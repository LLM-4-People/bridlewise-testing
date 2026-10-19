/**
 * EXP420 — Efficiency analyzer.
 *
 * Aggregates per-trial metrics into per-kind and per-mode summaries and
 * computes the save/cost verdict:
 *   - TIME saved (ms per trial): without.durationMs - with.durationMs
 *   - TOKENS saved (per trial): without.totalTokens - with.totalTokens
 *     (NOT counting the injected tokens, because those are added by us,
 *     not by the LLM — but we DO report them separately so the user can
 *     see the cost of injection).
 *   - ROUND TRIPS saved (per trial): without.roundTrips - with.roundTrips
 *   - ACCURACY delta (percentage points): with.accuracy - without.accuracy
 *
 * The verdict is HYBRID if WITH injection saves time AND tokens AND does not
 * hurt accuracy by more than 5pp. SHIP if it saves time AND tokens AND does
 * not hurt accuracy AT ALL. DON'T SHIP otherwise.
 */

import type { ModeSummary, PerKindSummary, QueryKind, TrialResult } from "./types.ts";

export function summarizeMode(
  mode: string,
  trials: readonly TrialResult[],
): ModeSummary {
  const kinds: QueryKind[] = ["code", "memory", "action", "general"];
  const perKind: PerKindSummary[] = kinds.map((kind) => {
    const subset = trials.filter((t) => t.expectedKind === kind);
    return summarizeKind(kind, subset);
  });
  const aggregate = summarizeAggregate(trials);
  return Object.freeze({
    mode: mode as ModeSummary["mode"],
    trials: trials.length,
    perKind,
    aggregate,
  });
}

function summarizeKind(kind: QueryKind, trials: readonly TrialResult[]): PerKindSummary {
  if (trials.length === 0) {
    return Object.freeze({
      kind,
      trials: 0,
      avgLlmCalls: 0,
      avgRoundTrips: 0,
      avgTokens: 0,
      avgDurationMs: 0,
      accuracy: 0,
      avgInjectedTokens: 0,
    });
  }
  const n = trials.length;
  const sum = trials.reduce(
    (acc, t) => {
      acc.llmCalls += t.llmCalls;
      acc.roundTrips += t.roundTrips;
      acc.tokens += t.totalTokens;
      acc.durationMs += t.durationMs;
      acc.injected += t.injectedTokens;
      if (t.correct) acc.correct++;
      return acc;
    },
    { llmCalls: 0, roundTrips: 0, tokens: 0, durationMs: 0, injected: 0, correct: 0 },
  );
  return Object.freeze({
    kind,
    trials: n,
    avgLlmCalls: sum.llmCalls / n,
    avgRoundTrips: sum.roundTrips / n,
    avgTokens: sum.tokens / n,
    avgDurationMs: sum.durationMs / n,
    accuracy: sum.correct / n,
    avgInjectedTokens: sum.injected / n,
  });
}

function summarizeAggregate(trials: readonly TrialResult[]): ModeSummary["aggregate"] {
  if (trials.length === 0) {
    return Object.freeze({
      avgLlmCalls: 0,
      avgRoundTrips: 0,
      avgTokens: 0,
      avgDurationMs: 0,
      accuracy: 0,
      avgInjectedTokens: 0,
    });
  }
  const n = trials.length;
  const sum = trials.reduce(
    (acc, t) => {
      acc.llmCalls += t.llmCalls;
      acc.roundTrips += t.roundTrips;
      acc.tokens += t.totalTokens;
      acc.durationMs += t.durationMs;
      acc.injected += t.injectedTokens;
      if (t.correct) acc.correct++;
      return acc;
    },
    { llmCalls: 0, roundTrips: 0, tokens: 0, durationMs: 0, injected: 0, correct: 0 },
  );
  return Object.freeze({
    avgLlmCalls: sum.llmCalls / n,
    avgRoundTrips: sum.roundTrips / n,
    avgTokens: sum.tokens / n,
    avgDurationMs: sum.durationMs / n,
    accuracy: sum.correct / n,
    avgInjectedTokens: sum.injected / n,
  });
}

export type EfficiencyVerdict = Readonly<{
  ship: "SHIP" | "DON'T SHIP" | "HYBRID";
  reasoning: string;
  timeSavedMs: number;
  tokensSaved: number;
  roundTripsSaved: number;
  accuracyDeltaPp: number;
}>;

