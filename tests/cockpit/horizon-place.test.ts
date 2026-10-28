// @vitest-environment jsdom
/**
 * The HORIZON place (§2.4 `project ▸ conversation`) is LIVE state, never a
 * boot snapshot.
 *
 * The live-seam defect this pins: sending a message with no conversation
 * open auto-created a chat and the run streamed — but the place still read
 * "… ▸ no conversation open" after the turn completed. The place must
 * react to `currentChatId` / chat metadata (the stores are the source; the
 * shell renders it).
 *
 * Also pinned: the §10 boot restore — the persisted selection
 * (currentProjectId / currentChatId) is validated against the server's
 * real lists before the reveal, so the last conversation restores at its
 * kept position; a kept id that no longer exists clears to an honest
 * "no conversation open"; with nothing kept the honest absence renders but
 * UPDATES the moment a conversation exists.
 *
 * Mutation checks by construction: a place bound to a constant (or to the
 * boot-time snapshot) fails the mid-session update test; a restore that
 * does not validate fails the stale-id test.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

vi.mock("../../src/cockpit/shell/outlets.ts", () => ({
  outletExists: () => false,
  loadOutlet: async () => null,
  loadRoom: async () => null,
  roomExists: () => false,
}));

import Cockpit from "../../src/cockpit/Cockpit.svelte";
import {
  currentProjectId,
  resetProjects,
} from "../../src/state/projects.ts";
import {
  addChat,
  currentChatId,
  resetChats,
  selectChat,
  type ChatSummary,
} from "../../src/state/chats.ts";
import { clearMessages } from "../../src/state/chat-messages.ts";
import { wholeConversationPage } from "../helpers/history-page.ts";
import { until } from "../helpers/until.ts";

type Json = Record<string, unknown> | unknown[];

function jsonResponse(body: Json): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

const PROJECT = {
  id: "p1",
  name: "web-interface",
  path: "/tmp/web-interface",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-25T00:00:00.000Z",
};

function chatSummary(id: string, title: string): ChatSummary {
  return {
    id,
    projectId: "p1",
    title,
    createdAt: "2026-07-25T09:00:00.000Z",
    updatedAt: "2026-07-25T09:00:00.000Z",
    modelId: null,
    pinned: false,
  };
}

function emptyHistory(chat: ChatSummary): Json {
  return {
    chat,
    messages: [],
    toolCalls: [],
    timelineRefs: [],
    page: wholeConversationPage(0),
    metricsSnapshots: [],
  };
}

/** Stub the API the boot path hits. `chats` is what the server holds for
 * p1; history answers for any of them. Order matters: the chats/history
 * URLs contain "/api/projects" and "/api/chats". */
