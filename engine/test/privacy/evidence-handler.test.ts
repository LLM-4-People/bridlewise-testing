import assert from "node:assert/strict";
import test from "node:test";

import { createPrivacyPolicy } from "../../src/privacy/privacy-policy.ts";
import {
  createEvidenceReceipt,
  homePathsAsTilde,
  markUnparseable,
  persistableText,
  redactEvidence,
  redactForDisplay,
  redactForLog,
  redactForPersistence,
  type EvidenceAdmissionStatus,
  type EvidenceRedactionAdmitted,
  type EvidenceRedactionResult,
} from "../../src/privacy/evidence-handler.ts";

/**
 * Narrow an evidence result to the admitted variant, asserting on the way
 * through. Every read of `redactedContent` goes through this, so a test that
 * expects content also states that the evidence was not refused — which is
 * the distinction the old `redactedContent: ""` shape could not make.
 */
function admitted(result: EvidenceRedactionResult): EvidenceRedactionAdmitted {
  assert.notEqual(
    result.status,
    "blocked",
    `expected admitted evidence; it was refused: ${result.status === "blocked" ? result.blockReason : ""}`,
  );
  return result as EvidenceRedactionAdmitted;
}


test("persistableText: a home directory is spelled ~ — this process's home and any /home/<name>, a whole segment only (#238)", () => {
  assert.equal(homePathsAsTilde("log at /srv/me/a, /srv/me and /srv/me2/b", "/srv/me"), "log at ~/a, ~ and /srv/me2/b");
  assert.equal(homePathsAsTilde("from /home/jdoe/.cache/x and /home/alice", "/srv/me"), "from ~/.cache/x and ~");
  assert.equal(homePathsAsTilde("nothing here: /homes/x /var/tmp", "/srv/me"), "nothing here: /homes/x /var/tmp");
  assert.equal(homePathsAsTilde("/", "/"), "/", "a root home names nobody and is left alone");
  const kept = persistableText("full output (9 bytes): /home/jdoe/.cache/run.log");
  assert.equal(kept, "full output (9 bytes): ~/.cache/run.log");
});

// ---------------------------------------------------------------------------
// Section 1: redactForPersistence — basic behavior
// ---------------------------------------------------------------------------

test("redactForPersistence: clean content returns status 'clean'", () => {
  const result = redactForPersistence("hello world");
  assert.equal(result.status, "clean");
  assert.equal(admitted(result).redactedContent, "hello world");
  assert.equal(result.metadata.spanCount, 0);
});

test("redactForPersistence: secret content returns status 'redacted'", () => {
  const result = redactForPersistence(("api_key = sk" + "_abcdefghijklmnopqrstuvwx"));
  assert.equal(result.status, "redacted");
  assert.ok(result.metadata.spanCount > 0);
  assert.ok(!admitted(result).redactedContent.includes(("sk" + "_abcdefghijklmnopqrstuvwx")));
  assert.ok(admitted(result).redactedContent.includes("[REDACTED:"));
});

test("redactForPersistence: redacted content has no residual secrets", () => {
  const result = redactForPersistence(("api_key = sk" + "_abcdefghijklmnopqrstuvwx"));
  assert.equal(result.metadata.verified, true);
  assert.equal(result.metadata.residualSpanCount, 0);
});

test("redactForPersistence: metadata does not expose original content", () => {
  const result = redactForPersistence(("api_key = sk" + "_abcdefghijklmnopqrstuvwx"));
  const metaJson = JSON.stringify(result.metadata);
  assert.ok(!metaJson.includes(("sk" + "_abcdefghijklmnopqrstuvwx")));
});

test("redactForPersistence: empty string returns status 'clean'", () => {
  const result = redactForPersistence("");
  assert.equal(result.status, "clean");
  assert.equal(admitted(result).redactedContent, "");
});

test("redactForPersistence: non-string content returns status 'blocked'", () => {
  const result = redactForPersistence(null as unknown as string);
  assert.equal(result.status, "blocked");
  assert.ok(result.blockReason);
});

// ---------------------------------------------------------------------------
// Section 2: redactForDisplay
// ---------------------------------------------------------------------------

test("redactForDisplay: clean content returns status 'clean'", () => {
  const result = redactForDisplay("hello world");
  assert.equal(result.status, "clean");
});

