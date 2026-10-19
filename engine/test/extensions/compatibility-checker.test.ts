import assert from "node:assert/strict";
import test from "node:test";

import {
  checkCompatibility,
  checkBackwardCompatibility,
  assertCompatible,
  isBlocking,
} from "../../src/extensions/compatibility-checker.ts";
import type { HarnessApiContract, CapabilityOwnership } from "../../src/extensions/compatibility-checker.ts";
import { createExtensionManifest } from "../../src/extensions/extension-manifest.ts";
import { makeEntry, makeProviderEntry, makeModelEntry, makeModuleEntry } from "./fixtures.ts";

const HARNESS: HarnessApiContract = { apiVersion: "1.0.0", compatibilityRange: "^1.0.0" };

// ============================================================================
// checkCompatibility — version
// ============================================================================

test("Compat: compatible when api versions satisfy ranges", () => {
  const m = createExtensionManifest();
  const r = checkCompatibility({ manifest: m, entry: makeEntry(), harness: HARNESS });
  assert.ok(r.compatible);
});

test("Compat: error when extension apiVersion outside harness range", () => {
  const m = createExtensionManifest();
  const r = checkCompatibility({ manifest: m, entry: makeEntry({ apiVersion: "2.0.0" }), harness: HARNESS });
  assert.ok(!r.compatible);
  assert.ok(r.findings.some((f) => f.code === "extension_api_version_outside_harness_range"));
});

test("Compat: error when harness apiVersion outside extension range", () => {
  const m = createExtensionManifest();
  const r = checkCompatibility({
    manifest: m,
    entry: makeEntry({ compatibilityRange: ">=2.0.0 <3.0.0" }),
    harness: HARNESS,
  });
  assert.ok(!r.compatible);
  assert.ok(r.findings.some((f) => f.code === "harness_api_version_outside_extension_range"));
});

test("Compat: no version findings when harness omitted", () => {
  const m = createExtensionManifest();
  const r = checkCompatibility({ manifest: m, entry: makeEntry() });
  assert.ok(r.findings.filter((f) => f.check === "version").length === 0);
});

// ============================================================================
// checkCompatibility — capability
// ============================================================================

test("Compat: error when required capability missing", () => {
  const m = createExtensionManifest();
  const r = checkCompatibility({
    manifest: m,
    entry: makeEntry({ capabilities: ["a"] }),
    requiredCapabilities: ["a", "b"],
  });
  assert.ok(!r.compatible);
  assert.ok(r.findings.some((f) => f.code === "required_capability_missing" && f.detail!.capability === "b"));
});

test("Compat: passes when all required capabilities present", () => {
  const m = createExtensionManifest();
  const r = checkCompatibility({
    manifest: m,
    entry: makeEntry({ capabilities: ["a", "b"] }),
    requiredCapabilities: ["a", "b"],
  });
  assert.ok(r.compatible);
});

test("Compat: no capability findings when requiredCapabilities omitted", () => {
  const m = createExtensionManifest();
  const r = checkCompatibility({ manifest: m, entry: makeEntry() });
  assert.ok(r.findings.filter((f) => f.check === "capability").length === 0);
});

// ============================================================================
// checkCompatibility — dependency
// ============================================================================

test("Compat: error when required dependency missing", () => {
  const m = createExtensionManifest();
  const entry = makeEntry({ dependencies: [{ id: "missing", versionRange: "^1.0.0" }] });
  const r = checkCompatibility({ manifest: m, entry });
  assert.ok(!r.compatible);
  assert.ok(r.findings.some((f) => f.code === "required_dependency_missing"));
});

test("Compat: info when optional dependency missing", () => {
  const m = createExtensionManifest();
  const entry = makeEntry({ dependencies: [{ id: "missing", versionRange: "^1.0.0", optional: true }] });
  const r = checkCompatibility({ manifest: m, entry });
  assert.ok(r.compatible);
  assert.ok(r.findings.some((f) => f.code === "optional_dependency_absent" && f.severity === "info"));
});

