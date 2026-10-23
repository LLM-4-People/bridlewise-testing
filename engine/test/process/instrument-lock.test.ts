/**
 * THE HOST'S ONE INSTRUMENT LOCK (src/process/instrument-lock.ts, on the one
 * lock primitive src/filesystem/file-lock.ts): two heavy runs serialize — the
 * second WAITS, naming the holder; a run inside a hold borrows it whatever its
 * label holds (a backslash, a TAB, a long command); a crashed holder frees it;
 * a door killed outright leaves the lock held until the command it ran under
 * the supervisor is gone; a light run takes nothing; the stamp is read from
 * the live holder and bound to the owner's acquisition token; a holder label
 * is shown escaped; the lock is the host user's (never moved by $HOME) and
 * never in a checkout. Every arm uses its own lock file under the run's temp
 * root — the supervising door's too (correctness L-N3): no arm takes, waits
 * for or borrows the host's lock (a light run's handle names it and takes
 * nothing).
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { testProcessSupervisorBinary } from "../../guardian/build.ts";
import { liveFileLockHolder, tryAcquireFileLock } from "../../src/filesystem/file-lock.ts";
import { borrowInstrumentLock, holdInstrumentLock, INSTRUMENT_LOCK_TOKEN_VARIABLE, instrumentLockPath, instrumentLockStamp, isHeavyRun, wholeInstrumentTestFileCount, waitForInstrumentLock } from "../../src/process/instrument-lock.ts";
import { allProcessIds, commandLineOf, isProcessAlive, ownedChild, processIdentity, terminate } from "../../src/process/process-facts.ts";
import { namedTestFileCount } from "../../scripts/tooling/test-run-lock.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { InstrumentLockWaitInterrupted, interruptedWaitExitCode } from "../../src/kernel/errors.ts";
import { requireHost } from "../support/host-requirement.ts";

const ENGINE = join(fileURLToPath(new URL("../../", import.meta.url)));
const LOCK_OWNER = pathToFileURL(join(ENGINE, "src", "process", "instrument-lock.ts")).href;
const SUPERVISOR_OWNER = pathToFileURL(join(ENGINE, "src", "process", "supervised-run.ts")).href;

/** A node child running `body` as a module (it may import the owners by URL); its stdout lines arrive through `lines`. */
function child(body: string, args: readonly string[] = []): Readonly<{ process: ChildProcess; lines: string[]; next: (match: RegExp, withinMs: number) => Promise<string> }> {
  const proc = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", body, ...args], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const lines: string[] = [];
  const waiters: (() => void)[] = [];
  let buffered = "";
  const take = (chunk: Buffer): void => {
    buffered += chunk.toString("utf8");
    const parts = buffered.split("\n");
    buffered = parts.pop() ?? "";
    lines.push(...parts);
    for (const wake of waiters.splice(0)) wake();
  };
  proc.stdout!.on("data", take);
  proc.stderr!.on("data", take);
  const next = (match: RegExp, withinMs: number): Promise<string> => new Promise((resolveLine, rejectLine) => {
    const timer = setTimeout(() => rejectLine(new Error(`no line matched ${String(match)} within ${String(withinMs)} ms; saw: ${lines.join(" | ")}`)), withinMs);
    const look = (): void => {
      const found = lines.find((line) => match.test(line));
      if (found !== undefined) {
        clearTimeout(timer);
        resolveLine(found);
      } else {
        waiters.push(look);
      }
    };
    look();
  });
  return { process: proc, lines, next };
}

const exited = (proc: ChildProcess): Promise<void> => new Promise((resolveExit) => {
  if (proc.exitCode !== null || proc.signalCode !== null) resolveExit();
  else proc.once("exit", () => resolveExit());
});

const holderBody = (label: string): string => [
  `const { waitForInstrumentLock } = await import(${JSON.stringify(LOCK_OWNER)});`,
  `const lock = await waitForInstrumentLock(process.argv[1], ${JSON.stringify(label)}, { onWait: (line) => console.log(line), pollIntervalMs: 50 });`,
  `console.log("ACQUIRED owns=" + String(lock.owns));`,
  "setTimeout(() => undefined, 60_000);",
].join("\n");

