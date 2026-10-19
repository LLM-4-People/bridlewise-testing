import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { ROOT_POLICY } from "../../../../src/kernel/root-policy.ts";
import { createTempDir } from "../../../support/temp-dir.ts";
import { walk } from "../../../../scripts/verification/source-walk.ts";

/**
 * Mechanical prevention: no scattered absolute-path literals for the Landlock
 * floor allow-set. The 6 system paths (`/usr`, `/lib`, `/etc`, `/dev`, `/proc`,
 * `/tmp`) have ONE canonical owner: `ROOT_POLICY.selfProtection.minimumAllowSet`
 * (plus `tempDir` resolved from `os.tmpdir` at runtime, never a `/tmp` literal).
 * No source file under `src/filesystem/self-protection/` may hardcode these
 * paths as string literals — they must be read from the floor. This catches a
 * future contributor re-introducing a scattered `/usr`/`/lib`/etc. literal.
 */

const SELF_PROTECTION_DIR = join(process.cwd(), "src", "filesystem", "self-protection");
const FORBIDDEN_FLOOR_PATHS = new Set(["/usr", "/lib", "/etc", "/dev", "/proc", "/tmp"]);

/** Every path the floor owns, for a cross-check that the floor is the authority. */
const FLOOR_OWNED_PATHS = new Set<string>(
  ROOT_POLICY.selfProtection.minimumAllowSet.map((entry) => entry.path),
);

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    if (entry.name.endsWith(".ts")) out.push(join(dir, entry.name));
  }
  return out;
}

