import assert from "node:assert/strict";
import test from "node:test";

import { sha256 } from "../../src/kernel/integrity.ts";
import {
  computeApplyPatch,
  computeDeleteRange,
  computeEdit,
  computeEditFromOperation,
  computeInsertText,
  computeReplaceFile,
  computeReplaceRange,
  parseUnifiedDiff,
  type EditOperation,
} from "../../src/editor/edit-operations.ts";

const SAMPLE_CONTENT = "line1\nline2\nline3\nline4\nline5";

function hash(content: string): string {
  return sha256(content);
}

// ============================================================================
// computeReplaceFile
// ============================================================================

test("edit-ops: computeReplaceFile returns new content and expected hash", () => {
  const result = computeReplaceFile(SAMPLE_CONTENT, { kind: "replaceFile", newContent: "new content" });
  assert.equal(result.newContent, "new content");
  assert.equal(result.expectedPostimageHash, hash("new content"));
});

test("edit-ops: computeReplaceFile with empty content", () => {
  const result = computeReplaceFile(SAMPLE_CONTENT, { kind: "replaceFile", newContent: "" });
  assert.equal(result.newContent, "");
  assert.equal(result.expectedPostimageHash, hash(""));
});

test("edit-ops: computeReplaceFile with multiline content", () => {
  const newContent = "a\nb\nc";
  const result = computeReplaceFile(SAMPLE_CONTENT, { kind: "replaceFile", newContent });
  assert.equal(result.newContent, newContent);
  assert.equal(result.expectedPostimageHash, hash(newContent));
});

test("edit-ops: computeReplaceFile ignores preimage content", () => {
  const result1 = computeReplaceFile("old1", { kind: "replaceFile", newContent: "new" });
  const result2 = computeReplaceFile("old2", { kind: "replaceFile", newContent: "new" });
  assert.equal(result1.newContent, result2.newContent);
  assert.equal(result1.expectedPostimageHash, result2.expectedPostimageHash);
});

test("edit-ops: computeReplaceFile rejects non-string newContent", () => {
  assert.throws(
    () => computeReplaceFile(SAMPLE_CONTENT, { kind: "replaceFile", newContent: 42 as never }),
    (e: unknown) => (e as Error).message.includes("newContent"),
  );
});

// ============================================================================
// computeInsertText
// ============================================================================

test("edit-ops: computeInsertText inserts at beginning", () => {
  const result = computeInsertText(SAMPLE_CONTENT, { kind: "insertText", byteOffset: 0, text: "PRE" });
  assert.equal(result.newContent, "PRE" + SAMPLE_CONTENT);
  assert.equal(result.expectedPostimageHash, hash("PRE" + SAMPLE_CONTENT));
});

test("edit-ops: computeInsertText inserts at end", () => {
  const len = Buffer.byteLength(SAMPLE_CONTENT, "utf8");
  const result = computeInsertText(SAMPLE_CONTENT, { kind: "insertText", byteOffset: len, text: "POST" });
  assert.equal(result.newContent, SAMPLE_CONTENT + "POST");
});

test("edit-ops: computeInsertText inserts in middle", () => {
  const result = computeInsertText(SAMPLE_CONTENT, { kind: "insertText", byteOffset: 5, text: "MID" });
  // byte offset 5 is right after "line1" (5 bytes)
  assert.equal(result.newContent, "line1" + "MID" + "\nline2\nline3\nline4\nline5");
});

test("edit-ops: computeInsertText with empty text is a no-op", () => {
  const result = computeInsertText(SAMPLE_CONTENT, { kind: "insertText", byteOffset: 5, text: "" });
  assert.equal(result.newContent, SAMPLE_CONTENT);
  assert.equal(result.expectedPostimageHash, hash(SAMPLE_CONTENT));
});

test("edit-ops: computeInsertText with empty preimage", () => {
  const result = computeInsertText("", { kind: "insertText", byteOffset: 0, text: "hello" });
  assert.equal(result.newContent, "hello");
});

