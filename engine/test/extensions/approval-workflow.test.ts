import assert from "node:assert/strict";
import test from "node:test";

import {
  createApprovalWorkflow,
  createMemoryApprovalStateStore,
  assessRisk,
  RISK_LEVELS,
  PROPOSAL_STATUSES,
  ApprovalError,
} from "../../src/extensions/approval-workflow.ts";
import type {
  ApprovalWorkflow,
  ApprovalPrincipal,
  ActivationApplier,
  ExtensionEffectRecorder,
  ModificationProposal,
  ApprovalGrant,
  ReviewResult,
} from "../../src/extensions/approval-workflow.ts";
import { InputError, SecurityError } from "../../src/kernel/errors.ts";
import { createExtensionManifest } from "../../src/extensions/extension-manifest.ts";
import { proposeAdd } from "../../src/extensions/extension-lifecycle.ts";
import { makeEntry, makeProviderEntry, VALID_TIMESTAMP } from "./fixtures.ts";

const APPROVER: ApprovalPrincipal = { kind: "user", id: "operator" };
const REVIEWER: ApprovalPrincipal = { kind: "cli", id: "reviewer-agent" };

function makeWorkflow(
  applier: ActivationApplier,
  recorder?: ExtensionEffectRecorder,
  clock?: () => string,
  ttl = 3600_000,
): ApprovalWorkflow {
  return createApprovalWorkflow({
    applier,
    ...(recorder !== undefined ? { recorder } : {}),
    ...(clock !== undefined ? { clock } : {}),
    approvalTtlMs: ttl,
  });
}

function recordingApplier(): { applier: ActivationApplier; calls: { apply: number; rollback: number } } {
  const calls = { apply: 0, rollback: 0 };
  const applier: ActivationApplier = {
    applyProposal: (proposal: ModificationProposal) => {
      calls.apply++;
      return { success: true, postimageHash: proposal.postimageHash };
    },
    rollbackProposal: (proposal: ModificationProposal) => {
      void proposal;
      calls.rollback++;
      return { success: true };
    },
  };
  return { applier, calls };
}

function recordingRecorder(): { recorder: ExtensionEffectRecorder; events: string[] } {
  const events: string[] = [];
  const recorder: ExtensionEffectRecorder = {
    recordProposal: (p) => { events.push(`proposal:${p.proposalId}`); },
    recordApproval: (g) => { events.push(`approval:${g.grantId}`); },
    recordRejection: (p) => { events.push(`rejection:${p.proposalId}`); },
    recordApplication: (p, _h, success) => { events.push(`application:${p.proposalId}:${success}`); },
    recordReview: (r) => { events.push(`review:${r.reviewId}:${r.verdict}`); },
    recordActivation: (o) => { events.push(`activation:${o.proposalId}:${o.activated}`); },
    recordRollback: (p, _r) => { events.push(`rollback:${p.proposalId}`); },
  };
  return { recorder, events };
}

function makeProposalInput(workflow: ApprovalWorkflow) {
  const entry = makeEntry({ status: "proposed" });
  const lifecycle = proposeAdd({ context: { manifest: createExtensionManifest() }, entry });
  return workflow.propose({
    scope: { extensionId: entry.id, operation: "add", writeSet: ["src/extensions/one.ts"] },
    lifecycle,
    description: "Add a test provider",
    rationale: "testing",
    compatibility: lifecycle.compatibility,
  });
}

// ============================================================================
// Closed registries
// ============================================================================

test("Approval: RISK_LEVELS has 4 levels", () => {
  assert.equal(RISK_LEVELS.length, 4);
  assert.ok(RISK_LEVELS.includes("critical"));
});

test("Approval: PROPOSAL_STATUSES has 8 statuses", () => {
  assert.equal(PROPOSAL_STATUSES.length, 8);
  assert.ok(PROPOSAL_STATUSES.includes("pending"));
  assert.ok(PROPOSAL_STATUSES.includes("activated"));
});

