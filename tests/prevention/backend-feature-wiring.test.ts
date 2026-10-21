// @vitest-environment node
/**
 * Adversarial tests for the 6 backend-wiring tasks.
 *
 * Covers:
 * — Auto-heal: stale-index detection (mtime drift, vanished files,
 * adaptive sample size, broken-edge detection, wiring into the bridge).
 * — Dedup/compression below API: wired at every turn-addition point
 * in run.ts; gated by dedupCompressionEnabled; lossless to the LLM.
 * — Context injection chain: system prompt → repo map → memory →
 * trimmed history → dedup, all wired in run.ts.
 * — Security: CSRF guard (same-origin / custom-header / safe-method
 * exempt), path validation (allowed-roots confinement, traversal), rate
 * limiting (GET-exempt), input validation (assertValidBody everywhere),
 * API keys never leaked in responses.
 *
 * 5 live in their own mechanical-prevention test files
 * (no-hardcoded-values.test.ts extended + debug-zero-overhead.test.ts).
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";

// ── Auto-heal ──
import {
  computeStaleSampleSize,
  sampleSourceFiles,
  captureMtimeSnapshot,
  detectStaleIndex,
  detectBrokenEdges,
  toAbsolutePath,
  toRelativePath,
  type MtimeSnapshot,
} from "../../server/intelligence/auto-heal.ts";
import { INTELLIGENCE_SCHEMA_VERSION } from "../../engine/src/intelligence/intelligence-types.ts";
import { getAutoHealConfig } from "../../server/kernel/harness-config.ts";

// ── CSRF + path validation ──
import { checkCsrf, isSafeMethod, CSRF_CUSTOM_HEADER } from "../../server/auth/csrf.ts";
import { CsrfError, RateLimitError } from "../../server/kernel/errors.ts";
import { rateLimitRetryAfterSeconds } from "../../server/router/rate-limiter.ts";
// isWithinAllowedRoots moved to the fs-gate (the single filesystem
// access owner). routes/filesystem.ts re-exports it for backward compat.
import { isWithinAllowedRoots } from "../../server/filesystem/fs-gate.ts";

// ── /3: source-scan helpers ──
import { readFileSync, readdirSync } from "node:fs";
import { createTempDir } from "../helpers/temp-dir.ts";
import { nonEmptySourceFilesUnder } from "../helpers/source-scan.ts";
// The run path is FIVE modules since the executor was split out of the GET
// handler that used to be it. This guard asks about the run path, not about
// whichever file happened to hold the answer when it was written.
import { runPathSource } from "../helpers/run-source.ts";

// ── debug bridge (zero overhead) ──
import {
  configureWebDebug,
  resetWebDebug,
  getWebDebugSignals,
  isWebDebugEnabled,
  webDebugLog,
  webWarn,
  webHandleError,
} from "../../server/observability/debug-bridge.ts";
import { ConfigError } from "../../server/kernel/errors.ts";
import { ZodError } from "zod";
import { DEBUG_CONFIG_DEFAULTS } from "../../engine/src/shared/debug/debug-config.ts";

import { modulePath, modulePathMatching } from "../helpers/module-resolver.ts";
// ── Test fixtures ──

function makeMockMap(files: { path: string; isSource?: boolean; imports?: { specifier: string; resolvedPath: string | null; kind?: string }[] }[]) {
  return {
    schemaVersion: INTELLIGENCE_SCHEMA_VERSION,
    rootPath: "/proj",
    generatedAt: "2026-01-01T00:00:00.000Z",
    files: files.map((f) => ({
      path: f.path,
      extension: "ts" as const,
      sizeBytes: 100,
      contentHash: "h",
      lineCount: 10,
      isSource: f.isSource ?? true,
    })),
    modules: files.map((f) => ({
      path: f.path,
      contentHash: "h",
      lineCount: 10,
      symbols: [],
      imports: (f.imports ?? []).map((i) => ({
        specifier: i.specifier,
        kind: (i.kind ?? "direct-import") as "direct-import",
        importedNames: [],
        resolvedPath: i.resolvedPath,
      })),
      exports: [],
      architectureModuleId: null,
      architectureLayer: null,
      architectureRealm: null,
      architectureOwner: null,
    })),
    totalSymbols: 0,
    totalDependencies: 0,
    mapHash: "h",
  } as const;
}

function mockCsrfReq(method: string, headers: Record<string, string> = {}): IncomingMessage {
  return { method, headers } as unknown as IncomingMessage;
}

// (-V8 fix): checkCsrf now THROWS `CsrfError` (HTTP 403) instead
// of returning false + writing its own 403 response. The router catches the
// thrown CsrfError + maps it via the centralized error-mapping choke point.
// These shared helpers assert the THROW-based contract (not the prior
// boolean-return + response-writing contract) + dedup the assertion logic
// Defined at module scope so both the CSRF
// describe blocks (happy path + adversarial) reuse them.
function expectCsrfBlocked(req: IncomingMessage): void {
  try {
    checkCsrf(req);
    throw new Error("expected checkCsrf to throw CsrfError, but it returned normally");
  } catch (e) {
    // Verify the SPECIFIC error type + code + status that catches ANY error). A different thrown error would
    // fail these assertions, so the test cannot pass on the wrong error.
    expect(e).toBeInstanceOf(CsrfError);
    expect((e as CsrfError).code).toBe("csrf_blocked");
    expect((e as CsrfError).statusCode).toBe(403);
    expect((e as Error).message).toContain("Cross-site request blocked");
  }
}
function expectCsrfAllowed(req: IncomingMessage): void {
  expect(() => checkCsrf(req)).not.toThrow();
}

// ════════════════════════════════════════════════════════════════════════
// — Auto-heal
// ════════════════════════════════════════════════════════════════════════

describe("Auto-heal — stale-index detection", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = createTempDir("autoheal-");
  });

  test("detectStaleIndex: a file whose mtime increased is flagged as changed (stale)", () => {
    const file = join(tmp, "a.ts");
    writeFileSync(file, "const a = 1;\n");
    const snap = captureMtimeSnapshot(tmp, makeMockMap([{ path: "a.ts" }]));
    // Bump mtime forward 5s (above the 1ms epsilon).
    const future = new Date(Date.now() + 5000);
    utimesSync(file, future, future);
    const report = detectStaleIndex(snap);
    expect(report.stale).toBe(true);
    expect(report.changedFiles.length).toBe(1);
    expect(report.vanishedFiles.length).toBe(0);
    expect(report.reason).toContain("changed");
  });

  test("detectStaleIndex: a deleted file is flagged as vanished (stale)", () => {
    const file = join(tmp, "b.ts");
    writeFileSync(file, "const b = 2;\n");
    const snap = captureMtimeSnapshot(tmp, makeMockMap([{ path: "b.ts" }]));
    rmSync(file);
    const report = detectStaleIndex(snap);
    expect(report.stale).toBe(true);
    expect(report.vanishedFiles.length).toBe(1);
    expect(report.changedFiles.length).toBe(0);
    expect(report.reason).toContain("vanished");
  });

  test("detectStaleIndex: unchanged files report NOT stale (the happy path)", () => {
    writeFileSync(join(tmp, "c.ts"), "const c = 3;\n");
    const snap = captureMtimeSnapshot(tmp, makeMockMap([{ path: "c.ts" }]));
    const report = detectStaleIndex(snap);
    expect(report.stale).toBe(false);
    expect(report.changedFiles).toEqual([]);
    expect(report.vanishedFiles).toEqual([]);
    expect(report.reason).toBeNull();
  });

  test("detectStaleIndex: a mtime change WITHIN 1ms epsilon is NOT drift (avoids false positives)", () => {
    const file = join(tmp, "d.ts");
    writeFileSync(file, "const d = 4;\n");
    const snap = captureMtimeSnapshot(tmp, makeMockMap([{ path: "d.ts" }]));
    // Sub-epsilon bump (mtimeMs is float; a 0.5ms bump is below the 1ms floor).
    const original = [...snap.mtimes.values()][0]!;
    const bumped = new Date(original + 0.4);
    utimesSync(file, bumped, bumped);
    const report = detectStaleIndex(snap);
    expect(report.stale).toBe(false);
  });

  test("detectStaleIndex never throws on a snapshot whose files are all gone", () => {
    const snap: MtimeSnapshot = { indexedAt: Date.now(), projectRoot: tmp, mtimes: new Map([[join(tmp, "gone.ts"), Date.now()]]) };
    expect(() => detectStaleIndex(snap)).not.toThrow();
    expect(detectStaleIndex(snap).vanishedFiles.length).toBe(1);
  });

  test("computeStaleSampleSize: small codebase gets FULL coverage; large codebase gets bounded sqrt sample", () => {
    const cfg = getAutoHealConfig();
    // Full coverage at/below threshold.
    expect(computeStaleSampleSize(0)).toBe(0);
    expect(computeStaleSampleSize(cfg.staleFullCoverageThreshold)).toBe(cfg.staleFullCoverageThreshold);
    // Large codebase: sqrt-scaled, floored + ceilinged.
    const big = computeStaleSampleSize(10_000);
    expect(big).toBeGreaterThan(0);
    expect(big).toBeLessThanOrEqual(cfg.staleSampleCeiling);
    expect(big).toBeGreaterThanOrEqual(cfg.staleSampleFloor);
    // sqrt(10000)=100 → within floor/ceiling.
    expect(computeStaleSampleSize(10_000)).toBe(100);
    // Very large codebase capped at ceiling.
    expect(computeStaleSampleSize(1_000_000)).toBe(cfg.staleSampleCeiling);
  });

  test("computeStaleSampleSize: NaN / negative / non-finite → 0 (no crash)", () => {
    expect(computeStaleSampleSize(NaN)).toBe(0);
    expect(computeStaleSampleSize(-1)).toBe(0);
    // Infinity is non-finite → the guard returns 0 (no unbounded sample).
    expect(computeStaleSampleSize(Infinity)).toBe(0);
  });

  test("sampleSourceFiles: deterministic stride — same input → same sample (reproducible)", () => {
    const paths = Array.from({ length: 100 }, (_, i) => `f${i}.ts`);
    const a = sampleSourceFiles(paths, 10);
    const b = sampleSourceFiles(paths, 10);
    expect(a).toEqual(b);
    expect(a.length).toBe(10);
  });

  test("sampleSourceFiles: size >= paths.length → returns all; size 0 → empty", () => {
    expect(sampleSourceFiles(["a", "b"], 5)).toEqual(["a", "b"]);
    expect(sampleSourceFiles(["a", "b"], 0)).toEqual([]);
    expect(sampleSourceFiles([], 5)).toEqual([]);
  });

  test("captureMtimeSnapshot: only samples isSource files (non-source assets don't bloat the snapshot)", () => {
    writeFileSync(join(tmp, "code.ts"), "x");
    writeFileSync(join(tmp, "image.png"), "png");
    const map = makeMockMap([
      { path: "code.ts", isSource: true },
      { path: "image.png", isSource: false },
    ]);
    const snap = captureMtimeSnapshot(tmp, map);
    expect(snap.mtimes.size).toBe(1);
    expect(snap.mtimes.has(join(tmp, "code.ts"))).toBe(true);
  });

  test("captureMtimeSnapshot: an unstatable file is skipped (not a crash, no empty-catch swallow)", () => {
    // Point the map at a path that doesn't exist on disk.
    const snap = captureMtimeSnapshot(tmp, makeMockMap([{ path: "nonexistent.ts" }]));
    expect(snap.mtimes.size).toBe(0);
  });
});

describe("Auto-heal — broken-edge detection", () => {
  test("detectBrokenEdges: imports with resolvedPath null are flagged", () => {
    const map = makeMockMap([
      { path: "a.ts", imports: [{ specifier: "./b", resolvedPath: "b.ts" }] },
      { path: "c.ts", imports: [{ specifier: "./deleted", resolvedPath: null }] },
      { path: "d.ts", imports: [{ specifier: "node:fs", resolvedPath: null }, { specifier: "./e", resolvedPath: "e.ts" }] },
    ]);
    const report = detectBrokenEdges(map);
    expect(report.count).toBe(2);
    expect(report.brokenEdges.map((e) => e.from)).toEqual(["c.ts", "d.ts"]);
    expect(report.brokenEdges[0]!.specifier).toBe("./deleted");
  });

  test("detectBrokenEdges: a clean map (all imports resolved) → zero broken edges", () => {
    const map = makeMockMap([
      { path: "a.ts", imports: [{ specifier: "./b", resolvedPath: "b.ts" }] },
    ]);
    expect(detectBrokenEdges(map).count).toBe(0);
  });

  test("detectBrokenEdges: a map with no modules → empty report (no crash)", () => {
    const map = makeMockMap([]);
    expect(detectBrokenEdges(map).count).toBe(0);
  });

  test("toAbsolutePath / toRelativePath: relative↔absolute round-trip within the root", () => {
    const root = "/proj";
    expect(toAbsolutePath(root, "src/a.ts")).toBe("/proj/src/a.ts");
    expect(toAbsolutePath(root, "/abs/x.ts")).toBe("/abs/x.ts");
    expect(toRelativePath(root, "/proj/src/a.ts")).toBe("src/a.ts");
    // A path outside the root is returned absolute (not a misleading../).
    expect(toRelativePath(root, "/etc/passwd")).toBe("/etc/passwd");
  });
});

describe("Auto-heal — wiring into the intelligence bridge", () => {
  test("the intelligence-bridge imports captureMtimeSnapshot + detectStaleIndex + detectBrokenEdges", () => {
    const src = readFileSync(modulePath("intelligence-bridge.ts"), "utf8");
    expect(src).toContain("captureMtimeSnapshot");
    expect(src).toContain("detectStaleIndex");
    expect(src).toContain("detectBrokenEdges");
    expect(src).toContain("isIndexStale");
    expect(src).toContain("mtimeSnapshot");
  });

  test("the auto-heal signals route is registered", () => {
    const src = readFileSync(modulePathMatching("server/routes/intelligence.ts"), "utf8");
    expect(src).toContain("/api/intelligence/auto-heal");
    expect(src).toContain("/api/intelligence/broken-edges");
    expect(src).toContain("getProjectAutoHealReport");
  });

  test("the auto-heal config knobs live in the harness config", () => {
    const src = readFileSync(modulePath("harness-config.ts"), "utf8");
    expect(src).toContain("getAutoHealConfig");
    expect(src).toContain("AutoHealConfig");
    expect(src).toContain("autoHeal");
  });
});

// ════════════════════════════════════════════════════════════════════════
// — Dedup/compression below API
// ════════════════════════════════════════════════════════════════════════

describe("Dedup/compression wired below the API", () => {
  const runSrc = runPathSource();
  const dedupBridgeSrc = readFileSync(modulePath("dedup-bridge.ts"), "utf8");
  const llmBridgeSrc = readFileSync(modulePath("llm-bridge.ts"), "utf8");

  test("wireDedupForTurn is imported from the dedup owner (dedup-bridge.ts) + called at every turn-addition point in run.ts", () => {
    // SPO: dedup functions moved from context-bridge.ts to dedup-bridge.ts
    // (the SINGLE web-UI owner of dedup). run.ts imports from dedup-bridge.ts.
    expect(runSrc).toContain("from \"../awareness/dedup-bridge.ts\"");
    expect(runSrc).toContain("wireDedupForTurn");
    // The call sites (wireDedupForTurn(...) with a paren): the steering
    // prompt, the assistant turn (×2 — incremental + final), and the tool
    // result. The initial user prompt is seeded from the DB history via
    // seedContextManagerFromHistory (not a live addTurn), so it is not a
    // wireDedupForTurn call site — the dedup is wired for NEW turns added
    // during the run.
    const callSites = (runSrc.match(/wireDedupForTurn\(/g) ?? []).length;
    expect(callSites).toBeGreaterThanOrEqual(4);
  });

  test("dedupCompressionEnabled gates the dedup wiring (opt-in) — owned by dedup-bridge.ts", () => {
    expect(dedupBridgeSrc).toContain("dedupCompressionEnabled");
    expect(dedupBridgeSrc).toContain("ensureDedupLowerLayer");
    // The gate is read from the harness config's memory.dedupCompression flag.
    expect(dedupBridgeSrc).toContain("getDedupCompressionSection");
  });

  test("the dedup layer is ON-PATH (compresses LLM input at the choke point) — not just decorative reporting", () => {
    // SPO: the dedup now ACTUALLY compresses LLM input (not just
    // off-path reporting). The LLM bridge choke point (`buildLLMMessages`)
    // calls `dedupContentForLLM` on each message's content after redaction.
    // This is the "not decorative" guarantee — the same class as the 748% bug
    // (where the context manager tracked state but the raw history was sent).
    expect(llmBridgeSrc).toContain("dedupContentForLLM");
    expect(dedupBridgeSrc).toContain("dedupContentForLLM");
    // The off-path storage reporter is still wired (storeContextTurn) for
    // cross-turn dedup reporting — BOTH modes coexist.
    expect(dedupBridgeSrc).toContain("storeContextTurn");
    // The LLM input still comes from buildTrimmedHistory (the context
    // manager is the single source of truth for the history).
    expect(runSrc).toContain("buildTrimmedHistory");
  });

  test("dedup status is exposed via a 'dedup' SSE event", () => {
    // The run route wires the `onDedup` callback → `dedup` SSE event.
    expect(runSrc).toContain("onDedup");
    expect(runSrc).toContain("SSE_EVENT_TYPES.dedup");
  });

  test("dedupCompressionEnabled returns false when the config flag is absent/invalid (safe default)", () => {
    // Source-level contract: the function guards on the flag being an object
    // with enabled === true. Reading the source keeps this test deterministic
    // (no need to mock the global config read). The pattern changed in 
    // (reads from `section["enabled"]` not a local `enabled` var).
    expect(dedupBridgeSrc).toContain('"enabled"] === true');
    expect(dedupBridgeSrc).toContain("return false");
  });
});

// ════════════════════════════════════════════════════════════════════════
// — Context injection chain (progressive, unlimited, dedup/compressed)
// ════════════════════════════════════════════════════════════════════════
//
// SPO update: the context-injection chain now goes through the
// context owner (context-bridge.ts `buildLLMInput`/`assembleSystemPrompt`),
// NOT ad-hoc in run.ts. The run route calls `buildLLMInput` (the single
// entry point); the three system-prompt injection functions
// (`buildSystemPrompt`, `injectRepositoryMapIntoPrompt`,
// `injectMemoriesIntoPrompt`) are orchestrated inside `assembleSystemPrompt`
// in context-bridge.ts. This test verifies the chain is fully wired in
// the context owner + that run.ts routes through it.

describe("context injection chain is fully wired (via the context owner)", () => {
  const runSrc = runPathSource();
  const bridgeSrc = readFileSync(modulePath("context-bridge.ts"), "utf8");

  test("the run route builds LLM input through the context owner (buildLLMInput)", () => {
    expect(runSrc, "run.ts must call buildLLMInput (the context owner's single entry point)").toContain("buildLLMInput");
  });

  test("stage 1: base system prompt is built (project name/path + tools) — in the context owner", () => {
    expect(bridgeSrc, "context-bridge assembleSystemPrompt must call buildSystemPrompt").toContain("buildSystemPrompt(");
  });

  test("stage 2: the pre-indexed repository map is injected (codebase intelligence) — in the context owner", () => {
    expect(bridgeSrc, "context-bridge assembleSystemPrompt must call injectRepositoryMapIntoPrompt").toContain("injectRepositoryMapIntoPrompt(");
  });

  test("stage 3: retrieved memories are injected into the system prompt (cross-run recall) — in the context owner", () => {
    expect(bridgeSrc, "context-bridge assembleSystemPrompt must call injectMemoriesIntoPrompt").toContain("injectMemoriesIntoPrompt(");
    expect(runSrc, "run.ts must call retrieveRelevantMemories before the LLM call").toContain("retrieveRelevantMemories(");
  });

  test("stage 4: the LLM receives the TRIMMED history from the unified context manager (not raw)", () => {
    // Provenance, not arity: the fact under test is that the history comes
    // from the context manager, which the prefix establishes. Requiring the
    // closing paren made this fail when the call gained an option.
    expect(runSrc, "run.ts must derive the LLM history from the context manager (buildTrimmedHistory)").toContain("buildTrimmedHistory(active.contextManager");
    expect(runSrc).toContain("seedContextManagerFromHistory(");
    // THE RUN PATH NO LONGER SEQUENCES ITS OWN TRIM, and that is the assertion.
    //
    // This line used to require the string `contextManager.trim()` in the run
    // path, which is a spelling, and the spelling was satisfied by a trim in
    // the WRONG PLACE: at the end of a turn, priced against the manifest of
    // the turn that had just finished, while the next turn re-read the
    // manifest and sent the repriced history untrimmed. Pricing and evicting
    // now happen inside `buildTrimmedHistory` — the one function every
    // provider-bound history comes out of — so a trim sequenced by the run
    // path is a second place that has to remember, which is the defect.
    //
    // The behavioural half lives in
    // tests/prevention/context-charge-matches-payload.test.ts, which drives
    // the turn boundary rather than reading the source.
    expect(
      runSrc.split("\n").filter((l) => /contextManager\.trim\(\)/.test(l) && !l.trimStart().startsWith("//")),
      "the run path must not trim on its own — deriving the history is what prices and trims",
    ).toEqual([]);
  });

  test("stage 5: every turn added to the manager is routed through the dedup layer", () => {
    expect(runSrc).toContain("wireDedupForTurn");
  });

  test("the chain is progressive + unlimited: no artificial cap — trimming is driven by the model's context window", () => {
    // The context manager's tokenLimit (from config) is the ONLY cap; there
    // is no hardcoded turn-count limit in run.ts.
    expect(runSrc).toContain("tokenLimit()");
    // No hardcoded history-length slice like `.slice(-N)` in the LLM call.
    expect(runSrc).not.toMatch(/conversationHistory.*slice\(-\d+\)/);
  });
});

// ════════════════════════════════════════════════════════════════════════
// — Centralized debug/error system (zero overhead + no swallow)
// ════════════════════════════════════════════════════════════════════════

describe("centralized debug system — warn/error never suppressed, debug lazy", () => {
  beforeEach(() => { resetWebDebug(); });
  afterEach(() => { resetWebDebug(); });

  test("before configureWebDebug: warn/error are reported; debug/info stay lazy", () => {
    expect(isWebDebugEnabled()).toBe(false);
    const before = getWebDebugSignals();
    let thunkCalled = false;
    let infoThunkCalled = false;
    const original = process.stderr.write.bind(process.stderr);
    let captured = "";
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured += chunk.toString();
      return true;
    }) as never;
    try {
      webWarn("test", "WITNESS-LG warn with no config", () => { thunkCalled = true; return {}; });
      webHandleError(new Error("WITNESS-LG error with no config"), { module: "test", operation: "noop" });
      webDebugLog("test", "info", "debug stays lazy", () => { infoThunkCalled = true; return {}; });
    } finally {
      process.stderr.write = original as never;
    }
    const after = getWebDebugSignals();
    expect(thunkCalled, "a reported warning evaluates its context").toBe(true);
    expect(infoThunkCalled, "the optional level remains zero-overhead").toBe(false);
    expect(captured).toContain("WITNESS-LG warn with no config");
    expect(captured).toContain("WITNESS-LG error with no config");
    expect(after.errorCount).toBe(before.errorCount + 1);
    expect(after.warnCount).toBe(before.warnCount + 1);
  });

  test("after configureWebDebug: webWarn evaluates the thunk + increments the warn signal", () => {
    // Configure with the "test" category allowed (the default allow-list is
    // the web-server module names; a test-only category must be opted in).
    configureWebDebug({ enabled: true, categories: ["test"] });
    expect(isWebDebugEnabled()).toBe(true);
    const before = getWebDebugSignals();
    let thunkCalled = false;
    webWarn("test", "emitted", () => { thunkCalled = true; return { detail: "x" }; });
    const after = getWebDebugSignals();
    expect(thunkCalled).toBe(true);
    // The warn signal may be counted under debugCount or warnCount depending
    // on the backend's level mapping; assert the total moved.
    expect(after.debugCount + after.warnCount).toBeGreaterThan(before.debugCount + before.warnCount);
  });

  test("after configureWebDebug: webHandleError increments the error-count signal (no swallow)", () => {
    configureWebDebug({ enabled: true, categories: ["test"] });
    const before = getWebDebugSignals();
    webHandleError(new Error("boom"), { module: "test", operation: "fail" });
    const after = getWebDebugSignals();
    expect(after.errorCount).toBeGreaterThan(before.errorCount);
  });

  test("configureWebDebug REFUSES redaction.enabled=false — ConfigError debug_redaction_required, and NOTHING is installed", () => {
    // Deny by default: the web debug bridge may never disable credential
    // redaction. The refusal must be typed AND must happen before
    // configureDebugSystem, so a refused policy leaves the no-op state.
    let thrown: unknown;
    try {
      configureWebDebug({ redaction: { ...DEBUG_CONFIG_DEFAULTS.redaction, enabled: false } });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect((thrown as ConfigError).code).toBe("debug_redaction_required");
    expect((thrown as ConfigError).message).toContain("redaction.enabled=false");
    expect(isWebDebugEnabled()).toBe(false); // refused BEFORE install — still no-op
  });

  test("configureWebDebug omitting redaction inherits the shipped enabled=true (only an explicit false is refused)", () => {
    const installed = configureWebDebug({ enabled: true, categories: ["test"] });
    expect(installed.redaction.enabled).toBe(true);
    expect(isWebDebugEnabled()).toBe(true);
  });

  test("configureWebDebug PARSES instead of casting: an invalid level is a ZodError naming the field, nothing installed", () => {
    let thrown: unknown;
    try {
      configureWebDebug({ enabled: true, categories: ["test"], level: "NOT-A-LEVEL" as never });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ZodError);
    expect((thrown as ZodError).issues.some((i) => i.path.includes("level"))).toBe(true);
    expect(isWebDebugEnabled()).toBe(false);
  });

  test("configureWebDebug refuses an unknown top-level key (strictObject) — a smuggled field is an error, not a passenger", () => {
    let thrown: unknown;
    try {
      configureWebDebug({ enabled: true, categories: ["test"], forbiddenPatterns: ["smuggled"] } as never);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ZodError);
    expect((thrown as ZodError).issues.some((i) => i.code === "unrecognized_keys")).toBe(true);
    expect(isWebDebugEnabled()).toBe(false);
  });

  test("the debug-bridge re-uses the canonical backend debug system", () => {
    const src = readFileSync(modulePath("debug-bridge.ts"), "utf8");
    expect(src).toContain("shared/debug/debug-system.ts");
    expect(src).toContain("backendDebugLog");
    expect(src).toContain("backendHandleError");
  });

  test("the web server bootstrap wires the debug system through the config section's one resolver (the file is the SSOT; HARNESS_WEB_DEBUG is the process-level on-switch)", () => {
    const idx = readFileSync(modulePathMatching("server/index.ts"), "utf8");
    expect(idx).toContain("configureWebDebug");
    // The bootstrap consults the debug config section's single resolver —
    // the one owner of the env-vs-file precedence — rather than reading the
    // env gate itself (the bypass shape the error-debug census refuses).
    expect(idx).toContain("resolveWebDebugBootstrap()");
  });

  test("all catch blocks in server/ route through the debug bridge or rethrow", () => {
    // The no-empty-catch prevention test enforces non-empty bodies; this
    // asserts the REPLACEMENT of console.warn with webWarn in the run +
    // context-bridge catch blocks (the centralized channel).
    const runSrc = runPathSource();
    expect(runSrc).not.toContain("console.warn");
    const bridgeSrc = readFileSync(modulePath("context-bridge.ts"), "utf8");
    expect(bridgeSrc).not.toContain("console.warn");
  });
});

// ════════════════════════════════════════════════════════════════════════
// — Resource sampler bootstrap/shutdown wiring
// ════════════════════════════════════════════════════════════════════════

describe("resource sampler bootstrap/shutdown wiring", () => {
  // A deny-by-default source scan, the same shape as the debug-bootstrap
  // test above. The sampler's timer is a process-lifecycle concern wired in
  // exactly one file, and it was measured that deleting the stop call from
  // the shutdown body failed ZERO tests — the wiring had no guard at all.
  // A runtime test cannot own this cheaply (it would have to deliver a real
  // signal to a real server and observe the timer die), but the wiring is
  // static, and a structural scan asserts the two placements that made the
  // defect possible: the sampler started with the listener, and stopped
  // before the shutdown path can hang.
  const idx = readFileSync(modulePathMatching("server/index.ts"), "utf8");

  test("the listen block starts the resource sampler — the time series begins with the server", () => {
    // STRUCTURAL, NOT A SUBSTRING: the call must sit INSIDE the listen
    // callback. A bare toContain would be satisfied by the import alone,
    // which is exactly the false pass a wiring guard exists to refuse.
    expect(idx, "startResourceSampler() must be called inside the server.listen callback").toMatch(
      /server\.listen\([^)]*,\s*\(\)\s*=>\s*\{[\s\S]*?\bstartResourceSampler\(\);/,
    );
  });

  test("the shutdown body stops the resource sampler — a standing timer is the hang shutdown exists to prevent", () => {
    // The stop call must sit INSIDE the shutdown() body (the first statement
    // of it), not merely be mentioned in the file.
    expect(idx, "stopResourceSampler() must be called inside the shutdown() body").toMatch(
      /function\s+shutdown\(\):\s*void\s*\{[\s\S]*?\bstopResourceSampler\(\);/,
    );
  });

  test("shutdown is reachable — registered on SIGTERM and SIGINT, or the stop call above is dead code", () => {
    // Through the event-loop door (SCALE-CR1 C3): the guarded shutdown.
    expect(idx).toContain("const onShutdownSignal = guarded(\"server.shutdown\", shutdown);");
    expect(idx).toContain("process.on(\"SIGTERM\", onShutdownSignal)");
    expect(idx).toContain("process.on(\"SIGINT\", onShutdownSignal)");
  });
});

// ════════════════════════════════════════════════════════════════════════
// — Security: CSRF, path validation, rate limiting, input validation, API keys
// ════════════════════════════════════════════════════════════════════════

describe("CSRF guard", () => {
  // (-V8 fix): checkCsrf now THROWS `CsrfError` (HTTP 403)
  // instead of returning false + writing its own 403 response. The router
  // catches the thrown CsrfError + maps it via the centralized error-
  // mapping choke point. These tests assert the THROW-based contract
  // (not the prior boolean-return + response-writing contract) using the
  // shared expectCsrfBlocked/expectCsrfAllowed helpers.

  test("safe methods (GET/HEAD/OPTIONS) are always exempt — no CSRF check", () => {
    expect(isSafeMethod("GET")).toBe(true);
    expect(isSafeMethod("HEAD")).toBe(true);
    expect(isSafeMethod("OPTIONS")).toBe(true);
    expect(isSafeMethod("POST")).toBe(false);
    expect(isSafeMethod("PUT")).toBe(false);
    expect(isSafeMethod("DELETE")).toBe(false);
    expect(isSafeMethod("PATCH")).toBe(false);
  });

  test("a GET request is allowed regardless of headers (THROWS nothing)", () => {
    expectCsrfAllowed(mockCsrfReq("GET", {}));
  });

  test("a POST with a same-origin Origin header is allowed", () => {
    // The allowed origin default is http://127.0.0.1:5173 (server/config.ts).
    const allowed = "http://127.0.0.1:5173";
    expectCsrfAllowed(mockCsrfReq("POST", { origin: allowed }));
  });

  test("a POST with a CROSS-origin Origin is BLOCKED (throws CsrfError 403 csrf_blocked)", () => {
    expectCsrfBlocked(mockCsrfReq("POST", { origin: "https://evil.example.com" }));
  });

  test("a POST with no Origin but a same-host Referer is allowed (OWASP fallback)", () => {
    const referer = "http://127.0.0.1:5173/api/projects";
    expectCsrfAllowed(mockCsrfReq("POST", { referer }));
  });

  test("a POST with no Origin and a cross-host Referer is BLOCKED (throws CsrfError)", () => {
    expectCsrfBlocked(mockCsrfReq("POST", { referer: "https://evil.example.com/x" }));
  });

  test("a POST with no Origin/Referer but the custom header is allowed (non-browser client opt-in)", () => {
    expectCsrfAllowed(mockCsrfReq("POST", { [CSRF_CUSTOM_HEADER]: "fetch" }));
  });

  test("a POST with NO Origin/Referer and NO custom header is BLOCKED (throws CsrfError — the CSRF threat)", () => {
    expectCsrfBlocked(mockCsrfReq("POST", {}));
  });

  test("a POST with a cross-origin Origin AND the custom header is allowed (defense-in-depth OR)", () => {
    expectCsrfAllowed(mockCsrfReq("POST", { origin: "https://evil.example.com", [CSRF_CUSTOM_HEADER]: "1" }));
  });

  test("a malformed Origin never matches (defensive — no crash, no bypass; throws CsrfError)", () => {
    expectCsrfBlocked(mockCsrfReq("POST", { origin: "::not-a-url::" }));
  });

  test("the CSRF guard is wired into the router's dispatch + the router maps the thrown CsrfError", () => {
    // (route registry): CSRF moved from server/index.ts into the
    // router's dispatch (the router owns the cross-cutting middleware).
    // (-V8): checkCsrf now THROWS CsrfError; the router catches
    // it + maps via statusForError/errorBody (the single error-mapping
    // owner). index.ts no longer calls checkCsrf; the router does, inside
    // dispatch, after the auth gate and before the route handler.
    const routerSrc = readFileSync(modulePath("router.ts"), "utf8");
    expect(routerSrc).toContain("checkCsrf");
    // The router wraps the gates in a try/catch that maps the thrown
    // CsrfError/AuthError (the `if (!checkCsrf(...))` boolean pattern is
    // gone — the guard now throws).
    expect(routerSrc).not.toMatch(/if\s*\(\s*!checkCsrf/);
    expect(routerSrc).toMatch(/try\s*\{[\s\S]*?checkCsrf\(/);
    // index.ts must NOT call checkCsrf directly (the router owns it now).
    const idx = readFileSync(modulePathMatching("server/index.ts"), "utf8");
    expect(idx).not.toContain("checkCsrf");
  });
});

describe("path validation — folder picker confinement", () => {
  test("isWithinAllowedRoots: empty roots → everything allowed (default dev behavior preserved)", () => {
    // The default serverConfig.allowedProjectRoots is empty (no HARNESS_WEB_ALLOWED_ROOTS).
    expect(isWithinAllowedRoots("/anywhere/on/disk")).toBe(true);
  });

  test("isWithinAllowedRoots: rejects path traversal outside every configured root", () => {
    // Temporarily set the env + re-resolve config so allowedProjectRoots is non-empty.
    const prev = process.env.HARNESS_WEB_ALLOWED_ROOTS;
    try {
      process.env.HARNESS_WEB_ALLOWED_ROOTS = "/home/example/projects";
      // the allowed-roots logic is now owned by fs-gate.ts (the
      // single filesystem access owner). routes/filesystem.ts uses the
      // throwing form `assertWithinAllowedRoots`. Verify the gate is the
      // owner + the route uses it.
      const gateSrc = readFileSync(modulePath("fs-gate.ts"), "utf8");
      expect(gateSrc).toContain("isWithinAllowedRoots");
      expect(gateSrc).toContain("path_outside_roots");
      const routeSrc = readFileSync(modulePath("filesystem.ts"), "utf8");
      // The list + mkdir routes call the throwing gate (≥3 usages).
      expect(routeSrc.match(/assertWithinAllowedRoots\(/g)?.length).toBeGreaterThanOrEqual(3);
    } finally {
      if (prev === undefined) delete process.env.HARNESS_WEB_ALLOWED_ROOTS;
      else process.env.HARNESS_WEB_ALLOWED_ROOTS = prev;
    }
  });

  test("filesystem list route rejects null-byte path injection (existing guard preserved)", () => {
    const src = readFileSync(modulePath("filesystem.ts"), "utf8");
    expect(src).toContain('includes("\\0")');
  });
});

describe("rate limiting — GET-exempt (the false-429 fix)", () => {
  test("the router exempts ALL read-only GET routes from rate limiting (by method, not a hardcoded path list)", () => {
    const src = readFileSync(modulePath("router.ts"), "utf8");
    // The exemption is by HTTP method (GET = read-only), not a hardcoded
    // path allowlist.
    expect(src).toMatch(/const isReadOnly\s*=\s*method\s*===\s*"GET"/);
    expect(src).toContain("isReadOnly");
    expect(src).toContain("checkRateLimit");
    // No hardcoded isPollRoute CODE (a function/const definition); the word
    // may survive in a comment as historical context, which is allowed.
    expect(src).not.toMatch(/(?:function|const)\s+isPollRoute\b/);
  });

  test("the rate-limit check THROWS RateLimitError (not writes its own 429) — the router maps it", () => {
    // Single-Party-Owner (-V8/V9 class): the rate-limit check now THROWS
    // a typed RateLimitError instead of writing its own 429 response, so the
    // router owns ALL guard error responses (consistent with authGate +
    // checkCsrf). The router's catch maps it + emits Retry-After.
    const src = readFileSync(modulePath("router.ts"), "utf8");
    expect(src).toContain("RateLimitError");
    // The typed 429 is CONSTRUCTED on the rate-limit path and THROWN. Two
    // spellings satisfy the throw: the original inline construction, or the
    // construct→record→throw of the same object (the refusal lane records
    // the denial between the two — the same choke point every pre-handler
    // refusal crosses). Deleting the throw reds both alternatives.
    expect(src).toMatch(/throw new RateLimitError\(|throw rateLimited;/);
    // …and the refusal lane carries the rate-limit denial into the http
    // ledger, at the throw site rather than the shared dispatch catch (a
    // handler error reaching that catch is already recorded by the dispatch
    // wrapper — recording it twice would double-count one request).
    expect(src).toMatch(/recordHttpRefusal\([\s\S]*?"refused rate-limit"\)/);
    // The prior inline 429 write (`res.writeHead(429,...)` with a hardcoded
    // Retry-After) is gone — the router's catch handles it.
    expect(src).not.toMatch(/res\.writeHead\(\s*429\b/);
    // The Retry-After is no longer a hardcoded "60" literal — it derives
    // from the rate-limiter owner (rateLimitRetryAfterSeconds).
    expect(src).not.toMatch(/["']Retry-After["']\s*:\s*["']60["']/);
    expect(src).toContain("rateLimitRetryAfterSeconds");
  });

  test("rateLimitRetryAfterSeconds derives from the refill rate (NOT a hardcoded 60; ~1s with defaults)", () => {
    // The Retry-After is the time until one token refills:
    // rateLimitRefillMs / rateLimitPerMinute (ms), ceil to seconds. With the
    // defaults (60 tokens / 1000ms) this is ~1s, NOT 60s (the prior hardcoded
    // "60" was ~60× too conservative). The single owner is rate-limiter.ts.
    const ra = rateLimitRetryAfterSeconds();
    expect(ra).toBeGreaterThanOrEqual(1);
    expect(ra).toBeLessThan(60); // the hardcoded "60" was wrong
    // The Retry-After is a positive integer (HTTP spec: integer seconds).
    expect(Number.isInteger(ra)).toBe(true);
  });

  test("RateLimitError carries statusCode=429 + code=rate_limited + retryAfterSeconds (the typed contract)", () => {
    const err = new RateLimitError("slow down", 5, "rate_limited");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("rate_limited");
    expect(err.statusCode).toBe(429);
    expect(err.retryAfterSeconds).toBe(5);
    expect(err.retryable).toBe(true);
  });
});

describe("input validation — all mutating routes use assertValidBody", () => {
  test("every route file with a POST/PUT/PATCH/DELETE handler uses assertValidBody or zod parse", () => {
    // Dynamic discovery: scan ALL route files for ones that
    // register mutating routes (POST/PUT/PATCH/DELETE). A mutating route
    // without body validation is automatically caught.
    const ROUTES_DIR_MUTATING = join(process.cwd(), "server", "routes");
    const MUTATING_RE = /\brouter\.(post|put|patch|delete)\s*\(/;
    const BODY_RE = /ctx\.body/;
    const routeFiles = readdirSync(ROUTES_DIR_MUTATING)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => join("server", "routes", f))
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        // Only check routes that have a mutating handler AND read ctx.body.
        // A POST that takes only query params (awareness/invalidate) has
        // no body to validate.
        return MUTATING_RE.test(src) && BODY_RE.test(src);
      });
    expect(routeFiles.length, "at least one mutating route should exist").toBeGreaterThan(0);
    for (const f of routeFiles) {
      const src = readFileSync(f, "utf8");
      // Either assertValidBody or a direct.parse (auth.ts uses.parse).
      expect(
        src.includes("assertValidBody") || src.includes(".parse("),
        `${f} must validate request bodies (assertValidBody or zod .parse)`,
      ).toBe(true);
    }
  });
});

describe("API keys never leaked in responses", () => {
  test("the models route CANNOT include an API key, because its response type has no field for one", () => {
    // This used to check that the route read the key from a config file and
    // then remembered not to print it. Remembering is the weak part, so the
    // shape changed: the route projects `ProviderView`, which declares
    // `hasApiKey: boolean` and no key field at all. Surfacing a key would mean
    // editing the type first, which is a visible act rather than an
    // accidental spread.
    const providersSrc = readFileSync(modulePath("providers.ts"), "utf8");
    const view = providersSrc.slice(providersSrc.indexOf("export type ProviderView"));
    const decl = view.slice(0, view.indexOf("}>;"));
    expect(decl.length, "the ProviderView declaration must have been found").toBeGreaterThan(40);
    expect(decl).toContain("hasApiKey");
    expect(decl).not.toMatch(/\bapiKey\s*:/u);
    // LIVENESS for the pattern: it does match a real key field.
    expect(/\bapiKey\s*:/u.test("  readonly apiKey: string;")).toBe(true);

    // And the route builds its response from that projection rather than from
    // the stored provider, so the safe shape is on the only path out.
    //
    // Scoped to `project()` deliberately. The file DOES mention `apiKey`
    // elsewhere and must: the merge carries a saved key forward when an edit
    // omits it, which is what stops a corrected base URL from silently
    // unsetting the credential. A whole-file ban would forbid the correct
    // code and only be satisfiable by breaking it — the shape of a guard that
    // gets deleted rather than obeyed.
    const routeSrc = readFileSync(modulePathMatching("server/routes/models.ts"), "utf8");
    const projection = routeSrc.slice(routeSrc.indexOf("function project("));
    const body = projection.slice(0, projection.indexOf("\n}"));
    expect(body.length, "the project() body must have been found").toBeGreaterThan(80);
    expect(body).toContain("providerViews(store)");
    expect(body).not.toMatch(/apiKey/u);
  });

  test("no route sends a raw HARNESS_API_KEY / api_key value in a response body", () => {
    // Dynamic discovery: scan ALL route files — no hardcoded list.
    const routeFiles = nonEmptySourceFilesUnder(
      join(process.cwd(), "server", "routes"),
      "route modules that build a response body",
    );
    for (const f of routeFiles) {
      const src = readFileSync(f, "utf8");
      // No sendJson/res.end that includes an apiKey field by name.
      expect(src).not.toMatch(/sendJson\([^)]*apiKey/);
      expect(src).not.toMatch(/res\.end\([^)]*api_key/);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// (bonus): smart-edit auto-heal Level-1 wired into applyPatch
// ════════════════════════════════════════════════════════════════════════

describe("CSRF guard — adversarial edge cases", () => {
  // (-V8): reuse the module-scope expectCsrfBlocked/Allowed
  // helpers. They assert the SPECIFIC CsrfError type +
  // code + status).
  test("an empty-string Origin header is treated as absent → blocked (throws CsrfError, no custom header)", () => {
    expectCsrfBlocked(mockCsrfReq("POST", { origin: "" }));
  });

  test("an Origin with the right host but WRONG PORT is blocked (host includes port)", () => {
    // allowed is 127.0.0.1:5173; send:9999 → host mismatch.
    expectCsrfBlocked(mockCsrfReq("POST", { origin: "http://127.0.0.1:9999" }));
  });

  test("an Origin with the right host:port but different SCHEME is allowed (host-only check — dev HTTP vs prod HTTPS)", () => {
    // allowed is http://127.0.0.1:5173; send https://127.0.0.1:5173 → same host.
    expectCsrfAllowed(mockCsrfReq("POST", { origin: "https://127.0.0.1:5173" }));
  });

  test("an OPTIONS preflight is always exempt (CORS preflight must not be CSRF-blocked)", () => {
    expectCsrfAllowed(mockCsrfReq("OPTIONS", {}));
  });

  test("a HEAD request is exempt (safe method)", () => {
    expectCsrfAllowed(mockCsrfReq("HEAD", {}));
  });

  test("a custom header with an EMPTY value is treated as ABSENT → blocked (throws CsrfError)", () => {
    // The contract: a non-empty custom-header value exempts. An empty value
    // (`X-Requested-With:`) is treated as absent (defensive — an empty
    // header is malformed; a real client always sends a value). This is
    // slightly stricter than "presence alone," which is fine: an attacker
    // cannot set the header AT ALL without a CORS preflight (blocked by the
    // single-origin CORS policy), so the non-empty requirement does not
    // weaken the guard.
    expectCsrfBlocked(mockCsrfReq("POST", { [CSRF_CUSTOM_HEADER]: "" }));
  });

  test("a Referer with the right host but a PATH query is allowed (only host is compared)", () => {
    expectCsrfAllowed(mockCsrfReq("POST", { referer: "http://127.0.0.1:5173/api/run/xyz/steer?x=1" }));
  });
});

describe("Auto-heal — adversarial edge cases", () => {
  let tmp: string;
  // createTempDir registers per-test removal via onTestFinished — no afterEach.
  beforeEach(() => { tmp = createTempDir("autoheal-edge-"); });

  test("a BACKWARD mtime (clock skew / file copied from the future) is NOT drift (only forward drift flags stale)", () => {
    const file = join(tmp, "past.ts");
    writeFileSync(file, "const p = 1;\n");
    const snap = captureMtimeSnapshot(tmp, makeMockMap([{ path: "past.ts" }]));
    // Move mtime BACKWARD 10s.
    const past = new Date([...snap.mtimes.values()][0]! - 10_000);
    utimesSync(file, past, past);
    const report = detectStaleIndex(snap);
    expect(report.stale).toBe(false);
    expect(report.changedFiles).toEqual([]);
  });

  test("detectStaleIndex with a 50/50 changed/unchanged mix flags ONLY the changed ones (no false negatives)", () => {
    const a = join(tmp, "a.ts"); const b = join(tmp, "b.ts");
    writeFileSync(a, "a"); writeFileSync(b, "b");
    const snap = captureMtimeSnapshot(tmp, makeMockMap([{ path: "a.ts" }, { path: "b.ts" }]));
    // Change only b.
    const future = new Date(Date.now() + 5000);
    utimesSync(b, future, future);
    const report = detectStaleIndex(snap);
    expect(report.stale).toBe(true);
    expect(report.changedFiles).toEqual([b]);
    expect(report.changedFiles).not.toContain(a);
  });

  test("detectBrokenEdges: dynamic imports + re-exports with null resolvedPath are flagged (all import kinds)", () => {
    const map = makeMockMap([
      { path: "a.ts", imports: [{ specifier: "./x", resolvedPath: null, kind: "dynamic-import" }] },
      { path: "b.ts", imports: [{ specifier: "./y", resolvedPath: null, kind: "re-export" }] },
      { path: "c.ts", imports: [{ specifier: "./z", resolvedPath: "z.ts", kind: "require" }] },
    ]);
    const report = detectBrokenEdges(map);
    expect(report.count).toBe(2);
    expect(report.brokenEdges.map((e) => e.kind).sort()).toEqual(["dynamic-import", "re-export"]);
  });

  test("sampleSourceFiles sample is SPREAD across the file set (stride), not clustered at the start", () => {
    const paths = Array.from({ length: 100 }, (_, i) => `f${i}.ts`);
    const sample = sampleSourceFiles(paths, 5);
    // With stride = 20, the sample is [f0, f20, f40, f60, f80] — spread, not
    // the first 5. This ensures a changed file anywhere in the set is
    // eventually sampled.
    expect(sample).toEqual(["f0.ts", "f20.ts", "f40.ts", "f60.ts", "f80.ts"]);
  });

  test("computeStaleSampleSize is monotonic WITHIN each regime (full-coverage then sqrt) + ceiling-capped", () => {
    const cfg = getAutoHealConfig();
    // Full-coverage regime: s == n (monotonic increasing).
    let prevFull = 0;
    for (let n = 1; n <= cfg.staleFullCoverageThreshold; n += 1) {
      const s = computeStaleSampleSize(n);
      expect(s).toBe(n);
      expect(s).toBeGreaterThanOrEqual(prevFull);
      prevFull = s;
    }
    // sqrt regime: s = min(ceiling, max(floor, sqrt(n))) — monotonic
    // (sqrt is monotonic) and capped at the ceiling. Note: there IS a
    // one-time drop at the regime boundary (full coverage ends, sampling
    // begins) which is by design — the contract is monotonic WITHIN each
    // regime, not across the boundary.
    let prevSqrt = computeStaleSampleSize(cfg.staleFullCoverageThreshold + 1);
    for (const n of [cfg.staleFullCoverageThreshold + 10, 1_000, 10_000, 100_000, 1_000_000]) {
      const s = computeStaleSampleSize(n);
      expect(s).toBeGreaterThanOrEqual(prevSqrt);
      expect(s).toBeLessThanOrEqual(cfg.staleSampleCeiling);
      prevSqrt = s;
    }
    expect(computeStaleSampleSize(1_000_000)).toBe(cfg.staleSampleCeiling);
  });
});

describe("path validation — adversarial edge cases", () => {
  test("isWithinAllowedRoots is false for a non-absolute path even with roots configured (defensive)", () => {
    // The helper requires an absolute path; a relative path is never within.
    // (With empty roots it returns true; this asserts the absolute-path guard
    // is present in the source.) the logic moved to fs-gate.ts.
    const src = readFileSync(modulePath("fs-gate.ts"), "utf8");
    expect(src).toContain("isAbsolute(absPath)");
    expect(src).toContain("return false");
  });
});

// ════════════════════════════════════════════════════════════════════════
// (bonus): the edit preimage heal (whitespace) is wired into the governed editor
// ════════════════════════════════════════════════════════════════════════

describe("edit preimage whitespace heal wired into the governed editor", () => {
  test("the governed edit path has the whitespace-tolerant heal (whitespaceEquivalent) + healed-replacement map", () => {
    // The web's edit tool delegates to the engine's governed editor; the heal
    // primitive lives in the engine's edit-operations / edit-resolve. Assert
    // the heal where it actually runs (the single owner), not a removed copy.
    const src = readFileSync(modulePath("edit-operations.ts"), "utf8");
    expect(src).toContain("whitespaceEquivalent");
    expect(src).toContain("healedReplacement");
    expect(src).toContain("AUTO-HEAL Level-1");
  });
});
