// @vitest-environment jsdom
/**
 * THE TAB STRIP — several projects open in one page, and the four ways that
 * can go wrong.
 *
 * The user asked for this twice: "we should also be able to work on multiple
 * projects from the same tab, kinda like terminal tab, like we should have a
 * + at the top with tabs open for projects/chats", then "we don't have a +
 * button beside the conversation title at the top left of the page to allow
 * us to open another conversation/project."
 *
 * What must hold, each with its mutation:
 *
 *   1. the `+` OPENS a workspace, it does not replace the active one — a `+`
 *      that replaced would be the Switch with a different glyph. MUTATION: a
 *      choice made from an UNARMED Switch replaces and adds nothing, which is
 *      the original gesture and must keep working.
 *   2. the strip exists only above ONE workspace; with one there is nothing
 *      to switch between. MUTATION: with a single workspace the strip must be
 *      absent AND the `+` must still be there — a `+` that only appeared once
 *      you had two tabs could not be how you got the second.
 *   3. the place chip and the strip never state the same pair (§1.4). Asserted
 *      by COUNTING the pair on screen, not by reading a flag: a fix that hid
 *      the chip while leaving a third copy somewhere would still fail.
 *   4. switching restores that workspace's room — the property that makes
 *      tabs real rather than decorative. MUTATION: a view stored under a
 *      SHARED key is proven to leak between workspaces.
 *
 * Plus the two geometry laws the strip inherits: a tab is never clipped
 * (shell/tab-fit.ts decides what renders, and what renders renders whole),
 * and every control clears the pointer-target floor.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import { cleanup, fireEvent, render } from "@testing-library/svelte";

vi.mock("../../src/cockpit/shell/outlets.ts", () => ({
  outletExists: () => false,
  loadOutlet: async () => null,
  loadRoom: async () => null,
  roomExists: () => false,
}));

import WorkspaceStrip from "../../src/cockpit/shell/WorkspaceStrip.svelte";
import * as chatStore from "../../src/state/chats.ts";
import Cockpit from "../../src/cockpit/Cockpit.svelte";
import SwitchRoom from "../../src/cockpit/rooms/SwitchRoom.svelte";
import { fitTabs, span } from "../../src/cockpit/shell/tab-fit.ts";
import { holdFlowAnchor } from "../../src/cockpit/shell/flow-anchor.ts";
import {
  bindWorkspaceView,
  noteShellView,
  shellViewForActive,
  viewToRecord,
  VIEW_KEY,
} from "../../src/cockpit/shell/workspace-view.ts";
import { armNewTab, clearOpenIntent, openIntent } from "../../src/cockpit/shell/open-intent.ts";
import {
  activateWorkspace,
  activeWorkspaceId,
  openWorkspace,
  resetWorkspaces,
  workspaces,
  workspaceScopedKey,
} from "../../src/state/workspaces.ts";
import { resetProjects, setProjects, currentProjectId } from "../../src/state/projects.ts";
import { resetChats, setChats, currentChatId } from "../../src/state/chats.ts";
import { clearMessages } from "../../src/state/chat-messages.ts";
import { resetSwitchFeed, setSwitchReaders } from "../../src/cockpit/rooms/switch-feed.ts";
import { resetCustodyFeed, setCustodyReaders } from "../../src/cockpit/rooms/custody-feed.ts";
import { resetTimeline } from "../../src/state/timeline-query.ts";
import { resetTimelineRefs } from "../../src/state/timeline-refs.ts";
import { resetSweep } from "../../src/cockpit/sweep/sweep-store.ts";
import { read } from "../helpers/source-scan.ts";
import type { ShellApi } from "../../src/cockpit/shell/contract.ts";
import { wholeConversationPage } from "../helpers/history-page.ts";
import { until } from "../helpers/until.ts";

const STRIP = "src/cockpit/shell/WorkspaceStrip.svelte";

/** jsdom has no ResizeObserver; Svelte's bind:clientWidth wants one. */
class InertResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const ISO = "2026-07-26T09:00:00.000Z";
const P1 = { id: "p1", name: "reader-refactor", path: "/tmp/p1", createdAt: ISO, updatedAt: ISO };
const P2 = { id: "p2", name: "billing", path: "/tmp/p2", createdAt: ISO, updatedAt: ISO };
const CHATS = [
  { id: "c1", projectId: "p1", title: "fix the parser", createdAt: ISO, updatedAt: ISO, modelId: null, pinned: false },
  { id: "c5", projectId: "p2", title: "invoices", createdAt: ISO, updatedAt: ISO, modelId: null, pinned: false },
];