export function analyzeEfficiency(
  without: ModeSummary,
  withMode: ModeSummary,
  hybrid: ModeSummary,
): EfficiencyVerdict {
  const timeSavedMs = without.aggregate.avgDurationMs - withMode.aggregate.avgDurationMs;
  const tokensSaved = without.aggregate.avgTokens - withMode.aggregate.avgTokens;
  const roundTripsSaved = without.aggregate.avgRoundTrips - withMode.aggregate.avgRoundTrips;
  const accuracyDeltaPp = (withMode.aggregate.accuracy - without.aggregate.accuracy) * 100;

  const parts: string[] = [];
  parts.push(
    `WITH: avg ${withMode.aggregate.avgLlmCalls.toFixed(2)} LLM calls, ${withMode.aggregate.avgRoundTrips.toFixed(2)} round trips, ${withMode.aggregate.avgTokens.toFixed(0)} tokens, ${withMode.aggregate.avgDurationMs.toFixed(0)}ms, ${(withMode.aggregate.accuracy * 100).toFixed(1)}% accuracy.`,
  );
  parts.push(
    `WITHOUT: avg ${without.aggregate.avgLlmCalls.toFixed(2)} LLM calls, ${without.aggregate.avgRoundTrips.toFixed(2)} round trips, ${without.aggregate.avgTokens.toFixed(0)} tokens, ${without.aggregate.avgDurationMs.toFixed(0)}ms, ${(without.aggregate.accuracy * 100).toFixed(1)}% accuracy.`,
  );
  parts.push(
    `HYBRID: avg ${hybrid.aggregate.avgLlmCalls.toFixed(2)} LLM calls, ${hybrid.aggregate.avgRoundTrips.toFixed(2)} round trips, ${hybrid.aggregate.avgTokens.toFixed(0)} tokens, ${hybrid.aggregate.avgDurationMs.toFixed(0)}ms, ${(hybrid.aggregate.accuracy * 100).toFixed(1)}% accuracy.`,
  );
  parts.push(
    `Time saved (with vs without): ${timeSavedMs.toFixed(0)}ms per trial. Tokens saved: ${tokensSaved.toFixed(0)}. Round trips saved: ${roundTripsSaved.toFixed(2)}. Accuracy delta: ${accuracyDeltaPp.toFixed(1)}pp.`,
  );

  // Verdict rules:
  //   - SHIP: with saves time AND tokens AND accuracy not hurt AT ALL.
  //   - HYBRID: with saves time AND tokens AND accuracy not hurt by more than 5pp.
  //   - DON'T SHIP: otherwise.
  let ship: "SHIP" | "DON'T SHIP" | "HYBRID";
  const savesTime = timeSavedMs > 0;
  const savesTokens = tokensSaved > 0;
  const accuracyOk = accuracyDeltaPp >= 0;
  const accuracyOkLoose = accuracyDeltaPp >= -5;
  if (savesTime && savesTokens && accuracyOk) {
    ship = "SHIP";
  } else if (savesTime && savesTokens && accuracyOkLoose) {
    ship = "HYBRID";
  } else if (hybrid.aggregate.avgDurationMs < without.aggregate.avgDurationMs && accuracyOkLoose) {
    // Even if `with` doesn't save, maybe `hybrid` does.
    ship = "HYBRID";
    parts.push("Note: HYBRID mode saves time vs WITHOUT even though WITH does not — recommend HYBRID.");
  } else {
    ship = "DON'T SHIP";
  }

  // Per-kind guidance.
  const perKindNotes: string[] = [];
  for (let i = 0; i < withMode.perKind.length; i++) {
    const wk = withMode.perKind[i]!;
    const wo = without.perKind[i]!;
    if (wk.trials === 0) continue;
    const kindTime = wo.avgDurationMs - wk.avgDurationMs;
    const kindTokens = wo.avgTokens - wk.avgTokens;
    const kindAcc = (wk.accuracy - wo.accuracy) * 100;
    if (kindTime > 0 || kindTokens > 0 || kindAcc >= 0) {
      perKindNotes.push(
        `kind=${wk.kind}: saved ${kindTime.toFixed(0)}ms + ${kindTokens.toFixed(0)} tokens, acc delta ${kindAcc.toFixed(1)}pp.`,
      );
    } else {
      perKindNotes.push(
        `kind=${wk.kind}: NO saving (${kindTime.toFixed(0)}ms, ${kindTokens.toFixed(0)} tokens, ${kindAcc.toFixed(1)}pp).`,
      );
    }
  }
  parts.push("Per-kind: " + perKindNotes.join(" "));

  return Object.freeze({
    ship,
    reasoning: parts.join(" "),
    timeSavedMs,
    tokensSaved,
    roundTripsSaved,
    accuracyDeltaPp,
  });
}
