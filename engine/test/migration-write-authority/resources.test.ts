import assert from "node:assert/strict";
import test from "node:test";

import { sha256 } from "../../src/kernel/integrity.ts";
import {
  compileMigrationResourceSet,
  migrationResourcesConflict,
  validateMigrationResource,
} from "../../verification/core/coordination/migration-write-authority/resources.ts";
import type {
  MigrationResource,
  MigrationResourceRegistry,
} from "../../verification/core/coordination/migration-write-authority/contracts.ts";

/** Assert that `fn` throws with the expected `code` (InputError code field). */
function expectCode(fn: () => void, code: string): void {
  try {
    fn();
    assert.fail(`expected ${code} to be thrown`);
  } catch (e) {
    assert.ok(e instanceof Error, "threw an Error");
    assert.equal((e as { code?: string }).code, code, `expected code ${code}`);
  }
}

const REGISTRY_ID = sha256("registry-v1");
const NORMALIZER_ID = sha256("normalizer-v1");

const REGISTRY: MigrationResourceRegistry = Object.freeze({
  registryIdentity: REGISTRY_ID,
  normalizerIdentity: NORMALIZER_ID,
});

function physical(resourceId: string, access: "read" | "write", path: string, collisionKey: string = path): MigrationResource {
  return Object.freeze({
    kind: "physical-path",
    resourceId,
    access,
    resolution: "resolved",
    registryIdentity: REGISTRY_ID,
    normalizerIdentity: NORMALIZER_ID,
    aliasClosure: [resourceId],
    path,
    portableCollisionKey: collisionKey,
    observedState: Object.freeze({ kind: "absent", parentIdentity: dirIdentity(), entryName: "x" }),
  });
}

function physicalWithInode(resourceId: string, access: "read" | "write", path: string, device: string, inode: string): MigrationResource {
  return Object.freeze({
    kind: "physical-path",
    resourceId,
    access,
    resolution: "resolved",
    registryIdentity: REGISTRY_ID,
    normalizerIdentity: NORMALIZER_ID,
    aliasClosure: [resourceId],
    path,
    portableCollisionKey: path,
    observedState: Object.freeze({
      kind: "file",
      identity: Object.freeze({ device, inode, mode: 0o100600, ownerUid: "0", ownerGid: "0", links: "1", kind: "file" }),
      byteLength: 0,
      sha256: "0".repeat(64),
    }),
  });
}

function semantic(resourceId: string, access: "read" | "write", ownerId: string, ancestors: readonly string[] = []): MigrationResource {
  return Object.freeze({
    kind: "semantic-owner",
    resourceId,
    access,
    resolution: "resolved",
    registryIdentity: REGISTRY_ID,
    normalizerIdentity: NORMALIZER_ID,
    aliasClosure: [resourceId],
    ownerKind: "module",
    ownerId,
    ancestorOwnerIds: Object.freeze([...ancestors]),
  });
}

function generated(resourceId: string, access: "read" | "write", generatorId: string, outputPath: string, authorityKey: string): MigrationResource {
  return Object.freeze({
    kind: "generated-output",
    resourceId,
    access,
    resolution: "resolved",
    registryIdentity: REGISTRY_ID,
    normalizerIdentity: NORMALIZER_ID,
    aliasClosure: [resourceId],
    generatorId,
    outputPath,
    authorityKey,
  });
}

function gitRef(resourceId: string, access: "read" | "write", refName: string, refFamilyId: string): MigrationResource {
  return Object.freeze({
    kind: "git-ref",
    resourceId,
    access,
    resolution: "resolved",
    registryIdentity: REGISTRY_ID,
    normalizerIdentity: NORMALIZER_ID,
    aliasClosure: [resourceId],
    refName,
    refFamilyId,
    expectedOld: null,
    intendedObjectKind: "commit",
  });
}

function packageSurface(resourceId: string, access: "read" | "write", surfaceKind: "export" | "script" | "compiler" | "dependency" | "executable-registry", surfaceId: string): MigrationResource {
  return Object.freeze({
    kind: "package-surface",
    resourceId,
    access,
    resolution: "resolved",
    registryIdentity: REGISTRY_ID,
    normalizerIdentity: NORMALIZER_ID,
    aliasClosure: [resourceId],
    surfaceKind,
    surfaceId,
  });
}

