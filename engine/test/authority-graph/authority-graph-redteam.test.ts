import assert from "node:assert/strict";
import test from "node:test";

import { sha256 } from "../../src/kernel/integrity.ts";
import {
  analyzeAuthorityGraph,
  createAuthoritySourceInventory,
  type AuthorityGraphInput,
  type AuthorityRegistry,
  type AuthorityRoleException,
} from "../../scripts/verification/authority-graph.ts";
import {
  analyze,
  BASE_SOURCES,
  declaredUniverse,
  discoveredUniverse,
  has,
  registry,
  source,
} from "../support/authority-graph-fixture.ts";

const LITERAL_OWNER = source("src/literal-owner.ts", `export const VERSION = "domain/v4";`);
const LITERAL_AUTHORITY: AuthorityRegistry["authorities"][number] = {
  id: "version",
  kind: "literal",
  owner: { path: LITERAL_OWNER.path, exportName: "VERSION" },
};
const SHAPE_OWNER = source("src/shape-owner.ts", `
  import { z } from "zod";
  export const SCOPE = z.strictObject({ a: z.string(), b: z.string() });
`);
const SHAPE_AUTHORITY: AuthorityRegistry["authorities"][number] = {
  id: "scope",
  kind: "zod-strict-object",
  owner: { path: SHAPE_OWNER.path, exportName: "SCOPE" },
};

function literalRegistry(sources: Parameters<typeof registry>[0], options: Parameters<typeof registry>[1] = {}) {
  return registry(sources, { ...options, authorities: [LITERAL_AUTHORITY] });
}

function shapeRegistry(sources: Parameters<typeof registry>[0], options: Parameters<typeof registry>[1] = {}) {
  return registry(sources, { ...options, authorities: [SHAPE_AUTHORITY] });
}

test("[AG-R001] caller-minted inventories and universe labels never establish public trust", () => {
  const ownerOnly = analyze([LITERAL_OWNER], literalRegistry([LITERAL_OWNER]));
  assert.equal(ownerOnly.ok, false);
  for (const violation of [
    "authority_source_inventory_untrusted",
    "authority_universe_attestation_untrusted",
    "authority_adapter_qualification_untrusted:typescript",
    "authority_derivation_inventory_unavailable",
  ]) assert.equal(has(ownerOnly, violation), true, ownerOnly.violations.join("\n"));

  const invented = discoveredUniverse({
    agents: ["invented-agent"],
    providers: ["invented-provider"],
    operations: ["invented-operation"],
    lifecycleStages: ["invented-stage"],
  });
  const inventedResult = analyze(
    [LITERAL_OWNER],
    literalRegistry([LITERAL_OWNER], { universe: invented }),
    invented,
  );
  assert.equal(has(inventedResult, "authority_universe_attestation_untrusted"), true);

  const disguised = source("src/not-typescript.py", `export const VERSION = "domain/v4";`);
  const disguisedAuthority = { ...LITERAL_AUTHORITY, owner: { path: disguised.path, exportName: "VERSION" } };
  const disguisedResult = analyze([disguised], registry([disguised], { authorities: [disguisedAuthority] }));
  assert.equal(has(disguisedResult, "authority_source_inventory_untrusted"), true);

  const forgedInventory = {
    ...createAuthoritySourceInventory([LITERAL_OWNER], "caller-forged-root"),
    provenance: "safe-repository-reader/v1",
  };
  const forgedResult = analyzeAuthorityGraph({
    registry: literalRegistry([LITERAL_OWNER]),
    sources: [LITERAL_OWNER],
    discoveredUniverse: declaredUniverse([LITERAL_OWNER]),
    sourceInventory: forgedInventory,
  } as unknown as AuthorityGraphInput);
  assert.equal(has(forgedResult, "authority_source_inventory_untrusted"), true);

  const ghostUniverse = discoveredUniverse({
    layers: ["ghost-layer", "verification"], realms: ["builder", "ghost-realm"], tests: ["ghost-test", "test"],
  });
  const ghostResult = analyze(
    [LITERAL_OWNER], literalRegistry([LITERAL_OWNER], { universe: ghostUniverse }), ghostUniverse,
  );
  assert.equal(has(ghostResult, "authority_universe_attestation_untrusted"), true);
});

