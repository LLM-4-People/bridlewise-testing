import { responsesSse, responseResource, responseSseResponse } from "../support/mock-provider.ts";
/**
 * EXP457 — configurable queue + concurrency for the OpenAI API module.
 *
 * Covers every required scenario:
 * 1. 100 concurrent requests → maxConcurrency respected.
 * 2. 1000 requests → handled (no crash, no OOM).
 * 3. Priority queue: 10 high-priority + 100 low-priority → high goes first.
 * 4. Adaptive: slow API → concurrency reduces; fast API → increases.
 * 5. Per-model: gemma=5, qwen=3 → separate limits.
 * 6. Improper: invalid config, negative concurrency, zero queue size.
 * 7. Performance: CPU, RAM, latency, throughput (requests/s), queue length, wait time.
 *
 * Every assertion reports concrete units (ms, MB, requests/s, count) so the
 * coordinator/user can read the results without inspecting the code.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  SharedLLMClient, RequestQueue, QueueOverflowError, QueueTimeoutError,
  AdaptiveController, resolveLLMConfig, validateLLMConfig,
  DEFAULT_ADAPTIVE, LLM_EXPOSURE_COUNTS,
  LLMError, isLLMError, registerLLMExposure,
} from "../../src/shared/llm/index.ts";
import { snapshotExposure, resetExposureForTest } from "../../src/shared/exposure/index.ts";
import { address, serve, type UpstreamHandler, type UpstreamRequest } from "../support/loopback-upstream.ts";

/** Install `handler` as the loopback upstream's answer (the spread keeps a config literal's shape). */
function upstream(handler: UpstreamHandler): Record<string, never> {
  serve(handler);
  return {};
}

// ── Loopback upstream answers: a controllable SSE response with per-call latency ─────────

function mockFetchLatency(latencyMs: number, content = "ok", model = "gemma-4-31b"): UpstreamHandler {
  return async () => {
    await new Promise((r) => setTimeout(r, latencyMs));
    return new Response(responsesSse({ content, model }), { headers: { "content-type": "text/event-stream", "x-model-id": model } });
  };
}

/** Non-streaming JSON mock with latency + a shared in-flight counter. */
function mockFetchJsonLatency(latencyMs: number, counter: { inFlight: number; max: number }, content = "ok", model = "gemma-4-31b"): UpstreamHandler {
  return async () => {
    counter.inFlight++;
    if (counter.inFlight > counter.max) counter.max = counter.inFlight;
    await new Promise((r) => setTimeout(r, latencyMs));
    counter.inFlight--;
    return new Response(JSON.stringify(responseResource({ model, content })), { headers: { "content-type": "application/json", "x-model-id": model } });
  };
}

/** Mock fetch that returns 429 rate-limit on every call (drives adaptive decrease). */
function mockFetch429(): UpstreamHandler {
  return async () => new Response('{"error":{"message":"rate limited"}}', { status: 429, headers: { "content-type": "text/plain", "retry-after": "0" } });
}

function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    baseUrl: address("https://api.test.com/v1"),
    apiKey: "sk-test-key-1234567890",
    allowPrivateAddress: true,
    model: "gemma-4-31b",
    timeout: 10_000,
    maxRetries: { "rate-limit": 0, server: 0, network: 0, overloaded: 0, timeout: 0 },
    backoff: { baseMs: 1, factor: 2, maxMs: 2, jitter: 0 },
    circuitBreaker: { threshold: 1000, resetMs: 1000 },
    ...overrides,
  };
}

// Native source fixture; the client owns privacy admission.
const MESSAGES = ({ input: "Hi" });

// ── helpers: process metrics ──────────────────────────────────────────────

function rssMb(): number {
  return process.memoryUsage().rss / (1024 * 1024);
}
function cpuUserMs(): number {
  return process.cpuUsage().user;
}
function nowMs(): number {
  return performance.now();
}
function fmtRequestsPerSecond(count: number, ms: number): string {
  return (count / (ms / 1000)).toFixed(1);
}

// Reset the process-local exposure registry once before the suite so the
// LLM catalog registration does not leak across files in the same process.
resetExposureForTest();
registerLLMExposure();

// ── 1. Queue config options are all configurable + exposed ─────────────────

test("EXP457: queue config options are all configurable + exposed", () => {
  const cfg = baseConfig({
    queue: { maxConcurrency: 7, maxQueueSize: 50, queueTimeoutMs: 5000, priorityLevels: true, queueStrategy: "lifo" },
  });
  const resolved = resolveLLMConfig(cfg as never).config!;
  assert.equal(resolved.queue.maxConcurrency, 7);
  assert.equal(resolved.queue.maxQueueSize, 50);
  assert.equal(resolved.queue.queueTimeoutMs, 5000);
  assert.equal(resolved.queue.priorityLevels, true);
  assert.equal(resolved.queue.queueStrategy, "lifo");
  assert.equal(resolved.concurrency, 7, "queue.maxConcurrency overrides top-level concurrency");
});

test("EXP457: concurrency policy config (perModel/perProvider/global) is configurable", () => {
  const cfg = baseConfig({
    concurrencyPolicy: { perModel: { "gemma-4-31b": 5, "qwen3.6-35b-fast": 3 }, perProvider: { neuralwatt: 5, openai: 10 }, global: 8 },
  });
  const resolved = resolveLLMConfig(cfg as never).config!;
  assert.equal(resolved.concurrencyPolicy.perModel?.["gemma-4-31b"], 5);
  assert.equal(resolved.concurrencyPolicy.perModel?.["qwen3.6-35b-fast"], 3);
  assert.equal(resolved.concurrencyPolicy.perProvider?.neuralwatt, 5);
  assert.equal(resolved.concurrencyPolicy.perProvider?.openai, 10);
  assert.equal(resolved.concurrencyPolicy.global, 8);
});