function dirIdentity() {
  return Object.freeze({ device: "1", inode: "1", mode: 0o40755, ownerUid: "0", ownerGid: "0", links: "2", kind: "directory" });
}

// ---------------------------------------------------------------------------
// Read/read coexist; write conflicts
// ---------------------------------------------------------------------------

test("resources: read/read coexist for every kind", () => {
  assert.equal(migrationResourcesConflict(physical("a", "read", "src/a"), physical("b", "read", "src/a")), "disjoint");
  assert.equal(migrationResourcesConflict(semantic("a", "read", "mod"), semantic("b", "read", "mod")), "disjoint");
  assert.equal(migrationResourcesConflict(generated("a", "read", "g", "o", "k"), generated("b", "read", "g", "o", "k")), "disjoint");
  assert.equal(migrationResourcesConflict(gitRef("a", "read", "refs/heads/main", "fam-main"), gitRef("b", "read", "refs/heads/main", "fam-main")), "disjoint");
  assert.equal(migrationResourcesConflict(packageSurface("a", "read", "export", "exp-1"), packageSurface("b", "read", "export", "exp-1")), "disjoint");
});

test("resources: write/write conflict for every kind", () => {
  assert.equal(migrationResourcesConflict(physical("a", "write", "src/a"), physical("b", "write", "src/a")), "conflict");
  assert.equal(migrationResourcesConflict(semantic("a", "write", "mod"), semantic("b", "write", "mod")), "conflict");
  assert.equal(migrationResourcesConflict(generated("a", "write", "g", "o", "k"), generated("b", "write", "g", "o", "k")), "conflict");
  assert.equal(migrationResourcesConflict(gitRef("a", "write", "refs/heads/main", "fam-main"), gitRef("b", "write", "refs/heads/main", "fam-main")), "conflict");
  assert.equal(migrationResourcesConflict(packageSurface("a", "write", "export", "exp-1"), packageSurface("b", "write", "export", "exp-1")), "conflict");
});

test("resources: read/write conflict (write overlaps a read)", () => {
  assert.equal(migrationResourcesConflict(physical("a", "read", "src/a"), physical("b", "write", "src/a")), "conflict");
  assert.equal(migrationResourcesConflict(semantic("a", "read", "mod"), semantic("b", "write", "mod")), "conflict");
  assert.equal(migrationResourcesConflict(generated("a", "read", "g", "o", "k"), generated("b", "write", "g", "o", "k")), "conflict");
  assert.equal(migrationResourcesConflict(gitRef("a", "read", "refs/heads/main", "fam"), gitRef("b", "write", "refs/heads/main", "fam")), "conflict");
  assert.equal(migrationResourcesConflict(packageSurface("a", "read", "export", "e"), packageSurface("b", "write", "export", "e")), "conflict");
});

test("resources: different kinds are disjoint", () => {
  assert.equal(migrationResourcesConflict(physical("a", "write", "src/a"), semantic("b", "write", "src/a")), "disjoint");
  assert.equal(migrationResourcesConflict(generated("a", "write", "g", "o", "k"), gitRef("b", "write", "refs/heads/main", "f")), "disjoint");
  assert.equal(migrationResourcesConflict(packageSurface("a", "write", "export", "e"), physical("b", "write", "p")), "disjoint");
});

// ---------------------------------------------------------------------------
// Physical: ancestor/descendant, rename overlap, case/Unicode, inode alias
// ---------------------------------------------------------------------------

test("resources: physical ancestor/descendant overlap conflicts on writes", () => {
  assert.equal(migrationResourcesConflict(physical("dir", "write", "src/foo"), physical("child", "write", "src/foo/bar.ts")), "conflict");
  assert.equal(migrationResourcesConflict(physical("child", "write", "src/foo/bar.ts"), physical("dir", "write", "src/foo")), "conflict");
  // read/write ancestor still conflicts (writing a dir while reading a child)
  assert.equal(migrationResourcesConflict(physical("dir", "write", "src/foo"), physical("child", "read", "src/foo/bar.ts")), "conflict");
  // disjoint sibling paths
  assert.equal(migrationResourcesConflict(physical("a", "write", "src/a"), physical("b", "write", "src/b")), "disjoint");
  // a string-prefix that is NOT a directory boundary is disjoint
  assert.equal(migrationResourcesConflict(physical("a", "write", "src/foo"), physical("b", "write", "src/foobar")), "disjoint");
});