test("two heavy runs serialize: the second WAITS (never fails, never runs beside), naming the holder; it takes the lock once the first is gone", async (t) => {
  const lockPath = join(createTempDir("instrument-lock-serial-"), "instrument.lock");
  const first = child(holderBody("the first run"), [lockPath]);
  t.after(() => { first.process.kill("SIGKILL"); });
  await first.next(/^ACQUIRED owns=true$/u, 15_000);
  const second = child(holderBody("the second run"), [lockPath]);
  t.after(() => { second.process.kill("SIGKILL"); });
  const waiting = await second.next(/waits for the one instrument lock/u, 15_000);
  assert.match(waiting, /held by the first run \(pid \d+, since /u, "the waiter names the holder");
  await assert.rejects(second.next(/^ACQUIRED/u, 1_000), "the second run waits while the first holds the lock");
  first.process.kill("SIGKILL"); // a crashed holder frees the lock (its pid is dead)
  await second.next(/^ACQUIRED owns=true$/u, 15_000);
});

test("a run INSIDE a hold borrows it — whatever the holder's label holds (a backslash, a TAB, a long command): nesting reads the record's structured fields, never its label", async (t) => {
  for (const label of ["grep -E a\\d | b\\|c", "tab\there", `slot run: ${"x".repeat(5_000)}`]) {
    const lockPath = join(createTempDir("instrument-lock-nested-"), "instrument.lock");
    const nestedBody = [
      `const { waitForInstrumentLock } = await import(${JSON.stringify(LOCK_OWNER)});`,
      `const { spawnSync } = await import("node:child_process");`,
      `const lock = await waitForInstrumentLock(process.argv[1], ${JSON.stringify(label)}, { onWait: () => undefined, pollIntervalMs: 50 });`,
      `const inner = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", ${JSON.stringify(`const { waitForInstrumentLock } = await import(${JSON.stringify(LOCK_OWNER)}); const lock = await waitForInstrumentLock(process.argv[1], "the nested run", { onWait: (line) => console.log(line), pollIntervalMs: 50 }); console.log("NESTED owns=" + String(lock.owns) + " stamp=" + lock.stamp);`)}, process.argv[1]], { encoding: "utf8", timeout: 10_000 });`,
      "console.log(inner.stdout.trim() || ('NO ANSWER ' + String(inner.status) + ' ' + String(inner.signal)));",
      "lock.release();",
    ].join("\n");
    const run = child(nestedBody, [lockPath]);
    t.after(() => { run.process.kill("SIGKILL"); });
    const answer = await run.next(/^(NESTED|NO ANSWER)/u, 20_000);
    assert.equal(answer, "NESTED owns=false stamp=held", `label ${JSON.stringify(label.slice(0, 40))}: the nested run borrowed at once`);
    await exited(run.process);
    const record = existsSync(lockPath) ? readFileSync(lockPath, "utf8") : "";
    assert.equal(record, "", "the holder released its lock");
  }
});

test("a door killed outright never frees the lock under its command: the supervisor it ran the command under is adopted, and the next run waits until that whole process tree is gone", async (t) => {
  const lockPath = join(createTempDir("instrument-lock-door-"), "instrument.lock");
  const marker = `${String(30 + Math.random()).slice(0, 8)}`;
  const doorBody = [
    `const { waitForInstrumentLock } = await import(${JSON.stringify(LOCK_OWNER)});`,
    `const { superviseCommand } = await import(${JSON.stringify(SUPERVISOR_OWNER)});`,
    `await waitForInstrumentLock(process.argv[1], "the door", { onWait: () => undefined, pollIntervalMs: 50 });`,
    // The command ignores the stop, so it outlives the door by the whole kill grace.
    `void superviseCommand({ supervisor: ${JSON.stringify(testProcessSupervisorBinary())}, command: "sh", args: ["-c", ${JSON.stringify(`trap '' TERM; sleep ${marker}`)}], hardCeilingMs: 60_000, killGraceMs: 3_000, onStdout: () => undefined, onStderr: () => undefined });`,
    "setTimeout(() => console.log('RUNNING'), 500);",
    "setTimeout(() => undefined, 60_000);",
  ].join("\n");
  const door = child(doorBody, [lockPath]);
  t.after(() => { door.process.kill("SIGKILL"); });
  await door.next(/^RUNNING$/u, 15_000);
  const sleeper = allProcessIds().find((pid) => { const argv = commandLineOf(pid); return argv?.[0] === "sleep" && argv[1] === marker; });
  assert.ok(sleeper !== undefined, "the door's command runs");
  const holder = liveFileLockHolder(lockPath);
  assert.equal(holder?.adopted.length, 1, "the supervisor is adopted into the record");
  door.process.kill("SIGKILL");
  await exited(door.process);
  // The door is dead; the command it ran is still stopping: the lock is still held.
  const right = tryAcquireFileLock(lockPath, { holder: "the next run" });
  assert.equal(right.state, "held", "the lock is held while the adopted supervisor lives");
  const next = await new Promise<string>((resolveNext) => {
    const deadline = Date.now() + 20_000;
    const poll = (): void => {
      const attempt = tryAcquireFileLock(lockPath, { holder: "the next run" });
      if (attempt.state === "taken") {
        resolveNext(isProcessAlive(sleeper) ? "taken while the command still ran" : "taken after the command was gone");
        attempt.handle.release();
      } else if (Date.now() > deadline) {
        resolveNext("never taken");
      } else {
        setTimeout(poll, 50);
      }
    };
    poll();
  });
  assert.equal(next, "taken after the command was gone");
});

test("a light run takes nothing; what is heavy is config — a file is one, a folder or pattern is heavy, a path that names nothing is none, no argument is the whole suite", async () => {
  const config = { cacheRelativeLockPath: "bridlewise-test/instrument.lock", minimumTestFiles: 2, pollIntervalMs: 50, wholeInstruments: ["playwright"] as const };
  const folder = createTempDir("instrument-lock-count-");
  const one = join(folder, "one.test.ts");
  writeFileSync(one, "");
  const kind = (path: string): "file" | "folder" | "absent" => existsSync(path) ? (path === folder ? "folder" : "file") : "absent";
  assert.equal(namedTestFileCount([one], 2, kind), 1);
  assert.equal(namedTestFileCount([one, one], 2, kind), 2);
  assert.equal(namedTestFileCount([folder], 2, kind), 2, "a folder is heavy");
  assert.equal(namedTestFileCount(["test/**/*.test.ts"], 2, () => "file"), 2, "a pattern is heavy");
  assert.equal(namedTestFileCount([join(folder, "no-such-test-file-selected")], 2, kind), 0, "a no-op subset is light");
  assert.equal(namedTestFileCount(["--reporter=dot"], 2, kind), Number.POSITIVE_INFINITY, "no file argument: the whole suite");
  assert.equal(isHeavyRun(config, 1), false);
  assert.equal(isHeavyRun(config, 2), true);
  // A WHOLE INSTRUMENT is heavy by config's word (`wholeInstruments`), whatever files it names; one config does not name is refused, never guessed light.
  assert.equal(isHeavyRun(config, wholeInstrumentTestFileCount(config, "playwright")), true);
  assert.throws(() => wholeInstrumentTestFileCount(config, "coverage"), (error: unknown) => (error as { code?: string }).code === "instrument_lock_instrument_undeclared");
  const light = await holdInstrumentLock({ config, harnessRoot: ENGINE, runner: "a one-file run", testFileCount: 1, onWait: () => undefined });
  assert.equal(light.owns, false, "a light run owns nothing");
  assert.equal(light.path, instrumentLockPath(config, ENGINE));
  light.release();
});

test("the stamp is READ from the live holder AND bound to its acquisition token: a run outside every hold is unslotted, whatever its environment says; a hand-written record naming this process stamps nothing; a dead holder's record stamps nothing", async () => {
  const lockPath = join(createTempDir("instrument-lock-stamp-"), "instrument.lock");
  const previous = { slot: process.env.HARNESS_HEAVY_SLOT_HOLDER, token: process.env[INSTRUMENT_LOCK_TOKEN_VARIABLE] };
  try {
    delete process.env[INSTRUMENT_LOCK_TOKEN_VARIABLE];
    process.env.HARNESS_HEAVY_SLOT_HOLDER = String(process.ppid); // the old slot's forgeable handoff: ignored
    assert.equal(instrumentLockStamp(lockPath), "unslotted");
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    mkdirSync(join(lockPath, ".."), { recursive: true });
    writeFileSync(lockPath, `${JSON.stringify({ schemaVersion: "bridlewise-file-lock/v1", pid: dead.pid, startTime: 1, acquiredAt: "2026-10-08T00:00:00.000Z", nonce: "n", holder: "a dead holder", adopted: [] })}\n`);
    assert.equal(instrumentLockStamp(lockPath), "unslotted", "a dead holder's record stamps nothing");
    // A record written by hand that names this very process as the holder: live, in this lineage, but no token.
    writeFileSync(lockPath, `${JSON.stringify({ schemaVersion: "bridlewise-file-lock/v1", pid: process.pid, startTime: processIdentity().startTime, acquiredAt: "2026-10-08T00:00:00.000Z", nonce: "forged", holder: "a forged holder", adopted: [] })}\n`);
    assert.equal(instrumentLockStamp(lockPath), "unslotted", "a forged record without the owner's acquisition token stamps nothing");
    const lock = await waitForInstrumentLock(join(createTempDir("instrument-lock-stamp-held-"), "instrument.lock"), "this test", { onWait: () => undefined, pollIntervalMs: 50 });
    assert.equal(process.env[INSTRUMENT_LOCK_TOKEN_VARIABLE], liveFileLockHolder(lock.path)?.nonce, "the owner exports its acquisition token");
    assert.equal(instrumentLockStamp(lock.path), "held", "inside a live hold, with its token");
    // The holder's own stamp reads its acquisition, not its environment: a test file that takes a lock
    // in a worker whose environment carries another token (the suite's) is still the holder.
    process.env[INSTRUMENT_LOCK_TOKEN_VARIABLE] = "the suite's token";
    assert.equal(instrumentLockStamp(lock.path), "held", "the process that acquired the hold stamps held by its acquisition");
    process.env[INSTRUMENT_LOCK_TOKEN_VARIABLE] = liveFileLockHolder(lock.path)!.nonce;
    lock.release();
    assert.equal(process.env[INSTRUMENT_LOCK_TOKEN_VARIABLE], undefined, "the token leaves with the hold");
    process.env[INSTRUMENT_LOCK_TOKEN_VARIABLE] = "inherited";
    const nested = await waitForInstrumentLock(join(createTempDir("instrument-lock-stamp-nested-"), "instrument.lock"), "a nested lock", { onWait: () => undefined, pollIntervalMs: 50 });
    nested.release();
    assert.equal(process.env[INSTRUMENT_LOCK_TOKEN_VARIABLE], "inherited", "a token the process inherited comes back when its own hold is released");
    delete process.env[INSTRUMENT_LOCK_TOKEN_VARIABLE];
    const long = await waitForInstrumentLock(lock.path, `a long label ${"y".repeat(5_000)}`, { onWait: () => undefined, pollIntervalMs: 50 });
    assert.ok((liveFileLockHolder(long.path)?.holder ?? "").length <= 200, "the record's label is bounded");
    long.release();
    assert.equal(instrumentLockStamp(lock.path), "unslotted", "after the release");
  } finally {
    if (previous.slot === undefined) delete process.env.HARNESS_HEAVY_SLOT_HOLDER; else process.env.HARNESS_HEAVY_SLOT_HOLDER = previous.slot;
    if (previous.token === undefined) delete process.env[INSTRUMENT_LOCK_TOKEN_VARIABLE]; else process.env[INSTRUMENT_LOCK_TOKEN_VARIABLE] = previous.token;
  }
});

test("A HOLDER LABEL IS SHOWN ESCAPED AND BOUNDED, whoever wrote the record: no terminal escape, no forged second line", async (t) => {
  const lockPath = join(createTempDir("instrument-lock-label-"), "instrument.lock");
  // A live holder whose record someone wrote by hand, its label raw.
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 60000)"], { stdio: "ignore" });
  t.after(() => { sleeper.kill("SIGKILL"); });
  writeFileSync(lockPath, `${JSON.stringify({ schemaVersion: "bridlewise-file-lock/v1", pid: sleeper.pid, startTime: processIdentity(sleeper.pid!).startTime, acquiredAt: "2026-10-08T00:00:00.000Z", nonce: "raw", holder: `\u001b[31mred\nheld by a forged line ${"z".repeat(5_000)}`, adopted: [] })}\n`, { mode: 0o600 });
  const waiter = child(holderBody("the waiter"), [lockPath]);
  t.after(() => { waiter.process.kill("SIGKILL"); });
  const said = await waiter.next(/waits for the one instrument lock/u, 15_000);
  assert.doesNotMatch(said, /\u001b/u, "no terminal escape reaches the waiter's line");
  assert.match(said, /held by \\u001b\[31mred\\u000aheld by a forged line z+… \(pid/u, "the control characters are escaped in one line, and the label is bounded");
});

test("A HOLD IS BORROWED ONLY THROUGH A LIVE IDENTITY (security L-3): an adopted entry naming an ancestor's pid under another start time — an ended process whose pid was recycled into this lineage — lends nothing; the same entry under the real start time does", async (t) => {
  const lockPath = join(createTempDir("instrument-lock-recycled-"), "instrument.lock");
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 60000)"], { stdio: "ignore" });
  t.after(() => { sleeper.kill("SIGKILL"); });
  const previous = process.env[INSTRUMENT_LOCK_TOKEN_VARIABLE];
  t.after(() => { if (previous === undefined) delete process.env[INSTRUMENT_LOCK_TOKEN_VARIABLE]; else process.env[INSTRUMENT_LOCK_TOKEN_VARIABLE] = previous; });
  const own = processIdentity().startTime!;
  const plant = (adoptedStart: number): void => writeFileSync(lockPath, `${JSON.stringify({ schemaVersion: "bridlewise-file-lock/v1", pid: sleeper.pid, startTime: processIdentity(sleeper.pid!).startTime, acquiredAt: "2026-10-08T00:00:00.000Z", nonce: "foreign-hold", holder: "a foreign holder", adopted: [{ pid: process.pid, startTime: adoptedStart }] })}\n`, { mode: 0o600 });
  process.env[INSTRUMENT_LOCK_TOKEN_VARIABLE] = "foreign-hold";
  plant(own + 12_345);
  assert.equal(instrumentLockStamp(lockPath), "unslotted", "a recycled pid in this lineage is not the process the hold adopted");
  plant(own);
  assert.equal(instrumentLockStamp(lockPath), "held", "the adopted process itself, by its full identity, is inside the hold");
});

test("A RECORD'S ACQUISITION INSTANT IS AN INSTANT (security L-2): a forged line or a terminal escape in it makes the record unreadable, never a line on the waiter's screen", (t) => {
  const lockPath = join(createTempDir("instrument-lock-instant-"), "instrument.lock");
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 60000)"], { stdio: "ignore" });
  t.after(() => { sleeper.kill("SIGKILL"); });
  const plant = (acquiredAt: string): void => writeFileSync(lockPath, `${JSON.stringify({ schemaVersion: "bridlewise-file-lock/v1", pid: sleeper.pid, startTime: processIdentity(sleeper.pid!).startTime, acquiredAt, nonce: "n", holder: "a holder", adopted: [] })}\n`, { mode: 0o600 });
  plant("2026\u001b[2J\nFORGED-ACQ-LINE");
  assert.equal(liveFileLockHolder(lockPath), null, "not an instant: no record of this owner");
  plant("2026-10-08");
  assert.equal(liveFileLockHolder(lockPath), null, "a date is not the instant the writer writes");
  plant("2026-10-08T00:00:00.000Z");
  assert.equal(liveFileLockHolder(lockPath)?.acquiredAt, "2026-10-08T00:00:00.000Z");
});

test("THE LOCK IS THE HOST'S, not the HOME's: its place comes from the password database's home and config; $HOME and $XDG_CACHE_HOME never move it; it stays under that cache folder", () => {
  const config = { cacheRelativeLockPath: "bridlewise/instrument.lock", minimumTestFiles: 2, pollIntervalMs: 50, wholeInstruments: ["playwright"] as const };
  const expected = join(userInfo().homedir, ".cache", "bridlewise", "instrument.lock");
  const previous = { home: process.env.HOME, xdg: process.env.XDG_CACHE_HOME };
  const refused = (relative: string): boolean => {
    try {
      instrumentLockPath({ ...config, cacheRelativeLockPath: relative }, ENGINE);
      return false;
    } catch (error) {
      return (error as { code?: string }).code === "instrument_lock_misplaced";
    }
  };
  try {
    process.env.HOME = createTempDir("instrument-lock-substitute-home-");
    process.env.XDG_CACHE_HOME = createTempDir("instrument-lock-substitute-cache-");
    assert.equal(instrumentLockPath(config, ENGINE), expected, "a substitute HOME and cache base do not move the host's lock");
    assert.equal(refused("/etc/instrument.lock"), true, "an absolute path");
    assert.equal(refused("../instrument.lock"), true, "out of the cache folder");
    assert.equal(refused("bridlewise/instrument.lock"), false, "under the cache folder");
  } finally {
    if (previous.home === undefined) delete process.env.HOME; else process.env.HOME = previous.home;
    if (previous.xdg === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = previous.xdg;
  }
});

test("THE SUPERVISING DOOR (`harness slot run`, the coverage run, the perf profile) holds the lock while its command runs — the command, under the adopted supervisor, reads \"held\" — bounds its label to the program and argument count, and exits with the command's code; a signal-ended command exits 128 + its number. On a lock of the test's own: the host's lock is never a test's (correctness L-N3)", async () => {
  const lockPath = join(createTempDir("instrument-lock-door-"), "instrument.lock");
  const probe = [
    `const { instrumentLockStamp } = await import(${JSON.stringify(LOCK_OWNER)});`,
    `const { liveFileLockHolder } = await import(${JSON.stringify(pathToFileURL(join(ENGINE, "src", "filesystem", "file-lock.ts")).href)});`,
    `console.log("STAMP " + instrumentLockStamp(${JSON.stringify(lockPath)}) + " LABEL " + JSON.stringify(liveFileLockHolder(${JSON.stringify(lockPath)})?.holder));`,
    "process.exit(7);",
  ].join("\n");
  const script = join(createTempDir("instrument-lock-door-script-"), "door.mjs");
  writeFileSync(script, [
    `const { runInsideInstrumentLock } = await import(${JSON.stringify(pathToFileURL(join(ENGINE, "src", "workflow", "slot-cli.ts")).href)});`,
    "const [lockPath, label, ...command] = process.argv.slice(2);",
    "const { exitCode } = await runInsideInstrumentLock(label, Number.POSITIVE_INFINITY, command, { lockPath });",
    "process.exit(exitCode);",
  ].join("\n"));
  const door = (label: string, command: readonly string[]) => spawnSync(process.execPath, ["--experimental-strip-types", script, lockPath, label, ...command], { cwd: ENGINE, encoding: "utf8", timeout: 120_000, env: process.env });
  const ran = door("slot run: node (5 argument(s))", [process.execPath, "--experimental-strip-types", "--input-type=module", "-e", probe, "secret\targument\\with a backslash"]);
  assert.equal(ran.status, 7, `the command's exit code is the door's (stderr: ${ran.stderr.slice(0, 400)})`);
  assert.match(ran.stdout, /STAMP held LABEL "slot run: node \(5 argument\(s\)\)"/u, "the command runs inside the hold; the label carries no argument");
  assert.equal(liveFileLockHolder(lockPath), null, "the door frees the lock when its command ends");
  assert.equal(door("a signal", ["sh", "-c", "kill -TERM $$"]).status, 143);
  // The CLI's slot run is this door, on the host's lock, heavy by kind.
  const cli = readFileSync(join(ENGINE, "src", "workflow", "slot-cli.ts"), "utf8");
  assert.ok(cli.includes('wholeInstrumentTestFileCount(declaredInstrumentLock(readTestExecutionConfig(engineRoot).instrumentLock), "slot")'), "a slot run is heavy by config's word (wholeInstruments)");
  assert.match(cli, /await runInsideInstrumentLock\(slotRunLabel\(command\), count, command\)/u);
});

test("A WAITING DOOR HONOURS SIGTERM AND SIGINT (design L-1): the wait is asynchronous, a signal ends it with a typed exit (128 + its number), and the door never goes on to take the lock", async () => {
  const lockPath = join(createTempDir("instrument-lock-signal-"), "instrument.lock");
  const holder = child(holderBody("a long holder"), [lockPath]);
  try {
    await holder.next(/^ACQUIRED owns=true$/u, 20_000);
    for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130]] as const) {
      const waiter = child([
        `const { waitForInstrumentLock, interruptedWaitExitCode } = await import(${JSON.stringify(LOCK_OWNER)});`,
        // A runner that installed its own handler first, like vitest's main process.
        `process.on(${JSON.stringify(signal)}, () => console.log("RUNNER HANDLER"));`,
        "try {",
        `  await waitForInstrumentLock(process.argv[1], "a waiter", { onWait: (line) => console.log("WAITING " + line), pollIntervalMs: 50 });`,
        `  console.log("ACQUIRED");`,
        "} catch (error) { console.log(\"ENDED \" + error.code); process.exit(interruptedWaitExitCode(error) ?? 1); }",
      ].join("\n"), [lockPath]);
      await waiter.next(/^WAITING /u, 20_000);
      waiter.process.kill(signal);
      await exited(waiter.process);
      assert.equal(waiter.process.exitCode, code, waiter.lines.join(" | "));
      assert.ok(waiter.lines.includes("ENDED instrument_lock_wait_interrupted"), waiter.lines.join(" | "));
      assert.ok(!waiter.lines.includes("ACQUIRED"), "a signalled waiter never takes the lock");
      assert.equal(liveFileLockHolder(lockPath)?.holder, "a long holder", "the holder keeps its hold");
    }
  } finally {
    holder.process.kill("SIGKILL");
    await exited(holder.process);
  }
});

