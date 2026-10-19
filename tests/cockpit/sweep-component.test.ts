// @vitest-environment jsdom
/**
 * Sweep component (jsdom): the parallel a11y outline, the on-band status
 * truth, coverage honesty language, and the documented event seam
 * (`headChange` callback + bubbling CustomEvent). jsdom has no 2D canvas —
 * the component must degrade to the DOM outline without crashing (which is
 * itself the "canvas is never the only access" law under test).
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { tick } from "svelte";
import type { ShellApi } from "../../src/cockpit/shell/contract.ts";
import { currentChatId } from "../../src/state/chats.ts";
import { currentProjectId, projects } from "../../src/state/projects.ts";
import { currentRun } from "../../src/state/run-state.ts";
import { resetTimeline, setTimelineScope } from "../../src/state/timeline-query.ts";

import Sweep from "../../src/cockpit/sweep/Sweep.svelte";
import CausalRibbon from "../../src/cockpit/sweep/CausalRibbon.svelte";
import { encodeSpectrumPacked, type SpectrumReadWire } from "../../src/cockpit/sweep/bin-source";
import { resetSweep, sweepHead, sweepMarks } from "../../src/cockpit/sweep/sweep-store";
import {
  consumeBandGoRequest,
  pendingBandGo,
  requestBandGo,
} from "../../src/cockpit/sweep/band-request.ts";
import {
  resetSpectrumFeed,
  spectrumProvKey,
  spectrumScopeKind,
  spectrumWire,
} from "../../src/cockpit/sweep/spectrum-load";
import { ingestLiveSweepEvent, resetLiveSweepBuffer } from "../../src/cockpit/sweep/sweep-data";
import type { StreamState, SweepEvent } from "../../src/cockpit/sweep/types";

const ev = (timeMs: number, extra: Partial<SweepEvent> = {}): SweepEvent => ({
  eventId: extra.eventId ?? `e${timeMs}`,
  timeMs,
  category: extra.category ?? "tool",
  isError: extra.isError ?? false,
  eventType: extra.eventType ?? "tool",
  outcome: null,
  errorCode: null,
  runId: extra.runId !== undefined ? extra.runId : "run-1",
  turnId: extra.turnId !== undefined ? extra.turnId : "t1",
  parentEventId: extra.parentEventId ?? null,
  description: extra.description ?? "",
});

const T0 = Date.parse("2026-07-25T13:40:00");
const RECONNECTING: StreamState = {
  status: "reconnecting",
  lastEventMs: Date.parse("2026-07-25T14:02:31"),
  eventsReceived: 3,
};

beforeEach(() => {
  cleanup();
  resetSweep();
  resetSpectrumFeed();
  resetLiveSweepBuffer();
  sweepMarks.set([]);
  consumeBandGoRequest();
  currentRun.set(null);
  currentChatId.set(null);
  currentProjectId.set(null);
  resetTimeline();
});

describe("a11y outline — the canvas is never the only access", () => {
  test("renders runs with counts and time ranges", () => {
    const { getByLabelText, getByText } = render(Sweep, {
      props: {
        events: [ev(T0), ev(T0 + 1000), ev(T0 + 2000, { runId: "run-2" })],
        stream: { status: "idle", lastEventMs: null, eventsReceived: 0 },
      },
    });
    expect(getByLabelText("recorded runs")).toBeTruthy();
    expect(getByText(/run run-1 · 2 events/)).toBeTruthy();
    expect(getByText(/run run-2 · 1 events/)).toBeTruthy();
  });

  test("unattributed events appear as their own honest entry", () => {
    const { getByText } = render(Sweep, {
      props: {
        events: [ev(T0, { runId: null, turnId: null })],
        stream: { status: "idle", lastEventMs: null, eventsReceived: 0 },
      },
    });
    expect(getByText(/not part of a run · 1 events/)).toBeTruthy();
  });
});

describe("the on-band stream truth", () => {
  test("reconnecting renders the spec sentence ON the band", () => {
    const { getAllByText } = render(Sweep, {
      props: { events: [ev(T0)], stream: RECONNECTING },
    });
    // Once in the .status chip, once in the outline paragraph.
    expect(
      getAllByText(/stream reconnecting — last event 14:02:31/).length,
    ).toBeGreaterThanOrEqual(1);
  });

  test("an idle band never claims to be live", () => {
    const { getAllByText } = render(Sweep, {
      props: {
        events: [ev(T0)],
        stream: { status: "idle", lastEventMs: null, eventsReceived: 0 },
      },
    });
    expect(getAllByText(/not live — no stream open/).length).toBeGreaterThanOrEqual(1);
  });

  /**
   * THE CENTRE CHIP IS GONE — and the sentence it carried is not.
   *
   * A bordered chip sat dead centre of the band (top/left 50%, translated
   * -50%/-50%) reading "not live — no stream open", ink-quiet at rest and
   * `--warn` yellow when a conversation was open and no stream existed. The
   * user asked for it to go.
   *
   * These two tests asserted its two tones, so they assert its ABSENCE now.
   * The pair above them is what keeps this from being a licence to say
   * nothing: `statusLine` still feeds the parallel a11y outline, which is the
   * band's non-visual access path (§6.6) and which those tests read through
   * `getAllByText`. So the visual chip went and the measured fact stayed —
   * removing a display must never remove a measurement (§1.1).
   */
  test("no status chip is painted over the band, in either tone", () => {
    for (const conversationOpen of [false, true] as const) {
      const { container, unmount } = render(Sweep, {
        props: {
          events: [],
          stream: { status: "idle", lastEventMs: null, eventsReceived: 0 },
          conversationOpen,
        },
      });
      expect(container.querySelector(".status")).toBeNull();
      expect(container.querySelector(".status.alert")).toBeNull();
      unmount();
      resetLiveSweepBuffer();
    }
  });
});

