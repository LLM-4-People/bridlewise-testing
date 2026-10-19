// @vitest-environment jsdom
/**
 * WHERE EACH TAB WAS READING — the flow's four view locals, and its height
 * index, kept per workspace.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────
 *
 * One Flow component serves every workspace, so its `scrollTop`, `focusedId`,
 * `expanded` and `follow` were shared by all of them. Clicking a tab left you
 * at the previous conversation's pixel offset, with a focus naming a beat
 * that does not exist in the one you opened, and cards unfolded that you
 * never unfolded here. The height index was shared the same way, which is
 * worse than untidy: it is measurements BY POSITION, and position 12 is a
 * different beat in every conversation.
 *
 * ── WHAT IS PINNED HERE ───────────────────────────────────────────────────
 *
 * Two layers. `flow-view.ts` is tested as a unit (which slot a value lands
 * in, which is the whole question), and the component is tested in jsdom for
 * the two claims only a render can make: that a switch PATCHES rather than
 * remounts, and that a measurement taken for one workspace cannot reach
 * another's index.
 *
 * jsdom has no layout and the ResizeObserver is a stub the test drives by
 * hand — which is what makes the index claims sharp: every number here was
 * either declared from a shape or handed in deliberately, so nothing can pass
 * by accident of real measurement.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";

import Flow from "../../src/cockpit/flow/Flow.svelte";
import {
  activateLog,
  appendBeat,
  batch,
  resetAllLogs,
} from "../../src/cockpit/flow/log.ts";
import { resetIngest } from "../../src/cockpit/flow/ingest.ts";
import { clearAllOverrides } from "../../src/cockpit/flow/fisheye.ts";
import { HeightIndex, SHAPE_HEIGHT } from "../../src/cockpit/flow/heights.ts";
import { rendersInFlow } from "../../src/cockpit/flow/beat-state.ts";
import {
  bindFlowView,
  flowViewForActive,
  noteFlowView,
  FLOW_VIEW_DEFAULT,
  SCROLL_KEY,
  EXPANDED_KEY,
  FOCUS_KEY,
  type FlowView,
} from "../../src/cockpit/flow/flow-view.ts";
import {
  activateWorkspace,
  activeWorkspaceId,
  openWorkspace,
  resetWorkspaces,
  workspaceScopedKey,
} from "../../src/state/workspaces.ts";
import { persistTabOnlyGet, persistTabOnlySet } from "../../src/state/persistence.ts";
import type { Beat } from "../../src/cockpit/flow/types.ts";

// ── A controllable ResizeObserver ──────────────────────────────────────────

type Watched = { cb: ResizeObserverCallback; node: Element };
let watched: Watched[] = [];

class RO {
  private readonly cb: ResizeObserverCallback;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
  }
  observe(node: Element): void {
    watched.push({ cb: this.cb, node });
  }
  unobserve(): void {}
  disconnect(): void {}
}

/** The observer armed for the row drawing `beatId` — found by the node it
 * watches, never by call order (the viewport's own observer is in the same
 * list, and the order actions run in is not this test's business). */
function watcherFor(beatId: string): Watched {
  const found = watched.find(
    (w) =>
      // A ROW's observer, not the viewport's — the viewport watches `.flow`,
      // which contains every beat and would match any id asked for.
      w.node.classList.contains("item") &&
      w.node.querySelector(`[data-beat-id="${beatId}"]`) !== null,
  );
  if (found === undefined) throw new Error(`no row observer for "${beatId}"`);
  return found;
}

/** Fire a stored observer with a measured height, as the browser would. */
function reportHeight(w: Watched, px: number): void {
  w.cb(
    [
      {
        target: w.node,
        borderBoxSize: [{ blockSize: px, inlineSize: 0 }],
        contentRect: { height: px } as DOMRectReadOnly,
      } as unknown as ResizeObserverEntry,
    ],
    {} as ResizeObserver,
  );
}

// ── Fixtures ───────────────────────────────────────────────────────────────

function turn(id: string, who: "you" | "model", text: string, turnIndex = 1): Beat {
  return {
    id,
    kind: "turn",
    parentId: null,
    turnIndex,
    at: 1000,
    abnormal: false,
    bleed: false,
    verbs: [],
    turn: { who, text, streaming: false },
  };
}

