import assert from "node:assert/strict";
import { rmSync, writeFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { ROOT_POLICY } from "../../../../src/kernel/root-policy.ts";
import { GUARDIAN_SPEC_SCHEMA } from "../../../../src/filesystem/self-protection/self-protection-contracts.ts";
import { createTempDir } from "../../../support/temp-dir.ts";
import { requireLinuxHost } from "../../../support/host-requirement.ts";

const modulePath = fileURLToPath(import.meta.url);
// test/filesystem/self-protection/contract/guardian-spec-contract.test.ts
// is 5 dirname hops to the candidate root (contract/ -> self-protection/ ->
// filesystem/ -> test/ -> root).
const candidateRoot = dirname(dirname(dirname(dirname(dirname(modulePath)))));
const binaryPath = join(candidateRoot, ROOT_POLICY.selfProtection.binaryRelativePath);

/**
 * Contract test: the C binary's actual behavior must match the Zod
 * GUARDIAN_SPEC_SCHEMA. A spec the schema accepts → the binary accepts (exit 0
 * or the payload's exit). A spec the schema rejects (malformed) → the binary
 * rejects (exit 2 or 4). This is the drift-prevention test between the C
 * binary's `landlock-guardian.h` flag table and the Node-side schema.
 *
 * The test host is Linux (a HOST REQUIREMENT: the binary is Landlock's).
 */

function runGuardian(spec: unknown, payload: string, args: readonly string[]): { exitCode: number; stderr: string } {
  const tempDir = createTempDir("harness-guardian-contract-");
  const specPath = join(tempDir, "spec.json");
  try {
    writeFileSync(specPath, JSON.stringify(spec), { mode: 0o600 });
    const result = spawnSync(
      binaryPath,
      ["apply", "--spec", specPath, "--exec", payload, ...args],
      { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" },
    );
    return { exitCode: result.status ?? -1, stderr: result.stderr ?? "" };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

const VALID_FLOOR_SPEC = {
  abi_version_hint: 0,
  handled_access_fs: ["EXECUTE", "READ_FILE", "READ_DIR", "WRITE_FILE"],
  allow_rules: [
    { path: "/usr", access: ["EXECUTE", "READ_FILE", "READ_DIR"] },
    // Resolved: the guardian opens every spec path without following links,
    // and `/lib` is a link into `/usr` on a merged-/usr host.
    { path: realpathSync("/lib"), access: ["EXECUTE", "READ_FILE", "READ_DIR"] },
    { path: "/etc", access: ["READ_FILE", "READ_DIR"] },
    { path: "/dev", access: ["READ_FILE", "WRITE_FILE", "READ_DIR"] },
    { path: "/proc", access: ["READ_FILE", "READ_DIR"] },
  ],
  protected_subtrees: [],
  default_deny_outside_allow_rules: true,
};

test("contract: Zod-accepted spec → C binary execs /bin/true (exit 0)", () => {
  requireLinuxHost();
  GUARDIAN_SPEC_SCHEMA.parse(VALID_FLOOR_SPEC);
  const { exitCode } = runGuardian(VALID_FLOOR_SPEC, "/bin/true", []);
  assert.equal(exitCode, 0, `expected /bin/true exit 0, got ${exitCode}`);
});

test("contract: Zod-rejected spec (unknown flag) → C binary exit 2 (spec_parse_error)", () => {
  requireLinuxHost();
  const bad = { ...VALID_FLOOR_SPEC, handled_access_fs: ["READ_FILE", "BOGUS_FLAG"] };
  assert.throws(() => GUARDIAN_SPEC_SCHEMA.parse(bad));
  const { exitCode, stderr } = runGuardian(bad, "/bin/true", []);
  assert.equal(exitCode, 2, `expected exit 2 for unknown flag, got ${exitCode}: ${stderr}`);
});

test("contract: Zod-rejected spec (temp_dir_access without temp_dir) → C binary exit 4", () => {
  requireLinuxHost();
  const bad = { ...VALID_FLOOR_SPEC, temp_dir_access: ["READ_FILE"] };
  assert.throws(() => GUARDIAN_SPEC_SCHEMA.parse(bad));
  const { exitCode, stderr } = runGuardian(bad, "/bin/true", []);
  assert.ok(exitCode === 2 || exitCode === 4, `expected exit 2 or 4, got ${exitCode}: ${stderr}`);
});

test("contract: C binary rejects an allow-rule path under a protected subtree (exit 4); Zod schema parses it but the compiler's superRefine catches it", () => {
  requireLinuxHost();
  const spec = {
    ...VALID_FLOOR_SPEC,
    protected_subtrees: ["/usr"],
    allow_rules: [{ path: "/usr/bin/true", access: ["EXECUTE", "READ_FILE"] }],
  };
  // The Zod spec schema itself accepts this shape (it cannot know the inode
  // type or path relationships without filesystem access). The C binary
  // validates it at runtime and rejects with exit 4. The Node-side compiler
  // (compileSelfProtectionConfigToSpec) catches this case earlier via its
  // validateCompiledSpec superRefine; see compile-spec.test.ts.
  GUARDIAN_SPEC_SCHEMA.parse(spec);
  const { exitCode, stderr } = runGuardian(spec, "/bin/true", []);
  assert.equal(exitCode, 4, `expected exit 4 for allow-rule under protected subtree, got ${exitCode}: ${stderr}`);
});

test("contract: the C binary sets no 'already confined' env sentinel (a sandbox decision is measured, never read from env)", () => {
  requireLinuxHost();
  const tempDir = createTempDir("harness-guardian-sentinel-");
  const probePath = join(tempDir, "env-probe.sh");
  const specPath = join(tempDir, "spec.json");
  try {
    writeFileSync(probePath, `#!/bin/sh\necho "sentinel=[$HARNESS_LANDLOCK_GUARDIAN]"\n`, { mode: 0o755 });
    const spec = {
      ...VALID_FLOOR_SPEC,
      allow_rules: [
        ...VALID_FLOOR_SPEC.allow_rules,
        { path: realpathSync(tempDir), access: ["EXECUTE", "READ_FILE", "READ_DIR"] },
      ],
    };
    writeFileSync(specPath, JSON.stringify(spec), { mode: 0o600 });
    const result = spawnSync(binaryPath, ["apply", "--spec", specPath, "--exec", probePath], {
      stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", env: { PATH: process.env["PATH"] ?? "" },
    });
    assert.equal((result.stdout ?? "").trim(), "sentinel=[]", `exit ${result.status}: ${result.stderr}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
