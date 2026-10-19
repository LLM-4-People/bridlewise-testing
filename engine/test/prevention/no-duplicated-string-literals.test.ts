import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  detectDuplicatedLiterals,
  type LiteralConcept,
  type LiteralPosition,
} from "../../src/quality-packs/prevention/duplicated-literals-detector.ts";
import { experimentExclusion, walk } from "../../scripts/verification/source-walk.ts";

/**
 * D3 Test #3 — No duplicated string/numeric literals.
 *
 * Scope: all.ts files under `src/` (excluding test files and.d.ts). Mirrors
 * `no-generic-errors.test.ts` scope for consistency.
 *
 * Concepts are seeded from `test/prevention/duplicated-literals-allowlist.json`.
 * Each concept has a `canonicalOwner` (the named constant that should own the
 * literal), a `literal` (the string/numeric value), an optional `position`
 * (`"any"` or `"max-arg"`), and an `allowlist` (files where the literal is
 * currently allowed — the baseline).
 *
 * Allowlist drift detection (T7 inversion): stale baseline entries MUST FAIL.
 * New duplications not in the baseline FAIL. This forces the baseline to
 * shrink (when a literal is deduplicated, the entry is removed).
 */

const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const ALLOWLIST_PATH = join(ROOT, "test", "prevention", "duplicated-literals-allowlist.json");
const HOSTILE_DIR = join(ROOT, "test", "fixtures", "duplicated-literals-hostile");

interface AllowlistJson {
  concepts: readonly {
    key: string;
    canonicalOwner: string;
    literal: string;
    position?: LiteralPosition;
    allowlist: readonly string[];
  }[];
}

function loadConcepts(): Map<string, LiteralConcept> {
  const json = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8")) as AllowlistJson;
  const concepts = new Map<string, LiteralConcept>();
  for (const c of json.concepts) {
    const concept: LiteralConcept = {
      canonicalOwner: c.canonicalOwner,
      literal: c.literal,
      allowlist: c.allowlist,
    };
    if (c.position !== undefined) concept.position = c.position;
    concepts.set(c.key, concept);
  }
  return concepts;
}

function listSrcTsFiles(dir: string, acc: string[] = []): string[] {
  for (const file of walk(dir, { exts: [".ts"], exclude: experimentExclusion(ROOT) })) {
    if (!file.endsWith(".test.ts") && !file.endsWith(".d.ts")) acc.push(file);
  }
  return acc;
}

function readSources(files: string[]): { path: string; content: string }[] {
  return files.map((f) => ({ path: f.slice(ROOT.length + 1).replace(/\\/g, "/"), content: readFileSync(f, "utf8") }));
}

// ---------------------------------------------------------------------------
// Main scan: ZERO findings + ZERO stale entries on the real src/ tree.
// ---------------------------------------------------------------------------

test("no-duplicated-string-literals: ZERO findings + ZERO stale baseline entries on the real src/ tree", () => {
  const files = listSrcTsFiles(SRC);
  const sources = readSources(files);
  const concepts = loadConcepts();
  const result = detectDuplicatedLiterals({ sources, concepts });
  if (result.findings.length > 0) {
    assert.fail(
      `Duplicated-literals detector found ${result.findings.length} finding(s):\n` +
        result.findings.map((f) => `  ${f.file}:${f.line} literal="${f.literal}" concept=${f.concept} (canonicalOwner: ${f.canonicalOwner})`).join("\n") +
        "\nExtract to the canonical owner constant or add the file to the concept's allowlist.",
    );
  }
  if (result.staleAllowlistEntries.length > 0) {
    assert.fail(
      `Duplicated-literals allowlist has ${result.staleAllowlistEntries.length} stale entr(y/ies):\n` +
        result.staleAllowlistEntries.map((v) => `  ${v}`).join("\n") +
        "\nRemove the stale entry from test/prevention/duplicated-literals-allowlist.json.",
    );
  }
});

// ---------------------------------------------------------------------------
// Hostile fixtures: the detector catches intentionally-duplicated literals.
// ---------------------------------------------------------------------------

test("no-duplicated-string-literals (hostile): unallowlisted \"input_error\" is caught", () => {
  const sources = readSources([join(HOSTILE_DIR, "input-error-dup.ts")]);
  const concepts = new Map<string, LiteralConcept>([
    ["error-code:input_error", { canonicalOwner: "src/errors.ts", literal: "input_error", position: "any", allowlist: [] }],
  ]);
  const result = detectDuplicatedLiterals({ sources, concepts });
  assert.ok(
    result.findings.some((f) => f.concept === "error-code:input_error"),
    'unallowlisted "input_error" must be caught',
  );
});

test("no-duplicated-string-literals (hostile): unallowlisted \"application/json\" is caught", () => {
  const sources = readSources([join(HOSTILE_DIR, "application-json-dup.ts")]);
  const concepts = new Map<string, LiteralConcept>([
    ["content-type:application_json", { canonicalOwner: "src/contracts.ts", literal: "application/json", position: "any", allowlist: [] }],
  ]);
  const result = detectDuplicatedLiterals({ sources, concepts });
  assert.ok(
    result.findings.some((f) => f.concept === "content-type:application_json"),
    'unallowlisted "application/json" must be caught',
  );
});

test("no-duplicated-string-literals (hostile): unallowlisted.max(4096) is caught", () => {
  const sources = readSources([join(HOSTILE_DIR, "max-4096-dup.ts")]);
  const concepts = new Map<string, LiteralConcept>([
    ["path-length:max_4096", { canonicalOwner: "MAX_PATH_LENGTH", literal: "4096", position: "max-arg", allowlist: [] }],
  ]);
  const result = detectDuplicatedLiterals({ sources, concepts });
  assert.ok(
    result.findings.some((f) => f.concept === "path-length:max_4096"),
    "unallowlisted .max(4096) must be caught",
  );
});

test("no-duplicated-string-literals (hostile): stale baseline entry FAILS (T7 inversion)", () => {
  const sources = readSources([join(HOSTILE_DIR, "input-error-dup.ts")]);
  // The allowlist lists a file that does NOT have the literal → stale entry.
  const concepts = new Map<string, LiteralConcept>([
    ["error-code:input_error", {
      canonicalOwner: "src/errors.ts",
      literal: "input_error",
      position: "any",
      allowlist: ["src/nonexistent-file.ts"],
    }],
  ]);
  const result = detectDuplicatedLiterals({ sources, concepts });
  assert.ok(
    result.staleAllowlistEntries.length >= 1,
    "stale baseline entry (file no longer inlines the literal) must FAIL",
  );
});
