// @vitest-environment jsdom
/**
 * THE UNANSWERED TURN'S FACE — a row that started, streamed, and died
 * mid-stream must render its ending, not render as nothing.
 *
 * The finding (UIE-076, drive 12): a 900-word story run died when the dev
 * server was stopped mid-stream (~678 chars already streamed at 302 c/s);
 * after the server returned and the page reloaded, the turn read as NEVER
 * ANSWERED — no partial text (text is persisted at finish, never
 * incrementally, so the words died with the process), no error beat, no
 * incomplete sentence. The history tail was an EMPTY assistant row, and the
 * flow HIDES an empty turn outright, so the turn left no trace at all. The
 * honest face — what the record can truly say — is that the run ended
 * before this answer was kept (a cancel and a server death write the same
 * nothing, so the face names the shared fact, never a guessed cause).
 *
 * §41's search, stated: the silent-turn hiding rule has no subject-first
 * charter — `rendersInFlow` appears in three suites only as a fixture
 * precondition ("the fixture must actually be a hidden beat"), and no
 * existing charter would lead a reader to expect a red on this defect; the
 * face suites that render TurnBeat (redaction-notice-face, dedup-savings-
 * face, model-provenance-owner, flow-steered-beat) each charter a DIFFERENT
 * face of the same component (the input's masking, the savings, the model
 * name, the steered note) and none covers the turn's ending. This suite
 * stands beside them the way redaction-notice-face stood beside its
 * neighbours, and owns the UIE-076 face end to end: the visibility rule
 * (beat-state.ts `rendersInFlow`), the rendered line (TurnBeat.svelte's
 * quiet register), and the store-level verdicts' contract live in
 * tests/unit/chat-messages.test.ts, the beat forwarding in
 * flow-ingest.test.ts, the state colour in flow-bubble-system.test.ts, and
 * the reconcile that SETTLES the verdict in tests/unit/client.test.ts.
 *
 *   MUTATION (a): drop the interrupted exception in `rendersInFlow` → the
 *     visibility arm reds while the record still carries the verdict —
 *     the finding's own shape, the row rendering nothing.
 *   MUTATION (b): drop the `silentLine` branch that reads the verdict →
 *     the rendered-line arm reds while the beat still carries it.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";

import TurnBeat from "../../src/cockpit/flow/TurnBeat.svelte";
import { rendersInFlow } from "../../src/cockpit/flow/beat-state.ts";
import type { Beat } from "../../src/cockpit/flow/types.ts";

const REASON = "the run ended before this answer was kept";

/** The beat shape the ingest builds for a row the reconcile settled: the
 * drive's empty assistant row carrying its verdict — no text, no reasoning,
 * no footer, nothing but the ending. */
function interruptedTurn(): Beat {
  return {
    id: "b-dead-1",
    kind: "turn",
    parentId: "b-ask",
    turnIndex: 0,
    at: Date.UTC(2026, 8, 2, 17, 55, 0),
    abnormal: true,
    bleed: false,
    verbs: [],
    turn: {
      who: "model",
      sourceId: "row-died-mid-stream",
      text: "",
      streaming: false,
      incompleteReason: REASON,
    },
  };
}

afterEach(() => cleanup());

describe("the unanswered turn's face", () => {
  test("an interrupted turn RENDERS — hiding it would erase the turn entirely", () => {
    const beat = interruptedTurn();
    expect(
      rendersInFlow(beat),
      "the turn has no beats beneath it and no answer — the row IS the only trace it happened",
    ).toBe(true);
    // The contrast that makes the exception honest: the SAME row without
    // its verdict is the silent turn the flow hides by design (its content
    // is told by the beats directly beneath it). The verdict is the
    // difference between a caption on a picture and a picture that is not
    // there.
    const unmarked = { ...beat, turn: { ...beat.turn! } };
    delete (unmarked.turn as { incompleteReason?: string }).incompleteReason;
    expect(rendersInFlow(unmarked), "the fixture must actually be a hidden beat without the verdict").toBe(false);
  });

  test("the quiet line speaks the verdict, verbatim — never prose, never a guessed cause", async () => {
    const { container } = render(TurnBeat, { props: { beat: interruptedTurn() } });
    await new Promise((r) => setTimeout(r, 0));
    const line = container.querySelector(".silent-line");
    expect(line, "the silent register renders — a turn with no words").not.toBeNull();
    expect(line!.textContent).toBe(REASON);
    expect(
      container.querySelector(".bubble"),
      "not a bubble: nothing here is the model's own words",
    ).toBeNull();
  });
});
