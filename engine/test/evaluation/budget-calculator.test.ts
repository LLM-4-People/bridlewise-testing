import assert from "node:assert/strict";
import test from "node:test";

import { calculateBudget, formatBudgetReport } from "../../src/evaluation/budget-calculator.ts";
import { createDevelopmentConfig, generateMatrix } from "../../src/evaluation/matrix-generator.ts";
import { SEED_SCENARIOS, SEED_PROJECTS } from "../../src/evaluation/scenarios.ts";
import { CHEP_MODELS } from "../../src/evaluation/types.ts";
import { devMatrix } from "../support/matrix.ts";

test("evaluation/budget-calculator: computes total cells", () => {
  const m = devMatrix();
  const budget = calculateBudget(m);
  assert.equal(budget.totalCells, m.cells.length);
});

test("evaluation/budget-calculator: computes total runs = cells * 3", () => {
  const m = devMatrix();
  const budget = calculateBudget(m);
  assert.equal(budget.totalRuns, m.cells.length * 3);
});

test("evaluation/budget-calculator: computes total tests", () => {
  const m = devMatrix();
  const budget = calculateBudget(m);
  assert.equal(budget.totalTests, m.tests.length);
});

test("evaluation/budget-calculator: computes total scenarios", () => {
  const m = devMatrix();
  const budget = calculateBudget(m);
  assert.equal(budget.totalScenarios, m.scenarios.length);
});

test("evaluation/budget-calculator: computes scored scenarios", () => {
  const m = devMatrix();
  const budget = calculateBudget(m);
  assert.equal(budget.scoredScenarios, m.scenarios.filter((s) => s.scored).length);
});

test("evaluation/budget-calculator: models match matrix", () => {
  const m = devMatrix();
  const budget = calculateBudget(m);
  assert.deepEqual(budget.models, ["google/gemma-4-26B-A4B", "zai-org/GLM-5.2-NVFP4"]);
});

test("evaluation/budget-calculator: conditions match matrix", () => {
  const m = devMatrix();
  const budget = calculateBudget(m);
  assert.equal(budget.conditions, 8);
});

test("evaluation/budget-calculator: repetitions is 3", () => {
  const m = devMatrix();
  const budget = calculateBudget(m);
  assert.equal(budget.repetitions, 3);
});

test("evaluation/budget-calculator: token estimates are positive", () => {
  const m = devMatrix();
  const budget = calculateBudget(m);
  assert.ok(budget.estimatedTokensPerCall.min > 0);
  assert.ok(budget.estimatedTokensPerCall.expected > 0);
  assert.ok(budget.estimatedTokensPerCall.max > 0);
  assert.ok(budget.estimatedTokensPerCall.min <= budget.estimatedTokensPerCall.expected);
  assert.ok(budget.estimatedTokensPerCall.expected <= budget.estimatedTokensPerCall.max);
});

test("evaluation/budget-calculator: wall time estimates are positive", () => {
  const m = devMatrix();
  const budget = calculateBudget(m);
  assert.ok(budget.estimatedWallTimeSeconds.min > 0);
  assert.ok(budget.estimatedWallTimeSeconds.expected > 0);
  assert.ok(budget.estimatedWallTimeSeconds.max > 0);
});

test("evaluation/budget-calculator: total tokens expected is positive", () => {
  const m = devMatrix();
  const budget = calculateBudget(m);
  assert.ok(budget.totalTokensExpected > 0);
});

test("evaluation/budget-calculator: total tokens worst >= expected", () => {
  const m = devMatrix();
  const budget = calculateBudget(m);
  assert.ok(budget.totalTokensWorst >= budget.totalTokensExpected);
});

test("evaluation/budget-calculator: wall time worst >= expected", () => {
  const m = devMatrix();
  const budget = calculateBudget(m);
  assert.ok(budget.totalWallTimeSecondsWorst >= budget.totalWallTimeSecondsExpected);
});

test("evaluation/budget-calculator: storage estimate is positive", () => {
  const m = devMatrix();
  const budget = calculateBudget(m);
  assert.ok(budget.estimatedStorageBytes > 0);
});

test("evaluation/budget-calculator: timeline records = runs * 12", () => {
  const m = devMatrix();
  const budget = calculateBudget(m);
  assert.equal(budget.estimatedTimelineRecords, budget.totalRuns * 12);
});

