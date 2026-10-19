/**
 * SPO R47 — Integration Tools + Quality Subsystem Owner mechanical test.
 *
 * Scope: `integration/src/tools/` + `integration/src/quality/` ONLY.
 *
 * Dynamic discovery: every file list is discovered via
 * `readdirSync` — NO hardcoded lists. A new file added to `tools/` or
 * `quality/` is automatically covered by every check.
 *
 * Assurance classes:
 * A. Single-owner / No Scattered Helpers:
 * `combineSignalArray` (shared/abort-signals) is the ONLY signal
 * combiner in tools/ (no `combineMcpSignals` parallel copy).
 * `extractErrorMessage` (errors.ts) is the ONLY error-message helper
 * in tools/ (no local `errMessage` in worker-pool.ts).
 * `deepFreeze` (integrity.ts) is NOT redefined in tools/ (no local
 * copy in tools/concurrent/long-task-runner.ts).
 * B. No hardcoded scattered configurables:
 * mcp-adapter `MAX_MCP_MESSAGE_BYTES` references ROOT_POLICY (not a
 * hardcoded literal).
 * scoring.ts has NO hardcoded grade boundaries (90/80/70/60) and NO
 * `?? 20` fallback cap — both come from config.
 * signals.ts `signalCodebaseTypeLevel` has NO `> 0.7` literal and
 * `signalArchitecture` has NO `.slice(0, 5)` — both from config.
 * C. No `throw new Error/TypeError/RangeError` in scope.
 * D. No swallowed catches (empty / effectively-empty) in scope.
 * E. Config owner: `buildQualityConfig` sets `gradeBoundaries`,
 * `defaultCategoryCap`, `codebaseTypeLevelFraction`, `topHubModuleCount`
 * (the canonical owner of the values scoring.ts/signals.ts consume).
 * F. Behavioral: `scoreQuality` grade respects config-overridden
 * `gradeBoundaries`; `monitorDelta` impact respects config-overridden
 * `severityPenalty` (proves the values flow THROUGH, not just received).
 * G. tool-adapter no-op removed: the `...(input.correlation!== undefined
 *? {}: {})` dead spread is gone (was a no-op bug).
 * H. tree-sitter-loader: no broken `"/package.json"` subpath resolve (the
 * ERR_PACKAGE_PATH_NOT_EXPORTED bug) and no `throw new Error(...)`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { experimentExclusion, walk } from "../../scripts/verification/source-walk.ts";

const ROOT = process.cwd();
const TOOLS_DIR = join(ROOT, "src", "tools");
const QUALITY_DIR = join(ROOT, "src", "quality");

// ── Dynamic file discovery ──────────

function listTsFiles(dir: string, acc: string[] = []): string[] {
  for (const file of walk(dir, { exts: [".ts"], exclude: experimentExclusion(ROOT) })) {
    if (!file.endsWith(".test.ts") && !file.endsWith(".d.ts")) acc.push(file);
  }
  return acc;
}

function toolsFiles(): string[] {
  return listTsFiles(TOOLS_DIR);
}

function qualityFiles(): string[] {
  return listTsFiles(QUALITY_DIR);
}

function scopeFiles(): string[] {
  return [...toolsFiles(), ...qualityFiles()];
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
    if (m.index === re.lastIndex) re.lastIndex++; // avoid zero-length loop
  }
  return hits;
}

// ── A. Single-owner / No Scattered Helpers ──────────────────────────────

test("R47-A1: combineMcpSignals is NOT redefined in tools/ (reuse combineSignalArray)", () => {
  for (const f of toolsFiles()) {
    const content = readFileSync(f, "utf8");
    const hits = codeMatches(content, /\bfunction\s+combineMcpSignals\s*\(/u);
    assert.equal(hits.length, 0, `${rel(f)}: combineMcpSignals must not be redefined (use shared/abort-signals combineSignalArray)`);
  }
});

test("R47-A2: the shared MCP tool adapter reuses the shared isAbortError helper", () => {
  // The MCP tool adapter lives in `src/mcp/tool-adapter.ts` (the canonical
  // shared module — the old `src/tools/mcp-adapter.ts` monolith is deleted).
  const src = readRel("src/mcp/tool-adapter.ts");
  assert.ok(/import\s*\{[^}]*isAbortError[^}]*\}\s*from\s*"\.\.\/tools\/tool-adapter\.ts"/u.test(src), "mcp/tool-adapter must import isAbortError from tools/tool-adapter");
});

test("R47-A3: no local errMessage helper in worker-pool.ts (use extractErrorMessage)", () => {
  const src = readRel("src/tools/concurrent/worker-pool.ts");
  assert.equal(codeMatches(src, /\bfunction\s+errMessage\s*\(/u).length, 0, "worker-pool must not redefine errMessage (use errors.ts extractErrorMessage)");
  assert.ok(/import\s*\{[^}]*extractErrorMessage/u.test(src), "worker-pool must import extractErrorMessage from errors.ts");
});

test("R47-A4: no local deepFreeze in long-task-runner.ts (import from integrity.ts)", () => {
  const src = readRel("src/tools/concurrent/long-task-runner.ts");
  assert.equal(codeMatches(src, /\bfunction\s+deepFreeze\s*[<(]/u).length, 0, "long-task-runner must not redefine deepFreeze (import from integrity.ts)");
  // The import reaches the integrity owner by whatever relative prefix the
  // post-fold depth requires — assert the target module, not the spelled path.
  assert.ok(/import\s*\{[^}]*deepFreeze[^}]*\}\s*from\s*"(?:\.\.\/)*kernel\/integrity\.ts"/u.test(src), "long-task-runner must import deepFreeze from the kernel integrity.ts owner");
});

// ── B. No hardcoded scattered configurables ───────────────

test("R47-B1: mcp core MCP_MAX_MESSAGE_BYTES references ROOT_POLICY (not a literal)", () => {
  // The MCP constants live in `src/mcp/core.ts` (the canonical shared module —
  // the old `src/tools/mcp-adapter.ts` monolith is deleted).
  const src = readRel("src/mcp/core.ts");
  // The constant must be derived from ROOT_POLICY, not a bare numeric literal.
  const decl = codeMatches(src, /MAX_MCP_MESSAGE_BYTES\s*=\s*[^;]+;/u);
  assert.ok(decl.length >= 1, "mcp/core must declare MCP_MAX_MESSAGE_BYTES");
  const declLine = src.split("\n")[decl[0]!.line - 1]!;
  assert.ok(/ROOT_POLICY\./u.test(declLine), `MCP_MAX_MESSAGE_BYTES must reference ROOT_POLICY (got: ${declLine.trim()})`);
  assert.ok(!/=\s*\d[\d_]*\s*;?/u.test(declLine.replace(/\/\/.*$/u, "")), `MCP_MAX_MESSAGE_BYTES must not be a bare numeric literal (got: ${declLine.trim()})`);
});

test("R47-B2: scoring.ts has NO hardcoded grade boundaries (90/80/70/60)", () => {
  const src = readRel("src/quality/scoring.ts");
  // gradeOf must read boundaries from a parameter, not compare to literals.
  assert.equal(codeMatches(src, />=\s*90\b|>=\s*80\b|>=\s*70\b|>=\s*60\b/u).length, 0, "scoring.ts gradeOf must not hardcode 90/80/70/60 — use config.scoring.gradeBoundaries");
  // The header claim "No static constants live here" must be backed by no numeric grade literals.
  assert.ok(/gradeBoundaries/u.test(src), "scoring.ts must consume config.scoring.gradeBoundaries");
});

test("R47-B3: scoring.ts categoryCap fallback is config-owned (no `?? 20`)", () => {
  const src = readRel("src/quality/scoring.ts");
  assert.equal(codeMatches(src, /\?\?\s*20\b/u).length, 0, "scoring.ts must not use a hardcoded `?? 20` fallback — use config.scoring.defaultCategoryCap");
  assert.ok(/defaultCategoryCap/u.test(src), "scoring.ts must consume config.scoring.defaultCategoryCap");
});

test("R47-B4: signals.ts signalCodebaseTypeLevel uses config threshold (no `> 0.7`)", () => {
  const src = readRel("src/quality/signals.ts");
  assert.equal(codeMatches(src, />\s*0\.7\b/u).length, 0, "signals.ts must not hardcode `> 0.7` — use config.thresholds.codebaseTypeLevelFraction");
  assert.ok(/codebaseTypeLevelFraction/u.test(src), "signals.ts must consume config.thresholds.codebaseTypeLevelFraction");
});

test("R47-B5: signals.ts signalArchitecture uses config topHubModuleCount (no `.slice(0, 5)`)", () => {
  const src = readRel("src/quality/signals.ts");
  assert.equal(codeMatches(src, /\.slice\(\s*0\s*,\s*5\s*\)/u).length, 0, "signals.ts must not hardcode `.slice(0, 5)` — use config.thresholds.topHubModuleCount");
  assert.ok(/topHubModuleCount/u.test(src), "signals.ts must consume config.thresholds.topHubModuleCount");
});

// ── C. No throw new Error/TypeError/RangeError in scope ───────

test("R47-C: no `throw new Error/TypeError/RangeError(...)` in tools/ + quality/", () => {
  const violations: string[] = [];
  for (const f of scopeFiles()) {
    const content = readFileSync(f, "utf8");
    const hits = codeMatches(content, /\bthrow\s+new\s+(Error|TypeError|RangeError)\s*\(/u);
    for (const h of hits) violations.push(`${rel(f)}:${h.line}`);
  }
  assert.equal(violations.length, 0, ` — use the typed HarnessError hierarchy, not throw new Error/TypeError/RangeError: ${violations.join(", ")}`);
});

// ── D. No swallowed catches in scope ──────────────────────────

test("R47-D: no swallowed (empty / effectively-empty) catches in tools/ + quality/", () => {
  const violations: string[] = [];
  for (const f of scopeFiles()) {
    const content = readFileSync(f, "utf8");
    // Match `catch {... }` or `catch (e) {... }` bodies.
    const re = /\bcatch\s*(?:\(\s*[A-Za-z_$][\w$]*\s*\))?\s*\{/gu;
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(content)) !== null) {
      if (isInStringOrComment(content, m.index)) continue;
      // Find the matching `}` for the catch body.
      let depth = 1;
      let i = m.index + m[0].length;
      let body = "";
      let inSingle = false, inDouble = false, inBacktick = false;
      let inLineComment = false, inBlockComment = false;
      while (i < content.length && depth > 0) {
        const c = content[i]!, n = content[i + 1];
        if (inLineComment) { body += c; if (c === "\n") inLineComment = false; i++; continue; }
        if (inBlockComment) { body += c; if (c === "*" && n === "/") { inBlockComment = false; body += n; i += 2; continue; } i++; continue; }
        if (inSingle) { body += c; if (c === "\\") { body += n ?? ""; i += 2; continue; } if (c === "'") inSingle = false; i++; continue; }
        if (inDouble) { body += c; if (c === "\\") { body += n ?? ""; i += 2; continue; } if (c === '"') inDouble = false; i++; continue; }
        if (inBacktick) { body += c; if (c === "\\") { body += n ?? ""; i += 2; continue; } if (c === "`") inBacktick = false; i++; continue; }
        if (c === "/" && n === "/") { inLineComment = true; body += c; i += 2; continue; }
        if (c === "/" && n === "*") { inBlockComment = true; body += c; i += 2; continue; }
        if (c === "'") { inSingle = true; body += c; i++; continue; }
        if (c === '"') { inDouble = true; body += c; i++; continue; }
        if (c === "`") { inBacktick = true; body += c; i++; continue; }
        if (c === "{" || c === "(" || c === "[") depth++;
        else if (c === "}" || c === ")" || c === "]") { depth--; if (depth === 0) break; }
        body += c;
        i++;
      }
      // Effectively-empty: only whitespace + comments. A catch that calls
      // handleError/bestEffort/console/rethrow/return-with-value is NOT empty.
      const stripped = body
        .replace(/\/\/[^\n]*/gu, "")
        .replace(/\/\*[\s\S]*?\*\//gu, "")
        .trim();
      if (stripped.length === 0) {
        const line = content.slice(0, m.index).split("\n").length;
        violations.push(`${rel(f)}:${line}`);
      }
    }
  }
  assert.equal(violations.length, 0, ` — no swallowed catches in tools/+quality: ${violations.join(", ")}`);
});

