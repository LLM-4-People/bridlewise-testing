// @vitest-environment jsdom
/**
 * THE FLOW'S GEOMETRY WHEN THE PAST ARRIVES ABOVE THE READER (§4).
 *
 * Two coordinate systems now meet in this component and they are offset from
 * each other by a constant:
 *
 *   • the HEIGHT INDEX numbers beats from 0 and knows nothing about the head
 *     row ("older messages not loaded yet" / "the beginning of this
 *     conversation"), which is not a beat and has no index position;
 *   • SCROLL PIXELS include that row, because it is the scroller's first
 *     child.
 *
 * Every place the two meet — the window, the reveal, the reading anchor, the
 * prepend compensation — converts by `headHeight()`. A missed conversion is
 * not a crash: it is 34px of drift somewhere, which reads as the transcript
 * quietly nudging itself, and only geometry can catch it.
 *
 * jsdom has no layout, so heights are the declared estimates and the
 * scroll box is defined by the test. That is exactly the right instrument
 * here: what is under test is the ARITHMETIC, and a real-browser check of
 * the same claims is in `flow-rest-geometry.spec.ts`.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { render, cleanup, waitFor } from "@testing-library/svelte";

import Flow from "../../src/cockpit/flow/Flow.svelte";
import { appendBeat, batch, clearLog, prependBeats } from "../../src/cockpit/flow/log.ts";
import { syntheticBeats } from "../../src/cockpit/flow/dev/synthetic.ts";
import { DEFAULT_ESTIMATE } from "../../src/cockpit/flow/heights.ts";
import { HISTORY_HEAD_H } from "../../src/cockpit/flow/flow-config.ts";
import { resetIngest } from "../../src/cockpit/flow/ingest.ts";
import { clearHistoryReach, noteReachOpened } from "../../src/state/chat-history-reach.ts";
import { currentChatId } from "../../src/state/chats.ts";
import type { Beat } from "../../src/cockpit/flow/types.ts";

class RO {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** jsdom reports 0 for both, which makes the flow think it is always at the
 * tail. A scroll box has to be declared for the reader to be anywhere. */
function giveItABox(el: HTMLElement, clientHeight: number, scrollHeight: number): void {
  Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true });
}

function load(n: number): void {
  batch(() => {
    for (const b of syntheticBeats(n)) appendBeat(b);
  });
}

/** Beats that are NOT in the synthetic set, so their ids cannot collide. */
function olderBeats(n: number): Beat[] {
  const out: Beat[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      id: `older-${i}`,
      kind: "event",
      parentId: null,
      turnIndex: -100 + i,
      at: 1_000 + i,
      abnormal: false,
      bleed: true,
      verbs: [],
      event: { eventKind: "steering", text: `older ${i}` },
    });
  }
  return out;
}

function offsets(container: HTMLElement): number[] {
  return [...container.querySelectorAll<HTMLElement>(".item")]
    .map((el) => {
      const m = /translateY\(([-\d.]+)px\)/.exec(el.style.transform);
      return m === null ? 0 : parseFloat(m[1]!);
    })
    .sort((a, b) => a - b);
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", RO);
  resetIngest();
  clearLog();
  clearHistoryReach();
  currentChatId.set(null);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  clearLog();
  clearHistoryReach();
  currentChatId.set(null);
});

