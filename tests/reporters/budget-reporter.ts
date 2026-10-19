/**
 * Vitest budget reporter — measures what makes a runtime number EVIDENCE,
 * AND JUDGES THE RUN IT IS ENDING.
 *
 * ── THIS IS WHERE THE VERDICT LIVES, AND THE REASON IS MECHANICAL ────────
 *
 * The three run-cost gates were tests inside the suite. A test executes
 * INSIDE the run it would be measuring, so the only totals it can read are
 * the ones written at the end of the PREVIOUS run — and a verdict about a
 * run nobody is looking at is a verdict the same tree can pass or fail
 * depending on what ran before it. That is not a lag to be tolerated; it is
 * the judge being inside the subject.
 *
 * It could not be closed by giving the test better data. The quantities are a
 * MAXIMUM and two TOTALS over every test module, and when a test body runs,
 * the modules scheduled after it have not been collected: a partial maximum
 * and two partial totals, all smaller than the truth, all permissive.
 *
 * `onTestRunEnd` is the first moment those numbers exist and the last moment
 * the run is still alive. So the summary is still written — for diagnosis,
 * and for anyone comparing runs — but nothing waits for the next run to read
 * it. `tests/prevention/web-ui-runtime-budget.test.ts` keeps only what has no
 * run in it: the population, the declared budget's shape, the caps' ranges.
 *
 * ── WHY THIS WRITES MORE THAN A DURATION ─────────────────────────────────
 *
 * It used to write `{ wallClockMs }` alone, and a bare duration cannot be
 * judged, because it does not say what was being timed.
 *
 * **A SUBSET RUN DISARMED THE BUDGET, SILENTLY.** `npx vitest run
 * tests/prevention/some-one.test.ts` — the most ordinary thing a developer
 * does — invokes this reporter too, and overwrote the summary with the
 * duration of ONE file. Proved directly: after a single-file run the summary
 * read `{"wallClockMs":174}`, and the next FULL run's budget test compared
 * 174ms against a 35,000ms budget and passed without noticing anything. The
 * guard was off, and nothing said so. `testModuleCount` is what closes that:
 * a summary that did not cover the suite is refused as evidence instead of
 * being believed.
 *
 * **THE SCHEDULER IS BLIND TO COLLECT TIME, AND THAT IS WHAT MADE THE WALL
 * CLOCK BIMODAL.** Vitest orders test files by their TEST duration.
 * `no-unused-exports.test.ts` reported `tests: 14ms` while spending **15.41s
 * importing** (it re-scanned the whole codebase once per candidate export at
 * module scope). Reporting 14ms, it was sorted to the very end of the run,
 * where its 15s had nothing left to overlap with. Measured on the full
 * suite: every other file finished by **+26.9s** and the run ended at
 * **+41.5s**. Absorbed, the suite read ~31s; exposed, ~43s — and the budget
 * was 35s, sitting between the two modes. That is the whole of the "coin
 * flip", and it was never a machine property.
 *
 * So `slowestCollects` records the cost the SEQUENCER CANNOT SEE, per file.
 * The budget test gates on it directly, which is a guard against the cause
 * rather than against the symptom: a file cannot re-acquire a multi-second
 * invisible tail without a named failure.
 *
 * ── WHAT IS RECORDED AND DELIBERATELY NOT GATED ON, AND WHY THE OLD REASON
 *    FOR THAT WAS WRONG ───────────────────────────────────────────────────
 *
 * `load1PerCpuAtStart` is written down because a number without its machine
 * conditions is not evidence, and it is NOT a normaliser. The reason recorded
 * here used to be *"ambient load does not move this suite"*, citing back-to-back
 * runs at **loadavg 0.11 → 28.38s** and **loadavg 7.47 → 28.21s**. **That
 * conclusion was false, and the measurement that produced it was reading a
 * ghost.** `loadavg()[0]` is a one-minute EXPONENTIALLY DECAYING average
 * sampled before the run starts, so immediately after a previous suite run it
 * reports that run's load over cores which are now completely idle. A "7.47"
 * taken thirty seconds after a full suite is an idle box.
 *
 * Driven here against burners that were genuinely running for the whole run:
 * eight of them on twelve cores took the same unchanged tree from **35.3s to
 * 61.1s**, +73%. Ambient load moves this suite a great deal. What it does not
 * do — under that MILD contention — is move the run's CPU cost (+2.6% across
 * the same pair), which is why `runCpuMs` is the field the budget judges and
 * this one stays provenance.
 *
 * **THE +2.6% DOES NOT SURVIVE SATURATION, AND THE ENVELOPE PAYS FOR IT.**
 * Five full runs of one unchanged tree read **1667.3 → 2024.7 ms/file (+21%)**
 * while the recorded ambient load climbed to **1.33/cpu** (load average 18 at
 * peak, 2026-09-01) — cache thrashing and scheduling pressure add real work to
 * the same instructions. So the recorded ambient load has exactly ONE gated
 * use now: the cap scales by the declared ambient-inflation envelope
 * (`ambientInflationFraction` in the shared verdict owner) at the run's own
 * recorded 5-minute leg, and the feed boundary of every ledger reading at
 * its own. A clean run at a busy ambient judges CLEAN; a regressed run at a
 * busy ambient FAILS, in its one run (UR-24-BUDGETS); the arithmetic is on
 * every gate line. A LOW reading still certifies nothing (the ghost cuts
 * both ways) and adjusts nothing; absence never loosens a line; and nothing
 * anywhere waits for a quieter box.
 *
 * The correct statement is therefore narrower and more useful: **the recorded
 * 1-minute load cannot be normalised by, because a LOW reading does not
 * describe the run** (the start sample is blind to load arriving mid-run).
 * The 5-minute leg is the covariate that separates sustained load from the
 * previous run's ghost, and it is consumed by the envelope the verdict
 * applies — recorded context turned into measured allowance, never a gate.
 */
import { writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { instrumentLockPath, instrumentLockStamp } from "../../engine/src/process/instrument-lock.ts";
import { readTestExecutionConfig } from "../../engine/src/workflow/test-result-collector.ts";
import { cpus, loadavg } from "node:os";
import { BUDGET_SUMMARY_PATH, moduleCacheDirOf } from "../helpers/budget-paths.ts";
import { readRunCpu } from "../../engine/src/shared/run-cpu.ts";
import { failureDigest, failureIdentityFile, failureLocation, qualificationInvocation } from "../../engine/src/shared/run-history.ts";
import {
  judgeRunCosts,
  judgeRuntimeBudget,
  provenanceLine,
  baselineLine,
  deriveRollingBaseline,
  type GateOutcome,
} from "../helpers/budget-verdict.ts";
import { appendJudgedRun, measuredTreeMark, provisionalFailureMark, mutationRunMark, readMeasuredTree, readRepositoryHeadSha, readRunHistory } from "../helpers/budget-history.ts";
import { readCpuBudget, readFileShareMax, fullRunModuleCount, WEB_BUDGET_FAILURE_IDENTITIES } from "../helpers/budget-config.ts";
import { judgePerformanceBudgets } from "../../scripts/testing/performance-measurements.ts";
import { REPORT_PATH } from "../performance/lib/perf-harness.ts";
import { getPerformanceBudgetConfig } from "../../server/kernel/harness-config.ts";
import { ROOT_POLICY } from "../../engine/src/kernel/root-policy.ts";

const SUMMARY_PATH = BUDGET_SUMMARY_PATH;


/** How many of the worst collect-time offenders to write down. */
const SLOWEST_COLLECT_KEPT = 5;

/** How many of the worst TOTAL-cost files to write down. */
const SLOWEST_FILES_KEPT = 8;

/** One file's invisible-to-the-scheduler cost. */
export interface CollectCost {
  readonly file: string;
  readonly ms: number;
}

/** The shape written to disk. Read by the budget test; keep them in step. */
export interface BudgetSummary {
  readonly wallClockMs: number;
  readonly timestamp: string;
  /** Test modules the recorded run actually covered. A subset run is not
   *  evidence about the suite — see the header. */
  readonly testModuleCount: number;
  /** Worst `collectDuration`s, descending. `collectDuration` is vitest's own
   *  "time to import the test module, including executing suite callbacks" —
   *  i.e. everything the file does OUTSIDE its tests. */
  readonly slowestCollects: readonly CollectCost[];
  /**
   * Worst TOTAL costs, descending — everything a file occupies a worker for:
   * collect + setup + environment + prepare + tests.
   *
   * This is a different question from `slowestCollects`, and it needed asking
   * separately. The collect gate catches a cost the SEQUENCER cannot see; this
   * one catches a cost it can see perfectly well and can do nothing about. The
   * suite is throughput-bound across a fixed number of workers, so every second
   * one file spends is a second of the whole pool's budget, and a file that
   * grows to a large multiple of its neighbours is spending the suite's wall
   * clock whether or not it is scheduled first.
   *
   * Measured: `async-db-ordering.test.ts` reached **23.9s of a 330s pool** —
   * 7.2% of the entire suite in ONE file — by opening a real threaded facade
   * (a writer plus four reader threads, ~0.5s of pure spawn) once per TEST
   * rather than once per file. Nothing in the suite said so; the collect gate
   * saw 0.6s and passed, because the cost was inside the tests where it was
   * perfectly visible and entirely unattributed.
   */
  readonly slowestFiles: readonly CollectCost[];
  /**
   * Every file's occupancy, summed — the whole pool's budget for the run.
   *
   * Recorded so the per-file gate can be a SHARE rather than a stopwatch.
   * Contention inflates every file together (the same tree measured minutes
   * apart moved 286s → 308s of pool time on this box), so an absolute
   * per-file ceiling has to be set loose enough to survive a busy machine and
   * is then too loose to catch anything. A share is invariant to that: the
   * question "is one file eating a disproportionate part of the suite" has
   * the same answer whether the box was idle or not.
   */
  readonly totalOccupancyMs: number;
  /**
   * Every file's `collectDuration` summed — the collect gate's denominator.
   *
   * The gate over the worst collect had no denominator at all: it compared a
   * millisecond figure against an absolute cap, and `collectDuration` is WALL
   * CLOCK per module, so it inflated with contention and again, far harder,
   * with a cold module cache. Recording the total is what lets the same
   * question be asked as a share.
   */
  readonly totalCollectMs: number;
  /**
   * Entries in vitest's transform cache when this reporter was initialised.
   *
   * NOT ZERO ON A COLD RUN, AND THAT IS THE WHOLE POINT OF THE FIELD BESIDE
   * IT. `onInit` fires after vitest has already transformed its own config
   * graph, so the cache is never empty by the time a reporter can look.
   * Driven: `npx vitest --clearCache` removes the directory, the directory is
   * confirmed ABSENT at launch, and this field still records **4**. An arm
   * gated on `=== 0` was therefore unreachable by any real run and fired only
   * for a fabricated summary — a value asserted on a fixture saying nothing
   * about the value in production.
   */
  readonly moduleCacheEntriesAtStart: number | null;
  /**
   * Entries in that cache when the run FINISHED.
   *
   * The pair is the measurement; neither end is one on its own. What makes a
   * cold run different is not the number it began with but how much of the
   * cache it had to BUILD, and that quantity survives the reading being taken
   * late — the config graph's handful of entries is noise against a full
   * suite's thousands. A warm run adds almost nothing; a cleared run builds
   * essentially all of it.
   */
  readonly moduleCacheEntriesAtEnd: number | null;
  /**
   * How many of the cache's files carry an mtime AT OR AFTER this run's
   * start — the run's transform work, measured directly.
   *
   * THE COUNT PAIR ABOVE CANNOT ANSWER THIS, and the failure was live: a
   * cache whose entries are REPLACED IN PLACE reads the same count at both
   * ends (`1489 → 1489` sat on the record of a regression hunt) while every
   * file was rewritten during the run. A write is a write whether it grows
   * the directory or not, and every write moves an mtime, so this field sees
   * full rebuilds, partial rebuilds and in-place replacement alike. The
   * verdict judges warmth on THIS field; the pair stays as provenance, and a
   * high written-count beside a still count is the in-place signature.
   */
  readonly moduleCacheEntriesWrittenDuringRun: number | null;
  /**
   * The newest mtime observed across ALL cache entries by the SAME walk that
   * produced the count above — the count's WITNESS.
   *
   * A written count of 0 is the most permissive reading there is, and it is
   * exactly what an instrument that computed the walk and DISCARDED its
   * result would report: driven — a mutant returning 0 from the walk let a
   * fully cold run be judged into the ledger while every guard stayed green.
   * The witness closes that: a zero count beside a newest mtime at or after
   * `runStartedAtMs` is a contradiction the verdict REFUSES, so the inert
   * shape cannot read as warmth. An absence assertion needs a witness, or it
   * proves nothing.
   */
  readonly moduleCacheNewestEntryMtimeMs: number | null;
  /**
   * When this run started (`onInit`, epoch ms) — the reference the written
   * count and its witness were both compared against. Recorded so the
   * verdict can check the two against each other; a summary that carries a
   * count but no reference cannot prove its walk happened.
   */
  readonly runStartedAtMs: number | null;
  /**
   * The directory the two readings above were taken from.
   *
   * A COUNT WITHOUT ITS SUBJECT IS NOT EVIDENCE. Both readings used to come
   * from a hardcoded default path, so a run launched with
   * `--experimental.fsModuleCachePath` built its whole cache elsewhere while
   * the reporter counted an untouched directory — start and end agreed, the
   * built fraction computed to 0.0, and a cold run was recorded as warm.
   * Writing the path down is what lets a reader see which directory a
   * "warm" verdict was about.
   */
  readonly moduleCacheDir: string;
  /** Ambient load per CPU when the run STARTED (before the suite ramps up).
   *  Recorded, not gated on — see the header. */
  readonly load1PerCpuAtStart: number;
  /**
   * The run-start snapshot's 5- and 15-minute legs, per CPU — recorded for
   * the same reason the 1-minute figure is: a number without its machine
   * conditions is not evidence. The 15-minute leg is the one the saturation
   * ghost lives in (a previous suite's load decays out of the 1-minute
   * figure within minutes while the 15-minute average still carries it), so
   * the row a future investigation reads can say "launched into the ghost"
   * without anyone reconstructing the context from prose.
   */
  readonly load5PerCpuAtStart: number;
  readonly load15PerCpuAtStart: number;
  readonly cpuCount: number;
  /**
   * CPU milliseconds the run consumed — this process plus every pool worker
   * it reaped. **This is the number the suite budget is judged on**, and the
   * wall clock is now recorded for diagnosis rather than for judgement.
   *
   * Absent (`null`) when it could not be measured, which the budget test
   * treats as a refusal rather than as a zero. See `engine/src/shared/run-cpu.ts`
   * for how it is read and why there is no clock-tick constant.
   *
   * Measured on this box, one unchanged tree, eight deliberate CPU burners
   * against twelve cores:
   *
   *     wall clock             35,304 →  61,144 ms   (+73.2%)
   *     wall-clock occupancy  325,892 → 562,633 ms   (+72.6%)
   *     CPU                   377,316 → 387,186 ms   ( +2.6%)
   *
   * Contention makes a process WAIT for a core; it does not make it execute
   * more instructions — under MILD contention. Saturation breaks the
   * invariance (cache thrashing, memory-bandwidth contention and scheduling
   * pressure add real work to the same instructions), which is why the
   * verdict defers a saturated box as provisional instead of judging it.
   * That is the whole reason this field exists.
   */
  readonly runCpuMs: number | null;
}

/** Structural input to `onTestRunEnd`, also supplied by reporter fixtures.
 * The complete typecheck includes this test tree. Unknown fields preserve
 * the runtime validation boundary before a module enters the summary. */
interface ModuleLike {
  readonly id?: unknown;
  readonly moduleId?: unknown;
  /**
   * The module's test collection, when the runner reports one. Fixture
   * modules driven by the verdict tests carry no `children`; absence means
   * "no per-test results were reported", never "every test passed".
   */
  readonly children?: {
    readonly allTests?: (state?: string) => Iterable<TestCaseLike>;
    readonly allSuites?: () => Iterable<SuiteLike>;
  };
  diagnostic?: () => Readonly<Record<string, unknown>> | undefined;
  /** The module's own state (`failed` when it failed at collection, in a hook, or in a case). */
  state?: () => unknown;
  /** Errors raised outside any case (collection, `beforeAll`/`afterAll`, an unhandled rejection). */
  errors?: () => readonly ErrorLike[];
}

interface SuiteLike {
  readonly id?: unknown;
  readonly fullName?: unknown;
  readonly children?: { readonly allTests?: () => Iterable<TestCaseLike> };
  state?: () => unknown;
  errors?: () => readonly ErrorLike[];
}

/** One test case, structurally — the fields a failure row is built from. */
interface TestCaseLike {
  readonly id?: unknown;
  readonly fullName?: unknown;
  result?: () => { readonly state?: unknown; readonly errors?: readonly ErrorLike[] } | undefined;
}

/** An error as vitest reports it, structurally. */
interface ErrorLike {
  readonly name?: unknown;
  readonly message?: unknown;
}

/** Snapshot each external error once. Absence is permitted only for case
 * diagnostics; malformed supplied entries remain an incomplete census. */
function observeErrors(read: () => unknown, absentAllowed = false): Readonly<{
  complete: boolean; errors: readonly { readonly message: string; readonly name?: string }[];
}> {
  const errors: { message: string; name?: string }[] = [];
  let complete = true;
  try {
    const value = read();
    if (value === undefined && absentAllowed) return { complete, errors };
    if (!Array.isArray(value)) return { complete: false, errors };
    for (const entry of value) {
      try {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) { complete = false; continue; }
        const { message, name } = entry as ErrorLike;
        if (typeof message !== "string" || (name !== undefined && typeof name !== "string")) { complete = false; continue; }
        errors.push(name === undefined ? { message } : { message, name });
      } catch { complete = false; }
    }
  } catch { complete = false; }
  return { complete, errors };
}

