import assert from "node:assert/strict";
import test from "node:test";

import {
  createFileNotFoundFeedback,
  createFileOversizedFeedback,
  createOperationInvalidFeedback,
  createPathInvalidFeedback,
  createPatchInvalidFeedback,
  createPostwriteMismatchFeedback,
  createPreimageMismatchFeedback,
  createPreimageMissingFeedback,
  createRollbackFeedback,
  createSyntaxErrorFeedback,
  createWriteFailedFeedback,
  createWriteSetDeniedFeedback,
  createZeroDeltaFeedback,
  feedbackToStructured,
  type EditFeedback,
} from "../../src/editor/edit-feedback.ts";
import type { SyntaxDiagnostic } from "../../src/editor/syntax-validator.ts";

const SAMPLE_HASH = "a".repeat(64);
const SAMPLE_HASH_B = "b".repeat(64);

const SAMPLE_DIAGNOSTICS: readonly SyntaxDiagnostic[] = [
  { severity: "error", line: 5, column: 10, message: "Unexpected token", code: "syntax_error" },
  { severity: "error", line: 7, column: 3, message: "Missing semicolon", code: "missing_semi" },
];

// ============================================================================
// createPreimageMismatchFeedback
// ============================================================================

test("feedback: preimage mismatch has correct type", () => {
  const f = createPreimageMismatchFeedback("test.ts", SAMPLE_HASH, SAMPLE_HASH_B);
  assert.equal(f.errorType, "preimage_mismatch");
});

test("feedback: preimage mismatch includes expected and actual hashes", () => {
  const f = createPreimageMismatchFeedback("test.ts", SAMPLE_HASH, SAMPLE_HASH_B);
  assert.equal(f.expectedPreimageHash, SAMPLE_HASH);
  assert.equal(f.actualPreimageHash, SAMPLE_HASH_B);
});

test("feedback: preimage mismatch is retryable and recoverable", () => {
  const f = createPreimageMismatchFeedback("test.ts", SAMPLE_HASH, SAMPLE_HASH_B);
  assert.equal(f.retryable, true);
  assert.equal(f.recoverable, true);
});

test("feedback: preimage mismatch includes suggested correction", () => {
  const f = createPreimageMismatchFeedback("test.ts", SAMPLE_HASH, SAMPLE_HASH_B);
  assert.ok(f.suggestedCorrection !== undefined);
  assert.ok(f.suggestedCorrection!.includes("re-read") || f.suggestedCorrection!.includes("Re-read"));
});

test("feedback: preimage mismatch includes path", () => {
  const f = createPreimageMismatchFeedback("test.ts", SAMPLE_HASH, SAMPLE_HASH_B);
  assert.equal(f.path, "test.ts");
});

test("feedback: preimage mismatch message mentions changed file", () => {
  const f = createPreimageMismatchFeedback("test.ts", SAMPLE_HASH, SAMPLE_HASH_B);
  assert.ok(f.message.includes("changed"));
});

// ============================================================================
// createPreimageMissingFeedback
// ============================================================================

test("feedback: preimage missing has correct type", () => {
  const f = createPreimageMissingFeedback("test.ts", SAMPLE_HASH);
  assert.equal(f.errorType, "preimage_missing");
});

test("feedback: preimage missing is retryable", () => {
  const f = createPreimageMissingFeedback("test.ts", SAMPLE_HASH);
  assert.equal(f.retryable, true);
  assert.equal(f.recoverable, true);
});

test("feedback: preimage missing includes expected hash", () => {
  const f = createPreimageMissingFeedback("test.ts", SAMPLE_HASH);
  assert.equal(f.expectedPreimageHash, SAMPLE_HASH);
});

// ============================================================================
// createSyntaxErrorFeedback
// ============================================================================

test("feedback: syntax error has correct type", () => {
  const f = createSyntaxErrorFeedback("test.ts", SAMPLE_DIAGNOSTICS);
  assert.equal(f.errorType, "syntax_error");
});

test("feedback: syntax error includes diagnostics", () => {
  const f = createSyntaxErrorFeedback("test.ts", SAMPLE_DIAGNOSTICS);
  assert.equal(f.syntaxDiagnostics!.length, 2);
  assert.equal(f.syntaxDiagnostics![0]!.line, 5);
});

test("feedback: syntax error is retryable", () => {
  const f = createSyntaxErrorFeedback("test.ts", SAMPLE_DIAGNOSTICS);
  assert.equal(f.retryable, true);
});

test("feedback: syntax error suggested correction references first error", () => {
  const f = createSyntaxErrorFeedback("test.ts", SAMPLE_DIAGNOSTICS);
  assert.ok(f.suggestedCorrection!.includes("line 5"));
});

test("feedback: syntax error message includes count", () => {
  const f = createSyntaxErrorFeedback("test.ts", SAMPLE_DIAGNOSTICS);
  assert.ok(f.message.includes("2"));
});

test("feedback: syntax error with empty diagnostics uses fallback correction", () => {
  const f = createSyntaxErrorFeedback("test.ts", []);
  assert.ok(f.suggestedCorrection !== undefined);
});

