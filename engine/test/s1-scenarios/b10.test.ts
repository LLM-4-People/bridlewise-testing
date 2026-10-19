import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { verifyS1Structure } from "../../scripts/tooling/s1-verification.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { makeRuntimeCandidate, removeOwnedTemporaryDirectories, historicalTableName, appendCandidateSource, candidateModulePath } from "../support/s1-scenario-shared.ts";

const scenarios: Readonly<Record<string, () => void | Promise<void>>> = {
  "S1-B10-CONTROL": () => {
    assert.deepEqual(ROOT_POLICY.storageArchitecture, {
      implementationStage: "target-invariant-only-physical-storage-unavailable-until-s3.2",
      ownership: "harness-owned-provider-model-neutral-versioned-schema",
      sourceOfTruth: "canonical-append-only-event-ledger",
      encryptedRawVault: "derived-rebuildable-projection",
      redactedSearch: "derived-rebuildable-projection",
      metrics: "derived-rebuildable-projection",
      operationalDomainTables: "derived-rebuildable-projection",
      migrations: "explicit-versioned-compatibility-policy-required",
      constraints: "database-constraints-and-reconciliation-required",
      historicalSourceSchemaRole: "isolated-read-only-study-adapter-evidence-only",
      physicalStorageAvailable: false,
    });
    const genericRoot = makeRuntimeCandidate();
    const baselineViolations = new Set(verifyS1Structure(genericRoot).violations);
    appendCandidateSource(genericRoot, candidateModulePath("forensic-state.ts"), [
      'export const genericSqlEvidence = ["CREATE TABLE harness_", "sessions (event_ledger_id TEXT)"].join("");',
      'const unusedHistoricalJoin = ["SELECT * FROM ses", "sion_mes", "sage"].join("");',
      'const unusedHistoricalConcat = "SELECT * FROM session_".concat("input");',
      'const unusedHistoricalTemplate = `SELECT * FROM ${"session"}_${"context"}_${"epoch"}`;',
      "void unusedHistoricalJoin;",
      "void unusedHistoricalConcat;",
      "void unusedHistoricalTemplate;",
    ].join("\n"));
    const violations = verifyS1Structure(genericRoot).violations
      .filter((entry) => !baselineViolations.has(entry));
    assert.equal(violations.some((entry) => entry.startsWith("historical-source-schema-")), false);
  },
  "S1-B10-FAILURE": () => {
    const variants = [
      'export const historicalQuery = ["SELECT * FROM ses", "sion_mes", "sage"].join("");',
      'export const historicalQuery = "SELECT * FROM session_".concat("input");',
      'export const historicalQuery = `SELECT * FROM ${"Session"}.${"Context"}.${"Epoch"}`;',
    ];
    for (const source of variants) {
      const root = makeRuntimeCandidate();
      appendCandidateSource(root, candidateModulePath("forensic-state.ts"), source);
      assert.ok(verifyS1Structure(root).violations.includes(
        `historical-source-schema-marker:${candidateModulePath("forensic-state.ts")}`,
      ));
    }
  },
  "S1-B10-HOSTILE-REAL": () => {
    const coupledRoot = makeRuntimeCandidate();
    appendCandidateSource(coupledRoot, candidateModulePath("forensic-state.ts"), [
      "export const coupledSourceSchema = [",
      '  ["CREATE TABLE ", "ses" + "sion", " (id TEXT)"].join(""),',
      '  ["CREATE TABLE ", "mes" + "sage", " (id TEXT, session_id TEXT REFERENCES session)"].join(""),',
      '  ["CREATE TABLE ", "pa" + "rt", " (id TEXT, message_id TEXT REFERENCES message)"].join(""),',
      '].join("; ");',
    ].join("\n"));
    assert.ok(verifyS1Structure(coupledRoot).violations.includes(
      `historical-source-schema-coupling:${candidateModulePath("forensic-state.ts")}`,
    ));

    const argumentRoot = makeRuntimeCandidate();
    appendCandidateSource(argumentRoot, candidateModulePath("forensic-state.ts"), [
      'const historicalQuery = ["SELECT * FROM ses", "sion_in", "put"].join("");',
      "JSON.stringify({ query: historicalQuery });",
    ].join("\n"));
    assert.ok(verifyS1Structure(argumentRoot).violations.includes(
      `historical-source-schema-marker:${candidateModulePath("forensic-state.ts")}`,
    ));

    const objectRoot = makeRuntimeCandidate();
    appendCandidateSource(objectRoot, candidateModulePath("forensic-state.ts"), [
      "export const schemaEnvelope = Object.freeze({",
      '  query: `SELECT * FROM ${"session"}_${"context"}_${"epoch"}`,',
      "});",
    ].join("\n"));
    assert.ok(verifyS1Structure(objectRoot).violations.includes(
      `historical-source-schema-marker:${candidateModulePath("forensic-state.ts")}`,
    ));

    const migrationRoot = makeRuntimeCandidate();
    mkdirSync(join(migrationRoot, "migrations"));
    const migrationMarker = historicalTableName("session", "context", "epoch");
    const migrationPath = `migrations/${migrationMarker}.sql`;
    writeFileSync(join(migrationRoot, migrationPath), `SELECT * FROM ${migrationMarker};\n`);
    assert.ok(verifyS1Structure(migrationRoot).violations.includes(
      `historical-source-schema-marker:${migrationPath}`,
    ));

    const contractRoot = makeRuntimeCandidate();
    const contractPath = join(contractRoot, "traceability", "s3.1-forensic-schemas.json");
    const contractMarker = ["session", "message"].join("_");
    const contract = JSON.parse(readFileSync(contractPath, "utf8")) as Record<string, unknown>;
    contract.historicalSchemaProbe = contractMarker;
    writeFileSync(contractPath, `${JSON.stringify(contract)}\n`);
    assert.ok(verifyS1Structure(contractRoot).violations.includes(
      "historical-source-schema-marker:traceability/s3.1-forensic-schemas.json",
    ));
  },
};

for (const scenarioId of Object.keys(scenarios).toSorted()) {
  test(scenarioId, scenarios[scenarioId]!);
}

test.afterEach(removeOwnedTemporaryDirectories);
test.after(removeOwnedTemporaryDirectories);
