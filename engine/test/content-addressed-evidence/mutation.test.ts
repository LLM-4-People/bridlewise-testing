import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { DATA_CLASSIFICATION } from "../../src/privacy/classification-catalog.ts";
import { sha256 } from "../../src/kernel/integrity.ts";
import { compileExactWriteLease } from "../../src/modules/effect-boundary/index.ts";
import {
  collectContentAdmissionEvidence,
  createClassificationReceipt,
  createContentAdmissionAuthority,
  createLicenseReceipt,
  prepareContentStoreCandidate,
  type ContentAdmissionEvidence,
  type ContentEvidenceProvider,
  type ContentStoreCandidate,
} from "../../verification/core/artifact-governance/content-store/application.ts";
import {
  compileContentStoreFirstActivation,
  compileContentStoreSyntheticQualificationLease,
  CONTENT_STORE_SYNTHETIC_QUALIFICATION_RESIDUE_DISPOSITION,
  observeContentRoot,
  publishContentStoreFirstActivation,
  type ContentStoreFirstActivationRequest,
} from "../../verification/core/artifact-governance/content-store/node-adapter/index.ts";
import {
  createRepositoryLocalTemporaryDirectory,
  removeRepositoryLocalTemporaryDirectory,
} from "../support/repository-local-temporary.ts";
import type {
  BlobClassificationReceipt,
  BlobLicenseReceipt,
} from "../../verification/core/artifact-governance/content-store/domain/contracts.ts";
import { encodeBase64urlBytes } from
  "../../verification/core/artifact-governance/content-store/domain/path-bytes.ts";
import {
  buildContentPacks,
  createContentBlob,
  parseContentPack,
  readContentPackBytes,
  type ContentBlob,
} from "../../verification/core/artifact-governance/content-store/pack.ts";
import {
  createContentTree,
  type ContentTree,
} from "../../verification/core/artifact-governance/content-store/tree.ts";

type AdmissionFixture = Readonly<{
  authority: ReturnType<typeof createContentAdmissionAuthority>;
  blobs: readonly ContentBlob[];
  tree: ContentTree;
}>;

function admissionFixture(): AdmissionFixture {
  const blobs = [
    createContentBlob(Buffer.from("first-evidence-blob", "utf8")),
    createContentBlob(Buffer.from("second-evidence-blob", "utf8")),
  ].toSorted((left, right) => left.sha256.localeCompare(right.sha256));
  const tree = createContentTree(blobs.map((blob, index) => ({
    kind: "file" as const,
    mode: 0o640,
    pathSegmentsBase64url: [encodeBase64urlBytes(Buffer.from(`blob-${index}.bin`))],
    byteLength: blob.byteLength,
    blobSha256: blob.sha256,
  })));
  return {
    authority: createContentAdmissionAuthority({
      classificationProviderIdentity: "a".repeat(64),
      licenseProviderIdentity: "b".repeat(64),
    }),
    blobs,
    tree,
  };
}

function admittedProviders(fixture: AdmissionFixture): Readonly<{
  classification: ContentEvidenceProvider<BlobClassificationReceipt>;
  license: ContentEvidenceProvider<BlobLicenseReceipt>;
}> {
  return {
    classification: {
      providerIdentity: fixture.authority.classificationProviderIdentity,
      policyIdentity: fixture.authority.classificationPolicyIdentity,
      schemaIdentity: fixture.authority.classificationSchemaIdentity,
      collect: (blobs) => blobs.map((blob) => createClassificationReceipt({
        blobSha256: blob.sha256,
        scannerRevision: "synthetic-classifier/v1",
        decision: "admit",
        classificationId: DATA_CLASSIFICATION.public,
        artifactExclusionId: null,
        blockReason: null,
      })),
    },
    license: {
      providerIdentity: fixture.authority.licenseProviderIdentity,
      policyIdentity: fixture.authority.licensePolicyIdentity,
      schemaIdentity: fixture.authority.licenseSchemaIdentity,
      collect: (blobs) => blobs.map((blob) => createLicenseReceipt({
        blobSha256: blob.sha256,
        decision: "admit",
        licenseExpression: "MIT",
        licenseTextSha256: sha256("synthetic-license"),
        noticeTextSha256: sha256("synthetic-notice"),
        externalLeaseIdentity: sha256("synthetic-lease"),
      })),
    },
  };
}

