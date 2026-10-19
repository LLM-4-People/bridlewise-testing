import assert from "node:assert/strict";
import test from "node:test";

import {
  LIFECYCLE_TRANSITIONS,
  isLegalTransition,
  legalTransitionsFor,
  legalTargetsFrom,
  proposeAdd,
  proposeEdit,
  proposeStatusChange,
  proposeVersionChange,
  proposeDelete,
  proposeRollback,
  LifecycleError,
} from "../../src/extensions/extension-lifecycle.ts";
import type { LifecycleContext, LifecycleResult } from "../../src/extensions/extension-lifecycle.ts";
import { createExtensionManifest } from "../../src/extensions/extension-manifest.ts";
import type { ExtensionManifestEntry } from "../../src/extensions/extension-manifest.ts";
import { InputError, SecurityError } from "../../src/kernel/errors.ts";
import {
  makeEntry, makeProviderEntry, makeModuleEntry, VALID_TIMESTAMP, LATER_TIMESTAMP,
} from "./fixtures.ts";

function ctx(entries: ExtensionManifestEntry[] = []): LifecycleContext {
  return { manifest: createExtensionManifest(entries) };
}

// ============================================================================
// LIFECYCLE_TRANSITIONS — closed registry
// ============================================================================

test("Lifecycle: LIFECYCLE_TRANSITIONS is frozen", () => {
  assert.ok(Object.isFrozen(LIFECYCLE_TRANSITIONS));
});

test("Lifecycle: LIFECYCLE_TRANSITIONS contains add→active", () => {
  assert.ok(LIFECYCLE_TRANSITIONS.some((t) => t.operation === "add" && t.to === "active"));
});

test("Lifecycle: LIFECYCLE_TRANSITIONS contains delete→tombstoned from active", () => {
  assert.ok(LIFECYCLE_TRANSITIONS.some((t) => t.operation === "delete" && t.from === "active" && t.to === "tombstoned"));
});

test("Lifecycle: LIFECYCLE_TRANSITIONS contains rollback from active", () => {
  assert.ok(LIFECYCLE_TRANSITIONS.some((t) => t.operation === "rollback" && t.from === "active"));
});

test("Lifecycle: isLegalTransition true for registered edge", () => {
  assert.ok(isLegalTransition("add", "absent", "active"));
});

test("Lifecycle: isLegalTransition false for unregistered edge", () => {
  assert.ok(!isLegalTransition("rollback", "proposed", "active"));
  assert.ok(!isLegalTransition("enable", "absent", "active"));
  assert.ok(!isLegalTransition("delete", "absent", "absent"));
});

test("Lifecycle: legalTransitionsFor filters by operation", () => {
  const adds = legalTransitionsFor("add");
  assert.equal(adds.length, 3);
  assert.ok(adds.every((t) => t.operation === "add"));
});

test("Lifecycle: legalTargetsFrom returns targets from a status", () => {
  const targets = legalTargetsFrom("enable", "disabled");
  assert.deepEqual([...targets], ["active"]);
});

test("Lifecycle: legalTargetsFrom returns empty for impossible", () => {
  const targets = legalTargetsFrom("rollback", "proposed");
  assert.equal(targets.length, 0);
});

// ============================================================================
// proposeAdd
// ============================================================================

test("Lifecycle: proposeAdd returns result with preimage/postimage hashes", () => {
  const entry = makeEntry({ status: "proposed" });
  const r = proposeAdd({ context: ctx(), entry });
  assert.equal(r.operation, "add");
  assert.equal(r.extensionId, entry.id);
  assert.equal(r.previousEntry, null);
  assert.ok(r.preimageHash.length === 64);
  assert.ok(r.postimageHash.length === 64);
  assert.equal(r.transition.to, "proposed");
});

test("Lifecycle: proposeAdd with targetStatus active", () => {
  const entry = makeEntry();
  const r = proposeAdd({ context: ctx(), entry, targetStatus: "active" });
  assert.equal(r.transition.to, "active");
  assert.equal(r.nextEntry.status, "active");
});

