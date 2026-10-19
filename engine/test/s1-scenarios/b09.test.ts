import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { verifyS1Structure } from "../../scripts/tooling/s1-verification.ts";
import { atomicWriteFile } from "../../src/filesystem/atomic-write.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { makeRuntimeCandidate, removeOwnedTemporaryDirectories, historicalApplicationName, appendCandidateSource, mutateCandidateTextExact, candidateModulePath } from "../support/s1-scenario-shared.ts";

const scenarios: Readonly<Record<string, () => void | Promise<void>>> = {
  "S1-B09-CONTROL": () => {
    assert.deepEqual(ROOT_POLICY.productBoundary, {
      architecture: "standalone-provider-model-agnostic-replacement",
      externalCodingApplicationRole: "isolated-read-only-historical-research-source-only",
      externalRuntimeDependency: false,
      pluginMode: false,
      wrapperMode: false,
      companionMode: false,
      extensionMode: false,
      childProcessMode: false,
      coRunningMode: false,
      historicalResearchEvidenceAllowlist: [
        "traceability/canonical/harness-requirements.md",
        "traceability/requirements.json",
        "docs/architecture/",
        "docs/research/",
        "traceability/artifacts/manifest.json",
        "verification/benchmarks/",
      ],
      historicalResearchAccessControl: {
        scope: "exact-manifest-bound-admitted-root-and-bounded-query-plan-only",
        launcher: "deny-by-default-path-scoped-wrapper-required-before-tool-launch",
        broadDiscoveryAllowed: false,
        implicitCurrentDirectoryAllowed: false,
        parentSiblingScratchPacketQuarantineTraversalAllowed: false,
        delegatedScopeExpansionAllowed: false,
        transcriptAdmission: "bounded-classified-and-fail-closed-on-scope-disagreement",
        currentFinding: "SEC-001-runbook-search-scope-exposure",
        currentRunDisposition: "confidentiality-tainted-no-readiness-or-no-access-claim",
        realHistoryAccessAvailable: false,
      },
    });
    const controlRoot = makeRuntimeCandidate();
    const baselineViolations = verifyS1Structure(controlRoot).violations;
    appendCandidateSource(controlRoot, candidateModulePath("forensic-state.ts"), [
      'const unusedExternalApplication = ["Open", "Code"].join("");',
      'const unusedModuleAccessor = ["get", "BuiltinModule"].join("");',
      "function shadowedProcess(process: { getBuiltinModule: string }): string {",
      "  return process.getBuiltinModule;",
      "}",
      "void unusedExternalApplication;",
      "void unusedModuleAccessor;",
      "void shadowedProcess;",
      'export const exportedFunctionControl = () => "safe-runtime-value";',
    ].join("\n"));
    const violations = verifyS1Structure(controlRoot).violations;
    const controlDiagnosticPrefixes = [
      "standalone-product-boundary-",
      "production-effect-",
      "process-member-unmodeled:",
      "governed-export-unmodeled:",
    ] as const;
    const relevantDiagnostics = (entries: readonly string[]) => entries.filter((entry) =>
      controlDiagnosticPrefixes.some((prefix) => entry.startsWith(prefix))
    );
    assert.deepEqual(
      relevantDiagnostics(violations),
      relevantDiagnostics(baselineViolations),
      "the control source must not add standalone, effect, process, or governed-export diagnostics",
    );
  },
  "S1-B09-FAILURE": () => {
    const dependencyRoot = makeRuntimeCandidate();
    const packagePath = join(dependencyRoot, "package.json");
    const packageDocument = JSON.parse(readFileSync(packagePath, "utf8")) as {
      dependencies: Record<string, string>;
    };
    packageDocument.dependencies[historicalApplicationName().toLowerCase()] = "^1.0.0";
    writeFileSync(packagePath, `${JSON.stringify(packageDocument)}\n`);
    assert.ok(verifyS1Structure(dependencyRoot).violations.includes(
      "standalone-product-boundary-reference:package.json",
    ));

    const configRoot = makeRuntimeCandidate();
    const configPath = join(configRoot, "bridlewise.config.json");
    const configDocument = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    configDocument[historicalApplicationName("_").toLowerCase()] = { mode: "companion" };
    // The mutated candidate config goes through the atomic-rename owner: the
    // S1 verification re-reads the tree, so the scenario must never present
    // a config file mid-write.
    assert.ok(atomicWriteFile(configPath, `${JSON.stringify(configDocument)}\n`, {
      requiredMode: 0o600,
    }).success);
    assert.ok(verifyS1Structure(configRoot).violations.includes(
      "standalone-product-boundary-reference:bridlewise.config.json",
    ));

    const processAcquisitionVariants = [
      'void process.getBuiltinModule("node:fs");',
      'void process["getBuiltin" + "Module"]("node:fs");',
      'void globalThis.process[["get", "Builtin", "Module"].join("")]("node:fs");',
      [
        "const globalAlias = globalThis;",
        'const processAlias = globalAlias["pro" + "cess"];',
        'void processAlias["get" + "BuiltinModule"]("node:fs");',
      ].join("\n"),
    ];
    for (const source of processAcquisitionVariants) {
      const root = makeRuntimeCandidate();
      appendCandidateSource(root, "src/cli.ts", source);
      assert.ok(verifyS1Structure(root).violations.includes(
        "production-effect-api:cli.ts:process.getBuiltinModule",
      ));
    }

    const dynamicRoot = makeRuntimeCandidate();
    appendCandidateSource(dynamicRoot, "src/cli.ts", [
      "const unknownProcessKey = String(Date.now());",
      "void process[unknownProcessKey];",
      "const unknownModuleSpecifier = String(Date.now());",
      "void import(unknownModuleSpecifier);",
      "const unknownEffectKey = String(Date.now());",
      "({ run: () => undefined })[unknownEffectKey]();",
    ].join("\n"));
    const dynamicViolations = verifyS1Structure(dynamicRoot).violations;
    assert.ok(dynamicViolations.includes("process-member-unmodeled:cli.ts"));
    assert.ok(dynamicViolations.includes("module-acquisition-unmodeled:cli.ts"));
    assert.ok(dynamicViolations.includes("production-effect-sink-unmodeled:cli.ts"));

    const invariantRoot = makeRuntimeCandidate();
    mutateCandidateTextExact(invariantRoot, ROOT_POLICY.sourcePath,
      "companionMode: false",
      "companionMode: true",
      "B09 companion-mode mutant",
    );
    assert.ok(verifyS1Structure(invariantRoot).violations.includes(
      "standalone-product-boundary-root-source",
    ));
  },
  "S1-B09-HOSTILE-REAL": () => {
    const sinkVariants = [
      [
        'const moduleName = ["node:child", "_process"].join("");',
        'const applicationName = ["Open", "Code"].join("");',
        'const builtin = process[["get", "Builtin", "Module"].join("")](moduleName);',
        'const launch = builtin[["sp", "awn"].join("")];',
        "Reflect.apply(launch, builtin, [applicationName]);",
      ].join("\n"),
      [
        "const launchProbe = (...args: unknown[]) => args;",
        'const applicationName = "Open".concat("Code");',
        "Reflect.apply(launchProbe, null, [applicationName]);",
      ].join("\n"),
      [
        "const launchProbe = (...args: unknown[]) => args;",
        'const applicationName = `${"Open"}${"Code"}`;',
        "Reflect.apply(launchProbe, null, [applicationName]);",
      ].join("\n"),
    ];
    for (const source of sinkVariants) {
      const root = makeRuntimeCandidate();
      const preflightPath = candidateModulePath("preflight.ts");
      appendCandidateSource(root, preflightPath, source);
      const violations = verifyS1Structure(root).violations;
      assert.ok(violations.includes(`standalone-product-boundary-reference:${preflightPath}`));
      // The effect-api label strips the leading `src/` but keeps the post-fold
      // folder, so it is derived from the resolved path, not spelled.
      assert.ok(violations.includes(`production-effect-api:${preflightPath.replace(/^src\//, "")}:Reflect.apply`));
    }

    const overBudgetLines = ['const staticChunk0 = "12345678";'];
    for (let index = 1; index <= 18; index += 1) {
      overBudgetLines.push(`const staticChunk${index} = staticChunk${index - 1} + staticChunk${index - 1};`);
    }
    overBudgetLines.push("export const overBudgetStaticValue = staticChunk18;");
    const unmodeledExportVariants = [
      [
        'const pieces = ["Open", "Safe"];',
        'pieces[1] = "Code";',
        'export const mutatedExternal = pieces.join("");',
      ].join("\n"),
      [
        'const pieces = ["Open", "Safe"];',
        "const alias = pieces;",
        'alias[1] = "Code";',
        'export const aliasMutatedExternal = pieces.join("");',
      ].join("\n"),
      [
        'const custom = { join: () => ["Open", "Code"].join("") };',
        "export const customJoin = custom.join();",
      ].join("\n"),
      overBudgetLines.join("\n"),
    ];
    for (const source of unmodeledExportVariants) {
      const root = makeRuntimeCandidate();
      const forensicState = candidateModulePath("forensic-state.ts");
      appendCandidateSource(root, forensicState, source);
      assert.ok(verifyS1Structure(root).violations.includes(
        `governed-export-unmodeled:${forensicState}`,
      ));
    }

    const unmodeledSinkRoot = makeRuntimeCandidate();
    const kernelConfig = candidateModulePath("kernel/config.ts");
    appendCandidateSource(unmodeledSinkRoot, kernelConfig, [
      'const customPath = { join: () => ["Open", "Code"].join("") };',
      "void readFileSync(customPath.join());",
    ].join("\n"));
    assert.ok(verifyS1Structure(unmodeledSinkRoot).violations.includes(
      `governed-sink-unmodeled:${kernelConfig}`,
    ));

    const runtimeRoot = makeRuntimeCandidate();
    const externalName = historicalApplicationName("-");
    const companionPath = join(runtimeRoot, "src", `${externalName}-companion.ts`);
    const marker = join(runtimeRoot, "external-launch-marker");
    writeFileSync(companionPath, "export const boundaryProbe = true;\n");
    assert.ok(verifyS1Structure(runtimeRoot).violations.includes(
      `standalone-product-boundary-reference:src/${externalName}-companion.ts`,
    ));
    assert.equal(existsSync(marker), false);

    const falseDocumentationRoot = makeRuntimeCandidate();
    mkdirSync(join(falseDocumentationRoot, "docs"));
    const documentationName = `${historicalApplicationName("_")}-research.md`;
    writeFileSync(
      join(falseDocumentationRoot, "docs", documentationName),
      `${historicalApplicationName()} companion setup\n`,
    );
    assert.ok(verifyS1Structure(falseDocumentationRoot).violations.includes(
      `standalone-product-boundary-reference:docs/${documentationName}`,
    ));

  },
};

for (const scenarioId of Object.keys(scenarios).toSorted()) {
  test(scenarioId, scenarios[scenarioId]!);
}

test.afterEach(removeOwnedTemporaryDirectories);
test.after(removeOwnedTemporaryDirectories);
