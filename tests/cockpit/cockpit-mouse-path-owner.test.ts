// @vitest-environment node
/**
 * MOUSE-PATH OWNER — the inverse of the keyboard rule (COCKPIT v2.1).
 *
 * The cockpit already holds that a keyboard-only interaction with no visible
 * counterpart is a defect. On the web the converse is just as true: this is
 * a mouse-first medium, and a capability reachable ONLY by chord is
 * invisible to everyone who has not read the grammar. So:
 *
 *   every ACTIONABLE keyboard grammar target must have a discoverable CLICK
 *   PATH — a rendered control that names the target — and that control must
 *   TEACH its chord through a tooltip.
 *
 * "Actionable" is derived, never hand-listed, from the two places a target
 * can acquire behaviour:
 *   - CLAIMED — some surface calls `shell.claimKey("<target>", …)`;
 *   - SHELL-HANDLED — Cockpit.svelte's own router acts on it (the explicit
 *     `spec.target === "…"` branches, plus every key of ROOM_TARGETS).
 * A target that is neither does nothing but print the honest "not built yet"
 * hint, and correctly has no click path — but the moment anyone claims it,
 * this guard demands one. That is the whole point: the exemption cannot
 * outlive the emptiness.
 *
 * A control names its target with `data-chord-target="<target>"`, or by
 * passing `target="<target>"` to the `ChordGrip` primitive (which renders
 * the attribute and generates the tooltip itself). Both forms are LITERAL at
 * the call site on purpose — a mouse path you cannot grep from the chord it
 * teaches is not discoverable by the next author either.
 *
 * ── THE WIDENING, AND WHY IT IS NOT A HOLE ────────────────────────────────
 *
 * The definition above is CONTROL-SHAPED, and it is narrower than the law it
 * implements. It surfaced when the `⋯` beat menu was deleted: that menu held
 * "focus the fact before / after this one" purely so `↑`/`↓` would have an
 * attribute-bearing control, and with it gone the guard called them
 * chord-only — while the real mouse path for "focus a beat" is CLICKING THAT
 * BEAT. The guard was demanding a strictly worse path because it was the only
 * shape it could see.
 *
 * So a second, GESTURE-shaped path is accepted, declared in
 * `src/cockpit/shell/mouse-paths.ts` — and every declaration is VERIFIED, not
 * believed. Three things must hold, each one mutation-tested at the bottom of
 * this file:
 *
 *   1. the declared marker is really rendered by the declared source, on an
 *      element that is really interactive;
 *   2. the declared source really CONSUMES the registry at runtime (it
 *      imports it) — a declaration nothing reads is a comment;
 *   3. the declared chord is real (the target exists in GRAMMAR) and the
 *      keys taught come from the grammar table, not from prose.
 *
 * A target that is neither attribute-reachable nor declared-and-verified
 * still fails. That is the difference between widening a guard and gutting
 * one.
 *
 * The scanners are pure functions and are MUTATION-TESTED below: a
 * chord-only target, a claim hidden on a non-interactive element, a control
 * with no tooltip, a control commented out, and each of the three gesture
 * conditions must be flagged, and a clean source must not be. Weakening a
 * scanner turns the self-checks red.
 */
import { describe, expect, test } from "vitest";

import { read, relpath, walk, stripTemplateComments, stripCommentsOnly } from "../helpers/source-scan.ts";
import { isTemplateSource } from "../../engine/scripts/verification/source-view.ts";
import { attributeOf, bindingValueOf, bodyCallsWith, elementWithAttribute, objectLiteralsWith } from "../helpers/function-scope.ts";
import { RIGHT_MENU_GROUPS } from "../../src/cockpit/shell/right-menu.ts";
import { GRAMMAR } from "../../src/cockpit/shell/keyboard.ts";
import { mouseTitleFor, chordFor } from "../../src/cockpit/shell/keyboard.ts";
import { ROOM_CHORDS, roomChordTitle } from "../../src/cockpit/shell/room-chords.ts";
import {
  GESTURE_PATHS,
  gestureKeysFor,
  type GesturePath,
} from "../../src/cockpit/shell/mouse-paths.ts";

import { HIT_TOKEN, floorClassesFrom, sizesToFloor, styleBlock } from "../helpers/control-floor.ts";

const COCKPIT_ROOT = "src/cockpit";
const SHELL_ROUTER = "src/cockpit/Cockpit.svelte";
/** The ONE module allowed to test the platform modifier — see below. */
const MODIFIER_OWNER = "src/cockpit/shell/chords.ts";

/**
 * A POINTER HANDLER IS A MOUSE PATH.
 *
 * The check was `onclick` only. That is a control-shaped notion of "reachable
 * by mouse" and it is narrower than the law — the same flaw the gesture-path
 * registry exists to fix, one level down. The SWEEP band answers a click
 * through `onpointerdown`/`onpointerup` (it needs the down/move/up sequence
 * to drag-scrub, so it cannot use `onclick`), and a canvas is not an
 * interactive tag. Refusing it would mean the band, which a reader clicks to
 * move the head through time, does not count as clickable.
 *
 * Widening a guard is the failure mode to avoid, so note what is NOT widened:
 * a pointer handler still has to be ON the element carrying the declared
 * marker, in the source the declaration names. An element with neither an
 * interactive tag, nor onclick, nor a pointer handler still fails — proven by
 * the mutation below.
 */
/** onclick, or the pointer sequence a drag-capable surface must use instead. */
const POINTER_OR_CLICK = /\b(?:onclick|onpointerdown|onpointerup)[\s=]/;

/** Elements that are interactive without needing an explicit onclick. */
const INTERACTIVE_TAGS = new Set([
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "ChordGrip",
]);

/** ChordGrip generates its own grammar-derived tooltip — it cannot lack one. */
const SELF_TITLING_TAGS = new Set(["ChordGrip"]);

// ── Strippers ──────────────────────────────────────────────────────────────

