/**
 * HEAVY-RUN ADMISSION (src/process/instrument-lock.ts, on the one lock
 * primitive src/filesystem/file-lock.ts; NO-LOAD-BLOCK): two heavy runs are
 * admitted AT ONCE, each with its own record in the run registry — neither
 * waits; a run inside an admitted run borrows it whatever its label holds; a
 * door killed outright leaves its record live until the command it ran under
 * the supervisor is gone; every supervisor an admitted run starts runs in a
 * cgroup scope with the run's memory cap and CPU weight and under its
 * CPU-time limit — and so does a child the admitting process spawns
 * directly, since admission puts the admitting process itself there; a
 * process borrows a run only from inside its scope; a host that cannot make
 * the scope REFUSES the run; a light run records nothing; nothing stamps a
 * measurement (a reading is valid whatever ran beside it); a label is shown
 * escaped; the registry is the host
 * user's (never moved by $HOME) and never in a checkout. Every arm uses its
 * own registry under the run's temp root — the supervising door's too
 * (correctness L-N3).
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ensureTestProcessSupervisor } from "../guardian/build.ts";
import { liveFileLockHolder } from "../src/filesystem/file-lock.ts";
import { admitInstrumentRun, admittedRuns, borrowInstrumentLock, holdInstrumentLock, instrumentLockPath, isHeavyRun, wholeInstrumentTestFileCount } from "../src/process/instrument-lock.ts";
import { SUBPROCESS_BOUNDS } from "../src/workflow/workflow-config.ts";
import { runCheckoutCommand, type CheckoutCommandRunner } from "../src/workflow/checkout-setup.ts";
import { allProcessIds, commandLineOf, isProcessAlive, ownedChild, processIdentity, procfsDocument, terminate } from "../src/process/process-facts.ts";
import { namedTestFileCount } from "../scripts/tooling/test-run-lock.ts";
import { createTempDir } from "../test/support/temp-dir.ts";
import { requireHost } from "../test/support/host-requirement.ts";

const ENGINE = join(fileURLToPath(new URL("../", import.meta.url)));
const LOCK_OWNER = pathToFileURL(join(ENGINE, "src", "process", "instrument-lock.ts")).href;
const SUPERVISOR_OWNER = pathToFileURL(join(ENGINE, "src", "process", "supervised-run.ts")).href;

/** A node child running `body` as a module (it may import the owners by URL); its stdout lines arrive through `lines`. */
function child(body: string, args: readonly string[] = []): Readonly<{ process: ChildProcess; lines: string[]; next: (match: RegExp) => Promise<string> }> {
  const proc = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", body, ...args], { stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const lines: string[] = [];
  const waiters: (() => void)[] = [];
  let buffered = "";
  let ended = false;
  const take = (chunk: Buffer): void => {
    buffered += chunk.toString("utf8");
    const parts = buffered.split("\n");
    buffered = parts.pop() ?? "";
    lines.push(...parts);
    for (const wake of waiters.splice(0)) wake();
  };
  proc.stdout!.on("data", take);
  proc.stderr!.on("data", take);
  proc.once("close", () => {
    ended = true;
    for (const wake of waiters.splice(0)) wake();
  });
  // BOUNDED BY THE CHILD'S LIFE, never by a wall clock (NO-LOAD-BLOCK): a
  // line that never comes from a child still running is a hang, ended and
  // named by the test's hang backstop; a child that ENDED without it is a
  // refusal at once.
  const next = (match: RegExp): Promise<string> => new Promise((resolveLine, rejectLine) => {
    const look = (): void => {
      const found = lines.find((line) => match.test(line));
      if (found !== undefined) resolveLine(found);
      else if (ended) rejectLine(new Error(`the child ended without a line matching ${String(match)}; saw: ${lines.join(" | ")}`));
      else waiters.push(look);
    };
    look();
  });
  return { process: proc, lines, next };
}

const exited = (proc: ChildProcess): Promise<void> => new Promise((resolveExit) => {
  if (proc.exitCode !== null || proc.signalCode !== null) resolveExit();
  else proc.once("exit", () => resolveExit());
});

const CAPS = { memoryMaxPercent: 50, cpuWeight: 100 } as const;
const CONFIG = { cacheRelativeLockPath: "bridlewise-test/instrument.lock", minimumTestFiles: 2, perRun: CAPS, wholeInstruments: ["playwright"] as const };

/** The run registry beside `lockPath` (one record per admitted run). */
const registryOf = (lockPath: string): string => `${lockPath}.runs`;

