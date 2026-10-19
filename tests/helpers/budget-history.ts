/**
 * THE RUN-HISTORY LEDGER'S WEB BINDING — the web path, bound onto the shared
 * owner.
 *
 * The ledger logic (parse-with-garbage-tolerance, judged-only append,
 * newest-kept trim, unknown-field preservation) was hoisted to
 * `integration/src/shared/run-history.ts` when the integration runner grew
 * its own judged-run ledger: one parser, one trim rule, one lean ("a broken
 * ledger delays a red, never manufactures one") — two copies would drift.
 * The shared functions take a REQUIRED path, because each repo's path has
 * exactly one owner; this module is the web side's owner-binding
 * (`BUDGET_HISTORY_PATH` from `budget-paths.ts`) and keeps every existing
 * call site's signature, defaults included.
 *
 * Tests still drive these functions against their own file, never the live
 * ledger — the real one is shared state a concurrent run may be appending to.
 */
import { BUDGET_HISTORY_PATH } from "./budget-paths.ts";
import {
  appendJudgedRun as appendJudgedRunAt,
  readRunHistory as readRunHistoryAt,
  readRepositoryHeadSha,
  HISTORY_KEPT,
} from "../../engine/src/shared/run-history.ts";
import { measuredTreeMark, provisionalFailureMark, mutationRunMark, readMeasuredTree } from "../../engine/src/shared/tree-identity.ts";
import type { JudgedRunRecord } from "./budget-verdict.ts";

// The shared owner's filesystem HEAD reader and the ledger's provisional
// marker ride through the same binding: the reporter records THIS
// repository's HEAD into each judged run so cap re-derivation can demand
// same-sha samples (the identity gap that made the accumulation ledger a
// cross-condition confound), and it marks a run's failure rows provisional
// when the run measured a tracked-dirty (mid-edit) tree. The mark itself is
// derived by the tree-identity owner — the ledger is server-reachable and
// must never hold a spelling of the porcelain subprocess. The deliberate-
// mutation marker (`HARNESS_MUTATION_RUN=1`) rides the same binding for the
// same reason: one spelling, derived by the owner, spread by the reporter.
// So does the measured tree's id (`readMeasuredTree` at the start,
// `measuredTreeMark` at the end): the like-for-like key a later commit of
// exactly that tree finds the run by.
export { HISTORY_KEPT, readRepositoryHeadSha, measuredTreeMark, provisionalFailureMark, mutationRunMark, readMeasuredTree };

/** The judged runs on disk, oldest first, malformed entries skipped. */
export function readRunHistory(path: string = BUDGET_HISTORY_PATH): JudgedRunRecord[] {
  return readRunHistoryAt(path);
}

/** Append one JUDGED run and trim to the newest `HISTORY_KEPT`. Never throws. */
export function appendJudgedRun(
  record: JudgedRunRecord,
  path: string = BUDGET_HISTORY_PATH,
): void {
  appendJudgedRunAt(record, path);
}
