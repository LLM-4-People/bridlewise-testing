import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createTempDir } from "../support/temp-dir.ts";

/**
 * THE WORKER BOOTSTRAP from a parent started on EVAL input
 * (`node --input-type=… -e …`, as tests and tools spawn short scripts): node
 * hands its options to a thread, and a FILE entry refuses `--input-type`, so
 * a bootstrapped thread used never to start — invisible to a parent that
 * blocks on it (the synchronous work-bounded door), which saw only silence.
 * Such a parent's thread starts on eval input importing the prelude: it
 * starts, its real entry runs, and the prelude's fault policy still holds it.
 */

const BOOTSTRAP = new URL("../../src/process/worker-bootstrap.ts", import.meta.url).href;

/** Runs `body` (an ES module) as a bootstrapped `worker` thread of a parent started with `parentOptions`; answers the parent's stdout and status. */
function fromEvalParent(parentOptions: readonly string[], body: string): Readonly<{ status: number | null; stdout: string; stderr: string }> {
  const entry = join(createTempDir("worker-bootstrap-eval-"), "entry.mjs");
  writeFileSync(entry, body);
  const script = `
    (async () => {
      const { Worker } = await import("node:worker_threads");
      const { bootstrappedWorker } = await import(${JSON.stringify(BOOTSTRAP)});
      const worker = new Worker(...bootstrappedWorker(${JSON.stringify(entry)}, "worker"));
      worker.on("message", (message) => process.stdout.write("MESSAGE " + message + "\\n"));
      worker.on("error", (error) => process.stdout.write("ERROR " + error.message + "\\n"));
      worker.on("exit", (code) => process.stdout.write("EXIT " + code + "\\n"));
    })();`;
  // No wall timeout of its own (the no-load rule): a thread that never answers is caught by the suite's one hang
  // backstop (no output and no CPU progress), never by a wall clock that host load can trip.
  const run = spawnSync(process.execPath, [...parentOptions, "-e", script], { encoding: "utf8" });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

const UP = `import { parentPort } from "node:worker_threads"; parentPort.postMessage("up");`;

/** The thread of a parent started with `parentOptions` starts and runs its entry. */
function startsAndRuns(parentOptions: readonly string[]): void {
  const run = fromEvalParent(parentOptions, UP);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^MESSAGE up$/mu, run.stdout);
  assert.doesNotMatch(run.stdout, /^ERROR/mu, "the thread refused to start");
  assert.match(run.stdout, /^EXIT 0$/mu);
}

test("a bootstrapped thread of a `node --input-type=module -e` parent starts and runs its entry", () => {
  startsAndRuns(["--input-type=module"]);
});

test("a bootstrapped thread of a `node --input-type commonjs -e` parent (the option's separate-value form) starts and runs its entry", () => {
  startsAndRuns(["--input-type", "commonjs"]);
});

test("the prelude still holds such a thread: a lost rejection in a `worker` fails the thread closed (exit 70)", () => {
  const run = fromEvalParent(["--input-type=module"], `import { setTimeout as sleep } from "node:timers/promises"; Promise.reject(new Error("thread lost it")); await sleep(50);`);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^EXIT 70$/mu, run.stdout);
});