// ── E. Config owner: buildQualityConfig sets the R47 values ────────────

test("R47-E: buildQualityConfig populates gradeBoundaries, defaultCategoryCap, codebaseTypeLevelFraction, topHubModuleCount", async () => {
  const { buildQualityConfig } = await import("../../src/quality/config.ts");
  const cfg = buildQualityConfig();
  assert.ok(cfg.scoring.gradeBoundaries, "gradeBoundaries must be set");
  assert.equal(typeof cfg.scoring.gradeBoundaries.a, "number");
  assert.equal(typeof cfg.scoring.defaultCategoryCap, "number");
  assert.equal(typeof cfg.thresholds.codebaseTypeLevelFraction, "number");
  assert.equal(typeof cfg.thresholds.topHubModuleCount, "number");
  // Defaults preserve prior behavior (grade boundaries 90/80/70/60).
  assert.deepEqual({ a: 90, b: 80, c: 70, d: 60 }, cfg.scoring.gradeBoundaries, "default grade boundaries must preserve the historical 90/80/70/60");
  assert.equal(cfg.scoring.defaultCategoryCap, 20, "default category cap must preserve the historical 20");
  assert.equal(cfg.thresholds.codebaseTypeLevelFraction, 0.7, "default typed-fraction must preserve the historical 0.7");
  assert.equal(cfg.thresholds.topHubModuleCount, 5, "default top-hub count must preserve the historical 5");
});

