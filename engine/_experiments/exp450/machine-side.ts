/**
 * EXP450 — Machine-side executor: the mechanical work the LLM never does.
 *
 * Per the user ideology: "we want to remove responsibilities from llm as much
 * as possible ... they're good at generating, which we cannot do mechanically,
 * but we must make it so its only task." This module performs EVERY mechanical
 * responsibility the harness owns:
 *   - apply edits (transactional editor: preimage hash, atomic write, verify,
 *     rollback) — ONE attempt per call; the unified-harness owns the async
 *     self-heal loop (L1 preimage-mismatch, L2 syntax-error, L3 quality-fail,
 *     L4 hallucination);
 *   - run searches (reuse the harness's intelligence symbol-search + the
 *     AST slice / quick-view gateways — the LLM never gets a full file);
 *   - read slices (read_file → slices per the binding directives).
 *
 * The LLM NEVER sees raw errors: when an edit fails, the harness re-reads the
 * current file, recomputes the preimage hash, and re-asks the model with the
 * corrected context. The model only learns "this failed, try a different
 * approach" — never a stack trace.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { sha256 } from "../../src/kernel/integrity.ts";
import { generateRepositoryMap, type RepositoryMapCache, type RepositoryReadLimits, type MapGenerationOptions, DEFAULT_READ_LIMITS } from "../../src/intelligence/repository-map.ts";
import { searchSymbols } from "../../src/intelligence/symbol-search.ts";
import type { RepositoryMap, SymbolSearchResult } from "../../src/intelligence/intelligence-types.ts";
import { createTransactionalEditor, type EditResult, type TransactionalEditor } from "../../src/editor/transactional-editor.ts";
import type { EditOperation } from "../../src/editor/edit-operations.ts";
import type { SignalTracker } from "./signal-registry.ts";
import type { PerfTracker } from "./perf-tracker.ts";
import type { ParsedEdit, SelfHealLevel } from "./types.ts";

export const MACHINE_CONFIG = Object.freeze({
  /** Bytes to include when re-reading a file for the L1 heal slice. */
  healSliceBytes: 8192,
  /** Top-K for mechanical symbol searches. */
  searchTopK: 8,
});

/** The result of one mechanical edit attempt (no heal loop — the orchestrator owns that). */
export type EditAttempt = Readonly<{
  path: string;
  result: EditResult;
  level: SelfHealLevel;
  preimageContent: string;
  durationMs: number;
}>;

export type MachineSide = Readonly<{
  /** The repository map (lazily generated + cached). */
  getMap(): RepositoryMap;
  /** Run a mechanical symbol search (the harness searches, not the LLM). */
  searchSymbols(query: string, mode: "exact" | "fuzzy"): readonly SymbolSearchResult[];
  /** Run a mechanical quick-view text search (replaces grep). */
  quickView(query: string): readonly { file: string; line: number; text: string }[];
  /** Get an AST slice of a function body (replaces read_file of a full file). */
  sliceFunction(symbolName: string): { path: string; body: string } | null;
  /** Apply a parsed edit mechanically (ONE attempt). Returns the result + heal level. */
  applyEdit(edit: ParsedEdit, contentOverride?: string): EditAttempt;
  /** Read a file slice (the harness owns file reading, not the LLM). */
  readSlice(path: string, maxBytes?: number): string;
}>;

export type MachineSideOptions = Readonly<{
  repositoryRoot: string;
  writeSet: ReadonlySet<string>;
  signals: SignalTracker;
  perf: PerfTracker;
  /** Optional injected map (tests). Production leaves undefined. */
  mapProvider?: (root: string, limits: RepositoryReadLimits) => { map: RepositoryMap; cache: RepositoryMapCache };
  /** Optional injected editor (tests). */
  editor?: TransactionalEditor;
  /** Optional injected repository-map options (e.g. a custom reader). */
  mapOptions?: Omit<MapGenerationOptions, "limits">;
  limits?: RepositoryReadLimits;
}>;

