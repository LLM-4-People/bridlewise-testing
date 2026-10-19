import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { experimentExclusion, walk } from "../../scripts/verification/source-walk.ts";

/**
 * Mechanical prevention: no configurable values outside the global config
 * file. One single source of truth. No default values outside config. No
 * `const FOO = 123` scattered in source files. ALL configurable values live
 * in `bridlewise.config.json` (or `root-policy.ts` for safety invariants).
 * A prevention test that scans ALL source files (harness + web UI) for
 * hardcoded configurable values outside the config.
 *
 * What counts as "configurable" (per the directive):
 * Timeouts, delays, limits, thresholds, max/min values
 * URLs, paths, ports, hostnames
 * Model IDs, provider IDs, API endpoints
 * Retry counts, backoff values, concurrency limits
 * Buffer sizes, chunk sizes, cache sizes
 * Feature flags, enable/disable toggles
 * Rate limits, quotas
 *
 * What is NOT configurable (safe to hardcode — excluded from this scan):
 * Protocol constants (HTTP methods, content types, JSON keys)
 * Error codes (typed error identifiers)
 * Schema field names, enum identifiers
 * Regex patterns for parsing (protocol, not operational)
 * Loop bounds, array indices, mathematical constants
 * Test fixture data
 *
 * Canonical owners (where configurables MAY live):
 * `src/config-contracts.ts` — the central config schema + defaults
 * `src/root-policy.ts` — non-configurable safety floor + protocol limits
 * `src/performance/performance-config.ts` — performance config fragment
 * `src/filesystem/self-protection/self-protection-config.ts` — self-protection config
 * `src/shared/debug/debug-config.ts` — debug config fragment (exp498)
 * `server/config.ts` (web UI) — server operational config (one owner)
 * `contracts/constants.ts` (web UI) — shared protocol constants
 * `*config*.ts`, `*config*.mjs` — any file named `config`
 *
 * The scanner detects `const NAME = <number>` and `const NAME = "<...>"`
 * where NAME matches configurable identifier patterns (TIMEOUT, LIMIT,
 * MAX, MIN, PORT, HOST, RETRIES, BACKOFF, INTERVAL, DELAY, BUFFER_SIZE,
 * CHUNK_SIZE, CACHE_SIZE, RATE_LIMIT, etc.) OUTSIDE the canonical owners.
 *
 * It also detects inline numeric literals in default/fallback positions
 * (`?? <num>`, `= <num>,`, `.default(<num>)`) that match configurable
 * thresholds (extending the existing duplicated-literals test to a broader configurable
 * family).
 */

const ROOT = process.cwd();

// ── Canonical owners where configurables MAY be declared ─────────────────
const CANONICAL_OWNERS = new Set<string>([
  join("src", "config-contracts.ts"),
  join("src", "root-policy.ts"),
  join("src", "requirements.ts"),
  join("src", "classification-catalog.ts"),
  join("src", "performance", "performance-config.ts"),
  join("src", "filesystem", "self-protection", "self-protection-config.ts"),
  join("src", "shared", "debug", "debug-config.ts"),
  join("server", "kernel", "config.ts"),
  join("contracts", "constants.ts"),
]);