// ── F. Behavioral: values flow THROUGH (not just received) ──────────────

test("R47-F1: scoreQuality grade respects config-overridden gradeBoundaries", async () => {
  const { scoreQuality } = await import("../../src/quality/scoring.ts");
  const { buildQualityConfig } = await import("../../src/quality/config.ts");
  // A report whose overall (100 - totalPenalty) lands at 85 → "B" with the
  // default boundaries (≥80). Override the A boundary to 85 → "A".
  const report = {
    codebasePath: "x", language: "typescript" as const, generatedAt: "t",
    files: { scanned: 1, parsed: 1, parseErrors: 0, loc: 1000 },
    findings: [], signals: [], byCheck: {}, durationMs: 0,
  };
  const defaultCfg = buildQualityConfig();
  const defaultScore = scoreQuality(report, defaultCfg);
  assert.equal(defaultScore.overall, 100);
  assert.equal(defaultScore.grade, "A");
  // Override A boundary to 95 → a 100 score is still A; to test the boundary
  // matters, build a report with a penalty that lands overall at 90.
  const report90 = {
    ...report,
    findings: [{
      checkId: "dead-code" as const, severity: "error" as const,
      filePath: "x", line: 1, column: 0, symbol: null,
      message: "m", extra: {},
    }],
  };
  // With one error finding on 1 KLOC: penalty = severityPenalty.error (4) * precision (high=1.0) / kloc(1) = 4.
  // category correctness cap = 40, so cappedPenalty = 4, overall = 96 → A (≥90).
  const s96 = scoreQuality(report90, defaultCfg);
  assert.equal(s96.overall, 96);
  assert.equal(s96.grade, "A");
  // Now override A boundary to 97 → 96 should become B.
  const cfgA97 = buildQualityConfig({ scoringGradeBoundaries: { a: 97, b: 80, c: 70, d: 60 } });
  const s96b = scoreQuality(report90, cfgA97);
  assert.equal(s96b.grade, "B", "overriding gradeBoundaries must change the grade (proves the value flows THROUGH)");
});

