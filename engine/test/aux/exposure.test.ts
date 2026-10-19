/**
 * EXP430 — shared exposure system tests (UNIFIED API, EXP470).
 *
 * Verifies the three exposure primitives (Signal, Action, Customization)
 * register + read + reset correctly, and that the unified aux aggregator
 * exposes them via one canonical API.
 *
 * MIGRATED from the A.2 verbs (invokeAction/readCustomization/writeCustomization/
 * resetCustomization) to the unified verbs (executeAction/getCustomizationValue/
 * setCustomizationValue/resetCustomizationValue). Actions now use `execute`
 * (sync or async) and `executeAction` is awaited.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  registerSignal,
  getSignal,
  readSignal,
  listSignals,
  listSignalsByModule,
  unregisterSignal,
  clearSignals,
} from "../../src/shared/exposure/signal.ts";
import {
  registerAction,
  getAction,
  executeAction,
  listActions,
  listActionsByModule,
  unregisterAction,
  clearActions,
} from "../../src/shared/exposure/action.ts";
import {
  registerCustomization,
  getCustomization as _getCust,
  getCustomizationValue,
  setCustomizationValue,
  resetCustomizationValue,
  listCustomizations,
  listCustomizationsByModule,
  makeNumberCustomization,
  makeBooleanCustomization,
  unregisterCustomization,
  clearCustomizations,
} from "../../src/shared/exposure/customization.ts";
import {
  snapshotExposure,
  resetExposure,
  totalExposedItems,
  listExposedModules,
} from "../../src/aux/index.ts";

function freshState() {
  clearSignals();
  clearActions();
  clearCustomizations();
}

test("exp430-exposure: signal registers + reads + unregisters", () => {
  freshState();
  let v = 42;
  registerSignal({
    id: "test.signal.counter",
    module: "test",
    name: "Counter",
    description: "A test counter signal.",
    type: "counter",
    value: () => v,
  });
  assert.equal(readSignal("test.signal.counter"), 42);
  v = 43;
  assert.equal(readSignal("test.signal.counter"), 43, "dynamic value recomputed");
  assert.equal(getSignal("test.signal.counter")?.module, "test");
  assert.equal(listSignals().length, 1);
  assert.equal(listSignalsByModule("test").length, 1);
  assert.equal(listSignalsByModule("other").length, 0);
  assert.equal(unregisterSignal("test.signal.counter"), true);
  assert.equal(listSignals().length, 0);
  freshState();
});

test("exp430-exposure: signal rejects invalid id + duplicate", () => {
  freshState();
  assert.throws(() => registerSignal({
    id: "invalid_id", module: "test", name: "X", description: "Y", type: "counter", value: () => 0,
  }));
  registerSignal({
    id: "test.signal.dup", module: "test", name: "X", description: "Y", type: "counter", value: () => 0,
  });
  assert.throws(() => registerSignal({
    id: "test.signal.dup", module: "test", name: "X", description: "Y", type: "counter", value: () => 0,
  }));
  freshState();
});

test("exp430-exposure: action registers + executes + unregisters", async () => {
  freshState();
  let called = 0;
  registerAction({
    id: "test.action.ping",
    module: "test",
    name: "Ping",
    description: "A test ping action.",
    execute: () => { called++; return "pong"; },
  });
  assert.equal(await executeAction("test.action.ping"), "pong");
  assert.equal(called, 1);
  assert.equal(getAction("test.action.ping")?.name, "Ping");
  assert.equal(listActions().length, 1);
  assert.equal(listActionsByModule("test").length, 1);
  assert.equal(unregisterAction("test.action.ping"), true);
  assert.equal(listActions().length, 0);
  freshState();
});

test("exp430-exposure: async action executes via executeAction", async () => {
  freshState();
  registerAction({
    id: "test.action.async",
    module: "test",
    name: "Async",
    description: "An async action.",
    execute: async () => "async-result",
  });
  assert.equal(await executeAction("test.action.async"), "async-result");
  freshState();
});

test("exp430-exposure: customization reads + writes + resets", () => {
  freshState();
  const c = makeNumberCustomization(
    "test.cust.threshold", "test", "Threshold", "A test threshold.", 5, 0, 10,
  );
  registerCustomization(c);
  assert.equal(getCustomizationValue("test.cust.threshold"), 5);
  setCustomizationValue("test.cust.threshold", 7);
  assert.equal(getCustomizationValue("test.cust.threshold"), 7);
  assert.throws(() => setCustomizationValue("test.cust.threshold", -1), /below its minimum/);
  assert.throws(() => setCustomizationValue("test.cust.threshold", 11), /above its maximum/);
  resetCustomizationValue("test.cust.threshold");
  assert.equal(getCustomizationValue("test.cust.threshold"), 5);
  assert.equal(listCustomizations().length, 1);
  assert.equal(listCustomizationsByModule("test").length, 1);
  assert.equal(unregisterCustomization("test.cust.threshold"), true);
  assert.equal(listCustomizations().length, 0);
  freshState();
});

test("exp430-exposure: boolean customization type-checks its value", () => {
  freshState();
  registerCustomization(
    makeBooleanCustomization("test.cust.flag", "test", "Flag", "A boolean flag.", true),
  );
  assert.equal(getCustomizationValue("test.cust.flag"), true);
  setCustomizationValue("test.cust.flag", false);
  assert.equal(getCustomizationValue("test.cust.flag"), false);
  assert.throws(() => setCustomizationValue("test.cust.flag", 1 as unknown as boolean), /holds a switch/);
  freshState();
});

test("exp430-exposure: resetCustomizationValue falls back to set(default) when no reset callback", () => {
  freshState();
  // A module-delegating customization (current/set delegate to module state, no reset).
  let val = 10;
  registerCustomization({
    id: "test.cust.noreset", module: "test", name: "NoReset", description: "No reset callback.",
    type: "number", default: 10, min: 0, max: 100,
    current: () => val,
    set: (v) => { val = Number(v); },
  });
  setCustomizationValue("test.cust.noreset", 42);
  assert.equal(getCustomizationValue("test.cust.noreset"), 42);
  resetCustomizationValue("test.cust.noreset");
  assert.equal(getCustomizationValue("test.cust.noreset"), 10, "reset falls back to set(default)");
  freshState();
});

test("exp430-exposure: snapshot + total + modules aggregation", async () => {
  freshState();
  registerSignal({
    id: "snap.test.signal", module: "snaptest", name: "S", description: "d", type: "counter", value: () => 1,
  });
  registerAction({
    id: "snap.test.action", module: "snaptest", name: "A", description: "d", execute: () => 2,
  });
  registerCustomization(
    makeNumberCustomization("snap.test.cust", "snaptest", "C", "d", 3),
  );
  const snap = snapshotExposure();
  assert.equal(snap.signals.length, 1);
  assert.equal(snap.actions.length, 1);
  assert.equal(snap.customizations.length, 1);
  assert.equal(totalExposedItems(), 3);
  assert.deepEqual(listExposedModules(), ["snaptest"]);
  resetExposure();
  assert.equal(totalExposedItems(), 0);
  assert.deepEqual(listExposedModules(), []);
  freshState();
});
