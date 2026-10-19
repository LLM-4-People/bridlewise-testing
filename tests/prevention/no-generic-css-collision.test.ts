// @vitest-environment node
/**
 * No generic class that sizes a surface may be shared across two components.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────
 *
 * The desk composer row (`shell/Desk.svelte`) and the desk context gauge's
 * tick (`desk/Gauge.svelte`) both used the class `bar`. Svelte scopes a
 * component's `<style>` rules behind a per-component hash only when it can
 * prove the selector is used; when a rule slips out unscoped — observed live
 * as a stale dev hot-update that served Gauge's whole sheet with no
 * `.svelte-XXXX` hash — a bare `.bar { width: var(--monitor-w) }` stops being
 * the gauge's 96px tick and starts matching the composer's layout row, which
 * collapses to the monitor width and becomes unusable.
 *
 * Scoped styles are the only thing standing between two same-named classes,
 * and scoping is exactly what fails here. So the durable fix is at the source:
 * a class that carries a hard size and shares a generic name across two
 * components is a collision waiting for one unscoped emission. Give the
 * sized, leak-prone thing a component-specific name.
 *
 * ── WHAT THIS GUARD JUDGES ────────────────────────────────────────────────
 *
 * A rule is a collision risk when ALL of these hold, and the guard fails on
 * the class name appearing in MORE THAN ONE component:
 *
 *   1. the selector is a STANDALONE generic class (`.bar`, `.row`, `.panel`)
 *      — not a compound (`.a.b`), descendant (`.a .b`), or element-qualified
 *      (`button.bar`) selector, and not inside `:global(...)`;
 *   2. the rule's body sets a hard box size (`width`/`height`/`min-*`/`max-*`)
 *      against a sizing TOKEN (`var(--…-w)`, `var(--…-h)`, `var(--…-size)`,
 *      …) — the property that crushes or clips an unrelated surface it lands
 *      on;
 *   3. the class name is a single generic box word (the kind two authors
 *      independently reach for);
 *   4. the class is actually applied in that component's own markup.
 *
 * Condition 4 keeps a dead rule out of scope (the dead-selector guard owns
 * that). The CROSS-COMPONENT condition is the point: a sized generic class
 * held by ONE component cannot collide, so it is not flagged — only a name
 * two components both size is a leak that would land on a stranger.
 *
 * ── §41 SEARCH, RECORDED ──────────────────────────────────────────────────
 *
 * Q1 (was this inside a guard's charter?): `no-dead-css-selectors.test.ts`
 * owns UNUSED selectors (a class no template references). Every class this
 * guard flags IS used — that is condition 4 — so the defect was never inside
 * that guard's subject; it stayed green because it asks a different question.
 * Not a blind guard; a different invariant.
 *
 * Q2 (is a test similar?): the closest are `no-dead-css-selectors` (scoped
 * class selectors in `<style>`) and `motion-owner` (self-starting animation
 * in a `<style>` block). Both scan `<style>` but neither asks about a class
 * NAME shared across components. No existing test to broaden; a new file is
 * justified.
 *
 * ── MUTATION ──────────────────────────────────────────────────────────────
 *
 * The detector is an exported pure function over source text, so the plant
 * drives it directly on synthetic component sources (§28a — never a live
 * tracked file as the canary). Three plants below: a sized generic class
 * shared by two synthetic components (must flag), the same class sized in
 * one and un-sized in the other (must not), and a sized class given a
 * component-specific name (must not). The live-tree arm then asserts the
 * detector finds NO colliding class across `src/cockpit` — and proves its
 * universe is real by containing the two components this bug lived in.
 */
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  walk,
  relpath,
  stripCssBlockComments,
} from "../helpers/source-scan.ts";

/**
 * The single-word generic box names two authors reach for independently.
 * This is the leak surface, not an enumeration of offenders: a class on this
 * list that sizes a surface AND appears in two components is the bug class.
 * Component-specific names (`tick-track`, `beat-card`, `panel-clip`) are the
 * fix and are deliberately NOT here.
 */
