import { writeSync } from "node:fs";
import { arch, argv, cwd, platform, version, versions } from "node:process";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { buildCandidateManifest, candidateTestIdentity } from "./candidate-manifest.ts";
import {
  createInventoryTestAccountant,
  executeInventoryTestRun,
} from "./inventory-test-run.ts";
import { PLANNED_NODE_TEST_PROTOCOL } from "./planned-node-test.ts";
import {
  buildTestInventory,
  type TestInventory,
} from "../test-inventory.ts";
import {
  createTestReceipt,
  createTestResultReceipt,
  type TestResultReceipt,
} from "./test-receipt.ts";
import {
  createTestSurfaceDispositionManifest,
} from "../verification/test-surface.ts";
import { readSafeRepositoryFile } from "../verification/safe-repository-reader.ts";
import { readNodeRuntimeCapabilities } from "../../src/runtime/runtime-capabilities.ts";
import {
  canonicalHash,
  canonicalJson,
  deepFreeze,
  sha256,
  type DeepReadonly,
} from "../../src/kernel/integrity.ts";
import { assertNoDuplicateJsonObjectKeys } from "../../src/kernel/json-integrity.ts";
import { extractErrorMessage } from "../../src/kernel/errors.ts";
import { relativePathViolationKinds } from "../../src/filesystem/path-boundary.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";

const SHA256 = z.string().regex(/^[0-9a-f]{64}$/u);
const SOURCE_ROLE = z.enum([
  "catalog",
  "domain-oracle",
  "evidence-executor",
  "shared-executor",
  "worker",
]);
const CORPUS_KIND = z.enum([
  "unicode-case-folding-cf",
  "unicode-normalization-test",
]);
const NONNEGATIVE_INTEGER = z.number().int().nonnegative();
const FACTS_SCHEMA = z.record(z.string().min(1), NONNEGATIVE_INTEGER);
const SOURCE_BINDING_SCHEMA = z.strictObject({
  role: SOURCE_ROLE,
  path: z.string().min(1).refine(isSafeRelativePath),
  byteLength: NONNEGATIVE_INTEGER,
  sha256: SHA256,
});
const CORPUS_BINDING_SCHEMA = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/u),
  kind: CORPUS_KIND,
  path: z.string().min(1).refine(isSafeRelativePath),
  byteLength: NONNEGATIVE_INTEGER,
  sha256: SHA256,
  facts: FACTS_SCHEMA,
});
const SUITE_SPEC_SCHEMA = z.strictObject({
  schemaVersion: z.literal(PLANNED_NODE_TEST_PROTOCOL.suiteSpecSchemaVersion),
  integrityClaim: z.literal(PLANNED_NODE_TEST_PROTOCOL.integrityClaim),
  qualificationDisposition: z.literal(PLANNED_NODE_TEST_PROTOCOL.qualificationDisposition),
  repositoryAdmissionAllowed: z.literal(PLANNED_NODE_TEST_PROTOCOL.repositoryAdmissionAllowed),
  suiteId: z.string().regex(/^[a-z][a-z0-9-]*$/u),
  declarationIdentity: SHA256,
  plannedCatalogIdentity: SHA256,
  catalogIdentity: SHA256,
  expectedTestNames: z.array(z.string().min(1)).min(1),
  sources: z.array(SOURCE_BINDING_SCHEMA).min(4),
  corpora: z.array(CORPUS_BINDING_SCHEMA),
  integrityHash: SHA256,
});
const INVENTORY_SNAPSHOT_SCHEMA = z.strictObject({
  schemaVersion: z.literal(ROOT_POLICY.verification.testInventorySchema),
  inventoryHash: SHA256,
  byteLength: NONNEGATIVE_INTEGER,
  sha256: SHA256,
  testCount: z.number().int().positive(),
});
const CANDIDATE_IDENTITY_SCHEMA = z.strictObject({
  manifestSchemaVersion: z.string().min(1),
  formatPolicyRevision: z.string().min(1),
  semanticTreeHash: SHA256,
  formatVerificationHash: SHA256,
});
const EVIDENCE_SCHEMA = z.strictObject({
  schemaVersion: z.literal(PLANNED_NODE_TEST_PROTOCOL.evidenceSchemaVersion),
  integrityClaim: z.literal(PLANNED_NODE_TEST_PROTOCOL.integrityClaim),
  qualificationDisposition: z.literal(PLANNED_NODE_TEST_PROTOCOL.qualificationDisposition),
  repositoryAdmissionAllowed: z.literal(PLANNED_NODE_TEST_PROTOCOL.repositoryAdmissionAllowed),
  suiteId: z.string().regex(/^[a-z][a-z0-9-]*$/u),
  suiteSpecIntegrityHash: SHA256,
  catalogIdentity: SHA256,
  sourcesBefore: z.array(SOURCE_BINDING_SCHEMA).min(4),
  sourcesAfter: z.array(SOURCE_BINDING_SCHEMA).min(4),
  corporaBefore: z.array(CORPUS_BINDING_SCHEMA),
  corporaAfter: z.array(CORPUS_BINDING_SCHEMA),
  candidateBefore: CANDIDATE_IDENTITY_SCHEMA,
  candidateAfter: CANDIDATE_IDENTITY_SCHEMA,
  inventoryBefore: INVENTORY_SNAPSHOT_SCHEMA,
  inventoryAfter: INVENTORY_SNAPSHOT_SCHEMA,
  outputOnlyAccountingRejected: z.literal(true),
  runtime: z.strictObject({
    disposition: z.literal(PLANNED_NODE_TEST_PROTOCOL.childRuntimeDisposition),
    node: z.string().min(1),
    platform: z.string().min(1),
    architecture: z.string().min(1),
    cwd: z.string().min(1),
    v8: z.string().min(1),
    unicode: z.string().optional(),
    icu: z.string().optional(),
    argv: z.array(z.string()).min(3),
  }),
  result: z.strictObject({
    schemaVersion: z.literal(ROOT_POLICY.receipts.testExecution.resultSchemaVersion),
    integrityHash: SHA256,
    status: z.enum(["passed", "failed"]),
  }),
  integrityHash: SHA256,
});

