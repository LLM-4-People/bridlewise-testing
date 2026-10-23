// @vitest-environment jsdom
/**
 * THE TURN FOOTER'S MASKED-INPUT FACE — the wire's own numbers, rendered.
 *
 * The round-27 residual (UIE-075, the redactionNotice atom): the server
 * masks sensitive values out of a call's input before the request leaves
 * the machine and emits the fact on the run stream ("redaction": how many
 * values, split by how confidently each was identified, plus a value-free
 * reason per span) — and no surface rendered it. The masking belongs to
 * the call whose input was rewritten, so the face renders on that call's
 * own record: the turn footer, beside the ↑input-tokens fact it explains
 * — the same home the dedup savings face (UIE-072) took. The DLP
 * precedent (Microsoft Purview's policy tips, retrieved 2026-09-02 in
 * research/uie-075-redaction-notice-face/README.md) settles what the face
 * says: the KIND and the COUNT of what was acted on, never the value.
 *
 * §41's search, stated: the footer's other facts have owners —
 * model-provenance-owner.test.ts charters the model name on this same
 * component, flow-turn-timing.test.ts charters the latency label,
 * dedup-savings-face.test.ts charters the savings face — and no charter
 * covers the masking face; this suite stands beside them the way
 * dedup-savings-face stood beside its neighbours (jsdom for a rendered
 * face, node for the store-level owners). The store write itself is
 * pinned by the round-21-style class guard in dedup-signal-wired's (D)
 * arm; the client attach + absence arms live in tests/unit/client.test.ts
 * under "client: startRun + SSE"; the beat forwarding lives in
 * flow-ingest.test.ts.
 *
 *   MUTATION (a): drop the `redactionSay` span from the footer → the
 *     renders arm reds while the record still carries the fact.
 *   MUTATION (b): unwire the handler (client.ts drops the buffer/store
 *     write) → the absence arm in tests/unit/client.test.ts reds.
 *   MUTATION (c): render the whole notice (or any unknown field) instead
 *     of the known count fields → the security arm below reds — a
 *     corrupt blob's smuggled value must find no template hole.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";

import TurnBeat from "../../src/cockpit/flow/TurnBeat.svelte";
import type { Beat } from "../../src/cockpit/flow/types.ts";
import type { RedactionSummary } from "../../src/state/redaction.ts";

/** A notice shaped as the server's own summary emits it — the wire's own
 * numbers, value-free. */
const MASKED: RedactionSummary = {
  maskedCount: 2,
  proven: 1,
  format: 0,
  inferred: 1,
  maskedUpstream: 0,
  byTier: { selfValidating: 1, declaredValues: 1 },
  reasons: [
    {
      confidence: "proven",
      category: "credential",
      maskedLength: 24,
      explanation: "equals a credential this machine holds",
    },
    {
      confidence: "inferred",
      category: "password",
      maskedLength: 8,
      explanation: "the words around it introduced it and its shape agreed",
    },
  ],
};

/** The face the footer must render for MASKED — exact, so a rewording or a
 * dropped number is a red, not a judgment call. The count leads, the
 * confidence split follows, and zero parts never render. */
const FACE_MASKED = "redaction 2 values hidden · 1 proven · 1 inferred";

function modelTurn(opts: {
  redactionNotice?: RedactionSummary;
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
      text: opts.silent ? "" : "done.",
      streaming: false,
      ...(opts.tokens === false ? {} : { inputTokens: 12, outputTokens: 3 }),
      ...(opts.redactionNotice !== undefined
        ? { redactionNotice: opts.redactionNotice }
        : {}),
    },
  } as unknown as Beat;
}

afterEach(() => {
  cleanup();
});

