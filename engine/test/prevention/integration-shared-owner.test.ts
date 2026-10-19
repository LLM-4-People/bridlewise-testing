/**
 * SPO R44 — Integration Shared Subsystem Owner mechanical test.
 *
 * Scope: `integration/src/shared/` ONLY (the shared utilities directory —
 * the canonical home for reusable functions). Prior rounds (R41, R42, R43)
 * found duplicates and dead code here; R44 audits comprehensively.
 *
 * Dynamic discovery: every file list is discovered via
 * `readdirSync` — NO hardcoded lists. A new file added to `shared/` is
 * automatically covered by every check.
 *
 * Assurance classes:
 * A. Single-owner: `jaccard`, `shingles`, `sha256`, `pearson`, `median`,
 * `percentileOf`, `clamp`, `round`, `jaccardArrays`, `shinglesArray`,
 * `jaccardLenient` are each defined in exactly ONE `shared/` file
 * (the canonical owner) — no private near-duplicate bodies in
 * `shared/`.
 * B. Cross-boundary duplicate-function scan: no function with the same
 * name is defined in 2+ `shared/` files (catches drift like the
 * R41-found `jaccard` in both `similarity.ts` and `dedup.ts`).
 * C. No swallowed catches: owned by the ONE shared catch classifier through
 * `no-empty-catch-blocks` and `no-unhandled-errors`, which cover all of `src/`.
 * D. No `throw new Error(...)` / `throw new TypeError(...)` /
 * `throw new RangeError(...)` in `shared/`.
 * E. No scattered hardcoded `*_DEFAULT_*` configurable consts in
 * `shared/` outside `*-config.ts` canonical owners.
 * F. Canonical-owner pinning: `similarity.ts` is the single owner of
 * `jaccard`/`shingles`/`jaccardLenient`/`jaccardArrays`/`shinglesArray`;
 * `numeric-helpers.ts` is the single owner of `clamp`/`round`/
 * `roundKeepNonFinite`/`percentile`; `stats.ts` is the single owner
 * of `pearson`/`median`/`percentileOf`; `integrity.ts` is the single
 * owner of the general `sha256`.
 * G. Behavioral: `dedupHitRate` reflects real cross-call dedup (R44 fix
 * for the R31-V9 wired-but-inert bug where `dedupHits` was declared
 * but never incremented).
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { shouldExcludeExperiment } from "../../src/shared/source-scan.ts";
import { experimentExclusion, walk } from "../../scripts/verification/source-walk.ts";

const ROOT = process.cwd();
const SHARED_DIR = join(ROOT, "src", "shared");

// ── Dynamic file discovery ──────────

/**
 * Every source file under `dir`, experiment directories excluded.
 *
 * `extensions` defaults to `.ts` — the original behaviour — and is widened by
 * callers that must see `.mjs` too. That door exists because a duplicated
 * constant hid in a `.mjs` sibling of its `.ts` owner for as long as the scan
 * only looked at `.ts`: a universe narrowed by extension is a universe that
 * passes for free.
 */
function listTsFiles(dir: string, acc: string[] = [], extensions: readonly string[] = [".ts"]): string[] {
  for (const file of walk(dir, { exts: extensions, exclude: experimentExclusion(ROOT) })) {
    if (!file.endsWith(".test.ts") && !file.endsWith(".d.ts")) acc.push(file);
  }
  return acc;
}

function allSharedFiles(): string[] {
  return listTsFiles(SHARED_DIR);
}

function rel(file: string): string {
  return relative(ROOT, file).replaceAll("\\", "/");
}

// ── String/comment detection (so regex matches don't fire inside strings) ─

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

// ── Function-definition extraction ───────────────────────────────────────

interface FuncDef {
  name: string;
  file: string;
  line: number;
}

const FUNC_DEF_REGEX = /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gu;

function extractFunctionDefs(content: string, file: string): FuncDef[] {
  const defs: FuncDef[] = [];
  let m: RegExpExecArray | null;
  FUNC_DEF_REGEX.lastIndex = 0;
  while ((m = FUNC_DEF_REGEX.exec(content)) !== null) {
    if (isInStringOrComment(content, m.index)) continue;
    const name = m[1]!;
    const line = content.slice(0, m.index).split("\n").length;
    defs.push({ name, file, line });
  }
  return defs;
}