test("R47-F2: monitorDelta impact respects config-overridden severityPenalty", async () => {
  const { monitorDelta } = await import("../../src/quality/monitoring.ts");
  const { buildQualityConfig } = await import("../../src/quality/config.ts");
  const emptyReport = {
    codebasePath: "x", language: "typescript" as const, generatedAt: "t",
    files: { scanned: 0, parsed: 0, parseErrors: 0, loc: 0 },
    findings: [], signals: [], byCheck: {}, durationMs: 0,
  };
  const reportWithOneError = {
    ...emptyReport,
    files: { scanned: 1, parsed: 1, parseErrors: 0, loc: 1000 },
    findings: [{
      checkId: "dead-code" as const, severity: "error" as const,
      filePath: "x", line: 1, column: 0, symbol: null,
      message: "m", extra: {},
    }],
  };
  // before has 0 findings, after has 1 error finding → impact = -severityPenalty.error.
  const defaultCfg = buildQualityConfig();
  const dflt = monitorDelta(emptyReport, reportWithOneError, defaultCfg);
  assert.equal(dflt.impact, -4, `default error penalty is 4 (impact=${dflt.impact})`);
  // Override error penalty to 10 → impact must be -10 (proves config flows through).
  const cfg10 = buildQualityConfig({ scoringSeverityPenalty: { error: 10, warning: 1.5, info: 0.5 } });
  const overridden = monitorDelta(emptyReport, reportWithOneError, cfg10);
  assert.equal(overridden.impact, -10, `overridden error penalty is 10 (impact=${overridden.impact}) — proves monitoring uses config, not a local duplicate`);
});

