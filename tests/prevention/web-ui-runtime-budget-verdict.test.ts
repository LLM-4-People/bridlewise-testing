// @vitest-environment node
/**
 * THE BUDGET'S REFUSAL PATH, DRIVEN DIRECTLY.
 *
 * `web-ui-runtime-budget.test.ts` judges whatever summary the previous run
 * left on disk, so in any single run exactly ONE of its branches executes —
 * and the branch that matters most (refusing to judge) is the one that fires
 * rarest. A refusal that is never exercised is a refusal that will one day
 * swallow a real regression without anyone noticing it stopped judging.
 *
 * So the decision is a pure function (`tests/helpers/budget-verdict.ts`) and
 * every branch is driven here with a fabricated summary.
 *
 * The case this exists for: a single-file `vitest run` invokes the same
 * reporter and overwrites the summary. Measured — after one such run the
 * summary read `{"wallClockMs":174}`, and the next FULL run compared 174ms
 * against a 35,000ms budget and passed. That is a guard reporting success
 * because it had been disarmed.
 *
 * It now also drives `judgePopulationDrift` — the mechanism that makes a
 * budget name the population it bounds — and `readRunCpu`, the measurement
 * the budget is judged on. Neither fires on a healthy tree, which is exactly
 * why neither can be left to fire for the first time in anger.
 */
import { beforeAll, describe, expect, test, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createTempDir } from "../helpers/temp-dir.ts";
import { judgePerformanceBudgets, performanceGate, performanceMeasurements } from "../../scripts/testing/performance-measurements.ts";
import type { ProfileReport } from "../performance/lib/perf-harness.ts";
import { readMeasuredSurfaceHash } from "../../engine/src/shared/tree-identity.ts";
import { ROOT_POLICY } from "../../engine/src/kernel/root-policy.ts";

import { createTempGitRepo } from "../helpers/temp-git-repo.ts";
import BudgetReporter, { cacheEntriesWrittenSince, failuresOf, MODULE_FAILURE_ROW } from "../reporters/budget-reporter.ts";
import { fullRunModuleCount } from "../helpers/budget-config.ts";

import {
  judgeRuntimeBudget,
  judgePopulationDrift,
  judgeRunCosts,
  deriveRollingBaseline,
  measureBudgetFloor,
  BUDGET_POPULATION_ARM,
  baselineLine,
  baselineNote,
  provenanceLine,
  ambientInflationFraction,
  COLLECT_TAIL_SHARE_MAX,
  MIN_COVERAGE_FRACTION,
  type DeclaredCpuBudget,
  type RollingCpuBudget,
} from "../helpers/budget-verdict.ts";
import { appendJudgedRun, HISTORY_KEPT, readRunHistory } from "../helpers/budget-history.ts";
import { currentQualificationOutcome, finalizeQualifiedRun, runForInvocation } from "../../engine/src/shared/run-history.ts";
import type { RunQualificationTerminal } from "../../engine/src/shared/budget-verdict.ts";
import { readTrackedTreeDirty } from "../../engine/src/shared/tree-identity.ts";
import { readRunCpu } from "../../engine/src/shared/run-cpu.ts";
import { measureWebBudget } from "../../scripts/testing/measure-web-budget.ts";
import { engineConfigDocumentPath } from "../../engine/src/kernel/config.ts";
import { atomicWriteFile } from "../../engine/src/filesystem/atomic-write.ts";
import { resetServerConfig } from "../../server/kernel/config.ts";
import { procfsDocument } from "../../engine/src/process/process-facts.ts";
import { waitForInstrumentLock } from "../../engine/src/process/instrument-lock.ts";
import { DEFAULT_VITEST_MODULE_CACHE_DIR, moduleCacheDirOf } from "../helpers/budget-paths.ts";

const FULL = 417;
const OPTS = { fullRunModuleCount: FULL };

/** A well-formed summary of a full, cheap, WARM run: the cache existed at
 *  start, grew by a handful of entries, and almost nothing was written. */
function goodSummary(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    wallClockMs: 28_240,
    timestamp: "2026-07-27T11:28:41.813Z",
    testModuleCount: FULL,
    slowestCollects: [
      { file: "tests/prevention/a.test.ts", ms: 420 },
      { file: "tests/prevention/b.test.ts", ms: 260 },
    ],
    slowestFiles: [
      { file: "tests/prevention/heavy.test.ts", ms: 9_400 },
      { file: "tests/prevention/a.test.ts", ms: 5_100 },
    ],
    totalOccupancyMs: 300_000,
    load1PerCpuAtStart: 0.01,
    cpuCount: 12,
    runCpuMs: 330_000,
    moduleCacheEntriesAtStart: 4_180,
    moduleCacheEntriesAtEnd: 4_211,
    moduleCacheEntriesWrittenDuringRun: 31,
    // The count's WITNESS, from the same walk: 31 entries were written, so
    // the newest observed mtime sits after the run's start. A zero-count
    // fixture must override the witness to sit BEFORE the start, or it is
    // the contradiction the verdict refuses.
    moduleCacheNewestEntryMtimeMs: 1_000_500,
    runStartedAtMs: 1_000_000,
    ...over,
  };
}

/** A summary whose cache state is entirely invisible — no readings at all.
 *  The verdict judges it (a reporter that cannot see the cache says nothing
 *  about coldness), which is asserted where it is used. */
function cacheInvisible(over: Record<string, unknown> = {}): Record<string, unknown> {
  return goodSummary({
    moduleCacheEntriesAtStart: null,
    moduleCacheEntriesAtEnd: null,
    moduleCacheEntriesWrittenDuringRun: null,
    ...over,
  });
}


/**
 * THE ONE REPOSITORY every reporter drive in this file records its tree
 * against (`ReporterHarness.repositoryRoot`): a one-file fixture made once,
 * so each drive's tree-identity reads hash a tiny tree instead of the whole
 * checkout (the reads that made five tests need 120 s ceilings).
 */
let reporterTree: string | undefined;
beforeAll(() => {
  // Made at the file's start, so it lives for the whole file (a temp folder
  // made inside a test is removed when that test finishes).
  const repository = createTempGitRepo("reporter-tree-");
  writeFileSync(join(repository.dir, "measured.txt"), "the tree a reporter fixture records\n");
  repository.git("add", "measured.txt");
  repository.git("commit", "-q", "-m", "fixture");
  reporterTree = repository.dir;
});
function reporterRepository(): string {
  if (reporterTree === undefined) throw new Error("the reporter fixture repository is made in beforeAll");
  return reporterTree;
}

/**
 * A lock file THIS test process holds, through the one instrument lock's own
 * door (engine/src/process/instrument-lock.ts): the reporter reads "held" from
 * its live holder — a drive never states its stamp.
 */
/** A profile report no drive has: a run that reads it FAILS its `performance-report` gate (an unmeasured budget is never a pass, design M-A). */
const ABSENT_PROFILE_REPORT = join(import.meta.dirname, "no-such-profile-report.json");

/**
 * A judgeable profile report OF THE REPORTER FIXTURE'S OWN CODE, every budget
 * within its configured limit: the drives that must be ACCEPTED judge the
 * performance budgets too, and none of them fails (an absent report would).
 */
function passingProfileReport(): string {
  const path = join(createTempDir("reporter-profile-report-"), "report.json");
  writeFileSync(path, JSON.stringify(plantedReport({
    treeIdentity: { headSha: "0".repeat(40), dirty: false, measuredSurfaceHash: readMeasuredSurfaceHash(reporterRepository()) },
    networkSummary: { totalCalls: 5, maxResponseMs: 100 },
    routeProfiles: [{ ok: true, responseMs: 90 }, { ok: true, responseMs: 100 }],
    routeSummary: { slowest: { responseMs: 100 } },
  })));
  return path;
}
let heldLock: string | undefined;
beforeAll(async () => {
  // Made at the file's start, like the fixture repository: a temp folder made
  // inside a test is removed when that test finishes, and the lock with it.
  heldLock = join(createTempDir("reporter-instrument-lock-"), "instrument.lock");
  await waitForInstrumentLock(heldLock, "reporter fixture drives", { onWait: () => undefined, pollIntervalMs: 50 });
});
function heldInstrumentLock(): string {
  if (heldLock === undefined) throw new Error("the held instrument lock is taken in beforeAll");
  return heldLock;
}

describe("a summary that IS evidence is judged", () => {
  test("a full, cheap run measures", () => {
    const v = judgeRuntimeBudget(goodSummary(), OPTS);
    expect(v.kind).toBe("measured");
    if (v.kind !== "measured") return;
    expect(v.wallClockMs).toBe(28_240);
    expect(v.runCpuMs).toBe(330_000);
    expect(v.testModuleCount).toBe(FULL);
    expect(v.load1PerCpuAtStart).toBe(0.01);
    expect(v.summaryTimestamp).toBe("2026-07-27T11:28:41.813Z");
  });

  test("the judged figure is CPU divided by the population, not a wall clock", () => {
    // The whole repair in one assertion: what comes out is the run's WORK per
    // test file. A wall clock reaching this number would mean the gate had
    // quietly gone back to judging duration.
    const v = judgeRuntimeBudget(goodSummary({ runCpuMs: 417_000 }), OPTS);
    expect(v.kind).toBe("measured");
    if (v.kind !== "measured") return;
    expect(v.cpuMsPerTestFile).toBe(1_000);
    expect(v.cpuMsPerTestFile).not.toBe(v.wallClockMs);
  });

  test("A BUSY MACHINE DOES NOT MOVE THE JUDGED FIGURE — the wall clock alone moves", () => {
    // The measurement this design rests on, as a fixture: one unchanged tree,
    // idle versus eight CPU burners on twelve cores. Wall clock +73%, pool
    // occupancy +71%, CPU +2.6%. If someone ever re-points the verdict at
    // wallClockMs or at totalOccupancyMs, this is the test that reds.
    const idle = judgeRuntimeBudget(
      goodSummary({ wallClockMs: 35_304, totalOccupancyMs: 325_892, runCpuMs: 377_316 }),
      OPTS,
    );
    const contended = judgeRuntimeBudget(
      goodSummary({ wallClockMs: 61_144, totalOccupancyMs: 562_633, runCpuMs: 387_186 }),
      OPTS,
    );
    expect(idle.kind).toBe("measured");
    expect(contended.kind).toBe("measured");
    if (idle.kind !== "measured" || contended.kind !== "measured") return;

    if (contended.totalOccupancyMs === null || idle.totalOccupancyMs === null) throw new Error("both readings recorded a pool total");
    const wallGrowth = contended.wallClockMs / idle.wallClockMs - 1;
    const occupancyGrowth = contended.totalOccupancyMs / idle.totalOccupancyMs - 1;
    const judgedGrowth = contended.cpuMsPerTestFile / idle.cpuMsPerTestFile - 1;
    expect(wallGrowth).toBeGreaterThan(0.7);
    expect(occupancyGrowth).toBeGreaterThan(0.7);
    // An order of magnitude less sensitive to the machine than either of the
    // two quantities a previous version of this gate reached for.
    expect(judgedGrowth).toBeLessThan(0.05);
  });

  test("a full but EXPENSIVE run still measures — cost is a failure, not a refusal", () => {
    // The distinction the whole design turns on: refusing must never be a way
    // for an expensive suite to avoid a red test.
    const v = judgeRuntimeBudget(goodSummary({ runCpuMs: 9_900_000 }), OPTS);
    expect(v.kind).toBe("measured");
    if (v.kind !== "measured") return;
    expect(v.cpuMsPerTestFile).toBeGreaterThan(20_000);
  });

  test("a heavy ambient load does NOT excuse an expensive run", () => {
    // Load is recorded for provenance and must never become an escape hatch —
    // especially now that it is measured not to predict anything.
    const v = judgeRuntimeBudget(
      goodSummary({ runCpuMs: 9_900_000, load1PerCpuAtStart: 4.2 }),
      OPTS,
    );
    expect(v.kind).toBe("measured");
  });

  test("one file short of the full count is still a full run", () => {
    // A skipped file must not read as a subset run.
    const v = judgeRuntimeBudget(goodSummary({ testModuleCount: FULL - 1 }), OPTS);
    expect(v.kind).toBe("measured");
  });

  test("collect costs come back sorted worst-first, whatever order they were written", () => {
    const v = judgeRuntimeBudget(
      goodSummary({
        slowestCollects: [
          { file: "small.test.ts", ms: 10 },
          { file: "huge.test.ts", ms: 15_410 },
          { file: "mid.test.ts", ms: 900 },
        ],
      }),
      OPTS,
    );
    expect(v.kind).toBe("measured");
    if (v.kind !== "measured") return;
    expect(v.slowestCollects.map((c) => c.file)).toEqual([
      "huge.test.ts",
      "mid.test.ts",
      "small.test.ts",
    ]);
    // THE REAL DEFECT'S NUMBERS, AGAINST THE REAL GATE — as a share now, so
    // the assertion says what the gate says. 15.41s of collect inside the
    // 41.5s run it produced is 0.371, which must exceed the cap by a margin
    // no busy machine can manufacture.
    expect(v.worstCollectShare).toBeGreaterThan(COLLECT_TAIL_SHARE_MAX);
    expect(v.worstCollectShare).toBeCloseTo(15_410 / v.wallClockMs, 6);
  });

  test("a SHARE and a stopwatch disagree, and the share is the one that is right", () => {
    // WITHOUT THIS FIXTURE THE CHANGE WOULD BE INERT, and saying that is the
    // point: on today's tree every reading falls the same side of both rules,
    // so a mutation swapping the share back for `worst.ms` would change no
    // answer at all. Two cases separate them, and both are real:
    //
    //   A. a SHORT run with a moderate tail — 2.5s of collect inside a 10s
    //      run is a quarter of the whole run spent where the scheduler cannot
    //      see it, and the 3,000 ms stopwatch called that healthy;
    //   B. a LONG run with a large tail — 4.0s inside a 120s run is 3.3%,
    //      ordinary, and the stopwatch called it a failure.
    //
    // B is the one that cost four steps a red, wearing a cold cache.
    const shortRun = judgeRuntimeBudget(
      goodSummary({ wallClockMs: 10_000, slowestCollects: [{ file: "tail.test.ts", ms: 2_500 }] }),
      OPTS,
    );
    expect(shortRun.kind).toBe("measured");
    if (shortRun.kind !== "measured") return;
    expect(shortRun.slowestCollects[0]!.ms).toBeLessThan(3_000); // the old rule: fine
    expect(shortRun.worstCollectShare).toBeGreaterThan(COLLECT_TAIL_SHARE_MAX); // the new rule: not

    const longRun = judgeRuntimeBudget(
      goodSummary({ wallClockMs: 120_000, slowestCollects: [{ file: "tail.test.ts", ms: 4_000 }] }),
      OPTS,
    );
    expect(longRun.kind).toBe("measured");
    if (longRun.kind !== "measured") return;
    expect(longRun.slowestCollects[0]!.ms).toBeGreaterThan(3_000); // the old rule: red
    expect(longRun.worstCollectShare).toBeLessThan(COLLECT_TAIL_SHARE_MAX); // the new rule: fine
  });

  test("a run that WROTE its module cache is NOT judged, and a warm one still is", () => {
    // THE TRIGGER, NAMED. `npx vitest --clearCache` is required after any
    // cross-repository edit, and the run that follows it transforms
    // everything from scratch — measured at ~2.7× the warm collect share.
    // Judging it reddened four consecutive steps for doing the required thing.
    //
    // TWO SPELLINGS OF THIS ARM HAVE ALREADY DIED, and both corpses are kept
    // as plants below. `start === 0` could never fire (onInit runs after the
    // config graph is transformed, so a truly absent cache still records 4).
    // Its replacement, the COUNT DELTA, could not see a write that does not
    // change the count. The question is now the mtime count: how many cache
    // files were WRITTEN at or after the run's own start.
    const cold = judgeRuntimeBudget(
      goodSummary({
        moduleCacheEntriesAtStart: 4,
        moduleCacheEntriesAtEnd: 4_211,
        moduleCacheEntriesWrittenDuringRun: 4_207,
      }),
      OPTS,
    );
    expect(cold.kind).toBe("unmeasurable");
    if (cold.kind !== "unmeasurable") return;
    expect(cold.why).toContain("WROTE");
    expect(cold.why).toContain("mtime");

    // THE ZERO-KEY PLANT: a start of 4 is what a real cold run records, so
    // nothing may key on zero again — judged by its writes this run is COLD.
    expect(
      judgeRuntimeBudget(
        goodSummary({
          moduleCacheEntriesAtStart: 4,
          moduleCacheEntriesAtEnd: 4_211,
          moduleCacheEntriesWrittenDuringRun: 4_207,
        }),
        OPTS,
      ).kind,
      "a start reading of 4 must not read as 'not zero, therefore warm'",
    ).toBe("unmeasurable");

    // THE BENIGN DIRECTION, which is what makes the arm a refusal and not a
    // hole: a warm run — one that re-transformed a handful of changed files —
    // is still judged, and a cache the reporter could not see at all is
    // judged too, because a reporter that cannot see the cache says nothing
    // about coldness either way.
    expect(
      judgeRuntimeBudget(
        goodSummary({
          moduleCacheEntriesAtStart: 4_150,
          moduleCacheEntriesAtEnd: 4_211,
          moduleCacheEntriesWrittenDuringRun: 61,
        }),
        OPTS,
      ).kind,
    ).toBe("measured");
    expect(judgeRuntimeBudget(cacheInvisible(), OPTS).kind).toBe("measured");

    // LIVENESS ON THE END READING. If it were ever taken at `onInit` as well,
    // start and end would agree and every run would look warm — this arm dying
    // silently a second time, exactly as it died the first. A finished run has
    // transformed at least one module per test file, so a smaller end reading
    // is a broken instrument rather than a warm cache.
    const early = judgeRuntimeBudget(
      goodSummary({
        moduleCacheEntriesAtStart: 4,
        moduleCacheEntriesAtEnd: 4,
        moduleCacheEntriesWrittenDuringRun: 0,
      }),
      OPTS,
    );
    expect(early.kind).toBe("unmeasurable");
    if (early.kind !== "unmeasurable") return;
    expect(early.why).toContain("taken before the run did its work");
  });

  test("THE COUNT-DELTA CORPSE — a cache REPLACED IN PLACE is refused, count notwithstanding", () => {
    // THE LIVE PAIR, VERBATIM. A regression hunt on this tree recorded
    // `1489 → 1489 entries` and the old count-delta arm read it as warm —
    // while the instrument could not have told an untouched cache from one
    // whose every entry was rewritten during the run, because a replacement
    // writes the same filename. This fixture is that exact shape: the count
    // did not move, the mtimes say the cache was rebuilt. A mutation
    // restoring the count-delta judgment turns this fixture green-to-judged
    // and dies here.
    const inPlace = judgeRuntimeBudget(
      goodSummary({
        moduleCacheEntriesAtStart: 1_489,
        moduleCacheEntriesAtEnd: 1_489,
        moduleCacheEntriesWrittenDuringRun: 1_489,
      }),
      OPTS,
    );
    expect(inPlace.kind).toBe("unmeasurable");
    if (inPlace.kind !== "unmeasurable") return;
    expect(inPlace.why).toContain("REPLACED IN PLACE");

    // A PARTIAL replacement past the threshold refuses too…
    expect(
      judgeRuntimeBudget(
        goodSummary({
          moduleCacheEntriesAtStart: 1_489,
          moduleCacheEntriesAtEnd: 1_489,
          moduleCacheEntriesWrittenDuringRun: 800,
        }),
        OPTS,
      ).kind,
    ).toBe("unmeasurable");
    // …and a genuinely warm run with a still count is judged: the fields
    // separate, so the refusal is about the writes and not about the pair.
    // A genuine zero carries a witness that AGREES with it — the newest
    // entry mtime sits before the run started.
    expect(
      judgeRuntimeBudget(
        goodSummary({
          moduleCacheEntriesAtStart: 1_489,
          moduleCacheEntriesAtEnd: 1_489,
          moduleCacheEntriesWrittenDuringRun: 0,
          moduleCacheNewestEntryMtimeMs: 999_000,
        }),
        OPTS,
      ).kind,
    ).toBe("measured");
  });

  test("DENY BY DEFAULT — a populated cache with no mtime reading cannot be judged warm", () => {
    // The INERT-shape guard: a reporter that computes the write count and
    // drops it (or predates it) must not be able to produce a judged pass.
    // If absence were warmth, deleting one line of the reporter would
    // silently disarm the cold arm forever.
    const v = judgeRuntimeBudget(
      goodSummary({ moduleCacheEntriesWrittenDuringRun: null }),
      OPTS,
    );
    expect(v.kind).toBe("unmeasurable");
    if (v.kind !== "unmeasurable") return;
    expect(v.why).toContain("moduleCacheEntriesWrittenDuringRun");
  });

  test("the cache directory the reporter watches is the one vitest fills", () => {
    // A WRONG PATH WOULD REPORT EVERY RUN AS COLD and make the gate silently
    // unmeasurable — the permissive direction, arriving from a rename in a
    // dependency. This test runs INSIDE a run, so the directory has been
    // populated by the very run executing it; an empty or absent one here
    // means the constant no longer names vitest's cache.
    //
    // It asserts the DEFAULT, which is what a run that says nothing uses. The
    // case where a run DOES say otherwise is the test below, and it is the one
    // that was missing.
    expect(
      existsSync(DEFAULT_VITEST_MODULE_CACHE_DIR),
      `${DEFAULT_VITEST_MODULE_CACHE_DIR} does not exist`,
    ).toBe(true);
    expect(readdirSync(DEFAULT_VITEST_MODULE_CACHE_DIR).length).toBeGreaterThan(0);
  });

  test("THE COLD ARM'S HOLE — a redirected cache must be the cache that is counted", () => {
    // THE DEFECT, AS ITS OWN FIXTURE. The reporter counted entries in a
    // hardcoded default path. `--experimental.fsModuleCachePath=<dir>` sends
    // vitest's module cache somewhere else, and that flag is not exotic: it is
    // how a run avoids a cache that a sibling-repository edit has made stale,
    // and it is the flag two consecutive agents were using while measuring
    // this very gate.
    //
    // DRIVEN on this tree: with the flag pointed at a fresh directory, that
    // directory was created and populated while
    // `node_modules/.experimental-vitest-cache` stayed at 1,884 entries. So
    // start and end agreed, `builtDuringRun` came out 0.0, and a run that
    // built its ENTIRE cache was recorded as WARM and judged against the warm
    // cap. Measured consequence on the full suite (466 modules, unit: ms of
    // vitest's collectDuration): worst collect 1,536/1,543/1,545 ms warm
    // against 4,553 ms cold — 0.038 of wall clock against 0.103, a 0.08 cap.
    expect(moduleCacheDirOf({ fsModuleCachePath: "/tmp/elsewhere" })).toBe("/tmp/elsewhere");
    // A RELATIVE PATH IS STILL A PATH, and vitest resolves it against the root.
    expect(moduleCacheDirOf({ fsModuleCachePath: "cache/here" })).toBe(
      `${process.cwd()}/cache/here`,
    );
    // …and everything that is NOT a directory name falls back to the default,
    // rather than to something that would resolve to the repository root and
    // count source files as cache entries.
    for (const notAPath of [undefined, null, "", "   ", 7, {}, [], true]) {
      expect(moduleCacheDirOf({ fsModuleCachePath: notAPath })).toBe(
        DEFAULT_VITEST_MODULE_CACHE_DIR,
      );
    }
    expect(moduleCacheDirOf(undefined)).toBe(DEFAULT_VITEST_MODULE_CACHE_DIR);
    expect(moduleCacheDirOf({})).toBe(DEFAULT_VITEST_MODULE_CACHE_DIR);
  });

  test("ABSENCE IS NOT WARMTH — an unreadable start beside a populated end refuses", () => {
    // The other half of the same hole. Once the reporter reads the directory
    // the run actually uses, a fresh redirected path does not exist when
    // `onInit` looks at it, so the start reading is `null`. Treating that as
    // "cache state unknown, carry on" would judge the coldest run there is.
    const v = judgeRuntimeBudget(
      goodSummary({ moduleCacheEntriesAtStart: null, moduleCacheEntriesAtEnd: 4_211 }),
      OPTS,
    );
    expect(v.kind).toBe("unmeasurable");
    if (v.kind !== "unmeasurable") return;
    expect(v.why).toContain("could not be read when the run STARTED");
    // And the genuinely unknown case — no cache reading at all — is still
    // judged, because a reporter that cannot see the cache at all says
    // nothing about whether the run was cold.
    expect(judgeRuntimeBudget(cacheInvisible(), OPTS).kind).toBe("measured");
  });
});

