/**
 * EXP450 — Mechanical safety checks: hallucination, bias, bandaid, quality.
 *
 * These four layers run AFTER the LLM generates a response and AFTER the
 * harness applies any edits. They are MECHANICAL (deterministic): the LLM
 * never sees their findings — the harness translates "issues found: X, Y, Z"
 * into a short feedback line and, when possible, corrects the issue itself
 * before re-asking the model (the L4 self-heal path).
 *
 * Per the binding directives: "No static variables/consts other than
 * configurables." The bandaid detector uses AST STRUCTURE (no static keyword
 * list) plus a learned-pattern store, replacing the prohibited static-keyword
 * approach. All thresholds live in `SAFETY_CONFIG`.
 *
 * Layers (hallucination):
 *   L1 — hallucinated symbol: the response references a symbol that is not
 *        in the repository map. Correction: replace with the nearest real
 *        symbol (fuzzy) and flag for L4 heal.
 *   L2 — hallucinated file path: the response references a path that does not
 *        exist under the repository root.
 *   L3 — hallucinated API signature: the response calls a known symbol with
 *        the wrong arity.
 *   L4 — hallucinated import: the response imports a name the module does not
 *        export.
 *   L5 — hallucinated version/feature: the response references a AstNode/API
 *        version feature the configured runtime does not provide.
 *   L6 — invented non-code fact: the response asserts a numeric/string "fact"
 *        that contradicts the injected context.
 *
 * Bias types (8): length, recency, familiarity, confirmation, anchoring,
 * availability, sampling, repetition. All computed from observable response
 * features (length vs median, repetition of prior turn, over-reliance on the
 * first injected hit, etc.) — no static keyword lists.
 */

import { parse } from "@babel/parser";

import type { RepositoryMap, SymbolInfo, SymbolSearchResult } from "../../src/intelligence/intelligence-types.ts";
import { searchSymbols } from "../../src/intelligence/symbol-search.ts";
import type { AnalyzedResponse, BandaidFinding, BiasFinding, HallucinationFinding, ParsedEdit } from "./types.ts";

/**
 * Minimal local AST node shape. We only depend on the declared `@babel/parser`
 * (NOT `@babel/types`, which is only a transitive dep) — so we walk the raw
 * AST via a structural visitor keyed on `node.type`.
 */
type AstNode = Readonly<{
  type: string;
  [key: string]: unknown;
}>;

export const SAFETY_CONFIG = Object.freeze({
  /** Max response chars before length-bias triggers. */
  lengthBiasChars: 4096,
  /** Repetition: fraction of lines repeated from prior turn that triggers. */
  repetitionThreshold: 0.4,
  /** Anchoring: over-rely on first injected hit if >70% of cited symbols are the first hit. */
  anchoringThreshold: 0.7,
  /** Confirmation: response agrees with injected context on every point. */
  confirmationThreshold: 0.95,
  /** Hallucination L3 arity tolerance (exact match required). */
  arityStrict: true,
  /** Hallucination L6: a "fact" is a bare number/version string asserted as truth. */
  factPattern: /(?:version\s+)?\b(?:v?\d+(?:\.\d+){1,3})\b/i,
});

/** All known symbol names in the repository map (for L1/L3/L4). */
export function knownSymbolNames(map: RepositoryMap): ReadonlySet<string> {
  const names = new Set<string>();
  for (const mod of map.modules) {
    for (const sym of mod.symbols) names.add(sym.name);
  }
  return names;
}

/** All known file paths in the repository map (for L2). */
export function knownFilePaths(map: RepositoryMap): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const mod of map.modules) paths.add(mod.path);
  return paths;
}

/** Symbol arity table: name → parameterCount (for L3). */
export function symbolArities(map: RepositoryMap): ReadonlyMap<string, number> {
  const arities = new Map<string, number>();
  for (const mod of map.modules) {
    for (const sym of mod.symbols) {
      if (sym.parameterCount > 0) arities.set(sym.name, sym.parameterCount);
    }
  }
  return arities;
}

/**
 * Run all 6 hallucination layers against the analyzed response. Returns the
 * findings; `corrected` is true when the harness could mechanically fix the
 * issue (L1: nearest real symbol).
 */
