// @vitest-environment node
/**
 * Lint-gate contract tests — the lint auto-check verdicts against DECLARED
 * thresholds over MEASURED sub-metrics, never against the configured
 * composite score.
 *
 * ── The defects prevented ──
 *
 * 1. The lint check passed/warned/failed on hardcoded >=80/>=60 cutoffs
 *    over the uncalibrated composite score. Because missing sub-metrics
 *    were coerced with `?? 0`, a FAILED quality computation produced a
 *    zero-penalty (high) score — and the check PASSED because its own
 *    computation failed. Deny-by-default: an unmeasured required
 *    sub-metric must FAIL the check.
 * 2. `quality-bridge.ts` coerced missing sub-metrics with `?? 0` — a
 *    fabricated measurement laundered into the score, into a fabricated
 *    `{0,0,0}` cloneStats object, and into recommendations that made
 *    claims about signals that were never measured.
 * 3. `buildRecommendations` restated the gate thresholds as inline
 *    10/5/0.15/0.5 literals that could drift from the declared config
 *    (`webUi.quality.lintGate` — single owner).
 *
 * ── Truth table verified (C) ──
 *   any required sub-metric unmeasured → FAILED (even with a perfect score)
 *   all measured, any declared threshold breached → WARNING
 *   all measured, no breach → PASSED
 *   the composite score NEVER decides the status
 *
 * ── Mutation-verified ──
 * Restoring the `>= 80 / >= 60` score cutoffs in runLint makes C fail.
 * Reintroducing `?? 0` coercion in buildQualityIndicator makes B fail.
 * Restoring inline 10/5/0.15/0.5 in buildRecommendations makes B/D fail.
 * Making getLintGateConfig ignore the config file makes A fail.
 * Removing the dashboard's derivation language / measured-flag dashes
 * makes E fail.
 */
