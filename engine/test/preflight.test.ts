import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createPreflightContext, isIssuedPreflightContext } from "../src/kernel/preflight.ts";
import { ROOT_POLICY, ROOT_POLICY_HASH } from "../src/kernel/root-policy.ts";
import { runCli } from "../src/cli.ts";

// createPreflightContext binds the real pinned repo and authenticates the
// local OS principal, so these tests run against the canonical repository.

let ctx: ReturnType<typeof createPreflightContext>;

test("preflight: createPreflightContext returns a context with a receipt", () => {
  ctx = createPreflightContext();
  assert.ok(ctx);
  assert.ok(ctx.receipt);
});

test("preflight: the receipt reports harnessReady:false", () => {
  ctx = createPreflightContext();
  assert.equal(ctx.receipt.harnessReady, false);
});

test("preflight: the receipt stage is s1-preflight-only", () => {
  ctx = createPreflightContext();
  assert.equal(ctx.receipt.stage, "s1-preflight-only");
});

test("preflight: the receipt integrityHash is a 64-char hex digest", () => {
  ctx = createPreflightContext();
  assert.match(ctx.receipt.integrityHash, /^[0-9a-f]{64}$/u);
});

test("preflight: the receipt rootPolicyHash matches ROOT_POLICY_HASH", () => {
  ctx = createPreflightContext();
  assert.equal(ctx.receipt.rootPolicyHash, ROOT_POLICY_HASH);
});

test("preflight: the receipt is frozen", () => {
  ctx = createPreflightContext();
  assert.ok(Object.isFrozen(ctx.receipt));
});

test("preflight: the principal binding matches the local OS uid/gid", () => {
  ctx = createPreflightContext();
  assert.equal(ctx.receipt.principal.uid, process.getuid?.());
  assert.equal(ctx.receipt.principal.gid, process.getgid?.());
  assert.equal(ctx.receipt.principal.authentication, "local-os-effective-user");
});

test("preflight: the requirements registry is bound and not directly runtime-read", () => {
  ctx = createPreflightContext();
  assert.equal(ctx.receipt.requirementsRegistry.repositoryManifestBound, true);
  assert.equal(ctx.receipt.requirementsRegistry.directRuntimeRead, false);
  assert.match(ctx.receipt.requirementsRegistry.schemaHash, /^[0-9a-f]{64}$/u);
});

test("preflight: offline contracts and forensics are unavailable in this stage", () => {
  ctx = createPreflightContext();
  assert.equal(ctx.receipt.offlineContracts.transportAvailable, false);
  assert.equal(ctx.receipt.offlineContracts.modelInvocationAvailable, false);
  assert.equal(ctx.receipt.offlineContracts.toolExecutionAvailable, false);
  assert.equal(ctx.receipt.offlineForensics.durableAuditAvailable, false);
  assert.equal(ctx.receipt.offlineForensics.storageAvailable, false);
  assert.equal(ctx.receipt.offlineForensics.forwardingAvailable, false);
});

test("preflight: capabilities are enumerated with no effect authorization", () => {
  ctx = createPreflightContext();
  assert.ok(ctx.receipt.capabilities.length > 0);
  for (const cap of ctx.receipt.capabilities) {
    assert.ok(cap.decision === "allow" || cap.decision === "deny");
    assert.equal(cap.effectAuthorized, false);
  }
});

test("preflight: each capability receipt names its covering policy fact and a remedy when denied", () => {
  ctx = createPreflightContext();
  const policyNames = Object.keys(ROOT_POLICY.capabilities) as Array<keyof typeof ROOT_POLICY.capabilities>;
  assert.deepEqual(
    ctx.receipt.capabilities.map((entry) => entry.capability).toSorted(),
    [...policyNames].toSorted(),
  );
  for (const entry of ctx.receipt.capabilities) {
    assert.equal(entry.evidence.path, "engine/src/kernel/root-policy.ts");
    assert.equal(entry.evidence.field, `capabilities.${entry.capability}`);
    // The named field is the decision's covering fact: it resolves to the same
    // answer the receipt reports (and the receipt's rootPolicyHash covers it).
    assert.equal(entry.decision === "allow", ROOT_POLICY.capabilities[entry.capability]);
    if (entry.decision === "deny") {
      assert.equal(typeof entry.remedy, "string");
      assert.ok(entry.remedy?.includes(`capabilities.${entry.capability}`));
      assert.match(entry.remedy ?? "", /governance gate/u);
    } else {
      assert.equal(entry.remedy, null);
    }
  }
});

test("preflight: inspectPath allows the repository root", () => {
  ctx = createPreflightContext();
  const decision = ctx.inspectPath(".");
  assert.equal(decision.decision, "allow");
  assert.equal(decision.operation, "inspect");
  assert.equal(decision.provisional, true);
  assert.equal(decision.effectAuthorized, false);
  assert.ok(decision.canonicalPath);
});

test("preflight: inspectPath allows a real subdirectory (src)", () => {
  ctx = createPreflightContext();
  const decision = ctx.inspectPath("src");
  assert.equal(decision.decision, "allow");
});