/**
 * Drop Svelte-template HTML comments and JS/TS comments. A commented-out
 * control is not a rendered control. The implementation is the one owner in
 * `tests/helpers/source-scan.ts`; this file's long-standing name is kept as
 * the import alias so the self-checks below read the way they always have.
 *
 * THE MODE IS A PROPERTY OF THE FILE, NOT OF THE QUESTION. `stripTemplateComments`
 * lexes its input as a Svelte template — markup prose, `{expressions}`,
 * attribute values, script and style content each with their own rules. A
 * `.ts` file or a TS-shaped fragment must NOT go through it: a `//` comment
 * is comment material in code and literal prose in markup, and reading code
 * in template mode resurrects the exact parity blindness the shared lexer's
 * mode machine exists to end. Every scanner below takes the path its content
 * came from and picks the view with `viewFor` — one dispatch, owned by the
 * lexer's own extension rule (`isTemplateSource`), never re-spelled here.
 */
const stripAllComments = stripTemplateComments;

/** The comment-stripped, strings-kept view of `src` FOR THIS PATH — the
 * template stripper for template sources, the code stripper for code. */
function viewFor(src: string, path: string): string {
  return isTemplateSource(path) ? stripTemplateComments(src) : stripCommentsOnly(src);
}

// ── What is actionable ─────────────────────────────────────────────────────

/** Targets some surface claims through `shell.claimKey("<target>", …)`.
 *
 * Each entry carries its own path: claims live in `.ts` route tables and in
 * `.svelte` script blocks, and the comment rules differ between the modes. */
