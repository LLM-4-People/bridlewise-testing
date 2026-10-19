import assert from "node:assert/strict";
import test from "node:test";

import {
  isExperimentPath,
  shouldExcludeExperiment,
  experimentsIncluded,
  matchSegment,
  experimentSourcePatterns,
  EXPERIMENT_INCLUDE_ENV_VAR,
  EXPERIMENT_SCAN_ROOTS,
  shouldRejectHardlinks,
  shouldRejectSymlinks,
} from "../../src/shared/source-scan.ts";

/**
 * Unit tests for the experiment-source exclusion helper (`src/shared/source-scan.ts`).
 *
 * The critical invariant is that the first-segment match distinguishes a
 * top-level experiment directory from a nested production directory that
 * happens to share a name — specifically `src/unified/` (experiment) vs
 * `src/memory/unified/` (production). A bare directory-name check would
 * wrongly exclude the production code; the segment check must not.
 *
 * Also covers the opt-in env var, glob semantics (`*` stays within a
 * segment), and improper/unknown inputs that should NOT trigger exclusion.
 */

const ORIG_ENV = process.env[EXPERIMENT_INCLUDE_ENV_VAR];

function restoreEnv(): void {
  if (ORIG_ENV === undefined) delete process.env[EXPERIMENT_INCLUDE_ENV_VAR];
  else process.env[EXPERIMENT_INCLUDE_ENV_VAR] = ORIG_ENV;
}

test("source-scan: experimentSourcePatterns returns the configured list", () => {
  const patterns = experimentSourcePatterns();
  assert.ok(Array.isArray(patterns), "patterns must be an array");
  assert.ok(patterns.includes("exp*"), "must include the exp* glob");
  assert.ok(patterns.includes("unified"), "must include unified");
  assert.ok(patterns.includes("auto-learning"), "must include auto-learning");
  assert.ok(patterns.includes("llm-beyond-max"), "must include llm-beyond-max");
});

test("source-scan: EXPERIMENT_SCAN_ROOTS covers src/ and test/", () => {
  assert.ok(EXPERIMENT_SCAN_ROOTS.includes("src/"));
  assert.ok(EXPERIMENT_SCAN_ROOTS.includes("test/"));
  assert.ok(EXPERIMENT_SCAN_ROOTS.includes("_experiments/"));
});

test("source-scan: matchSegment — `*` matches within a segment, never crosses `/`", () => {
  assert.equal(matchSegment("exp420", "exp*"), true);
  assert.equal(matchSegment("exp450", "exp*"), true);
  assert.equal(matchSegment("exp", "exp*"), true);
  assert.equal(matchSegment("memory", "exp*"), false, "memory must not match exp*");
  assert.equal(matchSegment("unified", "unified"), true);
  assert.equal(matchSegment("Unified", "unified"), false, "match is case-sensitive");
  assert.equal(matchSegment("auto-learning", "auto-learning"), true);
  assert.equal(matchSegment("llm-beyond-max", "llm-beyond-max"), true);
  assert.equal(matchSegment("exp420/sub", "exp*"), false, "the segment input has no slash; exp* must not match a slash");
  assert.equal(matchSegment("", "exp*"), false, "empty name must not match exp*");
  assert.equal(matchSegment("anything", "*"), true, "bare * matches any non-empty? actually matches empty too");
  assert.equal(matchSegment("", "*"), true, "bare * matches empty (.* )");
});

test("source-scan: isExperimentPath — CRITICAL src/unified vs src/memory/unified distinction", () => {
  // Experiment source dirs (top-level under src/) — EXCLUDED.
  assert.equal(isExperimentPath("src/unified/config.ts"), true, "src/unified/ is experiment");
  assert.equal(isExperimentPath("src/unified/awareness/engine.ts"), true);
  // Production nested dir sharing the name — KEPT.
  assert.equal(isExperimentPath("src/memory/unified/index.ts"), false, "src/memory/unified/ is PRODUCTION");
  assert.equal(isExperimentPath("src/memory/unified/unified-config.ts"), false);
});

