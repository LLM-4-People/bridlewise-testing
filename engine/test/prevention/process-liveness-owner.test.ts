/**
 * ONE LIVENESS ANSWER AND ONE PROCFS READER (`src/process/process-facts.ts`).
 *
 * wf1c-correctness §6: "is this process (group) alive?" was answered in six
 * places with two rules. `scripts/sd.mjs` counted EPERM (alive, not ours) as
 * DEAD — the one direction that lets a stale-reconciliation path treat a
 * live foreign process as gone — and the dev scripts each kept a private
 * group probe. wf1b2-design P5/T-M3: the tests, the dev-server preflight and
 * the census each kept their own procfs walks (three stat parsers, two boot
 * clocks, two tick constants), and a zombie answered alive. The owner answers
 * `isProcessAlive` (a zombie is not alive), `isProcessGroupAlive`,
 * `isProcessIdentityLive` (pid + start time), `terminate`, and every procfs
 * document (`procfsDocument`, `procfsPath`, the named facts); this guard
 * refuses a `kill(<pid>, 0)` probe of ANY receiver and a direct read of a
 * procfs path anywhere else — the engine, the server, the scripts, the
 * benches and every test tree.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join, relative } from "node:path";
import test from "node:test";

import { walk } from "../../scripts/verification/source-walk.ts";
import { readSourceView, sourceViewOf } from "../../scripts/verification/source-view.ts";
import { isProcessAlive, isProcessGroupAlive, ownedAnnouncement, ownedChild, parseProcessIdentityRecord, processesListeningOn, processIdentity, processIdentityRecord, readSpawnRecord, terminate, writeSpawnRecord } from "../../src/process/process-facts.ts";
import { readSupervisorReceipt } from "../../src/process/supervised-run.ts";
import { ensureTestProcessSupervisor } from "../../guardian/build.ts";
import { stopDevGroup } from "../../../scripts/dev-processes.ts";
import { createTempDir } from "../support/temp-dir.ts";

const REPOSITORY_ROOT = join(import.meta.dirname, "..", "..", "..");
const OWNER = "engine/src/process/process-facts.ts";
/**
 * A liveness probe: signal 0 sent through any receiver (`process.kill`, an
 * injected `kill`, `proc.kill`) whatever the target expression (a call, a
 * `!`, a `??`, nested parentheses — WF-1b3b verify M2), `0 as const` too.
 */
const PROBE = /\bkill\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*?,\s*0(?:\s+as\s+const)?\s*\)/u;
/**
 * A pid- or group-addressed signal (any but the probe's 0) — a private
 * terminate loop (WF-1b3b design H1: `sd.mjs` SIGKILLed every `dev-all.ts`
 * on the machine), or a stop of a process the run did not spawn
 * (KILL-OWNED-ONLY: a neighbour's run was killed by its group id,
 * 2026-10-08). The one terminator signals, and only an owned process. A
 * `ChildProcess` handle's `.kill(…)` names the caller's own unreaped child
 * (its spawn, by construction) and is not this class.
 */
