import assert from "node:assert/strict";
import { chownSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { SecurityError } from "../../src/kernel/errors.ts";
import { createPreflightContext, isIssuedPreflightContext } from "../../src/kernel/preflight.ts";
import { makeRuntimeCandidate, removeOwnedTemporaryDirectories, invoke, errorCode } from "../support/s1-scenario-shared.ts";

const scenarios: Readonly<Record<string, () => void | Promise<void>>> = {
  "S1-B03-CONTROL": () => {
    const context = createPreflightContext();
    assert.equal(context.receipt.principal.uid, process.getuid!());
    assert.equal(context.receipt.principal.gid, process.getgid!());
    assert.equal(context.receipt.principal.authentication, "local-os-effective-user");
    assert.equal(context.receipt.project.ownerUid, process.getuid!());
    assert.equal(context.receipt.project.ownerGid, process.getgid!());
    assert.equal(isIssuedPreflightContext(context), true);
  },
  "S1-B03-FAILURE": async () => {
    const genuine = createPreflightContext();
    const forged = Object.freeze({
      ...genuine,
      receipt: { ...genuine.receipt, principal: { ...genuine.receipt.principal, id: "forged" } },
    });
    assert.equal(isIssuedPreflightContext(forged), false);
    assert.equal(isIssuedPreflightContext({ inspectPath: genuine.inspectPath }), false);
    const module = await import("../../src/kernel/preflight.ts");
    assert.equal(Object.keys(module).some((name) =>
      name === "issue" || /authority|grant|token/iu.test(name)
    ), false);
    const getuid = process.getuid!;
    Object.defineProperty(process, "getuid", { configurable: true, value: () => getuid() + 1 });
    try {
      assert.throws(
        () => createPreflightContext(),
        (error: unknown) => error instanceof SecurityError && error.code === "project_owner_mismatch",
      );
    } finally {
      Object.defineProperty(process, "getuid", { configurable: true, value: getuid });
    }
  },
  "S1-B03-HOSTILE-REAL": () => {
    const root = makeRuntimeCandidate();
    const foreignGroup = process.getgroups!().find((group) => group !== process.getgid!());
    assert.notEqual(foreignGroup, undefined, "principal mismatch fixture requires a supplementary group");
    chownSync(join(root, "bridlewise.config.json"), process.getuid!(), foreignGroup!);
    const result = invoke(root);
    assert.equal(errorCode(result), "principal_authentication_failed");
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, new RegExp(root));
  },
};

for (const scenarioId of Object.keys(scenarios).toSorted()) {
  test(scenarioId, scenarios[scenarioId]!);
}

test.afterEach(removeOwnedTemporaryDirectories);
test.after(removeOwnedTemporaryDirectories);
