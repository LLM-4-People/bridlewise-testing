/**
 * THE ONE TEST-RUN SUPERVISOR (`src/process/supervised-run.ts`), driven over
 * the real native primitive: nothing a supervised command starts survives it
 * (the orphaned `leak.test.ts` finding: a file the engine watchdog aborted
 * ran on for 75 minutes with ppid 1), a command reporting on its fd 3 keeps
 * its channel, a stop reaches the command before the kill, and a receipt is
 * checked, never cast.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { ensureTestProcessSupervisor } from "../../guardian/build.ts";
import { runRecordedCommand } from "../../scripts/tooling/recorded-command.ts";
import { isProcessAlive } from "../../src/process/process-facts.ts";
import { readSupervisorReceipt, runBoundedTestProcess, startDetached, superviseCommand } from "../../src/process/supervised-run.ts";
import { openUnattendedLog } from "../../src/workflow/promotion/last-run.ts";
import { createTempDir } from "../support/temp-dir.ts";

/** A command that starts a DETACHED grandchild (its own session), records its pid, reports on fd 3, then exits. */
function leavesAGrandchild(pidFile: string, exitCode: number): string {
  return `const { spawn } = require("node:child_process"); const { writeFileSync, writeSync } = require("node:fs");
    const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    grandchild.unref();
    writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
    writeSync(3, "result-bytes");
    process.exit(${String(exitCode)});`;
}

test("a supervised command's detached grandchild does not survive it, and its fd-3 report is passed through", async () => {
  const pidFile = join(createTempDir("supervised-run-"), "grandchild.pid");
  const result: Buffer[] = [];
  const run = await superviseCommand({
    supervisor: ensureTestProcessSupervisor(), command: process.execPath, args: ["-e", leavesAGrandchild(pidFile, 4)],
    hardCeilingMs: 60_000, killGraceMs: 500, onStdout: () => undefined, onStderr: () => undefined, onResult: (chunk) => result.push(chunk),
  });
  const grandchild = Number(readFileSync(pidFile, "utf8"));
  assert.equal(run.ending, "exited");
  assert.equal(run.exitCode, 4, "the command's own exit code");
  assert.equal(Buffer.concat(result).toString("utf8"), "result-bytes");
  assert.ok(run.supervision?.killed.includes(grandchild), `the grandchild ${String(grandchild)} was not killed: ${JSON.stringify(run.supervision)}`);
  assert.equal(isProcessAlive(grandchild), false, "the detached grandchild outlived the supervised run");
});

test("a STOP reaches the command first (SIGTERM, within the grace), then the run ends as stopped", async () => {
  const stop = new AbortController();
  const result: Buffer[] = [];
  const script = `const { writeSync } = require("node:fs");
    process.on("SIGTERM", () => { writeSync(3, "terminated-gracefully"); process.exit(0); });
    writeSync(1, "ready\\n"); setInterval(() => {}, 1000);`;
  const running = superviseCommand({
    supervisor: ensureTestProcessSupervisor(), command: process.execPath, args: ["-e", script], hardCeilingMs: 60_000, killGraceMs: 5_000,
    onStdout: (chunk) => { if (chunk.toString("utf8").includes("ready")) stop.abort(); }, onStderr: () => undefined,
    onResult: (chunk) => result.push(chunk), stop: stop.signal,
  });
  const run = await running;
  assert.equal(run.ending, "stopped");
  assert.equal(run.exitCode, 1, "a stopped run is a failed run");
  assert.equal(Buffer.concat(result).toString("utf8"), "terminated-gracefully", "the command never heard the stop");
});

test("the recorded command (the engine worker's launch) runs supervised: the observation holds, and nothing it started survives", async () => {
  const pidFile = join(createTempDir("supervised-recorded-"), "grandchild.pid");
  const observation = await runRecordedCommand({
    arguments: ["-e", leavesAGrandchild(pidFile, 0)],
    cwd: process.cwd(),
    supervision: { supervisor: ensureTestProcessSupervisor(), hardCeilingMs: 60_000, killGraceMs: 500 },
  });
  assert.equal(observation.exitCode, 0);
  assert.equal(observation.spawnErrorCode, null);
  assert.equal(observation.resultPipe.bytes.toString("utf8"), "result-bytes");
  assert.equal(observation.resultPipe.complete, true);
  assert.equal(isProcessAlive(Number(readFileSync(pidFile, "utf8"))), false, "the worker's descendant outlived the run");
});

