import assert from "node:assert/strict";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  createTestResultCollector,
  collectTestResults,
  writeTestResultCollection,
  writeTestRunSummary,
  parseTestResultCollection,
  TEST_RESULT_COLLECTION_SCHEMA_VERSION,
  TEST_RESULT_COLLECTION_PATH,
  TEST_RESULT_COLLECTION_DIRECTORY,
  TEST_RUN_SUMMARY_SCHEMA_VERSION,
  TEST_RUN_SUMMARY_PATH,
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

function makeCancelEvent(name: string, file: string): { type: string; data: Record<string, unknown> } {
  return makeEvent("test:cancel", { name, file, details: { duration_ms: 0 } });
}

function makeSummaryEvent(success: boolean, counts: Record<string, number>, durationMs = 1000): { type: string; data: Record<string, unknown> } {
  return makeEvent("test:summary", { success, counts, details: { duration_ms: durationMs } });
}

test("TestResultCollector: creates a collector with observe and complete functions", () => {
  const collector = createTestResultCollector();
  assert.equal(typeof collector.observe, "function");
  assert.equal(typeof collector.complete, "function");
});

test("TestResultCollector: empty collection has zero counts", () => {
  const collector = createTestResultCollector();
  const collection = collector.complete("/root");
  assert.equal(collection.schemaVersion, TEST_RESULT_COLLECTION_SCHEMA_VERSION);
  assert.equal(collection.status, "passed");
  assert.equal(collection.summary.total, 0);
  assert.equal(collection.summary.passed, 0);
  assert.equal(collection.summary.failed, 0);
  assert.equal(collection.summary.skipped, 0);
  assert.equal(collection.summary.todo, 0);
  assert.equal(collection.summary.cancelled, 0);
  assert.equal(collection.tests.length, 0);
});

test("TestResultCollector: single pass event produces a passing entry", () => {
  const collector = createTestResultCollector();
  collector.observe(makePassEvent("test1", "/root/test/a.test.ts", 42));
  const collection = collector.complete("/root");
  assert.equal(collection.status, "passed");
  assert.equal(collection.summary.total, 1);
  assert.equal(collection.summary.passed, 1);
  assert.equal(collection.summary.failed, 0);
  assert.equal(collection.tests[0]!.name, "test1");
  assert.equal(collection.tests[0]!.file, "test/a.test.ts");
  assert.equal(collection.tests[0]!.status, "pass");
  assert.equal(collection.tests[0]!.durationMs, 42);
  assert.equal(collection.tests[0]!.error, null);
  assert.equal(collection.tests[0]!.line, 1);
  assert.equal(collection.tests[0]!.column, 1);
});

test("TestResultCollector: fail event captures error message and stack", () => {
  const collector = createTestResultCollector();
  const error = new Error("something went wrong");
  error.stack = "Error: something went wrong\n    at /root/test/a.test.ts:5:10";
  collector.observe(makeFailEvent("test-fail", "/root/test/a.test.ts", error, 50));
  const collection = collector.complete("/root");
  assert.equal(collection.status, "failed");
  assert.equal(collection.summary.failed, 1);
  assert.equal(collection.tests[0]!.status, "fail");
  assert.notEqual(collection.tests[0]!.error, null);
  assert.equal(collection.tests[0]!.error!.message, "something went wrong");
  assert.equal(collection.tests[0]!.error!.stack, error.stack);
  assert.equal(collection.tests[0]!.error!.cause, null);
});

test("TestResultCollector: fail event with Error cause captures cause message", () => {
  const collector = createTestResultCollector();
  const cause = new Error("root cause");
  const error = new Error("wrapper error", { cause });
  collector.observe(makeFailEvent("test-cause", "/root/test/a.test.ts", error));
  const collection = collector.complete("/root");
  assert.equal(collection.tests[0]!.error!.cause, "root cause");
});

test("TestResultCollector: fail event extracts the assertion failure location from the error stack and relativizes it", () => {
  const collector = createTestResultCollector();
  const error = new Error("Expected values to be strictly equal");
  error.stack = "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal\n" +
    "    at checkViewer (/root/test/privacy/file-viewer.test.ts:123:7)\n" +
    "    at TestContext.<anonymous> (/root/test/privacy/file-viewer.test.ts:130:3)";
  collector.observe(makeFailEvent("viewer-test", "/root/test/privacy/file-viewer.test.ts", error));
  const collection = collector.complete("/root");
  const entry = collection.tests[0]!;
  assert.equal(entry.status, "fail");
  assert.equal(entry.error!.failureFile, "test/privacy/file-viewer.test.ts");
  assert.equal(entry.error!.failureLine, 123);
  assert.equal(entry.error!.failureColumn, 7);
});