/** Writes a record by hand into the registry, as a foreign writer would. */
function plantRecord(lockPath: string, name: string, record: Record<string, unknown>): void {
  mkdirSync(registryOf(lockPath), { recursive: true, mode: 0o700 });
  writeFileSync(join(registryOf(lockPath), `${name}.lock`), `${JSON.stringify({ schemaVersion: "bridlewise-file-lock/v1", acquiredAt: "2026-10-08T00:00:00.000Z", adopted: [], ...record })}\n`, { mode: 0o600 });
}

/**
 * Runs `body` (a module) in a child placed in the scope of the run whose
 * record carries `nonce` — where an admitted run's processes are — with this
 * process as its parent (`systemd-run --scope` execs the command itself);
 * its trimmed stdout.
 */
function inRunScope(nonce: string, body: string, env: NodeJS.ProcessEnv = process.env): string {
  const ran = spawnSync("systemd-run", ["--user", "--scope", "--quiet", "--collect", `--unit=bridlewise-run-${nonce}`, process.execPath,
    "--experimental-strip-types", "--input-type=module", "-e", body], { encoding: "utf8", env });
  assert.equal(ran.status, 0, ran.stderr);
  return ran.stdout.trim();
}

const admitterBody = (label: string): string => [
  `const { admitInstrumentRun } = await import(${JSON.stringify(LOCK_OWNER)});`,
  `const { SUBPROCESS_BOUNDS } = await import(${JSON.stringify(pathToFileURL(join(ENGINE, "src", "workflow", "workflow-config.ts")).href)});`,
  `const lock = admitInstrumentRun(process.argv[1], ${JSON.stringify(label)}, ${JSON.stringify(CAPS)}, SUBPROCESS_BOUNDS);`,
  `console.log("ADMITTED owns=" + String(lock.owns));`,
  "setTimeout(() => undefined, 60_000);",
].join("\n");