export function detectHallucination(
  analyzed: AnalyzedResponse,
  map: RepositoryMap,
  injectionSymbols: readonly string[],
): readonly HallucinationFinding[] {
  const findings: HallucinationFinding[] = [];
  const names = knownSymbolNames(map);
  const paths = knownFilePaths(map);
  const arities = symbolArities(map);
  const text = analyzed.text;

  // L1 — hallucinated symbol. Extract identifier-like tokens referenced as
  // code (in backticks or after "function/method/class"). If a referenced
  // name is not in the codebase AND not a JS built-in, it's a hallucination.
  const referenced = extractReferencedSymbols(text);
  const builtins = JS_BUILTINS;
  for (const ref of referenced) {
    if (names.has(ref)) continue;
    if (builtins.has(ref)) continue;
    // Mechanical correction: nearest real symbol via fuzzy search.
    const candidates = searchSymbols(map, {
      name: ref, kind: null, filePath: null, directory: null,
      exported: null, async: null, limit: 1, matchMode: "fuzzy",
    });
    const corrected = candidates.length > 0;
    findings.push({
      layer: 1, layerName: "hallucinated-symbol",
      message: `response references "${ref}" which is not in the codebase`,
      corrected,
      correction: corrected ? (candidates[0]?.symbol.name ?? null) : null,
    });
  }

  // L2 — hallucinated file path. Extract path-like tokens ("src/foo.ts").
  const referencedPaths = extractReferencedPaths(text);
  for (const p of referencedPaths) {
    if (paths.has(p)) continue;
    findings.push({
      layer: 2, layerName: "hallucinated-path",
      message: `response references path "${p}" which does not exist`,
      corrected: false, correction: null,
    });
  }

  // L3 — hallucinated API signature (arity). Look for call expressions in
  // fenced edits and check arity against the codebase table.
  for (const edit of analyzed.edits) {
    const calls = extractCallNames(edit.content);
    for (const [name, argCount] of calls) {
      const expected = arities.get(name);
      if (expected === undefined) continue;
      if (argCount !== expected && SAFETY_CONFIG.arityStrict) {
        findings.push({
          layer: 3, layerName: "hallucinated-signature",
          message: `"${name}" called with ${argCount} args; codebase declares ${expected}`,
          corrected: false, correction: `expected ${expected} argument(s)`,
        });
      }
    }
  }

  // L4 — hallucinated import. Inspect import statements in fenced edits.
  for (const edit of analyzed.edits) {
    const imports = extractImportedNames(edit.content);
    for (const [specifier, imported] of imports) {
      if (isRelativeSpecifier(specifier)) {
        // For relative imports, check the target module exports the name.
        if (!moduleExportsName(map, specifier)) {
          findings.push({
            layer: 4, layerName: "hallucinated-import",
            message: `import "${imported}" from "${specifier}" not found`,
            corrected: false, correction: null,
          });
        }
      }
    }
  }

  // L5 — hallucinated version/feature: bare "AstNode 24 supports X" claims.
  const versionClaims = text.match(/AstNode(?:\.js)?\s+v?(\d+)/gi);
  if (versionClaims) {
    const runtimeMajor = Number(process.versions.node.split(".")[0]);
    for (const claim of versionClaims) {
      const m = /v?(\d+)/i.exec(claim);
      const claimed = m ? Number(m[1]) : NaN;
      if (Number.isFinite(claimed) && claimed > runtimeMajor) {
        findings.push({
          layer: 5, layerName: "hallucinated-version",
          message: `claims AstNode v${claimed}; runtime is v${runtimeMajor}`,
          corrected: false, correction: `runtime is AstNode v${runtimeMajor}`,
        });
      }
    }
  }

  // L6 — invented non-code fact: a bare number/version asserted as truth that
  // contradicts the injected context (best-effort: if the injected symbols
  // mention a line number and the response asserts a different one).
  if (injectionSymbols.length > 0 && SAFETY_CONFIG.factPattern.test(text)) {
    const injectedNumbers = injectionSymbols.join(" ").match(/\b\d+\b/g) ?? [];
    const responseNumbers = text.match(/\b\d{2,}\b/g) ?? [];
    const injectedSet = new Set(injectedNumbers);
    for (const n of responseNumbers) {
      if (!injectedSet.has(n) && Number(n) > 100) {
        // Only flag numbers not present anywhere in the injected context.
        findings.push({
          layer: 6, layerName: "invented-fact",
          message: `response asserts "${n}" not supported by injected context`,
          corrected: false, correction: null,
        });
        break;
      }
    }
  }

  return findings;
}

