import assert from "node:assert/strict";
import test from "node:test";
import { verifyS1Structure } from "../../scripts/tooling/s1-verification.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { makeRuntimeCandidate, removeOwnedTemporaryDirectories, mutateCandidateTextExact } from "../support/s1-scenario-shared.ts";

const scenarios: Readonly<Record<string, () => void | Promise<void>>> = {
  "S1-B16-CONTROL": () => {
    const policy = ROOT_POLICY.universalPolicyArchitecture.agentOrchestraArchitecture;
    assert.equal(policy.authority, "single-versioned-declarative-agent-profile-registry");
    assert.equal(policy.hiddenSideChannelsAllowed, false);
    assert.equal(policy.expectedOutput, "schema-and-expected-result-validation-before-merge-or-use");
    assert.equal(policy.available, false);
    assert.equal(ROOT_POLICY.steeringContinuityArchitecture.observers.effectOrMutationAuthorityAllowed, false);
    assert.equal(ROOT_POLICY.steeringContinuityArchitecture.observers.privateMemoryOrDirectPeerChannelAllowed, false);
  },
  "S1-B16-FAILURE": () => {
    const root = makeRuntimeCandidate();
    mutateCandidateTextExact(root, ROOT_POLICY.sourcePath,
      "hiddenSideChannelsAllowed: false",
      "hiddenSideChannelsAllowed: true",
      "B16 hidden-side-channel mutant",
    );
    assert.ok(verifyS1Structure(root).violations.includes("universal-policy-root-source"));
  },
  "S1-B16-HOSTILE-REAL": () => {
    const root = makeRuntimeCandidate();
    mutateCandidateTextExact(root, ROOT_POLICY.sourcePath,
      "effectOrMutationAuthorityAllowed: false",
      "effectOrMutationAuthorityAllowed: true",
      "B16 observer-effect-authority mutant",
    );
    assert.ok(verifyS1Structure(root).violations.includes("steering-continuity-root-source"));

    const outputRoot = makeRuntimeCandidate();
    mutateCandidateTextExact(outputRoot, ROOT_POLICY.sourcePath,
      "schema-and-expected-result-validation-before-merge-or-use",
      "accept-unvalidated-output-and-merge",
      "B16 unvalidated-output mutant",
    );
    assert.ok(verifyS1Structure(outputRoot).violations.includes("universal-policy-root-source"));
  },
};

for (const scenarioId of Object.keys(scenarios).toSorted()) {
  test(scenarioId, scenarios[scenarioId]!);
}

test.afterEach(removeOwnedTemporaryDirectories);
test.after(removeOwnedTemporaryDirectories);