// ── Configurable identifier patterns ─────────────────────────────────────
// A const named with these substrings is likely a configurable value that
// belongs in the config file, not scattered in source code. We match
// operational-config shapes (DEFAULT_*, *_MS, *_TIMEOUT, etc.) and exclude
// false-positive-prone substrings (PORT matches IMPORT/TRANSPORT/REPORT,
// HOST matches GHOST). Network ports are configured via env vars (config.ts).
const CONFIGURABLE_NAME_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  // R44 fix: the original `\bDEFAULT_[A-Z_]+\b` only matched when `DEFAULT_`
  // appeared at a word boundary. But `_` (underscore) IS a word char in JS
  // regex, so there is NO word boundary between `_` and `D` — names like
  // `GIT_CHURN_DEFAULT_DEPTH` (where `DEFAULT_` follows `_`) were MISSED
  // (the scattered-configurable bug class silently slipped
  // through). The anchored pattern matches the whole const name, allowing
  // `DEFAULT_` at the start OR after an `_`-terminated prefix, so
  // `GIT_CHURN_DEFAULT_DEPTH`, `DEFAULT_DEPTH`, and
  // `EMBEDDINGS_DEFAULT_BATCH_SIZE` all match, but `MYDEFAULT_FOO`
  // (where `DEFAULT` is part of a different word) does not.
  ["default", /^(?:[A-Z0-9_]*_)?DEFAULT_[A-Z0-9_]+$/u],
  ["timeout", /\b[A-Z0-9_]*TIMEOUT[A-Z0-9_]*\b/u],
  ["delay", /\b[A-Z0-9_]*DELAY[A-Z0-9_]*\b/u],
  ["interval", /\b[A-Z0-9_]*INTERVAL[A-Z0-9_]*\b/u],
  ["retries", /\b[A-Z0-9_]*RETR(Y|IES)[A-Z0-9_]*\b/u],
  ["backoff", /\b[A-Z0-9_]*BACKOFF[A-Z0-9_]*\b/u],
  ["concurrency", /\b[A-Z0-9_]*CONCURRENCY[A-Z0-9_]*\b/u],
  ["batch_size", /\b[A-Z0-9_]*BATCH_SIZE[A-Z0-9_]*\b/u],
  ["buffer_size", /\b[A-Z0-9_]*BUFFER_SIZE[A-Z0-9_]*\b/u],
  ["chunk_size", /\b[A-Z0-9_]*CHUNK_SIZE[A-Z0-9_]*\b/u],
  ["cache_size", /\b[A-Z0-9_]*CACHE_SIZE[A-Z0-9_]*\b/u],
  ["rate_limit", /\b[A-Z0-9_]*RATE_LIMIT[A-Z0-9_]*\b/u],
  ["ttl", /\b[A-Z0-9_]*TTL[A-Z0-9_]*\b/u],
  ["threshold", /\b[A-Z0-9_]*THRESHOLD[A-Z0-9_]*\b/u],
  ["max_bytes", /\b[A-Z0-9_]*MAX_BYTES[A-Z0-9_]*\b/u],
  ["max_entries", /\b[A-Z0-9_]*MAX_ENTRIES[A-Z0-9_]*\b/u],
  ["max_events", /\b[A-Z0-9_]*MAX_EVENTS[A-Z0-9_]*\b/u],
  ["quota", /\b[A-Z0-9_]*QUOTA[A-Z0-9_]*\b/u],
  ["budget", /\b[A-Z0-9_]*BUDGET[A-Z0-9_]*\b/u],
];

// Names that look configurable but are actually math/language constants.
const NON_CONFIGURABLE_NAME_EXCLUSIONS = new Set<string>([
  "MAX_SAFE", // Number.MAX_SAFE_INTEGER — math constant
  "MIN_SAFE", // Number.MIN_SAFE_INTEGER — math constant
  "MAXIMUM_SEQUENCE", // BigInt max sequence — language constant
  "MAX_VALUE", // Number.MAX_VALUE — math constant
]);

// ── Inline configurable literal positions ────────────────────────────────
// Numeric literals in these positions are likely configurable defaults
// that should come from config. The existing R6 test covers 30_000/60_000/
// 4096; this extends to configurable-threshold-shaped numbers (>= 100,
// round numbers, ms suffixes).
const INLINE_CONFIGURABLE_MS_PATTERNS: ReadonlyArray<RegExp> = [
  // `?? <num>ms` or `?? <num>_000` nullish fallback with ms-shaped values
  new RegExp("\\?\\?\\s*(?:\\d{4,6}_?000|\\d{4,6}000)(?![0-9_])", "gu"),
];

// ── File discovery ────────────────────────────────────────────────────────

function isCanonicalOwner(relPath: string): boolean {
  if (CANONICAL_OWNERS.has(relPath)) return true;
  // Any file whose basename contains "config" is a config owner.
  const base = relPath.split("/").pop() ?? "";
  if (/config/i.test(base)) return true;
  // root-policy.ts and requirements.ts are policy owners.
  if (base === "root-policy.ts" || base === "requirements.ts") return true;
  return false;
}

