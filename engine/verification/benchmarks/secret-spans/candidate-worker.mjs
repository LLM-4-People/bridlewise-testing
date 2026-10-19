import { parentPort, workerData } from "node:worker_threads";
import { isDeepStrictEqual } from "node:util";
import { SECRET_SPAN_CANDIDATES } from "./candidate-adapters.mjs";

function fail() {
  parentPort?.postMessage({ status: "failed", code: "candidate_worker_failure" });
}

try {
  const candidate = SECRET_SPAN_CANDIDATES.find((entry) => entry.id === workerData?.candidateId);
  if (!candidate || typeof workerData?.bytesBase64 !== "string" || !Array.isArray(workerData?.knownValues)) {
    fail();
  } else if (!isDeepStrictEqual(process.execArgv, workerData.qualificationRuntimeExecArgv)) {
    fail();
  } else {
    const bytes = Buffer.from(workerData.bytesBase64, "base64");
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const spans = candidate.detect({ bytes, text, knownValues: workerData.knownValues });
    parentPort?.postMessage({ status: "ok", spans, execArgv: process.execArgv });
  }
} catch {
  fail();
}