describe("the run's own costs are judged, and a refusal is not a pass", () => {
  const BUDGET: RollingCpuBudget = {
    baselineFloorMsPerTestFile: 1_000,
    derivedAtTestFileCount: FULL,
    maxPopulationDriftFraction: 0.03,
    // The baseline DERIVES from the ledger (never below the floor), and
    // these fixtures keep their readings unstamped or at or under the floor
    // so the floor holds the baseline at 1,000 exactly: the cap in force is
    // 1,000 at no ambient. The spread only decides which ledger readings
    // feed the baseline; it never widens a verdict.
    sameTreeSpreadFraction: 0.047,
    baselineWindowRuns: 12,
    // The deployed ambient envelope's proportions: +5% per unit of recorded
    // 5-minute ambient load per CPU, capped at 12%. At amb5 0.8 the
    // adjustment is +4% — the cap 1,040.
    ambientInflationSlopePerCpu: 0.05,
    ambientInflationCapFraction: 0.12,
  };
  const IDENTITIES = ["tests/prevention/web-ui-runtime-budget.test.ts::"];
  const INPUTS = {
    cpuBudget: BUDGET,
    fileShareMax: 0.05,
    priorRuns: [] as const,
    suiteLabel: "web-UI",
    budgetFailureIdentities: IDENTITIES,
  };
  const gate = (out: readonly { gate: string; kind: string }[], name: string): string =>
    out.find((o) => o.gate === name)?.kind ?? "<absent>";
  /** A prior JUDGED run at the given per-file cost. */
  const ranAt = (cpuMsPerTestFile: number, when = "2026-07-30T10:00:00.000Z") => ({
    timestamp: when,
    cpuMsPerTestFile,
    testModuleCount: FULL,
  });
  /** A summary whose judged figure lands at exactly `msPerFile`. */
  const summaryAt = (msPerFile: number) => goodSummary({ runCpuMs: msPerFile * FULL });

  test("a healthy run passes all three", () => {
    const out = judgeRunCosts(judgeRuntimeBudget(goodSummary(), OPTS), INPUTS);
    expect(out.map((o) => o.kind)).toEqual(["pass", "pass", "pass"]);
  });

  test("THE DEFECT THIS EXISTS FOR — a 15.41s collect tail inside a 41.5s run FAILS", () => {
    // `no-unused-exports.test.ts`, verbatim: 14ms of tests and 15.41s of
    // import, sorted to the end of the run by a number that excluded its own
    // cost. A share of 0.371 against a 0.08 cap.
    const out = judgeRunCosts(
      judgeRuntimeBudget(
        goodSummary({
          wallClockMs: 41_500,
          slowestCollects: [{ file: "tests/prevention/no-unused-exports.test.ts", ms: 15_410 }],
        }),
        OPTS,
      ),
      INPUTS,
    );
    expect(gate(out, "collect-tail-share")).toBe("fail");
    const failure = out.find((o) => o.gate === "collect-tail-share")!;
    expect(failure.message).toContain("no-unused-exports");
    expect(failure.message).toContain("invisible to the scheduler");
    // AND IT NAMES THIS RUN, NOT THE ONE BEFORE. The lag was the defect; a
    // message that still says "the PREVIOUS run" would mean the judgement had
    // drifted back into the suite.
    expect(failure.message).toContain("this run's");
    expect(failure.message).not.toContain("PREVIOUS");
  });

  test("ONE JUDGED RUN OVER THE CAP FAILS — no band, no streak, no re-run (UR-24-BUDGETS, the 2026-10-07 decision)", () => {
    // The old gate recorded this "one-off spike" as a warn and waited for
    // three consecutive runs beyond a same-tree spread band. Both are
    // deleted: a run over the cap in force fails that run, whatever its
    // neighbours read, and the reading is in the message.
    const spike = 1_001; // 1 ms/file over the cap, at no ambient
    const out = judgeRunCosts(judgeRuntimeBudget(summaryAt(spike), OPTS), {
      ...INPUTS,
      priorRuns: [ranAt(900), ranAt(910)], // green neighbours forgive nothing
    });
    const cpu = out.find((o) => o.gate === "cpu-per-test-file")!;
    expect(cpu.kind).toBe("fail");
    expect(cpu.message).toContain("no streak, no band, no re-run");
    expect(cpu.message).toContain("do not raise the budget");
    expect(cpu.message).toContain(spike.toFixed(1));
    expect(cpu.message).toContain("cap in force");
    // +50% fails the same way; the cap itself passes.
    expect(gate(judgeRunCosts(judgeRuntimeBudget(summaryAt(1_500), OPTS), INPUTS), "cpu-per-test-file")).toBe("fail");
    expect(gate(judgeRunCosts(judgeRuntimeBudget(summaryAt(1_000), OPTS), INPUTS), "cpu-per-test-file")).toBe("pass");
    // No CPU outcome is ever a warn any more: pass or fail.
    for (const ms of [950, 1_000, 1_001, 1_046, 1_048, 1_060, 2_000]) {
      expect(["pass", "fail"]).toContain(gate(judgeRunCosts(judgeRuntimeBudget(summaryAt(ms), OPTS), INPUTS), "cpu-per-test-file"));
    }
  });

  test("THE LEDGER NEVER CHANGES A VERDICT — the same over-cap reading fails after an empty, green, red or 60-row history, and the same healthy one passes after reds", () => {
    const verdict = (ms: number, priorRuns: readonly ReturnType<typeof ranAt>[]) =>
      gate(judgeRunCosts(judgeRuntimeBudget(summaryAt(ms), OPTS), { ...INPUTS, priorRuns }), "cpu-per-test-file");
    expect(verdict(1_060, [])).toBe("fail");
    expect(verdict(1_060, [ranAt(900), ranAt(905)])).toBe("fail");
    expect(verdict(1_060, [ranAt(1_055), ranAt(1_070)])).toBe("fail");
    expect(verdict(1_060, [ranAt(1_090), ranAt(1_090), ranAt(900), ranAt(1_055)])).toBe("fail");
    expect(verdict(1_060, [
      ...Array.from({ length: 57 }, (_, i) => ranAt(880 + (i % 7), `2026-07-01T0${String(i % 10)}:00:00.000Z`)),
      ranAt(905), ranAt(1_055), ranAt(1_070),
    ])).toBe("fail");
    // A deviant-population entry is never a reason either way.
    expect(verdict(1_060, [{ ...ranAt(1_338), testModuleCount: 30 }])).toBe("fail");
    // Earlier reds never turn a run under the cap red.
    expect(verdict(950, [ranAt(1_090), ranAt(1_090), ranAt(1_090)])).toBe("pass");
  });

  // ── AMBIENT LOAD: THE ONE ALLOWANCE LEFT, STATED ON EVERY VERDICT ────────
  //
  // Sustained ambient load inflates the CPU figure (the ledger's own
  // busy-vs-quiet pairs: +2.0% to +5.5% at amb5 0.557-1.263), and the declared
  // envelope scales the cap by exactly that much, capped, until
  // AMBIENT-ALLOWANCE-REMOVE removes it. The arms below hold both
  // directions — clean at busy ambient judges CLEAN, regressed at busy
  // ambient FAILS in its one run — plus the ghost bound (the 1-minute leg
  // adjusts nothing) and the cap (no ambient empties the teeth).
  /** A summary recorded at the given 5-minute ambient load per CPU. */
  const atAmb5 = (amb5: number, msPerFile: number) =>
    goodSummary({ load5PerCpuAtStart: amb5, load1PerCpuAtStart: amb5, runCpuMs: msPerFile * FULL });

  test("A CLEAN RUN AT A BUSY AMBIENT JUDGES CLEAN — the adjustment does its work, with the arithmetic on the gate line", () => {
    // At amb5 0.8 the adjustment is +4%: the cap is 1,040. A busy reading
    // of 1,030 lands within it — a PASS, with the arithmetic named.
    const busy = judgeRunCosts(judgeRuntimeBudget(atAmb5(0.8, 1_030), OPTS), INPUTS);
    const cpu = busy.find((o) => o.gate === "cpu-per-test-file")!;
    expect(cpu.kind).toBe("pass");
    expect(cpu.message).toContain("1030.0 ms/file within 1040.0");
    expect(cpu.message).toContain("baseline 1000.0 × 1.040 ambient adjustment");
    expect(cpu.message).toContain("0.800/cpu");
    expect(cpu.message).toContain("rolling baseline 1000.0");
    expect(cpu.message).toContain("ambient adjustment this run earned");
    // The counterfactual in the same arm: the IDENTICAL reading at a quiet
    // ambient FAILS — the adjustment moved the line, and it is stated.
    const quiet = judgeRunCosts(judgeRuntimeBudget(atAmb5(0.05, 1_030), OPTS), INPUTS);
    const quietCpu = quiet.find((o) => o.gate === "cpu-per-test-file")!;
    expect(quietCpu.kind).toBe("fail");
    expect(quietCpu.message).toContain("ambient allowance in force until AMBIENT-ALLOWANCE-REMOVE");
  });

  test("THE TEETH HOLD UNDER LOAD — one regressed reading at a busy ambient FAILS, whatever the ledger behind it", () => {
    // At amb5 0.8 the cap is 1,040: a 1,050 reading fails in its one run,
    // with green busy neighbours or none.
    const busyAmbient = (cpu: number, when: string) => ({ ...ranAt(cpu, when), ambientLoad5PerCpu: 0.8 });
    for (const priorRuns of [[], [busyAmbient(1_000, "2026-07-30T10:10:00.000Z"), busyAmbient(1_010, "2026-07-30T10:20:00.000Z")]]) {
      const out = judgeRunCosts(judgeRuntimeBudget(atAmb5(0.8, 1_050), OPTS), { ...INPUTS, priorRuns });
      const cpu = out.find((o) => o.gate === "cpu-per-test-file")!;
      expect(cpu.kind).toBe("fail");
      expect(cpu.message).toContain("do not raise the budget");
      expect(cpu.message).toContain("cap in force = baseline 1000.0 × 1.040 ambient adjustment");
      expect(cpu.message).toContain("1050.0");
    }
  });

  test("THE CAP — no ambient empties the teeth: beyond-envelope saturation still fails, never defers", () => {
    // At amb5 3.0 the raw adjustment (3.0 × 0.05 = 15%) is capped at 12%:
    // the cap is 1,120. 1,121 fails; 1,120 passes.
    expect(ambientInflationFraction(3.0, BUDGET)).toBe(0.12);
    const saturated = judgeRunCosts(judgeRuntimeBudget(atAmb5(3.0, 1_121), OPTS), INPUTS);
    const cpu = saturated.find((o) => o.gate === "cpu-per-test-file")!;
    expect(cpu.kind).toBe("fail");
    expect(cpu.message).toContain("1120.0");
    expect(gate(judgeRunCosts(judgeRuntimeBudget(atAmb5(3.0, 1_120), OPTS), INPUTS), "cpu-per-test-file")).toBe("pass");
    // And the helper's own bounds: absence, garbage and non-positive
    // readings adjust nothing — a missing covariate must never loosen a
    // line (deny-by-default).
    expect(ambientInflationFraction(undefined, BUDGET)).toBe(0);
    expect(ambientInflationFraction(null, BUDGET)).toBe(0);
    expect(ambientInflationFraction(Number.NaN, BUDGET)).toBe(0);
    expect(ambientInflationFraction(-1, BUDGET)).toBe(0);
  });

  test("THE GHOST BOUND — the 1-minute leg adjusts nothing, whatever it reads", () => {
    // The recorded 1-minute ambient is the decaying echo of the minute
    // BEFORE launch: a prior suite leaves it at 0.8-1.9/cpu on an otherwise
    // idle box. Two summaries identical in every recorded figure except the
    // 1-minute leg (1.6/cpu ghost vs 0.2/cpu honest) produce the IDENTICAL
    // verdict and the same cap — the ghost buys no allowance.
    const ghost = judgeRunCosts(
      judgeRuntimeBudget(goodSummary({ load1PerCpuAtStart: 1.6, load5PerCpuAtStart: 0.15, runCpuMs: 1_060 * FULL }), OPTS),
      INPUTS,
    );
    const twin = judgeRunCosts(
      judgeRuntimeBudget(goodSummary({ load1PerCpuAtStart: 0.2, load5PerCpuAtStart: 0.15, runCpuMs: 1_060 * FULL }), OPTS),
      INPUTS,
    );
    const cpu = ghost.find((o) => o.gate === "cpu-per-test-file")!;
    const cpuTwin = twin.find((o) => o.gate === "cpu-per-test-file")!;
    expect(cpu.kind).toBe(cpuTwin.kind);
    const cap = (1_000 * (1 + ambientInflationFraction(0.15, BUDGET))).toFixed(1);
    expect(cpu.message).toContain(`over the ${cap} ms/file cap in force`);
    expect(cpuTwin.message).toContain(`over the ${cap} ms/file cap in force`);
    expect(cpu.message).toContain("× 1.008 ambient adjustment");
    expect(cpuTwin.message).toContain("× 1.008 ambient adjustment");
    expect(cpu.message).not.toContain("× 1.016");
    expect(cpu.kind).toBe("fail");
    // ABSENCE IS NOT AN ESCAPE HATCH either: no 5-minute leg judges against
    // the unadjusted cap.
    const s = goodSummary({ runCpuMs: 1_060 * FULL });
    delete s.load5PerCpuAtStart;
    const noLeg = judgeRunCosts(judgeRuntimeBudget(s, OPTS), INPUTS);
    expect(noLeg.find((o) => o.gate === "cpu-per-test-file")!.kind).toBe("fail");
  });

  test("THE 23.9s-of-330s FILE — one file eating 7.2% of the pool FAILS", () => {
    const out = judgeRunCosts(
      judgeRuntimeBudget(
        goodSummary({
          slowestFiles: [{ file: "tests/prevention/async-db-ordering.test.ts", ms: 23_900 }],
          totalOccupancyMs: 330_000,
        }),
        OPTS,
      ),
      INPUTS,
    );
    expect(gate(out, "per-file-pool-share")).toBe("fail");
  });

  test("A REFUSAL IS NOT A PASS — an unmeasurable run reports three NOT-JUDGED", () => {
    // The colour that used to be identical to green. Every gate must say it
    // could not judge, and say why, or "within budget" and "no evidence" are
    // the same result again.
    const out = judgeRunCosts(judgeRuntimeBudget(null, OPTS), INPUTS);
    expect(out.map((o) => o.kind)).toEqual(["not-judged", "not-judged", "not-judged"]);
    for (const o of out) expect(o.message.length).toBeGreaterThan(10);
  });

  test("MISSING CONFIGURATION DOES NOT SILENTLY PASS a gate either", () => {
    const out = judgeRunCosts(judgeRuntimeBudget(goodSummary(), OPTS), {
      cpuBudget: { missing: "nobody set webUiSuiteCpuBudget" },
      fileShareMax: { missing: "nobody set webUiTestFileCostShareMax" },
      priorRuns: [],
      suiteLabel: "web-UI",
      budgetFailureIdentities: IDENTITIES,
    });
    expect(gate(out, "cpu-per-test-file")).toBe("not-judged");
    expect(gate(out, "per-file-pool-share")).toBe("not-judged");
    // …and the gate that needs no configuration still judges.
    expect(gate(out, "collect-tail-share")).toBe("pass");
  });

  test("a zero pool total is refused rather than divided by", () => {
    const s = goodSummary();
    delete s.totalOccupancyMs;
    const out = judgeRunCosts(judgeRuntimeBudget(s, OPTS), INPUTS);
    expect(gate(out, "per-file-pool-share")).toBe("not-judged");
  });
});

