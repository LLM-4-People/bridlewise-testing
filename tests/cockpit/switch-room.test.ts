// @vitest-environment jsdom
/**
 * THE SWITCH — the room, live in jsdom (spec §5.2).
 *
 * What must hold on screen:
 *   - instant river from the in-memory stores: caps in session order,
 *     latest 3 reels + "n more" expandable IN PLACE;
 *   - every reel state is honest: pending ("outcome not loaded yet"),
 *     measured (the pulse's own line), absent ("no runs yet" — the
 *     MUTATION test: a reel stripped of its absence state fails here);
 *   - type-to-filter narrows across project + conversation names;
 *   - resume sets the stores, closes the room, loads the history the FLOW
 *     ingests; replay additionally PLANTS THE SWEEP HEAD at the
 *     conversation's recorded start (the reachable seam);
 *   - the custody badge renders ONLY a measured attributed count from the
 *     custody feed (absence or zero → no badge — absence over fabrication);
 *   - the Switch chord toggles the room closed through the SHELL's claim
 *     stack (not a listener of its own), ⌘⇧N opens the inline validated
 *     project form from the room-local chord table, Esc clears the filter
 *     before ceding to the shell.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";

import { SwitchRiver } from "../../src/cockpit/rooms/switch-data.ts";
import SwitchRoom from "../../src/cockpit/rooms/SwitchRoom.svelte";
import {
  resetSwitchFeed,
  outcomeStates,
  densityStates,
  requestReelData,
  feedActiveCount,
  setSwitchReaders,
} from "../../src/cockpit/rooms/switch-feed.ts";
import {
  resetCustodyFeed,
  setCustodyReaders,
} from "../../src/cockpit/rooms/custody-feed.ts";
import { resetProjects, setProjects, currentProjectId } from "../../src/state/projects.ts";
import { resetChats, setChats, currentChatId } from "../../src/state/chats.ts";
// The suite runs with isolate:false (module state survives across test
// files in a worker) — every store the resume path writes MUST be reset
// here or it leaks into the sweep's scope-honesty tests.
import { resetTimeline } from "../../src/state/timeline-query.ts";
import { resetTimelineRefs } from "../../src/state/timeline-refs.ts";
import { resetSweep, sweepHead } from "../../src/cockpit/sweep/sweep-store.ts";
import type { ShellApi } from "../../src/cockpit/shell/contract.ts";
import { wholeConversationPage } from "../helpers/history-page.ts";

const T = Date.parse("2026-07-26T12:00:00Z");
const iso = (msAgo: number): string => new Date(T - msAgo).toISOString();

const P1 = { id: "p1", name: "reader-refactor", path: "/tmp/p1", createdAt: iso(9000), updatedAt: iso(5000) };
const P2 = { id: "p2", name: "billing", path: "/tmp/p2", createdAt: iso(9000), updatedAt: iso(8000) };
/** A conversation-less project — compact cap (name + new conversation). */
const P3 = { id: "p3", name: "empty-shell", path: "/tmp/p3", createdAt: iso(9000), updatedAt: iso(8500) };

const CHATS = [
  { id: "c1", projectId: "p1", title: "fix the parser", createdAt: iso(50_000), updatedAt: iso(1000), modelId: null, pinned: false },
  { id: "c2", projectId: "p1", title: "second pass", createdAt: iso(50_000), updatedAt: iso(2000), modelId: null, pinned: false },
  { id: "c3", projectId: "p1", title: "third pass", createdAt: iso(50_000), updatedAt: iso(3000), modelId: null, pinned: false },
  { id: "c4", projectId: "p1", title: "oldest work", createdAt: iso(50_000), updatedAt: iso(4000), modelId: null, pinned: false },
  { id: "c5", projectId: "p2", title: "invoices", createdAt: iso(50_000), updatedAt: iso(500), modelId: null, pinned: false },
];

const PULSE_START = "2026-07-25T14:02:00.000Z";
const MEASURED_PULSE = {
  runs: { known: 3, withEvents: 3 },
  filesTouched: { status: "measured", value: { distinctPaths: 6 }, derivation: "t" },
  errors: { status: "measured", value: { eventsWithErrorDetail: 0, failedOutcomes: 0 }, derivation: "t" },
  wallTimeSpan: { status: "measured", value: { firstEventAt: PULSE_START, lastEventAt: PULSE_START, events: 40 }, derivation: "t" },
};
const NO_RUNS_PULSE = { runs: { known: 0, withEvents: 0 } };

const EMPTY_SPECTRUM = {
  header: {
    categories: ["x"], errorRow: 1, errorRowIsOverlay: true, rows: 2, bins: 0,
    binMs: 0, t0: null, t1: null, events: 0, unbinnable: 0, attributedOnly: true, clamped: false,
  },
  packed: "",
};

type Claim = Readonly<{
  target: string;
  handler: (ev: Readonly<{ shift: boolean }>) => void;
  transient: boolean;
}>;

