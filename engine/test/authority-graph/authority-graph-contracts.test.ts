import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeAuthorityGraph,
  AUTHORITY_REGISTRY_SCHEMA_VERSION,
  createAuthoritySourceInventory,
  type AuthorityGraphInput,
  type AuthorityRegistry,
  type AuthorityRoleException,
} from "../../scripts/verification/authority-graph.ts";
import { sha256 } from "../../src/kernel/integrity.ts";
import {
  analyze,
  BASE_SOURCES,
  declaredUniverse,
  discoveredUniverse,
  has,
  registry,
  source,
} from "../support/authority-graph-fixture.ts";

test("[AG-K001] exception roles and selectors cannot be established by labels, broad paths, or stale hashes", () => {
  const historical = source("test/history.ts", `export const HISTORICAL = "example.test-result/v3";`);
  const mutation = source("test/mutation.ts", `export const MUTATION = "example.test-result/v999";`);
  const sources = [...BASE_SOURCES, historical, mutation];
  const baseline = analyze(sources, registry(sources));
  const exceptions: AuthorityRoleException[] = [historical, mutation].map((candidate, index) => ({
    authorityId: "receipt.version",
    path: candidate.path,
    selector: baseline.lock.occurrences.find((entry) =>
      entry.authorityId === "receipt.version" && entry.path === candidate.path)!.selector,
    sourceSha256: sha256(candidate.source),
    role: index === 0 ? "historical" : "mutation",
    rationale: "A label is not a receipt.",
    evidenceLinks: [`https://unresolved.invalid/${index}`],
  }));
  const result = analyze(sources, registry(sources, { exceptions }));
  assert.equal(result.lock.occurrences.some((entry) =>
    entry.role === "historical" || entry.role === "mutation"), false);
  assert.equal(result.violations.filter((entry) => entry.startsWith("authority_exception_role_unproven")).length, 2);

  const copy = source("test/copy.ts", `export const COPY = "example.test-result/v4";`);
  const copySources = [...BASE_SOURCES, copy];
  const broad: AuthorityRoleException = {
    authorityId: "receipt.version",
    path: "test/*.ts",
    selector: "export:COPY@0:1",
    sourceSha256: sha256(copy.source),
    role: "historical",
    rationale: "Broad paths are forbidden.",
    evidenceLinks: ["https://evidence.invalid/broad"],
  };
  const broadResult = analyze(copySources, registry(copySources, { exceptions: [broad] }));
  assert.equal(has(broadResult, "authority_exception_invalid"), true);
  assert.equal(has(broadResult, "authority_literal_duplicate:receipt.version"), true);
  const stale = { ...broad, path: copy.path, sourceSha256: "0".repeat(64) };
  assert.equal(has(analyze(copySources, registry(copySources, { exceptions: [stale] })),
    "authority_exception_invalid"), true);
});

