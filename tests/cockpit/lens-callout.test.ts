// @vitest-environment jsdom
/**
 * THE LENS CALLOUT (⌘L then hover) — spec §9.2.
 *
 * What must hold:
 *   - the callout SPEAKS ONLY what the Broker recorded or the pixel
 *     declared: a real read produces the block + age + how it was answered;
 *     an unbound pixel gets the absence sentence — the no-invention law is
 *     mutation-tested (a fabricated source must be impossible to produce);
 *   - it is a hairline callout, not a panel: one small fixed element, no
 *     room, no scope;
 *   - verbs are mechanically derived: adjust only where the registry links a
 *     setting, open-source only where the room is BUILT;
 *   - ZERO COST WHEN CLOSED: disarmed it renders nothing and the provenance
 *     ledger has ZERO listeners (the ledger's own counter proves it);
 *     arming attaches, disarming/unmount detaches every listener.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/svelte";

import LensCallout from "../../src/cockpit/lens/LensCallout.svelte";
import {
  actionClause,
  ageWords,
  calloutVerbs,
  derivationNote,
  readTarget,
  sourceLine,
} from "../../src/cockpit/lens/lens-callout-data.ts";
import { read as brokerRead, clearCache } from "../../src/data/broker.ts";
import { ASK_PREFILL } from "../../src/cockpit/computer/ask.ts";
import {
  actionLog,
  clearProvenance,
  provenanceListenerCount,
  recordAction,
} from "../../src/data/ledger.ts";
import type { ActionProvenanceRecord } from "../../shared/provenance.ts";
import { resetUiSchema, setUiSchema, setUiSchemaValues } from "../../src/state/schema-store.ts";
import { SCHEMA, VALUES } from "./fixtures/settings-schema.ts";
import type {
  DismissRequest,
  GrammarTarget,
  RoomId,
  ShellApi,
} from "../../src/cockpit/shell/contract.ts";
import type { ProvenanceAnswer } from "../../shared/provenance.ts";

vi.mock("../../src/cockpit/shell/outlets.ts", () => ({
  outletExists: () => false,
  loadOutlet: async () => null,
  loadRoom: async () => null,
  roomExists: (id: string) => id === "tools" || id === "settings",
}));

type Harness = ShellApi & {
  fireLens: () => void;
  /** Run the shell's Esc: dismiss the innermost registered layer. */
  fireEscape: () => void;
  /** Plain-words labels of the layers currently registered, outermost first. */
  layers: () => readonly string[];
  hints: () => readonly string[];
  rooms: () => readonly RoomId[];
  prefills: () => readonly string[];
  scopes: () => readonly unknown[];
};

function makeShell(): Harness {
  const claimsMap = new Map<GrammarTarget, (ev: { shift: boolean }) => void>();
  const dismissals: DismissRequest[] = [];
  const hints: string[] = [];
  const rooms: RoomId[] = [];
  const prefills: string[] = [];
  const scopes: unknown[] = [];
  return {
    revealAt: () => 0,
    openRoom: (id) => rooms.push(id),
    closeRoom: () => {},
    openScope: (req) => scopes.push(req),
    closeScope: () => {},
    setAnnunciators: () => {},
    setMonitors: () => {},
    claimKey: (target, handler) => {
      claimsMap.set(target, handler);
      return () => claimsMap.delete(target);
    },
    // A miniature of the shell's dismissal ladder: push on open, release on
    // close, and Esc takes the TOP. LENS registering here (instead of a
    // capture-phase listener of its own) is the behaviour under test.
    pushDismiss: (req) => {
      dismissals.push(req);
      return () => {
        const at = dismissals.indexOf(req);
        if (at >= 0) dismissals.splice(at, 1);
      };
    },
    hint: (t) => hints.push(t),
    composerText: () => "",
    onComposerSubmit: () => () => {},
    prefillComposer: (t) => prefills.push(t),
    clearComposer: () => {},
    restoreComposerText: () => {},
    onComposerChange: () => () => {},
    setDeskLine: () => {},
    fireLens: () => claimsMap.get("lens")?.({ shift: false }),
    fireEscape: () => dismissals[dismissals.length - 1]?.dismiss(),
    layers: () => dismissals.map((d) => d.label),
    hints: () => hints,
    rooms: () => rooms,
    prefills: () => prefills,
    scopes: () => scopes,
  };
}

