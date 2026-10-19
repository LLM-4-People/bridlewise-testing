import assert from "node:assert/strict";
import { rmSync, writeFileSync, mkdirSync, symlinkSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { sha256 } from "../../src/kernel/integrity.ts";
import { atomicWriteFile } from "../../src/filesystem/atomic-write.ts";
import {
  createTransactionalEditor,
  type EditorEffectRecorder,
  type TransactionalEditor,
} from "../../src/editor/transactional-editor.ts";
import { createDefaultSyntaxValidatorRegistry } from "../../src/editor/syntax-validator.ts";
import { mkTempDir } from "../support/temp-dir.ts";
import { ownedTemporaryOwnerOf } from "../../src/filesystem/private-state.ts";

type AtomicWriter = (resolvedPath: string, content: string) => Readonly<{ success: boolean; reason?: string }>;

function mkEditor(dir: string, writeSet: ReadonlySet<string>, options?: { recorder?: EditorEffectRecorder; skipSyntax?: boolean; atomicWriter?: AtomicWriter }): TransactionalEditor {
  return createTransactionalEditor({
    repositoryRoot: dir,
    writeSet,
    ...(options?.recorder !== undefined ? { recorder: options.recorder } : {}),
    ...(options?.skipSyntax !== undefined ? { skipSyntaxValidation: options.skipSyntax } : {}),
    ...(options?.atomicWriter !== undefined ? { atomicWriter: options.atomicWriter } : {}),
  });
}

function writeFile(dir: string, relPath: string, content: string): string {
  const full = join(dir, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  return sha256(content);
}

function readHash(dir: string, relPath: string): string {
  return sha256(readFileSync(join(dir, relPath), "utf8"));
}

const VALID_TS = "export const x = 42;";
const VALID_TS2 = "export const y = 99;";

// ============================================================================
// Construction and configuration
// ============================================================================

test("editor: createTransactionalEditor creates editor with write set", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const editor = mkEditor(dir, new Set(["test.ts"]));
    assert.equal(editor.getRepositoryRoot(), dir);
    assert.deepEqual(editor.getWriteSet(), ["test.ts"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: getWriteSet returns sorted paths", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const editor = mkEditor(dir, new Set(["z.ts", "a.ts", "m.ts"]));
    assert.deepEqual(editor.getWriteSet(), ["a.ts", "m.ts", "z.ts"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: constructor throws on missing repository root", () => {
  assert.throws(
    () => createTransactionalEditor({ repositoryRoot: "", writeSet: new Set(["a.ts"]) }),
    (e: unknown) => (e as Error).message.includes("root"),
  );
});

test("editor: constructor throws on missing write set", () => {
  assert.throws(
    () => createTransactionalEditor({ repositoryRoot: "/tmp", writeSet: undefined as never }),
    (e: unknown) => (e as Error).message.toLowerCase().includes("write set"),
  );
});

test("editor: constructor accepts custom syntax validator registry", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const registry = createDefaultSyntaxValidatorRegistry();
    const editor = createTransactionalEditor({
      repositoryRoot: dir,
      writeSet: new Set(["test.ts"]),
      syntaxValidatorRegistry: registry,
    });
    assert.ok(editor);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// replaceFile — success path
// ============================================================================

test("editor: replaceFile succeeds with correct preimage", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "test.ts", VALID_TS);
    const editor = mkEditor(dir, new Set(["test.ts"]));
    const result = editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent: VALID_TS2 },
    });
    assert.equal(result.success, true);
    assert.equal(result.feedback, null);
    assert.equal(result.rolledBack, false);
    assert.equal(result.zeroDeltaVerified, true);
    assert.equal(readHash(dir, "test.ts"), sha256(VALID_TS2));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: replaceFile postimage hash matches expected", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "test.ts", VALID_TS);
    const editor = mkEditor(dir, new Set(["test.ts"]));
    const result = editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent: VALID_TS2 },
    });
    assert.equal(result.success, true);
    assert.equal(result.postimageHash, sha256(VALID_TS2));
    assert.equal(result.expectedPostimageHash, sha256(VALID_TS2));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: replaceFile records durationMs", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "test.ts", VALID_TS);
    const editor = mkEditor(dir, new Set(["test.ts"]));
    const result = editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent: VALID_TS2 },
    });
    assert.equal(result.success, true);
    assert.ok(result.durationMs >= 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: replaceFile preserves preimageHash in result", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "test.ts", VALID_TS);
    const editor = mkEditor(dir, new Set(["test.ts"]));
    const result = editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent: VALID_TS2 },
    });
    assert.equal(result.preimageHash, preimage);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// Preimage verification — mismatch
// ============================================================================