test("a receipt is CHECKED: a malformed or truncated last line is an absent receipt, never a cast", () => {
  const announce = `{"announcedCommandPid":42}\n`;
  const good = `{"commandPid":42,"status":0,"timedOut":false,"interrupted":false,"commandKilled":false,"reaped":[{"pid":43,"status":9,"killed":true}],"noOwnedChildren":true,"waitedCpuUs":1,"supervisorCpuUsBeforeReceipt":2}\n`;
  const read = readSupervisorReceipt(announce + good);
  assert.equal(read.announcedCommandPid, 42);
  assert.deepEqual(read.receipt?.killed, [43]);
  for (const broken of [
    good.replace('"status":0', '"status":"0"'),
    good.replace('{"pid":43,"status":9,"killed":true}', '{"pid":43}'),
    good.replace(',"waitedCpuUs":1', ""),
    good.slice(0, 40),
  ]) {
    const refused = readSupervisorReceipt(announce + broken);
    assert.equal(refused.receipt, undefined, `a malformed receipt was accepted: ${broken}`);
    assert.equal(refused.announcedCommandPid, 42, "the announcement still names the command's group");
  }
});

/**
 * A FAKE supervisor (a shell script in the native binary's place) that
 * leaves a background process holding every pipe it was given, records that
 * holder's pid, then either exits at once or never closes (`sleep`). The
 * holder is killed by the caller.
 */
function fakeSupervisor(ending: "exits" | "never-closes"): Readonly<{ path: string; holderPid: () => number }> {
  const dir = createTempDir("supervised-fake-");
  const pidFile = join(dir, "holder.pid");
  const path = join(dir, "fake-supervisor");
  writeFileSync(path, `#!/bin/sh\nsleep 30 &\necho $! > ${JSON.stringify(pidFile)}\n${ending === "exits" ? "exit 0" : "sleep 30"}\n`);
  chmodSync(path, 0o755);
  return { path, holderPid: () => Number(readFileSync(pidFile, "utf8")) };
}

function killQuietly(pid: number): void {
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

test("runBoundedTestProcess is ITSELF bounded: a supervisor that never closes (a holder keeps its pipes) is refused within the ceiling plus two graces", (t) => {
  const fake = fakeSupervisor("never-closes");
  t.after(() => killQuietly(fake.holderPid()));
  assert.throws(
    () => runBoundedTestProcess(fake.path, process.execPath, ["-e", "0"], { timeoutMs: 1_000, killGraceMs: 200 }),
    (error: unknown) => (error as { code?: string }).code === "test_process_supervisor_failed",
  );
  // ENDED BY ITS BOUND, observed by its path, never by a wall clock
  // (NO-LOAD-BLOCK): the fake would have held the call until its holder's
  // 30 s sleep ended, and the holder is still alive, so the bound ended it.
  assert.equal(isProcessAlive(fake.holderPid()), true, "the launch waited for the holder to let go of its pipes");
});

test("the run is EXIT-BACKED: a supervisor that exits while a holder keeps its pipes settles within the grace, unverified and with its output marked incomplete", async (t) => {
  const fake = fakeSupervisor("exits");
  t.after(() => killQuietly(fake.holderPid()));
  const run = await superviseCommand({
    supervisor: fake.path, command: process.execPath, args: ["-e", "0"], hardCeilingMs: 60_000, killGraceMs: 300,
    onStdout: () => undefined, onStderr: () => undefined,
  });
  assert.equal(run.ending, "unverified", "no receipt came, so the run is not certified");
  assert.equal(run.outputComplete, false, "a pipe a holder kept open was reported complete");
  // SETTLED BY THE EXIT, observed by its path (NO-LOAD-BLOCK): the holder
  // keeps the pipes open for 30 s and is still alive, so the run did not wait for them.
  assert.equal(isProcessAlive(fake.holderPid()), true, "the run waited for pipes a holder kept open");
});

test("the recorded command marks its pipes INCOMPLETE when the supervised output did not end (the observation never claims bytes it did not see end)", async (t) => {
  const fake = fakeSupervisor("exits");
  t.after(() => killQuietly(fake.holderPid()));
  const observation = await runRecordedCommand({
    arguments: ["-e", "0"], cwd: process.cwd(), supervision: { supervisor: fake.path, hardCeilingMs: 60_000, killGraceMs: 300 },
  });
  assert.equal(observation.spawnErrorCode, "test_process_supervisor_unverified");
  for (const pipe of [observation.stdout, observation.stderr, observation.resultPipe]) assert.equal(pipe.complete, false);
});

test("a stop requested BEFORE the supervisor announced its command still reaches the command as SIGTERM (never a supervisor killed before it held its signals)", async () => {
  // Measured: a SIGTERM sent at once killed the supervisor before it blocked
  // its signals in 86 of 100 runs (no receipt, "unverified"). Repeated, so a
  // race the timing sometimes wins is still caught.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const stop = new AbortController();
    stop.abort();
    const run = await superviseCommand({
      supervisor: ensureTestProcessSupervisor(), command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], hardCeilingMs: 60_000, killGraceMs: 5_000,
      onStdout: () => undefined, onStderr: () => undefined, stop: stop.signal,
    });
    assert.equal(run.ending, "stopped", `attempt ${String(attempt)}: ${run.ending}`);
    assert.equal(run.signal, "SIGTERM", `the command was not stopped by the forwarded SIGTERM: ${JSON.stringify(run.supervision)}`);
    assert.equal(run.supervision?.commandKilled, false, "the command was killed instead of stopped");
  }
});

