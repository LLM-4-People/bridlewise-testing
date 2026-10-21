import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { sha256 } from "../../src/kernel/integrity.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { EVIDENCE_IGNORE_BLOCK, GENERATED_BLOCKS, README_CONSUMER_BLOCK, VERIFICATION_PATHS } from "../../src/kernel/verification-paths.ts";
import { pinAuthorities } from "../../scripts/pin-authority-regeneration.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { engineModuleSourceRelative } from "../support/module-resolver.ts";
import {
  computeBindingHash,
  fixtureDigestBindings,
  generatedOutputPaths,
  generatedReadmePaths,
  isGenerationOnlyChange,
  listAllBindings,
  repairAllBindings,
  repairBinding,
  verifyAllBindings,
  verifyBinding,
  HASH_BINDING_REGISTRY_VERSION,
  type HashBinding,
} from "../../src/workflow/hash-binding-registry.ts";

const ROOT = process.cwd();

const EXPECTED_BINDING_IDS = new Set([
  "root-policy-config-contracts-source-sha256",
  "root-policy-directory-worker-source-sha256",
  "root-policy-test-inventory-hash",
  "root-policy-disposition-file-sha256",
  "root-policy-disposition-identity-hash",
  "requirements-registry-file-sha256",
  "requirements-registry-source-sha256",
  "s1-trace-requirements-registry-file-sha256",
  "s2-trace-requirements-registry-file-sha256",
  "s2-4-trace-requirements-registry-file-sha256",
  "s3-1-trace-requirements-registry-file-sha256",
  "s2-4-trace-requirements-source-artifact-sha256",
  "s2-4-trace-requirements-schema-artifact-sha256",
  "slice-traces-requirements-schema-artifact-sha256",
  "s1-verification-requirements-schema-artifact-sha256",
]);

function makeTempRoot(): string {
  return createTempDir("hash-binding-registry-");
}

