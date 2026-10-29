/**
 * THE ENGINE SUITE'S MEASURED PER-WORKER MEMORY.
 *
 * A MEASURING run (`npm test -- --measure-worker-memory`, the workflow_dispatch
 * job `engine-worker-memory.yml` on the hosted runner) runs the suite one
 * worker at a time, so it never approaches the run's cap, and each test
 * file's worker peak (its scope leaf's `memory.peak`, children included) is
 * its own. The worker writes the readings to a RECEIPT
 * ({@link WORKER_MEMORY_RECEIPT_PATH}), which the job uploads as an artifact.
 *
 * `measure` (this file's CLI, from a downloaded receipt) is the ONE writer of
 * the committed measurement, `traceability/worker-memory.json`: a generated
 * value, never hand-edited, naming the runner it was measured on. A partial
 * receipt (a file with no reading, a reading that is not a byte count) is
 * refused.
 *
 * The run reads it back through {@link declaredWorkerMemory}, like the web
 * suite's test weights: a test file with no reading yet is counted at the
 * MEDIAN reading and listed as unmeasured; a reading whose file left the
 * suite is ignored. When the unmeasured share of the suite passes
 * `testExecution.workerMemory.maxUnmeasuredShare`, the measurement is STALE
 * and a capped run is refused (`worker_memory_stale`): the suite changed too
 * much since it was measured.
 */
import { readFileSync } from "node:fs";
import { cpus, release, totalmem } from "node:os";
import { join, resolve } from "node:path";

import { atomicWriteFile } from "../../src/filesystem/atomic-write.ts";
import { InputError } from "../../src/kernel/errors.ts";
import { canonicalJson } from "../../src/kernel/integrity.ts";
import { parseJsonExact } from "../../src/kernel/json-integrity.ts";
import { isEntryPoint } from "../../src/runtime/cli-debug.ts";
import type { WorkerMemory } from "../../src/workflow/workflow-config.ts";

/** The run-tests and test-worker flag of a measuring run. */
export const MEASURE_WORKER_MEMORY_FLAG = "--measure-worker-memory";
/** Where a measuring run's worker writes its receipt (engine-relative), uploaded by the measuring job. */
export const WORKER_MEMORY_RECEIPT_PATH = ".bridlewise/state/test-results/worker-memory-receipt.json";
/** The committed, generated measurement (engine-relative): written only by `measure`. */
export const WORKER_MEMORY_PATH = "traceability/worker-memory.json";

const RECEIPT_SCHEMA = "bridlewise-worker-memory-receipt/v1";
const MEASUREMENT_SCHEMA = "bridlewise-worker-memory/v1";

type Runner = Readonly<{ totalMemoryBytes: number; cpus: number; kernel: string }>;
type Measurement = Readonly<{ schemaVersion: typeof MEASUREMENT_SCHEMA; measuredAt: string; runner: Runner; capBytes: number; files: Readonly<Record<string, number>> }>;

/** The authored half of the declaration (`testExecution.workerMemory`): the headroom every worker gets, and how much of the suite may be unmeasured before the measurement is stale. */
export type WorkerMemoryPolicy = Readonly<{ headroomFactor: number; maxUnmeasuredShare: number }>;

/** A measuring run's receipt: every file's worker peak, the run's cap and the runner, written by the worker. */
export function writeWorkerMemoryReceipt(root: string, peaks: readonly Readonly<{ file: string; peakBytes: number }>[], capBytes: number | undefined): string {
  if (capBytes === undefined) throw new InputError("a measuring run must run inside an admitted run's scope: it has no worker leaves to measure", "worker_memory_unmeasurable");
  const path = join(root, WORKER_MEMORY_RECEIPT_PATH);
  const receipt = {
    schemaVersion: RECEIPT_SCHEMA,
    measuredAt: new Date().toISOString(),
    runner: { totalMemoryBytes: totalmem(), cpus: cpus().length, kernel: release() },
    capBytes,
    files: Object.fromEntries(peaks.map((one) => [one.file, one.peakBytes])),
  };
  const written = atomicWriteFile(path, `${canonicalJson(receipt)}\n`);
  if (!written.success) throw new InputError(`the worker memory receipt could not be written at ${path}: ${written.reason ?? "unknown"}`, "worker_memory_receipt_unwritten");
  return path;
}

/** A positive integer byte count, or a refusal naming `what`. */
function byteCount(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new InputError(`${what} is not a positive byte count`, "worker_memory_malformed");
  return value;
}

/** A receipt or measurement document, parsed and checked field by field. */
function parseDocument(text: string, schema: string, where: string): Measurement {
  const parsed = parseJsonExact(text);
  const record = parsed?.value;
  if (typeof record !== "object" || record === null || Array.isArray(record)) throw new InputError(`${where} is not a JSON object`, "worker_memory_malformed");
  const { schemaVersion, measuredAt, runner, capBytes, files } = record as Record<string, unknown>;
  if (schemaVersion !== schema) throw new InputError(`${where} is not a ${schema} document`, "worker_memory_malformed");
  if (typeof measuredAt !== "string" || Number.isNaN(Date.parse(measuredAt))) throw new InputError(`${where} has no measuredAt instant`, "worker_memory_malformed");
  if (typeof runner !== "object" || runner === null) throw new InputError(`${where} names no runner`, "worker_memory_malformed");
  const { totalMemoryBytes, cpus: cpuCount, kernel } = runner as Record<string, unknown>;
  if (typeof kernel !== "string" || typeof cpuCount !== "number" || !Number.isSafeInteger(cpuCount) || cpuCount <= 0) throw new InputError(`${where}'s runner is malformed`, "worker_memory_malformed");
  if (typeof files !== "object" || files === null || Array.isArray(files) || Object.keys(files).length === 0) throw new InputError(`${where} carries no file reading`, "worker_memory_malformed");
  const readings = Object.fromEntries(Object.entries(files as Record<string, unknown>).map(([file, bytes]) => [file, byteCount(bytes, `${where}'s reading for ${file}`)]));
  return {
    schemaVersion: MEASUREMENT_SCHEMA, measuredAt,
    runner: { totalMemoryBytes: byteCount(totalMemoryBytes, `${where}'s runner memory`), cpus: cpuCount, kernel },
    capBytes: byteCount(capBytes, `${where}'s cap`),
    files: readings,
  };
}

