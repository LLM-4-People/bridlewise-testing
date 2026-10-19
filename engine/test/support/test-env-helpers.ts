import { after } from "node:test";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { SAFE_READ_REJECT_ENV_VARS } from "../../src/shared/source-scan.ts";

/**
 * Shared test environment helpers (EXP481).
 *
 * These helpers let tests that verify PRODUCTION security invariants
 * (symlink/hardlink rejection) run with the production floor regardless of
 * the ambient dev-mode env vars, and let tests that need external resources
 * (the Landlock guardian binary) skip HONESTLY when the resource is absent
 * instead of erroring or timing out.
 */

/**
 * Save the current safe-read rejection env vars, force the PRODUCTION floor
 * (both = "1"), run the callback, then restore the originals. Tests that
 * verify symlink/hardlink REJECTION (a production security invariant) must
 * run with the production floor even in a dev workspace where the ambient
 * env vars are "0" (the dev-mode bypass disables the very rejection the test
 * verifies). `node --test` runs tests within a file sequentially, so the
 * restore is observed by later tests in the same file.
 */
export function withProductionRejectFloor<T>(fn: () => T): T {
  const savedHardlinks = process.env[SAFE_READ_REJECT_ENV_VARS.hardlinks];
  const savedSymlinks = process.env[SAFE_READ_REJECT_ENV_VARS.symlinks];
  process.env[SAFE_READ_REJECT_ENV_VARS.hardlinks] = "1";
  process.env[SAFE_READ_REJECT_ENV_VARS.symlinks] = "1";
  try {
    return fn();
  } finally {
    if (savedHardlinks === undefined) delete process.env[SAFE_READ_REJECT_ENV_VARS.hardlinks];
    else process.env[SAFE_READ_REJECT_ENV_VARS.hardlinks] = savedHardlinks;
    if (savedSymlinks === undefined) delete process.env[SAFE_READ_REJECT_ENV_VARS.symlinks];
    else process.env[SAFE_READ_REJECT_ENV_VARS.symlinks] = savedSymlinks;
  }
}

/**
 * Async variant: awaits the callback so the env-var restore runs AFTER the
 * async work completes (the sync version's `finally` would restore before a
 * returned promise resolves, leaking the production floor into later code).
 */
export async function withProductionRejectFloorAsync<T>(fn: () => Promise<T>): Promise<T> {
  const savedHardlinks = process.env[SAFE_READ_REJECT_ENV_VARS.hardlinks];
  const savedSymlinks = process.env[SAFE_READ_REJECT_ENV_VARS.symlinks];
  process.env[SAFE_READ_REJECT_ENV_VARS.hardlinks] = "1";
  process.env[SAFE_READ_REJECT_ENV_VARS.symlinks] = "1";
  try {
    return await fn();
  } finally {
    if (savedHardlinks === undefined) delete process.env[SAFE_READ_REJECT_ENV_VARS.hardlinks];
    else process.env[SAFE_READ_REJECT_ENV_VARS.hardlinks] = savedHardlinks;
    if (savedSymlinks === undefined) delete process.env[SAFE_READ_REJECT_ENV_VARS.symlinks];
    else process.env[SAFE_READ_REJECT_ENV_VARS.symlinks] = savedSymlinks;
  }
}

/**
 * @returns the path of the guardian binary if it exists, or `null`. Checks
 * the `guardian/build/` directory for the frozen C binary declared
 * in `ROOT_POLICY.selfProtection.binaryRelativePath`. Tests that
 * need the guardian can use this to detect availability.
 */
export function guardianBinaryPath(root: string): string | null {
  const candidate = join(root, "guardian", "build", "harness-landlock-guardian");
  if (existsSync(candidate)) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Turn the dev-mode safe-read bypass ON for the rest of this test FILE, and
 * put the previous values back when the file finishes.
 *
 * ── WHY A HELPER, AND WHY IT REGISTERS AN `after` ─────────────────────────
 *
 * Four test files set `HARNESS_REJECT_HARDLINKS=0` and `HARNESS_REJECT_SYMLINKS=0`
 * at MODULE SCOPE — before any test runs — and never put them back. Each had a
 * good local reason (a dev workspace seeded with `cp -rl` really does contain
 * hardlinks the production floor refuses), and the combined effect was that
 * two safety floors were off for everything that ran afterwards in the same
 * process, including tests that drive REAL writes at REAL shared artifacts.
 * A floor that is switched off at import and never restored is not a scoped
 * exception; it is a global one wearing the shape of a local decision.
 *
 * `withProductionRejectFloor` above is the mirror image — force the floor ON
 * for one callback — and this is the same idea for the file-scoped bypass, so
 * the two directions have one shape and neither is hand-rolled per file.
 */
export function relaxSafeReadFloorForThisFile(): void {
  const saved = {
    hardlinks: process.env[SAFE_READ_REJECT_ENV_VARS.hardlinks],
    symlinks: process.env[SAFE_READ_REJECT_ENV_VARS.symlinks],
  };
  process.env[SAFE_READ_REJECT_ENV_VARS.hardlinks] = "0";
  process.env[SAFE_READ_REJECT_ENV_VARS.symlinks] = "0";
  after(() => {
    for (const [key, value] of [
      [SAFE_READ_REJECT_ENV_VARS.hardlinks, saved.hardlinks],
      [SAFE_READ_REJECT_ENV_VARS.symlinks, saved.symlinks],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}
