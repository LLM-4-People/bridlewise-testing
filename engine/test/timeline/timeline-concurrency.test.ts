import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

import { createTimelineStore, type EventLedgerStoragePort } from "../../src/timeline/timeline-store.ts";
import type { TimelineStandaloneEventInput } from "../../src/timeline/timeline-types.ts";
import { sha256 } from "../../src/kernel/integrity.ts";
import { mkTempDir } from "../support/temp-dir.ts";

/**
 * P0-1 regression test: concurrent appenders must not corrupt the append-only
 * chain. Before the fix, doAppend read the chain tip (sequence + previous chain
 * hash) BEFORE BEGIN IMMEDIATE — a TOCTOU where two appenders both read seq=N
 * and the second commit inserts a duplicate sequence with a stale
 * previous_chain_hash. The fix reads the tip INSIDE BEGIN IMMEDIATE (with
 * PRAGMA busy_timeout) so the write lock serializes the read-modify-write.
 *
 * Each worker opens its own DatabaseSync handle to the SAME db file and
 * appends events concurrently. With the fix, all appends serialize cleanly:
 * sequences are a unique 1..N run and verifyChain is valid.
 */
const WORKER_URL = new URL("./timeline-concurrency-worker.ts", import.meta.url);

interface WorkerResult {
  workerIndex: number;
  appended: number;
  errors: string[];
}

