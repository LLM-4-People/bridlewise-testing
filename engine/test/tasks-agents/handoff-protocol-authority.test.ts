import assert from "node:assert/strict";
import test from "node:test";

import { HANDOFF_PROTOCOL_AUTHORITY, recomputeSemanticOwnerPins } from "../../src/modules/tasks-agents/domain/handoff-protocol-authority.ts";

const AUTHORITY = HANDOFF_PROTOCOL_AUTHORITY;

// ---------------------------------------------------------------------------
// Frozen / shape
// ---------------------------------------------------------------------------

test("handoff-authority: HANDOFF_PROTOCOL_AUTHORITY is frozen", () => {
  assert.ok(Object.isFrozen(AUTHORITY));
});

test("handoff-authority: manifestSchemaVersion is v1", () => {
  assert.equal(AUTHORITY.manifestSchemaVersion, "bridlewise-handoff-protocol-manifest/v1");
});

test("handoff-authority: currentProtocolVersion is 3", () => {
  assert.equal(AUTHORITY.currentProtocolVersion, 3);
});

test("handoff-authority: featurePolicyDisposition is capability-unavailable", () => {
  assert.equal(AUTHORITY.featurePolicyDisposition, "capability-unavailable");
});

// ---------------------------------------------------------------------------
// contractSchemaVersions + identityDomains
// ---------------------------------------------------------------------------

test("handoff-authority: contractSchemaVersions cover assignment/proposal/admissionContext/decision at v3", () => {
  assert.equal(AUTHORITY.contractSchemaVersions.assignment, "bridlewise-handoff-assignment/v3");
  assert.equal(AUTHORITY.contractSchemaVersions.proposal, "bridlewise-handoff-proposal/v3");
  assert.equal(AUTHORITY.contractSchemaVersions.admissionContext, "bridlewise-handoff-admission-context/v3");
  assert.equal(AUTHORITY.contractSchemaVersions.decision, "bridlewise-handoff-decision/v3");
});

test("handoff-authority: identityDomains cover all six domain identities", () => {
  const domains = AUTHORITY.identityDomains;
  assert.equal(domains.assignment, "bridlewise/handoff/assignment/v3");
  assert.equal(domains.assignmentCandidate, "bridlewise/handoff/assignment-candidate/v3");
  assert.equal(domains.proposal, "bridlewise/handoff/proposal/v3");
  assert.equal(domains.proposalCandidate, "bridlewise/handoff/proposal-candidate/v3");
  assert.equal(domains.admissionContext, "bridlewise/handoff/admission-context/v3");
  assert.equal(domains.decision, "bridlewise/handoff/decision/v3");
});

// ---------------------------------------------------------------------------
// invariantOrder + reasonOrder
// ---------------------------------------------------------------------------

test("handoff-authority: invariantOrder is non-empty and has no duplicates", () => {
  assert.ok(AUTHORITY.invariantOrder.length > 0);
  assert.equal(new Set(AUTHORITY.invariantOrder).size, AUTHORITY.invariantOrder.length);
});

test("handoff-authority: reasonOrder is non-empty and has no duplicates", () => {
  assert.ok(AUTHORITY.reasonOrder.length > 0);
  assert.equal(new Set(AUTHORITY.reasonOrder).size, AUTHORITY.reasonOrder.length);
});

test("handoff-authority: invariantOrder and reasonOrder are disjoint vocabularies", () => {
  // Invariant ids and reason codes occupy separate namespaces by convention.
  const invariants = new Set(AUTHORITY.invariantOrder);
  const reasons = new Set(AUTHORITY.reasonOrder);
  for (const r of reasons) assert.ok(!(invariants as Set<string>).has(r), `reason '${r}' must not be an invariant id`);
});

test("handoff-authority: invariantOrder includes the core structural invariants first", () => {
  const order = AUTHORITY.invariantOrder;
  assert.equal(order[0], "assignment-structure");
  assert.equal(order[1], "proposal-structure");
  assert.equal(order[2], "context-structure");
});

