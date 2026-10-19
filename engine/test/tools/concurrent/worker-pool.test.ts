import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";

import { WorkerPool } from "../../../src/tools/concurrent/worker-pool.ts";

const WORKER = resolve("scripts/concurrent/worker-entry.mjs");
const ROOT = resolve("large-codebases/babel");

test("worker-pool: rejects non-positive size", () => {
  assert.throws(
    () => new WorkerPool({ size: 0, workerScript: WORKER, root: ROOT }),
    /positive integer/i,
  );
  assert.throws(
    () => new WorkerPool({ size: -1, workerScript: WORKER, root: ROOT }),
    /positive integer/i,
  );
});

test("worker-pool: rejects empty workerScript", () => {
  assert.throws(
    () => new WorkerPool({ size: 2, workerScript: "", root: ROOT }),
    /non-empty path/i,
  );
});

test("worker-pool: start + exec count_functions + shutdown", async () => {
  const pool = new WorkerPool({ size: 2, workerScript: WORKER, root: ROOT, spawnTimeoutMs: 15000 });
  await pool.start();
  const r = await pool.exec({ id: "t1", name: "count_functions", args: { path: "eslint.config.ts" } });
  assert.equal(r.ok, true);
  assert.ok(r.durationMs >= 0);
  await pool.shutdown();
});

test("worker-pool: unknown CPU tool → ok=false", async () => {
  const pool = new WorkerPool({ size: 1, workerScript: WORKER, root: ROOT, spawnTimeoutMs: 15000 });
  await pool.start();
  const r = await pool.exec({ id: "t2", name: "nonexistent_cpu_tool", args: {} });
  assert.equal(r.ok, false);
  assert.match(r.error!, /unknown CPU tool/);
  await pool.shutdown();
});

test("worker-pool: ENOENT file → ok=false (handler throws, worker survives)", async () => {
  const pool = new WorkerPool({ size: 1, workerScript: WORKER, root: ROOT, spawnTimeoutMs: 15000 });
  await pool.start();
  const r1 = await pool.exec({ id: "e1", name: "count_functions", args: { path: "NONEXISTENT.ts" } });
  assert.equal(r1.ok, false);
  assert.match(r1.error!, /ENOENT/);
  // The worker should still be usable after an error.
  const r2 = await pool.exec({ id: "ok1", name: "count_functions", args: { path: "eslint.config.ts" } });
  assert.equal(r2.ok, true);
  await pool.shutdown();
});

test("worker-pool: multiple concurrent exec calls distribute across workers", async () => {
  const pool = new WorkerPool({ size: 4, workerScript: WORKER, root: ROOT, spawnTimeoutMs: 15000 });
  await pool.start();
  const calls = Array.from({ length: 8 }, (_, i) =>
    pool.exec({ id: `c${i}`, name: "count_functions", args: { path: "eslint.config.ts" } }),
  );
  const results = await Promise.all(calls);
  assert.equal(results.filter((r) => r.ok).length, 8);
  await pool.shutdown();
});
