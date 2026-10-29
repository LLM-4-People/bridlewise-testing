/**
 * THE WEB TEST-RUNTIME BUDGET'S MEASURING TOOL (D-17, A4-OWNED-BUDGET).
 *
 *   npm run budget:measure -- --check    # what the ledger measures now (exit 1 when it differs from the declared floor, or cannot measure)
 *   npm run budget:measure -- --write    # record the measured floor and its population in the settings document
 *
 * The web suite's CPU budget floor (`testExecution.webUiSuiteCpuBudget.
 * baselineFloorUnitsPerTestFile`, in the declared `calibrated-work/v1` unit,
 * with the population it was derived at, `derivedAtTestFileCount`) is a
 * MEASURED value: this tool is its one writer, from the judged runs the
 * suite's own reporter records in its ledger
 * (`.bridlewise/web-test-results/run-history.json`). The arithmetic is the
 * budget owner's (`measureBudgetFloor`, engine/src/shared/budget-verdict.ts):
 * the median of the last `baselineWindowRuns` clean judged
 * full runs of the population as it is now. Fewer such runs is
 * `unmeasurable`: reported with the count, never guessed, never tuned — a
 * budget judged under load is re-measured when the runs exist, not edited.
 *
 * A DECLARATION IN THE NEW METRIC'S ACCUMULATION PHASE HAS NO FLOOR TO
 * MEASURE YET. This tool reports `migrating` and writes no floor: the retired
 * raw-CPU floor has no calibration reading, so no arithmetic turns it into
 * calibrated work, and the new floor is derived later from the new-metric
 * rows alone. That is the honest state of a unit migration, not a failure to
 * measure. Its POPULATION is not a committed number either: in accumulation
 * the window is filled at the live supported population, derived on every
 * read (`readCpuBudget`), so no branch that adds a test edits a shared count.
 * A measured floor records the population it was measured at, with it.
 *
 * The write goes through the engine's one config-path writer (the config
 * write lock and the whole-document schema gate), so the document stays the
 * only home of the number.
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { bootstrapProcess, isEntryPoint } from "../../engine/src/runtime/cli-debug.ts";
import { InputError } from "../../engine/src/kernel/errors.ts";
import { measureBudgetFloor, type BudgetFloorMeasurement } from "../../engine/src/shared/budget-verdict.ts";
import { createEngineCustomizationConfigStore, installCustomizationConfigStore, writeConfigCustomization } from "../../engine/src/shared/exposure/config-binding.ts";
import { fullRunModuleCount, readCpuBudget, WEB_BUDGET_FAILURE_IDENTITIES } from "../../tests/helpers/budget-config.ts";
import { readRunHistory } from "../../tests/helpers/budget-history.ts";
import { serverConfig } from "../../server/kernel/config.ts";

/** The settings paths this tool owns. */
export const WEB_BUDGET_FLOOR_PATHS = Object.freeze({
  floor: "testExecution.webUiSuiteCpuBudget.baselineFloorUnitsPerTestFile",
  population: "testExecution.webUiSuiteCpuBudget.derivedAtTestFileCount",
});

export type WebBudgetReport = Readonly<{
  measurement: BudgetFloorMeasurement;
  declared: Readonly<{ floorUnitsPerTestFile: number | null; derivedAtTestFileCount: number }>;
  /** current: the declared floor is the measured one; drifted: a write would change it; unmeasurable: the ledger cannot say yet; written: --write recorded it; migrating: the declaration is in the new metric's accumulation phase. */
  status: "current" | "drifted" | "unmeasurable" | "written" | "migrating";
}>;

/**
 * The engine's settings document, the one this tool writes. The document
 * measured is the one written (WF-1b3b design LOW 12): the budget was read
 * from the web server's settings document, which HARNESS_CONFIG_PATH may move
 * away from the engine's, and a write there is refused.
 */
function engineDocumentStore(): ReturnType<typeof createEngineCustomizationConfigStore> {
  const store = createEngineCustomizationConfigStore();
  if (resolve(serverConfig.harnessConfigPath) !== resolve(store.configFilePath)) {
    throw new InputError(`the budget was read from ${serverConfig.harnessConfigPath} but would be written to ${store.configFilePath}; unset HARNESS_CONFIG_PATH or point it at the engine's document`, "web_budget_document_mismatch");
  }
  return store;
}