// Any `process.kill(…)` but the liveness probe `process.kill(pid, 0)`: the default-signal `process.kill(pid)` (SIGTERM)
// is a signal too.
const PID_SIGNAL = /\bprocess\.kill\((?!(?:[^()]|\([^()]*\))*,\s*0(?:\s+as\s+const)?\s*\))(?:[^()]|\((?:[^()]|\([^()]*\))*\))+\)/u;
/** A process killer run as a command: `kill`, `killall`, or the service manager told to stop or kill a unit. */
const KILL_COMMAND = /\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)\(\s*["'`](?:(?:kill|killall)\b|[^"'`]*\bsystemctl\b[^"'`]*\b(?:stop|kill)\b)/u;
/** The one caller of `ownedAnnouncement` (a supervisor's announced command is a spawn of the run that started the supervisor). */
const ANNOUNCEMENT_CALLERS = [
  "engine/src/process/supervised-run.ts",
  // This guard's own arm that proves an announcement owns only the identity bound at spawn.
  "engine/test/prevention/process-liveness-owner.test.ts",
] as const;
/** A process-list scrape: `ps`, `ss`, `pgrep`, `pkill`, `lsof`, `fuser` or `netstat` run as a command (the owner answers from procfs). */
const PROCESS_SCRAPE = /\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync)\(\s*["'`](?:ps|ss|pgrep|pkill|lsof|fuser|netstat)\b/u;
/** Where a pid-addressed signal is refused: the product and its tooling (a test may crash itself or kill its own fixture). */
const PID_SIGNAL_ROOTS = ["engine/src/", "engine/scripts/", "server/", "scripts/", "bench/", "shared/", "src/"] as const;
/** Pid-addressed signals and process-list scrapes outside the owner, each with its reason. */
const DECLARED_SIGNALLERS: Readonly<Record<string, string>> = {
  "bench/lib/machine.ts": "the machine report prints the top CPU consumers as `ps` formats them: a diagnostic line for a human, no pid is read back or acted on",
};
/** A direct read of a procfs path: a filesystem call whose first argument spells `/proc` (a literal, a template or a `join`). */
const PROCFS_READ = /\b(?:readFileSync|readFile|readdirSync|readdir|readlinkSync|readlink|existsSync|statSync|lstatSync|openSync|realpathSync)\(\s*(?:join\(\s*)?["'`]\/proc\b/u;
/**
 * Files that read procfs without the owner, each with the reason: none may
 * import it. A `node -e` script a test hands a CHILD is text, not a module of
 * this tree; it reads its own stat line in the child.
 */
const DECLARED_RAW_PROCFS_READERS: Readonly<Record<string, string>> = {
  "tests/prevention/test-isolation-contract.test.ts": "its supervised child is a `node -e` script (text handed to a child process), which reads its own stat line and its parent's procfs folder there",
};

function scannedFiles(): readonly string[] {
  const roots = ["engine/src", "engine/scripts", "engine/test", "server", "scripts", "bench", "tests", "shared", "src"].map((root) => join(REPOSITORY_ROOT, root));
  return roots.flatMap((root) => walk(root, { exts: [".ts", ".mts", ".mjs", ".js"] }))
    .map((file) => relative(REPOSITORY_ROOT, file).split("\\").join("/"))
    .filter((path) => path !== OWNER && !/^engine\/scripts\/exp/u.test(path) && !path.includes("/node_modules/") && !path.includes("/fixtures/"));
}

test("no process-liveness probe and no direct procfs read outside the one owner", () => {
  const files = scannedFiles();
  assert.ok(files.length > 1000, `the scan saw ${String(files.length)} files`);
  const probes: string[] = [];
  const reads: string[] = [];
  const signallers: string[] = [];
  for (const path of files) {
    const view = readSourceView(join(REPOSITORY_ROOT, path));
    // This guard spells both shapes as patterns: its own file is the one that may.
    if (path === "engine/test/prevention/process-liveness-owner.test.ts") continue;
    for (const hit of view.matches(PROBE, "code")) probes.push(`${path}:${String(hit.line)}`);
    if (!(path in DECLARED_SIGNALLERS)) {
      if (PID_SIGNAL_ROOTS.some((root) => path.startsWith(root))) for (const hit of view.matches(PID_SIGNAL, "codeWithStrings")) signallers.push(`${path}:${String(hit.line)}`);
      for (const pattern of [PROCESS_SCRAPE, KILL_COMMAND]) for (const hit of view.matches(pattern, "codeWithStringsAndTemplates")) signallers.push(`${path}:${String(hit.line)}`);
    }
    if (view.matches(/\bownedAnnouncement\(/u, "code").length > 0 && !(ANNOUNCEMENT_CALLERS as readonly string[]).includes(path)) {
      signallers.push(`${path}: ownedAnnouncement outside the supervised run`);
    }
    if (path in DECLARED_RAW_PROCFS_READERS) continue;
    for (const hit of view.matches(PROCFS_READ, "codeWithStringsAndTemplates")) reads.push(`${path}:${String(hit.line)}`);
  }
  assert.deepEqual(probes, [], "ask engine/src/process/process-facts.ts (isProcessAlive / isProcessGroupAlive / isProcessIdentityLive / terminate)");
  assert.deepEqual(reads, [], "read procfs through engine/src/process/process-facts.ts (procfsDocument / procfsPath / the named facts)");
  assert.deepEqual(signallers, [], "stop a process through engine/src/process/process-facts.ts terminate — only one this run spawned (ownedChild, ownedSelf, a spawn record) — and find it through its facts (processesListeningOn, workingDirectoryOf, the census): never a private signal, a kill command or a process-list scrape (KILL-OWNED-ONLY)");
  for (const [path, why] of Object.entries(DECLARED_SIGNALLERS)) {
    assert.ok(why.length > 60, `${path}: a declared signaller needs its reason`);
    const view = readSourceView(join(REPOSITORY_ROOT, path));
    assert.ok(view.matches(PID_SIGNAL, "codeWithStrings").length + view.matches(PROCESS_SCRAPE, "codeWithStringsAndTemplates").length > 0, `${path} no longer signals or scrapes: delete its declaration`);
  }
  for (const [path, why] of Object.entries(DECLARED_RAW_PROCFS_READERS)) {
    assert.ok(why.length > 60, `${path}: a declared reader needs its reason`);
    assert.ok(readSourceView(join(REPOSITORY_ROOT, path)).matches(PROCFS_READ, "codeWithStringsAndTemplates").length > 0, `${path} no longer reads procfs: delete its declaration`);
  }
});

test("the guard's shapes: every probe receiver and every procfs spelling is caught; a procfs path as data is not", () => {
  const hits = (text: string, pattern: RegExp): number => sourceViewOf(text, "planted.ts").matches(pattern, pattern === PROBE ? "code" : "codeWithStringsAndTemplates").length;
  for (const planted of [
    "try { process.kill(pid, 0); } catch {}", "process.kill(-pid, 0)", "kill(pid, 0)", "child.kill(target, 0)",
    'process.kill(Number(readFileSync(file, "utf8")), 0)', "process.kill(entry.pid!, 0)", "process.kill(a ?? b, 0)", "process.kill(pid, 0 as const)",
  ]) {
    assert.equal(hits(planted, PROBE), 1, `the probe ${planted} is not caught`);
  }
  for (const other of ["process.kill(pid, 'SIGTERM')", "process.kill(pid, 0x1)", "kill(pid, 10)"]) assert.equal(hits(other, PROBE), 0, `${other} is not a probe`);
  const scan = (text: string, pattern: RegExp, view: "codeWithStrings" | "codeWithStringsAndTemplates"): number => sourceViewOf(text, "planted.ts").matches(pattern, view).length;
  for (const planted of ['process.kill(p, "SIGKILL")', "process.kill(-group, 'SIGKILL')", 'process.kill(Number(read(file)), "SIGKILL")', 'process.kill(p, "SIGTERM")', "process.kill(-pid, sig)", "process.kill(pid, signal ?? 'SIGINT')", "process.kill(pid)", "process.kill(Number(read(file)))"]) {
    assert.equal(scan(planted, PID_SIGNAL, "codeWithStrings"), 1, `the signal ${planted} is not caught`);
  }
  for (const other of ['child.kill("SIGKILL")', "process.kill(p, 0)", '// process.kill(p, "SIGKILL")']) assert.equal(scan(other, PID_SIGNAL, "codeWithStrings"), 0, `${other} is not a pid-addressed signal`);
  for (const planted of ['execSync("kill -9 123")', "spawnSync('killall', ['node'])", "execSync(`systemctl --user stop '${unit}'`)", 'execSync("systemctl --user kill x")']) {
    assert.equal(scan(planted, KILL_COMMAND, "codeWithStringsAndTemplates"), 1, `the kill command ${planted} is not caught`);
  }
  for (const other of ['execSync("systemctl --user list-units")', 'spawnSync("killer-app")', 'execSync("echo stop")']) assert.equal(scan(other, KILL_COMMAND, "codeWithStringsAndTemplates"), 0, `${other} is not a kill command`);
  for (const planted of ["execSync(\"ps -ef | grep 'scripts/dev-all.ts'\")", "execSync(`ss -ltnp | grep :${port}`)", 'execFileSync(\n  "ps", ["-eo", "pid"])', 'spawnSync("pgrep", ["-f", "vitest"])', "execSync('lsof -i :5173')"]) {
    assert.equal(scan(planted, PROCESS_SCRAPE, "codeWithStringsAndTemplates"), 1, `the scrape ${planted} is not caught`);
  }
  for (const other of ['execSync("psql -c 1")', 'spawnSync("ssh", ["host"])', 'execSync("systemctl --user stop x")']) assert.equal(scan(other, PROCESS_SCRAPE, "codeWithStringsAndTemplates"), 0, `${other} is not a process-list scrape`);
  assert.equal(hits("// process.kill(pid, 0) in a comment", PROBE), 0, "a comment is not a probe");
  for (const planted of ['readFileSync("/proc/self/stat", "utf8")', "readdirSync('/proc')", "readlinkSync(`/proc/${pid}/cwd`)", 'readFileSync(join("/proc", pid, "cmdline"))', "existsSync(`/proc/${pid}`)"]) {
    assert.equal(hits(planted, PROCFS_READ), 1, `the read ${planted} is not caught`);
  }
  for (const data of ['const floor = ["/proc", "/sys"];', 'symlinkSync("/proc", link)', 'refusal("/proc/self")']) {
    assert.equal(hits(data, PROCFS_READ), 0, `${data} is a path as data, not a read`);
  }
});

test("the owner's answers: this process and its group are alive; pid 1 answers alive (EPERM is alive, never dead); an exited pid is dead", () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(1), true, "EPERM (alive, not ours) was answered dead");
  const exited = spawnSync(process.execPath, ["-e", "0"]);
  assert.equal(isProcessAlive(exited.pid!), false, "an exited pid was answered alive");
  const group = spawnSync("sh", ["-c", "echo $$"], { encoding: "utf8", detached: true } as never);
  assert.equal(isProcessGroupAlive(Number(group.stdout.trim())), false, "an exited group was answered alive");
  assert.equal(isProcessAlive(0), false);
});

test("a ZOMBIE is not alive: a child that exited and is not reaped yet holds nothing (wf1b2-design T-M3)", async () => {
  // `sh` forks a child that exits at once and then sleeps WITHOUT waiting for
  // it: the exited child stays a zombie (state Z) until `sh` ends.
  const parent = spawn("sh", ["-c", "sleep 0 & echo $!; exec sleep 30"], { stdio: ["ignore", "pipe", "ignore"] });
  try {
    const zombie = await new Promise<number>((resolveZombie) => parent.stdout.once("data", (chunk: Buffer) => resolveZombie(Number(String(chunk).trim()))));
    const deadline = Date.now() + 5_000;
    while (isProcessAlive(zombie) && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    assert.equal(isProcessAlive(zombie), false, "a zombie was answered alive");
    assert.equal(isProcessAlive(parent.pid!), true, "its (sleeping) parent is alive");
  } finally {
    parent.kill("SIGKILL");
  }
});

test("terminate: SIGTERM within the grace, SIGKILL after it, a gone target is gone; an identity whose pid was recycled is never signalled", async (t) => {
  const polite = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const stubborn = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('armed'); setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "ignore"] });
  const bystander = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('armed'); setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "ignore"] });
  // Bounded (WF-1b3b verify L5): a mutant that never escalates fails here instead of hanging, and no child outlives the test.
  t.after(() => { for (const child of [polite, stubborn, bystander]) child.kill("SIGKILL"); });
  await Promise.all([stubborn, bystander].map((child) => new Promise((resolveArmed) => child.stdout.once("data", resolveArmed))));
  // Reap each child as it exits, so the loop's liveness check sees it gone.
  const politeOwned = ownedChild(polite);
  const [a, b] = await Promise.all([terminate(politeOwned, { graceMs: 2_000 }), terminate(ownedChild(stubborn), { graceMs: 300 })]);
  assert.equal(a.ending, "terminated");
  assert.equal(b.ending, "killed");
  assert.ok(b.waitedMs >= 300, "the stubborn target was killed before its grace ran out");
  assert.equal((await terminate(politeOwned, { graceMs: 100 })).ending, "gone");
  // The bystander holds a pid an older record named: same pid, another start time.
  const own = processIdentity(bystander.pid!);
  const record = join(createTempDir("terminate-recycled-"), "old.pid");
  writeFileSync(record, processIdentityRecord({ pid: own.pid, startTime: (own.startTime ?? 0) + 1 }));
  assert.equal((await terminate(readSpawnRecord(record)!, { graceMs: 100 })).ending, "gone");
  assert.equal(isProcessAlive(bystander.pid!), true, "a recycled pid was signalled");
  assert.equal((await terminate(ownedChild(bystander), { graceMs: 100 })).ending, "killed", "its own identity stops it");
});