/**
 * `measure`: the committed measurement from a measuring run's receipt,
 * refused unless every file of `suiteFiles` has a reading (a partial
 * measurement is no measurement).
 */
export function measureWorkerMemory(root: string, receiptPath: string, suiteFiles: readonly string[]): string {
  const receipt = parseDocument(readFileSync(receiptPath, "utf8"), RECEIPT_SCHEMA, "the worker memory receipt");
  const missing = [...new Set(suiteFiles)].filter((file) => receipt.files[file] === undefined).sort();
  if (missing.length > 0) throw new InputError(`the receipt is partial: ${String(missing.length)} test file(s) have no reading (${missing.slice(0, 8).join(", ")}${missing.length > 8 ? ", …" : ""})`, "worker_memory_partial");
  const files = Object.fromEntries(Object.entries(receipt.files).toSorted(([left], [right]) => (left < right ? -1 : 1)));
  const path = join(root, WORKER_MEMORY_PATH);
  const written = atomicWriteFile(path, `${canonicalJson({ ...receipt, files })}\n`);
  if (!written.success) throw new InputError(`the worker memory measurement could not be written at ${path}: ${written.reason ?? "unknown"}`, "worker_memory_unwritten");
  return path;
}

/**
 * THE DECLARED PER-WORKER PEAK for the suite's files: the largest reading,
 * the file that reached it, the authored headroom. `undefined` when nothing
 * is measured yet (a capped run is then refused `worker_memory_undeclared`).
 * A file with no reading counts at the median and is listed; past the
 * policy's unmeasured share the measurement is stale (`worker_memory_stale`).
 */
export function declaredWorkerMemory(root: string, suiteFiles: readonly string[], policy: WorkerMemoryPolicy | undefined): WorkerMemory | undefined {
  let text: string;
  try {
    text = readFileSync(join(root, WORKER_MEMORY_PATH), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (policy === undefined) throw new InputError(`${WORKER_MEMORY_PATH} is measured, but testExecution.workerMemory declares no headroom or unmeasured share`, "worker_memory_policy_undeclared");
  const measurement = parseDocument(text, MEASUREMENT_SCHEMA, WORKER_MEMORY_PATH);
  return workerMemoryOf(measurement.files, [...new Set(suiteFiles)], policy, (unmeasured) => {
    process.stderr.write(`[worker-memory] ${String(unmeasured.length)} test file(s) have no measured peak yet and count at the median: ${unmeasured.join(", ")}\n`);
  });
}

/** The pure derivation behind {@link declaredWorkerMemory}: readings and the suite's files in, the declared peak out. */
export function workerMemoryOf(
  readings: Readonly<Record<string, number>>,
  suiteFiles: readonly string[],
  policy: WorkerMemoryPolicy,
  onUnmeasured: (files: readonly string[]) => void,
): WorkerMemory {
  const measured = suiteFiles.filter((file) => readings[file] !== undefined);
  if (measured.length === 0) throw new InputError(`no test file of the suite has a measured peak in ${WORKER_MEMORY_PATH}: measure again`, "worker_memory_stale");
  const unmeasured = suiteFiles.filter((file) => readings[file] === undefined).sort();
  if (unmeasured.length / suiteFiles.length > policy.maxUnmeasuredShare) {
    throw new InputError(
      `the worker memory measurement is stale: ${String(unmeasured.length)} of ${String(suiteFiles.length)} test files have no measured peak, ` +
        `past the declared share (${String(policy.maxUnmeasuredShare)}); dispatch the measuring job and commit its measurement`,
      "worker_memory_stale",
    );
  }
  if (unmeasured.length > 0) onUnmeasured(unmeasured);
  const sorted = measured.map((file) => readings[file]!).toSorted((left, right) => left - right);
  const median = sorted[Math.floor((sorted.length - 1) / 2)]!;
  const largest = measured.reduce((best, file) => (readings[file]! > readings[best]! ? file : best), measured[0]!);
  return { measuredPeakBytes: Math.max(readings[largest]!, median), measuredFile: largest, headroomFactor: policy.headroomFactor };
}

if (isEntryPoint(import.meta.url)) {
  const [verb, receipt] = process.argv.slice(2);
  if (verb !== "measure" || receipt === undefined) {
    process.stderr.write("Usage: node scripts/tooling/worker-memory.ts measure <worker-memory-receipt.json>\n");
    process.exitCode = 1;
  } else {
    const root = resolve(import.meta.dirname, "..", "..");
    const { loadTestInventoryWithSnapshot } = await import("../test-inventory.ts");
    const files = loadTestInventoryWithSnapshot(root).inventory.tests.map((entry) => entry.sourceId);
    process.stdout.write(`${measureWorkerMemory(root, resolve(receipt), files)}\n`);
  }
}