test("DRIVEN: a terminal Ctrl-C (SIGINT to the runner's whole process group) is ONE stop: the command gets its grace (wf-1b3a-correctness L3)", async (t) => {
  const dir = createTempDir("supervised-ctrl-c-");
  const graceful = join(dir, "graceful");
  const ready = join(dir, "ready");
  const owner = new URL("../../src/process/supervised-run.ts", import.meta.url).href;
  const command = `const { writeFileSync } = require("node:fs");
    process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(graceful)}, "yes"); process.exit(0); });
    writeFileSync(${JSON.stringify(ready)}, "1"); setInterval(() => {}, 1000);`;
  const runner = `const { superviseCommand } = await import(${JSON.stringify(owner)});
    const run = await superviseCommand({ supervisor: ${JSON.stringify(ensureTestProcessSupervisor())}, command: process.execPath,
      args: ["-e", ${JSON.stringify(command)}], hardCeilingMs: 60_000, killGraceMs: 10_000,
      onStdout: () => undefined, onStderr: () => undefined, killOnInterrupt: true });
    process.stdout.write(JSON.stringify({ ending: run.ending, status: run.status, commandKilled: run.supervision?.commandKilled }));`;
  // The runner leads its own group, as a shell's foreground job does.
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", runner], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* ended */ } });
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
  const deadline = Date.now() + 30_000;
  while (!existsSync(ready) && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  assert.ok(existsSync(ready), "the supervised command never started");
  process.kill(-child.pid!, "SIGINT");
  await new Promise((resolveExit) => child.once("close", resolveExit));
  const ended = JSON.parse(out) as { ending: string; status: number; commandKilled: boolean };
  assert.equal(existsSync(graceful), true, `the command never got its grace: ${out}`);
  assert.deepEqual([ended.ending, ended.status, ended.commandKilled], ["stopped", 0, false]);
});

test("the grace is the CALLER's (the suite watchdog's killGraceMs): a command that ignores its stop is killed when that grace ends", async () => {
  const stop = new AbortController();
  const run = await superviseCommand({
    supervisor: ensureTestProcessSupervisor(), command: process.execPath,
    args: ["-e", `process.on("SIGTERM", () => {}); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);`],
    hardCeilingMs: 60_000, killGraceMs: 300,
    onStdout: (chunk) => { if (chunk.toString("utf8").includes("ready")) stop.abort(); }, onStderr: () => undefined, stop: stop.signal,
  });
  assert.equal(run.supervision?.commandKilled, true, "a command ignoring its stop was not killed");
  // KILLED AT THE GRACE, read from the supervisor's own receipt (NO-LOAD-BLOCK):
  // a kill that waited for the 60 s hard ceiling records that it timed out.
  // (`run.ending` cannot tell them apart: a stopped run is "stopped" either way.)
  assert.equal(run.supervision?.timedOut, false, "the stop's grace ended the command, not the hard ceiling");
});

test("DRIVEN: a runner that DIES (SIGKILL) stops its supervisor (the parent-death signal): the command gets its grace, and nothing outlives the runner", async (t) => {
  // The supervisor leads its own process group (a terminal's Ctrl-C reaches
  // the runner alone), so the runner's death reaches it as its parent-death signal.
  const dir = createTempDir("supervised-runner-death-");
  const graceful = join(dir, "graceful");
  const ready = join(dir, "ready");
  const owner = new URL("../../src/process/supervised-run.ts", import.meta.url).href;
  const command = `const { writeFileSync } = require("node:fs");
    process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(graceful)}, "yes"); process.exit(0); });
    writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);`;
  const runner = `const { superviseCommand } = await import(${JSON.stringify(owner)});
    await superviseCommand({ supervisor: ${JSON.stringify(ensureTestProcessSupervisor())}, command: process.execPath,
      args: ["-e", ${JSON.stringify(command)}], hardCeilingMs: 60_000, killGraceMs: 10_000,
      onStdout: () => undefined, onStderr: () => undefined });`;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", runner], { stdio: "ignore" });
  t.after(() => { if (existsSync(ready)) killQuietly(Number(readFileSync(ready, "utf8"))); });
  const deadline = Date.now() + 30_000;
  while (!existsSync(ready) && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  assert.ok(existsSync(ready), "the supervised command never started");
  child.kill("SIGKILL");
  const until = Date.now() + 15_000;
  while (!existsSync(graceful) && Date.now() < until) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  assert.equal(existsSync(graceful), true, "the runner died and its supervised command was never stopped");
});

/**
 * The supervisor launched bare (its fd 3 a pipe), over a command that answers
 * SIGTERM by writing `graceful` after `delayMs` (so the grace has a window),
 * stopped by `stops` (signals to the SUPERVISOR, in order, 20 ms apart, once
 * the command is ready). Answers the receipt and whether the grace was given.
 */
async function stoppedBare(stops: readonly NodeJS.Signals[], delayMs: number): Promise<Readonly<{ receipt: ReturnType<typeof readSupervisorReceipt>["receipt"]; graceful: boolean }>> {
  const dir = createTempDir("supervised-bare-");
  const graceful = join(dir, "graceful");
  const ready = join(dir, "ready");
  const command = `const { writeFileSync } = require("node:fs");
    process.on("SIGTERM", () => setTimeout(() => { writeFileSync(${JSON.stringify(graceful)}, "yes"); process.exit(0); }, ${String(delayMs)}));
    writeFileSync(${JSON.stringify(ready)}, "1"); setInterval(() => {}, 1000);`;
  const supervisor = spawn(ensureTestProcessSupervisor(), ["60000", "10000", process.execPath, "-e", command], { stdio: ["ignore", "ignore", "ignore", "pipe"] });
  let receipt = "";
  (supervisor.stdio[3] as NodeJS.ReadableStream).on("data", (chunk: Buffer) => { receipt += chunk.toString("utf8"); });
  // Listened for before any stop: a kill at once closes it within the 20 ms below.
  const closed = new Promise((resolveExit) => supervisor.once("close", resolveExit));
  const deadline = Date.now() + 30_000;
  while (!existsSync(ready) && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  assert.ok(existsSync(ready), "the supervised command never started");
  for (const signal of stops) {
    supervisor.kill(signal);
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  await closed;
  return { receipt: readSupervisorReceipt(receipt).receipt, graceful: existsSync(graceful) };
}

test("the runner's death is ONE stop: its parent-death signal repeated (a dying multi-threaded runner reparents once per thread) never cuts the command's grace (PROMO01-SUPERVISOR-PDEATH)", async () => {
  // SIGUSR1 is the supervisor's parent-death signal (RUNNER_DEATH_SIGNAL in
  // the C source): three deliveries of one death, as measured.
  const run = await stoppedBare(["SIGUSR1", "SIGUSR1", "SIGUSR1"], 300);
  assert.equal(run.graceful, true, `the command never got its grace: ${JSON.stringify(run.receipt)}`);
  assert.deepEqual([run.receipt?.interrupted, run.receipt?.commandKilled, run.receipt?.status], [true, false, 0]);
});

test("after the runner's death, a REAL second stop still kills at once", async () => {
  const run = await stoppedBare(["SIGUSR1", "SIGTERM"], 2_000);
  assert.equal(run.graceful, false, "a second real stop waited for the grace");
  assert.deepEqual([run.receipt?.interrupted, run.receipt?.commandKilled], [true, true]);
});

test("startDetached: a background run's stderr lands in the open log its caller hands it (an unattended promotion's own log: private, never truncated by the next launch, M3), its stdout nowhere", async () => {
  const workDirectory = join(createTempDir("supervised-run-detached-"), "promotion", "pair");
  const launch = (script: string, now: number): Readonly<{ pid: number; path: string }> => {
    const log = openUnattendedLog(workDirectory, now);
    try {
      return { pid: startDetached(process.execPath, ["-e", script], { cwd: workDirectory, env: process.env, stderr: log.fd }), path: log.path };
    } finally {
      closeSync(log.fd);
    }
  };
  // A run still writing when the next one is launched (a coalesced launch) keeps its whole log.
  const first = launch(`process.stdout.write("out"); process.stderr.write("the first run's head\\n"); setTimeout(() => process.stderr.write("the first run's tail\\n"), 400);`, 1_000);
  await new Promise((resolve) => setTimeout(resolve, 150));
  const second = launch(`process.stderr.write("the second")`, 2_000);
  for (const { pid } of [first, second]) {
    for (let waited = 0; isProcessAlive(pid) && waited < 100; waited += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.notEqual(first.path, second.path);
  assert.equal(readFileSync(first.path, "utf8"), "the first run's head\nthe first run's tail\n", "the running run's log is whole: never truncated, no hole");
  assert.equal(readFileSync(second.path, "utf8"), "the second", "each run its own log only");
  for (const { path } of [first, second]) assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("ONE way to the supervisor: ensureTestProcessSupervisor builds once per process, and nothing else names the binary (#293)", () => {
  // Once per process: a second call runs no make. The child's PATH leads to a `make` that counts its runs in a
  // file, then runs the real one (the build is a bounded run, so the count is taken where the process starts).
  const owner = pathToFileURL(new URL("../../guardian/build.ts", import.meta.url).pathname).href;
  const shims = createTempDir("supervisor-make-shim-");
  const counter = join(shims, "makes");
  const realMake = spawnSync("sh", ["-c", "command -v make"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(join(shims, "make"), `#!/bin/sh\necho run >> ${JSON.stringify(counter)}\nexec ${JSON.stringify(realMake)} "$@"\n`);
  chmodSync(join(shims, "make"), 0o755);
  const script = `const {ensureTestProcessSupervisor}=await import(${JSON.stringify(owner)});
    const first=ensureTestProcessSupervisor(),second=ensureTestProcessSupervisor();console.log(JSON.stringify({same:first===second}));`;
  const child = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, PATH: `${shims}:${process.env["PATH"] ?? ""}` } });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout.trim().split("\n").at(-1)!), { same: true });
  assert.equal(readFileSync(counter, "utf8").trim().split("\n").length, 1, "make ran once for two calls");
  assert.ok(statSync(ensureTestProcessSupervisor()).isFile());
  // Nothing else spells the binary's path: the only way to it is the function that builds it first.
  const repository = new URL("../../../", import.meta.url).pathname;
  const spelled = spawnSync("git", ["grep", "-l", "-e", ["build", "test-process-supervisor"].join("/"), "--", "*.ts", "*.mjs", "*.js"], { cwd: repository, encoding: "utf8" });
  assert.deepEqual(spelled.stdout.split("\n").filter(Boolean), ["engine/guardian/build.ts"]);
});
