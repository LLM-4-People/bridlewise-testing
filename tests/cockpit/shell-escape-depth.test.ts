// @vitest-environment jsdom
/**
 * ESC, BY DEPTH — the routing contract driven through the REAL shell with
 * real key events, not asserted about in the abstract.
 *
 * THE DEFECT. The shell's escape order was `room → scope → claimed`, with
 * room-internal claims consulted LAST. Pressing Esc with a difference open
 * inside Custody closed the whole ROOM: the file list, the scroll position
 * and the difference went in one keystroke, having asked to close one thing.
 * The fix is a dismissal ladder (shell/routing.ts) that takes the INNERMOST
 * open surface first, one level per press.
 *
 * The room here is a fixture with Custody's shape and none of its data
 * (fixtures/NestedRoom.svelte). It registers its nested surface with
 * `shell.pushDismiss` and owns no key listener at all, so everything below
 * measures the shell.
 *
 * Harness style mirrors shell-room-load-failure.test.ts: a real Cockpit over
 * a stubbed API, with outlet DISCOVERY mocked so the room exists.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mount, unmount } from "svelte";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";

import NestedRoom from "./fixtures/NestedRoom.svelte";
import Sweep from "../../src/cockpit/sweep/Sweep.svelte";
import type { StreamState, SweepEvent } from "../../src/cockpit/sweep/types";

vi.mock("../../src/cockpit/shell/outlets.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/cockpit/shell/outlets.ts")>(),
  outletExists: () => false,
  loadOutlet: async () => null,
  roomExists: (id: string) => id === "custody" || id === "settings",
  loadRoom: async (id: string) =>
    id === "custody" ? NestedRoom : id === "settings" ? SettingsRoom : null,
}));

import Cockpit from "../../src/cockpit/Cockpit.svelte";
import SettingsRoom from "../../src/cockpit/rooms/SettingsRoom.svelte";
import { plantHead, returnToLive } from "../../src/data/asof.ts";
import { openRightMenu, rightMenu } from "../../src/cockpit/shell/right-menu.ts";

type Json = Record<string, unknown> | unknown[];

function jsonResponse(body: Json): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function stubApi(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes("/api/health")) return jsonResponse({ status: "ok" });
      if (url.includes("/api/auth/status"))
        return jsonResponse({
          setupRequired: false,
          authenticated: true,
          username: "ada",
          isAdmin: true,
        });
      // The full v2 schema shape (shared/ui-schema.ts): the fields are
      // REQUIRED so a stub that omits one fails where it is read — the
      // settings room iterates `schema.settings` at mount (UIE-033's arm).
      if (url.includes("/api/schema/ui"))
        return jsonResponse({
          menus: [],
          panels: [],
          widgets: [],
          modules: [],
          settings: [],
          actions: [],
          signals: [],
        });
      if (url.includes("/api/projects")) return jsonResponse([]);
      throw new Error(`unstubbed fetch: ${url}`);
    }),
  );
}

async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

let host: HTMLElement;
let app: object | null = null;

/** A real Esc, dispatched the way a keyboard delivers one. */
function esc(): void {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
}

/** jsdom is non-mac: the Custody chord fires on Ctrl+G. */
function openCustodyChord(): void {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "g", ctrlKey: true, bubbles: true, cancelable: true }),
  );
}

/** jsdom is non-mac: the Settings chord fires on Ctrl+, (UIE-033's room). */
function openSettingsChord(): void {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: ",", ctrlKey: true, bubbles: true, cancelable: true }),
  );
}

const roomOnScreen = (): boolean =>
  host.querySelector('[data-room-active="true"]') !== null;
const nestedOnScreen = (): boolean =>
  host.querySelector('[data-testid="nested"]') !== null;
const sheetOnScreen = (): boolean =>
  host.querySelector(".inline-sheet") !== null;
const hintText = (): string => host.querySelector(".hint")?.textContent ?? "";