test("Compat: error when dependency version outside range", () => {
  const dep = makeProviderEntry("dep", "2.0.0");
  const m = createExtensionManifest([dep]);
  const entry = makeEntry({ dependencies: [{ id: "dep", versionRange: "^1.0.0" }] });
  const r = checkCompatibility({ manifest: m, entry });
  assert.ok(!r.compatible);
  assert.ok(r.findings.some((f) => f.code === "dependency_version_outside_range"));
});

test("Compat: passes when dependency version satisfies range", () => {
  const dep = makeProviderEntry("dep", "1.5.0");
  const m = createExtensionManifest([dep]);
  const entry = makeEntry({ dependencies: [{ id: "dep", versionRange: "^1.0.0" }] });
  const r = checkCompatibility({ manifest: m, entry });
  assert.ok(r.compatible);
});

test("Compat: error when dependency tombstoned", () => {
  const m = createExtensionManifest([{ ...makeProviderEntry("dep"), status: "tombstoned" }]);
  const entry = makeEntry({ dependencies: [{ id: "dep", versionRange: "^1.0.0" }] });
  const r = checkCompatibility({ manifest: m, entry });
  assert.ok(r.findings.some((f) => f.code === "dependency_tombstoned"));
});

test("Compat: warning when dependency deprecated", () => {
  const m = createExtensionManifest([{ ...makeProviderEntry("dep"), status: "deprecated" }]);
  const entry = makeEntry({ dependencies: [{ id: "dep", versionRange: "^1.0.0" }] });
  const r = checkCompatibility({ manifest: m, entry });
  assert.ok(r.findings.some((f) => f.code === "dependency_deprecated" && f.severity === "warning"));
  assert.ok(r.compatible);
});

test("Compat: fatal when dependency is self reference", () => {
  const m = createExtensionManifest([makeProviderEntry("self")]);
  const entry = makeEntry({
    id: "self",
    dependencies: [{ id: "self", versionRange: "^1.0.0" }],
  });
  const r = checkCompatibility({ manifest: m, entry, existingEntryId: "self" });
  assert.ok(r.findings.some((f) => f.code === "dependency_self_reference" && f.severity === "fatal"));
});

// ============================================================================
// checkCompatibility — conflict
// ============================================================================

test("Compat: fatal duplicate id when no existingEntryId", () => {
  const m = createExtensionManifest([makeProviderEntry("dup")]);
  const r = checkCompatibility({ manifest: m, entry: makeProviderEntry("dup") });
  assert.ok(r.findings.some((f) => f.code === "duplicate_id" && f.severity === "fatal"));
});

test("Compat: no duplicate id when editing existing entry", () => {
  const m = createExtensionManifest([makeProviderEntry("dup")]);
  const r = checkCompatibility({ manifest: m, entry: makeProviderEntry("dup"), existingEntryId: "dup" });
  assert.ok(!r.findings.some((f) => f.code === "duplicate_id"));
});

test("Compat: error on entryPoint collision with same type", () => {
  const m = createExtensionManifest([makeProviderEntry("a")]);
  const entry = makeEntry({ id: "b", entryPoint: "src/providers/a.ts" });
  const r = checkCompatibility({ manifest: m, entry });
  assert.ok(r.findings.some((f) => f.code === "entry_point_collision"));
});

test("Compat: no entryPoint collision for different type", () => {
  const m = createExtensionManifest([makeModelEntry("a")]);
  const entry = makeEntry({ id: "b", type: "provider-adapter", entryPoint: "src/models/a.ts" });
  const r = checkCompatibility({ manifest: m, entry });
  assert.ok(!r.findings.some((f) => f.code === "entry_point_collision"));
});

