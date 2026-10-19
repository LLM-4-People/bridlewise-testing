import assert from "node:assert/strict";
import test from "node:test";

import {
  EXTENSION_MANIFEST_SCHEMA_VERSION,
  EXTENSION_TYPES,
  EXTENSION_STATUSES,
  EXTENSION_OPERATIONS,
  createExtensionManifest,
  extensionEntryHash,
  isExtensionType,
  isExtensionStatus,
  validateExtensionManifestEntry,
  ExtensionManifestError,
} from "../../src/extensions/extension-manifest.ts";
import type { ExtensionManifestEntry } from "../../src/extensions/extension-manifest.ts";
import { InputError } from "../../src/kernel/errors.ts";
import { makeEntry, makeProviderEntry, makeModuleEntry } from "./fixtures.ts";

// ============================================================================
// Closed registries
// ============================================================================

test("Manifest: EXTENSION_TYPES has exactly 7 types", () => {
  assert.equal(EXTENSION_TYPES.length, 7);
});

test("Manifest: EXTENSION_TYPES is frozen", () => {
  assert.ok(Object.isFrozen(EXTENSION_TYPES));
});

test("Manifest: EXTENSION_TYPES contains all root-policy types", () => {
  const expected = [
    "provider-adapter", "model-profile", "mcp-tool-or-adapter", "agent-profile",
    "quality-pack", "editor-repository-or-search-capability", "cohesive-product-module",
  ];
  for (const t of expected) {
    assert.ok(EXTENSION_TYPES.includes(t as never), `missing ${t}`);
  }
});

test("Manifest: EXTENSION_STATUSES has exactly 6 statuses", () => {
  assert.equal(EXTENSION_STATUSES.length, 6);
});

test("Manifest: EXTENSION_STATUSES is frozen", () => {
  assert.ok(Object.isFrozen(EXTENSION_STATUSES));
});

test("Manifest: EXTENSION_OPERATIONS has exactly 9 operations", () => {
  assert.equal(EXTENSION_OPERATIONS.length, 9);
});

test("Manifest: EXTENSION_MANIFEST_SCHEMA_VERSION is v1", () => {
  assert.equal(EXTENSION_MANIFEST_SCHEMA_VERSION, "bridlewise-extension-manifest/v1");
});

test("Manifest: isExtensionType true for registered", () => {
  assert.ok(isExtensionType("provider-adapter"));
});

test("Manifest: isExtensionType false for unknown", () => {
  assert.ok(!isExtensionType("unknown-type"));
});

test("Manifest: isExtensionStatus true for registered", () => {
  assert.ok(isExtensionStatus("active"));
});

test("Manifest: isExtensionStatus false for unknown", () => {
  assert.ok(!isExtensionStatus("unknown"));
});

// ============================================================================
// createExtensionManifest — creation
// ============================================================================

test("Manifest: creates empty manifest", () => {
  const m = createExtensionManifest();
  assert.equal(m.size(), 0);
  assert.deepEqual([...m.entries()], []);
});

test("Manifest: creates manifest with initial entries", () => {
  const e = makeEntry();
  const m = createExtensionManifest([e]);
  assert.equal(m.size(), 1);
  assert.ok(m.has("ext-provider-one"));
});

test("Manifest: returned manifest is frozen", () => {
  const m = createExtensionManifest();
  assert.ok(Object.isFrozen(m));
});

test("Manifest: stored entry is frozen", () => {
  const m = createExtensionManifest([makeEntry()]);
  const e = m.get("ext-provider-one");
  assert.ok(e);
  assert.ok(Object.isFrozen(e));
  assert.ok(Object.isFrozen(e!.capabilities));
  assert.ok(Object.isFrozen(e!.dependencies));
  assert.ok(Object.isFrozen(e!.provenance));
});

// ============================================================================
// register — duplicate / validation
// ============================================================================

test("Manifest: register adds entry", () => {
  const m = createExtensionManifest();
  m.register(makeEntry());
  assert.equal(m.size(), 1);
});