test("source-scan: isExperimentPath — all known experiment dirs excluded", () => {
  for (const p of [
    "src/exp420/index.ts",
    "src/exp450/unified-harness.ts",
    "src/exp464/extended-harness.ts",
    "src/exp438/x.ts",
    "src/exp473/x.ts",
    "src/auto-learning/index.ts",
    "src/llm-beyond-max/client.ts",
  ]) {
    assert.equal(isExperimentPath(p), true, `${p} must be an experiment path`);
  }
});

test("source-scan: isExperimentPath — production paths kept", () => {
  for (const p of [
    "src/config-contracts.ts",
    "src/root-policy.ts",
    "src/shared/source-scan.ts",
    "src/errors.ts",
    "src/workflow/module-registrar.ts",
    "scripts/test-inventory.ts",
    "verification/evidence.ts",
    "src/memory/memory-store.ts",
  ]) {
    assert.equal(isExperimentPath(p), false, `${p} must NOT be an experiment path`);
  }
});

test("source-scan: isExperimentPath — test/ experiment dirs excluded, test/ production kept", () => {
  assert.equal(isExperimentPath("test/exp420/exp420.test.ts"), true);
  assert.equal(isExperimentPath("test/exp450/exp450-unified.test.ts"), true);
  assert.equal(isExperimentPath("test/auto-learning/cusum-conflation.test.ts"), true);
  assert.equal(isExperimentPath("test/llm-beyond-max/unit.test.ts"), true);
  // Production tests under test/memory/unified/ — KEPT.
  assert.equal(isExperimentPath("test/memory/unified/unified.test.ts"), false, "test/memory/unified/ is production");
  assert.equal(isExperimentPath("test/prevention/no-generic-errors.test.ts"), false);
});

test("source-scan: isExperimentPath — unknown/empty patterns keep everything", () => {
  // Patterns come from config; if the config list were empty, nothing is excluded.
  // We verify the guard by passing a path that doesn't sit under a scan root.
  assert.equal(isExperimentPath("docs/research/x.md"), false, "non-scan-root paths are never experiments");
  assert.equal(isExperimentPath(""), false, "empty path is not an experiment");
  assert.equal(isExperimentPath("src"), false, "bare src root (no subdir) is not an experiment");
});

test("source-scan: shouldExcludeExperiment respects the opt-in env var", () => {
  delete process.env[EXPERIMENT_INCLUDE_ENV_VAR];
  assert.equal(experimentsIncluded(), false, "unset => not included");
  assert.equal(shouldExcludeExperiment("src/exp420/x.ts"), true, "unset => excluded");

  process.env[EXPERIMENT_INCLUDE_ENV_VAR] = "1";
  assert.equal(experimentsIncluded(), true, "1 => included");
  assert.equal(shouldExcludeExperiment("src/exp420/x.ts"), false, "1 => not excluded");
  assert.equal(shouldExcludeExperiment("src/memory/unified/x.ts"), false, "production never excluded even with opt-in");

  process.env[EXPERIMENT_INCLUDE_ENV_VAR] = "true";
  assert.equal(experimentsIncluded(), true, "true => included");
  assert.equal(shouldExcludeExperiment("src/exp420/x.ts"), false, "true => not excluded");

  process.env[EXPERIMENT_INCLUDE_ENV_VAR] = "TRUE";
  assert.equal(experimentsIncluded(), true, "TRUE (case-insensitive) => included");

  process.env[EXPERIMENT_INCLUDE_ENV_VAR] = "0";
  assert.equal(experimentsIncluded(), false, "0 => not included");
  assert.equal(shouldExcludeExperiment("src/exp420/x.ts"), true, "0 => excluded");

  process.env[EXPERIMENT_INCLUDE_ENV_VAR] = "false";
  assert.equal(experimentsIncluded(), false, "false => not included");

  process.env[EXPERIMENT_INCLUDE_ENV_VAR] = "random";
  assert.equal(experimentsIncluded(), false, "unrecognized => not included");

  restoreEnv();
});

test("source-scan: shouldExcludeExperiment does not exclude production even when opt-out", () => {
  delete process.env[EXPERIMENT_INCLUDE_ENV_VAR];
  // The headline safety property: production code is never excluded.
  assert.equal(shouldExcludeExperiment("src/memory/unified/index.ts"), false);
  assert.equal(shouldExcludeExperiment("src/errors.ts"), false);
  assert.equal(shouldExcludeExperiment("test/memory/unified/unified.test.ts"), false);
  restoreEnv();
});