/** Open the room, then the surface inside it. */
async function openRoomAndNested(): Promise<void> {
  openCustodyChord();
  await waitFor(roomOnScreen);
  host.querySelector<HTMLButtonElement>('[data-testid="open-nested"]')!.click();
  await waitFor(nestedOnScreen);
}

/** Open Settings (the real room), then one row's inline sheet. */
async function openSettingsAndSheet(): Promise<void> {
  openSettingsChord();
  await waitFor(() => host.querySelector('[data-room-active="true"] .setting-row') !== null);
  host.querySelector<HTMLButtonElement>('[data-verb-id="settings.index/adjust"]')!.click();
  await waitFor(sheetOnScreen);
}

beforeEach(async () => {
  returnToLive();
  if (typeof window.requestAnimationFrame !== "function") {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 16),
    );
  }
  // The real SettingsRoom measures its own box (a ResizeObserver); jsdom has
  // none. A no-op class stands in — the measured width stays 0, the room
  // renders its narrow layout, which is all UIE-033's arms need.
  if (typeof window.ResizeObserver !== "function") {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
  }
  stubApi();
  host = document.createElement("div");
  document.body.appendChild(host);
  app = mount(Cockpit, { target: host });
  await waitFor(() => host.querySelector(".shell")?.getAttribute("data-revealed") === "true");
});

afterEach(() => {
  if (app !== null) unmount(app);
  app = null;
  host.remove();
  vi.unstubAllGlobals();
  returnToLive();
});

