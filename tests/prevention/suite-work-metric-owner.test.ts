// @vitest-environment node
/**
 * THE SUITE-WORK METRIC'S OWNER — a mechanical guard, not a convention.
 *
 * The measurement contract says a judged signal is DYNAMIC,
 * RESILIENT, LOAD-AGNOSTIC or declared-and-deferring, and SINGLE-OWNER: one
 * computation at the lowest chokepoint, every consumer reading it. Each clause
 * below is asserted against the SOURCE and against the signal's behaviour, so
 * a future edit that reverts the gate to raw CPU milliseconds, adds a second
 * division of the run's CPU, or substitutes raw CPU when the calibration is
 * unreadable, reds here instead of quietly changing what a green run means.
 *
 * THE RED-FIRST SELF-CHECK at the bottom feeds the detector the exact line it
 * forbids: a guard whose scanner has gone blind passes silently, which is the
 * failure mode this file exists to refuse.
 */
import { describe, expect, test } from "vitest";
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeRunWork,
  measureCalibration,
  SUITE_WORK_METRIC,
} from "../../engine/src/shared/run-cpu.ts";
import { deriveRollingBaseline, type RollingCpuBudget } from "../helpers/budget-verdict.ts";
import { readCpuBudget } from "../helpers/budget-config.ts";
import { modulePathMatching } from "../helpers/module-resolver.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const source = (path: string): string => readFileSync(join(ROOT, path), "utf8");
const PRODUCTION_FILES = globSync(
  ["engine/src/**/*.ts", "engine/scripts/**/*.ts", "tests/reporters/**/*.ts", "scripts/**/*.ts"],
  { cwd: ROOT },
);
const OWNER = modulePathMatching("shared/run-cpu.ts");

/** The exact divisions that would be a SECOND computation of the metric. */
function divisionSites(text: string): readonly string[] {
  return text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return false;
      return (
        /\brunCpuMs\s*\/\s*(calibrationMs|testFileCount|testModuleCount|FULL|testFiles)\b/u.test(line) ||
        /\bworkUnits\s*\/\s*(testFileCount|testModuleCount|FULL|testFiles)\b/u.test(line)
      );
    });
}

/** The body of a top-level `function name(...)` — ends at the first `}` in column 0. */
function topLevelFunctionBody(text: string, name: string): string {
  const start = text.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`no function ${name} — the guard's subject moved`);
  const lines = text.slice(start).split("\n");
  const end = lines.findIndex((line, index) => index > 0 && line === "}");
  if (end < 0) throw new Error(`function ${name} has no closing brace at column 0`);
  return lines.slice(0, end + 1).join("\n");
}

const calibration = (cpuMs: number) => ({
  cpuMs,
  chunks: [cpuMs, cpuMs, cpuMs, cpuMs, cpuMs, cpuMs],
  workload: "int-mem-l2/v1",
  chunkIterations: 5_000_000,
});

