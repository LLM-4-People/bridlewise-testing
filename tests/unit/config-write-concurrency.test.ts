// @vitest-environment node
/**
 * THE CONFIG WRITE CONCURRENCY PROOFS — the racing arms for the config
 * file's atomic-rename owner and its cross-process write lock.
 *
 * The suite forks of the web run write the REAL shared config in parallel,
 * and the measured failures were: torn reads (a truncating write caught
 * mid-flight by another fork's parse), lost updates (two unlocked
 * read-modify-write cycles interleaving so one restored the other's
 * mid-cycle bytes), and the residue that became the next run's "found"
 * bytes. These arms race the mechanisms that close the classes — the
 * write-temp-then-rename owner and the lockfile — against REAL concurrency:
 * worker threads for the reader storm, spawned child processes for the
 * cross-process proofs. No timing luck: the lost-update arm's children park
 * between their read and their write on a marker the parent controls, so
 * the interleave the lock exists to prevent is FORCED in the severed
 * state, not hoped for.
 *
 * Every arm drives a scratch config in this suite's own temp world — the
 * real shared config is never touched here.
 */
import { describe, test, expect, afterAll } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

import { createTempDir } from "../helpers/temp-dir.ts";
// The two mechanisms under proof: the atomic-rename write owner, and the
// config file's cross-process write lock.
import { atomicWriteFile } from "../../engine/src/filesystem/atomic-write.ts";
import { InputError } from "../../engine/src/kernel/errors.ts";
import {
  configWriteLockPath,
  withConfigWriteLock,
} from "../../engine/src/kernel/config-write-lock.ts";
import { FILE_LOCK_SCHEMA_VERSION } from "../../engine/src/filesystem/file-lock.ts";

const FIXTURE = fileURLToPath(new URL("../fixtures/config-write-lock-holder.ts", import.meta.url));

/** Children the suite spawned, killed at teardown if a failed arm wedged them. */
const childJobs: ChildProcess[] = [];

afterAll(() => {
  for (const child of childJobs) {
    if (child.exitCode === null) child.kill();
  }
});

/** A config-shaped document padded to `targetBytes` — big enough that a raw
 *  truncating write has a real open→encode→write window a reader can land
 *  inside (the real config is bounded by the policy size cap; the owner this
 *  suite proves is the generic file-replacement owner, driven here at a size
 *  where tearing is measurable). */
function bigConfig(generation: number, targetBytes: number): string {
  const padding = "x".repeat(Math.max(0, targetBytes));
  return `${JSON.stringify({ generation, padding }, null, 2)}\n`;
}

/**
 * A reader-storm worker: plain readFileSync + JSON.parse + a byte-length
 * check — the exact shape of the config's unlocked readers (`readConfigRaw`
 * and its kin). A read is TORN when its bytes are neither the old document
 * nor the new one (a truncation to zero, or a partially-written body).
 * Evaluated code, so it must be self-contained.
 */
const READER_WORKER_CODE = `
const fs = require("node:fs");
const { parentPort, workerData } = require("node:worker_threads");
const ints = new Int32Array(workerData.sab);
let ok = 0;
let torn = 0;
let firstTorn = "";
let announced = false;
while (Atomics.load(ints, 0) === 0) {
  let bytes;
  try {
    bytes = fs.readFileSync(workerData.configPath);
  } catch (error) {
    torn += 1;
    firstTorn = firstTorn || ("read error: " + error.code);
    continue;
  }
  if (!announced) {
    // LIVE before the storm is allowed to start: a reader that is still
    // booting while the writer finishes has proven nothing, and a fast
    // filesystem makes that race real (measured: a 200-write storm over
    // before the workers took their first read).
    announced = true;
    parentPort.postMessage({ kind: "live" });
  }
  if (bytes.length !== workerData.oldLen && bytes.length !== workerData.newLen) {
    torn += 1;
    firstTorn = firstTorn || ("length " + bytes.length + ", neither " + workerData.oldLen + " nor " + workerData.newLen);
    continue;
  }
  try {
    JSON.parse(bytes.toString("utf8"));
    ok += 1;
  } catch (error) {
    torn += 1;
    firstTorn = firstTorn || ("parse failure at length " + bytes.length);
  }
}
parentPort.postMessage({ kind: "result", ok, torn, firstTorn });
`;