describe("the turn footer's masked-input face", () => {
  test("renders the wire's own numbers from the turn's own record", () => {
    const { container } = render(TurnBeat, { beat: modelTurn({ redactionNotice: MASKED }) });

    expect(container.textContent).toContain(FACE_MASKED);
    // A guess must never wear the authority of a proof: the split is
    // rendered, not folded into one total.
    expect(container.textContent).toContain("1 proven");
    expect(container.textContent).toContain("1 inferred");
  });

  test("the value-free reasons stay reachable on hover — one line per masked span", () => {
    const { container } = render(TurnBeat, { beat: modelTurn({ redactionNotice: MASKED }) });

    const span = container.querySelector('[data-field="redaction"]');
    expect(span, "the face renders in its own span").not.toBeNull();
    const title = span!.getAttribute("title") ?? "";
    expect(title).toContain("equals a credential this machine holds");
    expect(title).toContain("the words around it introduced it and its shape agreed");
    expect(title).toContain("proven credential");
    expect(title).toContain("inferred password");
  });

  test("a turn whose call masked nothing renders no masking face — absence, never a zero", () => {
    const { container } = render(TurnBeat, { beat: modelTurn({}) });

    expect(container.textContent).not.toContain("redaction");
    expect(container.textContent).not.toContain("0 values");
    expect(container.textContent).not.toContain("hidden");
  });

  test("the already-hidden-upstream count is stated as its own sentence, never folded into the count", () => {
    // This pass cannot know why the upstream values were masked, so it
    // must not lend them its confidence split — the two facts render as
    // two facts.
    const { container } = render(TurnBeat, {
      beat: modelTurn({
        redactionNotice: { ...MASKED, maskedCount: 1, proven: 1, inferred: 0, maskedUpstream: 3 },
      }),
    });

    expect(container.textContent).toContain(
      "redaction 1 value hidden · 1 proven · 3 more were hidden upstream",
    );
    expect(container.textContent).toContain("3 more were hidden upstream");
  });

  test("an upstream-only notice (this call masked nothing new) still renders — the input was rewritten either way", () => {
    const { container } = render(TurnBeat, {
      beat: modelTurn({
        redactionNotice: {
          maskedCount: 0,
          proven: 0,
          format: 0,
          inferred: 0,
          maskedUpstream: 2,
          byTier: {},
          reasons: [],
        },
      }),
    });

    expect(container.textContent).toContain(
      "redaction 2 values were already hidden upstream",
    );
  });

  test("a corrupt blob's smuggled value finds no template hole — the face renders only the known count fields", () => {
    // The security arm. The metadata blob is UNTRUSTED (model/tool
    // output); a corrupt or hostile blob could carry anything in an extra
    // field. The payload contract says no field holds the masked value,
    // and the renderer is the last line: it reads ONLY the known count
    // fields, so an unknown value-shaped key must never render. MUTATION:
    // render the whole notice (or an unknown field) and this reds while
    // the record carries the plant.
    const { container } = render(TurnBeat, {
      beat: modelTurn({
        redactionNotice: {
          ...MASKED,
          ...({
            value: ("sk" + "-SECRET-PLANTED-9f8e7d6c"),
            maskedValue: "hunter2-super-secret",
            preview: "AKIA1234567890EXAMPLE",
          } as Record<string, unknown>),
        } as RedactionSummary,
      }),
    });

    // The face still renders the honest fact…
    expect(container.textContent).toContain(FACE_MASKED);
    // …and never any of the planted value-shaped fields — not in the text,
    // not in the hover, nowhere.
    const span = container.querySelector('[data-field="redaction"]');
    const rendered = `${container.textContent ?? ""} ${span?.getAttribute("title") ?? ""}`;
    expect(rendered).not.toContain("sk-SECRET-PLANTED");
    expect(rendered).not.toContain("hunter2");
    expect(rendered).not.toContain("AKIA1234567890EXAMPLE");
  });

  test("a silent turn's footer carries the masking face too", () => {
    // A silent turn (the model acted without commenting) is still a
    // measured call whose input may have been masked; its footer is where
    // its facts live.
    const { container } = render(TurnBeat, {
      beat: modelTurn({ redactionNotice: MASKED, silent: true }),
    });

    expect(container.textContent).toContain("the model acted without commenting");
    expect(container.textContent).toContain(FACE_MASKED);
  });

  test("the count reads as one value, not one values", () => {
    const { container } = render(TurnBeat, {
      beat: modelTurn({
        redactionNotice: { ...MASKED, maskedCount: 1, proven: 1, inferred: 0 },
      }),
    });

    expect(container.textContent).toContain("1 value hidden");
    expect(container.textContent).not.toContain("1 values hidden");
  });
});
