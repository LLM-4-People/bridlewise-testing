// @vitest-environment node
/**
 * Prevention test — guards the HTTP 502 chat-run wedge regression
 * (, ). The root cause was `getCachedMap` calling
 * `generateRepositoryMap` SYNCHRONOUSLY on the main event loop, blocking
 * every HTTP request for tens of seconds. The fix moved the build into a
 * `node:worker_threads` Worker. This test mechanically asserts the
 * blocking call cannot return:
 * 1. intelligence-bridge.ts does NOT import `generateRepositoryMap`
 * (only the type) — the worker owns the call.
 * 2. intelligence-bridge.ts has NO synchronous `generateRepositoryMap(`
 * call anywhere in its source.
 * 3. The worker file exists, imports `generateRepositoryMap`, and uses
 * `node:worker_threads`.
 * 4. intelligence-bridge routes the off-thread build through the worker
 * POOL (SPO), not a direct `new Worker(...)`. The pool
 * (`server/worker-pool.ts`) owns `new Worker(` + `node:worker_threads`;
 * the bridge calls `runWorkerTask`. This is the Single-Party-Owner
 * enforcement: `new Worker(` is confined to the pool.
 * 5. MapNotReadyError is a typed WebError subclass.
 *
 * SPO update: the bridge no longer imports `Worker` from
 * `node:worker_threads` or calls `new Worker(...)` — the worker pool
 * (`server/worker-pool.ts`) is the single spawning owner. The architecture
 * assertions below were updated to assert the pool routing instead of the
 * old direct-spawn pattern. The core invariant (no synchronous build) is
 * preserved.
 */
import { describe, test, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const serverDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "server",
);
const bridgePath = join(serverDir, "intelligence/intelligence-bridge.ts");
const workerPath = join(serverDir, "intelligence/repository-map-worker.ts");
const poolPath = join(serverDir, "run/worker-pool.ts");
const awarenessBridgePath = join(serverDir, "awareness/awareness-bridge.ts");
const awarenessWorkerPath = join(serverDir, "awareness/awareness-worker.ts");

describe("prevention: repository map never built synchronously (502 wedge)", () => {
  const bridgeSource = readFileSync(bridgePath, "utf8");
  const poolSource = existsSync(poolPath) ? readFileSync(poolPath, "utf8") : "";

  test("intelligence-bridge.ts does not import generateRepositoryMap as a value", () => {
    // Only the TYPE may be imported. A value import would let the main
    // thread call it synchronously (the regression).
    expect(bridgeSource).not.toMatch(/import\s*\{[^}]*\bgenerateRepositoryMap\b[^}]*\}\s*from\s*["']\.\/canonical\.ts["']/);
    // The type-only import is allowed.
    expect(bridgeSource).toMatch(/import type \{ RepositoryMap \}/);
  });

  test("intelligence-bridge.ts has no synchronous generateRepositoryMap(call", () => {
    // No call to generateRepositoryMap as a function anywhere in the
    // bridge (the worker owns it). Comments mentioning the name are
    // allowed, but a `generateRepositoryMap(` call (with paren) is not.
    // Strip comment lines first so a comment like "// generateRepositoryMap
    // SYNCHRONOUSLY" does not false-positive on the bare name, but a real
    // call still has the trailing "(".
    const codeLines = bridgeSource
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
    const code = codeLines.join("\n");
    expect(code).not.toContain("generateRepositoryMap(");
    expect(code).not.toContain("createRepositoryMapCache(");
  });

  test("the stat-scan module is importable by the main thread WITHOUT the parse machinery — no tree-sitter, no extractor VALUE imports", () => {
    // The no-change TTL refresh runs the stat walk ON THE MAIN THREAD
    // (measured ~18ms on this repository's tree) instead of spawning a
    // one-shot worker (~1.25s CPU: module transform + tree-sitter WASM init
    // + the previousCache clone). That only stays true while the stat-scan
    // module's own import graph carries none of that machinery: a value
    // import of the tree-sitter backend (or the symbol extractor, whose
    // module chain reaches it) would put the ~550ms WASM init + its
    // resident memory onto the server's MAIN thread at import time — the
    // exact cost the walk was moved off the worker to avoid. Type-only
    // imports are fine (erased at evaluation); the arm reads the module's
    // import lines, deny-by-default on the two banned specifiers.
    const statScanPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "engine",
      "src",
      "intelligence",
      "repository-stat-scan.ts",
    );
    expect(existsSync(statScanPath), "the stat-scan module must exist").toBe(true);
    const statScanSource = readFileSync(statScanPath, "utf8");
    const importLines = statScanSource
      .split("\n")
      .filter((l) => l.trim().startsWith("import"));
    const valueImportLines = importLines.filter((l) => !/^\s*import\s+type\b/.test(l));
    for (const line of valueImportLines) {
      expect(
        line,
        "repository-stat-scan.ts must not VALUE-import the parse machinery — the main-thread stat walk would pay the tree-sitter WASM init at import time",
      ).not.toMatch(/tree-sitter-backend|symbol-extractor\.ts/);
    }
    // The bridge's stat walk must come from THIS module, never from
    // repository-map.ts (whose module init pays the WASM boot): a
    // "normalizing" refactor re-merging the two files would silently put
    // the init cost back on the main thread with nothing red.
    expect(bridgeSource).toMatch(/from "..\/..\/engine\/src\/intelligence\/repository-stat-scan\.ts"/);
    const bridgeMapImport = bridgeSource.match(/import\s*\{[^}]*\}\s*from\s*["']\.\.\/\.\.\/engine\/src\/intelligence\/repository-map\.ts["']/);
    expect(
      bridgeMapImport,
      "intelligence-bridge.ts must not VALUE-import from repository-map.ts — the stat walk's owner is repository-stat-scan.ts",
    ).toBe(null);
  });

  test("the worker file exists and owns the off-thread build", () => {
    expect(existsSync(workerPath)).toBe(true);
    const workerSource = readFileSync(workerPath, "utf8");
    expect(workerSource).toContain("node:worker_threads");
    expect(workerSource).toContain("generateRepositoryMap");
    expect(workerSource).toContain("parentPort");
  });

  test("intelligence-bridge.ts routes the off-thread build through the worker POOL (no direct new Worker)", () => {
    // SPO: the bridge must NOT call `new Worker(...)` directly — the
    // worker pool (`server/worker-pool.ts`) is the single spawning owner.
    // The bridge imports + calls `runWorkerTask` from the pool instead.
    // Strip comment lines so a comment mentioning `new Worker(` (e.g. the
    // doc comment "no longer calls new Worker(...)") doesn't false-positive;
    // a real call would still appear in code.
    const code = bridgeSource
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    expect(bridgeSource).toContain('from "../run/worker-pool.ts"');
    expect(bridgeSource).toContain("runWorkerTask");
    expect(code).not.toContain("new Worker(");
    expect(bridgeSource).not.toMatch(/from "node:worker_threads"/);
    // The pool owns the spawn (the choke point).
    expect(existsSync(poolPath), "server/worker-pool.ts must exist (the single spawning owner)").toBe(true);
    expect(poolSource).toContain('from "node:worker_threads"');
    expect(poolSource).toContain("new Worker(");
  });

  test("MapNotReadyError is a typed WebError subclass", async () => {
    const { MapNotReadyError, WebError } = await import("../../server/kernel/errors.ts");
    const err = new MapNotReadyError("x");
    expect(err).toBeInstanceOf(WebError);
    expect(err.code).toBe("map_not_ready");
    expect(err.retryable).toBe(true);
    expect(err.name).toBe("MapNotReadyError");
  });
});

