// @vitest-environment node
/**
 * RENDER COST BUDGETS — the rich renderers must not break the frame.
 *
 * The flow virtualizer measures beat heights and re-windows on scroll
 * (tests/cockpit/flow-perf.test.ts asserts the window math fits 16ms on a
 * 5k log). Rich rendering adds PARSE cost per visible beat, so the budgets
 * here are the per-beat halves of that frame:
 *
 *   - a screenful of beats must parse+tokenize inside one 16ms frame;
 *   - the cost of a folded block must be paid for the FOLD, not the whole
 *     document — this is the property that makes a 40k-line file cheap
 *     until the reader opens it, and it is asserted as a ratio so it cannot
 *     regress silently;
 *   - the cost is LINEAR in visible size, not quadratic in document size.
 *
 * MEASUREMENT. EVERY BUDGET IS CPU WORK, NEVER WALL TIME (NO-LOAD-BLOCK).
 * These budgets were wall time, and a loaded CI runner failed a correct
 * tokenizer at 16.09 ms against the 16 ms frame (#635's Shard 5, and the
 * merge queue's run that removed #561): the code waited for a core, it did
 * not do more. `cpuWorkOf` (engine/src/shared/run-cpu.ts, the one CPU
 * owner) counts the work the test's own thread did, which waiting does not
 * inflate, and the least of SAMPLES samples is the answer — a collection
 * pause is real work, but not the code's own. The budget stays a genuine
 * 16ms frame of work.
 *
 * A RATIO between two costs is measured inside one sample, both sides
 * through the same owner, and the QUOTIENT is minimised: a sample disturbed
 * by a collection pause on one side is discarded whole instead of
 * contaminating one half of the comparison.
 *
 * VACUITY. `highlight` refuses anything past MAX_HIGHLIGHT_CHARS and returns
 * an unhighlighted placeholder instead. A fixture that drifts past that cap
 * stops measuring tokenizing and starts measuring the refusal — the budget
 * still passes, and proves nothing. So every fixture whose SUBJECT is
 * tokenizing cost is sized from the cap rather than from a written-down line
 * count, and asserts it actually came back highlighted.
 */
import { describe, expect, test } from "vitest";

import { cpuWorkOf } from "../../engine/src/shared/run-cpu.ts";

import { parseProse } from "../../shared/markdown.ts";
import { highlight } from "../../src/cockpit/render/highlight.ts";
import { parseUnifiedDiff, firstHunkOf, paintDiffLine } from "../../src/cockpit/render/diff.ts";
import { classifyOutput, foldLines } from "../../src/cockpit/render/shapes.ts";
import {
  MAX_HIGHLIGHT_CHARS,
  TURN_CODE_FOLD_LINES,
  TOOL_CELL_FOLD_LINES,
} from "../../src/cockpit/render/render-config.ts";

/** One frame. The whole visible window must fit inside it. */
const FRAME_MS = 16;
/** Beats a tall viewport shows at once (the virtualizer's window, plus slack). */
const VISIBLE_BEATS = 40;

/** How many samples to take; the least is reported. */
const SAMPLES = 7;

/** The CPU work, in ms, of one call of `fn`: the least of SAMPLES samples (see MEASUREMENT). */
function work(fn: () => void): number {
  return cpuWorkOf(fn, SAMPLES);
}

/**
 * `big`'s CPU work divided by `small`'s, from the least-disturbed sample in
 * which BOTH were measured. See MEASUREMENT for why the quotient is
 * minimised rather than the two sides independently.
 */
function ratio(small: () => void, big: () => void): number {
  let best = Number.POSITIVE_INFINITY;
  for (let s = 0; s < SAMPLES; s += 1) {
    const smallMs = cpuWorkOf(small);
    if (smallMs <= 0) continue;
    const q = cpuWorkOf(big) / smallMs;
    if (q < best) best = q;
  }
  return best;
}

/**
 * Text built line by line until one more line would pass `budget`. Sizing a
 * fixture from the budget rather than from a line count is what stops it
 * drifting past MAX_HIGHLIGHT_CHARS when the template or the cap changes.
 */
function textUnder(budget: number, line: (i: number) => string): string {
  const out: string[] = [];
  let length = 0;
  for (let i = 0; ; i += 1) {
    const next = line(i);
    if (length + next.length + 1 > budget) break;
    out.push(next);
    length += next.length + 1;
  }
  return out.join("\n");
}

/** The measurement is only about tokenizing if the input was actually tokenized. */
function tokenized(code: string, lang: string): string {
  const result = highlight(code, lang);
  expect(
    result.highlighted,
    `${code.length} characters is past the ${MAX_HIGHLIGHT_CHARS}-character highlight budget, so this measures the refusal and not the tokenizer`,
  ).toBe(true);
  return code;
}