test("Approval: RISK_LEVELS is frozen", () => {
  assert.ok(Object.isFrozen(RISK_LEVELS));
});

// ============================================================================
// assessRisk
// ============================================================================

test("Approval: assessRisk low for reversible add with no dependents", () => {
  const r = assessRisk("add", { compatible: true, blockingCount: 0, findings: [], summary: "" }, [], true);
  assert.equal(r.level, "low");
});

test("Approval: assessRisk high for delete", () => {
  const r = assessRisk("delete", { compatible: true, blockingCount: 0, findings: [], summary: "" }, [], true);
  assert.equal(r.level, "high");
});

test("Approval: assessRisk critical with blocking findings", () => {
  const r = assessRisk("add", { compatible: false, blockingCount: 2, findings: [], summary: "" }, [], true);
  assert.equal(r.level, "critical");
});

test("Approval: assessRisk escalates with dependents", () => {
  const r = assessRisk("add", { compatible: true, blockingCount: 0, findings: [], summary: "" }, ["d1"], true);
  assert.equal(r.level, "medium");
});

test("Approval: assessRisk escalates when not reversible", () => {
  const r = assessRisk("add", { compatible: true, blockingCount: 0, findings: [], summary: "" }, [], false);
  assert.notEqual(r.level, "low");
});

test("Approval: assessRisk records reasons", () => {
  const r = assessRisk("delete", { compatible: true, blockingCount: 0, findings: [], summary: "" }, ["d1"], false);
  assert.ok(r.reasons.length >= 2);
  assert.ok(r.affectedConsumers.includes("d1"));
});

// ============================================================================
// propose
// ============================================================================

test("Approval: propose returns pending proposal with contentHash", () => {
  const wf = makeWorkflow(recordingApplier().applier);
  const p = makeProposalInput(wf);
  assert.equal(p.status, "pending");
  assert.ok(p.contentHash.length === 64);
  assert.ok(p.proposalId.length > 0);
  assert.ok(p.expiresAt > p.createdAt);
});

test("Approval: propose throws on scope mismatch (extensionId)", () => {
  const wf = makeWorkflow(recordingApplier().applier);
  const entry = makeEntry({ status: "proposed" });
  const lifecycle = proposeAdd({ context: { manifest: createExtensionManifest() }, entry });
  assert.throws(
    () => wf.propose({
      scope: { extensionId: "wrong", operation: "add", writeSet: [] },
      lifecycle,
      description: "x", rationale: "y", compatibility: lifecycle.compatibility,
    }),
    (e: Error) => e instanceof ApprovalError && e.code === "approval_scope_mismatch",
  );
});

test("Approval: propose throws on scope mismatch (operation)", () => {
  const wf = makeWorkflow(recordingApplier().applier);
  const entry = makeEntry({ status: "proposed" });
  const lifecycle = proposeAdd({ context: { manifest: createExtensionManifest() }, entry });
  assert.throws(
    () => wf.propose({
      scope: { extensionId: entry.id, operation: "delete", writeSet: [] },
      lifecycle,
      description: "x", rationale: "y", compatibility: lifecycle.compatibility,
    }),
    (e: Error) => e instanceof ApprovalError && e.code === "approval_scope_mismatch",
  );
});

test("Approval: propose throws on empty description", () => {
  const wf = makeWorkflow(recordingApplier().applier);
  const entry = makeEntry({ status: "proposed" });
  const lifecycle = proposeAdd({ context: { manifest: createExtensionManifest() }, entry });
  assert.throws(
    () => wf.propose({
      scope: { extensionId: entry.id, operation: "add", writeSet: [] },
      lifecycle, description: "", rationale: "y", compatibility: lifecycle.compatibility,
    }),
    (e: Error) => e instanceof InputError,
  );
});

test("Approval: proposal is frozen", () => {
  const wf = makeWorkflow(recordingApplier().applier);
  const p = makeProposalInput(wf);
  assert.ok(Object.isFrozen(p));
});

