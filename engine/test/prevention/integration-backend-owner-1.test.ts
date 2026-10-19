import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { getConfigDocumentSchema } from "../../src/kernel/config-contracts.ts";
import { engineModuleSourceRelative } from "../support/module-resolver.ts";
import { experimentExclusion, walk } from "../../scripts/verification/source-walk.ts";

const CONFIG_DOCUMENT_SCHEMA = getConfigDocumentSchema();

/**
 * SPO Round 41 — Integration backend owner audit (part 1).
 *
 * Mechanical prevention test for the Single-Party-Owner principle on the
 * integration backend (`integration/src/`). Verifies:
 *
 * 1. CONFIG DOCUMENT OWNER — `src/config.ts` is the SOLE reader of the
 * `bridlewise.config.json` document. No other module reads the config
 * document directly (SPO: one owner, gates at the lowest level). The
 * basename definition owner is `src/root-policy.ts`. Any other file
 * referencing the config basename string literal in actual code (not in
 * a comment or nested string) is a bypass violation.
 *
 * 2. ERROR HIERARCHY OWNER — `src/errors.ts` is the SOLE definer of the
 * `throw new Error(...)` pattern. All thrown errors in `src/` must use
 * the typed `HarnessError` hierarchy (InputError, SecurityError, etc.)
 * so callers can distinguish error types programmatically.
 * String/comment fixtures (e.g. bug-zoo.ts source samples) are excluded.
 *
 * 3. NO SWALLOWED CATCHES — owned by the ONE shared catch classifier
 * (`scripts/verification/catch-blocks.ts`) through
 * `test/prevention/no-empty-catch-blocks.test.ts` and
 * `test/prevention/no-unhandled-errors.test.ts`, which cover all of `src/`;
 * the copy that used to live here is gone.
 *
 * 4. NO process.env CONFIG-VALUE READS — `process.env` reads outside
 * `src/config.ts` that use dot access (`process.env.KEY`) or string-literal
 * bracket access (`process.env["KEY"]`) are config-value reads that bypass
 * the config owner. Legitimate patterns (subprocess passthrough
 * `...process.env`, sentinel reads via named consts `process.env[CONST]`)
 * are allowed; config values must go through `config.ts`.
 *
 * (NO static lists): all file discovery is DYNAMIC via `readdirSync`
 * walks of `src/`. No hardcoded file lists. If a new file is added, it is
 * automatically scanned.
 */

const ROOT = process.cwd();
const SRC_ROOT = join(ROOT, "src");

// Files where the config basename / `throw new Error` are legitimate (owners).
// These are the SINGLE owners of their concern — NOT a hardcoded scan list.
// The paths are resolved from the tree (the fold moved both under kernel/).
// - config.ts: the config-document reader owner (reads the config).
// - root-policy.ts: the config basename DEFINITION owner (not a read).
const CONFIG_BASENAME_FILE_EXCEPTIONS = new Set<string>([
  join("src", "kernel", "config.ts"),
  engineModuleSourceRelative("root-policy.ts"),
]);

const THROW_NEW_ERROR_FILE_EXCEPTIONS = new Set<string>([
  engineModuleSourceRelative("kernel/errors.ts"),
]);

// ---------------------------------------------------------------------------
// String/comment detection (reused logic from no-hardcoded-success.test.ts)
// ---------------------------------------------------------------------------

function isInStringOrComment(content: string, position: number): boolean {
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;
  while (i < position) {
    const c = content[i]!;
    const n = content[i + 1];
    if (inLineComment) { if (c === "\n") inLineComment = false; i += 1; continue; }
    if (inBlockComment) { if (c === "*" && n === "/") { inBlockComment = false; i += 2; continue; } i += 1; continue; }
    if (inSingle) { if (c === "\\") { i += 2; continue; } if (c === "'") inSingle = false; i += 1; continue; }
    if (inDouble) { if (c === "\\") { i += 2; continue; } if (c === '"') inDouble = false; i += 1; continue; }
    if (inBacktick) { if (c === "\\") { i += 2; continue; } if (c === "`") inBacktick = false; i += 1; continue; }
    if (c === "/" && n === "/") { inLineComment = true; i += 2; continue; }
    if (c === "/" && n === "*") { inBlockComment = true; i += 2; continue; }
    if (c === "'") { inSingle = true; i += 1; continue; }
    if (c === '"') { inDouble = true; i += 1; continue; }
    if (c === "`") { inBacktick = true; i += 1; continue; }
    i += 1;
  }
  return inSingle || inDouble || inBacktick || inLineComment || inBlockComment;
}

