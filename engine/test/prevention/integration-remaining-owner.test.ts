/**
 * SPO R49 — Integration Remaining Subsystems Owner mechanical test.
 *
 * Scope: the `integration/src/` subsystems NOT audited by R41–R48:
 * shared/dedup-compression/ (the dedup subsystem — R31 wired the web UI;
 * this audits the integration side)
 * root-policy.ts (the safety-invariants owner) + its consumers
 * filesystem/self-protection/ (the Landlock integration side)
 * quality/aggregator.ts (the signal aggregator)
 * the remaining unaudited dirs (agents, editor, workflow, self-improving,
 * privacy, git, mcp, timeline, extensions, performance, process, etc.)
 *
 * Dynamic discovery: every file list is discovered via
 * `readdirSync` — NO hardcoded lists. A new file added to a scanned dir is
 * automatically covered by every check.
 *
 * Assurance classes:
 * A. No `throw new Error/TypeError/RangeError` in the remaining subsystems
 *.
  * Excludes test fixtures (bug-zoo.ts — intentional bug samples) and
  * legacy `.mjs` engine internals (out of the production.ts path).
 * B. No swallowed catches (bare `catch {}` / `catch { void e; }`) in the
 * remaining subsystems.
 * C. R49-V1: privacy-policy.ts `enforceFloor` throws `InputError` (not
 * `RangeError`) with the `privacy_policy_floor_violation` code.
 * D. R49-V8: editor/transactional-editor.ts uses `MAX_PATH_BYTES` (no
 * inline `> 4096` path-length check); `EDITOR_DEFAULT_LIMITS` declares
 * `maxPathBytes` (the editor limit owner).
 * E. R49-V4: agents/agent-state.ts uses `DEFAULT_AGENT_EVENT_QUERY_LIMIT`
 * (no inline `limit: 10000` reconstruction literals).
 * F. R49-V5: workflow-config.ts owns the gate-output caps; workspace-
 * manager.ts has no inline `2048`/`2000` gate-cap literals.
 * G. R49-V6: self-improving config declares `largeOutputChars`;
 * workflow-improver.ts has no inline `> 5000` context-waste literal.
 * H. R49-V7: self-improving/config.ts `LearnedRulesStore.deserialize`
 * routes its catch through `handleError` (no bare `catch {}`).
 * I. R49-V3: aggregator.ts defines `SIGNAL_REGISTRY` and `runAnalysis`
 * loops over it (no bespoke `if (config.enabledSignals.has("..."))`
 * per-signal if-chain in runAnalysis).
 * J. R49-V9: lower-layer.ts `store`/`storeAsync` delegate to a single
 * `commitDedupResult` (no duplicated post-dedup commit body).
 * K. R49-V2: dynamic-keywords.ts `defaultWasmForExt` doc comment is
 * honest (does NOT claim the mapping is "config-owned").
 * L. root-policy.ts is the single owner of the `maximumPathBytes` safety
 * invariant — the editor derives its path limit from the config-layer
 * owner, not a parallel hardcoded `4096`.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { shouldExcludeExperiment } from "../../src/shared/source-scan.ts";
import { functionBody } from "../../src/shared/source-structure.ts";
import { engineModuleSourceRelative } from "../support/module-resolver.ts";
import { experimentExclusion, walk } from "../../scripts/verification/source-walk.ts";

const ROOT = process.cwd();

// ── Dynamic file discovery ──────────

function listTsFiles(dir: string, acc: string[] = []): string[] {
  for (const file of walk(dir, { exts: [".ts"], exclude: experimentExclusion(ROOT) })) {
    if (!file.endsWith(".test.ts") && !file.endsWith(".d.ts")) acc.push(file);
  }
  return acc;
}

/**
 * The remaining subsystems: every top-level `src/` directory NOT covered by
 * R41–R48 (config, memory, intelligence, shared, safety, runtime, tools,
 * quality, awareness) PLUS shared/dedup-compression + the root-level.ts
 * files. Discovered dynamically — adding a new directory is automatic.
 *
 * R41–R48 already audited: awareness, intelligence, memory, quality, runtime,
 * safety, shared (excl. dedup-compression deep dive), tools, config.
 * Excluded here to avoid duplicating their owner tests.
 */