describe("the measuring tool's arithmetic (D-17): the floor from the ledger's own clean runs of the current population", () => {
  const IDENTITIES = ["tests/prevention/web-ui-runtime-budget.test.ts::"];
  const declared: RollingCpuBudget = {
    baselineFloorMsPerTestFile: 1_000,
    derivedAtTestFileCount: 400,
    maxPopulationDriftFraction: 0.03,
    sameTreeSpreadFraction: 0.047,
    baselineWindowRuns: 4,
    ambientInflationSlopePerCpu: 0.05,
    ambientInflationCapFraction: 0.12,
  };
  // Every row is stamped as measured inside the host's instrument lock: only such a reading feeds (D-17, design M-B).
  const row = (cpuMsPerTestFile: number, over: Record<string, unknown> = {}) => ({ timestamp: "t", cpuMsPerTestFile, testModuleCount: FULL, heavySlot: "held" as const, ...over });

  test("the median of the last window of eligible readings, ambient-adjusted, at the CURRENT population; ineligible rows and OUTLIERS never count — the same rows the rolling baseline feeds on (WF-1b3b design M5)", () => {
    const rows = [
      row(9_000),                                          // older than the window, and an outlier
      row(2_000), row(2_100),
      row(2_600),                                          // an overloaded outlier: beyond the allowance of the window's median
      row(2_200),
      row(2_300, { ambientLoad5PerCpu: 1 }),               // busy: 2300 / 1.05 = 2190.5
      row(9_999, { mutation: true }),                      // a deliberate mutation run
      row(9_999, { testModuleCount: 300 }),                // another population
      row(9_999, { failures: [`${IDENTITIES[0]!}budget`] }), // the gate's own failure
      row(1_000, { heavySlot: "unslotted" }),              // measured outside the lock
      row(1_000, { heavySlot: undefined }),                // a legacy row with no stamp
    ];
    const measured = measureBudgetFloor(declared, rows, FULL, IDENTITIES);
    expect(measured.status).toBe("measured");
    if (measured.status !== "measured") return;
    expect(measured.derivedAtTestFileCount).toBe(FULL);
    expect(measured.readings).toEqual([2_000, 2_100, 2_200, 2_300 / 1.05]);
    expect(measured.floorMsPerTestFile).toBe(Math.ceil((2_100 + 2_300 / 1.05) / 2));
    // The rolling baseline feeds on the same eligible rows, but only those whose OWN CPU outcome passed (at or under
    // the cap in force at their moment): 2,200 and 2,190.5 were over the 2,150 cap, so they feed nothing (design HIGH 1).
    expect(deriveRollingBaseline({ ...declared, baselineFloorMsPerTestFile: 2_150 }, rows, FULL, IDENTITIES).windowReadings).toEqual([2_000, 2_100]);
  });

  test("ONLY A READING TAKEN INSIDE THE LOCK FEEDS: an unslotted row and a legacy row with no stamp never reach the tool's window or the rolling baseline (D-17, design M-B)", () => {
    const unstamped = (cpu: number) => ({ timestamp: "t", cpuMsPerTestFile: cpu, testModuleCount: FULL });
    for (const outside of [
      Array.from({ length: 4 }, (_, i) => unstamped(2_000 + i)),
      Array.from({ length: 4 }, (_, i) => row(2_000 + i, { heavySlot: "unslotted" })),
    ]) {
      expect(measureBudgetFloor(declared, outside, FULL, IDENTITIES)).toMatchObject({ status: "unmeasurable", eligibleRuns: 0 });
      expect(deriveRollingBaseline({ ...declared, baselineFloorMsPerTestFile: 2_000 }, outside, FULL, IDENTITIES).windowReadings).toEqual([]);
    }
    // The same readings, stamped, feed both.
    const held = Array.from({ length: 4 }, (_, i) => row(2_000 + i));
    expect(measureBudgetFloor(declared, held, FULL, IDENTITIES)).toMatchObject({ status: "measured", readings: [2_000, 2_001, 2_002, 2_003] });
    // …and the rolling baseline feeds only the stamped run that passed its own 2,000 cap (2,001 and above failed theirs).
    expect(deriveRollingBaseline({ ...declared, baselineFloorMsPerTestFile: 2_000 }, held, FULL, IDENTITIES).windowReadings).toEqual([2_000]);
  });

  test("a run failing ONLY the gate's population arm is eligible — the failure a re-measurement clears; any other face of the gate still disqualifies its run", () => {
    const stale = `${IDENTITIES[0]!}web-UI test-runtime budget > ${BUDGET_POPULATION_ARM}`;
    // Every run of a grown suite fails the population arm until the floor is re-derived: the window fills from them.
    const grown = [row(2_000, { failures: [stale] }), row(2_050, { failures: [stale] }), row(2_100, { failures: [stale] }), row(2_150, { failures: [stale] })];
    const measured = measureBudgetFloor(declared, grown, FULL, IDENTITIES);
    expect(measured).toMatchObject({ status: "measured", readings: [2_000, 2_050, 2_100, 2_150] });
    // The arm at the top level of the file is the same arm.
    expect(measureBudgetFloor(declared, grown.map((r) => ({ ...r, failures: [`${IDENTITIES[0]!}${BUDGET_POPULATION_ARM}`] })), FULL, IDENTITIES).status).toBe("measured");
    // Another face of the gate, alone or beside the population arm, disqualifies; so does a name that merely ends like the arm.
    for (const failures of [[`${IDENTITIES[0]!}web-UI test-runtime budget > the budget's floor is a positive finite number of milliseconds per test file`], [stale, `${IDENTITIES[0]!}web-UI test-runtime budget > the per-file share cap is a real cap, not a formality`], [`${IDENTITIES[0]!}web-UI test-runtime budget > not ${BUDGET_POPULATION_ARM}`]]) {
      expect(measureBudgetFloor(declared, grown.map((r) => ({ ...r, failures })), FULL, IDENTITIES), JSON.stringify(failures)).toMatchObject({ status: "unmeasurable", eligibleRuns: 0 });
    }
    // The rolling baseline: the same eligibility rule, then only the runs that passed their own cap (2,150 failed 2,100).
    expect(deriveRollingBaseline({ ...declared, baselineFloorMsPerTestFile: 2_100 }, grown, FULL, IDENTITIES).windowReadings).toEqual([2_000, 2_050, 2_100]);
  });

  test("the TOOL (npm run budget:measure) reads the declared budget and the ledger; too few runs is unmeasurable and writes nothing", () => {
    const ledger = join(createTempDir("web-budget-measure-"), "run-history.json");
    writeFileSync(ledger, JSON.stringify({ runs: [row(2_000)] }));
    const report = measureWebBudget(false, ledger);
    expect(report.status).toBe("unmeasurable");
    expect(report.measurement.status).toBe("unmeasurable");
    expect(report.declared.floorMsPerTestFile).toBeGreaterThan(0);
  });

  test("the TOOL writes only the document it measured: a HARNESS_CONFIG_PATH elsewhere is refused before any write (WF-1b3b design LOW 12)", () => {
    const engineDocument = engineConfigDocumentPath();
    const engineBytes = readFileSync(engineDocument);
    const elsewhere = join(createTempDir("web-budget-elsewhere-"), "bridlewise.config.json");
    expect(atomicWriteFile(elsewhere, engineBytes, { createMode: 0o600 }).success).toBe(true);
    const previous = process.env["HARNESS_CONFIG_PATH"];
    process.env["HARNESS_CONFIG_PATH"] = elsewhere;
    resetServerConfig();
    try {
      const declaredWindow = 64;
      const ledger = join(createTempDir("web-budget-mismatch-"), "run-history.json");
      writeFileSync(ledger, JSON.stringify({ runs: Array.from({ length: declaredWindow }, (_, index) => ({ timestamp: `t${String(index)}`, cpuMsPerTestFile: 1_234_567, testModuleCount: fullRunModuleCount(), heavySlot: "held" })) }));
      expect(() => measureWebBudget(true, ledger)).toThrow(expect.objectContaining({ code: "web_budget_document_mismatch" }));
      expect(readFileSync(engineDocument).equals(engineBytes), "the engine's document was written").toBe(true);
    } finally {
      if (previous === undefined) delete process.env["HARNESS_CONFIG_PATH"];
      else process.env["HARNESS_CONFIG_PATH"] = previous;
      resetServerConfig();
    }
  });

  test("fewer eligible runs than the window is UNMEASURABLE, with the count: never a guess", () => {
    const measured = measureBudgetFloor(declared, [row(2_000), row(2_100)], FULL, IDENTITIES);
    expect(measured).toMatchObject({ status: "unmeasurable", eligibleRuns: 2, windowRuns: 4, derivedAtTestFileCount: FULL });
  });
});

