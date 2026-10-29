/**
 * HEAVY-RUN ADMISSION OF THE HOST (NO-LOAD-BLOCK; audit rows A-01, A-02,
 * A-03, A-23; it replaces the one global instrument lock). Every heavy
 * instrument — a whole suite, a coverage run, a browser profile or e2e run,
 * `ws validate`/`ws merge`, an ad-hoc load run (`harness slot run -- …`) — is
 * ADMITTED AT ONCE: nothing waits for another run, whatever the load. A run
 * is judged by its CPU work, so it needs no exclusive machine to be measured.
 *
 * ADMISSION writes the run's own record in the host's RUN REGISTRY (a folder
 * beside `testExecution.instrumentLock.cacheRelativeLockPath`, under the cache
 * folder of the home the password database names; never in a checkout or the
 * keep-out floor), on the one lock primitive (`src/filesystem/file-lock.ts`):
 * pid AND start time, a nonce, a bounded holder label, and the processes the
 * run ADOPTED. The registry is shown and never waited on: it says which heavy
 * runs are live, since when, under which caps.
 *
 * EVERY ADMITTED RUN IS CAPPED, not serialized, and there is no path around
 * the cap: admission moves the ADMITTING PROCESS ITSELF into a cgroup v2
 * scope of the run's own (`bridlewise-run-<record nonce>.scope`, made by the
 * systemd user manager's `StartTransientUnit` with this process's pid:
 * `MemoryMax` and `CPUWeight` from `testExecution.instrumentLock.perRun`,
 * `MemorySwapMax=0` and `OOMPolicy=continue`)
 * and under the CPU-time limit of every harness subprocess
 * (`src/process/subprocess-bounds.ts` `limitOwnCpu`). Everything the run
 * starts from then on — a supervised command, a worker, a child spawned
 * directly — is born inside the scope and under the limit; nothing it starts
 * is uncapped. A host that cannot make the scope or set the limit REFUSES
 * the run, typed (`per_run_caps_unavailable`): there is no uncapped mode.
 *
 * THE MEMORY CAP MEANS THE CAP. Without `MemorySwapMax=0` a run past its
 * `MemoryMax` is swapped out, not stopped: measured (GH-7, #553), 1 GiB
 * allocated under a 1% cap went to swap and the run ended normally. So the
 * scope allows no swap, and admission READS BACK the kernel's own
 * `memory.swap.max` (it must be 0) and `memory.max` (it must be a number):
 * a host whose cgroup v2 has no swap accounting, or that did not apply
 * either, is refused typed (`per_run_caps_unavailable`), never run under
 * cap-plus-swap. Past the cap the kernel kills the run's largest process.
 * `OOMPolicy=continue` keeps the rest of the scope alive: under the user
 * manager's default (`stop`, measured on this host) systemd SIGTERMs every
 * process of the scope the moment one is OOM-killed — the runner that
 * admitted the run and every sibling worker mid-test — so nothing is left
 * to say what happened. The policy is READ BACK from the unit like the
 * memory files (a scope under another policy is refused).
 *
 * A RUN THE KERNEL CUT IS A TYPED REFUSAL, from this owner. When the run that
 * ADMITTED a scope releases its record, it reads the scope's `memory.events`
 * `oom_kill`: a kill there fails the release with `run_memory_cap_exceeded`
 * ("a process in this run was killed for passing the run's memory cap"),
 * whoever the run is (a suite runner, `ws validate`/`merge`, `flake
 * reproduce`, a checkout's setup, `slot run`), so a cut run is never mistaken
 * for a crash or a flake. It names the run, never one command: the kernel
 * says THAT a process of the scope was killed, not which. A borrower (a
 * nested door inside the run) blames nothing; the run's owner reports it.
 *
 * NESTING, read from the records' structured fields AND the kernel's: a
 * process BORROWS a live run (a validate's suites, a slot run's command,
 * vitest inside the web runner) only when the run's holder, or a process it
 * adopted, is this process or an ancestor, AND this process is inside the
 * run's own scope (`/proc/self/cgroup`). A borrower writes no record and
 * makes no scope (a nested scope would leave the outer cap); a process that
 * is not inside the scope borrows nothing, whatever its lineage.
 *
 * NO MEASUREMENT STAMP. A reading used to count only when taken "held"
 * (inside the one global lock) and was refused "unslotted" otherwise. Every
 * judged cost is CPU work, valid beside other runs (NO-LOAD-BLOCK, audit
 * A-04, A-05, A-07, A-12), so a run's admission says nothing about its
 * measurement and nothing reads it.
 */
