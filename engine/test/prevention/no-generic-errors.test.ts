import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";

import { sourceViewOf } from "../../scripts/verification/source-view.ts";
import { engineModuleSourceRelative } from "../support/module-resolver.ts";
import { experimentExclusion, walk } from "../../scripts/verification/source-walk.ts";
import { committedRatchetBaseline, judgeRatchet, parseRatchetBaseline, RATCHET_SCHEMA, ratchetFailure } from "../../scripts/verification/ratchet.ts";
import { inlineLiteralDefaults, ratchetBaseline } from "../../scripts/verification/ratchet-baselines.ts";
import { InputError } from "../../src/kernel/errors.ts";
import { repositoryToplevel } from "../../src/git/repository-ownership.ts";

/**
 * Mechanical prevention: typed errors, regex dedup, stray repo-root
 * scripts, duplicated URL regex / duplicated `new Set([...])` definitions /
 * inline magic literals that should be named constants.
 *
 * Six deterministic source-scanning tests:
 *
 * 1. No `throw new Error(...)` in src/ source files (excluding src/errors.ts
 * which defines the hierarchy, and excluding template-literal fixture
 * strings such as src/quality-packs/bug-zoo.ts). All thrown errors must
 * use the typed HarnessError → InputError/SecurityError hierarchy so
 * callers can distinguish error types programmatically.
 *
 * 2. No duplicated regex literals across src/ files. The same regex pattern
 * must not be declared in 2+ files; one canonical owner per concept
 * (DRY). Catches drift such as the ISO_TIMESTAMP_PATTERN triplication
 * and the URL_PATTERN duplication.
 *
 * 3. No stray.mjs/.js/.ts files at the repository root. Source files belong
 * in src/, scripts/, test/, or verification/. A debug script with
 * hardcoded absolute paths at the repo root fails on any other machine
 * and is not referenced by tooling.
 *
 * 4. URL_PATTERN has exactly one canonical owner (src/config-contracts.ts)
 * and no duplicated URL regex patterns across src/ files.
 *
 * 5. No duplicated `new Set([...])` definitions with the same string elements
 * across src/ files; TS_EXTENSIONS and JS_EXTENSIONS must each have
 * exactly one canonical owner (src/language-extensions.ts).
 *
 * 6. No inline magic literals (4096, 30000/30_000, 60000/60_000)
 * in default/fallback positions (`?? <lit>`, `= <lit>,`/`)`,
 * `.default(<lit>)`) across src/ files. Values with cross-file consumers
 * must be named constants with one canonical owner; inline literals at
 * consumption sites drift silently (the `30_000` git inspect timeout and
 * the `4096` evaluation maxOutputTokens findings).
 */

const ROOT = process.cwd();
/** The repository top holding this engine (the committed baseline is read at `HEAD` relative to it). */
const REPOSITORY_ROOT = repositoryToplevel(ROOT, "directory") ?? dirname(ROOT);
const SRC_ROOT = join(ROOT, "src");

