// @vitest-environment jsdom
/**
 * THE RESERVED HEIGHT IS THE RENDERED SHAPE'S HEIGHT — never another
 * shape's, and never an estimate for a shape that draws nothing.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────
 *
 * The user reported "enormous empty vertical space" between compressed
 * beats, with only broken segments of the causal spine crossing the gaps.
 * Measured live in Chrome, a run of collapsed tool calls read:
 *
 *     syn-t-174   offset 11176   rendered 120px   reserved 120px
 *     (no beat)   offset 11296   rendered   0px   reserved  56px
 *     (no beat)   offset 11352   rendered   0px   reserved  56px
 *     (no beat)   offset 11408   rendered   0px   reserved  56px
 *     (no beat)   offset 11464   rendered   0px   reserved  56px
 *     syn-fx-179  offset 11520   rendered  16px   reserved  16px
 *
 * — 224px of nothing, because four beats that deliberately drew nothing were
 * still holding the un-measured 56px estimate in the Fenwick index.
 *
 * THE CAUSE, precisely: Flow.svelte's ResizeObserver callback was gated on
 * `h > 0`. The observer DID fire for those rows (verified in the page:
 * `{ blockSize: 0, contentRect: 0 }`), and the guard threw the reading away.
 * A zero height is not "not laid out yet" — it is the height of a row that
 * paints no pixels, and the index never heard it. It is the one measurement
 * the index could never receive and therefore the one it could never fix.
 *
 * ── WHAT IS PINNED HERE ───────────────────────────────────────────────────
 *
 * jsdom has NO LAYOUT and the ResizeObserver is stubbed to a no-op, which is
 * exactly what makes this file sharp: nothing here can be satisfied by a
 * measurement. Every reservation under test comes from `declareShape` —
 * Flow.svelte declaring a shape's height from what the shape IS, the same
 * discipline `render/artifact.ts` already applies to artifact frames so the
 * height index cannot be corrupted after measurement.
 *
 * The REAL-LAYOUT half of the claim (reserved === rendered, in pixels, at
 * every level, in a browser that actually does layout) lives in
 * tests/cockpit/e2e/flow-rest-geometry.spec.ts. Both are needed: this one
 * proves the mechanism exists, that one proves it is correct.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";

import Flow from "../../src/cockpit/flow/Flow.svelte";
import { appendBeat, batch, clearLog } from "../../src/cockpit/flow/log.ts";
import { resetIngest } from "../../src/cockpit/flow/ingest.ts";
import { clearAllOverrides } from "../../src/cockpit/flow/fisheye.ts";
import { HeightIndex, SHAPE_HEIGHT } from "../../src/cockpit/flow/heights.ts";
import { rendersInFlow } from "../../src/cockpit/flow/beat-state.ts";
import type { Beat } from "../../src/cockpit/flow/types.ts";

class RO {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", RO);
  resetIngest();
  clearAllOverrides();
  clearLog();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  clearAllOverrides();
  clearLog();
});

// ── Fixtures ───────────────────────────────────────────────────────────────

function turn(i: number, who: "you" | "model", text: string): Beat {
  return {
    id: `t-${i}-${who}`,
    kind: "turn",
    parentId: null,
    turnIndex: i,
    at: i * 1000,
    abnormal: false,
    bleed: false,
    verbs: [],
    turn: { who, text, streaming: false },
  };
}

function toolBeat(i: number, id: string): Beat {
  return {
    id,
    kind: "tool",
    parentId: null,
    turnIndex: i,
    at: i * 1000 + 1,
    abnormal: false,
    bleed: true,
    verbs: [],
    tool: {
      name: "read_file",
      label: "read file",
      status: "done",
      input: { path: `src/${id}.ts` },
      output: "export const x = 1;",
      startedAt: 1,
      durationMs: 12,
    },
  };
}

/** The rendered rows, in index order, with what each RESERVES and what each
 *  actually DRAWS. `reserved` is read straight off the height index through
 *  the offsets the virtualizer positions rows at. */
function rows(container: HTMLElement): { id: string | null; offset: number }[] {
  return [...container.querySelectorAll<HTMLElement>(".item")]
    .map((el) => {
      const m = /translateY\(([-\d.]+)px\)/.exec(el.style.transform);
      return {
        id: el.querySelector("[data-beat-id]")?.getAttribute("data-beat-id") ?? null,
        offset: m === null ? 0 : parseFloat(m[1]!),
      };
    })
    .sort((a, b) => a.offset - b.offset);
}

function reservedFor(container: HTMLElement, id: string | null): number | null {
  const all = rows(container);
  const i = all.findIndex((r) => r.id === id);
  if (i < 0 || i + 1 >= all.length) return null;
  return all[i + 1]!.offset - all[i]!.offset;
}

// ── A. Zero is a height ────────────────────────────────────────────────────

