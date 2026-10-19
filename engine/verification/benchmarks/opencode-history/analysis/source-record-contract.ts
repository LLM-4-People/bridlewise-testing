/**
 * Sanitized SourceRecord contract (v4.6.1) for the OpenCode evidence study.
 *
 * This is a GENERIC exchange contract. It consumes the sanitized output of the
 * read-only adapter and sanitizer. It contains NO OpenCode-specific schema,
 * table names, identifiers, or relationships. It is research/verification code
 * in the verification realm, NOT a product runtime module. No product source
 * may import this file.
 *
 * The contract is versioned as `v46.SourceRecord/SourceMap-v1` to match the
 * upstream adapter design. A version change creates a new analysis version and
 * preserves prior results.
 */

import { canonicalHash, deepFreeze, sha256 } from "../../../../src/kernel/integrity.ts";
import { assertNoDuplicateJsonObjectKeys } from "../../../../src/kernel/json-integrity.ts";

export const SOURCE_RECORD_CONTRACT_VERSION = "v46.SourceRecord/SourceMap-v1" as const;
export const ANALYSIS_CONTRACT_VERSION = "bridlewise-opencode-study-analysis/v1" as const;

export type ProvenanceKind =
  | "user"
  | "system"
  | "tool_sink"
  | "assistant"
  | "tool_output"
  | "untrusted";

export const PROVENANCE_KINDS = deepFreeze([
  "user",
  "system",
  "tool_sink",
  "assistant",
  "tool_output",
  "untrusted",
] as readonly ProvenanceKind[]);

export const TRUSTED_PROVENANCE_KINDS = deepFreeze([
  "user",
  "system",
  "tool_sink",
] as readonly ProvenanceKind[]);

export type Provenance = Readonly<{
  kind: ProvenanceKind;
  authenticatedSchemaPath: boolean;
  retained: boolean;
}>;

export type SourceMapValue =
  | string
  | number
  | boolean
  | null
  | SourceMapValue[]
  | { [key: string]: SourceMapValue };

export type SourceMapPair = Readonly<{ key: string; value: SourceMapValue }>;

export type SourceMap = Readonly<{ pairs: readonly SourceMapPair[] }>;

export type ToolState = "pending" | "running" | "completed" | "error";

export const TOOL_STATES = deepFreeze([
  "pending",
  "running",
  "completed",
  "error",
] as readonly ToolState[]);

export type TurnRole = "user" | "assistant" | "system" | "tool" | "control";

export const TURN_ROLES = deepFreeze([
  "user",
  "assistant",
  "system",
  "tool",
  "control",
] as readonly TurnRole[]);

export type SourceRecord = Readonly<{
  rootOrdinal: number;
  recordOrdinal: number;
  provenance: Provenance;
  payload: SourceMap;
  orderKey: string;
  sessionId: string;
  rootId: string;
  turnRole: TurnRole;
  eventTimestampMs: number;
  toolState?: ToolState;
  toolName?: string;
  hasError?: boolean;
  hasFileEffect?: boolean;
  isCompaction?: boolean;
  isModelSwitch?: boolean;
  isAgentSwitch?: boolean;
  providerId?: string;
  modelId?: string;
  parentRecordOrdinal?: number;
}>;

export type SanitizedCorpus = Readonly<{
  contractVersion: string;
  sourceSnapshotSha256: string;
  selectionSha256: string;
  policySha256: string;
  querySha256: string;
  windowStartMs: number;
  windowEndMs: number;
  excludedStartMs: number;
  excludedEndMs: number;
  timezone: string;
  upstreamTag: string;
  upstreamCommit: string;
  records: readonly SourceRecord[];
  storeInventory: Readonly<Record<string, Readonly<{ rowCount: number; identitySha256: string }>>>;
  limitation: string;
}>;

export class SourceRecordContractError extends Error {
  readonly code: SourceRecordContractErrorCode;

  constructor(code: SourceRecordContractErrorCode) {
    super(code);
    this.name = "SourceRecordContractError";
    this.code = code;
  }
}

