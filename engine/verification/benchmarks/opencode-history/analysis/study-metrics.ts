/**
 * Study metrics engine for the OpenCode evidence study.
 *
 * Consumes a validated SanitizedCorpus and computes the metrics required by
 * the canonical OpenCode evidence study requirements (REQ-012, REQ-014,
 * REQ-031): coverage denominators, steering dynamics, friction patterns, code
 * quality indicators, and alignment trajectory. All computation is
 * deterministic and hashable for reproducibility.
 *
 * This is research/verification code. No product runtime module may import it.
 */

import { canonicalHash, deepFreeze } from "../../../../src/kernel/integrity.ts";
import {
  ANALYSIS_CONTRACT_VERSION,
  type ProvenanceKind,
  type SanitizedCorpus,
  type SourceRecord,
} from "./source-record-contract.ts";

export type CoverageDenominators = Readonly<{
  roots: number;
  sessions: number;
  totalRecords: number;
  userRecords: number;
  assistantRecords: number;
  systemRecords: number;
  toolSinkRecords: number;
  toolOutputRecords: number;
  untrustedRecords: number;
  toolCalls: number;
  toolResults: number;
  toolErrors: number;
  fileEffects: number;
  compactions: number;
  modelSwitches: number;
  agentSwitches: number;
  unavailable: number;
  truncated: number;
}>;

export type SteeringEventKind =
  | "user_correction"
  | "user_addendum"
  | "constraint_restatement"
  | "escalation";

export type SteeringEvent = Readonly<{
  kind: SteeringEventKind;
  sessionOrderIndex: number;
  triggeringRecordOrdinal: number | null;
  userRecordOrdinal: number;
  eventTimestampMs: number;
  rootId: string;
  sessionId: string;
}>;

export type SteeringDynamics = Readonly<{
  totalEvents: number;
  corrections: number;
  addenda: number;
  constraintRestatements: number;
  escalations: number;
  events: readonly SteeringEvent[];
  perRoot: Readonly<Record<string, number>>;
  perSession: Readonly<Record<string, number>>;
}>;

export type FrictionKind =
  | "tool_failure"
  | "tool_retry"
  | "edit_no_op"
  | "edit_partial"
  | "edit_over_replacement"
  | "tool_loop"
  | "context_loss_repeat"
  | "repeated_error";

export type FrictionIncident = Readonly<{
  kind: FrictionKind;
  sessionOrderIndex: number;
  recordOrdinal: number;
  eventTimestampMs: number;
  rootId: string;
  sessionId: string;
  toolName: string | null;
  detail: string;
}>;

export type FrictionInventory = Readonly<{
  totalIncidents: number;
  byKind: Readonly<Record<FrictionKind, number>>;
  incidents: readonly FrictionIncident[];
  perRoot: Readonly<Record<string, number>>;
  perSession: Readonly<Record<string, number>>;
}>;

export type CodeQualityIndicatorKind =
  | "dead_code_evidence"
  | "unused_export_evidence"
  | "unreachable_construct_evidence"
  | "cyclic_dependency_evidence"
  | "missing_regression_test_evidence"
  | "over_engineering_indicator"
  | "under_engineering_indicator";

export type CodeQualityAssessment = Readonly<{
  totalIndicators: number;
  byKind: Readonly<Record<CodeQualityIndicatorKind, number>>;
  perRoot: Readonly<Record<string, number>>;
  hasRegressionTestEvidence: boolean;
}>;

export type AlignmentCheckpointKind =
  | "divergence"
  | "recovery"
  | "constraint_retained"
  | "constraint_lost";

export type AlignmentCheckpoint = Readonly<{
  kind: AlignmentCheckpointKind;
  sessionOrderIndex: number;
  recordOrdinal: number;
  eventTimestampMs: number;
  rootId: string;
  sessionId: string;
  description: string;
}>;

