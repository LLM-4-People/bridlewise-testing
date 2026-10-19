// @vitest-environment node
/**
 * The served-CSS scope classifier, driven over fixtures.
 *
 * The defect class (DESK-CSS-1): a stale vite-plugin-svelte hot-update served
 * a component's `.bar` rule UNSCOPED, and the sizing declaration leaked onto
 * every same-named class in the app. The compiler scopes correctly; the test
 * suite never runs the dev server; so "served unscoped" had no tripwire. This
 * file proves the classifier refuses a bare sizing selector and passes a
 * scoped one — the deciding logic, tested without a server.
 *
 * The search before creation: `no-generic-css-collision.test.ts` owns the
 * ADJACENT static rule (generic class NAMES that collide across components,
 * read from source). That guard reads the SOURCE stylesheet; this probe reads
 * the SERVED module — the defect is a dev-server transform artifact that is
 * invisible to static compilation. No existing test judges the served CSS's
 * scope hash, so this is a new owner, not a second door.
 *
 * Mutation-verified below: a classifier that stopped refusing a bare sizing
 * selector, or one that refused a scoped one, turns the planted fixtures the
 * wrong colour.
 */
import { describe, expect, test } from "vitest";

import {
  extractServedCss,
  findUnscopedSizingSelectors,
  unscopedCssVerdict,
} from "../../scripts/svelte-css-scope-probe.ts";

describe("findUnscopedSizingSelectors — the classifier", () => {
  test("a BARE class selector carrying a sizing declaration is refused", () => {
    // The composer-crush shape: `.bar { --monitor-w: 96px }` served bare.
    const css = `.bar { --monitor-w: 96px; }`;
    const found = findUnscopedSizingSelectors(css);
    expect(found).toHaveLength(1);
    expect(found[0]).toEqual({ selector: ".bar", declaration: "--monitor-w" });
  });

  test("every sizing property is caught, on a bare class", () => {
    for (const prop of ["width", "min-width", "max-width", "height", "min-height", "max-height", "flex-basis"]) {
      const found = findUnscopedSizingSelectors(`.x { ${prop}: 10px; }`);
      expect(found, `bare .x with ${prop}`).toHaveLength(1);
      expect(found[0]!.declaration).toBe(prop);
    }
  });

  test("a SCOPED class selector passes, even with sizing", () => {
    const css = `.bar.svelte-4psua6 { width: 96px; --monitor-w: 96px; }`;
    expect(findUnscopedSizingSelectors(css)).toEqual([]);
  });

  test("a scoped selector with pseudo-classes and combinators passes", () => {
    const css = [
      `.bar.svelte-4psua6:hover { height: 5px; }`,
      `.theme-dark .bar.svelte-4psua6 { width: 1px; }`,
      `.svelte-4psua6 .bar { min-height: 2px; }`,
    ].join("\n");
    expect(findUnscopedSizingSelectors(css)).toEqual([]);
  });

  test("a bare class with NO sizing declaration is NOT refused (documented rule)", () => {
    // Deliberate: a non-sizing leak changes paint, not layout, and refusing it
    // would need to distinguish every :global() and reset. See the probe's
    // header for the stated rule.
    expect(findUnscopedSizingSelectors(`.bar { display: flex; color: red; }`)).toEqual([]);
  });

  test(":global() selectors are skipped — the deliberate escape is not the defect", () => {
    const css = `:global(body) { margin: 0; } :global(.theme) .bar { width: 5px; }`;
    expect(findUnscopedSizingSelectors(css)).toEqual([]);
  });

  test("a rule nested in @media is still judged", () => {
    const css = `@media (min-width: 10px) { .bar { height: 5px; } }`;
    expect(findUnscopedSizingSelectors(css)).toHaveLength(1);
  });

  test("a selector LIST is judged per member — one bare sizing member is a violation", () => {
    const css = `.scoped.svelte-x1, .bare { width: 10px; }`;
    const found = findUnscopedSizingSelectors(css);
    expect(found).toHaveLength(1);
    expect(found[0]!.selector).toBe(".bare");
  });

  test("element selectors and keyframes are not the class-collision shape", () => {
    const css = [
      `div { box-sizing: border-box; }`,
      `@keyframes svelte-x-spin { from { opacity: 0; } to { opacity: 1; } }`,
    ].join("\n");
    expect(findUnscopedSizingSelectors(css)).toEqual([]);
  });

  test("a CSS comment containing a brace does not split a rule mid-comment", () => {
    // The exact Desk.svelte shape that produced a false positive: a §-prose
    // comment holding `… 64px ↔ 280px … { … }` braces splits the NEXT rule's
    // chunk, and the comment's tail read as a selector carrying `height`.
    const css = `/* THE OPEN/CLOSE — 64px ↔ 280px { a layout prop } */\n` +
      `.bar.svelte-x { height: var(--desk-h); }`;
    expect(findUnscopedSizingSelectors(css)).toEqual([]);
  });

  test("a clean stylesheet with many scoped rules passes", () => {
    const css = [
      `.strip.svelte-a { display: flex; min-height: var(--row-h); }`,
      `.row.svelte-a { grid-template-columns: minmax(var(--monitor-w), 1fr); }`,
      `.tick-track.svelte-a { height: var(--gauge-bar-h); min-width: var(--monitor-w); }`,
    ].join("\n");
    expect(findUnscopedSizingSelectors(css)).toEqual([]);
  });
});