describe("prevention: awareness engine never computed synchronously (502 wedge #2)", () => {
  const bridgeSource = readFileSync(awarenessBridgePath, "utf8");
  // awareness-bridge is at the server root, so the pool is "./run/…" here.
  const poolSource = existsSync(poolPath) ? readFileSync(poolPath, "utf8") : "";

  test("awareness-bridge.ts does not call engine.compute synchronously on the main thread", () => {
    // The compute runs in the worker. The bridge must not call
    // `engine.compute(` or `.compute(` on the main thread (the regression
    // that wedged the server on a large codebase). Comments are allowed.
    const codeLines = bridgeSource
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
    const code = codeLines.join("\n");
    expect(code).not.toContain(".compute(");
    expect(code).not.toContain("engine.compute");
  });

  test("awareness-bridge.ts routes the off-thread compute through the worker POOL (no direct new Worker)", () => {
    // SPO: the bridge must NOT call `new Worker(...)` directly — the
    // worker pool is the single spawning owner. Strip comments so a doc
    // comment mentioning `new Worker(` doesn't false-positive.
    const code = bridgeSource
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    expect(bridgeSource).toContain('from "../run/worker-pool.ts"');
    expect(bridgeSource).toContain("runWorkerTask");
    expect(code).not.toContain("new Worker(");
    expect(bridgeSource).not.toMatch(/from "node:worker_threads"/);
    // The pool owns the spawn (shared with the intelligence bridge).
    expect(existsSync(poolPath)).toBe(true);
    expect(poolSource).toContain("new Worker(");
  });

  test("the awareness worker file exists and owns the off-thread compute", () => {
    expect(existsSync(awarenessWorkerPath)).toBe(true);
    const workerSource = readFileSync(awarenessWorkerPath, "utf8");
    expect(workerSource).toContain("node:worker_threads");
    expect(workerSource).toContain("createAwarenessEngine");
    expect(workerSource).toContain(".compute(");
    expect(workerSource).toContain("parentPort");
  });

  test("AwarenessNotReadyError is a typed WebError subclass", async () => {
    const { AwarenessNotReadyError, WebError } = await import("../../server/kernel/errors.ts");
    const err = new AwarenessNotReadyError("x");
    expect(err).toBeInstanceOf(WebError);
    expect(err.code).toBe("awareness_not_ready");
    expect(err.retryable).toBe(true);
    expect(err.name).toBe("AwarenessNotReadyError");
  });
});
