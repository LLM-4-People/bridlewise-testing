// @vitest-environment node
/**
 * Web-UI test-runtime budget.
 *
 * THIS FILE JUDGES THE TREE. THE REPORTER JUDGES THE RUN.
 *
 * ── THE ONE-RUN LAG IS GONE, AND IT WAS NOT REMOVED BY BEING FIXED ───────
 *
 * Three gates used to live here — CPU per test file, the collect-tail share,
 * and the per-file pool share — and all three judged the PREVIOUS run,
 * because a test executes inside the run it would be measuring and the
 * summary it can read is the one written at the end of the run before. Every
 * message therefore had to name which run was on trial. That was honest and
 * it was still a defect: **the same tree passed or failed depending on what
 * had run before it**, and the run being judged had already been overwritten
 * by the time anyone went to look.
 *
 * The lag could not be closed by handing this file better data. The three
 * quantities are a MAXIMUM and two TOTALS over all 466 modules, and at the
 * moment this file's bodies execute, the modules scheduled after it have not
 * been collected. Any channel from the reporter to a test can only deliver
 * partial figures — all of them smaller than the truth, all of them in the
 * permissive direction, silently.
 *
 * So the judge moved out of the subject: `tests/reporters/budget-reporter.ts`
 * judges the run it is ending, at the first moment those numbers exist and
 * the last moment the run is still alive, and fails it. The reporter rather
 * than `scripts/run-tests.ts` because the reporter is named in
 * `vitest.config.ts` and therefore loads on every invocation — `npm test`,
 * `npm run test:raw`, a bare `npx vitest run`, watch — while the watchdog is
 * reachable only through the first of those.
 *
 * What is left here has no run in it at all: the suite's POPULATION, the
 * declared budget's shape, and the ranges the caps must sit in. Those are
 * properties of the tree, they are the same on every invocation, and nothing
 * about them lags.
 *
 * ── WHY THIS TEST COULD NOT PASS RELIABLY, AND WHAT WAS ACTUALLY WRONG ────
 *
 * The suite's wall clock was bimodal — roughly 31s or roughly 43s — with the
 * budget at 35s sitting between the two modes. So the test was a coin flip on
 * which mode the machine landed in. Raising the number would have moved the
 * coin flip rather than removing it, and a budget satisfiable by editing the
 * budget guards nothing.
 *
 * Two real causes were found and fixed, and both are worth keeping:
 *
 * **1. A 15s serial tail the scheduler could not see.** Vitest orders test
 * files by their TEST duration. `no-unused-exports.test.ts` reported
 * `tests: 14ms` while spending **15.41s importing** — it re-read and
 * re-regexed the whole codebase once per candidate export name, at module
 * scope. Reporting 14ms, it was sorted to the END of the run, where its 15s
 * had nothing left to overlap with: every other file finished by **+26.9s**,
 * the run ended at **+41.5s**. Absorbed → ~31s; exposed → ~43s. That gap IS
 * the two modes. Fixed by answering the same question with one pass and an
 * index (15.5s → 428ms), with the equivalence asserted separately in
 * `no-unused-exports-index.test.ts`.
 *
 * **2. A statSync storm in test setup.** `createWorkerTempDir` reclaimed
 * stale stores by walking the whole system temp root and stat-ing every match
 * — 30.5ms per call at a realistic residue, once per test FILE, **12.7s per
 * run and growing**. The suite's `setup` phase fell 33.4s → 15.3s when that
 * was fixed.
 *
 * Together: **42.7s → 28.2s**, measured on the same tree minutes apart.
 *
 * ── AND THEN THE GATE ITSELF WAS THE DEFECT ──────────────────────────────
 *
 * After both fixes the gate went on failing, and by then it was failing on
 * nothing. It compared an ABSOLUTE wall clock against an ABSOLUTE cap that
 * had been measured when the suite held **433** files; the suite reached
 * **451** and the cap did not move. It became the sole red in three
 * consecutive steps, each time with no regression behind it, while its own
 * message said *"Fix the regression — do not raise the budget to meet it"* —
 * correct advice that the gate had made impossible to follow, since the only
 * way to silence it was the one thing it forbade.
 *
 * The normalising input was already in its hands and thrown away: it PRINTED
 * `ambient load ${load1PerCpuAtStart}/cpu` and then judged absolutely. That
 * is the wired-but-inert shape, inside a guard.
 *
 * **But dividing by that load would not have worked either, and the
 * measurement matters more than the diagnosis** — see the header of
 * `tests/helpers/budget-verdict.ts`. The recorded load is a decaying
 * one-minute average sampled before the run starts, so a genuinely contended
 * run and an idle run right after a previous suite both record ~0.6/cpu.
 * Wall-clock occupancy is no better; it inflated 71% under real contention.
 * **CPU inflated 2.6%.** So this gate judges the run's CPU cost per test
 * file, and the wall clock is reported on every run and judged on none.
 *
 * ── THE THREE WAYS THIS GUARD USED TO PROVE NOTHING ──────────────────────
 *
 * **A SUBSET RUN DISARMED IT SILENTLY.** Any `npx vitest run <one-file>`
 * invokes the reporter and overwrote the summary with that file's duration.
 * Proved directly: after a single-file run the summary read
 * `{"wallClockMs":174}`, and the next FULL run compared 174ms against 35,000ms
 * and passed — the guard was off and nothing said so. A summary that did not
 * cover the suite is now REFUSED as evidence rather than believed.
 *
 * **IT GATED ON THE SYMPTOM, NOT THE CAUSE.** A wall clock says a tail
 * appeared; it does not say a file grew an invisible one. The collect-time
 * gate below is the guard against the cause, and it is the one that fails
 * FIRST and by name when the defect recurs.
 *
 * **AND A REFUSAL WAS SCORED AS A PASS.** Three tests here `return`ed on
 * `unmeasurable`, which vitest counts as green — so "the suite is within
 * budget" and "there was no evidence to look at" reported the identical
 * colour. Now that those three live in the reporter, a refusal is PRINTED by
 * name on every run: `NOT JUDGED — <reason>`, on its own line, beside the
 * provenance line and the cache reading.
 *
 * Refusal is a real verdict, not a skip of convenience: it names what was
 * missing (DESIGN-PERFORMANCE L3 — absence is stated, never rendered as
 * emptiness) and it is itself tested, in `web-ui-runtime-budget-verdict.test.ts`.
 */