function toolBeat(id: string, turnIndex = 1): Beat {
  return {
    id,
    kind: "tool",
    parentId: null,
    turnIndex,
    at: 1000,
    abnormal: false,
    bleed: true,
    verbs: [],
    tool: {
      name: "read_file",
      label: "read file",
      status: "done",
      input: { path: "src/x.ts" },
      output: "ok",
      startedAt: 1000,
      durationMs: 4,
    },
  };
}

/** Rendered rows in offset order, with the beat each one draws. */
function rows(container: HTMLElement): { id: string | null; offset: number }[] {
  return [...container.querySelectorAll<HTMLElement>(".item")]
    .map((el) => {
      const m = /translateY\(([-\d.]+)px\)/.exec(el.style.transform);
      return {
        id: el.querySelector("[data-beat-id]")?.getAttribute("data-beat-id") ?? null,
        offset: m === null ? 0 : parseFloat(m[1]!),
      };
    })
    .sort((a, b) => a.offset - b.offset);
}

function view(over: Partial<FlowView> = {}): FlowView {
  return { ...FLOW_VIEW_DEFAULT, ...over };
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  watched = [];
  vi.stubGlobal("ResizeObserver", RO);
  resetIngest();
  resetAllLogs();
  clearAllOverrides();
  resetWorkspaces();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetIngest();
  resetAllLogs();
  clearAllOverrides();
});

// ── A. The four values, per workspace ──────────────────────────────────────

describe("the flow's reading position belongs to one workspace", () => {
  test("two workspaces keep four different values; returning restores all four", () => {
    const a = activeWorkspaceId.get()!;
    noteFlowView(view({ scrollTop: 1240, focusedId: "b-a7", expanded: { "b-a7": true }, follow: false }));

    const b = openWorkspace();
    expect(
      flowViewForActive(),
      "a tab that has never been read has no reading position — not the previous tab's",
    ).toBeNull();
    noteFlowView(view({ scrollTop: 0, focusedId: null, expanded: {}, follow: true }));

    activateWorkspace(a);
    const restored = flowViewForActive()!;
    expect(restored.scrollTop, "the pixel offset").toBe(1240);
    expect(restored.focusedId, "the focused beat — an id that belongs to THIS conversation").toBe("b-a7");
    expect(restored.expanded["b-a7"], "the card you opened").toBe(true);
    expect(restored.follow, "and whether the flow was chasing the tail").toBe(false);

    activateWorkspace(b.id);
    expect(flowViewForActive()!.scrollTop).toBe(0);
    expect(flowViewForActive()!.focusedId).toBeNull();
  });

  test("the switch records the OUTGOING tab's position under the OUTGOING tab's key", () => {
    const a = activeWorkspaceId.get()!;
    const applied: FlowView[] = [];
    const unbind = bindFlowView(
      (v) => applied.push(v),
      () => view({ scrollTop: 900, focusedId: "b-a1", expanded: { "b-a1": true }, follow: false }),
    );

    const b = openWorkspace();
    expect(applied.length, "the incoming tab's view is applied on activation").toBe(1);
    expect(applied[0], "and B has none yet, so it opens at the default").toEqual(FLOW_VIEW_DEFAULT);

    activateWorkspace(a);
    const back = applied[1]!;
    expect(
      back.scrollTop,
      "A's own offset came back — it was filed under A while the atom still said A",
    ).toBe(900);
    expect(back.focusedId).toBe("b-a1");
    unbind();
    expect(b.id).not.toBe(a);
  });

  test("mutation: recording after the atom has moved files it under the INCOMING tab", () => {
    // The trap, written out: `workspaceScopedKey` reads the CURRENT active
    // workspace, so a record taken after the switch names the wrong slot and
    // one tab inherits the other's scroll offset.
    const a = activeWorkspaceId.get()!;
    const keyWhileA = workspaceScopedKey(SCROLL_KEY);
    const b = openWorkspace();
    const keyAfterSwitch = workspaceScopedKey(SCROLL_KEY);
    expect(keyWhileA).toBe(`ws:${a}:${SCROLL_KEY}`);
    expect(
      keyAfterSwitch,
      "the same call, one activation later, names a different tab's slot",
    ).toBe(`ws:${b.id}:${SCROLL_KEY}`);
    expect(keyAfterSwitch).not.toBe(keyWhileA);
  });

  test("the reload mirror holds scroll, expansion and focus — and only the OPEN cards", () => {
    noteFlowView(view({ scrollTop: 512, focusedId: "b-x", expanded: { "b-x": true, "b-y": false } }));
    expect(persistTabOnlyGet(workspaceScopedKey(SCROLL_KEY)!)).toBe("512");
    expect(persistTabOnlyGet(workspaceScopedKey(FOCUS_KEY)!)).toBe("b-x");
    expect(
      JSON.parse(persistTabOnlyGet(workspaceScopedKey(EXPANDED_KEY)!)!),
      "a map of `false`s is the default written out longhand, and it grows without bound",
    ).toEqual(["b-x"]);
  });

  test("a reload restores the position, and does NOT restore following", () => {
    // A reload is a workspace with a MIRROR and no in-memory record — which
    // is exactly a workspace this page has never activated the flow for.
    const fresh = openWorkspace();
    expect(flowViewForActive()).toBeNull();
    persistTabOnlySet(workspaceScopedKey(SCROLL_KEY)!, "512");
    persistTabOnlySet(workspaceScopedKey(FOCUS_KEY)!, "b-x");
    persistTabOnlySet(workspaceScopedKey(EXPANDED_KEY)!, JSON.stringify(["b-x"]));

    const restored = flowViewForActive()!;
    expect(restored.scrollTop).toBe(512);
    expect(restored.focusedId).toBe("b-x");
    expect(restored.expanded["b-x"]).toBe(true);
    expect(fresh.id).toBe(activeWorkspaceId.get());
    expect(
      restored.follow,
      "a restored offset and a restored `follow: true` would fight each other on the first " +
        "version bump — the offset is the fact, following is derived from it",
    ).toBe(false);
  });
});

