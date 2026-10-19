import assert from "node:assert/strict";
import test from "node:test";

import { withRetry, withReconnect, backoffDelay, DEFAULT_MCP_RETRY } from "../../src/mcp/index.ts";
import { McpError } from "../../src/mcp/errors.ts";

test("retry: succeeds on first attempt — no retry", async () => {
  let calls = 0;
  const result = await withRetry(async () => { calls += 1; return "ok"; }, { retry: DEFAULT_MCP_RETRY });
  assert.equal(result, "ok");
  assert.equal(calls, 1);
});

test("retry: retries retryable McpError up to count times then succeeds", async () => {
  let calls = 0;
  const attempts: number[] = [];
  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new McpError("transient", "mcp_transient", true, {});
      return "ok";
    },
    { retry: { count: 5, backoffMs: 1 }, onAttempt: (a) => attempts.push(a.attempt) },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(attempts, [1, 2, 3]);
});

test("retry: does not retry a non-retryable error — rethrows immediately", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls += 1;
      throw new McpError("fatal", "mcp_fatal", false, {});
    }, { retry: { count: 5, backoffMs: 1 } }),
    (e: unknown) => (e as Error).message === "fatal",
  );
  assert.equal(calls, 1);
});

test("retry: gives up after count attempts and rethrows the last error", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls += 1;
      throw new McpError("always fails", "mcp_transient", true, {});
    }, { retry: { count: 3, backoffMs: 1 } }),
    (e: unknown) => (e as Error).message === "always fails",
  );
  assert.equal(calls, 3);
});

test("retry: honors AbortSignal between attempts", async () => {
  const ctrl = new AbortController();
  let calls = 0;
  setTimeout(() => ctrl.abort(), 5);
  await assert.rejects(
    withRetry(async () => {
      calls += 1;
      throw new McpError("transient", "mcp_transient", true, {});
    }, { retry: { count: 10, backoffMs: 50 }, signal: ctrl.signal }),
  );
  assert.ok(calls < 10, `should not have exhausted all attempts (calls=${calls})`);
});

test("retry: backoffDelay is exponential and capped at 10x base", () => {
  assert.equal(backoffDelay(1, 100), 100);
  assert.equal(backoffDelay(2, 100), 200);
  assert.equal(backoffDelay(3, 100), 400);
  assert.equal(backoffDelay(10, 100), 1000); // capped at 10x
  assert.equal(backoffDelay(20, 100), 1000); // still capped
});

test("retry: withReconnect calls reconnect then retries the operation", async () => {
  let opCalls = 0;
  let reconnectCalls = 0;
  const result = await withReconnect(
    async () => {
      opCalls += 1;
      if (opCalls === 1) throw new McpError("dropped", "mcp_transport_closed", true, {}, true);
      return "recovered";
    },
    async () => { reconnectCalls += 1; },
    { retry: { count: 3, backoffMs: 1 } },
  );
  assert.equal(result, "recovered");
  assert.equal(opCalls, 2);
  assert.equal(reconnectCalls, 1);
});

test("retry: withReconnect does NOT reconnect on non-retryable error", async () => {
  let reconnectCalls = 0;
  await assert.rejects(
    withReconnect(
      async () => { throw new McpError("fatal", "mcp_fatal", false, {}); },
      async () => { reconnectCalls += 1; },
      { retry: { count: 3, backoffMs: 1 } },
    ),
  );
  assert.equal(reconnectCalls, 0);
});
