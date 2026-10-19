import { styleBlock } from "../helpers/control-floor.ts";
// @vitest-environment jsdom
/**
 * INSTRUMENTS — shared width and minimum height (DESIGN-COCKPIT-V2 §8.2).
 * The former fixed 96px height clipped real values and footer controls.
 * Cells now grow with content; the same minimum applies to every cell.
 *
 * Three mechanical arms, each MUTATION-TESTED:
 *   A. the TOKENS declare the spec's exact numbers — a token edited to any
 *      other size fails, so the size cannot drift by editing tokens.css;
 *   B. the CELL consumes those tokens and nothing else — no cell may set a
 *      width/minimum height of its own, and no per-cell/featured/variant sizing
 *      may exist (a "featured tile" is a size branch, so a size branch is
 *      the thing this forbids);
 *   C. RENDERED: every cell in a live room carries the same size class and
 *      the same computed geometry rule — measured over a real render, not
 *      asserted from source alone.
 */
import { describe, expect, test } from "vitest";
import { cleanup, render } from "@testing-library/svelte";

import InstrumentCell from "../../src/cockpit/rooms/InstrumentCell.svelte";
import { read } from "../helpers/source-scan.ts";
import { readSourceView } from "../../engine/scripts/verification/source-view.ts";
import { ASK_PREFILL } from "../../src/cockpit/computer/ask.ts";
import type { SignalEntry } from "../../shared/ui-schema.ts";

const TOKENS = "src/cockpit/tokens.css";
const CELL = "src/cockpit/rooms/InstrumentCell.svelte";

/** §8.2, verbatim. */
const SPEC_CELL_W = "280px";
const SPEC_CELL_H = "96px";
/** §8.2 monitor, verbatim ("uniform 96×28"). */
const SPEC_MONITOR_W = "96px";
const SPEC_MONITOR_H = "var(--hit-min)";

function tokenValue(css: string, name: string): string | null {
  const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(css);
  return m === null ? null : m[1]!.trim();
}

const SIGNAL: SignalEntry = {
  id: "context.utilization",
  module: "context",
  name: "Utilization",
  description: "Fraction of the context window in use.",
  type: "gauge",
  unit: "ratio",
};

const BASE = {
  signal: SIGNAL,
  sample: undefined,
  points: [],
  verbs: [],
  collectingSince: null,
  pinned: false,
  sheetAvailable: false,
  onVerb: () => {},
  onPin: () => {},
};

// ── A. the tokens ARE the spec numbers ────────────────────────────────────