describe("the head row is a real row with a declared height", () => {
  test("it renders whenever beats do, at the height the config DECLARES", () => {
    load(20);
    const { container } = render(Flow, { props: { ingest: false } });
    const head = container.querySelector<HTMLElement>(".history-head");
    expect(head).not.toBeNull();
    expect(head!.style.height).toBe(`${HISTORY_HEAD_H}px`);
  });

  test("nothing in the row's own styling can make it taller than it declares", () => {
    /**
     * WHY THIS IS A SOURCE GUARD AND NOT A MEASUREMENT. The assertion above
     * compares the inline height against the same constant the component
     * used, so it is true by construction — verified by mutation: changing
     * `HISTORY_HEAD_H` leaves it green. jsdom has no layout engine, so the
     * only thing this environment CAN check is that the row is written so a
     * long sentence cannot grow it. The rendered-vs-declared measurement
     * lives where a layout engine exists: `flow-rest-geometry.spec.ts`.
     *
     * The three properties are the whole contract: the height includes the
     * padding, the text never wraps, and anything longer is clipped.
     */
    // jsdom's `import.meta.url` is an http:// URL, not a file one, so the
    // path is resolved from the repository root the runner is invoked at.
    const source = readFileSync("src/cockpit/flow/Flow.svelte", "utf8");
    const block = /\.history-head\s*\{([^}]*)\}/.exec(source);
    expect(block, ".history-head must have its own style block").not.toBeNull();
    const rules = block![1]!;
    expect(rules).toContain("box-sizing: border-box");
    expect(rules).toContain("white-space: nowrap");
    expect(rules).toContain("overflow: hidden");
    expect(rules, "a competing height rule would silently beat the declaration")
      .not.toMatch(/(^|;)\s*height\s*:/);
  });

  test("it is absent when no beats are drawn — an empty row is not a claim", () => {
    const { container } = render(Flow, { props: { ingest: false } });
    expect(container.querySelector(".history-head")).toBeNull();
    // Queried through the GRAMMAR'S own attribute rather than the retired
    // `.empty` class. This is the stronger claim of the two: `.empty` merely
    // asserted that some element existed, while `[data-answer="absent"]`
    // asserts the flow is answering through the one vocabulary — a surface
    // that relapsed into its own markup would fail this and passed that.
    expect(container.querySelector('[data-answer="absent"]')).not.toBeNull();
  });

  test("with no reach on record it says NOTHING, rather than guessing", () => {
    // A harness mount, or a warm log whose page facts were never fetched.
    // Claiming "the beginning" for a conversation nobody asked the server
    // about would be exactly the fabricated absence this row exists to
    // prevent (§1 L3).
    // MUTATION: default `headState` to "beginning" and this fails.
    load(20);
    const { container } = render(Flow, { props: { ingest: false } });
    expect(container.querySelector(".history-head")!.textContent!.trim()).toBe("");
  });

  test("it distinguishes 'not loaded yet' from 'the beginning'", () => {
    load(20);
    currentChatId.set("c1");
    noteReachOpened({
      chatId: "c1",
      hasOlder: true,
      olderCursor: "cur",
      messageCount: 5_000,
      loaded: 200,
    });
    const { container, unmount } = render(Flow, { props: { ingest: false } });
    const said = () => container.querySelector(".history-head")!.textContent!.replace(/\s+/g, " ").trim();
    expect(said()).toContain("earlier not loaded yet");
    expect(said()).toContain("Read earlier");
    unmount();

    noteReachOpened({
      chatId: "c1",
      hasOlder: false,
      olderCursor: null,
      messageCount: 20,
      loaded: 20,
    });
    const second = render(Flow, { props: { ingest: false } });
    expect(
      second.container.querySelector(".history-head")!.textContent!.replace(/\s+/g, " ").trim(),
    ).toBe("the beginning of this conversation");
  });
});

describe("scroll pixels and index offsets stay one constant apart", () => {
  test("the spacer holds the beats and the head row holds itself", async () => {
    // The head row is the scroller's FIRST CHILD, outside the virtualized
    // spacer, so the spacer's height is the index's total and nothing else.
    // MUTATION: put the row inside the spacer and every beat offset is off
    // by its height.
    load(50);
    const { container } = render(Flow, { props: { ingest: false } });
    await Promise.resolve();
    const flow = container.querySelector<HTMLElement>(".flow")!;
    const children = [...flow.children].map((c) => c.className);
    expect(children[0]).toContain("history-head");
    expect(children[1]).toContain("spacer");
    // The first beat sits at index offset 0 — the head row's height is
    // contributed by the row itself, in normal flow, not by the transform.
    expect(offsets(container)[0]).toBe(0);
  });

  test("the window is chosen from scrollTop MINUS the head row", async () => {
    // MUTATION: drop the `- HISTORY_HEAD_H` in `win` and the window is
    // chosen for a position 34px further down than the reader is at — one
    // row too far, forever, and only at the top of the log would anyone
    // notice.
    load(400);
    const { container } = render(Flow, { props: { ingest: false } });
    await Promise.resolve();
    const flow = container.querySelector<HTMLElement>(".flow")!;
    giveItABox(flow, 500, 400 * DEFAULT_ESTIMATE + HISTORY_HEAD_H);

    // A scrollTop of exactly the head height means "the first beat's top edge
    // is at the top of the viewport", i.e. index offset 0.
    flow.scrollTop = HISTORY_HEAD_H;
    flow.dispatchEvent(new Event("scroll"));
    await Promise.resolve();
    expect(offsets(container)[0]).toBe(0);

    // A position where the head row's height CROSSES a beat boundary — the
    // only kind that can tell the two coordinate systems apart. At any
    // scrollTop whose remainder exceeds the row's height, forgetting the
    // conversion still lands on the same beat, which is why the obvious
    // choice of `scrollTop = HISTORY_HEAD_H` proves nothing (verified by
    // mutation: it stayed green).
    const beatsDown = 10;
    flow.scrollTop = HISTORY_HEAD_H + beatsDown * DEFAULT_ESTIMATE + (DEFAULT_ESTIMATE - 1);
    flow.dispatchEvent(new Event("scroll"));
    await Promise.resolve();
    const first = offsets(container)[0]!;
    // The reader is inside beat 10; the window starts OVERSCAN rows earlier.
    // Forgetting the conversion puts them in beat 11 and shifts this by one
    // whole row.
    expect(first).toBe((beatsDown - 6) * DEFAULT_ESTIMATE);
  });
});

