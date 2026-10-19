// @vitest-environment node
/**
 * Client-computable findings (spec §4): the turn rollup (one measured line)
 * and the context projection (deterministic, labeled, windowed). Honest
 * absence: no measurement → no finding.
 */
import { describe, expect, test } from "vitest";

import {
  computeContextProjection,
  computeTurnRollup,
  PROJECTION_WINDOW,
  trimVerbPlaceholder,
} from "../../src/cockpit/computer/findings.ts";
import { assertDerivation } from "../../src/cockpit/computer/derivation.ts";
import type { Beat } from "../../src/cockpit/flow/types.ts";

function effectBeat(i: number): Beat {
  return {
    id: `fx-${i}`,
    kind: "effect",
    parentId: null,
    turnIndex: 0,
    at: 1000 + i,
    abnormal: false,
    bleed: true,
    verbs: [],
    effect: { path: `f${i}.ts`, producedBy: "t" },
  };
}

function modelBeat(inTok?: number, outTok?: number): Beat {
  return {
    id: "m1",
    kind: "turn",
    parentId: null,
    turnIndex: 0,
    at: 1000,
    abnormal: false,
    bleed: false,
    verbs: [],
    turn: {
      who: "model",
      text: "x",
      streaming: false,
      ...(inTok !== undefined ? { inputTokens: inTok } : {}),
      ...(outTok !== undefined ? { outputTokens: outTok } : {}),
    },
  };
}

describe("turn rollup", () => {
  test("measured clauses only — counts from the beats, tokens from the envelope", () => {
    const r = computeTurnRollup({
      turnIndex: 2,
      beats: [modelBeat(12_432, 3_104), effectBeat(1), effectBeat(2)],
      checksObserved: 3,
      asOf: 999,
    });
    expect(r.sentence).toBe("turn 3 — 2 files changed · ↑12,432 ↓3,104 tok");
    expect(() => assertDerivation(r.derivation, r.sentence)).not.toThrow();
    expect(r.derivation.steps[0]!.count).toBe(3);
    expect(r.derivation.asOf).toBe(999);
  });

  test("no measurements → the honest empty line, never zeros", () => {
    const r = computeTurnRollup({
      turnIndex: 0,
      beats: [modelBeat()],
      checksObserved: 0,
      asOf: 1,
    });
    expect(r.sentence).toBe("turn 1 — no file effects, no check changes");
    expect(r.sentence).not.toMatch(/0 files/);
  });

  test("check regressions appear as transitions in the line", () => {
    const delta: Beat = {
      id: "cd1",
      kind: "check-delta",
      parentId: null,
      turnIndex: 0,
      at: 5,
      abnormal: true,
      bleed: true,
      verbs: [],
      checkDelta: { checkId: "c", checkName: "lint", from: "passed", to: "failed", errorCount: 2 },
    };
    const r = computeTurnRollup({ turnIndex: 0, beats: [delta], checksObserved: 1, asOf: 5 });
    expect(r.sentence).toMatch(/lint: passed → failed/);
  });
});

describe("context projection", () => {
  const pt = (tokens: number, at: number, limit = 100_000) => ({
    contextTokens: tokens,
    contextTokenLimit: limit,
    at,
  });

  test("needs ≥2 measured points", () => {
    expect(computeContextProjection([])).toBeNull();
    expect(computeContextProjection([pt(10_000, 1)])).toBeNull();
  });

  test("needs a measured limit and positive growth", () => {
    expect(
      computeContextProjection([
        { contextTokens: 10_000, at: 1 },
        { contextTokens: 12_000, at: 2 },
      ]),
    ).toBeNull();
    expect(computeContextProjection([pt(12_000, 1), pt(10_000, 2)])).toBeNull();
    // Already full: nothing left to project.
    expect(computeContextProjection([pt(90_000, 1, 80_000), pt(95_000, 2, 80_000)])).toBeNull();
  });

  test("sentence carries the word 'projection' + the window; derivation carries both (§4.4)", () => {
    const r = computeContextProjection([pt(10_000, 100), pt(12_000, 200), pt(14_000, 300)]);
    expect(r).not.toBeNull();
    expect(r!.sentence).toMatch(/projection from your last 3 runs/);
    expect(r!.sentence).toMatch(/~43 more messages/);
    expect(r!.derivation.window).toMatch(/last 3 runs/);
    expect(r!.derivation.asOf).toBe(100); // the OLDEST input
    expect(() => assertDerivation(r!.derivation, r!.sentence)).not.toThrow();
  });

  test("the window is capped at the declared size", () => {
    const points = Array.from({ length: 30 }, (_, i) => pt(1000 * (i + 1), i + 1));
    const r = computeContextProjection(points);
    expect(r!.sentence).toContain(`last ${PROJECTION_WINDOW} runs`);
  });

  // ── The finding's trim shortcut: honest refusal, live control ──────────
  describe("trimVerbPlaceholder — the disabled trim shortcut never claims the control does not exist (UIE-011)", () => {
    test("the reason names the real limit (a chosen turn) and where the live control is", () => {
      const verb = trimVerbPlaceholder("the history strip of the context desk");
      expect(verb.wired).toBe(false);
      expect(verb.reason).toContain("trim needs a chosen turn");
      expect(verb.reason).toContain("the history strip of the context desk");
      // The lie this arm exists to prevent: the trim control IS built and
      // driven end-to-end — the refusal may state a limit, never a false
      // absence.
      expect(verb.reason).not.toContain("not built");
      expect(verb.reason).not.toContain("does not exist");
    });
  });
});
