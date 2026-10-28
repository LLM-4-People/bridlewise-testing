import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { sha256 } from "../../src/kernel/integrity.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { computeGuardianBuildStamp } from "../../src/filesystem/self-protection/guardian-build-stamp.ts";
import { DECISION_INDEX, EVIDENCE_IGNORE_BLOCK, GENERATED_BLOCKS, PIN_AUTHORITY_PATHS, VERIFICATION_PATHS } from "../../src/kernel/verification-paths.ts";
import { pinAuthorities } from "../../scripts/pin-authority-regeneration.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { engineModuleSourceRelative } from "../support/module-resolver.ts";
import {
  AUTHORED_PIN_REGION,
  bindingPinRanges,
  computeBindingHash,
  fixtureDigestBindings,
  generatedOutputPaths,
  isGenerationOnlyChange,
  listAllBindings,
  regeneratedPinRanges,
  repairAllBindings,
  repairBinding,
  stripRegeneratedPins,
  suiteRegeneratedPaths,
  verifyAllBindings,
  verifyBinding,
  wholesaleGeneratedPaths,
  HASH_BINDING_REGISTRY_VERSION,
  type HashBinding,
} from "../../src/workflow/hash-binding-registry.ts";
import { ARCHITECTURE_MANIFEST } from "../../src/architecture-manifest.ts";
import {
  PUBLISHED_EXTERNAL_COMMAND_POPULATION_SHA256,
  publishedExternalCommandPopulationHash,
} from "../../src/kernel/architecture-external-commands.ts";

const ROOT = process.cwd();

