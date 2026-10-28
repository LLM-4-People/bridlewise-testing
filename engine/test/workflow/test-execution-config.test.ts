import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { readTestExecutionConfig, collectTestResults, resolveDefaultParallelConcurrency } from "../../src/workflow/test-result-collector.ts";
import { harnessTest } from "../../src/workflow/harness-commands.ts";
import { createRepositoryWorkingCopy, removeRepositoryLocalTemporaryDirectory } from "../support/repository-local-temporary.ts";
import { createTempDir } from "../support/temp-dir.ts";

const ROOT = process.cwd();

test("readTestExecutionConfig: returns the pinned config's testExecution for the repository root", () => {
  // bridlewise.config.json declares:
  // "testExecution": { "concurrency": "auto", … }
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

test("readTestExecutionConfig: a FOREIGN root is answered from the defaults without bootstrapping this checkout's pinned document", () => {
  // Driven in a WORKING COPY whose own document is refused: a second
  // `*.config.json` planted beside it is the alternate document the pinned
  // bootstrap refuses. If a foreign-root answer still bootstraps the pinned
  // document, it inherits that refusal — the measured defect: the web budget
  // reporter drove a fixture repository, the live `engine/` folder was moved
  // by an unrelated concurrent write, and the foreign-root question failed
  // with `config_parent_changed` ("THE GATE COULD NOT RUN") although its
  // answer is the defaults. Answered from the defaults, it cannot.
  const copy = createRepositoryWorkingCopy("foreign-root-config-", {
    include: (path) => path.startsWith("engine/src/") || path.startsWith("shared/") ||
      path === `engine/${ROOT_POLICY.configuration.basename}` || path === "engine/package.json",
  });
  try {
    writeFileSync(join(copy.engineRoot, "stray-copy.config.json"), "{}\n", { mode: 0o600 });
    const moduleUrl = pathToFileURL(join(copy.engineRoot, "src", "workflow", "test-result-collector.ts")).href;
    const probe = spawnSync(process.execPath, ["--input-type=module", "-e", [
      `const { readTestExecutionConfig } = await import(${JSON.stringify(moduleUrl)});`,
      `const answer = (root) => { try { const config = readTestExecutionConfig(root); return "defaults:" + String(config.concurrency === undefined); } catch (error) { return "refused:" + String(error?.code ?? error); } };`,
      `process.stdout.write(JSON.stringify({ foreign: answer(${JSON.stringify(join(copy.root, "elsewhere"))}), own: answer(${JSON.stringify(copy.engineRoot)}) }));`,
    ].join("\n")], { encoding: "utf8", timeout: 120_000 });
    assert.equal(probe.status, 0, probe.stderr);
    assert.deepEqual(JSON.parse(probe.stdout), {
      // A root this checkout does not hold cannot be answered by its document,
      // and must not inherit that document's refusal.
      foreign: "defaults:true",
      // The checkout's OWN root still loads the document: the planted
      // alternate is a finding the caller sees, never a quiet default.
      own: "refused:alternate_config_denied",
    });
  } finally {
    removeRepositoryLocalTemporaryDirectory(copy.root);
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
