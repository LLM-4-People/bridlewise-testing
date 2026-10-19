import { isDeepStrictEqual } from "node:util";
import { Worker } from "node:worker_threads";

export class WorkerExecutionError extends Error {
  constructor(code) {
    super(code);
    this.name = "WorkerExecutionError";
    this.code = code;
  }
}

function governedRuntime(runtimeProfile) {
  if (!runtimeProfile || !Array.isArray(runtimeProfile.mainExecArgv) ||
    !Array.isArray(runtimeProfile.workerExecArgv) ||
    runtimeProfile.mainExecArgv.some((entry) => typeof entry !== "string") ||
    runtimeProfile.workerExecArgv.some((entry) => typeof entry !== "string")) {
    throw new WorkerExecutionError("candidate_runtime_profile_invalid");
  }
  if (!isDeepStrictEqual(process.execArgv, runtimeProfile.mainExecArgv)) {
    throw new WorkerExecutionError("candidate_main_exec_argv_mismatch");
  }
  return Object.freeze({
    mainExecArgv: Object.freeze([...runtimeProfile.mainExecArgv]),
    workerExecArgv: Object.freeze([...runtimeProfile.workerExecArgv])
  });
}

function forbiddenByteNeedles(values) {
  if (!Array.isArray(values) || values.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new WorkerExecutionError("candidate_forbidden_needles_invalid");
  }
  return Object.freeze(values.map((entry) => Buffer.from(entry, "utf8")));
}

function bytesContainNeedle(bytes, needles) {
  return needles.some((needle) => bytes.indexOf(needle) >= 0);
}

function surfaceContainsNeedle(value, needles, seen = new Set()) {
  if (typeof value === "string") return bytesContainNeedle(Buffer.from(value, "utf8"), needles);
  if (Buffer.isBuffer(value)) return bytesContainNeedle(value, needles);
  if (ArrayBuffer.isView(value)) {
    return bytesContainNeedle(Buffer.from(value.buffer, value.byteOffset, value.byteLength), needles);
  }
  if (value instanceof ArrayBuffer) return bytesContainNeedle(Buffer.from(value), needles);
  if (value === null || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (value instanceof Map) {
    return [...value].some(([key, entry]) =>
      surfaceContainsNeedle(key, needles, seen) || surfaceContainsNeedle(entry, needles, seen));
  }
  if (value instanceof Set) return [...value].some((entry) => surfaceContainsNeedle(entry, needles, seen));
  return Reflect.ownKeys(value).some((key) =>
    surfaceContainsNeedle(String(key), needles, seen) || surfaceContainsNeedle(value[key], needles, seen));
}

function streamCollector(maximumBytes, needles, onViolation) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new WorkerExecutionError("candidate_stream_budget_invalid");
  }
  const maximumNeedleBytes = needles.reduce((maximum, needle) => Math.max(maximum, needle.length), 0);
  let observedBytes = 0;
  let tail = Buffer.alloc(0);
  return Object.freeze({
    data(chunk) {
      const bytes = Buffer.from(chunk);
      observedBytes += bytes.length;
      const searchable = tail.length === 0 ? bytes : Buffer.concat([tail, bytes]);
      if (bytesContainNeedle(searchable, needles)) onViolation("candidate_forbidden_surface");
      const retained = Math.max(0, maximumNeedleBytes - 1);
      tail = retained === 0 ? Buffer.alloc(0) : searchable.subarray(Math.max(0, searchable.length - retained));
      if (observedBytes > maximumBytes) onViolation("candidate_stream_byte_limit");
    }
  });
}