test("edit-ops: computeInsertText rejects negative offset", () => {
  assert.throws(
    () => computeInsertText(SAMPLE_CONTENT, { kind: "insertText", byteOffset: -1, text: "x" }),
    (e: unknown) => (e as Error).message.includes("byteOffset"),
  );
});

test("edit-ops: computeInsertText rejects non-integer offset", () => {
  assert.throws(
    () => computeInsertText(SAMPLE_CONTENT, { kind: "insertText", byteOffset: 1.5, text: "x" }),
    (e: unknown) => (e as Error).message.includes("byteOffset"),
  );
});

test("edit-ops: computeInsertText rejects offset beyond content length", () => {
  const len = Buffer.byteLength(SAMPLE_CONTENT, "utf8");
  assert.throws(
    () => computeInsertText(SAMPLE_CONTENT, { kind: "insertText", byteOffset: len + 1, text: "x" }),
    (e: unknown) => (e as Error).message.includes("out_of_range") || (e as Error).message.includes("exceeds"),
  );
});

test("edit-ops: computeInsertText with multi-byte UTF-8 at boundary", () => {
  const content = "café"; // é is 2 bytes
  const result = computeInsertText(content, { kind: "insertText", byteOffset: 3, text: "X" });
  // "caf" (3 bytes) + "X" + "é" (2 bytes)
  assert.equal(result.newContent, "cafXé");
});

test("edit-ops: computeInsertText rejects non-UTF-8 boundary (mid-character)", () => {
  const content = "café"; // é is 2 bytes, starts at byte 3
  assert.throws(
    () => computeInsertText(content, { kind: "insertText", byteOffset: 4, text: "X" }),
    (e: unknown) => (e as Error).message.toLowerCase().includes("utf"),
  );
});

test("edit-ops: computeInsertText with emoji (4-byte characters)", () => {
  const content = "😀hello";
  // 😀 is 4 bytes, so byte offset 4 is after the emoji
  const result = computeInsertText(content, { kind: "insertText", byteOffset: 4, text: "X" });
  assert.equal(result.newContent, "😀Xhello");
});

// ============================================================================
// computeDeleteRange
// ============================================================================

test("edit-ops: computeDeleteRange deletes from beginning", () => {
  const result = computeDeleteRange(SAMPLE_CONTENT, { kind: "deleteRange", startByte: 0, endByte: 5 });
  assert.equal(result.newContent, "\nline2\nline3\nline4\nline5");
});

test("edit-ops: computeDeleteRange deletes from end", () => {
  const len = Buffer.byteLength(SAMPLE_CONTENT, "utf8");
  const result = computeDeleteRange(SAMPLE_CONTENT, { kind: "deleteRange", startByte: len - 5, endByte: len });
  assert.equal(result.newContent, "line1\nline2\nline3\nline4\n");
});

test("edit-ops: computeDeleteRange deletes from middle", () => {
  const result = computeDeleteRange(SAMPLE_CONTENT, { kind: "deleteRange", startByte: 5, endByte: 11 });
  // deletes "\nline2" (bytes 5-10, so endByte=11)
  assert.equal(result.newContent, "line1\nline3\nline4\nline5");
});

test("edit-ops: computeDeleteRange with zero-length range is no-op", () => {
  const result = computeDeleteRange(SAMPLE_CONTENT, { kind: "deleteRange", startByte: 5, endByte: 5 });
  assert.equal(result.newContent, SAMPLE_CONTENT);
  assert.equal(result.expectedPostimageHash, hash(SAMPLE_CONTENT));
});

test("edit-ops: computeDeleteRange deletes entire content", () => {
  const len = Buffer.byteLength(SAMPLE_CONTENT, "utf8");
  const result = computeDeleteRange(SAMPLE_CONTENT, { kind: "deleteRange", startByte: 0, endByte: len });
  assert.equal(result.newContent, "");
});

test("edit-ops: computeDeleteRange rejects inverted range", () => {
  assert.throws(
    () => computeDeleteRange(SAMPLE_CONTENT, { kind: "deleteRange", startByte: 10, endByte: 5 }),
    (e: unknown) => (e as Error).message.includes("inverted"),
  );
});

