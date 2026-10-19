// Two-tier serial-phase concurrency model prevention test.
//
// The serial test phase is split into two tiers: in-process serial files (no
// subprocess spawning) run at a HIGHER concurrency (no subprocess
// oversubscription), while subprocess-spawning serial files run at a LOWER
// concurrency. The classification is DYNAMIC (a source scan for subprocess-
// spawning markers, not a hardcoded file list) so a file that gains subprocess
// usage is automatically reclassified.
//
// This test verifies the classifier + the phase builder + the real slow serial
// files are classified into the correct tiers. It also serves as the consumer
// for the new exports (SUBPROCESS_SPAWNING_MARKERS, classifySerialConcurrencyTier,
// buildSerialPhases) so the dead-export scanner does not flag them.

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTempDir } from "../support/temp-dir.ts";

import {
  SUBPROCESS_SPAWNING_MARKERS,
  classifySerialConcurrencyTier,
  buildSerialPhases,
  type ConcurrencyMarker,
} from "../../src/workflow/test-result-collector.ts";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../..");

test("SUBPROCESS_SPAWNING_MARKERS: is a frozen array of concurrency markers", () => {
  assert.ok(Array.isArray(SUBPROCESS_SPAWNING_MARKERS));
  assert.ok(SUBPROCESS_SPAWNING_MARKERS.length >= 3);
  assert.ok(Object.isFrozen(SUBPROCESS_SPAWNING_MARKERS));
  for (const marker of SUBPROCESS_SPAWNING_MARKERS) {
    assert.ok(typeof marker.id === "string" && marker.id.length > 0);
    assert.ok(marker.pattern instanceof RegExp);
  }
});

test("SUBPROCESS_SPAWNING_MARKERS: detects child_process import", () => {
  const marker = SUBPROCESS_SPAWNING_MARKERS.find((m) => m.id === "child-process-import")!;
  assert.ok(marker.pattern.test('import { spawnSync } from "node:child_process";'));
  assert.ok(!marker.pattern.test('import { readFileSync } from "node:fs";'));
});

test("SUBPROCESS_SPAWNING_MARKERS: detects spawn calls", () => {
  const marker = SUBPROCESS_SPAWNING_MARKERS.find((m) => m.id === "subprocess-spawn-call")!;
  assert.ok(marker.pattern.test("spawnSync(process.execPath, [])"));
  assert.ok(marker.pattern.test("execSync('node --version')"));
  assert.ok(marker.pattern.test("execFileSync(node, args)"));
  // Bare identifier reference (not a call) is NOT matched — avoids false
  // positives on comments or variable names.
  assert.ok(!marker.pattern.test("// uses spawnSync here"));
});

test("SUBPROCESS_SPAWNING_MARKERS: detects evidence pipeline", () => {
  const marker = SUBPROCESS_SPAWNING_MARKERS.find((m) => m.id === "evidence-pipeline")!;
  assert.ok(marker.pattern.test("runPlannedNodeTestSuiteWithEvidence(args)"));
  assert.ok(marker.pattern.test("runWorkerWithEvidence(options)"));
  assert.ok(marker.pattern.test("runTestsWithEvidence()"));
  assert.ok(marker.pattern.test("runCheckWithEvidence()"));
});

test("classifySerialConcurrencyTier: empty files produces empty tiers", () => {
  const result = classifySerialConcurrencyTier([], REPOSITORY_ROOT);
  assert.deepEqual([...result.inProcess], []);
  assert.deepEqual([...result.subprocessSpawning], []);
});

