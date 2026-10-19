// @vitest-environment node
/**
 * THE REST-STATE VISIBILITY FLOOR.
 *
 * A control that is INVISIBLE at rest and revealed only by `:hover` is
 * unreachable on any device without a pointer that hovers — touch has no
 * hover, so the control simply does not exist there. The audit measured two
 * such affordances (the beat options row, the copy button) plus a
 * display-gated cousin (the reel's verb cluster), and the floor it proposes
 * is: a hover-revealed control must ALSO be revealed by focus (keyboard) and
 * must be visible AT REST wherever hover does not exist (`(hover: none)`).
 *
 * THE POPULATION IS DERIVED, NEVER HAND-LISTED. The scanner walks every
 * component `<style>` block plus `tokens.css`, pairs every "hidden at rest"
 * declaration (`opacity: 0` · `display: none` · `visibility: hidden`) with a
 * reveal of the SAME subject class under a `:hover` selector, and judges the
 * pair. A new hover-gated control is covered because nobody had to remember
 * it; §31a containment is asserted on the two audit-named subjects so a
 * scanner that goes quiet cannot certify an empty universe.
 *
 * RUNG 5, SAID PLAINLY: nothing structural stops a component hiding a
 * control its own way — CSS cannot be made to refuse. The scanner is the
 * floor, its parser is exercised on planted sources in BOTH directions at
 * the foot of this file, and it reads bytes (never grep — NUL bytes make
 * files invisible to grep in this tree).
 *
 * ── THE FLOOR'S OTHER HALF, AND WHY IT HAS NO GUARD ───────────────────────
 *
 * The audit (§7.5) counted TWO classes of rest-invisible control. The first
 * — hidden at rest, revealed on hover — is what this file judges, and it is
 * mechanically judgeable because CSS names both halves of the defect: a
 * hide and a hover reveal of the same subject.
 *
 * The second class is the REST-EDGE half: a control that is technically
 * visible at rest but does not LOOK like a control — bare text that only
 * grows a border, a fill, or a cursor change on hover. The audit counted
 * roughly twenty-nine such subjects; seven control owners (the verb chip,
 * the chord grips, the horizon controls among them) now wear a quiet
 * hairline edge at rest, and ROUGHLY NINETEEN SUBJECTS REMAIN un-edged.
 * They are deliberately not enumerated here — a list in a comment is a
 * count that goes stale silently; re-derive it the way the audit did, by
 * walking the interactive elements at rest in the browser.
 *
 * NO GUARD WAS BUILT FOR THE REST-EDGE HALF, deliberately. "This control
 * wears an edge at rest" has no CSS-nameable subject: an affordance can be
 * a border, a background shift, an underline, a glyph, or the element's
 * position — and a scanner would have to pick ONE spelling as "the edge"
 * and red everything else. That guard would manufacture wrong edges:
 * owners would grow borders they should not have, purely to satisfy the
 * proxy, and a control whose real affordance is typographic would be
 * judged naked while a decorative border passed. A guard that manufactures
 * wrong edges is worse than no guard — it converts a design judgment into
 * mechanical compliance with a wrong proxy, in the permissive direction
 * for real defects and the punitive direction for correct designs. So the
 * rest-edge half stays a reviewed judgment, made owner by owner, and this
 * header is where the next reader learns both the remainder and the reason.
 */
import { describe, expect, test } from "vitest";

import { read, relpath, walk } from "../helpers/source-scan.ts";

const COCKPIT_ROOT = "src/cockpit";

// ── The tiny CSS walker ────────────────────────────────────────────────────

export type CssRule = Readonly<{
  /** The full selector, as written. */
  selector: string;
  /** The declaration block's text. */
  body: string;
  /** Every enclosing at-rule condition ("@media (hover: none)", …). */
  media: readonly string[];
}>;

/** Every rule in a stylesheet, with its at-rule context. Brace-walking is
 * exact here because CSS has no nested braces outside at-rules. */
export function cssRules(css: string): CssRule[] {
  const out: CssRule[] = [];
  const walkBlock = (text: string, media: readonly string[]): void => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf("{", i);
      if (open === -1) return;
      const header = text.slice(i, open).trim();
      // find the matching close brace
      let depth = 1;
      let j = open + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === "{") depth += 1;
        else if (text[j] === "}") depth -= 1;
        j += 1;
      }
      const inner = text.slice(open + 1, j - 1);
      if (header.startsWith("@")) {
        walkBlock(inner, [...media, header]);
      } else if (header.length > 0) {
        out.push({ selector: header, body: inner, media });
      }
      i = j;
    }
  };
  walkBlock(css.replace(/\/\*[\s\S]*?\*\//g, ""), []);
  return out;
}

/** The `<style>` blocks of a Svelte source, or the whole text for a .css. */
export function styleTextOf(file: string, src: string): string {
  if (!file.endsWith(".svelte")) return src;
  return [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]!).join("\n");
}

