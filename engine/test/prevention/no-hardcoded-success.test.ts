import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { experimentExclusion, walk } from "../../scripts/verification/source-walk.ts";

// ---------------------------------------------------------------------------
// Mechanical prevention: no hardcoded success values, no swallowed catches.
//
// This test scans ALL.ts source files in src/, scripts/, and verification/
// (excluding.test.ts files) for two classes of defects:
//
// 1. Hardcoded boolean success values (C1/C3 class):
// Literal `true` assigned to verification/check keys (`matches`, `verified`,
// `allMatch`, `isValid`, `pass`) without a comparison or function call.
// `ok: true` is allowed in return-statement contexts (Result type
// constructors where the caller has already validated).
// Type definition lines are excluded (heuristic: `| {`, `Readonly<{`, `;`).
//
// 2. Swallowed catch blocks:
// Empty catch bodies (after stripping comments) that lack a meaningful
// explanation comment (>= 10 chars of comment text).
// Catches with a bound variable where the variable is never used and the
// body has no throw/log/return/fail are also flagged.
//
// Known acceptable exceptions are documented below.
// ---------------------------------------------------------------------------

const ROOT = process.cwd();
const SCAN_DIRS = ["src", "scripts", "verification"];

// Verification keys whose `true` must be COMPUTED, never literal.
const STRICT_KEYS = ["matches", "verified", "allMatch", "isValid", "pass"];

// `ok` is allowed in return-statement contexts (Result type constructors).
const RETURN_ALLOWED_KEYS = ["ok"];

// Files where `verified: true` is a legitimate success constructor (not a
// redaction-verification path). Each entry is a relative file path.
const VERIFIED_TRUE_FILE_EXCEPTIONS = new Set([
  "verification/core/coordination/migration-write-authority/genesis.ts",
]);

// Legitimate full identifiers whose name embeds a STRICT_KEY as a suffix and
// whose literal `true` is a plan-time declaration (not a runtime verification
// result). `clean_state_verified` in the evaluation matrix is a freshness
// property of a `fresh_execution` plan block (all sibling fields are `true`
// as const); it declares WHAT a fresh run IS, not that a check passed.
const LEGITIMATE_FULL_KEY_EXCEPTIONS = new Set([
  "clean_state_verified",
]);

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function listTsFiles(dir: string, acc: string[] = []): string[] {
  for (const file of walk(dir, { exts: [".ts"], exclude: experimentExclusion(ROOT) })) {
    if (!file.endsWith(".test.ts")) acc.push(file);
  }
  return acc;
}

function allSourceFiles(): string[] {
  const files: string[] = [];
  for (const dir of SCAN_DIRS) {
    listTsFiles(join(ROOT, dir), files);
  }
  return files;
}

// ---------------------------------------------------------------------------
// Hardcoded `true` scanner
// ---------------------------------------------------------------------------

interface TrueFinding {
  file: string;
  line: number;
  key: string;
  text: string;
  pattern: "literal" | "or-true" | "nullish-true" | "indirect";
}