test("redactForDisplay: secret content returns status 'redacted'", () => {
  const result = redactForDisplay(("api_key = sk" + "_abcdefghijklmnopqrstuvwx"));
  assert.equal(result.status, "redacted");
  assert.ok(!admitted(result).redactedContent.includes("sk_"));
});

test("redactForDisplay: preserves structure around secrets", () => {
  const text = ('config = {\n  api_key = "sk' + '_abcdefghijklmnopqrstuvwx"\n}');
  const result = redactForDisplay(text);
  assert.ok(admitted(result).redactedContent.includes("config = {"));
  assert.ok(admitted(result).redactedContent.includes("}"));
});

// ---------------------------------------------------------------------------
// Section 3: redactForLog
// ---------------------------------------------------------------------------

test("redactForLog: clean content returns status 'clean'", () => {
  const result = redactForLog("hello world");
  assert.equal(result.status, "clean");
});

test("redactForLog: secret content is redacted", () => {
  const result = redactForLog(("api_key = sk" + "_abcdefghijklmnopqrstuvwx"));
  assert.equal(result.status, "redacted");
  assert.ok(!admitted(result).redactedContent.includes("sk_"));
});

test("redactForLog: metadata does not contain secrets", () => {
  const result = redactForLog(("api_key = sk" + "_abcdefghijklmnopqrstuvwx"));
  // Witness: the planted secret reached the redactor and was found.
  assert.equal(result.status, "redacted");
  assert.ok(result.metadata.spanCount > 0);
  assert.ok(!JSON.stringify(result.metadata).includes("sk_"));
});

// ---------------------------------------------------------------------------
// Section 4: redactEvidence — general
// ---------------------------------------------------------------------------

test("redactEvidence: clean content", () => {
  const result = redactEvidence("hello world");
  assert.equal(result.status, "clean");
  assert.equal(result.metadata.spanCount, 0);
});

test("redactEvidence: secret content", () => {
  const result = redactEvidence(("api_key = sk" + "_abcdefghijklmnopqrstuvwx"));
  assert.equal(result.status, "redacted");
  assert.ok(result.metadata.spanCount > 0);
});

test("redactEvidence: uses provided policy", () => {
  const customPolicy = createPrivacyPolicy({
    redactionPrefix: "<HIDDEN:",
    redactionSuffix: ">",
  });
  const result = redactEvidence(("api_key = sk" + "_abcdefghijklmnopqrstuvwx"), { policy: customPolicy });
  assert.ok(admitted(result).redactedContent.includes("<HIDDEN:"));
});

test("redactEvidence: AWS key redacted", () => {
  const result = redactEvidence(("key = AK" + "IAIOSFODNN7EXAMPLE"));
  assert.ok(result.metadata.spanCount > 0);
  assert.ok(admitted(result).redactedContent.includes("[REDACTED:"), "witness: the planted key was redacted in this subject");
  assert.ok(!admitted(result).redactedContent.includes("AKIA"));
});

test("redactEvidence: Bearer token redacted", () => {
  const result = redactEvidence(("Authorization: Be" + "arer abcdefghijklmnopqrstuv1234567890"));
  assert.ok(result.metadata.spanCount > 0);
});

test("redactEvidence: private key header redacted", () => {
  const result = redactEvidence(("--" + "---BEGIN RSA PRIVATE KEY-----"));
  assert.ok(result.metadata.spanCount > 0);
});

test("redactEvidence: multiple secrets in one string", () => {
  const result = redactEvidence(("sk" + "_abcdefghijklmnopqrstuvwx and gh" + "p_abcdefghijklmnopqrstuvwx"));
  assert.ok(result.metadata.spanCount >= 2);
});

// ---------------------------------------------------------------------------
// Section 5: markUnparseable — blocks semantic claims
// ---------------------------------------------------------------------------

test("markUnparseable: returns status 'unparseable'", () => {
  const result = markUnparseable("some content", "unsupported_format");
  assert.equal(result.status, "unparseable");
});

test("markUnparseable: does NOT return 'clean'", () => {
  const result = markUnparseable("some content", "unsupported_format");
  assert.notEqual(result.status, "clean");
});

test("markUnparseable: block reason is preserved", () => {
  const result = markUnparseable("content", "binary_file_detected");
  assert.equal(result.blockReason, "binary_file_detected");
});

test("markUnparseable: content is still redacted", () => {
  const result = markUnparseable(("api_key = sk" + "_abcdefghijklmnopqrstuvwx"), "parse_error");
  assert.ok(!admitted(result).redactedContent.includes("sk_"));
  assert.ok(admitted(result).redactedContent.includes("[REDACTED:"));
});

