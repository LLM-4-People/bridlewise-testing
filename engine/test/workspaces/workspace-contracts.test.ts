import assert from "node:assert/strict";
import test from "node:test";

import { deepFreeze } from "../../src/kernel/integrity.ts";
import {
  assertLeasableWriteSet,
  assertWorkspaceAgentName,
  assertWorkspaceTransition,
  canonicalizeWriteSetPath,
  computeMergeReceiptHash,
  conflictReportSchema,
  finalizeMergeReceipt,
  isPathWithinWriteSet,
  isTerminalWorkspaceState,
  isWorkspaceTransitionAllowed,
  mergeReceiptSchema,
  parseMergeReceipt,
  parseValidationReport,
  parseWorkspaceRecord,
  validationReportSchema,
  WORKSPACE_SCHEMA_VERSION,
  WORKSPACE_STATES,
  WORKSPACE_TRANSITIONS,
  workspaceRecordSchema,
  type UnsignedMergeReceipt,
  type WorkspaceRecord,
} from "../../src/workflow/workspace-contracts.ts";

/** Matches a HarnessError by its typed code. */
function throwsCode(code: string): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof Error && (error as { code?: unknown }).code === code;
}

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

function makeLease(): WorkspaceRecord["lease"] {
  return deepFreeze({
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    workspaceId: "worker-abc123def456",
    agentName: "worker",
    kind: "feature",
    nonce: "abc123def456",
    branch: "agent/worker/abc123def456",
    targetBranch: "testing",
    worktreePath: "/home/user/bridlewise-worktrees/worker-abc123def456",
    baseSha: SHA_A,
    overlay: null,
    writeSet: ["src/"],
    writeSetIdentity: "f".repeat(64),
    issuedAt: "2026-07-19T00:00:00.000Z",
    heartbeatAt: "2026-07-19T00:00:00.000Z",
    expiresAt: "2026-07-20T00:00:00.000Z",
    generation: 1,
  });
}

function makeRecord(): WorkspaceRecord {
  return deepFreeze({
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    workspaceId: "worker-abc123def456",
    agentName: "worker",
    state: "active",
    lease: makeLease(),
    changedPaths: [],
    validationReport: null,
    conflictReport: null,
    mergeReceipt: null,
    abortReason: null,
    history: [deepFreeze({ from: "admitted", to: "active", at: "2026-07-19T00:00:00.000Z", reason: "created" })],
    forge: deepFreeze({ remote: "origin", trunk: "main", pullRequest: null, publishedHead: null, ready: false }),
    revision: 1,
  });
}

function makeUnsignedReceipt(): UnsignedMergeReceipt {
  return deepFreeze({
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    workspaceId: "worker-abc123def456",
    agentName: "worker",
    branch: "agent/worker/abc123def456",
    targetBranch: "testing",
    baseSha: SHA_A,
    preMergeHeadSha: SHA_B,
    mergeCommitSha: SHA_C,
    mergeTree: SHA_A,
    landing: "fast-forward",
    landedIn: "/home/user/bridlewise-testing",
    changedPaths: ["src/x.ts"],
    regeneratedPaths: ["engine/src/architecture-manifest.ts"],
    resolvedConflicts: [],
    importedRuns: ["engine/.bridlewise/state/test-results/run-history.json: 1"],
    timelineImportedEvents: 3,
    timelineSkippedEvents: 0,
    gateResults: [deepFreeze({ gate: "engine-suite", status: "pass", message: "ok", details: [] })],
    mergedAt: "2026-07-19T01:00:00.000Z",
  });
}

// ---------------------------------------------------------------------------
// schema closedness
// ---------------------------------------------------------------------------

test("workspace schemas are strict: unknown keys are rejected", () => {
  const record = { ...makeRecord(), unexpected: true };
  assert.throws(() => workspaceRecordSchema.parse(record));
  assert.throws(() => parseWorkspaceRecord(record), throwsCode("workspace_record_invalid"));
});

test("workspace schemas reject missing keys", () => {
  const record = { ...makeRecord() } as Record<string, unknown>;
  delete record.lease;
  assert.throws(() => parseWorkspaceRecord(record), throwsCode("workspace_record_invalid"));
});

test("lease, validation, conflict, and receipt schemas are strict", () => {
  assert.throws(() => validationReportSchema.parse({ ...makeValidReport(), extra: 1 }));
  assert.throws(() => conflictReportSchema.parse({ schemaVersion: WORKSPACE_SCHEMA_VERSION, kind: "static-overlap", workspaceId: "w-12345678", conflicts: [], detectedAt: "x" }));
  assert.throws(() => mergeReceiptSchema.parse({ ...makeUnsignedReceipt(), receiptHash: "z".repeat(64) }));
});

test("parseWorkspaceRecord round-trips a valid record", () => {
  const record = makeRecord();
  assert.deepEqual(parseWorkspaceRecord(JSON.parse(JSON.stringify(record))), record);
});