/**
 * Extract function definitions WITH their parameter count (arity). The
 * arity is the number of top-level parameters (split the parameter list
 * on commas at depth 0). Two functions with the same name but different
 * arity are DIFFERENT functions (not duplicates) — this filters false
 * positives like `retrieve(id)` (dedup) vs `retrieve(query, deps, options)`
 * (memory) without a static allowlist.
 */
interface FuncDefWithArity extends FuncDef {
  arity: number;
}

function extractFunctionDefsWithArity(content: string, file: string): FuncDefWithArity[] {
  const defs: FuncDefWithArity[] = [];
  let m: RegExpExecArray | null;
  FUNC_DEF_REGEX.lastIndex = 0;
  while ((m = FUNC_DEF_REGEX.exec(content)) !== null) {
    if (isInStringOrComment(content, m.index)) continue;
    const name = m[1]!;
    const line = content.slice(0, m.index).split("\n").length;
    // Find the matching `)` for the parameter list starting at m.index.
    const openParenIdx = content.indexOf("(", m.index);
    const closeParenIdx = findMatchingParen(content, openParenIdx);
    const params = closeParenIdx > 0 ? content.slice(openParenIdx + 1, closeParenIdx) : "";
    const arity = countTopLevelParams(params);
    defs.push({ name, file, line, arity });
  }
  return defs;
}

function findMatchingParen(content: string, openIndex: number): number {
  if (openIndex < 0 || content[openIndex] !== "(") return -1;
  let depth = 1;
  let i = openIndex + 1;
  let inSingle = false, inDouble = false, inBacktick = false;
  let inLineComment = false, inBlockComment = false;
  while (i < content.length) {
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
    if (c === "(" || c === "[" || c === "{") depth++;
    if (c === ")" || c === "]" || c === "}") { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
}

function countTopLevelParams(params: string): number {
  // Empty or whitespace-only → 0 params.
  const trimmed = params.trim();
  if (trimmed.length === 0) return 0;
  // Rest params and destructuring are 1 param each.
  let depth = 0;
  let count = 0;
  let sawToken = false;
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i]!;
    if (c === "(" || c === "[" || c === "{" || c === "<") depth++;
    else if (c === ")" || c === "]" || c === "}" || c === ">") depth--;
    else if (depth === 0 && c === ",") { count++; sawToken = false; continue; }
    else if (!/\s/.test(c)) sawToken = true;
  }
  if (sawToken) count++;
  return count;
}

// ── Class A: single-owner pinning ─────────────────────────────────────────

test("R44-A: canonical statistical/similarity helpers are defined in exactly ONE shared/ file", () => {
  const files = allSharedFiles();
  const expectedOwners: ReadonlyArray<readonly [string, string]> = [
    // [functionName, canonicalOwnerRelPath]
    ["jaccard", "src/shared/similarity.ts"],
    ["jaccardLenient", "src/shared/similarity.ts"],
    ["jaccardArrays", "src/shared/similarity.ts"],
    ["shingles", "src/shared/similarity.ts"],
    ["shinglesArray", "src/shared/similarity.ts"],
    ["clamp", "src/shared/numeric-helpers.ts"],
    ["round", "src/shared/numeric-helpers.ts"],
    ["roundKeepNonFinite", "src/shared/numeric-helpers.ts"],
    ["percentile", "src/shared/numeric-helpers.ts"],
    ["pearson", "src/shared/stats.ts"],
    ["median", "src/shared/stats.ts"],
    ["percentileOf", "src/shared/stats.ts"],
  ];
  const violations: string[] = [];
  for (const [fnName, ownerRel] of expectedOwners) {
    const definers: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      const defs = extractFunctionDefs(content, file);
      for (const d of defs) {
        if (d.name === fnName) definers.push(rel(file));
      }
    }
    if (definers.length === 0) {
      violations.push(`  ${fnName}: NOT DEFINED in any shared/ file (expected in ${ownerRel})`);
    } else if (definers.length > 1) {
      violations.push(`  ${fnName}: defined in ${definers.length} files: ${definers.join(", ")} (expected ONLY in ${ownerRel})`);
    } else if (definers[0] !== ownerRel) {
      violations.push(`  ${fnName}: defined in ${definers[0]} (expected in ${ownerRel})`);
    }
  }
  if (violations.length > 0) {
    assert.fail(
      `R44-A single-owner violations:\n${violations.join("\n")}\n` +
        `Fix: consolidate each function to its canonical owner.`,
    );
  }
});

