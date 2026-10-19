/**
 * The config write lock's child-process fixture — the cooperating writer the
 * concurrency suite spawns to prove the lock is genuinely CROSS-PROCESS.
 *
 * Run as `node --experimental-strip-types <this file> <verb> <configPath> …`.
 * A child process is the point: an in-process double of the lock could be
 * satisfied by module state, and the failures this lock exists for were
 * between PROCESSES.
 *
 * Verbs:
 *
 *   snapshot <configPath> <goMarkerPath> <statusPath>
 *     After the parent's go-marker, enter the real lock and record the bytes.
 *     Observe the actual owner's first contention wait so the parent can
 *     restore and release without guessing a delay or waiting for acquisition.
 *
 *   exit <configPath> <otherConfigPath>
 *     Finish one hold, then exit while two distinct locks are active. The
 *     exit cleanup must cover both after its earlier registration retired.
 *
 *   hold <configPath> <ms>
 *     Take the lock, announce, sleep, release. The exclusion arm measures
 *     that the parent's acquire cannot complete before this holder's.
 *
 *   rmw <configPath> <field> <goMarkerPath>
 *     ONE locked read-modify-write cycle over a plain JSON document: read
 *     inside the lock, announce the base it read, synchronously park until
 *     the parent creates the go-marker file, increment `field`, write
 *     through the atomic-rename owner, announce the value it wrote. The
 *     announce-then-park protocol is what makes the lost-update arm
 *     deterministic in BOTH directions: with a working lock the second
 *     child's announce cannot happen until the first child's whole cycle is
 *     done, so its read necessarily sees the first child's write; with the
 *     lock severed both children announce the SAME base before either
 *     writes, and one increment provably vanishes.
 *
 * The park is synchronous (a marker-file wait) because the lock is a
 * synchronous API: the whole cycle — read, park, write — is one hold, and
 * an async park would release the lock before the write it exists to
 * protect.
 */
import { existsSync, readFileSync, writeSync } from "node:fs";

import { atomicWriteFile } from "../../engine/src/filesystem/atomic-write.ts";

const argv = process.argv.slice(2, 6);
const verb = argv[0];
const configPath = argv[1];
const argOne = argv[2];
const argTwo = argv[3];

if (verb !== "hold" && verb !== "rmw" && verb !== "exit" && verb !== "snapshot") {
  console.error(`unknown verb: ${String(verb)}`);
  process.exit(64);
}
if (typeof configPath !== "string" || configPath.length === 0) {
  console.error("a config path is required");
  process.exit(64);
}

const { withConfigWriteLock } = await import("../../engine/src/kernel/config-write-lock.ts");

/**
 * Announcements go through a RAW synchronous descriptor write, never
 * `process.stdout.write`: stdout to a pipe is flushed asynchronously from
 * the event loop, and this fixture parks its main thread in a synchronous
 * wait INSIDE the lock — an announcement still sitting in the buffer at
 * that moment is not delivered until the park ends, which turns the
 * coordinating parent's protocol into a deadlock (measured: one child held
 * the lock parked on an announcement the parent never received, while the
 * other child starved on the lock's acquire timeout). `writeSync` hands
 * the bytes to the pipe before the caller returns.
 */
function say(line: string): void {
  const bytes = Buffer.from(`${line}\n`, "utf8");
  let written = 0;
  while (written < bytes.length) {
    written += writeSync(1, bytes, written, bytes.length - written);
  }
}

/** The loud failure exit: stderr is written synchronously for the same
 *  reason as `say`, and the exit code is never masked by a closed pipe. */
function fail(message: string, code: number): never {
  try {
    const bytes = Buffer.from(`${message}\n`, "utf8");
    let written = 0;
    while (written < bytes.length) {
      written += writeSync(2, bytes, written, bytes.length - written);
    }
  } catch {
    // A closed stderr cannot be the reason to mask the exit code.
  }
  process.exit(code);
}

/** Synchronous bounded sleep — Node's built-in main-thread wait. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Existing fixture park bound, shared by both coordinated child protocols.
const PARK_LIMIT_MS = 20_000;

if (verb === "snapshot") {
  if (!argOne || !argTwo) fail("the snapshot verb needs go and status paths", 64);
  const deadline = Date.now() + PARK_LIMIT_MS;
  while (!existsSync(argOne)) {
    if (Date.now() >= deadline) fail("snapshot timed out waiting for the go-marker", 75);
    sleepSync(5);
  }
  const actualWait = Atomics.wait;
  Atomics.wait = ((...args: Parameters<typeof Atomics.wait>) => {
    if (!existsSync(argTwo)) atomicWriteFile(argTwo, "contended");
    return actualWait(...args);
  }) as typeof Atomics.wait;
  try {
    withConfigWriteLock(configPath, () => {
      atomicWriteFile(argTwo + ".read", readFileSync(configPath, "utf8"));
      if (!existsSync(argTwo)) atomicWriteFile(argTwo, "acquired");
    });
  } finally { Atomics.wait = actualWait; }
  process.exit(0);
}

if (verb === "exit") {
  if (!argOne) fail("the exit verb needs a second config path", 64);
  withConfigWriteLock(configPath, () => undefined);
  withConfigWriteLock(configPath, () => withConfigWriteLock(argOne, () => {
    say("HELD AT EXIT");
    process.exit(0);
  }));
}

if (verb === "hold") {
  const ms = Number(argOne ?? "250");
  withConfigWriteLock(configPath, () => {
    say("HELD");
    sleepSync(ms);
  });
  process.exit(0);
}

// verb === "rmw"
const field = typeof argOne === "string" && argOne.length > 0 ? argOne : "lostUpdateCounter";
const markerPath = argTwo;
if (typeof markerPath !== "string" || markerPath.length === 0) {
  console.error("the rmw verb needs a go-marker path");
  process.exit(64);
}
// Bounded: a parent that died without marking leaves this child spinning for
// at most this long, then it exits loudly instead of hanging the suite.


withConfigWriteLock(configPath, () => {
  const doc = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  const base = typeof doc[field] === "number" ? (doc[field] as number) : 0;
  say(`READ ${String(base)}`);
  const deadline = Date.now() + PARK_LIMIT_MS;
  while (!existsSync(markerPath)) {
    if (Date.now() >= deadline) {
      fail("park timed out waiting for the go-marker", 75);
    }
    sleepSync(5);
  }
  const next = base + 1;
  doc[field] = next;
  const result = atomicWriteFile(configPath, `${JSON.stringify(doc)}\n`);
  if (!result.success) {
    fail(`write failed: ${result.reason ?? "unknown"}`, 74);
  }
  say(`WROTE ${String(next)}`);
});
process.exit(0);
