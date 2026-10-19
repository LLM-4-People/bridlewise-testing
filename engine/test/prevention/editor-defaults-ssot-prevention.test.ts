import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { engineModuleSourceRelative } from "../support/module-resolver.ts";
import { experimentExclusion, walk } from "../../scripts/verification/source-walk.ts";

/**
 * Mechanical prevention for the editor-defaults single-source-of-truth
 * (EXP468, Round 34, 12-point-loop-audit).
 *
 * The user's binding directive: "static values like that are prohibited
 * app-wide" and "No static variables/consts other than configurables."
 *: "All configurable values are declared once through the
 * central configuration contract."
 *
 * This test mechanically verifies that the editor operational default
 * values (the 64 MiB / 4 MiB magic numbers) are declared ONCE in the
 * canonical owner (`src/config-contracts.ts` as `EDITOR_DEFAULT_LIMITS`)
 * and are NOT redeclared as raw numeric literals elsewhere in `src/`.
 * Re-declaring them as `64 * 1024 * 1024` in another file would silently
 * create a second source of truth that could drift from the config layer.
 *
 * Allowed sites:
 * `src/config-contracts.ts` — the canonical owner (`EDITOR_DEFAULT_LIMITS`).
 * `src/root-policy.ts` — the protocol upper bounds (different values:
 * 1 GiB / 64 MiB — the protocol FLOOR, not the operational default).
 * `test/**` — tests legitimately reference the literals to pin them.
 *
 * If a future change reintroduces a scattered magic number, this test
 * fails and points the author at the canonical owner.
 */

const ROOT = process.cwd();
// The owner paths, resolved from the tree (the fold moved both under kernel/).
const CANONICAL_OWNER = engineModuleSourceRelative("config-contracts.ts");
const ROOT_POLICY = engineModuleSourceRelative("root-policy.ts");

// The operational-default magic numbers that must have exactly one
// declaration site (the canonical owner). We search for the numeric
// expressions, not just the values, so a renamed re-export doesn't
// bypass the check. The leading `\b` prevents the leading number from
// matching the trailing digit of a larger number (e.g. the `4` in
// `1024`); the negative lookahead `(?!\s*\*\s*1024)` excludes larger
// GiB values (e.g. `4 * 1024 * 1024 * 1024` = 4 GiB) which are different
// concepts (evaluation matrix resource budgets), not the 4 MiB editor
// default.
const EDITOR_DEFAULT_MAGIC_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["64 MiB file default", /\b64\s*\*\s*1024\s*\*\s*1024(?!\s*\*\s*1024)/],
  ["4 MiB patch/insert default", /\b4\s*\*\s*1024\s*\*\s*1024(?!\s*\*\s*1024)/],
];

function listTsFiles(dir: string, acc: string[] = []): string[] {
  for (const file of walk(dir, { exts: [".ts"], exclude: experimentExclusion(ROOT) })) {
    if (!file.endsWith(".test.ts") && !file.endsWith(".d.ts")) acc.push(file);
  }
  return acc;
}

// ---------------------------------------------------------------------------
// Non-editor files that legitimately use a 4 MiB / 64 MiB buffer for a
// DIFFERENT concept (disk I/O buffering, memory store allocation) than the
// editor patch/insert default. The regex matches the byte expression, not
// the intent, so these are excepted with the reason recorded. Adding a file
// here requires that its 4/64 MiB value is NOT an editor default.
// ---------------------------------------------------------------------------
const NON_EDITOR_BUFFER_EXCEPTIONS = new Set<string>([
  // 4 MiB append-only write buffer for the unified memory content store
  // (disk I/O batching), not an editor patch/insert limit.
  join("src", "memory", "unified", "content-store.ts"),
]);

test("editor-defaults-ssot-prevention: editor magic numbers declared only in the canonical owner", () => {
  const files = listTsFiles(join(ROOT, "src"));
  const violators: string[] = [];
  for (const file of files) {
    const rel = relative(ROOT, file);
    if (rel === CANONICAL_OWNER) continue; // canonical owner — allowed
    if (rel === ROOT_POLICY) continue; // protocol floor — different values
    if (NON_EDITOR_BUFFER_EXCEPTIONS.has(rel)) continue; // non-editor buffer concept
    const text = readFileSync(file, "utf8");
    for (const [label, pattern] of EDITOR_DEFAULT_MAGIC_PATTERNS) {
      if (pattern.test(text)) {
        violators.push(`${rel}: ${label} (${pattern.source})`);
      }
    }
  }
  assert.deepEqual(
    violators,
    [],
    `Editor default magic numbers must be declared once in ${CANONICAL_OWNER}. Found scattered redeclarations:\n${violators.join("\n")}`,
  );
});

test("editor-defaults-ssot-prevention: EDITOR_DEFAULT_LIMITS exported from config-contracts.ts (not the editor)", async () => {
  const configContracts = await import("../../src/kernel/config-contracts.ts");
  assert.ok(
    "EDITOR_DEFAULT_LIMITS" in configContracts,
    "EDITOR_DEFAULT_LIMITS must be exported from src/config-contracts.ts (the central config contract)",
  );
  assert.ok(Object.isFrozen(configContracts.EDITOR_DEFAULT_LIMITS), "EDITOR_DEFAULT_LIMITS must be frozen");
});

test("editor-defaults-ssot-prevention: edit-operations MAX_FILE_BYTES is a re-export (not a fresh magic number)", async () => {
  const editOps = await import("../../src/editor/edit-operations.ts");
  const configContracts = await import("../../src/kernel/config-contracts.ts");
  // Asked of the RESOLVER — the constant behind it is module-private, because
  // a default whose owner also owns the resolver has exactly one honest reader.
  assert.equal(
    editOps.resolveEditorLimits().maxFileBytes,
    configContracts.EDITOR_DEFAULT_LIMITS.maxFileBytes,
    "the resolved editor file-byte limit must equal the canonical config-layer default (no drift)",
  );
});
