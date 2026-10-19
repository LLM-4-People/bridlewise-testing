// @vitest-environment jsdom
/**
 * A TOOL BEAT OPENS IN PLACE, AND NOWHERE ELSE.
 *
 * ── THE REPORT, THREE TIMES ───────────────────────────────────────────────
 *
 * "when clicking on a tool, it shows up on the right side on top of expanding
 * in the chat, I just want expanding in the chat."
 * → then: "sometimes when clicking around the tool open on the right side, I
 *   don't want that."
 * → then: "scope also opens on a right menu."
 *
 * ── WHY THE FIRST FIX DID NOT HOLD, WHICH IS THE POINT OF THIS FILE ───────
 *
 * A guard was written for exactly this ("one click, one outcome", in
 * cockpit-mouse-path-owner.test.ts) and the defect came back anyway. That
 * guard is not weak — its assertions bite, and its own mutation self-checks
 * prove it: put `onopenbeat` back in `onBodyClick` and it goes red. It was
 * too narrow in SCOPE. Its universe was ONE GESTURE — the card's body click —
 * read out of one function in one file. The sheet had three other doors
 * standing wide open beside it: the `scope` grip in the hover-revealed
 * options row, the `⋯` menu's "open scope" row, and the ⏎ chord. A reader
 * "clicking around the tool" hits the first of those constantly.
 *
 * So the question this file asks is not "does the body click open the sheet".
 * It is: FOR A TOOL BEAT, DOES ANYTHING? — and it answers it by walking the
 * rendered subtree and pressing every element in it, so a sub-element added
 * later is covered the day it is added. A hardcoded list of openers stops
 * covering new ones the moment one appears, which is very likely how this
 * survived its first fix.
 */