// ── G. tool-adapter no-op removed ───────────────────────────────────────

test("R47-G: tool-adapter no-op conditional spread is gone", () => {
  const src = readRel("src/tools/tool-adapter.ts");
  // The dead `...(input.correlation!== undefined? {}: {})` always spread
  // `{}` — a no-op that was likely meant to attach correlation. Removed.
  assert.equal(codeMatches(src, /\?\s*\{\s*\}\s*:\s*\{\s*\}/u).length, 0, "tool-adapter must not contain the `? {} : {}` no-op spread");
});

// ── H. tree-sitter-loader: no broken subpath resolve, no throw new Error ─

test("R47-H1: tree-sitter-loader does not resolve the unsupported `/package.json` subpath", () => {
  const src = readRel("src/quality/languages/shared/tree-sitter-loader.ts");
  // The `web-tree-sitter` `exports` map does not expose `./package.json` on
  // ≥ 0.25 (ERR_PACKAGE_PATH_NOT_EXPORTED). The loader must resolve the
  // package dir via the main entry + walk-up, not the package.json subpath.
  assert.equal(codeMatches(src, /require\.resolve\(\s*TS_REQUIRE_PATH\s*\+\s*["']\/package\.json["']\s*\)/u).length, 0, "tree-sitter-loader must not resolve the unsupported `/package.json` subpath");
});

test("R47-H2: tree-sitter-loader uses typed HarnessError (no throw new Error)", () => {
  const src = readRel("src/quality/languages/shared/tree-sitter-loader.ts");
  assert.equal(codeMatches(src, /\bthrow\s+new\s+Error\s*\(/u).length, 0, "tree-sitter-loader must use HarnessError, not throw new Error");
  assert.ok(/import\s*\{[^}]*HarnessError/u.test(src), "tree-sitter-loader must import HarnessError");
});

// ── Mutation guards (reintroducing a bug must FAIL a test) ──────────────

test("R47-mutation: reintroducing combineMcpSignals in tools/ fails A1", () => {
  // The detector must still fire on the mutation shape even though the MCP
  // adapter moved to `src/mcp/` (the tools/ scope is unchanged).
  const src = readRel("src/tools/tool-adapter.ts") + "\nfunction combineMcpSignals(s: readonly (AbortSignal|undefined)[]): AbortSignal|undefined { return undefined; }\n";
  assert.ok(codeMatches(src, /\bfunction\s+combineMcpSignals\s*\(/u).length > 0, "mutation harness sanity");
});

test("R47-mutation: reintroducing `?? 20` in scoring fails B3", () => {
  const src = readRel("src/quality/scoring.ts") + "\nconst _mutant = (x: number) => x ?? 20;\n";
  assert.ok(codeMatches(src, /\?\?\s*20\b/u).length > 0, "mutation harness sanity");
});
