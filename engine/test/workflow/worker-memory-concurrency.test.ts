/**
 * THE SUITE'S WORKER COUNT UNDER ITS MEMORY CAP derives from the cap and the
 * measured per-worker peak (workflow-config.ts `memoryBoundedConcurrency`),
 * never from a hard-coded number: `floor(cap / (peak x headroom))` workers at
 * once at most, the configured CPU-tuned counts within that. A capped run
 * with no measured peak is refused, and a test file whose peak alone passes
 * the cap is a finding for that test, never a raised cap.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { memoryBoundedConcurrency } from "../../src/workflow/workflow-config.ts";
import { measureWorkerMemory, workerMemoryOf } from "../../scripts/tooling/worker-memory.ts";
import { createTempDir } from "../support/temp-dir.ts";

const GIB = 1024 ** 3;
const CONFIGURED = { parallel: 12, inProcessSerial: 4, subprocessSerial: 8 };

test("under a cap, the worker count is floor(cap / (measured peak x headroom)); within it, the configured counts", () => {
  // A hosted runner: 16 GiB, the run capped at half; a worker peaking at 1 GiB with 2x headroom: 4 fit.
  const memory = { measuredPeakBytes: GIB, measuredFile: "test/x.test.ts", headroomFactor: 2 };
  assert.deepEqual(memoryBoundedConcurrency(CONFIGURED, 8 * GIB, memory), { parallel: 4, inProcessSerial: 1, subprocessSerial: 3, serialTiersTogether: true });
  // A larger host fits the configured counts whole.
  assert.deepEqual(memoryBoundedConcurrency(CONFIGURED, 64 * GIB, memory), { parallel: 12, inProcessSerial: 4, subprocessSerial: 8, serialTiersTogether: true });
  // A smaller measured peak fits more workers on the same cap.
  assert.deepEqual(memoryBoundedConcurrency(CONFIGURED, 8 * GIB, { ...memory, measuredPeakBytes: GIB / 2 }), { parallel: 8, inProcessSerial: 2, subprocessSerial: 6, serialTiersTogether: true });
  // When one worker of each serial tier does not fit at once, the tiers run one after the other.
  assert.deepEqual(memoryBoundedConcurrency(CONFIGURED, 3 * GIB, { ...memory, measuredPeakBytes: 1.5 * GIB }), { parallel: 1, inProcessSerial: 1, subprocessSerial: 1, serialTiersTogether: false });
});

test("a run with no cap of its own keeps the configured counts; a capped run with no measured peak is refused, never guessed", () => {
  assert.deepEqual(memoryBoundedConcurrency(CONFIGURED, undefined, undefined), { ...CONFIGURED, serialTiersTogether: true });
  assert.throws(() => memoryBoundedConcurrency(CONFIGURED, 8 * GIB, undefined), (error: unknown) => (error as { code?: unknown }).code === "worker_memory_undeclared");
});

test("a test file whose measured peak with its headroom passes the whole cap is a finding naming that file, never a raised cap", () => {
  assert.throws(
    () => memoryBoundedConcurrency(CONFIGURED, 8 * GIB, { measuredPeakBytes: 5 * GIB, measuredFile: "test/heavy.test.ts", headroomFactor: 2 }),
    (error: unknown) => (error as { code?: unknown }).code === "worker_memory_over_share" && (error as Error).message.startsWith("test/heavy.test.ts alone peaks at "),
  );
});

test("the suite's run planning derives its counts through that one owner, from the admitted run's own cap and the declared measurement", () => {
  const planning = readFileSync(join(import.meta.dirname, "..", "..", "scripts", "tooling", "inventory-test-run.ts"), "utf8");
  assert.equal(planning.includes("      : memoryBoundedConcurrency("), true);
  assert.equal(planning.includes("options.measuredWorkerMemory,"), true);
  assert.equal(planning.includes("      options.memoryCapBytes,"), true);
  const worker = readFileSync(join(import.meta.dirname, "..", "..", "scripts", "tooling", "test-worker.ts"), "utf8");
  assert.equal(worker.includes("{ memoryCapBytes: runScopeMemory()!.maxBytes }"), true, "the composition root hands the run its admitted scope's cap");
  assert.equal(planning.includes("const parallelConcurrency = bounded.parallel;"), true);
});

test("the declared peak is the largest measured reading over the suite's files; an unmeasured file counts at the median and is listed; a reading whose file left is ignored", () => {
  const policy = { headroomFactor: 1.5, maxUnmeasuredShare: 0.25 };
  const listed: string[][] = [];
  const declared = workerMemoryOf({ "test/a.test.ts": 100, "test/b.test.ts": 300, "test/c.test.ts": 200, "test/gone.test.ts": 9_000 }, ["test/a.test.ts", "test/b.test.ts", "test/c.test.ts", "test/new.test.ts"], policy, (files) => listed.push([...files]));
  assert.deepEqual(declared, { measuredPeakBytes: 300, measuredFile: "test/b.test.ts", headroomFactor: 1.5 });
  assert.deepEqual(listed, [["test/new.test.ts"]]);
});

test("past the declared unmeasured share the measurement is STALE and refused; a receipt missing a suite file is a partial measurement, refused", () => {
  const policy = { headroomFactor: 1.5, maxUnmeasuredShare: 0.25 };
  assert.throws(
    () => workerMemoryOf({ "test/a.test.ts": 100 }, ["test/a.test.ts", "test/new-1.test.ts", "test/new-2.test.ts"], policy, () => undefined),
    (error: unknown) => (error as { code?: unknown }).code === "worker_memory_stale" && (error as Error).message.includes("2 of 3 test files have no measured peak"),
  );
  const root = createTempDir("worker-memory-measure-");
  mkdirSync(join(root, "traceability"), { recursive: true });
  const receipt = join(root, "receipt.json");
  writeFileSync(receipt, JSON.stringify({ schemaVersion: "bridlewise-worker-memory-receipt/v1", measuredAt: "2026-10-29T00:00:00.000Z", runner: { totalMemoryBytes: 17_000_000_000, cpus: 4, kernel: "6.8.0" }, capBytes: 8_500_000_000, files: { "test/a.test.ts": 100 } }));
  assert.throws(() => measureWorkerMemory(root, receipt, ["test/a.test.ts", "test/b.test.ts"]), (error: unknown) => (error as { code?: unknown }).code === "worker_memory_partial");
  const written = measureWorkerMemory(root, receipt, ["test/a.test.ts"]);
  const measurement = JSON.parse(readFileSync(written, "utf8")) as { schemaVersion: string; runner: { cpus: number }; files: Record<string, number> };
  assert.equal(measurement.schemaVersion, "bridlewise-worker-memory/v1");
  assert.equal(measurement.runner.cpus, 4, "the measurement names the runner it was measured on");
  assert.deepEqual(measurement.files, { "test/a.test.ts": 100 });
});
