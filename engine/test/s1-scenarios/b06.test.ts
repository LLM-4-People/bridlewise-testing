import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { canonicalHash } from "../../src/kernel/integrity.ts";
import { createPreflightContext } from "../../src/kernel/preflight.ts";
import { makeRuntimeCandidate, removeOwnedTemporaryDirectories } from "../support/s1-scenario-shared.ts";

const scenarios: Readonly<Record<string, () => void | Promise<void>>> = {
  "S1-B06-CONTROL": () => {
    const receipt = createPreflightContext().receipt;
    assert.equal(receipt.stage, "s1-preflight-only");
    assert.equal(receipt.harnessReady, false);
    assert.equal(receipt.trust.claim, "integrity-only-not-authenticity");
    assert.equal(receipt.trust.authenticityEstablished, false);
    assert.equal(receipt.trust.trustedBootstrapVerifier.available, false);
    assert.equal(receipt.trust.trustedBootstrapVerifier.status, "trusted_bootstrap_verifier_unavailable");
    assert.equal(receipt.capabilities.every((entry) => entry.effectAuthorized === false), true);
  },
  "S1-B06-FAILURE": () => {
    const receipt = createPreflightContext().receipt;
    const { integrityHash, ...unsigned } = receipt;
    assert.equal(canonicalHash(unsigned), integrityHash);
    const forged = { ...unsigned, harnessReady: true };
    assert.notEqual(canonicalHash(forged), integrityHash);
    assert.equal(receipt.capabilities.find((entry) => entry.capability === "repositoryMutation")?.decision, "deny");
  },
  "S1-B06-HOSTILE-REAL": () => {
    const root = makeRuntimeCandidate();
    const probe = join(root, "package-probe.mjs");
    writeFileSync(probe, 'const target=process.argv[2]; import(target).then(m=>console.log(Object.keys(m).sort().join(",")));\n');
    const publicImport = spawnSync(process.execPath, [probe, "bridlewise"], { cwd: root, encoding: "utf8" });
    assert.equal(publicImport.status, 0, publicImport.stderr);
    assert.equal(publicImport.stdout.trim(), "runCli");
    for (const subpath of [
      "bridlewise/store",
      "bridlewise/path-capability",
      "bridlewise/preflight",
      "bridlewise/bootstrap-permissions",
    ]) {
      const denied = spawnSync(process.execPath, [probe, subpath], { cwd: root, encoding: "utf8" });
      assert.notEqual(denied.status, 0, `${subpath} unexpectedly importable through package exports`);
    }
  },
};

for (const scenarioId of Object.keys(scenarios).toSorted()) {
  test(scenarioId, scenarios[scenarioId]!);
}

test.afterEach(removeOwnedTemporaryDirectories);
test.after(removeOwnedTemporaryDirectories);
