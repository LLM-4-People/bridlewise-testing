/**
 * THE ONE BOUNDED RUN (`runCpuBounded`, src/process/supervised-run.ts, under
 * `SubprocessBounds`, src/process/subprocess-bounds.ts): a command is bounded
 * by its process GROUP's CPU time, a stall (no output and CPU under the floor),
 * its output, the kernel's CPU limit and one wall backstop for a hang, never
 * by a wall clock a loaded host runs out. Each bound is pinned by a test a
 * mutation turns red; every child these tests start ends on its own.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isProcessAlive, procfsDocument } from "../../src/process/process-facts.ts";
import { boundedEnding, type SubprocessBounds } from "../../src/process/subprocess-bounds.ts";
import { runCpuBounded } from "../../src/process/supervised-run.ts";
import { createTempDir } from "../support/temp-dir.ts";

/** Tight bounds for the runner's tests: a 400 ms CPU budget, a 600 ms stall window under a 5% CPU floor, read every 50 ms; a 2 min hang backstop. */
const TIGHT: SubprocessBounds = { cpuBudgetMs: 400, stallMs: 600, hangBackstopMs: 120_000, pollMs: 50, killGraceMs: 200, outputBytes: 1 << 20 };
const NODE = process.execPath;
const ENV = { PATH: process.env["PATH"] ?? "" };

/**
 * A node one-liner that burns `cpuMs` of its OWN CPU, user plus system (never a wall-clock wait), then runs
 * `after`. Both halves count: the loop's own `cpuUsage()` calls are system time, and a user-only loop
 * measured several times its intended work.
 */
function burn(cpuMs: number, after = ""): string {
  return `const used = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; }; const until = used() + ${String(cpuMs)}; while (used() < until) {} ${after}`;
}

/**
 * Every child these tests start ENDS ON ITS OWN, so a mutated bound fails its test by name instead of hanging the file:
 * a busy child burns at most `SPIN_CAP_MS` of CPU (ten budgets, then it exits); a quiet one exits after `QUIET_LIFE_MS`
 * (it only has to outlive a stall window). Neither judges anything: the run's ending and the assertions do.
 */
const SPIN_CAP_MS = 4_000;
const QUIET_LIFE_MS = 30_000;
const SPIN = burn(SPIN_CAP_MS);
const QUIET = `setTimeout(() => {}, ${String(QUIET_LIFE_MS)});`;