export type SourceRecordContractErrorCode =
  | "contract_version_mismatch"
  | "corpus_not_object"
  | "records_not_array"
  | "record_not_object"
  | "provenance_invalid"
  | "provenance_kind_unknown"
  | "ordinal_negative"
  | "ordinal_not_integer"
  | "order_key_empty"
  | "session_id_empty"
  | "root_id_empty"
  | "turn_role_unknown"
  | "timestamp_not_integer"
  | "timestamp_negative"
  | "tool_state_unknown"
  | "payload_not_sourcemap"
  | "payload_pairs_not_array"
  | "payload_pair_invalid"
  | "payload_duplicate_key"
  | "store_inventory_invalid"
  | "window_inverted"
  | "exclusion_inverted"
  | "limitation_empty"
  | "window_outside_scope"
  | "record_ordinal_gap"
  | "root_ordinal_gap"
  | "timestamp_outside_window"
  | "timestamp_in_exclusion";

export function isProvenanceKind(value: unknown): value is ProvenanceKind {
  return typeof value === "string" && (PROVENANCE_KINDS as readonly string[]).includes(value);
}

export function isToolState(value: unknown): value is ToolState {
  return typeof value === "string" && (TOOL_STATES as readonly string[]).includes(value);
}

export function isTurnRole(value: unknown): value is TurnRole {
  return typeof value === "string" && (TURN_ROLES as readonly string[]).includes(value);
}

export function isSourceMapValue(value: unknown): value is SourceMapValue {
  if (value === null) return true;
  if (typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) {
    return value.every(isSourceMapValue);
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.values(record).every(isSourceMapValue);
  }
  return false;
}

export function validateProvenance(value: unknown): Provenance {
  if (typeof value !== "object" || value === null) {
    throw new SourceRecordContractError("provenance_invalid");
  }
  const record = value as Record<string, unknown>;
  if (!isProvenanceKind(record.kind)) {
    throw new SourceRecordContractError("provenance_kind_unknown");
  }
  if (typeof record.authenticatedSchemaPath !== "boolean") {
    throw new SourceRecordContractError("provenance_invalid");
  }
  if (typeof record.retained !== "boolean") {
    throw new SourceRecordContractError("provenance_invalid");
  }
  return deepFreeze({
    kind: record.kind,
    authenticatedSchemaPath: record.authenticatedSchemaPath,
    retained: record.retained,
  });
}

export function validateSourceMap(value: unknown): SourceMap {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SourceRecordContractError("payload_not_sourcemap");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.pairs)) {
    throw new SourceRecordContractError("payload_pairs_not_array");
  }
  const pairs: SourceMapPair[] = [];
  const seenKeys = new Set<string>();
  for (const pair of record.pairs) {
    if (typeof pair !== "object" || pair === null || Array.isArray(pair)) {
      throw new SourceRecordContractError("payload_pair_invalid");
    }
    const pairRecord = pair as Record<string, unknown>;
    if (typeof pairRecord.key !== "string" || pairRecord.key.length === 0) {
      throw new SourceRecordContractError("payload_pair_invalid");
    }
    if (seenKeys.has(pairRecord.key)) {
      throw new SourceRecordContractError("payload_duplicate_key");
    }
    seenKeys.add(pairRecord.key);
    if (!isSourceMapValue(pairRecord.value)) {
      throw new SourceRecordContractError("payload_pair_invalid");
    }
    pairs.push(deepFreeze({ key: pairRecord.key, value: pairRecord.value as SourceMapValue }));
  }
  return deepFreeze({ pairs });
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function validateSourceRecord(value: unknown): SourceRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SourceRecordContractError("record_not_object");
  }
  const record = value as Record<string, unknown>;
  if (!isNonNegativeInteger(record.rootOrdinal)) {
    throw new SourceRecordContractError("ordinal_not_integer");
  }
  if (!isNonNegativeInteger(record.recordOrdinal)) {
    throw new SourceRecordContractError("ordinal_not_integer");
  }
  const provenance = validateProvenance(record.provenance);
  const payload = validateSourceMap(record.payload);
  if (typeof record.orderKey !== "string" || record.orderKey.length === 0) {
    throw new SourceRecordContractError("order_key_empty");
  }
  if (typeof record.sessionId !== "string" || record.sessionId.length === 0) {
    throw new SourceRecordContractError("session_id_empty");
  }
  if (typeof record.rootId !== "string" || record.rootId.length === 0) {
    throw new SourceRecordContractError("root_id_empty");
  }
  if (!isTurnRole(record.turnRole)) {
    throw new SourceRecordContractError("turn_role_unknown");
  }
  if (typeof record.eventTimestampMs !== "number" || !Number.isInteger(record.eventTimestampMs)) {
    throw new SourceRecordContractError("timestamp_not_integer");
  }
  if (record.eventTimestampMs < 0) {
    throw new SourceRecordContractError("timestamp_negative");
  }
  const toolState = record.toolState !== undefined ? (isToolState(record.toolState) ? record.toolState : undefined) : undefined;
  if (record.toolState !== undefined && !isToolState(record.toolState)) {
    throw new SourceRecordContractError("tool_state_unknown");
  }
  return deepFreeze({
    rootOrdinal: record.rootOrdinal,
    recordOrdinal: record.recordOrdinal,
    provenance,
    payload,
    orderKey: record.orderKey,
    sessionId: record.sessionId,
    rootId: record.rootId,
    turnRole: record.turnRole,
    eventTimestampMs: record.eventTimestampMs,
    ...(toolState !== undefined ? { toolState } : {}),
    ...(typeof record.toolName === "string" ? { toolName: record.toolName } : {}),
    ...(typeof record.hasError === "boolean" ? { hasError: record.hasError } : {}),
    ...(typeof record.hasFileEffect === "boolean" ? { hasFileEffect: record.hasFileEffect } : {}),
    ...(typeof record.isCompaction === "boolean" ? { isCompaction: record.isCompaction } : {}),
    ...(typeof record.isModelSwitch === "boolean" ? { isModelSwitch: record.isModelSwitch } : {}),
    ...(typeof record.isAgentSwitch === "boolean" ? { isAgentSwitch: record.isAgentSwitch } : {}),
    ...(typeof record.providerId === "string" ? { providerId: record.providerId } : {}),
    ...(typeof record.modelId === "string" ? { modelId: record.modelId } : {}),
    ...(isNonNegativeInteger(record.parentRecordOrdinal) ? { parentRecordOrdinal: record.parentRecordOrdinal } : {}),
  });
}

