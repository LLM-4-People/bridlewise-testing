// @vitest-environment jsdom
/**
 * THE WRITE DOOR for `rooms/`, `desk/` and `settings/` (DESIGN-COCKPIT-V2 §6.2).
 *
 * `broker.action()` is the app's one write door: it calls
 * `assertLiveForWrite()` before it records anything, so a write cannot fire
 * while the user is looking at a past instant. A surface that calls a
 * `client.ts` write function DIRECTLY is not standing at that door — it reaches
 * the wire with no assertion at all.
 *
 * A previous agent closed that class for `flow/` + `computer/` (five writes,
 * `tests/cockpit/flow-past-view-owner.test.ts`) and scoped its guard to those
 * two trees, explicitly leaving `rooms/`, `desk/` and `settings/` as a live
 * finding for their owners. This suite is that audit, and it closes the class
 * for those three trees rather than the instances found in them.
 *
 * WHAT WAS MEASURED BEFORE THIS SUITE EXISTED — three unguarded writes:
 *
 *   - `desk/DeskPanel.svelte` → `setChatModel`. Choosing a model from a view
 *     of 10:14:21 changed which model the LIVE next turn would run. The
 *     `<select>` already disabled itself; the PATH had nothing on it.
 *   - `rooms/SwitchRoom.svelte` → `createChat`. Fired by ⌘N, which has no
 *     control to grey out at all, so the disabling half was not merely missing
 *     — there was nowhere for it to live. It created a real conversation in
 *     the live project.
 *   - `rooms/SwitchRoom.svelte` → `createProject`. The inline form's [create]
 *     was enabled during a past view, and the form can be left OPEN across a
 *     head plant, so a plain Enter submitted it.
 *
 *   A. INVENTORY — what each tree imports from `client.ts`, enumerated, so a
 *      NEW import is an audit decision instead of a silent arrival.
 *   B. THE CLASS — no module in the three trees imports a client-side write
 *      without the assertion beside it.
 *   C. RENDERED — every control that triggers one of those writes is off,
 *      with the one owned reason, during a past view; and ON when live, so the
 *      assertion is about the head and not about the fixture.
 *   D. THE PATHS — the writes refuse even when the control is bypassed.
 *   E. MUTATION — the scanners catch what they claim to.
 *
 * Block-action surfaces in these trees (custody keep/undo, the breakers, the
 * strips, the settings sheet, the instrument verbs) go through
 * `broker.action` and are covered by `past-view-grammar.test.ts` §D; this
 * suite is about the writes that do NOT.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";

import DeskPanel from "../../src/cockpit/desk/DeskPanel.svelte";
import SwitchRoom from "../../src/cockpit/rooms/SwitchRoom.svelte";
import { resetDeskBus } from "../../src/cockpit/desk/desk-bus.ts";
import { resetDeskFeed, setDeskIo } from "../../src/cockpit/desk/desk-feed.ts";
import { resetCustodyFeed } from "../../src/cockpit/rooms/custody-feed.ts";
import { resetSwitchFeed, setSwitchReaders } from "../../src/cockpit/rooms/switch-feed.ts";
import { resetSweep } from "../../src/cockpit/sweep/sweep-store.ts";
import {
  PAST_VIEW_ACT_REASON,
  PAST_VIEW_READ_ONLY_CODE,
  assertLiveForWrite,
  plantHead,
  returnToLive,
} from "../../src/data/asof.ts";
import { clearCache } from "../../src/data/broker.ts";
import { ClientError } from "../../src/data/errors.ts";
import { clearMessages, setStreaming } from "../../src/state/chat-messages.ts";
import { chatHistoryLoad } from "../../src/state/chat-history-load.ts";
import { wholeConversationPage } from "../helpers/history-page.ts";
import { currentChatId, resetChats, setChats } from "../../src/state/chats.ts";
import { resetModels, setModels } from "../../src/state/models.ts";
import { resetProjects, setProjects } from "../../src/state/projects.ts";
import { resetTimeline } from "../../src/state/timeline-query.ts";
import { resetTimelineRefs } from "../../src/state/timeline-refs.ts";
import type { ShellApi } from "../../src/cockpit/shell/contract.ts";
import {
  CLIENT_WRITES,
  clientImports,
  writesWithoutAssertion,
} from "../helpers/client-writes.ts";
import { read, relpath, walk } from "../helpers/source-scan.ts";

const HEAD_MS = 1_700_000_000_000;

/** The three trees this audit owns. */
const AUDITED_TREES = [
  "src/cockpit/rooms",
  "src/cockpit/desk",
  "src/cockpit/settings",
] as const;

