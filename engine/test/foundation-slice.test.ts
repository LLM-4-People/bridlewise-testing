import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { canonicalHash, canonicalJson } from "../src/kernel/integrity.ts";
import {
  FOUNDATION_CASCADE_SCHEMA_VERSION,
  FOUNDATION_COMPILER_REVISION,
  FOUNDATION_GENERATION_LOCK_PATH,
  FOUNDATION_STAGE_REGISTRY,
  FOUNDATION_STAGE_REGISTRY_IDENTITY,
  FOUNDATION_UTF8_ORDERING_RULE,
  compileFoundationPlan,
} from "../verification/core/foundation-cascade.ts";
import {
  FOUNDATION_SLICE_MODES,
  checkFoundation,
  planFoundation,
  recoverFoundation,
  writeFoundation,
} from "../verification/slices/foundation.ts";

const PLAN = planFoundation();
const CHECK = checkFoundation();
const WRITE = writeFoundation();
const RECOVER = recoverFoundation();
const CORE_PLAN = compileFoundationPlan();

const STAGE_NAMES = [
  "validate-authorities",
  "generate-schemas",
  "generate-code-intelligence-policy-lock",
  "generate-test-surface",
  "generate-test-inventory",
  "generate-slice-projections",
  "build-generation-lock",
  "generate-artifact-manifest",
  "publish-and-verify",
] as const;

const STAGE_ORDINALS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

const STAGE_OWNERS = [
  "foundation-authority-validation",
  "foundation-schema-projections",
  "code-intelligence-policy",
  "test-surface",
  "test-inventory",
  "slice-projections",
  "foundation-cascade",
  "artifact-governance",
  "foundation-transaction",
] as const;

const MODE_NAMES = ["plan", "check", "write", "recover"] as const;

function resultFor(mode: string): typeof PLAN {
  if (mode === "plan") return PLAN;
  if (mode === "check") return CHECK;
  if (mode === "write") return WRITE;
  return RECOVER;
}

const CLI_PATH = fileURLToPath(new URL("../scripts/tooling/foundation.ts", import.meta.url));

function runCli(...args: string[]): { exitCode: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [CLI_PATH, ...args], {
      encoding: "utf8",
      timeout: 30000,
    });
    return { exitCode: 0, stdout, stderr: "" };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { exitCode: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

// Cached CLI outputs for the four valid modes. Each runCli spawns a child
// process running the foundation pipeline (~0.7s); the previous version
// spawned ~46 processes for this section. The four mode outputs are
// deterministic, so a single lazy invocation is reused by every assertion.
const cliCache = new Map<string, { exitCode: number; stdout: string; stderr: string }>();
function cachedCli(mode: string): { exitCode: number; stdout: string; stderr: string } {
  let cached = cliCache.get(mode);
  if (cached) return cached;
  cached = runCli(mode);
  cliCache.set(mode, cached);
  return cached;
}

function assertFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value as object)) return;
  seen.add(value as object);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value as object)) assertFrozen(child, seen);
}

test("FS-M001 planFoundation returns mode plan", () => {
  assert.equal(PLAN.mode, "plan");
});

test("FS-M002 planFoundation returns blocked disposition", () => {
  assert.equal(PLAN.disposition, "blocked");
});

test("FS-M003 planFoundation schemaVersion matches core", () => {
  assert.equal(PLAN.schemaVersion, FOUNDATION_CASCADE_SCHEMA_VERSION);
  assert.equal(PLAN.schemaVersion, CORE_PLAN.schemaVersion);
});

test("FS-M004 planFoundation compilerRevision matches core", () => {
  assert.equal(PLAN.compilerRevision, FOUNDATION_COMPILER_REVISION);
  assert.equal(PLAN.compilerRevision, CORE_PLAN.compilerRevision);
});

test("FS-M005 planFoundation planIdentity matches core", () => {
  assert.equal(PLAN.planIdentity, CORE_PLAN.planIdentity);
  assert.match(PLAN.planIdentity, /^[0-9a-f]{64}$/u);
});

test("FS-M006 planFoundation stageRegistryIdentity matches core", () => {
  assert.equal(PLAN.stageRegistryIdentity, FOUNDATION_STAGE_REGISTRY_IDENTITY);
  assert.equal(PLAN.stageRegistryIdentity, CORE_PLAN.stageRegistryIdentity);
});