// Files where `throw new Error(...)` is legitimate (not a defect).
// - src/errors.ts: defines the HarnessError hierarchy and may construct
// base Error instances internally.
const THROW_NEW_ERROR_FILE_EXCEPTIONS = new Set<string>([
  join("src", "kernel/errors.ts"),
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
// File discovery
// ---------------------------------------------------------------------------

function listTsFiles(dir: string, acc: string[] = []): string[] {
  for (const file of walk(dir, { exts: [".ts", ".mjs"], exclude: experimentExclusion(ROOT) })) {
    if (!file.endsWith(".test.ts")) acc.push(file);
  }
  return acc;
}

function allSrcFiles(): string[] {
  return listTsFiles(SRC_ROOT);
}

// ---------------------------------------------------------------------------
// Test 1: No `throw new Error(...)` in src/ source files
// ---------------------------------------------------------------------------

test("prevention: no `throw new Error(...)` in src/ source files (typed errors)", () => {
  const files = allSrcFiles();
  const findings: string[] = [];
  const throwRegex = /\bthrow\s+new\s+Error\s*\(/gu;

  for (const file of files) {
    const relPath = relative(ROOT, file);
    if (THROW_NEW_ERROR_FILE_EXCEPTIONS.has(relPath)) continue;
    const content = readFileSync(file, "utf8");
    let match: RegExpExecArray | null;
    while ((match = throwRegex.exec(content)) !== null) {
      // Skip matches inside string literals or comments (e.g. fixture
      // source code embedded as string data in bug-zoo.ts).
      if (isInStringOrComment(content, match.index)) continue;
      const lineNum = content.slice(0, match.index).split("\n").length;
      const line = content.split("\n")[lineNum - 1]!.trim();
      findings.push(
        `Found \`throw new Error(...)\` at ${relPath}:${lineNum}: ${line}\n` +
        `  Fix: throw the typed HarnessError hierarchy instead — InputError for invalid input, SecurityError for security violations, HarnessError for internal invariants (src/errors.ts).\n` +
        `  Rule: all thrown errors must be typed so callers can distinguish them programmatically (prevention rule: no-generic-errors).`,
      );
    }
  }

  if (findings.length > 0) {
    assert.fail(
      `Found ${findings.length} \`throw new Error(...)\` in src/ (must use the typed HarnessError hierarchy instead):\n` +
      findings.join("\n"),
    );
  }
});

// ---------------------------------------------------------------------------
// Test 2: No duplicated regex literals across src/ files (regex dedup)
// ---------------------------------------------------------------------------

interface RegexDeclaration {
  file: string;
  line: number;
  name: string;
  pattern: string;
}

function findRegexDeclarations(content: string, filePath: string): RegexDeclaration[] {
  const declarations: RegexDeclaration[] = [];
  const lines = content.split("\n");
  const relPath = relative(ROOT, filePath);
  // Match `const <NAME> = /<pattern>/<flags>;` declarations.
  // This catches named regex constants (the form that duplicates drift).
  const regexConstRegex = /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*(\/[\s\S]+?\/[a-z]*)/u;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Skip lines inside template literals or comments (heuristic: line
    // starts with ` *` or `//` or is inside a template block). For named
    // const declarations this is a low false-positive risk.
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    const match = regexConstRegex.exec(line);
    if (!match) continue;
    const name = match[1]!;
    const pattern = match[2]!;
    // Only consider patterns that look like regex (contain regex metacharacters
    // or have regex flags) to avoid matching division expressions.
    if (!/\/[a-z]*$/u.test(pattern)) continue;
    declarations.push({ file: relPath, line: i + 1, name, pattern });
  }
  return declarations;
}

test("prevention: no duplicated timestamp/date regex patterns across src/ files (regex dedup)", () => {
  // Scan for duplicated regex patterns across source
  // files, at least for ISO_TIMESTAMP_PATTERN and similar timestamp/date
  // patterns. The general regex dedup is too noisy (pre-existing
  // identifier-pattern duplications serve different domains); this test
  // focuses on timestamp/date patterns which must have one canonical owner.
  const files = allSrcFiles();
  const byPattern = new Map<string, RegexDeclaration[]>();
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const declarations = findRegexDeclarations(content, file);
    for (const decl of declarations) {
      // Only consider patterns that look like timestamp/date regexes:
      // contain `\d{4}` (year), `\d{2}` (month/day/hour/...), and a `T` or
      // time separator. This catches ISO_TIMESTAMP_PATTERN and similar
      // date/time patterns without flagging unrelated identifier patterns.
      if (!/\\d\{4\}/u.test(decl.pattern) || !/\\d\{2\}/u.test(decl.pattern)) continue;
      const key = decl.pattern;
      const list = byPattern.get(key) ?? [];
      list.push(decl);
      byPattern.set(key, list);
    }
  }
  const duplicates: string[] = [];
  for (const [pattern, decls] of byPattern) {
    if (decls.length < 2) continue;
    const locations = decls.map((d) => `${d.file}:${d.line} (${d.name})`).join(", ");
    duplicates.push(
      `Found duplicated timestamp/date regex pattern ${pattern} declared in ${decls.length} files: ${locations}\n` +
      `  Fix: keep the declaration in its single canonical owner and import it everywhere else.\n` +
      `  Rule: one canonical owner per regex pattern — no re-declared copies that drift (prevention rule: no-duplicated-regex).`,
    );
  }
  if (duplicates.length > 0) {
    assert.fail(
      `Found ${duplicates.length} duplicated timestamp/date regex pattern(s) across src/ files:\n` +
      duplicates.join("\n"),
    );
  }
});

test("prevention: ISO_TIMESTAMP_PATTERN has exactly one canonical owner (regex dedup contract)", () => {
  // Targeted contract test: the ISO_TIMESTAMP_PATTERN must be declared in
  // exactly one file (src/extensions/extension-validation.ts) and imported
  // by every file that uses it. This catches the original triplication
  // (extension-manifest.ts, approval-workflow.ts, extension-lifecycle.ts).
  const files = allSrcFiles();
  const declarations: string[] = [];
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // Match a const declaration of ISO_TIMESTAMP_PATTERN.
      if (/^\s*(?:export\s+)?const\s+ISO_TIMESTAMP_PATTERN\s*=/u.test(line)) {
        declarations.push(`${relative(ROOT, file)}:${i + 1}`);
      }
    }
  }
  assert.equal(
    declarations.length,
    1,
    `ISO_TIMESTAMP_PATTERN must be declared in exactly one file (the canonical owner), found ${declarations.length}: ${declarations.join(", ")}. ` +
    `Fix: declare it once in src/extensions/extension-validation.ts and import it at every other use site. ` +
    `Rule: one canonical owner per regex pattern (prevention rule: no-duplicated-regex).`,
  );
  assert.ok(
    declarations[0]!.includes(join("src", "extensions", "extension-validation.ts")),
    `ISO_TIMESTAMP_PATTERN canonical owner must be src/extensions/extension-validation.ts, found: ${declarations[0]}. ` +
    `Fix: move the declaration to src/extensions/extension-validation.ts and import it elsewhere (prevention rule: no-duplicated-regex).`,
  );
});