export type PlannedNodeTestSourceBinding = Readonly<z.infer<typeof SOURCE_BINDING_SCHEMA>>;
export type PlannedNodeTestCorpusBinding = DeepReadonly<z.infer<typeof CORPUS_BINDING_SCHEMA>>;
export type PlannedNodeTestSuiteSpec = DeepReadonly<z.infer<typeof SUITE_SPEC_SCHEMA>>;
export type PlannedNodeTestInventorySnapshot = Readonly<z.infer<typeof INVENTORY_SNAPSHOT_SCHEMA>>;
export type PlannedNodeTestEvidence = DeepReadonly<z.infer<typeof EVIDENCE_SCHEMA>>;

export function createPlannedNodeTestSourceBinding(
  root: string,
  role: PlannedNodeTestSourceBinding["role"],
  path: string,
): PlannedNodeTestSourceBinding {
  const read = readBoundRepositoryFile(root, path);
  return deepFreeze({ role, path, byteLength: read.bytes.length, sha256: sha256(read.bytes) });
}

export function createPlannedNodeTestCorpusBinding(
  root: string,
  id: string,
  kind: PlannedNodeTestCorpusBinding["kind"],
  path: string,
): PlannedNodeTestCorpusBinding {
  const read = readBoundRepositoryFile(root, path);
  return parseCorpusBinding({
    id,
    kind,
    path,
    byteLength: read.bytes.length,
    sha256: sha256(read.bytes),
    facts: measureCorpus(kind, read.bytes),
  });
}

export function plannedNodeTestBoundCatalogIdentity(input: Readonly<{
  declarationIdentity: string;
  plannedCatalogIdentity: string;
  expectedTestNames: readonly string[];
  sources: readonly PlannedNodeTestSourceBinding[];
}>): string {
  return canonicalHash({
    domain: "planned-node-test-bound-catalog/v1",
    declarationIdentity: input.declarationIdentity,
    plannedCatalogIdentity: input.plannedCatalogIdentity,
    expectedTestNames: input.expectedTestNames,
    sources: input.sources.filter((source) =>
      source.role === "catalog" || source.role === "domain-oracle"
    ),
  });
}