test("two heavy runs are ADMITTED AT ONCE, side by side — neither waits — each with its own live record in the registry; a crashed run's record clears", async (t) => {
  const lockPath = join(createTempDir("instrument-lock-concurrent-"), "instrument.lock");
  const first = child(admitterBody("the first run"), [lockPath]);
  t.after(() => { first.process.kill("SIGKILL"); });
  await first.next(/^ADMITTED owns=true$/u);
  const second = child(admitterBody("the second run"), [lockPath]);
  t.after(() => { second.process.kill("SIGKILL"); });
  await second.next(/^ADMITTED owns=true$/u);
  const live = admittedRuns(lockPath);
  assert.equal(live.length, 2, live.join(" | "));
  assert.ok(live.some((line) => /^the first run \(pid \d+, since /u.test(line)) && live.some((line) => /^the second run \(pid /u.test(line)), live.join(" | "));
  first.process.kill("SIGKILL");
  await exited(first.process);
  assert.deepEqual(admittedRuns(lockPath).map((line) => line.split(" (")[0]), ["the second run"], "a crashed run's record is dead, and cleared when met");
});

test("a run INSIDE an admitted run borrows it — whatever the label holds (a backslash, a TAB, a long command): nesting reads the record's structured fields, never its label", async (t) => {
  for (const label of ["grep -E a\\d | b\\|c", "tab\there", `slot run: ${"x".repeat(5_000)}`]) {
    const lockPath = join(createTempDir("instrument-lock-nested-"), "instrument.lock");
    const workflowConfig = pathToFileURL(join(ENGINE, "src", "workflow", "workflow-config.ts")).href;
    const nestedBody = [
      `const { admitInstrumentRun } = await import(${JSON.stringify(LOCK_OWNER)});`,
      `const { SUBPROCESS_BOUNDS } = await import(${JSON.stringify(workflowConfig)});`,
      `const { spawnSync } = await import("node:child_process");`,
      `const lock = admitInstrumentRun(process.argv[1], ${JSON.stringify(label)}, ${JSON.stringify(CAPS)}, SUBPROCESS_BOUNDS);`,
      `const inner = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", ${JSON.stringify(`const { admitInstrumentRun } = await import(${JSON.stringify(LOCK_OWNER)}); const { SUBPROCESS_BOUNDS } = await import(${JSON.stringify(workflowConfig)}); const lock = admitInstrumentRun(process.argv[1], "the nested run", ${JSON.stringify(CAPS)}, SUBPROCESS_BOUNDS); console.log("NESTED owns=" + String(lock.owns));`)}, process.argv[1]], { encoding: "utf8" });`,
      "console.log(inner.stdout.trim() || ('NO ANSWER ' + String(inner.status) + ' ' + String(inner.signal) + ' ' + inner.stderr));",
      "lock.release();",
    ].join("\n");
    const run = child(nestedBody, [lockPath]);
    t.after(() => { run.process.kill("SIGKILL"); });
    const answer = await run.next(/^(NESTED|NO ANSWER)/u);
    assert.equal(answer, "NESTED owns=false", `label ${JSON.stringify(label.slice(0, 40))}: the nested run borrowed`);
    await exited(run.process);
    assert.deepEqual(admittedRuns(lockPath), [], "the admitted run released its record");
  }
});

test("EVERY SUPERVISOR AN ADMITTED RUN STARTS RUNS UNDER ITS CAPS: a cgroup scope with the run's MemoryMax and CPUWeight, and the CPU-time limit (soft and hard)", async () => {
  const lockPath = join(createTempDir("instrument-lock-caps-"), "instrument.lock");
  const script = join(createTempDir("instrument-lock-caps-script-"), "caps.mjs");
  writeFileSync(script, [
    `const { admitInstrumentRun } = await import(${JSON.stringify(LOCK_OWNER)});`,
    `const { superviseCommand } = await import(${JSON.stringify(SUPERVISOR_OWNER)});`,
    `const lock = admitInstrumentRun(process.argv[2], "a capped run", { memoryMaxPercent: 37, cpuWeight: 42 }, { cpuLimitSeconds: 77, cpuKillGraceSeconds: 3, hangBackstopMs: 600_000 });`,
    "let out = '';",
    `await superviseCommand({ supervisor: ${JSON.stringify(ensureTestProcessSupervisor())}, command: "sh", args: ["-c", 'g=/sys/fs/cgroup$(cut -d: -f3 /proc/self/cgroup); echo "cgroup=$(cut -d: -f3 /proc/self/cgroup) weight=$(cat $g/cpu.weight) memmax=$(cat $g/memory.max) soft=$(ulimit -S -t) hard=$(ulimit -H -t)"'], hardCeilingMs: 60_000, killGraceMs: 3_000, onStdout: (chunk) => { out += chunk; }, onStderr: (chunk) => process.stderr.write(chunk) });`,
    "lock.release();",
    "process.stdout.write(out);",
  ].join("\n"));
  const ran = spawnSync(process.execPath, ["--experimental-strip-types", script, lockPath], { cwd: ENGINE, encoding: "utf8", env: process.env });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /cgroup=\/\S+\/bridlewise-run-[0-9a-f-]+\.scope weight=42 memmax=\d+ soft=77 hard=80/u, ran.stdout);
  const total = Number(procfsDocument("meminfo")!.match(/^MemTotal:\s+(\d+) kB/mu)![1]) * 1024;
  const memmax = Number(/memmax=(\d+)/u.exec(ran.stdout)![1]);
  assert.ok(Math.abs(memmax - total * 0.37) < total * 0.01, `MemoryMax is 37% of the host's memory (${String(memmax)} of ${String(total)})`);
});

test("NO UNCAPPED PATH (the #362 review's plant): a child the admitting process spawns DIRECTLY, not through the supervisor, is born inside the run's scope and CPU-time limit and borrows the run; a descendant that left the scope borrows nothing", () => {
  const lockPath = join(createTempDir("instrument-lock-direct-"), "instrument.lock");
  const script = join(createTempDir("instrument-lock-direct-script-"), "direct.mjs");
  const probe = [
    `const { borrowInstrumentLock } = await import(${JSON.stringify(LOCK_OWNER)});`,
    `const { ownCgroupPath, ownCpuTimeLimit } = await import(${JSON.stringify(pathToFileURL(join(ENGINE, "src", "process", "process-facts.ts")).href)});`,
    `const { readFileSync } = await import("node:fs");`,
    `const cgroup = ownCgroupPath();`,
    `const limit = ownCpuTimeLimit();`,
    `console.log("cgroup=" + cgroup + " weight=" + readFileSync("/sys/fs/cgroup" + cgroup + "/cpu.weight", "utf8").trim() + " soft=" + limit.soft + " hard=" + limit.hard + " borrowed=" + String(borrowInstrumentLock(process.argv[1], "a direct child")?.owns));`,
  ].join("\n");
  writeFileSync(script, [
    `const { admitInstrumentRun } = await import(${JSON.stringify(LOCK_OWNER)});`,
    `const { spawnSync } = await import("node:child_process");`,
    `const lock = admitInstrumentRun(process.argv[2], "a run with a direct child", { memoryMaxPercent: 37, cpuWeight: 42 }, { cpuLimitSeconds: 77, cpuKillGraceSeconds: 3, hangBackstopMs: 600_000 });`,
    `const probe = ${JSON.stringify(probe)};`,
    `const direct = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", probe, process.argv[2]], { encoding: "utf8" });`,
    `const escaped = spawnSync("systemd-run", ["--user", "--scope", "--quiet", "--collect", process.execPath, "--experimental-strip-types", "--input-type=module", "-e", probe, process.argv[2]], { encoding: "utf8" });`,
    "lock.release();",
    "process.stdout.write(`DIRECT ${direct.stdout.trim()} ${direct.stderr.trim()}\nESCAPED ${escaped.stdout.trim()} ${escaped.stderr.trim()}\n`);",
  ].join("\n"));
  const ran = spawnSync(process.execPath, ["--experimental-strip-types", script, lockPath], { cwd: ENGINE, encoding: "utf8", env: process.env });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /^DIRECT cgroup=\/\S+\/bridlewise-run-[0-9a-f-]+\.scope weight=42 soft=77 hard=80 borrowed=false $/mu, "the direct child is capped, and borrows from inside the scope");
  assert.match(ran.stdout, /^ESCAPED cgroup=(?!\S*bridlewise-run-)\S+ weight=\d+ soft=77 hard=80 borrowed=undefined $/mu, "a descendant outside the run's scope borrows nothing, whatever its lineage");
});

