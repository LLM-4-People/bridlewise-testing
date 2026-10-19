import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, statSync, symlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { isProcessAlive } from "../../src/process/process-facts.ts";

import {
  acquireLock,
  withLock,
  validateResourceName,
  lockPathFor,
  LOCK_FILE_MODE,
  LOCK_DIR_MODE,
  RESOURCE_NAME_PATTERN,
  LockAcquisitionTimeout,
  lockedResources,
  type ResourceLockHandle,
} from "../../src/workflow/resource-lock.ts";
import { DEFAULT_LOCK_DIRECTORY, DEFAULT_LOCK_TIMEOUT_MS, DEFAULT_LOCK_POLL_INTERVAL_MS, DEFAULT_LOCK_STALE_MS } from "../../src/workflow/workflow-config.ts";
import { FILE_LOCK_SCHEMA_VERSION, type FileLockContent } from "../../src/filesystem/file-lock.ts";
import { processIdentity } from "../../src/process/process-facts.ts";
import { createTempDir } from "../support/temp-dir.ts";

/** A lock record as the one file lock writes it (a resource lock is that lock). */
function plantedRecord(pid: number, acquiredAt: string, startTime: number = processIdentity(pid).startTime ?? 1): string {
  const record: FileLockContent = { schemaVersion: FILE_LOCK_SCHEMA_VERSION, pid, startTime, acquiredAt, nonce: `planted-${String(pid)}`, holder: "a planted holder", adopted: [] };
  return `${JSON.stringify(record)}\n`;
}

function makeTmpDir(prefix: string): string {
  return createTempDir(`resource-lock-${prefix}-`);
}