function makeShell(): ShellApi & {
  closed: () => number;
  hints: () => readonly string[];
  claims: () => readonly Claim[];
  released: () => readonly string[];
} {
  let closed = 0;
  const hints: string[] = [];
  const claims: Claim[] = [];
  const released: string[] = [];
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
    // The real shell's claim stack, reduced to what a test needs to SEE:
    // which target was claimed, by what handler, and whether the claim was
    // released. A room that answered a chord from a private listener instead
    // would leave this empty, which is exactly the defect being pinned.
    claimKey: (target, handler, opts) => {
      claims.push({ target, handler, transient: opts?.transient === true });
      return () => released.push(target);
    },
    pushDismiss: () => () => {},
    hint: (t) => {
      hints.push(t);
    },
    composerText: () => "",
    onComposerSubmit: () => () => {},
    prefillComposer: () => {},
    clearComposer: () => {},
    restoreComposerText: () => {},
    onComposerChange: () => () => {},
    setDeskLine: () => {},
    closed: () => closed,
    hints: () => hints,
    claims: () => claims,
    released: () => released,
  };
}

/** Minimal fetch router: enough truth for loadChatHistory's store fill. */
function stubFetch(): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    const history = /\/api\/chats\/([^/]+)\/history/.exec(url);
    if (history !== null) {
      const chat = CHATS.find((c) => c.id === history[1]) ?? CHATS[0]!;
      return json({ chat, messages: [], toolCalls: [], metricsSnapshots: [], timelineRefs: [], page: wholeConversationPage(0) });
    }
    if (url.includes("/api/filesystem/roots")) {
      return json({ roots: [{ label: "work", path: "/work" }] });
    }
    if (url.includes("/api/filesystem/list")) {
      return json({ path: "/work", parent: null, accessible: true, entries: [] });
    }
    if (url.includes("/api/trash")) {
      return json({ projects: [], chats: [] });
    }
    if (url.includes("/api/editor/recycle")) {
      return json({ files: [] });
    }
    return json({});
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

function seed(): void {
  setProjects([P1, P2, P3]);
  setChats(CHATS);
  // Mark chats as session-loaded so the room does not re-fetch them.
  setSwitchReaders({
    chats: async () => [],
    pulse: async (chatId: string) => (chatId === "c1" ? MEASURED_PULSE : NO_RUNS_PULSE),
    spectrum: async () => EMPTY_SPECTRUM,
  });
}

function key(target: EventTarget, init: KeyboardEventInit): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

// Svelte's bind:clientWidth rides ResizeObserver, which jsdom lacks. A
// zero-size observer is honest here: jsdom boxes have no geometry anyway
// (the grid falls back to one column, which the roving-focus tests use).
class InertResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  cleanup();
  vi.stubGlobal("ResizeObserver", InertResizeObserver);
  resetSwitchFeed();
  resetCustodyFeed();
  resetProjects();
  resetChats();
  resetSweep();
  stubFetch();
  seed();
});

afterEach(async () => {
  cleanup();
  await tick();
  vi.unstubAllGlobals();
  resetSwitchFeed();
  resetCustodyFeed();
  resetProjects();
  resetChats();
  resetSweep();
  resetTimeline();
  resetTimelineRefs();
});


async function optionsAction(container: HTMLElement, id: string): Promise<void> {
  await fireEvent.click(container.querySelector('[data-verb-id="switch.options"]')!);
  await fireEvent.click(container.querySelector('[role="menu"] [data-verb-id="'+id+'"]')!);
}
async function projectMenu(container: HTMLElement, name: string): Promise<void> {
  const group = [...container.querySelectorAll('.group')].find(e => e.getAttribute('aria-label') === name)!;
  await fireEvent.click(group.querySelector('[data-verb-id="switch.project-menu"]')!);
}
async function conversationMenu(container: HTMLElement, title: string): Promise<void> {
  const reel = [...container.querySelectorAll('.reel')].find(e => e.querySelector('.name')?.textContent === title)!;
  await fireEvent.click(reel.querySelector('[data-verb-id="switch.conversation-menu"]')!);
}

