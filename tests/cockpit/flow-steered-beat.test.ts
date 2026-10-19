// @vitest-environment jsdom
/**
 * THE STEERED USER TURN, RENDERED (the flow half of the steer routing).
 *
 * A message sent while the conversation's run is live renders as the reader's
 * own words carrying their queued state: "steered the live run — the model
 * receives this after the current turn". That line is what stops the next
 * model turn from reading as the reply to a NEW run, which is precisely the
 * confusion the marking exists to prevent.
 *
 * No existing suite owns user-turn rendering (the thinking-fold and rail
 * files mount TurnBeat for their own instruments; flow-ingest owns the
 * message→beat mapping, which a sibling arm covers) — so the render arm
 * lives here, against the same TurnBeatProbe fixture.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";

import TurnBeatProbe from "./fixtures/TurnBeatProbe.svelte";
import type { Beat } from "../../src/cockpit/flow/types.ts";

function yourTurn(steered: boolean): Beat {
  return {
    id: "b-msg-steer",
    kind: "turn",
    parentId: null,
    turnIndex: 0,
    at: 1,
    abnormal: false,
    bleed: false,
    verbs: [],
    turn: {
      who: "you",
      text: "use the other approach",
      streaming: false,
      ...(steered ? { steered: true } : {}),
    },
  };
}

function mount(beat: Beat): HTMLElement {
  const { container } = render(TurnBeatProbe, {
    props: { initial: beat, register: () => undefined },
  });
  return container;
}

afterEach(() => {
  cleanup();
});

describe("a steered user turn states what it is doing", () => {
  test("the queued-state line renders on a STEERED turn and not on a plain one", async () => {
    const steered = mount(yourTurn(true));
    await tick();
    const note = steered.querySelector('[data-field="steered-note"]');
    expect(note).not.toBeNull();
    expect((note?.textContent ?? "").trim()).toContain("steered the live run");
    expect((note?.textContent ?? "").trim()).toContain("after the current turn");

    // MUTATION: render the line unconditionally and this reds — a plain
    // message claiming to have steered a run is the same lie in the other
    // direction.
    const plain = mount(yourTurn(false));
    await tick();
    expect(plain.querySelector('[data-field="steered-note"]')).toBeNull();
  });
});
