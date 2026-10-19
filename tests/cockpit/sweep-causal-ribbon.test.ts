// @vitest-environment node
/**
 * Causal structure (§6.3) + the ribbon (§6.5): bands and chains are exact
 * walks of the recorded parentage — conserved counts, cycle-safe, and an
 * honest stop where the recorded window ends.
 */
import { describe, expect, test } from "vitest";

import { buildCausalBands, nearestEvent } from "../../src/cockpit/sweep/causal";
import {
  MAX_CHAIN_DEPTH,
  ribbonPathD,
  ribbonPoints,
  sweepCausalChain,
} from "../../src/cockpit/sweep/ribbon";
import type { SweepEvent } from "../../src/cockpit/sweep/types";

function ev(
  id: string,
  timeMs: number,
  extra: Partial<SweepEvent> = {},
): SweepEvent {
  return {
    eventId: id,
    timeMs,
    category: extra.category ?? "tool",
    isError: extra.isError ?? false,
    eventType: extra.eventType ?? "tool",
    outcome: null,
    errorCode: null,
    runId: extra.runId !== undefined ? extra.runId : "r1",
    turnId: extra.turnId !== undefined ? extra.turnId : "t1",
    parentEventId: extra.parentEventId ?? null,
    description: extra.description ?? "",
  };
}

describe("buildCausalBands", () => {
  test("groups run → turn → tick, conserving every event", () => {
    const events = [
      ev("a", 100, { eventType: "run", turnId: null }),
      ev("b", 200, { eventType: "turn" }),
      ev("c", 300),
      ev("d", 400, { turnId: "t2" }),
      ev("e", 500, { runId: "r2", turnId: "tx" }),
    ];
    const runs = buildCausalBands(events);
    expect(runs.map((r) => r.runId)).toEqual(["r1", "r2"]);
    const total = runs.reduce((a, r) => a + r.eventCount, 0);
    expect(total).toBe(events.length);
    const r1 = runs[0]!;
    expect(r1.t0).toBe(100);
    expect(r1.t1).toBe(400);
    // run-level events (no turnId) get their own honest "∅" band.
    expect(r1.turns.map((t) => t.id).sort()).toEqual(["t1", "t2", "∅"].sort());
  });

  test("unattributed events form their own runId=null band, never hidden", () => {
    const runs = buildCausalBands([ev("x", 100, { runId: null, turnId: null })]);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.runId).toBeNull();
    expect(runs[0]!.eventCount).toBe(1);
  });

  test("empty input → empty output (no fabricated bands)", () => {
    expect(buildCausalBands([])).toEqual([]);
  });
});

describe("causalChain", () => {
  const chainEvents = [
    ev("run", 0, { eventType: "run", parentEventId: null }),
    ev("turn", 10, { eventType: "turn", parentEventId: "run" }),
    ev("tool", 20, { parentEventId: "turn" }),
    ev("effect", 30, { eventType: "file-effect", parentEventId: "tool" }),
    ev("other", 40, { parentEventId: null }),
  ];

  test("walks the recorded parent path root-first", () => {
    expect(sweepCausalChain("effect", chainEvents).map((e) => e.eventId)).toEqual([
      "run",
      "turn",
      "tool",
      "effect",
    ]);
  });

  test("a missing parent stops the walk honestly (window edge)", () => {
    const partial = chainEvents.filter((e) => e.eventId !== "turn");
    expect(sweepCausalChain("effect", partial).map((e) => e.eventId)).toEqual([
      "tool",
      "effect",
    ]);
  });

  test("an unknown focus lights nothing", () => {
    expect(sweepCausalChain("nope", chainEvents)).toEqual([]);
  });

  test("cycles cannot loop the walk", () => {
    const cyclic = [
      ev("a", 0, { parentEventId: "b" }),
      ev("b", 1, { parentEventId: "a" }),
    ];
    const chain = sweepCausalChain("a", cyclic);
    expect(chain.length).toBe(2);
  });

  test("depth is capped against corrupted parentage", () => {
    const deep: SweepEvent[] = [];
    for (let i = 0; i < 200; i++) {
      deep.push(ev(`n${i}`, i, { parentEventId: i === 0 ? null : `n${i - 1}` }));
    }
    expect(sweepCausalChain("n199", deep).length).toBe(MAX_CHAIN_DEPTH);
  });
});

describe("ribbonPathD / ribbonPoints", () => {
  test("fewer than 2 placeable points → empty path (honest absence)", () => {
    expect(ribbonPathD([])).toBe("");
    expect(ribbonPathD([{ eventId: "a", x: 0, y: 0 }])).toBe("");
  });

  test("a chain renders a spine through every anchor", () => {
    const d = ribbonPathD([
      { eventId: "a", x: 10, y: 10 },
      { eventId: "b", x: 10, y: 50 },
      { eventId: "c", x: 40, y: 90 },
    ]);
    expect(d.startsWith("M 10 10")).toBe(true);
    expect(d).toContain("40 90");
    // Two joins → four quadratic segments.
    expect(d.match(/Q /g)?.length).toBe(4);
  });

  test("ribbonPoints skips anchors the consumer cannot place", () => {
    const chain = [
      ev("a", 0),
      ev("b", 1, { parentEventId: "a" }),
      ev("c", 2, { parentEventId: "b" }),
    ];
    const pts = ribbonPoints(chain, (id) =>
      id === "b" ? null : { x: 1, y: 2 },
    );
    expect(pts.map((p) => p.eventId)).toEqual(["a", "c"]);
  });
});

describe("nearestEvent", () => {
  test("finds the closest recorded instant, or null on empty", () => {
    const events = [ev("a", 100), ev("b", 500)];
    expect(nearestEvent(events, 260)?.eventId).toBe("a");
    expect(nearestEvent(events, 350)?.eventId).toBe("b");
    expect(nearestEvent([], 100)).toBeNull();
  });
});
