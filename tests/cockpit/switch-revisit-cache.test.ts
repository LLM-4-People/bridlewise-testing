// @vitest-environment jsdom
/**
 * "EACH TIME WE GO BACK TO THE PROJECT/CONVERSATION MENU, IT RELOADS THEM
 * ALL" — the second telling of a correction this project already accepted
 * once ("projects are reloading each time we revisit the page"), and the
 * suite that keeps the answer applied to BOTH lists.
 *
 * TWO SEPARATE DEFECTS HIDE IN THAT ONE SENTENCE, and they need different
 * fixes, so they are proved separately here:
 *
 *   REMOUNTING — the room tearing down and rebuilding on every open, losing
 *     scroll, filter and everything painted. Already fixed by keep-alive
 *     (RoomHost hides, it never unmounts); § "the room survives" proves it
 *     for the SWITCH specifically, because a generic host test would pass
 *     against a room that reset its own state on show.
 *
 *   REFETCHING — a network round trip on every visit. The project list was
 *     given a revisit cache; the CONVERSATION list was not, so every page
 *     load started from an empty store and every project cap painted
 *     "conversations not loaded yet" before fetching the lot. § "the
 *     conversation list survives a page load" is that gap closed.
 *
 * And the honesty rule that makes a cache defensible at all: last-known is
 * shown immediately, revalidated underneath, and when the revalidation FAILS
 * the list stays on screen and SAYS it is last-visit knowledge. Never blank,
 * never silently stale.
 *
 * MUTATIONS: removing the seed empties the second load; a cap that dropped
 * its stale line stops saying so; a feed that re-queued a loaded project
 * refetches on reopen.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/svelte";

import SwitchRoom from "../../src/cockpit/rooms/SwitchRoom.svelte";
import RoomHost from "../../src/cockpit/shell/RoomHost.svelte";
import {
  chatsSnapshot,
  chatsFromCache,
  replaceChatsForProject,
  resetChats,
  setChats,
} from "../../src/state/chats.ts";
import { resetProjects, setProjects } from "../../src/state/projects.ts";
import { clearMessages } from "../../src/state/chat-messages.ts";
import {
  chatsStates,
  ensureChats,
  resetSwitchFeed,
  setSwitchReaders,
} from "../../src/cockpit/rooms/switch-feed.ts";
import { resetCustodyFeed, setCustodyReaders } from "../../src/cockpit/rooms/custody-feed.ts";
import { resetWorkspaces } from "../../src/state/workspaces.ts";
import { resetTimeline } from "../../src/state/timeline-query.ts";
import { resetTimelineRefs } from "../../src/state/timeline-refs.ts";
import { resetSweep } from "../../src/cockpit/sweep/sweep-store.ts";
import type { RoomId, ShellApi, VisitedRoom } from "../../src/cockpit/shell/contract.ts";

const ISO = "2026-07-26T09:00:00.000Z";
const P1 = { id: "p1", name: "reader-refactor", path: "/tmp/p1", createdAt: ISO, updatedAt: ISO };
const CHATS = [
  { id: "c1", projectId: "p1", title: "fix the parser", createdAt: ISO, updatedAt: ISO, modelId: null, pinned: false },
  { id: "c2", projectId: "p1", title: "second pass", createdAt: ISO, updatedAt: ISO, modelId: null, pinned: false },
];

const CACHE_KEY = "bridlewise:chats:lastKnown";

class InertResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
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
  };
}

function quietFeeds(chatsReader: () => Promise<unknown>): void {
  setSwitchReaders({
    chats: chatsReader,
    pulse: async () => {
      throw new Error("no pulse");
    },
    spectrum: async () => {
      throw new Error("no spectrum");
    },
  });
  setCustodyReaders({ state: async () => ({ parcels: [] }) });
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", InertResizeObserver);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  localStorage.clear();
  resetProjects();
  resetChats();
  resetSwitchFeed();
  resetCustodyFeed();
  resetWorkspaces();
});

afterEach(() => {
  cleanup();
  resetSwitchFeed();
  resetCustodyFeed();
  resetTimeline();
  resetTimelineRefs();
  resetSweep();
  resetProjects();
  resetChats();
  resetWorkspaces();
  clearMessages();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("the conversation list survives a page load", () => {
  test("a real server list is written to the revisit cache", () => {
    setChats(CHATS);
    expect(JSON.parse(localStorage.getItem("bridlewise:chats:project:p1")!)).toHaveLength(2);
    // …and one project's answer counts too (the per-project refresh path).
    resetChats();
    replaceChatsForProject("p1", CHATS);
    expect(JSON.parse(localStorage.getItem("bridlewise:chats:project:p1")!)).toHaveLength(2);
  });

  test("the NEXT page load paints the conversations it already knows, before any fetch", async () => {
    setChats(CHATS);
    // A page load: fresh module instances reading the same storage.
    vi.resetModules();
    const fresh = await import("../../src/state/chats.ts");
    expect(fresh.chatsSnapshot(), "an empty second load is the defect").toHaveLength(2);
    expect(fresh.chatsFromCache.get()).toBe(true);
    // …and it is honestly labelled as last-visit knowledge until a server
    // list lands.
    fresh.setChats(CHATS);
    expect(fresh.chatsFromCache.get()).toBe(false);
  });

  test("MUTATION: with no cache written, the second load starts empty", async () => {
    // The pre-fix behaviour, reproduced exactly: nothing in storage.
    localStorage.removeItem(CACHE_KEY);
    vi.resetModules();
    const fresh = await import("../../src/state/chats.ts");
    expect(fresh.chatsSnapshot()).toHaveLength(0);
    expect(fresh.chatsFromCache.get()).toBe(false);
  });

  test("a corrupt cache degrades to none — never to half a list", async () => {
    localStorage.setItem(CACHE_KEY, "{not json");
    vi.resetModules();
    const fresh = await import("../../src/state/chats.ts");
    expect(fresh.chatsSnapshot()).toHaveLength(0);
    expect(fresh.chatsFromCache.get()).toBe(false);
  });

  test("sign-out clears it — a cached conversation list is not left for the next person", () => {
    setChats(CHATS);
    resetChats();
    expect(JSON.parse(localStorage.getItem(CACHE_KEY)!)).toEqual([]);
    expect(chatsSnapshot()).toHaveLength(0);
    expect(chatsFromCache.get()).toBe(false);
  });
});

describe("reopening does not refetch what is already loaded", () => {
  test("a project loaded once is never re-queued; a FAILED one is retried", async () => {
    let calls = 0;
    quietFeeds(async () => {
      calls += 1;
      return [];
    });
    setProjects([P1]);
    ensureChats(["p1"]);
    await vi.waitFor(() => expect(chatsStates.get("p1")).toBe("loaded"));
    expect(calls).toBe(1);

    // The second open of the room.
    ensureChats(["p1"]);
    ensureChats(["p1"]);
    expect(calls, "a reopen must not go back to the network for a loaded list").toBe(1);

    // MUTATION side: a project that FAILED is the one case a reopen retries —
    // the next visit is the honest retry gesture.
    resetSwitchFeed();
    let failing = 0;
    quietFeeds(async () => {
      failing += 1;
      throw new Error("offline");
    });
    ensureChats(["p1"]);
    await vi.waitFor(() => expect(chatsStates.get("p1")).toBe("failed"));
    ensureChats(["p1"]);
    await vi.waitFor(() => expect(failing).toBe(2));
  });
});

describe("a failed revalidation keeps the list and says it is last-visit knowledge", () => {
  test("the reels stay on screen, with the staleness stated in plain words", async () => {
    // What a page load looks like with a cache and an unreachable server.
    setProjects([P1]);
    setChats(CHATS);
    quietFeeds(async () => {
      throw new Error("offline");
    });
    const { findByText, getByText } = render(SwitchRoom, { shell: makeShell() });

    // The list we already had is on screen…
    expect(getByText("fix the parser")).toBeTruthy();
    // …and once the revalidation fails, the cap says so rather than either
    // blanking the list or passing it off as current.
    expect(await findByText("Not reachable now. Showing your last visit.")).toBeTruthy();
    expect(getByText("fix the parser"), "the known list must NOT be blanked").toBeTruthy();
  });

  test("a successful load says nothing — the label is for failure only", async () => {
    setProjects([P1]);
    setChats(CHATS);
    quietFeeds(async () => []);
    const { queryByText } = render(SwitchRoom, { shell: makeShell() });
    await vi.waitFor(() => expect(chatsStates.get("p1")).toBe("loaded"));
    expect(queryByText("Not reachable now. Showing your last visit.")).toBeNull();
  });
});

describe("the room survives being closed and reopened", () => {
  test("the Switch keeps its typed filter across a close and a reopen (no remount)", async () => {
    setProjects([P1]);
    setChats(CHATS);
    quietFeeds(async () => []);

    const visited: readonly VisitedRoom[] = [{ id: "switch", comp: SwitchRoom as never }];
    let roomId: RoomId | null = "switch";
    const view = render(RoomHost, {
      props: { shell: makeShell(), roomId, visited, onClose: () => undefined },
    });
    const rerender = view.rerender as unknown as (p: Record<string, unknown>) => Promise<void>;

    const filter = view.container.querySelector<HTMLInputElement>(".filter")!;
    await fireEvent.input(filter, { target: { value: "second" } });
    expect(filter.value).toBe("second");

    // Close, then reopen — the shell's own gesture.
    roomId = null;
    await rerender({ shell: makeShell(), roomId, visited, onClose: () => undefined });
    roomId = "switch";
    await rerender({ shell: makeShell(), roomId, visited, onClose: () => undefined });

    // The SAME input element, with the same text in it. A remounted room
    // would hand back a new element with an empty value — which is exactly
    // what "it reloads them all" looked like from the outside.
    const after = view.container.querySelector<HTMLInputElement>(".filter")!;
    expect(after).toBe(filter);
    expect(after.value).toBe("second");
  });
});


describe("scoped completion persistence", () => {
  test("each completion writes its own list and legacy migration/empty tombstones survive a fresh module", async () => {
    localStorage.setItem(CACHE_KEY, JSON.stringify(CHATS));
    const stringify = vi.spyOn(JSON, "stringify");
    const writes = vi.spyOn(Storage.prototype, "setItem");
    let populations: number[];
    let keys: string[];
    try {
      for (let i = 0; i < 500; i++) {
        replaceChatsForProject(`scope-${i}`, [{ ...CHATS[0]!, id: `chat-${i}`, projectId: `scope-${i}` }]);
      }
      replaceChatsForProject("p1", []);
      populations = stringify.mock.calls.filter(([value]) => Array.isArray(value)).map(([value]) => (value as unknown[]).length);
      keys = writes.mock.calls.map(([key]) => key);
    } finally { stringify.mockRestore(); writes.mockRestore(); }
    expect(populations).toHaveLength(501);
    expect(Math.max(...populations)).toBe(1);
    expect(keys.every(key => key.startsWith("bridlewise:chats:project:"))).toBe(true);
    vi.resetModules();
    const fresh = await import("../../src/state/chats.ts");
    expect(fresh.chatsSnapshot()).toHaveLength(500);
    expect(fresh.projectChatsFor("p1")).toEqual([]);
    expect(fresh.chatForId("chat-499")?.title).toBe(CHATS[0]!.title);
    expect(fresh.chatsFromCache.get()).toBe(true);
    fresh.resetChats();
    expect(Object.keys(localStorage).filter(key => key.startsWith("bridlewise:chats:project:"))).toEqual([]);
  });
});
