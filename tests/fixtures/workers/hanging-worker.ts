/**
 * Test fixture — a hanging worker that NEVER posts a message. Used by the
 * worker-thread-owner prevention test to verify the pool's configurable
 * timeout: a worker that doesn't post within `timeoutMs` is terminated +
 * the promise rejects with the caller's typed error (fixes the
 * "worker-hang → permanent 'not ready'" bug). The `setInterval` keeps the
 * worker thread alive until the pool terminates it (otherwise an idle
 * worker would exit immediately + the exit handler would fire).
 *
 * Built-in node:worker_threads.
 */
import { parentPort } from "node:worker_threads";

if (parentPort === null) {
  process.exit(1);
}
// Never post — the pool's timeout should terminate + reject.
// Keep the worker alive so the timeout (not an early exit) fires.
setInterval(() => {}, 1000);
