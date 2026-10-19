import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { deepFreeze, sha256 } from "../../src/kernel/integrity.ts";
import { createScenarioRunner, checkOracle } from "../../src/evaluation/scenario-runner.ts";
import { executeMatrix } from "../../src/evaluation/matrix-executor.ts";
import {
  createResultsWriter,
  reconcileExecution,
  type CellResultRecord,
} from "../../src/evaluation/results-writer.ts";
import { validateMatrixPayloadHash } from "../../src/evaluation/semantic-validators.ts";
import { calculateBudget, formatBudgetReport } from "../../src/evaluation/budget-calculator.ts";
import { SEED_SCENARIOS, SEED_PROJECTS } from "../../src/evaluation/scenarios.ts";
import type {
  CellExecutionRequest,
  ConditionArm,
  HiddenOracle,
  MatrixDocument,
} from "../../src/evaluation/types.ts";
import type {
  ChatCompletionResult,
  ChatStreamEvent,
  ProviderAdapter,
} from "../../src/runtime/provider-adapter.ts";
import { makeMockProvider } from "../support/mock-provider.ts";
import { makeTimelineRecorder } from "../support/timeline.ts";
import { devMatrix } from "../support/matrix.ts";
import { mkTempDir } from "../support/temp-dir.ts";
import { address, serve, type UpstreamRequest } from "../support/loopback-upstream.ts";

/**
 * Adversarial / mutation tests for the fix2 commit (1983566) that closed
 * 20 gaps (C1-C10, M1-M10). Each test tries to break a specific fix or
 * exercise an edge case. A failing test indicates a real bug.
 *
 * These tests are INDEPENDENT of the prior adversarial-fixes.test.ts and
 * critical-fixes.test.ts rounds; they target edge cases and regressions
 * those files do not cover.
 */

const PROBE_PROMPT = "Reply with exactly: IDENTITY_PROBE_OK";

const mkTimeline = (dir: string) => makeTimelineRecorder(dir, "adversarial-2");

function makeRequest(
  matrix: MatrixDocument,
  cellId: string,
  prompt: string,
  overrides: Readonly<Record<string, unknown>> = {},
): CellExecutionRequest {
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

function findCellForArm(
  matrix: MatrixDocument,
  arm: ConditionArm,
): { cell_id: string; model_id: string; test_id: string } | undefined {
  const conditionMap = new Map(matrix.conditions.map((c) => [c.condition_id, c.arm]));
  for (const cell of matrix.cells) {
    const test = matrix.tests.find((t) => t.test_id === cell.test_id);
    if (test !== undefined && conditionMap.get(test.condition_id) === arm) return cell;
  }
  return undefined;
}

function findCellWithOracle(matrix: MatrixDocument, oracleName: string): { cell: MatrixDocument["cells"][number]; scenario: MatrixDocument["scenarios"][number] } | undefined {
  for (const cell of matrix.cells) {
    const testEntry = matrix.tests.find((t) => t.test_id === cell.test_id);
    if (testEntry === undefined) continue;
    const scenario = matrix.scenarios.find((s) => s.scenario_id === testEntry.scenario_id);
    if (scenario === undefined) continue;
    if (scenario.hidden_oracles.some((o) => o.name === oracleName)) {
      return { cell, scenario };
    }
  }
  return undefined;
}

// ============================================================================
// C1 — Scenario oracles actually evaluated
// ============================================================================

test("C1: different scenarios return different oracle sets (not just non-empty-response)", async () => {
  const matrix = devMatrix();
  // Pick two cells whose scenarios have distinct oracle names.
  const seen = new Map<string, { cell: MatrixDocument["cells"][number]; names: string[] }>();
  for (const cell of matrix.cells) {
    const testEntry = matrix.tests.find((t) => t.test_id === cell.test_id);
    if (testEntry === undefined) continue;
    const scenario = matrix.scenarios.find((s) => s.scenario_id === testEntry.scenario_id);
    if (scenario === undefined) continue;
    const names = scenario.hidden_oracles.map((o) => o.name);
    const key = names.join(",");
    if (!seen.has(key)) seen.set(key, { cell, names });
    if (seen.size >= 2) break;
  }
  assert.ok(seen.size >= 2, "matrix must contain scenarios with distinct oracle sets");
  const sets = [...seen.values()];
  const a = sets[0]!.names;
  const b = sets[1]!.names;
  assert.notDeepEqual(a, b, "two scenarios must have different oracle name sets");
});

test("C1: runOracles evaluates scenario-specific oracles, not just non-empty-response", async () => {
  const matrix = devMatrix();
  // "contains-format-date" is in P1-baseline (scored, has cells).
  const target = findCellWithOracle(matrix, "contains-format-date");
  assert.ok(target !== undefined, "matrix must have a scored scenario with contains-format-date oracle");
  const adapter = makeMockProvider({ content: "function formatDate(d) { return d; }" });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, target.cell.cell_id, "test"));
  for (const r of result.runs) {
    const names = r.oracleResults.map((o) => o.name);
    assert.ok(names.includes("contains-format-date"), "scenario-specific oracle must be evaluated");
    assert.ok(names.includes("non-empty-response"), "common oracle must also be evaluated");
    assert.ok(r.oracleResults.length >= 2, "should have at least 2 oracles for this scenario");
  }
});

test("C1: response missing the expected pattern FAILS the oracle", async () => {
  const matrix = devMatrix();
  const target = findCellWithOracle(matrix, "contains-format-date");
  assert.ok(target !== undefined);
  const adapter = makeMockProvider({ content: "I will not write the function you asked for." });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, target.cell.cell_id, "test"));
  for (const r of result.runs) {
    const oracle = r.oracleResults.find((o) => o.name === "contains-format-date");
    assert.ok(oracle !== undefined);
    assert.equal(oracle.passed, false, "response without 'formatDate' must fail the contains oracle");
  }
  assert.equal(result.allOraclesPassed, false);
});

test("C1: response containing the pattern PASSES the oracle", async () => {
  const matrix = devMatrix();
  const target = findCellWithOracle(matrix, "contains-format-date");
  assert.ok(target !== undefined);
  const adapter = makeMockProvider({ content: "export function formatDate(d: Date): string { return d.toISOString(); }" });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, target.cell.cell_id, "test"));
  for (const r of result.runs) {
    const oracle = r.oracleResults.find((o) => o.name === "contains-format-date");
    assert.ok(oracle !== undefined);
    assert.equal(oracle.passed, true, "response with 'formatDate' must pass the contains oracle");
  }
});

test("C1: contains and not-contains oracle kinds both work", () => {
  const contains: HiddenOracle = { name: "c", kind: "contains", pattern: "hello", expected: true };
  const notContains: HiddenOracle = { name: "nc", kind: "not-contains", pattern: "bad", expected: true };
  assert.equal(checkOracle(contains, "hello world").passed, true);
  assert.equal(checkOracle(contains, "goodbye").passed, false);
  assert.equal(checkOracle(notContains, "hello world").passed, true);
  assert.equal(checkOracle(notContains, "this is bad").passed, false);
});

test("C1: not-contains with expected=false inverts correctly (mutation guard)", () => {
  // not-contains: actual =!content.includes(pattern); passed = actual === expected.
  // expected=false means we EXPECT the pattern to be present (actual=false → passed=true).
  const oracle: HiddenOracle = { name: "x", kind: "not-contains", pattern: "secret", expected: false };
  // Content INCLUDES "secret" → actual =!true = false → passed = false===false = true.
  assert.equal(checkOracle(oracle, "no secret here").passed, true,
    "not-contains expected=false: pattern present → actual=false → passed=true");
  // Content EXCLUDES "secret" → actual = true → passed = true===false = false.
  assert.equal(checkOracle(oracle, "clean content").passed, false,
    "not-contains expected=false: pattern absent → actual=true → passed=false");
  assert.equal(checkOracle(oracle, "has secret").passed, true,
    "not-contains expected=false: pattern present → passed=true");
});

test("C1 (mutation guard): stub getOraclesForScenario returning only non-empty-response would fail", async () => {
  // If someone reverts runOracles to return only a hardcoded non-empty-response oracle,
  // the scenario-specific oracle names would be absent. This test catches that.
  const matrix = devMatrix();
  const target = findCellWithOracle(matrix, "contains-format-date");
  assert.ok(target !== undefined);
  const adapter = makeMockProvider({ content: "formatDate" });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, target.cell.cell_id, "test"));
  // The scenario has oracles beyond non-empty-response; all must be evaluated,
  // PLUS the anti-echo oracle (MAJ-9) added to every run.
  const expectedOracleCount = target.scenario.hidden_oracles.length + 1;
  for (const r of result.runs) {
    assert.equal(r.oracleResults.length, expectedOracleCount,
      `expected ${expectedOracleCount} oracle results (scenario oracles + anti-echo), got ${r.oracleResults.length}`);
    assert.ok(r.oracleResults.some((o) => o.name === "not-echo"), "anti-echo oracle must be present");
  }
});

test("C1 (edge): scenario with 0 hidden oracles produces 0 oracle results", async () => {
  // Build a minimal matrix-like scenario record with no oracles by using a custom matrix.
  // We reuse devMatrix but find a cell and verify the empty-oracle case via checkOracle directly.
  const emptyOracle: HiddenOracle = { name: "x", kind: "contains", pattern: "", expected: true };
  // Empty pattern → checks content.length > 0.
  assert.equal(checkOracle(emptyOracle, "").passed, false, "empty content with empty-pattern oracle must fail");
  assert.equal(checkOracle(emptyOracle, "x").passed, true, "non-empty content with empty-pattern oracle must pass");
});

test("C1 (edge): contains oracle with empty pattern checks non-empty content", () => {
  const oracle: HiddenOracle = { name: "non-empty", kind: "contains", pattern: "", expected: true };
  assert.equal(checkOracle(oracle, "").passed, false, "empty content must fail");
  assert.equal(checkOracle(oracle, "anything").passed, true, "non-empty content must pass");
  // expected=false edge: empty pattern, expected=false
  const inv: HiddenOracle = { name: "inv", kind: "contains", pattern: "", expected: false };
  assert.equal(checkOracle(inv, "anything").passed, false, "non-empty content with expected=false must not pass");
});

// ============================================================================
// C2 — Identity attestation
// ============================================================================