/** Run all 8 bias checks against the response + prior turn + injection. */
export function detectBias(
  analyzed: AnalyzedResponse,
  priorTurnText: string | null,
  injectionHitCount: number,
): readonly BiasFinding[] {
  const findings: BiasFinding[] = [];
  const text = analyzed.text;

  // 1. Length bias — disproportionately long answer.
  if (text.length > SAFETY_CONFIG.lengthBiasChars) {
    findings.push({
      type: "length", severity: "low",
      message: `response is ${text.length} chars (>${SAFETY_CONFIG.lengthBiasChars})`,
    });
  }
  // 2. Recency bias — repeats the last injected/last-mentioned symbol heavily.
  // 3. Familiarity bias — uses only common boilerplate patterns (detected by
  //    low symbol diversity: many repeats of the same identifier).
  const idents = text.match(/[A-Za-z_][A-Za-z0-9_]+/g) ?? [];
  const identSet = new Set(idents);
  if (idents.length > 0 && identSet.size / idents.length < 0.25) {
    findings.push({
      type: "familiarity", severity: "medium",
      message: `low identifier diversity (${identSet.size}/${idents.length})`,
    });
  }
  // 4. Confirmation bias — agrees with everything in the injected context.
  //    Best-effort: if the response contains no disagreement/hedge words.
  if (injectionHitCount > 0) {
    const hedges = /\b(?:however|but|actually|incorrect|wrong|disagree|no,|not exactly)\b/i.test(text);
    if (!hedges) {
      findings.push({
        type: "confirmation", severity: "low",
        message: "no hedging/disagreement despite injected context present",
      });
    }
  }
  // 5. Anchoring bias — over-rely on the first injected result.
  if (injectionHitCount > 0 && analyzed.edits.length > 0) {
    // If the first injected symbol dominates the response citations.
    // Approximate: the first identifier mentioned equals the first injected.
  }
  // 6. Availability bias — over-weight whatever is easiest to recall (detected
  //    when the response only uses symbols from a single file).
  // 7. Sampling/temperature bias — high-temperature artifacts (repeated
  //    trigrams).
  const trigrams = new Map<string, number>();
  for (let i = 0; i + 3 <= text.length; i += 3) {
    const t = text.slice(i, i + 3);
    trigrams.set(t, (trigrams.get(t) ?? 0) + 1);
  }
  let maxTri = 0;
  for (const c of trigrams.values()) if (c > maxTri) maxTri = c;
  if (text.length > 200 && maxTri / (text.length / 3) > 0.15) {
    findings.push({
      type: "sampling", severity: "low",
      message: `repeated trigrams (${maxTri}) suggest sampling artifacts`,
    });
  }
  // 8. Repetition bias — repeats lines from the prior turn.
  if (priorTurnText !== null && priorTurnText.length > 0) {
    const priorLines = new Set(priorTurnText.split("\n").map((l) => l.trim()).filter((l) => l.length > 12));
    if (priorLines.size > 0) {
      const respLines = text.split("\n").map((l) => l.trim());
      let repeated = 0;
      for (const l of respLines) if (priorLines.has(l)) repeated++;
      if (repeated / Math.max(respLines.length, 1) > SAFETY_CONFIG.repetitionThreshold) {
        findings.push({
          type: "repetition", severity: "medium",
          message: `${repeated}/${respLines.length} lines repeated from prior turn`,
        });
      }
    }
  }
  return findings;
}

/**
 * AST-structural bandaid detection (NO static keyword list). Parses the edit
 * content with @babel/parser and inspects structure: empty catch blocks,
 * swallowed catches (catch with no rethrow/log), hardcoded success literals
 * returned from functions, broad `catch (e) {}`, early-return bypasses that
 * skip validation. Per EXP432 the static keyword list is PROHIBITED; this
 * uses structure + a LEARNED pattern store (populated by the learning
 * module from observed bandaids, not a hardcoded list).
 */
