import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { verifyS1Structure } from "../../scripts/tooling/s1-verification.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { makeRuntimeCandidate, removeOwnedTemporaryDirectories, appendCandidateSource, mutateCandidateTextExact, candidateModulePath, REPOSITORY_ROOT } from "../support/s1-scenario-shared.ts";

const scenarios: Readonly<Record<string, () => void | Promise<void>>> = {
  "S1-B11-CONTROL": () => {
    const expectedIdentityKinds = [
      "run", "session", "turn", "feature", "task", "subtask", "attempt", "agent", "provider", "model",
      "request", "response", "tool", "context", "memory", "research", "repository", "edit", "test",
      "commit", "tag", "checkpoint", "rollback", "deployment",
    ];
    const expectedEdgeTypes = [
      "causal", "part-of", "performed-by", "used-context", "produced", "validated-by", "supersedes",
      "rolled-back-by",
    ];
    assert.deepEqual(ROOT_POLICY.evidenceGraphArchitecture.eventEnvelope.typedIdentities, expectedIdentityKinds);
    assert.deepEqual(ROOT_POLICY.evidenceGraphArchitecture.edgeTypes, expectedEdgeTypes);
    assert.equal(new Set(expectedIdentityKinds).size, expectedIdentityKinds.length);
    assert.equal(new Set(expectedEdgeTypes).size, expectedEdgeTypes.length);
    assert.equal(ROOT_POLICY.evidenceGraphArchitecture.authority, "storageArchitecture.sourceOfTruth");
    assert.equal(ROOT_POLICY.evidenceGraphArchitecture.competingSourceOfTruthAllowed, false);
    assert.equal(ROOT_POLICY.evidenceGraphArchitecture.querySurface.available, false);

    const registry = JSON.parse(readFileSync(
      join(REPOSITORY_ROOT, "traceability", "requirements.json"),
      "utf8",
    )) as {
      userStatements: Array<{
        id: string;
        boundRequirements: string[];
        provenance: { sourceArtifactSha256: string; sourceLine: number };
      }>;
      derivedControls: Array<{
        id: string;
        boundRequirements: string[];
        derivedControlDependencies: string[];
      }>;
    };
    const sharedMemory = registry.userStatements.find((entry) => entry.id === "USR-015")!;
    const attempts = registry.userStatements.find((entry) => entry.id === "USR-020")!;
    const evidenceGraph = registry.derivedControls.find((entry) => entry.id === "DER-023")!;
    assert.ok(sharedMemory.boundRequirements.includes("REQ-034"));
    assert.ok(attempts.boundRequirements.includes("REQ-034"));
    assert.equal(sharedMemory.provenance.sourceArtifactSha256,
      "769663cd46b34d1c9936e2d353de97ce3bd4ee27e16425ee86e39fef94fe1204");
    assert.equal(sharedMemory.provenance.sourceLine, 435);
    assert.equal(attempts.provenance.sourceLine, 440);
    for (const requirement of ["REQ-016", "REQ-020", "REQ-034"]) {
      assert.ok(evidenceGraph.boundRequirements.includes(requirement));
    }
    assert.ok(evidenceGraph.derivedControlDependencies.includes("DER-009"));
    const forensicContracts = readFileSync(join(REPOSITORY_ROOT, candidateModulePath("forensic-contracts.ts")), "utf8");
    assert.equal(forensicContracts.includes(["edge", "Types"].join("")), false);
    const controlRoot = makeRuntimeCandidate();
    const baselineViolations = new Set(verifyS1Structure(controlRoot).violations);
    appendCandidateSource(controlRoot, candidateModulePath("forensic-projection.ts"), [
      "const unusedCompetingAuthority = Object.freeze({",
      '  [["source", "Of", "Truth"].join("")]: ["memory", "store"].join("-"),',
      "});",
      "export const canonicalAuthority = Object.freeze({",
      '  [["source", "Of", "Truth"].join("")]: ["canonical", "append-only", "event-ledger"].join("-"),',
      "});",
      "export const importedWrapperControl = deepFreeze({",
      '  sourceOfTruth: "canonical-append-only-event-ledger",',
      "});",
      "void unusedCompetingAuthority;",
    ].join("\n"));
    const controlViolations = verifyS1Structure(controlRoot).violations
      .filter((entry) => !baselineViolations.has(entry));
    assert.equal(controlViolations.some(
      (entry) => entry.startsWith("evidence-graph-"),
    ), false);
    assert.equal(controlViolations.includes(
      `governed-export-unmodeled:${candidateModulePath("forensic-projection.ts")}`,
    ), false);
  },
  "S1-B11-FAILURE": () => {
    const weakenedRoot = makeRuntimeCandidate();
    mutateCandidateTextExact(weakenedRoot, ROOT_POLICY.sourcePath,
      "competingSourceOfTruthAllowed: false",
      "competingSourceOfTruthAllowed: true",
      "B11 competing-authority mutant",
    );
    assert.ok(verifyS1Structure(weakenedRoot).violations.includes("evidence-graph-root-source"));

    const competingVariants = [
      [
        "export const competingStore = Object.freeze({",
        '  [["source", "Of", "Truth"].join("")]: ["search", "index"].join("-"),',
        "});",
      ].join("\n"),
      [
        "export const competingStore = {",
        '  ["source" + "Of" + "Truth"]: "memory".concat("-store"),',
        "};",
      ].join("\n"),
      [
        "export const competingStore = {",
        '  [`${"author"}${"ity"}`]: `${"timeline"}-${"projection"}`,',
        "};",
      ].join("\n"),
    ];
    for (const source of competingVariants) {
      const root = makeRuntimeCandidate();
      appendCandidateSource(root, candidateModulePath("forensic-projection.ts"), source);
      assert.ok(verifyS1Structure(root).violations.includes(
        `evidence-graph-competing-authority:${candidateModulePath("forensic-projection.ts")}`,
      ));
    }

    const shadowedObjectRoot = makeRuntimeCandidate();
    appendCandidateSource(shadowedObjectRoot, candidateModulePath("forensic-projection.ts"), [
      'const Object = { freeze: (_value: unknown) => ({ sourceOfTruth: "memory-store" }) };',
      "export const shadowedFreeze = Object.freeze({",
      '  sourceOfTruth: "canonical-append-only-event-ledger",',
      "});",
    ].join("\n"));
    assert.ok(verifyS1Structure(shadowedObjectRoot).violations.includes(
      `governed-export-unmodeled:${candidateModulePath("forensic-projection.ts")}`,
    ));

    const localWrapperRoot = makeRuntimeCandidate();
    appendCandidateSource(localWrapperRoot, candidateModulePath("ledger-canonical.ts"), [
      "function deepFreeze(_value: unknown): unknown {",
      '  return { sourceOfTruth: "memory-store" };',
      "}",
      "export const localWrapperAuthority = deepFreeze({",
      '  sourceOfTruth: "canonical-append-only-event-ledger",',
      "});",
    ].join("\n"));
    assert.ok(verifyS1Structure(localWrapperRoot).violations.includes(
      `governed-export-unmodeled:${candidateModulePath("ledger-canonical.ts")}`,
    ));

    const fabricatedRoot = makeRuntimeCandidate();
    mutateCandidateTextExact(fabricatedRoot, ROOT_POLICY.sourcePath,
      "typed-reason-and-evidence-state-required-never-fabricate",
      "typed-reason-only",
      "B11 fabricated-evidence mutant",
    );
    assert.ok(verifyS1Structure(fabricatedRoot).violations.includes("evidence-graph-root-source"));
  },
  "S1-B11-HOSTILE-REAL": () => {
    const generatedRoot = makeRuntimeCandidate();
    const generatedPath = join(generatedRoot, "traceability", "s3.1-forensic-schemas.json");
    const authorityKey = ["author", "ity"].join("");
    const graphValue = ["graph", "projection"].join("-");
    const generated = JSON.parse(readFileSync(generatedPath, "utf8")) as Record<string, unknown>;
    generated[authorityKey] = graphValue;
    writeFileSync(generatedPath, `${JSON.stringify(generated)}\n`);
    assert.ok(verifyS1Structure(generatedRoot).violations.includes(
      "evidence-graph-competing-authority:traceability/s3.1-forensic-schemas.json",
    ));

    const caseVariantRoot = makeRuntimeCandidate();
    appendCandidateSource(caseVariantRoot, "scripts/verification/candidate-manifest.ts", [
      "const hostileAuthority = Object.freeze({",
      '  [["SoUrCe", "Of", "TrUtH"].join("")]: ["memory", "store"].join("-"),',
      "});",
      "JSON.stringify(hostileAuthority);",
    ].join("\n"));
    assert.ok(verifyS1Structure(caseVariantRoot).violations.includes(
      "evidence-graph-competing-authority:scripts/verification/candidate-manifest.ts",
    ));

    const nestedRoot = makeRuntimeCandidate();
    appendCandidateSource(nestedRoot, candidateModulePath("forensic-projection.ts"), [
      "const competingAuthority = Object.freeze({",
      '  [["source", "Of", "Truth"].join("")]: ["attempt", "store"].join("-"),',
      "});",
      "const projectionProbe = (...args: unknown[]) => args;",
      "Reflect.apply(projectionProbe, null, [JSON.stringify(competingAuthority)]);",
    ].join("\n"));
    const nestedViolations = verifyS1Structure(nestedRoot).violations;
    assert.ok(nestedViolations.includes(
      `evidence-graph-competing-authority:${candidateModulePath("forensic-projection.ts")}`,
    ));
    assert.ok(nestedViolations.includes(
      `production-effect-api:${candidateModulePath("forensic-projection.ts").replace(/^src\//, "")}:Reflect.apply`,
    ));

    const divergentRoot = makeRuntimeCandidate();
    const divergentAuthority = ["timeline", "projection"].join("-");
    mutateCandidateTextExact(divergentRoot, ROOT_POLICY.sourcePath,
      'authority: "storageArchitecture.sourceOfTruth"',
      `authority: ${JSON.stringify(divergentAuthority)}`,
      "B11 divergent evidence-authority mutant",
    );
    assert.ok(verifyS1Structure(divergentRoot).violations.includes("evidence-graph-root-source"));
  },
};

for (const scenarioId of Object.keys(scenarios).toSorted()) {
  test(scenarioId, scenarios[scenarioId]!);
}

test.afterEach(removeOwnedTemporaryDirectories);
test.after(removeOwnedTemporaryDirectories);
