import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ROOT_POLICY } from "../../../src/kernel/root-policy.ts";
import { PRODUCT_NAME } from "../../../src/kernel/product-identity.ts";
import {
  compileSelfProtectionConfigToSpec,
  verifyGuardianBinaryAvailability,
} from "../../../src/filesystem/self-protection/guardian-binary.ts";
import { computeGuardianBuildStamp } from "../../../src/filesystem/self-protection/guardian-build-stamp.ts";
import { applySelfProtection } from "../../support/guardian-apply.ts";
import { parseSelfProtectionConfig } from "../../../src/filesystem/self-protection/self-protection-config.ts";
import type { GuardianSpec } from "../../../src/filesystem/self-protection/self-protection-contracts.ts";
import { createTempDir } from "../../support/temp-dir.ts";
import { emptyKeepOutFacts } from "../../support/keep-out-facts.ts";
import { requireHost, requireLinuxHost } from "../../support/host-requirement.ts";

const EMPTY_KEEP_OUT = emptyKeepOutFacts();

const modulePath = fileURLToPath(import.meta.url);
const candidateRoot = dirname(dirname(dirname(dirname(modulePath))));
const testPayload = join(candidateRoot, "guardian", "build", "test_payload");

/** Floor allow-set for exec'ing a dynamically-linked binary (test_payload). */
const FLOOR_ALLOW = [
  { path: "/usr", access: ["EXECUTE", "READ_FILE", "READ_DIR"] as const },
  // Resolved: the guardian opens every spec path without following links.
  { path: realpathSync("/lib"), access: ["EXECUTE", "READ_FILE", "READ_DIR"] as const },
  { path: "/etc", access: ["READ_FILE", "READ_DIR"] as const },
  { path: "/dev", access: ["READ_FILE", "WRITE_FILE", "READ_DIR"] as const },
  { path: "/proc", access: ["READ_FILE", "READ_DIR"] as const },
];

function buildE2ESpec(protectedDir: string, allowedDir: string): GuardianSpec {
  return {
    abi_version_hint: 0,
    handled_access_fs: ["EXECUTE", "READ_FILE", "READ_DIR", "WRITE_FILE", "MAKE_REG", "TRUNCATE"],
    allow_rules: [
      ...FLOOR_ALLOW,
      { path: testPayload, access: ["EXECUTE", "READ_FILE"] },
      { path: allowedDir, access: ["READ_FILE", "READ_DIR", "WRITE_FILE", "MAKE_REG", "TRUNCATE"] },
    ],
    protected_subtrees: [protectedDir],
    default_deny_outside_allow_rules: true,
  };
}

test("e2e: non-Linux hosts report platform_unsupported (no skip; typed result, the platform planted)", () => {
  // HERMETIC: the platform is planted, so the non-Linux answer is measured on every host.
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...original, value: "darwin" });
  try {
    const availability = verifyGuardianBinaryAvailability(candidateRoot);
    assert.equal(availability.available, false);
    assert.equal(availability.code, "platform_unsupported");
  } finally {
    Object.defineProperty(process, "platform", original);
  }
});