function writeRelative(root: string, relativePath: string, content: string): void {
  const absolute = join(root, relativePath);
  mkdirSync(join(absolute.slice(0, absolute.lastIndexOf("/"))), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

function findBinding(id: string): HashBinding {
  const binding = listAllBindings().find((entry) => entry.id === id);
  assert.ok(binding, `binding ${id} must exist in registry`);
  return binding!;
}

// The config-contract and root-policy fixture paths are FOLD-SENSITIVE: the
// binding under test derives its source/target from ROOT_POLICY, so the
// synthetic project must mirror the policy's declared locations rather than a
// hardcoded pre-fold path. Derive both from the authority itself.
const CONTRACT_REL = ROOT_POLICY.configuration.contract.sourcePath;
const POLICY_REL = ROOT_POLICY.sourcePath;

/** A synthetic root-policy carrying the given contract sourceSha256, laid out
 *  to match the binding's findRegex (sourcePath line, then sourceSha256). */
function syntheticPolicySource(sourceSha256: string): string {
  return `    contract: {\n      sourcePath: "${CONTRACT_REL}",\n      sourceSha256: "${sourceSha256}",\n    },\n`;
}

test("HashBindingRegistry: listAllBindings returns at least 12 bindings", () => {
  const bindings = listAllBindings();
  assert.ok(bindings.length >= 12, `expected >= 12 bindings, got ${bindings.length}`);
});

test("HashBindingRegistry: listAllBindings includes every expected binding id", () => {
  const ids = new Set(listAllBindings().map((binding) => binding.id));
  for (const expected of EXPECTED_BINDING_IDS) {
    assert.ok(ids.has(expected), `missing expected binding id: ${expected}`);
  }
});

test("HashBindingRegistry: every binding has a unique id", () => {
  const ids = listAllBindings().map((binding) => binding.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("HashBindingRegistry: every binding has source/target paths and a locator", () => {
  for (const binding of listAllBindings()) {
    assert.ok(binding.sourcePath.length > 0);
    assert.ok(binding.targetPath.length > 0);
    if (binding.targetKind === "typescript") {
      assert.ok(binding.findRegex && binding.findRegex.length > 0, `${binding.id} needs findRegex`);
    } else {
      assert.ok(binding.jsonPath && binding.jsonPath.length > 0, `${binding.id} needs jsonPath`);
    }
  }
});

test("HashBindingRegistry: computeBindingHash computes file sha256 for file-sha256 bindings", () => {
  for (const binding of listAllBindings()) {
    if (binding.hashMode.kind !== "file-sha256") continue;
    const sourceText = readFileSync(join(ROOT, binding.sourcePath), "utf8");
    assert.equal(computeBindingHash(ROOT, binding), sha256(sourceText), `${binding.id} file hash`);
  }
});

test("HashBindingRegistry: computeBindingHash reads json-field bindings from the source file", () => {
  for (const binding of listAllBindings()) {
    if (binding.hashMode.kind !== "json-field") continue;
    const sourceText = readFileSync(join(ROOT, binding.sourcePath), "utf8");
    const parsed = JSON.parse(sourceText) as Record<string, unknown>;
    const fieldValue = parsed[binding.hashMode.fieldName];
    assert.equal(
      computeBindingHash(ROOT, binding),
      fieldValue,
      `${binding.id} should read field ${binding.hashMode.fieldName}`,
    );
  }
});

test("HashBindingRegistry: verifyAllBindings covers every registered binding", () => {
  const report = verifyAllBindings(ROOT);
  assert.equal(report.schemaVersion, HASH_BINDING_REGISTRY_VERSION);
  const expected = listAllBindings().length + fixtureDigestBindings(ROOT).length;
  assert.equal(report.totalBindings, expected);
  assert.equal(report.results.length, expected);
  assert.ok(typeof report.integrityHash === "string");
  assert.equal(report.integrityHash.length, 64);
});

test("HashBindingRegistry: verifyAllBindings reports all bindings matching for the real project", () => {
  const report = verifyAllBindings(ROOT);
  assert.equal(report.errors, 0, `unexpected errors: ${report.results.map((r) => r.error).filter(Boolean).join(", ")}`);
  assert.equal(report.allMatch, true, `mismatched: ${report.results.filter((r) => !r.matches).map((r) => r.id).join(", ")}`);
});

test("HashBindingRegistry: verifyBinding detects a stale typescript literal", () => {
  const binding = findBinding("root-policy-config-contracts-source-sha256");
  const tmpRoot = makeTempRoot();
  try {
    const sourceContent = "export const X = 1;\n";
    writeRelative(tmpRoot, CONTRACT_REL, sourceContent);
    writeRelative(tmpRoot, POLICY_REL, syntheticPolicySource("0".repeat(64)));
    const result = verifyBinding(tmpRoot, binding);
    assert.equal(result.matches, false);
    assert.equal(result.expected, sha256(sourceContent));
    assert.equal(result.actual, "0".repeat(64));
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("HashBindingRegistry: verifyBinding detects a stale json literal", () => {
  const binding = findBinding("s1-trace-requirements-registry-file-sha256");
  const tmpRoot = makeTempRoot();
  try {
    const registryContent = '{"registry":"r"}\n';
    writeRelative(tmpRoot, "traceability/requirements.json", registryContent);
    writeRelative(
      tmpRoot,
      "traceability/s1.json",
      `{"requirementsRegistry":{"fileSha256":"${"0".repeat(64)}"}}\n`,
    );
    const result = verifyBinding(tmpRoot, binding);
    assert.equal(result.matches, false);
    assert.equal(result.expected, sha256(registryContent));
    assert.equal(result.actual, "0".repeat(64));
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("HashBindingRegistry: repairBinding updates a stale typescript literal", () => {
  const binding = findBinding("root-policy-config-contracts-source-sha256");
  const tmpRoot = makeTempRoot();
  try {
    const sourceContent = "export const X = 1;\n";
    writeRelative(tmpRoot, CONTRACT_REL, sourceContent);
    writeRelative(tmpRoot, POLICY_REL, syntheticPolicySource("0".repeat(64)));
    const result = repairBinding(tmpRoot, binding);
    assert.equal(result.repaired, true);
    assert.equal(result.previousHash, "0".repeat(64));
    assert.equal(result.newHash, sha256(sourceContent));
    const after = readFileSync(join(tmpRoot, POLICY_REL), "utf8");
    assert.ok(after.includes(sha256(sourceContent)));
    assert.ok(!after.includes("0".repeat(64)));
    const verify = verifyBinding(tmpRoot, binding);
    assert.equal(verify.matches, true);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("HashBindingRegistry: repairBinding updates a stale json literal", () => {
  const binding = findBinding("s1-trace-requirements-registry-file-sha256");
  const tmpRoot = makeTempRoot();
  try {
    const registryContent = '{"registry":"r"}\n';
    writeRelative(tmpRoot, "traceability/requirements.json", registryContent);
    writeRelative(
      tmpRoot,
      "traceability/s1.json",
      `{"requirementsRegistry":{"fileSha256":"${"0".repeat(64)}"}}\n`,
    );
    const result = repairBinding(tmpRoot, binding);
    assert.equal(result.repaired, true);
    assert.equal(result.newHash, sha256(registryContent));
    const verify = verifyBinding(tmpRoot, binding);
    assert.equal(verify.matches, true);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("HashBindingRegistry: repairBinding is a no-op when the literal already matches", () => {
  const binding = findBinding("root-policy-config-contracts-source-sha256");
  const tmpRoot = makeTempRoot();
  try {
    const sourceContent = "export const X = 1;\n";
    const correct = sha256(sourceContent);
    writeRelative(tmpRoot, CONTRACT_REL, sourceContent);
    writeRelative(tmpRoot, POLICY_REL, syntheticPolicySource(correct));
    const result = repairBinding(tmpRoot, binding);
    assert.equal(result.repaired, false);
    assert.equal(result.previousHash, correct);
    assert.equal(result.newHash, correct);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("HashBindingRegistry: repairAllBindings repairs all stale bindings and verifyAllBindings then matches", () => {
  const tmpRoot = makeTempRoot();
  try {
    const configContent = "export const X = 1;\n";
    const registryContent = '{"registry":"r"}\n';
    const sourceArtifactContent = "# Requirements\n";
    writeRelative(tmpRoot, CONTRACT_REL, configContent);
    writeRelative(tmpRoot, "src/filesystem/private-directory-create-worker.mjs", "worker\n");
    writeRelative(tmpRoot, VERIFICATION_PATHS.testInventory, `{"inventoryHash":"${"1".repeat(64)}","tests":[]}\n`);
    writeRelative(tmpRoot, "traceability/test-surface-dispositions.json", `{"integrityHash":"${"2".repeat(64)}"}\n`);
    writeRelative(tmpRoot, "traceability/requirements.json", registryContent);
    writeRelative(tmpRoot, "traceability/canonical/harness-requirements.md", sourceArtifactContent);
    writeRelative(tmpRoot, "traceability/s2.4-requirements-schema.json", '{"schema":{}}\n');
    writeRelative(
      tmpRoot,
      POLICY_REL,
      [
        "    contract: {",
        `      sourcePath: "${CONTRACT_REL}",`,
        `      sourceSha256: "${"0".repeat(64)}",`,
        "    },",
        "    testInventorySchema: \"bridlewise-test-inventory/v4\",",
        `    testInventoryHash: "${"0".repeat(64)}",`,
        "    testSurfaceDispositionBinding: {",
        `      fileSha256: "${"0".repeat(64)}",`,
        `      identityHash: "${"0".repeat(64)}",`,
        "    },",
        "    directoryWorker: {",
        '      sourcePath: "src/filesystem/private-directory-create-worker.mjs",',
        `      sourceSha256: "${"0".repeat(64)}",`,
        "    },",
        "    selfProtection: {",
        '      binaryRelativePath: "guardian/build/harness-landlock-guardian",',
        `      binarySha256: "${"0".repeat(64)}",`,
        '      bundleRelativePath: "dist/bundle.js",',
        `      bundleSha256: "${"0".repeat(64)}",`,
        '      specSchemaArtifactPath: "traceability/self-protection/guardian-spec-schema.json",',
        `      specSchemaArtifactSha256: "${"0".repeat(64)}",`,
        "    },",
      ].join("\n") + "\n",
    );
    // Stub the three Landlock self-protection binding source files so
    // repairAllBindings can compute their hashes without file-not-found errors.
    writeRelative(tmpRoot, "guardian/build/harness-landlock-guardian", "guardian-binary-stub\n");
    // The bundle embeds its own pin (a self-pinned binding): the stub carries
    // one, so the digest is taken with it normalised out.
    writeRelative(tmpRoot, "dist/bundle.js", `const policy = { bundleSha256: "${"9".repeat(64)}" };\n`);
    writeRelative(tmpRoot, "traceability/self-protection/guardian-spec-schema.json", '{"schema":"guardian-spec"}\n');
    writeRelative(
      tmpRoot,
      engineModuleSourceRelative("kernel/requirements.ts"),
      [
        `export const REQUIREMENTS_REGISTRY_FILE_SHA256 =\n  "${"0".repeat(64)}";`,
        `export const REQUIREMENTS_REGISTRY_SOURCE_SHA256 =\n  "${"0".repeat(64)}";`,
      ].join("\n") + "\n",
    );
    const traceFile = (fileSha: string) =>
      `{"requirementsRegistry":{"fileSha256":"${fileSha}","identityHash":"${"f".repeat(64)}"}}\n`;
    writeRelative(tmpRoot, "traceability/s1.json", traceFile("0".repeat(64)));
    writeRelative(tmpRoot, "traceability/s2.json", traceFile("0".repeat(64)));
    writeRelative(
      tmpRoot,
      "traceability/s2.4.json",
      `{"requirementsRegistry":{"fileSha256":"${"0".repeat(64)}","sourceArtifactSha256":"${"0".repeat(64)}","identityHash":"${"f".repeat(64)}","schemaArtifact":{"sha256":"${"0".repeat(64)}"}}}\n`,
    );
    // The S3.1 trace also carries its contract identities (module-constant bindings to the forensic owners).
    writeRelative(
      tmpRoot,
      "traceability/s3.1.json",
      `{"requirementsRegistry":{"fileSha256":"${"0".repeat(64)}","identityHash":"${"f".repeat(64)}"},"contracts":{"schemaBundleHash":"${"0".repeat(64)}","offlineForensicHash":"${"0".repeat(64)}"}}\n`,
    );
    for (const owner of ["forensics/offline-forensics.ts", "forensics/forensic-contracts.ts"]) writeRelative(tmpRoot, engineModuleSourceRelative(owner), "export {};\n");
    writeRelative(
      tmpRoot,
      "scripts/tooling/verification/slice-traces.ts",
      [
        "    schemaArtifact: z.strictObject({",
        "      path: z.literal(SLICE_PROJECTION_PATHS.requirementsSchemaArtifact),",
        `      sha256: z.literal("${"0".repeat(64)}"),`,
        "    }),",
      ].join("\n") + "\n",
    );
    writeRelative(
      tmpRoot,
      "scripts/tooling/s1-verification.ts",
      `    if (sha256(schemaBytes) !== "${"0".repeat(64)}") {\n`,
    );

    const before = verifyAllBindings(tmpRoot);
    assert.equal(before.allMatch, false);
    assert.ok(before.mismatched > 0);

    const report = repairAllBindings(tmpRoot, { write: true });
    assert.equal(report.totalBindings, listAllBindings().length + fixtureDigestBindings(tmpRoot).length);
    assert.ok(report.repairedCount > 0, `expected repairs, got ${report.repairedCount}`);
    assert.equal(report.errorCount, 0, `unexpected errors: ${report.results.map((r) => r.error).filter(Boolean).join(", ")}`);
    assert.equal(report.allMatch, true);

    const after = verifyAllBindings(tmpRoot);
    assert.equal(after.allMatch, true, `still mismatched: ${after.results.filter((r) => !r.matches).map((r) => r.id).join(", ")}`);
    assert.equal(after.matched, listAllBindings().length);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("HashBindingRegistry: repairAllBindings with write:false does not modify targets", () => {
  const tmpRoot = makeTempRoot();
  try {
    const configContent = "export const X = 1;\n";
    writeRelative(tmpRoot, CONTRACT_REL, configContent);
    writeRelative(tmpRoot, POLICY_REL, syntheticPolicySource("0".repeat(64)));
    const targetPath = join(tmpRoot, POLICY_REL);
    const before = readFileSync(targetPath, "utf8");
    const report = repairAllBindings(tmpRoot, { write: false });
    assert.equal(report.repairedCount, 0);
    const after = readFileSync(targetPath, "utf8");
    assert.equal(before, after);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("HashBindingRegistry: verifyBinding reports an error when the source file is missing", () => {
  const binding = findBinding("root-policy-config-contracts-source-sha256");
  const tmpRoot = makeTempRoot();
  try {
    writeRelative(tmpRoot, POLICY_REL, syntheticPolicySource("0".repeat(64)));
    const result = verifyBinding(tmpRoot, binding);
    assert.equal(result.matches, false);
    assert.ok(result.error !== undefined);
    assert.equal(result.expected, "");
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("HashBindingRegistry: repairAllBindings followed by verifyAllBindings yields allMatch on the real project", () => {
  const verify = verifyAllBindings(ROOT);
  assert.equal(verify.allMatch, true);
  assert.equal(verify.errors, 0);
  assert.ok(existsSync(join(ROOT, "src/workflow/hash-binding-registry.ts")));
});

/**
 * ── EVERY PINNED SOURCE DECLARES WHETHER THE REPOSITORY HOLDS IT ──────────
 *
 * A binding pins BYTES and compares them only when the file is present. That
 * is correct for what it does, and it is silent about whether the file is
 * supposed to be there at all. Two bindings name paths `.gitignore` excludes
 * (`guardian/build/harness-landlock-guardian` at `.gitignore:8`,
 * `dist/bundle.js` at `.gitignore:5`) and both sit under
 * `selfProtection.mayNotBeDisabled`. Nothing distinguished "deliberately a
 * build artifact" from "swallowed by an ignore rule", which is exactly how a
 * live component went missing from the web tree.
 *
 * The rule is checked in BOTH directions, so neither classification can be
 * used to dodge it, and the classification is a REQUIRED field rather than a
 * list of the two known paths — a list has to be remembered, a required field
 * cannot be forgotten.
 */

/** Repository-relative paths in git's index, read once from the built-in answer. */
function gitTrackedPaths(root: string): ReadonlySet<string> {
  const out = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return new Set(out.split("\0").filter((entry) => entry.length > 0));
}

/**
 * Bindings whose declared origin disagrees with the git index, in both
 * directions. Pure over its two inputs so a plant costs a synthetic binding
 * and no mutation of the tree.
 */
function originViolations(
  bindings: readonly HashBinding[],
  isTracked: (path: string) => boolean,
): readonly string[] {
  const violations: string[] = [];
  for (const binding of bindings) {
    const tracked = isTracked(binding.sourcePath);
    if (binding.sourceOrigin.kind === "repository-source" && !tracked) {
      violations.push(
        `${binding.id}: declares repository-source but git does not track ${binding.sourcePath}; ` +
        `a clone cannot verify this pin. Check \`git check-ignore -v ${binding.sourcePath}\`.`,
      );
    }
    if (binding.sourceOrigin.kind === "build-output" && tracked) {
      violations.push(
        `${binding.id}: declares build-output but git tracks ${binding.sourcePath}; ` +
        `the committed copy is a second answer to a question the source already answers ` +
        `and goes stale on the first branch that edits it.`,
      );
    }
  }
  return violations;
}

test("HashBindingRegistry: every binding source agrees with the git index in both directions", () => {
  const tracked = gitTrackedPaths(ROOT);
  const bindings = listAllBindings();

  // LIVENESS — the covered population as runtime numbers, and a live subject
  // for EACH of the two rules. A conjunction of two detectors needs two
  // liveness checks; one satisfied rule would let the other pass vacuously.
  const repositorySources = bindings.filter((b) => b.sourceOrigin.kind === "repository-source");
  const buildOutputs = bindings.filter((b) => b.sourceOrigin.kind === "build-output");
  assert.equal(repositorySources.length + buildOutputs.length, bindings.length);
  assert.ok(bindings.length >= 18, `binding population collapsed to ${bindings.length}`);
  assert.ok(repositorySources.length > 0, "no repository-source binding: rule 1 has no subject");
  assert.ok(buildOutputs.length > 0, "no build-output binding: rule 2 has no subject");
  assert.ok(tracked.size > 0, "git index read returned nothing");

  assert.deepEqual(originViolations(bindings, (p) => tracked.has(p)), []);
});

test("HashBindingRegistry: the origin check reports a swallowed source and a committed build output", () => {
  // PLANTED FROM OUTSIDE, against the REAL git index — the two synthetic
  // bindings borrow real paths whose tracked-ness is a measured fact, so the
  // plant drives the same function with the same instrument the assertion
  // above uses and only the declaration varies.
  const tracked = gitTrackedPaths(ROOT);
  const swallowed = "dist/bundle.js";
  const committed = engineModuleSourceRelative("root-policy.ts");
  assert.equal(tracked.has(swallowed), false, "fixture assumption: dist/bundle.js is not tracked");
  assert.equal(tracked.has(committed), true, `fixture assumption: ${committed} is tracked`);

  const template = listAllBindings()[0]!;
  const planted: readonly HashBinding[] = [
    { ...template, id: "planted-swallowed", sourcePath: swallowed, sourceOrigin: { kind: "repository-source" } },
    {
      ...template,
      id: "planted-committed",
      sourcePath: committed,
      sourceOrigin: { kind: "build-output", producedBy: "node scripts/build-bundle.ts" },
    },
  ];
  const found = originViolations(planted, (p) => tracked.has(p));
  assert.equal(found.length, 2, `expected both directions to fire, got: ${found.join(" | ")}`);
  assert.ok(found[0]!.includes("planted-swallowed"));
  assert.ok(found[1]!.includes("planted-committed"));

  // And the same two bindings with their declarations swapped are silent, so
  // the finding is about the declaration and not about the paths.
  const corrected: readonly HashBinding[] = [
    { ...planted[0]!, sourceOrigin: { kind: "build-output", producedBy: "node scripts/build-bundle.ts" } },
    { ...planted[1]!, sourceOrigin: { kind: "repository-source" } },
  ];
  assert.deepEqual(originViolations(corrected, (p) => tracked.has(p)), []);
});

test("HashBindingRegistry: every build output names a producer that exists", () => {
  // Absence of a build output is a GUIDED STATE, not a bare error: the
  // consumer can name the command. That is only true if the command is real,
  // so the way out is checked rather than merely written down.
  const buildOutputs = listAllBindings().filter((b) => b.sourceOrigin.kind === "build-output");
  assert.ok(buildOutputs.length > 0);
  for (const binding of buildOutputs) {
    const origin = binding.sourceOrigin;
    assert.equal(origin.kind, "build-output");
    if (origin.kind !== "build-output") continue;
    assert.ok(origin.producedBy.length > 0, `${binding.id} has an empty producedBy`);
    const script = origin.producedBy.split(/\s+/u).at(-1)!;
    assert.ok(
      existsSync(join(ROOT, script)),
      `${binding.id} says it is produced by \`${origin.producedBy}\` but ${script} does not exist`,
    );
  }
});

test("HashBindingRegistry: a missing source NAMES the way out, and the two origins say different things", () => {
  // ── THE THIRD STATE, CLOSED ──────────────────────────────────────────────
  //
  // `sourceOrigin` was required at compile time, carried by every binding, and
  // read by nothing in production: every reference outside the registry lived
  // in this file. The doc promised that `producedBy` makes absence "a state
  // with a way out rather than a bare error", and the consumer said
  // `hash binding source file not found: dist/bundle.js`. Wired or removed —
  // the third state is what this sequence exists to eliminate, and it is
  // wired.
  //
  // Driven at the real door: `computeBindingHash` over an empty root, where
  // every source is legitimately absent, which is exactly the fresh-clone
  // situation that produced the bare errors.
  const emptyRoot = createTempDir("hash-binding-absent-");
  try {
    const bindings = listAllBindings();
    const buildOutput = bindings.find((binding) => binding.sourceOrigin.kind === "build-output");
    const repositorySource = bindings.find((binding) => binding.sourceOrigin.kind === "repository-source");
    assert.ok(buildOutput !== undefined, "no build-output binding: this rule has no subject");
    assert.ok(repositorySource !== undefined, "no repository-source binding: this rule has no subject");
    assert.equal(buildOutput.sourceOrigin.kind, "build-output");
    const producedBy = buildOutput.sourceOrigin.kind === "build-output"
      ? buildOutput.sourceOrigin.producedBy
      : "";
    assert.ok(producedBy.length > 0);

    assert.throws(
      () => computeBindingHash(emptyRoot, buildOutput),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error && error.code === "input_error" &&
        // THE ACTION, NAMED — not the lookup that failed.
        error.message.includes(producedBy) &&
        error.message.includes(buildOutput.sourcePath),
      `a missing build output must name \`${producedBy}\``,
    );

    // The other origin must NOT name a build command, because no build makes
    // it and offering one would send the reader somewhere that cannot help.
    // One message for two situations is the fallback shape this codebase
    // refuses: it reports a way out that does not exist.
    assert.throws(
      () => computeBindingHash(emptyRoot, repositorySource),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error && error.code === "input_error" &&
        error.message.includes(repositorySource.sourcePath) &&
        error.message.includes("version control") &&
        !error.message.includes(producedBy),
      "a missing repository source must not be reported as an unbuilt artifact",
    );
  } finally {
    rmSync(emptyRoot, { recursive: true, force: true });
  }
});

test("HashBindingRegistry: an S2 behaviour fixture digest is a binding — a stale pin is reported and re-pinned", () => {
  // The trace pins each behaviour fixture by sha256; no generator used to own
  // those pins, so an edited fixture could only be re-pinned by hand.
  const tmpRoot = createTempDir("hash-binding-fixture-digest-");
  try {
    const fixture = "test/fixtures/s2/b01-plant/one.json";
    mkdirSync(join(tmpRoot, "test/fixtures/s2/b01-plant"), { recursive: true });
    writeFileSync(join(tmpRoot, fixture), '{"planted":true}\n');
    mkdirSync(join(tmpRoot, "traceability"), { recursive: true });
    const tracePath = join(tmpRoot, "traceability/s2.json");
    writeFileSync(tracePath, `${JSON.stringify({ behaviors: [{ id: "S2-B01", fixtures: [{ path: fixture, sha256: "0".repeat(64) }] }] }, null, 2)}\n`);
    const bindings = fixtureDigestBindings(tmpRoot);
    assert.deepEqual(bindings.map((binding) => binding.id), [`s2-fixture-digest:${fixture}`]);
    const id = bindings[0]!.id;
    assert.equal(verifyAllBindings(tmpRoot).results.find((result) => result.id === id)?.matches, false);
    repairAllBindings(tmpRoot, { write: true });
    const repaired = JSON.parse(readFileSync(tracePath, "utf8")) as { behaviors: [{ fixtures: [{ sha256: string }] }] };
    assert.equal(repaired.behaviors[0].fixtures[0].sha256, sha256(readFileSync(join(tmpRoot, fixture))));
    assert.equal(verifyAllBindings(tmpRoot).results.find((result) => result.id === id)?.matches, true);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("HashBindingRegistry: a tree WITHOUT the test surface (a promotion's product tree) binds no S2 fixture digest; a tree that carries it judges every declared fixture, its folder deleted wholesale included", () => {
  // The product tree ships traceability/s2.json but never the test surface:
  // its `harness sync` used to fail on 50 fixtures "missing from the working
  // tree" (PROMO-2's real-data rehearsal). A tree that carries `test/` judges
  // each declared fixture — with the fixtures' folder gone too (PROMO-2 N6:
  // keyed on that folder, deleting it silenced the commit guard's check).
  const tmpRoot = createTempDir("hash-binding-fixture-product-");
  try {
    const fixture = "test/fixtures/s2/b01-plant/one.json";
    mkdirSync(join(tmpRoot, "traceability"), { recursive: true });
    writeFileSync(join(tmpRoot, "traceability/s2.json"), `${JSON.stringify({ behaviors: [{ id: "S2-B01", fixtures: [{ path: fixture, sha256: "0".repeat(64) }] }] }, null, 2)}\n`);
    assert.deepEqual(fixtureDigestBindings(tmpRoot), [], "no test surface: nothing to bind");
    assert.equal(verifyAllBindings(tmpRoot).results.some((result) => result.id.startsWith("s2-fixture-digest:")), false);
    mkdirSync(join(tmpRoot, "test"), { recursive: true });
    const id = `s2-fixture-digest:${fixture}`;
    assert.deepEqual(fixtureDigestBindings(tmpRoot).map((binding) => binding.id), [id]);
    const result = verifyAllBindings(tmpRoot).results.find((entry) => entry.id === id);
    assert.equal(result?.matches, false);
    assert.match(result?.error ?? "", /missing from the working tree/u, "the fixtures' folder deleted wholesale from a tree that carries the test surface is an error");
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("generatedReadmePaths: every OWNED README carrying the consumer marker is a generated output — tracked or untracked, never an ignored or unmarked one", () => {
  // WF-DEL leftover: the blocks were regenerated by hand and outside the
  // candidate's copy-back set; now `harness sync` writes them and the
  // generated-output set carries every README that holds one.
  const root = createTempDir("generated-readmes-");
  try {
    const git = (...args: string[]): void => { execFileSync("git", args, { cwd: root, stdio: "pipe" }); };
    git("init", "-q");
    const block = `${README_CONSUMER_BLOCK.begin}\n${README_CONSUMER_BLOCK.end}\n`;
    const plant = (path: string, text: string): void => {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    plant(".gitignore", "/ignored/\n");
    plant("README.md", `# root\n${block}`);
    plant("a/README.md", `# tracked\n${block}`);
    plant("b/README.md", "# prose only\n");
    plant("c/README.md", `# untracked\n${block}`);
    plant("ignored/README.md", `# ignored\n${block}`);
    plant("d/NOTREADME.md", block);
    git("add", "--", ".gitignore", "README.md", "a/README.md", "b/README.md");
    assert.deepEqual([...generatedReadmePaths(root)].sort(), ["README.md", "a/README.md", "c/README.md"]);
    const outputs = generatedOutputPaths(root);
    for (const path of ["README.md", "a/README.md", "c/README.md"]) assert.ok(outputs.has(path), `${path} is not a generated output`);
    assert.equal(outputs.has("b/README.md"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.deepEqual(generatedReadmePaths(createTempDir("not-a-repository-")), [], "outside a work tree there is no README to generate");
});

test("the root ignore file's evidence block is a registered generated block and output: an edit inside it alone is generation-only (design M9)", () => {
  const outputs = generatedOutputPaths(join(import.meta.dirname, "..", "..", ".."));
  assert.ok(outputs.has(EVIDENCE_IGNORE_BLOCK.path), "the ignore file is a generated output");
  assert.ok(GENERATED_BLOCKS.some((block) => block.begin === EVIDENCE_IGNORE_BLOCK.begin && block.end === EVIDENCE_IGNORE_BLOCK.end), "its block is registered");
  const before = `/node_modules/\n${EVIDENCE_IGNORE_BLOCK.begin}\n/a/evidence/\n${EVIDENCE_IGNORE_BLOCK.end}\n`;
  const regenerated = `/node_modules/\n${EVIDENCE_IGNORE_BLOCK.begin}\n/a/evidence/\n/b/evidence/\n${EVIDENCE_IGNORE_BLOCK.end}\n`;
  assert.equal(isGenerationOnlyChange(EVIDENCE_IGNORE_BLOCK.path, before, regenerated), true, "a rewritten block alone is generation-only");
  assert.equal(isGenerationOnlyChange(EVIDENCE_IGNORE_BLOCK.path, before, `/dist/\n${before}`), false, "an authored rule outside it is a source edit");
});

test("every source-authority pin target and projection a sync pass re-derives is a generated output (a candidate copies it back)", () => {
  // The pin authorities were missing from the set: a candidate re-derived
  // test/support/planned-node-test-source-authority.ts and copy-back refused
  // it as a source edit (`candidate_source_moved`).
  const outputs = generatedOutputPaths(join(import.meta.dirname, "..", "..", ".."));
  const targets = pinAuthorities().flatMap((authority) => [authority.targetPath, ...(authority.projection === undefined ? [] : [authority.projection.targetPath])]);
  assert.ok(targets.length >= 3, "the registry lists no authorities: the test has no subject");
  for (const target of targets) assert.ok(outputs.has(`engine/${target}`), `${target} is re-derived by sync but is not a generated output`);
});

/**
 * THE GUARDIAN BINARY PIN IS A PRODUCED TRUST ANCHOR, NOT A HAND VALUE.
 *
 * An alternate accepted hash that no build produces, no check verifies and no
 * regeneration path rewrites is a second trust anchor someone can edit without
 * evidence — a tampered alternate left every guard green (driven: replacing
 * the literal with 64 zeros and running the self-protection tests passed 6/6).
 * The pin is ONE anchor with its producer (`node guardian/build.ts`), its
 * binding (`file-binary-sha256`, rewritten by `harness sync`) and its check
 * (`verifyBinding`, and the availability probe's equality). The arms below
 * prove the checker fails on a tampered pin and on a removed one, and that
 * repair restores a tampered value from the binary's bytes.
 */
test("the guardian binary pin has one producer, one check and a regeneration path — and no unproduced alternate", () => {
  const binding = findBinding("root-policy-self-protection-guardian-binary-sha256");
  assert.equal(binding.sourcePath, ROOT_POLICY.selfProtection.binaryRelativePath, "the source is the built binary the floor names");
  assert.equal(binding.targetPath, ROOT_POLICY.sourcePath, "the target is the root policy that carries the pin");
  assert.deepEqual(binding.hashMode, { kind: "file-binary-sha256" }, "raw bytes, never a UTF-8 read");
  assert.equal(binding.sourceOrigin.kind, "build-output");
  assert.match(
    binding.sourceOrigin.kind === "build-output" ? binding.sourceOrigin.producedBy : "",
    /guardian\/build\.ts/u,
    "the binding names the command that produces the bytes",
  );
  assert.equal(
    "binarySha256Alternates" in ROOT_POLICY.selfProtection,
    false,
    "an alternate hash with no producer is a second trust anchor; a different toolchain is a reviewed re-pin",
  );

  // THE LIVE CHECK. A built binary must match the committed pin; an unbuilt
  // one is a guided absence naming the command, never a silent pass.
  const verdict = verifyBinding(ROOT, binding);
  if (existsSync(join(ROOT, binding.sourcePath))) {
    assert.equal(verdict.matches, true, `the committed pin disagrees with the binary bytes: ${verdict.expected} != ${verdict.actual}`);
  } else {
    assert.match(verdict.error ?? "", /has not been built yet/u);
    assert.match(verdict.error ?? "", /node guardian\/build\.ts/u);
  }

  // TAMPER, REMOVAL AND REGENERATION, driven from outside the checker: the
  // same binding and the real repair function, over planted bytes.
  const tmpRoot = makeTempRoot();
  try {
    const binaryBytes = "guardian-binary-stub\n";
    writeRelative(tmpRoot, binding.sourcePath, binaryBytes);
    const binaryHash = sha256(binaryBytes);
    const target = join(tmpRoot, binding.targetPath);
    mkdirSync(join(tmpRoot, "src", "kernel"), { recursive: true });
    const pinned = `export const P = { selfProtection: { binarySha256: "${binaryHash}" } };\n`;
    writeFileSync(target, pinned, "utf8");
    assert.equal(verifyBinding(tmpRoot, binding).matches, true, "control: the matching pin is green");

    writeFileSync(target, pinned.replace(binaryHash, "0".repeat(64)), "utf8");
    assert.equal(verifyBinding(tmpRoot, binding).matches, false, "a tampered pin must refuse");

    writeFileSync(target, "export const P = { selfProtection: {} };\n", "utf8");
    const removed = verifyBinding(tmpRoot, binding);
    assert.equal(removed.matches, false, "a removed pin must refuse");
    assert.match(removed.error ?? "", /hash literal not found/u);

    // REGENERATION: a wrong value is repaired from the bytes by the binding
    // `harness sync` runs; a removed field is a refusal (sync has no literal
    // to rewrite), never a value conjured from nothing.
    writeFileSync(target, pinned.replace(binaryHash, "0".repeat(64)), "utf8");
    const repaired = repairBinding(tmpRoot, binding);
    assert.equal(repaired.repaired, true, repaired.error ?? "repair must rewrite a wrong pin");
    assert.equal(repaired.newHash, binaryHash);
    assert.equal(verifyBinding(tmpRoot, binding).matches, true, "after repair the pin matches the bytes again");
    assert.equal(repairBinding(tmpRoot, binding).repaired, false, "an unchanged pin is not rewritten");
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
