/**
 * THE ENGINE RUN'S REPORT (#469): what each failure said reaches a reader off
 * this machine, never as a workflow command, never past the step summary's
 * limit, and from the summary the runner actually writes.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import test from "node:test";

import { logSafeReport, renderTestRunReport } from "../../scripts/tooling/test-run-report.ts";
import { writeTestRunSummary } from "../../src/workflow/test-result-collector.ts";
import { createTempDir } from "../support/temp-dir.ts";

const summary = (failures: Readonly<Record<string, string>>) => ({
  status: "failed" as const,
  passCount: 1,
  failCount: Object.keys(failures).length,
  testCount: 1 + Object.keys(failures).length,
  failures: Object.keys(failures),
  failureStatements: failures,
  reasons: ["test-failure"],
});

/**
 * The workflow commands a runner would execute from `log`: a line that starts,
 * after its leading whitespace, with `::`, except while commands are stopped
 * (`::stop-commands::<token>` until `::<token>::`).
 */
function executedCommands(log: string): readonly string[] {
  const executed: string[] = [];
  let stoppedBy: string | null = null;
  for (const line of log.split("\n")) {
    const command = line.trimStart();
    if (stoppedBy !== null) {
      if (command === `::${stoppedBy}::`) stoppedBy = null;
      continue;
    }
    if (!command.startsWith("::")) continue;
    executed.push(command);
    const stop = /^::stop-commands::(.+)$/u.exec(command);
    if (stop !== null) stoppedBy = stop[1]!;
  }
  return executed;
}

test("a failure's text runs no workflow command: ::add-mask:: and ::stop-commands:: planted in a statement and a name are inert", () => {
  const report = renderTestRunReport(summary({
    "test/a.test.ts::masks": "Error: boom\n::add-mask::planted-secret\n  ::set-output name=x::y",
    "test/b.test.ts::stops": "Error: boom\n   ::stop-commands::planted-token\n::planted-token::\n::add-mask::after-a-planted-resume",
    "test/c.test.ts::\n::warning::in-a-name": "Error: named",
  }));
  // Liveness: unwrapped, the planted lines WOULD run (the emulator sees them).
  assert.ok(executedCommands(report).includes("::add-mask::planted-secret"), "the planted command is live in the raw text");
  const token = "a-token-no-test-can-know";
  const log = logSafeReport(report, token);
  assert.deepEqual(executedCommands(log), [`::stop-commands::${token}`], "only the wrapper's own stop runs; every planted line is inert");
  assert.equal(log.split("\n").at(-2), `::${token}::`, "commands resume after the report");
  assert.throws(() => logSafeReport(`text ::${token}:: text`, token), /token occurs in the report/u);
  // Each report draws its own token.
  const [first, second] = [logSafeReport(report), logSafeReport(report)].map((wrapped) => wrapped.split("\n")[0]);
  assert.notEqual(first, second);
});

test("the report stays under the step summary's limit: failures that do not fit are counted in one stable line", () => {
  const failures = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`test/f.test.ts::case ${String(index).padStart(2, "0")}`, `Error: ${"x".repeat(900)}`]));
  const limit = 10_000;
  const report = renderTestRunReport(summary(failures), limit);
  assert.ok(Buffer.byteLength(report) <= limit, `${String(Buffer.byteLength(report))} bytes`);
  const shown = (report.match(/^- test\/f\.test\.ts::case /gmu) ?? []).length;
  assert.ok(shown > 0 && shown < 40, `shown ${String(shown)}`);
  assert.match(report, new RegExp(`\\n${String(40 - shown)} more failures omitted: the report holds at most 10000 bytes; the run's summary file holds them all\\.\\n`, "u"));
  assert.match(report, /### Reasons\n\n- test-failure\n$/u, "the reasons are kept after the omission");
  assert.equal(renderTestRunReport(summary(failures), limit), report, "stable: one summary, one report");
  // A report that fits omits nothing.
  assert.doesNotMatch(renderTestRunReport(summary({ "test/f.test.ts::one": "Error: short" })), /omitted/u);
  // A statement holding a fence cannot close the report's own.
  assert.match(renderTestRunReport(summary({ "test/f.test.ts::fenced": "Error: ```\nnot code" })), /\n {2}````text\n {2}Error: ```\n {2}not code\n {2}````\n/u);
});

test("the summary the runner writes carries each failure's statement, and the report renders it", () => {
  const root = createTempDir("test-run-report-");
  try {
    const failureStatements = { "test/a.test.ts::fails": "Error: what it said\n  caused by TypeError: why" };
    const path = writeTestRunSummary(root, {
      resultIntegrityHash: "a".repeat(64),
      deterministicHash: "b".repeat(64),
      status: "failed",
      exitCode: 1,
      failures: ["test/a.test.ts::fails"],
      failureStatements,
      reasons: ["test-failure"],
      testCount: 2,
      passCount: 1,
      failCount: 1,
    });
    const written = JSON.parse(readFileSync(path, "utf8")) as Parameters<typeof renderTestRunReport>[0];
    assert.deepEqual(written.failureStatements, failureStatements, "the summary carries the statements as given");
    assert.match(renderTestRunReport(written), /- test\/a\.test\.ts::fails\n\n {2}```text\n {2}Error: what it said\n {4}caused by TypeError: why\n {2}```\n/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
