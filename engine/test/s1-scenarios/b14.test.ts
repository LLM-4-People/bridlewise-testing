import assert from "node:assert/strict";
import test from "node:test";
import { verifyS1Structure } from "../../scripts/tooling/s1-verification.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { makeRuntimeCandidate, removeOwnedTemporaryDirectories, mutateCandidateTextExact } from "../support/s1-scenario-shared.ts";

const scenarios: Readonly<Record<string, () => void | Promise<void>>> = {
  "S1-B14-CONTROL": () => {
    const policy = ROOT_POLICY.universalPolicyArchitecture.missingCapabilityPolicy;
    assert.equal(policy.silentSubstitutionAllowed, false);
    assert.equal(policy.fallback,
      "forbidden-unless-prequalified-equivalent-for-exact-task-with-evidence");
    assert.equal(policy.equivalenceRegistryAvailable, false);
  },
  "S1-B14-FAILURE": () => {
    const root = makeRuntimeCandidate();
    mutateCandidateTextExact(root, ROOT_POLICY.sourcePath,
      "silentSubstitutionAllowed: false",
      "silentSubstitutionAllowed: true",
      "B14 silent-substitution mutant",
    );
    assert.ok(verifyS1Structure(root).violations.includes("universal-policy-root-source"));
  },
  "S1-B14-HOSTILE-REAL": () => {
    const root = makeRuntimeCandidate();
    mutateCandidateTextExact(root, ROOT_POLICY.sourcePath,
      "forbidden-unless-prequalified-equivalent-for-exact-task-with-evidence",
      "allowed-when-primary-is-unavailable",
      "B14 fallback mutant",
    );
    assert.ok(verifyS1Structure(root).violations.includes("universal-policy-root-source"));
  },
};

for (const scenarioId of Object.keys(scenarios).toSorted()) {
  test(scenarioId, scenarios[scenarioId]!);
}

test.afterEach(removeOwnedTemporaryDirectories);
test.after(removeOwnedTemporaryDirectories);
