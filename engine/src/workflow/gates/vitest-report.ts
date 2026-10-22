/**
 * THE ONE JUDGEMENT OF A WEB SHARD'S VITEST REPORT (moved here from the old
 * `scripts/test-shard-merge.mjs` with every refusal it made): a shard counts
 * as evidence only when its rows — not its summary — record every planned
 * file as a passed suite of passed tests, and the summary agrees with them.
 *
 *   - ABSENT IS NOT ZERO: every summary count must be declared, as a
 *     non-negative integer;
 *   - no failed test or suite, no skipped or todo test;
 *   - THE ROW IS THE RECORD: each row is a passed suite with no message, at
 *     least one assertion, every assertion passed with no failure message;
 *   - no file twice; the rows' assertion total equals the declared total and
 *     the declared passed count;
 *   - the files run are exactly the planned files (none missing, none
 *     unexpected).
 *
 * A report names files under the runner's own checkout, so a path outside
 * `repositoryRoot` is accepted only when its suffix names exactly one planned
 * file — never a guess between two.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";

export type VitestJudgement =
  | Readonly<{ ok: true; files: readonly Readonly<{ path: string; tests: number }>[]; tests: number }>
  | Readonly<{ ok: false; refusal: string }>;

class Refusal extends Error {}

function refuse(message: string): never {
  throw new Refusal(message);
}

function declared(report: Record<string, unknown>, field: string): number {
  const value = report[field];
  if (value === undefined || value === null) refuse(`the report does not declare ${field}; absent is not zero`);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) refuse(`${field} is not a declared non-negative integer (${String(value)})`);
  return value as number;
}

function reportPath(repositoryRoot: string, file: unknown, planned: readonly string[]): string {
  if (typeof file !== "string" || file.length === 0) refuse("a row names no file");
  const inside = relative(repositoryRoot, resolve(repositoryRoot, file as string));
  if (inside.length > 0 && !inside.startsWith("..") && !isAbsolute(inside)) return inside.split(sep).join("/");
  const candidates = planned.filter((path) => file === path || (file as string).endsWith(`/${path}`));
  if (candidates.length === 1) return candidates[0]!;
  return refuse(`${String(file)} is outside the repository and ${candidates.length === 0 ? "matches no" : "matches more than one"} planned file`);
}

/** Judges one vitest JSON report against the files the shard was planned to run. */
export function judgeVitestReport(report: unknown, repositoryRoot: string, planned: readonly string[]): VitestJudgement {
  try {
    if (report === null || typeof report !== "object") refuse("the report is not an object");
    const document = report as Record<string, unknown>;
    if (document.success !== true) refuse("vitest reported success=false");
    const failedTests = declared(document, "numFailedTests");
    const failedSuites = declared(document, "numFailedTestSuites");
    const pendingTests = declared(document, "numPendingTests");
    const todoTests = declared(document, "numTodoTests");
    const totalTests = declared(document, "numTotalTests");
    const passedTests = declared(document, "numPassedTests");
    if (failedTests !== 0 || failedSuites !== 0) refuse(`${failedTests} failed test(s) and ${failedSuites} failed suite(s)`);
    if (pendingTests !== 0 || todoTests !== 0) refuse(`${pendingTests} skipped and ${todoTests} todo test(s); a shard runs every selected test`);
    const results = document.testResults;
    if (!Array.isArray(results)) refuse("the report has no testResults array");
    const rows = (results as unknown[]).map((row, index) => {
      if (row === null || typeof row !== "object") refuse(`testResults[${index}] is not an object`);
      const result = row as Record<string, unknown>;
      const path = reportPath(repositoryRoot, result.name, planned);
      if (result.status !== "passed") refuse(`${path} records a ${String(result.status)} test suite (the summary claimed green)`);
      if (result.message !== undefined && result.message !== null && String(result.message).length > 0) {
        refuse(`${path} records a passed suite carrying a failure message: ${String(result.message).slice(0, 200)}`);
      }
      const assertions = result.assertionResults;
      if (!Array.isArray(assertions)) refuse(`${path} has no assertionResults; its test-level result cannot be judged`);
      if ((assertions as unknown[]).length === 0) refuse(`${path} records zero assertions; a file that ran no test is not evidence that it passed`);
      for (const entry of assertions as unknown[]) {
        if (entry === null || typeof entry !== "object") refuse(`${path} records a test result that is not an object`);
        const assertion = entry as Record<string, unknown>;
        if (assertion.status !== "passed") refuse(`${path} records a ${String(assertion.status)} test (the summary claimed green)`);
        const messages = assertion.failureMessages;
        const recorded = Array.isArray(messages) ? messages.map(String).join("\n") : messages === undefined || messages === null ? "" : String(messages);
        if (recorded.length > 0) refuse(`${path} records a passed test carrying failure messages: ${recorded.slice(0, 200)}`);
      }
      return { path, tests: (assertions as unknown[]).length };
    });
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.path)) refuse(`${row.path} appears twice in the report`);
      seen.add(row.path);
    }
    const rowTotal = rows.reduce((sum, row) => sum + row.tests, 0);
    if (rowTotal !== totalTests) refuse(`the rows record ${rowTotal} assertion(s) but numTotalTests declares ${totalTests}`);
    if (rowTotal !== passedTests) refuse(`the rows record ${rowTotal} assertion(s) but numPassedTests declares ${passedTests}`);
    const plannedSet = new Set(planned);
    const unexpected = rows.filter((row) => !plannedSet.has(row.path)).map((row) => row.path);
    if (unexpected.length > 0) refuse(`unexpected file(s) ran: ${unexpected.join(", ")}`);
    const missing = planned.filter((path) => !seen.has(path));
    if (missing.length > 0) refuse(`planned file(s) did not run: ${missing.join(", ")}`);
    return Object.freeze({ ok: true, files: Object.freeze(rows.toSorted((left, right) => (left.path < right.path ? -1 : 1))), tests: rowTotal });
  } catch (error) {
    if (error instanceof Refusal) return Object.freeze({ ok: false, refusal: error.message });
    throw error;
  }
}
