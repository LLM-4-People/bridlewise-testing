import {
  analyzeAuthorityGraph,
  AUTHORITY_REGISTRY_SCHEMA_VERSION,
  createAuthoritySourceInventory,
  TYPESCRIPT_AUTHORITY_ADAPTER_ID,
  type AuthorityGraphInput,
  type AuthorityRegistry,
  type AuthoritySource,
  type AuthorityUniverse,
} from "../../scripts/verification/authority-graph.ts";

export const EXPECTED_FOUNDATION_BLOCKERS = [
  "authority_adapter_qualification_untrusted:typescript",
  "authority_derivation_inventory_unavailable",
  "authority_source_inventory_untrusted",
  "authority_universe_attestation_untrusted",
] as const;

export const OWNER_SOURCE = `import { z } from "zod";
export const CURRENT_VERSION = "example.test-result/v4";
export const SCOPE_SCHEMA = z.strictObject({
  dispositionManifestHash: z.string(),
  canonicalNodeSourceIds: z.array(z.string()),
  fullRepositoryTestQualificationComplete: z.boolean(),
});
`;

export const CONSUMER_SOURCE = `import { CURRENT_VERSION, SCOPE_SCHEMA } from "./owner.ts";
export const emitted = { schemaVersion: CURRENT_VERSION };
export const parsed = SCOPE_SCHEMA.parse({
  dispositionManifestHash: "a",
  canonicalNodeSourceIds: [],
  fullRepositoryTestQualificationComplete: true,
});
`;

export const BASE_SOURCES: readonly AuthoritySource[] = [
  source("src/owner.ts", OWNER_SOURCE),
  source("src/consumer.ts", CONSUMER_SOURCE),
];

export function source(path: string, text: string, language = "typescript"): AuthoritySource {
  return { path, language, source: text, layer: "verification", realm: "builder" };
}

export function discoveredUniverse(
  overrides: Partial<Record<keyof AuthorityUniverse, readonly string[]>> = {},
): AuthorityUniverse {
  return {
    realms: ["builder", "harness"],
    modules: [],
    layers: ["verification"],
    languages: [],
    agents: ["foreground-agent"],
    tools: ["candidate-editor"],
    providers: ["provider-neutral"],
    extensions: ["core"],
    tests: ["authority-graph-hostile"],
    artifactKinds: ["source"],
    operations: ["analyze"],
    lifecycleStages: ["verification"],
    ...overrides,
  };
}

export function declaredUniverse(
  sources: readonly AuthoritySource[],
  discovered = discoveredUniverse(),
): AuthorityUniverse {
  return {
    realms: [...new Set([...discovered.realms, ...sources.flatMap((entry) => entry.realm ? [entry.realm] : [])])]
      .toSorted(),
    modules: [...new Set([...discovered.modules, ...sources.map((entry) => entry.path)])].toSorted(),
    layers: [...new Set([...discovered.layers, ...sources.flatMap((entry) => entry.layer ? [entry.layer] : [])])]
      .toSorted(),
    languages: [...new Set([...discovered.languages, ...sources.map((entry) => entry.language)])].toSorted(),
    agents: [...discovered.agents].toSorted(),
    tools: [...discovered.tools].toSorted(),
    providers: [...discovered.providers].toSorted(),
    extensions: [...discovered.extensions].toSorted(),
    tests: [...new Set([...discovered.tests, ...sources.flatMap((entry) => entry.testId ? [entry.testId] : [])])]
      .toSorted(),
    artifactKinds: [...discovered.artifactKinds].toSorted(),
    operations: [...discovered.operations].toSorted(),
    lifecycleStages: [...discovered.lifecycleStages].toSorted(),
  };
}

export function registry(
  sources: readonly AuthoritySource[] = BASE_SOURCES,
  options: Readonly<{
    exceptions?: AuthorityRegistry["roleExceptions"];
    generators?: AuthorityRegistry["generators"];
    adapters?: AuthorityRegistry["adapters"];
    universe?: AuthorityUniverse;
    cells?: AuthorityRegistry["applicability"]["cells"];
    authorities?: AuthorityRegistry["authorities"];
  }> = {},
): AuthorityRegistry {
  const universe = options.universe ?? discoveredUniverse();
  return {
    schemaVersion: AUTHORITY_REGISTRY_SCHEMA_VERSION,
    authorities: options.authorities ?? [{
      id: "receipt.version",
      kind: "literal",
      owner: { path: "src/owner.ts", exportName: "CURRENT_VERSION" },
    }, {
      id: "test.surface.scope",
      kind: "zod-strict-object",
      owner: { path: "src/owner.ts", exportName: "SCOPE_SCHEMA" },
    }],
    roleExceptions: options.exceptions ?? [],
    generators: options.generators ?? [],
    adapters: options.adapters ?? [{
      language: "typescript",
      adapterId: TYPESCRIPT_AUTHORITY_ADAPTER_ID,
      status: "qualified",
    }],
    applicability: {
      defaultDisposition: "applies",
      declaredUniverse: declaredUniverse(sources, universe),
      cells: options.cells ?? [],
    },
  };
}

export function analyze(
  sources: readonly AuthoritySource[] = BASE_SOURCES,
  registryValue = registry(sources),
  universe = discoveredUniverse(),
) {
  const input: AuthorityGraphInput = {
    registry: registryValue,
    sources,
    discoveredUniverse: declaredUniverse(sources, universe),
    sourceInventory: createAuthoritySourceInventory(sources, "caller-asserted-test-root"),
  };
  return analyzeAuthorityGraph(input);
}

export function has(result: ReturnType<typeof analyze>, prefix: string): boolean {
  return result.violations.some((violation) => violation.startsWith(prefix));
}

export function assertOnlyFoundationBlockers(result: ReturnType<typeof analyze>): boolean {
  return result.violations.every((violation) => EXPECTED_FOUNDATION_BLOCKERS.some((prefix) =>
    violation.startsWith(prefix)));
}

export function runScenario(assertion: (repetition: number) => void): void {
  assertion(0);
}
