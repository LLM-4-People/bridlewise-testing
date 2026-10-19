import assert from "node:assert/strict";
import test from "node:test";

import {
  engineSpans,
  engineArgsShape,
  isEngineSpan,
  withoutEngineSpans,
} from "../../src/performance/engine-instrumentation.ts";
import { setEffectSink, type EffectRecord } from "../../src/timeline/recorded-effect.ts";
import * as recordedEffectNs from "../../src/timeline/recorded-effect.ts";
import { withRecordingContext } from "../../src/timeline/recording-context.ts";

/**
 * The engine-span decoration owner — the module that makes hub re-exports
 * self-instrumenting.
 *
 * The deny-by-default contract under test: EVERY function-valued export of a
 * namespace handed to `engineSpans` comes back wrapped with an engine span,
 * unless the reviewed exclusion table names it. A new hub re-export is
 * therefore covered the day it lands; the only escape is the reviewed table,
 * and the hub-side guard (tests/prevention/recording-choke-points.test.ts
 * class G) refuses the bare-re-export bypass shape entirely.
 *
 * The span records ONLY inside an ambient recording context (boot, CLI and
 * background ticks pass through at one AsyncLocalStorage read), never
 * captures argument VALUES (shapes only — names/counts/byte-lengths), and
 * the re-entrancy suppression keeps the recording machinery from observing
 * itself.
 */

type Captured = { records: EffectRecord[]; restore: () => void };

function capture(): Captured {
  const records: EffectRecord[] = [];
  setEffectSink((record) => { records.push(record); });
  return {
    records,
    restore: () => setEffectSink(undefined),
  };
}

/** A probe namespace: functions, a constant, an excluded name, a class-like. */
function probeNamespace(): {
  plain(value: number): number;
  asyncWork(ms: number): Promise<string>;
  CONST_VALUE: string;
  classLike: new () => { hello(): string };
} {
  const ns = {
    plain: (value: number): number => value * 2,
    asyncWork: async (ms: number): Promise<string> => {
      await new Promise((r) => setTimeout(r, ms));
      return "done";
    },
    CONST_VALUE: "a constant, not a call",
    classLike: class {
      hello(): string {
        return "from the prototype";
      }
    },
  };
  return ns as typeof ns & { classLike: new () => { hello(): string } };
}

test("engineSpans: every plain function export is wrapped; constants and class-likes pass through raw", () => {
  const decorated = engineSpans(probeNamespace(), "test-probe");
  assert.equal(isEngineSpan(decorated.plain), true, "a plain function export must be wrapped");
  assert.equal(isEngineSpan(decorated.asyncWork), true, "an async function export must be wrapped");
  assert.equal(decorated.CONST_VALUE, "a constant, not a call", "constants pass through unchanged");
  assert.equal(isEngineSpan(decorated.classLike), false, "a class-like export passes through raw — a wrapper cannot preserve the prototype chain");
  // The raw prototype survives for class-likes: the documented reason they
  // are undecorated rather than silently broken.
  assert.equal(typeof decorated.classLike === "function" && new (decorated.classLike as new () => { hello(): string })().hello(), "from the prototype");
});

test("engineSpans: the wrapper answers to the original function's name", () => {
  const decorated = engineSpans(probeNamespace(), "test-probe");
  assert.equal(decorated.plain.name, "plain");
});

test("engineSpans: an excluded name keeps its RAW identity — exclusion means the original function, not a wrapper", () => {
  // Driven against the REAL table and a REAL module namespace: the recording
  // machinery (recordEffect) is excluded by review, while its sibling
  // (hasEffectSink) is not — one namespace, both dispositions, no planted
  // fixture (the table is frozen; planting into it is impossible by design,
  // which is itself the exclusion discipline the guards verify).
  const decorated = engineSpans(recordedEffectNs, "src-timeline-recorded-effect");
  assert.equal(isEngineSpan(decorated.recordEffect), false, "the excluded recording primitive is not wrapped");
  assert.equal(decorated.recordEffect, recordedEffectNs.recordEffect, "the excluded binding IS the original function — identity preserved for hot paths");
  assert.equal(isEngineSpan(decorated.hasEffectSink), true, "a sibling the table does not name is still wrapped — deny by default");
});

test("engine span: outside any recording context the call passes through with NO record", () => {
  const c = capture();
  try {
    const decorated = engineSpans(probeNamespace(), "test-probe");
    assert.equal(decorated.plain(21), 42, "the work runs and its result is returned");
    assert.equal(c.records.length, 0, "boot/CLI/no-context calls record nothing — the ambient check is the volume gate");
  } finally {
    c.restore();
  }
});

test("engine span: inside a recording context the call records kind engine with the ambient actor", () => {
  const c = capture();
  try {
    const decorated = engineSpans(probeNamespace(), "test-probe");
    const seen = withRecordingContext({ actor: { kind: "user", id: "engine-owner-test" } }, () => decorated.plain(5));
    assert.equal(seen, 10);
    assert.equal(c.records.length, 1);
    const record = c.records[0]!;
    assert.equal(record.kind, "engine");
    assert.equal(record.name, "plain");
    assert.equal(record.outcome, "succeeded");
    assert.equal(record.actor.kind, "user");
    assert.equal(record.actor.id, "engine-owner-test");
    assert.ok(typeof record.durationMs === "number" && record.durationMs >= 0);
    assert.ok(typeof record.cpuMs === "number", "the resource probe rides the record");
    assert.match(record.spanId, /^engine:plain:/);
  } finally {
    c.restore();
  }
});