const EXPECTED_BINDING_IDS = new Set([
  "root-policy-config-contracts-source-sha256",
  "root-policy-directory-worker-source-sha256",
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
        "    directoryWorker: {",
        '      sourcePath: "src/filesystem/private-directory-create-worker.mjs",',
        `      sourceSha256: "${"0".repeat(64)}",`,
        "    },",
        "    selfProtection: {",
        '      binaryRelativePath: "guardian/build/harness-landlock-guardian",',
        '      buildStampSpecPath: "guardian/build-stamp.spec",',
        `      binaryStamp: "${"0".repeat(64)}",`,
        '      bundleRelativePath: "dist/bundle.js",',
        '      specSchemaArtifactPath: "traceability/self-protection/guardian-spec-schema.json",',
        `      specSchemaArtifactSha256: "${"0".repeat(64)}",`,
        `      specSchemaSourcePath: "${ROOT_POLICY.selfProtection.specSchemaSourcePath}",`,
        `      specSchemaSourceSha256: "${"0".repeat(64)}",`,
        "    },",
      ].join("\n") + "\n",
    );
    // Stub the guardian's SEALED INPUTS (the stamp binding hashes them, not
    // the compiler-built binary) and the other Landlock self-protection
    // binding sources, so repairAllBindings can compute without file-not-found
    // errors. The built binary is deliberately absent: the stamp does not read
    // it.
    writeRelative(
      tmpRoot,
      "guardian/build-stamp.spec",
      "STAMP_FORMAT := bridlewise-guardian-build-stamp/v1\n"
        + "STAMP_CFLAGS := -std=c11 -O2\n"
        + "STAMP_SOURCES := landlock-guardian.c landlock-guardian.h\n",
    );
    writeRelative(tmpRoot, "guardian/landlock-guardian.c", "int main(void) { return 0; }\n");
    writeRelative(tmpRoot, "guardian/landlock-guardian.h", "#ifndef STUB_H\n#define STUB_H\n#endif\n");
    writeRelative(tmpRoot, "traceability/self-protection/guardian-spec-schema.json", '{"schema":"guardian-spec"}\n');
    // The spec-schema SOURCE pin (the module that decides guardian admission).
    writeRelative(tmpRoot, ROOT_POLICY.selfProtection.specSchemaSourcePath, "export const SCHEMA = 1;\n");
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

    // A binding whose TARGET is not in this fixture tree is not applicable
    // (the registry's own rule). The external-command bindings target
    // `src/architecture-manifest.ts`, which this fixture does not carry.
    const applicable = listAllBindings().filter((binding) => existsSync(join(tmpRoot, binding.targetPath)));
    const report = repairAllBindings(tmpRoot, { write: true });
    assert.equal(report.totalBindings, applicable.length + fixtureDigestBindings(tmpRoot).length);
    assert.ok(report.repairedCount > 0, `expected repairs, got ${report.repairedCount}`);
    assert.equal(report.errorCount, 0, `unexpected errors: ${report.results.map((r) => r.error).filter(Boolean).join(", ")}`);
    assert.equal(report.allMatch, true);

    const after = verifyAllBindings(tmpRoot);
    assert.equal(after.allMatch, true, `still mismatched: ${after.results.filter((r) => !r.matches).map((r) => r.id).join(", ")}`);
    assert.equal(after.matched, applicable.length);
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
 * ── EVERY PINNED SOURCE IS COMMITTED ──────────────────────────────────────
 *
 * A binding pins BYTES and compares them only when the file is present, so
 * the rule that the file is supposed to be there is checked separately: every
 * binding's source is in git's index. A build output (the bundle, the guardian
 * binary) is never pinned by a committed digest: the guardian is bound by a
 * stamp over its committed sources, and the bundle's digest rewrote a line of
 * root-policy.ts on every engine change and conflicted on nearly every merge
 * while nothing compared it at runtime (#221).
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
 * Bindings whose source git does not track. Every binding pins a COMMITTED
 * source: a build output is never pinned by a committed digest (#221), and an
 * untracked source is a clone that cannot verify itself. Pure over its two
 * inputs so a plant costs a synthetic binding and no mutation of the tree.
 */
function originViolations(
  bindings: readonly HashBinding[],
  isTracked: (path: string) => boolean,
): readonly string[] {
  return bindings
    .filter((binding) => !isTracked(binding.sourcePath))
    .map((binding) =>
      `${binding.id}: git does not track ${binding.sourcePath}; a clone cannot verify this pin, and a build ` +
      `output is never pinned in the tree (#221). Check \`git check-ignore -v ${binding.sourcePath}\`.`);
}

test("HashBindingRegistry: every binding pins a source git tracks (no build output is pinned in the tree)", () => {
  const tracked = gitTrackedPaths(ROOT);
  const bindings = listAllBindings();
  // LIVENESS — the covered population as runtime numbers.
  assert.ok(bindings.length >= 17, `binding population collapsed to ${bindings.length}`);
  assert.ok(tracked.size > 0, "git index read returned nothing");
  assert.deepEqual(originViolations(bindings, (p) => tracked.has(p)), []);
  assert.equal(bindings.some((binding) => binding.sourcePath === ROOT_POLICY.selfProtection.bundleRelativePath), false, "the bundle is a build output: no binding pins it");
});

test("HashBindingRegistry: the origin check reports a swallowed source", () => {
  // PLANTED FROM OUTSIDE, against the REAL git index: the synthetic binding
  // borrows a real path whose tracked-ness is a measured fact.
  const tracked = gitTrackedPaths(ROOT);
  const swallowed = "dist/bundle.js";
  const committed = engineModuleSourceRelative("root-policy.ts");
  assert.equal(tracked.has(swallowed), false, "fixture assumption: dist/bundle.js is not tracked");
  assert.equal(tracked.has(committed), true, `fixture assumption: ${committed} is tracked`);
  const template = listAllBindings()[0]!;
  const found = originViolations([{ ...template, id: "planted-swallowed", sourcePath: swallowed }], (p) => tracked.has(p));
  assert.equal(found.length, 1, found.join(" | "));
  assert.ok(found[0]!.includes("planted-swallowed"));
  assert.deepEqual(originViolations([{ ...template, id: "planted-committed", sourcePath: committed }], (p) => tracked.has(p)), [], "a committed source is silent");
});

test("HashBindingRegistry: a missing source names the way out (restore it from version control)", () => {
  // Driven at the real door: `computeBindingHash` over an empty root, where
  // every source is absent, the fresh-clone situation.
  const emptyRoot = createTempDir("hash-binding-absent-");
  try {
    const source = listAllBindings().find((binding) => binding.hashMode.kind !== "module-constant");
    assert.ok(source !== undefined, "no file-backed binding: this rule has no subject");
    assert.throws(
      () => computeBindingHash(emptyRoot, source),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error && error.code === "input_error" &&
        error.message.includes(source.sourcePath) &&
        error.message.includes("version control"),
      "a missing committed source says to restore it",
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

test("no README is a generated output, and the generated-output set is the same for every tree (#221)", () => {
  // A folder's consumers are the import graph's answer, never a committed list
  // every branch rewrites: a README is authored text, whatever it carries.
  const outputs = generatedOutputPaths();
  assert.deepEqual([...outputs].filter((path) => path === "README.md" || path.endsWith("/README.md") && path !== DECISION_INDEX.path), []);
  assert.deepEqual([...generatedOutputPaths()], [...outputs], "one set: it reads no tree");
});

test("the root ignore file's evidence block is a registered generated block and output: an edit inside it alone is generation-only (design M9)", () => {
  const outputs = generatedOutputPaths();
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
  const outputs = generatedOutputPaths();
  const targets = pinAuthorities().flatMap((authority) => [authority.targetPath, ...(authority.projection === undefined ? [] : [authority.projection.targetPath])]);
  assert.ok(targets.length >= 3, "the registry lists no authorities: the test has no subject");
  for (const target of targets) assert.ok(outputs.has(`engine/${target}`), `${target} is re-derived by sync but is not a generated output`);
});

/**
 * THE GUARDIAN'S TRUST ANCHOR IS A REPRODUCIBLE BUILD STAMP, NOT THE BINARY'S
 * BYTES.
 *
 * The old pin hashed the compiler's output, so the local and CI gcc sealed
 * different digests for the same sources and every CI run refused confinement.
 * The anchor is now the digest of the SEALED INPUTS (`build-stamp.spec`: the
 * source files and declared flags), computed by the owning module exactly as
 * the Makefile embeds it. `harness sync` rewrites the literal from that
 * computation; no compiler and no built binary is involved.
 *
 * The arms below prove: no binding hashes the built binary; the live pin and
 * the module's recomputation agree; the binding ignores the binary's bytes;
 * and a tampered source, a tampered pin and a removed pin each refuse, with
 * repair restoring the value from the sealed sources.
 */
test("the guardian anchor is a reproducible stamp over sealed sources with one check and a regeneration path", () => {
  const binding = findBinding("root-policy-self-protection-guardian-build-stamp");
  assert.equal(binding.sourcePath, ROOT_POLICY.selfProtection.buildStampSpecPath, "the source is the one sealed-inputs declaration");
  assert.equal(binding.targetPath, ROOT_POLICY.sourcePath, "the target is the root policy that carries the pin");
  assert.equal(binding.hashMode.kind, "module-constant", "the owning module computes the multi-file digest");
  assert.equal(
    "binarySha256" in ROOT_POLICY.selfProtection,
    false,
    "the compiler-built file's digest is not a trust anchor",
  );
  assert.equal(
    listAllBindings().some((entry) => entry.sourcePath === ROOT_POLICY.selfProtection.binaryRelativePath),
    false,
    "no binding may hash the compiler-built binary; its bytes are not reproducible",
  );
  assert.equal(
    "binarySha256Alternates" in ROOT_POLICY.selfProtection,
    false,
    "an alternate hash with no producer is a second trust anchor",
  );

  // THE LIVE CHECK: the committed pin is exactly the source tree's stamp.
  const live = verifyBinding(ROOT, binding);
  assert.equal(live.matches, true, `the committed stamp disagrees with the sealed sources: ${live.expected} != ${live.actual}`);
  assert.equal(computeBindingHash(ROOT, binding), computeGuardianBuildStamp(ROOT));
  assert.equal(computeGuardianBuildStamp(ROOT), ROOT_POLICY.selfProtection.binaryStamp);

  // TAMPER, BYTES-IRRELEVANCE, REMOVAL AND REGENERATION over planted inputs.
  const tmpRoot = makeTempRoot();
  try {
    const specRelative = ROOT_POLICY.selfProtection.buildStampSpecPath;
    writeRelative(
      tmpRoot,
      specRelative,
      "STAMP_FORMAT := bridlewise-guardian-build-stamp/v1\n"
        + "STAMP_CFLAGS := -std=c11 -O2\n"
        + "STAMP_SOURCES := landlock-guardian.c landlock-guardian.h\n",
    );
    writeRelative(tmpRoot, "guardian/landlock-guardian.c", "int main(void) { return 0; }\n");
    writeRelative(tmpRoot, "guardian/landlock-guardian.h", "#ifndef STUB_H\n#define STUB_H\n#endif\n");
    const target = join(tmpRoot, binding.targetPath);
    mkdirSync(join(tmpRoot, "src", "kernel"), { recursive: true });
    const firstStamp = computeGuardianBuildStamp(tmpRoot);
    writeFileSync(target, `export const P = { selfProtection: { binaryStamp: "${firstStamp}" } };\n`, "utf8");
    assert.equal(verifyBinding(tmpRoot, binding).matches, true, "control: the matching stamp is green");

    // THE BYTES ARE NOT THE ANCHOR: an arbitrary file at the binary's path
    // does not change the binding's answer.
    writeRelative(tmpRoot, ROOT_POLICY.selfProtection.binaryRelativePath, "not the compiler's output\n");
    assert.equal(verifyBinding(tmpRoot, binding).matches, true, "the built binary's bytes must not decide the binding");

    // A TAMPERED SOURCE changes the recomputed stamp and refuses the old pin.
    writeRelative(tmpRoot, "guardian/landlock-guardian.c", "int main(void) { return 1; }\n");
    assert.equal(verifyBinding(tmpRoot, binding).matches, false, "a source edit must move the stamp");

    // REGENERATION restores it from the sources (no compiler, no binary).
    const repaired = repairBinding(tmpRoot, binding);
    assert.equal(repaired.repaired, true, repaired.error ?? "repair must rewrite a stale stamp");
    const secondStamp = computeGuardianBuildStamp(tmpRoot);
    assert.equal(repaired.newHash, secondStamp);
    assert.equal(verifyBinding(tmpRoot, binding).matches, true, "after repair the pin matches the sealed sources");

    // A TAMPERED PIN refuses and is repaired from the sources.
    writeFileSync(
      target,
      `export const P = { selfProtection: { binaryStamp: "${"0".repeat(64)}" } };\n`,
      "utf8",
    );
    assert.equal(verifyBinding(tmpRoot, binding).matches, false, "a tampered pin must refuse");
    assert.equal(repairBinding(tmpRoot, binding).newHash, secondStamp);

    // A REMOVED literal is a refusal (sync has no literal to rewrite), never a
    // value conjured from nothing.
    writeFileSync(target, "export const P = { selfProtection: {} };\n", "utf8");
    const removed = verifyBinding(tmpRoot, binding);
    assert.equal(removed.matches, false, "a removed pin must refuse");
    assert.match(removed.error ?? "", /hash literal not found/u);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

const HEX_64_GLOBAL = /[0-9a-f]{64}/gu;

/** The literal offsets inside every declared `AUTHORED PIN` region of `text`. */
function authoredPinRanges(text: string): readonly Readonly<{ start: number; end: number }>[] {
  const ranges: Array<Readonly<{ start: number; end: number }>> = [];
  let from = 0;
  for (;;) {
    const opened = text.indexOf(AUTHORED_PIN_REGION.begin, from);
    if (opened < 0) return ranges;
    const closed = text.indexOf(AUTHORED_PIN_REGION.end, opened + AUTHORED_PIN_REGION.begin.length);
    assert.ok(closed > opened, "an AUTHORED PINS region is unterminated");
    const body = text.slice(opened, closed);
    for (const match of body.matchAll(HEX_64_GLOBAL)) {
      ranges.push({ start: opened + match.index!, end: opened + match.index! + match[0].length });
    }
    from = closed + AUTHORED_PIN_REGION.end.length;
  }
}

test("HashBindingRegistry: pin normalisation is owner-derived — a regenerated binding pin is generation-only, an authored root-policy pin is a source edit", () => {
  const policyPath = "engine/src/kernel/root-policy.ts";
  const policyText = readFileSync(join(ROOT, "src/kernel/root-policy.ts"), "utf8");
  const bound = bindingPinRanges("src/kernel/root-policy.ts", policyText);
  // Five since #221 took the bundle digest and the inventory and disposition copies out of the tree.
  assert.ok(bound.length >= 5, `root-policy must carry its registered binding pins, located ${bound.length}`);
  const replaceAt = (text: string, start: number, end: number, literal: string): string =>
    `${text.slice(0, start)}${literal}${text.slice(end)}`;
  const boundChange = replaceAt(policyText, bound[0]!.start, bound[0]!.end, "0".repeat(64));
  assert.equal(
    isGenerationOnlyChange(policyPath, policyText, boundChange),
    true,
    "a binding-owned pin restated by its generator is regeneration-only",
  );
  const authored = authoredPinRanges(policyText);
  assert.ok(authored.length >= 1, "root-policy must declare its authored refusal pins");
  const authoredChange = replaceAt(policyText, authored[0]!.start, authored[0]!.end, "0".repeat(64));
  assert.equal(
    isGenerationOnlyChange(policyPath, policyText, authoredChange),
    false,
    "a hand edit of an authored pin is a source edit, never an exempt regeneration",
  );
  // The blanket normaliser is gone: only the located literals are replaced.
  const stripped = stripRegeneratedPins(policyPath, policyText);
  assert.equal([...stripped.matchAll(/<regenerated-pin>/gu)].length, bound.length);
  assert.equal(
    [...stripped.matchAll(HEX_64_GLOBAL)].length,
    [...policyText.matchAll(HEX_64_GLOBAL)].length - bound.length,
    "every authored literal survives normalization",
  );
});

test("HashBindingRegistry: every 64-hex literal in a suite-regenerated or pin-authority TypeScript module is owner-derived or in a declared AUTHORED PINS region", () => {
  // The pin-authority modules are re-derived by the driver and are generated
  // outputs, but no registry binding targets them, so the old population (the
  // binding targets only) never looked at the literals inside them. A
  // `sha256:` value appended there in the pin field's shape was exempted from
  // every lease check and no guard saw it.
  const modules = [...new Set([
    ...suiteRegeneratedPaths(),
    ...Object.values(PIN_AUTHORITY_PATHS).map((path) => `engine/${path}`),
  ])]
    .filter((path) => path.startsWith("engine/") && path.endsWith(".ts") && !wholesaleGeneratedPaths().has(path));
  assert.ok(modules.length > 0, "the suite-regenerated module population came back empty — a guard over nothing certifies nothing");
  const pinAuthorityModules = Object.values(PIN_AUTHORITY_PATHS).filter((path) => path.endsWith(".ts"));
  assert.ok(pinAuthorityModules.length > 0, "no TypeScript pin authority is registered — the added population is empty");
  assert.ok(
    pinAuthorityModules.every((path) => modules.includes(`engine/${path}`)),
    "the guard population must include every registered pin-authority module",
  );
  for (const repositoryPath of modules) {
    const targetPath = repositoryPath.slice("engine/".length);
    const text = readFileSync(join(ROOT, targetPath), "utf8");
    // The owners' own locators: a binding's findRegex AND the pin-authority
    // driver's structural byte-pin reader.
    const ownedStarts = new Set(regeneratedPinRanges(targetPath, text).map((range) => range.start));
    const authoredStarts = new Set(authoredPinRanges(text).map((range) => range.start));
    for (const match of text.matchAll(HEX_64_GLOBAL)) {
      assert.ok(
        ownedStarts.has(match.index!) || authoredStarts.has(match.index!),
        `${repositoryPath}:64-hex literal ${match[0].slice(0, 12)}… at offset ${String(match.index)} is neither a registered binding pin nor inside an AUTHORED PINS region`,
      );
    }
  }
});

test("HashBindingRegistry: a pin-authority module's non-driver sha256 literal is an authored change, never an exempt regeneration", () => {
  const authority = pinAuthorities().find((entry) => !entry.testingOnly);
  assert.ok(authority, "no product pin authority is registered — the arm has no subject");
  const repositoryPath = `engine/${authority!.targetPath}`;
  const text = readFileSync(join(ROOT, authority!.targetPath), "utf8");
  // A REGENERATION-ONLY EDIT: one real byte-pin's digest restated.
  const driverOwned = regeneratedPinRanges(repositoryPath, text);
  assert.ok(driverOwned.length > 0, "the structural reader located no byte-pin in the registered authority");
  const pin = driverOwned[0]!;
  const restamped = `${text.slice(0, pin.start)}${"0".repeat(64)}${text.slice(pin.end)}`;
  assert.equal(
    isGenerationOnlyChange(repositoryPath, text, restamped),
    true,
    "a byte-pin the driver re-derives is a regeneration, not a source edit",
  );
  // THE DEFECT'S SHAPE: a `sha256:` literal with no path/byteLength sibling is
  // not a byte-pin. It must survive normalization and refuse the exemption.
  const injected = `${text}
export const SMUGGLED_SHA256 = { sha256: "${"a".repeat(64)}" } as const;
`;
  assert.equal(
    isGenerationOnlyChange(repositoryPath, text, injected),
    false,
    "an appended sha256 literal the driver does not own is an authored source edit",
  );
  assert.ok(
    stripRegeneratedPins(repositoryPath, injected).includes("a".repeat(64)),
    "an unowned sha256 literal must survive normalization",
  );
});

test("HashBindingRegistry: every published architecture external command's sourceSha256 is a derived, unique binding", () => {
  const manifestPath = "src/kernel/architecture-external-commands.ts";
  const manifest = readFileSync(join(ROOT, manifestPath), "utf8");
  const published = ARCHITECTURE_MANIFEST.externalCommands.filter((command) => command.publication === "published");
  // THE FLOOR IS THE PINNED POPULATION, not "at least one exists". The old
  // floor (`published.length > 0`) was satisfied by a set the same module had
  // just declared: flipping both helper defaults to `not-published` left it
  // with zero published commands, zero bindings and a green guard. The
  // authored population pin is a value those helpers cannot move, so the same
  // demotion now reds here.
  assert.equal(
    publishedExternalCommandPopulationHash(),
    PUBLISHED_EXTERNAL_COMMAND_POPULATION_SHA256,
    `the published external-command population (${String(published.length)} commands) moved off its authored pin. ` +
      "A demotion to not-published, a removal or an addition removes commands from verification; record the " +
      "deliberate population change in PUBLISHED_EXTERNAL_COMMAND_POPULATION_SHA256 with the command that moved.",
  );
  assert.ok(published.length > 0, "the manifest declares no published external command — this guard would be vacuous");
  const bindings = listAllBindings().filter((binding) => binding.targetPath === manifestPath);
  assert.equal(bindings.length, published.length, "one registry binding per published external command");
  for (const command of published) {
    const binding = bindings.find((entry) => entry.id === `architecture-external-command-${command.id}-source-sha256`);
    assert.ok(binding, `missing binding for ${command.path}`);
    const matches = [...manifest.matchAll(new RegExp(binding!.findRegex!, "gu"))];
    assert.equal(matches.length, 1, `${binding!.id} must locate exactly one literal`);
    assert.equal(matches[0]![0], command.sourceSha256, `${binding!.id} locates the declared pin`);
    assert.equal(computeBindingHash(ROOT, binding!), command.sourceSha256, `${binding!.id} is current against the source`);
  }
});

test("HashBindingRegistry: a published external command source edit reds its derived binding, and repair re-derives the declared pin", () => {
  const command = ARCHITECTURE_MANIFEST.externalCommands.find((entry) => entry.publication === "published");
  assert.ok(command, "the manifest must declare a published external command for this arm");
  const binding = listAllBindings().find((entry) => entry.id === `architecture-external-command-${command!.id}-source-sha256`);
  assert.ok(binding, "the command's pin must be a derived binding");
  const tmpRoot = makeTempRoot();
  try {
    const sourceBytes = "def main():\n    return 0\n";
    writeRelative(tmpRoot, command!.path, sourceBytes);
    writeRelative(
      tmpRoot,
      "src/kernel/architecture-external-commands.ts",
      `export const MANIFEST = { externalCommands: [\n  {\n    id: "${command!.id}",\n    path: "${command!.path}",\n    sourceSha256: "${command!.sourceSha256}",\n  },\n] };\n`,
    );
    const drifted = verifyBinding(tmpRoot, binding!);
    assert.equal(drifted.matches, false, "an edited source must red its binding");
    assert.equal(drifted.expected, sha256(sourceBytes), "the expected literal is the edited source's digest");
    assert.equal(drifted.actual, command!.sourceSha256, "the actual literal is the declared manifest pin");
    const repaired = repairBinding(tmpRoot, binding!);
    assert.equal(repaired.repaired, true, "the binding repair re-derives the pin");
    assert.ok(readFileSync(join(tmpRoot, "src/kernel/architecture-external-commands.ts"), "utf8").includes(sha256(sourceBytes)));
    assert.equal(verifyBinding(tmpRoot, binding!).matches, true, "the repaired pin matches the source");
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
