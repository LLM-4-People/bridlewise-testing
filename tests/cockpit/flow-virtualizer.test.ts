// @vitest-environment jsdom
/**
 * Flow virtualizer (spec §3.8): 5k beats in the log, only the visible
 * window in the DOM; the log stays outside component reactivity (the
 * component subscribes to the version counter only); scrolling moves the
 * window. jsdom has no layout, so geometry runs on the estimate heights —
 * the windowing math is what is under test here (real-browser scroll is
 * verified against the dev harness).
 */
import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";
import { render, cleanup } from "@testing-library/svelte";

import { threadCpuWorkMs } from "../../engine/src/shared/run-cpu.ts";

import Flow from "../../src/cockpit/flow/Flow.svelte";
import { appendBeat, batch, clearLog } from "../../src/cockpit/flow/log.ts";
import { syntheticBeats } from "../../src/cockpit/flow/dev/synthetic.ts";
import { DEFAULT_ESTIMATE } from "../../src/cockpit/flow/heights.ts";
import { resetIngest } from "../../src/cockpit/flow/ingest.ts";

class RO {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", RO);
  resetIngest();
  clearLog();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  clearLog();
});

function load(n: number): void {
  const beats = syntheticBeats(n);
  batch(() => {
    for (const b of beats) appendBeat(b);
  });
}

describe("flow virtualizer — 5k beats", () => {
  test("renders a small window, not the log", async () => {
    load(5000);
    const { container } = render(Flow, { props: { ingest: false } });
    await Promise.resolve(); // flush the microtask follow-scroll
    const items = container.querySelectorAll(".item");
    expect(items.length).toBeGreaterThan(0);
    // 5k beats in the log; the DOM must hold roughly a window + overscan.
    expect(items.length).toBeLessThan(60);
    const spacer = container.querySelector(".spacer") as HTMLElement;
    // Total height = the sum of every beat's RESERVED height.
    //
    // Un-mounted beats carry the generic estimate. MOUNTED beats no longer
    // do: each declares the height of the shape it is actually drawn as the
    // moment it mounts (Flow.svelte `declareShape`), so a beat rendered as a
    // one-line ghost reserves a ghost's height rather than a card's. jsdom
    // has no layout and the ResizeObserver is stubbed, so `declareShape` is
    // the ONLY writer here — which is precisely why the total lands slightly
    // under the all-estimates figure, and why it must.
    const total = parseInt(spacer.style.height, 10);
    const allEstimates = 5000 * DEFAULT_ESTIMATE;
    expect(total).toBeLessThanOrEqual(allEstimates);
    // …and only by the mounted window's worth. The DOM holds < 60 rows, so
    // no more than that many reservations can have been reduced.
    expect(total).toBeGreaterThan(allEstimates - 60 * DEFAULT_ESTIMATE);
  });

  test("scrolling moves the window to the offset's beats", async () => {
    load(5000);
    const { container } = render(Flow, { props: { ingest: false } });
    await Promise.resolve();
    const flow = container.querySelector(".flow") as HTMLElement;
    const before = [...container.querySelectorAll(".item [data-beat-id]")].map((el) =>
      el.getAttribute("data-beat-id"),
    );
    // Jump to the middle: beat ~2500 at 56px estimate.
    flow.scrollTop = 2500 * 56;
    flow.dispatchEvent(new Event("scroll"));
    await Promise.resolve();
    const after = [...container.querySelectorAll(".item [data-beat-id]")].map((el) =>
      el.getAttribute("data-beat-id"),
    );
    expect(after.length).toBeGreaterThan(0);
    expect(after).not.toEqual(before);
  });

  test("an appended beat reaches the DOM through the version counter", async () => {
    // Small log so the fresh beat lands INSIDE the estimate window (jsdom has
    // no layout: clientHeight is 0, so only ~overscan items render).
    load(5);
    const { container } = render(Flow, { props: { ingest: false } });
    await Promise.resolve();
    // CPU work on this thread, never wall time (NO-LOAD-BLOCK).
    const t0 = threadCpuWorkMs();
    appendBeat({
      id: "fresh-beat",
      kind: "event",
      parentId: null,
      turnIndex: 99,
      at: Date.now(),
      abnormal: false,
      bleed: true,
      verbs: [],
      event: { eventKind: "steering", text: "fresh" },
    });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    const ms = threadCpuWorkMs() - t0;
    const el = container.querySelector('[data-beat-id="fresh-beat"]');
    expect(el).not.toBeNull();
    // §1.5 budget: live event → its beat on screen < 100ms from receipt.
    expect(ms).toBeLessThan(100);
  });

  test("the empty log renders the honest empty state", () => {
    const { container } = render(Flow, { props: { ingest: false } });
    expect(container.querySelector('[data-answer="absent"]')?.textContent).toMatch(
      /nothing recorded/,
    );
  });
});
