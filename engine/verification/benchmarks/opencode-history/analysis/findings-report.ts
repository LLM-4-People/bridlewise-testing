/**
 * Structured findings report for the OpenCode evidence study.
 *
 * Produces a versioned, hashable findings report from computed StudyMetrics.
 * The report separates (1) coverage evidence, (2) findings, (3) limitations,
 * and (4) the SEC-001 blocker status. It is designed to work on synthetic
 * fixtures now and on real sanitized data when SEC-001 closes.
 *
 * This is research/verification code. No product runtime module may import it.
 */

import { canonicalHash, deepFreeze, sha256 } from "../../../../src/kernel/integrity.ts";
import { ANALYSIS_CONTRACT_VERSION, type SanitizedCorpus } from "./source-record-contract.ts";
import {
  computeProviderModelCohorts,
  computeStudyMetrics,
  computeWindowCoverage,
  type ProviderModelCohort,
  type StudyMetrics,
  type WindowCoverage,
} from "./study-metrics.ts";

export const FINDINGS_REPORT_SCHEMA_VERSION = "bridlewise-opencode-findings-report/v1" as const;

export type FindingSeverity = "critical" | "high" | "medium" | "low" | "info";

export const FINDING_SEVERITIES = deepFreeze([
  "critical",
  "high",
  "medium",
  "low",
  "info",
] as readonly FindingSeverity[]);

export type FindingCategory =
  | "steering"
  | "friction"
  | "code_quality"
  | "alignment"
  | "interaction"
  | "coverage"
  | "provider_tool";

export const FINDING_CATEGORIES = deepFreeze([
  "steering",
  "friction",
  "code_quality",
  "alignment",
  "interaction",
  "coverage",
  "provider_tool",
] as readonly FindingCategory[]);

export type Finding = Readonly<{
  id: string;
  category: FindingCategory;
  severity: FindingSeverity;
  title: string;
  description: string;
  evidenceCount: number;
  cohortProviderId: string | null;
  cohortModelId: string | null;
}>;

export type LimitationKind =
  | "sec001_blocking"
  | "synthetic_only"
  | "no_real_data"
  | "sanitizer_redacted"
  | "truncated_evidence"
  | "compaction_gap"
  | "unknown_provider_model"
  | "post_cutoff_excluded";

export type Limitation = Readonly<{
  kind: LimitationKind;
  description: string;
  affectedMetric: string;
}>;

export type FindingsReport = Readonly<{
  schemaVersion: string;
  analysisContractVersion: string;
  corpusIdentityHash: string;
  metricsHash: string;
  reportHash: string;
  generatedAt: string;
  sec001Open: boolean;
  realHistoryReady: boolean;
  syntheticOnly: boolean;
  window: Readonly<{ startMs: number; endMs: number; excludedStartMs: number; excludedEndMs: number; timezone: string }>;
  upstream: Readonly<{ tag: string; commit: string }>;
  coverage: StudyMetrics["coverage"];
  windowCoverage: WindowCoverage;
  providerModelCohorts: readonly ProviderModelCohort[];
  findings: readonly Finding[];
  limitations: readonly Limitation[];
  metrics: StudyMetrics;
}>;

export class FindingsReportError extends Error {
  readonly code: FindingsReportErrorCode;

  constructor(code: FindingsReportErrorCode) {
    super(code);
    this.name = "FindingsReportError";
    this.code = code;
  }
}

export type FindingsReportErrorCode =
  | "corpus_empty"
  | "metrics_hash_mismatch"
  | "finding_invalid"
  | "limitation_invalid"
  | "sec001_must_be_open_for_synthetic";

function isFindingCategory(value: unknown): value is FindingCategory {
  return typeof value === "string" && (FINDING_CATEGORIES as readonly string[]).includes(value);
}

function isFindingSeverity(value: unknown): value is FindingSeverity {
  return typeof value === "string" && (FINDING_SEVERITIES as readonly string[]).includes(value);
}

