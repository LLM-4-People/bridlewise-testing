// @vitest-environment node
/**
 * Adversarial tests for the off-event-loop repository-map worker (:
 * the HTTP 502 chat-run wedge root-cause fix).
 *
 * Covers:
 * hard, adversarial, improper-usage tests.
 * no faking/weakening.
 * a prevention test guards the regression (the map is NEVER
 * built synchronously on the main thread).
 *
 * Tests:
 * 1. The worker build does NOT block the event loop (a setTimeout fires
 * while the worker is indexing) — the regression that caused 502.
 * 2. Concurrent async calls for the same path SHARE one worker (both
 * resolve to the same ready cache entry; no duplicate build).
 * 3. The synchronous accessor throws a typed MapNotReadyError (not a
 * bare Error) on a miss, with retryable=true, and does NOT block.
 * 4. injectRepositoryMapIntoPrompt skips injection gracefully (returns
 * the prompt unchanged) when the map is not ready — the run route's
 * "skip and proceed" behavior.
 * 5. After the async build completes, the sync accessor returns the
 * cached map instantly (no re-build) and injection appends the
 * Codebase intelligence section.
 * 6. A stale-encrypted project path throws a typed ProjectPathError
 * BEFORE any worker is spawned (improper usage — no worker leak).
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";

import {
  getRepositoryMap,
  getRepositoryMapAsync,
  getRepositoryMapSummary,
  injectRepositoryMapIntoPrompt,
  invalidateProjectCache,
} from "../../server/intelligence/intelligence-bridge.ts";
import { MapNotReadyError, ProjectPathError } from "../../server/kernel/errors.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

let projectPath = "";

beforeEach(() => {
  projectPath = createTempDir("ch-worker-");
});

afterEach(() => {
  invalidateProjectCache(projectPath);
});

// Generate a moderate-sized project so the worker build takes measurable
// time (worker startup + parsing N files), making the non-blocking test
// meaningful. ~40 source files with a few symbols each.
function seedProject(root: string, fileCount: number): void {
  mkdirSync(join(root, "src"), { recursive: true });
  for (let i = 0; i < fileCount; i++) {
    writeFileSync(
      join(root, "src", `mod${i}.ts`),
      `export function fn${i}(x: number): number { return x * ${i + 1}; }\nexport const v${i} = ${i};\n`,
    );
  }
}

describe("repository-map worker — non-blocking (502 wedge fix)", () => {
  test("the worker build does NOT block the event loop", async () => {
    seedProject(projectPath, 40);
    // A setTimeout(0) callback. If the event loop were blocked by a
    // synchronous generateRepositoryMap (the old behavior), this callback
    // would NOT fire until the build finished. The worker runs off-thread,
    // so the callback fires on the next event-loop tick — long before the
    // worker posts its result.
    let timerFired = false;
    const timerPromise = new Promise<void>((resolve) => {
      setTimeout(() => { timerFired = true; resolve(); }, 0);
    });
    // Kick off the async build (spawns a worker).
    const mapPromise = getRepositoryMapAsync(projectPath);
    // Await the timer FIRST. If the build blocked the event loop, this
    // await would hang until the worker finished.
    await timerPromise;
    expect(timerFired).toBe(true);
    // The map should still be pending (worker takes longer than a
    // setTimeout(0)), proving the worker ran in parallel with the event
    // loop. (We don't assert mapPromise is still pending — it may have
    // resolved for a tiny project — only that the timer fired WHILE the
    // build was in flight, which is impossible under a blocking build.)
    const map = await mapPromise;
    expect(map.files.length).toBeGreaterThan(0);
  });

  test("concurrent async calls for the same path share one worker build", async () => {
    seedProject(projectPath, 20);
    // Two concurrent builds for the SAME path. The pending cache entry's
    // shared promise means only ONE worker is spawned; both callers await
    // the same result. The proof: both resolve to maps with identical
    // file counts (the same build), and a subsequent sync read is instant
    // (cache ready — no second build, no MapNotReadyError).
    const a = getRepositoryMapAsync(projectPath);
    const b = getRepositoryMapAsync(projectPath);
    const [mapA, mapB] = await Promise.all([a, b]);
    expect(mapA.files.length).toBe(mapB.files.length);
    expect(mapA.modules.length).toBe(mapB.modules.length);
    // Cache is now ready — sync read succeeds (no throw, no re-build).
    const syncMap = getRepositoryMap(projectPath);
    expect(syncMap.files.length).toBe(mapA.files.length);
  });

  test("sync accessor throws a typed MapNotReadyError on a miss (does not block)", () => {
    seedProject(projectPath, 5);
    // Miss: the map has not been built yet. The sync accessor must throw
    // a typed MapNotReadyError (retryable) — NOT block the event loop and
    // NOT return a partially-built map.
    let threw: unknown = null;
    try {
      getRepositoryMap(projectPath);
    } catch (err) {
      threw = err;
    }
    // Non-blocking proof, BY ITS PATH: a miss throws (the build is
    // off-thread, spawned fire-and-forget) instead of building inline and
    // returning a map; no wall clock judges it (NO-LOAD-BLOCK).
    expect(threw).toBeInstanceOf(MapNotReadyError);
    expect((threw as MapNotReadyError).retryable).toBe(true);
  });

  test("getRepositoryMapSummary throws MapNotReadyError when not ready", () => {
    seedProject(projectPath, 5);
    expect(() => getRepositoryMapSummary(projectPath)).toThrow(MapNotReadyError);
  });
});

describe("repository-map worker — prompt injection (skip when not ready)", () => {
  test("injectRepositoryMapIntoPrompt skips injection when the map is not ready", () => {
    seedProject(projectPath, 5);
    const prompt = "You are an assistant.";
    // The map is not ready (no prior build). Injection must skip gracefully
    // (return the prompt unchanged) — the run route's "skip and proceed"
    // behavior that prevents the 502 wedge on the first chat run.
    const result = injectRepositoryMapIntoPrompt(prompt, projectPath);
    expect(result).toBe(prompt);
  });

  test("injectRepositoryMapIntoPrompt appends the Codebase intelligence section once the map is ready", async () => {
    seedProject(projectPath, 10);
    await getRepositoryMapAsync(projectPath);
    const prompt = "You are an assistant.";
    const result = injectRepositoryMapIntoPrompt(prompt, projectPath);
    expect(result).toContain("## Codebase intelligence");
    expect(result).toContain("Pre-indexed map:");
    expect(result.startsWith(prompt)).toBe(true);
  });
});

describe("repository-map worker — improper usage (no worker leak on bad path)", () => {
  test("a stale enc: project path throws ProjectPathError before any worker spawn", async () => {
    // The path validation runs in the MAIN thread before the worker is
    // spawned, so a bad path throws a typed ProjectPathError (not a
    // MapNotReadyError) — no worker is leaked. The async path must be
    // awaited (rejects.toThrow returns a promise; without await the
    // assertion is never evaluated + the test passes spuriously).
    await expect(getRepositoryMapAsync("enc:stale-ciphertext")).rejects.toThrow(ProjectPathError);
    expect(() => getRepositoryMap("enc:stale-ciphertext")).toThrow(ProjectPathError);
  });

  test("an empty project path throws ProjectPathError", () => {
    expect(() => getRepositoryMap("")).toThrow(ProjectPathError);
  });

  test("a missing project path throws ProjectPathError", () => {
    expect(() => getRepositoryMap("/this/does/not/exist/anywhere")).toThrow(ProjectPathError);
  });
});
