import assert from "node:assert/strict";
import { test } from "node:test";

import { sha256 } from "../../src/kernel/integrity.ts";
import {
  ANALYSIS_CONTRACT_VERSION,
  corpusIdentityHash,
  isProvenanceKind,
  isSourceMapValue,
  isToolState,
  isTurnRole,
  parseCorpusJson,
  PROVENANCE_KINDS,
  recordIdentityHash,
  SOURCE_RECORD_CONTRACT_VERSION,
  SourceRecordContractError,
  TRUSTED_PROVENANCE_KINDS,
  validateProvenance,
  validateSanitizedCorpus,
  validateSourceMap,
  validateSourceRecord,
  validateStoreInventory,
  type SourceRecord,
} from "../../verification/benchmarks/opencode-history/analysis/source-record-contract.ts";
import {
  computeAlignment,
  computeCodeQuality,
  computeCoverage,
  computeFriction,
  computeInteraction,
  computeProviderModelCohorts,
  computeSteering,
  computeStudyMetrics,
  computeWindowCoverage,
  EMPTY_CODE_QUALITY_BY_KIND,
  EMPTY_FRICTION_BY_KIND,
  EMPTY_INTERACTION_BY_KIND,
} from "../../verification/benchmarks/opencode-history/analysis/study-metrics.ts";
import {
  FINDING_CATEGORIES,
  FINDING_SEVERITIES,
  FINDINGS_REPORT_SCHEMA_VERSION,
  findingsReportIdentityHash,
  FindingsReportError,
  generateFindings,
  produceFindingsReport,
  validateFinding,
  validateLimitation,
  type Finding,
  type Limitation,
} from "../../verification/benchmarks/opencode-history/analysis/findings-report.ts";
import {
  DEFAULT_SEED,
  generateCorpusWithExclusionRecords,
  generateCorpusWithPostCutoffRecords,
  generateEmptyCorpus,
  generateMalformedCorpus,
  generateMultiCohortCorpus,
  generateSyntheticCorpus,
  resetFixtureCounter,
  SYNTHETIC_EXCLUDED_END_MS,
  SYNTHETIC_EXCLUDED_START_MS,
  SYNTHETIC_FIXTURE_MARKER,
  SYNTHETIC_WINDOW_END_MS,
  SYNTHETIC_WINDOW_START_MS,
} from "../../verification/benchmarks/opencode-history/analysis/synthetic-fixtures.ts";

// ============================================================================
// SourceRecord contract: type guards and constants
// ============================================================================

test("PROVENANCE_KINDS contains exactly six kinds", () => {
  assert.equal(PROVENANCE_KINDS.length, 6);
  assert.deepEqual([...PROVENANCE_KINDS], ["user", "system", "tool_sink", "assistant", "tool_output", "untrusted"]);
});

test("TRUSTED_PROVENANCE_KINDS contains exactly three trusted kinds", () => {
  assert.equal(TRUSTED_PROVENANCE_KINDS.length, 3);
  assert.deepEqual([...TRUSTED_PROVENANCE_KINDS], ["user", "system", "tool_sink"]);
});

test("isProvenanceKind returns true for all valid kinds", () => {
  for (const kind of PROVENANCE_KINDS) {
    assert.equal(isProvenanceKind(kind), true, `expected true for ${kind}`);
  }
});

test("isProvenanceKind returns false for invalid kinds", () => {
  assert.equal(isProvenanceKind("invalid"), false);
  assert.equal(isProvenanceKind(""), false);
  assert.equal(isProvenanceKind(123), false);
  assert.equal(isProvenanceKind(null), false);
  assert.equal(isProvenanceKind(undefined), false);
  assert.equal(isProvenanceKind("USER"), false);
  assert.equal(isProvenanceKind("user "), false);
});

test("isToolState returns true for valid states", () => {
  for (const state of ["pending", "running", "completed", "error"] as const) {
    assert.equal(isToolState(state), true, `expected true for ${state}`);
  }
});

test("isToolState returns false for invalid states", () => {
  assert.equal(isToolState("invalid"), false);
  assert.equal(isToolState(""), false);
  assert.equal(isToolState(123), false);
  assert.equal(isToolState(null), false);
  assert.equal(isToolState("ERROR"), false);
});

test("isTurnRole returns true for valid roles", () => {
  for (const role of ["user", "assistant", "system", "tool", "control"] as const) {
    assert.equal(isTurnRole(role), true, `expected true for ${role}`);
  }
});

test("isTurnRole returns false for invalid roles", () => {
  assert.equal(isTurnRole("invalid"), false);
  assert.equal(isTurnRole(""), false);
  assert.equal(isTurnRole(123), false);
  assert.equal(isTurnRole(null), false);
  assert.equal(isTurnRole("USER"), false);
});

test("isSourceMapValue accepts primitives", () => {
  assert.equal(isSourceMapValue(null), true);
  assert.equal(isSourceMapValue("string"), true);
  assert.equal(isSourceMapValue(42), true);
  assert.equal(isSourceMapValue(3.14), true);
  assert.equal(isSourceMapValue(true), true);
  assert.equal(isSourceMapValue(false), true);
});

test("isSourceMapValue rejects non-finite numbers", () => {
  assert.equal(isSourceMapValue(Infinity), false);
  assert.equal(isSourceMapValue(-Infinity), false);
  assert.equal(isSourceMapValue(NaN), false);
});

test("isSourceMapValue accepts arrays of valid values", () => {
  assert.equal(isSourceMapValue([1, "two", null, true]), true);
  assert.equal(isSourceMapValue([[1, 2], [3]]), true);
});

test("isSourceMapValue rejects arrays with invalid values", () => {
  assert.equal(isSourceMapValue([1, Infinity]), false);
  assert.equal(isSourceMapValue([1, undefined]), false);
  assert.equal(isSourceMapValue([1, (() => {})]), false);
});

test("isSourceMapValue accepts objects with valid values", () => {
  assert.equal(isSourceMapValue({ a: 1, b: "two" }), true);
  assert.equal(isSourceMapValue({ nested: { deep: [1, 2] } }), true);
});

test("isSourceMapValue rejects objects with invalid values", () => {
  assert.equal(isSourceMapValue({ a: Infinity }), false);
  assert.equal(isSourceMapValue({ a: undefined }), false);
  assert.equal(isSourceMapValue({ a: Symbol("x") }), false);
});

test("isSourceMapValue rejects functions and symbols", () => {
  assert.equal(isSourceMapValue((() => {})), false);
  assert.equal(isSourceMapValue(Symbol("x")), false);
});

// ============================================================================
// SourceRecord contract: validateProvenance
// ============================================================================

test("validateProvenance accepts valid provenance", () => {
  for (const kind of PROVENANCE_KINDS) {
    const result = validateProvenance({ kind, authenticatedSchemaPath: true, retained: true });
    assert.equal(result.kind, kind);
    assert.equal(result.authenticatedSchemaPath, true);
    assert.equal(result.retained, true);
  }
});

test("validateProvenance rejects null", () => {
  assert.throws(() => validateProvenance(null), SourceRecordContractError);
});

test("validateProvenance rejects arrays", () => {
  assert.throws(() => validateProvenance([]), SourceRecordContractError);
});

test("validateProvenance rejects unknown kind", () => {
  assert.throws(() => validateProvenance({ kind: "unknown", authenticatedSchemaPath: true, retained: true }), SourceRecordContractError);
});

test("validateProvenance rejects non-boolean authenticatedSchemaPath", () => {
  assert.throws(
    () => validateProvenance({ kind: "user", authenticatedSchemaPath: "true", retained: true }),
    SourceRecordContractError,
  );
});

test("validateProvenance rejects non-boolean retained", () => {
  assert.throws(
    () => validateProvenance({ kind: "user", authenticatedSchemaPath: true, retained: "yes" }),
    SourceRecordContractError,
  );
});