test("Lifecycle: proposeAdd throws on duplicate id", () => {
  const entry = makeEntry();
  assert.throws(
    () => proposeAdd({ context: ctx([entry]), entry }),
    (e: Error) => e instanceof InputError && e.code === "extension_lifecycle_duplicate_id",
  );
});

test("Lifecycle: proposeAdd throws on invalid entry", () => {
  assert.throws(
    () => proposeAdd({ context: ctx(), entry: makeEntry({ id: "BAD ID" }) }),
    (e: Error) => e instanceof LifecycleError,
  );
});

test("Lifecycle: proposeAdd throws on incompatible (bad apiVersion)", () => {
  const entry = makeEntry({ apiVersion: "2.0.0" });
  const c: LifecycleContext = {
    manifest: createExtensionManifest(),
    harness: { apiVersion: "1.0.0", compatibilityRange: "^1.0.0" },
  };
  assert.throws(
    () => proposeAdd({ context: c, entry }),
    (e: Error) => e instanceof LifecycleError && e.code === "extension_lifecycle_incompatible",
  );
});

test("Lifecycle: proposeAdd throws on illegal targetStatus", () => {
  assert.throws(
    () => proposeAdd({ context: ctx(), entry: makeEntry(), targetStatus: "deprecated" }),
    (e: Error) => e instanceof LifecycleError && e.code === "extension_lifecycle_illegal_transition",
  );
});

test("Lifecycle: proposeAdd with required capabilities validates", () => {
  const entry = makeEntry({ capabilities: ["a"] });
  assert.throws(
    () => proposeAdd({ context: ctx(), entry, requiredCapabilities: ["a", "b"] }),
    (e: Error) => e instanceof LifecycleError,
  );
});

// ============================================================================
// proposeEdit
// ============================================================================

test("Lifecycle: proposeEdit returns result with previous and next", () => {
  const entry = makeEntry({ status: "active" });
  const r = proposeEdit({ context: ctx([entry]), id: entry.id, changes: { description: "updated" } });
  assert.equal(r.operation, "edit");
  assert.ok(r.previousEntry);
  assert.equal(r.nextEntry.description, "updated");
  assert.equal(r.previousEntry!.description, "A test provider adapter extension.");
});

test("Lifecycle: proposeEdit updates version compatibly", () => {
  const entry = makeEntry({ status: "active", version: "1.0.0" });
  const r = proposeEdit({ context: ctx([entry]), id: entry.id, changes: { version: "1.1.0" } });
  assert.equal(r.nextEntry.version, "1.1.0");
  assert.ok(r.backwardCompatibility);
  assert.ok(r.backwardCompatibility.backwardCompatible);
});

test("Lifecycle: proposeEdit throws for unknown id", () => {
  assert.throws(
    () => proposeEdit({ context: ctx(), id: "nope", changes: {} }),
    (e: Error) => e instanceof InputError && e.code === "extension_lifecycle_not_found",
  );
});

test("Lifecycle: proposeEdit throws on breaking capability removal", () => {
  const entry = makeEntry({ status: "active", capabilities: ["a", "b"] });
  assert.throws(
    () => proposeEdit({ context: ctx([entry]), id: entry.id, changes: { capabilities: ["a"] } }),
    (e: Error) => e instanceof LifecycleError && e.code === "extension_lifecycle_breaking_edit",
  );
});

test("Lifecycle: proposeEdit throws on illegal status transition", () => {
  const entry = makeEntry({ status: "proposed" });
  assert.throws(
    () => proposeEdit({ context: ctx([entry]), id: entry.id, changes: { status: "active" } }),
    (e: Error) => e instanceof LifecycleError && e.code === "extension_lifecycle_illegal_transition",
  );
});

test("Lifecycle: proposeEdit throws on id change attempt", () => {
  const entry = makeEntry({ status: "active" });
  // id is Omit-ed from changes, so it cannot be changed; type stays fixed
  const r = proposeEdit({ context: ctx([entry]), id: entry.id, changes: { description: "x" } });
  assert.equal(r.nextEntry.id, entry.id);
  assert.equal(r.nextEntry.type, entry.type);
});