test("handoff-authority: invariantOrder ends with the nominal-authority invariant", () => {
  assert.equal(AUTHORITY.invariantOrder[AUTHORITY.invariantOrder.length - 1], "nominal-authority");
});

test("handoff-authority: reasonOrder begins with observer-advisory-only", () => {
  assert.equal(AUTHORITY.reasonOrder[0], "observer-advisory-only");
});

// ---------------------------------------------------------------------------
// configKeyReferences
// ---------------------------------------------------------------------------

test("handoff-authority: configKeyReferences declare purpose/owner/path/availability", () => {
  for (const ref of AUTHORITY.configKeyReferences) {
    assert.ok(typeof ref.purpose === "string" && ref.purpose.length > 0);
    assert.ok(typeof ref.owner === "string");
    assert.ok(typeof ref.path === "string" && ref.path.length > 0);
    assert.ok(ref.availability === "required" || ref.availability === "required-absent");
  }
});

test("handoff-authority: configKeyReferences include the identifier-maximum and feature-policy keys", () => {
  const purposes = AUTHORITY.configKeyReferences.map((r) => r.purpose);
  assert.ok(purposes.includes("identifier-maximum"));
  assert.ok(purposes.includes("handoff-feature-policy"));
  const featurePolicy = AUTHORITY.configKeyReferences.find((r) => r.purpose === "handoff-feature-policy")!;
  assert.equal(featurePolicy.availability, "required-absent");
});

// ---------------------------------------------------------------------------
// semanticOwners — conformance between the authority and the actual files
// ---------------------------------------------------------------------------

test("handoff-authority: semanticOwners is non-empty and frozen", () => {
  assert.ok(AUTHORITY.semanticOwners.length > 0);
  assert.ok(Object.isFrozen(AUTHORITY.semanticOwners));
});

test("handoff-authority: every semanticOwner path matches its recorded byteLength and sha256", () => {
  // The recorded pins are fold-sensitive byte measurements of the named source
  // files. Recompute them from the CURRENT tree via the owner's regeneration
  // path and require the recorded authority to match — a stale pin (a fold
  // that moved or re-touched a semantic owner) fails here, and re-deriving is
  // one call to the same function, never a hand-edit.
  const recomputed = recomputeSemanticOwnerPins(process.cwd());
  const recordedByPath: ReadonlyMap<string, (typeof AUTHORITY.semanticOwners)[number]> =
    new Map(AUTHORITY.semanticOwners.map((o) => [o.path as string, o] as const));
  for (const fresh of recomputed) {
    const recorded = recordedByPath.get(fresh.path);
    assert.ok(recorded !== undefined, `no recorded pin for ${fresh.path}`);
    assert.equal(
      recorded.byteLength,
      fresh.byteLength,
      `byteLength mismatch for ${fresh.path}: recorded ${recorded.byteLength}, current ${fresh.byteLength} ` +
        `(re-derive with recomputeSemanticOwnerPins at the authority owner)`,
    );
    assert.equal(
      recorded.sha256,
      fresh.sha256,
      `sha256 mismatch for ${fresh.path} (re-derive with recomputeSemanticOwnerPins)`,
    );
  }
});

test("handoff-authority: semanticOwner roles are unique", () => {
  const roles = AUTHORITY.semanticOwners.map((o) => o.role);
  assert.equal(new Set(roles).size, roles.length);
});

test("handoff-authority: semanticOwner paths are unique", () => {
  const paths = AUTHORITY.semanticOwners.map((o) => o.path);
  assert.equal(new Set(paths).size, paths.length);
});

test("handoff-authority: the handoff-domain-owner is src/modules/tasks-agents/domain/handoff-contracts.ts", () => {
  const owner = AUTHORITY.semanticOwners.find((o) => o.role === "handoff-domain-owner");
  assert.ok(owner);
  assert.equal(owner!.path, "src/modules/tasks-agents/domain/handoff-contracts.ts");
});

test("handoff-authority: every semanticOwner sha256 is a 64-char hex digest", () => {
  for (const owner of AUTHORITY.semanticOwners) {
    assert.match(owner.sha256, /^[0-9a-f]{64}$/u);
  }
});