test("editor: replaceFile fails on preimage mismatch (file changed)", () => {
  const dir = mkTempDir("editor-test-");
  try {
    writeFile(dir, "test.ts", VALID_TS);
    const editor = mkEditor(dir, new Set(["test.ts"]));
    const wrongHash = "0".repeat(64);
    const result = editor.applyEdit({
      path: "test.ts",
      preimageHash: wrongHash,
      operation: { kind: "replaceFile", newContent: VALID_TS2 },
    });
    assert.equal(result.success, false);
    assert.ok(result.feedback !== null);
    assert.equal(result.feedback!.errorType, "preimage_mismatch");
    assert.equal(result.feedback!.expectedPreimageHash, wrongHash);
    assert.ok(result.feedback!.actualPreimageHash !== undefined);
    // File should be unchanged
    assert.equal(readHash(dir, "test.ts"), sha256(VALID_TS));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: preimage mismatch feedback is retryable", () => {
  const dir = mkTempDir("editor-test-");
  try {
    writeFile(dir, "test.ts", VALID_TS);
    const editor = mkEditor(dir, new Set(["test.ts"]));
    const result = editor.applyEdit({
      path: "test.ts",
      preimageHash: "0".repeat(64),
      operation: { kind: "replaceFile", newContent: VALID_TS2 },
    });
    assert.equal(result.feedback!.retryable, true);
    assert.equal(result.feedback!.recoverable, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: preimage mismatch includes suggested correction", () => {
  const dir = mkTempDir("editor-test-");
  try {
    writeFile(dir, "test.ts", VALID_TS);
    const editor = mkEditor(dir, new Set(["test.ts"]));
    const result = editor.applyEdit({
      path: "test.ts",
      preimageHash: "0".repeat(64),
      operation: { kind: "replaceFile", newContent: VALID_TS2 },
    });
    assert.ok(result.feedback!.suggestedCorrection !== undefined);
    assert.ok(result.feedback!.suggestedCorrection!.includes("re-read") || result.feedback!.suggestedCorrection!.includes("Re-read"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// Preimage verification — missing file
// ============================================================================

test("editor: replaceFile fails on missing file with preimage provided", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const editor = mkEditor(dir, new Set(["missing.ts"]));
    const result = editor.applyEdit({
      path: "missing.ts",
      preimageHash: "a".repeat(64),
      operation: { kind: "replaceFile", newContent: VALID_TS },
    });
    assert.equal(result.success, false);
    assert.ok(result.feedback !== null);
    assert.equal(result.feedback!.errorType, "preimage_missing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: preimage missing feedback is retryable", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const editor = mkEditor(dir, new Set(["missing.ts"]));
    const result = editor.applyEdit({
      path: "missing.ts",
      preimageHash: "a".repeat(64),
      operation: { kind: "replaceFile", newContent: VALID_TS },
    });
    assert.equal(result.feedback!.retryable, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The create path: a missing file + the empty preimage (sha256("")) + a
// whole-file replaceFile is the ONE case where an absent preimage is the valid
// starting state. Every other combination must stay refused — otherwise the
// stale-snapshot signal is gone.

test("editor: create succeeds for a missing file with the empty preimage + replaceFile", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const editor = mkEditor(dir, new Set(["new.ts"]));
    const result = editor.applyEdit({
      path: "new.ts",
      preimageHash: sha256(""),
      operation: { kind: "replaceFile", newContent: VALID_TS },
    });
    assert.equal(result.success, true);
    assert.equal(readFileSync(join(dir, "new.ts"), "utf8"), VALID_TS);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: a missing file with a NON-empty preimage is still refused (the create path cannot be reached by guessing a hash)", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const editor = mkEditor(dir, new Set(["missing.ts"]));
    const result = editor.applyEdit({
      path: "missing.ts",
      preimageHash: sha256("some prior content the model invented"),
      operation: { kind: "replaceFile", newContent: VALID_TS },
    });
    assert.equal(result.success, false);
    assert.equal(result.feedback!.errorType, "preimage_missing");
    // No file was created.
    assert.throws(() => readFileSync(join(dir, "missing.ts")), /ENOENT/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: the empty preimage on a missing file with a NON-replaceFile operation is refused (create is whole-file only)", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const editor = mkEditor(dir, new Set(["missing.ts"]));
    const result = editor.applyEdit({
      path: "missing.ts",
      preimageHash: sha256(""),
      operation: { kind: "insertText", byteOffset: 0, text: "x" },
    });
    assert.equal(result.success, false);
    assert.equal(result.feedback!.errorType, "preimage_missing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// Syntax validation
// ============================================================================

test("editor: replaceFile with valid syntax succeeds", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "test.ts", VALID_TS);
    const editor = mkEditor(dir, new Set(["test.ts"]));
    const result = editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent: "export const y = 100;" },
    });
    assert.equal(result.success, true);
    assert.ok(result.syntaxValidation !== null);
    assert.equal(result.syntaxValidation!.valid, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: replaceFile with invalid syntax fails", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "test.ts", VALID_TS);
    const editor = mkEditor(dir, new Set(["test.ts"]));
    const result = editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent: "function foo() {" },
    });
    assert.equal(result.success, false);
    assert.ok(result.feedback !== null);
    assert.equal(result.feedback!.errorType, "syntax_error");
    assert.ok(result.feedback!.syntaxDiagnostics !== undefined);
    assert.ok(result.feedback!.syntaxDiagnostics!.length > 0);
    // File should be unchanged
    assert.equal(readHash(dir, "test.ts"), sha256(VALID_TS));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: syntax error feedback includes line and column", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "test.ts", VALID_TS);
    const editor = mkEditor(dir, new Set(["test.ts"]));
    const result = editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent: "const x = {\n" },
    });
    assert.equal(result.feedback!.errorType, "syntax_error");
    const diag = result.feedback!.syntaxDiagnostics![0]!;
    assert.ok(typeof diag.line === "number");
    assert.ok(typeof diag.column === "number");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: syntax validation for JSON files", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "data.json", '{"key": "value"}');
    const editor = mkEditor(dir, new Set(["data.json"]));
    const result = editor.applyEdit({
      path: "data.json",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent: '{"new": "data"}' },
    });
    assert.equal(result.success, true);
    assert.equal(result.syntaxValidation!.language, "json");
    assert.equal(result.syntaxValidation!.valid, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: syntax validation rejects invalid JSON", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "data.json", '{"key": "value"}');
    const editor = mkEditor(dir, new Set(["data.json"]));
    const result = editor.applyEdit({
      path: "data.json",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent: '{"key":}' },
    });
    assert.equal(result.success, false);
    assert.equal(result.feedback!.errorType, "syntax_error");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: skipSyntaxValidation option bypasses syntax check", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "test.ts", VALID_TS);
    const editor = mkEditor(dir, new Set(["test.ts"]), { skipSyntax: true });
    const result = editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent: "function foo() {" },
    });
    assert.equal(result.success, true);
    assert.equal(result.syntaxValidation, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: unknown extension skips syntax by default with skipUnknown", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "readme.md", "# Title");
    const editor = createTransactionalEditor({
      repositoryRoot: dir,
      writeSet: new Set(["readme.md"]),
      skipUnknownExtensions: true,
    });
    const result = editor.applyEdit({
      path: "readme.md",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent: "# New Title" },
    });
    assert.equal(result.success, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: unknown extension fails without skipUnknown", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "readme.md", "# Title");
    const editor = createTransactionalEditor({
      repositoryRoot: dir,
      writeSet: new Set(["readme.md"]),
      skipUnknownExtensions: false,
    });
    const result = editor.applyEdit({
      path: "readme.md",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent: "# New Title" },
    });
    assert.equal(result.success, false);
    assert.equal(result.feedback!.errorType, "syntax_error");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// Write set enforcement
// ============================================================================

test("editor: denies write to path not in write set", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "test.ts", VALID_TS);
    const editor = mkEditor(dir, new Set(["allowed.ts"]));
    const result = editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent: VALID_TS2 },
    });
    assert.equal(result.success, false);
    assert.equal(result.feedback!.errorType, "write_set_denied");
    assert.equal(result.feedback!.retryable, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: allows write to path in write set", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "test.ts", VALID_TS);
    const editor = mkEditor(dir, new Set(["test.ts", "other.ts"]));
    const result = editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent: VALID_TS2 },
    });
    assert.equal(result.success, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: write set enforcement does not modify file", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "test.ts", VALID_TS);
    const editor = mkEditor(dir, new Set(["other.ts"]));
    editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent: VALID_TS2 },
    });
    assert.equal(readHash(dir, "test.ts"), sha256(VALID_TS));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// Atomic write — original file unchanged on failure
