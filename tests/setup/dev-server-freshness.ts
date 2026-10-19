/**
 * A DEV SERVER THAT PREDATES THE LAST HEAD CHANGE IS REFUSED, NOT JUDGED.
 *
 * ── THE INCIDENT ──────────────────────────────────────────────────────────
 *
 * After the cutover's mass deletion, a long-lived vite dev server went
 * silently wedged: 31 of 45 e2e specs failed against it, and every failure
 * vanished on restart. Playwright's `reuseExistingServer` reuses whatever is
 * listening, so the suite kept judging a server whose module graph described
 * a tree that no longer existed — a false red that costs a diagnosis cycle
 * every time it happens, and it happens exactly when nobody expects it:
 * right after tree surgery, when the suite's verdict matters most.
 *
 * ── THE SIGNAL ────────────────────────────────────────────────────────────
 *
 * "The tree changed under the server" is approximated by "the server process
 * is OLDER than the last HEAD change" — a commit, merge, amend, reset or
 * branch switch rewrites the branch's loose ref or the worktree's `HEAD`,
 * and those files' mtimes are the cheapest honest clock for it. Ordinary
 * edits do NOT move them: hot reload covers the edit loop, and refusing on
 * every edit would make the preflight hostile to exactly the workflow it
 * protects. The known blind side runs the safe way: `git gc` rewrites
 * `packed-refs` without changing the tree, which can over-refuse — a restart
 * costs seconds; a wedged server costs a cycle.
 *
 * The server side is read from procfs through its one owner
 * (`engine/src/process/process-facts.ts`), not from a process-list scrape:
 * the listening TCP sockets for the dev ports, each process's socket
 * descriptors for their owning pids, and the start time as a wall clock. No
 * subprocess, no pattern that can match the wrong process — the same reason
 * the one-instrument lock is a lockfile and not a pgrep.
 *
 * Everything below is split pure (the verdict, fixture-driven in
 * `tests/prevention/dev-server-freshness.test.ts`, beside the owner's
 * parsers) from live (the procfs and `.git` reads), so the deciding logic is
 * tested without a machine.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { processesListeningOn, startWallTimeMsOf } from "../../engine/src/process/process-facts.ts";

/** The dev servers an e2e/profile run can inherit, by the ports they listen on. */
export interface DevServerPorts {
  readonly vite: number;
  readonly api: number;
}

/**
 * The ports the dev workflow itself declares: `vite.config.ts` sets
 * `server.port` for the client and derives the API port from
 * `HARNESS_WEB_PORT`, defaulting to the API server's own default in
 * `server/config.ts`. If those move and these do not, the preflight goes
 * quiet in the safe-stated way: it finds no listener and has nothing to
 * judge.
 */
export function devServerPorts(env: NodeJS.ProcessEnv = process.env): DevServerPorts {
  const api = Number(env.HARNESS_WEB_PORT ?? 5174);
  return { vite: 5173, api: Number.isInteger(api) && api > 0 ? api : 5174 };
}

export interface DevServerListener {
  readonly port: number;
  readonly pid: number;
  readonly startedAtMs: number;
}

/**
 * THE VERDICT, pure over its inputs. Every listener older than the last HEAD
 * change is named with its port, pid and both clocks, and the remedy is the
 * one action that clears it — restart the servers. Several stale listeners
 * produce one message listing all of them.
 */
export function devServerFreshnessRefusal(
  listeners: readonly DevServerListener[],
  headChangeMs: number,
): string | null {
  const stale = listeners.filter((listener) => listener.startedAtMs < headChangeMs);
  if (stale.length === 0) return null;
  const lines = stale.map((listener) =>
    `port ${String(listener.port)} (pid ${String(listener.pid)}): serving since ` +
    `${new Date(listener.startedAtMs).toISOString()}`);
  return (
    `the dev server predates the last HEAD change (${new Date(headChangeMs).toISOString()}): ` +
    `${lines.join("; ")}. A long-lived dev server keeps serving the module graph of the tree ` +
    "it started in — after the cutover's mass deletion, one answered 31 of 45 e2e specs with " +
    "failures that did not exist, and all of them vanished on restart. Restart the dev servers " +
    "and re-run; judging this run would be judging a tree that is no longer there."
  );
}

/** Listening dev servers, from procfs. Ports with no listener are simply absent. */
export function readDevServerListeners(ports: DevServerPorts): readonly DevServerListener[] {
  return processesListeningOn([ports.vite, ports.api]).flatMap(({ pid, port }) => {
    const startedAtMs = startWallTimeMsOf(pid);
    return startedAtMs === undefined ? [] : [{ port, pid, startedAtMs }]; // the process exited, or it is not ours to inspect
  });
}

/**
 * The newest mtime among the git files a HEAD change rewrites: the worktree's
 * `HEAD` (a switch), the current branch's loose ref (a commit, merge, amend
 * or reset), and `packed-refs` (which a repack rewrites — the stated
 * over-refusal). The worktree `.git` FILE (`gitdir: …`) and `commondir` are
 * resolved the same way `readRepositoryHeadSha` resolves them in
 * `engine/src/shared/run-history.ts` — one answer to "where does this
 * worktree's HEAD live", kept deliberately small here because the runners
 * read it without a subprocess. Returns null when nothing along the way
 * reads — absence, reported as NOT JUDGED by the caller, never a guess.
 */
export function lastHeadChangeMs(repositoryRoot: string): number | null {
  const tryRead = (path: string): string | null => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  };
  let gitDir = join(repositoryRoot, ".git");
  const asFile = tryRead(gitDir);
  if (asFile !== null && asFile.startsWith("gitdir:")) {
    gitDir = asFile.slice("gitdir:".length).trim();
  }
  let refsDir = gitDir;
  const common = tryRead(join(gitDir, "commondir"))?.trim();
  if (common !== undefined) refsDir = join(gitDir, common);

  const candidates = [join(gitDir, "HEAD"), join(refsDir, "packed-refs")];
  const head = tryRead(join(gitDir, "HEAD"))?.trim();
  if (head !== undefined && head.startsWith("ref: ")) {
    const ref = head.slice("ref: ".length).trim();
    candidates.push(join(refsDir, ref));
    if (refsDir !== gitDir) candidates.push(join(gitDir, ref));
  }
  let newest: number | null = null;
  for (const candidate of candidates) {
    try {
      const mtime = statSync(candidate).mtimeMs;
      if (newest === null || mtime > newest) newest = mtime;
    } catch {
      // A missing loose ref or packed-refs is an ordinary shape of a healthy
      // repository; only the ones that exist vote.
    }
  }
  return newest;
}

/**
 * The door both Playwright suites walk through: refuse the run when a
 * listening dev server is older than the last HEAD change. No listener means
 * the runner spawns or provides a fresh one, and an unreadable clock means
 * the preflight says what it could not measure instead of guessing — a NOT
 * JUDGED line, never a silent pass and never a fabricated red.
 */
export function assertFreshDevServers(repositoryRoot: string): void {
  const headChangeMs = lastHeadChangeMs(repositoryRoot);
  if (headChangeMs === null) {
    console.log("dev-server freshness: NOT JUDGED — the repository's HEAD clock could not be read");
    return;
  }
  const listeners = readDevServerListeners(devServerPorts());
  const refusal = devServerFreshnessRefusal(listeners, headChangeMs);
  if (refusal !== null) throw new Error(refusal);
}
