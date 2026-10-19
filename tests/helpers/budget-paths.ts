/**
 * Shared budget-summary path — the single owner of the
 * `.bridlewise/web-test-results/latest-summary.json` path.
 *
 * Both the budget reporter (`tests/reporters/budget-reporter.ts`, which
 * WRITES the summary at the end of each run) and the budget prevention
 * test (`tests/prevention/web-ui-runtime-budget.test.ts`, which READS the
 * summary to ratchet against the previous run) need the same path. Before
 * this module, the path was duplicated in both files — a change to the path
 * had to be made in two places (DRY violation). This module is the single
 * owner: both import from here so a change to the path fixes both.
 */
import { dirname, isAbsolute, join } from "node:path";

import { WEB_RUN_HISTORY_PATH } from "../../engine/src/shared/run-history.ts";

/**
 * The ledger of JUDGED full runs — the memory behind "sustained", read and
 * written by `tests/helpers/budget-history.ts`. Its repository-relative
 * spelling is the ledger owner's (`WEB_RUN_HISTORY_PATH`: the commit guard and
 * the candidate copy-back read the same constant); the summary sits beside it
 * because they are two views of the same subject: the summary is the last run
 * in full, the history is the judged runs in brief.
 */
export const BUDGET_HISTORY_PATH = join(process.cwd(), WEB_RUN_HISTORY_PATH);
export const BUDGET_SUMMARY_PATH = join(dirname(BUDGET_HISTORY_PATH), "latest-summary.json");

/**
 * Vitest's transform cache when the run does not say otherwise — the
 * directory whose emptiness makes a run COLD.
 *
 * Named here because two things need it and neither owns it: the reporter,
 * which records whether it was populated when a run began, and the guard that
 * checks this path is still the right one.
 *
 * IT IS NOT THE OBVIOUS ONE. Clearing `node_modules/.vite` does nothing for
 * cross-repository staleness; `npx vitest --clearCache` empties THIS
 * directory, and that command is mandatory after any edit in the sibling
 * repository. So "the cache was cold" and "somebody just did the required
 * thing" are the same event, which is exactly why a duration gate reds on
 * correct work.
 *
 * A wrong path here would report every run as cold and make the gate silently
 * unmeasurable — the permissive direction. `web-ui-runtime-budget-verdict`
 * asserts the directory exists during a run, which it must, because the run
 * itself populates it.
 *
 * **IT IS THE DEFAULT, AND IT IS NOT ALWAYS THE ONE IN USE.** See
 * `moduleCacheDirOf` below — that distinction was the cold arm's actual hole.
 */
export const DEFAULT_VITEST_MODULE_CACHE_DIR = join(
  process.cwd(),
  "node_modules",
  ".experimental-vitest-cache",
);

/**
 * Where THIS run keeps its transform cache.
 *
 * ── THE HOLE THIS CLOSES, MEASURED IN BOTH DIRECTIONS ────────────────────
 *
 * The reporter used to count entries in the constant above, unconditionally.
 * But `--experimental.fsModuleCachePath=<dir>` redirects the module cache
 * somewhere else, and that flag is not exotic: it is the documented way to run
 * against a cache that cannot be stale after a sibling-repository edit, and it
 * is the flag two consecutive agents used while measuring this very gate.
 *
 * With the path hardcoded, such a run builds its ENTIRE cache in the
 * redirected directory while the reporter counts the untouched default one.
 * Start and end agree, `builtDuringRun` computes to **0.0**, and a completely
 * cold run is recorded as **warm** and judged against the warm cap.
 *
 * DRIVEN, on this tree, `npx vitest run tests/unit/when-eval.test.ts
 * --experimental.fsModuleCachePath=<fresh dir>`, rc 0: the fresh directory was
 * created and populated, and `node_modules/.experimental-vitest-cache` stayed
 * at **1,884 entries**, unchanged — the reading the reporter would have taken.
 *
 * And the consequence, measured on the full suite (466 test modules, unit:
 * milliseconds of vitest's own `collectDuration`, `npx vitest run` with an
 * out-of-tree dump reporter so no summary was written, rc 0 each):
 *
 *     warm  ×3   worst collect 1,536 / 1,543 / 1,545 ms   share of wall 0.0380 / 0.0378 / 0.0378
 *     COLD       worst collect         4,553 ms           share of wall        0.1027
 *
 * The cold column is over the 0.08 cap; the warm column is less than half of
 * it. So "the gate reds and nobody can reproduce the green" and "the gate is
 * reading the wrong directory" are the same sentence, and the fix is to ask
 * the RUN where its cache is rather than to assume.
 *
 * `experimental` is read structurally rather than through vitest's own config
 * type: this file is loaded by a reporter, where a wrong import fails at
 * RUNTIME in the one place a throw silently loses the summary.
 */
export function moduleCacheDirOf(experimental: unknown): string {
  if (typeof experimental === "object" && experimental !== null) {
    const declared = (experimental as { fsModuleCachePath?: unknown }).fsModuleCachePath;
    // A non-empty string is the only thing that can name a directory. An empty
    // string would resolve to the process cwd and make every run look warm
    // against a directory of source files — the permissive direction again.
    if (typeof declared === "string" && declared.trim().length > 0) {
      return isAbsolute(declared) ? declared : join(process.cwd(), declared);
    }
  }
  return DEFAULT_VITEST_MODULE_CACHE_DIR;
}
