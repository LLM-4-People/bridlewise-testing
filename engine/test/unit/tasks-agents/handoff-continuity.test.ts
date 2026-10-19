import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  createPlannedNodeTestSourceBinding,
  createPlannedNodeTestSuiteSpec,
  plannedNodeTestReproducibilityIdentity,
} from "../../../scripts/tooling/planned-node-test-evidence.ts";
import { plannedNodeTestCatalogIdentity, PLANNED_NODE_TEST_PROTOCOL } from "../../../scripts/tooling/planned-node-test.ts";
import { discoverTestNames } from "../../../scripts/test-inventory.ts";
import { getConfigDocumentSchema } from "../../../src/kernel/config-contracts.ts";
import { canonicalHash, sha256 } from "../../../src/kernel/integrity.ts";
import {
  HANDOFF_PROTOCOL_AUTHORITY,
  createHandoffProtocol,
  deriveHandoffExecutableSchemaFingerprint,
  parseHandoffProtocolManifest,
} from "../../../src/modules/tasks-agents/index.ts";
import {
  HANDOFF_CONTINUITY_TEST_CATALOG,
  HANDOFF_CONTINUITY_TEST_DECLARATION_IDENTITY,
  HANDOFF_CONTINUITY_TEST_WORKER_PATH,
  createHandoffContinuityPlannedCatalog,
} from "../../support/handoff-continuity-test-catalog.ts";
import { runHandoffContinuityTestOracle } from "../../support/handoff-continuity-test-oracles.ts";
import { runPlannedNodeTestSuiteWithEvidence } from "../../support/planned-node-test-evidence.ts";
import { relaxSafeReadFloorForThisFile } from "../../support/test-env-helpers.ts";
import { PLANNED_NODE_TEST_SOURCE_AUTHORITY } from
  "../../support/planned-node-test-source-authority.ts";

const CONFIG_DOCUMENT_SCHEMA = getConfigDocumentSchema();

const ROOT = resolve(".");
// This test reads the real repository workspace (seeded with `cp -rl`
// hardlinks, nlink=2) in dev mode. The safe repository reader accepts
// hardlinked files in dev mode via the `HARNESS_REJECT_HARDLINKS` env var
// (`shouldRejectHardlinks`). Hardlink rejection is verified by the
// dedicated security tests, which leave the env var unset.
// Relaxed for THIS FILE and restored when it finishes — see the helper.
relaxSafeReadFloorForThisFile();
const AUTHORITY_PATH = "src/modules/tasks-agents/domain/handoff-protocol-authority.ts";
const MANIFEST_PATH = "traceability/canonical/handoff-protocol-manifest.json";
const PREVENTION_REVIEW_PATH = "traceability/prevention/prevention-retrospective.json";
const MANIFEST_SOURCE = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as unknown;
const MANIFEST = parseHandoffProtocolManifest(MANIFEST_SOURCE);
const CONFIG = CONFIG_DOCUMENT_SCHEMA.parse(JSON.parse(readFileSync("bridlewise.config.json", "utf8")));
const PROTOCOL = createHandoffProtocol(MANIFEST, CONFIG);
const PLANNED_CATALOG = createHandoffContinuityPlannedCatalog(runHandoffContinuityTestOracle);
const EXPECTED_TEST_NAMES = HANDOFF_CONTINUITY_TEST_CATALOG.map((entry) => `[${entry.id}] ${entry.name}`);
const DYNAMIC_SOURCE_PATHS = [
  ["worker", HANDOFF_CONTINUITY_TEST_WORKER_PATH],
  ["catalog", "test/support/handoff-continuity-test-catalog.ts"],
  ["domain-oracle", "test/support/handoff-continuity-test-oracles.ts"],
  ["domain-oracle", MANIFEST_PATH],
  ["domain-oracle", AUTHORITY_PATH],
  ["domain-oracle", PREVENTION_REVIEW_PATH],
  ...MANIFEST.semanticOwners.values.map((owner) => ["domain-oracle", owner.path] as const),
] as const;
const SOURCE_BINDINGS = [
  ...DYNAMIC_SOURCE_PATHS.map(([role, path]) => createPlannedNodeTestSourceBinding(ROOT, role, path)),
  PLANNED_NODE_TEST_SOURCE_AUTHORITY.shared.executor,
  PLANNED_NODE_TEST_SOURCE_AUTHORITY.shared.evidenceExecutor,
] as const;
const SUITE_SPEC = createPlannedNodeTestSuiteSpec({
  suiteId: `handoff-continuity-v${HANDOFF_PROTOCOL_AUTHORITY.currentProtocolVersion}`,
  declarationIdentity: HANDOFF_CONTINUITY_TEST_DECLARATION_IDENTITY,
  plannedCatalogIdentity: plannedNodeTestCatalogIdentity(PLANNED_CATALOG),
  expectedTestNames: EXPECTED_TEST_NAMES,
  sources: SOURCE_BINDINGS,
});
const HOSTILE_ENVIRONMENTS = [
  { HANDOFF_TEST_VARIANT: "0", LANG: "C", LC_ALL: "C", TZ: "UTC" },
  { HANDOFF_TEST_VARIANT: "1", LANG: "fr_CA.UTF-8", LC_ALL: "fr_CA.UTF-8", TZ: "America/Toronto" },
  { HANDOFF_TEST_VARIANT: "2", LANG: "tr_TR.UTF-8", LC_ALL: "tr_TR.UTF-8", TZ: "Asia/Tokyo" },
] as const;