/** The row identity of a module that failed with no failed case of its own (collection, a hook): `<file>::<module>`. */
export const MODULE_FAILURE_ROW = "<module>";

/**
 * The run's per-test FAILURE ROWS — the substrate a flaky-test memory is
 * built from, and the reason they are recorded here at all.
 *
 * A test that fails once in twenty runs is invisible to every gate this
 * project has: the run that caught it is red for a moment, the next run is
 * green, and the baseline handed on says "0 failing" — while the bug the
 * failure was reporting sits unfixed. The escape is memory: every judged
 * full run appends the identities of the tests IT failed to the run-history
 * ledger, and a guard compares the window (`tests/prevention/flaky-test-memory.test.ts`).
 * Recording is unconditional — an empty array says "recorded, no failures",
 * which is a different fact from a run that recorded nothing.
 *
 * Identity is `<file>::<full test name>`: the file because two suites may
 * share a test name, the full name because a suite may repeat a case name.
 * A module that FAILED WITH NO FAILED CASE of its own — a collection error,
 * a `beforeAll` throw, an unhandled rejection — is one row
 * `<file>::<module>` ({@link MODULE_FAILURE_ROW}): such a file used to add
 * no row at all, so a whole red file was invisible to the ledger and to the
 * receipt diff (the WF-1b2 design review: 47 red files compared by hand).
 * The failure MESSAGE is not part of the identity (it is evidence about one
 * occurrence: timings, paths, machine state, and an identity carrying it
 * would never match across runs); its normalized DIGEST rides beside the
 * row (`digests`, `failureDigest`), so a comparison can tell an identity
 * that now fails differently.
 *
 * EXPORTED AND DRIVEN: the verdict tests plant modules with failing and
 * passing cases and assert the exact rows, because a compute-then-discard
 * mutant of this function is precisely the wired-but-inert shape.
 */