test("FS-M007 planFoundation rootPolicyIdentity matches core", () => {
  assert.equal(PLAN.rootPolicyIdentity, CORE_PLAN.rootPolicyIdentity);
  assert.match(PLAN.rootPolicyIdentity, /^[0-9a-f]{64}$/u);
});

test("FS-M008 planFoundation activationLockPath is correct", () => {
  assert.equal(PLAN.activationLockPath, FOUNDATION_GENERATION_LOCK_PATH);
  assert.equal(PLAN.activationLockPath, "traceability/generated/foundation-generation.json");
});

test("FS-M009 planFoundation activationLockPresent is false", () => {
  assert.equal(PLAN.activationLockPresent, false);
});

test("FS-M010 planFoundation artifactManifestPath matches core", () => {
  assert.equal(PLAN.artifactManifestPath, CORE_PLAN.artifactManifestPath);
  assert.ok(PLAN.artifactManifestPath.length > 0);
});

test("FS-M011 planFoundation transactionBlockers is empty", () => {
  assert.equal(PLAN.transactionBlockers.length, 0);
  assert.deepEqual(PLAN.transactionBlockers, []);
});

test("FS-M012 planFoundation stages count is 9", () => {
  assert.equal(PLAN.stages.length, 9);
  assert.equal(PLAN.stages.length, FOUNDATION_STAGE_REGISTRY.length);
});

for (const stageName of STAGE_NAMES) {
  test(`FS-S001 plan stage ${stageName} present in order`, () => {
    const index = STAGE_NAMES.indexOf(stageName);
    assert.equal(PLAN.stages[index]?.stage, stageName);
  });
}

for (const ordinal of STAGE_ORDINALS) {
  test(`FS-S002 plan stage ordinal ${ordinal} is correct`, () => {
    assert.equal(PLAN.stages[ordinal - 1]?.ordinal, ordinal);
  });
}

for (const owner of STAGE_OWNERS) {
  test(`FS-S003 plan stage owner ${owner} is present`, () => {
    assert.ok(PLAN.stages.some((s) => s.ownerId === owner));
  });
}

for (const stageName of STAGE_NAMES) {
  test(`FS-S004 plan stage ${stageName} has 2 blockers`, () => {
    const stage = PLAN.stages.find((s) => s.stage === stageName);
    assert.ok(stage);
    assert.equal(stage!.blockers.length, 2);
  });
}

for (const stageName of STAGE_NAMES) {
  test(`FS-S005 plan stage ${stageName} has executor blocker`, () => {
    const stage = PLAN.stages.find((s) => s.stage === stageName);
    assert.ok(stage);
    assert.ok(stage!.blockers.some((b) => b.code === "foundation_stage_executor_unavailable"));
  });
}

for (const stageName of STAGE_NAMES) {
  test(`FS-S006 plan stage ${stageName} has frozen blockers`, () => {
    const stage = PLAN.stages.find((s) => s.stage === stageName);
    assert.ok(stage);
    for (const blocker of stage!.blockers) {
      assert.equal(Object.isFrozen(blocker), true);
      assert.equal(Object.isFrozen(blocker.requiredCapabilities), true);
    }
  });
}

for (const stageName of STAGE_NAMES) {
  test(`FS-S007 plan stage ${stageName} is frozen`, () => {
    const stage = PLAN.stages.find((s) => s.stage === stageName);
    assert.ok(stage);
    assert.equal(Object.isFrozen(stage), true);
  });
}

test("FS-S008 plan stage 0 has blocked disposition", () => {
  assert.equal(PLAN.stages[0]?.disposition, "blocked");
});

test("FS-S009 plan stages 1-8 have unavailable disposition", () => {
  for (let i = 1; i < 9; i++) {
    assert.equal(PLAN.stages[i]?.disposition, "unavailable");
  }
});

test("FS-S010 plan stage 0 has snapshot issuer blocker", () => {
  assert.ok(
    PLAN.stages[0]?.blockers.some((b) => b.code === "foundation_snapshot_issuer_unavailable"),
  );
});

test("FS-S011 plan stages 1-8 have upstream unavailable blocker", () => {
  for (let i = 1; i < 9; i++) {
    assert.ok(
      PLAN.stages[i]?.blockers.some((b) => b.code === "foundation_upstream_stage_unavailable"),
    );
  }
});

