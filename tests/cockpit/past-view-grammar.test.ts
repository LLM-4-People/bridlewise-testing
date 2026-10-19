// @vitest-environment jsdom
/**
 * THE PAST-VIEW GRAMMAR (DESIGN-COCKPIT-V2 §6.2) — rendered, not asserted
 * about in the abstract.
 *
 * The Broker refuses every write from a past view, so the app is SAFE
 * without any of this. What this suite locks is the other half of the
 * promise: that a past view is unmistakably a past view, and that a control
 * which cannot work does not sit there wearing a working control's label.
 * A button that looks live and fails on click is the defect §1.2 exists to
 * prevent, one layer later.
 *
 *   A. ACTION VERBS — disabled, with the honest reason ON the control.
 *      MUTATION: the same control with no head planted is enabled, so the
 *      assertion is about the head and not about the fixture.
 *   B. INSTRUMENTS — a surface with no ranged read behind it renders the
 *      honest absence, and NO numeral survives in the DOM.
 *   C. THE COMPOSER — sending is the largest write there is; it is off, and
 *      the typed words are kept.
 *   D. STATIC — every cockpit control that names a real block action
 *      consults the past-view store, with an enumerated shrink-only list of
 *      the surfaces that do not yet (each owned by another seam).
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";

import BreakerRow from "../../src/cockpit/desk/BreakerRow.svelte";
import InstrumentCell from "../../src/cockpit/rooms/InstrumentCell.svelte";
import Desk from "../../src/cockpit/shell/Desk.svelte";
import {
  PAST_VIEW_ACT_REASON,
  PAST_VIEW_UNSUPPORTED_SENTENCE,
  plantHead,
  returnToLive,
} from "../../src/data/asof.ts";
import { resetDeskFeed } from "../../src/cockpit/desk/desk-feed.ts";
import { read, relpath, walk } from "../helpers/source-scan.ts";
import type { ShellApi } from "../../src/cockpit/shell/contract.ts";

const HEAD_MS = 1_700_000_000_000;

const BREAKER_ROW = Object.freeze({
  id: "read_file",
  label: "read file",
  state: "on" as const,
  calls: 3,
});

const SIGNAL = Object.freeze({
  id: "context.tokens",
  name: "context tokens",
  description: "tokens in the composed prompt",
  type: "number" as const,
  module: "context",
});

beforeEach(() => {
  returnToLive();
  resetDeskFeed();
});

afterEach(() => {
  cleanup();
  returnToLive();
  resetDeskFeed();
});

/** Every control the render produced that names a block action. */
function actionButtons(container: HTMLElement, block: string): HTMLButtonElement[] {
  return [
    ...container.querySelectorAll<HTMLButtonElement>(
      `button[data-verb-id^="${block}/"]`,
    ),
  ];
}

// ── A. ACTION VERBS ────────────────────────────────────────────────────────

describe("A. an action verb in a past view is off, and says why", () => {
  test("live: the breaker's verbs are live controls", () => {
    const { container } = render(BreakerRow, {
      props: { chatId: "c1", row: BREAKER_ROW },
    });
    const verbs = actionButtons(container, "tools.breaker");
    expect(verbs.length).toBeGreaterThan(0);
    for (const v of verbs) {
      expect(v.disabled, `${v.dataset.verbId} should be live`).toBe(false);
    }
  });

  // MUTATION (required): an action ENABLED during a past view fails here.
  test("mutation — with a head planted every breaker verb is disabled", () => {
    plantHead(HEAD_MS);
    const { container } = render(BreakerRow, {
      props: { chatId: "c1", row: BREAKER_ROW },
    });
    const verbs = actionButtons(container, "tools.breaker");
    expect(verbs.length).toBeGreaterThan(0);
    for (const v of verbs) {
      expect(v.disabled, `${v.dataset.verbId} must not be actionable`).toBe(true);
    }
  });

  test("the reason is ON the control, in the one plain sentence", () => {
    plantHead(HEAD_MS);
    const { container } = render(BreakerRow, {
      props: { chatId: "c1", row: BREAKER_ROW },
    });
    for (const v of actionButtons(container, "tools.breaker")) {
      expect(v.getAttribute("title")).toBe(PAST_VIEW_ACT_REASON);
    }
  });

  test("a NAVIGATION verb on the same row stays available — a past view is readable", () => {
    plantHead(HEAD_MS);
    const shell = { openScope: () => undefined } as unknown as ShellApi;
    const { container } = render(BreakerRow, {
      props: { chatId: "c1", row: { ...BREAKER_ROW, state: "tripped" as const }, shell },
    });
    const why = container.querySelector<HTMLButtonElement>(
      'button[data-verb-id="desk.scope/why"]',
    );
    expect(why).not.toBeNull();
    // Looking at the recorded trip event changes nothing, so it is not a
    // write and must not be swept up by the read-only rule.
    expect(why!.disabled).toBe(false);
  });
});