describe("Esc unwinds by depth — the innermost surface first", () => {
  test.each([
    '<button>Native action</button>',
    '<a href="#native-target">Native link</a>',
    '<details><summary>Native disclosure</summary></details>',
    '<div role="button" tabindex="0">Custom action</div>',
    '<button><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1" /></svg></button>',
  ])("native Enter remains owned by its control: %s", (markup) => {
    const fixture = document.createElement("div");
    fixture.innerHTML = markup;
    host.querySelector(".shell")!.appendChild(fixture);
    const target = fixture.querySelector("path") ?? fixture.querySelector("summary, button, a, [role=button]")!;
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    expect(event.defaultPrevented, "the global focused-beat chord must not cancel native activation").toBe(false);
    fixture.remove();
  });

  test("a key already handled by a local surface is not routed a second time", () => {
    const target = document.createElement("div");
    host.querySelector(".shell")!.appendChild(target);
    target.addEventListener("keydown", event => event.preventDefault());
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    const prevent = vi.spyOn(event, "preventDefault");
    target.dispatchEvent(event);
    expect(prevent, "the local handler consumed this key; the shell must not consume it again").toHaveBeenCalledTimes(1);
    target.remove();
  });

  test("a difference inside a room: first press closes the difference, the room STAYS", async () => {
    await openRoomAndNested();

    esc();
    await waitFor(() => !nestedOnScreen());
    // THE WHOLE DEFECT, in one assertion: the room the difference lives in is
    // still on screen, with its list and its scroll position intact.
    expect(roomOnScreen()).toBe(true);
  });

  test("…and the second press closes the room", async () => {
    await openRoomAndNested();
    esc();
    await waitFor(() => !nestedOnScreen());

    esc();
    await waitFor(() => !roomOnScreen());
    expect(nestedOnScreen()).toBe(false);
  });

  // MUTATION: proves the first press above was spent on the LAYER, not
  // swallowed. With nothing open inside it, one press closes the room.
  test("mutation — with no difference open, ONE press closes the room", async () => {
    openCustodyChord();
    await waitFor(roomOnScreen);
    esc();
    await waitFor(() => !roomOnScreen());
  });

  test("a surface left open in a HIDDEN room does not take the key", async () => {
    await openRoomAndNested();
    // Close the room from its own control, with the difference still open —
    // rooms are kept alive, so the difference is still open, just not visible.
    host.querySelector<HTMLButtonElement>('[data-verb-id="room.close"]')!.click();
    await waitFor(() => !roomOnScreen());
    // Esc must NOT be spent dismissing something nobody can see.
    esc();
    await waitFor(() => hintText().length > 0);
    expect(hintText()).toBe("Esc — nothing open, already at now");
  });

  test("reopening the room hands the key back to the surface inside it", async () => {
    await openRoomAndNested();
    host.querySelector<HTMLButtonElement>('[data-verb-id="room.close"]')!.click();
    await waitFor(() => !roomOnScreen());

    openCustodyChord();
    await waitFor(roomOnScreen);
    // The difference survived the round trip (keep-alive) — and so did its
    // claim on Esc, with nothing re-registered by the surface.
    expect(nestedOnScreen()).toBe(true);
    esc();
    await waitFor(() => !nestedOnScreen());
    expect(roomOnScreen()).toBe(true);
  });

  // ── THE SETTINGS SHEET (UIE-033) — the same defect, the same ladder ──
  //
  // Measured live: with a setting's inline sheet open, Esc closed the whole
  // of Settings — search, scroll, folded categories and sheet in one
  // keystroke — because the room-internal claim was consulted last. The
  // real room is mounted here (only the API is stubbed) so the arm measures
  // the room's own registration, not a fixture's goodwill.
  //
  // MUTATION: remove the `pushDismiss` effect from SettingsRoom.svelte and
  // the first arm fails — one press closes the room with the sheet open.
  test("a setting sheet open inside Settings: first press closes the sheet, the room STAYS", async () => {
    await openSettingsAndSheet();

    esc();
    await waitFor(() => !sheetOnScreen());
    // THE WHOLE DEFECT, in one assertion: the room the sheet lives in is
    // still on screen, with its search and its scroll position intact.
    expect(roomOnScreen()).toBe(true);
  });

  test("…and the second press closes the room", async () => {
    await openSettingsAndSheet();
    esc();
    await waitFor(() => !sheetOnScreen());

    esc();
    await waitFor(() => !roomOnScreen());
    expect(sheetOnScreen()).toBe(false);
  });

  // The settings-sheet mirror of the custody mutation arm: with no sheet
  // open, one press closes the room.
  test("mutation — with no setting sheet open, ONE press closes Settings", async () => {
    openSettingsChord();
    await waitFor(() => host.querySelector('[data-room-active="true"] .setting-row') !== null);
    esc();
    await waitFor(() => !roomOnScreen());
  });
});

describe("closing a room returns focus to the grip that opened it (UIE-047)", () => {
  /** The rail grip a mouse user would have clicked (jsdom does not move
   * focus on click(), so the test focuses it first — the state a real
   * pointer open leaves). */
  function railGrip(target: string): HTMLButtonElement {
    return host.querySelector<HTMLButtonElement>(
      `.rail [data-chord-target="${target}"]`,
    )!;
  }

  /** Focus is inside the room when it closes — the real-world state (the
   * search rooms grab their input on open; the close button takes focus on
   * click), and the only state in which a missing restore is observable:
   * with focus still on the opener, nothing would have been wrong. Every
   * arm therefore hands focus INTO the room before closing. */
  async function openWithFocusInside(): Promise<HTMLButtonElement> {
    const grip = railGrip("custody");
    grip.focus();
    grip.click();
    await waitFor(roomOnScreen);
    host.querySelector<HTMLButtonElement>('[data-verb-id="room.close"]')!.focus();
    expect(document.activeElement).not.toBe(grip);
    return grip;
  }

  test("mouse path: grip open → focus inside → Esc close → focus is back on the grip, not BODY", async () => {
    const grip = await openWithFocusInside();

    esc();
    await waitFor(() => !roomOnScreen());
    // THE DEFECT, in one assertion: focus used to fall to BODY (a focused
    // element inside the now-inert room is dropped by the engine), so the
    // reader's next Tab started at the document top.
    expect(document.activeElement).toBe(grip);
  });

  test("the room's own CLOSE button returns focus to the opener too", async () => {
    const grip = await openWithFocusInside();

    host.querySelector<HTMLButtonElement>('[data-verb-id="room.close"]')!.click();
    await waitFor(() => !roomOnScreen());
    expect(document.activeElement).toBe(grip);
  });

  test("chord path: the focus the chord found is the focus the close returns", async () => {
    // A keyboard open leaves focus wherever the reader was — the composer.
    const composer = host.querySelector<HTMLInputElement>('input[name="composer"]')!;
    composer.focus();
    openCustodyChord();
    await waitFor(roomOnScreen);
    host.querySelector<HTMLButtonElement>('[data-verb-id="room.close"]')!.focus();

    esc();
    await waitFor(() => !roomOnScreen());
    expect(document.activeElement).toBe(composer);
  });

  test("an opener unmounted since the open does not receive focus (isConnected guard)", async () => {
    const grip = await openWithFocusInside();
    // The opener leaves the DOM while the room is open (a virtualized grip,
    // a remounted rail — modeled by removal).
    grip.remove();

    esc();
    await waitFor(() => !roomOnScreen());
    // Focus falls to the document — the honest fallback, never a dead node.
    expect(document.activeElement).not.toBe(grip);
  });
});