test("[AG-K002] authority-specific applicability catches omitted dimensions, unsupported adapters, and unresolved evidence", () => {
  const extra = source("src/new-module.ts", `export const value = 1;`);
  const moduleSources = [...BASE_SOURCES, extra];
  const omitted = analyze(moduleSources, registry(BASE_SOURCES));
  assert.equal(has(omitted, "authority_applicability_missing_cell:receipt.version:modules:src/new-module.ts"), true);

  const providerUniverse = discoveredUniverse({ providers: ["new-provider", "provider-neutral"] });
  assert.equal(has(analyze(BASE_SOURCES, registry(BASE_SOURCES), providerUniverse),
    "authority_applicability_missing_cell:receipt.version:providers:new-provider"), true);

  const python = source("src/adapter.py", "VALUE = 1\n", "python");
  const languageSources = [...BASE_SOURCES, python];
  const languageUniverse = discoveredUniverse({ languages: ["python", "typescript"] });
  const unsupported = analyze(languageSources, registry(languageSources, {
    universe: languageUniverse,
    adapters: [{
      language: "python", adapterId: "python-authority/unqualified-v1", status: "unsupported",
    }, registry().adapters[0]!],
  }), languageUniverse);
  assert.equal(has(unsupported, "authority_adapter_unsupported:python"), true);

  const exactCell = registry(BASE_SOURCES, { cells: [{
    authorityId: "receipt.version",
    dimension: "extensions",
    member: "core",
    disposition: "not-applicable-with-evidence",
    rationale: "Still requires a resolution receipt.",
    evidenceLinks: ["https://evidence.invalid/scope"],
  }] });
  const unresolved = analyze(BASE_SOURCES, exactCell);
  assert.equal(has(unresolved, "authority_applicability_evidence_unresolved"), true);
  assert.equal(unresolved.lock.applicabilityMatrix.find((cell) =>
    cell.authorityId === "receipt.version" && cell.dimension === "extensions")?.disposition,
  "not-applicable-with-evidence");
  assert.equal(unresolved.lock.applicabilityMatrix.find((cell) =>
    cell.authorityId === "test.surface.scope" && cell.dimension === "extensions")?.disposition,
  "applies");
});

test("[AG-K003] derivation graph rejects missing inventories, duplicate writers, cycles, orphans, and back-edges", () => {
  assert.equal(has(analyze(), "authority_derivation_inventory_unavailable"), true);
  const generators: AuthorityRegistry["generators"] = [{
    id: "first",
    ownerPath: "src/owner.ts",
    authorityInputs: ["missing.authority", "receipt.version"],
    dependsOn: ["missing-generator", "second"],
    outputs: ["generated/shared.ts", "src/owner.ts"],
  }, {
    id: "second",
    ownerPath: "src/consumer.ts",
    authorityInputs: ["test.surface.scope"],
    dependsOn: ["first"],
    outputs: ["generated/shared.ts"],
  }];
  const result = analyze(BASE_SOURCES, registry(BASE_SOURCES, { generators }));
  for (const prefix of [
    "authority_generator_input_orphan", "authority_generator_dependency_orphan",
    "authority_generator_writer_duplicate", "authority_generator_back_edge",
    "authority_generator_cycle", "authority_generator_output_unproven",
    "authority_generator_reproducibility_unproven",
  ]) assert.equal(has(result, prefix), true, `${prefix}: ${result.violations.join("\n")}`);
});

test("[AG-K004] strict runtime contracts are nonthrowing across malformed roots, sources, and nested records", () => {
  const malformed = analyzeAuthorityGraph({
    registry: { schemaVersion: AUTHORITY_REGISTRY_SCHEMA_VERSION },
    sources: BASE_SOURCES,
    discoveredUniverse: discoveredUniverse(),
  } as unknown as AuthorityGraphInput);
  assert.equal(has(malformed, "authority_registry_schema_invalid"), true);
  assert.equal(has(malformed, "authority_source_inventory_untrusted"), true);

  const value = structuredClone(registry(BASE_SOURCES)) as any;
  value.authorities[0].owner.copied = "semantic";
  value.adapters[0].copied = "semantic";
  value.applicability.copied = "semantic";
  value.applicability.cells.push({
    authorityId: "receipt.version", dimension: "modules", member: "src/owner.ts",
    disposition: "applies", copied: "semantic",
  });
  value.roleExceptions.push({ copied: "semantic" });
  value.generators.push({
    id: "copied", ownerPath: "src/consumer.ts", authorityInputs: ["receipt.version"],
    dependsOn: [], outputs: ["src/generated.ts"], copied: "semantic",
  });
  const strict = analyzeAuthorityGraph({
    registry: value,
    sources: BASE_SOURCES,
    discoveredUniverse: declaredUniverse(BASE_SOURCES),
    sourceInventory: createAuthoritySourceInventory(BASE_SOURCES, "caller-asserted-test-root"),
  });
  for (const prefix of [
    "authority_registry_route_invalid", "authority_registry_adapter_invalid",
    "authority_registry_applicability_invalid", "authority_registry_applicability_cell_invalid",
    "authority_registry_exception_invalid", "authority_registry_generator_invalid",
  ]) assert.equal(has(strict, prefix), true, `${prefix}: ${strict.violations.join("\n")}`);

  const broken = source("src/broken.ts", "export const = ;");
  const brokenSources = [...BASE_SOURCES, broken];
  assert.equal(has(analyze(brokenSources, registry(brokenSources)), "authority_source_parse_failed"), true);
});

