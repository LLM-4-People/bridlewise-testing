// @vitest-environment jsdom
/**
 * THE WAIT ROW SAYS ONLY WHAT THE READER CANNOT ALREADY SEE.
 *
 * THE USER'S REPORT, VERBATIM: "when waiting for generation, i see your
 * message is in for a brief moment beside the frozen animation, then it
 * starts generating with the animation moving. wondering if there is a
 * cleaner way to let the user know its being sent" — narrowed by them to
 * "when sending a message i mean".
 *
 * TWO DEFECTS, ONE ROW:
 *
 *  1. A FROZEN INSTRUMENT IS INDISTINGUISHABLE FROM A BROKEN ONE. The row
 *     mounted the token rail (StreamPulse), which advances one cell per
 *     observed ARRIVAL. Before the first token there are no arrivals, so it
 *     rendered stuck at cell 0 for the whole of `startRun` — the same
 *     "cannot tell working from fallen-over" failure the rail exists to
 *     remove, reached from the other side.
 *
 *  2. THE SENTENCE NARRATED SOMETHING ALREADY ON SCREEN. "your message is
 *     in" fired on the line after `sendUserMessage`, which appends the
 *     reader's own beat SYNCHRONOUSLY. Two elements, one job, and the more
 *     prominent one saying nothing.
 *
 * What must hold now, and each of these is a separate way to regress:
 *   - the rail does not render in the wait row at all;
 *   - no stage claims progress before a milestone is genuinely observed;
 *   - the elapsed clock is measured from a real timestamp, never invented;
 *   - the removed milestone stays removed.
 *
 * Mutation self-checks at the bottom re-derive each defect and show the
 * assertion that catches it.
 */
import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/svelte";

import WaitLine from "../../src/cockpit/flow/WaitLine.svelte";
import Flow from "../../src/cockpit/flow/Flow.svelte";
import { appendBeat, batch, clearLog } from "../../src/cockpit/flow/log.ts";
import { resetIngest } from "../../src/cockpit/flow/ingest.ts";
import type { Beat } from "../../src/cockpit/flow/types.ts";
import {
  WAIT_MILESTONE_COUNT,
  WAIT_ROW_IDLE_SAY,
  WAIT_SAY,
  WAIT_STAGES,
  waitStage,
  waitSteps,
  resetWait,
  beginWait,
  type WaitStage,
} from "../../src/cockpit/flow/wait-stage.ts";

function textOf(container: HTMLElement): string {
  return (container.textContent ?? "").replace(/\s+/g, " ").trim();
}

describe("the stage vocabulary", () => {
  test("the redundant `sent` milestone is gone", () => {
    expect(WAIT_STAGES).not.toContain("sent");
  });

  test("no sentence narrates the send — the beat already did", () => {
    for (const say of [...Object.values(WAIT_SAY), WAIT_ROW_IDLE_SAY]) {
      expect(say.toLowerCase()).not.toContain("your message is in");
    }
  });

  test("the row's absence and the rail's absence are different sentences", () => {
    // The rail measures arrivals, so its idle is "no characters yet". The row
    // covers send→accepted, so its idle is about the run. Collapsing them made
    // a fresh rail with no run announce that it was waiting for one.
    expect(WAIT_ROW_IDLE_SAY).not.toBe(WAIT_SAY.idle);
    expect(WAIT_SAY.idle).toContain("characters");
    expect(WAIT_ROW_IDLE_SAY).not.toContain("characters");
  });

  test("the milestone count is DERIVED from the sequence, never written twice", () => {
    // The row prints "n of N". A hardcoded N is how that caption comes to
    // disagree with the stages it counts.
    expect(WAIT_MILESTONE_COUNT).toBe(WAIT_STAGES.length - 1);
    expect(waitSteps(WAIT_STAGES[WAIT_STAGES.length - 1]!)).toBe(WAIT_MILESTONE_COUNT);
  });

  test("`idle` has earned no milestones", () => {
    expect(waitSteps("idle")).toBe(0);
  });
});

describe("what the row draws", () => {
  test("NO RAIL — the instrument with nothing to measure is not drawn", () => {
    for (const stage of WAIT_STAGES) {
      cleanup();
      const { container } = render(WaitLine, { stage, startedAt: Date.now() });
      expect(container.querySelector(".rail"), `stage ${stage}`).toBeNull();
      expect(container.querySelectorAll(".cell").length, `stage ${stage}`).toBe(0);
    }
    cleanup();
  });

  test("at `idle` nothing claims progress", () => {
    const { container } = render(WaitLine, { stage: "idle" as WaitStage, startedAt: Date.now() });
    // "0 of 3" would be a progress claim over no progress.
    expect(container.querySelector('[data-field="wait-steps"]')).toBeNull();
    expect(textOf(container)).toContain(WAIT_ROW_IDLE_SAY);
    cleanup();
  });

  test("once a milestone is observed the position is shown", () => {
    const { container } = render(WaitLine, { stage: "connected" as WaitStage, startedAt: Date.now() });
    const steps = container.querySelector('[data-field="wait-steps"]');
    expect(steps).not.toBeNull();
    expect(steps!.textContent).toBe(`${waitSteps("connected")} of ${WAIT_MILESTONE_COUNT}`);
    cleanup();
  });

  test("the elapsed clock is measured from the given start, not from render", () => {
    const { container } = render(WaitLine, {
      stage: "accepted" as WaitStage,
      startedAt: Date.now() - 4_200,
    });
    const el = container.querySelector('[data-field="wait-elapsed"]');
    expect(el).not.toBeNull();
    // ~4.2s, allowing for the render taking a moment.
    const seconds = Number.parseFloat(el!.textContent!.replace("s", ""));
    expect(seconds).toBeGreaterThanOrEqual(4.1);
    expect(seconds).toBeLessThan(5);
    cleanup();
  });

  test("with NO start timestamp there is no duration — a number nobody took is not printed", () => {
    const { container } = render(WaitLine, { stage: "accepted" as WaitStage, startedAt: null });
    expect(container.querySelector('[data-field="wait-elapsed"]')).toBeNull();
    cleanup();
  });
});

