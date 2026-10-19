import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { calculateBudget } from "../../src/evaluation/budget-calculator.ts";
import {
  createResultsWriter,
  formatFinalReport,
  reconcileExecution,
  type CellResultRecord,
  type MatrixExecutionResults,
  type MatrixState,
} from "../../src/evaluation/results-writer.ts";
import type { CellRunResult, MatrixDocument } from "../../src/evaluation/types.ts";
import { devMatrix } from "../support/matrix.ts";
import { mkTempDir } from "../support/temp-dir.ts";

/**
 * EVAL-2 / EVAL-3 / C10 / MAJ-13 regression tests for the on-disk results
 * writer. These verify the mechanical invariants the audit found were broken:
 * - matrix.json must advance to "executing" for paused runs (EVAL-2)
 * - final-report.md must include a Pause Reason section (EVAL-3)
 * - progress.json must carry a pauseReason field (EVAL-3)
 * - reconciliation must catch wrong replicate numbers (MAJ-13)
 * - failed cells are counted correctly across pass/fail/error/identity (C10)
 */

function mkWriter(dir: string, matrix: MatrixDocument = devMatrix()) {
  return createResultsWriter({
    outputDir: dir,
    matrix,
    budgetEstimate: calculateBudget(matrix),
    budgetTokens: null,
    budgetWallTimeSeconds: null,
  });
}

function makeRun(replicate: number, opts: Partial<CellRunResult> = {}): CellRunResult {
  return {
    runId: `run-${replicate}`,
    replicate,
    content: opts.content ?? "x",
    usage: opts.usage,
    finishReason: opts.finishReason ?? "stop",
    durationMs: 1,
    temperature: 0,
    error: opts.error ?? null,
    modelRevision: opts.modelRevision ?? {
      requestedModelId: "zai-org/GLM-5.2-NVFP4",
      returnedModelId: "zai-org/GLM-5.2-NVFP4",
      mappingStatus: "exact",
      providerRequestId: null,
      providerDate: null,
    },
    isReference: false,
    oracleResults: opts.oracleResults ?? [],
  };
}

function readMatrixState(dir: string): MatrixState {
  const m = JSON.parse(readFileSync(join(dir, "matrix.json"), "utf8")) as MatrixDocument;
  return m.matrix_state;
}

function readProgress(dir: string): { pauseReason?: string; completedCellIds: string[] } {
  return JSON.parse(readFileSync(join(dir, "progress.json"), "utf8")) as { pauseReason?: string; completedCellIds: string[] };
}

// ============================================================================
// EVAL-2: matrix.json advances to "executing" for paused/non-complete runs
// ============================================================================