test("the bounded run: CPU spent past its budget stops the group; no output and no CPU is a stall; progress is never a stall, however long; the output bound; the exit status; stdin; no wall clock", async () => {
  // A busy loop: CPU past the budget, stopped through the owned group (with the child it spawned).
  const pidFile = join(createTempDir("bounded-runner-"), "pids");
  const burner = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(SPIN)}], { stdio: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); ${SPIN}`;
  assert.equal((await runCpuBounded(NODE, ["-e", burner], { cwd: process.cwd(), env: ENV, bounds: TIGHT })).ending, "cpu-exhausted");
  assert.equal(isProcessAlive(Number(readFileSync(pidFile, "utf8"))), false, "the command is gone");
  // Asleep: no output and no CPU for the stall window.
  assert.equal((await runCpuBounded(NODE, ["-e", QUIET], { cwd: process.cwd(), env: ENV, bounds: TIGHT })).ending, "stalled");
  // Slow but progressing: a line every 200 ms for 2.4 s — four stall windows of wall time, never a stall.
  const progressing = await runCpuBounded(NODE, ["-e", "let n = 0; const t = setInterval(() => { console.log(n); if (++n === 12) clearInterval(t); }, 200)"], { cwd: process.cwd(), env: ENV, bounds: TIGHT });
  assert.equal(progressing.ending, "exited");
  assert.equal(progressing.stdout.toString("utf8").trim().split("\n").length, 12);
  // Output past its bound, an exit status, and stdin reaching the command.
  assert.equal((await runCpuBounded(NODE, ["-e", "for (let n = 0; n < 1024; n += 1) process.stdout.write('x'.repeat(65536))"], { cwd: process.cwd(), env: ENV, bounds: { ...TIGHT, cpuBudgetMs: 60_000, outputBytes: 1 << 16 } })).ending, "output-exceeded");
  const failed = await runCpuBounded(NODE, ["-e", "process.exit(3)"], { cwd: process.cwd(), env: ENV, bounds: TIGHT });
  assert.deepEqual([failed.ending, failed.status], ["exited", 3]);
  const echoed = await runCpuBounded(NODE, ["-e", "process.stdin.pipe(process.stdout)"], { cwd: process.cwd(), env: ENV, bounds: TIGHT, input: Buffer.from("through stdin") });
  assert.equal(echoed.stdout.toString("utf8"), "through stdin");
});

test("the work-bounded run: a command that exits at once is never mistaken for an unowned or unmeasurable one (the kernel reaps before Node's exit event)", async () => {
  // Reproduced: with a 1 ms watch, an instant exit raced ownedChild (taken after the reap) and the CPU read
  // (no group member left while Node had not yet seen the exit). Both now ask procfs whether it is gone.
  const endings = new Map<string, number>();
  for (let index = 0; index < 200; index += 1) {
    const run = await runCpuBounded("true", [], { cwd: process.cwd(), env: ENV, bounds: { ...TIGHT, pollMs: 1 } });
    endings.set(run.ending, (endings.get(run.ending) ?? 0) + 1);
  }
  assert.deepEqual([...endings], [["exited", 200]]);
});

/**
 * A leader that starts a grandchild INHERITING its pipes (same process group), records the
 * grandchild's pid in `pidFile`, optionally burns `leaderBurnMs` of CPU, and exits. The
 * grandchild runs `grandchild` (a node one-liner) while holding the pipes open.
 */
function leaderWithGrandchild(pidFile: string, grandchild: string, leaderBurnMs = 0): string {
  return [
    `const { spawn } = require("node:child_process");`,
    `const g = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "inherit" });`,
    `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));`,
    `const used = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; }; const until = used() + ${String(leaderBurnMs)}; while (used() < until) {}`,
    `process.exit(0);`,
  ].join(" ");
}

test("the work-bounded run bounds the whole GROUP: a grandchild holding the pipe asleep is a stall, one burning CPU is over budget, and the leader's CPU never leaves the total when it exits", async () => {
  const dir = createTempDir("bounded-group-");
  // 1. The leader exits at once; the grandchild sleeps holding the pipe: the run lasts, then stalls, and the group dies.
  const sleeper = join(dir, "sleeper");
  const asleep = await runCpuBounded(NODE, ["-e", leaderWithGrandchild(sleeper, QUIET)], { cwd: dir, env: ENV, bounds: TIGHT });
  assert.equal(asleep.ending, "stalled");
  assert.equal(isProcessAlive(Number(readFileSync(sleeper, "utf8"))), false, "the grandchild was stopped with its group");
  // 2. The grandchild burns CPU after the leader exits: over budget, the group dies.
  const burner = join(dir, "burner");
  const burning = await runCpuBounded(NODE, ["-e", leaderWithGrandchild(burner, SPIN)], { cwd: dir, env: ENV, bounds: TIGHT });
  assert.equal(burning.ending, "cpu-exhausted");
  assert.equal(isProcessAlive(Number(readFileSync(burner, "utf8"))), false, "the burning grandchild was stopped with its group");
  // 3. The leader burns past the budget, then exits (reaped by this process) while an idle grandchild holds the pipe:
  //    its CPU stays in the total, so the run is over budget, never merely stalled.
  const spent = join(dir, "spent");
  const leaderSpent = await runCpuBounded(NODE, ["-e", leaderWithGrandchild(spent, QUIET, 700)], { cwd: dir, env: ENV, bounds: { ...TIGHT, stallMs: 5_000 } });
  assert.equal(leaderSpent.ending, "cpu-exhausted");
  assert.ok((leaderSpent.cpuMs ?? 0) > TIGHT.cpuBudgetMs, `the total kept the exited leader's work (${String(leaderSpent.cpuMs)} ms)`);
  assert.equal(isProcessAlive(Number(readFileSync(spent, "utf8"))), false);
});

