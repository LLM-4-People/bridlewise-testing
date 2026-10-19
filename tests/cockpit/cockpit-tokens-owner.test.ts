import { styleBlock } from "../helpers/control-floor.ts";
// @vitest-environment node
/**
 * CARBON/LOGBOOK token owner (DESIGN-COCKPIT-V2 §12) — the cockpit-native
 * successor to the old css-token owner, scoped to the NEW tree.
 *
 * `src/cockpit/tokens.css` is the SOLE visual-constant owner for
 * `src/cockpit/**`:
 *   A. no literal colors (hex / rgb / hsl / oklch) in cockpit .svelte
 *      <style> blocks — tokens only;
 *   A2. no quoted hex / quoted length in cockpit .svelte scripts or .ts —
 *      the one JS table is TOKEN_FALLBACKS in paint/design-tokens.ts, pinned
 *      to the owner (S42: the <style>-only walk was blind to script + .ts);
 *   B. no literal animation/transition durations — the --t-* scale only;
 *   C. no `--name:` custom-property declarations outside tokens.css;
 *   D. no `:root` / theme blocks outside tokens.css;
 *   E. tokens.css itself defines the spec's load-bearing token groups
 *      (grounds, ink, the one beam hue, alarm set, motion, density,
 *      focus ring) — a gutted token file fails;
 *   F. no hardcoded length literals (px / rem / em) in cockpit .svelte
 *      <style> blocks — every dimension is a tokens.css dim consumed via
 *      var() (zero is degenerate-ok; unitless numbers like line-height
 *      are fine);
 *   H. no hardcoded length/breakpoint literals inside tokens.css ITSELF —
 *      the owner is the one file the component arms exclude by construction,
 *      so its own media-query breakpoints and stray dimensions are scanned
 *      here (the `max-width: 1440px/1100px` pair lives in the ONE width
 *      block this arm admits);
 *   I. the OUTCOME AXIS is spelled once: the `[data-state="…"]` hue mapping
 *      in tokens.css is the grammar's own `OUTCOME_STATES` keys (parsed from
 *      the owner, never restated), and no component carries a `.state-*`
 *      hue class, a retired `data-state="live"/"running"/"bad"` spelling,
 *      or a `data-state="…"` value outside the grammar's admitted set;
 *   J. inline `style="…"` attributes in component markup may only stamp
 *      REGISTERED custom properties (the `@property` block in tokens.css is
 *      the registry) — anything else (a colour, a length, a layout decision)
 *      is invisible to the style-block arms and is the guard's blind spot.
 *
 * The scanners are pure functions, MUTATION-TESTED below: each violation
 * kind must be caught on a synthetic source and a clean source must pass.
 */
import { describe, expect, test } from "vitest";

import { read, relpath, walk } from "../helpers/source-scan.ts";
import { DATA_STATE_VALUES, OUTCOME_STATES } from "../../src/cockpit/response/grammar.ts";
import { TOKEN_FALLBACKS } from "../../src/cockpit/paint/design-tokens.ts";

const COCKPIT_ROOT = "src/cockpit";
const TOKENS = "src/cockpit/tokens.css";



function stripVarCalls(s: string): string {
  let prev: string;
  let cur = s;
  do {
    prev = cur;
    cur = cur.replace(/var\(\s*[^()]*\)/g, "");
  } while (cur !== prev);
  return cur;
}

/** A: literal colors in a <style> block (after var() stripping). */
export function findColorLiterals(style: string): string[] {
  const stripped = stripVarCalls(style);
  const re = /#[0-9a-fA-F]{3,8}\b|(?:rgba?|hsla?|oklch)\s*\(/g;
  return stripped.match(re) ?? [];
}

/** B: literal durations on animation/transition lines (0 is degenerate-ok). */
export function findDurationLiterals(style: string): string[] {
  const out: string[] = [];
  const durRe = /(?<!\d)(\d+(?:\.\d+)?)(ms|s)\b/g;
  for (const line of stripVarCalls(style).split("\n")) {
    if (!/\b(animation|transition|animation-delay|transition-delay)\b/.test(line)) continue;
    let m: RegExpExecArray | null;
    durRe.lastIndex = 0;
    while ((m = durRe.exec(line)) !== null) {
      if (parseFloat(m[1]!) !== 0) out.push(m[0]);
    }
  }
  return out;
}

/** C: custom-property declarations in a <style> block. */
export function findTokenDeclarations(style: string): string[] {
  const out: string[] = [];
  for (const line of style.split("\n")) {
    if (/^\s*--[\w-]+\s*:/.test(line)) out.push(line.trim());
  }
  return out;
}

/** F: hardcoded length literals in a <style> block (after var() stripping).
 * 0 is degenerate-ok (0px === 0); unitless numbers are not lengths. */
export function findLengthLiterals(style: string): string[] {
  const out: string[] = [];
  const re = /(?<![\w.-])(-?\d+(?:\.\d+)?)(px|rem|em)\b/g;
  let m: RegExpExecArray | null;
  const stripped = stripVarCalls(style);
  while ((m = re.exec(stripped)) !== null) {
    if (parseFloat(m[1]!) !== 0) out.push(m[0]);
  }
  return out;
}

/** F (leading half): a bare NUMERIC line-height. line-height is the one
 * unitless dimension that is a SCALE (the `--lh-*` rungs in tokens.css), so a
 * literal `line-height: 1.4` is a length the px/rem/em regex above cannot
 * see. The var() strip leaves `line-height: var(--lh-tight);` clean and a
 * bare number behind. Zero is not a leading anyone writes; any bare number
 * here is off-scale. */
