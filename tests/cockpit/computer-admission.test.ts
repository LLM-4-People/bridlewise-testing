// @vitest-environment node
/**
 * The finding admission controller (spec §4.6): one per seam, dwell ≥8s at
 * the desk line, dismissal learning (3× in a session → ask-only, recorded).
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  admitAtSeam,
  deskLine,
  dismissDeskLine,
  dismissalRecord,
  DISMISSALS_TO_RETIRE,
  DWELL_MS,
  isAskOnly,
  proposeDeskLine,
  recordDismissal,
  resetAdmission,
  scoreCandidate,
  type Candidate,
} from "../../src/cockpit/computer/admission.ts";
import type { FindingBody } from "../../src/cockpit/flow/types.ts";

function finding(kind: string, sentence = "s"): FindingBody {
  return {
    sentence,
    findingKind: kind,
    derivation: {
      method: "test join",
      steps: [{ source: "test", sourceId: "test", count: 1 }],
      asOf: 1,
    },
  };
}

beforeEach(() => resetAdmission());

describe("seam admission", () => {
  test("admits exactly one — highest score — and queues the rest", () => {
    const a: Candidate = { finding: finding("context-projection") };
    const b: Candidate = { finding: finding("turn-rollup") };
    const r = admitAtSeam([a, b]);
    expect(r.admitted).toBe(b); // turn-rollup outscores projection
    expect(r.queued).toEqual([a]);
  });

  test("abnormality boosts a candidate past a higher base", () => {
    const quiet: Candidate = { finding: finding("turn-rollup") };
    const alarmed: Candidate = { finding: finding("context-projection"), abnormal: true };
    expect(scoreCandidate(alarmed)).toBeGreaterThan(scoreCandidate(quiet));
  });

  test("an ask-only kind never self-docks", () => {
    for (let i = 0; i < DISMISSALS_TO_RETIRE; i += 1) recordDismissal("turn-rollup");
    expect(isAskOnly("turn-rollup")).toBe(true);
    const r = admitAtSeam([{ finding: finding("turn-rollup") }]);
    expect(r.admitted).toBeNull();
  });

  test("the dismissal record is inspectable", () => {
    recordDismissal("impact-reach");
    expect(dismissalRecord().get("impact-reach")).toBe(1);
  });
});

describe("desk line dwell (≥8s)", () => {
  test("an empty slot admits immediately; a fresh occupant blocks until dwell", () => {
    vi.useFakeTimers();
    try {
      expect(proposeDeskLine(finding("context-projection", "first"), 1000)).toBe(true);
      // 3s later: dwell not served — the newcomer queues.
      expect(proposeDeskLine(finding("context-projection", "second"), 4000)).toBe(false);
      expect(deskLine.get()!.finding.sentence).toBe("first");
      // After the dwell timer fires, the queued finding lands.
      vi.advanceTimersByTime(DWELL_MS);
      expect(deskLine.get()!.finding.sentence).toBe("second");
    } finally {
      vi.useRealTimers();
    }
  });

  test("after the dwell has been served, replacement is immediate", () => {
    expect(proposeDeskLine(finding("context-projection", "first"), 1000)).toBe(true);
    expect(proposeDeskLine(finding("context-projection", "second"), 1000 + DWELL_MS + 1)).toBe(true);
    expect(deskLine.get()!.finding.sentence).toBe("second");
  });

  test("dismissing the desk line records the kind; 3 dismissals retire it", () => {
    for (let i = 0; i < DISMISSALS_TO_RETIRE; i += 1) {
      proposeDeskLine(finding("context-projection"), i * (DWELL_MS + 1) + 1);
      dismissDeskLine();
    }
    expect(isAskOnly("context-projection")).toBe(true);
    expect(proposeDeskLine(finding("context-projection"), 10 * DWELL_MS)).toBe(false);
    expect(deskLine.get()).toBeNull();
  });
});