// ---------------------------------------------------------------------------
// Test 3: No stray.mjs/.js/.ts files at the repository root (no stray root scripts)
// ---------------------------------------------------------------------------

test("prevention: no stray.mjs/.js/.ts files at the repository root (no stray root scripts)", () => {
  const allowedRootDirs = new Set([
    "src", "scripts", "test", "verification", "node_modules", "docs",
    "traceability", ".bridlewise", ".git",
  ]);
  const strayExtensions = [".mjs", ".js", ".ts"];
  const strayFiles: string[] = [];
  for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const ext = entry.name.slice(entry.name.lastIndexOf("."));
    if (!strayExtensions.includes(ext)) continue;
    // Check if the file is in an allowed directory by examining whether a
    // same-named directory exists in allowedRootDirs. Stray files at the
    // repo root (not inside any subdirectory) are flagged.
    strayFiles.push(entry.name);
  }
  // The allowed root directories are directories, not files. Any.mjs/.js/.ts
  // FILE at the repo root is a stray script (like the removed rehash-manifest.mjs).
  if (strayFiles.length > 0) {
    assert.fail(
      `Found ${strayFiles.length} stray script file(s) at the repository root:\n` +
      strayFiles.map((f) =>
        `  Found stray script at repository root: ${f}\n` +
        `    Fix: move the file into src/, scripts/, test/, or verification/ (or delete it if obsolete).\n` +
        `    Rule: source files must not live at the repository root — debug scripts with hardcoded paths fail on other machines (prevention rule: no-stray-root-scripts).`
      ).join("\n"),
    );
  }
  void allowedRootDirs;
});

// ---------------------------------------------------------------------------
// Test 4: URL_PATTERN has exactly one canonical owner (duplicated-url-regex contract)
// ---------------------------------------------------------------------------