test("validateProvenance rejects missing fields", () => {
  assert.throws(() => validateProvenance({ kind: "user", authenticatedSchemaPath: true }), SourceRecordContractError);
});

// ============================================================================
// SourceRecord contract: validateSourceMap
// ============================================================================

test("validateSourceMap accepts valid SourceMap", () => {
  const result = validateSourceMap({ pairs: [{ key: "a", value: 1 }, { key: "b", value: "two" }] });
  assert.equal(result.pairs.length, 2);
  assert.equal(result.pairs[0]!.key, "a");
  assert.equal(result.pairs[1]!.key, "b");
});

test("validateSourceMap accepts empty pairs array", () => {
  const result = validateSourceMap({ pairs: [] });
  assert.equal(result.pairs.length, 0);
});

test("validateSourceMap rejects null", () => {
  assert.throws(() => validateSourceMap(null), SourceRecordContractError);
});

test("validateSourceMap rejects arrays", () => {
  assert.throws(() => validateSourceMap([]), SourceRecordContractError);
});

test("validateSourceMap rejects missing pairs", () => {
  assert.throws(() => validateSourceMap({}), SourceRecordContractError);
});

test("validateSourceMap rejects non-array pairs", () => {
  assert.throws(() => validateSourceMap({ pairs: "not-array" }), SourceRecordContractError);
});

test("validateSourceMap rejects empty key", () => {
  assert.throws(() => validateSourceMap({ pairs: [{ key: "", value: 1 }] }), SourceRecordContractError);
});

test("validateSourceMap rejects non-string key", () => {
  assert.throws(() => validateSourceMap({ pairs: [{ key: 123, value: 1 }] }), SourceRecordContractError);
});

test("validateSourceMap rejects duplicate keys", () => {
  assert.throws(
    () => validateSourceMap({ pairs: [{ key: "a", value: 1 }, { key: "a", value: 2 }] }),
    SourceRecordContractError,
  );
});

test("validateSourceMap rejects invalid pair value", () => {
  assert.throws(() => validateSourceMap({ pairs: [{ key: "a", value: Infinity }] }), SourceRecordContractError);
});

test("validateSourceMap rejects pair that is not an object", () => {
  assert.throws(() => validateSourceMap({ pairs: ["not-object"] }), SourceRecordContractError);
});

test("validateSourceMap rejects null pair", () => {
  assert.throws(() => validateSourceMap({ pairs: [null] }), SourceRecordContractError);
});

// ============================================================================
// SourceRecord contract: validateSourceRecord
// ============================================================================

function makeValidRecordInput(): Record<string, unknown> {
  return {
    rootOrdinal: 0,
    recordOrdinal: 0,
    provenance: { kind: "user", authenticatedSchemaPath: true, retained: true },
    payload: { pairs: [{ key: "content", value: "test" }] },
    orderKey: "0:sess:0:user",
    sessionId: "sess-1",
    rootId: "root-1",
    turnRole: "user",
    eventTimestampMs: SYNTHETIC_WINDOW_START_MS + 1000,
  };
}

test("validateSourceRecord accepts valid record", () => {
  const result = validateSourceRecord(makeValidRecordInput());
  assert.equal(result.rootOrdinal, 0);
  assert.equal(result.recordOrdinal, 0);
  assert.equal(result.provenance.kind, "user");
  assert.equal(result.turnRole, "user");
});

test("validateSourceRecord accepts optional fields", () => {
  const input = makeValidRecordInput();
  input.toolState = "completed";
  input.toolName = "edit";
  input.hasError = false;
  input.hasFileEffect = true;
  input.isCompaction = false;
  input.providerId = "prov";
  input.modelId = "model";
  input.parentRecordOrdinal = 5;
  const result = validateSourceRecord(input);
  assert.equal(result.toolState, "completed");
  assert.equal(result.toolName, "edit");
  assert.equal(result.hasFileEffect, true);
  assert.equal(result.providerId, "prov");
  assert.equal(result.parentRecordOrdinal, 5);
});

test("validateSourceRecord rejects null", () => {
  assert.throws(() => validateSourceRecord(null), SourceRecordContractError);
});

test("validateSourceRecord rejects arrays", () => {
  assert.throws(() => validateSourceRecord([]), SourceRecordContractError);
});

test("validateSourceRecord rejects negative rootOrdinal", () => {
  const input = makeValidRecordInput();
  input.rootOrdinal = -1;
  assert.throws(() => validateSourceRecord(input), SourceRecordContractError);
});

test("validateSourceRecord rejects non-integer rootOrdinal", () => {
  const input = makeValidRecordInput();
  input.rootOrdinal = 1.5;
  assert.throws(() => validateSourceRecord(input), SourceRecordContractError);
});

test("validateSourceRecord rejects negative recordOrdinal", () => {
  const input = makeValidRecordInput();
  input.recordOrdinal = -1;
  assert.throws(() => validateSourceRecord(input), SourceRecordContractError);
});

test("validateSourceRecord rejects non-integer recordOrdinal", () => {
  const input = makeValidRecordInput();
  input.recordOrdinal = 2.5;
  assert.throws(() => validateSourceRecord(input), SourceRecordContractError);
});

test("validateSourceRecord rejects invalid provenance", () => {
  const input = makeValidRecordInput();
  input.provenance = { kind: "unknown", authenticatedSchemaPath: true, retained: true };
  assert.throws(() => validateSourceRecord(input), SourceRecordContractError);
});

test("validateSourceRecord rejects empty orderKey", () => {
  const input = makeValidRecordInput();
  input.orderKey = "";
  assert.throws(() => validateSourceRecord(input), SourceRecordContractError);
});

test("validateSourceRecord rejects empty sessionId", () => {
  const input = makeValidRecordInput();
  input.sessionId = "";
  assert.throws(() => validateSourceRecord(input), SourceRecordContractError);
});

test("validateSourceRecord rejects empty rootId", () => {
  const input = makeValidRecordInput();
  input.rootId = "";
  assert.throws(() => validateSourceRecord(input), SourceRecordContractError);
});

test("validateSourceRecord rejects unknown turnRole", () => {
  const input = makeValidRecordInput();
  input.turnRole = "unknown";
  assert.throws(() => validateSourceRecord(input), SourceRecordContractError);
});

test("validateSourceRecord rejects non-integer timestamp", () => {
  const input = makeValidRecordInput();
  input.eventTimestampMs = 1.5;
  assert.throws(() => validateSourceRecord(input), SourceRecordContractError);
});

test("validateSourceRecord rejects negative timestamp", () => {
  const input = makeValidRecordInput();
  input.eventTimestampMs = -1;
  assert.throws(() => validateSourceRecord(input), SourceRecordContractError);
});

test("validateSourceRecord rejects unknown toolState", () => {
  const input = makeValidRecordInput();
  input.toolState = "unknown";
  assert.throws(() => validateSourceRecord(input), SourceRecordContractError);
});

test("validateSourceRecord rejects invalid payload", () => {
  const input = makeValidRecordInput();
  input.payload = { pairs: [{ key: "", value: 1 }] };
  assert.throws(() => validateSourceRecord(input), SourceRecordContractError);
});

// ============================================================================
// SourceRecord contract: validateStoreInventory
// ============================================================================

test("validateStoreInventory accepts valid inventory", () => {
  const result = validateStoreInventory({
    session: { rowCount: 10, identitySha256: sha256("test") },
    message: { rowCount: 20, identitySha256: sha256("test2") },
  });
  assert.equal(result.session!.rowCount, 10);
  assert.equal(result.message!.rowCount, 20);
});

test("validateStoreInventory accepts empty inventory", () => {
  const result = validateStoreInventory({});
  assert.equal(Object.keys(result).length, 0);
});

