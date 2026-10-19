import { canonicalDomainHash, deepFreeze } from "../../../src/kernel/integrity.ts";
import { normalizeUniverse } from "./applicability.ts";
import {
  AUTHORITY_REGISTRY_SCHEMA_VERSION,
  AUTHORITY_SOURCE_INVENTORY_PROVENANCE,
  AUTHORITY_SOURCE_INVENTORY_SCHEMA_VERSION,
  AUTHORITY_UNIVERSE_DIMENSIONS,
  authoritySourceInventoryEntry,
  type AuthorityRegistry,
  type AuthoritySource,
  type AuthoritySourceInventory,
  type AuthorityUniverseDimension,
} from "./contracts.ts";
import {
  SHA256_PATTERN,
  array,
  codePointCompare,
  exactPath,
  extraKeys,
  identifier,
  isRecord,
  nonempty,
  nullableString,
  sameOrdered,
  stringArray,
  stringValue,
} from "./shared.ts";

const REGISTRY_KEYS = new Set(["schemaVersion", "authorities", "roleExceptions", "generators", "adapters", "applicability"]);
const AUTHORITY_KEYS = new Set(["id", "kind", "owner"]);
const OWNER_KEYS = new Set(["path", "exportName"]);
const EXCEPTION_KEYS = new Set([
  "authorityId", "path", "selector", "sourceSha256", "role", "rationale", "evidenceLinks", "distinctAuthorityId",
]);
const GENERATOR_KEYS = new Set(["id", "ownerPath", "authorityInputs", "dependsOn", "outputs"]);
const ADAPTER_KEYS = new Set(["language", "adapterId", "status"]);
const APPLICABILITY_KEYS = new Set(["defaultDisposition", "declaredUniverse", "cells"]);
const APPLICABILITY_CELL_KEYS = new Set([
  "authorityId", "dimension", "member", "disposition", "rationale", "evidenceLinks",
]);
const SOURCE_KEYS = new Set(["path", "language", "source", "layer", "realm", "testId"]);
const INVENTORY_KEYS = new Set(["schemaVersion", "provenance", "rootIdentity", "entries"]);
const INVENTORY_ENTRY_KEYS = new Set(["path", "language", "layer", "realm", "testId", "sha256"]);

export function coerceRegistry(value: unknown, violations: string[]): AuthorityRegistry {
  const registry = isRecord(value) ? value : {};
  validateRegistryShape(registry, violations);
  const applicability = isRecord(registry.applicability) ? registry.applicability : {};
  return deepFreeze({
    schemaVersion: AUTHORITY_REGISTRY_SCHEMA_VERSION,
    authorities: array(registry.authorities).filter(isRecord).map((authority) => {
      const owner = isRecord(authority.owner) ? authority.owner : {};
      return {
        id: typeof authority.id === "string" ? authority.id : "invalid",
        kind: authority.kind === "zod-strict-object" ? "zod-strict-object" : "literal",
        owner: {
          path: typeof owner.path === "string" ? owner.path : "invalid",
          exportName: typeof owner.exportName === "string" ? owner.exportName : "invalid",
        },
      };
    }),
    roleExceptions: array(registry.roleExceptions).filter(isRecord).map((exception) => ({
      authorityId: stringValue(exception.authorityId), path: stringValue(exception.path),
      selector: stringValue(exception.selector), sourceSha256: stringValue(exception.sourceSha256),
      role: exception.role === "mutation" || exception.role === "distinct-domain" ? exception.role : "historical",
      rationale: stringValue(exception.rationale), evidenceLinks: stringArray(exception.evidenceLinks),
      ...(typeof exception.distinctAuthorityId === "string" ? { distinctAuthorityId: exception.distinctAuthorityId } : {}),
    })),
    generators: array(registry.generators).filter(isRecord).map((generator) => ({
      id: stringValue(generator.id), ownerPath: stringValue(generator.ownerPath),
      authorityInputs: stringArray(generator.authorityInputs), dependsOn: stringArray(generator.dependsOn),
      outputs: stringArray(generator.outputs),
    })),
    adapters: array(registry.adapters).filter(isRecord).map((adapter) => ({
      language: stringValue(adapter.language), adapterId: stringValue(adapter.adapterId),
      status: adapter.status === "qualified" ? "qualified" : "unsupported",
    })),
    applicability: {
      defaultDisposition: "applies",
      declaredUniverse: normalizeUniverse(applicability.declaredUniverse, "declared", violations),
      cells: array(applicability.cells).filter(validApplicabilityCellRecord).map((cell) => ({
        authorityId: stringValue(cell.authorityId),
        dimension: cell.dimension as AuthorityUniverseDimension,
        member: stringValue(cell.member),
        disposition: cell.disposition,
        ...(typeof cell.rationale === "string" ? { rationale: cell.rationale } : {}),
        ...(Array.isArray(cell.evidenceLinks) ? { evidenceLinks: stringArray(cell.evidenceLinks) } : {}),
      })),
    },
  }) as AuthorityRegistry;
}

