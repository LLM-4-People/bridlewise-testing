import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  detectDuplicateBodies,
  computeBodyHashes,
} from "../../src/quality-packs/prevention/duplicate-body-detector.ts";
import { experimentExclusion, walk } from "../../scripts/verification/source-walk.ts";

/**
 * D3 Test #1 — No duplicate function bodies (DRY mechanical enforcement).
 *
 * Scope: all.ts files under `src/` (excluding test files,.d.ts declarations,
 * and index.ts barrel re-exports). Rationale: `test/`, `scripts/`, `verification/`,
 * `traceability/` have legitimate repetition (test fixtures, build helpers,
 * research scripts). DRY's job here is to catch duplication in the shipped
 * runtime source, not in build helpers.
 *
 * Body = the FULL function (signature + body), ≥80 chars (T9: full function for
 * consistency with jscpd/jsinspect). The quorum: ≥2 of 3 passes (Pass 1 exact
 * hash, Pass 2 normalized Jaccard, Pass 3 allowlist drift). For NEW duplicates
 * (not in the allowlist), Pass 1 OR Pass 2 alone is sufficient.
 *
 * Allowlist drift detection (T7 inversion): stale allowlist entries MUST FAIL
 * (unlike `dead-export-scanner.test.ts:261-268` which only logs). This inverts
 * the "log only" pattern so the allowlist stays minimal and cannot rot.
 *
 * Performance (T5): the Jaccard pass uses hash-bucketing (effectively O(N)),
 * not O(N²) pairwise. The test target is <5s on ~160 src files / ~2685 functions.
 *
 * `minTokenCount: 100` is used for the main scan. This threshold is higher
 * than the design's default of 30. Rationale: with `jaccardThreshold: 1.0`
 * (only exact normalized matches), functions with 30-99 normalized tokens
 * can produce "shingle-rotation" false positives (Jaccard = 1.0 but different
 * normalizedHash, making the pair un-allowlistable via a hash). The 100-token
 * threshold eliminates these while still catching large normalized duplicates.
 * Recall limit FN2c: normalized duplicates with < 100 normalized tokens are
 * NOT caught. The hostile fixtures use `minTokenCount: 30` (the default) to
 * verify the detector's normalized-duplicate detection at the design threshold.
 *
 * Residual false-negative classes (documented recall limits, accepted):
 * - FN1: real duplicates below 80-char / 30-token threshold.
 * - FN2: real duplicates with Jaccard < 1.0 (heavily mutated).
 * - FN2c: normalized duplicates with < 100 normalized tokens (main scan).
 * - FN3: real duplicates wrongly added to the allowlist (human-error residual).
 * - FN5: real duplicates outside `src/` (test/, scripts/, verification/, traceability/).
 */

const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const ALLOWLIST_PATH = join(ROOT, "test", "prevention", "duplicate-bodies-allowlist.json");
const FIXTURES_DIR = join(ROOT, "test", "fixtures", "duplicate-bodies-hostile");

const MIN_TOKEN_COUNT_MAIN = 100;
const MIN_TOKEN_COUNT_HOSTILE = 30;
const JACCARD_THRESHOLD = 1.0;

function listSrcTsFiles(dir: string, acc: string[] = []): string[] {
  for (const file of walk(dir, { exts: [".ts", ".mjs"], exclude: experimentExclusion(ROOT) })) {
    if (file.endsWith(".test.ts") || file.endsWith(".test.mjs") || file.endsWith(".d.ts")) continue;
    // Treat `index.ts` / `index.mjs` barrel re-exports as non-source (they
    // contain only import/export statements, no function bodies to dedup).
    if ((file.endsWith("/index.ts") || file.endsWith("/index.mjs")) && isBarrelReExport(file)) continue;
    acc.push(file);
  }
  return acc;
}

function isBarrelReExport(path: string): boolean {
  const content = readFileSync(path, "utf8");
  const stripped = content.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
  const lines = stripped.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return true;
  return lines.every((l) =>
    /^import\s/.test(l) || /^export\s/.test(l) || /^export\s*\{[\s\S]*\}\s*from\s/.test(l) ||
    /^export\s+\*\s+from\s/.test(l) || /^export\s+type\s/.test(l),
  );
}