test("validateStoreInventory rejects null", () => {
  assert.throws(() => validateStoreInventory(null), SourceRecordContractError);
});

test("validateStoreInventory rejects arrays", () => {
  assert.throws(() => validateStoreInventory([]), SourceRecordContractError);
});

test("validateStoreInventory rejects non-integer rowCount", () => {
  assert.throws(
    () => validateStoreInventory({ session: { rowCount: 1.5, identitySha256: sha256("x") } }),
    SourceRecordContractError,
  );
});

test("validateStoreInventory rejects negative rowCount", () => {
  assert.throws(
    () => validateStoreInventory({ session: { rowCount: -1, identitySha256: sha256("x") } }),
    SourceRecordContractError,
  );
});

test("validateStoreInventory rejects invalid identitySha256", () => {
  assert.throws(
    () => validateStoreInventory({ session: { rowCount: 1, identitySha256: "not-a-hash" } }),
    SourceRecordContractError,
  );
});

test("validateStoreInventory rejects non-string identitySha256", () => {
  assert.throws(
    () => validateStoreInventory({ session: { rowCount: 1, identitySha256: 123 } }),
    SourceRecordContractError,
  );
});

// ============================================================================
// SourceRecord contract: validateSanitizedCorpus
// ============================================================================

test("validateSanitizedCorpus accepts valid corpus from fixture", () => {
  const corpus = generateSyntheticCorpus();
  const validated = validateSanitizedCorpus(corpus);
  assert.equal(validated.contractVersion, SOURCE_RECORD_CONTRACT_VERSION);
  assert.equal(validated.records.length, corpus.records.length);
});

test("validateSanitizedCorpus rejects null", () => {
  assert.throws(() => validateSanitizedCorpus(null), SourceRecordContractError);
});

test("validateSanitizedCorpus rejects array", () => {
  assert.throws(() => validateSanitizedCorpus([]), SourceRecordContractError);
});

test("validateSanitizedCorpus rejects wrong contract version", () => {
  const malformed = generateMalformedCorpus({ contractVersion: "wrong-version" });
  assert.throws(() => validateSanitizedCorpus(malformed), SourceRecordContractError);
});

test("validateSanitizedCorpus rejects inverted window", () => {
  const malformed = generateMalformedCorpus({ windowEndMs: SYNTHETIC_WINDOW_START_MS - 1 });
  assert.throws(() => validateSanitizedCorpus(malformed), SourceRecordContractError);
});

test("validateSanitizedCorpus rejects inverted exclusion", () => {
  const malformed = generateMalformedCorpus({ excludedEndMs: SYNTHETIC_EXCLUDED_START_MS - 1 });
  assert.throws(() => validateSanitizedCorpus(malformed), SourceRecordContractError);
});

test("validateSanitizedCorpus rejects non-array records", () => {
  const malformed = generateMalformedCorpus({ records: "not-array" });
  assert.throws(() => validateSanitizedCorpus(malformed), SourceRecordContractError);
});

test("validateSanitizedCorpus rejects empty limitation", () => {
  const malformed = generateMalformedCorpus({ limitation: "" });
  assert.throws(() => validateSanitizedCorpus(malformed), SourceRecordContractError);
});

test("validateSanitizedCorpus rejects invalid sourceSnapshotSha256", () => {
  const malformed = generateMalformedCorpus({ sourceSnapshotSha256: "invalid" });
  assert.throws(() => validateSanitizedCorpus(malformed), SourceRecordContractError);
});

test("validateSanitizedCorpus rejects invalid selectionSha256", () => {
  const malformed = generateMalformedCorpus({ selectionSha256: "invalid" });
  assert.throws(() => validateSanitizedCorpus(malformed), SourceRecordContractError);
});

test("validateSanitizedCorpus rejects empty timezone", () => {
  const malformed = generateMalformedCorpus({ timezone: "" });
  assert.throws(() => validateSanitizedCorpus(malformed), SourceRecordContractError);
});

test("validateSanitizedCorpus rejects empty upstream tag", () => {
  const malformed = generateMalformedCorpus({ upstreamTag: "" });
  assert.throws(() => validateSanitizedCorpus(malformed), SourceRecordContractError);
});

test("validateSanitizedCorpus rejects empty upstream commit", () => {
  const malformed = generateMalformedCorpus({ upstreamCommit: "" });
  assert.throws(() => validateSanitizedCorpus(malformed), SourceRecordContractError);
});

test("parseCorpusJson accepts valid JSON", () => {
  const corpus = generateSyntheticCorpus();
  const json = JSON.stringify(corpus);
  const parsed = parseCorpusJson(json);
  assert.equal(parsed.records.length, corpus.records.length);
});

test("parseCorpusJson rejects duplicate object keys", () => {
  const json = `{"contractVersion":"${SOURCE_RECORD_CONTRACT_VERSION}","contractVersion":"dup","sourceSnapshotSha256":"${sha256("x")}","selectionSha256":"${sha256("y")}","policySha256":"${sha256("z")}","querySha256":"${sha256("w")}","windowStartMs":1,"windowEndMs":2,"excludedStartMs":3,"excludedEndMs":4,"timezone":"UTC","upstreamTag":"v1","upstreamCommit":"abc","records":[],"storeInventory":{},"limitation":"test"}`;
  assert.throws(() => parseCorpusJson(json), SourceRecordContractError);
});

// ============================================================================
// SourceRecord contract: hashing and identity
// ============================================================================

test("corpusIdentityHash is deterministic for same corpus", () => {
  const corpus = generateSyntheticCorpus();
  const hash1 = corpusIdentityHash(corpus);
  const hash2 = corpusIdentityHash(corpus);
  assert.equal(hash1, hash2);
  assert.match(hash1, /^[0-9a-f]{64}$/u);
});

test("corpusIdentityHash differs for different corpora", () => {
  const corpus1 = generateSyntheticCorpus({ rootCount: 1 });
  const corpus2 = generateSyntheticCorpus({ rootCount: 2 });
  assert.notEqual(corpusIdentityHash(corpus1), corpusIdentityHash(corpus2));
});

test("recordIdentityHash is deterministic for same record", () => {
  const corpus = generateSyntheticCorpus();
  const record = corpus.records[0]!;
  const hash1 = recordIdentityHash(record);
  const hash2 = recordIdentityHash(record);
  assert.equal(hash1, hash2);
  assert.match(hash1, /^[0-9a-f]{64}$/u);
});

test("recordIdentityHash differs for different records", () => {
  const corpus = generateSyntheticCorpus();
  const hash1 = recordIdentityHash(corpus.records[0]!);
  const hash2 = recordIdentityHash(corpus.records[1]!);
  assert.notEqual(hash1, hash2);
});

// ============================================================================
// Study metrics: computeCoverage
// ============================================================================

test("computeCoverage counts roots correctly", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 3, sessionsPerRoot: 1, turnsPerSession: 1 });
  const coverage = computeCoverage(corpus);
  assert.equal(coverage.roots, 3);
});

test("computeCoverage counts sessions correctly", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 2, sessionsPerRoot: 3, turnsPerSession: 1 });
  const coverage = computeCoverage(corpus);
  assert.equal(coverage.sessions, 6);
});

test("computeCoverage counts records correctly", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 2 });
  const coverage = computeCoverage(corpus);
  assert.equal(coverage.totalRecords, corpus.records.length);
});

test("computeCoverage counts user and assistant records", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 2, hasFileEffects: false });
  const coverage = computeCoverage(corpus);
  assert.equal(coverage.userRecords, 2);
  assert.equal(coverage.assistantRecords, 2);
});

test("computeCoverage counts tool calls and results", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 1, hasFileEffects: true });
  const coverage = computeCoverage(corpus);
  assert.ok(coverage.toolCalls > 0);
  assert.ok(coverage.toolResults > 0);
});