export function validateStoreInventory(value: unknown): SanitizedCorpus["storeInventory"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SourceRecordContractError("store_inventory_invalid");
  }
  const record = value as Record<string, unknown>;
  const result: Record<string, Readonly<{ rowCount: number; identitySha256: string }>> = {};
  for (const [storeName, storeValue] of Object.entries(record)) {
    if (typeof storeValue !== "object" || storeValue === null || Array.isArray(storeValue)) {
      throw new SourceRecordContractError("store_inventory_invalid");
    }
    const storeRecord = storeValue as Record<string, unknown>;
    if (!isNonNegativeInteger(storeRecord.rowCount)) {
      throw new SourceRecordContractError("store_inventory_invalid");
    }
    if (typeof storeRecord.identitySha256 !== "string" || !/^[0-9a-f]{64}$/u.test(storeRecord.identitySha256)) {
      throw new SourceRecordContractError("store_inventory_invalid");
    }
    result[storeName] = deepFreeze({
      rowCount: storeRecord.rowCount,
      identitySha256: storeRecord.identitySha256,
    });
  }
  return deepFreeze(result);
}

export function validateSanitizedCorpus(value: unknown): SanitizedCorpus {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SourceRecordContractError("corpus_not_object");
  }
  const record = value as Record<string, unknown>;
  if (record.contractVersion !== SOURCE_RECORD_CONTRACT_VERSION) {
    throw new SourceRecordContractError("contract_version_mismatch");
  }
  if (typeof record.sourceSnapshotSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(record.sourceSnapshotSha256)) {
    throw new SourceRecordContractError("corpus_not_object");
  }
  if (typeof record.selectionSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(record.selectionSha256)) {
    throw new SourceRecordContractError("corpus_not_object");
  }
  if (typeof record.policySha256 !== "string" || !/^[0-9a-f]{64}$/u.test(record.policySha256)) {
    throw new SourceRecordContractError("corpus_not_object");
  }
  if (typeof record.querySha256 !== "string" || !/^[0-9a-f]{64}$/u.test(record.querySha256)) {
    throw new SourceRecordContractError("corpus_not_object");
  }
  if (typeof record.windowStartMs !== "number" || !Number.isInteger(record.windowStartMs)) {
    throw new SourceRecordContractError("corpus_not_object");
  }
  if (typeof record.windowEndMs !== "number" || !Number.isInteger(record.windowEndMs)) {
    throw new SourceRecordContractError("corpus_not_object");
  }
  if (record.windowEndMs < record.windowStartMs) {
    throw new SourceRecordContractError("window_inverted");
  }
  if (typeof record.excludedStartMs !== "number" || !Number.isInteger(record.excludedStartMs)) {
    throw new SourceRecordContractError("corpus_not_object");
  }
  if (typeof record.excludedEndMs !== "number" || !Number.isInteger(record.excludedEndMs)) {
    throw new SourceRecordContractError("corpus_not_object");
  }
  if (record.excludedEndMs < record.excludedStartMs) {
    throw new SourceRecordContractError("exclusion_inverted");
  }
  if (typeof record.timezone !== "string" || record.timezone.length === 0) {
    throw new SourceRecordContractError("corpus_not_object");
  }
  if (typeof record.upstreamTag !== "string" || record.upstreamTag.length === 0) {
    throw new SourceRecordContractError("corpus_not_object");
  }
  if (typeof record.upstreamCommit !== "string" || record.upstreamCommit.length === 0) {
    throw new SourceRecordContractError("corpus_not_object");
  }
  if (!Array.isArray(record.records)) {
    throw new SourceRecordContractError("records_not_array");
  }
  if (typeof record.limitation !== "string" || record.limitation.length === 0) {
    throw new SourceRecordContractError("limitation_empty");
  }
  const records = (record.records as unknown[]).map(validateSourceRecord);
  const storeInventory = validateStoreInventory(record.storeInventory);
  return deepFreeze({
    contractVersion: record.contractVersion,
    sourceSnapshotSha256: record.sourceSnapshotSha256,
    selectionSha256: record.selectionSha256,
    policySha256: record.policySha256,
    querySha256: record.querySha256,
    windowStartMs: record.windowStartMs,
    windowEndMs: record.windowEndMs,
    excludedStartMs: record.excludedStartMs,
    excludedEndMs: record.excludedEndMs,
    timezone: record.timezone,
    upstreamTag: record.upstreamTag,
    upstreamCommit: record.upstreamCommit,
    records,
    storeInventory,
    limitation: record.limitation,
  });
}

