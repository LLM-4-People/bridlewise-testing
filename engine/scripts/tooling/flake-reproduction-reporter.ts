/**
 * THE ENGINE'S REPRODUCTION REPORTER (a node:test custom reporter), loaded
 * by `harness flake reproduce` (src/workflow/flake-cli.ts) into the run it
 * makes in a reproduction checkout: every test identity the run reported and
 * how it ended, as ONE JSON document. The identity (`<file>::<test name>`,
 * `sourceIdForFile`) and the failure digest (`failureDigest` over
 * `extractTestResultError`, rooted at the run's engine root) are the very
 * owners the engine ledger's rows are written with, so a reproduced digest
 * and a recorded one say the same thing.
 */
import { writeFileSync } from "node:fs";

import { failureDigest, failureLocation, skippedIdentity } from "../../src/shared/run-history.ts";
import { extractTestResultError, testErrorStatement } from "../../src/workflow/test-result-collector.ts";
import { sourceIdForFile } from "./inventory-test-run.ts";

type ReporterEvent = Readonly<{ type: string; data?: Readonly<{ name?: string; file?: string; skip?: unknown; todo?: unknown; details?: Readonly<{ error?: unknown }> }> }>;

type Outcome = Readonly<{ outcome: "failed"; digest: string; location: string | null }> | Readonly<{ outcome: "passed" | "skipped" }>;

/** The run's result channel: descriptor 3 of a run the one test-execution door started with a result reader. */
const RESULT_CHANNEL = 3;

export default async function* flakeReproductionReporter(source: AsyncIterable<ReporterEvent>): AsyncGenerator<string> {
  const root = process.cwd();
  const outcomes: Record<string, Outcome> = {};
  for await (const event of source) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const data = event.data;
    if (data?.file === undefined || data.name === undefined) continue;
    const file = sourceIdForFile(root, data.file);
    if (file === undefined) continue;
    const identity = `${file}::${data.name}`;
    if (event.type === "test:fail") {
      const error = extractTestResultError(data.details?.error);
      outcomes[identity] = { outcome: "failed", digest: failureDigest(error ?? { name: null, message: "unknown error" }, root), location: error === null ? null : failureLocation(testErrorStatement(error), file) };
    } else if (outcomes[identity]?.outcome !== "failed") {
      outcomes[identity] = { outcome: data.skip !== undefined || data.todo !== undefined ? "skipped" : "passed" };
      // A skip is a ledger row of its own (`<identity> (skipped)`, its reason the digest): spelled as the engine runner spells it.
      if (data.skip !== undefined) {
        outcomes[skippedIdentity(identity)] = { outcome: "failed", digest: failureDigest({ name: "TestSkipped", message: typeof data.skip === "string" ? data.skip : "" }, root), location: null };
      }
    }
  }
  // Written to the run's result channel itself, descriptor 3 (the one test-execution door's pipe; node's file
  // destination fsyncs, which a pipe refuses); nothing is yielded to the destination.
  writeFileSync(RESULT_CHANNEL, `${JSON.stringify(outcomes)}\n`);
}
