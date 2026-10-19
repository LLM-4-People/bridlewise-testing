import assert from "node:assert/strict";
import test from "node:test";

import {
  createConcurrentDispatcher,
  DispatcherError,
  type HandlerContext,
  type ToolHandler,
} from "../../../src/tools/concurrent/dispatcher.ts";
import type { ConcurrentToolCall } from "../../../src/tools/concurrent/dependency-graph.ts";

function makeRegistry(): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  handlers.set("echo", async (args) => ({ ok: true, result: { echo: args.text ?? "" }, durationMs: 0 }));
  handlers.set("fail", async () => ({ ok: false, error: "boom", durationMs: 0 }));
  handlers.set("slow", async (args) => {
    const t0 = Date.now();
    const ms = Number(args.ms ?? 50);
    await new Promise((r) => setTimeout(r, ms));
    return { ok: true, result: { waited: ms }, durationMs: Date.now() - t0 };
  });
  return handlers;
}

const ctx: HandlerContext = { root: process.cwd() };

test("dispatcher: sequential runs one at a time", async () => {
  const d = createConcurrentDispatcher(makeRegistry());
  const batch: ConcurrentToolCall[] = [
    { id: "1", name: "echo", args: { text: "a" } },
    { id: "2", name: "echo", args: { text: "b" } },
  ];
  const r = await d.execute(batch, "sequential", ctx, {});
  assert.equal(r.results.length, 2);
  assert.equal(r.results[0]!.ok, true);
  assert.equal(r.results[1]!.ok, true);
});

test("dispatcher: parallel runs all via Promise.all", async () => {
  const d = createConcurrentDispatcher(makeRegistry());
  const batch: ConcurrentToolCall[] = Array.from({ length: 50 }, (_, i) => ({
    id: `c${i}`, name: "slow", args: { ms: 20 },
  }));
  const r = await d.execute(batch, "parallel", ctx, {});
  const ok = r.results.filter((x) => x.ok).length;
  assert.equal(ok, 50);
  // 50 × 20ms sequential = 1000ms; parallel should be ~20ms (allow headroom
  // for the test runner + event-loop scheduling).
  assert.ok(r.totalMs < 500, `parallel should be fast (<500ms), got ${r.totalMs}ms`);
});

test("dispatcher: unknown tool → typed error result (no throw)", async () => {
  const d = createConcurrentDispatcher(makeRegistry());
  const r = await d.execute([{ id: "x", name: "nonexistent", args: {} }], "sequential", ctx, {});
  assert.equal(r.results[0]!.ok, false);
  assert.match(r.results[0]!.error!, /unknown tool 'nonexistent'/);
});

test("dispatcher: handler failure → ok=false, no crash", async () => {
  const d = createConcurrentDispatcher(makeRegistry());
  const r = await d.execute([{ id: "f", name: "fail", args: {} }], "sequential", ctx, {});
  assert.equal(r.results[0]!.ok, false);
  assert.equal(r.results[0]!.error, "boom");
});

test("dispatcher: callTimeoutMs → timed-out call returns error", async () => {
  const d = createConcurrentDispatcher(makeRegistry());
  const r = await d.execute(
    [{ id: "s", name: "slow", args: { ms: 500 } }],
    "sequential",
    ctx,
    { callTimeoutMs: 50 },
  );
  assert.equal(r.results[0]!.ok, false);
  assert.match(r.results[0]!.error!, /exceeded call timeout/i);
});

test("dispatcher: worker mode without pool → DispatcherError", async () => {
  const d = createConcurrentDispatcher(makeRegistry());
  await assert.rejects(
    d.execute([{ id: "x", name: "echo", args: {} }], "worker", ctx, {}),
    DispatcherError,
  );
});

test("dispatcher: streaming mode without pool → DispatcherError", async () => {
  const d = createConcurrentDispatcher(makeRegistry());
  await assert.rejects(
    d.execute([{ id: "x", name: "echo", args: {} }], "streaming", ctx, {}),
    DispatcherError,
  );
});

test("dispatcher: empty batch → 0 results, 0 ms", async () => {
  const d = createConcurrentDispatcher(makeRegistry());
  const r = await d.execute([], "sequential", ctx, {});
  assert.equal(r.results.length, 0);
  assert.equal(r.totalMs, 0);
});

test("dispatcher: dependency-aware without pool → DispatcherError", async () => {
  const d = createConcurrentDispatcher(makeRegistry());
  await assert.rejects(
    d.execute([{ id: "x", name: "echo", args: {} }], "dependency-aware", ctx, {}),
    DispatcherError,
  );
});

test("dispatcher: result truncation caps large content", async () => {
  const handlers = new Map<string, ToolHandler>();
  handlers.set("big", async () => ({ ok: true, result: { content: "x".repeat(5000) }, durationMs: 0 }));
  const d = createConcurrentDispatcher(handlers);
  const r = await d.execute([{ id: "b", name: "big", args: {} }], "sequential", ctx, { maxResultChars: 100 });
  assert.equal(r.results[0]!.truncated, true);
  assert.ok((r.results[0]!.content ?? "").length <= 100);
  assert.ok((r.results[0]!.originalBytes ?? 0) > 1000);
});
