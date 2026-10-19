// @vitest-environment jsdom
/**
 * THE THINKING BLOCK — expanded while the model thinks, folded when it answers.
 *
 * THE USER'S RULING, VERBATIM: "when chatting with a thinking model, its
 * thinking block is collapsed, i want its thinking to be expanded from the
 * moment it starts thinking until it starts producing the real answer".
 *
 * Every claim below is about BEHAVIOUR the reader can observe, and each block
 * names the exact source edit that breaks it so a later reader can check the
 * guard bites rather than trust that it does. The mutations were run: each was
 * applied to the real source, confirmed to change the source, observed to fail
 * this file, and reverted.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";

import TurnBeatProbe from "./fixtures/TurnBeatProbe.svelte";
import {
  answerBegun,
  autoOpen,
  resetThinkingFolds,
  setThinkingFold,
  thinkingFoldPreference,
  thinkingOpen,
  thinkingState,
} from "../../src/cockpit/flow/thinking-fold.ts";
import {
  appendStreamingTail,
  clearMessages,
  setStreaming,
} from "../../src/state/chat-messages.ts";
import type { Beat, TurnBody } from "../../src/cockpit/flow/types.ts";

beforeEach(() => {
  resetThinkingFolds();
  clearMessages();
  setStreaming(false);
});
afterEach(() => {
  cleanup();
  resetThinkingFolds();
  clearMessages();
  setStreaming(false);
});

function turnBeat(turn: Partial<TurnBody>, id = "b-1"): Beat {
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

// ── The rule, in isolation ────────────────────────────────────────────────

describe("the three states are read from the record", () => {
  test("a model that produced NO thinking has no block at all", () => {
    // §1.1: never a fold for content nobody sent.
    // MUTATION: drop the `(turn.reasoning ?? "").length === 0` branch from
    // `thinkingState` and every ordinary turn grows an empty thinking block.
    expect(thinkingState(turnBeat({ text: "hello", streaming: false }))).toBe("absent");
    expect(thinkingState(turnBeat({ text: "", streaming: true }))).toBe("absent");
  });

  test("your OWN turn never carries a thinking block", () => {
    const yours = turnBeat({ who: "you", text: "hi", reasoning: "nope" });
    expect(thinkingState(yours)).toBe("absent");
  });

  test("thinking arriving while nothing has been answered is LIVE", () => {
    // MUTATION: return "settled" from the live branch of `thinkingState` and
    // the block never auto-opens — the reported defect, restored.
    const beat = turnBeat({ reasoning: "let me see…", streaming: true, text: "" });
    expect(thinkingState(beat)).toBe("live");
    expect(autoOpen(beat)).toBe(true);
  });

  test("the ANSWER beginning settles it — and that is an observed frame", () => {
    // MUTATION: make `answerBegun` return false always and the block stays
    // open through the whole answer, which is the opposite defect.
    const beat = turnBeat({ reasoning: "…", streaming: true, text: "", answerStarted: true });
    expect(thinkingState(beat)).toBe("settled");
    expect(autoOpen(beat)).toBe(false);
  });

  test("committed answer text settles it too — for a turn re-read from the database", () => {
    // A conversation loaded from history has no `answerStarted` (it is a live
    // measurement, not a persisted one). The committed text is the same fact,
    // recorded. MUTATION: drop the `turn.text.length > 0` term from
    // `answerBegun` and every reloaded thinking turn opens its block on sight.
    const beat = turnBeat({ reasoning: "…", streaming: false, text: "the answer" });
    expect(answerBegun(beat.turn!)).toBe(true);
    expect(thinkingState(beat)).toBe("settled");
  });

  test("a turn that ENDED without answering settles — the turn ended, not the thinking", () => {
    // The model thought, then called tools. Nothing here claims the thinking
    // was complete; the stream said the TURN was over (its finish frame is what
    // clears `streaming`). MUTATION: drop the `turn.streaming ?` ternary and
    // the block stays open forever on a tool-only turn.
    const beat = turnBeat({ reasoning: "…", streaming: false, text: "" });
    expect(thinkingState(beat)).toBe("settled");
  });
});

// ── An explicit action always wins, per beat ──────────────────────────────

describe("the reader's own decision outlives every automatic transition", () => {
  test("collapsing MID-THINK survives the answer beginning", () => {
    // THE RULE THAT MAKES THIS NOT ANNOYING. MUTATION: make `thinkingOpen`
    // return `autoOpen(beat)` and ignore the preference — the auto-collapse
    // then "un-collapses" nothing, but the NEXT live turn re-expands what the
    // reader shut, which is the surface undoing their decision.
    const thinking = turnBeat({ reasoning: "…", streaming: true, text: "" });
    expect(thinkingOpen(thinking)).toBe(true);

    setThinkingFold("b-1", false);
    expect(thinkingOpen(thinking)).toBe(false);

    // The answer begins. Nothing may re-open it, and the auto-collapse must
    // not "un-collapse" it either.
    const answering = turnBeat({ reasoning: "…", streaming: true, text: "", answerStarted: true });
    expect(thinkingOpen(answering)).toBe(false);

    // And it is still closed after the turn ends.
    expect(thinkingOpen(turnBeat({ reasoning: "…", streaming: false, text: "done" }))).toBe(false);
  });

  test("expanding AFTER the answer arrived stays expanded", () => {
    const settled = turnBeat({ reasoning: "…", streaming: false, text: "done" });
    expect(thinkingOpen(settled)).toBe(false);
    setThinkingFold("b-1", true);
    expect(thinkingOpen(settled)).toBe(true);
    // Nothing about the beat changing re-closes it.
    expect(thinkingOpen(turnBeat({ reasoning: "……", streaming: false, text: "done!" }))).toBe(true);
  });

  test("the preference is PER BEAT, never global", () => {
    // MUTATION: key `preferences` on a constant instead of the beat id and
    // this fails — one message's decision would speak for every message.
    setThinkingFold("b-1", false);
    const other = turnBeat({ reasoning: "…", streaming: true, text: "" }, "b-2");
    expect(thinkingFoldPreference("b-2")).toBeUndefined();
    expect(thinkingOpen(other)).toBe(true);
  });

  test("a beat with no expressed preference follows the auto rule", () => {
    expect(thinkingFoldPreference("b-1")).toBeUndefined();
    expect(thinkingOpen(turnBeat({ reasoning: "…", streaming: true, text: "" }))).toBe(true);
    expect(thinkingOpen(turnBeat({ reasoning: "…", streaming: false, text: "x" }))).toBe(false);
  });
});

// ── What the reader actually sees ─────────────────────────────────────────

function mount(initial: Beat): { container: HTMLElement; set: (b: Beat) => void } {
  let set: (b: Beat) => void = () => undefined;
  const { container } = render(TurnBeatProbe, {
    props: { initial, register: (fn: (b: Beat) => void) => (set = fn) },
  });
  return { container, set: (b: Beat) => set(b) };
}

function bodyOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-field="thinking"]');
}

function gripOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[data-field="thinking-grip"]');
}

describe("on screen: the block opens on its own and folds on its own", () => {
  test("thinking streams EXPANDED, then collapses when the answer starts", async () => {
    // THE WHOLE REQUEST, end to end, through the real component.
    // MUTATION: revert TurnBeat to the old `let showReasoning = $state(false)`
    // fold and the first assertion fails — that IS the reported defect.
    setStreaming(true);
    const { container, set } = mount(
      turnBeat({ reasoning: "step one", streaming: true, text: "" }),
    );
    await tick();
    expect(bodyOf(container), "thinking must be open the moment it starts").not.toBeNull();
    expect(bodyOf(container)!.textContent).toContain("step one");
    expect(gripOf(container)!.getAttribute("aria-expanded")).toBe("true");

    // More thinking arrives — still open, and the new text is shown.
    set(turnBeat({ reasoning: "step one step two", streaming: true, text: "" }));
    await tick();
    expect(bodyOf(container)!.textContent).toContain("step two");

    // The first ANSWER token lands (an observed `text_delta`, carried on the
    // beat by turn-timing.ts → ingest.ts).
    set(turnBeat({ reasoning: "step one step two", streaming: true, text: "", answerStarted: true }));
    await tick();
    expect(bodyOf(container), "the answer starting must fold the thinking away").toBeNull();
    expect(gripOf(container), "…and it must stay reachable").not.toBeNull();
    expect(gripOf(container)!.getAttribute("aria-expanded")).toBe("false");
  });

  test("a user collapse mid-think is NOT undone by the answer starting", async () => {
    setStreaming(true);
    const { container, set } = mount(
      turnBeat({ reasoning: "thinking hard", streaming: true, text: "" }),
    );
    await tick();
    expect(bodyOf(container)).not.toBeNull();

    gripOf(container)!.click();
    await tick();
    expect(bodyOf(container), "the reader shut it").toBeNull();

    set(turnBeat({ reasoning: "thinking hard", streaming: true, text: "", answerStarted: true }));
    await tick();
    expect(bodyOf(container), "the auto-collapse must not un-collapse it").toBeNull();

    set(turnBeat({ reasoning: "thinking hard", streaming: false, text: "the answer" }));
    await tick();
    expect(bodyOf(container), "nothing may re-expand it").toBeNull();
  });

  test("a user expand after the answer arrived stays expanded", async () => {
    const { container, set } = mount(
      turnBeat({ reasoning: "thought about it", streaming: false, text: "the answer" }),
    );
    await tick();
    expect(bodyOf(container), "settled turns rest folded, as before").toBeNull();

    gripOf(container)!.click();
    await tick();
    expect(bodyOf(container)).not.toBeNull();

    // A later re-render of the same beat (verbs wired, tokens attached…)
    // must not close what the reader opened.
    set(turnBeat({ reasoning: "thought about it", streaming: false, text: "the answer", outputTokens: 12 }));
    await tick();
    expect(bodyOf(container), "the reader opened it").not.toBeNull();
  });

  test("no thinking block is drawn for a model that produced none", async () => {
    // NEVER SHOW A THINKING BLOCK FOR A MODEL THAT PRODUCED NO THINKING.
    setStreaming(true);
    const { container } = mount(turnBeat({ streaming: true, text: "" }));
    await tick();
    expect(gripOf(container)).toBeNull();
    expect(bodyOf(container)).toBeNull();
  });

  test("a thinking-only turn draws no empty answer box above its block", async () => {
    // The gap that would otherwise sit where the answer will go.
    setStreaming(true);
    const { container } = mount(turnBeat({ reasoning: "…", streaming: true, text: "" }));
    await tick();
    expect(container.querySelector(".body")).toBeNull();
    appendStreamingTail("Now the answer.");
    await tick();
    expect(container.querySelector(".body")).not.toBeNull();
  });
});
