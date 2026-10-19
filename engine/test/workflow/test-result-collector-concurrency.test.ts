import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  createTestResultCollector,
  collectTestResults,
  writeTestResultCollection,
  parseTestResultCollection,
  parseConcurrencyReport,
  classifyTestConcurrency,
  SHARED_RESOURCE_MARKERS,
  resolveDefaultParallelConcurrency,
  MAXIMUM_PARALLEL_CONCURRENCY,
  MINIMUM_PARALLEL_CONCURRENCY,
  TEST_RESULT_COLLECTION_SCHEMA_VERSION,
  type ConcurrencyReport,
  type ConcurrencyMarker,
} from "../../src/workflow/test-result-collector.ts";
import { canonicalJson, sha256 } from "../../src/kernel/integrity.ts";
import { createTempDir } from "../support/temp-dir.ts";

function makeEvent(type: string, data: Record<string, unknown> = {}): { type: string; data: Record<string, unknown> } {
  return { type, data };
}

function makePassEvent(name: string, file: string, durationMs = 10): { type: string; data: Record<string, unknown> } {
  return makeEvent("test:pass", { name, file, details: { duration_ms: durationMs }, line: 1, column: 1 });
}

function makeFailEvent(name: string, file: string, error: unknown, durationMs = 20): { type: string; data: Record<string, unknown> } {
  return makeEvent("test:fail", { name, file, details: { duration_ms: durationMs, error }, line: 5, column: 3 });
}

function makeSummaryEvent(success: boolean, durationMs = 1000): { type: string; data: Record<string, unknown> } {
  return makeEvent("test:summary", { success, details: { duration_ms: durationMs } });
}

function makePerFileSummaryEvent(file: string, success: boolean, durationMs = 50): { type: string; data: Record<string, unknown> } {
  return makeEvent("test:summary", { file, success, details: { duration_ms: durationMs } });
}

const PASSING_TEST_SOURCE = `import test from "node:test";\ntest("pass", () => {});\n`;
const SERIAL_MARKER_SOURCE = `import test from "node:test";\n// uses runWorkerWithEvidence\ntest("serial", () => {});\n`;

function makeTempDir(prefix: string): string {
  return createTempDir(`trc-conc-${prefix}-`);
}

function writeTestFile(dir: string, name: string, source: string): string {
  const abs = join(dir, name);
  mkdirSync(resolve(abs, ".."), { recursive: true });
  writeFileSync(abs, source, "utf8");
  return abs;
}

function makeReport(overrides: Partial<ConcurrencyReport> = {}): ConcurrencyReport {
  return {
    mode: "auto",
    parallel: ["test/a.test.ts"],
    serial: ["test/b.test.ts"],
    serialReasons: { "test/b.test.ts": ["evidence-worker"] },
    parallelConcurrency: 2,
    ...overrides,
  } as ConcurrencyReport;
}

test("classifyTestConcurrency: empty files array produces empty classification", () => {
  const result = classifyTestConcurrency([], "/root");
  assert.deepEqual([...result.parallel], []);
  assert.deepEqual([...result.serial], []);
  assert.deepEqual(result.serialReasons, {});
});

