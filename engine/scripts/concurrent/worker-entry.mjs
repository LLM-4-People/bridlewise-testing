// EXP448 — Worker thread entry point for the concurrent dispatcher.
//
// Sends a `{ ready: true }` handshake on startup so the WorkerPool can
// await worker readiness (and time out a hung spawn). Then registers
// the message handler that dispatches CPU-bound tool calls to the
// handler registry in handlers.mjs.
//
// Message protocol (in):  { id, name, args, contents? }
// Message protocol (out): { id, ok, result?, error?, durationMs }

import { parentPort, workerData } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { CPU_HANDLERS } from "./worker-handlers.mjs";
// The event loop's door (the thread's fault policy is the bootstrap's: SCALE-CR1-FIX H2).
import { guarded } from "../../src/process/fault-policy.ts";

if (!parentPort) {
  throw new Error("worker-entry.mjs must be loaded inside a worker_threads Worker");
}

// Signal readiness so WorkerPool.start() can await (and time out) spawns.
parentPort.postMessage({ ready: true });

parentPort.on("message", guarded("tools.worker-entry.message", async (msg) => {
  const t0 = performance.now();
  try {
    const handler = CPU_HANDLERS[msg.name];
    if (!handler) {
      parentPort.postMessage({ id: msg.id, ok: false, error: `unknown CPU tool '${msg.name}'`, durationMs: 0 });
      return;
    }
    // Pass `contents` (pre-read file contents) through to handlers that
    // support it, so the worker can operate purely on CPU.
    const args = msg.args ?? {};
    if (Array.isArray(msg.contents) && !args.contents) {
      args.contents = msg.contents;
    }
    const result = await handler(args);
    parentPort.postMessage({ id: msg.id, ok: true, result, durationMs: performance.now() - t0 });
  } catch (e) {
    const name = e?.name ?? "Error";
    const message = e?.message ?? String(e);
    parentPort.postMessage({ id: msg.id, ok: false, error: `${name}: ${message}`, durationMs: performance.now() - t0 });
  }
}));
