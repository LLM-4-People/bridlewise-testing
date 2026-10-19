import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createTimelineStore } from "../../src/timeline/timeline-store.ts";
import { createTimelineRecorder } from "../../src/timeline/timeline-recorder.ts";
import type { TimelineRecorder } from "../../src/timeline/timeline-recorder.ts";
import { createDevelopmentConfig, generateMatrix, buildScenarioPromptIndex } from "../../src/evaluation/matrix-generator.ts";
import { executeMatrix, buildCellToArmMap } from "../../src/evaluation/matrix-executor.ts";
import {
  createResultsWriter,
  formatFinalReport,
  type CellResultRecord,
  type MatrixExecutionResults,
} from "../../src/evaluation/results-writer.ts";
import { createScenarioRunner } from "../../src/evaluation/scenario-runner.ts";
import { SEED_SCENARIOS, SEED_PROJECTS } from "../../src/evaluation/scenarios.ts";
import { calculateBudget, formatBudgetReport } from "../../src/evaluation/budget-calculator.ts";
import type {
  CellExecutionRequest,
  CellRecord,
  MatrixDocument,
} from "../../src/evaluation/types.ts";
import type { ChatStreamEvent, ProviderAdapter } from "../../src/runtime/provider-adapter.ts";
import { parseEvalArgs } from "../../src/evaluation/cli.ts";
import { makeMockProvider as sharedMakeMockProvider } from "../support/mock-provider.ts";
import { makeTimelineRecorder } from "../support/timeline.ts";
import { devMatrix } from "../support/matrix.ts";
import { mkTempDir } from "../support/temp-dir.ts";
import { address, serve, type UpstreamRequest } from "../support/loopback-upstream.ts";

/**
 * Positional adapter over the shared `makeMockProvider` options factory. The
 * provider implementation lives once in `test/support/mock-provider.ts`; this
 * shim only translates the legacy `(content, usage?)` call shape used by this
 * file's call sites so they need no per-call rewrite.
 */
function makeMockProvider(
  content: string,
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number },
): ProviderAdapter {
  return sharedMakeMockProvider({
    content,
    ...(usage !== undefined ? { usage } : {}),
  });
}

function makeFailingProvider(): ProviderAdapter {
  return {
    providerId: "mock-fail",
    async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> {
      throw new Error("provider unavailable");
    },
    async chatCompletion(): Promise<{ content: string; toolCalls: readonly never[]; usage: undefined; finishReason: string }> {
      throw new Error("provider unavailable");
    },
  };
}

// A response that satisfies every seed scenario's hidden oracles (contains the
// required keywords and avoids every not-contains oracle). Used by tests that
// need "provider succeeds AND all oracles pass" regardless of which cell runs.
const PASS_ALL_RESPONSE =
  "reverseString return @param @returns async await formatDate range(1, n+1) " +
  "POST valid 201 HashMap try catch fix timezone test quote security injection -1 " +
  "function add ( None if b == 0";

const mkTimeline = (dir: string) => makeTimelineRecorder(dir, "eval-executor-test");

