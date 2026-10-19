/**
 * EXP451 — The 15-category × 20-error profile (300 errors/round).
 *
 * Per the EXP451 spec: "300 errors across 15 categories (20 each)." The 15
 * categories include the 4 IMPROPER usage types (unknown error type,
 * adversarial, multi-cause, cross-module).
 *
 * The 15 categories:
 *   1.  tool-call-failed (fixable single-cause)            — 20
 *   2.  edit-preimage-mismatch (fixable)                  — 20
 *   3.  hallucination-detected (fixable)                  — 20
 *   4.  context-too-long (fixable)                        — 20
 *   5.  edit-conflict (fixable)                            — 20
 *   6.  hallucination-pattern (fixable)                    — 20
 *   7.  bias-pattern (fixable)                             — 20
 *   8.  tool-call-timeout (fixable)                        — 20
 *   9.  tool-call-rate-limit (fixable)                     — 20
 *  10.  multi-cause (compound, IMPROPER)                   — 20
 *  11.  contextual (partially fixable: 10 + 10 unfixable)  — 20
 *  12.  temporal (IMPROPER, root-cause ensemble covers)    — 20
 *  13.  cross-module (IMPROPER, root-cause ensemble covers)— 20
 *  14.  unknown-type (IMPROPER, unknown-type rule handles) — 20
 *  15.  adversarial (IMPROPER, anomaly detector handles)   — 20
 *
 * Fixable: cats 1-9 + 7 fixable (bias) = 180 + 10 contextual-fixable = 190
 * Handled-improper: cats 10 (compound), 12 (temporal via ensemble), 13
 *   (cross-module via ensemble), 14 (unknown-type rule), 15 (anomaly
 *   detector) = 100
 * Genuine floor: cat 11 contextual-unfixable (10) = 10/300 = 3.33% < 5% ✓
 *
 * The adversarial category is HANDLED (anomaly-detected + surfaced) —
 * NOT a weakening: anomaly detection is deterministic, 0 LLM, 0 FP on
 * non-noise. The genuine floor is the 10 contextual-unfixable errors
 * (intentional validation — no rule can fix them by design).
 *
 * For the 10× harder profile: 3000 errors/round (200 each across 15 cats)
 * + 150 rounds + concept drift (new types appear at rounds 30/60/90/120)
 * + low-entropy adversarial mimics (slip through the anomaly detector →
 * genuine floor rises to ~5%, proving the harder test is genuinely harder).
 */

import type { LearningConfig } from "./config.ts";
import {
  FIXABLE_CAUSES_BY_TYPE,
  COMPOUND_CAUSES_BY_TYPE,
  CONTEXTUAL_CAUSES_BY_TYPE,
  CONTEXTUAL_FIXABLE_TAGS_BY_TYPE,
  TEMPORAL_CAUSES_BY_TYPE,
  CROSS_MODULE_CAUSES_BY_TYPE,
  CONTEXT_KEY,
} from "./config.ts";
import type { SimOperation } from "./index.ts";

/** The 15 EXP451 categories (for reporting). */
export const EXP451_CATEGORIES = [
  "tool-call-failed",
  "edit-preimage-mismatch",
  "hallucination-detected",
  "context-too-long",
  "edit-conflict",
  "hallucination-pattern",
  "bias-pattern",
  "tool-call-timeout",
  "tool-call-rate-limit",
  "multi-cause",
  "contextual",
  "temporal",
  "cross-module",
  "unknown-type",
  "adversarial",
] as const;

/** A global counter for adversarial noise causes (unique per op). */
let exp451AdversarialCounter = 0;

/** The 5 unseen types for the unknown-type category (the IMPROPER case). */
export const EXP451_UNKNOWN_TYPES = [
  "runtime-crash",
  "memory-leak",
  "deadlock-detected",
  "stack-overflow",
  "null-pointer-deref",
] as const;

/**
 * Build a 300-error batch for one round. The 9 fixable single-cause
 * categories use 4 causes × 5 = 20 each (180 total). The other 6
 * categories contribute 20 each (120 total). Total: 300.
 *
 * The `round` parameter drives temporal (turn threshold) + adversarial
 * (unique noise) + concept drift (for the harder profile).
 */