test("Compat: error on exclusive capability conflict", () => {
  const m = createExtensionManifest();
  const ownerships: CapabilityOwnership[] = [{ capability: "exclusive-cap", ownerExtensionId: "owner", exclusive: true }];
  const entry = makeEntry({ id: "new", capabilities: ["exclusive-cap"] });
  const r = checkCompatibility({ manifest: m, entry, capabilityOwnerships: ownerships });
  assert.ok(r.findings.some((f) => f.code === "exclusive_capability_conflict"));
});

test("Compat: no conflict when same owner holds exclusive cap", () => {
  const m = createExtensionManifest();
  const ownerships: CapabilityOwnership[] = [{ capability: "exclusive-cap", ownerExtensionId: "owner", exclusive: true }];
  const entry = makeEntry({ id: "owner", capabilities: ["exclusive-cap"] });
  const r = checkCompatibility({ manifest: m, entry, capabilityOwnerships: ownerships });
  assert.ok(!r.findings.some((f) => f.code === "exclusive_capability_conflict"));
});

test("Compat: no conflict for non-exclusive capability ownerships", () => {
  const m = createExtensionManifest();
  const ownerships: CapabilityOwnership[] = [{ capability: "shared-cap", ownerExtensionId: "owner", exclusive: false }];
  const entry = makeEntry({ id: "new", capabilities: ["shared-cap"] });
  const r = checkCompatibility({ manifest: m, entry, capabilityOwnerships: ownerships });
  assert.ok(r.compatible);
});

// ============================================================================
// report shape
// ============================================================================

test("Compat: report summary is populated", () => {
  const m = createExtensionManifest();
  const r = checkCompatibility({ manifest: m, entry: makeEntry() });
  assert.ok(r.summary.includes("compatible"));
});

test("Compat: blockingCount counts error and fatal", () => {
  const m = createExtensionManifest();
  const r = checkCompatibility({ manifest: m, entry: makeEntry({ apiVersion: "2.0.0" }), harness: HARNESS });
  assert.ok(r.blockingCount >= 1);
});

test("Compat: isBlocking true for error", () => {
  const m = createExtensionManifest();
  const r = checkCompatibility({ manifest: m, entry: makeEntry({ apiVersion: "2.0.0" }), harness: HARNESS });
  assert.ok(isBlocking(r.findings[0]!));
});

test("Compat: assertCompatible throws on incompatible", () => {
  const m = createExtensionManifest();
  const r = checkCompatibility({ manifest: m, entry: makeEntry({ apiVersion: "2.0.0" }), harness: HARNESS });
  assert.throws(() => assertCompatible(r, "ctx"));
});

test("Compat: assertCompatible does not throw on compatible", () => {
  const m = createExtensionManifest();
  const r = checkCompatibility({ manifest: m, entry: makeEntry(), harness: HARNESS });
  assert.doesNotThrow(() => assertCompatible(r, "ctx"));
});

// ============================================================================
// checkBackwardCompatibility
// ============================================================================

test("Backward: same version compatible", () => {
  const prev = makeEntry();
  const next = makeEntry();
  const r = checkBackwardCompatibility(prev, next);
  assert.ok(r.backwardCompatible);
});

test("Backward: id change is fatal", () => {
  const prev = makeEntry({ id: "a" });
  const next = makeEntry({ id: "b" });
  const r = checkBackwardCompatibility(prev, next);
  assert.ok(!r.backwardCompatible);
  assert.ok(r.findings.some((f) => f.code === "id_changed"));
});

test("Backward: type change is fatal", () => {
  const prev = makeEntry({ type: "provider-adapter" });
  const next = makeEntry({ type: "model-profile" });
  const r = checkBackwardCompatibility(prev, next);
  assert.ok(!r.backwardCompatible);
  assert.ok(r.findings.some((f) => f.code === "type_changed"));
});

test("Backward: version downgrade is error", () => {
  const prev = makeEntry({ version: "1.5.0" });
  const next = makeEntry({ version: "1.2.0" });
  const r = checkBackwardCompatibility(prev, next);
  assert.ok(!r.backwardCompatible);
  assert.ok(r.findings.some((f) => f.code === "version_downgrade"));
});

