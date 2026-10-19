/**
 * THE MOVED-ASIDE CACHE SWEEP MATCHES EVERY SPELLING ON DISK.
 *
 * `npm run cache:evidence:sweep` (scripts/testing/sweep-cache-evidence.ts)
 * keeps the newest moved-aside copies of the web module cache and removes the
 * rest. Its first rule required `<label>-<epoch>` and matched 9 of the 237
 * copies measured on 2026-09-30: the rounds had written labels with no epoch
 * (`evidence-cache-worker-intent-…`) and a short `.evc.` spelling, and ~5 GB
 * stayed on disk. Each shape seen is pinned here, and the live cache itself —
 * the one directory the sweep must never touch — is pinned the other way.
 */
import { describe, expect, test } from "vitest";

import { isMovedAsideCache } from "../../scripts/testing/sweep-cache-evidence.ts";

describe("the moved-aside cache sweep", () => {
  test("every moved-aside spelling measured on disk is swept, the live cache and other names never", () => {
    for (const name of [
      ".experimental-vitest-cache.evidence-1786981263",
      ".experimental-vitest-cache.evidence-cache-worker-intent-tc-entry",
      ".experimental-vitest-cache.evidence-config-policy-boundary-erased-import-kinds-mutant",
      ".evc.f2g-1786981263",
      ".evc.f2t-1786980386",
    ]) expect(isMovedAsideCache(name), name).toBe(true);
    for (const name of [".experimental-vitest-cache", ".evc", "experimental-vitest-cache.evidence-1", ".vite", ".experimental-vitest-cache-other", "zod"]) {
      expect(isMovedAsideCache(name), name).toBe(false);
    }
  });
});