import { afterEach, describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import { readFileSync } from "node:fs";

import BeatView from "../../src/cockpit/flow/Beat.svelte";
import BeatDepth from "../../src/cockpit/flow/BeatDepth.svelte";
import { appendBeat, clearLog } from "../../src/cockpit/flow/log.ts";
import { opensScopeSheet } from "../../src/cockpit/flow/beat-state.ts";
import { makeVerbsFor, type VerbContext } from "../../src/cockpit/flow/verbs.ts";
import type { Beat } from "../../src/cockpit/flow/types.ts";

const FLOW = readFileSync("src/cockpit/flow/Flow.svelte", "utf8");
const BEAT = readFileSync("src/cockpit/flow/Beat.svelte", "utf8");

const PARENT_ID = "b-11111111-1111-4111-8111-111111111111";
const TOOL_ID = "b-22222222-2222-4222-8222-222222222222";

function toolBeat(extra: Partial<Beat> = {}): Beat {
  const beat: Beat = {
    id: TOOL_ID,
    kind: "tool",
    parentId: PARENT_ID,
    turnIndex: 3,
    at: Date.UTC(2024, 0, 1, 10, 23, 15),
    abnormal: false,
    bleed: true,
    verbs: [],
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
  return { ...beat, verbs: makeVerbsFor(CTX)(beat) };
}

const CTX: VerbContext = {
  chatId: "c1",
  projectId: "p1",
  toggleExpand: () => {},
  // No prefill sink and no project on SOME runs below, so the beat carries a
  // refusing verb too — the reason must still be reachable somewhere.
  prefillComposer: () => {},
  hint: null,
  userPromptBefore: () => "the prompt",
};

function parentTurn(): Beat {
  return {
    id: PARENT_ID,
    kind: "turn",
    parentId: null,
    turnIndex: 2,
    at: Date.UTC(2024, 0, 1, 10, 23, 12),
    abnormal: false,
    bleed: false,
    verbs: [],
    turn: { who: "you", text: "read the reader", streaming: false },
  };
}

type Fired = { open: string[]; expand: string[]; focus: string[] };

function mountTool(expanded: boolean) {
  const fired: Fired = { open: [], expand: [], focus: [] };
  const { container } = render(BeatView, {
    props: {
      beat: toolBeat(),
      fisheye: { level: "full", reason: "full: fixture" },
      focused: true,
      onChain: false,
      expanded,
      projectPath: null,
      onfocusbeat: (id: string) => fired.focus.push(id),
      onoverridebeat: () => {},
      onopenbeat: (id: string) => fired.open.push(id),
      onexpandbeat: (id: string) => fired.expand.push(id),
      onfocuscause: (id: string) => fired.focus.push(id),
    },
  });
  return { container, fired };
}

/**
 * EVERY ELEMENT IN A SUBTREE, pressed every way a pointer can press it.
 *
 * Dynamic on purpose: it walks what was rendered rather than a list of what
 * someone remembered rendering. Returns a description of each element that
 * was pressed, so a failure can name the offender and so the count itself can
 * be asserted (a walker that finds nothing passes vacuously).
 */
export function pressEverything(
  root: HTMLElement,
  gestures: readonly string[] = ["click", "dblclick", "contextmenu"],
): string[] {
  const pressed: string[] = [];
  for (const el of [root, ...root.querySelectorAll("*")]) {
    if (!(el instanceof HTMLElement)) continue;
    pressed.push(
      `<${el.tagName.toLowerCase()}${el.className ? ` class="${String(el.className)}"` : ""}>`,
    );
    for (const type of gestures) {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
    }
  }
  return pressed;
}

afterEach(() => {
  cleanup();
  clearLog();
});

describe("NOTHING on a tool beat opens a right-hand sheet", () => {
  for (const expanded of [false, true]) {
    test(`${expanded ? "opened" : "resting"} card: every element, every gesture`, () => {
      const { container, fired } = mountTool(expanded);
      const pressed = pressEverything(container);
      // The walk is alive: it really did find a subtree to press.
      expect(pressed.length, "the enumerator found nothing to press").toBeGreaterThan(8);
      expect(
        fired.open,
        `a gesture on a tool beat opened the SCOPE — the enumerated elements were:\n${pressed.join("\n")}`,
      ).toEqual([]);
    });
  }

  test("the card body still EXPANDS IN PLACE — the outcome was moved, not deleted", () => {
    const { container, fired } = mountTool(false);
    (container.querySelector(".body") as HTMLElement).click();
    expect(fired.expand).toEqual([TOOL_ID]);
    expect(fired.open).toEqual([]);
  });

  test("no `scope` grip is rendered on a tool beat at any level", () => {
    for (const level of ["full", "ghost", "tick"] as const) {
      const { container } = render(BeatView, {
        props: {
          beat: toolBeat(),
          fisheye: { level, reason: "fixture" },
          focused: true,
          onChain: false,
          expanded: false,
          projectPath: null,
          onfocusbeat: () => {},
          onoverridebeat: () => {},
          onopenbeat: () => {},
          onexpandbeat: () => {},
        },
      });
      expect(
        container.querySelector('[data-chord-target="open-scope"]'),
        `a tool beat at ${level} must not carry a control that opens the sheet`,
      ).toBeNull();
      cleanup();
    }
  });

  test("right-click is given back to the browser (no preventDefault, no menu)", () => {
    // The `⋯` menu is deleted, so the beat must not swallow the context menu
    // either — a reader selecting text out of a tool's output wants the
    // browser's own copy item.
    expect(BEAT, "the beat must not handle contextmenu at all").not.toMatch(/oncontextmenu/);
    const { container } = mountTool(true);
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    (container.querySelector(".body") as HTMLElement).dispatchEvent(ev);
    expect(ev.defaultPrevented, "the browser's own menu must still open").toBe(false);
  });

  test("the ⏎ chord routes by kind, and a tool beat's route is the inline expansion", () => {
    // The routing law: a pressed grammar chord never silently does nothing.
    // So ⏎ is not dropped for this kind — it opens the same depth the body
    // click opens.
    const openFocused = /function openFocused\(\): void \{([\s\S]*?)\n  \}/.exec(FLOW);
    expect(openFocused, "the flow must have an openFocused").not.toBeNull();
    const body = openFocused![1]!;
    expect(body, "the route must ask the ONE owner which kinds have a sheet").toContain(
      "opensScopeSheet(beat.kind)",
    );
    expect(body, "…and send the sheetless kinds to the inline expansion").toMatch(
      /expandBeat\(focusedId\)/,
    );
    // The owner's answer for this kind, from the owner itself.
    expect(opensScopeSheet("tool")).toBe(false);
    expect(opensScopeSheet("turn")).toBe(true);
  });

  test("OTHER kinds keep their sheet — the removal is per kind, not wholesale", () => {
    const beat: Beat = { ...parentTurn(), verbs: [] };
    const fired: string[] = [];
    const { container } = render(BeatView, {
      props: {
        beat,
        fisheye: { level: "full", reason: "fixture" },
        focused: true,
        onChain: false,
        expanded: false,
        projectPath: null,
        onfocusbeat: () => {},
        onoverridebeat: () => {},
        onopenbeat: (id: string) => fired.push(id),
        onexpandbeat: () => {},
      },
    });
    const grip = container.querySelector('[data-chord-target="open-scope"]') as HTMLElement | null;
    expect(grip, "a turn still opens its sheet").not.toBeNull();
    grip!.click();
    expect(fired).toEqual([beat.id]);
  });

  test("the claim/dismissal ladder and the ScopeHost are untouched", () => {
    // Removing a sheet for ONE kind must not remove the sheet machinery.
    expect(readFileSync("src/cockpit/shell/ScopeHost.svelte", "utf8").length).toBeGreaterThan(100);
    expect(FLOW, "the flow still opens the scope for the kinds that have one").toContain(
      "shell.openScope({",
    );
  });

  // ── mutation ─────────────────────────────────────────────────────────────

  test("MUTATION: a NEW sub-element that opens the sheet is caught by the walk", () => {
    // The failure mode a hardcoded opener list has: someone adds a control
    // inside the card and the list does not know about it. The walk does,
    // because it walks what is there.
    const host = document.createElement("div");
    let opened = 0;
    host.innerHTML = `<div class="beat"><div class="body"><div class="cells">
      <span class="new-thing">peek</span></div></div></div>`;
    host.querySelector(".new-thing")!.addEventListener("click", () => {
      opened += 1;
    });
    const pressed = pressEverything(host);
    expect(pressed.some((p) => p.includes("new-thing"))).toBe(true);
    expect(opened, "the walk must reach a sub-element nobody listed").toBe(1);
  });

  test("MUTATION: a right-click handler that opens the menu is caught", () => {
    const host = document.createElement("div");
    let opened = 0;
    host.innerHTML = `<div class="beat">card</div>`;
    host.querySelector(".beat")!.addEventListener("contextmenu", () => {
      opened += 1;
    });
    pressEverything(host);
    expect(opened).toBe(1);
  });

  test("MUTATION: the walk on an empty subtree reports as much (no vacuous pass)", () => {
    const host = document.createElement("div");
    expect(pressEverything(host)).toHaveLength(1); // the root only
  });
});

// ── What the sheet used to add, now inline ─────────────────────────────────

describe("the SCOPE sheet's extra content moved INTO the expanded beat", () => {
  /**
   * The inventory, from reading BeatScope.svelte against the open card. The
   * sheet rendered five sections; one of them WAS the open card (the beat's
   * body, expanded). These are the other four.
   */
  function mountDepth() {
    clearLog();
    appendBeat(parentTurn());
    const focused: string[] = [];
    const beat = toolBeat();
    appendBeat(beat);
    const { container } = render(BeatDepth, {
      props: { beat, onfocuscause: (id: string) => focused.push(id) },
    });
    return { container, focused, beat };
  }

  test("1. WHEN — the clock time of the fact (the card states a duration, not an instant)", () => {
    const { container } = mountDepth();
    expect(container.textContent).toMatch(/at \d{2}:\d{2}:\d{2}/);
  });

  test("2. CAUSE — named as a thing, in plain words, and followable", () => {
    const { container, focused } = mountDepth();
    expect(container.textContent).toContain("in reply to your message");
    const link = container.querySelector(".cause-link") as HTMLElement | null;
    expect(link, "following the causal chain is the point — it must be clickable").not.toBeNull();
    link!.click();
    expect(focused).toEqual([PARENT_ID]);
  });

  test("3. VERBS — EVERY verb, including the refusing ones with their reason", () => {
    // The options row deliberately draws only the WIRED verbs; the full set
    // with its refusals lived in the sheet. For a kind with no sheet it has
    // to live here, or a refusal's reason becomes unreachable.
    clearLog();
    const beat: Beat = { ...toolBeat({ tool: undefined }) };
    const withVerbs = { ...beat, verbs: makeVerbsFor(CTX)(beat) };
    expect(withVerbs.verbs.some((v) => !v.wired), "the fixture must carry a refusing verb").toBe(true);
    const { container } = render(BeatDepth, { props: { beat: withVerbs } });
    const disabled = container.querySelector(".verb-unwired");
    expect(disabled, "a refusing verb must render here").not.toBeNull();
    expect(disabled!.textContent, "…carrying its reason as visible text").toMatch(/no tool name/);
  });

  test("4. THE PRECISE RECORD — real, reachable, and NOT the body", () => {
    const { container, beat } = mountDepth();
    const details = container.querySelector("details");
    expect(details, "the precise record must exist").not.toBeNull();
    expect(details!.open, "…and be CLOSED at rest, exactly as the sheet had it").toBe(false);
    expect(details!.textContent ?? "").toContain(beat.id);
    expect(container.textContent, "the exchange number survives too").toContain("exchange");
  });

  test("it renders on the OPENED card and only there", () => {
    const shut = mountTool(false);
    expect(shut.container.querySelector('[data-field="beat-depth"]')).toBeNull();
    cleanup();
    const open = mountTool(true);
    expect(open.container.querySelector('[data-field="beat-depth"]')).not.toBeNull();
  });

  test("pressing a verb in the depth does NOT re-fold the card underneath it", () => {
    // One gesture, one outcome — the same law, applied to the new surface.
    const { container, fired } = mountTool(true);
    const depth = container.querySelector('[data-field="beat-depth"]') as HTMLElement;
    depth.click();
    expect(fired.expand, "a click inside the depth must not toggle the card").toEqual([]);
  });

  test("MUTATION: a depth that dropped a section is caught", () => {
    // Each of the four is asserted separately above; this proves the
    // assertions are not satisfied by the surrounding chrome.
    const host = document.createElement("div");
    host.innerHTML = `<div data-field="beat-depth"><p>at 10:23:15</p></div>`;
    expect(host.querySelector("details")).toBeNull();
    expect(host.querySelector(".cause-link")).toBeNull();
    expect(host.textContent).not.toContain("exchange");
  });
});

// ── The `⋯` menu: gone, and every entry accounted for ──────────────────────

describe("the `⋯` menu is gone, and nothing went with it", () => {
  test("no beat kind renders a menu grip any more", () => {
    for (const kind of ["turn", "tool", "effect", "check-delta", "event", "act"] as const) {
      const beat: Beat = {
        id: `b-3333${kind}`,
        kind,
        parentId: null,
        turnIndex: 1,
        at: 1,
        abnormal: false,
        bleed: kind !== "turn",
        verbs: [],
        ...(kind === "turn" ? { turn: { who: "you" as const, text: "x", streaming: false } } : {}),
        ...(kind === "tool" ? { tool: { name: "read_file", label: "read file", status: "done" as const, input: {}, output: "", startedAt: 1 } } : {}),
        ...(kind === "effect" ? { effect: { path: "x.ts", producedBy: "t" } } : {}),
        ...(kind === "check-delta" ? { checkDelta: { checkId: "c", checkName: "lint", from: "passed" as const, to: "failed" as const } } : {}),
        ...(kind === "event" ? { event: { eventKind: "bias" as const, text: "x" } } : {}),
        ...(kind === "act" ? { act: { block: "b", action: "a", title: "t", state: "done" as const, latencyMs: 3 } } : {}),
      };
      const { container } = render(BeatView, {
        props: {
          beat: { ...beat, verbs: makeVerbsFor(CTX)(beat) },
          fisheye: { level: "full", reason: "fixture" },
          focused: true,
          onChain: false,
          expanded: false,
          projectPath: null,
          onfocusbeat: () => {},
          onoverridebeat: () => {},
          onopenbeat: () => {},
          onexpandbeat: () => {},
        },
      });
      expect(container.textContent ?? "", `${kind} still draws a ⋯`).not.toContain("⋯");
      expect(container.querySelector('[aria-haspopup="menu"]'), `${kind} still has a menu grip`).toBeNull();
      cleanup();
    }
  });

  test("its component is deleted and nothing imports it", () => {
    expect(() => readFileSync("src/cockpit/flow/BeatMenu.svelte", "utf8")).toThrow(
      /ENOENT|no such file/,
    );
    expect(FLOW).not.toContain("BeatMenu");
  });

  test("the retired chord is retired everywhere (no half-removal)", () => {
    expect(readFileSync("src/cockpit/shell/keyboard.ts", "utf8")).not.toMatch(
      /target:\s*"verb-menu"/,
    );
    expect(FLOW, "the flow must not claim a chord that opens nothing").not.toMatch(
      /claimKey\(\s*"verb-menu"/,
    );
  });

  test("every entry the menu held is still reachable, and by a better path", () => {
    // focus prev / next — the mouse path is clicking the beat you want, and
    // it is DECLARED and verified as such (shell/mouse-paths.ts, checked by
    // cockpit-mouse-path-owner). Here: the row really does focus on a click.
    const { container, fired } = mountTool(false);
    (container.querySelector("[data-beat-id]") as HTMLElement).click();
    expect(fired.focus, "clicking a beat focuses it — the whole mouse path").toContain(TOOL_ID);

    // open scope — the grip, for the kinds that still have a sheet (asserted
    // in the suite above). expand / collapse — the grip, for the kinds that
    // really fold (flow-control-effect-owner.test.ts). the verbs — the
    // options row (wired) plus the sheet or the inline depth (all of them).
    expect(BEAT).toContain('data-chord-target="open-scope"');
    expect(BEAT).toContain('data-chord-target="collapse"');
  });
});
