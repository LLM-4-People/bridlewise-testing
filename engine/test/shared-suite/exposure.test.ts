import assert from "node:assert/strict";
import test from "node:test";

import {
  defineCounter, defineGauge, defineState,
  defineAction,
  defineNumber, defineString, defineBoolean, defineEnum, defineObject,
  registerSignal, registerAction, registerCustomization,
  getSignal, getAction, getCustomization,
  readSignal, executeAction,
  getCustomizationValue, setCustomizationValue, resetCustomizationValue,
  listSignalsByModule, listActionsByModule, listCustomizationsByModule,
  countSignals, countActions, countCustomizations, countAll,
  makeNumberCustomization,
  snapshot, clearAll,
  SIGNAL_TYPES, CUSTOMIZATION_TYPES,
  type CustomizationValue,
} from "../../src/shared/exposure/index.ts";

/**
 * EXP470 — unified exposure system tests.
 *
 * Verifies the ONE unified API (superset of the three previously-fragmented
 * families) supports every operation: register + define ergonomics + read +
 * execute + set + reset + snapshot. The B-family positional helpers
 * (defineCounter/defineGauge/defineState/defineAction/defineNumber/...) are
 * thin wrappers over the canonical registerX functions and share ONE
 * registry.
 */

function freshState() {
  clearAll();
}

// ── Signal: register + define + read + get ──────────────────────────────

test("unified: registerSignal + readSignal round-trips a dynamic value", () => {
  freshState();
  let v = 42;
  registerSignal({
    id: "demo.counter", module: "demo", name: "Counter", description: "A counter.",
    type: "counter", unit: "count", value: () => v,
  });
  assert.equal(readSignal("demo.counter"), 42);
  v = 99;
  assert.equal(readSignal("demo.counter"), 99, "value is dynamic");
  assert.equal(getSignal("demo.counter")?.type, "counter");
  assert.equal(getSignal("demo.counter")?.unit, "count");
  assert.equal(getSignal("missing.signal"), undefined);
  freshState();
});

test("unified: defineCounter + defineGauge + defineState ergonomics register via the same registry", () => {
  freshState();
  defineCounter("demo", "hits", "Hits", "Total hits.", () => 5, ["route"]);
  defineGauge("demo", "temp", "Temp", "Temperature.", () => 21.5, "ms");
  defineState("demo", "phase", "Phase", "Current phase.", () => "idle");
  assert.equal(listSignalsByModule("demo").length, 3);
  assert.equal(getSignal("demo.hits")?.type, "counter");
  assert.deepEqual(getSignal("demo.hits")?.labels, ["route"]);
  assert.equal(getSignal("demo.temp")?.type, "gauge");
  assert.equal(getSignal("demo.temp")?.unit, "ms");
  assert.equal(getSignal("demo.phase")?.type, "state");
  freshState();
});

test("unified: SIGNAL_TYPES is a frozen superset (counter/gauge/histogram/timer/boolean/string/event/state)", () => {
  assert.ok(Object.isFrozen(SIGNAL_TYPES));
  for (const t of ["counter", "gauge", "histogram", "timer", "boolean", "string", "event", "state"] as const) {
    assert.ok(SIGNAL_TYPES.includes(t), `SIGNAL_TYPES must include ${t}`);
  }
  freshState();
});

test("unified: duplicate signal id throws; invalid id throws; missing fields throw", () => {
  freshState();
  registerSignal({ id: "demo.dup", module: "demo", name: "N", description: "D", type: "counter", value: () => 0 });
  assert.throws(() => registerSignal({ id: "demo.dup", module: "demo", name: "N", description: "D", type: "counter", value: () => 0 }));
  assert.throws(() => registerSignal({ id: "bad_id", module: "demo", name: "N", description: "D", type: "counter", value: () => 0 }));
  assert.throws(() => registerSignal({ id: "", module: "demo", name: "N", description: "D", type: "counter", value: () => 0 }));
  freshState();
});

// ── Action: register + define + execute (sync + async) ───────────────────

test("unified: registerAction + executeAction (sync execute)", async () => {
  freshState();
  let called = 0;
  registerAction({
    id: "demo.ping", module: "demo", name: "Ping", description: "Ping.",
    execute: () => { called++; return "pong"; },
  });
  assert.equal(await executeAction("demo.ping"), "pong");
  assert.equal(called, 1);
  assert.equal(getAction("demo.ping")?.name, "Ping");
  freshState();
});

test("unified: registerAction + executeAction (async execute)", async () => {
  freshState();
  registerAction({
    id: "demo.async", module: "demo", name: "Async", description: "Async.",
    execute: async () => "async-result",
  });
  assert.equal(await executeAction("demo.async"), "async-result");
  freshState();
});