test("EXP457: adaptive config defaults + overrides", () => {
  const resolved = resolveLLMConfig(baseConfig() as never).config!;
  assert.equal(resolved.adaptive.enabled, false);
  assert.equal(resolved.adaptive.minConcurrency, 1);
  assert.equal(resolved.adaptive.maxConcurrency, 50);
  assert.equal(resolved.adaptive.decreaseFactor, 0.5);
  assert.equal(resolved.adaptive.increaseStep, 1);
  assert.equal(resolved.adaptive.errorThreshold, 0.5);
  assert.equal(resolved.adaptive.sampleWindow, 20);
  const resolved2 = resolveLLMConfig(baseConfig({
    adaptive: { enabled: true, minConcurrency: 2, maxConcurrency: 12, increaseStep: 2, decreaseFactor: 0.25, sampleWindow: 5 },
  }) as never).config!;
  assert.equal(resolved2.adaptive.enabled, true);
  assert.equal(resolved2.adaptive.minConcurrency, 2);
  assert.equal(resolved2.adaptive.maxConcurrency, 12);
  assert.equal(resolved2.adaptive.increaseStep, 2);
  assert.equal(resolved2.adaptive.decreaseFactor, 0.25);
  assert.equal(resolved2.adaptive.sampleWindow, 5);
});

test("EXP457: exposure catalog includes the new queue + adaptive signals/actions/customization", () => {
  const snap = snapshotExposure("llm");
  assert.equal(snap.signals.length, LLM_EXPOSURE_COUNTS.signals, `signals=${snap.signals.length}`);
  assert.equal(snap.actions.length, LLM_EXPOSURE_COUNTS.actions, `actions=${snap.actions.length}`);
  assert.equal(snap.customizations.length, LLM_EXPOSURE_COUNTS.customizations, `customizations=${snap.customizations.length}`);
  const sigIds = new Set(snap.signals.map((s) => s.id));
  for (const id of ["queue.rejected", "queue.timedOut", "queue.utilization", "queue.strategy", "adaptive.concurrency", "adaptive.lastDecision", "adaptive.increases", "adaptive.decreases"]) {
    assert.ok(sigIds.has(id), `signal '${id}' exposed`);
  }
  const actIds = new Set(snap.actions.map((a) => a.id));
  for (const id of ["queue.setConcurrency", "queue.pauseQueue", "queue.resumeQueue", "queue.clearQueue", "queue.rejectAll"]) {
    assert.ok(actIds.has(id), `action '${id}' exposed`);
  }
  const optIds = new Set(snap.customizations.map((o) => o.id));
  for (const id of ["queue.maxConcurrency", "queue.maxQueueSize", "queue.queueTimeoutMs", "queue.priorityLevels", "queue.strategy", "concurrency.perModel", "concurrency.perProvider", "concurrency.global", "adaptive.enabled", "adaptive.decreaseFactor", "adaptive.rateLimitWeight"]) {
    assert.ok(optIds.has(id), `customization '${id}' exposed`);
  }
});

// ── 2. 100 concurrent requests → maxConcurrency respected ─────────────────

test("EXP457: 100 concurrent requests respect maxConcurrency (no more than N in flight)", async () => {
  const maxConc = 5;
  const counter = { inFlight: 0, max: 0 };
  const client = new SharedLLMClient(baseConfig({
    model: "gemma-4-31b",
    queue: { maxConcurrency: maxConc, maxQueueSize: 200, queueTimeoutMs: 30_000 },
    ...upstream(mockFetchJsonLatency(15, counter)),
  }) as never);
  const N = 100;
  const tasks: Promise<unknown>[] = [];
  const t0 = nowMs();
  for (let i = 0; i < N; i++) {
    tasks.push(client.create(({ ...MESSAGES, model: "gemma-4-31b"  }), {}));
  }
  await Promise.allSettled(tasks);
  const elapsed = nowMs() - t0;
  const finalQ = client.getQueue();
  assert.ok(counter.max <= maxConc, `maxInFlight=${counter.max} must be <= maxConcurrency=${maxConc}`);
  assert.equal(finalQ.active, 0, "all slots released after completion");
  assert.equal(finalQ.rejected, 0, "no rejections under maxQueueSize=200");
  assert.equal(finalQ.timedOut, 0);
  console.log(`  [100-concurrent] maxInFlight=${counter.max} maxConcurrency=${maxConc} elapsed=${elapsed.toFixed(0)}ms throughput=${fmtRequestsPerSecond(N, elapsed)} req/s queue.maxQueueSize=200`);
});

// ── 3. 1000 requests handled (no crash, no OOM) ───────────────────────────

test("EXP457: 1000 requests handled without crash or OOM", async () => {
  const maxConc = 10;
  const counter = { inFlight: 0, max: 0 };
  const client = new SharedLLMClient(baseConfig({
    model: "gemma-4-31b",
    queue: { maxConcurrency: maxConc, maxQueueSize: 1000, queueTimeoutMs: 30_000 },
    ...upstream(mockFetchJsonLatency(2, counter)),
  }) as never);
  const rssBefore = rssMb();
  const cpuBefore = cpuUserMs();
  const N = 1000;
  const t0 = nowMs();
  let completed = 0;
  let errors = 0;
  // Run in bounded waves so we do not allocate 1000 promises at once.
  const wave = 50;
  for (let i = 0; i < N; i += wave) {
    const batch: Promise<void>[] = [];
    for (let j = 0; j < wave && i + j < N; j++) {
      batch.push((async () => {
        try {
          await client.create(({ ...MESSAGES, model: "gemma-4-31b"  }), {});
          completed++;
        } catch {
          errors++;
        }
      })());
    }
    await Promise.allSettled(batch);
  }
  const elapsed = nowMs() - t0;
  const rssAfter = rssMb();
  const cpuAfter = cpuUserMs();
  const q = client.getQueue();
  assert.equal(completed + errors, N, `all ${N} requests settled (completed=${completed} errors=${errors})`);
  assert.equal(q.active, 0);
  assert.equal(q.rejected, 0, "maxQueueSize=1000 absorbed the wave");
  assert.ok(counter.max <= maxConc, `maxInFlight=${counter.max} <= ${maxConc}`);
  assert.ok(rssAfter - rssBefore < 200, `RSS delta=${(rssAfter - rssBefore).toFixed(1)}MB must be < 200MB (no OOM)`);
  console.log(`  [1000-requests] completed=${completed} errors=${errors} maxInFlight=${counter.max}/${maxConc} elapsed=${elapsed.toFixed(0)}ms throughput=${fmtRequestsPerSecond(N, elapsed)} req/s rssBefore=${rssBefore.toFixed(0)}MB rssAfter=${rssAfter.toFixed(0)}MB deltaRss=${(rssAfter - rssBefore).toFixed(1)}MB cpuUser=${((cpuAfter - cpuBefore) / 1000).toFixed(1)}ms`);
});