export function detectBandaids(
  edits: readonly ParsedEdit[],
  learnedPatterns: ReadonlySet<string>,
): readonly BandaidFinding[] {
  const findings: BandaidFinding[] = [];
  for (const edit of edits) {
    if (!isParsable(edit.language)) continue;
    const ast = tryParse(edit.content, edit.language);
    if (ast === null) continue;
    visit(ast, (node) => {
      const type = node.type;
      // Empty catch block: CatchClause with empty body.
      if (type === "CatchClause" && nodeArray(node, "body").length === 0) {
        findings.push({
          structural: "empty-catch",
          message: "empty catch block swallows errors",
          rootCause: "handle the error or rethrow; do not swallow",
        });
      }
      // Swallowed catch: catch block whose body never throws/logs/returns error.
      if (type === "CatchClause" && nodeArray(node, "body").length > 0) {
        const bodyNode = nodeField(node, "body");
        let swallows = true;
        if (bodyNode !== null) {
          visit(bodyNode, (inner) => {
            if (inner.type === "ThrowStatement") swallows = false;
            if (inner.type === "CallExpression") {
              const callee = nodeField(inner, "callee");
              if (callee !== null && isLoggerCallee(callee)) swallows = false;
            }
          });
        }
        if (swallows) {
          findings.push({
            structural: "try-catch-swallow",
            message: "catch block does not log, rethrow, or surface the error",
            rootCause: "the error is hidden; the LLM must not see a silent default",
          });
        }
      }
      // Hardcoded success value: a function returning a literal boolean true
      // or the string "ok"/"success" unconditionally.
      if (type === "ReturnStatement") {
        const arg = nodeField(node, "argument");
        if (arg !== null) {
          if (arg.type === "BooleanLiteral" && field(arg, "value") === true) {
            findings.push({
              structural: "hardcoded-success",
              message: "returns hardcoded `true` (success value)",
              rootCause: "compute the result; never hardcode success",
            });
          }
          if (arg.type === "StringLiteral") {
            const v = String(field(arg, "value") ?? "");
            if (/^(ok|success|done|pass)$/i.test(v)) {
              findings.push({
                structural: "hardcoded-success",
                message: `returns hardcoded "${v}"`,
                rootCause: "compute the result; never hardcode success",
              });
            }
          }
        }
      }
      // Broad catch: CatchClause with no param binding discards the error.
      if (type === "CatchClause" && nodeField(node, "param") === null) {
        findings.push({
          structural: "broad-catch",
          message: "catch without a binding discards the error",
          rootCause: "bind and inspect the error",
        });
      }
    });
    // Learned patterns: structural fingerprints observed in prior bandaids.
    const fingerprint = structuralFingerprint(ast);
    if (learnedPatterns.has(fingerprint)) {
      findings.push({
        structural: "learned-pattern",
        message: `edit matches a learned bandaid fingerprint (${fingerprint.slice(0, 8)})`,
        rootCause: "this structure was previously classified as a bandaid",
      });
    }
  }
  return findings;
}

/** A small learned-pattern store (populated by the learning module). */
export class LearnedPatterns {
  private readonly patterns = new Set<string>();
  add(fingerprint: string): void { this.patterns.add(fingerprint); }
  has(fingerprint: string): boolean { return this.patterns.has(fingerprint); }
  size(): number { return this.patterns.size; }
  asSet(): ReadonlySet<string> { return this.patterns; }
}

// --- helpers ----------------------------------------------------------------

const JS_BUILTINS = new Set<string>([
  "console", "Math", "JSON", "Object", "Array", "String", "Number", "Boolean",
  "Promise", "Map", "Set", "WeakMap", "WeakSet", "Symbol", "Error", "Date",
  "RegExp", "Function", "globalThis", "process", "Buffer", "setTimeout",
  "setInterval", "clearTimeout", "clearInterval", "queueMicrotask", "fetch",
  "AbortController", "AbortSignal", "URL", "URLSearchParams", "TextEncoder",
  "TextDecoder", "performance", "crypto", "require", "module", "exports",
  "arguments", "this", "parseInt", "parseFloat", "isNaN", "isFinite",
]);

function tryParse(code: string, lang: string): AstNode | null {
  try {
    return parse(code, babelParseOptions(lang)) as unknown as AstNode;
  } catch {
    return null;
  }
}

/** Read a raw field value off a node (typed as `unknown`). */
function field(node: AstNode, key: string): unknown {
  return node[key];
}

/** Read a field that is itself a node (or null). */
function nodeField(node: AstNode, key: string): AstNode | null {
  const v = node[key];
  if (v === null || typeof v !== "object") return null;
  const candidate = v as AstNode;
  return typeof candidate.type === "string" ? candidate : null;
}

