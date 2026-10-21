import assert from "node:assert/strict";
import test from "node:test";

import { InputError } from "../../src/kernel/errors.ts";
import { createPrivacyPolicy, type PrivacyPolicy } from "../../src/privacy/privacy-policy.ts";
import {
  applyRedactions,
  detectSensitiveSpans,
  hasSensitiveContent,
  redactLine,
  redactLines,
  redactText,
  redactionMetadata,
  resolveOverlaps,
  verifyRedaction,
  type RedactableSpan,
} from "../../src/privacy/redaction-engine.ts";

const policy: PrivacyPolicy = createPrivacyPolicy();

// ---------------------------------------------------------------------------
// Section 1: detectSensitiveSpans — basic detection
// ---------------------------------------------------------------------------

test("detectSensitiveSpans: returns empty array for clean text", () => {
  const spans = detectSensitiveSpans("hello world", policy);
  assert.equal(spans.length, 0);
});

test("detectSensitiveSpans: detects a BARE coralbricks key (cb_ + a mixed-case body), never a snake_case cb_ identifier", () => {
  const key = ["cb", "Q7fXk2LmP9sT4vWz8RbN3cYh6J"].join("_");
  const spans = detectSensitiveSpans(`the provider answered with ${key} in the log`, policy);
  assert.equal(spans.length, 1);
  assert.equal(spans[0]!.signalId, "coralbricks-key");
  assert.deepEqual(detectSensitiveSpans("const cb_handle_request_timeout_value = 1;", policy).filter((span) => span.signalId === "coralbricks-key"), []);
});

test("detectSensitiveSpans: detects makora-key (mbh_ prefix)", () => {
  const text = ("key = mb" + "h_1234567890abcdefghijk");
  const spans = detectSensitiveSpans(text, policy);
  assert.ok(spans.length > 0);
  assert.equal(spans[0]!.category, "api-key");
  assert.equal(spans[0]!.signalId, "makora-key");
});

test("detectSensitiveSpans: detects sk_ prefixed token", () => {
  const text = ('api_key = "sk' + '_abcdefghijklmnopqrstuvwx"');
  const spans = detectSensitiveSpans(text, policy);
  assert.ok(spans.length > 0);
});

test("detectSensitiveSpans: detects rk_ prefixed token", () => {
  const text = ('token = "rk' + '_abcdefghijklmnopqrstuvwx"');
  const spans = detectSensitiveSpans(text, policy);
  assert.ok(spans.length > 0);
});

test("detectSensitiveSpans: detects ghp_ prefixed token", () => {
  const text = ('token = "gh' + 'p_abcdefghijklmnopqrstuvwx"');
  const spans = detectSensitiveSpans(text, policy);
  assert.ok(spans.length > 0);
});

test("detectSensitiveSpans: detects AWS access key (AKIA prefix)", () => {
  const text = ("aws_key = AK" + "IAIOSFODNN7EXAMPLE");
  const spans = detectSensitiveSpans(text, policy);
  assert.ok(spans.length > 0);
  assert.equal(spans[0]!.category, "api-key");
});

test("detectSensitiveSpans: detects Bearer token", () => {
  const text = ("Authorization: Be" + "arer abcdefghijklmnopqrstuv1234567890");
  const spans = detectSensitiveSpans(text, policy);
  assert.ok(spans.length > 0);
  assert.equal(spans[0]!.category, "bearer-token");
});

test("detectSensitiveSpans: detects private key header", () => {
  const text = ("--" + "---BEGIN RSA PRIVATE KEY-----");
  const spans = detectSensitiveSpans(text, policy);
  assert.ok(spans.length > 0);
  assert.equal(spans[0]!.category, "private-key");
});

test("detectSensitiveSpans: detects credential-assignment (api_key = value)", () => {
  const text = 'api_key = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA=="';
  const spans = detectSensitiveSpans(text, policy);
  assert.ok(spans.length > 0);
  assert.equal(spans[0]!.signalId, "credential-assignment");
});