function stripCommentsAndStrings(text: string, keepStrings: boolean): string {
  // Remove block + line comments so commented-out literals do not count.
  let result = text.replace(/\/\*[\s\S]*?\*\//g, "");
  result = result.replace(/\/\/[^\n]*/g, "");
  if (!keepStrings) {
    // Remove string literals (so doc-comment paths inside strings are excluded
    // when we are scanning for code literals). Keep this conservative: strip
    // double-quoted and single-quoted and backtick strings.
    result = result.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    result = result.replace(/'(?:[^'\\]|\\.)*'/g, "''");
    result = result.replace(/`(?:[^`\\]|\\.)*`/g, "``");
  }
  return result;
}

test("prevention: the floor owns the 5 system allow-set paths (not /tmp, which is runtime-resolved)", () => {
  // /usr, /lib, /etc, /dev, /proc are floor-owned (minimumAllowSet). /tmp is
  // NOT floor-owned — it is resolved from os.tmpdir at runtime, so it must
  // never appear as a literal anywhere in the module either.
  for (const p of ["/usr", "/lib", "/etc", "/dev", "/proc"]) {
    assert.equal(FLOOR_OWNED_PATHS.has(p), true, `floor must own ${p}`);
  }
  assert.equal(FLOOR_OWNED_PATHS.has("/tmp"), false, "/tmp must be runtime-resolved, not floor-owned");
});

/**
 * The main scan: reads all.ts files in a directory, strips comments/strings
 * with `keepStrings=true`, and reports any forbidden floor-path literals.
 * Extracted into a named function so the M6 end-to-end test can exercise it
 * with a temp fixture (the M6 regression tests at the bottom only call
 * `stripCommentsAndStrings` directly, bypassing the main scan).
 */
function scanDirectoryForFloorPathLiterals(dir: string): string[] {
  const files = listTsFiles(dir);
  const findings: string[] = [];
  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    const codeOnly = stripCommentsAndStrings(raw, true);
    for (const path of FORBIDDEN_FLOOR_PATHS) {
      if (codeOnly.includes(`"${path}"`) || codeOnly.includes(`'${path}'`)) {
        findings.push(`${file}: hardcoded floor-path literal ${path}`);
      }
    }
  }
  return findings;
}

test("prevention: no hardcoded floor-path literals in src/filesystem/self-protection/ source (outside comments)", () => {
  const findings = scanDirectoryForFloorPathLiterals(SELF_PROTECTION_DIR);
  if (findings.length > 0) {
    assert.fail(
      `Found ${findings.length} scattered floor-path literal(s); they must live ONLY in ROOT_POLICY.selfProtection.minimumAllowSet:\n` +
        findings.join("\n"),
    );
  }
});

test("prevention: ROOT_POLICY.selfProtection.minimumAllowSet is the single owner of the floor paths", () => {
  // The floor's paths must include exactly the 5 absolute system paths
  // (/tmp is NOT in the allow-set — it is resolved from os.tmpdir at runtime).
  assert.deepEqual(
    ROOT_POLICY.selfProtection.minimumAllowSet.map((e) => e.path),
    ["/usr", "/lib", "/etc", "/dev", "/proc"],
  );
});

test("prevention: no `new Set([...])` with the 6 floor paths scattered in the module", () => {
  const files = listTsFiles(SELF_PROTECTION_DIR);
  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    // keepStrings=true so `new Set(["/usr"...` is detectable (FINDING-C1).
    const codeOnly = stripCommentsAndStrings(raw, true);
    assert.ok(
      !codeOnly.includes('new Set(["/usr"') && !codeOnly.includes("new Set(['/usr'"),
      `${file}: must not construct a Set from scattered floor-path literals`,
    );
  }
});

/**
 * Hostile regression for M6 (Author C's mutant): a used `"/usr"` string
 * literal scattered in `guardian-binary.ts`. With `keepStrings=false` the
 * prevention test structurally cannot detect this (the literal is stripped
 * before the scan); with `keepStrings=true` (the FINDING-C1 fix) the scan
 * sees the literal and the prevention test would fail on the mutant. This
 * test asserts the fixed scanner catches the mutant, so future M6-style
 * regressions are caught.
 */
test("prevention (M6 hostile regression): a used scattered \"/usr\" literal in a mutant is detected by the fixed scanner", () => {
  // The M6 mutant: a used `const SCATTERED_USR_FALLBACK = "/usr"` plus an
  // exported function referencing it (so noUnusedLocals does not flag it).
  const mutantSource =
    `const SCATTERED_USR_FALLBACK = "/usr";\n` +
    `export function _m6ScatteredUsrFallback(): string { return SCATTERED_USR_FALLBACK; }\n`;
  const codeOnly = stripCommentsAndStrings(mutantSource, true);
  assert.ok(
    codeOnly.includes('"/usr"'),
    "keepStrings=true must preserve the scattered \"/usr\" literal so the prevention test can catch it",
  );
  // The prevention test's per-path check would flag this mutant:
  const findings: string[] = [];
  for (const path of FORBIDDEN_FLOOR_PATHS) {
    if (codeOnly.includes(`"${path}"`) || codeOnly.includes(`'${path}'`)) {
      findings.push(`mutant: hardcoded floor-path literal ${path}`);
    }
  }
  assert.ok(
    findings.some((f) => f.includes("/usr")),
    "the fixed scanner must flag the scattered /usr literal (M6 regression)",
  );
});

/**
 * Cross-check: with `keepStrings=false` (the pre-FINDING-C1 behavior), the
 * M6 mutant is NOT detected. This documents why the fix is necessary: the
 * old scanner was structurally blind to string literals.
 */
test("prevention (M6 baseline): keepStrings=false does NOT detect the scattered literal (documents the FINDING-C1 gap)", () => {
  const mutantSource =
    `const SCATTERED_USR_FALLBACK = "/usr";\n` +
    `export function _m6ScatteredUsrFallback(): string { return SCATTERED_USR_FALLBACK; }\n`;
  const codeOnly = stripCommentsAndStrings(mutantSource, false);
  assert.equal(
    codeOnly.includes('"/usr"'),
    false,
    "keepStrings=false strips the literal, so the pre-fix scanner is blind to it",
  );
});

/**
 * M6 end-to-end: the MAIN scan's `keepStrings=true` argument catches a
 * scattered `"/usr"` fixture in a temp file under the scanned directory.
 * This exercises the main scan end-to-end (not just the helper-level
 * `stripCommentsAndStrings`), proving the `keepStrings=true` fix propagates
 * through the full scan path. The M6 regression tests above only call the
 * helper directly; this test is the end-to-end guarantee.
 */
test("prevention (M6 end-to-end): the main scan catches a scattered /usr fixture in a temp file under the scanned directory", () => {
  const tempDir = createTempDir("harness-m6-e2e-");
  try {
    const tempFile = join(tempDir, "m6-fixture.ts");
    writeFileSync(
      tempFile,
      `const SCATTERED_USR_FALLBACK = "/usr";\n` +
        `export function _m6ScatteredUsrFallback(): string { return SCATTERED_USR_FALLBACK; }\n`,
      { mode: 0o600 },
    );
    const findings = scanDirectoryForFloorPathLiterals(tempDir);
    assert.ok(
      findings.some((f) => f.includes("/usr")),
      "the main scan (keepStrings=true) must catch the scattered /usr fixture end-to-end",
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

/**
 * The corpus root every large-codebase fixture must resolve through. The
 * corpus lives outside this repository and is reached ONLY through the
 * `large-codebases` symlink at the engine root, so a fixture survives the
 * corpus being relocated. An ABSOLUTE path into a developer's workspace
 * (`/home/<user>/.../large-codebases/...`) bypasses that symlink and rots the
 * moment the workspace moves — the fixture then silently `existsSync`-skips
 * and the suite reports green over a corpus it never read. Discovered
 * dynamically (recursive walk of the engine test estate), never a hardcoded
 * list: a new fixture directory is covered without an edit.
 */
function listTestSources(dir: string): string[] {
  return walk(dir, { exts: [".ts", ".mts", ".cts", ".mjs"] });
}

test("prevention: no test resolves the corpus through an absolute workspace path (only the large-codebases symlink)", () => {
  const testRoot = join(process.cwd(), "test");
  const findings: string[] = [];
  let scanned = 0;
  for (const file of listTestSources(testRoot)) {
    scanned++;
    // Read bytes (not a shell grep) so a NUL-bearing fixture is not silently
    // skipped. Strip comments only and KEEP strings: the corpus path IS a
    // string literal, so stripping strings would blank the very thing under
    // test. A path inside a comment is a mention, not a lookup, and is free.
    const raw = readFileSync(file, "utf8");
    const codeOnly = stripCommentsAndStrings(raw, true);
    if (/\/home\/[a-z0-9._-]+\/[a-z0-9._/-]*large-codebases\//i.test(codeOnly)) {
      findings.push(
        `${relative(testRoot, file)}: absolute workspace corpus path — resolve via ./large-codebases/ so a corpus relocation cannot silently skip the fixture`,
      );
    }
  }
  // Liveness witness: the scan must have actually examined a non-empty
  // population, so a wrong root cannot report a vacuous green.
  assert.ok(scanned > 0, `expected a non-empty engine test population under ${testRoot}`);
  assert.deepEqual(findings, [], `found ${findings.length} absolute corpus path(s)`);
});
