import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import test from "node:test";

import { bootstrappedWorker } from "../../src/process/worker-bootstrap.ts";
import { createTempDir } from "../support/temp-dir.ts";

/**
 * THE WORKER BOOTSTRAP from a parent started on EVAL input
 * (`node --input-type=… -e …`, as tests and tools spawn short scripts): node
 * hands its options to a thread, and a FILE entry refuses `--input-type`, so
 * a bootstrapped thread used never to start — invisible to a parent that
 * blocks on it (the synchronous work-bounded door), which saw only silence.
 * Such a parent's thread starts on eval input importing the prelude: it
 * starts, its real entry runs, and the prelude's fault policy still holds it.
 * A thread starts only on a DECLARED entry (the fixtures here are declared).
 */

const BOOTSTRAP = new URL("../../src/process/worker-bootstrap.ts", import.meta.url).href;

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "worker-entries");

/** Runs the declared fixture entry `name` as a bootstrapped `worker` thread of a parent started with `parentOptions`; answers the parent's stdout and status. */
function fromEvalParent(parentOptions: readonly string[], name: string): Readonly<{ status: number | null; stdout: string; stderr: string }> {
  const entry = join(FIXTURES, name);
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


/** The thread of a parent started with `parentOptions` starts and runs its entry. */
function startsAndRuns(parentOptions: readonly string[]): void {
  const run = fromEvalParent(parentOptions, "up.mjs");
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
  const run = fromEvalParent(["--input-type=module"], "lost-rejection.mjs");
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^EXIT 70$/mu, run.stdout);
});

test("a thread starts only on a DECLARED entry: an undeclared one is refused before it starts, and the prelude refuses a boot record that names one", async () => {
  const undeclared = join(createTempDir("worker-bootstrap-undeclared-"), "entry.mjs");
  writeFileSync(undeclared, `import { parentPort } from "node:worker_threads"; parentPort.postMessage("ran");`);
  assert.throws(() => bootstrappedWorker(undeclared, "worker"), (error: unknown) => (error as { code?: string }).code === "worker_entry_undeclared");
  assert.throws(() => bootstrappedWorker(new URL("https://example.invalid/entry.mjs"), "worker"), (error: unknown) => (error as { code?: string }).code === "worker_entry_undeclared");
  // A boot record handed a declared entry, then pointed elsewhere: the prelude refuses it, and the entry never runs.
  const [prelude, options] = bootstrappedWorker(join(FIXTURES, "up.mjs"), "worker");
  const data = options.workerData as Record<string, Record<string, unknown>>;
  const tampered = Object.fromEntries(Object.entries(data).map(([key, value]) => [key, { ...value, entry: new URL(`file://${undeclared}`).href }]));
  const seen = await new Promise<string>((resolve) => {
    const worker = new Worker(prelude, { ...options, workerData: tampered });
    worker.once("message", (message) => resolve(`message ${String(message)}`));
    worker.once("error", (error) => resolve(`error ${error.message}`));
  });
  assert.match(seen, /^error a worker thread may start only on a declared entry/u, seen);
});
