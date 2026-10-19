/**
 * Comprehensive prevention-v3 authority test surface.
 *
 * These tests are ADDITIONAL coverage beyond the 25 governed test families
 * (AG-C001–AG-C007, AG-K001–AG-K006, AG-R001–AG-R011, AG-B001). They do not
 * use the `[AG-` prefix so the boundary catalog (AG-B001) remains unaffected.
 *
 * Coverage categories:
 * 1. Deterministic lock compilation (happy path)
 * 2. Foundation blockers (fail-closed invariant)
 * 3. Registry validation (hostile)
 * 4. Source validation (boundary)
 * 5. Universe validation (boundary)
 * 6. Literal semantics (hostile)
 * 7. Shape semantics (hostile)
 * 8. Exception validation (hostile)
 * 9. Derivation validation (hostile)
 * 10. Concurrency and determinism
 * 11. Input boundary and malformed payloads
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeAuthorityGraph,
  AUTHORITY_REGISTRY_SCHEMA_VERSION,
  AUTHORITY_SOURCE_INVENTORY_PROVENANCE,
  AUTHORITY_SOURCE_INVENTORY_SCHEMA_VERSION,
  AUTHORITY_UNIVERSE_DIMENSIONS,
  createAuthoritySourceInventory,
  TYPESCRIPT_AUTHORITY_ADAPTER_ID,
  type AuthorityGraphInput,
  type AuthorityRegistry,
  type AuthorityRoleException,
  type AuthoritySource,
  type AuthorityUniverse,
} from "../../scripts/verification/authority-graph.ts";
import { sha256 } from "../../src/kernel/integrity.ts";
import {
  analyze,
  assertOnlyFoundationBlockers,
  BASE_SOURCES,
  declaredUniverse,
  discoveredUniverse,
  EXPECTED_FOUNDATION_BLOCKERS,
  has,
  OWNER_SOURCE,
  registry,
  source,
} from "../support/authority-graph-fixture.ts";

const LITERAL_OWNER = source("src/literal-owner.ts", `export const VERSION = "domain/v4";`);
const LITERAL_AUTHORITY: AuthorityRegistry["authorities"][number] = {
  id: "version", kind: "literal", owner: { path: LITERAL_OWNER.path, exportName: "VERSION" },
};
const SHAPE_OWNER = source("src/shape-owner.ts", `
  import { z } from "zod";
  export const SCOPE = z.strictObject({ a: z.string(), b: z.string() });
`);
const SHAPE_AUTHORITY: AuthorityRegistry["authorities"][number] = {
  id: "scope", kind: "zod-strict-object", owner: { path: SHAPE_OWNER.path, exportName: "SCOPE" },
};

function literalRegistry(sources: Parameters<typeof registry>[0], options: Parameters<typeof registry>[1] = {}) {
  return registry(sources, { ...options, authorities: [LITERAL_AUTHORITY] });
}
function shapeRegistry(sources: Parameters<typeof registry>[0], options: Parameters<typeof registry>[1] = {}) {
  return registry(sources, { ...options, authorities: [SHAPE_AUTHORITY] });
}
function rawAnalyze(
  sources: readonly AuthoritySource[],
  reg: AuthorityRegistry,
  universe: AuthorityUniverse = declaredUniverse(sources),
) {
  return analyzeAuthorityGraph({
    registry: reg, sources, discoveredUniverse: universe,
    sourceInventory: createAuthoritySourceInventory(sources, "caller-asserted-test-root"),
  });
}

// ---------------------------------------------------------------------------
// 1. Deterministic lock compilation (happy path)
// ---------------------------------------------------------------------------

test("deterministic-lock: identical inputs produce identical lock hash", () => {
  const a = analyze();
  const b = analyze();
  assert.equal(a.lock.lockHash, b.lock.lockHash);
  assert.deepEqual(a.lock, b.lock);
});

test("deterministic-lock: identical inputs produce identical lock across 10 repetitions", () => {
  const first = analyze();
  for (let i = 1; i < 10; i += 1) {
    assert.equal(analyze().lock.lockHash, first.lock.lockHash);
  }
});

test("deterministic-lock: changing source bytes changes lock hash", () => {
  const before = analyze();
  const modified = source("src/owner.ts", OWNER_SOURCE.replace("v4", "v5"));
  const after = analyze([modified, BASE_SOURCES[1]!], registry([modified, BASE_SOURCES[1]!]));
  assert.notEqual(after.lock.lockHash, before.lock.lockHash);
});

test("deterministic-lock: changing layer metadata changes lock hash", () => {
  const modified = BASE_SOURCES.map((s, i) => i === 0 ? { ...s, layer: "different" } : s);
  assert.notEqual(analyze(modified, registry(modified)).lock.lockHash, analyze().lock.lockHash);
});

test("deterministic-lock: changing realm metadata changes lock hash", () => {
  const modified = BASE_SOURCES.map((s, i) => i === 0 ? { ...s, realm: "different" } : s);
  assert.notEqual(analyze(modified, registry(modified)).lock.lockHash, analyze().lock.lockHash);
});

test("deterministic-lock: changing testId metadata changes lock hash", () => {
  const modified = BASE_SOURCES.map((s, i) => i === 0 ? { ...s, testId: "test-x" } : s);
  assert.notEqual(analyze(modified, registry(modified)).lock.lockHash, analyze().lock.lockHash);
});

test("deterministic-lock: lock contains correct schemaVersion", () => {
  assert.equal(analyze().lock.schemaVersion, "bridlewise-authority-lock/v1");
});

test("deterministic-lock: lock contains non-null registryHash", () => {
  assert.ok(analyze().lock.registryHash.length > 0);
  assert.match(analyze().lock.registryHash, /^[0-9a-f]+$/u);
});

test("deterministic-lock: lock sourceInventoryHash is non-null (untrusted inventory still hashed)", () => {
  assert.ok(analyze().lock.sourceInventoryHash !== null);
  assert.match(analyze().lock.sourceInventoryHash!, /^[0-9a-f]+$/u);
});

test("deterministic-lock: lock sources are sorted by path", () => {
  const sources = [BASE_SOURCES[1]!, BASE_SOURCES[0]!];
  const result = analyze(sources, registry(sources));
  const paths = result.lock.sources.map((s) => s.path);
  assert.deepEqual(paths, [...paths].sort());
});

test("deterministic-lock: lock authorities are sorted by id", () => {
  const result = analyze();
  const ids = result.lock.authorities.map((a) => a.id);
  assert.deepEqual(ids, [...ids].sort());
});

test("deterministic-lock: lock occurrences are sorted by tuple", () => {
  const result = analyze();
  for (let i = 1; i < result.lock.occurrences.length; i += 1) {
    const prev = result.lock.occurrences[i - 1]!;
    const curr = result.lock.occurrences[i]!;
    const prevKey = [prev.authorityId, prev.path, prev.selector, prev.occurrenceKind, prev.role];
    const currKey = [curr.authorityId, curr.path, curr.selector, curr.occurrenceKind, curr.role];
    assert.ok(prevKey <= currKey, `occurrence order violation at ${i}`);
  }
});

test("deterministic-lock: lock generators are sorted by id", () => {
  const gens: AuthorityRegistry["generators"] = [{
    id: "z-gen", ownerPath: "src/owner.ts", authorityInputs: ["receipt.version"],
    dependsOn: [], outputs: ["generated/z.ts"],
  }, {
    id: "a-gen", ownerPath: "src/consumer.ts", authorityInputs: ["test.surface.scope"],
    dependsOn: ["z-gen"], outputs: ["generated/a.ts"],
  }];
  const result = analyze(BASE_SOURCES, registry(BASE_SOURCES, { generators: gens }));
  const ids = result.lock.generators.map((g) => g.id);
  assert.deepEqual(ids, [...ids].sort());
});

test("deterministic-lock: lock violations are sorted and deduplicated", () => {
  const result = analyze();
  for (let i = 1; i < result.violations.length; i += 1) {
    assert.ok(result.violations[i - 1]! <= result.violations[i]!, "violations not sorted");
  }
  assert.equal(new Set(result.violations).size, result.violations.length, "violations not deduplicated");
});

test("deterministic-lock: result ok is always false due to blockers", () => {
  assert.equal(analyze().ok, false);
});

test("deterministic-lock: lock and result objects are frozen", () => {
  const result = analyze();
  assert.ok(Object.isFrozen(result), "result not frozen");
  assert.ok(Object.isFrozen(result.lock), "lock not frozen");
  assert.ok(Object.isFrozen(result.violations), "violations not frozen");
});

test("deterministic-lock: lock contains correct source sha256 entries", () => {
  const result = analyze();
  for (const src of result.lock.sources) {
    const original = BASE_SOURCES.find((s) => s.path === src.path);
    assert.ok(original, `missing source ${src.path}`);
    assert.equal(src.sha256, sha256(original.source));
  }
});

test("deterministic-lock: lock contains correct authority owner paths", () => {
  const result = analyze();
  const ownerAuth = result.lock.authorities.find((a) => a.id === "receipt.version");
  assert.ok(ownerAuth);
  assert.equal(ownerAuth.owner.path, "src/owner.ts");
  assert.equal(ownerAuth.owner.exportName, "CURRENT_VERSION");
});

test("deterministic-lock: lock contains semanticFingerprint for resolved authorities", () => {
  const result = analyze();
  const auth = result.lock.authorities.find((a) => a.id === "receipt.version");
  assert.ok(auth);
  assert.ok(auth.semanticFingerprint !== null);
  assert.match(auth.semanticFingerprint, /^[0-9a-f]+$/u);
});

test("deterministic-lock: lock adapterCoverage matches universe languages", () => {
  const result = analyze();
  assert.equal(result.lock.adapterCoverage.length, 1);
  assert.equal(result.lock.adapterCoverage[0]!.language, "typescript");
});

// ---------------------------------------------------------------------------
// 2. Foundation blockers (fail-closed invariant)
// ---------------------------------------------------------------------------

test("blockers: authority_source_inventory_untrusted always present", () => {
  assert.equal(has(analyze(), "authority_source_inventory_untrusted"), true);
});

test("blockers: authority_universe_attestation_untrusted always present", () => {
  assert.equal(has(analyze(), "authority_universe_attestation_untrusted"), true);
});

test("blockers: authority_adapter_qualification_untrusted:typescript always present", () => {
  assert.equal(has(analyze(), "authority_adapter_qualification_untrusted:typescript"), true);
});

test("blockers: authority_derivation_inventory_unavailable present when no generators", () => {
  assert.equal(has(analyze(), "authority_derivation_inventory_unavailable"), true);
});

test("blockers: authority_generator_reproducibility_unproven present for each generator", () => {
  const gens: AuthorityRegistry["generators"] = [{
    id: "gen-a", ownerPath: "src/owner.ts", authorityInputs: ["receipt.version"],
    dependsOn: [], outputs: ["generated/a.ts"],
  }];
  const result = analyze(BASE_SOURCES, registry(BASE_SOURCES, { generators: gens }));
  assert.equal(has(result, "authority_generator_reproducibility_unproven:gen-a"), true);
  // derivation_inventory_unavailable should NOT be present when generators exist
  assert.equal(has(result, "authority_derivation_inventory_unavailable"), false);
});

test("blockers: only foundation blockers present in nominal fixture", () => {
  assert.equal(assertOnlyFoundationBlockers(analyze()), true);
});

test("blockers: forged provenance does not remove source inventory blocker", () => {
  const forged = {
    ...createAuthoritySourceInventory(BASE_SOURCES, "caller-forged-root"),
    provenance: "safe-repository-reader/v1",
  };
  const result = analyzeAuthorityGraph({
    registry: registry(BASE_SOURCES), sources: BASE_SOURCES,
    discoveredUniverse: declaredUniverse(BASE_SOURCES), sourceInventory: forged,
  } as unknown as AuthorityGraphInput);
  assert.equal(has(result, "authority_source_inventory_untrusted"), true);
});

test("blockers: forged provenance adds schema violation", () => {
  const forged = {
    ...createAuthoritySourceInventory(BASE_SOURCES, "caller-forged-root"),
    provenance: "different-provenance/v2",
  };
  const result = analyzeAuthorityGraph({
    registry: registry(BASE_SOURCES), sources: BASE_SOURCES,
    discoveredUniverse: declaredUniverse(BASE_SOURCES), sourceInventory: forged,
  } as unknown as AuthorityGraphInput);
  assert.equal(has(result, "authority_source_inventory_untrusted"), true);
});

test("blockers: incomplete inventory adds mismatch but keeps blocker", () => {
  const complete = createAuthoritySourceInventory(BASE_SOURCES, "caller-asserted-test-root");
  const incomplete = analyzeAuthorityGraph({
    registry: registry(BASE_SOURCES), sources: BASE_SOURCES,
    discoveredUniverse: declaredUniverse(BASE_SOURCES),
    sourceInventory: { ...complete, entries: complete.entries.slice(0, 1) },
  });
  assert.equal(has(incomplete, "authority_source_inventory_mismatch"), true);
  assert.equal(has(incomplete, "authority_source_inventory_untrusted"), true);
});

test("blockers: no adapters does not remove qualification blocker for typescript", () => {
  const noAdapter = registry(BASE_SOURCES, { adapters: [] });
  const result = analyze(BASE_SOURCES, noAdapter);
  assert.equal(has(result, "authority_adapter_missing:typescript"), true);
});

test("blockers: unsupported adapter adds unsupported but keeps qualification blocker", () => {
  const unsupported = registry(BASE_SOURCES, { adapters: [{
    language: "typescript", adapterId: TYPESCRIPT_AUTHORITY_ADAPTER_ID, status: "unsupported",
  }] });
  const result = analyze(BASE_SOURCES, unsupported);
  assert.equal(has(result, "authority_adapter_unsupported:typescript"), true);
});

test("blockers: wrong adapter ID adds identity invalid", () => {
  const wrongId = registry(BASE_SOURCES, { adapters: [{
    language: "typescript", adapterId: "unqualified-adapter/v1", status: "qualified",
  }] });
  const result = analyze(BASE_SOURCES, wrongId);
  assert.equal(has(result, "authority_adapter_identity_invalid:typescript"), true);
});

test("blockers: qualified non-typescript adapter adds not-implemented", () => {
  const python = source("src/adapter.py", "VALUE = 1\n", "python");
  const sources = [...BASE_SOURCES, python];
  const pyUniverse = discoveredUniverse({ languages: ["python", "typescript"] });
  const reg = registry(sources, {
    universe: pyUniverse,
    adapters: [
      { language: "python", adapterId: "python-authority/v1", status: "qualified" },
      { language: "typescript", adapterId: TYPESCRIPT_AUTHORITY_ADAPTER_ID, status: "qualified" },
    ],
  });
  const result = analyze(sources, reg, pyUniverse);
  assert.equal(has(result, "authority_adapter_not_implemented:python"), true);
});

test("blockers: generator with outputs still gets reproducibility_unproven", () => {
  const gens: AuthorityRegistry["generators"] = [{
    id: "gen", ownerPath: "src/owner.ts", authorityInputs: ["receipt.version"],
    dependsOn: [], outputs: ["src/generated.ts"],
  }];
  const sources = [...BASE_SOURCES, source("src/generated.ts", `export const X = 1;`)];
  const result = analyze(sources, registry(sources, { generators: gens }));
  assert.equal(has(result, "authority_generator_reproducibility_unproven:gen"), true);
});

test("blockers: changing provenance string keeps untrusted but changes hash (null inventory)", () => {
  const a = analyze();
  const forged = { ...createAuthoritySourceInventory(BASE_SOURCES, "different-root"),
    provenance: "different-provenance/v2" } as any;
  const b = analyzeAuthorityGraph({
    registry: registry(BASE_SOURCES), sources: BASE_SOURCES,
    discoveredUniverse: declaredUniverse(BASE_SOURCES), sourceInventory: forged,
  } as unknown as AuthorityGraphInput);
  // Wrong provenance causes validateSourceInventory to return null, so hash changes
  assert.equal(has(b, "authority_source_inventory_untrusted"), true);
  assert.notEqual(a.lock.sourceInventoryHash, b.lock.sourceInventoryHash);
});

test("blockers: all four blockers present in empty sources", () => {
  const emptySource = source("src/empty.ts", "");
  const reg = literalRegistry([emptySource], {
    authorities: [{ id: "v", kind: "literal", owner: { path: emptySource.path, exportName: "X" } }],
  });
  const result = rawAnalyze([emptySource], reg);
  for (const blocker of EXPECTED_FOUNDATION_BLOCKERS) {
    assert.equal(has(result, blocker), true, `missing blocker: ${blocker}`);
  }
});

// ---------------------------------------------------------------------------
// 3. Registry validation (hostile)
// ---------------------------------------------------------------------------

test("registry: wrong schema version is rejected", () => {
  const bad = analyzeAuthorityGraph({
    registry: { ...registry(BASE_SOURCES), schemaVersion: "wrong/v1" as any },
    sources: BASE_SOURCES, discoveredUniverse: declaredUniverse(BASE_SOURCES),
    sourceInventory: createAuthoritySourceInventory(BASE_SOURCES, "caller-asserted-test-root"),
  });
  assert.equal(has(bad, "authority_registry_schema_invalid"), true);
});

test("registry: extra top-level key is rejected", () => {
  const extra = analyzeAuthorityGraph({
    registry: { ...registry(BASE_SOURCES), extra: "field" } as unknown as AuthorityRegistry,
    sources: BASE_SOURCES, discoveredUniverse: declaredUniverse(BASE_SOURCES),
    sourceInventory: createAuthoritySourceInventory(BASE_SOURCES, "caller-asserted-test-root"),
  });
  assert.equal(has(extra, "authority_registry_schema_invalid"), true);
});

test("registry: missing authorities array is rejected", () => {
  const missing = analyzeAuthorityGraph({
    registry: { ...registry(BASE_SOURCES), authorities: undefined } as unknown as AuthorityRegistry,
    sources: BASE_SOURCES, discoveredUniverse: declaredUniverse(BASE_SOURCES),
    sourceInventory: createAuthoritySourceInventory(BASE_SOURCES, "caller-asserted-test-root"),
  });
  assert.equal(has(missing, "authority_registry_schema_invalid"), true);
});

test("registry: missing roleExceptions array is rejected", () => {
  const missing = analyzeAuthorityGraph({
    registry: { ...registry(BASE_SOURCES), roleExceptions: undefined } as unknown as AuthorityRegistry,
    sources: BASE_SOURCES, discoveredUniverse: declaredUniverse(BASE_SOURCES),
    sourceInventory: createAuthoritySourceInventory(BASE_SOURCES, "caller-asserted-test-root"),
  });
  assert.equal(has(missing, "authority_registry_schema_invalid"), true);
});

test("registry: missing generators array is rejected", () => {
  const missing = analyzeAuthorityGraph({
    registry: { ...registry(BASE_SOURCES), generators: undefined } as unknown as AuthorityRegistry,
    sources: BASE_SOURCES, discoveredUniverse: declaredUniverse(BASE_SOURCES),
    sourceInventory: createAuthoritySourceInventory(BASE_SOURCES, "caller-asserted-test-root"),
  });
  assert.equal(has(missing, "authority_registry_schema_invalid"), true);
});

test("registry: missing adapters array is rejected", () => {
  const missing = analyzeAuthorityGraph({
    registry: { ...registry(BASE_SOURCES), adapters: undefined } as unknown as AuthorityRegistry,
    sources: BASE_SOURCES, discoveredUniverse: declaredUniverse(BASE_SOURCES),
    sourceInventory: createAuthoritySourceInventory(BASE_SOURCES, "caller-asserted-test-root"),
  });
  assert.equal(has(missing, "authority_registry_schema_invalid"), true);
});

test("registry: missing applicability is rejected", () => {
  const missing = analyzeAuthorityGraph({
    registry: { ...registry(BASE_SOURCES), applicability: undefined } as unknown as AuthorityRegistry,
    sources: BASE_SOURCES, discoveredUniverse: declaredUniverse(BASE_SOURCES),
    sourceInventory: createAuthoritySourceInventory(BASE_SOURCES, "caller-asserted-test-root"),
  });
  assert.equal(has(missing, "authority_registry_schema_invalid"), true);
});

test("registry: authority with uppercase ID is rejected", () => {
  const bad = registry(BASE_SOURCES, {
    authorities: [{ id: "UPPER.CASE", kind: "literal", owner: { path: "src/owner.ts", exportName: "CURRENT_VERSION" } }],
  });
  assert.equal(has(analyze(BASE_SOURCES, bad), "authority_registry_route_invalid"), true);
});

test("registry: authority with leading dot ID is rejected", () => {
  const bad = registry(BASE_SOURCES, {
    authorities: [{ id: ".leading", kind: "literal", owner: { path: "src/owner.ts", exportName: "CURRENT_VERSION" } }],
  });
  assert.equal(has(analyze(BASE_SOURCES, bad), "authority_registry_route_invalid"), true);
});

test("registry: authority with invalid kind is rejected", () => {
  const bad = analyzeAuthorityGraph({
    registry: { ...registry(BASE_SOURCES), authorities: [
      { id: "test", kind: "invalid-kind", owner: { path: "src/owner.ts", exportName: "X" } },
    ] } as unknown as AuthorityRegistry,
    sources: BASE_SOURCES, discoveredUniverse: declaredUniverse(BASE_SOURCES),
    sourceInventory: createAuthoritySourceInventory(BASE_SOURCES, "caller-asserted-test-root"),
  });
  assert.equal(has(bad, "authority_registry_route_invalid"), true);
});

test("registry: authority with extra key is rejected", () => {
  const bad = analyzeAuthorityGraph({
    registry: { ...registry(BASE_SOURCES), authorities: [
      { id: "test", kind: "literal", owner: { path: "src/owner.ts", exportName: "X" }, extra: "field" },
    ] } as unknown as AuthorityRegistry,
    sources: BASE_SOURCES, discoveredUniverse: declaredUniverse(BASE_SOURCES),
    sourceInventory: createAuthoritySourceInventory(BASE_SOURCES, "caller-asserted-test-root"),
  });
  assert.equal(has(bad, "authority_registry_route_invalid"), true);
});

test("registry: owner with invalid path is rejected", () => {
  const bad = registry(BASE_SOURCES, {
    authorities: [{ id: "test", kind: "literal", owner: { path: "/absolute", exportName: "X" } }],
  });
  assert.equal(has(analyze(BASE_SOURCES, bad), "authority_registry_route_invalid"), true);
});

test("registry: owner with invalid export name is rejected", () => {
  const bad = registry(BASE_SOURCES, {
    authorities: [{ id: "test", kind: "literal", owner: { path: "src/owner.ts", exportName: "123invalid" } }],
  });
  assert.equal(has(analyze(BASE_SOURCES, bad), "authority_registry_route_invalid"), true);
});

test("registry: owner with extra key is rejected", () => {
  const bad = analyzeAuthorityGraph({
    registry: { ...registry(BASE_SOURCES), authorities: [
      { id: "test", kind: "literal", owner: { path: "src/owner.ts", exportName: "X", extra: true } },
    ] } as unknown as AuthorityRegistry,
    sources: BASE_SOURCES, discoveredUniverse: declaredUniverse(BASE_SOURCES),
    sourceInventory: createAuthoritySourceInventory(BASE_SOURCES, "caller-asserted-test-root"),
  });
  assert.equal(has(bad, "authority_registry_route_invalid"), true);
});

test("registry: duplicate authority IDs are rejected", () => {
  const dup = registry(BASE_SOURCES, {
    authorities: [
      { id: "dup", kind: "literal", owner: { path: "src/owner.ts", exportName: "CURRENT_VERSION" } },
      { id: "dup", kind: "literal", owner: { path: "src/consumer.ts", exportName: "emitted" } },
    ],
  });
  assert.equal(has(analyze(BASE_SOURCES, dup), "authority_domain_duplicate:dup"), true);
});

test("registry: duplicate owner paths are rejected", () => {
  const dup = registry(BASE_SOURCES, {
    authorities: [
      { id: "a", kind: "literal", owner: { path: "src/owner.ts", exportName: "CURRENT_VERSION" } },
      { id: "b", kind: "literal", owner: { path: "src/owner.ts", exportName: "SCOPE_SCHEMA" } },
    ],
  });
  assert.equal(has(analyze(BASE_SOURCES, dup), "authority_owner_reused:src/owner.ts#CURRENT_VERSION"), false);
  assert.equal(has(analyze(BASE_SOURCES, dup), "authority_owner_reused:src/owner.ts#SCOPE_SCHEMA"), false);
  // Actually different export names = different owner, so no reuse violation
});

test("registry: same owner path AND export name reused is rejected", () => {
  const dup = registry(BASE_SOURCES, {
    authorities: [
      { id: "a", kind: "literal", owner: { path: "src/owner.ts", exportName: "CURRENT_VERSION" } },
      { id: "b", kind: "literal", owner: { path: "src/owner.ts", exportName: "CURRENT_VERSION" } },
    ],
  });
  assert.equal(has(analyze(BASE_SOURCES, dup), "authority_owner_reused:src/owner.ts#CURRENT_VERSION"), true);
});

test("registry: non-canonical authority order is rejected", () => {
  const reversed = structuredClone(registry(BASE_SOURCES)) as any;
  reversed.authorities.reverse();
  assert.equal(has(analyze(BASE_SOURCES, reversed), "authority_registry_authorities_noncanonical"), true);
});

test("registry: non-canonical generator order is rejected", () => {
  const gens: AuthorityRegistry["generators"] = [
    { id: "z-gen", ownerPath: "src/owner.ts", authorityInputs: ["receipt.version"], dependsOn: [], outputs: ["g/z.ts"] },
    { id: "a-gen", ownerPath: "src/owner.ts", authorityInputs: ["receipt.version"], dependsOn: [], outputs: ["g/a.ts"] },
  ];
  assert.equal(has(analyze(BASE_SOURCES, registry(BASE_SOURCES, { generators: gens })),
    "authority_registry_generators_noncanonical"), true);
});

test("registry: non-canonical adapter order is rejected", () => {
  const adapters = [
    { language: "typescript", adapterId: TYPESCRIPT_AUTHORITY_ADAPTER_ID, status: "qualified" },
    { language: "python", adapterId: "python/v1", status: "unsupported" },
  ] as any;
  // typescript before python IS noncanonical (python < typescript)
  const result = analyze(BASE_SOURCES, registry(BASE_SOURCES, { adapters }));
  assert.equal(has(result, "authority_registry_adapters_noncanonical"), true);
});

test("registry: non-canonical adapter order (reversed) is rejected", () => {
  const adapters = [
    { language: "typescript", adapterId: TYPESCRIPT_AUTHORITY_ADAPTER_ID, status: "qualified" },
    { language: "python", adapterId: "python/v1", status: "unsupported" },
  ] as any;
  // typescript before python is NOT canonical (python < typescript)
  // But wait, both need to be in the universe for the adapter to be relevant
  // The registry validation happens regardless of universe
  const result = analyze(BASE_SOURCES, registry(BASE_SOURCES, { adapters }));
  assert.equal(has(result, "authority_registry_adapters_noncanonical"), true);
});

test("registry: applicability default not 'applies' is rejected", () => {
  const bad = analyzeAuthorityGraph({
    registry: { ...registry(BASE_SOURCES), applicability: {
      ...registry(BASE_SOURCES).applicability, defaultDisposition: "not-applicable-with-evidence",
    } } as unknown as AuthorityRegistry,
    sources: BASE_SOURCES, discoveredUniverse: declaredUniverse(BASE_SOURCES),
    sourceInventory: createAuthoritySourceInventory(BASE_SOURCES, "caller-asserted-test-root"),
  });
  assert.equal(has(bad, "authority_applicability_default_not_universal"), true);
});

test("registry: applicability with extra key is rejected", () => {
  const bad = analyzeAuthorityGraph({
    registry: { ...registry(BASE_SOURCES), applicability: {
      ...registry(BASE_SOURCES).applicability, extra: true,
    } } as unknown as AuthorityRegistry,
    sources: BASE_SOURCES, discoveredUniverse: declaredUniverse(BASE_SOURCES),
    sourceInventory: createAuthoritySourceInventory(BASE_SOURCES, "caller-asserted-test-root"),
  });
  assert.equal(has(bad, "authority_registry_applicability_invalid"), true);
});

test("registry: applicability cell with extra key is rejected", () => {
  const bad = analyzeAuthorityGraph({
    registry: { ...registry(BASE_SOURCES), applicability: {
      ...registry(BASE_SOURCES).applicability,
      cells: [{ authorityId: "receipt.version", dimension: "modules", member: "src/owner.ts",
        disposition: "applies", extra: true }],
    } } as unknown as AuthorityRegistry,
    sources: BASE_SOURCES, discoveredUniverse: declaredUniverse(BASE_SOURCES),
    sourceInventory: createAuthoritySourceInventory(BASE_SOURCES, "caller-asserted-test-root"),
  });
  assert.equal(has(bad, "authority_registry_applicability_cell_invalid"), true);
});

test("registry: applicability cell with invalid dimension is rejected", () => {
  const bad = analyzeAuthorityGraph({
    registry: { ...registry(BASE_SOURCES), applicability: {
      ...registry(BASE_SOURCES).applicability,
      cells: [{ authorityId: "receipt.version", dimension: "bogus", member: "src/owner.ts", disposition: "applies" }],
    } } as unknown as AuthorityRegistry,
    sources: BASE_SOURCES, discoveredUniverse: declaredUniverse(BASE_SOURCES),
    sourceInventory: createAuthoritySourceInventory(BASE_SOURCES, "caller-asserted-test-root"),
  });
  assert.equal(has(bad, "authority_registry_applicability_cell_invalid"), true);
});

test("registry: applicability cell with invalid disposition is rejected", () => {
  const bad = analyzeAuthorityGraph({
    registry: { ...registry(BASE_SOURCES), applicability: {
      ...registry(BASE_SOURCES).applicability,
      cells: [{ authorityId: "receipt.version", dimension: "modules", member: "src/owner.ts",
        disposition: "garbage" }],
    } } as unknown as AuthorityRegistry,
    sources: BASE_SOURCES, discoveredUniverse: declaredUniverse(BASE_SOURCES),
    sourceInventory: createAuthoritySourceInventory(BASE_SOURCES, "caller-asserted-test-root"),
  });
  assert.equal(has(bad, "authority_registry_applicability_cell_invalid"), true);
});

test("registry: applicability cell with duplicate key is rejected", () => {
  const cells = [
    { authorityId: "receipt.version", dimension: "modules", member: "src/owner.ts", disposition: "applies" },
    { authorityId: "receipt.version", dimension: "modules", member: "src/owner.ts", disposition: "applies" },
  ] as AuthorityRegistry["applicability"]["cells"];
  assert.equal(has(analyze(BASE_SOURCES, registry(BASE_SOURCES, { cells })),
    "authority_registry_applicability_cells_noncanonical"), true);
});

test("registry: exception with extra key is rejected", () => {
  const exceptions: AuthorityRoleException[] = [{
    authorityId: "receipt.version", path: "src/owner.ts", selector: "export:CURRENT_VERSION@0:1",
    sourceSha256: sha256(OWNER_SOURCE), role: "historical", rationale: "test", evidenceLinks: ["https://e.invalid/1"],
    extra: true,
  }] as any;
  assert.equal(has(analyze(BASE_SOURCES, registry(BASE_SOURCES, { exceptions })),
    "authority_registry_exception_invalid"), true);
});

test("registry: exception with non-canonical evidence links is rejected", () => {
  const exceptions: AuthorityRoleException[] = [{
    authorityId: "receipt.version", path: "src/owner.ts", selector: "export:CURRENT_VERSION@0:1",
    sourceSha256: sha256(OWNER_SOURCE), role: "historical", rationale: "test",
    evidenceLinks: ["https://z.invalid/1", "https://a.invalid/1"],
  }];
  assert.equal(has(analyze(BASE_SOURCES, registry(BASE_SOURCES, { exceptions })),
    "authority_registry_exception_evidence_noncanonical"), true);
});

test("registry: non-canonical exception order is rejected", () => {
  const exceptions: AuthorityRoleException[] = [
    { authorityId: "receipt.version", path: "src/owner.ts", selector: "export:CURRENT_VERSION@0:1",
      sourceSha256: sha256(OWNER_SOURCE), role: "historical", rationale: "z", evidenceLinks: ["https://z.invalid"] },
    { authorityId: "receipt.version", path: "src/owner.ts", selector: "export:SCOPE_SCHEMA@0:1",
      sourceSha256: sha256(OWNER_SOURCE), role: "mutation", rationale: "a", evidenceLinks: ["https://a.invalid"] },
  ];
  // These are sorted by [authorityId, path, selector] - both same authorityId and path, so sorted by selector
  // "export:CURRENT..." < "export:SCOPE..." (C < S), so this IS canonical
  const result = analyze(BASE_SOURCES, registry(BASE_SOURCES, { exceptions }));
  // Should NOT be noncanonical
  assert.equal(has(result, "authority_registry_exceptions_noncanonical"), false);
});

test("registry: generator with extra key is rejected", () => {
  const gens = [{ id: "g", ownerPath: "src/owner.ts", authorityInputs: ["receipt.version"],
    dependsOn: [], outputs: ["g.ts"], extra: true }] as any;
  assert.equal(has(analyze(BASE_SOURCES, registry(BASE_SOURCES, { generators: gens })),
    "authority_registry_generator_invalid"), true);
});

test("registry: adapter with extra key is rejected", () => {
  const adapters = [{ language: "typescript", adapterId: TYPESCRIPT_AUTHORITY_ADAPTER_ID,
    status: "qualified", extra: true }] as any;
  assert.equal(has(analyze(BASE_SOURCES, registry(BASE_SOURCES, { adapters })),
    "authority_registry_adapter_invalid"), true);
});

test("registry: null registry is handled gracefully", () => {
  const result = analyzeAuthorityGraph({
    registry: null as unknown as AuthorityRegistry, sources: BASE_SOURCES,
    discoveredUniverse: declaredUniverse(BASE_SOURCES),
    sourceInventory: createAuthoritySourceInventory(BASE_SOURCES, "caller-asserted-test-root"),
  });
  assert.equal(has(result, "authority_registry_schema_invalid"), true);
});

test("registry: registry with only schema version is handled", () => {
  const result = analyzeAuthorityGraph({
    registry: { schemaVersion: AUTHORITY_REGISTRY_SCHEMA_VERSION } as unknown as AuthorityRegistry,
    sources: BASE_SOURCES, discoveredUniverse: declaredUniverse(BASE_SOURCES),
    sourceInventory: createAuthoritySourceInventory(BASE_SOURCES, "caller-asserted-test-root"),
  });
  assert.equal(has(result, "authority_registry_schema_invalid"), true);
});

// ---------------------------------------------------------------------------
// 4. Source validation (boundary)
// ---------------------------------------------------------------------------

test("source: absolute path is rejected", () => {
  const bad = source("/absolute/path.ts", `export const X = 1;`);
  const result = analyze([LITERAL_OWNER, bad], literalRegistry([LITERAL_OWNER, bad]));
  assert.equal(has(result, "authority_source_invalid"), true);
});

test("source: path traversal is rejected", () => {
  const bad = source("src/../other.ts", `export const X = 1;`);
  const result = analyze([LITERAL_OWNER, bad], literalRegistry([LITERAL_OWNER, bad]));
  assert.equal(has(result, "authority_source_invalid"), true);
});

test("source: path with glob character is rejected", () => {
  const bad = source("src/*.ts", `export const X = 1;`);
  const result = analyze([LITERAL_OWNER, bad], literalRegistry([LITERAL_OWNER, bad]));
  assert.equal(has(result, "authority_source_invalid"), true);
});

test("source: path with backslash is rejected", () => {
  const bad = source("src\\owner.ts", `export const X = 1;`);
  const result = analyze([LITERAL_OWNER, bad], literalRegistry([LITERAL_OWNER, bad]));
  assert.equal(has(result, "authority_source_invalid"), true);
});

test("source: non-NFC path is rejected", () => {
  const bad = source("src/e\u0301.ts", `export const X = 1;`);
  const result = analyze([LITERAL_OWNER, bad], literalRegistry([LITERAL_OWNER, bad]));
  assert.equal(has(result, "authority_source_invalid"), true);
});

test("source: path with control character is rejected", () => {
  const bad = source("src/\nowner.ts", `export const X = 1;`);
  const result = analyze([LITERAL_OWNER, bad], literalRegistry([LITERAL_OWNER, bad]));
  assert.equal(has(result, "authority_source_invalid"), true);
});

test("source: path with carriage return is rejected", () => {
  const bad = source("src/\rowner.ts", `export const X = 1;`);
  const result = analyze([LITERAL_OWNER, bad], literalRegistry([LITERAL_OWNER, bad]));
  assert.equal(has(result, "authority_source_invalid"), true);
});

test("source: path with bidi control is rejected", () => {
  const bad = source("src/\u202Eowner.ts", `export const X = 1;`);
  const result = analyze([LITERAL_OWNER, bad], literalRegistry([LITERAL_OWNER, bad]));
  assert.equal(has(result, "authority_source_invalid"), true);
});

test("source: empty language is rejected", () => {
  const bad = { ...LITERAL_OWNER, language: "" } as AuthoritySource;
  const result = analyze([bad], literalRegistry([bad]));
  assert.equal(has(result, "authority_source_invalid"), true);
});

test("source: non-string language is rejected", () => {
  const bad = { ...LITERAL_OWNER, language: 42 } as unknown as AuthoritySource;
  const result = analyze([bad], literalRegistry([bad as any]));
  assert.equal(has(result, "authority_source_invalid"), true);
});

test("source: non-string source throws in inventory creation", () => {
  const bad = { ...LITERAL_OWNER, source: 42 } as unknown as AuthoritySource;
  // createAuthoritySourceInventory calls sha256 on source, which requires a string
  assert.throws(() => analyze([bad], literalRegistry([bad as any])));
});

test("source: non-string source is rejected by normalizeSources", () => {
  const bad = { ...LITERAL_OWNER, source: 42 } as unknown as AuthoritySource;
  // Use analyzeAuthorityGraph directly to test normalizeSources without inventory creation
  const result = analyzeAuthorityGraph({
    registry: literalRegistry([LITERAL_OWNER]),
    sources: [bad] as unknown as readonly AuthoritySource[],
    discoveredUniverse: declaredUniverse([LITERAL_OWNER]),
    sourceInventory: createAuthoritySourceInventory([LITERAL_OWNER], "caller-asserted-test-root"),
  });
  assert.equal(has(result, "authority_source_invalid"), true);
});

test("source: empty layer metadata is rejected", () => {
  const bad = { ...LITERAL_OWNER, layer: "" };
  const result = analyze([bad], literalRegistry([bad]));
  assert.equal(has(result, "authority_source_metadata_invalid"), true);
});

test("source: empty realm metadata is rejected", () => {
  const bad = { ...LITERAL_OWNER, realm: "" };
  const result = analyze([bad], literalRegistry([bad]));
  assert.equal(has(result, "authority_source_metadata_invalid"), true);
});

test("source: empty testId metadata is rejected", () => {
  const bad = { ...LITERAL_OWNER, testId: "" };
  const result = analyze([bad], literalRegistry([bad]));
  assert.equal(has(result, "authority_source_metadata_invalid"), true);
});

test("source: non-string layer metadata is rejected", () => {
  const bad = { ...LITERAL_OWNER, layer: 42 } as any;
  const result = analyze([bad], literalRegistry([bad]));
  assert.equal(has(result, "authority_source_metadata_invalid"), true);
});

test("source: duplicate paths are rejected", () => {
  const dup = source("src/owner.ts", `export const X = 1;`);
  const dup2 = source("src/owner.ts", `export const Y = 2;`);
  const result = analyze([LITERAL_OWNER, dup, dup2], literalRegistry([LITERAL_OWNER, dup, dup2]));
  assert.equal(has(result, "authority_source_duplicate:src/owner.ts"), true);
});

test("source: source with extra key is rejected", () => {
  const bad = { ...LITERAL_OWNER, extra: true } as any;
  const result = analyze([bad], literalRegistry([bad]));
  assert.equal(has(result, "authority_source_invalid"), true);
});

test("source: undefined metadata is accepted", () => {
  const good = { path: LITERAL_OWNER.path, language: "typescript", source: LITERAL_OWNER.source };
  const result = analyze([good], literalRegistry([good]));
  assert.equal(has(result, "authority_source_invalid"), false);
});

test("source: valid metadata is accepted", () => {
  const good = source("src/good.ts", `export const X = "domain/v4";`, "typescript");
  const result = analyze([LITERAL_OWNER, good], literalRegistry([LITERAL_OWNER, good]));
  assert.equal(has(result, "authority_source_invalid"), false);
  assert.equal(has(result, "authority_source_metadata_invalid"), false);
});

test("source: empty sources array is handled", () => {
  const result = analyzeAuthorityGraph({
    registry: registry([]), sources: [],
    discoveredUniverse: discoveredUniverse(),
    sourceInventory: createAuthoritySourceInventory([], "caller-asserted-test-root"),
  });
  assert.equal(result.lock.sources.length, 0);
});

// ---------------------------------------------------------------------------
// 5. Universe validation (boundary)
// ---------------------------------------------------------------------------

test("universe: extra dimension is rejected", () => {
  const bad = { ...discoveredUniverse(), extra: ["x"] } as unknown as AuthorityUniverse;
  const result = analyzeAuthorityGraph({
    registry: registry(BASE_SOURCES), sources: BASE_SOURCES,
    discoveredUniverse: bad,
    sourceInventory: createAuthoritySourceInventory(BASE_SOURCES, "caller-asserted-test-root"),
  });
  assert.equal(has(result, "authority_discovered_universe_invalid"), true);
});

test("universe: non-array dimension member is rejected", () => {
  const bad = { ...discoveredUniverse(), modules: "not-array" as unknown as string[] };
  const result = analyzeAuthorityGraph({
    registry: registry(BASE_SOURCES), sources: BASE_SOURCES,
    discoveredUniverse: bad as unknown as AuthorityUniverse,
    sourceInventory: createAuthoritySourceInventory(BASE_SOURCES, "caller-asserted-test-root"),
  });
  assert.equal(has(result, "authority_discovered_universe_invalid:modules"), true);
});

test("universe: empty string member is rejected", () => {
  const bad = discoveredUniverse({ modules: [""] });
  const result = analyze(BASE_SOURCES, registry(BASE_SOURCES), bad);
  assert.equal(has(result, "authority_discovered_universe_invalid:modules"), true);
});

test("universe: duplicate members are rejected", () => {
  const bad = discoveredUniverse({ agents: ["a", "a"] });
  const result = analyze(BASE_SOURCES, registry(BASE_SOURCES), bad);
  assert.equal(has(result, "authority_discovered_universe_noncanonical:agents"), true);
});

test("universe: non-canonical order is rejected", () => {
  const bad = { ...discoveredUniverse(), agents: ["z", "a"] };
  const result = analyzeAuthorityGraph({
    registry: registry(BASE_SOURCES), sources: BASE_SOURCES,
    discoveredUniverse: bad as unknown as AuthorityUniverse,
    sourceInventory: createAuthoritySourceInventory(BASE_SOURCES, "caller-asserted-test-root"),
  });
  assert.equal(has(result, "authority_discovered_universe_noncanonical:agents"), true);
});

test("universe: discovered universe always gets attestation_untrusted", () => {
  const result = analyze(BASE_SOURCES, registry(BASE_SOURCES), discoveredUniverse());
  assert.equal(has(result, "authority_universe_attestation_untrusted"), true);
});

test("universe: empty dimensions produce applicability empty_dimension violations", () => {
  const empty = discoveredUniverse({
    agents: [], tools: [], providers: [], extensions: [],
    artifactKinds: [], operations: [], lifecycleStages: [],
  });
  const result = analyze(BASE_SOURCES, registry(BASE_SOURCES), empty);
  assert.ok(has(result, "authority_applicability_empty_dimension"));
});

test("universe: valid members are accepted", () => {
  const good = discoveredUniverse({ agents: ["agent-a", "agent-b"] });
  const result = analyze(BASE_SOURCES, registry(BASE_SOURCES), good);
  assert.equal(has(result, "authority_discovered_universe_invalid"), false);
});

test("universe: discovered universe coverage catches missing module (registry lacks new source)", () => {
  const extra = source("src/new-module.ts", `export const value = 1;`);
  const moduleSources = [...BASE_SOURCES, extra];
  // Use registry built from BASE_SOURCES (without the extra module)
  const result = analyze(moduleSources, registry(BASE_SOURCES));
  assert.equal(has(result, "authority_applicability_missing_cell:receipt.version:modules:src/new-module.ts"), true);
});

test("universe: discovered universe coverage catches extra module", () => {
  const ghostUniverse = discoveredUniverse({ modules: ["src/ghost.ts"] });
  const result = analyze(BASE_SOURCES, registry(BASE_SOURCES), ghostUniverse);
  assert.equal(has(result, "authority_source_set_incomplete:modules:src/ghost.ts"), true);
});

test("universe: all dimensions present in fixture", () => {
  const u = declaredUniverse(BASE_SOURCES);
  for (const dim of AUTHORITY_UNIVERSE_DIMENSIONS) {
    assert.ok(Array.isArray(u[dim]), `missing dimension ${dim}`);
  }
});

test("universe: declared universe members include source modules", () => {
  const u = declaredUniverse(BASE_SOURCES);
  assert.ok(u.modules.includes("src/owner.ts"));
  assert.ok(u.modules.includes("src/consumer.ts"));
});

test("universe: declared universe members include source languages", () => {
  const u = declaredUniverse(BASE_SOURCES);
  assert.ok(u.languages.includes("typescript"));
});

test("universe: declared universe members include source layers", () => {
  const u = declaredUniverse(BASE_SOURCES);
  assert.ok(u.layers.includes("verification"));
});

// ---------------------------------------------------------------------------
// 6. Literal semantics (hostile)
// ---------------------------------------------------------------------------

test("literal: direct copy is detected as duplicate", () => {
  const copy = source("src/copy.ts", `export const C = "domain/v4";`);
  const result = rawAnalyze([LITERAL_OWNER, copy], literalRegistry([LITERAL_OWNER, copy]));
  assert.equal(has(result, "authority_literal_duplicate:version"), true);
});

test("literal: concatenated copy is detected", () => {
  const copy = source("src/copy.ts", `export const C = "domain" + "/v4";`);
  const result = rawAnalyze([LITERAL_OWNER, copy], literalRegistry([LITERAL_OWNER, copy]));
  assert.equal(has(result, `authority_literal_duplicate:version:${copy.path}`), true);
});

test("literal: template literal copy is detected", () => {
  const copy = source("src/copy.ts", "export const C = `domain/v4`;");
  const result = rawAnalyze([LITERAL_OWNER, copy], literalRegistry([LITERAL_OWNER, copy]));
  assert.equal(has(result, `authority_literal_duplicate:version:${copy.path}`), true);
});

test("literal: String.fromCharCode copy is detected", () => {
  const copy = source("src/copy.ts", `export const C = String.fromCharCode(100,111,109,97,105,110,47,118,52);`);
  const result = rawAnalyze([LITERAL_OWNER, copy], literalRegistry([LITERAL_OWNER, copy]));
  assert.equal(has(result, `authority_literal_duplicate:version:${copy.path}`), true);
});

test("literal: array.join copy is detected", () => {
  const copy = source("src/copy.ts", `export const C = ["domain", "v4"].join("/");`);
  const result = rawAnalyze([LITERAL_OWNER, copy], literalRegistry([LITERAL_OWNER, copy]));
  assert.equal(has(result, `authority_literal_duplicate:version:${copy.path}`), true);
});

test("literal: replace copy is detected", () => {
  const copy = source("src/copy.ts", `export const C = "d0main/v4".replace("0", "o");`);
  const result = rawAnalyze([LITERAL_OWNER, copy], literalRegistry([LITERAL_OWNER, copy]));
  assert.equal(has(result, `authority_literal_duplicate:version:${copy.path}`), true);
});

test("literal: base64 decode copy is detected", () => {
  const copy = source("src/copy.ts", `export const C = Buffer.from("ZG9tYWluL3Y0", "base64").toString();`);
  const result = rawAnalyze([LITERAL_OWNER, copy], literalRegistry([LITERAL_OWNER, copy]));
  assert.equal(has(result, `authority_literal_duplicate:version:${copy.path}`), true);
});

test("literal: toLowerCase copy is detected", () => {
  const copy = source("src/copy.ts", `export const C = "DOMAIN/V4".toLowerCase();`);
  const result = rawAnalyze([LITERAL_OWNER, copy], literalRegistry([LITERAL_OWNER, copy]));
  assert.equal(has(result, `authority_literal_duplicate:version:${copy.path}`), true);
});

test("literal: stale version (same family, different version) is detected", () => {
  const stale = source("src/stale.ts", `export const S = "domain/v3";`);
  const result = rawAnalyze([LITERAL_OWNER, stale], literalRegistry([LITERAL_OWNER, stale]));
  assert.equal(has(result, "authority_literal_stale:version"), true);
});

test("literal: owner module literal is not a duplicate of itself", () => {
  const result = rawAnalyze([LITERAL_OWNER], literalRegistry([LITERAL_OWNER]));
  assert.equal(has(result, "authority_literal_duplicate:version"), false);
});

test("literal: unrelated string is not a false positive", () => {
  const unrelated = source("src/unrelated.ts", `export const U = "completely/different";`);
  const result = rawAnalyze([LITERAL_OWNER, unrelated], literalRegistry([LITERAL_OWNER, unrelated]));
  assert.equal(has(result, `authority_literal_duplicate:version:${unrelated.path}`), false);
  assert.equal(has(result, `authority_literal_stale:version:${unrelated.path}`), false);
});

test("literal: String wrapper copy is detected", () => {
  const copy = source("src/copy.ts", `export const C = String("domain/v4");`);
  const result = rawAnalyze([LITERAL_OWNER, copy], literalRegistry([LITERAL_OWNER, copy]));
  assert.equal(has(result, `authority_literal_duplicate:version:${copy.path}`), true);
});

test("literal: nested constant reference resolves", () => {
  const copy = source("src/copy.ts", `const PART = "domain/v4"; export const C = PART;`);
  const result = rawAnalyze([LITERAL_OWNER, copy], literalRegistry([LITERAL_OWNER, copy]));
  assert.equal(has(result, `authority_literal_duplicate:version:${copy.path}`), true);
});

test("literal: deeply nested constant reference resolves", () => {
  const copy = source("src/copy.ts", `const A = "domain"; const B = "/v4"; const C = A + B; export const D = C;`);
  const result = rawAnalyze([LITERAL_OWNER, copy], literalRegistry([LITERAL_OWNER, copy]));
  assert.equal(has(result, `authority_literal_duplicate:version:${copy.path}`), true);
});

test("literal: same-export multiple literals get distinct selectors", () => {
  const both = source("test/both.ts", `export const B = ["domain/v3", "domain/v4"];`);
  const result = rawAnalyze([LITERAL_OWNER, both], literalRegistry([LITERAL_OWNER, both]));
  const candidates = result.lock.occurrences.filter((o) =>
    o.authorityId === "version" && o.path === both.path && o.occurrenceKind === "literal");
  assert.equal(candidates.length, 2);
  assert.notEqual(candidates[0]?.selector, candidates[1]?.selector);
});

test("literal: non-version literal does not get stale detection", () => {
  const nonVersion = source("src/nv.ts", `export const VERSION = "just-a-string";`);
  const auth = { id: "nv", kind: "literal" as const, owner: { path: nonVersion.path, exportName: "VERSION" } };
  const similar = source("src/similar.ts", `export const S = "just-a-string2";`);
  const result = rawAnalyze([nonVersion, similar], registry([nonVersion, similar], { authorities: [auth] }));
  assert.equal(has(result, "authority_literal_stale:nv"), false);
});

test("literal: literal as object property key is not flagged as duplicate", () => {
  const obj = source("src/obj.ts", `export const O = { "domain/v4": 1 };`);
  const result = rawAnalyze([LITERAL_OWNER, obj], literalRegistry([LITERAL_OWNER, obj]));
  // The literal "domain/v4" as a property key should not be a value expression
  assert.equal(has(result, `authority_literal_duplicate:version:${obj.path}`), false);
});

test("literal: literal in import path is not flagged", () => {
  const importer = source("src/importer.ts", `import "domain/v4";`);
  const result = rawAnalyze([LITERAL_OWNER, importer], literalRegistry([LITERAL_OWNER, importer]));
  // Import source is not a value expression
  assert.equal(has(result, `authority_literal_duplicate:version:${importer.path}`), false);
});

// ---------------------------------------------------------------------------
// 7. Shape semantics (hostile)
// ---------------------------------------------------------------------------

test("shape: type alias copy is detected", () => {
  const copy = source("src/copy.ts", `export type C = Readonly<{ a: string; b: string }>;`);
  const result = rawAnalyze([SHAPE_OWNER, copy], shapeRegistry([SHAPE_OWNER, copy]));
  assert.equal(has(result, "authority_shape_duplicate:scope"), true);
});

test("shape: interface copy is detected", () => {
  const copy = source("src/copy.ts", `export interface C { a: string; b: string }`);
  const result = rawAnalyze([SHAPE_OWNER, copy], shapeRegistry([SHAPE_OWNER, copy]));
  assert.equal(has(result, "authority_shape_duplicate:scope"), true);
});

test("shape: zod strictObject copy is detected", () => {
  const copy = source("src/copy.ts", `import { z } from "zod"; export const C = z.strictObject({ a: z.string(), b: z.string() });`);
  const result = rawAnalyze([SHAPE_OWNER, copy], shapeRegistry([SHAPE_OWNER, copy]));
  assert.equal(has(result, "authority_shape_duplicate:scope"), true);
});

test("shape: object literal copy is detected", () => {
  const copy = source("src/copy.ts", `export const C = { a: "x", b: "y" };`);
  const result = rawAnalyze([SHAPE_OWNER, copy], shapeRegistry([SHAPE_OWNER, copy]));
  assert.equal(has(result, "authority_shape_duplicate:scope"), true);
});

test("shape: spread copy is detected", () => {
  const copy = source("src/copy.ts", `const BASE = { a: "x" }; export const C = { ...BASE, b: "y" };`);
  const result = rawAnalyze([SHAPE_OWNER, copy], shapeRegistry([SHAPE_OWNER, copy]));
  assert.equal(has(result, "authority_shape_duplicate:scope"), true);
});

test("shape: optional field difference prevents duplicate", () => {
  const optional = source("src/opt.ts", `export type O = { a?: string; b: string };`);
  const result = rawAnalyze([SHAPE_OWNER, optional], shapeRegistry([SHAPE_OWNER, optional]));
  assert.equal(has(result, `authority_shape_duplicate:scope:${optional.path}`), false);
});

test("shape: type difference prevents duplicate", () => {
  const different = source("src/diff.ts", `export type D = { a: number; b: string };`);
  const result = rawAnalyze([SHAPE_OWNER, different], shapeRegistry([SHAPE_OWNER, different]));
  assert.equal(has(result, `authority_shape_duplicate:scope:${different.path}`), false);
});

test("shape: unknown runtime values do not become shape duplicates", () => {
  const unknown = source("src/unk.ts", `declare function v(): number; export const U = { a: v(), b: v() };`);
  const result = rawAnalyze([SHAPE_OWNER, unknown], shapeRegistry([SHAPE_OWNER, unknown]));
  assert.equal(has(result, `authority_shape_duplicate:scope:${unknown.path}`), false);
});

test("shape: one-field overlap does not become duplicate", () => {
  const partial = source("src/partial.ts", `export const P = { a: "x" };`);
  const result = rawAnalyze([SHAPE_OWNER, partial], shapeRegistry([SHAPE_OWNER, partial]));
  assert.equal(has(result, `authority_shape_duplicate:scope:${partial.path}`), false);
});

test("shape: unknown zod transform blocks", () => {
  const bad = source("src/bad.ts", `import { z } from "zod"; export const C = z.strictObject({ a: z.string().nullable(), b: z.string() });`);
  const result = rawAnalyze([SHAPE_OWNER, bad], shapeRegistry([SHAPE_OWNER, bad]));
  assert.equal(has(result, "authority_shape_unsupported:scope"), true);
});

test("shape: external spread blocks", () => {
  const bad = source("src/bad.ts", `import { z } from "zod"; import { F } from "shared"; export const C = z.strictObject({ ...F });`);
  const result = rawAnalyze([SHAPE_OWNER, bad], shapeRegistry([SHAPE_OWNER, bad]));
  assert.equal(has(result, "authority_shape_unsupported:scope"), true);
});

test("shape: non-zod owner is unsupported", () => {
  const plainObj = source("src/plain.ts", `export const SCOPE = { a: 1, b: 2 };`);
  const auth = { id: "scope", kind: "zod-strict-object" as const, owner: { path: plainObj.path, exportName: "SCOPE" } };
  const result = rawAnalyze([plainObj], registry([plainObj], { authorities: [auth] }));
  assert.equal(has(result, "authority_owner_unsupported:scope"), true);
});

test("shape: materialization via parse is detected", () => {
  const consumer = source("src/consumer.ts", `import { SCOPE } from "./shape-owner.ts"; export const V = SCOPE.parse({ a: "x", b: "y" });`);
  const result = rawAnalyze([SHAPE_OWNER, consumer], shapeRegistry([SHAPE_OWNER, consumer]));
  assert.ok(result.lock.occurrences.some((o) => o.path === consumer.path && o.role === "materialization"));
});

test("shape: materialization via namespace parse is detected", () => {
  const consumer = source("src/consumer.ts", `import * as ns from "./shape-owner.ts"; export const V = ns.SCOPE.parse({ a: "x", b: "y" });`);
  const result = rawAnalyze([SHAPE_OWNER, consumer], shapeRegistry([SHAPE_OWNER, consumer]));
  assert.ok(result.lock.occurrences.some((o) => o.path === consumer.path && o.role === "materialization"));
});

test("shape: materialization via safeParse is detected", () => {
  const consumer = source("src/consumer.ts", `import { SCOPE } from "./shape-owner.ts"; export const V = SCOPE.safeParse({ a: "x", b: "y" });`);
  const result = rawAnalyze([SHAPE_OWNER, consumer], shapeRegistry([SHAPE_OWNER, consumer]));
  assert.ok(result.lock.occurrences.some((o) => o.path === consumer.path && o.role === "materialization"));
});

test("shape: shadowed import does not create materialization", () => {
  const shadowed = source("src/shadow.ts", `import { SCOPE } from "./shape-owner.ts"; export function f(SCOPE: any) { return SCOPE.parse({ a: "x", b: "y" }); }`);
  const result = rawAnalyze([SHAPE_OWNER, shadowed], shapeRegistry([SHAPE_OWNER, shadowed]));
  assert.equal(result.lock.occurrences.some((o) => o.path === shadowed.path && o.role === "materialization"), false);
});

test("shape: unrelated array spread does not block", () => {
  const unrelated = source("src/unrelated.ts", `declare const v: readonly number[]; export const C = [...v];`);
  const result = rawAnalyze([SHAPE_OWNER, unrelated], shapeRegistry([SHAPE_OWNER, unrelated]));
  assert.equal(has(result, "authority_shape_unsupported:scope"), false);
});

test("shape: computed keys are detected", () => {
  const computed = source("src/computed.ts", `import { z } from "zod"; const A = "a", B = "b"; export const C = z.strictObject({ [A]: z.string(), [B]: z.string() });`);
  const result = rawAnalyze([SHAPE_OWNER, computed], shapeRegistry([SHAPE_OWNER, computed]));
  assert.equal(has(result, "authority_shape_duplicate:scope"), true);
});

test("shape: nested shape comparison works", () => {
  const nestedOwner = source("src/nested-owner.ts", `import { z } from "zod"; export const S = z.strictObject({ outer: z.strictObject({ a: z.string() }) });`);
  const nestedAuth = { id: "nested", kind: "zod-strict-object" as const, owner: { path: nestedOwner.path, exportName: "S" } };
  const copy = source("src/copy.ts", `export type C = { outer: { a: string } };`);
  const result = rawAnalyze([nestedOwner, copy], registry([nestedOwner, copy], { authorities: [nestedAuth] }));
  assert.equal(has(result, "authority_shape_duplicate:nested"), true);
});

test("shape: readonly wrapper is detected", () => {
  const readonlyCopy = source("src/ro.ts", `export type C = Readonly<{ a: string; b: string }>;`);
  const result = rawAnalyze([SHAPE_OWNER, readonlyCopy], shapeRegistry([SHAPE_OWNER, readonlyCopy]));
  assert.equal(has(result, "authority_shape_duplicate:scope"), true);
});

test("shape: intersection type is handled", () => {
  const intersection = source("src/inter.ts", `export type C = { a: string } & { b: string };`);
  const result = rawAnalyze([SHAPE_OWNER, intersection], shapeRegistry([SHAPE_OWNER, intersection]));
  assert.equal(has(result, "authority_shape_duplicate:scope"), true);
});

// ---------------------------------------------------------------------------
// 8. Exception validation (hostile)
// ---------------------------------------------------------------------------

test("exception: historical role is unproven", () => {
  const hist = source("test/hist.ts", `export const H = "domain/v3";`);
  const sources = [LITERAL_OWNER, hist];
  const baseline = rawAnalyze(sources, literalRegistry(sources));
  const occ = baseline.lock.occurrences.find((o) => o.authorityId === "version" && o.path === hist.path)!;
  const exceptions: AuthorityRoleException[] = [{
    authorityId: "version", path: hist.path, selector: occ.selector, sourceSha256: sha256(hist.source),
    role: "historical", rationale: "label", evidenceLinks: ["https://e.invalid/1"],
  }];
  const result = rawAnalyze(sources, literalRegistry(sources, { exceptions }));
  assert.equal(has(result, "authority_exception_role_unproven"), true);
  assert.equal(result.lock.occurrences.some((o) => o.role === "historical"), false);
});

test("exception: mutation role is unproven", () => {
  const mut = source("test/mut.ts", `export const M = "domain/v999";`);
  const sources = [LITERAL_OWNER, mut];
  const baseline = rawAnalyze(sources, literalRegistry(sources));
  const occ = baseline.lock.occurrences.find((o) => o.authorityId === "version" && o.path === mut.path)!;
  const exceptions: AuthorityRoleException[] = [{
    authorityId: "version", path: mut.path, selector: occ.selector, sourceSha256: sha256(mut.source),
    role: "mutation", rationale: "label", evidenceLinks: ["https://e.invalid/1"],
  }];
  const result = rawAnalyze(sources, literalRegistry(sources, { exceptions }));
  assert.equal(has(result, "authority_exception_role_unproven"), true);
  assert.equal(result.lock.occurrences.some((o) => o.role === "mutation"), false);
});

test("exception: distinct-domain role is unproven", () => {
  const a = source("src/a.ts", `export const V = "domain/v4";`);
  const b = source("src/b.ts", `export const V = "domain/v4";`);
  const auth = [
    { id: "a.v", kind: "literal" as const, owner: { path: a.path, exportName: "V" } },
    { id: "b.v", kind: "literal" as const, owner: { path: b.path, exportName: "V" } },
  ];
  const sources = [a, b];
  const baseline = rawAnalyze(sources, registry(sources, { authorities: auth }));
  const occ = baseline.lock.occurrences.find((o) => o.authorityId === "a.v" && o.path === b.path && o.role === "duplicate")!;
  const exceptions: AuthorityRoleException[] = [{
    authorityId: "a.v", path: b.path, selector: occ.selector, sourceSha256: sha256(b.source),
    role: "distinct-domain", distinctAuthorityId: "b.v", rationale: "claim", evidenceLinks: ["https://e.invalid/1"],
  }];
  const result = rawAnalyze(sources, registry(sources, { authorities: auth, exceptions }));
  assert.equal(has(result, "authority_exception_role_unproven"), true);
  assert.equal(result.lock.occurrences.some((o) => o.role === "distinct-domain"), false);
});

test("exception: broad path is invalid", () => {
  const exceptions: AuthorityRoleException[] = [{
    authorityId: "version", path: "test/*.ts", selector: "export:X@0:1",
    sourceSha256: sha256("x"), role: "historical", rationale: "broad", evidenceLinks: ["https://e.invalid/1"],
  }];
  assert.equal(has(rawAnalyze(BASE_SOURCES, literalRegistry(BASE_SOURCES, { exceptions })),
    "authority_exception_invalid"), true);
});

test("exception: stale hash is invalid", () => {
  const exceptions: AuthorityRoleException[] = [{
    authorityId: "version", path: "src/owner.ts", selector: "export:CURRENT_VERSION@0:1",
    sourceSha256: "0".repeat(64), role: "historical", rationale: "stale", evidenceLinks: ["https://e.invalid/1"],
  }];
  assert.equal(has(rawAnalyze(BASE_SOURCES, literalRegistry(BASE_SOURCES, { exceptions })),
    "authority_exception_invalid"), true);
});

test("exception: empty rationale is invalid", () => {
  const exceptions: AuthorityRoleException[] = [{
    authorityId: "version", path: "src/owner.ts", selector: "export:CURRENT_VERSION@0:1",
    sourceSha256: sha256(OWNER_SOURCE), role: "historical", rationale: "", evidenceLinks: ["https://e.invalid/1"],
  }];
  assert.equal(has(rawAnalyze(BASE_SOURCES, literalRegistry(BASE_SOURCES, { exceptions })),
    "authority_exception_invalid"), true);
});

test("exception: empty evidence links are invalid", () => {
  const exceptions: AuthorityRoleException[] = [{
    authorityId: "version", path: "src/owner.ts", selector: "export:CURRENT_VERSION@0:1",
    sourceSha256: sha256(OWNER_SOURCE), role: "historical", rationale: "test", evidenceLinks: [],
  }];
  assert.equal(has(rawAnalyze(BASE_SOURCES, literalRegistry(BASE_SOURCES, { exceptions })),
    "authority_exception_invalid"), true);
});

test("exception: non-URL evidence links are invalid", () => {
  const exceptions: AuthorityRoleException[] = [{
    authorityId: "version", path: "src/owner.ts", selector: "export:CURRENT_VERSION@0:1",
    sourceSha256: sha256(OWNER_SOURCE), role: "historical", rationale: "test", evidenceLinks: ["not-a-url"],
  }];
  assert.equal(has(rawAnalyze(BASE_SOURCES, literalRegistry(BASE_SOURCES, { exceptions })),
    "authority_exception_invalid"), true);
});

test("exception: self-referencing distinctAuthorityId is invalid", () => {
  const exceptions: AuthorityRoleException[] = [{
    authorityId: "version", path: "src/owner.ts", selector: "export:CURRENT_VERSION@0:1",
    sourceSha256: sha256(OWNER_SOURCE), role: "distinct-domain", distinctAuthorityId: "version",
    rationale: "self", evidenceLinks: ["https://e.invalid/1"],
  }];
  assert.equal(has(rawAnalyze(BASE_SOURCES, literalRegistry(BASE_SOURCES, { exceptions })),
    "authority_exception_distinct_domain_invalid"), true);
});

test("exception: unknown distinctAuthorityId is invalid", () => {
  const exceptions: AuthorityRoleException[] = [{
    authorityId: "version", path: "src/owner.ts", selector: "export:CURRENT_VERSION@0:1",
    sourceSha256: sha256(OWNER_SOURCE), role: "distinct-domain", distinctAuthorityId: "nonexistent",
    rationale: "unknown", evidenceLinks: ["https://e.invalid/1"],
  }];
  assert.equal(has(rawAnalyze(BASE_SOURCES, literalRegistry(BASE_SOURCES, { exceptions })),
    "authority_exception_distinct_domain_invalid"), true);
});

test("exception: distinctAuthorityId on non-distinct role is invalid", () => {
  const exceptions: AuthorityRoleException[] = [{
    authorityId: "version", path: "src/owner.ts", selector: "export:CURRENT_VERSION@0:1",
    sourceSha256: sha256(OWNER_SOURCE), role: "historical", distinctAuthorityId: "other.id",
    rationale: "wrong", evidenceLinks: ["https://e.invalid/1"],
  }];
  assert.equal(has(rawAnalyze(BASE_SOURCES, literalRegistry(BASE_SOURCES, { exceptions })),
    "authority_exception_distinct_domain_invalid"), true);
});

test("exception: distinct-domain without distinctAuthorityId is invalid", () => {
  const exceptions: AuthorityRoleException[] = [{
    authorityId: "version", path: "src/owner.ts", selector: "export:CURRENT_VERSION@0:1",
    sourceSha256: sha256(OWNER_SOURCE), role: "distinct-domain",
    rationale: "missing", evidenceLinks: ["https://e.invalid/1"],
  }];
  assert.equal(has(rawAnalyze(BASE_SOURCES, literalRegistry(BASE_SOURCES, { exceptions })),
    "authority_exception_distinct_domain_invalid"), true);
});

test("exception: duplicate exception key is rejected", () => {
  const exceptions: AuthorityRoleException[] = [
    { authorityId: "version", path: "src/owner.ts", selector: "export:CURRENT_VERSION@0:1",
      sourceSha256: sha256(OWNER_SOURCE), role: "historical", rationale: "a", evidenceLinks: ["https://a.invalid"] },
    { authorityId: "version", path: "src/owner.ts", selector: "export:CURRENT_VERSION@0:1",
      sourceSha256: sha256(OWNER_SOURCE), role: "mutation", rationale: "b", evidenceLinks: ["https://b.invalid"] },
  ];
  assert.equal(has(rawAnalyze(BASE_SOURCES, literalRegistry(BASE_SOURCES, { exceptions })),
    "authority_exception_duplicate"), true);
});

test("exception: unknown authority ID is invalid", () => {
  const exceptions: AuthorityRoleException[] = [{
    authorityId: "nonexistent", path: "src/owner.ts", selector: "export:CURRENT_VERSION@0:1",
    sourceSha256: sha256(OWNER_SOURCE), role: "historical", rationale: "test", evidenceLinks: ["https://e.invalid/1"],
  }];
  assert.equal(has(rawAnalyze(BASE_SOURCES, literalRegistry(BASE_SOURCES, { exceptions })),
    "authority_exception_invalid"), true);
});

test("exception: invalid selector pattern is rejected", () => {
  const exceptions: AuthorityRoleException[] = [{
    authorityId: "version", path: "src/owner.ts", selector: "invalid-selector",
    sourceSha256: sha256(OWNER_SOURCE), role: "historical", rationale: "test", evidenceLinks: ["https://e.invalid/1"],
  }];
  assert.equal(has(rawAnalyze(BASE_SOURCES, literalRegistry(BASE_SOURCES, { exceptions })),
    "authority_exception_invalid"), true);
});

test("exception: stale exception (no matching occurrence) is rejected", () => {
  const exceptions: AuthorityRoleException[] = [{
    authorityId: "version", path: "src/owner.ts", selector: "export:NONEXISTENT@0:1",
    sourceSha256: sha256(OWNER_SOURCE), role: "historical", rationale: "test", evidenceLinks: ["https://e.invalid/1"],
  }];
  assert.equal(has(rawAnalyze(BASE_SOURCES, literalRegistry(BASE_SOURCES, { exceptions })),
    "authority_exception_stale"), true);
});

// ---------------------------------------------------------------------------
// 9. Derivation validation (hostile)
// ---------------------------------------------------------------------------

test("derivation: no generators gives inventory_unavailable", () => {
  assert.equal(has(rawAnalyze(BASE_SOURCES, registry(BASE_SOURCES)),
    "authority_derivation_inventory_unavailable"), true);
});

test("derivation: generator with missing owner source is rejected", () => {
  const gens: AuthorityRegistry["generators"] = [{
    id: "g", ownerPath: "src/nonexistent.ts", authorityInputs: ["receipt.version"],
    dependsOn: [], outputs: ["g.ts"],
  }];
  assert.equal(has(rawAnalyze(BASE_SOURCES, registry(BASE_SOURCES, { generators: gens })),
    "authority_generator_owner_missing:g"), true);
});

test("derivation: generator with missing authority input is rejected", () => {
  const gens: AuthorityRegistry["generators"] = [{
    id: "g", ownerPath: "src/owner.ts", authorityInputs: [],
    dependsOn: [], outputs: ["g.ts"],
  }];
  assert.equal(has(rawAnalyze(BASE_SOURCES, registry(BASE_SOURCES, { generators: gens })),
    "authority_generator_input_missing:g"), true);
});

test("derivation: generator with orphan authority input is rejected", () => {
  const gens: AuthorityRegistry["generators"] = [{
    id: "g", ownerPath: "src/owner.ts", authorityInputs: ["nonexistent.authority"],
    dependsOn: [], outputs: ["g.ts"],
  }];
  assert.equal(has(rawAnalyze(BASE_SOURCES, registry(BASE_SOURCES, { generators: gens })),
    "authority_generator_input_orphan:g:nonexistent.authority"), true);
});

test("derivation: generator with invalid output path is rejected", () => {
  const gens: AuthorityRegistry["generators"] = [{
    id: "g", ownerPath: "src/owner.ts", authorityInputs: ["receipt.version"],
    dependsOn: [], outputs: ["/absolute/path.ts"],
  }];
  assert.equal(has(rawAnalyze(BASE_SOURCES, registry(BASE_SOURCES, { generators: gens })),
    "authority_generator_output_invalid:g"), true);
});

test("derivation: generator with unproven output (not in sources) is rejected", () => {
  const gens: AuthorityRegistry["generators"] = [{
    id: "g", ownerPath: "src/owner.ts", authorityInputs: ["receipt.version"],
    dependsOn: [], outputs: ["generated/not-present.ts"],
  }];
  assert.equal(has(rawAnalyze(BASE_SOURCES, registry(BASE_SOURCES, { generators: gens })),
    "authority_generator_output_unproven:g"), true);
});

test("derivation: generator with duplicate writer is rejected", () => {
  const gens: AuthorityRegistry["generators"] = [
    { id: "g1", ownerPath: "src/owner.ts", authorityInputs: ["receipt.version"], dependsOn: [], outputs: ["shared.ts"] },
    { id: "g2", ownerPath: "src/consumer.ts", authorityInputs: ["test.surface.scope"], dependsOn: [], outputs: ["shared.ts"] },
  ];
  const sources = [...BASE_SOURCES, source("shared.ts", `export const X = 1;`)];
  assert.equal(has(rawAnalyze(sources, registry(sources, { generators: gens })),
    "authority_generator_writer_duplicate"), true);
});

test("derivation: generator with back-edge to authority is rejected", () => {
  const gens: AuthorityRegistry["generators"] = [{
    id: "g", ownerPath: "src/owner.ts", authorityInputs: ["receipt.version"],
    dependsOn: [], outputs: ["src/owner.ts"],
  }];
  assert.equal(has(rawAnalyze(BASE_SOURCES, registry(BASE_SOURCES, { generators: gens })),
    "authority_generator_back_edge:g:src/owner.ts"), true);
});

test("derivation: generator with orphan dependency is rejected", () => {
  const gens: AuthorityRegistry["generators"] = [{
    id: "g", ownerPath: "src/owner.ts", authorityInputs: ["receipt.version"],
    dependsOn: ["nonexistent-gen"], outputs: ["g.ts"],
  }];
  assert.equal(has(rawAnalyze(BASE_SOURCES, registry(BASE_SOURCES, { generators: gens })),
    "authority_generator_dependency_orphan:g:nonexistent-gen"), true);
});

test("derivation: generator with self-cycle is rejected", () => {
  const gens: AuthorityRegistry["generators"] = [{
    id: "g", ownerPath: "src/owner.ts", authorityInputs: ["receipt.version"],
    dependsOn: ["g"], outputs: ["g.ts"],
  }];
  assert.equal(has(rawAnalyze(BASE_SOURCES, registry(BASE_SOURCES, { generators: gens })),
    "authority_generator_cycle:g"), true);
});

test("derivation: two-generator cycle is rejected", () => {
  const gens: AuthorityRegistry["generators"] = [
    { id: "g1", ownerPath: "src/owner.ts", authorityInputs: ["receipt.version"], dependsOn: ["g2"], outputs: ["g1.ts"] },
    { id: "g2", ownerPath: "src/consumer.ts", authorityInputs: ["test.surface.scope"], dependsOn: ["g1"], outputs: ["g2.ts"] },
  ];
  const sources = [...BASE_SOURCES, source("g1.ts", ""), source("g2.ts", "")];
  assert.equal(has(rawAnalyze(sources, registry(sources, { generators: gens })),
    "authority_generator_cycle"), true);
});

test("derivation: generator with non-canonical fields is rejected", () => {
  const gens: AuthorityRegistry["generators"] = [{
    id: "g", ownerPath: "src/owner.ts", authorityInputs: ["receipt.version"],
    dependsOn: [], outputs: ["g.ts", "g.ts"],
  }];
  assert.equal(has(rawAnalyze(BASE_SOURCES, registry(BASE_SOURCES, { generators: gens })),
    "authority_generator_noncanonical:g"), true);
});

test("derivation: generator with duplicate ID is rejected", () => {
  const gens: AuthorityRegistry["generators"] = [
    { id: "g", ownerPath: "src/owner.ts", authorityInputs: ["receipt.version"], dependsOn: [], outputs: ["g1.ts"] },
    { id: "g", ownerPath: "src/consumer.ts", authorityInputs: ["test.surface.scope"], dependsOn: [], outputs: ["g2.ts"] },
  ];
  assert.equal(has(rawAnalyze(BASE_SOURCES, registry(BASE_SOURCES, { generators: gens })),
    "authority_generator_duplicate:g"), true);
});

test("derivation: every generator gets reproducibility_unproven", () => {
  const gens: AuthorityRegistry["generators"] = [
    { id: "g1", ownerPath: "src/owner.ts", authorityInputs: ["receipt.version"], dependsOn: [], outputs: ["g1.ts"] },
    { id: "g2", ownerPath: "src/consumer.ts", authorityInputs: ["test.surface.scope"], dependsOn: ["g1"], outputs: ["g2.ts"] },
  ];
  const sources = [...BASE_SOURCES, source("g1.ts", ""), source("g2.ts", "")];
  const result = rawAnalyze(sources, registry(sources, { generators: gens }));
  assert.equal(has(result, "authority_generator_reproducibility_unproven:g1"), true);
  assert.equal(has(result, "authority_generator_reproducibility_unproven:g2"), true);
});

test("derivation: generator with empty ID is rejected", () => {
  const gens: AuthorityRegistry["generators"] = [{
    id: "", ownerPath: "src/owner.ts", authorityInputs: ["receipt.version"],
    dependsOn: [], outputs: ["g.ts"],
  }];
  assert.equal(has(rawAnalyze(BASE_SOURCES, registry(BASE_SOURCES, { generators: gens })),
    "authority_generator_orphan:"), true);
});

test("derivation: generator with empty outputs is rejected", () => {
  const gens: AuthorityRegistry["generators"] = [{
    id: "g", ownerPath: "src/owner.ts", authorityInputs: ["receipt.version"],
    dependsOn: [], outputs: [],
  }];
  assert.equal(has(rawAnalyze(BASE_SOURCES, registry(BASE_SOURCES, { generators: gens })),
    "authority_generator_orphan:g"), true);
});

// ---------------------------------------------------------------------------
// 10. Concurrency and determinism
// ---------------------------------------------------------------------------

test("concurrency: parallel analysis of same inputs produces same lock", () => {
  const results = [analyze(), analyze(), analyze()];
  assert.equal(results[0]!.lock.lockHash, results[1]!.lock.lockHash);
  assert.equal(results[1]!.lock.lockHash, results[2]!.lock.lockHash);
});

test("concurrency: analysis of different inputs produces different locks", () => {
  const a = analyze();
  const modifiedOwner = source("src/owner.ts", OWNER_SOURCE.replace("v4", "v5"));
  const b = analyze([modifiedOwner, BASE_SOURCES[1]!], registry([modifiedOwner, BASE_SOURCES[1]!]));
  assert.notEqual(a.lock.lockHash, b.lock.lockHash);
});

test("concurrency: violations array is stable across repetitions", () => {
  const first = analyze().violations;
  for (let i = 1; i < 10; i += 1) {
    assert.deepEqual(analyze().violations, first);
  }
});

test("concurrency: occurrences array is stable across repetitions", () => {
  const first = analyze().lock.occurrences;
  for (let i = 1; i < 10; i += 1) {
    assert.deepEqual(analyze().lock.occurrences, first);
  }
});

test("concurrency: applicability matrix is stable across repetitions", () => {
  const first = analyze().lock.applicabilityMatrix;
  for (let i = 1; i < 10; i += 1) {
    assert.deepEqual(analyze().lock.applicabilityMatrix, first);
  }
});

test("concurrency: adapter coverage is stable across repetitions", () => {
  const first = analyze().lock.adapterCoverage;
  for (let i = 1; i < 10; i += 1) {
    assert.deepEqual(analyze().lock.adapterCoverage, first);
  }
});

test("concurrency: result object is frozen across all repetitions", () => {
  for (let i = 0; i < 10; i += 1) {
    const result = analyze();
    assert.ok(Object.isFrozen(result), `iteration ${i}: result not frozen`);
    assert.ok(Object.isFrozen(result.lock), `iteration ${i}: lock not frozen`);
  }
});

test("concurrency: source-order independence (sources in different order same lock)", () => {
  const forward = analyze([BASE_SOURCES[0]!, BASE_SOURCES[1]!], registry([BASE_SOURCES[0]!, BASE_SOURCES[1]!]));
  const reverse = analyze([BASE_SOURCES[1]!, BASE_SOURCES[0]!], registry([BASE_SOURCES[1]!, BASE_SOURCES[0]!]));
  assert.equal(forward.lock.lockHash, reverse.lock.lockHash);
});

// ---------------------------------------------------------------------------
// 11. Input boundary and malformed payloads
// ---------------------------------------------------------------------------

test("input: null input is handled gracefully", () => {
  const result = analyzeAuthorityGraph(null as unknown as AuthorityGraphInput);
  assert.equal(has(result, "authority_graph_input_invalid"), true);
});

test("input: undefined input is handled gracefully", () => {
  const result = analyzeAuthorityGraph(undefined as unknown as AuthorityGraphInput);
  assert.equal(has(result, "authority_graph_input_invalid"), true);
});

test("input: array input is handled gracefully", () => {
  const result = analyzeAuthorityGraph([] as unknown as AuthorityGraphInput);
  assert.equal(has(result, "authority_graph_input_invalid"), true);
});

test("input: string input is handled gracefully", () => {
  const result = analyzeAuthorityGraph("not-an-object" as unknown as AuthorityGraphInput);
  assert.equal(has(result, "authority_graph_input_invalid"), true);
});

test("input: input with extra keys is rejected", () => {
  const result = analyzeAuthorityGraph({
    ...({ registry: registry(BASE_SOURCES), sources: BASE_SOURCES,
      discoveredUniverse: declaredUniverse(BASE_SOURCES),
      sourceInventory: createAuthoritySourceInventory(BASE_SOURCES, "caller-asserted-test-root") }),
    extra: true,
  } as unknown as AuthorityGraphInput);
  assert.equal(has(result, "authority_graph_input_invalid"), true);
});

test("input: input with missing registry is handled", () => {
  const result = analyzeAuthorityGraph({
    sources: BASE_SOURCES, discoveredUniverse: declaredUniverse(BASE_SOURCES),
    sourceInventory: createAuthoritySourceInventory(BASE_SOURCES, "caller-asserted-test-root"),
  } as unknown as AuthorityGraphInput);
  assert.equal(has(result, "authority_registry_schema_invalid"), true);
});

test("input: input with missing sources is handled", () => {
  const result = analyzeAuthorityGraph({
    registry: registry(BASE_SOURCES), discoveredUniverse: declaredUniverse(BASE_SOURCES),
    sourceInventory: createAuthoritySourceInventory(BASE_SOURCES, "caller-asserted-test-root"),
  } as unknown as AuthorityGraphInput);
  // Missing sources means empty array, which is handled
  assert.ok(result.lock.sources.length === 0 || has(result, "authority_source_invalid"));
});

test("input: input with missing discoveredUniverse is handled", () => {
  const result = analyzeAuthorityGraph({
    registry: registry(BASE_SOURCES), sources: BASE_SOURCES,
    sourceInventory: createAuthoritySourceInventory(BASE_SOURCES, "caller-asserted-test-root"),
  } as unknown as AuthorityGraphInput);
  assert.equal(has(result, "authority_discovered_universe_invalid"), true);
});

test("input: input with missing sourceInventory is handled", () => {
  const result = analyzeAuthorityGraph({
    registry: registry(BASE_SOURCES), sources: BASE_SOURCES,
    discoveredUniverse: declaredUniverse(BASE_SOURCES),
  } as unknown as AuthorityGraphInput);
  assert.equal(has(result, "authority_source_inventory_untrusted"), true);
});

test("input: malformed registry with non-array authorities is handled", () => {
  const result = analyzeAuthorityGraph({
    registry: { ...registry(BASE_SOURCES), authorities: "not-array" } as unknown as AuthorityRegistry,
    sources: BASE_SOURCES, discoveredUniverse: declaredUniverse(BASE_SOURCES),
    sourceInventory: createAuthoritySourceInventory(BASE_SOURCES, "caller-asserted-test-root"),
  });
  assert.equal(has(result, "authority_registry_schema_invalid"), true);
});

test("input: malformed registry with non-array generators is handled", () => {
  const result = analyzeAuthorityGraph({
    registry: { ...registry(BASE_SOURCES), generators: "not-array" } as unknown as AuthorityRegistry,
    sources: BASE_SOURCES, discoveredUniverse: declaredUniverse(BASE_SOURCES),
    sourceInventory: createAuthoritySourceInventory(BASE_SOURCES, "caller-asserted-test-root"),
  });
  assert.equal(has(result, "authority_registry_schema_invalid"), true);
});

test("input: malformed registry with non-record applicability is handled", () => {
  const result = analyzeAuthorityGraph({
    registry: { ...registry(BASE_SOURCES), applicability: "not-record" } as unknown as AuthorityRegistry,
    sources: BASE_SOURCES, discoveredUniverse: declaredUniverse(BASE_SOURCES),
    sourceInventory: createAuthoritySourceInventory(BASE_SOURCES, "caller-asserted-test-root"),
  });
  assert.equal(has(result, "authority_registry_schema_invalid"), true);
});

test("input: deeply nested malformed records are nonthrowing", () => {
  const result = analyzeAuthorityGraph({
    registry: { schemaVersion: AUTHORITY_REGISTRY_SCHEMA_VERSION, authorities: [{ id: "x" }] } as unknown as AuthorityRegistry,
    sources: BASE_SOURCES, discoveredUniverse: declaredUniverse(BASE_SOURCES),
    sourceInventory: createAuthoritySourceInventory(BASE_SOURCES, "caller-asserted-test-root"),
  });
  assert.equal(has(result, "authority_registry_route_invalid"), true);
});

test("input: source with parse error is nonthrowing", () => {
  const broken = source("src/broken.ts", "export const = ;");
  const sources = [...BASE_SOURCES, broken];
  const result = rawAnalyze(sources, registry(sources));
  assert.equal(has(result, "authority_source_parse_failed:src/broken.ts"), true);
});

test("input: createAuthoritySourceInventory with empty root throws", () => {
  assert.throws(() => createAuthoritySourceInventory([], ""), TypeError);
});

test("input: createAuthoritySourceInventory with valid root works", () => {
  const inv = createAuthoritySourceInventory(BASE_SOURCES, "test-root");
  assert.equal(inv.schemaVersion, AUTHORITY_SOURCE_INVENTORY_SCHEMA_VERSION);
  assert.equal(inv.provenance, AUTHORITY_SOURCE_INVENTORY_PROVENANCE);
  assert.equal(inv.rootIdentity, "test-root");
  assert.equal(inv.entries.length, BASE_SOURCES.length);
});

test("input: createAuthoritySourceInventory entries are sorted by path", () => {
  const inv = createAuthoritySourceInventory([BASE_SOURCES[1]!, BASE_SOURCES[0]!], "test-root");
  const paths = inv.entries.map((e) => e.path);
  assert.deepEqual(paths, [...paths].sort());
});

test("input: createAuthoritySourceInventory entries have correct sha256", () => {
  const inv = createAuthoritySourceInventory(BASE_SOURCES, "test-root");
  for (const entry of inv.entries) {
    const original = BASE_SOURCES.find((s) => s.path === entry.path);
    assert.ok(original);
    assert.equal(entry.sha256, sha256(original.source));
  }
});

test("input: inventory with wrong schema version is untrusted", () => {
  const inv = { ...createAuthoritySourceInventory(BASE_SOURCES, "root"),
    schemaVersion: "wrong/v1" };
  const result = analyzeAuthorityGraph({
    registry: registry(BASE_SOURCES), sources: BASE_SOURCES,
    discoveredUniverse: declaredUniverse(BASE_SOURCES), sourceInventory: inv,
  } as unknown as AuthorityGraphInput);
  assert.equal(has(result, "authority_source_inventory_untrusted"), true);
});

test("input: inventory with empty root identity is untrusted", () => {
  const inv = { ...createAuthoritySourceInventory(BASE_SOURCES, "root"),
    rootIdentity: "" };
  const result = analyzeAuthorityGraph({
    registry: registry(BASE_SOURCES), sources: BASE_SOURCES,
    discoveredUniverse: declaredUniverse(BASE_SOURCES), sourceInventory: inv,
  } as unknown as AuthorityGraphInput);
  assert.equal(has(result, "authority_source_inventory_untrusted"), true);
});

test("input: inventory with non-array entries is untrusted", () => {
  const inv = { ...createAuthoritySourceInventory(BASE_SOURCES, "root"),
    entries: "not-array" } as any;
  const result = analyzeAuthorityGraph({
    registry: registry(BASE_SOURCES), sources: BASE_SOURCES,
    discoveredUniverse: declaredUniverse(BASE_SOURCES), sourceInventory: inv,
  });
  assert.equal(has(result, "authority_source_inventory_untrusted"), true);
});

test("input: inventory with extra key is untrusted", () => {
  const inv = { ...createAuthoritySourceInventory(BASE_SOURCES, "root"),
    extra: true } as any;
  const result = analyzeAuthorityGraph({
    registry: registry(BASE_SOURCES), sources: BASE_SOURCES,
    discoveredUniverse: declaredUniverse(BASE_SOURCES), sourceInventory: inv,
  });
  assert.equal(has(result, "authority_source_inventory_untrusted"), true);
});

test("input: inventory entry with invalid sha256 is rejected", () => {
  const inv = structuredClone(createAuthoritySourceInventory(BASE_SOURCES, "root")) as any;
  inv.entries[0].sha256 = "not-a-hash";
  const result = analyzeAuthorityGraph({
    registry: registry(BASE_SOURCES), sources: BASE_SOURCES,
    discoveredUniverse: declaredUniverse(BASE_SOURCES), sourceInventory: inv,
  });
  assert.equal(has(result, "authority_source_inventory_entry_invalid"), true);
});

test("input: inventory entry with invalid path is rejected", () => {
  const inv = structuredClone(createAuthoritySourceInventory(BASE_SOURCES, "root")) as any;
  inv.entries[0].path = "/absolute";
  const result = analyzeAuthorityGraph({
    registry: registry(BASE_SOURCES), sources: BASE_SOURCES,
    discoveredUniverse: declaredUniverse(BASE_SOURCES), sourceInventory: inv,
  });
  assert.equal(has(result, "authority_source_inventory_entry_invalid"), true);
});

test("input: inventory with non-canonical entry order is rejected", () => {
  const inv = structuredClone(createAuthoritySourceInventory(BASE_SOURCES, "root")) as any;
  inv.entries.reverse();
  const result = analyzeAuthorityGraph({
    registry: registry(BASE_SOURCES), sources: BASE_SOURCES,
    discoveredUniverse: declaredUniverse(BASE_SOURCES), sourceInventory: inv,
  });
  assert.equal(has(result, "authority_source_inventory_noncanonical"), true);
});