describe("the rolling baseline — the cap derived from the ledger's own clean history", () => {
  const IDENTITIES = ["tests/prevention/web-ui-runtime-budget.test.ts::"];
  const budget = (over: Partial<RollingCpuBudget> = {}): RollingCpuBudget => ({
    baselineFloorMsPerTestFile: 1_000,
    derivedAtTestFileCount: FULL,
    maxPopulationDriftFraction: 0.03,
    sameTreeSpreadFraction: 0.047,
    baselineWindowRuns: 12,
    ambientInflationSlopePerCpu: 0.05,
    ambientInflationCapFraction: 0.12,
    ...over,
  });
  // Stamped as measured inside the host's instrument lock: only such a row feeds the baseline (design M-B).
  const ranAt = (cpuMsPerTestFile: number, over: Record<string, unknown> = {}) => ({
    timestamp: "2026-07-30T10:00:00.000Z",
    cpuMsPerTestFile,
    testModuleCount: FULL,
    heavySlot: "held" as const,
    ...over,
  });
  const summaryAt = (msPerFile: number) => goodSummary({ runCpuMs: msPerFile * FULL });
  const costs = (b: RollingCpuBudget, priorRuns: readonly ReturnType<typeof ranAt>[], ms: number) =>
    judgeRunCosts(judgeRuntimeBudget(summaryAt(ms), OPTS), {
      cpuBudget: b,
      fileShareMax: 0.05,
      priorRuns,
      suiteLabel: "web-UI",
      budgetFailureIdentities: IDENTITIES,
    });

  test("(a) THE ANTI-NORMALIZATION PROOF — a regressing run NEVER feeds the baseline, and the next regressed run fails against the unchanged one", () => {
    // A clean history at ~940-951, then the tree regresses in a step: 1,100
    // and 1,120, both over the 1,000 cap in force. Those readings must NOT
    // move the baseline — each failed its own run, so it is not clean — and the next regressed
    // reading FAILS, in its one run, against the UNCHANGED baseline: a
    // caught step cannot also move the cap that caught it.
    const cleanHistory = Array.from({ length: 12 }, (_, i) => ranAt(940 + i));
    const before = deriveRollingBaseline(budget(), cleanHistory, FULL, IDENTITIES);
    expect(before.baselineMsPerTestFile).toBe(1_000); // the floor held it
    const regressed = [...cleanHistory, ranAt(1_100), ranAt(1_120)];
    const after = deriveRollingBaseline(budget(), regressed, FULL, IDENTITIES);
    expect(after.baselineMsPerTestFile).toBe(before.baselineMsPerTestFile);
    expect(after.windowReadings).not.toContain(1_100);
    expect(after.windowReadings).not.toContain(1_120);
    const out = costs(budget(), regressed, 1_110);
    const cpu = out.find((o) => o.gate === "cpu-per-test-file")!;
    expect(cpu.kind).toBe("fail");
    expect(cpu.message).toContain("do not raise the budget");
    expect(cpu.message).toContain("no streak, no band, no re-run");
    // …and the red names the baseline it fired against, so a reader sees
    // the cap did not move.
    expect(cpu.message).toContain("rolling baseline 1000.0");
    // …AND THE SAME PROOF AT A BUSY AMBIENT: the regression is recorded at
    // amb5 0.8 (its readings earning the +4% adjustment), and the clean
    // history behind it is quiet. The regressed readings sit beyond the
    // AMBIENT-ADJUSTED cap (1,040), so they failed their runs and feed nothing,
    // the baseline still does not move, and the next regressed reading
    // still FAILS — the adjustment pays for the box, never for the
    // regression. A mutant that over-adjusts (or feeds raw busy readings)
    // moves the baseline here and this half reds.
    const busyRegressed = [...cleanHistory,
      ranAt(1_140, { ambientLoad5PerCpu: 0.8 }),
      ranAt(1_160, { ambientLoad5PerCpu: 0.8 }),
    ];
    const busyAfter = deriveRollingBaseline(budget(), busyRegressed, FULL, IDENTITIES);
    expect(busyAfter.baselineMsPerTestFile).toBe(before.baselineMsPerTestFile);
    expect(busyAfter.windowReadings).not.toContain(1_140 / 1.04);
    expect(busyAfter.windowReadings).not.toContain(1_160 / 1.04);
    const busyOut = costs(budget(), busyRegressed, 1_150);
    // The current run is quiet (no amb5): its cap is the unadjusted 1,000,
    // and 1,150 fails against the UNCHANGED baseline, exactly as at quiet.
    const busyCpu = busyOut.find((o) => o.gate === "cpu-per-test-file")!;
    expect(busyCpu.kind).toBe("fail");
    expect(busyCpu.message).toContain("rolling baseline 1000.0");
  });

  test("(b) GROWTH IS NOT ABSORBED BY THE FOLD — readings rising past the cap fail and feed nothing; only the measuring tool moves the floor (design HIGH 1, D-17)", () => {
    // A floor below the readings (900), and readings that rise in small steps, each inside the old spread of the
    // baseline in force: the old fold fed them and the baseline followed the growth, a climb on failing runs. Now a
    // reading over the cap in force failed its own run and feeds nothing: the window stays empty, the baseline stays
    // the floor, and a run at the grown center FAILS until the floor is re-derived by its tool.
    const b = budget({ baselineFloorMsPerTestFile: 900 });
    const rows = Array.from({ length: 24 }, (_, i) => ranAt(905 + 5 * i, { timestamp: `2026-08-01T0${String(i % 10)}:00:00.000Z` }));
    const d = deriveRollingBaseline(b, rows, FULL, IDENTITIES);
    expect(d.windowReadings).toEqual([]);
    expect(d.baselineMsPerTestFile).toBe(900);
    const grown = costs(b, rows, 1_000);
    const cpu = grown.find((o) => o.gate === "cpu-per-test-file")!;
    expect(cpu.kind).toBe("fail");
    expect(cpu.message).toContain("rolling baseline 900.0");
  });

  test("(c) THE FLOOR — a lucky quiet stretch cannot pull the baseline below the recorded floor", () => {
    // Twelve quiet readings at 940-951: all under the 1,000 cap of the
    // floor-seeded cold start, so all passed and feed — and their median (945.5)
    // sits BELOW the floor. The baseline must refuse to drop: the recorded
    // floor is the anchor against exactly this window, so a fast band on
    // the box cannot loosen the gate and arm reds when the band returns.
    const rows = Array.from({ length: 12 }, (_, i) => ranAt(940 + i));
    const d = deriveRollingBaseline(budget(), rows, FULL, IDENTITIES);
    expect(d.medianMsPerTestFile).toBeLessThan(1_000);
    expect(d.floorBound).toBe(true);
    expect(d.baselineMsPerTestFile).toBe(1_000);
  });

  test("(d) THE COLD START — an empty ledger judges against the recorded floor", () => {
    const d = deriveRollingBaseline(budget(), [], FULL, IDENTITIES);
    expect(d.baselineMsPerTestFile).toBe(1_000);
    expect(d.medianMsPerTestFile).toBeNull();
    expect(d.windowReadings).toEqual([]);
    expect(baselineLine(d)).toContain("cold start");
    // The gate judges a first run against the floor exactly: under it
    // passes, over it fails in that one run — an empty ledger forgives nothing.
    expect(costs(budget(), [], 990).find((o) => o.gate === "cpu-per-test-file")!.kind).toBe("pass");
    const first = costs(budget(), [], 1_060).find((o) => o.gate === "cpu-per-test-file")!;
    expect(first.kind).toBe("fail");
    expect(first.message).toContain("no streak, no band, no re-run");
  });

  test("(e) THE FEED FILTER — budget-failed, mutation, saturated and population-drifted rows never feed", () => {
    const clean = Array.from({ length: 12 }, (_, i) => ranAt(940 + i));
    // A quiet-stretch's worth of LOW readings (900 — under the cap, so they
    // would feed), each carrying the budget gate's own failure
    // identity: such a run's budget state was not trustworthy, so its
    // reading must not move the baseline.
    const budgetFailed = Array.from({ length: 14 }, (_, i) =>
      ranAt(900, {
        timestamp: `2026-08-02T0${String(i % 10)}:00:00.000Z`,
        failures: [
          "tests/prevention/web-ui-runtime-budget.test.ts::the suite budget is configured, with the population it was derived against",
        ],
      }),
    );
    const withRows = deriveRollingBaseline(budget(), [...clean, ...budgetFailed], FULL, IDENTITIES);
    expect(withRows.windowReadings).toHaveLength(12);
    expect(withRows.windowReadings).not.toContain(900);
    expect(withRows.medianMsPerTestFile).toBe(945.5);
    // THE COUNTERFACTUAL — the filter is load-bearing: with no identities
    // declared, the same rows feed, evict the clean window, and move the
    // median to their own level.
    const counterfactual = deriveRollingBaseline(budget(), [...clean, ...budgetFailed], FULL, []);
    expect(counterfactual.windowReadings).toContain(900);
    expect(counterfactual.medianMsPerTestFile).toBe(900);
    // A deliberate mutation-verification row at a within-allowance reading
    // never feeds: its reading measured a tree the operator deliberately
    // broke.
    const withMut = deriveRollingBaseline(
      budget(),
      [...clean, ranAt(935, { mutation: true })],
      FULL,
      IDENTITIES,
    );
    expect(withMut.windowReadings).not.toContain(935);
    // THE BUSY-CLEAN ROW FEEDS ITS ADJUSTED READING — the acceptance
    // scenario's mechanism, pinned on the derivation: a row at amb5 0.8
    // reading 935 (inside its own adjusted line 1,000 × 1.047 × 1.04 =
    // 1,088.9) feeds, at 935 / 1.04 = 899.0 — its quiet-equivalent cost, so
    // a busy stretch cannot drag the window's centre up. A mutant that
    // excludes busy rows starves the window on a busy box (the quiet
    // dependency the design forbids); one that feeds the RAW reading
    // inflates the median by 4% for free.
    const withBusy = deriveRollingBaseline(
      budget(),
      [...clean, ranAt(935, { ambientLoad5PerCpu: 0.8 })],
      FULL,
      IDENTITIES,
    );
    expect(withBusy.windowReadings).toContain(899.0384615384615);
    // And the population-drifted row still never feeds — the one condition
    // that remains an exclusion, because it is about the SUITE, not the box.
    const withDrifted = deriveRollingBaseline(
      budget(),
      [...clean, { ...ranAt(935), testModuleCount: 30 }],
      FULL,
      IDENTITIES,
    );
    expect(withDrifted.windowReadings).not.toContain(935);
  });

  test("(f) THE DISCLOSURE — the baseline line and every gate note name the K, the window and the median", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ranAt(940 + i));
    const d = deriveRollingBaseline(budget(), rows, FULL, IDENTITIES);
    const line = baselineLine(d);
    expect(line).toContain("[runtime-budget] baseline: 1000.0 ms/file");
    expect(line).toContain("12-run window");
    expect(line).toContain("945.5"); // the median, named
    expect(line).toContain("held at the declared floor 1000.0"); // the floor, named
    expect(line).toContain("940.0"); // a window reading, named — the evidence
    // The note rides every cpu outcome, pass included: an operator reading
    // any verdict line can see which baseline judged the run and how it
    // was derived.
    const pass = costs(budget(), rows, 990).find((o) => o.gate === "cpu-per-test-file")!;
    expect(pass.kind).toBe("pass");
    expect(pass.message).toContain("rolling baseline 1000.0");
    expect(pass.message).toContain("12-run window");
    expect(baselineNote(d, 0, 0.05)).toContain("945.5");
    // The standing line says the window's readings are ambient-adjusted
    // (an operator must not read them as raw costs), and the note carries
    // the adjustment a given run earned — zero for a quiet one, the
    // envelope's product for a busy one, both spelled.
    expect(baselineLine(d)).toContain("ambient-adjusted");
    expect(baselineNote(d, 0, 0.05)).toContain("No ambient adjustment was earned");
    expect(baselineNote(d, 0.04, 0.8)).toContain("+4.0%");
    expect(baselineNote(d, 0.04, 0.8)).toContain("0.800/cpu");
  });

  test("(g) A STALE-HIGH FLOOR IS DISCLOSED — when the clean median sits beyond the spread below the floor, every line says the floor is stale-loose", () => {
    // The tree genuinely got faster: twelve clean readings at 900 (each
    // inside the 1,047 allowance of the floor-seeded baseline, so all
    // feed). The floor still holds the baseline — but a floor more than a
    // spread above the measured center is a gate looser than the tree it
    // bounds, and the never-silent principle works both directions: the
    // standing line and the gate note must say so and demand the floor's
    // re-derivation.
    const rows = Array.from({ length: 12 }, () => ranAt(900));
    const d = deriveRollingBaseline(budget(), rows, FULL, IDENTITIES);
    expect(d.floorStaleBeyondSpread).toBe(true); // (1,000 − 900)/1,000 = 10% > 4.7%
    const line = baselineLine(d);
    expect(line).toContain("STALE-LOOSE");
    expect(line).toContain("re-derive the floor");
    const out = costs(budget(), rows, 1_060).find((o) => o.gate === "cpu-per-test-file")!;
    expect(out.message).toContain("STALE-LOOSE");
  });

  test("(h) THE AMBIENT CURVE — a synthetic ledger where inflation is planted: the verdict applies the measured adjustment, and the window holds the quiet centre", () => {
    // The calibration the deployed envelope was derived from, planted as a
    // ledger: quiet rows at 950, then busy rows whose readings carry
    // exactly the inflation the envelope predicts for their ambient
    // (amb5 0.6 → +3%, reading 950 × 1.03 = 978.5; amb5 1.0 → +5%, reading
    // 997.5). Every busy row sits inside its own adjusted line (950-era
    // baseline 1,000 × 1.047 × 1.0x ≥ the reading), so all of them feed —
    // and each feeds its ADJUSTED value (950.0 and 950.0 again: the
    // inflation cancels EXACTLY, which is the curve being right). A window
    // full of busy rows therefore holds the quiet centre: the median stays
    // 950 and the floor keeps holding the baseline at 1,000. A mutant that
    // applies no adjustment lets the 997.5 reading feed raw (the median
    // climbs toward 997.5 and this arm's median assertion reds); a mutant
    // that over-adjusts (double the slope) feeds 950 × 1.05 / 1.10 ≈ 909
    // and drags the median DOWN — the floor hides that here, so the arm
    // also asserts the window's VALUES directly, which the floor cannot
    // mask.
    const quiet = Array.from({ length: 6 }, (_, i) => ranAt(950, { timestamp: `2026-08-01T0${String(i)}:00:00.000Z` }));
    const busy = [
      ranAt(978.5, { ambientLoad5PerCpu: 0.6, timestamp: "2026-08-02T01:00:00.000Z" }),
      ranAt(997.5, { ambientLoad5PerCpu: 1.0, timestamp: "2026-08-02T02:00:00.000Z" }),
      ranAt(978.5, { ambientLoad5PerCpu: 0.6, timestamp: "2026-08-02T03:00:00.000Z" }),
      ranAt(997.5, { ambientLoad5PerCpu: 1.0, timestamp: "2026-08-02T04:00:00.000Z" }),
      ranAt(997.5, { ambientLoad5PerCpu: 1.0, timestamp: "2026-08-02T05:00:00.000Z" }),
      ranAt(978.5, { ambientLoad5PerCpu: 0.6, timestamp: "2026-08-02T06:00:00.000Z" }),
    ];
    const d = deriveRollingBaseline(budget(), [...quiet, ...busy], FULL, IDENTITIES);
    // Every busy row fed, at its adjusted value — the window carries the
    // quiet centre, not the busy readings.
    expect(d.windowReadings).toHaveLength(12);
    expect(d.windowReadings).not.toContain(978.5);
    expect(d.windowReadings).not.toContain(997.5);
    // 978.5 / 1.03 and 997.5 / 1.05 both land at ~950 (the planted
    // inflation cancels), beside the six quiet 950s.
    const near = (x: number) => Math.abs(x - 950) < 0.01;
    expect(d.windowReadings.every(near)).toBe(true);
    expect(d.medianMsPerTestFile).toBeLessThan(951);
    expect(d.floorBound).toBe(true); // 950 < the 1,000 floor: the floor holds
    expect(d.baselineMsPerTestFile).toBe(1_000);
    // And the gate over that window: a busy reading carrying exactly the
    // envelope's inflation (1,000 × 1.05 = 1,050 at amb5 1.0) judges a
    // PASS with the arithmetic on the line — the acceptance scenario,
    // driven at the owner. The current run's own ambient is planted on the
    // SUMMARY (where the reporter records it), not on a ledger row.
    const planted = judgeRunCosts(
      judgeRuntimeBudget(goodSummary({ load5PerCpuAtStart: 1.0, load1PerCpuAtStart: 1.0, runCpuMs: 1_050 * FULL }), OPTS),
      {
        cpuBudget: budget(),
        fileShareMax: 0.05,
        priorRuns: [...quiet, ...busy],
        suiteLabel: "web-UI",
        budgetFailureIdentities: IDENTITIES,
      },
    );
    const plantedCpu = planted.find((o) => o.gate === "cpu-per-test-file")!;
    expect(plantedCpu.kind).toBe("pass");
    expect(plantedCpu.message).toContain("1050.0 ms/file within 1050.0");
    expect(plantedCpu.message).toContain("× 1.050 ambient adjustment");
  });
});

describe("a summary that is NOT evidence is refused, and says why", () => {
  const REFUSALS: readonly { readonly what: string; readonly summary: unknown }[] = [
    { what: "nothing on disk yet", summary: null },
    { what: "not an object", summary: "28240" },
    { what: "no wallClockMs", summary: { timestamp: "x", testModuleCount: FULL } },
    { what: "a non-finite wallClockMs", summary: goodSummary({ wallClockMs: Number.NaN }) },
    { what: "a string wallClockMs", summary: goodSummary({ wallClockMs: "28240" }) },
    {
      what: "an older reporter's summary with no testModuleCount",
      summary: { wallClockMs: 28_240, timestamp: "x" },
    },
    {
      what: "a reporter that could not read the run's CPU",
      summary: goodSummary({ runCpuMs: null }),
    },
    {
      what: "a summary predating runCpuMs entirely",
      summary: {
        wallClockMs: 28_240,
        timestamp: "x",
        testModuleCount: FULL,
        totalOccupancyMs: 300_000,
      },
    },
    {
      what: "a ZERO CPU cost — absence wearing a number's clothes",
      summary: goodSummary({ runCpuMs: 0 }),
    },
    { what: "a negative CPU cost", summary: goodSummary({ runCpuMs: -1 }) },
    { what: "a string CPU cost", summary: goodSummary({ runCpuMs: "330000" }) },
  ];

  for (const { what, summary } of REFUSALS) {
    test(`refuses: ${what}`, () => {
      const v = judgeRuntimeBudget(summary, OPTS);
      expect(v.kind).toBe("unmeasurable");
      if (v.kind !== "unmeasurable") return;
      // A refusal that does not say what was missing is a silent skip.
      expect(v.why.length).toBeGreaterThan(10);
    });
  }

  test("A ZERO CPU COST IS THE MOST PERMISSIVE ANSWER THERE IS, so it must not be one", () => {
    // If a missing field became 0, the quotient would be 0 and the budget
    // would pass whatever the suite did. That is the shape of every guard
    // this project has watched go quiet, so it gets its own named test.
    const v = judgeRuntimeBudget(goodSummary({ runCpuMs: 0 }), OPTS);
    expect(v.kind).toBe("unmeasurable");
    if (v.kind !== "unmeasurable") return;
    expect(v.why).toContain("runCpuMs");
  });

  test("THE SUBSET RUN — the exact 174ms summary that used to pass", () => {
    // Reproduced from disk, verbatim, after `npx vitest run <one-file>`.
    const v = judgeRuntimeBudget(
      { wallClockMs: 174, timestamp: "2026-07-27T11:29:54.062Z", testModuleCount: 1 },
      OPTS,
    );
    expect(v.kind).toBe("unmeasurable");
    if (v.kind !== "unmeasurable") return;
    expect(v.why).toContain("1 test files");
    expect(v.why).toContain("subset run");
  });

  test("a run covering just under the coverage floor is refused", () => {
    const justUnder = Math.floor(FULL * MIN_COVERAGE_FRACTION) - 1;
    const v = judgeRuntimeBudget(goodSummary({ testModuleCount: justUnder }), OPTS);
    expect(v.kind).toBe("unmeasurable");
  });

  test("…and one file above the floor is accepted — the boundary is where it is claimed", () => {
    const justOver = Math.ceil(FULL * MIN_COVERAGE_FRACTION) + 1;
    const v = judgeRuntimeBudget(goodSummary({ testModuleCount: justOver }), OPTS);
    expect(v.kind).toBe("measured");
  });
});

