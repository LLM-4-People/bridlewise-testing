/**
 * THE GUIDE IS FAITHFUL TO THE CODES (merge-door-final §17.2 T-E3): every
 * code `src/workflow/promotion/codes.ts` answers with appears in the code
 * table of `docs/process/MERGE-GUIDE.md` exactly once, with its class and its
 * exit code and rendered remedy (and "auto 0" exactly for the codes an unattended run exits 0
 * on), and the table names no code that does not exist — so a person reading
 * a refusal's code finds what it means, and a code added tomorrow cannot
 * ship undocumented.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { PROMOTION_CODES, promotionExitCode, type PromotionCode } from "../../../src/workflow/promotion/codes.ts";
import { parseProse, type InlineNode } from "../../../../shared/markdown.ts";

const GUIDE = new URL("../../../../docs/process/MERGE-GUIDE.md", import.meta.url);

/** The code table's rows: code → its class, exit and rendered remedy cells. */
type GuideRow = Readonly<{ class: string; exit: string; remedy: readonly InlineNode[] }>;

function guideRows(markdown = readFileSync(GUIDE, "utf8")): ReadonlyMap<string, GuideRow> {
  const rows = new Map<string, GuideRow>();
  for (const block of parseProse(markdown)) {
    if (block.type !== "table") continue;
    for (const cells of block.rows) {
      const [codeCell, classCell, exitCell, remedyCell] = cells;
      const code = codeCell?.[0];
      if (codeCell?.length !== 1 || code?.type !== "code" || !/^promotion_[a-z_]+$/u.test(code.code)) continue;
      const classification = classCell?.[0];
      const exit = exitCell?.[0];
      assert.equal(cells.length, 4, `${code.code}: a code row must have four cells`);
      assert.equal(classCell?.length, 1, `${code.code}: class must be one text cell`);
      assert.equal(exitCell?.length, 1, `${code.code}: exit must be one text cell`);
      assert.ok(classification?.type === "text", `${code.code}: missing class text`);
      assert.ok(exit?.type === "text", `${code.code}: missing exit text`);
      assert.ok(remedyCell !== undefined && remedyCell.length > 0, `${code.code}: missing remedy`);
      assert.equal(rows.has(code.code), false, `${code.code} has two rows`);
      rows.set(code.code, { class: classification.text.trim(), exit: exit.text.trim(), remedy: remedyCell });
    }
  }
  return rows;
}

/** Compare the parser's inline structure, preserving formatting, links and text. */
function assertGuideRemedy(code: string, actual: readonly InlineNode[], remedy: string): void {
  const blocks = parseProse(remedy);
  assert.equal(blocks.length, 1, `${code}: the canonical remedy must be one paragraph`);
  const paragraph = blocks[0];
  assert.ok(paragraph?.type === "paragraph", `${code}: the canonical remedy must be a paragraph`);
  assert.deepEqual(actual, paragraph.children, `${code}: the guide's remedy`);
}

test("guide code rows come from Markdown tables, excluding fenced and paragraph lookalikes", () => {
  const markdown = [
    "| Code | Class | Exit | What to do |",
    "|---|---|---|---|",
    "| `promotion_real` | ok | 0 | A rendered table row |",
    "",
    "```md",
    "| `promotion_fenced` | input | 2 | A code example |",
    "```",
    "",
    "| `promotion_prose` | input | 2 | No table header or separator |",
  ].join("\n");
  assert.deepEqual([...guideRows(markdown)], [["promotion_real", {
    class: "ok", exit: "0", remedy: [{ type: "text", text: "A rendered table row" }],
  }]]);
});

test("guide remedy comparison rejects stale words and lost inline meaning while class and exit stay correct", () => {
  const code = "promotion_probe";
  const remedy = "Inspect **native** `first|attempt` output via [details](https://example.invalid/first).";
  const markdown = [
    "| Code | Class | Exit | What to do |",
    "|---|---|---|---|",
    "| `promotion_probe` | errored | 4 | Inspect **native** `first\\|attempt` output via [details](https://example.invalid/first). |",
  ].join("\n");
  const row = guideRows(markdown).get(code);
  assert.ok(row !== undefined);
  assertGuideRemedy(code, row.remedy, remedy);
  const mutants = [
    ["stale words", markdown.replace("Inspect", "Ignore")],
    ["lost emphasis", markdown.replace("**native**", "native")],
    ["lost code span", markdown.replace("`first\\|attempt`", "first\\|attempt")],
    ["changed link target", markdown.replace("https://example.invalid/first", "https://example.invalid/second")],
    ["changed text spacing", markdown.replace("output via", "output  via")],
  ];
  for (const [name, mutant] of mutants) {
    const changed = guideRows(mutant!).get(code);
    assert.ok(changed !== undefined, name);
    assert.equal(changed.class, row.class, `${name}: the class remains correct`);
    assert.equal(changed.exit, row.exit, `${name}: the exit remains correct`);
    assert.throws(() => assertGuideRemedy(code, changed.remedy, remedy), /the guide's remedy/u, name);
  }
  assert.throws(() => guideRows(`${markdown}\n${markdown.split("\n").at(-1)}`), /has two rows/u);
  assert.throws(() => guideRows(`${markdown} extra |`), /four cells/u);
  for (const malformed of ["", "# A heading", "First paragraph.\n\nSecond paragraph."]) {
    assert.throws(() => assertGuideRemedy(code, row.remedy, malformed), /canonical remedy must be/u);
  }
});

test("T-E3: every code is in the guide's table once, with its class, exit and remedy (auto 0 exactly where an unattended run exits 0), and the table names no other", () => {
  const rows = guideRows();
  const codes = Object.keys(PROMOTION_CODES) as PromotionCode[];
  assert.ok(rows.size > 0, "the guide's code table was not found: a reader finds nothing");
  for (const code of codes) {
    const row = rows.get(code);
    assert.ok(row !== undefined, `${code} is missing from docs/process/MERGE-GUIDE.md §7`);
    assert.equal(row.class, PROMOTION_CODES[code].class, `${code}: the guide's class`);
    const exit = String(promotionExitCode(code));
    const auto = promotionExitCode(code, true);
    assert.equal(row.exit, auto === 0 && exit !== "0" ? `${exit} (auto 0)` : exit, `${code}: the guide's exit`);
    assertGuideRemedy(code, row.remedy, PROMOTION_CODES[code].remedy);
  }
  assert.deepEqual([...rows.keys()].filter((code) => !(code in PROMOTION_CODES)), [], "the guide names codes that do not exist");
});