export function generateFindings(
  corpus: SanitizedCorpus,
  metrics: StudyMetrics,
  options: Readonly<{ generatedAt: string; sec001Open: boolean; realHistoryReady: boolean; syntheticOnly: boolean }> = {
    generatedAt: "1970-01-01T00:00:00.000Z",
    sec001Open: true,
    realHistoryReady: false,
    syntheticOnly: true,
  },
): FindingsReport {
  if (corpus.records.length === 0) {
    throw new FindingsReportError("corpus_empty");
  }
  if (options.syntheticOnly && !options.sec001Open) {
    throw new FindingsReportError("sec001_must_be_open_for_synthetic");
  }
  const windowCoverage = computeWindowCoverage(corpus);
  const cohorts = computeProviderModelCohorts(corpus);
  const findings: Finding[] = [];
  const limitations: Limitation[] = [];
  let findingSeq = 0;

  function nextFindingId(): string {
    findingSeq += 1;
    return `FIND-${findingSeq.toString().padStart(4, "0")}`;
  }

  if (metrics.coverage.toolErrors > 0) {
    const severity: FindingSeverity = metrics.coverage.toolErrors > 10 ? "high" : "medium";
    findings.push(deepFreeze({
      id: nextFindingId(),
      category: "friction",
      severity,
      title: "Tool errors observed in corpus",
      description: `${metrics.coverage.toolErrors} tool error records across ${metrics.coverage.toolCalls} tool calls (${metrics.coverage.toolCalls > 0 ? ((metrics.coverage.toolErrors / metrics.coverage.toolCalls) * 100).toFixed(1) : "0"}% error rate).`,
      evidenceCount: metrics.coverage.toolErrors,
      cohortProviderId: null,
      cohortModelId: null,
    }));
  }
  if (metrics.steering.corrections > 0) {
    findings.push(deepFreeze({
      id: nextFindingId(),
      category: "steering",
      severity: metrics.steering.corrections > 10 ? "high" : "medium",
      title: "User corrections indicate steering friction",
      description: `${metrics.steering.corrections} rapid user corrections (<60s after assistant) across ${metrics.coverage.sessions} sessions.`,
      evidenceCount: metrics.steering.corrections,
      cohortProviderId: null,
      cohortModelId: null,
    }));
  }
  if (metrics.friction.totalIncidents > 0) {
    findings.push(deepFreeze({
      id: nextFindingId(),
      category: "friction",
      severity: metrics.friction.totalIncidents > 20 ? "high" : "medium",
      title: "Friction incidents detected",
      description: `${metrics.friction.totalIncidents} friction incidents: ${metrics.friction.byKind.tool_failure} tool failures, ${metrics.friction.byKind.tool_retry} retries, ${metrics.friction.byKind.tool_loop} loops, ${metrics.friction.byKind.context_loss_repeat} context-loss repeats.`,
      evidenceCount: metrics.friction.totalIncidents,
      cohortProviderId: null,
      cohortModelId: null,
    }));
  }
  if (metrics.codeQuality.totalIndicators > 0) {
    findings.push(deepFreeze({
      id: nextFindingId(),
      category: "code_quality",
      severity: "high",
      title: "Code quality indicators in produced code",
      description: `${metrics.codeQuality.totalIndicators} indicators: ${metrics.codeQuality.byKind.dead_code_evidence} dead code, ${metrics.codeQuality.byKind.unused_export_evidence} unused exports, ${metrics.codeQuality.byKind.missing_regression_test_evidence} missing regression tests.`,
      evidenceCount: metrics.codeQuality.totalIndicators,
      cohortProviderId: null,
      cohortModelId: null,
    }));
  }
  if (metrics.alignment.divergences > 0) {
    findings.push(deepFreeze({
      id: nextFindingId(),
      category: "alignment",
      severity: metrics.alignment.divergenceRate > 0.3 ? "high" : "medium",
      title: "Alignment divergence points detected",
      description: `${metrics.alignment.divergences} divergence points with ${metrics.alignment.recoveries} recoveries (recovery rate: ${(metrics.alignment.recoveryRate * 100).toFixed(1)}%).`,
      evidenceCount: metrics.alignment.divergences,
      cohortProviderId: null,
      cohortModelId: null,
    }));
  }
  if (metrics.coverage.compactions > 0) {
    findings.push(deepFreeze({
      id: nextFindingId(),
      category: "alignment",
      severity: "low",
      title: "Context compaction events",
      description: `${metrics.coverage.compactions} compaction events; ${metrics.alignment.constraintsLost} potential constraint-loss candidates, ${metrics.alignment.constraintsRetained} retained.`,
      evidenceCount: metrics.coverage.compactions,
      cohortProviderId: null,
      cohortModelId: null,
    }));
  }
  if (metrics.interaction.byKind.rapid_correction > 0) {
    findings.push(deepFreeze({
      id: nextFindingId(),
      category: "interaction",
      severity: "medium",
      title: "Rapid-correction interaction pattern",
      description: `${metrics.interaction.byKind.rapid_correction} sessions show rapid-correction patterns (first two user turns <60s apart).`,
      evidenceCount: metrics.interaction.byKind.rapid_correction,
      cohortProviderId: null,
      cohortModelId: null,
    }));
  }
  if (cohorts.length > 1) {
    findings.push(deepFreeze({
      id: nextFindingId(),
      category: "provider_tool",
      severity: "info",
      title: "Multiple provider/model cohorts",
      description: `${cohorts.length} distinct provider/model cohorts identified across ${metrics.coverage.assistantRecords} assistant records.`,
      evidenceCount: cohorts.length,
      cohortProviderId: null,
      cohortModelId: null,
    }));
  }
  if (metrics.coverage.unavailable > 0 || metrics.coverage.truncated > 0) {
    findings.push(deepFreeze({
      id: nextFindingId(),
      category: "coverage",
      severity: "low",
      title: "Unavailable or truncated evidence",
      description: `${metrics.coverage.unavailable} unavailable and ${metrics.coverage.truncated} truncated records; coverage is exact within retained evidence but incomplete.`,
      evidenceCount: metrics.coverage.unavailable + metrics.coverage.truncated,
      cohortProviderId: null,
      cohortModelId: null,
    }));
  }

  limitations.push(deepFreeze({
    kind: "sec001_blocking",
    description: "SEC-001 is open-blocking. Real OpenCode data access is blocked. This report is synthetic-only.",
    affectedMetric: "all",
  }));
  limitations.push(deepFreeze({
    kind: "synthetic_only",
    description: "All findings are computed from synthetic fixtures. Real-data findings require SEC-001 closure.",
    affectedMetric: "all",
  }));
  limitations.push(deepFreeze({
    kind: "no_real_data",
    description: "Frozen snapshot counts (696 sessions, 52 roots, 23159 Makora-tagged messages) cannot be recomputed from real data.",
    affectedMetric: "coverage",
  }));
  if (metrics.coverage.compactions > 0) {
    limitations.push(deepFreeze({
      kind: "compaction_gap",
      description: `${metrics.coverage.compactions} compaction events may have lost context; post-compaction analysis is inferential.`,
      affectedMetric: "alignment",
    }));
  }
  if (windowCoverage.inExclusion > 0) {
    limitations.push(deepFreeze({
      kind: "post_cutoff_excluded",
      description: `${windowCoverage.inExclusion} records fall in the exclusion window and are not analyzed.`,
      affectedMetric: "coverage",
    }));
  }
  if (cohorts.length === 0) {
    limitations.push(deepFreeze({
      kind: "unknown_provider_model",
      description: "No provider/model attribution found in assistant records.",
      affectedMetric: "provider_tool",
    }));
  }

  const corpusId = canonicalHash({
    contractVersion: corpus.contractVersion,
    sourceSnapshotSha256: corpus.sourceSnapshotSha256,
    selectionSha256: corpus.selectionSha256,
    recordCount: corpus.records.length,
  });

  const unsigned = {
    schemaVersion: FINDINGS_REPORT_SCHEMA_VERSION,
    analysisContractVersion: ANALYSIS_CONTRACT_VERSION,
    corpusIdentityHash: corpusId,
    metricsHash: metrics.metricsHash,
    generatedAt: options.generatedAt,
    sec001Open: options.sec001Open,
    realHistoryReady: options.realHistoryReady,
    syntheticOnly: options.syntheticOnly,
    window: deepFreeze({
      startMs: corpus.windowStartMs,
      endMs: corpus.windowEndMs,
      excludedStartMs: corpus.excludedStartMs,
      excludedEndMs: corpus.excludedEndMs,
      timezone: corpus.timezone,
    }),
    upstream: deepFreeze({ tag: corpus.upstreamTag, commit: corpus.upstreamCommit }),
    coverage: metrics.coverage,
    windowCoverage,
    providerModelCohorts: cohorts,
    findings,
    limitations,
    metrics,
  };
  const reportHash = sha256(canonicalHash(unsigned));
  return deepFreeze({ ...unsigned, reportHash });
}