test("edit-ops: computeDeleteRange rejects negative start", () => {
  assert.throws(
    () => computeDeleteRange(SAMPLE_CONTENT, { kind: "deleteRange", startByte: -1, endByte: 5 }),
    (e: unknown) => (e as Error).message.includes("startByte"),
  );
});

test("edit-ops: computeDeleteRange rejects end beyond content", () => {
  const len = Buffer.byteLength(SAMPLE_CONTENT, "utf8");
  assert.throws(
    () => computeDeleteRange(SAMPLE_CONTENT, { kind: "deleteRange", startByte: 0, endByte: len + 1 }),
    (e: unknown) => (e as Error).message.includes("out_of_range") || (e as Error).message.includes("exceeds"),
  );
});

// ============================================================================
// computeReplaceRange
// ============================================================================

test("edit-ops: computeReplaceRange replaces at beginning", () => {
  const result = computeReplaceRange(SAMPLE_CONTENT, { kind: "replaceRange", startByte: 0, endByte: 5, text: "NEW" });
  assert.equal(result.newContent, "NEW\nline2\nline3\nline4\nline5");
});

test("edit-ops: computeReplaceRange replaces at end", () => {
  const len = Buffer.byteLength(SAMPLE_CONTENT, "utf8");
  const result = computeReplaceRange(SAMPLE_CONTENT, { kind: "replaceRange", startByte: len - 5, endByte: len, text: "END" });
  assert.equal(result.newContent, "line1\nline2\nline3\nline4\nEND");
});

test("edit-ops: computeReplaceRange replaces in middle", () => {
  const result = computeReplaceRange(SAMPLE_CONTENT, { kind: "replaceRange", startByte: 6, endByte: 11, text: "LINE2" });
  assert.equal(result.newContent, "line1\nLINE2\nline3\nline4\nline5");
});

test("edit-ops: computeReplaceRange with empty text is same as delete", () => {
  const result = computeReplaceRange(SAMPLE_CONTENT, { kind: "replaceRange", startByte: 0, endByte: 5, text: "" });
  assert.equal(result.newContent, "\nline2\nline3\nline4\nline5");
});

test("edit-ops: computeReplaceRange with zero-length range is same as insert", () => {
  const result = computeReplaceRange(SAMPLE_CONTENT, { kind: "replaceRange", startByte: 5, endByte: 5, text: "X" });
  assert.equal(result.newContent, "line1X\nline2\nline3\nline4\nline5");
});

test("edit-ops: computeReplaceRange rejects inverted range", () => {
  assert.throws(
    () => computeReplaceRange(SAMPLE_CONTENT, { kind: "replaceRange", startByte: 10, endByte: 5, text: "x" }),
    (e: unknown) => (e as Error).message.includes("inverted"),
  );
});

// ============================================================================
// computeApplyPatch
// ============================================================================

test("edit-ops: computeApplyPatch applies simple addition patch", () => {
  const patch = `--- a/test.txt\n+++ b/test.txt\n@@ -1,3 +1,4 @@\n line1\n line2\n line3\n+line3.5\n line4`;
  const content = "line1\nline2\nline3\nline4\nline5";
  const result = computeApplyPatch(content, { kind: "applyPatch", patch });
  assert.equal(result.newContent, "line1\nline2\nline3\nline3.5\nline4\nline5");
});

test("edit-ops: computeApplyPatch applies simple removal patch", () => {
  const patch = `--- a/test.txt\n+++ b/test.txt\n@@ -1,4 +1,3 @@\n line1\n line2\n-line3\n line4`;
  const content = "line1\nline2\nline3\nline4\nline5";
  const result = computeApplyPatch(content, { kind: "applyPatch", patch });
  assert.equal(result.newContent, "line1\nline2\nline4\nline5");
});

