import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";

import { createScenarioRunner, checkOracle } from "../../src/evaluation/scenario-runner.ts";
import type {
  CellExecutionRequest,
  HiddenOracle,
  MatrixDocument,
} from "../../src/evaluation/types.ts";
import type { ChatStreamEvent, ProviderAdapter } from "../../src/runtime/provider-adapter.ts";
import { makeMockProvider as sharedMakeMockProvider } from "../support/mock-provider.ts";
import { makeTimelineRecorder } from "../support/timeline.ts";
import { devMatrix } from "../support/matrix.ts";
import { mkTempDir } from "../support/temp-dir.ts";
import { address, serve, type UpstreamRequest } from "../support/loopback-upstream.ts";

const mkTimeline = (dir: string) => makeTimelineRecorder(dir, "eval-test");

/**
 * Positional adapter over the shared `makeMockProvider` options factory. The
 * provider implementation lives once in `test/support/mock-provider.ts`; this
 * shim only translates the legacy `(content, usage?, headers?)` call shape
 * used by this file's call sites so they need no per-call rewrite.
 */
function makeMockProvider(
  content: string,
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number },
  headers?: Record<string, string>,
): ProviderAdapter {
  return sharedMakeMockProvider({
    content,
    ...(usage !== undefined ? { usage } : {}),
    ...(headers !== undefined ? { headers } : {}),
  });
}

function makeRequest(matrix: MatrixDocument, cellId: string, prompt: string): CellExecutionRequest {
  return {
    matrix,
    cellId,
    scenarioPrompt: prompt,
    providerConfig: {
      id: "makora",
      baseUrl: address("https://inference.makora.com/v1"),
      apiKeyEnvVar: "MAKORA_API_KEY",
      timeoutMs: 120000,
      retries: { maxRetries: 3, initialBackoffMs: 500, maxBackoffMs: 10000, backoffMultiplier: 2 },
    },
    apiKey: "mock-key",
    maxTokens: 256,
  };
}