/**
 * THE SPAN CAPTION IS GONE — the user's first request, mechanically.
 *
 * "remove the 'this conversation - since date' inside timeline". It was a
 * SECOND sentence about the same band, saying a weaker version of what the
 * head résumé above the band already states from measured values. This is the
 * regression guard for the removal, and it is deliberately a statement about
 * the band's whole rendered TEXT rather than about one selector: a caption
 * reintroduced under a different class name is the same defect.
 *
 * Its sibling below is what keeps it from being a guard against having
 * nothing to say: the band must still describe the window it is showing.
 */
describe("the band's span caption — removed, and not replaced by a twin", () => {
  /** Every retired phrase, verbatim, from the sentence set band-scope owned. */
  const RETIRED = [
    "this conversation · since",
    "this session's window only",
    "recorded history · since",
    "this project's recorded history",
    "nothing recorded yet in this scope",
    "does not start at this conversation's first message",
  ] as const;

  function bandText(container: HTMLElement): string {
    return (container.querySelector(".sweep") as HTMLElement).textContent ?? "";
  }

  for (const conversationOpen of [false, true] as const) {
    test(`no caption anywhere on the band — conversation ${conversationOpen ? "open" : "closed"}`, () => {
      const { container } = render(Sweep, {
        props: {
          events: [ev(T0), ev(T0 + 60_000)],
          stream: { status: "live", lastEventMs: T0 + 60_000, eventsReceived: 2 },
          conversationOpen,
        },
      });
      expect(container.querySelector(".sweep .coverage")).toBeNull();
      const text = bandText(container as HTMLElement);
      for (const phrase of RETIRED) expect(text).not.toContain(phrase);
    });
  }

  test("an empty scope carries no caption either — and invents no band", () => {
    const { container } = render(Sweep, {
      props: {
        events: [],
        stream: { status: "live", lastEventMs: null, eventsReceived: 0 },
      },
    });
    const text = bandText(container as HTMLElement);
    for (const phrase of RETIRED) expect(text).not.toContain(phrase);
    // …and nothing was invented in its place: with no events there is no
    // window, so the head résumé says nothing at all.
    expect(text).not.toContain("showing");
  });

  test("NOT VACUOUS: the band still states the window it is showing — the head résumé survived", () => {
    const { container } = render(Sweep, {
      props: {
        events: [ev(T0), ev(T0 + 60_000)],
        stream: { status: "live", lastEventMs: T0 + 60_000, eventsReceived: 2 },
      },
    });
    const text = bandText(container as HTMLElement);
    expect(text).toContain("showing 13:40:00 → 13:41:01");
    expect(text).toContain("1m 1s of the record");
    expect(text).toContain("2 events");
  });

  test("MUTATION: put a caption back on the band and the guard goes red", () => {
    const { container } = render(Sweep, {
      props: {
        events: [ev(T0), ev(T0 + 60_000)],
        stream: { status: "live", lastEventMs: T0 + 60_000, eventsReceived: 2 },
        conversationOpen: true,
      },
    });
    const band = container.querySelector(".sweep") as HTMLElement;
    // Exactly the pre-fix markup, class and all.
    const caption = document.createElement("div");
    caption.className = "coverage";
    caption.textContent = "this conversation · since Jul 25 13:40";
    band.appendChild(caption);

    expect(container.querySelector(".sweep .coverage")).not.toBeNull();
    const text = bandText(container as HTMLElement);
    expect(
      RETIRED.some((phrase) => text.includes(phrase)),
      "the caption guard must SEE a reintroduced caption — one that cannot is measuring nothing",
    ).toBe(true);
  });
});