interface ReaderResult {
  ok: number;
  torn: number;
  firstTorn: string;
}

/**
 * Reader workers for the storm. The returned pair: a promise for the final
 * counts (resolved when both workers post their results) and a promise that
 * resolves once every worker has completed its first live read — the gate
 * the writer's storm waits behind, so the storm cannot finish before the
 * readers exist.
 */
function startReaders(configPath: string, oldLen: number, newLen: number, sab: SharedArrayBuffer): Readonly<{
  results: Promise<ReaderResult[]>;
  live: Promise<readonly void[]>;
}> {
  const results: Array<Promise<ReaderResult>> = [];
  const live: Array<Promise<void>> = [];
  for (let i = 0; i < 2; i += 1) {
    const worker = new Worker(READER_WORKER_CODE, {
      eval: true,
      workerData: { configPath, oldLen, newLen, sab },
    });
    // ONE dispatching listener per worker: `once` would be consumed by the
    // first message of any kind, and the "live" announcement arrives before
    // the result — two `once` listeners would each eat the other's message.
    let resolveResult: (value: ReaderResult) => void = () => undefined;
    let resolveLive: () => void = () => undefined;
    results.push(new Promise<ReaderResult>((resolveJob, rejectJob) => {
      resolveResult = resolveJob;
      worker.once("error", rejectJob);
    }));
    live.push(new Promise<void>((resolveJob) => {
      resolveLive = resolveJob;
    }));
    worker.on("message", (message: { kind?: string } & ReaderResult) => {
      if (message.kind === "live") resolveLive();
      if (message.kind === "result") {
        resolveResult({ ok: message.ok, torn: message.torn, firstTorn: message.firstTorn });
      }
    });
  }
  return { results: Promise.all(results), live: Promise.all(live) };
}

function stopReaders(sab: SharedArrayBuffer): void {
  const ints = new Int32Array(sab);
  Atomics.store(ints, 0, 1);
  Atomics.notify(ints, 0, 2);
}

/** Spawn a fixture child and resolve once it prints `awaitLine`. */
function fixtureChildAwaiting(args: readonly string[], awaitLine: string): Promise<ChildProcess> {
  return new Promise((resolveJob, rejectJob) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", FIXTURE, ...args], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let seen = "";
    child.stdout.on("data", (chunk: Buffer) => {
      seen += chunk.toString("utf8");
      if (seen.includes(awaitLine)) resolveJob(child);
    });
    child.once("error", rejectJob);
    childJobs.push(child);
  });
}

describe("the atomic-rename owner under a reader storm — no reader ever sees torn bytes", () => {
  test("a writer alternating two documents cannot tear a read (workers race the whole storm)", async () => {
    const dir = createTempDir("config-torn-");
    const configPath = join(dir, "bridlewise.config.json");
    // 128 KiB documents: big enough that a raw truncating write has a real
    // open→encode window a reader can land inside, small enough that the
    // readers' parse stays cheap and they sample hundreds of reads per
    // storm — a storm that samples nothing proves nothing.
    const oldDoc = bigConfig(1, 128 * 1024);
    const newDoc = bigConfig(2, 128 * 1024 + 977);
    // Seed the file through the owner so the first read is a committed doc.
    expect(atomicWriteFile(configPath, oldDoc, { createMode: 0o600 }).success).toBe(true);
    const sab = new SharedArrayBuffer(16);
    const readers = startReaders(configPath, oldDoc.length, newDoc.length, sab);
    // The readers must be LIVE before the storm starts — on a fast
    // filesystem the writes can outrun the workers' boot.
    await readers.live;
    try {
      for (let i = 0; i < 800; i += 1) {
        expect(atomicWriteFile(configPath, i % 2 === 0 ? newDoc : oldDoc).success).toBe(true);
      }
    } finally {
      stopReaders(sab);
    }
    const results = await readers.results;
    const totalOk = results.reduce((sum, r) => sum + r.ok, 0);
    const totalTorn = results.reduce((sum, r) => sum + r.torn, 0);
    const firstTorn = results.map((r) => r.firstTorn).find((t) => t.length > 0) ?? "";
    expect(
      totalTorn,
      `a reader saw bytes that were neither the old document nor the new one (${firstTorn}) — ` +
        "the atomic rename is the only shape in which this can be zero",
    ).toBe(0);
    expect(totalOk, "the readers must actually have read — a storm that sampled nothing proves nothing").toBeGreaterThan(100);
    // The storm's end state is a fully committed document, at the mode the
    // owner guarantees for a config-shaped file.
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toHaveProperty("generation");
    expect((statSync(configPath).mode & 0o7777).toString(8)).toBe("600");
  }, 30_000);
});