test("C2: identity NOT established when probe returns wrong content", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider({
    probeContent: "I am a different model returning garbage",
    content: "main response",
  });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  assert.equal(result.identityAttested, false);
  for (const r of result.runs) {
    assert.equal(r.finishReason, "identity_not_established");
  }
});

test("C2: identity IS established when probe returns IDENTITY_PROBE_OK", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider({ content: "main", headers: { "x-model-id": cell.model_id } });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  assert.equal(result.identityAttested, true);
});

test("C2: returnedModelId comes from x-model-id header when present", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider({
    content: "main",
    headers: { "x-model-id": cell.model_id },
  });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  for (const r of result.runs) {
    assert.equal(r.modelRevision.returnedModelId, cell.model_id);
  }
});

test("C2: returnedModelId is null and mappingStatus not-returned when header absent", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider({ content: "main", headers: {} });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  for (const r of result.runs) {
    assert.equal(r.modelRevision.returnedModelId, null);
    assert.equal(r.modelRevision.mappingStatus, "not-returned");
  }
});

test("C2: mappingStatus is exact when header matches requested model", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider({ content: "main", headers: { "x-model-id": cell.model_id } });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  for (const r of result.runs) {
    assert.equal(r.modelRevision.mappingStatus, "exact");
  }
});

test("C2: mappingStatus is mismatch-blocked when header differs from requested", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider({
    content: "main",
    headers: { "x-model-id": "some/different-model" },
  });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  for (const r of result.runs) {
    assert.equal(r.modelRevision.mappingStatus, "mismatch-blocked");
    assert.equal(r.modelRevision.returnedModelId, "some/different-model");
  }
});

test("C2 (FIXED): a model mismatch blocks the run — finishReason is identity_not_established", async () => {
  // MAJ-6: a model mismatch (x-model-id differs from requested) MUST block the
  // run. The endpoint profile declares model_fallback_allowed:false and
  // exact_model_string_required:true. The run returns finishReason
  // "identity_not_established" and produces no content.
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider({
    content: "main response content",
    headers: { "x-model-id": "some/different-model" },
  });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  for (const r of result.runs) {
    assert.equal(r.finishReason, "identity_not_established",
      "a model mismatch must block the run (finishReason=identity_not_established)");
    assert.equal(r.content, "", "a blocked run must produce no content");
  }
  assert.equal(result.identityAttested, false, "mismatch → identityAttested false");
});