test("FS-S012 plan stage 0 blockers do not include upstream unavailable", () => {
  assert.equal(
    PLAN.stages[0]?.blockers.some((b) => b.code === "foundation_upstream_stage_unavailable"),
    false,
  );
});

test("FS-S013 plan stages array is frozen", () => {
  assert.equal(Object.isFrozen(PLAN.stages), true);
});

test("FS-S014 plan result is deeply frozen", () => {
  assertFrozen(PLAN);
});

test("FS-S015 plan determinism - two calls produce same planIdentity", () => {
  const second = planFoundation();
  assert.equal(second.planIdentity, PLAN.planIdentity);
});

test("FS-S016 plan determinism - two calls produce deepEqual results", () => {
  const second = planFoundation();
  assert.deepEqual(second, PLAN);
});

test("FS-S017 plan determinism - canonicalJson is stable across 3 calls", () => {
  const a = canonicalJson(planFoundation());
  const b = canonicalJson(planFoundation());
  const c = canonicalJson(planFoundation());
  assert.equal(a, b);
  assert.equal(b, c);
});

test("FS-C001 checkFoundation returns mode check", () => {
  assert.equal(CHECK.mode, "check");
});

test("FS-C002 checkFoundation returns blocked disposition", () => {
  assert.equal(CHECK.disposition, "blocked");
});

test("FS-C003 checkFoundation activationLockPresent is false", () => {
  assert.equal(CHECK.activationLockPresent, false);
});

test("FS-C004 checkFoundation planIdentity matches plan", () => {
  assert.equal(CHECK.planIdentity, PLAN.planIdentity);
});

test("FS-C005 checkFoundation stages match plan stages", () => {
  assert.deepEqual(CHECK.stages, PLAN.stages);
});

test("FS-C006 checkFoundation transactionBlockers is empty", () => {
  assert.equal(CHECK.transactionBlockers.length, 0);
});

test("FS-C007 checkFoundation schemaVersion matches plan", () => {
  assert.equal(CHECK.schemaVersion, PLAN.schemaVersion);
});

test("FS-C008 checkFoundation compilerRevision matches plan", () => {
  assert.equal(CHECK.compilerRevision, PLAN.compilerRevision);
});

test("FS-C009 checkFoundation result is deeply frozen", () => {
  assertFrozen(CHECK);
});

test("FS-C010 checkFoundation determinism - two calls produce same planIdentity", () => {
  assert.equal(checkFoundation().planIdentity, CHECK.planIdentity);
});

test("FS-C011 checkFoundation determinism - two calls produce deepEqual results", () => {
  assert.deepEqual(checkFoundation(), CHECK);
});

test("FS-W001 writeFoundation returns mode write", () => {
  assert.equal(WRITE.mode, "write");
});

test("FS-W002 writeFoundation returns unavailable disposition", () => {
  assert.equal(WRITE.disposition, "unavailable");
});

test("FS-W003 writeFoundation transactionBlockers has 1 entry", () => {
  assert.equal(WRITE.transactionBlockers.length, 1);
});

test("FS-W004 writeFoundation transaction blocker code is correct", () => {
  assert.equal(WRITE.transactionBlockers[0]?.code, "foundation_write_protocol_pending_implementation");
});

test("FS-W005 writeFoundation transaction blocker ownerId is correct", () => {
  assert.equal(WRITE.transactionBlockers[0]?.ownerId, "foundation-transaction");
});

test("FS-W006 writeFoundation transaction blocker reason is non-empty", () => {
  assert.ok((WRITE.transactionBlockers[0]?.reason.length ?? 0) > 0);
});

test("FS-W007 writeFoundation transaction blocker has empty requiredCapabilities (MWA admitted)", () => {
  assert.equal(WRITE.transactionBlockers[0]?.requiredCapabilities.length, 0);
});

test("FS-W008 writeFoundation planIdentity matches plan", () => {
  assert.equal(WRITE.planIdentity, PLAN.planIdentity);
});

test("FS-W009 writeFoundation stages match plan stages", () => {
  assert.deepEqual(WRITE.stages, PLAN.stages);
});

test("FS-W010 writeFoundation result is deeply frozen", () => {
  assertFrozen(WRITE);
});

test("FS-W011 writeFoundation transaction blocker is frozen", () => {
  assert.equal(Object.isFrozen(WRITE.transactionBlockers[0]), true);
  assert.equal(Object.isFrozen(WRITE.transactionBlockers), true);
});

