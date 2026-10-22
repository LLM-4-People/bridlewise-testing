import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { InputError, SecurityError } from "../../src/kernel/errors.ts";
import { createPrivacyPolicy, DEFAULT_PRIVACY_MAX_FILE_BYTES, DEFAULT_PRIVACY_MAX_REGEX_PATTERN_BYTES } from "../../src/privacy/privacy-policy.ts";
import {
  SUPPORTED_SEMANTIC_EXTENSIONS,
  viewFile,
  type FileViewAdmitted,
  type FileViewResult,
} from "../../src/privacy/file-viewer.ts";

/**
 * Narrow a view result to the admitted variant, asserting on the way through.
 * Every read of `content` and its siblings goes through this, so a test that
 * expects to see a file also states that the file was not refused — which is
 * the distinction the old `content: ""` shape could not make.
 */
function viewed(result: FileViewResult): FileViewAdmitted {
  assert.equal(
    result.outcome,
    "viewed",
    `expected a viewed result; it was refused: ${result.outcome === "refused" ? result.blockReason : ""}`,
  );
  return result as FileViewAdmitted;
}

// ---------------------------------------------------------------------------
// Section 1: viewFile — full mode basic
// ---------------------------------------------------------------------------

test("viewFile full: clean file returns content unchanged", () => {
  const result = viewFile("test.ts", "const x = 42;", { mode: "full" });
  assert.equal(result.mode, "full");
  assert.equal(viewed(result).content, "const x = 42;");
  assert.equal(result.parseStatus, "not-attempted");
  assert.equal(result.redactionSummary.spanCount, 0);
});

test("viewFile full: secret content is redacted", () => {
  const result = viewFile("config.ts", ("api_key = sk" + "_abcdefghijklmnopqrstuvwx"), { mode: "full" });
  assert.ok(result.redactionSummary.spanCount > 0);
  assert.ok(!viewed(result).content.includes("sk_"));
  assert.ok(viewed(result).content.includes("[REDACTED:"));
});

test("viewFile full: preserves line count", () => {
  const content = ("line1\nline2\napi_key = sk" + "_abcdefghijklmnopqrstuvwx\nline4");
  const result = viewFile("test.ts", content, { mode: "full" });
  assert.equal(viewed(result).lineCount, 4);
});

test("viewFile full: contentHash is a 64-char hex string", () => {
  const result = viewFile("test.ts", "hello", { mode: "full" });
  assert.ok(/^[0-9a-f]{64}$/.test(viewed(result).contentHash));
});

test("viewFile full: truncated when exceeding maxLines", () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
  const result = viewFile("test.ts", lines.join("\n"), { mode: "full", maxLines: 5 });
  assert.equal(result.truncated, true);
  assert.equal(viewed(result).lineCount, 5);
});

test("viewFile full: not truncated when within maxLines", () => {
  const result = viewFile("test.ts", "line1\nline2\nline3", { mode: "full", maxLines: 10 });
  assert.equal(result.truncated, false);
  assert.equal(viewed(result).lineCount, 3);
});

test("viewFile full: byteLength matches redacted content", () => {
  const result = viewFile("test.ts", ("api_key = sk" + "_abcdefghijklmnopqrstuvwx"), { mode: "full" });
  assert.equal(viewed(result).byteLength, Buffer.byteLength(viewed(result).content, "utf8"));
});

test("viewFile: default mode is full", () => {
  const result = viewFile("test.ts", "hello");
  assert.equal(result.mode, "full");
});

test("viewFile: throws on empty path", () => {
  assert.throws(() => viewFile("", "content"), InputError);
});

test("viewFile: throws on non-string content", () => {
  assert.throws(() => viewFile("test.ts", 123 as unknown as string), InputError);
});

// ---------------------------------------------------------------------------
// Section 2: viewFile — full mode with secrets
// ---------------------------------------------------------------------------

test("viewFile full: multiple secrets redacted", () => {
  const content = ("sk" + "_abcdefghijklmnopqrstuvwx\nghp_abcdefghijklmnopqrstuvwx");
  const result = viewFile("test.ts", content, { mode: "full" });
  assert.ok(viewed(result).content.includes("[REDACTED:"), "witness: the planted secrets were redacted in this subject");
  assert.ok(!viewed(result).content.includes("sk_"));
  assert.ok(!viewed(result).content.includes("ghp_"));
  assert.ok(result.redactionSummary.spanCount >= 2);
});

test("viewFile full: AWS key redacted", () => {
  const result = viewFile("test.ts", ("key = AK" + "IAIOSFODNN7EXAMPLE"), { mode: "full" });
  assert.ok(viewed(result).content.includes("[REDACTED:"), "witness: the planted key was redacted in this subject");
  assert.ok(!viewed(result).content.includes("AKIA"));
});

test("viewFile full: Bearer token redacted", () => {
  const result = viewFile("test.ts", ("Authorization: Be" + "arer abcdefghijklmnopqrstuv1234567890"), { mode: "full" });
  assert.ok(result.redactionSummary.spanCount > 0);
});

test("viewFile full: private key header redacted", () => {
  const result = viewFile("test.ts", ("--" + "---BEGIN RSA PRIVATE KEY-----"), { mode: "full" });
  assert.ok(result.redactionSummary.spanCount > 0);
});

