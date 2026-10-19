/**
 * Synthetic fixture generators for the OpenCode evidence study analysis.
 *
 * Produces deterministic synthetic SanitizedCorpus instances with controlled
 * structure (provenance, timing, tool states, errors, compaction, model
 * switches) for analysis qualification. All content is synthetic; no real
 * OpenCode data, schema, or identifiers are used.
 *
 * This is research/verification code. No product runtime module may import it.
 */

import { deepFreeze, sha256 } from "../../../../src/kernel/integrity.ts";
import {
  SOURCE_RECORD_CONTRACT_VERSION,
  type Provenance,
  type ProvenanceKind,
  type SanitizedCorpus,
  type SourceMap,
  type SourceRecord,
  type ToolState,
  type TurnRole,
} from "./source-record-contract.ts";

export const SYNTHETIC_FIXTURE_MARKER = "generated-synthetic-only/v1" as const;
export const SYNTHETIC_WINDOW_START_MS = 1782014400000;
export const SYNTHETIC_WINDOW_END_MS = 1783655999999;
export const SYNTHETIC_EXCLUDED_START_MS = 1783468800000;
export const SYNTHETIC_EXCLUDED_END_MS = 1783555200000;
export const SYNTHETIC_TIMEZONE = "America/Toronto";
export const SYNTHETIC_UPSTREAM_TAG = "v1.17.18";
export const SYNTHETIC_UPSTREAM_COMMIT = "b1fc8113948b518835c2a39ece49553cffe9b30c";

export type FixtureSeed = Readonly<{
  rootCount: number;
  sessionsPerRoot: number;
  turnsPerSession: number;
  toolErrorRate: number;
  compactionRate: number;
  modelSwitchRate: number;
  hasFileEffects: boolean;
  hasCodeQualityIndicators: boolean;
  hasRegressionTests: boolean;
  providerId: string;
  modelId: string;
  rapidCorrection: boolean;
  toolLoop: boolean;
  contextLossRepeat: boolean;
}>;

export const DEFAULT_SEED: FixtureSeed = deepFreeze({
  rootCount: 2,
  sessionsPerRoot: 2,
  turnsPerSession: 4,
  toolErrorRate: 0.1,
  compactionRate: 0,
  modelSwitchRate: 0,
  hasFileEffects: true,
  hasCodeQualityIndicators: false,
  hasRegressionTests: false,
  providerId: "synthetic-provider",
  modelId: "synthetic-model",
  rapidCorrection: false,
  toolLoop: false,
  contextLossRepeat: false,
});

function makeSourceMap(pairs: ReadonlyArray<Readonly<{ key: string; value: unknown }>>): SourceMap {
  return deepFreeze({ pairs: pairs.map((p) => deepFreeze({ key: p.key, value: p.value as SourceMap["pairs"][number]["value"] })) });
}

function makeProvenance(kind: ProvenanceKind, authenticated: boolean): Provenance {
  return deepFreeze({ kind, authenticatedSchemaPath: authenticated, retained: true });
}

let fixtureRecordCounter = 0;

function nextRecordOrdinal(): number {
  fixtureRecordCounter += 1;
  return fixtureRecordCounter - 1;
}

function makeRecord(params: Readonly<{
  rootOrdinal: number;
  rootId: string;
  sessionId: string;
  turnRole: TurnRole;
  provenanceKind: ProvenanceKind;
  eventTimestampMs: number;
  orderKey: string;
  toolState?: ToolState;
  toolName?: string;
  hasError?: boolean;
  hasFileEffect?: boolean;
  isCompaction?: boolean;
  isModelSwitch?: boolean;
  isAgentSwitch?: boolean;
  providerId?: string;
  modelId?: string;
  payloadPairs?: ReadonlyArray<Readonly<{ key: string; value: unknown }>>;
}>): SourceRecord {
  const recordOrdinal = nextRecordOrdinal();
  const provenance = makeProvenance(params.provenanceKind, params.provenanceKind !== "untrusted");
  return deepFreeze({
    rootOrdinal: params.rootOrdinal,
    recordOrdinal,
    provenance,
    payload: makeSourceMap(params.payloadPairs ?? [{ key: "content", value: `synthetic-${recordOrdinal}` }]),
    orderKey: params.orderKey,
    sessionId: params.sessionId,
    rootId: params.rootId,
    turnRole: params.turnRole,
    eventTimestampMs: params.eventTimestampMs,
    ...(params.toolState !== undefined ? { toolState: params.toolState } : {}),
    ...(params.toolName !== undefined ? { toolName: params.toolName } : {}),
    ...(params.hasError !== undefined ? { hasError: params.hasError } : {}),
    ...(params.hasFileEffect !== undefined ? { hasFileEffect: params.hasFileEffect } : {}),
    ...(params.isCompaction !== undefined ? { isCompaction: params.isCompaction } : {}),
    ...(params.isModelSwitch !== undefined ? { isModelSwitch: params.isModelSwitch } : {}),
    ...(params.isAgentSwitch !== undefined ? { isAgentSwitch: params.isAgentSwitch } : {}),
    ...(params.providerId !== undefined ? { providerId: params.providerId } : {}),
    ...(params.modelId !== undefined ? { modelId: params.modelId } : {}),
  });
}

