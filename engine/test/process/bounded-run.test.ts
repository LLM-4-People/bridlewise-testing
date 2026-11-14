/**
 * THE ONE BOUNDED RUN (`runCpuBounded`, src/process/supervised-run.ts, under
 * `SubprocessBounds`, src/process/subprocess-bounds.ts): a command is bounded
 * by its process GROUP's CPU time, a stall (no output and no CPU work while it could run),
 * its output, the kernel's CPU limit and one wall backstop for a hang, never
 * by a wall clock a loaded host runs out. Each bound is pinned by a test a
 * mutation turns red; every child these tests start ends on its own.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isProcessAlive, isProcessIdentityLive, ownedChild, procfsDocument, terminate } from "../../src/process/process-facts.ts";
import { boundedEnding, kernelCpuLimit, snapshotSubprocessBounds, type SubprocessBounds } from "../../src/process/subprocess-bounds.ts";
import { boundedRunDiagnostic, runBoundedTestProcess, runCpuBounded } from "../../src/process/supervised-run.ts";
import { ensureTestProcessSupervisor } from "../../guardian/build.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { guarded, PROCESS_FAULT_EXIT_CODE } from "../../src/process/fault-policy.ts";

/** Tight bounds for the runner's tests: a 400 ms CPU budget, a 600 ms window with neither output nor CPU work, read every 50 ms; a 2 min hang backstop. */
const TIGHT: SubprocessBounds = { cpuBudgetMs: 400, stallMs: 600, hangBackstopMs: 120_000, pollMs: 50, killGraceMs: 200, outputBytes: 1 << 20 };
const NODE = process.execPath;
const ENV = { PATH: process.env["PATH"] ?? "" };

