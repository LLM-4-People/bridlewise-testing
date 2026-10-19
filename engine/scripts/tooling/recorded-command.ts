import { execPath } from "node:process";

import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { superviseCommand, supervisedEndingLines, type SupervisedCommand } from "../../src/process/supervised-run.ts";

export type RecordedCommandRequest = Readonly<{
  arguments: readonly string[];
  cwd: string;
  environment?: Readonly<NodeJS.ProcessEnv>;
  setupFailureCode?: string;
  /** Aborting it asks the command to stop (SIGTERM); the observation still completes when it exits. */
  stop?: AbortSignal;
  /**
   * THE ONE test-run supervisor (`src/process/supervised-run.ts`): every
   * process the command starts — the test files and whatever THEY start,
   * detached ones included — is killed when it ends, is stopped, or reaches
   * `hardCeilingMs`; a stopped one has `killGraceMs` before the SIGKILL; its
   * fd 3 (the result pipe) is passed through.
   */
  supervision: Readonly<{ supervisor: string; hardCeilingMs: number; killGraceMs: number }>;
}>;

export type ObservedPipe = Readonly<{
  bytes: Buffer;
  complete: boolean;
  overflow: boolean;
}>;

export type RecordedCommandObservation = Readonly<{
  spawned: boolean;
  closeObserved: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnErrorCode: string | null;
  stdout: ObservedPipe;
  stderr: ObservedPipe;
  resultPipe: ObservedPipe;
  /** Actual supervision, absent for a command that never started. */
  terminal?: SupervisedCommand;
}>;

type MutablePipe = {
  chunks: Buffer[];
  byteLength: number;
  ended: boolean;
  overflow: boolean;
};

const MAXIMUM_BYTES = ROOT_POLICY.receipts.immutableExecution.maximumBytes;

/**
 * Runs `node <arguments>` under THE test-run supervisor
 * (`src/process/supervised-run.ts`) and observes it: its output, its fd-3
 * result pipe and how it ended. Nothing the command starts survives it.
 */
export function runRecordedCommand(request: RecordedCommandRequest): Promise<RecordedCommandObservation> {
  const stdout = mutablePipe();
  const stderr = mutablePipe();
  const resultPipe = mutablePipe();
  if (request.setupFailureCode !== undefined) {
    return Promise.resolve(observation(false, false, null, null, request.setupFailureCode, stdout, stderr, resultPipe));
  }
  return runSupervised(request, stdout, stderr, resultPipe).catch((error: unknown) =>
    observation(false, false, null, null, processErrorCode(error), stdout, stderr, resultPipe));
}

async function runSupervised(
  request: RecordedCommandRequest,
  stdout: MutablePipe,
  stderr: MutablePipe,
  resultPipe: MutablePipe,
): Promise<RecordedCommandObservation> {
  const supervision = request.supervision;
  const stop = new AbortController();
  const forward = (): void => stop.abort();
  if (request.stop?.aborted === true) forward();
  else request.stop?.addEventListener("abort", forward, { once: true });
  try {
    const run = await superviseCommand({
      supervisor: supervision.supervisor,
      command: execPath,
      args: request.arguments,
      hardCeilingMs: supervision.hardCeilingMs,
      killGraceMs: supervision.killGraceMs,
      cwd: request.cwd,
      ...(request.environment === undefined ? {} : { env: { ...request.environment } }),
      onStdout: (chunk) => collect(chunk, stdout, forward),
      onStderr: (chunk) => collect(chunk, stderr, forward),
      onResult: (chunk) => collect(chunk, resultPipe, forward),
      stop: stop.signal,
    });
    for (const line of supervisedEndingLines(run, supervision.hardCeilingMs)) process.stderr.write(`${line}\n`);
    for (const pipe of [stdout, stderr, resultPipe]) pipe.ended = run.outputComplete;
    if (run.ending === "unverified") {
      return { ...observation(true, true, null, null, "test_process_supervisor_unverified", stdout, stderr, resultPipe), terminal: run };
    }
    const status = run.status ?? 0;
    return { ...observation(true, true, status >= 0 ? status : null, run.signal, null, stdout, stderr, resultPipe), terminal: run };
  } finally {
    request.stop?.removeEventListener("abort", forward);
  }
}

/** One chunk into a bounded pipe; past the bound the pipe overflows and the command is stopped. */
function collect(chunk: Buffer, pipe: MutablePipe, stop: () => void): void {
  const remaining = Math.max(0, MAXIMUM_BYTES - pipe.byteLength);
  if (remaining > 0) {
    pipe.chunks.push(chunk.subarray(0, remaining));
    pipe.byteLength += Math.min(chunk.length, remaining);
  }
  if (chunk.length > remaining) {
    pipe.overflow = true;
    stop();
  }
}

function mutablePipe(): MutablePipe {
  return { chunks: [], byteLength: 0, ended: false, overflow: false };
}

function observation(
  spawned: boolean,
  closeObserved: boolean,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  spawnErrorCode: string | null,
  stdout: MutablePipe,
  stderr: MutablePipe,
  resultPipe: MutablePipe,
): RecordedCommandObservation {
  return Object.freeze({
    spawned,
    closeObserved,
    exitCode,
    signal,
    spawnErrorCode,
    stdout: freezePipe(stdout),
    stderr: freezePipe(stderr),
    resultPipe: freezePipe(resultPipe),
  });
}

function freezePipe(pipe: MutablePipe): ObservedPipe {
  return Object.freeze({
    bytes: Buffer.concat(pipe.chunks, pipe.byteLength),
    complete: pipe.ended && !pipe.overflow,
    overflow: pipe.overflow,
  });
}

function processErrorCode(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : "command_setup_failed";
}