test("viewFile full: password assignment redacted", () => {
  const result = viewFile("test.ts", 'password = "MyS3cretPassw0rd12345678"', { mode: "full" });
  assert.ok(result.redactionSummary.spanCount > 0);
});

test("viewFile full: safe credential variable names preserved", () => {
  const content = "const apiKey = config.apiKey;";
  const result = viewFile("test.ts", content, { mode: "full" });
  assert.ok(viewed(result).content.includes("apiKey"));
  assert.ok(viewed(result).content.includes("config"));
});

test("viewFile full: function-call assignments not redacted", () => {
  const content = "authorization = load_bound_json_object(root, snapshot)";
  const result = viewFile("test.ts", content, { mode: "full" });
  assert.equal(result.redactionSummary.spanCount, 0);
});

test("viewFile full: Unicode content with secrets", () => {
  const content = ("café 日本語 api_key = sk" + "_abcdefghijklmnopqrstuvwx 😀");
  const result = viewFile("test.ts", content, { mode: "full" });
  assert.ok(result.redactionSummary.spanCount > 0);
  assert.ok(viewed(result).content.includes("café"));
  assert.ok(viewed(result).content.includes("😀"));
});

test("viewFile full: CRLF line endings preserved", () => {
  const content = ("line1\r\napi_key = sk" + "_abcdefghijklmnopqrstuvwx\r\nline3");
  const result = viewFile("test.ts", content, { mode: "full" });
  assert.ok(viewed(result).content.includes("\r\n"));
});

// ---------------------------------------------------------------------------
// Section 3: viewFile — regex mode
// ---------------------------------------------------------------------------

test("viewFile regex: returns only matching lines", () => {
  const content = ("line1\napi_key = sk" + "_abcdefghijklmnopqrstuvwx\nline3");
  const result = viewFile("test.ts", content, { mode: "regex", pattern: "api_key" });
  assert.equal(result.mode, "regex");
  assert.ok(viewed(result).content.includes("[REDACTED:"));
  assert.ok(!viewed(result).content.includes("sk_"));
  assert.ok(viewed(result).matchedLineCount === 1);
});

test("viewFile regex: no matches returns empty content", () => {
  const result = viewFile("test.ts", "hello\nworld", { mode: "regex", pattern: "zzz" });
  assert.equal(viewed(result).content, "");
  assert.equal(viewed(result).matchedLineCount, 0);
});

test("viewFile regex: matching lines are redacted", () => {
  const content = ("api_key = sk" + "_abcdefghijklmnopqrstuvwx");
  const result = viewFile("test.ts", content, { mode: "regex", pattern: "api_key" });
  assert.ok(!viewed(result).content.includes("sk_"));
  assert.ok(viewed(result).content.includes("[REDACTED:"));
});

test("viewFile regex: line numbers are included in output", () => {
  const content = ("line1\napi_key = sk" + "_abcdefghijklmnopqrstuvwx\nline3");
  const result = viewFile("test.ts", content, { mode: "regex", pattern: "api_key" });
  assert.ok(viewed(result).content.includes("2:"));
});

test("viewFile regex: throws on missing pattern", () => {
  assert.throws(
    () => viewFile("test.ts", "content", { mode: "regex" }),
    InputError,
  );
});

test("viewFile regex: throws on empty pattern", () => {
  assert.throws(
    () => viewFile("test.ts", "content", { mode: "regex", pattern: "" }),
    InputError,
  );
});

test("viewFile regex: throws on oversize pattern", () => {
  const bigPattern = "a".repeat(DEFAULT_PRIVACY_MAX_REGEX_PATTERN_BYTES + 1);
  assert.throws(
    () => viewFile("test.ts", "content", { mode: "regex", pattern: bigPattern }),
    SecurityError,
  );
});

test("viewFile regex: throws on invalid regex", () => {
  assert.throws(
    () => viewFile("test.ts", "content", { mode: "regex", pattern: "(" }),
    InputError,
  );
});

test("viewFile regex: multiple matches", () => {
  const content = ("api_key = sk" + "_abcdefghijklmnopqrstuvwx\npassword = MyS3cretPassw0rd12345678");
  const result = viewFile("test.ts", content, { mode: "regex", pattern: "(api_key|password)" });
  assert.ok(viewed(result).matchedLineCount! >= 2);
});

test("viewFile regex: regex match on safe content is not redacted", () => {
  const content = "const apiKey = config.apiKey;";
  const result = viewFile("test.ts", content, { mode: "regex", pattern: "apiKey" });
  assert.equal(result.redactionSummary.spanCount, 0);
});

test("viewFile regex: lineCount reflects total lines in file", () => {
  const content = "line1\nline2\nline3\nline4";
  const result = viewFile("test.ts", content, { mode: "regex", pattern: "line" });
  assert.equal(viewed(result).lineCount, 4);
  assert.equal(viewed(result).matchedLineCount, 4);
});

// ---------------------------------------------------------------------------
// Section 4: viewFile — semantic mode
// ---------------------------------------------------------------------------

test("viewFile semantic: disabled by default returns blocked", () => {
  const result = viewFile("test.ts", "const x = 42;", { mode: "semantic" });
  assert.equal(result.parseStatus, "not-attempted");
  assert.ok(result.blockReason);
  assert.equal(result.blockReason, "semantic_mode_disabled_before_qualification");
});