test("feedback: syntax error with only warnings uses first diagnostic", () => {
  const warnings: readonly SyntaxDiagnostic[] = [
    { severity: "warning", line: 1, column: 1, message: "deprecated", code: "deprecated" },
  ];
  const f = createSyntaxErrorFeedback("test.ts", warnings);
  assert.equal(f.syntaxDiagnostics!.length, 1);
});

// ============================================================================
// createWriteSetDeniedFeedback
// ============================================================================

test("feedback: write set denied has correct type", () => {
  const f = createWriteSetDeniedFeedback("test.ts", "2 paths");
  assert.equal(f.errorType, "write_set_denied");
});

test("feedback: write set denied is not retryable", () => {
  const f = createWriteSetDeniedFeedback("test.ts", "2 paths");
  assert.equal(f.retryable, false);
  assert.equal(f.recoverable, false);
});

test("feedback: write set denied includes path", () => {
  const f = createWriteSetDeniedFeedback("test.ts", "2 paths");
  assert.equal(f.path, "test.ts");
});

test("feedback: write set denied message includes write set description", () => {
  const f = createWriteSetDeniedFeedback("test.ts", "2 authorized path(s)");
  assert.ok(f.message.includes("2 authorized"));
});

// ============================================================================
// createWriteFailedFeedback
// ============================================================================

test("feedback: write failed has correct type", () => {
  const f = createWriteFailedFeedback("test.ts", "disk full");
  assert.equal(f.errorType, "write_failed");
});

test("feedback: write failed is retryable", () => {
  const f = createWriteFailedFeedback("test.ts", "disk full");
  assert.equal(f.retryable, true);
});

test("feedback: write failed message includes reason", () => {
  const f = createWriteFailedFeedback("test.ts", "disk full");
  assert.ok(f.message.includes("disk full"));
});

// ============================================================================
// createPostwriteMismatchFeedback
// ============================================================================

test("feedback: postwrite mismatch has correct type", () => {
  const f = createPostwriteMismatchFeedback("test.ts", SAMPLE_HASH, SAMPLE_HASH_B);
  assert.equal(f.errorType, "postwrite_mismatch");
});

test("feedback: postwrite mismatch includes expected and actual", () => {
  const f = createPostwriteMismatchFeedback("test.ts", SAMPLE_HASH, SAMPLE_HASH_B);
  assert.equal(f.expectedPostimageHash, SAMPLE_HASH);
  assert.equal(f.actualPostimageHash, SAMPLE_HASH_B);
});

test("feedback: postwrite mismatch is retryable", () => {
  const f = createPostwriteMismatchFeedback("test.ts", SAMPLE_HASH, SAMPLE_HASH_B);
  assert.equal(f.retryable, true);
});

// ============================================================================
// createRollbackFeedback
// ============================================================================

test("feedback: rollback has correct type", () => {
  const f = createRollbackFeedback("test.ts", SAMPLE_HASH, "postwrite mismatch");
  assert.equal(f.errorType, "rollback_performed");
});

test("feedback: rollback includes preimage hash", () => {
  const f = createRollbackFeedback("test.ts", SAMPLE_HASH, "postwrite mismatch");
  assert.equal(f.expectedPreimageHash, SAMPLE_HASH);
});

test("feedback: rollback is retryable", () => {
  const f = createRollbackFeedback("test.ts", SAMPLE_HASH, "postwrite mismatch");
  assert.equal(f.retryable, true);
});

test("feedback: rollback message includes reason", () => {
  const f = createRollbackFeedback("test.ts", SAMPLE_HASH, "postwrite mismatch");
  assert.ok(f.message.includes("postwrite mismatch"));
});

// ============================================================================
// createZeroDeltaFeedback
// ============================================================================

test("feedback: zero delta has correct type", () => {
  const f = createZeroDeltaFeedback("test.ts", SAMPLE_HASH);
  assert.equal(f.errorType, "zero_delta_verification");
});

test("feedback: zero delta includes preimage hash", () => {
  const f = createZeroDeltaFeedback("test.ts", SAMPLE_HASH);
  assert.equal(f.expectedPreimageHash, SAMPLE_HASH);
});

// ============================================================================
// createOperationInvalidFeedback
// ============================================================================

test("feedback: operation invalid has correct type", () => {
  const f = createOperationInvalidFeedback("test.ts", "offset out of range");
  assert.equal(f.errorType, "operation_invalid");
});

test("feedback: operation invalid is retryable", () => {
  const f = createOperationInvalidFeedback("test.ts", "offset out of range");
  assert.equal(f.retryable, true);
});

// ============================================================================
// createPathInvalidFeedback
// ============================================================================

test("feedback: path invalid has correct type", () => {
  const f = createPathInvalidFeedback("test.ts", "absolute path forbidden");
  assert.equal(f.errorType, "path_invalid");
});

test("feedback: path invalid is not retryable", () => {
  const f = createPathInvalidFeedback("test.ts", "absolute path forbidden");
  assert.equal(f.retryable, false);
});

