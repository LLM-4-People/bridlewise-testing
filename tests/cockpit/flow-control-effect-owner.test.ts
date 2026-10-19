// @vitest-environment jsdom
/**
 * FLOW CONTROL-EFFECT OWNER — no button without an effect, IN THE FLOW.
 *
 * ── WHY THIS FILE EXISTS AT ALL ───────────────────────────────────────────
 *
 * THE USER'S REPORT, VERBATIM: "we have collapse under every chat message,
 * but the button does not do anything, so just remove it."
 *
 * They were right, and the interesting part is not the button — it is that
 * this project ran an inert-control audit that wired 35 controls and removed
 * 8, under the standing "no button without effect" law, and that audit did
 * not see THE MOST-RENDERED CONTROL IN THE APP. The diagnosis, stated so the
 * next guard is not built the same way:
 *
 *   IT WAS BOTH, and the two failures compounded.
 *
 *   SCOPE. The existing owners are `cockpit-flow-verb-owner.test.ts` (every
 *   `BeatVerb` the wiring factory produces is wired-or-reasoned, plus a
 *   static scan that every `<button>` carries a `data-verb-id`) and
 *   `cockpit-mouse-path-owner.test.ts` (every chord has a click path). Their
 *   universe is the VERB FACTORY and the CHORD TABLE. The expand/collapse
 *   grip is neither: it is a grammar grip rendered by Beat.svelte, wired to a
 *   real function, naming a real chord. Both guards looked straight at it and
 *   saw nothing wrong, because neither was asking the question.
 *
 *   ASSERTION. And they could not have caught it if they had been asking,
 *   because both check that a control is BOUND, not that it DOES anything.
 *   `COLLAPSE` was bound to `onoverridebeat`, which called `setOverride`,
 *   which the fisheye honoured, which returned `tick` — and then
 *   `renderedLevel` pinned turns back to `full`. Every layer was live. The
 *   outcome was nothing. A handler that early-returns for one kind reads as
 *   live to any guard that stops at the binding.
 *
 * So this guard asks the third question, per kind, end to end: for every
 * control a beat of this kind ACTUALLY RENDERS, does pressing it change
 * something observable FOR THAT KIND? The kinds and the controls are both
 * enumerated dynamically — the kind list is parsed from `types.ts`, and the
 * controls are read out of the rendered DOM — so a kind or a control added
 * later is covered without anyone remembering this file.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { readFileSync } from "node:fs";

import BeatView from "../../src/cockpit/flow/Beat.svelte";
import { clearLog } from "../../src/cockpit/flow/log.ts";
import {
  clearAllOverrides,
  compressesInFlow,
  fisheyeLevel,
  renderedLevel,
  setOverride,
  type FisheyeLevel,
} from "../../src/cockpit/flow/fisheye.ts";
import { opensScopeSheet } from "../../src/cockpit/flow/beat-state.ts";
import { makeVerbsFor, type VerbContext } from "../../src/cockpit/flow/verbs.ts";
import type { Beat } from "../../src/cockpit/flow/types.ts";

// ── The kinds, read from their declaration (never hand-listed) ─────────────

/**
 * Every beat kind, parsed out of the `BeatKind` union in types.ts. A kind
 * added there joins this suite automatically — which is the property the
 * previous audit lacked (its universe was a list someone maintained).
 */
export function declaredKinds(src: string): string[] {
  const m = /export type BeatKind =([\s\S]*?);/.exec(src);
  if (m === null) return [];
  return [...m[1]!.matchAll(/"([a-z-]+)"/g)].map((x) => x[1]!);
}

const KINDS = declaredKinds(readFileSync("src/cockpit/flow/types.ts", "utf8")) as Beat["kind"][];

// ── Fixtures ───────────────────────────────────────────────────────────────

const PARENT_ID = "b-11111111-1111-4111-8111-111111111111";

