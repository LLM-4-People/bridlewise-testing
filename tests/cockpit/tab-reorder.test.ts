// @vitest-environment jsdom
/**
 * THE POINTER VOCABULARY OF TABS AND REELS — drag to reorder, middle-click
 * to close or to open in a new tab. One file because it is one subject: the
 * gestures a browser's own tab strip taught everyone, wired to the doors
 * that already exist.
 *
 *   A. THE ORDER OWNER (state/workspaces.moveWorkspace): the workspaces atom
 *      is the ONE list — a move re-arranges it in place, the write-through
 *      listener persists it exactly like an open or a close (no second
 *      store, no drop-time reconciliation), the active workspace never
 *      changes, and unknown ids / out-of-range positions are REFUSED.
 *
 *   B. THE GESTURE (WorkspaceStrip): pointer capture (never the HTML5 drag
 *      API), live reorder as midpoints are crossed, and the click that
 *      follows a real drag is swallowed — a drag must not also switch tabs.
 *      A press below the start threshold stays a click.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

import {
  activateWorkspace,
  activeWorkspaceId,
  moveWorkspace,
  openWorkspace,
  resetWorkspaces,
  workspaces,
} from "../../src/state/workspaces.ts";
import { clearOpenIntent, openIntent } from "../../src/cockpit/shell/open-intent.ts";
import Reel from "../../src/cockpit/rooms/Reel.svelte";
import { resetProjects } from "../../src/state/projects.ts";
import { resetChats } from "../../src/state/chats.ts";
import WorkspaceStrip from "../../src/cockpit/shell/WorkspaceStrip.svelte";

// jsdom has no layout, so it has no ResizeObserver; the strip's width binding
// asks for one. Inert is honest here — geometry is stubbed per slot below.
class InertResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
const entryResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= InertResizeObserver;
// jsdom has no ResizeObserver. The fallback is installed at module scope for
// this file's components; put the entry descriptor back at teardown so the
// next file inherits the environment it had, not this file's polyfill.
afterAll(() => {
  if (entryResizeObserver === undefined) {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  } else {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = entryResizeObserver;
  }
});

beforeEach(() => {
  window.sessionStorage.clear();
  resetWorkspaces();
  clearOpenIntent();
});

afterEach(() => {
  resetWorkspaces();
  resetProjects();
  resetChats();
  clearOpenIntent();
});

// ── A. the order owner ─────────────────────────────────────────────────────

describe("moveWorkspace — the one list re-arranged, persisted, active untouched", () => {
  function threeWorkspaces(): readonly [string, string, string] {
    const a = activeWorkspaceId.get()!;
    const b = openWorkspace({ projectId: "p2", chatId: null }).id;
    const c = openWorkspace({ projectId: "p3", chatId: null }).id;
    activateWorkspace(a);
    return [a, b, c];
  }

  test("a move re-orders the list and the write-through persists the NEW order", () => {
    const [a, b, c] = threeWorkspaces();
    expect(moveWorkspace(a, 2)).toBe(true);
    expect(workspaces.get().map((w) => w.id)).toEqual([b, c, a]);
    // The same listener every list change goes through — no second store.
    const stored = JSON.parse(window.sessionStorage.getItem("bridlewise:workspaces")!) as {
      id: string;
    }[];
    expect(stored.map((w) => w.id)).toEqual([b, c, a]);
    // Dragging a tab MOVES it, never switches to it.
    expect(activeWorkspaceId.get()).toBe(a);
  });

  test("an unknown id and an out-of-range position are refused UNCHANGED", () => {
    const [a, b, c] = threeWorkspaces();
    expect(moveWorkspace("ws-nope", 0)).toBe(false);
    expect(moveWorkspace(a, 3)).toBe(false);
    expect(moveWorkspace(a, -1)).toBe(false);
    expect(moveWorkspace(a, 1.5)).toBe(false);
    expect(workspaces.get().map((w) => w.id)).toEqual([a, b, c]);
  });

  test("moving to its own position is a clean no-op", () => {
    const [a, b, c] = threeWorkspaces();
    const before = workspaces.get();
    expect(moveWorkspace(b, 1)).toBe(true);
    expect(workspaces.get()).toBe(before); // not even a new array — nothing happened
    void a;
    void c;
  });
});

// ── B. the gesture ─────────────────────────────────────────────────────────

describe("the strip's drag", () => {
  let host: HTMLElement | null = null;
  let app: object | null = null;

  function mountStrip(): HTMLElement {
    host = document.createElement("div");
    document.body.appendChild(host);
    app = mount(WorkspaceStrip, {
      target: host,
      props: {
        revealed: true,
        onnewtab: () => undefined,
        onactivevisible: () => undefined,
      },
    });
    flushSync();
    return host;
  }

  afterEach(() => {
    if (app !== null) unmount(app);
    app = null;
    host?.remove();
    host = null;
  });

  /** Stub each rendered slot's rect so midpoint arithmetic has geometry —
   * jsdom lays nothing out. 100px per slot, in DOM order at call time. */
  function stubSlotRects(root: HTMLElement): void {
    root.querySelectorAll<HTMLElement>(".tabs .slot").forEach((slot, i) => {
      slot.getBoundingClientRect = () =>
        ({ left: i * 100, width: 100, right: i * 100 + 100 }) as DOMRect;
    });
  }

  const pointer = (type: string, x: number): PointerEvent =>
    new MouseEvent(type, { bubbles: true, clientX: x }) as unknown as PointerEvent;

  test("dragging the first tab past the others reorders the OWNER's list live, and the release-click is swallowed", () => {
    const a = activeWorkspaceId.get()!;
    const b = openWorkspace({}).id;
    const c = openWorkspace({}).id;
    activateWorkspace(a);
    const el = mountStrip();
    stubSlotRects(el);

    const tabs = el.querySelectorAll<HTMLButtonElement>(".tabs .tab");
    expect(tabs.length).toBe(3);
    const first = tabs[0]!;
    (first as unknown as { setPointerCapture: (id: number) => void }).setPointerCapture =
      vi.fn();

    first.dispatchEvent(pointer("pointerdown", 50));
    // Past all three midpoints (50, 150, 250): the tab lands at the end.
    first.dispatchEvent(pointer("pointermove", 260));
    expect(workspaces.get().map((w) => w.id)).toEqual([b, c, a]);
    expect(
      (first as unknown as { setPointerCapture: ReturnType<typeof vi.fn> }).setPointerCapture,
    ).toHaveBeenCalled();
    first.dispatchEvent(pointer("pointerup", 260));
    flushSync();

    // The click that follows a drag must not switch tabs…
    activateWorkspace(b);
    first.click();
    flushSync();
    expect(activeWorkspaceId.get()).toBe(b);

    // …but the NEXT plain click is a click again.
    first.click();
    flushSync();
    expect(activeWorkspaceId.get()).toBe(a);
  });

  test("a press below the drag threshold stays a CLICK and moves nothing", () => {
    const a = activeWorkspaceId.get()!;
    const b = openWorkspace({}).id;
    activateWorkspace(b);
    const el = mountStrip();
    stubSlotRects(el);

    const first = el.querySelector<HTMLButtonElement>(".tabs .tab")!;
    (first as unknown as { setPointerCapture: (id: number) => void }).setPointerCapture =
      () => undefined;
    first.dispatchEvent(pointer("pointerdown", 50));
    first.dispatchEvent(pointer("pointermove", 52)); // 2px — a shaky click, not a drag
    first.dispatchEvent(pointer("pointerup", 52));
    first.click();
    flushSync();
    expect(workspaces.get().map((w) => w.id)).toEqual([a, b]);
    expect(activeWorkspaceId.get()).toBe(a);
  });
});