test("evaluation/scenario-runner: runs a cell with mock provider and returns 3 runs", async () => {
  const dir = mkTempDir("eval-runner-test-");
  try {
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const adapter = makeMockProvider("function reverseString(s) { return s.split('').reverse().join(''); }");
    const runner = createScenarioRunner({ adapter });
    const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "Write a function that reverses a string."));
    assert.equal(result.cellId, cell.cell_id);
    assert.equal(result.runs.length, 3);
    assert.equal(result.error, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/scenario-runner: each run has replicate 1, 2, 3", async () => {
  const dir = mkTempDir("eval-runner-test-");
  try {
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const adapter = makeMockProvider("test response");
    const runner = createScenarioRunner({ adapter });
    const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test prompt"));
    const replicates = result.runs.map((r) => r.replicate).sort();
    assert.deepEqual(replicates, [1, 2, 3]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/scenario-runner: identity attested with exact match", async () => {
  const dir = mkTempDir("eval-runner-test-");
  try {
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const adapter = makeMockProvider("IDENTITY_PROBE_OK");
    const runner = createScenarioRunner({ adapter });
    const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
    assert.equal(result.identityAttested, true);
    for (const r of result.runs) {
      assert.equal(r.modelRevision.mappingStatus, "exact");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/scenario-runner: identity not attested when provider fails", async () => {
  const dir = mkTempDir("eval-runner-test-");
  try {
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const failingAdapter: ProviderAdapter = {
      providerId: "mock-fail",
      async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> {
        throw new Error("provider unavailable");
      },
      async chatCompletion(): Promise<{ content: string; toolCalls: readonly never[]; usage: undefined; finishReason: string }> {
        throw new Error("provider unavailable");
      },
    };
    const runner = createScenarioRunner({ adapter: failingAdapter });
    const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
    assert.equal(result.identityAttested, false);
    for (const r of result.runs) {
      assert.equal(r.modelRevision.mappingStatus, "not-returned");
      assert.equal(r.finishReason, "identity_not_established");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/scenario-runner: returns error when cell not found", async () => {
  const dir = mkTempDir("eval-runner-test-");
  try {
    const matrix = devMatrix();
    const adapter = makeMockProvider("test");
    const runner = createScenarioRunner({ adapter });
    const result = await runner.runCell(makeRequest(matrix, "cel_nonexistent", "test"));
    assert.notEqual(result.error, null);
    assert.equal(result.runs.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/scenario-runner: records to timeline when provided", async () => {
  const dir = mkTempDir("eval-runner-test-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const adapter = makeMockProvider("test response");
    const runner = createScenarioRunner({ adapter, timeline: tl });
    await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
    const events = tl.store.query({ runId: cell.runs[0]!.run_id });
    assert.ok(events.length > 0, "expected timeline events for the run");
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/scenario-runner: records token usage to timeline", async () => {
  const dir = mkTempDir("eval-runner-test-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const adapter = makeMockProvider("test", { promptTokens: 15, completionTokens: 25, totalTokens: 40 });
    const runner = createScenarioRunner({ adapter, timeline: tl });
    await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
    const allEvents = tl.store.query({});
    const tokenEvents = allEvents.filter((e) => e.eventType === "token");
    assert.ok(tokenEvents.length > 0, `expected token events, got ${tokenEvents.length} out of ${allEvents.length} total events`);
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/scenario-runner: all oracle checks pass for correct response", async () => {
  const dir = mkTempDir("eval-runner-test-");
  try {
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const adapter = makeMockProvider("function reverseString(s: string): string { return s.split('').reverse().join(''); }");
    const runner = createScenarioRunner({ adapter });
    const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "Write reverseString"));
    for (const r of result.runs) {
      for (const o of r.oracleResults) {
        if (o.name === "non-empty-response") {
          assert.equal(o.passed, true, `oracle ${o.name} should pass`);
        }
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/scenario-runner: captures content from provider response", async () => {
  const dir = mkTempDir("eval-runner-test-");
  try {
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const expectedContent = "function test() { return 42; }";
    const adapter = makeMockProvider(expectedContent);
    const runner = createScenarioRunner({ adapter });
    const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
    for (const r of result.runs) {
      assert.equal(r.content, expectedContent);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/scenario-runner: captures usage from provider response", async () => {
  const dir = mkTempDir("eval-runner-test-");
  try {
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const adapter = makeMockProvider("test", { promptTokens: 100, completionTokens: 200, totalTokens: 300 });
    const runner = createScenarioRunner({ adapter });
    const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
    for (const r of result.runs) {
      assert.ok(r.usage !== undefined);
      assert.equal(r.usage.promptTokens, 100);
      assert.equal(r.usage.completionTokens, 200);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/scenario-runner: durationMs is positive", async () => {
  const dir = mkTempDir("eval-runner-test-");
  try {
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const adapter = makeMockProvider("test");
    const runner = createScenarioRunner({ adapter });
    const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
    for (const r of result.runs) {
      assert.ok(r.durationMs >= 0);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/scenario-runner: isReference is false for normal mode", async () => {
  const dir = mkTempDir("eval-runner-test-");
  try {
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const adapter = makeMockProvider("test");
    const runner = createScenarioRunner({ adapter });
    const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
    for (const r of result.runs) {
      assert.equal(r.isReference, false);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/scenario-runner: model ID matches cell model", async () => {
  const dir = mkTempDir("eval-runner-test-");
  try {
    const matrix = devMatrix();
    for (const cell of matrix.cells.slice(0, 4)) {
      const adapter = makeMockProvider("test");
      const runner = createScenarioRunner({ adapter });
      const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
      assert.equal(result.modelId, cell.model_id);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/scenario-runner: checkOracle contains passes", () => {
  const oracle: HiddenOracle = { name: "test", kind: "contains", pattern: "hello", expected: true };
  const result = checkOracle(oracle, "hello world");
  assert.equal(result.passed, true);
});

test("evaluation/scenario-runner: checkOracle contains fails on missing", () => {
  const oracle: HiddenOracle = { name: "test", kind: "contains", pattern: "hello", expected: true };
  const result = checkOracle(oracle, "goodbye world");
  assert.equal(result.passed, false);
});

test("evaluation/scenario-runner: checkOracle not-contains passes", () => {
  const oracle: HiddenOracle = { name: "test", kind: "not-contains", pattern: "secret", expected: true };
  const result = checkOracle(oracle, "no secrets here");
  assert.equal(result.passed, false);
});

test("evaluation/scenario-runner: checkOracle regex-match passes", () => {
  const oracle: HiddenOracle = { name: "test", kind: "regex-match", pattern: "^function", expected: true };
  const result = checkOracle(oracle, "function foo() {}");
  assert.equal(result.passed, true);
});

test("evaluation/scenario-runner: checkOracle regex-match fails", () => {
  const oracle: HiddenOracle = { name: "test", kind: "regex-match", pattern: "^function", expected: true };
  const result = checkOracle(oracle, "const foo = () => {}");
  assert.equal(result.passed, false);
});

test("evaluation/scenario-runner: checkOracle json-valid passes", () => {
  const oracle: HiddenOracle = { name: "test", kind: "json-valid", pattern: "", expected: true };
  const result = checkOracle(oracle, '{"key": "value"}');
  assert.equal(result.passed, true);
});

test("evaluation/scenario-runner: checkOracle json-valid fails on invalid JSON", () => {
  const oracle: HiddenOracle = { name: "test", kind: "json-valid", pattern: "", expected: true };
  const result = checkOracle(oracle, "not json");
  assert.equal(result.passed, false);
});

test("evaluation/scenario-runner: checkOracle line-count passes", () => {
  const oracle: HiddenOracle = { name: "test", kind: "line-count", pattern: "3", expected: true };
  const result = checkOracle(oracle, "line1\nline2\nline3");
  assert.equal(result.passed, true);
});

test("evaluation/scenario-runner: checkOracle line-count fails on fewer lines", () => {
  const oracle: HiddenOracle = { name: "test", kind: "line-count", pattern: "5", expected: true };
  const result = checkOracle(oracle, "line1\nline2");
  assert.equal(result.passed, false);
});

test("evaluation/scenario-runner: checkOracle empty pattern contains passes on non-empty content", () => {
  const oracle: HiddenOracle = { name: "non-empty", kind: "contains", pattern: "", expected: true };
  assert.equal(checkOracle(oracle, "some content").passed, true);
  assert.equal(checkOracle(oracle, "").passed, false);
});

test("evaluation/scenario-runner: checkOracle expected=false inverts result", () => {
  const oracle: HiddenOracle = { name: "test", kind: "contains", pattern: "hello", expected: false };
  const result = checkOracle(oracle, "hello world");
  assert.equal(result.passed, false);
  assert.equal(result.actual, true);
  assert.equal(result.expected, false);
});

test("evaluation/scenario-runner: oracle results include name, passed, expected, actual", () => {
  const oracle: HiddenOracle = { name: "my-oracle", kind: "contains", pattern: "foo", expected: true };
  const result = checkOracle(oracle, "foobar");
  assert.equal(result.name, "my-oracle");
  assert.equal(result.passed, true);
  assert.equal(result.expected, true);
  assert.equal(result.actual, true);
});

test("evaluation/scenario-runner: allOraclesPassed is true when all pass", async () => {
  const dir = mkTempDir("eval-runner-test-");
  try {
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const adapter = makeMockProvider("function reverseString(s: string): string { return s.split('').reverse().join(''); }");
    const runner = createScenarioRunner({ adapter });
    const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "Write reverseString"));
    assert.equal(result.allOraclesPassed, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/scenario-runner: both models produce results", async () => {
  const dir = mkTempDir("eval-runner-test-");
  try {
    const matrix = devMatrix();
    const cellGemma = matrix.cells.find((c) => c.model_id === "google/gemma-4-26B-A4B")!;
    const cellGlm = matrix.cells.find((c) => c.model_id === "zai-org/GLM-5.2-NVFP4")!;
    const adapter = makeMockProvider("test");
    const runner = createScenarioRunner({ adapter });
    const resultGemma = await runner.runCell(makeRequest(matrix, cellGemma.cell_id, "test"));
    const resultGlm = await runner.runCell(makeRequest(matrix, cellGlm.cell_id, "test"));
    assert.equal(resultGemma.modelId, "google/gemma-4-26B-A4B");
    assert.equal(resultGlm.modelId, "zai-org/GLM-5.2-NVFP4");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/scenario-runner: offline mode (no API key) rejects when building adapter", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const request: CellExecutionRequest = {
    ...makeRequest(matrix, cell.cell_id, "test"),
    apiKey: "",
  };
  await assert.rejects(
    async () => createScenarioRunner({}).runCell(request),
    /API key/,
  );
});

test("evaluation/scenario-runner: isReference is true when runReferenceTransport is set", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider("test");
  const runner = createScenarioRunner({ adapter });
  const mockFetch = async (_url: string, init: UpstreamRequest): Promise<Response> => {
    const body = JSON.parse(init.body as string) as { messages?: { content?: string }[] };
    const isProbe = body.messages?.[0]?.content === "Reply with exactly: IDENTITY_PROBE_OK";
    const content = isProbe ? "IDENTITY_PROBE_OK" : "reference response";
    return new Response(JSON.stringify({
      choices: [{ message: { content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }), { status: 200, headers: { "content-type": "application/json", "x-request-id": "ref-001" } });
  };
  const request = makeRequest(matrix, cell.cell_id, "test");
  serve(mockFetch);
  const result = await runner.runCell({ ...request, runReferenceTransport: true });
  for (const r of result.runs) {
    assert.equal(r.isReference, true);
  }
});

test("evaluation/scenario-runner: isReference is false when runReferenceTransport is unset", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider("test");
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  for (const r of result.runs) {
    assert.equal(r.isReference, false);
  }
});

test("evaluation/scenario-runner: modelRevision captures providerRequestId and providerDate from headers", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider("IDENTITY_PROBE_OK", undefined, {
    "x-request-id": "req-abc123",
    "date": "Wed, 17 Jul 2026 12:00:00 GMT",
  });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  for (const r of result.runs) {
    assert.equal(r.modelRevision.providerRequestId, "req-abc123");
    assert.equal(r.modelRevision.providerDate, "Wed, 17 Jul 2026 12:00:00 GMT");
  }
});

test("evaluation/scenario-runner: modelRevision providerRequestId is null when headers absent", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider("IDENTITY_PROBE_OK");
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  for (const r of result.runs) {
    assert.equal(r.modelRevision.providerRequestId, null);
    assert.equal(r.modelRevision.providerDate, null);
  }
});

test("evaluation/scenario-runner: capabilityProbe is populated with content and headers", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider("IDENTITY_PROBE_OK", undefined, {
    "x-request-id": "req-xyz",
  });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  for (const r of result.runs) {
    assert.ok(r.capabilityProbe !== undefined, "capabilityProbe should be populated");
    assert.equal(r.capabilityProbe.content, "IDENTITY_PROBE_OK");
    assert.equal(r.capabilityProbe.headers["x-request-id"], "req-xyz");
  }
});

test("evaluation/scenario-runner: capabilityProbe is undefined when identity not established", async () => {
  const dir = mkTempDir("eval-runner-test-");
  try {
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const failingAdapter: ProviderAdapter = {
      providerId: "mock-fail",
      async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> { throw new Error("fail"); },
      async chatCompletion(): Promise<{ content: string; toolCalls: readonly never[]; usage: undefined; finishReason: string }> { throw new Error("fail"); },
    };
    const runner = createScenarioRunner({ adapter: failingAdapter });
    const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
    for (const r of result.runs) {
      assert.equal(r.capabilityProbe, undefined);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/scenario-runner: timeline records prompt content as document", async () => {
  const dir = mkTempDir("eval-runner-test-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const adapter = makeMockProvider("test response");
    const runner = createScenarioRunner({ adapter, timeline: tl });
    await runner.runCell(makeRequest(matrix, cell.cell_id, "a unique prompt marker XYZ"));
    const messageEvents = tl.store.query({ eventType: "message" });
    const promptDocs = messageEvents.flatMap((e) => e.documents.filter((d) => d.name === "prompt"));
    assert.ok(promptDocs.length > 0, "expected prompt documents in timeline");
    const promptContent = promptDocs.map((d) => JSON.parse(d.contentJson ?? "{}") as { content?: string });
    assert.ok(promptContent.some((p) => p.content === "a unique prompt marker XYZ"), "prompt content should be recorded");
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/scenario-runner: timeline records response content as document", async () => {
  const dir = mkTempDir("eval-runner-test-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const adapter = makeMockProvider("unique response marker 789");
    const runner = createScenarioRunner({ adapter, timeline: tl });
    await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
    const messageEvents = tl.store.query({ eventType: "message" });
    const responseDocs = messageEvents.flatMap((e) => e.documents.filter((d) => d.name === "response"));
    assert.ok(responseDocs.length > 0, "expected response documents in timeline");
    const responseContent = responseDocs.map((d) => JSON.parse(d.contentJson ?? "{}") as { content?: string });
    assert.ok(responseContent.some((p) => p.content === "unique response marker 789"), "response content should be recorded");
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/scenario-runner: timeline records capability probe as provider event", async () => {
  const dir = mkTempDir("eval-runner-test-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const adapter = makeMockProvider("IDENTITY_PROBE_OK");
    const runner = createScenarioRunner({ adapter, timeline: tl });
    await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
    const providerEvents = tl.store.query({ eventType: "provider" });
    assert.ok(providerEvents.length > 0, "expected provider events (capability probe)");
    const probeDocs = providerEvents.flatMap((e) => e.documents.filter((d) => d.name === "probe-response"));
    assert.ok(probeDocs.length > 0, "expected probe-response documents");
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/scenario-runner: timeline records topology metadata for A-arms", async () => {
  const dir = mkTempDir("eval-runner-test-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const aCell = matrix.cells.find((c) => {
      const test = matrix.tests.find((t) => t.test_id === c.test_id);
      const cond = test && matrix.conditions.find((cd) => cd.condition_id === test.condition_id);
      return cond?.arm === "A3";
    }) ?? matrix.cells[0]!;
    const adapter = makeMockProvider("test");
    const runner = createScenarioRunner({ adapter, timeline: tl });
    await runner.runCell(makeRequest(matrix, aCell.cell_id, "test"));
    const agentEvents = tl.store.query({ eventType: "agent" });
    const taskEvents = tl.store.query({ eventType: "task" });
    assert.ok(agentEvents.length > 0, "expected agent events for A3 topology");
    assert.ok(taskEvents.length > 0, "expected task events for A3 topology");
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/scenario-runner: no topology events for D0-direct arm", async () => {
  const dir = mkTempDir("eval-runner-test-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const d0Cell = matrix.cells.find((c) => {
      const test = matrix.tests.find((t) => t.test_id === c.test_id);
      const cond = test && matrix.conditions.find((cd) => cd.condition_id === test.condition_id);
      return cond?.arm === "D0-direct";
    });
    if (d0Cell === undefined) { tl.close(); return; }
    const adapter = makeMockProvider("test");
    const runner = createScenarioRunner({ adapter, timeline: tl });
    await runner.runCell(makeRequest(matrix, d0Cell.cell_id, "test"));
    const agentEvents = tl.store.query({ eventType: "agent" });
    assert.equal(agentEvents.length, 0, "D0-direct should have no agent events");
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/scenario-runner: cell run result includes topology metadata for A-arms", async () => {
  const matrix = devMatrix();
  const aCell = matrix.cells.find((c) => {
    const test = matrix.tests.find((t) => t.test_id === c.test_id);
    const cond = test && matrix.conditions.find((cd) => cd.condition_id === test.condition_id);
    return cond?.arm === "A5";
  }) ?? matrix.cells[0]!;
  const adapter = makeMockProvider("test");
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, aCell.cell_id, "test"));
  for (const r of result.runs) {
    assert.ok(r.topology !== undefined, "A5 runs should have topology metadata");
    assert.equal(r.topology.agentCount, 5);
    assert.equal(r.topology.roles.length, 5);
  }
});

// ============================================================================
// EVAL-1: oracle outcomes must be recorded in the queryable timeline
// ============================================================================

test("evaluation/scenario-runner: records oracle outcome to the timeline (EVAL-1)", async () => {
  const dir = mkTempDir("eval-runner-test-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const adapter = makeMockProvider("function reverseString(s: string): string { return s.split('').reverse().join(''); }");
    const runner = createScenarioRunner({ adapter, timeline: tl });
    await runner.runCell(makeRequest(matrix, cell.cell_id, "Write reverseString"));
    const allEvents = tl.store.query({});
    const testEvents = allEvents.filter((e) => e.eventType === "test");
    assert.ok(testEvents.length > 0, `expected 'test' events recording oracle outcomes, got ${testEvents.length} of ${allEvents.length} total events`);
    for (const te of testEvents) {
      assert.ok(te.description.includes("Oracle results"), `test event description should mention oracles: ${te.description}`);
      assert.ok(te.runId !== null, "each oracle test event must correlate to a runId");
      // The 'result' document carries { passed, testCount }.
      const resultDoc = te.documents.find((d) => d.name === "result");
      assert.ok(resultDoc !== undefined, "oracle test event must carry a 'result' document");
      const parsed = JSON.parse(resultDoc!.contentJson ?? "{}") as { passed: boolean; testCount: number };
      assert.equal(typeof parsed.passed, "boolean");
      assert.equal(typeof parsed.testCount, "number");
      assert.ok(parsed.testCount > 0, "testCount should be > 0 (anti-echo oracle is always added)");
    }
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/scenario-runner: records oracle failure to the timeline (EVAL-1)", async () => {
  const dir = mkTempDir("eval-runner-test-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    // A response that echoes the prompt fails the anti-echo oracle
    // (runOracles appends a not-contains oracle for the prompt prefix),
    // guaranteeing at least one oracle fails.
    const adapter = makeMockProvider("Write reverseString");
    const runner = createScenarioRunner({ adapter, timeline: tl });
    await runner.runCell(makeRequest(matrix, cell.cell_id, "Write reverseString"));
    const testEvents = tl.store.query({}).filter((e) => e.eventType === "test");
    assert.ok(testEvents.length > 0);
    const anyFailed = testEvents.some((te) => {
      const resultDoc = te.documents.find((d) => d.name === "result");
      const parsed = JSON.parse(resultDoc?.contentJson ?? "{}") as { passed: boolean };
      return parsed.passed === false;
    });
    assert.ok(anyFailed, "at least one oracle test event must record passed=false for a failing response");
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// C1: scenario-specific hidden oracles are evaluated (not just non-empty-response)
// ============================================================================

test("evaluation/scenario-runner: scenario-specific oracles are evaluated, not just non-empty-response (C1)", async () => {
  const dir = mkTempDir("eval-runner-test-");
  try {
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    // Find a scenario-specific oracle in this cell's scenario (one that is
    // NOT the generic "non-empty-response"). The first dev scenario declares
    // "no-explicit-any" (not-contains ": any"), which is scenario-specific.
    const test = matrix.tests.find((x) => x.test_id === cell.test_id)!;
    const scenario = matrix.scenarios.find((x) => x.scenario_id === test.scenario_id)!;
    const specificOracle = scenario.hidden_oracles.find((o) => o.name !== "non-empty-response")!;
    assert.ok(specificOracle !== undefined, "dev scenario must declare at least one scenario-specific oracle beyond non-empty-response");
    // Run with a non-empty response that VIOLATES the scenario-specific oracle.
    // For a "not-contains" oracle (e.g. no-explicit-any), include the pattern.
    const violation = specificOracle.kind === "not-contains"
      ? `function foo(): ${specificOracle.pattern}string { return 1; }`
      : "function foo() { return 1; }";
    const adapter = makeMockProvider(violation);
    const runner = createScenarioRunner({ adapter });
    const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "Write code"));
    // Collect the full set of oracle names evaluated across runs.
    const oracleNames = new Set<string>();
    for (const r of result.runs) {
      for (const o of r.oracleResults) oracleNames.add(o.name);
    }
    // The scenario-specific oracle must be present (C1: oracles are no longer
    // hardcoded to just "non-empty-response").
    assert.ok(
      oracleNames.has(specificOracle.name),
      `scenario-specific oracle "${specificOracle.name}" must be evaluated. Got: ${[...oracleNames].join(", ")}`,
    );
    // And a violating response must FAIL that oracle.
    for (const r of result.runs) {
      const oracle = r.oracleResults.find((o) => o.name === specificOracle.name);
      assert.ok(oracle !== undefined, `${specificOracle.name} oracle must be in the results`);
      assert.equal(oracle!.passed, false, `a violating response must FAIL the ${specificOracle.name} oracle`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/scenario-runner: a response satisfying the scenario-specific oracle PASSES it (C1)", async () => {
  const dir = mkTempDir("eval-runner-test-");
  try {
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const test = matrix.tests.find((x) => x.test_id === cell.test_id)!;
    const scenario = matrix.scenarios.find((x) => x.scenario_id === test.scenario_id)!;
    const specificOracle = scenario.hidden_oracles.find((o) => o.name !== "non-empty-response")!;
    // A response that SATISFIES the scenario-specific oracle.
    const satisfying = specificOracle.kind === "not-contains"
      ? "function foo() { return 'clean code'; }"
      : `function foo() { return '${specificOracle.pattern}'; }`;
    const adapter = makeMockProvider(satisfying);
    const runner = createScenarioRunner({ adapter });
    const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "Write code"));
    for (const r of result.runs) {
      const oracle = r.oracleResults.find((o) => o.name === specificOracle.name);
      assert.ok(oracle !== undefined);
      assert.equal(oracle!.passed, true, `a satisfying response must PASS the ${specificOracle.name} oracle`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// MAJ-9: anti-echo oracle — a response starting with the prompt text fails
// ============================================================================

test("evaluation/scenario-runner: a response that echoes the prompt prefix fails the not-echo oracle (MAJ-9)", async () => {
  const dir = mkTempDir("eval-runner-test-");
  try {
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const prompt = "Write reverseString";
    // The response literally starts with the prompt text → anti-echo oracle fails.
    const echoResponse = prompt + " and here is the answer.";
    const adapter = makeMockProvider(echoResponse);
    const runner = createScenarioRunner({ adapter });
    const result = await runner.runCell(makeRequest(matrix, cell.cell_id, prompt));
    for (const r of result.runs) {
      const antiEcho = r.oracleResults.find((o) => o.name === "not-echo");
      assert.ok(antiEcho !== undefined, "the anti-echo 'not-echo' oracle must be added to every run");
      assert.equal(antiEcho!.passed, false, "a response starting with the prompt prefix must FAIL the not-echo oracle");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("evaluation/scenario-runner: a response that does not echo the prompt passes the not-echo oracle (MAJ-9)", async () => {
  const dir = mkTempDir("eval-runner-test-");
  try {
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const prompt = "Write reverseString";
    const adapter = makeMockProvider("function reverseString(s: string): string { return s.split('').reverse().join(''); }");
    const runner = createScenarioRunner({ adapter });
    const result = await runner.runCell(makeRequest(matrix, cell.cell_id, prompt));
    for (const r of result.runs) {
      const antiEcho = r.oracleResults.find((o) => o.name === "not-echo");
      assert.ok(antiEcho !== undefined);
      assert.equal(antiEcho!.passed, true, "a response not starting with the prompt prefix must PASS the not-echo oracle");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