test("TestResultCollector: fail event composes an assertion summary from expected/actual/operator", () => {
  const collector = createTestResultCollector();
  const error = Object.assign(new Error("Expected values to be strictly equal"), {
    expected: true,
    actual: false,
    operator: "strictEqual",
  });
  collector.observe(makeFailEvent("assert-test", "/root/test/a.test.ts", error));
  const collection = collector.complete("/root");
  assert.equal(collection.tests[0]!.error!.assertion, "strictEqual: expected true, got false");
});

test("TestResultCollector: fail event without a source frame or assertion values reports nulls honestly", () => {
  const collector = createTestResultCollector();
  collector.observe(makeFailEvent("no-frame", "/root/test/a.test.ts", { message: "plain failure" }));
  const collection = collector.complete("/root");
  assert.equal(collection.tests[0]!.error!.failureFile, null);
  assert.equal(collection.tests[0]!.error!.failureLine, null);
  assert.equal(collection.tests[0]!.error!.failureColumn, null);
  assert.equal(collection.tests[0]!.error!.assertion, null);
});

test("TestResultCollector: fail event unwraps the runner's ERR_TEST_FAILURE envelope to the assertion cause", () => {
  // The node:test runner wraps assertion failures: the delivered error has
  // code ERR_TEST_FAILURE and a frame-less stack, while the AssertionError in
  // `cause` carries the failing call site and the assertion detail. This is
  // the exact shape emitted for `assert.equal(false, true)` (verified against
  // the runner's event stream).
  const collector = createTestResultCollector();
  const cause = Object.assign(new Error("Expected values to be strictly equal:\n\nfalse !== true\n"), {
    name: "AssertionError",
    code: "ERR_ASSERTION",
  });
  cause.stack = "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\nfalse !== true\n\n" +
    "    at TestContext.<anonymous> (/root/test/demo.test.ts:4:10)\n" +
    "    at Test.runInAsyncScope (node:async_hooks:227:14)";
  const error = Object.assign(new Error("Expected values to be strictly equal:\n\nfalse !== true\n"), {
    code: "ERR_TEST_FAILURE",
    cause,
  });
  error.stack = "Error [ERR_TEST_FAILURE]: Expected values to be strictly equal:\n\nfalse !== true\n";
  collector.observe(makeFailEvent("wrapper-test", "/root/test/demo.test.ts", error));
  const collection = collector.complete("/root");
  const entry = collection.tests[0]!;
  assert.equal(entry.error!.failureFile, "test/demo.test.ts");
  assert.equal(entry.error!.failureLine, 4);
  assert.equal(entry.error!.failureColumn, 10);
  assert.equal(entry.error!.assertion, "Expected values to be strictly equal: false !== true");
});

test("TestResultCollector: fail event with string cause captures string cause", () => {
  const collector = createTestResultCollector();
  const error = { message: "err", stack: "stk", cause: "string cause" };
  collector.observe(makeFailEvent("test-str-cause", "/root/test/a.test.ts", error));
  const collection = collector.complete("/root");
  assert.equal(collection.tests[0]!.error!.cause, "string cause");
});

test("TestResultCollector: cancel event produces a cancel entry", () => {
  const collector = createTestResultCollector();
  collector.observe(makeCancelEvent("test-cancel", "/root/test/a.test.ts"));
  const collection = collector.complete("/root");
  assert.equal(collection.summary.cancelled, 1);
  assert.equal(collection.tests[0]!.status, "cancel");
});

test("TestResultCollector: pass event with skip flag produces a skip entry", () => {
  const collector = createTestResultCollector();
  collector.observe(makeEvent("test:pass", { name: "test-skip", file: "/root/test/a.test.ts", skip: true, details: { duration_ms: 0 } }));
  const collection = collector.complete("/root");
  assert.equal(collection.summary.skipped, 1);
  assert.equal(collection.tests[0]!.status, "skip");
});