test("[AG-K005] source inventory and metadata are hashed exactly and cannot narrow discovered modules", () => {
  const universe = declaredUniverse(BASE_SOURCES);
  const complete = createAuthoritySourceInventory(BASE_SOURCES, "caller-asserted-test-root");
  const incomplete = analyzeAuthorityGraph({
    registry: registry(BASE_SOURCES),
    sources: BASE_SOURCES,
    discoveredUniverse: universe,
    sourceInventory: { ...complete, entries: complete.entries.slice(0, 1) },
  });
  assert.equal(has(incomplete, "authority_source_inventory_mismatch"), true);
  assert.equal(has(incomplete, "authority_source_inventory_untrusted"), true);

  const ghostUniverse = discoveredUniverse({ modules: ["src/ghost.ts"] });
  const ghost = analyze(BASE_SOURCES, registry(BASE_SOURCES, { universe: ghostUniverse }), ghostUniverse);
  assert.equal(has(ghost, "authority_source_set_incomplete:modules:src/ghost.ts"), true);

  const firstSources = BASE_SOURCES.map((entry, index) => ({
    ...entry, layer: index === 0 ? "one" : "two", realm: index === 0 ? "alpha" : "beta",
    testId: index === 0 ? "first" : "second",
  }));
  const secondSources = firstSources.map((entry, index) => ({
    ...entry, layer: index === 0 ? "two" : "one", realm: index === 0 ? "beta" : "alpha",
    testId: index === 0 ? "second" : "first",
  }));
  const metadataUniverse = discoveredUniverse({
    layers: ["one", "two"], realms: ["alpha", "beta"], tests: ["first", "second"],
  });
  const first = analyze(firstSources, registry(firstSources, { universe: metadataUniverse }), metadataUniverse);
  const second = analyze(secondSources, registry(secondSources, { universe: metadataUniverse }), metadataUniverse);
  assert.notEqual(first.lock.lockHash, second.lock.lockHash);
});

test("[AG-K006] duplicate domains, false adapter identities, canonical registry order, and code-point paths block", () => {
  const duplicateAuthorities: AuthorityRegistry["authorities"] = [
    ...registry().authorities,
    { id: "receipt.version", kind: "literal", owner: { path: "src/consumer.ts", exportName: "emitted" } },
  ];
  assert.equal(has(analyze(BASE_SOURCES, registry(BASE_SOURCES, { authorities: duplicateAuthorities })),
    "authority_domain_duplicate:receipt.version"), true);

  const falseQualified = registry(BASE_SOURCES, { adapters: [{
    language: "typescript", adapterId: "unqualified-adapter/v1", status: "qualified",
  }] });
  assert.equal(has(analyze(BASE_SOURCES, falseQualified), "authority_adapter_identity_invalid:typescript"), true);

  const reversed = structuredClone(registry(BASE_SOURCES)) as any;
  reversed.authorities.reverse();
  assert.equal(has(analyze(BASE_SOURCES, reversed), "authority_registry_authorities_noncanonical"), true);

  const zed = source("src/z.ts", `export const value = 1;`);
  const accented = source("src/é.ts", `export const value = 2;`);
  const sources = [...BASE_SOURCES, accented, zed];
  const result = analyze(sources, registry(sources));
  const paths = result.lock.sources.map((entry) => entry.path);
  assert.ok(paths.indexOf(zed.path) < paths.indexOf(accented.path), paths.join("\n"));
});
