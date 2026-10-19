import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import test from "node:test";

import { createScenarioRunner } from "../../src/evaluation/scenario-runner.ts";
import type { CellExecutionRequest, MatrixDocument } from "../../src/evaluation/types.ts";
import type { ChatStreamEvent, ProviderAdapter } from "../../src/runtime/provider-adapter.ts";
import { devMatrix } from "../support/matrix.ts";
import { mkTempDir } from "../support/temp-dir.ts";

/**
 * C2 regression: attestIdentity never checked the probe response content —
 * HTTP success alone was treated as identity. The fix requires the probe to
 * return the IDENTITY_PROBE_OK marker AND a matching model id (header or body).
 * This test exercises all five identity decision paths so any regression in
 * the attestation logic fails mechanically.
 */

const PROBE_PROMPT = "Reply with exactly: IDENTITY_PROBE_OK";

interface ProbeOpts {
  probeContent: string;
  mainContent?: string;
  headers?: Record<string, string>;
  /** "match" → echo request.model; otherwise use this literal as the body model. */
  bodyModel?: string;
  throwOnProbe?: boolean;
}

function makeAdapter(opts: ProbeOpts): ProviderAdapter {
  const mainContent = opts.mainContent ?? "function reverseString(s){return s}";
  return {
    providerId: "mock",
    async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> {
      yield { type: "content", text: mainContent };
      yield { type: "usage", usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 } };
      yield { type: "finish", reason: "stop" };
    },
    async chatCompletion(request) {
      const isProbe = request.messages[0]?.content === PROBE_PROMPT;
      if (isProbe && opts.throwOnProbe) throw new Error("probe call failed");
      const content = isProbe ? opts.probeContent : mainContent;
      const headers = opts.headers ?? {};
      const result: {
        content: string;
        toolCalls: readonly never[];
        usage: { promptTokens: number; completionTokens: number; totalTokens: number };
        finishReason: string;
        headers?: Readonly<Record<string, string>>;
        model?: string;
      } = {
        content,
        toolCalls: [],
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        finishReason: "stop",
        headers,
      };
      if (opts.bodyModel !== undefined) {
        result.model = opts.bodyModel === "match" ? request.model : opts.bodyModel;
      }
      return result;
    },
  };
}

function makeRequest(matrix: MatrixDocument, cellId: string): CellExecutionRequest {
  return {
    matrix,
    cellId,
    scenarioPrompt: "Write reverseString",
    providerConfig: {
      id: "makora",
      baseUrl: "https://inference.makora.com/v1",
      apiKeyEnvVar: "MAKORA_API_KEY",
      timeoutMs: 60000,
      retries: { maxRetries: 3, initialBackoffMs: 500, maxBackoffMs: 10000, backoffMultiplier: 2 },
    },
    apiKey: "mock-key",
    maxTokens: 256,
  };
}

async function runOnce(adapter: ProviderAdapter, matrix: MatrixDocument, cellId: string) {
  const runner = createScenarioRunner({ adapter });
  return await runner.runCell(makeRequest(matrix, cellId));
}

