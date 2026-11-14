import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ROOT_POLICY } from "../../../src/kernel/root-policy.ts";
import { listSafeRepositoryTree, readSafeRepositoryFile } from "../../../scripts/verification/safe-repository-reader.ts";
import { createPathLocator, resolveLocation } from "../../../src/filesystem/path-identity.ts";
import { sha256 } from "../../../src/kernel/integrity.ts";
import { verifyGuardianBinaryAvailability, readGuardianBinaryBuildStamp } from "../../../src/filesystem/self-protection/guardian-binary.ts";
import {
  computeGuardianBuildStamp,
  parseGuardianBuildStampOutput,
  readGuardianBuildStampSpec,
} from "../../../src/filesystem/self-protection/guardian-build-stamp.ts";
import { copyGuardianSealedInputs } from "../../support/guardian-build-stamp.ts";
import { createTempDir } from "../../support/temp-dir.ts";
import { requireHost, requireLinuxHost } from "../../support/host-requirement.ts";

const modulePath = fileURLToPath(import.meta.url);
// test/filesystem/self-protection/ -> self-protection, filesystem, test, engine.
const candidateRoot = dirname(dirname(dirname(dirname(modulePath))));

function canBuildGuardian(): boolean {
  return spawnSync("make", ["--version"], { stdio: "ignore" }).status === 0
    && spawnSync("gcc-14", ["--version"], { stdio: "ignore" }).status === 0;
}

/** A harness root with the guardian's Makefile and sealed inputs, no build output. */
function freshGuardianRoot(prefix: string): string {
  const root = createTempDir(prefix);
  copyGuardianSealedInputs(candidateRoot, root);
  const guardian = join(root, "guardian");
  copyFileSync(join(candidateRoot, "guardian", "Makefile"), join(guardian, "Makefile"));
  return root;
}

function invokeMake(root: string, ...args: readonly string[]) {
  return spawnSync("make", ["--no-print-directory", "-C", join(root, "guardian"), ...args], {
    encoding: "utf8",
  });
}

function make(root: string, ...args: readonly string[]): void {
  const result = invokeMake(root, ...args);
  assert.equal(
    result.status,
    0,
    `make ${args.join(" ")} failed in ${root}:\n${result.stdout ?? ""}${result.stderr ?? ""}`,
  );
}

function builtBinary(root: string): string {
  return join(root, ROOT_POLICY.selfProtection.binaryRelativePath);
}

function builtStamp(root: string): string {
  const probe = readGuardianBinaryBuildStamp(builtBinary(root));
  assert.equal(probe.kind, "stamp", `expected a stamp from ${builtBinary(root)}, got ${JSON.stringify(probe)}`);
  return probe.kind === "stamp" ? probe.stamp : "";
}

/**
 * (a) TWO CLEAN BUILDS FROM THE SAME SEALED INPUTS REPORT THE SAME STAMP.
 *
 * The old anchor hashed the compiler's output, so two toolchains — or two
 * builds whose debug paths differed — sealed different digests. The stamp is
 * derived from the inputs, so every clean build of this tree agrees, and it
 * agrees with the runtime's own recomputation.
 */