test("TestResultCollector: pass event with todo flag produces a todo entry", () => {
  const collector = createTestResultCollector();
  collector.observe(makeEvent("test:pass", { name: "test-todo", file: "/root/test/a.test.ts", todo: true, details: { duration_ms: 0 } }));
  const collection = collector.complete("/root");
  assert.equal(collection.summary.todo, 1);
  assert.equal(collection.tests[0]!.status, "todo");
});

test("TestResultCollector: fail event with todo flag produces a todo entry", () => {
  const collector = createTestResultCollector();
  collector.observe(makeEvent("test:fail", { name: "test-todo-fail", file: "/root/test/a.test.ts", todo: true, details: { duration_ms: 0, error: new Error("todo") } }));
  const collection = collector.complete("/root");
  assert.equal(collection.tests[0]!.status, "todo");
});

test("TestResultCollector: summary event sets status to passed when success is true and no failures", () => {
  const collector = createTestResultCollector();
  collector.observe(makePassEvent("test1", "/root/test/a.test.ts"));
  collector.observe(makeSummaryEvent(true, { tests: 1, passed: 1, failed: 0, cancelled: 0, skipped: 0, todo: 0 }, 500));
  const collection = collector.complete("/root");
  assert.equal(collection.status, "passed");
  assert.equal(collection.summary.durationMs, 500);
});

test("TestResultCollector: summary event sets status to failed when success is false", () => {
  const collector = createTestResultCollector();
  collector.observe(makeFailEvent("test1", "/root/test/a.test.ts", new Error("fail")));
  collector.observe(makeSummaryEvent(false, { tests: 1, passed: 0, failed: 1, cancelled: 0, skipped: 0, todo: 0 }, 500));
  const collection = collector.complete("/root");
  assert.equal(collection.status, "failed");
});

test("TestResultCollector: summary event sets status to failed when success is true but failures exist", () => {
  const collector = createTestResultCollector();
  collector.observe(makeFailEvent("test1", "/root/test/a.test.ts", new Error("fail")));
  collector.observe(makeSummaryEvent(true, { tests: 1, passed: 0, failed: 1, cancelled: 0, skipped: 0, todo: 0 }, 500));
  const collection = collector.complete("/root");
  assert.equal(collection.status, "failed");
});

test("TestResultCollector: no summary event uses accumulated duration", () => {
  const collector = createTestResultCollector();
  collector.observe(makePassEvent("test1", "/root/test/a.test.ts", 100));
  collector.observe(makePassEvent("test2", "/root/test/a.test.ts", 200));
  const collection = collector.complete("/root");
  assert.equal(collection.summary.durationMs, 300);
});

test("TestResultCollector: summary duration takes priority over accumulated", () => {
  const collector = createTestResultCollector();
  collector.observe(makePassEvent("test1", "/root/test/a.test.ts", 100));
  collector.observe(makeSummaryEvent(true, { tests: 1, passed: 1, failed: 0, cancelled: 0, skipped: 0, todo: 0 }, 500));
  const collection = collector.complete("/root");
  assert.equal(collection.summary.durationMs, 500);
});

test("TestResultCollector: skip and todo durations are not accumulated", () => {
  const collector = createTestResultCollector();
  collector.observe(makeEvent("test:pass", { name: "skip1", file: "/root/test/a.test.ts", skip: true, details: { duration_ms: 500 } }));
  collector.observe(makeEvent("test:pass", { name: "todo1", file: "/root/test/a.test.ts", todo: true, details: { duration_ms: 300 } }));
  collector.observe(makePassEvent("pass1", "/root/test/a.test.ts", 50));
  const collection = collector.complete("/root");
  assert.equal(collection.summary.durationMs, 50);
});