describe("a beat the flow does not draw reserves nothing", () => {
  test("the hidden empty turn's row costs zero, not the estimate", async () => {
    const silent = turn(1, "model", ""); // renders nothing at all
    expect(rendersInFlow(silent), "the fixture must actually be a hidden beat").toBe(false);
    batch(() => {
      appendBeat(turn(1, "you", "do the thing"));
      appendBeat(silent);
      appendBeat(toolBeat(1, "tool-a"));
      appendBeat(toolBeat(1, "tool-b"));
    });
    const { container } = render(Flow, { props: { ingest: false } });
    await Promise.resolve();

    const all = rows(container);
    const hiddenAt = all.findIndex((r) => r.id === null);
    expect(hiddenAt, "the hidden beat still occupies an index slot").toBeGreaterThan(-1);
    expect(
      all[hiddenAt + 1]!.offset - all[hiddenAt]!.offset,
      "a row that paints no pixels must reserve no pixels — this gap IS the reported defect",
    ).toBe(SHAPE_HEIGHT["none"]);
  });

  test("mutation: the estimate standing in for a hidden beat is exactly the defect", () => {
    // What the index did before: the slot kept its un-measured estimate
    // because the only writer refused to record a zero.
    const idx = new HeightIndex(SHAPE_HEIGHT["full"]!);
    idx.append(3);
    // The old callback's gate, transcribed:
    const h = 0;
    if (h > 0) idx.update(1, h, "none");
    expect(
      idx.heightOf(1),
      "with the old `h > 0` gate the hidden row keeps a full beat's height",
    ).toBe(SHAPE_HEIGHT["full"]);
    // And with the gate gone, the row is what it draws.
    idx.update(1, 0, "none");
    expect(idx.heightOf(1)).toBe(0);
    expect(idx.offsetOf(2) - idx.offsetOf(1)).toBe(0);
  });
});

// ── B. A level change invalidates the cached height ────────────────────────

describe("a shape change invalidates the height recorded for the old shape", () => {
  test("collapsing a full beat drops the full shape's reservation immediately", async () => {
    batch(() => {
      appendBeat(turn(1, "you", "read them"));
      appendBeat(toolBeat(1, "tool-x"));
      appendBeat(toolBeat(1, "tool-y"));
    });
    const { container } = render(Flow, { props: { ingest: false } });
    await Promise.resolve();

    const before = reservedFor(container, "tool-x");
    expect(before, "the beat must be mounted with a reservation").not.toBeNull();
    expect(before, "a beat in the focused turn rests at `full`").toBe(SHAPE_HEIGHT["full"]);

    // The ← chord on the focused beat: the flow's own collapse path.
    const flow = container.querySelector(".flow") as HTMLElement;
    (container.querySelector('[data-beat-id="tool-x"]') as HTMLElement).click();
    await Promise.resolve();
    flow.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    const after = reservedFor(container, "tool-x");
    expect(
      after,
      "the index must stop reserving the shape the beat is no longer drawn as. Nothing " +
        "measured this — the ResizeObserver is a no-op here — so only `declareShape` can " +
        "have produced it.",
    ).toBe(SHAPE_HEIGHT["tick"]);
    expect(after).not.toBe(before);
  });

  test("mutation: an index with no stamp cannot tell a stale height from a current one", () => {
    const idx = new HeightIndex(SHAPE_HEIGHT["full"]!);
    idx.append(2);
    idx.update(0, 613, "full"); // the card, measured
    // The shape changes. WITHOUT consulting the stamp there is nothing to
    // notice: `heightOf` still answers 613 and the row reserves a card.
    expect(idx.heightOf(0)).toBe(613);
    expect(idx.stampOf(0)).toBe("full");
    // WITH the stamp, "this height is not for the shape on screen" is a fact
    // the caller can act on before any observer runs.
    expect(idx.stampOf(0)).not.toBe("ghost");
    idx.update(0, SHAPE_HEIGHT["ghost"]!, "ghost");
    expect(idx.heightOf(0)).toBe(SHAPE_HEIGHT["ghost"]);
    expect(idx.stampOf(0)).toBe("ghost");
  });

  test("a re-declared shape that has not changed is a no-op (no churn per frame)", () => {
    const idx = new HeightIndex(SHAPE_HEIGHT["full"]!);
    idx.append(1);
    idx.update(0, 613, "full");
    // The caller's own gate is `stampOf(i) === shape`; re-declaring the same
    // shape must not throw away a real measurement.
    expect(idx.stampOf(0)).toBe("full");
    expect(idx.heightOf(0)).toBe(613);
  });
});

// ── C. The index keeps its own invariants under the new writes ─────────────

describe("the Fenwick index stays coherent with zero-height entries", () => {
  test("offsets, total and lookup all agree when rows are zero", () => {
    const idx = new HeightIndex(50);
    idx.append(5);
    idx.update(0, 10, "ghost");
    idx.update(1, 0, "none");
    idx.update(2, 0, "none");
    idx.update(3, 20, "full");
    idx.update(4, 30, "full");
    expect(idx.totalHeight()).toBe(60);
    expect(idx.offsetOf(1)).toBe(10);
    expect(idx.offsetOf(2)).toBe(10);
    expect(idx.offsetOf(3)).toBe(10);
    expect(idx.offsetOf(4)).toBe(30);
    // A zero-height row can never be the row "containing" a pixel — the
    // lookup must land on a row that actually occupies the offset.
    expect(idx.heightOf(idx.indexAtOffset(15))).toBeGreaterThan(0);
    expect(idx.heightOf(idx.indexAtOffset(45))).toBeGreaterThan(0);
  });

  test("truncation carries the stamps with the heights", () => {
    const idx = new HeightIndex(50);
    idx.append(4);
    idx.update(0, 10, "ghost");
    idx.update(1, 0, "none");
    idx.truncate(2);
    expect(idx.length).toBe(2);
    expect(idx.stampOf(0)).toBe("ghost");
    expect(idx.stampOf(1)).toBe("none");
    expect(idx.heightOf(1)).toBe(0);
  });
});