// ── Class B: cross-boundary duplicate-function scan ─────────────────────

test("R44-B: no function with the SAME NAME and SAME PARAMETER COUNT is defined in 2+ shared/ files (cross-file duplicate)", () => {
  // R44: a same-name function in 2 files is a duplicate ONLY when the
  // signatures match (same parameter count). Different signatures (e.g.
  // `retrieve(id: string)` in dedup-compression vs `retrieve(query,
  // deps, options)` in memory/retrieval) are DIFFERENT functions that
  // happen to share a name — not duplicates. The parameter-count check
  // filters these false positives without a static allowlist.
  const files = allSharedFiles();
  const byKey = new Map<string, string[]>();
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    const defs = extractFunctionDefsWithArity(content, file);
    for (const d of defs) {
      const key = `${d.name}#${d.arity}`;
      const list = byKey.get(key) ?? [];
      list.push(rel(file));
      byKey.set(key, list);
    }
  }
  const duplicates: string[] = [];
  for (const [key, definers] of byKey) {
    const unique = [...new Set(definers)];
    if (unique.length > 1) {
      duplicates.push(`  ${key}: ${unique.length} files: ${unique.join(", ")}`);
    }
  }
  if (duplicates.length > 0) {
    assert.fail(
      `R44-B cross-file duplicate-function violations (same name + same arity):\n${duplicates.join("\n")}\n` +
        `Fix: consolidate to a single canonical owner.`,
    );
  }
});

// ── Class D: no throw new Error/TypeError/RangeError in shared/ ───────────

test("R44-D: no `throw new Error/TypeError/RangeError` in shared/", () => {
  const files = allSharedFiles();
  const findings: string[] = [];
  const throwRegex = /\bthrow\s+new\s+(Error|TypeError|RangeError|SyntaxError|ReferenceError)\s*\(/gu;
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    let m: RegExpExecArray | null;
    throwRegex.lastIndex = 0;
    while ((m = throwRegex.exec(content)) !== null) {
      if (isInStringOrComment(content, m.index)) continue;
      const lineNum = content.slice(0, m.index).split("\n").length;
      findings.push(`${rel(file)}:${lineNum} — throw new ${m[1]}`);
    }
  }
  if (findings.length > 0) {
    assert.fail(
      `R44-D: found ${findings.length} \`throw new <GenericError>\` in shared/:\n${findings.map(f => `  ${f}`).join("\n")}\n` +
        `Fix: use the typed HarnessError hierarchy (InputError, SecurityError, etc.) from src/errors.ts.`,
    );
  }
});

// ── Class E: no scattered *_DEFAULT_* configurables in shared/ ────────────

test("R44-E: no scattered *_DEFAULT_* configurable consts in shared/ outside *-config.ts owners", () => {
  const files = allSharedFiles();
  const findings: string[] = [];
  // Matches `const FOO_DEFAULT_BAR = <num>` or `const DEFAULT_FOO = <num>`.
  // The `_DEFAULT_` and `DEFAULT_` patterns are the configurable-default shape.
  const constRegex = /^\s*(?:export\s+)?const\s+([A-Z][A-Z0-9_]*)\s*(?::\s*[^=]+)?\s*=\s*(.+?);?\s*$/gmu;
  const defaultNameRegex = /^(?:[A-Z0-9_]*_)?DEFAULT_[A-Z_]+$/u;
  for (const file of files) {
    const fileRel = rel(file);
    // Canonical owners (files matching *config*) are exempt.
    if (/config/i.test(fileRel.split("/").pop() ?? "")) continue;
    const content = readFileSync(file, "utf8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      constRegex.lastIndex = 0;
      const m = constRegex.exec(line);
      if (!m) continue;
      const name = m[1]!;
      const value = m[2]!.trim();
      if (!defaultNameRegex.test(name)) continue;
      // Skip non-numeric (function refs, factory calls, strings, objects).
      if (!/^\d/.test(value)) continue;
      // Skip re-exports / references to other config owners (e.g. `= DEFAULT_FOO_CONFIG.bar`).
      if (/DEFAULT_.*_CONFIG\./.test(value)) continue;
      findings.push(`${fileRel}:${i + 1} — const ${name} = ${value}`);
    }
  }
  if (findings.length > 0) {
    assert.fail(
      `R44-E: found ${findings.length} scattered *_DEFAULT_* configurable const(s) in shared/:\n${findings.map(f => `  ${f}`).join("\n")}\n` +
        `Fix: move to a *-config.ts canonical owner in shared/ and read from the resolved config at every call site.`,
    );
  }
});