// ============================================================================
// approve / verifyGrant / isExpired
// ============================================================================

test("Approval: approve returns grant with nonce and contentHash", () => {
  const wf = makeWorkflow(recordingApplier().applier);
  const p = makeProposalInput(wf);
  const g = wf.approve(p, APPROVER, "base-rev-1");
  assert.ok(g.nonce.length > 0);
  assert.equal(g.proposalContentHash, p.contentHash);
  assert.equal(g.principal.id, "operator");
  assert.equal(g.baseRevision, "base-rev-1");
});

test("Approval: verifyGrant true for matching grant", () => {
  const wf = makeWorkflow(recordingApplier().applier);
  const p = makeProposalInput(wf);
  const g = wf.approve(p, APPROVER, "rev");
  assert.ok(wf.verifyGrant(g, p));
});

test("Approval: verifyGrant false for mismatched contentHash", () => {
  const wf = makeWorkflow(recordingApplier().applier);
  const p = makeProposalInput(wf);
  const g = wf.approve(p, APPROVER, "rev");
  assert.ok(!wf.verifyGrant({ ...g, proposalContentHash: "0".repeat(64) }, p));
});

test("Approval: verifyGrant false for mismatched proposalId", () => {
  const wf = makeWorkflow(recordingApplier().applier);
  const p = makeProposalInput(wf);
  const g = wf.approve(p, APPROVER, "rev");
  assert.ok(!wf.verifyGrant({ ...g, proposalId: "other" }, p));
});

test("Approval: approve throws on expired proposal", () => {
  let t = 1_000_000;
  const wf = makeWorkflow(recordingApplier().applier, undefined, () => new Date(t).toISOString(), 1000);
  const p = makeProposalInput(wf);
  t += 10_000; // expire
  assert.throws(
    () => wf.approve(p, APPROVER, "rev"),
    (e: Error) => e instanceof ApprovalError && e.code === "approval_proposal_expired",
  );
});

test("Approval: isExpired false before expiry", () => {
  const wf = makeWorkflow(recordingApplier().applier);
  const p = makeProposalInput(wf);
  assert.ok(!wf.isExpired(p));
});

test("Approval: isExpired true after expiry", () => {
  let t = 1_000_000;
  const wf = makeWorkflow(recordingApplier().applier, undefined, () => new Date(t).toISOString(), 1000);
  const p = makeProposalInput(wf);
  assert.ok(wf.isExpired(p, new Date(t + 10_000).toISOString()));
});

test("Approval: approve throws on invalid principal", () => {
  const wf = makeWorkflow(recordingApplier().applier);
  const p = makeProposalInput(wf);
  assert.throws(() => wf.approve(p, { kind: "bad" as never, id: "x" }, "rev"), InputError);
  assert.throws(() => wf.approve(p, { kind: "user", id: "" }, "rev"), InputError);
});

test("Approval: approve throws on empty baseRevision", () => {
  const wf = makeWorkflow(recordingApplier().applier);
  const p = makeProposalInput(wf);
  assert.throws(() => wf.approve(p, APPROVER, ""), InputError);
});

test("Approval: grant is frozen", () => {
  const wf = makeWorkflow(recordingApplier().applier);
  const p = makeProposalInput(wf);
  const g = wf.approve(p, APPROVER, "rev");
  assert.ok(Object.isFrozen(g));
});

// ============================================================================
// reject
// ============================================================================

test("Approval: reject records rejection", () => {
  const { recorder, events } = recordingRecorder();
  const wf = makeWorkflow(recordingApplier().applier, recorder);
  const p = makeProposalInput(wf);
  wf.reject(p, APPROVER, "not needed");
  assert.ok(events.some((e) => e.startsWith("rejection:")));
});

test("Approval: reject throws on empty reason", () => {
  const wf = makeWorkflow(recordingApplier().applier);
  const p = makeProposalInput(wf);
  assert.throws(() => wf.reject(p, APPROVER, ""), InputError);
});