// (a) probe returns IDENTITY_PROBE_OK + header matches → identity established (exact)
test("identity-attestation: probe OK + x-model-id header matches → identity established (exact)", async () => {
  const dir = mkTempDir("identity-attest-");
  try {
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const result = await runOnce(
      makeAdapter({ probeContent: "IDENTITY_PROBE_OK", headers: { "x-model-id": cell.model_id } }),
      matrix,
      cell.cell_id,
    );
    assert.equal(result.identityAttested, true);
    for (const r of result.runs) {
      assert.equal(r.modelRevision.mappingStatus, "exact");
      assert.equal(r.modelRevision.returnedModelId, cell.model_id);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// (b) probe returns wrong content → identity NOT established, run blocked
test("identity-attestation: probe returns wrong content → identity NOT established (blockRun)", async () => {
  const dir = mkTempDir("identity-attest-");
  try {
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const result = await runOnce(
      makeAdapter({ probeContent: "some other content", headers: { "x-model-id": cell.model_id } }),
      matrix,
      cell.cell_id,
    );
    assert.equal(result.identityAttested, false);
    for (const r of result.runs) {
      assert.equal(r.finishReason, "identity_not_established", "wrong probe content must block the run");
      assert.equal(r.content, "", "a blocked run must produce no content");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// (c) probe returns correct content + header mismatch → identity NOT established, blocked
test("identity-attestation: probe OK + header mismatch → identity NOT established (blockRun)", async () => {
  const dir = mkTempDir("identity-attest-");
  try {
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const result = await runOnce(
      makeAdapter({ probeContent: "IDENTITY_PROBE_OK", headers: { "x-model-id": "other/different-model" } }),
      matrix,
      cell.cell_id,
    );
    assert.equal(result.identityAttested, false);
    for (const r of result.runs) {
      assert.equal(r.modelRevision.mappingStatus, "mismatch-blocked");
      assert.equal(r.finishReason, "identity_not_established", "header mismatch must block the run");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// (d) probe OK + no header + body model matches → identity established (exact-body)
test("identity-attestation: probe OK + no header + body model matches → identity established (exact-body)", async () => {
  const dir = mkTempDir("identity-attest-");
  try {
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const result = await runOnce(
      makeAdapter({ probeContent: "IDENTITY_PROBE_OK", bodyModel: "match" }),
      matrix,
      cell.cell_id,
    );
    assert.equal(result.identityAttested, true);
    for (const r of result.runs) {
      assert.equal(r.modelRevision.mappingStatus, "exact-body", "body model match must establish identity via exact-body");
      assert.equal(r.modelRevision.returnedModelId, cell.model_id);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// (e) probe OK + no header + no body model → identity NOT established (not-returned, soft)
test("identity-attestation: probe OK + no header + no body model → identity NOT established (not-returned)", async () => {
  const dir = mkTempDir("identity-attest-");
  try {
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const result = await runOnce(
      makeAdapter({ probeContent: "IDENTITY_PROBE_OK" }),
      matrix,
      cell.cell_id,
    );
    assert.equal(result.identityAttested, false);
    for (const r of result.runs) {
      assert.equal(r.modelRevision.mappingStatus, "not-returned");
      assert.equal(r.modelRevision.returnedModelId, null);
      // Soft limitation: not-returned does NOT block the run, but marks identity-unverified.
      assert.notEqual(r.finishReason, "identity_not_established", "not-returned must NOT block the run (soft limitation)");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// (f) probe call throws → identity NOT established, run blocked
test("identity-attestation: probe call failure → identity NOT established (blockRun)", async () => {
  const dir = mkTempDir("identity-attest-");
  try {
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const result = await runOnce(
      makeAdapter({ probeContent: "", throwOnProbe: true }),
      matrix,
      cell.cell_id,
    );
    assert.equal(result.identityAttested, false);
    for (const r of result.runs) {
      assert.equal(r.modelRevision.mappingStatus, "not-returned");
      assert.equal(r.finishReason, "identity_not_established", "probe call failure must block the run");
      assert.equal(r.capabilityProbe, undefined, "capabilityProbe must be undefined when the probe call fails");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// (g) probe OK + no header + body model mismatch → identity NOT established (mismatch-blocked)
test("identity-attestation: probe OK + no header + body model mismatch → mismatch-blocked", async () => {
  const dir = mkTempDir("identity-attest-");
  try {
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const result = await runOnce(
      makeAdapter({ probeContent: "IDENTITY_PROBE_OK", bodyModel: "wrong/model-id" }),
      matrix,
      cell.cell_id,
    );
    assert.equal(result.identityAttested, false);
    for (const r of result.runs) {
      assert.equal(r.modelRevision.mappingStatus, "mismatch-blocked");
      assert.equal(r.finishReason, "identity_not_established", "body model mismatch must block the run");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