export function failuresOf(testModules: readonly ModuleLike[], cwd: string): Readonly<{
  rows: string[]; digests: Record<string, string>; complete: boolean; outcomes: GateOutcome[];
  /** Where each failure happened (`failureLocation`: its operator and its test file's own frames), when its error names it. */
  locations: Record<string, string>;
  /** The identities of the cases that PASSED, spelled as the failure rows are (a reproduction reads both). */
  passed: string[];
}> {
  const rows: string[] = [];
  const passed: string[] = [];
  const digests: Record<string, string> = {};
  const locations: Record<string, string> = {};
  const outcomes: GateOutcome[] = [];
  let complete = testModules.length > 0;
  const counts = { passed: 0, failed: 0, skipped: 0 };
  const incomplete = (message: string): void => {
    complete = false;
    outcomes.push({ gate: "test-results", kind: "fail", message });
  };
  const record = (row: string, error: { readonly message: string; readonly name?: string; readonly stack?: string; readonly operator?: unknown } | undefined): void => {
    if (rows.includes(row)) incomplete(`distinct failed tasks share the historical identity ${row}`);
    else rows.push(row);
    if (error === undefined) return;
    const statement = { name: error.name ?? null, message: error.message, stack: error.stack ?? null, operator: typeof error.operator === "string" ? error.operator : null };
    digests[row] = failureDigest(statement, cwd);
    const file = failureIdentityFile(row);
    const location = file === null ? null : failureLocation(statement, file);
    if (location !== null) locations[row] = location;
  };
  const moduleIds = new Set<string>();
  const caseIds = new Set<string>();
  const suiteIds = new Set<string>();
  const admitId = (value: unknown, seen: Set<string>): value is string => {
    if (typeof value !== "string" || value.trim().length === 0 || seen.has(value)) return false;
    seen.add(value);
    return true;
  };
  for (const mod of testModules) {
    const moduleId = readOr(() => mod.moduleId, undefined);
    const id = typeof moduleId === "string" && moduleId.trim().length > 0 ? moduleId : "<unknown>";
    const file = relative(cwd, id);
    let caseRows = 0;
    const caseStates = new Map<string, unknown>();
    if (id === "<unknown>" || !admitId(readOr(() => mod.id, undefined), moduleIds)) incomplete("a module task identity or path is missing, unreadable or duplicated");
    try {
      if (typeof mod.children?.allTests !== "function") throw new Error("missing test collection");
      for (const testCase of mod.children.allTests()) {
        let result: ReturnType<NonNullable<TestCaseLike["result"]>>;
        try { result = testCase.result?.(); }
        catch { incomplete(`${file}: a case result could not be read`); continue; }
        if (result === undefined || typeof result.state !== "string" || !["passed", "failed", "skipped"].includes(result.state)) {
          incomplete(`${file}: a case has no terminal result`); continue;
        }
        const errors = observeErrors(() => result.errors, true);
        if (!errors.complete) incomplete(`${file}: a case error census is malformed or unreadable`);
        const name = testCase.fullName;
        const taskId = testCase.id;
        if (!admitId(taskId, caseIds) || typeof name !== "string" || name.trim().length === 0) incomplete(`${file}: a case task identity or display name is missing or duplicated`);
        else caseStates.set(taskId, result.state);
        counts[result.state as keyof typeof counts] += 1;
        // Retried-passed cases legitimately retain earlier errors. Their final
        // passed state owns the result; failed cases alone enter the test rows.
        if (result.state === "passed" && typeof name === "string" && name.length > 0) passed.push(`${file}::${name}`);
        if (result.state !== "failed" || typeof name !== "string" || name.length === 0) continue;
        record(`${file}::${name}`, errors.errors[0]);
        caseRows += 1;
      }
    } catch { incomplete(`${file}: the test collection could not be read`); }
    const moduleErrors = observeErrors(() => mod.errors?.());
    if (!moduleErrors.complete) incomplete(`${file}: module error census is malformed or unreadable`);
    const moduleState = readOr(() => mod.state?.(), undefined);
    if (typeof moduleState !== "string" || !["passed", "failed", "skipped"].includes(moduleState)) incomplete(`${file}: module terminal result is missing or unreadable`);
    if (moduleErrors.errors.length > 0) outcomes.push({ gate: "module-errors", kind: "fail", message: `${file}: ${String(moduleErrors.errors.length)} independent module error(s)` });
    if (caseRows === 0 && (moduleState === "failed" || moduleErrors.errors.length > 0)) record(`${file}::${MODULE_FAILURE_ROW}`, moduleErrors.errors[0]);
    // Preserve the historical module failure row, but it cannot explain an
    // unknown terminal cause in current admission merely by existing.
    if (moduleState === "failed" && caseRows === 0 && moduleErrors.errors.length === 0) incomplete(`${file}: failed module has no accounted failing case or error`);
    try {
      if (typeof mod.children?.allSuites !== "function") throw new Error("missing suite collection");
      for (const suite of mod.children.allSuites()) {
        const name = suite.fullName;
        if (!admitId(suite.id, suiteIds) || typeof name !== "string" || name.trim().length === 0) incomplete(`${file}: a suite task identity or display name is missing or duplicated`);
        const observedErrors = observeErrors(() => suite.errors?.());
        if (!observedErrors.complete) incomplete(`${file}: nested suite error census is malformed or unreadable`);
        const errors = observedErrors.errors;
        const state = suite.state?.();
        if (typeof state !== "string" || !["passed", "failed", "skipped"].includes(state)) { incomplete(`${file}: nested suite terminal result is missing or unreadable`); continue; }
        if (errors.length > 0) outcomes.push({ gate: "suite-errors", kind: "fail", message: `${file}: ${String(errors.length)} independent nested suite error(s)` });
        if (state === "failed" && errors.length === 0) {
          if (typeof suite.children?.allTests !== "function") { incomplete(`${file}: failed suite has no readable case collection`); continue; }
          if (![...suite.children.allTests()].some((testCase) => typeof testCase.id === "string" && caseStates.get(testCase.id) === "failed")) incomplete(`${file}: failed suite has no accounted failing case or error`);
        }
      }
    } catch { incomplete(`${file}: nested suite results could not be read`); }
  }
  if (testModules.length === 0) incomplete("no test modules were reported");
  outcomes.push({ gate: "test-results", kind: complete ? "pass" : "fail",
    message: `${String(counts.passed)} passed, ${String(counts.failed)} failed, ${String(counts.skipped)} skipped under the existing web skip policy; result census ${complete ? "complete" : "incomplete"}` });
  return { rows, digests, locations, complete, outcomes, passed };
}

/** `read()`, or `fallback` when it throws (a reporter never loses its summary to one unreadable field). */
function readOr<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/** A module's diagnostics, or null when vitest did not report any. */
function diagnosticOf(mod: ModuleLike): Readonly<Record<string, unknown>> | null {
  if (typeof mod.diagnostic !== "function") return null;
  try {
    return mod.diagnostic() ?? null;
  } catch {
    return null;
  }
}

