import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  createMetricsCollector,
  type MetricScopeKey,
  type MetricCorrelation,
} from "../../src/performance/metrics-collector.ts";
import { createDiagnosticRunner } from "../../src/performance/diagnostic-modes.ts";
import { generateFunctionManifest, validateFunctionManifest } from "../../src/performance/function-manifest.ts";
import { createBenchmarkRunner, validateBenchmarkResult } from "../../src/performance/benchmark-runner.ts";
import { ARCHITECTURE_MANIFEST } from "../../src/architecture-manifest.ts";
import { DEFAULT_PERFORMANCE_CONFIG, parsePerformanceConfig, isLabelAllowed, redactLabelValue } from "../../src/performance/performance-config.ts";
import { makePerfConfig } from "../support/factories.ts";

const KEY: MetricScopeKey = { module: "test", function: "op", scope: "unit" };

function repositoryModuleSources(): Map<string, string> {
  const map = new Map<string, string>();
  for (const module of ARCHITECTURE_MANIFEST.modules) {
    map.set(module.path, readFileSync(module.path, "utf8"));
  }
  return map;
}

test("hostile: concurrent metrics recording does not crash", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  const promises = [];
  for (let i = 0; i < 100; i++) {
    promises.push(Promise.resolve(collector.recordCall(KEY, { runId: `run-${i}` }, Math.random() * 100, "succeeded", "shared")));
  }
  Promise.all(promises);
  const snap = collector.snapshot();
  assert.ok(snap.totalCallCount > 0);
});

test("hostile: oversized label values are rejected", () => {
  const longValue = "x".repeat(500);
  assert.equal(isLabelAllowed(DEFAULT_PERFORMANCE_CONFIG, "runId", longValue), false);
});

test("hostile: credential-like label values are redacted", () => {
  const credValues = [
    "Bearer abc123",
    "password=secret",
    "sk-1234567890",
    "api-key=mykey",
    "token=xyz",
  ];
  for (const v of credValues) {
    assert.equal(redactLabelValue(DEFAULT_PERFORMANCE_CONFIG, v), "[redacted]");
  }
});

test("hostile: PII patterns in label values are rejected by isLabelAllowed", () => {
  const piiValues = [
    "password=secret",
    "Bearer token",
  ];
  for (const v of piiValues) {
    assert.equal(isLabelAllowed(DEFAULT_PERFORMANCE_CONFIG, "runId", v), false);
  }
});

test("hostile: prompt content in label values is rejected", () => {
  assert.equal(isLabelAllowed(DEFAULT_PERFORMANCE_CONFIG, "prompt", "system prompt content"), false);
});

test("hostile: file content in label values is rejected", () => {
  assert.equal(isLabelAllowed(DEFAULT_PERFORMANCE_CONFIG, "content", "file contents here"), false);
  assert.equal(isLabelAllowed(DEFAULT_PERFORMANCE_CONFIG, "payload", "payload data"), false);
});

test("hostile: source code in label values is rejected", () => {
  assert.equal(isLabelAllowed(DEFAULT_PERFORMANCE_CONFIG, "source-code", "source code"), false);
});

test("hostile: diff content in label values is rejected", () => {
  assert.equal(isLabelAllowed(DEFAULT_PERFORMANCE_CONFIG, "diff", "diff content"), false);
});

test("hostile: metrics collector does not leak credential in snapshot", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  collector.recordCall(KEY, { toolName: "Bearer sk-12345" } as MetricCorrelation, 10, "succeeded", "shared");
  const snap = collector.snapshot();
  const json = JSON.stringify(snap);
  assert.ok(!json.includes("sk-12345"));
  assert.ok(json.includes("[redacted]"));
});

test("hostile: metrics collector filters credential keys from correlation", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  collector.recordCall(KEY, { apiKey: "sk-12345", password: "secret" } as MetricCorrelation, 10, "succeeded", "shared");
  const snap = collector.snapshot();
  const json = JSON.stringify(snap);
  assert.ok(!json.includes("sk-12345"));
  assert.ok(!json.includes("secret"));
  assert.ok(!json.includes("apiKey"));
  assert.ok(!json.includes("password"));
});

