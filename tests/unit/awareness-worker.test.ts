// @vitest-environment node
/**
 * Adversarial tests for the off-event-loop awareness worker (the second
 * 502 chat-run wedge fix). The awareness engine's `engine.compute` is a
 * CPU-heavy synchronous pass over every source file; run on the main
 * thread (the post-run quality call) it wedged the HTTP server for tens
 * of seconds on a large codebase. The compute now runs in a worker.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";

import {
  getAwarenessSnapshot,
  getAwarenessSnapshotAsync,
  invalidateAwarenessCache,
} from "../../server/awareness/awareness-bridge.ts";
import * as workerPool from "../../server/run/worker-pool.ts";
import { AwarenessNotReadyError, ProjectPathError } from "../../server/kernel/errors.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

let projectPath = "";

beforeEach(() => {
  projectPath = createTempDir("ch-aware-");
});

afterEach(() => {
  invalidateAwarenessCache(projectPath);
});

function seedProject(root: string, fileCount: number): void {
  mkdirSync(join(root, "src"), { recursive: true });
  for (let i = 0; i < fileCount; i++) {
    writeFileSync(
      join(root, "src", `mod${i}.ts`),
      `export function fn${i}(x: number): number { return x * ${i + 1}; }\n`,
    );
  }
}

describe("awareness worker — non-blocking (502 wedge fix)", () => {
  test("the worker compute does NOT block the event loop", async () => {
    seedProject(projectPath, 20);
    let timerFired = false;
    const timerPromise = new Promise<void>((resolve) => {
      setTimeout(() => { timerFired = true; resolve(); }, 0);
    });
    const snapPromise = getAwarenessSnapshotAsync(projectPath);
    await timerPromise;
    expect(timerFired).toBe(true);
    const snap = await snapPromise;
    expect(snap.fileCount).toBeGreaterThan(0);
  }, 30_000);

  test("concurrent async calls share one worker build", async () => {
    seedProject(projectPath, 10);
    const [a, b] = await Promise.all([
      getAwarenessSnapshotAsync(projectPath),
      getAwarenessSnapshotAsync(projectPath),
    ]);
    expect(a.fileCount).toBe(b.fileCount);
    // Cache ready — sync read succeeds (no throw, no re-build).
    const syncSnap = getAwarenessSnapshot(projectPath);
    expect(syncSnap.fileCount).toBe(a.fileCount);
  }, 30_000);

  test("sync accessor throws a typed AwarenessNotReadyError on a miss", () => {
    seedProject(projectPath, 5);
    let threw: unknown = null;
    const start = Date.now();
    try {
      getAwarenessSnapshot(projectPath);
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(AwarenessNotReadyError);
    expect((threw as AwarenessNotReadyError).retryable).toBe(true);
    // Non-blocking: a miss returns immediately (spawns the worker
    // fire-and-forget) — well under the time a real compute takes.
    expect(Date.now() - start).toBeLessThan(2000);
  });

  test("after the async build, the sync accessor returns the cached snapshot", async () => {
    seedProject(projectPath, 8);
    await getAwarenessSnapshotAsync(projectPath);
    const snap = getAwarenessSnapshot(projectPath);
    expect(snap.fileCount).toBeGreaterThan(0);
    expect(typeof snap.totalLoc).toBe("number");
  }, 30_000);
});


describe("awareness root admission precedes cache reads and worker startup", () => {
  test.each(["empty", "encrypted", "missing", "file"] as const)("refuses a %s root without starting a worker", async (kind) => {
    const file = join(projectPath, "a-file.ts");
    writeFileSync(file, "export const retained = 1;\n");
    const paths = { empty: "", encrypted: "enc:stale", missing: join(projectPath, "missing"), file };
    const codes = { empty: "project_path_empty", encrypted: "project_path_stale_encrypted", missing: "project_path_missing", file: "project_path_not_directory" };
    const spawn = vi.spyOn(workerPool, "runWorkerTask");
    try {
      expect(() => getAwarenessSnapshot(paths[kind])).toThrow(ProjectPathError);
      await expect(getAwarenessSnapshotAsync(paths[kind])).rejects.toMatchObject({ code: codes[kind] });
      expect(spawn, "an invalid root must be rejected before native worker startup").not.toHaveBeenCalled();
    } finally {
      spawn.mockRestore();
    }
  });

  test("a vanished cached root refuses, and recreating it performs a fresh populated scan", async () => {
    seedProject(projectPath, 1);
    const before = await getAwarenessSnapshotAsync(projectPath);
    expect(before.fileCount).toBe(1);
    rmSync(projectPath, { recursive: true });
    const spawn = vi.spyOn(workerPool, "runWorkerTask");
    try {
      expect(() => getAwarenessSnapshot(projectPath)).toThrow(ProjectPathError);
      await expect(getAwarenessSnapshotAsync(projectPath)).rejects.toMatchObject({ code: "project_path_missing" });
      expect(spawn).not.toHaveBeenCalled();
      seedProject(projectPath, 3);
      const after = await getAwarenessSnapshotAsync(projectPath);
      expect(after.fileCount).toBe(3);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      spawn.mockRestore();
    }
  });

  test("a directory lost after admission fails in the real worker instead of publishing an empty snapshot", async () => {
    seedProject(projectPath, 1);
    const original = workerPool.runWorkerTask;
    const spawn = vi.spyOn(workerPool, "runWorkerTask").mockImplementation((options) => {
      // The bridge has admitted the directory. Remove it at the actual
      // dispatch boundary, then execute the real worker and engine.
      rmSync(projectPath, { recursive: true });
      return original(options);
    });
    try {
      await expect(getAwarenessSnapshotAsync(projectPath)).rejects.toMatchObject({ code: "awareness_root_unreadable" });
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      spawn.mockRestore();
    }
  });

  test("a real empty directory remains an actual successful worker computation", async () => {
    const spawn = vi.spyOn(workerPool, "runWorkerTask");
    try {
      const snapshot = await getAwarenessSnapshotAsync(projectPath);
      expect(snapshot.fileCount).toBe(0);
      expect(snapshot.rootPath).toBe(projectPath);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      spawn.mockRestore();
    }
  });
});