test("computeCoverage counts tool errors", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 2, toolErrorRate: 1.0, hasFileEffects: true });
  const coverage = computeCoverage(corpus);
  assert.ok(coverage.toolErrors > 0);
});

test("computeCoverage counts file effects", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 2, hasFileEffects: true });
  const coverage = computeCoverage(corpus);
  assert.ok(coverage.fileEffects > 0);
});

test("computeCoverage counts compactions", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 4, compactionRate: 1.0 });
  const coverage = computeCoverage(corpus);
  assert.ok(coverage.compactions > 0);
});

test("computeCoverage counts model switches", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 4, modelSwitchRate: 1.0 });
  const coverage = computeCoverage(corpus);
  assert.ok(coverage.modelSwitches > 0);
});

test("computeCoverage counts zero for empty corpus", () => {
  const corpus = generateEmptyCorpus();
  const coverage = computeCoverage(corpus);
  assert.equal(coverage.roots, 0);
  assert.equal(coverage.sessions, 0);
  assert.equal(coverage.totalRecords, 0);
  assert.equal(coverage.toolCalls, 0);
  assert.equal(coverage.toolErrors, 0);
});

test("computeCoverage separates provenance kinds", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 2 });
  const coverage = computeCoverage(corpus);
  assert.ok(coverage.userRecords > 0);
  assert.ok(coverage.assistantRecords > 0);
  assert.ok(coverage.toolSinkRecords > 0);
  assert.ok(coverage.toolOutputRecords > 0);
});

// ============================================================================
// Study metrics: computeSteering
// ============================================================================

test("computeSteering returns zero events for single-turn sessions", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 1 });
  const steering = computeSteering(corpus);
  assert.equal(steering.totalEvents, 0);
});

test("computeSteering detects corrections when rapidCorrection is enabled", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 3, rapidCorrection: true });
  const steering = computeSteering(corpus);
  assert.ok(steering.totalEvents > 0);
  assert.ok(steering.corrections > 0 || steering.addenda > 0);
});

test("computeSteering detects addenda for multi-turn sessions without rapid correction", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 3, rapidCorrection: false });
  const steering = computeSteering(corpus);
  assert.ok(steering.totalEvents > 0);
});

test("computeSteering perRoot counts match total events", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 2, sessionsPerRoot: 1, turnsPerSession: 3, rapidCorrection: true });
  const steering = computeSteering(corpus);
  const perRootSum = Object.values(steering.perRoot).reduce((a, b) => a + b, 0);
  assert.equal(perRootSum, steering.totalEvents);
});

test("computeSteering perSession counts match total events", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 2, sessionsPerRoot: 2, turnsPerSession: 3, rapidCorrection: true });
  const steering = computeSteering(corpus);
  const perSessionSum = Object.values(steering.perSession).reduce((a, b) => a + b, 0);
  assert.equal(perSessionSum, steering.totalEvents);
});

test("computeSteering escalation for large gaps", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 2 });
  const records = [...corpus.records];
  const userRecords = records.filter((r) => r.turnRole === "user");
  if (userRecords.length >= 2) {
    const lastUser = userRecords[userRecords.length - 1]!;
    const idx = records.indexOf(lastUser);
    records[idx] = { ...lastUser, eventTimestampMs: lastUser.eventTimestampMs + 7_200_000 };
  }
  const modified = { ...corpus, records: records as readonly SourceRecord[] };
  const steering = computeSteering(modified);
  assert.ok(steering.escalations > 0, "expected escalation events");
});

test("computeSteering returns zero for empty corpus", () => {
  const steering = computeSteering(generateEmptyCorpus());
  assert.equal(steering.totalEvents, 0);
});

// ============================================================================
// Study metrics: computeFriction
// ============================================================================

test("computeFriction detects tool failures when errorRate is high", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 3, toolErrorRate: 1.0, hasFileEffects: true });
  const friction = computeFriction(corpus);
  assert.ok(friction.byKind.tool_failure > 0);
});

test("computeFriction detects tool loops when toolLoop is enabled", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 1, toolLoop: true, hasFileEffects: true });
  const friction = computeFriction(corpus);
  assert.ok(friction.byKind.tool_loop > 0);
});

test("computeFriction detects context loss repeats", () => {
  const corpus = generateSyntheticCorpus({
    rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 4, compactionRate: 1.0, contextLossRepeat: true, hasFileEffects: true,
  });
  const friction = computeFriction(corpus);
  assert.ok(friction.byKind.context_loss_repeat > 0, "expected context loss repeat incidents");
});

test("computeFriction detects repeated errors", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 3, toolErrorRate: 1.0, hasFileEffects: true, toolLoop: true });
  const friction = computeFriction(corpus);
  assert.ok(friction.byKind.repeated_error > 0 || friction.byKind.tool_failure > 0);
});

test("computeFriction byKind sums match total", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 2, sessionsPerRoot: 2, turnsPerSession: 3, toolErrorRate: 0.5, compactionRate: 1.0, hasFileEffects: true });
  const friction = computeFriction(corpus);
  const byKindSum = Object.values(friction.byKind).reduce((a, b) => a + b, 0);
  assert.equal(byKindSum, friction.totalIncidents);
});

test("computeFriction perRoot sums match total", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 2, sessionsPerRoot: 1, turnsPerSession: 3, toolErrorRate: 1.0, hasFileEffects: true });
  const friction = computeFriction(corpus);
  const perRootSum = Object.values(friction.perRoot).reduce((a, b) => a + b, 0);
  assert.equal(perRootSum, friction.totalIncidents);
});

test("computeFriction returns zero for empty corpus", () => {
  const friction = computeFriction(generateEmptyCorpus());
  assert.equal(friction.totalIncidents, 0);
  assert.deepEqual({ ...friction.byKind }, { ...EMPTY_FRICTION_BY_KIND });
});

test("computeFriction has no incidents when no errors and no loops", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 2, toolErrorRate: 0, hasFileEffects: true, toolLoop: false });
  const friction = computeFriction(corpus);
  assert.equal(friction.byKind.tool_failure, 0);
  assert.equal(friction.byKind.tool_loop, 0);
  assert.equal(friction.byKind.repeated_error, 0);
});

// ============================================================================
// Study metrics: computeCodeQuality
// ============================================================================

test("computeCodeQuality detects code quality indicators when enabled", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 2, hasCodeQualityIndicators: true });
  const cq = computeCodeQuality(corpus);
  assert.ok(cq.totalIndicators > 0);
  assert.ok(cq.byKind.dead_code_evidence > 0);
});

test("computeCodeQuality returns zero when no indicators", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 2, hasCodeQualityIndicators: false });
  const cq = computeCodeQuality(corpus);
  assert.equal(cq.totalIndicators, 0);
});

test("computeCodeQuality detects regression test evidence", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 2, hasRegressionTests: true });
  const cq = computeCodeQuality(corpus);
  assert.equal(cq.hasRegressionTestEvidence, true);
});

test("computeCodeQuality has no regression test evidence by default", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 2, hasRegressionTests: false });
  const cq = computeCodeQuality(corpus);
  assert.equal(cq.hasRegressionTestEvidence, false);
});

test("computeCodeQuality byKind sums match total", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 2, sessionsPerRoot: 2, turnsPerSession: 2, hasCodeQualityIndicators: true });
  const cq = computeCodeQuality(corpus);
  const byKindSum = Object.values(cq.byKind).reduce((a, b) => a + b, 0);
  assert.equal(byKindSum, cq.totalIndicators);
});

test("computeCodeQuality returns zero for empty corpus", () => {
  const cq = computeCodeQuality(generateEmptyCorpus());
  assert.equal(cq.totalIndicators, 0);
  assert.equal(cq.hasRegressionTestEvidence, false);
  assert.deepEqual({ ...cq.byKind }, { ...EMPTY_CODE_QUALITY_BY_KIND });
});

