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
 * EVERY ADMITTED RUN IS CAPPED, not serialized: each command it starts under
 * the native supervisor (`supervised-run.ts`) runs in a cgroup v2 scope of
 * its own (`systemd-run --user --scope`: `MemoryMax` and `CPUWeight` from
 * `testExecution.instrumentLock.perRun`) and under the CPU-time limit of
 * every harness subprocess (`src/process/subprocess-bounds.ts`). A host that
 * cannot make the scope REFUSES the run, typed (`per_run_caps_unavailable`):
 * there is no uncapped mode (the probe is recorded once per process).
 *
 * NESTING, read from the records' structured fields: a run whose ancestor
 * holds a live record is inside that run and BORROWS it (a validate's
 * suites, a slot run's command, vitest inside the web runner); it writes no
 * record and makes no scope of its own (a nested scope would leave the
 * outer cap).
 *
 * NO MEASUREMENT STAMP. A reading used to count only when taken "held"
 * (inside the one global lock) and was refused "unslotted" otherwise. Every
 * judged cost is CPU work, valid beside other runs (NO-LOAD-BLOCK, audit
 * A-04, A-05, A-07, A-12), so a run's admission says nothing about its
 * measurement and nothing reads it.
 */
import { dirname, isAbsolute, join } from "node:path";

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

import { HarnessError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import { identityOverlapIndex, resolveLocation } from "../filesystem/path-identity.ts";
import { liveFileLockHolder, printableHolderLabel, tryAcquireFileLock, type FileLockContent } from "../filesystem/file-lock.ts";
import { randomUuid } from "../kernel/integrity.ts";
import { cpuLimitPrefix, type SubprocessBounds } from "./subprocess-bounds.ts";
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

/** One admitted run's cgroup caps (`systemd-run --user --scope -p MemoryMax=…% -p CPUWeight=…`). */
export type PerRunCaps = Readonly<{ memoryMaxPercent: number; cpuWeight: number }>;

export type InstrumentHold = Readonly<{
  /** This process took the lock (a borrowed or light hold owns nothing). */
  owns: boolean;
  runner: string;
  path: string;
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

/** The live run this process runs inside (its own, or an ancestor's), if any. */
function enclosingRun(lockPath: string): Readonly<{ path: string; holder: FileLockContent }> | undefined {
  return liveRuns(lockPath).find((run) => holdsThisProcess(run.holder));
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

let capsProbed: string | null | undefined;

/**
 * The recorded capability probe (one-package-probe-dont-branch): can this
 * host make a cgroup v2 scope for the run (`systemd-run --user --scope`)?
 * Answered once per process; a host that cannot is REFUSED, never run uncapped.
 */
export function assertPerRunCapsAvailable(caps: PerRunCaps): void {
  if (capsProbed === undefined) {
    const probe = spawnSync("systemd-run", [...perRunScopeArguments(caps), "true"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    capsProbed = probe.error === undefined && probe.status === 0 ? null
      : `${probe.error !== undefined ? probe.error.message : `systemd-run exited ${String(probe.status)}${probe.signal === null ? "" : ` (${probe.signal})`}`}: ${probe.stderr?.trim() ?? ""}`;
  }
  if (capsProbed !== null) {
    throw new HarnessError(
      `a heavy run is admitted only under its per-run caps (a cgroup v2 scope: MemoryMax ${String(caps.memoryMaxPercent)}%, CPUWeight ${String(caps.cpuWeight)}), ` +
        `and this host cannot make one through \`systemd-run --user --scope\` (${capsProbed}). Nothing runs uncapped: give the host a running systemd user manager (\`loginctl enable-linger\`).`,
      "per_run_caps_unavailable",
    );
  }
}

/** `systemd-run`'s arguments for one run's scope (the command follows). */
export function perRunScopeArguments(caps: PerRunCaps): readonly string[] {
  return ["--user", "--scope", "--quiet", "--collect", "-p", `MemoryMax=${String(caps.memoryMaxPercent)}%`, "-p", `CPUWeight=${String(caps.cpuWeight)}`, "--"];
}

/**
 * ADMIT a heavy run for `runner` (a bounded label: who runs, never a command
 * line) AT ONCE — or BORROW the run this process is inside. Never waits for
 * another run. The run's caps are probed first: a host that cannot cap it is
 * refused. Its record is released by `release` (idempotent).
 */
export function admitInstrumentRun(lockPath: string, runner: string, caps: PerRunCaps, cpu: SubprocessBounds): InstrumentHold {
  if (runner.trim().length === 0) throw new HarnessError("a heavy run needs a runner name: the run registry names every admitted run", "instrument_lock_runner_unnamed");
  const label = printableHolderLabel(runner);
  const borrowed = borrowInstrumentLock(lockPath, label);
  if (borrowed !== undefined) return borrowed;
  assertPerRunCapsAvailable(caps);
  const record = join(registryOf(lockPath), `${randomUuid()}.lock`);
  const answer = tryAcquireFileLock(record, { holder: label });
  if (answer.state !== "taken") {
    throw new HarnessError(`the run registry could not record ${label} at ${record} (${answer.state}): a fresh record name is never held`, "instrument_run_unrecorded");
  }
  // Every supervisor this run starts goes under its caps: its own cgroup
  // scope (memory, CPU weight), then the CPU-time limit, then the supervisor.
  setOwnedInstrumentHold(answer.handle, ["systemd-run", ...perRunScopeArguments(caps), ...cpuLimitPrefix(cpu)]);
  return deepFreeze({
    owns: true, runner: label, path: lockPath,
    release: () => {
      if (ownedInstrumentHold() === answer.handle) setOwnedInstrumentHold(undefined, undefined);
      answer.handle.release();
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
