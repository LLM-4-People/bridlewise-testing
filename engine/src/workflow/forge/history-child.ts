/**
 * THE HISTORY IMPORTER'S BOUNDED CHILD — the importer runs its in-process
 * passes over a history here, in a process of its own under the one bounded
 * run (`runAddressCensus`, `runHistoryScan`: the CPU budget, the stall check,
 * the kernel's CPU limit and the hang backstop), so no history, however
 * shaped, holds the importer's own process unbounded:
 *
 * - `census`: the address census (`addressCensus`): every address, every
 *   known address in any spelling, every old object id;
 * - `scan`: the catalogue scan and its oracle (`scanHistory`).
 *
 * Protocol: one JSON request on stdin (`HistoryChildRequest`), one JSON
 * answer on stdout. Both may hold addresses or secret values, so neither is
 * ever written anywhere: the parent holds the answer in memory only. A
 * failure is one typed line on stderr (a code and a message with every
 * address-shaped string withheld).
 */
import { readFileSync } from "node:fs";

import { bootstrapProcess, isEntryPoint } from "../../runtime/cli-debug.ts";
import { initializeHarnessRuntime } from "../../runtime/harness-bootstrap.ts";
import { withRecordingContext } from "../../timeline/recording-context.ts";
import { withoutAddresses } from "./history-identities.ts";
import { answerHistoryChild, type HistoryChildRequest } from "./history-import.ts";

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "worker" });
  // A production entry point: the harness runtime (exposure catalog, effect sink) and a recording boundary
  // whose actor is this child's pass.
  initializeHarnessRuntime();
  try {
    const request = JSON.parse(readFileSync(0, "utf8")) as HistoryChildRequest;
    process.stdout.write(await withRecordingContext({ actor: { kind: "cli", id: `history-import:${request.kind}` } }, () => answerHistoryChild(request)));
  } catch (error) {
    const { code, message } = error as { code?: unknown; message?: unknown };
    process.stderr.write(`${JSON.stringify({ error: typeof code === "string" ? code : "history_import_child_failed", message: withoutAddresses(typeof message === "string" ? message : String(error)) })}\n`);
    process.exitCode = 1;
  }
}
