/**
 * THE WEB TEST-RUNTIME BUDGET'S MEASURING TOOL (D-17, A4-OWNED-BUDGET).
 *
 *   npm run budget:measure -- --check    # what the ledger measures now (exit 1 when it differs from the declared floor, or cannot measure)
 *   npm run budget:measure -- --write    # record the measured floor and its population in the settings document
 *
 * The web suite's CPU budget floor (`testExecution.webUiSuiteCpuBudget.
 * baselineFloorMsPerTestFile`, with the population it was derived at,
 * `derivedAtTestFileCount`) is a MEASURED value: this tool is its one
 * writer, from the judged runs the suite's own reporter records in its
 * ledger (`.bridlewise/web-test-results/run-history.json`). The arithmetic is
 * the budget owner's (`measureBudgetFloor`, engine/src/shared/budget-verdict.ts):
 * the ambient-adjusted median of the last `baselineWindowRuns` clean judged
 * full runs of the population as it is now. Fewer such runs is
 * `unmeasurable`: reported with the count, never guessed, never tuned — a
 * budget judged under load is re-measured when the runs exist, not edited.
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
  floor: "testExecution.webUiSuiteCpuBudget.baselineFloorMsPerTestFile",
  population: "testExecution.webUiSuiteCpuBudget.derivedAtTestFileCount",
});

export type WebBudgetReport = Readonly<{
  measurement: BudgetFloorMeasurement;
  declared: Readonly<{ floorMsPerTestFile: number; derivedAtTestFileCount: number }>;
  /** current: the declared floor is the measured one; drifted: a write would change it; unmeasurable: the ledger cannot say yet; written: --write recorded it. */
  status: "current" | "drifted" | "unmeasurable" | "written";
}>;

/** Measure the floor from the ledger (`ledgerPath`: the web ledger by default); with `write`, record it. */
export function measureWebBudget(write: boolean, ledgerPath?: string): WebBudgetReport {
  const budget = readCpuBudget();
  if ("missing" in budget) throw new InputError(budget.missing, "web_budget_undeclared");
  const measurement = measureBudgetFloor(budget, ledgerPath === undefined ? readRunHistory() : readRunHistory(ledgerPath), fullRunModuleCount(), WEB_BUDGET_FAILURE_IDENTITIES);
  const declared = { floorMsPerTestFile: budget.baselineFloorMsPerTestFile, derivedAtTestFileCount: budget.derivedAtTestFileCount };
  if (measurement.status === "unmeasurable") return Object.freeze({ measurement, declared, status: "unmeasurable" });
  const current = measurement.floorMsPerTestFile === declared.floorMsPerTestFile && measurement.derivedAtTestFileCount === declared.derivedAtTestFileCount;
  if (current || !write) return Object.freeze({ measurement, declared, status: current ? "current" : "drifted" });
  // The document measured is the one written (WF-1b3b design LOW 12): the
  // budget was read from the web server's settings document, which
  // HARNESS_CONFIG_PATH may move away from the engine's.
  const store = createEngineCustomizationConfigStore();
  if (resolve(serverConfig.harnessConfigPath) !== resolve(store.configFilePath)) {
    throw new InputError(`the budget was read from ${serverConfig.harnessConfigPath} but would be written to ${store.configFilePath}; unset HARNESS_CONFIG_PATH or point it at the engine's document`, "web_budget_document_mismatch");
  }
  installCustomizationConfigStore(store);
  writeConfigCustomization(WEB_BUDGET_FLOOR_PATHS.floor, measurement.floorMsPerTestFile);
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