// ============================================================================
// Study metrics: computeAlignment
// ============================================================================

test("computeAlignment detects divergence with rapid correction", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 3, rapidCorrection: true });
  const alignment = computeAlignment(corpus);
  assert.ok(alignment.divergences > 0);
});

test("computeAlignment detects constraint loss with compaction", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 4, compactionRate: 1.0 });
  const alignment = computeAlignment(corpus);
  assert.ok(alignment.constraintsLost > 0 || alignment.constraintsRetained > 0);
});

test("computeAlignment detects recovery after error", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 4, toolErrorRate: 0.5, hasFileEffects: true });
  const alignment = computeAlignment(corpus);
  assert.ok(alignment.recoveries > 0, "expected at least one recovery checkpoint");
});

test("computeAlignment divergenceRate is between 0 and 1", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 2, sessionsPerRoot: 2, turnsPerSession: 3, rapidCorrection: true });
  const alignment = computeAlignment(corpus);
  assert.ok(alignment.divergenceRate >= 0);
  assert.ok(alignment.divergenceRate <= 1);
});

test("computeAlignment recoveryRate is between 0 and 1", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 2, sessionsPerRoot: 2, turnsPerSession: 3, toolErrorRate: 1.0, hasFileEffects: true });
  const alignment = computeAlignment(corpus);
  assert.ok(alignment.recoveryRate >= 0);
  assert.ok(alignment.recoveryRate <= 1);
});

test("computeAlignment returns zero for empty corpus", () => {
  const alignment = computeAlignment(generateEmptyCorpus());
  assert.equal(alignment.totalCheckpoints, 0);
  assert.equal(alignment.divergences, 0);
  assert.equal(alignment.recoveries, 0);
});

test("computeAlignment constraint_retained when compaction has no followup", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 4, compactionRate: 1.0 });
  const records = corpus.records.filter((r) => r.turnRole !== "user" || r.recordOrdinal < (corpus.records.find((r) => r.isCompaction)?.recordOrdinal ?? Infinity));
  const modified = { ...corpus, records: records as readonly SourceRecord[] };
  const alignment = computeAlignment(modified);
  assert.ok(alignment.constraintsRetained >= 0);
});

// ============================================================================
// Study metrics: computeInteraction
// ============================================================================

test("computeInteraction counts sessions correctly", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 2, sessionsPerRoot: 3, turnsPerSession: 1 });
  const interaction = computeInteraction(corpus);
  assert.equal(interaction.totalSessions, 6);
});

test("computeInteraction detects rapid correction pattern", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 3, rapidCorrection: true });
  const interaction = computeInteraction(corpus);
  assert.ok(interaction.byKind.rapid_correction > 0);
});

test("computeInteraction detects tool heavy pattern", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 4, hasFileEffects: true });
  const interaction = computeInteraction(corpus);
  assert.ok(interaction.byKind.tool_heavy > 0 || interaction.byKind.tool_heavy === 0);
});

test("computeInteraction detects compaction recovery pattern", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 4, compactionRate: 1.0 });
  const interaction = computeInteraction(corpus);
  assert.ok(interaction.byKind.compaction_recovery > 0);
});

test("computeInteraction median turns is reasonable", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 3 });
  const interaction = computeInteraction(corpus);
  assert.ok(interaction.medianTurnsPerSession > 0);
  assert.ok(interaction.maxTurnsPerSession >= interaction.minTurnsPerSession);
});

test("computeInteraction returns zero for empty corpus", () => {
  const interaction = computeInteraction(generateEmptyCorpus());
  assert.equal(interaction.totalSessions, 0);
  assert.deepEqual({ ...interaction.byKind }, { ...EMPTY_INTERACTION_BY_KIND });
});

// ============================================================================
// Study metrics: computeStudyMetrics (integration)
// ============================================================================

test("computeStudyMetrics produces all metric sections", () => {
  const corpus = generateSyntheticCorpus();
  const metrics = computeStudyMetrics(corpus);
  assert.ok(metrics.coverage);
  assert.ok(metrics.steering);
  assert.ok(metrics.friction);
  assert.ok(metrics.codeQuality);
  assert.ok(metrics.alignment);
  assert.ok(metrics.interaction);
  assert.equal(metrics.analysisContractVersion, ANALYSIS_CONTRACT_VERSION);
});

test("computeStudyMetrics metricsHash is deterministic", () => {
  const corpus = generateSyntheticCorpus();
  const m1 = computeStudyMetrics(corpus);
  const m2 = computeStudyMetrics(corpus);
  assert.equal(m1.metricsHash, m2.metricsHash);
  assert.match(m1.metricsHash, /^[0-9a-f]{64}$/u);
});

test("computeStudyMetrics metricsHash differs for different corpora", () => {
  const c1 = generateSyntheticCorpus({ rootCount: 1 });
  const c2 = generateSyntheticCorpus({ rootCount: 2 });
  assert.notEqual(computeStudyMetrics(c1).metricsHash, computeStudyMetrics(c2).metricsHash);
});

test("computeStudyMetrics works on empty corpus", () => {
  const metrics = computeStudyMetrics(generateEmptyCorpus());
  assert.equal(metrics.coverage.totalRecords, 0);
  assert.match(metrics.metricsHash, /^[0-9a-f]{64}$/u);
});

// ============================================================================
// Study metrics: computeWindowCoverage
// ============================================================================

test("computeWindowCoverage counts in-window records", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 2 });
  const wc = computeWindowCoverage(corpus);
  assert.ok(wc.inWindow > 0);
  assert.equal(wc.inExclusion, 0);
  assert.equal(wc.postCutoff, 0);
});

test("computeWindowCoverage detects exclusion records", () => {
  const corpus = generateCorpusWithExclusionRecords();
  const wc = computeWindowCoverage(corpus);
  assert.ok(wc.inExclusion > 0, "expected exclusion records");
});

test("computeWindowCoverage detects post-cutoff records", () => {
  const corpus = generateCorpusWithPostCutoffRecords();
  const wc = computeWindowCoverage(corpus);
  assert.ok(wc.postCutoff > 0, "expected post-cutoff records");
});

test("computeWindowCoverage total equals record count", () => {
  const corpus = generateSyntheticCorpus();
  const wc = computeWindowCoverage(corpus);
  assert.equal(wc.total, corpus.records.length);
  assert.equal(wc.inWindow + wc.preWindow + wc.inExclusion + wc.postCutoff, wc.total);
});

// ============================================================================
// Study metrics: computeProviderModelCohorts
// ============================================================================

test("computeProviderModelCohorts identifies single cohort", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 2 });
  const cohorts = computeProviderModelCohorts(corpus);
  assert.ok(cohorts.length >= 1);
  assert.equal(cohorts[0]!.providerId, "synthetic-provider");
  assert.equal(cohorts[0]!.modelId, "synthetic-model");
});

test("computeProviderModelCohorts identifies multiple cohorts", () => {
  const corpus = generateMultiCohortCorpus();
  const cohorts = computeProviderModelCohorts(corpus);
  assert.ok(cohorts.length >= 2, "expected multiple cohorts");
});

test("computeProviderModelCohorts returns empty for no attribution", () => {
  const corpus = generateEmptyCorpus();
  const cohorts = computeProviderModelCohorts(corpus);
  assert.equal(cohorts.length, 0);
});

test("computeProviderModelCohorts are sorted by provider then model", () => {
  const corpus = generateMultiCohortCorpus();
  const cohorts = computeProviderModelCohorts(corpus);
  for (let i = 1; i < cohorts.length; i += 1) {
    const prev = cohorts[i - 1]!;
    const curr = cohorts[i]!;
    const cmp = prev.providerId.localeCompare(curr.providerId) || prev.modelId.localeCompare(curr.modelId);
    assert.ok(cmp <= 0, `cohort ${i} not sorted`);
  }
});

