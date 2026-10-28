// @vitest-environment jsdom
/**
 * THE BAND IS INERT UNTIL ACTIVATED — the guard for the reported defect
 * "the timeline we should click on it to activate it first, otherwise its
 * too easy to scroll when just passing on it", and for its follow-up
 * "moving the mouse onto the timeline still makes the chat scroll sometimes
 * even when timeline not activated".
 *
 * TWO CHANNELS, ONE RULE. The band could reach out and change what the
 * reader was looking at in two different ways, and gating only the obvious
 * one left the defect standing:
 *
 *   1. THE WHEEL — `onwheel` was bound unconditionally, so a wheel tick with
 *      the pointer merely passing over the band panned or zoomed the window.
 *   2. THE HOVER PREVIEW — a pointermove dispatched `sweep.focusBeat` with
 *      `preview: true`, and the FLOW answers that by SCROLLING to the beat at
 *      that instant. No wheel involved at all, which is exactly why the first
 *      fix did not cover it.
 *
 * The rule this file pins is therefore stated once and tested per channel:
 * AN INERT BAND HAS NO EFFECT, THROUGH ANY CHANNEL. And the converse matters
 * just as much — an inert band that silently swallowed the wheel would be
 * worse than one that stole it, so the inert wheel must also NOT be
 * `preventDefault`ed, and the inert band must SAY what a click will do.
 *
 * NON-VACUITY is pinned in the file itself: for every "nothing happened"
 * assertion there is a sibling test proving the SAME observable moves once
 * the band is activated. An assertion that could never have been false is
 * worse than no assertion, and these pairs are what stop that.
 *
 * The MUTATION PROOFS themselves are run against the source: each gate is
 * deliberately removed, this file is run, and the named tests go red. See
 * the report accompanying the change for the recorded runs.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";

import Sweep from "../../src/cockpit/sweep/Sweep.svelte";
import { resetSweep, sweepMarks } from "../../src/cockpit/sweep/sweep-store";
import { resetSpectrumFeed } from "../../src/cockpit/sweep/spectrum-load";
import type { FocusBeatDetail } from "../../src/cockpit/sweep/focus-seam";
import type { StreamState, SweepEvent } from "../../src/cockpit/sweep/types";

const T0 = Date.parse("2026-07-25T13:40:00");

const ev = (timeMs: number): SweepEvent => ({
  eventId: `e${timeMs}`,
  timeMs,
  category: "tool",
  isError: false,
  eventType: "tool",
  outcome: null,
  errorCode: null,
  runId: "run-1",
  turnId: "t1",
  parentEventId: null,
  description: "",
});

/** A live stream, so the band's aria-label carries the event count rather
 * than a status sentence — the count is how this file OBSERVES the view. */
const LIVE: StreamState = {
  status: "live",
  lastEventMs: T0 + 600_000,
  eventsReceived: 4,
};

/** Events spread wide enough that zooming in genuinely drops some out of
 * the window — that drop is the visible proof the view moved. */
const EVENTS = [ev(T0), ev(T0 + 200_000), ev(T0 + 400_000), ev(T0 + 600_000)];

function mount(onFocusBeat?: (d: FocusBeatDetail) => void) {
  const { container } = render(Sweep, {
    props: {
      events: EVENTS,
      stream: LIVE,
      ...(onFocusBeat !== undefined ? { onFocusBeat } : {}),
    },
  });
  const band = container.querySelector(".sweep") as HTMLElement;
  const canvas = container.querySelector("canvas") as HTMLCanvasElement;
  // jsdom has no pointer capture; the band asks for it on press.
  (canvas as unknown as { setPointerCapture(id: number): void }).setPointerCapture =
    () => {};
  return { container, band, canvas };
}

/**
 * THE VIEW, AS A NUMBER. `bins.eventCount` counts only the events inside the
 * window the painter is drawing (sweep/bins.ts `binEvents`), and the canvas
 * publishes it on its own label. Zoom in and it falls; leave the view alone
 * and it cannot move. So this is the band's view, read through the same
 * surface a screen reader reads — not through a test-only hook.
 */
function eventsInView(canvas: HTMLCanvasElement): number {
  const label = canvas.getAttribute("aria-label") ?? "";
  const m = /(\d+) events on the band/.exec(label);
  if (m === null) {
    throw new Error(`the band is not reporting its event count: "${label}"`);
  }
  return Number(m[1]);
}