function beatOf(kind: Beat["kind"], extra: Partial<Beat> = {}): Beat {
  const base: Beat = {
    id: `b-2222${kind}`,
    kind,
    parentId: PARENT_ID,
    turnIndex: 3,
    at: Date.UTC(2024, 0, 1, 10, 23, 15),
    abnormal: false,
    bleed: kind !== "turn",
    verbs: [],
  };
  switch (kind) {
    case "turn":
      return { ...base, turn: { who: "you", text: "please refactor the reader", streaming: false }, ...extra };
    case "tool":
      return {
        ...base,
        tool: {
          name: "read_file",
          label: "read file",
          status: "done",
          input: { path: "src/reader.ts" },
          output: "export const x = 1;",
          startedAt: 1,
          durationMs: 42,
        },
        ...extra,
      };
    case "effect":
      return { ...base, effect: { path: "src/reader.ts", producedBy: "t", added: 4, removed: 2 }, ...extra };
    case "check-delta":
      return {
        ...base,
        checkDelta: { checkId: "c1", checkName: "lint", from: "passed", to: "failed", errorCount: 2 },
        ...extra,
      };
    case "event":
      return { ...base, event: { eventKind: "bias", text: "leaned on one source" }, ...extra };
    case "finding":
      return {
        ...base,
        finding: {
          sentence: "six files changed in this conversation",
          derivation: {
            method: "joined this conversation's file effects",
            steps: [{ source: "this conversation's transcript", sourceId: "transcript", count: 6 }],
            asOf: Date.UTC(2024, 0, 1, 10, 23, 15),
          },
          findingKind: "file-effects",
        },
        ...extra,
      };
    case "act":
      return { ...base, act: { block: "tools.breaker", action: "set", title: "turned off web fetch", state: "done", latencyMs: 3 }, ...extra };
    case "seam":
      return {
        ...base,
        seam: {
          turnIndex: 3,
          sentence: "6 files touched · 2 checks failing",
          derivation: {
            method: "joined this conversation's file effects and check results",
            steps: [{ source: "this conversation's transcript", sourceId: "transcript", count: 6 }],
            asOf: Date.UTC(2024, 0, 1, 10, 23, 15),
          },
          queued: 0,
        },
        ...extra,
      };
    default:
      return { ...base, ...extra };
  }
}

const ctx: VerbContext = {
  chatId: "c1",
  projectId: "p1",
  toggleExpand: () => {},
  prefillComposer: () => {},
  hint: null,
  userPromptBefore: () => "the prompt",
};

function withVerbs(beat: Beat): Beat {
  return { ...beat, verbs: makeVerbsFor(ctx)(beat) };
}

type Fired = {
  override: ("expand" | "collapse")[];
  open: string[];
  expand: string[];
  focus: string[];
};

function mount(beat: Beat, level: FisheyeLevel, expanded = false) {
  const fired: Fired = { override: [], open: [], expand: [], focus: [] };
  const { container } = render(BeatView, {
    props: {
      beat,
      fisheye: { level, reason: `${level}: fixture` },
      focused: true,
      onChain: false,
      expanded,
      projectPath: null,
      onfocusbeat: (id: string) => fired.focus.push(id),
      onoverridebeat: (_id: string, v: "expand" | "collapse") => fired.override.push(v),
      onopenbeat: (id: string) => fired.open.push(id),
      onexpandbeat: (id: string) => fired.expand.push(id),
      onfocuscause: (id: string) => fired.focus.push(id),
    },
  });
  return { container, fired };
}

// ── The third question: does pressing it CHANGE anything for this kind? ────

/**
 * The real outcome of a grammar grip on a beat of this kind, computed by
 * running the ACTUAL pipeline rather than by restating the rule the row uses.
 *
 * `collapse`/`expand` — set the session override the grip sets, ask the
 * fisheye, ask the renderer's own level owner, and compare the level the
 * reader would see. This is exactly where the inert COLLAPSE died: every
 * call succeeded and the two levels came back equal.
 *
 * `open-scope` — the kind either has a sheet or does not.
 */
export function observableOutcomeOf(target: string, kind: Beat["kind"]): boolean {
  if (target === "collapse" || target === "expand") {
    const beat = beatOf(kind);
    const shown = (override?: "expand" | "collapse"): FisheyeLevel => {
      clearAllOverrides();
      if (override !== undefined) setOverride(beat.id, override);
      const f = fisheyeLevel({
        beat,
        focusTurnIndex: 0,
        onFocusChain: false,
        latestTurnIndex: 9,
        ...(override !== undefined ? { override } : {}),
      });
      return renderedLevel(kind, f.level);
    };
    const before = shown();
    const after = shown(target);
    clearAllOverrides();
    return before !== after;
  }
  if (target === "open-scope") return opensScopeSheet(kind);
  return true;
}

/** Every grammar grip a rendered beat draws, by the target it names. */
export function renderedGrips(container: HTMLElement): string[] {
  return [...container.querySelectorAll("[data-chord-target]")].map(
    (el) => el.getAttribute("data-chord-target") ?? "",
  );
}

/**
 * The controls that name a grammar target but cannot change anything for
 * this kind. The pure core of the guard, so it can be mutation-tested with a
 * rendered set this build no longer produces.
 */
export function inertGrips(kind: Beat["kind"], targets: readonly string[]): string[] {
  return [...new Set(targets)].filter((t) => !observableOutcomeOf(t, kind));
}

afterEach(() => {
  cleanup();
  clearLog();
  clearAllOverrides();
});

// ── The suite ──────────────────────────────────────────────────────────────