test("prevention: URL_PATTERN has exactly one canonical owner (duplicated-url-regex contract)", () => {
  // Targeted contract test: the URL_PATTERN must be declared in exactly one
  // file (src/config-contracts.ts) and imported by every file that uses it.
  // The original duplication (a second declaration in the since-deleted
  // monolithic MCP adapter) is the shape this catches.
  const files = allSrcFiles();
  const declarations: string[] = [];
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // Match a const declaration of URL_PATTERN (exported or not).
      if (/^\s*(?:export\s+)?const\s+URL_PATTERN\s*=/u.test(line)) {
        declarations.push(`${relative(ROOT, file)}:${i + 1}`);
      }
    }
  }
  assert.equal(
    declarations.length,
    1,
    `URL_PATTERN must be declared in exactly one file (the canonical owner), found ${declarations.length}: ${declarations.join(", ")}. ` +
    `Fix: declare it once in src/config-contracts.ts and import it at every other use site. ` +
    `Rule: one canonical owner per regex pattern (prevention rule: no-duplicated-url-regex).`,
  );
  assert.ok(
    declarations[0]!.includes(engineModuleSourceRelative("config-contracts.ts")),
    `URL_PATTERN canonical owner must be ${engineModuleSourceRelative("config-contracts.ts")}, found: ${declarations[0]}. ` +
    `Fix: keep the declaration in its single canonical owner and import it elsewhere (prevention rule: no-duplicated-url-regex).`,
  );
});

test("prevention: no duplicated URL regex patterns across src/ files (duplicated-url-regex)", () => {
  // Scan for duplicated http/https URL regex patterns. The
  // `^https?:\/\/[^\s]+$` pattern (and equivalent variants) must have one
  // canonical owner. The original URL_PATTERN duplication (a second copy in
  // the since-deleted monolithic MCP adapter) is the shape this catches.
  const files = allSrcFiles();
  const byPattern = new Map<string, RegexDeclaration[]>();
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const declarations = findRegexDeclarations(content, file);
    for (const decl of declarations) {
      // Only consider patterns that look like URL regexes: contain
      // `https?` (the http/https scheme) and a `\/\/` (escaped `//`).
      if (!/https?\?/u.test(decl.pattern) || !/\\/u.test(decl.pattern)) continue;
      const key = decl.pattern;
      const list = byPattern.get(key) ?? [];
      list.push(decl);
      byPattern.set(key, list);
    }
  }
  const duplicates: string[] = [];
  for (const [pattern, decls] of byPattern) {
    if (decls.length < 2) continue;
    const locations = decls.map((d) => `${d.file}:${d.line} (${d.name})`).join(", ");
    duplicates.push(
      `Found duplicated URL regex pattern ${pattern} declared in ${decls.length} files: ${locations}\n` +
      `  Fix: keep the declaration in its single canonical owner (src/config-contracts.ts) and import it everywhere else.\n` +
      `  Rule: one canonical owner per URL regex pattern (prevention rule: no-duplicated-url-regex).`,
    );
  }
  if (duplicates.length > 0) {
    assert.fail(
      `Found ${duplicates.length} duplicated URL regex pattern(s) across src/ files:\n` +
      duplicates.join("\n"),
    );
  }
});

// ---------------------------------------------------------------------------
// Test 5: No duplicated `new Set([...])` definitions across src/ files (duplicated-set-definitions)
// ---------------------------------------------------------------------------

interface SetDeclaration {
  file: string;
  line: number;
  name: string;
  elements: string; // canonical, sorted, comma-joined element signature
  raw: string;
}