// ============================================================================

test("editor: atomic write preserves original on syntax failure", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "test.ts", VALID_TS);
    const editor = mkEditor(dir, new Set(["test.ts"]));
    editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent: "broken {" },
    });
    assert.equal(readHash(dir, "test.ts"), sha256(VALID_TS));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: atomic write preserves original on preimage mismatch", () => {
  const dir = mkTempDir("editor-test-");
  try {
    writeFile(dir, "test.ts", VALID_TS);
    const editor = mkEditor(dir, new Set(["test.ts"]));
    editor.applyEdit({
      path: "test.ts",
      preimageHash: "0".repeat(64),
      operation: { kind: "replaceFile", newContent: VALID_TS2 },
    });
    assert.equal(readHash(dir, "test.ts"), sha256(VALID_TS));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: no temp files left after successful write", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "test.ts", VALID_TS);
    const editor = mkEditor(dir, new Set(["test.ts"]));
    editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent: VALID_TS2 },
    });
    // Check no temp files exist in the directory
    const files = readdirSync(dir);
    const tempFiles = files.filter((f: string) => ownedTemporaryOwnerOf(f) !== undefined);
    assert.equal(tempFiles.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// Zero-delta proof — failed edit must prove zero effect
// ============================================================================

test("editor: zero-delta verified on syntax failure", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "test.ts", VALID_TS);
    const editor = mkEditor(dir, new Set(["test.ts"]));
    const result = editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent: "broken {" },
    });
    assert.equal(result.success, false);
    assert.equal(result.zeroDeltaVerified, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: zero-delta verified on preimage mismatch", () => {
  const dir = mkTempDir("editor-test-");
  try {
    writeFile(dir, "test.ts", VALID_TS);
    const editor = mkEditor(dir, new Set(["test.ts"]));
    const result = editor.applyEdit({
      path: "test.ts",
      preimageHash: "0".repeat(64),
      operation: { kind: "replaceFile", newContent: VALID_TS2 },
    });
    assert.equal(result.success, false);
    assert.equal(result.zeroDeltaVerified, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: zero-delta verified on write set denial", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "test.ts", VALID_TS);
    const editor = mkEditor(dir, new Set(["other.ts"]));
    const result = editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent: VALID_TS2 },
    });
    assert.equal(result.success, false);
    assert.equal(result.zeroDeltaVerified, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// All edit operations
// ============================================================================

test("editor: insertText operation succeeds", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const content = "export const x = 1;";
    const preimage = writeFile(dir, "test.ts", content);
    const editor = mkEditor(dir, new Set(["test.ts"]));
    const result = editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage,
      operation: { kind: "insertText", byteOffset: 19, text: " // end" },
    });
    assert.equal(result.success, true);
    assert.equal(readFileSync(join(dir, "test.ts"), "utf8"), "export const x = 1; // end");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: deleteRange operation succeeds", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "test.ts", "hello world");
    const editor = mkEditor(dir, new Set(["test.ts"]));
    const result = editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage,
      operation: { kind: "deleteRange", startByte: 5, endByte: 11 },
    });
    assert.equal(result.success, true);
    assert.equal(readFileSync(join(dir, "test.ts"), "utf8"), "hello");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: replaceRange operation succeeds", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "test.ts", "export const x = 1;");
    const editor = mkEditor(dir, new Set(["test.ts"]));
    const result = editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage,
      operation: { kind: "replaceRange", startByte: 13, endByte: 14, text: "y" },
    });
    assert.equal(result.success, true);
    assert.equal(readFileSync(join(dir, "test.ts"), "utf8"), "export const y = 1;");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: applyPatch operation succeeds", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const content = "line1\nline2\nline3";
    const preimage = writeFile(dir, "test.ts", content);
    const editor = mkEditor(dir, new Set(["test.ts"]));
    const patch = `@@ -1,3 +1,3 @@\n line1\n-line2\n+LINE2\n line3`;
    const result = editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage,
      operation: { kind: "applyPatch", patch },
    });
    assert.equal(result.success, true);
    assert.equal(readFileSync(join(dir, "test.ts"), "utf8"), "line1\nLINE2\nline3");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// Concurrency — two edits to same file
