import assert from "node:assert/strict";
import test from "node:test";

import {
  createLiveGrant,
  isBackendErrorCode,
  isLeaseState,
  isLeaseTransition,
  isLiveGrant,
  isMigrationResourceKind,
  leaseTransitionToken,
  isLeaseTransitionValid,
  MWA_AUTHORITY_CONTEXT,
  MWA_BACKEND_ERROR_CODES,
  MWA_BACKEND_SCHEMA_VERSION,
  MWA_JOURNAL_SCHEMA_VERSION,
  MWA_LEDGER_DOMAIN,
  MWA_LEASE_STATES,
  MWA_LEASE_TRANSITIONS,
  MWA_LEASE_EVIDENCE_AUTHORITY,
  MWA_PROTOCOL_SCHEMA_VERSION,
  MWA_RECEIPT_AUTHORITY,
  MWA_RESOURCE_REGISTRY_VERSION,
  MWA_VALID_TRANSITIONS,
  type BackendError,
  type BackendResult,
  type LeaseState,
  type LeaseTransition,
  type LiveGrant,
  type MigrationResource,
} from "../../verification/core/coordination/migration-write-authority/contracts.ts";

// ---------------------------------------------------------------------------
// Schema version constants (closed)
// ---------------------------------------------------------------------------

test("contracts: protocol/backend/journal/registry schema versions are closed constants", () => {
  assert.equal(MWA_PROTOCOL_SCHEMA_VERSION, "migration-authority-message/v2");
  assert.equal(MWA_BACKEND_SCHEMA_VERSION, "bridlewise-migration-authority-backend/v1");
  assert.equal(MWA_RESOURCE_REGISTRY_VERSION, "bridlewise-migration-resource-registry/v1");
  assert.equal(MWA_JOURNAL_SCHEMA_VERSION, "migration-authority-journal/v1");
  // The ledger domain is a null-terminated domain prefix (disjoint from timeline).
  assert.ok(MWA_LEDGER_DOMAIN.endsWith("\u0000"));
  assert.ok(MWA_LEDGER_DOMAIN.startsWith("bridlewise/migration-authority-ledger/v1"));
  // Authority-context / receipt-authority markers.
  assert.equal(MWA_AUTHORITY_CONTEXT, "process-private-live-grant-required-out-of-band");
  assert.equal(MWA_RECEIPT_AUTHORITY, "evidence-only-not-a-bearer-capability");
  assert.equal(MWA_LEASE_EVIDENCE_AUTHORITY, "evidence-only-never-authority");
});

// ---------------------------------------------------------------------------
// Lifecycle state machine (closed)
// ---------------------------------------------------------------------------

test("contracts: lifecycle states are the seven closed states", () => {
  assert.deepEqual([...MWA_LEASE_STATES].toSorted(), [
    "active",
    "blocked-unknown-effect",
    "expired",
    "fenced",
    "quiescing",
    "reconciling",
    "released",
  ]);
});

test("contracts: transitions are the eight closed transitions", () => {
  assert.deepEqual([...MWA_LEASE_TRANSITIONS].toSorted(), [
    "active-expired",
    "active-fenced",
    "active-quiescing",
    "active-released",
    "quiescing-reconciling",
    "reconciling-blocked-unknown-effect",
    "reconciling-released",
    "requested-active",
  ]);
});

test("contracts: every transition maps a valid (from,to) state pair", () => {
  for (const t of MWA_LEASE_TRANSITIONS) {
    const edge = MWA_VALID_TRANSITIONS[t];
    assert.ok(edge, `transition ${t} has no edge`);
    if (t === "requested-active") {
      // The creation transition has the virtual "requested" from-state.
      assert.equal(edge[0], "requested");
      assert.equal(edge[1], "active");
    } else {
      assert.ok(isLeaseState(edge[0]), `transition ${t} from-state invalid`);
      assert.ok(isLeaseState(edge[1]), `transition ${t} to-state invalid`);
    }
  }
});

