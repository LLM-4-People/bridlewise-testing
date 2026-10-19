import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createTempDir } from "../../../support/temp-dir.ts";

import {
  verifyGuardianBinaryAvailability,
} from "../../../../src/filesystem/self-protection/guardian-binary.ts";
import { requireLinuxHost } from "../../../support/host-requirement.ts";

/**
 * Binary-tampering hostile tests. The guardian binary's sha256 is pinned in
 * `ROOT_POLICY.selfProtection.binarySha256` (the hash-binding target). If the
 * binary is replaced/tampered, `verifyGuardianBinaryAvailability` MUST report
 * `binary_hash_mismatch` and `applySelfProtection` MUST refuse to run (the
 * bootstrap's `assertSelfProtectionAvailable` throws). Never silently fall
 * back to the tampered binary.
 */

test("hostile binary-tampering: a stub binary with the wrong sha256 → binary_hash_mismatch (fail closed)", () => {
  requireLinuxHost();
  const fakeRoot = createTempDir("harness-guardian-tamper-");
  try {
    mkdirSync(join(fakeRoot, "guardian", "build"), { recursive: true });
    // Write a stub binary whose sha256 will NOT match the pin.
    writeFileSync(
      join(fakeRoot, "guardian", "build", "harness-landlock-guardian"),
      "#!/bin/sh\necho tampered\n",
      { mode: 0o755 },
    );
    const availability = verifyGuardianBinaryAvailability(fakeRoot);
    assert.equal(availability.available, false, "tampered binary must not be admitted");
    assert.equal(availability.code, "binary_hash_mismatch");
    assert.equal(availability.fallbackAttempted, false, "must never silently fall back");
  } finally {
    rmSync(fakeRoot, { recursive: true, force: true });
  }
});

test("hostile binary-tampering: an empty binary file → binary_hash_mismatch (not binary_missing)", () => {
  requireLinuxHost();
  const fakeRoot = createTempDir("harness-guardian-empty-");
  try {
    mkdirSync(join(fakeRoot, "guardian", "build"), { recursive: true });
    writeFileSync(join(fakeRoot, "guardian", "build", "harness-landlock-guardian"), "", { mode: 0o755 });
    const availability = verifyGuardianBinaryAvailability(fakeRoot);
    assert.equal(availability.available, false);
    assert.equal(availability.code, "binary_hash_mismatch");
  } finally {
    rmSync(fakeRoot, { recursive: true, force: true });
  }
});

test("hostile binary-tampering: missing binary → binary_missing (fail closed)", () => {
  const availability = verifyGuardianBinaryAvailability("/nonexistent-harness-root-xyz");
  assert.equal(availability.available, false);
  assert.equal(availability.code, "binary_missing");
  assert.equal(availability.fallbackAttempted, false);
});