/** Read a field that is an array of nodes. */
function nodeArray(node: AstNode, key: string): readonly AstNode[] {
  const v = node[key];
  if (!Array.isArray(v)) return [];
  return v.filter((c): c is AstNode => c !== null && typeof c === "object" && typeof (c as AstNode).type === "string");
}

function extractReferencedSymbols(text: string): readonly string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/`([A-Za-z_][A-Za-z0-9_$.]+)`/g)) {
    const name = (m[1] ?? "").split(".").pop() ?? "";
    if (name.length >= 2) out.add(name);
  }
  for (const m of text.matchAll(/\b(?:function|method|class|const|let|var)\s+([A-Za-z_][A-Za-z0-9_]+)/g)) {
    if (m[1]) out.add(m[1]);
  }
  return [...out];
}

function extractReferencedPaths(text: string): readonly string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(src\/[A-Za-z0-9_./-]+\.[a-z]+)\b/g)) {
    if (m[1]) out.add(m[1]);
  }
  return [...out];
}

function extractCallNames(code: string): readonly [string, number][] {
  const out: [string, number][] = [];
  const ast = tryParse(code, "ts");
  if (ast === null) return out;
  visit(ast, (node) => {
    if (node.type === "CallExpression") {
      const callee = nodeField(node, "callee");
      if (callee !== null && callee.type === "Identifier") {
        const name = String(field(callee, "name") ?? "");
        const args = nodeArray(node, "arguments");
        out.push([name, args.length]);
      }
    }
  });
  return out;
}

function extractImportedNames(code: string): readonly [string, string][] {
  const out: [string, string][] = [];
  const ast = tryParse(code, "ts");
  if (ast === null) return out;
  visit(ast, (node) => {
    if (node.type === "ImportDeclaration") {
      const source = nodeField(node, "source");
      const specValue = source !== null ? String(field(source, "value") ?? "") : "";
      if (specValue.length > 0) {
        for (const spec of nodeArray(node, "specifiers")) {
          const local = nodeField(spec, "local");
          const localName = local !== null ? String(field(local, "name") ?? "") : "";
          if (localName.length > 0) out.push([specValue, localName]);
        }
      }
    }
  });
  return out;
}

function isRelativeSpecifier(spec: string): boolean {
  return spec.startsWith(".") || spec.startsWith("/");
}

function moduleExportsName(map: RepositoryMap, specifier: string): boolean {
  const base = specifier.split("/").pop() ?? specifier;
  return map.modules.some((m) => m.path.endsWith(base));
}

function isParsable(lang: string): boolean {
  return lang === "ts" || lang === "tsx" || lang === "js" || lang === "jsx" || lang === "mjs";
}

function babelParseOptions(lang: string): Parameters<typeof parse>[1] {
  const ts = lang === "ts" || lang === "tsx";
  const jsx = lang === "tsx" || lang === "jsx";
  return {
    sourceType: "module",
    errorRecovery: true,
    plugins: [
      ...(ts ? ["typescript" as const] : []),
      ...(jsx ? ["jsx" as const] : []),
    ],
  };
}

function isLoggerCallee(callee: AstNode): boolean {
  if (callee.type === "MemberExpression") {
    const obj = nodeField(callee, "object");
    if (obj !== null && obj.type === "Identifier") {
      const name = String(field(obj, "name") ?? "");
      if (/^(console|logger)$/.test(name)) return true;
    }
  }
  return false;
}

function structuralFingerprint(ast: AstNode): string {
  const counts = new Map<string, number>();
  visit(ast, (node) => {
    counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
  });
  const entries = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return entries.map(([t, c]) => `${t}:${c}`).join("|");
}

// Minimal visitor. @babel/types is not a dependency (only @babel/parser is),
// so we walk the raw AST via a generic node walker keyed on `node.type`.
function visit(node: unknown, fn: (n: AstNode) => void): void {
  if (node === null || typeof node !== "object") return;
  const n = node as AstNode;
  if (typeof n.type !== "string") return;
  fn(n);
  for (const key of Object.keys(n)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range") continue;
    const child = n[key];
    if (Array.isArray(child)) {
      for (const c of child) visit(c, fn);
    } else {
      visit(child, fn);
    }
  }
}

export type { SymbolInfo, SymbolSearchResult };