describe("the recency river, instant from memory", () => {
  test("measured geometry publishes once per frame and unmount cancels observer work", async () => {
    const frames = new Map<number, FrameRequestCallback>(); let sequence=0;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { const id=++sequence;frames.set(id,callback);return id; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id); });
    const observers: {node: Element | null; callback: ResizeObserverCallback; disconnected:boolean}[] = [];
    vi.stubGlobal('ResizeObserver', class {
      owner: typeof observers[number];
      constructor(callback: ResizeObserverCallback) { this.owner={node:null,callback,disconnected:false};observers.push(this.owner); }
      observe(node: Element) { this.owner.node=node; }
      disconnect() { this.owner.disconnected=true; }
    });
    const {container,unmount} = render(SwitchRoom,{shell:makeShell()});
    const row = observers.find(owner=>owner.node?.classList.contains('cap'))!;
    const groups = [...container.querySelectorAll<HTMLElement>('.group')];
    expect(row).toBeTruthy();expect(groups.length).toBeGreaterThan(1);
    const before=groups[1]!.style.top;
    for(const height of [140,160,180]) row.callback([{target:row.node!,borderBoxSize:[{blockSize:height}]}] as unknown as ResizeObserverEntry[],{} as ResizeObserver);
    await Promise.resolve();
    expect(groups[1]!.style.top, 'observer delivery cannot synchronously reshape its own virtual window').toBe(before);
    expect(frames.size, 'multiple deliveries share one finite publication').toBe(1);
    const frame=[...frames.values()][0]!;frames.clear();frame(0);await Promise.resolve();await Promise.resolve();
    expect(groups[1]!.style.top).not.toBe(before);
    row.callback([{target:row.node!,borderBoxSize:[{blockSize:190}]}] as unknown as ResizeObserverEntry[],{} as ResizeObserver);
    expect(frames.size).toBe(1);
    unmount();await Promise.resolve();
    expect(frames.size).toBe(0);
    expect(observers.every(owner=>owner.disconnected)).toBe(true);
  });
  test("caps render with latest-3 + 'n more', expandable in place", async () => {
    const { getByText, queryByText, getByLabelText } = render(SwitchRoom, { shell: makeShell() });

    expect(getByText("reader-refactor")).toBeTruthy();
    expect(getByText("billing")).toBeTruthy();
    // p1 holds 4 conversations: latest 3 visible, the 4th behind "1 more".
    expect(getByText("fix the parser")).toBeTruthy();
    expect(getByText("second pass")).toBeTruthy();
    expect(getByText("third pass")).toBeTruthy();
    expect(queryByText("oldest work")).toBeNull();

    await fireEvent.click(getByText("1 more"));
    expect(getByText("oldest work")).toBeTruthy();
    expect(getByText("Latest 3 only")).toBeTruthy();
    expect(getByLabelText("recency river")).toBeTruthy();
  });

  test("rendered row membership follows the model's column population and uses measured content height", async () => {
    const { container } = render(SwitchRoom, { shell: makeShell() });
    const rows = [...container.querySelectorAll<HTMLElement>(".conversation-row")];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.querySelectorAll('.reel').length).toBeLessThanOrEqual(Number(row.style.getPropertyValue('--cap-columns')));
      expect(row.style.height, "content cannot be cropped to the initial height estimate").toBe("");
    }
    const indices = [...container.querySelectorAll<HTMLElement>('[data-reel-index]')].map(e => Number(e.dataset.reelIndex));
    expect(indices).toEqual(Array.from({ length: indices.length }, (_, i) => i));
  });

  test("counts line states the measured shape of the workspace", () => {
    const { getByText } = render(SwitchRoom, { shell: makeShell() });
    expect(getByText(/3 projects · 5 conversations/)).toBeTruthy();
  });

  test("empty projects retain a deliberate action menu without repeated creation controls", async () => {
    const { findByText, container } = render(SwitchRoom, { shell: makeShell() });
    const name = await findByText("empty-shell");
    const group = name.closest('.group')!;
    expect(group.querySelectorAll('button')).toHaveLength(2);
    expect(group.querySelector('[data-verb-id="switch.open-project"]')).not.toBeNull();
    expect(group.querySelector('[data-verb-id="switch.cap-new-conversation"]')).toBeNull();
    await projectMenu(container, 'empty-shell');
    expect(container.querySelector('[data-verb-id="switch.cap-new-conversation"]')).not.toBeNull();
    const details = container.querySelector('[data-disclosure="switch-project-details"] button')!;
    if (details.getAttribute('aria-expanded') !== 'true') await fireEvent.click(details);
    expect(container.querySelector('.project-folder')?.textContent).toContain(P3.path);
  });

  test("the legend teaches the key that actually fires on this platform", async () => {
    // Zero-knowledge law: jsdom is a non-mac platform, the chords fire on
    // Ctrl — the legend must spell Ctrl, and the mac glyph must be absent
    // from the whole rendered room. Replay is named only once a recorded
    // start exists (c1's pulse); until then the legend does not teach it.
    const { container, getByText } = render(SwitchRoom, { shell: makeShell() });
    await optionsAction(container, "switch.shortcuts");
    await waitFor(() => {
      expect(
        getByText("Enter resume · Shift+Enter replay · Ctrl+N + conversation · Ctrl+Shift+N + project"),
      ).toBeTruthy();
    });
    expect(container.textContent).not.toContain("⌘");
  });

  test("the legend omits replay when no conversation has a recorded start", async () => {
    setSwitchReaders({
      chats: async () => [],
      pulse: async () => NO_RUNS_PULSE,
      spectrum: async () => EMPTY_SPECTRUM,
    });
    const { container, getByText, queryByText } = render(SwitchRoom, { shell: makeShell() });
    await optionsAction(container, "switch.shortcuts");
    await waitFor(() => {
      expect(
        getByText("Enter resume · Ctrl+N + conversation · Ctrl+Shift+N + project"),
      ).toBeTruthy();
    });
    expect(queryByText(/Shift\+Enter replay/)).toBeNull();
  });

  test("each project is a full-width shelf; order = DOM order (mechanical)", async () => {
    // jsdom computes no layout, so the mechanical test is at the source:
    // the river is a column of shelves and each group takes the river's
    // width. Reading order stays the session-stable cap order because
    // stacking follows DOM order (asserted on the render).
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/cockpit/rooms/SwitchRoom.svelte", "utf8");
    const style = src.slice(src.indexOf("<style"), src.indexOf("</style>"));
    const riverRule = /\.river\s*\{[^}]*\}/.exec(style)?.[0] ?? "";
    expect(riverRule).toMatch(/display:\s*flex;/);
    expect(riverRule).toMatch(/flex-direction:\s*column;/);
    const groupRule = /\.group\s*\{[^}]*\}/.exec(style)?.[0] ?? "";
    expect(groupRule).toMatch(/width:\s*100%;/);

    const { container, findByText } = render(SwitchRoom, { shell: makeShell() });
    await findByText("empty-shell");
    const groups = [...container.querySelectorAll(".group")];
    expect(groups.length).toBe(3);
    // Conversation-holding caps first (recency), then compact empty caps.
    // c5 in p2 at 500ms ago beats c1 in p1 at 1000ms ago; empty-shell last.
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual([
      "billing",
      "reader-refactor",
      "empty-shell",
    ]);
    const billing = groups[0]!;
    expect(billing.querySelector(".cap-name")?.textContent).toBe("billing");
    expect(billing.querySelector('.cap-path')).toBeNull();
    expect(billing.querySelector('.cap-meta')).toBeNull();
    await projectMenu(container, 'billing');
    const details = container.querySelector('[data-disclosure="switch-project-details"] button')!;
    if (details.getAttribute('aria-expanded') !== 'true') await fireEvent.click(details);
    expect(container.querySelector('.project-folder')?.textContent).toContain(P2.path);
  });
});