function findSetDeclarations(content: string, filePath: string): SetDeclaration[] {
  const declarations: SetDeclaration[] = [];
  const lines = content.split("\n");
  const relPath = relative(ROOT, filePath);
  // Match `const <NAME> = new Set([...])` declarations. The element list
  // may span multiple lines; this scanner handles single-line declarations
  // (the common form for short extension sets) and the start of multi-line
  // declarations by collecting until the matching `])`.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    const match = /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*:\s*ReadonlySet<string>\s*=\s*new Set\(\s*\[([\s\S]*?)\]\s*\)/u.exec(line);
    if (match) {
      const name = match[1]!;
      const elementsRaw = match[2]!;
      const elements = canonicalizeSetElements(elementsRaw);
      declarations.push({ file: relPath, line: i + 1, name, elements, raw: elementsRaw });
      continue;
    }
    // Also handle the untyped form `const <NAME> = new Set([...])`.
    const matchUntyped = /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*=\s*new Set\(\s*\[([\s\S]*?)\]\s*\)/u.exec(line);
    if (matchUntyped) {
      const name = matchUntyped[1]!;
      const elementsRaw = matchUntyped[2]!;
      // Skip non-string element sets (e.g. `new Set([1, 2, 3])`).
      if (!/["'`]/u.test(elementsRaw)) continue;
      const elements = canonicalizeSetElements(elementsRaw);
      declarations.push({ file: relPath, line: i + 1, name, elements, raw: elementsRaw });
    }
  }
  return declarations;
}

function canonicalizeSetElements(elementsRaw: string): string {
  // Extract quoted string literals from the element list and sort them so
  // sets with the same elements in different orders are treated as equal.
  const elements: string[] = [];
  const re = /["'`]([^"'`]+)["'`]/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(elementsRaw)) !== null) {
    elements.push(m[1]!);
  }
  return elements.toSorted().join(",");
}

test("prevention: no duplicated `new Set([...])` definitions across src/ files (duplicated-set-definitions)", () => {
  // Scan for `new Set([...])` declarations with the same canonical element
  // signature across src/ files. The same set of string literals must not be
  // declared in 2+ files; one canonical owner per concept (DRY). Catches the
  // original TS_EXTENSIONS / JS_EXTENSIONS duplication (syntax-validator.ts +
  // typescript-pack.ts).
  const files = allSrcFiles();
  const byElements = new Map<string, SetDeclaration[]>();
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const declarations = findSetDeclarations(content, file);
    for (const decl of declarations) {
      if (decl.elements.length === 0) continue;
      const list = byElements.get(decl.elements) ?? [];
      list.push(decl);
      byElements.set(decl.elements, list);
    }
  }
  const duplicates: string[] = [];
  for (const [elements, decls] of byElements) {
    if (decls.length < 2) continue;
    // Same file is fine (a file can re-declare with a different name); only
    // flag when 2+ different files declare the same element set.
    const uniqueFiles = new Set(decls.map((d) => d.file));
    if (uniqueFiles.size < 2) continue;
    const locations = decls.map((d) => `${d.file}:${d.line} (${d.name})`).join(", ");
    duplicates.push(
      `Found duplicated \`new Set([...])\` with elements [${elements}] declared in ${decls.length} files: ${locations}\n` +
      `  Fix: keep the set declaration in its single canonical owner (e.g. src/language-extensions.ts) and import it everywhere else.\n` +
      `  Rule: one canonical owner per string-literal set (prevention rule: no-duplicated-set-definitions).`,
    );
  }
  if (duplicates.length > 0) {
    assert.fail(
      `Found ${duplicates.length} duplicated \`new Set([...])\` definition(s) across src/ files:\n` +
      duplicates.join("\n"),
    );
  }
});

test("prevention: TS_EXTENSIONS and JS_EXTENSIONS have exactly one canonical owner (duplicated-set-definitions contract)", () => {
  // Targeted contract test: TS_EXTENSIONS and JS_EXTENSIONS must each be
  // declared in exactly one file (src/language-extensions.ts) and imported
  // by every file that uses them. This catches the original duplication
  // (editor/syntax-validator.ts + quality-packs/typescript-pack.ts).
  const files = allSrcFiles();
  const tsDeclarations: string[] = [];
  const jsDeclarations: string[] = [];
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (/^\s*(?:export\s+)?const\s+TS_EXTENSIONS\s*[:=]/u.test(line)) {
        tsDeclarations.push(`${relative(ROOT, file)}:${i + 1}`);
      }
      if (/^\s*(?:export\s+)?const\s+JS_EXTENSIONS\s*[:=]/u.test(line)) {
        jsDeclarations.push(`${relative(ROOT, file)}:${i + 1}`);
      }
    }
  }
  assert.equal(
    tsDeclarations.length,
    1,
    `TS_EXTENSIONS must be declared in exactly one file (the canonical owner), found ${tsDeclarations.length}: ${tsDeclarations.join(", ")}. ` +
    `Fix: declare it once in src/language-extensions.ts and import it at every other use site (prevention rule: no-duplicated-set-definitions).`,
  );
  assert.ok(
    tsDeclarations[0]!.includes(engineModuleSourceRelative("language-extensions.ts")),
    `TS_EXTENSIONS canonical owner must be ${engineModuleSourceRelative("language-extensions.ts")}, found: ${tsDeclarations[0]}. ` +
    `Fix: keep the declaration in its single canonical owner and import it elsewhere (prevention rule: no-duplicated-set-definitions).`,
  );
  assert.equal(
    jsDeclarations.length,
    1,
    `JS_EXTENSIONS must be declared in exactly one file (the canonical owner), found ${jsDeclarations.length}: ${jsDeclarations.join(", ")}. ` +
    `Fix: declare it once in src/language-extensions.ts and import it at every other use site (prevention rule: no-duplicated-set-definitions).`,
  );
  assert.ok(
    jsDeclarations[0]!.includes(engineModuleSourceRelative("language-extensions.ts")),
    `JS_EXTENSIONS canonical owner must be ${engineModuleSourceRelative("language-extensions.ts")}, found: ${jsDeclarations[0]}. ` +
    `Fix: keep the declaration in its single canonical owner and import it elsewhere (prevention rule: no-duplicated-set-definitions).`,
  );
});

