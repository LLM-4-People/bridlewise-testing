// @vitest-environment node
/**
 * Adversarial tests for the self-improving analyzer.
 *
 * The analyzer is a PURE function over a MetricsSnapshot + config. It must
 * handle empty snapshots, below-threshold samples, high error rates, slow
 * tools/LLM calls, cancellation churn, NaN/Infinity durations, and the
 * maxSuggestions cap — honestly (bounded list, never a throw).
 * Thresholds come from the config owner; tests pass an explicit config
 * for hermetic, deterministic assertions.
 */
import { describe, it, expect } from "vitest";
import {
  computeSelfImprovementSuggestions,
} from "../../server/observability/self-improving.ts";
import type { MetricsSnapshot, MetricEntrySnapshot } from "../../server/kernel/canonical.ts";
import type { SelfImprovingConfig } from "../../server/kernel/harness-config.ts";

const CFG: SelfImprovingConfig = {
  minSampleCount: 5,
  errorRateThreshold: 0.25,
  slowToolMsThreshold: 5000,
  slowLlmMsThreshold: 30000,
  maxSuggestions: 10,
};

function entry(
  mod: string,
  fn: string,
  over: Partial<{
    callCount: number;
    errorCount: number;
    cancellationCount: number;
    sumMs: number;
    totalCount: number;
  }>,
): MetricEntrySnapshot {
  const callCount = over.callCount ?? 0;
  const errorCount = over.errorCount ?? 0;
  const cancellationCount = over.cancellationCount ?? 0;
  const totalCount = over.totalCount ?? callCount;
  const sumMs = over.sumMs ?? 0;
  return {
    key: { module: mod, function: fn, scope: "execute" },
    correlation: {},
    callCount,
    errorCount,
    cancellationCount,
    durationHistogram: {
      bucketCount: 8,
      bucketStrategy: "pow",
      bounds: [1, 2, 4, 8, 16, 32, 64, 128],
      counts: [],
      totalCount,
      minMs: 0,
      maxMs: 0,
      sumMs,
    },
    totalCpuMs: 0,
    totalHeapDeltaBytes: 0,
    attribution: "exact",
  };
}

function snapshot(entries: MetricEntrySnapshot[], totals?: Partial<{ totalCallCount: number; totalErrorCount: number; totalCancellationCount: number }>): MetricsSnapshot {
  const totalCallCount = totals?.totalCallCount ?? entries.reduce((s, e) => s + e.callCount, 0);
  const totalErrorCount = totals?.totalErrorCount ?? entries.reduce((s, e) => s + e.errorCount, 0);
  const totalCancellationCount = totals?.totalCancellationCount ?? entries.reduce((s, e) => s + e.cancellationCount, 0);
  return {
    schemaVersion: "1",
    snapshotId: "snap",
    wallTime: new Date().toISOString(),
    entryCount: entries.length,
    entries,
    totalCallCount,
    totalErrorCount,
    totalCancellationCount,
    configHash: "h",
  };
}