// ---------------------------------------------------------------------------
// File discovery (DYNAMIC, no hardcoded lists)
// ---------------------------------------------------------------------------

function listTsFiles(dir: string, acc: string[] = []): string[] {
  for (const file of walk(dir, { exts: [".ts"], exclude: experimentExclusion(ROOT) })) {
    if (!file.endsWith(".test.ts")) acc.push(file);
  }
  return acc;
}

function allSrcFiles(): string[] {
  return listTsFiles(SRC_ROOT);
}

// ---------------------------------------------------------------------------
// Test 1: config document owner — no config basename reads outside the owners
// ---------------------------------------------------------------------------

test("R41: config document owner — no config basename string literal in code outside config.ts + root-policy.ts", () => {
  const files = allSrcFiles();
  const findings: string[] = [];
  const basenameRegex = /"bridlewise\.config\.json"|'bridlewise\.config\.json'/gu;
  for (const file of files) {
    const relPath = relative(ROOT, file);
    if (CONFIG_BASENAME_FILE_EXCEPTIONS.has(relPath)) continue;
    const content = readFileSync(file, "utf8");
    let match: RegExpExecArray | null;
    basenameRegex.lastIndex = 0;
    while ((match = basenameRegex.exec(content)) !== null) {
      if (isInStringOrComment(content, match.index)) continue;
      const lineNum = content.slice(0, match.index).split("\n").length;
      const line = content.split("\n")[lineNum - 1]!.trim();
      findings.push(
        `${relPath}:${lineNum}: ${line}\n` +
        `  Fix: route config-document reads through src/config.ts (the config owner). ` +
        `Use readConfigDocumentRawIfPresent(configDocumentPath(root)) for lightweight bootstrap reads or ` +
        `loadPinnedConfigSnapshot() for the security-verified read.\n` +
        `  Rule: config.ts is the SOLE config-document reader (SPO, ).`,
      );
    }
  }
  if (findings.length > 0) {
    assert.fail(
      `Found ${findings.length} config basename reference(s) in code outside the owners (config.ts + root-policy.ts):\n` +
      findings.join("\n"),
    );
  }
});

// ---------------------------------------------------------------------------
// Test 2: error hierarchy owner — no throw new Error outside errors.ts
// ---------------------------------------------------------------------------