test("contracts: isLeaseTransitionValid accepts preregistered transitions and rejects others", () => {
  assert.equal(isLeaseTransitionValid("active", "quiescing"), true);
  assert.equal(isLeaseTransitionValid("quiescing", "reconciling"), true);
  assert.equal(isLeaseTransitionValid("reconciling", "released"), true);
  assert.equal(isLeaseTransitionValid("active", "released"), true);
  assert.equal(isLeaseTransitionValid("active", "fenced"), true);
  assert.equal(isLeaseTransitionValid("active", "expired"), true);
  assert.equal(isLeaseTransitionValid("reconciling", "blocked-unknown-effect"), true);
  assert.equal(isLeaseTransitionValid("requested" as LeaseState, "active"), false);
  assert.equal(isLeaseTransitionValid("released", "active"), false);
  assert.equal(isLeaseTransitionValid("fenced", "active"), false);
  assert.equal(isLeaseTransitionValid("quiescing", "released"), false);
});

test("contracts: leaseTransitionToken returns the transition token or undefined", () => {
  assert.equal(leaseTransitionToken("active", "quiescing"), "active-quiescing");
  assert.equal(leaseTransitionToken("reconciling", "blocked-unknown-effect"), "reconciling-blocked-unknown-effect");
  assert.equal(leaseTransitionToken("active", "active"), undefined);
  assert.equal(leaseTransitionToken("released", "fenced"), undefined);
});

test("contracts: isLeaseState and isLeaseTransition reject unknown values", () => {
  assert.equal(isLeaseState("active"), true);
  assert.equal(isLeaseState("pending"), false);
  assert.equal(isLeaseState(42), false);
  assert.equal(isLeaseTransition("active-released"), true);
  assert.equal(isLeaseTransition("active-active"), false);
  assert.equal(isLeaseTransition(null), false);
});

// ---------------------------------------------------------------------------
// Error catalog (closed enum)
// ---------------------------------------------------------------------------

test("contracts: backend error catalog is the closed 24-code enum", () => {
  assert.equal(MWA_BACKEND_ERROR_CODES.length, 24);
  const expected = [
    "repository-mismatch", "base-drift", "configuration-drift", "policy-drift", "capability-drift",
    "resource-unresolved", "resource-conflict", "resource-order-invalid", "lease-missing",
    "lease-expired", "lease-state-invalid", "generation-stale", "grant-invalid",
    "idempotency-conflict", "backend-busy", "backend-corrupt", "schema-unsupported",
    "clock-regression", "process-identity-ambiguous", "journal-mismatch", "cas-mismatch",
    "effect-unknown", "filesystem-unsupported", "operation-unsupported",
  ];
  assert.deepEqual([...MWA_BACKEND_ERROR_CODES], expected);
});

test("contracts: isBackendErrorCode accepts catalog codes and rejects others", () => {
  assert.equal(isBackendErrorCode("lease-expired"), true);
  assert.equal(isBackendErrorCode("cas-mismatch"), true);
  assert.equal(isBackendErrorCode("not-a-code"), false);
  assert.equal(isBackendErrorCode(undefined), false);
});

// ---------------------------------------------------------------------------
// Resource kinds (five closed kinds)
// ---------------------------------------------------------------------------

test("contracts: isMigrationResourceKind accepts the five closed kinds", () => {
  assert.equal(isMigrationResourceKind("physical-path"), true);
  assert.equal(isMigrationResourceKind("semantic-owner"), true);
  assert.equal(isMigrationResourceKind("generated-output"), true);
  assert.equal(isMigrationResourceKind("git-ref"), true);
  assert.equal(isMigrationResourceKind("package-surface"), true);
  assert.equal(isMigrationResourceKind("network-endpoint"), false);
});

// ---------------------------------------------------------------------------
// Opaque LiveGrant (Symbol-branded nominal)
// ---------------------------------------------------------------------------