export type AlignmentTrajectory = Readonly<{
  totalCheckpoints: number;
  divergences: number;
  recoveries: number;
  constraintsRetained: number;
  constraintsLost: number;
  checkpoints: readonly AlignmentCheckpoint[];
  divergenceRate: number;
  recoveryRate: number;
}>;

export type InteractionPatternKind =
  | "rapid_correction"
  | "long_monologue"
  | "tool_heavy"
  | "error_heavy"
  | "compaction_recovery";

export type InteractionPattern = Readonly<{
  kind: InteractionPatternKind;
  rootId: string;
  sessionId: string;
  sessionOrderIndex: number;
  metric: number;
}>;

export type InteractionSummary = Readonly<{
  totalSessions: number;
  patterns: readonly InteractionPattern[];
  byKind: Readonly<Record<InteractionPatternKind, number>>;
  medianTurnsPerSession: number;
  maxTurnsPerSession: number;
  minTurnsPerSession: number;
}>;

export type StudyMetrics = Readonly<{
  analysisContractVersion: string;
  coverage: CoverageDenominators;
  steering: SteeringDynamics;
  friction: FrictionInventory;
  codeQuality: CodeQualityAssessment;
  alignment: AlignmentTrajectory;
  interaction: InteractionSummary;
  metricsHash: string;
}>;

export const EMPTY_FRICTION_BY_KIND = deepFreeze({
  tool_failure: 0,
  tool_retry: 0,
  edit_no_op: 0,
  edit_partial: 0,
  edit_over_replacement: 0,
  tool_loop: 0,
  context_loss_repeat: 0,
  repeated_error: 0,
} as Readonly<Record<FrictionKind, number>>);

export const EMPTY_CODE_QUALITY_BY_KIND = deepFreeze({
  dead_code_evidence: 0,
  unused_export_evidence: 0,
  unreachable_construct_evidence: 0,
  cyclic_dependency_evidence: 0,
  missing_regression_test_evidence: 0,
  over_engineering_indicator: 0,
  under_engineering_indicator: 0,
} as Readonly<Record<CodeQualityIndicatorKind, number>>);

export const EMPTY_INTERACTION_BY_KIND = deepFreeze({
  rapid_correction: 0,
  long_monologue: 0,
  tool_heavy: 0,
  error_heavy: 0,
  compaction_recovery: 0,
} as Readonly<Record<InteractionPatternKind, number>>);

function countByRoot(records: readonly { rootId: string }[]): Readonly<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const record of records) {
    result[record.rootId] = (result[record.rootId] ?? 0) + 1;
  }
  return deepFreeze(result);
}

function countBySession(records: readonly { sessionId: string }[]): Readonly<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const record of records) {
    result[record.sessionId] = (result[record.sessionId] ?? 0) + 1;
  }
  return deepFreeze(result);
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export function computeCoverage(corpus: SanitizedCorpus): CoverageDenominators {
  const rootIds = new Set<string>();
  const sessionIds = new Set<string>();
  const counts: Record<ProvenanceKind, number> = {
    user: 0,
    system: 0,
    tool_sink: 0,
    assistant: 0,
    tool_output: 0,
    untrusted: 0,
  };
  let toolCalls = 0;
  let toolResults = 0;
  let toolErrors = 0;
  let fileEffects = 0;
  let compactions = 0;
  let modelSwitches = 0;
  let agentSwitches = 0;
  let unavailable = 0;
  let truncated = 0;

  for (const record of corpus.records) {
    rootIds.add(record.rootId);
    sessionIds.add(record.sessionId);
    counts[record.provenance.kind] += 1;
    if (record.provenance.kind === "tool_sink") toolCalls += 1;
    if (record.provenance.kind === "tool_output") toolResults += 1;
    if (record.hasError === true) toolErrors += 1;
    if (record.hasFileEffect === true) fileEffects += 1;
    if (record.isCompaction === true) compactions += 1;
    if (record.isModelSwitch === true) modelSwitches += 1;
    if (record.isAgentSwitch === true) agentSwitches += 1;
    if (record.toolState === "pending" && record.provenance.kind === "tool_output") unavailable += 1;
    if (record.provenance.kind === "tool_output" && record.toolState === "running") truncated += 1;
  }

  return deepFreeze({
    roots: rootIds.size,
    sessions: sessionIds.size,
    totalRecords: corpus.records.length,
    userRecords: counts.user,
    assistantRecords: counts.assistant,
    systemRecords: counts.system,
    toolSinkRecords: counts.tool_sink,
    toolOutputRecords: counts.tool_output,
    untrustedRecords: counts.untrusted,
    toolCalls,
    toolResults,
    toolErrors,
    fileEffects,
    compactions,
    modelSwitches,
    agentSwitches,
    unavailable,
    truncated,
  });
}