describe("the ladder's floor — the past view is reached LAST", () => {
  test("with a room open, Esc closes the room before it returns to now", async () => {
    plantHead(1_700_000_000_000);
    openCustodyChord();
    await waitFor(roomOnScreen);

    esc();
    await waitFor(() => !roomOnScreen());
    // Still a past view: closing what is on screen never silently un-plants
    // the head as a side effect.
    expect(host.querySelector(".past-band")).not.toBeNull();

    // …and now the head is what Esc means. (No SWEEP is mounted here, so
    // this exercises the shell's own fallback; with a sweep the fallback is
    // its floor layer, which additionally unpins the band's view.)
    esc();
    await waitFor(() => host.querySelector(".past-band") === null);
  });

  test("with nothing open and nothing planted, Esc says so rather than nothing", async () => {
    esc();
    await waitFor(() => hintText().length > 0);
    expect(hintText()).toBe("Esc — nothing open, already at now");
  });
});

// ── the shell's own toggled surfaces and the identity menu ────────────────
//
// THE LADDER'S CONTRACT IS FOR EVERY RAISED SURFACE, not only rooms and
// sheets: a surface that is visibly open must take the key before the honest
// "nothing open" hint fires, or the hint lies. Three surfaces were measured
// outside it (the identity glyph menu, the run pane, the desk) — Esc left
// each open while announcing "nothing open, already at now".

