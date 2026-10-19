// @vitest-environment jsdom
/**
 * THE CUSTODY ROOM — live in jsdom (spec §7.2).
 *
 * What must hold on screen:
 *   - instant open, absence-first: the room paints its honest "reading…"
 *     states before any read answers (<200ms law — measured render);
 *   - work parcels grouped by producing conversation, the outside bucket
 *     LAST with its honest reason; every ± is the wire's measured number;
 *   - `keep` opens ONE inline line — the suggestion QUOTED from the
 *     producing turn's words, labeled, editable — and ⏎ posts the real
 *     block action with the parcel's files and the edited message;
 *   - `undo` arms an inline confirmation stating the MEASURED loss and only
 *     the second press posts the action; new files are never offered;
 *   - the empty state says "nothing changed since the last save";
 *   - SAVED WORK joins each save to its conversation (click → the
 *     conversation opens) or states "no recorded conversation"; `see` shows
 *     `<hash>^!` in the room's own difference pane;
 *   - `see` renders BESIDE the list on one continuous surface — never as a
 *     raised sheet over it — and the list does not move when it does.
 */
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";

import CustodyRoom from "../../src/cockpit/rooms/CustodyRoom.svelte";
import DiffSheet from "../../src/cockpit/rooms/DiffSheet.svelte";
import {
  resetCustodyFeed,
  setCustodyReaders,
} from "../../src/cockpit/rooms/custody-feed.ts";
import {
  bindShellVisibility,
  setVisibleRoom,
} from "../../src/cockpit/shell/room-visibility.ts";
import { resetProjects, selectProject, setProjects } from "../../src/state/projects.ts";
import { currentChatId, resetChats, setChats } from "../../src/state/chats.ts";
import { resetTimeline } from "../../src/state/timeline-query.ts";
import { resetTimelineRefs } from "../../src/state/timeline-refs.ts";
import { clearCache } from "../../src/data/broker.ts";
import { ClientError } from "../../src/data/errors.ts";
import { PAST_VIEW_ACT_REASON, plantHead, returnToLive } from "../../src/data/asof.ts";
import { UNDO_CONFIRM_SETTLE_MS } from "../../src/cockpit/rooms/custody-config.ts";
import { wholeConversationPage } from "../helpers/history-page.ts";
import type {
  DismissRequest,
  ScopeRequest,
  ShellApi,
} from "../../src/cockpit/shell/contract.ts";

const P1 = {
  id: "p1",
  name: "reader-refactor",
  path: "/tmp/p1",
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-25T00:00:00Z",
};

const STATE = {
  repository: true,
  branch: "main",
  parcels: [
    {
      id: "run-1",
      attribution: {
        kind: "conversation",
        runId: "run-1",
        chatId: "c1",
        chatTitle: "fix flaky test",
        turn: 7,
        requestText: "refactor the reader path",
        lastTouchedAt: "2026-07-25T14:02:00Z",
      },
      files: [
        { path: "src/reader.ts", state: "changed", insertions: 42, deletions: 8 },
        { path: "src/broker.ts", state: "changed", insertions: 11, deletions: 0 },
        { path: "src/new-file.ts", state: "new", insertions: null, deletions: null, countsAbsentReason: "new file" },
      ],
      insertions: 53,
      deletions: 8,
      derivation: "t",
    },
    {
      id: "outside",
      attribution: {
        kind: "outside",
        reason: "these changes are not attributed to any recorded conversation",
      },
      files: [{ path: "notes.md", state: "changed", insertions: 2, deletions: 0 }],
      insertions: 2,
      deletions: 0,
      derivation: "t",
    },
  ],
  join: {
    changedFiles: 4,
    attributedFiles: 3,
    filesBeyondPathCap: 0,
    fileEffectEventsExamined: 6,
    undecodableEffects: 0,
    truncated: false,
    withheldRuns: 0,
  },
};

const HISTORY = {
  repository: true,
  remoteConfigured: false,
  commits: [
    {
      hash: "a".repeat(40),
      shortHash: "aaaaaaa",
      message: "reader path refactor",
      author: "ada",
      when: "2026-07-25T13:00:00Z",
      files: 2,
      insertions: 10,
      deletions: 3,
      filePaths: ["src/reader.ts", "src/broker.ts"],
      conversation: { chatId: "c1", chatTitle: "fix flaky test", overlapFiles: 2, matchedRecords: 4 },
      derivation: "d1",
    },
    {
      hash: "b".repeat(40),
      shortHash: "bbbbbbb",
      message: "base",
      author: "ada",
      when: "2026-07-20T13:00:00Z",
      files: 1,
      insertions: 5,
      deletions: 0,
      filePaths: ["notes.md"],
      conversation: null,
      derivation: "d2",
    },
  ],
};

type Posted = { url: string; body: unknown };

