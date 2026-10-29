/**
 * THE LIVE SUITE'S S1 SCENARIO S1-B03-HOSTILE-REAL — moved here, byte for byte, from the
 * hermetic family file `test/s1-scenarios/b03.test.ts` (decision
 * TEST-CONFINEMENT-SELF-BIND). It needs a REAL supplementary group: its
 * foreign-owner fixture is `chownSync(<config>, uid, <another group of this
 * user>)`, and a test run whose checkout is read-only runs in an unprivileged
 * user namespace that can map only the user's own group, so that chown is
 * EINVAL there. The live suite is unconfined by design (real host facts) and
 * runs in CI's engine job (`npm run test:live:s1`). The S1 registry discovers
 * it here (`test/s1-scenarios-registry.test.ts`).
 */
import assert from "node:assert/strict";
import { chownSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { makeRuntimeCandidate, removeOwnedTemporaryDirectories, invoke, errorCode } from "../test/support/s1-scenario-shared.ts";

const scenarios: Readonly<Record<string, () => void | Promise<void>>> = {
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
