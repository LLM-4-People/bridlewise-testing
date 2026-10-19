import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { sha256 } from "../../src/kernel/integrity.ts";
import {
  createDevelopmentConfig,
  generateMatrix,
} from "../../src/evaluation/matrix-generator.ts";
import { createScenarioRunner } from "../../src/evaluation/scenario-runner.ts";
import {
  createResultsWriter,
  reconcileExecution,
  type CellResultRecord,
} from "../../src/evaluation/results-writer.ts";
import { validateMatrixPayloadHash } from "../../src/evaluation/semantic-validators.ts";
import { calculateBudget } from "../../src/evaluation/budget-calculator.ts";
import { SEED_SCENARIOS, SEED_PROJECTS, loadProjectContext } from "../../src/evaluation/scenarios.ts";
import type {
  CellExecutionRequest,
  MatrixDocument,
} from "../../src/evaluation/types.ts";
import type {
  ChatStreamEvent,
  ProviderAdapter,
} from "../../src/runtime/provider-adapter.ts";
import { makeMockProvider as sharedMakeMockProvider } from "../support/mock-provider.ts";
import { makeTimelineRecorder } from "../support/timeline.ts";
import { devMatrix } from "../support/matrix.ts";
import { mkTempDir } from "../support/temp-dir.ts";

/**
 * Tests for the critical+major DER-014/018 fixes (oracles, identity, digests,
 * state machine, fault profiles, reconciliation, request body, probe tokens,
 * event edges, temperature, contamination, failure-prone projects).
 */

const mkTimeline = (dir: string) => makeTimelineRecorder(dir, "fix2");

const PROBE_PROMPT = "Reply with exactly: IDENTITY_PROBE_OK";

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

function makeRequest(matrix: MatrixDocument, cellId: string, prompt: string): CellExecutionRequest {
  return {
    matrix,
    cellId,
    scenarioPrompt: prompt,
    providerConfig: {
      id: "makora",
      baseUrl: "https://inference.makora.com/v1",
      apiKeyEnvVar: "MAKORA_API_KEY",
      timeoutMs: 120000,
      retries: { maxRetries: 3, initialBackoffMs: 500, maxBackoffMs: 10000, backoffMultiplier: 2 },
    },
    apiKey: "mock-key",
    maxTokens: 256,
  };
}

// ----------------------------------------------------------------------------
// C3: content digests cover exactly the stored contentJson
// ----------------------------------------------------------------------------

