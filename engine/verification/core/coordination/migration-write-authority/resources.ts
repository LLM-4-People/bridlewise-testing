/**
 * MigrationWriteAuthority — pure resource compiler + conflict detector.
 *
 * `compileMigrationResourceSet` validates registered lexical + semantic
 * authorities against a registry and produces the closed resource set.
 * `migrationResourcesConflict` returns `"conflict" | "disjoint"` for all five
 * closed resource kinds. Both functions are pure (no I/O) and independently
 * testable.
 *
 * Design authority: MWA-DESIGN §4.7 and the qualification spec §"Resource and
 * conflict model". Semantic/generated/package conflicts use registered
 * hierarchy/ownership edges (`ancestorOwnerIds`), NOT substring matching.
 * Read/read coexist; any overlap with write conflicts. Unknown, unregistered,
 * or unnormalizable resources fail closed with `resource-unresolved`.
 */

import { canonicalHash, deepFreeze, SHA256_HEX_REGEX } from "../../../../src/kernel/integrity.ts";
import { InputError } from "../../../../src/kernel/errors.ts";
import {
  isMigrationResourceKind,
  type BackendError,
  type MigrationResource,
  type MigrationResourceRegistry,
  type Sha256,
  type StableId,
} from "./contracts.ts";

// ---------------------------------------------------------------------------
// Validation constants
// ---------------------------------------------------------------------------

export const MWA_RESOURCE_ID_PATTERN = /^[a-z][a-z0-9._/-]{0,127}$/u;
export const MWA_ALIAS_CLOSURE_MIN = 1;
export const MWA_ALIAS_CLOSURE_MAX = 256;

function isSha256(value: unknown): value is Sha256 {
  return typeof value === "string" && SHA256_HEX_REGEX.test(value);
}