// ============================================================================

test("editor: second edit to same file fails (preimage changed)", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "test.ts", VALID_TS);
    const editor = mkEditor(dir, new Set(["test.ts"]));
    // First edit succeeds
    const result1 = editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent: VALID_TS2 },
    });
    assert.equal(result1.success, true);
    // Second edit with old preimage fails
    const result2 = editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent: "export const z = 1;" },
    });
    assert.equal(result2.success, false);
    assert.equal(result2.feedback!.errorType, "preimage_mismatch");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: sequential edits with refreshed preimage succeed", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage1 = writeFile(dir, "test.ts", VALID_TS);
    const editor = mkEditor(dir, new Set(["test.ts"]));
    const result1 = editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage1,
      operation: { kind: "replaceFile", newContent: VALID_TS2 },
    });
    assert.equal(result1.success, true);
    const preimage2 = sha256(VALID_TS2);
    const result2 = editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage2,
      operation: { kind: "replaceFile", newContent: "export const z = 1;" },
    });
    assert.equal(result2.success, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// Path validation — hostile inputs
// ============================================================================

test("editor: rejects absolute path", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const editor = mkEditor(dir, new Set(["test.ts"]));
    const result = editor.applyEdit({
      path: "/etc/passwd",
      preimageHash: "0".repeat(64),
      operation: { kind: "replaceFile", newContent: "x" },
    });
    assert.equal(result.success, false);
    assert.equal(result.feedback!.errorType, "path_invalid");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: rejects path traversal", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const editor = mkEditor(dir, new Set(["test.ts"]));
    const result = editor.applyEdit({
      path: "../../../etc/passwd",
      preimageHash: "0".repeat(64),
      operation: { kind: "replaceFile", newContent: "x" },
    });
    assert.equal(result.success, false);
    assert.equal(result.feedback!.errorType, "path_invalid");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: rejects backslash in path", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const editor = mkEditor(dir, new Set(["test.ts"]));
    const result = editor.applyEdit({
      path: "subdir\\test.ts",
      preimageHash: "0".repeat(64),
      operation: { kind: "replaceFile", newContent: "x" },
    });
    assert.equal(result.success, false);
    assert.equal(result.feedback!.errorType, "path_invalid");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: rejects control characters in path", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const editor = mkEditor(dir, new Set(["test.ts"]));
    const result = editor.applyEdit({
      path: "test\x00.ts",
      preimageHash: "0".repeat(64),
      operation: { kind: "replaceFile", newContent: "x" },
    });
    assert.equal(result.success, false);
    assert.equal(result.feedback!.errorType, "path_invalid");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: rejects empty path", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const editor = mkEditor(dir, new Set(["test.ts"]));
    const result = editor.applyEdit({
      path: "",
      preimageHash: "0".repeat(64),
      operation: { kind: "replaceFile", newContent: "x" },
    });
    assert.equal(result.success, false);
    assert.equal(result.feedback!.errorType, "path_invalid");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// Symlink rejection
// ============================================================================

test("editor: rejects symlink target", () => {
  const dir = mkTempDir("editor-test-");
  try {
    writeFile(dir, "real.ts", VALID_TS);
    symlinkSync(join(dir, "real.ts"), join(dir, "link.ts"));
    const editor = mkEditor(dir, new Set(["link.ts"]));
    const result = editor.applyEdit({
      path: "link.ts",
      preimageHash: sha256(VALID_TS),
      operation: { kind: "replaceFile", newContent: VALID_TS2 },
    });
    assert.equal(result.success, false);
    assert.ok(result.feedback!.errorType === "path_invalid" || result.feedback!.errorType === "preimage_missing");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// Timeline recording
// ============================================================================

test("editor: records attempt on success", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "test.ts", VALID_TS);
    const attempts: { path: string; operationKind: string; preimageHash: string }[] = [];
    const recorder: EditorEffectRecorder = {
      recordAttempt: (input) => attempts.push(input),
      recordSuccess: () => {},
      recordFailure: () => {},
      recordRollback: () => {},
    };
    const editor = mkEditor(dir, new Set(["test.ts"]), { recorder });
    editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent: VALID_TS2 },
    });
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.path, "test.ts");
    assert.equal(attempts[0]!.operationKind, "replaceFile");
    assert.equal(attempts[0]!.preimageHash, preimage);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: records success on success", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "test.ts", VALID_TS);
    const successes: { path: string; postimageHash: string }[] = [];
    const recorder: EditorEffectRecorder = {
      recordAttempt: () => {},
      recordSuccess: (input) => successes.push({ path: input.path, postimageHash: input.postimageHash }),
      recordFailure: () => {},
      recordRollback: () => {},
    };
    const editor = mkEditor(dir, new Set(["test.ts"]), { recorder });
    editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent: VALID_TS2 },
    });
    assert.equal(successes.length, 1);
    assert.equal(successes[0]!.postimageHash, sha256(VALID_TS2));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: onWriteSuccess hook fires after a successful edit (FIX 8)", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "test.ts", VALID_TS);
    const hookCalls: { path: string; operationKind: string }[] = [];
    const recorder: EditorEffectRecorder = {
      recordAttempt: () => {},
      recordSuccess: () => {},
      recordFailure: () => {},
      recordRollback: () => {},
      onWriteSuccess: (input) => hookCalls.push({ path: input.path, operationKind: input.operationKind }),
    };
    const editor = mkEditor(dir, new Set(["test.ts"]), { recorder });
    const result = editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent: VALID_TS2 },
    });
    assert.equal(result.success, true);
    assert.equal(hookCalls.length, 1, "onWriteSuccess must fire exactly once after a successful edit");
    assert.equal(hookCalls[0]!.path, "test.ts");
    assert.equal(hookCalls[0]!.operationKind, "replaceFile");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: onWriteSuccess hook does NOT fire on a failed edit (FIX 8)", () => {
  const dir = mkTempDir("editor-test-");
  try {
    writeFile(dir, "test.ts", VALID_TS);
    const hookCalls: { path: string; operationKind: string }[] = [];
    const recorder: EditorEffectRecorder = {
      recordAttempt: () => {},
      recordSuccess: () => {},
      recordFailure: () => {},
      recordRollback: () => {},
      onWriteSuccess: (input) => hookCalls.push({ path: input.path, operationKind: input.operationKind }),
    };
    const editor = mkEditor(dir, new Set(["test.ts"]), { recorder });
    const result = editor.applyEdit({
      path: "test.ts",
      preimageHash: "0".repeat(64), // wrong preimage -> failure
      operation: { kind: "replaceFile", newContent: VALID_TS2 },
    });
    assert.equal(result.success, false);
    assert.equal(hookCalls.length, 0, "onWriteSuccess must not fire on a failed edit");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: a throwing onWriteSuccess hook does not crash the editor (FIX 8)", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "test.ts", VALID_TS);
    const recorder: EditorEffectRecorder = {
      recordAttempt: () => {},
      recordSuccess: () => {},
      recordFailure: () => {},
      recordRollback: () => {},
      onWriteSuccess: () => { throw new Error("hook failure must not crash editor"); },
    };
    const editor = mkEditor(dir, new Set(["test.ts"]), { recorder });
    const result = editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent: VALID_TS2 },
    });
    assert.equal(result.success, true, "edit must still succeed when the post-write hook throws");
    assert.equal(readHash(dir, "test.ts"), sha256(VALID_TS2));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: records failure on preimage mismatch", () => {
  const dir = mkTempDir("editor-test-");
  try {
    writeFile(dir, "test.ts", VALID_TS);
    const failures: { path: string; feedback: { errorType: string } }[] = [];
    const recorder: EditorEffectRecorder = {
      recordAttempt: () => {},
      recordSuccess: () => {},
      recordFailure: (input) => failures.push({ path: input.path, feedback: input.feedback }),
      recordRollback: () => {},
    };
    const editor = mkEditor(dir, new Set(["test.ts"]), { recorder });
    editor.applyEdit({
      path: "test.ts",
      preimageHash: "0".repeat(64),
      operation: { kind: "replaceFile", newContent: VALID_TS2 },
    });
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.feedback.errorType, "preimage_mismatch");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: records failure on syntax error", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "test.ts", VALID_TS);
    const failures: { feedback: { errorType: string } }[] = [];
    const recorder: EditorEffectRecorder = {
      recordAttempt: () => {},
      recordSuccess: () => {},
      recordFailure: (input) => failures.push({ feedback: input.feedback }),
      recordRollback: () => {},
    };
    const editor = mkEditor(dir, new Set(["test.ts"]), { recorder });
    editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent: "broken {" },
    });
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.feedback.errorType, "syntax_error");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: records failure on write set denial", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "test.ts", VALID_TS);
    const failures: { feedback: { errorType: string } }[] = [];
    const recorder: EditorEffectRecorder = {
      recordAttempt: () => {},
      recordSuccess: () => {},
      recordFailure: (input) => failures.push({ feedback: input.feedback }),
      recordRollback: () => {},
    };
    const editor = mkEditor(dir, new Set(["other.ts"]), { recorder });
    editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent: VALID_TS2 },
    });
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.feedback.errorType, "write_set_denied");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: recorder failure does not crash editor", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "test.ts", VALID_TS);
    const recorder: EditorEffectRecorder = {
      recordAttempt: () => { throw new Error("recorder broken"); },
      recordSuccess: () => { throw new Error("recorder broken"); },
      recordFailure: () => { throw new Error("recorder broken"); },
      recordRollback: () => { throw new Error("recorder broken"); },
    };
    const editor = mkEditor(dir, new Set(["test.ts"]), { recorder });
    const result = editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent: VALID_TS2 },
    });
    assert.equal(result.success, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// Rollback scenarios
// ============================================================================

test("editor: rolledBack is false on success", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "test.ts", VALID_TS);
    const editor = mkEditor(dir, new Set(["test.ts"]));
    const result = editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent: VALID_TS2 },
    });
    assert.equal(result.rolledBack, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: rolledBack is false on pre-failure (before write)", () => {
  const dir = mkTempDir("editor-test-");
  try {
    writeFile(dir, "test.ts", VALID_TS);
    const editor = mkEditor(dir, new Set(["test.ts"]));
    const result = editor.applyEdit({
      path: "test.ts",
      preimageHash: "0".repeat(64),
      operation: { kind: "replaceFile", newContent: VALID_TS2 },
    });
    assert.equal(result.rolledBack, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// Operation invalid
// ============================================================================

test("editor: invalid offset in insertText fails with operation_invalid", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "test.ts", VALID_TS);
    const editor = mkEditor(dir, new Set(["test.ts"]));
    const result = editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage,
      operation: { kind: "insertText", byteOffset: -1, text: "x" },
    });
    assert.equal(result.success, false);
    assert.equal(result.feedback!.errorType, "operation_invalid");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: inverted range in deleteRange fails with operation_invalid", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "test.ts", VALID_TS);
    const editor = mkEditor(dir, new Set(["test.ts"]));
    const result = editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage,
      operation: { kind: "deleteRange", startByte: 10, endByte: 5 },
    });
    assert.equal(result.success, false);
    assert.equal(result.feedback!.errorType, "operation_invalid");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: invalid patch fails with operation_invalid", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "test.ts", "line1\nline2");
    const editor = mkEditor(dir, new Set(["test.ts"]));
    const result = editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage,
      operation: { kind: "applyPatch", patch: "not a valid patch" },
    });
    assert.equal(result.success, false);
    assert.equal(result.feedback!.errorType, "operation_invalid");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// Multiple files in write set