function withTmpDir<T>(prefix: string, fn: (dir: string) => T | Promise<T>): T | Promise<T> {
  const dir = makeTmpDir(prefix);
  return Promise.resolve(fn(dir)).finally(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// validateResourceName
// ---------------------------------------------------------------------------

test("validateResourceName: accepts simple lowercase name", () => {
  assert.doesNotThrow(() => validateResourceName("test"));
});

test("validateResourceName: accepts name with digits", () => {
  assert.doesNotThrow(() => validateResourceName("test123"));
});

test("validateResourceName: accepts name with dots", () => {
  assert.doesNotThrow(() => validateResourceName("test.lock"));
});

test("validateResourceName: accepts name with dashes", () => {
  assert.doesNotThrow(() => validateResourceName("test-lock"));
});

test("validateResourceName: accepts name with underscores", () => {
  assert.doesNotThrow(() => validateResourceName("test_lock"));
});

test("validateResourceName: accepts single char digit", () => {
  assert.doesNotThrow(() => validateResourceName("1"));
});

test("validateResourceName: accepts single char letter", () => {
  assert.doesNotThrow(() => validateResourceName("a"));
});

test("validateResourceName: rejects empty string", () => {
  assert.throws(() => validateResourceName(""), /non-empty/);
});

test("validateResourceName: rejects non-string", () => {
  assert.throws(() => validateResourceName(42 as unknown as string), /non-empty/);
  assert.throws(() => validateResourceName(null as unknown as string), /non-empty/);
  assert.throws(() => validateResourceName(undefined as unknown as string), /non-empty/);
});

test("validateResourceName: rejects uppercase letters", () => {
  assert.throws(() => validateResourceName("Test"), /invalid/);
  assert.throws(() => validateResourceName("TEST"), /invalid/);
});

test("validateResourceName: rejects path separators", () => {
  assert.throws(() => validateResourceName("test/path"), /invalid/);
  assert.throws(() => validateResourceName("test\\path"), /invalid/);
  assert.throws(() => validateResourceName("a/b"), /invalid/);
});

test("validateResourceName: rejects path traversal", () => {
  assert.throws(() => validateResourceName(".."), /invalid/);
  assert.throws(() => validateResourceName("../etc"), /invalid/);
});

test("validateResourceName: rejects names starting with dot", () => {
  assert.throws(() => validateResourceName(".test"), /invalid/);
  assert.throws(() => validateResourceName(".hidden"), /invalid/);
});

test("validateResourceName: rejects names starting with dash", () => {
  assert.throws(() => validateResourceName("-test"), /invalid/);
});

test("validateResourceName: rejects names starting with underscore", () => {
  assert.throws(() => validateResourceName("_test"), /invalid/);
});

test("validateResourceName: rejects names with spaces", () => {
  assert.throws(() => validateResourceName("test lock"), /invalid/);
});

test("validateResourceName: rejects names with special chars", () => {
  assert.throws(() => validateResourceName("test!"), /invalid/);
  assert.throws(() => validateResourceName("test@lock"), /invalid/);
  assert.throws(() => validateResourceName("test#"), /invalid/);
  assert.throws(() => validateResourceName("test$"), /invalid/);
  assert.throws(() => validateResourceName("test%"), /invalid/);
  assert.throws(() => validateResourceName("test&"), /invalid/);
});

test("validateResourceName: rejects names exceeding 128 chars", () => {
  const long = "a".repeat(129);
  assert.throws(() => validateResourceName(long), /128/);
});

test("validateResourceName: accepts name of exactly 128 chars", () => {
  const exact = "a".repeat(128);
  assert.doesNotThrow(() => validateResourceName(exact));
});

test("RESOURCE_NAME_PATTERN: matches valid names", () => {
  assert.ok(RESOURCE_NAME_PATTERN.test("test"));
  assert.ok(RESOURCE_NAME_PATTERN.test("a1.b2-c3_d4"));
});

test("RESOURCE_NAME_PATTERN: rejects invalid names", () => {
  assert.ok(!RESOURCE_NAME_PATTERN.test(""));
  assert.ok(!RESOURCE_NAME_PATTERN.test("Test"));
  assert.ok(!RESOURCE_NAME_PATTERN.test(".test"));
  assert.ok(!RESOURCE_NAME_PATTERN.test("test/path"));
});

// ---------------------------------------------------------------------------
// lockPathFor
// ---------------------------------------------------------------------------

test("lockPathFor: returns path in default lock directory", () => {
  const path = lockPathFor("/root", "test");
  assert.ok(path.includes("test.lock"));
  assert.ok(path.includes(DEFAULT_LOCK_DIRECTORY));
});

test("lockPathFor: accepts custom lock directory", () => {
  const path = lockPathFor("/root", "test", ".custom/locks");
  assert.ok(path.includes(".custom/locks"));
  assert.ok(path.endsWith("test.lock"));
});

test("lockPathFor: accepts absolute lock directory", () => {
  const path = lockPathFor("/root", "test", "/abs/locks");
  assert.ok(path.startsWith("/abs/locks/"));
  assert.ok(path.endsWith("test.lock"));
});

test("lockPathFor: different resources produce different paths", () => {
  const p1 = lockPathFor("/root", "test");
  const p2 = lockPathFor("/root", "build");
  assert.notEqual(p1, p2);
});

test("lockPathFor: same resource produces same path", () => {
  const p1 = lockPathFor("/root", "test");
  const p2 = lockPathFor("/root", "test");
  assert.equal(p1, p2);
});

test("lockPathFor: rejects empty root", () => {
  assert.throws(() => lockPathFor("", "test"), /root must be/);
});

test("lockPathFor: rejects invalid resource", () => {
  assert.throws(() => lockPathFor("/root", ""), /non-empty/);
  assert.throws(() => lockPathFor("/root", "TEST"), /invalid/);
});

// ---------------------------------------------------------------------------
// isProcessAlive
// ---------------------------------------------------------------------------

test("isProcessAlive: current process is alive", () => {
  assert.equal(isProcessAlive(process.pid), true);
});

test("isProcessAlive: pid 0 returns false", () => {
  assert.equal(isProcessAlive(0), false);
});

test("isProcessAlive: negative pid returns false", () => {
  assert.equal(isProcessAlive(-1), false);
});

test("isProcessAlive: very large unlikely pid returns false", () => {
  assert.equal(isProcessAlive(9999999), false);
});

test("isProcessAlive: NaN returns false", () => {
  assert.equal(isProcessAlive(NaN), false);
});

test("isProcessAlive: Infinity returns false", () => {
  assert.equal(isProcessAlive(Infinity), false);
});

test("isProcessAlive: string pid returns false", () => {
  assert.equal(isProcessAlive("1" as unknown as number), false);
});

// ---------------------------------------------------------------------------
// acquireLock basic
// ---------------------------------------------------------------------------

test("acquireLock: acquires and creates lock file", async () => {
  await withTmpDir("acquire-basic", async (dir) => {
    const handle = await acquireLock(dir, "test");
    assert.ok(existsSync(handle.lockPath));
    assert.equal(handle.resource, "test");
    assert.equal(handle.pid, process.pid);
    handle.release();
  });
});

test("lockedResources: the resources locked in a directory now, by prefix, sorted; a released lock and a foreign file are not listed; no directory lists none", async () => {
  await withTmpDir("locked-resources", async (dir) => {
    const lockDirectory = join(dir, DEFAULT_LOCK_DIRECTORY);
    assert.deepEqual(lockedResources(lockDirectory), []);
    const b = await acquireLock(dir, "promotion-b");
    const a = await acquireLock(dir, "promotion-a");
    const other = await acquireLock(dir, "workspace");
    const released = await acquireLock(dir, "promotion-c");
    released.release();
    writeFileSync(join(lockDirectory, "promotion-notes.txt"), "not a lock\n");
    assert.deepEqual(lockedResources(lockDirectory, "promotion-"), ["promotion-a", "promotion-b"]);
    assert.deepEqual(lockedResources(lockDirectory), ["promotion-a", "promotion-b", "workspace"]);
    for (const handle of [a, b, other]) handle.release();
    assert.deepEqual(lockedResources(lockDirectory), []);
  });
});

test("acquireLock: lock file contains valid JSON", async () => {
  await withTmpDir("acquire-content", async (dir) => {
    const handle = await acquireLock(dir, "test");
    const content = readFileSync(handle.lockPath, "utf8");
    const parsed = JSON.parse(content);
    assert.equal(parsed.schemaVersion, FILE_LOCK_SCHEMA_VERSION);
    assert.equal(parsed.pid, process.pid);
    handle.release();
  });
});

test("acquireLock: lock file content is one record with a newline", async () => {
  await withTmpDir("acquire-canonical", async (dir) => {
    const handle = await acquireLock(dir, "test");
    const content = readFileSync(handle.lockPath, "utf8");
    assert.ok(content.endsWith("\n"));
    handle.release();
  });
});

test("acquireLock: lock file has mode 0o600", async () => {
  await withTmpDir("acquire-mode", async (dir) => {
    const handle = await acquireLock(dir, "test");
    const stat = statSync(handle.lockPath);
    assert.equal(stat.mode & 0o777, LOCK_FILE_MODE);
    handle.release();
  });
});

test("acquireLock: lock directory has mode 0o700", async () => {
  await withTmpDir("acquire-dirmode", async (dir) => {
    const handle = await acquireLock(dir, "test");
    const dirPath = handle.lockPath.slice(0, handle.lockPath.lastIndexOf("/"));
    const stat = statSync(dirPath);
    assert.equal(stat.mode & 0o777, LOCK_DIR_MODE);
    handle.release();
  });
});

test("acquireLock: creates lock directory if missing", async () => {
  await withTmpDir("acquire-mkdir", async (dir) => {
    const handle = await acquireLock(dir, "test");
    assert.ok(existsSync(handle.lockPath));
    handle.release();
  });
});

test("acquireLock: handle is frozen", async () => {
  await withTmpDir("acquire-frozen", async (dir) => {
    const handle = await acquireLock(dir, "test");
    assert.ok(Object.isFrozen(handle));
    handle.release();
  });
});

test("acquireLock: acquiredAt is valid ISO string", async () => {
  await withTmpDir("acquire-ts", async (dir) => {
    const handle = await acquireLock(dir, "test");
    const parsed = new Date(handle.acquiredAt);
    assert.ok(!Number.isNaN(parsed.getTime()));
    handle.release();
  });
});

test("acquireLock: owner is recorded in handle", async () => {
  await withTmpDir("acquire-owner", async (dir) => {
    const handle = await acquireLock(dir, "test", { owner: "agent-xyz" });
    assert.equal(handle.owner, "agent-xyz");
    handle.release();
  });
});

test("acquireLock: owner defaults to null", async () => {
  await withTmpDir("acquire-no-owner", async (dir) => {
    const handle = await acquireLock(dir, "test");
    assert.equal(handle.owner, null);
    handle.release();
  });
});

test("acquireLock: rejects empty root", async () => {
  await assert.rejects(() => acquireLock("", "test"), /root must be/);
});

test("acquireLock: rejects invalid resource", async () => {
  await assert.rejects(() => acquireLock("/tmp", ""), /non-empty/);
  await assert.rejects(() => acquireLock("/tmp", "TEST"), /invalid/);
  await assert.rejects(() => acquireLock("/tmp", "a/b"), /invalid/);
});

test("acquireLock: custom lock directory", async () => {
  await withTmpDir("acquire-customdir", async (dir) => {
    const handle = await acquireLock(dir, "test", { lockDirectory: ".custom/locks" });
    assert.ok(handle.lockPath.includes(".custom/locks"));
    assert.ok(existsSync(handle.lockPath));
    handle.release();
  });
});

test("acquireLock: absolute lock directory", async () => {
  await withTmpDir("acquire-absdir", async (dir) => {
    const absDir = join(dir, "abs-locks");
    const handle = await acquireLock(dir, "test", { lockDirectory: absDir });
    assert.ok(handle.lockPath.startsWith(absDir));
    handle.release();
  });
});

// ---------------------------------------------------------------------------
// handle.release
// ---------------------------------------------------------------------------

test("handle.release: removes the lock file", async () => {
  await withTmpDir("handle-release", async (dir) => {
    const handle = await acquireLock(dir, "test");
    handle.release();
    assert.ok(!existsSync(handle.lockPath));
  });
});

test("handle.release: is idempotent", async () => {
  await withTmpDir("handle-release-idem", async (dir) => {
    const handle = await acquireLock(dir, "test");
    handle.release();
    handle.release();
    handle.release();
    assert.ok(!existsSync(handle.lockPath));
  });
});

test("handle.release: works with custom lock directory", async () => {
  await withTmpDir("handle-release-custom", async (dir) => {
    const handle = await acquireLock(dir, "test", { lockDirectory: ".custom/locks" });
    handle.release();
    assert.ok(!existsSync(handle.lockPath));
  });
});

// ---------------------------------------------------------------------------
// withLock
// ---------------------------------------------------------------------------

test("withLock: runs function and releases lock", async () => {
  await withTmpDir("withlock-basic", async (dir) => {
    const result = await withLock(dir, "test", async () => 42);
    assert.equal(result, 42);
    assert.ok(!existsSync(lockPathFor(dir, "test")));
  });
});

test("withLock: releases lock even when function throws", async () => {
  await withTmpDir("withlock-throw", async (dir) => {
    await assert.rejects(
      () => withLock(dir, "test", async () => { throw new Error("boom"); }),
      /boom/,
    );
    assert.ok(!existsSync(lockPathFor(dir, "test")));
  });
});

test("withLock: returns function result", async () => {
  await withTmpDir("withlock-return", async (dir) => {
    const result = await withLock(dir, "test", async () => "hello");
    assert.equal(result, "hello");
  });
});

test("withLock: returns object result", async () => {
  await withTmpDir("withlock-obj", async (dir) => {
    const result = await withLock(dir, "test", async () => ({ a: 1, b: 2 }));
    assert.deepEqual(result, { a: 1, b: 2 });
  });
});

test("withLock: lock is held during function execution", async () => {
  await withTmpDir("withlock-held", async (dir) => {
    let observed = false;
    await withLock(dir, "test", async () => {
      observed = existsSync(lockPathFor(dir, "test"));
    });
    assert.equal(observed, true);
  });
});

test("withLock: lock is released after function completes", async () => {
  await withTmpDir("withlock-released", async (dir) => {
    await withLock(dir, "test", async () => 1);
    assert.ok(!existsSync(lockPathFor(dir, "test")));
  });
});

test("withLock: can re-acquire after release", async () => {
  await withTmpDir("withlock-reacquire", async (dir) => {
    await withLock(dir, "test", async () => 1);
    await withLock(dir, "test", async () => 2);
    assert.ok(!existsSync(lockPathFor(dir, "test")));
  });
});

test("withLock: passes owner option", async () => {
  await withTmpDir("withlock-owner", async (dir) => {
    await withLock(dir, "test", async () => 1, { owner: "my-agent" });
    assert.ok(!existsSync(lockPathFor(dir, "test")));
  });
});

test("withLock: async function with await inside", async () => {
  await withTmpDir("withlock-await", async (dir) => {
    const result = await withLock(dir, "test", async () => {
      await sleep(10);
      return "done";
    });
    assert.equal(result, "done");
    assert.ok(!existsSync(lockPathFor(dir, "test")));
  });
});

// ---------------------------------------------------------------------------
// Contention
// ---------------------------------------------------------------------------

test("acquireLock: second acquire waits then succeeds after release", async () => {
  await withTmpDir("contention-wait", async (dir) => {
    const handle1 = await acquireLock(dir, "test", { pollIntervalMs: 10 });
    let secondAcquired = false;
    const p2 = acquireLock(dir, "test", { pollIntervalMs: 10, timeoutMs: 5000 }).then((h) => {
      secondAcquired = true;
      h.release();
    });
    assert.equal(secondAcquired, false);
    handle1.release();
    await p2;
    assert.equal(secondAcquired, true);
  });
});

test("acquireLock: second acquire times out when lock is held", async () => {
  await withTmpDir("contention-timeout", async (dir) => {
    const handle1 = await acquireLock(dir, "test", { pollIntervalMs: 10 });
    await assert.rejects(
      () => acquireLock(dir, "test", { pollIntervalMs: 10, timeoutMs: 50 }),
      (err: Error) => err instanceof LockAcquisitionTimeout,
    );
    handle1.release();
  });
});

test("acquireLock: timeout=0 with free lock succeeds immediately", async () => {
  await withTmpDir("contention-zero-free", async (dir) => {
    const handle = await acquireLock(dir, "test", { timeoutMs: 0 });
    assert.ok(existsSync(handle.lockPath));
    handle.release();
  });
});

test("acquireLock: timeout=0 with held lock fails immediately", async () => {
  await withTmpDir("contention-zero-held", async (dir) => {
    const handle1 = await acquireLock(dir, "test");
    await assert.rejects(
      () => acquireLock(dir, "test", { timeoutMs: 0 }),
      (err: Error) => err instanceof LockAcquisitionTimeout,
    );
    handle1.release();
  });
});

test("LockAcquisitionTimeout: has correct code and is retryable", () => {
  const err = new LockAcquisitionTimeout("test", 100);
  assert.equal(err.code, "lock_acquisition_timeout");
  assert.equal(err.retryable, true);
  assert.ok(err.message.includes("test"));
  assert.ok(err.message.includes("100"));
});

test("LockAcquisitionTimeout: safeDetails has resource and timeout", () => {
  const err = new LockAcquisitionTimeout("build", 5000);
  assert.equal(err.safeDetails.resource, "build");
  assert.equal(err.safeDetails.timeoutMs, 5000);
});

// ---------------------------------------------------------------------------
// Stale lock reclamation
// ---------------------------------------------------------------------------

test("acquireLock: reclaims stale lock with dead pid", async () => {
  await withTmpDir("stale-dead-pid", async (dir) => {
    const lockDir = join(dir, DEFAULT_LOCK_DIRECTORY);
    mkdirSync(lockDir, { recursive: true, mode: LOCK_DIR_MODE });
    const lockPath = join(lockDir, "test.lock");
    writeFileSync(lockPath, plantedRecord(9999999, new Date().toISOString()), { mode: LOCK_FILE_MODE });
    const handle = await acquireLock(dir, "test", { pollIntervalMs: 10, timeoutMs: 5000 });
    assert.ok(existsSync(handle.lockPath));
    assert.equal(handle.pid, process.pid);
    handle.release();
  });
});

test("acquireLock: NEVER breaks a live holder, however old its lock (merge-door-final J9) — the waiter times out naming it", async () => {
  // wf-del2-design D1: an age bound used to break a live holder (300 s here).
  await withTmpDir("live-old", async (dir) => {
    const lockDir = join(dir, DEFAULT_LOCK_DIRECTORY);
    mkdirSync(lockDir, { recursive: true, mode: LOCK_DIR_MODE });
    const lockPath = join(lockDir, "test.lock");
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 60000)"], { stdio: "ignore" });
    try {
      const planted = plantedRecord(holder.pid!, new Date(Date.now() - 3_600_000).toISOString());
      writeFileSync(lockPath, planted, { mode: LOCK_FILE_MODE });
      const hourAgo = (Date.now() - 3_600_000) / 1000;
      utimesSync(lockPath, hourAgo, hourAgo);
      await assert.rejects(
        () => acquireLock(dir, "test", { unreadableAfterMs: 1, pollIntervalMs: 10, timeoutMs: 200 }),
        (err: Error) => err instanceof LockAcquisitionTimeout && err.message.includes(`pid ${String(holder.pid)}`),
      );
      assert.equal(readFileSync(lockPath, "utf8"), planted, "the live holder's lock was broken");
    } finally {
      holder.kill("SIGKILL");
    }
  });
});

test("acquireLock: reclaims corrupt old lock", async () => {
  await withTmpDir("stale-corrupt-old", async (dir) => {
    const lockDir = join(dir, DEFAULT_LOCK_DIRECTORY);
    mkdirSync(lockDir, { recursive: true, mode: LOCK_DIR_MODE });
    const lockPath = join(lockDir, "test.lock");
    writeFileSync(lockPath, "corrupt garbage", { mode: LOCK_FILE_MODE });
    await sleep(20);
    const handle = await acquireLock(dir, "test", { unreadableAfterMs: 10, pollIntervalMs: 10, timeoutMs: 5000 });
    assert.ok(existsSync(handle.lockPath));
    handle.release();
  });
});

test("acquireLock: waits for fresh corrupt lock (does not reclaim immediately)", async () => {
  await withTmpDir("stale-fresh-corrupt", async (dir) => {
    const lockDir = join(dir, DEFAULT_LOCK_DIRECTORY);
    mkdirSync(lockDir, { recursive: true, mode: LOCK_DIR_MODE });
    const lockPath = join(lockDir, "test.lock");
    writeFileSync(lockPath, "corrupt", { mode: LOCK_FILE_MODE });
    await assert.rejects(
      () => acquireLock(dir, "test", { unreadableAfterMs: 60_000, pollIntervalMs: 10, timeoutMs: 50 }),
      (err: Error) => err instanceof LockAcquisitionTimeout,
    );
    assert.ok(existsSync(lockPath));
  });
});

// ---------------------------------------------------------------------------
// Multiple resources
// ---------------------------------------------------------------------------

test("acquireLock: different resources are independent", async () => {
  await withTmpDir("multi-independent", async (dir) => {
    const h1 = await acquireLock(dir, "test");
    const h2 = await acquireLock(dir, "build");
    assert.ok(existsSync(h1.lockPath));
    assert.ok(existsSync(h2.lockPath));
    assert.notEqual(h1.lockPath, h2.lockPath);
    h1.release();
    h2.release();
  });
});

test("acquireLock: 10 different resources acquired simultaneously", async () => {
  await withTmpDir("multi-ten", async (dir) => {
    const handles: ResourceLockHandle[] = [];
    for (let i = 0; i < 10; i++) {
      handles.push(await acquireLock(dir, `res-${i}`));
    }
    for (const h of handles) {
      assert.ok(existsSync(h.lockPath));
    }
    for (const h of handles) {
      h.release();
    }
    for (let i = 0; i < 10; i++) {
      assert.ok(!existsSync(lockPathFor(dir, `res-${i}`)));
    }
  });
});

test("acquireLock: sequential acquire-release-acquire same resource", async () => {
  await withTmpDir("seq-ara", async (dir) => {
    for (let i = 0; i < 5; i++) {
      const handle = await acquireLock(dir, "test");
      handle.release();
      assert.ok(!existsSync(lockPathFor(dir, "test")));
    }
  });
});

test("withLock: 10 sequential uses of same resource", async () => {
  await withTmpDir("seq-ten", async (dir) => {
    for (let i = 0; i < 10; i++) {
      await withLock(dir, "test", async () => i);
    }
    assert.ok(!existsSync(lockPathFor(dir, "test")));
  });
});

// ---------------------------------------------------------------------------
// Options validation
// ---------------------------------------------------------------------------

test("acquireLock: rejects negative timeoutMs", async () => {
  await withTmpDir("opt-neg-timeout", async (dir) => {
    await assert.rejects(() => acquireLock(dir, "test", { timeoutMs: -1 }), (error: unknown) => (error as { code?: string }).code === "workflow_option_invalid" && /timeoutMs must be a non-negative/u.test((error as Error).message));
  });
});

test("acquireLock: rejects NaN timeoutMs", async () => {
  await withTmpDir("opt-nan-timeout", async (dir) => {
    await assert.rejects(() => acquireLock(dir, "test", { timeoutMs: NaN }), /non-negative/);
  });
});

test("acquireLock: rejects Infinity timeoutMs", async () => {
  await withTmpDir("opt-inf-timeout", async (dir) => {
    await assert.rejects(() => acquireLock(dir, "test", { timeoutMs: Infinity }), /non-negative/);
  });
});

test("acquireLock: rejects zero pollIntervalMs", async () => {
  await withTmpDir("opt-zero-poll", async (dir) => {
    await assert.rejects(() => acquireLock(dir, "test", { pollIntervalMs: 0 }), /positive/);
  });
});

test("acquireLock: rejects negative pollIntervalMs", async () => {
  await withTmpDir("opt-neg-poll", async (dir) => {
    await assert.rejects(() => acquireLock(dir, "test", { pollIntervalMs: -1 }), /positive/);
  });
});

test("acquireLock: rejects zero unreadableAfterMs", async () => {
  await withTmpDir("opt-zero-stale", async (dir) => {
    await assert.rejects(() => acquireLock(dir, "test", { unreadableAfterMs: 0 }), /positive/);
  });
});

test("acquireLock: accepts explicit defaults", async () => {
  await withTmpDir("opt-defaults", async (dir) => {
    const handle = await acquireLock(dir, "test", {
      timeoutMs: DEFAULT_LOCK_TIMEOUT_MS,
      pollIntervalMs: DEFAULT_LOCK_POLL_INTERVAL_MS,
      unreadableAfterMs: DEFAULT_LOCK_STALE_MS,
    });
    handle.release();
  });
});

// ---------------------------------------------------------------------------
// Hostile / edge cases
// ---------------------------------------------------------------------------

test("acquireLock: rejects resource with path traversal dots", async () => {
  await withTmpDir("hostile-traversal", async (dir) => {
    await assert.rejects(() => acquireLock(dir, ".."), /invalid/);
    await assert.rejects(() => acquireLock(dir, "../etc"), /invalid/);
  });
});

test("acquireLock: rejects resource with slash", async () => {
  await withTmpDir("hostile-slash", async (dir) => {
    await assert.rejects(() => acquireLock(dir, "a/b"), /invalid/);
  });
});

test("acquireLock: rejects resource with backslash", async () => {
  await withTmpDir("hostile-backslash", async (dir) => {
    await assert.rejects(() => acquireLock(dir, "a\\b"), /invalid/);
  });
});

test("acquireLock: rejects resource with null byte embedded", async () => {
  await withTmpDir("hostile-null", async (dir) => {
    await assert.rejects(() => acquireLock(dir, "test\0lock"), /invalid/);
  });
});

test("acquireLock: a planted symlink at the lock path is never written through — the one writer refuses it, loudly", async () => {
  await withTmpDir("hostile-symlink", async (dir) => {
    const lockDir = join(dir, DEFAULT_LOCK_DIRECTORY);
    mkdirSync(lockDir, { recursive: true, mode: LOCK_DIR_MODE });
    const target = join(dir, "malicious-target");
    writeFileSync(target, "evil", { mode: LOCK_FILE_MODE });
    const lockPath = join(lockDir, "test.lock");
    symlinkSync(target, lockPath);
    await assert.rejects(
      () => acquireLock(dir, "test", { timeoutMs: 200, pollIntervalMs: 10 }),
      (err: Error) => /symbolic link/u.test(err.message),
    );
    assert.equal(readFileSync(target, "utf8"), "evil", "the symlink's target was written");
    rmSync(lockPath, { force: true });
  });
});

test("lockPathFor: does not allow escaping via resource name", () => {
  assert.throws(() => lockPathFor("/root", "a/b"), /invalid/);
  assert.throws(() => lockPathFor("/root", ".."), /invalid/);
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test("lockPathFor: deterministic path for same inputs", () => {
  assert.equal(lockPathFor("/root", "test"), lockPathFor("/root", "test"));
  assert.equal(
    lockPathFor("/root", "test", ".custom"),
    lockPathFor("/root", "test", ".custom"),
  );
});

// ---------------------------------------------------------------------------
// Stress / volume
// ---------------------------------------------------------------------------

test("acquireLock: 20 resources acquired and released", async () => {
  await withTmpDir("stress-20", async (dir) => {
    const handles: ResourceLockHandle[] = [];
    for (let i = 0; i < 20; i++) {
      handles.push(await acquireLock(dir, `lock-${i}`));
    }
    assert.equal(handles.length, 20);
    for (const h of handles) h.release();
    for (let i = 0; i < 20; i++) {
      assert.ok(!existsSync(lockPathFor(dir, `lock-${i}`)));
    }
  });
});

test("withLock: 20 sequential locks", async () => {
  await withTmpDir("stress-20-seq", async (dir) => {
    for (let i = 0; i < 20; i++) {
      await withLock(dir, "test", async () => i);
    }
  });
});

test("acquireLock: 50 resources with custom lock directory", async () => {
  await withTmpDir("stress-50-custom", async (dir) => {
    const handles: ResourceLockHandle[] = [];
    for (let i = 0; i < 50; i++) {
      handles.push(await acquireLock(dir, `r${i}`, { lockDirectory: ".locks" }));
    }
    for (const h of handles) h.release();
  });
});

// ---------------------------------------------------------------------------
// Schema constants
// ---------------------------------------------------------------------------

test("DEFAULT_LOCK_DIRECTORY: is under.bridlewise", () => {
  assert.ok(DEFAULT_LOCK_DIRECTORY.startsWith(".bridlewise"));
});

test("DEFAULT_LOCK_TIMEOUT_MS: is positive", () => {
  assert.ok(DEFAULT_LOCK_TIMEOUT_MS > 0);
});

test("DEFAULT_LOCK_POLL_INTERVAL_MS: is positive", () => {
  assert.ok(DEFAULT_LOCK_POLL_INTERVAL_MS > 0);
});

test("DEFAULT_LOCK_STALE_MS: is positive", () => {
  assert.ok(DEFAULT_LOCK_STALE_MS > 0);
});

test("LOCK_FILE_MODE: is 0o600", () => {
  assert.equal(LOCK_FILE_MODE, 0o600);
});

test("LOCK_DIR_MODE: is 0o700", () => {
  assert.equal(LOCK_DIR_MODE, 0o700);
});