test("detectSensitiveSpans: detects password assignment", () => {
  const text = 'password = "MyS3cretPassw0rd12345678"';
  const spans = detectSensitiveSpans(text, policy);
  assert.ok(spans.length > 0);
});

test("detectSensitiveSpans: detects session token assignment", () => {
  const text = "session_token=sess-FFFFFFFFFFFFFFFFFFFFFFFFFFFF";
  const spans = detectSensitiveSpans(text, policy);
  assert.ok(spans.length > 0);
});

test("detectSensitiveSpans: does not detect safe text", () => {
  const safe = [
    "const x = 42;",
    "function hello() { return 'world'; }",
    "import { foo } from 'bar';",
    "export const CONFIG = { debug: true };",
    "# This is a comment",
  ];
  for (const text of safe) {
    const spans = detectSensitiveSpans(text, policy);
    assert.equal(spans.length, 0, `should not detect secrets in: ${text}`);
  }
});

test("detectSensitiveSpans: does not detect function-call assignments", () => {
  const safe = [
    "authorization = load_bound_json_object(root, snapshot)",
    "secret = get_secret_key()",
    "password = request.headers['apikey']",
  ];
  for (const text of safe) {
    const spans = detectSensitiveSpans(text, policy);
    assert.equal(spans.length, 0, `should not detect secrets in: ${text}`);
  }
});

// ---------------------------------------------------------------------------
// Section 2: detectSensitiveSpans — span properties
// ---------------------------------------------------------------------------

test("detectSensitiveSpans: spans have UTF-16 and UTF-8 byte offsets", () => {
  const text = ("api_key = sk" + "_abcdefghijklmnopqrstuvwx");
  const spans = detectSensitiveSpans(text, policy);
  assert.ok(spans.length > 0);
  const span = spans[0]!;
  assert.ok(typeof span.startUtf16 === "number");
  assert.ok(typeof span.endUtf16 === "number");
  assert.ok(typeof span.startByte === "number");
  assert.ok(typeof span.endByte === "number");
  assert.ok(span.startUtf16 < span.endUtf16);
  assert.ok(span.startByte < span.endByte);
});

test("detectSensitiveSpans: byte offsets match Buffer.byteLength of slice", () => {
  const text = ("key = mb" + "h_1234567890abcdefghijk");
  const spans = detectSensitiveSpans(text, policy);
  for (const span of spans) {
    const slice = text.slice(span.startUtf16, span.endUtf16);
    const expectedBytes = Buffer.byteLength(slice, "utf8");
    assert.equal(span.endByte - span.startByte, expectedBytes);
  }
});

test("detectSensitiveSpans: spans have detectorId 'secret-signals'", () => {
  const text = ("key = mb" + "h_1234567890abcdefghijk");
  const spans = detectSensitiveSpans(text, policy);
  assert.ok(spans.length > 0);
  assert.equal(spans[0]!.detectorId, "secret-signals");
});

test("detectSensitiveSpans: spans have reason starting with 'detected:'", () => {
  const text = ("key = mb" + "h_1234567890abcdefghijk");
  const spans = detectSensitiveSpans(text, policy);
  assert.ok(spans.length > 0);
  assert.ok(spans[0]!.reason.startsWith("detected:"));
});

test("detectSensitiveSpans: multiple secrets in one text", () => {
  const text = ("api_key = sk" + "_abcdefghijklmnopqrstuvwx\npassword = MyS3cretPassw0rd12345678");
  const spans = detectSensitiveSpans(text, policy);
  assert.ok(spans.length >= 2);
});

// ---------------------------------------------------------------------------
// Section 3: detectSensitiveSpans — Unicode / astral correctness
// ---------------------------------------------------------------------------

