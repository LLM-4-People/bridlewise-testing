// @vitest-environment node
/**
 * Prevention test — SPO: Worker Thread Management Owner.
 *
 * Mechanically enforces the Single-Party-Owner principle that ALL backend
 * `node:worker_threads` spawning goes through ONE owner module
 * (`server/worker-pool.ts`). No bridge/service spawns `new Worker(...)`
 * directly. The pool handles spawning, same-key dedup, configurable
 * timeout, error mapping, concurrency cap, and shutdown cleanup.
 *
 * Assurance classes:
 * A — Source-scan (DYNAMIC discovery): `new Worker(` appears
 * ONLY in server/worker-pool.ts among server/.ts files.
 * B — Single owner: `runWorkerTask` is defined ONLY in worker-pool.ts.
 * C — Bridges route through the pool (no direct `new Worker`, no
 * `node:worker_threads` import in the bridges).
 * D — Config owner: harness-config.ts defines the timeout + concurrency
 * accessors; worker-pool.ts imports them.
 * E — Cleanup on shutdown: worker-pool.ts registers SIGTERM/SIGINT/
 * beforeExit handlers + exposes shutdownWorkerPool.
 * F — Pending-entry (N-build storm fix): all 3 build functions set a
 * pending cache entry (the map worker now does too-V3 fix).
 * G — Behavioral timeout: a hanging worker rejects within the timeout
 * with the caller's typed error.
 * H — Behavioral dedup: same dedupKey → shared promise (one worker).
 * I — Behavioral concurrency cap: at capacity → rejects with
 * `${label}_worker_pool_full`.
 * J — Behavioral malformed payload: a worker posting `{ok:true}` with no
 * payload → rejects with `${label}_worker_bad_payload`.
 * K — Behavioral typed-error propagation: the rejection is the caller's
 * errorClass (MapNotReadyError), not a generic Error.
 *
 * every error assertion verifies the SPECIFIC error type AND
 * code/message. dynamic `readdirSync` discovery — no hardcoded
 * file lists. built-in node:worker_threads only.
 */
import { describe, test, expect, afterAll, afterEach } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname, relative } from "node:path";
import { runWorkerTask, shutdownWorkerPool, activeWorkerCount, getInFlightWorker } from "../../server/run/worker-pool.ts";
import { MapNotReadyError, WebError } from "../../server/kernel/errors.ts";
import { getWorkerTimeoutMs, getWorkerMaxConcurrent } from "../../server/kernel/harness-config.ts";
import { walkTs } from "../helpers/source-scan.ts";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "server");
const TESTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const POOL_PATH = join(SERVER_DIR, "run/worker-pool.ts");
const echoUrl = new URL("../fixtures/workers/echo-worker.ts", import.meta.url);
const hangingUrl = new URL("../fixtures/workers/hanging-worker.ts", import.meta.url);
const badPayloadUrl = new URL("../fixtures/workers/bad-payload-worker.ts", import.meta.url);

/** Read a server file's source (relative path from server/). */
function readServer(rel: string): string {
  return readFileSync(join(SERVER_DIR, rel), "utf8");
}

afterEach(() => {
  // Clear all active workers + inflight entries between tests so each test
  // starts from a clean pool state (the cap test depends on activeWorkerCount
  // starting at 0). Terminates any lingering worker threads.
  shutdownWorkerPool();
});
afterAll(() => {
  shutdownWorkerPool();
});

// ── A. Source-scan: `new Worker(` confined to worker-pool.ts ──

/**
 * The modules permitted to construct a worker thread, named INDIVIDUALLY and
 * each with the reason it cannot go through the pool.
 *
 *  - `worker-pool.ts` — the general-purpose TASK pool. Short-lived units of
 *    work, capped, queued, recycled. This is where anything task-shaped goes.
 *  - `db/thread-backend.ts` — the async data facade's connections. These are
 *    NOT tasks. Each thread owns a long-lived SQLite handle for the lifetime
 *    of the process, and the whole architecture depends on WHICH thread a call
 *    lands on: exactly one writer, because the ledger's chain hash needs
 *    "the entry before this one" to be well defined, and read-only readers
 *    that SQLite itself refuses to let write. A pool that recycles workers or
 *    routes freely would break both properties, so the identity of the thread
 *    is the point rather than an implementation detail.
 *
 * Named one at a time, never as a directory glob, so a new worker has to
 * argue for itself here rather than inherit permission from its neighbours.
 */
const WORKER_OWNERS: ReadonlySet<string> = new Set([
  "run/worker-pool.ts",
  "db/thread-backend.ts",
]);