test("R41: error hierarchy owner — no `throw new Error(...)` in src/ outside errors.ts", () => {
  const files = allSrcFiles();
  const findings: string[] = [];
  const throwRegex = /\bthrow\s+new\s+Error\s*\(/gu;
  for (const file of files) {
    const relPath = relative(ROOT, file);
    if (THROW_NEW_ERROR_FILE_EXCEPTIONS.has(relPath)) continue;
    const content = readFileSync(file, "utf8");
    let match: RegExpExecArray | null;
    throwRegex.lastIndex = 0;
    while ((match = throwRegex.exec(content)) !== null) {
      if (isInStringOrComment(content, match.index)) continue;
      const lineNum = content.slice(0, match.index).split("\n").length;
      const line = content.split("\n")[lineNum - 1]!.trim();
      findings.push(
        `${relPath}:${lineNum}: ${line}\n` +
        `  Fix: throw the typed HarnessError hierarchy — InputError for invalid input, ` +
        `SecurityError for security violations, HarnessError for internal invariants (src/errors.ts).\n` +
        `  Rule: all thrown errors must be typed so callers can distinguish them.`,
      );
    }
  }
  if (findings.length > 0) {
    assert.fail(
      `Found ${findings.length} \`throw new Error(...)\` in src/ outside errors.ts:\n` +
      findings.join("\n"),
    );
  }
});

// ---------------------------------------------------------------------------
// Test 4: no process.env config-value reads (dot access / string-literal bracket)
// ---------------------------------------------------------------------------

test("R41: no process.env config-value reads (dot access / string-literal bracket) outside config.ts", () => {
  // Legitimate patterns:
  // - `...process.env` (subprocess passthrough spread)
  // - `process.env[IDENTIFIER]` (sentinel read via named const)
  // - `process.env` as a default param value / reference
  // Illegitimate (config-value reads from env — should go through config.ts):
  // - `process.env.KEY` (dot access)
  // - `process.env["KEY"]` (string-literal bracket access)
  const files = allSrcFiles();
  const findings: string[] = [];
  // Dot access: process.env.KEY (uppercase identifier after the dot).
  const dotAccessRegex = /\bprocess\.env\.[A-Za-z_][A-Za-z0-9_]*/gu;
  // String-literal bracket: process.env["KEY"] or process.env['KEY'].
  const stringBracketRegex = /\bprocess\.env\[\s*["'`]/gu;
  for (const file of files) {
    const relPath = relative(ROOT, file);
    if (relPath === join("src", "kernel", "config.ts")) continue;
    const content = readFileSync(file, "utf8");
    for (const regex of [dotAccessRegex, stringBracketRegex]) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        if (isInStringOrComment(content, match.index)) continue;
        const lineNum = content.slice(0, match.index).split("\n").length;
        const line = content.split("\n")[lineNum - 1]!.trim();
        findings.push(
          `${relPath}:${lineNum}: ${line}\n` +
          `  Fix: read config values through src/config.ts (the config owner), not process.env. ` +
          `Use loadPinnedConfigSnapshot() or readConfigDocumentRaw(configDocumentPath(root)). ` +
          `For subprocess env passthrough use \`...process.env\`; for sentinels use \`process.env[NAMED_CONST]\`.\n` +
          `  Rule: config.ts is the SOLE config reader (SPO, ).`,
        );
      }
    }
  }
  if (findings.length > 0) {
    assert.fail(
      `Found ${findings.length} process.env config-value read(s) outside config.ts:\n` +
      findings.join("\n"),
    );
  }
});

// ---------------------------------------------------------------------------
// Mutation-verification: the scanner catches reintroduced violations
// ---------------------------------------------------------------------------

test("R41 scanner: catches config basename read in a non-owner file (mutant)", () => {
  const content = 'const p = join(root, "bridlewise.config.json"); readFileSync(p);';
  const basenameRegex = /"bridlewise\.config\.json"|'bridlewise\.config\.json'/gu;
  const matches: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  basenameRegex.lastIndex = 0;
  while ((m = basenameRegex.exec(content)) !== null) {
    if (!isInStringOrComment(content, m.index)) matches.push(m);
  }
  assert.ok(matches.length >= 1, "config basename string in code must be detected");
});

test("R41 scanner: catches throw new Error in a non-owner file (mutant)", () => {
  const content = 'function bad() { throw new Error("bad"); }';
  const throwRegex = /\bthrow\s+new\s+Error\s*\(/gu;
  const matches: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  throwRegex.lastIndex = 0;
  while ((m = throwRegex.exec(content)) !== null) {
    if (!isInStringOrComment(content, m.index)) matches.push(m);
  }
  assert.ok(matches.length >= 1, "throw new Error in code must be detected");
});

test("R41 scanner: allows throw new Error inside a string fixture (no false positive)", () => {
  const content = 'const fixture = `function f(): never { throw new Error("x"); return 1; }`;';
  const throwRegex = /\bthrow\s+new\s+Error\s*\(/gu;
  let m: RegExpExecArray | null;
  throwRegex.lastIndex = 0;
  let found = false;
  while ((m = throwRegex.exec(content)) !== null) {
    if (!isInStringOrComment(content, m.index)) found = true;
  }
  assert.equal(found, false, "throw new Error inside a template string fixture must NOT be flagged");
});

test("R41 scanner: catches process.env dot access (mutant)", () => {
  const content = 'const timeout = process.env.HARNESS_TIMEOUT_MS;';
  const dotAccessRegex = /\bprocess\.env\.[A-Za-z_][A-Za-z0-9_]*/gu;
  let found = false;
  dotAccessRegex.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = dotAccessRegex.exec(content)) !== null) {
    if (!isInStringOrComment(content, m.index)) found = true;
  }
  assert.ok(found, "process.env.KEY dot access must be detected");
});

test("R41 scanner: allows process.env sentinel bracket access (no false positive)", () => {
  const content = 'const raw = process.env[SENTINEL_VAR];';
  const dotAccessRegex = /\bprocess\.env\.[A-Za-z_][A-Za-z0-9_]*/gu;
  const stringBracketRegex = /\bprocess\.env\[\s*["'`]/gu;
  let found = false;
  dotAccessRegex.lastIndex = 0;
  stringBracketRegex.lastIndex = 0;
  while (dotAccessRegex.exec(content) !== null) found = true;
  while (stringBracketRegex.exec(content) !== null) found = true;
  assert.equal(found, false, "process.env[IDENTIFIER] sentinel access must NOT be flagged");
});

// ---------------------------------------------------------------------------
// Test 5: config schema covers ALL sections in the config file (no drift)
// R46: prevents the R45-F1 schema-drift bug class — config sections added to
// bridlewise.config.json but never added to the strict backend schema
// (CONFIG_DOCUMENT_SCHEMA) caused loadPinnedConfigSnapshot to throw
// config_schema_invalid in production. This test is DYNAMIC: it
// reads the ACTUAL config file + the ACTUAL schema, so a new section added to
// the config but not the schema is auto-caught. No hardcoded section list.
// ---------------------------------------------------------------------------

test("R46: CONFIG_DOCUMENT_SCHEMA accepts the actual config file (no unrecognized keys — dynamic)", () => {
  const configPath = join(ROOT, "bridlewise.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  const result = CONFIG_DOCUMENT_SCHEMA.safeParse(config);
  if (!result.success) {
    const unrecognized = result.error.issues.filter((i) => i.code === "unrecognized_keys");
    if (unrecognized.length > 0) {
      const detail = unrecognized
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.keys?.join(", ") ?? i.message}`)
        .join("; ");
      assert.fail(
        `CONFIG_DOCUMENT_SCHEMA is out of sync with bridlewise.config.json — ` +
        `${unrecognized.length} unrecognized key(s): ${detail}. ` +
        `Add the missing section(s) to the schema in src/config-contracts.ts (the config contract owner). ` +
        `The strict schema (z.strictObject) denies unknown keys by design (deny-by-default); it MUST cover every section in the config file.`,
      );
    }
    assert.fail(
      `CONFIG_DOCUMENT_SCHEMA rejected the config file (non-schema-drift failure): ` +
      result.error.issues.map((i) => `${i.path.join(".")} [${i.code}] ${i.message}`).join("; "),
    );
  }
  // Deny-by-default guard: the strict schema must not silently DROP any
  // top-level key present in the config (every config key must be a known
  // schema key). If a key is in the config but not the parsed output, the
  // schema is incomplete.
  const configKeys = Object.keys(config).sort();
  const parsedKeys = Object.keys(result.data as Record<string, unknown>).sort();
  assert.deepEqual(
    parsedKeys,
    configKeys,
    "every top-level config key must be in the parsed output (the schema must not drop any section)",
  );
});

test("R46: CONFIG_DOCUMENT_SCHEMA catches a reintroduced unknown section (mutation)", () => {
  // Simulates the R45-F1 regression: a config section added to the JSON but
  // not the schema. The strict schema must reject it as unrecognized_keys.
  const configPath = join(ROOT, "bridlewise.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  const mutant = structuredClone(config) as Record<string, unknown>;
  mutant["__unknownFutureSection__"] = { flag: true };
  const result = CONFIG_DOCUMENT_SCHEMA.safeParse(mutant);
  assert.equal(result.success, false, "an unknown top-level section must be rejected");
  const hasUnrecognized = result.error.issues.some((i) => i.code === "unrecognized_keys");
  assert.ok(hasUnrecognized, "the rejection must be an unrecognized_keys issue (not a value error)");
});

test("R46: CONFIG_DOCUMENT_SCHEMA catches a reintroduced unknown nested key (mutation)", () => {
  // Simulates the R45-F1 nested drift: a nested key added under `runtime`
  // but not the schema. The strict nested schema must reject it.
  const configPath = join(ROOT, "bridlewise.config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  const mutant = structuredClone(config) as Record<string, unknown>;
  const runtime = mutant["runtime"] as Record<string, unknown>;
  runtime["__unknownNestedKey__"] = true;
  const result = CONFIG_DOCUMENT_SCHEMA.safeParse(mutant);
  assert.equal(result.success, false, "an unknown nested key must be rejected");
  const atRuntime = result.error.issues.some(
    (i) => i.code === "unrecognized_keys" && i.path[0] === "runtime",
  );
  assert.ok(atRuntime, "the rejection must be an unrecognized_keys issue at the runtime path");
});