export function resetFixtureCounter(): void {
  fixtureRecordCounter = 0;
}

export function generateSyntheticCorpus(seed: Partial<FixtureSeed> = {}): SanitizedCorpus {
  resetFixtureCounter();
  const s: FixtureSeed = { ...DEFAULT_SEED, ...seed };
  const records: SourceRecord[] = [];
  const sessionIds = new Set<string>();
  const rootIds = new Set<string>();
  const baseTime = SYNTHETIC_WINDOW_START_MS + 86_400_000;
  const turnGapMs = 120_000;
  const withinTurnGapMs = 5_000;

  for (let rootIndex = 0; rootIndex < s.rootCount; rootIndex += 1) {
    const rootId = `synthetic-root-${rootIndex}`;
    rootIds.add(rootId);
    for (let sessionIndex = 0; sessionIndex < s.sessionsPerRoot; sessionIndex += 1) {
      const sessionId = `${rootId}-session-${sessionIndex}`;
      sessionIds.add(sessionId);
      let currentTime = baseTime + rootIndex * 7_200_000 + sessionIndex * 1_800_000;
      for (let turnIndex = 0; turnIndex < s.turnsPerSession; turnIndex += 1) {
        const userGap = s.rapidCorrection ? 10_000 : turnGapMs;
        records.push(makeRecord({
          rootOrdinal: rootIndex,
          rootId,
          sessionId,
          turnRole: "user",
          provenanceKind: "user",
          eventTimestampMs: currentTime,
          orderKey: `${rootIndex}:${sessionId}:${turnIndex}:user`,
          payloadPairs: [{ key: "content", value: `user-turn-${turnIndex}` }],
        }));
        currentTime += withinTurnGapMs;
        const hasAssistant = s.modelSwitchRate > 0 && turnIndex === Math.floor(s.turnsPerSession / 2) && turnIndex > 0;
        if (hasAssistant) {
          records.push(makeRecord({
            rootOrdinal: rootIndex,
            rootId,
            sessionId,
            turnRole: "control",
            provenanceKind: "system",
            eventTimestampMs: currentTime,
            orderKey: `${rootIndex}:${sessionId}:${turnIndex}:model-switch`,
            isModelSwitch: true,
            payloadPairs: [{ key: "event", value: "model_switched" }],
          }));
          currentTime += withinTurnGapMs;
        }
        const assistantPayloadPairs: ReadonlyArray<Readonly<{ key: string; value: unknown }>> = [
          { key: "content", value: `assistant-turn-${turnIndex}` },
          ...(s.hasCodeQualityIndicators ? [{ key: "qualityIndicator", value: "dead_code_evidence" }] : []),
          ...(s.hasRegressionTests ? [{ key: "regressionTestAdded", value: true }] : []),
        ];
        records.push(makeRecord({
          rootOrdinal: rootIndex,
          rootId,
          sessionId,
          turnRole: "assistant",
          provenanceKind: "assistant",
          eventTimestampMs: currentTime,
          orderKey: `${rootIndex}:${sessionId}:${turnIndex}:assistant`,
          providerId: s.providerId,
          modelId: s.modelId,
          payloadPairs: assistantPayloadPairs,
        }));
        currentTime += withinTurnGapMs;
        const hasError = s.toolErrorRate > 0 && (turnIndex % Math.max(1, Math.round(1 / s.toolErrorRate)) === 0);
        if (s.hasFileEffects || hasError) {
          const toolRepeatCount = s.toolLoop && turnIndex === 0 ? 3 : 1;
          for (let toolRepeat = 0; toolRepeat < toolRepeatCount; toolRepeat += 1) {
            records.push(makeRecord({
              rootOrdinal: rootIndex,
              rootId,
              sessionId,
              turnRole: "tool",
              provenanceKind: "tool_sink",
              eventTimestampMs: currentTime,
              orderKey: `${rootIndex}:${sessionId}:${turnIndex}:tool-call:${toolRepeat}`,
              toolName: "synthetic-edit-tool",
              toolState: "pending",
              payloadPairs: [
                { key: "tool", value: "synthetic-edit-tool" },
                { key: "input", value: `synthetic-input-${turnIndex}-${toolRepeat}` },
              ],
            }));
            currentTime += withinTurnGapMs;
            const toolHasError = hasError && toolRepeat === 0;
            records.push(makeRecord({
              rootOrdinal: rootIndex,
              rootId,
              sessionId,
              turnRole: "tool",
              provenanceKind: "tool_output",
              eventTimestampMs: currentTime,
              orderKey: `${rootIndex}:${sessionId}:${turnIndex}:tool-result:${toolRepeat}`,
              toolName: "synthetic-edit-tool",
              toolState: toolHasError ? "error" : "completed",
              hasError: toolHasError,
              hasFileEffect: s.hasFileEffects && !toolHasError,
              payloadPairs: [
                { key: "result", value: toolHasError ? "error" : "ok" },
                ...(s.hasFileEffects && !toolHasError ? [{ key: "diff", value: `diff-${turnIndex}-${toolRepeat}` }] : []),
              ],
            }));
            currentTime += withinTurnGapMs;
          }
        }
        if (s.compactionRate > 0 && turnIndex === Math.floor(s.turnsPerSession / 2) && turnIndex > 0) {
          records.push(makeRecord({
            rootOrdinal: rootIndex,
            rootId,
            sessionId,
            turnRole: "control",
            provenanceKind: "system",
            eventTimestampMs: currentTime,
            orderKey: `${rootIndex}:${sessionId}:${turnIndex}:compaction`,
            isCompaction: true,
            payloadPairs: [{ key: "event", value: "compaction" }],
          }));
          currentTime += withinTurnGapMs;
        }
        currentTime += userGap;
      }
    }
  }

  if (s.contextLossRepeat) {
    const firstRecord = records[0];
    if (firstRecord) {
      const compactionIndex = records.findIndex((r) => r.isCompaction === true);
      if (compactionIndex >= 0) {
        const compaction = records[compactionIndex]!;
        records.push(makeRecord({
          rootOrdinal: compaction.rootOrdinal,
          rootId: compaction.rootId,
          sessionId: compaction.sessionId,
          turnRole: "tool",
          provenanceKind: "tool_sink",
          eventTimestampMs: compaction.eventTimestampMs + withinTurnGapMs,
          orderKey: `${compaction.rootOrdinal}:${compaction.sessionId}:post-compaction-repeat`,
          toolName: "synthetic-edit-tool",
          toolState: "pending",
          payloadPairs: [{ key: "tool", value: "synthetic-edit-tool" }],
        }));
      }
    }
  }

  const storeInventory = deepFreeze({
    session: { rowCount: rootIds.size * s.sessionsPerRoot, identitySha256: sha256(`session:${records.length}`) },
    message: { rowCount: records.filter((r) => r.turnRole === "user" || r.turnRole === "assistant").length, identitySha256: sha256(`message:${records.length}`) },
    part: { rowCount: records.filter((r) => r.turnRole === "tool").length, identitySha256: sha256(`part:${records.length}`) },
    session_message: { rowCount: records.filter((r) => r.turnRole === "user" || r.turnRole === "assistant").length, identitySha256: sha256(`session_message:${records.length}`) },
    session_input: { rowCount: 0, identitySha256: sha256("session_input:0") },
    session_context_epoch: { rowCount: 0, identitySha256: sha256("session_context_epoch:0") },
  });

  return deepFreeze({
    contractVersion: SOURCE_RECORD_CONTRACT_VERSION,
    sourceSnapshotSha256: sha256(`snapshot:${SYNTHETIC_FIXTURE_MARKER}:${records.length}`),
    selectionSha256: sha256(`selection:${records.length}`),
    policySha256: sha256(`policy:${s.providerId}:${s.modelId}`),
    querySha256: sha256(`query:${SYNTHETIC_UPSTREAM_COMMIT}`),
    windowStartMs: SYNTHETIC_WINDOW_START_MS,
    windowEndMs: SYNTHETIC_WINDOW_END_MS,
    excludedStartMs: SYNTHETIC_EXCLUDED_START_MS,
    excludedEndMs: SYNTHETIC_EXCLUDED_END_MS,
    timezone: SYNTHETIC_TIMEZONE,
    upstreamTag: SYNTHETIC_UPSTREAM_TAG,
    upstreamCommit: SYNTHETIC_UPSTREAM_COMMIT,
    records: deepFreeze(records),
    storeInventory,
    limitation: "synthetic-only: no real OpenCode data; SEC-001 open-blocking",
  });
}

