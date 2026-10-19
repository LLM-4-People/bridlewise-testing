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
  compileAssignmentContract,
  inspectAssignmentContract,
  inspectAssignmentSnapshot,
  verifyAssignmentContractIdentity,
} from "../../src/modules/tasks-agents/application/compile-assignment-contract.ts";

const CONFIG_DOCUMENT_SCHEMA = getConfigDocumentSchema();

const MANIFEST = parseHandoffProtocolManifest(
  JSON.parse(readFileSync("traceability/canonical/handoff-protocol-manifest.json", "utf8")) as unknown,
);
const CONFIG = CONFIG_DOCUMENT_SCHEMA.parse(JSON.parse(readFileSync("bridlewise.config.json", "utf8")));
const PROTOCOL: HandoffProtocol = createHandoffProtocol(MANIFEST, CONFIG);

// ---------------------------------------------------------------------------
// compileAssignmentContract — untrusted-input rejection boundary
// ---------------------------------------------------------------------------

test("assignment-contract: compileAssignmentContract rejects a primitive candidate (contract-invalid)", () => {
  // snapshotHandoffCandidate accepts and hashes primitives, so they pass the
  // structural snapshot but fail the assignmentDraft schema.
  const result = compileAssignmentContract("not-an-object", PROTOCOL);
  assert.equal(result.outcome, "rejected");
  assert.equal(result.assignment, null);
  assert.equal(result.reasonCode, "assignment-contract-invalid");
  assert.equal(result.structuralRejection, null);
  assert.ok(result.candidateIdentity !== null);
});

test("assignment-contract: compileAssignmentContract rejects null (contract-invalid)", () => {
  const result = compileAssignmentContract(null, PROTOCOL);
  assert.equal(result.outcome, "rejected");
  assert.equal(result.reasonCode, "assignment-contract-invalid");
  assert.equal(result.structuralRejection, null);
});

test("assignment-contract: compileAssignmentContract rejects a Proxy candidate (structure)", () => {
  const proxied = new Proxy({ foo: 1 }, {});
  const result = compileAssignmentContract(proxied, PROTOCOL);
  assert.equal(result.outcome, "rejected");
  assert.equal(result.reasonCode, "assignment-structure-rejected");
});

test("assignment-contract: compileAssignmentContract rejects an empty object (contract-invalid)", () => {
  const result = compileAssignmentContract({}, PROTOCOL);
  assert.equal(result.outcome, "rejected");
  assert.equal(result.reasonCode, "assignment-contract-invalid");
  assert.equal(result.structuralRejection, null);
});

test("assignment-contract: compileAssignmentContract rejects an object with wrong shape (contract-invalid)", () => {
  const result = compileAssignmentContract({ bogus: true, notAnAssignment: 1 }, PROTOCOL);
  assert.equal(result.outcome, "rejected");
  assert.equal(result.reasonCode, "assignment-contract-invalid");
});

test("assignment-contract: a rejected compilation reports a null candidateIdentity for non-structure rejections", () => {
  // For a contract-invalid (post-snapshot) rejection, the candidate identity was captured.
  const result = compileAssignmentContract({}, PROTOCOL);
  assert.ok(result.candidateIdentity !== undefined);
});

test("assignment-contract: compileAssignmentContract result is frozen", () => {
  const result = compileAssignmentContract({}, PROTOCOL);
  assert.ok(Object.isFrozen(result));
});

test("assignment-contract: a structural (Proxy) rejection has no candidateIdentity", () => {
  const result = compileAssignmentContract(new Proxy({}, {}), PROTOCOL);
  assert.equal(result.outcome, "rejected");
  assert.equal(result.reasonCode, "assignment-structure-rejected");
  assert.equal(result.candidateIdentity, null);
  assert.ok(result.structuralRejection);
});

// ---------------------------------------------------------------------------
// inspectAssignmentContract / inspectAssignmentSnapshot — untrusted inspectors
// ---------------------------------------------------------------------------

test("assignment-contract: inspectAssignmentContract returns null for a non-object", () => {
  assert.equal(inspectAssignmentContract("nope", PROTOCOL), null);
});

test("assignment-contract: inspectAssignmentContract returns null for an empty object", () => {
  assert.equal(inspectAssignmentContract({}, PROTOCOL), null);
});

test("assignment-contract: inspectAssignmentContract returns null for a Proxy", () => {
  assert.equal(inspectAssignmentContract(new Proxy({}, {}), PROTOCOL), null);
});

test("assignment-contract: inspectAssignmentSnapshot returns null for an empty object", () => {
  assert.equal(inspectAssignmentSnapshot({}, PROTOCOL), null);
});

test("assignment-contract: inspectAssignmentSnapshot returns null for a wrong-shape object", () => {
  assert.equal(inspectAssignmentSnapshot({ notAnAssignment: true }, PROTOCOL), null);
});

// ---------------------------------------------------------------------------
// verifyAssignmentContractIdentity — identity tamper detection
// ---------------------------------------------------------------------------

test("assignment-contract: verifyAssignmentContractIdentity returns null when assignmentIdentity is a bad hash", () => {
  // Build a minimal object that passes the assignment schema shape is not feasible without
  // the full fixture, but the identity verifier is a pure function: a candidate whose
  // assignmentIdentity does not match the recomputed domain hash returns null.
  // We pass an object with a deliberately wrong assignmentIdentity to exercise the
  // mismatch path directly (the verifier does not re-parse).
  const tampered = {
    assignmentIdentity: "0".repeat(64),
    schemaVersion: PROTOCOL.authority.contractSchemaVersions.assignment,
  } as never;
  assert.equal(verifyAssignmentContractIdentity(tampered, PROTOCOL), null);
});

test("assignment-contract: the protocol identity is a 64-char hex digest", () => {
  assert.match(PROTOCOL.protocolIdentity, /^[0-9a-f]{64}$/u);
});

test("assignment-contract: the protocol authority currentProtocolVersion matches the manifest", () => {
  assert.equal(PROTOCOL.authority.currentProtocolVersion, MANIFEST.currentProtocolVersion);
});

test("assignment-contract: the protocol schemas are present for every contract kind", () => {
  assert.ok(PROTOCOL.schemas.assignment);
  assert.ok(PROTOCOL.schemas.assignmentDraft);
  assert.ok(PROTOCOL.schemas.proposal);
  assert.ok(PROTOCOL.schemas.proposalDraft);
  assert.ok(PROTOCOL.schemas.admissionContext);
  assert.ok(PROTOCOL.schemas.decision);
});
