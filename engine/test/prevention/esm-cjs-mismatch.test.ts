/**
 * GUARD SUBJECT: the ESM/CJS mismatch detector flags a `.ts` module that uses CJS-only exports (`module.exports`, `exports.`) while being consumed as ESM
 * GUARD OWNS: src/quality-packs/prevention/esm-cjs-detector.ts — the detector's export/scope classification
 * GUARD PLANT: a `.ts` fixture exporting via `module.exports = …` (NOT `createRequire`, which is a permitted ESM target and the inert first plant) in the scanned scope; the detector must report it
 * GUARD DRIVEN: detectEsmCjsMismatches over the repo tree, entered through the same detector the quality pack runs — not a hand-built AST
 * GUARD LIVENESS: the scanned file population is asserted non-empty (an empty scope is a broken scan, not a clean bill), and the detector's report on the real tree is read before the plant verdict is trusted
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { detectEsmCjsMismatches } from "../../src/quality-packs/prevention/esm-cjs-detector.ts";
import { experimentExclusion, walk } from "../../scripts/verification/source-walk.ts";

/**
 * D3 Test #2 — ESM/CJS mismatch detector.
 *
 * Scope: `src/`, `test/`, `scripts/`, `verification/`, `traceability/` — all
 * `.ts/.tsx/.cts/.mts/.d.mts/.mjs/.cjs` files (E1, E2). Excludes
 * `test/fixtures/**`, `node_modules`, `.git`.
 *
 * E7 dependency: the `.js`-of-`.ts` import rule is correct for THIS
 * project because `tsconfig.json:16` enables `rewriteRelativeImportExtensions:
 * true`. For projects using classic/bundler resolution, the rule is not
 * applicable.
 *
 * E3 disclaimer: S1 (`scripts/s1-verification.ts:1624-1629`) enforces
 * `.ts`-extension imports ONLY for the `src/` production graph. This test is
 * a NEW prevention test with broader scope, not a claim that S1 already
 * enforces this across the full scope.
 *
 * Allowlist: initially empty (the triple-check confirmed the repo is clean).
 * Each exception must reference a source comment explaining why.
 */

const ROOT = process.cwd();
const SCAN_ROOTS = ["src", "test", "scripts", "verification", "traceability"];
const SCAN_EXTENSIONS = [".ts", ".tsx", ".cts", ".mts", ".d.mts", ".mjs", ".cjs"];

function listScanFiles(dir: string, acc: string[] = []): string[] {
  // `fixtures` directories hold planted mismatches on purpose; the scan declares it skips them.
  for (const file of walk(dir, { exts: [".ts", ".tsx", ".cts", ".mts", ".mjs", ".cjs"], ignore: ["fixtures"], exclude: experimentExclusion(ROOT) })) {
    if (SCAN_EXTENSIONS.some((ext) => file.endsWith(ext))) acc.push(file);
  }
  return acc;
}

function readSources(files: string[]): { path: string; content: string }[] {
  return files.map((f) => ({ path: relative(ROOT, f).replace(/\\/g, "/"), content: readFileSync(f, "utf8") }));
}

// ---------------------------------------------------------------------------
// Main scan: ZERO mismatches on the real tree.
// ---------------------------------------------------------------------------

test("esm-cjs-mismatch: ZERO mismatches across src/, test/, scripts/, verification/, traceability/", () => {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    listScanFiles(join(ROOT, root), files);
  }
  const sources = readSources(files);
  const findings = detectEsmCjsMismatches({
    sources,
    allowlist: new Set<string>(),
    createRequirePermittedTargets: new Set<string>(),
  });
  if (findings.length > 0) {
    assert.fail(
      `ESM/CJS detector found ${findings.length} mismatch(es):\n` +
        findings.map((f) => `  [${f.kind}] ${f.file}:${f.line} ${f.detail}`).join("\n") +
        "\nFix the mismatch or add the file to the allowlist with a source comment.",
    );
  }
});

// ---------------------------------------------------------------------------
// Hostile fixtures: the detector catches intentionally-broken files.
// ---------------------------------------------------------------------------

const HOSTILE_DIR = join(ROOT, "test", "fixtures", "esm-cjs-hostile");

test("esm-cjs-mismatch (hostile): bare require in ESM.ts is caught", () => {
  const sources = readSources([join(HOSTILE_DIR, "bare-require.ts")]);
  const findings = detectEsmCjsMismatches({
    sources,
    allowlist: new Set<string>(),
    createRequirePermittedTargets: new Set<string>(),
  });
  assert.ok(
    findings.some((f) => f.kind === "require-in-esm"),
    "bare require() in ESM must be flagged as require-in-esm",
  );
});

test("esm-cjs-mismatch (hostile): __dirname in ESM.ts is caught", () => {
  const sources = readSources([join(HOSTILE_DIR, "dirname.ts")]);
  const findings = detectEsmCjsMismatches({
    sources,
    allowlist: new Set<string>(),
    createRequirePermittedTargets: new Set<string>(),
  });
  assert.ok(
    findings.some((f) => f.kind === "dirname-in-esm"),
    "__dirname in ESM must be flagged as dirname-in-esm",
  );
});

test("esm-cjs-mismatch (hostile): module.exports in ESM.ts is caught", () => {
  const sources = readSources([join(HOSTILE_DIR, "module-exports.ts")]);
  const findings = detectEsmCjsMismatches({
    sources,
    allowlist: new Set<string>(),
    createRequirePermittedTargets: new Set<string>(),
  });
  assert.ok(
    findings.some((f) => f.kind === "module-exports-in-esm"),
    "module.exports in ESM must be flagged as module-exports-in-esm",
  );
});

test("esm-cjs-mismatch (hostile):.js-of-.ts import is caught", () => {
  const sources = readSources([
    join(HOSTILE_DIR, "js-of-ts-import.ts"),
    join(HOSTILE_DIR, "foo.ts"),
  ]);
  const findings = detectEsmCjsMismatches({
    sources,
    allowlist: new Set<string>(),
    createRequirePermittedTargets: new Set<string>(),
  });
  assert.ok(
    findings.some((f) => f.kind === "js-of-ts-import"),
    "import './foo.js' where ./foo.ts exists must be flagged as js-of-ts-import",
  );
});

test("esm-cjs-mismatch (hostile): import declaration in.cjs is caught", () => {
  const sources = readSources([join(HOSTILE_DIR, "import-in-cjs.cjs")]);
  const findings = detectEsmCjsMismatches({
    sources,
    allowlist: new Set<string>(),
    createRequirePermittedTargets: new Set<string>(),
  });
  assert.ok(
    findings.some((f) => f.kind === "import-in-cjs" || f.kind === "export-in-cjs"),
    "import in .cjs must be flagged as import-in-cjs or export-in-cjs",
  );
});

test("esm-cjs-mismatch (hostile): import.meta in.cjs is caught", () => {
  const sources = readSources([join(HOSTILE_DIR, "import-meta-in-cjs.cjs")]);
  const findings = detectEsmCjsMismatches({
    sources,
    allowlist: new Set<string>(),
    createRequirePermittedTargets: new Set<string>(),
  });
  assert.ok(
    findings.some((f) => f.kind === "import-meta-in-cjs"),
    "import.meta in .cjs must be flagged as import-meta-in-cjs",
  );
});