function loadAllowlist(): { allowlistCross: readonly { hash: string; fileA: string; fileB: string; reason: string; contractTest?: string }[]; allowlistSameFile: readonly { hash: string; file: string; count: number; reason: string }[] } {
  return JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8"));
}

function readSources(files: string[]): { path: string; content: string }[] {
  return files.map((f) => ({ path: f.slice(ROOT.length + 1).replace(/\\/g, "/"), content: readFileSync(f, "utf8") }));
}

// ---------------------------------------------------------------------------
// Main scan: ZERO findings + ZERO mirror violations on the real src/ tree.
// ---------------------------------------------------------------------------

test("no-duplicate-function-bodies: ZERO findings on the real src/ tree (with allowlist + drift detection)", () => {
  const files = listSrcTsFiles(SRC);
  const sources = readSources(files);
  const allowlist = loadAllowlist();
  const result = detectDuplicateBodies({
    sources,
    allowlistCross: allowlist.allowlistCross,
    allowlistSameFile: allowlist.allowlistSameFile,
    jaccardThreshold: JACCARD_THRESHOLD,
    minTokenCount: MIN_TOKEN_COUNT_MAIN,
  });
  if (result.findings.length > 0) {
    assert.fail(
      `DRY detector found ${result.findings.length} duplicate-body finding(s) in src/:\n` +
        result.findings.map((f) => `  [${f.passes}] ${f.file}:${f.line} ${f.name} (bodySize=${f.bodySize})`).join("\n") +
        "\nExtract to a shared helper and import at all sites, OR add to test/prevention/duplicate-bodies-allowlist.json with a contract-test path if intentional.",
    );
  }
  if (result.mirrorViolations.length > 0) {
    assert.fail(
      `DRY allowlist has ${result.mirrorViolations.length} stale entr(y/ies):\n` +
        result.mirrorViolations.map((v) => `  ${v}`).join("\n") +
        "\nUpdate the hash or remove the stale entry from test/prevention/duplicate-bodies-allowlist.json.",
    );
  }
});

// ---------------------------------------------------------------------------
// Hostile fixtures: the detector catches intentionally-duplicated functions.
// ---------------------------------------------------------------------------

test("no-duplicate-function-bodies (hostile): Pass 1 catches exact cross-file duplicates", () => {
  const sources = readSources([
    join(FIXTURES_DIR, "exact-duplicate-a.ts"),
    join(FIXTURES_DIR, "exact-duplicate-b.ts"),
  ]);
  const result = detectDuplicateBodies({
    sources,
    allowlistCross: [],
    allowlistSameFile: [],
    jaccardThreshold: JACCARD_THRESHOLD,
    minTokenCount: MIN_TOKEN_COUNT_HOSTILE,
  });
  assert.ok(result.findings.length >= 2, `Pass 1 must catch the exact duplicate (got ${result.findings.length} findings)`);
  assert.equal(result.findings[0]!.passes, "exact");
});

test("no-duplicate-function-bodies (hostile): Pass 2 catches normalized cross-file duplicates (different names, same structure)", () => {
  const sources = readSources([
    join(FIXTURES_DIR, "normalized-duplicate-a.ts"),
    join(FIXTURES_DIR, "normalized-duplicate-b.ts"),
  ]);
  const result = detectDuplicateBodies({
    sources,
    allowlistCross: [],
    allowlistSameFile: [],
    jaccardThreshold: JACCARD_THRESHOLD,
    minTokenCount: MIN_TOKEN_COUNT_HOSTILE,
  });
  const normalizedFindings = result.findings.filter((f) => f.passes === "normalized");
  assert.ok(normalizedFindings.length >= 2, `Pass 2 must catch the normalized duplicate (got ${normalizedFindings.length} findings)`);
});

test("no-duplicate-function-bodies (hostile): below-threshold duplicates are NOT caught (FN1 documented)", () => {
  const sources = readSources([join(FIXTURES_DIR, "below-threshold.ts")]);
  const result = detectDuplicateBodies({
    sources,
    allowlistCross: [],
    allowlistSameFile: [],
    jaccardThreshold: JACCARD_THRESHOLD,
    minTokenCount: MIN_TOKEN_COUNT_HOSTILE,
  });
  assert.equal(result.findings.length, 0, "functions below 80-char bodySize must NOT be caught (FN1)");
});