test("the canonical bounds snapshot admits only known scalar bounds, freezes their values and never reads compatible extras", () => {
  const sentinel = "DIAGNOSTIC_PRIVATE_EXTRA_SENTINEL";
  let extraReads = 0;
  const caller = { ...TIGHT, command: sentinel, environment: { TOKEN: sentinel }, output: sentinel };
  Object.defineProperty(caller, "credential", { enumerable: true, get: () => { extraReads += 1; return sentinel; } });
  const snapshot = snapshotSubprocessBounds(caller);
  assert.deepEqual(snapshot, TIGHT);
  assert.deepEqual(Object.keys(snapshot).sort(), Object.keys(TIGHT).sort());
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(extraReads, 0, "the canonical projection never touches an unknown getter");
  assert.equal(JSON.stringify(snapshot).includes(sentinel), false);
  let knownReads = 0;
  const changing = { ...TIGHT, get cpuBudgetMs(): number { knownReads += 1; return knownReads === 1 ? TIGHT.cpuBudgetMs : 1; } };
  assert.deepEqual(snapshotSubprocessBounds(changing), TIGHT);
  assert.equal(knownReads, 1, "known getters are captured once before validating the owned snapshot");
  const kernelBefore = kernelCpuLimit(snapshot);
  for (const key of Object.keys(TIGHT) as (keyof SubprocessBounds)[]) caller[key] += 1;
  assert.deepEqual(snapshot, TIGHT, "caller mutation cannot change admitted execution/record values");
  assert.deepEqual(kernelCpuLimit(snapshot), kernelBefore);
  assert.equal(Reflect.set(snapshot, "cpuBudgetMs", TIGHT.cpuBudgetMs + 1), false);
});

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
function leaderWithGrandchild(pidFile: string, grandchild: string, leaderBurnMs = 0, rendezvous?: Readonly<{ detached: boolean; admitFile: string; readyFile: string }>): string {
  const stdio = rendezvous === undefined ? '"inherit"' : '["ignore", "inherit", "inherit", "ipc"]';
  const detached = rendezvous?.detached === true ? ", detached: true" : "";
  return [
    `const { spawn } = require("node:child_process");`,
    `const g = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: ${stdio}${detached} });`,
    `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));`,
    `const used = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; }; const until = used() + ${String(leaderBurnMs)}; while (used() < until) {}`,
    rendezvous === undefined ? `process.exit(0);` : `const fs = require("node:fs"); let ready = false; let admitted = false; const finish = () => { if (!ready || admitted || !fs.existsSync(${JSON.stringify(rendezvous.admitFile)})) return; admitted = true; admission.close(); process.exit(0); }; const admission = fs.watch(require("node:path").dirname(${JSON.stringify(rendezvous.admitFile)}), finish); g.once("message", (message) => { if (message === "ready") { ready = true; fs.writeFileSync(${JSON.stringify(rendezvous.readyFile)}, "ready"); finish(); } }); finish();`,
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

test("the bounded ending: SIGXCPU is `cpu-rlimit`", async () => {
  const dir = createTempDir("bounded-endings-");
  // A command the kernel's CPU limit ends (SIGXCPU) ends `cpu-rlimit`, worded as the kernel's limit, never `exited`.
  const xcpu = await runCpuBounded(NODE, ["-e", `process.kill(process.pid, "SIGXCPU"); ${QUIET}`], { cwd: dir, env: ENV, bounds: TIGHT });
  assert.equal(xcpu.ending, "cpu-rlimit", boundedRunDiagnostic(xcpu));
  assert.match(boundedEnding(xcpu, TIGHT), /CPU-time limit of 2 s of CPU work \(RLIMIT_CPU, the kernel backstop\) and was ended by SIGXCPU/u, boundedRunDiagnostic(xcpu));
});

test("the bounded ending: a poller doing any CPU work is progressing, never stalled", async () => {
  const dir = createTempDir("bounded-endings-");
  // ANY CPU work is progress (no rate: a rate is a load threshold, and a busy host would judge the command): a
  // poller that wakes every 200 ms for 2 ms of work (about 1% of a core) prints nothing, outlives the stall window,
  // and exits: under any rate floor it would be stopped.
  const poller = await runCpuBounded(NODE, ["-e", `const used = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; }; setInterval(() => { const until = used() + 2; while (used() < until) {} }, 200); setTimeout(() => process.exit(0), 2_500);`], { cwd: dir, env: ENV, bounds: { ...TIGHT, cpuBudgetMs: 60_000, stallMs: 1_000 } });
  assert.equal(poller.ending, "exited", boundedRunDiagnostic(poller));
});

test("the bounded ending: a run past the wall backstop is hung", async () => {
  const dir = createTempDir("bounded-endings-");
  // The hang backstop, the one wall bound: a run that keeps printing (progress) is still stopped at it, as hung.
  const chatty = await runCpuBounded(NODE, ["-e", `setInterval(() => console.log("."), 100); setTimeout(() => process.exit(0), 10_000);`], { cwd: dir, env: ENV, bounds: { ...TIGHT, cpuBudgetMs: 60_000, hangBackstopMs: 1_000 } });
  assert.equal(chatty.ending, "hung", boundedRunDiagnostic(chatty));
  assert.match(boundedEnding(chatty, { ...TIGHT, hangBackstopMs: 1_000 }), /^HUNG: it was still running at the 1 s hang backstop \(wall\)/u, boundedRunDiagnostic(chatty));});

test("the bounded diagnostic omits compatible extras at every nested owner and real output content", async () => {
  const sentinel = "DIAGNOSTIC_PRIVATE_EXTRA_SENTINEL";
  const caller = { ...TIGHT, command: sentinel, environment: { TOKEN: sentinel }, output: sentinel };
  const run = await runCpuBounded(NODE, ["-e", "process.stdout.write('DIAGNOSTIC_PRIVATE_OUTPUT_SENTINEL'); " + QUIET], { cwd: createTempDir("bounded-diagnostic-"), env: ENV, bounds: caller });
  assert.equal(run.ending, "stalled", boundedRunDiagnostic(run));
  assert.equal(run.stdout.toString("utf8"), "DIAGNOSTIC_PRIVATE_OUTPUT_SENTINEL");
  assert.ok(run.diagnostics.lastObservation);
  assert.ok(run.diagnostics.stopRequest);
  assert.ok(run.diagnostics.termination);
  const extraObservation = { ...run.diagnostics.lastObservation, output: sentinel, nativeExit: { status: run.status, signal: run.signal, credential: sentinel } };
  const forged = {
    ...run, command: sentinel, startError: sentinel,
    diagnostics: {
      ...run.diagnostics, command: sentinel, environment: { TOKEN: sentinel },
      admittedBounds: { ...run.diagnostics.admittedBounds, credential: sentinel },
      lastObservation: extraObservation,
      stopRequest: { ...run.diagnostics.stopRequest, credential: sentinel, observation: extraObservation },
      termination: { ...run.diagnostics.termination, credential: sentinel },
    },
  };
  const projected = boundedRunDiagnostic(forged);
  assert.equal(projected.includes(sentinel), false);
  assert.equal(projected.includes("DIAGNOSTIC_PRIVATE_OUTPUT_SENTINEL"), false);
  assert.deepEqual(JSON.parse(projected).diagnostics.admittedBounds, TIGHT);
  assert.equal(JSON.parse(projected).stdoutBytes, run.stdout.length);
});

test("the actual bounded watch and record use one admitted snapshot after caller mutation", async () => {
  const dir = createTempDir("bounded-snapshot-");
  const ready = join(dir, "ready");
  const release = join(dir, "release");
  const caller = { ...TIGHT };
  let stage = 0;
  let observedAfterMutation = false;
  let stoppedAfterMutation = false;
  const child = [
    'const fs = require("node:fs"); let ended = false;',
    `const finish = () => { if (ended || !fs.existsSync(${JSON.stringify(release)})) return; ended = true; watch.close(); process.stdout.write("SNAPSHOT_FROZEN"); };`,
    `const watch = fs.watch(${JSON.stringify(dir)}, finish);`,
    `fs.writeFileSync(${JSON.stringify(ready)}, "ready"); finish();`,
  ].join(" ");
  const run = await runCpuBounded(NODE, ["-e", child], {
    cwd: dir, env: ENV, bounds: caller,
    onObservation: (event) => {
      if (event.phase !== "watch") return;
      if (stage === 0 && existsSync(ready)) {
        for (const key of Object.keys(TIGHT) as (keyof SubprocessBounds)[]) caller[key] = 1;
        stage = 1;
      } else if (stage === 1) {
        observedAfterMutation = true;
        stoppedAfterMutation = event.diagnostics.stopRequest !== null;
        stage = 2;
        writeFileSync(release, "release");
      }
    },
  });
  assert.equal(observedAfterMutation, true, boundedRunDiagnostic(run));
  assert.equal(stoppedAfterMutation, false, boundedRunDiagnostic(run));
  assert.equal(run.ending, "exited", boundedRunDiagnostic(run));
  assert.equal(run.stdout.toString("utf8"), "SNAPSHOT_FROZEN");
  assert.deepEqual(run.diagnostics.admittedBounds, TIGHT);
  assert.equal(Object.isFrozen(run.diagnostics.admittedBounds), true);
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

/** Future recorded controls only: the ended-empty-group expectation is intentionally red on unchanged V3. */
async function observeOwnedPipeHolder(detached: boolean): Promise<Readonly<{
  run: Awaited<ReturnType<typeof runCpuBounded>>;
  authoritativeGone: boolean;
  realLiveStall: boolean;
  helperOwnedBeforeLeaderExit: boolean;
  helperGone: boolean;
  closedReason: string | null;
  missingCloseAfterExit: boolean;
  cleanupBackstopUsed: boolean;
  cleanup: Awaited<ReturnType<typeof terminate>> | null;
}>> {
  const dir = createTempDir("bounded-owned-pipe-rendezvous-");
  const pidFile = join(dir, "helper.pid");
  const ready = join(dir, "helper-ready");
  const admit = join(dir, "admit-leader-exit");
  const release = join(dir, "release-helper");
  const closed = join(dir, "helper-closed");
  const timedOut = join(dir, "cleanup-backstop");
  let resolveClosed: () => void = () => undefined;
  const closedObserved = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const closedWatch = watch(dir, guarded("test.bounded-pair.helper-closed", () => {
    if (existsSync(closed)) resolveClosed();
  }));
  const helper = [
    'const fs = require("node:fs"); let done = false;',
    `const finish = (reason) => { if (done) return; done = true; monitor.close(); clearTimeout(cleanup); if (reason === "cleanup") fs.writeFileSync(${JSON.stringify(timedOut)}, "cleanup only"); fs.writeFileSync(${JSON.stringify(closed + ".next")}, reason); fs.renameSync(${JSON.stringify(closed + ".next")}, ${JSON.stringify(closed)}); process.exit(reason === "cleanup" ? 71 : 0); };`,
    `const release = () => { if (fs.existsSync(${JSON.stringify(release)})) finish("release"); };`,
    `const monitor = fs.watch(${JSON.stringify(dir)}, release);`,
    `const cleanup = setTimeout(() => finish("cleanup"), ${String(QUIET_LIFE_MS)});`,
    'process.on("SIGTERM", () => finish("term")); process.send("ready"); release();',
  ].join(" ");
  let ownedHelper: ReturnType<typeof ownedChild> | undefined;
  let authoritativeGone = false;
  let realLiveStall = false;
  let cleanup: Awaited<ReturnType<typeof terminate>> | null = null;
  let helperGone = false;
  let closedReason: string | null = null;
  let missingCloseAfterExit = false;
  let run: Awaited<ReturnType<typeof runCpuBounded>>;
  try {
    run = await runCpuBounded(NODE, ["-e", leaderWithGrandchild(pidFile, helper, 0, { detached, admitFile: admit, readyFile: ready })], {
      cwd: dir, env: ENV, bounds: TIGHT,
      onObservation: (event) => {
        if (event.phase === "watch" && ownedHelper === undefined && event.diagnostics.stopRequest === null && existsSync(ready)) {
          // The IPC-ready leader is still alive behind admit: retain the actual owned identity before reparenting.
          ownedHelper = ownedChild({ pid: Number(readFileSync(pidFile, "utf8")) });
          writeFileSync(admit, "admitted");
        }
        if (event.phase !== "termination") return;
        const request = event.diagnostics.stopRequest;
        const observed = request?.observation;
        const native = observed?.nativeExit;
        const termination = event.diagnostics.termination;
        if (request?.ending === "stalled" && observed !== null && observed !== undefined && native?.status === 0 && native.signal === null && observed.closed === false) {
          authoritativeGone = detached && observed.members === 0 && termination?.ending === "gone";
          realLiveStall = !detached && observed.members > 0 && (termination?.ending === "terminated" || termination?.ending === "killed");
        }
        // A completed real-owner decision drives release; unexpected outcomes release only for cleanup and fail below.
        writeFileSync(release, "release");
      },
    });
  } finally {
    try {
      writeFileSync(release, "release");
      if (existsSync(pidFile)) {
        if (!existsSync(closed) && ownedHelper !== undefined && isProcessIdentityLive(ownedHelper)) {
          const identity = ownedHelper;
          let resolveGone: () => void = () => undefined;
          const goneObserved = new Promise<void>((resolve) => { resolveGone = resolve; });
          // Cleanup-only liveness observation: never a release, classifier or group-absence driver.
          const exitWatch = setInterval(guarded("test.bounded-pair.helper-exit", () => {
            if (!isProcessIdentityLive(identity)) resolveGone();
          }), TIGHT.pollMs);
          try { await Promise.race([closedObserved, goneObserved]); }
          finally { clearInterval(exitWatch); }
        }
        if (existsSync(closed)) closedReason = readFileSync(closed, "utf8");
        else missingCloseAfterExit = true;
      }
    } finally {
      try {
        if (ownedHelper !== undefined) {
          cleanup = await terminate(ownedHelper, { graceMs: TIGHT.killGraceMs });
          helperGone = !isProcessIdentityLive(ownedHelper);
        }
      } finally { closedWatch.close(); }
    }
  }
  return { run, authoritativeGone, realLiveStall, helperOwnedBeforeLeaderExit: ownedHelper !== undefined, helperGone, closedReason, missingCloseAfterExit, cleanupBackstopUsed: existsSync(timedOut), cleanup };
}

test("controlled ended empty group keeps its native ending after owned outsider close is acknowledged", async () => {
  const observed = await observeOwnedPipeHolder(true);
  assert.equal(observed.helperOwnedBeforeLeaderExit, true, boundedRunDiagnostic(observed.run));
  assert.equal(observed.authoritativeGone, true, boundedRunDiagnostic(observed.run));
  assert.equal(observed.closedReason, "release", boundedRunDiagnostic(observed.run));
  assert.equal(observed.helperGone, true, boundedRunDiagnostic(observed.run));
  assert.equal(observed.missingCloseAfterExit, false, "a dead helper without a close marker is a failed control");
  assert.notEqual(observed.cleanup?.ending, "unconfirmed");
  assert.equal(observed.cleanupBackstopUsed, false);
  assert.deepEqual([observed.run.status, observed.run.signal], [0, null], boundedRunDiagnostic(observed.run));
  // INTENTIONAL pre-fix red, reserved for recorded reproduction and exact later repair review.
  assert.equal(observed.run.ending, "exited", boundedRunDiagnostic(observed.run));
});

test("controlled native leader exit still bounds its live same-group quiet holder and confirms owned cleanup", async () => {
  const observed = await observeOwnedPipeHolder(false);
  assert.equal(observed.helperOwnedBeforeLeaderExit, true, boundedRunDiagnostic(observed.run));
  assert.equal(observed.realLiveStall, true, boundedRunDiagnostic(observed.run));
  assert.equal(observed.closedReason, "term", boundedRunDiagnostic(observed.run));
  assert.equal(observed.helperGone, true, boundedRunDiagnostic(observed.run));
  assert.equal(observed.missingCloseAfterExit, false, "a dead helper without a close marker is a failed control");
  assert.notEqual(observed.cleanup?.ending, "unconfirmed");
  assert.equal(observed.cleanupBackstopUsed, false);
  assert.equal(observed.run.ending, "stalled", boundedRunDiagnostic(observed.run));
});

const OBSERVER_LIFECYCLE_DRIVER = "// PRIVATE UNAPPLIED AND UNEXECUTED native-supervised fixture child.\nimport assert from \"node:assert/strict\";\nimport { existsSync, readFileSync, writeFileSync, writeSync } from \"node:fs\";\nconst c = JSON.parse(process.argv[2]);\n(await import(c.bootstrapUrl)).bootstrapProcess({ role: \"cli\" });\nconst policy = await import(c.policyUrl);\nconst { runCpuBounded, boundedRunDiagnostic } = await import(c.runnerUrl);\nconst { isProcessAlive } = await import(c.factsUrl);\nlet seen = false;\nlet rejectObserver;\nlet rejected = false;\nconst held = new Promise((_resolve, reject) => { rejectObserver = reject; });\nlet nativeEvent = null;\nlet terminationEvent = null;\nconst mutations = Object.create(null);\nconst trySet = (name, object, key, value) => {\n  if (object !== null && !(name in mutations)) mutations[name] = Reflect.set(object, key, value);\n};\nassert.deepEqual(policy.processFaultCounts(), { guardedCallbackFaults: 0, unhandledRejections: 0, uncaughtExceptions: 0 });\nconst run = await runCpuBounded(process.execPath, [\"-e\", c.command], {\n  cwd: c.cwd, env: c.env, bounds: c.bounds,\n  onObservation: (event) => {\n    if (c.mode === \"immutable\") {\n      seen = true;\n      const d = event.diagnostics;\n      if (d.lastObservation?.nativeExit !== null && d.lastObservation?.nativeExit !== undefined) nativeEvent ??= event;\n      if (event.phase === \"termination\") terminationEvent = event;\n      trySet(\"bounds\", d.admittedBounds, \"stallMs\", 1);\n      trySet(\"observation\", d.lastObservation, \"idleMs\", -1);\n      trySet(\"nativeExit\", d.lastObservation?.nativeExit ?? null, \"signal\", \"SIGXCPU\");\n      trySet(\"stop\", d.stopRequest, \"ending\", \"hung\");\n      trySet(\"stopObservation\", d.stopRequest?.observation ?? null, \"idleMs\", -1);\n      trySet(\"termination\", d.termination, \"ending\", \"unconfirmed\");\n      return { ending: \"cpu-rlimit\", status: 99, signal: \"SIGXCPU\", diagnostics: { admittedBounds: { stallMs: 1 } } };\n    }\n    if (c.mode === \"throw\") {\n      if (!seen && event.phase === \"termination\") {\n        seen = true;\n        throw new TypeError(\"BOUNDED_OBSERVER_SYNC\");\n      }\n      return;\n    }\n    if (!seen && event.phase === \"watch\" && existsSync(c.ready)) {\n      seen = true;\n      writeFileSync(c.release, \"release\");\n      return held;\n    }\n  },\n});\nassert.equal(seen, true, boundedRunDiagnostic(run));\nif (c.mode === \"reject\") {\n  assert.equal(run.ending, \"exited\", boundedRunDiagnostic(run));\n  assert.equal(run.status, 0);\n  assert.equal(rejected, false, \"actual run resolves while observer Promise is still pending\");\n  rejected = true;\n  rejectObserver(new RangeError(\"BOUNDED_OBSERVER_ASYNC\"));\n  await new Promise((resolve) => setImmediate(resolve));\n} else {\n  assert.equal(run.ending, \"stalled\", boundedRunDiagnostic(run));\n}\nif (c.mode === \"immutable\") {\n  assert.equal(run.status, 0);\n  assert.equal(run.signal, null);\n  assert.ok(nativeEvent);\n  assert.ok(terminationEvent);\n  assert.deepEqual(run.diagnostics.admittedBounds, c.bounds);\n  for (const name of [\"bounds\", \"observation\", \"nativeExit\", \"stop\", \"stopObservation\", \"termination\"]) assert.equal(mutations[name], false, name);\n  for (const event of [nativeEvent, terminationEvent]) {\n    assert.equal(Object.isFrozen(event), true);\n    assert.equal(Object.isFrozen(event.diagnostics), true);\n    for (const value of [event.diagnostics.admittedBounds, event.diagnostics.lastObservation, event.diagnostics.lastObservation?.nativeExit, event.diagnostics.stopRequest, event.diagnostics.stopRequest?.observation, event.diagnostics.termination]) {\n      if (value !== null && value !== undefined) assert.equal(Object.isFrozen(value), true);\n    }\n  }\n  assert.equal(isProcessAlive(Number(readFileSync(c.grandchild, \"utf8\"))), false);\n  assert.deepEqual(policy.processFaultCounts(), { guardedCallbackFaults: 0, unhandledRejections: 0, uncaughtExceptions: 0 });\n} else {\n  assert.deepEqual(policy.processFaultCounts(), { guardedCallbackFaults: 1, unhandledRejections: 0, uncaughtExceptions: 0 });\n  assert.match(policy.lastProcessFault(), /^callback fault in process\\.cpu-bounded\\.observation: /u);\n}\nwriteSync(1, \"BOUNDED_OBSERVER_LIFECYCLE \" + JSON.stringify({\n  mode: c.mode, seen, counts: policy.processFaultCounts(), last: policy.lastProcessFault(),\n  ending: run.ending, status: run.status, signal: run.signal,\n  pendingAtRunCompletion: c.mode === \"reject\", mutations,\n}) + \"\\n\");\nprocess.exitCode = 0;\nprocess.exit(0);\n";

function runBoundedObserverLifecycle(mode: "throw" | "reject" | "immutable") {
  const dir = createTempDir("bounded-observer-lifecycle-");
  const entry = join(dir, "driver.mjs");
  const ready = join(dir, "ready");
  const release = join(dir, "release");
  const grandchild = join(dir, "grandchild");
  const controlled = [
    'const fs = require("node:fs"); let ended = false; let cleanup;',
    "const finish = () => { if (ended || !fs.existsSync(" + JSON.stringify(release) + ")) return; ended = true; clearTimeout(cleanup); watch.close(); };",
    "const watch = fs.watch(" + JSON.stringify(dir) + ", finish);",
    "cleanup = setTimeout(() => { if (ended) return; ended = true; watch.close(); process.exitCode = 86; }, " + String(QUIET_LIFE_MS) + ");",
    "fs.writeFileSync(" + JSON.stringify(ready) + ', "ready"); finish();',
  ].join(" ");
  const command = mode === "reject" ? controlled : mode === "immutable" ? leaderWithGrandchild(grandchild, QUIET) : QUIET;
  writeFileSync(entry, OBSERVER_LIFECYCLE_DRIVER);
  const input = {
    bootstrapUrl: new URL("../../src/runtime/cli-debug.ts", import.meta.url).href,
    policyUrl: new URL("../../src/process/fault-policy.ts", import.meta.url).href,
    runnerUrl: new URL("../../src/process/supervised-run.ts", import.meta.url).href,
    factsUrl: new URL("../../src/process/process-facts.ts", import.meta.url).href,
    mode, cwd: dir, ready, release, grandchild, command, bounds: TIGHT, env: ENV,
  };
  return runBoundedTestProcess(ensureTestProcessSupervisor(), NODE, [entry, JSON.stringify(input)], {
    cwd: dir, env: process.env, timeoutMs: TIGHT.hangBackstopMs, killGraceMs: TIGHT.killGraceMs,
  });
}

function observerLifecycleReport(child: ReturnType<typeof runBoundedObserverLifecycle>) {
  assert.equal(child.error, undefined, child.stderr);
  assert.equal(child.supervision.noOwnedChildren, true, child.stderr);
  assert.equal(child.supervision.timedOut, false, child.stderr);
  assert.equal(child.supervision.interrupted, false, child.stderr);
  assert.equal(child.supervision.commandKilled, false, child.stderr);
  const lines = child.stdout.split("\n").filter((line) => line.startsWith("BOUNDED_OBSERVER_LIFECYCLE "));
  assert.equal(lines.length, 1, child.stdout + child.stderr);
  return JSON.parse(lines[0]!.slice("BOUNDED_OBSERVER_LIFECYCLE ".length)) as {
    mode: string; counts: { guardedCallbackFaults: number; unhandledRejections: number; uncaughtExceptions: number };
    pendingAtRunCompletion: boolean; ending: string; status: number | null; signal: string | null;
  };
}

test("the actual bounded observer's synchronous throw uses the guarded fault owner without skipping cleanup", () => {
  const child = runBoundedObserverLifecycle("throw");
  const report = observerLifecycleReport(child);
  assert.equal(child.status, PROCESS_FAULT_EXIT_CODE, child.stderr);
  assert.deepEqual(report.counts, { guardedCallbackFaults: 1, unhandledRejections: 0, uncaughtExceptions: 0 });
  assert.equal(report.ending, "stalled");
  assert.match(child.stderr, /callback fault in process\.cpu-bounded\.observation: TypeError: BOUNDED_OBSERVER_SYNC/u);
});

test("the actual bounded observer returns a native Promise without delaying the run, and its later rejection stays attributed", () => {
  const child = runBoundedObserverLifecycle("reject");
  const report = observerLifecycleReport(child);
  assert.equal(child.status, PROCESS_FAULT_EXIT_CODE, child.stderr);
  assert.deepEqual(report.counts, { guardedCallbackFaults: 1, unhandledRejections: 0, uncaughtExceptions: 0 });
  assert.equal(report.pendingAtRunCompletion, true);
  assert.equal(report.ending, "exited");
  assert.match(child.stderr, /callback fault in process\.cpu-bounded\.observation: RangeError: BOUNDED_OBSERVER_ASYNC/u);
});

test("the actual bounded observer cannot mutate nested facts or replace the real owned-group decision", () => {
  const child = runBoundedObserverLifecycle("immutable");
  const report = observerLifecycleReport(child);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(report.counts, { guardedCallbackFaults: 0, unhandledRejections: 0, uncaughtExceptions: 0 });
  assert.deepEqual([report.ending, report.status, report.signal], ["stalled", 0, null]);
});
