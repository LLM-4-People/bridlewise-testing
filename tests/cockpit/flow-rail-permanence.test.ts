// @vitest-environment jsdom
/**
 * THE RAIL IS LIVE; TOK/S STAYS.
 *
 * The rail walks while the model is answering. When the turn completes it
 * leaves — an arrival instrument on a finished turn would claim a stream
 * that is over. The measured rate stays in the footer as `tok/s`, including
 * across a page refresh (the recorded rate, not the live window).
 *
 * THE TRAP THIS FILE EXISTS FOR is mixing those two. An earlier design kept
 * the rail after finish so the count would remain readable. The count is
 * not the measurement the reader asked to keep; tok/s is. Gating the rail
 * on observed characters (rather than on `streaming`) is how a finished
 * turn kept animating, and how a refresh of a completed turn looked empty
 * of both the rate AND the rail.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";

import TurnBeatProbe from "./fixtures/TurnBeatProbe.svelte";
import { resetThinkingFolds } from "../../src/cockpit/flow/thinking-fold.ts";
import {
  noteOutputDelta,
  noteToolInputDelta,
  noteTurnStart,
  resetTurnTimings,
} from "../../src/cockpit/flow/turn-timing.ts";
import {
  appendStreamingTail,
  clearMessages,
  commitStreamingTail,
  setStreaming,
  streamingTail,
} from "../../src/state/chat-messages.ts";
import type { Beat, TurnBody } from "../../src/cockpit/flow/types.ts";

beforeEach(() => {
  clearMessages();
  resetTurnTimings();
  resetThinkingFolds();
  setStreaming(false);
});
afterEach(() => {
  cleanup();
  clearMessages();
  resetTurnTimings();
  resetThinkingFolds();
  setStreaming(false);
});

function turnBeat(turn: Partial<TurnBody>, id = "b-rail"): Beat {
  return {
    id,
    kind: "turn",
    parentId: null,
    turnIndex: 0,
    at: 1,
    abnormal: false,
    bleed: false,
    verbs: [],
    turn: { who: "model", text: "", streaming: false, ...turn },
  };
}

function mount(initial: Beat): { container: HTMLElement; set: (b: Beat) => void } {
  let set: (b: Beat) => void = () => undefined;
  const { container } = render(TurnBeatProbe, {
    props: { initial, register: (fn: (b: Beat) => void) => (set = fn) },
  });
  return { container, set: (b: Beat) => set(b) };
}

const railOf = (c: HTMLElement): Element | null => c.querySelector(".rail-group");
const charsOf = (c: HTMLElement): string =>
  c.querySelector('[data-field="chars"]')?.textContent ?? "";

describe("the rail is the live wait; tok/s is the kept measurement", () => {
  test("a finished turn whose arrivals WERE observed draws NO rail", async () => {
    // MUTATION: keep gating `showRail` on `observed.chars > 0` and the
    // animation stays on a completed turn.
    noteTurnStart("msg-done", 0);
    noteOutputDelta("msg-done", "answer", 10, 28);
    const { container } = mount(
      turnBeat({ sourceId: "msg-done", text: "the whole reply, twenty-four", tokPerSec: 41 }),
    );
    await tick();
    expect(railOf(container), "the rail leaves when the turn completes").toBeNull();
    expect(container.querySelector('[data-field="tps"]')?.textContent).toContain("41 tok/s");
  });

  test("A RE-READ TURN DRAWS NO RAIL — its words arrived in one response, not as a stream", async () => {
    // THE FABRICATION THIS PINS. `observed.chars` briefly read
    // `Math.max(seen.chars, railTail.length)`, substituting the committed
    // text's length for an arrival count so the number would not drop on a
    // re-read. A conversation loaded from the database had NO arrivals in this
    // session — its words came back in one HTTP response — so the rail lit its
    // cells and printed a figure for a stream that never happened.
    //
    // MUTATION: restore the `Math.max(..., text.length)` fallback and this
    // fails: a turn nobody watched arrive claims 28 characters of arrivals.
    const { container } = mount(turnBeat({ sourceId: "msg-reloaded", text: "the whole reply, twenty-four" }));
    await tick();
    expect(
      railOf(container),
      "no arrivals were observed for this turn, so no arrival instrument is drawn",
    ).toBeNull();
  });

  test("the rail leaves at finish; tok/s stays on the footer", async () => {
    setStreaming(true);
    noteTurnStart("msg-commit", 0);
    const { container, set } = mount(
      turnBeat({ sourceId: "msg-commit", text: "", streaming: true }),
    );
    noteOutputDelta("msg-commit", "answer", 10, 31);
    appendStreamingTail("a streamed reply of some length");
    await tick();
    expect(railOf(container), "the rail walks while the turn streams").not.toBeNull();
    expect(charsOf(container)).toContain("31");

    const committed = streamingTail.get();
    commitStreamingTail();
    setStreaming(false);
    set(turnBeat({ sourceId: "msg-commit", text: committed, streaming: false, tokPerSec: 22.5 }));
    await tick();
    expect(railOf(container), "the animation is gone once the turn completes").toBeNull();
    expect(container.querySelector('[data-field="tps"]')?.textContent).toContain("22.5 tok/s");
  });

  test("NO EMPTY BUBBLE BEFORE THE FIRST CHARACTER — the rail holds that window", async () => {
    // THE REGRESSION THIS PINS, reported as: "now it shows a empty chat before
    // the animation". Between the reply's row appearing and its first
    // character, a streaming model turn has no words (correctly — none have
    // arrived), no measured numbers, and no thinking. If the rail is gated on
    // characters having arrived, the bubble renders EMPTY: exactly the shape
    // two earlier rulings already deleted from this component.
    //
    // MUTATION: gate `showRail` on `observed.chars > 0` alone — which is what
    // shipped and what was reported — and this fails on both assertions.
    setStreaming(true);
    const { container } = mount(turnBeat({ text: "", streaming: true }));
    await tick();

    const bubble = container.querySelector(".bubble");
    expect(bubble, "a streaming turn still draws its bubble").not.toBeNull();
    expect(
      railOf(container),
      "the rail must fill the pre-first-character window, or the bubble is empty",
    ).not.toBeNull();
    // And it says what is actually known — the milestone, not a fabricated
    // count (wait-stage.ts owns those sentences).
    expect((bubble!.textContent ?? "").trim().length).toBeGreaterThan(0);
  });

  test("a turn that received NOTHING draws no instrument", async () => {
    // Absence renders as absence — a rail reading zero would assert a
    // measurement nobody took.
    const { container } = mount(turnBeat({ text: "" }));
    await tick();
    expect(railOf(container)).toBeNull();
  });

  test("your own turn never carries one", async () => {
    const { container } = mount(turnBeat({ who: "you", text: "do the thing" }));
    await tick();
    expect(railOf(container)).toBeNull();
  });

  test("thinking counts toward the characters a turn received WHILE it streams", async () => {
    noteTurnStart("msg-think", 0);
    noteOutputDelta("msg-think", "thinking", 5, 14);
    noteOutputDelta("msg-think", "answer", 10, 2);
    const { container } = mount(
      turnBeat({ sourceId: "msg-think", text: "hi", reasoning: "a longer think", streaming: true }),
    );
    await tick();
    expect(charsOf(container)).toContain("16");
  });

  test("a re-read finished turn keeps tok/s and draws no rail", async () => {
    // Page refresh: no arrival record, no live window. The recorded rate
    // is the measurement that must survive.
    const { container } = mount(
      turnBeat({
        sourceId: "msg-reloaded-rate",
        text: "the whole reply",
        reasoning: "a long think",
        tokPerSec: 18.4,
      }),
    );
    await tick();
    expect(railOf(container)).toBeNull();
    expect(container.querySelector('[data-field="tps"]')?.textContent).toContain("18.4 tok/s");
  });

  test("A TOOL CALL'S ARGUMENTS REACH THE RAIL — end to end, through the beat", async () => {
    // THE REPORTED FREEZE, closed at the last link in the chain. `run-stream`
    // counts the argument frames and `turn-timing` holds them, but they only
    // matter if the component actually reads them: TurnBeat has to join its
    // beat to that record (`turn.sourceId`) rather than measuring the answer
    // tail it can see.
    //
    // MUTATION: feed StreamPulse `railTail.length` instead of `observed.chars`
    // in TurnBeat — the pre-existing behaviour — and the count below stays at
    // the preamble's length while 40,000 characters of artifact stream past.
    noteTurnStart("msg-artifact", 0);
    noteOutputDelta("msg-artifact", "answer", 10, 500); // the prose preamble
    const { container, set } = mount(
      turnBeat({ sourceId: "msg-artifact", text: "", streaming: true }),
    );
    await tick();
    expect(charsOf(container)).toContain("500");

    // The artifact's HTML, as tool-call arguments — characters that reach no
    // store, produce no prose, and would otherwise be invisible.
    for (let i = 0; i < 40; i += 1) {
      noteToolInputDelta("msg-artifact", 1_000, 20 + i);
    }
    // The beat itself has not changed — that is the point: the arrival signal
    // is what re-renders the rail, not a rebuilt beat.
    set(turnBeat({ sourceId: "msg-artifact", text: "", streaming: true }));
    await tick();
    await tick();
    expect(
      charsOf(container),
      "the rail must be counting the tool call's input, not sitting at the preamble",
    ).toContain("40,500");
    expect(container.querySelector('[data-field="channel"]')?.textContent).toBe(
      "a tool call's input",
    );
  });
});
