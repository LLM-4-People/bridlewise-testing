// @vitest-environment jsdom
/**
 * ROW CONTEXT MENUS — right-click on a row opens the shared
 * Popover listing that row's EXISTING verbs, wired to the SAME handlers.
 *
 * Two properties carry the whole feature, and both are the kind that rot
 * silently, so both are asserted mechanically:
 *
 *   1. NO SECOND ACTION PATH. Menu entries are proven to invoke the row's
 *      own handlers (spy identity — one call, from the menu, on the exact
 *      function the visible control uses), and the entry set is DERIVED for
 *      comparison from the verbs the row itself renders (`data-verb-id`
 *      values in the row's own DOM), never from a list this file maintains.
 *   2. DISMISSAL COMES FROM THE SHELL'S MACHINERY. The menu is a Popover, so
 *      Esc and a pointer press outside close it — asserted here through the
 *      standalone fallback (no shell above), which is the same component
 *      path minus the routing ladder.
 */
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import { flushSync, mount, tick, unmount } from "svelte";

import Reel from "../../src/cockpit/rooms/Reel.svelte";
import FileTree from "../../src/cockpit/editor/FileTree.svelte";
import WorkspaceStrip from "../../src/cockpit/shell/WorkspaceStrip.svelte";
import { openWorkspace, resetWorkspaces, workspaces } from "../../src/state/workspaces.ts";
import { resetProjects, setProjects } from "../../src/state/projects.ts";
import { resetChats, setChats } from "../../src/state/chats.ts";
import type { TreeEntry, TreeRow } from "../../src/cockpit/editor/tree.ts";

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

let host: HTMLElement | null = null;
let app: object | null = null;

function mountComp(component: unknown, props: Record<string, unknown>): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  app = mount(component as never, { target: host, props: props as never });
  flushSync();
  return host;
}

function rightClick(el: Element): MouseEvent {
  const ev = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: 40,
    clientY: 50,
  });
  el.dispatchEvent(ev);
  flushSync();
  return ev;
}

function menuVerbIds(root: HTMLElement): string[] {
  return [...root.querySelectorAll<HTMLElement>('[role="menu"] [data-verb-id]')].map(
    (el) => el.getAttribute("data-verb-id")!,
  );
}

afterEach(() => {
  if (app !== null) unmount(app);
  app = null;
  host?.remove();
  host = null;
  resetWorkspaces();
  resetProjects();
  resetChats();
  vi.restoreAllMocks();
});

// ── Fixtures ───────────────────────────────────────────────────────────────

const REEL = {
  chat: { id: "c1", projectId: "p1", title: "fix the parser" },
  updatedMs: 1_700_000_000_000,
};

function reelProps(onResume = vi.fn(), onReplay = vi.fn()) {
  return {
    reel: REEL,
    index: 0,
    focused: false,
    outcome: { kind: "measured", line: "1 run", startMs: 1_700_000_000_000, events: 3 },
    density: { kind: "absent", reason: "no events recorded" },
    nowMs: 1_700_000_100_000,
    onResume,
    onReplay,
  };
}

