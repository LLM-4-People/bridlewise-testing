import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { ARCHITECTURE_MANIFEST } from "../../src/architecture-manifest.ts";
import { experimentExclusion, walk } from "../../scripts/verification/source-walk.ts";

/**
 * D3 Test #4 — Registration procedure doc (D2).
 *
 * Asserts:
 * 1. `docs/registration-procedure.md` exists, is non-empty (>500 bytes).
 * 2. The doc contains the canonical registration steps: `moduleContract({...})`,
 * `harness sync`, `harness check`, `harness register --write`.
 * 3. Every `.ts` file under `src/` (excluding `index.ts` barrel re-exports and
 * `.d.ts` declarations) has a `moduleContract` owner in
 * `src/architecture-manifest.ts`. This closes the manifest-entry-missing
 * risk mechanically: a new `src/*.ts` file without a manifest entry fails
 * the prevention suite.
 */

const ROOT = process.cwd();
const DOC_PATH = join(ROOT, "docs", "registration-procedure.md");

test("registration-procedure-doc: docs/registration-procedure.md exists and is non-empty (>500 bytes)", () => {
  assert.equal(existsSync(DOC_PATH), true, "docs/registration-procedure.md must exist");
  const content = readFileSync(DOC_PATH, "utf8");
  assert.ok(content.length > 500, `docs/registration-procedure.md must be >500 bytes (got ${content.length})`);
});

test("registration-procedure-doc: contains the canonical registration steps", () => {
  const content = readFileSync(DOC_PATH, "utf8");
  assert.match(content, /moduleContract\(\{/, "must mention moduleContract({...})");
  assert.match(content, /harness sync/, "must mention 'harness sync'");
  assert.match(content, /harness check/, "must mention 'harness check'");
  assert.match(content, /harness register --write/, "must mention 'harness register --write'");
});

test("registration-procedure-doc: every src/**/*.ts file (excl. index.ts barrels +.d.ts) has a moduleContract owner", () => {
  // Build the set of module paths from the manifest.
  const manifestPaths = new Set<string>();
  for (const module of ARCHITECTURE_MANIFEST.modules) {
    manifestPaths.add(module.path);
  }

  // Discover all src/*.ts files (excluding index.ts barrels and.d.ts declarations).
  const srcFiles = listSrcTsFiles(join(ROOT, "src"));
  const missing: string[] = [];
  for (const file of srcFiles) {
    const rel = file.slice(ROOT.length + 1);
    const relPath = rel.replace(/\\/g, "/");
    if (!manifestPaths.has(relPath)) {
      missing.push(relPath);
    }
  }
  if (missing.length > 0) {
    assert.fail(
      `${missing.length} src/*.ts file(s) without a moduleContract owner in src/architecture-manifest.ts:\n` +
        missing.map((m) => `  ${m}`).join("\n") +
        "\nAdd a moduleContract({...}) entry per docs/registration-procedure.md.",
    );
  }
});

function listSrcTsFiles(dir: string, acc: string[] = []): string[] {
  for (const file of walk(dir, { exts: [".ts"], exclude: experimentExclusion(ROOT) })) {
    if (file.endsWith(".d.ts")) continue;
    // Exclude index.ts barrel re-exports.
    if (file.endsWith("/index.ts") && isBarrelReExport(file)) continue;
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