export function normalizeSources(
  sources: readonly AuthoritySource[],
  violations: string[],
): readonly AuthoritySource[] {
  const seen = new Set<string>();
  const normalized: AuthoritySource[] = [];
  for (const source of sources) {
    if (isRecord(source) && [source.layer, source.realm, source.testId]
      .some((entry) => entry !== undefined && !nonempty(entry))) {
      violations.push(`authority_source_metadata_invalid:${String(source.path)}`);
    }
    if (!isRecord(source) || extraKeys(source, SOURCE_KEYS).length > 0 || !exactPath(source.path) ||
      typeof source.language !== "string" || source.language.length === 0 || typeof source.source !== "string" ||
      [source.layer, source.realm, source.testId].some((entry) => entry !== undefined && !nonempty(entry))) {
      violations.push("authority_source_invalid");
      continue;
    }
    if (seen.has(source.path)) violations.push(`authority_source_duplicate:${source.path}`);
    seen.add(source.path);
    normalized.push(source as AuthoritySource);
  }
  return normalized.toSorted((left, right) => codePointCompare(left.path, right.path));
}

export function validateSourceInventory(
  value: unknown,
  sources: readonly AuthoritySource[],
  violations: string[],
): AuthoritySourceInventory | null {
  if (!isRecord(value) || extraKeys(value, INVENTORY_KEYS).length > 0 ||
    value.schemaVersion !== AUTHORITY_SOURCE_INVENTORY_SCHEMA_VERSION ||
    value.provenance !== AUTHORITY_SOURCE_INVENTORY_PROVENANCE ||
    !nonempty(value.rootIdentity) || !Array.isArray(value.entries)) {
    violations.push("authority_source_inventory_untrusted");
    return null;
  }
  // A pure caller can construct this document over an arbitrarily narrowed
  // source list. Only the future descriptor-held broker can issue repository
  // completeness trust, so public analysis must remain blocking.
  violations.push("authority_source_inventory_untrusted");
  const entries: AuthoritySourceInventory["entries"][number][] = [];
  for (const entry of value.entries) {
    if (!isRecord(entry) || extraKeys(entry, INVENTORY_ENTRY_KEYS).length > 0 || !exactPath(entry.path) ||
      !nonempty(entry.language) || !SHA256_PATTERN.test(String(entry.sha256)) ||
      !nullableString(entry.layer) || !nullableString(entry.realm) || !nullableString(entry.testId)) {
      violations.push("authority_source_inventory_entry_invalid");
      continue;
    }
    entries.push({
      path: entry.path, language: entry.language, layer: entry.layer, realm: entry.realm,
      testId: entry.testId, sha256: entry.sha256 as string,
    });
  }
  const canonicalEntries = [...entries].toSorted((left, right) => codePointCompare(left.path, right.path));
  if (!sameOrdered(entries.map((entry) => entry.path), canonicalEntries.map((entry) => entry.path)) ||
    new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    violations.push("authority_source_inventory_noncanonical");
  }
  const expected = sources.map(authoritySourceInventoryEntry).toSorted((left, right) => codePointCompare(left.path, right.path));
  if (canonicalDomainHash("authority-graph/source-entries/v1", canonicalEntries) !==
    canonicalDomainHash("authority-graph/source-entries/v1", expected)) {
    violations.push("authority_source_inventory_mismatch");
  }
  return deepFreeze({
    schemaVersion: AUTHORITY_SOURCE_INVENTORY_SCHEMA_VERSION,
    provenance: AUTHORITY_SOURCE_INVENTORY_PROVENANCE,
    rootIdentity: value.rootIdentity,
    entries: canonicalEntries,
  });
}