test("markUnparseable: empty content returns zero spans", () => {
  const result = markUnparseable("", "empty_file");
  assert.equal(result.metadata.spanCount, 0);
});

test("markUnparseable: the status is visible (not hidden)", () => {
  const result = markUnparseable("content", "reason");
  assert.ok(result.status === "unparseable");
  assert.ok(result.blockReason !== undefined);
});

// ---------------------------------------------------------------------------
// C3 regression: verifyRedaction is called in markUnparseable
// ---------------------------------------------------------------------------

test("C3 markUnparseable: verified is computed true for redacted content", () => {
  const result = markUnparseable(("api_key = sk" + "_abcdefghijklmnopqrstuvwx"), "parse_error");
  assert.equal(result.metadata.verified, true);
  assert.equal(result.metadata.residualSpanCount, 0);
});

test("C3 markUnparseable: verified is computed true for clean content", () => {
  const result = markUnparseable("some clean content", "unsupported_format");
  assert.equal(result.metadata.verified, true);
  assert.equal(result.metadata.residualSpanCount, 0);
});

test("C3 markUnparseable: verified is computed true for empty content", () => {
  const result = markUnparseable("", "empty_file");
  assert.equal(result.metadata.verified, true);
  assert.equal(result.metadata.residualSpanCount, 0);
});

test("C3 markUnparseable: blocks when redaction replacement itself is a secret", () => {
  const leakyPolicy = createPrivacyPolicy({
    redactionPrefix: ("sk" + "_abcdefghijklmnopqrstuvwx"),
    redactionSuffix: "",
  });
  const result = markUnparseable("password = MyS3cretPassw0rd12345678", "test_reason", { policy: leakyPolicy });
  assert.equal(result.status, "blocked");
  assert.ok(!("redactedContent" in result), "a refusal must not carry content — an empty string reads as clean, empty evidence");
  assert.equal(result.metadata.verified, false);
  assert.ok(result.metadata.residualSpanCount > 0);
  assert.equal(result.blockReason, "redaction_incomplete_residual_secrets_detected");
});

// ---------------------------------------------------------------------------
// Section 6: createEvidenceReceipt
// ---------------------------------------------------------------------------

test("createEvidenceReceipt: returns hash and status for clean evidence", () => {
  const result = redactForPersistence("hello world");
  const receipt = createEvidenceReceipt(result);
  assert.equal(receipt.status, "clean");
  assert.equal(receipt.spanCount, 0);
  assert.ok(/^[0-9a-f]{64}$/.test(receipt.receiptHash));
});

test("createEvidenceReceipt: returns hash and status for redacted evidence", () => {
  const result = redactForPersistence(("api_key = sk" + "_abcdefghijklmnopqrstuvwx"));
  const receipt = createEvidenceReceipt(result);
  assert.equal(receipt.status, "redacted");
  assert.ok(receipt.spanCount > 0);
  assert.ok(/^[0-9a-f]{64}$/.test(receipt.receiptHash));
});

test("createEvidenceReceipt: returns hash and status for unparseable evidence", () => {
  const result = markUnparseable("content", "reason");
  const receipt = createEvidenceReceipt(result);
  assert.equal(receipt.status, "unparseable");
  assert.ok(receipt.blockReason === "reason");
});

test("createEvidenceReceipt: receipt hash is deterministic for same input", () => {
  const result1 = redactForPersistence(("api_key = sk" + "_abcdefghijklmnopqrstuvwx"));
  const result2 = redactForPersistence(("api_key = sk" + "_abcdefghijklmnopqrstuvwx"));
  const receipt1 = createEvidenceReceipt(result1);
  const receipt2 = createEvidenceReceipt(result2);
  assert.equal(receipt1.receiptHash, receipt2.receiptHash);
});

test("createEvidenceReceipt: receipt hash differs for different inputs", () => {
  const result1 = redactForPersistence(("api_key = sk" + "_abcdefghijklmnopqrstuvwx"));
  const result2 = redactForPersistence(("api_key = gh" + "p_abcdefghijklmnopqrstuvwx"));
  const receipt1 = createEvidenceReceipt(result1);
  const receipt2 = createEvidenceReceipt(result2);
  assert.notEqual(receipt1.receiptHash, receipt2.receiptHash);
});

