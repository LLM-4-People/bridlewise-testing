import { auditEvent } from "../../src/shared/debug/debug-system.ts";

/**
 * A RUN NEVER OUTLIVES ITS LAUNCHER: calls `onExit` once when the process
 * that LAUNCHED this one exits. The kernel re-parents an orphan (to init, or
 * to the nearest subreaper), so the parent pid this process had when the
 * watch began changes; `process.ppid` is asked afresh on every poll (every
 * `intervalMs`; the timer never keeps the process alive). Returns the
 * function that stops the watch.
 *
 * The test runners use it (engine `run-tests.ts`, web `scripts/run-tests.ts`):
 * a SIGTERM to the `npm test` wrapper used to leave the runner orphaned,
 * finishing the whole suite and holding the test-run lock while the wrapper
 * had already reported 143 (step6-readiness-2 F-11). Runner tooling, not
 * runtime: the web server never watches a launcher, so this standing timer
 * lives beside the runners' other supervision (`test-run-lock.ts`), never in
 * the server process's anatomy.
 */
export function watchLauncher(onExit: (launcherPid: number) => void, intervalMs: number): () => void {
  const launcher = process.ppid;
  const timer = setInterval(() => {
    if (process.ppid === launcher) return;
    clearInterval(timer);
    onExit(launcher);
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * THE ONE REPORT of a run its launcher's exit stopped, for both runners: the
 * audit event (`test-run-stopped`, reason `launcher-exited`) through central
 * logging, and the one sentence (wf-del2-design D9: the web runner used to
 * spell the sentence itself and log nothing). A runner launched directly from
 * a shell that then exits is stopped the same way: a detached run must keep a
 * live launcher.
 */
export function reportLauncherStop(launcherPid: number, wallClockMs: number, write: (text: string) => void): void {
  auditEvent("test-run-stopped", { reason: "launcher-exited", launcherPid, wallClockMs });
  write(`[run-tests] STOPPED: the launcher (pid ${String(launcherPid)}) exited, so this run was stopped and certifies nothing; no result was recorded.\n`);
}