function makeShell(): ShellApi & {
  closed: () => number;
  scopes: () => readonly ScopeRequest[];
  /** Plain-words labels of the dismissal layers registered right now. */
  layers: () => readonly string[];
  /** Run the shell's Esc against this room: dismiss the innermost layer. */
  escape: () => void;
} {
  let closed = 0;
  const scopes: ScopeRequest[] = [];
  const dismissals: DismissRequest[] = [];
  return {
    revealAt: () => 0,
    openRoom: () => {},
    closeRoom: () => {
      closed += 1;
    },
    openScope: (req) => {
      scopes.push(req);
    },
    closeScope: () => {},
    setAnnunciators: () => {},
    setMonitors: () => {},
    claimKey: () => () => {},
    // A miniature of the shell's dismissal ladder (src/cockpit/shell/
    // routing.ts): push on open, release on close, Esc takes the TOP.
    pushDismiss: (req) => {
      dismissals.push(req);
      return () => {
        const at = dismissals.indexOf(req);
        if (at >= 0) dismissals.splice(at, 1);
      };
    },
    hint: () => {},
    composerText: () => "",
    onComposerSubmit: () => () => {},
    prefillComposer: () => {},
    clearComposer: () => {},
    restoreComposerText: () => {},
    onComposerChange: () => () => {},
    setDeskLine: () => {},
    closed: () => closed,
    scopes: () => scopes,
    layers: () => dismissals.map((d) => d.label),
    escape: () => dismissals[dismissals.length - 1]?.dismiss(),
  };
}

/** Fetch stub: block actions answer the uniform envelope; history loads
 * answer enough truth for the store fill. Captures every POST body. */