function finiteAt(d: Readonly<Record<string, unknown>> | null, key: string): number | null {
  const v = d?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Every field of vitest's own module diagnostics that measures time a worker
 * was occupied by this file.
 *
 * Named here, once, rather than summed inline at the call site: the total is
 * the number a per-file budget is judged against, and a field silently
 * dropped from the sum would lower every file's measured cost and quietly
 * vacate that budget.
 */
const OCCUPANCY_FIELDS = [
  "collectDuration",
  "setupDuration",
  "environmentSetupDuration",
  "prepareDuration",
  "duration",
] as const;

/** Everything the file cost a worker, or null when vitest reported nothing. */
function totalMsOf(d: Readonly<Record<string, unknown>> | null): number | null {
  let total = 0;
  let any = false;
  for (const field of OCCUPANCY_FIELDS) {
    const ms = finiteAt(d, field);
    if (ms === null) continue;
    any = true;
    total += ms;
  }
  return any ? total : null;
}

/**
 * How many entries vitest's transform cache held before this run started.
 *
 * A COLD cache is not contention and cannot be normalised away: it is real
 * transform work that a warm run simply does not do. Measured across full
 * runs of this suite, worst `collectDuration` as a share of wall clock is
 * ~0.036–0.043 warm (idle OR under eight burners) and ~0.100–0.115 cold —
 * a 2.7× step that no load-invariant ratio removes, because the load is not
 * where it comes from.
 *
 * So the run's cache state is RECORDED, and a cold run is reported as
 * unmeasurable rather than judged. That matters because a cold run is
 * MANDATORY after any edit in the sibling repository, which is how the remedy
 * one guard requires came to manufacture another guard's red.
 *
 * Absence is not zero here either: a directory that cannot be read at all
 * gives `null`, which the verdict treats as "cannot say", never as "cold".
 */
function moduleCacheEntries(dir: string): number | null {
  try {
    return readdirSync(dir).length;
  } catch {
    // ENOENT is the state `npx vitest --clearCache` leaves behind: the
    // directory is removed, not emptied. That IS zero entries, and it is the
    // one absence that is genuinely a measurement.
    return existsSync(dirname(dir)) ? 0 : null;
  }
}

/**
 * How many files in the cache were WRITTEN at or after `sinceMs` — the run's
 * own transform work, which is the quantity a count delta cannot see when an
 * entry is replaced in place (same name, new bytes, new mtime) — AND the
 * newest mtime the walk observed, which is the count's witness.
 *
 * `>=` rather than `>` on purpose: the boundary belongs to the run, and the
 * only cost of the inclusive edge is counting the config graph's handful of
 * entries when their write and `onInit` land in the same millisecond — noise
 * against a threshold of half the cache. A file that vanishes between the
 * readdir and its stat was not written by this run's transforms; it is
 * skipped rather than allowed to throw away the whole reading.
 *
 * EXPORTED AND DRIVEN (`web-ui-runtime-budget-verdict.test.ts` plants mtimes
 * in a temp directory and asserts the exact counts): the S37-check proved a
 * compute-then-return-0 mutant of this function let a fully cold run be
 * judged into the ledger with all 95 guard tests green, because nothing ever
 * drove the measurement itself against a real directory. The witness is
 * computed by the SAME walk, so that mutant now produces a zero beside a
 * newest mtime at or after the run's start — a contradiction the verdict
 * refuses to call warm.
 */
export function cacheEntriesWrittenSince(
  dir: string,
  sinceMs: number,
): { written: number; newestMtimeMs: number | null } | null {
  try {
    let written = 0;
    let newestMtimeMs: number | null = null;
    for (const name of readdirSync(dir)) {
      try {
        const mtimeMs = statSync(join(dir, name)).mtimeMs;
        if (mtimeMs >= sinceMs) written++;
        if (newestMtimeMs === null || mtimeMs > newestMtimeMs) newestMtimeMs = mtimeMs;
      } catch {
        // Deleted mid-scan: not transform work this run is paying for.
      }
    }
    return { written, newestMtimeMs };
  } catch {
    // Same absence semantics as the entry count: a removed directory is
    // genuinely zero writes; an unreadable one is no measurement at all.
    return existsSync(dirname(dir)) ? { written: 0, newestMtimeMs: null } : null;
  }
}

/** Structural view of the Vitest instance a reporter's `onInit` receives.
 *  Vitest's own type is not imported for the reason `ModuleLike` gives. */
interface VitestLike {
  readonly config?: { readonly experimental?: unknown; readonly shard?: unknown };
}

/**
 * Everything a test must supply to drive this reporter without touching the
 * real run — all of it, or none of it.
 *
 * EVERY FIELD IS REQUIRED ON PURPOSE. An optional `out` is an `out` somebody
 * will omit, and the omission is invisible until an operator reads a gate
 * verdict that belongs to a fixture. These are the six observables a run has:
 * the summary file, the ledger, the cache directory it measures, stdout,
 * stderr and the process exit code. Five were already redirectable and one was
 * not, which is exactly where the impersonation came out.
 */
export type ReporterHarness = Readonly<{
  readonly summaryPath: string;
  readonly historyPath: string;
  readonly cacheDir: string;
  /**
   * The repository whose tree the run is recorded against (the tree id read
   * at start and end, HEAD, the tracked-dirty mark) — production: the
   * folder the run started in. A test hands a small fixture repository: the
   * identity reads hash the whole working tree twice per run, and a reporter
   * fixture driven against the real checkout paid that for every drive
   * (LAND-OC-FIX: the per-test ceilings raised to 120 s were this cost).
   */
  readonly repositoryRoot: string;
  /**
   * The instrument lock the run's stamp is read from (engine/src/process/instrument-lock.ts)
   * — production: the host's, from config; a test names its own lock file.
   * The stamp is always READ from the lock's live holder, never stated.
   */
  readonly instrumentLockPath: string;
  /** The profile report the performance budgets are judged from — production: the one path the profile step writes. */
  readonly performanceReportPath: string;
  readonly out: (chunk: string) => void;
  readonly err: (chunk: string) => void;
  readonly setExitCode: (code: number) => void;
}>;

export default class BudgetReporter {
  private startTime = 0;
  private loadAtStart = 0;
  private load5AtStart = 0;
  private load15AtStart = 0;
  private cacheEntriesAtStart: number | null = null;
  /**
   * The cache directory THIS RUN uses, resolved from the run's own config.
   *
   * NOT A CONSTANT, AND THAT WAS THE COLD ARM'S HOLE. See `moduleCacheDirOf`.
   * Recorded in the summary as well, so a reading names the directory it was
   * taken from — the generalisation of "record the invoking argv in each
   * summary, so a reader can say which run wrote it".
   */
  private cacheDir = moduleCacheDirOf(undefined);
  /** The tree read at `onInit` (null: unread, or `onInit` never ran). */
  private treeAtStart: string | null = null;
  private invocationId: string | undefined;
  private expectedModules: ReadonlyMap<string, string> | undefined;
  private configuredShard = false;
  private readonly summaryPath: string;
  private readonly historyPath: string | undefined;
  private readonly cacheDirOverride: string | undefined;
  private readonly repositoryRoot: string;
  private readonly instrumentLockPathOverride: string | undefined;
  private readonly performanceReportPath: string;
  private readonly out: (chunk: string) => void;
  private readonly err: (chunk: string) => void;
  private readonly fail: (code: number) => void;

  /**
   * Vitest constructs this with NO arguments; a test supplies EVERY field or
   * none.
   *
   * ── WHY THE HARNESS SHAPE IS ALL-OR-NOTHING ─────────────────────────────
   *
   * The file paths were already overridable, for a good reason: the live
   * summary and ledger are shared state a concurrent run may be writing
   * (observed twice in one read-only check), so a test that let the defaults
   * stand would be mutating the artifacts every other run reads.
   *
   * The OUTPUT was not, and that was the same defect one step further out. A
   * test driving a deliberately-refused run printed
   * `[runtime-budget] <gate>: NOT JUDGED — the recorded run covered 3 test
   * files` onto the REAL run's stdout, byte-identical to the product's own
   * line, from a fixture the operator has no way to know exists. It cost a
   * writer a full extra run chasing a gate that was never unarmed. A test's
   * output wearing the product's exact bytes is a defect on its own terms: the
   * one place everybody looks stops being evidence about the run.
   *
   * So the override is a SINGLE object with every field REQUIRED, rather than
   * a bag of optionals. Forgetting the sink is then a compile error rather
   * than a line on somebody else's terminal — the state is unreachable by
   * shape instead of merely discouraged, which is the only version of this
   * that survives the next test somebody adds. `process.exitCode` rides along
   * for the same reason: it is an observable of the real run, and a fabricated
   * gate result must not be able to reach it.
   */
  constructor(harness?: ReporterHarness) {
    this.summaryPath = harness?.summaryPath ?? SUMMARY_PATH;
    this.historyPath = harness?.historyPath;
    this.cacheDirOverride = harness?.cacheDir;
    this.repositoryRoot = harness?.repositoryRoot ?? process.cwd();
    this.instrumentLockPathOverride = harness?.instrumentLockPath;
    this.performanceReportPath = harness?.performanceReportPath ?? REPORT_PATH;
    this.out = harness?.out ?? ((chunk) => void process.stdout.write(chunk));
    this.err = harness?.err ?? ((chunk) => void process.stderr.write(chunk));
    this.fail = harness?.setExitCode ?? ((code) => void (process.exitCode = code));
  }

  onInit(ctx?: unknown): void {
    this.startTime = Date.now();
    this.expectedModules = undefined;
    this.configuredShard = (ctx as VitestLike | undefined)?.config?.shard != null;
    // Read BEFORE the suite loads the box, so this is the ambient load the
    // run had to compete with rather than the load the run itself created.
    // ONE read, all three legs: the 1-minute figure feeds the provisional
    // threshold, and the 5-/15-minute figures record the saturation ghost
    // the 1-minute leg decays away — three reads at three moments would be
    // three different "run starts".
    const loads = loadavg();
    this.loadAtStart = loads[0] ?? 0;
    this.load5AtStart = loads[1] ?? 0;
    this.load15AtStart = loads[2] ?? 0;
    this.cacheDir =
      this.cacheDirOverride ?? moduleCacheDirOf((ctx as VitestLike | undefined)?.config?.experimental);
    // Recorded for the pair, NOT because it can answer "was this run cold" on
    // its own: by the time `onInit` runs, vitest has already transformed its
    // config graph and the cache is never empty. See the field's own comment.
    this.cacheEntriesAtStart = moduleCacheEntries(this.cacheDir);
    // The tree the run starts on, before any test: the row carries it only
    // when the end's read finds it unchanged.
    this.treeAtStart = readMeasuredTree(this.repositoryRoot);
    this.invocationId = qualificationInvocation(process.env);
  }

  /** The public start hook precedes sharding. Task IDs bind verbatim module paths;
   * distinct projects/pools may legitimately share one path. */
  onTestRunStart(specifications: readonly { readonly taskId?: unknown; readonly moduleId?: unknown }[]): void {
    this.expectedModules = undefined;
    const modules = new Map<string, string>();
    try {
      for (const specification of specifications) {
        const id = specification.taskId;
        const path = specification.moduleId;
        if (typeof id !== "string" || id.trim().length === 0 || modules.has(id)
          || typeof path !== "string" || path.trim().length === 0) return;
        modules.set(id, path);
      }
      if (modules.size > 0) this.expectedModules = modules;
    } catch { /* Unreadable intent remains absent, never inferred from arrivals. */ }
  }

  private moduleCensus(modules: readonly ModuleLike[]): GateOutcome {
    const expected = this.expectedModules;
    const actual = modules.map((mod) => readOr(() => mod.id, undefined));
    // THE EMPTY-SUITE DEAD-END (`passWithNoTests`). A run that planned no
    // specifications and reported no modules matched no test files, and the
    // config's `passWithNoTests: true` promises that run exits clean — a
    // signpost, never a failure. With nothing intended and nothing arrived
    // there is nothing this gate can certify, so the honest verdict is
    // NOT JUDGED. The gate bites the moment either side is populated:
    // intent with no terminal modules is the omitted-task red below, and
    // terminal modules with no readable intent is the missing-census red.
    if (expected === undefined && modules.length === 0) {
      return { gate: "module-census", kind: "not-judged", message: "no intended specifications and no terminal modules: the passWithNoTests empty suite judges nothing" };
    }
    if (expected === undefined || actual.some((id, index) => typeof id !== "string" || !expected.has(id)
      || expected.get(id) !== readOr(() => modules[index]!.moduleId, undefined))) {
      return { gate: "module-census", kind: "fail", message: "the intended task census is missing, malformed, or disagrees with terminal task identities or paths" };
    }
    const arrived = new Set(actual);
    if (arrived.size !== actual.length) return { gate: "module-census", kind: "fail", message: "terminal task identities are duplicated" };
    if (arrived.size === expected.size) return { gate: "module-census", kind: "pass", message: "every intended task has exactly one terminal module" };
    // Public start specifications precede shard selection. A successful shard
    // remains usable but cannot certify the omitted part of full qualification.
    return this.configuredShard
      ? { gate: "qualification-scope", kind: "not-judged", message: "configured shard has partial scope; full intended module completion is unproven" }
      : { gate: "module-census", kind: "fail", message: "terminal modules omit intended tasks" };
  }

  onTestRunEnd(testModules?: readonly ModuleLike[], unhandledErrors?: readonly ErrorLike[], reason?: "passed" | "failed" | "interrupted"): void {
    const wallClockMs = this.startTime > 0 ? Date.now() - this.startTime : 0;
    const modules = testModules ?? [];
    const cpuCount = Math.max(1, cpus().length);
    // ONE walk: the written count and its newest-mtime witness must come
    // from the same pass, or the contradiction check compares two moments.
    const written =
      this.startTime > 0 ? cacheEntriesWrittenSince(this.cacheDir, this.startTime) : null;

    const collects: CollectCost[] = [];
    const totals: CollectCost[] = [];
    for (const mod of modules) {
      const diag = diagnosticOf(mod);
      const moduleId = readOr(() => mod.moduleId, undefined);
      const id = typeof moduleId === "string" ? moduleId : "<unknown>";
      const file = relative(process.cwd(), id);
      const collectMs = finiteAt(diag, "collectDuration");
      if (collectMs !== null) collects.push({ file, ms: Math.round(collectMs) });
      const totalMs = totalMsOf(diag);
      if (totalMs !== null) totals.push({ file, ms: Math.round(totalMs) });
    }
    const totalOccupancyMs = Math.round(totals.reduce((sum, t) => sum + t.ms, 0));
    collects.sort((a, b) => b.ms - a.ms);
    totals.sort((a, b) => b.ms - a.ms);

    const summary: BudgetSummary = {
      wallClockMs,
      timestamp: new Date().toISOString(),
      testModuleCount: modules.length,
      slowestCollects: collects.slice(0, SLOWEST_COLLECT_KEPT),
      slowestFiles: totals.slice(0, SLOWEST_FILES_KEPT),
      totalOccupancyMs,
      // THE DENOMINATOR THE COLLECT GATE NEEDED AND DID NOT HAVE. Only the
      // five worst collects were written down, so the one number that makes a
      // worst-collect figure comparable across machines and loads — what every
      // OTHER file spent doing the same thing — did not exist on disk.
      totalCollectMs: Math.round(collects.reduce((sum, c) => sum + c.ms, 0)),
      moduleCacheEntriesAtStart: this.cacheEntriesAtStart,
      // The OTHER end of the pair, read at the last moment the run still
      // exists. A reading taken at `onInit` instead would make start and end
      // equal, the built fraction zero, and every run "warm" — which is why
      // the verdict floors this against the run's own module count.
      moduleCacheEntriesAtEnd: moduleCacheEntries(this.cacheDir),
      // Transform work measured by mtime, not by count — the field the
      // verdict judges warmth on. A start time of 0 means `onInit` never ran,
      // and a reading taken against it would classify the whole cache as
      // written by this run; absence is the honest answer there. The newest
      // mtime rides along from the SAME walk as the count's witness, and the
      // run-start reference beside it — the verdict refuses a zero count
      // whose witness says a write happened.
      moduleCacheEntriesWrittenDuringRun: written?.written ?? null,
      moduleCacheNewestEntryMtimeMs: written?.newestMtimeMs ?? null,
      runStartedAtMs: this.startTime > 0 ? this.startTime : null,
      moduleCacheDir: this.cacheDir,
      load1PerCpuAtStart: Number((this.loadAtStart / cpuCount).toFixed(3)),
      load5PerCpuAtStart: Number((this.load5AtStart / cpuCount).toFixed(3)),
      load15PerCpuAtStart: Number((this.load15AtStart / cpuCount).toFixed(3)),
      cpuCount,
      // Read HERE rather than at process exit: this is the last hook vitest
      // gives a reporter that still runs inside the run, and the pool workers
      // are reaped children by the time it fires. Absence stays absent — a
      // missing CPU reading must not become a zero.
      runCpuMs: readRunCpu()?.totalCpuMs ?? null,
    };

    let summaryWriteFailed = false;
    try {
      mkdirSync(dirname(this.summaryPath), { recursive: true });
      writeFileSync(this.summaryPath, JSON.stringify(summary));
    } catch {
      summaryWriteFailed = true;
    }

    const recorded = failuresOf(modules, process.cwd());
    const census = this.moduleCensus(modules);
    // The same dead-end at the result census. `failuresOf` rightly calls a
    // zero-module census incomplete, and an intended-but-missing run must
    // stay exactly that red — but an empty suite has no results to lose:
    // the run that `passWithNoTests` lets exit clean is NOT JUDGED here
    // too, never failed. Only the no-intent/no-module state takes this
    // arm; one intended module reported by nobody keeps every gate red.
    const emptySuite = modules.length === 0 && this.expectedModules === undefined;
    const outcomes: GateOutcome[] = emptySuite
      ? [{ gate: "test-results", kind: "not-judged", message: "no modules reported and none intended: the passWithNoTests empty suite leaves no result census to judge" }, census]
      : [...recorded.outcomes, census];
    let complete = recorded.complete && census.kind === "pass";
    if (summaryWriteFailed) {
      complete = false;
      outcomes.push({ gate: "web-summary", kind: "fail", message: "the run summary could not be published" });
    }
    const globalErrors = observeErrors(() => unhandledErrors);
    if (!globalErrors.complete) {
      complete = false;
      outcomes.push({ gate: "runner-terminal", kind: "fail", message: "terminal unhandled error census is missing, malformed or unreadable" });
    }
    if (typeof reason !== "string" || !["passed", "failed", "interrupted"].includes(reason)) {
      complete = false;
      outcomes.push({ gate: "runner-terminal", kind: "fail", message: "terminal hook error/reason channels are missing" });
    } else {
      if (globalErrors.errors.length > 0) outcomes.push({ gate: "unhandled-errors", kind: "fail", message: `${String(globalErrors.errors.length)} independent unhandled error(s)` });
      if (reason === "interrupted") outcomes.push({ gate: "runner-terminal", kind: "fail", message: "Vitest run was interrupted" });
      if (reason === "passed" && recorded.rows.length > 0) outcomes.push({ gate: "runner-terminal", kind: "fail", message: "passed terminal reason contradicts failed test rows" });
      if (reason === "failed" && recorded.rows.length === 0 && !outcomes.some((outcome) => outcome.kind === "fail")) outcomes.push({ gate: "runner-terminal", kind: "fail", message: "failed terminal reason has no accounted failure" });
    }
    this.judgeThisRun(summary, { ...recorded, complete, outcomes });
  }

  /**
   * JUDGE THE RUN THAT IS ENDING — not the one before it.
   *
   * The three run-cost gates used to be tests inside the suite, which meant
   * they read a summary written at the END of the PREVIOUS run: a verdict
   * about a run nobody was looking at, on data that had already been
   * overwritten by the time anyone went to check. Here the numbers are the
   * ones printed a few lines above, for the run whose output the operator is
   * reading.
   *
   * `summary` is passed as an OBJECT, not re-read from disk. Re-reading would
   * reintroduce the same class of defect one layer down: the artifact is
   * gitignored and has been observed changing underneath a reader twice in one
   * check, because a concurrent single-file run invokes this same reporter.
   *
   * `process.exitCode` is set rather than thrown: a throw from a reporter
   * prints `error during close` and STILL EXITS 0 — measured in this project.
   * That the exit code survives was also measured rather than assumed: 7 set
   * here reached the shell as rc 7.
   */
  private judgeThisRun(summary: BudgetSummary, recorded: ReturnType<typeof failuresOf>): void {
    let outcomes: readonly GateOutcome[];
    try {
      const verdict = judgeRuntimeBudget(summary, {
        fullRunModuleCount: fullRunModuleCount(),
      });
      if (verdict.kind === "measured") this.out(`${provenanceLine(verdict)}\n`);
      this.out(
        `[runtime-budget] module cache: ${String(summary.moduleCacheEntriesAtStart)} → ` +
          `${String(summary.moduleCacheEntriesAtEnd)} entries, ` +
          `${String(summary.moduleCacheEntriesWrittenDuringRun)} written during the run, in ` +
          `${summary.moduleCacheDir}\n`,
      );
      const budget = readCpuBudget();
      // History is read BEFORE this run is appended, so the baseline the
      // gate derives is made of the preceding rows only, never this run's own
      // reading (one judged run against the cap in force: UR-24-BUDGETS).
      const priorRuns =
        this.historyPath === undefined ? readRunHistory() : readRunHistory(this.historyPath);
      // THE STANDING BASELINE LINE — the disclosure the rolling design owes
      // on every run: which baseline judges this run, from what window, at
      // what floor. A baseline that moved and said nothing would be the
      // silent climb the feed filter's construction exists to prevent.
      const derivation =
        verdict.kind === "measured" && !("missing" in budget)
          ? deriveRollingBaseline(
              budget,
              priorRuns,
              verdict.testModuleCount,
              WEB_BUDGET_FAILURE_IDENTITIES,
            )
          : null;
      if (derivation !== null) this.out(`${baselineLine(derivation)}\n`);
      outcomes = [...judgeRunCosts(verdict, {
        cpuBudget: budget,
        fileShareMax: readFileShareMax(),
        priorRuns,
        suiteLabel: "web-UI",
        budgetFailureIdentities: WEB_BUDGET_FAILURE_IDENTITIES,
      }), ...recorded.outcomes];
      // THE PERFORMANCE BUDGETS, IN THE SAME JUDGEMENT: a full run judges the
      // profile report's measurements (scripts/testing/performance-measurements.ts)
      // and its row records them, for the workspace's ledger judge (owned, not worse).
      const performance = verdict.kind === "measured" ? judgePerformanceBudgets(this.repositoryRoot, this.performanceReportPath, getPerformanceBudgetConfig()) : undefined;
      if (performance !== undefined) outcomes = [...outcomes, ...performance.outcomes];
      // AN UNSLOTTED MEASUREMENT IS REFUSED, NEVER JUDGED (the host's one
      // the host's one instrument lock, engine/src/process/instrument-lock.ts): without it another
      // writer's heavy run may have shared the cores, so the cost says
      // nothing about this tree. The runner holds the slot for every full run.
      const engineRoot = join(this.repositoryRoot, "engine");
      const lockConfig = readTestExecutionConfig(engineRoot).instrumentLock;
      const lockPath = this.instrumentLockPathOverride ?? (lockConfig === undefined ? undefined : instrumentLockPath(lockConfig, engineRoot));
      const heavySlot = lockPath === undefined ? "unslotted" : instrumentLockStamp(lockPath);
      if (verdict.kind === "measured" && heavySlot !== "held") {
        // Refused like the engine runner's: failed, said, and NOT recorded.
        this.err(
          "\n[runtime-budget] cpu-per-test-file REFUSED: this run did not hold the host's instrument lock, so its CPU cost is not a " +
            "measurement of this tree and is neither judged nor recorded. Run the suite through its runner (`npm test`), which holds the lock.\n",
        );
        this.fail(1);
        return;
      }
      // Only a JUDGED run enters the ledger — a refusal proved nothing about
      // the tree, so it must never feed a baseline. That
      // this guard sits OUTSIDE the append (rather than inside it) is pinned
      // by a test that drives a refused run and asserts the ledger unchanged.
      if (verdict.kind === "measured") {
        // Tree identity + measurement condition ride into the ledger so a
        // future cap re-derivation can demand same-sha, same-condition
        // samples — the recorded confound: same tree, same day, 1287.6 vs
        // ~2060 ms/file under different ambient conditions. An unreadable
        // sha stays ABSENT (never a placeholder); the ambient figure is the
        // one this reporter already measured at run start.
        const headSha = readRepositoryHeadSha(this.repositoryRoot);
        // The provisional judgement, derived through the tree-identity
        // owner's ONE spelling (ridden through the ledger's web binding): a
        // run whose TRACKED tree differs from HEAD measured mid-edit code,
        // so its failure rows must not indict the committed tree in the
        // flaky-test memory. Untracked scratch or gitignored artifacts do
        // not mark it — they are not edits to the committed source. An
        // unreadable answer records nothing (the row then counts as a real
        // failure: absence of provenance is not innocence).
        const tree = measuredTreeMark(this.repositoryRoot, this.treeAtStart);
        const record = {
          ...(tree.treeId === undefined || this.invocationId === undefined ? {} : { qualification: {
            schemaVersion: 1 as const, invocationId: this.invocationId, treeId: tree.treeId,
            producer: "web" as const, producerComplete: recorded.complete, outcomes,
          } }),
          timestamp: verdict.summaryTimestamp,
          cpuMsPerTestFile: verdict.cpuMsPerTestFile,
          testModuleCount: verdict.testModuleCount,
          ...(headSha !== null ? { headSha } : {}),
          ambientLoadPerCpu: verdict.load1PerCpuAtStart,
          // The pre-launch snapshot's longer legs ride beside the 1-minute
          // figure: one row now carries the whole run-start loadavg triple,
          // so the 15-minute saturation ghost is read from the record
          // instead of rebuilt from tracker prose.
          ambientLoad5PerCpu: verdict.load5PerCpuAtStart,
          ambientLoad15PerCpu: verdict.load15PerCpuAtStart,
          // The run's wall clock and pool occupancy — the during-run
          // calibration fields for any future ambient-envelope derivation
          // (the occupancy/CPU ratio is the in-situ contention signal; the
          // 2026-09-04 pairs show ≈0.99 for both a quiet and an inflated
          // run, so nothing judges by them today). Recorded, never judged.
          wallClockMs: verdict.wallClockMs,
          totalOccupancyMs: verdict.totalOccupancyMs,
          // The run's failure rows ride into the ledger — the memory a
          // flaky-test guard reads. Unconditional, so "recorded, no failures"
          // is distinguishable from "recorded nothing" (a legacy entry).
          failures: recorded.rows,
          ...(performance?.measurements === undefined ? {} : { [ROOT_POLICY.workflow.webPerformanceBudgets.ledgerField]: performance.measurements }),
          ...(Object.keys(recorded.digests).length > 0 ? { failureDigests: recorded.digests } : {}),
          ...(Object.keys(recorded.locations).length > 0 ? { failureLocations: recorded.locations } : {}),
          // The baseline that judged this run — recorded provenance, the
          // same reason the ambient legs ride along: a reader of the row
          // (or the chain-watch) can see which cap was in force without
          // re-deriving it from the rows above. The derivation recomputes
          // from the ledger on every read; this field is the row's own
          // record of what judged it, never an input.
          ...(derivation !== null
            ? { baselineMsPerTestFile: derivation.baselineMsPerTestFile }
            : {}),
          ...provisionalFailureMark(this.repositoryRoot),
          // The tree this run measured: the like-for-like key a later commit
          // of exactly this tree (a candidate's qualification, landed) finds
          // the run by — only when it is still the tree read at `onInit`.
          ...tree,
          // The deliberate-mutation provenance: a run launched with
          // HARNESS_MUTATION_RUN=1 is the operator's own verification red,
          // and the flaky memory must not read it as the suite's flakiness.
          ...mutationRunMark(),
          // Whether the measurement held the host's heavy slot: an unslotted
          // row never feeds a baseline (budget-verdict's feed filter).
          heavySlot,
        };
        if (this.historyPath === undefined) appendJudgedRun(record);
        else appendJudgedRun(record, this.historyPath);
      }
    } catch (err) {
      // THE INSTRUMENT ITSELF FAILING IS A RED, NOT A SHRUG. A budget that
      // cannot run its own decision has not found the suite healthy; it has
      // found nothing, and reporting nothing as success is the whole failure
      // mode this mechanism exists to refuse.
      this.err(
        `\n[runtime-budget] THE GATE COULD NOT RUN: ${err instanceof Error ? err.message : String(err)}\n` +
          `[runtime-budget] A guard that cannot evaluate has not passed. Failing the run.\n`,
      );
      this.fail(1);
      return;
    }

    // A REFUSAL IS PRINTED, NEVER SWALLOWED — and so is a WARN.
    // "Within budget", "over the cap but not yet a verdict" and "there was
    // no evidence to look at" are three different results, and the summary
    // line is the one place everybody looks. There is no provisional colour
    // any more: a busy ambient is PAID FOR by the ambient adjustment in
    // every judgement line, never deferred, and nothing waits for a quiet
    // box.
    for (const o of outcomes) {
      if (o.kind === "not-judged") {
        this.out(`[runtime-budget] ${o.gate}: NOT JUDGED — ${o.message}\n`);
      }
    }

    const failures = outcomes.filter((o) => o.kind === "fail");
    if (failures.length === 0) return;
    this.err(
      `\n⎯⎯⎯⎯⎯⎯ RUNTIME BUDGET: ${String(failures.length)} gate(s) failed on THIS run ⎯⎯⎯⎯⎯⎯\n\n` +
        failures.map((f) => `[${f.gate}]\n${f.message}\n`).join("\n") +
        `\nThese are judged by tests/reporters/budget-reporter.ts, which is why they do not\n` +
        `appear as a failing test file: the numbers are totals over every module, and no\n` +
        `test running inside the run can see them.\n\n`,
    );
    this.fail(1);
  }
}
