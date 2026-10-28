import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { buildCandidateManifest, CANDIDATE_MANIFEST_SCHEMA_VERSION } from "../../scripts/verification/candidate-manifest.ts";
import { analyzeStaticSource, verifyS1Structure } from "../../scripts/tooling/s1-verification.ts";
import { buildTestInventory, discoverTestNames, recoverTestInventoryTransaction, testInventoryEntryIdentity, testInventoryIdentity, writeTestInventoryTransaction } from "../../scripts/test-inventory.ts";
import { createTestReceipt, createTestResultReceipt, validateTestReceipt } from "../../scripts/tooling/test-receipt.ts";
import { artifactAdmissionViolations, buildArtifactAdmissionManifest } from "../../scripts/tooling/verification/artifact-admission.ts";
import { createTestSurfaceDispositionManifest } from "../../scripts/verification/test-surface.ts";
import { canonicalHash, canonicalJson, sha256 } from "../../src/kernel/integrity.ts";
import { VERIFICATION_PATHS } from "../../src/kernel/verification-paths.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { createCanonicalNodeTestInventoryFixture } from "../support/test-inventory-fixture.ts";
import { makeRuntimeCandidate, createOwnedTemporaryDirectory, removeOwnedTemporaryDirectories, appendCandidateSource, registeredOpenArchitectureDiagnostics, isMovingProjectionDiagnostic, isUnavailableCapabilityDiagnostic, isPendingArchitectureRefactor, REPOSITORY_ROOT } from "../support/s1-scenario-shared.ts";
import { journalPathFor } from "../../src/filesystem/journaled-commit.ts";

