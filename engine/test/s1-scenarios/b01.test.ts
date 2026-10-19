import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { makeRuntimeCandidate, removeOwnedTemporaryDirectories, invoke, errorCode, writeConfig, config, activeRootPolicyProjection } from "../support/s1-scenario-shared.ts";

const scenarios: Readonly<Record<string, () => void | Promise<void>>> = {
  "S1-B01-CONTROL": () => {
    assert.ok(Object.isFrozen(ROOT_POLICY));
    assert.ok(Object.isFrozen(ROOT_POLICY.capabilities));
    const projection = activeRootPolicyProjection();
    const applicableIds = ROOT_POLICY.requirements.applicableIds;
    assert.deepEqual(applicableIds, projection.orderedIds);
    assert.equal(new Set(applicableIds).size, applicableIds.length);
    assert.equal(applicableIds.every((id) => projection.referencedIds.has(id)), true);
    assert.equal([...projection.referencedIds].every((id) => applicableIds.includes(id as never)), true);
    for (const id of ["REQ-024", "REQ-029", "DER-010", "DER-028", "DER-029", "DER-030"] as const) {
      assert.ok(applicableIds.includes(id));
    }
    assert.equal(ROOT_POLICY.capabilities.preflight, true);
    assert.equal(Object.values(ROOT_POLICY.capabilities).filter(Boolean).length, 1);
  },
  "S1-B01-FAILURE": () => {
    const root = makeRuntimeCandidate();
    writeConfig(root, { ...config(), rootPolicy: { modelInvocation: true } });
    assert.equal(errorCode(invoke(root)), "config_schema_invalid");
    writeConfig(root, { ...config(), data: { defaultClassification: "public" } });
    assert.equal(errorCode(invoke(root)), "config_schema_invalid");
  },
  "S1-B01-HOSTILE-REAL": () => {
    const root = makeRuntimeCandidate();
    const marker = join(root, "marker");
    const hostileInvocation = ["--config", join(root, "bridlewise.config.json"), "preflight", marker];
    const validDocument = readFileSync(join(root, "bridlewise.config.json"), "utf8");
    // A hostile document is refused BEFORE any argument is honoured — the
    // self-protection bootstrap reads the configuration first and a refusal
    // there is a refusal, never "proceed unprotected".
    writeConfig(root, { ...config(), capabilities: { repositoryMutation: true, processExecution: true } });
    assert.equal(errorCode(invoke(root, hostileInvocation)), "config_schema_invalid");
    assert.equal(existsSync(marker), false);
    // With a valid document, the alternate-config flag itself is unavailable.
    writeConfig(root, undefined, validDocument);
    assert.equal(errorCode(invoke(root, hostileInvocation)), "command_unavailable");
    assert.equal(existsSync(marker), false);
    assert.equal(ROOT_POLICY.capabilities.repositoryMutation, false);
  },
};

for (const scenarioId of Object.keys(scenarios).toSorted()) {
  test(scenarioId, scenarios[scenarioId]!);
}

test.afterEach(removeOwnedTemporaryDirectories);
test.after(removeOwnedTemporaryDirectories);