describe("the full-history spectrum (§6.6) — fills silently, in place", () => {
  /** A real multi-day wire payload (tool row + error row, overlay declared). */
  function multiDayWire(): SpectrumReadWire {
    const bins = 4;
    const dayMs = 24 * 3600 * 1000;
    const t0 = Date.parse("2026-07-22T14:02:00");
    const toolRow = [5, 0, 3, 2];
    const errorRow = [1, 0, 0, 0];
    return {
      header: {
        categories: ["tool"],
        errorRow: 1,
        errorRowIsOverlay: true,
        rows: 2,
        bins,
        binMs: dayMs,
        t0,
        t1: t0 + bins * dayMs,
        events: 10,
        unbinnable: 0,
        attributedOnly: true,
        clamped: false,
      },
      packed: encodeSpectrumPacked([toolRow], errorRow),
    };
  }

  test("a landed spectrum fills the band in place — and changes NO geometry", async () => {
    // A shell-style mount: no data props, so the sweep follows the stores.
    const { container } = render(Sweep, { props: { conversationOpen: false } });
    const band = container.querySelector(".sweep") as HTMLElement;
    const canvasBefore = container.querySelector("canvas");
    const heightBefore = band.style.height;
    const childrenBefore = band.children.length;

    // The spectrum read lands (late, post-reveal in production) — payload and
    // the key it came from, together, exactly as spectrum-load sets them.
    (spectrumProvKey as unknown as { set: (v: string | null) => void }).set(
      "sweep.spectrum?projectId=p-1&scope=project",
    );
    (spectrumWire as unknown as { set: (v: SpectrumReadWire | null) => void }).set(
      multiDayWire(),
    );
    await Promise.resolve();
    await Promise.resolve();

    // THE PIXELS MOVED, and the résumé moved with them: the band now spans
    // the payload's own four days, stated by the one sentence it has left.
    // (No caption is asserted — there is none; its own guard is above.)
    const head = band.querySelector(".line") as HTMLElement;
    expect(head.textContent).toContain("showing 14:02:00 →");
    expect(head.textContent).toContain("4d 1h of the record");
    expect(head.textContent).toContain("with errors");
    // ONE-REVEAL discipline: the fill swaps overlay text and repaints the
    // canvas — same band element, same height, no extra mounted children
    // beyond the overlay row that replaces the fallback label.
    expect(band.style.height).toBe(heightBefore);
    expect(container.querySelector("canvas")).toBe(canvasBefore);
    expect(Math.abs(band.children.length - childrenBefore)).toBeLessThanOrEqual(1);
  });

  test("a mount that brings its OWN events keeps the client window (spectrum untouched)", async () => {
    (spectrumWire as unknown as { set: (v: SpectrumReadWire | null) => void }).set(
      multiDayWire(),
    );
    const { container } = render(Sweep, {
      props: {
        events: [ev(T0), ev(T0 + 60_000)],
        stream: { status: "live", lastEventMs: T0 + 60_000, eventsReceived: 2 },
      },
    });
    await Promise.resolve();
    // The band spans the MOUNT's own minute, not the store's four days — the
    // window on screen is the observable that says which source won, now that
    // no caption names it.
    const head = container.querySelector(".sweep .line") as HTMLElement;
    expect(head.textContent).toContain("showing 13:40:00 → 13:41:01");
    expect(head.textContent).toContain("2 events");
  });
});

