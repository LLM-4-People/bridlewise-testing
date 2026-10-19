/**
 * WHAT THE OPERATOR DECLARED, AND HOW BIG A FULL RUN IS — read once, here.
 *
 * Both the budget REPORTER (which now judges the run it is ending) and the
 * budget PREVENTION TEST (which judges the tree's own configuration) need the
 * same three answers: the declared CPU budget, the declared per-file share
 * cap, and how many test files a full run covers. Before this module they
 * lived in the test file, so moving the judgement to the reporter would have
 * meant restating them — a second source of truth for a number whose whole
 * purpose is to be the only one (§1, §16).
 *
 * Nothing here has a DEFAULT, deliberately. See `readCpuBudget`.
 */
import { globSync } from "node:fs";

import { readConfigRaw } from "../../server/kernel/harness-config.ts";
import { getConfigDocumentSchema } from "../../engine/src/kernel/config.ts";
import { TEST_INCLUDE } from "../test-include.ts";
// TYPE ONLY — the shape belongs to the decision module that judges it, and a
// second declaration here would be a second source of truth for the field
// names the config schema requires. Erased at runtime, so this costs nothing.
import type { RollingCpuBudget } from "./budget-verdict.ts";
import type { SuiteWatchdog } from "../../engine/src/workflow/workflow-config.ts";

export type { RollingCpuBudget };

/**
 * Where an operator sets these, named once so every message can point at it.
 * A guard that refuses without saying where to fix it has moved the problem
 * rather than reported it.
 */
export const CONFIG_SITE = "testExecution in bridlewise.config.json";

/**
 * The ledger identities of the budget gate's own faces on this suite. A run
 * whose recorded failures carry one of these ran under a budget state the
 * verdict could not trust (the tree-side arms judge the live declaration),
 * so its reading must never move the rolling baseline — the
 * self-normalizing loop a bad run raising the bar for future bad runs. The
 * reporter's own gate fails through the process exit code, never as a test
 * row, so the prevention file's identity is the one face that can appear.
 */
export const WEB_BUDGET_FAILURE_IDENTITIES: readonly string[] = Object.freeze(["tests/prevention/web-ui-runtime-budget.test.ts::"]);

/** The `testExecution` section, as written, from the single config owner. */
function testExecutionSection(): Record<string, unknown> {
  const raw = readConfigRaw() as { testExecution?: Record<string, unknown> };
  return raw?.testExecution ?? {};
}

function positiveFinite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * The declared rolling budget, or the plain-words reason it cannot be read.
 *
 * **THERE IS NO DEFAULT, DELIBERATELY.** A budget that falls back to a
 * constant in this file is a second source of truth for the same question,
 * and the fallback only fires when the real source is missing — the exact
 * moment nobody is looking. Worse, it converts "nobody has configured this"
 * into a green run against a number no operator ever chose. Missing
 * configuration is a first-class state here: the gate fails, says what is
 * absent, and says where to put it.
 */