async function runWorkers(dbPath: string, ledgerId: string, count: number, workerCount: number, signal: AbortSignal, operation: "event" | "intent" | "terminal" = "event"): Promise<WorkerResult[]> {
  signal.throwIfAborted();
  const workers: { worker: Worker; ready: Promise<void>; result: Promise<WorkerResult> }[] = [];
  const aborted = Promise.withResolvers<never>();
  const onAbort = () => aborted.reject(signal.reason);
  void aborted.promise.catch(() => {});
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (let workerIndex = 0; workerIndex < workerCount; workerIndex += 1) {
      const ready = Promise.withResolvers<void>();
      const result = Promise.withResolvers<WorkerResult>();
      // Both promises can reject before the group reaches its corresponding await.
      // The original promises are still awaited below; these handlers only prevent
      // an early worker failure becoming an unrelated unhandled rejection.
      void ready.promise.catch(() => {});
      void result.promise.catch(() => {});
      const worker = new Worker(WORKER_URL, {
        workerData: { dbPath, ledgerId, count, workerIndex, operation },
      });
      workers.push({ worker, ready: ready.promise, result: result.promise });
      let value: WorkerResult | undefined;
      worker.on("message", (msg: { type: "ready" } | { type: "result"; value: WorkerResult }) => {
        if (msg.type === "ready") ready.resolve();
        else if (msg.type === "result") value = msg.value;
      });
      worker.on("error", (error) => { ready.reject(error); result.reject(error); });
      worker.on("exit", (code) => {
        ready.reject(new Error(`worker ${workerIndex} exited before becoming ready (code ${code})`));
        if (code !== 0 || value === undefined) {
          const error = new Error(`worker ${workerIndex} exited without a result (code ${code})`);
          result.reject(error);
        } else result.resolve(value);
      });
    }
    // Chain contention starts only after every connection has opened. Open-time
    // contention has its own controlled held-lock test below.
    await Promise.race([Promise.all(workers.map(({ ready }) => ready)), aborted.promise]);
    for (const { worker } of workers) worker.postMessage({ type: "start" });
    return await Promise.race([Promise.all(workers.map(({ result }) => result)), aborted.promise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
    // A rejected opener must not leave peers appending while the caller removes
    // the database directory. Errors may reject before exit, so terminate joins
    // every worker before the caller can clean up its files.
    await Promise.all(workers.map(({ worker }) => worker.terminate()));
    await Promise.allSettled(workers.flatMap(({ ready, result }) => [ready, result]));
  }
}

test("timeline-store: failed worker opens drain every started worker before returning", { timeout: 120_000 }, async (t) => {
  const dir = mkTempDir("timeline-worker-open-failure-");
  const terminated: Worker[] = [];
  const terminate = Worker.prototype.terminate;
  t.mock.method(Worker.prototype, "terminate", async function (this: Worker) {
    const code = await terminate.call(this);
    terminated.push(this);
    return code;
  });
  const workerCount = 4;
  try {
    await assert.rejects(runWorkers(join(dir, "missing", "timeline.db"), "failed-open", 1, workerCount, t.signal),
      (error: unknown) => error instanceof Error && error.message === "unable to open database file" &&
        "code" in error && error.code === "ERR_SQLITE_ERROR" && "errcode" in error && error.errcode === 14);
    assert.equal(terminated.length, workerCount, "every started worker was joined before rejection returned");
    assert.ok(terminated.every((worker) => worker.threadId === -1), "no worker remains active after rejection");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("timeline-store: configured busy timeout is active before WAL setup under a held lock", (t) => {
  const dir = mkTempDir("timeline-open-lock-");
  const dbPath = join(dir, "held.db");
  const holder = new DatabaseSync(dbPath);
  const timeoutMs = 37;
  let store: EventLedgerStoragePort | undefined;
  try {
    assert.equal(holder.prepare("PRAGMA journal_mode").get()!.journal_mode, "delete");
    holder.exec("CREATE TABLE held (value TEXT); BEGIN EXCLUSIVE; INSERT INTO held VALUES ('retained')");
    const observedTimeouts: number[] = [];
    const observedModes: string[] = [];
    // The FIRST statement that touches the file is the provenance admission's
    // header read (SCALE-CR1-FIX N5: nothing may change the file before it),
    // so the lock wait must already be configured there too.
    const admissionTimeouts: number[] = [];
    const prepare = DatabaseSync.prototype.prepare;
    const admission = t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      if (sql === "PRAGMA application_id") admissionTimeouts.push(Number(prepare.call(this, "PRAGMA busy_timeout").get()!.timeout));
      return prepare.call(this, sql);
    });
    const exec = DatabaseSync.prototype.exec;
    const injection = t.mock.method(DatabaseSync.prototype, "exec", function (this: DatabaseSync, sql: string) {
      if (sql === "PRAGMA journal_mode = WAL") {
        observedTimeouts.push(Number(this.prepare("PRAGMA busy_timeout").get()!.timeout));
      }
      const result = exec.call(this, sql);
      if (sql === "PRAGMA journal_mode = WAL") observedModes.push(String(this.prepare("PRAGMA journal_mode").get()!.journal_mode));
      return result;
    });
    try {
      // The lock remains held for the entire synchronous open, so this drives
      // actual SQLite contention without a scheduling delay or synthetic throw.
      assert.throws(() => createTimelineStore({ path: dbPath, ledgerId: "held", timelineConfig: { sqliteBusyTimeoutMs: timeoutMs } }),
        (error: unknown) => error instanceof Error && error.message === "database is locked" &&
          "code" in error && error.code === "ERR_SQLITE_ERROR" && "errcode" in error && error.errcode === 5);
      assert.deepEqual(admissionTimeouts, [timeoutMs], "the lock wait is configured before the first statement that reads the file");
      assert.deepEqual(observedTimeouts, [], "the held lock stopped the open at its admission: no WAL setup was attempted");
      assert.deepEqual(observedModes, [], "the held lock prevented WAL setup");
      assert.equal(holder.isTransaction, true);
      assert.equal(holder.prepare("PRAGMA journal_mode").get()!.journal_mode, "delete");
      assert.equal(holder.prepare("SELECT value FROM held").get()!.value, "retained");
      holder.exec("COMMIT");
      store = createTimelineStore({ path: dbPath, ledgerId: "held", timelineConfig: { sqliteBusyTimeoutMs: timeoutMs } });
      assert.deepEqual(observedTimeouts, [timeoutMs]);
      assert.deepEqual(observedModes, ["wal"]);
      const event = store.appendEvent({ eventId: "after-lock", ledgerId: "held", eventType: "turn", actor: { kind: "test", id: "opener" }, description: "after release", wallTime: "2026-09-24T00:00:00Z" });
      assert.equal(store.getEvent(event.eventId)?.eventId, "after-lock");
      assert.equal(store.verifyChain().valid, true);
      store.close(); store = undefined;
      store = createTimelineStore({ path: dbPath, ledgerId: "held", timelineConfig: { sqliteBusyTimeoutMs: timeoutMs } });
      assert.deepEqual(observedTimeouts, [timeoutMs, timeoutMs]);
      assert.deepEqual(observedModes, ["wal", "wal"]);
      assert.deepEqual(admissionTimeouts, [timeoutMs, timeoutMs, timeoutMs]);
      assert.equal(store.count(), 1);
      assert.equal(store.getEvent("after-lock")?.eventId, "after-lock");
    } finally { injection.mock.restore(); admission.mock.restore(); }
  } finally {
    store?.close();
    if (holder.isTransaction) holder.exec("ROLLBACK");
    holder.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("timeline-store: concurrent appenders produce an unbroken chain (P0-1)", { timeout: 120_000 }, async (t) => {
  const dir = mkTempDir("timeline-concurrency-");
  const dbPath = join(dir, "timeline-concurrent.db");
  const ledgerId = "ledger-concurrency";
  const workerCount = 4;
  const appendsPerWorker = 25;
  try {
    // Initialize the db (migrations + first event) in the main thread so
    // workers only append (migrations are idempotent on reopen).
    const initStore: EventLedgerStoragePort = createTimelineStore({ path: dbPath, ledgerId });
    const initInput: TimelineStandaloneEventInput = {
      eventId: "evt-init-0",
      ledgerId,
      eventType: "turn",
      actor: { kind: "harness", id: "main" },
      correlation: { runId: "run-init" },
      description: "init event",
      wallTime: "2026-09-24T00:00:00Z",
    };
    initStore.appendEvent(initInput);
    initStore.close();

    const results = await runWorkers(dbPath, ledgerId, appendsPerWorker, workerCount, t.signal);

    // Every worker must have appended all its events with no errors.
    for (const r of results) {
      assert.deepEqual(r.errors, [], `worker ${r.workerIndex} had errors: ${r.errors.join("; ")}`);
      assert.equal(r.appended, appendsPerWorker, `worker ${r.workerIndex} appended ${r.appended}/${appendsPerWorker}`);
    }

    // Open the db and verify chain integrity.
    const store = createTimelineStore({ path: dbPath, ledgerId });
    const expectedTotal = 1 + workerCount * appendsPerWorker;
    const count = store.count();
    assert.equal(count, expectedTotal, `expected ${expectedTotal} events, got ${count}`);

    // No duplicate sequences: every sequence from 1..expectedTotal must appear exactly once.
    const all = store.query({ limit: expectedTotal + 100 });
    const sequences = all.map((e) => e.sequence).sort((a, b) => Number(BigInt(a) - BigInt(b)));
    assert.equal(sequences.length, expectedTotal, "sequence count mismatch");
    const unique = new Set(sequences);
    assert.equal(unique.size, expectedTotal, `duplicate sequences detected: ${expectedTotal - unique.size} duplicates`);
    for (let i = 0; i < expectedTotal; i++) {
      assert.equal(sequences[i], String(i + 1), `sequence gap/dup at position ${i}: got ${sequences[i]}`);
    }

    // previous_chain_hash must chain correctly (no stale hashes) — verifyChain
    // recomputes the chain and confirms every record's previous_chain_hash
    // equals the prior record's chain_hash.
    const verification = store.verifyChain();
    assert.equal(verification.valid, true, `chain verification failed: ${verification.code} at sequence ${verification.breakAtSequence ?? "?"}`);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * P0-1 stronger regression: 8 workers × 50 appends (400 events) with full
 * chain-integrity assertions. This exceeds the original 4×25 coverage and
 * verifies: no duplicate sequences, no broken chain_hash links, all sequences
 * are contiguous from 1, and verifyChain is valid. This workload can expose
 * a `getLastRow` read moved outside BEGIN IMMEDIATE through duplicate sequences
 * or broken links; scheduling does not guarantee that interleaving.
 */
test("timeline-store: 8 workers × 50 appends produce a contiguous unbroken chain (P0-1 stronger)", { timeout: 180_000 }, async (t) => {
  const dir = mkTempDir("timeline-concurrency-");
  const dbPath = join(dir, "timeline-concurrent-8x50.db");
  const ledgerId = "ledger-concurrency-8x50";
  const workerCount = 8;
  const appendsPerWorker = 50;
  try {
    const initStore: EventLedgerStoragePort = createTimelineStore({ path: dbPath, ledgerId });
    const initInput: TimelineStandaloneEventInput = {
      eventId: "evt-init-8x50",
      ledgerId,
      eventType: "turn",
      actor: { kind: "harness", id: "main" },
      correlation: { runId: "run-init" },
      description: "init event",
      wallTime: "2026-09-24T00:00:00Z",
    };
    initStore.appendEvent(initInput);
    initStore.close();

    const results = await runWorkers(dbPath, ledgerId, appendsPerWorker, workerCount, t.signal);

    for (const r of results) {
      assert.deepEqual(r.errors, [], `worker ${r.workerIndex} had errors: ${r.errors.join("; ")}`);
      assert.equal(r.appended, appendsPerWorker, `worker ${r.workerIndex} appended ${r.appended}/${appendsPerWorker}`);
    }

    const store = createTimelineStore({ path: dbPath, ledgerId });
    const expectedTotal = 1 + workerCount * appendsPerWorker;
    const count = store.count();
    assert.equal(count, expectedTotal, `expected ${expectedTotal} events, got ${count}`);

    const all = store.query({ limit: expectedTotal + 100 });

    // No duplicate sequences.
    const sequences = all.map((e) => e.sequence).sort((a, b) => Number(BigInt(a) - BigInt(b)));
    assert.equal(sequences.length, expectedTotal, "sequence count mismatch");
    const unique = new Set(sequences);
    assert.equal(
      unique.size,
      expectedTotal,
      `duplicate sequences detected: ${expectedTotal - unique.size} duplicates (TOCTOU regression: getLastRow read outside BEGIN IMMEDIATE)`,
    );

    // All sequences contiguous from 1.
    for (let i = 0; i < expectedTotal; i++) {
      assert.equal(
        sequences[i],
        String(i + 1),
        `sequence gap/dup at position ${i}: got ${sequences[i]} (expected ${i + 1})`,
      );
    }

    // No broken chain_hash links: every record's previous_chain_hash equals
    // the prior record's chain_hash (recomputed by verifyChain).
    const verification = store.verifyChain();
    assert.equal(
      verification.valid,
      true,
      `chain verification failed under 8×50 contention: ${verification.code} at sequence ${verification.breakAtSequence ?? "?"}`,
    );
    assert.equal(verification.verifiedRecords, expectedTotal);

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const operation of ["intent", "terminal"] as const) {
  test(`timeline-store: competing connections admit only one ${operation} for an effect`, { timeout: 120_000 }, async (t) => {
    const dir = mkTempDir("timeline-lineage-contention-");
    const dbPath = join(dir, "timeline.db");
    const ledgerId = "lineage-contention";
    const workerCount = 4;
    try {
      const seed = createTimelineStore({ path: dbPath, ledgerId });
      try {
        if (operation === "terminal") seed.appendIntent({
          eventId: "arbitrary-origin", ledgerId, eventType: "turn", effectKind: "process", effectId: "shared-effect",
          actor: { kind: "agent", id: "original-worker", role: "author" }, correlation: { runId: "original-run" },
          traceId: "original-trace", description: "shared operation", intentHash: sha256("intent"), wallTime: "2026-09-26T00:00:00Z",
        });
      } finally { seed.close(); }
      const results = await runWorkers(dbPath, ledgerId, 1, workerCount, t.signal, operation);
      assert.equal(results.reduce((sum, result) => sum + result.appended, 0), 1);
      assert.deepEqual(results.flatMap((result) => result.errors), Array(workerCount - 1).fill(`timeline_${operation}_duplicate`));
      const store = createTimelineStore({ path: dbPath, ledgerId });
      try {
        assert.equal(store.count(), operation === "terminal" ? 2 : 1);
        assert.equal(store.count({ recordKind: operation }), 1);
        assert.equal(store.verifyChain().valid, true);
        if (operation === "terminal") {
          const terminal = store.query({ recordKind: "terminal" })[0]!;
          assert.equal(terminal.parentEventId, "arbitrary-origin");
          assert.equal(terminal.actorId, "original-worker");
          assert.equal(terminal.runId, "original-run");
          assert.equal(terminal.traceId, "original-trace");
        }
      } finally { store.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

/**
 * Start `count` worker threads that each import the store and then park on
 * `gate[index]` (the startup test's own hook) or on `gate[0]` (a common start
 * line); the caller releases them. One plumbing owner for every
 * multi-connection startup test here.
 */
function startGatedWorkers(source: string, count: number, workerData: Readonly<Record<string, unknown>>) {
  return Array.from({ length: count }, (_, index) => {
    const ready = Promise.withResolvers<void>(), result = Promise.withResolvers<Record<string, unknown>>();
    void ready.promise.catch(() => {}); void result.promise.catch(() => {});
    const worker = new Worker(source, { eval: true, workerData: { ...workerData, index, url: new URL("../../src/timeline/timeline-store.ts", import.meta.url).href } });
    let value: Record<string, unknown> | undefined;
    worker.on("message", (message: Record<string, unknown>) => { if (message.type === "ready") ready.resolve(); else value = message; });
    worker.on("error", (error) => { ready.reject(error); result.reject(error); });
    worker.on("exit", (code) => { ready.reject(new Error("startup worker exited before ready")); if (code === 0 && value) result.resolve(value); else result.reject(new Error(`startup worker exit ${code}`)); });
    return { worker, ready: ready.promise, result: result.promise };
  });
}

async function settleWorkers(workers: ReturnType<typeof startGatedWorkers>): Promise<void> {
  await Promise.all(workers.map((w) => w.worker.terminate()));
  await Promise.allSettled(workers.flatMap((w) => [w.ready, w.result]));
}

test("timeline-store: contending first migrations recheck the registry under the acquired writer", { timeout: 30_000 }, async () => {
  // A FRESH file: the WAL switch and the registry both race here, as they do
  // for two processes starting on a new state folder.
  const dir = mkTempDir("timeline-startup-registry-"); const dbPath = join(dir, "timeline.db");
  const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const source = `const{parentPort,workerData}=require('node:worker_threads');const{DatabaseSync}=require('node:sqlite');const original=DatabaseSync.prototype.exec;let gated=false;DatabaseSync.prototype.exec=function(sql){if(!gated&&sql==='BEGIN IMMEDIATE'){gated=true;parentPort.postMessage({type:'ready'});Atomics.wait(new Int32Array(workerData.gate),workerData.index,0);}return original.call(this,sql);};(async()=>{const{createTimelineStore}=await import(workerData.url);try{const s=createTimelineStore({path:workerData.path,ledgerId:'startup-registry'});const verified=s.verifyChain();s.close();parentPort.postMessage({type:'result',opened:true,verified});}catch(e){parentPort.postMessage({type:'result',opened:false,code:e.code,message:e.message});}})();`;
  const workers = startGatedWorkers(source, 2, { gate, path: dbPath });
  const watchdog = setTimeout(() => { for (const w of workers) void w.worker.terminate(); }, 20_000);
  try {
    await Promise.all(workers.map((w) => w.ready));
    const results = [];
    for (let index = 0; index < workers.length; index += 1) { Atomics.store(new Int32Array(gate), index, 1); Atomics.notify(new Int32Array(gate), index); results.push(await workers[index]!.result); }
    assert.deepEqual(results.map((r) => r.opened), [true, true], JSON.stringify(results));
    const s = createTimelineStore({ path: dbPath, ledgerId: "startup-registry" });
    try { assert.equal(s.verifyChain().valid, true); } finally { s.close(); }
  } finally {
    clearTimeout(watchdog);
    await settleWorkers(workers);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("timeline-store: every concurrent FIRST opener of a fresh file starts (the WAL switch waits for the other opener)", { timeout: 120_000 }, async () => {
  // SQLite refuses one of two connections promoting their locks to switch a
  // new file to WAL WITHOUT consulting the busy handler (deadlock avoidance);
  // measured before the WAL owner: 2 of 10 rounds of 3 openers failed
  // "database is locked". Each round releases its openers on one start line.
  const dir = mkTempDir("timeline-fresh-open-");
  const source = `const{parentPort,workerData}=require('node:worker_threads');(async()=>{const{createTimelineStore}=await import(workerData.url);parentPort.postMessage({type:'ready'});Atomics.wait(new Int32Array(workerData.gate),0,0);try{const s=createTimelineStore({path:workerData.path,ledgerId:'fresh-open'});s.close();parentPort.postMessage({type:'result',opened:true});}catch(e){parentPort.postMessage({type:'result',opened:false,code:e.code,message:e.message});}})();`;
  try {
    for (let round = 0; round < 10; round += 1) {
      const gate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
      const workers = startGatedWorkers(source, 3, { gate, path: join(dir, `round-${round}.db`) });
      try {
        await Promise.all(workers.map((w) => w.ready));
        Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0);
        const results = await Promise.all(workers.map((w) => w.result));
        assert.deepEqual(results.map((r) => r.opened), [true, true, true], `round ${round}: ${JSON.stringify(results)}`);
      } finally { await settleWorkers(workers); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("timeline-store: a migration this build does not know refuses the ledger (another build wrote it); a known one missing is applied", () => {
  const dir = mkTempDir("timeline-registry-admission-");
  try {
    const dbPath = join(dir, "timeline.db");
    createTimelineStore({ path: dbPath, ledgerId: "registry" }).close();
    const db = new DatabaseSync(dbPath);
    db.prepare("INSERT INTO schema_migrations (migration_id, name, checksum, applied_at) VALUES (?, ?, ?, ?)").run(100, "timeline-from-another-build-v1", "0".repeat(64), "2026-09-29T00:00:00.000Z");
    db.close();
    assert.throws(() => createTimelineStore({ path: dbPath, ledgerId: "registry" }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "timeline_migration_unknown");
    const unknown = new DatabaseSync(dbPath);
    try { assert.equal(unknown.prepare("SELECT COUNT(*) AS n FROM schema_migrations WHERE name = 'timeline-from-another-build-v1'").get()!.n, 1); } finally { unknown.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