test("Approval: reject throws on invalid principal", () => {
  const wf = makeWorkflow(recordingApplier().applier);
  const p = makeProposalInput(wf);
  assert.throws(() => wf.reject(p, { kind: "user", id: "" }, "x"), InputError);
});

// ============================================================================
// apply
// ============================================================================

test("Approval: apply invokes applier and returns result", () => {
  const { applier, calls } = recordingApplier();
  const wf = makeWorkflow(applier);
  const p = makeProposalInput(wf);
  const g = wf.approve(p, APPROVER, "rev");
  const result = wf.apply(g, p);
  assert.ok(result.success);
  assert.equal(result.postimageHash, p.postimageHash);
  assert.equal(calls.apply, 1);
});

test("Approval: apply throws on invalid grant", () => {
  const wf = makeWorkflow(recordingApplier().applier);
  const p = makeProposalInput(wf);
  const fakeGrant: ApprovalGrant = {
    grantId: "x", proposalId: "other", proposalContentHash: "0".repeat(64), nonce: "n",
    principal: APPROVER, scope: p.scope, issuedAt: VALID_TIMESTAMP, expiresAt: p.expiresAt, baseRevision: "r",
  };
  assert.throws(
    () => wf.apply(fakeGrant, p),
    (e: Error) => e instanceof SecurityError && e.code === "approval_grant_invalid",
  );
});

test("Approval: apply records application to recorder", () => {
  const { recorder, events } = recordingRecorder();
  const wf = makeWorkflow(recordingApplier().applier, recorder);
  const p = makeProposalInput(wf);
  const g = wf.approve(p, APPROVER, "rev");
  wf.apply(g, p);
  assert.ok(events.some((e) => e.startsWith("application:")));
});

test("Approval: apply records failure to recorder", () => {
  const { recorder, events } = recordingRecorder();
  const failApplier: ActivationApplier = {
    applyProposal: () => ({ success: false, postimageHash: "", reason: "boom" }),
    rollbackProposal: () => ({ success: true }),
  };
  const wf = makeWorkflow(failApplier, recorder);
  const p = makeProposalInput(wf);
  const g = wf.approve(p, APPROVER, "rev");
  wf.apply(g, p);
  assert.ok(events.some((e) => e.includes("application:") && e.endsWith(":false")));
});

// ============================================================================
// review
// ============================================================================

test("Approval: review ADMIT returns ReviewResult", () => {
  const wf = makeWorkflow(recordingApplier().applier);
  const p = makeProposalInput(wf);
  const g = wf.approve(p, APPROVER, "rev");
  const r = wf.review(g, p, "ADMIT", REVIEWER);
  assert.equal(r.verdict, "ADMIT");
  assert.equal(r.reviewer.id, "reviewer-agent");
  assert.ok(r.contractHash.length === 64);
});

test("Approval: review REJECT returns ReviewResult", () => {
  const wf = makeWorkflow(recordingApplier().applier);
  const p = makeProposalInput(wf);
  const g = wf.approve(p, APPROVER, "rev");
  const r = wf.review(g, p, "REJECT", REVIEWER, ["bad"], []);
  assert.equal(r.verdict, "REJECT");
  assert.deepEqual([...r.findings], ["bad"]);
});

test("Approval: review throws when reviewer is approver", () => {
  const wf = makeWorkflow(recordingApplier().applier);
  const p = makeProposalInput(wf);
  const g = wf.approve(p, APPROVER, "rev");
  assert.throws(
    () => wf.review(g, p, "ADMIT", APPROVER),
    (e: Error) => e instanceof SecurityError && e.code === "approval_reviewer_is_approver",
  );
});

test("Approval: review throws on invalid verdict", () => {
  const wf = makeWorkflow(recordingApplier().applier);
  const p = makeProposalInput(wf);
  const g = wf.approve(p, APPROVER, "rev");
  assert.throws(() => wf.review(g, p, "MAYBE" as never, REVIEWER), InputError);
});

