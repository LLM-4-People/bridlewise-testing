import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { sha256 } from "../../src/kernel/integrity.ts";
import { DATA_CLASSIFICATION } from "../../src/privacy/classification-catalog.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import {
  EXACT_WRITE_LEASE_AUTHORITY_STAGE,
  EXACT_WRITE_LEASE_PATH_ENCODING,
  assertExactWriteAuthorized,
  bindTransientWriteRootCapability,
  compileExactWriteLease,
} from "../../src/modules/effect-boundary/index.ts";
import {
  collectContentAdmissionEvidence,
  contentRegistryBytes,
  createClassificationReceipt,
  createContentAdmissionAuthority,
  createLicenseReceipt,
  prepareContentStoreCandidate,
} from "../../verification/core/artifact-governance/content-store/application.ts";
import {
  CONTENT_BYTE_OWNERSHIP_CONTRACT,
  buildContentPacks,
  createContentBlob,
  parseContentPack,
  readContentBlobBytes,
  readContentPackBytes,
} from "../../verification/core/artifact-governance/content-store/pack.ts";
import { encodeBase64urlBytes } from
  "../../verification/core/artifact-governance/content-store/domain/path-bytes.ts";
import { createContentTree } from
  "../../verification/core/artifact-governance/content-store/tree.ts";
import { compileContentStoreFirstActivation } from
  "../../verification/core/artifact-governance/content-store/node-adapter/index.ts";
import {
  CONTENT_ADDRESSED_EVIDENCE_PATHS,
  buildContentAddressedEvidenceDocuments,
  contentAddressedEvidenceBytes,
} from "../../scripts/tooling/verification/content-addressed-evidence.ts";
import { walk } from "../../scripts/verification/source-walk.ts";

test("content bytes have explicit copy ownership without a deep-freeze claim", () => {
  const input = Buffer.from("owned-alpha", "utf8");
  const blob = createContentBlob(input);
  input.fill(0);
  assert.equal(Buffer.from(readContentBlobBytes(blob)).toString("utf8"), "owned-alpha");

  const firstRead = readContentBlobBytes(blob);
  firstRead.fill(0);
  assert.equal(Buffer.from(readContentBlobBytes(blob)).toString("utf8"), "owned-alpha");
  assert.equal(CONTENT_BYTE_OWNERSHIP_CONTRACT.internalStorage, "module-private-weak-map");
  assert.equal(CONTENT_BYTE_OWNERSHIP_CONTRACT.deepFreezeClaim, "none-for-byte-storage");
});

test("governed evidence projections are canonical byte-stable defensive reads", () => {
  const documents = buildContentAddressedEvidenceDocuments();
  const names = Object.keys(CONTENT_ADDRESSED_EVIDENCE_PATHS).toSorted() as
    (keyof typeof CONTENT_ADDRESSED_EVIDENCE_PATHS)[];
  assert.deepEqual(names, [
    "byte-ownership-regression",
    "pre-ingestion-assessment",
    "write-boundary-incident",
  ]);
  for (const name of names) {
    const first = contentAddressedEvidenceBytes(name);
    const expected = sha256(first);
    first.fill(0);
    assert.equal(sha256(contentAddressedEvidenceBytes(name)), expected);
    assert.match(String((documents[name] as Record<string, unknown>)[
      name === "pre-ingestion-assessment" ? "assessmentIdentity" :
        name === "write-boundary-incident" ? "incidentIdentity" : "regressionIdentity"
    ]), /^[0-9a-f]{64}$/u);
  }
});

test("pooled buffers and subarray views snapshot only their exact bytes", () => {
  const pooled = Buffer.allocUnsafe(64);
  pooled.fill(0x61);
  const view = pooled.subarray(7, 19);
  const blob = createContentBlob(view);
  pooled.fill(0x62);
  assert.equal(blob.byteLength, 12);
  assert.deepEqual(readContentBlobBytes(blob), new Uint8Array(12).fill(0x61));
});

test("pack ingress and every exported byte read are alias resistant", () => {
  const source = new Uint8Array([0, 1, 2, 3, 4]);
  const blob = createContentBlob(source);
  const pack = buildContentPacks([blob], 256)[0]!;
  source.fill(9);
  const firstPackRead = readContentPackBytes(pack);
  const expectedPackSha256 = sha256(firstPackRead);
  firstPackRead.fill(0);
  assert.equal(sha256(readContentPackBytes(pack)), expectedPackSha256);

  const parserInput = readContentPackBytes(pack);
  const parsed = parseContentPack(parserInput, 256);
  parserInput.fill(0);
  assert.equal(sha256(readContentPackBytes(parsed)), parsed.sha256);
});