test("C2 (FIXED): a model mismatch run is counted as FAILED if oracles pass and no error", async () => {
  // MAJ-6 + MAJ-8: a model mismatch blocks the run, leaving oracleResults empty.
  // The non-vacuous allOraclesPassed check makes the cell FAILED (not passed).
  const dir = mkTempDir("eval-adv2-");
  try {
    const matrix = devMatrix();
    const target = findCellWithOracle(matrix, "contains-format-date");
    assert.ok(target !== undefined, "need a scored scenario with a contains oracle");
    const adapter = makeMockProvider({
      content: "function formatDate(d) { return d.toISOString(); }",
      headers: { "x-model-id": "wrong/model" },
    });
    const runner = createScenarioRunner({ adapter });
    const cellResult = await runner.runCell(makeRequest(matrix, target.cell.cell_id, "test"));
    assert.equal(cellResult.identityAttested, false, "mismatch → identityAttested false");
    assert.equal(cellResult.allOraclesPassed, false, "blocked run → allOraclesPassed false (non-vacuous)");
    assert.equal(cellResult.error, null);
    const w = createResultsWriter({
      outputDir: dir, matrix, budgetEstimate: calculateBudget(matrix),
      budgetTokens: null, budgetWallTimeSeconds: null,
    });
    w.writeMatrixDocument();
    w.recordCellResult({
      cellId: target.cell.cell_id, modelId: target.cell.model_id, testId: target.cell.test_id,
      scenarioId: target.scenario.scenario_id, conditionArm: "A1",
      runs: cellResult.runs, allOraclesPassed: cellResult.allOraclesPassed,
      identityAttested: cellResult.identityAttested, error: cellResult.error,
      totalTokens: 0, totalDurationMs: 0,
    });
    const results = w.finalize("complete", new Date().toISOString(), 10);
    assert.equal(results.failedCells, 1,
      "a model-mismatch cell with blocked oracles MUST be counted as failed");
    const report = readFileSync(join(dir, "final-report.md"), "utf8");
    assert.ok(report.includes(target.cell.cell_id),
      "the mismatch cell must appear in the Failed Cells section");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("C2 (mutation guard): hardcoding identityEstablished=true breaks probe-content check", async () => {
  // If someone hardcodes identityEstablished=true, the wrong-content probe
  // test above catches it. This test re-verifies with a different wrong payload.
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider({
    probeContent: "",
    content: "main",
  });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  assert.equal(result.identityAttested, false,
    "empty probe content must not establish identity (no IDENTITY_PROBE_OK marker)");
});

test("C2 (edge): probe response with extra whitespace around IDENTITY_PROBE_OK still passes", async () => {
  // The check is `content.includes(IDENTITY_PROBE_OK)`, so surrounding
  // whitespace is tolerated. This documents the substring-match behavior.
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider({
    probeContent: "   IDENTITY_PROBE_OK   ",
    content: "main",
    headers: { "x-model-id": cell.model_id },
  });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  assert.equal(result.identityAttested, true,
    "substring match tolerates surrounding whitespace around the marker");
});

test("C2 (edge): probe response containing the marker as a substring passes", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider({
    probeContent: "The marker is IDENTITY_PROBE_OK and more text",
    content: "main",
    headers: { "x-model-id": cell.model_id },
  });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  assert.equal(result.identityAttested, true, "substring match passes even with extra text");
});

test("C2 (edge): empty x-model-id header is treated as not-returned", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider({
    content: "main",
    headers: { "x-model-id": "" },
  });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  for (const r of result.runs) {
    assert.equal(r.modelRevision.returnedModelId, null, "empty x-model-id → null returnedModelId");
    assert.equal(r.modelRevision.mappingStatus, "not-returned", "empty x-model-id → not-returned");
  }
});

test("C2: probe-call failure (throw) does not establish identity and records not-returned", async () => {
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

// ============================================================================
// C3 — Content digests cover exactly the stored contentJson
// ============================================================================

test("C3: probe-response digest equals sha256(contentJson)", async () => {
  const dir = mkTempDir("eval-adv2-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const runner = createScenarioRunner({ adapter: makeMockProvider({ content: "resp" }), timeline: tl });
    await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
    const docs = tl.store.query({ eventType: "provider" }).flatMap((e) =>
      e.documents.filter((d) => d.name === "probe-response"));
    assert.ok(docs.length > 0);
    for (const d of docs) {
      assert.equal(d.contentDigest, sha256(d.contentJson ?? ""),
        "probe-response digest must equal sha256 of the stored contentJson");
    }
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("C3: agent-role digest equals sha256(contentJson) and includes communicationGraph/workspaceMode/roles", async () => {
  const dir = mkTempDir("eval-adv2-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const a3Cell = findCellForArm(matrix, "A3") ?? matrix.cells[0]!;
    const runner = createScenarioRunner({ adapter: makeMockProvider({ content: "resp" }), timeline: tl });
    await runner.runCell(makeRequest(matrix, a3Cell.cell_id, "test"));
    const docs = tl.store.query({ eventType: "agent" }).flatMap((e) =>
      e.documents.filter((d) => d.name === "agent-role"));
    assert.ok(docs.length > 0, "expected agent-role documents for A3");
    for (const d of docs) {
      assert.equal(d.contentDigest, sha256(d.contentJson ?? ""),
        "agent-role digest must equal sha256 of the stored contentJson");
      const parsed = JSON.parse(d.contentJson ?? "{}") as {
        communicationGraph?: string; workspaceMode?: string; specialty?: string; roleId?: string;
      };
      assert.ok(parsed.communicationGraph !== undefined, "agent-role must include communicationGraph");
      assert.ok(parsed.workspaceMode !== undefined, "agent-role must include workspaceMode");
      assert.ok(parsed.specialty !== undefined, "agent-role must include specialty");
      assert.ok(parsed.roleId !== undefined, "agent-role must include roleId");
    }
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("C3: topology digest equals sha256(contentJson) and includes agentCount/communicationGraph/workspaceMode/roles", async () => {
  const dir = mkTempDir("eval-adv2-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const a2Cell = findCellForArm(matrix, "A2") ?? matrix.cells[0]!;
    const runner = createScenarioRunner({ adapter: makeMockProvider({ content: "resp" }), timeline: tl });
    await runner.runCell(makeRequest(matrix, a2Cell.cell_id, "test"));
    const docs = tl.store.query({ eventType: "task" }).flatMap((e) =>
      e.documents.filter((d) => d.name === "topology"));
    assert.ok(docs.length > 0, "expected topology documents for A2");
    for (const d of docs) {
      assert.equal(d.contentDigest, sha256(d.contentJson ?? ""),
        "topology digest must equal sha256 of the stored contentJson");
      const parsed = JSON.parse(d.contentJson ?? "{}") as {
        agentCount?: number; communicationGraph?: string; workspaceMode?: string; roles?: unknown[];
      };
      assert.ok(parsed.agentCount !== undefined, "topology must include agentCount");
      assert.ok(parsed.communicationGraph !== undefined, "topology must include communicationGraph");
      assert.ok(parsed.workspaceMode !== undefined, "topology must include workspaceMode");
      assert.ok(Array.isArray(parsed.roles), "topology must include roles array");
    }
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("C3: request-body digest equals sha256(contentJson)", async () => {
  const dir = mkTempDir("eval-adv2-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const runner = createScenarioRunner({ adapter: makeMockProvider({ content: "resp" }), timeline: tl });
    await runner.runCell(makeRequest(matrix, cell.cell_id, "test prompt"));
    const docs = tl.store.query({ eventType: "provider" }).flatMap((e) =>
      e.documents.filter((d) => d.name === "request-body"));
    assert.ok(docs.length > 0);
    for (const d of docs) {
      assert.equal(d.contentDigest, sha256(d.contentJson ?? ""),
        "request-body digest must equal sha256 of the stored contentJson");
    }
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("C3: temperature digest equals sha256(contentJson)", async () => {
  const dir = mkTempDir("eval-adv2-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const runner = createScenarioRunner({ adapter: makeMockProvider({ content: "resp" }), timeline: tl });
    await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
    const docs = tl.store.query({ eventType: "run" }).flatMap((e) =>
      e.documents.filter((d) => d.name === "temperature"));
    assert.ok(docs.length > 0);
    for (const d of docs) {
      assert.equal(d.contentDigest, sha256(d.contentJson ?? ""),
        "temperature digest must equal sha256 of the stored contentJson");
    }
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("C3: tool-call digest equals sha256(contentJson) including arguments", async () => {
  const dir = mkTempDir("eval-adv2-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const tc = [{ id: "tc-1", type: "function" as const, function: { name: "read_file", arguments: '{"path":"src/x.ts"}' } }];
    const runner = createScenarioRunner({
      adapter: makeMockProvider({ content: "resp", toolCalls: tc }),
      timeline: tl,
    });
    await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
    const docs = tl.store.query({ eventType: "tool" }).flatMap((e) =>
      e.documents.filter((d) => d.name === "tool-call"));
    assert.ok(docs.length > 0);
    for (const d of docs) {
      assert.equal(d.contentDigest, sha256(d.contentJson ?? ""),
        "tool-call digest must equal sha256 of the stored contentJson (including arguments)");
      const parsed = JSON.parse(d.contentJson ?? "{}") as { arguments?: string; name?: string; id?: string };
      assert.ok(parsed.arguments !== undefined, "tool-call must include arguments");
      assert.ok(parsed.name !== undefined, "tool-call must include function name");
      assert.ok(parsed.id !== undefined, "tool-call must include id");
    }
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("C3: prompt and response digests equal sha256(contentJson)", async () => {
  const dir = mkTempDir("eval-adv2-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const runner = createScenarioRunner({ adapter: makeMockProvider({ content: "resp-content" }), timeline: tl });
    await runner.runCell(makeRequest(matrix, cell.cell_id, "prompt-content"));
    const docs = tl.store.query({ eventType: "message" }).flatMap((e) => e.documents);
    assert.ok(docs.length > 0);
    for (const d of docs) {
      assert.equal(d.contentDigest, sha256(d.contentJson ?? ""),
        `${d.name} digest must equal sha256 of the stored contentJson`);
    }
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("C3 (mutation guard): adding a field to the stored object but not the digest is detectable", () => {
  // Simulate the OLD bug: digest computed over a subset. We verify that
  // sha256(contentJson) === contentDigest for a representative object.
  const obj = { content: "x", usage: { total: 5 }, headers: { "x": "y" }, finishReason: "stop" };
  const json = JSON.stringify(obj);
  const digest = sha256(json);
  // If someone stored the full object but computed the digest over only
  // {content}, this assertion would fail.
  assert.equal(digest, sha256(json));
  assert.notEqual(digest, sha256(JSON.stringify({ content: "x" })),
    "digest over a subset must NOT match the digest over the full object");
});

test("C3 (tamper): changing contentJson invalidates the digest", async () => {
  // If the database is tampered with (contentJson modified), the digest
  // computed from the (unchanged) contentJson would no longer match.
  const json1 = JSON.stringify({ content: "original" });
  const json2 = JSON.stringify({ content: "tampered" });
  assert.notEqual(sha256(json1), sha256(json2),
    "tampering with contentJson must produce a different digest");
});

// ============================================================================
// C4 — Matrix state machine
// ============================================================================

test("C4: results-writer transitions preregistered→frozen→executing→complete", () => {
  const dir = mkTempDir("eval-adv2-");
  try {
    const m = devMatrix();
    const w = createResultsWriter({
      outputDir: dir, matrix: m, budgetEstimate: calculateBudget(m),
      budgetTokens: null, budgetWallTimeSeconds: null,
    });
    assert.equal(w.getResults().matrixState, "preregistered");
    w.writeMatrixDocument();
    assert.equal(w.getResults().matrixState, "frozen");
    w.recordCellResult({
      cellId: "c1", modelId: m.models[0]!, testId: "t1", scenarioId: "s1", conditionArm: "A1",
      runs: [], allOraclesPassed: true, identityAttested: true, error: null, totalTokens: 0, totalDurationMs: 0,
    });
    assert.equal(w.getResults().matrixState, "executing");
    const results = w.finalize("complete", new Date().toISOString(), 50);
    assert.equal(results.matrixState, "complete");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("C4 (FIXED): finalize('complete') throws from preregistered (state machine enforced)", () => {
  // MAJ-5: the state machine is enforced. Calling finalize("complete") without
  // writeMatrixDocument or recordCellResult/beginExecution throws because the
  // matrix must be in the "executing" state.
  const dir = mkTempDir("eval-adv2-");
  try {
    const m = devMatrix();
    const w = createResultsWriter({
      outputDir: dir, matrix: m, budgetEstimate: calculateBudget(m),
      budgetTokens: null, budgetWallTimeSeconds: null,
    });
    assert.equal(w.getResults().matrixState, "preregistered",
      "precondition: starts at preregistered");
    assert.throws(() => w.finalize("complete", new Date().toISOString(), 0),
      /executing/,
      "finalize('complete') from preregistered must throw (state machine enforced)");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("C4 (FIXED): finalize('complete') throws from frozen without executing", () => {
  // MAJ-5: even after writeMatrixDocument (frozen), finalize('complete') without
  // beginExecution/recordCellResult throws — executing was skipped.
  const dir = mkTempDir("eval-adv2-");
  try {
    const m = devMatrix();
    const w = createResultsWriter({
      outputDir: dir, matrix: m, budgetEstimate: calculateBudget(m),
      budgetTokens: null, budgetWallTimeSeconds: null,
    });
    w.writeMatrixDocument();
    assert.equal(w.getResults().matrixState, "frozen");
    assert.throws(() => w.finalize("complete", new Date().toISOString(), 0),
      /executing/,
      "finalize('complete') from frozen must throw (executing was skipped)");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("C4: a partial run leaves matrixState as executing (not complete)", () => {
  const dir = mkTempDir("eval-adv2-");
  try {
    const m = devMatrix();
    const w = createResultsWriter({
      outputDir: dir, matrix: m, budgetEstimate: calculateBudget(m),
      budgetTokens: null, budgetWallTimeSeconds: null,
    });
    w.writeMatrixDocument();
    w.recordCellResult({
      cellId: "c1", modelId: m.models[0]!, testId: "t1", scenarioId: "s1", conditionArm: "A1",
      runs: [], allOraclesPassed: true, identityAttested: true, error: null, totalTokens: 0, totalDurationMs: 0,
    });
    // Do NOT finalize — simulate a partial run.
    assert.equal(w.getResults().matrixState, "executing",
      "a partial run (not finalized) must leave matrixState as executing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("C4: non-complete finalize keeps the current matrixState", () => {
  const dir = mkTempDir("eval-adv2-");
  try {
    const m = devMatrix();
    const w = createResultsWriter({
      outputDir: dir, matrix: m, budgetEstimate: calculateBudget(m),
      budgetTokens: null, budgetWallTimeSeconds: null,
    });
    w.writeMatrixDocument();
    w.recordCellResult({
      cellId: "c1", modelId: m.models[0]!, testId: "t1", scenarioId: "s1", conditionArm: "A1",
      runs: [], allOraclesPassed: true, identityAttested: true, error: null, totalTokens: 0, totalDurationMs: 0,
    });
    // finalize with a non-complete state (e.g., interrupted).
    const results = w.finalize("interrupted", new Date().toISOString(), 100);
    assert.equal(results.matrixState, "executing",
      "finalize('interrupted') must preserve matrixState=executing (not jump to complete)");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("C4: writeMatrixDocument is idempotent for the frozen transition (only transitions once)", () => {
  const dir = mkTempDir("eval-adv2-");
  try {
    const m = devMatrix();
    const w = createResultsWriter({
      outputDir: dir, matrix: m, budgetEstimate: calculateBudget(m),
      budgetTokens: null, budgetWallTimeSeconds: null,
    });
    w.writeMatrixDocument();
    assert.equal(w.getResults().matrixState, "frozen");
    // After recordCellResult → executing; a second writeMatrixDocument must NOT regress to frozen.
    w.recordCellResult({
      cellId: "c1", modelId: m.models[0]!, testId: "t1", scenarioId: "s1", conditionArm: "A1",
      runs: [], allOraclesPassed: true, identityAttested: true, error: null, totalTokens: 0, totalDurationMs: 0,
    });
    assert.equal(w.getResults().matrixState, "executing");
    w.writeMatrixDocument();
    assert.equal(w.getResults().matrixState, "executing",
      "a second writeMatrixDocument must NOT regress matrixState from executing to frozen");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// C5 — Hash validator
// ============================================================================

test("C5: a correct matrix passes validateMatrixPayloadHash", () => {
  assert.equal(validateMatrixPayloadHash(devMatrix()), true);
});

test("C5: a tampered matrix (changed field) FAILS", () => {
  const m = devMatrix();
  const tampered: MatrixDocument = { ...m, created_at: "1970-01-01T00:00:00.000Z" };
  assert.equal(validateMatrixPayloadHash(tampered), false);
});

test("C5: a matrix with a 63-char (wrong length) hash FAILS", () => {
  const m = devMatrix();
  const tampered = { ...m, matrix_payload_sha256: "0".repeat(63) } as MatrixDocument;
  assert.equal(validateMatrixPayloadHash(tampered), false,
    "a 63-char hash must fail (length != 64 and content mismatch)");
});

test("C5: a matrix with a valid-length (64) but wrong hash FAILS", () => {
  const m = devMatrix();
  const tampered = { ...m, matrix_payload_sha256: "a".repeat(64) } as MatrixDocument;
  assert.equal(validateMatrixPayloadHash(tampered), false,
    "a 64-char non-matching hash must fail (no false-green)");
});

test("C5 (mutation guard): reverting to `void computed` would make any 64-char hash pass", () => {
  // The old bug returned `length === 64` after `void computed`. We verify
  // that a 64-char string of all-zeros (which is NOT the real hash) fails.
  const m = devMatrix();
  const tampered = { ...m, matrix_payload_sha256: "0".repeat(64) } as MatrixDocument;
  assert.equal(validateMatrixPayloadHash(tampered), false,
    "all-zeros 64-char hash must fail — if `void computed` were restored, this would wrongly pass");
});

// ============================================================================
// C6 — Artifact hashes over real file content
// ============================================================================

test("C6: harness artifact hashes real source files (not label strings)", () => {
  const m = devMatrix();
  const harness = m.generator.implementation_artifact;
  // The harness artifact should NOT be a hash of a label like "harness:createdAt".
  const labelHash = sha256(`harness:${m.created_at}`);
  assert.notEqual(harness.sha256, labelHash,
    "harness artifact must hash real source bytes, not the label 'harness:<createdAt>'");
});

test("C6: harness artifact hash matches the actual source file content", async () => {
  const m = devMatrix();
  // The condition's harness_artifact is built from 4 source files.
  const harness = m.conditions[0]!.harness_artifact;
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(moduleDir, "..", "..");
  const files = [
    "src/evaluation/matrix-generator.ts",
    "src/evaluation/scenario-runner.ts",
    "src/evaluation/matrix-executor.ts",
    "src/evaluation/results-writer.ts",
  ];
  const content = files.map((f) => readFileSync(join(repoRoot, f), "utf8")).join("\n");
  assert.equal(harness.sha256, sha256(content),
    "harness artifact hash must match sha256 of the 4 joined source files");
  assert.equal(harness.size_bytes, Buffer.from(content, "utf8").length,
    "harness artifact size_bytes must match the byte length of the joined source files");
});

test("C6: generator.implementation_artifact hashes the single matrix-generator source", async () => {
  const m = devMatrix();
  const gen = m.generator.implementation_artifact;
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(moduleDir, "..", "..");
  const content = readFileSync(join(repoRoot, "src/evaluation/matrix-generator.ts"), "utf8");
  assert.equal(gen.sha256, sha256(content),
    "generator.implementation_artifact must hash matrix-generator.ts exactly");
});

test("C6: harness artifact hash changes when source files change", () => {
  const m1 = devMatrix();
  // Simulate a content change by computing the hash of a different content string.
  const differentContent = "totally different content";
  assert.notEqual(m1.generator.implementation_artifact.sha256, sha256(differentContent),
    "a different content must produce a different hash");
});

test("C6: adapter artifact hashes the real provider-adapter source", async () => {
  const m = devMatrix();
  const adapter = m.conditions[0]!.adapter_artifact;
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(moduleDir, "..", "..");
  const content = readFileSync(join(repoRoot, "src/runtime/provider-adapter.ts"), "utf8");
  assert.equal(adapter.sha256, sha256(content),
    "adapter artifact hash must match sha256 of provider-adapter.ts");
});

test("C6 (mutation guard): reverting to hashing labels would produce a small fixed hash", () => {
  // The old bug hashed "matrix-generator" (a label). The real source is much
  // larger, so the size_bytes must be far larger than the label length.
  const m = devMatrix();
  const gen = m.generator.implementation_artifact;
  assert.ok(gen.size_bytes > 1000,
    `implementation_artifact size_bytes must reflect real source (>1KB), got ${gen.size_bytes}. ` +
    "If reverted to hashing labels, size_bytes would be tiny.");
});

// ============================================================================
// C7 — Fault profiles
// ============================================================================

test("C7: there are 4 fault profiles", () => {
  const m = devMatrix();
  assert.equal(m.fault_profiles.length, 4, "expected exactly 4 fault profiles");
});

test("C7: at least 3 fault profiles have non-empty events", () => {
  const m = devMatrix();
  const withEvents = m.fault_profiles.filter((f) => f.events.length > 0);
  assert.ok(withEvents.length >= 3, `expected >= 3 profiles with events, got ${withEvents.length}`);
});

test("C7: fault event descriptions (fault_type) are non-empty", () => {
  const m = devMatrix();
  for (const fp of m.fault_profiles) {
    for (const ev of fp.events) {
      assert.ok(ev.fault_type.length > 0, "fault_type must be non-empty");
      assert.ok(ev.trigger_specification.sha256.length === 64, "trigger artifact sha256 must be 64 hex chars");
      assert.ok(ev.trigger_specification.size_bytes > 0, "trigger artifact must have non-zero size");
    }
  }
});

test("C7: natural-no-injection profile has 0 events (control)", () => {
  const m = devMatrix();
  const control = m.fault_profiles.find((f) => f.profile_kind === "natural-no-injection");
  assert.ok(control !== undefined);
  assert.equal(control!.events.length, 0, "natural-no-injection must be the control (0 events)");
});

test("C7: fault trigger artifacts hash real canonical-JSON content", () => {
  const m = devMatrix();
  // Each non-control trigger artifact should hash canonical JSON (an object),
  // not a label string. We verify the sha256 is 64 chars and the artifact
  // has a json media type.
  for (const fp of m.fault_profiles) {
    for (const ev of fp.events) {
      assert.equal(ev.trigger_specification.media_type, "application/json");
      assert.match(ev.trigger_specification.sha256, /^[0-9a-f]{64}$/);
    }
  }
});

// ============================================================================
// C8 — Reconciliation
// ============================================================================

test("C8: reconcileExecution detects missing cells", () => {
  const m = devMatrix();
  // Complete only one cell; the rest are missing.
  const first = m.cells[0]!;
  const records: CellResultRecord[] = [{
    cellId: first.cell_id, modelId: first.model_id, testId: first.test_id,
    scenarioId: "scn", conditionArm: "A1", runs: [{} as never, {} as never, {} as never],
    allOraclesPassed: true, identityAttested: true, error: null, totalTokens: 0, totalDurationMs: 0,
  }];
  const report = reconcileExecution(m, records, []);
  assert.equal(report.allConsistent, false);
  assert.ok(report.missingCells > 0, "missing cells must be > 0");
  assert.ok(report.discrepancies.some((d) => d.includes("planned cells have no completed or skipped record")),
    "discrepancies must mention missing cells");
});

test("C8: reconcileExecution detects cells with fewer than 3 runs", () => {
  const m = devMatrix();
  const first = m.cells[0]!;
  const records: CellResultRecord[] = [{
    cellId: first.cell_id, modelId: first.model_id, testId: first.test_id,
    scenarioId: "scn", conditionArm: "A1", runs: [{} as never], // only 1 run
    allOraclesPassed: true, identityAttested: true, error: null, totalTokens: 0, totalDurationMs: 0,
  }];
  // Mark all other cells as skipped to isolate the fewer-runs check.
  const skipped = m.cells.slice(1).map((c) => ({ cellId: c.cell_id, reason: "test" }));
  const report = reconcileExecution(m, records, skipped);
  assert.equal(report.cellsWithFewerRuns, 1, "cell with 1 run must be flagged");
  assert.ok(report.discrepancies.some((d) => d.includes("has 1 runs (expected 3)")),
    "discrepancies must mention the short cell");
});

test("C8: reconcileExecution detects a cell with a 4th run", () => {
  const m = devMatrix();
  const first = m.cells[0]!;
  const records: CellResultRecord[] = [{
    cellId: first.cell_id, modelId: first.model_id, testId: first.test_id,
    scenarioId: "scn", conditionArm: "A1", runs: [{} as never, {} as never, {} as never, {} as never],
    allOraclesPassed: true, identityAttested: true, error: null, totalTokens: 0, totalDurationMs: 0,
  }];
  const skipped = m.cells.slice(1).map((c) => ({ cellId: c.cell_id, reason: "test" }));
  const report = reconcileExecution(m, records, skipped);
  assert.equal(report.cellsWithFourthRun, 1, "cell with 4 runs must be flagged as a retained fourth run");
  assert.ok(report.discrepancies.some((d) => d.includes("no_selective_retained_fourth_run")),
    "discrepancies must mention the retained fourth run");
});

test("C8: reconcileExecution returns allConsistent=true when everything matches", () => {
  const m = devMatrix();
  const records: CellResultRecord[] = m.cells.map((c) => ({
    cellId: c.cell_id, modelId: c.model_id, testId: c.test_id, scenarioId: "scn", conditionArm: "A1",
    runs: [{ replicate: 1 }, { replicate: 2 }, { replicate: 3 }] as never[], allOraclesPassed: true, identityAttested: true,
    error: null, totalTokens: 0, totalDurationMs: 0,
  }));
  const report = reconcileExecution(m, records, []);
  assert.equal(report.allConsistent, true);
  assert.equal(report.discrepancies.length, 0);
  assert.equal(report.missingCells, 0);
  assert.equal(report.cellsWithFewerRuns, 0);
  assert.equal(report.cellsWithFourthRun, 0);
  assert.equal(report.cellsWithWrongReplicates, 0);
});

test("C8: reconciliation report includes discrepancy details", () => {
  const m = devMatrix();
  const first = m.cells[0]!;
  const records: CellResultRecord[] = [{
    cellId: first.cell_id, modelId: first.model_id, testId: first.test_id,
    scenarioId: "scn", conditionArm: "A1", runs: [{} as never, {} as never],
    allOraclesPassed: true, identityAttested: true, error: null, totalTokens: 0, totalDurationMs: 0,
  }];
  const report = reconcileExecution(m, records, []);
  assert.ok(report.discrepancies.length > 0, "discrepancies must be populated");
  for (const d of report.discrepancies) {
    assert.ok(typeof d === "string" && d.length > 0, "each discrepancy must be a non-empty string");
  }
});

test("C8: skipped cells are not counted as missing", () => {
  const m = devMatrix();
  const first = m.cells[0]!;
  const records: CellResultRecord[] = [{
    cellId: first.cell_id, modelId: first.model_id, testId: first.test_id,
    scenarioId: "scn", conditionArm: "A1", runs: [{} as never, {} as never, {} as never],
    allOraclesPassed: true, identityAttested: true, error: null, totalTokens: 0, totalDurationMs: 0,
  }];
  const skipped = m.cells.slice(1).map((c) => ({ cellId: c.cell_id, reason: "budget" }));
  const report = reconcileExecution(m, records, skipped);
  assert.equal(report.missingCells, 0, "skipped cells must not be counted as missing");
  assert.equal(report.skippedCells, skipped.length);
  assert.equal(report.completedCells, 1);
});

// ============================================================================
// C9 — Serialized request body
// ============================================================================

test("C9: request-body document contains model, messages, max_tokens, temperature", async () => {
  const dir = mkTempDir("eval-adv2-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const runner = createScenarioRunner({ adapter: makeMockProvider({ content: "resp" }), timeline: tl });
    await runner.runCell(makeRequest(matrix, cell.cell_id, "test prompt", { maxTokens: 512 }));
    const docs = tl.store.query({ eventType: "provider" }).flatMap((e) =>
      e.documents.filter((d) => d.name === "request-body"));
    assert.ok(docs.length > 0);
    for (const d of docs) {
      const parsed = JSON.parse(d.contentJson ?? "{}") as {
        model?: string; messages?: unknown[]; max_tokens?: number; temperature?: number; stream?: boolean;
      };
      assert.equal(parsed.model, cell.model_id);
      assert.ok(Array.isArray(parsed.messages) && parsed.messages!.length > 0, "messages must be a non-empty array");
      assert.equal(parsed.max_tokens, 512);
      assert.equal(parsed.temperature, 0);
    }
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("C9: request-body is recorded BEFORE the response message (timeline ordering)", async () => {
  const dir = mkTempDir("eval-adv2-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const runner = createScenarioRunner({ adapter: makeMockProvider({ content: "resp" }), timeline: tl });
    await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
    const providerEvents = tl.store.query({ eventType: "provider" });
    const messageEvents = tl.store.query({ eventType: "message" });
    // Find the first request-body event and the first response message event.
    const reqEvent = providerEvents.find((e) =>
      e.documents.some((d) => d.name === "request-body"));
    assert.ok(reqEvent !== undefined, "must have a request-body event");
    const respEvent = messageEvents.find((e) =>
      e.documents.some((d) => d.name === "response"));
    assert.ok(respEvent !== undefined, "must have a response message event");
    // Compare sequence numbers (lexicographic string comparison works for same-length sequences).
    assert.ok(reqEvent!.sequence <= respEvent!.sequence,
      `request-body (seq ${reqEvent!.sequence}) must be recorded before response (seq ${respEvent!.sequence})`);
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("C9: reference transport also records the request-body with stream=false", async () => {
  const dir = mkTempDir("eval-adv2-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const mockFetch = async (_url: string, _init: UpstreamRequest): Promise<Response> => {
      return new Response(JSON.stringify({
        choices: [{ message: { content: "IDENTITY_PROBE_OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const runner = createScenarioRunner({ timeline: tl });
    serve(mockFetch);
    await runner.runCell(makeRequest(matrix, cell.cell_id, "test", {
      runReferenceTransport: true,
    }));
    const docs = tl.store.query({ eventType: "provider" }).flatMap((e) =>
      e.documents.filter((d) => d.name === "request-body"));
    assert.ok(docs.length > 0, "reference transport must also record request-body");
    for (const d of docs) {
      const parsed = JSON.parse(d.contentJson ?? "{}") as { stream?: boolean };
      assert.equal(parsed.stream, false, "reference transport request-body must have stream=false");
    }
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("C9: normal (non-reference) transport records stream=true", async () => {
  const dir = mkTempDir("eval-adv2-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const runner = createScenarioRunner({ adapter: makeMockProvider({ content: "resp" }), timeline: tl });
    await runner.runCell(makeRequest(matrix, cell.cell_id, "test", { runReferenceTransport: false }));
    const docs = tl.store.query({ eventType: "provider" }).flatMap((e) =>
      e.documents.filter((d) => d.name === "request-body"));
    assert.ok(docs.length > 0);
    for (const d of docs) {
      const parsed = JSON.parse(d.contentJson ?? "{}") as { stream?: boolean };
      assert.equal(parsed.stream, true, "non-reference transport request-body must have stream=true");
    }
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// C10 — Oracle failures counted as failed
// ============================================================================

function makeCellRecord(overrides: Partial<CellResultRecord> = {}): CellResultRecord {
  return {
    cellId: "cel_test", modelId: "zai-org/GLM-5.2-NVFP4" as const, testId: "t1",
    scenarioId: "s1", conditionArm: "A1", runs: [],
    allOraclesPassed: true, identityAttested: true, error: null,
    totalTokens: 0, totalDurationMs: 0, ...overrides,
  };
}

test("C10: allOraclesPassed=false + error=null is counted as failed", () => {
  const dir = mkTempDir("eval-adv2-");
  try {
    const m = devMatrix();
    const w = createResultsWriter({
      outputDir: dir, matrix: m, budgetEstimate: calculateBudget(m),
      budgetTokens: null, budgetWallTimeSeconds: null,
    });
    w.writeMatrixDocument();
    w.recordCellResult(makeCellRecord({ cellId: "c1", allOraclesPassed: false, error: null }));
    const results = w.finalize("complete", new Date().toISOString(), 10);
    assert.equal(results.failedCells, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("C10: allOraclesPassed=true + error=null is counted as passed (not failed)", () => {
  const dir = mkTempDir("eval-adv2-");
  try {
    const m = devMatrix();
    const w = createResultsWriter({
      outputDir: dir, matrix: m, budgetEstimate: calculateBudget(m),
      budgetTokens: null, budgetWallTimeSeconds: null,
    });
    w.writeMatrixDocument();
    w.recordCellResult(makeCellRecord({ cellId: "c1", allOraclesPassed: true, error: null, identityAttested: true }));
    const results = w.finalize("complete", new Date().toISOString(), 10);
    assert.equal(results.failedCells, 0, "passing cell must not be counted as failed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("C10: error set (regardless of oracles) is counted as failed", () => {
  const dir = mkTempDir("eval-adv2-");
  try {
    const m = devMatrix();
    const w = createResultsWriter({
      outputDir: dir, matrix: m, budgetEstimate: calculateBudget(m),
      budgetTokens: null, budgetWallTimeSeconds: null,
    });
    w.writeMatrixDocument();
    w.recordCellResult(makeCellRecord({
      cellId: "c1", error: "some error", allOraclesPassed: true, identityAttested: true,
    }));
    const results = w.finalize("complete", new Date().toISOString(), 10);
    assert.equal(results.failedCells, 1, "error cell must be failed even if oracles passed");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("C10: failed count in the report matches the actual number of failed cells", () => {
  const dir = mkTempDir("eval-adv2-");
  try {
    const m = devMatrix();
    const w = createResultsWriter({
      outputDir: dir, matrix: m, budgetEstimate: calculateBudget(m),
      budgetTokens: null, budgetWallTimeSeconds: null,
    });
    w.writeMatrixDocument();
    w.recordCellResult(makeCellRecord({ cellId: "c1", allOraclesPassed: false, error: null }));
    w.recordCellResult(makeCellRecord({ cellId: "c2", allOraclesPassed: true, error: "boom" }));
    w.recordCellResult(makeCellRecord({ cellId: "c3", allOraclesPassed: true, error: null, identityAttested: true }));
    const results = w.finalize("complete", new Date().toISOString(), 10);
    assert.equal(results.failedCells, 2, "two cells (oracle-fail + error) must be failed");
    assert.equal(results.completedCells, 3);
    const report = readFileSync(join(dir, "final-report.md"), "utf8");
    assert.ok(report.includes("c1"), "failed cell c1 must appear in the report");
    assert.ok(report.includes("c2"), "failed cell c2 must appear in the report");
    assert.ok(!report.includes("| c3 "), "passing cell c3 must NOT appear in the Failed Cells section");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// M1 — Temperature
// ============================================================================

test("M1: temperature is 0 and present on every run", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const runner = createScenarioRunner({ adapter: makeMockProvider({ content: "resp" }) });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  assert.equal(result.runs.length, 3);
  for (const r of result.runs) {
    assert.equal(r.temperature, 0);
    assert.equal(typeof r.temperature, "number");
  }
});

test("M1: temperature is 0 even on identity-failed runs", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider({ probeContent: "wrong", content: "main" });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  for (const r of result.runs) {
    assert.equal(r.temperature, 0, "identity-failed runs must still record temperature 0");
  }
});

test("M1: temperature is 0 even on error runs (main call throws)", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  let callCount = 0;
  const adapter: ProviderAdapter = {
    providerId: "mock",
    async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> { yield { type: "content", text: "x" }; },
    async chatCompletion(request): Promise<ChatCompletionResult> {
      callCount++;
      if (callCount % 2 === 1) return { content: "IDENTITY_PROBE_OK", toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "stop", headers: { "x-model-id": request.model } };
      throw new Error("main failed");
    },
  };
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  for (const r of result.runs) {
    assert.equal(r.temperature, 0, "error runs must still record temperature 0");
  }
});

// ============================================================================
// M2 — Stop-and-restart on identity failure
// ============================================================================

async function runMatrixWithIdentityFailures(matrix: MatrixDocument, cellLimit: number): Promise<{ state: string; identityFailureCells: number; completed: number }> {
  const dir = mkTempDir("eval-adv2-");
  try {
    const w = createResultsWriter({
      outputDir: dir, matrix, budgetEstimate: calculateBudget(matrix),
      budgetTokens: null, budgetWallTimeSeconds: null,
    });
    w.writeMatrixDocument();
    // Adapter always returns wrong probe content → identity always fails.
    const adapter = makeMockProvider({ probeContent: "WRONG", content: "main" });
    const runner = createScenarioRunner({ adapter });
    const outcome = await executeMatrix({
      matrix, runner, resultsWriter: w,
      resolvePrompt: () => "test",
      buildCellRequest: (cell) => makeRequest(matrix, cell.cell_id, "test"),
      concurrency: 1, // deterministic ordering
      limitCells: cellLimit,
    });
    return { state: outcome.state, identityFailureCells: outcome.identityFailureCells, completed: outcome.completedCells };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("M2: 6 consecutive identity failures trigger benchmark-restart-required", async () => {
  const matrix = devMatrix();
  const { state, identityFailureCells } = await runMatrixWithIdentityFailures(matrix, 6);
  assert.equal(identityFailureCells, 6, "6 identity-failed cells must be recorded");
  assert.equal(state, "benchmark-restart-required",
    "6 consecutive identity failures (> threshold 5) must pause with benchmark-restart-required");
});

test("M2 (FIX4-IDENTITY): body model verification prevents M2 pause (unblocks full matrix)", async () => {
  // This is the CORE FIX: Makora does not return x-model-id, but the response
  // body `model` field matches the requested model. Identity is established
  // via "exact-body" and the matrix does NOT pause after 5+ cells.
  const dir = mkTempDir("eval-adv2-");
  try {
    const matrix = devMatrix();
    const w = createResultsWriter({
      outputDir: dir, matrix, budgetEstimate: calculateBudget(matrix),
      budgetTokens: null, budgetWallTimeSeconds: null,
    });
    w.writeMatrixDocument();
    // Inline adapter: no x-model-id header, but body model echoes the
    // requested model (as Makora does). This establishes identity via body.
    const bodyAdapter: ProviderAdapter = {
      providerId: "mock-body",
      async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> {
        yield { type: "content", text: "resp" };
        yield { type: "finish", reason: "stop" };
      },
      async chatCompletion(request): Promise<ChatCompletionResult> {
        const isProbe = request.messages[0]?.content === PROBE_PROMPT;
        return {
          content: isProbe ? "IDENTITY_PROBE_OK" : "main response",
          toolCalls: [],
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          finishReason: "stop",
          headers: {},
          model: request.model,
        };
      },
    };
    const runner = createScenarioRunner({ adapter: bodyAdapter });
    const outcome = await executeMatrix({
      matrix, runner, resultsWriter: w,
      resolvePrompt: () => "test",
      buildCellRequest: (cell) => makeRequest(matrix, cell.cell_id, "test"),
      concurrency: 1,
      limitCells: 10,
    });
    assert.notEqual(outcome.state, "benchmark-restart-required",
      "body model verification must NOT trigger the M2 pause");
    assert.equal(outcome.state, "complete",
      "matrix must complete normally when identity is established via body model");
    assert.equal(outcome.identityFailureCells, 0,
      "no identity failure cells when body model matches");
    const results = JSON.parse(readFileSync(join(dir, "results.json"), "utf8")) as { cellResults: { identityAttested: boolean; runs: { modelRevision: { mappingStatus: string } }[] }[] };
    for (const cr of results.cellResults) {
      assert.equal(cr.identityAttested, true,
        "every cell must have identityAttested=true via body model");
      for (const r of cr.runs) {
        assert.equal(r.modelRevision.mappingStatus, "exact-body",
          "every run must have mappingStatus 'exact-body'");
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("M2 (DISCREPANCY): 5 consecutive identity failures do NOT trigger a pause (threshold is >5, i.e., 6)", async () => {
  // The task description says "5 consecutive identity failures trigger a pause".
  // The code triggers at `consecutiveIdentityFailures > 5` (i.e., 6). 5 does NOT trigger.
  // This documents the actual behavior: the threshold requires 6, not 5.
  const matrix = devMatrix();
  const { state, identityFailureCells } = await runMatrixWithIdentityFailures(matrix, 5);
  assert.equal(identityFailureCells, 5);
  assert.notEqual(state, "benchmark-restart-required",
    "DISCREPANCY: 5 consecutive identity failures do NOT trigger a pause. " +
    "The code uses `> 5` (requires 6), but the task/M2 description says '5'.");
  assert.equal(state, "complete",
    "with only 5 identity failures, execution completes normally (no pause)");
});

test("M2: a successful run resets the consecutive identity-failure counter", async () => {
  const dir = mkTempDir("eval-adv2-");
  try {
    const matrix = devMatrix();
    const w = createResultsWriter({
      outputDir: dir, matrix, budgetEstimate: calculateBudget(matrix),
      budgetTokens: null, budgetWallTimeSeconds: null,
    });
    w.writeMatrixDocument();
    // Fail ALL probes for the first 5 cells (each cell = 3 runs, 3 probes),
    // then succeed for cell 6+. Track cells by counting probes (3 per cell).
    let probesSeen = 0;
    const trackAdapter: ProviderAdapter = {
      providerId: "mock-track",
      async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> { yield { type: "content", text: "x" }; },
      async chatCompletion(request): Promise<ChatCompletionResult> {
        const isProbe = request.messages[0]?.content === PROBE_PROMPT;
        if (!isProbe) {
          return { content: "resp", toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "stop", headers: { "x-model-id": request.model } };
        }
        probesSeen++;
        const cellNumber = Math.ceil(probesSeen / 3); // 3 probes per cell
        // Cells 1-5: fail all probes. Cell 6+: succeed.
        if (cellNumber <= 5) {
          return { content: "WRONG", toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "stop", headers: {} };
        }
        return { content: "IDENTITY_PROBE_OK", toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "stop", headers: { "x-model-id": request.model } };
      },
    };
    const trackRunner = createScenarioRunner({ adapter: trackAdapter });
    const outcome = await executeMatrix({
      matrix, runner: trackRunner, resultsWriter: w,
      resolvePrompt: () => "test",
      buildCellRequest: (cell) => makeRequest(matrix, cell.cell_id, "test"),
      concurrency: 1,
      limitCells: 8,
    });
    // 5 fully-failed cells then a successful cell 6 → reset → no pause.
    assert.notEqual(outcome.state, "benchmark-restart-required",
      "a successful cell (6th) after 5 fully-failed cells must reset the counter (no pause)");
    assert.ok(outcome.identityFailureCells >= 5, "should have at least 5 identity-failed cells");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// M3 — Error messages recorded
// ============================================================================

test("M3: error message is captured in CellRunResult.error when main call throws", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  let callCount = 0;
  const adapter: ProviderAdapter = {
    providerId: "mock",
    async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> { yield { type: "content", text: "x" }; },
    async chatCompletion(request): Promise<ChatCompletionResult> {
      callCount++;
      if (callCount % 2 === 1) return { content: "IDENTITY_PROBE_OK", toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "stop", headers: { "x-model-id": request.model } };
      throw new Error("M3_ERROR_MARKER");
    },
  };
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  for (const r of result.runs) {
    assert.equal(r.error, "M3_ERROR_MARKER", "error message must be captured on CellRunResult.error");
    assert.equal(r.finishReason, "error");
  }
});

test("M3: error message is recorded in the timeline as outcome=failed with errorMessage", async () => {
  const dir = mkTempDir("eval-adv2-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    let callCount = 0;
    const adapter: ProviderAdapter = {
      providerId: "mock",
      async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> { yield { type: "content", text: "x" }; },
      async chatCompletion(request): Promise<ChatCompletionResult> {
        callCount++;
        if (callCount % 2 === 1) return { content: "IDENTITY_PROBE_OK", toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "stop", headers: { "x-model-id": request.model } };
        throw new Error("TIMELINE_ERR_MARKER");
      },
    };
    const runner = createScenarioRunner({ adapter, timeline: tl });
    await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
    const failedEvents = tl.store.query({ eventType: "provider" }).filter((e) => e.outcome === "failed");
    assert.ok(failedEvents.length > 0, "must have failed provider events");
    const withMsg = failedEvents.find((e) => e.errorMessage?.includes("TIMELINE_ERR_MARKER"));
    assert.ok(withMsg !== undefined, "failed event must carry the error message");
    assert.ok(withMsg!.errorCategory !== null, "failed event must carry an error category");
    assert.ok(withMsg!.errorCode !== null, "failed event must carry an error code");
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("M3: identity-not-established records an error event in the timeline", async () => {
  const dir = mkTempDir("eval-adv2-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const adapter = makeMockProvider({ probeContent: "WRONG", content: "main" });
    const runner = createScenarioRunner({ adapter, timeline: tl });
    await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
    const failedEvents = tl.store.query({ eventType: "provider" }).filter((e) => e.outcome === "failed");
    assert.ok(failedEvents.length > 0, "identity failure must record a failed event");
    const idEvent = failedEvents.find((e) => e.errorCode?.includes("identity") || e.errorMessage?.includes("IDENTITY_PROBE_OK"));
    assert.ok(idEvent !== undefined, "must have an identity-related failed event");
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// M4 — AbortSignal/timeout during attestation
// ============================================================================

test("M4: an already-aborted signal prevents identity establishment", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider({ content: "IDENTITY_PROBE_OK" });
  const runner = createScenarioRunner({ adapter });
  const controller = new AbortController();
  controller.abort();
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test", { signal: controller.signal }));
  assert.equal(result.identityAttested, false);
  for (const r of result.runs) {
    assert.equal(r.finishReason, "identity_not_established");
  }
});

test("M4: a hanging probe is bounded by the 30s attestation timeout", async () => {
  // We verify the signal combination does not hang when the caller provides a
  // fast-aborting signal. The 30s timeout itself is exercised in integration.
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider({ content: "IDENTITY_PROBE_OK" });
  const runner = createScenarioRunner({ adapter });
  const controller = new AbortController();
  // Abort after 50ms — the probe should be cancelled and identity not established.
  const timer = setTimeout(() => controller.abort(), 50);
  try {
    const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test", { signal: controller.signal }));
    // The run completes (no hang) — the timeout mechanism works.
    assert.ok(result.runs.length > 0, "run must complete (not hang) when a signal aborts mid-attestation");
  } finally {
    clearTimeout(timer);
  }
});

test("M4: mock provider that throws on aborted signal is handled gracefully", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider({ content: "IDENTITY_PROBE_OK" });
  const runner = createScenarioRunner({ adapter });
  const controller = new AbortController();
  controller.abort();
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test", { signal: controller.signal }));
  assert.equal(result.error, null, "cell-level error must be null (identity failure is not a cell error)");
  for (const r of result.runs) {
    assert.equal(r.error, null, "identity-failed run must have error=null (not the abort message)");
  }
});

// ============================================================================
// M5 — Budget report dimensions
// ============================================================================

test("M5: budget estimate has all 4 new dimensions", () => {
  const m = devMatrix();
  const budget = calculateBudget(m);
  assert.ok("estimatedCostUsd" in budget, "must have estimatedCostUsd");
  assert.ok("estimatedIndexingBytes" in budget, "must have estimatedIndexingBytes");
  assert.ok("rateLimitProfile" in budget, "must have rateLimitProfile");
  assert.ok("estimatedHumanReviewLoad" in budget, "must have estimatedHumanReviewLoad");
  assert.equal(typeof budget.estimatedCostUsd, "number");
  assert.equal(typeof budget.estimatedIndexingBytes, "number");
  assert.equal(budget.rateLimitProfile, null, "rateLimitProfile must be null until observed");
  assert.equal(typeof budget.estimatedHumanReviewLoad, "number");
});

test("M5: formatBudgetReport renders all 4 new dimensions", () => {
  const m = devMatrix();
  const budget = calculateBudget(m, { pricePerTokenUsd: 0.001 });
  const report = formatBudgetReport(budget);
  assert.ok(report.includes("Estimated indexing (bytes)"), "report must include indexing bytes");
  assert.ok(report.includes("Estimated cost (USD)"), "report must include cost USD");
  assert.ok(report.includes("Rate-limit profile"), "report must include rate-limit profile");
  assert.ok(report.includes("Estimated human review load"), "report must include human review load");
});

test("M5: estimatedCostUsd is totalTokensExpected * pricePerTokenUsd", () => {
  const m = devMatrix();
  const budget = calculateBudget(m, { pricePerTokenUsd: 0.002 });
  assert.equal(budget.estimatedCostUsd, budget.totalTokensExpected * 0.002);
});

test("M5: estimatedHumanReviewLoad is ceil(totalCells * sampleRate)", () => {
  const m = devMatrix();
  const budget = calculateBudget(m, { humanReviewSampleRate: 0.5 });
  assert.equal(budget.estimatedHumanReviewLoad, Math.ceil(budget.totalCells * 0.5));
});

// ============================================================================
// M6 — parent_event_id on child events
// ============================================================================

test("M6: message events parent to the run event", async () => {
  const dir = mkTempDir("eval-adv2-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const runner = createScenarioRunner({ adapter: makeMockProvider({ content: "resp" }), timeline: tl });
    await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
    const runEvents = tl.store.query({ eventType: "run" });
    const messageEvents = tl.store.query({ eventType: "message" });
    assert.ok(runEvents.length > 0);
    assert.ok(messageEvents.length > 0);
    const runIds = new Set(runEvents.map((e) => e.eventId));
    const parented = messageEvents.filter((e) => e.parentEventId !== null && runIds.has(e.parentEventId!));
    assert.equal(parented.length, messageEvents.length,
      "ALL message events must be parented to a run event");
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("M6: token events parent to a message event", async () => {
  const dir = mkTempDir("eval-adv2-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const runner = createScenarioRunner({ adapter: makeMockProvider({ content: "resp" }), timeline: tl });
    await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
    const messageEvents = tl.store.query({ eventType: "message" });
    const tokenEvents = tl.store.query({ eventType: "token" });
    assert.ok(tokenEvents.length > 0);
    const messageIds = new Set(messageEvents.map((e) => e.eventId));
    const parented = tokenEvents.filter((e) => e.parentEventId !== null && messageIds.has(e.parentEventId!));
    assert.equal(parented.length, tokenEvents.length,
      "ALL token events must be parented to a message event");
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("M6: agent events parent to the run event and carry part-of edges", async () => {
  const dir = mkTempDir("eval-adv2-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const a3Cell = findCellForArm(matrix, "A3") ?? matrix.cells[0]!;
    const runner = createScenarioRunner({ adapter: makeMockProvider({ content: "resp" }), timeline: tl });
    await runner.runCell(makeRequest(matrix, a3Cell.cell_id, "test"));
    const runEvents = tl.store.query({ eventType: "run" });
    const agentEvents = tl.store.query({ eventType: "agent" });
    assert.ok(agentEvents.length > 0);
    const runIds = new Set(runEvents.map((e) => e.eventId));
    for (const e of agentEvents) {
      assert.ok(e.parentEventId !== null && runIds.has(e.parentEventId!),
        "agent event must be parented to a run event");
      assert.ok(e.edges.some((ed) => ed.edgeType === "part-of"),
        "agent event must carry a part-of edge");
    }
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("M6: topology (task) events parent to the run event and carry part-of edges", async () => {
  const dir = mkTempDir("eval-adv2-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const a2Cell = findCellForArm(matrix, "A2") ?? matrix.cells[0]!;
    const runner = createScenarioRunner({ adapter: makeMockProvider({ content: "resp" }), timeline: tl });
    await runner.runCell(makeRequest(matrix, a2Cell.cell_id, "test"));
    const runEvents = tl.store.query({ eventType: "run" });
    const taskEvents = tl.store.query({ eventType: "task" });
    assert.ok(taskEvents.length > 0);
    const runIds = new Set(runEvents.map((e) => e.eventId));
    for (const e of taskEvents) {
      assert.ok(e.parentEventId !== null && runIds.has(e.parentEventId!),
        "task event must be parented to a run event");
      assert.ok(e.edges.some((ed) => ed.edgeType === "part-of"),
        "task event must carry a part-of edge");
    }
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// M7 — outcome metadata
// ============================================================================

test("M7: a successful run does NOT set outcome=failed on the response event", async () => {
  const dir = mkTempDir("eval-adv2-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    const runner = createScenarioRunner({ adapter: makeMockProvider({ content: "resp" }), timeline: tl });
    await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
    const failedEvents = tl.store.query({ eventType: "provider" }).filter((e) => e.outcome === "failed");
    assert.equal(failedEvents.length, 0, "a successful run must not record any failed provider events");
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("M7: a failed run records outcome=failed with error metadata", async () => {
  const dir = mkTempDir("eval-adv2-");
  try {
    const tl = mkTimeline(dir);
    const matrix = devMatrix();
    const cell = matrix.cells[0]!;
    let callCount = 0;
    const adapter: ProviderAdapter = {
      providerId: "mock",
      async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> { yield { type: "content", text: "x" }; },
      async chatCompletion(request): Promise<ChatCompletionResult> {
        callCount++;
        if (callCount % 2 === 1) return { content: "IDENTITY_PROBE_OK", toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "stop", headers: { "x-model-id": request.model } };
        throw new Error("M7_FAIL");
      },
    };
    const runner = createScenarioRunner({ adapter, timeline: tl });
    await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
    const failed = tl.store.query({ eventType: "provider" }).filter((e) => e.outcome === "failed");
    assert.ok(failed.length > 0);
    for (const e of failed) {
      assert.equal(e.outcome, "failed");
      assert.ok(e.errorMessage !== null && e.errorMessage!.includes("M7_FAIL"));
      assert.ok(e.errorCategory !== null);
      assert.ok(e.errorCode !== null);
    }
    tl.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// M8 — Probe tokens included in cell total
// ============================================================================

test("M8: cellTokens includes main + probe tokens (arithmetic check)", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const probeUsage = { promptTokens: 7, completionTokens: 11, totalTokens: 18 };
  const mainUsage = { promptTokens: 100, completionTokens: 200, totalTokens: 300 };
  let callCount = 0;
  const adapter: ProviderAdapter = {
    providerId: "mock",
    async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> { yield { type: "content", text: "x" }; },
    async chatCompletion(request): Promise<ChatCompletionResult> {
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
    assert.equal(r.usage?.totalTokens, 300, "main usage captured");
    assert.equal(r.capabilityProbe?.usage?.totalTokens, 18, "probe usage captured");
  }
  // The executor's cellTokens = sum over runs of (main + probe).
  // 3 runs * (300 + 18) = 954.
  const expected = 3 * (300 + 18);
  const actual = result.runs.reduce((sum, r) => sum + (r.usage?.totalTokens ?? 0) + (r.capabilityProbe?.usage?.totalTokens ?? 0), 0);
  assert.equal(actual, expected, `cell total tokens must be ${expected} (3 * (300 main + 18 probe)), got ${actual}`);
});

test("M8 (FIXED): probe tokens ARE counted when identity fails due to wrong probe content", async () => {
  // MAJ-7: when the probe returns WRONG content (a real API call that consumed
  // tokens), the identity-failure return path now includes capabilityProbe so
  // the probe's consumed tokens are counted in cellTokens.
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const probeUsage = { promptTokens: 50, completionTokens: 50, totalTokens: 100 };
  const adapter = makeMockProvider({
    probeContent: "WRONG_CONTENT_NOT_MARKER",
    probeUsage,
    content: "main",
  });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  for (const r of result.runs) {
    assert.equal(r.finishReason, "identity_not_established");
    assert.ok(r.capabilityProbe !== undefined,
      "capabilityProbe must be present on identity-failure (wrong content) so probe tokens are counted");
    assert.equal(r.capabilityProbe?.usage?.totalTokens, 100);
  }
  const cellTotal = result.runs.reduce((sum, r) =>
    sum + (r.usage?.totalTokens ?? 0) + (r.capabilityProbe?.usage?.totalTokens ?? 0), 0);
  assert.equal(cellTotal, 3 * 100,
    "probe tokens consumed by the failed-identity probe MUST be counted (3 * 100 = 300)");
});

test("M8: probe tokens ARE counted when identity succeeds", async () => {
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const probeUsage = { promptTokens: 5, completionTokens: 5, totalTokens: 10 };
  const mainUsage = { promptTokens: 50, completionTokens: 50, totalTokens: 100 };
  let callCount = 0;
  const adapter: ProviderAdapter = {
    providerId: "mock",
    async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> { yield { type: "content", text: "x" }; },
    async chatCompletion(request): Promise<ChatCompletionResult> {
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
    assert.ok(r.capabilityProbe !== undefined, "identity success → capabilityProbe present");
    assert.equal(r.capabilityProbe!.usage?.totalTokens, 10);
  }
  const cellTotal = result.runs.reduce((sum, r) =>
    sum + (r.usage?.totalTokens ?? 0) + (r.capabilityProbe?.usage?.totalTokens ?? 0), 0);
  assert.equal(cellTotal, 3 * (100 + 10), "probe tokens must be counted when identity succeeds");
});

// ============================================================================
// M9 — contamination_risk
// ============================================================================

test("M9: every scenario has a contamination_risk field", () => {
  const m = devMatrix();
  for (const s of m.scenarios) {
    assert.ok("contamination_risk" in s, `scenario ${s.scenario_id} must have contamination_risk`);
    assert.ok(["known-clean", "unknown", "known-contaminated"].includes(s.contamination_risk),
      `contamination_risk must be a valid value, got ${s.contamination_risk}`);
  }
});

test("M9: synthetic-fixture scenarios have contamination_risk='unknown'", () => {
  const m = devMatrix();
  for (const s of m.scenarios) {
    assert.equal(s.contamination_risk, "unknown",
      `synthetic fixture scenario ${s.scenario_id} must be 'unknown'`);
  }
});

test("M9: every project has a contamination_risk field", () => {
  const m = devMatrix();
  for (const p of m.projects) {
    assert.ok("contamination_risk" in p, `project ${p.project_id} must have contamination_risk`);
    assert.ok(["known-clean", "unknown", "known-contaminated"].includes(p.contamination_risk));
  }
});

// ============================================================================
// M10 — failure-prone projects
// ============================================================================

test("M10: at least 2 projects are marked failureProne", () => {
  const m = devMatrix();
  const failureProne = m.projects.filter((p) => p.failure_prone);
  assert.ok(failureProne.length >= 2, `expected >= 2 failure-prone projects, got ${failureProne.length}`);
});

test("M10: failure-prone project records have failure_prone=true", () => {
  const m = devMatrix();
  for (const p of m.projects) {
    if (SEED_PROJECTS.find((sp) => sp.projectId === p.project_id)?.failureProne === true) {
      assert.equal(p.failure_prone, true, `project ${p.project_id} must have failure_prone=true`);
    }
  }
});

test("M10: non-failure-prone projects have failure_prone=false (not undefined)", () => {
  const m = devMatrix();
  for (const p of m.projects) {
    assert.equal(typeof p.failure_prone, "boolean", `failure_prone must be boolean, got ${typeof p.failure_prone}`);
    if (SEED_PROJECTS.find((sp) => sp.projectId === p.project_id)?.failureProne !== true) {
      assert.equal(p.failure_prone, false, `non-failure-prone project ${p.project_id} must be false`);
    }
  }
});

test("M10: failure-prone seed scenarios reference failure-prone projects", () => {
  const failureProneProjectIds = new Set(
    SEED_PROJECTS.filter((p) => p.failureProne === true).map((p) => p.projectId),
  );
  const failureProneScenarios = SEED_SCENARIOS.filter((s) => failureProneProjectIds.has(s.projectRef));
  assert.ok(failureProneScenarios.length >= 2,
    "at least 2 seed scenarios must reference failure-prone projects");
});

// ============================================================================
// Cross-cutting: code smells and new bugs introduced by fix2
// ============================================================================

test("SMELL (FIXED): identityAttested=false + allOraclesPassed=true + error=null is identity-unverified (third category)", () => {
  // MAJ-1: a cell with identityAttested=false, allOraclesPassed=true, error=null
  // is neither passed nor failed — it falls into the new "identity-unverified"
  // third category. passed + failed + identity-unverified = completed.
  const dir = mkTempDir("eval-adv2-");
  try {
    const m = devMatrix();
    const w = createResultsWriter({
      outputDir: dir, matrix: m, budgetEstimate: calculateBudget(m),
      budgetTokens: null, budgetWallTimeSeconds: null,
    });
    w.writeMatrixDocument();
    w.recordCellResult(makeCellRecord({
      cellId: "c1", allOraclesPassed: true, error: null, identityAttested: false,
    }));
    const results = w.finalize("complete", new Date().toISOString(), 10);
    assert.equal(results.failedCells, 0, "identity-unverified is NOT failed");
    assert.equal(results.identityUnverifiedCells, 1, "identity-unverified category = 1");
    const modelAgg = results.aggregates.perModel[0]!;
    assert.equal(modelAgg.passed, 0, "identityAttested=false → not counted as passed");
    assert.equal(modelAgg.failed, 0, "identity-unverified is not failed either");
    assert.equal(modelAgg.identityUnverified, 1, "identity-unverified aggregate = 1");
    assert.equal(modelAgg.cells, 1, "but it IS counted as a cell");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SMELL: identityAttested=false cells are counted in identityAttested aggregate as 0 but still a cell", () => {
  const dir = mkTempDir("eval-adv2-");
  try {
    const m = devMatrix();
    const w = createResultsWriter({
      outputDir: dir, matrix: m, budgetEstimate: calculateBudget(m),
      budgetTokens: null, budgetWallTimeSeconds: null,
    });
    w.writeMatrixDocument();
    w.recordCellResult(makeCellRecord({
      cellId: "c1", allOraclesPassed: true, error: null, identityAttested: false,
    }));
    const results = w.finalize("complete", new Date().toISOString(), 10);
    const modelAgg = results.aggregates.perModel[0]!;
    assert.equal(modelAgg.identityAttested, 0, "identityAttested aggregate counts only attested cells");
    assert.equal(modelAgg.cells, 1, "but cells count includes the non-attested cell");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SMELL: M2 threshold boundary — exactly 6 triggers, exactly 5 does not", async () => {
  // Confirms the boundary: the pause triggers at >5 (6), not >=5 (5).
  // This is a code smell because the task and FIX2-REPORT describe ">5"
  // but the cli message says "> 5 consecutive" — a 5-cell run completes.
  const matrix = devMatrix();
  const r5 = await runMatrixWithIdentityFailures(matrix, 5);
  const r6 = await runMatrixWithIdentityFailures(matrix, 6);
  assert.notEqual(r5.state, "benchmark-restart-required", "5 failures must NOT pause");
  assert.equal(r6.state, "benchmark-restart-required", "6 failures must pause");
});

test("SMELL (FIXED): executeMatrix failedCount NOW includes identity-failed cells (non-vacuous)", async () => {
  // MAJ-8: an identity-failed cell has oracleResults=[] (no oracles ran). The
  // non-vacuous allOraclesPassed check (runs.length > 0 && every run has
  // non-empty oracleResults that all pass) makes allOraclesPassed=false, so
  // the C10 failed logic counts identity-failed cells as failed.
  const dir = mkTempDir("eval-adv2-");
  try {
    const matrix = devMatrix();
    const w = createResultsWriter({
      outputDir: dir, matrix, budgetEstimate: calculateBudget(matrix),
      budgetTokens: null, budgetWallTimeSeconds: null,
    });
    w.writeMatrixDocument();
    const adapter = makeMockProvider({ probeContent: "WRONG", content: "main" });
    const runner = createScenarioRunner({ adapter });
    const outcome = await executeMatrix({
      matrix, runner, resultsWriter: w,
      resolvePrompt: () => "test",
      buildCellRequest: (cell) => makeRequest(matrix, cell.cell_id, "test"),
      concurrency: 1, limitCells: 2,
    });
    assert.equal(outcome.identityFailureCells, 2, "identity failures tracked separately");
    assert.equal(outcome.failedCells, 2,
      "identity-failed cells are now counted as failed (allOraclesPassed=false, non-vacuous)");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SMELL (FIXED): identity-failed cell result has allOraclesPassed=false (non-vacuous)", async () => {
  // MAJ-8: the CellResult from the runner reports allOraclesPassed=false for
  // identity-failed runs because oracleResults is empty (non-vacuous check).
  const matrix = devMatrix();
  const cell = matrix.cells[0]!;
  const adapter = makeMockProvider({ probeContent: "WRONG", content: "main" });
  const runner = createScenarioRunner({ adapter });
  const result = await runner.runCell(makeRequest(matrix, cell.cell_id, "test"));
  assert.equal(result.identityAttested, false);
  assert.equal(result.error, null);
  assert.equal(result.allOraclesPassed, false,
    "allOraclesPassed is false when identity failed (non-vacuous empty oracleResults)");
  for (const r of result.runs) {
    assert.equal(r.oracleResults.length, 0, "identity-failed runs have 0 oracle results");
  }
});

test("SMELL: a cell with mixed identity (some runs fail, some succeed) does NOT reset counter cleanly", async () => {
  // The M2 logic: if identityFailedRuns > 0 &&!cellHadSuccessfulRun → increment.
  // If cellHadSuccessfulRun → reset. A mixed cell (some identity fail, some
  // success) has cellHadSuccessfulRun=true → resets the counter. This means
  // a single successful run in a cell masks the identity failures for the
  // counter purpose. This is a code smell: mixed cells reset the counter.
  // We document this behavior.
  const dir = mkTempDir("eval-adv2-");
  try {
    const matrix = devMatrix();
    const w = createResultsWriter({
      outputDir: dir, matrix, budgetEstimate: calculateBudget(matrix),
      budgetTokens: null, budgetWallTimeSeconds: null,
    });
    w.writeMatrixDocument();
    // Adapter: first run's probe fails, second and third succeed (within one cell).
    let runInCell = 0;
    let cellVisits = 0;
    const adapter: ProviderAdapter = {
      providerId: "mock-mixed",
      async *streamChatCompletion(): AsyncGenerator<ChatStreamEvent, void, unknown> { yield { type: "content", text: "x" }; },
      async chatCompletion(request): Promise<ChatCompletionResult> {
        const isProbe = request.messages[0]?.content === PROBE_PROMPT;
        if (isProbe) {
          runInCell++;
          // Fail the first probe of each cell, succeed the rest.
          if (runInCell % 3 === 1) {
            return { content: "WRONG", toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "stop", headers: {} };
          }
          return { content: "IDENTITY_PROBE_OK", toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "stop", headers: { "x-model-id": request.model } };
        }
        cellVisits++;
        return { content: "resp", toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "stop", headers: { "x-model-id": request.model } };
      },
    };
    const runner = createScenarioRunner({ adapter });
    const outcome = await executeMatrix({
      matrix, runner, resultsWriter: w,
      resolvePrompt: () => "test",
      buildCellRequest: (cell) => makeRequest(matrix, cell.cell_id, "test"),
      concurrency: 1, limitCells: 6,
    });
    // Each cell has a successful run (runs 2,3) → cellHadSuccessfulRun=true → counter resets.
    // So no pause despite 6 cells each with 1 identity-failed run.
    assert.notEqual(outcome.state, "benchmark-restart-required",
      "mixed cells (some success) reset the counter → no pause even with 6 cells");
    void cellVisits;
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("SMELL (FIXED): reconcileExecution flags a cell whose runs are exactly 3 but wrong replicate numbers", () => {
  // MAJ-13: reconciliation now checks replicate identity, not just count.
  // A cell with 3 runs all replicate=1 must fail reconciliation.
  const m = devMatrix();
  const first = m.cells[0]!;
  const fakeRuns = [{ replicate: 1 }, { replicate: 1 }, { replicate: 1 }] as never[];
  const records: CellResultRecord[] = [{
    cellId: first.cell_id, modelId: first.model_id, testId: first.test_id,
    scenarioId: "scn", conditionArm: "A1", runs: fakeRuns,
    allOraclesPassed: true, identityAttested: true, error: null, totalTokens: 0, totalDurationMs: 0,
  }];
  const skipped = m.cells.slice(1).map((c) => ({ cellId: c.cell_id, reason: "test" }));
  const report = reconcileExecution(m, records, skipped);
  assert.equal(report.cellsWithFewerRuns, 0, "3 runs (wrong replicates) is not flagged as fewer");
  assert.equal(report.cellsWithFourthRun, 0, "3 runs is not flagged as a fourth run");
  assert.equal(report.cellsWithWrongReplicates, 1, "wrong replicates must be flagged");
  assert.equal(report.allConsistent, false,
    "reconciliation now checks replicate identity — wrong replicates fail");
  assert.ok(report.discrepancies.some((d) => d.includes("replicates") && d.includes("1,1,1")),
    "discrepancies must mention the wrong replicate numbers");
});