test("a stopped run answers only once its GROUP is gone: a member that closes its pipes on SIGTERM and keeps running is killed before the run answers", async () => {
  const dir = createTempDir("bounded-linger-");
  const member = join(dir, "member");
  // The grandchild works in slices (so its SIGTERM handler runs), closes its stdout and stderr on SIGTERM (the run's
  // pipes close at once) and keeps working, up to its own CPU cap. Only the terminator's SIGKILL ends it.
  const lingering = `const fs = require("node:fs"); process.on("SIGTERM", () => { fs.closeSync(1); fs.closeSync(2); }); const used = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; }; const t = setInterval(() => { const until = used() + 20; while (used() < until) {} if (used() > ${String(SPIN_CAP_MS)}) clearInterval(t); }, 0);`;
  const run = await runCpuBounded(NODE, ["-e", leaderWithGrandchild(member, lingering)], { cwd: dir, env: ENV, bounds: TIGHT });
  assert.equal(run.ending, "cpu-exhausted");
  assert.equal(isProcessAlive(Number(readFileSync(member, "utf8"))), false, "the member that let go of the pipes was still running when the run answered");
});

test("the kernel backstop: a process that LEFT the group (setsid, NB-1) is still ended at its own CPU-time limit (RLIMIT_CPU, SIGXCPU); the command itself is exec'd", async () => {
  const dir = createTempDir("bounded-rlimit-");
  // The leader starts, in a session of its own (out of the group: no budget, no stop reaches it), a shell that runs a
  // burner and records how it ended, then exits. The burner burns up to SPIN_CAP_MS of CPU; at its soft limit (2 s for
  // TIGHT: ceil((400 + 2 × 50 + 200) / 1000) + 1) the kernel ends it with SIGXCPU (status 128 + 24). Without the
  // backstop it burns its cap and exits 0. (A JavaScript SIGXCPU handler never runs: the busy loop holds the event loop.)
  const escapee = join(dir, "escapee");
  const record = join(dir, "ended");
  const parent = join(dir, "parent");
  const run = await runCpuBounded(NODE, ["-e", [
    `require("node:fs").writeFileSync(${JSON.stringify(parent)}, String(process.ppid));`,
    `const g = require("node:child_process").spawn("/bin/sh", ["-c", '"$0" -e "$1"; echo $? > "$2"', process.execPath, ${JSON.stringify(SPIN)}, ${JSON.stringify(record)}], { detached: true, stdio: "ignore" });`,
    `require("node:fs").writeFileSync(${JSON.stringify(escapee)}, String(g.pid)); g.unref();`,
  ].join(" ")], { cwd: dir, env: ENV, bounds: TIGHT });
  assert.equal(run.ending, "exited");
  assert.equal(Number(readFileSync(parent, "utf8")), process.pid, "the command was exec'd: its parent is this process, no shell between");
  const pid = Number(readFileSync(escapee, "utf8"));
  // The escapee ends on its own either way (the burner's CPU cap): wait for that, never for a clock.
  while (isProcessAlive(pid)) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(readFileSync(record, "utf8").trim(), String(128 + constants.signals.SIGXCPU), "the escapee's burner was ended by the kernel's CPU-time limit (SIGXCPU), not its own cap");
});