test("NESTING READS ADOPTED PROCESSES TOO (correctness M2): a run whose ancestor is a process the holder ADOPTED (a supervisor it runs a command under) borrows the hold; one outside it does not", async (t) => {
  const lockPath = join(createTempDir("instrument-lock-adopted-"), "instrument.lock");
  const stranger = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => { stranger.kill("SIGKILL"); });
  const holder = processIdentity(stranger.pid!);
  const parent = processIdentity(process.ppid);
  const record = (adopted: readonly unknown[]): void => writeFileSync(lockPath, `${JSON.stringify({ schemaVersion: "bridlewise-file-lock/v1", pid: holder.pid, startTime: holder.startTime, acquiredAt: "2026-10-09T00:00:00.000Z", nonce: "adopting", holder: "a door", adopted })}\n`, { mode: 0o600 });
  record([]);
  assert.equal(borrowInstrumentLock(lockPath, "a nested run"), undefined, "the holder is no ancestor: nothing to borrow");
  record([{ pid: parent.pid, startTime: parent.startTime }]);
  assert.equal(borrowInstrumentLock(lockPath, "a nested run")?.owns, false, "an adopted ancestor holds this run inside the hold");
});

test("THE ANCESTOR'S STAMP NEEDS ITS TOKEN (correctness M3): inside an ancestor's hold, \"held\" only with the acquisition token the holder exported; without it, unslotted", (t) => {
  const lockPath = join(createTempDir("instrument-lock-token-"), "instrument.lock");
  const parent = processIdentity(process.ppid);
  writeFileSync(lockPath, `${JSON.stringify({ schemaVersion: "bridlewise-file-lock/v1", pid: parent.pid, startTime: parent.startTime, acquiredAt: "2026-10-09T00:00:00.000Z", nonce: "the-ancestors-token", holder: "an ancestor", adopted: [] })}\n`, { mode: 0o600 });
  const previous = process.env[INSTRUMENT_LOCK_TOKEN_VARIABLE];
  t.after(() => { if (previous === undefined) delete process.env[INSTRUMENT_LOCK_TOKEN_VARIABLE]; else process.env[INSTRUMENT_LOCK_TOKEN_VARIABLE] = previous; });
  delete process.env[INSTRUMENT_LOCK_TOKEN_VARIABLE];
  assert.equal(instrumentLockStamp(lockPath), "unslotted", "no token: the hold is not this run's to claim");
  process.env[INSTRUMENT_LOCK_TOKEN_VARIABLE] = "another token";
  assert.equal(instrumentLockStamp(lockPath), "unslotted", "a wrong token claims nothing");
  process.env[INSTRUMENT_LOCK_TOKEN_VARIABLE] = "the-ancestors-token";
  assert.equal(instrumentLockStamp(lockPath), "held");
});

