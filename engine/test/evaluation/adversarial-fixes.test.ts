import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";

import { deepFreeze } from "../../src/kernel/integrity.ts";
import { CONDITION_ARMS } from "../../src/evaluation/types.ts";
import { createDevelopmentConfig, buildScenarioPromptIndex } from "../../src/evaluation/matrix-generator.ts";
import { createScenarioRunner } from "../../src/evaluation/scenario-runner.ts";
import { enrichPrompt, loadProjectContext, SEED_SCENARIOS, SEED_PROJECTS } from "../../src/evaluation/scenarios.ts";
import type {
  CellExecutionRequest,
  ConditionArm,
  MatrixDocument,
} from "../../src/evaluation/types.ts";
import { buildCellToArmMap } from "../../src/evaluation/matrix-executor.ts";
import type {
  ChatCompletionResult,
  ChatStreamEvent,
  ProviderAdapter,
  ToolCall,
} from "../../src/runtime/provider-adapter.ts";
import { makeMockProvider, referenceTransportUpstream } from "../support/mock-provider.ts";
import { makeTimelineRecorder } from "../support/timeline.ts";
import { devMatrix } from "../support/matrix.ts";
import { mkTempDir } from "../support/temp-dir.ts";
import { address, serve } from "../support/loopback-upstream.ts";

/**
 * Adversarial / mutation tests for the 7 DER-014/017 data-recording fixes
 * in commit 05e2614. Each test tries to break a specific fix or exercise
 * an edge case. A failing test indicates a real bug.
 */

const mkTimeline = (dir: string) => makeTimelineRecorder(dir, "adversarial");

function makeRequest(matrix: MatrixDocument, cellId: string, prompt: string, overrides: Readonly<Record<string, unknown>> = {}): CellExecutionRequest {
  const base: CellExecutionRequest = {
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
  return deepFreeze({ ...base, ...overrides }) as CellExecutionRequest;
}

function findCellForArm(matrix: MatrixDocument, arm: ConditionArm): { cell_id: string; model_id: string } | undefined {
  const conditionMap = new Map(matrix.conditions.map((c) => [c.condition_id, c.arm]));
  for (const cell of matrix.cells) {
    const test = matrix.tests.find((t) => t.test_id === cell.test_id);
    if (test !== undefined && conditionMap.get(test.condition_id) === arm) return cell;
  }
  return undefined;
}

// ============================================================================
// FIX 1: isReference — R1-reference arm sets runReferenceTransport=true
// ============================================================================

test("FIX1: runReferenceTransport=true produces isReference=true in all runs", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const mockFetch = referenceTransportUpstream({ content: "reference response", headers: { "x-request-id": "ref-001" } });
  const runner = createScenarioRunner({});
  serve(mockFetch);
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test", {
    runReferenceTransport: true,
  }));
  assert.equal(result.runs.length, 3, "should have 3 runs");
  for (const r of result.runs) {
    assert.equal(r.isReference, true, `run ${r.replicate} isReference should be true`);
  }
});

test("FIX1: runReferenceTransport=false produces isReference=false in all runs", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider({ content: "test" });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test", { runReferenceTransport: false }));
  for (const r of result.runs) {
    assert.equal(r.isReference, false, `run ${r.replicate} isReference should be false`);
  }
});

test("FIX1: runReferenceTransport=undefined produces isReference=false (not undefined)", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider({ content: "test" });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  for (const r of result.runs) {
    assert.equal(r.isReference, false, `run ${r.replicate} isReference should be false, not undefined`);
    assert.equal(typeof r.isReference, "boolean", "isReference must be a boolean, not undefined");
  }
});

test("FIX1 (mutation guard): isReference is never undefined even if runReferenceTransport omitted", async () => {
  // Mutation: if someone removes `?? false` from `isReference: request.runReferenceTransport?? false`,
  // isReference would be undefined. This test catches that.
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider({ content: "test" });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  for (const r of result.runs) {
    assert.ok(r.isReference !== undefined, "isReference must not be undefined");
    assert.ok(r.isReference !== null, "isReference must not be null");
  }
});

test("FIX1 (edge): R1-reference cell with maxRuns=0 produces empty runs array, no crash", async () => {
  const matrix = devMatrix();
  const r1Cell = findCellForArm(matrix, "R1-reference") ?? matrix.cells[0]!;
  const mockFetch = referenceTransportUpstream({ content: "ref" });
  const runner = createScenarioRunner({});
  serve(mockFetch);
  const result = await runner.runCell(makeRequest(matrix, r1Cell.cell_id, "test", {
    runReferenceTransport: true,
  }), { maxRuns: 0 });
  assert.equal(result.runs.length, 0, "maxRuns=0 should produce empty runs");
  assert.equal(result.error, null);
});