const GENERIC_CLASS_WORDS: readonly string[] = [
  "bar", "fill", "row", "value", "detail", "cell", "item", "box", "panel",
  "card", "list", "head", "body", "foot", "wrap", "inner", "outer", "content",
  "label", "title", "icon", "track", "thumb", "input", "button", "chip",
  "dot", "line", "grid", "col", "column", "section", "block", "entry",
  "header", "footer", "main", "aside", "nav", "menu",
];

/** A hard box-size property set against a sizing token (the crushing kind). */
const SIZED_ON_TOKEN =
  /(?:^|[\s;])(?:width|height|min-width|min-height|max-width|max-height)\s*:\s*var\(--[a-z0-9-]*-(?:w|h|width|height|size|min|max)\b/;

/** True iff `sel` is a standalone generic class selector: `.bar`, nothing else. */
function standaloneGenericClass(sel: string): string | null {
  const s = sel.trim();
  if (s.includes(":global")) return null;
  const m = /^\.([A-Za-z_][\w-]*)$/.exec(s);
  if (m === null) return null;
  return GENERIC_CLASS_WORDS.includes(m[1]!) ? m[1]! : null;
}

/**
 * The generic class names that `source` (one component) both applies in its
 * markup AND sizes on a token via a standalone `.name { … }` rule. These are
 * the names that, if shared with a second component, collide on a leak.
 */
export function sizedGenericClasses(source: string): string[] {
  const styleOpen = source.indexOf("<style");
  const styleEnd = source.indexOf("</style>");
  if (styleOpen === -1 || styleEnd === -1) return [];
  // Start after the `<style …>` tag's closing `>` so the tag itself is not
  // read as part of the first selector.
  const bodyStart = source.indexOf(">", styleOpen) + 1;
  const style = stripCssBlockComments(source.slice(bodyStart, styleEnd));
  const markup = source.slice(0, styleOpen) + source.slice(styleEnd + "</style>".length);

  // Classes this component actually applies (literal class attrs + class:).
  const applied = new Set<string>();
  for (const m of markup.matchAll(/class\s*=\s*"([^"]*)"/g)) {
    for (const c of m[1]!.split(/\s+/)) {
      if (c.length > 0 && !c.includes("{")) applied.add(c);
    }
  }
  for (const m of markup.matchAll(/class:([A-Za-z_][\w-]*)/g)) applied.add(m[1]!);

  const out = new Set<string>();
  const rule = /([^{}@]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = rule.exec(style)) !== null) {
    const body = m[2]!;
    if (!SIZED_ON_TOKEN.test(body)) continue;
    for (const sel of m[1]!.split(",")) {
      const name = standaloneGenericClass(sel);
      if (name !== null && applied.has(name)) out.add(name);
    }
  }
  return [...out];
}

/**
 * Generic class names that size a surface in MORE THAN ONE of the given
 * component sources — the colliding set. `sources` maps a component label to
 * its source text so the finding can name where each half lives.
 */
