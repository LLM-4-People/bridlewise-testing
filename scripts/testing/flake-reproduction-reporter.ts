/**
 * THE WEB SUITE'S REPRODUCTION REPORTER (a vitest reporter), loaded by
 * `harness flake reproduce` (engine/src/workflow/flake-cli.ts) into the run
 * it makes in a reproduction checkout: every case identity and how it ended,
 * as ONE JSON document at `$FLAKE_REPRODUCTION_OUTPUT`. The identities and
 * digests come from `failuresOf` (tests/reporters/budget-reporter.ts) — the
 * one owner the web ledger's rows are written with.
 */
import { writeFileSync } from "node:fs";

import { failuresOf } from "../../tests/reporters/budget-reporter.ts";

type Outcome = Readonly<{ outcome: "failed"; digest: string; location: string | null }> | Readonly<{ outcome: "passed" }>;

export default class FlakeReproductionReporter {
  onTestRunEnd(testModules: Parameters<typeof failuresOf>[0]): void {
    const output = process.env.FLAKE_REPRODUCTION_OUTPUT;
    if (output === undefined || output.length === 0) throw new Error("FLAKE_REPRODUCTION_OUTPUT names no file: this reporter runs only under `harness flake reproduce`");
    const { rows, digests, locations, passed } = failuresOf(testModules, process.cwd());
    const outcomes: Record<string, Outcome> = {};
    for (const identity of passed) outcomes[identity] = { outcome: "passed" };
    for (const identity of rows) {
      const digest = digests[identity];
      if (digest !== undefined) outcomes[identity] = { outcome: "failed", digest, location: locations[identity] ?? null };
    }
    writeFileSync(output, `${JSON.stringify(outcomes)}\n`);
  }
}