export function generateEmptyCorpus(): SanitizedCorpus {
  return deepFreeze({
    contractVersion: SOURCE_RECORD_CONTRACT_VERSION,
    sourceSnapshotSha256: sha256(`empty:${SYNTHETIC_FIXTURE_MARKER}`),
    selectionSha256: sha256("empty-selection"),
    policySha256: sha256("empty-policy"),
    querySha256: sha256("empty-query"),
    windowStartMs: SYNTHETIC_WINDOW_START_MS,
    windowEndMs: SYNTHETIC_WINDOW_END_MS,
    excludedStartMs: SYNTHETIC_EXCLUDED_START_MS,
    excludedEndMs: SYNTHETIC_EXCLUDED_END_MS,
    timezone: SYNTHETIC_TIMEZONE,
    upstreamTag: SYNTHETIC_UPSTREAM_TAG,
    upstreamCommit: SYNTHETIC_UPSTREAM_COMMIT,
    records: deepFreeze([]),
    storeInventory: deepFreeze({
      session: { rowCount: 0, identitySha256: sha256("session:0") },
      message: { rowCount: 0, identitySha256: sha256("message:0") },
      part: { rowCount: 0, identitySha256: sha256("part:0") },
      session_message: { rowCount: 0, identitySha256: sha256("session_message:0") },
      session_input: { rowCount: 0, identitySha256: sha256("session_input:0") },
      session_context_epoch: { rowCount: 0, identitySha256: sha256("session_context_epoch:0") },
    }),
    limitation: "empty-synthetic-corpus",
  });
}