/** A realistic model turn: prose, a list, a fenced block, a table. */
const TURN = [
  "Here is what I found in the reader path.",
  "",
  "## Findings",
  "",
  "- The `parse` step allocates twice per row.",
  "- The **second** allocation is avoidable — see [the note](https://example.com/n).",
  "",
  "```ts",
  ...Array.from({ length: 30 }, (_, i) => `  const row${i} = decode(buffer, ${i}); // step ${i}`),
  "```",
  "",
  "| step | cost |",
  "| --- | ---: |",
  "| decode | 12ms |",
  "| encode | 3ms |",
  "",
  "That is the whole picture.",
].join("\n");

/**
 * A unit of source small enough that FOUR of it still tokenize — the
 * linearity test below quadruples it, so a quarter of the cap (less a
 * margin for the joins and for the template growing a digit) is the budget.
 */
const SOURCE = textUnder(
  Math.floor((MAX_HIGHLIGHT_CHARS * 0.85) / 4),
  (i) => `export function thing${i}(a: number): string { /* c */ return "v" + a; }`,
);

function patchOf(hunks: number): string {
  const out = ["diff --git a/x.ts b/x.ts", "--- a/x.ts", "+++ b/x.ts"];
  for (let h = 0; h < hunks; h += 1) {
    out.push(`@@ -${h * 20 + 1},6 +${h * 20 + 1},7 @@`);
    out.push(" const before = 1;");
    out.push(`-  return oldValue${h};`);
    out.push(`+  return newValue${h};`);
    out.push("+  // added");
    out.push(" const after = 2;");
  }
  return `${out.join("\n")}\n`;
}

describe("a screenful of rich beats fits one frame", () => {
  test(`${VISIBLE_BEATS} model turns parse inside ${FRAME_MS}ms`, () => {
    // Warm the JIT the way a real scroll does before measuring.
    for (let i = 0; i < 5; i += 1) parseProse(TURN);
    const ms = work(() => {
      for (let i = 0; i < VISIBLE_BEATS; i += 1) parseProse(TURN);
    });
    expect(ms, `${ms.toFixed(2)}ms of CPU work for ${VISIBLE_BEATS} turns`).toBeLessThan(FRAME_MS);
  });

  test(`${VISIBLE_BEATS} folded code blocks tokenize inside ${FRAME_MS}ms`, () => {
    const shown = foldLines(SOURCE.split("\n"), TURN_CODE_FOLD_LINES).shown.join("\n");
    for (let i = 0; i < 5; i += 1) highlight(shown, "ts");
    const ms = work(() => {
      for (let i = 0; i < VISIBLE_BEATS; i += 1) highlight(shown, "ts");
    });
    expect(ms, `${ms.toFixed(2)}ms of CPU work for ${VISIBLE_BEATS} code blocks`).toBeLessThan(FRAME_MS);
  });

  test(`${VISIBLE_BEATS} micro-diffs parse + paint inside ${FRAME_MS}ms`, () => {
    const patch = patchOf(6);
    const run = (): void => {
      const parsed = parseUnifiedDiff(patch);
      const { preview } = firstHunkOf(parsed, 12);
      for (const file of preview.files) {
        for (const hunk of file.hunks) {
          for (const line of hunk.lines) paintDiffLine(line.text, "ts", line.segs);
        }
      }
    };
    for (let i = 0; i < 5; i += 1) run();
    const ms = work(() => {
      for (let i = 0; i < VISIBLE_BEATS; i += 1) run();
    });
    expect(ms, `${ms.toFixed(2)}ms of CPU work for ${VISIBLE_BEATS} micro-diffs`).toBeLessThan(FRAME_MS);
  });

  test(`${VISIBLE_BEATS} tool outputs classify in well under a frame`, () => {
    const output = Array.from({ length: 500 }, (_, i) => `src/f${i}.ts:${i}:match`).join("\n");
    for (let i = 0; i < 5; i += 1) classifyOutput({ query: "x" }, output, "search");
    const ms = work(() => {
      for (let i = 0; i < VISIBLE_BEATS; i += 1) {
        classifyOutput({ query: "x" }, output, "search");
      }
    });
    expect(ms, `${ms.toFixed(2)}ms of CPU work`).toBeLessThan(FRAME_MS);
  });
});