/**
 * ── §36: THESE THREE USED TO BE ABSENCE ASSERTIONS WITH NO CANARY ─────────
 *
 * Nine assertions across the three tests below asserted that `password`,
 * `apiKey` and `Bearer` did not appear in a `json` that NO TEST EVER PUT A
 * CREDENTIAL INTO. They passed against `{}`, against `null`, and against a
 * completely unredacted implementation. (The two collector tests above are the
 * counter-example in the same file: they plant `sk-12345` before asserting it is
 * gone, and the first also carries a positive witness.)
 *
 * That was not a stylistic gap. Driving a real plant through the third one
 * found the claim was FALSE: an operation throwing `auth failed: <CANARY>` put
 * the whole canary into `JSON.stringify(result)` via `errorMessage`, which is
 * why `benchmark-runner.ts` now screens that field.
 *
 * Each test below now carries BOTH directions:
 *   • the CANARY, planted through the channel the subject actually reads, and
 *     asserted absent;
 *   • a WITNESS in the same subject, asserted PRESENT — so a scan that returned
 *     zero because it was pointed at nothing fails loudly instead of passing.
 */
const CREDENTIAL_CANARY = "sk-hostile-4d9a1f7e0c2b6853f10e";

test("hostile: diagnostic snapshots do not echo a credential planted in the cgroup reader", () => {
  // The only foreign text a diagnostic snapshot reads is the cgroup files, and
  // the reader is injectable — so that is where the canary belongs.
  let cgroupReads = 0;
  const runner = createDiagnosticRunner({
    config: makePerfConfig(),
    readCgroupFile: (path: string) => {
      cgroupReads++;
      return `max ${CREDENTIAL_CANARY} password=${CREDENTIAL_CANARY} Bearer ${CREDENTIAL_CANARY} apiKey=${CREDENTIAL_CANARY} ${path}\n`;
    },
  });
  const results = runner.runAll();

  // WITNESSES, before any absence claim is allowed to mean anything: the reader
  // carrying the canary was really consulted, and the run really produced
  // snapshots. A zero from a runner that read nothing is not evidence.
  assert.ok(cgroupReads > 0, "witness: the planted cgroup reader was consulted");
  assert.ok(results.length > 0, "witness: runAll produced diagnostic results");

  for (const result of results) {
    const json = JSON.stringify(result);
    assert.ok(json.includes(result.mode), "witness: the serialised result is the real snapshot");
    assert.ok(!json.includes(CREDENTIAL_CANARY), "the planted canary does not reach the snapshot");
    assert.ok(!json.includes("password"));
    assert.ok(!json.includes("apiKey"));
    assert.ok(!json.includes("Bearer"));
  }
});

test("hostile: function manifest does not echo a credential planted in a module source", () => {
  // `moduleSources` is the manifest's whole input, so a credential in a module
  // body is the real shape of this risk.
  const sources = repositoryModuleSources();
  const planted = ARCHITECTURE_MANIFEST.modules[0];
  assert.ok(planted !== undefined, "witness: the architecture manifest declares at least one module");
  sources.set(
    planted.path,
    `const apiKey = "${CREDENTIAL_CANARY}";\n`
    + `const password = "${CREDENTIAL_CANARY}";\n`
    + `export function hostilePlantedFunction() { return apiKey + password; }\n`,
  );

  const manifest = generateFunctionManifest({
    config: makePerfConfig(),
    architectureModules: ARCHITECTURE_MANIFEST.modules,
    moduleSources: sources,
  });
  const json = JSON.stringify(manifest);

  // WITNESS: the planted source was really parsed into this manifest. Without
  // it, a manifest built from an empty map would satisfy every line below.
  assert.ok(
    json.includes("hostilePlantedFunction"),
    "witness: the planted module source reached the manifest",
  );
  assert.ok(!json.includes(CREDENTIAL_CANARY), "the planted canary does not reach the manifest");
  assert.ok(!json.includes("password"));
  assert.ok(!json.includes("apiKey"));
  assert.ok(!json.includes("Bearer"));
});

test("hostile: benchmark result does not echo a credential thrown by the operation", async () => {
  const runner = createBenchmarkRunner({ config: makePerfConfig() });
  const result = await runner.run({
    name: "hostile-throwing-bench",
    operation: () => {
      throw new Error(`auth failed: Bearer ${CREDENTIAL_CANARY}`);
    },
  });
  const json = JSON.stringify(result);

  // WITNESSES: the operation really threw and the failure really reached the
  // result. Both had to be false for the old version of this test to pass.
  assert.ok(result.failedRepetitions > 0, "witness: the throwing operation was recorded as a failure");
  assert.ok(json.includes("auth failed"), "witness: the thrown message reached the result");
  assert.ok(!json.includes(CREDENTIAL_CANARY), "the thrown canary is screened out of errorMessage");
  assert.ok(!json.includes("password"));
  assert.ok(!json.includes("apiKey"));
});