/** Hover a real element — pointerover is captured on window. */
function hover(el: Element): Promise<void> {
  return fireEvent(
    el,
    new (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent("pointerover", {
      bubbles: true,
      clientX: 40,
      clientY: 40,
    }) as Event,
  ) as unknown as Promise<void>;
}

beforeEach(() => {
  cleanup();
  clearCache();
  clearProvenance();
  resetUiSchema();
  setUiSchema(SCHEMA);
  setUiSchemaValues(VALUES);
  // jsdom has no PointerEvent — MouseEvent carries the fields the callout reads.
  if (!("PointerEvent" in (window as unknown as Record<string, unknown>))) {
    (window as unknown as { PointerEvent: unknown }).PointerEvent = window.MouseEvent;
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ data: { n: 1 }, meta: { etag: 'W/"1"', asOf: Date.now() } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearProvenance();
  resetUiSchema();
});

// ── pure model ────────────────────────────────────────────────────────────

describe("the source line — record or honest absence, NOTHING else", () => {
  const NONE = { provKey: null, settingId: null, signalId: null, inFinding: false };

  test("a recorded read speaks the block, its age and how it was answered", () => {
    const answer: ProvenanceAnswer = {
      kind: "record",
      record: {
        key: "tools.breaker",
        block: "tools.breaker",
        cacheState: "fresh",
        requestedAt: 1000,
        settledAt: 1200,
        latencyMs: 200,
        asOf: 1000,
        ttlMs: 5000,
        causality: {},
      },
    };
    expect(sourceLine(NONE, answer, 2200)).toBe(
      "tools.breaker · 1.2s ago · fresh from the server",
    );
  });

  test("a failed read says so with its typed code", () => {
    const answer: ProvenanceAnswer = {
      kind: "record",
      record: {
        key: "k",
        block: "code.graph",
        cacheState: "failed",
        requestedAt: 1,
        settledAt: 2,
        latencyMs: 1,
        ttlMs: 1,
        causality: {},
        errorCode: "timeout",
      },
    };
    expect(sourceLine(NONE, answer, 2)).toMatch(/code\.graph · read failed · timeout/);
  });

  test("bound but never read says exactly that", () => {
    expect(sourceLine(NONE, { kind: "absent", reason: "unresolved", key: "x" }, 0)).toBe(
      "bound to “x” — nothing has read it yet",
    );
  });

  test("mutation: an UNBOUND pixel can never produce a source — only the absence", () => {
    const line = sourceLine(NONE, { kind: "absent", reason: "unbound" }, 0);
    expect(line).toBe(
      "this pixel declares no source — nothing here is bound to a recorded read",
    );
    // No block id, no time, no via-clause can appear out of nowhere.
    expect(line).not.toMatch(/ago|server|cache/);
  });

  test("a stamped declaration speaks for itself when no read backs it", () => {
    expect(
      sourceLine({ ...NONE, settingId: "tools.parallelCap" }, { kind: "absent", reason: "unbound" }, 0),
    ).toMatch(/setting “tools.parallelCap” — served by this install's registry/);
    expect(
      sourceLine({ ...NONE, signalId: "tools.activeCalls" }, null, 0),
    ).toMatch(/signal “tools.activeCalls” — measured/);
  });

  test("derivation note only inside a computed finding", () => {
    expect(derivationNote({ ...NONE, inFinding: true })).toMatch(/computed/);
    expect(derivationNote(NONE)).toBeNull();
  });

  test("ages read as measured durations", () => {
    expect(ageWords(1000, 1200)).toBe("just now");
    expect(ageWords(0, 90_000)).toBe("1m ago");
  });
});

describe("verbs — mechanically derived only (§1.2)", () => {
  const deps = {
    schema: SCHEMA,
    roomExists: (id: string) => id === "tools" || id === "settings",
    openSheet: () => {},
    openForSignal: () => {},
    prefill: () => {},
    openRoom: () => {},
  };
  const NONE = { provKey: null, settingId: null, signalId: null, inFinding: false };

  test("a stamped setting gets adjust + open index", () => {
    const ids = calloutVerbs({ ...NONE, settingId: "tools.parallelCap" }, null, deps).map(
      (v) => v.id,
    );
    expect(ids).toContain("lens.adjust");
    expect(ids).toContain("lens.ask");
    expect(ids).toContain("lens.open-source");
  });

  test("a signal the registry links gets adjust", () => {
    const ids = calloutVerbs({ ...NONE, signalId: "tools.activeCalls" }, null, deps).map((v) => v.id);
    expect(ids).toContain("lens.adjust");
  });

  test("mutation: a fact with NO linked setting gets NO adjust verb", () => {
    const ids = calloutVerbs({ ...NONE, signalId: "sweep.spectrum" }, null, deps).map((v) => v.id);
    expect(ids).not.toContain("lens.adjust");
  });

  test("mutation: open-source appears only for a BUILT room", () => {
    const record = {
      kind: "record" as const,
      record: {
        key: "k",
        block: "tools.breaker",
        cacheState: "fresh" as const,
        requestedAt: 1,
        settledAt: 1,
        latencyMs: 0,
        ttlMs: 1,
        causality: {},
      },
    };
    expect(calloutVerbs(NONE, record, deps).map((v) => v.label)).toContain("open tools");
    const noRooms = { ...deps, roomExists: () => false };
    expect(calloutVerbs(NONE, record, noRooms).map((v) => v.id)).not.toContain(
      "lens.open-source",
    );
  });

  test("ask is absent when the composer cannot be prefilled (never inert)", () => {
    const noPrefill = { ...deps, prefill: null };
    expect(calloutVerbs(NONE, null, noPrefill).map((v) => v.id)).not.toContain("lens.ask");
  });

  test("the ask verb prefills the grammar's bare leader — never a phrase of its own", () => {
    // The same ask-door contract the instruments room's cells follow: the
    // verb opens the grammar at its leader and the composer's own menu
    // enumerates the questions. A prefilled phrase built from the callout's
    // subject (a setting name, a signal name) is a question the grammar can
    // never parse — the send answers only the unknown-keyword refusal.
    const got: string[] = [];
    const recording = { ...deps, prefill: (t: string) => got.push(t) };
    const ask = calloutVerbs(NONE, null, recording).find((v) => v.id === "lens.ask")!;
    expect(ask).toBeDefined();
    ask.run();
    expect(got).toEqual([ASK_PREFILL]);
  });
});

describe("stamp resolution", () => {
  test("walks ancestors for prov / setting / signal / finding stamps", () => {
    document.body.innerHTML =
      '<div data-prov="tools.breaker"><section data-finding><span data-signal="tools.activeCalls"><b id="leaf">4</b></span></section></div>';
    const t = readTarget(document.getElementById("leaf"));
    expect(t.provKey).toBe("tools.breaker");
    expect(t.signalId).toBe("tools.activeCalls");
    expect(t.inFinding).toBe(true);
    expect(t.settingId).toBeNull();
  });
});

// ── the action clause ("you changed this") ────────────────────────────────

describe("the action clause — only what the Broker's write side recorded", () => {
  const recordAnswer = (block: string): ProvenanceAnswer => ({
    kind: "record",
    record: {
      key: block,
      block,
      cacheState: "fresh",
      requestedAt: 1000,
      settledAt: 1000,
      latencyMs: 0,
      ttlMs: 5000,
      causality: {},
    },
  });

  function act(
    block: string,
    action: string,
    state: "done" | "failed",
    settledAt: number,
  ): ActionProvenanceRecord {
    return {
      key: `${block}/${action}`,
      origin: "operator",
      block,
      action,
      state,
      requestedAt: settledAt,
      settledAt,
      latencyMs: 0,
      causality: {},
    };
  }

  test("a recorded action on the SAME block speaks, with the clock time it settled", () => {
    const at = new Date(2026, 0, 2, 12, 55).getTime();
    const line = actionClause(recordAnswer("run.compose"), [act("run.compose", "pin", "done", at)]);
    expect(line).toBe("changed by you at 12:55 · recorded");
  });

  test("a FAILED action says nothing changed — it never reads as a success", () => {
    const at = new Date(2026, 0, 2, 9, 5).getTime();
    const line = actionClause(recordAnswer("tools.breaker"), [
      act("tools.breaker", "set", "failed", at),
    ]);
    expect(line).toBe("your change at 09:05 did not go through · recorded");
  });

  test("the NEWEST matching row wins (the log is oldest-first)", () => {
    const early = new Date(2026, 0, 2, 8, 0).getTime();
    const late = new Date(2026, 0, 2, 17, 30).getTime();
    expect(
      actionClause(recordAnswer("run.compose"), [
        act("run.compose", "pin", "done", early),
        act("run.compose", "unpin", "done", late),
      ]),
    ).toBe("changed by you at 17:30 · recorded");
  });

  test("MUTATION: an action on ANOTHER block is never borrowed", () => {
    expect(
      actionClause(recordAnswer("run.compose"), [act("tools.breaker", "set", "done", 1000)]),
    ).toBeNull();
  });

  test("MUTATION: no recorded action at all → NO clause (never 'changed by you')", () => {
    expect(actionClause(recordAnswer("run.compose"), [])).toBeNull();
  });

  test("MUTATION: an unbound or unresolved pixel gets no clause however many actions exist", () => {
    expect(actionClause(null, [act("run.compose", "pin", "done", 1000)])).toBeNull();
    expect(
      actionClause({ kind: "absent", reason: "unbound" }, [act("run.compose", "pin", "done", 1000)]),
    ).toBeNull();
    expect(
      actionClause({ kind: "absent", reason: "unresolved", key: "run.compose?chatId=c" }, [
        act("run.compose", "pin", "done", 1000),
      ]),
    ).toBeNull();
  });
});

// ── live component ────────────────────────────────────────────────────────

describe("armed / disarmed behavior", () => {
  test("ZERO COST when closed: nothing renders, the ledger has no listeners", () => {
    const { container } = render(LensCallout, { shell: makeShell() });
    expect(container.querySelector(".callout")).toBeNull();
    expect(provenanceListenerCount()).toBe(0);
  });

  test("⌘L arms, hover speaks a REAL recorded read, Esc disarms and releases", async () => {
    // A genuine Broker read — the choke point writes the ledger itself.
    await brokerRead("tools.breaker", { ttlMs: 60_000 });
    const shell = makeShell();
    const { container } = render(LensCallout, { shell });
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div data-prov="tools.breaker"><b id="pixel">4</b></div>',
    );

    shell.fireLens();
    await waitFor(() => expect(provenanceListenerCount()).toBe(1));
    await hover(document.getElementById("pixel")!);

    await waitFor(() => expect(container.querySelector(".callout")).toBeTruthy());
    const callout = container.querySelector(".callout")!;
    expect(callout.textContent).toMatch(/tools\.breaker/);
    expect(callout.textContent).toMatch(/fresh from the server|from the client's cache/);
    // A hairline callout, NOT a panel: ONE element, positioned in place, and
    // it opens no room and no scope to say what it says.
    expect(container.querySelectorAll(".callout").length).toBe(1);
    expect((callout as HTMLElement).style.left).toMatch(/px$/);
    expect((callout as HTMLElement).style.top).toMatch(/px$/);
    expect(shell.scopes().length).toBe(0);
    expect(shell.rooms().length).toBe(0);

    // ARMED IS A DISMISSAL LAYER, not a capture-phase listener of its own.
    // LENS used to take Esc off `window` in capture, because the shell's
    // `claimKey` was last-claim-wins and the SWEEP had already taken the key.
    // It now registers with the shell, so a raw Escape reaching the window
    // does NOTHING here — the shell is the only router of that key.
    expect(shell.layers()).toEqual(["LENS"]);
    await fireEvent.keyDown(window, { key: "Escape" });
    expect(container.querySelector(".callout")).toBeTruthy();

    // …and the shell dismissing the innermost layer is what disarms it.
    shell.fireEscape();
    await waitFor(() => expect(container.querySelector(".callout")).toBeNull());
    expect(provenanceListenerCount()).toBe(0);
    // Disarmed holds no layer either — Esc must not keep landing on LENS.
    expect(shell.layers()).toEqual([]);
  });

  test("an unbound pixel gets the absence sentence, never an invented source", async () => {
    const shell = makeShell();
    const { container } = render(LensCallout, { shell });
    document.body.insertAdjacentHTML("beforeend", '<b id="bare">plain</b>');
    shell.fireLens();
    await hover(document.getElementById("bare")!);
    await waitFor(() => expect(container.querySelector(".callout")).toBeTruthy());
    expect(container.querySelector(".callout")!.textContent).toMatch(
      /declares no source/,
    );
  });

  test("a SECOND hover retargets while the callout is mounted (no throw)", async () => {
    const shell = makeShell();
    const { container } = render(LensCallout, { shell });
    document.body.insertAdjacentHTML(
      "beforeend",
      '<b id="one">a</b><div data-setting="tools.parallelCap"><b id="two">b</b></div>',
    );
    shell.fireLens();
    await hover(document.getElementById("one")!);
    await waitFor(() => expect(container.querySelector(".callout")).toBeTruthy());
    expect(container.querySelector(".callout")!.textContent).toMatch(/declares no source/);
    // The callout is now MOUNTED; hovering a different pixel must retarget it
    // (the self-hover guard must not trip on a live element reference).
    await hover(document.getElementById("two")!);
    await waitFor(() =>
      expect(container.querySelector(".callout")!.textContent).toMatch(/tools\.parallelCap/),
    );
  });

  test("adjust on a stamped setting opens THE sheet through the shell scope", async () => {
    const shell = makeShell();
    const { container, findByText } = render(LensCallout, { shell });
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div data-setting="tools.parallelCap"><b id="stamped">4</b></div>',
    );
    shell.fireLens();
    await hover(document.getElementById("stamped")!);
    await waitFor(() => expect(container.querySelector(".callout")).toBeTruthy());
    await fireEvent.click(await findByText("adjust"));
    expect(shell.scopes().length).toBe(1);
    expect((shell.scopes()[0] as { props: { settingId: string } }).props.settingId).toBe(
      "tools.parallelCap",
    );
    // Acting closes the callout — the instrument is not left armed over a sheet.
    expect(container.querySelector(".callout")).toBeNull();
  });

  test("MUTATION: a stamp naming a record that does NOT exist says so — it never invents one", async () => {
    // The failure this guards: someone stamps a region with a key nothing
    // ever read (a typo, a param that drifted from the reader's). The
    // callout must report the gap, not dress the region up with the nearest
    // plausible record.
    await brokerRead("tools.breaker", { ttlMs: 60_000 });
    const shell = makeShell();
    const { container } = render(LensCallout, { shell });
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div data-prov="tools.breaker?chatId=never-read"><b id="fake">4</b></div>',
    );
    shell.fireLens();
    await hover(document.getElementById("fake")!);
    await waitFor(() => expect(container.querySelector(".callout")).toBeTruthy());
    const text = container.querySelector(".callout")!.textContent ?? "";
    // It names the key it was asked about and states that nothing read it…
    expect(text).toMatch(/tools\.breaker\?chatId=never-read/);
    expect(text).toMatch(/nothing has read it yet/);
    // …and borrows NOTHING from the record that does exist for the sibling key.
    expect(text).not.toMatch(/fresh from the server|from the client's cache/);
    expect(text).not.toMatch(/ago/);
  });

  test("a recorded ACTION on the region's block adds the honest 'changed by you' clause", async () => {
    await brokerRead("tools.breaker", { ttlMs: 60_000 });
    // The write-side row the Broker's choke point writes for a real action.
    recordAction({
      origin: "operator",
      block: "tools.breaker",
      action: "set",
      state: "done",
      requestedAt: Date.now() - 10,
      settledAt: Date.now(),
    });
    expect(actionLog().length).toBe(1);

    const shell = makeShell();
    const { container } = render(LensCallout, { shell });
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div data-prov="tools.breaker"><b id="acted">4</b></div>',
    );
    shell.fireLens();
    await hover(document.getElementById("acted")!);
    await waitFor(() => expect(container.querySelector(".callout")).toBeTruthy());
    await waitFor(() =>
      expect(container.querySelector(".callout")!.textContent).toMatch(
        /changed by you at \d{2}:\d{2} · recorded/,
      ),
    );
  });

  test("MUTATION: with no recorded action the clause is ABSENT, not empty-worded", async () => {
    await brokerRead("tools.breaker", { ttlMs: 60_000 });
    const shell = makeShell();
    const { container } = render(LensCallout, { shell });
    document.body.insertAdjacentHTML(
      "beforeend",
      '<div data-prov="tools.breaker"><b id="untouched">4</b></div>',
    );
    shell.fireLens();
    await hover(document.getElementById("untouched")!);
    await waitFor(() => expect(container.querySelector(".callout")).toBeTruthy());
    expect(container.querySelector(".callout")!.textContent).not.toMatch(/changed by you/);
  });

  test("unmount releases every listener even while armed", async () => {
    const shell = makeShell();
    const view = render(LensCallout, { shell });
    shell.fireLens();
    await waitFor(() => expect(provenanceListenerCount()).toBe(1));
    view.unmount();
    await waitFor(() => expect(provenanceListenerCount()).toBe(0));
  });
});