const HIDES = [
  /\bopacity\s*:\s*0(?![.\d])/,
  /\bopacity\s*:\s*var\(\s*--opacity-off\s*\)/,
  /\bdisplay\s*:\s*none\b/,
  /\bvisibility\s*:\s*hidden\b/,
];
const REVEALS = [
  /\bopacity\s*:\s*(?!0(?![.\d]))[\d.]+/,
  /\bopacity\s*:\s*var\(\s*--opacity-on\s*\)/,
  /\bdisplay\s*:\s*(?!none)[a-z-]+/,
  /\bvisibility\s*:\s*visible\b/,
];

/** The subject of a selector — its LAST class token ("
 * .reel:hover .verbs" → "verbs"). */
export function subjectOf(selector: string): string | null {
  const last = selector.trim().split(/[\s>+~]+/).pop() ?? "";
  const classes = [...last.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]!);
  return classes.length > 0 ? classes[classes.length - 1]! : null;
}

export type HoverGated = Readonly<{
  file: string;
  subject: string;
  focusRevealed: boolean;
  restVisibleWithoutHover: boolean;
}>;

/**
 * Every subject class a stylesheet hides at rest and reveals on hover, with
 * the two floor facts judged per subject.
 *
 * `sharedCss` is the one global sheet (tokens.css): a component's scoped
 * class can only be reached from its own block or from the global sheet.
 * Copy used to split hide (CopyButton.svelte) from reveal (tokens.css);
 * both halves now live on the owned `.reveal-item` rule. Hides are read
 * from the component's OWN css; reveals and media arms are searched in both.
 */
export function hoverGatedSubjects(file: string, css: string, sharedCss = ""): HoverGated[] {
  const ownRules = cssRules(css);
  const rules = sharedCss.length > 0 ? [...ownRules, ...cssRules(sharedCss)] : ownRules;
  const isRest = (r: CssRule): boolean =>
    !/:hover|:focus|\.focused/.test(r.selector) && !r.media.some((m) => /hover:\s*none/.test(m));
  const hiddenSubjects = new Map<string, CssRule>();
  for (const r of ownRules) {
    if (!isRest(r)) continue;
    if (!HIDES.some((h) => h.test(r.body))) continue;
    const subject = subjectOf(r.selector);
    if (subject !== null) hiddenSubjects.set(subject, r);
  }
  const out: HoverGated[] = [];
  for (const [subject] of hiddenSubjects) {
    // A COMMA-JOINED selector is about every one of its subjects: the owned
    // pattern's rest rule is `.reveal-on-hover .reveal-item`, and the reveal
    // answers `.reveal-on-hover:hover .reveal-item` — the same rule, read
    // per arm, or the shared half is invisible to the subject it dresses.
    const subjectsOf = (r: CssRule): (string | null)[] => r.selector.split(",").map(subjectOf);
    const about = (r: CssRule): boolean => subjectsOf(r).includes(subject);
    const revealed = (r: CssRule): boolean => REVEALS.some((re) => re.test(r.body));
    const hoverReveal = rules.some((r) => about(r) && /:hover/.test(r.selector) && revealed(r));
    if (!hoverReveal) continue; // hidden for some other reason — not this floor's subject
    const focusRevealed = rules.some(
      (r) => about(r) && /:focus|\.focused/.test(r.selector) && revealed(r),
    );
    const restVisibleWithoutHover = rules.some(
      (r) => about(r) && r.media.some((m) => /hover:\s*none/.test(m)) && revealed(r),
    );
    out.push({ file, subject, focusRevealed, restVisibleWithoutHover });
  }
  return out;
}

// ── The floor, over the real tree ──────────────────────────────────────────

function realPopulation(): HoverGated[] {
  const shared = read("src/cockpit/tokens.css");
  const out: HoverGated[] = [...hoverGatedSubjects("src/cockpit/tokens.css", shared)];
  for (const file of walk(COCKPIT_ROOT)) {
    if (!file.endsWith(".svelte")) continue;
    const css = styleTextOf(file, read(file));
    if (css.trim().length === 0) continue;
    out.push(...hoverGatedSubjects(relpath(file), css, shared));
  }
  return out;
}