test("Manifest: register throws on duplicate id", () => {
  assert.throws(
    () => createExtensionManifest([makeEntry(), makeEntry()]),
    (e: Error) => e instanceof InputError && e.code === "extension_manifest_duplicate_id",
  );
});

test("Manifest: register throws on invalid entry", () => {
  assert.throws(
    () => createExtensionManifest([makeEntry({ id: "BAD ID" })]),
    (e: Error) => e instanceof ExtensionManifestError,
  );
});

// ============================================================================
// validateExtensionManifestEntry — field validation
// ============================================================================

test("Manifest: validate accepts a valid entry", () => {
  assert.equal(validateExtensionManifestEntry(makeEntry()).length, 0);
});

test("Manifest: validate rejects empty id", () => {
  assert.ok(validateExtensionManifestEntry(makeEntry({ id: "" })).length > 0);
});

test("Manifest: validate rejects id with invalid pattern", () => {
  for (const bad of ["UPPER", "1bad space", "id/with/slash", "-leading-dash"]) {
    assert.ok(validateExtensionManifestEntry(makeEntry({ id: bad })).length > 0, `expected reject for '${bad}'`);
  }
});

test("Manifest: validate rejects invalid version", () => {
  assert.ok(validateExtensionManifestEntry(makeEntry({ version: "1.2" })).length > 0);
  assert.ok(validateExtensionManifestEntry(makeEntry({ version: "abc" })).length > 0);
});

test("Manifest: validate rejects unknown type", () => {
  assert.ok(validateExtensionManifestEntry(makeEntry({ type: "unknown" as ExtensionManifestEntry["type"] })).length > 0);
});

test("Manifest: validate rejects unknown status", () => {
  assert.ok(validateExtensionManifestEntry(makeEntry({ status: "unknown" as ExtensionManifestEntry["status"] })).length > 0);
});

test("Manifest: validate rejects empty description", () => {
  assert.ok(validateExtensionManifestEntry(makeEntry({ description: "" })).length > 0);
});

test("Manifest: validate rejects oversized description", () => {
  assert.ok(validateExtensionManifestEntry(makeEntry({ description: "x".repeat(4097) })).length > 0);
});

test("Manifest: validate rejects duplicate capabilities", () => {
  assert.ok(validateExtensionManifestEntry(makeEntry({ capabilities: ["a", "a"] })).length > 0);
});

test("Manifest: validate rejects empty capability string", () => {
  assert.ok(validateExtensionManifestEntry(makeEntry({ capabilities: [""] })).length > 0);
});

test("Manifest: validate rejects invalid capability pattern", () => {
  assert.ok(validateExtensionManifestEntry(makeEntry({ capabilities: ["Bad Cap"] })).length > 0);
});

test("Manifest: validate rejects dependency with invalid id", () => {
  const e = makeEntry({ dependencies: [{ id: "BAD ID", versionRange: "^1.0.0" }] });
  assert.ok(validateExtensionManifestEntry(e).length > 0);
});

test("Manifest: validate rejects dependency with invalid version range", () => {
  const e = makeEntry({ dependencies: [{ id: "dep", versionRange: "abc" }] });
  assert.ok(validateExtensionManifestEntry(e).length > 0);
});

test("Manifest: validate rejects dependency with non-boolean optional", () => {
  const e = makeEntry({ dependencies: [{ id: "dep", versionRange: "^1.0.0", optional: "yes" as unknown as boolean }] });
  assert.ok(validateExtensionManifestEntry(e).length > 0);
});

test("Manifest: validate rejects duplicate dependency ids", () => {
  const e = makeEntry({
    dependencies: [
      { id: "dep", versionRange: "^1.0.0" },
      { id: "dep", versionRange: "^1.0.0" },
    ],
  });
  assert.ok(validateExtensionManifestEntry(e).length > 0);
});

test("Manifest: validate rejects empty entryPoint", () => {
  assert.ok(validateExtensionManifestEntry(makeEntry({ entryPoint: "" })).length > 0);
});

