import { deepFreeze, sha256, type DeepReadonly } from "../../../src/kernel/integrity.ts";
import { codePointCompare } from "./shared.ts";

export const AUTHORITY_REGISTRY_SCHEMA_VERSION = "bridlewise-authority-registry/v1" as const;
export const AUTHORITY_LOCK_SCHEMA_VERSION = "bridlewise-authority-lock/v1" as const;
export const AUTHORITY_SOURCE_INVENTORY_SCHEMA_VERSION = "bridlewise-authority-source-inventory/v1" as const;
export const AUTHORITY_SOURCE_INVENTORY_PROVENANCE = "caller-asserted-untrusted/v1" as const;
export const TYPESCRIPT_AUTHORITY_ADAPTER_ID = "babel-typescript-authority/v1" as const;

export const AUTHORITY_UNIVERSE_DIMENSIONS = [
  "realms", "modules", "layers", "languages", "agents", "tools", "providers", "extensions", "tests",
  "artifactKinds", "operations", "lifecycleStages",
] as const;

export type AuthorityUniverseDimension = typeof AUTHORITY_UNIVERSE_DIMENSIONS[number];
export type AuthorityUniverse = Readonly<Record<AuthorityUniverseDimension, readonly string[]>>;
export type AuthorityKind = "literal" | "zod-strict-object";
export type AuthorityExceptionRole = "mutation" | "historical" | "distinct-domain";
export type AuthorityApplicabilityDisposition =
  | "applies"
  | "not-applicable-with-evidence"
  | "unsupported-blocking";

export type AuthoritySource = Readonly<{
  path: string;
  language: string;
  source: string;
  layer?: string;
  realm?: string;
  testId?: string;
}>;

export type AuthoritySourceInventory = DeepReadonly<{
  schemaVersion: typeof AUTHORITY_SOURCE_INVENTORY_SCHEMA_VERSION;
  provenance: typeof AUTHORITY_SOURCE_INVENTORY_PROVENANCE;
  rootIdentity: string;
  entries: Array<{
    path: string;
    language: string;
    layer: string | null;
    realm: string | null;
    testId: string | null;
    sha256: string;
  }>;
}>;

export type AuthorityRoute = Readonly<{
  id: string;
  kind: AuthorityKind;
  owner: Readonly<{ path: string; exportName: string }>;
}>;

export type AuthorityRoleException = Readonly<{
  authorityId: string;
  path: string;
  selector: string;
  sourceSha256: string;
  role: AuthorityExceptionRole;
  rationale: string;
  evidenceLinks: readonly string[];
  distinctAuthorityId?: string;
}>;

export type AuthorityGenerator = Readonly<{
  id: string;
  ownerPath: string;
  authorityInputs: readonly string[];
  dependsOn: readonly string[];
  outputs: readonly string[];
}>;

export type AuthorityApplicabilityCell = Readonly<{
  authorityId: string;
  dimension: AuthorityUniverseDimension;
  member: string;
  disposition: AuthorityApplicabilityDisposition;
  rationale?: string;
  evidenceLinks?: readonly string[];
}>;

export type AuthorityRegistry = Readonly<{
  schemaVersion: typeof AUTHORITY_REGISTRY_SCHEMA_VERSION;
  authorities: readonly AuthorityRoute[];
  roleExceptions: readonly AuthorityRoleException[];
  generators: readonly AuthorityGenerator[];
  adapters: readonly Readonly<{
    language: string;
    adapterId: string;
    status: "qualified" | "unsupported";
  }>[];
  applicability: Readonly<{
    defaultDisposition: "applies";
    declaredUniverse: AuthorityUniverse;
    cells: readonly AuthorityApplicabilityCell[];
  }>;
}>;

export type AuthorityOccurrenceRole =
  | "authority"
  | "reference"
  | "materialization"
  | AuthorityExceptionRole
  | "duplicate";

export type AuthorityOccurrence = Readonly<{
  authorityId: string;
  path: string;
  selector: string;
  occurrenceKind: "literal" | "shape" | "reference";
  role: AuthorityOccurrenceRole;
  semanticFingerprint: string;
}>;

export type AuthorityLock = DeepReadonly<{
  schemaVersion: typeof AUTHORITY_LOCK_SCHEMA_VERSION;
  registryHash: string;
  sourceInventoryHash: string | null;
  sources: Array<{
    path: string;
    language: string;
    layer: string | null;
    realm: string | null;
    testId: string | null;
    sha256: string;
  }>;
  authorities: Array<{
    id: string;
    kind: AuthorityKind;
    owner: { path: string; exportName: string };
    semanticFingerprint: string | null;
  }>;
  occurrences: AuthorityOccurrence[];
  generators: Array<{
    id: string;
    ownerPath: string;
    authorityInputs: string[];
    dependsOn: string[];
    outputs: string[];
  }>;
  applicabilityMatrix: Array<{
    authorityId: string;
    dimension: AuthorityUniverseDimension;
    member: string;
    disposition: AuthorityApplicabilityDisposition;
    rationale: string | null;
    evidenceLinks: string[];
  }>;
  adapterCoverage: Array<{ language: string; adapterId: string | null; status: string }>;
  violations: string[];
  lockHash: string;
}>;

export type AuthorityGraphInput = Readonly<{
  registry: AuthorityRegistry;
  sources: readonly AuthoritySource[];
  discoveredUniverse: AuthorityUniverse;
  sourceInventory: AuthoritySourceInventory;
}>;

export type AuthorityGraphResult = Readonly<{
  ok: boolean;
  violations: readonly string[];
  lock: AuthorityLock;
}>;

export function createAuthoritySourceInventory(
  sources: readonly AuthoritySource[],
  rootIdentity: string,
): AuthoritySourceInventory {
  if (rootIdentity.length === 0) throw new TypeError("rootIdentity must be non-empty");
  const entries = sources.map(authoritySourceInventoryEntry).toSorted((left, right) =>
    codePointCompare(left.path, right.path));
  return deepFreeze({
    schemaVersion: AUTHORITY_SOURCE_INVENTORY_SCHEMA_VERSION,
    provenance: AUTHORITY_SOURCE_INVENTORY_PROVENANCE,
    rootIdentity,
    entries,
  });
}

export function authoritySourceInventoryEntry(
  source: AuthoritySource,
): AuthoritySourceInventory["entries"][number] {
  return {
    path: source.path,
    language: source.language,
    layer: source.layer ?? null,
    realm: source.realm ?? null,
    testId: source.testId ?? null,
    sha256: sha256(source.source),
  };
}
