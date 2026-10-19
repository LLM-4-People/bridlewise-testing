/**
 * THE ONE FILE LOCK (`src/filesystem/file-lock.ts`), DRIVEN.
 *
 * wf-del2-design D1: the "one" lock broke LIVE holders after an age, kept a
 * known double-break race, sat beside two other lock implementations with
 * other policies, and broke locks without a word. Driven here, each arm in a
 * child process of its own (a patched `node:fs` never touches this runner):
 *
 *   - TWO BREAKERS OF ONE DEAD HOLDER, forced interleaving: while contender B
 *     judges the dead record, contender A breaks it and takes the lock; B's
 *     break must find A's live record and leave it — one holder, never two;
 *   - a LIVE holder is never broken, however old its lock;
 *   - an UNREADABLE lock is honoured until the bound, then broken — and every
 *     break and every timeout is an audit event naming the holder;
 *   - a break file left by a breaker that died inside its break is cleared;
 *   - the guard: no other module spells a lock file without taking it through
 *     this owner, and none renames or unlinks one by hand.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { walk } from "../../scripts/verification/source-walk.ts";
import { FILE_LOCK_SCHEMA_VERSION, printableHolderLabel, type FileLockContent } from "../../src/filesystem/file-lock.ts";
import { processIdentity, processUid } from "../../src/process/process-facts.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { createTempDir } from "../support/temp-dir.ts";

const ENGINE_ROOT = join(import.meta.dirname, "..", "..");
const REPOSITORY_ROOT = join(ENGINE_ROOT, "..");
const FILE_LOCK = pathToFileURL(join(ENGINE_ROOT, "src", "filesystem", "file-lock.ts")).href;
const DEBUG = pathToFileURL(join(ENGINE_ROOT, "src", "shared", "debug", "debug-system.ts")).href;
const DEBUG_CONFIG = pathToFileURL(join(ENGINE_ROOT, "src", "shared", "debug", "debug-config.ts")).href;

function record(pid: number, nonce: string, acquiredAt = new Date().toISOString(), holder: string | null = "a planted holder"): string {
  const content: FileLockContent = { schemaVersion: FILE_LOCK_SCHEMA_VERSION, pid, startTime: processIdentity(pid).startTime ?? 1, acquiredAt, nonce, holder, adopted: [] };
  return `${JSON.stringify(content)}\n`;
}

/** A pid that is certainly not alive: a child that already exited. */
function deadPid(): number {
  const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  assert.ok(dead.pid !== undefined);
  return dead.pid;
}

/** Runs `body` (ESM, top-level await; `lock` is the file lock, `audits()` the audit events so far) in a child; its last stdout line, parsed. */
function inChild(body: string): unknown {
  const script = [
    `const lock = await import(${JSON.stringify(FILE_LOCK)});`,
    `const debug = await import(${JSON.stringify(DEBUG)});`,
    `const { DEBUG_CONFIG_DEFAULTS } = await import(${JSON.stringify(DEBUG_CONFIG)});`,
    `debug.configureDebugSystem({ ...DEBUG_CONFIG_DEFAULTS, sinks: { ...DEBUG_CONFIG_DEFAULTS.sinks, enabledSinks: ["collecting"] }, audit: { ...DEBUG_CONFIG_DEFAULTS.audit, enabled: true, categories: [] } }, [debug.createCollectingSink()]);`,
    // The ring is newest first; the arms read it in the order things happened.
    `const audits = () => [...debug.getAuditEvents()].reverse().map((event) => ({ type: event.category, reason: event.context.reason ?? null }));`,
    body,
  ].join("\n");
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 120_000 });
  assert.equal(child.status, 0, `the child failed: ${child.stderr}`);
  return JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "null");
}

