/** The one retry delay (`src/shared/backoff.ts`), shared by the LLM client and the MCP retry layer. */
import assert from "node:assert/strict";
import test from "node:test";

import { backoffDelayMs } from "../../src/shared/backoff.ts";

const POLICY = { baseMs: 100, factor: 2, maxMs: 1_000, jitter: 0 } as const;

test("backoff: exponential from the base, capped at the ceiling", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 10].map((retry) => backoffDelayMs(POLICY, retry)), [100, 200, 400, 800, 1_000, 1_000]);
});

test("backoff: a server's Retry-After is a floor the ceiling never cuts", () => {
  assert.equal(backoffDelayMs(POLICY, 0, 5_000), 5_000);
  assert.equal(backoffDelayMs(POLICY, 0, 50), 50, "a shorter Retry-After is the server's own answer");
});

test("backoff: jitter stays within its fraction of the delay", () => {
  for (let i = 0; i < 200; i += 1) {
    const delay = backoffDelayMs({ ...POLICY, jitter: 0.25 }, 1);
    assert.ok(delay >= 150 && delay <= 250, String(delay));
  }
});
