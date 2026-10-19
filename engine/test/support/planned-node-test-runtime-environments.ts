import { PLANNED_NODE_TEST_PROTOCOL } from "../../scripts/tooling/planned-node-test.ts";
import { deepFreeze } from "../../src/kernel/integrity.ts";

const HOSTILE_REQUIRED_ENVIRONMENTS = [
  { LANG: "C", LC_ALL: "C", TZ: "UTC" },
  { LANG: "fr_CA.UTF-8", LC_ALL: "fr_CA.UTF-8", TZ: "America/Toronto" },
  { LANG: "tr_TR.UTF-8", LC_ALL: "tr_TR.UTF-8", TZ: "Asia/Tokyo" },
] as const;

const DENIED_CANARY_KEYS = [
  "AWS_SECRET_ACCESS_KEY",
  "OPENAI_API_KEY",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_TEST_CONTEXT",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "HOME",
  "PATH",
  "PLANNED_NODE_TEST_AMBIENT_CANARY",
] as const;

type DeniedCanaryKey = typeof DENIED_CANARY_KEYS[number];

export type PlannedNodeTestHostileEnvironmentScenario = Readonly<{
  id: string;
  environment: Readonly<NodeJS.ProcessEnv>;
}>;

export type PlannedNodeTestHostileEnvironmentMatrix = Readonly<{
  scenarios: readonly PlannedNodeTestHostileEnvironmentScenario[];
  expectedDeniedKeyNames: readonly DeniedCanaryKey[];
  leakedDeniedKeyNames: (value: string | Uint8Array) => readonly DeniedCanaryKey[];
}>;

export function createPlannedNodeTestHostileEnvironmentMatrix(
  suiteVariantKey: string,
): PlannedNodeTestHostileEnvironmentMatrix {
  assertSuiteVariantKey(suiteVariantKey);
  const requiredKeys = PLANNED_NODE_TEST_PROTOCOL.childEnvironmentContract.requiredExactKeys;
  if (new Set(requiredKeys).size !== requiredKeys.length) {
    throw new Error("planned_node_test_hostile_environment_required_key_duplicate");
  }
  const sortedRequiredKeys = [...requiredKeys].toSorted();
  if (HOSTILE_REQUIRED_ENVIRONMENTS.some((environment) => {
    const environmentKeys = Object.keys(environment).toSorted();
    return environmentKeys.length !== sortedRequiredKeys.length ||
      environmentKeys.some((key, index) => key !== sortedRequiredKeys[index]);
  })) {
    throw new Error("planned_node_test_hostile_environment_required_key_mismatch");
  }
  if (new Set(HOSTILE_REQUIRED_ENVIRONMENTS.map((environment) =>
    requiredKeys.map((key) => environment[key]).join("\0")
  )).size !== HOSTILE_REQUIRED_ENVIRONMENTS.length ||
    new Set(DENIED_CANARY_KEYS).size !== DENIED_CANARY_KEYS.length) {
    throw new Error("planned_node_test_hostile_environment_duplicate_scenario_authority");
  }
  if (requiredKeys.some((key) => key === suiteVariantKey) ||
    DENIED_CANARY_KEYS.some((key) => key === suiteVariantKey)) {
    throw new Error("planned_node_test_hostile_environment_variant_key_collision");
  }

  const deniedCanaries = createDeniedCanaries();
  const scenarios = HOSTILE_REQUIRED_ENVIRONMENTS.map((requiredEnvironment, index) => {
    return {
      id: `hostile-runtime-${index}`,
      environment: {
        ...requiredEnvironment,
        [suiteVariantKey]: index.toString(),
        ...deniedCanaries,
      },
    };
  });

  return deepFreeze({
    scenarios,
    expectedDeniedKeyNames: DENIED_CANARY_KEYS,
    leakedDeniedKeyNames: (value: string | Uint8Array) => {
      const text = typeof value === "string" ? value : Buffer.from(value).toString("utf8");
      return Object.freeze(
        DENIED_CANARY_KEYS.filter((key) => text.includes(deniedCanaries[key])),
      );
    },
  });
}

function assertSuiteVariantKey(suiteVariantKey: string): void {
  const pattern = new RegExp(
    PLANNED_NODE_TEST_PROTOCOL.childEnvironmentContract.requiredSuiteVariantKeyPattern,
    "u",
  );
  if (!pattern.test(suiteVariantKey)) {
    throw new Error("planned_node_test_hostile_environment_variant_key_invalid");
  }
}

function createDeniedCanaries(): Readonly<Record<DeniedCanaryKey, string>> {
  return Object.freeze(Object.fromEntries(DENIED_CANARY_KEYS.map((key, index) => [
    key,
    `synthetic-planned-node-test-denied-${index}-${key.toLowerCase()}`,
  ])) as Record<DeniedCanaryKey, string>);
}