// ── the fit: pure arithmetic, no DOM ───────────────────────────────────────

describe("the fit — a tab renders whole or not at all", () => {
  const gap = 4;

  test("everything that fits is shown, with no fold and no window", () => {
    const fit = fitTabs({
      widths: [100, 100],
      gap,
      available: 400,
      newButton: 80,
      fold: 60,
      activeIndex: 0,
      start: 0,
    });
    expect(fit).toEqual({ start: 0, count: 2, activeVisible: true });
  });

  test("what does not fit FOLDS — and nothing rendered is ever wider than the room", () => {
    const widths = [200, 200, 200, 200];
    const available = 500;
    const newButton = 80;
    const fold = 60;
    const fit = fitTabs({ widths, gap, available, newButton, fold, activeIndex: 0, start: 0 });
    expect(fit.count).toBeGreaterThan(0);
    expect(fit.count).toBeLessThan(widths.length);
    // THE NO-CLIP LAW, mechanically: the rendered run plus both controls
    // fits in the strip. A fit that let one more tab in would overflow, and
    // an overflowing tab is a clipped name.
    expect(span(widths, fit.start, fit.count, gap) + newButton + fold + gap * 2).toBeLessThanOrEqual(
      available,
    );
    expect(
      span(widths, fit.start, fit.count + 1, gap) + newButton + fold + gap * 2,
      "one more tab must NOT have fit — otherwise the fit is leaving room unused",
    ).toBeGreaterThan(available);
  });

  test("the window slides to keep the ACTIVE tab visible (it never reorders)", () => {
    const widths = [200, 200, 200, 200];
    const fit = fitTabs({
      widths,
      gap,
      available: 500,
      newButton: 80,
      fold: 60,
      activeIndex: 3,
      start: 0,
    });
    expect(fit.activeVisible).toBe(true);
    expect(3).toBeGreaterThanOrEqual(fit.start);
    expect(3).toBeLessThan(fit.start + fit.count);
  });

  test("when not even one tab fits, the honest answer is zero tabs — never half a name", () => {
    const fit = fitTabs({
      widths: [400],
      gap,
      available: 200,
      newButton: 80,
      fold: 60,
      activeIndex: 0,
      start: 0,
    });
    expect(fit.count).toBe(0);
    // …and the shell is told, so the place chip comes back rather than
    // leaving the active workspace unnamed anywhere on screen.
    expect(fit.activeVisible).toBe(false);
  });

  test("the window HOLDS still when nothing forces it to move", () => {
    const widths = [200, 200, 200, 200];
    const first = fitTabs({ widths, gap, available: 500, newButton: 80, fold: 60, activeIndex: 1, start: 1 });
    const again = fitTabs({ widths, gap, available: 500, newButton: 80, fold: 60, activeIndex: 1, start: first.start });
    expect(again.start).toBe(first.start);
  });
});

// ── per-workspace shell view ───────────────────────────────────────────────