test("edit-ops: computeApplyPatch applies simple replacement patch", () => {
  const patch = `--- a/test.txt\n+++ b/test.txt\n@@ -1,3 +1,3 @@\n line1\n-line2\n+LINE2\n line3`;
  const content = "line1\nline2\nline3\nline4\nline5";
  const result = computeApplyPatch(content, { kind: "applyPatch", patch });
  assert.equal(result.newContent, "line1\nLINE2\nline3\nline4\nline5");
});

test("edit-ops: computeApplyPatch applies multi-hunk patch", () => {
  const content = "a\nb\nc\nd\ne";
  const patch = `--- a/test.txt\n+++ b/test.txt\n@@ -1,2 +1,2 @@\n-a\n+A\n b\n@@ -4,2 +4,2 @@\n d\n-e\n+E`;
  const result = computeApplyPatch(content, { kind: "applyPatch", patch });
  assert.equal(result.newContent, "A\nb\nc\nd\nE");
});

test("edit-ops: computeApplyPatch rejects empty patch", () => {
  assert.throws(
    () => computeApplyPatch(SAMPLE_CONTENT, { kind: "applyPatch", patch: "" }),
    (e: unknown) => (e as Error).message.includes("no hunks") || (e as Error).message.includes("empty"),
  );
});

test("edit-ops: computeApplyPatch rejects context mismatch", () => {
  const patch = `--- a/test.txt\n+++ b/test.txt\n@@ -1,2 +1,2 @@\n WRONG\n line2`;
  assert.throws(
    () => computeApplyPatch("line1\nline2", { kind: "applyPatch", patch }),
    (e: unknown) => (e as Error).message.includes("mismatch"),
  );
});

test("edit-ops: computeApplyPatch rejects invalid hunk header", () => {
  const patch = `--- a/test.txt\n+++ b/test.txt\n@@ invalid header @@\n line1`;
  assert.throws(
    () => computeApplyPatch("line1", { kind: "applyPatch", patch }),
    (e: unknown) => (e as Error).message.includes("hunk header"),
  );
});

// ============================================================================
// parseUnifiedDiff
// ============================================================================

test("edit-ops: parseUnifiedDiff parses single hunk", () => {
  const patch = `@@ -1,3 +1,3 @@\n line1\n-old\n+new\n line3`;
  const hunks = parseUnifiedDiff(patch);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0]!.oldStart, 1);
  assert.equal(hunks[0]!.oldCount, 3);
  assert.equal(hunks[0]!.newStart, 1);
  assert.equal(hunks[0]!.newCount, 3);
  assert.equal(hunks[0]!.lines.length, 4);
});

test("edit-ops: parseUnifiedDiff parses multiple hunks", () => {
  const patch = `@@ -1,2 +1,2 @@\n a\n-b\n+B\n@@ -5,2 +5,2 @@\n e\n-f\n+F`;
  const hunks = parseUnifiedDiff(patch);
  assert.equal(hunks.length, 2);
});

test("edit-ops: parseUnifiedDiff skips --- and +++ header lines", () => {
  const patch = `--- a/file.txt\n+++ b/file.txt\n@@ -1,1 +1,1 @@\n-a\n+a`;
  const hunks = parseUnifiedDiff(patch);
  assert.equal(hunks.length, 1);
});

// ============================================================================
// computeEdit dispatcher
// ============================================================================

test("edit-ops: computeEdit dispatches to replaceFile", () => {
  const op: EditOperation = { kind: "replaceFile", newContent: "new" };
  const result = computeEdit("old", op);
  assert.equal(result.newContent, "new");
});

test("edit-ops: computeEdit dispatches to insertText", () => {
  const op: EditOperation = { kind: "insertText", byteOffset: 0, text: "PRE" };
  const result = computeEdit("old", op);
  assert.equal(result.newContent, "PREold");
});

test("edit-ops: computeEdit dispatches to deleteRange", () => {
  const op: EditOperation = { kind: "deleteRange", startByte: 0, endByte: 3 };
  const result = computeEdit("hello", op);
  assert.equal(result.newContent, "lo");
});