test("FS-W012 writeFoundation determinism - two calls produce same result", () => {
  assert.deepEqual(writeFoundation(), WRITE);
});

test("FS-W013 writeFoundation disposition is not clean", () => {
  assert.notEqual(WRITE.disposition, "clean");
});

test("FS-R001 recoverFoundation returns mode recover", () => {
  assert.equal(RECOVER.mode, "recover");
});

test("FS-R002 recoverFoundation returns unavailable disposition", () => {
  assert.equal(RECOVER.disposition, "unavailable");
});

test("FS-R003 recoverFoundation transactionBlockers has 1 entry", () => {
  assert.equal(RECOVER.transactionBlockers.length, 1);
});

test("FS-R004 recoverFoundation transaction blocker code is correct", () => {
  assert.equal(RECOVER.transactionBlockers[0]?.code, "foundation_recover_protocol_pending_implementation");
});

test("FS-R005 recoverFoundation transaction blocker ownerId is correct", () => {
  assert.equal(RECOVER.transactionBlockers[0]?.ownerId, "foundation-transaction");
});

test("FS-R006 recoverFoundation transaction blocker reason is non-empty", () => {
  assert.ok((RECOVER.transactionBlockers[0]?.reason.length ?? 0) > 0);
});

test("FS-R007 recoverFoundation transaction blocker has empty requiredCapabilities (MWA admitted)", () => {
  assert.equal(RECOVER.transactionBlockers[0]?.requiredCapabilities.length, 0);
});

test("FS-R008 recoverFoundation planIdentity matches plan", () => {
  assert.equal(RECOVER.planIdentity, PLAN.planIdentity);
});

test("FS-R009 recoverFoundation stages match plan stages", () => {
  assert.deepEqual(RECOVER.stages, PLAN.stages);
});

test("FS-R010 recoverFoundation result is deeply frozen", () => {
  assertFrozen(RECOVER);
});

test("FS-R011 recoverFoundation determinism - two calls produce same result", () => {
  assert.deepEqual(recoverFoundation(), RECOVER);
});

test("FS-R012 recoverFoundation transactionBlockers differ from write by mode-specific code", () => {
  assert.notEqual(RECOVER.transactionBlockers[0]?.code, WRITE.transactionBlockers[0]?.code);
  assert.equal(RECOVER.transactionBlockers[0]?.ownerId, WRITE.transactionBlockers[0]?.ownerId);
  assert.equal(RECOVER.transactionBlockers[0]?.requiredCapabilities.length, 0);
  assert.equal(WRITE.transactionBlockers[0]?.requiredCapabilities.length, 0);
});

test("FS-X001 all four results share the same planIdentity", () => {
  assert.equal(PLAN.planIdentity, CHECK.planIdentity);
  assert.equal(CHECK.planIdentity, WRITE.planIdentity);
  assert.equal(WRITE.planIdentity, RECOVER.planIdentity);
});

test("FS-X002 all four results share the same stageRegistryIdentity", () => {
  assert.equal(PLAN.stageRegistryIdentity, CHECK.stageRegistryIdentity);
  assert.equal(CHECK.stageRegistryIdentity, WRITE.stageRegistryIdentity);
  assert.equal(WRITE.stageRegistryIdentity, RECOVER.stageRegistryIdentity);
});

test("FS-X003 all four results share the same rootPolicyIdentity", () => {
  assert.equal(PLAN.rootPolicyIdentity, CHECK.rootPolicyIdentity);
  assert.equal(CHECK.rootPolicyIdentity, WRITE.rootPolicyIdentity);
  assert.equal(WRITE.rootPolicyIdentity, RECOVER.rootPolicyIdentity);
});

test("FS-X004 all four results share the same schemaVersion", () => {
  assert.equal(PLAN.schemaVersion, CHECK.schemaVersion);
  assert.equal(CHECK.schemaVersion, WRITE.schemaVersion);
  assert.equal(WRITE.schemaVersion, RECOVER.schemaVersion);
});

test("FS-X005 all four results share the same compilerRevision", () => {
  assert.equal(PLAN.compilerRevision, CHECK.compilerRevision);
  assert.equal(CHECK.compilerRevision, WRITE.compilerRevision);
  assert.equal(WRITE.compilerRevision, RECOVER.compilerRevision);
});