/**
 * SHARED-MODULE HYGIENE. `vitest.config.ts` sets `isolate: false`, so every test
 * file in a worker shares one module registry — and a head left standing would
 * make every later `broker.read()` in the worker throw `past_view_unsupported`,
 * failing somebody else's suite for a reason that has nothing to do with them.
 */
afterAll(() => {
  returnToLive();
});

// ── A. INVENTORY ───────────────────────────────────────────────────────────

/** Every `client.ts` specifier imported anywhere under a tree. */
function treeClientImports(root: string): string[] {
  const names = new Set<string>();
  for (const f of walk(root, { exts: [".ts", ".svelte"] })) {
    for (const n of clientImports(read(f))) names.add(n);
  }
  return [...names].sort();
}

describe("A. the complete client.ts inventory of each tree", () => {
  /**
   * The full list, not just the offenders — reads included. Enumerated so a
   * NEW `client.ts` import into one of these trees fails here and gets
   * audited, rather than arriving quietly and being covered only if it
   * happens to be a write someone already thought of.
   */
  test("rooms/ imports exactly these", () => {
    expect(treeClientImports("src/cockpit/rooms")).toEqual([
      "RecycledFile", // type — file recycle payload
      "TrashList", // type — recycle bin payload
      "createChat", // WRITE — gated (SwitchRoom, assertLiveForWrite)
      "createFolder", // WRITE — the picker's inline "new folder" (mkdir)
      "createProject", // WRITE — gated (SwitchRoom, assertLiveForWrite)
      "deleteChat", // WRITE — recycle bin (SwitchRoom, assertLiveForWrite)
      "deleteProject", // WRITE — recycle bin (SwitchRoom, assertLiveForWrite)
      // WRITE — the instruments actions fold's one wire door (the admin-only
      // POST /api/schema/ui/actions/:id wrapper; assertLiveForWrite at the
      // fold's own door, the RunPane stop's precedent)
      "executeSchemaAction",
      "getUiSchemaValues", // read — the live signal channel
      "listChats", // read
      "listDirectories", // read — the picker's directory listing
      "listDirectoryRoots", // read — the picker's allowed starting points
      "listRecycledFiles", // read — file recycle bin
      "listTrash", // read — recycle bin
      "loadChatHistory", // read — fills the message store the FLOW ingests
      "restoreChat", // WRITE — recycle bin (SwitchRoom, assertLiveForWrite)
      "restoreProject", // WRITE — recycle bin (SwitchRoom, assertLiveForWrite)
      "restoreRecycledFile", // WRITE — file recycle (SwitchRoom, assertLiveForWrite)
      "updateProjectPath", // WRITE — gated (SwitchRoom relink, assertLiveForWrite)
    ]);
  });

  test("desk/ imports exactly these", () => {
    expect(treeClientImports("src/cockpit/desk")).toEqual([
      "getModels", // read — the served catalog
      "setChatModel", // WRITE — gated (DeskPanel, assertLiveForWrite)
    ]);
  });

  test("settings/ imports exactly these", () => {
    // Served changes go through `settings-feed.saveSetting` →
    // `broker.action`, which IS the door. The provider section is the one
    // exception with client-side writes: the /api/models routes predate the
    // block fabric, and its two writes are gated below (part B) exactly as
    // the desk's setChatModel is. The MCP servers section is the same
    // exception for the same reason (the /api/mcp routes predate the fabric):
    // its two writes are gated below too.
    expect(treeClientImports("src/cockpit/settings")).toEqual([
      "McpServerView", // type — the served tool server list's row shape
      "deleteMcpServer", // WRITE — gated (McpServersSection, assertLiveForWrite)
      "deleteModelProvider", // WRITE — gated (ProvidersSection, assertLiveForWrite)
      "discoverModelProvider", // read-shaped probe — lists an endpoint's models, never writes preferences
      "getModels", // read — the served catalog
      "getUiSchema",
      "getUiSchemaValues",
      "listMcpServers", // read — the configured tool servers + live status
      "saveMcpServer", // WRITE — gated (McpServersSection, assertLiveForWrite)
      "saveModelPrefs", // WRITE — gated (ProvidersSection, assertLiveForWrite)
      "testMcpServer", // read-shaped probe — one real connect, changes nothing saved
      "testModelProvider", // read-shaped probe — a real request, changes nothing saved
    ]);
  });

  test("the WRITES in the inventory are really writes", () => {
    for (const name of [
      "createChat",
      "createProject",
      "deleteChat",
      "deleteProject",
      "restoreChat",
      "restoreProject",
      "restoreRecycledFile",
      "setChatModel",
    ]) {
      expect(CLIENT_WRITES, `${name} must be in the shared write set`).toContain(name);
    }
  });

  test("the write set is REAL — every name is exported by client.ts", () => {
    // A renamed export would otherwise empty the set and make every scan
    // below pass by checking nothing.
    const client = read("src/client.ts");
    for (const name of CLIENT_WRITES) {
      expect(client, `client.ts must export ${name}`).toMatch(
        new RegExp(`export\\s+(async\\s+)?function\\s+${name}\\b|export\\s+const\\s+${name}\\b`),
      );
    }
  });
});