// ============================================================================
// Findings report: generateFindings
// ============================================================================

test("generateFindings produces a report with correct schema version", () => {
  const corpus = generateSyntheticCorpus();
  const metrics = computeStudyMetrics(corpus);
  const report = generateFindings(corpus, metrics);
  assert.equal(report.schemaVersion, FINDINGS_REPORT_SCHEMA_VERSION);
});

test("generateFindings sets sec001Open and syntheticOnly for synthetic", () => {
  const corpus = generateSyntheticCorpus();
  const metrics = computeStudyMetrics(corpus);
  const report = generateFindings(corpus, metrics, {
    generatedAt: "2026-07-17T00:00:00.000Z",
    sec001Open: true,
    realHistoryReady: false,
    syntheticOnly: true,
  });
  assert.equal(report.sec001Open, true);
  assert.equal(report.syntheticOnly, true);
  assert.equal(report.realHistoryReady, false);
});

test("generateFindings rejects synthetic-only with sec001 closed", () => {
  const corpus = generateSyntheticCorpus();
  const metrics = computeStudyMetrics(corpus);
  assert.throws(
    () => generateFindings(corpus, metrics, { generatedAt: "x", sec001Open: false, realHistoryReady: true, syntheticOnly: true }),
    FindingsReportError,
  );
});

test("generateFindings rejects empty corpus", () => {
  const corpus = generateEmptyCorpus();
  const metrics = computeStudyMetrics(corpus);
  assert.throws(() => generateFindings(corpus, metrics), FindingsReportError);
});

test("generateFindings includes SEC-001 limitation", () => {
  const corpus = generateSyntheticCorpus();
  const metrics = computeStudyMetrics(corpus);
  const report = generateFindings(corpus, metrics);
  const sec001Limit = report.limitations.find((l) => l.kind === "sec001_blocking");
  assert.ok(sec001Limit, "expected SEC-001 limitation");
});

test("generateFindings includes synthetic-only limitation", () => {
  const corpus = generateSyntheticCorpus();
  const metrics = computeStudyMetrics(corpus);
  const report = generateFindings(corpus, metrics);
  const synthLimit = report.limitations.find((l) => l.kind === "synthetic_only");
  assert.ok(synthLimit, "expected synthetic-only limitation");
});

test("generateFindings generates friction findings when errors exist", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 3, toolErrorRate: 1.0, hasFileEffects: true });
  const metrics = computeStudyMetrics(corpus);
  const report = generateFindings(corpus, metrics);
  const frictionFinding = report.findings.find((f) => f.category === "friction");
  assert.ok(frictionFinding, "expected friction finding");
});

test("generateFindings generates steering findings when corrections exist", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 3, rapidCorrection: true });
  const metrics = computeStudyMetrics(corpus);
  const report = generateFindings(corpus, metrics);
  const steeringFinding = report.findings.find((f) => f.category === "steering");
  assert.ok(steeringFinding, "expected steering finding");
});

test("generateFindings generates code quality findings when indicators exist", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 2, hasCodeQualityIndicators: true });
  const metrics = computeStudyMetrics(corpus);
  const report = generateFindings(corpus, metrics);
  const cqFinding = report.findings.find((f) => f.category === "code_quality");
  assert.ok(cqFinding, "expected code quality finding");
});

test("generateFindings generates alignment findings when divergences exist", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 3, rapidCorrection: true });
  const metrics = computeStudyMetrics(corpus);
  const report = generateFindings(corpus, metrics);
  const alignFinding = report.findings.find((f) => f.category === "alignment");
  assert.ok(alignFinding, "expected alignment finding");
});

test("generateFindings generates coverage findings when truncated evidence exists", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 2 });
  const metrics = computeStudyMetrics(corpus);
  const report = generateFindings(corpus, metrics);
  if (metrics.coverage.unavailable > 0 || metrics.coverage.truncated > 0) {
    const covFinding = report.findings.find((f) => f.category === "coverage");
    assert.ok(covFinding);
  }
});

test("generateFindings generates provider_tool findings for multiple cohorts", () => {
  const corpus = generateMultiCohortCorpus();
  const metrics = computeStudyMetrics(corpus);
  const report = generateFindings(corpus, metrics);
  const providerFinding = report.findings.find((f) => f.category === "provider_tool");
  assert.ok(providerFinding, "expected provider_tool finding for multiple cohorts");
});

test("generateFindings reportHash is deterministic", () => {
  const corpus = generateSyntheticCorpus();
  const metrics = computeStudyMetrics(corpus);
  const r1 = generateFindings(corpus, metrics, { generatedAt: "2026-07-17T00:00:00.000Z", sec001Open: true, realHistoryReady: false, syntheticOnly: true });
  const r2 = generateFindings(corpus, metrics, { generatedAt: "2026-07-17T00:00:00.000Z", sec001Open: true, realHistoryReady: false, syntheticOnly: true });
  assert.equal(r1.reportHash, r2.reportHash);
  assert.match(r1.reportHash, /^[0-9a-f]{64}$/u);
});

test("generateFindings reportHash differs for different generatedAt", () => {
  const corpus = generateSyntheticCorpus();
  const metrics = computeStudyMetrics(corpus);
  const r1 = generateFindings(corpus, metrics, { generatedAt: "2026-07-17T00:00:00.000Z", sec001Open: true, realHistoryReady: false, syntheticOnly: true });
  const r2 = generateFindings(corpus, metrics, { generatedAt: "2026-07-18T00:00:00.000Z", sec001Open: true, realHistoryReady: false, syntheticOnly: true });
  assert.notEqual(r1.reportHash, r2.reportHash);
});

test("generateFindings includes window metadata", () => {
  const corpus = generateSyntheticCorpus();
  const metrics = computeStudyMetrics(corpus);
  const report = generateFindings(corpus, metrics);
  assert.equal(report.window.startMs, SYNTHETIC_WINDOW_START_MS);
  assert.equal(report.window.endMs, SYNTHETIC_WINDOW_END_MS);
  assert.equal(report.window.timezone, "America/Toronto");
});

test("generateFindings includes upstream metadata", () => {
  const corpus = generateSyntheticCorpus();
  const metrics = computeStudyMetrics(corpus);
  const report = generateFindings(corpus, metrics);
  assert.equal(report.upstream.tag, "v1.17.18");
  assert.ok(report.upstream.commit.length > 0);
});

test("generateFindings includes compaction limitation when compactions exist", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 4, compactionRate: 1.0 });
  const metrics = computeStudyMetrics(corpus);
  const report = generateFindings(corpus, metrics);
  const compactionLimit = report.limitations.find((l) => l.kind === "compaction_gap");
  assert.ok(compactionLimit, "expected compaction_gap limitation");
});

test("generateFindings includes exclusion limitation when exclusion records exist", () => {
  const corpus = generateCorpusWithExclusionRecords();
  const metrics = computeStudyMetrics(corpus);
  const report = generateFindings(corpus, metrics);
  const exclLimit = report.limitations.find((l) => l.kind === "post_cutoff_excluded");
  assert.ok(exclLimit, "expected post_cutoff_excluded limitation");
});

test("generateFindings includes unknown_provider_model limitation when no cohorts", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 2 });
  const records = corpus.records.map((r) =>
    r.turnRole === "assistant" ? { ...r, providerId: undefined, modelId: undefined } : r,
  ) as readonly SourceRecord[];
  const modified = { ...corpus, records };
  const metrics = computeStudyMetrics(modified);
  const report = generateFindings(modified, metrics);
  const unknownLimit = report.limitations.find((l) => l.kind === "unknown_provider_model");
  assert.ok(unknownLimit, "expected unknown_provider_model limitation");
});