test("parallel defensive reads remain stable", async () => {
  const blob = createContentBlob(Buffer.from("parallel-stability", "utf8"));
  const pack = buildContentPacks([blob], 256)[0]!;
  const expected = pack.sha256;
  const observed = await Promise.all(Array.from({ length: 64 }, async () => {
    await Promise.resolve();
    const bytes = readContentPackBytes(pack);
    const digest = sha256(bytes);
    bytes.fill(0);
    return digest;
  }));
  assert.deepEqual([...new Set(observed)], [expected]);
  assert.equal(sha256(readContentPackBytes(pack)), expected);
});

test("exact write leases reject rather than normalize logical targets", () => {
  const root = bindTransientWriteRootCapability(Object.freeze({ testScope: "root-a" }));
  const effect = { operation: "write-file" as const, relativePath: "objects/aa/payload.pack" };
  const lease = compileExactWriteLease(root, [effect]);
  assert.equal(lease.authorityStage, EXACT_WRITE_LEASE_AUTHORITY_STAGE);
  assert.equal(lease.pathEncoding, EXACT_WRITE_LEASE_PATH_ENCODING);
  assert.doesNotThrow(() => assertExactWriteAuthorized(lease, root, effect));
  assert.throws(
    () => assertExactWriteAuthorized(
      lease,
      root,
      { ...effect, relativePath: "objects/aa/other.pack" },
    ),
    (error: unknown) => error instanceof Error &&
      "code" in error && error.code === "effect_write_target_unleased",
  );
  assert.throws(
    () => compileExactWriteLease(root, [{
      operation: "write-file",
      relativePath: "objects/e\u0301.pack",
    }]),
    (error: unknown) => error instanceof Error &&
      "code" in error && error.code === "effect_write_target_noncanonical",
  );
});

test("root capabilities and leases deny serialization without path commitments", () => {
  const left = bindTransientWriteRootCapability(Object.freeze({ protected: "left" }));
  const right = bindTransientWriteRootCapability(Object.freeze({ protected: "right" }));
  const effect = { operation: "publish-file" as const, relativePath: "objects/aa/payload.pack" };
  const leftLease = compileExactWriteLease(left, [effect]);
  const rightLease = compileExactWriteLease(right, [effect]);
  assert.equal(leftLease.writeSetIdentity, rightLease.writeSetIdentity);
  assert.throws(() => JSON.stringify(left), /not serializable/u);
  assert.throws(() => JSON.stringify(leftLease), /not serializable/u);
  assert.throws(
    () => assertExactWriteAuthorized(leftLease, right, effect),
    (error: unknown) => error instanceof Error &&
      "code" in error && error.code === "effect_write_lease_invalid",
  );
});

test("closed classification and license evidence admits an exact synthetic blob set", () => {
  const blob = createContentBlob(Buffer.from("licensed-content", "utf8"));
  const tree = createContentTree([{
    kind: "file",
    mode: 0o640,
    pathSegmentsBase64url: [encodeBase64urlBytes(Buffer.from("payload.bin"))],
    byteLength: blob.byteLength,
    blobSha256: blob.sha256,
  }]);
  const authority = createContentAdmissionAuthority({
    classificationProviderIdentity: "a".repeat(64),
    licenseProviderIdentity: "b".repeat(64),
  });
  const evidence = collectContentAdmissionEvidence([blob], {
    classification: {
      providerIdentity: authority.classificationProviderIdentity,
      policyIdentity: authority.classificationPolicyIdentity,
      schemaIdentity: authority.classificationSchemaIdentity,
      collect: (blobs) => blobs.map((candidate) => createClassificationReceipt({
        blobSha256: candidate.sha256,
        scannerRevision: "synthetic-classifier/v1",
        decision: "admit",
        classificationId: DATA_CLASSIFICATION.public,
        artifactExclusionId: null,
        blockReason: null,
      })),
    },
    license: {
      providerIdentity: authority.licenseProviderIdentity,
      policyIdentity: authority.licensePolicyIdentity,
      schemaIdentity: authority.licenseSchemaIdentity,
      collect: (blobs) => blobs.map((candidate) => createLicenseReceipt({
        blobSha256: candidate.sha256,
        decision: "admit",
        licenseExpression: "MIT",
        licenseTextSha256: sha256("synthetic-license"),
        noticeTextSha256: sha256("synthetic-notice"),
        externalLeaseIdentity: sha256("synthetic-external-lease"),
      })),
    },
  });
  const stages: string[] = [];
  const result = prepareContentStoreCandidate({
    tree,
    blobs: [blob],
    authority,
    evidence,
    packCeilingBytes: 512,
    onBuildStage: (stage) => stages.push(stage),
  });
  assert.equal(result.status, "admitted");
  assert.deepEqual(stages, ["pack", "tree-document", "registry"]);
  assert.equal(result.candidate.registry.packs.length, 1);
  assert.equal(sha256(contentRegistryBytes(result.candidate.registry)).length, 64);
});