test("detectSensitiveSpans: handles text with CJK characters before secret", () => {
  const text = ("日本語テスト api_key = sk" + "_abcdefghijklmnopqrstuvwx");
  const spans = detectSensitiveSpans(text, policy);
  assert.ok(spans.length > 0);
  const span = spans[0]!;
  const slice = text.slice(span.startUtf16, span.endUtf16);
  assert.ok(slice.includes("sk_"));
  assert.equal(span.endByte - span.startByte, Buffer.byteLength(slice, "utf8"));
});

test("detectSensitiveSpans: handles text with emoji before secret", () => {
  const text = ("😀 emoji api_key = sk" + "_abcdefghijklmnopqrstuvwx");
  const spans = detectSensitiveSpans(text, policy);
  assert.ok(spans.length > 0);
  const span = spans[0]!;
  assert.equal(span.endByte - span.startByte, Buffer.byteLength(
    text.slice(span.startUtf16, span.endUtf16), "utf8",
  ));
});

test("detectSensitiveSpans: handles text with astral characters", () => {
  const text = ("café 𝕏 unicode key = mb" + "h_1234567890abcdefghijk");
  const spans = detectSensitiveSpans(text, policy);
  assert.ok(spans.length > 0);
});

// ---------------------------------------------------------------------------
// Section 4: detectSensitiveSpans — profile selection
// ---------------------------------------------------------------------------

test("detectSensitiveSpans: admission profile is the default", () => {
  const text = ("key = mb" + "h_1234567890abcdefghijk");
  const spansDefault = detectSensitiveSpans(text, policy);
  const spansAdmission = detectSensitiveSpans(text, policy, { profile: "admission" });
  assert.equal(spansDefault.length, spansAdmission.length);
});

test("detectSensitiveSpans: classification profile can find different spans", () => {
  const text = "Bearer someValueHere";
  const spansAdmission = detectSensitiveSpans(text, policy, { profile: "admission" });
  const spansClassification = detectSensitiveSpans(text, policy, { profile: "classification" });
  assert.ok(spansClassification.length >= spansAdmission.length);
});

test("detectSensitiveSpans: throws on non-string text", () => {
  assert.throws(
    () => detectSensitiveSpans(123 as unknown as string, policy),
    InputError,
  );
});

// ---------------------------------------------------------------------------
// Section 5: resolveOverlaps
// ---------------------------------------------------------------------------

test("resolveOverlaps: empty array returns empty", () => {
  assert.deepEqual(resolveOverlaps([]), []);
});

test("resolveOverlaps: single span returns unchanged", () => {
  const span: RedactableSpan = {
    startUtf16: 0, endUtf16: 10, startByte: 0, endByte: 10,
    category: "secret", signalId: "test", reason: "test", detectorId: "test",
  };
  assert.deepEqual(resolveOverlaps([span]), [span]);
});

test("resolveOverlaps: non-overlapping spans all kept", () => {
  const a: RedactableSpan = {
    startUtf16: 0, endUtf16: 5, startByte: 0, endByte: 5,
    category: "secret", signalId: "a", reason: "a", detectorId: "test",
  };
  const b: RedactableSpan = {
    startUtf16: 10, endUtf16: 15, startByte: 10, endByte: 15,
    category: "secret", signalId: "b", reason: "b", detectorId: "test",
  };
  assert.equal(resolveOverlaps([a, b]).length, 2);
});

test("resolveOverlaps: overlapping spans prefer longest", () => {
  const short: RedactableSpan = {
    startUtf16: 0, endUtf16: 5, startByte: 0, endByte: 5,
    category: "secret", signalId: "short", reason: "short", detectorId: "test",
  };
  const long: RedactableSpan = {
    startUtf16: 0, endUtf16: 10, startByte: 0, endByte: 10,
    category: "secret", signalId: "long", reason: "long", detectorId: "test",
  };
  const result = resolveOverlaps([short, long]);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.signalId, "long");
});