test("the endings no budget decides, each pinned: SIGXCPU is `cpu-rlimit`; a poller doing any CPU work is progressing, never stalled; a run past the wall backstop is hung", async () => {
  const dir = createTempDir("bounded-endings-");
  // A command the kernel's CPU limit ends (SIGXCPU) ends `cpu-rlimit`, worded as the kernel's limit, never `exited`.
  const xcpu = await runCpuBounded(NODE, ["-e", `process.kill(process.pid, "SIGXCPU"); ${QUIET}`], { cwd: dir, env: ENV, bounds: TIGHT });
  assert.equal(xcpu.ending, "cpu-rlimit");
  assert.match(boundedEnding(xcpu, TIGHT), /CPU-time limit of 2 s of CPU work \(RLIMIT_CPU, the kernel backstop\) and was ended by SIGXCPU/u);
  // ANY CPU work is progress (no rate: a rate is a load threshold, and a busy host would judge the command): a
  // poller that wakes every 200 ms for 2 ms of work (about 1% of a core) prints nothing, outlives the stall window,
  // and exits: under any rate floor it would be stopped.
  const poller = await runCpuBounded(NODE, ["-e", `const used = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; }; setInterval(() => { const until = used() + 2; while (used() < until) {} }, 200); setTimeout(() => process.exit(0), 2_500);`], { cwd: dir, env: ENV, bounds: { ...TIGHT, cpuBudgetMs: 60_000, stallMs: 1_000 } });
  assert.equal(poller.ending, "exited", `a poller doing CPU work is progressing (${String(poller.cpuMs)} ms of CPU)`);
  // The hang backstop, the one wall bound: a run that keeps printing (progress) is still stopped at it, as hung.
  const chatty = await runCpuBounded(NODE, ["-e", `setInterval(() => console.log("."), 100); setTimeout(() => process.exit(0), 10_000);`], { cwd: dir, env: ENV, bounds: { ...TIGHT, cpuBudgetMs: 60_000, hangBackstopMs: 1_000 } });
  assert.equal(chatty.ending, "hung");
  assert.match(boundedEnding(chatty, { ...TIGHT, hangBackstopMs: 1_000 }), /^HUNG: it was still running at the 1 s hang backstop \(wall\)/u);
});

test("NO-LOAD: a busy command a loaded host starves of its core is NEVER stalled (its run-queue wait is not held against it); a blocked one is", async () => {
  const dir = createTempDir("bounded-starved-");
  // One CPU this process may use; the command and the load are pinned to it.
  const allowed = /Cpus_allowed_list:\s*(\d+)/u.exec(procfsDocument("self", "status") ?? "")?.[1] ?? "0";
  const ready = join(dir, "ready");
  // The command: lowest priority, busy for 5 s of wall time, printing nothing. Once the load starts it gets almost
  // no CPU (no clock tick for seconds): only its wait on the run queue explains the silence.
  const command = `require("node:os").setPriority(19); require("node:fs").writeFileSync(${JSON.stringify(ready)}, "x"); const end = Date.now() + 5_000; while (Date.now() < end) {}`;
  const run = runCpuBounded("taskset", ["-c", allowed, NODE, "-e", command], { cwd: dir, env: ENV, bounds: { ...TIGHT, cpuBudgetMs: 60_000, stallMs: 1_500, hangBackstopMs: 60_000 } });
  while (!existsSync(ready)) await new Promise((resolve) => setTimeout(resolve, 20));
  const hogs = Array.from({ length: 8 }, () => spawn("taskset", ["-c", allowed, NODE, "-e", "const end = Date.now() + 6_000; while (Date.now() < end) {}"], { stdio: "ignore" }));
  try {
    const starved = await run;
    assert.equal(starved.ending, "exited", "a command starved of its core by load is working, never stalled");
  } finally {
    for (const hog of hogs) hog.kill("SIGKILL");
  }
  // Blocked (asleep on nothing, never waiting for a core): it IS a stall, worded as one.
  const blocked = await runCpuBounded(NODE, ["-e", QUIET], { cwd: dir, env: ENV, bounds: TIGHT });
  assert.equal(blocked.ending, "stalled");
  assert.match(boundedEnding(blocked, TIGHT), /no output and no CPU work for 600 ms of the time it could run \(stalled\)/u);
});