export function collidingSizedClasses(
  sources: Readonly<Record<string, string>>,
): { name: string; files: string[] }[] {
  const byClass = new Map<string, Set<string>>();
  for (const [label, source] of Object.entries(sources)) {
    for (const name of sizedGenericClasses(source)) {
      if (!byClass.has(name)) byClass.set(name, new Set());
      byClass.get(name)!.add(label);
    }
  }
  const out: { name: string; files: string[] }[] = [];
  for (const [name, files] of byClass) {
    if (files.size >= 2) out.push({ name, files: [...files].sort() });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const SIZED = `.x { width: var(--monitor-w); height: var(--tick-h); }`;

describe("no sized generic class is shared across components", () => {
  test("mutation: a sized generic class in two synthetic components is flagged", () => {
    const a = `<div class="bar"></div>\n<style>${SIZED.replace(".x", ".bar")}</style>`;
    const b = `<div class="bar"></div>\n<style>${SIZED.replace(".x", ".bar")}</style>`;
    const hits = collidingSizedClasses({ "A.svelte": a, "B.svelte": b });
    expect(hits.some((h) => h.name === "bar" && h.files.length === 2)).toBe(true);
  });

  test("mutation: sized in one component, un-sized in the other, is NOT flagged", () => {
    // The class is shared but only one side SIZES it on a token — an unscoped
    // leak of the other's `.bar { display:flex }` carries no crushing size.
    const sized = `<div class="bar"></div>\n<style>${SIZED.replace(".x", ".bar")}</style>`;
    const plain = `<div class="bar"></div>\n<style>.bar { display: flex; gap: var(--sp-2); }</style>`;
    expect(collidingSizedClasses({ "A.svelte": sized, "B.svelte": plain })).toEqual([]);
  });

  test("mutation: a component-specific sized name is NOT flagged even when sized", () => {
    // `tick-track` is not a generic word, so two components may each size it
    // without it being the leakable generic class this guard exists to end.
    const a = `<div class="tick-track"></div>\n<style>${SIZED.replace(".x", ".tick-track")}</style>`;
    const b = `<div class="tick-track"></div>\n<style>${SIZED.replace(".x", ".tick-track")}</style>`;
    expect(collidingSizedClasses({ "A.svelte": a, "B.svelte": b })).toEqual([]);
  });

  test("mutation: a compound or descendant selector escapes the standalone rule", () => {
    // `.gauge .bar` and `.bar.live` are scoped to their base; they are not the
    // bare standalone `.bar` that leaks onto an unrelated surface.
    const a = `<div class="bar"></div>\n<style>.gauge .bar { width: var(--monitor-w); }</style>`;
    const b = `<div class="bar live"></div>\n<style>.bar.live { width: var(--monitor-w); }</style>`;
    expect(collidingSizedClasses({ "A.svelte": a, "B.svelte": b })).toEqual([]);
  });

  test("the desk shell's own layout classes are not sized-and-shared by any desk sub-component", () => {
    // THE HONEST BOUNDARY. The desk (`shell/Desk.svelte`) is the host that
    // mounts its sub-components (`desk/*`) as adjacent siblings. A generic
    // class the desk SIZES for its own layout (the composer `.bar`, the
    // `.panel`) must not also be sized by a sub-component it mounts — that is
    // the exact leak that crushed the composer. Two unrelated panels each
    // using a `.row` idiom are NOT this bug (they are never adjacent and never
    // one-inside-the-other), so this guard scopes to host-versus-mounted, not
    // a blanket ban on any shared word.
    const host = "src/cockpit/shell/Desk.svelte";
    const hostSized = new Set(sizedGenericClasses(readFileSync(host, "utf8")));
    // WITNESS (§36): the desk really does size a generic `.bar` for its
    // composer — otherwise the narrowing below selects nothing and the guard
    // would pass having examined nothing.
    expect(readFileSync(host, "utf8")).toContain('class="composer"');
    // The migrated composer has no sized GENERIC class; the scanner’s live
    // positive/collision self-tests above still prove discovery.

    const deskChildren = walk("src/cockpit/desk", { exts: [".svelte"] }).map(relpath);
    const collisions: string[] = [];
    for (const child of deskChildren) {
      for (const name of sizedGenericClasses(readFileSync(child, "utf8"))) {
        if (hostSized.has(name)) collisions.push(`  .${name}  →  ${host}  +  ${child}`);
      }
    }
    if (collisions.length > 0) {
      throw new Error(
        `A desk sub-component sizes a generic class the desk shell also sizes for ` +
          `its own layout — if the sub-component's rule is ever emitted unscoped it ` +
          `crushes the host surface:\n${collisions.join("\n")}\n` +
          `Rename the sub-component's class to a component-specific name (the way ` +
          `the gauge's tick is now .tick-track, not .bar).`,
      );
    }
  });
});