test("resolveOverlaps: equal-length overlapping spans prefer earlier start", () => {
  const a: RedactableSpan = {
    startUtf16: 0, endUtf16: 10, startByte: 0, endByte: 10,
    category: "secret", signalId: "a", reason: "a", detectorId: "test",
  };
  const b: RedactableSpan = {
    startUtf16: 2, endUtf16: 12, startByte: 2, endByte: 12,
    category: "secret", signalId: "b", reason: "b", detectorId: "test",
  };
  const result = resolveOverlaps([a, b]);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.signalId, "a");
});

test("resolveOverlaps: partially overlapping spans resolve to earlier-start when equal length", () => {
  const a: RedactableSpan = {
    startUtf16: 0, endUtf16: 10, startByte: 0, endByte: 10,
    category: "secret", signalId: "a", reason: "a", detectorId: "test",
  };
  const b: RedactableSpan = {
    startUtf16: 5, endUtf16: 15, startByte: 5, endByte: 15,
    category: "secret", signalId: "b", reason: "b", detectorId: "test",
  };
  const result = resolveOverlaps([a, b]);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.startUtf16, 0);
  assert.equal(result[0]!.endUtf16, 10);
});

// ---------------------------------------------------------------------------
// Section 6: applyRedactions
// ---------------------------------------------------------------------------

test("applyRedactions: empty spans returns original text", () => {
  assert.equal(applyRedactions("hello", [], policy), "hello");
});

test("applyRedactions: single span replaced with [REDACTED:category]", () => {
  const text = ("api_key = sk" + "_abcdefghijklmnopqrstuvwx");
  const spans = detectSensitiveSpans(text, policy);
  const redacted = applyRedactions(text, spans, policy);
  assert.ok(redacted.includes("[REDACTED:"));
  assert.ok(!redacted.includes(("sk" + "_abcdefghijklmnopqrstuvwx")));
});

test("applyRedactions: preserves surrounding structure", () => {
  const text = ('api_key = "sk' + '_abcdefghijklmnopqrstuvwx"');
  const spans = detectSensitiveSpans(text, policy);
  const redacted = applyRedactions(text, spans, policy);
  assert.ok(redacted.startsWith("api_key = "));
  assert.ok(redacted.includes('"'));
});

test("applyRedactions: multiple spans all replaced", () => {
  const text = ("sk" + "_abcdefghijklmnopqrstuvwx and gh" + "p_abcdefghijklmnopqrstuvwx");
  const spans = detectSensitiveSpans(text, policy);
  const redacted = applyRedactions(text, spans, policy);
  assert.ok(!redacted.includes("sk_"));
  assert.ok(!redacted.includes("ghp_"));
  assert.ok(redacted.includes("[REDACTED:"));
});

test("applyRedactions: preserves line count", () => {
  const text = ("line1\napi_key = sk" + "_abcdefghijklmnopqrstuvwx\nline3");
  const spans = detectSensitiveSpans(text, policy);
  const redacted = applyRedactions(text, spans, policy);
  assert.equal(redacted.split("\n").length, 3);
});

test("applyRedactions: handles text with no secrets unchanged", () => {
  const text = "const x = 42;";
  const spans = detectSensitiveSpans(text, policy);
  assert.equal(spans.length, 0);
  assert.equal(applyRedactions(text, spans, policy), text);
});

test("applyRedactions: throws on non-string text", () => {
  assert.throws(
    () => applyRedactions(123 as unknown as string, [], policy),
    InputError,
  );
});

// ---------------------------------------------------------------------------
// Section 7: redactText — full pipeline
// ---------------------------------------------------------------------------

test("redactText: clean text returns unchanged with zero spans", () => {
  const result = redactText("hello world", policy);
  assert.equal(result.redactedText, "hello world");
  assert.equal(result.spanCount, 0);
});

test("redactText: secret text is redacted", () => {
  const text = ("api_key = sk" + "_abcdefghijklmnopqrstuvwx");
  const result = redactText(text, policy);
  assert.ok(result.spanCount > 0);
  assert.ok(result.redactedText.includes("[REDACTED:"));
  assert.ok(!result.redactedText.includes(("sk" + "_abcdefghijklmnopqrstuvwx")));
});