export function createPlannedNodeTestSuiteSpec(input: Readonly<{
  suiteId: string;
  declarationIdentity: string;
  plannedCatalogIdentity: string;
  expectedTestNames: readonly string[];
  sources: readonly PlannedNodeTestSourceBinding[];
  corpora?: readonly PlannedNodeTestCorpusBinding[];
}>): PlannedNodeTestSuiteSpec {
  const sources = [...input.sources];
  const corpora = [...(input.corpora ?? [])];
  const unsigned = {
    schemaVersion: PLANNED_NODE_TEST_PROTOCOL.suiteSpecSchemaVersion,
    integrityClaim: PLANNED_NODE_TEST_PROTOCOL.integrityClaim,
    qualificationDisposition: PLANNED_NODE_TEST_PROTOCOL.qualificationDisposition,
    repositoryAdmissionAllowed: PLANNED_NODE_TEST_PROTOCOL.repositoryAdmissionAllowed,
    suiteId: input.suiteId,
    declarationIdentity: input.declarationIdentity,
    plannedCatalogIdentity: input.plannedCatalogIdentity,
    catalogIdentity: plannedNodeTestBoundCatalogIdentity({ ...input, sources }),
    expectedTestNames: [...input.expectedTestNames],
    sources,
    corpora,
  } as const;
  return parsePlannedNodeTestSuiteSpec({ ...unsigned, integrityHash: canonicalHash(unsigned) });
}

export function parsePlannedNodeTestSuiteSpec(value: unknown): PlannedNodeTestSuiteSpec {
  const parsed = SUITE_SPEC_SCHEMA.parse(value);
  const { integrityHash, ...unsigned } = parsed;
  if (canonicalHash(unsigned) !== integrityHash) throw new Error("planned_node_test_spec_integrity_invalid");
  assertSpecSemantics(parsed);
  return deepFreeze(parsed) as PlannedNodeTestSuiteSpec;
}

export function parsePlannedNodeTestSuiteSpecText(text: string): PlannedNodeTestSuiteSpec {
  assertNoDuplicateJsonObjectKeys(
    text,
    "Planned Node test suite spec has duplicate keys",
    "planned_node_test_spec_key_duplicate",
  );
  const parsed = parsePlannedNodeTestSuiteSpec(JSON.parse(text) as unknown);
  if (canonicalJson(parsed) !== text) throw new Error("planned_node_test_spec_bytes_noncanonical");
  return parsed;
}

export function buildPlannedNodeTestInventory(
  root: string,
  spec: PlannedNodeTestSuiteSpec,
): TestInventory {
  const worker = onlySource(spec, "worker");
  const dispositionManifest = createTestSurfaceDispositionManifest([{
    path: worker.path,
    language: "javascript-typescript",
    disposition: "canonical-node-test",
    rationale: "Isolated normal v4 inventory qualification; never repository admission.",
    evidenceLinks: [],
    blocksFullRepositoryClaim: false,
  }]);
  const inventory = buildTestInventory(root, { dispositionManifest });
  if (canonicalHash(inventory.tests.map((entry) => entry.name)) !==
    canonicalHash(spec.expectedTestNames)) {
    throw new Error("planned_node_test_worker_catalog_mismatch");
  }
  if (canonicalHash(inventory.scope.canonicalNodeSourceIds) !== canonicalHash([worker.path]) ||
    inventory.tests.some((entry) => entry.sourceId !== worker.path || entry.sourceHash !== worker.sha256)) {
    throw new Error("planned_node_test_inventory_source_mismatch");
  }
  return inventory;
}

export function plannedNodeTestInventorySnapshot(
  inventory: TestInventory,
): PlannedNodeTestInventorySnapshot {
  const bytes = Buffer.from(canonicalJson(inventory), "utf8");
  return deepFreeze({
    schemaVersion: inventory.schemaVersion,
    inventoryHash: inventory.inventoryHash,
    byteLength: bytes.length,
    sha256: sha256(bytes),
    testCount: inventory.tests.length,
  });
}

export function parsePlannedNodeTestEvidenceBytes(bytesInput: Uint8Array): PlannedNodeTestEvidence {
  const bytes = Buffer.from(bytesInput);
  if (bytes.length === 0 || bytes.includes(0) || bytes.at(-1) !== 0x0a || bytes.at(-2) === 0x0a) {
    throw new Error("planned_node_test_evidence_framing_invalid");
  }
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) throw new Error("planned_node_test_evidence_bom_invalid");
  assertNoDuplicateJsonObjectKeys(
    text,
    "Planned Node test evidence has duplicate keys",
    "planned_node_test_evidence_key_duplicate",
  );
  const parsed = EVIDENCE_SCHEMA.parse(JSON.parse(text) as unknown);
  const { integrityHash, ...unsigned } = parsed;
  if (`${canonicalJson(parsed)}\n` !== text || canonicalHash(unsigned) !== integrityHash) {
    throw new Error("planned_node_test_evidence_integrity_invalid");
  }
  return deepFreeze(parsed) as PlannedNodeTestEvidence;
}