describe("self-improving analyzer — adversarial", () => {
  it("an empty snapshot yields no suggestions (honest, not a throw)", () => {
    const s = computeSelfImprovementSuggestions(snapshot([]), CFG);
    expect(s).toEqual([]);
  });

  it("a function below minSampleCount is NOT analyzed (statistical noise guard)", () => {
    const s = computeSelfImprovementSuggestions(
      snapshot([entry("tool", "read_file", { callCount: 4, errorCount: 4, sumMs: 999999, totalCount: 4 })]),
      CFG,
    );
    // 4 calls < minSampleCount 5 → no suggestion despite 100% error + huge duration.
    expect(s).toEqual([]);
  });

  it("a failing tool (error rate >= threshold) produces a HIGH suggestion", () => {
    // Add a healthy filler so the OVERALL error rate stays below threshold
    // (otherwise the overall suggestion also fires — correct but not what
    // this per-function test isolates).
    const s = computeSelfImprovementSuggestions(
      snapshot([
        entry("tool", "read_file", { callCount: 10, errorCount: 5, sumMs: 100, totalCount: 10 }),
        entry("tool", "healthy_filler", { callCount: 90, sumMs: 100, totalCount: 90 }),
      ]),
      CFG,
    );
    expect(s.length).toBe(1);
    expect(s[0]!.severity).toBe("high");
    expect(s[0]!.area).toBe("tool");
    expect(s[0]!.signal).toContain("read_file");
    expect(s[0]!.functionKey?.function).toBe("read_file");
  });

  it("a slow tool (avg >= slowToolMsThreshold) produces a MEDIUM suggestion", () => {
    // 10 calls, 0 errors, sumMs 60000 → avg 6000ms >= 5000 threshold.
    const s = computeSelfImprovementSuggestions(
      snapshot([entry("tool", "get_repository_map", { callCount: 10, sumMs: 60_000, totalCount: 10 })]),
      CFG,
    );
    expect(s.length).toBe(1);
    expect(s[0]!.severity).toBe("medium");
    expect(s[0]!.signal).toContain("6000");
  });

  it("a slow LLM call uses the LLM threshold, not the tool threshold", () => {
    // avg 31000ms: above slowLlmMsThreshold (30000) but below the 5000 tool
    // threshold concept — must be flagged as an LLM suggestion, not a tool.
    const s = computeSelfImprovementSuggestions(
      snapshot([entry("llm", "gemma-4-31b", { callCount: 5, sumMs: 155_000, totalCount: 5 })]),
      CFG,
    );
    expect(s.length).toBe(1);
    expect(s[0]!.area).toBe("llm");
    expect(s[0]!.signal).toContain("gemma-4-31b");
  });

  it("a high OVERALL error rate produces the overall suggestion", () => {
    // 20 calls, 10 errors overall → 50% >= 25%. Individual tools each have
    // 5/10 = 50% too, so the overall suggestion + 2 tool suggestions appear.
    const s = computeSelfImprovementSuggestions(
      snapshot(
        [
          entry("tool", "read_file", { callCount: 10, errorCount: 5, sumMs: 100, totalCount: 10 }),
          entry("tool", "list_files", { callCount: 10, errorCount: 5, sumMs: 100, totalCount: 10 }),
        ],
        { totalCallCount: 20, totalErrorCount: 10 },
      ),
      CFG,
    );
    const overall = s.find((x) => x.area === "overall");
    expect(overall).toBeDefined();
    expect(overall!.severity).toBe("high");
    expect(overall!.signal).toContain("50.0%");
  });

  it("cancellation churn produces a LOW suggestion", () => {
    // 10 calls, 5 cancellations → 50% >= 25% threshold.
    const s = computeSelfImprovementSuggestions(
      snapshot([entry("llm", "qwen3", { callCount: 10, cancellationCount: 5, sumMs: 1000, totalCount: 10 })]),
      CFG,
    );
    const cancel = s.find((x) => x.area === "cancellation");
    expect(cancel).toBeDefined();
    expect(cancel!.severity).toBe("low");
  });

  it("suggestions are sorted high → medium → low", () => {
    // Filler keeps the overall error rate below threshold so only the
    // per-function suggestions appear (high + medium + low).
    const s = computeSelfImprovementSuggestions(
      snapshot([
        entry("llm", "slowmodel", { callCount: 5, sumMs: 200_000, totalCount: 5 }), // medium
        entry("tool", "failingtool", { callCount: 5, errorCount: 2, sumMs: 10, totalCount: 5 }), // high (40%)
        entry("tool", "canceltool", { callCount: 5, cancellationCount: 5, sumMs: 10, totalCount: 5 }), // low
        entry("tool", "healthy_filler", { callCount: 85, sumMs: 100, totalCount: 85 }),
      ]),
      CFG,
    );
    const severities = s.map((x) => x.severity);
    expect(severities).toEqual(["high", "medium", "low"]);
  });

  it("maxSuggestions caps the returned list (sorted order preserved)", () => {
    const smallCap: SelfImprovingConfig = { ...CFG, maxSuggestions: 1 };
    const s = computeSelfImprovementSuggestions(
      snapshot([
        entry("tool", "failingtool", { callCount: 5, errorCount: 5, sumMs: 10, totalCount: 5 }), // high
        entry("llm", "slowmodel", { callCount: 5, sumMs: 200_000, totalCount: 5 }), // medium
      ]),
      smallCap,
    );
    expect(s.length).toBe(1);
    expect(s[0]!.severity).toBe("high"); // the highest-severity one survives the cap
  });

  it("NaN/Infinity durations do not crash and do not produce spurious slow suggestions", () => {
    // sumMs Infinity, totalCount 5 → avg Infinity. avg >= threshold is true,
    // so this WOULD flag. But a NaN avg must not. Build a NaN entry.
    const s = computeSelfImprovementSuggestions(
      snapshot([entry("tool", "weird", { callCount: 5, sumMs: Number.NaN, totalCount: 5 })]),
      CFG,
    );
    // NaN >= threshold is false → no slow suggestion. No errors/cancels → empty.
    expect(s).toEqual([]);
  });

  it("callCount 0 never divides by zero (no suggestion for a zero-call entry)", () => {
    const s = computeSelfImprovementSuggestions(
      snapshot([entry("tool", "nevercalled", { callCount: 0, errorCount: 0, sumMs: 0, totalCount: 0 })]),
      CFG,
    );
    expect(s).toEqual([]);
  });

  it("falls back to the config owner when no config is passed (real config path)", () => {
    // No explicit config → reads getSelfImprovingConfig (the real config
    // file). The result is a finite, bounded array (never throws).
    const s = computeSelfImprovementSuggestions(snapshot([]));
    expect(Array.isArray(s)).toBe(true);
    expect(s.length).toBeLessThanOrEqual(100);
  });

  it("a tool that is BOTH failing AND slow produces two suggestions (both signals surface)", () => {
    // Filler suppresses the overall suggestion so the two per-tool signals
    // (high error + medium slow) are isolated.
    const s = computeSelfImprovementSuggestions(
      snapshot([
        entry("tool", "badandslow", { callCount: 10, errorCount: 5, sumMs: 80_000, totalCount: 10 }),
        entry("tool", "healthy_filler", { callCount: 90, sumMs: 100, totalCount: 90 }),
      ]),
      CFG,
    );
    expect(s.length).toBe(2);
    expect(s.some((x) => x.severity === "high")).toBe(true);
    expect(s.some((x) => x.severity === "medium")).toBe(true);
  });
});