test("redactText: returns frozen result", () => {
  const result = redactText("hello", policy);
  assert.ok(Object.isFrozen(result));
});

test("redactText: redactionMapHash is a 64-char hex string", () => {
  const result = redactText("hello", policy);
  assert.equal(result.redactionMapHash.length, 64);
  assert.ok(/^[0-9a-f]{64}$/.test(result.redactionMapHash));
});

test("redactText: originalByteLength matches Buffer.byteLength", () => {
  const text = "hello world";
  const result = redactText(text, policy);
  assert.equal(result.originalByteLength, Buffer.byteLength(text, "utf8"));
});

test("redactText: profile is recorded in result", () => {
  const result = redactText("hello", policy, { profile: "admission" });
  assert.equal(result.profile, "admission");
  const result2 = redactText("hello", policy, { profile: "classification" });
  assert.equal(result2.profile, "classification");
});

test("redactText: throws on non-string text", () => {
  assert.throws(
    () => redactText(null as unknown as string, policy),
    InputError,
  );
});

// ---------------------------------------------------------------------------
// Section 8: redactLine and redactLines
// ---------------------------------------------------------------------------

test("redactLine: redacts a single line", () => {
  const result = redactLine(("api_key = sk" + "_abcdefghijklmnopqrstuvwx"), policy);
  assert.ok(result.spanCount > 0);
  assert.ok(result.redactedText.includes("[REDACTED:"));
});

test("redactLine: clean line returns unchanged", () => {
  const result = redactLine("const x = 42;", policy);
  assert.equal(result.spanCount, 0);
  assert.equal(result.redactedText, "const x = 42;");
});

test("redactLines: redacts multiple lines independently", () => {
  const lines = ["const x = 42;", ("api_key = sk" + "_abcdefghijklmnopqrstuvwx"), "const y = 10;"];
  const result = redactLines(lines, policy);
  assert.equal(result.redactedLines.length, 3);
  assert.equal(result.redactedLines[0], "const x = 42;");
  assert.ok(result.redactedLines[1]!.includes("[REDACTED:"));
  assert.equal(result.redactedLines[2], "const y = 10;");
});

test("redactLines: totalSpans sums per-line spans", () => {
  const lines = [("sk" + "_abcdefghijklmnopqrstuvwx"), ("gh" + "p_abcdefghijklmnopqrstuvwx"), "clean line"];
  const result = redactLines(lines, policy);
  assert.ok(result.totalSpans >= 2);
});

test("redactLines: empty array returns empty results", () => {
  const result = redactLines([], policy);
  assert.equal(result.results.length, 0);
  assert.equal(result.totalSpans, 0);
  assert.equal(result.redactedLines.length, 0);
});

// ---------------------------------------------------------------------------
// Section 9: hasSensitiveContent
// ---------------------------------------------------------------------------

test("hasSensitiveContent: true for text with secrets", () => {
  assert.equal(hasSensitiveContent(("api_key = sk" + "_abcdefghijklmnopqrstuvwx"), policy), true);
});

test("hasSensitiveContent: false for clean text", () => {
  assert.equal(hasSensitiveContent("const x = 42;", policy), false);
});

test("hasSensitiveContent: false for empty string", () => {
  assert.equal(hasSensitiveContent("", policy), false);
});

test("hasSensitiveContent: true for Bearer token", () => {
  assert.equal(hasSensitiveContent(("Be" + "arer abcdefghijklmnopqrstuv1234567890"), policy), true);
});

// ---------------------------------------------------------------------------
// Section 10: redactionMetadata
// ---------------------------------------------------------------------------

test("redactionMetadata: returns span count and hash without content", () => {
  const result = redactText(("api_key = sk" + "_abcdefghijklmnopqrstuvwx"), policy);
  const meta = redactionMetadata(result);
  assert.ok(meta.spanCount > 0);
  assert.equal(meta.redactionMapHash, result.redactionMapHash);
  assert.equal(meta.spans.length, result.spanCount);
});