function wheel(
  canvas: HTMLCanvasElement,
  deltaY: number,
  opts: { shiftKey?: boolean } = {},
): WheelEvent {
  const e = new MouseEvent("wheel", {
    bubbles: true,
    cancelable: true,
    ...(opts.shiftKey !== undefined ? { shiftKey: opts.shiftKey } : {}),
  }) as unknown as WheelEvent;
  Object.defineProperty(e, "deltaY", { value: deltaY });
  Object.defineProperty(e, "offsetX", { value: 0 });
  canvas.dispatchEvent(e as unknown as Event);
  return e;
}

function pointerMove(canvas: HTMLCanvasElement, offsetX: number): void {
  const e = new MouseEvent("pointermove", { bubbles: true }) as unknown as PointerEvent;
  Object.defineProperty(e, "offsetX", { value: offsetX });
  canvas.dispatchEvent(e as unknown as Event);
}

function press(canvas: HTMLCanvasElement, offsetX = 0): void {
  for (const type of ["pointerdown", "pointerup"] as const) {
    const e = new MouseEvent(type, { bubbles: true }) as unknown as PointerEvent;
    Object.defineProperty(e, "offsetX", { value: offsetX });
    Object.defineProperty(e, "pointerId", { value: 1 });
    canvas.dispatchEvent(e as unknown as Event);
  }
}

beforeEach(() => {
  cleanup();
  resetSweep();
  resetSpectrumFeed();
  sweepMarks.set([]);
});

// ── 1. THE WHEEL ──────────────────────────────────────────────────────────

describe("channel 1 — the wheel", () => {
  test("an inert band passes the wheel through: the view does not move, and the event is NOT preventDefaulted", async () => {
    const { band, canvas } = mount();
    await tick();
    expect(band.dataset.active).toBe("inert");

    const before = eventsInView(canvas);
    const zoomIn = wheel(canvas, -120);
    await tick();

    expect(eventsInView(canvas)).toBe(before);
    // The other half, and the one that makes "inert" mean inert: we do not
    // consume the gesture either. Whatever would have scrolled still can.
    expect(zoomIn.defaultPrevented).toBe(false);

    // …and the same for the pan variant (⇧), which is a different branch.
    const pan = wheel(canvas, 120, { shiftKey: true });
    await tick();
    expect(eventsInView(canvas)).toBe(before);
    expect(pan.defaultPrevented).toBe(false);
  });

  test("NON-VACUITY: a click activates, and the activated band's wheel really does zoom", async () => {
    const { band, canvas } = mount();
    await tick();
    const before = eventsInView(canvas);

    press(canvas);
    await tick();
    expect(band.dataset.active).toBe("active");

    const zoomIn = wheel(canvas, -120);
    await tick();
    expect(zoomIn.defaultPrevented).toBe(true);
    // Zooming in narrows the window, so events fall outside it. This is the
    // assertion that proves the inert test above is not vacuous: the number
    // it watches CAN move, and does — it simply must not while inert.
    expect(eventsInView(canvas)).toBeLessThan(before);
  });
});

// ── 2. THE HOVER PREVIEW (the channel that is not a wheel) ────────────────

describe("channel 2 — the hover preview into the flow", () => {
  test("an inert band emits NO focusBeat while the pointer crosses it", async () => {
    const seen: FocusBeatDetail[] = [];
    const { band, canvas } = mount((d) => seen.push(d));
    await tick();
    expect(band.dataset.active).toBe("inert");

    for (let x = 0; x < 200; x += 20) pointerMove(canvas, x);
    // Previews are coalesced to the animation frame, so give the frame that
    // would have carried them a chance to run before concluding it is quiet.
    await new Promise((r) => setTimeout(r, 50));

    expect(seen).toEqual([]);
  });

  test("NON-VACUITY: an activated band previews again — scrub-moves-the-flow is kept, not removed", async () => {
    const seen: FocusBeatDetail[] = [];
    const { band, canvas } = mount((d) => seen.push(d));

    canvas.focus(); // keyboard parity: focus is the keyboard's click
    await tick();
    expect(band.dataset.active).toBe("active");

    // The IDENTICAL pointer sweep the inert test performs.
    for (let x = 0; x < 200; x += 20) pointerMove(canvas, x);
    await vi.waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen[seen.length - 1]!.preview).toBe(true);
    expect(seen[seen.length - 1]!.via).toBe("hover");
  });
});