export function corpusIdentityHash(corpus: SanitizedCorpus): string {
  return canonicalHash({
    contractVersion: corpus.contractVersion,
    sourceSnapshotSha256: corpus.sourceSnapshotSha256,
    selectionSha256: corpus.selectionSha256,
    policySha256: corpus.policySha256,
    querySha256: corpus.querySha256,
    windowStartMs: corpus.windowStartMs,
    windowEndMs: corpus.windowEndMs,
    excludedStartMs: corpus.excludedStartMs,
    excludedEndMs: corpus.excludedEndMs,
    timezone: corpus.timezone,
    upstreamTag: corpus.upstreamTag,
    upstreamCommit: corpus.upstreamCommit,
    recordCount: corpus.records.length,
    storeInventory: corpus.storeInventory,
  });
}

export function recordIdentityHash(record: SourceRecord): string {
  return sha256(canonicalHash({
    rootOrdinal: record.rootOrdinal,
    recordOrdinal: record.recordOrdinal,
    provenance: record.provenance,
    orderKey: record.orderKey,
    sessionId: record.sessionId,
    rootId: record.rootId,
    turnRole: record.turnRole,
    eventTimestampMs: record.eventTimestampMs,
  }));
}

export function isTrustedRecord(record: SourceRecord): boolean {
  return (
    record.provenance.retained &&
    record.provenance.authenticatedSchemaPath &&
    (TRUSTED_PROVENANCE_KINDS as readonly string[]).includes(record.provenance.kind)
  );
}

export function parseCorpusJson(text: string): SanitizedCorpus {
  try {
    assertNoDuplicateJsonObjectKeys(text, "duplicate object key in corpus JSON", "corpus_not_object");
  } catch (error) {
    if (error instanceof Error && error.name === "InputError") {
      throw new SourceRecordContractError("corpus_not_object");
    }
    throw error;
  }
  return validateSanitizedCorpus(JSON.parse(text));
}
