// @vitest-environment node
/**
 * Causal fisheye DOI (spec §3.2): explainable from the record — causal
 * distance + recency + abnormality; every compressed beat carries its
 * computed reason; manual override wins for the session.
 */
import { beforeEach, describe, expect, test } from "vitest";

import {
  clearAllOverrides,
  clearOverride,
  fisheyeLevel,
  overrideFor,
  setOverride,
} from "../../src/cockpit/flow/fisheye.ts";
import type { Beat } from "../../src/cockpit/flow/types.ts";

function beat(turnIndex: number, kind: Beat["kind"] = "tool", abnormal = false): Beat {
  return {
    id: `t${turnIndex}-${kind}`,
    kind,
    parentId: null,
    turnIndex,
    at: 0,
    abnormal,
    bleed: kind !== "turn",
    verbs: [],
  };
}

beforeEach(() => clearAllOverrides());

describe("fisheye DOI", () => {
  test("the focused turn renders full, with the reason stated", () => {
    const r = fisheyeLevel({
      beat: beat(5, "tool"),
      focusTurnIndex: 5,
      onFocusChain: false,
      latestTurnIndex: 8,
    });
    expect(r.level).toBe("full");
    expect(r.reason).toMatch(/focused/);
  });

  test("the causal chain of the focus renders full regardless of distance", () => {
    const r = fisheyeLevel({
      beat: beat(1, "tool"),
      focusTurnIndex: 9,
      onFocusChain: true,
      latestTurnIndex: 9,
    });
    expect(r.level).toBe("full");
    expect(r.reason).toMatch(/causal chain/);
  });

  /**
   * ONE TURN AWAY IS STILL THE READING WINDOW.
   *
   * This band used to hold prose full and ghost the INSTRUMENTS, which is
   * what the user saw and reported as "tool calls no longer show properly":
   * the model's words beside a one-line trace of the tool calls that turn
   * actually made. Compression starts at distance 2 now — and the guard
   * below pins that a tool call adjacent to the focus is FULL, so the band
   * cannot quietly tighten again.
   */
  test("nothing one turn from the focus is compressed — instruments included", () => {
    for (const kind of ["tool", "effect", "check-delta", "event", "turn"] as const) {
      const r = fisheyeLevel({
        beat: beat(4, kind),
        focusTurnIndex: 5,
        onFocusChain: false,
        latestTurnIndex: 5,
      });
      expect(r.level, `${kind} one turn from the focus must render full`).toBe("full");
      expect(r.reason).toMatch(/one turn from your focus/);
    }
  });

  test("compression begins at TWO turns away, not one (the ramp's first step)", () => {
    const r = fisheyeLevel({
      beat: beat(3, "tool"),
      focusTurnIndex: 5,
      onFocusChain: false,
      latestTurnIndex: 5,
    });
    expect(r.level).toBe("ghost");
    expect(r.reason).toMatch(/2 turns/);
  });

  test("old and far beats become ticks, with the distance in the reason", () => {
    // A single-fact beat — its status mark IS a fair rendering of it, so the
    // tick survives here. (A TOOL call floors at `ghost`; see the note in
    // fisheye.ts and the dedicated test below.)
    const r = fisheyeLevel({
      beat: beat(1, "check-delta"),
      focusTurnIndex: 9,
      onFocusChain: false,
      latestTurnIndex: 9,
    });
    expect(r.level).toBe("tick");
    expect(r.reason).toMatch(/8 turns/);
  });

  test("…and an old, far TOOL call ghosts instead, still naming the distance", () => {
    const r = fisheyeLevel({
      beat: beat(1, "tool"),
      focusTurnIndex: 9,
      onFocusChain: false,
      latestTurnIndex: 9,
    });
    expect(r.level).toBe("ghost");
    expect(r.reason).toMatch(/8 turns/);
    expect(r.reason).toMatch(/never compresses below one full line/);
  });

  /**
   * ABNORMALITY RESISTS COLLAPSE — urgent cannot fold.
   *
   * This band used to hold an abnormal beat at GHOST once it was more than a
   * turn away. A failure compressed to one line among a column of one-liners
   * is a failure you have to go looking for, which is exactly what the user
   * reported ("not very visible except when clicking on it"). The whole
   * point of recording a failure is that finding it should not be work.
   */
  test("an abnormal beat is NEVER compressed, at any causal distance", () => {
    for (const turnIndex of [0, 1, 5, 8]) {
      const r = fisheyeLevel({
        beat: beat(turnIndex, "tool", true),
        focusTurnIndex: 9,
        onFocusChain: false,
        latestTurnIndex: 9,
      });
      expect(r.level, `abnormal beat ${9 - turnIndex} turns away must stay full`).toBe("full");
      expect(r.reason).toMatch(/abnormal/);
    }
  });

  test("…but a NORMAL beat at the same distance still collapses (the flag is what does it)", () => {
    const r = fisheyeLevel({
      beat: beat(1, "tool", false),
      focusTurnIndex: 9,
      onFocusChain: false,
      latestTurnIndex: 9,
    });
    // GHOST, not tick: a TOOL call's automatic floor is one full line — see
    // the long note in fisheye.ts, and the user's report that a ticked tool
    // call "shows as ultra collapsed … until I click on them". The point of
    // this test is unchanged: the abnormal flag, and nothing else, is what
    // held the beat above at `full`.
    expect(r.level).toBe("ghost");
    expect(r.level).not.toBe("full");
  });

  test("the tool floor is a floor for TOOLS, not a retreat from compressing", () => {
    // The mutation this guards: raising the floor for every kind would make
    // the test above pass while quietly turning the fisheye off. A beat that
    // is a single fact still ticks at the same distance.
    const r = fisheyeLevel({
      beat: beat(1, "check-delta", false),
      focusTurnIndex: 9,
      onFocusChain: false,
      latestTurnIndex: 9,
    });
    expect(r.level).toBe("tick");
  });

  test("every result carries a non-empty plain-words reason (salience law)", () => {
    for (const turn of [0, 3, 5, 9]) {
      for (const abnormal of [false, true]) {
        const r = fisheyeLevel({
          beat: beat(turn, "tool", abnormal),
          focusTurnIndex: 5,
          onFocusChain: false,
          latestTurnIndex: 9,
        });
        expect(r.reason.length).toBeGreaterThan(10);
      }
    }
  });

  test("manual override wins over every computed term, and says so", () => {
    setOverride("x", "expand");
    expect(overrideFor("x")).toBe("expand");
    clearOverride("x");
    expect(overrideFor("x")).toBeUndefined();
    setOverride("x", "expand");
    const r = fisheyeLevel({
      beat: beat(0, "tool"),
      focusTurnIndex: 9,
      onFocusChain: false,
      latestTurnIndex: 9,
      override: "expand",
    });
    expect(r.level).toBe("full");
    expect(r.reason).toMatch(/manual choice/);
    const c = fisheyeLevel({
      beat: beat(9, "turn", true),
      focusTurnIndex: 9,
      onFocusChain: true,
      latestTurnIndex: 9,
      override: "collapse",
    });
    expect(c.level).toBe("tick");
  });
});
