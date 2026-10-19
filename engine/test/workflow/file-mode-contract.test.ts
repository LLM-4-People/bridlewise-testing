import assert from "node:assert/strict";
import test from "node:test";

import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { LOCK_FILE_MODE, LOCK_DIR_MODE } from "../../src/workflow/resource-lock.ts";
import { createTempDir } from "../support/temp-dir.ts";

/**
 * FIX 8 (MAJOR) contract test: the file/directory modes hardcoded in
 * atomic-write.ts and resource-lock.ts must match the single source of
 * truth in ROOT_POLICY.filesystemInfrastructure.privateState. This
 * catches drift if either file re-introduces a hardcoded 0o600/0o700
 * instead of consuming the root policy.
 *
 * resource-lock.ts exports LOCK_FILE_MODE and LOCK_DIR_MODE which now
 * derive from ROOT_POLICY. atomic-write.ts consumes the file mode
 * directly (not exported), so the atomic-write file-mode contract is
 * verified by the atomic-write tests (which check the temp file mode
 * is 0o600).
 */

test("FIX 8 contract: LOCK_FILE_MODE matches ROOT_POLICY privateState.fileMode", () => {
  assert.equal(
    LOCK_FILE_MODE,
    ROOT_POLICY.filesystemInfrastructure.privateState.fileMode,
    "LOCK_FILE_MODE must equal ROOT_POLICY.filesystemInfrastructure.privateState.fileMode",
  );
});

test("FIX 8 contract: LOCK_DIR_MODE matches ROOT_POLICY privateState.directoryMode", () => {
  assert.equal(
    LOCK_DIR_MODE,
    ROOT_POLICY.filesystemInfrastructure.privateState.directoryMode,
    "LOCK_DIR_MODE must equal ROOT_POLICY.filesystemInfrastructure.privateState.directoryMode",
  );
});

test("FIX 8 contract: ROOT_POLICY privateState fileMode is 0o600", () => {
  assert.equal(ROOT_POLICY.filesystemInfrastructure.privateState.fileMode, 0o600);
});

test("FIX 8 contract: ROOT_POLICY privateState directoryMode is 0o700", () => {
  assert.equal(ROOT_POLICY.filesystemInfrastructure.privateState.directoryMode, 0o700);
});

/**
 * Verify atomic-write.ts uses the root-policy file mode. This catches a
 * re-introduction of a hardcoded 0o600 that doesn't match ROOT_POLICY (if
 * ROOT_POLICY is ever changed to a different mode, atomic-write must follow).
 *
 * ── THIS TEST USED TO PIN THE DEFECT IT WAS NAMED AFTER ───────────────────
 *
 * Its name says "creates TEMP FILES with ROOT_POLICY fileMode" — a real
 * property, and the right one: the file being written must not be readable by
 * anyone else while it is being written. But it measured the TARGET after the
 * rename, over a PRE-CREATED file, and asserted that the target came out
 * private. That is not the temp file's mode; it is the consequence of the
 * rename replacing the inode, which is a DEFECT — every atomic write silently
 * re-permissioned whatever it overwrote, and this test required it to.
 * Fifty-two tracked files were sitting at 0600 against 100644 in the index
 * while this was green.
 *
 * A correct region attached to the wrong object. The two properties are now
 * measured separately, on the fixtures where each one is actually visible:
 * the private mode is observed where NO target exists (so what survives the
 * rename IS the temp file's mode), and preservation is observed where one
 * does.
 */
test("FIX 8 contract: atomicWriteFile creates its temp file with ROOT_POLICY fileMode", async () => {
  const { statSync, rmSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { atomicWriteFile } = await import("../../src/filesystem/atomic-write.ts");
  const dir = createTempDir("fix8-mode-");
  try {
    // NO pre-existing target: nothing to preserve, so the mode that survives
    // the rename is exactly the mode the temp file was opened with.
    const target = join(dir, "brand-new.txt");
    assert.equal(existsSync(target), false, "the fixture must not already exist");
    const result = atomicWriteFile(target, "new content");
    assert.ok(result.success, "atomicWriteFile must succeed");
    const expectedMode = ROOT_POLICY.filesystemInfrastructure.privateState.fileMode & 0o777;
    const actualMode = statSync(target).mode & 0o777;
    assert.equal(
      actualMode,
      expectedMode,
      `atomicWriteFile temp file mode ${actualMode.toString(8)} must match ROOT_POLICY fileMode ${expectedMode.toString(8)}`,
    );
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

test("FIX 8 contract: atomicWriteFile does not re-permission a file it overwrites", async () => {
  const { statSync, rmSync, writeFileSync, chmodSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { atomicWriteFile } = await import("../../src/filesystem/atomic-write.ts");
  const dir = createTempDir("fix8-preserve-");
  try {
    const target = join(dir, "target.txt");
    writeFileSync(target, "old");
    // A mode that is NOT the private one, so "preserved" and "reset to the
    // policy default" cannot produce the same answer.
    chmodSync(target, 0o664);
    assert.equal(statSync(target).mode & 0o777, 0o664, "the fixture never took the mode");
    assert.notEqual(
      0o664,
      ROOT_POLICY.filesystemInfrastructure.privateState.fileMode & 0o777,
      "the fixture mode must differ from the policy mode or this test cannot tell them apart",
    );

    assert.ok(atomicWriteFile(target, "new content").success);
    const after = statSync(target).mode & 0o777;
    assert.equal(
      after,
      0o664,
      `overwriting the file changed its permissions from 664 to ${after.toString(8)} — a rename replaces the inode, so the mode must be carried across`,
    );
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