test("TWO BREAKERS OF ONE DEAD HOLDER (forced interleaving): the second finds the first's live lock and leaves it — one holder", () => {
  const dir = createTempDir("file-lock-two-breakers-");
  const lockPath = join(dir, "resource.lock");
  const dead = record(deadPid(), "the-dead-holder");
  writeFileSync(lockPath, dead, { mode: 0o600 });
  // Contender A is the test runner's own pid (alive for the whole arm): the
  // moment contender B (the child) has READ the dead record, A breaks it and
  // takes the lock; B goes on with its judgement of the dead bytes.
  const liveA = record(process.pid, "contender-a", new Date().toISOString(), "contender A");
  const outcome = inChild([
    `const fs = (await import("node:fs")).default;`,
    `const { syncBuiltinESMExports } = await import("node:module");`,
    // B opens the dead record (its descriptor keeps those bytes); A breaks it and takes the lock before B reads.
    `const open = fs.openSync; let raced = false;`,
    `fs.openSync = (path, ...rest) => {`,
    `  const descriptor = open(path, ...rest);`,
    `  if (!raced && path === ${JSON.stringify(lockPath)}) { raced = true; fs.renameSync(path, path + ".a-broke-it"); fs.writeFileSync(path, ${JSON.stringify(liveA)}); }`,
    `  return descriptor;`,
    `};`,
    `syncBuiltinESMExports();`,
    `const attempt = lock.tryAcquireFileLock(${JSON.stringify(lockPath)}, { holder: "contender B" });`,
    `console.log(JSON.stringify({ state: attempt.state, holder: attempt.holder?.holder ?? null, raced }));`,
  ].join("\n"));
  assert.deepEqual(outcome, { state: "held", holder: "contender A", raced: true }, "B broke A's fresh lock: two holders");
  assert.equal(readFileSync(lockPath, "utf8"), liveA, "A's lock was moved");
  assert.equal(existsSync(`${lockPath}.break`), false, "the break file was left behind");
});

test("a LIVE holder is never broken, however old its lock; a dead holder's lock is broken at once — both audited", () => {
  const dir = createTempDir("file-lock-live-old-");
  const lockPath = join(dir, "resource.lock");
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 120000)"], { stdio: "ignore" });
  try {
    const old = new Date(Date.now() - 24 * 3_600_000);
    const live = record(sleeper.pid!, "an-old-live-holder", old.toISOString());
    writeFileSync(lockPath, live, { mode: 0o600 });
    utimesSync(lockPath, old, old);
    const outcome = inChild([
      `const held = lock.tryAcquireFileLock(${JSON.stringify(lockPath)}, { holder: "a contender", unreadableAfterMs: 1 });`,
      `let timedOut = null;`,
      `try { lock.withFileLock(${JSON.stringify(lockPath)}, (message) => new Error(message), () => 0, { timeoutMs: 100, pollIntervalMs: 10 }); } catch (error) { timedOut = error.message; }`,
      `console.log(JSON.stringify({ state: held.state, timedOut, audits: audits() }));`,
    ].join("\n")) as { state: string; timedOut: string | null; audits: readonly { type: string }[] };
    assert.equal(outcome.state, "held");
    assert.match(outcome.timedOut ?? "", new RegExp(`held by pid ${String(sleeper.pid)}, a planted holder`, "u"));
    assert.deepEqual(outcome.audits.map((event) => event.type), ["file-lock-timeout"], "the timeout was not audited, or something was broken");
    assert.equal(readFileSync(lockPath, "utf8"), live, "a live holder's lock was broken");
  } finally {
    sleeper.kill("SIGKILL");
  }
  const dead = record(deadPid(), "a-dead-holder");
  writeFileSync(lockPath, dead, { mode: 0o600 });
  const broken = inChild([
    `const taken = lock.tryAcquireFileLock(${JSON.stringify(lockPath)}, { holder: "the next holder" });`,
    `const mine = JSON.parse((await import("node:fs")).readFileSync(${JSON.stringify(lockPath)}, "utf8")).holder;`,
    `taken.handle.release();`,
    `console.log(JSON.stringify({ state: taken.state, mine, audits: audits() }));`,
  ].join("\n"));
  assert.deepEqual(broken, { state: "taken", mine: "the next holder", audits: [{ type: "file-lock-broken", reason: "dead" }] });
  assert.equal(existsSync(lockPath), false, "the release left the lock behind");
});

test("an UNREADABLE lock is honoured until the bound, then broken (audited); a break file a dead breaker left is cleared", () => {
  const dir = createTempDir("file-lock-unreadable-");
  const lockPath = join(dir, "resource.lock");
  writeFileSync(lockPath, "not a lock record\n", { mode: 0o600 });
  const fresh = inChild(`console.log(JSON.stringify({ state: lock.tryAcquireFileLock(${JSON.stringify(lockPath)}).state, audits: audits() }));`);
  assert.deepEqual(fresh, { state: "unreadable", audits: [] });
  const old = new Date(Date.now() - ROOT_POLICY.filesystemInfrastructure.fileLock.staleMs - 60_000);
  utimesSync(lockPath, old, old);
  // …and a breaker died inside its break, leaving `<lock>.break` behind.
  writeFileSync(`${lockPath}.break`, record(deadPid(), "a-dead-breaker"), { mode: 0o600 });
  const aged = inChild([
    `const first = lock.tryAcquireFileLock(${JSON.stringify(lockPath)});`,
    `const second = first.state === "taken" ? first : lock.tryAcquireFileLock(${JSON.stringify(lockPath)});`,
    `if (second.state === "taken") second.handle.release();`,
    `console.log(JSON.stringify({ state: second.state, audits: audits() }));`,
  ].join("\n")) as { state: string; audits: readonly { type: string; reason: string | null }[] };
  assert.equal(aged.state, "taken");
  assert.deepEqual(aged.audits, [{ type: "file-lock-broken", reason: "dead-breaker" }, { type: "file-lock-broken", reason: "unreadable" }]);
  assert.equal(existsSync(`${lockPath}.break`), false);
});