// ── The middle-click halves (merged from the strip/reel gesture suite) ─────

let mcHost: HTMLElement | null = null;
let mcApp: object | null = null;

function mountComp(component: unknown, props: Record<string, unknown>): HTMLElement {
  mcHost = document.createElement("div");
  document.body.appendChild(mcHost);
  mcApp = mount(component as never, { target: mcHost, props: props as never });
  flushSync();
  return mcHost;
}

afterEach(() => {
  if (mcApp !== null) unmount(mcApp);
  mcApp = null;
  mcHost?.remove();
  mcHost = null;
});

const aux = (button: number): MouseEvent =>
  new MouseEvent("auxclick", { bubbles: true, cancelable: true, button });

describe("a tab middle-clicks closed through the one close path", () => {
  test("button 1 closes; button 2 does not; the LAST tab is refused by the owner", () => {
    const a = activeWorkspaceId.get()!;
    const b = openWorkspace({}).id;
    activateWorkspace(a);
    const el = mountComp(WorkspaceStrip, {
      revealed: true,
      onnewtab: () => undefined,
      onactivevisible: () => undefined,
    });

    const tabs = el.querySelectorAll<HTMLButtonElement>(".tabs .tab");
    expect(tabs.length).toBe(2);

    // A RIGHT press's auxclick is the menu's, never a close.
    tabs[1]!.dispatchEvent(aux(2));
    flushSync();
    expect(workspaces.get().length).toBe(2);

    tabs[1]!.dispatchEvent(aux(1));
    flushSync();
    expect(workspaces.get().map((w) => w.id)).toEqual([a]);
    void b;

    // The gesture reaches the SAME refusal the × wears: one tab left, the
    // state owner says no, and the strip still shows it.
    const last = el.querySelectorAll<HTMLButtonElement>(".tabs .tab");
    expect(last.length).toBe(1);
    last[0]!.dispatchEvent(aux(1));
    flushSync();
    expect(workspaces.get().length).toBe(1);
  });

  test("the tab teaches the gesture exactly while it is possible", () => {
    const a = activeWorkspaceId.get()!;
    openWorkspace({});
    activateWorkspace(a);
    const el = mountComp(WorkspaceStrip, {
      revealed: true,
      onnewtab: () => undefined,
      onactivevisible: () => undefined,
    });
    for (const tab of el.querySelectorAll<HTMLButtonElement>(".tabs .tab")) {
      expect(tab.title).toContain("middle-click closes");
    }
  });
});

