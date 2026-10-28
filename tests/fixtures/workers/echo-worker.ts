/**
 * Test fixture — an echo worker that posts `{ ok: true, value }` back to the
 * parent. Used by the worker-thread-owner prevention test to verify dedup
 * (same dedupKey → shared promise), the concurrency cap, and the
 * malformed-payload path (via bad-payload-worker). Optional `delayMs` in
 * workerData delays the post (used by the concurrency-cap test to keep
 * workers active long enough to fill the pool).
 *
 * Built-in node:worker_threads. Loaded with
 * --experimental-strip-types by the pool.
 */
import { parentPort, workerData } from "node:worker_threads";

if (parentPort === null) throw new Error("this fixture is a worker thread's entry; start it as a worker");

const input = workerData as { value?: number; delayMs?: number; preloadKey?: string };
const port = parentPort;
const send = (): void => {
  port.postMessage({
    ok: true,
    value: input.value ?? 0,
    execArgv: process.execArgv,
    preload: input.preloadKey === undefined ? undefined : Reflect.get(globalThis, Symbol.for(input.preloadKey)),
  });
};
if (typeof input.delayMs === "number" && input.delayMs > 0) {
  setTimeout(send, input.delayMs);
} else {
  send();
}