test("viewFile semantic: enabled but unsupported extension returns unparseable", () => {
  const enabledPolicy = createPrivacyPolicy({ semanticModeEnabled: true, failClosedOnUncertainty: false });
  const result = viewFile("test.txt", "some content", { mode: "semantic", policy: enabledPolicy });
  assert.equal(result.parseStatus, "unparseable");
  assert.ok(result.blockReason);
  assert.ok(result.blockReason!.includes("unsupported_file_extension"));
});

test("viewFile semantic: enabled with.json file returns parsed", () => {
  const enabledPolicy = createPrivacyPolicy({ semanticModeEnabled: true, failClosedOnUncertainty: false });
  const content = '{"name": "test", "value": 42}';
  const result = viewFile("test.json", content, { mode: "semantic", policy: enabledPolicy });
  assert.equal(result.parseStatus, "parsed");
});

test("viewFile semantic: enabled with.ts file returns parsed", () => {
  const enabledPolicy = createPrivacyPolicy({ semanticModeEnabled: true, failClosedOnUncertainty: false });
  const content = "const x = 42;";
  const result = viewFile("test.ts", content, { mode: "semantic", policy: enabledPolicy });
  assert.equal(result.parseStatus, "parsed");
});

test("viewFile semantic: JSON with secrets is redacted", () => {
  const enabledPolicy = createPrivacyPolicy({ semanticModeEnabled: true, failClosedOnUncertainty: false });
  const content = ('{"api_key": "sk' + '_abcdefghijklmnopqrstuvwx"}');
  const result = viewFile("test.json", content, { mode: "semantic", policy: enabledPolicy });
  assert.ok(result.redactionSummary.spanCount > 0);
  assert.ok(viewed(result).content.includes("[REDACTED:"), "witness: the planted secret was redacted in this subject");
  assert.ok(!viewed(result).content.includes("sk_"));
});

test("viewFile semantic: invalid JSON returns unparseable", () => {
  const enabledPolicy = createPrivacyPolicy({ semanticModeEnabled: true, failClosedOnUncertainty: false });
  const content = "{ invalid json }";
  const result = viewFile("test.json", content, { mode: "semantic", policy: enabledPolicy });
  assert.equal(result.parseStatus, "unparseable");
  assert.ok(result.blockReason);
  assert.ok(result.blockReason!.includes("parse_error"));
});

test("viewFile semantic: unparseable is NOT hidden — content is still returned redacted", () => {
  const enabledPolicy = createPrivacyPolicy({ semanticModeEnabled: true, failClosedOnUncertainty: false });
  const content = ("{ invalid json with api_key = sk" + "_abcdefghijklmnopqrstuvwx }");
  const result = viewFile("test.json", content, { mode: "semantic", policy: enabledPolicy });
  assert.equal(result.parseStatus, "unparseable");
  assert.ok(viewed(result).content.length > 0);
  assert.ok(!viewed(result).content.includes("sk_"));
});

test("viewFile semantic: unparseable is NOT 'clean' — blockReason is set", () => {
  const enabledPolicy = createPrivacyPolicy({ semanticModeEnabled: true, failClosedOnUncertainty: false });
  const result = viewFile("test.txt", "content", { mode: "semantic", policy: enabledPolicy });
  assert.notEqual(result.parseStatus, "parsed");
  assert.ok(result.blockReason !== undefined);
});

test("viewFile semantic:.js file is supported", () => {
  const enabledPolicy = createPrivacyPolicy({ semanticModeEnabled: true, failClosedOnUncertainty: false });
  const result = viewFile("test.js", "const x = 42;", { mode: "semantic", policy: enabledPolicy });
  assert.equal(result.parseStatus, "parsed");
});

test("viewFile semantic:.mjs file is supported", () => {
  const enabledPolicy = createPrivacyPolicy({ semanticModeEnabled: true, failClosedOnUncertainty: false });
  const result = viewFile("test.mjs", "export const x = 42;", { mode: "semantic", policy: enabledPolicy });
  assert.equal(result.parseStatus, "parsed");
});

test("viewFile semantic:.cjs file is supported", () => {
  const enabledPolicy = createPrivacyPolicy({ semanticModeEnabled: true, failClosedOnUncertainty: false });
  const result = viewFile("test.cjs", "module.exports = 42;", { mode: "semantic", policy: enabledPolicy });
  assert.equal(result.parseStatus, "parsed");
});

test("viewFile semantic:.tsx file is supported", () => {
  const enabledPolicy = createPrivacyPolicy({ semanticModeEnabled: true, failClosedOnUncertainty: false });
  const result = viewFile("test.tsx", "const x = 42;", { mode: "semantic", policy: enabledPolicy });
  assert.equal(result.parseStatus, "parsed");
});

test("viewFile semantic:.py file is NOT supported (unparseable)", () => {
  const enabledPolicy = createPrivacyPolicy({ semanticModeEnabled: true, failClosedOnUncertainty: false });
  const result = viewFile("test.py", "x = 42", { mode: "semantic", policy: enabledPolicy });
  assert.equal(result.parseStatus, "unparseable");
  assert.ok(result.blockReason!.includes("unsupported_file_extension"));
});

test("viewFile semantic:.sh file is NOT supported (unparseable)", () => {
  const enabledPolicy = createPrivacyPolicy({ semanticModeEnabled: true, failClosedOnUncertainty: false });
  const result = viewFile("test.sh", "echo hello", { mode: "semantic", policy: enabledPolicy });
  assert.equal(result.parseStatus, "unparseable");
});