function isStableId(value: unknown): value is StableId {
  return typeof value === "string" && MWA_RESOURCE_ID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Resource set
// ---------------------------------------------------------------------------

export type MigrationResourceSet = Readonly<{
  registryIdentity: Sha256;
  normalizerIdentity: Sha256;
  resources: readonly MigrationResource[];
  /** Canonical hash of the ordered resource set — the `resourceRegistryIdentity`. */
  setIdentity: Sha256;
}>;

// ---------------------------------------------------------------------------
// Resource validation
// ---------------------------------------------------------------------------

/**
 * Validates a single resource against the closed shape. Throws `InputError`
 * with code `resource-unresolved` when the resource is unknown, unregistered,
 * or unnormalizable. Returns the resource unchanged on success.
 */
export function validateMigrationResource(resource: MigrationResource): MigrationResource {
  if (resource === null || typeof resource !== "object") {
    throw resourceUnresolved("resource is not an object");
  }
  if (resource.resolution !== "resolved") {
    throw resourceUnresolved(`resource ${String(resource.resourceId)} is not resolved`);
  }
  if (!isStableId(resource.resourceId)) {
    throw resourceUnresolved("resourceId is not a stable id");
  }
  if (resource.access !== "read" && resource.access !== "write") {
    throw resourceUnresolved(`resource ${resource.resourceId} has invalid access`);
  }
  if (!isSha256(resource.registryIdentity)) {
    throw resourceUnresolved(`resource ${resource.resourceId} has invalid registryIdentity`);
  }
  if (!isSha256(resource.normalizerIdentity)) {
    throw resourceUnresolved(`resource ${resource.resourceId} has invalid normalizerIdentity`);
  }
  if (!Array.isArray(resource.aliasClosure) || resource.aliasClosure.length < MWA_ALIAS_CLOSURE_MIN || resource.aliasClosure.length > MWA_ALIAS_CLOSURE_MAX) {
    throw resourceUnresolved(`resource ${resource.resourceId} has invalid aliasClosure length`);
  }
  for (const alias of resource.aliasClosure) {
    if (!isStableId(alias)) {
      throw resourceUnresolved(`resource ${resource.resourceId} has invalid aliasClosure entry`);
    }
  }
  if (!areUnique(resource.aliasClosure)) {
    throw resourceUnresolved(`resource ${resource.resourceId} has duplicate aliasClosure entries`);
  }
  validateKindSpecific(resource);
  return resource;
}

function validateKindSpecific(resource: MigrationResource): void {
  switch (resource.kind) {
    case "physical-path":
      if (typeof resource.path !== "string" || resource.path.length === 0 || resource.path.startsWith("/") || resource.path.includes("/..")) {
        throw resourceUnresolved(`physical-path ${resource.resourceId} has invalid path`);
      }
      if (typeof resource.portableCollisionKey !== "string" || resource.portableCollisionKey.length === 0) {
        throw resourceUnresolved(`physical-path ${resource.resourceId} has invalid portableCollisionKey`);
      }
      validateTargetState(resource.observedState);
      return;
    case "semantic-owner":
      if (!isStableId(resource.ownerId)) {
        throw resourceUnresolved(`semantic-owner ${resource.resourceId} has invalid ownerId`);
      }
      if (!Array.isArray(resource.ancestorOwnerIds)) {
        throw resourceUnresolved(`semantic-owner ${resource.resourceId} has invalid ancestorOwnerIds`);
      }
      for (const ancestor of resource.ancestorOwnerIds) {
        if (!isStableId(ancestor)) {
          throw resourceUnresolved(`semantic-owner ${resource.resourceId} has invalid ancestorOwnerId`);
        }
      }
      if (!areUnique(resource.ancestorOwnerIds)) {
        throw resourceUnresolved(`semantic-owner ${resource.resourceId} has duplicate ancestorOwnerIds`);
      }
      return;
    case "generated-output":
      if (!isStableId(resource.generatorId)) {
        throw resourceUnresolved(`generated-output ${resource.resourceId} has invalid generatorId`);
      }
      if (typeof resource.outputPath !== "string" || resource.outputPath.length === 0) {
        throw resourceUnresolved(`generated-output ${resource.resourceId} has invalid outputPath`);
      }
      if (!isStableId(resource.authorityKey)) {
        throw resourceUnresolved(`generated-output ${resource.resourceId} has invalid authorityKey`);
      }
      return;
    case "git-ref":
      if (typeof resource.refName !== "string" || !/^refs\/(?:heads|tags|bridlewise)\/[A-Za-z0-9._/-]+$/u.test(resource.refName)) {
        throw resourceUnresolved(`git-ref ${resource.resourceId} has invalid refName`);
      }
      if (!isStableId(resource.refFamilyId)) {
        throw resourceUnresolved(`git-ref ${resource.resourceId} has invalid refFamilyId`);
      }
      if (resource.intendedObjectKind !== "commit" && resource.intendedObjectKind !== "tag") {
        throw resourceUnresolved(`git-ref ${resource.resourceId} has invalid intendedObjectKind`);
      }
      return;
    case "package-surface":
      if (
        resource.surfaceKind !== "export" && resource.surfaceKind !== "script" && resource.surfaceKind !== "compiler"
        && resource.surfaceKind !== "dependency" && resource.surfaceKind !== "executable-registry"
      ) {
        throw resourceUnresolved(`package-surface ${resource.resourceId} has invalid surfaceKind`);
      }
      if (!isStableId(resource.surfaceId)) {
        throw resourceUnresolved(`package-surface ${resource.resourceId} has invalid surfaceId`);
      }
      return;
    default:
      throw resourceUnresolved(`unknown resource kind`);
  }
}

function validateTargetState(state: unknown): void {
  if (state === null || typeof state !== "object") {
    throw resourceUnresolved("observedState is invalid");
  }
  const s = state as Record<string, unknown>;
  if (s.kind === "absent") {
    if (typeof s.entryName !== "string") throw resourceUnresolved("absent state has invalid entryName");
    return;
  }
  if (s.kind === "file") {
    if (typeof s.byteLength !== "number" || !isSha256(s.sha256)) throw resourceUnresolved("file state is invalid");
    return;
  }
  if (s.kind === "directory") {
    if (!isSha256(s.entrySetIdentity)) throw resourceUnresolved("directory state is invalid");
    return;
  }
  throw resourceUnresolved("observedState has invalid kind");
}

function areUnique(values: readonly string[]): boolean {
  const seen = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) return false;
    seen.add(v);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Resource set compiler
// ---------------------------------------------------------------------------

/**
 * Validates every resource against the closed shape and the registry, then
 * checks the set for internal conflicts. Returns the frozen
 * `MigrationResourceSet` whose `setIdentity` is the canonical hash of the
 * ordered resources. Throws `InputError` (`resource-unresolved`) for
 * unknown/unregistered/unnormalizable resources, and `InputError`
 * (`resource-conflict`) for an internally conflicting set.
 */
export function compileMigrationResourceSet(input: Readonly<{
  registry: MigrationResourceRegistry;
  resources: readonly MigrationResource[];
}>): MigrationResourceSet {
  if (input.registry === null || typeof input.registry !== "object") {
    throw resourceUnresolved("registry is invalid");
  }
  if (!isSha256(input.registry.registryIdentity)) {
    throw resourceUnresolved("registry has invalid registryIdentity");
  }
  if (!isSha256(input.registry.normalizerIdentity)) {
    throw resourceUnresolved("registry has invalid normalizerIdentity");
  }
  if (input.resources.length === 0) {
    throw resourceUnresolved("resource set is empty");
  }
  const validated: MigrationResource[] = [];
  const seenIds = new Set<string>();
  for (const resource of input.resources) {
    const checked = validateMigrationResource(resource);
    if (checked.registryIdentity !== input.registry.registryIdentity) {
      throw resourceUnresolved(`resource ${checked.resourceId} registryIdentity does not match registry`);
    }
    if (checked.normalizerIdentity !== input.registry.normalizerIdentity) {
      throw resourceUnresolved(`resource ${checked.resourceId} normalizerIdentity does not match registry`);
    }
    if (!isMigrationResourceKind(checked.kind)) {
      throw resourceUnresolved(`resource ${checked.resourceId} has unknown kind`);
    }
    if (seenIds.has(checked.resourceId)) {
      throw resourceUnresolved(`duplicate resourceId ${checked.resourceId}`);
    }
    seenIds.add(checked.resourceId);
    validated.push(checked);
  }
  // Internal conflict check: no two write/overlap resources in the same set.
  for (let i = 0; i < validated.length; i += 1) {
    for (let j = i + 1; j < validated.length; j += 1) {
      if (migrationResourcesConflict(validated[i]!, validated[j]!) === "conflict") {
        throw resourceConflict(
          `internal resource conflict between ${validated[i]!.resourceId} and ${validated[j]!.resourceId}`,
        );
      }
    }
  }
  const ordered = validated.toSorted((a, b) => a.resourceId.localeCompare(b.resourceId));
  const setIdentity = canonicalHash(ordered.map((r) => ({
    resourceId: r.resourceId,
    kind: r.kind,
    access: r.access,
  })));
  return deepFreeze({
    registryIdentity: input.registry.registryIdentity,
    normalizerIdentity: input.registry.normalizerIdentity,
    resources: Object.freeze(ordered) as readonly MigrationResource[],
    setIdentity,
  });
}

// ---------------------------------------------------------------------------
// Conflict detector
// ---------------------------------------------------------------------------

/**
 * Returns `"conflict"` when two resources cannot coexist under one authority
 * (any overlap with a write), and `"disjoint"` when they can. Read/read always
 * coexist. Semantic/generated/package conflicts use registered hierarchy/
 * ownership edges, not substring matching. Git refs conflict on exact ref or
 * registered ref-family. Physical conflicts include equality, ancestor/
 * descendant overlap, source/destination rename overlap, inode/hardlink alias,
 * and portable case/Unicode-normalization collision (via `portableCollisionKey`).
 */
export function migrationResourcesConflict(a: MigrationResource, b: MigrationResource): "conflict" | "disjoint" {
  if (a.kind !== b.kind) return "disjoint";
  // Read/read coexist.
  if (a.access === "read" && b.access === "read") return "disjoint";
  const overlap = kindSpecificOverlap(a, b);
  return overlap ? "conflict" : "disjoint";
}

function kindSpecificOverlap(a: MigrationResource, b: MigrationResource): boolean {
  switch (a.kind) {
    case "physical-path":
      return physicalPathOverlap(a as PhysicalLike, b as PhysicalLike);
    case "semantic-owner":
      return semanticOwnerOverlap(a as SemanticLike, b as SemanticLike);
    case "generated-output":
      return generatedOutputOverlap(a as GeneratedLike, b as GeneratedLike);
    case "git-ref":
      return gitRefOverlap(a as GitRefLike, b as GitRefLike);
    case "package-surface":
      return packageSurfaceOverlap(a as PackageLike, b as PackageLike);
    default:
      return false;
  }
}

// Structural locals so the narrowing is local and cheap.
type PhysicalLike = Readonly<{
  kind: "physical-path";
  path: string;
  portableCollisionKey: string;
  observedState: Readonly<{ kind: string; identity?: { device: string; inode: string } }>;
}>;
type SemanticLike = Readonly<{ kind: "semantic-owner"; ownerId: string; ancestorOwnerIds: readonly string[] }>;
type GeneratedLike = Readonly<{ kind: "generated-output"; generatorId: string; outputPath: string; authorityKey: string }>;
type GitRefLike = Readonly<{ kind: "git-ref"; refName: string; refFamilyId: string }>;
type PackageLike = Readonly<{ kind: "package-surface"; surfaceKind: string; surfaceId: string }>;

function physicalPathOverlap(a: PhysicalLike, b: PhysicalLike): boolean {
  // Equality (catches case/Unicode via portableCollisionKey) — same key.
  if (a.portableCollisionKey === b.portableCollisionKey) return true;
  // Ancestor/descendant directory overlap: writing a directory and a descendant.
  if (isAncestorPath(a.path, b.path) || isAncestorPath(b.path, a.path)) return true;
  // Source/destination rename overlap: the same physical path appears as both
  // a source and a destination across two reservations. We detect this when one
  // resource's path equals the other's portableCollisionKey-derived destination;
  // the portableCollisionKey already encodes the normalized final path, so
  // equality of collisionKey is covered above. For cross-direction rename, we
  // additionally compare the raw path against the collision key when they
  // diverge (a move from A to B where B's path == A's collisionKey).
  if (a.path === b.portableCollisionKey || b.path === a.portableCollisionKey) return true;
  // Inode/hardlink alias: same device+inode on two file states.
  const ai = fileInode(a.observedState);
  const bi = fileInode(b.observedState);
  if (ai !== null && bi !== null && ai.device === bi.device && ai.inode === bi.inode) return true;
  return false;
}

function fileInode(state: PhysicalLike["observedState"]): { device: string; inode: string } | null {
  if (state.kind === "file" && state.identity !== undefined) {
    return { device: state.identity.device, inode: state.identity.inode };
  }
  return null;
}

/** True when `prefix` is a directory ancestor of `path` (segment-wise). */
function isAncestorPath(prefix: string, path: string): boolean {
  if (prefix === path) return false;
  if (!path.startsWith(prefix + "/")) return false;
  // Exclude the case where prefix is a file (no trailing slash) that happens
  // to be a string prefix: a file cannot contain a child. We approximate by
  // treating the prefix as a directory ancestor; the registry's normalizer
  // already classified the observed state. A more precise check would inspect
  // the observedState kind, but the portableCollisionKey equality case above
  // already handles same-path collisions.
  return true;
}

function semanticOwnerOverlap(a: SemanticLike, b: SemanticLike): boolean {
  // Same owner — conflict (registered hierarchy edge, not substring).
  if (a.ownerId === b.ownerId) return true;
  // Registered ancestor edge: one owner is the other's registered ancestor.
  if (a.ancestorOwnerIds.includes(b.ownerId)) return true;
  if (b.ancestorOwnerIds.includes(a.ownerId)) return true;
  return false;
}

function generatedOutputOverlap(a: GeneratedLike, b: GeneratedLike): boolean {
  // Same generator + outputPath — conflict (same generated destination).
  if (a.generatorId === b.generatorId && a.outputPath === b.outputPath) return true;
  // Same authority key under the same generator — conflict (same authority slot).
  if (a.generatorId === b.generatorId && a.authorityKey === b.authorityKey) return true;
  return false;
}

function gitRefOverlap(a: GitRefLike, b: GitRefLike): boolean {
  // Exact ref name — conflict.
  if (a.refName === b.refName) return true;
  // Registered ref-family operation — conflict (same family).
  if (a.refFamilyId === b.refFamilyId) return true;
  return false;
}

function packageSurfaceOverlap(a: PackageLike, b: PackageLike): boolean {
  // Same surface kind + surface id — conflict.
  if (a.surfaceKind === b.surfaceKind && a.surfaceId === b.surfaceId) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Access helpers
// ---------------------------------------------------------------------------

export function isWriteResource(resource: MigrationResource): resource is MigrationResource & { access: "write" } {
  return resource.access === "write";
}

export function isReadResource(resource: MigrationResource): resource is MigrationResource & { access: "read" } {
  return resource.access === "read";
}

// ---------------------------------------------------------------------------
// Error constructors (typed `BackendError`-shaped throws)
// ---------------------------------------------------------------------------

export function resourceUnresolved(message: string): InputError {
  return new InputError(message, "resource-unresolved");
}

export function resourceConflict(message: string): InputError {
  return new InputError(message, "resource-conflict");
}

/** Shape a backend error from a thrown `InputError` code, or default to `resource-unresolved`. */
export function toBackendError(error: unknown): BackendError {
  if (error instanceof InputError) {
    return deepFreeze({ code: error.code as BackendError["code"], message: error.message });
  }
  const message = error instanceof Error ? error.message : String(error);
  return deepFreeze({ code: "resource-unresolved", message });
}