// ── B. The render: a switch patches, it does not remount ───────────────────

describe("switching workspaces patches the flow in place", () => {
  test("the flow element survives the switch, and the focus does not travel", async () => {
    const a = activeWorkspaceId.get()!;
    activateLog(a);
    batch(() => {
      appendBeat(turn("a-1", "you", "do the thing"));
      appendBeat(toolBeat("a-2"));
    });
    const { container } = render(Flow, { props: { ingest: false } });
    await Promise.resolve();

    const flowEl = container.querySelector(".flow");
    const hostEl = container.querySelector(".flow-host");
    (container.querySelector('[data-beat-id="a-2"]') as HTMLElement).click();
    await Promise.resolve();
    expect(flowEl!.getAttribute("aria-activedescendant")).toBe("beat-a-2");

    // The switch. (The log follows the workspace through the ingest, which
    // this mount does not run — so it is moved here by hand, and the join
    // between the two is `flow-workspace-keepalive.test.ts`.)
    const b = openWorkspace();
    activateLog(b.id);
    batch(() => appendBeat(turn("b-1", "you", "B's words")));
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    expect(container.querySelector(".flow"), "no remount: the same element").toBe(flowEl);
    expect(container.querySelector(".flow-host")).toBe(hostEl);
    expect(
      flowEl!.getAttribute("aria-activedescendant"),
      "a focus naming a beat from the other conversation would be a dead ↑↓ and a dead ⏎",
    ).toBeNull();
    expect(container.querySelector('[data-beat-id="b-1"]'), "B's beats are on screen").not.toBeNull();

    // And back.
    activateWorkspace(a);
    activateLog(a);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector(".flow"), "still no remount").toBe(flowEl);
    expect(
      flowEl!.getAttribute("aria-activedescendant"),
      "A's focus came back exactly as it was left",
    ).toBe("beat-a-2");
  });
});

// ── C. The height index does not mix workspaces ────────────────────────────