test("FS-X006 all four results share the same activationLockPath", () => {
  assert.equal(PLAN.activationLockPath, CHECK.activationLockPath);
  assert.equal(CHECK.activationLockPath, WRITE.activationLockPath);
  assert.equal(WRITE.activationLockPath, RECOVER.activationLockPath);
});

test("FS-X007 all four results share the same artifactManifestPath", () => {
  assert.equal(PLAN.artifactManifestPath, CHECK.artifactManifestPath);
  assert.equal(CHECK.artifactManifestPath, WRITE.artifactManifestPath);
  assert.equal(WRITE.artifactManifestPath, RECOVER.artifactManifestPath);
});

test("FS-X008 all four results share the same stages", () => {
  assert.deepEqual(PLAN.stages, CHECK.stages);
  assert.deepEqual(CHECK.stages, WRITE.stages);
  assert.deepEqual(WRITE.stages, RECOVER.stages);
});

test("FS-X009 plan and check have empty transactionBlockers", () => {
  assert.equal(PLAN.transactionBlockers.length, 0);
  assert.equal(CHECK.transactionBlockers.length, 0);
});

test("FS-X010 write and recover have non-empty transactionBlockers with distinct codes", () => {
  assert.ok(WRITE.transactionBlockers.length > 0);
  assert.ok(RECOVER.transactionBlockers.length > 0);
  assert.notEqual(WRITE.transactionBlockers[0]?.code, RECOVER.transactionBlockers[0]?.code);
});

test("FS-X011 plan and write are different objects", () => {
  assert.notEqual(PLAN, WRITE);
});

test("FS-X012 check and recover are different objects", () => {
  assert.notEqual(CHECK, RECOVER);
});

test("FS-X013 planIdentity matches core compileFoundationPlan", () => {
  assert.equal(PLAN.planIdentity, CORE_PLAN.planIdentity);
});

test("FS-X014 canonicalHash of plan result is stable", () => {
  const a = canonicalHash(PLAN);
  const b = canonicalHash(planFoundation());
  assert.equal(a, b);
});

test("FS-X015 each result mode is unique", () => {
  const modes = new Set([PLAN.mode, CHECK.mode, WRITE.mode, RECOVER.mode]);
  assert.equal(modes.size, 4);
});

for (const mode of MODE_NAMES) {
  test(`FS-X016 result ${mode} has 9 stages`, () => {
    assert.equal(resultFor(mode).stages.length, 9);
  });
}

for (const mode of MODE_NAMES) {
  test(`FS-X017 result ${mode} is deeply frozen`, () => {
    assertFrozen(resultFor(mode));
  });
}

for (const mode of MODE_NAMES) {
  test(`FS-X018 result ${mode} has correct activationLockPath`, () => {
    assert.equal(resultFor(mode).activationLockPath, FOUNDATION_GENERATION_LOCK_PATH);
  });
}

for (const mode of MODE_NAMES) {
  test(`FS-X019 result ${mode} has matching planIdentity to core`, () => {
    assert.equal(resultFor(mode).planIdentity, CORE_PLAN.planIdentity);
  });
}

for (const mode of MODE_NAMES) {
  test(`FS-X020 result ${mode} has matching stageRegistryIdentity`, () => {
    assert.equal(resultFor(mode).stageRegistryIdentity, FOUNDATION_STAGE_REGISTRY_IDENTITY);
  });
}

for (const mode of MODE_NAMES) {
  test(`FS-X021 result ${mode} has matching schemaVersion`, () => {
    assert.equal(resultFor(mode).schemaVersion, FOUNDATION_CASCADE_SCHEMA_VERSION);
  });
}

for (const mode of MODE_NAMES) {
  test(`FS-X022 result ${mode} has matching compilerRevision`, () => {
    assert.equal(resultFor(mode).compilerRevision, FOUNDATION_COMPILER_REVISION);
  });
}

test("FS-F001 FOUNDATION_SLICE_MODES has 4 entries", () => {
  assert.equal(FOUNDATION_SLICE_MODES.length, 4);
});

test("FS-F002 FOUNDATION_SLICE_MODES contains plan", () => {
  assert.ok(FOUNDATION_SLICE_MODES.includes("plan"));
});

test("FS-F003 FOUNDATION_SLICE_MODES contains check", () => {
  assert.ok(FOUNDATION_SLICE_MODES.includes("check"));
});