// ============================================================================

test("editor: can edit multiple files in write set", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const pre1 = writeFile(dir, "a.ts", "export const a = 1;");
    const pre2 = writeFile(dir, "b.ts", "export const b = 2;");
    const editor = mkEditor(dir, new Set(["a.ts", "b.ts"]));
    const r1 = editor.applyEdit({ path: "a.ts", preimageHash: pre1, operation: { kind: "replaceFile", newContent: "export const a = 10;" } });
    const r2 = editor.applyEdit({ path: "b.ts", preimageHash: pre2, operation: { kind: "replaceFile", newContent: "export const b = 20;" } });
    assert.equal(r1.success, true);
    assert.equal(r2.success, true);
    assert.equal(readFileSync(join(dir, "a.ts"), "utf8"), "export const a = 10;");
    assert.equal(readFileSync(join(dir, "b.ts"), "utf8"), "export const b = 20;");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: nested path in write set works", () => {
  const dir = mkTempDir("editor-test-");
  try {
    mkdirSync(join(dir, "src", "sub"), { recursive: true });
    writeFileSync(join(dir, "src", "sub", "test.ts"), VALID_TS);
    const preimage = sha256(VALID_TS);
    const editor = mkEditor(dir, new Set(["src/sub/test.ts"]));
    const result = editor.applyEdit({
      path: "src/sub/test.ts",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent: VALID_TS2 },
    });
    assert.equal(result.success, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// JSON file edits
// ============================================================================

test("editor: JSON file edit with valid content succeeds", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "data.json", '{"a": 1}');
    const editor = mkEditor(dir, new Set(["data.json"]));
    const result = editor.applyEdit({
      path: "data.json",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent: '{"a": 2, "b": 3}' },
    });
    assert.equal(result.success, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: JSON file edit with invalid content fails", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "data.json", '{"a": 1}');
    const editor = mkEditor(dir, new Set(["data.json"]));
    const result = editor.applyEdit({
      path: "data.json",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent: '{"a":}' },
    });
    assert.equal(result.success, false);
    assert.equal(result.feedback!.errorType, "syntax_error");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// Idempotency — re-reading gives stable results
// ============================================================================

test("editor: reading file after edit gives stable hash", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "test.ts", VALID_TS);
    const editor = mkEditor(dir, new Set(["test.ts"]));
    editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent: VALID_TS2 },
    });
    const h1 = readHash(dir, "test.ts");
    const h2 = readHash(dir, "test.ts");
    assert.equal(h1, h2);
    assert.equal(h1, sha256(VALID_TS2));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: no-op edit (same content) succeeds with correct preimage", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "test.ts", VALID_TS);
    const editor = mkEditor(dir, new Set(["test.ts"]));
    const result = editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent: VALID_TS },
    });
    assert.equal(result.success, true);
    assert.equal(result.postimageHash, preimage);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// Large file handling
