// @vitest-environment jsdom
/**
 * NOTHING FOCUSED, NOTHING COMPRESSED — the guard for the reported defect
 * "they show ultra collapsed until we click on them, then they show
 * normally, if we click on them again, then they show expanded".
 *
 * THE CAUSE, and why a pure-function test would have missed it. `fisheyeLevel`
 * was always correct for the inputs it was given; the FLOW gave it the wrong
 * one. With nothing focused it substituted the LAST beat for the focus, so
 * `causalDistance` and `recency` became the same number, the three-term DOI
 * degenerated into a pure age ramp anchored at the tail, and every beat more
 * than three turns old rendered compressed before the reader had touched
 * anything. The bug lived entirely in the WIRING, so the guard has to be on
 * the wiring: this file mounts the real FLOW over a real log.
 *
 * The three rungs the user described, and what each one was:
 *   1. on load, compressed        — the defect (this file)
 *   2. one click, "normal"        — focus arriving, distance 0, level full
 *   3. a second click, "expanded" — the card's own expand, which only exists
 *                                   once a `.body` is on screen to click
 * Fixing rung 1 collapses the ladder: the body is there from the start, so
 * the expand grip is one gesture away rather than two.
 *
 * NON-VACUITY is pinned here too: the same log, with a beat focused, MUST
 * compress its far neighbours. Otherwise this file would pass against a
 * fisheye that had simply been deleted.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";

import Flow from "../../src/cockpit/flow/Flow.svelte";
import { appendBeat, batch, clearLog } from "../../src/cockpit/flow/log.ts";
import { fisheyeLevel } from "../../src/cockpit/flow/fisheye.ts";
import { resetIngest } from "../../src/cockpit/flow/ingest.ts";
import type { Beat } from "../../src/cockpit/flow/types.ts";

class RO {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", RO);
  resetIngest();
  clearLog();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  clearLog();
});

const T0 = Date.parse("2026-07-25T13:40:00");

/** A conversation long enough that the old age ramp would have ticked most
 * of it: 14 turns, each with an instrumental beat the fisheye may compress. */
function loadConversation(turns = 14): void {
  batch(() => {
    for (let t = 0; t < turns; t += 1) {
      const at = T0 + t * 60_000;
      appendBeat({
        id: `you-${t}`,
        kind: "turn",
        parentId: null,
        turnIndex: t,
        at,
        abnormal: false,
        bleed: false,
        verbs: [],
        turn: { who: "you", text: `message ${t}`, streaming: false },
      });
      appendBeat({
        id: `tool-${t}`,
        kind: "tool",
        parentId: `you-${t}`,
        turnIndex: t,
        at: at + 1_000,
        abnormal: false,
        bleed: true,
        verbs: [],
        tool: {
          name: "read_file",
          label: "read file",
          status: "done",
          input: { path: `src/${t}.ts` },
          output: "ok",
          startedAt: at + 1_000,
          durationMs: 4,
        },
      });
      appendBeat({
        id: `event-${t}`,
        kind: "event",
        parentId: `you-${t}`,
        turnIndex: t,
        at: at + 2_000,
        abnormal: false,
        bleed: true,
        verbs: [],
        event: { eventKind: "steering", text: `the harness said something ${t}` },
      });
    }
  });
}

function levelsOnScreen(container: HTMLElement): { full: number; ghost: number; tick: number } {
  const out = { full: 0, ghost: 0, tick: 0 };
  for (const el of container.querySelectorAll(".beat")) {
    for (const level of ["full", "ghost", "tick"] as const) {
      if (el.classList.contains(`level-${level}`)) out[level] += 1;
    }
  }
  return out;
}

describe("the flow before the reader has focused anything", () => {
  test("every beat on screen renders FULL — nothing is compressed around a focus that does not exist", async () => {
    loadConversation();
    const { container } = render(Flow, { props: { ingest: false } });
    await tick();
    await Promise.resolve();

    const levels = levelsOnScreen(container);
    expect(levels.full).toBeGreaterThan(0);
    expect(
      levels.ghost + levels.tick,
      "beats were compressed before the reader focused anything — the fisheye has nothing to compress around yet",
    ).toBe(0);
  });
});

describe("NON-VACUITY — the fisheye still compresses once there IS a focus", () => {
  test("a beat far from the focused turn compresses; the focused turn does not", () => {
    const far: Beat = {
      id: "far",
      kind: "event",
      parentId: null,
      turnIndex: 0,
      at: T0,
      abnormal: false,
      bleed: true,
      verbs: [],
      event: { eventKind: "steering", text: "far away" },
    };
    // With a focus 12 turns away this is the ramp's floor…
    expect(
      fisheyeLevel({
        beat: far,
        focusTurnIndex: 12,
        onFocusChain: false,
        latestTurnIndex: 12,
      }).level,
    ).toBe("tick");
    // …and with NO focus, the very same beat is full. If this pair ever
    // agreed, the guard above would be measuring nothing.
    expect(
      fisheyeLevel({
        beat: far,
        focusTurnIndex: null,
        onFocusChain: false,
        latestTurnIndex: 12,
      }).level,
    ).toBe("full");
  });

  test("a manual collapse still wins over 'nothing is focused'", () => {
    const beat: Beat = {
      id: "b",
      kind: "event",
      parentId: null,
      turnIndex: 3,
      at: T0,
      abnormal: false,
      bleed: true,
      verbs: [],
      event: { eventKind: "steering", text: "chosen" },
    };
    const r = fisheyeLevel({
      beat,
      focusTurnIndex: null,
      onFocusChain: false,
      latestTurnIndex: 9,
      override: "collapse",
    });
    expect(r.level).toBe("tick");
    expect(r.reason).toMatch(/manual choice/);
  });

  test("the unfocused level states its reason, like every other level", () => {
    const beat: Beat = {
      id: "b2",
      kind: "event",
      parentId: null,
      turnIndex: 3,
      at: T0,
      abnormal: false,
      bleed: true,
      verbs: [],
      event: { eventKind: "steering", text: "reasoned" },
    };
    const r = fisheyeLevel({
      beat,
      focusTurnIndex: null,
      onFocusChain: false,
      latestTurnIndex: 9,
    });
    expect(r.reason.length).toBeGreaterThan(0);
    expect(r.reason).toMatch(/nothing is focused/);
  });
});
