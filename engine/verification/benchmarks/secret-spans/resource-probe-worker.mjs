import v8 from "node:v8";
import { isDeepStrictEqual } from "node:util";
import { parentPort, workerData } from "node:worker_threads";

if (!isDeepStrictEqual(process.execArgv, workerData?.qualificationRuntimeExecArgv)) {
  parentPort?.postMessage({ status: "failed", code: "exec-argv-mismatch" });
} else if (workerData?.mode === "report-limits") {
  parentPort?.postMessage({
    status: "ok",
    heapSizeLimit: v8.getHeapStatistics().heap_size_limit,
    execArgv: process.execArgv
  });
} else if (workerData?.mode === "hang") {
  for (;;) {
    Math.imul(17, 19);
  }
} else if (workerData?.mode === "stdout") {
  process.stdout.write(workerData.value);
  parentPort?.postMessage({ status: "ok" });
} else if (workerData?.mode === "stdout-split") {
  const split = Math.floor(workerData.value.length / 2);
  process.stdout.write(workerData.value.slice(0, split));
  setImmediate(() => {
    process.stdout.write(workerData.value.slice(split));
    parentPort?.postMessage({ status: "ok" });
  });
} else if (workerData?.mode === "stderr") {
  process.stderr.write(workerData.value);
  parentPort?.postMessage({ status: "ok" });
} else if (workerData?.mode === "message") {
  parentPort?.postMessage({ status: "ok", value: workerData.value });
} else if (workerData?.mode === "throw") {
  throw new Error(workerData.value);
} else if (workerData?.mode === "exit") {
  process.exitCode = 7;
} else {
  parentPort?.postMessage({ status: "failed" });
}