function stubApi(chats: readonly ChatSummary[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes("/api/health")) return jsonResponse({ status: "ok" });
      if (url.includes("/api/auth/status"))
        return jsonResponse({ setupRequired: false, authenticated: true, username: "ada", isAdmin: true });
      if (url.includes("/api/schema/ui")) return jsonResponse({ menus: [], panels: [], widgets: [] });
      if (url.includes("/api/intelligence/map")) return jsonResponse({ summary: { fileCount: 3 } });
      if (/\/api\/chats\/[^/]+\/history/.test(url)) {
        const id = /\/api\/chats\/([^/]+)\/history/.exec(url)![1]!;
        const chat = chats.find((c) => c.id === id);
        // A 404, NOT a thrown error. `fetch` rejects only on a NETWORK
        // failure, so throwing here modelled "the socket died" when what is
        // being simulated is "the server does not have this chat" — and the
        // connection owner correctly read the difference, flipped to
        // unreachable, and drove the shell's reconnect path in a test about
        // the boot restore. The stub now says what the server would say.
        if (chat === undefined) {
          return new Response(JSON.stringify({ error: "not_found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }
        return jsonResponse(emptyHistory(chat));
      }
      if (url.includes("/api/projects/p1/chats")) return jsonResponse([...chats]);
      if (url.includes("/api/projects")) return jsonResponse([PROJECT]);
      // Also a RESPONSE, not a rejection: an unstubbed URL is a test-authoring
      // mistake, and reporting it as a network failure would make it look
      // like a connection problem instead. 501 + the URL says what it is.
      return new Response(JSON.stringify({ error: "unstubbed", url }), {
        status: 501,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}


describe("horizon place — live `project ▸ conversation`, §10 boot restore", () => {
  let host: HTMLElement;
  let app: object | null = null;

  beforeEach(() => {
    if (typeof window.requestAnimationFrame !== "function") {
      vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
        setTimeout(() => cb(performance.now()), 16),
      );
    }
    localStorage.clear();
    resetProjects();
    resetChats();
    clearMessages();
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
    localStorage.clear();
  });

  async function mountAndReveal(): Promise<void> {
    app = mount(Cockpit, { target: host });
    await until(
      () => host.querySelector(".cockpit")?.getAttribute("data-revealed") === "true",
    );
  }

  function placeText(): string {
    const project = host.querySelector(".place-project");
    const conversation = host.querySelector(".place-conversation");
    if (project !== null && conversation !== null) return `${project.textContent} ▸ ${conversation.textContent}`;
    return host.querySelector(".place")?.textContent?.trim() ?? "";
  }

  function lineDetail(id: string): string | null {
    for (const line of host.querySelectorAll(".line")) {
      if (line.textContent?.includes(id) === true) {
        return line.querySelector(".detail")?.textContent ?? null;
      }
    }
    return null;
  }

  test("boot with nothing kept: honest absence — and the stores hold no phantom selection", async () => {
    stubApi([]);
    await mountAndReveal();
    expect(placeText()).toBe("web-interface ▸ no conversation open");
    expect(currentChatId.get()).toBeNull();
    // The boot column printed the restore fact.
    expect(lineDetail("conversation")).toContain("none kept");
  });

  test("a conversation created MID-SESSION updates the place the moment it exists (the live-seam fix)", async () => {
    stubApi([]);
    await mountAndReveal();
    expect(placeText()).toBe("web-interface ▸ no conversation open");

    // What client.ts createChat does on the store layer after the server
    // answers (the auto-create-on-first-send path).
    addChat(chatSummary("c9", "fresh talk"));
    selectChat("c9");
    flushSync();

    expect(placeText()).toBe("web-interface ▸ fresh talk");

    // And deselecting is honest again — the place is live in BOTH directions.
    selectChat(null);
    flushSync();
    expect(placeText()).toBe("web-interface ▸ no conversation open");
  });

  test("boot with a kept conversation restores it: validated against the server, shown in the place", async () => {
    const kept = chatSummary("c1", "seam walk");
    stubApi([kept]);
    // What the persistence layer restores into the stores at module load.
    currentProjectId.set("p1");
    currentChatId.set("c1");

    await mountAndReveal();

    expect(placeText()).toBe("web-interface ▸ seam walk");
    expect(currentChatId.get()).toBe("c1");
    expect(lineDetail("conversation")).toContain("restored · seam walk");
    // The kept conversation's history was actually loaded (not just labeled).
    const fetchMock = vi.mocked(fetch);
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes("/api/chats/c1/history")),
    ).toBe(true);
  });

  test("a kept id that no longer exists clears to an honest absence (no stale pointer)", async () => {
    stubApi([chatSummary("c1", "seam walk")]);
    currentProjectId.set("p1");
    currentChatId.set("deleted-chat");

    await mountAndReveal();

    expect(currentChatId.get()).toBeNull();
    expect(placeText()).toBe("web-interface ▸ no conversation open");
    expect(lineDetail("conversation")).toContain("no longer exists");
  });

  test("a kept project id that no longer exists falls back to a real project — the place never shows a ghost", async () => {
    stubApi([]);
    currentProjectId.set("deleted-project");

    await mountAndReveal();

    expect(currentProjectId.get()).toBe("p1");
    expect(placeText()).toBe("web-interface ▸ no conversation open");
  });
});