function validateRegistryShape(registry: Readonly<Record<string, unknown>>, violations: string[]): void {
  if (registry.schemaVersion !== AUTHORITY_REGISTRY_SCHEMA_VERSION || extraKeys(registry, REGISTRY_KEYS).length > 0 ||
    !Array.isArray(registry.authorities) || !Array.isArray(registry.roleExceptions) ||
    !Array.isArray(registry.generators) || !Array.isArray(registry.adapters) || !isRecord(registry.applicability)) {
    violations.push("authority_registry_schema_invalid");
  }
  const ids = new Set<string>();
  const owners = new Set<string>();
  const authorityOrder: string[] = [];
  for (const authority of array(registry.authorities)) {
    if (!isRecord(authority) || extraKeys(authority, AUTHORITY_KEYS).length > 0 ||
      typeof authority.id !== "string" || !/^[a-z0-9][a-z0-9._/-]*$/u.test(authority.id) ||
      !["literal", "zod-strict-object"].includes(String(authority.kind)) || !isRecord(authority.owner) ||
      extraKeys(authority.owner, OWNER_KEYS).length > 0 || !exactPath(authority.owner.path) ||
      !identifier(authority.owner.exportName)) {
      violations.push("authority_registry_route_invalid");
      continue;
    }
    if (ids.has(authority.id)) violations.push(`authority_domain_duplicate:${authority.id}`);
    ids.add(authority.id);
    authorityOrder.push(authority.id);
    const owner = `${authority.owner.path}#${authority.owner.exportName}`;
    if (owners.has(owner)) violations.push(`authority_owner_reused:${owner}`);
    owners.add(owner);
  }
  if (!sameOrdered(authorityOrder, [...authorityOrder].toSorted(codePointCompare))) {
    violations.push("authority_registry_authorities_noncanonical");
  }
  for (const exception of array(registry.roleExceptions)) {
    if (!isRecord(exception) || extraKeys(exception, EXCEPTION_KEYS).length > 0) {
      violations.push("authority_registry_exception_invalid");
    }
    if (isRecord(exception) && Array.isArray(exception.evidenceLinks)) {
      const links = stringArray(exception.evidenceLinks);
      if (links.length !== exception.evidenceLinks.length || new Set(links).size !== links.length ||
        !sameOrdered(links, [...links].toSorted(codePointCompare))) {
        violations.push("authority_registry_exception_evidence_noncanonical");
      }
    }
  }
  const exceptionOrder = array(registry.roleExceptions).filter(isRecord).map((exception) => JSON.stringify([
    stringValue(exception.authorityId), stringValue(exception.path), stringValue(exception.selector),
  ]));
  if (new Set(exceptionOrder).size !== exceptionOrder.length ||
    !sameOrdered(exceptionOrder, [...exceptionOrder].toSorted(codePointCompare))) {
    violations.push("authority_registry_exceptions_noncanonical");
  }
  for (const generator of array(registry.generators)) {
    if (!isRecord(generator) || extraKeys(generator, GENERATOR_KEYS).length > 0 ||
      !Array.isArray(generator.authorityInputs) || !Array.isArray(generator.dependsOn) ||
      !Array.isArray(generator.outputs)) violations.push("authority_registry_generator_invalid");
  }
  const generatorOrder = array(registry.generators).filter(isRecord).map((generator) => stringValue(generator.id));
  if (new Set(generatorOrder).size !== generatorOrder.length ||
    !sameOrdered(generatorOrder, [...generatorOrder].toSorted(codePointCompare))) {
    violations.push("authority_registry_generators_noncanonical");
  }
  for (const adapter of array(registry.adapters)) {
    if (!isRecord(adapter) || extraKeys(adapter, ADAPTER_KEYS).length > 0) {
      violations.push("authority_registry_adapter_invalid");
    }
  }
  const adapterOrder = array(registry.adapters).filter(isRecord).map((entry) => stringValue(entry.language));
  if (new Set(adapterOrder).size !== adapterOrder.length ||
    !sameOrdered(adapterOrder, [...adapterOrder].toSorted(codePointCompare))) {
    violations.push("authority_registry_adapters_noncanonical");
  }
  const applicability = isRecord(registry.applicability) ? registry.applicability : {};
  if (extraKeys(applicability, APPLICABILITY_KEYS).length > 0 ||
    !Array.isArray(applicability.cells) || !isRecord(applicability.declaredUniverse)) {
    violations.push("authority_registry_applicability_invalid");
  }
  for (const cell of array(applicability.cells)) {
    if (!validApplicabilityCellRecord(cell) || extraKeys(cell, APPLICABILITY_CELL_KEYS).length > 0) {
      violations.push("authority_registry_applicability_cell_invalid");
    }
    if (isRecord(cell) && Array.isArray(cell.evidenceLinks)) {
      const links = stringArray(cell.evidenceLinks);
      if (links.length !== cell.evidenceLinks.length || new Set(links).size !== links.length ||
        !sameOrdered(links, [...links].toSorted(codePointCompare))) {
        violations.push("authority_registry_applicability_evidence_noncanonical");
      }
    }
  }
  const cellOrder = array(applicability.cells).filter(isRecord).map((cell) => JSON.stringify([
    stringValue(cell.authorityId), stringValue(cell.dimension), stringValue(cell.member),
  ]));
  if (new Set(cellOrder).size !== cellOrder.length ||
    !sameOrdered(cellOrder, [...cellOrder].toSorted(codePointCompare))) {
    violations.push("authority_registry_applicability_cells_noncanonical");
  }
  if (applicability.defaultDisposition !== "applies") {
    violations.push("authority_applicability_default_not_universal");
  }
}

function validApplicabilityCellRecord(value: unknown): value is Readonly<Record<string, unknown>> & Readonly<{
  authorityId: string;
  dimension: AuthorityUniverseDimension;
  member: string;
  disposition: "applies" | "not-applicable-with-evidence" | "unsupported-blocking";
}> {
  return isRecord(value) && nonempty(value.authorityId) &&
    AUTHORITY_UNIVERSE_DIMENSIONS.includes(value.dimension as AuthorityUniverseDimension) &&
    nonempty(value.member) &&
    ["applies", "not-applicable-with-evidence", "unsupported-blocking"].includes(String(value.disposition)) &&
    (value.rationale === undefined || typeof value.rationale === "string") &&
    (value.evidenceLinks === undefined || Array.isArray(value.evidenceLinks) && value.evidenceLinks.every(nonempty));
}