describe("A. source-scan — new Worker( confined to its declared owners (dynamic discovery)", () => {
  test("the invariant this file states is the invariant it checks — TWO owners, not one", () => {
    // A GUARD MUST NOT CLAIM MORE THAN IT ENFORCES. The heading here read
    // "worker creation lives ONLY in worker-pool.ts" while `WORKER_OWNERS`
    // held two entries, so the sentence a reader takes away was false and the
    // second owner arrived without ever being argued for. The count is stated
    // as a number so it cannot grow quietly, and each member is checked to be
    // a file that really exists — a stale name would silently narrow the rule
    // by making its exemption unreachable, which reads as a stricter guard and
    // is a weaker one.
    expect([...WORKER_OWNERS].sort(), `declared worker owners: ${[...WORKER_OWNERS].join(", ")}`)
      .toEqual(["db/thread-backend.ts", "run/worker-pool.ts"]);
    for (const owner of WORKER_OWNERS) {
      const src = readFileSync(join(SERVER_DIR, owner), "utf8");
      expect(src, `${owner} is declared an owner but creates no worker`).toContain("new Worker(");
    }
  });

  test("new Worker( appears ONLY in the declared owners among all server/*.ts files", () => {
    const files = walkTs(SERVER_DIR);
    expect(files.length, "server/ should contain .ts files").toBeGreaterThan(0);
    const violators: string[] = [];
    for (const f of files) {
      const rel = relative(SERVER_DIR, f);
      const src = readFileSync(f, "utf8");
      // Strip comment lines so a comment mentioning `new Worker(` doesn't
      // false-positive, but a real call still matches.
      const code = src
        .split("\n")
        .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
        .join("\n");
      if (code.includes("new Worker(") && !WORKER_OWNERS.has(rel)) {
        violators.push(rel);
      }
    }
    expect(violators, "`new Worker(` must appear ONLY in a declared owner — found it in: " + violators.join(", ")).toEqual([]);
  });

  test("server/worker-pool.ts exists and owns new Worker( + node:worker_threads", () => {
    expect(existsSync(POOL_PATH), "server/worker-pool.ts must exist").toBe(true);
    const src = readFileSync(POOL_PATH, "utf8");
    expect(src).toContain('from "node:worker_threads"');
    expect(src).toContain("new Worker(");
  });

  test("the worker entry-point files use parentPort (worker-side), NOT new Worker( (spawn-side)", () => {
    // Dynamic discovery (deny-by-default): scan server/ for ALL `*-worker.ts`
    // files. A new worker added tomorrow is auto-covered — no static list.
    const workerFiles = walkTs(SERVER_DIR).filter((f) => f.endsWith("-worker.ts"));
    expect(workerFiles.length, "server/ should contain at least one *-worker.ts file").toBeGreaterThan(0);
    for (const f of workerFiles) {
      const w = relative(SERVER_DIR, f);
      const src = readFileSync(f, "utf8");
      const code = src.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
      expect(code, `${w} must not spawn a nested worker`).not.toContain("new Worker(");
      expect(src, `${w} must use node:worker_threads (parentPort/workerData)`).toContain("node:worker_threads");
    }
  });
});

// ── B. Single owner: runWorkerTask defined ONLY in worker-pool.ts ──

describe("B. single owner — runWorkerTask defined ONLY in worker-pool.ts", () => {
  test("runWorkerTask is exported + defined in worker-pool.ts and NOWHERE else in server/", () => {
    const files = walkTs(SERVER_DIR);
    const definers: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      // A function definition (not just a call/import). Match `function
      // runWorkerTask` or `export function runWorkerTask`.
      if (/\bfunction runWorkerTask\b/.test(src)) {
        definers.push(relative(SERVER_DIR, f));
      }
    }
    expect(definers, "runWorkerTask must be defined in exactly ONE file (run/worker-pool.ts)").toEqual(["run/worker-pool.ts"]);
    const poolSrc = readFileSync(POOL_PATH, "utf8");
    expect(poolSrc).toMatch(/export async function runWorkerTask/);
  });

  test("shutdownWorkerPool + activeWorkerCount are exported from worker-pool.ts", () => {
    const poolSrc = readFileSync(POOL_PATH, "utf8");
    expect(poolSrc).toMatch(/export function shutdownWorkerPool/);
    expect(poolSrc).toMatch(/export function activeWorkerCount/);
  });
});

// ── C. Bridges route through the pool (no direct spawn) ──

