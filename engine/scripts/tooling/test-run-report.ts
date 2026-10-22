/**
 * THE ENGINE RUN'S REPORT, FOR A READER OFF THIS MACHINE (CI).
 *
 * Renders the run summary (`TEST_RUN_SUMMARY_PATH`, written by the runner) as
 * Markdown: the counts, each failing test with what it said
 * (`failureStatements`), and the reasons. CI prints it to the log and appends
 * it to the step summary.
 *
 * Two hazards are the renderer's, because the text is the tests' own output:
 *  - WORKFLOW COMMANDS. The runner executes a log line that starts (after its
 *    leading whitespace) with `::` — a failure message carrying
 *    `\n::add-mask::…` or `\n::stop-commands::…` would act on the job. The log
 *    copy is therefore wrapped in `::stop-commands::<token>` … `::<token>::`
 *    with a token drawn fresh for every report, which no test output can
 *    know, so nothing between them is executed.
 *  - SIZE. The step summary drops everything past 1 MiB. The report is capped
 *    below that: failures that do not fit are counted in one stable
 *    "N more failures omitted" line, never cut mid-statement.
 *
 * Usage (from the repository root): `node engine/scripts/tooling/test-run-report.ts`
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";
import { TEST_RUN_SUMMARY_PATH, type TestRunSummary } from "../../src/workflow/test-result-collector.ts";

/** GitHub's step-summary limit: content past it is dropped. */
export const STEP_SUMMARY_LIMIT_BYTES = 1_048_576;

type ReportedSummary = Pick<TestRunSummary, "status" | "passCount" | "failCount" | "testCount" | "failures" | "failureStatements" | "reasons">;

/** A code fence longer than any backtick run in `text`, so the statement cannot close it. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/gu)].map((match) => match[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

function failureBlock(failure: string, said: string | undefined): string {
  if (said === undefined) return `- ${failure}\n`;
  const fence = fenceFor(said);
  return `- ${failure}\n\n  ${fence}text\n${said.split("\n").map((line) => `  ${line}`).join("\n")}\n  ${fence}\n\n`;
}

/**
 * The report's Markdown, at most `limitBytes` long: the header, then each
 * failure's block while it fits, then — when some do not — one line counting
 * the ones left out, then the reasons.
 */
export function renderTestRunReport(summary: ReportedSummary, limitBytes: number = STEP_SUMMARY_LIMIT_BYTES): string {
  const header = `## Engine suite: ${summary.status}\n\n${String(summary.passCount)} passed, ${String(summary.failCount)} failed of ${String(summary.testCount)}\n\n`;
  const reasons = summary.reasons.length === 0 ? "" : `\n### Reasons\n\n${summary.reasons.map((reason) => `- ${reason}`).join("\n")}\n`;
  const omission = (count: number): string => `\n${String(count)} more failure${count === 1 ? "" : "s"} omitted: the report holds at most ${String(limitBytes)} bytes; the run's summary file holds them all.\n`;
  // The room the blocks may take: the cap, less the fixed parts and the longest omission line.
  const room = limitBytes - Buffer.byteLength(header + reasons + omission(summary.failures.length));
  let used = 0;
  let shown = 0;
  const blocks: string[] = [];
  for (const failure of summary.failures) {
    const block = failureBlock(failure, summary.failureStatements[failure]);
    const size = Buffer.byteLength(block);
    if (used + size > room) break;
    blocks.push(block);
    used += size;
    shown += 1;
  }
  const left = summary.failures.length - shown;
  return `${header}${blocks.join("")}${left === 0 ? "" : omission(left)}${reasons}`;
}

/**
 * The log copy of `report`: wrapped so the runner executes no workflow command
 * inside it (`::stop-commands::<token>` … `::<token>::`, a fresh token each
 * time, never one the report contains).
 */
export function logSafeReport(report: string, token: string = randomUUID()): string {
  if (report.includes(token)) throw new Error("the stop-commands token occurs in the report");
  return `::stop-commands::${token}\n${report}::${token}::\n`;
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  const path = join(resolve(import.meta.dirname, "..", ".."), TEST_RUN_SUMMARY_PATH);
  const report = existsSync(path)
    ? renderTestRunReport(JSON.parse(readFileSync(path, "utf8")) as ReportedSummary)
    : "## Engine suite: no summary\n\nThe runner recorded no result.\n";
  process.stdout.write(logSafeReport(report));
  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary !== undefined && stepSummary.length > 0) appendFileSync(stepSummary, report);
}