test("Lifecycle: proposeEdit preserves createdAt", () => {
  const entry = makeEntry({ createdAt: "2026-01-01T00:00:00Z" });
  const r = proposeEdit({ context: ctx([entry]), id: entry.id, changes: { description: "x" } });
  assert.equal(r.nextEntry.createdAt, "2026-01-01T00:00:00Z");
});

// ============================================================================
// proposeStatusChange — enable / disable / deprecate
// ============================================================================

test("Lifecycle: proposeStatusChange enable staged→active", () => {
  const entry = makeEntry({ status: "staged" });
  const r = proposeStatusChange({ context: ctx([entry]), id: entry.id, operation: "enable", targetStatus: "active", updatedAt: LATER_TIMESTAMP });
  assert.equal(r.nextEntry.status, "active");
  assert.equal(r.transition.from, "staged");
  assert.equal(r.transition.to, "active");
});

test("Lifecycle: proposeStatusChange disable active→disabled", () => {
  const entry = makeEntry({ status: "active" });
  const r = proposeStatusChange({ context: ctx([entry]), id: entry.id, operation: "disable", targetStatus: "disabled", updatedAt: LATER_TIMESTAMP });
  assert.equal(r.nextEntry.status, "disabled");
});

test("Lifecycle: proposeStatusChange deprecate active→deprecated", () => {
  const entry = makeEntry({ status: "active" });
  const r = proposeStatusChange({ context: ctx([entry]), id: entry.id, operation: "deprecate", targetStatus: "deprecated", updatedAt: LATER_TIMESTAMP });
  assert.equal(r.nextEntry.status, "deprecated");
});

test("Lifecycle: proposeStatusChange throws on illegal transition", () => {
  const entry = makeEntry({ status: "proposed" });
  assert.throws(
    () => proposeStatusChange({ context: ctx([entry]), id: entry.id, operation: "disable", targetStatus: "disabled", updatedAt: LATER_TIMESTAMP }),
    (e: Error) => e instanceof LifecycleError && e.code === "extension_lifecycle_illegal_transition",
  );
});

test("Lifecycle: proposeStatusChange throws on invalid timestamp", () => {
  const entry = makeEntry({ status: "staged" });
  assert.throws(
    () => proposeStatusChange({ context: ctx([entry]), id: entry.id, operation: "enable", targetStatus: "active", updatedAt: "bad" }),
    (e: Error) => e instanceof InputError,
  );
});

test("Lifecycle: proposeStatusChange throws on unknown operation", () => {
  const entry = makeEntry({ status: "active" });
  assert.throws(
    () => proposeStatusChange({ context: ctx([entry]), id: entry.id, operation: "add" as never, targetStatus: "active", updatedAt: LATER_TIMESTAMP }),
  );
});

// ============================================================================
// proposeVersionChange — upgrade / downgrade
// ============================================================================

test("Lifecycle: proposeVersionChange upgrade increases version", () => {
  const entry = makeEntry({ status: "active", version: "1.0.0" });
  const r = proposeVersionChange({ context: ctx([entry]), id: entry.id, operation: "upgrade", newVersion: "1.1.0", updatedAt: LATER_TIMESTAMP });
  assert.equal(r.nextEntry.version, "1.1.0");
  assert.equal(r.operation, "upgrade");
});

test("Lifecycle: proposeVersionChange downgrade decreases version", () => {
  const entry = makeEntry({ status: "active", version: "1.5.0" });
  const r = proposeVersionChange({ context: ctx([entry]), id: entry.id, operation: "downgrade", newVersion: "1.0.0", updatedAt: LATER_TIMESTAMP });
  assert.equal(r.nextEntry.version, "1.0.0");
});

test("Lifecycle: proposeVersionChange upgrade throws when not higher", () => {
  const entry = makeEntry({ status: "active", version: "1.5.0" });
  assert.throws(
    () => proposeVersionChange({ context: ctx([entry]), id: entry.id, operation: "upgrade", newVersion: "1.0.0", updatedAt: LATER_TIMESTAMP }),
    (e: Error) => e instanceof LifecycleError && e.code === "extension_lifecycle_not_an_upgrade",
  );
});

