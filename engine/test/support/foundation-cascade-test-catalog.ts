import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";

import { InputError } from "../../src/kernel/errors.ts";
import { canonicalHash, canonicalJson, deepFreeze } from "../../src/kernel/integrity.ts";
import { compareUtf8Bytes } from "../../src/kernel/ordered.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { snapshotJsonValue, snapshotUint8Array } from "../../src/kernel/safe-structural.ts";
import { SLICE_PROJECTION_PATHS, VERIFICATION_PATHS } from "../../src/kernel/verification-paths.ts";
import {
  FOUNDATION_CASCADE_SCHEMA_VERSION,
  FOUNDATION_COMPILER_REVISION,
  FOUNDATION_EXPECTED_OUTPUTS,
  FOUNDATION_GENERATION_LOCK_PATH,
  FOUNDATION_GENERATION_LOCK_SCHEMA_VERSION,
  FOUNDATION_STAGE_REGISTRY,
  FOUNDATION_STAGE_REGISTRY_IDENTITY,
  FOUNDATION_UTF8_ORDERING_RULE,
  buildFoundationGenerationLock,
  compileFoundationPlan,
  parseUntrustedFoundationGenerationLockBytes,
  parseUntrustedFoundationPlanBytes,
  validateFoundationDag,
  validateFoundationGenerationLockCandidate,
  validateFoundationPlanCandidate,
  type FoundationPlan,
  type UntrustedFoundationGenerationLockCandidate,
} from "../../verification/core/foundation-cascade.ts";
import { isInternallyIssuedFoundationPlanInternal } from
  "../../verification/core/foundation-cascade/plan.ts";
import {
  executePlannedNodeTestFamily,
  plannedNodeTestCatalogIdentity,
  plannedNodeTestRuntimeResults,
  type PlannedNodeTestCallback,
  type PlannedNodeTestFamily,
} from "../../scripts/tooling/planned-node-test.ts";

type FoundationCascadeFamily<Id extends string> = PlannedNodeTestFamily<Id>;

const variant = Number.parseInt(process.env.FOUNDATION_TEST_VARIANT ?? "0", 10);
const baseline = compileFoundationPlan();