test("TestResultCollector: slowestFiles uses per-file summary durations, sorted desc then path asc, capped at 20", () => {
  const collector = createTestResultCollector();
  for (let index = 0; index < 25; index += 1) {
    const name = `f${String(index).padStart(2, "0")}.test.ts`;
    collector.observe(makePassEvent(`t-${name}`, `/root/test/${name}`, 1));
    collector.observe(makeEvent("test:summary", { file: `/root/test/${name}`, success: true, details: { duration_ms: (index + 1) * 10 } }));
  }
  // Tie on duration: the two files at 260ms must order by path ascending.
  collector.observe(makePassEvent("t-aa", "/root/test/aa.test.ts", 1));
  collector.observe(makeEvent("test:summary", { file: "/root/test/aa.test.ts", success: true, details: { duration_ms: 250 } }));
  collector.observe(makePassEvent("t-zz", "/root/test/zz.test.ts", 1));
  collector.observe(makeEvent("test:summary", { file: "/root/test/zz.test.ts", success: true, details: { duration_ms: 250 } }));
  const collection = collector.complete("/root");
  const slowest = collection.summary.slowestFiles;
  assert.equal(slowest.length, 20);
  // The maximum duration is 250ms, shared by three files; equal durations
  // order by path ascending.
  const ties = slowest.filter((entry) => entry.durationMs === 250).map((entry) => entry.file);
  assert.deepEqual(ties, ["test/aa.test.ts", "test/f24.test.ts", "test/zz.test.ts"]);
  assert.deepEqual(slowest.slice(0, 3).map((entry) => entry.file), ["test/aa.test.ts", "test/f24.test.ts", "test/zz.test.ts"]);
  // After the ties, durations strictly descend from 240ms.
  assert.equal(slowest[3]!.file, "test/f23.test.ts");
  assert.equal(slowest[3]!.durationMs, 240);
  for (let index = 1; index < slowest.length; index += 1) {
    const previous = slowest[index - 1]!;
    const current = slowest[index]!;
    assert.ok(previous.durationMs > current.durationMs ||
      (previous.durationMs === current.durationMs && previous.file < current.file));
  }
  // Every entry is normalized to a root-relative path.
  assert.ok(slowest.every((entry) => !entry.file.startsWith("/")));
});

test("TestResultCollector: slowestFiles falls back to summed per-test durations without file summaries", () => {
  const collector = createTestResultCollector();
  collector.observe(makePassEvent("t1", "/root/test/a.test.ts", 100));
  collector.observe(makePassEvent("t2", "/root/test/a.test.ts", 150));
  collector.observe(makePassEvent("t3", "/root/test/b.test.ts", 500));
  const collection = collector.complete("/root");
  assert.deepEqual(collection.summary.slowestFiles, [
    { file: "test/b.test.ts", durationMs: 500 },
    { file: "test/a.test.ts", durationMs: 250 },
  ]);
});

test("TestResultCollector: slowestFiles durations are excluded from deterministicHash", () => {
  const build = (durationMs: number): string => {
    const collector = createTestResultCollector();
    collector.observe(makePassEvent("t1", "/root/test/a.test.ts", durationMs));
    collector.observe(makeEvent("test:summary", { file: "/root/test/a.test.ts", success: true, details: { duration_ms: durationMs } }));
    return collector.complete("/root").deterministicHash;
  };
  assert.equal(build(10), build(9999));
});

test("TestResultCollector: file paths are normalized to relative", () => {
  const collector = createTestResultCollector();
  collector.observe(makePassEvent("test1", "/root/test/sub/dir/a.test.ts"));
  const collection = collector.complete("/root");
  assert.equal(collection.tests[0]!.file, "test/sub/dir/a.test.ts");
});

test("TestResultCollector: backslash paths are normalized to forward slashes", () => {
  const collector = createTestResultCollector();
  collector.observe(makePassEvent("test1", "test\\sub\\dir\\a.test.ts"));
  const collection = collector.complete("/root");
  assert.equal(collection.tests[0]!.file, "test/sub/dir/a.test.ts");
});

test("TestResultCollector: already-relative paths are kept as-is", () => {
  const collector = createTestResultCollector();
  collector.observe(makePassEvent("test1", "test/a.test.ts"));
  const collection = collector.complete("/root");
  assert.equal(collection.tests[0]!.file, "test/a.test.ts");
});

test("TestResultCollector: entries are frozen", () => {
  const collector = createTestResultCollector();
  collector.observe(makePassEvent("test1", "/root/test/a.test.ts"));
  const collection = collector.complete("/root");
  assert.ok(Object.isFrozen(collection));
  assert.ok(Object.isFrozen(collection.tests));
  assert.ok(Object.isFrozen(collection.tests[0]));
  assert.ok(Object.isFrozen(collection.summary));
});