test("viewFile semantic: no extension is NOT supported (unparseable)", () => {
  const enabledPolicy = createPrivacyPolicy({ semanticModeEnabled: true, failClosedOnUncertainty: false });
  const result = viewFile("Makefile", "all: build", { mode: "semantic", policy: enabledPolicy });
  assert.equal(result.parseStatus, "unparseable");
});

// ---------------------------------------------------------------------------
// Section 5: viewFile — oversize and blocking
// ---------------------------------------------------------------------------

test("viewFile: oversize file is blocked with reason", () => {
  const bigContent = "a".repeat(100);
  const result = viewFile("test.ts", bigContent, { maxBytes: 50 });
  assert.ok(result.blockReason);
  assert.equal(result.blockReason, "file_viewer_oversize");
  assert.equal(result.truncated, true);
});

test("viewFile: file within byte limit is not blocked", () => {
  const result = viewFile("test.ts", "hello", { maxBytes: 100 });
  assert.equal(result.blockReason, undefined);
});

// Asked of the RESOLVED policy, which is what the viewer actually enforces.
test("viewFile: default max bytes is 1MB", () => {
  assert.equal(createPrivacyPolicy().maxFileBytes, 1_048_576);
});

test("viewFile: default max lines is 10000", () => {
  assert.equal(createPrivacyPolicy().maxLines, 10_000);
});

// ---------------------------------------------------------------------------
// Section 6: SUPPORTED_SEMANTIC_EXTENSIONS
// ---------------------------------------------------------------------------

test("SUPPORTED_SEMANTIC_EXTENSIONS includes.ts", () => {
  assert.ok(SUPPORTED_SEMANTIC_EXTENSIONS.includes(".ts" as never));
});

test("SUPPORTED_SEMANTIC_EXTENSIONS includes.js", () => {
  assert.ok(SUPPORTED_SEMANTIC_EXTENSIONS.includes(".js" as never));
});

test("SUPPORTED_SEMANTIC_EXTENSIONS includes.json", () => {
  assert.ok(SUPPORTED_SEMANTIC_EXTENSIONS.includes(".json" as never));
});

test("SUPPORTED_SEMANTIC_EXTENSIONS does NOT include.py", () => {
  assert.ok(!SUPPORTED_SEMANTIC_EXTENSIONS.includes(".py" as never));
});

test("SUPPORTED_SEMANTIC_EXTENSIONS does NOT include.txt", () => {
  assert.ok(!SUPPORTED_SEMANTIC_EXTENSIONS.includes(".txt" as never));
});

// ---------------------------------------------------------------------------
// Section 7: viewFile — unknown mode
// ---------------------------------------------------------------------------

test("viewFile: throws on unknown mode", () => {
  assert.throws(
    () => viewFile("test.ts", "content", { mode: "unknown" as never }),
    InputError,
  );
});

// ---------------------------------------------------------------------------
// Section 8: viewFile — custom policy
// ---------------------------------------------------------------------------

test("viewFile: uses custom policy for redaction", () => {
  const customPolicy = createPrivacyPolicy({
    redactionPrefix: "<HIDDEN:",
    redactionSuffix: ">",
  });
  const result = viewFile("test.ts", ("api_key = sk" + "_abcdefghijklmnopqrstuvwx"), {
    mode: "full",
    policy: customPolicy,
  });
  assert.ok(viewed(result).content.includes("<HIDDEN:"));
});

test("viewFile: disabled categories result in no redaction", () => {
  const restrictedPolicy = createPrivacyPolicy({ enabledCategories: ["pii"] });
  const result = viewFile("test.ts", ("api_key = sk" + "_abcdefghijklmnopqrstuvwx"), {
    mode: "full",
    policy: restrictedPolicy,
  });
  assert.equal(result.redactionSummary.spanCount, 0);
});

// ---------------------------------------------------------------------------
// Section 9: viewFile — result properties
// ---------------------------------------------------------------------------

test("viewFile: result is frozen", () => {
  const result = viewFile("test.ts", "hello", { mode: "full" });
  assert.ok(Object.isFrozen(result));
});

test("viewFile: redactionSummary has verified true for full mode", () => {
  const result = viewFile("test.ts", ("api_key = sk" + "_abcdefghijklmnopqrstuvwx"), { mode: "full" });
  assert.equal(result.redactionSummary.verified, true);
});

test("viewFile: redactionSummary has residualSpanCount 0 for full mode", () => {
  const result = viewFile("test.ts", ("api_key = sk" + "_abcdefghijklmnopqrstuvwx"), { mode: "full" });
  assert.equal(result.redactionSummary.residualSpanCount, 0);
});

test("viewFile: redactionMapHash is 64-char hex", () => {
  const result = viewFile("test.ts", ("api_key = sk" + "_abcdefghijklmnopqrstuvwx"), { mode: "full" });
  assert.ok(/^[0-9a-f]{64}$/.test(result.redactionSummary.redactionMapHash));
});

// ---------------------------------------------------------------------------
// Section 10: Hostile / edge cases
// ---------------------------------------------------------------------------

test("viewFile full: empty content returns empty string", () => {
  const result = viewFile("test.ts", "", { mode: "full" });
  assert.equal(viewed(result).content, "");
  assert.equal(viewed(result).lineCount, 1);
  assert.equal(result.redactionSummary.spanCount, 0);
});