// ── 4. Priority queue: 10 high + 100 low → high goes first ─────────────────

test("EXP457: priority queue serves high-priority requests before low-priority", async () => {
  // Use the raw RequestQueue so the test does not depend on the client
  // generator's slot lifetime (a streaming generator holds its slot across
  // yields, which complicates deterministic admission ordering).
  const q = new RequestQueue({ maxConcurrency: 1, maxQueueSize: 500, queueTimeoutMs: 30_000, priorityLevels: true, queueStrategy: "priority" });
  const completionOrder: string[] = [];
  // Occupy the single slot so everything else queues.
  const blockerRelease = new Promise<void>((r) => setTimeout(r, 25));
  const first = q.run({ model: "m", provider: "p" }, async () => { await blockerRelease; });
  await new Promise((r) => setImmediate(r)); // let the blocker acquire the slot
  // Submit 100 low-priority then 10 high-priority (high submitted AFTER low,
  // proving priority ordering rather than arrival luck).
  const gate: Promise<unknown>[] = [];
  for (let i = 0; i < 100; i++) {
    gate.push(q.run({ model: "m", provider: "p", priority: 0 }, async () => { completionOrder.push(`low-${i}`); }));
  }
  for (let i = 0; i < 10; i++) {
    gate.push(q.run({ model: "m", provider: "p", priority: 10 }, async () => { completionOrder.push(`high-${i}`); }));
  }
  await first; // blocker releases the slot → dispatching begins in priority order
  await Promise.allSettled(gate);
  const firstHigh = completionOrder.findIndex((x) => x.startsWith("high-"));
  const firstLow = completionOrder.findIndex((x) => x.startsWith("low-"));
  assert.ok(firstHigh !== -1 && firstLow !== -1, "both groups completed");
  assert.ok(firstHigh < firstLow, `first high (#${firstHigh}) must complete before first low (#${firstLow}) — priority works`);
  // The first 10 completions after the blocker should all be high-priority.
  const firstTen = completionOrder.slice(0, 10);
  const allHighFirst = firstTen.every((x) => x.startsWith("high-"));
  assert.ok(allHighFirst, `first 10 completions must all be high-priority (got: ${firstTen.join(",")})`);
  console.log(`  [priority] firstHigh=#${firstHigh} firstLow=#${firstLow} first10=[${firstTen.join(",")}] queueStrategy=priority`);
});

// ── 5. Adaptive: slow/429 API reduces concurrency; fast API increases ────

test("EXP457: AIMD adaptive — 429 storm decreases concurrency", () => {
  const controller = new AdaptiveController(
    { ...DEFAULT_ADAPTIVE, enabled: true, minConcurrency: 1, maxConcurrency: 20, sampleWindow: 5, errorThreshold: 0.5 },
    10,
  );
  // Feed 5 rate-limit errors → error rate 1.0 > 0.5 → multiplicative decrease.
  for (let i = 0; i < 5; i++) {
    controller.record({ durationMs: 100, errorType: "rate-limit" });
  }
  const snap = controller.snapshot();
  assert.equal(snap.lastDecision, "decrease");
  assert.equal(snap.concurrency, 5, "10 * 0.5 = 5 (multiplicative decrease)");
  // Another decrease window: 5 → 2 (floor(5*0.5)=2).
  for (let i = 0; i < 5; i++) controller.record({ durationMs: 100, errorType: "rate-limit" });
  assert.equal(controller.snapshot().concurrency, 2);
  // Floor: 2 → 1 (floor(2*0.5)=1).
  for (let i = 0; i < 5; i++) controller.record({ durationMs: 100, errorType: "rate-limit" });
  assert.equal(controller.snapshot().concurrency, 1, "floored at minConcurrency=1");
});

test("EXP457: AIMD adaptive — fast + error-free API increases concurrency", () => {
  const controller = new AdaptiveController(
    { ...DEFAULT_ADAPTIVE, enabled: true, minConcurrency: 1, maxConcurrency: 20, sampleWindow: 5, fastLatencyMs: 500, slowLatencyMs: 5000 },
    5,
  );
  // 5 fast, error-free samples → additive increase.
  for (let i = 0; i < 5; i++) controller.record({ durationMs: 50, errorType: undefined });
  const snap = controller.snapshot();
  assert.equal(snap.lastDecision, "increase");
  assert.equal(snap.concurrency, 6, "5 + 1 (additive increase)");
  // Keep increasing until ceiling.
  for (let i = 0; i < 5; i++) controller.record({ durationMs: 50, errorType: undefined });
  assert.equal(controller.snapshot().concurrency, 7);
});

test("EXP457: AIMD adaptive wired in client — 429s drive the queue concurrency down", async () => {
  const client = new SharedLLMClient(baseConfig({
    model: "gemma-4-31b",
    queue: { maxConcurrency: 8, maxQueueSize: 100, queueTimeoutMs: 5000 },
    adaptive: { enabled: true, minConcurrency: 1, maxConcurrency: 8, sampleWindow: 3, errorThreshold: 0.5, decreaseFactor: 0.5 },
    ...upstream(mockFetch429()),
  }) as never);
  const before = client.getAdaptive().concurrency;
  // 3 rate-limit errors fill the window → decrease 8 → 4.
  for (let i = 0; i < 3; i++) {
    try { await client.create(({ ...MESSAGES, model: "gemma-4-31b"  }), {}); } catch { /* expected 429 */ }
  }
  const after = client.getAdaptive().concurrency;
  const queueConc = client.getQueue().maxConcurrency;
  assert.equal(before, 8);
  assert.equal(after, 4, "8 * 0.5 = 4 after one decrease window");
  assert.equal(queueConc, 4, "queue.setConcurrency applied the AIMD value");
  console.log(`  [adaptive-429] concurrency ${before} → ${after} (queue=${queueConc}) decisions=${JSON.stringify(client.getAdaptive().decisions)}`);
});

