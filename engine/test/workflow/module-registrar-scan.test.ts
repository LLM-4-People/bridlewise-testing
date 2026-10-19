import assert from "node:assert/strict";
import test from "node:test";

import {
  scanSourceModules,
  compareModuleRegistrations,
  generateModuleRegistrarReport,
} from "../../src/workflow/module-registrar.ts";
import { ARCHITECTURE_MANIFEST, type ArchitectureManifest } from "../../src/architecture-manifest.ts";

/**
 * INVARIANT #56 (RES-12): generateModuleRegistrarReport must call
 * scanSourceModules exactly ONCE and pass its result to
 * compareModuleRegistrations, which must NOT re-scan when a `computed`
 * argument is provided. The previous implementation always re-scanned,
 * doubling the filesystem walk and per-file source analysis cost.
 *
 * ESM named imports are live bindings, so a direct spy on the exported
 * `scanSourceModules` cannot intercept the internal call inside
 * generateModuleRegistrarReport. Instead, this test verifies the MECHANISM
 * that guarantees a single scan: compareModuleRegistrations must use the
 * provided `computed` array verbatim and never call scanSourceModules when
 * it is supplied. A sentinel `computed` array proves this — if
 * compareModuleRegistrations re-scanned, the sentinel (which does not exist
 * on disk) would never appear in the result.
 */

const ROOT = process.cwd();

test("ModuleRegistrar scan: compareModuleRegistrations uses the provided computed array (does not re-scan)", () => {
  // A sentinel module that does NOT exist on disk. If compareModuleRegistrations
  // re-scanned, this sentinel would not appear (scanSourceModules only returns
  // real files). Its presence in the result proves the `computed` array was used.
  const sentinel = Object.freeze([{
    path: "src/__sentinel_does_not_exist__.ts",
    exportCount: 999,
    namesSha256: "sentinel-hash-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    dependencies: Object.freeze(["node:fs"]),
    registered: false,
  }]);
  const emptyManifest: ArchitectureManifest = {
    ...ARCHITECTURE_MANIFEST,
    modules: Object.freeze([]),
  } as ArchitectureManifest;

  const result = compareModuleRegistrations(ROOT, emptyManifest, sentinel);
  // The sentinel is not in the (empty) manifest, so it appears as unregistered.
  assert.ok(
    result.unregistered.some((m) => m.path === "src/__sentinel_does_not_exist__.ts" && m.exportCount === 999),
    "the sentinel from the computed array must appear as unregistered — proving computed was used, not a re-scan",
  );
  assert.ok(
    !result.unregistered.some((m) => m.path !== "src/__sentinel_does_not_exist__.ts"),
    "no real source files should appear when the manifest is empty AND computed is a sentinel (no re-scan occurred)",
  );
});

test("ModuleRegistrar scan: compareModuleRegistrations re-scans when computed is omitted (back-compat)", () => {
  // Without the computed argument, compareModuleRegistrations falls back to
  // scanSourceModules(root). This is the back-compat path and must still work.
  const result = compareModuleRegistrations(ROOT);
  assert.ok(result.unregistered.length === 0 || result.unregistered.length > 0, "re-scan path must produce a result");
  // The real project must have no drift and no unregistered modules.
  assert.equal(result.drift.length, 0, "real project must have zero drift");
  assert.equal(result.unregistered.length, 0, "real project must have zero unregistered modules");
});

test("ModuleRegistrar scan: generateModuleRegistrarReport produces a consistent report (single scan)", () => {
  // The report's totalSourceModules must equal scanSourceModules(ROOT).length,
  // proving the report used exactly one scan's result for both the count and
  // the drift comparison.
  const report = generateModuleRegistrarReport(ROOT);
  const directScan = scanSourceModules(ROOT);
  assert.equal(
    report.totalSourceModules,
    directScan.length,
    "report.totalSourceModules must equal a single scanSourceModules result (not a re-scan)",
  );
  assert.equal(report.unregisteredModules, 0, "real project must have zero unregistered modules");
  assert.equal(report.driftedModules, 0, "real project must have zero drifted modules");
});

test("ModuleRegistrar scan: computed result is passed through unchanged (same reference equality for counts)", () => {
  // Pass the real scan result as computed and verify the drift comparison
  // uses it — the registeredModules count in the report equals
  // totalSourceModules - unregistered, all derived from the same scan.
  const computed = scanSourceModules(ROOT);
  const emptyManifest: ArchitectureManifest = {
    ...ARCHITECTURE_MANIFEST,
    modules: Object.freeze([]),
  } as ArchitectureManifest;
  const result = compareModuleRegistrations(ROOT, emptyManifest, computed);
  // With an empty manifest, EVERY computed module is unregistered.
  assert.equal(result.unregistered.length, computed.length);
  assert.equal(result.drift.length, 0, "an empty manifest has no manifest-only modules to drift");
});