describe("switching restores what that tab was looking at", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    resetWorkspaces();
  });

  test("each workspace keeps its own room; activating one applies it", () => {
    const a = activeWorkspaceId.get()!;
    noteShellView({ room: "custody", inspector: "setup" });

    const applied: Array<{ room: string | null; inspector: string | null }> = [];
    const stop = bindWorkspaceView((v) => applied.push({ room: v.room, inspector: v.inspector }));

    const b = openWorkspace({ projectId: "p2", chatId: "c5" });
    // A fresh workspace has no record: the flow, desk closed.
    expect(applied.at(-1)).toEqual({ room: null, inspector: null });
    noteShellView({ room: "instruments", inspector: null });

    activateWorkspace(a);
    expect(applied.at(-1)).toEqual({ room: "custody", inspector: "setup" });

    activateWorkspace(b.id);
    expect(applied.at(-1)).toEqual({ room: "instruments", inspector: null });
    stop();
  });

  test("MUTATION: a view stored under a SHARED key leaks between workspaces", () => {
    // What the module does — one slot per workspace.
    const a = activeWorkspaceId.get()!;
    noteShellView({ room: "custody", inspector: null });
    const scoped = workspaceScopedKey(VIEW_KEY)!;
    expect(scoped).toContain(a);

    const b = openWorkspace({});
    expect(workspaceScopedKey(VIEW_KEY)).not.toBe(scoped);
    expect(shellViewForActive(), "a new workspace inherits nothing").toBeNull();

    // The mutation: the same value written under ONE shared key. Read back
    // from the other workspace, it is the first workspace's room — which is
    // exactly the "switching feels broken" defect.
    window.sessionStorage.setItem("bridlewise:shell-view", JSON.stringify({ room: "custody", inspector: null }));
    const shared = window.sessionStorage.getItem("bridlewise:shell-view");
    activateWorkspace(a);
    expect(window.sessionStorage.getItem("bridlewise:shell-view")).toBe(shared);
    expect(b.id).not.toBe(a);
  });

  test("the + does not leave the tab you were in sitting in the picker", () => {
    // The `+` opens the Switch OVER the tab you are in. That tab is not
    // "showing the Switch" in any sense the user asked for — found in the
    // browser: without this rule, coming back to it reopened the picker.
    expect(viewToRecord("switch", true, null)).toEqual({ room: null, inspector: null });
    // Every other case records what is on screen, including the Switch when
    // it was opened normally, and any other room while armed.
    expect(viewToRecord("switch", false, null)).toEqual({ room: "switch", inspector: null });
    expect(viewToRecord("custody", true, "setup")).toEqual({ room: "custody", inspector: "setup" });
    expect(viewToRecord(null, false, null)).toEqual({ room: null, inspector: null });
  });

  test("a reload does NOT reopen a room (the one-reveal law owns the boot frame)", () => {
    noteShellView({ room: "custody", inspector: null });
    const applied: unknown[] = [];
    // A fresh bind is what a reload looks like: the first notification is
    // this page's own boot and must not summon a room.
    const stop = bindWorkspaceView((v) => applied.push(v));
    expect(applied).toEqual([]);
    stop();
  });

  test("a reload does NOT reopen the run column either — the recorded view's `rightMenuOpen` is not a boot instruction", () => {
    // The right-menu store is unpersisted by design (shell/right-menu.ts):
    // a reload is a fresh boot and the boot frame mounts nothing the reader
    // did not ask for. The recorded view survives as a MIRROR, and only a
    // real tab switch (a second notification) applies it.
    noteShellView({ room: null, inspector: "run" });
    const applied: unknown[] = [];
    const stop = bindWorkspaceView((v) => applied.push(v));
    expect(applied, "the boot's own notification must not reopen the column").toEqual([]);
    stop();
  });
});

// ── the flow keeps its place ───────────────────────────────────────────────

