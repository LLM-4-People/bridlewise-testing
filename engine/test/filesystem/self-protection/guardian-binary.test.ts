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
import { computeGuardianBuildStamp } from "../../../src/filesystem/self-protection/guardian-build-stamp.ts";
import { copyGuardianSealedInputs } from "../../support/guardian-build-stamp.ts";
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

test("guardian-binary: verifyGuardianBinaryAvailability admits the binary whose build stamp matches the sealed sources on this Linux host", () => {
  requireLinuxHost();
  const availability = verifyGuardianBinaryAvailability(candidateRoot);
  assert.equal(availability.available, true, `expected available, got: ${JSON.stringify(availability)}`);
  if (availability.available) {
    // The trust anchor: the binary's reported stamp, the source tree's
    // recomputation and the committed pin are one value. The file sha256 is
    // carried for diagnostics only, and is deliberately not equal to a pin.
    assert.equal(availability.stamp, computeGuardianBuildStamp(candidateRoot));
    assert.equal(availability.stamp, ROOT_POLICY.selfProtection.binaryStamp);
    assert.match(availability.sha256, /^[0-9a-f]{64}$/u);
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

test("guardian-binary: verifyGuardianBinaryAvailability reports binary_hash_mismatch when the binary reports no stamp", () => {
  requireLinuxHost();
  // To exercise the refusal WITHOUT mutating the frozen binary, point at a
  // harness root whose guardian binary is a stub with no `--stamp` mode. The
  // source tree is copied too, so the refusal is about the binary's answer,
  // not about missing sealed inputs.
  const fakeRoot = createTempDir("harness-guardian-mismatch-");
  try {
    copyGuardianSealedInputs(candidateRoot, fakeRoot);
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
