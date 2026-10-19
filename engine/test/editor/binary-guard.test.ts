// Regression test for EXP444: binary-file corruption via readPreimage.
// Root cause: readPreimage read every file as UTF-8 (readFileSync(path,"utf8")).
// A binary file (PNG/ELF) was decoded → text → edited → re-encoded, SILENTLY
// corrupting the binary. The guard existed only in applyAtomicEdit (exp444),
// NOT in the canonical transactional-editor's readPreimage.
// Fix: content-based looksBinary guard in the shared read path.
// This test would FAIL pre-fix (binary file read as UTF-8 → hash mismatch or
// silent corruption) and PASSES post-fix (binary detected → typed failure).
import assert from "node:assert/strict";
import { rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { sha256 } from "../../src/kernel/integrity.ts";
import {
  createTransactionalEditor,
  type TransactionalEditor,
} from "../../src/editor/transactional-editor.ts";
import { mkTempDir } from "../support/temp-dir.ts";

function mkEditor(dir: string, writeSet: ReadonlySet<string>): TransactionalEditor {
  return createTransactionalEditor({ repositoryRoot: dir, writeSet, skipSyntaxValidation: true });
}

// Minimal PNG header + null bytes (a real binary file).
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0xff, 0xfe, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06,
]);

test("editor: binary file is rejected by readPreimage (EXP444 root-cause fix)", () => {
  const dir = mkTempDir("editor-bin-");
  try {
    const binPath = join(dir, "image.png");
    writeFileSync(binPath, PNG_BYTES);
    const editor = mkEditor(dir, new Set(["image.png"]));
    const result = editor.applyEdit({
      path: "image.png",
      preimageHash: sha256(PNG_BYTES),
      operation: { kind: "replaceFile", newContent: "not binary" },
    });
    // The edit must be REJECTED — binary files cannot be text-edited.
    assert.equal(result.success, false, "binary file edit must be rejected");
    assert.ok(result.feedback, "feedback must be present");
    const fb = result.feedback as { kind?: string; message?: string; [k: string]: unknown };
    const text = JSON.stringify(fb);
    assert.ok(text.includes("binary"), `feedback must mention binary: ${text}`);
    // CRITICAL: the file must NOT be corrupted by the UTF-8 round-trip.
    const after = readFileSync(binPath);
    assert.ok(Buffer.compare(after, PNG_BYTES) === 0,
      `binary file must be unchanged (pre=${PNG_BYTES.toString("hex")} post=${after.toString("hex")})`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: text file with normal content is NOT flagged as binary", () => {
  const dir = mkTempDir("editor-text-");
  try {
    const txt = "export const x = 42;\n// hello world\n";
    const txtPath = join(dir, "code.ts");
    writeFileSync(txtPath, txt);
    const preimage = sha256(txt);
    const editor = mkEditor(dir, new Set(["code.ts"]));
    const result = editor.applyEdit({
      path: "code.ts",
      preimageHash: preimage,
      operation: { kind: "replaceFile", newContent: "export const y = 99;\n" },
    });
    assert.equal(result.success, true, "text file edit must succeed (not flagged binary)");
    assert.equal(readFileSync(join(dir, "code.ts"), "utf8"), "export const y = 99;\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: ELF binary (null bytes) is rejected", () => {
  const dir = mkTempDir("editor-elf-");
  try {
    const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const elfPath = join(dir, "binary.elf");
    writeFileSync(elfPath, elf);
    const editor = mkEditor(dir, new Set(["binary.elf"]));
    const result = editor.applyEdit({
      path: "binary.elf",
      preimageHash: sha256(elf),
      operation: { kind: "replaceFile", newContent: "text" },
    });
    assert.equal(result.success, false, "ELF binary must be rejected");
    const after = readFileSync(elfPath);
    assert.ok(Buffer.compare(after, elf) === 0, "ELF must be unchanged");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("editor: empty file is NOT flagged as binary", () => {
  const dir = mkTempDir("editor-empty-");
  try {
    const emptyPath = join(dir, "empty.txt");
    writeFileSync(emptyPath, "");
    const editor = mkEditor(dir, new Set(["empty.txt"]));
    const result = editor.applyEdit({
      path: "empty.txt",
      preimageHash: sha256(""),
      operation: { kind: "replaceFile", newContent: "content" },
    });
    assert.equal(result.success, true, "empty file must not be flagged binary");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