// ── 3. DISCOVERABILITY, RELEASE, AND KEYBOARD PARITY ──────────────────────

describe("the band says what it will do, and gives itself back", () => {
  test("an inert band states what a click will do — in words, on the band and on its label", async () => {
    const { container, canvas } = mount();
    pointerMove(canvas, 40);
    await tick();

    const note = container.querySelector(".activation-note") as HTMLElement;
    expect(note).not.toBeNull();
    expect(note.textContent).toContain("click to");
    // The same words reach a screen reader through the canvas's own label —
    // an affordance only the eye can find is not an affordance.
    expect(canvas.getAttribute("aria-label")).toContain(note.textContent);
  });

  test("an activated band says it has the wheel, and how to hand it back", async () => {
    const { container, canvas } = mount();
    press(canvas);
    await tick();
    const note = container.querySelector(".activation-note") as HTMLElement;
    expect(note.textContent).toMatch(/wheel/);
    expect(note.textContent).toMatch(/Esc/);
  });

  test("blur releases it — nobody is left holding the wheel they cannot see", async () => {
    const { band, canvas } = mount();
    canvas.focus();
    await tick();
    expect(band.dataset.active).toBe("active");
    canvas.blur();
    await tick();
    expect(band.dataset.active).toBe("inert");
  });

  test("Esc gives the band back BEFORE it gives up the past view — innermost first", async () => {
    const { band, canvas } = mount();
    press(canvas); // plants a head AND activates
    await tick();
    expect(band.dataset.active).toBe("active");

    canvas.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await tick();
    expect(band.dataset.active).toBe("inert");
  });
});

// ── THE ARM CHORD BRIDGES TO THE SHELL'S RIGHT MENU ────────────────────────
//
// The arm menu has two hosts and ONE grammar. Standalone (the dev harness,
// these tests' own mounts) it is the raised Popover over the band, opened by
// the band's own `a` key. Under the cockpit shell it is the RIGHT-MENU column
// (shell/right-menu.ts + RightMenuHost.svelte), and every open path — the
// band's `a`, the ⌘⇧A claim the SWEEP holds, the side rail's `arm` word —
// must reach the SAME state through the store, so that exactly one arm
// surface is ever on screen per mount.
//
// The bridge is proven at both ends: a shell-handed band toggles the STORE
// (no local popover), a shell-less band keeps the Popover (the store
// untouched), and the whole mounted shell answers ⌘⇧A with the hosted column.
//
// The outlets mock is FILE-WIDE and harmless to the mounts above: they take
// Sweep directly and never read the outlet registry; only the full-shell
// arm below discovers the sweep through it.

vi.mock("../../src/cockpit/shell/outlets.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/cockpit/shell/outlets.ts")>(),
  outletExists: () => false,
  loadOutlet: async (id: string) =>
    id === "sweep" ? (await import("../../src/cockpit/sweep/Sweep.svelte")).default : null,
  roomExists: () => false,
  loadRoom: async () => null,
}));

import { closeRightMenu, rightMenu } from "../../src/cockpit/shell/right-menu.ts";
import type { ShellApi } from "../../src/cockpit/shell/contract.ts";
import { mount as svelteMount, unmount as svelteUnmount } from "svelte";
import { until } from "../helpers/until.ts";

type ShellJson = Record<string, unknown> | unknown[];

function shellJsonResponse(body: ShellJson, status = 200): Response {
  return { ok: status === 200, status, json: async () => body } as unknown as Response;
}

/** The API surface a full Cockpit needs to reveal, plus an honest refusal
 * (404) for everything else — the spectrum read has no project to scope to,
 * and a refused read degrades to the empty band rather than an error. */
function stubApiForShell(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes("/api/health")) return shellJsonResponse({ status: "ok" });
      if (url.includes("/api/auth/status"))
        return shellJsonResponse({
          setupRequired: false,
          authenticated: true,
          username: "ada",
          isAdmin: true,
        });
      if (url.includes("/api/schema/ui"))
        return shellJsonResponse({
          menus: [],
          panels: [],
          widgets: [],
          modules: [],
          settings: [],
          actions: [],
          signals: [],
        });
      if (url.includes("/api/projects")) return shellJsonResponse([]);
      return shellJsonResponse({ error: "not stubbed" }, 404);
    }),
  );
}