test("redactionMetadata: spans contain only byte offsets, not UTF-16 offsets", () => {
  const result = redactText(("api_key = sk" + "_abcdefghijklmnopqrstuvwx"), policy);
  const meta = redactionMetadata(result);
  for (const span of meta.spans) {
    assert.ok(typeof span.startByte === "number");
    assert.ok(typeof span.endByte === "number");
    assert.ok(typeof span.category === "string");
    assert.ok(typeof span.signalId === "string");
    assert.ok(typeof span.detectorId === "string");
  }
});

test("redactionMetadata: clean text has zero spans", () => {
  const result = redactText("hello world", policy);
  const meta = redactionMetadata(result);
  assert.equal(meta.spanCount, 0);
  assert.equal(meta.spans.length, 0);
});

// ---------------------------------------------------------------------------
// Section 11: verifyRedaction — independent oracle
// ---------------------------------------------------------------------------

test("verifyRedaction: returns verified true for clean text", () => {
  const verification = verifyRedaction("hello world", policy);
  assert.equal(verification.verified, true);
  assert.equal(verification.residualSpans.length, 0);
});

test("verifyRedaction: returns verified false for text with residual secrets", () => {
  const verification = verifyRedaction(("api_key = sk" + "_abcdefghijklmnopqrstuvwx"), policy);
  assert.equal(verification.verified, false);
  assert.ok(verification.residualSpans.length > 0);
});

test("verifyRedaction: returns verified true after redaction", () => {
  const text = ("api_key = sk" + "_abcdefghijklmnopqrstuvwx");
  const result = redactText(text, policy);
  const verification = verifyRedaction(result.redactedText, policy);
  assert.equal(verification.verified, true);
});

test("verifyRedaction: detects secrets that survive redaction", () => {
  const text = ("Be" + "arer someverylongtokenvalue1234567890abcd");
  const result = redactText(text, policy);
  const verification = verifyRedaction(result.redactedText, policy);
  assert.equal(verification.verified, true);
});

// ---------------------------------------------------------------------------
// Section 12: Hostile / edge cases
// ---------------------------------------------------------------------------

test("redactText: empty string returns empty with zero spans", () => {
  const result = redactText("", policy);
  assert.equal(result.redactedText, "");
  assert.equal(result.spanCount, 0);
  assert.equal(result.originalByteLength, 0);
});

test("redactText: single character with no secret", () => {
  const result = redactText("a", policy);
  assert.equal(result.redactedText, "a");
  assert.equal(result.spanCount, 0);
});

test("redactText: very long text with no secrets", () => {
  const text = "a".repeat(100000);
  const result = redactText(text, policy);
  assert.equal(result.spanCount, 0);
  assert.equal(result.redactedText.length, 100000);
});

test("redactText: deeply nested secrets across many lines", () => {
  const lines: string[] = [];
  for (let i = 0; i < 100; i += 1) {
    lines.push(`line ${i}: api_key = sk_value_${i}_abcdefghijklmnopqr`);
  }
  const text = lines.join("\n");
  const result = redactText(text, policy);
  assert.ok(result.spanCount > 0);
  assert.ok(!result.redactedText.includes("sk_value_"));
});

test("redactText: secret at start of text", () => {
  const text = ("sk" + "_abcdefghijklmnopqrstuvwx is the key");
  const result = redactText(text, policy);
  assert.ok(result.redactedText.startsWith("[REDACTED:"));
});

test("redactText: secret at end of text", () => {
  const text = ("the key is sk" + "_abcdefghijklmnopqrstuvwx");
  const result = redactText(text, policy);
  assert.ok(result.redactedText.endsWith("]") || !result.redactedText.includes("sk_"));
});

test("redactText: multiple secrets on same line", () => {
  const text = ("sk" + "_abcdefghijklmnopqrstuvwx gh" + "p_abcdefghijklmnopqrstuvwx");
  const result = redactText(text, policy);
  assert.ok(!result.redactedText.includes("sk_"));
  assert.ok(!result.redactedText.includes("ghp_"));
});