export function plannedNodeTestReproducibilityIdentity(
  evidence: PlannedNodeTestEvidence,
): string {
  return canonicalHash({
    domain: "planned-node-test-reproducibility/v1",
    schemaVersion: evidence.schemaVersion,
    integrityClaim: evidence.integrityClaim,
    qualificationDisposition: evidence.qualificationDisposition,
    repositoryAdmissionAllowed: evidence.repositoryAdmissionAllowed,
    suiteId: evidence.suiteId,
    suiteSpecIntegrityHash: evidence.suiteSpecIntegrityHash,
    catalogIdentity: evidence.catalogIdentity,
    sourcesBefore: evidence.sourcesBefore,
    sourcesAfter: evidence.sourcesAfter,
    corporaBefore: evidence.corporaBefore,
    corporaAfter: evidence.corporaAfter,
    candidateBefore: evidence.candidateBefore,
    candidateAfter: evidence.candidateAfter,
    inventoryBefore: evidence.inventoryBefore,
    inventoryAfter: evidence.inventoryAfter,
    outputOnlyAccountingRejected: evidence.outputOnlyAccountingRejected,
    runtime: {
      disposition: evidence.runtime.disposition,
      node: evidence.runtime.node,
      platform: evidence.runtime.platform,
      architecture: evidence.runtime.architecture,
      v8: evidence.runtime.v8,
      ...(evidence.runtime.unicode === undefined ? {} : { unicode: evidence.runtime.unicode }),
      ...(evidence.runtime.icu === undefined ? {} : { icu: evidence.runtime.icu }),
    },
    result: evidence.result,
  });
}

export async function executePlannedNodeTestEvidenceWorker(
  spec: PlannedNodeTestSuiteSpec,
): Promise<Readonly<{
  evidence: PlannedNodeTestEvidence;
  result: TestResultReceipt;
  exitCode: 0 | 1;
}>> {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const sourcesBefore = snapshotSources(root, spec);
  const corporaBefore = snapshotCorpora(root, spec);
  const inventoryBeforeValue = buildPlannedNodeTestInventory(root, spec);
  const inventoryBefore = plannedNodeTestInventorySnapshot(inventoryBeforeValue);
  const candidateBefore = candidateTestIdentity(buildCandidateManifest(root));
  const outputOnlyAccounting = createInventoryTestAccountant(root, inventoryBeforeValue).complete();
  if (outputOnlyAccounting.passed || outputOnlyAccounting.counts.discovered !== 0 ||
    outputOnlyAccounting.counts.passed !== 0) {
    throw new Error("planned_node_test_output_only_accounting_accepted");
  }

  const accounting = await executeInventoryTestRun(root, inventoryBeforeValue);

  const candidateAfter = candidateTestIdentity(buildCandidateManifest(root));
  const inventoryAfterValue = buildPlannedNodeTestInventory(root, spec);
  const inventoryAfter = plannedNodeTestInventorySnapshot(inventoryAfterValue);
  const corporaAfter = snapshotCorpora(root, spec);
  const sourcesAfter = snapshotSources(root, spec);
  if (canonicalHash(inventoryBefore) !== canonicalHash(inventoryAfter) ||
    canonicalHash(sourcesBefore) !== canonicalHash(sourcesAfter) ||
    canonicalHash(corporaBefore) !== canonicalHash(corporaAfter)) {
    throw new Error("planned_node_test_bound_snapshot_changed");
  }

  const testReceipt = createTestReceipt(
    candidateBefore,
    inventoryBeforeValue,
    accounting.discoveredIds,
    accounting.passedIds,
    accounting.counts,
  );
  const result = createTestResultReceipt(
    testReceipt,
    accounting.runnerSummary,
    candidateAfter,
    accounting.failures,
    accounting.unknownTests,
    accounting.failureDetails,
    accounting.skips,
  );
  const runtimeCapabilities = readNodeRuntimeCapabilities();
  const unsigned = {
    schemaVersion: PLANNED_NODE_TEST_PROTOCOL.evidenceSchemaVersion,
    integrityClaim: PLANNED_NODE_TEST_PROTOCOL.integrityClaim,
    qualificationDisposition: PLANNED_NODE_TEST_PROTOCOL.qualificationDisposition,
    repositoryAdmissionAllowed: PLANNED_NODE_TEST_PROTOCOL.repositoryAdmissionAllowed,
    suiteId: spec.suiteId,
    suiteSpecIntegrityHash: spec.integrityHash,
    catalogIdentity: spec.catalogIdentity,
    sourcesBefore,
    sourcesAfter,
    corporaBefore,
    corporaAfter,
    candidateBefore,
    candidateAfter,
    inventoryBefore,
    inventoryAfter,
    outputOnlyAccountingRejected: true as const,
    runtime: {
      disposition: PLANNED_NODE_TEST_PROTOCOL.childRuntimeDisposition,
      node: version,
      platform,
      architecture: arch,
      cwd: cwd(),
      v8: versions.v8,
      ...(runtimeCapabilities.unicodeVersion === undefined
        ? {} : { unicode: runtimeCapabilities.unicodeVersion }),
      ...(runtimeCapabilities.icuVersion === undefined
        ? {} : { icu: runtimeCapabilities.icuVersion }),
      argv: [...argv],
    },
    result: {
      schemaVersion: result.schemaVersion,
      integrityHash: result.integrityHash,
      status: result.result.status,
    },
  } as const;
  const evidence = parsePlannedNodeTestEvidenceValue({
    ...unsigned,
    integrityHash: canonicalHash(unsigned),
  });
  return deepFreeze({ evidence, result, exitCode: result.result.exitCode });
}