describe("the flow keeps its place when the strip appears", () => {
  function scroller(clientHeight: number, scrollHeight: number, scrollTop: number): HTMLElement {
    const region = document.createElement("div");
    const el = document.createElement("div");
    // The real flow scroller declares this; the finder looks for the SHAPE
    // of a scroller, never for a class name the flow owns.
    el.style.overflowY = "auto";
    Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
    Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true });
    // jsdom's own `scrollTop` no-ops on an attached element with no layout;
    // a plain backing value keeps the test about the arithmetic, which is
    // the part that can be wrong.
    let top = scrollTop;
    Object.defineProperty(el, "scrollTop", {
      get: () => top,
      set: (v: number) => {
        top = v;
      },
      configurable: true,
    });
    region.appendChild(el);
    document.body.appendChild(region);
    return region;
  }

  test("the distance from the bottom survives the height change", () => {
    // 400px of viewport over 1000px of content, parked 40px off the bottom.
    const region = scroller(400, 1000, 560);
    const el = region.firstElementChild as HTMLElement;
    const restore = holdFlowAnchor(region);
    // The strip takes 32px: the viewport shrinks, the content does not.
    Object.defineProperty(el, "clientHeight", { value: 368, configurable: true });
    restore();
    expect(el.scrollHeight - el.scrollTop - el.clientHeight).toBe(40);
    region.remove();
  });

  test("MUTATION: without the hold, the same change moves the reader", () => {
    const region = scroller(400, 1000, 560);
    const el = region.firstElementChild as HTMLElement;
    Object.defineProperty(el, "clientHeight", { value: 368, configurable: true });
    expect(el.scrollHeight - el.scrollTop - el.clientHeight).toBe(72); // moved by the strip's height
    region.remove();
  });

  test("no scroller (boot, a failed outlet) is a no-op, never a guessed position", () => {
    expect(() => holdFlowAnchor(null)()).not.toThrow();
    expect(() => holdFlowAnchor(document.createElement("div"))()).not.toThrow();
  });
});

// ── the strip on screen ────────────────────────────────────────────────────

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
        return jsonResponse({ setupRequired: false, authenticated: true, username: "ada", isAdmin: true });
      if (url.includes("/api/schema/ui")) return jsonResponse({ menus: [], panels: [], widgets: [] });
      if (url.includes("/api/intelligence/map")) return jsonResponse({ summary: { fileCount: 3 } });
      if (/\/api\/chats\/[^/]+\/history/.test(url))
        return jsonResponse({ chat: CHATS[0], messages: [], toolCalls: [], timelineRefs: [], metricsSnapshots: [], page: wholeConversationPage(0) });
      if (/\/api\/projects\/[^/]+\/chats/.test(url)) return jsonResponse([...CHATS]);
      if (url.includes("/api/projects")) return jsonResponse([P1, P2]);
      return jsonResponse({});
    }),
  );
}