describe("a reel middle-clicks open in a NEW tab through the one intent bit", () => {
  const REEL = {
    chat: { id: "c1", projectId: "p1", title: "fix the parser" },
    updatedMs: 1_700_000_000_000,
  };

  function reelProps(onResume = vi.fn(), onReplay = vi.fn()) {
    return {
      reel: REEL,
      index: 0,
      focused: false,
      outcome: { kind: "absent", reason: "no runs yet" },
      density: { kind: "absent", reason: "no events recorded" },
      nowMs: 1_700_000_100_000,
      onResume,
      onReplay,
    };
  }

  // The row's resume verb — the button that owns click, middle-click and the
  // gesture's title (the reel itself is only the row's frame).
  const resumeOf = (el: Element): HTMLElement =>
    el.querySelector<HTMLElement>('[data-verb-id="switch.resume"]')!;

  test("button 1 arms the new-tab bit and runs the row's OWN resume", () => {
    const onResume = vi.fn();
    const el = mountComp(Reel, reelProps(onResume));
    expect(openIntent.get()).toBe("replace");
    resumeOf(el).dispatchEvent(aux(1));
    // The bit is armed BEFORE the resume runs, which is the order `land()`
    // needs — it takes the intent at the moment of the choice.
    expect(openIntent.get()).toBe("new-tab");
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  test("button 2 arms nothing and resumes nothing; a plain click stays a plain resume", () => {
    const onResume = vi.fn();
    const el = mountComp(Reel, reelProps(onResume));
    resumeOf(el).dispatchEvent(aux(2));
    expect(openIntent.get()).toBe("replace");
    expect(onResume).not.toHaveBeenCalled();

    resumeOf(el).click();
    expect(openIntent.get()).toBe("replace");
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  test("the row teaches the gesture in its own words", () => {
    const el = mountComp(Reel, reelProps());
    expect(resumeOf(el).title).toContain(
      "middle-click opens it in a new tab",
    );
  });
});
