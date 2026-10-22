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
 * `MemoryMax` and `CPUWeight` from `testExecution.instrumentLock.perRun`)
 * and under the CPU-time limit of every harness subprocess
 * (`src/process/subprocess-bounds.ts` `limitOwnCpu`). Everything the run
 * starts from then on — a supervised command, a worker, a child spawned
 * directly — is born inside the scope and under the limit; nothing it starts
 * is uncapped. A host that cannot make the scope or set the limit REFUSES
 * the run, typed (`per_run_caps_unavailable`): there is no uncapped mode.
 *
 * NESTING, read from the records' structured fields AND the kernel's: a
 * process BORROWS a live run (a validate's suites, a slot run's command,
 * vitest inside the web runner) only when the run's holder, or a process it
 * adopted, is this process or an ancestor, AND this process is inside the
 * run's own scope (`/proc/self/cgroup`). A borrower writes no record and
 * makes no scope (a nested scope would leave the outer cap); a process that
 * is not inside the scope borrows nothing, whatever its lineage.
 *
 * THE STAMP every measurement carries ({@link instrumentLockStamp}): "held"
 * when this process runs inside an admitted run AND carries that run's own
 * token (`HARNESS_INSTRUMENT_LOCK_TOKEN`, the record's nonce), else
 * "unslotted". Retiring the stamp is the measurement half (audit A-04, A-07).
 */
import { dirname, isAbsolute, join } from "node:path";

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

import { HarnessError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import { identityOverlapIndex, resolveLocation } from "../filesystem/path-identity.ts";
import { liveFileLockHolder, ownsFileLockHold, printableHolderLabel, tryAcquireFileLock, type FileLockContent } from "../filesystem/file-lock.ts";
import { randomUuid } from "../kernel/integrity.ts";
import { limitOwnCpu, type SubprocessBounds } from "./subprocess-bounds.ts";
import { floorKeepOutVerdict } from "../filesystem/self-protection/keep-out.ts";
import type { WholeInstrumentKind } from "../kernel/config-contracts.ts";
import { hostUserCacheFolder } from "../filesystem/user-folders.ts";
import { repositoryToplevel } from "../git/repository-ownership.ts";
import { ownedInstrumentHold, setOwnedInstrumentHold } from "./instrument-lock-adoption.ts";
import { ancestorsOf, isOwnProcessIdentityLive } from "./process-facts.ts";

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

/** Whether a measurement ran inside a live hold of the one instrument lock. */
export type InstrumentLockStamp = "held" | "unslotted";

/** The variable an owner exports its acquisition token (the record's nonce) in, for the stamp of everything it starts. */
export const INSTRUMENT_LOCK_TOKEN_VARIABLE = "HARNESS_INSTRUMENT_LOCK_TOKEN";

export type InstrumentHold = Readonly<{
  /** This process took the lock (a borrowed or light hold owns nothing). */
  owns: boolean;
  runner: string;
  path: string;
  /** The measurement's stamp for the run this hold covers. */
  stamp: InstrumentLockStamp;
  /** Frees an owned hold (idempotent; a borrowed or light hold frees nothing). */
  release: () => void;
}>;

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

/** Whether THIS process is inside the scope of the run whose record carries `nonce` (`/proc/self/cgroup`, cgroup v2). */
function insideRunScope(nonce: string): boolean {
  const unified = readFileSync("/proc/self/cgroup", "utf8").split("\n").find((line) => line.startsWith("0::"));
  return unified !== undefined && unified.endsWith(`/${runScopeUnit(nonce)}`);
}

/** The live run this process runs inside (its own, or an ancestor's) AND inside whose capped scope it is, if any. */
function enclosingRun(lockPath: string): Readonly<{ path: string; holder: FileLockContent }> | undefined {
  return liveRuns(lockPath).find((run) => holdsThisProcess(run.holder) && insideRunScope(run.holder.nonce));
}

/**
 * "held" when this process runs inside an admitted run (see the header): its
 * OWN run, by the admission this process made (`ownsFileLockHold`); or an
 * ancestor's, by the run's token the owner exported to what it starts.
 */
export function instrumentLockStamp(lockPath: string): InstrumentLockStamp {
  const run = enclosingRun(lockPath);
  if (run === undefined) return "unslotted";
  if (run.holder.pid === process.pid) return ownsFileLockHold(run.path, run.holder.nonce) ? "held" : "unslotted";
  return process.env[INSTRUMENT_LOCK_TOKEN_VARIABLE] === run.holder.nonce ? "held" : "unslotted";
}

/**
 * The run this process runs inside, BORROWED (it owns nothing and frees
 * nothing), or `undefined` when no admitted run covers it — never a take.
 */
export function borrowInstrumentLock(lockPath: string, runner: string): InstrumentHold | undefined {
  if (enclosingRun(lockPath) === undefined) return undefined;
  return deepFreeze({ owns: false, runner: printableHolderLabel(runner), path: lockPath, stamp: instrumentLockStamp(lockPath), release: () => undefined });
}

/** The live admitted runs of the host, for a person: who, since when, how many adopted processes. Never waited on. */
export function admittedRuns(lockPath: string): readonly string[] {
  return liveRuns(lockPath).map(({ holder }) => `${holder.holder ?? "an unnamed instrument"} (pid ${String(holder.pid)}, since ${holder.acquiredAt}${holder.adopted.length === 0 ? "" : `, with ${String(holder.adopted.length)} adopted process(es)`})`);
}

/** The refusal of a run whose caps this host cannot put in force. */
function capsUnavailable(caps: PerRunCaps, why: string): HarnessError {
  return new HarnessError(
    `a heavy run is admitted only under its per-run caps (its own cgroup v2 scope: MemoryMax ${String(caps.memoryMaxPercent)}%, CPUWeight ${String(caps.cpuWeight)}; ` +
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
    "StartTransientUnit", "ssa(sv)a(sa(sv))", unit, "fail", "4", "PIDs", "au", "1", String(process.pid), "MemoryMaxScale", "u", String(memoryScale),
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
  const limited = limitOwnCpu(cpu);
  if (limited !== null) throw capsUnavailable(caps, limited);
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
  // The run's token, for the stamp of everything this process starts
  // (its own stamp reads its admission); a token it inherited comes back on release.
  const inherited = process.env[INSTRUMENT_LOCK_TOKEN_VARIABLE];
  process.env[INSTRUMENT_LOCK_TOKEN_VARIABLE] = answer.handle.nonce;
  return deepFreeze({
    owns: true, runner: label, path: lockPath, stamp: "held",
    release: () => {
      if (ownedInstrumentHold() === answer.handle) setOwnedInstrumentHold(undefined);
      if (process.env[INSTRUMENT_LOCK_TOKEN_VARIABLE] === answer.handle.nonce) {
        if (inherited === undefined) delete process.env[INSTRUMENT_LOCK_TOKEN_VARIABLE];
        else process.env[INSTRUMENT_LOCK_TOKEN_VARIABLE] = inherited;
      }
      answer.handle.release();
    },
  });
}

/**
 * The hold for a run of `testFileCount` test files: an ADMITTED run when the
 * run is heavy ({@link admitInstrumentRun}), else a LIGHT hold that owns
 * nothing (its stamp still says whether it runs inside an admitted run). A
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
    return deepFreeze({ owns: false, runner: options.runner, path: lockPath, stamp: instrumentLockStamp(lockPath), release: () => undefined });
  }
  return admitInstrumentRun(lockPath, options.runner, options.config.perRun, options.cpu);
}