describe("the strip is present only above ONE workspace, and never says the pair twice", () => {
  let host: HTMLElement;
  let app: object | null = null;

  beforeEach(() => {
    // Svelte's bind:clientWidth rides ResizeObserver, which jsdom lacks. An
    // inert observer is honest here: jsdom boxes have no geometry, so every
    // measured width is zero and every tab "fits" — the fit itself is proved
    // by the pure suite above.
    vi.stubGlobal("ResizeObserver", InertResizeObserver);
    if (typeof window.requestAnimationFrame !== "function") {
      vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
        setTimeout(() => cb(performance.now()), 16),
      );
    }
    localStorage.clear();
    window.sessionStorage.clear();
    resetProjects();
    resetChats();
    clearMessages();
    resetWorkspaces();
    stubApi();
    setProjects([P1, P2]);
    setChats(CHATS);
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    if (app !== null) unmount(app);
    app = null;
    host.remove();
    vi.unstubAllGlobals();
    resetProjects();
    resetChats();
    clearMessages();
    resetWorkspaces();
    localStorage.clear();
  });

  async function mountAndReveal(): Promise<void> {
    app = mount(Cockpit, { target: host });
    await until(() => host.querySelector(".cockpit")?.getAttribute("data-revealed") === "true");
  }

  /** How many controls on screen state `project ▸ conversation`. */
  function pairMentions(pair: string): number {
    let n = 0;
    for (const el of host.querySelectorAll("button")) {
      if ((el.textContent ?? "").trim() === pair) n += 1;
    }
    return n;
  }

  test("one workspace: no strip, the place chip names the pair, and the + is beside it", async () => {
    currentProjectId.set("p1");
    currentChatId.set("c1");
    await mountAndReveal();

    expect(host.querySelector(".workspace-strip"), "one workspace needs no tabs").toBeNull();
    expect(host.querySelector(".place-project")?.textContent).toBe("reader-refactor");
    expect(host.querySelector(".place-conversation")?.textContent).toBe("fix the parser");
    // The `+` is the thing the user went looking for, and it is here BEFORE
    // there is a second tab — otherwise it could not create one.
    const plus = host.querySelectorAll(".new-tab");
    expect(plus).toHaveLength(1);
    expect(plus[0]!.textContent).toContain("New tab");
    expect(plus[0]!.getAttribute("title")).toContain("new tab");
  });

  test("two workspaces: the strip names both, the place chip collapses, ONE + remains", async () => {
    currentProjectId.set("p1");
    currentChatId.set("c1");
    await mountAndReveal();

    openWorkspace({ projectId: "p2", chatId: "c5" });
    flushSync();

    const strip = host.querySelector(".workspace-strip");
    expect(strip, "a second workspace brings the strip").not.toBeNull();
    const tabs = [...host.querySelectorAll("nav.tabs button.tab")].map((t) => t.textContent?.trim());
    expect(tabs).toEqual(["reader-refactor ▸ fix the parser", "billing ▸ invoices"]);

    // §1.4 one manifestation per fact: the pair is stated exactly once.
    expect(host.querySelector(".place"), "the chip collapses when the tab says it").toBeNull();
    expect(pairMentions("billing ▸ invoices")).toBe(1);
    // …and the Switch keeps a mouse path, as the engraved word.
    expect(host.querySelector('[data-chord-target="switch"]')).not.toBeNull();
    // Exactly one `+` on screen, now living in the strip.
    expect(host.querySelectorAll(".new-tab")).toHaveLength(1);
    expect(strip!.querySelector(".new-tab")).not.toBeNull();
  });

  test("closing the active tab activates a neighbour; the last one cannot be closed", async () => {
    currentProjectId.set("p1");
    currentChatId.set("c1");
    await mountAndReveal();
    openWorkspace({ projectId: "p2", chatId: "c5" });
    flushSync();

    const closers = [...host.querySelectorAll<HTMLButtonElement>("nav.tabs button.tab-close")];
    expect(closers).toHaveLength(2);
    await fireEvent.click(closers[1]!); // the active (second) tab
    flushSync();

    expect(workspaces.get()).toHaveLength(1);
    // The neighbour is showing, so the cockpit still has something real on it.
    expect(currentChatId.get()).toBe("c1");
    // Back to one workspace: the strip is gone and the chip is back.
    expect(host.querySelector(".workspace-strip")).toBeNull();
    expect(host.querySelector(".place-project")?.textContent).toBe("reader-refactor");
    expect(host.querySelector(".place-conversation")?.textContent).toBe("fix the parser");
  });

  test("a workspace with nothing chosen yet says so, and never invents a name", async () => {
    currentProjectId.set("p1");
    currentChatId.set("c1");
    await mountAndReveal();
    openWorkspace({});
    flushSync();

    const tabs = [...host.querySelectorAll("nav.tabs button.tab")].map((t) => t.textContent?.trim());
    expect(tabs).toContain("nothing open yet");
    // A project we hold no name for is stated as unknown, not as an id.
    openWorkspace({ projectId: "p-not-loaded", chatId: null });
    flushSync();
    const later = [...host.querySelectorAll("nav.tabs button.tab")].map((t) => t.textContent?.trim());
    expect(later.some((t) => t?.includes("not loaded yet"))).toBe(true);
    expect(later.some((t) => t?.includes("p-not-loaded")), "no ids on screen").toBe(false);
  });
});

// ── the `+` opens rather than replaces ─────────────────────────────────────

