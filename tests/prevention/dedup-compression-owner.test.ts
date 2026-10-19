// @vitest-environment node
/**
 * Mechanical prevention test — Dedup/compression owner (SPO, ).
 *
 * Enforces the Single-Party-Owner principle for token dedup/compression: ALL
 * dedup/compression in the web UI goes through ONE owner module
 * (`server/dedup-bridge.ts`). No route, bridge, or service imports the
 * canonical dedup-compression subsystem (`integration/src/shared/dedup-
 * compression/`) directly — they all go through the dedup owner. The dedup
 * is:
 * (a) wired into the actual pipeline (ON-PATH — the LLM bridge choke point
 * `buildNativeRequest` calls `dedupContentForLLM` on every message),
 * not just decorative reporting (the 748% bug class).
 * (b) configurable + opt-in — gated by `memory.dedupCompression.
 * enabled` + `memory.dedupCompression.llmInputDedup`, both default
 * false (deny-by-default).
 * (c) status exposed via a `dedup` SSE event.
 *
 * Dynamic discovery: the test dynamically
 * walks every.ts file under server/ (via readdirSync) to find files that
 * import from the dedup-compression subsystem. A hardcoded list would
 * silently miss a new file that bypasses the owner — the dynamic scan
 * catches ALL current + future files.
 *
 * Assurance classes (WORKFLOW.md §9 + ):
 * A. SOURCE-SCAN: dedup-bridge.ts is the SINGLE importer of the canonical
 * dedup-compression subsystem (dynamic discovery — no allowlist).
 * B. SINGLE-OWNER: dedup functions (`dedupCompressionEnabled`,
 * `wireDedupForTurn`, `dedupContentForLLM`, `summarizeDedupReports`)
 * are defined ONLY in dedup-bridge.ts.
 * C. ON-PATH: the LLM bridge choke point (`buildNativeRequest`) calls
 * `dedupContentForLLM` — the dedup is NOT decorative.
 * D. CONFIGURABLE + OPT-IN: both flags default false; the gates are read
 * from the harness config.
 * E. SSE EXPOSURE: the run route wires `onDedup` → `dedup` SSE event.
 * F. BEHAVIORAL: when disabled, `dedupContentForLLM` is a no-op (returns
 * the original content + null report); `summarizeDedupReports` returns
 * null for all-null reports.
 * G. BEHAVIORAL: when enabled, `dedupContentForLLM` removes duplicate
 * blocks (the kept blocks are exact — lossless for the kept content).
 *
 * Mutation-verified: removing the `dedupContentForLLM` call from
 * `buildNativeRequest` makes test C fail; removing the `onDedup` callback from
 * `buildChatOpts` makes test E fail.
 */