describe("the calibrated-work metric has exactly one owner and one computation", () => {
  test("NO production file divides the run's CPU by its calibration or population outside run-cpu.ts", () => {
    const offenders = PRODUCTION_FILES
      .filter((file) => file !== OWNER)
      .flatMap((file) => divisionSites(source(file)).map((line) => `${file}: ${line.trim()}`));
    expect(
      offenders,
      "a second computation is a defect: the run's CPU is divided by its calibration in " +
        "engine/src/shared/run-cpu.ts `computeRunWork`, and every consumer reads that record",
    ).toEqual([]);
    // The owner itself DOES make the division — a guard that scans a tree where
    // the computation has vanished would also pass, so the positive half is
    // asserted too.
    expect(divisionSites(source(OWNER)).length).toBeGreaterThanOrEqual(2);
  });

  test("the gate JUDGES workUnitsPerTestFile and never the raw CPU millisecond figure", () => {
    const verdict = source(modulePathMatching("shared/budget-verdict.ts"));
    const gate = topLevelFunctionBody(verdict, "cpuGate");
    expect(gate).toContain("v.workUnitsPerTestFile");
    expect(gate).not.toContain("v.cpuMsPerTestFile");
    const cap = topLevelFunctionBody(verdict, "cpuCap");
    expect(cap).toContain("budget.unitsPerTestFile");
    expect(cap).not.toContain("cpuMsPerTestFile");
    const eligible = topLevelFunctionBody(verdict, "eligibleBudgetRows");
    expect(eligible).toContain("r.workUnitsPerTestFile");
    expect(eligible).not.toContain("r.cpuMsPerTestFile");
    // The raw figure survives ONLY as provenance on the record and in prose.
    const judge = topLevelFunctionBody(verdict, "judgeSuiteCpu");
    expect(judge).toContain("cpuMsPerTestFile: evidence.rawCpuMsPerTestFile");
    expect(judge).toContain("workUnitsPerTestFile: evidence.workUnitsPerTestFile");
  });

  test("the reporter READS the owner; it does not divide the CPU itself", () => {
    const reporter = source("tests/reporters/budget-reporter.ts");
    expect(reporter).toContain("computeRunWork(");
    expect(divisionSites(reporter)).toEqual([]);
    expect(reporter).toContain("workUnitsPerTestFile: runWork?.workUnitsPerTestFile ?? null");
  });

  test("an unreadable calibration is ABSENT — raw CPU is NEVER substituted", () => {
    expect(computeRunWork(1_000, { atStart: null, atEnd: calibration(10) }, 10)).toBeNull();
    expect(computeRunWork(1_000, { atStart: calibration(10), atEnd: null }, 10)).toBeNull();
    expect(computeRunWork(1_000, { atStart: undefined as never, atEnd: calibration(10) }, 10)).toBeNull();
    expect(computeRunWork(1_000, { atStart: calibration(0), atEnd: calibration(10) }, 10)).toBeNull();
    expect(computeRunWork(null, { atStart: calibration(10), atEnd: calibration(10) }, 10)).toBeNull();
    expect(computeRunWork(1_000, { atStart: calibration(10), atEnd: calibration(10) }, 0)).toBeNull();
  });

  test("THE INVARIANCE ARITHMETIC: twice the CPU at twice the calibration unit is the SAME work per file", () => {
    const idle = computeRunWork(1_000, { atStart: calibration(10), atEnd: calibration(10) }, 10);
    const loaded = computeRunWork(2_000, { atStart: calibration(20), atEnd: calibration(20) }, 10);
    expect(idle).not.toBeNull();
    expect(loaded).not.toBeNull();
    expect(idle!.workUnitsPerTestFile).toBeCloseTo(10, 10);
    expect(loaded!.workUnitsPerTestFile).toBeCloseTo(10, 10);
    // The raw figures DID move — the metric is not a raw reading wearing a new name.
    expect(idle!.rawCpuMsPerTestFile).toBe(100);
    expect(loaded!.rawCpuMsPerTestFile).toBe(200);
  });

  test("the unit is MEASURED at run time, not a per-machine constant", () => {
    const reading = measureCalibration();
    expect(reading, "the in-process calibration child must produce a reading on this host").not.toBeNull();
    expect(reading!.cpuMs).toBeGreaterThan(0);
    expect(reading!.chunks.length).toBeGreaterThanOrEqual(3);
    expect(reading!.workload).toBe("int-mem-l2/v1");
    const owner = source(OWNER);
    expect(owner).toContain("spawnSync");
    expect(owner).toContain("process.cpuUsage()");
  });

  test("the config declares the metric, its validity bounds, and the retired floor as INCOMPARABLE", () => {
    const budget = readCpuBudget();
    expect("missing" in budget ? budget.missing : null).toBeNull();
    if ("missing" in budget) return;
    expect(budget.metric).toBe(SUITE_WORK_METRIC);
    expect(budget.calibrationDriftMaxFraction).toBeGreaterThan(0);
    expect(budget.validThroughLoad5PerCpu).toBeGreaterThan(1);
    if ("phase" in budget) {
      expect(budget.legacy?.metric).toBe("raw-cpu-ms/v0");
      expect(budget.legacy?.incomparable).toBe(true);
      expect("baselineFloorUnitsPerTestFile" in budget).toBe(false);
    }
  });

  test("the judgement layer DEFERS on its own witnesses, at the declared bounds", () => {
    const verdict = source(modulePathMatching("shared/budget-verdict.ts"));
    const refusal = topLevelFunctionBody(verdict, "metricValidityRefusal");
    expect(refusal).toContain("budget.validThroughLoad5PerCpu");
    expect(refusal).toContain("budget.calibrationDriftMaxFraction");
    expect(refusal).toContain("reading.workMetric !== budget.metric");
    expect(topLevelFunctionBody(verdict, "cpuGate")).toContain("metricValidityRefusal");
    expect(topLevelFunctionBody(verdict, "accumulatingCpuGate")).toContain("metricValidityRefusal");
  });

  test("NO production file rescales the retired raw floor into the new unit", () => {
    const RESCALE = /baselineFloorMsPerTestFile\s*[*/]|[*/]\s*baselineFloorMsPerTestFile/u;
    const offenders = PRODUCTION_FILES.flatMap((file) =>
      source(file)
        .split("\n")
        .filter((line) => {
          const trimmed = line.trim();
          if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return false;
          return RESCALE.test(line);
        })
        .map((line) => `${file}: ${line.trim()}`),
    );
    expect(
      offenders,
      "the retired floor is a RECORD, not a conversion: the new floor is derived from " +
        "calibrated-work rows alone, and the old unit's number is never multiplied or divided into it",
    ).toEqual([]);
  });

  test("a legacy raw-CPU row is INCOMPARABLE: it never enters a calibrated-work window", () => {
    const budget: RollingCpuBudget = {
      metric: SUITE_WORK_METRIC,
      calibrationDriftMaxFraction: 0.15,
      validThroughLoad5PerCpu: 1.25,
      baselineFloorUnitsPerTestFile: 10,
      derivedAtTestFileCount: 521,
      maxPopulationDriftFraction: 0.03,
      sameTreeSpreadFraction: 0.03,
      baselineWindowRuns: 12,
    };
    const legacy = { timestamp: "2026-10-20T00:00:00.000Z", cpuMsPerTestFile: 2_124.7, testModuleCount: 521 };
    expect(deriveRollingBaseline(budget, [legacy], 521, []).windowReadings).toEqual([]);
  });

  test("RED-FIRST: the detector is live — it catches the raw division and the rescaled legacy floor it forbids", () => {
    expect(divisionSites("const judged = runCpuMs / testFileCount;")).not.toEqual([]);
    expect(divisionSites("const judged = runCpuMs / calibrationMs;")).not.toEqual([]);
    expect(divisionSites("const judged = workUnits / testModuleCount;")).not.toEqual([]);
    // A comment is not a computation.
    expect(divisionSites("// the old formula was runCpuMs / testFileCount")).toEqual([]);
    // The migration detector: a legacy floor multiplied into the new unit.
    const RESCALE = /\bbaselineFloorMsPerTestFile\s*[*/]|[*/]\s*baselineFloorMsPerTestFile\b/u;
    expect(RESCALE.test("const newFloor = baselineFloorMsPerTestFile * 4;")).toBe(true);
    expect(RESCALE.test("baselineFloorMsPerTestFile.toFixed(1)")).toBe(false);
  });
});
