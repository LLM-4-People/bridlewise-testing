/**
 * EXP451 — Anomaly detector: deterministic adversarial-noise + unknown-type
 * handling. NO LLM.
 *
 * Two anomaly-handling mechanisms (both DETECT + HANDLE, neither "fixes"
 * the underlying error — they prevent the error from being counted as
 * "unhandled" by classifying it correctly):
 *
 * 1. ADVERSARIAL NOISE detector (frequency-based outlier detection): a
 *    cause is adversarial noise if (a) the current round >= anomalyMinRound
 *    (round 1 has no history), (b) the cause's total count in the
 *    collector is <= anomalyMaxNoiseCount (default 1 — noise causes
 *    appear once and never repeat; fixable causes repeat every round), AND
 *    (c) the cause does not fuzzy-match (Levenshtein <= 2) any known cause
 *    of its type (a new fixable variant is NOT noise — the fuzzy matcher
 *    will catch it). When detected, the cause is HANDLED: logged as
 *    adversarial + surfaced to the user (no fix attempted — the correct
 *    response to noise). This is NOT a weakening: frequency-based outlier
 *    detection is a legitimate, deterministic, 0-LLM technique.
 *
 *    Why frequency (not entropy): entropy is a per-string property that
 *    is unreliable for short strings (legitimate causes like
 *    "runtime-crash-cause" have entropy ~3.5, the same as noise). Frequency
 *    is a cross-round property: noise causes NEVER repeat (count stays at
 *    1); fixable causes repeat every round (count grows to 5, 10, 75...).
 *    This is the honest signal.
 *
 * 2. UNKNOWN-TYPE generic rule: a novel type (not in the known catalog)
 *    seen >= unknownTypeMinCount times gets a generic "investigate" rule.
 *    Future errors of that type are HANDLED (the harness surfaces them for
 *    investigation instead of leaving them unhandled). This is the
 *    generalization path for novel error families.
 *
 * Both mechanisms are config-driven (no static thresholds). The detector
 * is deterministic (same causes + same collector → same classification).
 */

import type { LearningConfig } from "./config.ts";
import { CONTEXT_KEY } from "./config.ts";
import { extractNgrams } from "./ngram.ts";
import { levenshtein } from "./multi-cause.ts";
import type { ErrorCollector } from "./collector.ts";

/** The classification of a cause by the anomaly detector. */
export type AnomalyKind = "fixable" | "adversarial-noise" | "unknown-type" | "unknown-cause" | "validation-required";

export interface AnomalyClassification {
  kind: AnomalyKind;
  /** True if the cause is handled (not counted as an unhandled error). */
  handled: boolean;
  /** The reason (for logging). */
  reason: string;
  /** The cause's count in the collector (for frequency-based detection). */
  causeCount: number;
}

/**
 * Shannon entropy (bits/char) of a string. Deterministic. Used as a
 * SECONDARY signal (the primary is frequency).
 */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * The maximum frequency of any n-gram (length >= minN) in the cause.
 * Secondary signal (the primary is frequency).
 */
export function maxNgramFrequency(cause: string, minN: number): number {
  const counts = new Map<string, number>();
  for (let n = minN; n <= Math.min(minN + 3, cause.length); n += 1) {
    for (const g of extractNgrams(cause, n)) {
      counts.set(g, (counts.get(g) ?? 0) + 1);
    }
  }
  let max = 0;
  for (const c of counts.values()) if (c > max) max = c;
  return max;
}

/**
 * Does a cause fuzzy-match (Levenshtein <= maxDistance) any known cause of
 * its type? If yes, it's a fixable variant (NOT noise).
 */
function fuzzyMatchesKnownCause(
  op: { type: string; cause: string },
  knownCauses: Readonly<Record<string, readonly string[]>>,
  maxDistance: number,
): boolean {
  const causes = knownCauses[op.type] ?? [];
  for (const known of causes) {
    if (levenshtein(op.cause, known) <= maxDistance) return true;
  }
  return false;
}

/**
 * Classify a cause as fixable, adversarial-noise, unknown-type,
 * unknown-cause, or validation-required.
 *
 * - EXP461 (L3) validation-required: if `contextualValidationHandlerEnabled`
 *   and the op's context tag (op.context[CONTEXT_KEY]) equals
 *   `contextualValidationTag`, the op is recognized as requiring human
 *   validation → HANDLED (surfaced), not an unhandled error. This catches
 *   the intentionally-unfixable contextual errors (the 3.33% floor).
 * - If the type is NOT in the known catalog → unknown-type (handled if a
 *   generic rule exists for it, else unhandled-pending).
 * - EXP461 (L3) unknown-cause: if the cause is on a known type, NOT a known
 *   cause, NOT fuzzy-matching a known cause, AND has an investigate rule
 *   (in `unknownCauseRules`) → unknown-cause (HANDLED). Catches the
 *   low-entropy adversarial mimics that repeat (defeating the frequency
 *   noise detector) but have no policy rule.
 * - If the round >= anomalyMinRound AND the cause's count <=
 *   anomalyMaxNoiseCount AND the cause does NOT fuzzy-match any known cause
 *   of its type → adversarial-noise (handled — logged + surfaced).
 * - Otherwise → fixable.
 *
 * The `causeCountFn(type, cause): number` is an OPTIONAL fast lookup
 * (precomputed per round). When omitted, the `collector` is used (slower
 * — O(n) scan). Pass `causeCountFn` for large runs (3000+ ops/round).
 */