test("S3: A BARE PID IS NO HOLDER — a record or an adopted entry without a start time is unreadable (broken at the bound, never honoured forever), and pid 1 under a start time that is not its own is a dead holder", () => {
  const dir = createTempDir("file-lock-identity-");
  const lockPath = join(dir, "resource.lock");
  const at = new Date().toISOString();
  const plant = (content: unknown): void => writeFileSync(lockPath, `${JSON.stringify(content)}\n`, { mode: 0o600 });
  const state = (): string => (inChild(`const a = lock.tryAcquireFileLock(${JSON.stringify(lockPath)}); if (a.state === "taken") a.handle.release(); console.log(JSON.stringify({ state: a.state }));`) as { state: string }).state;
  plant({ schemaVersion: FILE_LOCK_SCHEMA_VERSION, pid: 1, acquiredAt: at, nonce: "bare-pid-one", holder: "init by pid alone", adopted: [] });
  assert.equal(state(), "unreadable", "a holder named by pid alone is no identity: honoured only until the bound");
  const old = new Date(Date.now() - ROOT_POLICY.filesystemInfrastructure.fileLock.staleMs - 60_000);
  utimesSync(lockPath, old, old);
  assert.equal(state(), "taken", "and broken at the bound: pid 1 never holds the host's lock forever");
  plant({ schemaVersion: FILE_LOCK_SCHEMA_VERSION, pid: deadPid(), startTime: 1, acquiredAt: at, nonce: "adopted-bare", holder: "a dead holder", adopted: [{ pid: 1 }] });
  assert.equal(state(), "unreadable", "an adopted entry by pid alone makes the record no identity");
  const initStart = processIdentity(1).startTime;
  assert.ok(initStart !== null, "this host reads pid 1's start time");
  plant({ schemaVersion: FILE_LOCK_SCHEMA_VERSION, pid: deadPid(), startTime: 1, acquiredAt: at, nonce: "adopted-recycled", holder: "a dead holder", adopted: [{ pid: 1, startTime: initStart + 12_345 }] });
  assert.equal(state(), "taken", "a recycled pid (another start time) is a dead holder: broken at once");
  // PID 1 UNDER ITS REAL START TIME (world-readable) — another user's process: no holder of this user's lock, as the holder
  // or as an adopted entry; broken at once, never honoured forever (security L-1/MF-7).
  plant({ schemaVersion: FILE_LOCK_SCHEMA_VERSION, pid: 1, startTime: initStart, acquiredAt: at, nonce: "pid-one-real", holder: "init, really", adopted: [] });
  assert.equal(state(), "taken", "pid 1 with its real start time is not this user's process: it holds nothing");
  plant({ schemaVersion: FILE_LOCK_SCHEMA_VERSION, pid: deadPid(), startTime: 1, acquiredAt: at, nonce: "adopted-pid-one-real", holder: "a dead holder", adopted: [{ pid: 1, startTime: initStart }] });
  assert.equal(state(), "taken", "nor as an adopted entry");
  assert.equal(processUid(process.pid), process.getuid?.(), "this process's uid is read from procfs");
});

test("A HOLDER LABEL HIDES NOTHING THE TERMINAL WOULD REORDER (security L-2): bidi embeddings, overrides, isolates and the line separators are escaped like control characters", () => {
  assert.equal(printableHolderLabel("a\u202Eexe.txt"), "a\\u202eexe.txt");
  assert.equal(printableHolderLabel("x\u2066y\u2069\u200F\u2028z"), "x\\u2066y\\u2069\\u200f\\u2028z");
  assert.equal(printableHolderLabel("plain — label ünïcode"), "plain — label ünïcode", "ordinary text passes as written");
});

