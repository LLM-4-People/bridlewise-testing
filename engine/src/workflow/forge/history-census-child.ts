/**
 * THE ADDRESS CENSUS'S CHILD — the history importer runs its in-process
 * address census (`addressCensus`, history-import.ts) here, in a process of
 * its own under the one bounded run (`runAddressCensus`: the CPU budget, the
 * stall check, the kernel's CPU limit and the hang backstop), so no history,
 * however shaped, holds the importer's own process unbounded.
 *
 * Protocol: one JSON request on stdin (`AddressCensusRequest`: the mirror,
 * the known addresses, what is new), one JSON answer on stdout. Both hold
 * addresses, so neither is ever written anywhere: the parent holds the answer
 * in memory only. A failure is one typed line on stderr (a code and a
 * message with every address-shaped string withheld).
 */
import { readFileSync } from "node:fs";

import { bootstrapProcess } from "../../runtime/cli-debug.ts";
import { withoutAddresses } from "./history-identities.ts";
import { answerAddressCensus, type AddressCensusRequest } from "./history-import.ts";

// A top-level program (the importer starts it): the one process bootstrap first.
bootstrapProcess({ role: "worker" });

try {
  process.stdout.write(answerAddressCensus(JSON.parse(readFileSync(0, "utf8")) as AddressCensusRequest));
} catch (error) {
  const { code, message } = error as { code?: unknown; message?: unknown };
  process.stderr.write(`${JSON.stringify({ error: typeof code === "string" ? code : "history_import_census_failed", message: withoutAddresses(typeof message === "string" ? message : String(error)) })}\n`);
  process.exitCode = 1;
}