test("[HCF-O001] worker declarations and shared planned-evidence bindings are exact", () => {
  assert.deepEqual(discoverTestNames(readFileSync(HANDOFF_CONTINUITY_TEST_WORKER_PATH, "utf8")),
    EXPECTED_TEST_NAMES);
  assert.deepEqual(SOURCE_BINDINGS.map((binding) =>
    createPlannedNodeTestSourceBinding(ROOT, binding.role, binding.path)
  ), SOURCE_BINDINGS);
  assert.equal(SUITE_SPEC.repositoryAdmissionAllowed, false);
  assert.equal(SUITE_SPEC.qualificationDisposition, PLANNED_NODE_TEST_PROTOCOL.qualificationDisposition);
});

test("[HCF-O002] production authority binds manifest semantics and every declared source", () => {
  assert.equal(MANIFEST.currentProtocolVersion, HANDOFF_PROTOCOL_AUTHORITY.currentProtocolVersion);
  assert.deepEqual(MANIFEST.contractSchemaVersions, HANDOFF_PROTOCOL_AUTHORITY.contractSchemaVersions);
  assert.deepEqual(MANIFEST.identityDomains, HANDOFF_PROTOCOL_AUTHORITY.identityDomains);
  assert.deepEqual(MANIFEST.invariantOrder.values, HANDOFF_PROTOCOL_AUTHORITY.invariantOrder);
  assert.deepEqual(MANIFEST.reasonOrder.values, HANDOFF_PROTOCOL_AUTHORITY.reasonOrder);
  assert.deepEqual(MANIFEST.configKeyReferences.values, HANDOFF_PROTOCOL_AUTHORITY.configKeyReferences);
  assert.deepEqual(MANIFEST.semanticOwners.values, HANDOFF_PROTOCOL_AUTHORITY.semanticOwners);
  assert.equal(deriveHandoffExecutableSchemaFingerprint(MANIFEST),
    MANIFEST.lineage.at(-1)?.executableSchemaFingerprint);
  assert.match(PROTOCOL.protocolIdentity, /^[0-9a-f]{64}$/u);
  assert.equal(MANIFEST.semanticOwners.identity.sha256, canonicalHash(MANIFEST.semanticOwners.values));
  for (const owner of MANIFEST.semanticOwners.values) {
    const bytes = readFileSync(owner.path);
    assert.equal(bytes.length, owner.byteLength, owner.path);
    assert.equal(sha256(bytes), owner.sha256, owner.path);
  }
});

test("[HCF-O003] handoff regression suite is reproducible across three isolated runtimes", async () => {
  const evidence = [];
  for (const environment of HOSTILE_ENVIRONMENTS) {
    const observation = await runPlannedNodeTestSuiteWithEvidence(
      SUITE_SPEC,
      { ...process.env, ...environment },
    );
    assert.equal(observation.accepted, true, JSON.stringify(observation.violations));
    assert.ok(observation.evidence);
    assert.equal(observation.evidence.repositoryAdmissionAllowed, false);
    evidence.push(observation.evidence);
  }
  const identities = evidence.map(plannedNodeTestReproducibilityIdentity);
  assert.deepEqual(identities.slice(1), [identities[0], identities[0]]);
});

test("[HCF-O004] a false bound source cannot fabricate planned evidence", async () => {
  const falseSpec = createPlannedNodeTestSuiteSpec({
    suiteId: SUITE_SPEC.suiteId,
    declarationIdentity: SUITE_SPEC.declarationIdentity,
    plannedCatalogIdentity: SUITE_SPEC.plannedCatalogIdentity,
    expectedTestNames: SUITE_SPEC.expectedTestNames,
    sources: SUITE_SPEC.sources.map((source) => source.role === "worker"
      ? { ...source, sha256: "0".repeat(64) }
      : source),
  });
  const observation = await runPlannedNodeTestSuiteWithEvidence(
    falseSpec,
    { ...process.env, ...HOSTILE_ENVIRONMENTS[0] },
  );
  assert.equal(observation.accepted, false);
  assert.ok(observation.violations.length > 0);
});