test("engine span: an async decorated function settles its record at settlement", async () => {
  const c = capture();
  try {
    const decorated = engineSpans(probeNamespace(), "test-probe");
    await withRecordingContext({ actor: { kind: "user", id: "engine-owner-async" } }, () => decorated.asyncWork(5));
    assert.equal(c.records.length, 1);
    assert.equal(c.records[0]!.outcome, "succeeded");
    assert.ok(c.records[0]!.durationMs >= 4, "the duration covers the awaited window");
  } finally {
    c.restore();
  }
});

test("engine span: a throwing decorated function records failed with the real error and still propagates", () => {
  const c = capture();
  try {
    const throwing = (): never => { throw new Error("probe explosion"); };
    const decorated = engineSpans({ throwing }, "test-probe");
    assert.throws(
      () => withRecordingContext({ actor: { kind: "user", id: "engine-owner-error" } }, () => decorated.throwing()),
      (err: unknown) => err instanceof Error && err.message === "probe explosion",
    );
    assert.equal(c.records.length, 1);
    assert.equal(c.records[0]!.outcome, "failed");
    assert.equal(c.records[0]!.error?.message, "probe explosion");
  } finally {
    c.restore();
  }
});

test("engine span: the args document carries SHAPES ONLY — argument values never reach a record", () => {
  const c = capture();
  try {
    const CANARY = "sk-canary-secret-value-0123456789";
    const taking = (_config: unknown): string => "called";
    const decorated = engineSpans({ taking }, "test-probe");
    withRecordingContext({ actor: { kind: "user", id: "engine-owner-shapes" } }, () =>
      decorated.taking({ password: CANARY, nested: [CANARY], token: CANARY, plain: 3 }),
    );
    assert.equal(c.records.length, 1);
    const serialized = JSON.stringify(c.records[0]!.args);
    assert.equal(serialized.includes(CANARY), false, "no argument VALUE may appear in the args document");
    const shape = c.records[0]!.args as {
      count: number;
      args: { type: string; count?: number; keys?: string[] }[];
    };
    assert.equal(shape.count, 1);
    assert.equal(shape.args[0]!.type, "object");
    // Key NAMES are schema, not data — they are the point of the shape.
    assert.deepEqual(shape.args[0]!.keys, ["password", "nested", "token", "plain"]);
  } finally {
    c.restore();
  }
});

test("engine span: inside withoutEngineSpans no span opens — the recording machinery does not observe itself", () => {
  const c = capture();
  try {
    const decorated = engineSpans(probeNamespace(), "test-probe");
    withRecordingContext({ actor: { kind: "user", id: "engine-owner-suppress" } }, () =>
      withoutEngineSpans(() => decorated.plain(1)),
    );
    assert.equal(c.records.length, 0, "suppression holds even with a context active and a sink installed");
    // Suppression is scoped: the next call outside the window records.
    withRecordingContext({ actor: { kind: "user", id: "engine-owner-suppress" } }, () => decorated.plain(1));
    assert.equal(c.records.length, 1);
  } finally {
    c.restore();
  }
});

test("engineArgsShape: strings carry bytes, arrays length, objects count + bounded key names, functions their name", () => {
  function namedArgument(): string {
    return "ignored";
  }
  const shape = engineArgsShape([
    "hello",
    [1, 2, 3],
    { alpha: 1, beta: 2, gamma: 3 },
    namedArgument,
    new Map([["k", "v"]]),
    new Set([1]),
    null,
    42,
  ]) as { count: number; args: ReadonlyArray<Record<string, unknown>> };
  assert.equal(shape.count, 8);
  assert.deepEqual(shape.args[0], { type: "string", bytes: 5 });
  assert.deepEqual(shape.args[1], { type: "array", length: 3 });
  assert.deepEqual(shape.args[2], { type: "object", count: 3, keys: ["alpha", "beta", "gamma"] });
  assert.equal((shape.args[3] as { name: string }).name, "namedArgument", "a function argument reports its name, never its closure");
  assert.deepEqual(shape.args[4], { type: "map", size: 1 });
  assert.deepEqual(shape.args[5], { type: "set", size: 1 });
  assert.deepEqual(shape.args[6], { type: "null" });
  assert.deepEqual(shape.args[7], { type: "number" });
});

test("engineArgsShape: object key listing is BOUNDED — a wide object reports a count, not a thousand names", () => {
  const wide: Record<string, number> = {};
  for (let i = 0; i < 50; i += 1) wide[`key-${i}`] = i;
  const shape = engineArgsShape([wide]) as { args: [{ count: number; keys: string[] }] };
  assert.equal(shape.args[0]!.count, 50, "the count tells the truth about the width");
  assert.ok(shape.args[0]!.keys.length <= 16, "the key list is capped");
});


test("paired sink factory construction is excluded from instrumentation", async () => {
  const ns = await import("../../src/timeline/effect-sink.ts");
  const captureState = capture();
  try {
    await withRecordingContext({ actor: { kind: "test", id: "factory" } }, async () => {
      const decorated = engineSpans(ns, "src-timeline-effect-sink");
      assert.equal(decorated.createTimelineEffectSink, ns.createTimelineEffectSink);
      const sink = decorated.createTimelineEffectSink(() => undefined);
      assert.equal(typeof sink.begin, "function");
    });
    assert.equal(captureState.records.length, 0);
  } finally { captureState.restore(); }
});