describe("C. bridges route through the pool — no new Worker( / node:worker_threads import", () => {
  test("intelligence-bridge.ts imports + calls runWorkerTask, has no new Worker( or node:worker_threads import", () => {
    const src = readServer("intelligence/intelligence-bridge.ts");
    expect(src).toContain('from "../run/worker-pool.ts"');
    expect(src).toContain("runWorkerTask");
    const code = src.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
    expect(code).not.toContain("new Worker(");
    expect(src).not.toMatch(/from "node:worker_threads"/);
  });

  test("awareness-bridge.ts imports + calls runWorkerTask, has no new Worker( or node:worker_threads import", () => {
    const src = readServer("awareness/awareness-bridge.ts");
    expect(src).toContain('from "../run/worker-pool.ts"');
    expect(src).toContain("runWorkerTask");
    const code = src.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
    expect(code).not.toContain("new Worker(");
    expect(src).not.toMatch(/from "node:worker_threads"/);
  });
});

// ── D. Config owner — timeout + concurrency accessors ──

describe("D. config owner — getWorkerTimeoutMs + getWorkerMaxConcurrent in harness-config.ts", () => {
  test("harness-config.ts defines the worker-thread config accessors (single owner)", () => {
    const src = readServer("kernel/harness-config.ts");
    expect(src).toMatch(/export function getWorkerTimeoutMs/);
    expect(src).toMatch(/export function getWorkerMaxConcurrent/);
    expect(src).toContain("workerThreads");
  });

  test("worker-pool.ts imports the config accessors (reads config through the single owner)", () => {
    const src = readFileSync(POOL_PATH, "utf8");
    expect(src).toContain("getWorkerTimeoutMs");
    expect(src).toContain("getWorkerMaxConcurrent");
  });

  test("the accessors return finite positive numbers (or 0 for disabled timeout)", () => {
    expect(Number.isFinite(getWorkerTimeoutMs())).toBe(true);
    expect(getWorkerTimeoutMs()).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(getWorkerMaxConcurrent())).toBe(true);
    expect(getWorkerMaxConcurrent()).toBeGreaterThan(0);
  });
});

// ── E. Cleanup on shutdown ──

describe("E. cleanup on shutdown — SIGTERM/SIGINT/beforeExit + shutdownWorkerPool", () => {
  test("worker-pool.ts registers SIGTERM/SIGINT/beforeExit handlers + exposes shutdownWorkerPool", () => {
    const src = readFileSync(POOL_PATH, "utf8");
    expect(src).toContain('process.once("SIGTERM"');
    expect(src).toContain('process.once("SIGINT"');
    expect(src).toContain('process.once("beforeExit"');
    expect(src).toMatch(/export function shutdownWorkerPool/);
  });
});

// ── F. Pending-entry at the LOWEST level (pool owns it, not bridges) ──