describe("the reel — a conversation row's verbs, from one declaration", () => {
  test("exact conversation details are directly available without an overflow menu or opening the conversation", async () => {
    const resume=vi.fn();
    const el=mountComp(Reel,{...reelProps(resume),focused:true});
    const details=el.querySelector<HTMLButtonElement>('[data-verb-id="switch.conversation-details"]')!;
    details.focus();details.click();flushSync();await tick();
    expect(details.getAttribute('aria-expanded')).toBe('true');
    expect(el.querySelector('[role="menu"]')).toBeNull();
    expect(el.querySelector('.full-title')!.textContent).toBe(REEL.chat.title);
    expect(el.querySelector('.full-outcome')!.textContent).toBe('1 run');
    expect(resume).not.toHaveBeenCalled();
    el.querySelector('.popover')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));flushSync();await tick();
    expect(el.querySelector('.popover')).toBeNull();
    expect(document.activeElement).toBe(details);
  });
  test("keyboard menu navigation and virtualization return focus use the shared menu lifetime", async () => {
    const fallback = document.createElement('input'); document.body.append(fallback);
    try {
      const el = mountComp(Reel, {...reelProps(),returnFocus:()=>fallback});
      const button = el.querySelector<HTMLButtonElement>('[data-verb-id="switch.conversation-menu"]')!;
      button.focus(); button.click(); flushSync(); await tick();
      const items = [...el.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
      expect(items.length).toBeGreaterThan(1);
      expect(document.activeElement, 'opening a menu enters its first action').toBe(items[0]);
      items[0]!.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));
      expect(document.activeElement).toBe(items.at(-1));
      items.at(-1)!.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));
      expect(document.activeElement).toBe(items[0]);
      unmount(app!); app=null; await tick(); await Promise.resolve();
      expect(document.activeElement, 'a removed virtual row returns to the surviving project search').toBe(fallback);
    } finally { fallback.remove(); }
  });
  test("direct opening and deliberate secondary menu actions share the existing handlers without duplicate Open", () => {
    const onResume = vi.fn();
    const onReplay = vi.fn();
    const el = mountComp(Reel, reelProps(onResume, onReplay));

    expect(el.querySelector('[data-verb-id="switch.resume"]')).not.toBeNull();
    expect(el.querySelector('[data-verb-id="switch.conversation-menu"]')).not.toBeNull();
    expect(el.querySelector('[data-verb-id="switch.replay"]')).toBeNull();

    const ev = rightClick(el.querySelector(".reel")!);
    expect(ev.defaultPrevented).toBe(true);
    expect(new Set(menuVerbIds(el))).toEqual(new Set(["switch.open-new-tab", "switch.replay"]));

    // Same handler, one call — and the row's own click verb must NOT also
    // fire underneath the menu press.
    const resumeEntry = el.querySelector<HTMLButtonElement>(
      '[role="menu"] [data-verb-id="switch.open-new-tab"]',
    )!;
    resumeEntry.click();
    flushSync();
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onReplay).not.toHaveBeenCalled();
    // The menu consumed itself on the act.
    expect(host!.querySelector('[role="menu"]')).toBeNull();
    rightClick(el.querySelector(".reel")!);
    el.querySelector<HTMLButtonElement>('[role="menu"] [data-verb-id="switch.replay"]')!.click();
    flushSync();
    expect(onReplay).toHaveBeenCalledTimes(1);
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  test("Esc dismisses without running anything; a pointer press outside dismisses too", () => {
    const onResume = vi.fn();
    const onReplay = vi.fn();
    const el = mountComp(Reel, reelProps(onResume, onReplay));

    // A real right-click focuses the row (mousedown moves focus), and the
    // Popover's opener-exemption keys off that focus — made explicit here
    // because jsdom's synthetic contextmenu moves no focus on its own.
    const row = el.querySelector<HTMLElement>(".reel")!;
    row.tabIndex = 0;
    row.focus();
    rightClick(row);
    const popover = el.querySelector<HTMLElement>(".popover")!;
    popover.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    flushSync();
    expect(el.querySelector('[role="menu"]')).toBeNull();
    expect(onResume).not.toHaveBeenCalled();

    row.focus();
    rightClick(row);
    expect(el.querySelector('[role="menu"]')).not.toBeNull();
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    flushSync();
    expect(el.querySelector('[role="menu"]')).toBeNull();
    expect(onResume).not.toHaveBeenCalled();
    expect(onReplay).not.toHaveBeenCalled();
  });
});