interface SessionTurn {
  readonly records: readonly SourceRecord[];
  readonly orderIndex: number;
  readonly userRecords: readonly SourceRecord[];
  readonly assistantRecords: readonly SourceRecord[];
  readonly toolRecords: readonly SourceRecord[];
}

function groupBySessionOrdered(corpus: SanitizedCorpus): ReadonlyMap<string, SessionTurn> {
  const bySession = new Map<string, SourceRecord[]>();
  for (const record of corpus.records) {
    const list = bySession.get(record.sessionId) ?? [];
    list.push(record);
    bySession.set(record.sessionId, list);
  }
  const result = new Map<string, SessionTurn>();
  let orderIndex = 0;
  const sortedSessions = [...bySession.entries()].sort((a, b) => {
    const aMin = Math.min(...a[1].map((r) => r.eventTimestampMs));
    const bMin = Math.min(...b[1].map((r) => r.eventTimestampMs));
    return aMin - bMin;
  });
  for (const [sessionId, records] of sortedSessions) {
    const sorted = [...records].sort((a, b) => a.recordOrdinal - b.recordOrdinal);
    result.set(sessionId, deepFreeze({
      records: sorted,
      orderIndex,
      userRecords: sorted.filter((r) => r.turnRole === "user"),
      assistantRecords: sorted.filter((r) => r.turnRole === "assistant"),
      toolRecords: sorted.filter((r) => r.turnRole === "tool"),
    }));
    orderIndex += 1;
  }
  return result;
}

export function computeSteering(corpus: SanitizedCorpus): SteeringDynamics {
  const sessions = groupBySessionOrdered(corpus);
  const events: SteeringEvent[] = [];

  for (const [sessionId, turn] of sessions) {
    const userRecords = turn.userRecords;
    for (let index = 1; index < userRecords.length; index += 1) {
      const current = userRecords[index]!;
      const previous = userRecords[index - 1]!;
      const gapMs = current.eventTimestampMs - previous.eventTimestampMs;
      const hasInterveningAssistant = turn.records.some(
        (r) =>
          r.turnRole === "assistant" &&
          r.recordOrdinal > previous.recordOrdinal &&
          r.recordOrdinal < current.recordOrdinal,
      );
      if (!hasInterveningAssistant) continue;
      let kind: SteeringEventKind;
      if (gapMs < 60_000) {
        kind = "user_correction";
      } else if (gapMs < 300_000) {
        kind = "user_addendum";
      } else if (gapMs > 3_600_000) {
        kind = "escalation";
      } else {
        kind = "user_addendum";
      }
      const triggeringRecord = turn.records.find(
        (r) => r.turnRole === "assistant" && r.recordOrdinal < current.recordOrdinal && r.recordOrdinal > previous.recordOrdinal,
      );
      events.push(deepFreeze({
        kind,
        sessionOrderIndex: turn.orderIndex,
        triggeringRecordOrdinal: triggeringRecord?.recordOrdinal ?? null,
        userRecordOrdinal: current.recordOrdinal,
        eventTimestampMs: current.eventTimestampMs,
        rootId: current.rootId,
        sessionId,
      }));
    }
  }

  const corrections = events.filter((e) => e.kind === "user_correction").length;
  const addenda = events.filter((e) => e.kind === "user_addendum").length;
  const constraintRestatements = events.filter((e) => e.kind === "constraint_restatement").length;
  const escalations = events.filter((e) => e.kind === "escalation").length;

  return deepFreeze({
    totalEvents: events.length,
    corrections,
    addenda,
    constraintRestatements,
    escalations,
    events,
    perRoot: countByRoot(events),
    perSession: countBySession(events),
  });
}