test("viewFile full: single line with no newline", () => {
  const result = viewFile("test.ts", "const x = 42;", { mode: "full" });
  assert.equal(viewed(result).lineCount, 1);
});

test("viewFile full: deeply nested secrets", () => {
  const lines: string[] = [];
  for (let i = 0; i < 50; i += 1) {
    lines.push(`  level${i}: { key: "sk_value_${i}_abcdefghijklmnopqrst" }`);
  }
  const result = viewFile("test.ts", lines.join("\n"), { mode: "full" });
  assert.ok(result.redactionSummary.spanCount > 0);
  assert.ok(!viewed(result).content.includes("sk_value_"));
});

test("viewFile regex: regex matching multiple secrets", () => {
  const content = ("sk" + "_abcdefghijklmnopqrstuvwx\nghp_abcdefghijklmnopqrstuvwx\nclean line");
  const result = viewFile("test.ts", content, { mode: "regex", pattern: "sk_|ghp_" });
  assert.ok(viewed(result).matchedLineCount! >= 2);
  assert.ok(!viewed(result).content.includes("sk_"));
  assert.ok(!viewed(result).content.includes("ghp_"));
});

test("viewFile full: makora key redacted", () => {
  const result = viewFile("test.ts", ("key = mb" + "h_1234567890abcdefghijk"), { mode: "full" });
  assert.ok(result.redactionSummary.spanCount > 0);
});

test("viewFile full: session token redacted", () => {
  const result = viewFile("test.ts", "session_token=sess-FFFFFFFFFFFFFFFFFFFFFFFFFFFF", { mode: "full" });
  assert.ok(result.redactionSummary.spanCount > 0);
});

test("viewFile full: multiple secret types in one file", () => {
  const content = [
    ("api_key = sk" + "_abcdefghijklmnopqrstuvwx"),
    "password = MyS3cretPassw0rd12345678",
    "session_token = sess-FFFFFFFFFFFFFFFFFFFFFFFFFFFF",
    "const safe = 42;",
  ].join("\n");
  const result = viewFile("test.ts", content, { mode: "full" });
  assert.ok(result.redactionSummary.spanCount >= 3);
  assert.ok(viewed(result).content.includes("const safe = 42;"));
});

test("viewFile full: YAML-style colon assignments redacted", () => {
  const result = viewFile("test.yaml", 'database_password: "S3cure+EEEEEEEEEEEE/?EEEEEEEEEE"', { mode: "full" });
  assert.ok(result.redactionSummary.spanCount > 0);
});

test("viewFile: path is preserved in result", () => {
  const result = viewFile("some/path/to/file.ts", "hello", { mode: "full" });
  assert.equal(result.path, "some/path/to/file.ts");
});

test("viewFile regex: very long file with few matches", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
  lines[50] = ("api_key = sk" + "_abcdefghijklmnopqrstuvwx");
  const result = viewFile("test.ts", lines.join("\n"), { mode: "regex", pattern: "api_key" });
  assert.equal(viewed(result).matchedLineCount, 1);
  assert.ok(viewed(result).content.includes("[REDACTED:"));
});

test("viewFile semantic: semantic query extracts matching spans", () => {
  const enabledPolicy = createPrivacyPolicy({ semanticModeEnabled: true, failClosedOnUncertainty: false });
  const content = "const apiKey = 42;\nconst password = 'secret';\nconst safe = 10;";
  const result = viewFile("test.ts", content, {
    mode: "semantic",
    policy: enabledPolicy,
    semanticQuery: "apiKey",
  });
  assert.equal(result.parseStatus, "parsed");
  assert.ok(viewed(result).matchedLineCount! > 0);
});

test("viewFile semantic: empty semantic query returns full file", () => {
  const enabledPolicy = createPrivacyPolicy({ semanticModeEnabled: true, failClosedOnUncertainty: false });
  const content = "const x = 42;";
  const result = viewFile("test.ts", content, {
    mode: "semantic",
    policy: enabledPolicy,
    semanticQuery: "",
  });
  assert.equal(result.parseStatus, "parsed");
});

// ---------------------------------------------------------------------------
// C3 regression: verifyRedaction is called in all file-viewer paths
// ---------------------------------------------------------------------------

test("C3 viewFile full: verified is computed true for clean content", () => {
  const result = viewFile("test.ts", "const x = 42;", { mode: "full" });
  assert.equal(result.redactionSummary.verified, true);
  assert.equal(result.redactionSummary.residualSpanCount, 0);
});

test("C3 viewFile full: verified is computed true for redacted content", () => {
  const result = viewFile("test.ts", ("api_key = sk" + "_abcdefghijklmnopqrstuvwx"), { mode: "full" });
  assert.equal(result.redactionSummary.verified, true);
  assert.equal(result.redactionSummary.residualSpanCount, 0);
});

test("C3 viewFile regex: verified is computed true for redacted content", () => {
  const content = ("line1\napi_key = sk" + "_abcdefghijklmnopqrstuvwx\nline3");
  const result = viewFile("test.ts", content, { mode: "regex", pattern: "api_key" });
  assert.equal(result.redactionSummary.verified, true);
  assert.equal(result.redactionSummary.residualSpanCount, 0);
});