test("Backward: major bump that drops prior is breaking", () => {
  const prev = makeEntry({ version: "1.0.0", compatibilityRange: "^1.0.0" });
  const next = makeEntry({ version: "2.0.0", compatibilityRange: "^2.0.0" });
  const r = checkBackwardCompatibility(prev, next);
  assert.ok(!r.backwardCompatible);
  assert.ok(r.findings.some((f) => f.code === "breaking_major_bump"));
});

test("Backward: major bump that keeps prior is compatible", () => {
  const prev = makeEntry({ version: "1.0.0", compatibilityRange: "^1.0.0" });
  const next = makeEntry({ version: "2.0.0", compatibilityRange: ">=1.0.0 <3.0.0" });
  const r = checkBackwardCompatibility(prev, next);
  assert.ok(r.backwardCompatible);
});

test("Backward: removed capability is breaking", () => {
  const prev = makeEntry({ capabilities: ["a", "b"] });
  const next = makeEntry({ capabilities: ["a"] });
  const r = checkBackwardCompatibility(prev, next);
  assert.ok(!r.backwardCompatible);
  assert.ok(r.findings.some((f) => f.code === "capability_removed" && f.detail!.capability === "b"));
});

test("Backward: added capability is compatible", () => {
  const prev = makeEntry({ capabilities: ["a"] });
  const next = makeEntry({ capabilities: ["a", "b"] });
  const r = checkBackwardCompatibility(prev, next);
  assert.ok(r.backwardCompatible);
});

test("Backward: removed required dependency is breaking", () => {
  const prev = makeEntry({ dependencies: [{ id: "dep", versionRange: "^1.0.0" }] });
  const next = makeEntry({ dependencies: [] });
  const r = checkBackwardCompatibility(prev, next);
  assert.ok(!r.backwardCompatible);
  assert.ok(r.findings.some((f) => f.code === "required_dependency_removed"));
});

test("Backward: removed optional dependency is compatible", () => {
  const prev = makeEntry({ dependencies: [{ id: "dep", versionRange: "^1.0.0", optional: true }] });
  const next = makeEntry({ dependencies: [] });
  const r = checkBackwardCompatibility(prev, next);
  assert.ok(r.backwardCompatible);
});

test("Backward: patch bump is compatible", () => {
  const prev = makeEntry({ version: "1.2.3" });
  const next = makeEntry({ version: "1.2.4" });
  const r = checkBackwardCompatibility(prev, next);
  assert.ok(r.backwardCompatible);
});

test("Backward: minor bump is compatible", () => {
  const prev = makeEntry({ version: "1.2.3" });
  const next = makeEntry({ version: "1.3.0" });
  const r = checkBackwardCompatibility(prev, next);
  assert.ok(r.backwardCompatible);
});

test("Backward: summary is populated", () => {
  const prev = makeEntry();
  const next = makeEntry({ version: "1.2.4" });
  const r = checkBackwardCompatibility(prev, next);
  assert.ok(r.summary.length > 0);
});

// ============================================================================
// Hostile / combined
// ============================================================================

test("Compat: multiple blocking findings sum in blockingCount", () => {
  const m = createExtensionManifest();
  const entry = makeEntry({
    apiVersion: "2.0.0",
    dependencies: [{ id: "missing", versionRange: "^1.0.0" }],
  });
  const r = checkCompatibility({ manifest: m, entry, harness: HARNESS });
  assert.ok(r.blockingCount >= 2);
});

test("Compat: existing module edit with new dependency resolves", () => {
  const dep = makeModuleEntry("dep");
  const existing = makeModuleEntry("mod");
  const m = createExtensionManifest([dep, existing]);
  const next = { ...existing, dependencies: [{ id: "dep", versionRange: "^1.0.0" }] };
  const r = checkCompatibility({ manifest: m, entry: next, existingEntryId: "mod" });
  assert.ok(r.compatible);
});