test("Approval: review records to recorder", () => {
  const { recorder, events } = recordingRecorder();
  const wf = makeWorkflow(recordingApplier().applier, recorder);
  const p = makeProposalInput(wf);
  const g = wf.approve(p, APPROVER, "rev");
  wf.review(g, p, "ADMIT", REVIEWER);
  assert.ok(events.some((e) => e.includes("review:") && e.endsWith(":ADMIT")));
});

test("Approval: review result is frozen", () => {
  const wf = makeWorkflow(recordingApplier().applier);
  const p = makeProposalInput(wf);
  const g = wf.approve(p, APPROVER, "rev");
  const r: ReviewResult = wf.review(g, p, "ADMIT", REVIEWER);
  assert.ok(Object.isFrozen(r));
});

// ============================================================================
// activate
// ============================================================================

test("Approval: activate ADMIT activates and does not rollback", () => {
  const { applier, calls } = recordingApplier();
  const wf = makeWorkflow(applier);
  const p = makeProposalInput(wf);
  const g = wf.approve(p, APPROVER, "rev");
  const r = wf.review(g, p, "ADMIT", REVIEWER);
  const outcome = wf.activate(r, g, p);
  assert.ok(outcome.activated);
  assert.ok(!outcome.rolledBack);
  assert.ok(outcome.activatedEntry);
  assert.equal(calls.rollback, 0);
});

test("Approval: activate REJECT triggers rollback", () => {
  const { applier, calls } = recordingApplier();
  const wf = makeWorkflow(applier);
  const p = makeProposalInput(wf);
  const g = wf.approve(p, APPROVER, "rev");
  const r = wf.review(g, p, "REJECT", REVIEWER, ["broken"]);
  const outcome = wf.activate(r, g, p);
  assert.ok(!outcome.activated);
  assert.ok(outcome.rolledBack);
  assert.equal(outcome.activatedEntry, null);
  assert.equal(calls.rollback, 1);
});

test("Approval: activate records activation to recorder", () => {
  const { recorder, events } = recordingRecorder();
  const wf = makeWorkflow(recordingApplier().applier, recorder);
  const p = makeProposalInput(wf);
  const g = wf.approve(p, APPROVER, "rev");
  const r = wf.review(g, p, "ADMIT", REVIEWER);
  wf.activate(r, g, p);
  assert.ok(events.some((e) => e.endsWith(":true") && e.startsWith("activation:")));
});

test("Approval: activate throws on review mismatch", () => {
  const wf = makeWorkflow(recordingApplier().applier);
  const p = makeProposalInput(wf);
  const g = wf.approve(p, APPROVER, "rev");
  const otherReview: ReviewResult = {
    reviewId: "x", proposalId: "other", verdict: "ADMIT", reviewer: REVIEWER,
    appliedContentHash: p.postimageHash, contractHash: "x", findings: [], conditions: [], reviewedAt: VALID_TIMESTAMP,
  };
  assert.throws(() => wf.activate(otherReview, g, p), ApprovalError);
});

test("Approval: activate throws on invalid grant", () => {
  const wf = makeWorkflow(recordingApplier().applier);
  const p = makeProposalInput(wf);
  const g = wf.approve(p, APPROVER, "rev");
  const r = wf.review(g, p, "ADMIT", REVIEWER);
  const expiredGrant: ApprovalGrant = { ...g, expiresAt: "2020-01-01T00:00:00Z" };
  assert.throws(() => wf.activate(r, expiredGrant, p), SecurityError);
});

// ============================================================================
// createApprovalWorkflow — options validation
// ============================================================================

test("Approval: workflow throws on invalid approvalTtlMs", () => {
  assert.throws(
    () => createApprovalWorkflow({ applier: recordingApplier().applier, approvalTtlMs: 0 }),
    InputError,
  );
  assert.throws(
    () => createApprovalWorkflow({ applier: recordingApplier().applier, approvalTtlMs: NaN }),
    InputError,
  );
  assert.throws(
    () => createApprovalWorkflow({ applier: recordingApplier().applier, approvalTtlMs: -1 }),
    InputError,
  );
});

