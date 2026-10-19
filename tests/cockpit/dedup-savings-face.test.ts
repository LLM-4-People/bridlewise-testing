// @vitest-environment jsdom
/**
 * THE TURN FOOTER'S DEDUP SAVINGS FACE — the wire's own numbers, rendered.
 *
 * UIE-072: the server folds repeated passages out of a call's input and
 * emits the measurement on the run stream ("dedup": chars before/after,
 * the reduction pct, blocks removed), and no surface rendered it — the
 * user could make the system save tokens and never see that it did. The
 * savings belong to the call whose input was folded, so the face renders
 * on that call's own record: the turn footer, beside the ↑input-tokens
 * fact it explains. The provider-side precedent reports per-request
 * savings the same way (cached tokens ride each response's `usage`), and
 * the record carries the fact (accumulated + persisted in the message
 * metadata, the response-headers pattern) so the live and reloaded views
 * of the same turn agree.
 *
 * §41's search, stated: the footer's OTHER facts have owners —
 * model-provenance-owner.test.ts charters the model name on this same
 * component, flow-turn-timing.test.ts charters the latency label — and
 * neither charter covers the savings face; this suite stands beside them
 * the way rewind-confirm-face and effect-beat-diff-face did (jsdom for a
 * rendered face, node for the store-level owners).
 *
 *   MUTATION (a): drop the `dedupSay` span from the footer → the renders
 *     arm reds while the record still carries the fact.
 *   MUTATION (b): attach without consuming the buffer (client.ts) → the
 *     stale-inheritance arm in tests/unit/client.test.ts reds — a turn
 *     whose call removed nothing inherits the previous turn's savings.
 *   MUTATION (c): render the face on `applied: false` (drop the applied
 *     gate) → the applied arm below reds.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";

import TurnBeat from "../../src/cockpit/flow/TurnBeat.svelte";
import type { Beat } from "../../src/cockpit/flow/types.ts";
import type { DedupSummary } from "../../src/state/dedup.ts";

/** The drive-11 capture, verbatim — the wire's own numbers. */
const FOLDED: DedupSummary = {
  applied: true,
  originalChars: 2440,
  dedupedChars: 1845,
  charReductionPct: 24.39,
  removedBlocks: 5,
  removedLines: 31,
  messageCount: 5,
};

/** The face the footer must render for FOLDED — exact, so a rewording or a
 * dropped number is a red, not a judgment call. */
const FACE_FOLDED =
  "dedup −24.39% · 2,440→1,845 chars · 5 repeated blocks folded";

function modelTurn(opts: {
  dedupSummary?: DedupSummary;
  silent?: boolean;
  tokens?: boolean;
}): Beat {
  return {
    id: "b-1",
    kind: "turn",
    at: Date.UTC(2026, 8, 2, 12, 0, 0),
    parentId: null,
    abnormal: false,
    bleed: false,
    turn: {
      who: "model",
      // A silent turn is one that acted without commenting — its content
      // is the tool beats below it, which is the drive-11 shape the
      // savings fired on.
      text: opts.silent ? "" : "done.",
      streaming: false,
      ...(opts.tokens === false ? {} : { inputTokens: 12, outputTokens: 3 }),
      ...(opts.dedupSummary !== undefined ? { dedupSummary: opts.dedupSummary } : {}),
    },
  } as unknown as Beat;
}

afterEach(() => {
  cleanup();
});

describe("the turn footer's dedup savings face", () => {
  test("renders the wire's own numbers from the turn's own record", () => {
    const { container } = render(TurnBeat, { beat: modelTurn({ dedupSummary: FOLDED }) });

    expect(container.textContent).toContain(FACE_FOLDED);
    // The chars are stated AS chars — the provider's token count beside
    // them measures the whole request in a different unit, and the face
    // must never let the two be read as one measurement.
    expect(container.textContent).toContain("chars");
  });

  test("a turn whose call removed nothing renders no savings face — absence, never a zero", () => {
    const { container } = render(TurnBeat, { beat: modelTurn({}) });

    expect(container.textContent).not.toContain("dedup");
    expect(container.textContent).not.toContain("−0%");
    expect(container.textContent).not.toContain("folded");
  });

  test("an applied=false summary renders no savings face", () => {
    // The server does not send applied:false today (no event fires when
    // nothing was removed), but the wire's own field says it may — and a
    // face that rendered savings for a non-applied summary would be
    // exactly the fabricated-zero class this product refuses.
    const { container } = render(TurnBeat, {
      beat: modelTurn({ dedupSummary: { ...FOLDED, applied: false } }),
    });

    expect(container.textContent).not.toContain("dedup");
  });

  test("a silent turn's footer carries the savings too — the drive-11 shape", () => {
    // The savings fired on a turn whose content was its tool calls; a
    // silent turn is still a measured call, and its footer is where its
    // facts live.
    const { container } = render(TurnBeat, {
      beat: modelTurn({ dedupSummary: FOLDED, silent: true }),
    });

    expect(container.textContent).toContain("the model acted without commenting");
    expect(container.textContent).toContain(FACE_FOLDED);
  });

  test("the block count reads as one block, not one blocks", () => {
    const { container } = render(TurnBeat, {
      beat: modelTurn({
        dedupSummary: {
          applied: true,
          originalChars: 500,
          dedupedChars: 250,
          charReductionPct: 50,
          removedBlocks: 1,
          removedLines: 4,
          messageCount: 2,
        },
      }),
    });

    expect(container.textContent).toContain("1 repeated block folded");
    expect(container.textContent).not.toContain("1 repeated blocks folded");
  });
});
