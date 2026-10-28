import assert from "node:assert/strict";
import test from "node:test";

import { compareModuleRegistrations, generateModuleRegistrarReport } from "../../src/workflow/module-registrar.ts";
import { architectureSourcePaths } from "../../scripts/verification/architecture.ts";

/**
 * INVARIANT #56 (RES-12): the registrar reads the census ONCE and passes it
 * to the comparison, which must NOT re-walk the tree when a census is given.
 * A sentinel census proves it: a decision whose path is not in the given
 * census drifts, whatever the disk holds.
 */

const ROOT = process.cwd();

test("ModuleRegistrar scan: compareModuleRegistrations judges the given census (does not re-walk)", () => {
  const sentinel = "src/__sentinel_does_not_exist__.ts";
  const drift = compareModuleRegistrations(ROOT, { defaults: [], entries: [{ path: sentinel, owner: "sentinel" }] }, []);
  assert.deepEqual(drift.map((module) => module.path), [sentinel], "a decision outside the given (empty) census drifts: the census given was used");
});

test("ModuleRegistrar scan: the report's census is exactly one census of the tree", () => {
  const report = generateModuleRegistrarReport(ROOT);
  assert.equal(report.totalSourceModules, architectureSourcePaths(ROOT).length);
  assert.equal(report.driftedModules, 0, "real project must have zero drift");
});
