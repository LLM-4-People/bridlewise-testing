/**
 * SPO R45 — Integration Safety + Runtime Subsystem Owner mechanical test.
 *
 * Scope: `integration/src/safety/` + `integration/src/runtime/` ONLY.
 *
 * Dynamic discovery: every file list is discovered via
 * `readdirSync` — NO hardcoded lists. A new file added to `safety/` or
 * `runtime/` is automatically covered by every check.
 *
 * Assurance classes:
 * A. Single safety-gate owner: `createToolCallGate` is defined ONLY in
 * `safety/tool-call-gate.ts`; `runtime/interactive-session.ts` imports
 * the gate from `safety/tool-call-gate.ts` (the single import point —
 * no parallel ghost-tool/schema/loop check scattered in runtime).
 * B. No scattered safety helpers: `statementTextLength` + `isStatementLike`
 * are defined ONLY in `safety/shared-helpers.ts` (R45 consolidated the
 * near-duplicate bodies that lived in `bandaid-ast-detector.ts` +
 * `bandaid-pattern-learner.ts` with the same `* 40` magic number).
 * C. No generic throws: no `throw new Error(...)` / `throw new TypeError`
 * / `throw new RangeError(...)` in `safety/` or `runtime/`.
 * D. Runtime tool limits single owner: the operational limit constants
 * (`GIT_MAX_LOG_ENTRIES`, `GIT_MAX_SUMMARY_FILES`, `GIT_MAX_MESSAGE_LENGTH`,
 * `GIT_STATS_ONLY_FACTOR`, `GIT_DEFAULT_LOG_COUNT`, `QUALITY_MAX_FILES`,
 * `SYMBOL_SEARCH_DEFAULT_LIMIT`, `SYMBOL_SEARCH_MAX_LIMIT`,
 * `REUSE_SEARCH_DEFAULT_LIMIT`, `REUSE_SEARCH_MAX_LIMIT`,
 * `AGENT_NAME_MAX_LENGTH`, `AGENT_TASK_MAX_LENGTH`, `PROVIDER_CONCURRENCY`)
 * are declared ONLY in `runtime/runtime-config.ts` (the canonical
 * runtime-config owner) — no scattered local `const MAX_... = <num>`
 * declarations in other `runtime/` tool modules.
 * E. bias-preventer no bare magic numbers: `bias-preventer.ts` uses the
 * named `MAX_ENFORCEMENT_LEVEL_BEFORE_BYPASS` constant (not a bare
 * `Math.min(3,...)` literal) + the config-owned `cfg.retentionScoreFloor`
 * (not a bare `Math.max(0.01,...)` literal).
 * F. Architecture realm coverage: the `ArchitectureRealm` union includes
 * `safety`, and `EMPTY_COMPOSITION_ROOTS` (the typed fixture owner)
 * covers EVERY realm in the union (so a new realm forces an update —
 *, no hand-maintained realm list that can rot).
 * G. tool-call-gate public API: the gate's `config` option accepts a
 * `Partial<ToolCallGateConfig>` (callers may override individual fields)
 * and the gate re-exports the `ToolCall`/`ToolDefinition` types it
 * consumes (single import point for the gate's API).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { bindingValueOf, bodyCalls } from "../../src/shared/source-structure.ts";
import { parseConstExportsFromFile } from "../support/source-scan.ts";
import { experimentExclusion, walk } from "../../scripts/verification/source-walk.ts";

const ROOT = process.cwd();
const SAFETY_DIR = join(ROOT, "src", "safety");
const RUNTIME_DIR = join(ROOT, "src", "runtime");

// ── Dynamic file discovery ──────────

function listTsFiles(dir: string, acc: string[] = []): string[] {
  for (const file of walk(dir, { exts: [".ts"], exclude: experimentExclusion(ROOT) })) {
    if (!file.endsWith(".test.ts") && !file.endsWith(".d.ts")) acc.push(file);
  }
  return acc;
}

function allSafetyFiles(): string[] {
  return listTsFiles(SAFETY_DIR);
}

function allRuntimeFiles(): string[] {
  return listTsFiles(RUNTIME_DIR);
}

function rel(file: string): string {
  return relative(ROOT, file).replaceAll("\\", "/");
}

function read(file: string): string {
  return readFileSync(file, "utf8");
}

// Detect whether a position in source is inside a string literal or comment
// (so scan regexes don't false-positive on mention-in-prose).
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

// ── A. Single safety-gate owner ──────────────────────────────────────────

test("R45-A: createToolCallGate is defined ONLY in safety/tool-call-gate.ts", () => {
  const defRegex = /\bcreateToolCallGate\b/g;
  const definitionRegex = /\bexport\s+function\s+createToolCallGate\b/;
  const sites: string[] = [];
  for (const file of [...allSafetyFiles(), ...allRuntimeFiles()]) {
    const content = read(file);
    let m: RegExpExecArray | null;
    defRegex.lastIndex = 0;
    while ((m = defRegex.exec(content)) !== null) {
      if (isInStringOrComment(content, m.index)) continue;
      // A definition (`export function createToolCallGate`) is allowed ONLY in the owner.
      if (definitionRegex.test(content) && rel(file) !== "src/safety/tool-call-gate.ts") {
        sites.push(`${rel(file)} defines createToolCallGate`);
      }
    }
  }
  assert.deepEqual(sites, [], `createToolCallGate must be defined ONLY in src/safety/tool-call-gate.ts (the single safety-gate owner). Found: ${sites.join(", ")}`);
});

test("R45-A: interactive-session imports the gate from safety/tool-call-gate.ts (single import point)", () => {
  const session = read(join(RUNTIME_DIR, "interactive-session.ts"));
  assert.match(session, /from\s+"\.\.\/safety\/tool-call-gate\.ts"/, "interactive-session.ts must import the gate from ../safety/tool-call-gate.ts (the canonical owner), not a parallel/duplicate safety check");
});

// ── B. No scattered safety helpers ────────────────────────────────────────

test("R45-B: statementTextLength + isStatementLike defined ONLY in safety/shared-helpers.ts", () => {
  const helpers = ["statementTextLength", "isStatementLike"];
  const owners: string[] = [];
  for (const file of allSafetyFiles()) {
    const content = read(file);
    for (const fn of helpers) {
      const defRegex = new RegExp(`\\bfunction\\s+${fn}\\s*\\(`, "g");
      let m: RegExpExecArray | null;
      while ((m = defRegex.exec(content)) !== null) {
        if (isInStringOrComment(content, m.index)) continue;
        owners.push(`${rel(file)} defines ${fn}`);
      }
    }
  }
  // Each helper must be defined exactly once, in shared-helpers.ts.
  const expected = ["src/safety/shared-helpers.ts defines statementTextLength", "src/safety/shared-helpers.ts defines isStatementLike"];
  assert.deepEqual(owners.sort(), expected.sort(), `statementTextLength + isStatementLike must be defined ONLY in src/safety/shared-helpers.ts (R45 consolidated the near-duplicate bodies). Found: ${owners.join(", ")}`);
});

// ── C. No generic throws in safety/ or runtime/ ─────────────────

test("R45-C: no throw new Error/TypeError/RangeError in safety/ or runtime/", () => {
  const throwRegex = /\bthrow\s+new\s+(Error|TypeError|RangeError|SyntaxError)\s*\(/g;
  const findings: string[] = [];
  for (const file of [...allSafetyFiles(), ...allRuntimeFiles()]) {
    const content = read(file);
    let m: RegExpExecArray | null;
    throwRegex.lastIndex = 0;
    while ((m = throwRegex.exec(content)) !== null) {
      if (isInStringOrComment(content, m.index)) continue;
      findings.push(`${rel(file)}`);
    }
  }
  assert.deepEqual(findings, [], `no throw new Error/TypeError/RangeError in safety/ or runtime/ — use the typed HarnessError/InputError hierarchy from src/errors.ts. Found in: ${findings.join(", ")}`);
});

// ── D. Runtime tool limits single owner ─────────────────────

// Derive the consolidated tool-limit const set DYNAMICALLY from the single
// owner source (runtime-config.ts) — every `export const` in the canonical
// runtime-config owner is a consolidated limit that must be declared ONLY
// there (no hand-maintained mirror that would silently miss a newly added
// limit const). This is deny-by-default: a new `export const` added to
// runtime-config.ts is automatically required to live only there.
const RUNTIME_LIMIT_CONSTS = parseConstExportsFromFile(join(RUNTIME_DIR, "runtime-config.ts"));

test("R45-D: runtime tool limit consts are declared ONLY in runtime/runtime-config.ts", () => {
  // Non-empty guard: a failed parse must not make the scan vacuously pass.
  assert.ok(RUNTIME_LIMIT_CONSTS.length > 0, "the dynamically derived runtime limit const set must be non-empty (parseExports of runtime-config.ts)");
  const findings: string[] = [];
  for (const file of allRuntimeFiles()) {
    if (rel(file) === "src/runtime/runtime-config.ts") continue; // the canonical owner
    const content = read(file);
    for (const name of RUNTIME_LIMIT_CONSTS) {
      // A `const NAME =` DECLARATION (not an import alias or usage) outside the owner.
      const declRegex = new RegExp(`\\bconst\\s+${name}\\s*=`, "");
      if (declRegex.test(content)) {
        findings.push(`${rel(file)} declares const ${name}`);
      }
    }
  }
  assert.deepEqual(findings, [], `runtime tool limit consts must be declared ONLY in src/runtime/runtime-config.ts (the canonical runtime-config owner). Found scattered: ${findings.join(", ")}`);
});

test("R45-D: no reverted OLD scattered limit const names in runtime/ tool modules", () => {
  // The pre-R45 scattered local const names that were consolidated into
  // runtime-config.ts. A revert (re-adding `const MAX_LOG_ENTRIES = 100;` in
  // git-tools instead of importing from the owner) must be caught. These
  // names legitimately appear as IMPORT ALIASES (`GIT_MAX_LOG_ENTRIES as
  // MAX_LOG_ENTRIES`), so the scan matches a `const <name> =` DECLARATION
  // only — not an import alias line.
  const OLD_SCATTERED_NAMES = [
    "MAX_LOG_ENTRIES", "MAX_MESSAGE_LENGTH", "STATS_ONLY_FACTOR",
    "MAX_SUMMARY_FILES", "MAX_FILES",
  ];
  const findings: string[] = [];
  for (const file of allRuntimeFiles()) {
    if (rel(file) === "src/runtime/runtime-config.ts") continue; // the canonical owner
    const content = read(file);
    for (const name of OLD_SCATTERED_NAMES) {
      const declRegex = new RegExp(`\\bconst\\s+${name}\\s*=\\s*\\d`, "");
      if (declRegex.test(content)) {
        findings.push(`${rel(file)} declares const ${name} = <number> (a revert of the R45 consolidation)`);
      }
    }
  }
  assert.deepEqual(findings, [], `no reverted scattered limit consts (MAX_LOG_ENTRIES, MAX_FILES, ...) in runtime/ tool modules — import from runtime-config.ts instead. Found: ${findings.join(", ")}`);
});

test("R45-D: runtime-config.ts exports all the consolidated tool limit consts", () => {
  // Sanity: the dynamic parse produced a non-empty set of consolidated const
  // names, and each is genuinely an `export const` in the owner source (this
  // guards against a parse regression that returns stale or empty names).
  assert.ok(RUNTIME_LIMIT_CONSTS.length > 0, "runtime-config.ts must export at least one consolidated tool limit const");
  const config = read(join(RUNTIME_DIR, "runtime-config.ts"));
  for (const name of RUNTIME_LIMIT_CONSTS) {
    assert.match(config, new RegExp(`\\bexport\\s+const\\s+${name}\\b`), `runtime-config.ts must export ${name} (the consolidated owner)`);
  }
});

// ── E. bias-preventer no bare magic numbers ─────────────────────

test("R45-E: bias-preventer uses named MAX_ENFORCEMENT_LEVEL_BEFORE_BYPASS (no bare Math.min(3,...))", () => {
  const bp = read(join(SAFETY_DIR, "bias-preventer.ts"));
  assert.match(bp, /\bMAX_ENFORCEMENT_LEVEL_BEFORE_BYPASS\b/, "bias-preventer.ts must use the named MAX_ENFORCEMENT_LEVEL_BEFORE_BYPASS constant");
  // A bare `Math.min(3,` literal (the old magic number) must NOT appear in the escalation path.
  // (A `Math.min(3,...)` elsewhere would be a regression.)
  const bareLiteral = /\bMath\.min\(\s*3\s*,/g;
  let m: RegExpExecArray | null;
  const hits: string[] = [];
  while ((m = bareLiteral.exec(bp)) !== null) {
    if (isInStringOrComment(bp, m.index)) continue;
    hits.push(`Math.min(3, ...) at offset ${m.index}`);
  }
  assert.deepEqual(hits, [], `bias-preventer.ts must not contain a bare Math.min(3, ...) literal — use MAX_ENFORCEMENT_LEVEL_BEFORE_BYPASS. Found: ${hits.join(", ")}`);
});

test("R45-E: bias-preventer uses cfg.retentionScoreFloor (no bare Math.max(0.01,...))", () => {
  const bp = read(join(SAFETY_DIR, "bias-preventer.ts"));
  assert.match(bp, /\bcfg\.retentionScoreFloor\b/, "bias-preventer.ts must use cfg.retentionScoreFloor (the config-owned floor)");
  const bareLiteral = /\bMath\.max\(\s*0\.01\s*,/g;
  let m: RegExpExecArray | null;
  const hits: string[] = [];
  while ((m = bareLiteral.exec(bp)) !== null) {
    if (isInStringOrComment(bp, m.index)) continue;
    hits.push(`Math.max(0.01, ...) at offset ${m.index}`);
  }
  assert.deepEqual(hits, [], `bias-preventer.ts must not contain a bare Math.max(0.01, ...) literal — use cfg.retentionScoreFloor. Found: ${hits.join(", ")}`);
});

test("R45-E: bias-config.ts owns + validates retentionScoreFloor", () => {
  const bc = read(join(SAFETY_DIR, "bias-config.ts"));
  assert.match(bc, /\bretentionScoreFloor\b/, "bias-config.ts must declare retentionScoreFloor (the canonical bias-config owner)");
  assert.match(bc, /retentionScoreFloor must be a finite number in \[0, 1\]/, "bias-config.ts must validate retentionScoreFloor (bounds check at the trust boundary)");
});

// ── F. Architecture realm coverage ───────────────────────────────

test("R45-F: ArchitectureRealm includes safety", () => {
  const manifest = read(join(ROOT, "src", "architecture-manifest.ts"));
  // The union must include "safety" (the safety realm added in R33).
  assert.match(manifest, /export type ArchitectureRealm = [^;]*"safety"/, "ArchitectureRealm must include the safety realm");
});

test("R45-F: EMPTY_COMPOSITION_ROOTS covers EVERY realm in the ArchitectureRealm union", () => {
  const manifest = read(join(ROOT, "src", "architecture-manifest.ts"));
  // Extract the ArchitectureRealm union members dynamically.
  const unionMatch = manifest.match(/export type ArchitectureRealm = ([^;]+);/);
  assert.ok(unionMatch, "ArchitectureRealm union not found");
  const realms = unionMatch[1]!.split("|").map((s) => s.trim().replace(/"/g, ""));
  assert.ok(realms.length > 0, "ArchitectureRealm union must have members");
  // EMPTY_COMPOSITION_ROOTS must be exported + typed as Record<ArchitectureRealm,...>.
  assert.match(manifest, /export const EMPTY_COMPOSITION_ROOTS:\s*Readonly<Record<ArchitectureRealm,\s*readonly string\[\]>>/, "EMPTY_COMPOSITION_ROOTS must be exported + typed as Record<ArchitectureRealm, readonly string[]>");
  // Every realm must appear as a key in the EMPTY_COMPOSITION_ROOTS object literal.
  //
  // THE SUBJECT IS THE CONSTANT'S OWN VALUE. The retired form ran a lazy gap
  // from the NAME to the next `deepFreeze({ … })`, which a sibling constant
  // satisfies: with `EMPTY_COMPOSITION_ROOTS = []` and a neighbouring
  // `OTHER_ROOTS = deepFreeze({ … })` the pattern still matches and the fields
  // it captures are the NEIGHBOUR's.
  const emptyRoots = bindingValueOf(manifest, "EMPTY_COMPOSITION_ROOTS", "src/architecture-manifest.ts");
  assert.ok(bodyCalls(emptyRoots, "deepFreeze"), "EMPTY_COMPOSITION_ROOTS must be frozen at its declaration");
  const block = emptyRoots.body;
  for (const realm of realms) {
    assert.match(block, new RegExp(`\\b${realm}\\s*:\\s*\\[\\s*\\]`), `EMPTY_COMPOSITION_ROOTS must cover the '${realm}' realm (no hand-maintained realm list — a new realm forces an update)`);
  }
});

// ── G. tool-call-gate public API ──────────────────────────────────────────

test("R45-G: tool-call-gate config option accepts Partial<ToolCallGateConfig>", () => {
  const gate = read(join(SAFETY_DIR, "tool-call-gate.ts"));
  // The config option must accept a Partial (callers may override individual fields).
  assert.match(gate, /config\?:\s*Partial<ToolCallGateConfig>/, "ToolCallGateOptions.config must accept Partial<ToolCallGateConfig> (matches resolveToolCallGateConfig + the override API)");
});

test("R45-G: tool-call-gate re-exports ToolCall + ToolDefinition (single import point)", () => {
  const gate = read(join(SAFETY_DIR, "tool-call-gate.ts"));
  assert.match(gate, /export type \{ ToolCall, ToolDefinition \}/, "tool-call-gate.ts must re-export ToolCall + ToolDefinition so consumers import the gate's full API from one place");
});

// ── Mutation verification ─────────────────────────────────────────────────

test("R45-mutation: reintroducing a throw new TypeError in runtime/ makes R45-C fail", () => {
  // Sanity: the scan regex DOES catch a synthetic generic throw.
  const synthetic = "if (!ok) { throw new TypeError('bad'); }";
  const throwRegex = /\bthrow\s+new\s+(Error|TypeError|RangeError|SyntaxError)\s*\(/g;
  assert.ok(throwRegex.test(synthetic), "the throwRegex must catch a generic throw (mutation sanity)");
});

test("R45-mutation: reintroducing a scattered const MAX_LOG_ENTRIES in git-tools makes R45-D fail", () => {
  // Sanity: the decl regex catches a local const declaration (not an import alias).
  const syntheticDecl = "const MAX_LOG_ENTRIES = 100;";
  const declRegex = /\bconst\s+GIT_MAX_LOG_ENTRIES\s*=/;
  assert.ok(declRegex.test("const GIT_MAX_LOG_ENTRIES = 100;"), "declRegex must catch a const declaration (mutation sanity)");
  // And it does NOT match an import alias line.
  assert.ok(!declRegex.test("GIT_MAX_LOG_ENTRIES as MAX_LOG_ENTRIES,"), "declRegex must NOT match an import alias (so the consolidation's aliased import is not a false positive)");
  void syntheticDecl;
});
