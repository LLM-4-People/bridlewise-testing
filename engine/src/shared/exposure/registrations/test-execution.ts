/**
 * Shared exposure registrations — `testExecution` module.
 *
 * The harness's own test machinery: the engine runner's run bounds (how many
 * lanes a phase gets, how long one test may run) and — shown read-only — the
 * CPU budgets the suites' own gates judge by.
 *
 * THE DISPOSITION DOCTRINE (this class's census, tests/prevention/
 * exposure-reachable.test.ts): the section declares 19 leaves. Five are run
 * bounds with contract defaults — the pytest-xdist lane-count class, knobs
 * the operator tunes per machine — and register as writable rows. The nine
 * budget leaves (the web suite's rolling CPU baseline — its recorded floor,
 * its population, its window, the drift tolerance, the noise band and the
 * ratchet count — plus the per-file worker-time share cap, the flaky-test
 * lookback window, and the engine suite's own budget phase) are the gates'
 * OWN verdict numbers: each decides what a green run MEANS, and a settings
 * write that loosened one would silently weaken the verdict — so each is
 * served as a READ-ONLY
 * signal and pinned never-writable, the same doctrine the benchmark budgets
 * and the web performance ceilings follow. The remaining leaves are FILED
 * by the census with their reasons: the `concurrency` union ("auto" | false
 * | a bounded integer) is a value space no scalar sheet row can spell
 * honestly (a number-typed row could write one spelling, and its
 * return-to-default "auto" would fail the row's own validation);
 * `parallelConcurrency`'s designed default is derived from the machine's
 * own parallelism at run time, so a row would present a host-derived number
 * as a contract default; and the compile-cache pruning bounds are
 * default-less BY DESIGN in their consuming owner ("a bound nobody chose is
 * not a bound") — a settings row must declare a default, and the
 * omit-on-default write would prune the key, presenting the file's current
 * choice as the contract's default.
 *
 * THE HONEST TIMING: every row's consumer is a fresh runner process that
 * resolves the pinned config document once per invocation, so a settings
 * write lands in the file and the NEXT test run reads it. The signals read
 * the live config on every poll.
 */

import {
  registerCustomization,
  registerExposureModule,
  registerSignal,
} from "../index.ts";
import { readConfigCustomization, readNumberCustomization, writeConfigCustomization } from "../config-binding.ts";
import {
  DEFAULT_ENGINE_SUITE_WATCHDOG,
  DEFAULT_SERIAL_PHASE_CONCURRENCY,
  DEFAULT_FULL_SUITE_SERIAL_PHASE_CONCURRENCY,
  DEFAULT_FULL_SUITE_IN_PROCESS_SERIAL_PHASE_CONCURRENCY,
  DEFAULT_FULL_SUITE_PARALLEL_CONCURRENCY,
  classCeilingMs,
} from "../../../workflow/workflow-config.ts";

/**
 * The honest absence for the budget readings. These leaves are deliberately
 * default-less in their consuming owners (a budget nobody chose is not a
 * budget), so an absent key is a first-class state the gate reports loudly —
 * the signal states it in words, the same honest-absence contract as a
 * pinned executable the machine has not named.
 */
const NOT_DECLARED = "not declared — the gate that reads it refuses to judge a run until it is measured and set in the config file";