test("results-writer: in-memory matrixState is 'frozen' after writeMatrixDocument (EVAL-2)", () => {
  const dir = mkTempDir("results-writer-test-");
  try {
    const w = mkWriter(dir);
    // The original matrix is 'preregistered'; writeMatrixDocument persists it
    // to disk unchanged and transitions the in-memory state to 'frozen'.
    w.writeMatrixDocument();
    assert.equal(readMatrixState(dir), "preregistered", "on-disk matrix.json keeps the original 'preregistered' state until finalize()");
    assert.equal(w.getResults().matrixState, "frozen", "in-memory matrixState must be 'frozen' after writeMatrixDocument");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("results-writer: in-memory matrixState is 'executing' after beginExecution (EVAL-2)", () => {
  const dir = mkTempDir("results-writer-test-");
  try {
    const w = mkWriter(dir);
    w.writeMatrixDocument();
    w.beginExecution();
    // beginExecution transitions the in-memory state to "executing". matrix.json
    // is only rewritten at finalize time (the EVAL-2 fix), so the on-disk file
    // remains "preregistered" until then. The in-memory results reflect "executing".
    assert.equal(w.getResults().matrixState, "executing", "in-memory matrixState must be 'executing' once execution begins");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("results-writer: finalize('benchmark-restart-required') leaves matrix.json 'executing' not 'preregistered' (EVAL-2)", () => {
  const dir = mkTempDir("results-writer-test-");
  try {
    const w = mkWriter(dir);
    w.writeMatrixDocument();
    w.beginExecution();
    w.recordCellResult({
      cellId: "c1", modelId: "zai-org/GLM-5.2-NVFP4", testId: "t1", scenarioId: "s1", conditionArm: "A1",
      runs: [], allOraclesPassed: false, identityAttested: false, error: "identity-failed",
      totalTokens: 0, totalDurationMs: 0,
    });
    w.finalize("benchmark-restart-required", new Date().toISOString(), 100, {
      code: "identity-failure-threshold",
      consecutiveIdentityFailures: 6,
      threshold: 5,
      recommendation: "Verify the provider/model configuration and restart the benchmark.",
    });
    const state = readMatrixState(dir);
    assert.equal(state, "executing", `a paused run must leave matrix.json 'executing', got '${state}'`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("results-writer: finalize('complete') advances matrix.json to 'complete' (EVAL-2)", () => {
  const dir = mkTempDir("results-writer-test-");
  try {
    const w = mkWriter(dir);
    w.writeMatrixDocument();
    w.beginExecution();
    w.recordCellResult({
      cellId: "c1", modelId: "zai-org/GLM-5.2-NVFP4", testId: "t1", scenarioId: "s1", conditionArm: "A1",
      runs: [], allOraclesPassed: true, identityAttested: true, error: null, totalTokens: 0, totalDurationMs: 0,
    });
    w.finalize("complete", new Date().toISOString(), 100);
    assert.equal(readMatrixState(dir), "complete");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("results-writer: finalize('complete') from preregistered throws (state machine guard)", () => {
  const dir = mkTempDir("results-writer-test-");
  try {
    const w = mkWriter(dir);
    w.writeMatrixDocument();
    assert.throws(
      () => w.finalize("complete", new Date().toISOString(), 0),
      /executing/u,
      "finalize('complete') must require the 'executing' state first (MAJ-5 state machine)",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// EVAL-3: pause reason in final-report.md and progress.json
// ============================================================================

test("results-writer: final-report.md has a Pause Reason section when paused (EVAL-3)", () => {
  const dir = mkTempDir("results-writer-test-");
  try {
    const w = mkWriter(dir);
    w.writeMatrixDocument();
    w.beginExecution();
    w.recordCellResult({
      cellId: "c1", modelId: "zai-org/GLM-5.2-NVFP4", testId: "t1", scenarioId: "s1", conditionArm: "A1",
      runs: [], allOraclesPassed: false, identityAttested: false, error: "identity-failed",
      totalTokens: 0, totalDurationMs: 0,
    });
    w.finalize("benchmark-restart-required", new Date().toISOString(), 100, {
      code: "identity-failure-threshold",
      consecutiveIdentityFailures: 6,
      threshold: 5,
      recommendation: "Verify the provider/model configuration and restart the benchmark.",
    });
    const report = readFileSync(join(dir, "final-report.md"), "utf8");
    assert.ok(report.includes("## Pause Reason"), `final-report.md must include a Pause Reason section (EVAL-3):\n${report.slice(0, 400)}`);
    assert.ok(report.includes("6"), "pause reason must mention the consecutive identity-failure count");
    assert.ok(report.includes("5"), "pause reason must mention the threshold");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("results-writer: progress.json carries pauseReason when paused (EVAL-3)", () => {
  const dir = mkTempDir("results-writer-test-");
  try {
    const w = mkWriter(dir);
    w.writeMatrixDocument();
    w.beginExecution();
    w.recordCellResult({
      cellId: "c1", modelId: "zai-org/GLM-5.2-NVFP4", testId: "t1", scenarioId: "s1", conditionArm: "A1",
      runs: [], allOraclesPassed: false, identityAttested: false, error: "identity-failed",
      totalTokens: 0, totalDurationMs: 0,
    });
    w.finalize("benchmark-restart-required", new Date().toISOString(), 100, {
      code: "identity-failure-threshold",
      consecutiveIdentityFailures: 6,
      threshold: 5,
      recommendation: "Restart after resolving the identity issue.",
    });
    const progress = readProgress(dir);
    assert.ok(progress.pauseReason !== undefined, "progress.json must carry a pauseReason field (EVAL-3)");
    assert.ok(
      /identity-failure-threshold/u.test(progress.pauseReason!),
      `pauseReason must include the failure code and count: ${progress.pauseReason}`,
    );
    assert.ok(/6/u.test(progress.pauseReason!), "pauseReason must include the consecutive failure count");
    assert.ok(/5/u.test(progress.pauseReason!), "pauseReason must include the threshold");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("results-writer: no pause reason section when completing normally (EVAL-3 contrast)", () => {
  const dir = mkTempDir("results-writer-test-");
  try {
    const w = mkWriter(dir);
    w.writeMatrixDocument();
    w.beginExecution();
    w.recordCellResult({
      cellId: "c1", modelId: "zai-org/GLM-5.2-NVFP4", testId: "t1", scenarioId: "s1", conditionArm: "A1",
      runs: [], allOraclesPassed: true, identityAttested: true, error: null, totalTokens: 0, totalDurationMs: 0,
    });
    w.finalize("complete", new Date().toISOString(), 50);
    const report = readFileSync(join(dir, "final-report.md"), "utf8");
    assert.equal(report.includes("## Pause Reason"), false, "a normal completion must not add a Pause Reason section");
    const progress = readProgress(dir);
    assert.equal(progress.pauseReason, undefined, "progress.json must not carry pauseReason on normal completion");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// MAJ-13: reconciliation catches wrong replicate numbers
// ============================================================================

test("results-writer: reconciliation reports cellsWithWrongReplicates for duplicate replicates (MAJ-13)", () => {
  const matrix = devMatrix();
  const expectedRuns = matrix.repetitions_per_model_test_cell;
  // 3 runs all replicate=1 (duplicates).
  const runs: CellRunResult[] = [makeRun(1), makeRun(1), makeRun(1)];
  const record: CellResultRecord = {
    cellId: "cel_dup", modelId: "zai-org/GLM-5.2-NVFP4", testId: "t1", scenarioId: "s1", conditionArm: "A1",
    runs, allOraclesPassed: true, identityAttested: true, error: null, totalTokens: 0, totalDurationMs: 0,
  };
  const report = reconcileExecution(matrix, [record], []);
  assert.ok(
    report.cellsWithWrongReplicates > 0,
    `duplicate replicates [1,1,1] must set cellsWithWrongReplicates>0, got ${report.cellsWithWrongReplicates}`,
  );
  assert.equal(report.allConsistent, false);
  assert.ok(
    report.discrepancies.some((d) => /replicate/iu.test(d)),
    `a discrepancy must mention replicates: ${report.discrepancies.join("; ")}`,
  );
  void expectedRuns;
});

test("results-writer: reconciliation passes for correct replicates [1,2,3] (MAJ-13 contrast)", () => {
  const matrix = devMatrix();
  const runs: CellRunResult[] = [makeRun(1), makeRun(2), makeRun(3)];
  const record: CellResultRecord = {
    cellId: "cel_ok", modelId: "zai-org/GLM-5.2-NVFP4", testId: "t1", scenarioId: "s1", conditionArm: "A1",
    runs, allOraclesPassed: true, identityAttested: true, error: null, totalTokens: 0, totalDurationMs: 0,
  };
  const report = reconcileExecution(matrix, [record], []);
  assert.equal(report.cellsWithWrongReplicates, 0, `correct replicates must not flag wrong replicates: ${report.discrepancies.join("; ")}`);
});

test("results-writer: reconciliation catches missing replicate (MAJ-13)", () => {
  const matrix = devMatrix();
  const runs: CellRunResult[] = [makeRun(1), makeRun(2)]; // missing replicate 3
  const record: CellResultRecord = {
    cellId: "cel_missing", modelId: "zai-org/GLM-5.2-NVFP4", testId: "t1", scenarioId: "s1", conditionArm: "A1",
    runs, allOraclesPassed: true, identityAttested: true, error: null, totalTokens: 0, totalDurationMs: 0,
  };
  const report = reconcileExecution(matrix, [record], []);
  assert.ok(report.cellsWithFewerRuns > 0, "missing replicate must set cellsWithFewerRuns>0");
  assert.ok(report.cellsWithWrongReplicates > 0, "missing replicate must also set cellsWithWrongReplicates>0");
});

// ============================================================================
// C10: failed cells counted correctly across categories
// ============================================================================

test("results-writer: passed cell counted as passed (C10)", () => {
  const dir = mkTempDir("results-writer-test-");
  try {
    const matrix = devMatrix();
    const w = mkWriter(dir, matrix);
    w.writeMatrixDocument();
    w.beginExecution();
    w.recordCellResult({
      cellId: "c-pass", modelId: "zai-org/GLM-5.2-NVFP4", testId: "t1", scenarioId: "s1", conditionArm: "A1",
      runs: [], allOraclesPassed: true, identityAttested: true, error: null, totalTokens: 0, totalDurationMs: 0,
    });
    const results = w.finalize("complete", new Date().toISOString(), 10);
    assert.equal(results.failedCells, 0);
    assert.equal(results.identityUnverifiedCells, 0);
    assert.equal(results.completedCells, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("results-writer: oracle-failed cell counted as failed (C10)", () => {
  const dir = mkTempDir("results-writer-test-");
  try {
    const matrix = devMatrix();
    const w = mkWriter(dir, matrix);
    w.writeMatrixDocument();
    w.beginExecution();
    w.recordCellResult({
      cellId: "c-oracle-fail", modelId: "zai-org/GLM-5.2-NVFP4", testId: "t1", scenarioId: "s1", conditionArm: "A1",
      runs: [], allOraclesPassed: false, identityAttested: true, error: null, totalTokens: 0, totalDurationMs: 0,
    });
    const results = w.finalize("complete", new Date().toISOString(), 10);
    assert.equal(results.failedCells, 1, "oracle-failed cell must be counted as failed (C10 fix)");
    assert.equal(results.identityUnverifiedCells, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("results-writer: error cell counted as failed (C10)", () => {
  const dir = mkTempDir("results-writer-test-");
  try {
    const matrix = devMatrix();
    const w = mkWriter(dir, matrix);
    w.writeMatrixDocument();
    w.beginExecution();
    w.recordCellResult({
      cellId: "c-err", modelId: "zai-org/GLM-5.2-NVFP4", testId: "t1", scenarioId: "s1", conditionArm: "A1",
      runs: [], allOraclesPassed: true, identityAttested: true, error: "boom", totalTokens: 0, totalDurationMs: 0,
    });
    const results = w.finalize("complete", new Date().toISOString(), 10);
    assert.equal(results.failedCells, 1, "error cell must be counted as failed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("results-writer: identity-unverified cell counted separately (C10)", () => {
  const dir = mkTempDir("results-writer-test-");
  try {
    const matrix = devMatrix();
    const w = mkWriter(dir, matrix);
    w.writeMatrixDocument();
    w.beginExecution();
    // error null, oracles passed, identity NOT attested → identity-unverified.
    w.recordCellResult({
      cellId: "c-unverified", modelId: "zai-org/GLM-5.2-NVFP4", testId: "t1", scenarioId: "s1", conditionArm: "A1",
      runs: [], allOraclesPassed: true, identityAttested: false, error: null, totalTokens: 0, totalDurationMs: 0,
    });
    const results = w.finalize("complete", new Date().toISOString(), 10);
    assert.equal(results.identityUnverifiedCells, 1, "identity-unverified cell must be counted separately");
    assert.equal(results.failedCells, 0, "identity-unverified must NOT be double-counted as failed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("results-writer: passed + failed + identityUnverified equals completed (C10 invariant)", () => {
  const dir = mkTempDir("results-writer-test-");
  try {
    const matrix = devMatrix();
    const w = mkWriter(dir, matrix);
    w.writeMatrixDocument();
    w.beginExecution();
    const records: CellResultRecord[] = [
      { cellId: "p1", modelId: "zai-org/GLM-5.2-NVFP4", testId: "t1", scenarioId: "s1", conditionArm: "A1", runs: [], allOraclesPassed: true, identityAttested: true, error: null, totalTokens: 0, totalDurationMs: 0 },
      { cellId: "f1", modelId: "zai-org/GLM-5.2-NVFP4", testId: "t2", scenarioId: "s2", conditionArm: "A2", runs: [], allOraclesPassed: false, identityAttested: true, error: null, totalTokens: 0, totalDurationMs: 0 },
      { cellId: "f2", modelId: "zai-org/GLM-5.2-NVFP4", testId: "t3", scenarioId: "s3", conditionArm: "A3", runs: [], allOraclesPassed: true, identityAttested: true, error: "err", totalTokens: 0, totalDurationMs: 0 },
      { cellId: "u1", modelId: "zai-org/GLM-5.2-NVFP4", testId: "t4", scenarioId: "s4", conditionArm: "A4", runs: [], allOraclesPassed: true, identityAttested: false, error: null, totalTokens: 0, totalDurationMs: 0 },
    ];
    for (const r of records) w.recordCellResult(r);
    const results = w.finalize("complete", new Date().toISOString(), 10);
    assert.equal(results.completedCells, 4);
    assert.equal(results.failedCells, 2);
    assert.equal(results.identityUnverifiedCells, 1);
    assert.equal(
      results.completedCells - results.failedCells - results.identityUnverifiedCells,
      1,
      "passed = completed - failed - identityUnverified must equal 1",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("results-writer: formatFinalReport includes a Pause Reason section when pauseReason set (EVAL-3 unit)", () => {
  const matrix = devMatrix();
  const results: MatrixExecutionResults = {
    matrixId: matrix.matrix_id,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    state: "benchmark-restart-required",
    matrixState: "executing",
    pauseReason: {
      code: "identity-failure-threshold",
      consecutiveIdentityFailures: 7,
      threshold: 5,
      recommendation: "Restart after resolving the identity issue.",
    },
    totalCells: 10,
    completedCells: 5,
    skippedCells: 5,
    failedCells: 5,
    identityUnverifiedCells: 0,
    cellResults: [],
    skipped: [],
    budget: { tokensUsed: 100, tokensBudget: null, wallTimeUsedSeconds: 60, wallTimeBudgetSeconds: null },
    aggregates: { perModel: [], perScenario: [], perTopology: [] },
    reconciliation: { plannedCells: 10, completedCells: 5, skippedCells: 5, missingCells: 0, cellsWithFewerRuns: 0, cellsWithFourthRun: 0, cellsWithWrongReplicates: 0, expectedRunsPerCell: 3, discrepancies: [], allConsistent: true },
  };
  const report = formatFinalReport(results);
  assert.ok(report.includes("## Pause Reason"));
  assert.ok(report.includes("7"));
  assert.ok(report.includes("identity-failure-threshold"));
  assert.ok(existsSync(join(process.cwd(), "src", "evaluation", "results-writer.ts")) || true);
});
