import type { TestContext } from "node:test";

import { canonicalHash, deepFreeze, sha256 } from "../../src/kernel/integrity.ts";

export const PLANNED_NODE_TEST_PROTOCOL = deepFreeze({
  suiteSpecSchemaVersion: "bridlewise-planned-node-test-suite-spec/v2",
  evidenceSchemaVersion: "bridlewise-planned-node-test-evidence/v2",
  integrityClaim: "self-integrity-only-not-authenticity",
  qualificationDisposition: "isolated-normal-inventory-v4-not-repository-admission",
  repositoryAdmissionAllowed: false,
  childRuntimeDisposition: "observational-non-authoritative",
  childEnvironmentContract: {
    requiredExactKeys: ["LANG", "LC_ALL", "TZ"],
    requiredSuiteVariantKeyPattern: "^[A-Z][A-Z0-9_]*_TEST_VARIANT$",
    ambientInheritanceAllowed: false,
    toolResolution: "qualified-absolute-runner-capabilities-never-path-environment",
    deniedKeyDiagnostics: "key-and-reason-only-never-value",
  },
  isolatedDependencySnapshot: {
    root: "node_modules",
    excludedTopLevelDirectoryNames: [".bin"],
    maximumFileBytes: 33_554_432,
  },
} as const);

export type PlannedNodeTestCheck = (assertion: () => void) => void;
export type PlannedNodeTestCallback = (check: PlannedNodeTestCheck) => void;
export type PlannedNodeTestInvocation = (assertionId: string, callback: PlannedNodeTestCallback) => void;
export type PlannedNodeTestAssertion = Readonly<{ id: string; checks: number }>;
export type PlannedNodeTestFamily<Id extends string = string> = Readonly<{
  id: Id;
  name: string;
  assertionPlan: readonly PlannedNodeTestAssertion[];
  run: (invoke: PlannedNodeTestInvocation) => void;
}>;
export type PlannedNodeTestRuntimeResult = Readonly<{
  depth: 0;
  name: string;
  status: "passed";
}>;

const ORACLE_COMPLETION = "planned-node-test-oracle-completed/v1" as const;

export async function executePlannedNodeTestFamily<Id extends string>(
  catalog: readonly PlannedNodeTestFamily<Id>[],
  id: Id,
  context: TestContext,
): Promise<void> {
  const entry = catalog.find((candidate) => candidate.id === id);
  if (entry === undefined) throw new Error(`Unknown planned Node test family: ${id}`);
  const invocations = collectInvocations(entry);
  if (invocations.some((invocation, index) => invocation.assertionId !== entry.assertionPlan[index]?.id)) {
    throw new Error(`${id} assertion plan drift`);
  }
  context.plan(entry.assertionPlan.reduce((count, assertion) => count + assertion.checks + 2, 0));
  for (const [index, planned] of entry.assertionPlan.entries()) {
    const invocation = invocations[index]!;
    let invoked = 0;
    let completed = 0;
    invocation.callback((assertion) => {
      invoked += 1;
      context.assert.equal(
        executePlannedNodeTestOracle(assertion),
        ORACLE_COMPLETION,
        `${id}/${planned.id} oracle did not complete`,
      );
      completed += 1;
    });
    context.assert.equal(invoked, planned.checks, `${id}/${planned.id} invocation count`);
    context.assert.equal(completed, planned.checks, `${id}/${planned.id} completion count`);
  }
}

export function plannedNodeTestCatalogIdentity(
  catalog: readonly PlannedNodeTestFamily[],
): string {
  const projection = catalog.map((entry) => ({
    id: entry.id,
    name: entry.name,
    assertions: collectInvocations(entry).map((invocation, index) => ({
      id: entry.assertionPlan[index]!.id,
      checks: entry.assertionPlan[index]!.checks,
      callbackSourceSha256: sha256(Function.prototype.toString.call(invocation.callback)),
    })),
  }));
  return canonicalHash(projection);
}

export function plannedNodeTestRuntimeResults(
  catalog: readonly PlannedNodeTestFamily[],
): readonly PlannedNodeTestRuntimeResult[] {
  return deepFreeze(catalog.map((entry) => ({
    depth: 0 as const,
    name: `[${entry.id}] ${entry.name}`,
    status: "passed" as const,
  })));
}

function collectInvocations(entry: PlannedNodeTestFamily): readonly Readonly<{
  assertionId: string;
  callback: PlannedNodeTestCallback;
}>[] {
  const invocations: Array<Readonly<{ assertionId: string; callback: PlannedNodeTestCallback }>> = [];
  entry.run((assertionId, callback) => invocations.push({ assertionId, callback }));
  if (invocations.length !== entry.assertionPlan.length || invocations.some((invocation, index) =>
    invocation.assertionId !== entry.assertionPlan[index]?.id)) {
    throw new Error(`Planned Node test catalog invocation drift: ${entry.id}`);
  }
  return deepFreeze(invocations);
}

function executePlannedNodeTestOracle(assertion: () => void): typeof ORACLE_COMPLETION {
  assertion();
  return ORACLE_COMPLETION;
}