export const FOUNDATION_CASCADE_TEST_CATALOG = deepFreeze([
  family("FC-C001", "closed registry and exact output authority", "authority-closure", (check) => {
    check(() => {
      validateFoundationDag();
      assert.deepEqual(FOUNDATION_STAGE_REGISTRY.map((entry) => entry.ordinal),
        FOUNDATION_STAGE_REGISTRY.map((_entry, index) => index + 1));
      assert.equal(new Set(FOUNDATION_EXPECTED_OUTPUTS.map((output) => output.path)).size,
        FOUNDATION_EXPECTED_OUTPUTS.length);
      for (const path of [ROOT_POLICY.configuration.contract.generatedSchemaPath,
        ROOT_POLICY.verification.testDiscovery.dispositionRegistry.recordsPath,
        ROOT_POLICY.artifactGovernance.canonicalInventory, SLICE_PROJECTION_PATHS.s2Trace,
        SLICE_PROJECTION_PATHS.s24Trace, SLICE_PROJECTION_PATHS.s31Trace]) {
        assert.ok(FOUNDATION_EXPECTED_OUTPUTS.some((output) => output.path === path));
      }
    });
  }),
  family("FC-C002", "truthful blocked and unavailable production plan", "blocked-plan", (check) => {
    check(() => {
      assert.equal(baseline.compilationDisposition, "blocked");
      assert.equal(baseline.stages[0]?.disposition, "blocked");
      assert.ok(baseline.stages.slice(1).every((stage) => stage.disposition === "unavailable"));
      assert.ok(baseline.stages.every((stage) => stage.outputs.length === 0));
      assert.ok(baseline.stages.flatMap((stage) => stage.blockers).some((blocker) =>
        blocker.code === "foundation_snapshot_issuer_unavailable"));
      assert.ok(baseline.stages.every((stage) => stage.blockers.some((blocker) =>
        blocker.code === "foundation_stage_executor_unavailable")));
    });
  }),
  family("FC-C003", "caller projection and authority claims forbidden", "caller-claims", (check) => {
    check(() => {
      const compileWithClaims = compileFoundationPlan as unknown as (...claims: unknown[]) => FoundationPlan;
      expectCode(() => compileWithClaims({ disposition: "projected", outputs: [{ path: ".git/config" }] }),
        "foundation_compile_arguments_forbidden");
      const buildWithClaims = buildFoundationGenerationLock as unknown as (...claims: unknown[]) => never;
      expectCode(() => buildWithClaims(baseline), "foundation_generation_lock_arguments_forbidden");
    });
  }),
  family("FC-C004", "plan candidate parser remains explicitly untrusted", "untrusted-wrapper", (check) => {
    check(() => {
      const mutated = { ...structuredClone(baseline), planIdentity: "0".repeat(64) };
      const parsed = parseUntrustedFoundationPlanBytes(canonicalBytes(mutated));
      assert.equal(parsed.kind, "untrusted-foundation-plan-candidate");
      assert.equal(parsed.candidate.planIdentity, "0".repeat(64));
      assert.equal(isInternallyIssuedFoundationPlanInternal(parsed), false);
      assert.equal(isInternallyIssuedFoundationPlanInternal(parsed.candidate), false);
      expectCode(() => validateFoundationPlanCandidate(parsed), "foundation_plan_identity_invalid");
    });
  }),
  family("FC-C005", "validated plan binds internal nominal issuer", "issuer-boundary", (check) => {
    check(() => {
      assert.equal(isInternallyIssuedFoundationPlanInternal(baseline), true);
      assertRecursivelyFrozen(baseline);
      const parsed = parseUntrustedFoundationPlanBytes(canonicalBytes(baseline));
      const validated = validateFoundationPlanCandidate(parsed);
      assert.equal(isInternallyIssuedFoundationPlanInternal(validated), true);
      assertRecursivelyFrozen(validated);
      assert.notEqual(validated, parsed.candidate);
      assert.notEqual(validated.stages, parsed.candidate.stages);
      const clone = structuredClone(baseline);
      const cast = { ...baseline } as FoundationPlan;
      const serialized = JSON.parse(JSON.stringify(baseline)) as unknown;
      for (const forged of [clone, cast, serialized]) {
        assert.equal(isInternallyIssuedFoundationPlanInternal(forged), false);
        const revalidated = validateFoundationPlanCandidate(forged);
        assert.equal(isInternallyIssuedFoundationPlanInternal(revalidated), true);
        assert.notEqual(revalidated, forged);
      }
      const independentlyCompiled = compileFoundationPlan();
      assert.notEqual(independentlyCompiled, baseline);
      assert.notEqual(independentlyCompiled.stages, baseline.stages);
      assert.equal(independentlyCompiled.planIdentity, baseline.planIdentity);
      const firstStage = baseline.stages[0]!;
      const firstBlocker = firstStage.blockers[0]!;
      expectThrow(() => {
        (baseline as unknown as { compilationDisposition: string }).compilationDisposition = "projected";
      });
      expectThrow(() => {
        (baseline.stages as unknown as unknown[]).push(firstStage);
      });
      expectThrow(() => {
        (firstStage.outputs as unknown as unknown[]).push({ path: ".git/config" });
      });
      expectThrow(() => {
        (firstStage.dependsOn as unknown as string[]).push("publish-and-verify");
      });
      expectThrow(() => {
        (firstBlocker.requiredCapabilities as unknown as string[]).push("attacker/capability");
      });
      assert.equal(isInternallyIssuedFoundationPlanInternal(baseline), true);
    });
  }),
  family("FC-C006", "strict recursive unknown-field rejection", "strict-shapes", (check) => {
    check(() => {
      expectThrow(() => validateFoundationPlanCandidate({ ...baseline, publicationAuthorized: true }));
      const stageExtra = structuredClone(baseline) as MutablePlan;
      Object.assign(stageExtra.stages[0]!, { generatorIdentity: "f".repeat(64) });
      expectThrow(() => validateFoundationPlanCandidate(stageExtra));
      const blockerExtra = structuredClone(baseline) as MutablePlan;
      Object.assign(blockerExtra.stages[0]!.blockers[0]!, { inputIdentity: "f".repeat(64) });
      expectThrow(() => validateFoundationPlanCandidate(blockerExtra));
    });
  }),
  family("FC-C007", "plan stage and plan identities fail closed", "identity-binding", (check) => {
    check(() => {
      const stageMutation = structuredClone(baseline) as MutablePlan;
      stageMutation.stages[0]!.stageIdentity = "0".repeat(64);
      expectCode(() => validateFoundationPlanCandidate(stageMutation), "foundation_plan_stage_identity_invalid");
      const planMutation = structuredClone(baseline) as MutablePlan;
      planMutation.planIdentity = "0".repeat(64);
      expectCode(() => validateFoundationPlanCandidate(planMutation), "foundation_plan_identity_invalid");
      const dependencyMutation = structuredClone(baseline) as MutablePlan;
      dependencyMutation.stages[1]!.dependsOn.push("validate-authorities");
      expectCode(() => validateFoundationPlanCandidate(dependencyMutation), "foundation_plan_stage_invalid");
    });
  }),
  family("FC-C008", "generation lock construction and validation unavailable", "lock-unavailable", (check) => {
    check(() => {
      expectCode(() => buildFoundationGenerationLock(), "foundation_generation_lock_unavailable");
      const candidate = lockCandidate(baseline);
      assert.deepEqual(parseUntrustedFoundationGenerationLockBytes(canonicalBytes(candidate)), candidate);
      expectCode(() => validateFoundationGenerationLockCandidate(candidate),
        "foundation_generation_lock_unavailable");
      expectCode(() => validateFoundationGenerationLockCandidate({ ...candidate, planIdentity: "0".repeat(64) }),
        "foundation_generation_lock_plan_mismatch");
    });
  }),
  family("FC-C009", "generation lock claims and destinations rejected", "lock-claims", (check) => {
    check(() => {
      const candidate = lockCandidate(baseline);
      expectThrow(() => parseUntrustedFoundationGenerationLockBytes(canonicalBytes({
        ...candidate, outputs: [{ path: ".git/config", publicationAuthorized: true }],
      })));
      expectThrow(() => validateFoundationGenerationLockCandidate({ ...candidate, readiness: true }));
    });
  }),
  family("FC-C010", "fatal UTF-8 duplicate-key and canonical-byte intake", "canonical-intake", (check) => {
    check(() => {
      expectCode(() => parseUntrustedFoundationPlanBytes(new Uint8Array([0xc3, 0x28])),
        "foundation_plan_candidate_utf8_invalid");
      const text = new TextDecoder().decode(canonicalBytes(baseline));
      const duplicate = text.replace(`"schemaVersion":"${FOUNDATION_CASCADE_SCHEMA_VERSION}"`,
        `"schemaVersion":"${FOUNDATION_CASCADE_SCHEMA_VERSION}","schemaVersion":"${FOUNDATION_CASCADE_SCHEMA_VERSION}"`);
      expectCode(() => parseUntrustedFoundationPlanBytes(new TextEncoder().encode(duplicate)),
        "foundation_plan_candidate_key_duplicate");
      expectCode(() => parseUntrustedFoundationPlanBytes(
        new TextEncoder().encode(`${JSON.stringify(baseline, null, 2)}\n`)),
      "foundation_plan_candidate_bytes_noncanonical");
    });
  }),
  family("FC-S001", "trap-free object candidate snapshots", "trap-free-objects", (check) => {
    check(() => {
      let proxyTraps = 0;
      const proxy = new Proxy(structuredClone(baseline), {
        getPrototypeOf() { proxyTraps += 1; return Object.prototype; },
      });
      expectCode(() => validateFoundationPlanCandidate(proxy), "foundation_plan_candidate_structure_unsafe");
      assert.equal(proxyTraps, 0);
      let accessorCalls = 0;
      const accessor = structuredClone(baseline) as Record<string, unknown>;
      Object.defineProperty(accessor, "schemaVersion", { enumerable: true, get() {
        accessorCalls += 1; return FOUNDATION_CASCADE_SCHEMA_VERSION;
      } });
      expectCode(() => validateFoundationPlanCandidate(accessor), "foundation_plan_candidate_structure_unsafe");
      assert.equal(accessorCalls, 0);
    });
  }),
  family("FC-S002", "object exotics cycles sparse arrays and bounds rejected", "bounded-objects", (check) => {
    check(() => {
      class Candidate {}
      expectCode(() => validateFoundationPlanCandidate(Object.assign(new Candidate(), baseline)),
        "foundation_plan_candidate_structure_unsafe");
      const cycle = structuredClone(baseline) as Record<string, unknown>;
      cycle.self = cycle;
      expectCode(() => validateFoundationPlanCandidate(cycle), "foundation_plan_candidate_structure_unsafe");
      const sparse = structuredClone(baseline) as MutablePlan;
      sparse.stages = new Array(FOUNDATION_STAGE_REGISTRY.length);
      expectCode(() => validateFoundationPlanCandidate(sparse), "foundation_plan_candidate_structure_unsafe");
      expectThrow(() => snapshotJsonValue({ child: { leaf: true } }, { maximumDepth: 1, maximumNodes: 10 }));
    });
  }),
  family("FC-S003", "exact byte view shapes and immutable copy", "byte-shapes", (check) => {
    check(() => {
      const source = new Uint8Array([1, 2, 3]);
      const snapshot = snapshotUint8Array(source, source.byteLength);
      source[0] = 9;
      assert.deepEqual([...snapshot], [1, 2, 3]);
      class ByteSubclass extends Uint8Array {}
      expectThrow(() => snapshotUint8Array(new ByteSubclass(1), 1));
      expectThrow(() => snapshotUint8Array(new Uint8ClampedArray(1), 1));
      expectThrow(() => snapshotUint8Array(new DataView(new ArrayBuffer(1)), 1));
      expectThrow(() => snapshotUint8Array(Object.create(Uint8Array.prototype) as unknown, 1));
    });
  }),
  family("FC-S004", "shared resizable detached and oversized bytes rejected", "byte-bounds", (check) => {
    check(() => {
      expectThrow(() => snapshotUint8Array(new Uint8Array(new SharedArrayBuffer(1)), 1));
      const resizable = new ArrayBuffer(1, { maxByteLength: 2 });
      expectThrow(() => snapshotUint8Array(new Uint8Array(resizable), 2));
      const backing = new ArrayBuffer(1);
      const detached = new Uint8Array(backing);
      structuredClone(backing, { transfer: [backing] });
      expectThrow(() => snapshotUint8Array(detached, 1));
      expectThrow(() => snapshotUint8Array(new Uint8Array(2), 1));
    });
  }),
  family("FC-D001", "UTF-8 ordering uses independent byte oracle", "utf8-order", (check) => {
    check(() => {
      const values = ["a", "aa", "é", "e\u0301", "😀", "\u{10ffff}"];
      const expected = [...values].toSorted((left, right) =>
        Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")));
      assert.deepEqual([...values].toSorted(compareUtf8Bytes), expected);
    });
  }),
  family("FC-D002", "locale timezone and insertion environment invariance", "environment-invariance", (check) => {
    check(() => {
      assert.equal(compileFoundationPlan().planIdentity, baseline.planIdentity);
      const reordered = reorderRecord(structuredClone(baseline) as Record<string, unknown>, variant + 1);
      assert.equal(validateFoundationPlanCandidate(reordered).planIdentity, baseline.planIdentity);
    });
  }),
  family("FC-D003", "terminal roots and dependency closure remain acyclic", "dependency-closure", (check) => {
    check(() => {
      const outputIndex = new Map(FOUNDATION_EXPECTED_OUTPUTS.map((output) => [output.path, output]));
      const stageIndex = new Map(FOUNDATION_STAGE_REGISTRY.map((stage) => [stage.stage, stage.ordinal]));
      for (const output of FOUNDATION_EXPECTED_OUTPUTS) {
        assert.equal(new Set(output.dependencies).size, output.dependencies.length);
        assert.deepEqual(output.dependencies, [...output.dependencies].toSorted(compareUtf8Bytes));
        for (const dependency of output.dependencies) {
          const target = outputIndex.get(dependency);
          assert.ok(target);
          assert.ok(stageIndex.get(target.stage)! < stageIndex.get(output.stage)!);
        }
      }
      const activation = outputIndex.get(FOUNDATION_GENERATION_LOCK_PATH)!;
      const artifact = outputIndex.get(ROOT_POLICY.artifactGovernance.canonicalInventory)!;
      assert.equal(activation.dependencies.includes(artifact.path), false);
      assert.equal(artifact.dependencies.includes(activation.path), false);
    });
  }),
  family("FC-B001", "pure modular boundary and single protocol ownership", "module-authority", (check) => {
    check(() => {
      const modulePaths = [
        "verification/core/foundation-cascade.ts",
        "verification/core/foundation-cascade/plan.ts",
        "verification/core/foundation-cascade/candidate.ts",
        "verification/core/foundation-cascade/generation-lock.ts",
        "verification/core/foundation-cascade/shared.ts",
      ];
      const allSource = modulePaths.map((path) => readFileSync(resolve(path), "utf8")).join("\n");
      for (const forbidden of ["node:fs", "node:child_process", "Date.now", "Math.random", "process.env",
        "writeFile", "../../scripts/", "publicationAuthorized", "generatorIdentity", "inputIdentity",
        "disposition: \"projected\""]) {
        assert.equal(allSource.includes(forbidden), false, forbidden);
      }
      assert.equal(countOccurrences(allSource, "function compileFoundationPlanInternal"), 1);
      assert.equal(countOccurrences(allSource, "function validateFoundationDagInternal"), 1);
      const pathOccurrences = repositoryTypeScriptSources(resolve("."))
        .reduce((count, source) => count + countOccurrences(source, VERIFICATION_PATHS.testInventory), 0);
      assert.equal(pathOccurrences, 1, "test inventory path must have one TypeScript literal owner");
    });
  }),
] as const);

export type FoundationCascadeTestId = typeof FOUNDATION_CASCADE_TEST_CATALOG[number]["id"];
export const FOUNDATION_CASCADE_TEST_WORKER_PATH =
  "test/support/foundation-cascade-hostile-worker.test.ts" as const;
export const FOUNDATION_CASCADE_TEST_IDS = deepFreeze(
  FOUNDATION_CASCADE_TEST_CATALOG.map((entry) => entry.id),
);
export const FOUNDATION_CASCADE_TEST_DECLARATION_IDENTITY = canonicalHash(
  FOUNDATION_CASCADE_TEST_CATALOG.map((entry) => ({
    id: entry.id,
    name: entry.name,
    assertionPlan: entry.assertionPlan,
  })),
);
export const FOUNDATION_CASCADE_TEST_CATALOG_IDENTITY = plannedNodeTestCatalogIdentity(
  FOUNDATION_CASCADE_TEST_CATALOG,
);

export const FOUNDATION_CASCADE_EXPECTED_RUNTIME_RESULTS = plannedNodeTestRuntimeResults(
  FOUNDATION_CASCADE_TEST_CATALOG,
);

export async function executeFoundationCascadeFamily(
  id: FoundationCascadeTestId,
  context: TestContext,
): Promise<void> {
  return executePlannedNodeTestFamily(FOUNDATION_CASCADE_TEST_CATALOG, id, context);
}

function family<Id extends string>(
  id: Id,
  name: string,
  assertionId: string,
  callback: PlannedNodeTestCallback,
): FoundationCascadeFamily<Id> {
  return {
    id,
    name,
    assertionPlan: [{ id: assertionId, checks: 1 }],
    run: (invoke) => invoke(assertionId, callback),
  };
}

function lockCandidate(plan: FoundationPlan): UntrustedFoundationGenerationLockCandidate {
  return {
    schemaVersion: FOUNDATION_GENERATION_LOCK_SCHEMA_VERSION,
    compilerRevision: FOUNDATION_COMPILER_REVISION,
    planIdentity: plan.planIdentity,
    stageRegistryIdentity: FOUNDATION_STAGE_REGISTRY_IDENTITY,
    completedStages: [],
    outputs: [],
    exclusions: [
      { path: plan.artifactManifestPath, reason: "artifact-manifest-terminal-root-excluded" as const },
      { path: plan.activationLockPath, reason: "activation-lock-self-excluded" as const },
    ].toSorted((left, right) => compareUtf8Bytes(left.path, right.path)),
    orderingRule: FOUNDATION_UTF8_ORDERING_RULE,
  };
}

function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${canonicalJson(value)}\n`);
}

function reorderRecord(value: Record<string, unknown>, orderVariant: number): Record<string, unknown> {
  const entries = Object.entries(value);
  if (orderVariant % 3 === 1) entries.reverse();
  if (orderVariant % 3 === 2 && entries.length > 1) entries.push(entries.shift()!);
  return Object.fromEntries(entries) as Record<string, unknown>;
}

function expectCode(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) => error instanceof InputError && error.code === code);
}

function expectThrow(run: () => unknown): void {
  assert.throws(run);
}

function assertRecursivelyFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertRecursivelyFrozen(child, seen);
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function repositoryTypeScriptSources(root: string): readonly string[] {
  const sources: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === ".bridlewise" || entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".ts")) sources.push(readFileSync(path, "utf8"));
    }
  };
  visit(root);
  return sources;
}

type MutablePlan = {
  -readonly [Key in keyof FoundationPlan]: FoundationPlan[Key] extends readonly (infer Entry)[]
    ? Array<Mutable<Entry>>
    : FoundationPlan[Key];
};

type Mutable<Value> = {
  -readonly [Key in keyof Value]: Value[Key] extends readonly (infer Entry)[]
    ? Array<Mutable<Entry>>
    : Value[Key];
};