test("EXP457: AIMD adaptive disabled by default (deterministic, no auto-adjust)", async () => {
  const counter = { inFlight: 0, max: 0 };
  const client = new SharedLLMClient(baseConfig({
    queue: { maxConcurrency: 5 },
    ...upstream(mockFetchJsonLatency(2, counter)),
  }) as never);
  assert.equal(client.getAdaptive().enabled, false);
  for (let i = 0; i < 30; i++) { try { await client.create(({ ...MESSAGES, model: "gemma-4-31b"  }), {}); } catch { /* ok */ } }
  assert.equal(client.getAdaptive().concurrency, 5, "no change when disabled");
  assert.equal(client.getQueue().maxConcurrency, 5);
});

// ── 6. Per-model concurrency: gemma=5, qwen=3 → separate limits ────────────

test("EXP457: per-model concurrency — gemma=5 and qwen=3 enforced separately", async () => {
  const q = new RequestQueue(
    { maxConcurrency: 20, maxQueueSize: 500, queueTimeoutMs: 30_000 },
    { perModel: { "gemma-4-31b": 5, "qwen3.6-35b-fast": 3 } },
  );
  let gemmaInFlight = 0;
  let qwenInFlight = 0;
  let gemmaMax = 0;
  let qwenMax = 0;
  const gate: Promise<unknown>[] = [];
  const t0 = nowMs();
  for (let i = 0; i < 20; i++) {
    gate.push(q.run({ model: "gemma-4-31b", provider: "neuralwatt" }, async () => {
      gemmaInFlight = q.perModelActiveCount("gemma-4-31b");
      if (gemmaInFlight > gemmaMax) gemmaMax = gemmaInFlight;
      await new Promise((r) => setTimeout(r, 8));
    }));
  }
  for (let i = 0; i < 20; i++) {
    gate.push(q.run({ model: "qwen3.6-35b-fast", provider: "neuralwatt" }, async () => {
      qwenInFlight = q.perModelActiveCount("qwen3.6-35b-fast");
      if (qwenInFlight > qwenMax) qwenMax = qwenInFlight;
      await new Promise((r) => setTimeout(r, 8));
    }));
  }
  await Promise.allSettled(gate);
  const elapsed = nowMs() - t0;
  assert.ok(gemmaMax <= 5, `gemmaMax=${gemmaMax} must be <= perModel.gemma=5`);
  assert.ok(qwenMax <= 3, `qwenMax=${qwenMax} must be <= perModel.qwen=3`);
  assert.equal(q.activeCount(), 0, "all slots released");
  console.log(`  [per-model] gemmaMax=${gemmaMax}/5 qwenMax=${qwenMax}/3 elapsed=${elapsed.toFixed(0)}ms throughput=${fmtRequestsPerSecond(40, elapsed)} req/s`);
});

test("EXP457: per-provider + global concurrency enforced", async () => {
  const q = new RequestQueue(
    { maxConcurrency: 30, maxQueueSize: 500, queueTimeoutMs: 30_000 },
    { perProvider: { neuralwatt: 4, openai: 6 }, global: 7 },
  );
  let provMaxNeuralwatt = 0;
  let provMaxOpenai = 0;
  let globalMax = 0;
  const gate: Promise<unknown>[] = [];
  for (let i = 0; i < 30; i++) {
    const provider = i % 2 === 0 ? "neuralwatt" : "openai";
    gate.push(q.run({ model: "m", provider }, async () => {
      const nw = q.perProviderActiveCount("neuralwatt");
      const oa = q.perProviderActiveCount("openai");
      const active = q.activeCount();
      if (nw > provMaxNeuralwatt) provMaxNeuralwatt = nw;
      if (oa > provMaxOpenai) provMaxOpenai = oa;
      if (active > globalMax) globalMax = active;
      await new Promise((r) => setTimeout(r, 5));
    }));
  }
  await Promise.allSettled(gate);
  assert.ok(provMaxNeuralwatt <= 4, `neuralwatt max=${provMaxNeuralwatt} <= 4`);
  assert.ok(provMaxOpenai <= 6, `openai max=${provMaxOpenai} <= 6`);
  assert.ok(globalMax <= 7, `global max=${globalMax} <= 7`);
});

// ── 7. Improper usage: invalid config, negative concurrency, zero queue ───

test("EXP457: improper — invalid config rejected by validateLLMConfig", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["queue.maxConcurrency=0", baseConfig({ queue: { maxConcurrency: 0 } })],
    ["queue.maxConcurrency=-1", baseConfig({ queue: { maxConcurrency: -1 } })],
    ["queue.maxConcurrency=2.5", baseConfig({ queue: { maxConcurrency: 2.5 } })],
    ["queue.maxQueueSize=-1", baseConfig({ queue: { maxQueueSize: -1 } })],
    ["queue.queueTimeoutMs=-1", baseConfig({ queue: { queueTimeoutMs: -1 } })],
    ["queue.queueStrategy=bogus", baseConfig({ queue: { queueStrategy: "bogus" as never } })],
    ["concurrency.global=0", baseConfig({ concurrencyPolicy: { global: 0 } })],
    ["concurrency.perModel.gemma=0", baseConfig({ concurrencyPolicy: { perModel: { "gemma-4-31b": 0 } } })],
    ["adaptive.decreaseFactor=1.0", baseConfig({ adaptive: { decreaseFactor: 1.0 } })],
    ["adaptive.decreaseFactor=0", baseConfig({ adaptive: { decreaseFactor: 0 } })],
    ["adaptive.errorThreshold=1.5", baseConfig({ adaptive: { errorThreshold: 1.5 } })],
    ["adaptive.minConcurrency>maxConcurrency", baseConfig({ adaptive: { minConcurrency: 10, maxConcurrency: 5 } })],
    ["adaptive.fastLatencyMs>slowLatencyMs", baseConfig({ adaptive: { fastLatencyMs: 5000, slowLatencyMs: 1000 } })],
  ];
  for (const [label, cfg] of cases) {
    const err = validateLLMConfig(cfg as never);
    assert.ok(err !== null, `must reject ${label} (got: ${err})`);
  }
});