// ============================================================================
// FIX 2: Timeline content — prompt/response stored as documents
// ============================================================================

test("FIX2: prompt document has name 'prompt' and contains prompt text", async () => {
  const dir = mkTempDir("eval-adversarial-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const adapter = makeMockProvider({ content: "resp" });
    const runner = createScenarioRunner({ adapter, timeline: tl });
    const marker = "UNIQUE-PROMPT-MARKER-42";
    await runner.runCell(makeRequest(matrix, cell.cell_id, marker));
    const messageEvents = tl.store.query({ eventType: "message" });
    const promptDocs = messageEvents.flatMap((e) => e.documents.filter((d) => d.name === "prompt"));
    assert.ok(promptDocs.length > 0, "expected prompt documents");
    const parsed = promptDocs.map((d) => JSON.parse(d.contentJson ?? "{}") as { content?: string });
    assert.ok(parsed.some((p) => p.content === marker), "prompt document must contain the prompt text");
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("FIX2: response document has name 'response' and contains response text", async () => {
  const dir = mkTempDir("eval-adversarial-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const marker = "UNIQUE-RESPONSE-MARKER-99";
    const adapter = makeMockProvider({ content: marker });
    const runner = createScenarioRunner({ adapter, timeline: tl });
    await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
    const messageEvents = tl.store.query({ eventType: "message" });
    const responseDocs = messageEvents.flatMap((e) => e.documents.filter((d) => d.name === "response"));
    assert.ok(responseDocs.length > 0, "expected response documents");
    const parsed = responseDocs.map((d) => JSON.parse(d.contentJson ?? "{}") as { content?: string });
    assert.ok(parsed.some((p) => p.content === marker), "response document must contain the response text");
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("FIX2: prompt and response documents have non-empty contentDigest", async () => {
  const dir = mkTempDir("eval-adversarial-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const adapter = makeMockProvider({ content: "resp" });
    const runner = createScenarioRunner({ adapter, timeline: tl });
    await runner.runCell(makeRequest(matrix, cell.cell_id, "test prompt"));
    const messageEvents = tl.store.query({ eventType: "message" });
    const docs = messageEvents.flatMap((e) => e.documents);
    const promptResponseDocs = docs.filter((d) => d.name === "prompt" || d.name === "response");
    assert.ok(promptResponseDocs.length >= 2, "expected at least prompt+response docs");
    for (const d of promptResponseDocs) {
      assert.ok(d.contentDigest.length > 0, `document ${d.name} must have non-empty contentDigest`);
    }
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("FIX2 (mutation guard): removing documents would leave zero prompt docs — test catches it", async () => {
  // This test ensures the prompt document is actually recorded.
  // If someone removes the recordMessage call with documents, this fails.
  const dir = mkTempDir("eval-adversarial-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const adapter = makeMockProvider({ content: "resp" });
    const runner = createScenarioRunner({ adapter, timeline: tl });
    await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
    const messageEvents = tl.store.query({ eventType: "message" });
    // There should be at least 2 message events: prompt + response per run, 3 runs = 6
    assert.ok(messageEvents.length >= 6, `expected >= 6 message events (3 prompts + 3 responses), got ${messageEvents.length}`);
    const allDocs = messageEvents.flatMap((e) => e.documents);
    assert.ok(allDocs.some((d) => d.name === "prompt"), "must have prompt documents");
    assert.ok(allDocs.some((d) => d.name === "response"), "must have response documents");
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("FIX2 (edge): empty prompt string still records a prompt document", async () => {
  const dir = mkTempDir("eval-adversarial-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const adapter = makeMockProvider({ content: "resp" });
    const runner = createScenarioRunner({ adapter, timeline: tl });
    await runner.runCell(makeRequest(matrix, cell.cell_id, ""));
    const messageEvents = tl.store.query({ eventType: "message" });
    const promptDocs = messageEvents.flatMap((e) => e.documents.filter((d) => d.name === "prompt"));
    assert.ok(promptDocs.length > 0, "even empty prompt should be recorded");
    const parsed = promptDocs.map((d) => JSON.parse(d.contentJson ?? "{}") as { content?: string });
    assert.ok(parsed.some((p) => p.content === ""), "empty prompt content should be recorded as empty string");
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// FIX 3: HTTP headers — ChatCompletionResult includes response headers
// ============================================================================

test("FIX3: mock provider with headers returns headers in result", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider({
    content: "IDENTITY_PROBE_OK",
    headers: { "x-request-id": "req-abc", "date": "Wed, 17 Jul 2026 12:00:00 GMT" },
  });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  for (const r of result.runs) {
    assert.ok(r.capabilityProbe !== undefined);
    assert.equal(r.capabilityProbe.headers["x-request-id"], "req-abc");
    assert.equal(r.capabilityProbe.headers["date"], "Wed, 17 Jul 2026 12:00:00 GMT");
  }
});

test("FIX3: headers are empty object (not null/undefined) when no headers present", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider({ content: "IDENTITY_PROBE_OK", headers: {} });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  for (const r of result.runs) {
    assert.ok(r.capabilityProbe !== undefined);
    assert.ok(r.capabilityProbe.headers !== null, "headers must not be null");
    assert.ok(r.capabilityProbe.headers !== undefined, "headers must not be undefined");
    assert.equal(typeof r.capabilityProbe.headers, "object", "headers must be an object");
    assert.equal(Object.keys(r.capabilityProbe.headers).length, 0, "headers should be empty when none provided");
  }
});

test("FIX3: modelRevision captures providerRequestId and providerDate from headers", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider({
    content: "IDENTITY_PROBE_OK",
    headers: { "x-request-id": "req-xyz789", "date": "Thu, 18 Jul 2026 08:30:00 GMT" },
  });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  for (const r of result.runs) {
    assert.equal(r.modelRevision.providerRequestId, "req-xyz789");
    assert.equal(r.modelRevision.providerDate, "Thu, 18 Jul 2026 08:30:00 GMT");
  }
});

test("FIX3 (mutation guard): removing headers from type would break providerRequestId capture", async () => {
  // If someone removes the headers field from ChatCompletionResult,
  // attestIdentity would get undefined and providerRequestId would be null even when headers exist.
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider({
    content: "IDENTITY_PROBE_OK",
    headers: { "x-request-id": "req-guard-1" },
  });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  for (const r of result.runs) {
    assert.equal(r.modelRevision.providerRequestId, "req-guard-1",
      "providerRequestId must be captured from x-request-id header");
  }
});

test("FIX3 (edge): response with no headers at all — providerRequestId is null", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider({ content: "IDENTITY_PROBE_OK" });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  for (const r of result.runs) {
    assert.equal(r.modelRevision.providerRequestId, null);
    assert.equal(r.modelRevision.providerDate, null);
  }
});

// ============================================================================
// FIX 4: Capability probe — attestIdentity captures and stores probe result
// ============================================================================

test("FIX4: capabilityProbe is present in CellRunResult when identity established", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider({ content: "IDENTITY_PROBE_OK" });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  for (const r of result.runs) {
    assert.ok(r.capabilityProbe !== undefined, "capabilityProbe should be present");
  }
});

test("FIX4: capabilityProbe has content, usage, headers, finishReason", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider({
    content: "IDENTITY_PROBE_OK",
    usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
    headers: { "x-request-id": "probe-1" },
  });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  for (const r of result.runs) {
    assert.ok(r.capabilityProbe !== undefined);
    assert.equal(r.capabilityProbe.content, "IDENTITY_PROBE_OK");
    assert.ok(r.capabilityProbe.usage !== undefined);
    assert.equal(r.capabilityProbe.usage.promptTokens, 5);
    assert.equal(r.capabilityProbe.usage.completionTokens, 3);
    assert.equal(r.capabilityProbe.headers["x-request-id"], "probe-1");
    assert.equal(r.capabilityProbe.finishReason, "stop");
  }
});

test("FIX4 (BUG): identity NOT established when probe returns wrong response", async () => {
  // ADVERSARIAL: The probe sends "Reply with exactly: IDENTITY_PROBE_OK".
  // If the model returns a WRONG response, identity should NOT be established.
  // This test WILL FAIL if attestIdentity doesn't verify the probe response content.
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  // Probe returns wrong content; main calls return something else.
  const adapter = makeMockProvider({
    probeContent: "I am definitely not the right model, I return garbage",
    content: "main response",
  });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  assert.equal(
    result.identityAttested, false,
    "identity should NOT be attested when probe returns wrong response (got identityAttested=true — attestIdentity does not verify probe content)",
  );
  for (const r of result.runs) {
    assert.equal(
      r.finishReason, "identity_not_established",
      "runs should be marked identity_not_established when probe fails",
    );
  }
});

test("FIX4 (BUG): mappingStatus is NOT 'exact' when probe returns wrong response", async () => {
  // ADVERSARIAL: If the probe returns a wrong response, mappingStatus should
  // reflect the mismatch, not be hardcoded to "exact".
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider({
    probeContent: "wrong response from a different model",
    content: "main response",
  });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  for (const r of result.runs) {
    assert.notEqual(
      r.modelRevision.mappingStatus, "exact",
      "mappingStatus should not be 'exact' when probe returns wrong response",
    );
  }
});

test("FIX4 (FIXED): returnedModelId is captured from x-model-id and mismatch detected", async () => {
  // FIXED (C2): attestIdentity now reads the x-model-id header instead of
  // hardcoding returnedModelId = requestedModelId. A different header is
  // reported as mappingStatus "mismatch-blocked".
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  // Provider returns a DIFFERENT model id in the header.
  const adapter = makeMockProvider({
    content: "IDENTITY_PROBE_OK",
    headers: { "x-model-id": "some/other-model" },
  });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  for (const r of result.runs) {
    assert.equal(r.modelRevision.returnedModelId, "some/other-model",
      "returnedModelId must be captured from the x-model-id header");
    assert.equal(r.modelRevision.mappingStatus, "mismatch-blocked",
      "mappingStatus must be 'mismatch-blocked' when x-model-id differs from requested model");
  }
});

test("FIX4 (FIXED): returnedModelId is null and mappingStatus not-returned when header absent", async () => {
  // FIXED (C2): when the x-model-id header is absent, the code must NOT
  // fabricate the returned model id; it records null and "not-returned".
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider({
    content: "IDENTITY_PROBE_OK",
    headers: {},
  });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  for (const r of result.runs) {
    assert.equal(r.modelRevision.returnedModelId, null);
    assert.equal(r.modelRevision.mappingStatus, "not-returned");
  }
});

test("FIX4: identity NOT established when provider throws (catch path)", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider({ throwOnCall: true });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  assert.equal(result.identityAttested, false);
  for (const r of result.runs) {
    assert.equal(r.finishReason, "identity_not_established");
    assert.equal(r.modelRevision.mappingStatus, "not-returned");
    assert.equal(r.capabilityProbe, undefined);
  }
});

test("FIX4 (FIXED): identity NOT established when probe returns wrong marker", async () => {
  // FIXED (C2): attestIdentity now verifies the probe response contains
  // IDENTITY_PROBE_OK. A probe that returns "WRONG" no longer attests identity.
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider({
    probeContent: "WRONG",
    content: "main",
  });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  assert.equal(result.identityAttested, false,
    "identity must NOT be attested when the probe returns 'WRONG' instead of IDENTITY_PROBE_OK");
  for (const r of result.runs) {
    assert.equal(r.finishReason, "identity_not_established");
  }
});

// ============================================================================
// FIX4-IDENTITY: Body model fallback when x-model-id header is absent
// (unblocks the full Makora matrix — Makora does not return x-model-id)
// ============================================================================

test("FIX4-IDENTITY: identity established via body model when header absent", async () => {
  // Makora does not return the x-model-id header. The response body `model`
  // field is the authoritative fallback. When it matches the requested model,
  // identity IS established and the run is NOT identity-unverified.
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider({
    content: "IDENTITY_PROBE_OK",
    headers: {},
    bodyModel: cell.model_id,
  });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  assert.equal(result.identityAttested, true,
    "identity must be attested via body model when header absent and body matches");
  for (const r of result.runs) {
    assert.equal(r.modelRevision.mappingStatus, "exact-body",
      "mappingStatus must be 'exact-body' when verified via response body");
    assert.equal(r.modelRevision.returnedModelId, cell.model_id,
      "returnedModelId must be the body model string");
    assert.equal(r.finishReason, "stop",
      "run must NOT be blocked when identity established via body");
  }
});

test("FIX4-IDENTITY: body model mismatch blocks the run", async () => {
  // A body model that does NOT match the requested model is a real mismatch.
  // The endpoint profile declares exact_model_string_required:true.
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider({
    content: "IDENTITY_PROBE_OK",
    headers: {},
    bodyModel: "some/other-model",
  });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  assert.equal(result.identityAttested, false,
    "identity must NOT be attested when body model mismatches");
  for (const r of result.runs) {
    assert.equal(r.modelRevision.mappingStatus, "mismatch-blocked",
      "body mismatch must produce mappingStatus 'mismatch-blocked'");
    assert.equal(r.modelRevision.returnedModelId, "some/other-model");
    assert.equal(r.finishReason, "identity_not_established",
      "a body mismatch must block the run");
  }
});

test("FIX4-IDENTITY: both header and body absent → not-returned (genuine failure)", async () => {
  // When neither the x-model-id header nor the body model is present, identity
  // cannot be established. This is a genuine failure that should still trigger
  // the M2 pause after the threshold.
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider({
    content: "IDENTITY_PROBE_OK",
    headers: {},
  });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  assert.equal(result.identityAttested, false,
    "identity must NOT be attested when both header and body are absent");
  for (const r of result.runs) {
    assert.equal(r.modelRevision.mappingStatus, "not-returned",
      "both absent must produce 'not-returned'");
    assert.equal(r.modelRevision.returnedModelId, null);
  }
});

test("FIX4-IDENTITY: header takes priority over body (header match wins)", async () => {
  // Priority: x-model-id header > body model. When the header is present and
  // matches, mappingStatus is "exact" (not "exact-body") even if the body
  // also has a model field.
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider({
    content: "IDENTITY_PROBE_OK",
    headers: { "x-model-id": cell.model_id },
    bodyModel: cell.model_id,
  });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  for (const r of result.runs) {
    assert.equal(r.modelRevision.mappingStatus, "exact",
      "header match must take priority (mappingStatus 'exact', not 'exact-body')");
  }
});

test("FIX4-IDENTITY: header mismatch blocks even if body matches", async () => {
  // A header mismatch is a real mismatch regardless of the body. The header
  // is the higher-priority identity source.
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider({
    content: "IDENTITY_PROBE_OK",
    headers: { "x-model-id": "wrong/header-model" },
    bodyModel: cell.model_id,
  });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  for (const r of result.runs) {
    assert.equal(r.modelRevision.mappingStatus, "mismatch-blocked",
      "header mismatch must block even if body matches");
    assert.equal(r.modelRevision.returnedModelId, "wrong/header-model",
      "returnedModelId must be the header value (higher priority)");
    assert.equal(r.finishReason, "identity_not_established");
  }
});

test("FIX4-IDENTITY: capabilityProbe includes body model when present", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider({
    content: "IDENTITY_PROBE_OK",
    headers: {},
    bodyModel: cell.model_id,
  });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  for (const r of result.runs) {
    assert.ok(r.capabilityProbe !== undefined);
    assert.equal(r.capabilityProbe.model, cell.model_id,
      "capabilityProbe must include the body model for evidence");
  }
});

// ============================================================================
// FIX 5: Prompt enrichment — prompts include project context (code files)
// ============================================================================

test("FIX5: enrichPrompt produces 'Here is the project context:' prefix", async () => {
  const seed = SEED_SCENARIOS[0]!;
  const enriched = enrichPrompt(seed.promptVariants.original, seed, SEED_PROJECTS);
  assert.ok(
    enriched.startsWith("Here is the project context:"),
    `enriched prompt should start with 'Here is the project context:', got: ${enriched.slice(0, 60)}`,
  );
});

test("FIX5: enriched prompt includes the project display name", async () => {
  const seed = SEED_SCENARIOS[0]!;
  const project = SEED_PROJECTS.find((p) => p.projectId === seed.projectRef)!;
  const enriched = enrichPrompt(seed.promptVariants.original, seed, SEED_PROJECTS);
  assert.ok(
    enriched.includes(project.displayName),
    `enriched prompt should include project display name '${project.displayName}'`,
  );
});

test("FIX5: enriched prompt includes file content from the project", async () => {
  const seed = SEED_SCENARIOS[0]!;
  const enriched = enrichPrompt(seed.promptVariants.original, seed, SEED_PROJECTS);
  // The ts-utils project has index.ts and utils.ts with actual code.
  assert.ok(enriched.includes("---"), "enriched prompt should include file separator markers (---)");
  assert.ok(enriched.includes(".ts"), "enriched prompt should include .ts file references");
});

test("FIX5: enriched prompt is significantly longer than base prompt", async () => {
  const seed = SEED_SCENARIOS[0]!;
  const base = seed.promptVariants.original;
  const enriched = enrichPrompt(base, seed, SEED_PROJECTS);
  assert.ok(
    enriched.length > base.length + 100,
    `enriched prompt should be >100 chars longer than base (base=${base.length}, enriched=${enriched.length})`,
  );
});

test("FIX5 (mutation guard): buildScenarioPromptIndex returns enriched prompts", async () => {
  const config = createDevelopmentConfig(SEED_SCENARIOS, SEED_PROJECTS);
  const index = buildScenarioPromptIndex(config);
  assert.ok(index.size > 0, "prompt index should not be empty");
  for (const [scenarioId, prompt] of index) {
    assert.ok(
      prompt.includes("Here is the project context:") || prompt.length > 0,
      `prompt for scenario ${scenarioId} should be enriched or at least non-empty`,
    );
  }
  // At least one should be enriched (the ones with valid project refs).
  const enriched = [...index.values()].filter((p) => p.includes("Here is the project context:"));
  assert.ok(enriched.length > 0, "at least one prompt should be enriched with project context");
});

test("FIX5 (edge): enrichPrompt with nonexistent project returns base prompt unchanged", async () => {
  const seed = SEED_SCENARIOS[0]!;
  const fakeProjects = [{ ...SEED_PROJECTS[0]!, projectId: "prj_NONEXISTENT" }];
  const enriched = enrichPrompt(seed.promptVariants.original, seed, fakeProjects);
  assert.equal(
    enriched, seed.promptVariants.original,
    "enrichPrompt should return base prompt when project not found",
  );
});

test("FIX5 (edge): enrichPrompt with nonexistent project directory returns base prompt", async () => {
  const seed = SEED_SCENARIOS[0]!;
  // Create a project ref that exists in the projects list but has no fixture directory.
  const fakeProject = { ...SEED_PROJECTS[0]!, displayName: "nonexistent-project-dir" };
  const enriched = enrichPrompt(seed.promptVariants.original, seed, [fakeProject]);
  assert.equal(
    enriched, seed.promptVariants.original,
    "enrichPrompt should return base prompt when project directory doesn't exist",
  );
});

test("FIX5 (edge): loadProjectContext returns null for nonexistent directory", async () => {
  const result = loadProjectContext("nonexistent-project-xyz", 3);
  assert.equal(result, null);
});

// ============================================================================
// FIX 6: Agent events — topology/agent/task events recorded for multi-agent cells
// ============================================================================

test("FIX6: topology events recorded for A1-A5 arms", async () => {
  const dir = mkTempDir("eval-adversarial-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    for (const arm of CONDITION_ARMS) {
      const cell = findCellForArm(matrix, arm);
      if (cell === undefined) continue;
      const adapter = makeMockProvider({ content: "test" });
      const runner = createScenarioRunner({ adapter, timeline: tl });
      await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
    }
    const agentEvents = tl.store.query({ eventType: "agent" });
    const taskEvents = tl.store.query({ eventType: "task" });
    assert.ok(agentEvents.length > 0, "expected agent events for A1-A5 arms");
    assert.ok(taskEvents.length > 0, "expected task events for A1-A5 arms");
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("FIX6: agent events recorded when agent_count > 0", async () => {
  const dir = mkTempDir("eval-adversarial-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const a3Cell = findCellForArm(matrix, "A3") ?? matrix.cells[0]!;
    const adapter = makeMockProvider({ content: "test" });
    const runner = createScenarioRunner({ adapter, timeline: tl });
    await runner.runCell(makeRequest(matrix, a3Cell.cell_id, "test"));
    const agentEvents = tl.store.query({ eventType: "agent" });
    // A3 has 3 agents, 3 runs => at least 9 agent events
    assert.ok(agentEvents.length >= 3, `expected >= 3 agent events for A3 (3 agents), got ${agentEvents.length}`);
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("FIX6: task events recorded when agent_count > 0", async () => {
  const dir = mkTempDir("eval-adversarial-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const a5Cell = findCellForArm(matrix, "A5") ?? matrix.cells[0]!;
    const adapter = makeMockProvider({ content: "test" });
    const runner = createScenarioRunner({ adapter, timeline: tl });
    await runner.runCell(makeRequest(matrix, a5Cell.cell_id, "test"));
    const taskEvents = tl.store.query({ eventType: "task" });
    // 3 runs => at least 3 task events
    assert.ok(taskEvents.length >= 3, `expected >= 3 task events for A5 (3 runs), got ${taskEvents.length}`);
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("FIX6: D0-direct (0 agents) does NOT have agent/task events", async () => {
  const dir = mkTempDir("eval-adversarial-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const d0Cell = findCellForArm(matrix, "D0-direct");
    if (d0Cell === undefined) { tl.close(); return; }
    const adapter = makeMockProvider({ content: "test" });
    const runner = createScenarioRunner({ adapter, timeline: tl });
    await runner.runCell(makeRequest(matrix, d0Cell.cell_id, "test"));
    const agentEvents = tl.store.query({ eventType: "agent" });
    const taskEvents = tl.store.query({ eventType: "task" });
    assert.equal(agentEvents.length, 0, "D0-direct should have 0 agent events");
    assert.equal(taskEvents.length, 0, "D0-direct should have 0 task events");
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("FIX6: N1-noop HAS agent events (agent_count=1 per ARM_AGENT_COUNT)", async () => {
  // N1-noop has agent_count=1 in the matrix generator, so it DOES get agent events.
  // Only D0-direct has agent_count=0. This test documents the actual topology config.
  const dir = mkTempDir("eval-adversarial-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const n1Cell = findCellForArm(matrix, "N1-noop");
    if (n1Cell === undefined) { tl.close(); return; }
    const adapter = makeMockProvider({ content: "test" });
    const runner = createScenarioRunner({ adapter, timeline: tl });
    await runner.runCell(makeRequest(matrix, n1Cell.cell_id, "test"));
    const agentEvents = tl.store.query({ eventType: "agent" });
    assert.ok(agentEvents.length > 0, "N1-noop has agent_count=1, so should have agent events");
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("FIX6 (mutation guard): removing recordTopologyEvents would leave zero agent events", async () => {
  const dir = mkTempDir("eval-adversarial-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const a5Cell = findCellForArm(matrix, "A5") ?? matrix.cells[0]!;
    const adapter = makeMockProvider({ content: "test" });
    const runner = createScenarioRunner({ adapter, timeline: tl });
    await runner.runCell(makeRequest(matrix, a5Cell.cell_id, "test"));
    const agentEvents = tl.store.query({ eventType: "agent" });
    // A5 has 5 agents, 3 runs = 15 agent events minimum
    assert.ok(agentEvents.length >= 15,
      `expected >= 15 agent events for A5 (5 agents x 3 runs), got ${agentEvents.length}. ` +
      `If recordTopologyEvents were removed, this would be 0.`);
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("FIX6: cell run result topology metadata matches agent count for each A-arm", async () => {
  const matrix = devMatrix();
  const armToAgentCount: Record<string, number> = { A1: 1, A2: 2, A3: 3, A4: 4, A5: 5 };
  for (const [arm, expectedCount] of Object.entries(armToAgentCount)) {
    const cell = findCellForArm(matrix, arm as ConditionArm);
    if (cell === undefined) continue;
    const adapter = makeMockProvider({ content: "test" });
    const runner = createScenarioRunner({ adapter });
    const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
    for (const r of result.runs) {
      assert.ok(r.topology !== undefined, `${arm} run should have topology metadata`);
      assert.equal(r.topology.agentCount, expectedCount, `${arm} should have agentCount=${expectedCount}`);
      assert.equal(r.topology.roles.length, expectedCount, `${arm} should have ${expectedCount} roles`);
    }
  }
});

// ============================================================================
// FIX 7: Tool calls — recording path ready for tool calls if present
// ============================================================================

test("FIX7: tool events recorded when result.toolCalls.length > 0", async () => {
  const dir = mkTempDir("eval-adversarial-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const toolCalls: readonly ToolCall[] = [
      {
        id: "call-1",
        type: "function",
        function: { name: "read_file", arguments: '{"path":"src/index.ts"}' },
      },
      {
        id: "call-2",
        type: "function",
        function: { name: "write_file", arguments: '{"path":"src/out.ts","content":"x"}' },
      },
    ];
    const adapter = makeMockProvider({ content: "resp", toolCalls });
    const runner = createScenarioRunner({ adapter, timeline: tl });
    await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
    const toolEvents = tl.store.query({ eventType: "tool" });
    // 2 tool calls x 3 runs = 6 tool events
    assert.ok(toolEvents.length >= 6,
      `expected >= 6 tool events (2 tool calls x 3 runs), got ${toolEvents.length}`);
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("FIX7: no tool events when toolCalls is empty", async () => {
  const dir = mkTempDir("eval-adversarial-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const adapter = makeMockProvider({ content: "resp", toolCalls: [] });
    const runner = createScenarioRunner({ adapter, timeline: tl });
    await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
    const toolEvents = tl.store.query({ eventType: "tool" });
    assert.equal(toolEvents.length, 0, "should have 0 tool events when toolCalls is empty");
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("FIX7 (mutation guard): tool event documents contain tool-call name and id", async () => {
  const dir = mkTempDir("eval-adversarial-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const adapter = makeMockProvider({
      content: "resp",
      toolCalls: [{ id: "tc-xyz", type: "function", function: { name: "search", arguments: "{}" } }],
    });
    const runner = createScenarioRunner({ adapter, timeline: tl });
    await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
    const toolEvents = tl.store.query({ eventType: "tool" });
    assert.ok(toolEvents.length > 0);
    const docs = toolEvents.flatMap((e) => e.documents.filter((d) => d.name === "tool-call"));
    assert.ok(docs.length > 0, "expected tool-call documents");
    const parsed = docs.map((d) => JSON.parse(d.contentJson ?? "{}") as { id?: string; name?: string });
    assert.ok(parsed.some((p) => p.id === "tc-xyz" && p.name === "search"),
      "tool-call document should contain id and function name");
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("FIX7 (edge): toolCalls with single call records exactly one event per run", async () => {
  const dir = mkTempDir("eval-adversarial-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const adapter = makeMockProvider({
      content: "resp",
      toolCalls: [{ id: "single", type: "function", function: { name: "ping", arguments: "{}" } }],
    });
    const runner = createScenarioRunner({ adapter, timeline: tl });
    await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
    const toolEvents = tl.store.query({ eventType: "tool" });
    // 1 tool call x 3 runs = 3 tool events
    assert.equal(toolEvents.length, 3,
      `expected exactly 3 tool events (1 call x 3 runs), got ${toolEvents.length}`);
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// CROSS-CUTTING: Code smell / hidden bug detection
// ============================================================================

test("SMELL (FIXED): error message is captured on the run result (M3)", async () => {
  // FIXED (M3): the error message is no longer discarded via `void message`.
  // A run that throws after identity is established records the message on
  // CellRunResult.error and as a timeline error event.
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  let callCount = 0;
  const adapter: ProviderAdapter = {
    providerId: "mock-fail-after-probe",
    async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> { throw new Error("x"); },
    async chatCompletion(): Promise<ChatCompletionResult> {
      callCount++;
      if (callCount % 2 === 1) {
        // First call: probe succeeds
        return { content: "IDENTITY_PROBE_OK", toolCalls: [], usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 }, finishReason: "stop", headers: {} };
      }
      // Second call: main call throws — triggers executeRun catch block
      throw new Error("MAIN_CALL_FAILED_MARKER");
    },
  };
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  for (const r of result.runs) {
    assert.equal(r.finishReason, "error", "run that throws after identity should have finishReason 'error'");
    assert.equal(r.error, "MAIN_CALL_FAILED_MARKER",
      "the error message must be captured on CellRunResult.error (M3)");
  }
});

test("SMELL (FIXED): attestIdentity respects an already-aborted signal (M4)", async () => {
  // FIXED (M4): attestIdentity no longer voids the AbortSignal. An already
  // aborted signal prevents the probe from establishing identity.
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider({ content: "IDENTITY_PROBE_OK" });
  const runner = createScenarioRunner({ adapter });
  const controller = new AbortController();
  controller.abort();
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test", { signal: controller.signal }));
  // With the signal already aborted, the probe must not establish identity.
  assert.equal(result.identityAttested, false,
    "an already-aborted signal must prevent identity attestation (M4)");
  for (const r of result.runs) {
    assert.equal(r.finishReason, "identity_not_established");
  }
});

test("SMELL (FIXED): scenario-specific oracles are evaluated (C1)", async () => {
  // FIXED (C1): getOraclesForScenario is no longer a stub. The runner looks up
  // the scenario's hidden_oracles from the matrix and evaluates each one.
  // A response that fails a scenario-specific oracle is detected.
  const matrix = devMatrix();
  // Find a cell whose scenario has a non-empty "contains" oracle that "hello"
  // will fail (so we can prove the scenario-specific oracle actually ran).
  let target: { cell: typeof matrix.cells[number]; scenario: typeof matrix.scenarios[number]; failingOracle: string } | undefined;
  for (const cell of matrix.cells) {
    const testEntry = matrix.tests.find((t) => t.test_id === cell.test_id);
    if (testEntry === undefined) continue;
    const scenario = matrix.scenarios.find((s) => s.scenario_id === testEntry.scenario_id);
    if (scenario === undefined) continue;
    const containsOracle = scenario.hidden_oracles.find((o) => o.kind === "contains" && o.pattern.length > 0);
    if (containsOracle !== undefined) {
      target = { cell, scenario, failingOracle: containsOracle.name };
      break;
    }
  }
  assert.ok(target !== undefined, "matrix must contain a scenario with a non-empty contains oracle");
  const adapter = makeMockProvider({ content: "hello" });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, target.cell.cell_id, "test"));
  for (const r of result.runs) {
    const runOracleNames = r.oracleResults.map((o) => o.name);
    for (const oracle of target.scenario.hidden_oracles) {
      assert.ok(runOracleNames.includes(oracle.name), `oracle '${oracle.name}' must be evaluated`);
    }
    const failing = r.oracleResults.find((o) => o.name === target!.failingOracle && !o.passed);
    assert.ok(failing !== undefined, `'hello' must fail the '${target.failingOracle}' contains oracle`);
  }
  assert.equal(result.allOraclesPassed, false, "allOraclesPassed must be false when a scenario-specific oracle fails");
});

test("SMELL: buildCellToArmMap and cli.ts agree on R1-reference arm mapping", async () => {
  // Verify that buildCellToArmMap correctly identifies R1-reference cells,
  // which is what cli.ts uses to set runReferenceTransport.
  const matrix = devMatrix();
  const cellToArm = buildCellToArmMap(matrix);
  const r1Cells = matrix.cells.filter((c) => cellToArm.get(c.cell_id) === "R1-reference");
  assert.ok(r1Cells.length > 0, "should have at least one R1-reference cell");
  for (const cell of r1Cells) {
    const test = matrix.tests.find((t) => t.test_id === cell.test_id)!;
    const cond = matrix.conditions.find((c) => c.condition_id === test.condition_id)!;
    assert.equal(cond.arm, "R1-reference", "cell mapped to R1-reference must have R1-reference condition");
  }
});