describe("F. pending-entry at the lowest level — the pool owns the in-flight state", () => {
  test("worker-pool.ts sets the inflight entry BEFORE spawning (deferred pattern)", () => {
    const src = readFileSync(POOL_PATH, "utf8");
    // The deferred pattern: createDeferred + inflight.set BEFORE spawnWorker.
    expect(src).toContain("createDeferred");
    expect(src).toMatch(/inflight\.set\(dedupKey, deferred\.promise\)/);
    expect(src).toMatch(/spawnWorker<.*>\(.*deferred\.resolve.*deferred\.reject/);
    // The pool must expose getInFlightWorker so bridges can check the
    // in-flight state without maintaining their own pending entries.
    expect(src).toMatch(/export function getInFlightWorker/);
  });

  test("intelligence-bridge.ts does NOT set a pending mapCache entry (pool owns it)", () => {
    const src = readServer("intelligence/intelligence-bridge.ts");
    // The bridge must NOT set a pending entry — the pool owns the in-flight
    // state. A pending entry in the bridge is the RIGID pattern that a new
    // bridge could forget; the pool's inflight is the DYNAMIC fix.
    expect(src).not.toMatch(/mapCache\.set\(projectPath,\s*\{\s*status:\s*"pending"/);
    expect(src).not.toMatch(/quickViewIndexCache\.set\(projectPath,\s*\{\s*status:\s*"pending"/);
    // The bridge must use getInFlightWorker for the sync path.
    expect(src).toContain("getInFlightWorker");
  });

  test("awareness-bridge.ts does NOT set a pending snapshotCache entry (pool owns it)", () => {
    const src = readServer("awareness/awareness-bridge.ts");
    expect(src).not.toMatch(/snapshotCache\.set\(projectPath,\s*\{\s*status:\s*"pending"/);
    expect(src).toContain("getInFlightWorker");
  });

  test("a new bridge using runWorkerTask gets automatic dedup without manual pending code", async () => {
    // Simulate a NEW bridge that calls runWorkerTask with a dedupKey. The
    // pool should automatically dedup — two calls with the same key return
    // the SAME promise (one worker). The new bridge does NOT set any
    // pending entry; the pool handles it.
    const key = "new-bridge-" + Date.now();
    const opts = {
      workerUrl: echoUrl,
      workerData: { value: 7 },
      errorClass: MapNotReadyError,
      label: "new-bridge",
      dedupKey: key,
      timeoutMs: 5000,
      validateOk: (msg: unknown): number => (msg as { value?: number }).value ?? 0,
    };
    // Two calls with the same key → ONE worker (the pool deduped): the door is
    // async, so each call has its own promise, both settling with the shared one.
    const before = activeWorkerCount();
    const p1 = runWorkerTask<number>(opts);
    const p2 = runWorkerTask<number>(opts);
    expect(activeWorkerCount() - before).toBe(1);
    // getInFlightWorker returns the shared in-flight promise.
    const shared = getInFlightWorker<number>(echoUrl, key);
    expect(shared).toBeDefined();
    expect(await Promise.all([p1, p2, shared!])).toEqual([7, 7, 7]);
  });
});

// ── G. Behavioral — timeout (worker-hang → permanent not-ready fix) ──

describe("G. behavioral — a hanging worker rejects within the timeout (typed error)", () => {
  test("a worker that never posts rejects with ${label}_worker_timeout within the timeout", async () => {
    const start = Date.now();
    const p = runWorkerTask<number>({
      workerUrl: hangingUrl,
      workerData: {},
      errorClass: MapNotReadyError,
      label: "test-timeout",
      dedupKey: "timeout-" + Date.now(),
      timeoutMs: 150,
      validateOk: (msg) => (msg as { value?: number }).value ?? 0,
    });
    try {
      await p;
      expect.unreachable("a hanging worker should reject via timeout, not resolve");
    } catch (err) {
      // verify the SPECIFIC error type AND code.
      expect(err).toBeInstanceOf(MapNotReadyError);
      expect((err as MapNotReadyError).code).toBe("test-timeout_worker_timeout");
      expect((err as MapNotReadyError).retryable).toBe(true);
    }
    const elapsed = Date.now() - start;
    // Should reject within roughly the timeout (allow scheduler slack).
    expect(elapsed).toBeLessThan(2000);
  });
});

// ── H. Behavioral — dedup (same dedupKey → shared promise) ──

describe("H. behavioral — same dedupKey shares ONE worker (dedup)", () => {
  test("two synchronous calls with the same dedupKey share ONE worker", () => {
    const key = "dedup-same-" + Date.now();
    const opts = {
      workerUrl: echoUrl,
      workerData: { value: 42 },
      errorClass: MapNotReadyError,
      label: "test-dedup",
      dedupKey: key,
      timeoutMs: 5000,
      validateOk: (msg: unknown): number => (msg as { value?: number }).value ?? 0,
    };
    const before = activeWorkerCount();
    const p1 = runWorkerTask<number>(opts);
    const p2 = runWorkerTask<number>(opts);
    // Dedup: one worker spawned; both callers settle with its answer.
    expect(activeWorkerCount() - before).toBe(1);
    return Promise.all([p1, p2]).then((values) => expect(values).toEqual([42, 42]));
  });

  test("activeWorkerCount reflects spawned workers", async () => {
    const before = activeWorkerCount();
    const key = "count-" + Date.now();
    const originalArgs = process.execArgv;
    const preload = `globalThis[Symbol.for(${JSON.stringify(key)})] = ${JSON.stringify(key)};`;
    const args = [...originalArgs, "--conditions", "first-worker-condition", "--conditions", "second-worker-condition",
      "--import", `data:text/javascript,${encodeURIComponent(preload)}`];
    process.execArgv = args;
    let p: Promise<{ value: number; execArgv: string[]; preload: unknown }>;
    try {
      p = runWorkerTask({
        workerUrl: echoUrl,
        workerData: { value: 1, preloadKey: key },
        errorClass: MapNotReadyError,
        label: "test-count",
        dedupKey: key,
        timeoutMs: 5000,
        validateOk: (msg) => msg as { value: number; execArgv: string[]; preload: unknown },
      });
    } finally {
      process.execArgv = originalArgs;
    }
    // The worker is active until the message arrives (next tick).
    expect(activeWorkerCount()).toBeGreaterThan(before);
    const result = await p;
    expect(result.value).toBe(1);
    expect(result.preload, "repeatable argument pairs preserve the later native preload's effect").toBe(key);
    expect(result.execArgv).toEqual(args.includes("--experimental-strip-types") ? args : [...args, "--experimental-strip-types"]);
    // After resolution, the worker is cleaned up (cleanup is async — poll
    // briefly until the count drops back, with a timeout).
    for (let i = 0; i < 50 && activeWorkerCount() > before; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(activeWorkerCount()).toBe(before);
  });
});

// ── I. Behavioral — concurrency cap ──

describe("I. behavioral — at capacity, a new spawn rejects (pool full)", () => {
  test("spawning maxConcurrent workers then one more rejects with ${label}_worker_pool_full", async () => {
    const max = getWorkerMaxConcurrent();
    // Spawn `max` hanging workers with unique dedupKeys + a long timeout so
    // they stay active (fill the pool). Handle their eventual rejection
    // (the afterEach shutdown terminates them).
    const fillers: Promise<unknown>[] = [];
    for (let i = 0; i < max; i++) {
      const p = runWorkerTask<number>({
        workerUrl: hangingUrl,
        workerData: {},
        errorClass: MapNotReadyError,
        label: "test-cap",
        dedupKey: `cap-${i}-${Date.now()}`,
        timeoutMs: 60_000,
        validateOk: () => 0,
      });
      // Suppress the expected rejection from the afterEach cleanup
      // termination (NOT swallowing a real bug — the cap behavior is
      // verified separately below; these workers are terminated on cleanup).
      void p.then(undefined, () => { /* terminated by shutdownWorkerPool */ });
      fillers.push(p);
    }
    // Give the workers a tick to register in activeWorkers.
    await new Promise((r) => setTimeout(r, 30));
    expect(activeWorkerCount(), "the pool should be at capacity").toBeGreaterThanOrEqual(max);
    // The (max+1)th spawn (unique dedupKey) should reject — pool full.
    const overflow = runWorkerTask<number>({
      workerUrl: hangingUrl,
      workerData: {},
      errorClass: MapNotReadyError,
      label: "test-cap",
      dedupKey: `cap-overflow-${Date.now()}`,
      timeoutMs: 60_000,
      validateOk: () => 0,
    });
    try {
      await overflow;
      expect.unreachable("an over-capacity spawn should reject, not resolve");
    } catch (err) {
      // verify the SPECIFIC error type AND code.
      expect(err).toBeInstanceOf(MapNotReadyError);
      expect((err as MapNotReadyError).code).toBe("test-cap_worker_pool_full");
    }
  });
});

// ── J. Behavioral — malformed payload ──

describe("J. behavioral — a malformed ok payload rejects (bad_payload)", () => {
  test("a worker posting {ok:true} with no payload rejects with ${label}_worker_bad_payload", async () => {
    const p = runWorkerTask<number>({
      workerUrl: badPayloadUrl,
      workerData: {},
      errorClass: MapNotReadyError,
      label: "test-bad-payload",
      dedupKey: "bad-" + Date.now(),
      timeoutMs: 5000,
      // Returns `undefined` when `value` is missing — the pool detects the
      // undefined return + rejects with `${label}_worker_bad_payload`.
      validateOk: (msg) => (msg as { value?: number }).value,
    });
    try {
      await p;
      expect.unreachable("a malformed payload should reject, not resolve");
    } catch (err) {
      // verify the SPECIFIC error type AND code.
      expect(err).toBeInstanceOf(MapNotReadyError);
      expect((err as MapNotReadyError).code).toBe("test-bad-payload_worker_bad_payload");
    }
  });
});

// ── K. Behavioral — typed-error propagation ──

describe("K. behavioral — rejections use the caller's typed errorClass", () => {
  test("a timeout rejection is an instanceof the caller's errorClass (MapNotReadyError) + WebError", async () => {
    const p = runWorkerTask<number>({
      workerUrl: hangingUrl,
      workerData: {},
      errorClass: MapNotReadyError,
      label: "test-typed",
      dedupKey: "typed-" + Date.now(),
      timeoutMs: 100,
      validateOk: (msg) => (msg as { value?: number }).value ?? 0,
    });
    try {
      await p;
      expect.unreachable("should reject");
    } catch (err) {
      expect(err).toBeInstanceOf(MapNotReadyError);
      expect(err).toBeInstanceOf(WebError);
      // NOT a generic Error — the pool throws the caller's typed class.
      expect((err as Error).name).toBe("MapNotReadyError");
    }
  });
});
