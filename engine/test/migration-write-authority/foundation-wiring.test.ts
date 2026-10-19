import assert from "node:assert/strict";
import test from "node:test";

import {
  writeFoundation,
  recoverFoundation,
  planFoundation,
  checkFoundation,
} from "../../verification/slices/foundation.ts";
import {
  isMigrationWriteAuthorityAdmitted,
  MWA_QUALIFIED_CAPABILITY,
  MWA_CAPABILITY_ADMITTED,
} from "../../verification/core/coordination/migration-write-authority/capability.ts";

test("foundation-wiring: the MWA qualified capability is admitted (hostile matrix passed)", () => {
  // Honest gate: the capability is registered and admitted after the hostile
  // qualification matrix (11 families × 3 reps) passed independent review.
  assert.equal(MWA_CAPABILITY_ADMITTED, true, "MWA_CAPABILITY_ADMITTED must be true after the hostile matrix passes");
  assert.equal(isMigrationWriteAuthorityAdmitted(), true, "isMigrationWriteAuthorityAdmitted must be true");
  assert.equal(MWA_QUALIFIED_CAPABILITY, "migration-write-authority/qualified");
});

test("foundation-wiring: writeFoundation returns the protocol-pending blocker when MWA is admitted", () => {
  const result = writeFoundation();
  assert.equal(result.disposition, "unavailable");
  assert.equal(result.transactionBlockers.length, 1);
  const blocker = result.transactionBlockers[0]!;
  assert.equal(blocker.code, "foundation_write_protocol_pending_implementation");
  assert.equal(blocker.requiredCapabilities.length, 0, "no missing capabilities: MWA is admitted");
});

test("foundation-wiring: recoverFoundation returns the protocol-pending blocker when MWA is admitted", () => {
  const result = recoverFoundation();
  assert.equal(result.disposition, "unavailable");
  assert.equal(result.transactionBlockers.length, 1);
  assert.equal(result.transactionBlockers[0]!.code, "foundation_recover_protocol_pending_implementation");
  assert.equal(result.transactionBlockers[0]!.requiredCapabilities.length, 0);
});

test("foundation-wiring: the transaction authority gate is satisfied (MWA admitted returns null)", () => {
  // `resolveTransactionAuthorityGate` is not exported, so verify its null
  // return indirectly: when MWA is admitted the gate returns null, so neither
  // write nor recover reports the transaction-authority-unavailable blocker.
  // `isMigrationWriteAuthorityAdmitted === true` is the direct precondition.
  assert.equal(isMigrationWriteAuthorityAdmitted(), true);
  const write = writeFoundation();
  assert.notEqual(write.transactionBlockers[0]?.code, "foundation_transaction_authority_unavailable");
  const recover = recoverFoundation();
  assert.notEqual(recover.transactionBlockers[0]?.code, "foundation_transaction_authority_unavailable");
});

test("foundation-wiring: plan and check modes do not require MWA (no transaction blocker)", () => {
  // plan and check are read-only; they must not report a transaction authority blocker.
  const plan = planFoundation();
  assert.equal(plan.transactionBlockers.length, 0, "planFoundation must not report transaction blockers");
  const check = checkFoundation();
  assert.equal(check.transactionBlockers.length, 0, "checkFoundation must not report transaction blockers");
});
