// @vitest-environment jsdom
/**
 * THE BAND→CHAT NAVIGATION SEAM, and the two things about it that are
 * invisible in a screenshot:
 *
 *  1. the band's DOMAIN must be the read's own span — its left edge is the
 *     read's first recorded event, and a newer received event extends the
 *     right edge without inventing a bin;
 *  2. a scrub must not emit more navigations than there were frames — an
 *     uncoalesced scrub looks identical in a still and stutters in the hand,
 *     so it gets a number rather than a comment.
 *
 * Every claim has its mutation beside it: the assertion is only worth what it
 * catches, so each guard is shown failing against the defect it names.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";

import Sweep from "../../src/cockpit/sweep/Sweep.svelte";
import { bandBounds } from "../../src/cockpit/sweep/band-scope";
import {
  FOCUS_BEAT_CONTRACT,
  FOCUS_BEAT_EVENT,
  assertNavigationCoalesced,
  dispatchFocusBeat,
  eventAtOrBefore,
  focusBeatDetail,
  frameCoalesced,
  legacyBridgeFireCount,
  resetFocusSeam,
  type FocusBeatDetail,
} from "../../src/cockpit/sweep/focus-seam";
import { resetSweep, sweepHead } from "../../src/cockpit/sweep/sweep-store";
import { resetSpectrumFeed } from "../../src/cockpit/sweep/spectrum-load";
import { type SweepEvent } from "../../src/cockpit/sweep/types";

const T0 = Date.parse("2026-07-25T13:40:00");

const ev = (timeMs: number, id = `e${timeMs}`): SweepEvent =>
  Object.freeze({
    eventId: id,
    timeMs,
    category: "tool" as const,
    isError: false,
    eventType: "tool",
    outcome: null,
    errorCode: null,
    runId: "run-1",
    turnId: "t1",
    parentEventId: null,
    description: "",
  });

beforeEach(() => {
  cleanup();
  resetSweep();
  resetSpectrumFeed();
  resetFocusSeam();
});

// ── 1. THE BAND'S FIRST EVENT IS THE CONVERSATION'S FIRST EVENT ────────────
//
// The SPAN CAPTION that used to be asserted here is gone (band-scope.ts says
// why), and with it `bandSpan` / `parseBandReadScope` / `assertBandSpanHonest`.
// The band's DOMAIN is the half of this that survives — where its left edge
// sits, which is a measured fact about the pixels rather than a sentence — and
// the regression guard for the removal itself (nothing in the band says
// "· since …" any more) is in sweep-component.test.ts, where the band is
// really rendered.

describe("what the band spans", () => {
  const coverage = { t0: T0, t1: T0 + 3_600_000 };

  test("the band's left edge IS the read's left edge — never a wider ledger's", () => {
    expect(bandBounds(coverage, null)!.t0).toBe(T0);
  });

  test("nothing recorded is an absent domain, not an invented one", () => {
    expect(bandBounds(null, T0)).toBeNull();
  });

  test("bounds run to NOW: a received event newer than the loaded snapshot extends the band", () => {
    const later = T0 + 7_200_000;
    expect(bandBounds(coverage, later)).toEqual({ t0: T0, t1: later });
    // …and an edge inside the snapshot changes nothing (no invented span).
    expect(bandBounds(coverage, T0 + 10)).toEqual(coverage);
  });
});

// ── 2. RESOLUTION: at-or-before, capped by the head ────────────────────────

describe("the band's half of the resolution — at-or-before, never ahead", () => {
  const events = [ev(100), ev(200), ev(300), ev(400)];

  test("picks the last event at or before the instant", () => {
    expect(eventAtOrBefore(events, 250)?.timeMs).toBe(200);
    expect(eventAtOrBefore(events, 300)?.timeMs).toBe(300);
  });

  test("an instant before everything recorded resolves to NOTHING — never the nearest ahead", () => {
    expect(eventAtOrBefore(events, 50)).toBeNull();
  });

  test("a planted head caps the answer — a past view never resolves past its own banner", () => {
    expect(eventAtOrBefore(events, 400, 250)?.timeMs).toBe(200);
  });
});

// ── 3. BUTTER SMOOTH: one navigation per frame, never more ─────────────────

describe("coalescing — a 1200-bin scrub is not 1200 navigations", () => {
  function fakeRaf() {
    const queue: (() => void)[] = [];
    return {
      raf: (cb: () => void) => {
        queue.push(cb);
        return queue.length;
      },
      cancel: () => {},
      frame(): void {
        const pending = queue.splice(0, queue.length);
        for (const cb of pending) cb();
      },
      depth: () => queue.length,
    };
  }

  test("1200 offers across 3 frames emit 3 navigations, and the LAST offer of each frame wins", () => {
    const seen: number[] = [];
    const clock = fakeRaf();
    const emitter = frameCoalesced<number>((v) => seen.push(v), clock.raf, clock.cancel);

    for (let i = 0; i < 400; i++) emitter.offer(i);
    clock.frame();
    for (let i = 400; i < 800; i++) emitter.offer(i);
    clock.frame();
    for (let i = 800; i < 1200; i++) emitter.offer(i);
    clock.frame();

    expect(seen).toEqual([399, 799, 1199]);
    const stats = emitter.stats();
    expect(stats.offered).toBe(1200);
    expect(stats.emitted).toBe(3);
    expect(stats.frames).toBe(3);
    expect(() => assertNavigationCoalesced(stats)).not.toThrow();
  });

  test("a commitment does not wait for a frame — and cancels the preview queued behind it", () => {
    const seen: string[] = [];
    const clock = fakeRaf();
    const emitter = frameCoalesced<string>((v) => seen.push(v), clock.raf, clock.cancel);
    emitter.offer("hover");
    emitter.now("click");
    expect(seen).toEqual(["click"]);
    clock.frame();
    expect(seen).toEqual(["click"]);
  });

  test("cancel drops a pending preview — a pointer that left the band navigates nowhere", () => {
    const seen: string[] = [];
    const clock = fakeRaf();
    const emitter = frameCoalesced<string>((v) => seen.push(v), clock.raf, clock.cancel);
    emitter.offer("hover");
    emitter.cancel();
    clock.frame();
    expect(seen).toEqual([]);
  });

  test("MUTATION: an emitter that fires per pointer tick IS caught by the guard", () => {
    // The regression, written out: 1200 emissions across 3 frames.
    expect(() =>
      assertNavigationCoalesced({ offered: 1200, emitted: 1200, frames: 3 }),
    ).toThrow(/must be coalesced to the animation frame/);
  });
});

// ── 4. THE SEAM ON THE BAND ITSELF ─────────────────────────────────────────

describe("focusBeat — the contract, on a real mount", () => {
  test("hovering an ACTIVATED band emits a coalesced PREVIEW carrying the instant and the event at-or-before it", async () => {
    const details: FocusBeatDetail[] = [];
    const { container } = render(Sweep, {
      props: {
        events: [ev(T0), ev(T0 + 30_000), ev(T0 + 60_000)],
        stream: { status: "live", lastEventMs: T0 + 60_000, eventsReceived: 3 },
        onFocusBeat: (d: FocusBeatDetail) => details.push(d),
      },
    });
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    // THE BAND IS INERT UNTIL ACTIVATED (tests/cockpit/sweep-activation.test.ts
    // owns that rule and its mutation proof). A hover preview SCROLLS the
    // flow, so it is one of the channels the rule covers: the pointer must be
    // welcome here only after the reader has taken hold of the instrument.
    // Focus is the keyboard's half of that gesture and needs no pointer
    // capture stub, so it is what this test uses to get to the state it is
    // actually about.
    canvas.focus();
    // jsdom reports width 0; the band still resolves times off its own view.
    const move = new MouseEvent("pointermove", { bubbles: true }) as unknown as PointerEvent;
    Object.defineProperty(move, "offsetX", { value: 40 });
    canvas.dispatchEvent(move as unknown as Event);
    await vi.waitFor(() => expect(details.length).toBeGreaterThan(0));

    const d = details[details.length - 1]!;
    expect(d.contract).toBe(FOCUS_BEAT_CONTRACT);
    expect(d.preview).toBe(true);
    expect(d.via).toBe("hover");
    expect(Number.isFinite(d.timeMs)).toBe(true);
    expect(d.headMs).toBeNull();
  });

  test("clicking the band navigates the chat AND plants the head — in the same gesture", async () => {
    const details: FocusBeatDetail[] = [];
    const { container } = render(Sweep, {
      props: {
        events: [ev(T0), ev(T0 + 60_000)],
        stream: { status: "live", lastEventMs: T0 + 60_000, eventsReceived: 2 },
        onFocusBeat: (d: FocusBeatDetail) => details.push(d),
      },
    });
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    const down = new MouseEvent("pointerdown", { bubbles: true }) as unknown as PointerEvent;
    Object.defineProperty(down, "offsetX", { value: 10 });
    Object.defineProperty(down, "pointerId", { value: 1 });
    (canvas as unknown as { setPointerCapture(id: number): void }).setPointerCapture = () => {};
    canvas.dispatchEvent(down as unknown as Event);
    const up = new MouseEvent("pointerup", { bubbles: true }) as unknown as PointerEvent;
    Object.defineProperty(up, "offsetX", { value: 10 });
    Object.defineProperty(up, "pointerId", { value: 1 });
    canvas.dispatchEvent(up as unknown as Event);
    await Promise.resolve();

    const committed = details.filter((d) => !d.preview);
    expect(committed.length).toBe(1);
    expect(committed[0]!.via).toBe("click");
    expect(sweepHead.get()).not.toBeNull();
    // The head the band planted and the instant it navigated to are the SAME
    // instant — two opinions about "when" is how the banner and the log came
    // to describe different moments.
    expect(committed[0]!.timeMs).toBe(sweepHead.get());
    expect(committed[0]!.headMs).toBe(sweepHead.get());
  });

  test("the a11y outline's run jump navigates as well as plants — the keyboard path is not a lesser path", async () => {
    const details: FocusBeatDetail[] = [];
    const { getByText } = render(Sweep, {
      props: {
        events: [ev(T0), ev(T0 + 1000)],
        stream: { status: "idle", lastEventMs: null, eventsReceived: 0 },
        onFocusBeat: (d: FocusBeatDetail) => details.push(d),
      },
    });
    getByText(/run run-1/).click();
    await Promise.resolve();
    expect(details.filter((d) => !d.preview).map((d) => d.timeMs)).toEqual([T0]);
  });

  test("the event BUBBLES to the document — the flow listens there, not on the band", async () => {
    const seen: unknown[] = [];
    const onDoc = (e: Event): void => {
      seen.push((e as CustomEvent).detail);
    };
    document.addEventListener(FOCUS_BEAT_EVENT, onDoc);
    try {
      const { getByText } = render(Sweep, {
        props: {
          events: [ev(T0)],
          stream: { status: "idle", lastEventMs: null, eventsReceived: 0 },
        },
      });
      getByText(/run run-1/).click();
      await Promise.resolve();
      expect(seen.length).toBeGreaterThan(0);
    } finally {
      document.removeEventListener(FOCUS_BEAT_EVENT, onDoc);
    }
  });
});

describe("the legacy bridge — and the day it must be deleted", () => {
  function detail(over: Partial<FocusBeatDetail> = {}): FocusBeatDetail {
    return focusBeatDetail({
      eventId: "evt-1",
      timeMs: T0,
      via: "click",
      preview: false,
      headMs: null,
      ...over,
    });
  }

  test("an UNHANDLED commitment is re-dispatched in the v1 string form, so a flow that has not upgraded still moves", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const legacy: unknown[] = [];
    host.addEventListener(FOCUS_BEAT_EVENT, (e) => {
      const d = (e as CustomEvent).detail;
      if (typeof d === "string") legacy.push(d);
    });
    dispatchFocusBeat(host, detail());
    expect(legacy).toEqual(["evt-1"]);
    expect(legacyBridgeFireCount()).toBe(1);
  });

  test("a PREVIEW is never bridged — the v1 handler hints and steals focus, which per hover frame is worse than nothing", () => {
    const host = document.createElement("div");
    const legacy: unknown[] = [];
    host.addEventListener(FOCUS_BEAT_EVENT, (e) => {
      const d = (e as CustomEvent).detail;
      if (typeof d === "string") legacy.push(d);
    });
    dispatchFocusBeat(host, detail({ preview: true }));
    expect(legacy).toEqual([]);
    expect(legacyBridgeFireCount()).toBe(0);
  });

  test("THE DELETION CHECK: once the flow handles v2 and preventDefaults, the bridge stays silent", () => {
    const host = document.createElement("div");
    const legacy: unknown[] = [];
    host.addEventListener(FOCUS_BEAT_EVENT, (e) => {
      const d = (e as CustomEvent).detail;
      if (typeof d === "string") legacy.push(d);
      else e.preventDefault();
    });
    expect(dispatchFocusBeat(host, detail())).toBe(true);
    expect(legacy).toEqual([]);
    expect(legacyBridgeFireCount()).toBe(0);
  });
});
