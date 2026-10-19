/**
 * THE GUIDE IS FAITHFUL TO THE CODES (merge-door-final §17.2 T-E3): every
 * code `src/workflow/promotion/codes.ts` answers with appears in the code
 * table of `docs/process/MERGE-GUIDE.md` exactly once, with its class and its
 * exit code (and "auto 0" exactly for the codes an unattended run exits 0
 * on), and the table names no code that does not exist — so a person reading
 * a refusal's code finds what it means, and a code added tomorrow cannot
 * ship undocumented.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { PROMOTION_CODES, promotionExitCode, type PromotionCode } from "../../../src/workflow/promotion/codes.ts";

const GUIDE = new URL("../../../../docs/process/MERGE-GUIDE.md", import.meta.url);

/** The code table's rows: code → its class and exit cell. */
function guideRows(): ReadonlyMap<string, Readonly<{ class: string; exit: string }>> {
  const rows = new Map<string, Readonly<{ class: string; exit: string }>>();
  for (const line of readFileSync(GUIDE, "utf8").split("\n")) {
    const match = /^\| `(promotion_[a-z_]+)` \| ([a-z]+) \| ([^|]+) \|/u.exec(line);
    if (match === null) continue;
    assert.equal(rows.has(match[1]!), false, `${match[1]!} has two rows`);
    rows.set(match[1]!, { class: match[2]!, exit: match[3]!.trim() });
  }
  return rows;
}

test("T-E3: every code is in the guide's table once, with its class and exit (auto 0 exactly where an unattended run exits 0), and the table names no other", () => {
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
  }
  assert.deepEqual([...rows.keys()].filter((code) => !(code in PROMOTION_CODES)), [], "the guide names codes that do not exist");
});