test("[AG-R002] destructured parameters, catch bindings, and destructured constants shadow schema imports", () => {
  const scenarios = [
    `export function f({ SCOPE }: { SCOPE: { parse(v: unknown): unknown } }) {
       return SCOPE.parse({ a: "x", b: "y" });
     }`,
    `export function f() { try { throw 1; } catch (SCOPE) {
       return SCOPE.parse({ a: "x", b: "y" });
     } }`,
    `declare const fake: any; export function f() { const { SCOPE } = fake;
       return SCOPE.parse({ a: "x", b: "y" });
     }`,
    `export function f() { if (true) { var SCOPE = { parse: (value: unknown) => value }; }
       return SCOPE.parse({ a: "x", b: "y" });
     }`,
    `export const holder = { f({ SCOPE }: { SCOPE: { parse(v: unknown): unknown } }) {
       return SCOPE.parse({ a: "x", b: "y" });
     } };`,
  ];
  for (const [index, body] of scenarios.entries()) {
    const consumer = source(`src/shadow-${index}.ts`, `import { SCOPE } from "./shape-owner.ts"; ${body}`);
    const sources = [SHAPE_OWNER, consumer];
    const result = analyze(sources, shapeRegistry(sources));
    assert.equal(result.lock.occurrences.some((entry) =>
      entry.path === consumer.path && entry.role === "materialization"), false, result.violations.join("\n"));
    assert.equal(result.lock.occurrences.some((entry) =>
      entry.path === consumer.path && entry.role === "reference"), false, result.violations.join("\n"));
    assert.equal(has(result, `authority_shape_duplicate:scope:${consumer.path}`), true, result.violations.join("\n"));
  }

  const loop = source("src/loop-shadow.ts", `
    import { SCOPE } from "./shape-owner.ts";
    export function f(values: readonly { parse(v: unknown): unknown }[]) {
      for (const SCOPE of values) SCOPE.parse({ a: "local", b: "local" });
      return SCOPE.parse({ a: "import", b: "import" });
    }
  `);
  const loopSources = [SHAPE_OWNER, loop];
  const loopResult = analyze(loopSources, shapeRegistry(loopSources));
  assert.equal(loopResult.lock.occurrences.filter((entry) =>
    entry.path === loop.path && entry.role === "materialization").length, 1, loopResult.violations.join("\n"));
});

test("[AG-R003] provable namespace, barrel, and mjs imports materialize; unresolved aliases block", () => {
  const namespace = source("src/namespace.ts", `
    import * as contracts from "./shape-owner";
    export const value = contracts.SCOPE.parse({ a: "x", b: "y" });
  `);
  const namespaceResult = analyze([SHAPE_OWNER, namespace], shapeRegistry([SHAPE_OWNER, namespace]));
  assert.ok(namespaceResult.lock.occurrences.some((entry) =>
    entry.path === namespace.path && entry.role === "materialization"));

  const barrel = source("src/barrel.ts", `export { SCOPE } from "./shape-owner.ts";`);
  const barrelConsumer = source("src/barrel-consumer.ts", `
    import { SCOPE } from "./barrel";
    export const value = SCOPE.parse({ a: "x", b: "y" });
  `);
  const barrelSources = [SHAPE_OWNER, barrel, barrelConsumer];
  const barrelResult = analyze(barrelSources, shapeRegistry(barrelSources));
  assert.ok(barrelResult.lock.occurrences.some((entry) =>
    entry.path === barrelConsumer.path && entry.role === "materialization"));

  const mtsOwner = source("src/mts-owner.mts", SHAPE_OWNER.source);
  const mtsAuthority = { ...SHAPE_AUTHORITY, owner: { path: mtsOwner.path, exportName: "SCOPE" } };
  const mjsConsumer = source("src/mjs-consumer.ts", `
    import { SCOPE } from "./mts-owner.mjs";
    export const value = SCOPE.parse({ a: "x", b: "y" });
  `);
  const mtsSources = [mtsOwner, mjsConsumer];
  const mtsResult = analyze(mtsSources, registry(mtsSources, { authorities: [mtsAuthority] }));
  assert.ok(mtsResult.lock.occurrences.some((entry) =>
    entry.path === mjsConsumer.path && entry.role === "materialization"));

  const alias = source("src/alias.ts", `
    import { SCOPE } from "@app/shape-owner";
    export const value = SCOPE.parse({ a: "x", b: "y" });
  `);
  const aliasResult = analyze([SHAPE_OWNER, alias], shapeRegistry([SHAPE_OWNER, alias]));
  assert.equal(has(aliasResult, `authority_import_resolution_unsupported:${alias.path}`), true);
});

