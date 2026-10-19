import { deepFreeze } from "../../../src/kernel/integrity.ts";
import {
  AUTHORITY_UNIVERSE_DIMENSIONS,
  TYPESCRIPT_AUTHORITY_ADAPTER_ID,
  type AuthorityApplicabilityCell,
  type AuthorityLock,
  type AuthorityRegistry,
  type AuthoritySource,
  type AuthorityUniverse,
  type AuthorityUniverseDimension,
} from "./contracts.ts";
import {
  applicabilityKey,
  array,
  codePointCompare,
  compareTuple,
  extraKeys,
  isRecord,
  nonempty,
  nonemptyEvidenceLinks,
  sameOrdered,
} from "./shared.ts";

export function normalizeUniverse(
  value: unknown,
  label: "declared" | "discovered",
  violations: string[],
): AuthorityUniverse {
  if (label === "discovered") violations.push("authority_universe_attestation_untrusted");
  const record = isRecord(value) ? value : {};
  if (!isRecord(value) || extraKeys(record, new Set(AUTHORITY_UNIVERSE_DIMENSIONS)).length > 0) {
    violations.push(`authority_${label}_universe_invalid`);
  }
  const universe = Object.fromEntries(AUTHORITY_UNIVERSE_DIMENSIONS.map((dimension) => {
    const members = record[dimension];
    if (!Array.isArray(members) || !members.every(nonempty)) {
      violations.push(`authority_${label}_universe_invalid:${dimension}`);
      return [dimension, []];
    }
    const strings = members as string[];
    if (new Set(strings).size !== strings.length || !sameOrdered(strings, strings.toSorted(codePointCompare))) {
      violations.push(`authority_${label}_universe_noncanonical:${dimension}`);
    }
    return [dimension, [...new Set(strings)].toSorted(codePointCompare)];
  }));
  return deepFreeze(universe) as unknown as AuthorityUniverse;
}

export function validateDiscoveredSourceCoverage(
  discovered: AuthorityUniverse,
  sources: readonly AuthoritySource[],
  violations: string[],
): void {
  const expected: Partial<Record<AuthorityUniverseDimension, readonly string[]>> = {
    modules: sources.map((source) => source.path).toSorted(codePointCompare),
    languages: [...new Set(sources.map((source) => source.language))].toSorted(codePointCompare),
    layers: [...new Set(sources.flatMap((source) => source.layer ? [source.layer] : []))].toSorted(codePointCompare),
    realms: [...new Set(sources.flatMap((source) => source.realm ? [source.realm] : []))].toSorted(codePointCompare),
    tests: [...new Set(sources.flatMap((source) => source.testId ? [source.testId] : []))].toSorted(codePointCompare),
  };
  for (const [dimension, members] of Object.entries(expected) as Array<
    [AuthorityUniverseDimension, readonly string[]]
  >) {
    for (const member of members.filter((entry) => !discovered[dimension].includes(entry))) {
      violations.push(`authority_discovered_universe_incomplete:${dimension}:${member}`);
    }
    if (dimension === "modules") {
      for (const member of discovered.modules.filter((entry) => !members.includes(entry))) {
        violations.push(`authority_source_set_incomplete:modules:${member}`);
      }
    }
  }
}

export function deriveUniverse(input: AuthorityUniverse, sources: readonly AuthoritySource[]): AuthorityUniverse {
  const result = Object.fromEntries(AUTHORITY_UNIVERSE_DIMENSIONS.map((dimension) => [
    dimension,
    [...new Set(input[dimension] ?? [])],
  ])) as Record<AuthorityUniverseDimension, string[]>;
  result.modules.push(...sources.map((source) => source.path));
  result.languages.push(...sources.map((source) => source.language));
  result.layers.push(...sources.flatMap((source) => source.layer ? [source.layer] : []));
  result.realms.push(...sources.flatMap((source) => source.realm ? [source.realm] : []));
  result.tests.push(...sources.flatMap((source) => source.testId ? [source.testId] : []));
  for (const dimension of AUTHORITY_UNIVERSE_DIMENSIONS) {
    result[dimension] = [...new Set(result[dimension])].toSorted(codePointCompare);
  }
  return deepFreeze(result) as AuthorityUniverse;
}