// ============================================================================
// createFileNotFoundFeedback
// ============================================================================

test("feedback: file not found has correct type", () => {
  const f = createFileNotFoundFeedback("test.ts");
  assert.equal(f.errorType, "file_not_found");
});

test("feedback: file not found is retryable", () => {
  const f = createFileNotFoundFeedback("test.ts");
  assert.equal(f.retryable, true);
});

// ============================================================================
// createFileOversizedFeedback
// ============================================================================

test("feedback: file oversized has correct type", () => {
  const f = createFileOversizedFeedback("test.ts", 1000000, 65536);
  assert.equal(f.errorType, "file_oversized");
});

test("feedback: file oversized is not retryable", () => {
  const f = createFileOversizedFeedback("test.ts", 1000000, 65536);
  assert.equal(f.retryable, false);
});

test("feedback: file oversized message includes sizes", () => {
  const f = createFileOversizedFeedback("test.ts", 1000000, 65536);
  assert.ok(f.message.includes("1000000"));
  assert.ok(f.message.includes("65536"));
});

// ============================================================================
// createPatchInvalidFeedback
// ============================================================================

test("feedback: patch invalid has correct type", () => {
  const f = createPatchInvalidFeedback("test.ts", "invalid hunk header");
  assert.equal(f.errorType, "patch_invalid");
});

test("feedback: patch invalid is retryable", () => {
  const f = createPatchInvalidFeedback("test.ts", "invalid hunk header");
  assert.equal(f.retryable, true);
});

// ============================================================================
// feedbackToStructured
// ============================================================================

test("feedback: toStructured converts feedback to record", () => {
  const f = createPreimageMismatchFeedback("test.ts", SAMPLE_HASH, SAMPLE_HASH_B);
  const s = feedbackToStructured(f);
  assert.equal(s.errorType, "preimage_mismatch");
  assert.equal(s.path, "test.ts");
  assert.equal(s.expectedPreimageHash, SAMPLE_HASH);
  assert.equal(s.actualPreimageHash, SAMPLE_HASH_B);
  assert.equal(s.recoverable, true);
  assert.equal(s.retryable, true);
});

test("feedback: toStructured omits undefined optional fields", () => {
  const f = createPathInvalidFeedback("test.ts", "invalid");
  const s = feedbackToStructured(f);
  assert.equal("expectedPreimageHash" in s, false);
  assert.equal("actualPreimageHash" in s, false);
  assert.equal("syntaxDiagnostics" in s, false);
});

test("feedback: toStructured includes syntaxDiagnostics when present", () => {
  const f = createSyntaxErrorFeedback("test.ts", SAMPLE_DIAGNOSTICS);
  const s = feedbackToStructured(f);
  assert.ok("syntaxDiagnostics" in s);
  assert.ok(Array.isArray(s.syntaxDiagnostics));
});

test("feedback: toStructured includes suggestedCorrection when present", () => {
  const f = createPreimageMismatchFeedback("test.ts", SAMPLE_HASH, SAMPLE_HASH_B);
  const s = feedbackToStructured(f);
  assert.ok("suggestedCorrection" in s);
});

// ============================================================================
// Immutability
// ============================================================================

test("feedback: feedback objects are frozen", () => {
  const f = createPreimageMismatchFeedback("test.ts", SAMPLE_HASH, SAMPLE_HASH_B);
  assert.ok(Object.isFrozen(f));
});

test("feedback: structured feedback is frozen", () => {
  const f = createPreimageMismatchFeedback("test.ts", SAMPLE_HASH, SAMPLE_HASH_B);
  const s = feedbackToStructured(f);
  assert.ok(Object.isFrozen(s));
});

// ============================================================================
// All error types have consistent shape
// ============================================================================

test("feedback: all error types have non-empty message", () => {
  const all: EditFeedback[] = [
    createPreimageMismatchFeedback("test.ts", SAMPLE_HASH, SAMPLE_HASH_B),
    createPreimageMissingFeedback("test.ts", SAMPLE_HASH),
    createSyntaxErrorFeedback("test.ts", SAMPLE_DIAGNOSTICS),
    createWriteSetDeniedFeedback("test.ts", "2 paths"),
    createWriteFailedFeedback("test.ts", "error"),
    createPostwriteMismatchFeedback("test.ts", SAMPLE_HASH, SAMPLE_HASH_B),
    createRollbackFeedback("test.ts", SAMPLE_HASH, "reason"),
    createZeroDeltaFeedback("test.ts", SAMPLE_HASH),
    createOperationInvalidFeedback("test.ts", "reason"),
    createPathInvalidFeedback("test.ts", "reason"),
    createFileNotFoundFeedback("test.ts"),
    createFileOversizedFeedback("test.ts", 1000, 100),
    createPatchInvalidFeedback("test.ts", "reason"),
  ];
  for (const f of all) {
    assert.ok(f.message.length > 0, `message empty for ${f.errorType}`);
    assert.equal(typeof f.path, "string");
    assert.equal(typeof f.recoverable, "boolean");
    assert.equal(typeof f.retryable, "boolean");
  }
});
