import assert from "node:assert/strict";
import { chmodSync, chownSync, cpSync, linkSync, lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { verifyS1Structure } from "../../scripts/tooling/s1-verification.ts";
import { loadPinnedConfigSnapshot } from "../../src/kernel/config.ts";
import { canonicalHash, sha256 } from "../../src/kernel/integrity.ts";
import { configContractArtifactText } from "../../src/kernel/config-contracts.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { ALIGNMENT_CONFIG_FIXTURE, makeRuntimeCandidate, removeOwnedTemporaryDirectories, invoke, invokeBootstrap, errorCode, writeConfig, config, appendCandidateSource, mutateCandidateTextExact, mutateTextExact, raceRuntime, candidateModulePath, REPOSITORY_ROOT } from "../support/s1-scenario-shared.ts";

const scenarios: Readonly<Record<string, () => void | Promise<void>>> = {
  "S1-B02-CONTROL": () => {
    const first = loadPinnedConfigSnapshot();
    const second = loadPinnedConfigSnapshot();
    assert.equal(first.canonicalHash, second.canonicalHash);
    assert.equal(first.sourceHash, second.sourceHash);
    assert.equal(first.source.path, join(REPOSITORY_ROOT, "bridlewise.config.json"));
    assert.equal(first.source.links, "1");
    assert.match(first.source.modifiedNanoseconds, /^\d+$/u);
    assert.match(first.source.parentEntriesHash, /^[0-9a-f]{64}$/u);
    assert.ok(Object.isFrozen(first.document.project));
    assert.equal(first.document.alignmentCheckpoint.cadence.maximumEventsBetweenCheckpoints, 50);
    assert.equal(first.document.alignmentCheckpoint.observerProfile, "deterministic-only");

    const nestedDependency = makeRuntimeCandidate();
    const nestedBin = join(nestedDependency, "verification", "probe", "node_modules", ".bin");
    mkdirSync(nestedBin, { recursive: true });
    writeFileSync(join(nestedDependency, "verification", "probe", "target"), "dependency tool\n");
    symlinkSync("../../target", join(nestedBin, "tool"));
    assert.equal(invoke(nestedDependency).status, 0);
  },
  "S1-B02-FAILURE": () => {
    const duplicate = makeRuntimeCandidate();
    writeConfig(duplicate, {}, '{"schemaVersion":2,"schemaVersion":2,"project":{"id":"s1-fixture","root":"."},"data":{"defaultClassification":"project-private"}}');
    assert.equal(errorCode(invoke(duplicate)), "config_key_duplicate");
    const writable = makeRuntimeCandidate();
    chmodSync(join(writable, "bridlewise.config.json"), 0o666);
    assert.equal(errorCode(invoke(writable)), "config_mode_insecure");

    const freshCheckout = makeRuntimeCandidate();
    const freshConfig = join(freshCheckout, "bridlewise.config.json");
    const unrelatedPath = join(freshCheckout, "unrelated.txt");
    const originalConfig = readFileSync(freshConfig);
    writeFileSync(unrelatedPath, "must remain unchanged\n", { mode: 0o664 });
    chmodSync(unrelatedPath, 0o664);
    chmodSync(freshConfig, 0o664);
    assert.equal(errorCode(invoke(freshCheckout)), "config_mode_insecure");
    const repaired = invokeBootstrap(freshCheckout);
    assert.equal(repaired.status, 0, repaired.stderr);
    assert.equal(repaired.stderr, "");
    assert.equal(
      repaired.stdout,
      '{"action":"bootstrap-config-permissions","requiredMode":"0600","result":"verified","schemaVersion":1}\n',
    );
    assert.equal(lstatSync(freshConfig).mode & 0o7777, 0o600);
    assert.deepEqual(readFileSync(freshConfig), originalConfig);
    assert.equal(lstatSync(unrelatedPath).mode & 0o7777, 0o664);
    assert.equal(readFileSync(unrelatedPath, "utf8"), "must remain unchanged\n");
    assert.equal(invoke(freshCheckout).status, 0);

    const alternate = makeRuntimeCandidate();
    mkdirSync(join(alternate, "test", "nested"), { recursive: true });
    writeFileSync(join(alternate, "test", "nested", "alternate.config.json"), "{}\n");
    assert.equal(errorCode(invoke(alternate)), "alternate_config_denied");
    const traversal = makeRuntimeCandidate();
    writeConfig(traversal, { ...config(), project: { id: "s1-fixture", root: "a/../b" } });
    assert.equal(errorCode(invoke(traversal)), "project_root_invalid");
    const weakenedAlignment = makeRuntimeCandidate();
    writeConfig(weakenedAlignment, {
      ...config(),
      alignmentCheckpoint: { ...(ALIGNMENT_CONFIG_FIXTURE as object), enabled: false },
    });
    assert.equal(errorCode(invoke(weakenedAlignment)), "config_schema_invalid");
    const unboundedAlignment = makeRuntimeCandidate();
    writeConfig(unboundedAlignment, {
      ...config(),
      alignmentCheckpoint: {
        ...(ALIGNMENT_CONFIG_FIXTURE as Record<string, unknown>),
        cadence: {
          ...((ALIGNMENT_CONFIG_FIXTURE as { cadence: Record<string, unknown> }).cadence),
          maximumEventsBetweenCheckpoints: 10_001,
        },
      },
    });
    assert.equal(errorCode(invoke(unboundedAlignment)), "config_schema_invalid");

    const sourceDrift = makeRuntimeCandidate();
    appendCandidateSource(sourceDrift, candidateModulePath("config-contracts.ts"), "// stale source-hash mutant");
    // Exact projection of the config-contract family: a pristine candidate must
    // project its root policy, so ONLY the appended source byte may drift.
    assert.deepEqual(
      verifyS1Structure(sourceDrift).violations.filter((violation) => violation.startsWith("config-contract-")),
      ["config-contract-source-hash"],
      "a pristine candidate must project its root policy; only the appended source byte may drift",
    );

    const artifactFramingDrift = makeRuntimeCandidate();
    const artifactFramingPath = join(
      artifactFramingDrift,
      ROOT_POLICY.configuration.contract.generatedSchemaPath,
    );
    writeFileSync(artifactFramingPath, `${readFileSync(artifactFramingPath, "utf8")} `);
    assert.ok(verifyS1Structure(artifactFramingDrift).violations.includes(
      "config-contract-artifact-drift",
    ));

    const coherentArtifactWidening = makeRuntimeCandidate();
    const coherentArtifactPath = join(
      coherentArtifactWidening,
      ROOT_POLICY.configuration.contract.generatedSchemaPath,
    );
    const coherentArtifact = JSON.parse(readFileSync(coherentArtifactPath, "utf8")) as {
      schema: { properties: { contracts: { properties: { limits: { properties: {
        maximumEvents: { maximum?: number };
      } } } } } };
      schemaHash: string;
      identity: { schemaHash: string };
      identityHash: string;
    };
    const maximumEventsDefinition = coherentArtifact.schema.properties.contracts.properties.limits
      .properties.maximumEvents;
    assert.notEqual(maximumEventsDefinition?.maximum, undefined);
    assert.equal(maximumEventsDefinition!.maximum, ROOT_POLICY.contracts.limits.maximumEvents);
    maximumEventsDefinition!.maximum = ROOT_POLICY.contracts.limits.maximumEvents + 1;
    coherentArtifact.schemaHash = canonicalHash(coherentArtifact.schema);
    coherentArtifact.identity.schemaHash = coherentArtifact.schemaHash;
    coherentArtifact.identityHash = canonicalHash(coherentArtifact.identity);
    writeFileSync(coherentArtifactPath, configContractArtifactText(coherentArtifact));
    assert.ok(verifyS1Structure(coherentArtifactWidening).violations.includes(
      "config-contract-artifact-drift",
    ));

    const mutateRootPolicy = (root: string, before: string, after: string): void => {
      mutateCandidateTextExact(root, ROOT_POLICY.sourcePath, before, after, "B02 root-policy mutant");
    };
    const lexicalCandidate = makeRuntimeCandidate();
    const lexicalPath = candidateModulePath("lexical-policy.ts");
    const originalLexical = readFileSync(join(lexicalCandidate, lexicalPath), "utf8");
    assert.equal(verifyS1Structure(lexicalCandidate).violations.includes("config-contract-lexical-policy-projection"), false);
    // Metadata equality cannot certify current bytes, including when a
    // candidate was copied to another root. Judge every shape independently.
    const lexicalAbsolute = join(lexicalCandidate, lexicalPath);
    const lexicalMode = lstatSync(lexicalAbsolute).mode & 0o7777;
    const lexicalTime = Math.floor(lstatSync(lexicalAbsolute).mtimeMs / 1000);
    const changedLexical = mutateTextExact(originalLexical, "maximumInputs: 4096", "maximumInputs: 4097", "same-length lexical edit");
    assert.equal(Buffer.byteLength(changedLexical), Buffer.byteLength(originalLexical));
    const restoreLexical = (): void => {
      writeFileSync(lexicalAbsolute, originalLexical);
      chmodSync(lexicalAbsolute, lexicalMode);
      utimesSync(lexicalAbsolute, lexicalTime, lexicalTime);
    };
    restoreLexical();
    const lexicalControl = verifyS1Structure(lexicalCandidate);
    const freshnessOutcomes: Array<{ shape: string; changedManifest: boolean; refused: boolean; restored: boolean }> = [];
    for (const shape of ["in-place", "atomic replacement", "different root"] as const) {
      let candidate = lexicalCandidate;
      try {
        if (shape === "different root") candidate = makeRuntimeCandidate();
        const target = join(candidate, lexicalPath);
        const before = lstatSync(target);
        const output = shape === "atomic replacement" ? `${target}.replacement` : target;
        writeFileSync(output, changedLexical);
        chmodSync(output, lexicalMode);
        utimesSync(output, lexicalTime, lexicalTime);
        if (shape === "atomic replacement") renameSync(output, target);
        const after = lstatSync(target);
        assert.equal(after.size, Buffer.byteLength(originalLexical));
        assert.equal(after.mtimeMs, lexicalTime * 1000);
        if (shape === "atomic replacement") assert.notEqual(after.ino, before.ino);
        else assert.equal(after.ino, before.ino);
        const result = verifyS1Structure(candidate);
        freshnessOutcomes.push({ shape, changedManifest: result.repositoryManifestHash !== lexicalControl.repositoryManifestHash,
          refused: result.violations.includes("config-contract-lexical-policy-projection"), restored: false });
      } finally { restoreLexical(); }
      freshnessOutcomes.at(-1)!.restored = verifyS1Structure(lexicalCandidate).repositoryManifestHash === lexicalControl.repositoryManifestHash;
    }
    let modeManifestChanged = false;
    try {
      chmodSync(lexicalAbsolute, lexicalMode ^ 0o100);
      assert.equal(lstatSync(lexicalAbsolute).mtimeMs, lexicalTime * 1000);
      modeManifestChanged = verifyS1Structure(lexicalCandidate).repositoryManifestHash !== lexicalControl.repositoryManifestHash;
    } finally { restoreLexical(); }
    assert.deepEqual({ freshnessOutcomes, modeManifestChanged }, {
      freshnessOutcomes: freshnessOutcomes.map(({ shape }) => ({ shape, changedManifest: true, refused: true, restored: true })),
      modeManifestChanged: true,
    }, "current safe bytes and physical mode govern every verification snapshot");
    assert.equal(verifyS1Structure(lexicalCandidate).repositoryManifestHash, lexicalControl.repositoryManifestHash);
    for (const [before, after] of [
      ["maximumInputs: 4096", "maximumInputs: 4097"],
      ["Object.freeze({", "({"],
    ]) {
      mutateCandidateTextExact(lexicalCandidate, lexicalPath, before!, after!, "B02 lexical policy mutant");
      assert.ok(verifyS1Structure(lexicalCandidate).violations.includes("config-contract-lexical-policy-projection"), "actual candidate lexical bytes and immutability must be checked");
      writeFileSync(join(lexicalCandidate, lexicalPath), originalLexical);
      assert.equal(verifyS1Structure(lexicalCandidate).violations.includes("config-contract-lexical-policy-projection"), false);
    }
    const lexicalImport = makeRuntimeCandidate();
    mutateRootPolicy(lexicalImport, 'from "./lexical-policy.ts"', 'from "./other-policy.ts"');
    assert.ok(verifyS1Structure(lexicalImport).violations.includes("config-contract-root-policy-projection"), "the lexical binding must come from its canonical import");

    // The actual candidate projection must refuse erased bindings at BOTH
    // import boundaries. Other candidate violations are not this refusal;
    // retain the unchanged leaf control and restore after every source edit.
    const runtimeImports = makeRuntimeCandidate();
    const runtimePolicyPath = join(runtimeImports, ROOT_POLICY.sourcePath);
    const runtimePolicy = readFileSync(runtimePolicyPath, "utf8");
    const importControl = verifyS1Structure(runtimeImports).violations;
    assert.equal(importControl.includes("config-contract-root-policy-projection"), false);
    assert.equal(importControl.includes("config-contract-lexical-policy-projection"), false);
    const importOutcomes: Array<{ name: string; rootRefused: boolean; leafRefused: boolean }> = [];
    for (const [name, before, after] of [
      ["lexical type declaration", 'import { LEXICAL_REUSE_LIMITS }', 'import type { LEXICAL_REUSE_LIMITS }'],
      ["lexical type specifier", 'import { LEXICAL_REUSE_LIMITS }', 'import { type LEXICAL_REUSE_LIMITS }'],
      ["freezer type declaration", 'import { canonicalHash, deepFreeze, type CanonicalValue }', 'import { canonicalHash, type CanonicalValue } from "./integrity.ts";\nimport type { deepFreeze }'],
      ["freezer type specifier", 'import { canonicalHash, deepFreeze, type CanonicalValue }', 'import { canonicalHash, type deepFreeze, type CanonicalValue }'],
      ["lexical alias", 'import { LEXICAL_REUSE_LIMITS }', 'import { LEXICAL_REUSE_LIMITS as renamed }'],
      ["lexical namespace", 'import { LEXICAL_REUSE_LIMITS }', 'import * as LEXICAL_REUSE_LIMITS'],
      ["lexical default", 'import { LEXICAL_REUSE_LIMITS }', 'import LEXICAL_REUSE_LIMITS'],
      ["freezer alias", 'canonicalHash, deepFreeze, type CanonicalValue', 'canonicalHash, deepFreeze as renamed, type CanonicalValue'],
      ["freezer namespace", 'import { canonicalHash, deepFreeze, type CanonicalValue }', 'import { canonicalHash, type CanonicalValue } from "./integrity.ts";\nimport * as deepFreeze'],
      ["freezer wrong source", 'import { canonicalHash, deepFreeze, type CanonicalValue } from "./integrity.ts";', 'import { canonicalHash, type CanonicalValue } from "./integrity.ts";\nimport { deepFreeze } from "./other-integrity.ts";'],
      ["lexical import attribute", 'from "./lexical-policy.ts";', 'from "./lexical-policy.ts" with { type: "json" };'],
      ["freezer import attribute", 'import { canonicalHash, deepFreeze, type CanonicalValue } from "./integrity.ts";', 'import { canonicalHash, type CanonicalValue } from "./integrity.ts";\nimport { deepFreeze } from "./integrity.ts" with { type: "json" };'],
    ] as const) {
      try {
        writeFileSync(runtimePolicyPath, mutateTextExact(runtimePolicy, before, after, name));
        const violations = verifyS1Structure(runtimeImports).violations;
        importOutcomes.push({ name, rootRefused: violations.includes("config-contract-root-policy-projection"), leafRefused: violations.includes("config-contract-lexical-policy-projection") });
      } finally { writeFileSync(runtimePolicyPath, runtimePolicy); }
      assert.deepEqual(verifyS1Structure(runtimeImports).violations, importControl, `${name}: exact-restored candidate control`);
    }
    assert.deepEqual(importOutcomes,
      importOutcomes.map(({ name }) => ({ name, rootRefused: true, leafRefused: false })),
      "both runtime import boundaries refuse invalid authority while the canonical leaf stays unchanged");

    const rootPinWidening = makeRuntimeCandidate();
    mutateRootPolicy(
      rootPinWidening,
      `sourceSha256: ${JSON.stringify(ROOT_POLICY.configuration.contract.sourceSha256)}`,
      `sourceSha256: ${JSON.stringify("0".repeat(64))}`,
    );
    assert.ok(verifyS1Structure(rootPinWidening).violations.includes(
      "config-contract-root-policy-projection",
    ));

    for (const [name, before, after] of [
      [
        "widened",
        `maximumProtocolIdentifiers: ${ROOT_POLICY.configuration.contract.compilerLimits.maximumProtocolIdentifiers}`,
        `maximumProtocolIdentifiers: ${ROOT_POLICY.configuration.contract.compilerLimits.maximumProtocolIdentifiers + 1}`,
      ],
      [
        "missing",
        `        maximumProtocolIdentifiers: ${ROOT_POLICY.configuration.contract.compilerLimits.maximumProtocolIdentifiers},\n`,
        "",
      ],
    ] as const) {
      const compilerLimitMutant = makeRuntimeCandidate();
      mutateRootPolicy(compilerLimitMutant, before, after);
      assert.ok(verifyS1Structure(compilerLimitMutant).violations.includes(
        "config-contract-root-policy-projection",
      ), name);
    }

    const coordinatedManualMutation = makeRuntimeCandidate();
    const coordinatedSourcePath = join(coordinatedManualMutation, candidateModulePath("config-contracts.ts"));
    const coordinatedSource = mutateTextExact(
      readFileSync(coordinatedSourcePath, "utf8"),
      "const POLICY_STRING = z.string().min(1);",
      "const POLICY_STRING = z.string().min(0);",
      "B02 coordinated config-source mutant",
    );
    writeFileSync(coordinatedSourcePath, coordinatedSource);
    const coordinatedSourceSha256 = sha256(Buffer.from(coordinatedSource));
    mutateRootPolicy(
      coordinatedManualMutation,
      `sourceSha256: ${JSON.stringify(ROOT_POLICY.configuration.contract.sourceSha256)}`,
      `sourceSha256: ${JSON.stringify(coordinatedSourceSha256)}`,
    );
    const coordinatedArtifactPath = join(
      coordinatedManualMutation,
      ROOT_POLICY.configuration.contract.generatedSchemaPath,
    );
    const coordinatedArtifact = JSON.parse(readFileSync(coordinatedArtifactPath, "utf8")) as {
      sourceSha256: string;
      identity: { sourceSha256: string };
      identityHash: string;
    };
    coordinatedArtifact.sourceSha256 = coordinatedSourceSha256;
    coordinatedArtifact.identity.sourceSha256 = coordinatedSourceSha256;
    coordinatedArtifact.identityHash = canonicalHash(coordinatedArtifact.identity);
    writeFileSync(coordinatedArtifactPath, configContractArtifactText(coordinatedArtifact));
    const coordinatedViolations = verifyS1Structure(coordinatedManualMutation).violations;
    assert.ok(coordinatedViolations.includes("config-contract-root-policy-projection"));
    assert.equal(coordinatedViolations.includes("config-contract-source-hash"), false);
  },
  "S1-B02-HOSTILE-REAL": async () => {
    const setupLinked = makeRuntimeCandidate();
    const setupLinkedConfig = join(setupLinked, "bridlewise.config.json");
    chmodSync(setupLinkedConfig, 0o664);
    renameSync(setupLinkedConfig, `${setupLinkedConfig}.real`);
    symlinkSync(`${setupLinkedConfig}.real`, setupLinkedConfig);
    const linkedSetup = invokeBootstrap(setupLinked);
    assert.equal(errorCode(linkedSetup), "bootstrap_config_invalid");
    assert.equal(linkedSetup.stdout, "");
    assert.equal(
      linkedSetup.stderr,
      '{"action":"bootstrap-config-permissions","error":"bootstrap_config_invalid","result":"denied","schemaVersion":1}\n',
    );
    assert.equal(lstatSync(`${setupLinkedConfig}.real`).mode & 0o7777, 0o664);
    assert.doesNotMatch(linkedSetup.stderr, new RegExp(setupLinked));

    const setupForeignOwner = makeRuntimeCandidate();
    const setupForeignConfig = join(setupForeignOwner, "bridlewise.config.json");
    const foreignGroup = process.getgroups!().find((group) => group !== process.getgid!());
    assert.notEqual(foreignGroup, undefined, "bootstrap owner fixture requires a supplementary group");
    chmodSync(setupForeignConfig, 0o664);
    chownSync(setupForeignConfig, process.getuid!(), foreignGroup!);
    assert.equal(errorCode(invokeBootstrap(setupForeignOwner)), "bootstrap_owner_mismatch");
    assert.equal(lstatSync(setupForeignConfig).mode & 0o7777, 0o664);

    const setupPathOverride = makeRuntimeCandidate();
    const setupPathConfig = join(setupPathOverride, "bridlewise.config.json");
    chmodSync(setupPathConfig, 0o664);
    assert.equal(
      errorCode(invokeBootstrap(setupPathOverride, ["--root", "/tmp/attacker-selected-root"])),
      "bootstrap_arguments_invalid",
    );
    assert.equal(lstatSync(setupPathConfig).mode & 0o7777, 0o664);
    // The CLI refuses the insecure document before any command runs (a refused
    // configuration is never "proceed unprotected"), and it does not repair it.
    assert.equal(errorCode(invoke(setupPathOverride, ["bootstrap-permissions"])), "config_mode_insecure");
    assert.equal(lstatSync(setupPathConfig).mode & 0o7777, 0o664);
    // With a document it accepts, the permission bootstrap is still not a CLI command.
    chmodSync(setupPathConfig, 0o600);
    assert.equal(errorCode(invoke(setupPathOverride, ["bootstrap-permissions"])), "command_unavailable");

    const linked = makeRuntimeCandidate();
    const configPath = join(linked, "bridlewise.config.json");
    renameSync(configPath, `${configPath}.real`);
    symlinkSync(`${configPath}.real`, configPath);
    assert.equal(errorCode(invoke(linked)), "repository_symlink_denied");

    const hardlinked = makeRuntimeCandidate();
    const hardConfig = join(hardlinked, "bridlewise.config.json");
    renameSync(hardConfig, `${hardConfig}.real`);
    linkSync(`${hardConfig}.real`, hardConfig);
    assert.equal(errorCode(invoke(hardlinked)), "config_hardlink_denied");

    const rewriting = makeRuntimeCandidate();
    const rewritePath = join(rewriting, "bridlewise.config.json");
    const left = `${JSON.stringify(config("fixture-left"))}${" ".repeat(50_000)}\n`;
    const right = `${JSON.stringify(config("fixture-rght"))}${" ".repeat(50_000)}\n`;
    assert.equal(left.length, right.length);
    let toggle = false;
    const rewritten = await raceRuntime(rewriting, () => {
      const replacement = `${rewritePath}.replacement`;
      writeFileSync(replacement, toggle ? left : right, { mode: 0o600 });
      renameSync(replacement, rewritePath);
      toggle = !toggle;
    });
    assert.notEqual(rewritten.status, 0, "same-size replacement race unexpectedly passed");

    const substituting = makeRuntimeCandidate();
    const trace = join(substituting, "traceability");
    const alternate = join(substituting, "traceability.alternate");
    cpSync(trace, alternate, { recursive: true });
    const swapped = await raceRuntime(substituting, () => {
      const temporary = join(substituting, "traceability.swap");
      renameSync(trace, temporary);
      renameSync(alternate, trace);
      renameSync(temporary, alternate);
    });
    assert.notEqual(swapped.status, 0, "directory substitution race unexpectedly passed");
  },
};

for (const scenarioId of Object.keys(scenarios).toSorted()) {
  test(scenarioId, scenarios[scenarioId]!);
}

test.afterEach(removeOwnedTemporaryDirectories);
test.after(removeOwnedTemporaryDirectories);