/** Read a leaf that is a number when declared, absent otherwise. */
function readBudgetNumber(path: string): number | undefined {
  const value = readConfigCustomization(path);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The engine suite's watchdog bound as served: the declared value, or — the
 * watchdog has a default, like its sibling per-test kill timeout — the default
 * the runner applies, SAID to be the default.
 */
function engineWatchdogFace(path: string, fallbackMs: number, face: (seconds: string) => string): string {
  const declared = readBudgetNumber(path);
  return declared === undefined ? `not declared — the default applies: ${face(String(fallbackMs / 1000))}` : face(String(declared / 1000));
}

/** A fraction (0..1) rendered as a percentage without float noise. */
function asPercent(fraction: number): string {
  return `${Math.round(fraction * 1000) / 10}%`;
}

const ROWS = [
  {
    id: "serialPhaseConcurrency",
    configPath: "testExecution.serialPhaseConcurrency",
    name: "How many serial-phase tests run at once",
    description:
      "Files that must not run in parallel still run several at a time inside the serial phase. Lower = less interference between them; higher = the serial phase finishes sooner on a big machine. Takes effect on the next test run.",
    default: DEFAULT_SERIAL_PHASE_CONCURRENCY,
    min: 1,
    max: 16,
    unit: "lanes",
  },
  {
    id: "fullSuiteSerialPhaseConcurrency",
    configPath: "testExecution.fullSuiteSerialPhaseConcurrency",
    name: "How many serial-phase tests a full run starts at once",
    description:
      "The full suite's serial phase runs this many files concurrently. Lower = shared resources contend less; higher = the full run's serial tail is shorter. Takes effect on the next full test run.",
    default: DEFAULT_FULL_SUITE_SERIAL_PHASE_CONCURRENCY,
    min: 1,
    max: 16,
    unit: "lanes",
  },
  {
    id: "fullSuiteInProcessSerialPhaseConcurrency",
    configPath: "testExecution.fullSuiteInProcessSerialPhaseConcurrency",
    name: "How many in-process serial tests a full run shares",
    description:
      "Serial files that spawn no subprocess of their own run together in one process, this many at a time. Lower = less memory pressure; higher = the in-process tier drains faster. Takes effect on the next full test run.",
    default: DEFAULT_FULL_SUITE_IN_PROCESS_SERIAL_PHASE_CONCURRENCY,
    min: 1,
    max: 16,
    unit: "lanes",
  },
  {
    id: "fullSuiteParallelConcurrency",
    configPath: "testExecution.fullSuiteParallelConcurrency",
    name: "How many parallel lanes a full suite run uses",
    description:
      "The full suite's parallel phase gets this many worker lanes. Lower = a loaded machine breathes; higher = independent tests finish sooner. Takes effect on the next full test run.",
    default: DEFAULT_FULL_SUITE_PARALLEL_CONCURRENCY,
    min: 1,
    max: 64,
    unit: "lanes",
  },
] as const;

let testExecutionRegistered = false;
export function registerTestExecutionExposure(): void {
  if (testExecutionRegistered) return;
  testExecutionRegistered = true;

  registerExposureModule({
    id: "testExecution",
    title: "How the harness runs its own tests",
    purpose:
      "How many tests run at once, how long one may run, and the CPU budgets the harness's own test gates judge every run by.",
  });

  // --- Customizations (5: the runner's run bounds, contract defaults) ---
  for (const spec of ROWS) {
    registerCustomization({
      id: `testExecution.${spec.id}`,
      module: "testExecution",
      name: spec.name,
      description: spec.description,
      type: "number",
      default: spec.default,
      min: spec.min,
      max: spec.max,
      unit: spec.unit,
      current: () => readNumberCustomization(spec.configPath, spec.default),
      set: (v) => writeConfigCustomization(spec.configPath, v),
      contract: { effect: "next-run" },
      configPath: spec.configPath,
    });
  }

  // --- Signals (9: the gates' own verdict numbers, read-only) ---
  // Each budget decides what a suite gate's green MEANS: the web suite's
  // CPU-per-file floor (the rolling cap's recorded anchor) and population,
  // the window the rolling median is taken over, the drift tolerance, the
  // noise band, the ratchet count, the share of the pool one file may
  // occupy, the flaky memory's lookback window, and the engine suite's own
  // budget phase. They are the round-39 doctrine's class — shown read-only,
  // pinned never-writable by the census — and they carry no default on
  // purpose: an absent key is the gate's own loud refusal, so the signal
  // states it in words instead of inventing a number (the honest-absence
  // contract).
  const BUDGET_PATH = "testExecution.webUiSuiteCpuBudget";
  registerSignal({
    id: "testExecution.webSuiteCpuCap",
    module: "testExecution",
    name: "CPU cost one web-suite test file may reach",
    description:
      "The web-UI suite's CPU cap: the recorded floor itself. Only a run that passed its own cap feeds the rolling window, so the window's median never rises above the floor; a grown or slower suite fails the cap until the measuring tool re-derives the floor (npm run budget:measure). Every judgement line scales by the measured ambient-inflation envelope (see the ambient signals). Shown read-only: a settings write that loosened it would silently weaken what a green run means.",
    type: "string",
    value: () => {
      const metric = readConfigCustomization(`${BUDGET_PATH}.metric`);
      const floor = readBudgetNumber(`${BUDGET_PATH}.baselineFloorUnitsPerTestFile`);
      const minimum = readBudgetNumber(`${BUDGET_PATH}.minimumJudgedRuns`);
      if (typeof metric === "string" && minimum !== undefined && floor === undefined) {
        return (
          `no cap yet — ${metric} ACCUMULATION (${String(minimum)} clean judged full runs ` +
          `needed); the retired raw-CPU floor is recorded but incomparable`
        );
      }
      if (floor === undefined) return NOT_DECLARED;
      return `${floor} calibration units of work per test file (${typeof metric === "string" ? metric : "metric undeclared"}) — the cap`;
    },
  });
  registerSignal({
    id: "testExecution.webSuiteBaselineWindow",
    module: "testExecution",
    name: "Clean runs the rolling CPU baseline's median is taken over",
    description:
      "How many recent clean judged runs (each one passed its own cap) the stale-floor check's median is computed over. The cap itself is the floor: a grown suite fails it until the measuring tool re-derives the floor. Shown read-only: widening or shrinking the window from the settings room would change what the gate reports.",
    type: "string",
    value: () => {
      const window = readBudgetNumber(`${BUDGET_PATH}.baselineWindowRuns`);
      if (window !== undefined) {
        return `the stale-floor check reads the median of the last ${String(window)} clean judged runs`;
      }
      const minimum = readBudgetNumber(`${BUDGET_PATH}.minimumJudgedRuns`);
      return minimum === undefined
        ? NOT_DECLARED
        : `no window yet — the metric is in accumulation (${String(minimum)} clean judged full runs needed before a cap is derived)`;
    },
  });
  registerSignal({
    id: "testExecution.webSuiteCpuPopulation",
    module: "testExecution",
    name: "Test files the web-suite budget is judged against",
    description:
      "The suite size the budget's recorded floor was derived on — or, while the metric is in accumulation, the population its clean-run window is being filled at. The gate refuses when the suite grows or shrinks past its declared drift tolerance, so the population and the floor move together or not at all. Shown read-only: a settings write here would decouple the floor from the tree it was measured on.",
    type: "string",
    value: () => {
      const count = readBudgetNumber(`${BUDGET_PATH}.derivedAtTestFileCount`);
      if (count !== undefined) return `judged against ${count} test files`;
      // In accumulation the population is never committed: it is the live supported population, derived on every read.
      return readBudgetNumber(`${BUDGET_PATH}.minimumJudgedRuns`) === undefined ? NOT_DECLARED : "the live supported test files (accumulation: derived, never committed)";
    },
  });
  registerSignal({
    id: "testExecution.webSuitePopulationDriftTolerance",
    module: "testExecution",
    name: "Suite-size drift the web-suite budget tolerates",
    description:
      "How far the suite may grow or shrink before the CPU cap must be re-derived on the tree as it now is. Shown read-only: widening this from the settings room would let a cap govern a suite it never measured.",
    type: "string",
    value: () => {
      const drift = readBudgetNumber(`${BUDGET_PATH}.maxPopulationDriftFraction`);
      return drift === undefined ? NOT_DECLARED : `${asPercent(drift)} suite-size drift before re-deriving`;
    },
  });
  registerSignal({
    id: "testExecution.webSuiteNoiseSpread",
    module: "testExecution",
    name: "Same-tree spread that decides which runs feed the web-suite baseline",
    description:
      "How far a judged run's reading may sit above the baseline in force and still feed the rolling baseline and the measuring tool's window — the measured run-to-run spread of an unchanged tree. It never widens a verdict: one judged run over the cap fails. Shown read-only: widening it from the settings room would let regressed readings feed the baseline.",
    type: "string",
    value: () => {
      const spread = readBudgetNumber(`${BUDGET_PATH}.sameTreeSpreadFraction`);
      if (spread !== undefined) return `${asPercent(spread)} same-tree spread decides which runs feed the baseline`;
      return readBudgetNumber(`${BUDGET_PATH}.minimumJudgedRuns`) === undefined
        ? NOT_DECLARED
        : "no feed spread yet — no baseline is being derived while the metric accumulates";
    },
  });
  registerSignal({
    id: "testExecution.webTestFileCostShareMax",
    module: "testExecution",
    name: "Worker-time share one web-suite test file may take",
    description:
      "The largest share of the whole pool's worker time one test file may occupy — a share rather than a duration, so contention moves the numerator and denominator together. Shown read-only: loosening it would let one file eat the suite unnoticed.",
    type: "string",
    value: () => {
      const share = readBudgetNumber("testExecution.webUiTestFileCostShareMax");
      return share === undefined ? NOT_DECLARED : `one test file may take at most ${asPercent(share)} of the pool's worker time`;
    },
  });
  // HEAVY-RUN ADMISSION (src/process/instrument-lock.ts): served read-only,
  // like every suite-gate number — a settings write that moved the registry
  // or loosened a run's caps would let a run escape them.
  registerSignal({
    id: "testExecution.instrumentLockFile",
    module: "testExecution",
    name: "The host's run registry (under the host user's cache folder)",
    description:
      "Every heavy instrument — a whole suite, a coverage or browser run, a workspace validation, an ad-hoc load run through `harness slot run` — is admitted at once and recorded beside this path, under its per-run caps; none waits for another. Shown read-only.",
    type: "string",
    value: () => {
      const path = readConfigCustomization("testExecution.instrumentLock.cacheRelativeLockPath");
      return typeof path === "string" ? `<cache>/${path}` : NOT_DECLARED;
    },
  });
  registerSignal({
    id: "testExecution.instrumentLockHeavyAt",
    module: "testExecution",
    name: "Test files that make a run heavy",
    description:
      "A run of this many test files or more is heavy: it is admitted under its per-run caps; a targeted run of fewer records nothing. Shown read-only.",
    type: "string",
    value: () => {
      const files = readBudgetNumber("testExecution.instrumentLock.minimumTestFiles");
      return files === undefined ? NOT_DECLARED : `a run of ${files} or more test files is heavy`;
    },
  });
  registerSignal({
    id: "testExecution.perRunMemoryCap",
    module: "testExecution",
    name: "The memory one heavy run may use (a share of the host's memory)",
    description:
      "Every supervisor a heavy run starts runs in a cgroup scope of its own with this memory ceiling; a host that cannot make the scope refuses the run. Shown read-only.",
    type: "string",
    value: () => {
      const percent = readBudgetNumber("testExecution.instrumentLock.perRun.memoryMaxPercent");
      return percent === undefined ? NOT_DECLARED : `a heavy run may use at most ${String(percent)}% of the host's memory`;
    },
  });
  registerSignal({
    id: "testExecution.perRunCpuWeight",
    module: "testExecution",
    name: "The CPU share one heavy run gets beside the others",
    description:
      "Heavy runs proceed concurrently; each one's scope gets this CPU weight (100 is an equal share), so runs share the cores instead of waiting for each other. Shown read-only.",
    type: "string",
    value: () => {
      const weight = readBudgetNumber("testExecution.instrumentLock.perRun.cpuWeight");
      return weight === undefined ? NOT_DECLARED : `a heavy run's CPU weight is ${String(weight)}`;
    },
  });
  registerSignal({
    id: "testExecution.instrumentLockWholeInstruments",
    module: "testExecution",
    name: "Instruments that are heavy whatever they run",
    description:
      "These whole instruments hold the host's instrument lock by kind, whatever files they name (the one definition of heavy). Shown read-only: dropping one from a settings write would let it share the cores with a measured run.",
    type: "string",
    value: () => {
      const kinds = readConfigCustomization("testExecution.instrumentLock.wholeInstruments");
      return Array.isArray(kinds) ? `heavy by kind: ${kinds.join(", ")}` : NOT_DECLARED;
    },
  });
  // THE FLAKY-CAUSE REPRODUCTION DOOR's statistical N (`harness flake reproduce
  // --statistical`, FLAKE-REPRO): served read-only — a smaller N written from a
  // settings cookie would let fewer runs explain a flaky suspect.
  registerSignal({
    id: "testExecution.flakeReproductionRuns",
    module: "testExecution",
    name: "Runs on each side of a statistical flake reproduction",
    description:
      "A cause that needs load or a race is reproduced statistically: at least this many runs on each side, the fix passing every one of them, under the same condition. Shown read-only.",
    type: "string",
    value: () => {
      const runs = readBudgetNumber("testExecution.flakeReproduction.statisticalRuns");
      return runs === undefined ? NOT_DECLARED : `${runs} runs on each side of a statistical reproduction`;
    },
  });
  registerSignal({
    id: "testExecution.flakeReproductionSignificance",
    module: "testExecution",
    name: "How strong a flake reproduction must be",
    description:
      "The most probability a reproduction's counts may leave that a fix which changed nothing shows them (one-sided Fisher); the door derives the runs per side a failure rate needs from it. Shown read-only: a settings write that raised it would let a lucky run explain a flaky suspect.",
    type: "string",
    value: () => {
      const significance = readBudgetNumber("testExecution.flakeReproduction.significance");
      return significance === undefined ? NOT_DECLARED : `a reproduction counts only when a no-op fix shows its counts at most ${String(significance)} of the time`;
    },
  });
  registerSignal({
    id: "testExecution.flakeReproductionShims",
    module: "testExecution",
    name: "Preloads whose one run per side is a reproduction",
    description:
      "The deterministic shims: the only preloaded modules whose single failing parent run and single passing fix run count as a reproduction. Shown read-only: a shim added from a settings write would let one run explain a flaky suspect.",
    type: "string",
    value: () => {
      const shims = readConfigCustomization("testExecution.flakeReproduction.deterministicShims");
      return Array.isArray(shims) ? (shims.length === 0 ? "no deterministic shim: every reproduction needs its runs" : `deterministic shims: ${shims.join(", ")}`) : NOT_DECLARED;
    },
  });
  // PER-TEST LIMITS (TEST-CPU-CLASSES): judged in CPU work by class, with one
  // wall hang backstop. Read-only like every suite-gate number: a settings
  // write that raised a ceiling would change what a green test means.
  registerSignal({
    id: "testExecution.testCpuDefaultCeiling",
    module: "testExecution",
    name: "CPU work a test may do (its class's ceiling, by default)",
    description:
      "Each test is judged by the CPU work it did (its process and every child it reaped), never by its wall time: a test over its file's class ceiling fails. This is the ceiling of every file no class names. Shown read-only.",
    type: "string",
    value: () => {
      const ms = readBudgetNumber("testExecution.testCpuClasses.defaultCeilingMs");
      return ms === undefined ? NOT_DECLARED : `a test may do ${ms / 1000} s of CPU work unless its file's class says otherwise`;
    },
  });
  registerSignal({
    id: "testExecution.testCpuHeadroom",
    module: "testExecution",
    name: "Headroom over a measured CPU class",
    description:
      "A CPU class records the most CPU work one of its tests was measured to do; its ceiling is that measurement times this factor, because CPU work still varies with the runner's processor. Shown read-only.",
    type: "string",
    value: () => {
      const factor = readBudgetNumber("testExecution.testCpuClasses.headroomFactor");
      return factor === undefined ? NOT_DECLARED : `a class's ceiling is ${String(factor)} times the CPU work it was measured to do`;
    },
  });
  registerSignal({
    id: "testExecution.testCpuClasses",
    module: "testExecution",
    name: "Test files with their own CPU-work ceiling",
    description:
      "The named CPU-work classes and the test files each holds, each ceiling measured for its files. Shown read-only: a class added from a settings write would let a test do more work unseen.",
    type: "string",
    value: () => {
      const classes = readConfigCustomization("testExecution.testCpuClasses.classes");
      const headroom = readBudgetNumber("testExecution.testCpuClasses.headroomFactor");
      if (!Array.isArray(classes) || headroom === undefined) return NOT_DECLARED;
      if (classes.length === 0) return "no class: every test file has the default ceiling";
      // The ceiling is DERIVED by the one owner the judgement asks.
      return (classes as { name: string; measuredCpuMs: number; files: string[] }[])
        .map((one) => `${one.name} (measured ${one.measuredCpuMs / 1000} s, ceiling ${classCeilingMs({ headroomFactor: headroom }, one) / 1000} s): ${one.files.join(", ")}`).join("; ");
    },
  });
  registerSignal({
    id: "testExecution.testHangBackstop",
    module: "testExecution",
    name: "Wall time after which a test is reported hung",
    description:
      "The one wall bound left on a test: one still running after this long is hung (a promise that never settles), not slow; how much a test costs is judged in CPU work. Shown read-only.",
    type: "string",
    value: () => {
      const ms = readBudgetNumber("testExecution.testHangBackstopMs");
      return ms === undefined ? NOT_DECLARED : `a test still running after ${ms / 1000} s is reported hung`;
    },
  });
  // The web suite's supervisor (`scripts/run-tests.ts`): served read-only,
  // like every other suite-gate number — loosening a stall limit or the
  // hard ceiling from a settings cookie would change what a green run means.
  registerSignal({
    id: "testExecution.webSuiteStallTimeout",
    module: "testExecution",
    name: "Silence after which the web-suite supervisor kills a run",
    description:
      "A synchronous spin cannot be interrupted from inside the runtime, so a process outside it ends a run that has printed nothing for this long — a slow run keeps printing and is never killed. Shown read-only.",
    type: "string",
    value: () => {
      const ms = readBudgetNumber("testExecution.webSuiteWatchdog.stallTimeoutMs");
      return ms === undefined ? NOT_DECLARED : `a run that prints nothing for ${ms / 1000} s is killed`;
    },
  });
  registerSignal({
    id: "testExecution.webSuiteHardCeiling",
    module: "testExecution",
    name: "Hard ceiling at which the web-suite supervisor kills a run",
    description:
      "Whatever the machine's load, a run still going after this long is killed with every process it started, detached ones included — a run that keeps printing forever still ends. Performance is the CPU budget's verdict, not this. Shown read-only.",
    type: "string",
    value: () => {
      const ms = readBudgetNumber("testExecution.webSuiteWatchdog.hardCeilingMs");
      return ms === undefined ? NOT_DECLARED : `a run still going after ${ms / 1000} s is killed`;
    },
  });
  registerSignal({
    id: "testExecution.webSuiteKillGrace",
    module: "testExecution",
    name: "Grace a stopped web-suite run has before it is killed",
    description:
      "A run the supervisor stops (a stall, the ceiling, Ctrl-C, its launcher exiting) is told first (SIGTERM) and gets this long to report on its way out; then it and every process it started are killed. Shown read-only.",
    type: "string",
    value: () => {
      const ms = readBudgetNumber("testExecution.webSuiteWatchdog.killGraceMs");
      return ms === undefined ? NOT_DECLARED : `a stopped run has ${ms / 1000} s before it is killed`;
    },
  });
  // The ENGINE suite's watchdog (`scripts/tooling/inventory-test-run.ts`):
  // served read-only for the same reason as the web suite's.
  registerSignal({
    id: "testExecution.engineSuiteStallTimeout",
    module: "testExecution",
    name: "Silence after which the engine-suite watchdog kills a phase",
    description:
      "A test file whose cancelled test left something open never exits, and the runner would wait for it forever; a phase that reports no test event for this long is aborted, and every file still running is killed and reported failed. Shown read-only.",
    type: "string",
    value: () => engineWatchdogFace("testExecution.engineSuiteWatchdog.stallTimeoutMs", DEFAULT_ENGINE_SUITE_WATCHDOG.stallTimeoutMs, (seconds) => `a phase that reports nothing for ${seconds} s is killed`),
  });
  registerSignal({
    id: "testExecution.engineSuiteHardCeiling",
    module: "testExecution",
    name: "Hard ceiling at which the engine-suite watchdog kills a run",
    description:
      "Whatever the machine's load, an engine test run still going after this long is aborted, and every file still running is killed and reported failed. Performance is the CPU budget's verdict, not this. Shown read-only.",
    type: "string",
    value: () => engineWatchdogFace("testExecution.engineSuiteWatchdog.hardCeilingMs", DEFAULT_ENGINE_SUITE_WATCHDOG.hardCeilingMs, (seconds) => `a run still going after ${seconds} s is killed`),
  });
  registerSignal({
    id: "testExecution.engineSuiteKillGrace",
    module: "testExecution",
    name: "Grace a stopped engine-suite run has before it is killed",
    description:
      "The engine test worker told to stop (its ceiling, Ctrl-C, its launcher exiting) gets this long to abort its test files and report; then it and every process it started are killed. Shown read-only.",
    type: "string",
    value: () => engineWatchdogFace("testExecution.engineSuiteWatchdog.killGraceMs", DEFAULT_ENGINE_SUITE_WATCHDOG.killGraceMs, (seconds) => `a stopped run has ${seconds} s before it is killed`),
  });
  registerSignal({
    id: "testExecution.integrationSuiteBudgetPhase",
    module: "testExecution",
    name: "Phase the engine suite's own CPU budget is in",
    description:
      "The engine suite's budget is either accumulating evidence (every run's CPU reading is recorded, no cap in force) or derived (a cap governs, with its population and spread declared beside it). Shown read-only: the phase and its numbers are the gate's own contract, changed through the config file with the derivation recorded there.",
    type: "string",
    value: () => {
      const budget = readConfigCustomization("testExecution.integrationSuiteCpuBudget");
      if (budget === null || typeof budget !== "object" || Array.isArray(budget)) return NOT_DECLARED;
      const record = budget as Record<string, unknown>;
      if (record.phase === "accumulation") {
        return `accumulation — at least ${String(record.minimumJudgedRuns)} judged runs before the cap is derived`;
      }
      if (record.phase === "derived") {
        return `derived — ${String(record.unitsPerTestFile)} calibration units of work per test file over ${String(record.derivedAtTestFileCount)} files`;
      }
      return NOT_DECLARED;
    },
  });
}

/** Reset the per-module registration flag (test-only). */
export function resetTestExecutionRegistration(): void {
  testExecutionRegistered = false;
}