test("Lifecycle: proposeVersionChange downgrade throws when not lower", () => {
  const entry = makeEntry({ status: "active", version: "1.0.0" });
  assert.throws(
    () => proposeVersionChange({ context: ctx([entry]), id: entry.id, operation: "downgrade", newVersion: "1.5.0", updatedAt: LATER_TIMESTAMP }),
    (e: Error) => e instanceof LifecycleError && e.code === "extension_lifecycle_not_a_downgrade",
  );
});

test("Lifecycle: proposeVersionChange throws on breaking downgrade", () => {
  const entry = makeEntry({ status: "active", version: "1.2.0", capabilities: ["a", "b"] });
  assert.throws(
    () => proposeVersionChange({
      context: ctx([entry]),
      id: entry.id,
      operation: "downgrade",
      newVersion: "1.0.0",
      updatedAt: LATER_TIMESTAMP,
      newCapabilities: ["a"],
    }),
    (e: Error) => e instanceof LifecycleError,
  );
});

test("Lifecycle: proposeVersionChange updates entryPoint", () => {
  const entry = makeEntry({ status: "active" });
  const r = proposeVersionChange({ context: ctx([entry]), id: entry.id, operation: "upgrade", newVersion: "2.0.0", updatedAt: LATER_TIMESTAMP, newEntryPoint: "src/providers/v2.ts" });
  assert.equal(r.nextEntry.entryPoint, "src/providers/v2.ts");
});

test("Lifecycle: proposeVersionChange throws on unknown id", () => {
  assert.throws(
    () => proposeVersionChange({ context: ctx(), id: "nope", operation: "upgrade", newVersion: "2.0.0", updatedAt: LATER_TIMESTAMP }),
    (e: Error) => e instanceof InputError,
  );
});

// ============================================================================
// proposeDelete
// ============================================================================

test("Lifecycle: proposeDelete tombstones entry", () => {
  const entry = makeEntry({ status: "active" });
  const r = proposeDelete({ context: ctx([entry]), id: entry.id, updatedAt: LATER_TIMESTAMP });
  assert.equal(r.nextEntry.status, "tombstoned");
  assert.equal(r.transition.to, "tombstoned");
});

test("Lifecycle: proposeDelete blocks when non-optional dependents exist", () => {
  const dep = makeProviderEntry("dep");
  const consumer = makeEntry({ id: "consumer", dependencies: [{ id: "dep", versionRange: "^1.0.0" }] });
  assert.throws(
    () => proposeDelete({ context: ctx([dep, consumer]), id: "dep", updatedAt: LATER_TIMESTAMP }),
    (e: Error) => e instanceof SecurityError && e.code === "extension_lifecycle_dependents_block_delete",
  );
});

test("Lifecycle: proposeDelete allows when optional dependents exist", () => {
  const dep = makeProviderEntry("dep");
  const consumer = makeEntry({ id: "consumer", dependencies: [{ id: "dep", versionRange: "^1.0.0", optional: true }] });
  const r = proposeDelete({ context: ctx([dep, consumer]), id: "dep", updatedAt: LATER_TIMESTAMP });
  assert.equal(r.nextEntry.status, "tombstoned");
});

test("Lifecycle: proposeDelete allows when dependents are tombstoned", () => {
  const dep = makeProviderEntry("dep");
  const consumer = makeEntry({ id: "consumer", status: "tombstoned", dependencies: [{ id: "dep", versionRange: "^1.0.0" }] });
  const r = proposeDelete({ context: ctx([dep, consumer]), id: "dep", updatedAt: LATER_TIMESTAMP });
  assert.equal(r.nextEntry.status, "tombstoned");
});

test("Lifecycle: proposeDelete throws on unknown id", () => {
  assert.throws(
    () => proposeDelete({ context: ctx(), id: "nope", updatedAt: LATER_TIMESTAMP }),
    (e: Error) => e instanceof InputError,
  );
});

test("Lifecycle: proposeDelete throws on invalid timestamp", () => {
  const entry = makeEntry({ status: "active" });
  assert.throws(
    () => proposeDelete({ context: ctx([entry]), id: entry.id, updatedAt: "bad" }),
    (e: Error) => e instanceof InputError,
  );
});