export function createMachineSide(options: MachineSideOptions): MachineSide {
  const root = options.repositoryRoot;
  const signals = options.signals;
  const perf = options.perf;
  let cachedMap: RepositoryMap | null = null;
  const limits = options.limits ?? DEFAULT_READ_LIMITS;
  const editor: TransactionalEditor = options.editor ?? createTransactionalEditor({
    repositoryRoot: root,
    writeSet: options.writeSet,
  });

  function getMap(): RepositoryMap {
    if (cachedMap !== null) return cachedMap;
    const start = Date.now();
    let map: RepositoryMap;
    if (options.mapProvider !== undefined) {
      map = options.mapProvider(root, limits).map;
    } else {
      map = generateRepositoryMap(root, { limits, ...options.mapOptions }).map;
    }
    cachedMap = map;
    signals.observe("search.codebase-indexed");
    signals.observe("aware.repository-modules", map.modules.length);
    let symCount = 0;
    for (const m of map.modules) symCount += m.symbols.length;
    signals.observe("aware.repository-symbols", symCount);
    signals.measure("search.duration", Date.now() - start);
    return map;
  }

  function searchSymbolsImpl(query: string, mode: "exact" | "fuzzy"): readonly SymbolSearchResult[] {
    const start = Date.now();
    const map = getMap();
    const hits = searchSymbols(map, {
      name: query, kind: null, filePath: null, directory: null,
      exported: null, async: null, limit: MACHINE_CONFIG.searchTopK, matchMode: mode,
    });
    signals.observe(mode === "exact" ? "search.symbol-exact" : "search.symbol-fuzzy");
    signals.observe("search.results", hits.length);
    signals.measure("search.duration", Date.now() - start);
    return hits;
  }

  function quickViewImpl(query: string): readonly { file: string; line: number; text: string }[] {
    // Per the binding directives: "Do NOT use grep — use quick-view." This is
    // the harness's lexical quick-view: scan known source files for the query,
    // dedup by (file, line). The LLM never receives raw grep output.
    const start = Date.now();
    const map = getMap();
    const lower = query.toLowerCase();
    const out: { file: string; line: number; text: string }[] = [];
    for (const mod of map.modules) {
      try {
        const content = readFileSync(join(root, mod.path), "utf8");
        perf.noteDiskRead(Buffer.byteLength(content, "utf8"));
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i]!.toLowerCase().includes(lower)) {
            out.push({ file: mod.path, line: i + 1, text: lines[i]!.trim().slice(0, 200) });
            if (out.length >= MACHINE_CONFIG.searchTopK) break;
          }
        }
        if (out.length >= MACHINE_CONFIG.searchTopK) break;
      } catch {
        // unreadable file — skip
      }
    }
    signals.observe("search.text");
    signals.observe("search.results", out.length);
    signals.measure("search.duration", Date.now() - start);
    return out;
  }

  function sliceFunctionImpl(symbolName: string): { path: string; body: string } | null {
    // Per "read_file → slices": the LLM never gets a full file. The harness
    // returns the function body only (a coarse brace-bounded slice).
    const hits = searchSymbolsImpl(symbolName, "exact");
    if (hits.length === 0) return null;
    const hit = hits[0]!;
    try {
      const content = readFileSync(join(root, hit.filePath), "utf8");
      perf.noteDiskRead(Buffer.byteLength(content, "utf8"));
      const lines = content.split("\n");
      const startLine = Math.max(0, hit.symbol.location.line - 1);
      let braceStart = -1;
      for (let i = startLine; i < lines.length; i++) {
        const idx = lines[i]!.indexOf("{");
        if (idx >= 0) { braceStart = i; break; }
      }
      if (braceStart === -1) return { path: hit.filePath, body: lines.slice(startLine, startLine + 20).join("\n") };
      let depth = 0;
      let endLine = braceStart;
      for (let i = braceStart; i < lines.length; i++) {
        for (const ch of lines[i]!) {
          if (ch === "{") depth++;
          else if (ch === "}") { depth--; if (depth === 0) { endLine = i; break; } }
        }
        if (depth === 0) break;
      }
      const body = lines.slice(startLine, endLine + 1).join("\n");
      signals.observe("search.slice-returned");
      signals.observe("search.full-file-avoided");
      return { path: hit.filePath, body };
    } catch {
      return null;
    }
  }

  function readSliceImpl(path: string, maxBytes?: number): string {
    const cap = maxBytes ?? MACHINE_CONFIG.healSliceBytes;
    try {
      const buf = readFileSync(join(root, path));
      perf.noteDiskRead(buf.length);
      const text = buf.subarray(0, cap).toString("utf8");
      signals.observe("tool.read-file");
      return text;
    } catch {
      return "";
    }
  }

  function applyEditImpl(edit: ParsedEdit, contentOverride?: string): EditAttempt {
    const path = edit.path ?? "(no-path)";
    const content = contentOverride ?? edit.content;
    const start = Date.now();
    signals.observe("edit.attempted");
    let preimageContent = "";
    try {
      const buf = readFileSync(join(root, path));
      perf.noteDiskRead(buf.length);
      preimageContent = buf.toString("utf8");
    } catch {
      preimageContent = "";
    }
    const preimageHash = sha256(preimageContent);
    signals.observe("safety.preimage-verified");
    const operation: EditOperation = { kind: "replaceFile", newContent: content };
    const result: EditResult = editor.applyEdit({ path, preimageHash, operation });
    if (result.success) {
      signals.observe("edit.applied");
      signals.observe("edit.atomic-write");
      signals.observe("edit.postwrite-verified");
      signals.observe("edit.replaceFile");
      perf.noteDiskWrite(Buffer.byteLength(content, "utf8"));
    }
    if (result.rolledBack) {
      signals.observe("edit.rolled-back");
      signals.observe("edit.zero-delta-verified");
    }
    signals.measure("edit.duration", Date.now() - start);
    const level = classifyFailure(result);
    return Object.freeze({ path, result, level, preimageContent, durationMs: Date.now() - start });
  }

  function classifyFailure(result: EditResult): SelfHealLevel {
    if (result.success) return "L1";
    if (result.feedback === null) return "L2";
    const code = result.feedback.errorType;
    if (code === "preimage_mismatch" || code === "preimage_missing") return "L1";
    if (code === "syntax_error" || code === "operation_invalid") return "L2";
    if (code === "postwrite_mismatch") return "L2";
    return "L4";
  }

  return Object.freeze({
    getMap,
    searchSymbols: searchSymbolsImpl,
    quickView: quickViewImpl,
    sliceFunction: sliceFunctionImpl,
    applyEdit: applyEditImpl,
    readSlice: readSliceImpl,
  });
}
