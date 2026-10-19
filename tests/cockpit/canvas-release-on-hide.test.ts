// @vitest-environment jsdom
/**
 * A HIDDEN ROOM KEEPS ITS VALUES, NOT ITS PIXELS.
 *
 * Keep-alive holds every visited room mounted, and the sweep counted the
 * cost: ~100 painted canvases (a micro-sweep per Switch reel, a spark per
 * Instruments cell) held in memory for surfaces nobody could see — each a
 * w×h×4-byte bitmap. The fix is the keep-alive law applied to bitmaps: on
 * hide the canvas is zero-sized (which frees its backing store); the
 * measured DATA stays, and the show repaints from it in the same frame.
 *
 * jsdom cannot paint, so what is assertable here is the release itself:
 * the canvas dimensions drop to zero when the room leaves the screen, and
 * the strip's data (the sr sentence, the state attribute) stands.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";

import MicroSweep from "../../src/cockpit/rooms/MicroSweep.svelte";
import Spark from "../../src/cockpit/rooms/Spark.svelte";
import {
  bindShellVisibility,
  setVisibleRoom,
} from "../../src/cockpit/shell/room-visibility.ts";

const DENSITY = {
  kind: "measured" as const,
  density: {
    t0: 0,
    t1: 60_000,
    binMs: 10_000,
    totals: [3, 0, 5, 1, 0, 2],
    errors: [1, 0, 0, 0, 0, 0],
    events: 11,
  },
};

const POINTS = [
  { t: 1_000, v: 10 },
  { t: 2_000, v: 12 },
  { t: 3_000, v: 9 },
];

let unbind: (() => void) | null = null;

beforeEach(() => {
  unbind = bindShellVisibility();
});
afterEach(() => {
  cleanup();
  unbind?.();
  unbind = null;
});

describe("the Switch reel's micro-sweep", () => {
  test("hiding the Switch releases the bitmap; the measured data stands", async () => {
    setVisibleRoom("switch");
    const { container } = render(MicroSweep, { props: { density: DENSITY } });
    const canvas = container.querySelector("canvas")!;
    expect(canvas).not.toBeNull();
    // Give the bitmap a size, as a real paint would have.
    canvas.width = 96;
    canvas.height = 24;

    setVisibleRoom(null);
    await Promise.resolve();
    expect(canvas.width, "a hidden room's bitmap is released").toBe(0);
    expect(canvas.height).toBe(0);
    // The VALUES survive the hide — that is what keep-alive keeps. The
    // data-state is the grammar's word, not the feed's domain kind: a
    // measured strip is content (the canvas) and carries NO state hue, so
    // the attribute is null (mapped at the component's door), never the
    // feed's "measured". The measured DATA stands either way.
    expect(container.querySelector(".micro")!.getAttribute("data-state")).toBe(null);
    expect(container.textContent).toContain("11 recorded events");
  });
});

describe("the Instruments cell's spark", () => {
  test("hiding the Instruments room releases the bitmap; the series stands", async () => {
    setVisibleRoom("instruments");
    const { container } = render(Spark, { props: { points: POINTS } });
    const canvas = container.querySelector("canvas")!;
    canvas.width = 96;
    canvas.height = 20;

    setVisibleRoom(null);
    await Promise.resolve();
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
    expect(container.querySelector(".spark")!.getAttribute("data-points")).toBe("3");
  });

  test("another room hiding does not release this room's canvases", async () => {
    setVisibleRoom("instruments");
    const { container } = render(Spark, { props: { points: POINTS } });
    const canvas = container.querySelector("canvas")!;
    canvas.width = 96;
    canvas.height = 20;
    // The Switch closing is not the Instruments room leaving the screen.
    setVisibleRoom("instruments");
    await Promise.resolve();
    expect(canvas.width).toBe(96);
  });
});