function parsePlannedNodeTestEvidenceValue(value: unknown): PlannedNodeTestEvidence {
  const parsed = EVIDENCE_SCHEMA.parse(value);
  const { integrityHash, ...unsigned } = parsed;
  if (canonicalHash(unsigned) !== integrityHash) {
    throw new Error("planned_node_test_evidence_integrity_invalid");
  }
  return deepFreeze(parsed) as PlannedNodeTestEvidence;
}

function snapshotSources(
  root: string,
  spec: PlannedNodeTestSuiteSpec,
): readonly PlannedNodeTestSourceBinding[] {
  return deepFreeze(spec.sources.map((binding) => {
    const read = readBoundRepositoryFile(root, binding.path);
    assertSourceMatches(binding, read.bytes);
    return { ...binding };
  }));
}

function snapshotCorpora(
  root: string,
  spec: PlannedNodeTestSuiteSpec,
): readonly PlannedNodeTestCorpusBinding[] {
  return deepFreeze(spec.corpora.map((binding) => {
    const read = readBoundRepositoryFile(root, binding.path);
    const observed = parseCorpusBinding({
      ...binding,
      byteLength: read.bytes.length,
      sha256: sha256(read.bytes),
      facts: measureCorpus(binding.kind, read.bytes),
    });
    if (canonicalHash(observed) !== canonicalHash(binding)) {
      throw new Error(`planned_node_test_corpus_binding_mismatch:${binding.id}`);
    }
    return observed;
  }));
}

function parseCorpusBinding(value: unknown): PlannedNodeTestCorpusBinding {
  const parsed = CORPUS_BINDING_SCHEMA.parse(value);
  const expectedKeys = parsed.kind === "unicode-case-folding-cf"
    ? ["entries", "uniqueSourceCodePoints"]
    : ["assertions", "assertionsPerRow", "rows"];
  if (canonicalHash(Object.keys(parsed.facts).toSorted()) !== canonicalHash(expectedKeys)) {
    throw new Error(`planned_node_test_corpus_facts_invalid:${parsed.id}`);
  }
  return deepFreeze(parsed) as PlannedNodeTestCorpusBinding;
}

function measureCorpus(
  kind: PlannedNodeTestCorpusBinding["kind"],
  bytes: Buffer,
): Readonly<Record<string, number>> {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) throw new Error("planned_node_test_corpus_bom_invalid");
  if (kind === "unicode-case-folding-cf") {
    const sourceCodePoints: string[] = [];
    for (const line of text.split("\n")) {
      const match = /^([0-9A-F]+); ([CF]); ([0-9A-F ]+);/u.exec(line);
      if (match?.[1] !== undefined) sourceCodePoints.push(match[1]);
    }
    return deepFreeze({
      entries: sourceCodePoints.length,
      uniqueSourceCodePoints: new Set(sourceCodePoints).size,
    });
  }
  let rows = 0;
  let assertions = 0;
  let assertionsPerRow: number | undefined;
  for (const line of text.split("\n")) {
    const data = line.split("#", 1)[0]!.trim();
    if (data.length === 0 || data.startsWith("@")) continue;
    const fields = data.split(";").slice(0, 5).map((field) => field.trim());
    if (fields.length !== 5 || fields.some((field) =>
      !/^(?:[0-9A-F]{4,6})(?: [0-9A-F]{4,6})*$/u.test(field)
    )) throw new Error("planned_node_test_normalization_corpus_invalid");
    assertionsPerRow ??= fields.length;
    if (fields.length !== assertionsPerRow) {
      throw new Error("planned_node_test_normalization_corpus_width_invalid");
    }
    rows += 1;
    assertions += fields.length;
  }
  return deepFreeze({ assertions, assertionsPerRow: assertionsPerRow ?? 0, rows });
}

