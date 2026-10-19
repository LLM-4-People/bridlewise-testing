import assert from "node:assert/strict";
import test from "node:test";

import {
  clearActions,
  executeAction,
  registerAction,
} from "../../src/shared/exposure/action.ts";
import { setEffectSink, type EffectRecord } from "../../src/timeline/recorded-effect.ts";

/**
 * ── A DESTRUCTIVE VERB CANNOT RUN UNRECORDED ───────────────────────────────
 *
 * `executeAction` is the one function behind every registered exposure verb,
 * and nineteen of them are clear/reset/prune/compact — `memory.clear`,
 * `editor.clearHistory`, `learning.clearRules`, `context.clear` and the rest.
 * They are reachable over HTTP (`POST /api/schema/ui/actions/:id`) and, until
 * this wrapper, they destroyed state and left nothing behind: no record that
 * the state had existed, none that it was removed, none of who removed it.
 *
 * These tests assert the record EXISTS and says the right thing, from the
 * sink's side — which is the side the ledger sees.
 */

type Captured = EffectRecord[];

function withSink(body: (captured: Captured) => Promise<void>): Promise<void> {
  const captured: Captured = [];
  setEffectSink((record) => { captured.push(record); });
  return body(captured).finally(() => {
    setEffectSink(undefined);
    clearActions();
  });
}

test("exposure action: executing a verb emits one effect record naming it", async () => {
  await withSink(async (captured) => {
    let ran = 0;
    registerAction({
      id: "test.clearEverything",
      module: "test",
      name: "test verb",
      description: "clear everything",

      execute: () => { ran += 1; return { ok: true }; },
    });

    const result = await executeAction("test.clearEverything");

    assert.deepEqual(result, { ok: true });
    assert.equal(ran, 1, "the verb must still actually run");
    assert.equal(captured.length, 1, "exactly one effect record");
    assert.equal(captured[0]?.kind, "action");
    assert.equal(captured[0]?.name, "test.clearEverything", "the record must name the verb that ran");
    assert.equal(captured[0]?.outcome, "succeeded");
  });
});

test("exposure action: a verb that THREW is recorded as failed, not left unrecorded", async () => {
  await withSink(async (captured) => {
    registerAction({
      id: "test.clearThatBreaks",
      module: "test",
      name: "test verb",
      description: "clear, badly",

      execute: () => { throw new Error("half the cache is gone"); },
    });

    await assert.rejects(() => executeAction("test.clearThatBreaks"));

    // The dangerous case: a destructive verb that got part way and then threw
    // has changed the world. "It failed" is not a reason to record nothing.
    assert.equal(captured.length, 1, "a failed verb must still be recorded");
    assert.equal(captured[0]?.outcome, "failed");
    assert.equal(captured[0]?.name, "test.clearThatBreaks");
    assert.ok(captured[0]?.error?.message.includes("half the cache is gone"));
  });
});

test("exposure action: an async verb is recorded when it SETTLES, not when it starts", async () => {
  await withSink(async (captured) => {
    let resolveIt: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { resolveIt = resolve; });
    registerAction({
      id: "test.slowClear",
      module: "test",
      name: "test verb",
      description: "a slow clear",

      execute: async () => { await gate; return { ok: true }; },
    });

    const pending = executeAction("test.slowClear");
    // Yield the loop so a wrapper that recorded on INVOCATION would have.
    await Promise.resolve();
    assert.equal(captured.length, 0, "nothing may be recorded while the verb is still running");

    resolveIt?.();
    await pending;
    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.outcome, "succeeded");
  });
});

test("exposure action: a refusal before the verb runs records nothing", async () => {
  await withSink(async (captured) => {
    // Nothing happened in the world, so an event would be a record of an
    // effect that did not occur — the falsification this whole layer refuses.
    await assert.rejects(() => executeAction("test.notRegistered"));
    assert.equal(captured.length, 0, "an unregistered id must not produce an effect record");

    registerAction({
      id: "test.needsAnArgument",
      module: "test",
      name: "test verb",
      description: "needs an argument",

      args: { count: { type: "number", required: true, description: "how many" } },
      execute: () => ({ ok: true }),
    });
    await assert.rejects(() => executeAction("test.needsAnArgument"));
    assert.equal(captured.length, 0, "invalid arguments must not produce an effect record");
  });
});

test("exposure action: with no ledger attached, executing a verb still works", async () => {
  setEffectSink(undefined);
  try {
    registerAction({
      id: "test.noLedger",
      module: "test",
      name: "test verb",
      description: "runs with no ledger",

      execute: () => ({ ok: true }),
    });
    assert.deepEqual(await executeAction("test.noLedger"), { ok: true });
  } finally { clearActions(); }
});