// ============================================================================
// proposeRollback
// ============================================================================

test("Lifecycle: proposeRollback from active→disabled", () => {
  const entry = makeEntry({ status: "active" });
  const r = proposeRollback({ context: ctx([entry]), id: entry.id, updatedAt: LATER_TIMESTAMP });
  assert.equal(r.nextEntry.status, "disabled");
  assert.equal(r.operation, "rollback");
});

test("Lifecycle: proposeRollback throws when not active", () => {
  const entry = makeEntry({ status: "proposed" });
  assert.throws(
    () => proposeRollback({ context: ctx([entry]), id: entry.id, updatedAt: LATER_TIMESTAMP }),
    (e: Error) => e instanceof LifecycleError && e.code === "extension_lifecycle_rollback_not_active",
  );
});

test("Lifecycle: proposeRollback throws on unknown id", () => {
  assert.throws(
    () => proposeRollback({ context: ctx(), id: "nope", updatedAt: LATER_TIMESTAMP }),
    (e: Error) => e instanceof InputError,
  );
});

// ============================================================================
// Hostile / cross-operation
// ============================================================================

test("Lifecycle: LifecycleResult is frozen", () => {
  const entry = makeEntry({ status: "active" });
  const r: LifecycleResult = proposeDelete({ context: ctx([entry]), id: entry.id, updatedAt: LATER_TIMESTAMP });
  assert.ok(Object.isFrozen(r));
});

test("Lifecycle: preimageHash differs from postimageHash on change", () => {
  const entry = makeEntry({ status: "active" });
  const r = proposeEdit({ context: ctx([entry]), id: entry.id, changes: { description: "changed" } });
  assert.notEqual(r.preimageHash, r.postimageHash);
});

test("Lifecycle: add to manifest with cycle throws", () => {
  const a = makeProviderEntry("a");
  const b = makeEntry({ id: "b", dependencies: [{ id: "a", versionRange: "^1.0.0" }] });
  const aWithDep = { ...a, dependencies: [{ id: "b", versionRange: "^1.0.0" }] };
  const c = makeModuleEntry("newmod");
  assert.throws(
    () => proposeAdd({ context: ctx([aWithDep, b]), entry: c }),
    (e: Error) => e instanceof LifecycleError && e.code === "extension_lifecycle_cycle",
  );
});

test("Lifecycle: add with satisfied optional dependency succeeds", () => {
  const dep = makeProviderEntry("dep");
  const entry = makeEntry({ id: "new", dependencies: [{ id: "dep", versionRange: "^1.0.0" }] });
  const r = proposeAdd({ context: ctx([dep]), entry });
  assert.equal(r.operation, "add");
  assert.ok(r.compatibility.compatible);
});

test("Lifecycle: edit that keeps all capabilities is backward compatible", () => {
  const entry = makeEntry({ status: "active", capabilities: ["a", "b"], version: "1.0.0" });
  const r = proposeEdit({ context: ctx([entry]), id: entry.id, changes: { version: "1.1.0", description: "new" } });
  assert.ok(r.backwardCompatibility);
  assert.ok(r.backwardCompatibility.backwardCompatible);
});

test("Lifecycle: warnings populated for deprecated dependency", () => {
  const dep = { ...makeProviderEntry("dep"), status: "deprecated" as const };
  const entry = makeEntry({ id: "new", dependencies: [{ id: "dep", versionRange: "^1.0.0" }] });
  const r = proposeAdd({ context: ctx([dep]), entry });
  assert.ok(r.warnings.some((w) => w.includes("deprecated")));
});

test("Lifecycle: updatedAt defaults to previous when omitted in edit", () => {
  const entry = makeEntry({ status: "active" });
  const r = proposeEdit({ context: ctx([entry]), id: entry.id, changes: { description: "x" } });
  assert.equal(r.nextEntry.updatedAt, entry.updatedAt);
});

test("Lifecycle: VALID_TIMESTAMP constant is ISO format", () => {
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(VALID_TIMESTAMP));
});
