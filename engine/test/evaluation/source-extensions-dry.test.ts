// Regression test for EXP437: DRY violation — evaluation/scenarios.ts
// duplicated SOURCE_EXTENSIONS instead of importing the canonical owner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SOURCE_EXTENSIONS } from "../../src/intelligence/intelligence-types.ts";
import { walk } from "../../scripts/verification/source-walk.ts";

test("scenarios.ts does NOT define its own SOURCE_EXTENSIONS (DRY)", () => {
  const src = readFileSync("src/evaluation/scenarios.ts", "utf8");
  assert.doesNotMatch(src, /const SOURCE_EXTENSIONS\s*=/,
    "scenarios.ts must NOT define its own SOURCE_EXTENSIONS — import the canonical one");
  assert.match(src, /import.*SOURCE_EXTENSIONS.*from.*intelligence-types/,
    "scenarios.ts must import SOURCE_EXTENSIONS from the canonical owner (intelligence-types.ts)");
});

test("only ONE SOURCE_EXTENSIONS definition exists (the canonical owner)", () => {
  const defs: string[] = [];
  for (const p of walk("src", { exts: [".ts"] })) {
    // Look for a DEFINITION (const SOURCE_EXTENSIONS =), not an import.
    if (/^(export\s+)?const SOURCE_EXTENSIONS\s*=/m.test(readFileSync(p, "utf8"))) defs.push(p);
  }
  assert.equal(defs.length, 1, `exactly one SOURCE_EXTENSIONS definition; found: ${JSON.stringify(defs)}`);
  assert.ok(defs[0].includes("intelligence-types"), `the definition must be in intelligence-types.ts; found: ${defs[0]}`);
});

test("canonical SOURCE_EXTENSIONS is a superset of the old hardcoded list", () => {
  const oldHardcoded = [".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java", ".rb", ".cpp", ".cc", ".h", ".hpp"];
  for (const ext of oldHardcoded) {
    assert.ok((SOURCE_EXTENSIONS as readonly string[]).includes(ext),
      `canonical SOURCE_EXTENSIONS must include ${ext} (the old hardcoded list member)`);
  }
});