function listTsFiles(dir: string, acc: string[] = []): string[] {
  for (const file of walk(dir, { exts: [".ts", ".mjs"], exclude: experimentExclusion(ROOT) })) {
    if (!file.endsWith(".test.ts") && !file.endsWith(".test.mjs") && !file.endsWith(".d.ts")) acc.push(file);
  }
  return acc;
}

function allSourceFiles(roots: readonly string[]): string[] {
  const files: string[] = [];
  for (const dir of roots) {
    const fullDir = join(ROOT, dir);
    if (existsSync(fullDir)) listTsFiles(fullDir, files);
  }
  return files;
}

// ── String/comment detection (reused from no-generic-errors) ────────────

function isInStringOrComment(content: string, position: number): boolean {
  let i = 0;
  let inSingle = false, inDouble = false, inBacktick = false;
  let inLineComment = false, inBlockComment = false;
  while (i < position) {
    const c = content[i]!, n = content[i + 1];
    if (inLineComment) { if (c === "\n") inLineComment = false; i++; continue; }
    if (inBlockComment) { if (c === "*" && n === "/") { inBlockComment = false; i += 2; continue; } i++; continue; }
    if (inSingle) { if (c === "\\") { i += 2; continue; } if (c === "'") inSingle = false; i++; continue; }
    if (inDouble) { if (c === "\\") { i += 2; continue; } if (c === '"') inDouble = false; i++; continue; }
    if (inBacktick) { if (c === "\\") { i += 2; continue; } if (c === "`") inBacktick = false; i++; continue; }
    if (c === "/" && n === "/") { inLineComment = true; i += 2; continue; }
    if (c === "/" && n === "*") { inBlockComment = true; i += 2; continue; }
    if (c === "'") { inSingle = true; i++; continue; }
    if (c === '"') { inDouble = true; i++; continue; }
    if (c === "`") { inBacktick = true; i++; continue; }
    i++;
  }
  return inSingle || inDouble || inBacktick || inLineComment || inBlockComment;
}

interface Finding {
  file: string;
  line: number;
  name: string;
  value: string;
  pattern: string;
}

// ── Test 1: No scattered configurable const declarations outside owners ──