export function computeFriction(corpus: SanitizedCorpus): FrictionInventory {
  const sessions = groupBySessionOrdered(corpus);
  const incidents: FrictionIncident[] = [];

  for (const [sessionId, turn] of sessions) {
    const records = turn.records;
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index]!;
      if (record.hasError === true && record.provenance.kind === "tool_output") {
        incidents.push(deepFreeze({
          kind: "tool_failure",
          sessionOrderIndex: turn.orderIndex,
          recordOrdinal: record.recordOrdinal,
          eventTimestampMs: record.eventTimestampMs,
          rootId: record.rootId,
          sessionId,
          toolName: record.toolName ?? null,
          detail: `tool_error:${record.toolName ?? "unknown"}`,
        }));
      }
      if (record.provenance.kind === "tool_sink" && record.toolName) {
        const nextSameTool = records
          .slice(index + 1)
          .find((r) => r.provenance.kind === "tool_sink" && r.toolName === record.toolName);
        if (nextSameTool) {
          const interveningError = records
            .slice(index + 1, records.indexOf(nextSameTool))
            .some((r) => r.hasError === true);
          if (interveningError) {
            incidents.push(deepFreeze({
              kind: "tool_retry",
              sessionOrderIndex: turn.orderIndex,
              recordOrdinal: nextSameTool.recordOrdinal,
              eventTimestampMs: nextSameTool.eventTimestampMs,
              rootId: nextSameTool.rootId,
              sessionId,
              toolName: record.toolName,
              detail: `retry_after_error:${record.toolName}`,
            }));
          }
        }
        const sameToolCount = records.filter(
          (r) => r.provenance.kind === "tool_sink" && r.toolName === record.toolName,
        ).length;
        if (sameToolCount >= 3) {
          const alreadyLooped = incidents.some(
            (i) => i.kind === "tool_loop" && i.sessionId === sessionId && i.toolName === record.toolName,
          );
          if (!alreadyLooped) {
            incidents.push(deepFreeze({
              kind: "tool_loop",
              sessionOrderIndex: turn.orderIndex,
              recordOrdinal: record.recordOrdinal,
              eventTimestampMs: record.eventTimestampMs,
              rootId: record.rootId,
              sessionId,
              toolName: record.toolName,
              detail: `loop:${record.toolName}:${sameToolCount}`,
            }));
          }
        }
      }
    }
    const compactions = records.filter((r) => r.isCompaction === true);
    for (const compaction of compactions) {
      const postCompaction = records.filter((r) => r.recordOrdinal > compaction.recordOrdinal);
      const preCompactionTools = new Set(
        records
          .filter((r) => r.recordOrdinal < compaction.recordOrdinal && r.provenance.kind === "tool_sink" && r.toolName)
          .map((r) => r.toolName!),
      );
      const repeatedTools = postCompaction.filter(
        (r) => r.provenance.kind === "tool_sink" && r.toolName && preCompactionTools.has(r.toolName),
      );
      if (repeatedTools.length > 0) {
        incidents.push(deepFreeze({
          kind: "context_loss_repeat",
          sessionOrderIndex: turn.orderIndex,
          recordOrdinal: compaction.recordOrdinal,
          eventTimestampMs: compaction.eventTimestampMs,
          rootId: compaction.rootId,
          sessionId,
          toolName: null,
          detail: `post_compaction_repeat:${repeatedTools.length}`,
        }));
      }
    }
    const errorKinds = new Map<string, number>();
    for (const record of records) {
      if (record.hasError === true) {
        const key = record.toolName ?? "unknown";
        errorKinds.set(key, (errorKinds.get(key) ?? 0) + 1);
      }
    }
    for (const [toolName, count] of errorKinds) {
      if (count >= 2) {
        incidents.push(deepFreeze({
          kind: "repeated_error",
          sessionOrderIndex: turn.orderIndex,
          recordOrdinal: records.find((r) => r.hasError === true && (r.toolName ?? "unknown") === toolName)!.recordOrdinal,
          eventTimestampMs: records.find((r) => r.hasError === true && (r.toolName ?? "unknown") === toolName)!.eventTimestampMs,
          rootId: records[0]!.rootId,
          sessionId,
          toolName,
          detail: `repeated_error:${toolName}:${count}`,
        }));
      }
    }
  }

  const byKind: Record<FrictionKind, number> = { ...EMPTY_FRICTION_BY_KIND };
  for (const incident of incidents) {
    byKind[incident.kind] += 1;
  }

  return deepFreeze({
    totalIncidents: incidents.length,
    byKind: deepFreeze(byKind),
    incidents,
    perRoot: countByRoot(incidents),
    perSession: countBySession(incidents),
  });
}