function makeRequestFactory(matrix: MatrixDocument): (cell: CellRecord, prompt: string) => CellExecutionRequest {
  const cellToArm = buildCellToArmMap(matrix);
  const mockRefFetch = async (_url: string, init: UpstreamRequest): Promise<Response> => {
    const body = JSON.parse(init.body as string) as { messages?: { content?: string }[] };
    const isProbe = body.messages?.[0]?.content === "Reply with exactly: IDENTITY_PROBE_OK";
    const content = isProbe ? "IDENTITY_PROBE_OK" : PASS_ALL_RESPONSE;
    return new Response(JSON.stringify({
      choices: [{ message: { content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), {
      status: 200,
      headers: { "content-type": "application/json", "x-request-id": "ref-req-001", "date": "Wed, 17 Jul 2026 12:00:00 GMT" },
    });
  };
  serve(mockRefFetch);
  return (cell, prompt) => ({
    matrix,
    cellId: cell.cell_id,
    scenarioPrompt: prompt,
    providerConfig: {
      id: "makora",
      baseUrl: address("https://inference.makora.com/v1"),
      apiKeyEnvVar: "MAKORA_API_KEY",
      timeoutMs: 60000,
      retries: { maxRetries: 3, initialBackoffMs: 500, maxBackoffMs: 10000, backoffMultiplier: 2 },
    },
    apiKey: "mock-key",
    maxTokens: 256,
    runReferenceTransport: cellToArm.get(cell.cell_id) === "R1-reference",
  } as CellExecutionRequest);
}

function makePromptResolver(matrix: MatrixDocument): (cellId: string) => string {
  const config = createDevelopmentConfig(SEED_SCENARIOS, SEED_PROJECTS);
  const index = buildScenarioPromptIndex(config);
  return (cellId) => {
    const cell = matrix.cells.find((c) => c.cell_id === cellId);
    if (cell === undefined) throw new Error(`cell not found: ${cellId}`);
    const testEntry = matrix.tests.find((t) => t.test_id === cell.test_id);
    if (testEntry === undefined) throw new Error(`test not found: ${cellId}`);
    const prompt = index.get(testEntry.scenario_id);
    if (prompt === undefined) throw new Error(`prompt not found: ${testEntry.scenario_id}`);
    return prompt;
  };
}

type ExecutorHarness = Readonly<{
  dir: string;
  matrix: MatrixDocument;
  writer: ReturnType<typeof createResultsWriter>;
  timeline: TimelineRecorder;
  progress: { updates: import("../../src/evaluation/matrix-executor.ts").ProgressUpdate[] };
}>;

async function runExecutor(adapter: ProviderAdapter, overrides: Record<string, unknown> = {}): Promise<{
  outcome: import("../../src/evaluation/matrix-executor.ts").MatrixExecutorOutcome;
  harness: ExecutorHarness;
}> {
  const dir = mkTempDir("eval-executor-test-");
  const matrix = devMatrix();
  const budget = calculateBudget(matrix);
  const writer = createResultsWriter({
    outputDir: dir,
    matrix,
    budgetEstimate: budget,
    budgetTokens: (overrides.budgetTokens as number | undefined) ?? null,
    budgetWallTimeSeconds: (overrides.budgetWallTimeSeconds as number | undefined) ?? null,
  });
  writer.writeMatrixDocument();
  const timeline = mkTimeline(dir);
  const progress = { updates: [] as import("../../src/evaluation/matrix-executor.ts").ProgressUpdate[] };
  const runner = createScenarioRunner({ adapter });
  const outcome = await executeMatrix({
    matrix,
    runner,
    resolvePrompt: makePromptResolver(matrix),
    buildCellRequest: makeRequestFactory(matrix),
    resultsWriter: writer,
    timeline,
    concurrency: (overrides.concurrency as number | undefined) ?? 3,
    ...(overrides.budgetTokens !== undefined ? { budgetTokens: overrides.budgetTokens as number } : {}),
    ...(overrides.budgetWallTimeSeconds !== undefined ? { budgetWallTimeSeconds: overrides.budgetWallTimeSeconds as number } : {}),
    ...(overrides.limitScenarios !== undefined ? { limitScenarios: overrides.limitScenarios as number } : {}),
    ...(overrides.limitCells !== undefined ? { limitCells: overrides.limitCells as number } : {}),
    ...(overrides.maxRunsPerCell !== undefined ? { maxRunsPerCell: overrides.maxRunsPerCell as number } : {}),
    ...(overrides.resume !== undefined ? { resume: overrides.resume as boolean } : {}),
    onProgress: (u) => progress.updates.push(u),
  } as import("../../src/evaluation/matrix-executor.ts").MatrixExecutorOptions);
  return { outcome, harness: { dir, matrix, writer, timeline, progress } };
}

function readResults(dir: string): MatrixExecutionResults {
  return JSON.parse(readFileSync(join(dir, "results.json"), "utf8")) as MatrixExecutionResults;
}

function readProgress(dir: string): { completedCellIds: string[]; skippedCellIds: string[]; tokensUsed: number } {
  return JSON.parse(readFileSync(join(dir, "progress.json"), "utf8")) as { completedCellIds: string[]; skippedCellIds: string[]; tokensUsed: number };
}

test("evaluation/matrix-executor: executes all cells and reaches complete state", async () => {
  const { outcome } = await runExecutor(makeMockProvider("test response"));
  assert.equal(outcome.state, "complete");
  assert.equal(outcome.completedCells, devMatrix().cells.length);
  assert.equal(outcome.skippedCells, 0);
});

test("evaluation/matrix-executor: total cells equals matrix cell count", async () => {
  const { outcome } = await runExecutor(makeMockProvider("test"));
  assert.equal(outcome.totalCells, devMatrix().cells.length);
});

test("evaluation/matrix-executor: completed cells have 3 runs each by default", async () => {
  const { harness } = await runExecutor(makeMockProvider("test"));
  const results = readResults(harness.dir);
  for (const cr of results.cellResults) {
    assert.equal(cr.runs.length, 3, `cell ${cr.cellId} should have 3 runs`);
  }
});

test("evaluation/matrix-executor: maxRunsPerCell limits runs per cell", async () => {
  const { harness } = await runExecutor(makeMockProvider("test"), { maxRunsPerCell: 1 });
  const results = readResults(harness.dir);
  for (const cr of results.cellResults) {
    assert.equal(cr.runs.length, 1);
  }
});

test("evaluation/matrix-executor: cell order is deterministic for the same matrix", async () => {
  const matrix = devMatrix();
  const dir1 = mkTempDir("eval-executor-test-");
  const dir2 = mkTempDir("eval-executor-test-");
  try {
    const w1 = createResultsWriter({ outputDir: dir1, matrix, budgetEstimate: calculateBudget(matrix), budgetTokens: null, budgetWallTimeSeconds: null });
    w1.writeMatrixDocument();
    const w2 = createResultsWriter({ outputDir: dir2, matrix, budgetEstimate: calculateBudget(matrix), budgetTokens: null, budgetWallTimeSeconds: null });
    w2.writeMatrixDocument();
    const runner = createScenarioRunner({ adapter: makeMockProvider("test") });
    // ONE cell at a time: the ORDER under test is the executor's schedule (a
    // seeded shuffle). With parallel workers the results record completion
    // order, and the reference cells now cross a real (loopback) connection,
    // so their completion timing is the network's, not the schedule's.
    const [o1, o2] = await Promise.all([
      executeMatrix({ matrix, runner, resolvePrompt: makePromptResolver(matrix), buildCellRequest: makeRequestFactory(matrix), resultsWriter: w1, timeline: mkTimeline(dir1), concurrency: 1 }),
      executeMatrix({ matrix, runner, resolvePrompt: makePromptResolver(matrix), buildCellRequest: makeRequestFactory(matrix), resultsWriter: w2, timeline: mkTimeline(dir2), concurrency: 1 }),
    ]);
    const r1 = readResults(dir1);
    const r2 = readResults(dir2);
    assert.equal(r1.cellResults.length, r2.cellResults.length);
    assert.deepEqual(r1.cellResults.map((c) => c.cellId), r2.cellResults.map((c) => c.cellId));
    assert.equal(o1.state, "complete");
    assert.equal(o2.state, "complete");
  } finally {
    rmSync(dir1, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  }
});

test("evaluation/matrix-executor: shuffle produces a permutation of all cell IDs", async () => {
  const { harness } = await runExecutor(makeMockProvider("test"));
  const results = readResults(harness.dir);
  const completedIds = new Set(results.cellResults.map((c) => c.cellId));
  const allIds = new Set(harness.matrix.cells.map((c) => c.cell_id));
  assert.equal(completedIds.size, allIds.size);
  for (const id of allIds) assert.ok(completedIds.has(id), `missing cell ${id}`);
});

test("evaluation/matrix-executor: concurrency=1 runs all cells sequentially", async () => {
  const { outcome } = await runExecutor(makeMockProvider("test"), { concurrency: 1 });
  assert.equal(outcome.state, "complete");
  assert.equal(outcome.completedCells, devMatrix().cells.length);
});

test("evaluation/matrix-executor: concurrency higher than cell count still completes", async () => {
  const { outcome } = await runExecutor(makeMockProvider("test"), { concurrency: 999 });
  assert.equal(outcome.state, "complete");
  assert.equal(outcome.completedCells, devMatrix().cells.length);
});

test("evaluation/matrix-executor: budget tokens stops and records skipped cells", async () => {
  const { outcome, harness } = await runExecutor(makeMockProvider("test", { promptTokens: 10, completionTokens: 20, totalTokens: 30 }), { budgetTokens: 100 });
  assert.equal(outcome.state, "budget-exhausted");
  assert.ok(outcome.skippedCells > 0, "should have skipped cells");
  assert.ok(outcome.completedCells > 0, "should have completed some cells");
  const results = readResults(harness.dir);
  assert.ok(results.skipped.length > 0, "skipped list should be non-empty");
  for (const s of results.skipped) {
    assert.ok(s.reason.includes("budget-exhausted"), `reason should mention budget: ${s.reason}`);
  }
});

test("evaluation/matrix-executor: budget wall-time stops and records skipped cells", async () => {
  const { outcome, harness } = await runExecutor(makeMockProvider("test"), { budgetWallTimeSeconds: 0 });
  assert.equal(outcome.state, "budget-exhausted");
  assert.ok(outcome.skippedCells > 0);
  const results = readResults(harness.dir);
  assert.ok(results.skipped.length > 0);
});

test("evaluation/matrix-executor: single cell failure does not abort the matrix", async () => {
  // M2: a fully-failing provider triggers >5 consecutive identity failures,
  // which pauses execution (benchmark-restart-required). Keep the cell count
  // below the threshold so the matrix still completes and each failing cell
  // is recorded rather than skipped.
  const { outcome, harness } = await runExecutor(makeFailingProvider(), { limitCells: 4 });
  assert.equal(outcome.state, "complete");
  assert.equal(outcome.completedCells, 4);
  const results = readResults(harness.dir);
  for (const cr of results.cellResults) {
    assert.equal(cr.identityAttested, false);
  }
});

test("evaluation/matrix-executor: progressive results.json is written after each cell", async () => {
  const dir = mkTempDir("eval-executor-test-");
  try {
    const matrix = devMatrix();
    const writer = createResultsWriter({ outputDir: dir, matrix, budgetEstimate: calculateBudget(matrix), budgetTokens: null, budgetWallTimeSeconds: null });
    writer.writeMatrixDocument();
    const runner = createScenarioRunner({ adapter: makeMockProvider("test") });
    let writeCount = 0;
    const originalRecord = writer.recordCellResult;
    const wrappedWriter: typeof writer = {
      ...writer,
      recordCellResult: (r) => { originalRecord(r); writeCount++; assert.ok(existsSync(join(dir, "results.json")), "results.json must exist after each cell"); },
    };
    await executeMatrix({ matrix, runner, resolvePrompt: makePromptResolver(matrix), buildCellRequest: makeRequestFactory(matrix), resultsWriter: wrappedWriter, timeline: mkTimeline(dir) });
    assert.ok(writeCount > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/matrix-executor: progress callback invoked with completed count", async () => {
  const { harness } = await runExecutor(makeMockProvider("test"));
  assert.ok(harness.progress.updates.length > 0);
  const last = harness.progress.updates[harness.progress.updates.length - 1]!;
  assert.equal(last.completedCells, devMatrix().cells.length);
  assert.equal(last.state, "complete");
});

test("evaluation/matrix-executor: progress callback reports current model and scenario", async () => {
  const { harness } = await runExecutor(makeMockProvider("test"), { concurrency: 1 });
  const withModel = harness.progress.updates.filter((u) => u.currentModelId !== null);
  assert.ok(withModel.length > 0);
  for (const u of withModel) {
    assert.ok(u.currentModelId === "google/gemma-4-26B-A4B" || u.currentModelId === "zai-org/GLM-5.2-NVFP4");
    assert.ok(u.currentScenarioId !== null);
  }
});

test("evaluation/matrix-executor: limitScenarios reduces total cells", async () => {
  const { outcome } = await runExecutor(makeMockProvider("test"), { limitScenarios: 1 });
  assert.equal(outcome.state, "complete");
  assert.ok(outcome.totalCells < devMatrix().cells.length);
  assert.ok(outcome.totalCells > 0);
});

test("evaluation/matrix-executor: limitCells reduces total cells", async () => {
  const { outcome } = await runExecutor(makeMockProvider("test"), { limitCells: 2 });
  assert.equal(outcome.state, "complete");
  assert.equal(outcome.completedCells, 2);
  assert.equal(outcome.totalCells, 2);
});

test("evaluation/matrix-executor: limitCells=0 runs zero cells and completes", async () => {
  const { outcome } = await runExecutor(makeMockProvider("test"), { limitCells: 0 });
  assert.equal(outcome.state, "complete");
  assert.equal(outcome.completedCells, 0);
  assert.equal(outcome.totalCells, 0);
});

test("evaluation/matrix-executor: tokens accumulate from run usage", async () => {
  const matrix = devMatrix();
  const cellToArm = buildCellToArmMap(matrix);
  // M8: probe tokens (mock usage 300) are included in addition to main-call
  // tokens (300 for non-reference cells, 15 for R1-reference fetch transport).
  const probeUsage = 300;
  const { outcome } = await runExecutor(makeMockProvider("test", { promptTokens: 100, completionTokens: 200, totalTokens: 300 }));
  assert.ok(outcome.tokensUsed > 0);
  let expected = 0;
  for (const cell of matrix.cells) {
    const isRef = cellToArm.get(cell.cell_id) === "R1-reference";
    const mainUsage = isRef ? 15 : 300;
    const tokensPerRun = probeUsage + mainUsage;
    expected += cell.runs.length * tokensPerRun;
  }
  assert.equal(outcome.tokensUsed, expected);
});

test("evaluation/matrix-executor: cell results include scenarioId and conditionArm", async () => {
  const { harness } = await runExecutor(makeMockProvider("test"));
  const results = readResults(harness.dir);
  for (const cr of results.cellResults) {
    assert.ok(cr.scenarioId.length > 0);
    assert.ok(cr.conditionArm.length > 0);
    assert.ok(cr.testId.length > 0);
  }
});

test("evaluation/matrix-executor: identity attested tracked per cell", async () => {
  const { harness } = await runExecutor(makeMockProvider("IDENTITY_PROBE_OK"));
  const results = readResults(harness.dir);
  for (const cr of results.cellResults) {
    assert.equal(cr.identityAttested, true);
  }
});

test("evaluation/matrix-executor: identity not attested when provider fails", async () => {
  const { harness } = await runExecutor(makeFailingProvider());
  const results = readResults(harness.dir);
  for (const cr of results.cellResults) {
    assert.equal(cr.identityAttested, false);
  }
});

test("evaluation/matrix-executor: aggregates computed per model", async () => {
  const { harness } = await runExecutor(makeMockProvider("test"));
  const results = readResults(harness.dir);
  assert.equal(results.aggregates.perModel.length, 2);
  const ids = results.aggregates.perModel.map((m) => m.modelId).sort();
  assert.deepEqual(ids, ["google/gemma-4-26B-A4B", "zai-org/GLM-5.2-NVFP4"]);
});

test("evaluation/matrix-executor: per-model aggregates sum to total cells", async () => {
  const { harness } = await runExecutor(makeMockProvider("test"));
  const results = readResults(harness.dir);
  const sum = results.aggregates.perModel.reduce((a, m) => a + m.cells, 0);
  assert.equal(sum, results.completedCells);
});

test("evaluation/matrix-executor: per-model runs equal completed cells * 3", async () => {
  const { harness } = await runExecutor(makeMockProvider("test"));
  const results = readResults(harness.dir);
  const sumRuns = results.aggregates.perModel.reduce((a, m) => a + m.runs, 0);
  assert.equal(sumRuns, results.completedCells * 3);
});

test("evaluation/matrix-executor: per-topology aggregates computed", async () => {
  const { harness } = await runExecutor(makeMockProvider("test"));
  const results = readResults(harness.dir);
  assert.ok(results.aggregates.perTopology.length > 0);
});

test("evaluation/matrix-executor: per-scenario aggregates computed", async () => {
  const { harness } = await runExecutor(makeMockProvider("test"));
  const results = readResults(harness.dir);
  assert.ok(results.aggregates.perScenario.length > 0);
});

test("evaluation/matrix-executor: resume skips already-completed cells", async () => {
  const dir = mkTempDir("eval-executor-test-");
  try {
    const matrix = devMatrix();
    const writer = createResultsWriter({ outputDir: dir, matrix, budgetEstimate: calculateBudget(matrix), budgetTokens: null, budgetWallTimeSeconds: null });
    writer.writeMatrixDocument();
    const runner = createScenarioRunner({ adapter: makeMockProvider("test") });
    await executeMatrix({ matrix, runner, resolvePrompt: makePromptResolver(matrix), buildCellRequest: makeRequestFactory(matrix), resultsWriter: writer, timeline: mkTimeline(dir), limitCells: 4 });
    const firstProgress = readProgress(dir);
    assert.equal(firstProgress.completedCellIds.length, 4);
    const writer2 = createResultsWriter({ outputDir: dir, matrix, budgetEstimate: calculateBudget(matrix), budgetTokens: null, budgetWallTimeSeconds: null });
    const outcome2 = await executeMatrix({ matrix, runner, resolvePrompt: makePromptResolver(matrix), buildCellRequest: makeRequestFactory(matrix), resultsWriter: writer2, timeline: mkTimeline(dir), resume: true, limitCells: 4 });
    assert.equal(outcome2.completedCells, 4);
    assert.equal(outcome2.state, "complete");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/matrix-executor: resume with no prior progress runs all", async () => {
  const dir = mkTempDir("eval-executor-test-");
  try {
    const matrix = devMatrix();
    const writer = createResultsWriter({ outputDir: dir, matrix, budgetEstimate: calculateBudget(matrix), budgetTokens: null, budgetWallTimeSeconds: null });
    writer.writeMatrixDocument();
    const runner = createScenarioRunner({ adapter: makeMockProvider("test") });
    const outcome = await executeMatrix({ matrix, runner, resolvePrompt: makePromptResolver(matrix), buildCellRequest: makeRequestFactory(matrix), resultsWriter: writer, timeline: mkTimeline(dir), resume: true, limitCells: 3 });
    assert.equal(outcome.completedCells, 3);
    assert.equal(outcome.state, "complete");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/matrix-executor: signal abort stops execution with interrupted state", async () => {
  const controller = new AbortController();
  controller.abort();
  const matrix = devMatrix();
  const dir = mkTempDir("eval-executor-test-");
  try {
    const writer = createResultsWriter({ outputDir: dir, matrix, budgetEstimate: calculateBudget(matrix), budgetTokens: null, budgetWallTimeSeconds: null });
    writer.writeMatrixDocument();
    const runner = createScenarioRunner({ adapter: makeMockProvider("test") });
    const outcome = await executeMatrix({ matrix, runner, resolvePrompt: makePromptResolver(matrix), buildCellRequest: makeRequestFactory(matrix), resultsWriter: writer, timeline: mkTimeline(dir), signal: controller.signal, limitCells: 3 });
    assert.equal(outcome.state, "interrupted");
    assert.ok(outcome.skippedCells > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/matrix-executor: prompt resolution error is recorded as cell failure", async () => {
  const matrix = devMatrix();
  const dir = mkTempDir("eval-executor-test-");
  try {
    const writer = createResultsWriter({ outputDir: dir, matrix, budgetEstimate: calculateBudget(matrix), budgetTokens: null, budgetWallTimeSeconds: null });
    writer.writeMatrixDocument();
    const runner = createScenarioRunner({ adapter: makeMockProvider("test") });
    const badResolver = (): string => { throw new Error("prompt boom"); };
    const outcome = await executeMatrix({ matrix, runner, resolvePrompt: badResolver, buildCellRequest: makeRequestFactory(matrix), resultsWriter: writer, timeline: mkTimeline(dir), limitCells: 2 });
    assert.equal(outcome.state, "complete");
    assert.equal(outcome.failedCells, 2);
    const results = readResults(dir);
    for (const cr of results.cellResults) {
      assert.ok(cr.error !== null && cr.error.includes("prompt-resolution-error"));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/matrix-executor: estimatedRemainingMs is null before any completion", async () => {
  const { harness } = await runExecutor(makeMockProvider("test"), { concurrency: 1 });
  const first = harness.progress.updates[0]!;
  assert.equal(first.estimatedRemainingMs, null);
});

test("evaluation/matrix-executor: estimatedRemainingMs is a number after completion", async () => {
  const { harness } = await runExecutor(makeMockProvider("test"), { concurrency: 1 });
  const after = harness.progress.updates.find((u) => u.completedCells > 0 && u.currentModelId !== null);
  if (after !== undefined) {
    assert.ok(after.estimatedRemainingMs !== null);
  }
});

test("evaluation/matrix-executor: timeline records are created for runs", async () => {
  const dir = mkTempDir("eval-executor-test-");
  try {
    const store = createTimelineStore({ path: join(dir, "tl.db"), ledgerId: "ledger-exec-test" });
    const timeline = createTimelineRecorder({ store });
    const matrix = devMatrix();
    const writer = createResultsWriter({ outputDir: dir, matrix, budgetEstimate: calculateBudget(matrix), budgetTokens: null, budgetWallTimeSeconds: null });
    writer.writeMatrixDocument();
    const runner = createScenarioRunner({ adapter: makeMockProvider("test") });
    await executeMatrix({ matrix, runner, resolvePrompt: makePromptResolver(matrix), buildCellRequest: makeRequestFactory(matrix), resultsWriter: writer, timeline, limitCells: 1 });
    const events = store.query({});
    const runEvents = events.filter((e) => e.eventType === "run");
    assert.ok(runEvents.length > 0, "expected run events in timeline");
    timeline.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/matrix-executor: final report markdown is generated", async () => {
  const { harness } = await runExecutor(makeMockProvider("test"), { limitCells: 2 });
  assert.ok(existsSync(join(harness.dir, "final-report.md")));
  const report = readFileSync(join(harness.dir, "final-report.md"), "utf8");
  assert.ok(report.includes("CHEP-1.0 Evaluation Final Report"));
  assert.ok(report.includes("Per-Model Aggregates"));
});

test("evaluation/results-writer: writes matrix.json", () => {
  const dir = mkTempDir("eval-executor-test-");
  try {
    const matrix = devMatrix();
    const w = createResultsWriter({ outputDir: dir, matrix, budgetEstimate: calculateBudget(matrix), budgetTokens: null, budgetWallTimeSeconds: null });
    w.writeMatrixDocument();
    assert.ok(existsSync(join(dir, "matrix.json")));
    const parsed = JSON.parse(readFileSync(join(dir, "matrix.json"), "utf8")) as MatrixDocument;
    assert.equal(parsed.matrix_id, matrix.matrix_id);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/results-writer: writes budget-report.md", () => {
  const dir = mkTempDir("eval-executor-test-");
  try {
    const matrix = devMatrix();
    const w = createResultsWriter({ outputDir: dir, matrix, budgetEstimate: calculateBudget(matrix), budgetTokens: null, budgetWallTimeSeconds: null });
    w.writeBudgetReport("test budget report");
    assert.ok(existsSync(join(dir, "budget-report.md")));
    assert.equal(readFileSync(join(dir, "budget-report.md"), "utf8"), "test budget report");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/results-writer: recordCellResult writes results.json and progress.json", () => {
  const dir = mkTempDir("eval-executor-test-");
  try {
    const matrix = devMatrix();
    const w = createResultsWriter({ outputDir: dir, matrix, budgetEstimate: calculateBudget(matrix), budgetTokens: null, budgetWallTimeSeconds: null });
    const record: CellResultRecord = {
      cellId: "cel_test1", modelId: "zai-org/GLM-5.2-NVFP4", testId: "tst_1", scenarioId: "scn_1", conditionArm: "A1",
      runs: [], allOraclesPassed: true, identityAttested: true, error: null, totalTokens: 100, totalDurationMs: 50,
    };
    w.recordRunProgress(100);
    w.recordCellResult(record);
    assert.ok(existsSync(join(dir, "results.json")));
    assert.ok(existsSync(join(dir, "progress.json")));
    const progress = readProgress(dir);
    assert.deepEqual(progress.completedCellIds, ["cel_test1"]);
    assert.equal(progress.tokensUsed, 100);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/results-writer: loadProgress returns null when no progress file", () => {
  const dir = mkTempDir("eval-executor-test-");
  try {
    const matrix = devMatrix();
    const w = createResultsWriter({ outputDir: dir, matrix, budgetEstimate: calculateBudget(matrix), budgetTokens: null, budgetWallTimeSeconds: null });
    assert.equal(w.loadProgress(), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/results-writer: loadProgress returns completed cells when file exists", () => {
  const dir = mkTempDir("eval-executor-test-");
  try {
    const matrix = devMatrix();
    const w = createResultsWriter({ outputDir: dir, matrix, budgetEstimate: calculateBudget(matrix), budgetTokens: null, budgetWallTimeSeconds: null });
    w.recordCellResult({ cellId: "c1", modelId: "zai-org/GLM-5.2-NVFP4", testId: "t1", scenarioId: "s1", conditionArm: "A1", runs: [], allOraclesPassed: true, identityAttested: true, error: null, totalTokens: 10, totalDurationMs: 1 });
    const progress = w.loadProgress();
    assert.ok(progress !== null);
    assert.deepEqual(progress!.completedCellIds, ["c1"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/results-writer: recordSkipped adds to skipped list", () => {
  const dir = mkTempDir("eval-executor-test-");
  try {
    const matrix = devMatrix();
    const w = createResultsWriter({ outputDir: dir, matrix, budgetEstimate: calculateBudget(matrix), budgetTokens: null, budgetWallTimeSeconds: null });
    w.recordSkipped("cel_skip1", "budget-exhausted");
    const progress = w.loadProgress();
    assert.ok(progress !== null);
    assert.deepEqual(progress!.skippedCellIds, ["cel_skip1"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/results-writer: finalize sets state and completedAt", () => {
  const dir = mkTempDir("eval-executor-test-");
  try {
    const matrix = devMatrix();
    const w = createResultsWriter({ outputDir: dir, matrix, budgetEstimate: calculateBudget(matrix), budgetTokens: null, budgetWallTimeSeconds: null });
    w.recordCellResult({ cellId: "c1", modelId: "zai-org/GLM-5.2-NVFP4", testId: "t1", scenarioId: "s1", conditionArm: "A1", runs: [], allOraclesPassed: true, identityAttested: true, error: null, totalTokens: 10, totalDurationMs: 1 });
    const results = w.finalize("complete", new Date().toISOString(), 5000);
    assert.equal(results.state, "complete");
    assert.ok(results.completedAt !== null);
    assert.ok(existsSync(join(dir, "final-report.md")));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/results-writer: finalize with budget-exhausted sets completedAt", () => {
  const dir = mkTempDir("eval-executor-test-");
  try {
    const matrix = devMatrix();
    const w = createResultsWriter({ outputDir: dir, matrix, budgetEstimate: calculateBudget(matrix), budgetTokens: null, budgetWallTimeSeconds: null });
    const results = w.finalize("budget-exhausted", new Date().toISOString(), 1000);
    assert.equal(results.state, "budget-exhausted");
    assert.ok(results.completedAt !== null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/results-writer: finalize with interrupted sets completedAt", () => {
  const dir = mkTempDir("eval-executor-test-");
  try {
    const matrix = devMatrix();
    const w = createResultsWriter({ outputDir: dir, matrix, budgetEstimate: calculateBudget(matrix), budgetTokens: null, budgetWallTimeSeconds: null });
    const results = w.finalize("interrupted", new Date().toISOString(), 100);
    assert.ok(results.completedAt !== null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/results-writer: multiple cell results accumulate", () => {
  const dir = mkTempDir("eval-executor-test-");
  try {
    const matrix = devMatrix();
    const w = createResultsWriter({ outputDir: dir, matrix, budgetEstimate: calculateBudget(matrix), budgetTokens: null, budgetWallTimeSeconds: null });
    for (let i = 0; i < 5; i++) {
      w.recordCellResult({ cellId: `c${i}`, modelId: "zai-org/GLM-5.2-NVFP4", testId: `t${i}`, scenarioId: `s${i}`, conditionArm: "A1", runs: [], allOraclesPassed: true, identityAttested: true, error: null, totalTokens: 10, totalDurationMs: 1 });
    }
    const results = w.getResults();
    assert.equal(results.cellResults.length, 5);
    assert.equal(results.completedCells, 5);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/results-writer: tokens accumulate across cells", () => {
  const dir = mkTempDir("eval-executor-test-");
  try {
    const matrix = devMatrix();
    const w = createResultsWriter({ outputDir: dir, matrix, budgetEstimate: calculateBudget(matrix), budgetTokens: 5000, budgetWallTimeSeconds: null });
    w.recordRunProgress(100);
    w.recordCellResult({ cellId: "c1", modelId: "zai-org/GLM-5.2-NVFP4", testId: "t1", scenarioId: "s1", conditionArm: "A1", runs: [], allOraclesPassed: true, identityAttested: true, error: null, totalTokens: 100, totalDurationMs: 1 });
    w.recordRunProgress(200);
    w.recordCellResult({ cellId: "c2", modelId: "zai-org/GLM-5.2-NVFP4", testId: "t2", scenarioId: "s2", conditionArm: "A1", runs: [], allOraclesPassed: true, identityAttested: true, error: null, totalTokens: 200, totalDurationMs: 1 });
    const results = w.getResults();
    assert.equal(results.budget.tokensUsed, 300);
    assert.equal(results.budget.tokensBudget, 5000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/results-writer: skipped and completed tracked separately", () => {
  const dir = mkTempDir("eval-executor-test-");
  try {
    const matrix = devMatrix();
    const w = createResultsWriter({ outputDir: dir, matrix, budgetEstimate: calculateBudget(matrix), budgetTokens: null, budgetWallTimeSeconds: null });
    w.recordCellResult({ cellId: "c1", modelId: "zai-org/GLM-5.2-NVFP4", testId: "t1", scenarioId: "s1", conditionArm: "A1", runs: [], allOraclesPassed: true, identityAttested: true, error: null, totalTokens: 0, totalDurationMs: 0 });
    w.recordSkipped("c2", "budget");
    w.recordSkipped("c3", "budget");
    const results = w.getResults();
    assert.equal(results.completedCells, 1);
    assert.equal(results.skippedCells, 2);
    assert.equal(results.skipped.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/results-writer: failed cells counted in results", () => {
  const dir = mkTempDir("eval-executor-test-");
  try {
    const matrix = devMatrix();
    const w = createResultsWriter({ outputDir: dir, matrix, budgetEstimate: calculateBudget(matrix), budgetTokens: null, budgetWallTimeSeconds: null });
    w.recordCellResult({ cellId: "c1", modelId: "zai-org/GLM-5.2-NVFP4", testId: "t1", scenarioId: "s1", conditionArm: "A1", runs: [], allOraclesPassed: false, identityAttested: false, error: "boom", totalTokens: 0, totalDurationMs: 0 });
    const results = w.finalize("complete", new Date().toISOString(), 100);
    assert.equal(results.failedCells, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/results-writer: getResults returns executing state before finalize", () => {
  const dir = mkTempDir("eval-executor-test-");
  try {
    const matrix = devMatrix();
    const w = createResultsWriter({ outputDir: dir, matrix, budgetEstimate: calculateBudget(matrix), budgetTokens: null, budgetWallTimeSeconds: null });
    w.recordCellResult({ cellId: "c1", modelId: "zai-org/GLM-5.2-NVFP4", testId: "t1", scenarioId: "s1", conditionArm: "A1", runs: [], allOraclesPassed: true, identityAttested: true, error: null, totalTokens: 0, totalDurationMs: 0 });
    assert.equal(w.getResults().state, "executing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/results-writer: formatFinalReport includes model names", () => {
  const dir = mkTempDir("eval-executor-test-");
  try {
    const matrix = devMatrix();
    const w = createResultsWriter({ outputDir: dir, matrix, budgetEstimate: calculateBudget(matrix), budgetTokens: null, budgetWallTimeSeconds: null });
    w.recordCellResult({ cellId: "c1", modelId: "zai-org/GLM-5.2-NVFP4", testId: "t1", scenarioId: "s1", conditionArm: "A1", runs: [], allOraclesPassed: true, identityAttested: true, error: null, totalTokens: 10, totalDurationMs: 5 });
    w.recordCellResult({ cellId: "c2", modelId: "google/gemma-4-26B-A4B", testId: "t2", scenarioId: "s2", conditionArm: "A2", runs: [], allOraclesPassed: true, identityAttested: true, error: null, totalTokens: 20, totalDurationMs: 10 });
    const results = w.finalize("complete", new Date().toISOString(), 100);
    const report = formatFinalReport(results);
    assert.ok(report.includes("zai-org/GLM-5.2-NVFP4"));
    assert.ok(report.includes("google/gemma-4-26B-A4B"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/results-writer: formatFinalReport includes skipped section when present", () => {
  const matrix = devMatrix();
  const results: MatrixExecutionResults = {
    matrixId: matrix.matrix_id,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    state: "budget-exhausted",
    matrixState: "executing",
    pauseReason: null,
    totalCells: 10,
    completedCells: 5,
    skippedCells: 5,
    failedCells: 0,
    identityUnverifiedCells: 0,
    cellResults: [],
    skipped: [{ cellId: "cel_x", reason: "budget-exhausted" }],
    budget: { tokensUsed: 100, tokensBudget: 100, wallTimeUsedSeconds: 60, wallTimeBudgetSeconds: null },
    aggregates: { perModel: [], perScenario: [], perTopology: [] },
    reconciliation: { plannedCells: 10, completedCells: 5, skippedCells: 5, missingCells: 0, cellsWithFewerRuns: 0, cellsWithFourthRun: 0, cellsWithWrongReplicates: 0, expectedRunsPerCell: 3, discrepancies: [], allConsistent: true },
  };
  const report = formatFinalReport(results);
  assert.ok(report.includes("Skipped Cells"));
  assert.ok(report.includes("cel_x"));
});

test("evaluation/results-writer: formatFinalReport shows none for no failures", () => {
  const matrix = devMatrix();
  const results: MatrixExecutionResults = {
    matrixId: matrix.matrix_id,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    state: "executing",
    matrixState: "executing",
    pauseReason: null,
    totalCells: 0,
    completedCells: 0,
    skippedCells: 0,
    failedCells: 0,
    identityUnverifiedCells: 0,
    cellResults: [],
    skipped: [],
    budget: { tokensUsed: 0, tokensBudget: null, wallTimeUsedSeconds: 0, wallTimeBudgetSeconds: null },
    aggregates: { perModel: [], perScenario: [], perTopology: [] },
    reconciliation: { plannedCells: 0, completedCells: 0, skippedCells: 0, missingCells: 0, cellsWithFewerRuns: 0, cellsWithFourthRun: 0, cellsWithWrongReplicates: 0, expectedRunsPerCell: 3, discrepancies: [], allConsistent: true },
  };
  const report = formatFinalReport(results);
  assert.ok(report.includes("(none)"));
});

test("evaluation/cli: parseEvalArgs returns defaults", () => {
  const opts = parseEvalArgs([]);
  assert.equal(opts.outputDir, "verification/benchmarks/evaluation/runs");
  assert.equal(opts.concurrency, 3);
  assert.equal(opts.matrix, "production");
  assert.equal(opts.resume, false);
  assert.equal(opts.dryRun, false);
  assert.equal(opts.budgetTokens, null);
  assert.equal(opts.budgetWallTimeSeconds, null);
  assert.equal(opts.limitScenarios, null);
  assert.equal(opts.limitCells, null);
  assert.equal(opts.maxRunsPerCell, null);
  assert.equal(opts.providerId, null);
  assert.equal(opts.models, null);
});

test("evaluation/cli: parseEvalArgs parses --output-dir", () => {
  assert.equal(parseEvalArgs(["--output-dir", "/tmp/eval"]).outputDir, "/tmp/eval");
});

test("evaluation/cli: parseEvalArgs parses --concurrency", () => {
  assert.equal(parseEvalArgs(["--concurrency", "5"]).concurrency, 5);
});

test("evaluation/cli: parseEvalArgs parses --matrix production", () => {
  assert.equal(parseEvalArgs(["--matrix", "production"]).matrix, "production");
});

test("evaluation/cli: parseEvalArgs parses --matrix development", () => {
  assert.equal(parseEvalArgs(["--matrix", "development"]).matrix, "development");
});

test("evaluation/cli: parseEvalArgs rejects invalid --matrix value", () => {
  assert.throws(() => parseEvalArgs(["--matrix", "staging"]), /production.*development/u);
});

test("evaluation/cli: parseEvalArgs parses --resume", () => {
  assert.equal(parseEvalArgs(["--resume"]).resume, true);
});

test("evaluation/cli: parseEvalArgs parses --dry-run", () => {
  assert.equal(parseEvalArgs(["--dry-run"]).dryRun, true);
});

test("evaluation/cli: parseEvalArgs parses --budget-tokens", () => {
  assert.equal(parseEvalArgs(["--budget-tokens", "1000000"]).budgetTokens, 1000000);
});

test("evaluation/cli: parseEvalArgs parses --budget-wall-time-seconds", () => {
  assert.equal(parseEvalArgs(["--budget-wall-time-seconds", "3600"]).budgetWallTimeSeconds, 3600);
});

test("evaluation/cli: parseEvalArgs parses --limit-scenarios", () => {
  assert.equal(parseEvalArgs(["--limit-scenarios", "10"]).limitScenarios, 10);
});

test("evaluation/cli: parseEvalArgs parses --limit-cells", () => {
  assert.equal(parseEvalArgs(["--limit-cells", "50"]).limitCells, 50);
});

test("evaluation/cli: parseEvalArgs parses --limit-runs", () => {
  assert.equal(parseEvalArgs(["--limit-runs", "1"]).maxRunsPerCell, 1);
});

test("evaluation/cli: parseEvalArgs parses --provider (AGN-1: provider-agnostic)", () => {
  assert.equal(parseEvalArgs(["--provider", "openrouter"]).providerId, "openrouter");
});

test("evaluation/cli: parseEvalArgs parses --models (AGN-4: configurable models)", () => {
  const opts = parseEvalArgs(["--models", "google/gemma-4-26B-A4B,zai-org/GLM-5.2-NVFP4"]);
  assert.deepEqual(opts.models, ["google/gemma-4-26B-A4B", "zai-org/GLM-5.2-NVFP4"]);
});

test("evaluation/cli: parseEvalArgs --models trims whitespace and drops empties", () => {
  const opts = parseEvalArgs(["--models", " alpha/beta , ,gamma/delta "]);
  assert.deepEqual(opts.models, ["alpha/beta", "gamma/delta"]);
});

test("evaluation/cli: parseEvalArgs rejects empty --models", () => {
  assert.throws(() => parseEvalArgs(["--models", ""]), /at least one model id/u);
  assert.throws(() => parseEvalArgs(["--models", " , , "]), /at least one model id/u);
});

test("evaluation/cli: parseEvalArgs rejects --provider without value", () => {
  assert.throws(() => parseEvalArgs(["--provider"]), /requires a value/u);
});

test("evaluation/cli: parseEvalArgs rejects --models without value", () => {
  assert.throws(() => parseEvalArgs(["--models"]), /requires a value/u);
});

test("evaluation/cli: parseEvalArgs rejects unknown flag", () => {
  assert.throws(() => parseEvalArgs(["--bogus"]), /unknown eval flag/u);
});

test("evaluation/cli: parseEvalArgs rejects flag without value", () => {
  assert.throws(() => parseEvalArgs(["--concurrency"]), /requires a value/u);
});

test("evaluation/cli: parseEvalArgs rejects negative concurrency", () => {
  assert.throws(() => parseEvalArgs(["--concurrency", "0"]), /must be >= 1/u);
});

test("evaluation/cli: parseEvalArgs rejects non-integer concurrency", () => {
  assert.throws(() => parseEvalArgs(["--concurrency", "abc"]), /non-negative integer/u);
});

test("evaluation/cli: parseEvalArgs rejects negative budget-tokens", () => {
  assert.throws(() => parseEvalArgs(["--budget-tokens", "-5"]), /non-negative integer/u);
});

test("evaluation/cli: parseEvalArgs combines multiple flags", () => {
  const opts = parseEvalArgs(["--matrix", "development", "--concurrency", "2", "--dry-run", "--limit-cells", "4", "--limit-runs", "1"]);
  assert.equal(opts.matrix, "development");
  assert.equal(opts.concurrency, 2);
  assert.equal(opts.dryRun, true);
  assert.equal(opts.limitCells, 4);
  assert.equal(opts.maxRunsPerCell, 1);
});

test("evaluation/cli: parseEvalArgs budget-tokens=0 is valid", () => {
  assert.equal(parseEvalArgs(["--budget-tokens", "0"]).budgetTokens, 0);
});

test("evaluation/scenario-runner: maxRuns option limits runs to 1", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const runner = createScenarioRunner({ adapter: makeMockProvider("test") });
  const result = await runner.runCell(makeRequestFactory(matrix)(cell, "test"), { maxRuns: 1 });
  assert.equal(result.runs.length, 1);
});

test("evaluation/scenario-runner: maxRuns=2 limits runs to 2", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const runner = createScenarioRunner({ adapter: makeMockProvider("test") });
  const result = await runner.runCell(makeRequestFactory(matrix)(cell, "test"), { maxRuns: 2 });
  assert.equal(result.runs.length, 2);
});

test("evaluation/scenario-runner: maxRuns unset runs all 3", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const runner = createScenarioRunner({ adapter: makeMockProvider("test") });
  const result = await runner.runCell(makeRequestFactory(matrix)(cell, "test"));
  assert.equal(result.runs.length, 3);
});

test("evaluation/scenario-runner: maxRuns=0 runs zero runs", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const runner = createScenarioRunner({ adapter: makeMockProvider("test") });
  const result = await runner.runCell(makeRequestFactory(matrix)(cell, "test"), { maxRuns: 0 });
  assert.equal(result.runs.length, 0);
});

test("evaluation/matrix-generator: buildScenarioPromptIndex returns a prompt for every scenario", () => {
  const config = createDevelopmentConfig(SEED_SCENARIOS, SEED_PROJECTS);
  const index = buildScenarioPromptIndex(config);
  const matrix = generateMatrix(config);
  for (const cell of matrix.cells) {
    const testEntry = matrix.tests.find((t) => t.test_id === cell.test_id)!;
    const prompt = index.get(testEntry.scenario_id);
    assert.ok(prompt !== undefined, `prompt missing for scenario ${testEntry.scenario_id}`);
    assert.ok(prompt!.length > 0);
  }
});

test("evaluation/matrix-executor: per-model passed count is 0 when provider fails", async () => {
  const { harness } = await runExecutor(makeFailingProvider(), { limitCells: 4 });
  const results = readResults(harness.dir);
  for (const m of results.aggregates.perModel) {
    assert.equal(m.passed, 0);
  }
});

test("evaluation/matrix-executor: per-model passed count > 0 when provider succeeds", async () => {
  const { harness } = await runExecutor(makeMockProvider(PASS_ALL_RESPONSE), { limitCells: 4 });
  const results = readResults(harness.dir);
  const totalPassed = results.aggregates.perModel.reduce((a, m) => a + m.passed, 0);
  assert.ok(totalPassed > 0);
});

test("evaluation/matrix-executor: elapsedMs is positive after execution", async () => {
  const { outcome } = await runExecutor(makeMockProvider("test"), { limitCells: 2 });
  assert.ok(outcome.elapsedMs >= 0);
});

test("evaluation/matrix-executor: totalDurationMs accumulates per cell", async () => {
  const { harness } = await runExecutor(makeMockProvider("test"), { limitCells: 2 });
  const results = readResults(harness.dir);
  for (const cr of results.cellResults) {
    assert.ok(cr.totalDurationMs >= 0);
  }
});

test("evaluation/matrix-executor: resume after budget exhaustion continues from checkpoint", async () => {
  const dir = mkTempDir("eval-executor-test-");
  try {
    const matrix = devMatrix();
    const writer = createResultsWriter({ outputDir: dir, matrix, budgetEstimate: calculateBudget(matrix), budgetTokens: 60, budgetWallTimeSeconds: null });
    writer.writeMatrixDocument();
    const runner = createScenarioRunner({ adapter: makeMockProvider(PASS_ALL_RESPONSE, { promptTokens: 10, completionTokens: 20, totalTokens: 30 }) });
    const o1 = await executeMatrix({ matrix, runner, resolvePrompt: makePromptResolver(matrix), buildCellRequest: makeRequestFactory(matrix), resultsWriter: writer, timeline: mkTimeline(dir), budgetTokens: 60 });
    assert.equal(o1.state, "budget-exhausted");
    const completedSoFar = o1.completedCells;
    assert.ok(completedSoFar < matrix.cells.length, "first run should not complete all cells");
    const writer2 = createResultsWriter({ outputDir: dir, matrix, budgetEstimate: calculateBudget(matrix), budgetTokens: 100000, budgetWallTimeSeconds: null });
    const o2 = await executeMatrix({ matrix, runner, resolvePrompt: makePromptResolver(matrix), buildCellRequest: makeRequestFactory(matrix), resultsWriter: writer2, timeline: mkTimeline(dir), resume: true, budgetTokens: 100000 });
    assert.equal(o2.state, "complete");
    assert.equal(o2.completedCells, matrix.cells.length, "resumed run should complete all cells");
    // C10: "failed" now includes oracle failures. R1-reference cells use the
    // reference transport (mock fetch) which returns PASS_ALL_RESPONSE and
    // should pass all seed-scenario oracles. The resume contract is
    // that every cell completed with no error (error === null).
    const results2 = readResults(dir);
    for (const cr of results2.cellResults) {
      assert.equal(cr.error, null, `cell ${cr.cellId} should have no error after resume`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/matrix-executor: progress total reflects limitCells", async () => {
  const { harness } = await runExecutor(makeMockProvider("test"), { limitCells: 5 });
  const last = harness.progress.updates[harness.progress.updates.length - 1]!;
  assert.equal(last.totalCells, 5);
});

test("evaluation/matrix-executor: progress total reflects limitScenarios", async () => {
  const { harness } = await runExecutor(makeMockProvider("test"), { limitScenarios: 1 });
  const last = harness.progress.updates[harness.progress.updates.length - 1]!;
  assert.ok(last.totalCells < devMatrix().cells.length);
});

test("evaluation/matrix-executor: budget-exhausted state propagates to results", async () => {
  const { harness } = await runExecutor(makeMockProvider("test", { promptTokens: 10, completionTokens: 20, totalTokens: 30 }), { budgetTokens: 50 });
  const results = readResults(harness.dir);
  assert.equal(results.state, "budget-exhausted");
});

test("evaluation/matrix-executor: complete state propagates to results", async () => {
  const { harness } = await runExecutor(makeMockProvider("test"), { limitCells: 3 });
  const results = readResults(harness.dir);
  assert.equal(results.state, "complete");
});

test("evaluation/matrix-executor: matrix.json written contains correct matrix id", async () => {
  const { harness } = await runExecutor(makeMockProvider("test"), { limitCells: 1 });
  const matrixFile = JSON.parse(readFileSync(join(harness.dir, "matrix.json"), "utf8")) as MatrixDocument;
  assert.equal(matrixFile.matrix_id, harness.matrix.matrix_id);
});

test("evaluation/matrix-executor: results.json matrixId matches matrix", async () => {
  const { harness } = await runExecutor(makeMockProvider("test"), { limitCells: 1 });
  const results = readResults(harness.dir);
  assert.equal(results.matrixId, harness.matrix.matrix_id);
});

test("evaluation/matrix-executor: budget tokens tracked in results", async () => {
  const cellToArm = buildCellToArmMap(devMatrix());
  const probeUsage = 10;
  const refMainUsage = 15;
  const { harness } = await runExecutor(makeMockProvider("test", { promptTokens: 5, completionTokens: 5, totalTokens: 10 }), { limitCells: 2, budgetTokens: 100000 });
  const results = readResults(harness.dir);
  assert.equal(results.budget.tokensBudget, 100000);
  // M8: each run contributes probe tokens (10) plus main tokens (10 for
  // non-reference mock, 15 for R1-reference fetch transport).
  let expected = 0;
  for (const cr of results.cellResults) {
    const isRef = cellToArm.get(cr.cellId) === "R1-reference";
    const perRun = probeUsage + (isRef ? refMainUsage : 10);
    expected += cr.runs.length * perRun;
  }
  assert.equal(results.budget.tokensUsed, expected);
});

test("evaluation/matrix-executor: wall-time budget recorded in results", async () => {
  const { harness } = await runExecutor(makeMockProvider("test"), { limitCells: 2, budgetWallTimeSeconds: 3600 });
  const results = readResults(harness.dir);
  assert.equal(results.budget.wallTimeBudgetSeconds, 3600);
});

test("evaluation/matrix-executor: both models present in per-model aggregates", async () => {
  const { harness } = await runExecutor(makeMockProvider("test"), { limitCells: 10 });
  const results = readResults(harness.dir);
  const modelIds = results.aggregates.perModel.map((m) => m.modelId);
  assert.ok(modelIds.includes("google/gemma-4-26B-A4B"));
  assert.ok(modelIds.includes("zai-org/GLM-5.2-NVFP4"));
});

test("evaluation/matrix-executor: topology aggregates include condition arms", async () => {
  const { harness } = await runExecutor(makeMockProvider("test"), { limitCells: 20 });
  const results = readResults(harness.dir);
  const arms = results.aggregates.perTopology.map((t) => t.conditionArm);
  assert.ok(arms.length > 0);
});

test("evaluation/matrix-executor: empty matrix completes with zero cells", async () => {
  const dir = mkTempDir("eval-executor-test-");
  try {
    const emptyMatrix = { ...devMatrix(), cells: [] as readonly CellRecord[] };
    const writer = createResultsWriter({ outputDir: dir, matrix: emptyMatrix as MatrixDocument, budgetEstimate: calculateBudget(emptyMatrix as MatrixDocument), budgetTokens: null, budgetWallTimeSeconds: null });
    writer.writeMatrixDocument();
    const runner = createScenarioRunner({ adapter: makeMockProvider("test") });
    const outcome = await executeMatrix({ matrix: emptyMatrix as MatrixDocument, runner, resolvePrompt: () => "x", buildCellRequest: makeRequestFactory(emptyMatrix as MatrixDocument), resultsWriter: writer, timeline: mkTimeline(dir) });
    assert.equal(outcome.state, "complete");
    assert.equal(outcome.completedCells, 0);
    assert.equal(outcome.totalCells, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/matrix-executor: single cell matrix completes", async () => {
  const full = devMatrix();
  const singleCellMatrix = { ...full, cells: [full.cells[0]!] as readonly CellRecord[] };
  const dir = mkTempDir("eval-executor-test-");
  try {
    const writer = createResultsWriter({ outputDir: dir, matrix: singleCellMatrix as MatrixDocument, budgetEstimate: calculateBudget(singleCellMatrix as MatrixDocument), budgetTokens: null, budgetWallTimeSeconds: null });
    writer.writeMatrixDocument();
    const runner = createScenarioRunner({ adapter: makeMockProvider("test") });
    const outcome = await executeMatrix({ matrix: singleCellMatrix as MatrixDocument, runner, resolvePrompt: makePromptResolver(full), buildCellRequest: makeRequestFactory(singleCellMatrix as MatrixDocument), resultsWriter: writer, timeline: mkTimeline(dir) });
    assert.equal(outcome.state, "complete");
    assert.equal(outcome.completedCells, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/matrix-executor: per-model identityAttested count matches provider success", async () => {
  const { harness } = await runExecutor(makeMockProvider("IDENTITY_PROBE_OK"), { limitCells: 6 });
  const results = readResults(harness.dir);
  for (const m of results.aggregates.perModel) {
    assert.equal(m.identityAttested, m.cells);
  }
});

test("evaluation/matrix-executor: per-model identityAttested is 0 when provider fails", async () => {
  const { harness } = await runExecutor(makeFailingProvider(), { limitCells: 6 });
  const results = readResults(harness.dir);
  for (const m of results.aggregates.perModel) {
    assert.equal(m.identityAttested, 0);
  }
});

test("evaluation/matrix-executor: per-model failed is 0 when provider succeeds and oracles pass", async () => {
  const { harness } = await runExecutor(makeMockProvider(PASS_ALL_RESPONSE), { limitCells: 6 });
  const results = readResults(harness.dir);
  for (const m of results.aggregates.perModel) {
    assert.equal(m.failed, 0, `model ${m.modelId} should have 0 failed cells when oracles pass`);
  }
});

test("evaluation/matrix-executor: per-scenario aggregates include passed count", async () => {
  const { harness } = await runExecutor(makeMockProvider(PASS_ALL_RESPONSE), { limitCells: 10 });
  const results = readResults(harness.dir);
  const totalPassed = results.aggregates.perScenario.reduce((a, s) => a + s.passed, 0);
  assert.ok(totalPassed > 0);
});

test("evaluation/matrix-executor: per-topology aggregates include passed count", async () => {
  const { harness } = await runExecutor(makeMockProvider(PASS_ALL_RESPONSE), { limitCells: 20 });
  const results = readResults(harness.dir);
  const totalPassed = results.aggregates.perTopology.reduce((a, t) => a + t.passed, 0);
  assert.ok(totalPassed > 0);
});

test("evaluation/matrix-executor: concurrency default is 3", async () => {
  const { outcome } = await runExecutor(makeMockProvider("test"), { limitCells: 3 });
  assert.equal(outcome.state, "complete");
});

test("evaluation/results-writer: budget-report.md content preserved", () => {
  const dir = mkTempDir("eval-executor-test-");
  try {
    const matrix = devMatrix();
    const w = createResultsWriter({ outputDir: dir, matrix, budgetEstimate: calculateBudget(matrix), budgetTokens: null, budgetWallTimeSeconds: null });
    const report = formatBudgetReport(calculateBudget(matrix));
    w.writeBudgetReport(report);
    const content = readFileSync(join(dir, "budget-report.md"), "utf8");
    assert.ok(content.includes("CHEP-1.0 Budget Report"));
    assert.ok(content.includes("Total cells:"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/results-writer: progress persists across writer instances", () => {
  const dir = mkTempDir("eval-executor-test-");
  try {
    const matrix = devMatrix();
    const w1 = createResultsWriter({ outputDir: dir, matrix, budgetEstimate: calculateBudget(matrix), budgetTokens: null, budgetWallTimeSeconds: null });
    w1.recordRunProgress(50);
    w1.recordCellResult({ cellId: "c1", modelId: "zai-org/GLM-5.2-NVFP4", testId: "t1", scenarioId: "s1", conditionArm: "A1", runs: [], allOraclesPassed: true, identityAttested: true, error: null, totalTokens: 50, totalDurationMs: 10 });
    w1.recordRunProgress(70);
    w1.recordCellResult({ cellId: "c2", modelId: "zai-org/GLM-5.2-NVFP4", testId: "t2", scenarioId: "s2", conditionArm: "A2", runs: [], allOraclesPassed: true, identityAttested: true, error: null, totalTokens: 70, totalDurationMs: 20 });
    const w2 = createResultsWriter({ outputDir: dir, matrix, budgetEstimate: calculateBudget(matrix), budgetTokens: null, budgetWallTimeSeconds: null });
    const progress = w2.loadProgress();
    assert.ok(progress !== null);
    assert.equal(progress!.completedCellIds.length, 2);
    assert.equal(progress!.tokensUsed, 120);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/matrix-executor: final report includes both models in aggregates table", async () => {
  // The executor seeded-shuffles cells by matrix_payload_sha256, which binds
  // to the generator/validator source hashes. AGN-4 changed those sources, so
  // the shuffle order changed. Use a limitCells large enough to guarantee
  // both models appear (pigeonhole: the dev matrix has 30 cells per model, so
  // 31+ guarantees both) rather than relying on a specific shuffle order.
  const { harness } = await runExecutor(makeMockProvider("test"), { limitCells: 31 });
  const report = readFileSync(join(harness.dir, "final-report.md"), "utf8");
  assert.ok(report.includes("google/gemma-4-26B-A4B"));
  assert.ok(report.includes("zai-org/GLM-5.2-NVFP4"));
  assert.ok(report.includes("Per-Topology Aggregates"));
});

test("evaluation/matrix-executor: isReference is true for R1-reference arm cells", async () => {
  const { harness } = await runExecutor(makeMockProvider("IDENTITY_PROBE_OK"));
  const results = readResults(harness.dir);
  const refCells = results.cellResults.filter((cr) => cr.conditionArm === "R1-reference");
  assert.ok(refCells.length > 0, "expected at least one R1-reference cell");
  for (const cr of refCells) {
    for (const r of cr.runs) {
      assert.equal(r.isReference, true, `cell ${cr.cellId} run should have isReference=true`);
    }
  }
});

test("evaluation/matrix-executor: isReference is false for non-reference arm cells", async () => {
  const { harness } = await runExecutor(makeMockProvider("IDENTITY_PROBE_OK"));
  const results = readResults(harness.dir);
  const nonRefCells = results.cellResults.filter((cr) => cr.conditionArm !== "R1-reference");
  assert.ok(nonRefCells.length > 0, "expected at least one non-reference cell");
  for (const cr of nonRefCells) {
    for (const r of cr.runs) {
      assert.equal(r.isReference, false, `cell ${cr.cellId} (${cr.conditionArm}) should have isReference=false`);
    }
  }
});

test("evaluation/matrix-executor: timeline records prompt and response content", async () => {
  const { harness } = await runExecutor(makeMockProvider("test response"), { limitCells: 1 });
  const store = (harness.timeline as TimelineRecorder).store;
  const messageEvents = store.query({ eventType: "message" });
  const promptDocs = messageEvents.flatMap((e) => e.documents.filter((d) => d.name === "prompt"));
  const responseDocs = messageEvents.flatMap((e) => e.documents.filter((d) => d.name === "response"));
  assert.ok(promptDocs.length > 0, "expected prompt documents in timeline");
  assert.ok(responseDocs.length > 0, "expected response documents in timeline");
  for (const d of responseDocs) {
    const parsed = JSON.parse(d.contentJson ?? "{}") as { content?: string };
    assert.ok(parsed.content && parsed.content.length > 0,
      `response content must be non-empty (got: ${parsed.content})`);
  }
});

test("evaluation/matrix-executor: R1-reference runs use reference transport", async () => {
  const { harness } = await runExecutor(makeMockProvider("IDENTITY_PROBE_OK"));
  const results = readResults(harness.dir);
  const refCells = results.cellResults.filter((cr) => cr.conditionArm === "R1-reference");
  assert.ok(refCells.length > 0);
  for (const cr of refCells) {
    for (const r of cr.runs) {
      assert.equal(r.isReference, true);
      assert.equal(r.content, PASS_ALL_RESPONSE);
    }
  }
});

test("evaluation/matrix-executor: timeline records capability probe events", async () => {
  const { harness } = await runExecutor(makeMockProvider("IDENTITY_PROBE_OK"), { limitCells: 2 });
  const store = (harness.timeline as TimelineRecorder).store;
  const providerEvents = store.query({ eventType: "provider" });
  assert.ok(providerEvents.length > 0, "expected capability probe provider events");
  const probeDocs = providerEvents.flatMap((e) => e.documents.filter((d) => d.name === "probe-response"));
  assert.ok(probeDocs.length > 0, "expected probe-response documents");
});

test("evaluation/matrix-executor: timeline records topology events for A-arms", async () => {
  const { harness } = await runExecutor(makeMockProvider("IDENTITY_PROBE_OK"));
  const store = (harness.timeline as TimelineRecorder).store;
  const agentEvents = store.query({ eventType: "agent" });
  const taskEvents = store.query({ eventType: "task" });
  assert.ok(agentEvents.length > 0, "expected agent events for A-arm topologies");
  assert.ok(taskEvents.length > 0, "expected task events for A-arm topologies");
});

// ============================================================================
// EVAL-2: matrix.json state advances on non-complete finalize
// EVAL-3: pause reason recorded in report, progress, and results
// ============================================================================

test("evaluation/results-writer: non-complete finalize advances matrix.json to executing (EVAL-2)", () => {
  const dir = mkTempDir("eval-executor-test-");
  try {
    const matrix = devMatrix();
    const w = createResultsWriter({ outputDir: dir, matrix, budgetEstimate: calculateBudget(matrix), budgetTokens: null, budgetWallTimeSeconds: null });
    w.writeMatrixDocument();
    const before = JSON.parse(readFileSync(join(dir, "matrix.json"), "utf8")) as MatrixDocument;
    assert.equal(before.matrix_state, "preregistered", "matrix.json starts at the generated preregistered state");
    w.beginExecution();
    w.finalize("interrupted", new Date().toISOString(), 100);
    const after = JSON.parse(readFileSync(join(dir, "matrix.json"), "utf8")) as MatrixDocument;
    assert.equal(after.matrix_state, "executing", "non-complete finalize must advance matrix.json from preregistered to executing (previously stayed preregistered)");
    assert.notEqual(after.matrix_payload_sha256, before.matrix_payload_sha256, "matrix_payload_sha256 must be recomputed over the new state");
    assert.equal(after.matrix_id, matrix.matrix_id, "matrix identity must be preserved");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/results-writer: complete finalize still advances matrix.json to complete (EVAL-2 regression)", () => {
  const dir = mkTempDir("eval-executor-test-");
  try {
    const matrix = devMatrix();
    const w = createResultsWriter({ outputDir: dir, matrix, budgetEstimate: calculateBudget(matrix), budgetTokens: null, budgetWallTimeSeconds: null });
    w.writeMatrixDocument();
    w.beginExecution();
    w.recordCellResult({ cellId: "c1", modelId: "zai-org/GLM-5.2-NVFP4", testId: "t1", scenarioId: "s1", conditionArm: "A1", runs: [], allOraclesPassed: true, identityAttested: true, error: null, totalTokens: 0, totalDurationMs: 0 });
    w.finalize("complete", new Date().toISOString(), 50);
    const after = JSON.parse(readFileSync(join(dir, "matrix.json"), "utf8")) as MatrixDocument;
    assert.equal(after.matrix_state, "complete", "complete finalize must still advance matrix.json to complete");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/matrix-executor: pause records reason in report, progress, results, and matrix.json (EVAL-3)", async () => {
  // 6+ consecutive identity failures trigger benchmark-restart-required.
  const { outcome, harness } = await runExecutor(makeFailingProvider(), { limitCells: 7, concurrency: 1 });
  assert.equal(outcome.state, "benchmark-restart-required", "7 failing cells must pause with benchmark-restart-required");

  // results.json carries the structured pause reason.
  const results = readResults(harness.dir);
  assert.ok(results.pauseReason !== null, "results.json must include a structured pauseReason");
  assert.ok((results.pauseReason as { consecutiveIdentityFailures: number }).consecutiveIdentityFailures > 5,
    "pauseReason must record >5 consecutive identity failures");

  // final-report.md has a Pause Reason section explaining WHY.
  const report = readFileSync(join(harness.dir, "final-report.md"), "utf8");
  assert.ok(report.includes("## Pause Reason"), "final report must have a '## Pause Reason' section");
  assert.ok(report.includes("consecutive identity failures"), "report must explain the consecutive identity failures");
  assert.ok(/recommendation/i.test(report), "report must include a recommendation");
  // the report lists which cells failed identity
  assert.ok(report.includes("Cells that failed identity"), "report must list identity-failed cells");

  // progress.json carries a human-readable pauseReason field.
  const progress = JSON.parse(readFileSync(join(harness.dir, "progress.json"), "utf8")) as { pauseReason?: string };
  assert.ok(typeof progress.pauseReason === "string" && progress.pauseReason.length > 0,
    "progress.json must have a string pauseReason field");
  assert.ok(progress.pauseReason.includes("identity-failure-threshold"), "progress pauseReason should reference the failure code");

  // EVAL-2: matrix.json advanced to executing (not left at preregistered).
  const matrixFile = JSON.parse(readFileSync(join(harness.dir, "matrix.json"), "utf8")) as MatrixDocument;
  assert.equal(matrixFile.matrix_state, "executing", "matrix.json must advance to executing on a paused run (EVAL-2)");
});

// ============================================================================
// MAJ-4: budget is enforced after EACH run, not just after each cell. A budget
// exceeded mid-cell skips the remaining planned replicates with reason
// "budget-exceeded" rather than silently dropping them.
// ============================================================================

test("evaluation/matrix-executor: budget exceeded mid-cell skips remaining runs with finishReason skipped-budget-exceeded (MAJ-4)", async () => {
  // Each run costs probe tokens (30) + main tokens (30) = 60 total. A budget of
  // 60 is exceeded after the FIRST run of the first cell, so the remaining 2
  // replicates of that cell must be skipped (not silently dropped).
  const { harness } = await runExecutor(
    makeMockProvider("test", { promptTokens: 10, completionTokens: 20, totalTokens: 30 }),
    { limitCells: 1, budgetTokens: 60 },
  );
  const results = readResults(harness.dir);
  assert.equal(results.cellResults.length, 1, "the single limited cell must be recorded");
  const cell = results.cellResults[0]!;
  // The first run completes; runs 2 and 3 must be present with a skipped reason.
  assert.ok(cell.runs.length === 3, `expected 3 run slots (1 completed + 2 skipped), got ${cell.runs.length}`);
  const skipped = cell.runs.filter((r) => r.finishReason === "skipped-budget-exceeded");
  assert.ok(
    skipped.length >= 1,
    `expected at least 1 run skipped with finishReason 'skipped-budget-exceeded', got ${skipped.length}: ${cell.runs.map((r) => r.finishReason).join(",")}`,
  );
  for (const s of skipped) {
    assert.equal(s.content, "", "a skipped run must produce no content");
  }
});

test("evaluation/matrix-executor: skipped-budget-exceeded runs are recorded, not silently dropped (MAJ-4)", async () => {
  const { harness } = await runExecutor(
    makeMockProvider("test", { promptTokens: 10, completionTokens: 20, totalTokens: 30 }),
    { limitCells: 1, budgetTokens: 60 },
  );
  const results = readResults(harness.dir);
  const cell = results.cellResults[0]!;
  // No run slot may be silently dropped — the cell has 3 planned replicates.
  assert.equal(cell.runs.length, 3, "all 3 planned replicate slots must be present (no silent drops)");
  const completed = cell.runs.filter((r) => r.finishReason !== "skipped-budget-exceeded");
  const skipped = cell.runs.filter((r) => r.finishReason === "skipped-budget-exceeded");
  assert.ok(completed.length >= 1, "at least one run must complete before the budget trips");
  assert.ok(skipped.length >= 1, "at least one run must be recorded as skipped-budget-exceeded");
  assert.equal(completed.length + skipped.length, 3, "completed + skipped must cover all 3 planned slots");
});