test("THE LOCK'S PLACE IS REFUSED INSIDE A CHECKOUT (correctness M6): a lock path under the per-user cache that lies in (or around) the checkout is misplaced", () => {
  const cache = join(userInfo().homedir, ".cache");
  const checkout = createTempDir("instrument-lock-checkout-");
  requireHost(checkout.startsWith(`${cache}/`), `a run temp root under ${cache} (D-19), so a checkout can lie under the cache folder: ${checkout}`);
  spawnSync("git", ["init", "-q", checkout]);
  const relativeToCache = checkout.slice(cache.length + 1);
  assert.throws(() => instrumentLockPath({ cacheRelativeLockPath: `${relativeToCache}/inside/instrument.lock`, minimumTestFiles: 2, pollIntervalMs: 50, wholeInstruments: ["playwright"] }, checkout),
    (error: unknown) => (error as { code?: string }).code === "instrument_lock_misplaced" && /inside or around the checkout/u.test((error as Error).message));
});

test("A GRACE OF 0 IS SIGKILL AT ONCE (correctness M17): a target that ignores SIGTERM is killed, not asked", async (t) => {
  const stubborn = spawn("sh", ["-c", "trap '' TERM; while :; do sleep 1; done"], { stdio: "ignore", detached: true });
  t.after(() => { try { stubborn.kill("SIGKILL"); } catch { /* gone */ } });
  await new Promise((resolveStart) => setTimeout(resolveStart, 200));
  const started = Date.now();
  const ended = await terminate({ group: ownedChild(stubborn) }, { graceMs: 0 });
  assert.equal(ended.ending, "killed");
  assert.ok(Date.now() - started < 2_000, "at once, with no grace spent on a SIGTERM it ignores");
});

test("the CLI's exit for an interrupted wait is decided BY TYPE: 128 + the signal for the lock's own error, nothing for a look-alike (design LOW 14)", () => {
  assert.equal(interruptedWaitExitCode(new InstrumentLockWaitInterrupted("a door", "SIGTERM")), 143);
  assert.equal(interruptedWaitExitCode(new InstrumentLockWaitInterrupted("a door", "SIGINT")), 130);
  const lookAlike = Object.assign(new Error("not the lock's"), { code: "instrument_lock_wait_interrupted", signal: "SIGTERM" });
  assert.equal(interruptedWaitExitCode(lookAlike), undefined, "fields that merely look like the lock's error decide nothing");
  const cli = readFileSync(join(import.meta.dirname, "..", "..", "src", "cli.ts"), "utf8");
  assert.match(cli, /const interrupted = interruptedWaitExitCode\(error\);\n\s*if \(interrupted !== undefined\) return interrupted;\n\s*return 1;/u, "the CLI maps it through the one typed function, and every other error exits 1");
  assert.doesNotMatch(cli, /code\?: unknown \}\)\.code === "instrument_lock_wait_interrupted"/u, "no duck-typed read of the error's fields");
});