// ---------------------------------------------------------------------------
// Test 6: No inline magic literals in default/fallback positions
// ---------------------------------------------------------------------------

// STRUCTURAL, not a denylist: any numeric literal other than the trivial
// 0 / 1 / 2 / -1 (by VALUE, in any spelling) in a default or fallback
// position is a finding (verify/a2-correctness §7 found `|| 30000`,
// `{ a = 30000 }`, `?? (30000)`, `?? +30000`, `0x7530`, `30000n`, `30000.` and
// `.catch(30000)` passing). The SCAN lives with its baseline's generator
// (`scripts/verification/ratchet-baselines.ts`, a2b-design H2): this guard and
// `harness sync`'s prune run the same function, so the baseline's keys are
// never typed by hand. The remaining debt is a SHRINK-ONLY RATCHET: every
// entry carries its reason, a new site fails, a stale entry fails (sync
// removes it), and an entry the committed baseline does not hold fails.
const INLINE_LITERAL_RATCHET = ratchetBaseline("inline-literal-defaults");

test("prevention: no inline magic literals in default/fallback positions across src/ files", () => {
  const baselinePath = INLINE_LITERAL_RATCHET.path;
  const baseline = parseRatchetBaseline(readFileSync(join(REPOSITORY_ROOT, baselinePath), "utf8"), baselinePath);
  const findings = INLINE_LITERAL_RATCHET.findings(REPOSITORY_ROOT);
  const keys = findings.map((finding) => finding.key);
  const where = new Map(findings.map((finding) => [finding.key, finding.where]));
  const verdict = judgeRatchet(keys, baseline, committedRatchetBaseline(REPOSITORY_ROOT, INLINE_LITERAL_RATCHET.id));
  const failure = ratchetFailure(baselinePath, {
    ...verdict,
    unbaselined: verdict.unbaselined.map((key) => `${where.get(key) ?? key} — ${key.slice(key.indexOf(": ") + 2)}`),
  });
  assert.equal(
    failure,
    undefined,
    `${failure ?? ""}\n  Fix: give the value one named owner (a DEFAULT_* constant or the module's frozen defaults object, e.g. DEFAULT_GIT_INSPECT_TIMEOUT_MS, DEFAULT_TIMELINE_QUERY_LIMIT) and import it here.\n` +
      `  Rule: values consumed across files must be named constants, not inline literals at consumption sites (prevention rule: no-inline-magic-literals).`,
  );
});