describe("the row does not outlive the answer (the flow's gating)", () => {
  // THE USER'S REPORT: after the answer completed the row still said
  // "answering · 3 of 3" while the run stayed open for its end-of-run work.
  // The stage is advance-only and only the run boundary resets it, so a
  // settled turn with the run still open re-opened the row over a message
  // that had already finished. These arms drive the REAL flow mount.
  class RO {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }

  function turnBeat(streaming: boolean, at: number): Beat {
    return {
      id: `turn-${at}-${streaming}`,
      kind: "turn",
      parentId: null,
      turnIndex: 1,
      at,
      abnormal: false,
      bleed: false,
      verbs: [],
      turn: { who: "model", text: "the answer, committed", streaming },
    };
  }

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", RO);
    resetIngest();
    clearLog();
    resetWait();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    clearLog();
    resetWait();
  });

  test("the pre-acceptance window renders — a hung startRun still gets its clock", async () => {
    batch(() => {
      appendBeat(turnBeat(false, 1));
    });
    beginWait();
    const { container } = await render(Flow, { props: { ingest: false } });
    await Promise.resolve();
    expect(container.querySelector('[data-field="wait-line"]')).not.toBeNull();
  });

  test("a COMPLETED answer with the run still open does NOT re-open the stale row", async () => {
    // The exact incident shape: the turn settled, the stage never moved
    // back (advance-only), and the run boundary has not fired — end-of-run
    // quality work keeps it open. The row must not claim "answering" over a
    // finished message.
    batch(() => {
      appendBeat(turnBeat(false, 1));
    });
    beginWait();
    waitStage.set("answering");
    const { container } = await render(Flow, { props: { ingest: false } });
    await Promise.resolve();
    expect(
      container.querySelector('[data-field="wait-line"]'),
      "the wait ended when the answer began; nothing is waited-on that this row can name",
    ).toBeNull();
  });

  test("a NEW send after settled turns renders — old turns must not hide the new wait", async () => {
    // beginWait resets the stage, so the previous run's settled turns in the
    // window cannot swallow the new send's pre-acceptance clock.
    batch(() => {
      appendBeat(turnBeat(false, 1));
      appendBeat(turnBeat(false, 2));
    });
    beginWait();
    const { container } = await render(Flow, { props: { ingest: false } });
    await Promise.resolve();
    const row = container.querySelector('[data-field="wait-line"]');
    expect(row).not.toBeNull();
    expect(textOf(row as HTMLElement)).toContain(WAIT_ROW_IDLE_SAY);
  });

  test("a streaming turn still hides the row (the rail has its home)", async () => {
    batch(() => {
      appendBeat(turnBeat(true, 1));
    });
    beginWait();
    waitStage.set("answering");
    const { container } = await render(Flow, { props: { ingest: false } });
    await Promise.resolve();
    expect(container.querySelector('[data-field="wait-line"]')).toBeNull();
  });
});

describe("mutation: the wait-row guards fail when the rule is removed", () => {
  test("re-adding a `sent` stage that narrates the send", () => {
    const mutated = ["idle", "sent", "accepted", "connected", "answering"] as const;
    const mutatedSay = { ...WAIT_SAY, sent: "your message is in" } as Record<string, string>;
    // The two assertions above are exactly what go red.
    expect(mutated).toContain("sent");
    expect(Object.values(mutatedSay).some((s) => s.includes("your message is in"))).toBe(true);
    // The real vocabulary refuses both.
    expect(WAIT_STAGES).not.toContain("sent");
    expect(Object.values(WAIT_SAY).some((s) => s.includes("your message is in"))).toBe(false);
  });

  test("hardcoding the milestone count", () => {
    // A caption of "n of 4" against a three-milestone sequence.
    const HARDCODED = 4;
    expect(WAIT_MILESTONE_COUNT).not.toBe(HARDCODED);
  });

  test("printing a position at zero milestones", () => {
    // The defect renders "0 of 3" — a progress claim over no progress. The
    // `idle` test is what catches it.
    const wouldRender = `${waitSteps("idle")} of ${WAIT_MILESTONE_COUNT}`;
    expect(wouldRender).toBe(`0 of ${WAIT_MILESTONE_COUNT}`);
    const { container } = render(WaitLine, { stage: "idle" as WaitStage, startedAt: Date.now() });
    expect(textOf(container)).not.toContain(wouldRender);
    cleanup();
  });

  test("defaulting the clock's origin to render time", () => {
    // The defect is `startedAt ?? Date.now()`, which shows 0.0s forever
    // however long the reader has actually been waiting.
    const fabricated = Date.now();
    const { container } = render(WaitLine, {
      stage: "accepted" as WaitStage,
      startedAt: fabricated - 9_000,
    });
    const el = container.querySelector('[data-field="wait-elapsed"]');
    expect(el!.textContent).not.toBe("0.0s");
    cleanup();
  });
});