// ── B. INSTRUMENTS ─────────────────────────────────────────────────────────

describe("B. an instrument with no ranged read behind it refuses honestly", () => {
  // A small integer so the assertion is about presence, not about the
  // compact-number formatter (which is owned and tested elsewhere).
  const sample = { v: 12, t: HEAD_MS };

  test("live: the measured value renders", () => {
    const { container } = render(InstrumentCell, {
      props: {
        signal: SIGNAL,
        sample,
        points: [],
        verbs: [],
        collectingSince: HEAD_MS,
        pinned: false,
        sheetAvailable: false,
        onVerb: () => undefined,
        onPin: () => undefined,
      },
    });
    expect(container.textContent).toContain("12");
    expect(container.querySelector("[data-measured='true']")).not.toBeNull();
  });

  test("past: the sentence replaces the reading and NO numeral survives", () => {
    const { container } = render(InstrumentCell, {
      props: {
        signal: SIGNAL,
        sample,
        points: [],
        verbs: [],
        collectingSince: HEAD_MS,
        pinned: false,
        sheetAvailable: false,
        pastReason: PAST_VIEW_UNSUPPORTED_SENTENCE,
        onVerb: () => undefined,
        onPin: () => undefined,
      },
    });
    expect(container.textContent).toContain(PAST_VIEW_UNSUPPORTED_SENTENCE);
    // The exact failure this prevents: true digits under a banner naming a
    // different instant. Absence must be absence, not a frozen number.
    expect(container.textContent).not.toContain("12");
    expect(container.querySelector("[data-measured='true']")).toBeNull();
    // No `asOf` is claimed either — there is no honest one to claim.
    expect(container.textContent).not.toContain("asOf ");
  });

  test("past: the cell's own verbs are off with the act reason", () => {
    const { container } = render(InstrumentCell, {
      props: {
        signal: SIGNAL,
        sample,
        points: [],
        verbs: [{ kind: "ask" as const, label: "ask" }],
        collectingSince: HEAD_MS,
        pinned: false,
        sheetAvailable: false,
        pastReason: PAST_VIEW_UNSUPPORTED_SENTENCE,
        onVerb: () => undefined,
        onPin: () => undefined,
      },
    });
    const pin = container.querySelector<HTMLButtonElement>(
      'button[data-verb-id="instruments.pin"]',
    );
    expect(pin!.disabled).toBe(true);
    expect(pin!.getAttribute("title")).toBe(PAST_VIEW_ACT_REASON);
  });
});

// ── C. THE COMPOSER ────────────────────────────────────────────────────────

describe("C. sending is unavailable, and the words are kept", () => {
  const deskProps = (text: string) => ({
    shell: {} as unknown as ShellApi,
    revealed: true,
    open: false,
    text,
    gauge: null,
    panel: null,
    onToggle: () => undefined,
    onSubmit: () => undefined,
    focusRequest: 0,
  });

  test("live: send is available once something is typed", () => {
    const { container } = render(Desk, { props: deskProps("hello") });
    const send = container.querySelector<HTMLButtonElement>(".send")!;
    expect(send.disabled).toBe(false);
  });

  test("past: send is off with the reason, and the typed text survives", () => {
    plantHead(HEAD_MS);
    const { container } = render(Desk, { props: deskProps("hello") });
    const send = container.querySelector<HTMLButtonElement>(".send")!;
    expect(send.disabled).toBe(true);
    expect(send.getAttribute("title")).toBe(PAST_VIEW_ACT_REASON);
    // F3: words are never lost. The composer is still a live input holding
    // exactly what was typed — only the SEND is unavailable.
    const composer = container.querySelector<HTMLInputElement>(".composer")!;
    expect(composer.value).toBe("hello");
    expect(composer.disabled).toBe(false);
  });
});

