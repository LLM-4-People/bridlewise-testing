#!/usr/bin/env -S node --experimental-strip-types
/**
 * RUN DIFF — the failure identities of one judged run against another.
 *
 *   node engine/scripts/tooling/run-diff.ts --baseline <ledger>[#<index>|@<timestamp>] --current <ledger>[#<index>|@<timestamp>]
 *   npm run run-diff -- …   (root and engine: the same tool)
 *
 * Each side is a run-history ledger (the engine suite's
 * `engine/.bridlewise/state/test-results/run-history.json`, the web suite's
 * `.bridlewise/web-test-results/run-history.json`) and ONE row of it: a row
 * index (negative counts from the end; none: -1, the latest) or the row's
 * exact recorded timestamp (`@2026-09-30T13:41:49.440Z`: the stable name a
 * report cites, where an index moves with every append). Prints
 * `{baseline, current, diff}` as JSON: each side's identity (ledger, index,
 * timestamp, tree, conditions and where the row came from — an imported
 * candidate row names its candidate, a mid-edit or mutation run says so),
 * and the diff (`diffRunFailures`, src/shared/run-history.ts): new /
 * persisting / changed (a persisting identity that fails differently now) /
 * fixed, or `unmeasured`. A whole red file is a `<file>::<module>` row on the
 * web side, so it is compared like any case. A candidate's ledger against
 * the previous qualified rows is the qualification receipt diff.
 *
 * Arguments are parsed strictly: an unknown flag, a missing value or an
 * index that is not an integer is a refusal, never a silent default.
 */
import { parseArgs } from "node:util";

import { canonicalJson } from "../../src/kernel/integrity.ts";
import { InputError } from "../../src/kernel/errors.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";
import { qualificationEvidence, diffRunFailures, readRunHistory, WEB_RUN_HISTORY_PATH } from "../../src/shared/run-history.ts";
import { TEST_RUN_HISTORY_PATH } from "../../src/shared/run-history.ts";
import type { JudgedRunRecord } from "../../src/shared/budget-verdict.ts";

type Side = Readonly<{ ledger: string; index: number; row: JudgedRunRecord }>;

/** Which suite a ledger records, by its path: `web`, `engine`, or `undefined` for a ledger elsewhere (a scratch copy). */
export function ledgerSuite(ledger: string): "web" | "engine" | undefined {
  const path = ledger.split("\\").join("/");
  if (path.endsWith(`/${WEB_RUN_HISTORY_PATH}`) || path === WEB_RUN_HISTORY_PATH) return "web";
  if (path.endsWith(`/${TEST_RUN_HISTORY_PATH}`) || path === TEST_RUN_HISTORY_PATH) return "engine";
  return undefined;
}

function rowOf(spec: string, flag: string): Side {
  // The selector follows the ledger's file name (a folder may hold `@` or `#`).
  const name = spec.lastIndexOf("/");
  const at = spec.lastIndexOf("@");
  const hash = spec.lastIndexOf("#");
  const cut = Math.max(at, hash) > name ? Math.max(at, hash) : -1;
  const ledger = cut < 0 ? spec : spec.slice(0, cut);
  const selector = cut < 0 ? undefined : spec.slice(cut + 1);
  const rows = readRunHistory(ledger);
  let index: number;
  if (selector === undefined) index = -1;
  else if (cut === at) {
    index = rows.findIndex((row) => row.timestamp === selector);
    if (index < 0) throw new InputError(`${flag}: ${ledger} has no judged run recorded at ${selector}`, "run_diff_row_missing");
  } else {
    if (!/^-?\d+$/u.test(selector)) throw new InputError(`${flag}: the row index "${selector}" is not an integer`, "run_diff_usage");
    index = Number(selector);
  }
  const row = rows.at(index);
  if (row === undefined) throw new InputError(`${flag}: ${ledger} has no judged run at index ${String(index)} (${String(rows.length)} rows)`, "run_diff_row_missing");
  return { ledger, index: index < 0 ? rows.length + index : index, row };
}

/** One side's identity: which row, of which tree, under which conditions, from where. */
function describe(side: Side): Readonly<Record<string, unknown>> {
  const { row } = side;
  return {
    ledger: side.ledger,
    suite: ledgerSuite(side.ledger) ?? "unknown",
    index: side.index,
    timestamp: row.timestamp,
    headSha: row.headSha ?? null,
    treeId: row.treeId ?? null,
    testModuleCount: row.testModuleCount,
    qualification: row.qualification ?? null,
    evidenceClaim: qualificationEvidence(row),
    failures: row.failures?.length ?? null,
    load5PerCpu: row.ambientLoad5PerCpu ?? null,
    environment: row.importedFrom === undefined ? "this ledger's checkout" : `imported from ${row.importedFrom}`,
    ...(row.provisionalFailures === true ? { provisional: "measured a tracked-dirty (mid-edit) tree" } : {}),
    ...(row.mutation === true ? { mutation: "a deliberate mutation-verification run" } : {}),
  };
}

export function runDiff(argv: readonly string[]): string {
  let values: Readonly<{ baseline?: string; current?: string }>;
  try {
    ({ values } = parseArgs({ args: [...argv], options: { baseline: { type: "string" }, current: { type: "string" } }, strict: true, allowPositionals: false }));
  } catch (error) {
    throw new InputError(`${(error as Error).message}; usage: --baseline <ledger>[#<index>|@<timestamp>] --current <ledger>[#<index>|@<timestamp>]`, "run_diff_usage");
  }
  if (values.baseline === undefined || values.current === undefined) {
    throw new InputError("--baseline <ledger>[#<index>|@<timestamp>] and --current <ledger>[#<index>|@<timestamp>] are required", "run_diff_usage");
  }
  const baseline = rowOf(values.baseline, "--baseline");
  const current = rowOf(values.current, "--current");
  const [baselineSuite, currentSuite] = [ledgerSuite(baseline.ledger), ledgerSuite(current.ledger)];
  if (baselineSuite !== undefined && currentSuite !== undefined && baselineSuite !== currentSuite) {
    throw new InputError(`--baseline is a ${baselineSuite} ledger and --current a ${currentSuite} ledger: rows of different suites share no failure identities`, "run_diff_usage");
  }
  return canonicalJson({ baseline: describe(baseline), current: describe(current), diff: diffRunFailures(baseline.row, current.row) });
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  try {
    process.stdout.write(`${runDiff(process.argv.slice(2))}\n`);
  } catch (error) {
    process.stderr.write(`${canonicalJson({ error: (error as { code?: string }).code ?? "run_diff_failed", message: (error as Error).message })}\n`);
    process.exitCode = 1;
  }
}