test("hostile: benchmark NAME is caller-owned and is NOT screened — the limit, stated and driven", async () => {
  // The INERT direction of the test above: this proves the screening is scoped
  // to foreign text and does not silently swallow the caller's own label. A
  // benchmark name comes from the caller's source, not from a remote system.
  const runner = createBenchmarkRunner({ config: makePerfConfig() });
  const result = await runner.run({ name: `bench-${CREDENTIAL_CANARY}`, operation: () => {} });
  const json = JSON.stringify(result);
  assert.ok(json.includes(CREDENTIAL_CANARY), "a name the caller chose survives verbatim, by design");
  assert.equal(result.failedRepetitions, 0, "witness: this run did not fail, so no errorMessage path ran");
});

test("hostile: resource pressure - many entries at cardinality limit", () => {
  const config = makePerfConfig({ cardinality: { ...DEFAULT_PERFORMANCE_CONFIG.cardinality, maxTotalSeries: 100 } });
  const collector = createMetricsCollector({ config });
  for (let i = 0; i < 200; i++) {
    collector.recordCall(KEY, { runId: `run-${i}` }, 10, "succeeded", "shared");
  }
  assert.ok(collector.entryCount() <= 100);
  const snap = collector.snapshot();
  assert.ok(snap.entryCount <= 100);
});

test("hostile: NaN duration does not corrupt histogram", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  collector.recordCall(KEY, { runId: "r1" }, NaN, "succeeded", "shared");
  collector.recordCall(KEY, { runId: "r1" }, Infinity, "succeeded", "shared");
  collector.recordCall(KEY, { runId: "r1" }, 10, "succeeded", "shared");
  const snap = collector.snapshot();
  assert.equal(snap.entries[0]!.durationHistogram.totalCount, 1);
  assert.equal(snap.entries[0]!.durationHistogram.minMs, 10);
});

test("hostile: negative duration does not corrupt histogram", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  collector.recordCall(KEY, { runId: "r1" }, -5, "succeeded", "shared");
  collector.recordCall(KEY, { runId: "r1" }, 10, "succeeded", "shared");
  const snap = collector.snapshot();
  assert.equal(snap.entries[0]!.durationHistogram.totalCount, 1);
});

test("hostile: empty string label value is allowed", () => {
  assert.equal(isLabelAllowed(DEFAULT_PERFORMANCE_CONFIG, "runId", ""), true);
});

test("hostile: very long module name in scope is handled", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  const longKey: MetricScopeKey = { module: "x".repeat(100), function: "f", scope: "s" };
  collector.recordCall(longKey, { runId: "r1" }, 10, "succeeded", "shared");
  assert.equal(collector.entryCount(), 1);
});

test("hostile: rapid open/close cycle does not crash", () => {
  for (let i = 0; i < 10; i++) {
    const collector = createMetricsCollector({ config: makePerfConfig() });
    collector.recordCall(KEY, { runId: "r1" }, 10, "succeeded", "shared");
    collector.close();
  }
});

test("hostile: snapshot after close still returns valid data", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  collector.recordCall(KEY, { runId: "r1" }, 10, "succeeded", "shared");
  collector.close();
  const snap = collector.snapshot();
  assert.ok(snap.schemaVersion.length > 0);
});

test("hostile: function manifest stale detection blocks claims", () => {
  const manifest = generateFunctionManifest({
    config: makePerfConfig(),
    architectureModules: ARCHITECTURE_MANIFEST.modules,
    moduleSources: repositoryModuleSources(),
  });
  const staleModules = ARCHITECTURE_MANIFEST.modules.slice(0, 5);
  const result = validateFunctionManifest(manifest, staleModules);
  assert.equal(result.valid, false);
  assert.equal(result.stale, true);
});