export function computeCodeQuality(corpus: SanitizedCorpus): CodeQualityAssessment {
  const rootCounts: Record<string, number> = {};
  const byKind: Record<CodeQualityIndicatorKind, number> = { ...EMPTY_CODE_QUALITY_BY_KIND };
  let hasRegressionTestEvidence = false;

  for (const record of corpus.records) {
    for (const pair of record.payload.pairs) {
      if (pair.key === "qualityIndicator" && typeof pair.value === "string") {
        const indicator = pair.value as CodeQualityIndicatorKind;
        if (indicator in byKind) {
          byKind[indicator] += 1;
          rootCounts[record.rootId] = (rootCounts[record.rootId] ?? 0) + 1;
        }
      }
      if (pair.key === "regressionTestAdded" && pair.value === true) {
        hasRegressionTestEvidence = true;
      }
    }
  }

  const totalIndicators = Object.values(byKind).reduce((a, b) => a + b, 0);
  return deepFreeze({
    totalIndicators,
    byKind: deepFreeze(byKind),
    perRoot: deepFreeze(rootCounts),
    hasRegressionTestEvidence,
  });
}

export function computeAlignment(corpus: SanitizedCorpus): AlignmentTrajectory {
  const sessions = groupBySessionOrdered(corpus);
  const checkpoints: AlignmentCheckpoint[] = [];

  for (const [sessionId, turn] of sessions) {
    const records = turn.records;
    const userRecords = turn.userRecords;
    for (let index = 1; index < userRecords.length; index += 1) {
      const current = userRecords[index]!;
      const previous = userRecords[index - 1]!;
      const gapMs = current.eventTimestampMs - previous.eventTimestampMs;
      const hasInterveningAssistant = records.some(
        (r) => r.turnRole === "assistant" && r.recordOrdinal > previous.recordOrdinal && r.recordOrdinal < current.recordOrdinal,
      );
      if (!hasInterveningAssistant) continue;
      if (gapMs < 60_000) {
        checkpoints.push(deepFreeze({
          kind: "divergence",
          sessionOrderIndex: turn.orderIndex,
          recordOrdinal: current.recordOrdinal,
          eventTimestampMs: current.eventTimestampMs,
          rootId: current.rootId,
          sessionId,
          description: `rapid_correction_after_assistant:${gapMs}ms`,
        }));
      }
    }
    const compactions = records.filter((r) => r.isCompaction === true);
    for (const compaction of compactions) {
      const postCompactionUser = records.filter(
        (r) => r.turnRole === "user" && r.recordOrdinal > compaction.recordOrdinal,
      );
      if (postCompactionUser.length > 0) {
        checkpoints.push(deepFreeze({
          kind: "constraint_lost",
          sessionOrderIndex: turn.orderIndex,
          recordOrdinal: compaction.recordOrdinal,
          eventTimestampMs: compaction.eventTimestampMs,
          rootId: compaction.rootId,
          sessionId,
          description: "compaction_constraint_loss_candidate",
        }));
      } else {
        checkpoints.push(deepFreeze({
          kind: "constraint_retained",
          sessionOrderIndex: turn.orderIndex,
          recordOrdinal: compaction.recordOrdinal,
          eventTimestampMs: compaction.eventTimestampMs,
          rootId: compaction.rootId,
          sessionId,
          description: "compaction_without_followup",
        }));
      }
    }
    const errorRecords = records.filter((r) => r.hasError === true);
    const lastError = errorRecords.length > 0 ? errorRecords[errorRecords.length - 1]! : null;
    if (lastError) {
      const postError = records.filter((r) => r.recordOrdinal > lastError.recordOrdinal && r.turnRole === "assistant");
      if (postError.length > 0 && !postError.some((r) => r.hasError === true)) {
        checkpoints.push(deepFreeze({
          kind: "recovery",
          sessionOrderIndex: turn.orderIndex,
          recordOrdinal: postError[0]!.recordOrdinal,
          eventTimestampMs: postError[0]!.eventTimestampMs,
          rootId: postError[0]!.rootId,
          sessionId,
          description: "post_error_clean_assistant",
        }));
      }
    }
  }

  const divergences = checkpoints.filter((c) => c.kind === "divergence").length;
  const recoveries = checkpoints.filter((c) => c.kind === "recovery").length;
  const constraintsRetained = checkpoints.filter((c) => c.kind === "constraint_retained").length;
  const constraintsLost = checkpoints.filter((c) => c.kind === "constraint_lost").length;
  const total = checkpoints.length;
  const divergenceRate = total > 0 ? divergences / total : 0;
  const recoveryRate = divergences > 0 ? recoveries / divergences : 0;

  return deepFreeze({
    totalCheckpoints: total,
    divergences,
    recoveries,
    constraintsRetained,
    constraintsLost,
    checkpoints,
    divergenceRate,
    recoveryRate,
  });
}

