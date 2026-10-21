/**
 * WHAT THE PROJECTOR READS FROM THE LEDGER (`L`, the append-only ledger tree,
 * github-only §9.6) — one file per kind of row, JSON Lines, each row typed by
 * its schema; the writer appends, the projector reads at a ledger commit.
 *
 *   - `main-runs.jsonl` (`bridlewise-ledger-main-run/v1`): one row per judged
 *     run on `main` — the door's verdict on main's tip, the nightly cold audit
 *     — written by its judge: `{ schema, workflow, commit, conclusion,
 *     runUrl, failedTests: [{ path, message }] }`. The LAST row of each
 *     workflow is main's health for it: MAIN-RED (`project.ts`).
 *
 * A malformed row is refused typed (`ledger_row_invalid`, naming the file and
 * line), never skipped: a dropped red row would be a green main that is not.
 */
import { HarnessError } from "../../../kernel/errors.ts";
import { deepFreeze } from "../../../kernel/integrity.ts";
import { schemaId } from "../../../kernel/product-identity.ts";
import type { TreeReader } from "../../../git/tree-reader.ts";

export const LEDGER_MAIN_RUNS = Object.freeze({ path: "main-runs.jsonl", schema: schemaId("ledger-main-run", 1) });

/** One judged run on main, as its judge appended it. */
export type MainRun = Readonly<{
  workflow: string;
  commit: string;
  conclusion: "success" | "failure";
  runUrl: string;
  failedTests: readonly Readonly<{ path: string; message: string }>[];
}>;

const WORKFLOW = /^[a-z][a-z0-9-]*$/u;

function row(value: unknown, where: string): MainRun {
  const entry = value as Partial<Record<string, unknown>>;
  const fail = (why: string): never => { throw new HarnessError(`ledger_row_invalid: ${where}: ${why}`, "ledger_row_invalid"); };
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("not a JSON object");
  if (entry.schema !== LEDGER_MAIN_RUNS.schema) fail(`schema is not ${LEDGER_MAIN_RUNS.schema}`);
  if (typeof entry.workflow !== "string" || !WORKFLOW.test(entry.workflow)) fail("workflow must be a lower-case name");
  if (typeof entry.commit !== "string" || !/^[0-9a-f]{40}$/u.test(entry.commit)) fail("commit must be a full commit id");
  if (entry.conclusion !== "success" && entry.conclusion !== "failure") fail("conclusion must be success or failure");
  if (typeof entry.runUrl !== "string" || !entry.runUrl.startsWith("https://")) fail("runUrl must be an https URL");
  if (!Array.isArray(entry.failedTests)) fail("failedTests must be a list");
  const failedTests = (entry.failedTests as unknown[]).map((test, index) => {
    const failed = test as Partial<Record<string, unknown>>;
    if (typeof failed?.path !== "string" || failed.path.length === 0 || typeof failed.message !== "string") fail(`failedTests[${String(index)}] must be { path, message }`);
    return { path: failed.path as string, message: failed.message as string };
  });
  return { workflow: entry.workflow as string, commit: entry.commit as string, conclusion: entry.conclusion as MainRun["conclusion"], runUrl: entry.runUrl as string, failedTests };
}

/** Main's health per workflow at the ledger tree `ledger`: each workflow's LAST row, in workflow order; none when the file is absent. */
export function mainHealth(ledger: TreeReader): readonly MainRun[] {
  const text = ledger.text(LEDGER_MAIN_RUNS.path);
  if (text === null) return deepFreeze([]);
  const last = new Map<string, MainRun>();
  text.split("\n").forEach((line, index) => {
    if (line.trim().length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new HarnessError(`ledger_row_invalid: ${LEDGER_MAIN_RUNS.path}:${String(index + 1)}: not JSON (${(error as Error).message})`, "ledger_row_invalid");
    }
    const run = row(parsed, `${LEDGER_MAIN_RUNS.path}:${String(index + 1)}`);
    last.set(run.workflow, run);
  });
  return deepFreeze([...last.values()].sort((left, right) => (left.workflow < right.workflow ? -1 : 1)));
}