describe("unscopedCssVerdict — the refusal line", () => {
  test("clean is null", () => {
    expect(unscopedCssVerdict("Desk.svelte", [])).toBeNull();
  });

  test("a violation names the component, the selector, and the remedy", () => {
    const verdict = unscopedCssVerdict("src/cockpit/shell/Desk.svelte", [
      { selector: ".bar", declaration: "--monitor-w" },
    ]);
    expect(verdict).toContain("Desk.svelte");
    expect(verdict).toContain("UNSCOPED");
    expect(verdict).toContain(".bar");
    expect(verdict).toContain("sd.mjs restart");
  });
});

describe("extractServedCss — the served-module unwrap", () => {
  test("the __vite__css payload is decoded out of the JS module", () => {
    const css = `.bar.svelte-x { width: 1px; }`;
    const module = `import { updateStyle as __vite__updateStyle } from "/@vite/client"\n` +
      `const __vite__id = "/src/Desk.svelte"\n` +
      `const __vite__css = ${JSON.stringify(css)}\n` +
      `__vite__updateStyle(__vite__id, __vite__css)`;
    expect(extractServedCss(module)).toBe(css);
  });

  test("a module with no style payload is null (absent, never a guess)", () => {
    expect(extractServedCss(`import "/x.js";`)).toBeNull();
  });

  test("a payload holding escaped quotes and newlines survives the decode", () => {
    const css = `.x::before { content: "a\\"b"; }\n.y { width: 1px; }`;
    const module = `const __vite__css = ${JSON.stringify(css)}`;
    expect(extractServedCss(module)).toBe(css);
  });
});

describe("end-to-end over a served-shaped fixture", () => {
  test("a served module carrying a bare sizing rule is refused", () => {
    // The defect, as served: the whole RAW source as the css payload (no hash).
    const rawSource = `<div class="bar">x</div>\n<style>\n  .bar {\n    --monitor-w: 96px;\n  }\n</style>`;
    const module = `const __vite__css = ${JSON.stringify(rawSource)}`;
    const css = extractServedCss(module);
    expect(css).not.toBeNull();
    const violations = findUnscopedSizingSelectors(css!);
    const verdict = unscopedCssVerdict("Desk.svelte", violations);
    expect(verdict).not.toBeNull();
    expect(verdict).toContain("UNSCOPED");
  });

  test("a served module carrying scoped CSS passes end-to-end", () => {
    const scoped = `.bar.svelte-4psua6 { --monitor-w: 96px; width: 96px; }`;
    const module = `const __vite__css = ${JSON.stringify(scoped)}`;
    const css = extractServedCss(module)!;
    expect(unscopedCssVerdict("Desk.svelte", findUnscopedSizingSelectors(css))).toBeNull();
  });
});