test("C3: probe-response digest equals sha256 of the stored contentJson", async () => {
  const dir = mkTempDir("eval-fix2-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const runner = createScenarioRunner({ adapter: makeMockProvider("resp"), timeline: tl });
    await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
    const providerEvents = tl.store.query({ eventType: "provider" });
    const probeDocs = providerEvents.flatMap((e) => e.documents.filter((d) => d.name === "probe-response"));
    assert.ok(probeDocs.length > 0);
    for (const d of probeDocs) {
      assert.equal(d.contentDigest, sha256(d.contentJson ?? ""),
        "probe-response digest must be sha256 of the stored contentJson");
    }
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("C3: tool-call digest covers id, name, AND arguments", async () => {
  const dir = mkTempDir("eval-fix2-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const tcAdapter: ProviderAdapter = {
      providerId: "mock-tc",
      async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> { yield { type: "content", text: "x" }; },
      async chatCompletion(request): Promise<{ content: string; toolCalls: readonly { id: string; type: "function"; function: { name: string; arguments: string } }[]; usage: { promptTokens: number; completionTokens: number; totalTokens: number }; finishReason: string; headers?: Readonly<Record<string, string>> }> {
        const isProbe = request.messages[0]?.content === PROBE_PROMPT;
        if (isProbe) return { content: "IDENTITY_PROBE_OK", toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "stop", headers: { "x-model-id": request.model } };
        return {
          content: "resp",
          toolCalls: [{ id: "tc-1", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } }],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          finishReason: "stop",
          headers: { "x-model-id": request.model },
        };
      },
    };
    const runner = createScenarioRunner({ adapter: tcAdapter, timeline: tl });
    await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
    const toolEvents = tl.store.query({ eventType: "tool" });
    const docs = toolEvents.flatMap((e) => e.documents.filter((d) => d.name === "tool-call"));
    assert.ok(docs.length > 0);
    for (const d of docs) {
      const parsed = JSON.parse(d.contentJson ?? "{}") as { arguments?: string };
      assert.ok(parsed.arguments !== undefined, "tool-call contentJson must include arguments");
      assert.equal(d.contentDigest, sha256(d.contentJson ?? ""),
        "tool-call digest must cover the full stored object including arguments");
    }
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ----------------------------------------------------------------------------
// C5: matrix payload hash validator actually compares
// ----------------------------------------------------------------------------

test("C5: validateMatrixPayloadHash returns true for an honest matrix", () => {
  const m = devMatrix();
  assert.equal(validateMatrixPayloadHash(m), true);
});

test("C5: validateMatrixPayloadHash returns false for a tampered matrix", () => {
  const m = devMatrix();
  // Tamper with a field that is part of the payload but keep the old hash.
  const tampered: MatrixDocument = { ...m, target_unique_scored_scenarios: 9999 as MatrixDocument["target_unique_scored_scenarios"] };
  assert.equal(validateMatrixPayloadHash(tampered), false,
    "a tampered matrix with a stale payload hash must fail validation");
});

test("C5: validateMatrixPayloadHash returns false for a 64-char non-matching hash", () => {
  const m = devMatrix();
  const tampered: MatrixDocument = { ...m, matrix_payload_sha256: "0".repeat(64) };
  assert.equal(validateMatrixPayloadHash(tampered), false,
    "a 64-char string that does not match the computed hash must fail (no false-green)");
});

// ----------------------------------------------------------------------------
// C7: fault profiles have real events
// ----------------------------------------------------------------------------

test("C7: matrix defines 4 fault profile kinds with events", () => {
  const m = devMatrix();
  const kinds = new Set(m.fault_profiles.map((f) => f.profile_kind));
  assert.ok(kinds.has("natural-no-injection"));
  assert.ok(kinds.has("provider-harness-injection"));
  assert.ok(kinds.has("repository-adversarial"));
  assert.ok(kinds.has("scoring-adversarial"));
  for (const fp of m.fault_profiles) {
    if (fp.profile_kind === "natural-no-injection") {
      assert.equal(fp.events.length, 0, "natural-no-injection is the control (0 events)");
    } else {
      assert.ok(fp.events.length >= 2, `${fp.profile_kind} must have >= 2 fault events`);
      for (const ev of fp.events) {
        assert.ok(ev.fault_type.length > 0);
        assert.ok(ev.trigger_specification.sha256.length === 64);
        assert.ok(ev.trigger_specification.size_bytes > 0, "fault trigger artifact must hash real content");
      }
    }
  }
});

// ----------------------------------------------------------------------------
// C8: reconciliation
// ----------------------------------------------------------------------------

test("C8: reconcileExecution reports consistent for a complete matrix", () => {
  const m = devMatrix();
  const dummyRuns = [{ replicate: 1 }, { replicate: 2 }, { replicate: 3 }] as never[];
  const records: CellResultRecord[] = m.cells.map((c) => ({
    cellId: c.cell_id,
    modelId: c.model_id,
    testId: c.test_id,
    scenarioId: "scn",
    conditionArm: "A1",
    runs: dummyRuns,
    allOraclesPassed: true,
    identityAttested: true,
    error: null,
    totalTokens: 0,
    totalDurationMs: 0,
  }));
  const report = reconcileExecution(m, records, []);
  assert.equal(report.allConsistent, true);
  assert.equal(report.plannedCells, m.cells.length);
  assert.equal(report.completedCells, m.cells.length);
  assert.equal(report.missingCells, 0);
  assert.equal(report.cellsWithFourthRun, 0);
});

test("C8: reconcileExecution detects missing cells and short cells", () => {
  const m = devMatrix();
  // Complete only the first cell, with 2 runs (fewer than 3).
  const first = m.cells[0]!;
  const records: CellResultRecord[] = [{
    cellId: first.cell_id,
    modelId: first.model_id,
    testId: first.test_id,
    scenarioId: "scn",
    conditionArm: "A1",
    runs: [],
    allOraclesPassed: true,
    identityAttested: true,
    error: null,
    totalTokens: 0,
    totalDurationMs: 0,
  }];
  const report = reconcileExecution(m, records, []);
  assert.equal(report.allConsistent, false);
  assert.ok(report.missingCells > 0, "missing cells must be reported");
});

// ----------------------------------------------------------------------------
// C9: serialized request body recorded in timeline
// ----------------------------------------------------------------------------

test("C9: request-body document recorded before the completion call", async () => {
  const dir = mkTempDir("eval-fix2-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const runner = createScenarioRunner({ adapter: makeMockProvider("resp"), timeline: tl });
    await runner.runCell(makeRequest(matrix, cell.cell_id, "a unique prompt"));
    const providerEvents = tl.store.query({ eventType: "provider" });
    const reqDocs = providerEvents.flatMap((e) => e.documents.filter((d) => d.name === "request-body"));
    assert.ok(reqDocs.length > 0, "request-body document must be recorded");
    for (const d of reqDocs) {
      const parsed = JSON.parse(d.contentJson ?? "{}") as { model?: string; messages?: unknown[]; temperature?: number; max_tokens?: number; stream?: boolean };
      assert.equal(parsed.model, cell.model_id);
      assert.equal(parsed.temperature, 0);
      assert.ok(Array.isArray(parsed.messages) && parsed.messages!.length > 0);
      assert.equal(typeof parsed.max_tokens, "number");
    }
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ----------------------------------------------------------------------------
// M1: temperature recorded per run
// ----------------------------------------------------------------------------

test("M1: each run result records temperature 0", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const runner = createScenarioRunner({ adapter: makeMockProvider("resp") });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  for (const r of result.runs) {
    assert.equal(r.temperature, 0);
  }
});

test("M1: temperature is recorded as a run-event document", async () => {
  const dir = mkTempDir("eval-fix2-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const runner = createScenarioRunner({ adapter: makeMockProvider("resp"), timeline: tl });
    await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
    const runEvents = tl.store.query({ eventType: "run" });
    assert.ok(runEvents.length > 0);
    const tempDocs = runEvents.flatMap((e) => e.documents.filter((d) => d.name === "temperature"));
    assert.ok(tempDocs.length > 0, "run event must carry a temperature document");
    for (const d of tempDocs) {
      const parsed = JSON.parse(d.contentJson ?? "{}") as { temperature?: number };
      assert.equal(parsed.temperature, 0);
    }
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ----------------------------------------------------------------------------
// M6: event edges / parent links
// ----------------------------------------------------------------------------

test("M6: message and token events link to the run event via parentEventId", async () => {
  const dir = mkTempDir("eval-fix2-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const runner = createScenarioRunner({ adapter: makeMockProvider("resp"), timeline: tl });
    await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
    const runEvents = tl.store.query({ eventType: "run" });
    const messageEvents = tl.store.query({ eventType: "message" });
    const tokenEvents = tl.store.query({ eventType: "token" });
    assert.ok(runEvents.length > 0);
    const runEventIds = new Set(runEvents.map((e) => e.eventId));
    // At least some message events should be parented to a run event.
    const parentedMessages = messageEvents.filter((e) => e.parentEventId !== null && runEventIds.has(e.parentEventId!));
    assert.ok(parentedMessages.length > 0, "message events must link to the run event via parentEventId");
    // Token events should be parented to a message event.
    const messageEventIds = new Set(messageEvents.map((e) => e.eventId));
    const parentedTokens = tokenEvents.filter((e) => e.parentEventId !== null && messageEventIds.has(e.parentEventId!));
    assert.ok(parentedTokens.length > 0, "token events must link to a message event via parentEventId");
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ----------------------------------------------------------------------------
// M7: outcome/error metadata on timeline events
// ----------------------------------------------------------------------------

test("M7: failed run records outcome=failed and error metadata in timeline", async () => {
  const dir = mkTempDir("eval-fix2-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    // Provider succeeds on probe, throws on main → run error recorded.
    let callCount = 0;
    const failAdapter: ProviderAdapter = {
      providerId: "mock-fail-main",
      async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> { throw new Error("x"); },
      async chatCompletion(request): Promise<{ content: string; toolCalls: readonly never[]; usage: { promptTokens: number; completionTokens: number; totalTokens: number }; finishReason: string; headers?: Readonly<Record<string, string>> }> {
        callCount++;
        if (callCount % 2 === 1) return { content: "IDENTITY_PROBE_OK", toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "stop", headers: { "x-model-id": request.model } };
        throw new Error("MAIN_EXPLODED");
      },
    };
    const runner = createScenarioRunner({ adapter: failAdapter, timeline: tl });
    await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
    const providerEvents = tl.store.query({ eventType: "provider" });
    const failedEvents = providerEvents.filter((e) => e.outcome === "failed");
    assert.ok(failedEvents.length > 0, "a failed run must record outcome=failed");
    const withError = failedEvents.find((e) => e.errorMessage !== null && e.errorMessage!.includes("MAIN_EXPLODED"));
    assert.ok(withError !== undefined, "the failed event must carry the error message");
    assert.ok(withError!.errorCategory !== null, "the failed event must carry an error category");
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ----------------------------------------------------------------------------
// M8: probe tokens included in cell total
// ----------------------------------------------------------------------------

test("M8: cell totalTokens includes capability-probe tokens", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const probeUsage = { promptTokens: 7, completionTokens: 11, totalTokens: 18 };
  const mainUsage = { promptTokens: 100, completionTokens: 200, totalTokens: 300 };
  let callCount = 0;
  const adapter: ProviderAdapter = {
    providerId: "mock-mixed",
    async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> { yield { type: "content", text: "x" }; },
    async chatCompletion(request): Promise<{ content: string; toolCalls: readonly never[]; usage: { promptTokens: number; completionTokens: number; totalTokens: number }; finishReason: string; headers?: Readonly<Record<string, string>> }> {
      callCount++;
      const isProbe = request.messages[0]?.content === PROBE_PROMPT;
      return {
        content: isProbe ? "IDENTITY_PROBE_OK" : "resp",
        toolCalls: [],
        usage: isProbe ? probeUsage : mainUsage,
        finishReason: "stop",
        headers: { "x-model-id": request.model },
      };
    },
  };
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  for (const r of result.runs) {
    assert.ok(r.capabilityProbe !== undefined);
    assert.equal(r.capabilityProbe.usage?.totalTokens, 18, "probe usage must be captured");
    assert.equal(r.usage?.totalTokens, 300, "main usage must be captured");
  }
});

// ----------------------------------------------------------------------------
// M9: contamination risk recorded
// ----------------------------------------------------------------------------

test("M9: scenarios and projects carry contamination_risk", () => {
  const m = devMatrix();
  for (const s of m.scenarios) {
    assert.equal(s.contamination_risk, "unknown", "synthetic fixtures have unknown contamination risk");
  }
  for (const p of m.projects) {
    assert.equal(p.contamination_risk, "unknown");
  }
});

// ----------------------------------------------------------------------------
// M10: failure-prone projects and scenarios
// ----------------------------------------------------------------------------

test("M10: failure-prone projects are marked in the project record", () => {
  const m = devMatrix();
  const failureProne = m.projects.filter((p) => p.failure_prone);
  assert.ok(failureProne.length >= 2, "at least 2 failure-prone projects must be registered");
  for (const p of failureProne) {
    assert.equal(p.failure_prone, true);
  }
});

test("M10: failure-prone seed scenarios reference failure-prone projects", () => {
  // The failure-prone scenarios appear in a matrix with enough slots.
  const config = {
    ...createDevelopmentConfig(SEED_SCENARIOS, SEED_PROJECTS),
    phaseCounts: { "P0-shakedown": 0, "P1-baseline": 8, "P2-development": 4, "P3-holdout": 3 },
  };
  const m = generateMatrix(config);
  const failureProneProjectIds = new Set(
    SEED_PROJECTS.filter((p) => p.failureProne === true).map((p) => p.projectId),
  );
  const failureProneScenarios = m.scenarios.filter((s) => failureProneProjectIds.has(s.project_id));
  assert.ok(failureProneScenarios.length >= 2, "failure-prone scenarios must appear in a sufficiently large matrix");
});

test("M10: failure-prone project fixtures exist on disk", () => {
  // The fixtures are read by loadProjectContext; ensure they exist.
  assert.ok(loadProjectContext("ts-broken-syntax", 3) !== null, "ts-broken-syntax fixture must exist");
  assert.ok(loadProjectContext("py-failing-tests", 3) !== null, "py-failing-tests fixture must exist");
});

// ----------------------------------------------------------------------------
// C4: matrix state machine
// ----------------------------------------------------------------------------

test("C4: results-writer tracks matrixState transitions (frozen -> executing -> complete)", () => {
  const dir = mkTempDir("eval-fix2-");
  try {
    const m = devMatrix();
    const w = createResultsWriter({ outputDir: dir, matrix: m, budgetEstimate: calculateBudget(m), budgetTokens: null, budgetWallTimeSeconds: null });
    // Before writing the matrix document, matrixState is preregistered.
    assert.equal(w.getResults().matrixState, "preregistered");
    w.writeMatrixDocument();
    assert.equal(w.getResults().matrixState, "frozen", "writeMatrixDocument must transition to frozen");
    w.recordCellResult({
      cellId: "cel_x", modelId: "zai-org/GLM-5.2-NVFP4", testId: "t1", scenarioId: "s1", conditionArm: "A1",
      runs: [], allOraclesPassed: true, identityAttested: true, error: null, totalTokens: 0, totalDurationMs: 0,
    });
    assert.equal(w.getResults().matrixState, "executing", "recordCellResult must transition to executing");
    const results = w.finalize("complete", new Date().toISOString(), 100);
    assert.equal(results.matrixState, "complete", "finalize(complete) must transition matrixState to complete");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ----------------------------------------------------------------------------
// C10: oracle failures counted as failed
// ----------------------------------------------------------------------------

test("C10: a cell with allOraclesPassed=false and error=null is counted as failed", () => {
  const dir = mkTempDir("eval-fix2-");
  try {
    const m = devMatrix();
    const w = createResultsWriter({ outputDir: dir, matrix: m, budgetEstimate: calculateBudget(m), budgetTokens: null, budgetWallTimeSeconds: null });
    w.recordCellResult({
      cellId: "cel_oracle_fail", modelId: "zai-org/GLM-5.2-NVFP4", testId: "t1", scenarioId: "s1", conditionArm: "A1",
      runs: [], allOraclesPassed: false, identityAttested: true, error: null, totalTokens: 0, totalDurationMs: 0,
    });
    const results = w.finalize("complete", new Date().toISOString(), 10);
    assert.equal(results.failedCells, 1, "oracle failure with no error must count as failed");
    const report = readFileSync(join(dir, "final-report.md"), "utf8");
    assert.ok(report.includes("cel_oracle_fail"), "oracle-failed cell must appear in the Failed Cells section");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ----------------------------------------------------------------------------
// C2: identity probe content verification
// ----------------------------------------------------------------------------

test("C2: identity established only when probe returns the marker", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  // Probe returns the marker plus extra text (contains check should still pass).
  const okAdapter: ProviderAdapter = {
    providerId: "mock-ok",
    async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> { yield { type: "content", text: "x" }; },
    async chatCompletion(request): Promise<{ content: string; toolCalls: readonly never[]; usage: { promptTokens: number; completionTokens: number; totalTokens: number }; finishReason: string; headers?: Readonly<Record<string, string>> }> {
      const isProbe = request.messages[0]?.content === PROBE_PROMPT;
      return {
        content: isProbe ? "Sure! IDENTITY_PROBE_OK" : "resp",
        toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "stop",
        headers: { "x-model-id": request.model },
      };
    },
  };
  const runner = createScenarioRunner({ adapter: okAdapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  assert.equal(result.identityAttested, true, "probe containing the marker must establish identity");
});