describe("honest reel states (MUTATION: absence removed → these fail)", () => {
  test("measured pulse renders its own line; a known runless chat keeps a quiet baseline", async () => {
    const { findByText, findAllByText } = render(SwitchRoom, { shell: makeShell() });
    expect(await findByText("3 runs · 6 files · no errors")).toBeTruthy();
    await waitFor(() => expect(document.querySelector(".reel.empty-conversation")).not.toBeNull());
    const empty = document.querySelector(".reel.empty-conversation")!;
    expect(empty.querySelector(".name")?.textContent).toBeTruthy();
    expect(empty.querySelector(".when")?.textContent).toBeTruthy();
    expect(empty.querySelector(".outcome")).toBeNull();
    expect(empty.querySelector(".micro")).toBeNull();
  });

  test("deliberate conversation inspection retains the empty ledger explanation", async () => {
    const { container, findByText } = render(SwitchRoom, { shell: makeShell() });
    const reel = [...container.querySelectorAll('.reel')].find(e => e.querySelector('.name')?.textContent === 'invoices')!;
    await fireEvent.click(reel.querySelector('[data-verb-id="switch.conversation-details"]')!);
    expect(await findByText("no events recorded")).toBeTruthy();
  });

  test("a refused pulse renders as absence, not an error wall", async () => {
    resetSwitchFeed();
    setSwitchReaders({
      chats: async () => [],
      pulse: async () => {
        const { ClientError } = await import("../../src/data/errors.ts");
        throw new ClientError("forbidden", "no", 403);
      },
      spectrum: async () => EMPTY_SPECTRUM,
    });
    const { findAllByText, container } = render(SwitchRoom, { shell: makeShell() });
    expect((await findAllByText("not available to this session")).length).toBeGreaterThan(0);
    expect(container.textContent).not.toMatch(/error:|Error:|failed/i);
  });

  test("custody badge: measured attributed counts render; everything else badges NOTHING", async () => {
    // MEASURED: the feed's decoded custody.state attributes 2 files to c1.
    resetCustodyFeed();
    setCustodyReaders({
      // Only p1 holds work; every other project answers the honest empty
      // state (a shared fixture would double-count c1 across projects).
      state: async (projectId: string) =>
        projectId !== "p1"
          ? {
              repository: true, branch: "main", parcels: [],
              join: {
                changedFiles: 0, attributedFiles: 0, filesBeyondPathCap: 0,
                fileEffectEventsExamined: 0, undecodableEffects: 0,
                truncated: false, withheldRuns: 0,
              },
            }
          : ({
        repository: true,
        branch: "main",
        parcels: [
          {
            id: "run-x",
            attribution: {
              kind: "conversation", runId: "run-x", chatId: "c1",
              chatTitle: "fix the parser", turn: 2, requestText: "fix it",
              lastTouchedAt: iso(100),
            },
            files: [
              { path: "a.ts", state: "changed", insertions: 3, deletions: 1 },
              { path: "b.ts", state: "changed", insertions: 1, deletions: 0 },
            ],
            insertions: 4, deletions: 1, derivation: "t",
          },
          {
            // The outside bucket must badge NO reel.
            id: "outside",
            attribution: { kind: "outside", reason: "not recorded" },
            files: [{ path: "n.md", state: "changed", insertions: 1, deletions: 1 }],
            insertions: 1, deletions: 1, derivation: "t",
          },
        ],
        join: {
          changedFiles: 3, attributedFiles: 2, filesBeyondPathCap: 0,
          fileEffectEventsExamined: 5, undecodableEffects: 0, truncated: false,
          withheldRuns: 0,
        },
      }),
    });
    const { container, findByTitle } = render(SwitchRoom, { shell: makeShell() });
    const badge = await findByTitle(/2 changed files from this conversation/);
    expect(badge.textContent).toBe("Δ2");
    // Exactly ONE reel badges: c1. No other reel fabricates custody.
    expect(container.querySelectorAll(".custody").length).toBe(1);
  });

  test("custody badge is ABSENT when the read is refused (MUTATION: a placeholder badge fails here)", async () => {
    resetCustodyFeed();
    setCustodyReaders({
      state: async () => {
        const { ClientError } = await import("../../src/data/errors.ts");
        throw new ClientError("forbidden", "no", 403);
      },
    });
    const { container, findByText } = render(SwitchRoom, { shell: makeShell() });
    // Give the rejected read a tick to settle into absence.
    await findByText("fix the parser");
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelectorAll(".custody").length).toBe(0);
  });
});

