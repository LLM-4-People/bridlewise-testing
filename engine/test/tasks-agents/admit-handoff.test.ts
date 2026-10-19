import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { getConfigDocumentSchema } from "../../src/kernel/config-contracts.ts";
import {
  createHandoffProtocol,
  parseHandoffProtocolManifest,
  type HandoffProtocol,
} from "../../src/modules/tasks-agents/domain/handoff-contracts.ts";
import {
  admitHandoff,
  inspectHandoffDecision,
} from "../../src/modules/tasks-agents/application/admit-handoff.ts";

const CONFIG_DOCUMENT_SCHEMA = getConfigDocumentSchema();

const MANIFEST = parseHandoffProtocolManifest(
  JSON.parse(readFileSync("traceability/canonical/handoff-protocol-manifest.json", "utf8")) as unknown,
);
const CONFIG = CONFIG_DOCUMENT_SCHEMA.parse(JSON.parse(readFileSync("bridlewise.config.json", "utf8")));
const PROTOCOL: HandoffProtocol = createHandoffProtocol(MANIFEST, CONFIG);

// ---------------------------------------------------------------------------
// admitHandoff — never issues admission/effect/delivery authority (foundation)
// ---------------------------------------------------------------------------

test("admit-handoff: empty candidates are rejected with contract-invalid reasons", () => {
  const decision = admitHandoff({}, {}, {}, PROTOCOL);
  assert.equal(decision.outcome, "rejected");
  assert.ok(decision.reasonCodes.includes("assignment-contract-invalid"));
  assert.ok(decision.reasonCodes.includes("proposal-contract-invalid"));
  assert.ok(decision.reasonCodes.includes("admission-context-invalid"));
});

test("admit-handoff: Proxy candidates produce three structural rejections", () => {
  const decision = admitHandoff(new Proxy({}, {}), new Proxy({}, {}), new Proxy({}, {}), PROTOCOL);
  assert.equal(decision.outcome, "rejected");
  assert.equal(decision.structuralRejections.length, 3);
});

test("admit-handoff: the decision never carries admission, effect, or delivery authority", () => {
  const decision = admitHandoff({}, {}, {}, PROTOCOL);
  assert.equal(decision.admissionCapability, "unavailable");
  assert.equal(decision.effectAuthorization, "unavailable");
  assert.equal(decision.deliveryAuthorization, "unavailable");
});

test("admit-handoff: the decision featurePolicyDisposition matches the authority", () => {
  const decision = admitHandoff({}, {}, {}, PROTOCOL);
  assert.equal(decision.featurePolicyDisposition, PROTOCOL.featurePolicyDisposition);
});

test("admit-handoff: the decision protocolIdentity matches the protocol", () => {
  const decision = admitHandoff({}, {}, {}, PROTOCOL);
  assert.equal(decision.protocolIdentity, PROTOCOL.protocolIdentity);
});

test("admit-handoff: invariantResults cover the full invariant order", () => {
  const decision = admitHandoff({}, {}, {}, PROTOCOL);
  assert.equal(decision.invariantResults.length, PROTOCOL.authority.invariantOrder.length);
  const ids = decision.invariantResults.map((r) => r.invariantId);
  assert.deepEqual(ids, [...PROTOCOL.authority.invariantOrder]);
});

test("admit-handoff: every invariantResult disposition is satisfied/failed/unassessed", () => {
  const decision = admitHandoff({}, {}, {}, PROTOCOL);
  for (const result of decision.invariantResults) {
    assert.ok(result.disposition === "satisfied" || result.disposition === "failed" || result.disposition === "unassessed");
  }
});

test("admit-handoff: the decision is frozen", () => {
  const decision = admitHandoff({}, {}, {}, PROTOCOL);
  assert.ok(Object.isFrozen(decision));
});

test("admit-handoff: assignment/proposal/context candidate identities are present even on rejection", () => {
  const decision = admitHandoff({}, {}, {}, PROTOCOL);
  assert.match(decision.assignmentCandidateIdentity!, /^[0-9a-f]{64}$/u);
  assert.match(decision.proposalCandidateIdentity!, /^[0-9a-f]{64}$/u);
  assert.match(decision.contextIdentity!, /^[0-9a-f]{64}$/u);
});

test("admit-handoff: a rejected decision has null assignment and proposal identities", () => {
  const decision = admitHandoff({}, {}, {}, PROTOCOL);
  assert.equal(decision.assignmentIdentity, null);
  assert.equal(decision.proposalIdentity, null);
});

test("admit-handoff: nominal-authority and feature-policy are unassessed with unavailable reasons", () => {
  const decision = admitHandoff({}, {}, {}, PROTOCOL);
  assert.ok(decision.reasonCodes.includes("feature-policy-unavailable"));
  assert.ok(decision.reasonCodes.includes("nominal-authority-unavailable"));
});

test("admit-handoff: reasonCodes are ordered per the authority reason order", () => {
  const decision = admitHandoff({}, {}, {}, PROTOCOL);
  const order = PROTOCOL.authority.reasonOrder;
  const indices = decision.reasonCodes.map((code) => (order as readonly string[]).indexOf(code));
  // The reasonCodes must appear in the same relative order as the authority catalog.
  for (let i = 1; i < indices.length; i += 1) {
    assert.ok(indices[i]! > indices[i - 1]!, `reasonCodes not ordered at ${i}: ${decision.reasonCodes.join(",")}`);
  }
});

// ---------------------------------------------------------------------------
// inspectHandoffDecision — untrusted inspector
// ---------------------------------------------------------------------------

test("admit-handoff: inspectHandoffDecision returns null for a non-object", () => {
  assert.equal(inspectHandoffDecision("nope", PROTOCOL), null);
  assert.equal(inspectHandoffDecision(null, PROTOCOL), null);
});

test("admit-handoff: inspectHandoffDecision returns null for a wrong-shape object", () => {
  assert.equal(inspectHandoffDecision({ bogus: true }, PROTOCOL), null);
});

test("admit-handoff: inspectHandoffDecision returns null for a Proxy", () => {
  assert.equal(inspectHandoffDecision(new Proxy({}, {}), PROTOCOL), null);
});

test("admit-handoff: inspectHandoffDecision does not accept an unissued decision identity", () => {
  // A hand-built decision object with a fabricated decisionIdentity must not be accepted.
  const fake = {
    schemaVersion: PROTOCOL.authority.contractSchemaVersions.decision,
    protocolIdentity: PROTOCOL.protocolIdentity,
    assignmentCandidateIdentity: "0".repeat(64),
    assignmentIdentity: null,
    proposalCandidateIdentity: "0".repeat(64),
    proposalIdentity: null,
    contextIdentity: "0".repeat(64),
    outcome: "rejected",
    reasonCodes: [],
    invariantResults: [],
    structuralRejections: [],
    featurePolicyDisposition: PROTOCOL.featurePolicyDisposition,
    admissionCapability: "unavailable",
    effectAuthorization: "unavailable",
    deliveryAuthorization: "unavailable",
    decisionIdentity: "1".repeat(64),
  };
  assert.equal(inspectHandoffDecision(fake, PROTOCOL), null);
});
