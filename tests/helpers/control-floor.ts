/** Shared pointer-floor source analysis. No test registration on import. */
import { read } from "./source-scan.ts";

/** The one token that owns the pointer target floor (tokens.css §12.5). */
export const HIT_TOKEN = "var(--hit-min)";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Tokens whose value is ALREADY at or above the floor — a rule that pins
 * `height: var(--monitor-h)` satisfies its axis without restating
 * the floor. Listed explicitly so a future token cannot silently qualify.
 */
const AT_OR_OVER_FLOOR = ["hit-min", "monitor-h", "instrument-h", "reel-h"];

/**
 * Whether a `.class` rule in this source sizes its control to the pointer
 * target floor in BOTH axes. An axis passes when the rule declares
 * `min-height`/`min-width: var(--hit-min)`, or pins that axis with a token
 * already at or over the floor. Rules are read out of the file's own
 * `<style>` block; a control whose class has no rule at all is REPORTED,
 * not assumed fine.
 *
 * A class may also be dressed by the TOKEN OWNER instead of the component:
 * the owned control recipe (`.cockpit .verb` in tokens.css) clears the
 * floor for every `.verb`, so a component that relies on the shared recipe
 * declares nothing locally — and that is the migration working, not a
 * control left unsized. The owner-derived set below is computed from
 * tokens.css, so a new owned class is covered because nobody had to
 * remember it.
 */
export function sizesToFloor(style: string, cls: string, inheritedFloor = false): { found: boolean; ok: boolean } {
  const body = cssRuleBody(style, cls);
  // A local minimum can override the recipe. A local width/height alone
  // cannot defeat its inherited minimum, so judge those separately.
  const shared = inheritedFloor || ownerClearsFloor(cls);
  if (body === null) {
    return { found: shared, ok: shared };
  }
  const over = `var\\(\\s*--(?:${AT_OR_OVER_FLOOR.join("|")})\\s*\\)`;
  // An axis passes when `height`/`min-height` (resp. width) is set from a
  // token at or over the floor. A literal (`24px`) never passes: the number
  // has one owner, and a restated literal is exactly the drift the token
  // exists to prevent.
  const axis = (name: string): boolean => {
    const minimum = [...body.matchAll(new RegExp(`(?:^|;)\\s*min-${name}\\s*:\\s*([^;]+)`, "g"))].at(-1)?.[1];
    if (minimum !== undefined) return new RegExp(`^${over}\\s*$`).test(minimum.trim());
    return shared || new RegExp(`(^|[;{\\s])${name}\\s*:\\s*${over}`).test(body);
  };
  return { found: true, ok: axis("height") && axis("width") };
}

/**
 * The classes the token owner sizes to the floor, DERIVED from tokens.css:
 * any `.cockpit .<name>` rule whose body clears both axes. Computed once at
 * module load rather than written out — the day tokens.css owns another
 * control recipe, this set grows with it.
 */
let ownerFloorClasses: ReadonlySet<string> | null = null;
export function floorClassesFrom(css: string): ReadonlySet<string> {
  const found = new Set<string>();
  for (const rule of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = rule[2]!;
    const over = `var\\(\\s*--(?:${AT_OR_OVER_FLOOR.join("|")})\\s*\\)`;
    const axis = (name: string): boolean =>
      new RegExp(`(^|[;{\\s])(?:min-)?${name}\\s*:\\s*${over}`).test(body);
    if (!axis("height") || !axis("width")) continue;
    for (const selector of rule[1]!.split(",")) {
      // Only an unconditional class recipe sizes every member. A descendant,
      // state or variant selector cannot certify its base class.
      const match = /^\s*\.cockpit\s+(?:\.([A-Za-z_][\w-]*)|:where\(\.([A-Za-z_][\w-]*)\))\s*$/.exec(selector);
      if (match !== null) found.add(match[1] ?? match[2]!);
    }
  }
  return found;
}
export function ownerClearsFloor(cls: string): boolean {
  if (ownerFloorClasses === null) {
    // tokens.css is pure CSS (no Svelte <style> wrapper) — read it raw,
    // comments stripped, so the derivation reads the owner itself.
    ownerFloorClasses = floorClassesFrom(read("src/cockpit/tokens.css"));
  }
  return ownerFloorClasses.has(cls);
}

/** The body of the FIRST `.cls { … }` rule in a style block (null if none). */
export function cssRuleBody(style: string, cls: string): string | null {
  // `.cls` must end at a selector boundary, so `.grip` never matches
  // `.chord-grip` and `.beat-grip` never matches `.beat-grip-x`.
  const re = new RegExp(`\\.${escapeRe(cls)}(?![\\w-])[^{}]*\\{`);
  const m = re.exec(style);
  if (m === null) return null;
  let depth = 1;
  let i = m.index + m[0].length;
  const start = i;
  for (; i < style.length && depth > 0; i += 1) {
    if (style[i] === "{") depth += 1;
    else if (style[i] === "}") depth -= 1;
  }
  return style.slice(start, i - 1);
}

/** The `<style>` block of a Svelte source (css comments stripped). */
export function styleBlock(src: string): string {
  const a = src.indexOf("<style");
  const b = src.indexOf("</style>");
  if (a === -1 || b === -1) return "";
  return src.slice(a, b).replace(/\/\*[\s\S]*?\*\//g, "");
}