export function computeInteraction(corpus: SanitizedCorpus): InteractionSummary {
  const sessions = groupBySessionOrdered(corpus);
  const patterns: InteractionPattern[] = [];
  const turnCounts: number[] = [];
  const byKind: Record<InteractionPatternKind, number> = { ...EMPTY_INTERACTION_BY_KIND };

  for (const [sessionId, turn] of sessions) {
    const records = turn.records;
    const userCount = turn.userRecords.length;
    const toolCount = turn.toolRecords.length;
    const errorCount = records.filter((r) => r.hasError === true).length;
    const compactionCount = records.filter((r) => r.isCompaction === true).length;
    turnCounts.push(userCount);

    if (userCount >= 2) {
      const firstTwo = [turn.userRecords[0]!, turn.userRecords[1]!];
      const gap = firstTwo[1]!.eventTimestampMs - firstTwo[0]!.eventTimestampMs;
      if (gap < 60_000) {
        patterns.push(deepFreeze({
          kind: "rapid_correction",
          rootId: records[0]!.rootId,
          sessionId,
          sessionOrderIndex: turn.orderIndex,
          metric: gap,
        }));
        byKind.rapid_correction += 1;
      }
    }
    if (userCount === 0 && records.length > 10) {
      patterns.push(deepFreeze({
        kind: "long_monologue",
        rootId: records[0]!.rootId,
        sessionId,
        sessionOrderIndex: turn.orderIndex,
        metric: records.length,
      }));
      byKind.long_monologue += 1;
    }
    if (toolCount > 0 && toolCount / records.length > 0.5) {
      patterns.push(deepFreeze({
        kind: "tool_heavy",
        rootId: records[0]!.rootId,
        sessionId,
        sessionOrderIndex: turn.orderIndex,
        metric: toolCount / records.length,
      }));
      byKind.tool_heavy += 1;
    }
    if (errorCount > 0 && errorCount / records.length > 0.2) {
      patterns.push(deepFreeze({
        kind: "error_heavy",
        rootId: records[0]!.rootId,
        sessionId,
        sessionOrderIndex: turn.orderIndex,
        metric: errorCount / records.length,
      }));
      byKind.error_heavy += 1;
    }
    if (compactionCount > 0) {
      patterns.push(deepFreeze({
        kind: "compaction_recovery",
        rootId: records[0]!.rootId,
        sessionId,
        sessionOrderIndex: turn.orderIndex,
        metric: compactionCount,
      }));
      byKind.compaction_recovery += 1;
    }
  }

  return deepFreeze({
    totalSessions: sessions.size,
    patterns,
    byKind: deepFreeze(byKind),
    medianTurnsPerSession: median(turnCounts),
    maxTurnsPerSession: turnCounts.length > 0 ? Math.max(...turnCounts) : 0,
    minTurnsPerSession: turnCounts.length > 0 ? Math.min(...turnCounts) : 0,
  });
}

