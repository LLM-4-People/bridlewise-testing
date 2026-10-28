/**
 * Test fixture — a worker that posts `{ ok: true }` with NO payload field.
 * Used by the worker-thread-owner prevention test to verify the pool's
 * `validateOk` error path: the caller's `validateOk` extractor throws on the
 * missing payload → the pool rejects with a `${label}_worker_bad_payload`
 * typed error (not a silent undefined resolve that would crash downstream).
 *
 * Built-in node:worker_threads.
 */
import { parentPort } from "node:worker_threads";

if (parentPort === null) throw new Error("this fixture is a worker thread's entry; start it as a worker");
// Posts { ok: true } with NO payload — the caller's validateOk should
// throw (missing field) → the pool rejects with `${label}_worker_bad_payload`.
parentPort.postMessage({ ok: true });