describe("folding is what makes big content cheap", () => {
  test("tokenizing a FOLD costs a fraction of tokenizing the document", () => {
    // This is the property CodeBlock relies on: it folds BEFORE it
    // highlights, so a huge file costs its preview until the reader opens
    // it. If someone reorders those two steps, this ratio collapses.
    //
    // The document has to stay INSIDE the highlight budget or the comparison
    // is against the refusal path, which is cheap for a reason that has
    // nothing to do with folding — and then reordering fold and highlight
    // would leave this passing.
    const big = tokenized(
      textUnder(Math.floor(MAX_HIGHLIGHT_CHARS * 0.85), (i) => `const v${i} = "value ${i}"; // note`),
      "ts",
    );
    const folded = foldLines(big.split("\n"), TOOL_CELL_FOLD_LINES).shown.join("\n");
    expect(folded.split("\n").length).toBeLessThanOrEqual(TOOL_CELL_FOLD_LINES + 1);

    for (let i = 0; i < 3; i += 1) {
      highlight(folded, "ts");
      highlight(big, "ts");
    }
    // The fold is ~16 lines of thousands, but the assertion is deliberately
    // much looser than proportional: at these sizes a fixed per-call
    // overhead (regex lastIndex setup, array allocation) is a real share of
    // the fold's cost, so demanding a proportional saving would be measuring
    // the harness rather than the property. 5x is far outside noise and
    // still fails immediately if someone highlights BEFORE folding.
    const MIN_SAVING = 5;
    const saving = ratio(
      () => { for (let i = 0; i < 20; i += 1) highlight(folded, "ts"); },
      () => { for (let i = 0; i < 20; i += 1) highlight(big, "ts"); },
    );
    expect(
      saving,
      `tokenizing the whole ${big.length}-character document cost only ${saving.toFixed(1)}x the fold — folding must happen BEFORE tokenizing`,
    ).toBeGreaterThan(MIN_SAVING);
  });

  test("a folded preview of a 40k-line file is a sub-millisecond render cost", () => {
    const huge = Array.from({ length: 40_000 }, (_, i) => `line ${i} const a = ${i};`).join("\n");
    const folded = foldLines(huge.split("\n"), TOOL_CELL_FOLD_LINES).shown.join("\n");
    for (let i = 0; i < 5; i += 1) highlight(folded, "ts");
    const ms = work(() => {
      for (let i = 0; i < 50; i += 1) highlight(folded, "ts");
    }) / 50;
    expect(ms, `${ms.toFixed(3)}ms of CPU work per folded preview`).toBeLessThan(1);
  });
});

describe("cost is linear, not quadratic", () => {
  /**
   * Quadrupling the input must cost about 4x, never 16x. Stated as a bound
   * on the QUOTIENT rather than on the larger timing: a bound of the form
   * `four < one * 8 + 5` is satisfied outright once `one` is slow enough,
   * so on a loaded machine it could pass while the code was quadratic.
   */
  const MAX_GROWTH_FOR_4X = 8;

  test("tokenizing 4x the source costs well under 16x the work", () => {
    const unit = tokenized(SOURCE, "ts");
    const quad = tokenized([unit, unit, unit, unit].join("\n"), "ts");
    for (let i = 0; i < 3; i += 1) {
      highlight(unit, "ts");
      highlight(quad, "ts");
    }
    const growth = ratio(
      () => { for (let i = 0; i < 10; i += 1) highlight(unit, "ts"); },
      () => { for (let i = 0; i < 10; i += 1) highlight(quad, "ts"); },
    );
    expect(growth, `4x the source cost ${growth.toFixed(2)}x the work`).toBeLessThan(MAX_GROWTH_FOR_4X);
  });

  test("markdown parsing 4x the document costs well under 16x the work", () => {
    const quad = [TURN, TURN, TURN, TURN].join("\n\n");
    for (let i = 0; i < 3; i += 1) {
      parseProse(TURN);
      parseProse(quad);
    }
    const growth = ratio(
      () => { for (let i = 0; i < 20; i += 1) parseProse(TURN); },
      () => { for (let i = 0; i < 20; i += 1) parseProse(quad); },
    );
    expect(growth, `4x the document cost ${growth.toFixed(2)}x the work`).toBeLessThan(MAX_GROWTH_FOR_4X);
  });

  test("a pathological run of unmatched emphasis stays bounded", () => {
    // The lenient streaming behaviour means an unmatched `*` scans forward
    // looking for a partner. A wall of them must not become quadratic.
    const hostile = "*".repeat(20_000);
    const ms = work(() => parseProse(hostile));
    expect(ms, `${ms.toFixed(2)}ms of CPU work on 20k unmatched emphasis markers`).toBeLessThan(150);
  });
});