export function validateFinding(value: unknown): Finding {
  if (typeof value !== "object" || value === null) {
    throw new FindingsReportError("finding_invalid");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) {
    throw new FindingsReportError("finding_invalid");
  }
  if (!isFindingCategory(record.category)) {
    throw new FindingsReportError("finding_invalid");
  }
  if (!isFindingSeverity(record.severity)) {
    throw new FindingsReportError("finding_invalid");
  }
  if (typeof record.title !== "string" || record.title.length === 0) {
    throw new FindingsReportError("finding_invalid");
  }
  if (typeof record.description !== "string" || record.description.length === 0) {
    throw new FindingsReportError("finding_invalid");
  }
  if (typeof record.evidenceCount !== "number" || !Number.isInteger(record.evidenceCount) || record.evidenceCount < 0) {
    throw new FindingsReportError("finding_invalid");
  }
  return deepFreeze({
    id: record.id,
    category: record.category,
    severity: record.severity,
    title: record.title,
    description: record.description,
    evidenceCount: record.evidenceCount,
    cohortProviderId: typeof record.cohortProviderId === "string" ? record.cohortProviderId : null,
    cohortModelId: typeof record.cohortModelId === "string" ? record.cohortModelId : null,
  });
}

export function validateLimitation(value: unknown): Limitation {
  if (typeof value !== "object" || value === null) {
    throw new FindingsReportError("limitation_invalid");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.kind !== "string" || record.kind.length === 0) {
    throw new FindingsReportError("limitation_invalid");
  }
  if (typeof record.description !== "string" || record.description.length === 0) {
    throw new FindingsReportError("limitation_invalid");
  }
  if (typeof record.affectedMetric !== "string" || record.affectedMetric.length === 0) {
    throw new FindingsReportError("limitation_invalid");
  }
  return deepFreeze({
    kind: record.kind as LimitationKind,
    description: record.description,
    affectedMetric: record.affectedMetric,
  });
}

export function produceFindingsReport(
  corpus: SanitizedCorpus,
  options: Readonly<{ generatedAt: string; sec001Open: boolean; realHistoryReady: boolean; syntheticOnly: boolean }> = {
    generatedAt: "1970-01-01T00:00:00.000Z",
    sec001Open: true,
    realHistoryReady: false,
    syntheticOnly: true,
  },
): FindingsReport {
  const metrics = computeStudyMetrics(corpus);
  return generateFindings(corpus, metrics, options);
}

export function findingsReportIdentityHash(report: FindingsReport): string {
  return canonicalHash({
    schemaVersion: report.schemaVersion,
    corpusIdentityHash: report.corpusIdentityHash,
    metricsHash: report.metricsHash,
    reportHash: report.reportHash,
    findingCount: report.findings.length,
    limitationCount: report.limitations.length,
  });
}