test("C3 viewFile regex: verified is computed true for clean content", () => {
  const result = viewFile("test.ts", "const x = 42;", { mode: "regex", pattern: "x" });
  assert.equal(result.redactionSummary.verified, true);
  assert.equal(result.redactionSummary.residualSpanCount, 0);
});

test("C3 viewFile semantic: verified is computed true for redacted content", () => {
  const enabledPolicy = createPrivacyPolicy({ semanticModeEnabled: true, failClosedOnUncertainty: false });
  const content = ('{"api_key": "sk' + '_abcdefghijklmnopqrstuvwx"}');
  const result = viewFile("test.json", content, { mode: "semantic", policy: enabledPolicy });
  assert.equal(result.redactionSummary.verified, true);
  assert.equal(result.redactionSummary.residualSpanCount, 0);
});

test("C3 viewFile semantic unparseable: verified is computed true for redacted content", () => {
  const enabledPolicy = createPrivacyPolicy({ semanticModeEnabled: true, failClosedOnUncertainty: false });
  const content = ("{ invalid json with api_key = sk" + "_abcdefghijklmnopqrstuvwx }");
  const result = viewFile("test.json", content, { mode: "semantic", policy: enabledPolicy });
  assert.equal(result.parseStatus, "unparseable");
  assert.equal(result.redactionSummary.verified, true);
  assert.equal(result.redactionSummary.residualSpanCount, 0);
});

test("C3 viewFile full: blocks when redaction replacement itself is a secret", () => {
  const leakyPolicy = createPrivacyPolicy({
    redactionPrefix: ("sk" + "_abcdefghijklmnopqrstuvwx"),
    redactionSuffix: "",
  });
  const result = viewFile("test.ts", "password = MyS3cretPassw0rd12345678", { mode: "full", policy: leakyPolicy });
  assert.equal(result.redactionSummary.verified, false);
  assert.ok(result.redactionSummary.residualSpanCount > 0);
  assert.equal(result.outcome, "refused");
  assert.ok(!("content" in result), "a refusal must not carry content — an empty string reads as a successful view of an empty file");
  assert.equal(result.blockReason, "redaction_incomplete_residual_secrets_detected");
});

test("C3 viewFile regex: blocks when redaction replacement itself is a secret", () => {
  const leakyPolicy = createPrivacyPolicy({
    redactionPrefix: ("sk" + "_abcdefghijklmnopqrstuvwx"),
    redactionSuffix: "",
  });
  const result = viewFile("test.ts", "password = MyS3cretPassw0rd12345678", { mode: "regex", pattern: "password", policy: leakyPolicy });
  assert.equal(result.redactionSummary.verified, false);
  assert.ok(result.redactionSummary.residualSpanCount > 0);
  assert.equal(result.outcome, "refused");
  assert.ok(!("content" in result), "a refusal must not carry content — an empty string reads as a successful view of an empty file");
  assert.equal(result.blockReason, "redaction_incomplete_residual_secrets_detected");
});

test("C3 viewFile semantic: blocks when redaction replacement itself is a secret", () => {
  const leakyPolicy = createPrivacyPolicy({
    semanticModeEnabled: true,
    // The fail-OPEN path (content shown redacted) is what this arm checks.
    failClosedOnUncertainty: false,
    redactionPrefix: ("sk" + "_abcdefghijklmnopqrstuvwx"),
    redactionSuffix: "",
  });
  const result = viewFile("test.ts", "password = MyS3cretPassw0rd12345678", { mode: "semantic", policy: leakyPolicy });
  assert.equal(result.redactionSummary.verified, false);
  assert.ok(result.redactionSummary.residualSpanCount > 0);
  assert.equal(result.outcome, "refused");
  assert.ok(!("content" in result), "a refusal must not carry content — an empty string reads as a successful view of an empty file");
  assert.equal(result.blockReason, "redaction_incomplete_residual_secrets_detected");
});

test("C3 viewFile semantic unparseable: blocks when redaction replacement itself is a secret", () => {
  const leakyPolicy = createPrivacyPolicy({
    semanticModeEnabled: true,
    // The fail-OPEN path (content shown redacted) is what this arm checks.
    failClosedOnUncertainty: false,
    redactionPrefix: ("sk" + "_abcdefghijklmnopqrstuvwx"),
    redactionSuffix: "",
  });
  const result = viewFile("test.json", "{ invalid json with password = MyS3cretPassw0rd12345678 }", { mode: "semantic", policy: leakyPolicy });
  assert.equal(result.redactionSummary.verified, false);
  assert.equal(result.outcome, "refused");
  assert.ok(!("content" in result), "a refusal must not carry content — an empty string reads as a successful view of an empty file");
  assert.equal(result.blockReason, "redaction_incomplete_residual_secrets_detected");
});

// ---------------------------------------------------------------------------
// Round-3 MAJOR fix: privacy-policy limit fields must be consumed by the
// file viewer (not just declared). Previously file-viewer used its own
// hardcoded MAX_FILE_BYTES_DEFAULT / MAX_PATTERN_BYTES and bounded the regex
// loop by maxLines, so policy.maxFileBytes / policy.maxRegexPatternBytes /
// policy.maxMatchCount were silently ignored. These regression tests verify
// each field is now the authoritative limit.
// ---------------------------------------------------------------------------