test("unified: defineAction ergonomics register via the same registry", async () => {
  freshState();
  defineAction("demo", "retry", "Retry", "Retry the request.", () => ({ retried: true }));
  defineAction("demo", "purge", "Purge", "Purge the cache.", async () => ({ purged: true }),
    { force: { type: "boolean", required: false, description: "Force purge." } });
  assert.equal(listActionsByModule("demo").length, 2);
  assert.equal(getAction("demo.retry")?.name, "Retry");
  assert.deepEqual(await executeAction("demo.retry"), { retried: true });
  assert.deepEqual(await executeAction("demo.purge", { force: true }), { purged: true });
  freshState();
});

test("unified: executeAction throws for unknown id; validates required args", async () => {
  freshState();
  await assert.rejects(() => executeAction("demo.unknown"), /not registered/);
  registerAction({
    id: "demo.needsArg", module: "demo", name: "NeedsArg", description: "Needs an arg.",
    args: { x: { type: "string", required: true, description: "Required." } },
    execute: (a) => String(a?.x ?? ""),
  });
  await assert.rejects(() => executeAction("demo.needsArg"), /is required/);
  freshState();
});

// ── Customization: register + define + make + get/set/reset ──────────────

test("unified: defineNumber/String/Boolean/Enum/Object ergonomics register via the same registry", () => {
  freshState();
  defineNumber("demo", "timeout", "Timeout", "Per-request timeout.", 5000, { min: 1, max: 60000 }, "ms");
  defineString("demo", "name", "Name", "A name.", "default");
  defineBoolean("demo", "enabled", "Enabled", "On/off.", false);
  defineEnum("demo", "mode", "Mode", "Strategy.", "round-robin", ["round-robin", "priority"]);
  defineObject("demo", "extra", "Extra", "Extra config.", { a: 1 });
  assert.equal(listCustomizationsByModule("demo").length, 5);
  assert.equal(getCustomization("demo.timeout")?.default, 5000);
  assert.deepEqual(getCustomization("demo.mode")?.enum, ["round-robin", "priority"]);
  assert.equal(getCustomization("demo.enabled")?.type, "boolean");
  assert.equal(getCustomization("demo.extra")?.type, "object");
  freshState();
});

test("unified: getCustomizationValue + setCustomizationValue + resetCustomizationValue on defineNumber", () => {
  freshState();
  defineNumber("demo", "threshold", "Threshold", "A threshold.", 0.5, { min: 0, max: 1 });
  assert.equal(getCustomizationValue("demo.threshold"), 0.5);
  setCustomizationValue("demo.threshold", 0.8);
  assert.equal(getCustomizationValue("demo.threshold"), 0.8);
  assert.throws(() => setCustomizationValue("demo.threshold", -1), /below its minimum/);
  assert.throws(() => setCustomizationValue("demo.threshold", 2), /above its maximum/);
  resetCustomizationValue("demo.threshold");
  assert.equal(getCustomizationValue("demo.threshold"), 0.5, "reset restores default");
  freshState();
});

test("unified: makeNumberCustomization + registerCustomization (self-contained state + reset)", () => {
  freshState();
  registerCustomization(makeNumberCustomization("demo.self", "demo", "Self", "Self-contained.", 5, 0, 10));
  assert.equal(getCustomizationValue("demo.self"), 5);
  setCustomizationValue("demo.self", 7);
  assert.equal(getCustomizationValue("demo.self"), 7);
  resetCustomizationValue("demo.self");
  assert.equal(getCustomizationValue("demo.self"), 5);
  freshState();
});

test("unified: resetCustomizationValue falls back to set(default) when no explicit reset callback", () => {
  freshState();
  let val = 10;
  registerCustomization({
    id: "demo.noreset", module: "demo", name: "NoReset", description: "No reset callback.",
    type: "number", default: 10, min: 0, max: 100,
    current: () => val, set: (v) => { val = Number(v); },
  });
  setCustomizationValue("demo.noreset", 42);
  resetCustomizationValue("demo.noreset");
  assert.equal(getCustomizationValue("demo.noreset"), 10);
  freshState();
});

test("unified: CUSTOMIZATION_TYPES is a frozen superset (number/string/boolean/enum/object)", () => {
  assert.ok(Object.isFrozen(CUSTOMIZATION_TYPES));
  for (const t of ["number", "string", "boolean", "enum", "object"] as const) {
    assert.ok(CUSTOMIZATION_TYPES.includes(t), `CUSTOMIZATION_TYPES must include ${t}`);
  }
  freshState();
});

test("unified: object customization get/set/reset", () => {
  freshState();
  defineObject("demo", "opts", "Opts", "Options.", { x: 1 });
  assert.deepEqual(getCustomizationValue("demo.opts"), { x: 1 });
  setCustomizationValue("demo.opts", { x: 2, y: 3 });
  assert.deepEqual(getCustomizationValue("demo.opts"), { x: 2, y: 3 });
  resetCustomizationValue("demo.opts");
  assert.deepEqual(getCustomizationValue("demo.opts"), { x: 1 });
  freshState();
});

// ── Registry: snapshot + counts + module filtering ──────────────────────