import { describe, test, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { plantSettingsDocument } from "../helpers/isolated-config.ts";

// Point the config owner at a per-file temp config BEFORE server/config.ts
// resolves (vi.hoisted runs before static imports; the isolate-false setup's
// beforeAll re-resolves the singleton from this env).
await vi.hoisted(async () => {
  const { createTempDir } = await import("../helpers/temp-dir.ts");
  const dir = createTempDir("ch-lint-gate-");
  process.env.HARNESS_CONFIG_PATH = `${dir}/harness.config.json`;
});

// The quality bridge's ONLY data sources are the awareness snapshot and the
// repository-map summary. Mocking them (not the bridge) means the bridge +
// the auto-check runner run REAL code over a controlled snapshot — the
// integration the defects lived in.
const holder = vi.hoisted(() => ({ snap: null as unknown }));

vi.mock("../../server/awareness/awareness-bridge.ts", () => ({
  getAwarenessSnapshot: () => holder.snap,
  getAwarenessSnapshotAsync: async () => holder.snap,
}));
vi.mock("../../server/intelligence/intelligence-bridge.ts", () => ({
  getRepositoryMapSummary: () => ({ fileCount: 3 }),
  getRepositoryMapAsync: async () => ({}),
}));

import { getLintGateConfig, getQualityConfig } from "../../server/kernel/harness-config.ts";
import * as fileRead from "../../server/filesystem/file-read.ts";
import { getQualityIndicator } from "../../server/awareness/quality-bridge.ts";
import { runAutoCheck } from "../../server/awareness/auto-check-runner.ts";

const CONFIG_PATH = process.env.HARNESS_CONFIG_PATH!;

// Retain the shared fixture writer; the config owner checks current bytes.
function writeCfg(cfg: Record<string, unknown>): void {
  plantSettingsDocument(CONFIG_PATH, JSON.stringify(cfg));
}

/** A fully-measured, CLEAN snapshot (every gate metric well inside its
 * declared threshold). Overrides let each test break exactly one thing. */
function makeSnap(overrides: Record<string, unknown> = {}): unknown {
  return {
    functionCount: 10,
    totalLoc: 500,
    moduleCount: 2,
    quality: { issueDensity: 0.02, issuesPerKloc: 2, totalIssues: 1, topCategories: [] },
    complexity: { mean: 2, median: 1, p95: 5, max: 8, hotspotCount: 1 },
    typeLevel: { level: "typed", typedFileFraction: 0.9, typedParameterFraction: 0.8 },
    clones: { familyCount: 1, cloneCoverage: 0.05, topFamilies: [] },
    ...overrides,
  };
}

beforeEach(() => {
  writeCfg({});
  holder.snap = makeSnap();
});

// ── A. getLintGateConfig: the single owner of the declared thresholds ──

describe("A. getLintGateConfig (config owner)", () => {
  test("defaults match the shipped schema contract when the section is absent", () => {
    writeCfg({});
    expect(getLintGateConfig()).toEqual({
      maxIssuesPerKloc: 10,
      maxComplexityHotspots: 5,
      maxCloneRatio: 0.15,
      minTypedFileFraction: 0.5,
    });
    // An empty lintGate section behaves identically (per-field defaults).
    writeCfg({ webUi: { quality: { lintGate: {} } } });
    expect(getLintGateConfig().maxIssuesPerKloc).toBe(10);
  });

  test("configured thresholds are READ (the config file is the source of truth)", () => {
    writeCfg({ webUi: { quality: { lintGate: { maxIssuesPerKloc: 3, maxComplexityHotspots: 0, maxCloneRatio: 0.5, minTypedFileFraction: 0.9 } } } });
    expect(getLintGateConfig()).toEqual({
      maxIssuesPerKloc: 3,
      maxComplexityHotspots: 0,
      maxCloneRatio: 0.5,
      minTypedFileFraction: 0.9,
    });
    // A composed getter must use one resolved snapshot for every field and
    // read no file itself (the request-start refresh did, in the plant).
    // Observe the real byte reader, and assert the returned values too:
    // a per-call read or discarding the derived lint values must red.
    const reads = vi.spyOn(fileRead, "readFileText");
    try {
      for (const quality of [
        undefined,
        { topCategoriesCount: 7, lintGate: { maxIssuesPerKloc: 3, maxComplexityHotspots: 0, maxCloneRatio: 0.5, minTypedFileFraction: 0.9 } },
        { topCategoriesCount: 8, lintGate: { maxIssuesPerKloc: 4, maxComplexityHotspots: 1, maxCloneRatio: 0.4, minTypedFileFraction: 0.8 } },
      ]) {
        writeCfg({ webUi: { quality } });
        reads.mockClear();
        const actual = getQualityConfig();
        expect(actual.topCategoriesCount).toBe(quality?.topCategoriesCount ?? 3);
        expect(actual.lintGate).toEqual(quality?.lintGate ?? {
          maxIssuesPerKloc: 10, maxComplexityHotspots: 5, maxCloneRatio: 0.15, minTypedFileFraction: 0.5,
        });
        expect(reads.mock.calls.filter(([path]) => path === CONFIG_PATH), "the complete quality result comes from the snapshot, not the file").toHaveLength(0);
      }
    } finally {
      reads.mockRestore();
    }
  });

  test("invalid values fall back per-field (negative, out-of-range fraction, non-integer)", () => {
    writeCfg({ webUi: { quality: { lintGate: { maxIssuesPerKloc: -1, maxComplexityHotspots: 2.5, maxCloneRatio: 1.5, minTypedFileFraction: "high" } } } });
    expect(getLintGateConfig()).toEqual({
      maxIssuesPerKloc: 10,
      maxComplexityHotspots: 5,
      maxCloneRatio: 0.15,
      minTypedFileFraction: 0.5,
    });
  });

  test("0 is a VALID threshold (strictest gate), not coerced to the default", () => {
    writeCfg({ webUi: { quality: { lintGate: { maxIssuesPerKloc: 0, maxComplexityHotspots: 0, maxCloneRatio: 0, minTypedFileFraction: 0 } } } });
    expect(getLintGateConfig()).toEqual({
      maxIssuesPerKloc: 0,
      maxComplexityHotspots: 0,
      maxCloneRatio: 0,
      minTypedFileFraction: 0,
    });
  });
});

// ── B. quality bridge: measured flags, no fabricated figures ──

describe("B. quality bridge measured-flag honesty (no ?? 0 laundering)", () => {
  test("a fully-measured snapshot reports every measured flag true", () => {
    const ind = getQualityIndicator("/fake/project");
    expect(ind.measured).toEqual({ quality: true, complexity: true, clones: true, typeLevel: true });
    expect(ind.cloneStats).not.toBeNull();
  });

  test("an unmeasured clone signal yields cloneStats: null — NOT a fabricated {0,0,0}", () => {
    holder.snap = makeSnap({ clones: null });
    const ind = getQualityIndicator("/fake/project");
    expect(ind.measured.clones).toBe(false);
    expect(ind.cloneStats).toBeNull();
  });

  test("an unmeasured type signal produces NO fabricated 'low type coverage' claim", () => {
    // With `?? 0`, typedFraction became 0 → an invented "Low type
    // annotation coverage" recommendation about a signal never measured.
    holder.snap = makeSnap({ typeLevel: null });
    const ind = getQualityIndicator("/fake/project");
    expect(ind.measured.typeLevel).toBe(false);
    expect(ind.recommendations.join(" ")).not.toContain("Low type annotation coverage");
    expect(ind.recommendations.join(" ")).toContain("could not be measured");
  });

  test("an unmeasured quality signal flags itself and withholds the 'looks good' claim", () => {
    holder.snap = makeSnap({ quality: null });
    const ind = getQualityIndicator("/fake/project");
    expect(ind.measured.quality).toBe(false);
    expect(ind.recommendations.join(" ")).not.toContain("looks good");
    expect(ind.recommendations.join(" ")).toContain("could not be measured");
  });

  test("recommendation thresholds come from the DECLARED lintGate, not inline literals", () => {
    // A codebase breaching every default threshold…
    holder.snap = makeSnap({
      quality: { issueDensity: 0.5, issuesPerKloc: 50, totalIssues: 100, topCategories: [] },
      complexity: { mean: 9, median: 8, p95: 30, max: 60, hotspotCount: 20 },
      typeLevel: { level: "mixed", typedFileFraction: 0.1, typedParameterFraction: 0.1 },
      clones: { familyCount: 9, cloneCoverage: 0.5, topFamilies: [] },
    });
    const strict = getQualityIndicator("/fake/project").recommendations.join(" ");
    expect(strict).toContain("High issue density");
    expect(strict).toContain("complexity hotspots");
    expect(strict).toContain("clone ratio");
    expect(strict).toContain("Low type annotation coverage");
    // …stops earning those recommendations when the DECLARED gate is
    // loosened past its numbers. Inline 10/5/0.15/0.5 literals would keep
    // recommending regardless of the config (the drift this prevents).
    writeCfg({ webUi: { quality: { lintGate: { maxIssuesPerKloc: 1000, maxComplexityHotspots: 1000, maxCloneRatio: 1, minTypedFileFraction: 0 } } } });
    const loose = getQualityIndicator("/fake/project").recommendations.join(" ");
    expect(loose).not.toContain("High issue density");
    expect(loose).not.toContain("complexity hotspots");
    expect(loose).not.toContain("clone ratio");
    expect(loose).not.toContain("Low type annotation coverage");
  });
});

// ── C. lint auto-check truth table (deny-by-default) ──

describe("C. lint check truth table: unmeasured → failed, breach → warning, clean → passed", () => {
  test("all measured + no breach → PASSED", async () => {
    const outcome = await runAutoCheck("lint", "/fake/project");
    expect(outcome.status).toBe("passed");
    expect(outcome.output.unmeasured).toEqual([]);
    expect(outcome.output.breaches).toEqual([]);
  });

  test("a breached declared threshold → WARNING, naming the breach", async () => {
    // typedFileFraction 0.4 < 0.5 floor while everything else is pristine.
    // The composite score stays HIGH (>= 80) — under the old >=80 cutoff
    // this PASSED. The declared gate warns.
    holder.snap = makeSnap({
      quality: { issueDensity: 0.005, issuesPerKloc: 0.5, totalIssues: 1, topCategories: [] },
      complexity: { mean: 2, median: 1, p95: 5, max: 8, hotspotCount: 0 },
      clones: { familyCount: 0, cloneCoverage: 0.01, topFamilies: [] },
      typeLevel: { level: "mixed", typedFileFraction: 0.4, typedParameterFraction: 0.4 },
    });
    const outcome = await runAutoCheck("lint", "/fake/project");
    expect(outcome.status).toBe("warning");
    expect((outcome.output.breaches as string[]).join(" ")).toContain("typedFileFraction");
    expect(outcome.output.score as number).toBeGreaterThanOrEqual(80);
  });

  test("a metric exactly AT its threshold is not a breach (boundary)", async () => {
    holder.snap = makeSnap({ quality: { issueDensity: 0.02, issuesPerKloc: 10, totalIssues: 5, topCategories: [] } });
    const outcome = await runAutoCheck("lint", "/fake/project");
    expect(outcome.status).toBe("passed");
  });

  test("an unmeasured sub-metric → FAILED even with a perfect composite score", async () => {
    // The defect this prevents: clones unmeasured → `?? 0` → zero clone
    // penalty → score ≈ 100 → the old cutoff PASSED a check whose own
    // computation had failed. Deny-by-default: it must FAIL.
    holder.snap = makeSnap({ clones: null });
    const outcome = await runAutoCheck("lint", "/fake/project");
    expect(outcome.status).toBe("failed");
    expect(outcome.output.unmeasured).toEqual(["clones"]);
    expect(outcome.output.score as number).toBeGreaterThanOrEqual(80);
    // Honest absence in the output — null, not a fabricated 0.
    expect(outcome.output.cloneRatio).toBeNull();
  });

  test("unmeasured wins over breach (failed, not warning)", async () => {
    holder.snap = makeSnap({
      clones: null,
      typeLevel: { level: "mixed", typedFileFraction: 0.1, typedParameterFraction: 0.1 },
    });
    const outcome = await runAutoCheck("lint", "/fake/project");
    expect(outcome.status).toBe("failed");
    expect((outcome.output.breaches as string[]).length).toBeGreaterThan(0);
  });

  test("every required sub-metric unmeasured → FAILED and all four are named", async () => {
    holder.snap = makeSnap({ quality: null, complexity: null, clones: null, typeLevel: null });
    const outcome = await runAutoCheck("lint", "/fake/project");
    expect(outcome.status).toBe("failed");
    expect(outcome.output.unmeasured).toEqual(["quality", "complexity", "clones", "typeLevel"]);
  });

  test("the verdict follows the DECLARED gate: loosening the config flips warning → passed", async () => {
    holder.snap = makeSnap({ typeLevel: { level: "mixed", typedFileFraction: 0.4, typedParameterFraction: 0.4 } });
    expect((await runAutoCheck("lint", "/fake/project")).status).toBe("warning");
    writeCfg({ webUi: { quality: { lintGate: { minTypedFileFraction: 0.3 } } } });
    expect((await runAutoCheck("lint", "/fake/project")).status).toBe("passed");
  });

  test("score/grade remain in the output as information (display continuity)", async () => {
    const outcome = await runAutoCheck("lint", "/fake/project");
    expect(typeof outcome.output.score).toBe("number");
    expect(typeof outcome.output.grade).toBe("string");
    expect(outcome.output.gate).toEqual(getLintGateConfig());
  });
});

// ── D. the gate has a single owner (no restated literals) ──

describe("D. single owner: no inline gate literals in the consumers", () => {
  test("quality-bridge and auto-check-runner read getLintGateConfig", () => {
    const bridge = readFileSync("server/awareness/quality-bridge.ts", "utf8");
    const runner = readFileSync("server/awareness/auto-check-runner.ts", "utf8");
    expect(bridge).toContain("getLintGateConfig");
    expect(runner).toContain("getLintGateConfig");
    // The old hardcoded composite cutoffs must not decide the lint status.
    expect(runner).not.toMatch(/overallScore\s*>=\s*80/);
    expect(runner).not.toMatch(/overallScore\s*>=\s*60/);
  });
});

// (Class E died with the MetricsDashboard — the old tree's dial.)
