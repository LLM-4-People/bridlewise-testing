/**
 * THE ONE BOUNDED RUN, FOR A SYNCHRONOUS CALLER.
 *
 * Some callers cannot wait for a promise. The git door's readers
 * (`src/git/tree-reader.ts`) are synchronous interfaces that synchronous code
 * uses throughout, and so are the commit guard's legs and the verification
 * scripts' steps. {@link runCpuBoundedSync} gives them the SAME run as
 * {@link runCpuBounded} (src/process/supervised-run.ts): the same group, the
 * same CPU budget, stall rule, output bound, kernel limit and hang backstop.
 * It is not a second runner. One worker thread per thread that asks runs
 * `runCpuBounded` itself. The asking thread posts the request on a private
 * port and blocks on a shared word with `Atomics.wait` until the worker
 * stores the answer and notifies. The answer is then read with
 * `receiveMessageOnPort`.
 *
 * The worker is started once, through the one worker spawn
 * (`bootstrappedWorker`, src/process/worker-bootstrap.ts), and unreferenced,
 * so an idle bridge never keeps its process alive. The two halves are one
 * protocol, so they are one module: the worker half is at the bottom.
 *
 * A blocked thread cannot see its worker's `error` or `exit` events. So the
 * wait has one backstop: the run's own bounds. A run ends, at the latest, at
 * its hang backstop plus the stop's grace periods. A worker that has not
 * answered by then is lost, and the bridge refuses with
 * `cpu_bounded_bridge_lost`. That is the hang backstop the bounds already
 * hold, never a new wall bound. It never answers a refusal for the command
 * itself: like `runCpuBounded`, it answers the ending, and the caller maps it.
 */
import { isMainThread, MessageChannel, receiveMessageOnPort, Worker, workerData, type MessagePort } from "node:worker_threads";

import { HarnessError } from "../kernel/errors.ts";
import { guarded } from "./fault-policy.ts";
import { assertSubprocessBounds, type SubprocessBounds } from "./subprocess-bounds.ts";
import { runCpuBounded, type CpuBoundedRun } from "./supervised-run.ts";
import { bootstrappedWorker } from "./worker-bootstrap.ts";

/** The `workerData` key of this module's worker half: its port and the shared word. */
const BRIDGE_KEY = "boundedRunBridge";

/** The shared word: 0 while a request is open, 1 once its answer is posted. */
const ANSWERED = 1;
const OPEN = 0;

type BridgeRequest = Readonly<{
  sequence: number;
  command: string;
  args: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string | undefined>>;
  input?: Uint8Array;
  bounds: SubprocessBounds;
}>;

type BridgeAnswer = Readonly<{ sequence: number; run?: CpuBoundedRun; error?: string }>;

type Bridge = Readonly<{ port: MessagePort; word: Int32Array }>;

let bridge: Bridge | undefined;
let sequence = 0;

/** The bridge of this thread: started on first use, unreferenced. */
function threadBridge(): Bridge {
  if (bridge !== undefined) return bridge;
  const { port1, port2 } = new MessageChannel();
  const word = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const worker = new Worker(...bootstrappedWorker(new URL(import.meta.url), "worker", {
    workerData: { [BRIDGE_KEY]: { port: port2, word } },
    transferList: [port2],
  }));
  worker.unref();
  port1.unref();
  bridge = { port: port1, word };
  return bridge;
}

/** A structured-clone copy of a Buffer arrives as a Uint8Array: the same bytes as a Buffer again. */
function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * {@link runCpuBounded}, answered synchronously: `command` bounded by its work
 * under `bounds`, as a process group, its output held in memory. It blocks
 * this thread until the run ends (see the header).
 */
export function runCpuBoundedSync(
  command: string,
  args: readonly string[],
  options: Readonly<{ cwd: string; env?: Readonly<Record<string, string | undefined>>; input?: Buffer; bounds: SubprocessBounds }>,
): CpuBoundedRun {
  assertSubprocessBounds(options.bounds);
  const { port, word } = threadBridge();
  sequence += 1;
  const request: BridgeRequest = {
    sequence,
    command,
    args: [...args],
    cwd: options.cwd,
    bounds: options.bounds,
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.input === undefined ? {} : { input: options.input }),
  };
  Atomics.store(word, 0, OPEN);
  port.postMessage(request);
  // The run ends by its hang backstop at the latest; its stop then waits out the grace twice (the group, then
  // a pipe held outside it). Past that, the worker is lost.
  const { hangBackstopMs, killGraceMs, pollMs } = options.bounds;
  const backstopMs = hangBackstopMs + 2 * killGraceMs + 2 * pollMs;
  if (Atomics.wait(word, 0, OPEN, backstopMs) === "timed-out") {
    throw new HarnessError(`the bounded run of ${command} did not answer within its own backstop (${String(backstopMs)} ms): its worker thread is lost`, "cpu_bounded_bridge_lost", true);
  }
  const received = receiveMessageOnPort(port) as { message: BridgeAnswer } | undefined;
  const answer = received?.message;
  if (answer?.sequence !== sequence) {
    throw new HarnessError(`the bounded run of ${command} answered out of turn (expected request ${String(sequence)}, got ${String(answer?.sequence)})`, "cpu_bounded_bridge_lost", true);
  }
  if (answer.error !== undefined || answer.run === undefined) {
    throw new HarnessError(`the bounded run of ${command} failed in its worker: ${answer.error ?? "no answer"}`, "cpu_bounded_bridge_failed");
  }
  const run = answer.run;
  return Object.freeze({ ...run, stdout: asBuffer(run.stdout), stderr: asBuffer(run.stderr) });
}

// ── The worker half: this module as a bridge worker's entry ───────────────
//
// Started by `threadBridge` with its port and the shared word under
// BRIDGE_KEY. Each request is one `runCpuBounded`; its answer is posted, then
// the word is set and the waiting thread notified. Imported anywhere else it
// does nothing.
const handed = isMainThread ? undefined : (workerData as Readonly<Record<string, unknown>> | null | undefined)?.[BRIDGE_KEY];
if (handed !== undefined) {
  const { port, word } = handed as Readonly<{ port: MessagePort; word: Int32Array }>;
  port.on("message", guarded("process.bounded-run-sync.request", (request: BridgeRequest) => {
    const answer = (value: BridgeAnswer): void => {
      port.postMessage(value);
      Atomics.store(word, 0, ANSWERED);
      Atomics.notify(word, 0);
    };
    runCpuBounded(request.command, request.args, {
      cwd: request.cwd,
      bounds: request.bounds,
      ...(request.env === undefined ? {} : { env: request.env }),
      ...(request.input === undefined ? {} : { input: asBuffer(request.input) }),
    }).then(
      guarded("process.bounded-run-sync.answer", (run: CpuBoundedRun) => answer({ sequence: request.sequence, run })),
      guarded("process.bounded-run-sync.failure", (error: unknown) => answer({ sequence: request.sequence, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) })),
    );
  }));
}