test("prevention: no scattered configurable const declarations outside canonical owners", () => {
  const SCAN_ROOTS = ["src", "scripts", "verification"];
  const files = allSourceFiles(SCAN_ROOTS);
  const findings: Finding[] = [];
  const constDeclRegex = /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::\s*[^=]+)?\s*=\s*(.+?);?\s*$/gmu;

  for (const file of files) {
    const relPath = relative(ROOT, file);
    if (isCanonicalOwner(relPath)) continue;
    const content = readFileSync(file, "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
      const match = constDeclRegex.exec(line);
      if (!match) continue;
      const name = match[1]!;
      const value = match[2]!.trim();
      // Skip math/language constants (Number.MAX_SAFE_INTEGER, BigInt max).
      if (NON_CONFIGURABLE_NAME_EXCLUSIONS.has(name)) continue;
      // Skip regex pattern declarations (protocol parsing, not operational config).
      if (/^\//.test(value) && /\/[a-z]*$/.test(value)) continue;
      // Skip BigInt literals (language constants like 9223372036854775807n).
      if (/n$/.test(value) && /^\d/.test(value)) continue;
      // Skip schema version strings (protocol identifiers, not operational config).
      if (/["'].*\/v\d+/i.test(value)) continue;
      // Skip complex config objects (deepFreeze/Object.freeze/new Set — likely owners).
      if (/^(?:deepFreeze\(\[|deepFreeze\(|Object\.freeze\(|new Set\()/.test(value)) continue;
      // Skip re-exports/imports (not fresh literals).
      if (/^(?:EDITOR_DEFAULT_LIMITS|DEFAULT_|ROOT_POLICY|CONFIG|performance|debug)/.test(value)) continue;
      // Skip non-numeric values: function refs, factory calls, strings, objects.
      // A configurable is an operational NUMBER (timeout/limit/threshold). Function
      // references (DEFAULT_CLOCK = =>...), factory calls (createPrivacyPolicy),
      // and string defaults (DEFAULT_PROFILE = "admission") are NOT numeric
      // configurables — they're behavioral defaults, not operator-tunable values.
      if (!/^\d/.test(value)) continue;
      // Skip object-literal values (e.g. `{ count: 3, backoffMs: 1000 }`).
      if (/^\{/.test(value)) continue;
      for (const [label, pattern] of CONFIGURABLE_NAME_PATTERNS) {
        if (pattern.test(name)) {
          findings.push({ file: relPath, line: i + 1, name, value, pattern: label });
          break;
        }
      }
    }
    constDeclRegex.lastIndex = 0;
  }

  if (findings.length > 0) {
    const report = findings.map((f) =>
      `  ${f.file}:${f.line} — const ${f.name} = ${f.value} (matches "${f.pattern}")\n` +
      `    Fix: move this configurable to bridlewise.config.json (or a *-config.ts canonical owner) and read it from the resolved config at every call site.`,
    ).join("\n");
    assert.fail(
      `Found ${findings.length} scattered configurable const declaration(s) outside canonical config owners:\n${report}\n` +
        `Rule: ALL configurable values (timeouts, limits, ports, retries, etc.) must live in bridlewise.config.json or a *-config.ts canonical owner (prevention rule: no-hardcoded-configurables).`,
    );
  }
});

// ── Test 2: No inline configurable ms-shaped literals in fallback positions ──

test("prevention: no inline configurable ms-shaped literals in fallback positions outside owners", () => {
  const SCAN_ROOTS = ["src"];
  const files = allSourceFiles(SCAN_ROOTS);
  const findings: Array<{ file: string; line: number; text: string }> = [];

  for (const file of files) {
    const relPath = relative(ROOT, file);
    if (isCanonicalOwner(relPath)) continue;
    const content = readFileSync(file, "utf8");
    for (const pattern of INLINE_CONFIGURABLE_MS_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        if (isInStringOrComment(content, match.index)) continue;
        const lineNum = content.slice(0, match.index).split("\n").length;
        const line = content.split("\n")[lineNum - 1]!.trim();
        if (/^\s*(?:export\s+)?const\s+[A-Z][A-Z0-9_]*\s*=/u.test(line)) continue;
        findings.push({ file: relPath, line: lineNum, text: line });
      }
    }
  }

  if (findings.length > 0) {
    const report = findings.map((f) => `  ${f.file}:${f.line}: ${f.text}`).join("\n");
    assert.fail(
      `Found ${findings.length} inline configurable ms-shaped literal(s) in fallback positions outside canonical owners:\n${report}\n` +
        `Fix: extract the value into a config field and read it from the resolved config (prevention rule: no-hardcoded-configurables).`,
    );
  }
});

// ── Test 3: DEBUG_CONFIG_DEFAULTS is declared in the canonical debug-config owner ──

test("prevention: DEBUG_CONFIG_DEFAULTS has exactly one canonical owner (debug-config.ts)", () => {
  const files = allSourceFiles(["src"]);
  const declarations: string[] = [];
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(?:export\s+)?const\s+DEBUG_CONFIG_DEFAULTS\b/u.test(lines[i]!)) {
        declarations.push(`${relative(ROOT, file)}:${i + 1}`);
      }
    }
  }
  assert.equal(
    declarations.length,
    1,
    `DEBUG_CONFIG_DEFAULTS must be declared exactly once (the canonical owner), found ${declarations.length}: ${declarations.join(", ")}. ` +
      `Fix: declare it once in src/shared/debug/debug-config.ts (prevention rule: no-hardcoded-configurables).`,
  );
  assert.ok(
    declarations[0]!.includes(join("src", "shared", "debug", "debug-config.ts")),
    `DEBUG_CONFIG_DEFAULTS canonical owner must be src/shared/debug/debug-config.ts, found: ${declarations[0]}`,
  );
});

// ── Test 4: DEBUG_CONFIG_SCHEMA composed into the central config contract ──

test("prevention: DEBUG_CONFIG_SCHEMA exists and is exported from debug-config.ts (contract)", async () => {
  const debugConfig = await import("../../src/shared/debug/debug-config.ts");
  assert.ok("DEBUG_CONFIG_SCHEMA" in debugConfig, "DEBUG_CONFIG_SCHEMA must be exported from debug-config.ts");
  assert.ok("DEBUG_CONFIG_DEFAULTS" in debugConfig, "DEBUG_CONFIG_DEFAULTS must be exported");
  assert.ok("DEBUG_CONFIG_SCHEMA_VERSION" in debugConfig, "DEBUG_CONFIG_SCHEMA_VERSION must be exported");
});

// ── Mutant tests: the scanner must catch violations ──────────────────────

test("prevention scanner: catches scattered const TIMEOUT_MS = 30000 (mutant A)", () => {
  const content = "export const REQUEST_TIMEOUT_MS = 30000;";
  const findings: string[] = [];
  const regex = /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::\s*[^=]+)?\s*=\s*(.+?);?\s*$/gmu;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    const name = m[1]!;
    for (const [, pattern] of CONFIGURABLE_NAME_PATTERNS) {
      if (pattern.test(name)) {
        findings.push(name);
        break;
      }
    }
  }
  assert.equal(findings.length, 1, "REQUEST_TIMEOUT_MS must be detected as a scattered configurable");
});

test("prevention scanner: catches scattered const MAX_RETRIES = 5 (mutant B)", () => {
  const content = "const MAX_RETRIES = 5;";
  const findings: string[] = [];
  const regex = /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::\s*[^=]+)?\s*=\s*(.+?);?\s*$/gmu;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    const name = m[1]!;
    for (const [, pattern] of CONFIGURABLE_NAME_PATTERNS) {
      if (pattern.test(name)) {
        findings.push(name);
        break;
      }
    }
  }
  assert.equal(findings.length, 1, "MAX_RETRIES must be detected as a scattered configurable");
});

