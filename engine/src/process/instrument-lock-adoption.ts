/**
 * THE HOLD OF THE ONE INSTRUMENT LOCK THIS PROCESS OWNS — the one fact the
 * native supervisor's spawn needs (`supervised-run.ts`): every supervisor a
 * holder starts is adopted into the lock's record, so a holder killed
 * outright leaves the lock held until that supervisor — which ends only after
 * its whole process tree is gone — has ended too (src/process/instrument-lock.ts).
 * Kept apart from the lock's owner so the supervisor imports a registry, not
 * the lock's placement and keep-out machinery.
 */
import type { FileLockHandle } from "../filesystem/file-lock.ts";

let owned: FileLockHandle | undefined;
let launchPrefix: readonly string[] | undefined;

/**
 * Record (or, with `undefined`, forget) the admitted run this process owns,
 * with the LAUNCH PREFIX that puts each supervisor it starts under the run's
 * caps (src/process/instrument-lock.ts: its cgroup scope and CPU-time limit).
 */
export function setOwnedInstrumentHold(handle: FileLockHandle | undefined, prefix: readonly string[] | undefined): void {
  owned = handle;
  launchPrefix = handle === undefined ? undefined : prefix;
}

/** The argv that goes before a supervisor this process starts, so it runs under the owned run's caps; none outside an owned run. */
export function ownedRunLaunchPrefix(): readonly string[] | undefined {
  return launchPrefix;
}

/** The hold this process owns now, if any. */
export function ownedInstrumentHold(): FileLockHandle | undefined {
  return owned;
}

/**
 * Name `pid` (a supervisor this process just started) in the hold this
 * process OWNS. A process that owns no hold adopts nothing: inside a borrowed
 * hold, the owner's own adopted supervisor already spans this one.
 */
export function adoptIntoOwnedInstrumentLock(pid: number): void {
  owned?.adopt(pid);
}