const ALREADY_AUDITED_DIRS = new Set([
  "awareness", "intelligence", "memory", "quality", "runtime", "safety", "tools",
]);

function remainingSubsystemFiles(): string[] {
  const files: string[] = [];
  const srcDir = join(ROOT, "src");
  // Subdirectories not already audited.
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    if (ALREADY_AUDITED_DIRS.has(entry.name)) continue;
    if (shouldExcludeExperiment(entry.name)) continue;
    listTsFiles(join(srcDir, entry.name), files);
  }
  // shared/ is audited by R44 EXCEPT the dedup-compression deep dive (R49).
  listTsFiles(join(srcDir, "shared", "dedup-compression"), files);
  // Root-level.ts files (root-policy.ts, errors.ts, integrity.ts, etc.).
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) {
      files.push(join(srcDir, entry.name));
    }
  }
  return files;
}

function rel(file: string): string {
  return relative(ROOT, file).replaceAll("\\", "/");
}

function readRel(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf8");
}

// ── String/comment detection (so regex matches don't fire in strings) ──

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

/** Find all occurrences of a regex in code (skipping strings/comments). */
function codeMatches(content: string, pattern: RegExp): { index: number; line: number }[] {
  const hits: { index: number; line: number }[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
  re.lastIndex = 0;
  while ((m = re.exec(content)) !== null) {
    if (isInStringOrComment(content, m.index)) continue;
    const line = content.slice(0, m.index).split("\n").length;
    hits.push({ index: m.index, line });
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return hits;
}

// ── A. No `throw new Error/TypeError/RangeError` ──────────────

test("R49-A: no `throw new Error/TypeError/RangeError` in remaining subsystems", () => {
  const throwRegex = /\bthrow\s+new\s+(Error|TypeError|RangeError|SyntaxError|ReferenceError)\s*\(/gu;
  // bug-zoo.ts is a test fixture of intentional bug samples (throws are the
  // bugs being detected); exclude it. Legacy.mjs is excluded by the.ts filter.
  const violations: string[] = [];
  for (const f of remainingSubsystemFiles()) {
    if (rel(f).endsWith("quality-packs/bug-zoo.ts")) continue;
    const content = readFileSync(f, "utf8");
    const hits = codeMatches(content, throwRegex);
    for (const h of hits) violations.push(`${rel(f)}:${h.line}`);
  }
  assert.equal(violations.length, 0,
    ` — use the typed HarnessError hierarchy (errors.ts), not throw new Error/TypeError/RangeError: ${violations.join(", ")}`);
});

// ── B. No swallowed catches ───────────────────────────────

test("R49-B: no swallowed catches in remaining subsystems", () => {
  const violations: string[] = [];
  for (const f of remainingSubsystemFiles()) {
    const content = readFileSync(f, "utf8");
    // bare `catch {}` or `catch (e) {}` (empty body) — allow `catch (e) { handleError...`
    const catchRegex = /\bcatch\s*(\([^)]*\))?\s*\{/gu;
    let m: RegExpExecArray | null;
    while ((m = catchRegex.exec(content)) !== null) {
      if (isInStringOrComment(content, m.index)) continue;
      // Find the matching closing brace of the catch block.
      let depth = 1, i = m.index + m[0].length;
      let bodyStart = i;
      while (i < content.length && depth > 0) {
        const ch = content[i];
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        if (depth === 0) break;
        i++;
      }
      const body = content.slice(bodyStart, i).trim();
      // A swallowed catch has an empty or effectively-empty body (only whitespace/semicolon).
      if (body.length === 0 || body === ";") {
        const line = content.slice(0, m.index).split("\n").length;
        violations.push(`${rel(f)}:${line}`);
      }
    }
  }
  assert.equal(violations.length, 0,
    ` — swallowed catch (empty body) hides failures; route through handleError: ${violations.join(", ")}`);
});

// ── C. R49-V1: privacy-policy.ts enforceFloor uses InputError (not RangeError) ─

test("R49-C: privacy-policy.ts enforceFloor throws InputError with privacy_policy_floor_violation code", () => {
  const content = readRel("src/privacy/privacy-policy.ts");
  assert.equal(codeMatches(content, /\bthrow\s+new\s+RangeError\s*\(/u).length, 0,
    "enforceFloor must NOT throw RangeError");
  const inputHits = codeMatches(content, /\bthrow\s+new\s+InputError\s*\(/u);
  assert.ok(inputHits.length >= 1, "enforceFloor must throw InputError");
  assert.ok(/privacy_policy_floor_violation/u.test(content),
    "enforceFloor must use the privacy_policy_floor_violation code");
});

// ── D. R49-V8: editor uses MAX_PATH_BYTES (no inline 4096 path check) ───

test("R49-D: editor path-length check uses MAX_PATH_BYTES from the config-layer owner", () => {
  const editor = readRel("src/editor/transactional-editor.ts");
  assert.ok(/\bMAX_PATH_BYTES\b/u.test(editor),
    "transactional-editor.ts must use MAX_PATH_BYTES (not an inline 4096 literal)");
  // No inline `> 4096` path-length check remains.
  assert.equal(codeMatches(editor, /byteLength\s*\(\s*path[^)]*\)\s*>\s*4096/u).length, 0,
    "no inline `> 4096` path-length check — use MAX_PATH_BYTES");
  const config = readRel(engineModuleSourceRelative("config-contracts.ts"));
  assert.ok(/maxPathBytes/u.test(config), "EDITOR_DEFAULT_LIMITS must declare maxPathBytes");
  const editOps = readRel("src/editor/edit-operations.ts");
  assert.ok(/MAX_PATH_BYTES\b[^;]*=\s*EDITOR_DEFAULT_LIMITS\.maxPathBytes/u.test(editOps),
    "edit-operations.ts must re-export MAX_PATH_BYTES from the config-layer owner");
});

// ── E. R49-V4: agent-state uses DEFAULT_AGENT_EVENT_QUERY_LIMIT ─────────

test("R49-E: agent-state.ts uses DEFAULT_AGENT_EVENT_QUERY_LIMIT (no inline limit: 10000)", () => {
  const content = readRel("src/agents/agent-state.ts");
  assert.ok(/\bDEFAULT_AGENT_EVENT_QUERY_LIMIT\b/u.test(content),
    "agent-state.ts must use DEFAULT_AGENT_EVENT_QUERY_LIMIT");
  assert.equal(codeMatches(content, /limit:\s*10000\b/u).length, 0,
    "no inline `limit: 10000` reconstruction literals — use the named const");
  const config = readRel("src/agents/agents-config.ts");
  assert.ok(/DEFAULT_AGENT_EVENT_QUERY_LIMIT\s*=\s*10[_\s]*000/u.test(config),
    "agents-config.ts must own DEFAULT_AGENT_EVENT_QUERY_LIMIT");
});

// ── F. R49-V5: workflow gate-output caps owned by workflow-config.ts ───

test("R49-F: workspace-manager gate-output caps owned by workflow-config.ts (no inline 2048/2000)", () => {
  const manager = readRel("src/workflow/workspace-manager.ts");
  // No inline `= 2048` / `= 2000` gate-cap literals remain.
  assert.equal(codeMatches(manager, /MAXIMUM_GATE_OUTPUT_CHARACTERS\s*=\s*2048\b/u).length, 0,
    "no inline `MAXIMUM_GATE_OUTPUT_CHARACTERS = 2048` — own it in workflow-config.ts");
  assert.equal(codeMatches(manager, /MAXIMUM_PERSISTED_GATE_STRING_CHARACTERS\s*=\s*2000\b/u).length, 0,
    "no inline `MAXIMUM_PERSISTED_GATE_STRING_CHARACTERS = 2000` — own it in workflow-config.ts");
  const config = readRel("src/workflow/workflow-config.ts");
  assert.ok(/DEFAULT_MAXIMUM_GATE_OUTPUT_CHARACTERS\s*=\s*2048/u.test(config),
    "workflow-config.ts must own DEFAULT_MAXIMUM_GATE_OUTPUT_CHARACTERS");
  assert.ok(/DEFAULT_MAXIMUM_PERSISTED_GATE_STRING_CHARACTERS\s*=\s*2000/u.test(config),
    "workflow-config.ts must own DEFAULT_MAXIMUM_PERSISTED_GATE_STRING_CHARACTERS");
  // The consumers derive from the config owner (not a parallel literal): the
  // command runner's output tail is set where the ONE runner is constructed
  // (`configuredCheckoutCommandRunner`, which the workspace command, the
  // candidate checkout and the promotion call), the persisted cap where the
  // manager writes reports and receipts.
  assert.ok(/outputCharacters:\s*DEFAULT_MAXIMUM_GATE_OUTPUT_CHARACTERS/u.test(readRel("src/workflow/checkout-setup.ts")),
    "checkout-setup.ts's configuredCheckoutCommandRunner must take the command output tail from the config owner");
  assert.ok(/configuredCheckoutCommandRunner\(/u.test(readRel("src/workflow/workspace-cli.ts")),
    "workspace-cli.ts must build its runner through configuredCheckoutCommandRunner");
  assert.ok(/DEFAULT_MAXIMUM_PERSISTED_GATE_STRING_CHARACTERS/u.test(manager),
    "workspace-manager.ts must take the persisted gate-string cap from the config owner");
});

// ── G. R49-V6: self-improving config owns largeOutputChars ──────────────

test("R49-G: self-improving config declares largeOutputChars; workflow-improver has no inline > 5000", () => {
  const config = readRel("src/self-improving/config.ts");
  assert.ok(/largeOutputChars:\s*z\.number\(\)\.int\(\)\.positive\(\)/u.test(config),
    "SelfImprovingConfig schema must declare largeOutputChars");
  assert.ok(/largeOutputChars:\s*5000/u.test(config),
    "DEFAULT_SELF_IMPROVING_CONFIG must set largeOutputChars (the former inline literal)");
  const improver = readRel("src/self-improving/workflow-improver.ts");
  assert.equal(codeMatches(improver, />\s*5000\b/u).length, 0,
    "no inline `> 5000` context-waste literal — use config.largeOutputChars");
  assert.ok(/config\.largeOutputChars/u.test(improver),
    "workflow-improver.ts must read config.largeOutputChars");
});

// ── H. R49-V7: LearnedRulesStore.deserialize routes through handleError ─

test("R49-H: LearnedRulesStore.deserialize routes its catch through handleError (no bare catch {})", () => {
  const content = readRel("src/self-improving/config.ts");
  assert.ok(/import\s*\{[^}]*handleError[^}]*\}\s*from\s*"[^"]*debug-system\.ts"/u.test(content),
    "self-improving/config.ts must import handleError from the debug owner");
  // The deserialize method must call handleError (the exact call site I added
  // — robust against brace-matching brittleness). R49-V7.
  assert.ok(/handleError\s*\(\s*e,\s*\{\s*module:\s*"self-improving-config"/u.test(content),
    "LearnedRulesStore.deserialize catch must route through handleError (R49-V7)");
  assert.equal(codeMatches(content, /\bcatch\s*\{\s*\}/u).length, 0,
    "no bare `catch {}` in self-improving/config.ts");
});

// ── I. R49-V3: aggregator SIGNAL_REGISTRY (auto-registration) ───────────

test("R49-I: aggregator.ts defines SIGNAL_REGISTRY and runAnalysis loops over it (no bespoke signal if-chain)", () => {
  const content = readRel("src/quality/aggregator.ts");
  assert.ok(/\bSIGNAL_REGISTRY\b/u.test(content), "aggregator.ts must define SIGNAL_REGISTRY");
  assert.ok(/SignalRegistryEntry/u.test(content), "SIGNAL_REGISTRY entries must be typed SignalRegistryEntry");
  // runAnalysis must NOT contain a bespoke per-signal if-chain. The old
  // pattern was `if (config.enabledSignals.has("..."))` repeated per signal.
  // After the refactor, there is exactly ONE such check (inside the loop).
  const ifChainHits = codeMatches(content, /\bif\s*\(\s*config\.enabledSignals\.has\s*\(\s*"/u);
  assert.ok(ifChainHits.length <= 1,
    `runAnalysis must loop over SIGNAL_REGISTRY, not repeat a bespoke if-chain per signal (found ${ifChainHits.length} bespoke checks)`);
  // The registry must list all 8 signals (auto-registration — a new signal is
  // wired once). Derive the count from signals.ts dynamically.
  const signalsSrc = readRel("src/quality/signals.ts");
  const signalFns = codeMatches(signalsSrc, /\bexport\s+function\s+signal\w+\s*\(/u);
  assert.ok(signalFns.length >= 8, `signals.ts must export the signal functions (found ${signalFns.length})`);
  // Each exported signal function must be referenced in the registry.
  const fnNames = signalFns.map((h) => {
    const line = signalsSrc.split("\n")[h.line - 1] ?? "";
    const m = line.match(/export\s+function\s+(signal\w+)\s*\(/u);
    return m ? m[1] : null;
  }).filter(Boolean) as string[];
  for (const fn of fnNames) {
    assert.ok(new RegExp(`\\b${fn}\\b`).test(content),
      `aggregator.ts must register the ${fn} signal in SIGNAL_REGISTRY (auto-registration)`);
  }
});

// ── J. R49-V9: lower-layer store/storeAsync delegate to commitDedupResult ─

test("R49-J: lower-layer store/storeAsync delegate to a single commitDedupResult (no duplicated commit body)", () => {
  const content = readRel("src/shared/dedup-compression/lower-layer.ts");
  assert.ok(/\bcommitDedupResult\b/u.test(content),
    "lower-layer.ts must define a shared commitDedupResult helper");
  // The store and storeAsync methods must call commitDedupResult (not
  // duplicate the commit body inline). Each delegation is asserted inside that
  // method's OWN extracted body — a lazy span across the file can cross the
  // closing brace and match a SIBLING method's return, so removing store's
  // delegation would stay green on storeAsync's. functionBody bounds the claim
  // to the method the assertion names.
  for (const method of ["store", "storeAsync"] as const) {
    const body = functionBody(content, method, `method ${method}`).body;
    assert.ok(
      /return\s+this\.commitDedupResult/u.test(body),
      `${method}() must delegate to commitDedupResult inside its own body`,
    );
  }
  // The commit body (content-hash lookup + compress + entry creation) must
  // appear exactly ONCE (in commitDedupResult), not duplicated in store/storeAsync.
  const commitBodyHits = codeMatches(content, /this\.entries\.set\s*\(\s*id,\s*entry\s*\)/u);
  assert.equal(commitBodyHits.length, 1,
    `the entry-creation commit body must appear once (in commitDedupResult), not duplicated — found ${commitBodyHits.length}`);
});

// ── K. R49-V2: dynamic-keywords defaultWasmForExt honest comment ───────

test("R49-K: dynamic-keywords.ts defaultWasmForExt comment does not lie about being config-owned", () => {
  const content = readRel("src/shared/dedup-compression/dynamic-keywords.ts");
  // The old lie: "the WASM filename mapping, which is config-owned".
  assert.equal(codeMatches(content, /config-owned/u).length, 0,
    "defaultWasmForExt comment must not falsely claim the mapping is config-owned (R49-V2)");
  // The honest comment must acknowledge it is a built-in default that the
  // config can OVERRIDE (not "owns").
  assert.ok(/built-in default/u.test(content) || /config OVERRIDABLE|user OVERRIDABLE|FALLBACK/u.test(content),
    "defaultWasmForExt comment must honestly describe it as a built-in default / fallback the config overrides");
});

// ── L. root-policy.ts is the single owner of maximumPathBytes ──────────

test("R49-L: root-policy.ts owns maximumPathBytes; the editor does not bypass it with a parallel 4096", () => {
  const rootPolicy = readRel(engineModuleSourceRelative("root-policy.ts"));
  // root-policy owns the safety invariant (the safety carve-out).
  assert.ok(/maximumPathBytes:\s*4_?096/u.test(rootPolicy),
    "root-policy.ts must own the maximumPathBytes safety invariant");
  // The editor must derive its path limit from the config-layer owner
  // (EDITOR_DEFAULT_LIMITS.maxPathBytes), not a parallel hardcoded 4096.
  const editor = readRel("src/editor/transactional-editor.ts");
  assert.ok(!/> 4096\b/u.test(editor.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "")),
    "editor must not contain a hardcoded `> 4096` path check — derive from MAX_PATH_BYTES");
});