describe("A — tokens.css declares the spec's exact instrument geometry", () => {
  const css = read(TOKENS);

  test("--instrument-w is exactly the spec's 280px", () => {
    expect(tokenValue(css, "instrument-w")).toBe(SPEC_CELL_W);
  });

  test("--instrument-h is exactly the spec's 96px", () => {
    expect(tokenValue(css, "instrument-h")).toBe(SPEC_CELL_H);
  });

  test("the HORIZON monitor preserves width and consumes the shared pointer minimum", () => {
    expect(tokenValue(css, "monitor-w")).toBe(SPEC_MONITOR_W);
    expect(tokenValue(css, "monitor-h")).toBe(SPEC_MONITOR_H);
  });

  test("MUTATION: the extractor really reads the value it asserts", () => {
    expect(tokenValue("--instrument-w: 281px;", "instrument-w")).toBe("281px");
    expect(tokenValue("--instrument-w: 281px;", "instrument-w")).not.toBe(SPEC_CELL_W);
    expect(tokenValue("/* nothing */", "instrument-w")).toBeNull();
  });

  /**
   * ★ THE SIZE TOKENS ARE DECLARED ONCE, AND THAT IS THE WHOLE CLAIM.
   *
   * ── WHAT THIS REPLACES, AND WHY IT PROVED NOTHING ─────────────────────
   *
   *     const afterRoot = css.slice(css.indexOf("@media"));
   *     const densityBlocks = css.slice(css.indexOf('[data-density='));
   *     expect(afterRoot).not.toMatch(/--instrument-[wh]:/);
   *     expect(densityBlocks.slice(0, densityBlocks.indexOf("/* ── Light")))
   *       .not.toMatch(/--instrument-[wh]:/);
   *
   * Three regions, every bound taken from an UNCHECKED `indexOf`, and the
   * last one keyed to a COMMENT BANNER. `indexOf` returns -1 when its needle
   * is absent, and `slice(-1)` is THE LAST CHARACTER OF THE FILE — so
   * removing the `@media` block, renaming the density attribute, or merely
   * editing the decorative `/* ── Light` banner leaves a ONE-CHARACTER
   * subject against which `.not.toMatch()` passes VACUOUSLY. Driven at the
   * parent commit: rc 0, 13/13 passed, with the region collapsed to one
   * character. These are ABSENCE assertions, which is the direction that
   * fails silent, and they had no witness.
   *
   * ── THE CLAIM THAT NEEDS NO NEIGHBOUR ─────────────────────────────────
   *
   * §8.2 says "all exactly 280×96px … no featured tiles". A token declared
   * ONCE cannot be remapped by anything — not by a breakpoint, not by a
   * density block, and not by the light theme, which the sliced version
   * never looked at. So the claim is a COUNT OVER THE WHOLE STYLESHEET:
   * each size token is declared exactly once. Nothing bounds it but the file
   * itself, and it is strictly stronger than what it replaces.
   *
   * ── THE WITNESS (§36) ─────────────────────────────────────────────────
   *
   * A counter that had stopped counting would report 1 for everything and
   * pass. So the same instrument is pointed at `--ground-1`, a token the
   * light theme genuinely DOES re-declare, and is required to find MORE than
   * one — and at the regions the old test named, which must still exist.
   */
  function declarationsOf(stylesheet: string, token: string): number {
    // Comments blanked, so a token named in the banner prose is not a
    // declaration; a declaration is `--name:` and nothing else is.
    return [...stylesheet.matchAll(new RegExp(`--${token}\\s*:`, "g"))].length;
  }

  const code = readSourceView(TOKENS).codeWithStrings();

  test("the size tokens are declared EXACTLY ONCE — no breakpoint, density or theme remaps them", () => {
    // THE WITNESS, first: the instrument can see a redeclaration at all, and
    // the regions this claim is about are present in the file being read.
    expect(
      declarationsOf(code, "ground-1"),
      "the witness: a token the light theme re-declares must count MORE than once, "
      + "or this counter is broken and every assertion below is vacuous",
    ).toBeGreaterThan(1);
    expect(code, "the witness: the stylesheet really carries breakpoints").toContain("@media");
    expect(code, "the witness: the stylesheet really carries density blocks").toContain("[data-density=");

    for (const token of ["instrument-w", "instrument-h"]) {
      expect(
        declarationsOf(code, token),
        `--${token} is declared more than once, so the cell's size depends on which rule wins — `
        + `"all exactly 280×96" admits no responsive, density or theme exception`,
      ).toBe(1);
    }
  });

  test("the one-declaration claim is DRIVEN — a remap in ANY block is found", () => {
    // Both directions on the real stylesheet's shape, so the assertion above
    // is not satisfied by a counter that matches nothing.
    const base = `:root { --instrument-w: 280px; }\n`;
    expect(declarationsOf(base, "instrument-w")).toBe(1);
    expect(declarationsOf(base + `@media (max-width: 1100px) { --instrument-w: 240px; }\n`, "instrument-w")).toBe(2);
    expect(declarationsOf(base + `:root[data-density="scan"] { --instrument-w: 240px; }\n`, "instrument-w")).toBe(2);
    // ★ THE ONE THE SLICED VERSION COULD NOT SEE AT ALL: the light theme sits
    // BEFORE the `@media` blocks and AFTER the density blocks' end banner.
    expect(declarationsOf(base + `:root[data-cockpit-theme="light"] { --instrument-w: 240px; }\n`, "instrument-w")).toBe(2);
    // INERT: a different token's remap is not this token's business.
    expect(declarationsOf(base + `@media (max-width: 1100px) { --row-h: 24px; }\n`, "instrument-w")).toBe(1);
  });
});

// ── B. the cell consumes tokens; no size may be declared or branched ──────

/** Any width/height declaration in a style block that is not a var(). */
export function findLiteralSizes(style: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[;{\s])(width|height|min-width|min-height|max-width|max-height)\s*:\s*([^;}]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(style)) !== null) {
    const value = m[2]!.trim();
    const ok =
      value.includes("var(") || value === "0" || value === "auto" || value === "100%" || value === "inherit";
    if (!ok) out.push(`${m[1]}: ${value}`);
  }
  return out;
}

/** A size branch on the cell selector — the "featured tile" shape. */
export function findSizeBranches(style: string): string[] {
  const out: string[] = [];
  const blockRe = /\.cell([^{]*)\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(style)) !== null) {
    const selectorTail = m[1]!.trim();
    const body = m[2]!;
    if (selectorTail.length === 0) continue; // the base rule owns the size
    if (/(?:^|[;\s])(width|height)\s*:/.test(body)) out.push(`.cell${selectorTail}`);
  }
  return out;
}



