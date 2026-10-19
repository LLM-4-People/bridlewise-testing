import process from "node:process";
import { anchorRequest } from "./anchor-client.mjs";
import {
  appendCommitted,
  insertNextInCurrentTransaction,
  openLedger,
} from "./ledger-lib.mjs";

process.umask(0o077);
const [mode, databasePath, socketPath, label] = process.argv.slice(2);
if (!mode || !databasePath || !socketPath || !label) throw new Error("worker arguments missing");

if (mode === "before-db-commit") {
  const database = openLedger(databasePath);
  database.exec("BEGIN IMMEDIATE");
  insertNextInCurrentTransaction(database, label);
  process.kill(process.pid, "SIGKILL");
} else if (mode === "after-db-commit-before-anchor") {
  appendCommitted(databasePath, label);
  process.kill(process.pid, "SIGKILL");
} else if (mode === "after-anchor-before-mark") {
  const entry = appendCommitted(databasePath, label);
  const response = await anchorRequest(socketPath, {
    op: "cas",
    expectedGeneration: entry.sequence - 1,
    expectedTip: entry.previousTip,
    newGeneration: entry.sequence,
    newTip: entry.tip,
    requestId: `crash-after-anchor-${entry.sequence}-${entry.tip.slice(0, 16)}`,
  });
  if (!response.ok) throw new Error(`anchor update failed: ${JSON.stringify(response)}`);
  process.kill(process.pid, "SIGKILL");
} else {
  throw new Error(`unknown mode ${mode}`);
}
