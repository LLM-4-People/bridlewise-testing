// @vitest-environment jsdom
/**
 * THE INSTRUMENTS ROOM — live in jsdom (DESIGN-COCKPIT-V2 §8.2).
 *
 * What must hold on screen:
 *   - the room opens from the SERVED registry alone, every cell in its
 *     honest absence state, grouped by feature module under the served
 *     display names — before any sample exists (absence-first);
 *   - a landed sample fills values in place; a signal ABSENT from the
 *     snapshot stays absent (never zeroed, never interpolated);
 *   - verbs are the mechanically resolved ones and nothing else: adjust
 *     only where the registry declares a bounding setting (and honestly
 *     DISABLED while the settings sibling's sheet has not landed), the
 *     block action only where the manifest declares one, `ask` always —
 *     and it prefills the composer's `?` grammar;
 *   - pin → monitor; a 5th pin asks INLINE which to displace (no modal),
 *     and the ask mutates nothing until the user picks;
 *   - dark cockpit: no cell earns color while no threshold is declared.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";

import InstrumentsRoom from "../../src/cockpit/rooms/InstrumentsRoom.svelte";
import {
  resetInstrumentsFeed,
  setInstrumentsReader,
  pinnedMonitors,
} from "../../src/cockpit/rooms/instruments-feed.ts";
import { setUiSchema, setUiSchemaValues, resetUiSchema } from "../../src/state/schema-store.ts";
import { authState, initialAuth } from "../../src/state/auth.ts";
import { persistGet } from "../../src/state/persistence.ts";
import {
  ACTION_ARM_WINDOW_MS,
  MONITORS_STORAGE_KEY,
  SIGNALS_POLL_MS,
} from "../../src/cockpit/rooms/instruments-config.ts";
import { ASK_PREFILL } from "../../src/cockpit/computer/ask.ts";
import type { ShellApi } from "../../src/cockpit/shell/contract.ts";
import type { UiSchema, UiSchemaValues } from "../../shared/ui-schema.ts";

// The wire door the actions fold executes through — mocked HERE so the fold's
// arms observe the call (its id, its timing, its absence) without a server.
vi.mock("../../src/client.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/client.ts")>()),
  executeSchemaAction: vi.fn(async () => ({ refreshed: true })),
}));

import { executeSchemaAction } from "../../src/client.ts";
const executeActionMock = vi.mocked(executeSchemaAction);

// ── a realistic slice of the real 110-signal registry ─────────────────────

const SCHEMA: UiSchema = {
  version: "bridlewise-ui-schema/v2",
  modules: [
    { id: "sys.context", title: "Context signals", group: "system", order: 0,
      sources: [], render: { home: 1 }, relevance: { base: 0.25 }, synthesized: true },
    { id: "sys.tools", title: "Tools signals", group: "system", order: 1,
      sources: [], render: { home: 1 }, relevance: { base: 0.25 }, synthesized: true },
  ] as unknown as UiSchema["modules"],
  menus: [],
  panels: [],
  widgets: [],
  settings: [
    {
      id: "cust.tools.maxConcurrent",
      label: "Max Concurrent",
      description: "Maximum tool calls in flight.",
      type: "number",
      default: 4,
      customizationId: "tools.maxConcurrent",
      order: 0,
    },
  ],
  // The actions slice the fold derives from: real registry ids (so the
  // press-classification under test is the live one) across the shapes the
  // fold must handle — a module WITH signals (context, tools), a module
  // with actions but NO signals (privacy — its fold must still surface),
  // and one with REQUIRED args (disabled with its reason, never a dead
  // press).
  actions: [
    { id: "context.retrieveMemory", label: "Retrieve Memory", description: "Trigger one memory retrieval.", module: "context", order: 1 },
    { id: "context.clear", label: "Clear", description: "Clear the entire context window.", module: "context", order: 2 },
    { id: "tools.resetCounters", label: "Reset Counters", description: "Reset all tools counters to zero.", module: "tools", order: 3 },
    { id: "privacy.setTier", label: "Turn a kind of detection on or off", description: "Switch a tier.", module: "privacy", order: 4, args: { tier: { type: "string", required: true, description: "Which tier" }, enabled: { type: "boolean", required: true, description: "On or off" } } },
  ],
  signals: [
    { id: "context.utilization", module: "context", name: "Utilization",
      description: "Fraction of the context window in use (0..1).", type: "gauge", unit: "ratio" },
    { id: "context.totalTokens", module: "context", name: "Total Tokens",
      description: "Token size of the current context window.", type: "gauge", unit: "tokens" },
    { id: "tools.callCount", module: "tools", name: "Call Count",
      description: "Total tool calls.", type: "counter", unit: "count" },
    { id: "tools.maxConcurrent", module: "tools", name: "Max Concurrent",
      description: "Concurrency limit.", type: "gauge", unit: "count" },
    { id: "tools.errorRate", module: "tools", name: "Error Rate",
      description: "Failed calls over total.", type: "gauge", unit: "ratio" },
    { id: "tools.inFlight", module: "tools", name: "In Flight",
      description: "Calls currently executing.", type: "gauge", unit: "count" },
  ],
  blockActions: {
    "tools.callCount": [
      { name: "reset", title: "Reset", consequence: "Clears the counter.", params: {} },
    ],
    // Declared but UNBUILDABLE here (needs a selection) — must NOT render.
    "tools.errorRate": [
      { name: "inspect", title: "Inspect", consequence: "Opens the failing calls.",
        params: { chatId: "$sel.chatId" } },
    ],
  },
};

const values = (pairs: Readonly<Record<string, number | string | boolean>>): UiSchemaValues => ({
  signals: Object.entries(pairs).map(([id, value]) => ({ id, value })),
  customizations: [],
});

// ── shell double ──────────────────────────────────────────────────────────

function makeShell(): ShellApi & {
  prefilled: string[];
  monitors: unknown[][];
  scopes: unknown[];
  hints: string[];
  closed: number;
} {
  const prefilled: string[] = [];
  const monitors: unknown[][] = [];
  const scopes: unknown[] = [];
  const hints: string[] = [];
  let closed = 0;
  const api = {
    revealAt: () => 0,
    openRoom: () => {},
    closeRoom: () => { closed += 1; api.closed = closed; },
    openScope: (req: unknown) => scopes.push(req),
    closeScope: () => {},
    setAnnunciators: () => {},
    setMonitors: (list: readonly unknown[]) => monitors.push([...list]),
    claimKey: () => () => {},
    pushDismiss: () => () => {},
    hint: (t: string) => hints.push(t),
    composerText: () => "",
    onComposerSubmit: () => () => {},
    prefillComposer: (t: string) => prefilled.push(t),
    clearComposer: () => {},
    restoreComposerText: () => {},
    onComposerChange: () => () => {},
    setDeskLine: () => {},
    prefilled,
    monitors,
    scopes,
    hints,
    closed: 0,
  };
  return api as unknown as ShellApi & {
    prefilled: string[];
    monitors: unknown[][];
    scopes: unknown[];
    hints: string[];
    closed: number;
  };
}

let shell = makeShell();

beforeEach(() => {
  vi.useFakeTimers();
  resetInstrumentsFeed();
  resetUiSchema();
  localStorage.clear();
  setUiSchema(SCHEMA);
  // The fold's verbs are admin-gated by the wire door's own contract; the
  // arms run as the admin (the non-admin arm sets this false itself).
  authState.set({ ...initialAuth, authenticated: true, isAdmin: true, username: "admin" });
  executeActionMock.mockReset();
  executeActionMock.mockResolvedValue({ refreshed: true });
  shell = makeShell();
  // Default: the channel answers nothing — the room must still open.
  setInstrumentsReader({ values: async () => undefined });
});

afterEach(() => {
  cleanup();
  resetInstrumentsFeed();
  resetUiSchema();
  vi.useRealTimers();
});

function open() {
  return render(InstrumentsRoom, { props: { shell } });
}

// ── the grid ──────────────────────────────────────────────────────────────

describe("the grid — uniform, module-grouped, absence-first", () => {
  test("every declared signal has a cell before any sample exists", () => {
    const { container } = open();
    const cells = container.querySelectorAll("article.cell");
    expect(cells).toHaveLength(SCHEMA.signals.length);
    for (const cell of cells) {
      expect(cell.getAttribute("data-measured")).toBe("false");
      expect(cell.querySelector(".value")).toBeNull();
    }
  });

  // ── THE ROOM FOCUS GRAMMAR (UIE-051) — the without-input half ────────────
  //
  // Instruments has NO primary input (a monitor wall: cells, folds, pins),
  // so opening it takes NO focus. The Switch's suite pins the with-input
  // half; the two halves together are the grammar the playbook documents.
  test("opening the room takes no focus — an input-less room never steals it", () => {
    const before = document.activeElement;
    const { container } = open();
    expect(container.querySelectorAll("article.cell").length).toBeGreaterThan(0);
    expect(document.activeElement, "focus is where the reader left it").toBe(before);
  });

  test("groups use the registry's SERVED display names, not raw ids", () => {
    const { container } = open();
    const titles = [...container.querySelectorAll(".module-title")].map((h) => h.textContent?.trim());
    // Privacy declares ACTIONS but no signals in this slice — its group
    // still renders (the fold surfaces all served actions), titled by the
    // contracts-owned humanization because the slice declares no
    // sys.privacy module.
    expect(titles).toEqual(["Context signals", "Privacy", "Tools signals"]);
  });

  test("cells carry their plain-language served names", () => {
    const { getByText } = open();
    expect(getByText("Utilization")).toBeTruthy();
    expect(getByText("Max Concurrent")).toBeTruthy();
  });

  test("the header counts are honest before any measurement", () => {
    const { container } = open();
    const line = container.querySelector(".counts")!.textContent!;
    expect(line).toContain("6 signals declared");
    expect(line).toContain("0 measured");
  });

  test("no signal renders twice (one manifestation per fact, §1.4)", () => {
    const { container } = open();
    const ids = [...container.querySelectorAll("article.cell")].map((c) =>
      c.getAttribute("data-signal"),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ── live values ───────────────────────────────────────────────────────────

describe("values arrive live and absence survives", () => {
  test("a landed snapshot fills the measured cells IN PLACE", async () => {
    setInstrumentsReader({
      values: async () => {
        setUiSchemaValues(values({ "context.utilization": 0.16, "tools.callCount": 12 }));
      },
    });
    const { container } = open();
    await vi.advanceTimersByTimeAsync(1);
    await waitFor(() => {
      const util = container.querySelector('[data-signal="context.utilization"]');
      expect(util?.querySelector(".value")?.textContent).toBe("16%");
    });
    expect(
      container.querySelector('[data-signal="tools.callCount"] .value')?.textContent,
    ).toBe("12");
    // Cell count unchanged — values filled in place, nothing mounted.
    expect(container.querySelectorAll("article.cell")).toHaveLength(SCHEMA.signals.length);
  });

  test("a signal ABSENT from the snapshot stays absent (never zeroed)", async () => {
    setInstrumentsReader({
      values: async () => setUiSchemaValues(values({ "context.utilization": 0.16 })),
    });
    const { container } = open();
    await vi.advanceTimersByTimeAsync(1);
    await waitFor(() => {
      expect(container.querySelector('[data-signal="context.utilization"] .value')).not.toBeNull();
    });
    const missing = container.querySelector('[data-signal="tools.inFlight"]')!;
    expect(missing.getAttribute("data-measured")).toBe("false");
    expect(missing.querySelector(".value")).toBeNull();
    expect(missing.textContent).toContain("collecting since");
  });

  test("counts stay honest as measurements land", async () => {
    setInstrumentsReader({
      values: async () => setUiSchemaValues(values({ "context.utilization": 0.16 })),
    });
    const { container } = open();
    await vi.advanceTimersByTimeAsync(1);
    await waitFor(() => {
      const line = container.querySelector(".counts")!.textContent!;
      expect(line).toContain("1 measured");
      expect(line).toContain("5 collecting");
    });
  });

  test("a refused channel says so and un-measures nothing", async () => {
    let fail = false;
    setInstrumentsReader({
      values: async () => {
        if (fail) throw new Error("boom");
        setUiSchemaValues(values({ "context.utilization": 0.16 }));
      },
    });
    const { container } = open();
    await vi.advanceTimersByTimeAsync(1);
    await waitFor(() =>
      expect(container.querySelector('[data-signal="context.utilization"] .value')).not.toBeNull(),
    );
    fail = true;
    await vi.advanceTimersByTimeAsync(5001);
    await waitFor(() => expect(container.querySelector(".feed-error")).not.toBeNull());
    // The measured past survives the failing present.
    expect(container.querySelector('[data-signal="context.utilization"] .value')?.textContent).toBe(
      "16%",
    );
  });

  // ── the digit roll (§11.4) ──────────────────────────────────────────────
  // A live value change rolls the numeral ONCE, with a NAMED cause and no
  // exception. The defect this arms against: the roll used to be a reactive
  // `use:moves` param beside a keyed remount, so one change consumed its
  // fresh cause twice — the action update spent it on the outgoing node and
  // the remount's mount-apply threw `MotionContract` uncaught on the
  // arriving one, losing the roll and landing a console error per change.
  test("a true value change rolls the digit once, named, with no exception", async () => {
    let reading = 12;
    setInstrumentsReader({
      values: async () => setUiSchemaValues(values({ "tools.callCount": reading })),
    });
    const { container } = open();
    await vi.advanceTimersByTimeAsync(1);
    await waitFor(() =>
      expect(container.querySelector('[data-signal="tools.callCount"] .value')?.textContent).toBe("12"),
    );
    // The FIRST appearance rolls nothing — no cause exists for it yet.
    expect(container.querySelector('[data-signal="tools.callCount"] .value')!.getAttribute("data-motion")).toBeNull();

    reading = 15;
    await vi.advanceTimersByTimeAsync(SIGNALS_POLL_MS + 1);
    await waitFor(() =>
      expect(container.querySelector('[data-signal="tools.callCount"] .value')?.textContent).toBe("15"),
    );
    const rolled = container.querySelector('[data-signal="tools.callCount"] .value')!;
    expect(rolled.getAttribute("data-motion"), "the change must roll the numeral").toBe("roll");
    expect(rolled.getAttribute("data-motion-cause")).toBe("change");
    expect(
      rolled.getAttribute("data-motion-signal"),
      "the roll must NAME the signal it is bound to (§11.8)",
    ).toBe("Call Count");
    // The roll ENDS (a real browser fires animationend ~150ms later and the
    // action clears its attributes) — the next change must arrive at a node
    // AT REST, which is exactly the state the double-consumption needed:
    // an at-rest outgoing node's update path consumed the fresh cause, and
    // the keyed remount's mount was then refused with it, uncaught.
    rolled.dispatchEvent(new Event("animationend"));
    expect(rolled.getAttribute("data-motion"), "at rest, nothing is moving").toBeNull();

    // A rapid SECOND change rolls again — on a fresh node, not swallowed by a
    // still-wearing one — and never spends one cause on two nodes.
    reading = 17;
    await vi.advanceTimersByTimeAsync(SIGNALS_POLL_MS + 1);
    await waitFor(() => {
      const again = container.querySelector('[data-signal="tools.callCount"] .value')!;
      expect(again.textContent).toBe("17");
      expect(again.getAttribute("data-motion"), "the second change rolls too").toBe("roll");
      expect(again.getAttribute("data-motion-signal")).toBe("Call Count");
    });
  });

  test("a re-measurement of the SAME value rolls nothing", async () => {
    setInstrumentsReader({
      values: async () => setUiSchemaValues(values({ "tools.callCount": 12 })),
    });
    const { container } = open();
    await vi.advanceTimersByTimeAsync(1);
    await waitFor(() =>
      expect(container.querySelector('[data-signal="tools.callCount"] .value')).not.toBeNull(),
    );
    const before = container.querySelector('[data-signal="tools.callCount"] .value')!;
    await vi.advanceTimersByTimeAsync(SIGNALS_POLL_MS + 1);
    const after = container.querySelector('[data-signal="tools.callCount"] .value')!;
    expect(after.textContent).toBe("12");
    expect(after.getAttribute("data-motion"), "the poll firing is not the reading changing").toBeNull();
    expect(after).toBe(before); // same node — the key never re-keyed
  });
});

// ── verbs ─────────────────────────────────────────────────────────────────

describe("verbs — mechanically resolved, never invented", () => {
  test("`ask` exists on every cell and prefills the ? grammar", async () => {
    const { container } = open();
    const cell = container.querySelector('[data-signal="context.utilization"]')!;
    const ask = cell.querySelector('[data-verb-id="instruments.ask"]')!;
    expect(ask.textContent?.trim()).toBe("ask");
    await fireEvent.click(ask);
    // The bare leader alone — the grammar's own menu enumerates the
    // questions from there; a prefilled display name could never parse.
    expect(shell.prefilled).toEqual([ASK_PREFILL]);
  });

  test("adjust appears ONLY where the registry declares a bounding setting", () => {
    const { container } = open();
    const bounded = container.querySelector('[data-signal="tools.maxConcurrent"]')!;
    const unbounded = container.querySelector('[data-signal="context.utilization"]')!;
    expect(bounded.querySelector('[data-verb-id="instruments.adjust"]')).not.toBeNull();
    expect(unbounded.querySelector('[data-verb-id="instruments.adjust"]')).toBeNull();
  });

  test("adjust is DISABLED with its reason until the sibling's sheet resolves", () => {
    // The sheet is the settings surface's component, discovered by file
    // convention and loaded async — a verb that cannot act yet says so
    // rather than opening an empty sheet (§1.2).
    const { container } = open();
    const adjust = container.querySelector(
      '[data-signal="tools.maxConcurrent"] [data-verb-id="instruments.adjust"]',
    ) as HTMLButtonElement;
    expect(adjust.disabled).toBe(true);
    expect(adjust.title).toMatch(/settings surface owns it/);
  });

  test("once the sheet has loaded, adjust opens the SCOPE with the sibling's payload", async () => {
    const { container } = open();
    await vi.waitFor(() => {
      const adjust = container.querySelector(
        '[data-signal="tools.maxConcurrent"] [data-verb-id="instruments.adjust"]',
      ) as HTMLButtonElement;
      expect(adjust.disabled).toBe(false);
    });
    await fireEvent.click(
      container.querySelector(
        '[data-signal="tools.maxConcurrent"] [data-verb-id="instruments.adjust"]',
      )!,
    );
    expect(shell.scopes).toHaveLength(1);
    const req = shell.scopes[0] as { title: string; component: unknown; props: unknown };
    expect(req.title).toBe("adjust");
    expect(req.component).toBeTruthy();
    // Exactly the settings sibling's published payload — nothing else.
    expect(req.props).toEqual({ settingId: "tools.maxConcurrent" });
  });

  test("a declared block action renders; an UNBUILDABLE one does not", () => {
    const { container } = open();
    const withAction = container.querySelector('[data-signal="tools.callCount"]')!;
    expect(withAction.querySelector('[data-verb-id="instruments.action"]')?.textContent?.trim()).toBe(
      "reset",
    );
    // errorRate's action needs $sel.chatId — no selection scope here, so it
    // must not be offered (an inert control wearing a working one's label).
    const unbuildable = container.querySelector('[data-signal="tools.errorRate"]')!;
    expect(unbuildable.querySelector('[data-verb-id="instruments.action"]')).toBeNull();
  });

  test("no cell offers more than two verbs (§8.2 'up to two')", () => {
    const { container } = open();
    for (const cell of container.querySelectorAll("article.cell")) {
      const verbs = cell.querySelectorAll('[data-verb-id^="instruments."]:not([data-verb-id="instruments.pin"])');
      expect(verbs.length).toBeLessThanOrEqual(2);
      expect(verbs.length).toBeGreaterThanOrEqual(1); // ask is always there
    }
  });
});

// ── pinning ───────────────────────────────────────────────────────────────

describe("pin → HORIZON monitor, max 4, the 5th asks inline", () => {
  function pin(container: HTMLElement, id: string): Promise<unknown> {
    return fireEvent.click(
      container.querySelector(`[data-signal="${id}"] [data-verb-id="instruments.pin"]`)!,
    );
  }

  test("pinning pushes a monitor to the shell", async () => {
    const { container } = open();
    await pin(container, "context.utilization");
    expect(pinnedMonitors.get().map((m) => m.signalId)).toEqual(["context.utilization"]);
    const last = shell.monitors[shell.monitors.length - 1]!;
    expect(last).toHaveLength(1);
    expect((last[0] as { label: string }).label).toBe("Utilization");
  });

  test("a monitor carries a real asOf even before its first sample", async () => {
    const { container } = open();
    await pin(container, "context.utilization");
    const last = shell.monitors[shell.monitors.length - 1]!;
    const m = last[0] as { asOf: number; value: string };
    expect(typeof m.asOf).toBe("number");
    expect(m.asOf).toBeGreaterThan(0);
    expect(m.value).toBe("collecting");
  });

  test("clicking pin again unpins", async () => {
    const { container } = open();
    await pin(container, "context.utilization");
    await pin(container, "context.utilization");
    expect(pinnedMonitors.get()).toEqual([]);
  });

  test("a 5th pin asks INLINE which to displace and changes nothing yet", async () => {
    const { container } = open();
    for (const id of ["context.utilization", "context.totalTokens", "tools.callCount", "tools.errorRate"]) {
      await pin(container, id);
    }
    expect(pinnedMonitors.get()).toHaveLength(4);
    await pin(container, "tools.inFlight");
    // Still four — nothing was silently evicted.
    expect(pinnedMonitors.get()).toHaveLength(4);
    const ask = container.querySelector("[data-displace-ask]");
    expect(ask).not.toBeNull();
    // Inline, in the room's own flow — not a modal/dialog overlay.
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(ask!.textContent).toContain("In Flight");
    expect(ask!.querySelectorAll('[data-verb-id="instruments.displace"]')).toHaveLength(4);
  });

  test("picking a monitor in the ask swaps exactly that slot, in place", async () => {
    const { container } = open();
    const first4 = ["context.utilization", "context.totalTokens", "tools.callCount", "tools.errorRate"];
    for (const id of first4) await pin(container, id);
    await pin(container, "tools.inFlight");
    const choices = container.querySelectorAll('[data-verb-id="instruments.displace"]');
    await fireEvent.click(choices[1]!); // displace context.totalTokens
    const ids = pinnedMonitors.get().map((m) => m.signalId);
    expect(ids).toEqual([
      "context.utilization",
      "tools.inFlight",
      "tools.callCount",
      "tools.errorRate",
    ]);
    expect(container.querySelector("[data-displace-ask]")).toBeNull();
  });

  test("declining the ask keeps the set as it was", async () => {
    const { container } = open();
    for (const id of ["context.utilization", "context.totalTokens", "tools.callCount", "tools.errorRate"]) {
      await pin(container, id);
    }
    await pin(container, "tools.inFlight");
    await fireEvent.click(container.querySelector('[data-verb-id="instruments.displace-cancel"]')!);
    expect(pinnedMonitors.get().map((m) => m.signalId)).toEqual([
      "context.utilization",
      "context.totalTokens",
      "tools.callCount",
      "tools.errorRate",
    ]);
    expect(container.querySelector("[data-displace-ask]")).toBeNull();
  });

  test("pins persist per the cockpit storage convention", async () => {
    const { container } = open();
    await pin(container, "context.utilization");
    const raw = persistGet(MONITORS_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)[0].signalId).toBe("context.utilization");
  });

  test("monitors live-update from the same stream", async () => {
    setInstrumentsReader({
      values: async () => setUiSchemaValues(values({ "context.utilization": 0.42 })),
    });
    const { container } = open();
    await pin(container, "context.utilization");
    await vi.advanceTimersByTimeAsync(1);
    await waitFor(() => {
      const last = shell.monitors[shell.monitors.length - 1]!;
      expect((last[0] as { value: string }).value).toBe("42%");
    });
  });
});

// ── dark cockpit ──────────────────────────────────────────────────────────

describe("dark cockpit — color only from a DECLARED abnormal state", () => {
  test("no cell is colored while the registry declares no thresholds", async () => {
    setInstrumentsReader({
      values: async () =>
        setUiSchemaValues(
          values({ "context.utilization": 0.99, "tools.errorRate": 1, "tools.inFlight": 9999 }),
        ),
    });
    const { container } = open();
    await vi.advanceTimersByTimeAsync(1);
    await waitFor(() =>
      expect(container.querySelector('[data-signal="tools.errorRate"] .value')).not.toBeNull(),
    );
    for (const cell of container.querySelectorAll("article.cell")) {
      expect(cell.getAttribute("data-abnormal")).toBeNull();
    }
  });
});

// ── the exposure actions fold ──────────────────────────────────────────────

describe("the actions fold — the module's act-on-the-system surface", () => {
  /** Open the room and expand every fold — the arms below observe the
   * surfaced set, so this is the honest "reader opened it" state. */
  function openAllFolds(): ReturnType<typeof open> {
    const rendered = open();
    for (const head of rendered.container.querySelectorAll(
      '[data-verb-id="instruments.actions/fold"]',
    )) {
      fireEvent.click(head as HTMLElement);
    }
    return rendered;
  }

  test("the fold is COLLAPSED by default and opens on its head", () => {
    const { container } = open();
    const heads = [...container.querySelectorAll('[data-verb-id="instruments.actions/fold"]')];
    expect(heads.length).toBe(3);
    for (const head of heads) {
      expect(head.getAttribute("aria-expanded")).toBe("false");
    }
    expect(container.querySelectorAll("[data-action-id]")).toHaveLength(0);
    fireEvent.click(heads[0]!);
    expect(heads[0]!.getAttribute("aria-expanded")).toBe("true");
    expect(
      container.querySelectorAll('[data-actions-fold="context"] [data-action-id]').length,
    ).toBe(2);
  });

  test("EVERY served action surfaces exactly once, in its module's fold (deny-by-default count)", () => {
    // THE PASTE-COUNT CHECK: the fold derives from the SERVED schema, never
    // a hand list — so the rendered set must equal the served set, per id.
    // MUTATION: filter the derivation (drop one action in buildGroups) and
    // this reds while the schema still serves it.
    const { container } = openAllFolds();
    const rows = [...container.querySelectorAll("[data-action-id]")];
    expect(rows).toHaveLength(SCHEMA.actions.length);
    const renderedIds = rows.map((r) => r.getAttribute("data-action-id"));
    expect(new Set(renderedIds).size).toBe(SCHEMA.actions.length);
    for (const action of SCHEMA.actions) {
      expect(renderedIds, `${action.id} was not surfaced`).toContain(action.id);
      // And its verb address is the served id, derived — never restated.
      expect(
        container.querySelector(`[data-verb-id="actions/${action.id}"]`),
      ).not.toBeNull();
    }
  });

  test("a module with actions but NO signals still gets its fold — actions are never dropped for lack of cells", () => {
    const { container } = openAllFolds();
    const privacyFold = container.querySelector('[data-actions-fold="privacy"]');
    expect(privacyFold).not.toBeNull();
    expect(
      privacyFold!.querySelectorAll("[data-action-id]").length,
    ).toBe(1);
  });

  test("a DESTRUCTIVE action takes TWO presses — the first arms (face changes, nothing runs), the second fires", async () => {
    const { container } = openAllFolds();
    const clear = container.querySelector<HTMLButtonElement>(
      '[data-verb-id="actions/context.clear"]',
    )!;
    expect(clear).not.toBeNull();
    fireEvent.click(clear);
    // Armed, not run: the face names what a second press does.
    expect(executeActionMock).not.toHaveBeenCalled();
    expect(clear.textContent).toBe("confirm");
    expect(clear.getAttribute("data-state")).toBe("armed");
    // Past the settle window (one double-click must never fire) and inside
    // the arm window — the same band the recycle confirm's rule allows.
    await vi.advanceTimersByTimeAsync(200);
    fireEvent.click(clear);
    expect(executeActionMock).toHaveBeenCalledTimes(1);
    expect(executeActionMock).toHaveBeenCalledWith("context.clear");
    await waitFor(() => {
      const line = container.querySelector(
        '[data-action-id="context.clear"] [role="status"]',
      );
      expect(line?.textContent).toContain("Clear — done");
    });
  });

  test("a SAFE action fires on ONE press and never wears the confirm face", async () => {
    const { container } = openAllFolds();
    const retrieve = container.querySelector<HTMLButtonElement>(
      '[data-verb-id="actions/context.retrieveMemory"]',
    )!;
    fireEvent.click(retrieve);
    expect(retrieve.textContent).not.toBe("confirm");
    expect(executeActionMock).toHaveBeenCalledTimes(1);
    expect(executeActionMock).toHaveBeenCalledWith("context.retrieveMemory");
    await waitFor(() => {
      expect(
        container.querySelector('[data-action-id="context.retrieveMemory"] [role="status"]')
          ?.textContent,
      ).toContain("Retrieve Memory — done");
    });
  });

  test("an action that returned NOTHING renders absence, never the string \"null\"", async () => {
    // THE DEFECT THIS PINS: `compactActionResult` ended
    // `JSON.stringify(result) ?? "null"`, and `JSON.stringify(undefined)` is
    // `undefined` — so an action whose execute returned nothing printed
    // "Retrieve Memory — done · null", a value nobody sent.
    executeActionMock.mockResolvedValueOnce(undefined);
    const { container } = openAllFolds();
    const retrieve = container.querySelector<HTMLButtonElement>(
      '[data-verb-id="actions/context.retrieveMemory"]',
    )!;
    fireEvent.click(retrieve);
    await waitFor(() => {
      expect(
        container.querySelector('[data-action-id="context.retrieveMemory"] [role="status"]')
          ?.textContent,
      ).toContain("the action ran and returned no result");
    });
    const line = container.querySelector('[data-action-id="context.retrieveMemory"] [role="status"]')!;
    expect(line.textContent).not.toContain("null");
    expect(line.textContent).toContain("Retrieve Memory — done");
  });

  test("a JSON null result is still shown as the value the action returned", async () => {
    // The other half: a real `null` result is a measured value, not absence.
    executeActionMock.mockResolvedValueOnce(null);
    const { container } = openAllFolds();
    fireEvent.click(
      container.querySelector<HTMLButtonElement>('[data-verb-id="actions/context.retrieveMemory"]')!,
    );
    await waitFor(() => {
      expect(
        container.querySelector('[data-action-id="context.retrieveMemory"] [role="status"]')
          ?.textContent,
      ).toContain("done · null");
    });
  });

  test("an action with REQUIRED arguments renders disabled with its reason and runs nothing", () => {
    const { container } = openAllFolds();
    const setTier = container.querySelector<HTMLButtonElement>(
      '[data-verb-id="actions/privacy.setTier"]',
    )!;
    expect(setTier.disabled).toBe(true);
    expect(
      container.querySelector('[data-action-id="privacy.setTier"] .act-reason')?.textContent,
    ).toContain("needs tier, enabled");
    fireEvent.click(setTier);
    expect(executeActionMock).not.toHaveBeenCalled();
  });

  test("an armed destructive verb DISARMS ITSELF when the documented window passes", async () => {
    // THE DISARM TITLE'S PROMISE, KEPT (UIE-007): "reverts on its own after
    // 4s". For two rounds the window existed only as a number the SECOND
    // press was judged by — an armed confirm sat armed forever, and a reader
    // returning to the fold minutes later fired a destructive action with
    // one press believing it fresh. The arm now carries its own clock.
    // MUTATION: remove the auto-disarm effect and this fails at the face
    // still reading "confirm" after the window.
    const { container } = openAllFolds();
    const clear = container.querySelector<HTMLButtonElement>(
      '[data-verb-id="actions/context.clear"]',
    )!;
    fireEvent.click(clear);
    expect(clear.textContent).toBe("confirm");
    // Just inside the window: still armed…
    await vi.advanceTimersByTimeAsync(ACTION_ARM_WINDOW_MS - 100);
    expect(clear.textContent).toBe("confirm");
    expect(clear.getAttribute("data-state")).toBe("armed");
    // …and the window passing stands it down on its own, without running
    // anything — the face returns to the resting label.
    await vi.advanceTimersByTimeAsync(200);
    expect(clear.textContent).toBe("clear");
    expect(clear.getAttribute("data-state")).toBeNull();
    expect(executeActionMock).not.toHaveBeenCalled();
    // A press after the auto-disarm is a FIRST press again: it re-arms
    // rather than firing — the window that judged the second press and the
    // window that reverted the face are the same one.
    fireEvent.click(clear);
    expect(executeActionMock).not.toHaveBeenCalled();
    expect(clear.textContent).toBe("confirm");
  });

  test("the disarm verb inside the window stands the arm down and the timer never fires it", async () => {
    const { container } = openAllFolds();
    const clear = container.querySelector<HTMLButtonElement>(
      '[data-verb-id="actions/context.clear"]',
    )!;
    fireEvent.click(clear);
    fireEvent.click(
      container.querySelector<HTMLButtonElement>(
        '[data-actions-fold="context"] [data-verb-id="instruments.actions/disarm"]',
      )!,
    );
    expect(clear.textContent).toBe("clear");
    // Long past the window: nothing was left armed, and nothing fires.
    await vi.advanceTimersByTimeAsync(ACTION_ARM_WINDOW_MS * 3);
    expect(clear.textContent).toBe("clear");
    expect(executeActionMock).not.toHaveBeenCalled();
  });

  test("unmounting the room clears the arm's timer — it never outlives the surface", async () => {
    const rendered = openAllFolds();
    const clear = rendered.container.querySelector<HTMLButtonElement>(
      '[data-verb-id="actions/context.clear"]',
    )!;
    fireEvent.click(clear);
    expect(clear.textContent).toBe("confirm");
    rendered.unmount();
    // Nothing is left to write to, and advancing past the window throws
    // no "state set after unmount" and fires nothing.
    await vi.advanceTimersByTimeAsync(ACTION_ARM_WINDOW_MS * 2);
    expect(executeActionMock).not.toHaveBeenCalled();
  });

  test("an armed destructive verb can be stood down without running anything", () => {
    const { container } = openAllFolds();
    const clear = container.querySelector<HTMLButtonElement>(
      '[data-verb-id="actions/context.clear"]',
    )!;
    fireEvent.click(clear);
    expect(clear.textContent).toBe("confirm");
    fireEvent.click(
      container.querySelector<HTMLButtonElement>(
        '[data-actions-fold="context"] [data-verb-id="instruments.actions/disarm"]',
      )!,
    );
    expect(clear.textContent).toBe("clear");
    expect(executeActionMock).not.toHaveBeenCalled();
  });

  test("a REFUSED execution renders the server's sentence in the answer grammar, not as silence", async () => {
    // The refusal must be the TYPED client error the reconstruction mints —
    // refusalReason classifies by instance + status + typed code, never by
    // shape, so an untyped stand-in would silently render as a failure.
    const { ClientError: TypedClientError } = await import("../../src/data/errors.ts");
    executeActionMock.mockRejectedValueOnce(
      new TypedClientError(
        "git_not_run",
        "the action was refused because this server would not run git",
        503,
      ),
    );
    const { container } = openAllFolds();
    fireEvent.click(
      container.querySelector<HTMLButtonElement>('[data-verb-id="actions/context.retrieveMemory"]')!,
    );
    await waitFor(() => {
      const refusedLine = container.querySelector(
        '[data-action-id="context.retrieveMemory"] [data-answer="refused"]',
      );
      expect(refusedLine?.textContent).toContain("would not run git");
    });
  });

  test("a FAILED execution renders as an alert with what broke", async () => {
    executeActionMock.mockRejectedValueOnce(new Error("the harness lost the disk"));
    const { container } = openAllFolds();
    fireEvent.click(
      container.querySelector<HTMLButtonElement>('[data-verb-id="actions/context.retrieveMemory"]')!,
    );
    await waitFor(() => {
      const failedLine = container.querySelector(
        '[data-action-id="context.retrieveMemory"] [data-answer="failed"]',
      );
      expect(failedLine?.textContent).toContain("the harness lost the disk");
    });
  });

  test("NON-ADMIN: every fold verb is disabled with the wire door's own reason", () => {
    authState.set({ ...initialAuth, authenticated: true, isAdmin: false, username: "member" });
    const { container } = openAllFolds();
    const verbs = [...container.querySelectorAll<HTMLButtonElement>('[data-verb-id^="actions/"]')];
    expect(verbs.length).toBe(SCHEMA.actions.length);
    for (const verb of verbs) {
      expect(verb.disabled).toBe(true);
    }
    fireEvent.click(verbs[0]!);
    expect(executeActionMock).not.toHaveBeenCalled();
  });
});