function isTypeDefinitionLine(line: string): boolean {
  const trimmed = line.trim();
  // Union type member: `| { ok: true;... }` or `| Readonly<{ ok: true;... }>`
  if (/^\|\s*(Readonly<\s*)?\{/.test(trimmed)) return true;
  // Readonly wrapper: `Readonly<{ ok: true;... }>`
  if (/^Readonly<\s*\{/.test(trimmed)) return true;
  // Semicolon after `true` strongly indicates a type (TS types use `;`)
  if (/\b\w+\s*:\s*true\s*;/.test(trimmed) && !trimmed.includes("return") && !trimmed.includes("deepFreeze")) return true;
  return false;
}

function isNearReturn(lines: string[], lineIndex: number, window: number = 3): boolean {
  for (let i = lineIndex; i >= Math.max(0, lineIndex - window); i--) {
    if (/\breturn\b/.test(lines[i]!)) return true;
  }
  return false;
}

function findHardcodedTrue(content: string, filePath: string): TrueFinding[] {
  const findings: TrueFinding[] = [];
  const lines = content.split("\n");
  const relPath = relative(ROOT, filePath);
  const allKeys = [...STRICT_KEYS, ...RETURN_ALLOWED_KEYS];
  const keyPattern = allKeys.join("|");
  // `\w*` captures the full identifier ending in a success key so that
  // underscore-suffix keys like `clean_state_verified` are caught (`\b` alone
  // would not match between `_` and a keyword char, since both are word chars).
  const literalRegex = new RegExp(`\\b(\\w*(?:${keyPattern}))\\s*:\\s*true\\b`, "u");
  // `key: <expr> || true` is always truthy regardless of <expr>: a masked
  // hardcoded success value. No context exception (ok-near-return, genesis,
  // plan declaration) applies — `|| true` is always a defect.
  const orTrueRegex = new RegExp(`\\b(\\w*(?:${keyPattern}))\\s*:\\s*.+?\\|\\|\\s*true\\b`, "u");
  // `key: <expr>?? true` is truthy whenever <expr> is null/undefined: a
  // nullish-masked hardcoded success value. Like `|| true`, no context
  // exception applies — `?? true` on a success key is always a defect.
  const nullishTrueRegex = new RegExp(`\\b(\\w*(?:${keyPattern}))\\s*:\\s*.+?\\?\\?\\s*true\\b`, "u");

  // Track the absolute byte offset of each line so a per-line regex match can
  // be checked against `isInStringOrComment` (which needs the absolute offset).
  // This skips `key: true` mentions inside string literals (e.g. a detector
  // that checks `err.includes("matches: true")` — the literal is data, not a
  // hardcoded success value).
  let lineOffset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineStart = lineOffset;
    lineOffset += line.length + 1; // +1 for the `\n`
    const isType = isTypeDefinitionLine(line);

    const lit = literalRegex.exec(line);
    if (lit && !isType) {
      const absIdx = lineStart + lit.index;
      if (isInStringOrComment(content, absIdx)) continue;
      const key = lit[1]!;
      const okNearReturn = RETURN_ALLOWED_KEYS.includes(key) && isNearReturn(lines, i);
      const genesisException = key === "verified" && VERIFIED_TRUE_FILE_EXCEPTIONS.has(relPath);
      const legitimateSuffix = LEGITIMATE_FULL_KEY_EXCEPTIONS.has(key);
      if (!okNearReturn && !genesisException && !legitimateSuffix) {
        findings.push({ file: relPath, line: i + 1, key, text: line.trim(), pattern: "literal" });
        continue; // literal already flagged; skip the `|| true`/`?? true` checks for this line
      }
    }

    const orTrue = orTrueRegex.exec(line);
    if (orTrue && !isType) {
      const absIdx = lineStart + orTrue.index;
      if (isInStringOrComment(content, absIdx)) continue;
      const key = orTrue[1]!;
      // `|| true` is always a defect; no ok-near-return, genesis, or plan
      // declaration exception applies. A masked hardcode is never legitimate.
      findings.push({ file: relPath, line: i + 1, key, text: line.trim(), pattern: "or-true" });
      continue; // `|| true` and `?? true` are mutually exclusive on one line
    }

    const nullishTrue = nullishTrueRegex.exec(line);
    if (nullishTrue && !isType) {
      const absIdx = lineStart + nullishTrue.index;
      if (isInStringOrComment(content, absIdx)) continue;
      const key = nullishTrue[1]!;
      // `?? true` is always a defect on a success key; no exception applies.
      findings.push({ file: relPath, line: i + 1, key, text: line.trim(), pattern: "nullish-true" });
    }
  }
  return findings;
}

/**
 * Detect indirect hardcoded success values: `const|let <successKey> = true` or
 * `const|let <successKey> = <expr> || true` or `const|let <successKey> = <expr>?? true`,
 * where the variable is named like a success indicator and typically spread
 * into a returned object (`const ok = true; return { ok }`). A variable named
 * `ok`/`verified`/etc. assigned a literal `true` (or a `|| true` / `?? true`
 * masked truthy) is a hardcoded success value. False positives, if any arise,
 * are added to `LEGITIMATE_FULL_KEY_EXCEPTIONS`.
 */
function findIndirectHardcoded(content: string, filePath: string): TrueFinding[] {
  const findings: TrueFinding[] = [];
  const lines = content.split("\n");
  const relPath = relative(ROOT, filePath);
  const allKeys = [...STRICT_KEYS, ...RETURN_ALLOWED_KEYS];
  const keyPattern = allKeys.join("|");
  // Matches `const|let <id-ending-in-success-key> = true` OR `= <expr> || true`
  // OR `= <expr>?? true`.
  const indirectRegex = new RegExp(
    `\\b(?:const|let)\\s+(\\w*(?:${keyPattern}))\\s*=\\s*(?:.+?(?:\\|\\||\\?\\?)\\s*)?true\\b`,
    "u",
  );
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isTypeDefinitionLine(line)) continue;
    const match = indirectRegex.exec(line);
    if (!match) continue;
    const key = match[1]!;
    if (LEGITIMATE_FULL_KEY_EXCEPTIONS.has(key)) continue;
    findings.push({ file: relPath, line: i + 1, key, text: line.trim(), pattern: "indirect" });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Swallowed catch scanner
// ---------------------------------------------------------------------------

interface CatchFinding {
  file: string;
  line: number;
  variable: string | null;
  text: string;
  reason: string;
}

function findMatchingBrace(content: string, openIndex: number): number {
  let depth = 1;
  let i = openIndex + 1;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < content.length) {
    const c = content[i]!;
    const n = content[i + 1];

    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      i += 1;
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && n === "/") {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (inSingle) {
      if (c === "\\") { i += 2; continue; }
      if (c === "'") inSingle = false;
      i += 1;
      continue;
    }
    if (inDouble) {
      if (c === "\\") { i += 2; continue; }
      if (c === '"') inDouble = false;
      i += 1;
      continue;
    }
    if (inBacktick) {
      if (c === "\\") { i += 2; continue; }
      if (c === "`") inBacktick = false;
      i += 1;
      continue;
    }
    if (c === "/" && n === "/") { inLineComment = true; i += 2; continue; }
    if (c === "/" && n === "*") { inBlockComment = true; i += 2; continue; }
    if (c === "'") { inSingle = true; i += 1; continue; }
    if (c === '"') { inDouble = true; i += 1; continue; }
    if (c === "`") { inBacktick = true; i += 1; continue; }
    if (c === "{") depth += 1;
    if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

function stripComments(text: string): string {
  let result = text.replace(/\/\*[\s\S]*?\*\//g, "");
  result = result.replace(/\/\/[^\n]*/g, "");
  return result.trim();
}

function extractCommentText(text: string): string {
  const blockComments = text.match(/\/\*([\s\S]*?)\*\//g) ?? [];
  const lineComments = text.match(/\/\/([^\n]*)/g) ?? [];
  const allComments = [...blockComments, ...lineComments];
  const textContent = allComments
    .map((c) => c.replace(/\/\*|\*\/|\/\//g, ""))
    .join("")
    .trim();
  return textContent;
}

function hasErrorHandling(text: string): boolean {
  return /\bthrow\b/u.test(text)
    || /\bconsole\b/u.test(text)
    || /\bprocess\.stderr\b/u.test(text)
    || /\blog\w*\s*\(/u.test(text)
    || /\breturn\b/u.test(text)
    || /\bfail\s*\(/u.test(text)
    || /\bassert\b/u.test(text);
}

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

function findSwallowedCatches(content: string, filePath: string): CatchFinding[] {
  const findings: CatchFinding[] = [];
  const relPath = relative(ROOT, filePath);
  const catchRegex = /\bcatch\b\s*(?:\(\s*(\w+)\s*\))?\s*\{/gu;
  let match: RegExpExecArray | null;

  while ((match = catchRegex.exec(content)) !== null) {
    // Skip catch keywords inside strings or comments (e.g. test fixtures)
    if (isInStringOrComment(content, match.index)) continue;
    const variable = match[1] ?? null;
    // The last character of match[0] is the opening brace `{`
    const openBraceIdx = match.index + match[0].length - 1;
    const closeBraceIdx = findMatchingBrace(content, openBraceIdx);
    if (closeBraceIdx < 0) continue;

    const body = content.slice(openBraceIdx + 1, closeBraceIdx);
    const lineNum = content.slice(0, match.index).split("\n").length;
    const stripped = stripComments(body);

    if (stripped === "") {
      // Empty catch body — check for meaningful comment
      const commentText = extractCommentText(body);
      if (commentText.length < 10) {
        findings.push({
          file: relPath,
          line: lineNum,
          variable,
          text: content.split("\n")[lineNum - 1]!.trim(),
          reason: "empty catch body without meaningful explanation comment",
        });
      }
      continue;
    }

    // Non-empty body with bound variable: check if variable is used
    if (variable !== null) {
      if (!stripped.includes(variable) && !hasErrorHandling(stripped)) {
        findings.push({
          file: relPath,
          line: lineNum,
          variable,
          text: content.split("\n")[lineNum - 1]!.trim(),
          reason: `catch variable '${variable}' is bound but never used, and body has no error handling (throw/log/return)`,
        });
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Actionable finding formatters: every finding carries file:line, what is
// wrong, how to fix it, and the rule violated, so a failure message tells the
// reader exactly what to change without reading the scanner source.
// ---------------------------------------------------------------------------

const RULE_NO_HARDCODED_SUCCESS = "no-hardcoded-success-values";
const RULE_NO_SWALLOWED_CATCH = "no-swallowed-catch-blocks";

function formatHardcodedSuccessFinding(finding: TrueFinding): string {
  return `Found hardcoded \`${finding.key}: true\` (${finding.pattern}) at ${finding.file}:${finding.line}: ${finding.text}\n` +
    `  Fix: replace the literal with a computed comparison (e.g. \`${finding.key}: actual === expected\`) or the result of a verification call.\n` +
    `  Rule: success values must be computed, never literal (prevention rule: ${RULE_NO_HARDCODED_SUCCESS}).`;
}

function formatSwallowedCatchFinding(finding: CatchFinding): string {
  return `Found swallowed catch block at ${finding.file}:${finding.line}: ${finding.reason} — ${finding.text}\n` +
    `  Fix: rethrow the error, log it with context, or return a typed failure; an intentionally empty catch body requires an explanation comment of at least 10 characters.\n` +
    `  Rule: errors must not be silently swallowed (prevention rule: ${RULE_NO_SWALLOWED_CATCH}).`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("prevention: no hardcoded success values in source files", () => {
  const files = allSourceFiles();
  const allFindings: TrueFinding[] = [];

  for (const file of files) {
    const content = readFileSync(file, "utf8");
    allFindings.push(...findHardcodedTrue(content, file));
    allFindings.push(...findIndirectHardcoded(content, file));
  }

  if (allFindings.length > 0) {
    const report = allFindings.map(formatHardcodedSuccessFinding).join("\n");
    assert.fail(
      `Found ${allFindings.length} hardcoded success value(s):\n${report}`,
    );
  }
});

test("prevention: no swallowed catch blocks in source files", () => {
  const files = allSourceFiles();
  const allFindings: CatchFinding[] = [];

  for (const file of files) {
    const content = readFileSync(file, "utf8");
    allFindings.push(...findSwallowedCatches(content, file));
  }

  if (allFindings.length > 0) {
    const report = allFindings.map(formatSwallowedCatchFinding).join("\n");
    assert.fail(
      `Found ${allFindings.length} swallowed catch block(s):\n${report}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Scanner mutant verification: each gap described in the triple-check is
// covered by an embedded-mutant test that exercises the scanner directly.
// These do not pollute the source tree; they feed mutant strings to the
// scanner functions and assert the finding.
// ---------------------------------------------------------------------------

test("prevention scanner: catches `key: <expr> || true` masked hardcode (Mutant A)", () => {
  const content = "  verified: someCondition || true,\n";
  const findings = findHardcodedTrue(content, join(ROOT, "src", "fake-mutant-a.ts"));
  assert.equal(findings.length, 1, "expected exactly one finding");
  assert.equal(findings[0]!.pattern, "or-true");
  assert.equal(findings[0]!.key, "verified");
});

test("prevention scanner: catches `matches: a === b || true` masked hardcode", () => {
  const content = "  matches: a === b || true,\n";
  const findings = findHardcodedTrue(content, join(ROOT, "src", "fake-mutant-match.ts"));
  assert.equal(findings.length, 1, "expected exactly one finding");
  assert.equal(findings[0]!.pattern, "or-true");
  assert.equal(findings[0]!.key, "matches");
});

test("prevention scanner: catches non-excepted underscore-suffix success key (Mutant B)", () => {
  const content = "  bad_thing_verified: true,\n";
  const findings = findHardcodedTrue(content, join(ROOT, "src", "fake-mutant-b.ts"));
  assert.equal(findings.length, 1, "expected exactly one finding");
  assert.equal(findings[0]!.pattern, "literal");
  assert.equal(findings[0]!.key, "bad_thing_verified");
});

test("prevention scanner: excepts legitimate `clean_state_verified: true` plan declaration", () => {
  const content = "  clean_state_verified: true,\n";
  const findings = findHardcodedTrue(content, join(ROOT, "src", "fake-mutant-clean.ts"));
  assert.equal(findings.length, 0, "plan-declaration key must be excepted");
});

test("prevention scanner: catches indirect hardcode `const ok = true` (Mutant C)", () => {
  const content = "const ok = true;\nreturn { ok };\n";
  const findings = findIndirectHardcoded(content, join(ROOT, "src", "fake-mutant-c.ts"));
  assert.equal(findings.length, 1, "expected exactly one finding");
  assert.equal(findings[0]!.pattern, "indirect");
  assert.equal(findings[0]!.key, "ok");
});

test("prevention scanner: catches indirect masked hardcode `const verified = cond || true`", () => {
  const content = "const verified = cond || true;\n";
  const findings = findIndirectHardcoded(content, join(ROOT, "src", "fake-mutant-ind-or.ts"));
  assert.equal(findings.length, 1, "expected exactly one finding");
  assert.equal(findings[0]!.pattern, "indirect");
  assert.equal(findings[0]!.key, "verified");
});

test("prevention scanner: catches `verified: cond?? true` nullish-masked hardcode (Mutant D)", () => {
  const content = "  verified: someCondition ?? true,\n";
  const findings = findHardcodedTrue(content, join(ROOT, "src", "fake-mutant-d.ts"));
  assert.equal(findings.length, 1, "expected exactly one finding");
  assert.equal(findings[0]!.pattern, "nullish-true");
  assert.equal(findings[0]!.key, "verified");
});

test("prevention scanner: catches `matches: a === b?? true` nullish-masked hardcode", () => {
  const content = "  matches: a === b ?? true,\n";
  const findings = findHardcodedTrue(content, join(ROOT, "src", "fake-mutant-match-nullish.ts"));
  assert.equal(findings.length, 1, "expected exactly one finding");
  assert.equal(findings[0]!.pattern, "nullish-true");
  assert.equal(findings[0]!.key, "matches");
});

test("prevention scanner: catches indirect nullish-masked hardcode `const ok = cond?? true`", () => {
  const content = "const ok = cond ?? true;\n";
  const findings = findIndirectHardcoded(content, join(ROOT, "src", "fake-mutant-ind-nullish.ts"));
  assert.equal(findings.length, 1, "expected exactly one finding");
  assert.equal(findings[0]!.pattern, "indirect");
  assert.equal(findings[0]!.key, "ok");
});

test("prevention scanner: `ok: true` near return is still allowed (no false positive)", () => {
  const content = "  return { ok: true, value: 42 };\n";
  const findings = findHardcodedTrue(content, join(ROOT, "src", "fake-mutant-ok-return.ts"));
  assert.equal(findings.length, 0, "ok: true near return must be allowed");
});

test("prevention scanner: `verified: true` in genesis.ts is excepted (no false positive)", () => {
  const content = "  return deepFreeze({ verified: true, genesisIdentity });\n";
  const findings = findHardcodedTrue(
    content,
    join(ROOT, "verification", "core", "coordination", "migration-write-authority", "genesis.ts"),
  );
  assert.equal(findings.length, 0, "genesis.ts verified: true must be excepted");
});

// ---------------------------------------------------------------------------
// Finding-message contract: every finding must be actionable — file:line,
// what is wrong, how to fix it, and the rule violated.
// ---------------------------------------------------------------------------

test("prevention messages: hardcoded-success finding is actionable (file:line, fix, rule)", () => {
  const message = formatHardcodedSuccessFinding({
    file: "src/workflow/auto-generator.ts",
    line: 94,
    key: "matches",
    text: "matches: true,",
    pattern: "literal",
  });
  assert.ok(message.includes("src/workflow/auto-generator.ts:94"), "message must carry file:line");
  assert.ok(message.includes("hardcoded `matches: true`"), "message must state what is wrong");
  assert.ok(message.includes("Fix: replace the literal with a computed comparison"), "message must state how to fix it");
  assert.ok(message.includes(`Rule: success values must be computed, never literal (prevention rule: ${RULE_NO_HARDCODED_SUCCESS})`), "message must name the violated rule");
});

test("prevention messages: swallowed-catch finding is actionable (file:line, fix, rule)", () => {
  const message = formatSwallowedCatchFinding({
    file: "src/config.ts",
    line: 51,
    variable: null,
    text: "} catch {",
    reason: "empty catch body without meaningful explanation comment",
  });
  assert.ok(message.includes("src/config.ts:51"), "message must carry file:line");
  assert.ok(message.includes("empty catch body"), "message must state what is wrong");
  assert.ok(message.includes("Fix: rethrow the error"), "message must state how to fix it");
  assert.ok(message.includes(`prevention rule: ${RULE_NO_SWALLOWED_CATCH}`), "message must name the violated rule");
});