test("KILL-OWNED-ONLY: the one terminator stops only what this run spawned — a forged or found identity, a pid this process did not spawn, is refused before any signal", async (t) => {
  const victim = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
  t.after(() => { victim.kill("SIGKILL"); });
  const found = processIdentity(victim.pid!);
  for (const forged of [found, { ...found, owned: true as const }, { pid: victim.pid!, startTime: null, owned: true as const }]) {
    await assert.rejects(terminate(forged as never, { graceMs: 100 }), (error: unknown) => (error as { code?: string }).code === "termination_not_owned", JSON.stringify(forged));
    await assert.rejects(terminate({ group: forged } as never, { graceMs: 100 }), (error: unknown) => (error as { code?: string }).code === "termination_not_owned");
  }
  assert.equal(isProcessAlive(victim.pid!), true, "a refused target was signalled");
  // A process this one did not spawn (its own parent, init) cannot be taken as owned.
  for (const pid of [process.ppid, 1]) assert.throws(() => ownedChild({ pid }), (error: unknown) => (error as { code?: string }).code === "termination_not_owned", String(pid));
  assert.throws(() => ownedChild({}), (error: unknown) => (error as { code?: string }).code === "termination_not_owned");
  assert.throws(() => writeSpawnRecord(join(createTempDir("terminate-forged-record-"), "x.pid"), found as never), (error: unknown) => (error as { code?: string }).code === "termination_not_owned", "a record holds only an owned process");
  // A spawn record written at spawn is the proof a later step stops it by.
  const record = join(createTempDir("terminate-record-"), "victim.pid");
  writeSpawnRecord(record, ownedChild(victim));
  assert.equal(readSpawnRecord(join(createTempDir("terminate-no-record-"), "absent.pid")), undefined);
  assert.equal((await terminate({ group: readSpawnRecord(record)! }, { graceMs: 2_000 })).ending, "terminated");
});