export function claimedTargets(
  entries: readonly (readonly [path: string, src: string])[],
): Set<string> {
  const out = new Set<string>();
  for (const [path, src] of entries) {
    for (const m of viewFor(src, path).matchAll(/claimKey\(\s*"([a-z-]+)"/g)) {
      out.add(m[1]!);
    }
  }
  return out;
}

/** Targets the shell's own router acts on, read out of its source. */
export function shellHandledTargets(routerSrc: string, path: string): Set<string> {
  const src = viewFor(routerSrc, path);
  const out = new Set<string>();
  for (const m of src.matchAll(/spec\.target\s*===\s*"([a-z-]+)"/g)) out.add(m[1]!);
  const table = /ROOM_TARGETS[^=]*=\s*\{([\s\S]*?)\}/.exec(src);
  if (table !== null) {
    for (const m of table[1]!.matchAll(/(^|[\s{,])([a-z-]+)\s*:/g)) out.add(m[2]!);
  }
  return out;
}

// ── Click paths ────────────────────────────────────────────────────────────

export type ClickPath = Readonly<{
  target: string;
  tag: string;
  file: string;
  interactive: boolean;
  teaches: boolean;
  /** First class token on the element — the CSS rule that must size it. */
  cls: string | null;
}>;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


/**
 * Every control in ONE Svelte source that names a grammar target. Returns
 * the tag name, whether it is interactive, and whether it carries a tooltip.
 *
 * `attr` selects WHICH registry is being scanned: the shell grammar
 * (`data-chord-target`, plus the `ChordGrip` primitive's own `target` prop)
 * or the room-local chord table (`data-room-chord`). Same rules, two
 * registries — because there ARE two, and a guard that only knew about one
 * of them is how ⌘N shipped with no button.
 */
export function findClickPaths(
  file: string,
  src: string,
  attr: string = "data-chord-target",
): ClickPath[] {
  const out: ClickPath[] = [];
  const stripped = viewFor(src, file);
  // Any opening tag, attributes captured. `[^>]` is enough because Svelte
  // attribute expressions with `>` inside are written `{a > b}` — none of the
  // cockpit's controls do that, and a missed tag fails CLOSED (no click path).
  for (const m of stripped.matchAll(/<([A-Za-z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    const tag = m[1]!;
    const attrs = m[2]!;
    const explicit = new RegExp(`\\b${attr}\\s*=\\s*"([a-z.-]+)"`).exec(attrs);
    const viaGrip =
      attr === "data-chord-target" && tag === "ChordGrip"
        ? /\btarget\s*=\s*"([a-z-]+)"/.exec(attrs)
        : null;
    const target = explicit?.[1] ?? viaGrip?.[1];
    if (target === undefined) {
      // One declaration-driven menu. Accept only the actual imported loop,
      // binding, action and generated tooltip; arbitrary dynamic paths still
      // fail closed. Its complete rendered population is guarded by the
      // mounted run-pane-shell owner.
      if (file === "src/cockpit/shell/RightMenuHost.svelte" && attr === "data-chord-target"
        && /import \{[^}]*INSPECTOR_GROUPS[^}]*\} from "\.\/outlets.ts"/.test(stripped)
        && stripped.includes("{#each INSPECTOR_GROUPS as item, index (item.id)}")
        && /data-chord-target=\{item.chord\}/.test(attrs)
        && bodyCallsWith(attributeOf(elementWithAttribute(stripped, 'data-chord-target={item.chord}'), "onclick"), "select", ["item.id"])
        && attrs.includes("mouseTitleFor(item.chord)")) {
        for (const group of Object.values(RIGHT_MENU_GROUPS)) out.push({ target: group.chord, tag, file, interactive: INTERACTIVE_TAGS.has(tag), teaches: true, cls: "section-tab" });
      }
      continue;
    }
    const clsAttr = /\bclass\s*=\s*"([^"{]*)/.exec(attrs);
    out.push({
      target,
      tag,
      file,
      interactive: INTERACTIVE_TAGS.has(tag) || POINTER_OR_CLICK.test(attrs),
      teaches: SELF_TITLING_TAGS.has(tag) || /\btitle\s*=/.test(attrs),
      cls: clsAttr?.[1]?.trim().split(/\s+/)[0] ?? null,
    });
  }
  return out;
}

/** Menu capabilities remain source-discoverable through their declared
 * collection and the shared native action; mounted owners prove each route. */
export function findRoomMenuPaths(file: string, src: string, menuSource: string): ClickPath[] {
  const source = viewFor(src, file);
  const menu = viewFor(menuSource, "src/cockpit/shell/ContextMenu.svelte");
  if (!source.includes('import ContextMenu, { type MenuVerb } from "../shell/ContextMenu.svelte"')) return [];
  if (!menu.includes("data-room-chord={verb.roomChord}")) return [];
  const item = elementWithAttribute(menu, "data-room-chord={verb.roomChord}");
  if (!menu.includes("{#each verbs as verb (verb.id)}") || !item.body.startsWith("<button")
    || !bodyCallsWith(attributeOf(item, "onclick"), "verb.run", [])) return [];
  const result: ClickPath[] = [];
  const cls = attributeOf(item, "class").body.replace(/^["']|["']$/g, "").trim().split(/\s+/, 1)[0] || null;
  const titled = attributeOf(item, "title").body === "verb.title";
  for (const call of source.matchAll(/<ContextMenu\b[^>]*\bverbs=\{([A-Za-z]\w*)\}/g)) {
    const declaration = bindingValueOf(source, call[1]!).body;
    const targets = new Set([...declaration.matchAll(/\broomChord\s*:\s*["']([^"']+)["']/g)].map(match => match[1]!));
    for (const target of targets) for (const value of objectLiteralsWith("const menu = " + declaration, "roomChord", target)) {
      result.push({ file, target, tag: "button", interactive: value.has("run") && value.get("run") !== "()=>{}",
        teaches: titled && value.get("title") === 'roomChordTitle("' + target + '")', cls });
    }
  }
  return result;
}

// ── Gesture paths (the widening) ───────────────────────────────────────────

/**
 * Verify ONE declared gesture path against the source it names. Returns the
 * reasons it fails; an empty array is a path that genuinely exists.
 *
 * Pure: the source text and the registry module's text are passed in, so the
 * mutation self-checks can feed it a source that lies.
 */
export function verifyGesturePath(
  g: GesturePath,
  src: string,
  knownTargets: ReadonlySet<string>,
): string[] {
  const bad: string[] = [];
  const stripped = stripAllComments(src);

  // 1. The marker is rendered, on something that can be clicked.
  let rendered = false;
  for (const m of stripped.matchAll(/<([A-Za-z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    const tag = m[1]!;
    const attrs = m[2]!;
    if (!new RegExp(`\\b${escapeRe(g.marker)}[\\s=]`).test(attrs)) continue;
    if (INTERACTIVE_TAGS.has(tag) || POINTER_OR_CLICK.test(attrs)) {
      rendered = true;
      break;
    }
  }
  if (!rendered) {
    bad.push(
      `${g.source}: nothing interactive there carries "${g.marker}" — the gesture path for ` +
        `"${g.target}" is declared but not rendered`,
    );
  }

  // 2. The source CONSUMES the registry — a declaration nothing reads is a
  //    comment, and a comment cannot carry a mouse path.
  if (!/mouse-paths\.ts/.test(stripped)) {
    bad.push(
      `${g.source}: declares a gesture path for "${g.target}" but never imports ` +
        `shell/mouse-paths.ts — the declaration is not consumed by the surface`,
    );
  }

  // 3. The chord is real, and the sentence says something.
  if (!knownTargets.has(g.target)) {
    bad.push(`"${g.target}" is not a grammar target — a gesture path cannot teach a phantom chord`);
  }
  if (g.gesture.trim().length < 10) {
    bad.push(`"${g.target}": the gesture must be stated in plain words`);
  }
  return bad;
}

// ── The suite ──────────────────────────────────────────────────────────────

describe("cockpit-mouse-path-owner — every actionable chord has a click path", () => {
  const files = walk(COCKPIT_ROOT, { exts: [".svelte", ".ts"] });
  const svelte = files.filter((f) => f.endsWith(".svelte"));

  const claimed = claimedTargets(files.map((f) => [relpath(f), read(f)] as const));
  const shellHandled = shellHandledTargets(read(SHELL_ROUTER), SHELL_ROUTER);
  const actionable = new Set([...claimed, ...shellHandled]);

  const paths: ClickPath[] = [];
  for (const f of svelte) paths.push(...findClickPaths(relpath(f), read(f)));

  test("the derivation found real targets on both sides (the scan is alive)", () => {
    expect(claimed.size).toBeGreaterThan(4);
    expect(shellHandled.size).toBeGreaterThan(4);
    // Sanity: known members of each set, so a broken regex cannot pass by
    // finding nothing.
    expect(claimed.has("focus-next")).toBe(true);
    expect(claimed.has("scrub-back")).toBe(true);
    expect(shellHandled.has("desk")).toBe(true);
    expect(shellHandled.has("instruments")).toBe(true);
    expect(paths.length).toBeGreaterThan(10);
  });

  test("every target named by a control is a REAL grammar target", () => {
    const known = new Set(GRAMMAR.map((s) => s.target));
    const phantom = [...new Set(paths.map((p) => p.target))].filter((t) => !known.has(t as never));
    expect(phantom, `controls name targets the grammar does not have: ${phantom.join(", ")}`).toEqual([]);
  });

  const knownTargets = new Set<string>(GRAMMAR.map((s) => s.target));
  /** Gesture paths that survive verification — see the header's three rules. */
  const verifiedGestures = new Set(
    GESTURE_PATHS.filter((g) => verifyGesturePath(g, read(g.source), knownTargets).length === 0).map(
      (g) => g.target,
    ),
  );

  test("every DECLARED gesture path is real (rendered, interactive, consumed)", () => {
    const bad: string[] = [];
    for (const g of GESTURE_PATHS) bad.push(...verifyGesturePath(g, read(g.source), knownTargets));
    expect(bad, bad.join("\n")).toEqual([]);
    // …and the registry is alive: it declares something, and the keys it
    // teaches come from the grammar table rather than from prose.
    expect(GESTURE_PATHS.length).toBeGreaterThan(0);
    expect(gestureKeysFor("focus-prev", "focus-next")).toBe("ArrowUp ArrowDown");
  });

  test("NO actionable target is chord-only", () => {
    // A mouse can reach a capability through a CONTROL that names the chord,
    // or through a declared-and-verified GESTURE. Both are real paths; only
    // one of them is control-shaped, and the law never asked for a control.
    const withPath = new Set([...paths.map((p) => p.target), ...verifiedGestures]);
    const chordOnly = [...actionable].filter((t) => !withPath.has(t)).sort();
    expect(
      chordOnly,
      `chord-only capabilities (a mouse cannot reach them): ${chordOnly
        .map((t) => `${t} (${chordFor(t as never)})`)
        .join(", ")}`,
    ).toEqual([]);
  });

  test("every click path is on an INTERACTIVE element", () => {
    const dead = paths
      .filter((p) => !p.interactive)
      .map((p) => `${p.file}: <${p.tag}> claims "${p.target}" but nothing can click it`);
    expect(dead, dead.join("\n")).toEqual([]);
  });

  test("every click path TEACHES its chord (carries a tooltip)", () => {
    const mute = paths
      .filter((p) => !p.teaches)
      .map((p) => `${p.file}: <${p.tag}> claims "${p.target}" with no title — the mouse path must teach the chord`);
    expect(mute, mute.join("\n")).toEqual([]);
  });

  test("every click path clears the POINTER TARGET FLOOR in both axes", () => {
    // WCAG 2.2 SC 2.5.8 sets 24×24 CSS px, and mouse-first makes it more
    // than a touch concern: a 21px chip is an imprecise target for a
    // pointer too. The floor is a token (tokens.css --hit-min) so the
    // number has one owner; here every registered mouse path must consume
    // it (or be sized by a token that is already larger).
    const small: string[] = [];
    for (const p of paths) {
      if (SELF_TITLING_TAGS.has(p.tag)) continue; // ChordGrip is checked at its own source
      if (p.cls === null) {
        small.push(`${p.file}: <${p.tag}> claims "${p.target}" with no class — nothing sizes its hit area`);
        continue;
      }
      const style = styleBlock(read(p.file));
      const { found, ok } = sizesToFloor(style, p.cls);
      if (!found) small.push(`${p.file}: .${p.cls} claims "${p.target}" but has no CSS rule to size it`);
      else if (!ok) small.push(`${p.file}: .${p.cls} ("${p.target}") does not clear ${HIT_TOKEN} in both axes`);
    }
    expect(small, small.join("\n")).toEqual([]);
  });

  test("the floor has ONE owner and it is tokens.css", () => {
    const tokens = read("src/cockpit/tokens.css");
    expect(tokens).toMatch(/--hit-min:\s*40px/);
    expect(tokens).toMatch(/@media[^{}]*\(pointer:\s*coarse\)[\s\S]*?--hit-min:\s*44px/);
    // …and the ChordGrip primitive itself consumes it.
    const grip = read("src/cockpit/shell/ChordGrip.svelte");
    expect(grip).toContain('class="verb chord-grip');
    expect(sizesToFloor(styleBlock(grip), "verb").ok).toBe(true);
    // Disclosures do not name a keyboard chord, but they are the shared
    // pointer door to every inspector capability. Row density is not a
    // target floor: Work/Scan rows can be smaller than the pointer token.
    const disclosure = read("src/cockpit/shell/Disclosure.svelte");
    expect(disclosure).toContain('class="disc-grip"');
    expect(sizesToFloor(styleBlock(disclosure), "disc-grip").ok).toBe(true);
  });

  test("a target with no click path is honestly not built (unclaimed, unrouted)", () => {
    const withPath = new Set([...paths.map((p) => p.target), ...verifiedGestures]);
    for (const spec of GRAMMAR) {
      if (withPath.has(spec.target)) continue;
      expect(
        actionable.has(spec.target),
        `"${spec.target}" has no click path, so it must do nothing but hint — ` +
          `but it is claimed or shell-routed`,
      ).toBe(false);
    }
  });

  test("the taught tooltip is grammar-derived and platform-true (node = non-mac)", () => {
    // The tooltip owner cannot teach a key the router does not fire: it is
    // built from the same table, and on this platform it spells Ctrl.
    expect(mouseTitleFor("switch")).toBe("the Switch · Ctrl+J");
    expect(mouseTitleFor("focus-next")).toContain("↓");
    expect(mouseTitleFor("arm")).toBe("arm a trigger · Ctrl+Shift+A");
    for (const spec of GRAMMAR) {
      expect(mouseTitleFor(spec.target)).toContain(chordFor(spec.target));
    }
  });
});

/**
 * ONE CLICK, ONE OUTCOME — the other half of the mouse-first law.
 *
 * Everything above proves a chord is REACHABLE by mouse. This proves the
 * reverse property, which the same law needs and which nothing was checking:
 * a single gesture must not fire two of them.
 *
 * THE USER'S CORRECTION, VERBATIM: "when clicking on a tool, it shows up on
 * the right side on top of expanding in the chat, I just want expanding in
 * the chat."
 *
 * A beat's body click used to land in the flow's `openBeat`, which BOTH
 * toggled the card's inline expansion AND threw the SCOPE sheet open on the
 * right. That was a deliberate decision of ours — "inspecting a card IS the
 * natural web action" — and it was reasonable, but it had accumulated a
 * second job, and two surfaces from one gesture is a gesture nobody can aim.
 * The user decided; their call wins.
 *
 * THIS ASSERTION IS THE OLD ONE INVERTED, ON PURPOSE. It is kept rather than
 * deleted precisely so the failure mode stays impossible in BOTH directions:
 * a body click may not open the scope, and the scope's own openers may not
 * quietly re-fold the card underneath. Do not "restore" the old behaviour.
 * Nothing was taken away — the `scope` grip is still in the options row at
 * rest, still titled with its chord, and ⏎ and the `⋯` menu still open it.
 */
describe("one click, one outcome — a body click never opens a second surface", () => {
  const flow = read("src/cockpit/flow/Flow.svelte");
  const beat = read("src/cockpit/flow/Beat.svelte");

  test("the body click and the SCOPE have two separate entry points", () => {
    expect(beat, "the beat must take a dedicated inline-expansion callback").toMatch(
      /onexpandbeat:\s*\(id: string\) => void;/,
    );
    expect(flow, "the flow must answer it with its own function").toMatch(
      /function expandBeat\(id: string\): void/,
    );
  });

  test("the body click calls ONLY the inline expansion", () => {
    const handler = /function onBodyClick\(\): void \{([\s\S]*?)\n  \}/.exec(beat);
    expect(handler, "Beat.svelte must have a body-click handler").not.toBeNull();
    expect(handler![1]!, "the body click must expand in place").toContain("onexpandbeat(beat.id)");
    expect(
      handler![1]!,
      "…and must not ALSO open the scope — that is the two-surfaces defect the user reported",
    ).not.toContain("onopenbeat");
  });

  test("opening the SCOPE does not also toggle the card underneath", () => {
    const openBeat = /function openBeat\(id: string\): void \{([\s\S]*?)\n  \}/.exec(flow);
    expect(openBeat, "the flow must have an openBeat").not.toBeNull();
    expect(
      openBeat![1]!,
      "asking for the sheet opens the sheet; it must not re-fold the beat as a side effect",
    ).not.toMatch(/expanded\s*=/);
    expect(openBeat![1]!, "…and it must still open the scope").toContain("openScope");
  });

  test("the SCOPE keeps its own explicit click path (nothing was removed)", () => {
    // THE ELEMENT'S OWN TAG, not 200 bytes after its attribute — the template
    // has several handlers within that distance and the window could not say
    // which element carried the one it found.
    expect(
      // THAT ATTRIBUTE'S OWN HANDLER, and the call graph inside it. The
      // element scope stopped a neighbouring element answering; this also
      // stops a neighbouring ATTRIBUTE of the same element answering, and asks
      // the parser for the call rather than matching `onopenbeat(beat.id)` as
      // text — so the same handler written across lines still counts and one
      // named in a string does not.
      bodyCallsWith(
        attributeOf(elementWithAttribute(beat, 'data-chord-target="open-scope"'), "onclick"),
        "onopenbeat",
        ["beat.id"],
      ),
      "the scope grip must survive as a real, titled control",
    ).toBe(true);
  });

  test("only beats with inline depth claim the gesture at all", () => {
    // A card that silently did something other than what its neighbours do
    // would be worse than one that does nothing. Check deltas, harness events
    // and findings carry no inline depth, so they take focus and stop.
    expect(beat).toMatch(
      /const bodyExpands = \$derived\(beat\.kind === "tool" \|\| beat\.kind === "effect"\)/,
    );
  });
});

// ── ROOM-LOCAL CHORDS ──────────────────────────────────────────────────────

/**
 * A read of the platform modifier that is not a NEGATION.
 *
 * `!ev.metaKey` is a surface excluding modified keys ("plain Enter sends") —
 * that is not a chord, it is a guard against one. A POSITIVE read is a
 * surface deciding that a modified key means something, which is the
 * definition of a chord, and chords belong in a registry.
 *
 * Returns the offending snippets, so the failure message can name them.
 *
 * The path names the mode: a `.svelte` file is lexed as a template (its
 * script block is where a real modifier read hides behind markup), a `.ts`
 * file or TS fragment as code. The default is the probe path for this
 * scanner's own subject — a modifier read is a JavaScript statement, so a
 * bare fragment is code unless the caller says otherwise.
 */
export function findPrivateModifierReads(src: string, path: string = "probe.ts"): string[] {
  const stripped = viewFor(src, path);
  const out: string[] = [];
  for (const m of stripped.matchAll(/\.(metaKey|ctrlKey)\b/g)) {
    // Walk back over the member expression to its first character.
    let i = m.index - 1;
    while (i >= 0 && /[\w$.[\]]/.test(stripped[i]!)) i -= 1;
    while (i >= 0 && /\s/.test(stripped[i]!)) i -= 1;
    if (stripped[i] === "!") continue; // a negation, not a chord
    // AN EXCLUSION GUARD IS NOT A CHORD EITHER. `if (ev.key !== "Tab" ||
    // ev.ctrlKey || ev.metaKey) return;` is the same statement as a row of
    // `!` tests written the other way round: it says "not while a modifier
    // is held". The tell is the BARE early return — a chord does something,
    // an exclusion returns nothing.
    const lineStart = stripped.lastIndexOf("\n", m.index) + 1;
    let lineEnd = stripped.indexOf("\n", m.index);
    if (lineEnd === -1) lineEnd = stripped.length;
    const line = stripped.slice(lineStart, lineEnd);
    if (/\breturn\s*;/.test(line)) continue;
    out.push(stripped.slice(Math.max(0, i - 12), m.index + m[0].length).trim());
  }
  return out;
}

/**
 * THE GAP THIS CLOSES, stated plainly because it is the interesting part.
 *
 * Everything above proves that every SHELL grammar chord has a click path.
 * It passed while ⌘N ("new conversation") and ⌘⇧N ("new project") — the two
 * gestures you need before the product does anything at all — had no control
 * on screen whatsoever. The guard was not too weak in its ASSERTIONS; it was
 * too narrow in SCOPE. Its universe of chords was one table (`GRAMMAR`), and
 * those two chords lived in a second, undeclared one: a capture-phase
 * listener inside SwitchRoom that read `ev.metaKey` for itself. With nothing
 * to compare against, the guard passed vacuously.
 *
 * So the fix is structural, not a bigger list:
 *   1. room-local chords are DECLARED (shell/room-chords.ts) and every
 *      declaration must have its own click path, by the same four rules;
 *   2. reading the platform modifier anywhere but the one owner is refused —
 *      which is what stops a third registry from being invented next time.
 *
 * Both rules are derived from the registry, never hand-listed.
 */
describe("room-local chords — the second registry, under the same law", () => {
  const svelte = walk(COCKPIT_ROOT, { exts: [".svelte"] });
  const paths: ClickPath[] = [];
  for (const f of svelte) paths.push(...findClickPaths(relpath(f), read(f), "data-room-chord"));
  for (const f of svelte) paths.push(...findRoomMenuPaths(relpath(f), read(f), read("src/cockpit/shell/ContextMenu.svelte")));

  test("menu capabilities require the rendered collection, native action and declared chord title", () => {
    const source = read("src/cockpit/rooms/SwitchRoom.svelte");
    const menu = read("src/cockpit/shell/ContextMenu.svelte");
    const scan = (src: string, projected = menu) => findRoomMenuPaths("src/cockpit/rooms/SwitchRoom.svelte", src, projected);
    expect(scan(source).map(path => path.target).sort()).toEqual(ROOM_CHORDS.map(chord => chord.id).sort());
    expect(scan(source.replace('verbs={createVerbs}', 'verbs={optionVerbs}')), 'unrendered capabilities do not count').toEqual([]);
    expect(scan(source, menu.replace('verb.run();', 'void verb.run;')), 'dropping the actual dispatch invalidates the path').toEqual([]);
    expect(scan(source, menu.replace('data-room-chord={verb.roomChord}', '')), 'projection must expose the declared capability').toEqual([]);
    const inert = source.replace('run: openProjectForm', 'run: () => {}');
    expect(scan(inert).find(path => path.target === 'switch.new-project')?.interactive).toBe(false);
    const untitled = source.replace('title: roomChordTitle("switch.new-project")', 'title: "New project"');
    expect(scan(untitled).find(path => path.target === 'switch.new-project')?.teaches).toBe(false);
    const phantom = source.replace('roomChord: "switch.new-project"', 'roomChord: "switch.missing"');
    expect(scan(phantom).some(path => path.target === 'switch.missing'), 'unknown declarations remain visible to the registry guard').toBe(true);
  });

  test("the scan is alive (there ARE room-local chords, and they are found)", () => {
    expect(ROOM_CHORDS.length).toBeGreaterThan(0);
    expect(paths.length).toBeGreaterThan(0);
  });

  test("every control names a REAL room chord (no phantom ids)", () => {
    const known = new Set(ROOM_CHORDS.map((c) => c.id));
    const phantom = [...new Set(paths.map((p) => p.target))].filter((t) => !known.has(t as never));
    expect(phantom, `controls name room chords that do not exist: ${phantom.join(", ")}`).toEqual([]);
  });

  test("NO declared room chord is chord-only", () => {
    const withPath = new Set(paths.map((p) => p.target));
    const chordOnly = ROOM_CHORDS.filter((c) => !withPath.has(c.id)).map(
      (c) => `${c.id} (${c.chord}) — declared in ${c.room}, reachable by keyboard alone`,
    );
    expect(chordOnly, chordOnly.join("\n")).toEqual([]);
  });

  test("every room-chord control is interactive, teaches its chord, clears the floor", () => {
    const bad: string[] = [];
    for (const p of paths) {
      if (!p.interactive) bad.push(`${p.file}: <${p.tag}> claims "${p.target}" but nothing can click it`);
      if (!p.teaches) bad.push(`${p.file}: <${p.tag}> claims "${p.target}" with no title`);
      if (p.cls === null) {
        bad.push(`${p.file}: <${p.tag}> claims "${p.target}" with no class — nothing sizes its hit area`);
        continue;
      }
      const { found, ok } = sizesToFloor(styleBlock(read(p.file)), p.cls);
      if (!found) bad.push(`${p.file}: .${p.cls} claims "${p.target}" but has no CSS rule to size it`);
      else if (!ok) bad.push(`${p.file}: .${p.cls} ("${p.target}") does not clear ${HIT_TOKEN}`);
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  test("the tooltip comes from the REGISTRY, so it cannot teach a key that does not fire", () => {
    for (const p of paths) {
      const src = read(p.file);
      expect(
        src.includes(`roomChordTitle("${p.target}")`),
        `${p.file}: the control for "${p.target}" must title itself from roomChordTitle()`,
      ).toBe(true);
    }
    // …and the owner spells the platform-true key (node = non-mac).
    expect(roomChordTitle("switch.new-project")).toBe("+ project · Ctrl+Shift+N");
  });

  test("no surface reads the platform modifier for itself (no third registry)", () => {
    const files = walk(COCKPIT_ROOT, { exts: [".svelte", ".ts"] });
    const offenders: string[] = [];
    for (const f of files) {
      if (relpath(f) === MODIFIER_OWNER) continue;
      for (const hit of findPrivateModifierReads(read(f), relpath(f))) {
        offenders.push(`${relpath(f)}: ${hit} — declare it in shell/room-chords.ts instead`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  test("the owner itself really does the test (the exemption is not a hole)", () => {
    expect(findPrivateModifierReads(read(MODIFIER_OWNER), MODIFIER_OWNER).length).toBeGreaterThan(0);
  });
});

// ── MUTATION SELF-CHECKS ───────────────────────────────────────────────────

const AT = "src/cockpit/rooms/Example.svelte";

describe("mutation — the scanners catch what they claim to", () => {
  test("a chord-only target is flagged (no control names it)", () => {
    const actionable = claimedTargets([["probe.ts", `shell.claimKey("arm", () => {});`]]);
    const withPath = new Set(findClickPaths(AT, `<button title="x" onclick={f}>go</button>`).map((p) => p.target));
    expect([...actionable].filter((t) => !withPath.has(t))).toEqual(["arm"]);
  });

  test("a claim on a non-interactive element is flagged", () => {
    const found = findClickPaths(AT, `<div data-chord-target="lens" title="t">lens</div>`);
    expect(found).toHaveLength(1);
    expect(found[0]!.interactive).toBe(false);
  });

  test("a div WITH onclick counts as interactive (the honest escape hatch)", () => {
    const found = findClickPaths(AT, `<div data-chord-target="lens" title="t" onclick={f}>lens</div>`);
    expect(found[0]!.interactive).toBe(true);
  });

  test("a control with no tooltip is flagged (it cannot teach the chord)", () => {
    const found = findClickPaths(AT, `<button data-chord-target="lens" onclick={f}>lens</button>`);
    expect(found[0]!.teaches).toBe(false);
  });

  test("a body click that ALSO opens the scope is caught (the inverted guard bites)", () => {
    // The pre-decision handler, verbatim. If it comes back, the assertion
    // above goes red on the same string.
    const before = `function onBodyClick(): void {\n    if (!bodyOpens) return;\n    onopenbeat(beat.id);\n  }`;
    const body = /function onBodyClick\(\): void \{([\s\S]*?)\n  \}/.exec(before);
    expect(body![1]!.includes("onopenbeat")).toBe(true);
    expect(body![1]!.includes("onexpandbeat(beat.id)")).toBe(false);
  });

  test("an openBeat that also toggles the expansion is caught", () => {
    const before = `function openBeat(id: string): void {\n    expanded = { ...expanded, [id]: true };\n    shell.openScope({});\n  }`;
    const m = /function openBeat\(id: string\): void \{([\s\S]*?)\n  \}/.exec(before);
    expect(/expanded\s*=/.test(m![1]!)).toBe(true);
  });

  test("a commented-out control does NOT count as a click path", () => {
    expect(
      findClickPaths(AT, `<!-- <button data-chord-target="lens" title="t" onclick={f}>lens</button> -->`),
    ).toEqual([]);
    // A `//`-commented control only exists inside a script block — a bare `//`
    // line in MARKUP is prose Svelte renders, not a comment (the mode machine
    // follows the language), so the real shape of this mutation carries its
    // script fence. The commented-out control still must not count.
    expect(
      findClickPaths(AT, `<script>// const note = '<button data-chord-target="lens" title="t" onclick={f}>x</button>';</script>`),
    ).toEqual([]);
  });

  test("a comment that SPELLS a tag in prose is not a click path either", () => {
    // The defect class the stripper exists for: prose naming a tag is not a
    // rendered control — and must not supply the target a live sibling lacks.
    expect(
      findClickPaths(AT, `<!-- this row rides the real <button> rows below -->`),
    ).toEqual([]);
    const live = findClickPaths(
      AT,
      `<!-- <button data-chord-target="lens" title="t" onclick={f}>old</button> -->\n` +
        `<button data-chord-target="lens" onclick={f}>lens</button>`,
    );
    expect(live).toMatchObject([{ target: "lens", interactive: true, teaches: false }]);
  });

  test("a ChordGrip names its target and is self-titling", () => {
    const found = findClickPaths(AT, `<ChordGrip target="custody" label="custody" onclick={f} />`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ target: "custody", interactive: true, teaches: true });
  });

  test("a DYNAMIC target is not counted — the call site must spell it out", () => {
    expect(findClickPaths(AT, `<ChordGrip target={item.target} onclick={f} />`)).toEqual([]);
    expect(findClickPaths(AT, `<button data-chord-target={t} title="x" onclick={f}>go</button>`)).toEqual([]);
  });

  test("multi-line and multi-attribute tags are still read", () => {
    const src = `<button\n  class="grip"\n  data-chord-target="expand"\n  title={tExpand}\n  onclick={go}\n>expand</button>`;
    expect(findClickPaths(AT, src)).toMatchObject([{ target: "expand", interactive: true, teaches: true }]);
  });

  test("claimedTargets ignores a commented-out claim", () => {
    expect(claimedTargets([["probe.ts", `// shell.claimKey("arm", f)`]]).size).toBe(0);
    expect(claimedTargets([["probe.ts", `/* shell.claimKey("arm", f) */`]]).size).toBe(0);
  });

  test("shellHandledTargets reads both the branches and the room table", () => {
    const src = `
      const ROOM_TARGETS = { switch: "switch", custody: "custody" };
      if (spec.target === "desk") {}
      if (spec.target === "send") {}
    `;
    const found = shellHandledTargets(src, "probe.ts");
    expect([...found].sort()).toEqual(["custody", "desk", "send", "switch"]);
  });

  test("a control sized below the floor is flagged", () => {
    const style = `<style>.tiny { padding: 2px; color: red; }</style>`;
    expect(sizesToFloor(style, "tiny")).toEqual({ found: true, ok: false });
  });

  test("shared floor discovery covers grouped and low-specificity recipes without accepting variants", () => {
    const floor = "min-width: var(--hit-min); min-height: var(--hit-min)";
    expect([...floorClassesFrom(`
      .cockpit .group .nested, .cockpit .second { ${floor} }
      .cockpit :where(.neutral) { ${floor} }
      .cockpit .partial { min-height: var(--hit-min) }
      .cockpit .variant.only, .cockpit .hover:hover { ${floor} }
    `)].sort()).toEqual(["neutral", "second"]);
    expect(sizesToFloor('.dense { min-width: var(--row-h); min-height: var(--row-h) }', 'dense').ok).toBe(false);
    expect(sizesToFloor('.verb { min-height: var(--row-h) }', 'verb').ok).toBe(false);
    expect(sizesToFloor('.verb { min-width: 0 }', 'verb').ok).toBe(false);
    expect(sizesToFloor('.verb { width: 12px; color: red }', 'verb').ok).toBe(true);
  });

  test("a control with only ONE axis at the floor is flagged", () => {
    const style = `<style>.half { min-height: var(--hit-min); }</style>`;
    expect(sizesToFloor(style, "half").ok).toBe(false);
  });

  test("a control at the floor in both axes passes", () => {
    const style = `<style>.ok { min-height: var(--hit-min); min-width: var(--hit-min); }</style>`;
    expect(sizesToFloor(style, "ok")).toEqual({ found: true, ok: true });
  });

  test("an explicitly larger token size satisfies its axis", () => {
    const style = `<style>.big { width: var(--sp-6); height: var(--monitor-h); min-width: var(--hit-min); }</style>`;
    expect(sizesToFloor(style, "big").ok).toBe(true);
  });

  test("a class with no rule at all is reported, not assumed fine", () => {
    expect(sizesToFloor(`<style>.other { min-height: var(--hit-min); }</style>`, "missing"))
      .toEqual({ found: false, ok: false });
  });

  test("a literal 24px instead of the token does NOT satisfy the floor (one owner)", () => {
    const style = `<style>.literal { min-height: 24px; min-width: 24px; }</style>`;
    expect(sizesToFloor(style, "literal").ok).toBe(false);
  });

  test("findClickPaths reports the class that must carry the floor", () => {
    const found = findClickPaths(AT, `<button class="beat-grip glyph" data-chord-target="expand" title="t" onclick={f}>x</button>`);
    expect(found[0]!.cls).toBe("beat-grip");
  });

  // ── room-local chords ────────────────────────────────────────────────────

  test("mutation: a declared room chord with NO control is flagged", () => {
    const withPath = new Set(
      findClickPaths(AT, `<button class="verb" title="t" onclick={f}>new project</button>`, "data-room-chord").map(
        (p) => p.target,
      ),
    );
    // The real assertion, on a source where the control lost its attribute:
    // every declared chord goes unmatched.
    expect(ROOM_CHORDS.filter((c) => !withPath.has(c.id)).length).toBe(ROOM_CHORDS.length);
  });

  test("mutation: a room-chord control is read with its tag, title and class", () => {
    const found = findClickPaths(
      AT,
      `<button class="verb create" data-room-chord="switch.new-project" title="t" onclick={f}>new project</button>`,
      "data-room-chord",
    );
    expect(found).toMatchObject([
      { target: "switch.new-project", interactive: true, teaches: true, cls: "verb" },
    ]);
  });

  test("mutation: a room-chord control commented out does not count", () => {
    expect(
      findClickPaths(AT, `<!-- <button data-room-chord="switch.new-project" title="t" onclick={f}>x</button> -->`, "data-room-chord"),
    ).toEqual([]);
  });

  test("mutation: the two registries do not read each other's attributes", () => {
    const src = `<button data-chord-target="switch" title="t" onclick={f}>go</button>`;
    expect(findClickPaths(AT, src, "data-room-chord")).toEqual([]);
    expect(findClickPaths(AT, src)).toHaveLength(1);
  });

  test("mutation: a POSITIVE modifier read is flagged; a negation is not", () => {
    expect(findPrivateModifierReads(`const p = isMac ? ev.metaKey : ev.ctrlKey;`)).toHaveLength(2);
    expect(findPrivateModifierReads(`if (ev.key === "Enter" && !ev.metaKey && !ev.ctrlKey) send();`)).toEqual([]);
    expect(findPrivateModifierReads(`if (e.shiftKey && !e.ctrlKey) zoom();`)).toEqual([]);
    // A whitespace-separated negation is still a negation.
    expect(findPrivateModifierReads(`if (! ev.ctrlKey) {}`)).toEqual([]);
    // An exclusion guard — "only the plain key" — is not a chord.
    expect(
      findPrivateModifierReads(`if (ev.key !== "Tab" || ev.ctrlKey || ev.metaKey) return;`),
    ).toEqual([]);
    // …but a modifier that DOES something still is, even inside an if.
    expect(findPrivateModifierReads(`if (ev.metaKey) save();`)).toHaveLength(1);
    // A type declaration is not a read.
    expect(findPrivateModifierReads(`type E = { metaKey: boolean; ctrlKey: boolean };`)).toEqual([]);
    // …and a commented-out read is not a read either.
    expect(findPrivateModifierReads(`// const p = ev.metaKey;`)).toEqual([]);
  });

  // ── the widening: it must still be able to say no ────────────────────────

  const KNOWN = new Set<string>(["focus-prev", "focus-next", "lens"]);
  const decl = (over: Partial<GesturePath> = {}): GesturePath => ({
    target: "focus-prev",
    marker: "data-beat-id",
    source: AT,
    gesture: "click the fact you want — every beat row focuses itself on a click",
    ...over,
  });
  /** A source that genuinely carries the path: interactive, and consuming. */
  const HONEST_SOURCE =
    `import { gestureKeysFor } from "../shell/mouse-paths.ts";\n` +
    `<div data-beat-id={beat.id} onclick={focus}>row</div>`;

  test("mutation: a gesture path whose element is NOT RENDERED is flagged", () => {
    const bad = verifyGesturePath(
      decl(),
      `import { gestureKeysFor } from "../shell/mouse-paths.ts";\n<div class="row">row</div>`,
      KNOWN,
    );
    expect(bad.join("\n")).toMatch(/declared but not rendered/);
  });

  test("mutation: a gesture path on a NON-INTERACTIVE element is flagged", () => {
    // The marker is there; nothing can click it. A path you cannot take.
    const bad = verifyGesturePath(
      decl(),
      `import { gestureKeysFor } from "../shell/mouse-paths.ts";\n<div data-beat-id={id}>row</div>`,
      KNOWN,
    );
    expect(bad.join("\n")).toMatch(/declared but not rendered/);
  });

  test("mutation: a gesture path the surface never CONSUMES is flagged", () => {
    // The element exists and is clickable, but nothing ties it to the
    // declaration — so the declaration is a note, and notes teach nothing.
    const bad = verifyGesturePath(decl(), `<div data-beat-id={id} onclick={focus}>row</div>`, KNOWN);
    expect(bad.join("\n")).toMatch(/never imports/);
  });

  test("mutation: a gesture path for a PHANTOM chord is flagged", () => {
    expect(
      verifyGesturePath(decl({ target: "arm" as never }), HONEST_SOURCE, KNOWN).join("\n"),
    ).toMatch(/not a grammar target/);
  });

  test("mutation: a gesture path with no stated gesture is flagged", () => {
    expect(verifyGesturePath(decl({ gesture: "click" }), HONEST_SOURCE, KNOWN).join("\n")).toMatch(
      /plain words/,
    );
  });

  test("mutation: a COMMENTED-OUT element does not satisfy a gesture path", () => {
    const bad = verifyGesturePath(
      decl(),
      `import { gestureKeysFor } from "../shell/mouse-paths.ts";\n` +
        `<!-- <div data-beat-id={id} onclick={focus}>row</div> -->`,
      KNOWN,
    );
    expect(bad.join("\n")).toMatch(/declared but not rendered/);
  });

  test("mutation: an honest declaration passes (the widening is not useless in reverse)", () => {
    expect(verifyGesturePath(decl(), HONEST_SOURCE, KNOWN)).toEqual([]);
  });

  test("mutation: a chord with NEITHER a control NOR a declaration is still chord-only", () => {
    // The whole point: widening the definition must not remove the answer
    // "no". `lens` here is claimed, has no control, and no gesture declared.
    const claimed = claimedTargets([["probe.ts", `shell.claimKey("lens", () => {});`]]);
    const withControl = new Set(findClickPaths(AT, `<button title="x" onclick={f}>go</button>`).map((p) => p.target));
    const gestures = new Set(
      [decl()].filter((g) => verifyGesturePath(g, HONEST_SOURCE, KNOWN).length === 0).map((g) => g.target),
    );
    const withPath = new Set([...withControl, ...gestures]);
    expect([...claimed].filter((t) => !withPath.has(t))).toEqual(["lens"]);
  });

  test("a clean control set produces no findings (no false positives)", () => {
    const src = `<button data-chord-target="send" title={tSend} onclick={onSubmit}>send</button>`;
    const found = findClickPaths(AT, src);
    expect(found).toMatchObject([{ target: "send", interactive: true, teaches: true }]);
  });
});