test("A HOST THAT CANNOT MAKE THE RUN'S SCOPE REFUSES THE RUN, typed and loud (per_run_caps_unavailable): there is no uncapped mode", () => {
  const lockPath = join(createTempDir("instrument-lock-uncappable-"), "instrument.lock");
  // No systemd-run on PATH: the probe answers no, and nothing is admitted.
  const empty = createTempDir("instrument-lock-empty-path-");
  const ran = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", [
    `const { admitInstrumentRun } = await import(${JSON.stringify(LOCK_OWNER)});`,
    `try { admitInstrumentRun(process.argv[1], "an uncappable run", ${JSON.stringify(CAPS)}, ${JSON.stringify(SUBPROCESS_BOUNDS)}); console.log("ADMITTED"); } catch (error) { console.log("REFUSED " + error.code); }`,
  ].join("\n"), lockPath], { encoding: "utf8", env: { ...process.env, PATH: empty } });
  assert.match(ran.stdout, /^REFUSED per_run_caps_unavailable$/mu, `${ran.stdout} ${ran.stderr}`);
  assert.deepEqual(admittedRuns(lockPath), [], "nothing was recorded for a refused run");
});

test("a door killed outright never drops its record under its command: the supervisor it ran the command under is adopted, and the record stays live until that whole process tree is gone", async (t) => {
  const lockPath = join(createTempDir("instrument-lock-door-"), "instrument.lock");
  const marker = `${String(30 + Math.random()).slice(0, 8)}`;
  const doorBody = [
    `const { admitInstrumentRun } = await import(${JSON.stringify(LOCK_OWNER)});`,
    `const { superviseCommand } = await import(${JSON.stringify(SUPERVISOR_OWNER)});`,
    `admitInstrumentRun(process.argv[1], "the door", ${JSON.stringify(CAPS)}, ${JSON.stringify(SUBPROCESS_BOUNDS)});`,
    // The command ignores the stop, so it outlives the door by the whole kill grace.
    `void superviseCommand({ supervisor: ${JSON.stringify(ensureTestProcessSupervisor())}, command: "sh", args: ["-c", ${JSON.stringify(`trap '' TERM; sleep ${marker}`)}], hardCeilingMs: 60_000, killGraceMs: 3_000, onStdout: () => undefined, onStderr: () => undefined });`,
    "setTimeout(() => console.log('RUNNING'), 500);",
    "setTimeout(() => undefined, 60_000);",
  ].join("\n");
  const door = child(doorBody, [lockPath]);
  t.after(() => { door.process.kill("SIGKILL"); });
  await door.next(/^RUNNING$/u);
  const sleeper = allProcessIds().find((pid) => { const argv = commandLineOf(pid); return argv?.[0] === "sleep" && argv[1] === marker; });
  assert.ok(sleeper !== undefined, "the door's command runs");
  assert.match(admittedRuns(lockPath)[0] ?? "", /^the door \(pid \d+, since [^,]+, with 1 adopted process\(es\)\)$/u, "the supervisor is adopted into the record");
  door.process.kill("SIGKILL");
  await exited(door.process);
  assert.equal(admittedRuns(lockPath).length, 1, "the record is live while the adopted supervisor lives");
  // Waited for by the record itself, with NO wall deadline (NO-LOAD-BLOCK):
  // a record that is never cleared is a hang, ended and named by the backstop.
  const cleared = await new Promise<string>((resolveCleared) => {
    const poll = (): void => {
      if (admittedRuns(lockPath).length === 0) resolveCleared(isProcessAlive(sleeper) ? "cleared while the command still ran" : "cleared after the command was gone");
      else setTimeout(poll, 50);
    };
    poll();
  });
  assert.equal(cleared, "cleared after the command was gone");
});