test("classifyTestConcurrency: file with no markers goes to parallel", () => {
  const dir = makeTempDir("no-marker");
  try {
    writeTestFile(dir, "a.test.ts", PASSING_TEST_SOURCE);
    const result = classifyTestConcurrency(["a.test.ts"], dir);
    assert.deepEqual([...result.parallel], ["a.test.ts"]);
    assert.deepEqual([...result.serial], []);
    assert.deepEqual(result.serialReasons, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifyTestConcurrency: absolute path is resolved relative to root", () => {
  const dir = makeTempDir("abs");
  try {
    const abs = writeTestFile(dir, "a.test.ts", PASSING_TEST_SOURCE);
    const result = classifyTestConcurrency([abs], dir);
    assert.deepEqual([...result.parallel], ["a.test.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifyTestConcurrency: evidence-worker marker classifies as serial", () => {
  const dir = makeTempDir("ev-worker");
  try {
    writeTestFile(dir, "a.test.ts", `// runWorkerWithEvidence\ntest("x", () => {});`);
    const result = classifyTestConcurrency(["a.test.ts"], dir);
    assert.deepEqual([...result.serial], ["a.test.ts"]);
    assert.deepEqual(result.serialReasons["a.test.ts"], ["evidence-worker"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifyTestConcurrency: runTestsWithEvidence marker classifies as serial", () => {
  const dir = makeTempDir("rts");
  try {
    writeTestFile(dir, "a.test.ts", `// runTestsWithEvidence`);
    const result = classifyTestConcurrency(["a.test.ts"], dir);
    assert.deepEqual([...result.serial], ["a.test.ts"]);
    assert.deepEqual(result.serialReasons["a.test.ts"], ["evidence-worker"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifyTestConcurrency: runCheckWithEvidence marker classifies as serial", () => {
  const dir = makeTempDir("rcw");
  try {
    writeTestFile(dir, "a.test.ts", `// runCheckWithEvidence`);
    const result = classifyTestConcurrency(["a.test.ts"], dir);
    assert.deepEqual(result.serialReasons["a.test.ts"], ["evidence-worker"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifyTestConcurrency: runPlannedNodeTestSuiteWithEvidence marker classifies as serial", () => {
  const dir = makeTempDir("rpntsw");
  try {
    writeTestFile(dir, "a.test.ts", `// runPlannedNodeTestSuiteWithEvidence`);
    const result = classifyTestConcurrency(["a.test.ts"], dir);
    assert.deepEqual(result.serialReasons["a.test.ts"], ["evidence-worker"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifyTestConcurrency: TEST_EXECUTION_OPERATION marker classifies as serial", () => {
  const dir = makeTempDir("teo");
  try {
    writeTestFile(dir, "a.test.ts", `// TEST_EXECUTION_OPERATION`);
    const result = classifyTestConcurrency(["a.test.ts"], dir);
    assert.deepEqual(result.serialReasons["a.test.ts"], ["execution-operation"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifyTestConcurrency: CHECK_EXECUTION_OPERATION marker classifies as serial", () => {
  const dir = makeTempDir("ceo");
  try {
    writeTestFile(dir, "a.test.ts", `// CHECK_EXECUTION_OPERATION`);
    const result = classifyTestConcurrency(["a.test.ts"], dir);
    assert.deepEqual(result.serialReasons["a.test.ts"], ["execution-operation"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifyTestConcurrency: planned-node-test-evidence marker classifies as serial", () => {
  const dir = makeTempDir("pnte");
  try {
    writeTestFile(dir, "a.test.ts", `// import from "./planned-node-test-evidence.ts"`);
    const result = classifyTestConcurrency(["a.test.ts"], dir);
    assert.deepEqual(result.serialReasons["a.test.ts"], ["evidence-session-import"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifyTestConcurrency: scripts/run-tests marker classifies as serial", () => {
  const dir = makeTempDir("srr");
  try {
    writeTestFile(dir, "a.test.ts", `// from "../scripts/tooling/run-tests.ts"`);
    const result = classifyTestConcurrency(["a.test.ts"], dir);
    assert.deepEqual(result.serialReasons["a.test.ts"], ["test-runner-import"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifyTestConcurrency: multiple markers produce multiple reasons", () => {
  const dir = makeTempDir("multi");
  try {
    writeTestFile(dir, "a.test.ts", `// runWorkerWithEvidence and TEST_EXECUTION_OPERATION and planned-node-test-evidence`);
    const result = classifyTestConcurrency(["a.test.ts"], dir);
    assert.deepEqual([...result.serial], ["a.test.ts"]);
    assert.deepEqual(result.serialReasons["a.test.ts"], ["evidence-worker", "execution-operation", "evidence-session-import"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifyTestConcurrency: unreadable file classifies as serial with unreadable-source reason", () => {
  const result = classifyTestConcurrency(["does-not-exist.test.ts"], "/root");
  assert.deepEqual([...result.serial], ["does-not-exist.test.ts"]);
  assert.deepEqual(result.serialReasons["does-not-exist.test.ts"], ["unreadable-source"]);
});

test("classifyTestConcurrency: results are sorted", () => {
  const dir = makeTempDir("sorted");
  try {
    writeTestFile(dir, "c.test.ts", PASSING_TEST_SOURCE);
    writeTestFile(dir, "a.test.ts", PASSING_TEST_SOURCE);
    writeTestFile(dir, "b.test.ts", PASSING_TEST_SOURCE);
    const result = classifyTestConcurrency(["c.test.ts", "a.test.ts", "b.test.ts"], dir);
    assert.deepEqual([...result.parallel], ["a.test.ts", "b.test.ts", "c.test.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifyTestConcurrency: mixed parallel and serial files are partitioned", () => {
  const dir = makeTempDir("mixed");
  try {
    writeTestFile(dir, "indep1.test.ts", PASSING_TEST_SOURCE);
    writeTestFile(dir, "indep2.test.ts", PASSING_TEST_SOURCE);
    writeTestFile(dir, "serial1.test.ts", `// runWorkerWithEvidence`);
    const result = classifyTestConcurrency(["indep1.test.ts", "serial1.test.ts", "indep2.test.ts"], dir);
    assert.deepEqual([...result.parallel], ["indep1.test.ts", "indep2.test.ts"]);
    assert.deepEqual([...result.serial], ["serial1.test.ts"]);
    assert.deepEqual(result.serialReasons, { "serial1.test.ts": ["evidence-worker"] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifyTestConcurrency: result is frozen", () => {
  const dir = makeTempDir("frozen");
  try {
    writeTestFile(dir, "a.test.ts", PASSING_TEST_SOURCE);
    const result = classifyTestConcurrency(["a.test.ts"], dir);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.parallel));
    assert.ok(Object.isFrozen(result.serial));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifyTestConcurrency: serialReasons entries are frozen arrays", () => {
  const dir = makeTempDir("srfrozen");
  try {
    writeTestFile(dir, "a.test.ts", `// runWorkerWithEvidence`);
    const result = classifyTestConcurrency(["a.test.ts"], dir);
    assert.ok(Object.isFrozen(result.serialReasons["a.test.ts"]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifyTestConcurrency: throws on non-array files", () => {
  assert.throws(() => classifyTestConcurrency("not-an-array" as unknown as string[], "/root"), /files must be an array/);
});

test("classifyTestConcurrency: throws on empty string file path", () => {
  assert.throws(() => classifyTestConcurrency([""], "/root"), /file path must be a non-empty string/);
});

test("classifyTestConcurrency: throws on non-string file path", () => {
  assert.throws(() => classifyTestConcurrency([42 as unknown as string], "/root"), /file path must be a non-empty string/);
});

test("classifyTestConcurrency: custom markers override defaults", () => {
  const dir = makeTempDir("custom");
  try {
    writeTestFile(dir, "a.test.ts", `// special-token-here`);
    writeTestFile(dir, "b.test.ts", PASSING_TEST_SOURCE);
    const customMarkers: readonly ConcurrencyMarker[] = [{ id: "custom", pattern: /special-token-here/u }];
    const result = classifyTestConcurrency(["a.test.ts", "b.test.ts"], dir, customMarkers);
    assert.deepEqual([...result.serial], ["a.test.ts"]);
    assert.deepEqual([...result.parallel], ["b.test.ts"]);
    assert.deepEqual(result.serialReasons["a.test.ts"], ["custom"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifyTestConcurrency: empty custom markers make all files parallel", () => {
  const dir = makeTempDir("empty-markers");
  try {
    writeTestFile(dir, "a.test.ts", `// runWorkerWithEvidence`);
    const result = classifyTestConcurrency(["a.test.ts"], dir, []);
    assert.deepEqual([...result.parallel], ["a.test.ts"]);
    assert.deepEqual([...result.serial], []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifyTestConcurrency: every shared-resource marker is well-formed and EARNS ITS PLACE on a real test file", () => {
  // This asserted a count and a literal list of ids, which meant adding a
  // marker — the one thing this list exists to allow — broke a test that had
  // nothing to say about the new marker. A count is also the weakest possible
  // check: it cannot tell a live marker from one whose pattern stopped
  // matching anything, which is the failure that matters, because a marker
  // matching nothing silently returns its files to the parallel phase.
  //
  // So: shape, uniqueness, and LIVENESS PER MARKER against the real tree. A
  // marker that classifies no file in this repository is either a pattern that
  // has rotted or a hazard that no longer exists, and both should be deleted
  // rather than left looking like enforcement.
  assert.ok(SHARED_RESOURCE_MARKERS.length > 0, "the marker list is empty — every file would run parallel");
  const ids = SHARED_RESOURCE_MARKERS.map((marker) => marker.id);
  assert.deepEqual([...new Set(ids)], ids, "marker ids must be unique");
  for (const marker of SHARED_RESOURCE_MARKERS) {
    assert.ok(marker.id.length > 0, "a marker must have an id");
    assert.ok(marker.pattern instanceof RegExp, `${marker.id} must carry a RegExp`);
  }
  const root = process.cwd();
  const inventory = JSON.parse(readFileSync(join(root, "traceability", "s1-test-inventory.json"), "utf8")) as {
    tests: readonly { sourceId: string }[];
  };
  const sources = [...new Set(inventory.tests.map((entry) => entry.sourceId))].toSorted();
  assert.ok(sources.length > 100, `only ${sources.length} test sources found — the liveness check would be vacuous`);
  const classified = classifyTestConcurrency(sources, root);
  const fired = new Set(Object.values(classified.serialReasons).flat());
  const dead = ids.filter((id) => !fired.has(id));
  assert.deepEqual(
    dead,
    [],
    `shared-resource markers that classify no test file in this repository. A marker that matches ` +
    `nothing returns its files to the parallel phase while reading like a guard: ${dead.join(", ")}`,
  );
});

test("classifyTestConcurrency: SHARED_RESOURCE_MARKERS is frozen", () => {
  assert.ok(Object.isFrozen(SHARED_RESOURCE_MARKERS));
});

test("classifyTestConcurrency: real immutable-receipt.test.ts is serial", () => {
  const root = process.cwd();
  const result = classifyTestConcurrency(["test/immutable-receipt.test.ts"], root);
  assert.deepEqual([...result.serial], ["test/immutable-receipt.test.ts"]);
  assert.ok(result.serialReasons["test/immutable-receipt.test.ts"]!.length > 0);
});

test("classifyTestConcurrency: real foundation-cascade.test.ts is serial", () => {
  const root = process.cwd();
  const result = classifyTestConcurrency(["test/foundation-cascade.test.ts"], root);
  assert.deepEqual([...result.serial], ["test/foundation-cascade.test.ts"]);
  assert.ok(result.serialReasons["test/foundation-cascade.test.ts"]!.includes("evidence-session-import"));
});

test("classifyTestConcurrency: real repository-path.test.ts is serial", () => {
  const root = process.cwd();
  const result = classifyTestConcurrency(["test/repository-path.test.ts"], root);
  assert.deepEqual([...result.serial], ["test/repository-path.test.ts"]);
});

test("classifyTestConcurrency: real handoff-continuity.test.ts is serial", () => {
  const root = process.cwd();
  const result = classifyTestConcurrency(["test/unit/tasks-agents/handoff-continuity.test.ts"], root);
  assert.deepEqual([...result.serial], ["test/unit/tasks-agents/handoff-continuity.test.ts"]);
});

test("classifyTestConcurrency: real s1-scenarios family files are serial", () => {
  const root = process.cwd();
  const files = readdirSync(join(root, "test", "s1-scenarios"))
    .filter((entry) => entry.endsWith(".test.ts"))
    .toSorted()
    .map((entry) => `test/s1-scenarios/${entry}`);
  assert.ok(files.length > 0);
  const result = classifyTestConcurrency(files, root);
  // S1 scenario files call verifyS1Structure / makeRuntimeCandidate which walk
  // the entire repo and copy it — CPU/IO heavy operations that must run serial
  // (no parallel contention). Files without these calls stay parallel.
  //
  // The reason a file is serial is checked against WHAT THE FILE CONTAINS
  // rather than against one expected marker. Asserting "every serial s1 file
  // is serial because of s1-verification-root" was true until a file bound a
  // preflight context without walking the repository — b05 — and then the
  // test failed while the classifier was right. A guard that names one
  // acceptable reason breaks whenever a second real reason appears.
  let serialCount = 0;
  for (const file of files) {
    const isSerial = result.serial.includes(file);
    const isParallel = result.parallel.includes(file);
    assert.ok(isSerial || isParallel, `${file} must be classified`);
    assert.ok(!(isSerial && isParallel), `${file} must not be in both phases`);
    if (!isSerial) continue;
    serialCount += 1;
    const reasons = result.serialReasons[file]!;
    assert.ok(reasons.length > 0, `${file} is serial with no stated reason`);
    const source = readFileSync(join(root, file), "utf8");
    for (const reason of reasons) {
      const marker = SHARED_RESOURCE_MARKERS.find((entry) => entry.id === reason);
      assert.ok(marker !== undefined, `${file} cites an unknown marker: ${reason}`);
      assert.ok(marker.pattern.test(source),
        `${file} is serial for ${reason}, but that marker's pattern does not match its source`);
    }
  }
  assert.ok(serialCount > 0, "no s1-scenario file was classified serial — the loop above proved nothing");
});

test("classifyTestConcurrency: real concurrency.test.ts is parallel", () => {
  const root = process.cwd();
  const result = classifyTestConcurrency(["test/concurrency.test.ts"], root);
  assert.deepEqual([...result.parallel], ["test/concurrency.test.ts"]);
});

test("classifyTestConcurrency: real resource-lock.test.ts is parallel", () => {
  const root = process.cwd();
  const result = classifyTestConcurrency(["test/workflow/resource-lock.test.ts"], root);
  assert.deepEqual([...result.parallel], ["test/workflow/resource-lock.test.ts"]);
});

test("classifyTestConcurrency: determinism - same input produces same output", () => {
  const dir = makeTempDir("det");
  try {
    writeTestFile(dir, "a.test.ts", `// runWorkerWithEvidence`);
    const r1 = classifyTestConcurrency(["a.test.ts"], dir);
    const r2 = classifyTestConcurrency(["a.test.ts"], dir);
    assert.deepEqual({ ...r1 }, { ...r2 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveDefaultParallelConcurrency: clamps host availableParallelism to [2, 8]", () => {
  const resolved = resolveDefaultParallelConcurrency();
  assert.ok(Number.isSafeInteger(resolved));
  assert.ok(resolved >= MINIMUM_PARALLEL_CONCURRENCY);
  assert.ok(resolved <= MAXIMUM_PARALLEL_CONCURRENCY);
  assert.equal(resolved, Math.min(MAXIMUM_PARALLEL_CONCURRENCY, Math.max(MINIMUM_PARALLEL_CONCURRENCY, availableParallelism())));
});

test("ConcurrencyReport: complete without report yields null concurrencyReport", () => {
  const collector = createTestResultCollector();
  collector.observe(makePassEvent("t1", "/root/test/a.test.ts"));
  const collection = collector.complete("/root");
  assert.equal(collection.concurrencyReport, null);
});

test("ConcurrencyReport: complete with report includes it", () => {
  const collector = createTestResultCollector();
  collector.observe(makePassEvent("t1", "/root/test/a.test.ts"));
  const report = makeReport();
  const collection = collector.complete("/root", report);
  assert.ok(collection.concurrencyReport !== null);
  assert.equal(collection.concurrencyReport!.mode, "auto");
  assert.deepEqual([...collection.concurrencyReport!.parallel], ["test/a.test.ts"]);
});

test("ConcurrencyReport: integrity hash covers the report", () => {
  const collector = createTestResultCollector();
  collector.observe(makePassEvent("t1", "/root/test/a.test.ts"));
  const without = collector.complete("/root");
  const withReport = collector.complete("/root", makeReport());
  assert.notEqual(without.integrityHash, withReport.integrityHash);
});

test("ConcurrencyReport: complete with null report yields null", () => {
  const collector = createTestResultCollector();
  collector.observe(makePassEvent("t1", "/root/test/a.test.ts"));
  const collection = collector.complete("/root", null);
  assert.equal(collection.concurrencyReport, null);
});

test("ConcurrencyReport: report is frozen in collection", () => {
  const collector = createTestResultCollector();
  collector.observe(makePassEvent("t1", "/root/test/a.test.ts"));
  const collection = collector.complete("/root", makeReport());
  assert.ok(Object.isFrozen(collection.concurrencyReport));
});

test("MultiSummary: zero summaries uses accumulated duration and failure-based status", () => {
  const collector = createTestResultCollector();
  collector.observe(makePassEvent("t1", "/root/test/a.test.ts", 100));
  collector.observe(makePassEvent("t2", "/root/test/a.test.ts", 200));
  const collection = collector.complete("/root");
  assert.equal(collection.summary.durationMs, 300);
  assert.equal(collection.status, "passed");
});

test("MultiSummary: one summary success=true with no failures is passed", () => {
  const collector = createTestResultCollector();
  collector.observe(makePassEvent("t1", "/root/test/a.test.ts"));
  collector.observe(makeSummaryEvent(true, 500));
  const collection = collector.complete("/root");
  assert.equal(collection.status, "passed");
  assert.equal(collection.summary.durationMs, 500);
});

test("MultiSummary: one summary success=false is failed", () => {
  const collector = createTestResultCollector();
  collector.observe(makeFailEvent("t1", "/root/test/a.test.ts", new Error("e")));
  collector.observe(makeSummaryEvent(false, 500));
  const collection = collector.complete("/root");
  assert.equal(collection.status, "failed");
});

test("MultiSummary: one summary success=true but failures exist is failed", () => {
  const collector = createTestResultCollector();
  collector.observe(makeFailEvent("t1", "/root/test/a.test.ts", new Error("e")));
  collector.observe(makeSummaryEvent(true, 500));
  const collection = collector.complete("/root");
  assert.equal(collection.status, "failed");
});

test("MultiSummary: two summaries both success=true with no failures is passed", () => {
  const collector = createTestResultCollector();
  collector.observe(makePassEvent("t1", "/root/test/a.test.ts"));
  collector.observe(makeSummaryEvent(true, 300));
  collector.observe(makePassEvent("t2", "/root/test/b.test.ts"));
  collector.observe(makeSummaryEvent(true, 400));
  const collection = collector.complete("/root");
  assert.equal(collection.status, "passed");
  assert.equal(collection.summary.durationMs, 700);
});

test("MultiSummary: two summaries second success=false is failed", () => {
  const collector = createTestResultCollector();
  collector.observe(makeSummaryEvent(true, 300));
  collector.observe(makeSummaryEvent(false, 400));
  const collection = collector.complete("/root");
  assert.equal(collection.status, "failed");
  assert.equal(collection.summary.durationMs, 700);
});

test("MultiSummary: two summaries first success=false is failed", () => {
  const collector = createTestResultCollector();
  collector.observe(makeSummaryEvent(false, 300));
  collector.observe(makeSummaryEvent(true, 400));
  const collection = collector.complete("/root");
  assert.equal(collection.status, "failed");
});

test("MultiSummary: summary duration sums across multiple summaries", () => {
  const collector = createTestResultCollector();
  collector.observe(makeSummaryEvent(true, 100));
  collector.observe(makeSummaryEvent(true, 250));
  collector.observe(makeSummaryEvent(true, 50));
  const collection = collector.complete("/root");
  assert.equal(collection.summary.durationMs, 400);
});

test("MultiSummary: per-file summary events are ignored for duration", () => {
  const collector = createTestResultCollector();
  collector.observe(makePassEvent("t1", "/root/test/a.test.ts", 42));
  collector.observe(makePerFileSummaryEvent("/root/test/a.test.ts", true, 999));
  collector.observe(makeSummaryEvent(true, 100));
  const collection = collector.complete("/root");
  assert.equal(collection.summary.durationMs, 100);
});

test("MultiSummary: zero summaries with a failure is failed", () => {
  const collector = createTestResultCollector();
  collector.observe(makeFailEvent("t1", "/root/test/a.test.ts", new Error("e")));
  const collection = collector.complete("/root");
  assert.equal(collection.status, "failed");
});

test("MultiSummary: zero summaries with only passes is passed", () => {
  const collector = createTestResultCollector();
  collector.observe(makePassEvent("t1", "/root/test/a.test.ts"));
  const collection = collector.complete("/root");
  assert.equal(collection.status, "passed");
});

test("MultiSummary: three summaries all success=true is passed", () => {
  const collector = createTestResultCollector();
  for (let i = 0; i < 3; i++) collector.observe(makeSummaryEvent(true, 100));
  const collection = collector.complete("/root");
  assert.equal(collection.status, "passed");
  assert.equal(collection.summary.durationMs, 300);
});

test("MultiSummary: summary without duration_ms falls back to accumulated", () => {
  const collector = createTestResultCollector();
  collector.observe(makePassEvent("t1", "/root/test/a.test.ts", 80));
  collector.observe(makeEvent("test:summary", { success: true }));
  const collection = collector.complete("/root");
  assert.equal(collection.summary.durationMs, 80);
});

test("MultiSummary: summary with zero duration sums to zero then falls back", () => {
  const collector = createTestResultCollector();
  collector.observe(makePassEvent("t1", "/root/test/a.test.ts", 80));
  collector.observe(makeSummaryEvent(true, 0));
  const collection = collector.complete("/root");
  assert.equal(collection.summary.durationMs, 80);
});

test("parseConcurrencyReport: null returns null", () => {
  assert.equal(parseConcurrencyReport(null), null);
});

test("parseConcurrencyReport: undefined returns null", () => {
  assert.equal(parseConcurrencyReport(undefined), null);
});

test("parseConcurrencyReport: valid report parses", () => {
  const report = makeReport();
  const parsed = parseConcurrencyReport(JSON.parse(canonicalJson(report)));
  assert.equal(parsed!.mode, "auto");
  assert.deepEqual([...parsed!.parallel], ["test/a.test.ts"]);
  assert.deepEqual([...parsed!.serial], ["test/b.test.ts"]);
  assert.equal(parsed!.parallelConcurrency, 2);
});

test("parseConcurrencyReport: parsed report is frozen", () => {
  const parsed = parseConcurrencyReport(JSON.parse(canonicalJson(makeReport())));
  assert.ok(Object.isFrozen(parsed));
});

test("parseConcurrencyReport: invalid mode throws", () => {
  assert.throws(() => parseConcurrencyReport({ mode: "serial" }), /mode must be/);
});

test("parseConcurrencyReport: non-array parallel throws", () => {
  assert.throws(() => parseConcurrencyReport({ mode: "auto", parallel: "x", serial: [], parallelConcurrency: 1 }), /parallel and serial must be arrays/);
});

test("parseConcurrencyReport: non-array serial throws", () => {
  assert.throws(() => parseConcurrencyReport({ mode: "auto", parallel: [], serial: 1, parallelConcurrency: 1 }), /parallel and serial must be arrays/);
});

test("parseConcurrencyReport: non-number parallelConcurrency throws", () => {
  assert.throws(() => parseConcurrencyReport({ mode: "auto", parallel: [], serial: [], parallelConcurrency: "x" }), /parallelConcurrency must be/);
});

test("parseConcurrencyReport: zero parallelConcurrency throws", () => {
  assert.throws(() => parseConcurrencyReport({ mode: "auto", parallel: [], serial: [], parallelConcurrency: 0 }), /parallelConcurrency must be/);
});

test("parseConcurrencyReport: negative parallelConcurrency throws", () => {
  assert.throws(() => parseConcurrencyReport({ mode: "auto", parallel: [], serial: [], parallelConcurrency: -1 }), /parallelConcurrency must be/);
});

test("parseConcurrencyReport: NaN parallelConcurrency throws", () => {
  assert.throws(() => parseConcurrencyReport({ mode: "auto", parallel: [], serial: [], parallelConcurrency: NaN }), /parallelConcurrency must be/);
});

test("parseConcurrencyReport: non-string parallel entry throws", () => {
  assert.throws(() => parseConcurrencyReport({ mode: "auto", parallel: [1], serial: [], parallelConcurrency: 1 }), /parallel entries must be strings/);
});

test("parseConcurrencyReport: non-string serial entry throws", () => {
  assert.throws(() => parseConcurrencyReport({ mode: "auto", parallel: [], serial: [2], parallelConcurrency: 1 }), /serial entries must be strings/);
});

test("parseConcurrencyReport: non-object serialReasons throws", () => {
  assert.throws(() => parseConcurrencyReport({ mode: "auto", parallel: [], serial: [], parallelConcurrency: 1, serialReasons: "x" }), /serialReasons must be an object/);
});

test("parseConcurrencyReport: non-array serialReasons value throws", () => {
  assert.throws(() => parseConcurrencyReport({ mode: "auto", parallel: [], serial: [], parallelConcurrency: 1, serialReasons: { "a.test.ts": "x" } }), /serialReasons entries must be string to string array/);
});

test("parseConcurrencyReport: non-string serialReasons reason throws", () => {
  assert.throws(() => parseConcurrencyReport({ mode: "auto", parallel: [], serial: [], parallelConcurrency: 1, serialReasons: { "a.test.ts": [1] } }), /serial reasons must be strings/);
});

test("parseConcurrencyReport: null serialReasons is accepted", () => {
  const parsed = parseConcurrencyReport({ mode: "auto", parallel: [], serial: [], parallelConcurrency: 1, serialReasons: null });
  assert.equal(parsed!.serialReasons, null);
});

test("parseConcurrencyReport: non-object value throws", () => {
  assert.throws(() => parseConcurrencyReport("string"), /must be an object or null/);
  assert.throws(() => parseConcurrencyReport(42), /must be an object or null/);
});

test("parseTestResultCollection: collection with concurrencyReport parses", () => {
  const collector = createTestResultCollector();
  collector.observe(makePassEvent("t1", "/root/test/a.test.ts"));
  const collection = collector.complete("/root", makeReport());
  const parsed = parseTestResultCollection(JSON.parse(canonicalJson(collection)));
  assert.equal(parsed.concurrencyReport!.mode, "auto");
});

test("parseTestResultCollection: collection with null report parses", () => {
  const collector = createTestResultCollector();
  collector.observe(makePassEvent("t1", "/root/test/a.test.ts"));
  const collection = collector.complete("/root");
  const parsed = parseTestResultCollection(JSON.parse(canonicalJson(collection)));
  assert.equal(parsed.concurrencyReport, null);
});

test("writeTestResultCollection: collection with report is written and readable", () => {
  const dir = makeTempDir("write-report");
  try {
    const collector = createTestResultCollector();
    collector.observe(makePassEvent("t1", "/root/test/a.test.ts"));
    const collection = collector.complete("/root", makeReport());
    const path = writeTestResultCollection(collection, dir, "r.json");
    const content = readFileSync(path, "utf8");
    const parsed = JSON.parse(content);
    assert.equal(parsed.concurrencyReport.mode, "auto");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectTestResults: auto mode with only independent files runs all in parallel", async () => {
  const dir = makeTempDir("auto-indep");
  try {
    mkdirSync(join(dir, "test"), { recursive: true });
    writeTestFile(dir, "test/a.test.ts", PASSING_TEST_SOURCE);
    writeTestFile(dir, "test/b.test.ts", PASSING_TEST_SOURCE);
    const collection = await collectTestResults(dir, { concurrency: "auto", parallelConcurrency: 2 });
    assert.equal(collection.status, "passed");
    assert.ok(collection.concurrencyReport !== null);
    assert.deepEqual([...collection.concurrencyReport!.parallel].sort(), ["test/a.test.ts", "test/b.test.ts"]);
    assert.deepEqual([...collection.concurrencyReport!.serial], []);
    assert.equal(collection.concurrencyReport!.parallelConcurrency, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectTestResults: auto mode with only serial files runs all serially", async () => {
  const dir = makeTempDir("auto-serial");
  try {
    mkdirSync(join(dir, "test"), { recursive: true });
    writeTestFile(dir, "test/a.test.ts", SERIAL_MARKER_SOURCE);
    writeTestFile(dir, "test/b.test.ts", SERIAL_MARKER_SOURCE);
    const collection = await collectTestResults(dir, { concurrency: "auto", parallelConcurrency: 2 });
    assert.equal(collection.status, "passed");
    assert.deepEqual([...collection.concurrencyReport!.serial].sort(), ["test/a.test.ts", "test/b.test.ts"]);
    assert.deepEqual([...collection.concurrencyReport!.parallel], []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectTestResults: auto mode with mixed files partitions and runs both phases", async () => {
  const dir = makeTempDir("auto-mixed");
  try {
    mkdirSync(join(dir, "test"), { recursive: true });
    writeTestFile(dir, "test/indep.test.ts", PASSING_TEST_SOURCE);
    writeTestFile(dir, "test/serial.test.ts", SERIAL_MARKER_SOURCE);
    const collection = await collectTestResults(dir, { concurrency: "auto", parallelConcurrency: 1 });
    assert.equal(collection.status, "passed");
    assert.deepEqual([...collection.concurrencyReport!.parallel], ["test/indep.test.ts"]);
    assert.deepEqual([...collection.concurrencyReport!.serial], ["test/serial.test.ts"]);
    assert.deepEqual(collection.concurrencyReport!.serialReasons["test/serial.test.ts"], ["evidence-worker"]);
    assert.equal(collection.concurrencyReport!.parallelConcurrency, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectTestResults: auto mode uses default parallelConcurrency when omitted", async () => {
  const dir = makeTempDir("auto-default");
  try {
    mkdirSync(join(dir, "test"), { recursive: true });
    writeTestFile(dir, "test/a.test.ts", PASSING_TEST_SOURCE);
    const collection = await collectTestResults(dir, { concurrency: "auto" });
    assert.equal(collection.concurrencyReport!.parallelConcurrency, resolveDefaultParallelConcurrency());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectTestResults: auto mode with empty test dir produces empty passing collection", async () => {
  const dir = makeTempDir("auto-empty");
  try {
    const collection = await collectTestResults(dir, { concurrency: "auto" });
    assert.equal(collection.summary.total, 0);
    assert.ok(collection.concurrencyReport !== null);
    assert.deepEqual([...collection.concurrencyReport!.parallel], []);
    assert.deepEqual([...collection.concurrencyReport!.serial], []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectTestResults: auto mode classifies failing independent file as parallel", async () => {
  const dir = makeTempDir("auto-fail-par");
  try {
    mkdirSync(join(dir, "test"), { recursive: true });
    writeTestFile(dir, "test/a.test.ts", `import test from "node:test";\nimport assert from "node:assert/strict";\ntest("fail", () => { assert.equal(1, 2); });\n`);
    const collection = await collectTestResults(dir, { concurrency: "auto", parallelConcurrency: 1 });
    assert.deepEqual([...collection.concurrencyReport!.parallel], ["test/a.test.ts"]);
    assert.deepEqual([...collection.concurrencyReport!.serial], []);
    assert.ok(collection.status === "passed" || collection.status === "failed");
    const { integrityHash, ...unsigned } = collection;
    assert.equal(sha256(canonicalJson(unsigned)), integrityHash);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectTestResults: auto mode classifies failing serial-marker file as serial", async () => {
  const dir = makeTempDir("auto-fail-ser");
  try {
    mkdirSync(join(dir, "test"), { recursive: true });
    writeTestFile(dir, "test/a.test.ts", `import test from "node:test";\nimport assert from "node:assert/strict";\n// runWorkerWithEvidence\ntest("fail", () => { assert.equal(1, 2); });\n`);
    const collection = await collectTestResults(dir, { concurrency: "auto", parallelConcurrency: 1 });
    assert.deepEqual([...collection.concurrencyReport!.serial], ["test/a.test.ts"]);
    assert.deepEqual(collection.concurrencyReport!.serialReasons["test/a.test.ts"], ["evidence-worker"]);
    assert.ok(collection.status === "passed" || collection.status === "failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectTestResults: auto mode partitions mixed files into both phases", async () => {
  const dir = makeTempDir("auto-merge");
  try {
    mkdirSync(join(dir, "test"), { recursive: true });
    writeTestFile(dir, "test/indep.test.ts", `import test from "node:test";\ntest("indep-pass", () => {});\n`);
    writeTestFile(dir, "test/serial.test.ts", `import test from "node:test";\n// runWorkerWithEvidence\ntest("serial-pass", () => {});\n`);
    const collection = await collectTestResults(dir, { concurrency: "auto", parallelConcurrency: 1 });
    assert.deepEqual([...collection.concurrencyReport!.parallel], ["test/indep.test.ts"]);
    assert.deepEqual([...collection.concurrencyReport!.serial], ["test/serial.test.ts"]);
    assert.equal(collection.concurrencyReport!.parallelConcurrency, 1);
    const { integrityHash, ...unsigned } = collection;
    assert.equal(sha256(canonicalJson(unsigned)), integrityHash);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectTestResults: in-process serial mode (concurrency false) detects failures (structure)", async () => {
  const dir = makeTempDir("inproc-fail");
  try {
    mkdirSync(join(dir, "test"), { recursive: true });
    writeTestFile(dir, "test/ok.test.ts", PASSING_TEST_SOURCE);
    writeTestFile(dir, "test/bad.test.ts", `import test from "node:test";\nimport assert from "node:assert/strict";\ntest("fail", () => { assert.equal(1, 2); });\n`);
    const collection = await collectTestResults(dir, { files: ["test/bad.test.ts"], concurrency: false });
    assert.equal(collection.concurrencyReport, null);
    assert.ok(collection.status === "passed" || collection.status === "failed");
    assert.equal(collection.tests.some((t) => t.status === "fail"), collection.status === "failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectTestResults: in-process serial mode (concurrency false) is well-formed for passing tests", async () => {
  const dir = makeTempDir("inproc-pass");
  try {
    mkdirSync(join(dir, "test"), { recursive: true });
    writeTestFile(dir, "test/ok.test.ts", PASSING_TEST_SOURCE);
    const collection = await collectTestResults(dir, { files: ["test/ok.test.ts"], concurrency: false });
    assert.ok(collection.status === "passed" || collection.status === "failed");
    const { integrityHash, ...unsigned } = collection;
    assert.equal(sha256(canonicalJson(unsigned)), integrityHash);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectTestResults: auto mode integrity hash is valid", async () => {
  const dir = makeTempDir("auto-hash");
  try {
    mkdirSync(join(dir, "test"), { recursive: true });
    writeTestFile(dir, "test/a.test.ts", PASSING_TEST_SOURCE);
    const collection = await collectTestResults(dir, { concurrency: "auto", parallelConcurrency: 1 });
    const { integrityHash, ...unsigned } = collection;
    assert.equal(sha256(canonicalJson(unsigned)), integrityHash);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectTestResults: serial mode (concurrency false) has null report and valid status", async () => {
  const dir = makeTempDir("serial-mode");
  try {
    mkdirSync(join(dir, "test"), { recursive: true });
    writeTestFile(dir, "test/a.test.ts", PASSING_TEST_SOURCE);
    const collection = await collectTestResults(dir, { concurrency: false });
    assert.equal(collection.concurrencyReport, null);
    assert.ok(collection.status === "passed" || collection.status === "failed");
    const { integrityHash, ...unsigned } = collection;
    assert.equal(sha256(canonicalJson(unsigned)), integrityHash);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectTestResults: numeric concurrency has null report", async () => {
  const dir = makeTempDir("num-mode");
  try {
    mkdirSync(join(dir, "test"), { recursive: true });
    writeTestFile(dir, "test/a.test.ts", PASSING_TEST_SOURCE);
    writeTestFile(dir, "test/b.test.ts", PASSING_TEST_SOURCE);
    const collection = await collectTestResults(dir, { concurrency: 2 });
    assert.equal(collection.concurrencyReport, null);
    assert.equal(collection.status, "passed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectTestResults: true concurrency has null report", async () => {
  const dir = makeTempDir("true-mode");
  try {
    mkdirSync(join(dir, "test"), { recursive: true });
    writeTestFile(dir, "test/a.test.ts", PASSING_TEST_SOURCE);
    const collection = await collectTestResults(dir, { concurrency: true });
    assert.equal(collection.concurrencyReport, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectTestResults: default concurrency (omitted) is serial with null report", async () => {
  const dir = makeTempDir("default-mode");
  try {
    mkdirSync(join(dir, "test"), { recursive: true });
    writeTestFile(dir, "test/a.test.ts", PASSING_TEST_SOURCE);
    const collection = await collectTestResults(dir, {});
    assert.equal(collection.concurrencyReport, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectTestResults: throws on invalid parallelConcurrency (zero)", async () => {
  const dir = makeTempDir("bad-pc");
  try {
    mkdirSync(join(dir, "test"), { recursive: true });
    writeTestFile(dir, "test/a.test.ts", PASSING_TEST_SOURCE);
    await assert.rejects(() => collectTestResults(dir, { concurrency: "auto", parallelConcurrency: 0 }), /parallelConcurrency must be/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectTestResults: throws on invalid parallelConcurrency (negative)", async () => {
  const dir = makeTempDir("bad-pc-neg");
  try {
    mkdirSync(join(dir, "test"), { recursive: true });
    writeTestFile(dir, "test/a.test.ts", PASSING_TEST_SOURCE);
    await assert.rejects(() => collectTestResults(dir, { concurrency: "auto", parallelConcurrency: -5 }), /parallelConcurrency must be/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectTestResults: throws on NaN parallelConcurrency", async () => {
  const dir = makeTempDir("bad-pc-nan");
  try {
    mkdirSync(join(dir, "test"), { recursive: true });
    writeTestFile(dir, "test/a.test.ts", PASSING_TEST_SOURCE);
    await assert.rejects(() => collectTestResults(dir, { concurrency: "auto", parallelConcurrency: NaN }), /parallelConcurrency must be/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectTestResults: auto mode explicit files list classifies and runs", async () => {
  const dir = makeTempDir("auto-files");
  try {
    mkdirSync(join(dir, "test"), { recursive: true });
    writeTestFile(dir, "test/a.test.ts", PASSING_TEST_SOURCE);
    writeTestFile(dir, "test/b.test.ts", SERIAL_MARKER_SOURCE);
    const collection = await collectTestResults(dir, { files: ["test/a.test.ts", "test/b.test.ts"], concurrency: "auto", parallelConcurrency: 1 });
    assert.equal(collection.status, "passed");
    assert.deepEqual([...collection.concurrencyReport!.parallel], ["test/a.test.ts"]);
    assert.deepEqual([...collection.concurrencyReport!.serial], ["test/b.test.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectTestResults: schema version tracks the collection shape (slowestFiles added in v2)", () => {
  assert.equal(TEST_RESULT_COLLECTION_SCHEMA_VERSION, "bridlewise-test-result-collection/v2");
});

test("classifyTestConcurrency: 20 independent files all go to parallel", () => {
  const dir = makeTempDir("bulk20");
  try {
    const names: string[] = [];
    for (let i = 0; i < 20; i++) {
      const name = `t${i}.test.ts`;
      writeTestFile(dir, name, PASSING_TEST_SOURCE);
      names.push(name);
    }
    const result = classifyTestConcurrency(names, dir);
    assert.equal(result.parallel.length, 20);
    assert.equal(result.serial.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifyTestConcurrency: 20 serial files all go to serial", () => {
  const dir = makeTempDir("bulk20s");
  try {
    const names: string[] = [];
    for (let i = 0; i < 20; i++) {
      const name = `t${i}.test.ts`;
      writeTestFile(dir, name, SERIAL_MARKER_SOURCE);
      names.push(name);
    }
    const result = classifyTestConcurrency(names, dir);
    assert.equal(result.serial.length, 20);
    assert.equal(result.parallel.length, 0);
    for (const name of names) {
      assert.deepEqual(result.serialReasons[name], ["evidence-worker"]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifyTestConcurrency: 50 mixed files partition correctly", () => {
  const dir = makeTempDir("bulk50");
  try {
    const names: string[] = [];
    for (let i = 0; i < 50; i++) {
      const name = `t${i}.test.ts`;
      writeTestFile(dir, name, i % 5 === 0 ? SERIAL_MARKER_SOURCE : PASSING_TEST_SOURCE);
      names.push(name);
    }
    const result = classifyTestConcurrency(names, dir);
    assert.equal(result.serial.length, 10);
    assert.equal(result.parallel.length, 40);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const COLLECTOR_ABSOLUTE = resolve(process.cwd(), "src/workflow/test-result-collector.ts");

const CLEAN_SUBPROCESS_ENV: NodeJS.ProcessEnv = (() => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  return env;
})();

function runCollectorSubprocess(mode: string, fail: boolean): {
  status: string;
  total: number;
  passed: number;
  failed: number;
  report: ConcurrencyReport | null;
} {
  const workDir = createTempDir("subproc-work-");
  try {
    mkdirSync(join(workDir, "test"), { recursive: true });
    writeFileSync(join(workDir, "test", "a.test.ts"), fail
      ? `import test from "node:test";\nimport assert from "node:assert/strict";\ntest("fail", () => { assert.equal(1, 2); });\n`
      : PASSING_TEST_SOURCE);
    const helperSource = `import { collectTestResults } from ${JSON.stringify(COLLECTOR_ABSOLUTE)};\n` +
      `const workDir = ${JSON.stringify(workDir)};\n` +
      `const mode = ${JSON.stringify(mode)};\n` +
      `const concurrency = mode === "auto" ? "auto" : mode === "false" ? false : mode === "true" ? true : Number(mode);\n` +
      `const coll = await collectTestResults(workDir, { concurrency, parallelConcurrency: 2 });\n` +
      `process.stdout.write(JSON.stringify({ status: coll.status, total: coll.summary.total, passed: coll.summary.passed, failed: coll.summary.failed, report: coll.concurrencyReport }));\n`;
    const helperPath = join(workDir, "helper.mts");
    writeFileSync(helperPath, helperSource, "utf8");
    const result = spawnSync(process.execPath, [helperPath], { encoding: "utf8", timeout: 60_000, env: CLEAN_SUBPROCESS_ENV });
    assert.equal(result.status, 0, `subprocess exited ${result.status}: ${result.stderr}`);
    assert.equal(result.stderr.length, 0, `subprocess stderr: ${result.stderr}`);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

test("subprocess: collectTestResults auto collects passing tests under clean node", () => {
  const out = runCollectorSubprocess("auto", false);
  assert.equal(out.status, "passed");
  assert.equal(out.total, 1);
  assert.equal(out.passed, 1);
  assert.equal(out.failed, 0);
  assert.ok(out.report !== null);
  assert.equal(out.report!.mode, "auto");
  assert.deepEqual([...out.report!.parallel], ["test/a.test.ts"]);
  assert.deepEqual([...out.report!.serial], []);
});

test("subprocess: collectTestResults auto detects failures under clean node", () => {
  const out = runCollectorSubprocess("auto", true);
  assert.equal(out.status, "failed");
  assert.ok(out.failed >= 1);
  assert.ok(out.report !== null);
  assert.deepEqual([...out.report!.parallel], ["test/a.test.ts"]);
});

test("subprocess: collectTestResults false collects passing tests under clean node", () => {
  const out = runCollectorSubprocess("false", false);
  assert.equal(out.status, "passed");
  assert.equal(out.total, 1);
  assert.equal(out.report, null);
});

test("subprocess: collectTestResults false detects failures under clean node", () => {
  const out = runCollectorSubprocess("false", true);
  assert.equal(out.status, "failed");
  assert.ok(out.failed >= 1);
  assert.equal(out.report, null);
});

test("subprocess: collectTestResults true (parallelism) collects passing tests under clean node", () => {
  const out = runCollectorSubprocess("true", false);
  assert.equal(out.status, "passed");
  assert.equal(out.total, 1);
  assert.equal(out.report, null);
});

test("subprocess: collectTestResults numeric concurrency collects passing tests under clean node", () => {
  const out = runCollectorSubprocess("2", false);
  assert.equal(out.status, "passed");
  assert.equal(out.total, 1);
  assert.equal(out.report, null);
});

test("subprocess: collectTestResults auto with serial-marker file runs serially under clean node", () => {
  const workDir = createTempDir("subproc-serial-");
  try {
    mkdirSync(join(workDir, "test"), { recursive: true });
    writeFileSync(join(workDir, "test", "serial.test.ts"), `import test from "node:test";\n// runWorkerWithEvidence\ntest("pass", () => {});\n`);
    const helperSource = `import { collectTestResults } from ${JSON.stringify(COLLECTOR_ABSOLUTE)};\n` +
      `const coll = await collectTestResults(${JSON.stringify(workDir)}, { concurrency: "auto", parallelConcurrency: 2 });\n` +
      `process.stdout.write(JSON.stringify({ status: coll.status, total: coll.summary.total, report: coll.concurrencyReport }));\n`;
    const helperPath = join(workDir, "helper.mts");
    writeFileSync(helperPath, helperSource, "utf8");
    const result = spawnSync(process.execPath, [helperPath], { encoding: "utf8", timeout: 60_000, env: CLEAN_SUBPROCESS_ENV });
    assert.equal(result.status, 0, `subprocess exited ${result.status}: ${result.stderr}`);
    const out = JSON.parse(result.stdout);
    assert.equal(out.status, "passed");
    assert.equal(out.total, 1);
    assert.deepEqual([...out.report.serial], ["test/serial.test.ts"]);
    assert.deepEqual([...out.report.parallel], []);
    assert.deepEqual(out.report.serialReasons["test/serial.test.ts"], ["evidence-worker"]);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("subprocess: collectTestResults auto with mixed files partitions and collects both under clean node", () => {
  const workDir = createTempDir("subproc-mixed-");
  try {
    mkdirSync(join(workDir, "test"), { recursive: true });
    writeFileSync(join(workDir, "test", "indep.test.ts"), PASSING_TEST_SOURCE);
    writeFileSync(join(workDir, "test", "serial.test.ts"), `import test from "node:test";\n// runWorkerWithEvidence\ntest("pass", () => {});\n`);
    const helperSource = `import { collectTestResults } from ${JSON.stringify(COLLECTOR_ABSOLUTE)};\n` +
      `const coll = await collectTestResults(${JSON.stringify(workDir)}, { concurrency: "auto", parallelConcurrency: 2 });\n` +
      `process.stdout.write(JSON.stringify({ status: coll.status, total: coll.summary.total, passed: coll.summary.passed, report: coll.concurrencyReport }));\n`;
    const helperPath = join(workDir, "helper.mts");
    writeFileSync(helperPath, helperSource, "utf8");
    const result = spawnSync(process.execPath, [helperPath], { encoding: "utf8", timeout: 60_000, env: CLEAN_SUBPROCESS_ENV });
    assert.equal(result.status, 0, `subprocess exited ${result.status}: ${result.stderr}`);
    const out = JSON.parse(result.stdout);
    assert.equal(out.status, "passed");
    assert.equal(out.total, 2);
    assert.equal(out.passed, 2);
    assert.deepEqual([...out.report.parallel], ["test/indep.test.ts"]);
    assert.deepEqual([...out.report.serial], ["test/serial.test.ts"]);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("subprocess: collectTestResults auto with two independent files runs both in parallel under clean node", () => {
  const workDir = createTempDir("subproc-two-");
  try {
    mkdirSync(join(workDir, "test"), { recursive: true });
    writeFileSync(join(workDir, "test", "a.test.ts"), PASSING_TEST_SOURCE);
    writeFileSync(join(workDir, "test", "b.test.ts"), PASSING_TEST_SOURCE);
    const helperSource = `import { collectTestResults } from ${JSON.stringify(COLLECTOR_ABSOLUTE)};\n` +
      `const coll = await collectTestResults(${JSON.stringify(workDir)}, { concurrency: "auto", parallelConcurrency: 2 });\n` +
      `process.stdout.write(JSON.stringify({ status: coll.status, total: coll.summary.total, report: coll.concurrencyReport }));\n`;
    const helperPath = join(workDir, "helper.mts");
    writeFileSync(helperPath, helperSource, "utf8");
    const result = spawnSync(process.execPath, [helperPath], { encoding: "utf8", timeout: 60_000, env: CLEAN_SUBPROCESS_ENV });
    assert.equal(result.status, 0, `subprocess exited ${result.status}: ${result.stderr}`);
    const out = JSON.parse(result.stdout);
    assert.equal(out.status, "passed");
    assert.equal(out.total, 2);
    assert.deepEqual([...out.report.parallel].sort(), ["test/a.test.ts", "test/b.test.ts"]);
    assert.deepEqual([...out.report.serial], []);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("subprocess: collectTestResults auto collects passing tests under clean node (recheck)", () => {
  const out = runCollectorSubprocess("auto", false);
  assert.equal(out.status, "passed");
  assert.equal(out.total, 1);
  assert.equal(out.report!.parallelConcurrency, 2);
});

test("classifyTestConcurrency: nested directory paths are preserved", () => {
  const dir = makeTempDir("nested");
  try {
    mkdirSync(join(dir, "test", "deep", "path"), { recursive: true });
    writeFileSync(join(dir, "test", "deep", "path", "a.test.ts"), PASSING_TEST_SOURCE, "utf8");
    const result = classifyTestConcurrency(["test/deep/path/a.test.ts"], dir);
    assert.deepEqual([...result.parallel], ["test/deep/path/a.test.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifyTestConcurrency:.spec.ts files without markers go to parallel", () => {
  const dir = makeTempDir("spec");
  try {
    writeTestFile(dir, "a.spec.ts", PASSING_TEST_SOURCE);
    const result = classifyTestConcurrency(["a.spec.ts"], dir);
    assert.deepEqual([...result.parallel], ["a.spec.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifyTestConcurrency:.spec.ts files with markers go to serial", () => {
  const dir = makeTempDir("spec-serial");
  try {
    writeTestFile(dir, "a.spec.ts", SERIAL_MARKER_SOURCE);
    const result = classifyTestConcurrency(["a.spec.ts"], dir);
    assert.deepEqual([...result.serial], ["a.spec.ts"]);
    assert.deepEqual(result.serialReasons["a.spec.ts"], ["evidence-worker"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifyTestConcurrency: marker in comment is detected", () => {
  const dir = makeTempDir("comment");
  try {
    writeTestFile(dir, "a.test.ts", `// this uses runWorkerWithEvidence here\ntest("x", () => {});`);
    const result = classifyTestConcurrency(["a.test.ts"], dir);
    assert.deepEqual([...result.serial], ["a.test.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifyTestConcurrency: marker in string literal is detected", () => {
  const dir = makeTempDir("stringlit");
  try {
    writeTestFile(dir, "a.test.ts", `const msg = "uses TEST_EXECUTION_OPERATION";\ntest("x", () => {});`);
    const result = classifyTestConcurrency(["a.test.ts"], dir);
    assert.deepEqual([...result.serial], ["a.test.ts"]);
    assert.deepEqual(result.serialReasons["a.test.ts"], ["execution-operation"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifyTestConcurrency: marker substring match is conservatively detected as serial", () => {
  const dir = makeTempDir("partial");
  try {
    writeTestFile(dir, "a.test.ts", `const x = "runWorkerWithEvidenceSuffix";\ntest("x", () => {});`);
    const result = classifyTestConcurrency(["a.test.ts"], dir);
    assert.deepEqual([...result.serial], ["a.test.ts"]);
    assert.deepEqual(result.serialReasons["a.test.ts"], ["evidence-worker"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifyTestConcurrency: empty file content goes to parallel", () => {
  const dir = makeTempDir("empty-content");
  try {
    writeTestFile(dir, "a.test.ts", "");
    const result = classifyTestConcurrency(["a.test.ts"], dir);
    assert.deepEqual([...result.parallel], ["a.test.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifyTestConcurrency: whitespace-only file goes to parallel", () => {
  const dir = makeTempDir("ws");
  try {
    writeTestFile(dir, "a.test.ts", "   \n  \n");
    const result = classifyTestConcurrency(["a.test.ts"], dir);
    assert.deepEqual([...result.parallel], ["a.test.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifyTestConcurrency: file with all four marker types lists all four reasons", () => {
  const dir = makeTempDir("all4");
  try {
    writeTestFile(dir, "a.test.ts", `// runWorkerWithEvidence TEST_EXECUTION_OPERATION planned-node-test-evidence scripts/run-tests`);
    const result = classifyTestConcurrency(["a.test.ts"], dir);
    assert.deepEqual(result.serialReasons["a.test.ts"], [
      "evidence-worker", "execution-operation", "evidence-session-import", "test-runner-import",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifyTestConcurrency: 100 files partition correctly", () => {
  const dir = makeTempDir("bulk100");
  try {
    const names: string[] = [];
    for (let i = 0; i < 100; i++) {
      const name = `t${i}.test.ts`;
      writeTestFile(dir, name, i % 10 === 0 ? SERIAL_MARKER_SOURCE : PASSING_TEST_SOURCE);
      names.push(name);
    }
    const result = classifyTestConcurrency(names, dir);
    assert.equal(result.serial.length, 10);
    assert.equal(result.parallel.length, 90);
    assert.equal(result.parallel.length + result.serial.length, 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ConcurrencyReport: empty parallel and serial arrays", () => {
  const collector = createTestResultCollector();
  const report: ConcurrencyReport = deepFreezeLocal({
    mode: "auto",
    parallel: [],
    serial: [],
    serialReasons: {},
    parallelConcurrency: 4,
  });
  const collection = collector.complete("/root", report);
  assert.deepEqual([...collection.concurrencyReport!.parallel], []);
  assert.deepEqual([...collection.concurrencyReport!.serial], []);
});

test("ConcurrencyReport: determinism - same events and report produce same hash", () => {
  const events = [makePassEvent("t1", "/root/test/a.test.ts", 10)];
  const report = makeReport();
  const c1 = createTestResultCollector();
  const c2 = createTestResultCollector();
  for (const ev of events) { c1.observe(ev); c2.observe(ev); }
  const r1 = c1.complete("/root", report);
  const r2 = c2.complete("/root", report);
  assert.deepEqual(
    { ...r1, generatedAt: "T", integrityHash: "H" },
    { ...r2, generatedAt: "T", integrityHash: "H" },
  );
});

test("ConcurrencyReport: different reports produce different hashes", () => {
  const collector = createTestResultCollector();
  collector.observe(makePassEvent("t1", "/root/test/a.test.ts"));
  const r1 = collector.complete("/root", makeReport({ parallelConcurrency: 2 }));
  const r2 = collector.complete("/root", makeReport({ parallelConcurrency: 4 }));
  assert.notEqual(r1.integrityHash, r2.integrityHash);
});

test("parseConcurrencyReport: empty parallel and serial arrays parse", () => {
  const parsed = parseConcurrencyReport({ mode: "auto", parallel: [], serial: [], serialReasons: {}, parallelConcurrency: 1 });
  assert.deepEqual([...parsed!.parallel], []);
  assert.deepEqual([...parsed!.serial], []);
  assert.deepEqual(parsed!.serialReasons, {});
});

test("parseConcurrencyReport: empty serialReasons object is accepted", () => {
  const parsed = parseConcurrencyReport({ mode: "auto", parallel: ["a"], serial: [], serialReasons: {}, parallelConcurrency: 1 });
  assert.deepEqual(parsed!.serialReasons, {});
});

test("parseConcurrencyReport: serialReasons with multiple reasons parse", () => {
  const parsed = parseConcurrencyReport({
    mode: "auto", parallel: [], serial: ["a.test.ts"], serialReasons: { "a.test.ts": ["evidence-worker", "execution-operation"] }, parallelConcurrency: 1,
  });
  assert.deepEqual(parsed!.serialReasons["a.test.ts"], ["evidence-worker", "execution-operation"]);
});

test("parseConcurrencyReport: valid report round-trips through canonicalJson", () => {
  const report = makeReport();
  const parsed = parseConcurrencyReport(JSON.parse(canonicalJson(report)));
  const reparsed = parseConcurrencyReport(JSON.parse(canonicalJson(parsed)));
  assert.deepEqual({ ...parsed }, { ...reparsed });
});

test("parseConcurrencyReport: Infinity parallelConcurrency throws", () => {
  assert.throws(() => parseConcurrencyReport({ mode: "auto", parallel: [], serial: [], parallelConcurrency: Infinity }), /parallelConcurrency/);
});

test("parseConcurrencyReport: boolean parallelConcurrency throws", () => {
  assert.throws(() => parseConcurrencyReport({ mode: "auto", parallel: [], serial: [], parallelConcurrency: true }), /parallelConcurrency/);
});

test("MultiSummary: summary success=true with only skip entries is passed", () => {
  const collector = createTestResultCollector();
  collector.observe(makeEvent("test:pass", { name: "s1", file: "/root/test/a.test.ts", skip: true, details: { duration_ms: 0 } }));
  collector.observe(makeSummaryEvent(true, 100));
  const collection = collector.complete("/root");
  assert.equal(collection.status, "passed");
});

test("MultiSummary: summary success=true with only todo entries is passed", () => {
  const collector = createTestResultCollector();
  collector.observe(makeEvent("test:pass", { name: "t1", file: "/root/test/a.test.ts", todo: true, details: { duration_ms: 0 } }));
  collector.observe(makeSummaryEvent(true, 100));
  const collection = collector.complete("/root");
  assert.equal(collection.status, "passed");
});

test("MultiSummary: two summaries where first has failure entries and second is clean is failed", () => {
  const collector = createTestResultCollector();
  collector.observe(makeFailEvent("f1", "/root/test/a.test.ts", new Error("e")));
  collector.observe(makeSummaryEvent(false, 100));
  collector.observe(makePassEvent("p1", "/root/test/b.test.ts"));
  collector.observe(makeSummaryEvent(true, 200));
  const collection = collector.complete("/root");
  assert.equal(collection.status, "failed");
  assert.equal(collection.summary.failed, 1);
});

test("MultiSummary: 10 summaries all success is passed with summed duration", () => {
  const collector = createTestResultCollector();
  for (let i = 0; i < 10; i++) collector.observe(makeSummaryEvent(true, 50));
  const collection = collector.complete("/root");
  assert.equal(collection.status, "passed");
  assert.equal(collection.summary.durationMs, 500);
});

test("MultiSummary: 10 summaries one failure is failed", () => {
  const collector = createTestResultCollector();
  for (let i = 0; i < 10; i++) {
    collector.observe(makeSummaryEvent(i === 5 ? false : true, 50));
  }
  const collection = collector.complete("/root");
  assert.equal(collection.status, "failed");
});

test("MultiSummary: pass events with no summary use accumulated duration", () => {
  const collector = createTestResultCollector();
  for (let i = 0; i < 5; i++) collector.observe(makePassEvent(`t${i}`, "/root/test/a.test.ts", 100));
  const collection = collector.complete("/root");
  assert.equal(collection.summary.durationMs, 500);
  assert.equal(collection.status, "passed");
});

test("MultiSummary: cancel events do not contribute to passed or failed", () => {
  const collector = createTestResultCollector();
  collector.observe(makePassEvent("p1", "/root/test/a.test.ts", 10));
  collector.observe(makeEvent("test:cancel", { name: "c1", file: "/root/test/a.test.ts", details: { duration_ms: 5 } }));
  collector.observe(makeSummaryEvent(true, 30));
  const collection = collector.complete("/root");
  assert.equal(collection.summary.passed, 1);
  assert.equal(collection.summary.cancelled, 1);
  assert.equal(collection.status, "passed");
});

test("ConcurrencyReport: complete with report sets status from entries", () => {
  const collector = createTestResultCollector();
  collector.observe(makeFailEvent("f1", "/root/test/a.test.ts", new Error("e")));
  const collection = collector.complete("/root", makeReport());
  assert.equal(collection.status, "failed");
  assert.ok(collection.concurrencyReport !== null);
});

test("ConcurrencyReport: complete with report and all passes is passed", () => {
  const collector = createTestResultCollector();
  collector.observe(makePassEvent("p1", "/root/test/a.test.ts"));
  collector.observe(makeSummaryEvent(true, 100));
  const collection = collector.complete("/root", makeReport());
  assert.equal(collection.status, "passed");
});

test("SHARED_RESOURCE_MARKERS: all patterns are RegExp instances", () => {
  for (const marker of SHARED_RESOURCE_MARKERS) {
    assert.ok(marker.pattern instanceof RegExp, `${marker.id} pattern must be RegExp`);
    assert.equal(typeof marker.id, "string");
    assert.ok(marker.id.length > 0);
  }
});

test("SHARED_RESOURCE_MARKERS: evidence-worker pattern matches runWorkerWithEvidence", () => {
  const marker = SHARED_RESOURCE_MARKERS.find((m) => m.id === "evidence-worker")!;
  assert.ok(marker.pattern.test("runWorkerWithEvidence"));
  assert.ok(marker.pattern.test("runTestsWithEvidence"));
  assert.ok(marker.pattern.test("runCheckWithEvidence"));
  assert.ok(marker.pattern.test("runPlannedNodeTestSuiteWithEvidence"));
  assert.ok(!marker.pattern.test("runWorker"));
  assert.ok(!marker.pattern.test("Evidence"));
});

test("SHARED_RESOURCE_MARKERS: execution-operation pattern matches uppercase constants", () => {
  const marker = SHARED_RESOURCE_MARKERS.find((m) => m.id === "execution-operation")!;
  assert.ok(marker.pattern.test("TEST_EXECUTION_OPERATION"));
  assert.ok(marker.pattern.test("CHECK_EXECUTION_OPERATION"));
  assert.ok(!marker.pattern.test("test_execution_operation"));
  assert.ok(!marker.pattern.test("execution"));
});

test("SHARED_RESOURCE_MARKERS: evidence-session-import pattern matches planned-node-test-evidence", () => {
  const marker = SHARED_RESOURCE_MARKERS.find((m) => m.id === "evidence-session-import")!;
  assert.ok(marker.pattern.test("planned-node-test-evidence"));
  assert.ok(marker.pattern.test("./planned-node-test-evidence.ts"));
  assert.ok(!marker.pattern.test("planned-node-test"));
  assert.ok(!marker.pattern.test("evidence"));
});

test("SHARED_RESOURCE_MARKERS: test-runner-import pattern matches scripts/run-tests", () => {
  const marker = SHARED_RESOURCE_MARKERS.find((m) => m.id === "test-runner-import")!;
  assert.ok(marker.pattern.test("scripts/run-tests"));
  assert.ok(marker.pattern.test("../scripts/tooling/run-tests.ts"));
  assert.ok(!marker.pattern.test("scripts/run-check"));
  assert.ok(!marker.pattern.test("run-tests"));
});

test("collectTestResults: auto mode with explicit files containing unreadable path classifies serial", async () => {
  const dir = makeTempDir("auto-unread");
  try {
    mkdirSync(join(dir, "test"), { recursive: true });
    writeTestFile(dir, "test/a.test.ts", PASSING_TEST_SOURCE);
    const collection = await collectTestResults(dir, { files: ["test/a.test.ts", "test/missing.test.ts"], concurrency: "auto", parallelConcurrency: 1 });
    assert.deepEqual([...collection.concurrencyReport!.parallel], ["test/a.test.ts"]);
    assert.deepEqual([...collection.concurrencyReport!.serial], ["test/missing.test.ts"]);
    assert.deepEqual(collection.concurrencyReport!.serialReasons["test/missing.test.ts"], ["unreadable-source"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function deepFreezeLocal<T>(value: T): Readonly<T> {
  return Object.freeze(value) as Readonly<T>;
}
