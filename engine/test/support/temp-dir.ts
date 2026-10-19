import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createOwnedTemporaryDirectory } from "../../src/filesystem/private-state.ts";

/**
 * SINGLE-PARTY OWNER of test temporary directories for this repo.
 *
 * ── The defect this exists to make impossible ────────────────────────────
 *
 * This module used to export `mkTempDir`, which created a directory and
 * registered NOTHING — cleanup was left to each of its 688 call sites across
 * 32 files. Every one of those sites was one forgotten `finally` away from a
 * leak, and separately six files created dirs through local helpers with no
 * cleanup at all. Measured in /tmp (a 36G tmpfs) before this repair: 74,476
 * stale directories across both repos, including 6,377 `eval-executor-test-*`,
 * 3,825 `bridlewise-core-*` and 2,847 `bridlewise-schema-*` from here. The
 * filesystem reached 100% and test runs began failing with ENOSPC.
 *
 * `mkTempDir` is now an alias of `createTempDir`, which registers removal in
 * the same call. Creating a temp dir without cleanup is no longer expressible
 * through this module, and the prevention test forbids reaching around it.
 *
 * ── Why this mechanism (a built-in, not custom machinery) ────────────────
 *
 * This repo runs on `node:test`, not vitest, so there is no `onTestFinished`.
 * The built-in used here is the root-level `test.after` hook. Registering it
 * at module scope works because a support module is evaluated while the test
 * file's module graph loads — before any test runs — so the hook attaches to
 * that process's root suite. `scripts/inventory-test-run.ts` runs every test
 * file in its own child process (`isolation: "process"`), so one registration
 * per file is exactly the right scope.
 *
 * ONE hook drains a Set, rather than one hook per created directory: the same
 * shape already proven in `test/support/git-fixtures.ts`. Root `after` hooks
 * run whether the file's tests passed or failed, which is the case that
 * actually caused the leak.
 *
 * A per-test hook (`t.after()`) would be tighter still, but it requires the
 * `TestContext` argument, which the 688 existing call sites do not have.
 * File-scoped cleanup stops the leak; `withTempDir` remains available where a
 * caller wants the directory gone the moment its block ends.
 *
 * ── A PROCESS KILLED BEFORE ITS HOOKS RUN ────────────────────────────────
 *
 * No hook runs in a test process killed by a signal (the runner's timeout or
 * stall abort, a run killed by hand), so its directories used to stay in the
 * temp root for ever, with random names nobody could attribute. Every
 * directory is now created inside ONE root per process, an OWNED temporary
 * (`bridlewise-engine-test-<pid>-<start time>-<nonce>`,
 * `src/filesystem/private-state.ts`): the first creation in a process sweeps
 * the roots dead processes left, and the process's own exit removes its root.
 * Inside it a counter names each directory (only this process writes there).
 */

/** Temp dirs created but not yet removed. Drained by the `test.after` below. */
const LIVE = new Set<string>();

function remove(dir: string): void {
  LIVE.delete(dir);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Cleanup is best-effort: failing to unlink must never turn a test red.
  }
}

// The file-scope backstop. Registered once, when this module is first loaded
// by a test file, and run after that file's tests regardless of outcome.
test.after(() => {
  for (const dir of [...LIVE]) remove(dir);
});

/** The name every process root starts with (and the sweep matches). */
const PROCESS_ROOT_PREFIX = "bridlewise-engine-test-";

let processRoot: string | undefined;
let created = 0;

/**
 * This process's owned root in the system temp root: created (dead owners'
 * roots swept) on first use; the owner (`createOwnedTemporaryDirectory`)
 * removes it when the process exits.
 */
function ownProcessRoot(): string {
  processRoot ??= createOwnedTemporaryDirectory(tmpdir(), PROCESS_ROOT_PREFIX);
  return processRoot;
}

/**
 * Create a temporary directory whose removal is already registered.
 *
 * @param prefix directory-name prefix, e.g. `"bridlewise-core-"`. Callers
 *        keep their former prefixes so per-file directory identity survives.
 */
export function createTempDir(prefix: string): string {
  created += 1;
  const dir = join(ownProcessRoot(), `${prefix}${String(created)}`);
  mkdirSync(dir, { mode: 0o700 });
  LIVE.add(dir);
  return dir;
}

/**
 * Backwards-compatible name for {@link createTempDir}.
 *
 * Previously this created a directory and registered no cleanup — the single
 * largest leak surface in this repo. It is now the same owned call, so all
 * existing call sites became leak-free without being touched.
 */
export const mkTempDir = createTempDir;

/**
 * Run `fn` with a temp dir that is removed as soon as the block ends, rather
 * than at end of file. Prefer this for dirs created in a loop.
 */
export function withTempDir<T>(prefix: string, fn: (dir: string) => T): T {
  const dir = createTempDir(prefix);
  try {
    return fn(dir);
  } finally {
    remove(dir);
  }
}

export async function withTempDirAsync<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = createTempDir(prefix);
  try {
    return await fn(dir);
  } finally {
    remove(dir);
  }
}

/**
 * Former name for the only variant that used to register cleanup. Retained so
 * its 14 existing call sites keep working; every creator is owned now.
 */
export const mkOwnedTempDir = createTempDir;

/**
 * The system temp root, for tests that need a temp PATH STRING but create
 * nothing at it — e.g. asserting that a path-boundary check rejects a path
 * outside the repository, or probing a lock file that must not exist.
 *
 * This exists so the prevention test can ban `os.tmpdir()` everywhere with no
 * allowlist: a legitimate path-only use has a named route through the owner,
 * and the name makes the "nothing is created here" claim explicit. If you are
 * about to create something at the returned path, you want `createTempDir`.
 */
export function systemTempRoot(): string {
  return tmpdir();
}
