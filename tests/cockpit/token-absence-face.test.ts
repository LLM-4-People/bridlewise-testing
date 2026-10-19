// @vitest-environment jsdom
/**
 * THE UNMEASURED TURN'S FACE — a settled model turn with no recorded usage
 * says so through the response grammar; it never renders a silent footer.
 *
 * The finding: a density edit (2026-09-13) removed the footer's absence line
 * and narrowed the footer to turns that already had something to show, so a
 * turn whose usage was never recorded rendered NO footer at all — absence
 * drawn as nothing, against DESIGN-COCKPIT-V2 "Absence renders as absence, in
 * plain words". Only the response-grammar source scan noticed (TurnBeat is a
 * converted surface); this suite is the behavioural witness, beside the other
 * TurnBeat faces (interrupted-turn-face, redaction-notice-face,
 * dedup-savings-face, model-provenance-owner, flow-steered-beat), each of
 * which charters a DIFFERENT face of the same component.
 *
 *   MUTATION: drop the footer's absence line (or gate the footer on having a
 *     number again) → the first arm reds; a second footer copy without it →
 *     the silent arm reds.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";

import TurnBeat from "../../src/cockpit/flow/TurnBeat.svelte";
import type { Beat } from "../../src/cockpit/flow/types.ts";

const ABSENT = "tokens not measured for this turn";

/** A settled model turn with the given recorded facts. */
function settled(turn: Partial<NonNullable<Beat["turn"]>>): Beat {
  return {
    id: "b-1",
    kind: "turn",
    parentId: "b-ask",
    turnIndex: 0,
    at: Date.UTC(2026, 8, 2, 17, 55, 0),
    abnormal: false,
    bleed: false,
    verbs: [],
    turn: { who: "model", sourceId: "row-1", text: "The fog lifted.", streaming: false, ...turn },
  };
}

afterEach(() => cleanup());

describe("the unmeasured turn's face", () => {
  test("no usage recorded: the footer says so through the grammar", () => {
    const { container } = render(TurnBeat, { props: { beat: settled({}) } });
    expect(container.querySelector(".footer")?.textContent).toContain(ABSENT);
  });

  test("a SILENT turn (it acted, said nothing) with a ttft and no usage says so too — one footer for both registers (a4-design M4)", () => {
    const { container } = render(TurnBeat, { props: { beat: settled({ text: "", firstOutputMs: 420 }) } });
    expect(container.querySelector(".turn.silent")).not.toBeNull();
    const footer = container.querySelector(".footer")?.textContent ?? "";
    expect(footer).toContain("ttft");
    expect(footer).toContain(ABSENT);
  });

  test("usage recorded: the measured numbers, never the absence", () => {
    const { container } = render(TurnBeat, { props: { beat: settled({ inputTokens: 12, outputTokens: 3 }) } });
    expect(container.textContent).not.toContain(ABSENT);
    expect(container.querySelector(".footer")?.textContent).toContain("↑12");
  });
});