test("synthetic UUIDv4 attempts are canonical but grant no uniqueness or chronology claim", () => {
  const candidate = admittedCandidateForContract();
  const root = bindTransientWriteRootCapability(Object.freeze({ contract: "attempt-root" }));
  const first = compileContentStoreFirstActivation(
    root,
    candidate,
    "00000000-0000-4000-8000-000000000001",
  ).plan;
  const second = compileContentStoreFirstActivation(
    root,
    candidate,
    "00000000-0000-4000-8000-000000000002",
  ).plan;
  assert.equal(first.planIdentity, second.planIdentity);
  assert.notEqual(first.transactionId, second.transactionId);
  assert.equal(first.attemptAuthority, "caller-supplied-synthetic-unadmitted");
  assert.equal(first.attemptChronologyClaim, false);
  const canonicalNumeric = "00000000-0000-4000-8000-000000000001";
  const canonicalAlphabetic = "00000000-0000-4000-8000-00000000000a";
  for (const [original, mutant] of [
    [canonicalNumeric, "00000000-0000-0000-0000-000000000000"],
    [canonicalNumeric, "00000000-0000-1000-8000-000000000001"],
    [canonicalNumeric, "00000000-0000-4000-7000-000000000001"],
    [canonicalNumeric, "00000000-0000-4000-c000-000000000001"],
    [canonicalNumeric, "00000000-0000-4000-8000-00000000001"],
    [canonicalAlphabetic, canonicalAlphabetic.toUpperCase()],
  ] as const) {
    assertNonVacuousMutant(original, mutant);
    assert.throws(
      () => compileContentStoreFirstActivation(root, candidate, mutant),
      (error: unknown) => error instanceof Error && "code" in error &&
        error.code === "content_store_attempt_identity_invalid",
    );
  }
});

test("content-store modules preserve responsibility imports acyclicity and sole registries", () => {
  const policy = ROOT_POLICY.artifactGovernance.contentAddressedEvidence.modularStructure;
  assert.equal(policy.lineCountDisposition, "diagnostic-only-no-pass-fail-threshold");
  assert.equal("provisionalMaximumModuleLines" in policy, false);
  assert.equal(
    policy.admissionOracle,
    "responsibility-import-export-cycle-and-duplicate-authority-contracts",
  );
  const structuralPolicy = policy as Readonly<Record<string, unknown>>;
  const passFailLineThresholdKeys = Object.keys(structuralPolicy).filter((key) =>
    /(?:maximum.*line|line.*(?:limit|threshold))/iu.test(key) && key !== "lineCountDisposition"
  );
  assert.equal(
    passFailLineThresholdKeys.length === 0 ||
      (typeof structuralPolicy.lineThresholdQualificationReference === "string" &&
        structuralPolicy.lineThresholdQualificationReference.length > 0),
    true,
  );

  const root = fileURLToPath(new URL(
    "../../verification/core/artifact-governance/content-store/",
    import.meta.url,
  ));
  const sources = recursiveTypeScriptSources(root);
  const byBase = new Map(sources.map((path) => [path, readFileSync(path, "utf8")]));
  const combined = [...byBase.values()].join("\n");
  assert.equal(count(combined, "export const CONTENT_STORE_JOURNAL_PHASE_REGISTRY ="), 1);
  assert.equal(count(combined, "export const CONTENT_STORE_FIRST_ACTIVATION_STAGE_REGISTRY ="), 1);
  assert.equal(count(combined, "export function evaluateContentAdmissionForCandidateInternal("), 1);
  assert.equal(count(combined, "export const CLASSIFICATION_EVIDENCE_SCHEMA_VERSION ="), 1);

  const application = readFileSync(resolve(root, "application.ts"), "utf8");
  assert.equal(/\bfunction\b/u.test(application), false);
  assert.equal(application.includes("node:"), false);
  const transaction = readFileSync(resolve(root, "node-adapter/transaction.ts"), "utf8");
  assert.equal(transaction.includes("node:"), false);
  assert.equal(transaction.includes("durable-filesystem"), false);
  const transactionState = readFileSync(resolve(root, "node-adapter/transaction-state.ts"), "utf8");
  assert.equal(transactionState.includes("durable-filesystem-internal"), false);
  for (const forbidden of ["fsync", "rename", "unlink", "rmSync", "node:fs"]) {
    assert.equal(transactionState.includes(forbidden), false);
  }
  const durableFacadeImporters = [...byBase.entries()]
    .filter(([, text]) => text.includes("src/filesystem/durable-filesystem.ts"))
    .map(([path]) => path.slice(root.length))
    .toSorted();
  assert.deepEqual(durableFacadeImporters, ["node-adapter/transaction-state.ts"]);
  const transactionSources = [...byBase.entries()]
    .filter(([path]) => /\/node-adapter\/transaction(?:-[^/]+)?\.ts$/u.test(path))
    .map(([, text]) => text)
    .join("\n");
  assert.equal(/\.(?:stack|cause)\b/u.test(transactionSources), false);
  assert.equal(
    ROOT_POLICY.artifactGovernance.contentAddressedEvidence.writeBoundary
      .rawStackOrCauseInPublicErrorProjectionAllowed,
    false,
  );
  assert.equal(
    ROOT_POLICY.artifactGovernance.contentAddressedEvidence.writeBoundary
      .fullPiiLogSanitizationAvailable,
    false,
  );
  assert.deepEqual(findRelativeImportCycles(sources), []);
});

