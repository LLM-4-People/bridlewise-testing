import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ROOT_POLICY } from "../../../src/kernel/root-policy.ts";
import {
  resolveGuardianBinaryPath,
  verifyGuardianBinaryAvailability,
} from "../../../src/filesystem/self-protection/guardian-binary.ts";
import { createTempDir } from "../../support/temp-dir.ts";
import { requireLinuxHost } from "../../support/host-requirement.ts";

// The candidate fork IS a harness root (the binary sits at
// `<root>/guardian/build/harness-landlock-guardian`). Resolve it the same way
// the runtime does: from this test file's module URL up two levels.
const modulePath = fileURLToPath(import.meta.url);
const candidateRoot = dirname(dirname(dirname(dirname(modulePath))));

function expectedBinaryPath(): string {
  return join(candidateRoot, ROOT_POLICY.selfProtection.binaryRelativePath);
}

test("guardian-binary: resolveGuardianBinaryPath finds the binary at the floor relative path", () => {
  const resolved = resolveGuardianBinaryPath(candidateRoot);
  assert.equal(resolved, expectedBinaryPath());
});

test("guardian-binary: resolveGuardianBinaryPath returns undefined for a missing binary", () => {
  const resolved = resolveGuardianBinaryPath("/nonexistent-harness-root");
  assert.equal(resolved, undefined);
});

test("guardian-binary: resolveGuardianBinaryPath rejects a relative root", () => {
  const resolved = resolveGuardianBinaryPath("relative/root");
  assert.equal(resolved, undefined);
});

test("guardian-binary: verifyGuardianBinaryAvailability returns available:true with the frozen sha256 on this Linux host", () => {
  requireLinuxHost();
  const availability = verifyGuardianBinaryAvailability(candidateRoot);
  assert.equal(availability.available, true, `expected available, got: ${JSON.stringify(availability)}`);
  if (availability.available) {
    assert.equal(availability.sha256, ROOT_POLICY.selfProtection.binarySha256);
    assert.equal(availability.binaryPath, expectedBinaryPath());
    assert.ok(availability.kernelAbi >= 1, `kernelAbi should be >= 1, got ${availability.kernelAbi}`);
  }
});

test("guardian-binary: verifyGuardianBinaryAvailability reports binary_missing when the binary is absent", () => {
  const availability = verifyGuardianBinaryAvailability("/nonexistent-harness-root-xyz");
  assert.equal(availability.available, false);
  assert.equal(availability.code, "binary_missing");
  assert.equal(availability.fallbackAttempted, false);
});

test("guardian-binary: verifyGuardianBinaryAvailability reports binary_hash_mismatch when the sha256 pin is wrong", () => {
  requireLinuxHost();
  // The real binary's sha256 matches the pin (verified above). To exercise the
  // mismatch path WITHOUT mutating the frozen binary, point at a harness root
  // whose guardian binary is a different file with a different hash. Build a
  // fake harness root layout with a stub binary at the relative path.
  const fakeRoot = createTempDir("harness-guardian-mismatch-");
  try {
    mkdirSync(join(fakeRoot, "guardian", "build"), { recursive: true });
    writeFileSync(join(fakeRoot, "guardian", "build", "harness-landlock-guardian"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const availability = verifyGuardianBinaryAvailability(fakeRoot);
    assert.equal(availability.available, false);
    assert.equal(availability.code, "binary_hash_mismatch");
    assert.equal(availability.fallbackAttempted, false);
  } finally {
    rmSync(fakeRoot, { recursive: true, force: true });
  }
});