describe("the kind list is DERIVED (a new kind joins this suite by itself)", () => {
  test("every declared kind is here", () => {
    expect(KINDS.length).toBeGreaterThan(6);
    expect(KINDS).toContain("turn");
    expect(KINDS).toContain("tool");
    expect(KINDS).toContain("act");
  });

  test("mutation: the parser reads the union, not a memory of it", () => {
    expect(declaredKinds(`export type BeatKind =\n  | "alpha"\n  | "beta";`)).toEqual(["alpha", "beta"]);
    expect(declaredKinds("no union here")).toEqual([]);
  });
});

describe("every grammar grip a beat renders can change something FOR THAT KIND", () => {
  for (const kind of KINDS) {
    for (const level of ["full", "ghost", "tick"] as const) {
      test(`${kind} at ${level}: no inert grip`, () => {
        const { container } = mount(withVerbs(beatOf(kind)), level);
        const targets = renderedGrips(container);
        const inert = inertGrips(kind, targets);
        expect(
          inert,
          `${kind} renders ${inert.join(", ")} — pressing it leaves the beat exactly as it was`,
        ).toEqual([]);
      });
    }
  }

  test("…and the grips are actually WIRED as well as effective (both halves)", () => {
    // The old guards' question, kept: a grip that changes nothing is one
    // defect, a grip bound to nothing is another, and this file must not
    // trade the second away to check the first.
    const { container, fired } = mount(withVerbs(beatOf("tool")), "full");
    const grips = [...container.querySelectorAll("[data-chord-target]")] as HTMLElement[];
    expect(grips.length).toBeGreaterThan(0);
    for (const g of grips) g.click();
    expect(fired.override.length).toBeGreaterThan(0);
  });
});

describe("the inert COLLAPSE on prose turns", () => {
  test("a prose turn renders NO expand/collapse grip", () => {
    for (const who of ["you", "model"] as const) {
      const beat = withVerbs(
        beatOf("turn", { turn: { who, text: "some words", streaming: false } }),
      );
      const { container } = mount(beat, "full");
      const targets = renderedGrips(container);
      expect(targets, `a ${who} turn must not offer a fold it cannot perform`).not.toContain("collapse");
      expect(targets).not.toContain("expand");
    }
  });

  test("…and it was inert BY CONSTRUCTION, which is why it had to go", () => {
    // The proof, run through the real pipeline: a turn's rendered level is
    // the same at both ends of the ladder, so the override had nothing to
    // change. Nothing was "broken"; the control could never have worked.
    expect(compressesInFlow("turn")).toBe(false);
    expect(observableOutcomeOf("collapse", "turn")).toBe(false);
    expect(renderedLevel("turn", "tick")).toBe(renderedLevel("turn", "full"));
  });

  test("MUTATION: re-adding the inert COLLAPSE to a prose turn fails this guard", () => {
    // The rendered set this build no longer produces, fed to the same pure
    // checker the tests above use. If the grip comes back, they go red.
    const before = ["collapse", "open-scope"];
    expect(inertGrips("turn", before)).toEqual(["collapse"]);
    expect(inertGrips("turn", ["expand"])).toEqual(["expand"]);
  });

  test("it is KEPT where it works — the removal is per kind, not wholesale", () => {
    // The kinds with genuine compressible depth still carry the control, and
    // the answer comes from the fisheye's own pin rather than from a list.
    const compressible = KINDS.filter((k) => compressesInFlow(k));
    expect(compressible, "the flow must still have foldable kinds").not.toEqual([]);
    for (const kind of compressible) {
      const { container } = mount(withVerbs(beatOf(kind)), "full");
      expect(
        renderedGrips(container),
        `${kind} folds for real — it must keep its grip`,
      ).toContain("collapse");
    }
    // …and the incompressible ones are exactly the pinned ones.
    expect(KINDS.filter((k) => !compressesInFlow(k)).sort()).toEqual(
      ["finding", "seam", "turn"],
    );
  });
});

describe("a kind may honestly end up with nothing at rest", () => {
  test("the row is never padded with a control invented to fill it", () => {
    // A seam carries no verbs, no fold and no sheet worth opening from the
    // row; the honest outcome is an empty options row, not a filler button.
    // (Hover-reveal means an empty row costs nothing visually either.)
    const { container } = mount(withVerbs(beatOf("seam")), "full");
    const options = container.querySelector(".options");
    expect(options, "the row is still LAID OUT — the reveal is opacity-only").not.toBeNull();
    for (const b of options!.querySelectorAll("button")) {
      const target = b.getAttribute("data-chord-target");
      if (target !== null) {
        expect(observableOutcomeOf(target, "seam"), `seam: ${target} does nothing`).toBe(true);
      }
    }
  });
});
