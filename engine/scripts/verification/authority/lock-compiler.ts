import {
  buildApplicabilityMatrix,
  deriveUniverse,
  normalizeUniverse,
  validateAdapters,
  validateDiscoveredSourceCoverage,
} from "./applicability.ts";
import { canonicalDomainHash, deepFreeze, sha256 } from "../../../src/kernel/integrity.ts";
import {
  AUTHORITY_LOCK_SCHEMA_VERSION,
  type AuthorityGraphInput,
  type AuthorityGraphResult,
  type AuthorityLock,
  type AuthoritySource,
} from "./contracts.ts";
import { validateDerivationGraph } from "./derivations.ts";
import { validateRoleExceptions } from "./exceptions.ts";
import { discoverAuthorityOccurrences } from "./occurrence-discovery.ts";
import { compareAuthorityOccurrences } from "./occurrence-selectors.ts";
import { coerceRegistry, normalizeSources, validateSourceInventory } from "./registry-runtime.ts";
import { resolveAuthorities } from "./semantic-resolution.ts";
import { array, codePointCompare, extraKeys, isRecord } from "./shared.ts";
import { parseTypeScriptModules } from "./typescript-adapter.ts";

const INPUT_KEYS = new Set(["registry", "sources", "discoveredUniverse", "sourceInventory"]);

/**
 * Pure orchestration and immutable lock assembly. Semantic parsing, occurrence
 * discovery, runtime validation, and applicability policy live in their
 * respective modules and are intentionally not re-exported through the façade.
 */
export function analyzeAuthorityGraph(input: AuthorityGraphInput): AuthorityGraphResult {
  const violations: string[] = [];
  const inputRecord: Readonly<Record<string, unknown>> = isRecord(input) ? input : {};
  if (!isRecord(input) || extraKeys(inputRecord, INPUT_KEYS).length > 0) {
    violations.push("authority_graph_input_invalid");
  }
  const registry = coerceRegistry(inputRecord.registry, violations);
  const sources = normalizeSources(array(inputRecord.sources) as readonly AuthoritySource[], violations);
  const discoveredUniverse = normalizeUniverse(inputRecord.discoveredUniverse, "discovered", violations);
  const sourceInventory = validateSourceInventory(inputRecord.sourceInventory, sources, violations);
  validateDiscoveredSourceCoverage(discoveredUniverse, sources, violations);
  const actualUniverse = deriveUniverse(discoveredUniverse, sources);
  const applicabilityMatrix = buildApplicabilityMatrix(registry, actualUniverse, violations);
  const adapterCoverage = validateAdapters(registry, actualUniverse, violations);
  const modules = parseTypeScriptModules(sources, violations);
  const resolved = resolveAuthorities(registry, modules, violations);
  validateDerivationGraph(registry, sources, violations);
  const occurrences = discoverAuthorityOccurrences(registry, modules, resolved, violations);
  validateRoleExceptions(registry, sources, occurrences, violations);

  const normalizedViolations = [...new Set(violations)].toSorted(codePointCompare);
  const unsignedLock = {
    schemaVersion: AUTHORITY_LOCK_SCHEMA_VERSION,
    registryHash: canonicalDomainHash("authority-graph/registry/v1", registry),
    sourceInventoryHash: sourceInventory === null
      ? null
      : canonicalDomainHash("authority-graph/source-inventory/v1", sourceInventory),
    sources: sources.map((source) => ({
      path: source.path,
      language: source.language,
      layer: source.layer ?? null,
      realm: source.realm ?? null,
      testId: source.testId ?? null,
      sha256: sha256(source.source),
    })),
    authorities: registry.authorities.map((route) => ({
      id: route.id,
      kind: route.kind,
      owner: { path: route.owner.path, exportName: route.owner.exportName },
      semanticFingerprint: resolved.get(route.id)?.semanticFingerprint ?? null,
    })).toSorted((left, right) => codePointCompare(left.id, right.id)),
    occurrences: [...occurrences].toSorted(compareAuthorityOccurrences),
    generators: registry.generators.map((generator) => ({
      id: generator.id,
      ownerPath: generator.ownerPath,
      authorityInputs: [...generator.authorityInputs].toSorted(codePointCompare),
      dependsOn: [...generator.dependsOn].toSorted(codePointCompare),
      outputs: [...generator.outputs].toSorted(codePointCompare),
    })).toSorted((left, right) => codePointCompare(left.id, right.id)),
    applicabilityMatrix,
    adapterCoverage,
    violations: normalizedViolations,
  };
  const lock = deepFreeze({
    ...unsignedLock,
    lockHash: canonicalDomainHash("authority-graph/lock/v1", unsignedLock),
  }) as AuthorityLock;
  return deepFreeze({ ok: normalizedViolations.length === 0, violations: normalizedViolations, lock });
}