test("a light run records nothing; what is heavy is config — a file is one, a folder or pattern is heavy, a path that names nothing is none, no argument is the whole suite", () => {
  const config = CONFIG;
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
  const light = holdInstrumentLock({ config, harnessRoot: ENGINE, runner: "a one-file run", testFileCount: 1, cpu: SUBPROCESS_BOUNDS });
  assert.equal(light.owns, false, "a light run owns nothing");
  assert.equal(light.path, instrumentLockPath(config, ENGINE));
  light.release();
});

test("NOTHING STAMPS A MEASUREMENT (NO-LOAD-BLOCK, audit A-04): the owner exports no token and no stamp, and a run's record label is bounded", () => {
  const before = Object.keys(process.env).sort();
  const lock = admitInstrumentRun(join(createTempDir("instrument-lock-nostamp-"), "instrument.lock"), `a long label ${"y".repeat(5_000)}`, CAPS, SUBPROCESS_BOUNDS);
  try {
    assert.deepEqual(Object.keys(process.env).sort(), before, "admission writes nothing into the environment a measurement could read");
    assert.equal("stamp" in lock, false, "a hold carries no measurement stamp");
    assert.ok((admittedRuns(lock.path)[0] ?? "").length <= 260, "the record's label is bounded");
  } finally {
    lock.release();
  }
  assert.deepEqual(admittedRuns(lock.path), [], "released");
});

test("A RUN'S LABEL IS SHOWN ESCAPED AND BOUNDED, whoever wrote the record: no terminal escape, no forged second line", (t) => {
  const lockPath = join(createTempDir("instrument-lock-label-"), "instrument.lock");
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 60000)"], { stdio: "ignore" });
  t.after(() => { sleeper.kill("SIGKILL"); });
  plantRecord(lockPath, "raw", { pid: sleeper.pid, startTime: processIdentity(sleeper.pid!).startTime, nonce: "raw", holder: `\u001b[31mred\nheld by a forged line ${"z".repeat(5_000)}` });
  const [said] = admittedRuns(lockPath);
  assert.doesNotMatch(said ?? "", /\u001b/u, "no terminal escape reaches the shown line");
  assert.match(said ?? "", /^\\u001b\[31mred\\u000aheld by a forged line z+… \(pid/u, "the control characters are escaped in one line, and the label is bounded");
});

test("A RUN IS BORROWED ONLY THROUGH A LIVE IDENTITY (security L-3): an adopted entry naming an ancestor's pid under another start time — an ended process whose pid was recycled into this lineage — lends nothing; the same entry under the real start time does", (t) => {
  const lockPath = join(createTempDir("instrument-lock-recycled-"), "instrument.lock");
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 60000)"], { stdio: "ignore" });
  t.after(() => { sleeper.kill("SIGKILL"); });
  const own = processIdentity().startTime!;
  const nonce = randomUUID();
  const plant = (adoptedStart: number): void => plantRecord(lockPath, "foreign", { pid: sleeper.pid, startTime: processIdentity(sleeper.pid!).startTime, nonce, holder: "a foreign run", adopted: [{ pid: process.pid, startTime: adoptedStart }] });
  // The borrower is a child of this process, inside the run's scope: only the adopted entry's identity varies.
  const borrowed = (): string => inRunScope(nonce, `const { borrowInstrumentLock } = await import(${JSON.stringify(LOCK_OWNER)}); console.log(String(borrowInstrumentLock(${JSON.stringify(lockPath)}, "a nested run")?.owns));`);
  plant(own + 12_345);
  assert.equal(borrowed(), "undefined", "a recycled pid in this lineage is not the process the run adopted");
  plant(own);
  assert.equal(borrowed(), "false", "the adopted process itself, by its full identity, holds its child inside the run");
});

test("A RECORD'S ACQUISITION INSTANT IS AN INSTANT (security L-2): a forged line or a terminal escape in it makes the record unreadable, never a shown line", (t) => {
  const lockPath = join(createTempDir("instrument-lock-instant-"), "instrument.lock");
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 60000)"], { stdio: "ignore" });
  t.after(() => { sleeper.kill("SIGKILL"); });
  const record = join(registryOf(lockPath), "instant.lock");
  const plant = (acquiredAt: string): void => plantRecord(lockPath, "instant", { pid: sleeper.pid, startTime: processIdentity(sleeper.pid!).startTime, acquiredAt, nonce: "n", holder: "a run" });
  plant("2026\u001b[2J\nFORGED-ACQ-LINE");
  assert.equal(liveFileLockHolder(record), null, "not an instant: no record of this owner");
  plant("2026-10-08");
  assert.equal(liveFileLockHolder(record), null, "a date is not the instant the writer writes");
  plant("2026-10-08T00:00:00.000Z");
  assert.equal(liveFileLockHolder(record)?.acquiredAt, "2026-10-08T00:00:00.000Z");
});