test("hostile: benchmark with all-failed target is not valid", async () => {
  const runner = createBenchmarkRunner({ config: makePerfConfig() });
  const result = await runner.run({ name: "fail", operation: () => { throw new Error("x"); } });
  const violations = validateBenchmarkResult(result, makePerfConfig());
  if (result.failedRepetitions === result.totalRepetitions) {
    assert.ok(violations.includes("benchmark_result_all_repetitions_failed"));
  }
});

test("hostile: config rejects extremely large bucket count", () => {
  assert.throws(() => parsePerformanceConfig({
    ...DEFAULT_PERFORMANCE_CONFIG,
    histograms: { ...DEFAULT_PERFORMANCE_CONFIG.histograms, bucketCount: Number.MAX_SAFE_INTEGER },
  }));
});

test("hostile: config rejects zero retention maxSnapshots", () => {
  assert.throws(() => parsePerformanceConfig({
    ...DEFAULT_PERFORMANCE_CONFIG,
    retention: { ...DEFAULT_PERFORMANCE_CONFIG.retention, maxSnapshots: 0 },
  }));
});

test("hostile: config rejects empty schema version", () => {
  assert.throws(() => parsePerformanceConfig({
    ...DEFAULT_PERFORMANCE_CONFIG,
    schemaVersion: "",
  }));
});

test("integration: metrics collector with provider-like flow", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  const providerKey: MetricScopeKey = { module: "provider-adapter", function: "streamChatCompletion", scope: "provider-1" };
  const providerCorr: MetricCorrelation = { providerId: "provider-1", modelId: "model-1" };
  for (let i = 0; i < 50; i++) {
    collector.recordCall(providerKey, providerCorr, Math.random() * 100, i % 10 === 0 ? "failed" : "succeeded", "shared");
  }
  const snap = collector.snapshot();
  assert.equal(snap.entryCount, 1);
  assert.equal(snap.totalCallCount, 50);
  assert.ok(snap.totalErrorCount > 0);
});

test("integration: metrics collector with tool-like flow", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  const toolKey: MetricScopeKey = { module: "tool-registry", function: "read_file", scope: "tool" };
  const toolCorr: MetricCorrelation = { toolName: "read_file" };
  for (let i = 0; i < 30; i++) {
    collector.recordCall(toolKey, toolCorr, Math.random() * 50, "succeeded", "shared");
  }
  const snap = collector.snapshot();
  assert.equal(snap.totalCallCount, 30);
});

test("integration: metrics collector with agent-like flow", () => {
  const collector = createMetricsCollector({ config: makePerfConfig() });
  const agentKey: MetricScopeKey = { module: "agent-runtime", function: "runTurn", scope: "agent-1" };
  const agentCorr: MetricCorrelation = { agentId: "agent-1", providerId: "provider-1", modelId: "model-1", runId: "run-1", taskId: "task-1" };
  for (let i = 0; i < 20; i++) {
    collector.recordCall(agentKey, agentCorr, Math.random() * 200, i % 15 === 0 ? "failed" : "succeeded", "shared");
  }
  const snap = collector.snapshot();
  assert.equal(snap.totalCallCount, 20);
  assert.ok(snap.entries[0]!.correlation.agentId === "agent-1");
});

test("integration: full pipeline - config, metrics, diagnostics, manifest, benchmark", async () => {
  const config = makePerfConfig();
  const collector = createMetricsCollector({ config });
  const diagRunner = createDiagnosticRunner({ config });
  const benchRunner = createBenchmarkRunner({ config });
  const manifest = generateFunctionManifest({ config, architectureModules: ARCHITECTURE_MANIFEST.modules, moduleSources: repositoryModuleSources() });

  collector.recordCall(KEY, { runId: "integration" }, 10, "succeeded", "shared");
  const diagResults = diagRunner.runAll();
  const benchResult = await benchRunner.run({ name: "integration-bench", operation: () => {} });
  const manifestValidation = validateFunctionManifest(manifest, ARCHITECTURE_MANIFEST.modules);

  assert.ok(collector.snapshot().totalCallCount > 0);
  assert.ok(diagResults.length > 0);
  assert.ok(benchResult.totalRepetitions > 0);
  assert.equal(manifestValidation.valid, true);
});

test("integration: frozen outputs cannot be mutated", () => {
  const config = makePerfConfig();
  assert.ok(Object.isFrozen(config));
  const collector = createMetricsCollector({ config });
  const snap = collector.snapshot();
  assert.ok(Object.isFrozen(snap));
  assert.ok(Object.isFrozen(snap.entries));
});