export function executeIsolatedWorker({
  workerUrl,
  workerData,
  budgets,
  runtimeProfile,
  forbiddenNeedles = [],
  signal
}) {
  if (signal?.aborted) return Promise.reject(new WorkerExecutionError("candidate_cancelled"));
  let runtime;
  let needles;
  try {
    runtime = governedRuntime(runtimeProfile);
    needles = forbiddenByteNeedles(forbiddenNeedles);
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let terminationCode = null;
    let workerError = null;
    let exitCode = null;
    let exited = false;
    let stdoutEnded = false;
    let stderrEnded = false;
    const messages = [];
    let worker;

    const finish = (operation) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      operation();
    };
    const terminate = (code) => {
      if (terminationCode === null) terminationCode = code;
      if (worker !== undefined) void worker.terminate();
    };
    const maybeFinish = () => {
      if (!exited || !stdoutEnded || !stderrEnded || settled) return;
      if (workerError !== null && surfaceContainsNeedle(workerError, needles)) {
        finish(() => reject(new WorkerExecutionError("candidate_forbidden_surface")));
      } else if (messages.some((message) => surfaceContainsNeedle(message, needles))) {
        finish(() => reject(new WorkerExecutionError("candidate_forbidden_surface")));
      } else if (terminationCode !== null) {
        finish(() => reject(new WorkerExecutionError(terminationCode)));
      } else if (workerError !== null) {
        const code = workerError?.code === "ERR_WORKER_OUT_OF_MEMORY" ?
          "candidate_memory_limit" : "candidate_worker_error";
        finish(() => reject(new WorkerExecutionError(code)));
      } else if (exitCode !== 0) {
        finish(() => reject(new WorkerExecutionError("candidate_worker_exit")));
      } else if (messages.length !== 1) {
        finish(() => reject(new WorkerExecutionError("candidate_worker_protocol")));
      } else {
        finish(() => resolve(messages[0]));
      }
    };
    const timer = setTimeout(() => terminate("candidate_timeout"), budgets.maximumDetectionMilliseconds);
    const onAbort = () => terminate("candidate_cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      if (workerData === null || typeof workerData !== "object" ||
        Object.hasOwn(workerData, "qualificationRuntimeExecArgv")) {
        throw new WorkerExecutionError("candidate_worker_data_invalid");
      }
      worker = new Worker(workerUrl, {
        workerData: {
          ...workerData,
          qualificationRuntimeExecArgv: runtime.workerExecArgv
        },
        execArgv: runtime.workerExecArgv,
        stdout: true,
        stderr: true,
        resourceLimits: {
          maxOldGenerationSizeMb: budgets.workerHeapMegabytes,
          maxYoungGenerationSizeMb: Math.max(4, Math.floor(budgets.workerHeapMegabytes / 4)),
          stackSizeMb: budgets.workerStackMegabytes
        }
      });
      const stdout = streamCollector(budgets.maximumWorkerStdoutBytes, needles, terminate);
      const stderr = streamCollector(budgets.maximumWorkerStderrBytes, needles, terminate);
      worker.stdout.on("data", (chunk) => stdout.data(chunk));
      worker.stderr.on("data", (chunk) => stderr.data(chunk));
      worker.stdout.once("error", (error) => terminate(
        surfaceContainsNeedle(error, needles) ? "candidate_forbidden_surface" : "candidate_stream_error"
      ));
      worker.stderr.once("error", (error) => terminate(
        surfaceContainsNeedle(error, needles) ? "candidate_forbidden_surface" : "candidate_stream_error"
      ));
      worker.stdout.once("end", () => { stdoutEnded = true; maybeFinish(); });
      worker.stderr.once("end", () => { stderrEnded = true; maybeFinish(); });
      worker.on("message", (message) => {
        messages.push(message);
        if (messages.length > 1) terminate("candidate_worker_protocol");
      });
      worker.once("error", (error) => { workerError = error; });
      worker.once("exit", (code) => {
        exitCode = code;
        exited = true;
        maybeFinish();
      });
    } catch (error) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const code = surfaceContainsNeedle(error, needles) ? "candidate_forbidden_surface" :
        error instanceof WorkerExecutionError ? error.code : "candidate_worker_setup";
      finish(() => reject(new WorkerExecutionError(code)));
    }
  });
}

export async function executeCandidate({
  candidateId,
  bytes,
  knownValues,
  budgets,
  runtimeProfile,
  forbiddenNeedles,
  signal
}) {
  if (bytes.length > budgets.maximumFixtureBytes) throw new WorkerExecutionError("candidate_input_byte_limit");
  const message = await executeIsolatedWorker({
    workerUrl: new URL("./candidate-worker.mjs", import.meta.url),
    workerData: {
      candidateId,
      bytesBase64: Buffer.from(bytes).toString("base64"),
      knownValues
    },
    budgets,
    runtimeProfile,
    forbiddenNeedles,
    signal
  });
  if (message?.status !== "ok" || !Array.isArray(message.spans) ||
    !isDeepStrictEqual(message.execArgv, runtimeProfile.workerExecArgv)) {
    throw new WorkerExecutionError("candidate_worker_protocol");
  }
  if (message.spans.length > budgets.maximumProposedSpansPerFixture) {
    throw new WorkerExecutionError("candidate_match_limit");
  }
  return Object.freeze(message.spans);
}