describe("a malformed summary cannot crash the guard it was measuring", () => {
  test("garbage in slowestCollects is dropped, not thrown on", () => {
    const v = judgeRuntimeBudget(
      goodSummary({ slowestCollects: [null, 7, { file: 5, ms: 5 }, { file: "ok.ts" }, "x"] }),
      OPTS,
    );
    expect(v.kind).toBe("measured");
    if (v.kind !== "measured") return;
    expect(v.slowestCollects).toEqual([]);
  });

  test("slowestCollects absent entirely is an empty list, not a refusal", () => {
    const s = goodSummary();
    delete s.slowestCollects;
    const v = judgeRuntimeBudget(s, OPTS);
    expect(v.kind).toBe("measured");
    if (v.kind !== "measured") return;
    expect(v.slowestCollects).toEqual([]);
  });

  test("garbage in slowestFiles is dropped, not thrown on", () => {
    const v = judgeRuntimeBudget(
      goodSummary({ slowestFiles: [null, 7, { file: 5, ms: 5 }, { file: "ok.ts" }, "x"] }),
      OPTS,
    );
    expect(v.kind).toBe("measured");
    if (v.kind !== "measured") return;
    expect(v.slowestFiles).toEqual([]);
  });

  test("a non-string timestamp is carried as absent, and the message says so", () => {
    const v = judgeRuntimeBudget(goodSummary({ timestamp: 1_700_000_000 }), OPTS);
    expect(v.kind).toBe("measured");
    if (v.kind !== "measured") return;
    expect(v.summaryTimestamp).toBeNull();
  });
});

describe("per-file occupancy — the share, and the denominator it needs", () => {
  test("the worst file comes back first, whatever order it was written in", () => {
    const v = judgeRuntimeBudget(
      goodSummary({
        slowestFiles: [
          { file: "small.test.ts", ms: 900 },
          { file: "huge.test.ts", ms: 23_900 },
          { file: "middling.test.ts", ms: 5_000 },
        ],
      }),
      OPTS,
    );
    expect(v.kind).toBe("measured");
    if (v.kind !== "measured") return;
    expect(v.slowestFiles.map((f) => f.file)).toEqual([
      "huge.test.ts",
      "middling.test.ts",
      "small.test.ts",
    ]);
  });

  test("THE REGRESSION — a file at 7.2% of the pool is over any sane cap", () => {
    // The measured shape of `async-db-ordering.test.ts` before it was fixed:
    // 23.9s of a 330s pool, while its collect was 0.6s. The collect gate saw
    // nothing wrong, which is the whole reason this second number exists.
    const v = judgeRuntimeBudget(
      goodSummary({
        slowestFiles: [{ file: "tests/prevention/async-db-ordering.test.ts", ms: 23_900 }],
        totalOccupancyMs: 330_000,
      }),
      OPTS,
    );
    expect(v.kind).toBe("measured");
    if (v.kind !== "measured") return;
    expect(v.totalOccupancyMs).not.toBeNull();
    expect(v.slowestFiles[0]!.ms / (v.totalOccupancyMs ?? 0)).toBeGreaterThan(0.05);
  });

  test("a summary predating the pool total reports NULL — a denominator the gate must refuse, never a fabricated zero", () => {
    // Null is not "the pool took no time". It is "this reporter never said",
    // and dividing by it would manufacture a verdict out of a missing field.
    const s = goodSummary();
    delete s.totalOccupancyMs;
    const v = judgeRuntimeBudget(s, OPTS);
    expect(v.kind).toBe("measured");
    if (v.kind !== "measured") return;
    expect(v.totalOccupancyMs).toBeNull();
    expect(provenanceLine(v)).toContain("pool occupancy not measured");
  });

  test("a non-finite pool total is treated as absent, not as a number", () => {
    const v = judgeRuntimeBudget(goodSummary({ totalOccupancyMs: "lots" }), OPTS);
    expect(v.kind).toBe("measured");
    if (v.kind !== "measured") return;
    expect(v.totalOccupancyMs).toBeNull();
  });

  test("unmeasured ambient legs and totals are carried as absence and printed as such, never as -1 or 0", () => {
    const v = judgeRuntimeBudget(goodSummary({
      totalCollectMs: null,
      totalOccupancyMs: null,
      load1PerCpuAtStart: null,
      load5PerCpuAtStart: null,
      load15PerCpuAtStart: null,
    }), OPTS);
    expect(v.kind).toBe("measured");
    if (v.kind !== "measured") return;
    expect(v.totalCollectMs).toBeNull();
    expect(v.totalOccupancyMs).toBeNull();
    expect(v.load1PerCpuAtStart).toBeNull();
    expect(v.load5PerCpuAtStart).toBeNull();
    expect(v.load15PerCpuAtStart).toBeNull();
    const line = provenanceLine(v);
    expect(line).toContain("pool occupancy not measured");
    expect(line).toContain("ambient load not measured/cpu");
    expect(line).toContain("5-minute leg not measured/cpu");
    expect(line).not.toContain("-1");
    expect(line).not.toContain("/cpu (5-minute leg 0");
  });

  test("the historical -1 sentinel is absence, not a measured reading", () => {
    // The old readers wrote -1 for an unreadable leg, and -1 is FINITE, so a
    // finite-number check alone lets it through as a measurement: the
    // provenance line printed "-1/cpu" and the ledger kept it. A measurement
    // magnitude cannot be negative.
    const v = judgeRuntimeBudget(goodSummary({
      totalCollectMs: -1,
      totalOccupancyMs: -1,
      load1PerCpuAtStart: -1,
      load5PerCpuAtStart: -1,
      load15PerCpuAtStart: -1,
    }), OPTS);
    expect(v.kind).toBe("measured");
    if (v.kind !== "measured") return;
    expect(v.totalCollectMs).toBeNull();
    expect(v.totalOccupancyMs).toBeNull();
    expect(v.load1PerCpuAtStart).toBeNull();
    expect(v.load5PerCpuAtStart).toBeNull();
    expect(v.load15PerCpuAtStart).toBeNull();
    expect(provenanceLine(v)).not.toContain("-1");
  });
});

describe("the budget names the population it bounds", () => {
  const WEB_KEY = "testExecution.webUiSuiteCpuBudget";
  const declared: DeclaredCpuBudget = {
    msPerTestFile: 900,
    derivedAtTestFileCount: 451,
    maxPopulationDriftFraction: 0.03,
    ambientInflationSlopePerCpu: 0.05,
    ambientInflationCapFraction: 0.12,
  };

  test("the tree it was derived against is current", () => {
    const v = judgePopulationDrift(declared, 451, WEB_KEY);
    expect(v.kind).toBe("current");
    expect(v.driftFraction).toBe(0);
  });

  test("THE ACTUAL INCIDENT — 433 derived, 451 running — is refused", () => {
    // The defect this mechanism exists for, as its own fixture. A cap
    // measured against 433 test files went on governing 451, silently, and
    // became the sole red in three consecutive steps with no regression
    // behind it. Under the configured tolerance this now fails and names the
    // re-derivation instead.
    const stale = judgePopulationDrift({ ...declared, derivedAtTestFileCount: 433 }, 451, WEB_KEY);
    expect(stale.kind).toBe("stale");
    if (stale.kind !== "stale") return;
    expect(stale.driftFraction).toBeGreaterThan(0.04);
    expect(stale.why).toContain("433");
    expect(stale.why).toContain("451");
    expect(stale.why).toContain("grown");
    // The message must forbid the cheap repair, or the mechanism converts
    // one stale number into a habit of restating populations.
    expect(stale.why).toContain("derivedAtTestFileCount");
    expect(stale.why).toContain("re-deriv");
  });

  test("growth within the tolerance is not a refusal — the gate must not red on every new test", () => {
    // 13 files added to 451 is 2.9%, inside a 3% tolerance. A mechanism that
    // reds on one new test file would be turned off within a week.
    expect(judgePopulationDrift(declared, 464, WEB_KEY).kind).toBe("current");
  });

  test("the boundary is exactly where it is claimed, on both sides", () => {
    const exact = Math.floor(451 * 1.03); // 464 — 2.88% drift, admitted
    expect(judgePopulationDrift(declared, exact, WEB_KEY).kind).toBe("current");
    expect(judgePopulationDrift(declared, exact + 1, WEB_KEY).kind).toBe("stale");
  });

  test("SHRINKING is drift too — deleting a population's definition must force a re-derive", () => {
    // The permissive direction is the dangerous one: a budget derived on a
    // big suite and left in place over a small one passes everything.
    const v = judgePopulationDrift(declared, 380, WEB_KEY);
    expect(v.kind).toBe("stale");
    if (v.kind !== "stale") return;
    expect(v.why).toContain("shrunk");
  });
});

describe("the run's CPU cost is measured, not assumed", () => {
  test("a reaped child's CPU is counted, and it dominates a forked run", () => {
    // DRIVEN, NOT READ. Vitest spends nearly all of a run's CPU in pool
    // workers, which are children of the process this is read from — so if
    // reaped children did not count, the number would be a rounding error
    // and the budget would bound the reporter rather than the suite.
    const before = readRunCpu();
    expect(before).not.toBeNull();
    // THE CHILD IS CPU-BOUNDED, NOT WALL-BOUNDED, and the difference is the
    // whole point of the field being measured. A `Date.now()`-bounded burner
    // delivers whatever share a contended box hands it — this test failed at
    // exactly that when the suite was running beside eight CPU burners — so
    // it would have been asserting the scheduler's mood rather than the
    // attribution being checked.
    const burnUs = 800_000;
    spawnSync(process.execPath, [
      "-e",
      `for (;;) { const u = process.cpuUsage(); if (u.user + u.system > ${String(burnUs)}) break; for (let i = 0; i < 2e6; i++) Math.sqrt(i); }`,
    ]);
    const after = readRunCpu();
    expect(after).not.toBeNull();
    if (before === null || after === null) return;
    // The child spent at least 800ms of its own CPU before exiting; most of
    // that must have landed in this process's reaped-children accounting.
    expect(after.childCpuMs - before.childCpuMs).toBeGreaterThan((burnUs / 1000) * 0.8);
    expect(after.totalCpuMs).toBeGreaterThan(after.childCpuMs);
  });

  test("the tick length is DERIVED, so a kernel with a different HZ still measures", () => {
    // No clock-tick constant exists to go stale: the rate comes from this
    // process's own two clocks. Handing in a self-CPU twice as large must
    // double the answer, which is only true if nothing is hardcoded.
    const stat = procfsDocument("self", "stat") ?? "";
    const single = readRunCpu(
      () => stat,
      () => ({ user: 1_000_000, system: 0 }),
    );
    const doubled = readRunCpu(
      () => stat,
      () => ({ user: 2_000_000, system: 0 }),
    );
    expect(single).not.toBeNull();
    expect(doubled).not.toBeNull();
    if (single === null || doubled === null) return;
    // Both answers are rounded to whole milliseconds independently, so
    // doubling the input can land one millisecond off doubling the output.
    // Measured: 4952 and 9905. Asserting exact equality here would be
    // asserting the rounding, not the derivation — and it went red on the
    // first real run that hit it.
    expect(Math.abs(doubled.totalCpuMs - single.totalCpuMs * 2)).toBeLessThanOrEqual(2);
    // …and the doubling must actually have happened: a hardcoded tick rate
    // would return the same number for both inputs.
    expect(doubled.totalCpuMs).toBeGreaterThan(single.totalCpuMs * 1.9);
  });

  test("a process name containing spaces and parentheses does not shift the fields", () => {
    // The standard trap in reading /proc/[pid]/stat, and the one that would
    // silently return some other field's number rather than failing.
    const fields = [
      "R", "1", "1", "1", "0", "-1", "4194304", "0", "0", "0", "0",
      "1000", "200", "30000", "1000",
    ];
    const line = `4242 (my (weird) name) ${fields.join(" ")}\n`;
    const v = readRunCpu(
      () => line,
      () => ({ user: 12_000_000, system: 0 }), // 12,000ms of self CPU
    );
    expect(v).not.toBeNull();
    if (v === null) return;
    // 1,200 self ticks ⇒ 10ms per tick; 31,000 child ticks ⇒ 310,000ms.
    expect(v.childCpuMs).toBe(310_000);
    expect(v.totalCpuMs).toBe(322_000);
  });

  test("ABSENCE, NEVER ZERO — an unreadable /proc is null and not a free pass", () => {
    // The procfs owner answers `undefined` for a document it cannot read.
    expect(readRunCpu(() => undefined)).toBeNull();
  });

  test("a stat line with no closing paren is refused rather than mis-parsed", () => {
    expect(readRunCpu(() => "4242 broken 1 2 3")).toBeNull();
  });

  test("a truncated stat line is refused rather than read short", () => {
    expect(readRunCpu(() => "4242 (n) R 1 1 1")).toBeNull();
  });

  test("a process with no measurable self CPU cannot calibrate, so it refuses", () => {
    // utime and stime both zero: there is nothing to derive the tick length
    // from, and inventing one would put a fabricated number into a budget.
    const line = "1 (n) R 1 1 1 0 -1 0 0 0 0 0 0 0 500 500\n";
    expect(readRunCpu(() => line, () => ({ user: 1_000, system: 0 }))).toBeNull();
  });

  test("a zero self CPU reading cannot calibrate either", () => {
    const stat = procfsDocument("self", "stat") ?? "";
    expect(readRunCpu(() => stat, () => ({ user: 0, system: 0 }))).toBeNull();
  });
});

describe("the run-history ledger — the judged runs the rolling baseline reads", () => {
  // DRIVEN AGAINST A PRIVATE FILE, never the live ledger: the real one is
  // shared state a concurrent run appends to (the same reason the summary is
  // judged as an object rather than re-read from disk).
  const dir = createTempDir("budget-history-");
  const record = (n: number) => ({
    timestamp: `2026-07-30T10:${String(n).padStart(2, "0")}:00.000Z`,
    cpuMsPerTestFile: 900 + n,
    testModuleCount: 417,
  });

  test("appends round-trip in order, oldest first", () => {
    const path = join(dir, "roundtrip.json");
    appendJudgedRun(record(1), path);
    appendJudgedRun(record(2), path);
    appendJudgedRun(record(3), path);
    expect(readRunHistory(path).map((r) => r.cpuMsPerTestFile)).toEqual([901, 902, 903]);
  });

  test("a missing ledger is EMPTY: the baseline stands at its floor, never inventing a red or loosening a cap", () => {
    expect(readRunHistory(join(dir, "never-written.json"))).toEqual([]);
  });

  test("a corrupt ledger is empty too — broken evidence weakens the verdict, loudly elsewhere", () => {
    const path = join(dir, "corrupt.json");
    writeFileSync(path, "{not json");
    expect(readRunHistory(path)).toEqual([]);
    // …and an append RECOVERS the file rather than throwing on it.
    appendJudgedRun(record(7), path);
    expect(readRunHistory(path).map((r) => r.cpuMsPerTestFile)).toEqual([907]);
  });

  test("malformed entries are skipped, well-formed neighbours survive", () => {
    const path = join(dir, "mixed.json");
    writeFileSync(
      path,
      JSON.stringify({
        runs: [record(1), null, "x", { cpuMsPerTestFile: "fast" }, { timestamp: 3 }, record(2)],
      }),
    );
    expect(readRunHistory(path).map((r) => r.cpuMsPerTestFile)).toEqual([901, 902]);
    // A record with no timestamp is carried with the absence stated, not dropped:
    // the baseline needs its number; the label is provenance.
    writeFileSync(path, JSON.stringify({ runs: [{ cpuMsPerTestFile: 950, testModuleCount: 417 }] }));
    expect(readRunHistory(path)).toEqual([
      { timestamp: null, cpuMsPerTestFile: 950, testModuleCount: 417 },
    ]);
  });

  test("the ledger trims to the newest HISTORY_KEPT, which is far above the baseline window and the flaky window", () => {
    const path = join(dir, "trim.json");
    for (let i = 0; i < HISTORY_KEPT + 5; i++) appendJudgedRun(record(i), path);
    const kept = readRunHistory(path);
    expect(kept).toHaveLength(HISTORY_KEPT);
    // The NEWEST are kept — trimming the newest would erase the evidence the baseline reads.
    expect(kept[kept.length - 1]!.cpuMsPerTestFile).toBe(900 + HISTORY_KEPT + 4);
    // Far above the declared flaky window (bounded above by HISTORY_KEPT
    // itself) and the baseline window, so a trim never eats a reading either reads.
    expect(HISTORY_KEPT).toBeGreaterThan(10);
  });

  test("the window holds the budget-watch era — the depth is the measured 60, and one row past it evicts the oldest", () => {
    // The depth is a measured requirement, not a round number: one
    // budget-watch round consumed 12 of the old 20 slots on its own runs,
    // and the 2026-09-04 era analysis that needed its earliest readings
    // found them rotated out and had to rebuild nine from tracker prose.
    // The derivation lives at the constant's owner; this arm pins the
    // owner to it so a severed depth (back to the 20 that amputated the
    // era) reds HERE rather than silently shrinking every future era
    // analysis.
    expect(HISTORY_KEPT).toBe(60);
    const path = join(dir, "era-depth.json");
    for (let i = 0; i < HISTORY_KEPT + 1; i++) appendJudgedRun(record(i), path);
    const kept = readRunHistory(path);
    expect(kept).toHaveLength(60);
    // One row past the window evicts exactly the OLDEST — the era's
    // readings survive in order, newest kept, none of the middle lost.
    expect(kept[0]!.cpuMsPerTestFile).toBe(901);
    expect(kept[kept.length - 1]!.cpuMsPerTestFile).toBe(960);
  });

  test("fields this module does not read SURVIVE a rewrite — the ledger leaves room to grow", () => {
    // A flaky-test guard will want per-test failure rows in the same ledger;
    // an append that strips unknown fields would silently delete that
    // guard's memory every time the budget writes its own.
    const path = join(dir, "grow.json");
    writeFileSync(
      path,
      JSON.stringify({ runs: [{ ...record(1), failedTests: ["tests/unit/a.test.ts"] }] }),
    );
    appendJudgedRun(record(2), path);
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      runs: Record<string, unknown>[];
    };
    expect(raw.runs[0]!.failedTests).toEqual(["tests/unit/a.test.ts"]);
  });

  test("the during-run calibration fields ride the row — wall clock and pool occupancy parse, survive a rewrite, and stay ABSENT when unrecorded", () => {
    // The occupancy/CPU ratio is the in-situ contention signal a future
    // ambient-envelope derivation will be calibrated from (the 2026-09-04
    // pairs recorded ≈0.99 for both a quiet and an inflated run, which is
    // WHY no consumer judges by them today). The row must carry them:
    // asserted as VALUES (the parse's own output), the severance-proof
    // shape — and a malformed or missing figure stays ABSENT, never a
    // fabricated zero poisoning the entry.
    const path = join(dir, "calibration.json");
    appendJudgedRun(
      { ...record(1), wallClockMs: 79_830, totalOccupancyMs: 795_900 },
      path,
    );
    appendJudgedRun({ ...record(2), wallClockMs: Number.NaN }, path);
    const rows = readRunHistory(path);
    expect(rows[0]!.wallClockMs).toBe(79_830);
    expect(rows[0]!.totalOccupancyMs).toBe(795_900);
    // A non-numeric wall clock is absent (never zero, never thrown on), and
    // a row recorded without the occupancy field omits it entirely.
    expect(rows[1]!.wallClockMs).toBeUndefined();
    expect(rows[1]!.totalOccupancyMs).toBeUndefined();
    // And both SURVIVE the rewrite the next append performs.
    appendJudgedRun(record(3), path);
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      runs: Record<string, unknown>[];
    };
    expect(raw.runs[0]!.wallClockMs).toBe(79_830);
    expect(raw.runs[0]!.totalOccupancyMs).toBe(795_900);

    // A legacy row's -1 sentinel is absence too. -1 is finite, so the parse
    // used to keep it as a reading; the ledger then held "unreadable" as a
    // number that every future window would average.
    appendJudgedRun({
      ...record(4),
      ambientLoadPerCpu: -1,
      ambientLoad5PerCpu: -1,
      ambientLoad15PerCpu: -1,
      wallClockMs: -5,
      totalOccupancyMs: -1,
    }, path);
    const sentinelRows = readRunHistory(path);
    expect(sentinelRows[3]!.ambientLoadPerCpu).toBeUndefined();
    expect(sentinelRows[3]!.ambientLoad5PerCpu).toBeUndefined();
    expect(sentinelRows[3]!.ambientLoad15PerCpu).toBeUndefined();
    expect(sentinelRows[3]!.wallClockMs).toBeUndefined();
    expect(sentinelRows[3]!.totalOccupancyMs).toBeUndefined();
  });
});