describe("a page of older beats does not move the reader", () => {
  test("scrollTop is compensated by exactly the height that arrived above", async () => {
    /**
     * THE CLAIM THE WHOLE FEATURE RESTS ON. `k` rows appear above everything
     * on screen; a browser keeps `scrollTop` through that, so the words under
     * the reader's eyes move DOWN by the full height of the page that
     * arrived — at 200 beats, thousands of pixels, from a fetch the reader
     * made no visible request for.
     *
     * MUTATION: delete the `absorbPrepend` call in the version-bump handler
     * and this fails by exactly `k * DEFAULT_ESTIMATE`.
     */
    load(400);
    const { container } = render(Flow, { props: { ingest: false } });
    await Promise.resolve();
    const flow = container.querySelector<HTMLElement>(".flow")!;
    giveItABox(flow, 500, 400 * DEFAULT_ESTIMATE + HISTORY_HEAD_H);

    // Park the reader in the middle. This also turns `follow` off, which is
    // what makes the compensation their business rather than the tail's.
    const parked = HISTORY_HEAD_H + 120 * DEFAULT_ESTIMATE;
    flow.scrollTop = parked;
    flow.dispatchEvent(new Event("scroll"));
    await Promise.resolve();

    const k = 37;
    prependBeats(olderBeats(k));
    // The compensation lands after a `tick()`, deliberately: the new rows do
    // not exist in the DOM until the spacer re-renders, and a larger
    // scrollTop applied before that is CLAMPED to the old height — which is
    // permanent, because the clamp is not undone when the height arrives.
    //
    // Wait for the SETTLED value, not a fixed tick count: a hard-coded
    // `setTimeout(0)` pair races the flow's `queueMicrotask(scrollTop = …)`
    // under full-suite CPU contention and reads the pre-compensation position.
    giveItABox(flow, 500, (400 + k) * DEFAULT_ESTIMATE + HISTORY_HEAD_H);
    await waitFor(() => {
      expect(flow.scrollTop).toBe(parked + k * DEFAULT_ESTIMATE);
    });

    expect(flow.scrollTop).toBe(parked + k * DEFAULT_ESTIMATE);
  });

  test("a reader AT THE TAIL is left at the tail, not shoved by the compensation", async () => {
    /**
     * A reader who asked to follow the newest beat asked for the newest beat.
     * Nothing arriving above them changes where that is.
     *
     * THE FOLLOW STATE IS ESTABLISHED EXPLICITLY, from a real scroll event
     * over a declared box, rather than inherited from jsdom's zero-sized
     * default. The first version of this test relied on the default and was
     * intermittently wrong about which element it was reading — an ambient
     * premise is not a premise.
     *
     * MUTATION: drop the `follow` check in `readingAnchor` and a following
     * reader is scrolled off the tail by every page that arrives.
     */
    load(400);
    const { container } = render(Flow, { props: { ingest: false } });
    await Promise.resolve();
    const flow = container.querySelector<HTMLElement>(".flow")!;
    // A box whose content exactly fills it, scrolled to the end: `follow` is
    // computed from these numbers by `onScroll`, not assumed.
    const total = 400 * DEFAULT_ESTIMATE + HISTORY_HEAD_H;
    giveItABox(flow, 500, total);
    flow.scrollTop = total - 500;
    flow.dispatchEvent(new Event("scroll"));
    await Promise.resolve();
    const before = flow.scrollTop;
    expect(before, "the reader must be at the tail for this to be about following").toBe(
      total - 500,
    );

    const k = 12;
    prependBeats(olderBeats(k));
    // Wait for the follow-scroll to SETTLE, not a fixed tick count: the flow
    // puts a following reader back at the end via `queueMicrotask(scrollToEnd)`,
    // and a hard-coded `setTimeout(0)` pair races that microtask under
    // full-suite CPU contention, reading the pre-scroll position.
    await waitFor(() => {
      expect(flow.scrollTop).toBeGreaterThanOrEqual(flow.scrollHeight - 500);
    });

    // STILL AT THE TAIL, which is not the same as "unmoved": the flow's
    // existing follow behaviour owns this reader and puts them back at the
    // end (`scrollToEnd`), so the honest invariant is where they end up, not
    // whether the number changed.
    expect(flow.scrollTop).toBeGreaterThanOrEqual(flow.scrollHeight - 500);
    // …and specifically NOT the prepend compensation, which would drag a
    // following reader `k` rows back up the log.
    expect(flow.scrollTop).not.toBe(before + k * DEFAULT_ESTIMATE);
  });
});