// ── Class F: canonical-owner pinning (behavioral import check) ───────────

test("R44-F: shared/dedup-compression/dedup.ts imports jaccardLenient from shared/similarity.ts (not a local re-definition)", () => {
  const dedupPath = join(SHARED_DIR, "dedup-compression", "dedup.ts");
  assert.ok(existsSync(dedupPath), "shared/dedup-compression/dedup.ts must exist");
  const content = readFileSync(dedupPath, "utf8");
  // Must import jaccardLenient from the canonical owner.
  assert.ok(
    /import\s+\{[^}]*\bjaccardLenient\b[^}]*\}\s*from\s*["']\.\.\/similarity\.ts["']/u.test(content),
    "dedup.ts must import jaccardLenient from shared/similarity.ts (the canonical owner)",
  );
  // Must NOT define a local `function jaccard` (the R41/R44 near-duplicate).
  assert.ok(
    !/\bfunction\s+jaccard\s*\(/u.test(content),
    "dedup.ts must NOT define a local `function jaccard` (use the canonical jaccardLenient from similarity.ts)",
  );
});

test("R44-F: shared/dedup-compression/compression.ts imports clamp from shared/numeric-helpers.ts (not a local re-definition)", () => {
  const compPath = join(SHARED_DIR, "dedup-compression", "compression.ts");
  const content = readFileSync(compPath, "utf8");
  assert.ok(
    /import\s+\{[^}]*\bclamp\b[^}]*\}\s*from\s*["']\.\.\/\.\.\/shared\/numeric-helpers\.ts["']/u.test(content),
    "compression.ts must import clamp from shared/numeric-helpers.ts (the canonical owner)",
  );
});