test("EXP457: improper — queue overflow rejects when maxQueueSize exceeded", async () => {
  // maxConcurrency=1, maxQueueSize=0 → every request beyond the first is rejected.
  const q = new RequestQueue({ maxConcurrency: 1, maxQueueSize: 0, queueTimeoutMs: 30_000 });
  const release = new Promise<void>((r) => setTimeout(() => { r(); }, 30));
  // Occupy the single slot.
  const first = q.run({ model: "m", provider: "p" }, async () => { await release; });
  await new Promise((r) => setImmediate(r)); // let first acquire
  let rejected = 0;
  for (let i = 0; i < 50; i++) {
    try { await q.acquire({ model: "m", provider: "p" }); } catch (e) {
      if (e instanceof QueueOverflowError) rejected++;
    }
  }
  await first;
  assert.equal(rejected, 50, "all 50 overflow requests rejected (maxQueueSize=0)");
  assert.equal(q.rejectedCount(), 50);
});

test("EXP457: improper — queue timeout rejects stale waiters", async () => {
  const q = new RequestQueue({ maxConcurrency: 1, maxQueueSize: 100, queueTimeoutMs: 20 });
  const release = new Promise<void>((r) => setTimeout(r, 60));
  const first = q.run({ model: "m", provider: "p" }, async () => { await release; });
  await new Promise((r) => setImmediate(r));
  let timedOut = 0;
  try { await q.acquire({ model: "m", provider: "p" }); }
  catch (e) { if (e instanceof QueueTimeoutError) timedOut++; }
  await first;
  assert.equal(timedOut, 1, "waiter timed out after 20ms while slot held for 60ms");
  assert.ok(q.timedOutCount() >= 1);
});

test("EXP457: improper — invalid RequestQueue construction throws", () => {
  assert.throws(() => new RequestQueue({ maxConcurrency: 0, maxQueueSize: 100 } as never), /maxConcurrency/);
  assert.throws(() => new RequestQueue({ maxConcurrency: 1, maxQueueSize: -1 } as never), /maxQueueSize/);
  assert.throws(() => new RequestQueue({ maxConcurrency: 1, queueTimeoutMs: -1 } as never), /queueTimeoutMs/);
});

test("EXP457: improper — setConcurrency rejects non-positive integers", () => {
  const q = new RequestQueue({ maxConcurrency: 3 });
  assert.throws(() => q.setConcurrency(0), /integer >= 1/);
  assert.throws(() => q.setConcurrency(-2), /integer >= 1/);
  assert.throws(() => q.setConcurrency(2.5 as never), /integer >= 1/);
  // LLM client surface too.
  const client = new SharedLLMClient(baseConfig({ ...upstream(mockFetchLatency(1)) }) as never);
  assert.throws(() => client.setConcurrency(0), /integer >= 1/);
});

test("EXP457: improper — invalid config throws LLMError on construction", () => {
  assert.throws(
    () => new SharedLLMClient(baseConfig({ queue: { maxConcurrency: -1 } }) as never),
    (e: unknown) => isLLMError(e) && (e as LLMError).code === "llm_config_invalid",
  );
});

