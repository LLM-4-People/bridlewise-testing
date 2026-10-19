/**
 * EXP374 — CUSUM (Cumulative Sum) detector: detects error-rate shifts and
 * triggers learning rounds.
 *
 * EXP296 showed CUSUM correctly detects detector-quality shifts on a real
 * codebase. EXP374 applies CUSUM to the LEARNING loop: track the error rate
 * over rounds. When the cumulative sum of (error_rate - target_rate) exceeds
 * a threshold, there's a shift — trigger a learning round.
 *
 * This answers "WHEN to learn" — not every round, but when the error rate
 * changes. In steady state (error rate = target), CUSUM hovers near 0. When
 * the error rate spikes (new error category) or plateaus (learning stuck),
 * CUSUM detects it.
 *
 * NO LLM. Pure deterministic statistics. All thresholds come from the config.
 *
 * Math:
 *   C⁺_t = max(0, C⁺_{t-1} + (errorRate_t - targetRate - slack))   (upper CUSUM)
 *   C⁻_t = min(0, C⁻_{t-1} + (errorRate_t - targetRate + slack))   (lower CUSUM)
 *   Shift detected when |C⁺| > threshold OR |C⁻| > threshold.
 *
 * A DROP in error rate (learning working) triggers C⁻ (improvement signal —
 * NOT a regression). A SPIKE (new error category) triggers C⁺ (regression
 * signal — triggers a learning round).
 */

import type { LearningConfig } from "./config.ts";

/** A CUSUM chart reading at one round. */
export interface CusumReading {
  round: number;
  errorRate: number;
  /** Upper CUSUM (detects rate increases / regressions). */
  cusumPos: number;
  /** Lower CUSUM (detects rate decreases / improvements). */
  cusumNeg: number;
  /** Whether a shift was detected this round. */
  shiftDetected: boolean;
  /** The direction of the shift (if detected). */
  shiftDirection: "regression" | "improvement" | "none";
}

/** A full CUSUM chart over a sequence of error rates. */
export interface CusumChart {
  readings: CusumReading[];
  /** Round indices where a shift was detected (regression). */
  regressionShifts: number[];
  /** Round indices where an improvement was detected. */
  improvementShifts: number[];
  /** The final C⁺ value (for the Maxwell's-demon thermodynamic analysis). */
  finalCusumPos: number;
  /** The final C⁻ value. */
  finalCusumNeg: number;
}

/**
 * Run a CUSUM chart over a sequence of error rates. Returns the full chart
 * with shift-detection readings.
 *
 * @param errorRates  the error rate at each round (0..1)
 * @param config      the learning config (owns target, threshold, slack)
 */
export function runCusum(
  errorRates: readonly number[],
  config: LearningConfig,
): CusumChart {
  const target = config.cusumTargetRate;
  const threshold = config.cusumThreshold;
  const slack = config.cusumSlack;

  const readings: CusumReading[] = [];
  const regressionShifts: number[] = [];
  const improvementShifts: number[] = [];
  let cusumPos = 0;
  let cusumNeg = 0;

  for (let t = 0; t < errorRates.length; t += 1) {
    const rate = errorRates[t] ?? 0;
    // Upper CUSUM: accumulates when rate > target + slack (regression).
    cusumPos = Math.max(0, cusumPos + (rate - target - slack));
    // Lower CUSUM: accumulates when rate < target - slack (improvement).
    cusumNeg = Math.min(0, cusumNeg + (rate - target + slack));

    let shiftDetected = false;
    let shiftDirection: "regression" | "improvement" | "none" = "none";
    if (cusumPos > threshold) {
      shiftDetected = true;
      shiftDirection = "regression";
      regressionShifts.push(t);
      // Reset after detection (standard CUSUM practice).
      cusumPos = 0;
    } else if (-cusumNeg > threshold) {
      shiftDetected = true;
      shiftDirection = "improvement";
      improvementShifts.push(t);
      cusumNeg = 0;
    }

    readings.push({
      round: t + 1,
      errorRate: rate,
      cusumPos,
      cusumNeg,
      shiftDetected,
      shiftDirection,
    });
  }

  return {
    readings,
    regressionShifts,
    improvementShifts,
    finalCusumPos: cusumPos,
    finalCusumNeg: cusumNeg,
  };
}

/**
 * Decide whether to trigger a learning round based on the CUSUM chart.
 * A learning round is triggered when:
 *   - A regression shift is detected (error rate spiked — learn new rules).
 *   - The error rate is above target and hasn't improved in `stallRounds`
 *     rounds (plateau — try harder learning: lower thresholds, fuzzy match).
 *
 * @param chart       the CUSUM chart
 * @param currentRound the current round number
 * @param stallRounds  the number of rounds without improvement before triggering
 * @returns whether to trigger a learning round + the reason
 */
export function shouldTriggerLearning(
  chart: CusumChart,
  currentRound: number,
  stallRounds: number,
): { trigger: boolean; reason: string } {
  const lastReading = chart.readings[chart.readings.length - 1];
  if (!lastReading) return { trigger: false, reason: "no readings" };

  if (lastReading.shiftDirection === "regression") {
    return {
      trigger: true,
      reason: `CUSUM regression shift detected at round ${currentRound} (error rate ${lastReading.errorRate.toFixed(4)} > target)`,
    };
  }

  // Check for plateau (no improvement in stallRounds).
  if (chart.readings.length >= stallRounds) {
    const recent = chart.readings.slice(-stallRounds);
    const allSame = recent.every(
      (r) => r.errorRate === (recent[0]?.errorRate ?? 0),
    );
    if (allSame && (lastReading.errorRate ?? 0) > 0) {
      return {
        trigger: true,
        reason: `CUSUM plateau: error rate unchanged at ${lastReading.errorRate.toFixed(4)} for ${stallRounds} rounds`,
      };
    }
  }

  return { trigger: false, reason: "in control" };
}