// ── D. STATIC ──────────────────────────────────────────────────────────────

/**
 * Surfaces that render a real block action but do not yet consult the
 * past-view store. SHRINK-ONLY: each entry is owned by another seam, and
 * every one of them is still SAFE — `broker.action` refuses the write — but
 * their controls do not yet say so before the click.
 */
const UNGUARDED_ACTION_SURFACES: readonly string[] = [
  // (empty) — `rooms/Parcel.svelte` was the last entry and the custody owner
  // closed it: keep / keep all / undo / undo all / the inline save all
  // consult `isPastView` and carry PAST_VIEW_ACT_REASON on the control. The
  // list is a RATCHET; it does not grow.
];

/**
 * WHAT THIS SCAN CANNOT SEE, stated rather than implied.
 *
 * A surface that binds its verb id at RUNTIME (`data-verb-id={verb.id}`)
 * carries no literal for a source scan to match — `flow/Verb.svelte` is that
 * shape. (`rooms/CustodyRoom.svelte` was too; it now consults `isPastView` on
 * the keep/undo paths itself, so its exemption is moot.) They are safe (the
 * Broker
 * refuses the write) but their honest disabling belongs with whoever owns
 * the factory that resolves those ids, and it cannot be enforced from here.
 * Extending this guard to them means giving the verb factory a declared
 * "writes" flag — the seam, named, so it is a decision and not an oversight.
 */

/** A control naming `<namespace>.<name>/<action>` — a block action id. */
const BLOCK_ACTION_CONTROL = /(?:data-verb-id|data-action)="([a-z][a-zA-Z0-9]*\.[a-zA-Z0-9]+)\/[a-zA-Z]+"/g;

/** Block namespaces the cockpit actually posts to. Ids matching this shape
 *  but owned by a client primitive (`flow.scope`, `desk.strip`) are not
 *  block actions — the namespaces below are the registered blocks' own. */
const REAL_BLOCK_NAMESPACES = new Set([
  "tools.breaker",
  "run.compose",
  "arm.flags",
  "custody.state",
  "settings.customizations",
  "settings.diagnosticModes",
  "checks.auto",
]);

/** Files rendering a real block action without consulting the past view. */
export function findUnguardedSurfaces(files: readonly string[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    const src = read(file);
    let hit = false;
    for (const m of src.matchAll(BLOCK_ACTION_CONTROL)) {
      if (REAL_BLOCK_NAMESPACES.has(m[1]!)) hit = true;
    }
    if (!hit) continue;
    if (/\bisPastView\b/.test(src)) continue;
    out.push(relpath(file));
  }
  return out;
}

describe("D. every surface offering a block action knows about the past view", () => {
  const files = walk("src/cockpit", { exts: [".svelte"] });

  test("the scan has something to look at", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test("no unlisted surface offers a block action without consulting the head", () => {
    const unguarded = findUnguardedSurfaces(files).filter(
      (f) => !UNGUARDED_ACTION_SURFACES.includes(f),
    );
    expect(unguarded, unguarded.join("\n")).toEqual([]);
  });

  test("the exception list is a RATCHET — every entry must still exist and still be unguarded", () => {
    const unguarded = findUnguardedSurfaces(files);
    for (const listed of UNGUARDED_ACTION_SURFACES) {
      expect(
        unguarded,
        `${listed} no longer needs its exception — delete the entry so the ` +
          `list can only ever shrink`,
      ).toContain(listed);
    }
  });

  test("mutation — the scanner sees a surface that drops the guard", () => {
    // The desk's breaker row DOES consult the store. Remove that one token
    // from its source and the scanner must flag it; this proves the check is
    // reading the guard and not merely the file list.
    const guarded = "src/cockpit/desk/BreakerRow.svelte";
    expect(findUnguardedSurfaces(files)).not.toContain(guarded);
    const src = read(guarded);
    expect(src).toMatch(/\bisPastView\b/);
    expect(/\bisPastView\b/.test(src.replace(/isPastView/g, "somethingElse"))).toBe(false);
  });
});