function inventoryWorkerPath(spec: PlannedNodeTestSuiteSpec): string {
  return onlySource(spec, "worker").path;
}

function onlySource(
  spec: PlannedNodeTestSuiteSpec,
  role: PlannedNodeTestSourceBinding["role"],
): PlannedNodeTestSourceBinding {
  const matches = spec.sources.filter((source) => source.role === role);
  if (matches.length !== 1) throw new Error(`planned_node_test_source_role_invalid:${role}`);
  return matches[0]!;
}

function assertSpecSemantics(spec: PlannedNodeTestSuiteSpec): void {
  if (new Set(spec.expectedTestNames).size !== spec.expectedTestNames.length ||
    new Set(spec.sources.map((source) => source.path)).size !== spec.sources.length ||
    new Set(spec.corpora.map((corpus) => corpus.id)).size !== spec.corpora.length ||
    new Set(spec.corpora.map((corpus) => corpus.path)).size !== spec.corpora.length) {
    throw new Error("planned_node_test_spec_duplicate_identity");
  }
  for (const role of ["worker", "catalog", "shared-executor", "evidence-executor"] as const) {
    onlySource(spec, role);
  }
  for (const corpus of spec.corpora) parseCorpusBinding(corpus);
  if (plannedNodeTestBoundCatalogIdentity(spec) !== spec.catalogIdentity) {
    throw new Error("planned_node_test_catalog_identity_invalid");
  }
  const workerPath = inventoryWorkerPath(spec);
  if (!workerPath.startsWith("test/") || !workerPath.endsWith(".test.ts")) {
    throw new Error("planned_node_test_worker_path_unqualified");
  }
}

function assertSourceMatches(binding: PlannedNodeTestSourceBinding, bytes: Buffer): void {
  if (bytes.length !== binding.byteLength || sha256(bytes) !== binding.sha256) {
    throw new Error(`planned_node_test_source_binding_mismatch:${binding.role}`);
  }
}

function readBoundRepositoryFile(root: string, path: string): Readonly<{ bytes: Buffer }> {
  if (!isSafeRelativePath(path)) throw new Error("planned_node_test_source_path_invalid");
  const read = readSafeRepositoryFile(
    root,
    path,
    ROOT_POLICY.verification.candidateFormat.maximumInspectedFileBytes,
  );
  const rootRelative = relative(resolve(root), read.realPath).replaceAll("\\", "/");
  if (rootRelative !== path) throw new Error("planned_node_test_source_path_identity_invalid");
  return Object.freeze({ bytes: read.bytes });
}

function isSafeRelativePath(path: string): boolean {
  return typeof path === "string" && relativePathViolationKinds(path).length === 0;
}

function parseSpecArgument(arguments_: readonly string[]): PlannedNodeTestSuiteSpec {
  if (arguments_.length !== 2 || arguments_[0] !== "--suite-spec" || arguments_[1] === undefined) {
    throw new Error("Usage: planned-node-test-evidence --suite-spec <canonical-json>");
  }
  return parsePlannedNodeTestSuiteSpecText(arguments_[1]);
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  try {
    const execution = await executePlannedNodeTestEvidenceWorker(parseSpecArgument(argv.slice(2)));
    writeSync(3, Buffer.from(`${canonicalJson(execution.result)}\n`, "utf8"));
    process.stdout.write(`${canonicalJson(execution.evidence)}\n`);
    process.exitCode = execution.exitCode;
  } catch (error) {
    process.stderr.write(`${canonicalJson({
      error: "planned_node_test_evidence_setup_failed",
      message: extractErrorMessage(error),
    })}\n`);
    process.exitCode = 1;
  }
}