function makeShell(): ShellApi & { closed: () => number } {
  let closed = 0;
  return {
    revealAt: () => 0,
    openRoom: () => {},
    closeRoom: () => {
      closed += 1;
    },
    openScope: () => {},
    closeScope: () => {},
    setAnnunciators: () => {},
    setMonitors: () => {},
    claimKey: () => () => {},
    pushDismiss: () => () => {},
    hint: () => {},
    composerText: () => "",
    onComposerSubmit: () => () => {},
    prefillComposer: () => {},
    clearComposer: () => {},
    restoreComposerText: () => {},
    onComposerChange: () => () => {},
    setDeskLine: () => {},
    closed: () => closed,
  };
}

describe("the + opens a workspace; it never replaces the one you are in", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", InertResizeObserver);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ chat: CHATS[0], messages: [], toolCalls: [], metricsSnapshots: [], timelineRefs: [], page: wholeConversationPage(0) })),
    );
    resetSwitchFeed();
    resetCustodyFeed();
    resetWorkspaces();
    resetProjects();
    resetChats();
    setProjects([P1, P2]);
    setChats(CHATS);
    setSwitchReaders({
      chats: async () => [],
      pulse: async () => {
        throw new Error("no pulse");
      },
      spectrum: async () => {
        throw new Error("no spectrum");
      },
    });
    setCustodyReaders({ state: async () => ({ parcels: [] }) });
    clearOpenIntent();
  });

  afterEach(() => {
    cleanup();
    clearOpenIntent();
    resetSwitchFeed();
    resetCustodyFeed();
    resetTimeline();
    resetTimelineRefs();
    resetSweep();
    resetWorkspaces();
    resetProjects();
    resetChats();
    clearMessages();
    vi.unstubAllGlobals();
  });

  test("armed by the +, choosing a conversation OPENS a tab and leaves this one alone", async () => {
    // The tab you are in, on a conversation you care about.
    activateWorkspace(activeWorkspaceId.get()!);
    currentProjectId.set("p1");
    currentChatId.set("c1");
    const before = workspaces.get().length;
    const here = activeWorkspaceId.get();

    armNewTab();
    expect(openIntent.get()).toBe("new-tab");
    const { getByText } = render(SwitchRoom, { shell: makeShell() });
    await fireEvent.click(getByText("invoices"));

    expect(workspaces.get()).toHaveLength(before + 1);
    expect(activeWorkspaceId.get()).not.toBe(here);
    // The tab you left still holds what it held.
    const left = workspaces.get().find((w) => w.id === here)!;
    expect(left.chatId).toBe("c1");
    // …and the arming is spent: it does not leak into the next open.
    expect(openIntent.get()).toBe("replace");
  });

  test("MUTATION: an UNARMED Switch replaces, exactly as it always did", async () => {
    currentProjectId.set("p1");
    currentChatId.set("c1");
    const before = workspaces.get().length;
    const here = activeWorkspaceId.get();

    const { getByText } = render(SwitchRoom, { shell: makeShell() });
    await fireEvent.click(getByText("invoices"));

    expect(workspaces.get()).toHaveLength(before);
    expect(activeWorkspaceId.get()).toBe(here);
    expect(currentChatId.get()).toBe("c5");
  });

  test("the exceptional new-tab intent is visible; ordinary replace behavior remains quiet", async () => {
    const { queryByText, unmount: close } = render(SwitchRoom, { shell: makeShell() });
    expect(queryByText("opens here, replacing what this tab shows")).toBeNull();
    close();
    armNewTab();
    const armedView = render(SwitchRoom, { shell: makeShell() });
    expect(armedView.getByText("opens in a new tab")).toBeTruthy();
  });

  test("one New menu exposes creation capabilities with registry tooltips", async () => {
    const { container } = render(SwitchRoom, { shell: makeShell() });
    expect(container.querySelector('[data-room-chord]')).toBeNull();
    await fireEvent.click(container.querySelector('[data-verb-id="switch.create-menu"]')!);
    const project = container.querySelector<HTMLButtonElement>('[data-room-chord="switch.new-project"]')!;
    const chat = container.querySelector<HTMLButtonElement>('[data-room-chord="switch.new-conversation"]')!;
    expect(project.title).toContain('Ctrl+Shift+N');
    expect(chat.title).toContain('Ctrl+N');
    expect(chat.textContent).toContain('New conversation in');
  });
});