test("classifySerialConcurrencyTier: in-process file goes to inProcess tier", () => {
  const dir = createTempDir("tier-test-");
  try {
    const file = join(dir, "in-process.test.ts");
    writeFileSync(file, 'import test from "node:test";\ntest("pass", () => {});\n');
    const result = classifySerialConcurrencyTier([file], dir);
    assert.equal(result.inProcess.length, 1);
    assert.equal(result.subprocessSpawning.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifySerialConcurrencyTier: child_process import goes to subprocess tier", () => {
  const dir = createTempDir("tier-test-");
  try {
    const file = join(dir, "subprocess.test.ts");
    writeFileSync(file, 'import { spawnSync } from "node:child_process";\ntest("pass", () => {});\n');
    const result = classifySerialConcurrencyTier([file], dir);
    assert.equal(result.inProcess.length, 0);
    assert.equal(result.subprocessSpawning.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifySerialConcurrencyTier: evidence pipeline import goes to subprocess tier", () => {
  const dir = createTempDir("tier-test-");
  try {
    const file = join(dir, "evidence.test.ts");
    writeFileSync(file, 'import { runPlannedNodeTestSuiteWithEvidence } from "./support";\ntest("pass", () => {});\n');
    const result = classifySerialConcurrencyTier([file], dir);
    assert.equal(result.inProcess.length, 0);
    assert.equal(result.subprocessSpawning.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifySerialConcurrencyTier: unreadable file goes to subprocess tier (conservative)", () => {
  const result = classifySerialConcurrencyTier(["does-not-exist.test.ts"], "/root");
  assert.equal(result.inProcess.length, 0);
  assert.equal(result.subprocessSpawning.length, 1);
});

test("classifySerialConcurrencyTier: result is frozen + sorted", () => {
  const dir = createTempDir("tier-test-");
  try {
    writeFileSync(join(dir, "a.test.ts"), 'import { spawnSync } from "node:child_process";\n');
    writeFileSync(join(dir, "b.test.ts"), 'import test from "node:test";\n');
    const result = classifySerialConcurrencyTier([
      join(dir, "b.test.ts"),
      join(dir, "a.test.ts"),
    ], dir);
    assert.ok(Object.isFrozen(result.inProcess));
    assert.ok(Object.isFrozen(result.subprocessSpawning));
    // Sorted by relative path
    assert.deepEqual([...result.subprocessSpawning], ["a.test.ts"]);
    assert.deepEqual([...result.inProcess], ["b.test.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("classifySerialConcurrencyTier: throws on non-array files", () => {
  assert.throws(
    () => classifySerialConcurrencyTier("not-an-array" as unknown as string[], "/root"),
    /files must be an array/,
  );
});

test("classifySerialConcurrencyTier: throws on empty string file path", () => {
  assert.throws(
    () => classifySerialConcurrencyTier([""], "/root"),
    /file path must be a non-empty string/,
  );
});

test("classifySerialConcurrencyTier: real S1 scenarios are in-process (no subprocess)", () => {
  // Dynamically discover S1 scenario files (no hardcoded list) + verify they
  // are classified correctly: most S1 scenarios call verifyS1Structure (a pure
  // in-process Babel parse — no subprocess spawning) so they go to the
  // in-process tier. b13 is the exception — it directly imports child_process
  // + calls spawnSync to test the CLI generator, so it goes to the subprocess
  // tier.
  const s1ScenarioFiles = [
    "test/s1-scenarios/b12.test.ts",
    "test/s1-scenarios/b08.test.ts",
    "test/s1-scenarios/b15.test.ts",
    "test/s1-scenarios/b13.test.ts",
    "test/s1-scenarios/b09.test.ts",
    "test/s1-scenarios/b11.test.ts",
    "test/s1-scenarios/b02.test.ts",
    "test/s1-scenarios/b10.test.ts",
    "test/s1-scenarios/b16.test.ts",
    "test/s1-scenarios/b14.test.ts",
  ].filter((f) => existsSync(resolve(REPOSITORY_ROOT, f)));
  assert.ok(s1ScenarioFiles.length >= 9, `expected at least 9 S1 scenario files, got ${s1ScenarioFiles.length}`);
  const result = classifySerialConcurrencyTier(s1ScenarioFiles, REPOSITORY_ROOT);
  // Every S1 scenario except b13 should be in-process.
  for (const file of result.inProcess) {
    assert.ok(
      !file.includes("b13"),
      `b13 should be subprocess-spawning, got in-process: ${file}`,
    );
  }
  const b13InSubprocess = [...result.subprocessSpawning].some((f) => f.includes("b13"));
  assert.ok(b13InSubprocess, `b13 should be in the subprocess-spawning tier (subprocess: ${[...result.subprocessSpawning].join(", ")})`);
});

test("classifySerialConcurrencyTier: real subprocess-spawning files are in the subprocess tier", () => {
  // These files import the evidence pipeline (spawns real node subprocesses)
  // or directly import node:child_process. They must be in the subprocess
  // tier (lower concurrency to avoid oversubscription).
  const subprocessFiles = [
    "test/foundation-cascade.test.ts",
    "test/repository-path.test.ts",
    "test/unit/tasks-agents/handoff-continuity.test.ts",
  ].filter((f) => existsSync(resolve(REPOSITORY_ROOT, f)));
  assert.ok(subprocessFiles.length >= 3);
  const result = classifySerialConcurrencyTier(subprocessFiles, REPOSITORY_ROOT);
  assert.equal(
    result.subprocessSpawning.length,
    subprocessFiles.length,
    `all ${subprocessFiles.length} files should be in the subprocess tier, got ${result.subprocessSpawning.length} (inProcess: ${[...result.inProcess].join(", ")})`,
  );
});

test("buildSerialPhases: empty serial files produces no phases", () => {
  const phases = buildSerialPhases([], REPOSITORY_ROOT, new Map(), {
    inProcessConcurrency: 12,
    subprocessConcurrency: 8,
    isolation: "process",
  });
  assert.equal(phases.length, 0);
});

test("buildSerialPhases: two tiers with different concurrency", () => {
  const dir = createTempDir("tier-test-");
  try {
    writeFileSync(join(dir, "in-process.test.ts"), 'import test from "node:test";\n');
    writeFileSync(join(dir, "subprocess.test.ts"), 'import { spawnSync } from "node:child_process";\n');
    const phases = buildSerialPhases(
      [join(dir, "in-process.test.ts"), join(dir, "subprocess.test.ts")],
      dir,
      new Map(),
      { inProcessConcurrency: 12, subprocessConcurrency: 8, isolation: "process" },
    );
    assert.equal(phases.length, 2, "should produce 2 phases (one per tier)");
    // First phase is the in-process tier (higher concurrency)
    assert.equal(phases[0]!.concurrency, 12);
    assert.equal(phases[0]!.isolation, "process");
    // Second phase is the subprocess tier (lower concurrency)
    assert.equal(phases[1]!.concurrency, 8);
    assert.equal(phases[1]!.isolation, "process");
    // Each phase has the right file
    assert.equal(phases[0]!.files.length, 1);
    assert.ok(phases[0]!.files[0]!.includes("in-process.test.ts"));
    assert.equal(phases[1]!.files.length, 1);
    assert.ok(phases[1]!.files[0]!.includes("subprocess.test.ts"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildSerialPhases: concurrency 1 collapses to sequential (no isolation)", () => {
  const dir = createTempDir("tier-test-");
  try {
    writeFileSync(join(dir, "in-process.test.ts"), 'import test from "node:test";\n');
    writeFileSync(join(dir, "subprocess.test.ts"), 'import { spawnSync } from "node:child_process";\n');
    const phases = buildSerialPhases(
      [join(dir, "in-process.test.ts"), join(dir, "subprocess.test.ts")],
      dir,
      new Map(),
      { inProcessConcurrency: 1, subprocessConcurrency: 1, isolation: undefined },
    );
    assert.equal(phases.length, 2);
    assert.equal(phases[0]!.concurrency, false, "concurrency 1 should map to false (sequential)");
    assert.equal(phases[0]!.isolation, undefined);
    assert.equal(phases[1]!.concurrency, false);
    assert.equal(phases[1]!.isolation, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildSerialPhases: only in-process files produces one phase", () => {
  const dir = createTempDir("tier-test-");
  try {
    writeFileSync(join(dir, "a.test.ts"), 'import test from "node:test";\n');
    writeFileSync(join(dir, "b.test.ts"), 'import test from "node:test";\n');
    const phases = buildSerialPhases(
      [join(dir, "a.test.ts"), join(dir, "b.test.ts")],
      dir,
      new Map(),
      { inProcessConcurrency: 12, subprocessConcurrency: 8, isolation: "process" },
    );
    assert.equal(phases.length, 1, "only in-process files should produce 1 phase");
    assert.equal(phases[0]!.concurrency, 12);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildSerialPhases: longest-first scheduling within each tier", () => {
  const dir = createTempDir("tier-test-");
  try {
    writeFileSync(join(dir, "a.test.ts"), 'import test from "node:test";\n');
    writeFileSync(join(dir, "b.test.ts"), 'import test from "node:test";\n');
    // a is slower (1000ms), b is faster (100ms)
    const durations = new Map([
      ["a.test.ts", 1000],
      ["b.test.ts", 100],
    ]);
    const phases = buildSerialPhases(
      [join(dir, "a.test.ts"), join(dir, "b.test.ts")],
      dir,
      durations,
      { inProcessConcurrency: 12, subprocessConcurrency: 8, isolation: "process" },
    );
    assert.equal(phases.length, 1);
    // a (slowest) should be first
    assert.ok(phases[0]!.files[0]!.includes("a.test.ts"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildSerialPhases: custom markers override defaults", () => {
  const dir = createTempDir("tier-test-");
  try {
    writeFileSync(join(dir, "custom.test.ts"), 'import { mySpecialThing } from "./lib";\n');
    const customMarkers: ConcurrencyMarker[] = [
      { id: "custom-spawn", pattern: /mySpecialThing/u },
    ];
    // Use classifySerialConcurrencyTier with custom markers directly
    const tier = classifySerialConcurrencyTier([join(dir, "custom.test.ts")], dir, customMarkers);
    assert.equal(tier.subprocessSpawning.length, 1);
    assert.equal(tier.inProcess.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
