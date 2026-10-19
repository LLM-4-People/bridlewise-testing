import { sha256 } from "../../../src/kernel/integrity.ts";
import type {
  AuthorityOccurrence,
  AuthorityRegistry,
  AuthorityRoleException,
  AuthoritySource,
} from "./contracts.ts";
import {
  SHA256_PATTERN,
  exactPath,
  nonempty,
  nonemptyEvidenceLinks,
} from "./shared.ts";

export const AUTHORITY_EXCEPTION_SELECTOR_PATTERN =
  /^(?:export|local|literal|type|object|zod):?[^*?\[\]{}\\]*@[0-9]+:[0-9]+$/u;

export type ResolvedSemanticAuthority = Readonly<{
  semanticFingerprint: string;
}>;

export function validateRoleExceptions(
  registry: AuthorityRegistry,
  sources: readonly AuthoritySource[],
  occurrences: readonly AuthorityOccurrence[],
  violations: string[],
): void {
  const sourceHashes = new Map(sources.map((source) => [source.path, sha256(source.source)]));
  const authorityIds = new Set(registry.authorities.map((authority) => authority.id));
  const seen = new Set<string>();
  for (const exception of registry.roleExceptions) {
    const key = exceptionKey(exception.authorityId, exception.path, exception.selector);
    if (seen.has(key)) violations.push(`authority_exception_duplicate:${key}`);
    seen.add(key);
    if (!authorityIds.has(exception.authorityId) || !exactPath(exception.path) ||
      !AUTHORITY_EXCEPTION_SELECTOR_PATTERN.test(exception.selector) ||
      !SHA256_PATTERN.test(exception.sourceSha256) || sourceHashes.get(exception.path) !== exception.sourceSha256 ||
      !nonempty(exception.rationale) || !nonemptyEvidenceLinks(exception.evidenceLinks)) {
      violations.push(`authority_exception_invalid:${key}`);
      continue;
    }
    if (exception.role === "distinct-domain" &&
      (!exception.distinctAuthorityId || exception.distinctAuthorityId === exception.authorityId ||
        !authorityIds.has(exception.distinctAuthorityId))) {
      violations.push(`authority_exception_distinct_domain_invalid:${key}`);
    }
    if (exception.role !== "distinct-domain" && exception.distinctAuthorityId !== undefined) {
      violations.push(`authority_exception_distinct_domain_invalid:${key}`);
    }
    const occurrence = occurrences.find((candidate) => candidate.authorityId === exception.authorityId &&
      candidate.path === exception.path && candidate.selector === exception.selector &&
      candidate.role === exception.role);
    if (!occurrence) {
      const unclassified = occurrences.find((candidate) => candidate.authorityId === exception.authorityId &&
        candidate.path === exception.path && candidate.selector === exception.selector);
      violations.push(`${unclassified ? "authority_exception_role_unproven" : "authority_exception_stale"}:${key}`);
    }
  }
}

export function exceptionRoleProven(
  exception: AuthorityRoleException,
  candidateFingerprint: string,
  resolved: ReadonlyMap<string, ResolvedSemanticAuthority>,
): boolean {
  // Registry v1 cannot bind either an archival evidence-resolution receipt or
  // an executed negative-test receipt. Labels alone cannot prove these roles.
  if (exception.role === "historical" || exception.role === "mutation") return false;
  // Equal fingerprints and symmetric registry claims cannot prove independent
  // semantic domains. Registry v1 has no signed domain-ownership receipt.
  void candidateFingerprint;
  void resolved;
  return false;
}

export function exceptionKey(authorityId: string, path: string, selector: string): string {
  return JSON.stringify([authorityId, path, selector]);
}