function admittedCandidateForContract() {
  const blob = createContentBlob(Buffer.from("contract-candidate", "utf8"));
  const tree = createContentTree([{
    kind: "file",
    mode: 0o640,
    pathSegmentsBase64url: [encodeBase64urlBytes(Buffer.from("payload.bin"))],
    byteLength: blob.byteLength,
    blobSha256: blob.sha256,
  }]);
  const authority = createContentAdmissionAuthority({
    classificationProviderIdentity: "c".repeat(64),
    licenseProviderIdentity: "d".repeat(64),
  });
  const evidence = collectContentAdmissionEvidence([blob], {
    classification: {
      providerIdentity: authority.classificationProviderIdentity,
      policyIdentity: authority.classificationPolicyIdentity,
      schemaIdentity: authority.classificationSchemaIdentity,
      collect: () => [createClassificationReceipt({
        blobSha256: blob.sha256,
        scannerRevision: "synthetic-contract-classifier/v1",
        decision: "admit",
        classificationId: DATA_CLASSIFICATION.public,
        artifactExclusionId: null,
        blockReason: null,
      })],
    },
    license: {
      providerIdentity: authority.licenseProviderIdentity,
      policyIdentity: authority.licensePolicyIdentity,
      schemaIdentity: authority.licenseSchemaIdentity,
      collect: () => [createLicenseReceipt({
        blobSha256: blob.sha256,
        decision: "admit",
        licenseExpression: "MIT",
        licenseTextSha256: sha256("contract-license"),
        noticeTextSha256: sha256("contract-notice"),
        externalLeaseIdentity: sha256("contract-external-lease"),
      })],
    },
  });
  const prepared = prepareContentStoreCandidate({
    tree,
    blobs: [blob],
    authority,
    evidence,
    packCeilingBytes: 512,
  });
  if (prepared.status !== "admitted") throw new Error("contract candidate blocked");
  return prepared.candidate;
}

function recursiveTypeScriptSources(root: string): readonly string[] {
  return walk(root, { exts: [".ts"] }).toSorted();
}

function findRelativeImportCycles(sources: readonly string[]): readonly string[] {
  const known = new Set(sources);
  const graph = new Map<string, readonly string[]>();
  for (const source of sources) {
    const text = readFileSync(source, "utf8");
    const dependencies = [...text.matchAll(/from\s+["'](\.[^"']+)["']/gu)]
      .map((match) => resolve(dirname(source), match[1]!))
      .filter((path) => known.has(path));
    graph.set(source, dependencies);
  }
  const active = new Set<string>();
  const complete = new Set<string>();
  const cycles = new Set<string>();
  const visit = (source: string, trail: readonly string[]): void => {
    if (active.has(source)) {
      cycles.add([...trail.slice(trail.indexOf(source)), source].map((path) => path.slice(path.lastIndexOf("/") + 1)).join("->"));
      return;
    }
    if (complete.has(source)) return;
    active.add(source);
    for (const dependency of graph.get(source) ?? []) visit(dependency, [...trail, source]);
    active.delete(source);
    complete.add(source);
  };
  for (const source of sources) visit(source, []);
  return [...cycles].toSorted();
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function assertNonVacuousMutant(original: string, mutant: string): void {
  assert.notEqual(Buffer.from(mutant, "utf8").toString("hex"), Buffer.from(original, "utf8").toString("hex"));
}