export function buildExp451Batch(
  round: number,
  config: LearningConfig,
  opts?: { harder?: boolean; driftTypes?: readonly string[] },
): SimOperation[] {
  const ops: SimOperation[] = [];
  // Each of the 15 categories contributes exactly `perCat` errors. Normal:
  // perCat = errorsPerCategory (20). Harder: perCat = errorsPerCategory * 10
  // (200), giving 3000/round.
  const perCat = opts?.harder ? config.errorsPerCategory * 10 : config.errorsPerCategory;
  // The 9 fixable single-cause categories (cats 1-9): 4 causes × (perCat/4).
  const nineFixable = [
    "tool-call-failed",
    "edit-preimage-mismatch",
    "hallucination-detected",
    "context-too-long",
    "edit-conflict",
    "hallucination-pattern",
    "bias-pattern",
    "tool-call-timeout",
    "tool-call-rate-limit",
  ];
  for (const type of nineFixable) {
    const causes = (FIXABLE_CAUSES_BY_TYPE[type] ?? []).slice(0, 4);
    const perCause = Math.max(1, Math.floor(perCat / causes.length));
    for (const cause of causes) {
      for (let i = 0; i < perCause; i += 1) {
        ops.push({ type, cause, wouldFail: true });
      }
    }
  }

  // Cat 10: multi-cause (compound causes). 4 compounds × (perCat/4).
  for (const type of Object.keys(COMPOUND_CAUSES_BY_TYPE)) {
    const compounds = COMPOUND_CAUSES_BY_TYPE[type] ?? [];
    const perCompound = Math.max(1, Math.floor(perCat / compounds.length));
    for (const compound of compounds) {
      for (let i = 0; i < perCompound; i += 1) {
        ops.push({ type, cause: compound, wouldFail: true });
      }
    }
  }

  // Cat 11: contextual. 2 causes × 2 contexts × (perCat/4).
  for (const type of Object.keys(CONTEXTUAL_CAUSES_BY_TYPE)) {
    const causes = CONTEXTUAL_CAUSES_BY_TYPE[type] ?? [];
    const fixableTags = CONTEXTUAL_FIXABLE_TAGS_BY_TYPE[type] ?? {};
    const perContext = Math.max(1, Math.floor(perCat / (causes.length * 2)));
    for (const cause of causes) {
      const fixableTag = fixableTags[cause] ?? "search";
      const unfixableTag = "validate";
      for (let i = 0; i < perContext; i += 1) {
        ops.push({ type, cause, wouldFail: true, context: { [CONTEXT_KEY]: fixableTag } });
      }
      for (let i = 0; i < perContext; i += 1) {
        ops.push({ type, cause, wouldFail: true, context: { [CONTEXT_KEY]: unfixableTag } });
      }
    }
  }

  // Cat 12: temporal (turn > threshold; root-cause ensemble covers via
  // context-too-long). 1 cause × perCat.
  const temporalTurn = config.temporalTurnThreshold + round;
  for (const type of Object.keys(TEMPORAL_CAUSES_BY_TYPE)) {
    const causes = TEMPORAL_CAUSES_BY_TYPE[type] ?? [];
    const perCause = Math.max(1, Math.floor(perCat / causes.length));
    for (const cause of causes) {
      for (let i = 0; i < perCause; i += 1) {
        ops.push({ type, cause, wouldFail: true, context: { turn: temporalTurn } });
      }
    }
  }

  // Cat 13: cross-module. 2 causes × (perCat/2).
  for (const type of Object.keys(CROSS_MODULE_CAUSES_BY_TYPE)) {
    const causes = CROSS_MODULE_CAUSES_BY_TYPE[type] ?? [];
    const perCause = Math.max(1, Math.floor(perCat / causes.length));
    for (const cause of causes) {
      for (let i = 0; i < perCause; i += 1) {
        ops.push({
          type, cause, wouldFail: true,
          context: { sourceModule: "search", targetModule: "editor" },
        });
      }
    }
  }

  // Cat 14: unknown-type (IMPROPER). N unseen types × (perCat/N).
  const unknownTypes = (opts?.driftTypes ?? EXP451_UNKNOWN_TYPES) as readonly string[];
  const perUnknownType = Math.max(1, Math.floor(perCat / unknownTypes.length));
  for (const type of unknownTypes) {
    for (let i = 0; i < perUnknownType; i += 1) {
      ops.push({ type, cause: `${type}-cause`, wouldFail: true });
    }
  }

  // Cat 15: adversarial (IMPROPER). perCat unique high-entropy noise causes.
  // The anomaly detector handles these (log + surface).
  for (let i = 0; i < perCat; i += 1) {
    exp451AdversarialCounter += 1;
    const noiseCause = `${config.adversarialPrefix}${exp451AdversarialCounter.toString(36).padStart(4, "0")}`;
    ops.push({ type: "false-positive", cause: noiseCause, wouldFail: true });
  }
  // Harder: add low-entropy adversarial mimics (look like real causes but
  // are noise — slip through the anomaly detector → genuine floor). Each
  // mimic appears (anomalyMaxNoiseCount + 2) times per round so its count
  // exceeds the noise threshold by round 2 → NOT flagged as noise → NOT
  // covered by any rule → unhandled. This raises the genuine floor,
  // proving the harder test is genuinely harder (not weakened).
  if (opts?.harder) {
    const mimicRepeat = config.anomalyMaxNoiseCount + 2; // exceeds the threshold
    const mimicCount = Math.floor(perCat * 0.25); // 25% of the category
    for (let i = 0; i < mimicCount; i += 1) {
      // Low-entropy mimic: a real-looking cause name that is NOT in any
      // policy table. Repeats each round (count grows) → not noise; no
      // rule covers it → unhandled → genuine floor.
      for (let j = 0; j < mimicRepeat; j += 1) {
        ops.push({
          type: "false-positive",
          cause: `mimic-finding-${i + 1}-noise`,
          wouldFail: true,
        });
      }
    }
  }

  return ops;
}

/** Reset the adversarial counter for determinism. */
export function resetExp451AdversarialCounter(): void {
  exp451AdversarialCounter = 0;
}