test("prevention scanner: does NOT flag protocol constant const CONTENT_TYPE = 'application/json' (no false positive)", () => {
  const content = 'export const CONTENT_TYPE_JSON = "application/json";';
  let found = false;
  const regex = /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::\s*[^=]+)?\s*=\s*(.+?);?\s*$/gmu;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    const name = m[1]!;
    for (const [, pattern] of CONFIGURABLE_NAME_PATTERNS) {
      if (pattern.test(name)) {
        found = true;
        break;
      }
    }
  }
  assert.equal(found, false, "CONTENT_TYPE_JSON is a protocol constant, not a configurable");
});

test("prevention scanner: does NOT flag const SCHEMA_VERSION = 1 (no false positive — enum/protocol)", () => {
  const content = "export const SCHEMA_VERSION = 1;";
  let found = false;
  const regex = /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::\s*[^=]+)?\s*=\s*(.+?);?\s*$/gmu;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    const name = m[1]!;
    for (const [, pattern] of CONFIGURABLE_NAME_PATTERNS) {
      if (pattern.test(name)) {
        found = true;
        break;
      }
    }
  }
  assert.equal(found, false, "SCHEMA_VERSION is a protocol constant, not a configurable");
});

// R44 mutation tests: the `default` pattern must catch `*_DEFAULT_*` names
// (the original `\bDEFAULT_[A-Z_]+\b` silently missed these because `_` is
// a word char so there is no word boundary between `_` and `D`). These
// mutants pin the fix.

// The name-pattern continuation classes carry digits ([A-Z0-9_]*) — a const
// name is an uppercase run that may include digits after its first character,
// and a digit must not break the run (a config-shaped const with a digit in
// its name is still a scattered configurable). These mutants pin the widening:
// each name carries a digit inside the configurable run and must be caught.

test("prevention scanner: catches scattered const RETRY_LIMIT_3 = 5000 (digit inside the configurable run)", () => {
  const content = "export const RETRY_LIMIT_3 = 5000;";
  const findings: string[] = [];
  const regex = /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::\s*[^=]+)?\s*=\s*(.+?);?\s*$/gmu;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    const name = m[1]!;
    for (const [, pattern] of CONFIGURABLE_NAME_PATTERNS) {
      if (pattern.test(name)) {
        findings.push(name);
        break;
      }
    }
  }
  assert.equal(findings.length, 1, "RETRY_LIMIT_3 must be detected (a digit must not break the configurable run)");
  assert.equal(findings[0], "RETRY_LIMIT_3");
});