const scenarios: Readonly<Record<string, () => void | Promise<void>>> = {
  "S1-B08-CONTROL": () => {
    const result = verifyS1Structure(REPOSITORY_ROOT);
    const openFindingDiagnostics = result.violations.filter((diagnostic) =>
      diagnostic.startsWith("architecture-open-blocking-finding:")
    );
    assert.deepEqual(openFindingDiagnostics, registeredOpenArchitectureDiagnostics());
    const movingProjectionDiagnostics = result.violations.filter(isMovingProjectionDiagnostic);
    const unavailableCapabilityDiagnostics = result.violations.filter(isUnavailableCapabilityDiagnostic);
    const pendingArchitectureRefactorDiagnostics = result.violations.filter(isPendingArchitectureRefactor);
    const classifiedDiagnostics = new Set([
      ...openFindingDiagnostics,
      ...movingProjectionDiagnostics,
      ...unavailableCapabilityDiagnostics,
      ...pendingArchitectureRefactorDiagnostics,
    ]);
    assert.deepEqual(
      result.violations.filter((diagnostic) => !classifiedDiagnostics.has(diagnostic)),
      [],
      "baseline diagnostics must be registered findings, moving projections, unavailable capabilities, or pending architecture refactor",
    );
    assert.ok(movingProjectionDiagnostics.length > 0, "moving projections must remain visible until regeneration");
    const authorityGraphUnavailable =
      ROOT_POLICY.universalPolicyArchitecture.authorityOwnershipGraph.available === false &&
      openFindingDiagnostics.includes(
        "architecture-open-blocking-finding:FOUNDATION-006-universal-authority-graph-unavailable",
      );
    assert.equal(authorityGraphUnavailable, true);
    assert.ok(unavailableCapabilityDiagnostics.some((diagnostic) =>
      diagnostic.startsWith("architecture-effect-") || diagnostic.startsWith("governed-")
    ));
    const historicalAccessUnavailable =
      ROOT_POLICY.productBoundary.historicalResearchAccessControl.realHistoryAccessAvailable === false &&
      openFindingDiagnostics.includes(
        "architecture-open-blocking-finding:SEC-001-runbook-search-scope-exposure",
      );
    assert.equal(historicalAccessUnavailable, true);
    assert.ok(unavailableCapabilityDiagnostics.some((diagnostic) =>
      diagnostic.startsWith("standalone-product-boundary-")
    ));
    assert.equal(result.ok, false);
    assert.match(result.repositoryManifestHash, /^[0-9a-f]{64}$/u);
    const manifest = buildCandidateManifest(REPOSITORY_ROOT);
    assert.equal(manifest.schemaVersion, CANDIDATE_MANIFEST_SCHEMA_VERSION);
    assert.equal(manifest.command, "node scripts/candidate-manifest.ts --root .");
    assert.match(manifest.semanticTreeHash, /^[0-9a-f]{64}$/u);
    assert.match(manifest.formatVerificationHash, /^[0-9a-f]{64}$/u);
    assert.match(manifest.workspace.stateHash, /^[0-9a-f]{64}$/u);
    assert.ok(manifest.files.some((entry) => entry.path === "scripts/tooling/bootstrap-permissions.ts"));
    assert.ok(manifest.files.some((entry) => entry.path === "bridlewise.config.json"));

    const shadowRoot = makeRuntimeCandidate();
    const baselineViolations = new Set(verifyS1Structure(shadowRoot).violations);
    appendCandidateSource(shadowRoot, "src/cli.ts", [
      "function safeProcessShadow(process: { getBuiltinModule(value: string }): string {",
      '  return process.getBuiltinModule("safe");',
      "}",
      "void safeProcessShadow;",
    ].join("\n"));
    const shadowViolations = verifyS1Structure(shadowRoot).violations
      .filter((entry) => !baselineViolations.has(entry));
    assert.equal(shadowViolations.some((entry) => entry.startsWith("environment-")), false);
    assert.equal(shadowViolations.some((entry) => entry.includes("process.getBuiltinModule")), false);
  },
  "S1-B08-FAILURE": () => {
    const fixtureRoot = join(REPOSITORY_ROOT, "test", "fixtures", "s1-verifier");
    const moduleFixtures = [
      ["direct-import.fixture", "direct-import"],
      ["re-export.fixture", "re-export"],
      ["re-export-star.fixture", "re-export"],
      ["dynamic-import.fixture", "dynamic-import"],
      ["direct-require.fixture", "require"],
    ] as const;
    for (const [fixture, kind] of moduleFixtures) {
      const fixtureSource = readFileSync(join(fixtureRoot, fixture), "utf8");
      const analysis = analyzeStaticSource(fixtureSource, "fixture.ts");
      assert.deepEqual(analysis.moduleAcquisitions, [{ kind, specifier: "./denied.ts" }]);
      const isolated = makeRuntimeCandidate();
      const isolatedCli = join(isolated, "src", "cli.ts");
      writeFileSync(isolatedCli, `${readFileSync(isolatedCli, "utf8")}\n${fixtureSource}`);
      assert.ok(verifyS1Structure(isolated).violations.some((violation) =>
        violation.startsWith("production-relative-import-denied:")
      ));
    }
    const bufferFrom = analyzeStaticSource(readFileSync(
      join(fixtureRoot, "export-buffer-from.fixture"),
      "utf8",
    ), "fixture.ts");
    assert.deepEqual(bufferFrom.moduleAcquisitions, []);
    assert.equal(bufferFrom.unmodeledModuleAcquisition, false);
    const environmentFixtures = [
      ["env-dot.fixture", "process.env.NAME"],
      ["env-bracket.fixture", "process.env['NAME']"],
      ["env-process-bracket.fixture", "process['env']"],
    ] as const;
    for (const [fixture, form] of environmentFixtures) {
      const fixtureSource = readFileSync(join(fixtureRoot, fixture), "utf8");
      const analysis = analyzeStaticSource(fixtureSource, "fixture.ts");
      assert.equal(analysis.environmentAcquisitions.length, 1);
      assert.equal(analysis.environmentAcquisitions[0]!.form, form);
      assert.equal(analysis.unmodeledEnvironmentAccess, false);
      const isolated = makeRuntimeCandidate();
      const isolatedCli = join(isolated, "src", "cli.ts");
      writeFileSync(isolatedCli, `${readFileSync(isolatedCli, "utf8")}\n${fixtureSource}`);
      assert.ok(verifyS1Structure(isolated).violations.includes("environment-configuration-source:cli.ts"));
    }
    const aliasSource = readFileSync(join(fixtureRoot, "env-alias-unmodeled.fixture"), "utf8");
    const alias = analyzeStaticSource(aliasSource, "fixture.ts");
    assert.equal(alias.environmentAcquisitions.length, 0);
    assert.equal(alias.unmodeledEnvironmentAccess, true);
    const aliasRoot = makeRuntimeCandidate();
    const aliasCli = join(aliasRoot, "src", "cli.ts");
    writeFileSync(aliasCli, `${readFileSync(aliasCli, "utf8")}\n${aliasSource}`);
    assert.ok(verifyS1Structure(aliasRoot).violations.includes("environment-configuration-source:cli.ts"));

    const computedEnvironmentRoot = makeRuntimeCandidate();
    appendCandidateSource(computedEnvironmentRoot, "src/cli.ts", [
      "const globalAlias = globalThis;",
      'const processAlias = globalAlias["pro" + "cess"];',
      'const environmentAlias = processAlias["e" + "nv"];',
      'void environmentAlias["HARNESS" + "_TOKEN"];',
    ].join("\n"));
    assert.ok(verifyS1Structure(computedEnvironmentRoot).violations.includes(
      "environment-configuration-source:cli.ts",
    ));

    const unknownEnvironmentRoot = makeRuntimeCandidate();
    appendCandidateSource(unknownEnvironmentRoot, "src/cli.ts", [
      "const unknownEnvironmentKey = String(Date.now());",
      "void process.env[unknownEnvironmentKey];",
    ].join("\n"));
    assert.ok(verifyS1Structure(unknownEnvironmentRoot).violations.includes(
      "environment-acquisition-unmodeled:cli.ts",
    ));
    const moduleAliasSource = readFileSync(join(fixtureRoot, "module-alias-unmodeled.fixture"), "utf8");
    const moduleAlias = analyzeStaticSource(moduleAliasSource, "fixture.ts");
    assert.equal(moduleAlias.moduleAcquisitions.length, 0);
    assert.equal(moduleAlias.unmodeledModuleAcquisition, true);
    const moduleAliasRoot = makeRuntimeCandidate();
    const moduleAliasCli = join(moduleAliasRoot, "src", "cli.ts");
    writeFileSync(moduleAliasCli, `${readFileSync(moduleAliasCli, "utf8")}\n${moduleAliasSource}`);
    assert.ok(verifyS1Structure(moduleAliasRoot).violations.includes("module-acquisition-unmodeled:cli.ts"));

    const s2IdentityDrift = makeRuntimeCandidate();
    const s2TracePath = join(s2IdentityDrift, "traceability", "s2.json");
    const s2Trace = JSON.parse(readFileSync(s2TracePath, "utf8")) as {
      contracts: { contractBundleHash: string };
    };
    s2Trace.contracts.contractBundleHash = "0".repeat(64);
    writeFileSync(s2TracePath, `${JSON.stringify(s2Trace)}\n`);
    assert.ok(verifyS1Structure(s2IdentityDrift).violations.includes("s2-contract-identity-mismatch"));

    const s2ArtifactDrift = makeRuntimeCandidate();
    const s2ArtifactPath = join(s2ArtifactDrift, "traceability", "s2-contract-schemas.json");
    writeFileSync(s2ArtifactPath, `${readFileSync(s2ArtifactPath, "utf8")} `);
    assert.ok(verifyS1Structure(s2ArtifactDrift).violations.includes("s2-contract-artifact-drift"));

    const s2FixtureDrift = makeRuntimeCandidate();
    const s2FixturePath = join(
      s2FixtureDrift,
      "test",
      "fixtures",
      "s2",
      "b06-fail-closed",
      "duplicate-json-key.json",
    );
    writeFileSync(s2FixturePath, `${readFileSync(s2FixturePath, "utf8")} `);
    assert.ok(verifyS1Structure(s2FixtureDrift).violations.some((violation) =>
      violation.startsWith("s2-fixture-hash-mismatch:")
    ));

    const root = makeRuntimeCandidate();
    mkdirSync(join(root, "deep", "nested"), { recursive: true });
    writeFileSync(join(root, "deep", "nested", "other.config.json"), "{}\n");
    writeFileSync(join(root, "src", "store.ts"), "export const Store = true;\n");
    const cliPath = join(root, "src", "cli.ts");
    writeFileSync(cliPath, `${readFileSync(cliPath, "utf8")}\nprocess.env.SECRET; process.env['OTHER'];\n`);
    const packagePath = join(root, "package.json");
    const packageDocument = JSON.parse(readFileSync(packagePath, "utf8")) as Record<string, unknown>;
    packageDocument.exports = { ".": "./src/store.ts", "./store": "./src/store.ts" };
    writeFileSync(packagePath, `${JSON.stringify(packageDocument)}\n`);
    const result = verifyS1Structure(root);
    assert.equal(result.ok, false);
    assert.ok(result.violations.includes("single-pinned-config-document"));
    assert.ok(result.violations.includes("forbidden-production-source:store.ts"));
    assert.ok(result.violations.includes("environment-configuration-source:cli.ts"));
    assert.ok(result.violations.includes("package-export-surface"));
  },
  "S1-B08-HOSTILE-REAL": () => {
    const inventory = createCanonicalNodeTestInventoryFixture({
      sourceId: "test/s1-scenarios/b08.test.ts",
      sourceHash: sha256(readFileSync(join(REPOSITORY_ROOT, "test", "s1-scenarios", "b08.test.ts"))),
      name: "S1-B08-HOSTILE-REAL",
    }).inventory;
    const ids = inventory.tests.map((entry) => entry.id);
    const counts = {
      discovered: inventory.tests.length,
      passed: inventory.tests.length,
      failed: 0,
      skipped: 0,
      todo: 0,
      cancelled: 0,
    };
    const candidateIdentity = {
      manifestSchemaVersion: CANDIDATE_MANIFEST_SCHEMA_VERSION,
      formatPolicyRevision: "candidate-format/v1",
      semanticTreeHash: "0".repeat(64),
      formatVerificationHash: "1".repeat(64),
    } as const;
    const validShape = createTestReceipt(candidateIdentity, inventory, ids, ids, counts);
    const validRun = createTestResultReceipt(validShape, {
      eventCount: 1,
      successful: true,
      counts: {
        tests: inventory.tests.length,
        failed: 0,
        passed: inventory.tests.length,
        cancelled: 0,
        skipped: 0,
        todo: 0,
      },
    }, validShape.candidate, [], []);
    const forgedTestReceipt = {
      ...validShape,
      candidate: { ...validShape.candidate, semanticTreeHash: "2".repeat(64) },
    };
    const forged = { ...validRun, testReceipt: forgedTestReceipt };
    assert.ok(validateTestReceipt(forged, candidateIdentity, inventory).includes("test-result-receipt-integrity-invalid"));

    const escapedSourceId = "test/../../outside.test.ts";
    const firstEntry = inventory.tests[0]!;
    const escapedEntry = {
      ...firstEntry,
      sourceId: escapedSourceId,
      id: testInventoryEntryIdentity(escapedSourceId, firstEntry.sourceHash, firstEntry.name),
    };
    const escapedInventory = [escapedEntry, ...inventory.tests.slice(1)];
    const { integrityHash: _testIntegrity, ...validTestUnsigned } = validShape;
    const escapedTestUnsigned = {
      ...validTestUnsigned,
      inventoryHash: testInventoryIdentity(inventory.scope, escapedInventory),
      inventory: escapedInventory,
    };
    const escapedTestReceipt = {
      ...escapedTestUnsigned,
      integrityHash: canonicalHash(escapedTestUnsigned),
    };
    const { integrityHash: _runIntegrity, ...validRunUnsigned } = validRun;
    const escapedRunUnsigned = { ...validRunUnsigned, testReceipt: escapedTestReceipt };
    const escapedRun = { ...escapedRunUnsigned, integrityHash: canonicalHash(escapedRunUnsigned) };
    assert.deepEqual(validateTestReceipt(escapedRun, candidateIdentity, inventory), [
      "test-result-receipt-schema-invalid",
    ]);
    const forgeRunWithCounts = (countsOverride: typeof counts) => {
      const { integrityHash: _validTestHash, ...validUnsigned } = validShape;
      const testUnsigned = { ...validUnsigned, counts: countsOverride };
      const testReceipt = { ...testUnsigned, integrityHash: canonicalHash(testUnsigned) };
      const { integrityHash: _validRunHash, ...runUnsignedBase } = validRun;
      const runUnsigned = { ...runUnsignedBase, testReceipt };
      return { ...runUnsigned, integrityHash: canonicalHash(runUnsigned) };
    };
    assert.ok(validateTestReceipt(
      forgeRunWithCounts({ discovered: 0, passed: 0, failed: 0, skipped: 0, todo: 0, cancelled: 0 }),
      candidateIdentity,
      inventory,
    ).includes("test-receipt-nonpassing-counts"));
    assert.ok(validateTestReceipt(
      forgeRunWithCounts({
        discovered: inventory.tests.length,
        passed: inventory.tests.length,
        failed: 0,
        skipped: 1,
        todo: 0,
        cancelled: 0,
      }),
      candidateIdentity,
      inventory,
    ).includes("test-receipt-nonpassing-counts"));

    const inventoryMutationRoot = createOwnedTemporaryDirectory("inventory-mutation-");
    mkdirSync(join(inventoryMutationRoot, "test"), { recursive: true });
    const inventoryMutationPath = join(inventoryMutationRoot, "test", "core.test.ts");
    const inventoryMutationManifest = createTestSurfaceDispositionManifest([{
      path: "test/core.test.ts",
      language: "javascript-typescript",
      disposition: "canonical-node-test",
      rationale: "Isolated inventory mutation fixture generated through the production contract.",
      evidenceLinks: [],
      blocksFullRepositoryClaim: false,
    }]);
    writeFileSync(inventoryMutationPath, 'import test from "node:test";\ntest("inventory control", () => undefined);\n');
    const inventoryBeforeMutation = buildTestInventory(inventoryMutationRoot, {
      dispositionManifest: inventoryMutationManifest,
    });
    rmSync(inventoryMutationPath);
    assert.throws(() => buildTestInventory(inventoryMutationRoot, {
      dispositionManifest: inventoryMutationManifest,
    }));
    writeFileSync(inventoryMutationPath, 'import test from "node:test";\ntest("inventory renamed", () => undefined);\n');
    const inventoryAfterRename = buildTestInventory(inventoryMutationRoot, {
      dispositionManifest: inventoryMutationManifest,
    });
    assert.notEqual(inventoryAfterRename.inventoryHash, inventoryBeforeMutation.inventoryHash);

    const root = makeRuntimeCandidate();
    const tracePath = join(root, "traceability", "s1.json");
    const trace = JSON.parse(readFileSync(tracePath, "utf8")) as { behaviors: Array<{ requirements: string[] }> };
    trace.behaviors[0]!.requirements = ["REQ-UNKNOWN"];
    writeFileSync(tracePath, `${JSON.stringify(trace)}\n`);
    assert.equal(verifyS1Structure(root).ok, false);

    assert.throws(
      () => discoverTestNames('test("duplicate", () => undefined); test("duplicate", () => undefined);'),
      /duplicate test names/u,
    );
    const uncoveredRoot = createOwnedTemporaryDirectory("inventory-uncovered-");
    mkdirSync(join(uncoveredRoot, "test"), { recursive: true });
    writeFileSync(join(uncoveredRoot, "test", "empty.test.ts"), "export const noTests = true;\n");
    const uncoveredManifest = createTestSurfaceDispositionManifest([{
      path: "test/empty.test.ts",
      language: "javascript-typescript",
      disposition: "canonical-node-test",
      rationale: "Empty static-discovery failure fixture.",
      evidenceLinks: [],
      blocksFullRepositoryClaim: false,
    }]);
    assert.throws(
      () => buildTestInventory(uncoveredRoot, { dispositionManifest: uncoveredManifest }),
      /no modeled test registrations/u,
    );

    const inertRoot = createOwnedTemporaryDirectory("inventory-inert-");
    mkdirSync(join(inertRoot, "test"), { recursive: true });
    const forbiddenMarker = join(inertRoot, "executed-marker");
    writeFileSync(join(inertRoot, "test", "hostile.test.ts"), [
      'import test from "node:test";',
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(forbiddenMarker)}, "executed");`,
      'test("statically discovered despite hostile top-level effects", () => undefined);',
      'throw new Error("module crash");',
    ].join("\n"));
    const inertInventory = buildTestInventory(inertRoot, {
      dispositionManifest: createTestSurfaceDispositionManifest([{
        path: "test/hostile.test.ts",
        language: "javascript-typescript",
        disposition: "canonical-node-test",
        rationale: "Static discovery must not execute hostile top-level effects.",
        evidenceLinks: [],
        blocksFullRepositoryClaim: false,
      }]),
    });
    assert.deepEqual(inertInventory.tests.map((entry) => entry.name), [
      "statically discovered despite hostile top-level effects",
    ]);
    assert.equal(existsSync(forbiddenMarker), false);

    const cacheRoot = makeRuntimeCandidate();
    // The evidence tree is floor content: it is tracked on the testing floor
    // and absent from the product tree, so a candidate built from the product
    // tree has no `traceability/evidence` at all. Create it BEFORE the
    // baseline — otherwise the recursive mkdir below adds the directory
    // itself to the manifest and the arm measures that addition instead of
    // the bytecode cache it exists to judge.
    mkdirSync(join(cacheRoot, "traceability", "evidence"), { recursive: true });
    const cacheBaseline = verifyS1Structure(cacheRoot);
    const pythonCache = join(cacheRoot, "traceability", "evidence", "__pycache__");
    mkdirSync(pythonCache, { recursive: true });
    writeFileSync(join(pythonCache, "probe.cpython-313.pyc"), Buffer.from([0xff, 0x00, 0xfe]));
    assert.deepEqual(verifyS1Structure(cacheRoot), cacheBaseline);

    const admissionRoot = createOwnedTemporaryDirectory("artifact-cache-");
    mkdirSync(join(admissionRoot, "docs", "research"), { recursive: true });
    mkdirSync(join(admissionRoot, "traceability", "canonical"), { recursive: true });
    mkdirSync(join(admissionRoot, "verification", "__pycache__"), { recursive: true });
    writeFileSync(join(admissionRoot, "docs", "research", "retained.md"), "retained\n");
    writeFileSync(join(admissionRoot, "traceability", "canonical", "harness-requirements.md"), "authority\n");
    writeFileSync(join(admissionRoot, "verification", "__pycache__", "probe.pyc"),
      Buffer.from([0xff, 0x00, 0xfe]));
    const cacheSafeManifest = buildArtifactAdmissionManifest({
      root: admissionRoot,
    });
    assert.deepEqual(cacheSafeManifest.entries.map((entry) => entry.path), [
      "docs/research/retained.md",
      "traceability/canonical/harness-requirements.md",
    ]);

    const reviewPolicy = ROOT_POLICY.artifactGovernance.independentReview;
    for (const path of new Set([
      reviewPolicy.reviewedArtifact,
      ...reviewPolicy.reviewedInputs,
      ...reviewPolicy.requiredReports.slice(0, -1),
    ])) {
      const absolute = join(admissionRoot, path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, `${path}\n`);
    }
    const pendingReviewManifest = buildArtifactAdmissionManifest({
      root: admissionRoot,
    });
    assert.ok(pendingReviewManifest.entries.filter((entry) =>
      entry.path.startsWith(reviewPolicy.governedPrefix)).every((entry) =>
      entry.admission.independentReview === "pending"));

    const finalReviewPath = reviewPolicy.requiredReports.at(-1)!;
    mkdirSync(dirname(join(admissionRoot, finalReviewPath)), { recursive: true });
    writeFileSync(join(admissionRoot, finalReviewPath), `${finalReviewPath}\n`);
    const staleReviewManifest = buildArtifactAdmissionManifest({
      root: admissionRoot,
    });
    assert.ok(staleReviewManifest.entries.filter((entry) =>
      entry.path.startsWith(reviewPolicy.governedPrefix)).every((entry) =>
      entry.admission.independentReview === "pending"));
    writeFileSync(join(admissionRoot, finalReviewPath), `${reviewPolicy.reviewedInputs.map((path) =>
      `${path} ${sha256(readFileSync(join(admissionRoot, path)))}`).join("\n")}\n`);
    const completeReviewManifest = buildArtifactAdmissionManifest({
      root: admissionRoot,
    });
    assert.ok(completeReviewManifest.entries.filter((entry) =>
      entry.path.startsWith(reviewPolicy.governedPrefix)).every((entry) =>
      entry.admission.independentReview === "complete"));
    assert.deepEqual(completeReviewManifest.entries.find((entry) =>
      entry.path === reviewPolicy.reviewedArtifact)!.relations.dependencyLinks,
    reviewPolicy.requiredReports);
    assert.deepEqual(completeReviewManifest.entries.find((entry) =>
      entry.path === finalReviewPath)!.relations.dependencyLinks,
    reviewPolicy.requiredReports.slice(0, -1));
    writeFileSync(join(admissionRoot, reviewPolicy.reviewedInputs[0]), "changed after review\n");
    assert.ok(artifactAdmissionViolations({
      root: admissionRoot,
      manifest: completeReviewManifest,
      paths: completeReviewManifest.entries.map((entry) => entry.path),
    }).some((violation) => violation.startsWith("artifact-independent-review-status-drift:")));

    const transactionRoot = createOwnedTemporaryDirectory("inventory-transaction-");
    mkdirSync(join(transactionRoot, "test"), { recursive: true });
    mkdirSync(join(transactionRoot, "src"), { recursive: true });
    mkdirSync(join(transactionRoot, "traceability"), { recursive: true });
    // The synthetic policy lives at the policy authority's declared location
    // (src/kernel/ post-fold); create its directory so the write lands.
    mkdirSync(join(transactionRoot, dirname(ROOT_POLICY.sourcePath)), { recursive: true });
    const transactionTestPath = join(transactionRoot, "test", "transaction.test.ts");
    const transactionInventoryOptions = {
      dispositionManifest: createTestSurfaceDispositionManifest([{
        path: "test/transaction.test.ts",
        language: "javascript-typescript",
        disposition: "canonical-node-test",
        rationale: "Transactional inventory publication fixture.",
        evidenceLinks: [],
        blocksFullRepositoryClaim: false,
      }]),
    } as const;
    writeFileSync(transactionTestPath, 'test("base inventory", () => undefined);\n');
    const baseInventory = buildTestInventory(transactionRoot, transactionInventoryOptions);
    const baseInventoryBytes = `${canonicalJson(baseInventory)}\n`;
    writeFileSync(join(transactionRoot, VERIFICATION_PATHS.testInventory), baseInventoryBytes);
    // The root policy holds no copy of the inventory's hash (#221): the transaction's one file is the inventory.
    writeFileSync(transactionTestPath, 'test("next inventory", () => undefined);\n');
    const nextInventory = buildTestInventory(transactionRoot, transactionInventoryOptions);
    const inventoryCommitted = `committed:${VERIFICATION_PATHS.testInventory}`;

    assert.throws(() => writeTestInventoryTransaction(transactionRoot, nextInventory, (phase) => {
      if (phase === "journal-written") {
        assert.throws(
          () => writeTestInventoryTransaction(
            transactionRoot,
            nextInventory,
            undefined,
            transactionInventoryOptions,
          ),
          /transaction already exists/u,
        );
      }
      if (phase === inventoryCommitted) throw new Error("synthetic interruption");
    }, transactionInventoryOptions), /synthetic interruption/u);
    // An in-process failure after the rename rolls back AT ONCE: no journal is
    // left, and the inventory holds its base bytes.
    assert.equal(existsSync(journalPathFor(transactionRoot, "test-inventory")), false);
    assert.equal(readFileSync(join(transactionRoot, VERIFICATION_PATHS.testInventory), "utf8"), baseInventoryBytes);
    // A real CRASH after the rename (SIGKILL, no finally) leaves the journal;
    // the next run's recovery puts the base back.
    const crashInput = join(createOwnedTemporaryDirectory("inventory-crash-"), "next.json");
    writeFileSync(crashInput, canonicalJson(nextInventory));
    const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", [
      `const { writeTestInventoryTransaction } = await import(${JSON.stringify(new URL("../../scripts/test-inventory.ts", import.meta.url).href)});`,
      `const { createTestSurfaceDispositionManifest } = await import(${JSON.stringify(new URL("../../scripts/verification/test-surface.ts", import.meta.url).href)});`,
      "const { readFileSync } = await import('node:fs');",
      `const options = { dispositionManifest: createTestSurfaceDispositionManifest(${JSON.stringify(transactionInventoryOptions.dispositionManifest.entries)}) };`,
      `writeTestInventoryTransaction(${JSON.stringify(transactionRoot)}, JSON.parse(readFileSync(${JSON.stringify(crashInput)}, "utf8")), (phase) => {`,
      `  if (phase === ${JSON.stringify(inventoryCommitted)}) process.kill(process.pid, "SIGKILL");`,
      "}, options);",
    ].join("\n")], { encoding: "utf8" });
    assert.equal(crashed.signal, "SIGKILL", crashed.stderr);
    assert.equal(existsSync(journalPathFor(transactionRoot, "test-inventory")), true, "a crash leaves the journal");
    assert.notEqual(readFileSync(join(transactionRoot, VERIFICATION_PATHS.testInventory), "utf8"), baseInventoryBytes, "the crash landed after the rename");
    assert.equal(recoverTestInventoryTransaction(transactionRoot), "rolled-back");
    assert.equal(readFileSync(join(transactionRoot, VERIFICATION_PATHS.testInventory), "utf8"),
      baseInventoryBytes);
    assert.equal(existsSync(journalPathFor(transactionRoot, "test-inventory")), false);

    writeTestInventoryTransaction(
      transactionRoot,
      nextInventory,
      undefined,
      transactionInventoryOptions,
    );
    assert.equal(readFileSync(join(transactionRoot, VERIFICATION_PATHS.testInventory), "utf8"),
      `${canonicalJson(nextInventory)}\n`);
  },
};

for (const scenarioId of Object.keys(scenarios).toSorted()) {
  test(scenarioId, scenarios[scenarioId]!);
}

test.afterEach(removeOwnedTemporaryDirectories);
test.after(removeOwnedTemporaryDirectories);