function stubFetch(posted: Posted[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        posted.push({ url, body: JSON.parse(String(init.body ?? "{}")) });
        return new Response(
          JSON.stringify({ data: { done: true }, meta: { etag: 'W/"1"', asOf: 1 } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (/\/api\/chats\/[^/]+\/history/.test(url)) {
        return new Response(
          JSON.stringify({
            chat: { id: "c1", projectId: "p1", title: "fix flaky test", createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-25T00:00:00Z", modelId: null, pinned: false },
            messages: [], toolCalls: [], metricsSnapshots: [], timelineRefs: [], page: wholeConversationPage(0),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
}

function seedMeasured(): void {
  setCustodyReaders({
    state: async () => STATE,
    history: async () => HISTORY,
  });
}

let posted: Posted[];

/**
 * Svelte's `bind:clientWidth` rides ResizeObserver, which jsdom lacks. An
 * inert observer is the honest stand-in: jsdom boxes report zero geometry
 * anyway, so the room measures 0 and falls to its NARROW arrangement — which
 * is the arrangement most of these tests want, and the split arrangement is
 * measured live in the browser where widths are real.
 */
type ROEntry = { cb: ResizeObserverCallback; el: Element };
const observed: ROEntry[] = [];

class InertResizeObserver {
  #cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.#cb = cb;
  }
  observe(el: Element): void {
    observed.push({ cb: this.#cb, el });
  }
  unobserve(): void {}
  disconnect(): void {}
}

/**
 * Give the room a real measured width. jsdom reports 0 for every box, so the
 * room falls to its NARROW arrangement by default; the tests that are about
 * the SPLIT say so explicitly by calling this.
 */
const NATIVE_CLIENT_WIDTH = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "clientWidth",
);

function setRoomWidth(px: number): void {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get: () => px,
  });
  for (const o of observed) {
    o.cb([{ target: o.el, contentRect: { width: px } } as unknown as ResizeObserverEntry], {} as ResizeObserver);
  }
}

beforeEach(() => {
  cleanup();
  observed.length = 0;
  vi.stubGlobal("ResizeObserver", InertResizeObserver);
  returnToLive();
  posted = [];
  clearCache();
  resetCustodyFeed();
  resetProjects();
  resetChats();
  stubFetch(posted);
  setProjects([P1]);
  setChats([
    { id: "c1", projectId: "p1", title: "fix flaky test", createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-25T00:00:00Z", modelId: null, pinned: false },
  ]);
  selectProject("p1");
});

afterEach(() => {
  vi.unstubAllGlobals();
  // The width override is on a SHARED prototype — restoring it is what keeps
  // a split-width test from silently deciding the next test's arrangement.
  if (NATIVE_CLIENT_WIDTH !== undefined) {
    Object.defineProperty(HTMLElement.prototype, "clientWidth", NATIVE_CLIENT_WIDTH);
  } else {
    // jsdom defines it on Element.prototype; `setRoomWidth` shadows it with
    // an OWN property here, so removing that own property is the restore.
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  }
  returnToLive();
  resetCustodyFeed();
  resetProjects();
  resetChats();
  resetTimeline();
  resetTimelineRefs();
});

describe("instant open, absence-first (<200ms law)", () => {
  test("the room paints honest reading states before any read answers — measured", () => {
    // Readers that never answer: whatever paints, paints from absence.
    setCustodyReaders({
      state: () => new Promise(() => {}),
      history: () => new Promise(() => {}),
    });
    const t0 = performance.now();
    const { getByText } = render(CustodyRoom, { shell: makeShell() });
    const openMs = performance.now() - t0;
    expect(getByText("reading the current work")).toBeTruthy();
    expect(getByText("reading the saved history")).toBeTruthy();
    expect(openMs, `room open took ${openMs}ms`).toBeLessThan(200);
  });

  test("no project open → the honest hint, no fabricated column", () => {
    resetProjects();
    const { getByText } = render(CustodyRoom, { shell: makeShell() });
    expect(getByText(/no project open/)).toBeTruthy();
  });

  // ── THE ROOM FOCUS GRAMMAR (UIE-051) — the other half of the convention ──
  //
  // Custody has NO primary input: it is a read-and-act surface (parcels,
  // verbs, keep forms), so opening it takes NO focus — the reader's focus
  // stays wherever the opening gesture left it, and the room never steals
  // it. The Switch's suite pins the with-input half; this pins the
  // without-input half, and together they are the grammar: rooms with a
  // primary input focus it, rooms without one take nothing.
  test("opening the room takes no focus — an input-less room never steals it", async () => {
    seedMeasured();
    const before = document.activeElement;
    const { findByText } = render(CustodyRoom, { shell: makeShell() });
    await findByText("reading the current work");
    expect(document.activeElement, "focus is where the reader left it").toBe(before);
  });
});

describe("work parcels (§7.2 walkthrough)", () => {
  test("grouped by producing conversation; outside bucket LAST; every ± is the wire's number", async () => {
    seedMeasured();
    const { findByText, container } = render(CustodyRoom, { shell: makeShell() });
    expect(await findByText("from “fix flaky test” · turn 7")).toBeTruthy();
    expect(await findByText("src/reader.ts")).toBeTruthy();
    expect(await findByText("+42 −8")).toBeTruthy();
    expect(await findByText("+11 −0")).toBeTruthy();
    // The new file carries its absence, not a number.
    expect(await findByText("all new")).toBeTruthy();
    // Outside bucket renders, LAST in the parcel order.
    const sections = [...container.querySelectorAll("section.parcel")];
    expect(sections.length).toBe(2);
    expect(sections[1]!.getAttribute("aria-label")).toBe("not from a recorded conversation");
    // The join honesty line is on the header.
    expect(await findByText(/3 of 4 changed files traced to a conversation/)).toBeTruthy();
  });

  test("keep: ONE inline line, suggestion quoted from the request, ⏎ posts the real action", async () => {
    seedMeasured();
    const { findByText, getByLabelText, findAllByText } = render(CustodyRoom, { shell: makeShell() });
    await findByText("from “fix flaky test” · turn 7");
    const keepAll = (await findAllByText("Keep all"))[0]!;
    await fireEvent.click(keepAll);
    // The one line: labeled quotation, editable field prefilled with the words.
    expect(await findByText("from your request:")).toBeTruthy();
    const field = getByLabelText("save message") as HTMLInputElement;
    expect(field.value).toBe("refactor the reader path");
    await fireEvent.input(field, { target: { value: "reader path, refactored" } });
    await fireEvent.submit(field.closest("form")!);
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0]!.url).toMatch(/\/api\/b\/custody\.state\/keep$/);
    expect(posted[0]!.body).toEqual({
      projectId: "p1",
      files: ["src/reader.ts", "src/broker.ts", "src/new-file.ts"],
      message: "reader path, refactored",
    });
  });

  /**
   * The deliberate path through the shield: wait out the settle window,
   * then ARRIVE on the confirm control, then press it. Anything less is
   * refused — which is the subject of the mutation block further down.
   */
  async function reachAndConfirm(button: Element): Promise<void> {
    await new Promise((r) => setTimeout(r, UNDO_CONFIRM_SETTLE_MS + 30));
    await fireEvent.pointerEnter(button);
    await fireEvent.click(button);
  }

  test("undo: armed confirmation states the MEASURED loss; only a deliberate second press posts; new files excluded", async () => {
    seedMeasured();
    const { findByText, findAllByText } = render(CustodyRoom, { shell: makeShell() });
    await findByText("from “fix flaky test” · turn 7");
    const undoAll = (await findAllByText("Undo all"))[0]!;
    await fireEvent.click(undoAll);
    // Exact arithmetic over the two restorable files (the new file has no
    // earlier saved version and is not offered).
    expect(
      await findByText("returns +53 −8 across 2 files to the last saved state"),
    ).toBeTruthy();
    expect(posted.length).toBe(0); // arming performed NOTHING
    await reachAndConfirm(await findByText("really undo"));
    await waitFor(() => expect(posted.length).toBe(1));
    expect(posted[0]!.url).toMatch(/\/api\/b\/custody\.state\/undo$/);
    expect(posted[0]!.body).toEqual({ projectId: "p1", files: ["src/reader.ts", "src/broker.ts"] });
  });

  /**
   * THE ACCIDENTAL PATH IS CLOSED (reported from live verification: a click
   * aimed elsewhere landed in an armed undo confirmation because the row
   * moved under the pointer).
   *
   * Two independent guarantees are asserted here, because either alone can
   * be regressed without the other noticing:
   *   1. arming does not MOVE anything — the file rows keep their exact
   *      offsets, so the click that follows lands where it was aimed;
   *   2. the destructive control refuses every press that is not a
   *      deliberate arrival on it, whatever the geometry did.
   */
  describe("undo cannot be reached by accident", () => {
    test("arming moves NOTHING: every file row keeps its offset", async () => {
      seedMeasured();
      const { findByText, findAllByText, container } = render(CustodyRoom, { shell: makeShell() });
      await findByText("from “fix flaky test” · turn 7");
      const offsets = (): string[] =>
        [...container.querySelectorAll(".parcel .row .path")].map((e) => e.textContent ?? "");
      const before = offsets();
      // jsdom has no layout, so the geometry claim is asserted STRUCTURALLY:
      // the slot the inline line occupies exists BEFORE anything is armed
      // (it is reserved, not inserted) and the row list is untouched after.
      const slotsBefore = container.querySelectorAll(".line-slot").length;
      expect(slotsBefore).toBeGreaterThan(0);
      await fireEvent.click((await findAllByText("Undo all"))[0]!);
      expect(container.querySelectorAll(".line-slot").length).toBe(slotsBefore);
      expect(offsets()).toEqual(before);
    });

    test("a click that arrives with the arm — the mis-click sequence — discards NOTHING", async () => {
      seedMeasured();
      const { findByText, findAllByText } = render(CustodyRoom, { shell: makeShell() });
      await findByText("from “fix flaky test” · turn 7");
      // The reported sequence: a press lands on `undo` unintentionally, and
      // the pointer is already travelling on toward where it was aimed —
      // arriving on the confirmation that has just appeared there.
      await fireEvent.click((await findAllByText("Undo all"))[0]!);
      const confirm = (await findByText("really undo")) as HTMLButtonElement;
      await fireEvent.pointerEnter(confirm);
      await fireEvent.click(confirm);
      await fireEvent.click(confirm);
      expect(posted.length).toBe(0);
      expect(confirm.disabled).toBe(true);
      // …and it SAYS why, rather than refusing in silence.
      expect(
        await findByText("move onto this button to confirm — a stray click cannot discard your work"),
      ).toBeTruthy();
    });

    test("waiting out the settle window is not enough on its own — the pointer must ARRIVE", async () => {
      seedMeasured();
      const { findByText, findAllByText } = render(CustodyRoom, { shell: makeShell() });
      await findByText("from “fix flaky test” · turn 7");
      await fireEvent.click((await findAllByText("Undo all"))[0]!);
      await new Promise((r) => setTimeout(r, UNDO_CONFIRM_SETTLE_MS + 30));
      // No pointerenter/focus: a press from a pointer that was resting on
      // the spot before the control existed is exactly the hazard.
      await fireEvent.click(await findByText("really undo"));
      expect(posted.length).toBe(0);
    });

    test("an arrival recorded BEFORE the settle window does not authorise the press", async () => {
      seedMeasured();
      const { findByText, findAllByText } = render(CustodyRoom, { shell: makeShell() });
      await findByText("from “fix flaky test” · turn 7");
      await fireEvent.click((await findAllByText("Undo all"))[0]!);
      const confirm = await findByText("really undo");
      await fireEvent.pointerEnter(confirm); // lands under a resting pointer
      await new Promise((r) => setTimeout(r, UNDO_CONFIRM_SETTLE_MS + 30));
      await fireEvent.click(confirm);
      expect(posted.length).toBe(0);
      // One real move onto the control afterwards, and it works.
      await fireEvent.pointerMove(confirm);
      await fireEvent.click(confirm);
      await waitFor(() => expect(posted.length).toBe(1));
    });

    test("RE-ARMING onto a different target does not inherit the earlier arrival", async () => {
      seedMeasured();
      const { findByText, findAllByText } = render(CustodyRoom, { shell: makeShell() });
      await findByText("from “fix flaky test” · turn 7");
      // Arm ONE file, reach its confirmation legitimately…
      await fireEvent.click((await findAllByText("Undo"))[0]!);
      await new Promise((r) => setTimeout(r, UNDO_CONFIRM_SETTLE_MS + 30));
      await fireEvent.pointerEnter(await findByText("really undo"));
      // …then arm something ELSE without cancelling first. The confirmation
      // now speaks for a different set of files, so the arrival that
      // authorised the old one must buy nothing here.
      await fireEvent.click((await findAllByText("Undo all"))[0]!);
      await fireEvent.click(await findByText("really undo"));
      expect(posted.length).toBe(0);
    });

    test("a REFUSED undo shows the server's own sentence — it never fails in silence", async () => {
      seedMeasured();
      // The real refusal shape: the block answers 400 with the reason it
      // refused. Nothing about that may be swallowed on the way to the eye.
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          if (init?.method === "POST") {
            return new Response(
              JSON.stringify({
                error: "custody_file_moved",
                message:
                  '"src/reader.ts" was moved here, so the last save holds no file at this path to return to',
              }),
              { status: 400, headers: { "Content-Type": "application/json" } },
            );
          }
          return new Response(JSON.stringify({}), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }),
      );
      const { findByText, findAllByText } = render(CustodyRoom, { shell: makeShell() });
      await findByText("from “fix flaky test” · turn 7");
      await fireEvent.click((await findAllByText("Undo all"))[0]!);
      await reachAndConfirm(await findByText("really undo"));
      const shown = await findByText(/was moved here/);
      expect(shown).toBeTruthy();
      expect(shown.getAttribute("role")).toBe("alert");
    });

    test("cancel disarms, and a fresh arm does not inherit the earlier arrival", async () => {
      seedMeasured();
      const { findByText, findAllByText, findByLabelText, queryByText } = render(CustodyRoom, { shell: makeShell() });
      await findByText("from “fix flaky test” · turn 7");
      await fireEvent.click((await findAllByText("Undo all"))[0]!);
      const confirm = await findByText("really undo");
      await new Promise((r) => setTimeout(r, UNDO_CONFIRM_SETTLE_MS + 30));
      await fireEvent.pointerEnter(confirm);
      await fireEvent.click(await findByLabelText("Cancel"));
      expect(queryByText("really undo")).toBeNull();
      expect(posted.length).toBe(0);
      // Re-arm: the arrival above is stale and buys nothing.
      await fireEvent.click((await findAllByText("Undo all"))[0]!);
      await fireEvent.click(await findByText("really undo"));
      expect(posted.length).toBe(0);
    });
  });

  /**
   * PAST VIEW (§6.2) — custody's writing verbs are off from a view of an
   * earlier instant, and say why on the control. The Broker refuses the
   * write regardless; what is asserted here is that the reader is told
   * BEFORE the click rather than at the door.
   */
  describe("a past view turns the writing verbs off, with the reason on them", () => {
    test("live: keep and undo are real controls", async () => {
      seedMeasured();
      const { findByText, container } = render(CustodyRoom, { shell: makeShell() });
      await findByText("from “fix flaky test” · turn 7");
      const writes = [
        ...container.querySelectorAll<HTMLButtonElement>(
          'button[data-verb-id="custody.state/keep"], button[data-verb-id="custody.state/undo"]',
        ),
      ].filter((b) => !b.classList.contains("unwired"));
      expect(writes.length).toBeGreaterThan(0);
      expect(writes.every((b) => !b.disabled)).toBe(true);
    });

    // MUTATION: a writing verb left ENABLED during a past view fails here.
    test("mutation — with a head planted EVERY writing verb is off", async () => {
      seedMeasured();
      plantHead(1_700_000_000_000);
      const { findByText, container } = render(CustodyRoom, { shell: makeShell() });
      await findByText("from “fix flaky test” · turn 7");
      const writes = [
        ...container.querySelectorAll<HTMLButtonElement>(
          'button[data-verb-id="custody.state/keep"], button[data-verb-id="custody.state/undo"]',
        ),
      ];
      expect(writes.length).toBeGreaterThan(0);
      for (const b of writes) {
        expect(b.disabled, `${b.textContent} must not be actionable`).toBe(true);
        expect(b.getAttribute("title")).toBe(PAST_VIEW_ACT_REASON);
      }
    });

    test("clicking a disabled verb from a past view arms and posts NOTHING", async () => {
      seedMeasured();
      plantHead(1_700_000_000_000);
      const { findByText, findAllByText, queryByText } = render(CustodyRoom, {
        shell: makeShell(),
      });
      await findByText("from “fix flaky test” · turn 7");
      await fireEvent.click((await findAllByText("Undo all"))[0]!);
      expect(queryByText("really undo"), "nothing may arm from a past view").toBeNull();
      await fireEvent.click((await findAllByText("Keep all"))[0]!);
      expect(queryByText("⏎ save")).toBeNull();
      expect(posted.length).toBe(0);
    });

    test("SEE stays available — a past view is readable", async () => {
      seedMeasured();
      plantHead(1_700_000_000_000);
      const shell = makeShell();
      const { findByText, findAllByText } = render(CustodyRoom, { shell });
      await findByText("src/reader.ts");
      const see = (await findAllByText("See"))[0]! as HTMLButtonElement;
      expect(see.disabled).toBe(false);
      await fireEvent.click(see);
      expect(await findByText("src/reader.ts — what changed")).toBeTruthy();
    });
  });

  test("per-file see shows that file's difference IN the room, never as a SCOPE", async () => {
    seedMeasured();
    const shell = makeShell();
    setRoomWidth(1600);
    const { findByText, findAllByText, container } = render(CustodyRoom, { shell });
    await findByText("src/reader.ts");
    // Split: the pane is there BEFORE anything is selected — that is what
    // makes the list unable to move when a difference opens.
    expect(container.querySelector(".look")).not.toBeNull();
    expect(await findByText(/select a file's SEE/)).toBeTruthy();
    await fireEvent.click((await findAllByText("See"))[0]!);
    // Shown here, not handed to the shell as a raised sheet over the list.
    expect(shell.scopes().length, "the difference must not open as a SCOPE").toBe(0);
    expect(await findByText("src/reader.ts — what changed")).toBeTruthy();
    expect(container.querySelector(".look .diff-sheet")).not.toBeNull();
  });

  /**
   * NO LAYOUT SHIFT. jsdom has no layout engine, so the pixels are measured
   * in the browser; what is pinned HERE is the structure that makes the
   * pixels impossible to move:
   *   - the pane exists before anything is selected, so it never ARRIVES;
   *   - the list's own nodes are untouched across open → switch → close;
   *   - the column's width is declared as a fixed basis, never `flex: 1`,
   *     so it cannot be computed from what the difference left over.
   */
  describe("opening a difference cannot move the list", () => {
    test("the list's rows survive open → switch → close, identical and in order", async () => {
      seedMeasured();
      setRoomWidth(1600);
      const { findByText, findAllByText, container } = render(CustodyRoom, {
        shell: makeShell(),
      });
      await findByText("src/reader.ts");
      const rows = (): string[] =>
        [...container.querySelectorAll(".board .parcel .row .path")].map(
          (e) => e.textContent ?? "",
        );
      const before = rows();
      expect(before.length).toBeGreaterThan(1);
      const sees = await findAllByText("See");
      await fireEvent.click(sees[0]!);
      expect(rows(), "opening a difference must not touch the list").toEqual(before);
      await fireEvent.click(sees[1]!);
      expect(rows(), "switching files must not touch the list").toEqual(before);
      await fireEvent.click(await findByText("Close"));
      expect(rows(), "closing must not touch the list").toEqual(before);
      expect(await findByText(/select a file's SEE/)).toBeTruthy();
    });

    test("the column's width is a fixed basis, not a share of the remainder", () => {
      const src = readFileSync("src/cockpit/rooms/CustodyRoom.svelte", "utf8");
      const board = /\.board\s*\{([^}]*)\}/.exec(src)?.[1] ?? "";
      expect(board, ".board must declare its own width").toMatch(
        /flex:\s*0\s+0\s+var\(--custody-board-w\)/,
      );
      // `flex: 1` here is the whole defect: the column would then be sized by
      // whatever the difference did not take, and every `see` would move it.
      expect(board).not.toMatch(/flex:\s*1[;\s]/);
    });

    /**
     * ESC CLOSES THE DIFFERENCE, NOT THE ROOM.
     *
     * The shell's escape order used to be `room → scope → claimed`, so one
     * press with a difference open took the whole of Custody with it — the
     * file list, the scroll position and the difference at once. The room now
     * registers the open difference as a dismissal layer
     * (src/cockpit/shell/routing.ts) and the shell closes the innermost layer
     * first, so the room only goes when there is nothing left inside it.
     */
    test("an open difference registers with the shell, and Esc closes IT", async () => {
      seedMeasured();
      setRoomWidth(1600);
      const shell = makeShell();
      const { findByText, findAllByText, container } = render(CustodyRoom, { shell });
      await findByText("src/reader.ts");

      // MUTATION: nothing open, nothing registered — so the press below
      // cannot be passing because the room registers unconditionally.
      expect(shell.layers()).toEqual([]);

      await fireEvent.click((await findAllByText("See"))[0]!);
      expect(shell.layers()).toEqual(["the difference"]);

      shell.escape();
      await waitFor(() => expect(container.querySelector(".diff-sheet, .look .resting")).toBeTruthy());
      // The room was never asked to close, and the list is still there.
      expect(shell.closed()).toBe(0);
      expect(container.querySelector(".board")).not.toBeNull();
      // …and the layer is RELEASED, so the next press is the room's.
      expect(shell.layers()).toEqual([]);
    });

    test("closing the difference by its own control releases the layer too", async () => {
      seedMeasured();
      setRoomWidth(1600);
      const shell = makeShell();
      const { findByText, findAllByText } = render(CustodyRoom, { shell });
      await findByText("src/reader.ts");
      await fireEvent.click((await findAllByText("See"))[0]!);
      expect(shell.layers()).toEqual(["the difference"]);
      await fireEvent.click(await findByText("Close"));
      // An unreleased layer here would leave Esc dismissing a difference that
      // is no longer on screen — a dead keystroke the reader cannot explain.
      await waitFor(() => expect(shell.layers()).toEqual([]));
    });

    test("the difference is NOT a raised sheet — no panel ground, no shadow", () => {
      const src = readFileSync("src/cockpit/rooms/CustodyRoom.svelte", "utf8");
      const look = /\.look\s*\{([^}]*)\}/.exec(src)?.[1] ?? "";
      expect(look, "one hairline in --line-2, nothing more").toMatch(
        /border-left:\s*var\(--hairline-w\)\s+solid\s+var\(--line-2\)/,
      );
      expect(look).not.toMatch(/box-shadow/);
      expect(look).not.toMatch(/background/);
      expect(look).not.toMatch(/border-radius/);
    });
  });

  test("under the split width the difference takes the room and carries the way back", async () => {
    seedMeasured();
    const { findByText, findAllByText, container } = render(CustodyRoom, {
      shell: makeShell(),
    });
    await findByText("src/reader.ts");
    // jsdom measures 0 — the narrow arrangement, where the panes take turns
    // and an EMPTY difference pane never takes one.
    expect(container.querySelector(".look"), "no empty pane stealing the list's room").toBeNull();
    await fireEvent.click((await findAllByText("See"))[0]!);
    expect(container.querySelector(".board"), "no list beside a diff that would not fit").toBeNull();
    const back = await findByText("‹ the list");
    expect(back.getAttribute("title")).toBeTruthy();
    await fireEvent.click(back);
    expect(container.querySelector(".board")).not.toBeNull();
  });

  test("the empty state is honest: nothing changed since the last save", async () => {
    setCustodyReaders({
      state: async () => ({ ...STATE, parcels: [], join: { ...STATE.join, changedFiles: 0, attributedFiles: 0 } }),
      history: async () => HISTORY,
    });
    const { findByText } = render(CustodyRoom, { shell: makeShell() });
    expect(await findByText("nothing changed since the last save")).toBeTruthy();
  });
});

describe("saved work (§7.2 history)", () => {
  test("each save joins to its conversation or states the absence; see opens the save's diff", async () => {
    seedMeasured();
    const shell = makeShell();
    const { findByText, findAllByText } = render(CustodyRoom, { shell });
    expect(await findByText("reader path refactor")).toBeTruthy();
    expect(await findByText("+10 −3")).toBeTruthy();
    expect(await findByText("∴ “fix flaky test”")).toBeTruthy();
    expect(await findByText("no recorded conversation")).toBeTruthy();
    // `see` on the newest save shows exactly that save, in the same pane.
    const sees = await findAllByText("See");
    await fireEvent.click(sees[sees.length - 2]!);
    expect(shell.scopes().length).toBe(0);
    expect(await findByText("saved: reader path refactor")).toBeTruthy();
  });

  test("clicking the joined conversation opens it (stores set, room closes)", async () => {
    seedMeasured();
    const shell = makeShell();
    const { findByText } = render(CustodyRoom, { shell });
    await fireEvent.click(await findByText("∴ “fix flaky test”"));
    expect(currentChatId.get()).toBe("c1");
    expect(shell.closed()).toBe(1);
  });

  test("the diff sheet renders the real patch with counted ±, and honest absence for none", async () => {
    const PATCH = "--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        new Response(
          JSON.stringify({ patch: String(input).includes("file=empty.ts") ? "" : PATCH }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );
    const withDiff = render(DiffSheet, { projectPath: "/tmp/p1", file: "src/reader.ts" });
    expect(await withDiff.findByText("+1")).toBeTruthy();
    expect(await withDiff.findByText("−1")).toBeTruthy();

    // The sheet now lays the patch out as a REAL unified diff (§7.3 via the
    // shared render/UnifiedDiff), so the +/− marker is a gutter cell rather
    // than the first character of a text line — "-old" is no longer a
    // substring of the rendered text. Assert the STRUCTURE instead, which is
    // a stronger claim than the old string match: the removed line's content
    // sits on a row marked as a deletion, the added line's on an addition,
    // and the hunk header is laid out as a hunk.
    await withDiff.findByText("@@ -1,2 +1,2 @@");
    const removed = withDiff.container.querySelector(".diff-del");
    const added = withDiff.container.querySelector(".diff-add");
    expect(removed, "the patch's deletion must render as a deletion row").not.toBeNull();
    expect(added, "the patch's addition must render as an addition row").not.toBeNull();
    expect(removed!.textContent).toContain("old");
    expect(added!.textContent).toContain("new");
    // Context is present and is NOT marked as a change.
    const context = withDiff.container.querySelector(".diff-context");
    expect(context!.textContent).toContain("keep");
    const empty = render(DiffSheet, { projectPath: "/tmp/p1", file: "empty.ts" });
    expect(
      await empty.findByText("no difference to show — the file matches its last saved state"),
    ).toBeTruthy();
  });

  test("a no-repository answer renders the wire's own sentence, never 'matches its last saved state'", async () => {
    // The same wire the effect beat reads: a folder no repository tracks
    // answers an empty patch WITH the typed fact and the door's sentence.
    // The sheet used to read only `.patch` — so the no-repository answer
    // dressed itself in the last-saved-state story, which is false where no
    // save exists at all.
    const REASON =
      "this project's folder is not under version control, so there is no earlier version to show changes against";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ patch: "", repository: false, reason: REASON }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    const sheet = render(DiffSheet, { projectPath: "/tmp/plain", file: "summary.md" });
    expect(await sheet.findByText(REASON)).toBeTruthy();
    expect(sheet.queryByText(/matches its last saved state/)).toBeNull();
  });

  test("no remote configured → NO share affordance at all (§1.2)", async () => {
    seedMeasured();
    const { findByText, queryByText } = render(CustodyRoom, { shell: makeShell() });
    await findByText("reader path refactor");
    expect(queryByText(/share this work/)).toBeNull();
  });
});

describe("a principled refusal reaches the screen as REFUSED (grammar state, server's sentence)", () => {
  test("the git_not_run sentence renders under data-answer=refused, for both reads", async () => {
    const SENTENCE =
      "The unsaved change counts could not be read because this server would not run git: confinement is active";
    setCustodyReaders({
      state: async () => {
        throw new ClientError("git_not_run", SENTENCE, 503);
      },
      history: async () => {
        throw new ClientError("git_not_run", SENTENCE, 503);
      },
    });
    const { container } = render(CustodyRoom, { shell: makeShell() });
    await waitFor(() => {
      const refusedEls = container.querySelectorAll('[data-answer="refused"]');
      expect(refusedEls.length).toBe(2);
      for (const el of refusedEls) expect(el.textContent).toContain(SENTENCE);
    });
    // And never re-dressed as a broken read: no failed answer on screen.
    expect(container.querySelector('[data-answer="failed"]')).toBeNull();
  });
});

describe("staleness (D-class: the world changes outside this client)", () => {
  test("re-showing the room revalidates: a git init made outside is seen on reopen", async () => {
    // The shell publishes visibility; the room holds its feed against it.
    const unbind = bindShellVisibility();
    setVisibleRoom("custody");
    let repo = false;
    const stateCalls: Array<boolean | undefined> = [];
    setCustodyReaders({
      state: async (_id, fresh) => {
        stateCalls.push(fresh);
        return { repository: repo, reason: repo ? undefined : "not a git repository", branch: null, parcels: [], join: { changedFiles: 0, attributedFiles: 0, filesBeyondPathCap: 0, fileEffectEventsExamined: 0, undecodableEffects: 0, truncated: false, withheldRuns: 0 } };
      },
      history: async () => HISTORY,
    });
    const { findByText } = render(CustodyRoom, { shell: makeShell() });
    expect(await findByText("not a git repository")).toBeTruthy();

    // The world changes while the room is hidden…
    setVisibleRoom(null);
    repo = true;
    // …and showing it again is the revalidation gesture.
    setVisibleRoom("custody");
    await waitFor(() => {
      // The re-read was FRESH (cache bypassed), and the measured answer moved.
      expect(stateCalls.some((fresh) => fresh === true)).toBe(true);
    });
    await waitFor(() => {
      expect(document.body.textContent).not.toContain("not a git repository");
    });
    unbind();
  });

  test("the open difference clears on project switch — no stale sheet over the new project", async () => {
    seedMeasured();
    const { container, findAllByText } = render(CustodyRoom, { shell: makeShell() });
    const seeButtons = await waitFor(() => {
      const els = container.querySelectorAll('[data-verb-id="custody.see"]');
      expect(els.length).toBeGreaterThan(0);
      return els;
    });
    await fireEvent.click(seeButtons[0]!);
    // The difference pane is open, titled by the file it shows.
    expect(container.textContent).toContain("what changed");
    expect(container.querySelector(".look-cap")).not.toBeNull();

    // The project switches under the kept-alive room.
    setProjects([
      P1,
      { id: "p2", name: "other", path: "/tmp/p2", createdAt: "2026-07-01T00:00:00Z", updatedAt: "2026-07-25T00:00:00Z" },
    ]);
    selectProject("p2");
    await waitFor(() => {
      expect(container.querySelector(".look-cap")).toBeNull();
    });
    void findAllByText;
  });
});