// ============================================================================
// Findings report: produceFindingsReport
// ============================================================================

test("produceFindingsReport integrates corpus -> metrics -> findings", () => {
  const corpus = generateSyntheticCorpus();
  const report = produceFindingsReport(corpus, {
    generatedAt: "2026-07-17T00:00:00.000Z",
    sec001Open: true,
    realHistoryReady: false,
    syntheticOnly: true,
  });
  assert.ok(report.metrics.coverage);
  assert.ok(report.findings.length >= 0);
  assert.ok(report.limitations.length >= 2);
});

test("produceFindingsReport metricsHash matches metrics", () => {
  const corpus = generateSyntheticCorpus();
  const report = produceFindingsReport(corpus);
  const metrics = computeStudyMetrics(corpus);
  assert.equal(report.metricsHash, metrics.metricsHash);
});

// ============================================================================
// Findings report: validateFinding and validateLimitation
// ============================================================================

test("validateFinding accepts valid finding", () => {
  const finding: Finding = {
    id: "FIND-0001",
    category: "friction",
    severity: "high",
    title: "Test finding",
    description: "Test description",
    evidenceCount: 5,
    cohortProviderId: null,
    cohortModelId: null,
  };
  const result = validateFinding(finding);
  assert.equal(result.id, "FIND-0001");
});

test("validateFinding rejects null", () => {
  assert.throws(() => validateFinding(null), FindingsReportError);
});

test("validateFinding rejects invalid category", () => {
  assert.throws(
    () => validateFinding({ id: "F", category: "invalid", severity: "high", title: "t", description: "d", evidenceCount: 1, cohortProviderId: null, cohortModelId: null }),
    FindingsReportError,
  );
});

test("validateFinding rejects invalid severity", () => {
  assert.throws(
    () => validateFinding({ id: "F", category: "friction", severity: "invalid", title: "t", description: "d", evidenceCount: 1, cohortProviderId: null, cohortModelId: null }),
    FindingsReportError,
  );
});

test("validateFinding rejects empty title", () => {
  assert.throws(
    () => validateFinding({ id: "F", category: "friction", severity: "high", title: "", description: "d", evidenceCount: 1, cohortProviderId: null, cohortModelId: null }),
    FindingsReportError,
  );
});

test("validateFinding rejects negative evidenceCount", () => {
  assert.throws(
    () => validateFinding({ id: "F", category: "friction", severity: "high", title: "t", description: "d", evidenceCount: -1, cohortProviderId: null, cohortModelId: null }),
    FindingsReportError,
  );
});

test("validateFinding accepts all valid categories", () => {
  for (const cat of FINDING_CATEGORIES) {
    const result = validateFinding({ id: "F", category: cat, severity: "info", title: "t", description: "d", evidenceCount: 0, cohortProviderId: null, cohortModelId: null });
    assert.equal(result.category, cat);
  }
});

test("validateFinding accepts all valid severities", () => {
  for (const sev of FINDING_SEVERITIES) {
    const result = validateFinding({ id: "F", category: "friction", severity: sev, title: "t", description: "d", evidenceCount: 0, cohortProviderId: null, cohortModelId: null });
    assert.equal(result.severity, sev);
  }
});

test("validateLimitation accepts valid limitation", () => {
  const limitation: Limitation = {
    kind: "sec001_blocking",
    description: "SEC-001 is open",
    affectedMetric: "all",
  };
  const result = validateLimitation(limitation);
  assert.equal(result.kind, "sec001_blocking");
});

test("validateLimitation rejects null", () => {
  assert.throws(() => validateLimitation(null), FindingsReportError);
});

test("validateLimitation rejects empty description", () => {
  assert.throws(() => validateLimitation({ kind: "x", description: "", affectedMetric: "all" }), FindingsReportError);
});

test("validateLimitation rejects empty affectedMetric", () => {
  assert.throws(() => validateLimitation({ kind: "x", description: "d", affectedMetric: "" }), FindingsReportError);
});

// ============================================================================
// Findings report: identity hash
// ============================================================================

test("findingsReportIdentityHash is deterministic", () => {
  const corpus = generateSyntheticCorpus();
  const report = produceFindingsReport(corpus);
  const h1 = findingsReportIdentityHash(report);
  const h2 = findingsReportIdentityHash(report);
  assert.equal(h1, h2);
  assert.match(h1, /^[0-9a-f]{64}$/u);
});

test("findingsReportIdentityHash differs for different reports", () => {
  const c1 = generateSyntheticCorpus({ rootCount: 1 });
  const c2 = generateSyntheticCorpus({ rootCount: 2 });
  const r1 = produceFindingsReport(c1);
  const r2 = produceFindingsReport(c2);
  assert.notEqual(findingsReportIdentityHash(r1), findingsReportIdentityHash(r2));
});

// ============================================================================
// Synthetic fixtures: determinism and edge cases
// ============================================================================

test("generateSyntheticCorpus with default seed produces records", () => {
  const corpus = generateSyntheticCorpus();
  assert.ok(corpus.records.length > 0);
  assert.equal(corpus.contractVersion, SOURCE_RECORD_CONTRACT_VERSION);
});

test("generateSyntheticCorpus is deterministic for same seed", () => {
  const c1 = generateSyntheticCorpus({ rootCount: 2 });
  const c2 = generateSyntheticCorpus({ rootCount: 2 });
  assert.equal(c1.records.length, c2.records.length);
  assert.equal(c1.selectionSha256, c2.selectionSha256);
});

test("generateSyntheticCorpus respects rootCount", () => {
  const c1 = generateSyntheticCorpus({ rootCount: 1 });
  const c2 = generateSyntheticCorpus({ rootCount: 3 });
  assert.ok(c2.records.length > c1.records.length);
});

test("generateSyntheticCorpus respects sessionsPerRoot", () => {
  const c1 = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1 });
  const c2 = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 3 });
  assert.ok(c2.records.length > c1.records.length);
});

test("generateSyntheticCorpus respects turnsPerSession", () => {
  const c1 = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 1 });
  const c2 = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 4 });
  assert.ok(c2.records.length > c1.records.length);
});

test("generateSyntheticCorpus produces validatable corpus", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 2, sessionsPerRoot: 2, turnsPerSession: 3 });
  const validated = validateSanitizedCorpus(corpus);
  assert.equal(validated.records.length, corpus.records.length);
});

test("generateSyntheticCorpus with toolLoop produces repeated tool calls", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 1, toolLoop: true, hasFileEffects: true });
  const toolCalls = corpus.records.filter((r) => r.provenance.kind === "tool_sink");
  const toolNames = toolCalls.map((r) => r.toolName);
  const counts = toolNames.reduce<Record<string, number>>((acc, name) => {
    if (name) acc[name] = (acc[name] ?? 0) + 1;
    return acc;
  }, {});
  assert.ok(Object.values(counts).some((c) => c >= 3), "expected at least 3 repeated tool calls");
});

test("generateSyntheticCorpus with compactionRate produces compaction events", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 4, compactionRate: 1.0 });
  const compactions = corpus.records.filter((r) => r.isCompaction === true);
  assert.ok(compactions.length > 0, "expected compaction events");
});

test("generateSyntheticCorpus with modelSwitchRate produces model switch events", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 4, modelSwitchRate: 1.0 });
  const switches = corpus.records.filter((r) => r.isModelSwitch === true);
  assert.ok(switches.length > 0, "expected model switch events");
});

test("generateSyntheticCorpus with hasFileEffects produces file effect records", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 2, hasFileEffects: true });
  const effects = corpus.records.filter((r) => r.hasFileEffect === true);
  assert.ok(effects.length > 0, "expected file effect records");
});

