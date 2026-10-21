import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createTempDir } from "../../../support/temp-dir.ts";

import {
  verifyGuardianBinaryAvailability,
} from "../../../../src/filesystem/self-protection/guardian-binary.ts";
import { copyGuardianSealedInputs } from "../../../support/guardian-build-stamp.ts";
import { requireLinuxHost } from "../../../support/host-requirement.ts";

/**
 * Binary-tampering hostile tests. The guardian is admitted by its REPRODUCIBLE
 * BUILD STAMP — a digest of its sealed sources and declared flags, recomputed
 * by the runtime and pinned in `ROOT_POLICY.selfProtection.binaryStamp` — not
 * by the digest of the compiler-built file. A binary that reports no stamp, a
 * malformed stamp, or a stamp that disagrees with the sealed source tree and
 * the pin MUST be refused with `binary_hash_mismatch`, never silently used.
 *
 * The fake harness roots carry the real sealed inputs beside the planted
 * binary, so each arm measures the binary's answer rather than a missing
 * source tree.
 */

const modulePath = fileURLToPath(import.meta.url);
// test/filesystem/self-protection/hostile/ -> five hops to the engine root.
const candidateRoot = dirname(dirname(dirname(dirname(dirname(modulePath)))));

function fakeHarnessWith(prefix: string, body: string): string {
  const fakeRoot = createTempDir(prefix);
  copyGuardianSealedInputs(candidateRoot, fakeRoot);
  mkdirSync(join(fakeRoot, "guardian", "build"), { recursive: true });
  writeFileSync(join(fakeRoot, "guardian", "build", "harness-landlock-guardian"), body, { mode: 0o755 });
  return fakeRoot;
}

test("hostile binary-tampering: a stub binary with no --stamp mode → binary_hash_mismatch (fail closed)", () => {
  requireLinuxHost();
  const fakeRoot = fakeHarnessWith("harness-guardian-tamper-absent-", "#!/bin/sh\nexit 0\n");
  try {
    const availability = verifyGuardianBinaryAvailability(fakeRoot);
    assert.equal(availability.available, false, "a binary with no stamp must not be admitted");
    assert.equal(availability.code, "binary_hash_mismatch");
    assert.equal(availability.fallbackAttempted, false, "must never silently fall back");
  } finally {
    rmSync(fakeRoot, { recursive: true, force: true });
  }
});

test("hostile binary-tampering: a malformed stamp → binary_hash_mismatch (not a parse guess)", () => {
  requireLinuxHost();
  const fakeRoot = fakeHarnessWith("harness-guardian-tamper-malformed-", "#!/bin/sh\necho tampered\n");
  try {
    const availability = verifyGuardianBinaryAvailability(fakeRoot);
    assert.equal(availability.available, false);
    assert.equal(availability.code, "binary_hash_mismatch");
  } finally {
    rmSync(fakeRoot, { recursive: true, force: true });
  }
});

test("hostile binary-tampering: a well-formed but different stamp → binary_hash_mismatch", () => {
  requireLinuxHost();
  const fakeRoot = fakeHarnessWith(
    "harness-guardian-tamper-disagree-",
    `#!/bin/sh\necho ${"0".repeat(64)}\n`,
  );
  try {
    const availability = verifyGuardianBinaryAvailability(fakeRoot);
    assert.equal(availability.available, false);
    assert.equal(availability.code, "binary_hash_mismatch");
  } finally {
    rmSync(fakeRoot, { recursive: true, force: true });
  }
});

test("hostile binary-tampering: an empty binary file → binary_hash_mismatch (not binary_missing)", () => {
  requireLinuxHost();
  const fakeRoot = fakeHarnessWith("harness-guardian-empty-", "");
  try {
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