// ============================================================================

test("editor: handles moderately large file", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const large = "export const data = " + JSON.stringify(Array.from({ length: 100 }, (_, i) => i)).replace(/"/g, "'") + ";";
    const preimage = writeFile(dir, "test.ts", large);
    const editor = mkEditor(dir, new Set(["test.ts"]));
    const newContent = "export const data = [];";
    const result = editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent },
    });
    assert.equal(result.success, true);
    assert.equal(readHash(dir, "test.ts"), sha256(newContent));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// Operations on different file types
// ============================================================================

test("editor: insertText on JS file", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "test.js", "const x = 1;");
    const editor = mkEditor(dir, new Set(["test.js"]));
    const result = editor.applyEdit({
      path: "test.js",
      preimageHash: preimage,
      operation: { kind: "insertText", byteOffset: 0, text: "// header\n" },
    });
    assert.equal(result.success, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: replaceRange on JSON file", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "data.json", '{"a": 1, "b": 2}');
    const editor = mkEditor(dir, new Set(["data.json"]));
    const result = editor.applyEdit({
      path: "data.json",
      preimageHash: preimage,
      operation: { kind: "replaceRange", startByte: 6, endByte: 7, text: "10" },
    });
    assert.equal(result.success, true);
    assert.equal(readFileSync(join(dir, "data.json"), "utf8"), '{"a": 10, "b": 2}');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// Error feedback structure
// ============================================================================

test("editor: feedback includes path for all error types", () => {
  const dir = mkTempDir("editor-test-");
  try {
    writeFile(dir, "test.ts", VALID_TS);
    const editor = mkEditor(dir, new Set(["test.ts"]));
    const result = editor.applyEdit({
      path: "test.ts",
      preimageHash: "0".repeat(64),
      operation: { kind: "replaceFile", newContent: VALID_TS2 },
    });
    assert.equal(result.feedback!.path, "test.ts");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: feedback message is non-empty", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "test.ts", VALID_TS);
    const editor = mkEditor(dir, new Set(["test.ts"]));
    const result = editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent: "broken {" },
    });
    assert.ok(result.feedback!.message.length > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ============================================================================
// P0-3: failed rollback must be reported, not silently ignored
// ============================================================================

test("editor: failed rollback is reported as rollbackFailed (P0-3)", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "test.ts", VALID_TS);
    let callCount = 0;
    const atomicWriter: AtomicWriter = (path, content) => {
      callCount++;
      if (callCount === 1) {
        // Edit write: succeed but write CORRUPTED bytes to disk so the
        // post-write re-read mismatches the expected postimage hash.
        atomicWriteFile(path, content + "\nCORRUPTED");
        return { success: true };
      }
      // Rollback write: fail to restore the preimage.
      return { success: false, reason: "simulated rollback failure" };
    };
    const editor = mkEditor(dir, new Set(["test.ts"]), { atomicWriter });
    const result = editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent: VALID_TS2 },
    });
    assert.equal(result.success, false);
    assert.equal(result.rolledBack, false, "rolledBack must be false when rollback FAILED (previously silently true)");
    assert.equal(result.rollbackFailed, true, "rollbackFailed must be true when rollback failed");
    assert.ok(result.feedback !== null);
    assert.equal(result.feedback!.errorType, "rollback_failed");
    assert.ok(result.feedback!.message.toLowerCase().includes("corrupt"), `feedback should mention corrupt state: ${result.feedback!.message}`);
    assert.equal(result.feedback!.retryable, false);
    assert.equal(callCount, 2, "expected edit write + rollback write = 2 writer calls");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: successful rollback after postwrite mismatch reports rolledBack true (P0-3 contrast)", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "test.ts", VALID_TS);
    let callCount = 0;
    const atomicWriter: AtomicWriter = (path, content) => {
      callCount++;
      if (callCount === 1) {
        atomicWriteFile(path, content + "\nCORRUPTED");
        return { success: true };
      }
      // Rollback write: succeed (real atomic write of the preimage).
      return atomicWriteFile(path, content);
    };
    const editor = mkEditor(dir, new Set(["test.ts"]), { atomicWriter });
    const result = editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent: VALID_TS2 },
    });
    assert.equal(result.success, false);
    assert.equal(result.rolledBack, true, "rolledBack must be true when rollback SUCCEEDED");
    assert.equal(result.rollbackFailed, false);
    assert.equal(result.feedback!.errorType, "postwrite_mismatch");
    assert.equal(readHash(dir, "test.ts"), sha256(VALID_TS), "file restored to preimage after successful rollback");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: successful edit has rollbackFailed false (P0-3)", () => {
  const dir = mkTempDir("editor-test-");
  try {
    const preimage = writeFile(dir, "test.ts", VALID_TS);
    const editor = mkEditor(dir, new Set(["test.ts"]));
    const result = editor.applyEdit({
      path: "test.ts",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent: VALID_TS2 },
    });
    assert.equal(result.success, true);
    assert.equal(result.rolledBack, false);
    assert.equal(result.rollbackFailed, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