test("FS-F004 FOUNDATION_SLICE_MODES contains write", () => {
  assert.ok(FOUNDATION_SLICE_MODES.includes("write"));
});

test("FS-F005 FOUNDATION_SLICE_MODES contains recover", () => {
  assert.ok(FOUNDATION_SLICE_MODES.includes("recover"));
});

test("FS-F006 FOUNDATION_SLICE_MODES is frozen", () => {
  assert.equal(Object.isFrozen(FOUNDATION_SLICE_MODES), true);
});

for (const mode of MODE_NAMES) {
  test(`FS-F007 FOUNDATION_SLICE_MODES contains ${mode}`, () => {
    assert.ok(FOUNDATION_SLICE_MODES.includes(mode as typeof FOUNDATION_SLICE_MODES[number]));
  });
}

test("FS-F008 FOUNDATION_SLICE_MODES order is plan check write recover", () => {
  assert.deepEqual([...FOUNDATION_SLICE_MODES], ["plan", "check", "write", "recover"]);
});

test("FS-H001 mutating plan mode throws", () => {
  assert.throws(() => {
    (PLAN as unknown as { mode: string }).mode = "write";
  });
});

test("FS-H002 mutating plan disposition throws", () => {
  assert.throws(() => {
    (PLAN as unknown as { disposition: string }).disposition = "clean";
  });
});

test("FS-H003 mutating plan planIdentity throws", () => {
  assert.throws(() => {
    (PLAN as unknown as { planIdentity: string }).planIdentity = "0".repeat(64);
  });
});

test("FS-H004 mutating plan stages throws", () => {
  assert.throws(() => {
    (PLAN.stages as unknown as unknown[]).push(PLAN.stages[0]!);
  });
});

test("FS-H005 mutating write transactionBlockers throws", () => {
  assert.throws(() => {
    (WRITE.transactionBlockers as unknown as unknown[]).pop();
  });
});

test("FS-H006 structuredClone of plan is not the same object", () => {
  const clone = structuredClone(PLAN);
  assert.notEqual(clone, PLAN);
  assert.deepEqual(clone, PLAN);
});

test("FS-H007 JSON round-trip preserves plan fields", () => {
  const json = JSON.parse(JSON.stringify(PLAN));
  assert.equal(json.mode, "plan");
  assert.equal(json.disposition, "blocked");
  assert.equal(json.stages.length, 9);
  assert.equal(json.transactionBlockers.length, 0);
});

test("FS-H008 JSON round-trip preserves write fields", () => {
  const json = JSON.parse(JSON.stringify(WRITE));
  assert.equal(json.mode, "write");
  assert.equal(json.disposition, "unavailable");
  assert.equal(json.transactionBlockers.length, 1);
  assert.equal(json.transactionBlockers[0].code, "foundation_write_protocol_pending_implementation");
});

test("FS-H009 canonicalJson of plan is deterministic across 3 calls", () => {
  const a = canonicalJson(PLAN);
  const b = canonicalJson(planFoundation());
  const c = canonicalJson(planFoundation());
  assert.equal(a, b);
  assert.equal(b, c);
});

test("FS-H010 write disposition is not blocked", () => {
  assert.notEqual(WRITE.disposition, "blocked");
});

test("FS-H011 recover disposition is not blocked", () => {
  assert.notEqual(RECOVER.disposition, "blocked");
});

test("FS-H012 plan ordering rule matches foundation UTF8 ordering", () => {
  assert.equal(FOUNDATION_UTF8_ORDERING_RULE, "unsigned-utf8-byte-lexicographic/v1");
});

test("FS-CLI001-006 plan mode CLI produces valid blocked output with 9 stages and planIdentity", () => {
  const result = cachedCli("plan");
  assert.notEqual(result.exitCode, 0);
  assert.ok(result.stdout.endsWith("\n"), "plan stdout ends with newline");
  const json = JSON.parse(result.stdout);
  assert.equal(json.mode, "plan");
  assert.equal(json.disposition, "blocked");
  assert.match(json.planIdentity, /^[0-9a-f]{64}$/u);
  assert.equal(json.stages.length, 9);
  assert.equal(json.planIdentity, PLAN.planIdentity);
});