test("evaluation/budget-calculator: max concurrency default is 3", () => {
  const m = devMatrix();
  const budget = calculateBudget(m);
  assert.equal(budget.maxConcurrency, 3);
});

test("evaluation/budget-calculator: max concurrency can be overridden", () => {
  const m = devMatrix();
  const budget = calculateBudget(m, { maxConcurrency: 10 });
  assert.equal(budget.maxConcurrency, 10);
});

test("evaluation/budget-calculator: higher concurrency reduces wall time", () => {
  const m = devMatrix();
  const budget3 = calculateBudget(m, { maxConcurrency: 3 });
  const budget10 = calculateBudget(m, { maxConcurrency: 10 });
  assert.ok(budget10.totalWallTimeSecondsExpected < budget3.totalWallTimeSecondsExpected);
});

test("evaluation/budget-calculator: budget respects custom token estimates", () => {
  const m = devMatrix();
  const budget = calculateBudget(m, {
    tokenEstimates: {
      promptTokensPerCall: { min: 500, expected: 2000, max: 8000 },
      completionTokensPerCall: { min: 200, expected: 3000, max: 12000 },
    },
  });
  assert.equal(budget.estimatedTokensPerCall.min, 700);
  assert.equal(budget.estimatedTokensPerCall.expected, 5000);
  assert.equal(budget.estimatedTokensPerCall.max, 20000);
});

test("evaluation/budget-calculator: formatBudgetReport produces non-empty string", () => {
  const m = devMatrix();
  const budget = calculateBudget(m);
  const report = formatBudgetReport(budget);
  assert.ok(report.length > 0);
  assert.ok(report.includes("CHEP-1.0 Budget Report"));
});

test("evaluation/budget-calculator: formatBudgetReport includes total cells", () => {
  const m = devMatrix();
  const budget = calculateBudget(m);
  const report = formatBudgetReport(budget);
  assert.ok(report.includes(`Total cells:`));
});

test("evaluation/budget-calculator: formatBudgetReport includes model names", () => {
  const m = devMatrix();
  const budget = calculateBudget(m);
  const report = formatBudgetReport(budget);
  assert.ok(report.includes("gemma"));
  assert.ok(report.includes("GLM"));
});

test("evaluation/budget-calculator: budget scales with matrix size", () => {
  const smallMatrix = generateMatrix({
    ...createDevelopmentConfig(SEED_SCENARIOS, SEED_PROJECTS),
    phaseCounts: {
      "P0-shakedown": 1,
      "P1-baseline": 2,
      "P2-development": 1,
      "P3-holdout": 1,
    },
  });
  const largeMatrix = devMatrix();
  const smallBudget = calculateBudget(smallMatrix);
  const largeBudget = calculateBudget(largeMatrix);
  assert.ok(largeBudget.totalCells >= smallBudget.totalCells);
  assert.ok(largeBudget.totalTokensExpected >= smallBudget.totalTokensExpected);
});

test("evaluation/budget-calculator: empty matrix produces zero counts", () => {
  const emptyMatrix = generateMatrix({
    phaseCounts: { "P0-shakedown": 0, "P1-baseline": 0, "P2-development": 0, "P3-holdout": 0 },
    seedScenarios: SEED_SCENARIOS,
    projects: SEED_PROJECTS,
    createdAt: "2026-07-17T00:00:00.000Z",
    maxOutputTokens: 4096,
    models: [...CHEP_MODELS],
  });
  const budget = calculateBudget(emptyMatrix);
  assert.equal(budget.totalCells, 0);
  assert.equal(budget.totalRuns, 0);
  assert.equal(budget.totalTokensExpected, 0);
});

test("evaluation/budget-calculator: production matrix budget has correct cell count", () => {
  const m = generateMatrix({
    phaseCounts: { "P0-shakedown": 64, "P1-baseline": 512, "P2-development": 256, "P3-holdout": 256 },
    seedScenarios: SEED_SCENARIOS,
    projects: SEED_PROJECTS,
    createdAt: "2026-07-17T00:00:00.000Z",
    maxOutputTokens: 16384,
    models: [...CHEP_MODELS],
  });
  const budget = calculateBudget(m);
  assert.equal(budget.totalCells, 6144);
  assert.equal(budget.totalRuns, 18432);
  assert.equal(budget.totalTests, 3072);
  assert.equal(budget.scoredScenarios, 1024);
});