test("THE LOCK FILE IS READ WITHOUT FOLLOWING A LINK, WITHOUT BLOCKING, AND BOUNDED: a link is refused loudly and never read; a FIFO and an oversized file are unreadable, never read", () => {
  const dir = createTempDir("file-lock-contained-");
  const lockPath = join(dir, "resource.lock");
  const target = join(dir, "elsewhere.json");
  writeFileSync(target, record(process.pid, "a-live-holder-behind-a-link"), { mode: 0o600 });
  symlinkSync(target, lockPath);
  const read = (): string => (inChild(`const a = lock.tryAcquireFileLock(${JSON.stringify(lockPath)}); if (a.state === "taken") a.handle.release(); console.log(JSON.stringify({ state: a.state }));`) as { state: string }).state;
  const linked = inChild([
    `let refused = null; try { lock.tryAcquireFileLock(${JSON.stringify(lockPath)}); } catch (error) { refused = error.code; }`,
    `console.log(JSON.stringify({ refused, holder: lock.liveFileLockHolder(${JSON.stringify(lockPath)}) }));`,
  ].join("\n"));
  assert.deepEqual(linked, { refused: "atomic_write_link_refused", holder: null }, "a link at the lock path is refused loudly, and never followed by the reader (a live holder behind it is not read)");
  unlinkSync(lockPath);
  execFileSync("mkfifo", [lockPath]);
  assert.equal(read(), "unreadable", "a FIFO never blocks a waiter");
  unlinkSync(lockPath);
  writeFileSync(lockPath, `${record(process.pid, "an-oversized-record").trimEnd()}${" ".repeat(ROOT_POLICY.filesystemInfrastructure.fileLock.maximumRecordBytes)}\n`, { mode: 0o600 });
  assert.equal(read(), "unreadable", "a file over the record bound is never read");
});

/**
 * Modules that name a lock file of their own and take it through this owner
 * or hand the name to git (git's own `index.lock` protocol, ref names).
 */
const DECLARED: Readonly<Record<string, string>> = {
  "engine/src/git/worktree-port.ts": "validates a branch name against git's refname rules (a name ending in .lock), no lock file",
  "engine/src/git/working-copy.ts": "validates a ref segment against git's refname rules (a name ending in .lock), no lock file",
};

test("THE ONE LOCK: no module spells a lock file without taking it through file-lock.ts, and none renames or unlinks one by hand", () => {
  const OWNER = "engine/src/filesystem/file-lock.ts";
  const roots = [join(ENGINE_ROOT, "src"), join(ENGINE_ROOT, "scripts"), join(REPOSITORY_ROOT, "server"), join(REPOSITORY_ROOT, "scripts"), join(REPOSITORY_ROOT, "tests", "setup")];
  const spellsALock = /\.lock(?:[`"'])/u;
  const handles = /(?<![A-Za-z])(?:renameSync|unlinkSync|linkSync|rmSync)\([^)\n]*[lL]ock/u;
  const offenders = roots.flatMap((root) => walk(root, { exts: [".ts", ".mts", ".mjs"] }))
    .map((file) => ({ path: relative(REPOSITORY_ROOT, file).split("\\").join("/"), text: readFileSync(file, "utf8") }))
    .filter((file) => !/^engine\/scripts\/exp/u.test(file.path) && file.path !== OWNER && DECLARED[file.path] === undefined)
    .flatMap((file) => [
      // The instrument lock IS the file lock (src/process/instrument-lock.ts takes every hold through it).
      ...(spellsALock.test(file.text) && !/(?:filesystem\/|["']\.\/)file-lock\.ts["']|process\/instrument-lock\.ts["']/u.test(file.text) ? [`${file.path}: names a lock file but does not take it through ${OWNER}`] : []),
      ...(handles.test(file.text) ? [`${file.path}: renames or unlinks a lock by hand`] : []),
    ]);
  assert.deepEqual(offenders, []);
  // Every declared exception still names a lock (a stale declaration is a hole nobody sees).
  for (const path of Object.keys(DECLARED)) assert.ok(spellsALock.test(readFileSync(join(REPOSITORY_ROOT, path), "utf8")), `${path} no longer names a lock: remove its declaration`);
  // The guard sees both shapes (planted).
  assert.ok(spellsALock.test("join(dir, `${name}.lock`)") && spellsALock.test('"test-runner.lock"'));
  assert.ok(handles.test("renameSync(lockPath, aside)") && handles.test("unlinkSync(`${x}.lock`)"));
  assert.equal(handles.test("unlinkSync(path)"), false);
});