test("FS-CLI007-010 check mode CLI produces valid blocked output matching slice planIdentity", () => {
  const result = cachedCli("check");
  assert.notEqual(result.exitCode, 0);
  const json = JSON.parse(result.stdout);
  assert.equal(json.mode, "check");
  assert.equal(json.disposition, "blocked");
  assert.equal(json.planIdentity, CHECK.planIdentity);
});

test("FS-CLI011-015 write mode CLI produces unavailable disposition with write-protocol blocker", () => {
  const result = cachedCli("write");
  assert.notEqual(result.exitCode, 0);
  const json = JSON.parse(result.stdout);
  assert.equal(json.mode, "write");
  assert.equal(json.disposition, "unavailable");
  assert.ok(json.transactionBlockers.length > 0);
  assert.equal(json.transactionBlockers[0].code, "foundation_write_protocol_pending_implementation");
  assert.equal(json.planIdentity, WRITE.planIdentity);
});

test("FS-CLI016-019 recover mode CLI produces unavailable disposition", () => {
  const result = cachedCli("recover");
  assert.notEqual(result.exitCode, 0);
  const json = JSON.parse(result.stdout);
  assert.equal(json.mode, "recover");
  assert.equal(json.disposition, "unavailable");
  assert.equal(json.planIdentity, RECOVER.planIdentity);
});

test("FS-CLI031-041 all four modes produce output with shared structural fields (table-driven)", () => {
  // Covers the previous 10 per-mode loop tests (CLI031-041): exitCode,
  // mode, planIdentity, stages, stageRegistryIdentity, rootPolicyIdentity,
  // schemaVersion, compilerRevision, activationLockPath, artifactManifestPath,
  // transactionBlockers. Each row asserts the invariant for one mode.
  for (const mode of MODE_NAMES) {
    const result = cachedCli(mode);
    assert.notEqual(result.exitCode, 0, `${mode}: exitCode nonzero`);
    const json = JSON.parse(result.stdout);
    assert.equal(json.mode, mode, `${mode}: json.mode`);
    assert.match(json.planIdentity, /^[0-9a-f]{64}$/u, `${mode}: planIdentity`);
    assert.equal(json.stages.length, 9, `${mode}: stages.length`);
    assert.match(json.stageRegistryIdentity, /^[0-9a-f]{64}$/u, `${mode}: stageRegistryIdentity`);
    assert.match(json.rootPolicyIdentity, /^[0-9a-f]{64}$/u, `${mode}: rootPolicyIdentity`);
    assert.equal(json.schemaVersion, FOUNDATION_CASCADE_SCHEMA_VERSION, `${mode}: schemaVersion`);
    assert.equal(json.compilerRevision, FOUNDATION_COMPILER_REVISION, `${mode}: compilerRevision`);
    assert.equal(json.activationLockPath, FOUNDATION_GENERATION_LOCK_PATH, `${mode}: activationLockPath`);
    assert.ok(json.artifactManifestPath.length > 0, `${mode}: artifactManifestPath`);
    assert.ok(Array.isArray(json.transactionBlockers), `${mode}: transactionBlockers is Array`);
  }
});

test("FS-CLI020-026 invalid CLI arguments exit nonzero (table-driven)", () => {
  const cases: ReadonlyArray<{ name: string; args: string[] }> = [
    { name: "no mode", args: [] },
    { name: "unknown mode", args: ["invalid-mode"] },
    { name: "extra argument", args: ["plan", "extra"] },
    { name: "flag is rejected", args: ["--plan"] },
    { name: "flag after mode is rejected", args: ["plan", "--force"] },
    { name: "empty string mode", args: [""] },
    { name: "two modes", args: ["plan", "check"] },
  ];
  for (const { name, args } of cases) {
    const result = runCli(...args);
    assert.notEqual(result.exitCode, 0, `${name}: exitCode nonzero`);
  }
});

test("FS-CLI043-045 CLI error output is valid JSON on stderr with error field (table-driven)", () => {
  const cases: ReadonlyArray<{ name: string; args: string[] }> = [
    { name: "unknown mode", args: ["invalid-mode"] },
    { name: "no mode", args: [] },
    { name: "extra arg", args: ["plan", "extra"] },
  ];
  for (const { name, args } of cases) {
    const result = runCli(...args);
    assert.ok(result.stderr.trim().length > 0, `${name}: stderr non-empty`);
    const json = JSON.parse(result.stderr);
    assert.ok(json.error, `${name}: json.error present`);
  }
});