test("Round-3: viewFull respects policy.maxFileBytes (small limit blocks oversize file)", () => {
  const policy = createPrivacyPolicy({ maxFileBytes: 50 });
  const bigContent = "a".repeat(100);
  const result = viewFile("test.ts", bigContent, { mode: "full", policy });
  assert.ok(result.blockReason, "oversize file must be blocked");
  assert.equal(result.blockReason, "file_viewer_oversize");
  assert.equal(result.truncated, true);
});

test("Round-3: viewFull respects policy.maxFileBytes (file within limit passes)", () => {
  const policy = createPrivacyPolicy({ maxFileBytes: 200 });
  const result = viewFile("test.ts", "hello", { mode: "full", policy });
  assert.equal(result.blockReason, undefined);
  assert.equal(viewed(result).content, "hello");
});

test("Round-3: viewRegex respects policy.maxRegexPatternBytes (oversize pattern rejected)", () => {
  const policy = createPrivacyPolicy({ maxRegexPatternBytes: 16 });
  const oversizePattern = "a".repeat(32);
  assert.throws(
    () => viewFile("test.ts", "content", { mode: "regex", pattern: oversizePattern, policy }),
    SecurityError,
  );
});

test("Round-3: viewRegex respects policy.maxRegexPatternBytes (small pattern passes)", () => {
  const policy = createPrivacyPolicy({ maxRegexPatternBytes: 1024 });
  const result = viewFile("test.ts", "line1\nmatch\nline3", { mode: "regex", pattern: "match", policy });
  assert.equal(viewed(result).matchedLineCount, 1);
});

test("Round-3: viewRegex respects policy.maxMatchCount (match count is bounded)", () => {
  const policy = createPrivacyPolicy({ maxMatchCount: 3 });
  const lines = Array.from({ length: 100 }, (_, i) => `match${i}`);
  const result = viewFile("test.ts", lines.join("\n"), { mode: "regex", pattern: "match", policy });
  assert.equal(viewed(result).matchedLineCount, 3, "match count must be bounded by policy.maxMatchCount");
  assert.equal(result.truncated, true, "result must be truncated when match cap is hit");
});

test("Round-3: viewRegex respects policy.maxMatchCount (default 1000)", () => {
  const policy = createPrivacyPolicy();
  assert.equal(policy.maxMatchCount, 1000);
  const lines = Array.from({ length: 2000 }, () => "match");
  const result = viewFile("test.ts", lines.join("\n"), { mode: "regex", pattern: "match", policy });
  assert.equal(viewed(result).matchedLineCount, 1000, "default maxMatchCount bounds the match loop");
  assert.equal(result.truncated, true);
});

test("Round-3: viewRegex maxLines still bounds match loop when smaller than maxMatchCount", () => {
  const policy = createPrivacyPolicy({ maxMatchCount: 1000 });
  const lines = Array.from({ length: 100 }, () => "match");
  const result = viewFile("test.ts", lines.join("\n"), { mode: "regex", pattern: "match", policy, maxLines: 5 });
  assert.equal(viewed(result).matchedLineCount, 5, "maxLines cap still applies when smaller than maxMatchCount");
});

test("Round-3: DEFAULT_PRIVACY_MAX_FILE_BYTES canonical default is 1MB", () => {
  assert.equal(DEFAULT_PRIVACY_MAX_FILE_BYTES, 1_048_576);
  assert.equal(createPrivacyPolicy().maxFileBytes, DEFAULT_PRIVACY_MAX_FILE_BYTES, "the resolved policy must carry the canonical default");
});

test("Round-3: DEFAULT_PRIVACY_MAX_REGEX_PATTERN_BYTES canonical default is 4096", () => {
  assert.equal(DEFAULT_PRIVACY_MAX_REGEX_PATTERN_BYTES, 4_096);
  assert.equal(createPrivacyPolicy().maxRegexPatternBytes, DEFAULT_PRIVACY_MAX_REGEX_PATTERN_BYTES, "the resolved policy must carry the canonical default");
});

test("Round-3: contract — file-viewer source references policy.maxFileBytes / maxRegexPatternBytes / maxMatchCount", () => {
  // Mechanical prevention: if file-viewer regresses to using only local
  // constants again, this test fails. The privacy policy fields must be
  // referenced (consumed), not just declared in the policy type.
  const src = readFileSync(join(process.cwd(), "src/privacy/file-viewer.ts"), "utf8");
  assert.ok(/policy\.maxFileBytes/.test(src), "file-viewer must consume policy.maxFileBytes");
  assert.ok(/policy\.maxRegexPatternBytes/.test(src), "file-viewer must consume policy.maxRegexPatternBytes");
  assert.ok(/policy\.maxMatchCount/.test(src), "file-viewer must consume policy.maxMatchCount");
});

// ---------------------------------------------------------------------------
// Behavioral regression tests for configurable privacy policy fields.
//
// Each test sets a NON-DEFAULT value on the policy and verifies the behavioral
// effect is observable in the file-viewer output, comparing against the
// default to catch both directions of a semantic mutant (field logic removed
// or inverted). These catch mutants that the default-only tests miss: a field
// declared, validated, stored — but whose behavioral branch is bypassed.
// ---------------------------------------------------------------------------