describe("the config write lock across processes", () => {
  test("a locked read-modify-write cycle CANNOT interleave: both children's changes survive", async () => {
    const dir = createTempDir("config-lostupdate-");
    const configPath = join(dir, "bridlewise.config.json");
    const markerOne = join(dir, "go-one");
    const markerTwo = join(dir, "go-two");
    expect(atomicWriteFile(configPath, `${JSON.stringify({ lostUpdateCounter: 0 })}\n`, { createMode: 0o600 }).success).toBe(true);

    // Both children announce the base they read and park before writing —
    // the parent is the arbiter of who has read. With the lock working, the
    // second child's announcement can only arrive AFTER the first child's
    // whole cycle (it is locked out of its read until then); with the lock
    // severed, both announce the same base and one increment vanishes.
    const childOne = spawn(process.execPath, ["--experimental-strip-types", FIXTURE, "rmw", configPath, "lostUpdateCounter", markerOne], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const childTwo = spawn(process.execPath, ["--experimental-strip-types", FIXTURE, "rmw", configPath, "lostUpdateCounter", markerTwo], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    childJobs.push(childOne, childTwo);
    const stderrOf = (child: ChildProcess): string => {
      let text = "";
      if (child.stderr !== null) child.stderr.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
      });
      return text;
    };
    const stderrOne = stderrOf(childOne);
    const stderrTwo = stderrOf(childTwo);
    // The exit promises are taken AT SPAWN TIME: a child that exits while an
    // earlier await is pending has already emitted its close event, and a
    // listener attached afterwards would wait for an event that already
    // happened.
    const doneOf = (child: ChildProcess): Promise<void> => new Promise((resolveJob, rejectJob) => {
      child.once("close", (code) => {
        if (code === 0) resolveJob();
        else rejectJob(new Error(`rmw child exited ${String(code)}`));
      });
    });
    const doneOne = doneOf(childOne);
    const doneTwo = doneOf(childTwo);
    // The read channels are also attached AT SPAWN TIME, and the relay is
    // ORDER-INDEPENDENT: either child can win the acquire race, so the
    // parent must mark whoever announces first — a protocol that assumes a
    // specific child holds the lock first deadlocks the moment the other
    // one wins (measured).
    const readOf = (child: ChildProcess): Promise<number> => new Promise((resolveJob, rejectJob) => {
      let buffer = "";
      if (child.stdout === null) {
        rejectJob(new Error("rmw child has no stdout"));
        return;
      }
      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        const match = /READ (\d+)/.exec(buffer);
        if (match !== null) resolveJob(Number(match[1]));
      });
      child.once("error", rejectJob);
    });
    const readOne = readOf(childOne);
    const readTwo = readOf(childTwo);
    const first = await Promise.race([
      readOne.then((base) => ({ which: 1, base })),
      readTwo.then((base) => ({ which: 2, base })),
    ]) as { which: 1 | 2; base: number };
    // GO the announcing child once its read is announced.
    writeFileSync(first.which === 1 ? markerOne : markerTwo, "go");
    // The other child's read cannot be announced until the first child's
    // cycle is done (the lock holds it outside), so this await IS the
    // serialization the lock is being proven to provide.
    const secondBase = await (first.which === 1 ? readTwo : readOne);
    expect(secondBase, "the second cycle's read must see the first cycle's committed write").toBe(first.base + 1);
    writeFileSync(first.which === 1 ? markerTwo : markerOne, "go");
    await Promise.all([doneOne, doneTwo]);
    const finalDoc = JSON.parse(readFileSync(configPath, "utf8")) as { lostUpdateCounter: number };
    expect(
      finalDoc.lostUpdateCounter,
      `both increments must survive — a lost update is exactly one of them vanishing. ` +
        `bases read: ${String(first.base)}, ${String(secondBase)}; child stderr: [${stderrOne}] [${stderrTwo}]`,
    ).toBe(2);
  }, 20_000);

  test("a lock held by another PROCESS excludes this process until it releases", async () => {
    const dir = createTempDir("config-exclusion-");
    const configPath = join(dir, "bridlewise.config.json");
    await fixtureChildAwaiting(["hold", configPath, "400"], "HELD");
    const started = Date.now();
    let ranInside = false;
    withConfigWriteLock(configPath, () => {
      ranInside = true;
    });
    const waitedMs = Date.now() - started;
    expect(ranInside).toBe(true);
    expect(
      waitedMs,
      "the holder kept the lock for 400ms, so this acquire must have waited for it — an acquire that " +
        `returned immediately (${String(waitedMs)}ms) is not cross-process`,
    ).toBeGreaterThanOrEqual(350);
  }, 20_000);

  test("a stale lock from a dead holder is broken, not waited on", () => {
    const dir = createTempDir("config-stale-");
    const configPath = join(dir, "bridlewise.config.json");
    // A genuinely dead pid: a child that already exited.
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    expect(dead.status).toBe(0);
    expect(dead.pid).toBeTruthy();
    const lockPath = configWriteLockPath(configPath);
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, `${JSON.stringify({
      schemaVersion: FILE_LOCK_SCHEMA_VERSION,
      pid: dead.pid,
      // A record names its holder by pid AND start time (one without is no identity: unreadable until the bound).
      startTime: 1,
      acquiredAt: new Date().toISOString(),
      nonce: "planted-stale",
    })}\n`, { mode: 0o600 });
    expect(existsSync(lockPath)).toBe(true);
    const started = Date.now();
    let ranInside = false;
    withConfigWriteLock(configPath, () => {
      ranInside = true;
    });
    expect(ranInside).toBe(true);
    // Far under the policy timeout: the stale break is immediate, where the
    // wait for a live holder would have been the full timeout.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(existsSync(lockPath), "a released lock leaves no file behind").toBe(false);
  });

  test("a lock whose holder's pid was RECYCLED (live pid, another start time) is broken, not waited on", () => {
    // The one owner-liveness rule (engine/src/filesystem/private-state.ts):
    // pid alone judged a later process the holder and waited out the timeout.
    const dir = createTempDir("config-recycled-");
    const configPath = join(dir, "bridlewise.config.json");
    const lockPath = configWriteLockPath(configPath);
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, `${JSON.stringify({
      schemaVersion: FILE_LOCK_SCHEMA_VERSION,
      pid: 1,
      startTime: 1,
      acquiredAt: new Date().toISOString(),
      nonce: "planted-recycled",
    })}\n`, { mode: 0o600 });
    const started = Date.now();
    let ranInside = false;
    withConfigWriteLock(configPath, () => {
      ranInside = true;
    });
    expect(ranInside).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("the lock is re-entrant within one process — the gate writes inside a held cycle without deadlocking", () => {
    const dir = createTempDir("config-reentrant-");
    const configPath = join(dir, "bridlewise.config.json");
    expect(atomicWriteFile(configPath, "{}\n", { createMode: 0o600 }).success).toBe(true);
    const answer = withConfigWriteLock(configPath, () => withConfigWriteLock(configPath, () => 41) + 1);
    expect(answer).toBe(42);
    expect(existsSync(configWriteLockPath(configPath)), "both holds released with the outermost one").toBe(false);
  });

  test("a released hold leaves no lock file, no staging file and no stale copy", () => {
    const dir = createTempDir("config-lock-hygiene-");
    const configPath = join(dir, "bridlewise.config.json");
    const lockDir = join(dir, ".bridlewise");
    withConfigWriteLock(configPath, () => {
      expect(existsSync(configWriteLockPath(configPath))).toBe(true);
    });
    expect(existsSync(configWriteLockPath(configPath))).toBe(false);
    const leftovers = existsSync(lockDir) ? readdirSync(lockDir) : [];
    expect(
      leftovers.filter((name) => name.includes(".staging") || name.includes(".stale")),
      "the lock directory must not accumulate staging or stale-break litter",
    ).toEqual([]);

    const baselineListeners = process.listeners("exit");
    const otherPath = join(dir, "other.json");
    const refusal = new InputError("held callback refused", "held_callback_refused");
    for (let cycle = 0; cycle < process.getMaxListeners() * 10; cycle++) {
      withConfigWriteLock(configPath, () => {
        expect(process.listenerCount("exit"), "one cleanup serves all currently held locks").toBe(baselineListeners.length + 1);
        withConfigWriteLock(configPath, () => {
          withConfigWriteLock(otherPath, () => {
            expect(process.listenerCount("exit"), "distinct and reentrant holds share cleanup").toBe(baselineListeners.length + 1);
          });
          expect(process.listenerCount("exit"), "releasing a distinct lock keeps the outer cleanup").toBe(baselineListeners.length + 1);
        });
        expect(existsSync(configWriteLockPath(configPath))).toBe(true);
      });
      expect(process.listeners("exit"), "released cycles retain no exit cleanup handlers").toEqual(baselineListeners);
    }
    let callbackFailure: unknown;
    try { withConfigWriteLock(configPath, () => { throw refusal; }); }
    catch (error) { callbackFailure = error; }
    expect(callbackFailure).toBe(refusal);
    expect(callbackFailure).toMatchObject({ code: "held_callback_refused" });
    expect(process.listeners("exit"), "throwing callbacks release their cleanup handler").toEqual(baselineListeners);
    expect(existsSync(configWriteLockPath(configPath))).toBe(false);

    expect(atomicWriteFile(configPath, "{}").success).toBe(true);
    let acquisitionFailure: unknown;
    try { withConfigWriteLock(join(configPath, "impossible.json"), () => { throw refusal; }); }
    catch (error) { acquisitionFailure = error; }
    expect(acquisitionFailure).toBeInstanceOf(Error);
    expect(acquisitionFailure).toMatchObject({ code: "ENOTDIR" });
    expect(process.listeners("exit"), "failed acquisition owns no exit handler").toEqual(baselineListeners);

    const lockPath = configWriteLockPath(configPath);
    let replacement = "";
    withConfigWriteLock(configPath, () => {
      const held = JSON.parse(readFileSync(lockPath, "utf8"));
      replacement = JSON.stringify({ ...held, nonce: `${held.nonce}-replacement` });
      writeFileSync(lockPath, replacement);
    });
    try {
      expect(readFileSync(lockPath, "utf8"), "release preserves a replacement owner's lock").toBe(replacement);
      expect(process.listeners("exit"), "losing file ownership still retires the local cleanup").toEqual(baselineListeners);
    } finally { unlinkSync(lockPath); }

    const child = spawnSync(process.execPath, ["--experimental-strip-types", FIXTURE, "exit", configPath, otherPath], { encoding: "utf8" });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toContain("HELD AT EXIT");
    expect([configPath, otherPath].filter(path => existsSync(configWriteLockPath(path))), "process exit releases every owned lock").toEqual([]);
  });
});