describe("the file tree — one row, one verb, same handler", () => {
  const fileEntry: TreeEntry = {
    name: "app.ts",
    path: "/proj/src/app.ts",
    relativePath: "src/app.ts",
    type: "file",
    size: 12,
    extension: "ts",
    lineCount: 1,
  };
  const dirEntry: TreeEntry = {
    name: "src",
    path: "/proj/src",
    relativePath: "src",
    type: "directory",
    size: 0,
    extension: null,
    lineCount: null,
  };

  function treeProps(rows: readonly TreeRow[], onopenfile = vi.fn(), ontogglefolder = vi.fn()) {
    return {
      rows,
      rootLoad: { kind: "read", entries: rows.map((r) => r.entry), truncated: false },
      selectedPath: null,
      draftPaths: new Set<string>(),
      focusRel: null,
      focusSeq: 0,
      draftKeyOf: (p: string) => p,
      onopenfile,
      ontogglefolder,
      onfocusrow: () => undefined,
      onreadagain: () => undefined,
    };
  }

  test("a file row's menu opens the file through the row's own handler", () => {
    const onopenfile = vi.fn();
    const rows: TreeRow[] = [
      { entry: dirEntry, depth: 0, open: false, load: { kind: "unread" } },
      { entry: fileEntry, depth: 0, open: false, load: { kind: "unread" } },
    ];
    const el = mountComp(FileTree, treeProps(rows, onopenfile));

    const fileRow = [...el.querySelectorAll(".row")].find((r) =>
      r.textContent!.includes("app.ts"),
    )!;
    rightClick(fileRow);
    const ids = menuVerbIds(el);
    // Exactly the row's one verb — the same id the row button carries.
    expect(ids).toEqual([fileRow.getAttribute("data-verb-id")]);
    el.querySelector<HTMLButtonElement>('[role="menu"] [data-verb-id]')!.click();
    flushSync();
    expect(onopenfile).toHaveBeenCalledTimes(1);
    expect(onopenfile.mock.calls[0]![0]).toEqual(fileEntry);
  });

  test("a folder row's menu toggles the folder — and says which direction in its words", () => {
    const ontogglefolder = vi.fn();
    const rows: TreeRow[] = [{ entry: dirEntry, depth: 0, open: false, load: { kind: "unread" } }];
    const el = mountComp(FileTree, treeProps(rows, vi.fn(), ontogglefolder));

    rightClick(el.querySelector(".row")!);
    const entry = el.querySelector<HTMLButtonElement>('[role="menu"] [data-verb-id]')!;
    expect(entry.textContent).toContain("open folder");
    entry.click();
    flushSync();
    expect(ontogglefolder).toHaveBeenCalledTimes(1);
  });
});

describe("the tab strip — a tab's two verbs, and the last-tab refusal honored", () => {
  const ISO = "2026-07-26T09:00:00.000Z";

  function seed(tabs: number): void {
    setProjects([
      { id: "p1", name: "reader", path: "/tmp/p1", createdAt: ISO, updatedAt: ISO },
      { id: "p2", name: "billing", path: "/tmp/p2", createdAt: ISO, updatedAt: ISO },
    ]);
    setChats([]);
    // Exactly `tabs` workspaces, whatever an earlier test left behind.
    workspaces.set([]);
    openWorkspace({ projectId: "p1", chatId: null });
    if (tabs > 1) openWorkspace({ projectId: "p2", chatId: null });
  }

  function stripProps() {
    return {
      revealed: true,
      onnewtab: () => undefined,
      onactivevisible: () => undefined,
    };
  }

  test("a tab's menu lists switch-to and close, wired to the strip's own verbs", () => {
    seed(2);
    const el = mountComp(WorkspaceStrip, stripProps());
    const tabs = el.querySelectorAll<HTMLButtonElement>("button.tab");
    expect(tabs.length).toBe(2);

    rightClick(tabs[0]!);
    expect(new Set(menuVerbIds(el))).toEqual(new Set(["workspace.activate", "workspace.close"]));

    // Close through the menu really closes: one tab remains.
    el.querySelector<HTMLButtonElement>('[role="menu"] [data-verb-id="workspace.close"]')!.click();
    flushSync();
    expect(el.querySelectorAll("button.tab").length).toBe(1);
  });

  test("the last tab's menu carries NO close verb — the refusal cannot be routed around", () => {
    seed(1);
    const el = mountComp(WorkspaceStrip, stripProps());
    rightClick(el.querySelector("button.tab")!);
    expect(menuVerbIds(el)).toEqual(["workspace.activate"]);
  });
});