test("TestResultCollector: integrity hash is valid", () => {
  const collector = createTestResultCollector();
  collector.observe(makePassEvent("test1", "/root/test/a.test.ts"));
  const collection = collector.complete("/root");
  const { integrityHash, ...unsigned } = collection;
  assert.equal(sha256(canonicalJson(unsigned)), integrityHash);
});

test("TestResultCollector: generatedAt is a valid ISO string", () => {
  const collector = createTestResultCollector();
  const collection = collector.complete("/root");
  const parsed = new Date(collection.generatedAt);
  assert.ok(!Number.isNaN(parsed.getTime()));
  assert.equal(parsed.toISOString(), collection.generatedAt);
});

test("TestResultCollector: multiple events are collected in order", () => {
  const collector = createTestResultCollector();
  collector.observe(makePassEvent("test1", "/root/test/a.test.ts", 10));
  collector.observe(makePassEvent("test2", "/root/test/a.test.ts", 20));
  collector.observe(makeFailEvent("test3", "/root/test/b.test.ts", new Error("err"), 30));
  collector.observe(makeCancelEvent("test4", "/root/test/b.test.ts"));
  const collection = collector.complete("/root");
  assert.equal(collection.tests.length, 4);
  assert.equal(collection.tests[0]!.name, "test1");
  assert.equal(collection.tests[1]!.name, "test2");
  assert.equal(collection.tests[2]!.name, "test3");
  assert.equal(collection.tests[3]!.name, "test4");
});

test("TestResultCollector: mixed status types produce correct summary", () => {
  const collector = createTestResultCollector();
  collector.observe(makePassEvent("p1", "/root/test/a.test.ts"));
  collector.observe(makePassEvent("p2", "/root/test/a.test.ts"));
  collector.observe(makeFailEvent("f1", "/root/test/a.test.ts", new Error("e")));
  collector.observe(makeEvent("test:pass", { name: "s1", file: "/root/test/a.test.ts", skip: true, details: { duration_ms: 0 } }));
  collector.observe(makeEvent("test:pass", { name: "t1", file: "/root/test/a.test.ts", todo: true, details: { duration_ms: 0 } }));
  collector.observe(makeCancelEvent("c1", "/root/test/a.test.ts"));
  const collection = collector.complete("/root");
  assert.equal(collection.summary.total, 6);
  assert.equal(collection.summary.passed, 2);
  assert.equal(collection.summary.failed, 1);
  assert.equal(collection.summary.skipped, 1);
  assert.equal(collection.summary.todo, 1);
  assert.equal(collection.summary.cancelled, 1);
});

test("TestResultCollector: events without name or file are ignored", () => {
  const collector = createTestResultCollector();
  collector.observe(makeEvent("test:pass", { name: undefined, file: "/root/test/a.test.ts" }));
  collector.observe(makeEvent("test:pass", { name: "test1", file: undefined }));
  collector.observe(makeEvent("test:pass", {}));
  const collection = collector.complete("/root");
  assert.equal(collection.summary.total, 0);
});

test("TestResultCollector: non-test events are ignored", () => {
  const collector = createTestResultCollector();
  collector.observe(makeEvent("test:start", {}));
  collector.observe(makeEvent("test:enqueue", { name: "test1", file: "/root/test/a.test.ts" }));
  collector.observe(makeEvent("custom:event", {}));
  const collection = collector.complete("/root");
  assert.equal(collection.summary.total, 0);
});

test("TestResultCollector: per-file summary events are ignored for duration", () => {
  const collector = createTestResultCollector();
  collector.observe(makePassEvent("test1", "/root/test/a.test.ts", 50));
  collector.observe(makeEvent("test:summary", { file: "/root/test/a.test.ts", success: true, counts: {}, details: { duration_ms: 100 } }));
  const collection = collector.complete("/root");
  assert.equal(collection.summary.durationMs, 50);
});

test("TestResultCollector: line and column are captured when present", () => {
  const collector = createTestResultCollector();
  collector.observe(makeEvent("test:pass", { name: "test1", file: "/root/test/a.test.ts", details: { duration_ms: 0 }, line: 42, column: 7 }));
  const collection = collector.complete("/root");
  assert.equal(collection.tests[0]!.line, 42);
  assert.equal(collection.tests[0]!.column, 7);
});

