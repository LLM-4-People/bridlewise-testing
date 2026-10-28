// @vitest-environment jsdom
/** Mounted shared inspector: lazy tabs, persistent choices, addressed sections, and conversation/project scope. */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mount, unmount } from "svelte";

vi.mock("../../src/cockpit/shell/outlets.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/cockpit/shell/outlets.ts")>(),
  outletExists: () => false,
  loadOutlet: async () => null,
  roomExists: (id: string) => id === "editor",
  loadRoom: async () => null,
}));

import Cockpit from "../../src/cockpit/Cockpit.svelte";
import {
  consumeShellViewRequest,
  requestShellView,
} from "../../src/cockpit/shell/view-request.ts";
import {
  closeRightMenu,
  openRightMenu,
  rightMenu,
  toggleRightMenu,
} from "../../src/cockpit/shell/right-menu.ts";
import { upsertAgent, resetRunState, setRun, currentRun } from "../../src/state/run-state.ts";
import { clearMessages } from "../../src/state/chat-messages.ts";
import { resetCodebaseMapLoad, setCodebaseMapReader } from "../../src/state/run-pane.ts";
import { armedTriggers } from "../../src/cockpit/sweep/sweep-store.ts";
import { setChats, selectChat } from "../../src/state/chats.ts";
import { setProjects, currentProjectId } from "../../src/state/projects.ts";
import { workspaces } from "../../src/state/workspaces.ts";
import { INSPECTOR_SECTION_ENTRIES } from "../../shared/routes.ts";
import { RIGHT_MENU_GROUPS } from "../../src/cockpit/shell/right-menu.ts";
import { RUN_PANE_DOCK_MIN_PX } from "../../src/cockpit/shell/config.ts";
import { applyUiControlAction } from "../../src/state/ui-control.ts";
import { clearCache } from "../../src/data/broker.ts";
import type { AgentState } from "../../shared/types.ts";
import { until } from "../helpers/until.ts";

type Json = Record<string, unknown> | unknown[];
let captureRead: () => Promise<Response>;
function captureResponse(flags: unknown[]): Response {
  return new Response(JSON.stringify({ data: { flags, serverSideFiring: false }, meta: { etag: 'W/"capture"', asOf: 1000 } }), { headers: { "Content-Type": "application/json" } });
}

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
      if (url.includes("/api/projects")) return jsonResponse([]);
      if (url.includes("/api/b/arm.flags")) return captureRead();
      throw new Error(`unstubbed fetch: ${url}`);
    }),
  );
}


function pressRunChord(): void {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "r", ctrlKey: true, bubbles: true }),
  );
}

const RUNNING_AGENT: AgentState = {
  agentId: "shell-agent-1",
  agentName: "shell-agent-1",
  runId: "run-1",
  taskId: "task-1",
  attemptId: "att-1",
  lifecycleState: "running",
  turnCount: 1,
  totalPromptTokens: 10,
  totalCompletionTokens: 5,
  totalTokens: 15,
  turns: [],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  lastError: null,
  compactionSummary: null,
  suspensionReason: null,
};