function assertAdmissionBlocked(
  fixture: AdmissionFixture,
  evidence: ContentAdmissionEvidence,
  expectedCode: string,
): void {
  const stages: string[] = [];
  const result = prepareContentStoreCandidate({
    tree: fixture.tree,
    blobs: fixture.blobs,
    authority: fixture.authority,
    evidence,
    packCeilingBytes: 512,
    onBuildStage: (stage) => stages.push(stage),
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.candidate, null);
  assert.deepEqual(stages, []);
  assert.equal(result.decision.blockers.some((blocker) => blocker.code === expectedCode), true);
}

test("shared byte storage is rejected before content hashing", () => {
  const shared = new SharedArrayBuffer(8);
  assert.throws(
    () => createContentBlob(new Uint8Array(shared)),
    (error: unknown) => error instanceof Error &&
      "code" in error && error.code === "unsafe_byte_input",
  );
});

test("DataView and bare ArrayBuffer inputs are rejected", () => {
  const bytes = new ArrayBuffer(8);
  assert.throws(
    () => createContentBlob(new DataView(bytes)),
    (error: unknown) => error instanceof Error &&
      "code" in error && error.code === "unsafe_byte_input",
  );
  assert.throws(
    () => createContentBlob(bytes),
    (error: unknown) => error instanceof Error &&
      "code" in error && error.code === "unsafe_byte_input",
  );
});

test("typed-array subclasses and proxies are rejected", () => {
  class DerivedBytes extends Uint8Array {}
  assert.throws(
    () => createContentBlob(new DerivedBytes([1, 2, 3])),
    (error: unknown) => error instanceof Error &&
      "code" in error && error.code === "unsafe_byte_input",
  );
  assert.throws(
    () => createContentBlob(new Proxy(new Uint8Array([1, 2, 3]), {})),
    (error: unknown) => error instanceof Error &&
      "code" in error && error.code === "unsafe_byte_input",
  );
});

test("pack header body and trailer mutations fail closed", () => {
  const blob = createContentBlob(Buffer.from("mutation-target", "utf8"));
  const pack = buildContentPacks([blob], 256)[0]!;
  for (const offset of [0, 60, pack.byteLength - 1]) {
    const mutated = readContentPackBytes(pack);
    mutated[offset] = mutated[offset]! ^ 0x01;
    assert.throws(() => parseContentPack(mutated, 256));
  }
});

test("stale provider policy identities block before every builder stage", () => {
  const fixture = admissionFixture();
  const providers = admittedProviders(fixture);
  const evidence = collectContentAdmissionEvidence(fixture.blobs, {
    ...providers,
    classification: { ...providers.classification, policyIdentity: "f".repeat(64) },
  });
  assertAdmissionBlocked(fixture, evidence, "classification-evidence-invalid");
});

test("wrong blob and raw-match fields invalidate closed classification evidence", () => {
  const fixture = admissionFixture();
  const providers = admittedProviders(fixture);
  const wrongBlobEvidence = collectContentAdmissionEvidence(fixture.blobs, {
    ...providers,
    classification: {
      ...providers.classification,
      collect: () => fixture.blobs.map(() => createClassificationReceipt({
        blobSha256: "c".repeat(64),
        scannerRevision: "synthetic-classifier/v1",
        decision: "admit",
        classificationId: DATA_CLASSIFICATION.public,
        artifactExclusionId: null,
        blockReason: null,
      })),
    },
  });
  assertAdmissionBlocked(fixture, wrongBlobEvidence, "classification-evidence-invalid");

  const rawMatchEvidence = collectContentAdmissionEvidence(fixture.blobs, {
    ...providers,
    classification: {
      ...providers.classification,
      collect: (blobs) => blobs.map((blob) => ({
        ...createClassificationReceipt({
          blobSha256: blob.sha256,
          scannerRevision: "synthetic-classifier/v1",
          decision: "admit",
          classificationId: DATA_CLASSIFICATION.public,
          artifactExclusionId: null,
          blockReason: null,
        }),
        matchedValue: "forbidden-raw-value",
      })) as unknown as readonly BlobClassificationReceipt[],
    },
  });
  assertAdmissionBlocked(fixture, rawMatchEvidence, "classification-evidence-invalid");
});

test("incomplete throwing duplicated and reordered provider outputs fail closed", () => {
  const fixture = admissionFixture();
  const providers = admittedProviders(fixture);
  const goodRows = providers.classification.collect(fixture.blobs);
  const incomplete = collectContentAdmissionEvidence(fixture.blobs, {
    ...providers,
    classification: { ...providers.classification, collect: () => goodRows.slice(0, 1) },
  });
  assertAdmissionBlocked(fixture, incomplete, "classification-receipt-missing");

  const throwing = collectContentAdmissionEvidence(fixture.blobs, {
    ...providers,
    classification: {
      ...providers.classification,
      collect: () => {
        throw new Error("synthetic-provider-failure-without-raw-values");
      },
    },
  });
  assertAdmissionBlocked(fixture, throwing, "classification-provider-failed");

  const duplicated = collectContentAdmissionEvidence(fixture.blobs, {
    ...providers,
    classification: { ...providers.classification, collect: () => [goodRows[0]!, goodRows[0]!] },
  });
  assertAdmissionBlocked(fixture, duplicated, "classification-evidence-invalid");

  const reordered = collectContentAdmissionEvidence(fixture.blobs, {
    ...providers,
    classification: { ...providers.classification, collect: () => goodRows.toReversed() },
  });
  assertAdmissionBlocked(fixture, reordered, "classification-evidence-invalid");
});

test("semantic private and credential classifications remain blocked without exceptions", () => {
  const fixture = admissionFixture();
  const providers = admittedProviders(fixture);
  const cases = [
    {
      classificationId: DATA_CLASSIFICATION.regulatedRestricted,
      artifactExclusionId: null,
      blockReason: "semantic-classification-pending" as const,
      expected: "classification-semantic-pending",
    },
    {
      classificationId: DATA_CLASSIFICATION.userPrivate,
      artifactExclusionId: "raw-personal-conversation-data",
      blockReason: "local-identity" as const,
      expected: "classification-local-identity",
    },
    {
      classificationId: DATA_CLASSIFICATION.credentialSecret,
      artifactExclusionId: "credentials",
      blockReason: "credential-secret" as const,
      expected: "classification-credential-secret",
    },
  ];
  for (const candidate of cases) {
    const evidence = collectContentAdmissionEvidence(fixture.blobs, {
      ...providers,
      classification: {
        ...providers.classification,
        collect: (blobs) => blobs.map((blob) => createClassificationReceipt({
          blobSha256: blob.sha256,
          scannerRevision: "synthetic-classifier/v1",
          decision: "block",
          classificationId: candidate.classificationId,
          artifactExclusionId: candidate.artifactExclusionId,
          blockReason: candidate.blockReason,
        })),
      },
    });
    assertAdmissionBlocked(fixture, evidence, candidate.expected);
  }
});

test("missing SPDX or notice closure blocks before pack registry and filesystem use", () => {
  const fixture = admissionFixture();
  const providers = admittedProviders(fixture);
  const cases = [
    { licenseExpression: null, noticeTextSha256: sha256("synthetic-notice") },
    { licenseExpression: "MIT", noticeTextSha256: null },
  ];
  for (const candidate of cases) {
    const evidence = collectContentAdmissionEvidence(fixture.blobs, {
      ...providers,
      license: {
        ...providers.license,
        collect: (blobs) => blobs.map((blob) => createLicenseReceipt({
          blobSha256: blob.sha256,
          decision: "block",
          licenseExpression: candidate.licenseExpression,
          licenseTextSha256: sha256("synthetic-license"),
          noticeTextSha256: candidate.noticeTextSha256,
          externalLeaseIdentity: sha256("synthetic-lease"),
        })),
      },
    });
    assertAdmissionBlocked(fixture, evidence, "license-closure-incomplete");
  }
});

test("production mode and wrong transaction identity fail before every effect", (context) => {
  const fixture = mutationTransactionFixture(context, 301);
  assertTransactionCode(
    { ...fixture.request, mode: "production" as ContentStoreFirstActivationRequest["mode"] },
    "content_store_production_activation_blocked",
  );
  assertTransactionCode(
    { ...fixture.request, transactionId: "0".repeat(64) },
    "content_store_transaction_identity_invalid",
  );
  assert.deepEqual(readdirSync(fixture.stateRootPath), []);
  assert.deepEqual(readdirSync(fixture.qualificationRootPath), []);
});

test("wrong root incomplete superset and qualification leases fail before every effect", (context) => {
  const fixture = mutationTransactionFixture(context, 302);
  const otherStatePath = join(fixture.fixtureRoot, "other-state");
  mkdirSync(otherStatePath, { mode: 0o700 });
  chmodSync(otherStatePath, 0o700);
  const otherState = observeContentRoot(otherStatePath);
  assertTransactionCode(
    { ...fixture.request, stateRoot: otherState },
    "effect_write_lease_invalid",
  );

  const incomplete = compileExactWriteLease(fixture.request.stateRoot, [{
    operation: "publish-file",
    relativePath: "active.json",
  }]);
  assertTransactionCode(
    { ...fixture.request, stateLease: incomplete },
    "content_store_state_write_lease_plan_mismatch",
  );
  const superset = compileExactWriteLease(fixture.request.stateRoot, [
    ...fixture.request.stateLease.effects,
    { operation: "publish-file", relativePath: "foreign-mutant.json" },
  ]);
  assertTransactionCode(
    { ...fixture.request, stateLease: superset },
    "content_store_state_write_lease_plan_mismatch",
  );

  const wrongQualificationLease = compileExactWriteLease(fixture.request.qualification.root, [{
    operation: "create-directory",
    relativePath: "wrong-qualification",
  }]);
  assertTransactionCode(
    {
      ...fixture.request,
      qualification: { ...fixture.request.qualification, lease: wrongQualificationLease },
    },
    "content_store_qualification_write_lease_plan_mismatch",
  );
  const otherQualificationPath = join(fixture.fixtureRoot, "other-qualification");
  mkdirSync(otherQualificationPath, { mode: 0o700 });
  chmodSync(otherQualificationPath, 0o700);
  const otherQualification = observeContentRoot(otherQualificationPath);
  assertTransactionCode(
    {
      ...fixture.request,
      qualification: { ...fixture.request.qualification, root: otherQualification },
    },
    "effect_write_lease_invalid",
  );
  for (const path of [
    fixture.stateRootPath,
    fixture.qualificationRootPath,
    otherStatePath,
    otherQualificationPath,
  ]) assert.deepEqual(readdirSync(path), []);
});

function mutationTransactionFixture(
  context: TestContext,
  ordinal: number,
): Readonly<{
  candidate: ContentStoreCandidate;
  fixtureRoot: string;
  qualificationRootPath: string;
  request: ContentStoreFirstActivationRequest;
  stateRootPath: string;
}> {
  const fixtureRoot = createRepositoryLocalTemporaryDirectory(`cas-authority-mutation-${ordinal}-`);
  context.after(() => removeRepositoryLocalTemporaryDirectory(fixtureRoot));
  const stateRootPath = join(fixtureRoot, "state-root");
  const qualificationRootPath = join(fixtureRoot, "qualification-root");
  mkdirSync(stateRootPath, { mode: 0o700 });
  mkdirSync(qualificationRootPath, { mode: 0o700 });
  chmodSync(stateRootPath, 0o700);
  chmodSync(qualificationRootPath, 0o700);
  const admission = admissionFixture();
  const evidence = collectContentAdmissionEvidence(admission.blobs, admittedProviders(admission));
  const prepared = prepareContentStoreCandidate({
    tree: admission.tree,
    blobs: admission.blobs,
    authority: admission.authority,
    evidence,
    packCeilingBytes: 512,
  });
  if (prepared.status !== "admitted") throw new Error("mutation candidate blocked");
  const candidate = prepared.candidate;
  const stateRoot = observeContentRoot(stateRootPath);
  const attemptId = `00000000-0000-4000-8000-${ordinal.toString(16).padStart(12, "0")}`;
  const authorization = compileContentStoreFirstActivation(stateRoot, candidate, attemptId);
  const qualificationRoot = observeContentRoot(qualificationRootPath);
  const qualificationPath = `qualification-${ordinal}`;
  return {
    candidate,
    fixtureRoot,
    qualificationRootPath,
    stateRootPath,
    request: {
      mode: "synthetic-fixture-only",
      attemptId,
      transactionId: authorization.plan.transactionId,
      stateRoot,
      stateLease: authorization.lease,
      qualification: {
        mode: "caller-owned-transient-synthetic-qualification",
        root: qualificationRoot,
        lease: compileContentStoreSyntheticQualificationLease(qualificationRoot, qualificationPath),
        destinationRelativePath: qualificationPath,
        residueDisposition: CONTENT_STORE_SYNTHETIC_QUALIFICATION_RESIDUE_DISPOSITION,
      },
      sourceRoot: join(fixtureRoot, "unused-source-because-authority-mutations-fail-first"),
      candidate,
    },
  };
}

function assertTransactionCode(request: ContentStoreFirstActivationRequest, code: string): void {
  assert.throws(
    () => publishContentStoreFirstActivation(request),
    (error: unknown) => error instanceof Error && "code" in error && error.code === code,
  );
}