test("TestResultCollector: line and column are null when absent", () => {
  const collector = createTestResultCollector();
  collector.observe(makeEvent("test:pass", { name: "test1", file: "/root/test/a.test.ts", details: { duration_ms: 0 } }));
  const collection = collector.complete("/root");
  assert.equal(collection.tests[0]!.line, null);
  assert.equal(collection.tests[0]!.column, null);
});

test("TestResultCollector: durationMs defaults to 0 when not provided", () => {
  const collector = createTestResultCollector();
  collector.observe(makeEvent("test:pass", { name: "test1", file: "/root/test/a.test.ts" }));
  const collection = collector.complete("/root");
  assert.equal(collection.tests[0]!.durationMs, 0);
});

test("TestResultCollector: non-Error error object captures message", () => {
  const collector = createTestResultCollector();
  collector.observe(makeFailEvent("test1", "/root/test/a.test.ts", { message: "plain object error" }));
  const collection = collector.complete("/root");
  assert.equal(collection.tests[0]!.error!.message, "plain object error");
});

test("TestResultCollector: error with no message uses fallback", () => {
  const collector = createTestResultCollector();
  collector.observe(makeFailEvent("test1", "/root/test/a.test.ts", {}));
  const collection = collector.complete("/root");
  assert.equal(collection.tests[0]!.error!.message, "unknown error");
});

test("TestResultCollector: non-object error returns null", () => {
  const collector = createTestResultCollector();
  collector.observe(makeFailEvent("test1", "/root/test/a.test.ts", "string error"));
  const collection = collector.complete("/root");
  assert.equal(collection.tests[0]!.error, null);
});

test("TestResultCollector: null error on fail returns null", () => {
  const collector = createTestResultCollector();
  collector.observe(makeFailEvent("test1", "/root/test/a.test.ts", null));
  const collection = collector.complete("/root");
  assert.equal(collection.tests[0]!.error, null);
});

test("TestResultCollector: pass entry has null error", () => {
  const collector = createTestResultCollector();
  collector.observe(makePassEvent("test1", "/root/test/a.test.ts"));
  const collection = collector.complete("/root");
  assert.equal(collection.tests[0]!.error, null);
});