test("THE REGISTRY IS THE HOST'S, not the HOME's: its place comes from the password database's home and config; $HOME and $XDG_CACHE_HOME never move it; it stays under that cache folder", () => {
  const config = { ...CONFIG, cacheRelativeLockPath: "bridlewise/instrument.lock" };
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
    assert.equal(instrumentLockPath(config, ENGINE), expected, "a substitute HOME and cache base do not move the host's registry");
    assert.equal(refused("/etc/instrument.lock"), true, "an absolute path");
    assert.equal(refused("../instrument.lock"), true, "out of the cache folder");
    assert.equal(refused("bridlewise/instrument.lock"), false, "under the cache folder");
  } finally {
    if (previous.home === undefined) delete process.env.HOME; else process.env.HOME = previous.home;
    if (previous.xdg === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = previous.xdg;
  }
});

test("THE SUPERVISING DOOR (`harness slot run`, the coverage run, the perf profile) admits its run while its command runs — the command, under the adopted supervisor, runs inside it — bounds its label to the program and argument count, and exits with the command's code; a signal-ended command exits 128 + its number. On a registry of the test's own (correctness L-N3)", () => {
  const lockPath = join(createTempDir("instrument-lock-door-"), "instrument.lock");
  const probe = [
    `const { borrowInstrumentLock, admittedRuns } = await import(${JSON.stringify(LOCK_OWNER)});`,
    `console.log("INSIDE " + String(borrowInstrumentLock(${JSON.stringify(lockPath)}, "the probe")?.owns === false) + " LABEL " + JSON.stringify(admittedRuns(${JSON.stringify(lockPath)})[0]?.split(" (pid")[0]));`,
    "process.exit(7);",
  ].join("\n");
  const script = join(createTempDir("instrument-lock-door-script-"), "door.mjs");
  writeFileSync(script, [
    `const { runInsideInstrumentLock } = await import(${JSON.stringify(pathToFileURL(join(ENGINE, "src", "workflow", "slot-cli.ts")).href)});`,
    "const [lockPath, label, ...command] = process.argv.slice(2);",
    "const { exitCode } = await runInsideInstrumentLock(label, Number.POSITIVE_INFINITY, command, { lockPath });",
    "process.exit(exitCode);",
  ].join("\n"));
  const door = (label: string, command: readonly string[]) => spawnSync(process.execPath, ["--experimental-strip-types", script, lockPath, label, ...command], { cwd: ENGINE, encoding: "utf8", env: process.env });
  const ran = door("slot run: node (5 argument(s))", [process.execPath, "--experimental-strip-types", "--input-type=module", "-e", probe, "secret\targument\\with a backslash"]);
  assert.equal(ran.status, 7, `the command's exit code is the door's (stderr: ${ran.stderr.slice(0, 400)})`);
  assert.match(ran.stdout, /INSIDE true LABEL "slot run: node \(5 argument\(s\)\)"/u, "the command runs inside the admitted run; the label carries no argument");
  assert.deepEqual(admittedRuns(lockPath), [], "the door releases its record when its command ends");
  assert.equal(door("a signal", ["sh", "-c", "kill -TERM $$"]).status, 143);
  // The CLI's slot run is this door, on the host's registry, heavy by kind.
  const cli = readFileSync(join(ENGINE, "src", "workflow", "slot-cli.ts"), "utf8");
  assert.ok(cli.includes('wholeInstrumentTestFileCount(declaredInstrumentLock(readTestExecutionConfig(engineRoot).instrumentLock), "slot")'), "a slot run is heavy by config's word (wholeInstruments)");
  assert.match(cli, /await runInsideInstrumentLock\(slotRunLabel\(command\), count, command\)/u);
});