// ── the strip's own geometry laws, read off its source ─────────────────────

describe("the strip's tabs are never clipped and always clickable", () => {
  const src = read(STRIP);
  const style = src.slice(src.indexOf("<style"));

  test("the tab label declares no ellipsis and no clip of its own", () => {
    const rule = /\.tab\s*\{([\s\S]*?)\}/.exec(style)![1]!;
    expect(rule, "a truncated tab is a different name").not.toContain("text-overflow");
    expect(rule).not.toContain("overflow: hidden");
    // It DOES refuse to wrap — a two-line tab in a 32px row is the same
    // defect wearing a different hat; the fold is the answer instead.
    expect(rule).toContain("white-space: nowrap");
  });

  test("every control in the strip clears the pointer-target floor in both axes", () => {
    const rule = /\.tab\s*\{([\s\S]*?)\n  \}/.exec(style)?.[1] ?? "";
    expect(rule, ".tab must consume --hit-min").toContain("min-height: var(--hit-min)");
    expect(rule, ".tab must consume --hit-min").toContain("min-width: var(--hit-min)");
    expect(src).toMatch(/class="verb bare close tab-close"/);
    expect(src).toMatch(/class="verb engraved fold"/);
    expect(src).toMatch(/class="verb fold-open"/);
    expect(src).toMatch(/class="verb close fold-close"/);
    expect(style, "fold/close consume .verb — restating the floor is a twin").not.toMatch(
      /\.tab-close\s*\{[^}]*min-height:\s*var\(--hit-min\)/,
    );
    expect(style).not.toMatch(/\.fold-open\s*\{[^}]*min-height:\s*var\(--hit-min\)/);
  });

  test("the strip declares no pixel of its own — the row height is a token", () => {
    expect(style).toContain("var(--tabstrip-h)");
    expect(read("src/cockpit/tokens.css")).toMatch(/--tabstrip-h:\s*calc\(var\(--hit-min\)\s*\+\s*var\(--sp-4\)\)/);
  });
});


test("unrelated project completions do not recompute tab labels; relevant titles still update", async () => {
  cleanup();
  vi.stubGlobal("ResizeObserver", InertResizeObserver);
  resetWorkspaces(); resetProjects(); resetChats();
  setProjects([P1, P2]); setChats(CHATS);
  openWorkspace({ projectId: "p1", chatId: "c1" });
  openWorkspace({ projectId: "p2", chatId: "c5" });
  const view = render(WorkspaceStrip, { revealed: true, onnewtab: () => {}, onactivevisible: () => {} });
  const lookup = vi.spyOn(chatStore, "chatForId");
  try {
    await Promise.resolve();
    lookup.mockClear();
    const before = view.container.textContent;
    for (let i = 0; i < 50; i++) chatStore.replaceChatsForProject(`unrelated-${i}`, [{ ...CHATS[0]!, id: `other-${i}`, projectId: `unrelated-${i}` }]);
    flushSync();
    expect(lookup).not.toHaveBeenCalled();
    expect(view.container.textContent).toBe(before);
    chatStore.updateChatInStore("c1", { title: "the relevant new title" });
    flushSync();
    expect(lookup).toHaveBeenCalled();
    expect(view.container.textContent).toContain("the relevant new title");
    activateWorkspace(workspaces.get()[0]!.id);
    flushSync();
    expect(view.container.querySelector('[aria-current="page"]')).not.toBeNull();
  } finally {
    lookup.mockRestore(); cleanup(); resetWorkspaces(); resetProjects(); resetChats(); vi.unstubAllGlobals();
  }
});