test("the work-bounded run's bounds, each pinned by a test a mutation turns red (S1, S2, P1, G1)", async () => {
  const dir = createTempDir("bounded-bounds-");
  // S1: a missing, non-finite or zero bound is refused at call time, before anything runs (never a hang).
  const marker = join(dir, "ran");
  for (const name of ["cpuBudgetMs", "stallMs", "hangBackstopMs", "pollMs", "killGraceMs", "outputBytes"] as const) {
    for (const value of [undefined, Number.NaN, 0]) {
      const bounds = { ...TIGHT, [name]: value } as unknown as SubprocessBounds;
      await assert.rejects(runCpuBounded(NODE, ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`], { cwd: dir, env: ENV, bounds }), (error: Error & { code?: string }) => error.code === "cpu_bounds_invalid" && error.message.includes(name), `${name}=${String(value)}`);
    }
  }
  await assert.rejects(runCpuBounded(NODE, ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`], { cwd: dir, env: ENV, bounds: { ...TIGHT, pollMs: TIGHT.stallMs } }), (error: Error & { code?: string }) => error.code === "cpu_bounds_invalid" && error.message.includes("pollMs"));
  assert.equal(existsSync(marker), false, "nothing was spawned under an invalid bound");
  // S2: CPU is progress: a child busy for four stall windows of CPU, printing nothing, exits; it is never stalled.
  const busy = await runCpuBounded(NODE, ["-e", burn(1_200)], { cwd: dir, env: ENV, bounds: { ...TIGHT, cpuBudgetMs: 60_000, stallMs: 300 } });
  assert.equal(busy.ending, "exited");
  // P1: a child the leader forks in a group of its OWN (so no member sample ever sees it), which burns CPU, exits and is
  //     reaped by the leader, counts — only through the leader's reaped-child time (proc(5) cutime/cstime).
  const reaped = await runCpuBounded(NODE, ["-e", `require("node:child_process").spawnSync(process.execPath, ["-e", ${JSON.stringify(burn(700))}], { stdio: "ignore", detached: true }); ${QUIET}`], { cwd: dir, env: ENV, bounds: { ...TIGHT, stallMs: 5_000 } });
  assert.equal(reaped.ending, "cpu-exhausted", "the reaped child's 700 ms passed the 400 ms budget");
  // G1: two live grandchildren each burn under the budget (900 ms of work plus node's start, under 1,500 ms);
  //     their SUM is over it (a maximum per member would never see the budget spent).
  const pids = join(dir, "split");
  const split = await runCpuBounded(NODE, ["-e", [
    `const { spawn } = require("node:child_process");`,
    `const a = spawn(process.execPath, ["-e", ${JSON.stringify(burn(900, QUIET))}], { stdio: "inherit" });`,
    `const b = spawn(process.execPath, ["-e", ${JSON.stringify(burn(900, QUIET))}], { stdio: "inherit" });`,
    `require("node:fs").writeFileSync(${JSON.stringify(pids)}, a.pid + " " + b.pid);`,
    `process.exit(0);`,
  ].join(" ")], { cwd: dir, env: ENV, bounds: { ...TIGHT, cpuBudgetMs: 1_500, stallMs: 5_000 } });
  assert.equal(split.ending, "cpu-exhausted", "two members' work, each under the 1,500 ms budget, passed it together");
  for (const pid of readFileSync(pids, "utf8").split(" ").map(Number)) assert.equal(isProcessAlive(pid), false, "both grandchildren were stopped with the group");
  // G1, a VANISHED member: the leader burns 60% of the budget and exits; only then does its grandchild burn another 60%.
  //     The grandchild learns the leader is gone from its stdin, a pipe only the leader holds, reaching end of file
  //     (Node caches `process.ppid`, so a reparenting is never seen). The leader's work must stay in the sum after it
  //     is gone: a maximum per member, or a total of live members only, sees about 60% and passes it.
  const later = join(dir, "later");
  const vanished = await runCpuBounded(NODE, ["-e", [
    `const { spawn } = require("node:child_process");`,
    burn(900),
    `const g = spawn(process.execPath, ["-e", ${JSON.stringify(`process.stdin.on("end", () => { ${burn(900, QUIET)} }); process.stdin.resume();`)}], { stdio: ["pipe", "inherit", "inherit"] });`,
    `require("node:fs").writeFileSync(${JSON.stringify(later)}, String(g.pid));`,
    `process.exit(0);`,
  ].join(" ")], { cwd: dir, env: ENV, bounds: { ...TIGHT, cpuBudgetMs: 1_500, stallMs: 5_000 } });
  assert.equal(vanished.ending, "cpu-exhausted", "the exited leader's 900 ms and its grandchild's later 900 ms passed the 1,500 ms budget together");
  assert.equal(isProcessAlive(Number(readFileSync(later, "utf8"))), false, "the grandchild was stopped with the group");
});