test("Manifest: validate rejects invalid entryPoint pattern", () => {
  assert.ok(validateExtensionManifestEntry(makeEntry({ entryPoint: "bad path!" })).length > 0);
});

test("Manifest: validate rejects invalid apiVersion", () => {
  assert.ok(validateExtensionManifestEntry(makeEntry({ apiVersion: "abc" })).length > 0);
});

test("Manifest: validate rejects invalid compatibilityRange", () => {
  assert.ok(validateExtensionManifestEntry(makeEntry({ compatibilityRange: "abc" })).length > 0);
});

test("Manifest: validate rejects invalid contentDigest", () => {
  assert.ok(validateExtensionManifestEntry(makeEntry({ provenance: { publisher: "p", sourceUri: "local://x", contentDigest: "nothex" } })).length > 0);
});

test("Manifest: validate rejects empty publisher", () => {
  assert.ok(validateExtensionManifestEntry(makeEntry({ provenance: { publisher: "", sourceUri: "local://x", contentDigest: "0".repeat(64) } })).length > 0);
});

test("Manifest: validate accepts declaredLicense when present", () => {
  const e = makeEntry({ provenance: { publisher: "p", sourceUri: "local://x", contentDigest: "0".repeat(64), declaredLicense: "MIT" } });
  assert.equal(validateExtensionManifestEntry(e).length, 0);
});

test("Manifest: validate rejects non-object configSchemaFragment", () => {
  assert.ok(validateExtensionManifestEntry(makeEntry({ configSchemaFragment: "not-an-object" as unknown as Record<string, unknown> })).length > 0);
});

test("Manifest: validate accepts object configSchemaFragment", () => {
  const e = makeEntry({ configSchemaFragment: { type: "object" } });
  assert.equal(validateExtensionManifestEntry(e).length, 0);
});

test("Manifest: validate rejects invalid createdAt", () => {
  assert.ok(validateExtensionManifestEntry(makeEntry({ createdAt: "2026/07/15" })).length > 0);
});

test("Manifest: validate rejects invalid updatedAt", () => {
  assert.ok(validateExtensionManifestEntry(makeEntry({ updatedAt: "not-a-date" })).length > 0);
});

test("Manifest: validate rejects updatedAt before createdAt", () => {
  const e = makeEntry({ createdAt: "2026-07-16T00:00:00Z", updatedAt: "2026-07-15T00:00:00Z" });
  assert.ok(validateExtensionManifestEntry(e).length > 0);
});

// ============================================================================
// query methods
// ============================================================================

test("Manifest: get returns entry by id", () => {
  const m = createExtensionManifest([makeEntry()]);
  assert.ok(m.get("ext-provider-one"));
});

test("Manifest: get returns undefined for unknown id", () => {
  const m = createExtensionManifest();
  assert.equal(m.get("nope"), undefined);
});

test("Manifest: has returns boolean", () => {
  const m = createExtensionManifest([makeEntry()]);
  assert.ok(m.has("ext-provider-one"));
  assert.ok(!m.has("nope"));
});

test("Manifest: byType filters by type", () => {
  const m = createExtensionManifest([makeProviderEntry("p1"), makeModuleEntry("m1")]);
  assert.equal(m.byType("provider-adapter").length, 1);
  assert.equal(m.byType("cohesive-product-module").length, 1);
  assert.equal(m.byType("quality-pack").length, 0);
});

test("Manifest: byStatus filters by status", () => {
  const m = createExtensionManifest([makeEntry({ status: "active" }), makeEntry({ id: "ext-two", status: "disabled" })]);
  assert.equal(m.byStatus("active").length, 1);
  assert.equal(m.byStatus("disabled").length, 1);
});

test("Manifest: activeEntries returns only active", () => {
  const m = createExtensionManifest([makeEntry({ status: "active" }), makeEntry({ id: "ext-two", status: "proposed" })]);
  assert.equal(m.activeEntries().length, 1);
});