describe("every hover-revealed control is keyboard-revealed AND visible at rest without hover", () => {
  const population = realPopulation();

  test("the scanner sees the audit's named subjects — a quiet universe certifies nothing", () => {
    const names = population.map((g) => `${g.file}::${g.subject}`);
    // §31a containment: the audit-named affordances must be IN the
    // population the verdict covers. The beat's options row and the copy
    // button now read the OWNED pattern in tokens.css (the reveal item is
    // `reveal-item`, the container `reveal-on-hover`); the owner's combined
    // rule's subject is its last class token, so the witness for both is the
    // owner's own rule. Reels now expose one ordinary shared menu action;
    // their removed hover cluster must not be required back into the UI.
    expect(names.join("\n")).toContain("tokens.css::reveal-item");
    const reel = read("src/cockpit/rooms/Reel.svelte");
    expect(reel).toContain('class="verb more"');
    expect(reel).toContain('data-verb-id="switch.conversation-menu"');
    expect(population.filter(g => g.file.endsWith("Reel.svelte"))).toEqual([]);
    // The beat's own trigger remains: `.focused` reveals the row from the
    // flow's roving listbox, on top of the owned container's hover/focus.
    const beat = read("src/cockpit/flow/Beat.svelte");
    expect(beat).toContain("reveal-item");
    expect(beat).toContain("reveal-on-hover");
    // Copy is a `.verb.reveal-item` — hide/show is the owned rule, not a
    // second `.copy-btn` recipe. ArtifactFrame has no container, so copy
    // there is visible at rest (Primer).
    const copy = read("src/cockpit/render/CopyButton.svelte");
    expect(copy).toMatch(/class="verb reveal-item copy"/);
    expect(copy).not.toMatch(/class="copy-btn"/);
    expect(population.length).toBeGreaterThanOrEqual(2);
  });

  test("no control is reachable ONLY by hover", () => {
    const unreachable = population.filter((g) => !g.focusRevealed);
    expect(
      unreachable,
      "these are hidden at rest, revealed on hover, and have NO focus reveal — keyboard users cannot reach them",
    ).toEqual([]);
  });

  test("no control vanishes on a device with no hover", () => {
    const touchDead = population.filter((g) => !g.restVisibleWithoutHover);
    expect(
      touchDead,
      "these are hidden at rest with no (hover: none) reveal — on touch they do not exist. " +
        "Add an `@media (hover: none)` arm beside the reveal rule's owner",
    ).toEqual([]);
  });
});

// ── Mutation self-checks: the scanner must catch each shape alone ──────────

describe("the scanner itself", () => {
  const CLEAN = `
    .thing { opacity: 0; }
    .host:hover .thing { opacity: 1; }
    .host:focus-within .thing { opacity: 1; }
    @media (hover: none) { .thing { opacity: 1; } }
  `;

  test("a compliant reveal passes", () => {
    const got = hoverGatedSubjects("f", CLEAN);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ focusRevealed: true, restVisibleWithoutHover: true });
  });

  test("a hover-only reveal is flagged on BOTH floors", () => {
    const got = hoverGatedSubjects("f", ".t { opacity: 0; } .h:hover .t { opacity: 1; }");
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ focusRevealed: false, restVisibleWithoutHover: false });
  });

  test("the display-gated shape is the same defect, and is seen", () => {
    const got = hoverGatedSubjects(
      "f",
      ".v { display: none; } .h:hover .v { display: inline-flex; } .h:focus-within .v { display: inline-flex; }",
    );
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ focusRevealed: true, restVisibleWithoutHover: false });
  });

  test("the visibility-hidden shape is seen too — a third spelling of the same hide", () => {
    const got = hoverGatedSubjects(
      "f",
      ".v { visibility: hidden; } .h:hover .v { visibility: visible; }",
    );
    expect(got).toHaveLength(1);
  });

  test("an element hidden for a NON-hover reason is not this floor's subject", () => {
    expect(hoverGatedSubjects("f", ".gauge { display: none; } .open .gauge { display: block; }")).toEqual([]);
  });

  test("a reveal inside (hover: none) does not count as the hidden-at-rest base", () => {
    const got = hoverGatedSubjects("f", CLEAN);
    expect(got).toHaveLength(1); // the media-arm rule did not create a second subject
  });
});