test("createEvidenceReceipt: receipt does not expose secrets", () => {
  const result = redactForPersistence(("api_key = sk" + "_abcdefghijklmnopqrstuvwx"));
  const receipt = createEvidenceReceipt(result);
  const receiptJson = JSON.stringify(receipt);
  assert.ok(!receiptJson.includes(("sk" + "_abcdefghijklmnopqrstuvwx")));
});

// ---------------------------------------------------------------------------
// Section 7: EvidenceAdmissionStatus values
// ---------------------------------------------------------------------------

test("EvidenceAdmissionStatus includes 'clean'", () => {
  const status: EvidenceAdmissionStatus = "clean";
  assert.equal(status, "clean");
});

test("EvidenceAdmissionStatus includes 'redacted'", () => {
  const status: EvidenceAdmissionStatus = "redacted";
  assert.equal(status, "redacted");
});

test("EvidenceAdmissionStatus includes 'unparseable'", () => {
  const status: EvidenceAdmissionStatus = "unparseable";
  assert.equal(status, "unparseable");
});

test("EvidenceAdmissionStatus includes 'blocked'", () => {
  const status: EvidenceAdmissionStatus = "blocked";
  assert.equal(status, "blocked");
});

// ---------------------------------------------------------------------------
// Section 8: Integration with redaction engine
// ---------------------------------------------------------------------------

test("redactForPersistence: byte lengths are recorded", () => {
  const result = redactForPersistence(("api_key = sk" + "_abcdefghijklmnopqrstuvwx"));
  assert.ok(result.metadata.originalByteLength > 0);
  assert.ok(result.metadata.redactedByteLength > 0);
});

test("redactForPersistence: redaction map hash is 64-char hex", () => {
  const result = redactForPersistence(("api_key = sk" + "_abcdefghijklmnopqrstuvwx"));
  assert.ok(/^[0-9a-f]{64}$/.test(result.metadata.redactionMapHash));
});

test("redactForPersistence: verified is true for complete redaction", () => {
  const result = redactForPersistence(("api_key = sk" + "_abcdefghijklmnopqrstuvwx"));
  assert.equal(result.metadata.verified, true);
});

test("redactForPersistence: result is frozen", () => {
  const result = redactForPersistence("hello");
  assert.ok(Object.isFrozen(result));
});

test("redactEvidence: preserves line count for multi-line content", () => {
  const text = ("line1\napi_key = sk" + "_abcdefghijklmnopqrstuvwx\nline3");
  const result = redactEvidence(text);
  assert.equal(admitted(result).redactedContent.split("\n").length, 3);
});

// ---------------------------------------------------------------------------
// Section 9: Hostile / edge cases
// ---------------------------------------------------------------------------

test("redactForPersistence: handles very long content with secrets", () => {
  const lines: string[] = [];
  for (let i = 0; i < 50; i += 1) {
    lines.push(`line ${i}: api_key = sk_value_${i}_abcdefghijklmnopqr`);
  }
  const result = redactForPersistence(lines.join("\n"));
  assert.ok(result.metadata.spanCount > 0);
  assert.ok(!admitted(result).redactedContent.includes("sk_value_"));
});

test("redactForPersistence: handles unicode content with secrets", () => {
  const text = ("café 𝕏 日本語 api_key = sk" + "_abcdefghijklmnopqrstuvwx");
  const result = redactForPersistence(text);
  assert.ok(result.metadata.spanCount > 0);
});

test("redactForPersistence: content with only safe text is clean", () => {
  const text = "const config = { debug: true, port: 3000 };";
  const result = redactForPersistence(text);
  assert.equal(result.status, "clean");
});

test("redactForDisplay: content with only safe text is clean", () => {
  const text = "function foo() { return 42; }";
  const result = redactForDisplay(text);
  assert.equal(result.status, "clean");
});

test("redactForLog: content with only safe text is clean", () => {
  const text = "import { bar } from 'baz';";
  const result = redactForLog(text);
  assert.equal(result.status, "clean");
});

test("redactEvidence: result is frozen", () => {
  const result = redactEvidence("hello");
  assert.ok(Object.isFrozen(result));
});

test("redactEvidence: result has redactionResult attached", () => {
  const result = redactEvidence(("api_key = sk" + "_abcdefghijklmnopqrstuvwx"));
  assert.ok(result.redactionResult);
  assert.ok(result.redactionResult.spanCount > 0);
});
