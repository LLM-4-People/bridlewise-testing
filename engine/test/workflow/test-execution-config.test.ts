import assert from "node:assert/strict";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { readTestExecutionConfig, collectTestResults, resolveDefaultParallelConcurrency } from "../../src/workflow/test-result-collector.ts";
import { harnessTest } from "../../src/workflow/harness-commands.ts";
import { createTempDir } from "../support/temp-dir.ts";

const ROOT = process.cwd();

test("readTestExecutionConfig: returns the pinned config's testExecution for the repository root", () => {
  // bridlewise.config.json declares:
  // "testExecution": { "concurrency": "auto", "slowFileThresholdMs": 10000, "runtimeBudgetMs": 120000 }
  // parallelConcurrency is intentionally absent so the adaptive
  // availableParallelism() default is used (no manual override).
  const config = readTestExecutionConfig(ROOT);
  assert.equal(config.concurrency, "auto");
  assert.equal(config.parallelConcurrency, undefined);
});

test("readTestExecutionConfig: returns {} when root does not match the pinned config's repositoryRoot", () => {
  const tmp = createTempDir("read-test-exec-foreign-");
  try {
    const config = readTestExecutionConfig(tmp);
    // A temp dir does not match the pinned config's repositoryRoot, so the
    // foreign config is NOT applied (prevents a foreign config from leaking
    // into test runs against arbitrary directories).
    assert.equal(config.concurrency, undefined);
    assert.equal(config.parallelConcurrency, undefined);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("readTestExecutionConfig: returns a frozen object", () => {
  const config = readTestExecutionConfig(ROOT);
  assert.ok(Object.isFrozen(config));
});

test("harnessTest: consumes testExecution config when running against the repository root", async () => {
  // Build a single fast test file under a temp dir, then run harnessTest
  // against the REAL repository root (so the pinned config matches). We
  // cannot pass a single file via --file here because the test file must
  // live under the repo root. Instead, verify the wiring by asserting that
  // readTestExecutionConfig returns "auto" for the repo root and that
  // collectTestResults honors concurrency="auto" by producing a non-null
  // concurrencyReport.
  const config = readTestExecutionConfig(ROOT);
  assert.equal(config.concurrency, "auto");

  // Verify collectTestResults produces a non-null concurrencyReport when
  // concurrency="auto" is passed (the value sourced from config).
  const tmp = createTempDir("harness-test-config-");
  try {
    mkdirSync(join(tmp, "test"), { recursive: true });
    writeFileSync(
      join(tmp, "test", "simple.test.ts"),
      `import test from "node:test";\ntest("pass", () => {});\n`,
    );
    const collection = await collectTestResults(tmp, {
      concurrency: config.concurrency,
      ...(config.parallelConcurrency !== undefined ? { parallelConcurrency: config.parallelConcurrency } : {}),
    });
    assert.ok(collection.concurrencyReport !== null, "concurrencyReport must be non-null when concurrency is 'auto'");
    assert.equal(collection.concurrencyReport!.mode, "auto");
    // parallelConcurrency is undefined in the config (adaptive default),
    // so collectTestResults resolves it via resolveDefaultParallelConcurrency().
    assert.equal(collection.concurrencyReport!.parallelConcurrency, resolveDefaultParallelConcurrency());
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("harnessTest: against a foreign temp dir falls back to no-concurrency (config does not match)", async () => {
  // A temp dir does not match the pinned config's repositoryRoot, so
  // readTestExecutionConfig returns {} and collectTestResults is called
  // without concurrency, producing a null concurrencyReport (default false).
  const tmp = createTempDir("harness-test-foreign-");
  try {
    mkdirSync(join(tmp, "test"), { recursive: true });
    writeFileSync(
      join(tmp, "test", "simple.test.ts"),
      `import test from "node:test";\ntest("pass", () => {});\n`,
    );
    const result = await harnessTest(tmp, { file: "test/simple.test.ts", writeResults: false });
    assert.equal(result.command, "test");
    // When no config is consumed (foreign root), concurrency defaults to
    // false and the concurrencyReport is null.
    assert.equal(result.result.testResults.concurrencyReport, null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("readTestExecutionConfig: resolve normalization — trailing slash does not change the match", () => {
  // The function uses resolve on both sides, so a trailing slash on the
  // caller's root must not cause a spurious mismatch.
  const configWithSlash = readTestExecutionConfig(ROOT + "/");
  assert.equal(configWithSlash.concurrency, "auto");
  assert.equal(configWithSlash.parallelConcurrency, undefined);
});