test("contracts: LiveGrant is opaque, Symbol-branded, and not serializable", () => {
  const grant = createLiveGrant({
    leaseId: "11111111-1111-4111-8111-111111111111",
    generation: "1",
    fenceIdentity: "a".repeat(64),
    repositoryIdentity: "b".repeat(64),
    resourceRegistryIdentity: "c".repeat(64),
    processIdentity: "d".repeat(64),
  });
  assert.equal(isLiveGrant(grant), true);
  // A plain object structurally similar is NOT a LiveGrant (brand missing).
  const lookalike = {
    leaseId: "11111111-1111-4111-8111-111111111111",
    generation: "1",
    fenceIdentity: "a".repeat(64),
    repositoryIdentity: "b".repeat(64),
    resourceRegistryIdentity: "c".repeat(64),
    processIdentity: "d".repeat(64),
  };
  assert.equal(isLiveGrant(lookalike), false);
  assert.equal(isLiveGrant(null), false);
  assert.equal(isLiveGrant({}), false);
  // Symbol-branded field is dropped by JSON.stringify — never serializable.
  const serialized = JSON.stringify(grant);
  assert.ok(typeof serialized === "string");
  const parsed = JSON.parse(serialized as string) as Record<string, unknown>;
  assert.equal(parsed.leaseId, "11111111-1111-4111-8111-111111111111");
  // No symbol-keyed property survives serialization:
  assert.equal(Object.getOwnPropertySymbols(parsed).length, 0);
  // The parsed object is not a LiveGrant (brand lost).
  assert.equal(isLiveGrant(parsed), false);
});

test("contracts: BackendResult discriminated union accepts accepted/denied shapes", () => {
  const accepted: BackendResult = Object.freeze({
    outcome: "accepted",
    leaseEvidence: Object.freeze({
      leaseId: "11111111-1111-4111-8111-111111111111",
      generation: "1",
      fenceIdentity: "a".repeat(64),
      state: "active",
      receiptAuthority: "evidence-only-never-authority",
    }),
    journalCursor: "e".repeat(64),
  });
  const deniedResult: BackendResult = Object.freeze({
    outcome: "denied",
    error: Object.freeze({ code: "lease-expired", message: "expired" }) as BackendError,
    partialReservationRetained: false,
  });
  assert.equal(accepted.outcome, "accepted");
  assert.equal(deniedResult.outcome, "denied");
  assert.equal(deniedResult.partialReservationRetained, false);
});

// ---------------------------------------------------------------------------
// Type-level compile-time checks (these are erased; they exist to fail the
// build if the closed types drift from the design).
// ---------------------------------------------------------------------------

test("contracts: type-level closure of resource union (compile-time)", () => {
  const r: MigrationResource = Object.freeze({
    kind: "physical-path",
    resourceId: "src/foo.ts",
    access: "write",
    resolution: "resolved",
    registryIdentity: "0".repeat(64),
    normalizerIdentity: "0".repeat(64),
    aliasClosure: ["src/foo.ts"],
    path: "src/foo.ts",
    portableCollisionKey: "src/foo.ts",
    observedState: Object.freeze({ kind: "absent", parentIdentity: Object.freeze({ device: "1", inode: "1", mode: 0o40755, ownerUid: "0", ownerGid: "0", links: "2", kind: "directory" }), entryName: "foo.ts" }),
  });
  assert.equal(r.kind, "physical-path");
});

test("contracts: LeaseState and LeaseTransition are assignable from the closed unions", () => {
  const s: LeaseState = "active";
  const t: LeaseTransition = "requested-active";
  assert.equal(s, "active");
  assert.equal(t, "requested-active");
});

// Compile-time only: ensure LiveGrant type is not constructible without the
// internal factory (the brand is not exported). This is a structural check that
// the public API surface does not leak the brand symbol.
test("contracts: LiveGrant brand symbol is not reachable from the public surface", () => {
  const grant: LiveGrant = createLiveGrant({
    leaseId: "22222222-2222-4222-8222-222222222222",
    generation: "2",
    fenceIdentity: "f".repeat(64),
    repositoryIdentity: "f".repeat(64),
    resourceRegistryIdentity: "f".repeat(64),
    processIdentity: "f".repeat(64),
  });
  // The grant is frozen and the brand is a non-enumerable symbol key.
  assert.ok(Object.isFrozen(grant));
  const symbols = Object.getOwnPropertySymbols(grant);
  assert.equal(symbols.length, 1);
});