test("no-duplicate-function-bodies (hostile): allowlisted pair produces no finding (Pass 3 confirms the mirror)", () => {
  const files = [
    join(FIXTURES_DIR, "allowlisted-pair-a.ts"),
    join(FIXTURES_DIR, "allowlisted-pair-b.ts"),
  ];
  const sources = readSources(files);
  // Compute the exact hash of the duplicated function.
  const hashes = computeBodyHashes(sources);
  const target = hashes.find((h) => h.name === "hostileAllowlistedHelper");
  assert.ok(target, "hostileAllowlistedHelper function must exist in the fixture");
  const result = detectDuplicateBodies({
    sources,
    allowlistCross: [{
      hash: target.exactHash,
      fileA: sources[0]!.path,
      fileB: sources[1]!.path,
      reason: "hostile fixture allowlisted pair",
    }],
    allowlistSameFile: [],
    jaccardThreshold: JACCARD_THRESHOLD,
    minTokenCount: MIN_TOKEN_COUNT_HOSTILE,
  });
  assert.equal(result.findings.length, 0, "allowlisted pair must produce no finding");
  assert.equal(result.mirrorViolations.length, 0, "valid allowlist entry must have no drift");
});

test("no-duplicate-function-bodies (hostile): a same-file group is accepted by its COUNT, never its line numbers — lines moving above it change nothing, one fewer member makes the entry stale (WF1B3B-ALLOWLISTS)", () => {
  const helper = (name: string): string => `export function ${name}(value: string): string {
  const trimmed = value.trim();
  const lowered = trimmed.toLowerCase();
  const replaced = lowered.replace(/[^a-z0-9]+/g, "-");
  const cleaned = replaced.replace(/^-+|-+$/g, "");
  return cleaned || "fallback";
}
`;
  const file = "src/same-file-group.ts";
  const scan = (content: string, count: number) => {
    const sources = [{ path: file, content }];
    const hash = computeBodyHashes(sources).find((entry) => entry.name === "first")!.normalizedHash;
    return detectDuplicateBodies({ sources, allowlistCross: [], allowlistSameFile: [{ hash, file, count, reason: "fixture" }], jaccardThreshold: JACCARD_THRESHOLD, minTokenCount: MIN_TOKEN_COUNT_HOSTILE });
  };
  const two = `${helper("first")}${helper("second")}`;
  assert.deepEqual([scan(two, 2).findings.length, scan(two, 2).mirrorViolations.length], [0, 0]);
  const moved = `// a header grew above the group\n// and another line\n${two}`;
  assert.deepEqual([scan(moved, 2).findings.length, scan(moved, 2).mirrorViolations.length], [0, 0], "lines that moved are the same group");
  assert.match(scan(two, 3).mirrorViolations.join("\n"), /holds 2 member\(s\) there, the entry accepts 3: lower its count/u, "fewer than accepted: the debt fell");
});

test("no-duplicate-function-bodies (hostile): stale allowlist entry FAILS with a mirror violation (T7 inversion)", () => {
  const files = [
    join(FIXTURES_DIR, "allowlisted-pair-a.ts"),
    join(FIXTURES_DIR, "allowlisted-pair-b.ts"),
  ];
  const sources = readSources(files);
  const result = detectDuplicateBodies({
    sources,
    allowlistCross: [{
      hash: "0".repeat(64), // wrong hash — no clone group has this hash
      fileA: sources[0]!.path,
      fileB: sources[1]!.path,
      reason: "stale hostile fixture entry",
    }],
    allowlistSameFile: [],
    jaccardThreshold: JACCARD_THRESHOLD,
    minTokenCount: MIN_TOKEN_COUNT_HOSTILE,
  });
  assert.ok(
    result.mirrorViolations.length >= 1,
    "stale allowlist entry must produce a mirror violation (T7 inversion: stale entries FAIL, not log)",
  );
});