test("NESTING READS ADOPTED PROCESSES TOO (correctness M2): a run whose ancestor is a process the admitted run ADOPTED (a supervisor it runs a command under) borrows it; one outside it does not", (t) => {
  const lockPath = join(createTempDir("instrument-lock-adopted-"), "instrument.lock");
  const stranger = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => { stranger.kill("SIGKILL"); });
  const holder = processIdentity(stranger.pid!);
  const parent = processIdentity(process.ppid);
  const nonce = randomUUID();
  const record = (adopted: readonly unknown[]): void => plantRecord(lockPath, "adopting", { pid: holder.pid, startTime: holder.startTime, acquiredAt: "2026-10-09T00:00:00.000Z", nonce, holder: "a door", adopted });
  const borrowedInScope = (): string => inRunScope(nonce, `const { borrowInstrumentLock } = await import(${JSON.stringify(LOCK_OWNER)}); console.log(String(borrowInstrumentLock(${JSON.stringify(lockPath)}, "a nested run")?.owns));`);
  record([]);
  assert.equal(borrowedInScope(), "undefined", "the run is no ancestor: nothing to borrow, even from inside its scope");
  record([{ pid: parent.pid, startTime: parent.startTime }]);
  assert.equal(borrowedInScope(), "false", "an adopted ancestor holds this run inside the admitted run");
  assert.equal(borrowInstrumentLock(lockPath, "a nested run"), undefined, "the same lineage OUTSIDE the run's scope borrows nothing");
});

test("THE REGISTRY'S PLACE IS REFUSED INSIDE A CHECKOUT (correctness M6): a path under the per-user cache that lies in (or around) the checkout is misplaced", () => {
  const cache = join(userInfo().homedir, ".cache");
  const checkout = createTempDir("instrument-lock-checkout-");
  requireHost(checkout.startsWith(`${cache}/`), `a run temp root under ${cache} (D-19), so a checkout can lie under the cache folder: ${checkout}`);
  spawnSync("git", ["init", "-q", checkout]);
  const relativeToCache = checkout.slice(cache.length + 1);
  assert.throws(() => instrumentLockPath({ ...CONFIG, cacheRelativeLockPath: `${relativeToCache}/inside/instrument.lock` }, checkout),
    (error: unknown) => (error as { code?: string }).code === "instrument_lock_misplaced" && /inside or around the checkout/u.test((error as Error).message));
});

test("A GRACE OF 0 IS SIGKILL AT ONCE (correctness M17): a target that ignores SIGTERM is killed, not asked", async (t) => {
  const stubborn = spawn("sh", ["-c", "trap '' TERM; while :; do sleep 1; done"], { stdio: "ignore", detached: true });
  t.after(() => { try { stubborn.kill("SIGKILL"); } catch { /* gone */ } });
  await new Promise((resolveStart) => setTimeout(resolveStart, 200));
  const ended = await terminate({ group: ownedChild(stubborn) }, { graceMs: 0 });
  assert.equal(ended.ending, "killed");
});

