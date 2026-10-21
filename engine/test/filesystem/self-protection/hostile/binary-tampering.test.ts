import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createTempDir } from "../../../support/temp-dir.ts";

import { ROOT_POLICY } from "../../../../src/kernel/root-policy.ts";
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
 * A MATCHING STAMP IS NECESSARY, NOT SUFFICIENT. Admission also requires the
 * binary to demonstrate confinement: the same reader must read an unprotected
 * control file and be refused a file in a protected folder. A stub that prints
 * the real pin but performs no confinement — the round-5 finding, where the
 * old `/bin/true` probe waved it through — MUST be refused with
 * `confinement_not_observed`.
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

test("hostile binary-tampering: a stub that prints the real pin and exits 0 for apply is refused — no denial was observed", () => {
  requireLinuxHost();
  // THE FOUND SHAPE: three lines, the public pin, exit 0. It answers `--stamp`
  // correctly and passes an apply probe that only requires exit 0, while
  // performing no confinement at all.
  const fakeRoot = fakeHarnessWith(
    "harness-guardian-tamper-pin-noop-",
    `#!/bin/sh\necho ${ROOT_POLICY.selfProtection.binaryStamp}\nexit 0\n`,
  );
  try {
    const availability = verifyGuardianBinaryAvailability(fakeRoot);
    assert.equal(availability.available, false, "a pin without enforcement must not be admitted");
    assert.equal(availability.code, "confinement_not_observed");
    assert.equal(availability.fallbackAttempted, false);
  } finally {
    rmSync(fakeRoot, { recursive: true, force: true });
  }
});

test("hostile binary-tampering: a pin-printing stub that RUNS the payload without confining it is refused — the protected read was not denied", () => {
  requireLinuxHost();
  // THE HARDER SHAPE: it forwards `apply --spec … --exec …` to the payload, so
  // the control read succeeds exactly as the real guardian's does. If the probe
  // only checked that the payload ran, this would be admitted. It is refused
  // because the protected read SUCCEEDED. The stub records both reader exits,
  // so the arm proves the refusal came from the missing denial, not from a
  // control half that never ran.
  const fakeRoot = createTempDir("harness-guardian-tamper-pin-passthrough-");
  try {
    copyGuardianSealedInputs(candidateRoot, fakeRoot);
    mkdirSync(join(fakeRoot, "guardian", "build"), { recursive: true });
    const callsPath = join(fakeRoot, "reader-calls.log");
    writeFileSync(
      join(fakeRoot, "guardian", "build", "harness-landlock-guardian"),
      `#!/bin/sh
if [ "$1" = "--stamp" ]; then
  echo ${ROOT_POLICY.selfProtection.binaryStamp}
  exit 0
fi
if [ "$1" = "apply" ] && [ "$2" = "--spec" ] && [ "$4" = "--exec" ]; then
  shift 4
  "$@"
  status=$?
  printf '%s => %s\\n' "$*" "$status" >> ${JSON.stringify(callsPath)}
  exit "$status"
fi
exit 64
`,
      { mode: 0o755 },
    );
    const availability = verifyGuardianBinaryAvailability(fakeRoot);
    assert.equal(availability.available, false, "a pass-through reader must not be admitted");
    assert.equal(availability.code, "confinement_not_observed");
    assert.equal(availability.fallbackAttempted, false);
    const calls = readFileSync(callsPath, "utf8").trim().split("\n");
    assert.equal(calls.length, 2, `expected a control and a protected reader run, got: ${calls.join(" | ")}`);
    const control = calls.find((line) => line.includes("control.txt"));
    const protectedRead = calls.find((line) => line.includes("secret.txt"));
    assert.ok(control?.endsWith("=> 0"), `the control read must have SUCCEEDED, got: ${control ?? "no control run"}`);
    assert.ok(protectedRead?.endsWith("=> 0"), `the protected read must have SUCCEEDED for this arm to prove the missing denial, got: ${protectedRead ?? "no protected run"}`);
  } finally {
    rmSync(fakeRoot, { recursive: true, force: true });
  }
});