test("[AG-R004] unknown Zod transforms and external spreads block while computed keys are detected", () => {
  const cases = [{
    name: "nullable",
    source: `import { z } from "zod";
      export const COPY = z.strictObject({ a: z.string().nullable(), b: z.string().nullable() });`,
    violation: "authority_shape_unsupported:scope",
  }, {
    name: "computed",
    source: `import { z } from "zod"; const A = "a", B = "b";
      export const COPY = z.strictObject({ [A]: z.string(), [B]: z.string() });`,
    violation: "authority_shape_duplicate:scope",
  }, {
    name: "external-spread",
    source: `import { z } from "zod"; import { FIELDS } from "shared-fields";
      export const COPY = z.strictObject({ ...FIELDS });`,
    violation: "authority_shape_unsupported:scope",
  }];
  for (const scenario of cases) {
    const candidate = source(`src/zod-${scenario.name}.ts`, scenario.source);
    const sources = [SHAPE_OWNER, candidate];
    const result = analyze(sources, shapeRegistry(sources));
    assert.equal(has(result, scenario.violation), true, result.violations.join("\n"));
  }
});

test("[AG-R005] deterministic runtime string encodings resolve without blocking unrelated calls", () => {
  const copies = [
    `["domain", "v4"].join("/")`,
    `"domainXv4".replace("X", "/")`,
    `String.fromCharCode(100, 111, 109, 97, 105, 110, 47, 118, 52)`,
    `Buffer.from("ZG9tYWluL3Y0", "base64").toString()`,
    `"DOMAIN/V4".toLowerCase()`,
    `"d0main/v4".replace("0", "o")`,
  ];
  for (const [index, expression] of copies.entries()) {
    const candidate = source(`src/dynamic-${index}.ts`, `export const COPY = ${expression};`);
    const sources = [LITERAL_OWNER, candidate];
    const result = analyze(sources, literalRegistry(sources));
    assert.equal(has(result, `authority_literal_duplicate:version:${candidate.path}`), true,
      `${expression}: ${result.violations.join("\n")}`);
  }
  const unrelated = source("src/unrelated-call.ts", `
    declare function unrelated(base: string, value: number): void;
    unrelated("domain", 4);
  `);
  const unrelatedResult = analyze([LITERAL_OWNER, unrelated], literalRegistry([LITERAL_OWNER, unrelated]));
  assert.equal(unrelatedResult.violations.some((entry) =>
    entry.startsWith("authority_literal_duplicate:version") ||
    entry.startsWith("authority_literal_unsupported:version")), false, unrelatedResult.violations.join("\n"));
});