/**
 * Measure the floor from the ledger (`ledgerPath`: the web ledger by default);
 * with `write`, record it.
 *
 * A DECLARATION IN ACCUMULATION HAS NO FLOOR TO MEASURE YET, and this tool
 * refuses rather than converting the retired one. The old 1926 ms/file floor
 * was measured in raw CPU milliseconds with no calibration reading; the new
 * unit is calibrated work, and there is no arithmetic that carries one into
 * the other. The retired declaration is recorded under `legacy` in the
 * settings document, marked incomparable; the new floor is derived from the
 * new-metric rows alone once the window is full.
 */
/** The accumulation population `readCpuBudget` derived for the web suite; its absence is a reader defect, refused. */
function derivedPopulation(population: number | undefined): number {
  if (population === undefined) throw new InputError("the web budget's accumulation population was not derived (readCpuBudget derives it from the live supported files)", "web_budget_population_underived");
  return population;
}

export function measureWebBudget(write: boolean, ledgerPath?: string): WebBudgetReport {
  const budget = readCpuBudget();
  if ("missing" in budget) throw new InputError(budget.missing, "web_budget_undeclared");
  if ("phase" in budget) {
    // NO floor in the new unit: the legacy figure is named in the reason,
    // never placed in the declared slot where a reader could take it for
    // calibrated work.
    const declared = {
      floorUnitsPerTestFile: null,
      // In accumulation the population is the live supported one (readCpuBudget derives it, always).
      derivedAtTestFileCount: derivedPopulation(budget.derivedAtTestFileCount),
    };
    const legacy = budget.legacy;
    const measurement: BudgetFloorMeasurement = {
      status: "unmeasurable",
      reason:
        `the web suite's CPU budget is in the ${budget.metric} ACCUMULATION phase: ` +
        `${String(budget.minimumJudgedRuns)} clean judged full runs in that metric are needed ` +
        `before a floor can be derived.` +
        (legacy === undefined
          ? " No earlier floor is recorded."
          : ` The retired ${legacy.baselineFloorMsPerTestFile.toFixed(1)} ms/file floor at ` +
            `${String(legacy.derivedAtTestFileCount)} files was measured under ${legacy.metric} ` +
            `and is INCOMPARABLE — recorded, never rescaled, and its rows never feed the new ` +
            `window.`) +
        " Run the full suite, then derive the floor with --write once the window is full.",
      eligibleRuns: 0,
      windowRuns: budget.minimumJudgedRuns,
      derivedAtTestFileCount: declared.derivedAtTestFileCount,
    };
    return Object.freeze({ measurement, declared, status: "migrating" });
  }
  const declared = {
    floorUnitsPerTestFile: budget.baselineFloorUnitsPerTestFile,
    derivedAtTestFileCount: budget.derivedAtTestFileCount,
  };
  const measurement = measureBudgetFloor(budget, ledgerPath === undefined ? readRunHistory() : readRunHistory(ledgerPath), fullRunModuleCount(), WEB_BUDGET_FAILURE_IDENTITIES);
  if (measurement.status === "unmeasurable") return Object.freeze({ measurement, declared, status: "unmeasurable" });
  const current = measurement.floorUnitsPerTestFile === declared.floorUnitsPerTestFile && measurement.derivedAtTestFileCount === declared.derivedAtTestFileCount;
  if (current || !write) return Object.freeze({ measurement, declared, status: current ? "current" : "drifted" });
  installCustomizationConfigStore(engineDocumentStore());
  writeConfigCustomization(WEB_BUDGET_FLOOR_PATHS.floor, measurement.floorUnitsPerTestFile);
  writeConfigCustomization(WEB_BUDGET_FLOOR_PATHS.population, measurement.derivedAtTestFileCount);
  return Object.freeze({ measurement, declared, status: "written" });
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  const { values } = parseArgs({ args: process.argv.slice(2), options: { check: { type: "boolean" }, write: { type: "boolean" } }, strict: true, allowPositionals: false });
  if (values.check === values.write) throw new InputError("usage: measure-web-budget --check | --write", "web_budget_usage");
  const report = measureWebBudget(values.write === true);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.status === "current" || report.status === "written" ? 0 : 1;
}