describe("the measurement carries its witness — D1, the fabricated zero", () => {
  test("a zero written-count beside a newest mtime AFTER run start is a CONTRADICTION, refused", () => {
    // The S37-check's surviving mutant: `cacheEntriesWrittenSince` computed
    // the walk and returned 0, and a fully cold run was judged into the
    // ledger with every guard green — the deny-by-default arm refused only
    // the NULL spelling. The witness (newest mtime, from the same walk)
    // makes that mutant refuse itself: a zero it cannot fabricate a witness
    // for is a zero the verdict will not call warmth.
    const v = judgeRuntimeBudget(
      goodSummary({
        moduleCacheEntriesWrittenDuringRun: 0,
        moduleCacheNewestEntryMtimeMs: 1_000_900, // ≥ runStartedAtMs (1,000,000)
      }),
      OPTS,
    );
    expect(v.kind).toBe("unmeasurable");
    if (v.kind !== "unmeasurable") return;
    expect(v.why).toContain("contradict");
  });

  test("a populated cache with a count but NO witness beside it is refused (deny by default)", () => {
    for (const hole of [
      { moduleCacheNewestEntryMtimeMs: null },
      { runStartedAtMs: null },
    ]) {
      const v = judgeRuntimeBudget(goodSummary(hole), OPTS);
      expect(v.kind, JSON.stringify(hole)).toBe("unmeasurable");
      if (v.kind !== "unmeasurable") continue;
      expect(v.why).toContain("witness");
    }
  });

  test("THE INSTRUMENT ITSELF, DRIVEN — planted mtimes in, the exact count and witness out", () => {
    // The half the check found missing: no test ever drove the measurement
    // function against a real directory, so its compute-then-return-0 mutant
    // survived. This is that test: a temp directory, mtimes planted on both
    // sides of the reference, the exact count asserted, and the newest-mtime
    // witness asserted to come from the same walk.
    const dir = createTempDir("written-since-");
    const sinceMs = Date.now() - 120_000;
    const plant = (name: string, mtimeMs: number): void => {
      const p = join(dir, name);
      writeFileSync(p, name);
      utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
    };
    plant("old-a", sinceMs - 50_000);
    plant("old-b", sinceMs - 40_000);
    plant("old-c", sinceMs - 1_000);
    plant("new-a", sinceMs); // the boundary belongs to the run: >= counts
    plant("new-b", sinceMs + 30_000);

    const reading = cacheEntriesWrittenSince(dir, sinceMs);
    expect(reading).not.toBeNull();
    if (reading === null) return;
    expect(reading.written).toBe(2);
    expect(reading.newestMtimeMs).not.toBeNull();
    expect(Math.abs((reading.newestMtimeMs ?? 0) - (sinceMs + 30_000))).toBeLessThan(1_500);

    // A fully-old directory: zero written AND a witness that agrees (< since)
    // — the only honest spelling of a warm cache.
    const warmDir = createTempDir("written-since-warm-");
    const wp = join(warmDir, "only");
    writeFileSync(wp, "x");
    utimesSync(wp, (sinceMs - 5_000) / 1000, (sinceMs - 5_000) / 1000);
    const warm = cacheEntriesWrittenSince(warmDir, sinceMs);
    expect(warm).not.toBeNull();
    if (warm === null) return;
    expect(warm.written).toBe(0);
    expect(warm.newestMtimeMs).not.toBeNull();
    expect(warm.newestMtimeMs ?? Number.POSITIVE_INFINITY).toBeLessThan(sinceMs);
  });
});