function makeValidReport() {
  return {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    workspaceId: "worker-abc123def456",
    baseSha: SHA_A,
    headSha: SHA_B,
    tree: SHA_C,
    full: false,
    changedPaths: ["src/x.ts"],
    gates: [{ gate: "write-set-proof", status: "pass", message: "ok", details: [] }],
    status: "pass",
    startedAt: "2026-07-19T00:20:00.000Z",
    validatedAt: "2026-07-19T00:30:00.000Z",
  };
}

test("parseValidationReport accepts a valid report", () => {
  const report = parseValidationReport(makeValidReport());
  assert.equal(report.status, "pass");
});

// ---------------------------------------------------------------------------
// state machine
// ---------------------------------------------------------------------------

test("state machine enumerates seven states", () => {
  assert.equal(WORKSPACE_STATES.length, 7);
});

test("allowed transitions follow the pipeline", () => {
  assert.ok(isWorkspaceTransitionAllowed("admitted", "active"));
  assert.ok(isWorkspaceTransitionAllowed("active", "validating"));
  assert.ok(isWorkspaceTransitionAllowed("validating", "merging"));
  assert.ok(isWorkspaceTransitionAllowed("validating", "active"));
  assert.ok(isWorkspaceTransitionAllowed("merging", "merged"));
  assert.ok(isWorkspaceTransitionAllowed("merging", "active"));
  assert.ok(isWorkspaceTransitionAllowed("merging", "aborted"));
  assert.ok(isWorkspaceTransitionAllowed("merging", "quarantined"));
});

test("denied transitions throw", () => {
  for (const [from, to] of [
    ["admitted", "merging"],
    ["admitted", "merged"],
    ["active", "merged"],
    ["merged", "active"],
    ["aborted", "active"],
    ["quarantined", "aborted"],
  ] as const) {
    assert.throws(() => assertWorkspaceTransition(from, to), throwsCode("workspace_transition_invalid"));
  }
});

test("terminal states have no outgoing transitions", () => {
  assert.ok(isTerminalWorkspaceState("merged"));
  assert.ok(isTerminalWorkspaceState("aborted"));
  assert.ok(isTerminalWorkspaceState("quarantined"));
  assert.ok(!isTerminalWorkspaceState("active"));
  assert.deepEqual(WORKSPACE_TRANSITIONS.merged, []);
});

// ---------------------------------------------------------------------------
// receipt hashing
// ---------------------------------------------------------------------------

test("merge receipt hash is deterministic for identical content", () => {
  const first = finalizeMergeReceipt(makeUnsignedReceipt());
  const second = finalizeMergeReceipt(makeUnsignedReceipt());
  assert.equal(first.receiptHash, second.receiptHash);
  assert.equal(computeMergeReceiptHash(makeUnsignedReceipt()), first.receiptHash);
});

test("merge receipt hash changes with content", () => {
  const first = finalizeMergeReceipt(makeUnsignedReceipt());
  const other = finalizeMergeReceipt(deepFreeze({ ...makeUnsignedReceipt(), mergeCommitSha: SHA_A }));
  assert.notEqual(first.receiptHash, other.receiptHash);
});

test("parseMergeReceipt verifies the hash and rejects tampering", () => {
  const receipt = finalizeMergeReceipt(makeUnsignedReceipt());
  assert.deepEqual(parseMergeReceipt(JSON.parse(JSON.stringify(receipt))), receipt);
  const tampered = { ...receipt, timelineImportedEvents: 99 };
  assert.throws(() => parseMergeReceipt(tampered), throwsCode("workspace_receipt_invalid"));
});

// ---------------------------------------------------------------------------
// write-set canonicalization + leasability
// ---------------------------------------------------------------------------

test("canonicalizeWriteSetPath strips trailing slashes and normalizes", () => {
  assert.equal(canonicalizeWriteSetPath("src/git/"), "src/git");
  assert.equal(canonicalizeWriteSetPath("src/git"), "src/git");
  assert.equal(canonicalizeWriteSetPath("src\\git"), "src/git");
});

test("canonicalizeWriteSetPath rejects traversal and absolute paths", () => {
  for (const path of ["", "../x", "a/../b", "/abs", "a//b", "."]) {
    assert.throws(() => canonicalizeWriteSetPath(path), throwsCode("workspace_write_set_invalid"));
  }
});

test("assertLeasableWriteSet refuses the wholly generated outputs (derived) and never-source segments", () => {
  for (const path of [
    "engine/src/architecture-manifest.ts",
    "engine/traceability/config-document-schema.json",
    "engine/src",
    "engine",
    ".bridlewise/state",
    "engine/.bridlewise/state/x.json",
    ".git/refs",
    "node_modules/foo",
    "engine/node_modules/zod",
  ]) {
    assert.throws(() => assertLeasableWriteSet([path]), throwsCode("workspace_write_set_never_leasable"), path);
  }
});