test("guardian build stamp: two clean builds of the same sealed inputs report the same stamp", () => {
  requireHost(canBuildGuardian(), "make and the pinned gcc-14 (the guardian's declared compiler)");
  const first = freshGuardianRoot("guardian-stamp-a-");
  const second = freshGuardianRoot("guardian-stamp-b-");
  try {
    make(first, "clean", "guardian");
    make(second, "clean", "guardian");
    const firstStamp = builtStamp(first);
    const secondStamp = builtStamp(second);
    assert.equal(firstStamp, secondStamp, "two clean builds of one source tree must report one stamp");
    assert.equal(firstStamp, computeGuardianBuildStamp(first), "the Makefile and the runtime must hash the same payload");
    assert.equal(firstStamp, ROOT_POLICY.selfProtection.binaryStamp, "the committed pin must equal the source tree's stamp");
    assert.match(firstStamp, /^[0-9a-f]{64}$/u);
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

/**
 * (b) TAMPER THE SOURCE AND REBUILD → THE RUNTIME REFUSES.
 *
 * The rebuilt binary honestly reports the tampered tree's stamp (so a
 * recompute-only check would wave it through). The committed pin is the
 * sealed value the source no longer reproduces, and the availability probe
 * refuses with the typed `binary_hash_mismatch` — fail closed, no fallback.
 */
test("guardian build stamp: a tampered source rebuilt into a binary is refused as binary_hash_mismatch", () => {
  requireHost(canBuildGuardian(), "make and the pinned gcc-14 (the guardian's declared compiler)");
  requireLinuxHost();
  const root = freshGuardianRoot("guardian-stamp-tamper-");
  try {
    make(root, "clean", "guardian");
    const pristineStamp = builtStamp(root);
    assert.equal(pristineStamp, ROOT_POLICY.selfProtection.binaryStamp);
    appendFileSync(
      join(root, "guardian", "landlock-guardian.c"),
      "\n/* tampered in a test: this file is no longer the sealed source */\n",
    );
    make(root, "clean", "guardian");
    const tamperedStamp = builtStamp(root);
    assert.notEqual(tamperedStamp, ROOT_POLICY.selfProtection.binaryStamp, "the tamper must change the stamp");
    assert.equal(tamperedStamp, computeGuardianBuildStamp(root), "the rebuilt binary reports the tampered tree's stamp");
    const availability = verifyGuardianBinaryAvailability(root);
    assert.equal(availability.available, false, "a binary built from unsealed sources must be refused");
    assert.equal(availability.code, "binary_hash_mismatch");
    assert.equal(availability.fallbackAttempted, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * (c) A BINARY BUILT ELSEWHERE STILL PASSES WHEN ITS SOURCES MATCH.
 *
 * The stamp does not depend on codegen, so a binary built with extra debug
 * information — different bytes, same declared inputs — is admitted. That is
 * the property the CI runner's different gcc needed: the file digest is
 * reported for diagnostics, but it is not the trust anchor.
 */
test("guardian build stamp: a differently compiled binary from matching sources is admitted", () => {
  requireHost(canBuildGuardian(), "make and the pinned gcc-14 (the guardian's declared compiler)");
  requireLinuxHost();
  const reference = freshGuardianRoot("guardian-stamp-reference-");
  const elsewhere = freshGuardianRoot("guardian-stamp-elsewhere-");
  try {
    make(reference, "clean", "guardian");
    const spec = readGuardianBuildStampSpec(elsewhere);
    // Undeclared flags change the CODE but not the sealed stamp: `-g` is not
    // part of the declared inputs. This is the closest local stand-in for the
    // CI compiler's different codegen.
    make(elsewhere, "clean");
    make(elsewhere, "guardian", `CFLAGS=${spec.cflags} -g`);

    const referenceBytes = readFileSync(builtBinary(reference));
    const elsewhereBytes = readFileSync(builtBinary(elsewhere));
    assert.notEqual(sha256(referenceBytes), sha256(elsewhereBytes), "the witness must actually change the binary bytes");
    assert.equal(builtStamp(reference), builtStamp(elsewhere), "codegen must not change the stamp");

    const availability = verifyGuardianBinaryAvailability(elsewhere);
    assert.equal(availability.available, true, `expected the elsewhere-built binary to be admitted: ${JSON.stringify(availability)}`);
    if (availability.available) {
      assert.equal(availability.stamp, ROOT_POLICY.selfProtection.binaryStamp);
      assert.notEqual(availability.sha256, sha256(referenceBytes), "the reported file digest is diagnostic, not the anchor");
    }
  } finally {
    rmSync(reference, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

/** The parser refuses shapes the runtime must never mistake for a stamp. */
test("guardian build stamp: only exactly one 64-hex stamp is a stamp", () => {
  const stamp = "a".repeat(64);
  assert.equal(parseGuardianBuildStampOutput(`${stamp}\n`), stamp);
  assert.equal(parseGuardianBuildStampOutput(stamp), stamp);
  assert.equal(parseGuardianBuildStampOutput(`${stamp}\n\n`), undefined);
  assert.equal(parseGuardianBuildStampOutput(`${stamp} extra\n`), undefined);
  assert.equal(parseGuardianBuildStampOutput(`${"A".repeat(64)}\n`), undefined);
  assert.equal(parseGuardianBuildStampOutput(`${"a".repeat(63)}\n`), undefined);
  assert.equal(parseGuardianBuildStampOutput(""), undefined);
  assert.equal(parseGuardianBuildStampOutput("landlock-guardian: 64: usage\n"), undefined);
});

/** A spec that escapes its folder, names a missing source or is malformed refuses, typed. */
test("guardian build stamp: a malformed or escaping sealed-input declaration is refused", () => {
  const root = createTempDir("guardian-stamp-spec-");
  try {
    copyGuardianSealedInputs(candidateRoot, root);
    const specPath = join(root, ROOT_POLICY.selfProtection.buildStampSpecPath);
    const original = readFileSync(specPath, "utf8");
    const assertRefused = (text: string, expectedCode: string): void => {
      writeFileSync(specPath, text, "utf8");
      assert.throws(
        () => computeGuardianBuildStamp(root),
        (error: unknown) => (error as { code?: string }).code === expectedCode,
      );
    };
    assertRefused(original.replace(/STAMP_SOURCES := .*/u, "STAMP_SOURCES := ../escape.c"), "guardian_build_stamp_inputs_invalid");
    assertRefused(original.replace(/STAMP_SOURCES := .*/u, "STAMP_SOURCES := no-such-source.c"), "guardian_build_stamp_inputs_missing");
    assertRefused(original.replace(/STAMP_FORMAT := .*/u, ""), "guardian_build_stamp_inputs_invalid");
    assertRefused(`${original}UNKNOWN_KEY := value\n`, "guardian_build_stamp_inputs_invalid");
    writeFileSync(specPath, original, "utf8");
    assert.equal(computeGuardianBuildStamp(root), ROOT_POLICY.selfProtection.binaryStamp, "the restored declaration computes the committed pin");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("guardian build stamp: the snapshot fixture has the sources it names", () => {
  for (const source of readGuardianBuildStampSpec(candidateRoot).sources) {
    assert.equal(existsSync(join(candidateRoot, "guardian", source)), true, `sealed source ${source} must exist`);
  }
  assert.equal(existsSync(join(candidateRoot, ROOT_POLICY.selfProtection.buildStampSpecPath)), true);
});

// These existing sources are test-fixtures inputs, outside the guardian's
// sealed-source declaration. The shared sealed-input copier stays unchanged.
const guardianTestSources = ["tests/test_payload.c", "test-process-supervisor.c"] as const;

function freshGuardianTestRoot(prefix: string): string {
  const root = freshGuardianRoot(prefix);
  try {
    for (const source of guardianTestSources) {
      const destination = join(root, "guardian", source);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(candidateRoot, "guardian", source), destination);
    }
    return root;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function assertOwnedExecutable(root: string, path: string): void {
  assert.ok(isAbsolute(path), `expected an absolute fixture path, got ${JSON.stringify(path)}`);
  const locator = createPathLocator();
  const names = locator.namesUnder(
    locator.locate(resolveLocation(path, "native test fixture")),
    locator.locate(resolveLocation(root, "native test fixture root")),
  );
  assert.ok(names !== undefined && names.length > 0, `fixture must lie strictly below its owned root: ${path}`);
  const info = lstatSync(path, { bigint: true });
  assert.ok(info.isFile() && !info.isSymbolicLink(), `expected a regular fixture file: ${path}`);
  assert.notEqual(info.mode & 0o111n, 0n, `expected executable fixture mode: ${path}`);
}

/** The Makefile supplies this path; the test never spells a static basename. */
function staticTestBinary(root: string): string {
  const result = invokeMake(root, "test-preflight");
  assert.equal(result.error, undefined, `preflight did not start: ${String(result.error)}`);
  assert.equal(result.signal, null, `preflight ended by signal: ${String(result.signal)}`);
  assert.equal(result.status, 0, `preflight failed: ${result.stderr ?? ""}`);
  const output = result.stdout ?? "";
  assert.ok(output.endsWith("\n"), `preflight must emit one path line: ${JSON.stringify(output)}`);
  const path = output.slice(0, -1);
  assert.ok(path.length > 0 && !/[\r\n]/u.test(path), `preflight must emit exactly one path: ${JSON.stringify(output)}`);
  assertOwnedExecutable(root, path);
  return path;
}

function nativeFixtureMetadata(path: string) {
  const info = lstatSync(path, { bigint: true });
  return {
    path,
    kind: info.isFile() ? "file" : info.isDirectory() ? "directory" : "unsupported",
    device: info.dev.toString(),
    inode: info.ino.toString(),
    mode: info.mode.toString(),
    size: info.size.toString(),
    mtimeNs: info.mtimeNs.toString(),
    ctimeNs: info.ctimeNs.toString(),
  };
}

/** Observe declared fixture inputs and every flat build output through one byte owner. */
function nativeFixtureSnapshot(root: string) {
  const sourcePaths = [
    join("guardian", "Makefile"),
    ROOT_POLICY.selfProtection.buildStampSpecPath,
    ...readGuardianBuildStampSpec(root).sources.map((source) => join("guardian", source)),
    ...guardianTestSources.map((source) => join("guardian", source)),
  ];
  const buildRelative = dirname(ROOT_POLICY.selfProtection.binaryRelativePath);
  const directory = nativeFixtureMetadata(join(root, buildRelative));
  assert.equal(directory.kind, "directory", `expected the owned build directory: ${buildRelative}`);
  const outputs = listSafeRepositoryTree(root, buildRelative, {
    // Build outputs were already required to be files, with no subdirectories.
    maximumDepth: 0,
    maximumEntries: ROOT_POLICY.verification.testDiscovery.maximumEntries,
  });
  const outputIdentities = new Map(outputs.map((entry) => [entry.path, entry.identityHash]));
  const files = [...new Set([...sourcePaths, ...outputIdentities.keys()])].sort().map((path) => {
    const file = readSafeRepositoryFile(
      root, path, ROOT_POLICY.verification.candidateFormat.maximumInspectedFileBytes,
    );
    const enumeratedIdentity = outputIdentities.get(path);
    if (enumeratedIdentity !== undefined) {
      assert.equal(file.identityHash, enumeratedIdentity, `fixture changed after enumeration: ${path}`);
    }
    return { path, identityHash: file.identityHash, sha256: sha256(file.bytes) };
  });
  assert.deepEqual(listSafeRepositoryTree(root, buildRelative, {
    maximumDepth: 0,
    maximumEntries: ROOT_POLICY.verification.testDiscovery.maximumEntries,
  }), outputs, "fixture output entries changed during snapshot acquisition");
  assert.deepEqual(nativeFixtureMetadata(join(root, buildRelative)), directory,
    "fixture output directory changed during snapshot acquisition");
  // File identity includes mode, inode, size, mtime and ctime. Directory times
  // also expose temporary entries created then removed; atime stays excluded.
  return { directory, files };
}

function assertPreflightRefusesWithoutWriting(root: string, label: string): void {
  const before = nativeFixtureSnapshot(root);
  const result = invokeMake(root, "test-preflight");
  assert.equal(result.error, undefined, `${label}: preflight did not start: ${String(result.error)}`);
  assert.equal(result.signal, null, `${label}: preflight ended by signal: ${String(result.signal)}`);
  assert.notEqual(result.status, null, `${label}: preflight had no normal exit status`);
  assert.notEqual(result.status, 0, `${label}: preflight must refuse an outdated artifact`);
  assert.equal(result.stdout ?? "", "", `${label}: refused preflight must not emit a fixture path`);
  assert.deepEqual(nativeFixtureSnapshot(root), before, `${label}: preflight must not build, rewrite, replace or touch fixture inputs/outputs`);
}

test("guardian native test targets: prepare fixtures separately and refuse missing/stale artifacts without rebuilding", () => {
  requireHost(canBuildGuardian(), "make and the pinned gcc-14 (the guardian's declared compiler)");
  requireLinuxHost();
  const root = freshGuardianTestRoot("guardian-test-targets-");
  try {
    make(root, "test-fixtures");
    const staticBinary = staticTestBinary(root);
    assertOwnedExecutable(root, builtBinary(root));

    // Discover the static path before deleting anything. A clean product all
    // must not acquire or build that test-only static-libc output.
    make(root, "clean", "all");
    assertOwnedExecutable(root, builtBinary(root));
    assert.equal(existsSync(staticBinary), false, "product all must leave the static test-only output absent");

    make(root, "test-fixtures");
    assert.equal(staticTestBinary(root), staticBinary, "canonical preparation must retain its one static path authority");
    const current = nativeFixtureSnapshot(root);
    assert.equal(staticTestBinary(root), staticBinary);
    assert.deepEqual(nativeFixtureSnapshot(root), current, "current preflight must not rewrite prepared fixtures");

    const guardianSource = readGuardianBuildStampSpec(root).sources[0];
    assert.ok(guardianSource !== undefined, "the guardian must declare a sealed prerequisite");
    const artifacts = [
      { name: "static", path: staticBinary, prerequisite: join(root, "guardian", guardianTestSources[0]) },
      { name: "guardian", path: builtBinary(root), prerequisite: join(root, "guardian", guardianSource) },
    ];
    for (const artifact of artifacts) {
      assertOwnedExecutable(root, artifact.path);
      rmSync(artifact.path);
      assertPreflightRefusesWithoutWriting(root, `${artifact.name} missing`);
      assert.equal(existsSync(artifact.path), false, `${artifact.name}: missing artifact must remain missing after preflight`);
      make(root, "test-fixtures");
      assert.equal(staticTestBinary(root), staticBinary);
    }

    for (const artifact of artifacts) {
      assertOwnedExecutable(root, artifact.path);
      // Epoch timestamps are independent of wall-clock scheduling. Assert the
      // actual prerequisite ordering before asking make its freshness question.
      utimesSync(artifact.path, new Date(0), new Date(0));
      assert.ok(
        lstatSync(artifact.path, { bigint: true }).mtimeNs < lstatSync(artifact.prerequisite, { bigint: true }).mtimeNs,
        `${artifact.name}: controlled artifact must be older than its real prerequisite`,
      );
      assertPreflightRefusesWithoutWriting(root, `${artifact.name} stale`);
      assert.ok(
        lstatSync(artifact.path, { bigint: true }).mtimeNs < lstatSync(artifact.prerequisite, { bigint: true }).mtimeNs,
        `${artifact.name}: preflight must leave the artifact stale`,
      );
      make(root, "test-fixtures");
      assert.equal(staticTestBinary(root), staticBinary);
    }

    const final = nativeFixtureSnapshot(root);
    assert.equal(staticTestBinary(root), staticBinary);
    assert.deepEqual(nativeFixtureSnapshot(root), final, "final current preflight must remain observational");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