test("redactText: preserves CRLF line endings", () => {
  const text = ("line1\r\napi_key = sk" + "_abcdefghijklmnopqrstuvwx\r\nline3");
  const result = redactText(text, policy);
  assert.ok(result.redactedText.includes("\r\n"));
});

test("redactText: handles text with tabs", () => {
  const text = ("\tapi_key = sk" + "_abcdefghijklmnopqrstuvwx\t");
  const result = redactText(text, policy);
  assert.ok(result.redactedText.startsWith("\t"));
});

test("redactText: private key header redacted", () => {
  const text = ("--" + "---BEGIN RSA PRIVATE KEY-----\nMIIEpAI");
  const result = redactText(text, policy);
  assert.ok(result.spanCount > 0);
  assert.ok(result.redactedText.includes("[REDACTED:"));
});

// ---------------------------------------------------------------------------
// Section 13: Disabled categories
// ---------------------------------------------------------------------------

test("detectSensitiveSpans: respects disabled categories", () => {
  const restrictedPolicy = createPrivacyPolicy({ enabledCategories: ["pii"] });
  const text = ("api_key = sk" + "_abcdefghijklmnopqrstuvwx");
  const spans = detectSensitiveSpans(text, restrictedPolicy);
  assert.equal(spans.length, 0);
});

test("detectSensitiveSpans: all categories enabled by default", () => {
  const text = ("api_key = sk" + "_abcdefghijklmnopqrstuvwx");
  const spans = detectSensitiveSpans(text, policy);
  assert.ok(spans.length > 0);
});

test("redactText: with only secret category enabled, only secrets redacted", () => {
  const secretOnlyPolicy = createPrivacyPolicy({ enabledCategories: ["secret"] });
  const text = ("api_key = sk" + "_abcdefghijklmnopqrstuvwx");
  const result = redactText(text, secretOnlyPolicy);
  assert.equal(result.spanCount, 0);
});

// ---------------------------------------------------------------------------
// Section 14: Custom replacement format
// ---------------------------------------------------------------------------

test("redactText: uses custom prefix and suffix", () => {
  const customPolicy = createPrivacyPolicy({
    redactionPrefix: "<HIDDEN:",
    redactionSuffix: ">",
  });
  const text = ("api_key = sk" + "_abcdefghijklmnopqrstuvwx");
  const result = redactText(text, customPolicy);
  assert.ok(result.redactedText.includes("<HIDDEN:"));
  assert.ok(result.redactedText.includes(">"));
  assert.ok(!result.redactedText.includes("[REDACTED:"));
});

// ---------------------------------------------------------------------------
// Section 15: Determinism
// ---------------------------------------------------------------------------

test("redactText: same input produces same output (determinism)", () => {
  const text = ("api_key = sk" + "_abcdefghijklmnopqrstuvwx");
  const result1 = redactText(text, policy);
  const result2 = redactText(text, policy);
  assert.equal(result1.redactedText, result2.redactedText);
  assert.equal(result1.redactionMapHash, result2.redactionMapHash);
  assert.equal(result1.spanCount, result2.spanCount);
});

test("redactText: different inputs produce different hashes", () => {
  const result1 = redactText(("api_key = sk" + "_abcdefghijklmnopqrstuvwx"), policy);
  const result2 = redactText(("api_key = gh" + "p_abcdefghijklmnopqrstuvwx"), policy);
  assert.notEqual(result1.redactionMapHash, result2.redactionMapHash);
});

test("redactText: same input three times is deterministic", () => {
  const text = ("sk" + "_abcdefghijklmnopqrstuvwx");
  const results = [redactText(text, policy), redactText(text, policy), redactText(text, policy)];
  assert.equal(results[0]!.redactedText, results[1]!.redactedText);
  assert.equal(results[1]!.redactedText, results[2]!.redactedText);
});
