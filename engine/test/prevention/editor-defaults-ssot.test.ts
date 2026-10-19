import assert from "node:assert/strict";
import test from "node:test";

import { EDITOR_DEFAULT_LIMITS } from "../../src/kernel/config-contracts.ts";
import { resolveEditorLimits, MAX_PATH_BYTES } from "../../src/editor/edit-operations.ts";

/**
 * Regression test for the editor-defaults single-source-of-truth fix
 * (EXP468, Round 34, 12-point-loop-audit, Layer 5 + Layer 1).
 *
 * The user's binding directive: "static values like that are prohibited
 * app-wide" and: "All configurable values are declared once
 * through the central configuration contract." Previously the editor
 * operational defaults (64 MiB file / 4 MiB patch / 4 MiB insert) were
 * hardcoded magic numbers in `src/editor/edit-operations.ts`. They now
 * live once in `EDITOR_DEFAULT_LIMITS` (`src/config-contracts.ts`, the
 * central config contract) and are re-exported by the editor so existing
 * imports keep working without drift.
 *
 * This test pins:
 * 1. The canonical owner (`EDITOR_DEFAULT_LIMITS`) exists in the config
 * layer and has the expected operational-default values.
 * 2. The editor's `MAX_FILE_BYTES` re-export mirrors the canonical owner
 * (no drift — the two cannot diverge silently).
 * 3. The operational defaults are STRICTER than the protocol upper bounds
 * in `ROOT_POLICY.editor.limits` (the floor is 1 GiB; the default is
 * 64 MiB — a deliberate safety margin, not a duplicate).
 */

test("editor-defaults-ssot: EDITOR_DEFAULT_LIMITS is the canonical owner in the config layer", () => {
  assert.ok(EDITOR_DEFAULT_LIMITS, "EDITOR_DEFAULT_LIMITS must be exported from config-contracts.ts");
  assert.equal(typeof EDITOR_DEFAULT_LIMITS.maxFileBytes, "number");
  assert.equal(typeof EDITOR_DEFAULT_LIMITS.maxPatchBytes, "number");
  assert.equal(typeof EDITOR_DEFAULT_LIMITS.maxInsertTextBytes, "number");
  assert.equal(typeof EDITOR_DEFAULT_LIMITS.maxPathBytes, "number");
  assert.equal(EDITOR_DEFAULT_LIMITS.maxFileBytes, 64 * 1024 * 1024, "64 MiB operational default");
  assert.equal(EDITOR_DEFAULT_LIMITS.maxPatchBytes, 4 * 1024 * 1024, "4 MiB operational default");
  assert.equal(EDITOR_DEFAULT_LIMITS.maxInsertTextBytes, 4 * 1024 * 1024, "4 MiB operational default");
  assert.equal(EDITOR_DEFAULT_LIMITS.maxPathBytes, 4096, "4096-byte path limit mirrors root-policy maximumPathBytes");
});

test("editor-defaults-ssot: MAX_FILE_BYTES + MAX_PATH_BYTES mirror the canonical owner (no drift)", () => {
  assert.equal(resolveEditorLimits().maxFileBytes, EDITOR_DEFAULT_LIMITS.maxFileBytes, "the resolved editor file-byte limit must equal the config-layer default");
  assert.equal(MAX_PATH_BYTES, EDITOR_DEFAULT_LIMITS.maxPathBytes, "edit-operations.MAX_PATH_BYTES must equal the config-layer default (R49-V8)");
});

test("editor-defaults-ssot: operational defaults are stricter than the ROOT_POLICY protocol floor", async () => {
  const { ROOT_POLICY } = await import("../../src/kernel/root-policy.ts");
  const protocolFloor = ROOT_POLICY.editor.limits.maxFileBytes;
  assert.ok(
    EDITOR_DEFAULT_LIMITS.maxFileBytes < protocolFloor,
    `operational default (${EDITOR_DEFAULT_LIMITS.maxFileBytes}) must be stricter than the protocol floor (${protocolFloor})`,
  );
  assert.ok(
    EDITOR_DEFAULT_LIMITS.maxPatchBytes <= ROOT_POLICY.editor.limits.maxPatchBytes,
    "patch default must not exceed the protocol patch floor",
  );
  assert.ok(
    EDITOR_DEFAULT_LIMITS.maxInsertTextBytes <= ROOT_POLICY.editor.limits.maxInsertTextBytes,
    "insert default must not exceed the protocol insert floor",
  );
});

test("editor-defaults-ssot: EDITOR_DEFAULT_LIMITS is frozen (immutable)", () => {
  assert.ok(Object.isFrozen(EDITOR_DEFAULT_LIMITS), "EDITOR_DEFAULT_LIMITS must be deepFrozen");
});

test("editor-defaults-ssot: edit-operations fallback uses the canonical default when no limits provided", async () => {
  const { computeReplaceFile } = await import("../../src/editor/edit-operations.ts");
  const oversized = "x".repeat(EDITOR_DEFAULT_LIMITS.maxFileBytes + 1);
  assert.throws(
    () => computeReplaceFile("", { kind: "replaceFile", newContent: oversized }),
    (err: unknown) => err instanceof Error && /maximum file size/i.test(err.message),
    "replaceFile must reject content exceeding the canonical default when no limits override is provided",
  );
  const within = "y".repeat(EDITOR_DEFAULT_LIMITS.maxFileBytes);
  const result = computeReplaceFile("", { kind: "replaceFile", newContent: within });
  assert.equal(typeof result.expectedPostimageHash, "string");
});