export function computeStudyMetrics(corpus: SanitizedCorpus): StudyMetrics {
  const coverage = computeCoverage(corpus);
  const steering = computeSteering(corpus);
  const friction = computeFriction(corpus);
  const codeQuality = computeCodeQuality(corpus);
  const alignment = computeAlignment(corpus);
  const interaction = computeInteraction(corpus);

  const unsigned = {
    analysisContractVersion: ANALYSIS_CONTRACT_VERSION,
    coverage,
    steering,
    friction,
    codeQuality,
    alignment,
    interaction,
  };
  const metricsHash = canonicalHash(unsigned);
  return deepFreeze({ ...unsigned, metricsHash });
}

export type ProviderModelCohort = Readonly<{
  providerId: string;
  modelId: string;
  sessionCount: number;
  recordCount: number;
  toolCallCount: number;
  errorCount: number;
}>;

export function computeProviderModelCohorts(corpus: SanitizedCorpus): readonly ProviderModelCohort[] {
  const cohorts = new Map<string, ProviderModelCohort>();
  for (const record of corpus.records) {
    if (record.providerId === undefined || record.modelId === undefined) continue;
    if (record.turnRole !== "assistant") continue;
    const key = `${record.providerId}/${record.modelId}`;
    const existing = cohorts.get(key);
    if (existing) {
      cohorts.set(key, deepFreeze({
        providerId: existing.providerId,
        modelId: existing.modelId,
        sessionCount: existing.sessionCount,
        recordCount: existing.recordCount + 1,
        toolCallCount: existing.toolCallCount,
        errorCount: existing.errorCount + (record.hasError === true ? 1 : 0),
      }));
    } else {
      cohorts.set(key, deepFreeze({
        providerId: record.providerId,
        modelId: record.modelId,
        sessionCount: 1,
        recordCount: 1,
        toolCallCount: 0,
        errorCount: record.hasError === true ? 1 : 0,
      }));
    }
  }
  return deepFreeze([...cohorts.values()].sort((a, b) => a.providerId.localeCompare(b.providerId) || a.modelId.localeCompare(b.modelId)));
}

export type WindowCoverage = Readonly<{
  inWindow: number;
  preWindow: number;
  inExclusion: number;
  postCutoff: number;
  total: number;
}>;

export function computeWindowCoverage(corpus: SanitizedCorpus): WindowCoverage {
  let inWindow = 0;
  let preWindow = 0;
  let inExclusion = 0;
  let postCutoff = 0;
  for (const record of corpus.records) {
    const ts = record.eventTimestampMs;
    if (ts < corpus.windowStartMs) preWindow += 1;
    else if (ts >= corpus.excludedStartMs && ts < corpus.excludedEndMs) inExclusion += 1;
    else if (ts > corpus.windowEndMs) postCutoff += 1;
    else inWindow += 1;
  }
  return deepFreeze({
    inWindow,
    preWindow,
    inExclusion,
    postCutoff,
    total: corpus.records.length,
  });
}
