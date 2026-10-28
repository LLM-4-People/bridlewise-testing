/**
 * A PROCESS ENDS BY DRAINING ITS EVENT LOOP, NEVER BY `process.exit()` (#351).
 *
 * WHY — a measured defect. `process.exit()` tears Node's platform down while a
 * concurrent V8 compile job may still wait for a garbage collection the main
 * thread will never run, so the join never returns (nodejs/node#54918). On this
 * host, 30 orphaned `build-bundle.ts --check` processes sat at zero CPU across
 * 15 worktrees, each left with 3 threads in futex waits after printing its
 * verdict. Under a 240 s wall kill this was the "failed without a status
 * payload" of `harness sync`. Measured at 8 lanes: 5 of 1500 `--check` runs
 * ending by `process.exit()` hung; 0 of 1500, then 0 of 3000 interleaved run for
 * run, hung once the script set `process.exitCode` and let the loop drain.
 *
 * THE RULE covers every tracked source file of the repository, read through its
 * code view (comments, strings and templates blanked): a child program spelled
 * inside a test's string is that child's behaviour under test, not the ending
 * of any process this tree runs. A file that must end a process outright says
 * why below, with its exact count; a stale or miscounted declaration is refused
 * like an undeclared call.
 *
 * GUARD SUBJECT: no process of this tree ends by `process.exit()` except the declared last resorts
 * GUARD OWNS: every tracked source file's code view, scanned with the one source-view owner
 * GUARD PLANT: a `process.exit(0)` planted in code is found; the same text in a comment or a string, and `process.exitCode = 0`, are not
 * GUARD DRIVEN: walk the repository (the walker checks its universe against the git index) and match `process.exit(` over each file's code view
 * GUARD LIVENESS: the walk is asserted to reach this file and more than a thousand sources, and every declaration to match its file's count
 */
import assert from "node:assert/strict";
import { relative, resolve, sep } from "node:path";
import test from "node:test";

import { readSourceView, sourceViewOf } from "../../scripts/verification/source-view.ts";
import { walk } from "../../scripts/verification/source-walk.ts";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");
const EXIT_CALL = /\bprocess\.exit\s*\(/u;

/** Recorded qualification evidence: its runners' bytes are pinned by the qualification inventories and receipts. */
const PINNED_EVIDENCE = "engine/verification/benchmarks/";

/** The declared last resorts: an outright end is the contract, and each says why. */
const DECLARED: Readonly<Record<string, Readonly<{ count: number; reason: string }>>> = {
  "engine/src/process/fault-policy.ts": {
    count: 1,
    reason: "the fatal path after an uncaught exception: the process state is broken, so it ends at once, as Node's default does",
  },
  "engine/src/process/worker-bootstrap.ts": {
    count: 1,
    reason: "inside a worker thread `process.exit()` ends that thread alone (no platform shutdown); a worker whose entry failed to load stops",
  },
  "engine/src/intelligence/farm-child.ts": {
    count: 1,
    reason: "the escalation of a forked child whose farm left: it drains first, and only a child still held open after the bound is ended",
  },
  "server/index.ts": {
    count: 1,
    reason: "the long-running server's end after its shutdown signal and close: its open handles (database, watchers) are not drained",
  },
  "server/kernel/boot-settings-preflight.ts": {
    count: 2,
    reason: "an import-time boot refusal must stop module evaluation before anything else loads, with the configuration-error status (78)",
  },
  "engine/test/migration-write-authority/hostile/worker.ts": {
    count: 3,
    reason: "a hostile fixture whose abrupt death (137) or immediate end is the behaviour the test drives",
  },
  "engine/test/mcp/fixtures/adversarial-mcp-server.mjs": {
    count: 2,
    reason: "a fake MCP server whose crash on the Nth call, or end with its input, is the behaviour the transport test drives",
  },
  "engine/test/mcp/fixtures/fake-mcp-server.mjs": {
    count: 4,
    reason: "a fake MCP server whose crash, timed death, usage refusal or end with its input is the behaviour the transport test drives",
  },
  "tests/fixtures/config-write-lock-holder.ts": {
    count: 8,
    reason: "a lock-holder fixture whose end while holding the config write lock (and whose usage statuses) the lock tests drive",
  },
  "tests/setup/concurrency-lock.ts": {
    count: 1,
    reason: "vitest's global setup ends the outer run with the inner, locked run's status: vitest offers no other stop before the suite",
  },
  "tests/performance/scale/stack.ts": {
    count: 3,
    reason: "the stack runner answers a signal with that signal's own status (128 + n) once its servers are stopped",
  },
};

function exitCallsIn(path: string): readonly number[] {
  return readSourceView(path).matches(EXIT_CALL, "code").map((match) => match.line);
}

test("ProcessEndsByDraining: no source ends a process by process.exit() but the declared last resorts", () => {
  const files = walk(REPOSITORY_ROOT, { exts: [".ts", ".mts", ".mjs", ".cjs", ".js", ".svelte"] })
    .map((path) => relative(REPOSITORY_ROOT, path).split(sep).join("/"))
    .filter((path) => !path.startsWith(PINNED_EVIDENCE));
  assert.ok(files.length > 1000 && files.includes("engine/test/prevention/process-ends-by-draining.test.ts"), `the walk reached the tree (liveness): ${String(files.length)} files`);

  const found = new Map<string, readonly number[]>();
  for (const path of files) {
    const lines = exitCallsIn(resolve(REPOSITORY_ROOT, path));
    if (lines.length > 0) found.set(path, lines);
  }
  const undeclared = [...found].filter(([path]) => DECLARED[path] === undefined).map(([path, lines]) => `${path}:${lines.join(",")}`);
  assert.deepEqual(undeclared, [], "set process.exitCode and let the loop drain (or declare a last resort here, with its reason)");
  const miscounted = Object.entries(DECLARED)
    .filter(([path, declared]) => (found.get(path)?.length ?? 0) !== declared.count)
    .map(([path, declared]) => `${path}: declared ${String(declared.count)}, found ${String(found.get(path)?.length ?? 0)}`);
  assert.deepEqual(miscounted, [], "every declaration matches its file (a stale or miscounted one is refused)");
});

test("ProcessEndsByDraining: the scan finds a planted call in code, never in a comment, a string or an exit code", () => {
  const count = (text: string): number => sourceViewOf(text, "planted.ts").matches(EXIT_CALL, "code").length;
  assert.equal(count("main().then(() => process.exit(0));\n"), 1, "a planted call is found");
  assert.equal(count("main().then(() => process.exit (0));\n"), 1, "with a space before the parenthesis too");
  assert.equal(count("// never process.exit(0) here\nprocess.exitCode = 0;\n"), 0, "a comment and an exit code are not calls");
  assert.equal(count("spawnSync(process.execPath, [\"-e\", \"process.exit(3)\"]);\n"), 0, "a child program in a string is the child's");
});