test("preflight: inspectPath allows a real file (package.json)", () => {
  ctx = createPreflightContext();
  const decision = ctx.inspectPath("package.json");
  assert.equal(decision.decision, "allow");
});

test("preflight: inspectPath denies a parent traversal segment", () => {
  ctx = createPreflightContext();
  const decision = ctx.inspectPath("../escape");
  assert.equal(decision.decision, "deny");
  assert.equal(decision.code, "path_traversal_denied");
});

test("preflight: inspectPath denies an internal traversal segment", () => {
  ctx = createPreflightContext();
  const decision = ctx.inspectPath("a/../../../b");
  assert.equal(decision.decision, "deny");
  assert.equal(decision.code, "path_traversal_denied");
});

test("preflight: inspectPath denies an absolute path", () => {
  ctx = createPreflightContext();
  const decision = ctx.inspectPath("/etc/passwd");
  assert.equal(decision.decision, "deny");
  assert.equal(decision.code, "path_invalid");
});

test("preflight: inspectPath denies a path containing a null byte", () => {
  ctx = createPreflightContext();
  const decision = ctx.inspectPath("src\u0000evil.ts");
  assert.equal(decision.decision, "deny");
  assert.equal(decision.code, "path_invalid");
});

test("preflight: inspectPath denies a blank/whitespace path", () => {
  ctx = createPreflightContext();
  const decision = ctx.inspectPath("   ");
  assert.equal(decision.decision, "deny");
  assert.equal(decision.code, "path_invalid");
});

test("preflight: inspectPath denies a non-existent descendant", () => {
  ctx = createPreflightContext();
  const decision = ctx.inspectPath("this-does-not-exist-anywhere/deep");
  assert.equal(decision.decision, "deny");
  assert.equal(decision.code, "path_unavailable");
});

test("preflight: inspectPath decision is frozen", () => {
  ctx = createPreflightContext();
  const decision = ctx.inspectPath(".");
  assert.ok(Object.isFrozen(decision));
});

test("preflight: classify returns a ClassificationDecision", () => {
  ctx = createPreflightContext();
  const decision = ctx.classify({ foo: "bar" });
  assert.equal(decision.decision, "classified");
  assert.equal(decision.code, "classification_complete");
  assert.ok(typeof decision.classification === "string");
  assert.ok(typeof decision.payloadHash === "string");
  assert.ok(Array.isArray(decision.signalCategories));
});

test("preflight: decideEgress returns a deny EgressDecision", () => {
  ctx = createPreflightContext();
  const classification = ctx.classify({ foo: "bar" });
  const egress = ctx.decideEgress("external-destination", classification);
  assert.equal(egress.decision, "deny");
  assert.equal(egress.code, "egress_disabled_by_root_policy");
  assert.match(egress.destinationHash, /^[0-9a-f]{64}$/u);
  assert.equal(egress.classification, classification.classification);
  assert.equal(egress.policyHash, ROOT_POLICY_HASH);
  assert.ok(Object.isFrozen(egress));
});

test("preflight: isIssuedPreflightContext recognizes the issued context", () => {
  ctx = createPreflightContext();
  assert.equal(isIssuedPreflightContext(ctx), true);
});

test("preflight: isIssuedPreflightContext rejects a plain object", () => {
  assert.equal(isIssuedPreflightContext({ receipt: {} }), false);
});

test("preflight: isIssuedPreflightContext rejects null and primitives", () => {
  assert.equal(isIssuedPreflightContext(null), false);
  assert.equal(isIssuedPreflightContext(42), false);
  assert.equal(isIssuedPreflightContext("ctx"), false);
});

test("preflight: repeated inspectPath on root is stable (idempotent allow)", () => {
  ctx = createPreflightContext();
  const a = ctx.inspectPath(".");
  const b = ctx.inspectPath(".");
  assert.equal(a.decision, "allow");
  assert.equal(b.decision, "allow");
});

// ========== BUG-3 (RES-1): cli.ts must surface real errors ==========

test("BUG-3 prevention: cli.ts does not hide errors behind 'Preflight failed safely' (RES-1)", () => {
  const src = readFileSync(join(process.cwd(), "src/cli.ts"), "utf8");
  assert.equal(
    src.includes("Preflight failed safely"),
    false,
    "cli.ts must not use the hardcoded 'Preflight failed safely' message — surface the real error (RES-1)",
  );
  assert.ok(
    src.includes("safeError"),
    "cli.ts must use safeError (which surfaces real errors via extractErrorMessage) for non-HarnessError messages (RES-1)",
  );
});

test("cli: runCli surfaces the real error message for unknown commands (RES-1)", async () => {
  const originalWrite = process.stderr.write.bind(process.stderr);
  let captured = "";
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await runCli(["bogus-command-xyz"]);
    assert.equal(code, 1);
  } finally {
    process.stderr.write = originalWrite;
  }
  const parsed = JSON.parse(captured.trim()) as { error: string; message: string; retryable: boolean };
  assert.equal(parsed.error, "command_unavailable");
  assert.equal(
    parsed.message,
    "Unknown command: bogus-command-xyz (top-level commands: preflight, quality, harness)",
  );
  assert.notEqual(parsed.message, "Preflight failed safely");
});