test("prevention scanner: catches scattered const CP_PASS1_TIMEOUT_MS = 5000 (digit adjacent to the keyword)", () => {
  const content = "const CP_PASS1_TIMEOUT_MS = 5000;";
  const findings: string[] = [];
  const regex = /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::\s*[^=]+)?\s*=\s*(.+?);?\s*$/gmu;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    const name = m[1]!;
    for (const [, pattern] of CONFIGURABLE_NAME_PATTERNS) {
      if (pattern.test(name)) {
        findings.push(name);
        break;
      }
    }
  }
  assert.equal(findings.length, 1, "CP_PASS1_TIMEOUT_MS must be detected (a digit must not break the configurable run)");
  assert.equal(findings[0], "CP_PASS1_TIMEOUT_MS");
});

test("prevention scanner: catches scattered const BATCH_SIZE_16 = 16 (digit after the keyword)", () => {
  const content = "const BATCH_SIZE_16 = 16;";
  const findings: string[] = [];
  const regex = /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::\s*[^=]+)?\s*=\s*(.+?);?\s*$/gmu;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    const name = m[1]!;
    for (const [, pattern] of CONFIGURABLE_NAME_PATTERNS) {
      if (pattern.test(name)) {
        findings.push(name);
        break;
      }
    }
  }
  assert.equal(findings.length, 1, "BATCH_SIZE_16 must be detected (a digit must not break the configurable run)");
  assert.equal(findings[0], "BATCH_SIZE_16");
});

test("prevention scanner: catches scattered const GIT_CHURN_DEFAULT_DEPTH = 100 (R44 mutant — _DEFAULT_ after underscore)", () => {
  const content = "const GIT_CHURN_DEFAULT_DEPTH = 100;";
  const findings: string[] = [];
  const regex = /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::\s*[^=]+)?\s*=\s*(.+?);?\s*$/gmu;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    const name = m[1]!;
    for (const [, pattern] of CONFIGURABLE_NAME_PATTERNS) {
      if (pattern.test(name)) {
        findings.push(name);
        break;
      }
    }
  }
  assert.equal(findings.length, 1, "GIT_CHURN_DEFAULT_DEPTH must be detected (the original regex missed _DEFAULT_ after underscore)");
  assert.equal(findings[0], "GIT_CHURN_DEFAULT_DEPTH");
});

test("prevention scanner: catches scattered const AL5_DEFAULT_JACCARD_THRESHOLD = 0.9 (R44 mutant — _DEFAULT_ after digit+underscore)", () => {
  const content = "const AL5_DEFAULT_JACCARD_THRESHOLD = 0.9;";
  const findings: string[] = [];
  const regex = /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::\s*[^=]+)?\s*=\s*(.+?);?\s*$/gmu;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    const name = m[1]!;
    for (const [, pattern] of CONFIGURABLE_NAME_PATTERNS) {
      if (pattern.test(name)) {
        findings.push(name);
        break;
      }
    }
  }
  assert.equal(findings.length, 1, "AL5_DEFAULT_JACCARD_THRESHOLD must be detected");
});

test("prevention scanner: does NOT flag const MYDEFAULT_FOO = 1 (no false positive — DEFAULT inside a word)", () => {
  const content = "const MYDEFAULT_FOO = 1;";
  let found = false;
  const regex = /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::\s*[^=]+)?\s*=\s*(.+?);?\s*$/gmu;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(content)) !== null) {
    const name = m[1]!;
    for (const [, pattern] of CONFIGURABLE_NAME_PATTERNS) {
      if (pattern.test(name)) {
        found = true;
        break;
      }
    }
  }
  assert.equal(found, false, "MYDEFAULT_FOO is not a `DEFAULT_` configurable (DEFAULT is part of a different word)");
});