describe("type-to-filter", () => {
  test("narrows across conversation and project names; Esc clears before closing", async () => {
    const shell = makeShell();
    const { getByLabelText, queryByText, getByText } = render(SwitchRoom, { shell });
    const input = getByLabelText("filter projects and conversations") as HTMLInputElement;

    await fireEvent.input(input, { target: { value: "parser" } });
    expect(getByText("fix the parser")).toBeTruthy();
    expect(queryByText("invoices")).toBeNull();
    expect(queryByText("second pass")).toBeNull();

    await fireEvent.input(input, { target: { value: "billing" } });
    expect(getByText("invoices")).toBeTruthy();
    expect(queryByText("fix the parser")).toBeNull();

    key(input, { key: "Escape" });
    await waitFor(() => expect(input.value).toBe(""));
    expect(shell.closed()).toBe(0); // first Esc cleared; the shell was not asked

    key(input, { key: "Escape" });
    expect(shell.closed()).toBe(0); // unconsumed — the SHELL owns room close
  });

  test("no hits renders the honest empty state", async () => {
    const { getByLabelText, findByText } = render(SwitchRoom, { shell: makeShell() });
    const input = getByLabelText("filter projects and conversations") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "zzz-nope" } });
    expect(await findByText(/nothing named/)).toBeTruthy();
  });
});

describe("verbs — resume, replay (the planted head), ⌘ chords", () => {
  test("clicking a reel resumes: stores set, room closed, history requested", async () => {
    const shell = makeShell();
    const { getByText } = render(SwitchRoom, { shell });
    await fireEvent.click(getByText("invoices"));
    expect(currentProjectId.get()).toBe("p2");
    expect(currentChatId.get()).toBe("c5");
    expect(shell.closed()).toBe(1);
    await waitFor(() => {
      const fetchFn = globalThis.fetch as ReturnType<typeof vi.fn>;
      expect(fetchFn.mock.calls.some(([u]) => String(u).includes("/chats/c5/history"))).toBe(true);
    });
  });

  test("replay through the conversation menu plants the measured start", async () => {
    const shell = makeShell();
    const { container, findByText } = render(SwitchRoom, { shell });
    await findByText("3 runs · 6 files · no errors");
    await conversationMenu(container, 'fix the parser');
    await fireEvent.click(container.querySelector('[role="menu"] [data-verb-id="switch.replay"]')!);
    expect(sweepHead.get()).toBe(Date.parse(PULSE_START));
    expect(currentChatId.get()).toBe("c1");
    expect(shell.closed()).toBe(1);
  });

  test("a runless conversation menu offers no fabricated replay", async () => {
    const { container } = render(SwitchRoom, { shell: makeShell() });
    await waitFor(() => expect(container.querySelector('.reel.empty-conversation')).not.toBeNull());
    await conversationMenu(container, 'invoices');
    expect(container.querySelector('[role="menu"] [data-verb-id="switch.replay"]')).toBeNull();
    expect(container.querySelector('[role="menu"] [data-verb-id="switch.resume"]')).toBeNull();
    expect(container.querySelector('.reel [data-verb-id="switch.resume"]')).not.toBeNull();
  });

  test("the Switch chord toggles THROUGH THE SHELL's claim stack, not a private listener", async () => {
    const shell = makeShell();
    const { unmount } = render(SwitchRoom, { shell });
    // The room claims the published `switch` target while it is on screen,
    // TRANSIENTLY — the shell's permanent route (open the Switch) must come
    // back the moment this room closes.
    const claim = shell.claims().find((c) => c.target === "switch");
    expect(claim, "the Switch must claim its own chord while open").toBeTruthy();
    expect(claim!.transient).toBe(true);
    claim!.handler({ shift: false });
    expect(shell.closed()).toBe(1);
    unmount();
    expect(shell.released()).toContain("switch");
  });

  test("⌘⇧N opens the folder picker (the room-local chord table)", async () => {
    const shell = makeShell();
    const { findByLabelText, queryByLabelText, container } = render(SwitchRoom, { shell });
    expect(queryByLabelText("new project")).toBeNull();
    key(window, { key: "N", ctrlKey: true, shiftKey: true });
    expect(await findByLabelText("new project")).toBeTruthy();
    // The picker is the first thing on screen — no name field, no typed path.
    expect(container.querySelector('[data-testid="folder-picker"]')).not.toBeNull();
    expect(container.querySelector('input[name="project-path"]')).toBeNull();
    expect(container.querySelector('form[aria-label="new project"]')).toBeNull();
    expect(container.querySelector('input[name="project-name"]')).toBeNull();
  });

  test("the happy path has no leftover name+create form (picker stays the surface)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/cockpit/rooms/SwitchRoom.svelte", "utf8");
    expect(src).not.toMatch(/form class="new-project"/);
    expect(src).not.toMatch(/name="project-name"/);
    const pick = src.slice(
      src.indexOf("function pickProjectPath"),
      src.indexOf("function abandonCreate"),
    );
    expect(pick).not.toContain("npPicking = false");
    expect(pick).toContain("finishCreateProject");
  });

  test("Enter resumes the top filter hit (roving focus starts at the first reel)", async () => {
    const shell = makeShell();
    const { getByLabelText } = render(SwitchRoom, { shell });
    const input = getByLabelText("filter projects and conversations") as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "invoices" } });
    key(input, { key: "Enter" });
    await waitFor(() => expect(currentChatId.get()).toBe("c5"));
    expect(shell.closed()).toBe(1);
  });
});