test("ONE OWNERSHIP RULE: a spawn record with no start time owns nothing (the reviewer's K-1 repro: a process this run never spawned survives), and an announcement owns only the identity the supervisor bound AT SPAWN — a recycled leader pid is another group, never signalled (K-2)", async (t) => {
  // A process outside this run's tree, as `setsid -f` leaves it: detached and unreferenced.
  const stranger = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true });
  stranger.unref();
  t.after(() => { stranger.kill("SIGKILL"); });
  const record = join(createTempDir("terminate-null-record-"), "stranger.pid");
  writeFileSync(record, processIdentityRecord({ pid: stranger.pid!, startTime: null }));
  assert.equal(readSpawnRecord(record), undefined, "a bare pid in a record owns nothing");
  // The announcement of a group whose leader pid now names a different start time: the group is gone, the process is untouched.
  const leader = processIdentity(stranger.pid!);
  assert.notEqual(leader.startTime, null);
  const recycled = { pid: stranger.pid!, startTime: leader.startTime! + 1 };
  assert.equal((await terminate({ group: ownedAnnouncement(recycled) }, { graceMs: 100 })).ending, "gone");
  assert.equal(isProcessAlive(stranger.pid!), true, "a recycled leader's group was signalled");
  assert.throws(() => ownedAnnouncement({ pid: stranger.pid!, startTime: null }), (error: unknown) => (error as { code?: string }).code === "termination_not_owned", "an announcement with no start time owns nothing");
  // The receipt: the supervisor's announcement carries the start time; without one it names no identity.
  assert.deepEqual(readSupervisorReceipt('{"announcedCommandPid":42,"announcedCommandStartTime":7}\n').announcedCommand, { pid: 42, startTime: 7 });
  assert.equal(readSupervisorReceipt('{"announcedCommandPid":42,"announcedCommandStartTime":null}\n').announcedCommand, undefined);
  assert.equal(readSupervisorReceipt('{"announcedCommandPid":42}\n').announcedCommand, undefined);
});