describe("the identity glyph menu is a dismissal layer", () => {
  const glyph = (): HTMLButtonElement =>
    host.querySelector<HTMLButtonElement>(".glyph")!;
  const menuOnScreen = (): boolean =>
    host.querySelector(".identity-menu") !== null;

  function openIdentityMenu(): void {
    glyph().click();
  }

  test("Esc closes the open menu, and no lying hint fires", async () => {
    openIdentityMenu();
    await waitFor(menuOnScreen);
    expect(glyph().getAttribute("aria-expanded")).toBe("true");

    esc();
    await waitFor(() => !menuOnScreen());
    expect(glyph().getAttribute("aria-expanded")).toBe("false");
    // The menu WAS the open surface — the layer-blind "nothing open" hint
    // must not have fired while it was visibly up.
    expect(hintText()).toBe("");
  });

  test("a press outside closes the menu (the web-native menu contract)", async () => {
    openIdentityMenu();
    await waitFor(menuOnScreen);
    document.body.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
    await waitFor(() => !menuOnScreen());
  });

  test("a press on the menu itself does not close it", async () => {
    openIdentityMenu();
    await waitFor(menuOnScreen);
    host.querySelector(".identity-menu")!.dispatchEvent(
      new window.Event("pointerdown", { bubbles: true }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(menuOnScreen()).toBe(true);
    esc();
    await waitFor(() => !menuOnScreen());
  });
});

describe("the right menu and the desk are dismissal layers (the LENS precedent)", () => {
  // THE SINGLE RIGHT MENU: one column, one landmark — the run
  // and arm groups live inside it, so "the menu is on screen" is one fact
  // with one selector, and Esc has one layer to unwind here no matter
  // which group the reader landed at.
  const paneOnScreen = (): boolean => host.querySelector("aside.right-menu") !== null;
  const deskOpen = (): boolean => host.querySelector('[id="inspector-tab-setup"][aria-selected="true"]') !== null;

  function chord(key: string): void {
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true }),
    );
  }

  test("Esc closes the open run pane, and no lying hint fires", async () => {
    chord("r");
    await waitFor(paneOnScreen);

    esc();
    await waitFor(() => !paneOnScreen());
    expect(hintText()).toBe("");
  });

  test("Esc closes the open desk, and no lying hint fires", async () => {
    chord(".");
    await waitFor(deskOpen);

    esc();
    await waitFor(() => !deskOpen());
    expect(hintText()).toBe("");
  });

  test("the inspector above a room closes before the room", async () => {
    chord("r");
    await waitFor(paneOnScreen);
    openCustodyChord();
    await waitFor(roomOnScreen);

    esc();
    await waitFor(() => !paneOnScreen());
    expect(roomOnScreen()).toBe(true);
    esc();
    await waitFor(() => !roomOnScreen());
  });

  test("switching from Activity to Setup keeps one dismissal layer", async () => {
    chord("r");
    await waitFor(paneOnScreen);
    chord(".");
    await waitFor(deskOpen);

    esc();
    await waitFor(() => !deskOpen());
    expect(paneOnScreen(), "Setup and Activity share one inspector").toBe(false);
  });

  test("their own grips still toggle them (the layer only adds Esc)", async () => {
    chord("r");
    await waitFor(paneOnScreen);
    chord("r");
    await waitFor(() => !paneOnScreen());
  });

  // ── THE ARM GROUP JOINS THE LADDER THROUGH THE ONE MENU ────────────────
  //
  // The arm group is the single menu's other half (shell/right-menu.ts):
  // landing at it does not raise a SECOND surface — the same one column,
  // the same one dismissal layer, the same ctx = null — so Esc finds the
  // same layer whether the reader landed at the run group or the arm
  // group, and a room on screen still takes the key ahead of it.
  function landAtArmGroup(): void {
    // The store seam the SWEEP's ⌘⇧A claim writes — the landing gesture the
    // ladder must answer, whatever wrote it.
    openRightMenu("arm");
  }

  test("landing at the ARM group is the SAME one layer: Esc closes it in one press, from either landing", async () => {
    // One host, one column: the ladder's open-order unwind applies between
    // the menu and the OTHER toggled surfaces (the desk arm above), never
    // inside the menu — re-landing at a group is not a raise.
    chord("r");
    await waitFor(paneOnScreen);
    landAtArmGroup();
    await waitFor(paneOnScreen);
    expect(rightMenu.get()).toBe("arm");

    esc();
    await waitFor(() => !paneOnScreen());
    expect(rightMenu.get()).toBeNull();
    expect(hintText()).toBe("");
  });

  test("Esc closes the menu landed at the ARM group, and no lying hint fires", async () => {
    landAtArmGroup();
    await waitFor(paneOnScreen);

    esc();
    await waitFor(() => !paneOnScreen());
    expect(hintText()).toBe("");
  });

  test("the Watches inspector closes before the room beneath it", async () => {
    landAtArmGroup();
    await waitFor(paneOnScreen);
    openCustodyChord();
    await waitFor(roomOnScreen);

    esc();
    await waitFor(() => !paneOnScreen());
    expect(roomOnScreen()).toBe(true);
    esc();
    await waitFor(() => !roomOnScreen());
  });
});