export function generateCorpusWithExclusionRecords(): SanitizedCorpus {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 2 });
  const records = [...corpus.records];
  const exclusionTime = SYNTHETIC_EXCLUDED_START_MS + 3600_000;
  const lastRoot = records[records.length - 1] ?? null;
  if (lastRoot) {
    records.push(makeRecord({
      rootOrdinal: lastRoot.rootOrdinal,
      rootId: lastRoot.rootId,
      sessionId: lastRoot.sessionId,
      turnRole: "user",
      provenanceKind: "user",
      eventTimestampMs: exclusionTime,
      orderKey: `${lastRoot.rootOrdinal}:${lastRoot.sessionId}:exclusion`,
      payloadPairs: [{ key: "content", value: "exclusion-window-record" }],
    }));
  }
  return deepFreeze({ ...corpus, records: deepFreeze(records) });
}

export function generateCorpusWithPostCutoffRecords(): SanitizedCorpus {
  const corpus = generateSyntheticCorpus({ rootCount: 1, sessionsPerRoot: 1, turnsPerSession: 2 });
  const records = [...corpus.records];
  const postCutoffTime = SYNTHETIC_WINDOW_END_MS + 86_400_000;
  const lastRoot = records[records.length - 1] ?? null;
  if (lastRoot) {
    records.push(makeRecord({
      rootOrdinal: lastRoot.rootOrdinal,
      rootId: lastRoot.rootId,
      sessionId: lastRoot.sessionId,
      turnRole: "assistant",
      provenanceKind: "assistant",
      eventTimestampMs: postCutoffTime,
      orderKey: `${lastRoot.rootOrdinal}:${lastRoot.sessionId}:post-cutoff`,
      providerId: "synthetic-provider",
      modelId: "synthetic-model",
      payloadPairs: [{ key: "content", value: "post-cutoff-record" }],
    }));
  }
  return deepFreeze({ ...corpus, records: deepFreeze(records) });
}

export function generateMultiCohortCorpus(): SanitizedCorpus {
  const corpus = generateSyntheticCorpus({ rootCount: 2, sessionsPerRoot: 1, turnsPerSession: 3 });
  const records = [...corpus.records];
  const assistantRecords = records.filter((r) => r.turnRole === "assistant");
  for (let index = 0; index < assistantRecords.length; index += 1) {
    const record = assistantRecords[index]!;
    if (index % 2 === 0) continue;
    const replacementIndex = records.indexOf(record);
    if (replacementIndex < 0) continue;
    records[replacementIndex] = deepFreeze({
      ...record,
      providerId: "alternative-provider",
      modelId: "alternative-model",
    });
  }
  return deepFreeze({ ...corpus, records: deepFreeze(records) });
}

export function generateMalformedCorpus(overwrite: Readonly<Record<string, unknown>>): unknown {
  const corpus = generateSyntheticCorpus();
  return { ...corpus, ...overwrite };
}