test("Approval: workflow is frozen", () => {
  const wf = makeWorkflow(recordingApplier().applier);
  assert.ok(Object.isFrozen(wf));
});

// ============================================================================
// createMemoryApprovalStateStore — anti-replay
// ============================================================================

test("Approval: store records and consumes grant", () => {
  const store = createMemoryApprovalStateStore();
  const wf = makeWorkflow(recordingApplier().applier);
  const p = makeProposalInput(wf);
  const g = wf.approve(p, APPROVER, "rev");
  store.recordGrant(g);
  const consumed = store.consumeGrant(g.grantId, p.contentHash);
  assert.ok(consumed);
  // second consume returns undefined (replay blocked)
  assert.equal(store.consumeGrant(g.grantId, p.contentHash), undefined);
});

test("Approval: store consumeGrant rejects mismatched hash", () => {
  const store = createMemoryApprovalStateStore();
  const wf = makeWorkflow(recordingApplier().applier);
  const p = makeProposalInput(wf);
  const g = wf.approve(p, APPROVER, "rev");
  store.recordGrant(g);
  assert.equal(store.consumeGrant(g.grantId, "0".repeat(64)), undefined);
});

test("Approval: store consumeGrant returns undefined for unknown", () => {
  const store = createMemoryApprovalStateStore();
  assert.equal(store.consumeGrant("nope", "x"), undefined);
});

test("Approval: store records and retrieves proposal", () => {
  const store = createMemoryApprovalStateStore();
  const wf = makeWorkflow(recordingApplier().applier);
  const p = makeProposalInput(wf);
  store.recordProposal(p);
  assert.ok(store.getProposal(p.proposalId));
  assert.equal(store.getProposal("nope"), undefined);
});

// ============================================================================
// End-to-end flow
// ============================================================================

test("Approval: full flow propose→approve→apply→review→activate", () => {
  const { recorder, events } = recordingRecorder();
  const { applier } = recordingApplier();
  const wf = makeWorkflow(applier, recorder);
  const p = makeProposalInput(wf);
  const g = wf.approve(p, APPROVER, "rev-1");
  wf.apply(g, p);
  const r = wf.review(g, p, "ADMIT", REVIEWER);
  const outcome = wf.activate(r, g, p);
  assert.ok(outcome.activated);
  assert.ok(events.includes("proposal:" + p.proposalId));
  assert.ok(events.some((e) => e.startsWith("approval:")));
  assert.ok(events.some((e) => e.startsWith("application:")));
  assert.ok(events.some((e) => e.startsWith("review:")));
  assert.ok(events.some((e) => e.startsWith("activation:")));
});

test("Approval: full flow with REJECT rolls back", () => {
  const { recorder, events } = recordingRecorder();
  const { applier } = recordingApplier();
  const wf = makeWorkflow(applier, recorder);
  const p = makeProposalInput(wf);
  const g = wf.approve(p, APPROVER, "rev-1");
  wf.apply(g, p);
  const r = wf.review(g, p, "REJECT", REVIEWER, ["incompatible"]);
  const outcome = wf.activate(r, g, p);
  assert.ok(outcome.rolledBack);
  assert.ok(events.some((e) => e.startsWith("rollback:")));
});

test("Approval: add of provider produces reversible proposal", () => {
  const wf = makeWorkflow(recordingApplier().applier);
  const entry = makeProviderEntry("prov-x");
  const lifecycle = proposeAdd({ context: { manifest: createExtensionManifest() }, entry, targetStatus: "active" });
  const p = wf.propose({
    scope: { extensionId: "prov-x", operation: "add", writeSet: ["src/providers/prov-x.ts"] },
    lifecycle,
    description: "add provider", rationale: "need provider", compatibility: lifecycle.compatibility,
  });
  assert.equal(p.risk.level, "low");
  assert.ok(p.scope.writeSet.includes("src/providers/prov-x.ts"));
});