// From test/workflow/working-copy.test.ts: a heavy run's admission needs the host's user service manager (a cgroup
// scope), which a confined test run cannot reach (decision TEST-CONFINEMENT-SELF-BIND), so it is a live-suite fact.
test("a heavy setup command's OWN nested admission BORROWS the run its checkout command was admitted under: owns nothing, inside the run's scope, under its caps (NO-LOAD-BLOCK; a nested admission that refused or took a run of its own would leave the outer cap)", async () => {
  const target = createTempDir("working-copy-nested-admission-");
  execFileSync("git", ["init", "-q"], { cwd: target, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  writeFileSync(join(target, "a.txt"), "a\n");
  const lockPath = join(createTempDir("working-copy-nested-lock-"), "instrument.lock");
  const runner: CheckoutCommandRunner = { supervisor: ensureTestProcessSupervisor(), killGraceMs: 1_000, outputCharacters: 4_096, retries: { retries: 0, backoffMs: 0 }, instrumentLock: { lockPath, perRun: { memoryMaxPercent: 37, cpuWeight: 42 } } };
  const answer = join(target, "..", `${String(process.pid)}-nested.json`);
  const engine = join(import.meta.dirname, "..");
  const lockModule = pathToFileURL(join(engine, "src", "process", "instrument-lock.ts")).href;
  const factsModule = pathToFileURL(join(engine, "src", "process", "process-facts.ts")).href;
  const configModule = pathToFileURL(join(engine, "src", "workflow", "workflow-config.ts")).href;
  // The checkout command itself is a nested heavy run (a validate's suite does exactly this): it admits on the same registry.
  const script = [
    `const { admitInstrumentRun, admittedRuns } = await import(${JSON.stringify(lockModule)});`,
    `const { ownCgroupPath, ownCpuTimeLimit } = await import(${JSON.stringify(factsModule)});`,
    `const { SUBPROCESS_BOUNDS } = await import(${JSON.stringify(configModule)});`,
    `const { readFileSync, writeFileSync } = await import("node:fs");`,
    `const nested = admitInstrumentRun(${JSON.stringify(lockPath)}, "a nested suite", { memoryMaxPercent: 99, cpuWeight: 999 }, SUBPROCESS_BOUNDS);`,
    "const cgroup = ownCgroupPath();",
    `writeFileSync(${JSON.stringify(answer)}, JSON.stringify({ owns: nested.owns, cgroup, weight: readFileSync("/sys/fs/cgroup" + cgroup + "/cpu.weight", "utf8").trim(), limit: ownCpuTimeLimit(), runs: admittedRuns(${JSON.stringify(lockPath)}).length }));`,
    "nested.release();",
  ].join("\n");
  const command = { cwd: ".", argv: [process.execPath, "--input-type=module", "-e", script], timeoutMs: 60_000, holdsInstrumentLock: true as const };
  try {
    const ran = await runCheckoutCommand(target, "nested", command, runner);
    assert.equal(ran.status, "pass", ran.message);
    const seen = JSON.parse(readFileSync(answer, "utf8")) as { owns: boolean; cgroup: string; weight: string; limit: { soft: string; hard: string }; runs: number };
    assert.equal(seen.owns, false, "the nested admission borrows: it owns nothing");
    assert.match(seen.cgroup, /\/bridlewise-run-[0-9a-f-]+\.scope$/u, "the nested run is inside the outer run's scope");
    assert.equal(seen.weight, "42", "under the OUTER run's caps (its own requested 999 never applied)");
    assert.deepEqual(seen.limit, { soft: String(SUBPROCESS_BOUNDS.cpuLimitSeconds), hard: String(SUBPROCESS_BOUNDS.cpuLimitSeconds + SUBPROCESS_BOUNDS.cpuKillGraceSeconds) }, "under the CPU-time limit");
    assert.equal(seen.runs, 1, "one record: the outer run's; the nested admission wrote none");
  } finally {
    rmSync(answer, { force: true });
  }
});

// From test/workflow/working-copy.test.ts, for the same reason as the case above.
test("a heavy setup command is ADMITTED AT ONCE beside a live run — it never waits for another run — and runs once per tree", async () => {
  const target = createTempDir("working-copy-heavy-setup-");
  execFileSync("git", ["init", "-q"], { cwd: target, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  writeFileSync(join(target, "a.txt"), "a\n");
  const lockPath = join(createTempDir("working-copy-heavy-lock-"), "instrument.lock");
  const runner: CheckoutCommandRunner = { supervisor: ensureTestProcessSupervisor(), killGraceMs: 1_000, outputCharacters: 4_096, retries: { retries: 0, backoffMs: 0 }, instrumentLock: { lockPath, perRun: { memoryMaxPercent: 50, cpuWeight: 100 } } };
  const counter = join(target, "..", `${String(process.pid)}-runs.txt`);
  // The command counts its runs (outside the checkout, so the tree it ran for does not change).
  const command = { cwd: ".", argv: [process.execPath, "-e", `require("fs").appendFileSync(${JSON.stringify(counter)}, Date.now() + "\\n")`], timeoutMs: 60_000, holdsInstrumentLock: true as const };
  // Another admitted run is live for the whole test: the setup command runs beside it.
  const lockModule = pathToFileURL(join(import.meta.dirname, "..", "src", "process", "instrument-lock.ts")).href;
  const configModule = pathToFileURL(join(import.meta.dirname, "..", "src", "workflow", "workflow-config.ts")).href;
  const holder = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `const m = await import(${JSON.stringify(lockModule)}); const c = await import(${JSON.stringify(configModule)}); m.admitInstrumentRun(${JSON.stringify(lockPath)}, "a validate", { memoryMaxPercent: 50, cpuWeight: 100 }, c.SUBPROCESS_BOUNDS); console.log("admitted"); setTimeout(() => process.exit(0), 60_000);`], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    await new Promise<void>((resolveHeld) => holder.stdout.once("data", () => resolveHeld()));
    const first = await runCheckoutCommand(target, "warm", command, runner);
    assert.equal(first.status, "pass", first.message);
    assert.equal(holder.exitCode, null, "it ran while the other run was still live: nothing waited");
    assert.equal(readFileSync(counter, "utf8").trim().split("\n").length, 1, "it ran once");
    const again = await runCheckoutCommand(target, "warm", command, runner);
    assert.equal(again.status, "pass");
    assert.match(again.message, /already run for this tree/u);
    assert.equal(readFileSync(counter, "utf8").trim().split("\n").length, 1, "the same tree is not run again");
    writeFileSync(join(target, "a.txt"), "b\n");
    assert.equal((await runCheckoutCommand(target, "warm", command, runner)).status, "pass");
    assert.equal(readFileSync(counter, "utf8").trim().split("\n").length, 2, "another tree runs it");
  } finally {
    holder.kill("SIGKILL");
    rmSync(counter, { force: true });
  }
});
