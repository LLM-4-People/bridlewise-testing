// @vitest-environment node
/**
 * Finding docking (spec §4.3 / §4.5): ask answers dock unconditionally
 * (the user asked); effect-seam findings go through admission — at most
 * one, parented to the effect beat, ask-only kinds refused.
 */
import { beforeEach, describe, expect, test } from "vitest";

import {
  dockAskFinding,
  dockEffectSeamFinding,
  resetDockCounter,
} from "../../src/cockpit/flow/dock.ts";
import { appendBeat, beatCount, clearLog, windowSlice } from "../../src/cockpit/flow/log.ts";
import {
  DISMISSALS_TO_RETIRE,
  recordDismissal,
  resetAdmission,
} from "../../src/cockpit/computer/admission.ts";
import type { Beat, FindingBody } from "../../src/cockpit/flow/types.ts";

function finding(kind: string, sentence = "computed sentence"): FindingBody {
  return {
    sentence,
    findingKind: kind,
    derivation: {
      method: "test join",
      steps: [{ source: "test", sourceId: "test.block", count: 2 }],
      asOf: 10,
    },
  };
}

function effectBeat(): Beat {
  return {
    id: "fx-1",
    kind: "effect",
    parentId: "tool-1",
    turnIndex: 3,
    at: 1,
    abnormal: false,
    bleed: true,
    verbs: [],
    effect: { path: "x.ts", producedBy: "tool-1" },
  };
}

beforeEach(() => {
  clearLog();
  resetAdmission();
  resetDockCounter();
});

describe("dockAskFinding", () => {
  test("docks at the end of the flow with the last beat's turn index", () => {
    appendBeat(effectBeat());
    const beat = dockAskFinding(finding("ask-answer"));
    expect(beat.kind).toBe("finding");
    expect(beat.turnIndex).toBe(3);
    expect(windowSlice(0, beatCount()).at(-1)!.id).toBe(beat.id);
  });
});

describe("dockEffectSeamFinding", () => {
  test("docks one finding parented to the effect beat", () => {
    appendBeat(effectBeat());
    const docked = dockEffectSeamFinding("fx-1", [{ finding: finding("impact-reach") }]);
    expect(docked).not.toBeNull();
    expect(docked!.parentId).toBe("fx-1");
    expect(docked!.turnIndex).toBe(3);
  });

  test("refuses when the host beat is unknown", () => {
    expect(dockEffectSeamFinding("nope", [{ finding: finding("impact-reach") }])).toBeNull();
  });

  test("an ask-only (dismissal-retired) kind never self-docks at the seam", () => {
    appendBeat(effectBeat());
    for (let i = 0; i < DISMISSALS_TO_RETIRE; i += 1) recordDismissal("impact-reach");
    expect(dockEffectSeamFinding("fx-1", [{ finding: finding("impact-reach") }])).toBeNull();
    expect(beatCount()).toBe(1);
  });
});