test("behavioral: preserveLineCount=false collapses multi-line secret span to fewer lines", () => {
  // The bearer-token regex `\bBearer\s+[...]{16,}` uses `\s+` which matches
  // a newline, so a token split across two lines produces a single span
  // covering 2 lines. `preserveLineCount` controls whether the replacement
  // is padded with newlines to keep the original line count.
  const content = "Authorization: Bearer\nabcdefghijklmnopqrstuv1234567890";
  const falsePolicy = createPrivacyPolicy({ preserveLineCount: false });
  const truePolicy = createPrivacyPolicy({ preserveLineCount: true });
  const falseResult = viewFile("test.ts", content, { mode: "full", policy: falsePolicy });
  const trueResult = viewFile("test.ts", content, { mode: "full", policy: truePolicy });
  assert.equal(
    viewed(falseResult).content.split("\n").length,
    1,
    "preserveLineCount=false must collapse multi-line secret span to 1 line",
  );
  assert.equal(
    viewed(trueResult).content.split("\n").length,
    2,
    "preserveLineCount=true must preserve multi-line secret span at 2 lines",
  );
  assert.ok(
    viewed(falseResult).content.split("\n").length < viewed(trueResult).content.split("\n").length,
    "preserveLineCount=false must produce fewer lines than true for a multi-line span",
  );
  assert.ok(!viewed(falseResult).content.includes("abcdefghijklmnop"), "secret value must be redacted");
});

test("behavioral: failClosedOnUncertainty=true blocks unparseable file with empty content", () => {
  // `.py` in semantic mode is an unsupported extension -> unparseable.
  // With failClosedOnUncertainty=true, the result is blocked (empty content,
  // blockReason set). With false (default), best-effort redacted content is
  // returned so the caller can inspect non-sensitive structure.
  const truePolicy = createPrivacyPolicy({ semanticModeEnabled: true, failClosedOnUncertainty: true });
  const falsePolicy = createPrivacyPolicy({ semanticModeEnabled: true, failClosedOnUncertainty: false });
  const trueResult = viewFile("test.py", "x = 42", { mode: "semantic", policy: truePolicy });
  const falseResult = viewFile("test.py", "x = 42", { mode: "semantic", policy: falsePolicy });
  assert.ok(trueResult.blockReason, "failClosedOnUncertainty=true must set blockReason");
  assert.equal(trueResult.outcome, "refused", "failClosedOnUncertainty=true must refuse, not return content");
  assert.ok(
    !("content" in trueResult),
    "failClosedOnUncertainty=true must carry no content at all — an empty string reads as a successful view of an empty file",
  );
  assert.equal(
    viewed(falseResult).content.length > 0,
    true,
    "failClosedOnUncertainty=false must return best-effort redacted content",
  );
  assert.equal(falseResult.parseStatus, "unparseable", "false path must still mark parseStatus unparseable");
  assert.ok(falseResult.blockReason, "false path must still record the unparseable reason");
});

test("behavioral: maxContextLines=3 truncates spans exceeding the limit", () => {
  // The "nested" property value is an object spanning >3 lines. With
  // maxContextLines=3, the span text is truncated to 3 lines plus a marker.
  // With a large maxContextLines, no truncation occurs.
  const content = [
    '{',
    '  "nested": {',
    '    "a": 1,',
    '    "b": 2,',
    '    "c": 3,',
    '    "d": 4',
    '  }',
    '}',
  ].join('\n');
  const smallPolicy = createPrivacyPolicy({ semanticModeEnabled: true, maxContextLines: 3 });
  const largePolicy = createPrivacyPolicy({ semanticModeEnabled: true, maxContextLines: 100 });
  const smallResult = viewFile("test.json", content, { mode: "semantic", policy: smallPolicy });
  const largeResult = viewFile("test.json", content, { mode: "semantic", policy: largePolicy });
  assert.equal(smallResult.parseStatus, "parsed");
  assert.ok(
    viewed(smallResult).content.includes("... (truncated)"),
    "span exceeding maxContextLines=3 must be truncated with the marker",
  );
  assert.ok(
    !viewed(largeResult).content.includes("... (truncated)"),
    "span within maxContextLines=100 must NOT be truncated",
  );
});

test("behavioral: preserveStructure=false collapses consecutive pure redaction lines", () => {
  // Two lines, each containing only a token prefix secret. After redaction,
  // each line becomes a pure `[REDACTED:token]` marker line. With
  // preserveStructure=false, consecutive pure-redaction lines collapse to a
  // single representative line. With true (default), both lines are kept.
  const content = ("sk" + "_abcdefghijklmnopqrstuvwx\nghp_abcdefghijklmnopqrstuvwx");
  const falsePolicy = createPrivacyPolicy({ preserveStructure: false });
  const truePolicy = createPrivacyPolicy({ preserveStructure: true });
  const falseResult = viewFile("test.ts", content, { mode: "full", policy: falsePolicy });
  const trueResult = viewFile("test.ts", content, { mode: "full", policy: truePolicy });
  assert.equal(
    viewed(falseResult).content.split("\n").length,
    1,
    "preserveStructure=false must collapse consecutive pure redaction lines to 1",
  );
  assert.equal(
    viewed(trueResult).content.split("\n").length,
    2,
    "preserveStructure=true must preserve consecutive pure redaction lines at 2",
  );
  assert.ok(!viewed(falseResult).content.includes("sk_"), "secret value must be redacted");
  assert.ok(!viewed(falseResult).content.includes("ghp_"), "secret value must be redacted");
});