describe("a measurement reaches only the index of the workspace that drew it", () => {
  test("a height measured in one workspace never lays out another's rows", async () => {
    const a = activeWorkspaceId.get()!;
    activateLog(a);
    batch(() => {
      appendBeat(turn("a-1", "you", "do the thing"));
      appendBeat(toolBeat("a-2"));
      appendBeat(toolBeat("a-3"));
    });
    const { container } = render(Flow, { props: { ingest: false } });
    await Promise.resolve();

    // A real measurement in A: its row 0 is 999px tall.
    reportHeight(watcherFor("a-1"), 999);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    const inA = rows(container);
    expect(inA[1]!.offset - inA[0]!.offset, "A measured it").toBe(999);

    // B, with the same shapes at the same index positions.
    const b = openWorkspace();
    activateLog(b.id);
    batch(() => {
      appendBeat(turn("b-1", "you", "B's words"));
      appendBeat(toolBeat("b-2"));
      appendBeat(toolBeat("b-3"));
    });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    const inB = rows(container);
    expect(
      inB[1]!.offset - inB[0]!.offset,
      "B's row 0 is laid out from what B declared, not from what A measured at the same " +
        "index — position 0 is a different beat in every conversation",
    ).toBe(SHAPE_HEIGHT["full"]);

    // And A's own measurement is still there when A comes back.
    activateWorkspace(a);
    activateLog(a);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    const backInA = rows(container);
    expect(
      backInA[1]!.offset - backInA[0]!.offset,
      "returning must not have to re-measure what it had already measured",
    ).toBe(999);
    expect(b.id).not.toBe(a);
  });

  test("mutation: ONE index answers the same height for both workspaces", () => {
    // The index as it was — a single Fenwick tree serving every tab —
    // replayed against the same sequence. Position 0 has one height, and it
    // is whichever workspace measured last.
    const shared = new HeightIndex(SHAPE_HEIGHT["full"]!);
    shared.append(3);
    shared.update(0, 999, "full"); // workspace A's row, measured
    expect(
      shared.heightOf(0),
      "workspace B, laying out ITS row 0, reads workspace A's pixels",
    ).toBe(999);
    expect(shared.offsetOf(1) - shared.offsetOf(0)).toBe(999);
  });

  test("a reading DOES land in the index of the workspace on screen", async () => {
    const a = activeWorkspaceId.get()!;
    activateLog(a);
    batch(() => {
      appendBeat(turn("a-1", "you", "do the thing"));
      appendBeat(toolBeat("a-2"));
      appendBeat(toolBeat("a-3"));
    });
    const { container } = render(Flow, { props: { ingest: false } });
    await Promise.resolve();

    const before = rows(container);
    reportHeight(watcherFor("a-1"), 999);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    const after = rows(container);
    expect(
      after[1]!.offset - after[0]!.offset,
      "the reading is recorded, not merely routed: an index nothing ever writes to is a " +
        "virtualizer that never measures",
    ).toBe(999);
    expect(after[1]!.offset).not.toBe(before[1]!.offset);
  });

  test("each workspace's rows are laid out from its OWN declared shapes", async () => {
    const a = activeWorkspaceId.get()!;
    const silent = turn("a-2", "model", "", 1); // the flow draws nothing for it
    expect(rendersInFlow(silent), "the fixture must actually be a hidden beat").toBe(false);
    activateLog(a);
    batch(() => {
      appendBeat(turn("a-1", "you", "do the thing"));
      appendBeat(silent);
      appendBeat(toolBeat("a-3"));
    });
    const { container } = render(Flow, { props: { ingest: false } });
    await Promise.resolve();

    const aRows = rows(container);
    const hiddenAt = aRows.findIndex((r) => r.id === null);
    expect(
      aRows[hiddenAt + 1]!.offset - aRows[hiddenAt]!.offset,
      "A's index reserves nothing for a row that paints nothing",
    ).toBe(SHAPE_HEIGHT["none"]);

    const b = openWorkspace();
    activateLog(b.id);
    batch(() => {
      appendBeat(turn("b-1", "you", "B's words"));
      appendBeat(turn("b-2", "you", "more of B's words"));
      appendBeat(toolBeat("b-3"));
    });
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    const bRows = rows(container);
    expect(
      bRows[1]!.offset - bRows[0]!.offset,
      "B's row 1 is a drawn turn, and B's index reserves a drawn turn for it — the SAME " +
        "index position, a different reservation",
    ).toBe(SHAPE_HEIGHT["full"]);
  });
});