test("R44-F: shared/dedup-compression/shared-helpers.ts delegates sha256 to src/integrity.ts (not a local crypto re-definition)", () => {
  const helpersPath = join(SHARED_DIR, "dedup-compression", "shared-helpers.ts");
  const content = readFileSync(helpersPath, "utf8");
  assert.ok(
    /import\s+\{\s*sha256\s+as\s+integritySha256\s*\}\s*from\s*["'][../]+(?:[\w-]+\/)*integrity\.ts["']/u.test(content),
    "shared-helpers.ts must import sha256 (as integritySha256) from the integrity.ts owner (the fold moved it under kernel/)",
  );
  assert.ok(
    !/createHash\(["']sha256["']\)/u.test(content),
    "shared-helpers.ts must NOT call createHash('sha256') directly (delegate to integrity.ts)",
  );
});

test("R44-F: shared/stats.ts is the canonical owner of pearson/median/percentileOf (git-churn.ts re-exports, not defines)", () => {
  const statsPath = join(SHARED_DIR, "stats.ts");
  const gitChurnPath = join(SHARED_DIR, "git-churn.ts");
  const statsContent = readFileSync(statsPath, "utf8");
  const gitChurnContent = readFileSync(gitChurnPath, "utf8");
  // stats.ts must define all three.
  for (const fn of ["pearson", "median", "percentileOf"]) {
    assert.ok(
      new RegExp(`\\bfunction\\s+${fn}\\s*\\(`, "u").test(statsContent),
      `stats.ts must define ${fn} (the canonical owner)`,
    );
  }
  // git-churn.ts must NOT define them (re-export only).
  for (const fn of ["pearson", "median", "percentileOf"]) {
    assert.ok(
      !new RegExp(`\\bfunction\\s+${fn}\\s*\\(`, "u").test(gitChurnContent),
      `git-churn.ts must NOT define ${fn} (re-export from stats.ts, the canonical owner)`,
    );
  }
});

test("R44-F: shared/git-churn.ts has no scattered GIT_CHURN_DEFAULT_* numeric consts", () => {
  const gitChurnPath = join(SHARED_DIR, "git-churn.ts");
  assert.ok(existsSync(gitChurnPath), "shared/git-churn.ts must exist");
  const content = readFileSync(gitChurnPath, "utf8");
  const regex = /^const\s+GIT_CHURN_DEFAULT_[A-Z_]+\s*=\s*\d/gmu;
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  regex.lastIndex = 0;
  while ((m = regex.exec(content)) !== null) {
    matches.push(m[0]);
  }
  if (matches.length > 0) {
    assert.fail(
      `git-churn.ts must NOT declare scattered GIT_CHURN_DEFAULT_* numeric consts (moved to git-churn-config.ts). Found:\n${matches.map(x => `  ${x}`).join("\n")}`,
    );
  }
  // Must import from the config owner (resolveGitChurnConfig — the
  // validated accessor; DEFAULT_GIT_CHURN_CONFIG is module-private).
  assert.ok(
    /import\s+\{\s*resolveGitChurnConfig\s*\}\s*from\s*["']\.\/git-churn-config\.ts["']/u.test(content),
    "git-churn.ts must import resolveGitChurnConfig from ./git-churn-config.ts (the canonical owner)",
  );
});

// ── Class G: behavioral — dedupHitRate reflects real cross-call dedup ────

test("R44-G (behavioral): dedupHitRate is NOT hardwired to 0 (R44 fix for R31-V9 wired-but-inert bug)", async () => {
  const mod = await import("../../src/shared/dedup-compression/index.ts");
  const { DEFAULT_DEDUP_COMPRESSION_CONFIG } = await import("../../src/shared/dedup-compression/config.ts");
  const store = new mod.DedupCompressionStore({
    ...DEFAULT_DEDUP_COMPRESSION_CONFIG,
    dedupMode: "none" as const,
    compressionMode: "brotli" as const,
    llmVisibleLosslessOnly: false,
    enabled: true,
  });
  // Store the SAME content twice → second call is a cross-call dedup hit.
  const text = `function fnAlpha(x: number) { return x + 1; }`;
  store.store(text, "memory", false);
  store.store(text, "memory", false);
  const sig = mod.computeSignals(store);
  // 2 store calls, 1 dedup hit → 50% dedup hit rate (was always 0 before R44).
  assert.equal(
    sig.dedupHitRate,
    50,
    `dedupHitRate must be 50 (got ${sig.dedupHitRate}) — the R31-V9 bug had it hardwired to 0`,
  );
});

test("R44-G (behavioral): dedupHitRate is 0 when no dedup hits occur (no false positives)", async () => {
  const mod = await import("../../src/shared/dedup-compression/index.ts");
  const { DEFAULT_DEDUP_COMPRESSION_CONFIG } = await import("../../src/shared/dedup-compression/config.ts");
  const store = new mod.DedupCompressionStore({
    ...DEFAULT_DEDUP_COMPRESSION_CONFIG,
    dedupMode: "none" as const,
    compressionMode: "brotli" as const,
    llmVisibleLosslessOnly: false,
    enabled: true,
  });
  // Store DIFFERENT content → no dedup hits.
  store.store(`function fnA() { return 1; }`, "memory", false);
  store.store(`function fnB() { return 2; }`, "memory", false);
  const sig = mod.computeSignals(store);
  assert.equal(sig.dedupHitRate, 0, `dedupHitRate must be 0 with no hits (got ${sig.dedupHitRate})`);
});

// ── Mutation tests: the scanners must catch violations ───────────────────

test("R44-A scanner mutation: reintroducing a local `function jaccard` in dedup.ts makes the test fail", () => {
  // Simulate the violation: a content string with a local jaccard def.
  const mutantContent = `function jaccard(a: Set<string>, b: Set<string>): number { return 0; }`;
  const defs = extractFunctionDefs(mutantContent, "fake-mutant.ts");
  const hasJaccard = defs.some((d) => d.name === "jaccard");
  assert.ok(hasJaccard, "the scanner must detect a local `function jaccard` definition");
});

test("R44-D scanner mutation: `throw new TypeError(...)` is detected", () => {
  const mutantContent = `if (a.length !== b.length) throw new TypeError("mismatch");`;
  const throwRegex = /\bthrow\s+new\s+(Error|TypeError|RangeError|SyntaxError|ReferenceError)\s*\(/gu;
  assert.ok(throwRegex.test(mutantContent), "the scanner must detect `throw new TypeError(...)`");
});

test("R44-E scanner mutation: `const FOO_DEFAULT_BAR = 100` is detected outside a *-config.ts owner", () => {
  const name = "FOO_DEFAULT_BAR";
  const defaultNameRegex = /^(?:[A-Z0-9_]*_)?DEFAULT_[A-Z_]+$/u;
  assert.ok(defaultNameRegex.test(name), "the scanner must detect `*_DEFAULT_*` const names");
});

/**
 * ── ONE NAME, ONE DECLARATION — the `DEFAULT_*` family ────────────────────
 *
 * `DEFAULT_LOCK_TIMEOUT_MS` had two declarations with different values —
 * `src/shared/workflow/workflow-config.mjs` at 60_000 and
 * `src/workflow/workflow-config.ts` at 120_000 — and BOTH file headers said
 * "the canonical owner". The two were not even the same concept: one bounded
 * the merge script's own `O_EXCL` lock file, the other the resource lock. Two
 * meanings behind one name is worse than a duplicate, because neither value
 * is wrong and the disagreement reads as drift.
 *
 * The stated reason for the split was that a `.mjs` script "cannot import the
 * `.ts` workflow config". Driven on node 24.18.0: it can, exit 0. A runtime
 * axis had been expressed as a duplicated constant, and the axis did not
 * exist.
 *
 * Read from BYTES rather than through `grep`: a source file containing a NUL
 * is binary to GNU grep, which prints nothing and exits cleanly — a silently
 * smaller universe, which is how a count becomes wrong without failing.
 */
test("shared-owner: every exported DEFAULT_* constant is declared exactly once", () => {
  const declaration = /^\s*export\s+const\s+(DEFAULT_[A-Z0-9_]+)\s*[:=]/gmu;
  const byName = new Map<string, string[]>();
  let scanned = 0;
  for (const file of listTsFiles(join(ROOT, "src"), [], [".ts", ".mjs", ".cjs", ".js"])) {
    const relativePath = relative(ROOT, file).replaceAll("\\", "/");
    if (shouldExcludeExperiment(relativePath)) continue;
    scanned += 1;
    for (const match of readFileSync(file, "utf8").matchAll(declaration)) {
      const name = match[1]!;
      byName.set(name, [...(byName.get(name) ?? []), relativePath]);
    }
  }

  // LIVENESS — the covered population as runtime numbers. A scan that read no
  // files, or found no constants, would otherwise pass for free.
  assert.ok(scanned > 100, `only ${scanned} source files scanned`);
  assert.ok(byName.size > 20, `only ${byName.size} DEFAULT_* constants found`);

  const duplicated = duplicatedDeclarations(byName);
  assert.deepEqual(
    duplicated,
    [],
    `a DEFAULT_* constant is declared in more than one file:\n${duplicated.join("\n")}\n` +
    "Two declarations of one name are two answers to one question; widen the existing owner instead.",
  );

  // PLANT, supplied from outside and routed through the SAME function the
  // assertion above consumes. An earlier version of this plant re-implemented
  // the filter inline, so gutting the detector left the plant green — the
  // exact shape a plant exists to prevent.
  const plantedName = `DEFAULT_${scanned}_PLANTED_MS`;
  assert.deepEqual(
    duplicatedDeclarations(new Map([[plantedName, ["a/one.ts", "b/two.mjs"]]])),
    [`${plantedName}: a/one.ts, b/two.mjs`],
  );
  // And a single declaration of the same name is silent, so the verdict is
  // about the duplication rather than about the name.
  assert.deepEqual(duplicatedDeclarations(new Map([[plantedName, ["a/one.ts"]]])), []);
});

/** Names declared in more than one file, rendered `name: fileA, fileB`. */
function duplicatedDeclarations(byName: ReadonlyMap<string, readonly string[]>): readonly string[] {
  return [...byName.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([name, files]) => `${name}: ${files.join(", ")}`)
    .sort();
}