test("resources: physical case/Unicode collision via portableCollisionKey conflicts", () => {
  // Two resources with different raw paths but the same normalized collision key.
  const lower = physical("a", "write", "src/Foo.ts", "src/foo.ts");
  const upper = physical("b", "write", "src/fOO.ts", "src/foo.ts");
  assert.equal(migrationResourcesConflict(lower, upper), "conflict");
});

test("resources: physical source/destination rename overlap conflicts", () => {
  // Move from A to B: B's path equals A's collision key (rename overlap).
  const src = physical("a", "write", "src/old.ts", "src/old.ts");
  const dst = physical("b", "write", "src/old.ts", "src/new.ts");
  // dst.path === src.portableCollisionKey → rename overlap.
  assert.equal(migrationResourcesConflict(src, dst), "conflict");
});

test("resources: physical inode/hardlink alias conflicts", () => {
  const a = physicalWithInode("a", "write", "src/a.ts", "10", "999");
  const b = physicalWithInode("b", "write", "src/b.ts", "10", "999");
  assert.equal(migrationResourcesConflict(a, b), "conflict");
  // different inode → disjoint
  const c = physicalWithInode("c", "write", "src/c.ts", "10", "1000");
  assert.equal(migrationResourcesConflict(a, c), "disjoint");
});

// ---------------------------------------------------------------------------
// Semantic: hierarchy edges (ancestorOwnerIds), NOT substring
// ---------------------------------------------------------------------------

test("resources: semantic conflict uses registered ancestor edges, not substring", () => {
  // ancestor edge: mod-foo is an ancestor of mod-foo-bar
  const parent = semantic("a", "write", "mod-foo", ["mod-root"]);
  const child = semantic("b", "write", "mod-foo-bar", ["mod-foo", "mod-root"]);
  assert.equal(migrationResourcesConflict(parent, child), "conflict");
  // substring but no registered edge → disjoint (NOT substring matching)
  const s1 = semantic("a", "write", "mod-foo");
  const s2 = semantic("b", "write", "mod-foo-bar");
  assert.equal(migrationResourcesConflict(s1, s2), "disjoint");
});

// ---------------------------------------------------------------------------
// Generated: same generator+outputPath or same authority key
// ---------------------------------------------------------------------------

test("resources: generated conflicts on generator+outputPath or authorityKey", () => {
  assert.equal(migrationResourcesConflict(
    generated("a", "write", "gen-1", "out/schema.json", "key-1"),
    generated("b", "write", "gen-1", "out/schema.json", "key-2"),
  ), "conflict");
  assert.equal(migrationResourcesConflict(
    generated("a", "write", "gen-1", "out/a.json", "key-1"),
    generated("b", "write", "gen-1", "out/b.json", "key-1"),
  ), "conflict");
  // different generator → disjoint
  assert.equal(migrationResourcesConflict(
    generated("a", "write", "gen-1", "out/a.json", "key-1"),
    generated("b", "write", "gen-2", "out/a.json", "key-1"),
  ), "disjoint");
});

// ---------------------------------------------------------------------------
// Git-ref: exact ref or registered ref-family
// ---------------------------------------------------------------------------

test("resources: git-ref conflicts on exact ref or ref-family", () => {
  assert.equal(migrationResourcesConflict(
    gitRef("a", "write", "refs/heads/main", "fam-main"),
    gitRef("b", "write", "refs/heads/main", "fam-other"),
  ), "conflict");
  assert.equal(migrationResourcesConflict(
    gitRef("a", "write", "refs/heads/main", "fam-main"),
    gitRef("b", "write", "refs/heads/release", "fam-main"),
  ), "conflict");
  // different ref AND different family → disjoint
  assert.equal(migrationResourcesConflict(
    gitRef("a", "write", "refs/heads/main", "fam-main"),
    gitRef("b", "write", "refs/heads/release", "fam-release"),
  ), "disjoint");
});

// ---------------------------------------------------------------------------
// Package-surface: same surfaceKind + surfaceId
// ---------------------------------------------------------------------------

