import assert from "node:assert/strict";
import test from "node:test";

import {
  computeInsertText,
  computeReplaceFile,
  computeReplaceRange,
  computeApplyPatch,
} from "../../src/editor/edit-operations.ts";

// ---------------------------------------------------------------------------
// Fix 11: the local `assertString` helper in edit-operations.ts was renamed to
// `assertIsString` to avoid colliding with the canonical `assertString` in
// src/runtime/tool-args.ts. Both helpers exist with different signatures:
// - tool-args.ts:assertString(args, key, opts?) — record + key lookup
// - edit-operations.ts:assertIsString(value, field) — type predicate
//
// These tests verify the renamed helper still throws with the correct error
// code for each edit operation that uses it. The existing edit-operations
// tests cover the happy paths; this file covers the error paths explicitly
// to ensure the rename did not break the type-predicate behavior.
// ---------------------------------------------------------------------------

const SAMPLE = "line1\nline2\n";

test("assertIsString rename: computeReplaceFile rejects non-string newContent with edit_newContent_invalid", () => {
  assert.throws(
    () => computeReplaceFile(SAMPLE, { kind: "replaceFile", newContent: 42 as never }),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      return (e as { code?: string }).code === "edit_newContent_invalid";
    },
  );
});

test("assertIsString rename: computeApplyPatch rejects non-string patch with edit_patch_invalid", () => {
  assert.throws(
    () => computeApplyPatch(SAMPLE, { kind: "applyPatch", patch: 42 as never }),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      return (e as { code?: string }).code === "edit_patch_invalid";
    },
  );
});

test("assertIsString rename: computeInsertText rejects non-string text with edit_text_invalid", () => {
  assert.throws(
    () => computeInsertText(SAMPLE, { kind: "insertText", byteOffset: 0, text: 42 as never }),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      return (e as { code?: string }).code === "edit_text_invalid";
    },
  );
});

test("assertIsString rename: computeReplaceRange rejects non-string text with edit_text_invalid", () => {
  assert.throws(
    () => computeReplaceRange(SAMPLE, { kind: "replaceRange", startByte: 0, endByte: 2, text: 42 as never }),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      return (e as { code?: string }).code === "edit_text_invalid";
    },
  );
});