async function waitForReveal(host: HTMLElement): Promise<void> {
  await until(() => host.querySelector(".shell")?.getAttribute("data-revealed") === "true");
}

describe("the arm chord bridges to the shell's right menu", () => {
  beforeEach(() => {
    resetSweep();
    resetSpectrumFeed();
    closeRightMenu();
    window.sessionStorage.clear();
  });

  /** A minimal ShellApi: the band needs only `claimKey` at mount (and the
   * presence of the object is what "hosted" means to it). */
  const fakeShell = {
    claimKey: () => () => {},
    pushDismiss: () => () => {},
    hint: () => {},
  } as unknown as ShellApi;

  function keyA(el: HTMLElement): void {
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }),
    );
  }

  test("a shell-handed band's `a` toggles the RIGHT MENU store, and no popover mounts", async () => {
    const { container } = render(Sweep, {
      props: { shell: fakeShell, events: EVENTS, stream: LIVE },
    });
    const band = container.querySelector(".sweep") as HTMLElement;
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    canvas.focus();
    await tick();
    expect(band.dataset.active).toBe("active");

    expect(rightMenu.get()).toBeNull();
    keyA(canvas);
    expect(rightMenu.get()).toBe("arm");
    expect(
      container.querySelector(".popover"),
      "under the shell the arm menu is the hosted column, not the local popover",
    ).toBeNull();

    keyA(canvas);
    expect(rightMenu.get(), "the same press closes it — one toggle, one surface").toBeNull();
    cleanup();
  });

  test("a standalone band's `a` keeps the local Popover, and the store stays null", async () => {
    const { container } = render(Sweep, {
      props: { events: EVENTS, stream: LIVE },
    });
    const canvas = container.querySelector("canvas") as HTMLCanvasElement;
    canvas.focus();
    await tick();

    keyA(canvas);
    await tick();
    const popover = container.querySelector(".popover") as HTMLElement;
    expect(popover, "no shell, no host — the raised Popover carries the grammar").not.toBeNull();
    expect(rightMenu.get()).toBeNull();
    // The capture row names the band's real span through the sweep-store
    // mirror — the same fact the hosted column reads.
    await waitFor(() => expect(popover.querySelector('[data-verb-id="disclosure.arm-sec-capture"]')).not.toBeNull());
    const captureGrip = popover.querySelector<HTMLButtonElement>('[data-verb-id="disclosure.arm-sec-capture"]')!;
    if (captureGrip.getAttribute("aria-expanded") !== "true") captureGrip.click();
    await tick();
    expect(popover.textContent).toContain("13:40:00");

    keyA(canvas);
    await tick();
    expect(container.querySelector(".popover")).toBeNull();
    cleanup();
  });

  test("the whole mounted shell answers ⌘⇧A with the hosted column (the SWEEP's claim, the shell's column)", async () => {
    stubApiForShell();
    const { default: Cockpit } = await import("../../src/cockpit/Cockpit.svelte");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const app = svelteMount(Cockpit, { target: host });
    try {
      await waitForReveal(host);
      expect(
        host.querySelector(".sweep-outlet .sweep"),
        "the real sweep must be the mounted outlet for the claim to exist",
      ).not.toBeNull();

      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "a",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await new Promise((r) => setTimeout(r, 20));
      expect(rightMenu.get()).toBe("arm");
      const column = host.querySelector("aside.right-menu");
      expect(column, "the hosted column, not a popover over the band").not.toBeNull();
      expect(host.querySelector(".popover")).toBeNull();

      // THE LANDING, through the claim path too: ⌘R re-lands the ONE column
      // at the run group (it does not open a second column — there is one),
      // and ⌘⇧A re-lands it at the arm group. One column, one host, two
      // landings.
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "r", ctrlKey: true, bubbles: true }),
      );
      await new Promise((r) => setTimeout(r, 20));
      expect(rightMenu.get()).toBe("run");
      expect(host.querySelector("aside.right-menu"), "the same one column stays up").not.toBeNull();
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "a",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await new Promise((r) => setTimeout(r, 20));
      expect(rightMenu.get()).toBe("arm");
      expect(host.querySelectorAll("aside.right-menu").length, "never a second column").toBe(1);
    } finally {
      svelteUnmount(app);
      host.remove();
      closeRightMenu();
      window.sessionStorage.clear();
      vi.unstubAllGlobals();
    }
  });
});