// ── UIE-031: THE BAND JOINS THE LADDER PROTOCOL ────────────────────────────
//
// THE DEFECT. One Esc released the band's wheel claim AND closed the run
// pane: the band's own Escape handler acted, then let the same keydown
// bubble on to the shell's dismissal ladder, which popped the NEXT layer —
// one press, two layers. The ladder's own rule (shell/routing.ts) is that a
// layer which consumed the press stops it; the band is not exempt just
// because it handles its keys privately.
//
// The full-shell harness above boots with no recorded history, so its band
// has no time window and no key grammar to act on. The Sweep is
// standalone-mountable (documented at its props — the same recipe as
// sweep-activation.test.ts), so the band here carries real events, and the
// ladder is a window keydown listener: exactly where the shell's ladder
// listens, and the only thing a bubbled press can still reach after a
// Svelte handler declined to stop it.

describe("the band joins the ladder — an Esc it consumed stops there (UIE-031)", () => {
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

  const EVENTS: readonly SweepEvent[] = [
    ev(T0),
    ev(T0 + 200_000),
    ev(T0 + 400_000),
    ev(T0 + 600_000),
  ];

  const LIVE: StreamState = {
    status: "live",
    lastEventMs: T0 + 600_000,
    eventsReceived: 4,
  };

  /** The window-level Esc count — the dismissal ladder's ears. Whatever
   * fires here is a layer the band let the press through to. */
  let ladderEscs: number;
  let onLadder: (e: KeyboardEvent) => void;

  beforeEach(() => {
    ladderEscs = 0;
    onLadder = (e) => {
      if (e.key === "Escape") ladderEscs += 1;
    };
    window.addEventListener("keydown", onLadder);
  });

  afterEach(() => {
    window.removeEventListener("keydown", onLadder);
    cleanup();
  });

  async function mountBand(): Promise<{ band: HTMLElement; canvas: HTMLCanvasElement }> {
    const rendered = render(Sweep, { props: { events: EVENTS, stream: LIVE } });
    const band = rendered.container.querySelector(".sweep") as HTMLElement;
    const canvas = rendered.container.querySelector(
      "canvas[data-scrub-band='true']",
    ) as HTMLCanvasElement;
    // jsdom has no pointer capture; the band asks for it on press.
    (canvas as unknown as { setPointerCapture(id: number): void }).setPointerCapture =
      () => {};
    // Focus is the keyboard's click: reaching the band hands it the wheel
    // (Sweep's own keyboard-parity rule), so this is the state the drive
    // reproduced — focus on the band, wheel held.
    canvas.focus();
    await tick();
    expect(band.getAttribute("data-active"), "focus hands the band the wheel").toBe("active");
    return { band, canvas };
  }

  function escOnBand(canvas: HTMLCanvasElement): void {
    canvas.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  }

  test("Esc with the wheel held: the band releases, and the press goes NO further", async () => {
    const { band, canvas } = await mountBand();

    escOnBand(canvas);
    await tick();

    // The band CONSUMED the press…
    expect(band.getAttribute("data-active"), "the wheel is released").toBe("inert");
    // …so the ladder never heard it. With the defect, this same press
    // popped the next layer too — the run pane closed in one keystroke.
    expect(ladderEscs, "one press, one layer — the pane keeps its own press").toBe(0);
  });

  test("…and once the band holds nothing, the next Esc falls through to the ladder", async () => {
    const { band, canvas } = await mountBand();

    escOnBand(canvas); // first press: the band's own
    await tick();
    escOnBand(canvas); // second press: nothing band-owned left to dismiss
    await tick();

    expect(band.getAttribute("data-active")).toBe("inert");
    expect(ladderEscs, "an unconsumed press is still the ladder's to answer").toBe(1);
  });
});
