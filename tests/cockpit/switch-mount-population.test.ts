// @vitest-environment jsdom
/** Runtime mount/reachability owner. A pixel window bounds live DOM while
 * the full matching population remains reachable by scrolling and focus. */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";

import SwitchRoom from "../../src/cockpit/rooms/SwitchRoom.svelte";
import {
  buildRiver,
  filterRiver,
  stableCapOrder,
  type ProjectCap,
} from "../../src/cockpit/rooms/switch-data.ts";
import { resetSwitchFeed, setSwitchReaders } from "../../src/cockpit/rooms/switch-feed.ts";
import { resetCustodyFeed } from "../../src/cockpit/rooms/custody-feed.ts";
import { resetProjects, setProjects } from "../../src/state/projects.ts";
import { resetChats, setChats } from "../../src/state/chats.ts";
import { resetSweep } from "../../src/cockpit/sweep/sweep-store.ts";
import type { ShellApi } from "../../src/cockpit/shell/contract.ts";
import type { ProjectSummary } from "../../src/state/projects.ts";
import type { ChatSummary } from "../../src/state/chats.ts";

const T = Date.parse("2026-07-26T12:00:00Z");
const iso = (msAgo: number): string => new Date(T - msAgo).toISOString();

/**
 * The token every matching title shares. It is supplied as data, not spelled
 * into an assertion: a plant that names itself can be defeated by filtering
 * that exact literal.
 */
const SHARED = "pass";

/** N projects x M conversations, every title distinct, all matching SHARED. */
function fixture(projects: number, chatsPer: number): {
  projects: ProjectSummary[];
  chats: ChatSummary[];
} {
  const ps: ProjectSummary[] = Array.from({ length: projects }, (_, i) => ({
    id: `p${i}`,
    name: `project ${i}`,
    path: `/tmp/p${i}`,
    createdAt: iso(i * 10_000 + 1000),
    updatedAt: iso(i * 10_000),
  }));
  const cs: ChatSummary[] = [];
  for (const p of ps) {
    for (let j = 0; j < chatsPer; j += 1) {
      cs.push({
        id: `${p.id}-c${j}`,
        projectId: p.id,
        // Varied words, one shared token — a repeated character would
        // flatter every length-sensitive measure in sight.
        title: `${["parser", "cleanup", "render", "index", "stream"][j % 5]} ${j} ${SHARED}`,
        createdAt: iso(j * 60_000 + 1000),
        updatedAt: iso(j * 60_000),
        modelId: null,
        pinned: false,
      });
    }
  }
  return { projects: ps, chats: cs };
}

function makeShell(): ShellApi {
  return {
    revealAt: () => 0,
    openRoom: () => {},
    closeRoom: () => {},
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
  } as unknown as ShellApi;
}

class InertResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** THE MEASUREMENT: reels actually present in the document. */
function mountedReels(): number {
  return document.querySelectorAll("[data-reel-index]").length;
}

/** The river the room derives, so the input can be compared to the output. */
function river(projects: readonly ProjectSummary[], chats: readonly ChatSummary[]): readonly ProjectCap[] {
  const byProject: Record<string, ChatSummary[]> = {};
  for (const c of chats) (byProject[c.projectId] ??= []).push(c);
  const order = stableCapOrder([], projects, byProject);
  return buildRiver(projects, byProject, order, new Set(), () => "loaded");
}

function seed(projects: readonly ProjectSummary[], chats: readonly ChatSummary[]): void {
  setProjects([...projects]);
  setChats([...chats]);
  setSwitchReaders({
    chats: async () => [],
    pulse: async () => ({ runs: { known: 0, withEvents: 0 } }),
    spectrum: async () => ({
      header: {
        categories: ["x"], errorRow: 1, errorRowIsOverlay: true, rows: 2, bins: 0,
        binMs: 0, t0: null, t1: null, events: 0, unbinnable: 0, attributedOnly: true, clamped: false,
      },
      packed: "",
    }),
  });
}

beforeEach(() => {
  cleanup();
  vi.stubGlobal("ResizeObserver", InertResizeObserver);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })));
  resetSwitchFeed();
  resetCustodyFeed();
  resetProjects();
  resetChats();
  resetSweep();
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  resetSwitchFeed();
  resetCustodyFeed();
  resetProjects();
  resetChats();
  resetSweep();
});

// The fixture's shape is declared once and every bound is re-derived from it.
const PROJECTS = 12;
const CHATS_PER = 9;

describe("the Switch mounts a bounded window without dropping matches", () => {
  test("unfiltered liveness keeps the full river population behind the mounted window", () => {
    const { projects, chats } = fixture(PROJECTS, CHATS_PER);
    seed(projects, chats);
    render(SwitchRoom, { shell: makeShell() });
    const expected = river(projects, chats).reduce((n, cap) => n + cap.visible.length, 0);
    expect(expected).toBe(36);
    expect(mountedReels()).toBeGreaterThan(0);
    expect(mountedReels()).toBeLessThan(expected);
    expect(mountedReels()).toBeLessThanOrEqual(32);
    expect(document.querySelector(".counts")?.textContent).toContain("108 conversations");
  });

  test.each([CHATS_PER, CHATS_PER * 2])("filtering %i chats per cap bounds DOM and every match is reachable", async chatsPer => {
    const { projects, chats } = fixture(PROJECTS, chatsPer);
    seed(projects, chats);
    const view = render(SwitchRoom, { shell: makeShell() });
    await fireEvent.input(view.getByLabelText("filter projects and conversations"), { target: { value: SHARED } });
    const expected = filterRiver(river(projects, chats), SHARED).reduce((n, cap) => n + cap.visible.length, 0);
    expect(expected).toBe(chats.length);
    const scroll = view.getByLabelText("recency river") as HTMLElement;
    const canvas = scroll.querySelector<HTMLElement>(".river-canvas")!;
    const seen = new Set<number>();
    for (let top = 0; top < Number.parseFloat(canvas.style.height); top += 450) {
      await fireEvent.scroll(scroll, { target: { scrollTop: top } });
      const mounted = scroll.querySelectorAll<HTMLElement>("[data-reel-index]");
      expect(mounted.length).toBeGreaterThan(0);
      expect(mounted.length).toBeLessThanOrEqual(32);
      for (const node of mounted) seen.add(Number(node.dataset.reelIndex));
    }
    expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: expected }, (_, index) => index));
  });

  test("one large matching cap is windowed internally and its last result is keyboard reachable", async () => {
    const { projects, chats } = fixture(1, 100);
    seed(projects, chats);
    const view = render(SwitchRoom, { shell: makeShell() });
    const input = view.getByLabelText("filter projects and conversations");
    await fireEvent.input(input, { target: { value: SHARED } });
    expect(mountedReels()).toBeGreaterThan(0);
    expect(mountedReels()).toBeLessThanOrEqual(32);
    await fireEvent.keyDown(input, { key: "ArrowDown" });
    // ArrowDown walks the one project column (ArrowRight moves between
    // columns and stays put at the edge — switch-river.test.ts owns that).
    for (let index = 1; index < 100; index++) await fireEvent.keyDown(window, { key: "ArrowDown" });
    const last = document.querySelector<HTMLElement>('[data-reel-index="99"]');
    expect(last).not.toBeNull();
    expect(document.activeElement).toBe(last);
    expect(mountedReels()).toBeLessThanOrEqual(32);
  });
});
