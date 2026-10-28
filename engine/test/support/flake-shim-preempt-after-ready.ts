/**
 * A REPRODUCTION SHIM for the engine runner (`harness flake reproduce
 * --preload engine/test/support/flake-shim-preempt-after-ready.ts`, the
 * FLAKE-REPRO decision). It recreates, on any machine and every run, a
 * scripted MCP child (test/mcp/transport.test.ts `spawnScriptedChild`)
 * preempted for 500 ms right after it writes its ready file — what a loaded
 * host does at random. A child that announced ready before installing its
 * SIGTERM handler is then killed by the polite close's SIGTERM (the default
 * action) and never flushes.
 *
 * Two roles, one module:
 * - in the TEST process (preloaded by the door), it hands itself to every
 *   child spawned with a ready path (`STDIO_READY_PATH`), through
 *   NODE_OPTIONS;
 * - in such a CHILD, the write of the ready file is followed by a 500 ms
 *   stall, before the child's next statement runs.
 *
 * Never imported by a test.
 */
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

const STALL_MS = 500;
const SELF = fileURLToPath(import.meta.url);
const readyPath = process.env.STDIO_READY_PATH;

if (readyPath !== undefined) {
  const write = fs.writeFileSync;
  fs.writeFileSync = ((path: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    const answer = Reflect.apply(write, fs, [path, ...rest]) as void;
    if (path === readyPath) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, STALL_MS);
    return answer;
  }) as typeof fs.writeFileSync;
} else {
  const spawn = childProcess.spawn;
  childProcess.spawn = ((command: string, args: readonly string[], options: childProcess.SpawnOptions = {}) => {
    const env = options.env;
    if (env?.["STDIO_READY_PATH"] === undefined) return Reflect.apply(spawn, childProcess, [command, args, options]) as childProcess.ChildProcess;
    return Reflect.apply(spawn, childProcess, [command, args, { ...options, env: { ...env, NODE_OPTIONS: `--import=${SELF}` } }]) as childProcess.ChildProcess;
  }) as typeof childProcess.spawn;
}
syncBuiltinESMExports();