import { dirname, isAbsolute, join } from "node:path";

import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

import { HarnessError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import { identityOverlapIndex, resolveLocation } from "../filesystem/path-identity.ts";
import { liveFileLockHolder, printableHolderLabel, tryAcquireFileLock, type FileLockContent } from "../filesystem/file-lock.ts";
import { randomUuid } from "../kernel/integrity.ts";
import { limitOwnCpu, type SubprocessBounds } from "./subprocess-bounds.ts";
import { floorKeepOutVerdict } from "../filesystem/self-protection/keep-out.ts";
import type { WholeInstrumentKind } from "../kernel/config-contracts.ts";
import { hostUserCacheFolder } from "../filesystem/user-folders.ts";
import { repositoryToplevel } from "../git/repository-ownership.ts";
import { ownedInstrumentHold, setOwnedInstrumentHold } from "./instrument-lock-adoption.ts";
import { ancestorsOf, isOwnProcessIdentityLive, ownCgroupFile, ownCgroupPath } from "./process-facts.ts";

export type InstrumentLockConfig = Readonly<{
  /** The lock file, relative to the host user's cache folder (`hostUserCacheFolder`). */
  cacheRelativeLockPath: string;
  /** A run of this many test files or more is heavy. */
  minimumTestFiles: number;
  /** The whole instruments that are heavy by kind, whatever files they name. */
  wholeInstruments: readonly WholeInstrumentKind[];
  /** Each admitted run's caps: its scope's memory ceiling (a share of the host's memory) and its CPU weight. */
  perRun: PerRunCaps;
}>;

/** One admitted run's cgroup caps: its scope's `MemoryMax` (a share of the host's memory) and `CPUWeight`. */
export type PerRunCaps = Readonly<{ memoryMaxPercent: number; cpuWeight: number }>;

export type InstrumentHold = Readonly<{
  /** This process took the lock (a borrowed or light hold owns nothing). */
  owns: boolean;
  runner: string;
  path: string;
  /**
   * Frees an owned hold (a borrowed or light hold frees nothing). `failure`
   * is the run's OWN failure if it was failing (a thrown error, or what its
   * ending was): a run cut at its memory cap is refused typed
   * (`run_memory_cap_exceeded`) and that refusal CARRIES the failure (its
   * message names both; `cause` is the failure), never replaces it.
   */
  release: (failure?: unknown) => void;
}>;

/**
 * Runs `body` inside `hold`, then releases it with the body's own failure (a
 * throw, or what `failureOf` says of its result), so a run cut at its memory
 * cap is refused typed WITH what the run was doing; without a cut, the body's
 * own throw stands. Every door that holds a run for a body uses this.
 */
export async function withinInstrumentHold<T>(hold: InstrumentHold, body: () => Promise<T> | T, failureOf: (result: T) => unknown = () => undefined): Promise<T> {
  let result: T;
  try {
    result = await body();
  } catch (error) {
    hold.release(error);
    throw error;
  }
  hold.release(failureOf(result));
  return result;
}

/** A run's own failure, in words, for the memory refusal that carries it. */
function failureInWords(failure: unknown): string {
  if (failure instanceof Error) return `${failure.name}: ${failure.message}`;
  return String(failure);
}

/**
 * The lock file of `config` for the harness checkout at `harnessRoot`: under
 * the per-user cache folder, and refused (`instrument_lock_misplaced`)
 * inside the checkout or the keep-out floor — by identity.
 */
export function instrumentLockPath(config: InstrumentLockConfig, harnessRoot: string): string {
  const misplaced = (why: string): HarnessError => new HarnessError(`the instrument lock (testExecution.instrumentLock.cacheRelativeLockPath = ${config.cacheRelativeLockPath}) ${why}`, "instrument_lock_misplaced");
  if (isAbsolute(config.cacheRelativeLockPath)) throw misplaced("must be relative to the per-user cache folder");
  const cache = hostUserCacheFolder();
  const lockPath = join(cache, config.cacheRelativeLockPath);
  const folder = resolveLocation(dirname(lockPath), "the instrument lock's folder");
  const overlap = identityOverlapIndex();
  if (!overlap.atOrUnder(folder, resolveLocation(cache, "the per-user cache folder"))) throw misplaced("must stay under the per-user cache folder");
  const repositoryRoot = repositoryToplevel(harnessRoot, "directory") ?? harnessRoot;
  if (overlap.overlaps(folder, resolveLocation(repositoryRoot, "the checkout"))) throw misplaced(`may not be inside or around the checkout ${repositoryRoot}`);
  if (floorKeepOutVerdict(harnessRoot, lockPath) !== undefined) throw misplaced("may not be in the keep-out floor");
  return lockPath;
}

/** A run of `testFileCount` test files is heavy (config, never code). */
export function isHeavyRun(config: InstrumentLockConfig, testFileCount: number): boolean {
  return testFileCount >= config.minimumTestFiles;
}

/**
 * THE COUNT A WHOLE INSTRUMENT PASSES the one heavy rule ({@link isHeavyRun}):
 * every file, when config declares the instrument heavy by kind
 * (`wholeInstruments`). An instrument config does not name is refused, never
 * guessed light: the rule lives in config, and a door of a kind it forgot
 * fails loudly.
 */
export function wholeInstrumentTestFileCount(config: InstrumentLockConfig, instrument: WholeInstrumentKind): number {
  if (!config.wholeInstruments.includes(instrument)) {
    throw new HarnessError(`testExecution.instrumentLock.wholeInstruments does not declare "${instrument}": whether a whole instrument is heavy is config's word, never a guess`, "instrument_lock_instrument_undeclared");
  }
  return Number.POSITIVE_INFINITY;
}

/** The run registry: the folder beside the configured path, one record per admitted run. */
function registryOf(lockPath: string): string {
  return `${lockPath}.runs`;
}

/** The registry's live records (a dead one is cleared as it is met: taken from its dead holder and released). */
function liveRuns(lockPath: string): readonly Readonly<{ path: string; holder: FileLockContent }>[] {
  const registry = registryOf(lockPath);
  let names: readonly string[];
  try {
    names = readdirSync(registry).filter((name) => name.endsWith(".lock"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const live: { path: string; holder: FileLockContent }[] = [];
  for (const name of names) {
    const path = join(registry, name);
    const holder = liveFileLockHolder(path);
    if (holder !== null) {
      live.push({ path, holder });
      continue;
    }
    // A dead run's record: the primitive breaks it for a new taker; release it at once.
    const cleared = tryAcquireFileLock(path, { holder: "registry sweep" });
    if (cleared.state === "taken") cleared.handle.release();
  }
  return live;
}

/**
 * `holder`'s LIVE processes (the holder and what it adopted) include this
 * process or one of its ancestors — each judged by its full identity (pid AND
 * start time, this user's): an adopted entry whose process ended is pruned
 * only at the next adoption, and its pid recycled into this lineage is not the
 * process the hold adopted (security L-3).
 */
function holdsThisProcess(holder: FileLockContent): boolean {
  const lineage = new Set([process.pid, ...ancestorsOf(process.pid)]);
  return [{ pid: holder.pid, startTime: holder.startTime }, ...holder.adopted].some((entry) => lineage.has(entry.pid) && isOwnProcessIdentityLive(entry));
}

/** The cgroup scope unit of the run whose record carries `nonce`. */
function runScopeUnit(nonce: string): string {
  return `bridlewise-run-${nonce}.scope`;
}

/**
 * THE RUN SCOPE'S SUBTREE (Delegate=yes). The scope itself holds no process:
 * the admitting process moves into its `run` leaf (everything it starts is
 * born there), and each test file's process moves into a `worker-<pid>` leaf
 * of its own ({@link enterOwnWorkerLeaf}), so the kernel accounts each
 * worker's memory, its children included (`memory.peak`), while the scope's
 * `MemoryMax` still caps them all.
 */
const RUN_LEAF = "run";
const WORKER_LEAF = /^worker-\d+$/u;

/** The cgroup v2 path of the run scope THIS process is inside (its own cgroup, or the parent of its `run` / `worker-<pid>` leaf); `undefined` outside a run's scope. */
export function runScopeCgroup(): string | undefined {
  const own = ownCgroupPath();
  if (own === undefined) return undefined;
  const last = own.slice(own.lastIndexOf("/") + 1);
  const scope = last === RUN_LEAF || WORKER_LEAF.test(last) ? own.slice(0, own.lastIndexOf("/")) : own;
  return /\/bridlewise-run-[^/]+\.scope$/u.test(scope) ? scope : undefined;
}

/** One interface file of the run scope THIS process is inside, trimmed; `undefined` outside a scope or when the file is absent. */
function runScopeFile(name: string): string | undefined {
  const scope = runScopeCgroup();
  if (scope === undefined) return undefined;
  try {
    return readFileSync(`/sys/fs/cgroup${scope}/${name}`, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Whether THIS process is inside the scope of the run whose record carries `nonce` (`/proc/self/cgroup`, cgroup v2), in the scope or one of its leaves. */
function insideRunScope(nonce: string): boolean {
  return runScopeCgroup()?.endsWith(`/${runScopeUnit(nonce)}`) === true;
}

/**
 * Splits the scope THIS process just entered: this process moves into the
 * `run` leaf and the scope's subtree gets the memory controller, so each
 * worker leaf has its own `memory.peak`. Throws `per_run_caps_unavailable`
 * when the host cannot (a scope that is not delegated).
 */
function splitRunScope(unit: string, caps: PerRunCaps): void {
  const scope = runScopeCgroup();
  if (scope === undefined) throw capsUnavailable(caps, `this process is not inside ${unit} after entering it`);
  const root = `/sys/fs/cgroup${scope}`;
  try {
    mkdirSync(join(root, RUN_LEAF));
    writeFileSync(join(root, RUN_LEAF, "cgroup.procs"), String(process.pid));
    writeFileSync(join(root, "cgroup.subtree_control"), "+memory");
  } catch (error) {
    throw capsUnavailable(caps, `${unit} could not be split into leaves (is it delegated?): ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Moves THIS process (a test file's own process) into a leaf of its own in
 * the run's scope, `worker-<pid>`, so its memory and its children's are
 * accounted on their own (`memory.peak`). Answers the leaf's cgroup path, or
 * `undefined` outside a run's scope (a light run has no scope to account in).
 */
export function enterOwnWorkerLeaf(): string | undefined {
  const scope = runScopeCgroup();
  if (scope === undefined) return undefined;
  const leaf = `${scope}/worker-${String(process.pid)}`;
  mkdirSync(`/sys/fs/cgroup${leaf}`, { recursive: true });
  writeFileSync(`/sys/fs/cgroup${leaf}/cgroup.procs`, String(process.pid));
  return leaf;
}

/** The peak memory, in bytes, the kernel has charged to THIS process's own worker leaf (its children included); `undefined` outside a worker leaf. */
export function ownWorkerMemoryPeakBytes(): number | undefined {
  const own = ownCgroupPath();
  if (own === undefined || !WORKER_LEAF.test(own.slice(own.lastIndexOf("/") + 1)) || runScopeCgroup() === undefined) return undefined;
  const text = readFileSync(`/sys/fs/cgroup${own}/memory.peak`, "utf8").trim();
  const peak = byteCountOf(text);
  if (peak === undefined) throw new HarnessError(`the worker leaf ${own} holds memory.peak ${text}, not a byte count`, "worker_memory_unreadable");
  return peak;
}

/** A cgroup interface file's byte count (its decimal digits exactly), or `undefined` for anything else ("max", absent). */
function byteCountOf(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= 0 && String(value) === text ? value : undefined;
}

/** The run scope's own memory readings: its cap (`memory.max`) and the peak it reached (`memory.peak`), in bytes; `undefined` outside a scope. */
export function runScopeMemory(): Readonly<{ maxBytes: number; peakBytes: number }> | undefined {
  const max = byteCountOf(runScopeFile("memory.max"));
  const peak = byteCountOf(runScopeFile("memory.peak"));
  return max === undefined || peak === undefined ? undefined : { maxBytes: max, peakBytes: peak };
}

/** The live run this process runs inside (its own, or an ancestor's) AND inside whose capped scope it is, if any. */
function enclosingRun(lockPath: string): Readonly<{ path: string; holder: FileLockContent }> | undefined {
  return liveRuns(lockPath).find((run) => holdsThisProcess(run.holder) && insideRunScope(run.holder.nonce));
}

/**
 * The run this process runs inside, BORROWED (it owns nothing and frees
 * nothing), or `undefined` when no admitted run covers it — never a take.
 */
export function borrowInstrumentLock(lockPath: string, runner: string): InstrumentHold | undefined {
  if (enclosingRun(lockPath) === undefined) return undefined;
  return deepFreeze({ owns: false, runner: printableHolderLabel(runner), path: lockPath, release: () => undefined });
}

/** The live admitted runs of the host, for a person: who, since when, how many adopted processes. Never waited on. */
export function admittedRuns(lockPath: string): readonly string[] {
  return liveRuns(lockPath).map(({ holder }) => `${holder.holder ?? "an unnamed instrument"} (pid ${String(holder.pid)}, since ${holder.acquiredAt}${holder.adopted.length === 0 ? "" : `, with ${String(holder.adopted.length)} adopted process(es)`})`);
}

/** The refusal of a run whose caps this host cannot put in force. */
function capsUnavailable(caps: PerRunCaps, why: string): HarnessError {
  return new HarnessError(
    `a heavy run is admitted only under its per-run caps (its own cgroup v2 scope: MemoryMax ${String(caps.memoryMaxPercent)}% with no swap, CPUWeight ${String(caps.cpuWeight)}; ` +
      `and the CPU-time limit), and this host could not put them in force (${why}). Nothing runs uncapped: give the host a running systemd user manager ` +
      "(`loginctl enable-linger`), `busctl` and `prlimit`.",
    "per_run_caps_unavailable",
  );
}

/** A short pause while the scope's start job runs (an event this process waits on, never a load threshold). */
const PAUSE = new Int32Array(new SharedArrayBuffer(4));

/**
 * Moves THIS process into the run's own scope under `caps` (the systemd user
 * manager's `StartTransientUnit`, this process's pid: what `systemd-run
 * --scope` does for a new command), waits for the move by the start job's own
 * state, and puts this process under the CPU-time limit. Every process it
 * starts afterwards is born inside both. Throws `per_run_caps_unavailable`.
 */
function enterRunScope(nonce: string, caps: PerRunCaps, cpu: SubprocessBounds): void {
  const unit = runScopeUnit(nonce);
  const memoryScale = Math.min(0xffffffff, Math.round((caps.memoryMaxPercent / 100) * 0xffffffff));
  const started = spawnSync("busctl", ["--user", "call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager",
    "StartTransientUnit", "ssa(sv)a(sa(sv))", unit, "fail", "7", "PIDs", "au", "1", String(process.pid), "MemoryMaxScale", "u", String(memoryScale),
    "MemorySwapMax", "t", "0", "OOMPolicy", "s", "continue", "Delegate", "b", "true",
    "CPUWeight", "t", String(caps.cpuWeight), "CollectMode", "s", "inactive-or-failed", "0"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (started.error !== undefined || started.status !== 0) {
    throw capsUnavailable(caps, `busctl StartTransientUnit ${started.error !== undefined ? started.error.message : `exited ${String(started.status)}: ${started.stderr.trim()}`}`);
  }
  const job = /^o "([^"]+)"/mu.exec(started.stdout)?.[1];
  if (job === undefined) throw capsUnavailable(caps, `the scope's start answered no job: ${started.stdout.trim()}`);
  const since = Date.now();
  while (!insideRunScope(nonce)) {
    const pending = spawnSync("busctl", ["--user", "get-property", "org.freedesktop.systemd1", job, "org.freedesktop.systemd1.Job", "State"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (pending.status !== 0 && !insideRunScope(nonce)) throw capsUnavailable(caps, `the start job of ${unit} ended without moving this process into it`);
    if (Date.now() - since > cpu.hangBackstopMs) throw capsUnavailable(caps, `HUNG: the start job of ${unit} was still pending at the ${String(cpu.hangBackstopMs / 1000)} s hang backstop (wall)`);
    Atomics.wait(PAUSE, 0, 0, 5);
  }
  verifyRunScopeCaps(unit, caps);
  splitRunScope(unit, caps);
  const limited = limitOwnCpu(cpu);
  if (limited !== null) throw capsUnavailable(caps, limited);
}

/**
 * READ BACK what the kernel and the user manager hold for the scope THIS
 * process is in (`unit`): a cap the host did not apply is no cap. Refused
 * typed (`per_run_caps_unavailable`) unless `memory.swap.max` is 0, it exists
 * at all (swap accounting on), `memory.max` is a byte count, and the unit's
 * OOMPolicy is `continue`.
 */
export function verifyRunScopeCaps(unit: string, caps: PerRunCaps): void {
  const swapMax = ownCgroupFile("memory.swap.max");
  if (swapMax === undefined) throw capsUnavailable(caps, `this host's cgroup v2 has no memory.swap.max for ${unit} (swap accounting is off), so its memory cap would be cap-plus-swap`);
  if (swapMax !== "0") throw capsUnavailable(caps, `${unit} holds memory.swap.max ${swapMax}, not 0: the run could swap past its memory cap`);
  const memoryMax = ownCgroupFile("memory.max");
  if (memoryMax === undefined || !/^\d+$/u.test(memoryMax)) throw capsUnavailable(caps, `${unit} holds memory.max ${memoryMax ?? "(absent)"}, not a byte count`);
  const oomPolicy = runScopeOomPolicy(unit);
  if (oomPolicy !== "continue") throw capsUnavailable(caps, `${unit} runs under OOMPolicy ${oomPolicy ?? "(unreadable)"}, not continue: one process past the cap would stop the whole run before it could say so`);
}

/** The OOM policy systemd holds for the run's scope `unit` (`Manager.GetUnit`, then the Scope's `OOMPolicy`), or `undefined` when unreadable. */
function runScopeOomPolicy(unit: string): string | undefined {
  const found = spawnSync("busctl", ["--user", "call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager", "GetUnit", "s", unit], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const path = found.status === 0 ? /^o "([^"]+)"/mu.exec(found.stdout)?.[1] : undefined;
  if (path === undefined) return undefined;
  const policy = spawnSync("busctl", ["--user", "get-property", "org.freedesktop.systemd1", path, "org.freedesktop.systemd1.Scope", "OOMPolicy"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return policy.status === 0 ? /^s "([^"]*)"/mu.exec(policy.stdout)?.[1] : undefined;
}

/**
 * How many processes the kernel has killed in the admitted run's scope THIS
 * process is inside for passing the run's memory cap (`memory.events`
 * `oom_kill`); `undefined` outside a run's scope (a light run has no cap of
 * its own).
 */
function runScopeOomKills(): number | undefined {
  if (runScopeCgroup() === undefined) return undefined;
  const events = runScopeFile("memory.events");
  const kills = events === undefined ? undefined : /^oom_kill (\d+)$/mu.exec(events)?.[1];
  return kills === undefined ? undefined : Number(kills);
}

/**
 * ADMIT a heavy run for `runner` (a bounded label: who runs, never a command
 * line) AT ONCE — or BORROW the run this process is inside. Never waits for
 * another run. This process enters the run's caps before anything else runs
 * under it: a host that cannot cap it is refused, and records nothing. Its
 * record is released by `release` (idempotent); the process stays in the
 * scope, which the user manager collects once its last process ends.
 */
export function admitInstrumentRun(lockPath: string, runner: string, caps: PerRunCaps, cpu: SubprocessBounds): InstrumentHold {
  if (runner.trim().length === 0) throw new HarnessError("a heavy run needs a runner name: the run registry names every admitted run", "instrument_lock_runner_unnamed");
  const label = printableHolderLabel(runner);
  const borrowed = borrowInstrumentLock(lockPath, label);
  if (borrowed !== undefined) return borrowed;
  const record = join(registryOf(lockPath), `${randomUuid()}.lock`);
  const answer = tryAcquireFileLock(record, { holder: label });
  if (answer.state !== "taken") {
    throw new HarnessError(`the run registry could not record ${label} at ${record} (${answer.state}): a fresh record name is never held`, "instrument_run_unrecorded");
  }
  // THIS process, and so everything it starts from now on, goes under the
  // run's caps; a host that cannot is refused, and the record goes with it.
  try {
    enterRunScope(answer.handle.nonce, caps, cpu);
  } catch (error) {
    answer.handle.release();
    throw error;
  }
  setOwnedInstrumentHold(answer.handle);
  // Released once: a later call (a runner's catch after a refused release) does nothing, so the refusal is said once.
  let released = false;
  return deepFreeze({
    owns: true, runner: label, path: lockPath,
    release: (failure?: unknown) => {
      if (released) return;
      released = true;
      if (ownedInstrumentHold() === answer.handle) setOwnedInstrumentHold(undefined);
      answer.handle.release();
      // The scope is the run's own (made at admission, so it started at 0):
      // a kill in it means the run was cut at its memory cap.
      const kills = runScopeOomKills();
      if (kills !== undefined && kills > 0) {
        const refusal = new HarnessError(
          `a process in the run ${label} was killed for passing the run's memory cap (${String(kills)} kill(s) in its scope's memory.events; ` +
            `MemoryMax ${String(caps.memoryMaxPercent)}% with no swap): the run ended there and its result is not a test result. ` +
            (failure === undefined ? "" : `The run was also failing when it was released (${failureInWords(failure)}), which the cut may have caused. `) +
            "Use less memory, or raise testExecution.instrumentLock.perRun.memoryMaxPercent in bridlewise.config.json.",
          "run_memory_cap_exceeded",
        );
        // The run's own failure rides along as the refusal's cause: the operator sees both.
        if (failure !== undefined) Object.defineProperty(refusal, "cause", { value: failure, enumerable: false, writable: false, configurable: true });
        throw refusal;
      }
    },
  });
}

/**
 * The hold for a run of `testFileCount` test files: an ADMITTED run when the
 * run is heavy ({@link admitInstrumentRun}), else a LIGHT hold that owns
 * nothing. A
 * heavy run with no declared registry is refused (`instrument_lock_undeclared`).
 */
export function holdInstrumentLock(options: Readonly<{
  config: InstrumentLockConfig | undefined;
  harnessRoot: string;
  runner: string;
  testFileCount: number;
  /** The CPU-time limit every process of the run gets (the harness's `SUBPROCESS_BOUNDS`). */
  cpu: SubprocessBounds;
}>): InstrumentHold {
  if (options.config === undefined) {
    throw new HarnessError("testExecution.instrumentLock is not declared in bridlewise.config.json: every heavy run is admitted under per-run caps, and the registry's place, what is heavy and the caps are declared there", "instrument_lock_undeclared");
  }
  const lockPath = instrumentLockPath(options.config, options.harnessRoot);
  if (!isHeavyRun(options.config, options.testFileCount)) {
    return deepFreeze({ owns: false, runner: options.runner, path: lockPath, release: () => undefined });
  }
  return admitInstrumentRun(lockPath, options.runner, options.config.perRun, options.cpu);
}