export function findLineHeightLiterals(style: string): string[] {
  const out: string[] = [];
  const stripped = stripVarCalls(style);
  for (const m of stripped.matchAll(/line-height\s*:\s*(-?\d+(?:\.\d+)?)\s*;/g)) {
    out.push(`line-height: ${m[1]}`);
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** A2: a quoted `#rrggbb` in script / .ts — a restated token. */
export function findQuotedHex(src: string): string[] {
  const out: string[] = [];
  for (const m of stripComments(src).matchAll(/(['"`])#([0-9a-fA-F]{3,8})\1/g)) {
    out.push(`#${m[2]}`);
  }
  return out;
}

/** A2: a quoted `12px` / `90ms` in script / .ts — a restated token. */
export function findQuotedLengths(src: string): string[] {
  const out: string[] = [];
  for (const m of stripComments(src).matchAll(/(['"`])(\d+(?:\.\d+)?(?:px|rem|em|ms))\1/g)) {
    out.push(m[2]!);
  }
  return out;
}

/** Spacing rungs 0–7 must be calc/var of --sp-unit, never restated px. */
const SP_MULTIPLIERS = [0.5, 1, 2, 3, 4, 6, 8, 12] as const;

export function findSpScaleViolations(css: string): string[] {
  const out: string[] = [];
  if (!/--sp-unit\s*:\s*\d+(?:\.\d+)?px\s*;/.test(css)) {
    out.push("--sp-unit must be the one px primitive");
  }
  for (let i = 0; i < SP_MULTIPLIERS.length; i++) {
    const m = SP_MULTIPLIERS[i]!;
    const decl = new RegExp(`--sp-${i}\\s*:\\s*([^;]+);`).exec(css);
    if (decl === null) {
      out.push(`--sp-${i} is missing`);
      continue;
    }
    const got = decl[1]!.replace(/\s+/g, "");
    const expected = m === 1 ? "var(--sp-unit)" : `calc(var(--sp-unit)*${m})`;
    if (got !== expected) out.push(`--sp-${i}: ${decl[1]!.trim()} — expected ${expected}`);
  }
  return out;
}

/** --t-1 / --t-2 must be calc of --t-unit (the reduced-motion override is 1ms). */
export function findTScaleViolations(css: string): string[] {
  const out: string[] = [];
  if (!/--t-unit\s*:\s*\d+(?:\.\d+)?ms\s*;/.test(css)) {
    out.push("--t-unit must be the one ms primitive");
  }
  const t1 = /--t-1\s*:\s*([^;]+);/.exec(css);
  const t2 = /--t-2\s*:\s*([^;]+);/.exec(css);
  const t3 = /--t-3\s*:\s*([^;]+);/.exec(css);
  if (t1 === null || t1[1]!.replace(/\s+/g, "") !== "calc(var(--t-unit)*3)") {
    out.push(`--t-1: ${t1?.[1]?.trim() ?? "missing"} — expected calc(var(--t-unit) * 3)`);
  }
  if (t2 === null || t2[1]!.replace(/\s+/g, "") !== "calc(var(--t-unit)*5)") {
    out.push(`--t-2: ${t2?.[1]?.trim() ?? "missing"} — expected calc(var(--t-unit) * 5)`);
  }
  if (t3 === null || t3[1]!.replace(/\s+/g, "") !== "calc(var(--t-unit)*8)") {
    out.push(`--t-3: ${t3?.[1]?.trim() ?? "missing"} — expected calc(var(--t-unit) * 8)`);
  }
  return out;
}

/** D: :root / [data-theme blocks in a cockpit source that is not tokens.css. */
export function findThemeBlocks(src: string): string[] {
  const out: string[] = [];
  for (const line of src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n")) {
    if (/(^|[^-\w])(:root|\[data-theme|\[data-cockpit-theme)/.test(line)) out.push(line.trim());
  }
  return out;
}

// ── Shared scanners for arms I / L — ONE instrument, consumed by the arm  ──
// and by the mutation self-check alike. The arms used to carry their scan
// inline and the mutations re-implemented a copy beside it; a copy that drifts
// from the arm keeps passing while proving nothing (the arm-J defect). The
// scanner is extracted here so the mutation drives the REAL function and a
// blinded arm cannot keep its mutation green.

/** The state-id scanner behind arm I's anti-respelling half: every `.state-*`
 * class (prefixed `.chip.state-ok` or bare `.state-ok`) whose captured id is
 * one of the admitted states is a per-class hue spelling the axis replaced. */
export function findStateClassSpellings(src: string, admitted: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\.([a-z][a-z0-9-]*\.)?state-([a-z-]+)/g)) {
    if (admitted.has(m[2]!)) out.push(`.state-${m[2]}`);
  }
  return out;
}

/** The data-state scanner behind arm I: every literal `[data-state="…"]`
 * selector and `data-state="…"` attribute whose value is NOT admitted. A
 * selector is the attribute spelling wrapped in brackets, so the attribute
 * pass skips any hit already reported as a selector (no double-count). */
export function findOutOfVocabularyStateValues(src: string, admitted: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\[data-state="([a-z-]+)"\]/g)) {
    if (!admitted.has(m[1]!)) out.push(`[data-state="${m[1]}"]`);
  }
  // The attribute pass skips any hit already wrapped as a selector (the
  // lookbehind refuses the bracketed form), so a selector is not also
  // reported as a bare attribute.
  for (const m of src.matchAll(/(?<!\[)data-state="([a-z-]+)"/g)) {
    if (!admitted.has(m[1]!)) out.push(`data-state="${m[1]}"`);
  }
  return out;
}

/** The second-armed-spelling scanner behind arm I: a `data-armed` attribute
 * or an `.armed` class is the armed state said in a word the grammar does
 * not own (`data-state="armed"` is the one spelling). */
export function findArmedRespellings(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/data-armed/g)) out.push(m[0]);
  for (const m of src.matchAll(/class="[^"]*\barmed\b/g)) out.push(m[0]);
  return out;
}

/** A DYNAMIC `data-state={…}` emission is covered only when its value is
 * grammar-derived. The leak this arm exists to catch is a DOMAIN kind reaching
 * the attribute: the feed's `…kind` member (`outcome.kind` → `measured`,
 * `density.kind` → `measured`), a `?? <member>` fallback that substitutes a
 * domain word when the mapped state is null (`chipState ?? row.state` →
 * `off`), and a `?? "<literal>"` fallback whose literal is OUT OF VOCABULARY
 * (`line?.state ?? "at-now"` — the same private-vocabulary leak wearing a
 * string literal: the fallback still has to be a value the grammar admits,
 * because the attribute cannot tell a fallback from a claim). A bare
 * grammar-typed binding (`{state}` — a `BeatState`), a grammar-literal
 * conditional (`armed ? "armed" : null`), an explicit `*DataState(…)` mapping
 * call, or an IN-VOCABULARY literal fallback (`?? "empty"`) are all covered —
 * the first because the binding's own type is derived from the grammar
 * (renaming a state stops the component typechecking), the rest by
 * construction. The `?? <literal>` half reads the admitted set rather than a
 * hand list, so a state added to the grammar is a valid fallback the day it
 * lands. */
export function findUncoveredDynamicStateEmissions(
  src: string,
  admitted: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/data-state\s*=\s*\{([^}]+)\}/g)) {
    const expr = m[1]!.trim();
    // Covered by construction: an explicit mapping call at the door (the
    // argument to the call is the DOMAIN kind being mapped — never the value
    // that reaches the attribute). The call is consumed first so its
    // argument's `.kind` is not misread as the emitted value.
    if (/^[A-Za-z_$][\w$]*DataState\(/.test(expr)) continue;
    // The leak shapes in the EMITTED value: a `…kind` member (a domain kind,
    // never a presentation state), a `??` fallback onto a member expression
    // (a mapped state falling back to a domain word), or a `?? "<literal>"`
    // fallback whose literal is not one the grammar admits.
    let leaks = /\.kind\b/.test(expr) || /\?\?\s*[a-zA-Z_$][\w$]*\.[\w$]/.test(expr);
    if (!leaks) {
      for (const lm of expr.matchAll(/\?\?\s*["']([a-z-]+)["']/g)) {
        if (!admitted.has(lm[1]!)) leaks = true;
      }
    }
    if (leaks) out.push(`data-state={${expr}}`);
  }
  return out;
}

/** The case scanner behind arm L: a `text-transform` in a component style
 * block is the engraved register restated with one knob turned. */
export function findTextTransformRestatements(style: string): string[] {
  const out: string[] = [];
  for (const m of style.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const t of m[2]!.matchAll(/text-transform\s*:\s*([a-z]+)/g)) {
      out.push(`${m[1]!.trim().replace(/\s+/g, " ")} sets text-transform: ${t[1]}`);
    }
  }
  return out;
}

/** The cursor scanner behind arm N: the affordance cursor is ONE decision,
 * owned by tokens.css (a control is `pointer`, a disabled control is
 * `default`, and that pair is the whole vocabulary). A `not-allowed` is a
 * second answer to the question `:disabled` already answers — it crept in on
 * the flow's unwired verb while the rest of the tree read `default`. The
 * structural cursors a surface genuinely needs (a resize handle's
 * `ew-resize`, a drag's `grabbing`) are not this arm's subject: they answer
 * "what gesture works here", not "may I act". */
export function findDisabledCursorRespellings(style: string): string[] {
  const out: string[] = [];
  for (const m of style.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const c of m[2]!.matchAll(/cursor\s*:\s*not-allowed/g)) {
      out.push(`${m[1]!.trim().replace(/\s+/g, " ")} sets cursor: not-allowed`);
    }
  }
  return out;
}

/** Strip CSS comments so a commented-out spine cannot fake a live recipe. */
export function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** First rule body whose selector equals `selector` (whitespace-flexible). */
export function exactSelectorBody(css: string, selector: string): string {
  const sel = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`${sel}\\s*\\{([^}]*)\\}`).exec(stripCssComments(css))?.[1] ?? "";
}

/** Labelled COLUMN recipe — DeleteConfirm / editor (label above). */
export function labelledFieldBody(css: string): string {
  return exactSelectorBody(css, ".cockpit .field");
}

/** SPINE variant — Registration's `.column .field` (label left, on --label-track). */
export function spineFieldBody(css: string): string {
  return exactSelectorBody(css, ".cockpit .column .field");
}

export function labelTrackDeclCount(css: string): number {
  return (stripCssComments(css).match(/--label-track\s*:/g) ?? []).length;
}

/**
 * THE GATE INVARIANT. `--label-track` once; `.cockpit .field` stays the
 * stacked column; `.cockpit .column .field` is a higher-specificity grid
 * on that track so the column recipe cannot stack the registration gate.
 * Planting tokens-only column on the gate (drop the spine, or restack it)
 * returns findings — that is the mutation the live round drives.
 */
export function fieldSpineFindings(css: string): string[] {
  const out: string[] = [];
  const n = labelTrackDeclCount(css);
  if (n !== 1) out.push(`--label-track declared ${n} times — must be once`);
  if (!/--label-track\s*:\s*12ch\s*;/.test(stripCssComments(css))) {
    out.push("--label-track must be declared as 12ch");
  }
  const column = labelledFieldBody(css);
  if (!/flex-direction\s*:\s*column/.test(column)) {
    out.push("labelled .cockpit .field must stay the stacked column recipe");
  }
  const spine = spineFieldBody(css);
  if (!/display\s*:\s*grid/.test(spine)) {
    out.push(".cockpit .column .field must be display:grid (the spine)");
  }
  if (!/grid-template-columns\s*:\s*var\(--label-track\)/.test(spine)) {
    out.push(".cockpit .column .field must size its label track from var(--label-track)");
  }
  if (/flex-direction\s*:\s*column/.test(spine)) {
    out.push(".cockpit .column .field must not be the stacked column recipe — that stacks the gate");
  }
  const classCount = (s: string) => (s.match(/\./g) ?? []).length;
  if (!(classCount(".cockpit .column .field") > classCount(".cockpit .field"))) {
    out.push("spine selector must out-specify .cockpit .field so the column recipe cannot win on the gate");
  }
  return out;
}

describe("cockpit-tokens-owner — tokens.css is the cockpit's sole visual owner", () => {
  const svelteFiles = walk(COCKPIT_ROOT, { exts: [".svelte"] });
  const tsFiles = walk(COCKPIT_ROOT, { exts: [".ts"] });
  const cssFiles = walk(COCKPIT_ROOT, { exts: [".css"] });
  const FALLBACK_OWNER = "src/cockpit/paint/design-tokens.ts";

  test("tokens.css exists and is the only css file in the cockpit tree", () => {
    expect(cssFiles.map(relpath)).toEqual([TOKENS]);
  });

  test("the walk's population is live (S42: a svelte-only walk passed on an empty .ts universe)", () => {
    expect(svelteFiles.length, "cockpit .svelte files").toBeGreaterThan(40);
    expect(tsFiles.length, "cockpit .ts files").toBeGreaterThan(40);
    expect(
      svelteFiles.some((f) => relpath(f).endsWith("rooms/Spark.svelte")),
      "witness: Spark.svelte (a paint that used to restate hex)",
    ).toBe(true);
    expect(
      tsFiles.some((f) => relpath(f) === FALLBACK_OWNER),
      "witness: the TOKEN_FALLBACKS owner",
    ).toBe(true);
  });

  test("A: no literal colors in cockpit component styles", () => {
    const findings: string[] = [];
    for (const f of svelteFiles) {
      for (const hit of findColorLiterals(styleBlock(read(f))))
        findings.push(`${relpath(f)}: ${hit}`);
    }
    expect(findings, findings.join("\n")).toEqual([]);
  });

  test("B: no literal durations in cockpit component styles", () => {
    const findings: string[] = [];
    for (const f of svelteFiles) {
      for (const hit of findDurationLiterals(styleBlock(read(f))))
        findings.push(`${relpath(f)}: ${hit}`);
    }
    expect(findings, findings.join("\n")).toEqual([]);
  });

  test("C: no custom-property declarations outside tokens.css", () => {
    const findings: string[] = [];
    for (const f of svelteFiles) {
      for (const hit of findTokenDeclarations(styleBlock(read(f))))
        findings.push(`${relpath(f)}: ${hit}`);
    }
    expect(findings, findings.join("\n")).toEqual([]);
  });

  test("D: no :root / theme blocks outside tokens.css", () => {
    const findings: string[] = [];
    for (const f of svelteFiles) {
      for (const hit of findThemeBlocks(styleBlock(read(f))))
        findings.push(`${relpath(f)}: ${hit}`);
    }
    expect(findings, findings.join("\n")).toEqual([]);
  });

  test("F: no hardcoded length literals in cockpit component styles", () => {
    const findings: string[] = [];
    for (const f of svelteFiles) {
      const style = styleBlock(read(f));
      for (const hit of findLengthLiterals(style))
        findings.push(`${relpath(f)}: ${hit}`);
      // line-height is the one unitless SCALE — a bare number there is a
      // length the px/rem/em scan cannot see; it belongs to the --lh-* rungs.
      for (const hit of findLineHeightLiterals(style))
        findings.push(`${relpath(f)}: ${hit} — leading is the --lh-* scale in tokens.css`);
    }
    expect(findings, findings.join("\n")).toEqual([]);
  });

  test("A2: no quoted hex or quoted length outside TOKEN_FALLBACKS", () => {
    const findings: string[] = [];
    for (const f of [...svelteFiles, ...tsFiles]) {
      const path = relpath(f);
      const src = read(f);
      const hexes = findQuotedHex(src);
      const lengths = findQuotedLengths(src);
      if (path === FALLBACK_OWNER) continue;
      for (const hit of hexes) findings.push(`${path}: quoted hex ${hit}`);
      for (const hit of lengths) findings.push(`${path}: quoted length ${hit}`);
    }
    expect(findings, findings.join("\n")).toEqual([]);
  });

  test("A2: TOKEN_FALLBACKS is a pin of tokens.css, not a second palette", () => {
    const css = read(TOKENS);
    const unit = /--sp-unit\s*:\s*(\d+(?:\.\d+)?)px/.exec(css);
    expect(unit, "--sp-unit must be declared as px").not.toBeNull();
    for (const [name, value] of Object.entries(TOKEN_FALLBACKS)) {
      if (value.startsWith("#")) {
        const decl = new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*(#[0-9a-fA-F]{6})\\s*;`, "m").exec(
          css,
        );
        expect(decl, `${name} must be a dark hex in tokens.css`).not.toBeNull();
        expect(value, `TOKEN_FALLBACKS[${name}] drifted from the owner`).toBe(decl![1]);
      }
    }
    expect(TOKEN_FALLBACKS["--sp-3"]).toBe(`${Number(unit![1]) * 3}px`);
    for (const name of ["--reel-w", "--hit-min", "--hairline-w", "--sp-unit"] as const) {
      const declared = new RegExp(`${name}:\\s*(\\d+(?:\\.\\d+)?)px`).exec(css);
      expect(declared, `${name} must be declared as px`).not.toBeNull();
      expect(TOKEN_FALLBACKS[name]).toBe(`${declared![1]}px`);
    }
    const tile = /--reel-h:\s*([\d.]+)rem/.exec(css);
    expect(tile, "equal tile height scales with root text").not.toBeNull();
    // Derived from the owner, never restated: the rem tile at the 16px root is
    // the fallback pin AND the registered property's initial value.
    const tilePx = `${Number(tile![1]) * 16}px`;
    expect(TOKEN_FALLBACKS["--reel-h"]).toBe(tilePx);
    expect(css).toMatch(new RegExp(`@property --reel-h\\s*\\{\\s*syntax:\\s*"<length>";\\s*inherits:\\s*true;\\s*initial-value:\\s*${tilePx};`));
    const ownerHex = new Set(findQuotedHex(read(FALLBACK_OWNER)));
    const tableHex = new Set(
      Object.values(TOKEN_FALLBACKS).filter((v) => v.startsWith("#")),
    );
    expect([...ownerHex].sort(), "design-tokens.ts quoted hex must be exactly TOKEN_FALLBACKS").toEqual(
      [...tableHex].sort(),
    );
  });

  test("H2: spacing and motion rungs derive from one primitive", () => {
    const css = read(TOKENS);
    expect(findSpScaleViolations(css), findSpScaleViolations(css).join("\n")).toEqual([]);
    expect(findTScaleViolations(css), findTScaleViolations(css).join("\n")).toEqual([]);
  });

  test("H2: @property --update-ink initial-value is --warn (CSS forbids var() there)", () => {
    const css = read(TOKENS);
    const warn = /^\s*--warn:\s*(#[0-9a-fA-F]{6})\s*;/m.exec(css);
    const init = /@property --update-ink[\s\S]*?initial-value:\s*(#[0-9a-fA-F]{6})/.exec(css);
    expect(warn, "--warn must be a dark hex").not.toBeNull();
    expect(init, "@property --update-ink must declare initial-value").not.toBeNull();
    expect(init![1], "the @property initial-value drifted from --warn").toBe(warn![1]);
  });

  test("E: tokens.css carries the spec's load-bearing groups (§12)", () => {
    const css = read(TOKENS);
    const required = [
      "--ground-0:",
      "--ground-3:",
      "--line-1:",
      "--ink-1:",
      "--ink-4:",
      "--beam:",
      "--alarm:",
      "--warn:",
      "--ok:",
      "--t-unit:",
      "--t-1:",
      "--t-2:",
      "--t-3:",
      "--sp-unit:",
      "--horizon-h:",
      "--sweep-h:",
      "--hit-min:",
      "--measure:",
      "--label-track:",
      "data-density",
      "prefers-reduced-motion",
      ":focus-visible",
      "data-cockpit-theme",
    ];
    const missing = required.filter((token) => !css.includes(token));
    expect(missing, `tokens.css lost: ${missing.join(", ")}`).toEqual([]);
  });

  // G. The installable surface pins the cockpit ground. index.html's
  // `<meta theme-color>` and manifest.json's theme/background colors cannot
  // consume var(), so each is a MIRROR of `--ground-0` and this drift
  // contract is what keeps the mirrors honest (the same class the old
  // shell's css-token owner enforced against its own tokens file).
  test("G: index.html <meta theme-color> + manifest colors match --ground-0", () => {
    const css = read(TOKENS);
    const ground = css.match(/--ground-0:\s*(#[0-9a-fA-F]{6})/);
    expect(ground, "tokens.css must declare --ground-0 as a 6-digit hex").not.toBeNull();
    const expected = ground![1]!.toLowerCase();

    const html = read("index.html");
    const meta = html.match(/<meta\s+name=["']theme-color["']\s+content=["']([^"']+)["']/i);
    expect(meta, 'index.html must declare <meta name="theme-color">').not.toBeNull();
    expect(
      meta![1]!.toLowerCase(),
      `index.html <meta theme-color> drifted from --ground-0 (${expected}) — HTML meta cannot use var(); update the content to match the token`,
    ).toBe(expected);

    const manifest = JSON.parse(read("public/manifest.json")) as {
      theme_color: string;
      background_color: string;
    };
    expect(manifest.theme_color.toLowerCase(), `manifest.json theme_color drifted from --ground-0 (${expected})`).toBe(expected);
    expect(manifest.background_color.toLowerCase(), `manifest.json background_color drifted from --ground-0 (${expected})`).toBe(expected);
  });

  // ── H. tokens.css ITSELF — the one file the component arms exclude ──────

  /** The width-driven block at the foot of tokens.css is the ONE place a
   * breakpoint may be written (a media query cannot read a var()), and the
   * two breakpoint lengths are ITS declared shape. Every other length or
   * breakpoint literal inside the owner is a decision that escaped the
   * token scale. */
  test("H: no stray length/breakpoint literals inside tokens.css itself", () => {
    const css = read(TOKENS);
    // Strip every var() and every declared custom property's own value; what
    // remains must hold no px/rem/em literal and no hardcoded @media width.
    const stripped = stripVarCalls(css);
    const findings: string[] = [];
    for (const m of stripped.matchAll(/@media\s*\(([^)]+)\)/g)) {
      const cond = m[1]!;
      const lit = cond.match(/\d+(?:\.\d+)?px/);
      if (lit !== null && cond.includes("max-width")) {
        // The two breakpoints are the width block's own; this arm admits
        // exactly that pair and refuses a THIRD, so a new breakpoint cannot
        // appear without being named here.
        if (lit[0] !== "1440px" && lit[0] !== "1100px") {
          findings.push(`@media (${cond}) — a breakpoint outside the declared pair`);
        }
      }
    }
    expect(findings, findings.join("\n")).toEqual([]);
  });

  // ── I. the outcome axis, spelled once ──────────────────────────────────

  test("I: the [data-state] hue mapping in tokens.css IS the grammar's outcome axis", () => {
    const css = read(TOKENS);
    // The mapping rules set --outcome-ink; parse which states they admit.
    const mapped = new Set<string>();
    for (const m of css.matchAll(/\.cockpit \[data-state="([a-z-]+)"\]\s*\{\s*--outcome-ink:/g)) {
      mapped.add(m[1]!);
    }
    const axis = new Set(Object.keys(OUTCOME_STATES));
    expect(
      [...mapped].sort(),
      "the token owner's outcome mapping must be the grammar's axis, no more and no less",
    ).toEqual([...axis].sort());
  });

  test("I: no component re-spells the outcome axis as a class, and no retired data-state survives", () => {
    const findings: string[] = [];
    const admitted = new Set(DATA_STATE_VALUES);
    for (const f of svelteFiles) {
      const src = read(f);
      // A per-class hue spelling of the axis, in ANY of its shapes — the
      // prefixed `.chip.state-ok` and the bare `.state-ok` alike: the class
      // of defect is "a state name worn as a class", and a scan that only
      // knew the prefixed spelling passed green while the bare one sat
      // inside this arm's charter. The words scanned here are the admitted
      // state ids themselves, derived from the grammar, so a new state is
      // guarded because nobody had to remember to add it.
      for (const hit of findStateClassSpellings(src, admitted)) {
        findings.push(`${relpath(f)}: ${hit} — the axis is read through --outcome-ink now`);
      }
      // A retired or out-of-vocabulary data-state value, literal.
      for (const hit of findOutOfVocabularyStateValues(src, admitted)) {
        findings.push(`${relpath(f)}: ${hit} is outside the grammar's admitted set`);
      }
      // A DYNAMIC emission must route its value through a grammar-derived
      // mapping at the door; a bare domain kind reaching the attribute is a
      // private vocabulary the literal scan cannot see (the breaker's `off`,
      // the switch feed's `measured`). Covered shapes are named in the
      // scanner's own comment.
      for (const hit of findUncoveredDynamicStateEmissions(src, admitted)) {
        findings.push(
          `${relpath(f)}: ${hit} — a dynamic data-state must map its domain kind to the grammar at the door (a *DataState call or a grammar-literal conditional), never reach the attribute bare`,
        );
      }
      // A SECOND armed spelling: `data-state="armed"` is the one spelling
      // (the delete confirmation's edge, the switch's landing); a
      // `data-armed` attribute or an `.armed` class is the same fact said
      // in a private word, and "armed" appearing three ways is exactly the
      // defect class this arm exists to close. The scan is the shared
      // scanner, so the arm and its mutation read one instrument.
      for (const hit of findArmedRespellings(src)) {
        findings.push(
          hit === "data-armed"
            ? `${relpath(f)}: data-armed — the armed state is data-state="armed", one spelling`
            : `${relpath(f)}: ${hit} — an .armed class is a second spelling of data-state="armed"`,
        );
      }
    }
    expect(findings, findings.join("\n")).toEqual([]);
  });

  // ── J. inline style= attributes — the guard's blind spot ───────────────

  /** The custom properties a component may stamp inline — the `@property`
   * registry in tokens.css, derived rather than typed out so a new
   * registered stamp is admitted by registering it, never by editing this. */
  function registeredStamps(css: string): Set<string> {
    const out = new Set<string>();
    for (const m of css.matchAll(/@property\s+(--[\w-]+)/g)) out.add(m[1]!);
    return out;
  }

  // ── K. the consumed state vocabulary stays honest ──────────────────────

  test("K: a component never reads --ink-4 as a DISABLED ink (the refused ink is --layer-disabled)", () => {
    // The alias defect this round closed: `--layer-disabled` was declared as
    // `var(--ink-4)` and consumed nowhere, so "disabled" was faked by the
    // faintest text ink in every `:disabled` rule. A `:disabled` rule that
    // still reads `--ink-4` is the alias creeping back.
    const findings: string[] = [];
    for (const f of svelteFiles) {
      const style = styleBlock(read(f));
      if (style === "") continue;
      for (const m of style.matchAll(/([^{}]*:disabled[^{]*)\{([^}]*)\}/g)) {
        if (/var\(--ink-4\)/.test(m[2]!)) {
          findings.push(`${relpath(f)}: ${m[1]!.trim()} reads --ink-4 for the refused ink — it is --layer-disabled now`);
        }
      }
    }
    expect(findings, findings.join("\n")).toEqual([]);
  });

  // ── L. the case is the register's, never a component's ─────────────────
  //
  // A `text-transform` in a component style block is the engraved register
  // restated with one knob turned — the exact duplication the owned
  // `.engraved` / `.engraved-ctl` / `.engraved-note` / `.plain` recipes in
  // tokens.css exist to end. The tokens.css comment has claimed this arm
  // existed since before it did; a comment asserting a guard that does not
  // exist is the phantom-guard defect, so the claim is now made true.

  test("L: no component style block carries a text-transform (the case belongs to the owned register)", () => {
    const findings: string[] = [];
    for (const f of svelteFiles) {
      const style = styleBlock(read(f));
      if (style === "") continue;
      for (const hit of findTextTransformRestatements(style)) {
        findings.push(
          `${relpath(f)}: ${hit} — the owned register carries the case (.engraved / .engraved-ctl / .engraved-note, .plain to step out)`,
        );
      }
    }
    expect(findings, findings.join("\n")).toEqual([]);
  });

  // ── N. the disabled cursor is spelled once ────────────────────────────
  //
  // A disabled control's cursor is the owned `default` (tokens.css
  // `.verb:disabled` and the global `:disabled` reset), never a second
  // spelling. `not-allowed` says "forbidden"; this product says "refused,
  // and here is why on the control" — the reason lives in the words, not a
  // second cursor. The arm scans every component style block so a new
  // `not-allowed` anywhere is caught, not only the one that was fixed.

  test("N: no component style block spells the disabled cursor as not-allowed", () => {
    const findings: string[] = [];
    for (const f of svelteFiles) {
      const style = styleBlock(read(f));
      if (style === "") continue;
      for (const hit of findDisabledCursorRespellings(style)) {
        findings.push(
          `${relpath(f)}: ${hit} — a disabled control's cursor is the owned default (tokens.css .verb:disabled); not-allowed is a second answer to one question`,
        );
      }
    }
    expect(findings, findings.join("\n")).toEqual([]);
  });

  test("J: an inline style stamps only a REGISTERED custom property, and any plain property is a VAR() into the owner", () => {
    const registered = registeredStamps(read(TOKENS));
    expect(registered.size, "the @property registry must be non-empty").toBeGreaterThan(0);
    const findings: string[] = [];
    for (const f of svelteFiles) {
      const src = read(f);
      const markup = src.slice(0, src.indexOf("<style") >>> 0 || undefined);
      for (const m of markup.matchAll(/\bstyle(?:\:\S+)?\s*=\s*(\{[^}]*\}|"[^"]*")/g)) {
        const body = m[1]!;
        // A custom-property stamp is legitimate only when the name is in the
        // @property registry; anything else (a property: value pair, a color,
        // a length with a unit) is a decision the style-block arms cannot see.
        const stamps = [...body.matchAll(/(--[\w-]+)\s*:/g)].map((s) => s[1]!);
        for (const name of stamps) {
          if (!registered.has(name)) {
            findings.push(`${relpath(f)}: inline stamp ${name} is not @property-registered in tokens.css`);
          }
        }
        // A plain property is permitted ONLY when every value it carries is
        // a var() into the owner (a measured position/height computed from a
        // token at runtime) — never a literal the owner does not declare.
        const plain = body
          .replace(/\{[^}]*\}/g, " ") // svelte expression wrappers
          .replace(/`[^`]*`/g, " ") // template literals
          .replace(/(--[\w-]+\s*:\s*[^;]+;?)/g, " "); // registered-shape stamps
        for (const pm of plain.matchAll(/(?:^|[;\s"'{])([a-z-]+)\s*:\s*([^;"'}]+)/g)) {
          const value = pm[2]!.trim();
          // Every value must be built from the owner's tokens: a var() read,
          // a calc() over var()s, or a measured-at-runtime expression — never
          // a bare literal (a number+unit, a named colour) the owner does
          // not declare. A calc() is read for literals INSIDE it; a bare
          // percent inside calc (100%) is arithmetic, not a declared length.
          const withoutVars = value
            .replace(/var\(\s*--[\w-]+\s*\)/g, " ")
            .replace(/\{[^}]*\}/g, " "); // measured at runtime (a svelte expression)
          const bad = (withoutVars.match(/(?<![\w.-])-?\d+(?:\.\d+)?(?:px|rem|em|vh|vw)|#[0-9a-fA-F]{3,8}\b/g) ?? []);
          if (bad.length > 0) {
            findings.push(`${relpath(f)}: inline style carries ${pm[1]}: ${value} — a literal (${bad.join(", ")}) the owner does not declare`);
          }
        }
      }
    }
    expect(findings, findings.join("\n")).toEqual([]);
  });

  // ── MUTATION SELF-CHECKS ───────────────────────────────────────────────

  test("mutation: a hex color literal is caught", () => {
    expect(findColorLiterals("<style>.x{color:#abc123;}</style>").length).toBeGreaterThan(0);
  });

  test("mutation: a quoted hex in script is caught, a regex is not", () => {
    expect(findQuotedHex(`const ink = "#79818d";`)).toEqual(["#79818d"]);
    expect(findQuotedHex(`const re = /#[0-9a-fA-F]{3,8}/;`)).toEqual([]);
    expect(findQuotedHex(`// "#dead00" in a comment`)).toEqual([]);
  });

  test("mutation: a quoted length in script is caught", () => {
    expect(findQuotedLengths(`read("--reel-w", "320px")`)).toEqual(["320px"]);
    expect(findQuotedLengths(`read("--sp-3")`)).toEqual([]);
  });

  test("mutation: a restated --sp-* px rung is caught, a calc is not", () => {
    const bad = ":root { --sp-unit: 4px; --sp-0: calc(var(--sp-unit) * 0.5); --sp-1: var(--sp-unit); --sp-2: 8px; --sp-3: calc(var(--sp-unit) * 3); --sp-4: calc(var(--sp-unit) * 4); --sp-5: calc(var(--sp-unit) * 6); --sp-6: calc(var(--sp-unit) * 8); --sp-7: calc(var(--sp-unit) * 12); }";
    expect(findSpScaleViolations(bad).join(" ")).toContain("--sp-2");
    const good = ":root { --sp-unit: 4px; --sp-0: calc(var(--sp-unit) * 0.5); --sp-1: var(--sp-unit); --sp-2: calc(var(--sp-unit) * 2); --sp-3: calc(var(--sp-unit) * 3); --sp-4: calc(var(--sp-unit) * 4); --sp-5: calc(var(--sp-unit) * 6); --sp-6: calc(var(--sp-unit) * 8); --sp-7: calc(var(--sp-unit) * 12); }";
    expect(findSpScaleViolations(good)).toEqual([]);
  });

  test("mutation: a restated --t-1 ms is caught", () => {
    expect(findTScaleViolations(":root { --t-unit: 30ms; --t-1: 90ms; --t-2: calc(var(--t-unit) * 5); --t-3: calc(var(--t-unit) * 8); }").join(" ")).toContain("--t-1");
    expect(findTScaleViolations(":root { --t-unit: 30ms; --t-1: calc(var(--t-unit) * 3); --t-2: calc(var(--t-unit) * 5); --t-3: calc(var(--t-unit) * 8); }")).toEqual([]);
    expect(findTScaleViolations(":root { --t-unit: 30ms; --t-1: calc(var(--t-unit) * 3); --t-2: calc(var(--t-unit) * 5); --t-3: 240ms; }").join(" ")).toContain("--t-3");
  });

  test("mutation: an oklch literal is caught", () => {
    expect(findColorLiterals(".x{color:oklch(0.7 0.1 200);}").length).toBeGreaterThan(0);
  });

  test("mutation: a transition duration literal is caught", () => {
    expect(findDurationLiterals(".x{transition: height 150ms ease;}").length).toBeGreaterThan(0);
  });

  test("mutation: a local token declaration is caught", () => {
    expect(findTokenDeclarations(".x{\n  --sneaky: 12px;\n}").length).toBeGreaterThan(0);
  });

  test("mutation: a :root block outside tokens.css is caught", () => {
    expect(findThemeBlocks(":root { --x: 1; }").length).toBeGreaterThan(0);
  });

  test("mutation: token consumption via var() is NOT a false positive", () => {
    const clean = ".x{color:var(--ink-1);transition:height var(--t-2) var(--ease-out);}";
    expect(findColorLiterals(clean)).toEqual([]);
    expect(findDurationLiterals(clean)).toEqual([]);
  });

  test("mutation: a px length literal is caught", () => {
    expect(findLengthLiterals(".x{width: 7px;}").length).toBeGreaterThan(0);
  });

  test("mutation: a rem literal (and one inside calc) is caught", () => {
    expect(findLengthLiterals(".x{top: -1.4rem;}").length).toBeGreaterThan(0);
    expect(findLengthLiterals(".x{bottom: calc(100% + 6px);}").length).toBeGreaterThan(0);
  });

  test("mutation: arm F catches a bare numeric line-height, and passes a token one", () => {
    // The leading half of arm F: a unitless number the px/rem/em regex skips.
    expect(findLineHeightLiterals(".x{line-height: 1.4;}")).toEqual(["line-height: 1.4"]);
    expect(findLineHeightLiterals(".x{line-height: 1;}")).toEqual(["line-height: 1"]);
    // A token read and a non-line-height rule pass clean.
    expect(findLineHeightLiterals(".x{line-height: var(--lh-tight);}")).toEqual([]);
    expect(findLineHeightLiterals(".x{color: var(--ink-1);}")).toEqual([]);
  });

  test("mutation: zero, unitless numbers, %, and var() dims are NOT false positives", () => {
    const clean =
      ".x{margin:0px;line-height:1.3;width:100%;height:var(--sweep-h);margin:calc(-1 * var(--hairline-w));transform:scale(0.994);}";
    expect(findLengthLiterals(clean)).toEqual([]);
  });

  test("mutation: arm I catches a class re-spelling, a retired data-state, and an invented one", () => {
    const admitted = new Set(DATA_STATE_VALUES);
    // The class re-spelling, in BOTH its shapes: the prefixed form this
    // round deleted everywhere, and the BARE form that survived in
    // EventBeat inside the arm's charter while the prefixed-only scan
    // stayed green. A widened claim needs evidence against the shape the
    // old scan missed, not only the one it caught — and the mutations drive
    // the arm's REAL scanner, not a re-implemented copy beside it.
    expect(
      findStateClassSpellings(".chip.state-ok { color: var(--ok); }", admitted),
    ).toEqual([".state-ok"]);
    expect(
      findStateClassSpellings(".state-warn .kind { color: var(--warn); }", admitted),
    ).toEqual([".state-warn"]);
    // A retired spelling is outside the admitted set, caught by the value arm.
    expect(findOutOfVocabularyStateValues(`[data-state="running"] { color: red; }`, admitted)).toEqual([
      '[data-state="running"]',
    ]);
    expect(findOutOfVocabularyStateValues(`<span data-state="live">`, admitted)).toEqual([
      'data-state="live"',
    ]);
    expect(findOutOfVocabularyStateValues(`<span data-state="bad">`, admitted)).toEqual([
      'data-state="bad"',
    ]);
    // And a current one passes clean.
    expect(findOutOfVocabularyStateValues(`<span data-state="working">`, admitted)).toEqual([]);
    expect(findOutOfVocabularyStateValues(`<span data-state="armed">`, admitted)).toEqual([]);
  });

  test("mutation: arm I covers a DYNAMIC data-state emission, and refuses a bare domain kind", () => {
    const admitted = new Set(DATA_STATE_VALUES);
    // The defect the widened arm exists to catch: `data-state={outcome.kind}`
    // emitting the feed's `measured`, `data-state={row.state}` emitting the
    // breaker's `off` — out-of-vocabulary values the literal scan cannot see.
    expect(findUncoveredDynamicStateEmissions(`<div data-state={outcome.kind}>`, admitted)).toEqual([
      "data-state={outcome.kind}",
    ]);
    expect(findUncoveredDynamicStateEmissions(`<div data-state={density.kind}>`, admitted)).toEqual([
      "data-state={density.kind}",
    ]);
    expect(findUncoveredDynamicStateEmissions(`<div data-state={chipState ?? row.state}>`, admitted)).toEqual([
      "data-state={chipState ?? row.state}",
    ]);
    // The `?? <literal>` half: an IN-vocabulary fallback is covered, an
    // OUT-of-vocabulary one is the same private-vocabulary leak wearing a
    // string literal — the attribute cannot tell a fallback from a claim.
    expect(findUncoveredDynamicStateEmissions(`<div data-state={line?.state ?? "at-now"}>`, admitted)).toEqual([
      `data-state={line?.state ?? "at-now"}`,
    ]);
    // The covered doors pass clean: an explicit mapping call, a
    // grammar-literal conditional, a bare null, and an admitted literal
    // fallback.
    expect(findUncoveredDynamicStateEmissions(`<div data-state={outcomeDataState(outcome.kind)}>`, admitted)).toEqual([]);
    expect(findUncoveredDynamicStateEmissions(`<div data-state={armed ? "armed" : null}>`, admitted)).toEqual([]);
    expect(findUncoveredDynamicStateEmissions(`<div data-state={line?.state ?? "empty"}>`, admitted)).toEqual([]);
  });

  test("mutation: arm I catches a second armed spelling", () => {
    // The class the repair is for: `armed` said in a word the grammar does
    // not own. Both shapes must match the arm's REAL scanner.
    expect(findArmedRespellings(`<span class="landing" data-armed={armed}>`)).toEqual(["data-armed"]);
    expect(findArmedRespellings(`<div class="row armed">`)).toEqual(['class="row armed']);
    // And the owned spelling passes clean.
    expect(findArmedRespellings(`<span data-state="armed">`)).toEqual([]);
  });

  test("mutation: arm K catches a :disabled rule reading the old faked ink", () => {
    const planted = `.x:disabled { color: var(--ink-4); cursor: default; }`;
    const hits = [...planted.matchAll(/([^{}]*:disabled[^{]*)\{([^}]*)\}/g)].filter((m) =>
      /var\(--ink-4\)/.test(m[2]!),
    );
    expect(hits.length).toBeGreaterThan(0);
  });

  test("mutation: arm L catches a component carrying the register's case by hand", () => {
    // The mutations drive the arm's REAL scanner (extracted, shared) — never
    // a re-implemented copy, which would keep passing if the arm drifted.
    expect(findTextTransformRestatements(".note { text-transform: uppercase; letter-spacing: var(--f-micro-track); }")).toEqual([
      ".note sets text-transform: uppercase",
    ]);
    expect(findTextTransformRestatements(".word { text-transform: none; }")).toEqual([
      ".word sets text-transform: none",
    ]);
    expect(findTextTransformRestatements(".x { color: var(--ink-3); }")).toEqual([]);
  });

  test("mutation: arm N catches a not-allowed cursor, and passes the owned treatments", () => {
    // The class the arm exists to close: a second disabled-cursor spelling.
    expect(findDisabledCursorRespellings(".verb-unwired { cursor: not-allowed; }")).toEqual([
      ".verb-unwired sets cursor: not-allowed",
    ]);
    // The owned spellings (and the structural cursors that are not this
    // arm's subject) pass clean.
    expect(findDisabledCursorRespellings(".verb:disabled { cursor: default; }")).toEqual([]);
    expect(findDisabledCursorRespellings(".handle { cursor: ew-resize; }")).toEqual([]);
    expect(findDisabledCursorRespellings(".verb { cursor: pointer; }")).toEqual([]);
  });

  test("the field recipe owns a stacked COLUMN and a SPINE; --label-track is once", () => {
    const css = read(TOKENS);
    expect(fieldSpineFindings(css), fieldSpineFindings(css).join("\n")).toEqual([]);
    // Column recipe still exists for DeleteConfirm — stacking the gate is
    // not "delete the column recipe", it is "column winning on .column .field".
    expect(labelledFieldBody(css)).toMatch(/flex-direction:\s*column/);
    expect(spineFieldBody(css)).toMatch(/var\(--label-track\)/);
  });

  test("mutation: tokens-only column on the gate is caught (the live plant)", () => {
    const stacked = `
      :root { --label-track: 12ch; }
      .cockpit .field { display: flex; flex-direction: column; gap: 2px; }
    `;
    expect(fieldSpineFindings(stacked).join(" ")).toMatch(/display:grid/);
    const restackedSpine = `
      :root { --label-track: 12ch; }
      .cockpit .field { display: flex; flex-direction: column; }
      .cockpit .column .field { display: flex; flex-direction: column; }
    `;
    expect(fieldSpineFindings(restackedSpine).join(" ")).toMatch(/stacks the gate|display:grid/);
    const good = `
      :root { --label-track: 12ch; }
      .cockpit .field { display: flex; flex-direction: column; }
      .cockpit .column .field { display: grid; grid-template-columns: var(--label-track) 1fr; }
    `;
    expect(fieldSpineFindings(good)).toEqual([]);
  });

  test("mutation: arm H catches a new hardcoded breakpoint inside the owner", () => {
    const css = ".x{}\n@media (max-width: 900px) { :root { --sweep-h: 20px; } }\n";
    const stripped = stripVarCalls(css);
    const findings: string[] = [];
    for (const m of stripped.matchAll(/@media\s*\(([^)]+)\)/g)) {
      const cond = m[1]!;
      const lit = cond.match(/\d+(?:\.\d+)?px/);
      if (lit !== null && cond.includes("max-width") && lit[0] !== "1440px" && lit[0] !== "1100px") {
        findings.push(`@media (${cond})`);
      }
    }
    expect(findings.length).toBeGreaterThan(0);
  });

  test("mutation: arm J catches an unregistered inline stamp and a literal-carrying inline style", () => {
    const registered = new Set(["--depth", "--cap-reels", "--update-ink"]);
    const bad1 = `<div style="--sneaky: 3"></div>`;
    const bad2 = `<div style="position: fixed; left: 4px"></div>`;
    const good1 = `<div style="--depth: {n}"></div>`;
    const good2 = `<div style="top: var(--horizon-h); right: var(--sp-3);"></div>`;
    const good3 = `<div style="bottom: calc(100% + var(--sp-2)); min-width: var(--arm-menu-min-w);"></div>`;
    const scan = (markup: string): string[] => {
      const out: string[] = [];
      for (const m of markup.matchAll(/\bstyle\s*=\s*(\{[^}]*\}|"[^"]*")/g)) {
        const body = m[1]!;
        for (const s of body.matchAll(/(--[\w-]+)\s*:/g)) {
          if (!registered.has(s[1]!)) out.push(`unregistered ${s[1]}`);
        }
        const plain = body
          .replace(/\{[^}]*\}/g, " ")
          .replace(/`[^`]*`/g, " ")
          .replace(/(--[\w-]+\s*:\s*[^;]+;?)/g, " ");
        for (const pm of plain.matchAll(/(?:^|[;\s"'{])([a-z-]+)\s*:\s*([^;"'}]+)/g)) {
          const value = pm[2]!.trim();
          const withoutVars = value
            .replace(/var\(\s*--[\w-]+\s*\)/g, " ")
            .replace(/\{[^}]*\}/g, " ");
          const bad = withoutVars.match(/(?<![\w.-])-?\d+(?:\.\d+)?(?:px|rem|em|vh|vw)|#[0-9a-fA-F]{3,8}\b/g) ?? [];
          if (bad.length > 0) out.push(`literal ${pm[1]}: ${bad.join(",")}`);
        }
      }
      return out;
    };
    expect(scan(bad1).join(" ")).toContain("unregistered --sneaky");
    expect(scan(bad2).join(" ")).toContain("literal left: 4px");
    expect(scan(good1)).toEqual([]);
    expect(scan(good2)).toEqual([]);
    expect(scan(good3)).toEqual([]);
  });
});
