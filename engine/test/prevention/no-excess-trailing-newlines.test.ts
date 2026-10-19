import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { candidateFormatForBytes } from "../../scripts/verification/candidate-format.ts";
import { experimentExclusion, walk } from "../../scripts/verification/source-walk.ts";

/**
 * Mechanical format prevention test (EXP481).
 *
 * The candidate-format check (`scripts/verification/candidate-format.ts`) is
 * the canonical authority for text-byte format violations. EXP480 found 39
 * source files ending with `\n\n` (excess-final-newline); those were fixed
 * manually one-by-one. This prevention test mechanically detects regressions
 * so a future edit can never reintroduce them, and pairs with `harness format`
 * (the one-command auto-fix) so the repair is never manual again.
 *
 * Detects (reusing the canonical detector — no duplicated logic):
 * - excess-final-newline (file ends with `\n\n` or more)
 * - missing-final-newline (file does not end with `\n`)
 * - trailing-whitespace (any line ends with spaces/tabs)
 * - carriage-return (`\r` — CRLF line endings)
 * - byte-order-mark (UTF-8 BOM)
 *
 * All `.ts` files under `src/`, `test/`, `scripts/`, `verification/` are
 * scanned. Experiment code is excluded via `shouldExcludeExperiment` (the
 * canonical opt-in/opt-out contract) so experiment scripts under
 * `scripts/exp*` do not trip the production format gate.
 */

const ROOT = process.cwd();
const SCAN_DIRS = ["src", "test", "scripts", "verification"];

function listTsFiles(dir: string, acc: string[] = []): string[] {
  for (const file of walk(dir, { exts: [".ts"], exclude: experimentExclusion(ROOT) })) {
    if (!file.endsWith(".d.ts")) acc.push(file);
  }
  return acc;
}

function allTsFiles(): string[] {
  const files: string[] = [];
  for (const dir of SCAN_DIRS) listTsFiles(join(ROOT, dir), files);
  return files.toSorted();
}

// The mechanical kinds the auto-fix (`harness format`) can repair. Other
// kinds (nul, invalid-utf8) are not auto-fixable and are left to the
// candidate-format gate; they would indicate corruption, not formatting.
const MECHANICAL_KINDS = new Set([
  "excess-final-newline",
  "missing-final-newline",
  "trailing-whitespace",
  "carriage-return",
  "byte-order-mark",
]);

test("no-excess-trailing-newlines: every.ts file has exactly one final newline and no trailing whitespace", () => {
  const files = allTsFiles();
  assert.ok(files.length > 0, "no .ts files found to scan");
  const violations: string[] = [];
  for (const file of files) {
    const bytes = readFileSync(file);
    if (bytes.length === 0) continue;
    const relativePath = relative(ROOT, file).replaceAll("\\", "/");
    const outcome = candidateFormatForBytes(relativePath, bytes, undefined);
    for (const violation of outcome.violations) {
      if (violation.startsWith("candidate-text-")) {
        const kind = violation.slice("candidate-text-".length).split(":")[0]!;
        if (MECHANICAL_KINDS.has(kind)) violations.push(violation);
      }
    }
  }
  assert.equal(
    violations.length,
    0,
    `Mechanical format violations detected in ${violations.length} file(s). ` +
      `Run \`node src/cli.ts harness format\` to auto-fix (strips trailing whitespace + ensures exactly one final newline). ` +
      `Violations:\n${violations.toSorted().join("\n")}`,
  );
});

test("no-excess-trailing-newlines (hostile): the detector flags each mechanical kind on a synthetic file", () => {
  // Confirms the prevention test would CATCH a regression, not just pass on
  // the current clean tree. Each mechanical kind is injected into a
  // synthetic source and must produce at least one violation.
  const cases: ReadonlyArray<{ name: string; bytes: Buffer; kind: string }> = [
    { name: "excess-final-newline", bytes: Buffer.from("export const x = 1;\n\n"), kind: "excess-final-newline" },
    { name: "missing-final-newline", bytes: Buffer.from("export const x = 1;"), kind: "missing-final-newline" },
    { name: "trailing-whitespace", bytes: Buffer.from("export const x = 1;   \n"), kind: "trailing-whitespace" },
    { name: "carriage-return", bytes: Buffer.from("export const x = 1;\r\n"), kind: "carriage-return" },
    { name: "byte-order-mark", bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("export const x = 1;\n")]), kind: "byte-order-mark" },
  ];
  for (const { name, bytes, kind } of cases) {
    const outcome = candidateFormatForBytes(`synthetic-${name}.ts`, bytes, undefined);
    const matched = outcome.violations.some((v) => v.includes(`candidate-text-${kind}:`));
    assert.equal(matched, true, `synthetic ${name} must be flagged as candidate-text-${kind}`);
  }
  // A clean file produces zero mechanical violations.
  const clean = candidateFormatForBytes("synthetic-clean.ts", Buffer.from("export const x = 1;\n"), undefined);
  const cleanMechanical = clean.violations.filter((v) =>
    MECHANICAL_KINDS.has(v.slice("candidate-text-".length).split(":")[0]!),
  );
  assert.equal(cleanMechanical.length, 0, "a clean file must produce zero mechanical violations");
});