test("[AG-R006] symmetric and third-copy distinct-domain claims never self-prove", () => {
  const first = source("src/a.ts", `export const VERSION = "domain/v4";`);
  const second = source("src/b.ts", `export const VERSION = "domain/v4";`);
  const third = source("src/c.ts", `export const COPY = "domain/v4";`);
  const authorities: AuthorityRegistry["authorities"] = [{
    id: "a.version", kind: "literal", owner: { path: first.path, exportName: "VERSION" },
  }, {
    id: "b.version", kind: "literal", owner: { path: second.path, exportName: "VERSION" },
  }];
  const sources = [first, second, third];
  const baseline = analyze(sources, registry(sources, { authorities }));
  const pairs = [
    ["a.version", second.path, "b.version"],
    ["b.version", first.path, "a.version"],
    ["a.version", third.path, "b.version"],
    ["b.version", third.path, "a.version"],
  ] as const;
  const exceptions: AuthorityRoleException[] = pairs.map(([authorityId, path, distinctAuthorityId]) => {
    const occurrence = baseline.lock.occurrences.find((entry) =>
      entry.authorityId === authorityId && entry.path === path && entry.role === "duplicate")!;
    const sourceEntry = sources.find((entry) => entry.path === path)!;
    return {
      authorityId,
      path,
      selector: occurrence.selector,
      sourceSha256: sha256(sourceEntry.source),
      role: "distinct-domain" as const,
      distinctAuthorityId,
      rationale: "Unproven symmetric claim.",
      evidenceLinks: [`https://unresolved.invalid/${authorityId}/${path}`],
    };
  }).toSorted((left, right) => {
    const leftKey = JSON.stringify([left.authorityId, left.path, left.selector]);
    const rightKey = JSON.stringify([right.authorityId, right.path, right.selector]);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  const result = analyze(sources, registry(sources, { authorities, exceptions }));
  assert.equal(result.lock.occurrences.some((entry) => entry.role === "distinct-domain"), false);
  assert.equal(result.violations.filter((entry) => entry.startsWith("authority_exception_role_unproven")).length, 4);
});

test("[AG-R011] byte-identical shape authorities cannot mutually self-prove distinct domains", () => {
  const first = source("src/a-shape.ts", `
    import { z } from "zod"; export const SCOPE = z.strictObject({ a: z.string(), b: z.string() });
  `);
  const second = source("src/b-shape.ts", first.source);
  const authorities: AuthorityRegistry["authorities"] = [{
    id: "a.scope", kind: "zod-strict-object", owner: { path: first.path, exportName: "SCOPE" },
  }, {
    id: "b.scope", kind: "zod-strict-object", owner: { path: second.path, exportName: "SCOPE" },
  }];
  const sources = [first, second];
  const baseline = analyze(sources, registry(sources, { authorities }));
  const exceptions: AuthorityRoleException[] = [{
    authorityId: "a.scope", path: second.path, distinctAuthorityId: "b.scope",
  }, {
    authorityId: "b.scope", path: first.path, distinctAuthorityId: "a.scope",
  }].map((entry) => ({
    ...entry,
    selector: baseline.lock.occurrences.find((occurrence) =>
      occurrence.authorityId === entry.authorityId && occurrence.path === entry.path &&
      occurrence.role === "duplicate")!.selector,
    sourceSha256: sha256(sources.find((sourceEntry) => sourceEntry.path === entry.path)!.source),
    role: "distinct-domain" as const,
    rationale: "Symmetric shape claim.",
    evidenceLinks: [`https://unresolved.invalid/${entry.authorityId}`],
  })).toSorted((left, right) => left.authorityId < right.authorityId ? -1 : 1);
  const result = analyze(sources, registry(sources, { authorities, exceptions }));
  assert.equal(result.lock.occurrences.some((entry) => entry.role === "distinct-domain"), false);
  assert.equal(result.violations.filter((entry) => entry.startsWith("authority_exception_role_unproven")).length, 2);
});

test("[AG-R007] malformed applicability and source metadata are strict and nonthrowing", () => {
  for (const cell of [
    { authorityId: "version", dimension: "bogus", member: LITERAL_OWNER.path, disposition: "garbage" },
    { authorityId: "version", dimension: 12, member: LITERAL_OWNER.path, disposition: "applies" },
    { authorityId: "version", dimension: "modules", member: LITERAL_OWNER.path, disposition: { bad: true } },
  ]) {
    const value = structuredClone(literalRegistry([LITERAL_OWNER])) as any;
    value.applicability.cells = [cell];
    const result = analyze([LITERAL_OWNER], value);
    assert.equal(has(result, "authority_registry_applicability_cell_invalid"), true, result.violations.join("\n"));
  }
  for (const [name, metadata] of [
    ["layer", { layer: 42 }], ["realm", { realm: { bad: true } }], ["test", { testId: true }],
  ] as const) {
    const malformed = { ...source(`src/bad-${name}.ts`, `export const X = 1;`), ...metadata };
    const result = analyze([LITERAL_OWNER, malformed as any], literalRegistry([LITERAL_OWNER, malformed as any]));
    assert.equal(has(result, "authority_source_metadata_invalid"), true, result.violations.join("\n"));
  }
});

test("[AG-R008] control, bidi, and non-NFC paths are rejected", () => {
  const paths = ["src/\nowner.ts", "src/\rowner.ts", "src/\u202Eowner.ts", "src/e\u0301.ts"];
  for (const path of paths) {
    const owner = source(path, `export const VERSION = "domain/v4";`);
    const authority = { ...LITERAL_AUTHORITY, owner: { path, exportName: "VERSION" } };
    const result = analyze([owner], registry([owner], { authorities: [authority] }));
    assert.equal(has(result, "authority_source_invalid"), true, JSON.stringify(result.violations));
    assert.equal(has(result, "authority_registry_route_invalid"), true, JSON.stringify(result.violations));
  }
});

test("[AG-R009] unknown runtime values and one-field overlap do not become unrelated shape copies", () => {
  const unknown = source("src/unknown.ts", `
    declare function value(): number;
    export const DIFFERENT = { a: value(), b: value() };
  `);
  const partial = source("src/partial.ts", `export const UNRELATED = { a: "x" };`);
  const sources = [SHAPE_OWNER, unknown, partial];
  const result = analyze(sources, shapeRegistry(sources));
  for (const candidate of [unknown, partial]) {
    assert.equal(result.violations.some((entry) =>
      entry.startsWith(`authority_shape_duplicate:scope:${candidate.path}`)), false,
    result.violations.join("\n"));
  }
});

test("[AG-R010] fixture universe includes universal artifact, operation, and lifecycle dimensions", () => {
  const universe = declaredUniverse(BASE_SOURCES, discoveredUniverse());
  assert.deepEqual(universe.artifactKinds, ["source"]);
  assert.deepEqual(universe.operations, ["analyze"]);
  assert.deepEqual(universe.lifecycleStages, ["verification"]);
});
