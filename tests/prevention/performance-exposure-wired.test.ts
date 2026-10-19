// @vitest-environment node
/**
 * PERFORMANCE EXPOSURE WIRING — the metrics-bridge feeds the exposure
 * signals, and nothing else does.
 *
 * The `performance` registration declares its signals over an installable
 * state source (the pattern the safety runtime established for its detector
 * verdicts). The metrics BRIDGE owns the measurements — the same collector
 * snapshot, token accumulator and self-improving analyzer `/api/metrics`
 * serves — and installs the source at server boot. This suite proves the
 * wiring is REAL, not declared:
 *
 *   A. the composition points — ONE installer, installed at ONE place (the
 *      bootstrap), and the registration file owns the signals it serves;
 *   B. the live source drives the signal values through the REAL collector:
 *      a recorded call moves the counts, the lanes, the quantiles and the
 *      tokens-per-second row a poll later would serve;
 *   C. the resource rows read the SAMPLER's own last tick (not an
 *      independent fresh process read), and are honest absence before one;
 *   D. the SSOT equivalence — the signal total IS the bridge's snapshot
 *      total, asserted against the same owner rather than a re-derived fold;
 *   E. with the source cleared, every performance signal reads its honest
 *      zero/false — absence, never an invented number.
 *
 * Mutation discipline: removing the bootstrap install reds A; pointing the
 * source at a fabricated snapshot reds D; reading a fresh process-memory
 * call instead of the sampler's tick reds C's identity arm.
 */