test("source-scan: isExperimentPath — _experiments/ relocated source excluded", () => {
  // After exp477 the experiment source physically lives under _experiments/.
  // The first-segment match (under the _experiments/ scan root) excludes each
  // experiment subdir while keeping the root itself non-excluded.
  for (const p of [
    "_experiments/exp420/index.ts",
    "_experiments/exp450/unified-harness.ts",
    "_experiments/exp464/extended-harness.ts",
    "_experiments/auto-learning/index.ts",
    "_experiments/llm-beyond-max/client.ts",
    "_experiments/unified/config.ts",
  ]) {
    assert.equal(isExperimentPath(p), true, `${p} must be an experiment path`);
  }
  // The _experiments/ root directory itself is not a file path with a matching
  // subdir; it must not be flagged (it is pruned by repositoryScanExclusions).
  assert.equal(isExperimentPath("_experiments"), false, "bare _experiments root is not an experiment path");
});

test("source-scan: shouldExcludeExperiment — _experiments/ respects opt-in", () => {
  delete process.env[EXPERIMENT_INCLUDE_ENV_VAR];
  assert.equal(shouldExcludeExperiment("_experiments/exp420/x.ts"), true, "excluded by default");
  process.env[EXPERIMENT_INCLUDE_ENV_VAR] = "1";
  assert.equal(shouldExcludeExperiment("_experiments/exp420/x.ts"), false, "opt-in re-includes");
  assert.equal(shouldExcludeExperiment("_experiments/unified/x.ts"), false, "opt-in re-includes unified");
  restoreEnv();
});

test("source-scan: custom scanRoots are honoured", () => {
  // Restricting to only src/ still excludes src/exp420 but the helper does not
  // look under test/ when test/ is not in the provided roots.
  assert.equal(isExperimentPath("src/exp420/x.ts", ["src/"]), true);
  assert.equal(isExperimentPath("test/exp420/x.ts", ["src/"]), false, "test/ not in roots => not an experiment");
  assert.equal(isExperimentPath("src/memory/unified/x.ts", ["src/"]), false);
});

test("source-scan: shouldRejectHardlinks honours HARNESS_REJECT_HARDLINKS env var", () => {
  const prev = process.env.HARNESS_REJECT_HARDLINKS;
  try {
    process.env.HARNESS_REJECT_HARDLINKS = "0";
    assert.equal(shouldRejectHardlinks(), false, "0 disables rejection");
    process.env.HARNESS_REJECT_HARDLINKS = "1";
    assert.equal(shouldRejectHardlinks(), true, "1 enables rejection");
    process.env.HARNESS_REJECT_HARDLINKS = "false";
    assert.equal(shouldRejectHardlinks(), false, "false disables rejection");
    process.env.HARNESS_REJECT_HARDLINKS = "true";
    assert.equal(shouldRejectHardlinks(), true, "true enables rejection");
  } finally {
    if (prev === undefined) delete process.env.HARNESS_REJECT_HARDLINKS;
    else process.env.HARNESS_REJECT_HARDLINKS = prev;
  }
});

test("source-scan: shouldRejectSymlinks honours HARNESS_REJECT_SYMLINKS env var", () => {
  const prev = process.env.HARNESS_REJECT_SYMLINKS;
  try {
    process.env.HARNESS_REJECT_SYMLINKS = "0";
    assert.equal(shouldRejectSymlinks(), false, "0 disables rejection (dev mode)");
    process.env.HARNESS_REJECT_SYMLINKS = "1";
    assert.equal(shouldRejectSymlinks(), true, "1 enables rejection (production floor)");
    process.env.HARNESS_REJECT_SYMLINKS = "false";
    assert.equal(shouldRejectSymlinks(), false, "false disables rejection");
    process.env.HARNESS_REJECT_SYMLINKS = "true";
    assert.equal(shouldRejectSymlinks(), true, "true enables rejection");
  } finally {
    if (prev === undefined) delete process.env.HARNESS_REJECT_SYMLINKS;
    else process.env.HARNESS_REJECT_SYMLINKS = prev;
  }
});