// ── B. THE CLASS ───────────────────────────────────────────────────────────

describe("B. no rooms/desk/settings module holds a client write without the assertion", () => {
  test("the scan has something to look at", () => {
    for (const dir of AUDITED_TREES) {
      expect(walk(dir, { exts: [".ts", ".svelte"] }).length, dir).toBeGreaterThan(0);
    }
  });

  test("every tree is clean", () => {
    const offenders: string[] = [];
    for (const dir of AUDITED_TREES) {
      for (const f of walk(dir, { exts: [".ts", ".svelte"] })) {
        offenders.push(...writesWithoutAssertion(relpath(f), read(f)));
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  test("the two modules that DO hold a client write carry the assertion", () => {
    // Named, so deleting the assertion from either one fails here with the
    // file that lost it rather than as an anonymous empty-list mismatch.
    for (const f of [
      "src/cockpit/rooms/SwitchRoom.svelte",
      "src/cockpit/desk/DeskPanel.svelte",
    ]) {
      expect(read(f), `${f} must assert the read-only rule`).toMatch(
        /\bassertLiveForWrite\s*\(/,
      );
    }
  });
});

// ── C. RENDERED — the control is honest before the click ───────────────────

function shellStub(): ShellApi & { hints: () => readonly string[] } {
  const hints: string[] = [];
  return {
    revealAt: () => 0,
    openRoom: () => {},
    closeRoom: () => {},
    openScope: () => {},
    closeScope: () => {},
    setAnnunciators: () => {},
    setMonitors: () => {},
    claimKey: () => () => {},
    hint: (t: string) => {
      hints.push(t);
    },
    composerText: () => "",
    onComposerSubmit: () => () => {},
    prefillComposer: () => {},
    clearComposer: () => {},
    restoreComposerText: () => {},
    onComposerChange: () => () => {},
    setDeskLine: () => {},
    hints: () => hints,
  } as unknown as ShellApi & { hints: () => readonly string[] };
}

/** jsdom has no ResizeObserver; the switch's river binds clientWidth to one. */
class InertResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const CHAT = "chat-1";
const PROJECT = {
  id: "p1",
  name: "reader-refactor",
  path: "/tmp/p1",
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-25T00:00:00Z",
};
const CHAT_ROW = {
  id: CHAT,
  projectId: "p1",
  title: "fix the parser",
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-25T00:00:00Z",
  modelId: "claude-x",
  pinned: false,
};

const COMPOSE = {
  channels: [
    {
      id: "system",
      tokens: 300,
      items: [{ id: "system-prompt", label: "system prompt", tokens: 300 }],
    },
  ],
  limit: 10_000,
  settings: { pinnedMemoryIds: [], mutedChannels: [], mutedMemoryIds: [] },
};

const CREATED_CHAT = {
  id: "new-c", projectId: "new-p", title: "new conversation",
  createdAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z",
  modelId: null, pinned: false,
};

/** Every POST this render attempted — the evidence that nothing was written. */
let posts: string[] = [];

function stubFetch(): void {
  posts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET").toUpperCase() === "POST") posts.push(String(input));
      const url = String(input);
      // The folder picker's two reads answer with a real (small) tree, so the
      // "pick a folder, then [create] goes live" drive has something to pick.
      if (url.includes("/api/filesystem/roots")) {
        return new Response(JSON.stringify({ roots: [{ label: "work", path: "/work" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/api/filesystem/list")) {
        return new Response(
          JSON.stringify({ path: "/work", parent: null, accessible: true, entries: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if ((init?.method ?? "GET").toUpperCase() === "POST" && /\/api\/projects\/?$/.test(url)) {
        return new Response(
          JSON.stringify({
            id: "new-p",
            name: "work 2026-08-25",
            path: "/work",
            createdAt: "2026-08-25T00:00:00.000Z",
            updatedAt: "2026-08-25T00:00:00.000Z",
            folder: "present",
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      if ((init?.method ?? "GET").toUpperCase() === "POST" && /\/api\/projects\/[^/]+\/chats/.test(url)) {
        return new Response(
          JSON.stringify(CREATED_CHAT),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/chats/new-c/history")) {
        return new Response(JSON.stringify({
          chat: CREATED_CHAT, messages: [], toolCalls: [], timelineRefs: [],
          metricsSnapshots: [], page: wholeConversationPage(0),
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
}

beforeEach(() => {
  cleanup();
  returnToLive();
  vi.stubGlobal("ResizeObserver", InertResizeObserver);
  stubFetch();
  clearCache();
  resetDeskFeed();
  resetDeskBus();
  resetSwitchFeed();
  resetCustodyFeed();
  resetSweep();
  resetProjects();
  resetChats();
  resetModels();
  clearMessages();
  setStreaming(false);
  setProjects([PROJECT]);
  setChats([CHAT_ROW]);
  currentChatId.set(CHAT);
  setModels({
    providers: [
      {
        id: "prov",
        baseUrl: "http://x",
        models: [{ id: "claude-x" }, { id: "claude-y" }],
        hasApiKey: true,
      },
    ],
    defaultProvider: "prov",
    defaultModel: "claude-x",
    setupRequired: false,
    setupRemedy: "Open Settings and add a model provider.",
  });
  setSwitchReaders({
    chats: async () => [],
    pulse: async () => ({ runs: { known: 0, withEvents: 0 } }),
    spectrum: async () => ({
      header: {
        categories: ["x"],
        errorRow: 1,
        errorRowIsOverlay: true,
        rows: 2,
        bins: 0,
        binMs: 0,
        t0: null,
        t1: null,
        events: 0,
        unbinnable: 0,
        attributedOnly: true,
        clamped: false,
      },
      packed: "",
    }),
  });
});

afterEach(() => {
  cleanup();
  returnToLive();
  vi.unstubAllGlobals();
  resetDeskFeed();
  resetDeskBus();
  resetSwitchFeed();
  resetCustodyFeed();
  resetSweep();
  resetProjects();
  resetChats();
  resetModels();
  resetTimeline();
  resetTimelineRefs();
  clearMessages();
  setStreaming(false);
});

describe("C1. the desk's model selector", () => {
  async function renderDesk(): Promise<HTMLElement> {
    setDeskIo({
      compose: async () => COMPOSE,
      breaker: async () => [],
      act: async () => ({}),
    });
    const { container } = render(DeskPanel, { shell: shellStub() });
    await waitFor(() => {
      expect(container.querySelector("#desk-model")).not.toBeNull();
    });
    return container;
  }

  test("live: choosing a model is available", async () => {
    const container = await renderDesk();
    const select = container.querySelector<HTMLSelectElement>("#desk-model")!;
    expect(select.disabled).toBe(false);
  });

  // MUTATION (required): a selector left ENABLED during a past view fails here.
  test("past: the selector is off, with the one owned reason ON the control", async () => {
    plantHead(HEAD_MS);
    const container = await renderDesk();
    const select = container.querySelector<HTMLSelectElement>("#desk-model")!;
    expect(
      select.disabled,
      "choosing a model changes which model the LIVE next turn runs",
    ).toBe(true);
    expect(select.getAttribute("title")).toBe(PAST_VIEW_ACT_REASON);
  });
});

describe("C2. the switch's two create gestures", () => {
  /** The room, rendered; returns the container and the shell it was given. */
  function renderSwitch(): {
    container: HTMLElement;
    shell: ShellApi & { hints: () => readonly string[] };
  } {
    const shell = shellStub();
    const { container } = render(SwitchRoom, { shell });
    return { container, shell };
  }

  function press(container: HTMLElement, init: KeyboardEventInit): void {
    container.ownerDocument.defaultView!.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    );
  }

  test("live: ⌘N reaches the create — a POST is attempted", async () => {
    const { container } = renderSwitch();
    press(container, { key: "n", ctrlKey: true });
    await waitFor(() => {
      expect(posts.some((u) => u.includes("/chats"))).toBe(true);
    });
    // Finish the gesture's history read before cleanup restores real fetch.
    // Seeing the POST begin is too early: its async continuation still runs.
    await waitFor(() => {
      expect(chatHistoryLoad.get()).toEqual({ kind: "measured", chatId: "new-c" });
    });
  });

  // MUTATION (required): a chord that still writes during a past view fails.
  test("past: ⌘N writes NOTHING and says why", async () => {
    plantHead(HEAD_MS);
    const { container, shell } = renderSwitch();
    press(container, { key: "n", ctrlKey: true });
    await waitFor(() => {
      expect(shell.hints().length).toBeGreaterThan(0);
    });
    expect(shell.hints().join(" ")).toContain(PAST_VIEW_ACT_REASON);
    expect(
      posts.filter((u) => u.includes("/chats")),
      "no conversation may be created from a view of an earlier instant",
    ).toEqual([]);
  });

  test("past: ⌘⇧N does not even open the form — it says why instead", async () => {
    plantHead(HEAD_MS);
    const { container, shell } = renderSwitch();
    press(container, { key: "n", ctrlKey: true, shiftKey: true });
    await waitFor(() => {
      expect(shell.hints().length).toBeGreaterThan(0);
    });
    expect(container.querySelector('form[aria-label="new project"]')).toBeNull();
    expect(shell.hints().join(" ")).toContain(PAST_VIEW_ACT_REASON);
  });

  test("live: choosing a folder from the picker creates the project", async () => {
    const { container } = renderSwitch();
    press(container, { key: "n", ctrlKey: true, shiftKey: true });
    // The picker is the first thing on screen — no name field to fill.
    await waitFor(() => {
      expect(container.querySelector('[data-testid="folder-picker"]')).not.toBeNull();
    });
    await waitFor(() => {
      expect(container.querySelector('[role="treeitem"]')).not.toBeNull();
    });
    container.querySelector<HTMLButtonElement>('[role="treeitem"]')!.click();
    await waitFor(() => {
      expect(
        container.querySelector<HTMLButtonElement>('[data-verb-id="picker.choose"]')!.disabled,
      ).toBe(false);
    });
    container.querySelector<HTMLButtonElement>('[data-verb-id="picker.choose"]')!.click();
    await waitFor(() => {
      expect(posts.some((u) => u.includes("/api/projects"))).toBe(true);
    });
    // Finish the gesture's history read before cleanup restores real fetch.
    // Seeing the POST begin is too early: its async continuation still runs.
    await waitFor(() => {
      expect(chatHistoryLoad.get()).toEqual({ kind: "measured", chatId: "new-c" });
    });
  });

  // The picker is opened while live and the head is planted UNDER it.
  // Choosing must go off — a folder picked from a past view would still
  // create a live project.
  test("past: a picker left open across a head plant has the checkmark off, with the reason", async () => {
    const { container } = renderSwitch();
    press(container, { key: "n", ctrlKey: true, shiftKey: true });
    await waitFor(() => {
      expect(container.querySelector('[data-testid="folder-picker"]')).not.toBeNull();
    });
    plantHead(HEAD_MS);
    await waitFor(() => {
      const choose = container.querySelector<HTMLButtonElement>(
        '[data-verb-id="picker.choose"]',
      )!;
      expect(choose.disabled).toBe(true);
      expect(choose.getAttribute("title")).toBe(PAST_VIEW_ACT_REASON);
    });
  });

  test("the legend stops teaching a chord that will be refused", async () => {
    const { container } = renderSwitch();
    await fireEvent.click(container.querySelector('[data-verb-id="switch.options"]')!);
    await fireEvent.click(container.querySelector('[data-verb-id="switch.shortcuts"]')!);
    const legend = () => container.querySelector('[role="dialog"][aria-label="Keyboard shortcuts"]')!;
    expect(legend().textContent).toContain("+ conversation");
    plantHead(HEAD_MS);
    await waitFor(() => {
      const hints = legend().textContent ?? "";
      expect(hints).toContain(PAST_VIEW_ACT_REASON);
      expect(hints).not.toContain("+ conversation");
    });
    // …and a READ verb keeps its place — a past view is readable.
    expect(legend().textContent).toContain("resume");
  });

  test("the reason has ONE owner — no surface spells its own", () => {
    for (const f of [
      "src/cockpit/rooms/SwitchRoom.svelte",
      "src/cockpit/desk/DeskPanel.svelte",
    ]) {
      expect(read(f)).toContain("PAST_VIEW_ACT_REASON");
      expect(read(f), `${f} must not re-spell the sentence`).not.toMatch(
        /"this is a past view/,
      );
    }
  });
});

// ── D. THE PATHS ───────────────────────────────────────────────────────────

describe("D. the assertion is the guarantee, not the disabled attribute", () => {
  test("assertLiveForWrite refuses with the typed code while a head stands", () => {
    plantHead(HEAD_MS);
    let code: string | null = null;
    try {
      assertLiveForWrite();
    } catch (err) {
      code = err instanceof ClientError ? err.code : `unexpected:${String(err)}`;
    }
    expect(code).toBe(PAST_VIEW_READ_ONLY_CODE);
  });

  test("and does not refuse when live — the gate is the head, not the call", () => {
    returnToLive();
    expect(() => assertLiveForWrite()).not.toThrow();
  });

  test("the refusal's sentence IS the one on the controls", () => {
    plantHead(HEAD_MS);
    try {
      assertLiveForWrite();
      expect.unreachable("a planted head must refuse");
    } catch (err) {
      expect((err as ClientError).message).toBe(PAST_VIEW_ACT_REASON);
    }
  });
});

// ── E. MUTATION SELF-CHECKS ────────────────────────────────────────────────

describe("E. the scanners catch what they claim to", () => {
  test("an ungated client write in a ROOMS module is flagged", () => {
    const src = `import { createChat } from "../../client.ts";\nawait createChat(p, i);`;
    expect(writesWithoutAssertion("src/cockpit/rooms/X.svelte", src)).toHaveLength(1);
  });

  test("an ungated client write in a DESK module is flagged", () => {
    const src = `import { setChatModel } from "../../client.ts";\nawait setChatModel(c, m);`;
    expect(writesWithoutAssertion("src/cockpit/desk/X.svelte", src)).toHaveLength(1);
  });

  test("an ungated client write in a SETTINGS module is flagged", () => {
    const src =
      `import { setChatModel } from "../../client.ts";\n` +
      `await setChatModel(id, v);`;
    expect(writesWithoutAssertion("src/cockpit/settings/X.ts", src)).toHaveLength(1);
  });

  test("the same write WITH the assertion passes", () => {
    const src =
      `import { createProject } from "../../client.ts";\n` +
      `assertLiveForWrite();\nawait createProject(x);`;
    expect(writesWithoutAssertion("src/cockpit/rooms/X.svelte", src)).toEqual([]);
  });

  test("a module importing only READS is not asked for an assertion", () => {
    const src = `import { getUiSchema, listChats } from "../../client.ts";`;
    expect(clientImports(src)).toEqual(["getUiSchema", "listChats"]);
    expect(writesWithoutAssertion("src/cockpit/settings/X.ts", src)).toEqual([]);
  });

  test("a write named only in PROSE is not flagged", () => {
    const src = `// setChatModel( is described here, not called\nconst x = 1;`;
    expect(writesWithoutAssertion("src/cockpit/desk/X.svelte", src)).toEqual([]);
  });

  test("a renamed import still resolves to the write it is", () => {
    const src = `import { createChat as start } from "../../client.ts";\nawait start(p, i);`;
    expect(clientImports(src)).toEqual(["createChat"]);
    expect(writesWithoutAssertion("src/cockpit/rooms/X.svelte", src)).toHaveLength(1);
  });

  test("the inventory scan reads a real tree, not an empty one", () => {
    // A `walk` that silently returned nothing would make section A pass by
    // comparing two empty lists.
    expect(treeClientImports("src/cockpit/desk").length).toBeGreaterThan(0);
  });
});