test("writeTestResultCollection: writes JSON to file", () => {
  const tmpDir = createTempDir("test-result-write-");
  try {
    const collector = createTestResultCollector();
    collector.observe(makePassEvent("test1", "/root/test/a.test.ts"));
    const collection = collector.complete("/root");
    const filePath = writeTestResultCollection(collection, tmpDir, "state/results.json");
    assert.ok(existsSync(filePath));
    const content = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(content);
    assert.equal(parsed.schemaVersion, TEST_RESULT_COLLECTION_SCHEMA_VERSION);
    assert.equal(parsed.summary.total, 1);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("writeTestResultCollection: creates parent directories", () => {
  const tmpDir = createTempDir("test-result-mkdir-");
  try {
    const collector = createTestResultCollector();
    const collection = collector.complete(tmpDir);
    const filePath = writeTestResultCollection(collection, tmpDir, "deep/nested/dir/results.json");
    assert.ok(existsSync(filePath));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("writeTestResultCollection: default path writes to.bridlewise/state/test-results/latest-collection.json", () => {
  const tmpDir = createTempDir("test-result-default-");
  try {
    const collector = createTestResultCollector();
    const collection = collector.complete(tmpDir);
    const filePath = writeTestResultCollection(collection, tmpDir);
    assert.equal(filePath, resolve(tmpDir, TEST_RESULT_COLLECTION_PATH));
    assert.ok(existsSync(filePath));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("writeTestResultCollection: absolute path is used directly", () => {
  const tmpDir = createTempDir("test-result-abs-");
  try {
    const collector = createTestResultCollector();
    const collection = collector.complete(tmpDir);
    const absPath = join(tmpDir, "custom.json");
    const filePath = writeTestResultCollection(collection, tmpDir, absPath);
    assert.equal(filePath, absPath);
    assert.ok(existsSync(filePath));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("test result collection and test run summary paths are distinct", () => {
  assert.notEqual(TEST_RESULT_COLLECTION_PATH, TEST_RUN_SUMMARY_PATH);
  assert.equal(TEST_RESULT_COLLECTION_PATH, `${TEST_RESULT_COLLECTION_DIRECTORY}/latest-collection.json`);
  assert.equal(TEST_RUN_SUMMARY_PATH, `${TEST_RESULT_COLLECTION_DIRECTORY}/latest-summary.json`);
});

test("writeTestRunSummary: default path writes to.bridlewise/state/test-results/latest-summary.json", () => {
  const tmpDir = createTempDir("test-run-summary-default-");
  try {
    const filePath = writeTestRunSummary(tmpDir, {
      resultIntegrityHash: "a".repeat(64),
      deterministicHash: "b".repeat(64),
      status: "passed",
      exitCode: 0,
      failures: [],
      failureMessages: {},
      reasons: [],
      testCount: 3,
      passCount: 3,
      failCount: 0,
    });
    assert.equal(filePath, resolve(tmpDir, TEST_RUN_SUMMARY_PATH));
    assert.ok(existsSync(filePath));
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(parsed.schemaVersion, TEST_RUN_SUMMARY_SCHEMA_VERSION);
    assert.equal(parsed.testCount, 3);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("writeTestRunSummary: each failure's message is kept by its identity, redacted as it is written (#149)", () => {
  const tmpDir = createTempDir("test-run-summary-messages-");
  try {
    const identity = "test/a.test.ts::refuses a stale pin";
    const filePath = writeTestRunSummary(tmpDir, {
      resultIntegrityHash: "a".repeat(64),
      deterministicHash: "b".repeat(64),
      status: "failed",
      exitCode: 1,
      failures: [identity],
      failureMessages: { [identity]: 'AssertionError: expected the pin to refuse\npassword = "sensitive44word"' },
      reasons: [],
      testCount: 3,
      passCount: 2,
      failCount: 1,
    });
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { failureMessages: Record<string, string> };
    const message = parsed.failureMessages[identity]!;
    assert.match(message, /^AssertionError: expected the pin to refuse/u, "the message is kept, so the red is diagnosable from the summary");
    assert.doesNotMatch(message, /sensitive44word/u, "a credential in a message never reaches the summary");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("writeTestResultCollection: content is canonical JSON with trailing newline", () => {
  const tmpDir = createTempDir("test-result-canonical-");
  try {
    const collector = createTestResultCollector();
    collector.observe(makePassEvent("test1", "/root/test/a.test.ts"));
    const collection = collector.complete("/root");
    const filePath = writeTestResultCollection(collection, tmpDir, "r.json");
    const content = readFileSync(filePath, "utf8");
    assert.ok(content.endsWith("\n"));
    assert.equal(content, `${canonicalJson(collection)}\n`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("parseTestResultCollection: valid collection parses correctly", () => {
  const collector = createTestResultCollector();
  collector.observe(makePassEvent("test1", "/root/test/a.test.ts"));
  const collection = collector.complete("/root");
  const parsed = parseTestResultCollection(JSON.parse(canonicalJson(collection)));
  assert.equal(parsed.schemaVersion, collection.schemaVersion);
  assert.equal(parsed.summary.total, collection.summary.total);
});

test("parseTestResultCollection: invalid schema version throws", () => {
  const collector = createTestResultCollector();
  const collection = collector.complete("/root");
  const raw = JSON.parse(canonicalJson(collection));
  raw.schemaVersion = "wrong";
  assert.throws(() => parseTestResultCollection(raw), /schema version/);
});

test("parseTestResultCollection: missing integrity hash throws", () => {
  const collector = createTestResultCollector();
  const collection = collector.complete("/root");
  const raw = JSON.parse(canonicalJson(collection));
  delete raw.integrityHash;
  assert.throws(() => parseTestResultCollection(raw), /integrity hash/);
});

test("parseTestResultCollection: tampered integrity hash throws", () => {
  const collector = createTestResultCollector();
  collector.observe(makePassEvent("test1", "/root/test/a.test.ts"));
  const collection = collector.complete("/root");
  const raw = JSON.parse(canonicalJson(collection));
  raw.integrityHash = "0000000000000000000000000000000000000000000000000000000000000000";
  assert.throws(() => parseTestResultCollection(raw), /integrity is invalid/);
});

test("parseTestResultCollection: non-object throws", () => {
  assert.throws(() => parseTestResultCollection(null), /must be an object/);
  assert.throws(() => parseTestResultCollection("string"), /must be an object/);
  assert.throws(() => parseTestResultCollection(42), /must be an object/);
  assert.throws(() => parseTestResultCollection(undefined), /must be an object/);
});

test("collectTestResults: throws on empty root", async () => {
  await assert.rejects(() => collectTestResults(""), /root must be/);
});

test("collectTestResults: throws on empty files array", async () => {
  const tmpDir = createTempDir("test-result-empty-files-");
  try {
    await assert.rejects(() => collectTestResults(tmpDir, { files: [] }), /files must be/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("collectTestResults: inventoryBinding cannot be combined with an explicit files list", async () => {
  const tmpDir = createTempDir("test-result-binding-files-");
  try {
    await assert.rejects(
      () => collectTestResults(tmpDir, { files: ["a.test.ts"], inventoryBinding: true }),
      /inventoryBinding cannot be combined/,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("collectTestResults: inventoryBinding fails when the inventory is unavailable", async () => {
  const tmpDir = createTempDir("test-result-binding-missing-");
  try {
    await assert.rejects(
      () => collectTestResults(tmpDir, { inventoryBinding: true }),
      /test inventory is unavailable/,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("TestResultCollector: determinism - same events produce same collection", () => {
  const events = [
    makePassEvent("test1", "/root/test/a.test.ts", 10),
    makeFailEvent("test2", "/root/test/b.test.ts", new Error("e"), 20),
    makeCancelEvent("test3", "/root/test/c.test.ts"),
  ];
  const collector1 = createTestResultCollector();
  const collector2 = createTestResultCollector();
  for (const event of events) {
    collector1.observe(event);
    collector2.observe(event);
  }
  const collection1 = collector1.complete("/root");
  const collection2 = collector2.complete("/root");
  assert.deepEqual(
    { ...collection1, generatedAt: "T", integrityHash: "H" },
    { ...collection2, generatedAt: "T", integrityHash: "H" },
  );
});

test("TestResultCollector: deterministicHash is identical across runs with same tests but different durations/timestamps", () => {
  const collector1 = createTestResultCollector();
  const collector2 = createTestResultCollector();
  // Same test names/files/statuses but DIFFERENT durations — deterministicHash
  // must exclude durations and timestamps.
  collector1.observe(makePassEvent("test1", "/root/test/a.test.ts", 10));
  collector1.observe(makeFailEvent("test2", "/root/test/b.test.ts", new Error("boom"), 20));
  collector2.observe(makePassEvent("test1", "/root/test/a.test.ts", 999));
  collector2.observe(makeFailEvent("test2", "/root/test/b.test.ts", new Error("boom"), 888));
  const collection1 = collector1.complete("/root");
  const collection2 = collector2.complete("/root");
  assert.equal(collection1.deterministicHash, collection2.deterministicHash);
  // integrityHash differs because generatedAt and durations differ.
  assert.notEqual(collection1.integrityHash, collection2.integrityHash);
});

test("TestResultCollector: deterministicHash differs when test status changes", () => {
  const collectorPass = createTestResultCollector();
  const collectorFail = createTestResultCollector();
  collectorPass.observe(makePassEvent("test1", "/root/test/a.test.ts", 10));
  collectorFail.observe(makeFailEvent("test1", "/root/test/a.test.ts", new Error("fail"), 10));
  const passCollection = collectorPass.complete("/root");
  const failCollection = collectorFail.complete("/root");
  assert.notEqual(passCollection.deterministicHash, failCollection.deterministicHash);
});

test("TestResultCollector: 50 pass events produce 50 entries", () => {
  const collector = createTestResultCollector();
  for (let i = 0; i < 50; i++) {
    collector.observe(makePassEvent(`test-${i}`, "/root/test/a.test.ts", i));
  }
  const collection = collector.complete("/root");
  assert.equal(collection.summary.total, 50);
  assert.equal(collection.summary.passed, 50);
});

test("TestResultCollector: 100 mixed events produce correct counts", () => {
  const collector = createTestResultCollector();
  for (let i = 0; i < 100; i++) {
    if (i % 5 === 0) collector.observe(makeFailEvent(`fail-${i}`, "/root/test/a.test.ts", new Error(`e${i}`)));
    else collector.observe(makePassEvent(`pass-${i}`, "/root/test/a.test.ts", i));
  }
  const collection = collector.complete("/root");
  assert.equal(collection.summary.total, 100);
  assert.equal(collection.summary.failed, 20);
  assert.equal(collection.summary.passed, 80);
});