test("Manifest: ids returns sorted ids", () => {
  const m = createExtensionManifest([makeProviderEntry("b"), makeProviderEntry("a")]);
  assert.deepEqual([...m.ids()], ["a", "b"]);
});

test("Manifest: entries returns all entries", () => {
  const m = createExtensionManifest([makeProviderEntry("a"), makeProviderEntry("b")]);
  assert.equal(m.entries().length, 2);
});

// ============================================================================
// validate (manifest-wide) — missing dependencies + cycles
// ============================================================================

test("Manifest: validate flags missing non-optional dependency", () => {
  const e = makeEntry({ dependencies: [{ id: "missing-dep", versionRange: "^1.0.0" }] });
  const m = createExtensionManifest([e]);
  const v = m.validate();
  assert.ok(v.some((x) => x.includes("missing-dep")));
});

test("Manifest: validate does not flag optional missing dependency", () => {
  const e = makeEntry({ dependencies: [{ id: "missing-dep", versionRange: "^1.0.0", optional: true }] });
  const m = createExtensionManifest([e]);
  const v = m.validate();
  assert.ok(!v.some((x) => x.includes("missing non-optional")));
});

test("Manifest: validate flags cycle in dependency graph", () => {
  const a = makeProviderEntry("a");
  const b = makeEntry({ id: "b", dependencies: [{ id: "a", versionRange: "^1.0.0" }] });
  const aWithDep = { ...a, dependencies: [{ id: "b", versionRange: "^1.0.0" }] };
  const m = createExtensionManifest([aWithDep, b]);
  const v = m.validate();
  assert.ok(v.some((x) => x.includes("cycle")));
});

test("Manifest: validate passes for clean manifest", () => {
  const m = createExtensionManifest([makeProviderEntry("a")]);
  assert.equal(m.validate().length, 0);
});

// ============================================================================
// dependents / dependencyGraph / hasCycle
// ============================================================================

test("Manifest: dependents returns ids that depend on given id", () => {
  const a = makeProviderEntry("a");
  const b = makeEntry({ id: "b", dependencies: [{ id: "a", versionRange: "^1.0.0" }] });
  const c = makeEntry({ id: "c", dependencies: [{ id: "a", versionRange: "^1.0.0" }] });
  const m = createExtensionManifest([a, b, c]);
  assert.deepEqual([...m.dependents("a")], ["b", "c"]);
});

test("Manifest: dependents returns empty for unknown id", () => {
  const m = createExtensionManifest([makeProviderEntry("a")]);
  assert.deepEqual([...m.dependents("nope")], []);
});

test("Manifest: dependencyGraph returns sorted adjacency", () => {
  const a = makeProviderEntry("a");
  const b = makeEntry({ id: "b", dependencies: [{ id: "a", versionRange: "^1.0.0" }] });
  const m = createExtensionManifest([a, b]);
  const g = m.dependencyGraph();
  assert.deepEqual([...(g["a"] ?? [])], []);
  assert.deepEqual([...(g["b"] ?? [])], ["a"]);
});

test("Manifest: hasCycle false for acyclic graph", () => {
  const m = createExtensionManifest([makeProviderEntry("a")]);
  assert.ok(!m.hasCycle());
});

test("Manifest: hasCycle true for cyclic graph", () => {
  const a = makeProviderEntry("a");
  const b = makeEntry({ id: "b", dependencies: [{ id: "a", versionRange: "^1.0.0" }] });
  const aWithDep = { ...a, dependencies: [{ id: "b", versionRange: "^1.0.0" }] };
  const m = createExtensionManifest([aWithDep, b]);
  assert.ok(m.hasCycle());
});

test("Manifest: hasCycle false for self-loop-free diamond", () => {
  const a = makeProviderEntry("a");
  const b = makeEntry({ id: "b", dependencies: [{ id: "a", versionRange: "^1.0.0" }] });
  const c = makeEntry({ id: "c", dependencies: [{ id: "a", versionRange: "^1.0.0" }, { id: "b", versionRange: "^1.0.0" }] });
  const m = createExtensionManifest([a, b, c]);
  assert.ok(!m.hasCycle());
});