import { describe, test, expect } from "vitest";
import { globSync, readFileSync } from "node:fs";
import {
  BUDGET_POPULATION_ARM,
  judgePopulationDrift,
  COLD_MODULE_CACHE_FRACTION,
  MIN_COVERAGE_FRACTION,
} from "../helpers/budget-verdict.ts";
import {
  readCpuBudget,
  readFileShareMax,
  fullRunGlobs,
  fullRunModuleCount,
} from "../helpers/budget-config.ts";
import { HISTORY_KEPT } from "../helpers/budget-history.ts";
import { modulePath } from "../helpers/module-resolver.ts";
import { read, stripCommentsOnly } from "../helpers/source-scan.ts";

describe("web-UI test-runtime budget", () => {
  const cpuBudget = readCpuBudget();
  const fileShareMax = readFileShareMax();
  const discovered = fullRunModuleCount();

  test("the run-cost gates are wired where EVERY invocation passes through", () => {
    // WITHOUT THIS, DELETING THE ENFORCEMENT IS A GREEN RUN. The three gates
    // that judge a run's cost now live in the reporter, because that is the
    // only place the totals exist — and a reporter that stopped judging would
    // look exactly like a suite that had nothing to complain about. So the
    // wiring is asserted from the config the runner actually loads, through to
    // the two things the reporter must do with what it measures.
    //
    // Read through `stripCommentsOnly`, so a mention in prose — including the
    // prose in this very file — cannot satisfy it.
    const config = stripCommentsOnly(read("vitest.config.ts"));
    const reporterPaths = [...config.matchAll(/"(\.\/tests\/reporters\/[^"]+\.ts)"/g)].map(
      (m) => m[1]!,
    );
    expect(
      reporterPaths,
      "vitest.config.ts names no reporter under tests/reporters — the run-cost gates are " +
        "loaded by nothing and every run is unjudged",
    ).not.toEqual([]);
    const judging = reporterPaths.filter((rel) => {
      const src = stripCommentsOnly(read(rel.replace(/^\.\//, "")));
      // THE EXIT CODE MUST BE DOWNSTREAM OF THE FAILURES, and that ordering is
      // the whole assertion. A first draft asked only that the file mention
      // `process.exitCode = 1` somewhere, and deleting the line on the failure
      // path SURVIVED — the reporter also raises the code when the gate itself
      // cannot run, and that earlier occurrence satisfied the match. A guard
      // that a mutation walks through is a guard that has told you nothing.
      //
      // AND THE INDIRECTION IS FOLLOWED, NOT ASSUMED AWAY. This arm broke on a
      // CORRECT change: the reporter's writes moved behind injectable sinks so
      // a test could stop printing the gate's exact bytes onto the real run's
      // stdout, `process.exitCode = 1` became `this.fail(1)`, and a guard keyed
      // to a spelling went red on the repair. Adding the new spelling beside
      // the old one is what this project has already done three times in one
      // file, and it is why it recurred. So the failure branch's raiser is
      // READ OUT of the source and its own binding is then required to reach
      // `process.exitCode` — one indirection, followed rather than trusted, and
      // a raiser bound to something else is still a red.
      if (!/judgeRunCosts\s*\(/.test(src)) return false;
      const failuresBranch = src.slice(src.search(/\bconst\s+failures\b/u));
      if (failuresBranch.length === 0) return false;
      if (/process\.exitCode\s*=\s*1/u.test(failuresBranch)) return true;
      const raiser = /\bthis\.(?<name>\w+)\s*\(\s*1\s*\)/u.exec(failuresBranch)?.groups?.["name"];
      if (raiser === undefined) return false;
      return new RegExp(`this\\.${raiser}\\s*=[^;]*process\\.exitCode`, "u").test(src);
    });
    expect(
      judging,
      `no reporter in ${reporterPaths.join(", ")} both calls judgeRunCosts and fails the ` +
        `run. A gate that computes a verdict and does not act on it is the wired-but-inert ` +
        `shape this whole mechanism exists to refuse.`,
    ).toHaveLength(1);
  });

  test("THE RUNNER IS HANDED THE BINDING THIS POPULATION IS COUNTED FROM", () => {
    // The one claim `vitest.config.ts`'s SOURCE is the right subject for, and
    // until now it was enforced by nothing. Every guard that asks "which files
    // does a full run cover" imports `TEST_INCLUDE`; the runner covers
    // whatever `test.include` evaluates to. Those are the same set only while
    // the config spreads the constant, and an inline list written beside it
    // would leave every such guard measuring a population the runner does not
    // use — silently, and with the constant still exported and still green.
    //
    // Read as BYTES on purpose: the subject is the config's own text, not its
    // value. Comments are blanked first so this file's own prose cannot
    // satisfy it.
    const config = stripCommentsOnly(readFileSync("vitest.config.ts", "utf8"));
    const includes = [...config.matchAll(/\binclude\s*:\s*\[([^\]]*)\]/g)].map((m) => m[1]!.trim());
    expect(
      includes,
      "vitest.config.ts declares no include: [] at all — the runner's population cannot be read",
    ).not.toEqual([]);
    expect(
      includes,
      `no include: [] in vitest.config.ts spreads TEST_INCLUDE. Found: ${includes.join(" | ")}. ` +
        `A list spelled inline here is a second source of truth for the suite's population, ` +
        `and the guards that count it would go on counting the exported constant.`,
    ).toContain("...TEST_INCLUDE");
    // …and the constant must reach the config from the module that owns it,
    // not be re-declared in the config under the same name.
    expect(config, "vitest.config.ts must import TEST_INCLUDE, not restate it").toMatch(
      /import\s*\{[^}]*\bTEST_INCLUDE\b[^}]*\}\s*from\s*"\.\/tests\/test-include\.ts"/,
    );
  });

  test("the glob that counts a full run is not vacuous", () => {
    // Everything below leans on this number. If the globs stopped matching,
    // every coverage check would pass trivially against a floor of zero.
    expect(
      discovered,
      "test.include matched suspiciously few files — the coverage check would be vacuous",
    ).toBeGreaterThan(300);
  });

  test("the population is counted from test globs, not from whatever include: came first", () => {
    // The count is the base of the budget's declared population, so a glob
    // list that quietly admits a non-test path moves the population without
    // anything having changed about the tests. That happened: an entry
    // reading `./tests/reporters/budget-reporter.ts` was being counted, and
    // the guard reported 452 files for a 451-file suite.
    const globs = fullRunGlobs();
    expect(globs.length).toBeGreaterThan(0);
    for (const glob of globs) {
      expect(glob, `${glob} is not a test-file glob — it is counting something else`).toMatch(
        /\*\.test\.ts$/,
      );
    }
    // And every counted path must itself be a test file, not merely reachable
    // from a glob that happens to end in the right suffix.
    for (const file of globSync([...globs])) {
      expect(file, `${file} entered the population and is not a test file`).toMatch(
        /\.test\.ts$/,
      );
    }
  });

  test("the suite budget is configured, with the population it was derived against", () => {
    // Missing CONFIGURATION is a red, not a skip — unlike missing EVIDENCE.
    // A tree that never stated its budget has a defect in the tree; a run
    // with no summary yet has only an absence of measurement.
    expect("missing" in cpuBudget ? cpuBudget.missing : null).toBeNull();
  });

  // Titled by the budget owner's constant: the measuring tool's eligibility rule finds this arm by name.
  test(BUDGET_POPULATION_ARM, () => {
    if ("missing" in cpuBudget) throw new Error(`the CPU budget is not declared: ${cpuBudget.missing}`);
    const population = judgePopulationDrift(
      {
        derivedAtTestFileCount:
          cpuBudget.derivedAtTestFileCount ??
          ("phase" in cpuBudget ? cpuBudget.legacy?.derivedAtTestFileCount : undefined) ??
          0,
        maxPopulationDriftFraction: cpuBudget.maxPopulationDriftFraction,
      },
      discovered,
      "testExecution.webUiSuiteCpuBudget",
    );
    expect(
      population.kind,
      population.kind === "stale" ? population.why : "",
    ).toBe("current");
  });

  test("the per-file share cap is a real cap, not a formality", () => {
    if (typeof fileShareMax !== "number") throw new Error(`the per-file share cap is not declared: ${fileShareMax.missing}`);
    // A cap at or above 1 would admit a suite that is one file, which is the
    // shape this gate exists to refuse. A gate budget is never raised to
    // pass (UR-17, the retroactive budget audit): the share cap's guard
    // stays at its quarter bound, and a file that outgrows the cap is split
    // or made cheaper, never admitted by a looser cap.
    expect(fileShareMax).toBeGreaterThan(0);
    expect(fileShareMax).toBeLessThan(0.25);
  });

  test("the per-file-pool-share verdict is judged by the config's key, never a literal", () => {
    // THE JUDGING-OWNER BINDING (the gate-greening arm-key precedent): the
    // cap must travel the ONE wired path —
    //   config `testExecution.webUiTestFileCostShareMax`
    //   -> readFileShareMax() (the defaultless reader)
    //   -> the reporter's verdict inputs
    //   -> perFileShareGate's `share <= fileShareMax`
    // — and each hop is bound as BYTES read through stripCommentsOnly, so
    // prose (including this file's own) cannot satisfy a binding. A silent
    // raise — a literal planted anywhere in the chain, the shape the
    // reader's own history records (a 0.05 constant that the config never
    // stated) — reds here even though every fixture would still pass,
    // because the hop that stopped reading the config stopped matching.
    const reporter = stripCommentsOnly(read("tests/reporters/budget-reporter.ts"));
    expect(
      reporter,
      "the reporter must hand the verdict readFileShareMax() — the config's key through its " +
        "defaultless reader; a local constant here is a silent cap the config never stated",
    ).toMatch(/fileShareMax:\s*readFileShareMax\(\)/u);
    const verdict = stripCommentsOnly(read(modulePath("budget-verdict.ts")));
    expect(
      verdict,
      "the verdict must feed the gate the INPUT cap — perFileShareGate(verdict, inputs.fileShareMax) — " +
        "so the config's move is the only move",
    ).toMatch(/perFileShareGate\(\s*verdict,\s*inputs\.fileShareMax\s*\)/u);
    expect(
      verdict,
      "the gate must compare the measured share against the passed cap — `share <= fileShareMax` — " +
        "never a literal; a number here would be a second cap the config cannot see",
    ).toMatch(/share\s*<=\s*fileShareMax/u);
    const reader = stripCommentsOnly(read("tests/helpers/budget-config.ts"));
    const readerAt = reader.search(/export function readFileShareMax/u);
    expect(
      readerAt,
      "readFileShareMax must exist in tests/helpers/budget-config.ts — the share cap's one reader",
    ).toBeGreaterThanOrEqual(0);
    const readerNext = reader.indexOf("export function", readerAt + 1);
    const readerSlice = reader.slice(readerAt, readerNext === -1 ? undefined : readerNext);
    expect(
      readerSlice,
      "the reader must read the config's own key — testExecution.webUiTestFileCostShareMax",
    ).toContain("webUiTestFileCostShareMax");
    expect(
      readerSlice,
      "the reader must return the CONFIGURED value — a constant return is a cap the config cannot move",
    ).toMatch(/return configured;/u);
  });

  test("the calibrated-work declaration names its unit and its validity bounds", () => {
    if ("missing" in cpuBudget) throw new Error(`the CPU budget is not declared: ${cpuBudget.missing}`);
    // THE UNIT IS PART OF THE BUDGET. A reading in one metric is never
    // compared with a declaration in another; the reporter produces this one.
    expect(cpuBudget.metric).toBe("calibrated-work/v1");
    // The run's own witnesses, bounded: past either the gate DEFERS.
    expect(cpuBudget.calibrationDriftMaxFraction).toBeGreaterThan(0);
    expect(cpuBudget.calibrationDriftMaxFraction).toBeLessThanOrEqual(0.3);
    // The recorded 5-minute load the residual was measured through. Above
    // the measured maximum (1.066/cpu), below the deep-saturation incident
    // (~1.5/cpu) the bound deliberately leaves out.
    expect(cpuBudget.validThroughLoad5PerCpu).toBeGreaterThan(1.648);
    expect(cpuBudget.validThroughLoad5PerCpu).toBeLessThan(2);
    // A drift tolerance at or above the 4.2% growth (433 → 451) that carried
    // the previous cap past its own derivation would admit that same defect.
    expect(cpuBudget.maxPopulationDriftFraction).toBeGreaterThan(0);
    expect(cpuBudget.maxPopulationDriftFraction).toBeLessThan(0.042);
  });

  test("the migration state is DECLARED, and the retired floor is recorded incomparable rather than converted", () => {
    if ("missing" in cpuBudget) throw new Error(`the CPU budget is not declared: ${cpuBudget.missing}`);
    if ("phase" in cpuBudget) {
      // ACCUMULATION: no cap exists, and none is guessed. The retired
      // declaration is a RECORD, not a conversion.
      expect(cpuBudget.phase).toBe("accumulation");
      expect(cpuBudget.minimumJudgedRuns).toBeGreaterThanOrEqual(5);
      const legacy = cpuBudget.legacy;
      expect(legacy, "the retired raw-CPU floor must be recorded, not deleted").toBeDefined();
      expect(legacy?.metric).toBe("raw-cpu-ms/v0");
      expect(legacy?.baselineFloorMsPerTestFile).toBe(1926);
      expect(legacy?.derivedAtTestFileCount).toBe(521);
      expect(legacy?.incomparable).toBe(true);
      // NOTHING RESCALED IT: the new unit's floor is absent until the new
      // window is derived. A number here would be a conversion nobody made.
      expect("baselineFloorUnitsPerTestFile" in cpuBudget).toBe(false);
    } else {
      // ROLLING: the derived shape. Its floor is in the declared unit and
      // its population moves with it or not at all.
      expect(cpuBudget.baselineFloorUnitsPerTestFile).toBeGreaterThan(0);
      expect(cpuBudget.derivedAtTestFileCount).toBeGreaterThan(0);
      expect("legacy" in cpuBudget).toBe(false);
    }
  });

  test("the phase's own knobs are declared inside the ranges their derivations allow, and no streak count is", () => {
    if ("missing" in cpuBudget) throw new Error(`the CPU budget is not declared: ${cpuBudget.missing}`);
    // NO STREAK: the three-consecutive-runs count is deleted, from the parsed
    // budget and from the declaration it was read from.
    expect("overCapRunsBeforeRed" in cpuBudget).toBe(false);
    if ("phase" in cpuBudget) {
      // Accumulation has no feed spread and no window yet: both are
      // ROLLING declarations, and inventing them now would be a cap
      // before the evidence.
      expect("sameTreeSpreadFraction" in cpuBudget).toBe(false);
      expect("baselineWindowRuns" in cpuBudget).toBe(false);
      expect(Number.isInteger(cpuBudget.minimumJudgedRuns)).toBe(true);
      expect(cpuBudget.minimumJudgedRuns).toBeLessThanOrEqual(50);
    } else {
      // The feed spread is a MEASUREMENT (the same-tree run-to-run spread),
      // not a knob: it decides only which ledger readings feed the rolling
      // baseline and the measuring tool's window, and anything at or above
      // 0.08 would let the +6–9% whole-band excursion feed the baseline. It
      // never widens a verdict: one judged run over the cap fails.
      expect(cpuBudget.sameTreeSpreadFraction).toBeGreaterThan(0);
      expect(cpuBudget.sameTreeSpreadFraction).toBeLessThan(0.08);
      // The rolling window: at least 2 (a one-run median is just the last
      // reading — the window would be vacuous), never more than the ledger's
      // own depth.
      expect(cpuBudget.baselineWindowRuns).toBeGreaterThanOrEqual(2);
      expect(cpuBudget.baselineWindowRuns).toBeLessThanOrEqual(HISTORY_KEPT);
    }
  });

  test("the calibrated metric RETIRES the ambient envelope instead of paying the load effect twice", () => {
    if ("missing" in cpuBudget) throw new Error(`the CPU budget is not declared: ${cpuBudget.missing}`);
    if ("phase" in cpuBudget) {
      // The calibration already absorbs the load effect; an ambient
      // envelope on top would double-pay it. The accumulation declaration
      // carries no slope, and the metric's validity bound is the only
      // load-sensitive declaration.
      expect("ambientInflationSlopePerCpu" in cpuBudget).toBe(false);
      expect("ambientInflationCapFraction" in cpuBudget).toBe(false);
    } else {
      // A rolling declaration in the calibrated metric must declare a ZERO
      // slope (no double-pay); the cap may also be zero.
      expect(cpuBudget.ambientInflationSlopePerCpu).toBe(0);
      expect(cpuBudget.ambientInflationCapFraction).toBeGreaterThanOrEqual(0);
      expect(cpuBudget.ambientInflationCapFraction).toBeLessThan(0.21);
    }
  });

  test("the coverage floor is a real floor, not a formality", () => {
    // A fraction near zero would let a two-file run count as a full suite,
    // which is the hole this whole mechanism exists to close.
    expect(MIN_COVERAGE_FRACTION).toBeGreaterThan(0.5);
    expect(MIN_COVERAGE_FRACTION).toBeLessThanOrEqual(1);
  });

  test("the cold-cache fraction sits inside the gap it was measured against", () => {
    // Until this test existed, COLD_MODULE_CACHE_FRACTION was bounded by
    // NOTHING: two occurrences repo-wide, its declaration and its one use.
    // 0.999 (refuse nothing — a cold run judged against a warm cap, the exact
    // red the arm exists to stop) and 0.001 (refuse everything — the gate
    // vacated in the other direction, nothing ever judged) were both silent.
    // Its neighbours MIN_COVERAGE_FRACTION and webUiTestFileCostShareMax both
    // carry range floors; this is that same shape.
    //
    // The bounds are the measurements, not round numbers. POPULATION: the full
    // web suite, 458 modules, 12-core box; `npx vitest run` (warm) and
    // `npx vitest --clearCache && npx vitest run` (cold), both read from
    // `.bridlewise/web-test-results/latest-summary.json`.
    //
    //   warm                     built 0.0000  collect share 0.0368
    //   45% of the cache deleted built 0.4478  collect share 0.0634
    //   COLD                     built 0.9978  collect share 0.1073
    const HIGHEST_STILL_JUDGEABLE = 0.4478;
    const COLDEST_MEASURED = 0.9978;
    expect(Number.isFinite(COLD_MODULE_CACHE_FRACTION)).toBe(true);
    // ABOVE the half-rebuilt run: that run's collect share was 0.0634, well
    // under COLLECT_TAIL_SHARE_MAX, so it is a run this gate must still JUDGE.
    // A fraction at or below it makes the gate refuse runs it can measure.
    expect(COLD_MODULE_CACHE_FRACTION).toBeGreaterThan(HIGHEST_STILL_JUDGEABLE);
    // BELOW the coldest measured run: a fraction at or above it lets a run
    // that rebuilt its entire cache be judged against the warm cap.
    expect(COLD_MODULE_CACHE_FRACTION).toBeLessThan(COLDEST_MEASURED);
  });

});