describe("the reporter appends ONLY judged runs — D2's other half, driven end-to-end", () => {
  // The reporter is driven through onInit, onTestRunStart and onTestRunEnd —
  // against ITS OWN summary, ledger and cache directory (constructor
  // overrides), never the live artifacts: the live summary was observed
  // being overwritten twice inside one read-only check, and a test that
  // wrote the live ledger would be planting entries into the baseline every
  // other run consults.
  const fakeModules = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `task-${String(i)}`,
      moduleId: `tests/fake/${String(i)}.test.ts`,
      // Zero collect (the share gate must not fire on a fabricated
      // wall-clock of milliseconds); 1ms of occupancy each so the pool
      // total exists and no single file dominates it.
      diagnostic: () => ({ collectDuration: 0, duration: 1 }),
      state: () => "passed",
      errors: () => [],
      children: {
        allTests: () => [{ id: `case-${String(i)}`, fullName: `case ${String(i)}`, result: () => ({ state: "passed", errors: [] }) }],
        allSuites: () => [],
      },
    }));

  const currentQualificationCauses = ["file-share", "unhandled-with-owned-case", "module-with-owned-case", "suite-with-owned-case", "unreadable-with-owned-case", "missing-with-owned-case", "passed-reason-global", "interrupted", "malformed-state", "empty-module-id", "empty-suite-id", "unreadable-suite", "unaccounted-module", "summary-write", "owned-only", "missing-start", "omitted-module", "substitute-module", "duplicate-start", "malformed-start", "unreadable-start", "duplicate-module-task-id", "malformed-module-task-id", "same-path-project-pool", "same-case-display", "same-suite-display", "duplicate-case-task-id", "duplicate-suite-task-id", "configured-shard", "wrong-module-path"] as const;
  const runCurrentQualificationCause = (cause: (typeof currentQualificationCauses)[number]): void => {
    // The real suite may be a deliberate mutation run; this private fixture
    // models an ordinary run. Keep its provenance local and restore its
    // parent even when the producer or an assertion throws.
    const runFixture = (completionFailure?: Error): void => {
      const inheritedMutation = process.env.HARNESS_MUTATION_RUN;
      delete process.env.HARNESS_MUTATION_RUN;
      try {
        const dir = createTempDir("reporter-current-completion-");
        const historyPath = join(dir, "history.json");
        const cacheDir = join(dir, "cache");
        mkdirSync(cacheDir);
        const full = fullRunModuleCount();
        const past = (Date.now() - 60_000) / 1000;
        for (let i = 0; i < full + 10; i++) {
          const entry = join(cacheDir, `entry-${String(i)}`);
          writeFileSync(entry, "x");
          utimesSync(entry, past, past);
        }
        const output: string[] = [];
        const exits: number[] = [];
        const reporter = new BudgetReporter({
          summaryPath: cause === "summary-write" ? dir : join(dir, "summary.json"), historyPath, cacheDir, repositoryRoot: reporterRepository(),
          out: (line) => { output.push(line); }, err: (line) => { output.push(line); },
          instrumentLockPath: heldInstrumentLock(), performanceReportPath: passingProfileReport(), setExitCode: (code) => { exits.push(code); },
        });
        const owned = cause !== "file-share" && cause !== "passed-reason-global" && cause !== "unaccounted-module";
        const allModules = fakeModules(full).map((module, index) => ({
          ...module,
          moduleId: cause === "empty-module-id" && index === 0 ? ""
            : cause === "same-path-project-pool" && index === 1 ? "tests/fake/0.test.ts" : module.moduleId,
          id: cause === "duplicate-module-task-id" && index === full - 1 ? "task-0"
            : cause === "malformed-module-task-id" && index === full - 1 ? null : module.id,
          diagnostic: () => ({ collectDuration: 0, duration: cause === "file-share" && index === 0 ? full : 1 }),
          state: () => (owned || cause === "unaccounted-module") && index === 0 ? "failed" : "passed",
          errors: () => cause === "module-with-owned-case" && index === 0 ? [{ message: "independent module error" }] : [],
          children: {
            allTests: () => [
              { id: `case-${String(index)}`, fullName: `case ${String(index)}`, result: () => owned && index === 0
                ? { state: "failed", errors: [{ name: "AssertionError", message: "already owned test failure" }] }
                : { state: "passed", errors: [] } },
              ...(index !== 0 ? [] : cause === "unreadable-with-owned-case"
                ? [{ fullName: "unreadable case", result: () => { throw new Error("no result"); } }]
                : cause === "missing-with-owned-case" ? [{ fullName: "missing case", result: () => undefined }]
                : cause === "malformed-state" ? [{ id: "malformed-case", fullName: "malformed case", result: () => ({ state: ["passed"], errors: [] }) }]
                : cause === "same-case-display" ? [{ id: "other-case-0", fullName: "case 0", result: () => ({ state: "passed", errors: [] }) }]
                : cause === "duplicate-case-task-id" ? [{ id: "case-0", fullName: "other case", result: () => ({ state: "passed", errors: [] }) }]
                : []),
            ],
            allSuites: () => cause === "suite-with-owned-case" && index === 0
              ? [{ id: "nested-suite", fullName: "nested", state: () => "failed", errors: () => [{ message: "independent nested suite error" }] }]
              : index === 0 && cause === "empty-suite-id" ? [{ id: "", fullName: "nested", state: () => "passed", errors: () => [] }]
              : index === 0 && cause === "same-suite-display" ? [0, 1].map((i) => ({ id: `suite-${String(i)}`, fullName: "same display", state: () => "passed", errors: () => [] }))
              : index === 0 && cause === "duplicate-suite-task-id" ? [0, 1].map((i) => ({ id: "duplicated-suite", fullName: `different ${String(i)}`, state: () => "passed", errors: () => [] }))
              : index === 0 && cause === "unreadable-suite" ? [{ id: "unreadable-suite", fullName: "unreadable", state: () => { throw new Error("no suite result"); }, errors: () => [] }]
              : [],
          },
        }));
        const modules = cause === "omitted-module" ? allModules.slice(0, -1)
          : cause === "substitute-module" ? allModules.map((module, index) => index === full - 1 ? { ...module, id: "unplanned-task" } : module)
          : cause === "wrong-module-path" ? allModules.map((module, index) => index === full - 1 ? { ...module, moduleId: "virtual:unplanned-module-path" } : module)
          : allModules;
        let specifications: { taskId: unknown; moduleId: string }[] = fakeModules(full).map((module, index) => ({
          taskId: module.id,
          moduleId: cause === "same-path-project-pool" && index === 1 ? "tests/fake/0.test.ts" : module.moduleId,
        }));
        if (cause === "duplicate-start") specifications[full - 1] = { ...specifications[full - 1]!, taskId: "task-0" };
        if (cause === "malformed-start") specifications[full - 1] = { ...specifications[full - 1]!, taskId: null };
        if (cause === "unreadable-start") specifications[full - 1] = { moduleId: specifications[full - 1]!.moduleId, get taskId() { throw new Error("unreadable intended identity"); } };
        if (cause === "configured-shard") specifications = [...specifications, ...specifications.map((specification) => ({ ...specification, taskId: `${String(specification.taskId)}-other-shard` }))];
        // Real public hooks. Optional lookup keeps the missing-hook BEFORE a
        // semantic false-admission witness, not a TypeError/setup failure.
        Reflect.apply(reporter.onInit, reporter, [{ config: { shard: cause === "configured-shard" ? { index: 1, count: 2 } : undefined } }]);
        const startHook = (reporter as BudgetReporter & { onTestRunStart?: (specifications: readonly { taskId: unknown }[]) => void }).onTestRunStart;
        if (cause !== "missing-start") startHook?.call(reporter, specifications);
        reporter.onTestRunEnd(modules,
          cause === "unhandled-with-owned-case" || cause === "passed-reason-global" ? [{ name: "Error", message: "independent unhandled failure" }] : [],
          cause === "interrupted" ? "interrupted" : owned || cause === "unaccounted-module" ? "failed" : "passed");
        const acceptsCurrent = cause === "owned-only" || cause === "same-path-project-pool" || cause === "same-case-display" || cause === "same-suite-display";
        // A refusal the drive did not ask for says why (the reporter's own words), so a red names its cause.
        if (acceptsCurrent || cause === "configured-shard") expect(exits, output.join("")).not.toContain(1);
        else expect(exits, "the actual producer must fail independently of any ordinary owned test").toContain(1);
        // A gate that could not run writes no history: the red says why, in the reporter's own words.
        expect(existsSync(historyPath), `the reporter wrote no history: ${output.join("")}`).toBe(true);
        const raw = JSON.parse(readFileSync(historyPath, "utf8")) as { runs: { mutationRun?: boolean; failures: string[]; qualification?: { outcomes?: { gate: string; kind: string; message: string }[] } }[] };
        expect(raw.runs).toHaveLength(1);
        expect(raw.runs[0]!.mutationRun, "an ordinary reporter fixture must not inherit its parent mutation provenance").toBeUndefined();
        expect(raw.runs[0]!.failures).toHaveLength(owned || cause === "unaccounted-module" ? 1 : 0);
        const expectedGate = cause === "file-share" ? "per-file-pool-share"
          : cause === "module-with-owned-case" ? "module-errors" : cause === "suite-with-owned-case" ? "suite-errors"
          : cause === "unhandled-with-owned-case" || cause === "passed-reason-global" ? "unhandled-errors"
          : cause === "interrupted" ? "runner-terminal" : cause === "summary-write" ? "web-summary"
          : ["missing-start", "omitted-module", "substitute-module", "duplicate-start", "malformed-start", "unreadable-start", "wrong-module-path"].includes(cause) ? "module-census" : "test-results";
        if (!acceptsCurrent && cause !== "configured-shard") expect(raw.runs[0]!.qualification?.outcomes,
          "the real producer's independent failure survives in its own envelope beside the exact test rows")
          .toEqual(expect.arrayContaining([expect.objectContaining({ gate: expectedGate, kind: "fail" })]));
        const row = readRunHistory(historyPath)[0]!;
        const qualification = row.qualification!;
        // This typed terminal is a fixture; the producer above is actual. The
        // identical terminal boundary isolates the non-test producer verdict.
        const terminal: RunQualificationTerminal = {
          invocationId: qualification.invocationId, treeId: qualification.treeId,
          ending: "exited", exitCode: 1, status: 1, signal: null, outputComplete: true,
          receiptPresent: true, noOwnedChildren: true, timedOut: false, interrupted: false,
          commandKilled: false, killedDescendants: 0, orphanedGroupKilled: false,
        };
        finalizeQualifiedRun(historyPath, qualification.invocationId, qualification.treeId, terminal);
        const admission = currentQualificationOutcome(runForInvocation(historyPath, qualification.invocationId), {
          invocationId: qualification.invocationId, treeId: qualification.treeId, producer: "web", outer: terminal,
        });
        expect(admission.kind).toBe(acceptsCurrent ? "pass" : "fail");
        if (acceptsCurrent) expect(admission.message).toContain("complete current result");
        else expect(admission.message).toMatch(/producer result census is incomplete|current non-test gate failed/u);
        if (cause === "configured-shard") {
          expect(qualification.producerComplete).toBe(false);
          expect(qualification.outcomes).toEqual(expect.arrayContaining([expect.objectContaining({ gate: "qualification-scope", kind: "not-judged" })]));
          expect(qualification.outcomes.some((outcome) => outcome.kind === "fail")).toBe(false);
        }
        if (completionFailure !== undefined) throw completionFailure;
      } finally {
        if (inheritedMutation === undefined) delete process.env.HARNESS_MUTATION_RUN;
        else process.env.HARNESS_MUTATION_RUN = inheritedMutation;
      }
    };
    const suiteMutation = process.env.HARNESS_MUTATION_RUN;
    // Vitest stores one original value per key; its stubs are not nested
    // scopes. Only the test input uses that owner; the fixture restores its
    // own captured parent directly. Exercise contamination in ordinary runs.
    for (const inheritedMutation of [undefined, "1", ...(cause === "owned-only" ? ["not-a-mutation"] : [])]) {
      vi.stubEnv("HARNESS_MUTATION_RUN", inheritedMutation);
      try {
        runFixture();
        expect(process.env.HARNESS_MUTATION_RUN, "normal fixture completion restores its exact parent mutation flag").toBe(inheritedMutation);
        if (cause === "owned-only") {
          const completionFailure = new Error("reporter fixture completion interrupted");
          let caught: unknown;
          try { runFixture(completionFailure); }
          catch (error) { caught = error; }
          expect(caught, "the completed producer/admission body must propagate this exact failure").toBe(completionFailure);
          expect(process.env.HARNESS_MUTATION_RUN, "throwing fixture completion restores its exact parent mutation flag").toBe(inheritedMutation);
        }
      } finally {
        vi.unstubAllEnvs();
      }
      expect(process.env.HARNESS_MUTATION_RUN, "test input cleanup restores the actual suite mutation flag").toBe(suiteMutation);
    }
  };
  const ownedOnlyIndex = currentQualificationCauses.indexOf("owned-only");
  test.each(currentQualificationCauses.slice(0, ownedOnlyIndex))("current qualification preserves the actual reporter %s failure independently of test rows", (cause) => {
    runCurrentQualificationCause(cause);
  });
  test("current qualification preserves the actual reporter owned-only failure independently of test rows", () => {
    runCurrentQualificationCause("owned-only");
  });
  test.each(currentQualificationCauses.slice(ownedOnlyIndex + 1))("current qualification preserves the actual reporter %s failure independently of test rows", (cause) => {
    runCurrentQualificationCause(cause);
  });

  test("a REFUSED run leaves the ledger untouched; a JUDGED run appends exactly one record", async () => {
    const dir = createTempDir("reporter-append-");
    const summaryPath = join(dir, "summary.json");
    const historyPath = join(dir, "history.json");
    // A warm cache the size of a full run: the verdict floors the end-count
    // by the module count, and mtimes sit safely before onInit.
    const cacheDir = join(dir, "cache");
    mkdirSync(cacheDir);
    const full = fullRunModuleCount();
    const past = (Date.now() - 60_000) / 1000;
    for (let i = 0; i < full + 10; i++) {
      const p = join(cacheDir, `entry-${String(i)}`);
      writeFileSync(p, "x");
      utimesSync(p, past, past);
    }

    // EVERY OBSERVABLE THIS RUN HAS IS CAPTURED, NOT JUST THE FILES.
    //
    // The paths were already redirected here, correctly, because the live
    // summary and ledger are shared state. The OUTPUT was not, and that was
    // the same defect one step out: the refused run below prints
    // `[runtime-budget] <gate>: NOT JUDGED — the recorded run covered 3 test
    // files` — the product's exact bytes, from a fixture — straight onto the
    // real run's stdout. It cost a writer a full extra run chasing a gate that
    // was never unarmed, and no amount of reading the terminal could have told
    // them, because the line is byte-identical to the one the real gate emits.
    //
    // The harness type now requires all six sinks, so this is a compile error
    // rather than a habit. `process.exitCode` is captured for the same reason
    // and the old `finally` that restored it afterwards is gone: restoring an
    // observable after the fact still lets a fabricated verdict exist, and it
    // relies on the restore running.
    const printed: string[] = [];
    const exitCodes: number[] = [];
    const harness = {
      summaryPath,
      historyPath,
      cacheDir,
      repositoryRoot: reporterRepository(),
      out: (chunk: string) => void printed.push(chunk),
      err: (chunk: string) => void printed.push(chunk),
      instrumentLockPath: heldInstrumentLock(), performanceReportPath: ABSENT_PROFILE_REPORT, setExitCode: (code: number) => void exitCodes.push(code),
    } as const;
    const exitBefore = process.exitCode;

    // THE REFUSED RUN: a three-module subset. The verdict refuses it
    // (coverage floor), so nothing may enter the ledger — the mutant this
    // kills is the append hoisted out of the judged-only guard.
    const refused = new BudgetReporter(harness);
    refused.onInit();
    refused.onTestRunStart(fakeModules(3).map((module) => ({ taskId: module.id, moduleId: module.moduleId })));
    refused.onTestRunEnd(fakeModules(3), [], "passed");
    expect(readRunHistory(historyPath)).toEqual([]);

    // THE JUDGED RUN: full-coverage modules over the warm cache. Exactly
    // one record enters, carrying the run's own population.
    const judged = new BudgetReporter(harness);
    judged.onInit();
    judged.onTestRunStart(fakeModules(full).map((module) => ({ taskId: module.id, moduleId: module.moduleId })));
    judged.onTestRunEnd(fakeModules(full), [], "passed");
    const history = readRunHistory(historyPath);
    expect(history).toHaveLength(1);
    expect(history[0]!.testModuleCount).toBe(full);
    expect(history[0]!.cpuMsPerTestFile).toBeGreaterThan(0);
    // THE PRE-LAUNCH SNAPSHOT RIDES IN THE SAME ROW — the 5- and 15-minute
    // legs beside the 1-minute ambient the row already carried. The
    // saturation ghost is a 15-minute phenomenon the 1-minute sample decays
    // away (measured: "quiet" 1-minute contexts recorded while the
    // 15-minute averages read 2.4-4.1), and the row is where the next
    // investigation must read it from — not tracker prose. Real loadavg
    // readings are finite and non-negative; a field dropped at the append
    // site reads undefined here and reds.
    expect(history[0]!.ambientLoadPerCpu).toBeGreaterThanOrEqual(0);
    expect(history[0]!.ambientLoad5PerCpu).toBeGreaterThanOrEqual(0);
    expect(history[0]!.ambientLoad15PerCpu).toBeGreaterThanOrEqual(0);
    // The summary carries the same triple — the row's figures derive from
    // the verdict, which reads them from the summary, so a summary field
    // dropped at the write is caught one step earlier.
    const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as Record<string, unknown>;
    expect(typeof summary.load5PerCpuAtStart).toBe("number");
    expect(typeof summary.load15PerCpuAtStart).toBe("number");
    // And the summary landed at the OVERRIDDEN path — the live artifact
    // was never this test's to write.
    expect(existsSync(summaryPath)).toBe(true);

    // WITNESS (§36): the capture must have caught the very line that used to
    // escape. "Nothing reached the real stdout" and "the reporter printed
    // nothing at all" are the same silence, and only a captured line separates
    // them — so the refusal's own words are required to be HERE.
    const captured = printed.join("");
    expect(
      captured,
      "the refused run printed no NOT JUDGED line, so this capture proves nothing about what " +
        "would otherwise have reached the real stdout",
    ).toContain("[runtime-budget]");
    expect(captured).toContain("NOT JUDGED");
    expect(captured).toContain("3 test");
    // THE STANDING BASELINE LINE IS PART OF THE RUN'S OWN OUTPUT: the judged
    // run (the second reporter above) must print the rolling baseline it
    // judged by, with the derivation's evidence — a reporter that derived
    // the cap and said nothing would be the silent-climb shape the whole
    // disclosure exists to prevent, and every unit arm would stay green.
    expect(
      captured,
      "the judged run printed no baseline line — the rolling baseline judged the run without " +
        "being said",
    ).toContain("[runtime-budget] baseline:");
    expect(captured).toContain("clean judged run");

    // …and the real run's exit code was never this fixture's to touch.
    expect(process.exitCode).toBe(exitBefore);
  });

  test("THE PERF BUDGETS REACH THE RUN AND THE LEDGER (correctness B-N2): a profile report over a budget FAILS the run by its gate, and the row records every measurement the ledger judge compares", () => {
    const dir = createTempDir("reporter-perf-");
    const cacheDir = join(dir, "cache");
    mkdirSync(cacheDir);
    const full = fullRunModuleCount();
    const past = (Date.now() - 60_000) / 1000;
    for (let i = 0; i < full + 10; i++) {
      const p = join(cacheDir, `entry-${String(i)}`);
      writeFileSync(p, "x");
      utimesSync(p, past, past);
    }
    // The planted report breaches the API budget (1,926 ms against 250).
    const report = join(dir, "report.json");
    writeFileSync(report, JSON.stringify(plantedReport({ treeIdentity: { headSha: "0".repeat(40), dirty: false, measuredSurfaceHash: readMeasuredSurfaceHash(reporterRepository()) } })));
    const exits: number[] = [];
    const reporter = new BudgetReporter({
      summaryPath: join(dir, "summary.json"), historyPath: join(dir, "history.json"), cacheDir, repositoryRoot: reporterRepository(),
      out: () => undefined, err: () => undefined, instrumentLockPath: heldInstrumentLock(), performanceReportPath: report, setExitCode: (code) => { exits.push(code); },
    });
    reporter.onInit();
    reporter.onTestRunEnd(fakeModules(full), [], "passed");
    expect(exits, "a breached perf budget fails the run").toContain(1);
    const raw = JSON.parse(readFileSync(join(dir, "history.json"), "utf8")) as { runs: Record<string, unknown>[] };
    const outcomes = (raw.runs[0]!["qualification"] as { outcomes: { gate: string; kind: string }[] }).outcomes;
    expect(outcomes.find((outcome) => outcome.gate === "performance:apiResponseMaxMs")?.kind, "the breach is its own gate's fail").toBe("fail");
    expect((raw.runs[0]![ROOT_POLICY.workflow.webPerformanceBudgets.ledgerField] as Record<string, number>)["apiResponseMaxMs"], "the row records the measurement the ledger judge compares").toBe(1926);
  });

  test("a judged run's PER-TEST FAILURE ROWS land in its ledger record — the flaky memory's substrate", () => {
    const dir = createTempDir("reporter-failures-");
    const summaryPath = join(dir, "summary.json");
    const historyPath = join(dir, "history.json");
    const cacheDir = join(dir, "cache");
    mkdirSync(cacheDir);
    const full = fullRunModuleCount();
    const past = (Date.now() - 60_000) / 1000;
    for (let i = 0; i < full + 10; i++) {
      const p = join(cacheDir, `entry-${String(i)}`);
      writeFileSync(p, "x");
      utimesSync(p, past, past);
    }

    // One module carries a mixed collection: two failures (which must be
    // recorded, with file and full name), a pass and a skip (which must
    // not), and a case whose result cannot be read (which must not throw
    // the run down with it).
    const cases = [
      { fullName: "suite > flakes sometimes", result: () => ({ state: "failed" }) },
      { fullName: "suite > passes always", result: () => ({ state: "passed" }) },
      { fullName: "suite > skipped out", result: () => ({ state: "skipped" }) },
      { fullName: "suite > second flake", result: () => ({ state: "failed" }) },
      {
        fullName: "suite > unreadable",
        result: () => {
          throw new Error("no result");
        },
      },
    ];
    const modules = [
      ...Array.from({ length: full - 1 }, (_, i) => ({
        moduleId: `tests/fake/${String(i)}.test.ts`,
        diagnostic: () => ({ collectDuration: 0, duration: 1 }),
      })),
      {
        moduleId: `${process.cwd()}/tests/fake/flaky.test.ts`,
        children: { allTests: () => cases },
        diagnostic: () => ({ collectDuration: 0, duration: 1 }),
      },
    ];

    const harness = {
      summaryPath,
      historyPath,
      cacheDir,
      repositoryRoot: reporterRepository(),
      out: () => undefined,
      err: () => undefined,
      instrumentLockPath: heldInstrumentLock(), performanceReportPath: ABSENT_PROFILE_REPORT, setExitCode: () => undefined,
    } as const;
    const reporter = new BudgetReporter(harness);
    reporter.onInit();
    reporter.onTestRunEnd(modules, [], "failed");

    const raw = JSON.parse(readFileSync(historyPath, "utf8")) as { runs: Record<string, unknown>[] };
    expect(raw.runs).toHaveLength(1);
    // The rows, exactly: file + full name, failures only, in run order. The
    // assertion is on the RAW ledger bytes rather than a parsed view, so a
    // writer that strips the field on rewrite fails here.
    expect(raw.runs[0]!["failures"]).toEqual([
      "tests/fake/flaky.test.ts::suite > flakes sometimes",
      "tests/fake/flaky.test.ts::suite > second flake",
    ]);
  });

  test("a measured run that did not hold the host's instrument lock is REFUSED: failed, said, and not recorded (engine/src/process/instrument-lock.ts)", () => {
    const dir = createTempDir("reporter-unslotted-");
    const historyPath = join(dir, "history.json");
    const errors: string[] = [];
    const exits: number[] = [];
    const full = fullRunModuleCount();
    const modules = Array.from({ length: full }, (_, i) => ({
      moduleId: `tests/fake/${String(i)}.test.ts`,
      diagnostic: () => ({ collectDuration: 0, duration: 1 }),
    }));
    const reporter = new BudgetReporter({
      summaryPath: join(dir, "summary.json"), historyPath, cacheDir: dir, repositoryRoot: reporterRepository(),
      instrumentLockPath: join(dir, "no-holder.lock"), performanceReportPath: ABSENT_PROFILE_REPORT, out: () => undefined, err: (chunk) => { errors.push(chunk); }, setExitCode: (code) => { exits.push(code); },
    });
    reporter.onInit();
    reporter.onTestRunEnd(modules, [], "passed");
    expect(errors.join("")).toMatch(/cpu-per-test-file REFUSED: this run did not hold the host's instrument lock/u);
    expect(exits).toContain(1);
    expect(existsSync(historyPath), "an unslotted measurement is not recorded").toBe(false);
  });

  test("a judged run's record carries the PROVISIONAL marker when the measured tree is tracked-dirty, and not when clean", () => {
    // The live wiring, driven through the reporter's judged path against a
    // temp ledger: the row's provisional flag must AGREE with the tree the
    // run actually measured (`readTrackedTreeDirty` of the harness's
    // repository). This is the reporter's own append site — the place the
    // flaky memory's baseline is written — so it catches a reporter that
    // stops spreading the mark (compute-then-discard) with the tree in BOTH
    // states, each driven here: clean, the marker is absent (never a
    // `false` literal); after a tracked edit, `provisionalFailures: true`.
    const repository = createTempGitRepo("reporter-provisional-tree-");
    writeFileSync(join(repository.dir, "tracked.txt"), "committed\n");
    repository.git("add", "tracked.txt");
    repository.git("commit", "-q", "-m", "fixture");
    const recorded = (): unknown => {
      const dir = createTempDir("reporter-provisional-");
      const historyPath = join(dir, "history.json");
      const cacheDir = join(dir, "cache");
      mkdirSync(cacheDir);
      const full = fullRunModuleCount();
      const past = (Date.now() - 60_000) / 1000;
      for (let i = 0; i < full + 10; i++) {
        const p = join(cacheDir, `entry-${String(i)}`);
        writeFileSync(p, "x");
        utimesSync(p, past, past);
      }
      const modules = fakeModules(full);
      const reporter = new BudgetReporter({
        summaryPath: join(dir, "summary.json"), historyPath, cacheDir, repositoryRoot: repository.dir,
        out: () => undefined, err: () => undefined, instrumentLockPath: heldInstrumentLock(), performanceReportPath: ABSENT_PROFILE_REPORT, setExitCode: () => undefined,
      });
      reporter.onInit();
      reporter.onTestRunStart(modules.map((module) => ({ taskId: module.id, moduleId: module.moduleId })));
      reporter.onTestRunEnd(modules, [], "passed");
      const raw = JSON.parse(readFileSync(historyPath, "utf8")) as { runs: Record<string, unknown>[] };
      expect(raw.runs).toHaveLength(1);
      return raw.runs[0]!["provisionalFailures"];
    };
    expect(readTrackedTreeDirty(repository.dir)).not.toBe(true);
    expect(recorded(), "a committed tree's row carries no provisional marker").toBeUndefined();
    writeFileSync(join(repository.dir, "tracked.txt"), "a mid-edit change\n");
    expect(readTrackedTreeDirty(repository.dir)).toBe(true);
    expect(recorded(), "a tracked-dirty tree's row is provisional").toBe(true);
  });

  test.each(["case", "module", "suite", "global"] as const)("C3: %s error observation preserves valid diagnostics and refuses malformed entries", (channel) => {
    const dir = createTempDir("reporter-error-census-");
    const cacheDir = join(dir, "cache");
    mkdirSync(cacheDir);
    const full = fullRunModuleCount();
    const past = (Date.now() - 60_000) / 1000;
    for (let i = 0; i < full + 10; i += 1) {
      const entry = join(cacheDir, `entry-${String(i)}`);
      writeFileSync(entry, "x");
      utimesSync(entry, past, past);
    }
    const inputs = [
      { label: "Error instance with empty message", errors: [new Error("")], complete: true },
      { label: "serialized error without name", errors: [{ message: "error" }], complete: true },
      { label: "null entry", errors: [null], complete: false },
      { label: "missing message", errors: [{}], complete: false },
      { label: "non-string name", errors: [{ message: "error", name: 4 }], complete: false },
      { label: "unreadable message", errors: [{ get message() { throw new Error("unreadable diagnostic"); } }], complete: false },
      ...(channel === "case" ? [{ label: "legitimately absent case diagnostics", errors: undefined, complete: true }] : []),
    ];
    for (const [index, input] of inputs.entries()) {
      const historyPath = join(dir, `history-${String(index)}.json`);
      const exits: number[] = [];
      const reporter = new BudgetReporter({ summaryPath: join(dir, "summary.json"), historyPath, cacheDir, repositoryRoot: reporterRepository(),
        out: () => undefined, err: () => undefined, instrumentLockPath: heldInstrumentLock(), performanceReportPath: passingProfileReport(), setExitCode: (code) => { exits.push(code); } });
      // Cross the actual external boundary deliberately. Passed cases with
      // valid earlier retry diagnostics stay passed and do not become rows.
      const errors = input.errors as { message: string; name?: string }[] | undefined;
      const modules = fakeModules(full).map((module, moduleIndex) => moduleIndex !== 0 ? module : ({ ...module,
        errors: () => channel === "module" ? errors! : [],
        children: {
          allTests: () => [{ id: "case-0", fullName: "case 0", result: () => ({ state: "passed", ...(channel === "case" && errors !== undefined ? { errors } : {}) }) }],
          allSuites: () => channel === "suite" ? [{ id: "suite-0", fullName: "nested", state: () => "passed", errors: () => errors! }] : [],
        },
      }));
      reporter.onInit();
      reporter.onTestRunStart(modules.map((module) => ({ taskId: module.id, moduleId: module.moduleId })));
      expect(() => reporter.onTestRunEnd(modules, channel === "global" ? errors! : [], channel === "case" ? "passed" : "failed"), input.label).not.toThrow();
      const row = (JSON.parse(readFileSync(historyPath, "utf8")) as { runs: {
        failures: string[]; qualification: { producerComplete: boolean; outcomes: { gate: string; kind: string }[] };
      }[] }).runs[0]!;
      expect(row.qualification.producerComplete, input.label).toBe(input.complete);
      expect(exits.includes(1), input.label).toBe(channel !== "case" || !input.complete);
      if (channel === "case") expect(row.failures, "retry diagnostics never manufacture failed cases").toEqual([]);
      if (!input.complete) expect(row.qualification.outcomes, input.label).toEqual(expect.arrayContaining([
        expect.objectContaining({ gate: channel === "global" ? "runner-terminal" : "test-results", kind: "fail" }),
      ]));
    }
  });

  test("C3: malformed reporter module errors must publish an explicit incomplete result instead of escaping the hook", () => {
    for (const malformed of [false, true]) {
      const dir = createTempDir("reporter-error-entry-");
      const historyPath = join(dir, "history.json");
      const cacheDir = join(dir, "cache");
      mkdirSync(cacheDir);
      const full = fullRunModuleCount();
      const past = (Date.now() - 60_000) / 1000;
      for (let i = 0; i < full + 10; i += 1) {
        const entry = join(cacheDir, `entry-${String(i)}`);
        writeFileSync(entry, "x");
        utimesSync(entry, past, past);
      }
      const exits: number[] = [];
      const reporter = new BudgetReporter({ summaryPath: join(dir, "summary.json"), historyPath, cacheDir, repositoryRoot: reporterRepository(),
        out: () => undefined, err: () => undefined, instrumentLockPath: heldInstrumentLock(), performanceReportPath: ABSENT_PROFILE_REPORT, setExitCode: (code) => { exits.push(code); } });
      const modules = fakeModules(full).map((module, index) => ({ ...module,
        state: () => index === 0 ? "failed" : "passed",
        // Deliberately cross the typed external boundary with one malformed
        // array element. The public reporter must preserve an honest result.
        errors: () => index !== 0 ? [] : malformed ? [null] as unknown as { message: string }[] : [{ message: "module hook failed" }],
      }));
      reporter.onInit();
      reporter.onTestRunStart(modules.map((module) => ({ taskId: module.id, moduleId: module.moduleId })));
      let threw = false;
      try { reporter.onTestRunEnd(modules, [], "failed"); }
      catch { threw = true; }
      const published = existsSync(historyPath);
      const record = published ? (JSON.parse(readFileSync(historyPath, "utf8")) as { runs: {
        qualification?: { producerComplete: boolean; outcomes: { gate: string; kind: string }[] };
      }[] }).runs[0]?.qualification : undefined;
      expect({ threw, published, producerFailed: exits.includes(1), complete: record?.producerComplete ?? null,
        resultFailure: record?.outcomes.some((outcome) => outcome.gate === "test-results" && outcome.kind === "fail") ?? null },
      malformed ? "malformed module error must retain explicit publication/refusal" : "matched ordinary module error must remain accounted").toEqual({
        threw: false, published: true, producerFailed: true, complete: !malformed, resultFailure: malformed,
      });
    }
  });

});