// ============================================================================
// identityHash / snapshot
// ============================================================================

test("Manifest: identityHash is deterministic for same content", () => {
  const m1 = createExtensionManifest([makeProviderEntry("a")]);
  const m2 = createExtensionManifest([makeProviderEntry("a")]);
  assert.equal(m1.identityHash(), m2.identityHash());
});

test("Manifest: identityHash changes when content changes", () => {
  const m1 = createExtensionManifest([makeProviderEntry("a")]);
  const m2 = createExtensionManifest([makeProviderEntry("a", "2.0.0")]);
  assert.notEqual(m1.identityHash(), m2.identityHash());
});

test("Manifest: identityHash is order-independent", () => {
  const m1 = createExtensionManifest([makeProviderEntry("a"), makeProviderEntry("b")]);
  const m2 = createExtensionManifest([makeProviderEntry("b"), makeProviderEntry("a")]);
  assert.equal(m1.identityHash(), m2.identityHash());
});

test("Manifest: snapshot returns schema version and hash", () => {
  const m = createExtensionManifest([makeProviderEntry("a")]);
  const s = m.snapshot();
  assert.equal(s.schemaVersion, EXTENSION_MANIFEST_SCHEMA_VERSION);
  assert.equal(s.entries.length, 1);
  assert.ok(s.manifestHash.length === 64);
});

test("Manifest: snapshot hash is deterministic", () => {
  const m1 = createExtensionManifest([makeProviderEntry("a")]);
  const m2 = createExtensionManifest([makeProviderEntry("a")]);
  assert.equal(m1.snapshot().manifestHash, m2.snapshot().manifestHash);
});

test("Manifest: snapshot entries are sorted by id", () => {
  const m = createExtensionManifest([makeProviderEntry("b"), makeProviderEntry("a")]);
  const s = m.snapshot();
  assert.deepEqual(s.entries.map((e) => e.id), ["a", "b"]);
});

// ============================================================================
// extensionEntryHash
// ============================================================================

test("Manifest: extensionEntryHash is deterministic", () => {
  const e = makeEntry();
  assert.equal(extensionEntryHash(e), extensionEntryHash(e));
});

test("Manifest: extensionEntryHash changes with status", () => {
  const e1 = makeEntry({ status: "active" });
  const e2 = makeEntry({ status: "disabled" });
  assert.notEqual(extensionEntryHash(e1), extensionEntryHash(e2));
});

// ============================================================================
// Hostile / adversarial
// ============================================================================

test("Manifest: register with null entry throws", () => {
  assert.throws(() => createExtensionManifest([null as unknown as ExtensionManifestEntry]));
});

test("Manifest: register with undefined entry throws", () => {
  assert.throws(() => createExtensionManifest([undefined as unknown as ExtensionManifestEntry]));
});

test("Manifest: validate rejects oversized id", () => {
  assert.ok(validateExtensionManifestEntry(makeEntry({ id: "a".repeat(129) })).length > 0);
});

test("Manifest: validate rejects too many capabilities", () => {
  const caps = Array.from({ length: 33 }, (_, i) => `cap${i}`);
  assert.ok(validateExtensionManifestEntry(makeEntry({ capabilities: caps })).length > 0);
});

test("Manifest: validate rejects too many dependencies", () => {
  const deps = Array.from({ length: 65 }, (_, i) => ({ id: `d${i}`, versionRange: "^1.0.0" }));
  assert.ok(validateExtensionManifestEntry(makeEntry({ dependencies: deps })).length > 0);
});

test("Manifest: multiple manifests are independent", () => {
  const m1 = createExtensionManifest([makeProviderEntry("a")]);
  const m2 = createExtensionManifest();
  assert.equal(m1.size(), 1);
  assert.equal(m2.size(), 0);
});