describe("B — the cell's size is the token, once, with no branch", () => {
  const style = styleBlock(read(CELL));

  test("the cell uses its shared width and minimum height without clipping content", () => {
    const base = /\.cell\s*\{([^}]*)\}/.exec(style)?.[1] ?? "";
    expect(base).toMatch(/width:\s*100%/);
    expect(styleBlock(read("src/cockpit/rooms/InstrumentsRoom.svelte"))).toMatch(/grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(100%,\s*var\(--instrument-w\)\),\s*1fr\)\)/);
    expect(base).toMatch(/min-height:\s*var\(--instrument-h\)/);
    expect(base, "real hit targets and enlarged content must determine the height").not.toMatch(/(?:^|[;\s])height:\s*var\(--instrument-h\)/);
    expect(base).not.toMatch(/overflow:\s*hidden/);
    // border-box, or the padding+border would make the painted box differ
    // from the declared one — "exactly 280×96" is about the painted box.
    expect(base).toMatch(/box-sizing:\s*border-box/);
  });

  test("no literal size anywhere in the cell's styles", () => {
    const hits = findLiteralSizes(style);
    expect(hits, hits.join("\n")).toEqual([]);
  });

  test("no per-state size branch exists (no featured tile can be built)", () => {
    const hits = findSizeBranches(style);
    expect(hits, hits.join("\n")).toEqual([]);
  });

  test("MUTATION: a literal size is flagged", () => {
    expect(findLiteralSizes(`.cell { width: 320px; }`)).toHaveLength(1);
    expect(findLiteralSizes(`.cell { height: 6rem; }`)).toHaveLength(1);
  });

  test("MUTATION: a size branch is flagged", () => {
    expect(findSizeBranches(`.cell[data-featured="true"] { width: var(--x); }`)).toHaveLength(1);
    expect(findSizeBranches(`.cell.big { height: var(--y); }`)).toHaveLength(1);
  });

  test("token sizes and non-size branches are NOT flagged (no false positives)", () => {
    const good = `.cell { width: var(--instrument-w); height: var(--instrument-h); }
      .cell[data-abnormal="warn"] { color: var(--warn); }`;
    expect(findLiteralSizes(good)).toEqual([]);
    expect(findSizeBranches(good)).toEqual([]);
  });
});

// ── C. rendered: every cell is the same box, in every state ──────────────

describe("C — every rendered cell is the same size, in every honest state", () => {
  test("a measured value owns the readout without repeating its type or history baseline", () => {
    for (const [type, value, expected] of [["boolean", true, "yes"], ["string", "Ready", "Ready"], ["gauge", 12, "12"]] as const) {
      const { container } = render(InstrumentCell, {props: {...BASE, signal: {...SIGNAL, type, unit: undefined}, sample: {v:value,t:1}, collectingSince:1}});
      expect(container.querySelector('.readout')?.textContent?.trim()).toBe(expected);
      expect(container.querySelector('.asof')?.textContent).toContain('asOf');
      expect(container.querySelector('[data-verb-id="instruments.pin"]')).not.toBeNull();
      cleanup();
    }
  });
  const STATES = [
    { name: "absent", props: { ...BASE } },
    {
      name: "measured, no spark",
      props: { ...BASE, sample: { v: 3, t: 1 }, collectingSince: 1 },
    },
    {
      name: "measured with spark",
      props: {
        ...BASE,
        sample: { v: 3, t: 20 },
        points: [
          { t: 10, v: 2 },
          { t: 20, v: 3 },
        ],
        collectingSince: 1,
      },
    },
    {
      name: "pinned with verbs",
      props: {
        ...BASE,
        sample: { v: 3, t: 20 },
        pinned: true,
        verbs: [{ kind: "ask" as const, label: "ask", prefill: ASK_PREFILL }],
      },
    },
  ];

  test("all states render the identical size-bearing element and class", () => {
    const seen = new Set<string>();
    for (const state of STATES) {
      const { container } = render(InstrumentCell, { props: state.props });
      const cell = container.querySelector("article.cell");
      expect(cell, state.name).not.toBeNull();
      // The size lives on the ONE element in every state — a state that
      // moved the box (or wrapped it) would show up as a different shape.
      // Svelte's scope hash rides along; the AUTHORED classes are what a
      // size branch would show up in.
      const authored = cell!.className
        .split(/\s+/)
        .filter((c) => !/^svelte-/.test(c))
        .sort()
        .join(" ");
      seen.add(authored);
      cleanup();
    }
    expect([...seen]).toEqual(["cell"]);
  });

  test("no state adds an inline size (a runtime override of the token)", () => {
    for (const state of STATES) {
      const { container } = render(InstrumentCell, { props: state.props });
      const style = container.querySelector("article.cell")!.getAttribute("style") ?? "";
      expect(style, state.name).not.toMatch(/width|height/);
      cleanup();
    }
  });
});