describe("failuresOf — the per-test extraction, driven against planted collections", () => {
  // The measurement itself, driven directly (the compute-then-discard mutant
  // of this function is the wired-but-inert shape: the append above stays
  // green while every ledger record carries an empty rows array).
  test("failures only, with file and full name; passes, skips and nameless cases are not rows", () => {
    const modules = [
      {
        moduleId: `${process.cwd()}/tests/a/one.test.ts`,
        children: {
          allTests: () => [
            { fullName: "s > fails", result: () => ({ state: "failed" }) },
            { fullName: "s > passes", result: () => ({ state: "passed" }) },
            { fullName: "s > pending", result: () => ({ state: "pending" }) },
            { fullName: "s > skipped", result: () => ({ state: "skipped" }) },
            { fullName: "s > also fails", result: () => ({ state: "failed" }) },
            { fullName: "", result: () => ({ state: "failed" }) },
            { result: () => ({ state: "failed" }) },
          ],
        },
      },
      // A module with no children at all — the fixture shape the append tests
      // drive — contributes no rows, and is not read as "every test passed".
      { moduleId: `${process.cwd()}/tests/a/two.test.ts`, diagnostic: () => ({ duration: 1 }) },
    ];
    expect(failuresOf(modules, process.cwd()).rows).toEqual([
      "tests/a/one.test.ts::s > fails",
      "tests/a/one.test.ts::s > also fails",
    ]);
  });

  test("a result() that throws retains other rows and makes the current census incomplete", () => {
    const modules = [
      {
        moduleId: `${process.cwd()}/tests/a/three.test.ts`,
        children: {
          allTests: () => [
            {
              fullName: "s > throws",
              result: () => {
                throw new Error("unsettled");
              },
            },
            { fullName: "s > fails honestly", result: () => ({ state: "failed" }) },
          ],
        },
      },
    ];
    const observed = failuresOf(modules, process.cwd());
    expect(observed.rows).toEqual(["tests/a/three.test.ts::s > fails honestly"]);
    expect(observed.complete).toBe(false);
    expect(observed.outcomes.some((outcome) => outcome.kind === "fail")).toBe(true);
  });

  test("a module that FAILED WITH NO FAILED CASE (collection error, a hook) is one module row; a failed case never adds one (a whole red file is compared like a case)", () => {
    const at = (name: string) => `${process.cwd()}/tests/a/${name}.test.ts`;
    const modules = [
      // Collection failed: no cases at all, the module failed with an error.
      { moduleId: at("collect"), children: { allTests: () => [] }, state: () => "failed", errors: () => [{ name: "SyntaxError", message: "Unexpected token at 12:4" }] },
      // beforeAll threw: every case is skipped, the module failed.
      { moduleId: at("hook"), children: { allTests: () => [{ fullName: "s > never ran", result: () => ({ state: "skipped" }) }] }, state: () => "failed", errors: () => [] },
      // A failed case carries the module's failure: no second row.
      { moduleId: at("case"), children: { allTests: () => [{ fullName: "s > fails", result: () => ({ state: "failed" }) }] }, state: () => "failed" },
      // A passing module and a module whose state cannot be read add nothing.
      { moduleId: at("pass"), children: { allTests: () => [] }, state: () => "passed", errors: () => [] },
      { moduleId: at("unreadable"), state: () => { throw new Error("unsettled"); } },
    ];
    expect(failuresOf(modules, process.cwd()).rows).toEqual([
      `tests/a/collect.test.ts::${MODULE_FAILURE_ROW}`,
      `tests/a/hook.test.ts::${MODULE_FAILURE_ROW}`,
      "tests/a/case.test.ts::s > fails",
    ]);
  });

  test("retried-passed errors and expected web skips keep a complete non-failing census", () => {
    const observed = failuresOf([{
      id: "complete-module", moduleId: `${process.cwd()}/tests/a/complete.test.ts`, state: () => "passed", errors: () => [],
      children: { allSuites: () => [], allTests: () => [
        { id: "retried", fullName: "retried then passed", result: () => ({ state: "passed", errors: [{ message: "earlier retry" }] }) },
        { id: "skipped", fullName: "declared skip", result: () => ({ state: "skipped" }) },
      ] },
    }], process.cwd());
    expect(observed.complete).toBe(true);
    expect(observed.rows).toEqual([]);
    expect(observed.outcomes.every((outcome) => outcome.kind !== "fail")).toBe(true);
    expect(observed.outcomes.at(-1)?.message).toContain("1 skipped under the existing web skip policy");
  });

  test("each failure's digest masks the numbers that move between runs; a different message is a different digest", () => {
    const one = (message: string) => failuresOf([{
      moduleId: `${process.cwd()}/tests/a/d.test.ts`,
      children: { allTests: () => [{ fullName: "s > f", result: () => ({ state: "failed", errors: [{ name: "AssertionError", message }] }) }] },
    }], process.cwd()).digests["tests/a/d.test.ts::s > f"];
    expect(one("took 1200ms on port 51234")).toBe(one("took 87ms on port 40001"));
    expect(one("1 offender: a.ts")).not.toBe(one("3 offenders: a.ts, b.ts, c.ts"));
    expect(one("x")).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ── THE PERFORMANCE BUDGETS IN THE ONE BUDGET JUDGEMENT (scripts/testing/performance-measurements.ts): what the
// profile measured per budget, and the reporter's judgement of a run (UR-16, UR-24). ──

const PERF_ROOT = process.cwd();

/** A report every budget can read, with the readings the test names. */
function plantedReport(over: Readonly<Record<string, unknown>> = {}): ProfileReport {
  return {
    instrumentLock: "held",
    treeIdentity: { headSha: "0".repeat(40), dirty: false, measuredSurfaceHash: readMeasuredSurfaceHash(PERF_ROOT) },
    pageLoad: { lcp: 600, cls: 0.05, longTaskWorstMs: 80, longTaskTotalMs: 200 },
    tabs: [{ name: "a", ok: true, switchMs: 90, domNodes: 900 }, { name: "b", ok: true, switchMs: 120, domNodes: 1100 }],
    interactiveElements: [{ ok: true, clickMs: 140, longTaskWorstMs: 95 }],
    interactions: [{ name: "chat-input-typing", kind: "latency", ok: true, durationMs: 30 }, { name: "scroll", kind: "scroll-long-task", ok: true, longTaskWorstMs: 60 }],
    networkSummary: { totalCalls: 5, maxResponseMs: 1926 },
    routeProfiles: [{ ok: true, responseMs: 316 }, { ok: true, responseMs: 747 }, { ok: false, responseMs: 9999 }],
    routeSummary: { slowest: { responseMs: 747 } },
    longSession: { heapGrowthMb: 4, domNodeGrowth: 30 },
    realData: { longChat: { ok: true, renderMs: 900, scroll: { ok: true, longTaskWorstMs: 70 } }, manyProjects: { ok: true, renderMs: 1500 } },
    viewports: [{ lcp: 700 }, { lcp: 1100 }],
    ...over,
  } as unknown as ProfileReport;
}

describe("what the profile measured, per budget", () => {
  test("every budget the policy lists is read; a shared budget takes the worst of its readings", () => {
    const measured = performanceMeasurements(plantedReport());
    expect(Object.keys(measured).sort()).toEqual(Object.keys(ROOT_POLICY.workflow.webPerformanceBudgets.kinds).sort());
    expect(measured.apiResponseMaxMs, "the in-session slowest, every isolated route, the slowest discovered: the worst").toBe(1926);
    expect(measured.tabSwitchMaxMs, "a tab switch and an element click share the interaction budget").toBe(140);
    expect(measured.longTaskWorstMaxMs, "the page load, every click, every scroll census").toBe(95);
    expect(measured.viewportLcpMaxMs).toBe(1100);
    expect(measured.lcpMaxMs).toBe(600);
  });

  test("an unmeasured reading leaves its budget unmeasured (null), never a number a budget could pass", () => {
    expect(performanceMeasurements(plantedReport({ pageLoad: { lcp: null, cls: 0, longTaskWorstMs: 1, longTaskTotalMs: 1 } })).lcpMaxMs).toBeNull();
    expect(performanceMeasurements(plantedReport({ viewports: [{ lcp: 700 }, { lcp: null }] })).viewportLcpMaxMs).toBeNull();
    expect(performanceMeasurements(plantedReport({ viewports: [] })).viewportLcpMaxMs, "an empty population measured nothing").toBeNull();
    expect(performanceMeasurements(plantedReport({ tabs: [{ name: "a", ok: false, switchMs: 1, domNodes: 1 }] })).tabSwitchMaxMs, "a refused tab").toBeNull();
    expect(performanceMeasurements(plantedReport({ realData: { longChat: { ok: false, renderMs: 0, scroll: { ok: false } }, manyProjects: { ok: true, renderMs: 0 } } })).longChatRenderMaxMs).toBeNull();
  });
});

describe("the reporter's judgement of a run", () => {
  const budget = { lcpMaxMs: 2500, clsMax: 0.12, longTaskWorstMaxMs: 100, longTaskTotalMaxMs: 500, tabSwitchMaxMs: 300, tabDomNodesMax: 1500, typingMeanMaxMs: 60, apiResponseMaxMs: 250, longSessionHeapGrowthMaxMb: 10, longSessionDomGrowthMax: 500, longChatRenderMaxMs: 2000, manyProjectsRenderMaxMs: 2000, viewportLcpMaxMs: 2000 };
  const at = (report: unknown): string => {
    const path = join(createTempDir("perf-judgement-"), "report.json");
    writeFileSync(path, JSON.stringify(report));
    return path;
  };

  test("a report it cannot judge FAILS the run by name, with why — absent, unslotted, of other code — and records nothing (an unmeasured budget is never a pass: design M-A)", () => {
    for (const [path, why] of [
      [join(createTempDir("perf-judgement-absent-"), "none.json"), /no profile report/u],
      [at({ ...plantedReport(), instrumentLock: "unslotted" }), /outside the host's instrument lock/u],
      [at({ ...plantedReport(), treeIdentity: { headSha: "0".repeat(40), dirty: false, measuredSurfaceHash: "f".repeat(64) } }), /describes other code/u],
    ] as const) {
      const judged = judgePerformanceBudgets(PERF_ROOT, path, budget);
      expect(judged.measurements).toBeUndefined();
      expect(judged.outcomes).toHaveLength(1);
      expect(judged.outcomes[0]).toMatchObject({ gate: "performance-report", kind: "fail" });
      expect(judged.outcomes[0]!.message).toMatch(why);
    }
  });

  test("a judged report fails each breach and each unmeasured budget by its gate, passes the rest, and records every measurement", () => {
    const judged = judgePerformanceBudgets(PERF_ROOT, at(plantedReport({ viewports: [{ lcp: null }] })), budget);
    const kinds = Object.fromEntries(judged.outcomes.map((outcome) => [outcome.gate, outcome.kind]));
    expect(kinds[performanceGate("apiResponseMaxMs")]).toBe("fail");
    expect(kinds[performanceGate("viewportLcpMaxMs")], "unmeasured is a failure, never a pass").toBe("fail");
    expect(kinds[performanceGate("lcpMaxMs")]).toBe("pass");
    expect(judged.outcomes.find((outcome) => outcome.gate === performanceGate("apiResponseMaxMs"))!.message).toMatch(/1926 exceeds the budget 250/u);
    expect(judged.measurements?.apiResponseMaxMs).toBe(1926);
    // Every gate is one the workspace's ledger judge holds: the ONE budget judgement.
    for (const outcome of judged.outcomes) expect(ROOT_POLICY.workflow.failureOwners.budgets.web, outcome.gate).toHaveProperty([outcome.gate]);
  });
});