test("edit-ops: computeEdit dispatches to replaceRange", () => {
  const op: EditOperation = { kind: "replaceRange", startByte: 0, endByte: 3, text: "X" };
  const result = computeEdit("hello", op);
  assert.equal(result.newContent, "Xlo");
});

test("edit-ops: computeEdit dispatches to applyPatch", () => {
  const patch = `@@ -1,1 +1,1 @@\n-old\n+new`;
  const op: EditOperation = { kind: "applyPatch", patch };
  const result = computeEdit("old", op);
  assert.equal(result.newContent, "new");
});

test("edit-ops: computeEditFromOperation is an alias for computeEdit", () => {
  const op: EditOperation = { kind: "replaceFile", newContent: "new" };
  const result = computeEditFromOperation(op, "old");
  assert.equal(result.newContent, "new");
});

// ============================================================================
// Expected postimage hash correctness
// ============================================================================

test("edit-ops: expectedPostimageHash matches sha256 of newContent for replaceFile", () => {
  const result = computeReplaceFile("old", { kind: "replaceFile", newContent: "content" });
  assert.equal(result.expectedPostimageHash, sha256("content"));
});

test("edit-ops: expectedPostimageHash matches sha256 of newContent for insertText", () => {
  const result = computeInsertText("abc", { kind: "insertText", byteOffset: 3, text: "def" });
  assert.equal(result.expectedPostimageHash, sha256("abcdef"));
});

test("edit-ops: expectedPostimageHash matches sha256 of newContent for deleteRange", () => {
  const result = computeDeleteRange("abcdef", { kind: "deleteRange", startByte: 0, endByte: 3 });
  assert.equal(result.expectedPostimageHash, sha256("def"));
});

test("edit-ops: expectedPostimageHash matches sha256 of newContent for replaceRange", () => {
  const result = computeReplaceRange("abcdef", { kind: "replaceRange", startByte: 0, endByte: 3, text: "XYZ" });
  assert.equal(result.expectedPostimageHash, sha256("XYZdef"));
});

// ============================================================================
// Edge cases and hostile inputs
// ============================================================================

test("edit-ops: insertText at offset 0 of empty string works", () => {
  const result = computeInsertText("", { kind: "insertText", byteOffset: 0, text: "hello" });
  assert.equal(result.newContent, "hello");
  assert.equal(result.expectedPostimageHash, sha256("hello"));
});

test("edit-ops: deleteRange on empty string with zero range is no-op", () => {
  const result = computeDeleteRange("", { kind: "deleteRange", startByte: 0, endByte: 0 });
  assert.equal(result.newContent, "");
  assert.equal(result.expectedPostimageHash, sha256(""));
});

test("edit-ops: replaceRange on empty string inserts text", () => {
  const result = computeReplaceRange("", { kind: "replaceRange", startByte: 0, endByte: 0, text: "hello" });
  assert.equal(result.newContent, "hello");
});

test("edit-ops: handle Unicode characters in insertText", () => {
  const content = "hello";
  const result = computeInsertText(content, { kind: "insertText", byteOffset: 5, text: " 世界" });
  assert.equal(result.newContent, "hello 世界");
  assert.equal(result.expectedPostimageHash, sha256("hello 世界"));
});

test("edit-ops: handle CRLF line endings in content", () => {
  const content = "line1\r\nline2\r\nline3";
  const result = computeReplaceFile(content, { kind: "replaceFile", newContent: "new\r\ncontent" });
  assert.equal(result.newContent, "new\r\ncontent");
  assert.equal(result.expectedPostimageHash, sha256("new\r\ncontent"));
});

test("edit-ops: handle content with null bytes", () => {
  const content = "before\x00after";
  const result = computeInsertText(content, { kind: "insertText", byteOffset: 6, text: "X" });
  assert.equal(result.newContent, "beforeX\x00after");
});

test("edit-ops: large content replacement works", () => {
  const large = "x".repeat(10000);
  const result = computeReplaceFile("old", { kind: "replaceFile", newContent: large });
  assert.equal(result.newContent, large);
  assert.equal(result.expectedPostimageHash, sha256(large));
});