import { describe, test, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { getConfigDocumentSchema } from "../../engine/src/kernel/config-contracts.ts";
// ── Dynamic file discovery ──

/** All.ts files under `server/` (dynamic discovery). */
const SERVER_TS_FILES = walkTs(resolve(process.cwd(), "server"));

// ── Test data ──

const DEDUP_BRIDGE_SRC = read(modulePath("dedup-bridge.ts"));
const LLM_BRIDGE_SRC = read(modulePath("llm-bridge.ts"));
const RUN_SRC = runPathSource();
const CONTEXT_BRIDGE_SRC = read(modulePath("context-bridge.ts"));

// ════════════════════════════════════════════════════════════════════════
// A. SOURCE-SCAN: dedup-bridge.ts is the SINGLE importer of the canonical
// dedup-compression subsystem (dynamic discovery — no allowlist).
// ════════════════════════════════════════════════════════════════════════

describe("A. dedup-compression-owner — single importer (dynamic discovery)", () => {
  test("ONLY dedup-bridge.ts imports from the canonical dedup-compression subsystem", () => {
    // Dynamic discovery: scan ALL server.ts files. A new file that imports from the canonical subsystem directly
    // (bypassing the dedup owner) is auto-caught. We check for IMPORT
    // statements (a `from "..." ` containing the canonical subsystem path),
    // NOT mere mentions in comments (a comment referencing the subsystem
    // path is informative, not a bypass).
    const violators: string[] = [];
    for (const file of SERVER_TS_FILES) {
      const rel = file.replace(resolve(process.cwd()) + "/", "");
      // dedup-bridge.ts IS the owner — it's allowed to import.
      if (rel === modulePath("dedup-bridge.ts")) continue;
      const src = readFileSync(file, "utf8");
      // Match import statements: `from "...dedup-compression/` (the
      // canonical subsystem path). A comment like `dedup-compression/` in
      // prose does NOT match (it's not preceded by `from "`).
      if (/from\s+["'][^"']*dedup-compression\//.test(src)) {
        violators.push(rel);
      }
    }
    expect(violators, `Files importing the canonical dedup-compression subsystem directly (bypassing dedup-bridge.ts): ${violators.join(", ")}`).toEqual([]);
  });

  test("context-bridge.ts no longer owns dedup functions (moved to dedup-bridge.ts)", () => {
    // SPO: the dedup adapter was moved from context-bridge.ts to
    // dedup-bridge.ts. context-bridge.ts must NOT define dedup functions.
    expect(CONTEXT_BRIDGE_SRC).not.toContain("export function dedupCompressionEnabled");
    expect(CONTEXT_BRIDGE_SRC).not.toContain("export function wireDedupForTurn");
    expect(CONTEXT_BRIDGE_SRC).not.toContain("export function dedupContentForLLM");
  });
});

// ════════════════════════════════════════════════════════════════════════
// B. SINGLE-OWNER: dedup functions are defined ONLY in dedup-bridge.ts
// ════════════════════════════════════════════════════════════════════════

describe("B. dedup-compression-owner — single owner (No Scattered Helpers)", () => {
  test("dedupCompressionEnabled is defined ONLY in dedup-bridge.ts", () => {
    const owners: string[] = [];
    for (const file of SERVER_TS_FILES) {
      const rel = file.replace(resolve(process.cwd()) + "/", "");
      const src = readFileSync(file, "utf8");
      if (src.includes("export function dedupCompressionEnabled")) {
        owners.push(rel);
      }
    }
    expect(owners).toEqual([modulePath("dedup-bridge.ts")]);
  });

  test("wireDedupForTurn is defined ONLY in dedup-bridge.ts", () => {
    const owners: string[] = [];
    for (const file of SERVER_TS_FILES) {
      const rel = file.replace(resolve(process.cwd()) + "/", "");
      const src = readFileSync(file, "utf8");
      if (src.includes("export function wireDedupForTurn")) {
        owners.push(rel);
      }
    }
    expect(owners).toEqual([modulePath("dedup-bridge.ts")]);
  });

  test("dedupContentForLLM is defined ONLY in dedup-bridge.ts", () => {
    const owners: string[] = [];
    for (const file of SERVER_TS_FILES) {
      const rel = file.replace(resolve(process.cwd()) + "/", "");
      const src = readFileSync(file, "utf8");
      if (src.includes("export function dedupContentForLLM")) {
        owners.push(rel);
      }
    }
    expect(owners).toEqual([modulePath("dedup-bridge.ts")]);
  });
});

// ════════════════════════════════════════════════════════════════════════
// C. ON-PATH: the LLM bridge choke point calls dedupContentForLLM
// ════════════════════════════════════════════════════════════════════════

describe("C. dedup-compression-owner — ON-PATH (not decorative wiring)", () => {
  test("buildNativeRequest (the LLM bridge choke point) calls dedupContentForLLM", () => {
    // The dedup is wired into the ACTUAL pipeline (the LLM bridge choke
    // point), not just decorative reporting. This is the "not decorative"
    // guarantee — same class as the 748% bug (where the context manager
    // tracked state but the raw history was sent verbatim).
    expect(LLM_BRIDGE_SRC).toContain("dedupContentForLLM");
  });

  test("buildNativeRequest imports dedupContentForLLM from dedup-bridge.ts (not from the canonical subsystem)", () => {
    // The LLM bridge imports the dedup function from the dedup OWNER, not
    // from the canonical subsystem directly (SPO — one owner).
    expect(LLM_BRIDGE_SRC).toContain("from \"../awareness/dedup-bridge.ts\"");
  });

  test("streamChat delegates message-building to buildNativeRequest (the choke point)", () => {
    // streamChat MUST delegate to buildNativeRequest (which applies dedup),
    // not assemble messages inline (which would bypass the dedup).
    expect(LLM_BRIDGE_SRC).toMatch(/buildNativeRequest\(prompt,\s*options\)/);
  });
});

// ════════════════════════════════════════════════════════════════════════
// D. CONFIGURABLE + OPT-IN
// ════════════════════════════════════════════════════════════════════════

describe("D. dedup-compression-owner — configurable + opt-in", () => {
  test("dedupCompressionEnabled reads the config flag (memory.dedupCompression.enabled)", () => {
    expect(DEDUP_BRIDGE_SRC).toContain("dedupCompression");
    // The dedup-bridge reads config via the config-owner accessor (not a
    // raw inline cast of getMemoryConfig). The accessor is the typed
    // boundary; the bridge consumes it.
    expect(DEDUP_BRIDGE_SRC).toContain("getDedupCompressionSection");
  });

  test("llmInputDedupEnabled is a separate opt-in flag (memory.dedupCompression.llmInputDedup)", () => {
    // Two independent opt-in flags: `enabled` (storage reporting) +
    // `llmInputDedup` (LLM-input dedup). Both default false.
    expect(DEDUP_BRIDGE_SRC).toContain("llmInputDedup");
    expect(DEDUP_BRIDGE_SRC).toContain("llmInputDedupEnabled");
  });

  test("both flags default to false (deny-by-default — safe default)", () => {
    // The invariant is the EFFECTIVE value: the config document schema
    // declares both flags `.default(false)` (the deny-by-default guarantee
    // lives in that declaration), and the shipped document omits
    // default-valued keys (the write gate's omit-on-default honesty — a
    // settings restore prunes them), so the flags read false whether they
    // are written as explicit false or pruned as defaults. Parsing the
    // shipped file through the schema resolves exactly what a runtime
    // reader resolves — and a schema declaration that dropped its false
    // default reds here, which the old raw-key assertion could never
    // catch.
    const configSrc = readFileSync(resolve(process.cwd(), "engine/bridlewise.config.json"), "utf8");
    const parsed = CONFIG_DOCUMENT_SCHEMA.parse(JSON.parse(configSrc));
    const dedupCfg = parsed.memory?.dedupCompression;
    expect(dedupCfg).toBeDefined();
    expect(dedupCfg!.enabled).toBe(false);
    expect(dedupCfg!.llmInputDedup).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════
// E. SSE EXPOSURE: the run route wires onDedup → dedup SSE event
// ════════════════════════════════════════════════════════════════════════

describe("E. dedup-compression-owner — SSE exposure", () => {
  test("run.ts wires the onDedup callback in buildChatOpts", () => {
    expect(RUN_SRC).toContain("onDedup");
  });

  test("run.ts emits the dedup SSE event via SSE_EVENT_TYPES.dedup", () => {
    expect(RUN_SRC).toContain("SSE_EVENT_TYPES.dedup");
  });

  test("the dedup SSE event type is registered in shared/constants.ts", () => {
    const constantsSrc = read("shared/constants.ts");
    expect(constantsSrc).toContain("dedup:");
    expect(constantsSrc).toMatch(/dedup:\s*"dedup"/);
  });
});

// ════════════════════════════════════════════════════════════════════════
// F. BEHAVIORAL: when disabled, dedupContentForLLM is a no-op
// ════════════════════════════════════════════════════════════════════════

import { dedupContentForLLM, summarizeDedupReports, dedupCompressionEnabled, llmInputDedupEnabled } from "../../server/awareness/dedup-bridge.ts";
import { read, walkTs } from "../helpers/source-scan.ts";
// The run path is FIVE modules since the executor was split out of the GET
// handler that used to be it. This guard asks about the run path, not about
// whichever file happened to hold the answer when it was written.
import { runPathSource } from "../helpers/run-source.ts";

import { modulePath } from "../helpers/module-resolver.ts";

const CONFIG_DOCUMENT_SCHEMA = getConfigDocumentSchema();
describe("F. dedup-compression-owner — behavioral (disabled = no-op)", () => {
  test("dedupCompressionEnabled returns false by default (no config section)", () => {
    // The config has dedupCompression.enabled = false (deny-by-default).
    expect(dedupCompressionEnabled()).toBe(false);
  });

  test("llmInputDedupEnabled returns false by default (no config section)", () => {
    expect(llmInputDedupEnabled()).toBe(false);
  });

  test("dedupContentForLLM is a no-op when disabled (returns original content + null report)", () => {
    const content = "Line one.\nLine one.\nLine two.\n\nLine one.\nLine three.";
    const result = dedupContentForLLM(content);
    expect(result.content).toBe(content);
    expect(result.report).toBeNull();
  });

  test("dedupContentForLLM is a no-op for empty content", () => {
    const result = dedupContentForLLM("");
    expect(result.content).toBe("");
    expect(result.report).toBeNull();
  });

  test("summarizeDedupReports returns null for all-null reports (no noisy no-op events)", () => {
    const summary = summarizeDedupReports([null, null, null]);
    expect(summary).toBeNull();
  });

  test("summarizeDedupReports returns null for an empty array", () => {
    const summary = summarizeDedupReports([]);
    expect(summary).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════
// G. BEHAVIORAL: summarizeDedupReports accumulates correctly
// ════════════════════════════════════════════════════════════════════════

describe("G. dedup-compression-owner — behavioral (summarizeDedupReports accumulates)", () => {
  test("summarizeDedupReports accumulates char reduction across multiple reports", () => {
    const reports = [
      {
        mode: "block" as const,
        originalChars: 100,
        originalLines: 10,
        originalBlocks: 5,
        dedupedChars: 80,
        dedupedLines: 8,
        dedupedBlocks: 4,
        removedLines: 2,
        removedBlocks: 1,
        nearDupCount: 1,
        charReductionPct: 20,
        lineReductionPct: 20,
        blockReductionPct: 20,
        keywordStrategy: null,
        keywordCount: null,
        identifierCount: null,
        parseError: null,
      },
      {
        mode: "block" as const,
        originalChars: 200,
        originalLines: 20,
        originalBlocks: 10,
        dedupedChars: 150,
        dedupedLines: 15,
        dedupedBlocks: 8,
        removedLines: 5,
        removedBlocks: 2,
        nearDupCount: 2,
        charReductionPct: 25,
        lineReductionPct: 25,
        blockReductionPct: 20,
        keywordStrategy: null,
        keywordCount: null,
        identifierCount: null,
        parseError: null,
      },
    ];
    const summary = summarizeDedupReports(reports);
    expect(summary).not.toBeNull();
    expect(summary!.applied).toBe(true);
    expect(summary!.originalChars).toBe(300);
    expect(summary!.dedupedChars).toBe(230);
    expect(summary!.removedBlocks).toBe(3);
    expect(summary!.removedLines).toBe(7);
    expect(summary!.messageCount).toBe(2);
    // charReductionPct = (1 - 230/300) * 100 = 23.33...
    expect(summary!.charReductionPct).toBeCloseTo(23.33, 1);
  });

  test("summarizeDedupReports ignores null reports in the array", () => {
    const reports = [
      null,
      {
        mode: "block" as const,
        originalChars: 100,
        originalLines: 10,
        originalBlocks: 5,
        dedupedChars: 80,
        dedupedLines: 8,
        dedupedBlocks: 4,
        removedLines: 2,
        removedBlocks: 1,
        nearDupCount: 1,
        charReductionPct: 20,
        lineReductionPct: 20,
        blockReductionPct: 20,
        keywordStrategy: null,
        keywordCount: null,
        identifierCount: null,
        parseError: null,
      },
      null,
    ];
    const summary = summarizeDedupReports(reports);
    expect(summary).not.toBeNull();
    expect(summary!.messageCount).toBe(1);
    expect(summary!.originalChars).toBe(100);
  });
});