export function buildApplicabilityMatrix(
  registry: AuthorityRegistry,
  actual: AuthorityUniverse,
  violations: string[],
): AuthorityLock["applicabilityMatrix"] {
  const declared = registry.applicability?.declaredUniverse;
  const cells = array(registry.applicability?.cells);
  const overrides = new Map<string, AuthorityApplicabilityCell>();
  const authorityIds = new Set(registry.authorities.map((authority) => authority.id));
  for (const cell of cells) {
    if (!isRecord(cell) || !AUTHORITY_UNIVERSE_DIMENSIONS.includes(cell.dimension as AuthorityUniverseDimension) ||
      !authorityIds.has(String(cell.authorityId)) || typeof cell.member !== "string" || cell.member.length === 0 ||
      !["applies", "not-applicable-with-evidence", "unsupported-blocking"].includes(String(cell.disposition))) {
      violations.push("authority_applicability_cell_invalid");
      continue;
    }
    const key = applicabilityKey(String(cell.authorityId), cell.dimension as AuthorityUniverseDimension, cell.member);
    if (overrides.has(key)) violations.push(`authority_applicability_cell_duplicate:${key}`);
    overrides.set(key, cell as AuthorityApplicabilityCell);
    if (!actual[cell.dimension as AuthorityUniverseDimension].includes(cell.member)) {
      violations.push(`authority_applicability_false_exception:${cell.authorityId}:${cell.dimension}:${cell.member}`);
    }
    if (cell.disposition === "not-applicable-with-evidence" &&
      (!nonempty(cell.rationale) || !nonemptyEvidenceLinks(cell.evidenceLinks))) {
      violations.push(`authority_applicability_evidence_missing:${cell.authorityId}:${cell.dimension}:${cell.member}`);
    }
    if (cell.disposition === "not-applicable-with-evidence") {
      // Registry v1 has no evidence inventory containing bytes, hashes, and a
      // resolver receipt. A syntactically valid URI is not proof it resolves.
      violations.push(`authority_applicability_evidence_unresolved:${cell.authorityId}:${cell.dimension}:${cell.member}`);
    }
    if (cell.disposition === "unsupported-blocking") {
      violations.push(`authority_applicability_unsupported:${cell.authorityId}:${cell.dimension}:${cell.member}`);
    }
  }
  const matrix: AuthorityLock["applicabilityMatrix"][number][] = [];
  for (const authority of registry.authorities) {
    for (const dimension of AUTHORITY_UNIVERSE_DIMENSIONS) {
      const declaredMembers = declared?.[dimension] ?? [];
      const actualMembers = actual[dimension];
      if (actualMembers.length === 0) violations.push(`authority_applicability_empty_dimension:${authority.id}:${dimension}`);
      for (const member of actualMembers) {
        if (!declaredMembers.includes(member)) {
          violations.push(`authority_applicability_missing_cell:${authority.id}:${dimension}:${member}`);
        }
        const override = overrides.get(applicabilityKey(authority.id, dimension, member));
        matrix.push({
          authorityId: authority.id,
          dimension,
          member,
          disposition: override?.disposition ?? "applies",
          rationale: override?.rationale ?? null,
          evidenceLinks: [...(override?.evidenceLinks ?? [])].toSorted(codePointCompare),
        });
      }
      for (const member of declaredMembers) {
        if (!actualMembers.includes(member)) {
          violations.push(`authority_applicability_stale_cell:${authority.id}:${dimension}:${member}`);
        }
      }
      if (new Set(declaredMembers).size !== declaredMembers.length) {
        violations.push(`authority_applicability_declared_duplicate:${dimension}`);
      }
    }
  }
  return deepFreeze(matrix.toSorted((left, right) =>
    compareTuple([left.authorityId, left.dimension, left.member], [right.authorityId, right.dimension, right.member])
  ));
}

export function validateAdapters(
  registry: AuthorityRegistry,
  universe: AuthorityUniverse,
  violations: string[],
): AuthorityLock["adapterCoverage"] {
  const adapters = new Map<string, AuthorityRegistry["adapters"][number]>();
  for (const adapter of array(registry.adapters)) {
    if (!isRecord(adapter) || !nonempty(adapter.language) || !nonempty(adapter.adapterId) ||
      !["qualified", "unsupported"].includes(String(adapter.status))) {
      violations.push("authority_adapter_invalid");
      continue;
    }
    if (adapters.has(adapter.language)) violations.push(`authority_adapter_duplicate:${adapter.language}`);
    adapters.set(adapter.language, adapter as AuthorityRegistry["adapters"][number]);
  }
  return deepFreeze(universe.languages.map((language) => {
    const adapter = adapters.get(language);
    if (!adapter) violations.push(`authority_adapter_missing:${language}`);
    else if (adapter.status !== "qualified") violations.push(`authority_adapter_unsupported:${language}`);
    else if (language !== "typescript") violations.push(`authority_adapter_not_implemented:${language}`);
    else if (adapter.adapterId !== TYPESCRIPT_AUTHORITY_ADAPTER_ID) {
      violations.push(`authority_adapter_identity_invalid:${language}:${adapter.adapterId}`);
    }
    if (language === "typescript" && adapter?.status === "qualified") {
      violations.push(`authority_adapter_qualification_untrusted:${language}`);
    }
    return {
      language,
      adapterId: adapter?.adapterId ?? null,
      status: adapter?.status ?? "missing",
    };
  }));
}