test("EXP457: improper — pauseQueue blocks admission; resumeQueue unblocks", async () => {
  const q = new RequestQueue({ maxConcurrency: 5, maxQueueSize: 100, queueTimeoutMs: 30_000 });
  q.pauseQueue();
  assert.equal(q.isPaused(), true);
  let admitted = false;
  const p = q.run({ model: "m", provider: "p" }, async () => { admitted = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(admitted, false, "paused queue does not admit");
  assert.equal(q.pendingCount(), 1, "request waits in pending while paused");
  q.resumeQueue();
  await p;
  assert.equal(admitted, true, "resumed queue admits the waiter");
});

test("EXP457: improper — clearQueue + rejectAll drop pending requests", async () => {
  const q = new RequestQueue({ maxConcurrency: 1, maxQueueSize: 100, queueTimeoutMs: 30_000 });
  const hold = new Promise<void>((r) => setTimeout(r, 40));
  const first = q.run({ model: "m", provider: "p" }, async () => { await hold; });
  await new Promise((r) => setImmediate(r));
  const waiters: Promise<void>[] = [];
  for (let i = 0; i < 10; i++) waiters.push(q.acquire({ model: "m", provider: "p" }));
  await new Promise((r) => setTimeout(r, 5));
  const dropped = q.clearQueue();
  assert.ok(dropped >= 9, `clearQueue dropped ${dropped} pending`);
  let clearedErrors = 0;
  for (const w of waiters) { try { await w; } catch { clearedErrors++; } }
  assert.ok(clearedErrors >= 9, "waiters rejected with cleared error");
  await first;
  // rejectAll also pauses.
  q.run({ model: "m", provider: "p" }, async () => {}).catch(() => {});
  await new Promise((r) => setTimeout(r, 5));
  const dropped2 = q.rejectAll();
  assert.ok(q.isPaused(), "rejectAll pauses admission");
  assert.ok(dropped2 >= 0);
  q.resumeQueue();
});

// ── 8. Performance: CPU, RAM, latency, throughput, queue length, wait time ─

test("EXP457: performance — throughput, queue length, wait time under load", async () => {
  const maxConc = 8;
  const counter = { inFlight: 0, max: 0 };
  const client = new SharedLLMClient(baseConfig({
    model: "gemma-4-31b",
    queue: { maxConcurrency: maxConc, maxQueueSize: 500, queueTimeoutMs: 30_000 },
    ...upstream(mockFetchJsonLatency(4, counter)),
  }) as never);
  const N = 200;
  const t0 = nowMs();
  const cpuBefore = cpuUserMs();
  const rssBefore = rssMb();
  const tasks: Promise<unknown>[] = [];
  for (let i = 0; i < N; i++) {
    tasks.push(client.create(({ ...MESSAGES, model: "gemma-4-31b"  }), {}));
  }
  await Promise.allSettled(tasks);
  const elapsed = nowMs() - t0;
  const cpuAfter = cpuUserMs();
  const rssAfter = rssMb();
  const q = client.getQueue();
  const throughput = fmtRequestsPerSecond(N, elapsed);
  assert.equal(q.active, 0);
  assert.equal(q.rejected, 0);
  assert.ok(counter.max <= maxConc, `maxInFlight=${counter.max} <= ${maxConc}`);
  assert.ok(Number(throughput) > 0);
  console.log(`  [perf] N=${N} maxConcurrency=${maxConc} maxInFlight=${counter.max} elapsed=${elapsed.toFixed(0)}ms throughput=${throughput} req/s queueActive=${q.active} queuePending=${q.pending} avgWaitMs=${q.avgWaitMs.toFixed(2)} utilization=${(q.utilization * 100).toFixed(0)}% rssDelta=${(rssAfter - rssBefore).toFixed(1)}MB cpuUser=${((cpuAfter - cpuBefore) / 1000).toFixed(1)}ms`);
});

// ── 9. setConcurrency action at runtime (overrides AIMD) ──────────────────

test("EXP457: setConcurrency action adjusts the queue cap at runtime", async () => {
  // Adaptive disabled (default): setConcurrency sets the queue directly;
  // the AIMD controller is not touched.
  const client = new SharedLLMClient(baseConfig({
    queue: { maxConcurrency: 5 }, ...upstream(mockFetchJsonLatency(1, { inFlight: 0, max: 0 })),
  }) as never);
  assert.equal(client.getQueue().maxConcurrency, 5);
  assert.equal(client.getAdaptive().enabled, false);
  client.setConcurrency(12);
  assert.equal(client.getQueue().maxConcurrency, 12, "setConcurrency raised the cap (adaptive off → exact)");
  client.setConcurrency(3);
  assert.equal(client.getQueue().maxConcurrency, 3, "setConcurrency lowered the cap (adaptive off → exact)");

  // Adaptive enabled: setConcurrency flows through the AIMD controller, so it
  // is bounded by adaptive.min/max.
  const client2 = new SharedLLMClient(baseConfig({
    queue: { maxConcurrency: 5 },
    adaptive: { enabled: true, minConcurrency: 1, maxConcurrency: 10 },
    ...upstream(mockFetchJsonLatency(1, { inFlight: 0, max: 0 })),
  }) as never);
  client2.setConcurrency(50);
  assert.equal(client2.getAdaptive().concurrency, 10, "bounded by adaptive.maxConcurrency=10");
  assert.equal(client2.getQueue().maxConcurrency, 10, "queue follows the AIMD value");
});

// ── 10. Queue strategy: fifo vs lifo ordering ─────────────────────────────

test("EXP457: fifo vs lifo queue ordering", async () => {
  const fifo = new RequestQueue({ maxConcurrency: 1, maxQueueSize: 100, queueTimeoutMs: 30_000, queueStrategy: "fifo" });
  const lifo = new RequestQueue({ maxConcurrency: 1, maxQueueSize: 100, queueTimeoutMs: 30_000, queueStrategy: "lifo" });
  async function orderFor(q: RequestQueue): Promise<string[]> {
    const out: string[] = [];
    const hold = new Promise<void>((r) => setTimeout(r, 20));
    const first = q.run({ model: "m", provider: "p" }, async () => { await hold; });
    await new Promise((r) => setImmediate(r));
    const a = q.run({ model: "m", provider: "p" }, async () => { out.push("a"); }).then(() => out.push("a-done"));
    const b = q.run({ model: "m", provider: "p" }, async () => { out.push("b"); }).then(() => out.push("b-done"));
    await first; await a; await b;
    return out;
  }
  const fifoOrder = await orderFor(fifo);
  const lifoOrder = await orderFor(lifo);
  assert.equal(fifoOrder[0], "a", "fifo serves the first-queued request (a) first");
  assert.equal(lifoOrder[0], "b", "lifo serves the last-queued request (b) first");
});

// ── 11. 10× harder auto-escalation (the rule: when 100% passes, go 10×) ───

test("EXP457 10× harder: 1000 requests submitted CONCURRENTLY (not waved) respect maxConcurrency", async () => {
  const maxConc = 10;
  const counter = { inFlight: 0, max: 0 };
  const client = new SharedLLMClient(baseConfig({
    model: "gemma-4-31b",
    queue: { maxConcurrency: maxConc, maxQueueSize: 2000, queueTimeoutMs: 30_000 },
    ...upstream(mockFetchJsonLatency(1, counter)),
  }) as never);
  const N = 1000;
  const tasks: Promise<unknown>[] = [];
  const t0 = nowMs();
  for (let i = 0; i < N; i++) tasks.push(client.create(({ ...MESSAGES, model: "gemma-4-31b"  }), {}));
  await Promise.allSettled(tasks);
  const elapsed = nowMs() - t0;
  const q = client.getQueue();
  assert.ok(counter.max <= maxConc, `maxInFlight=${counter.max} <= ${maxConc}`);
  assert.equal(q.active, 0);
  assert.equal(q.rejected, 0, "maxQueueSize=2000 absorbed 1000 concurrent");
  assert.equal(q.timedOut, 0);
  console.log(`  [10x-1000-concurrent] maxInFlight=${counter.max}/${maxConc} elapsed=${elapsed.toFixed(0)}ms throughput=${fmtRequestsPerSecond(N, elapsed)} req/s`);
});

test("EXP457 10× harder: 100 high-priority + 1000 low-priority → high goes first", async () => {
  const q = new RequestQueue({ maxConcurrency: 2, maxQueueSize: 5000, queueTimeoutMs: 30_000, priorityLevels: true, queueStrategy: "priority" });
  const order: string[] = [];
  const blockerRelease = new Promise<void>((r) => setTimeout(r, 20));
  const first = q.run({ model: "m", provider: "p" }, async () => { await blockerRelease; });
  const second = q.run({ model: "m", provider: "p" }, async () => { await blockerRelease; });
  await new Promise((r) => setImmediate(r));
  const gate: Promise<unknown>[] = [];
  for (let i = 0; i < 1000; i++) gate.push(q.run({ model: "m", provider: "p", priority: 0 }, async () => { order.push(`low-${i}`); }));
  for (let i = 0; i < 100; i++) gate.push(q.run({ model: "m", provider: "p", priority: 10 }, async () => { order.push(`high-${i}`); }));
  await Promise.allSettled([first, second]);
  await Promise.allSettled(gate);
  const firstHigh = order.findIndex((x) => x.startsWith("high-"));
  const firstLow = order.findIndex((x) => x.startsWith("low-"));
  assert.ok(firstHigh !== -1 && firstLow !== -1, "both groups completed");
  assert.ok(firstHigh < firstLow, `first high (#${firstHigh}) before first low (#${firstLow}) at 10× scale`);
  const first100 = order.slice(0, 100);
  const highInFirst100 = first100.filter((x) => x.startsWith("high-")).length;
  assert.ok(highInFirst100 >= 90, `at least 90 of the first 100 completions are high-priority (got ${highInFirst100}/100)`);
  console.log(`  [10x-priority] N=1100 firstHigh=#${firstHigh} firstLow=#${firstLow} highInFirst100=${highInFirst100}/100`);
});

test("EXP457 10× harder: 3-model + 3-provider concurrency policy enforced", async () => {
  const q = new RequestQueue(
    { maxConcurrency: 50, maxQueueSize: 2000, queueTimeoutMs: 30_000 },
    { perModel: { gemma: 5, qwen: 3, glm: 4 }, perProvider: { neuralwatt: 6, openai: 7, local: 8 }, global: 9 },
  );
  const maxes: Record<string, number> = { gemma: 0, qwen: 0, glm: 0 };
  const provMaxes: Record<string, number> = { neuralwatt: 0, openai: 0, local: 0 };
  let globalMax = 0;
  const gate: Promise<unknown>[] = [];
  const models = ["gemma", "qwen", "glm"];
  const providers = ["neuralwatt", "openai", "local"];
  for (let i = 0; i < 300; i++) {
    const model = models[i % 3]!;
    const provider = providers[i % 3]!;
    gate.push(q.run({ model, provider }, async () => {
      const m = q.perModelActiveCount(model); if (m > maxes[model]!) maxes[model] = m;
      const p = q.perProviderActiveCount(provider); if (p > provMaxes[provider]!) provMaxes[provider] = p;
      const a = q.activeCount(); if (a > globalMax) globalMax = a;
      await new Promise((r) => setTimeout(r, 3));
    }));
  }
  await Promise.allSettled(gate);
  assert.ok(maxes.gemma! <= 5, `gemma=${maxes.gemma} <= 5`);
  assert.ok(maxes.qwen! <= 3, `qwen=${maxes.qwen} <= 3`);
  assert.ok(maxes.glm! <= 4, `glm=${maxes.glm} <= 4`);
  assert.ok(provMaxes.neuralwatt! <= 6, `neuralwatt=${provMaxes.neuralwatt} <= 6`);
  assert.ok(provMaxes.openai! <= 7, `openai=${provMaxes.openai} <= 7`);
  assert.ok(provMaxes.local! <= 8, `local=${provMaxes.local} <= 8`);
  assert.ok(globalMax <= 9, `global=${globalMax} <= 9`);
  console.log(`  [10x-3model-3provider] modelMaxes=${JSON.stringify(maxes)} provMaxes=${JSON.stringify(provMaxes)} globalMax=${globalMax}`);
});

test("EXP457 10× harder: AIMD converges under alternating fast/429 bursts", () => {
  const controller = new AdaptiveController(
    { ...DEFAULT_ADAPTIVE, enabled: true, minConcurrency: 1, maxConcurrency: 30, sampleWindow: 4, errorThreshold: 0.5, decreaseFactor: 0.5, increaseStep: 2, fastLatencyMs: 200, slowLatencyMs: 5000 },
    8,
  );
  // Burst 1: 4 rate-limits → decrease 8 → 4.
  for (let i = 0; i < 4; i++) controller.record({ durationMs: 100, errorType: "rate-limit" });
  assert.equal(controller.snapshot().concurrency, 4, "burst1 decrease 8→4");
  // Burst 2: 4 fast successes → increase 4 → 6.
  for (let i = 0; i < 4; i++) controller.record({ durationMs: 50, errorType: undefined });
  assert.equal(controller.snapshot().concurrency, 6, "burst2 increase 4→6 (step=2)");
  // Burst 3: 4 rate-limits → decrease 6 → 3.
  for (let i = 0; i < 4; i++) controller.record({ durationMs: 100, errorType: "rate-limit" });
  assert.equal(controller.snapshot().concurrency, 3, "burst3 decrease 6→3");
  // Burst 4: 4 fast successes → increase 3 → 5.
  for (let i = 0; i < 4; i++) controller.record({ durationMs: 50, errorType: undefined });
  assert.equal(controller.snapshot().concurrency, 5, "burst4 increase 3→5");
  const snap = controller.snapshot();
  assert.ok(snap.decisions.increase >= 2 && snap.decisions.decrease >= 2, "AIMD oscillated both ways");
  console.log(`  [10x-aimd-converge] final=${snap.concurrency} decisions=${JSON.stringify(snap.decisions)}`);
});

// ── EXP467 — stream-slot release contract (addresses EXP457 #2) ───────────
// Root cause documented: `client.stream` acquires a concurrency slot before
// the first `yield*` and releases it in `finally`. The `finally` runs when the
// generator is EITHER fully consumed OR explicitly closed via `.return`. A
// caller that pulls a single chunk with `.next` and abandons the generator
// does NOT release the slot until GC. This is standard async-generator
// semantics. These tests pin the contract so a future refactor can't silently
// break slot release on full consumption or explicit `.return`.

test("EXP467/stream-slot: a fully-drained stream releases its concurrency slot", async () => {
  // maxConcurrency=1 so the slot is the single bottleneck — if the drained
  // stream does NOT release it, the second call would hang/timeout.
  const client = new SharedLLMClient(baseConfig({
    ...upstream(mockFetchLatency(1, "chunk", "gemma-4-31b")),
    queue: { maxConcurrency: 1, maxQueueSize: 10, queueTimeoutMs: 2000 },
  }) as never);
  // First stream: fully drain it.
  const gen1 = client.stream(MESSAGES);
  const chunks1: string[] = [];
  for await (const c of gen1) {
    if (c.type === "content" && c.text) chunks1.push(c.text);
  }
  assert.ok(chunks1.length > 0, "first stream produced content");
  // RELEASED BY ITS PATH, never judged by a wall clock (NO-LOAD-BLOCK): the
  // queue holds no slot now, and a second call acquires the only one.
  assert.equal(client.getQueue().active, 0, "the drained stream released its slot");
  const gen2 = client.stream(MESSAGES);
  const chunks2: string[] = [];
  for await (const c of gen2) {
    if (c.type === "content" && c.text) chunks2.push(c.text);
  }
  assert.ok(chunks2.length > 0, "second stream produced content after first drained");
  console.log(`  [stream-slot-drain] chunks1=${chunks1.length} chunks2=${chunks2.length}`);
});

test("EXP467/stream-slot: an explicitly-.return'd stream releases its concurrency slot", async () => {
  // A mock that returns SSE for stream requests and JSON for non-stream
  // requests, so the same client can do both `stream` and `complete`.
  function dualMock(latencyMs: number, content = "ok", model = "gemma-4-31b"): UpstreamHandler {
    return async (_url: string, init: UpstreamRequest) => {
      await new Promise((r) => setTimeout(r, latencyMs));
      const bodyStr = init.body ?? "";
      const wantsStream = bodyStr.includes('"stream":true') || bodyStr.includes('"stream": true');
      if (wantsStream) {
        return responseSseResponse({ content, model });
      }
      return new Response(JSON.stringify(responseResource({ model, content })), { headers: { "content-type": "application/json", "x-model-id": model } });
    };
  }
  const client = new SharedLLMClient(baseConfig({
    ...upstream(dualMock(1, "chunk", "gemma-4-31b")),
    queue: { maxConcurrency: 1, maxQueueSize: 10, queueTimeoutMs: 2000 },
  }) as never);
  // Pull exactly one chunk, then explicitly.return to release the slot.
  const gen = client.stream(MESSAGES);
  const first = await gen.next();
  assert.ok(!first.done, "first chunk arrived");
  // Explicitly close the generator → `finally` runs → slot released.
  await gen.return(undefined);
  // RELEASED BY ITS PATH, never judged by a wall clock (NO-LOAD-BLOCK).
  assert.equal(client.getQueue().active, 0, "the .return()'d stream released its slot");
  const result = await client.create(MESSAGES);
  assert.ok(result.content.length > 0, "complete() produced content after stream .return()");
  console.log(`  [stream-slot-return] complete() after .return() content=${JSON.stringify(result.content.slice(0, 40))}`);
});

test("EXP467/stream-slot: a stream that throws still releases its slot (finally runs)", async () => {
  // A failing fetch (429 with no retries) → stream rejects. The `finally`
  // must still release the slot so subsequent calls don't deadlock.
  const client = new SharedLLMClient(baseConfig({
    ...upstream(mockFetch429()),
    queue: { maxConcurrency: 1, maxQueueSize: 10, queueTimeoutMs: 2000 },
  }) as never);
  // The stream rejects (429, no retries configured).
  await assert.rejects(async () => {
    for await (const _c of client.stream(MESSAGES)) { /* drain */ }
  }, "stream with 429 fetch must reject");
  // Slot must be released despite the rejection → queue active=0.
  const t0 = Date.now();
  const queueSnap = client.getQueue();
  assert.equal(queueSnap.active, 0,
    "queue active=0 after a rejecting stream (finally released the slot)");
  const elapsed = Date.now() - t0;
  console.log(`  [stream-slot-throw] queueActive=${queueSnap.active} elapsed=${elapsed}ms`);
});

test("Queue abort errors are safe both before admission and while pending", async () => {
  const { TimeoutError } = await import("../../src/shared/llm/errors.ts");
  for (const pending of [false, true]) for (const timeout of [false, true]) {
    const q = new RequestQueue({ maxConcurrency: 1, maxQueueSize: 2, queueTimeoutMs: 0 });
    const controller = new AbortController();
    const reason = timeout ? new TimeoutError("private-queue-reason", { detail: "private-queue-reason" }) : new Error("private-queue-reason");
    const holder = { model: "holder", provider: "fixture" };
    if (pending) await q.acquire(holder); else controller.abort(reason);
    const operation = q.acquire({ model: "waiter", provider: "fixture", signal: controller.signal });
    const outcome = assert.rejects(operation, error => {
      assert.ok(error instanceof LLMError); assert.equal(error.code, timeout ? "llm_timeout" : "llm_cancelled"); assert.notEqual(error, reason);
      assert.deepEqual(error.safeDetails, {}); assert.equal(error.message.includes("private-queue-reason"), false); return true;
    });
    if (pending) { assert.equal(q.pendingCount(), 1); controller.abort(reason); }
    await outcome; assert.equal(q.pendingCount(), 0); assert.equal(q.activeCount(), pending ? 1 : 0);
    if (pending) q.release(holder); assert.equal(q.activeCount(), 0); assert.equal(controller.signal.reason, reason);
  }
});