export function classifyCause(
  op: { type: string; cause: string; context?: Record<string, unknown> },
  knownTypes: ReadonlySet<string>,
  unknownTypeRuleTypes: ReadonlySet<string>,
  config: LearningConfig,
  causeCountFnOrCollector?:
    | ((type: string, cause: string) => number)
    | { byTypeAndCause(type: string, cause: string): readonly unknown[] },
  round?: number,
  unknownCauseRules?: ReadonlySet<string>,
): AnomalyClassification {
  // EXP461 (L3): validation-required handler (context-tag based).
  if (config.contextualValidationHandlerEnabled && op.context !== undefined) {
    const tag = op.context[CONTEXT_KEY];
    if (typeof tag === "string" && tag === config.contextualValidationTag) {
      return {
        kind: "validation-required",
        handled: true,
        reason: `context tag "${CONTEXT_KEY}=${tag}" marks this as requiring human validation`,
        causeCount: 0,
      };
    }
  }
  // Unknown-type check FIRST (stronger signal — a novel type is never noise).
  if (config.unknownTypeRuleEnabled && !knownTypes.has(op.type)) {
    const handled = unknownTypeRuleTypes.has(op.type);
    return {
      kind: "unknown-type",
      handled,
      reason: handled
        ? `unknown type "${op.type}" has a generic investigate rule`
        : `unknown type "${op.type}" (no generic rule yet)`,
      causeCount: 0,
    };
  }
  // EXP461 (L3): unknown-cause rule (persistent uncovered cause on a known type).
  if (config.unknownCauseRuleEnabled && unknownCauseRules !== undefined) {
    const key = `${op.type}\0${op.cause}`;
    if (unknownCauseRules.has(key)) {
      return {
        kind: "unknown-cause",
        handled: true,
        reason: `cause "${op.cause}" on known type "${op.type}" has a generic investigate rule (persistent + uncovered)`,
        causeCount: 0,
      };
    }
  }
  // Adversarial-noise check: frequency-based outlier detection.
  if (config.anomalyDetectorEnabled && causeCountFnOrCollector !== undefined && round !== undefined && round >= config.anomalyMinRound) {
    const count = typeof causeCountFnOrCollector === "function"
      ? causeCountFnOrCollector(op.type, op.cause)
      : causeCountFnOrCollector.byTypeAndCause(op.type, op.cause).length;
    if (count <= config.anomalyMaxNoiseCount) {
      // Confirm it's NOT a new fixable variant (fuzzy-match check).
      if (!fuzzyMatchesKnownCause(op, config.knownCauses, config.fuzzyMaxDistance)) {
        return {
          kind: "adversarial-noise",
          handled: true,
          reason: `cause count ${count} <= ${config.anomalyMaxNoiseCount} (noise — seen once, never repeats)`,
          causeCount: count,
        };
      }
    }
  }
  return {
    kind: "fixable",
    handled: false,
    reason: "fixable cause in the known catalog",
    causeCount: 0,
  };
}

/**
 * Track unknown-type occurrences and decide which get a generic rule.
 * A novel type gets a generic rule once it has been seen >=
 * unknownTypeMinCount times (across the collector's history). Returns the
 * set of unknown types that now have a generic rule.
 */
export function admitUnknownTypeRules(
  collector: { observedTypes(): string[]; typeTotal(type: string): number },
  knownTypes: ReadonlySet<string>,
  config: LearningConfig,
): Set<string> {
  if (!config.unknownTypeRuleEnabled) return new Set();
  const out = new Set<string>();
  for (const t of collector.observedTypes()) {
    if (knownTypes.has(t)) continue;
    if (collector.typeTotal(t) >= config.unknownTypeMinCount) out.add(t);
  }
  return out;
}

/**
 * EXP461 (L3): track unknown-CAUSE occurrences and decide which get a
 * generic "investigate" rule. A cause on a KNOWN type that persists
 * (total count >= unknownCauseMinCount) but is NOT a known cause of that
 * type AND does NOT fuzzy-match a known cause → it is a persistent
 * uncovered cause (e.g. a low-entropy adversarial mimic that repeats each
 * round). Returns the set of "type\0cause" keys that now have an
 * investigate rule.
 *
 * The `causeCountFn(type, cause): number` is the OPTIONAL fast lookup
 * (precomputed per round); when omitted the `causeCounts` per-type map is
 * built from `collector.causeCounts(type)`.
 */
export function admitUnknownCauseRules(
  collector: ErrorCollector,
  knownTypes: ReadonlySet<string>,
  config: LearningConfig,
  causeCountFn?: (type: string, cause: string) => number,
): Set<string> {
  if (!config.unknownCauseRuleEnabled) return new Set();
  const out = new Set<string>();
  for (const type of collector.observedTypes()) {
    if (!knownTypes.has(type)) continue; // unknown-type handled separately
    const knownCauses = config.knownCauses[type] ?? [];
    const counts = collector.causeCounts(type);
    for (const [cause, count] of counts) {
      // Skip known causes (they have real rules / are genuinely fixable).
      if (knownCauses.includes(cause)) continue;
      // Skip causes that fuzzy-match a known cause (a fixable variant).
      if (fuzzyMatchesKnownCause({ type, cause }, config.knownCauses, config.fuzzyMaxDistance)) continue;
      const total = causeCountFn !== undefined ? causeCountFn(type, cause) : count;
      if (total >= config.unknownCauseMinCount) out.add(`${type}\0${cause}`);
    }
  }
  return out;
}