test("unified: snapshot + counts + module filtering", () => {
  freshState();
  defineCounter("a", "x", "X", "x", () => 1);
  defineAction("a", "y", "Y", "y", () => 2);
  defineNumber("b", "z", "Z", "z", 3);
  const snap = snapshot();
  assert.equal(snap.counts.signals, 1);
  assert.equal(snap.counts.actions, 1);
  assert.equal(snap.counts.customizations, 1);
  assert.equal(snap.counts.total, 3);
  assert.equal(countAll(), 3);
  assert.equal(countSignals(), 1);
  assert.equal(countActions(), 1);
  assert.equal(countCustomizations(), 1);
  assert.equal(listSignalsByModule("a").length, 1);
  assert.equal(listCustomizationsByModule("a").length, 0, "module b customization filtered out");
  freshState();
});

test("unified: empty module/id rejected for all three primitives", () => {
  freshState();
  assert.throws(() => registerSignal({ id: "", module: "m", name: "n", description: "d", type: "counter", value: () => 0 }));
  assert.throws(() => registerSignal({ id: "x.y", module: "", name: "n", description: "d", type: "counter", value: () => 0 }));
  assert.throws(() => registerAction({ id: "", module: "m", name: "n", description: "d", execute: () => 0 }));
  assert.throws(() => registerCustomization({ id: "", module: "m", name: "n", description: "d", type: "number", default: 0, current: () => 0, set: () => {} }));
  freshState();
});

// ── Hostile / improper-usage tests (things that should NOT work) ─────────

test("hostile: readSignal / getCustomizationValue / executeAction / setCustomizationValue / resetCustomizationValue throw for unknown ids", async () => {
  freshState();
  assert.throws(() => readSignal("nope.unknown"), /not registered/);
  assert.throws(() => getCustomizationValue("nope.unknown"), /not registered/);
  assert.throws(() => setCustomizationValue("nope.unknown", 1), /not registered/);
  assert.throws(() => resetCustomizationValue("nope.unknown"), /not registered/);
  await assert.rejects(() => executeAction("nope.unknown"), /not registered/);
  freshState();
});

test("hostile: invalid signal/action/customization type rejected", () => {
  freshState();
  assert.throws(() => registerSignal({ id: "h.bad", module: "h", name: "n", description: "d", type: "bogus" as never, value: () => 0 }));
  assert.throws(() => registerCustomization({ id: "h.bad", module: "h", name: "n", description: "d", type: "bogus" as never, default: 0, current: () => 0, set: () => {} }));
  freshState();
});

test("hostile: defineNumber default outside range is rejected at registration", () => {
  freshState();
  // default 5 with max 1 → the central validator rejects the default.
  assert.throws(() => defineNumber("h", "bad", "Bad", "bad default", 5, { max: 1 }));
  freshState();
});

test("hostile: action arg type validation rejects wrong types", async () => {
  freshState();
  registerAction({
    id: "h.needNum", module: "h", name: "NeedNum", description: "Needs a number.",
    args: { n: { type: "number", required: true, description: "a number" } },
    execute: (a) => Number(a?.n ?? 0),
  });
  await assert.rejects(() => executeAction("h.needNum", { n: "not-a-number" }), /finite number/);
  await assert.rejects(() => executeAction("h.needNum", { n: NaN }), /finite number/);
  assert.equal(await executeAction("h.needNum", { n: 7 }), 7);
  freshState();
});

test("hostile: object customization rejects non-object values", () => {
  freshState();
  defineObject("h", "obj", "Obj", "An object.", { a: 1 });
  assert.throws(() => setCustomizationValue("h.obj", 42), /holds a JSON object/);
  assert.throws(() => setCustomizationValue("h.obj", "str"), /holds a JSON object/);
  assert.throws(() => setCustomizationValue("h.obj", [1, 2] as unknown as CustomizationValue), /holds a JSON object/);
  freshState();
});

test("hostile: enum customization rejects values outside the enum", () => {
  freshState();
  defineEnum("h", "mode", "Mode", "A mode.", "a", ["a", "b", "c"]);
  assert.throws(() => setCustomizationValue("h.mode", "z"), /is not one of its choices/);
  assert.throws(() => setCustomizationValue("h.mode", 1), /declared choices/);
  assert.equal(getCustomizationValue("h.mode"), "a");
  setCustomizationValue("h.mode", "b");
  assert.equal(getCustomizationValue("h.mode"), "b");
  freshState();
});

test("hostile: re-registering an existing id throws (no silent shadowing)", () => {
  freshState();
  registerSignal({ id: "h.dup", module: "h", name: "n", description: "d", type: "counter", value: () => 0 });
  assert.throws(() => registerSignal({ id: "h.dup", module: "h", name: "other", description: "d", type: "counter", value: () => 1 }));
  assert.equal(getSignal("h.dup")?.name, "n", "original registration preserved");
  freshState();
});