import { describe, expect, test, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

import {
  registerAllExposure,
  readSignal,
  clearPerformanceMetricsSource,
} from "../../server/kernel/canonical.ts";
import {
  installPerformanceMetricsExposureSource,
  lastResourceSample,
  getMetricsSnapshot,
  recordLlmCall,
  recordToolCall,
  sampleResourceOnce,
} from "../../server/observability/metrics-bridge.ts";
import { walkTs } from "../helpers/source-scan.ts";
import { modulePath, modulePathMatching } from "../helpers/module-resolver.ts";

const SERVER_TS_FILES: readonly string[] = walkTs("server");

function srcOf(path: string): string {
  return readFileSync(path, "utf8");
}

// ── A. the composition points ────────────────────────────────────────────────

describe("A. the metrics bridge is the one composition point for the performance signals", () => {
  test("exactly ONE server module defines the exposure source installer (metrics-bridge)", () => {
    const definers = SERVER_TS_FILES.filter((f) =>
      /export\s+function\s+installPerformanceMetricsExposureSource\s*\(/.test(srcOf(f)),
    );
    // Resolved by name, never spelled: a module move rewrites nothing here.
    expect(definers).toEqual([modulePath("metrics-bridge.ts")]);
  });

  test("exactly ONE server file calls the installer — the bootstrap, beside the other exposure sources", () => {
    const callers = SERVER_TS_FILES.filter((f) =>
      /\binstallPerformanceMetricsExposureSource\s*\(\)/.test(srcOf(f)) &&
      !/export\s+function\s+installPerformanceMetricsExposureSource/.test(srcOf(f)),
    );
    // A path FRAGMENT, not a spelled path: the resolver proves it is
    // unique ("index.ts" alone is not) and a move fails loudly here.
    expect(callers).toEqual([modulePathMatching("server/index.ts")]);
  });

  test("the registration owns the signal ids the room renders (no other module registers performance.*)", () => {
    const SERVER_REGISTRARS = SERVER_TS_FILES.filter((f) =>
      /registerSignal\(\{\s*id:\s*"performance\./.test(srcOf(f)),
    );
    expect(SERVER_REGISTRARS).toEqual([]);
  });
});

// ── B + C + D + E: the live source, driven through the real collector ───────

describe("the installed source drives the exposure signals from the real bridge", () => {
  beforeEach(() => {
    registerAllExposure();
    installPerformanceMetricsExposureSource();
  });

  test("a recorded model call moves the totals, the llm lane and the duration quantiles", () => {
    recordLlmCall("test-model", 120, true, {}, { input: 40, output: 10 });
    expect(readSignal("performance.callCount")).toBeGreaterThan(0);
    expect(readSignal("performance.llmCalls")).toBeGreaterThanOrEqual(1);
    expect(readSignal("performance.llmErrors")).toBe(0);
    // One measured call: the median sits inside its bucket's range, and a
    // real duration was recorded for it.
    expect(readSignal("performance.durationP50Ms")).toBeGreaterThan(0);
    expect(readSignal("performance.durationP95Ms")).toBeGreaterThan(0);
    // The token accumulator feeds the throughput row.
    expect(readSignal("performance.tokensPerSecond")).toBeGreaterThan(0);
  });

  test("a failed tool call moves the tool lane's error count, not the llm lane's", () => {
    const llmBefore = readSignal("performance.llmCalls");
    recordToolCall("probe_tool", 15, false);
    expect(readSignal("performance.toolCalls")).toBeGreaterThanOrEqual(1);
    expect(readSignal("performance.toolErrors")).toBeGreaterThanOrEqual(1);
    expect(readSignal("performance.llmCalls")).toBe(llmBefore);
  });

  test("SSOT: the signal's total IS the bridge snapshot's total (no second measurement path)", () => {
    recordToolCall("probe_tool_two", 5, true);
    // The same owner the route serves — asserted by identity of the number,
    // never by re-deriving the fold in this test.
    expect(readSignal("performance.callCount")).toBe(getMetricsSnapshot().totalCallCount);
    expect(readSignal("performance.errorCount")).toBe(getMetricsSnapshot().totalErrorCount);
    expect(readSignal("performance.cancellationCount")).toBe(getMetricsSnapshot().totalCancellationCount);
  });

  test("the resource rows read the sampler's own last tick, honestly absent before one", () => {
    // Before any tick in THIS process the sampler head is whatever the live
    // process already measured — assert the IDENTITY instead: the signal
    // value equals the sampler's own exported head, whatever it is.
    const head = lastResourceSample();
    expect(readSignal("performance.processRssBytes")).toBe(head === null ? 0 : head.rssBytes);
    expect(readSignal("performance.processHeapUsedBytes")).toBe(head === null ? 0 : head.heapUsedBytes);
    expect(readSignal("performance.eventLoopUtilization")).toBe(head === null ? 0 : head.eventLoopUtilization);
    // One real tick (the same rows the live server writes on its interval):
    // the head moves, and the signal follows IT — not an independent read.
    sampleResourceOnce();
    const after = lastResourceSample();
    expect(after).not.toBeNull();
    expect(readSignal("performance.processRssBytes")).toBe(after!.rssBytes);
    expect(readSignal("performance.processRssBytes")).toBeGreaterThan(0);
    expect(readSignal("performance.samplerActive")).toBe(false); // never started here
  });

  test("with the source cleared, every performance signal reads its honest zero", () => {
    clearPerformanceMetricsSource();
    expect(readSignal("performance.callCount")).toBe(0);
    expect(readSignal("performance.llmCalls")).toBe(0);
    expect(readSignal("performance.toolCalls")).toBe(0);
    expect(readSignal("performance.durationP50Ms")).toBe(0);
    expect(readSignal("performance.durationP95Ms")).toBe(0);
    expect(readSignal("performance.tokensPerSecond")).toBe(0);
    expect(readSignal("performance.selfImprovingSuggestions")).toBe(0);
    expect(readSignal("performance.samplerActive")).toBe(false);
    expect(readSignal("performance.processRssBytes")).toBe(0);
    // The knobs' mirrors read the config, not the source — they stay live.
    expect(readSignal("performance.resourceDeltasEnabled")).toBe(true);
  });
});