test("THE SUPERVISOR ANNOUNCES ITS COMMAND'S IDENTITY: the start time it reads while the command is its unreaped child is the command's own", () => {
  const facts = pathToFileURL(join(import.meta.dirname, "..", "..", "src", "process", "process-facts.ts")).href;
  const ran = spawnSync(ensureTestProcessSupervisor(), ["30000", "1000", process.execPath, "--input-type=module", "-e", `const { processIdentity } = await import(${JSON.stringify(facts)}); console.log(JSON.stringify(processIdentity()));`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe", "pipe"], timeout: 50_000 });
  const own = JSON.parse(ran.stdout.trim()) as { pid: number; startTime: number };
  assert.deepEqual(readSupervisorReceipt(ran.output[3] ?? "").announcedCommand, own, ran.stderr);
});

test("a group of only dead-but-unreaped members is stopped: the stop confirms it, a live member still blocks (RR2-2)", async (t) => {
  // The supervised dev tree's stop, deterministic without a subreaper:
  // `set -m` puts the background job in its OWN process group, and
  // `exec sleep 60` leaves the job a parent (the exec'd image) that never
  // reaps. SIGTERM the job's group and it dies within the grace, but its
  // state-Z entry stays IN the group past every grace — the member shape a
  // late-reaping subreaper holds (run 2: the web group read "could not be
  // confirmed stopped" with zero live survivors and no SIGKILL).
  const holder = spawn("bash", ["-c", "set -m; sleep 30 & echo $!; exec sleep 60"], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => { holder.kill("SIGKILL"); });
  const member = await new Promise<number>((resolveMember) => holder.stdout.once("data", (chunk: Buffer) => resolveMember(Number(String(chunk).trim()))));
  assert.equal(isProcessAlive(member), true, "the spawned group member was dead on arrival");
  assert.equal(isProcessGroupAlive(member), true, "a live member did not keep its group alive");
  const memberOwned = ownedChild({ pid: member });
  const stopped = await terminate({ group: memberOwned }, { graceMs: 2_000 });
  assert.equal(stopped.ending, "terminated", "a group whose remaining member is a dead-but-unreaped zombie was not confirmed stopped");
  // The mechanism, not an emptied group: the member is dead, and its /proc
  // entry is still there — a zombie awaiting a reaper that never comes.
  assert.equal(isProcessAlive(member), false, "the stopped member was still alive");
  assert.notEqual(processIdentity(member).startTime, null, "the dead member's entry vanished — the group emptied instead of holding a zombie");
  assert.equal(isProcessGroupAlive(member), false, "a dead-but-unreaped member kept its group alive");
  // The dev stop path end to end: the recorded identity's group holds
  // nothing signalable — "gone" (already stopped), never the false
  // "unconfirmed" a zombie-only group used to answer.
  assert.equal(await stopDevGroup(memberOwned), "gone", "the dev stop did not confirm a zombie-only group stopped");
  // The fix must not over-confirm: a genuinely-live member still reads its
  // group alive through the whole grace, so the stop succeeds only by force.
  const armed = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('armed'); setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "ignore"], detached: true });
  t.after(() => { armed.kill("SIGKILL"); });
  // Wait for the handler to be installed: a SIGTERM before it arms would kill
  // the member outright (not the over-confirming shape under test).
  await new Promise((resolveArmed) => armed.stdout!.once("data", resolveArmed));
  assert.equal(isProcessGroupAlive(armed.pid!), true, "an armed live member's group was answered dead");
  assert.equal((await terminate({ group: ownedChild(armed) }, { graceMs: 300 })).ending, "killed", "a live member was confirmed stopped without the SIGKILL escalation");
});

test("processesListeningOn: the process holding a listening socket, by port; another port is absent", async (t) => {
  const server = createServer();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;
  assert.deepEqual(processesListeningOn([port]), [{ pid: process.pid, port }]);
  assert.deepEqual(processesListeningOn([]), []);
});

test("a process-identity record: round trip; a bare pid or another shape is refused", () => {
  const identity = processIdentity();
  assert.deepEqual(parseProcessIdentityRecord(processIdentityRecord(identity)), identity);
  for (const refused of [String(process.pid), "{}", '{"pid":0,"startTime":null}', '{"pid":12,"startTime":"x"}', "[1,2]", "not json",
    // Another spelling of numbers the record never writes, and a field it does not hold (WF1B3BFIX-PROCESS-LOWS).
    '{"pid":12.0,"startTime":null}', '{"pid":1e3,"startTime":null}', '{"pid":12,"startTime":null,"extra":1}', '{"startTime":null,"pid":12}']) {
    assert.equal(parseProcessIdentityRecord(refused), undefined, `${refused} was accepted as an identity`);
  }
});