export function readCpuBudget(): RollingCpuBudget | { readonly missing: string } {
  const section = testExecutionSection();
  const declared = section.webUiSuiteCpuBudget;
  if (typeof declared !== "object" || declared === null) {
    return {
      missing:
        `webUiSuiteCpuBudget is not set under ${CONFIG_SITE}. This gate bounds what the ` +
        `web-UI suite may cost in CPU milliseconds per test file, and it has no default: ` +
        `a budget nobody chose is not a budget. Declare the rolling baseline's recorded ` +
        `floor (baselineFloorMsPerTestFile) and window (baselineWindowRuns) beside the ` +
        `population, drift tolerance and feed spread — the cap itself is ` +
        `derived from the run-history ledger at read time.`,
    };
  }
  const rec = declared as Record<string, unknown>;
  const baselineFloorMsPerTestFile = positiveFinite(rec.baselineFloorMsPerTestFile);
  const derivedAtTestFileCount = positiveFinite(rec.derivedAtTestFileCount);
  const maxPopulationDriftFraction = positiveFinite(rec.maxPopulationDriftFraction);
  const sameTreeSpreadFraction = positiveFinite(rec.sameTreeSpreadFraction);
  const baselineWindowRuns = positiveFinite(rec.baselineWindowRuns);
  const ambientInflationSlopePerCpu = positiveFinite(rec.ambientInflationSlopePerCpu);
  const ambientInflationCapFraction = positiveFinite(rec.ambientInflationCapFraction);
  if (baselineFloorMsPerTestFile === null || derivedAtTestFileCount === null) {
    return {
      missing:
        `webUiSuiteCpuBudget under ${CONFIG_SITE} must carry BOTH a positive ` +
        `baselineFloorMsPerTestFile (the recorded floor the rolling baseline never drops ` +
        `below without a measured re-derivation) and the positive derivedAtTestFileCount ` +
        `it was measured against. A threshold without its population keeps its authority ` +
        `and loses its meaning, which is how the wall-clock cap this replaced came to ` +
        `govern a suite it had never measured.`,
    };
  }
  if (maxPopulationDriftFraction === null || maxPopulationDriftFraction >= 1) {
    return {
      missing:
        `webUiSuiteCpuBudget.maxPopulationDriftFraction under ${CONFIG_SITE} must be a ` +
        `fraction above 0 and below 1 — how far the suite may grow or shrink before the ` +
        `budget must be re-derived on the tree as it now is.`,
    };
  }
  if (sameTreeSpreadFraction === null || sameTreeSpreadFraction >= 1) {
    return {
      missing:
        `webUiSuiteCpuBudget.sameTreeSpreadFraction under ${CONFIG_SITE} must be a ` +
        `fraction above 0 and below 1 — the measured run-to-run spread of an UNCHANGED ` +
        `tree, which decides only which ledger readings feed the rolling baseline and the ` +
        `measuring tool's window; it never widens a verdict (one judged run over the cap fails).`,
    };
  }
  if (baselineWindowRuns === null || !Number.isInteger(baselineWindowRuns)) {
    return {
      missing:
        `webUiSuiteCpuBudget.baselineWindowRuns under ${CONFIG_SITE} must be a positive ` +
        `integer — how many recent clean judged runs the rolling baseline's median is ` +
        `computed over. Without it the cap is a hand-set number again, which is the ` +
        `treadmill the rolling derivation exists to end.`,
    };
  }
  if (
    ambientInflationSlopePerCpu === null ||
    ambientInflationSlopePerCpu >= 1 ||
    ambientInflationCapFraction === null ||
    ambientInflationCapFraction >= 1
  ) {
    return {
      missing:
        `webUiSuiteCpuBudget.ambientInflationSlopePerCpu and ambientInflationCapFraction ` +
        `under ${CONFIG_SITE} must both be positive fractions below 1 — the measured ` +
        `CPU-inflation envelope of the recorded 5-minute ambient load (the slope, per ` +
        `cpu) and the bound on the whole adjustment (the cap). The cap scales by this ` +
        `envelope (stated on every verdict until AMBIENT-ALLOWANCE-REMOVE), so a clean run ` +
        `at a busy ambient judges clean and a regressed one fails, at ANY ambient — without it ` +
        `the gate is back to either demanding a quiet box or pretending load moves ` +
        `nothing.`,
    };
  }
  return {
    baselineFloorMsPerTestFile,
    derivedAtTestFileCount,
    maxPopulationDriftFraction,
    sameTreeSpreadFraction,
    baselineWindowRuns,
    ambientInflationSlopePerCpu,
    ambientInflationCapFraction,
  };
}

/**
 * The per-file share cap, or the plain-words reason it cannot be read.
 *
 * Same rule as the budget above, and for the same reason: this used to fall
 * back to a constant declared in this file, so an unconfigured tree ran a cap
 * of 0.05 that the config never stated and nobody could see.
 */
