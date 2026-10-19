import assert from "node:assert/strict";
import test from "node:test";
import { bestEffort, bestEffortAsync } from "../../src/shared/best-effort.ts";
import { configureDebugSystem, createCollectingSink, getDebugSignals, resetDebugSystem } from "../../src/shared/debug/debug-system.ts";
import { DEBUG_CONFIG_DEFAULTS } from "../../src/shared/debug/debug-config.ts";

test("best-effort success retains values, undefined, and primary outcome without diagnostics", async () => {
  resetDebugSystem();
  const value = {};
  assert.equal(bestEffort(() => value), value);
  assert.equal(bestEffort(() => undefined), undefined);
  assert.equal(await bestEffortAsync(async () => value), value);
  assert.equal(getDebugSignals().bestEffortFailures, 0);
  assert.equal(getDebugSignals().fallbackAttempts, 0);
});

test("best-effort failure never inspects a thrown value, callback name, or stack formatter", async (t) => {
  t.after(resetDebugSystem);
  const warn = console.warn, prepare = Error.prepareStackTrace;
  const diagnostics: unknown[][] = [];
  const results: unknown[] = [];
  let inspections = 0;
  const hostile = new Proxy({}, { get() { inspections++; throw new Error("fixture-secret"); } });
  const named = { "fixture-secret"() { throw hostile; } }["fixture-secret"];
  console.warn = (...args: unknown[]) => { diagnostics.push(args); };
  Error.prepareStackTrace = () => { inspections++; throw new Error("fixture-secret"); };
  resetDebugSystem();
  try {
    for (const error of ["fixture-secret", new Error("fixture-secret"), hostile]) {
      results.push(bestEffort(() => { throw error; }));
      results.push(await bestEffortAsync(async () => { throw error; }));
    }
    results.push(bestEffort(named));
    results.push(bestEffort(() => 42));
  } finally { console.warn = warn; Error.prepareStackTrace = prepare; }
  assert.deepEqual(results, [undefined, undefined, undefined, undefined, undefined, undefined, undefined, 42]);
  assert.equal(inspections, 0);
  assert.equal(diagnostics.length, 7);
  assert.ok(diagnostics.every((args) => args.length === 1 && args[0] === "[debug] diagnostic unavailable"));
  assert.equal(getDebugSignals().bestEffortFailures, 7);
  assert.equal(getDebugSignals().fallbackAttempts, 7);
});

test("best-effort configured diagnostics share error policy and contain no caller data", async () => {
  const sink = createCollectingSink();
  configureDebugSystem({ ...DEBUG_CONFIG_DEFAULTS, sinks: { enabledSinks: ["collecting"] }, errorHandling: { ...DEBUG_CONFIG_DEFAULTS.errorHandling, reportingPolicy: "deduplicated" } }, [sink]);
  try {
    assert.equal(bestEffort(() => { throw "fixture-secret"; }), undefined);
    assert.equal(await bestEffortAsync(async () => { throw new Error("fixture-secret"); }), undefined);
    assert.equal(sink.events.length, 1);
    assert.deepEqual({ ...sink.events[0], timestamp: 0 }, {
      kind: "error", level: "error", category: "best-effort", message: "An optional operation failed",
      context: { retryable: false }, timestamp: 0, code: "best_effort_failed", source: null,
    });
    assert.equal(getDebugSignals().bestEffortFailures, 2);
    assert.equal(getDebugSignals().errorCount, 2);
    assert.equal(getDebugSignals().suppressedByLevel, 1);
    assert.equal(getDebugSignals().fallbackAttempts, 0);
  } finally { resetDebugSystem(); }
});

test("best-effort diagnostic assembly and terminal destination failures preserve the primary outcome", async () => {
  const sink = createCollectingSink();
  configureDebugSystem({ ...DEBUG_CONFIG_DEFAULTS, sinks: { enabledSinks: ["collecting"] } }, [sink]);
  const now = Date.now, warn = console.warn;
  let attempts = 0;
  Date.now = () => { throw "fixture-secret"; };
  console.warn = () => { attempts++; throw "fixture-secret"; };
  try {
    assert.doesNotThrow(() => { assert.equal(bestEffort(() => { throw "primary"; }), undefined); });
    assert.equal(await bestEffortAsync(async () => { throw "primary"; }), undefined);
    assert.equal(attempts, 2);
    assert.equal(getDebugSignals().reportingFailures, 2);
    assert.equal(getDebugSignals().fallbackFailures, 2);
    assert.equal(sink.events.length, 0);
  } finally { Date.now = now; console.warn = warn; resetDebugSystem(); }
});

test("best-effort configured empty sinks and sampling are intentional policies, not fallback failures", () => {
  configureDebugSystem({ ...DEBUG_CONFIG_DEFAULTS, sinks: { enabledSinks: [] } }, []);
  bestEffort(() => { throw "fixture-secret"; });
  assert.equal(getDebugSignals().errorCount, 1);
  assert.equal(getDebugSignals().sinkWriteAttempts, 0);
  assert.equal(getDebugSignals().fallbackAttempts, 0);
  const sink = createCollectingSink();
  const random = Math.random;
  configureDebugSystem({ ...DEBUG_CONFIG_DEFAULTS, sinks: { enabledSinks: ["collecting"] }, errorHandling: { ...DEBUG_CONFIG_DEFAULTS.errorHandling, reportingPolicy: "sampled", samplingRate: 0 } }, [sink]);
  Math.random = () => 0.5;
  try {
    bestEffort(() => { throw "fixture-secret"; });
    assert.equal(getDebugSignals().errorCount, 1);
    assert.equal(sink.events.length, 0);
    assert.equal(getDebugSignals().fallbackAttempts, 0);
  } finally { Math.random = random; resetDebugSystem(); }
});