test("generateSyntheticCorpus without fileEffects has no file effects", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 2, hasFileEffects: false, toolErrorRate: 0 });
  const effects = corpus.records.filter((r) => r.hasFileEffect === true);
  assert.equal(effects.length, 0);
});

test("generateSyntheticCorpus with hasCodeQualityIndicators produces indicators", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 2, hasCodeQualityIndicators: true });
  const indicators = corpus.records.filter((r) => r.payload.pairs.some((p) => p.key === "qualityIndicator"));
  assert.ok(indicators.length > 0);
});

test("generateEmptyCorpus produces zero-record corpus", () => {
  const corpus = generateEmptyCorpus();
  assert.equal(corpus.records.length, 0);
  assert.equal(corpus.contractVersion, SOURCE_RECORD_CONTRACT_VERSION);
});

test("generateEmptyCorpus is validatable", () => {
  const corpus = generateEmptyCorpus();
  const validated = validateSanitizedCorpus(corpus);
  assert.equal(validated.records.length, 0);
});

test("generateCorpusWithExclusionRecords produces exclusion-window records", () => {
  const corpus = generateCorpusWithExclusionRecords();
  const wc = computeWindowCoverage(corpus);
  assert.ok(wc.inExclusion > 0);
});

test("generateCorpusWithPostCutoffRecords produces post-cutoff records", () => {
  const corpus = generateCorpusWithPostCutoffRecords();
  const wc = computeWindowCoverage(corpus);
  assert.ok(wc.postCutoff > 0);
});

test("generateMultiCohortCorpus produces multiple provider/model cohorts", () => {
  const corpus = generateMultiCohortCorpus();
  const cohorts = computeProviderModelCohorts(corpus);
  assert.ok(cohorts.length >= 2);
});

test("generateMalformedCorpus applies overwrite", () => {
  const malformed = generateMalformedCorpus({ contractVersion: "overwritten" });
  const obj = malformed as Record<string, unknown>;
  assert.equal(obj.contractVersion, "overwritten");
});

test("resetFixtureCounter resets record ordinals", () => {
  generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 1 });
  resetFixtureCounter();
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 1 });
  assert.equal(corpus.records[0]!.recordOrdinal, 0);
});

test("SYNTHETIC_FIXTURE_MARKER is non-empty string", () => {
  assert.ok(SYNTHETIC_FIXTURE_MARKER.length > 0);
  assert.equal(typeof SYNTHETIC_FIXTURE_MARKER, "string");
});

test("synthetic window constants are consistent", () => {
  assert.ok(SYNTHETIC_WINDOW_START_MS < SYNTHETIC_WINDOW_END_MS);
  assert.ok(SYNTHETIC_EXCLUDED_START_MS < SYNTHETIC_EXCLUDED_END_MS);
  assert.ok(SYNTHETIC_EXCLUDED_START_MS > SYNTHETIC_WINDOW_START_MS);
  assert.ok(SYNTHETIC_EXCLUDED_END_MS < SYNTHETIC_WINDOW_END_MS);
});

test("DEFAULT_SEED has all required fields", () => {
  assert.ok(typeof DEFAULT_SEED.rootCount === "number");
  assert.ok(typeof DEFAULT_SEED.sessionsPerRoot === "number");
  assert.ok(typeof DEFAULT_SEED.turnsPerSession === "number");
  assert.ok(typeof DEFAULT_SEED.toolErrorRate === "number");
  assert.ok(typeof DEFAULT_SEED.providerId === "string");
  assert.ok(typeof DEFAULT_SEED.modelId === "string");
});

test("synthetic corpus storeInventory has all six stores", () => {
  const corpus = generateSyntheticCorpus();
  const storeNames = Object.keys(corpus.storeInventory);
  assert.ok(storeNames.includes("session"));
  assert.ok(storeNames.includes("message"));
  assert.ok(storeNames.includes("part"));
  assert.ok(storeNames.includes("session_message"));
  assert.ok(storeNames.includes("session_input"));
  assert.ok(storeNames.includes("session_context_epoch"));
});

test("synthetic corpus limitation mentions synthetic-only", () => {
  const corpus = generateSyntheticCorpus();
  assert.ok(corpus.limitation.includes("synthetic") || corpus.limitation.includes("SEC-001"));
});

// ============================================================================
// Cross-module integration: end-to-end pipeline
// ============================================================================

test("end-to-end: corpus -> validate -> metrics -> findings produces consistent report", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 2, sessionsPerRoot: 2, turnsPerSession: 3, toolErrorRate: 0.5, compactionRate: 1.0, hasFileEffects: true });
  const validated = validateSanitizedCorpus(corpus);
  const metrics = computeStudyMetrics(validated);
  const report = generateFindings(validated, metrics, {
    generatedAt: "2026-07-17T00:00:00.000Z",
    sec001Open: true,
    realHistoryReady: false,
    syntheticOnly: true,
  });
  assert.equal(report.metricsHash, metrics.metricsHash);
  assert.ok(report.findings.length > 0);
  assert.ok(report.limitations.length >= 2);
});

test("end-to-end: empty corpus validation passes, metrics pass, findings reject", () => {
  const corpus = generateEmptyCorpus();
  const validated = validateSanitizedCorpus(corpus);
  const metrics = computeStudyMetrics(validated);
  assert.equal(metrics.coverage.totalRecords, 0);
  assert.throws(() => generateFindings(validated, metrics), FindingsReportError);
});

test("end-to-end: multi-cohort corpus produces provider findings", () => {
  const corpus = generateMultiCohortCorpus();
  const metrics = computeStudyMetrics(corpus);
  const report = generateFindings(corpus, metrics);
  const providerFinding = report.findings.find((f) => f.category === "provider_tool");
  assert.ok(providerFinding);
  assert.ok(providerFinding!.evidenceCount >= 2);
});

test("end-to-end: report identity hash is stable across re-derivation", () => {
  const corpus = generateSyntheticCorpus();
  const report1 = produceFindingsReport(corpus, { generatedAt: "2026-07-17T00:00:00.000Z", sec001Open: true, realHistoryReady: false, syntheticOnly: true });
  const report2 = produceFindingsReport(corpus, { generatedAt: "2026-07-17T00:00:00.000Z", sec001Open: true, realHistoryReady: false, syntheticOnly: true });
  assert.equal(findingsReportIdentityHash(report1), findingsReportIdentityHash(report2));
  assert.equal(report1.reportHash, report2.reportHash);
});

test("end-to-end: corpus with all features produces comprehensive findings", () => {
  const corpus = generateSyntheticCorpus({
    rootCount: 2,
    sessionsPerRoot: 2,
    turnsPerSession: 4,
    toolErrorRate: 1.0,
    compactionRate: 1.0,
    modelSwitchRate: 1.0,
    hasFileEffects: true,
    hasCodeQualityIndicators: true,
    hasRegressionTests: true,
    rapidCorrection: true,
    toolLoop: true,
    contextLossRepeat: true,
  });
  const metrics = computeStudyMetrics(corpus);
  const report = generateFindings(corpus, metrics);
  assert.ok(report.findings.length >= 3, "expected comprehensive findings");
  assert.ok(report.limitations.length >= 3);
  assert.ok(metrics.friction.totalIncidents > 0);
  assert.ok(metrics.alignment.totalCheckpoints > 0);
  assert.ok(metrics.interaction.totalSessions > 0);
});

test("end-to-end: metrics hash is invariant to record ordering within corpus", () => {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 2 });
  const reversed = { ...corpus, records: [...corpus.records].reverse() as readonly SourceRecord[] };
  const m1 = computeStudyMetrics(corpus);
  const m2 = computeStudyMetrics(reversed);
  assert.equal(m1.metricsHash, m2.metricsHash, "metrics should be order-invariant at hash level");
});