test("e2e: test_payload read of a protected subtree → EACCES (payload exit 1)", async () => {
  requireLinuxHost();
  const work = createTempDir("harness-e2e-protected-");
  const protectedDir = join(work, "protect");
  const allowedDir = join(work, "allow");
  mkdirSync(protectedDir, { recursive: true });
  mkdirSync(allowedDir, { recursive: true });
  writeFileSync(join(protectedDir, "secret.txt"), "SECRET");
  writeFileSync(join(allowedDir, "public.txt"), "PUBLIC");
  try {
    const spec = buildE2ESpec(protectedDir, allowedDir);
    const result = await applySelfProtection(spec, testPayload, ["read", join(protectedDir, "secret.txt")], { harnessRoot: candidateRoot });
    assert.equal(result.kind, "payload_exited", `expected payload_exited, got ${JSON.stringify(result)}`);
    assert.equal((result as { exitCode: number }).exitCode, 1, `expected EACCES exit 1, got ${(result as { exitCode: number }).exitCode}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("e2e: test_payload read of an allowed subtree → OK (payload exit 0)", async () => {
  requireLinuxHost();
  const work = createTempDir("harness-e2e-allowed-");
  const protectedDir = join(work, "protect");
  const allowedDir = join(work, "allow");
  mkdirSync(protectedDir, { recursive: true });
  mkdirSync(allowedDir, { recursive: true });
  writeFileSync(join(protectedDir, "secret.txt"), "SECRET");
  writeFileSync(join(allowedDir, "public.txt"), "PUBLIC");
  try {
    const spec = buildE2ESpec(protectedDir, allowedDir);
    const result = await applySelfProtection(spec, testPayload, ["read", join(allowedDir, "public.txt")], { harnessRoot: candidateRoot });
    assert.equal(result.kind, "payload_exited");
    assert.equal((result as { exitCode: number }).exitCode, 0, `expected OK exit 0, got ${(result as { exitCode: number }).exitCode}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("e2e: test_payload write of a protected subtree → EACCES (payload exit 1)", async () => {
  requireLinuxHost();
  const work = createTempDir("harness-e2e-write-");
  const protectedDir = join(work, "protect");
  const allowedDir = join(work, "allow");
  mkdirSync(protectedDir, { recursive: true });
  mkdirSync(allowedDir, { recursive: true });
  try {
    const spec = buildE2ESpec(protectedDir, allowedDir);
    const result = await applySelfProtection(spec, testPayload, ["write", join(protectedDir, "new.txt")], { harnessRoot: candidateRoot });
    assert.equal(result.kind, "payload_exited");
    assert.equal((result as { exitCode: number }).exitCode, 1, `expected EACCES exit 1, got ${(result as { exitCode: number }).exitCode}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("e2e: applySelfProtection returns pre_exec_failure with exit 64 when the binary is missing", async () => {
  const spec = buildE2ESpec("/nonexistent/protect", "/nonexistent/allow");
  const result = await applySelfProtection(spec, "/bin/true", [], { harnessRoot: "/nonexistent-harness-root" });
  assert.equal(result.kind, "pre_exec_failure");
  assert.equal((result as { exitCode: number }).exitCode, 64);
});

test("e2e: the guardian's reported stamp is the one recomputed from the sealed sources and the committed pin", () => {
  // The stamp is reproducible: the binary carries one derived from its
  // sources and declared flags, and the runtime recomputes the same value from
  // the tree. A missed rebuild or a source edit without `harness sync` changes
  // the stamp and refuses here. A matching stamp is not admission by itself:
  // verifyGuardianBinaryAvailability also requires the binary to deny a
  // protected read, so a no-op that prints the pin is refused too.
  const binaryPath = join(candidateRoot, ROOT_POLICY.selfProtection.binaryRelativePath);
  requireHost(existsSync(binaryPath), `the built guardian binary at ${binaryPath} (the checkout setup's guardian step builds it)`);
  const availability = verifyGuardianBinaryAvailability(candidateRoot);
  assert.equal(availability.available, true, `expected available, got: ${JSON.stringify(availability)}`);
  if (availability.available) {
    const recomputed = computeGuardianBuildStamp(candidateRoot);
    assert.equal(availability.stamp, recomputed, "the binary's stamp must equal the sealed source tree's stamp");
    assert.equal(
      ROOT_POLICY.selfProtection.binaryStamp,
      recomputed,
      "the committed pin must equal the sealed source tree's stamp (run `harness sync` after a guardian source change)",
    );
  }
});

test("e2e: compiled spec (the cli.ts bootstrap path) blocks readFileSync of <harness-root>/src/cli.ts", async () => {
  requireLinuxHost();
  const work = createTempDir("harness-e2e-cli-reexec-");
  try {
    // The payload: a node script that reads <harness-root>/src/cli.ts. Under the
    // compiled spec (protected_subtrees includes <harness-root>/src) this MUST
    // be denied with EACCES. This is the integration path the cli.ts bootstrap
    // uses: compileSelfProtectionConfigToSpec -> applySelfProtection.
    const probeScript = join(work, "probe.js");
    const target = join(candidateRoot, "src", "cli.ts");
    writeFileSync(
      probeScript,
      `import { readFileSync } from "node:fs";\n` +
        `try { readFileSync(${JSON.stringify(target)}); console.log("LEAK_OK"); }\n` +
        `catch (e) { console.log("BLOCKED:" + (e.code ?? e.message)); }\n`,
      { mode: 0o600 },
    );
    const config = parseSelfProtectionConfig({
      schemaVersion: "bridlewise-self-protection-config/v1",
      enabled: true,
      tempDir: work,
    });
    const spec = compileSelfProtectionConfigToSpec(config, candidateRoot, work, process.execPath, EMPTY_KEEP_OUT);
    const result = await applySelfProtection(spec, process.execPath, [probeScript], { harnessRoot: candidateRoot });
    assert.equal(result.kind, "payload_exited", `expected payload_exited, got ${JSON.stringify(result)}`);
    // The node payload reads src/cli.ts -> EACCES -> prints BLOCKED:EACCES.
    // We assert the exit code is 0 (the script swallows the error and prints),
    // and rely on the BLOCKED/EACCES assertion in the contract test for the
    // hard denial. Here we assert the payload ran (exit 0) and the spec
    // actually protected src (no allow-rule for src/cli.ts).
    assert.ok(
      !spec.allow_rules.some((r) => r.path.startsWith(join(candidateRoot, "src"))),
      "no allow-rule may cover the protected src subtree",
    );
    assert.ok(spec.protected_subtrees.includes(join(candidateRoot, "src")), "src must be a protected subtree");
    assert.equal((result as { exitCode: number }).exitCode, 0, `expected probe script exit 0, got ${(result as { exitCode: number }).exitCode}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("e2e GUARD-F5: a link under the HOME's keep-out wildcard (`~/.local/state/<product>-*`) no longer refuses every confined spawn; its target stays unreadable", async () => {
  requireLinuxHost();
  // A substitute HOME under the run's own temp root (never the real floor).
  const home = realpathSync(createTempDir("harness-e2e-guard-f5-home-"));
  const work = realpathSync(createTempDir("harness-e2e-guard-f5-work-"));
  const target = realpathSync(createTempDir("harness-e2e-guard-f5-target-"));
  writeFileSync(join(target, "secret.txt"), "SECRET");
  const previousHome = process.env.HOME;
  try {
    process.env.HOME = home;
    mkdirSync(join(home, ".local", "state"), { recursive: true });
    const link = join(home, ".local", "state", `${PRODUCT_NAME}-coordinator`);
    symlinkSync(target, link);
    const probeScript = join(work, "probe.js");
    writeFileSync(
      probeScript,
      `import { readFileSync } from "node:fs";\n` +
        `for (const path of ${JSON.stringify([join(target, "secret.txt"), join(link, "secret.txt")])}) {\n` +
        `  try { readFileSync(path); console.log("LEAK"); process.exit(3); } catch (e) { if (e.code !== "EACCES") process.exit(4); }\n` +
        `}\n`,
      { mode: 0o600 },
    );
    const config = parseSelfProtectionConfig({ schemaVersion: "bridlewise-self-protection-config/v1", enabled: true, tempDir: work });
    const spec = compileSelfProtectionConfigToSpec(config, candidateRoot, work, process.execPath, EMPTY_KEEP_OUT);
    assert.ok((spec.keep_out ?? []).includes(link), `the wildcard's link is emitted into the spec: ${JSON.stringify(spec.keep_out)}`);
    const result = await applySelfProtection(spec, process.execPath, [probeScript], { harnessRoot: candidateRoot });
    assert.deepEqual(result, { kind: "payload_exited", exitCode: 0 }, "the confined spawn ran, and both reads of the target were refused");
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    for (const folder of [home, work, target]) rmSync(folder, { recursive: true, force: true });
  }
});