// ── Per-project new conversation + the missing-folder surface ────────────
//
// The user's report: "a project can have multiple chats — the create button
// belongs beside EACH project." There is no page-level [new conversation];
// a per-cap control creates in THAT project. The chord (⌘N) and every
// per-cap button land in the same owner (`startConversation`) — the only
// difference is which project id they bring. The folder presence is read
// from the project row the server sent (never probed per-render).

describe("central creation and contextual project actions", () => {
  test("pending creation cannot dispatch twice and past-view menus retain only the readable project action", async () => {
    const shell=makeShell();let release!: (response:Response)=>void;let writes=0;
    const base=globalThis.fetch;
    vi.stubGlobal('fetch',vi.fn((input:RequestInfo|URL,init?:RequestInit)=>{
      if(init?.method==='POST'&&String(input).endsWith('/projects/p2/chats')){writes++;return new Promise<Response>(resolve=>{release=resolve});}
      return base(input,init);
    }));
    const {container}=render(SwitchRoom,{shell});
    await fireEvent.click(container.querySelector('[data-verb-id="switch.create-menu"]')!);
    await fireEvent.click(container.querySelector('[data-room-chord="switch.new-conversation"]')!);
    expect(writes).toBe(1);
    key(window,{key:'n',ctrlKey:true});
    expect(writes).toBe(1);
    expect(container.querySelector<HTMLButtonElement>('[data-verb-id="switch.create-menu"]')!.disabled).toBe(true);
    await projectMenu(container,'billing');
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(container.querySelector('.project-folder')?.textContent).toContain(P2.path);
    expect(container.querySelector('.group [data-verb-id="switch.open-project"]')).not.toBeNull();
    await fireEvent.keyDown(container.querySelector('.popover')!,{key:'Escape'});
    release(new Response(JSON.stringify({...CHATS[4]!,id:'new-owned-chat',projectId:'p2'}),{status:200,headers:{'Content-Type':'application/json'}}));
    await waitFor(()=>expect(currentChatId.get()).toBe('new-owned-chat'));
    expect(shell.closed()).toBe(1);
    sweepHead.set(T);
    await waitFor(()=>expect(container.querySelector<HTMLButtonElement>('[data-verb-id="switch.create-menu"]')!.disabled).toBe(true));
    await projectMenu(container,'billing');
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(container.querySelector('.project-folder')?.textContent).toContain(P2.path);
    expect(container.querySelector('.group [data-verb-id="switch.open-project"]')).not.toBeNull();
    expect(writes).toBe(1);
  });
  test("central New names the focused project and creates there once", async () => {
    const { container, findByText } = render(SwitchRoom, { shell: makeShell() });
    const title = await findByText('fix the parser');
    title.closest<HTMLButtonElement>('.reel-open')!.focus();
    await fireEvent.click(container.querySelector('[data-verb-id="switch.create-menu"]')!);
    const entry = container.querySelector<HTMLButtonElement>('[role="menu"] [data-room-chord="switch.new-conversation"]')!;
    expect(entry.textContent).toBe('New conversation in reader-refactor');
    expect(container.querySelector('.cap [data-verb-id="switch.cap-new-conversation"]')).toBeNull();
    await fireEvent.click(entry);
    await waitFor(() => {
      const posts = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([,init]) => (init as RequestInit)?.method === 'POST').map(([u]) => String(u));
      expect(posts.filter(u => /\/api\/projects\/p1\/chats/.test(u))).toHaveLength(1);
      expect(posts.some(u => /\/api\/projects\/p2\/chats/.test(u))).toBe(false);
    });
  });

  test.each([
    ["fix the parser", "north/service", "p1"],
    ["invoices", "south/service", "p2"],
  ])("central New distinguishes same-name destination for %s", async (title, hint, projectId) => {
    setProjects([{ ...P1, name: "Service", path: "/work/north/service" }, { ...P2, name: "Service", path: "/work/south/service" }, P3]);
    const { container, findByText } = render(SwitchRoom, { shell: makeShell() });
    (await findByText(title)).closest<HTMLButtonElement>(".reel-open")!.focus();
    await fireEvent.click(container.querySelector('[data-verb-id="switch.create-menu"]')!);
    const entry = container.querySelector<HTMLButtonElement>('[role="menu"] [data-room-chord="switch.new-conversation"]')!;
    expect(entry.textContent).toBe(`New conversation in Service · ${hint}`);
    await fireEvent.click(entry);
    await waitFor(() => {
      const posts = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([,init]) => (init as RequestInit)?.method === "POST").map(([u]) => String(u));
      expect(posts.filter(u => u.endsWith(`/api/projects/${projectId}/chats`))).toHaveLength(1);
      expect(posts.filter(u => /\/api\/projects\/[^/]+\/chats$/.test(u))).toHaveLength(1);
    });
  });

  test("the in-row control and the ⌘N chord share ONE create path (no second writer)", async () => {
    // Structural: the chord handler and the in-row handler both land in the
    // same function — a second createChat path would drift (the defect the
    // user reported: a button that does nothing because it was wired to a
    // DIFFERENT, inert handler).
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/cockpit/rooms/SwitchRoom.svelte", "utf8");
    // The in-row control calls newChatIn; newChatIn calls startConversation;
    // the chord's newConversation also calls startConversation. Exactly one
    // createChat call site exists in the room.
    const createCalls = src.match(/\bcreateChat\s*\(/g) ?? [];
    expect(createCalls.length).toBe(1);
    expect(src).toMatch(/function\s+newChatIn[\s\S]*?startConversation\s*\(/);
    expect(src).toMatch(/function\s+newConversation[\s\S]*?startConversation\s*\(/);
  });

  test("one visible New exposes both chord capabilities; options retain the recycle bin", async () => {
    const { container } = render(SwitchRoom, { shell: makeShell() });
    expect(container.querySelectorAll('[data-verb-id="switch.create-menu"]')).toHaveLength(1);
    expect(container.querySelector('[data-room-chord]')).toBeNull();
    await fireEvent.click(container.querySelector('[data-verb-id="switch.create-menu"]')!);
    for (const [id, chord] of [['switch.new-conversation','Ctrl+N'],['switch.new-project','Ctrl+Shift+N']]) {
      const entry = container.querySelector<HTMLButtonElement>('[data-room-chord="'+id+'"]')!;
      expect(entry.tagName).toBe('BUTTON'); expect(entry.title).toContain(chord);
    }
    await fireEvent.keyDown(container.querySelector('.popover')!, { key: 'Escape' });
    await optionsAction(container, 'switch.recycle-bin');
    expect(container.querySelector('[aria-label="recycle bin"]')).not.toBeNull();
  });

  test("recycle bin opens as an empty honest absence", async () => {
    const { findByText, getByRole, container } = render(SwitchRoom, { shell: makeShell() });
    await optionsAction(container, "switch.recycle-bin");
    expect(await findByText("recycle bin is empty")).toBeTruthy();
    expect(container.querySelector('[aria-label="recycle bin"]')).not.toBeNull();
    expect(container.querySelector(".popover")).not.toBeNull();
  });

  test("recycling a project needs a second press after settle", async () => {
    const { container, findByText } = render(SwitchRoom, { shell: makeShell() });
    await findByText("billing");
    vi.useFakeTimers();
    try {
      const billing = [...container.querySelectorAll(".group")].find(
        (g) => g.getAttribute("aria-label") === "billing",
      )!;
      await projectMenu(container, "billing");
      const btn = container.querySelector<HTMLButtonElement>('[data-verb-id="switch.cap-trash"]')!;
      const deletes = (): string[] =>
        (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
          .filter(([, init]) => String((init as RequestInit | undefined)?.method ?? "").toUpperCase() === "DELETE")
          .map(([u]) => String(u));
      await fireEvent.click(btn);
      expect(deletes()).toEqual([]);
      expect(btn.isConnected, "the menu action yields to the owned confirmation").toBe(false);
      const confirm = container.querySelector<HTMLButtonElement>('[data-verb-id="switch.recycle-confirm"]');
      expect(confirm).not.toBeNull();
      await vi.advanceTimersByTimeAsync(400);
      await fireEvent.click(confirm!);
      await waitFor(() => {
        expect(deletes().some((u) => /\/api\/projects\/p2/.test(u))).toBe(true);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  // ── THE ARMED POPOVER'S COPY (UIE-050a) ──────────────────────────────────
  //
  // The armed recycle popover used to print "it goes to the recycle bin"
  // twice — once inside the arm sentence, once as the confirm line's opening
  // clause. A decision surface that repeats its threat reads as a nag, and
  // the second copy added no fact the first did not carry. The arm sentence
  // (recycleArmedTitle — the SAME string the reel verb and the confirm
  // button's title carry) states the move exactly once; the second line
  // carries only the recovery.
  test("the armed popover states the bin sentence ONCE, and the recovery separately", async () => {
    const { container, findByText } = render(SwitchRoom, { shell: makeShell() });
    await findByText("billing");
    const billing = [...container.querySelectorAll(".group")].find(
      (g) => g.getAttribute("aria-label") === "billing",
    )!;
    await projectMenu(container, "billing");
    await fireEvent.click(container.querySelector<HTMLButtonElement>('[data-verb-id="switch.cap-trash"]')!);
    const popover = container.querySelector(".popover") as HTMLElement;
    expect(popover).not.toBeNull();
    const text = popover.textContent ?? "";
    const occurrences = text.match(/it goes to the recycle bin/g)?.length ?? 0;
    expect(occurrences, `the bin clause appears exactly once:\n${text}`).toBe(1);
    // The recovery fact still stands on its own line.
    expect(text).toContain("restore it from the bin");
  });

  // ── THE ROOM FOCUS GRAMMAR (UIE-051) ─────────────────────────────────────
  //
  // The convention, pinned per room: a room WITH a primary input lands
  // focus in it on open (the Switch's whole job is finding a conversation —
  // the filter IS the interaction); a room with NO input takes no focus at
  // all (see custody/instruments — their suites carry the other half). The
  // grammar's own note lives in the drive playbook.
  test("opening the Switch lands focus in its primary input — the filter", async () => {
    const { container, findByText } = render(SwitchRoom, { shell: makeShell() });
    await findByText("billing");
    const filter = container.querySelector<HTMLInputElement>(".filter")!;
    expect(document.activeElement).toBe(filter);
  });

  test("binProject / binChat share the recycle-confirm door", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/cockpit/rooms/SwitchRoom.svelte", "utf8");
    expect(src.match(/\bdeleteProject\s*\(/g)?.length).toBe(1);
    expect(src.match(/\bdeleteChat\s*\(/g)?.length).toBe(1);
    expect(src).toMatch(/function\s+binProject[\s\S]*?startRecycle/);
    expect(src).toMatch(/function\s+binChat[\s\S]*?startRecycle/);
    expect(src).toMatch(/function\s+confirmArmedBin[\s\S]*?takeRecyclePress/);
  });
});

describe("the missing-folder surface", () => {
  const P_GONE = { id: "pg", name: "gone-project", path: "/tmp/wiped-away", createdAt: iso(9000), updatedAt: iso(100), folder: "missing" as const };

  test("a project whose folder is missing wears the badge + a relink verb", async () => {
    setProjects([P1, P_GONE]);
    const { container, findByText } = render(SwitchRoom, { shell: makeShell() });
    // The missing project has no conversations — filter it into view.
    const input = container.querySelector<HTMLInputElement>(".filter")!;
    await fireEvent.input(input, { target: { value: "gone-project" } });
    await findByText("this project's folder is missing");
    const cap = [...container.querySelectorAll(".group")].find(
      (g) => g.getAttribute("aria-label") === "gone-project",
    )!;
    expect(cap.querySelector('[data-verb-id="switch.relink"]')).not.toBeNull();
  });

  test("a project whose folder is present shows NO badge (the badge is not decorative)", async () => {
    setProjects([{ ...P1, folder: "present" as const }]);
    const { container, findByText } = render(SwitchRoom, { shell: makeShell() });
    await findByText("reader-refactor");
    expect(container.textContent).not.toContain("folder is missing");
    expect(container.querySelector('[data-verb-id="switch.relink"]')).toBeNull();
  });

  test("relink opens the picker and PATCHes the project to the picked folder", async () => {
    setProjects([P_GONE]);
    const patches: { url: string; body: unknown }[] = [];
    const base = globalThis.fetch as typeof fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "PATCH" && /\/api\/projects\//.test(url)) {
        patches.push({ url, body: init?.body !== null && init?.body !== undefined ? JSON.parse(String(init.body)) : undefined });
        return new Response(
          JSON.stringify({ id: "pg", name: "gone-project", path: (patches[patches.length - 1]!.body as { path: string }).path, createdAt: iso(9000), updatedAt: iso(0), folder: "present" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/api/filesystem/roots")) {
        return new Response(JSON.stringify({ roots: [{ label: "work", path: "/work" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/api/filesystem/list")) {
        return new Response(JSON.stringify({ path: "/work", parent: null, accessible: true, entries: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return base(input, init);
    }));
    const shell = makeShell();
    const { container, findByText } = render(SwitchRoom, { shell });
    const input = container.querySelector<HTMLInputElement>(".filter")!;
    await fireEvent.input(input, { target: { value: "gone-project" } });
    await findByText("this project's folder is missing");
    container.querySelector<HTMLButtonElement>('[data-verb-id="switch.relink"]')!.click();
    // The picker opens; choose the listed root and confirm.
    await waitFor(() => expect(container.querySelector('[role="treeitem"]')).not.toBeNull());
    container.querySelector<HTMLButtonElement>('[role="treeitem"]')!.click();
    await waitFor(() =>
      expect(container.querySelector<HTMLButtonElement>('[data-verb-id="picker.choose"]')!.disabled).toBe(false),
    );
    container.querySelector<HTMLButtonElement>('[data-verb-id="picker.choose"]')!.click();
    await waitFor(() => {
      expect(patches.some((p) => /\/api\/projects\/pg$/.test(p.url) && (p.body as { path: string }).path === "/work")).toBe(true);
    });
  });
});


test("one reel payload updates its keyed display without rebuilding the river window or reading other reel values", async () => {
  seed();
  render(SwitchRoom, { shell: makeShell() });
  await vi.waitFor(() => expect(feedActiveCount()).toBe(0));
  const waiting: Array<(value: unknown) => void> = [];
  setSwitchReaders({
    pulse: () => new Promise(resolve => waiting.push(resolve)),
    spectrum: () => new Promise(resolve => waiting.push(resolve)),
  });
  requestReelData("c1", true);
  expect(waiting).toHaveLength(2);
  const window = vi.spyOn(SwitchRiver.prototype, "window");
  const outcomes = vi.spyOn(outcomeStates, "get");
  const densities = vi.spyOn(densityStates, "get");
  try {
    waiting[0]!({ ...MEASURED_PULSE, runs: { known: 4, withEvents: 4 } });
    waiting[1]!(EMPTY_SPECTRUM);
    await vi.waitFor(() => expect(feedActiveCount()).toBe(0));
    expect(document.body.textContent).toContain("4 runs");
    expect(window).not.toHaveBeenCalled();
    expect(outcomes.mock.calls.every(([id]) => id === "c1")).toBe(true);
    expect(densities.mock.calls.every(([id]) => id === "c1")).toBe(true);
  } finally { window.mockRestore(); outcomes.mockRestore(); densities.mockRestore(); }
});