export function readFileShareMax(): number | { readonly missing: string } {
  const configured = positiveFinite(testExecutionSection().webUiTestFileCostShareMax);
  if (configured === null || configured >= 1) {
    return {
      missing:
        `webUiTestFileCostShareMax is not set (or is not a fraction below 1) under ` +
        `${CONFIG_SITE}. It is the largest share of the whole pool's worker time one ` +
        `test FILE may occupy, and it has no default here.`,
    };
  }
  return configured;
}

/**
 * The globs a FULL run covers — THE BINDING THE RUNNER IS HANDED.
 *
 * ── THIS USED TO BE A REGEX OVER `vite.config.ts`'S OWN SOURCE ───────────
 *
 * It could not import the declaration, because importing the vite config
 * pulls in the svelte plugin and a cross-repository liveness check, and this
 * module is loaded by a reporter and by a test file that gates on collect
 * time. So it re-parsed the config's text — a copy of the value, arrived at
 * by the exact route the config's own comment forbids. The copy was wrong
 * twice, and both failures are worth keeping written down:
 *
 * **A WRONG REGION IS WORSE THAN NO REGION.** The first version took the FIRST
 * `include: [ … ],` in the file. That is not `test.include` — it is
 * `deps.optimizer.ssr.include`, twenty lines earlier — and the non-greedy body
 * then ran on through `reporters:` to the next `],`. So the "test globs" it
 * returned were `zod · nanostores · svelte/compiler · default · default ·
 * ./tests/reporters/budget-reporter.ts · <the five real globs>`. Most of those
 * match nothing, which is why it looked correct. But the reporter path is a
 * REAL PATH, so the count came back **452 against a suite of 451**.
 *
 * **AND THE `include:` PREFIX WAS STILL A POSITION.** The replacement chose
 * the block by a PROPERTY of what it contained, and kept one word of the old
 * habit: the array had to be spelled immediately after `include:`. The moment
 * the globs were lifted into a named constant — `include: [...TEST_INCLUDE]` —
 * it found ZERO blocks and refused.
 *
 * The declaration now lives in `tests/test-include.ts`, a module with no
 * imports, so there is nothing left to work around: the population is the
 * value the runner receives. That the RUNNER still receives it —
 * `include: [...TEST_INCLUDE]` and not something spelled beside it — is the
 * one claim the config's source is the right subject for, and it is asserted
 * in `tests/prevention/web-ui-runtime-budget.test.ts`.
 */
export function fullRunGlobs(): readonly string[] {
  return TEST_INCLUDE;
}

/** How many test files a FULL run covers. */
export function fullRunModuleCount(): number {
  return new Set(globSync([...fullRunGlobs()])).size;
}

/**
 * The web suite's watchdog (`webSuiteWatchdog` under the testExecution
 * section), validated by the config contract's OWN schema (one validator,
 * never a second hand-written one), or the plain-words reason it cannot be
 * read. No default, for the reason {@link readCpuBudget} gives: the
 * supervisor refuses to start rather than guard a run with numbers nobody
 * chose.
 */
export function readWebSuiteWatchdog(): SuiteWatchdog | { readonly missing: string } {
  const schema = getConfigDocumentSchema().shape.testExecution.unwrap().shape.webSuiteWatchdog.unwrap();
  const parsed = schema.safeParse(testExecutionSection().webSuiteWatchdog);
  if (!parsed.success) {
    return {
      missing:
        `webSuiteWatchdog under ${CONFIG_SITE} must carry stallTimeoutMs (no output for this long kills the run), ` +
        `hardCeilingMs (a run still going after this long is killed, whatever the load) and killGraceMs (a stopped run's ` +
        `time between SIGTERM and SIGKILL): ${parsed.error.issues[0]?.message ?? "invalid"}`,
    };
  }
  return parsed.data;
}

/** The web suite's kill grace, for a test's own supervised launch (`runBoundedTestProcess`); a missing watchdog throws its reason. */
export function webSuiteKillGraceMs(): number {
  const watchdog = readWebSuiteWatchdog();
  if ("missing" in watchdog) throw new Error(watchdog.missing);
  return watchdog.killGraceMs;
}