describe("the band's empty state — the ONE measured emptiness gets its sentence (UIE-048)", () => {
  /** The wire shape the server answers for a scope it measured and found
   * empty: no window, no bins, no events, the overlay declaration intact. */
  function emptyScopeWire(): SpectrumReadWire {
    return {
      header: {
        categories: ["tool"],
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
      packed: encodeSpectrumPacked([[]], []),
    };
  }

  function setWire(wire: SpectrumReadWire | null, scope: "chat" | "project" | null): void {
    (spectrumWire as unknown as { set: (v: SpectrumReadWire | null) => void }).set(wire);
    (spectrumScopeKind as unknown as { set: (v: "chat" | "project" | "trace" | null) => void }).set(
      scope,
    );
  }

  test("integrated measured emptiness releases layout work, retains focused/past/marked and scoped running state, and reveals the first event", async () => {
    const observers: { active: boolean }[] = [];
    vi.stubGlobal("ResizeObserver", class {
      state = { active: true };
      constructor() { observers.push(this.state); }
      observe() {}
      disconnect() { this.state.active = false; }
    });
    const shell = { claimKey: () => () => {}, pushDismiss: () => () => {}, hint() {} } as unknown as ShellApi;
    const { container, unmount } = render(Sweep, { props: { shell, stream: { status: "live", lastEventMs: null, eventsReceived: 0 } } });
    try {
      await tick();
      const band = container.querySelector<HTMLElement>(".sweep")!;
      const canvas = container.querySelector<HTMLCanvasElement>("canvas")!;
      expect(band.dataset.quietEmpty, "unread is not measured empty").toBe("false");
      expect(observers.some(o => o.active)).toBe(true);
      canvas.focus();
      setWire(emptyScopeWire(), "chat");
      await tick();
      canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await tick();
      expect(document.activeElement, "Escape must not strand focused canvas in inert content").toBe(canvas);
      expect(band.dataset.quietEmpty).toBe("false");
      canvas.blur();
      await tick();
      expect(band.dataset.quietEmpty).toBe("true");
      expect(band.inert).toBe(true);
      expect(observers.every(o => !o.active), "quiet band disconnects layout observers").toBe(true);

      projects.set([{ id: "sweep-project", name: "Sweep project", path: "/tmp/sweep", createdAt: "2026-01-01", updatedAt: "2026-01-01" }]);
      currentProjectId.set("sweep-project");
      currentChatId.set("sweep-chat");
      setTimelineScope({ kind: "chat", label: "Sweep chat", chatId: "sweep-chat", runIds: [] });
      currentRun.set({ runId: "run-before-event", projectId: "sweep-project", status: "starting", startedAt: T0, modelLabel: null });
      await tick();
      expect(band.dataset.quietEmpty, "starting run retains its timeline before its first event").toBe("false");
      expect(observers.some(o => o.active)).toBe(true);
      setTimelineScope({ kind: "chat", label: "Other chat", chatId: "other-chat", runIds: [] });
      await tick();
      expect(band.dataset.quietEmpty, "same-project run is not a different chat's activity").toBe("true");
      currentRun.set(null);
      sweepHead.set(T0);
      await tick();
      expect(band.dataset.quietEmpty, "past view remains accessible").toBe("false");
      sweepHead.set(null);
      sweepMarks.set([{ id: "mark-empty", timeMs: T0, label: "A real mark", createdAtMs: T0, origin: "user", storage: "local" }]);
      await tick();
      expect(band.dataset.quietEmpty, "marks retain their navigation").toBe("false");
      sweepMarks.set([]);
      await tick();
      expect(band.dataset.quietEmpty).toBe("true");
      ingestLiveSweepEvent({ eventId: "first-real-event", wallTime: new Date(T0).toISOString(), eventType: "tool", outcome: "success", runId: "run-1", description: "First event" });
      await tick();
      expect(band.dataset.quietEmpty).toBe("false");
      expect(band.inert).toBe(false);
      expect(observers.some(o => o.active)).toBe(true);
      expect(canvas.getAttribute("aria-label")).toContain("1 events on the band");
    } finally {
      unmount();
      vi.unstubAllGlobals();
      currentRun.set(null); currentChatId.set(null); currentProjectId.set(null); resetTimeline();
    }
  });

  test("a fresh conversation: the landed empty read states the absence in the flow's own voice", async () => {
    // A shell-style mount (no data props) over an empty streamed window —
    // the fresh-conversation state the drive reproduced.
    const { container } = render(Sweep, { props: { conversationOpen: true } });
    await Promise.resolve();
    const head = container.querySelector(".sweep .line") as HTMLElement;
    // Silence before the read lands: an unmeasured emptiness stays wordless.
    expect(head.textContent).not.toContain("No timeline events recorded yet");

    // The conversation's own read lands — and it honestly says: nothing.
    setWire(emptyScopeWire(), "chat");
    await Promise.resolve();
    await Promise.resolve();
    expect(head.textContent).toContain("No timeline events recorded yet");
    // And nothing else was invented in its place: no window, no counts.
    expect(head.textContent).not.toContain("showing");
    expect(head.textContent).not.toMatch(/\d+\s+events/);
  });

  test("an unmeasured emptiness stays silent — no wire, no sentence (the in-flight/failed law)", async () => {
    const { container } = render(Sweep, { props: { conversationOpen: true } });
    await Promise.resolve();
    const head = container.querySelector(".sweep .line") as HTMLElement;
    expect(head.textContent).not.toContain("No timeline events recorded yet");
  });

  test("an empty read for a WIDER scope is a different absence — the conversation is not named", async () => {
    const { container } = render(Sweep, { props: { conversationOpen: false } });
    setWire(emptyScopeWire(), "project");
    await Promise.resolve();
    await Promise.resolve();
    const head = container.querySelector(".sweep .line") as HTMLElement;
    expect(head.textContent).not.toContain("No timeline events recorded yet");
  });

  test("a local streamed event means the conversation is not empty, whatever the read said", async () => {
    // The read landed empty, then the run's first events streamed in — the
    // sentence must retire the moment the emptiness stops being true.
    const { container } = render(Sweep, { props: { conversationOpen: true } });
    setWire(emptyScopeWire(), "chat");
    await Promise.resolve();
    // A REAL wire-shaped timeline record, as the run stream forwards them.
    ingestLiveSweepEvent({
      eventId: "live-1",
      wallTime: new Date(T0).toISOString(),
      eventType: "tool",
      outcome: "success",
      runId: "run-1",
      description: "",
    });
    await Promise.resolve();
    await Promise.resolve();
    const head = container.querySelector(".sweep .line") as HTMLElement;
    expect(head.textContent).not.toContain("No timeline events recorded yet");
  });

  test("MUTATION: a re-introduced scope caption cannot pass as the absence sentence", () => {
    // The retired-caption guard above forbids the old phrasings; the new
    // sentence must not collide with any of them (it names the CONVERSATION,
    // never "this scope").
    const RETIRED = [
      "this conversation · since",
      "nothing recorded yet in this scope",
    ] as const;
    for (const phrase of RETIRED) {
      expect("No timeline events recorded yet".includes(phrase)).toBe(false);
    }
  });
});

describe("headChange — the documented event seam", () => {
  test("outline navigation plants the head, fires the callback AND the CustomEvent, and mirrors into the store", async () => {
    const seen: (number | null)[] = [];
    const { getByText, getAllByText, container } = render(Sweep, {
      props: {
        events: [ev(T0), ev(T0 + 1000)],
        stream: { status: "idle", lastEventMs: null, eventsReceived: 0 },
        onHeadChange: (asOf: number | null) => seen.push(asOf),
      },
    });
    const domEvents: (number | null)[] = [];
    container.addEventListener("headChange", ((e: CustomEvent) => {
      domEvents.push(e.detail as number | null);
    }) as unknown as EventListener);

    const runButton = getByText(/run run-1/);
    runButton.click();
    await Promise.resolve();

    expect(seen).toEqual([T0]);
    expect(domEvents).toEqual([T0]);
    expect(sweepHead.get()).toBe(T0);

    // planted state renders the spec sentence + the return verb (it appears
    // both on the SweepHead chip and in the a11y outline — the parallel
    // access law, so multiple matches are expected)
    expect(getAllByText(/viewing 13:40:00/).length).toBeGreaterThanOrEqual(1);
    const back = getByText("Back to now");
    back.click();
    await Promise.resolve();
    expect(seen).toEqual([T0, null]);
    expect(sweepHead.get()).toBeNull();
  });

  test("the right menu's capture go plants the head through the band's own setHead (sweep/band-request.ts)", async () => {
    // A capture row's "go" writes the one-shot seam; the band answers with
    // the same composite verb a mark click runs — plant AND navigate — so
    // a visited capture and a clicked mark cannot behave differently.
    const seen: (number | null)[] = [];
    render(Sweep, {
      props: {
        events: [ev(T0), ev(T0 + 1000)],
        stream: { status: "idle", lastEventMs: null, eventsReceived: 0 },
        onHeadChange: (asOf: number | null) => seen.push(asOf),
      },
    });
    const AT = T0 + 500;
    requestBandGo(AT);
    await Promise.resolve();
    expect(sweepHead.get(), "the head plants at the asked instant").toBe(AT);
    expect(seen, "the navigation publishes the head change").toEqual([AT]);
    expect(pendingBandGo.get(), "the consumption is one-shot").toBeNull();
    // The DOM event fired too — the flow's channel hears the same trip.
    // (The event is asserted by the mark arm above; here the store + the
    // callback are the consumption's own evidence.)
  });
});

describe("folding (§2.7 <1100px: 28px band)", () => {
  test("folded prop drives the band height", () => {
    const { container } = render(Sweep, {
      props: {
        events: [],
        stream: { status: "idle", lastEventMs: null, eventsReceived: 0 },
        folded: true,
      },
    });
    const band = container.querySelector(".sweep") as HTMLElement;
    expect(band.style.height).toBe("28px");
  });
});

describe("CausalRibbon", () => {
  const chain = [
    ev(1, { eventId: "a", parentEventId: null }),
    ev(2, { eventId: "b", parentEventId: "a" }),
    ev(3, { eventId: "c", parentEventId: "b" }),
  ];

  test("renders one spine path through placeable anchors", () => {
    const { container } = render(CausalRibbon, {
      props: {
        focusedEventId: "c",
        events: chain,
        place: (id: string) =>
          id === "a" ? { x: 10, y: 10 } : id === "b" ? { x: 10, y: 50 } : { x: 30, y: 90 },
        width: 100,
        height: 100,
      },
    });
    const path = container.querySelector("path.spine");
    expect(path).toBeTruthy();
    expect(container.querySelectorAll("circle").length).toBe(3);
  });

  test("no focus → nothing rendered (honest absence)", () => {
    const { container } = render(CausalRibbon, {
      props: {
        focusedEventId: null,
        events: chain,
        place: () => ({ x: 0, y: 0 }),
        width: 100,
        height: 100,
      },
    });
    expect(container.querySelector("svg")).toBeNull();
  });
});