test("prevention scanner: inline literal defaults are found structurally, named owners and prose are not", () => {
  const texts = (content: string) => inlineLiteralDefaults(sourceViewOf(content, "probe.ts")).map((finding) => finding.text);
  assert.equal(texts("const a = options.limit ?? 8_388_608;").length, 1, "nullish fallback");
  assert.equal(texts("function f(timeoutMs = 5000) {}").length, 1, "parameter default");
  assert.equal(texts("const s = z.number().default(65_536);").length, 1, "schema default");
  assert.equal(texts("const r = x ?? 0.85;").length, 1, "a fractional literal is not trivial");
  assert.deepEqual(texts("const a = b ?? 0; function g(n = 1, m = -1) {} z.number().default(2);"), [], "0, 1, 2 and -1 are trivial");
  assert.deepEqual(texts("export const DEFAULT_LIMIT = 4096;\nconst b = x ?? DEFAULT_LIMIT;"), [], "the named owner is the fix");
  assert.deepEqual(texts('// fallback ?? 30_000\nconst s = "?? 60_000";'), [], "comments and strings are prose");
  assert.deepEqual(texts("if (a === 5) {} for (let k = 0; k < 9; k += 4) {}"), [], "comparisons and compound assignment are not defaults");
  // verify/a2-correctness §7: every spelling the old detector missed.
  for (const [label, content] of [
    ["logical-or fallback", "const t = o.timeout || 30000;"],
    ["destructuring default", "const { timeout = 30000 } = options;"],
    ["parenthesized", "const t = o.t ?? (30000);"],
    ["unary plus", "const t = o.t ?? +30000;"],
    ["hex", "const t = o.t ?? 0x7530;"],
    ["bigint", "const t = o.t ?? 30000n;"],
    ["trailing dot", "const t = o.t ?? 30000.;"],
    ["zod catch", "const s = z.number().catch(30000);"],
    ["fallback in an UPPER_CASE constant", "const TIMEOUT = o.t ?? 30000;"],
  ] as const) {
    assert.equal(texts(content).length, 1, label);
  }
  assert.deepEqual(texts("const t = o.t ?? 0x1; const u = o.u || 2n; const { v = +0 } = w;"), [], "a trivial value is trivial in every spelling");
});

test("prevention scanner: the literal baseline is a shrink-only ratchet — a self-added entry, a new site and a stale entry each fail", () => {
  const entry = (key: string) => ({ key, reason: "fixture debt (tracker FIXTURE-1)" });
  const baseline = (...keys: string[]) => ({ schema: RATCHET_SCHEMA, entries: keys.map(entry) });
  const committed = baseline("src/a.ts: x ?? 30", "src/a.ts: x ?? 30");
  // The gaming the verifier reproduced: the offending line appended to the
  // baseline next to the new site. The tree agrees with the list; the
  // committed list does not.
  const gamed = judgeRatchet(["src/a.ts: x ?? 30", "src/a.ts: x ?? 30", "src/b.ts: y ?? 12345"],
    baseline("src/a.ts: x ?? 30", "src/a.ts: x ?? 30", "src/b.ts: y ?? 12345"), committed);
  assert.deepEqual(gamed.grown, ["src/b.ts: y ?? 12345"]);
  assert.deepEqual(judgeRatchet(["src/a.ts: x ?? 30", "src/a.ts: x ?? 30", "src/b.ts: y ?? 12345"], committed, committed).unbaselined, ["src/b.ts: y ?? 12345"]);
  assert.deepEqual(judgeRatchet(["src/a.ts: x ?? 30"], committed, committed).stale, ["src/a.ts: x ?? 30"], "a multiset: one of two fixed");
  const shrunk = judgeRatchet(["src/a.ts: x ?? 30"], baseline("src/a.ts: x ?? 30"), committed);
  assert.deepEqual([shrunk.unbaselined, shrunk.stale, shrunk.grown], [[], [], []], "shrinking is always allowed");
  assert.deepEqual(judgeRatchet(["k"], baseline("k"), undefined).grown, [], "a baseline HEAD does not hold yet is being introduced");
  assert.throws(() => parseRatchetBaseline(JSON.stringify({ schema: RATCHET_SCHEMA, entries: [{ key: "k", reason: " " }] }), "fixture.json"),
    (error: unknown) => error instanceof InputError && error.code === "ratchet_baseline_unjustified");
  assert.throws(() => parseRatchetBaseline(JSON.stringify({ "src/a.ts": ["x ?? 30"] }), "fixture.json"),
    (error: unknown) => error instanceof InputError && error.code === "ratchet_baseline_invalid", "the old reason-less map is refused");
});