test("assertLeasableWriteSet leases authored files that carry generated parts: pin-bearing sources, the dispositions, READMEs", () => {
  assert.doesNotThrow(() => assertLeasableWriteSet([
    "engine/src/kernel/root-policy.ts",
    "engine/traceability/test-surface-dispositions.json",
    "engine/src/workflow/README.md",
    "engine/traceability/requirements.json",
  ]));
});

test("a read-only lease has no write set, no identity, no branch and no target; a feature lease has all four", () => {
  const readOnly = { ...makeLease(), kind: "read-only", writeSet: [], writeSetIdentity: null, branch: null, targetBranch: null };
  assert.doesNotThrow(() => parseWorkspaceRecord({ ...makeRecord(), lease: readOnly, forge: null }));
  for (const broken of [
    { ...readOnly, writeSet: ["src"] },
    { ...readOnly, branch: "agent/worker/abc123def456" },
    { ...readOnly, writeSetIdentity: "f".repeat(64) },
    { ...makeLease(), writeSet: [] },
    { ...makeLease(), targetBranch: null },
  ]) {
    assert.throws(() => parseWorkspaceRecord({ ...makeRecord(), lease: broken, forge: broken.kind === "read-only" ? null : makeRecord().forge }), throwsCode("workspace_record_invalid"));
  }
  assert.throws(() => parseWorkspaceRecord({ ...makeRecord(), lease: readOnly, forge: null, state: "merging" }), throwsCode("workspace_record_invalid"), "a read-only workspace never merges");
});

test("the forge state: a feature workspace has one and a read-only one none; the pull request and the published head come together; only an opened one is ready", () => {
  const readOnly = { ...makeLease(), kind: "read-only", writeSet: [], writeSetIdentity: null, branch: null, targetBranch: null };
  const forge = makeRecord().forge!;
  const published = { ...forge, pullRequest: { number: 7, url: "https://forge.test/pull/7" }, publishedHead: SHA_B };
  assert.doesNotThrow(() => parseWorkspaceRecord({ ...makeRecord(), forge: published }));
  assert.doesNotThrow(() => parseWorkspaceRecord({ ...makeRecord(), forge: { ...published, ready: true } }));
  for (const [broken, why] of [
    [{ ...makeRecord(), forge: null }, "a feature workspace without a forge state"],
    [{ ...makeRecord(), lease: readOnly, forge }, "a read-only workspace with a forge state"],
    [{ ...makeRecord(), forge: { ...forge, publishedHead: SHA_B } }, "a published head without a pull request"],
    [{ ...makeRecord(), forge: { ...published, publishedHead: null } }, "a pull request without a published head"],
    [{ ...makeRecord(), forge: { ...forge, ready: true } }, "ready without a pull request"],
    [{ ...makeRecord(), forge: { ...forge, remote: "-upload-pack" } }, "a remote name that is an option"],
    [{ ...makeRecord(), forge: { ...forge, unexpected: 1 } }, "an unknown key"],
  ] as const) {
    assert.throws(() => parseWorkspaceRecord(broken), throwsCode("workspace_record_invalid"), why);
  }
});

test("gate names are the built-ins and the configured command names: an open, shaped name", () => {
  const report = makeValidReport();
  assert.doesNotThrow(() => parseValidationReport({ ...report, gates: [{ gate: "engine-suite", status: "skip", message: "", details: [] }] }));
  assert.throws(() => parseValidationReport({ ...report, gates: [{ gate: "Not A Name", status: "pass", message: "", details: [] }] }), throwsCode("workspace_report_invalid"));
});

test("assertLeasableWriteSet accepts ordinary source paths and rejects empty sets", () => {
  assert.doesNotThrow(() => assertLeasableWriteSet(["src/git", "test/workspaces"]));
  assert.throws(() => assertLeasableWriteSet([]), throwsCode("workspace_write_set_empty"));
});

test("isPathWithinWriteSet respects prefix boundaries", () => {
  assert.ok(isPathWithinWriteSet("src/git/worktree-port.ts", ["src/git"]));
  assert.ok(isPathWithinWriteSet("src/git", ["src/git"]));
  assert.ok(!isPathWithinWriteSet("src/github/x.ts", ["src/git"]));
  assert.ok(!isPathWithinWriteSet("src", ["src/git"]));
});

test("assertWorkspaceAgentName enforces the profile name shape", () => {
  assert.doesNotThrow(() => assertWorkspaceAgentName("worker-1"));
  assert.throws(() => assertWorkspaceAgentName("bad name"), throwsCode("workspace_agent_name_invalid"));
  assert.throws(() => assertWorkspaceAgentName("-leading"), throwsCode("workspace_agent_name_invalid"));
});