describe("the single right menu in the mounted shell", () => {
  let host: HTMLElement;
  let app: object | null = null;
  const mediaChanges = new Map<string, (event: { matches: boolean }) => void>();

  beforeEach(async () => {
    mediaChanges.clear();
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query,
      addEventListener(_type: string, listener: (event: { matches: boolean }) => void) { mediaChanges.set(query, listener); },
      removeEventListener() { mediaChanges.delete(query); },
    }));
    if (typeof window.requestAnimationFrame !== "function") {
      vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) =>
        setTimeout(() => cb(performance.now()), 16),
      );
    }
    consumeShellViewRequest();
    // THE RIGHT-MENU STORE IS SHARED STATE (that is its point — the sweep's
    // ⌘⇧A claim reaches the host through it), so this suite resets it like
    // every other store it touches: a leftover open menu from a prior test
    // would mount the column at the next boot and deny-by-default would be
    // a coincidence, not a fact. The workspace-view MIRROR is cleared for
    // the same reason — a stored view is the only thing that can re-open a
    // column at boot, and it belongs to whichever test wrote it.
    closeRightMenu();
    clearCache();
    captureRead = async () => captureResponse([]);
    workspaces.set([]);
    window.sessionStorage.clear();
    resetRunState();
    clearMessages();
    armedTriggers.set([]);
    resetCodebaseMapLoad();
    // No project is open in these tests, so the codebase section renders its
    // honest absence; the reader floor guarantees no network is reached.
    setCodebaseMapReader(async () => {
      return { fileCount: 0, moduleCount: 0, symbolCount: 0, totalLines: 0, languages: [] };
    });
    stubApi();
    host = document.createElement("div");
    document.body.appendChild(host);
    app = mount(Cockpit, { target: host });
    await until(() => host.querySelector(".shell")?.getAttribute("data-revealed") === "true");
    setProjects([{ id: "p", name: "Project", path: "/test/project", createdAt: "t", updatedAt: "t" }]);
    currentProjectId.set("p");
    setChats(["a", "b"].map(id => ({ id, projectId: "p", title: "Conversation " + id, createdAt: "t", updatedAt: "t", modelId: null, pinned: false })));
    selectChat("a");
  });

  afterEach(async () => {
    if (app !== null) await unmount(app);
    app = null;
    host.remove();
    consumeShellViewRequest();
    closeRightMenu();
    window.sessionStorage.clear();
    resetRunState();
    clearMessages();
    vi.unstubAllGlobals();
  });

  /** The one column's aside element, or null when the edge hosts nothing.
   * Queried by tag + class, not [role]: the aside's complementary role is
   * implicit (the ARIA first rule — no redundant role attribute), and
   * querySelector reads attributes, not computed roles. The landmark itself
   * is proven by name in the dedicated arm below. */
  const menuEl = () => host.querySelector("aside.right-menu");
  /** A group's cap button, by the group id the store lands at. */
  const groupCap = (id: string) =>
    host.querySelector<HTMLButtonElement>(`[data-verb-id="rm.group-${id}"]`);

  test("the menu is closed by default (deny-by-default)", () => {
    expect(menuEl()).toBeNull();
    expect(rightMenu.get()).toBeNull();
  });

  test("every declared group has a titled mouse path and one real selected body", async () => {
    openRightMenu("run");
    await until(() => menuEl() !== null);
    for (const [id, group] of Object.entries(RIGHT_MENU_GROUPS)) {
      const button = groupCap(id)!;
      expect(button.getAttribute("data-chord-target")).toBe(group.chord);
      expect(button.title.length).toBeGreaterThan(0);
      button.click();
      await until(() => button.getAttribute("aria-selected") === "true");
      expect(rightMenu.get()).toBe(id);
      expect(host.querySelectorAll('aside.right-menu')).toHaveLength(1);
      expect(host.querySelectorAll('.section-tab[aria-selected="true"]')).toHaveLength(1);
    }
  });

  test("the same presentation decision leaves a wide Editor reachable and contains a compact overlay", async () => {
    requestShellView({ kind: "room", id: "editor" });
    await until(() => host.querySelector('[data-room-active="true"]') !== null);
    mediaChanges.get(`(min-width: ${RUN_PANE_DOCK_MIN_PX}px)`)?.({ matches: true });
    openRightMenu("run");
    await until(() => menuEl()?.getAttribute("data-presentation") === "room-docked");
    const first = host.querySelector<HTMLButtonElement>('[data-verb-id="right-menu.files"]')!;
    first.focus();
    const wideTab = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    first.dispatchEvent(wideTab);
    expect(wideTab.defaultPrevented).toBe(false);
    expect(menuEl()?.getAttribute("aria-modal")).toBeNull();
    expect(menuEl()?.getAttribute("role")).toBe("complementary");
    expect((host.querySelector('[data-room-active="true"]') as HTMLElement).inert).toBe(false);
    mediaChanges.get(`(min-width: ${RUN_PANE_DOCK_MIN_PX}px)`)?.({ matches: false });
    await until(() => menuEl()?.getAttribute("data-presentation") === "overlay");
    expect(menuEl()?.getAttribute("aria-modal")).toBe("true");
    expect((host.querySelector('[data-room-active="true"]') as HTMLElement).inert).toBe(true);
    first.focus();
    const compactTab = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    first.dispatchEvent(compactTab);
    expect(compactTab.defaultPrevented).toBe(true);
    const last = document.activeElement!;
    expect(last.closest('.right-menu')).toBe(menuEl());
    expect(last).not.toBe(first);
    const forwardTab = new KeyboardEvent("keydown", {key:"Tab",bubbles:true,cancelable:true});
    last.dispatchEvent(forwardTab);
    expect(forwardTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await until(() => menuEl() === null);
    expect(host.querySelector('[data-room-active="true"]')).not.toBeNull();
  });

  test("the chord toggles the single menu open and closed, landing at the run group", async () => {
    pressRunChord();
    await until(() => menuEl() !== null);
    expect(rightMenu.get()).toBe("run");
    pressRunChord();
    await until(() => menuEl() === null);
    expect(rightMenu.get()).toBeNull();
  });

  test("the single menu declares itself ONE complementary landmark named for both halves", async () => {
    pressRunChord();
    await until(() => menuEl() !== null);
    const aside = menuEl()!;
    expect(aside.getAttribute("aria-label")).toBe("workspace inspector");
    // ONE aside for the one column — the groups are named caps inside it,
    // not landmarks of their own (the APG's region-proliferation caution
    // at this menu's size).
    expect(host.querySelectorAll("aside").length).toBe(1);
  });

  test("one column exposes both tabs and mounts only the selected body's sections", async () => {
    pressRunChord();
    await until(() => host.querySelector('[data-disclosure="run-sec-progress"]') !== null);
    expect(groupCap("run")!.getAttribute("aria-selected")).toBe("true");
    expect(groupCap("arm")!.getAttribute("aria-selected")).toBe("false");
    expect(groupCap("run")!.getAttribute("aria-controls")).toBe("inspector-body");
    expect(host.querySelector('[data-disclosure="arm-sec-fire-when"]')).toBeNull();
    expect(host.querySelectorAll('aside.right-menu')).toHaveLength(1);
  });
  test("the arm group's cap IS the arm chord's mouse path; the rail's single button carries the run literal", async () => {
    // One button can carry one literal, honestly: the rail icon claims
    // `run`; the arm chord's own control is the arm group's cap inside the
    // open menu — a real, titled, floor-cleared button the guard can read.
    pressRunChord();
    await until(() => menuEl() !== null);
    const railButtons = host.querySelectorAll<HTMLButtonElement>('.side-rail [data-chord-target]');
    expect(railButtons.length, "the rail holds ONE button").toBe(1);
    expect(railButtons[0]!.getAttribute("data-chord-target")).toBe("run");
    const armCap = groupCap("arm")!;
    expect(armCap.getAttribute("data-chord-target")).toBe("arm");
    expect(armCap.getAttribute("title"), "the arm cap teaches its chord").toContain("Ctrl+Shift+A");
    expect(runCapTitle(), "the run cap teaches its chord").toContain("Ctrl+R");
  });

  function runCapTitle(): string {
    return groupCap("run")!.getAttribute("title") ?? "";
  }

  test("mouse and sweep landing select the same group and retain the toggle law", async () => {
    pressRunChord();
    await until(() => menuEl() !== null);
    groupCap("arm")!.click();
    await until(() => host.querySelector('[data-disclosure="arm-sec-fire-when"]') !== null);
    expect(rightMenu.get()).toBe("arm");
    expect(groupCap("run")!.getAttribute("aria-selected")).toBe("false");
    expect(host.querySelector('[data-disclosure="run-sec-progress"]')).toBeNull();
    toggleRightMenu("arm");
    await until(() => menuEl() === null);
    openRightMenu("arm");
    await until(() => groupCap("arm")?.getAttribute("aria-selected") === "true");
  });
  test("the toggle law, per group: the landed group's own press closes; the other group's press re-lands", async () => {
    pressRunChord();
    await until(() => menuEl() !== null);
    expect(rightMenu.get()).toBe("run");
    // A press naming the OTHER group re-lands the open menu — the old
    // two-column replacement, expressed as one gesture.
    toggleRightMenu("arm");
    await until(() => groupCap("arm")!.getAttribute("aria-selected") === "true");
    expect(menuEl(), "re-landing keeps the ONE menu open").not.toBeNull();
    expect(rightMenu.get()).toBe("arm");
    // A press naming the LANDED group closes it.
    toggleRightMenu("arm");
    await until(() => menuEl() === null);
    expect(rightMenu.get()).toBeNull();
  });

  test("the rail icon button is the mouse path to the same toggle (aria-pressed tracks open/closed, glyph + label carry the name)", async () => {
    mediaChanges.get(`(min-width: ${RUN_PANE_DOCK_MIN_PX}px)`)?.({ matches: true });
    const grip = host.querySelector<HTMLButtonElement>('.side-rail [data-chord-target="run"]');
    expect(grip, "the side rail must carry the icon button naming the run chord").not.toBeNull();
    expect(grip!.getAttribute("aria-pressed"), "closed menu → not pressed").toBe("false");
    // THE NAME RIDES WITH THE GLYPH: the accessible label names the menu
    // (never the title attribute alone), and the tooltip teaches BOTH
    // chords from the grammar table's own spellings.
    expect(grip!.getAttribute("aria-label")).toContain("workspace inspector");
    expect(grip!.getAttribute("title")).toContain("Ctrl+R");
    expect(grip!.getAttribute("title")).toContain("Ctrl+Shift+A");
    expect(grip!.querySelector('svg[aria-hidden="true"]'), "the button has a drawn icon and an accessible name").not.toBeNull();
    grip!.click();
    await until(() => menuEl() !== null);
    expect(rightMenu.get()).toBe("run");
    await until(() => grip!.getAttribute("aria-pressed") === "true");
    expect(grip!.disabled).toBe(false);
    grip!.click();
    await until(() => menuEl() === null);
    await until(() => grip!.getAttribute("aria-pressed") === "false");
  });

  test("a remount (what a reload is to an unpersisted store) does not reopen the menu", async () => {
    // THE RELOAD RULE (§10.3). The right-menu store is not persisted: a
    // fresh boot must not land in a column nobody re-asked for. A remount
    // over the same world is that boot — the store survives nothing.
    pressRunChord();
    await until(() => menuEl() !== null);
    unmount(app!);
    app = null;
    host.remove();
    closeRightMenu();
    window.sessionStorage.clear();
    host = document.createElement("div");
    document.body.appendChild(host);
    app = mount(Cockpit, { target: host });
    await until(() => host.querySelector(".shell")?.getAttribute("data-revealed") === "true");
    expect(rightMenu.get()).toBeNull();
    expect(menuEl()).toBeNull();
  });

  test("a pane view request (the LLM's set_tab → agents) opens it through the same door", async () => {
    requestShellView({ kind: "pane" });
    await until(() => menuEl() !== null);
    expect(consumeShellViewRequest()).toBeNull();
  });

  // ── THE ARM GROUP CAP'S COCKED COUNT — the standing population on the
  // cap, so the second group states what it holds without expanding. ONE
  // manifestation per fact: the cap count is THE standing visibility; the
  // count appears only while a trigger waits (deny-by-default dark at
  // rest, the annunciator's own resting law).
  test("the arm cap carries its cocked count while triggers wait — and stays dark with none", async () => {
    pressRunChord();
    await until(() => menuEl() !== null);
    // No triggers: no count on the cap — dark is the resting state.
    expect(groupCap("arm")!.querySelector(".group-count")).toBeNull();
    // Two cocked, one fired: the cap counts the COCKED (waiting) ones.
    armedTriggers.set([
      Object.freeze({
        id: "arm-1", kind: "tool-errors", param: null, predicate: null, scope: "chat",
        armedAtMs: 1, firedAtMs: null, storage: "local",
      }),
      Object.freeze({
        id: "arm-2", kind: "check-fails", param: null, predicate: null, scope: "chat",
        armedAtMs: 1, firedAtMs: null, storage: "local",
      }),
      Object.freeze({
        id: "arm-3", kind: "tool-errors", param: null, predicate: null, scope: "chat",
        armedAtMs: 1, firedAtMs: 9_000, storage: "local",
      }),
    ]);
    await until(() => {
      const count = groupCap("arm")!.querySelector(".group-count");
      return count !== null && count.textContent === "2 watching";
    });
    expect(groupCap("arm")!.querySelector(".group-count")!.textContent).toBe("2 watching");
    // The count is LIVE through a store tick (collapsed body or not).
    armedTriggers.set((armedTriggers.get()).slice(0, 1));
    await until(() => groupCap("arm")!.querySelector(".group-count")!.textContent === "1 watching");
    armedTriggers.set([]);
    await until(() => groupCap("arm")!.querySelector(".group-count") === null);
  });

  test("an agent upsert lands on screen through the whole shell (store→component is live)", async () => {
    pressRunChord();
    await until(() => host.querySelector('[data-verb-id="disclosure.run-sec-agents"]') !== null);
    // The agents section defaulted by presence: no agents → collapsed,
    // its count visible in the header. The reader's click path opens it.
    const agentsGrip = host.querySelector<HTMLButtonElement>('[data-verb-id="disclosure.run-sec-agents"]')!;
    expect(agentsGrip.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector("#run-sec-agents")).toBeNull();
    agentsGrip.click();
    await until(() => host.querySelector("#run-sec-agents") !== null);
    expect(host.querySelector("#run-sec-agents")!.textContent).toContain("no agents yet");
    upsertAgent(RUNNING_AGENT);
    await until(() =>
      host.querySelector("#run-sec-agents")!.textContent!.includes("shell-agent-1"),
    );
  });

  test("manual section choice survives closing and reopening the menu", async () => {
    pressRunChord();
    await until(() => host.querySelector('[data-verb-id="disclosure.run-sec-agents"]') !== null);
    const grip = host.querySelector<HTMLButtonElement>('[data-verb-id="disclosure.run-sec-agents"]')!;
    expect(grip.getAttribute("aria-expanded")).toBe("false");
    grip.click();
    await until(() => grip.getAttribute("aria-expanded") === "true");
    host.querySelector<HTMLButtonElement>(".right-menu .close")!.click();
    await until(() => menuEl() === null);
    pressRunChord();
    await until(() => host.querySelector('[data-verb-id="disclosure.run-sec-agents"]')?.getAttribute("aria-expanded") === "true");
  });
  test("all declared sections are discoverable before mounting their body", async () => {
    pressRunChord();
    await until(() => menuEl() !== null);
    const input = host.querySelector<HTMLInputElement>('[aria-label="find an inspector section or action"]')!;
    for (const section of INSPECTOR_SECTION_ENTRIES) {
      input.value = section.label;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await until(() => host.querySelector('[data-verb-id="right-menu.find-' + section.id + '"]') !== null);
    }
    expect(host.querySelector('[data-disclosure="arm-sec-fire-when"]')).toBeNull();
    applyUiControlAction({ action: "inspect", mode: "open", section: "arm-sec-palette" });
    await until(() => host.querySelector('[data-verb-id="disclosure.arm-sec-palette"]')?.getAttribute("aria-expanded") === "true");
  });

  test("watch draft survives switching tabs and reopening", async () => {
    openRightMenu("arm");
    await until(() => host.querySelector('[name="arm-custom-expression"]') !== null || host.querySelector('[data-verb-id="disclosure.arm-sec-palette"]') !== null);
    const grip = host.querySelector<HTMLButtonElement>('[data-verb-id="disclosure.arm-sec-palette"]')!;
    if (grip.getAttribute("aria-expanded") !== "true") grip.click();
    await until(() => host.querySelector('[name="arm-custom-expression"]') !== null);
    const input = host.querySelector<HTMLInputElement>('[name="arm-custom-expression"]')!;
    input.value = "tool.failed && event.type == 'tool'";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    groupCap("run")!.click();
    await until(() => host.querySelector('[name="arm-custom-expression"]') === null);
    groupCap("arm")!.click();
    await until(() => host.querySelector<HTMLInputElement>('[name="arm-custom-expression"]')?.value === "tool.failed && event.type == 'tool'");
  });

  test("a first section jump remains open while the real capture read settles", async () => {
    let answer!: (value: Response) => void;
    captureRead = () => new Promise(resolve => { answer = resolve; });
    applyUiControlAction({ action: "inspect", mode: "open", section: "arm-sec-captured" });
    await until(() => typeof answer === "function");
    await until(() => host.querySelector('[data-verb-id="disclosure.arm-sec-captured"]')?.getAttribute("aria-expanded") === "true");
    expect(host.textContent).not.toContain("has no entries in this context yet");
    answer(captureResponse([{ id: "capture-ready", kind: "range", t0: 100, t1: 900, label: "A useful moment", recordedAt: new Date(1000).toISOString() }]));
    await until(() => host.querySelector("#arm-sec-captured")?.textContent?.includes("A useful moment") === true);
    expect(host.querySelector('[data-verb-id="disclosure.arm-sec-captured"]')?.getAttribute("aria-expanded")).toBe("true");
  });

  test("an overlay contains Tab and Escape restores its real opener", async () => {
    const opener = host.querySelector<HTMLButtonElement>('[data-verb-id="chord.run"]')!;
    opener.focus(); opener.click();
    await until(() => host.querySelector('[data-disclosure="run-sec-preparation"]') !== null);
    const first = host.querySelector<HTMLButtonElement>('[data-verb-id="right-menu.files"]')!;
    expect(document.activeElement).toBe(first);
    first.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }));
    expect(document.activeElement?.closest('.right-menu')).toBe(menuEl());
    expect(document.activeElement).not.toBe(first);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await until(() => menuEl() === null && document.activeElement === opener);
    expect(host.querySelector('.flow-outlet')?.hasAttribute("inert")).toBe(false);
  });

  test("switching conversations in the same project retires the previous live run", async () => {
    openRightMenu("run");
    setRun({ runId: "owned-by-a", projectId: "p", status: "running", startedAt: Date.now(), modelLabel: null });
    await until(() => host.querySelector('.run-state')?.textContent === "● Run active");
    selectChat("b");
    expect(currentRun.get()).toBeNull();
    await until(() => host.querySelector('.run-state') === null);
    expect(host.querySelector('.inspector-heading h2')?.textContent).toBe("Conversation inspector");
    expect(host.querySelector('.conversation-summary'), "section links retain the counts and destinations without a duplicate summary").toBeNull();
    expect(host.querySelector('.place-conversation')?.textContent).toBe("Conversation b");
    expect(host.querySelector('[data-verb-id="run.stop"]')).toBeNull();
  });

  test("project-only inspector exposes project state and explains unavailable conversation sections", async () => {
    selectChat(null);
    openRightMenu("run");
    await until(() => host.querySelector('[data-disclosure="run-sec-codebase"]') !== null);
    expect(host.querySelector('[data-disclosure="run-sec-progress"]')).toBeNull();
    expect(host.querySelector('[data-verb-id="right-menu.files"]')).not.toBeNull();
    const heading = host.querySelector('.inspector-heading')!;
    expect(heading.querySelector('h2')?.textContent).toBe("Project inspector");
    for (const action of ["files", "changes", "close"]) {
      expect(heading.querySelector(`[data-verb-id="right-menu.${action}"]`), action).not.toBeNull();
    }
    expect(host.textContent).not.toContain("Project settings & activity");
    applyUiControlAction({ action: "inspect", mode: "open", section: "run-sec-calls" });
    await until(() => host.textContent?.includes("Open a conversation to see Tool calls.") === true);
  });

  test("the menu's own close control closes it", async () => {
    pressRunChord();
    await until(() => menuEl() !== null);
    host.querySelector<HTMLButtonElement>(".right-menu .close")!.click();
    await until(() => menuEl() === null);
  });

  test("the side rail renders inert from first paint, revealed as chrome with the boot", async () => {
    // ONE-REVEAL (§10.3): the rail mounts with the authed chrome in the
    // reveal frame — never after it — and its icon is a real control at
    // rest, disabled only until the reveal. A rail that appeared late or
    // a glyph that was live before the reveal would both break the law.
    unmount(app!);
    app = null;
    host.remove();
    closeRightMenu();
    window.sessionStorage.clear();
    host = document.createElement("div");
    document.body.appendChild(host);
    app = mount(Cockpit, { target: host });
    await until(() => host.querySelector(".side-rail") !== null);
    const grips = host.querySelectorAll<HTMLButtonElement>(".side-rail .rail-grip");
    expect(grips.length, "the rail holds exactly one grip").toBe(1);
    const grip = grips[0]!;
    expect(grip.getAttribute("aria-pressed")).toBe("false");
    expect(grip.getAttribute("data-chord-target")).toBe("run");
    expect(grip.getAttribute("title"), "the mouse path teaches both chords").toContain("Ctrl+");
    // THE INERT/LIVE LAW, read as a state law rather than a race: the stub
    // answers auth instantly, so this arm may catch the rail before OR
    // after the reveal frame — either way the grip's liveness must match
    // the shell's own revealed state exactly (inert chrome before, a real
    // control after; never live before the reveal, never dead after it).
    const revealedNow = host.querySelector(".shell")?.getAttribute("data-revealed") === "true";
    expect(grip.disabled, "the grip is inert exactly until the reveal").toBe(!revealedNow);
    await until(() => host.querySelector(".shell")?.getAttribute("data-revealed") === "true");
    expect(grip.disabled).toBe(false);
  });
});