test("resources: package-surface conflicts on kind+id, not id alone", () => {
  assert.equal(migrationResourcesConflict(
    packageSurface("a", "write", "export", "exp-1"),
    packageSurface("b", "write", "export", "exp-1"),
  ), "conflict");
  // same surfaceId, different surfaceKind → disjoint (different surfaces)
  assert.equal(migrationResourcesConflict(
    packageSurface("a", "write", "export", "shared-1"),
    packageSurface("b", "write", "script", "shared-1"),
  ), "disjoint");
});

// ---------------------------------------------------------------------------
// Fail closed: unknown/unregistered/unnormalizable
// ---------------------------------------------------------------------------

test("resources: validateMigrationResource fails closed on unresolved resource", () => {
  const bad = { ...physical("a", "write", "src/a"), resolution: "pending" } as unknown as MigrationResource;
  expectCode(() => validateMigrationResource(bad), "resource-unresolved");
  // invalid resourceId (uppercase)
  const badId = { ...physical("A", "write", "src/a") } as unknown as MigrationResource;
  expectCode(() => validateMigrationResource(badId), "resource-unresolved");
  // invalid access
  const badAccess = { ...physical("a", "read-write" as "read", "src/a") } as unknown as MigrationResource;
  expectCode(() => validateMigrationResource(badAccess), "resource-unresolved");
  // empty aliasClosure
  const badAlias = { ...physical("a", "write", "src/a"), aliasClosure: [] } as unknown as MigrationResource;
  expectCode(() => validateMigrationResource(badAlias), "resource-unresolved");
  // too many aliases
  const manyAlias = { ...physical("a", "write", "src/a"), aliasClosure: Array.from({ length: 257 }, (_, i) => `a${i}`) } as unknown as MigrationResource;
  expectCode(() => validateMigrationResource(manyAlias), "resource-unresolved");
  // invalid git refName
  const badRef = { ...gitRef("a", "write", "not-a-ref", "fam") } as unknown as MigrationResource;
  expectCode(() => validateMigrationResource(badRef), "resource-unresolved");
});

test("resources: compileMigrationResourceSet fails closed on registry mismatch", () => {
  const wrongRegistry: MigrationResourceRegistry = Object.freeze({ registryIdentity: sha256("other"), normalizerIdentity: NORMALIZER_ID });
  expectCode(
    () => compileMigrationResourceSet({ registry: wrongRegistry, resources: [physical("a", "write", "src/a")] }),
    "resource-unresolved",
  );
});

test("resources: compileMigrationResourceSet rejects an internally conflicting set", () => {
  expectCode(
    () => compileMigrationResourceSet({
      registry: REGISTRY,
      resources: [physical("a", "write", "src/x"), physical("b", "write", "src/x")],
    }),
    "resource-conflict",
  );
});

test("resources: compileMigrationResourceSet accepts a disjoint set and computes a setIdentity", () => {
  const set = compileMigrationResourceSet({
    registry: REGISTRY,
    resources: [
      physical("a", "write", "src/a"),
      physical("b", "read", "src/b"),
      semantic("c", "write", "mod-x", ["mod-root"]),
    ],
  });
  assert.equal(set.resources.length, 3);
  assert.equal(set.registryIdentity, REGISTRY_ID);
  assert.equal(set.normalizerIdentity, NORMALIZER_ID);
  assert.ok(set.setIdentity.length === 64, "setIdentity is a sha256 hex");
  // resources are ordered by resourceId
  assert.deepEqual(set.resources.map((r) => r.resourceId), ["a", "b", "c"]);
  // setIdentity is deterministic for the same input
  const set2 = compileMigrationResourceSet({
    registry: REGISTRY,
    resources: [
      physical("b", "read", "src/b"),
      physical("a", "write", "src/a"),
      semantic("c", "write", "mod-x", ["mod-root"]),
    ],
  });
  assert.equal(set2.setIdentity, set.setIdentity);
});

test("resources: compileMigrationResourceSet rejects duplicate resourceIds", () => {
  expectCode(
    () => compileMigrationResourceSet({
      registry: REGISTRY,
      resources: [physical("a", "write", "src/a"), physical("a", "read", "src/a")],
    }),
    "resource-unresolved",
  );
});
