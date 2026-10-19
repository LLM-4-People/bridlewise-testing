import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { DATA_CLASSIFICATION } from "../../src/privacy/classification-catalog.ts";
import { canonicalDomainHash, canonicalJson, sha256 } from "../../src/kernel/integrity.ts";
import { withCurrentNodeRuntimeForFilesystemMechanismTest } from
  "../../src/filesystem/durable-filesystem-internal.ts";
import {
  collectContentAdmissionEvidence,
  createClassificationReceipt,
  createContentAdmissionAuthority,
  createLicenseReceipt,
  prepareContentStoreCandidate,
  type ContentStoreCandidate,
} from "../../verification/core/artifact-governance/content-store/application.ts";
import {
  compileContentStoreFirstActivation,
  compileContentStoreSyntheticQualificationLease,
  CONTENT_STORE_SYNTHETIC_QUALIFICATION_RESIDUE_DISPOSITION,
  observeContentRoot,
  publishContentStoreFirstActivation,
  recoverContentStoreFirstActivation,
  scanContentTree,
  type ContentStoreFirstActivationRequest,
  type ContentStoreTransactionHooks,
} from "../../verification/core/artifact-governance/content-store/node-adapter/index.ts";
import { readContentPackBytes } from
  "../../verification/core/artifact-governance/content-store/pack.ts";
import {
  createRepositoryLocalTemporaryDirectory,
  removeRepositoryLocalTemporaryDirectory,
} from "../support/repository-local-temporary.ts";

class SimulatedCrash extends Error {}

type TransactionFixture = Readonly<{
  candidate: ContentStoreCandidate;
  qualificationPath: string;
  qualificationRootPath: string;
  request: ContentStoreFirstActivationRequest;
  stateRootPath: string;
}>;

test("recovery resumes before and after every registered durable publication", (context) => {
  const seed = createFixture(context, 1);
  const publications = compileContentStoreFirstActivation(
    seed.request.stateRoot,
    seed.candidate,
    seed.request.attemptId,
  ).plan.publications;
  assert.equal(seed.request.stateLease.effects.length, publications.length);
  assertBoundarySequence(publications, publications);
  assert.throws(() => assertBoundarySequence(publications, publications.slice(1)));
  assert.throws(() => assertBoundarySequence(publications, [
    ...publications,
    { ...publications.at(-1)!, id: "unregistered-mutant" },
  ]));

  for (const [ordinal] of publications.entries()) {
    for (const moment of ["before", "after"] as const) {
      const fixture = createFixture(context, 10 + ordinal * 2 + (moment === "after" ? 1 : 0));
      const hooks: ContentStoreTransactionHooks = {
        beforePublication: (event) => {
          if (moment === "before" && event.ordinal === ordinal) throw new SimulatedCrash();
        },
        afterPublication: (event) => {
          if (moment === "after" && event.ordinal === ordinal) throw new SimulatedCrash();
        },
      };
      assert.throws(
        () => withMechanismRuntime(() => publishContentStoreFirstActivation({ ...fixture.request, hooks })),
        (error: unknown) => error instanceof SimulatedCrash,
      );
      const recovered = withMechanismRuntime(() => recoverContentStoreFirstActivation(fixture.request));
      assert.equal(recovered.status, "synthetic-first-activation-complete");
      assert.equal(recovered.terminalPhase, "active-published");
      assert.equal(existsSync(join(fixture.stateRootPath, "active.json")), true);
    }
  }
});

test("pre-publication qualification crash leaves only typed caller-owned residue", (context) => {
  const fixture = createFixture(context, 100);
  assert.throws(
    () => publishContentStoreFirstActivation({
      ...fixture.request,
      hooks: { afterQualification: () => { throw new SimulatedCrash(); } },
    }),
    (error: unknown) => error instanceof SimulatedCrash,
  );
  assert.deepEqual(readdirSync(fixture.stateRootPath), []);
  assert.equal(existsSync(join(fixture.qualificationRootPath, fixture.qualificationPath)), true);

  const recovered = withMechanismRuntime(() => recoverContentStoreFirstActivation(fixture.request));
  assert.equal(
    recovered.qualificationResidueDisposition,
    CONTENT_STORE_SYNTHETIC_QUALIFICATION_RESIDUE_DISPOSITION,
  );
  assert.equal(recovered.deleteOrCleanupAuthorityAvailable, false);
});

test("same-byte replay is read-only and exact orphan objects are reused", (context) => {
  const replay = createFixture(context, 110);
  const first = withMechanismRuntime(() => publishContentStoreFirstActivation(replay.request));
  const second = recoverContentStoreFirstActivation(replay.request);
  assert.equal(first.disposition, "created-or-resumed");
  assert.equal(second.disposition, "already-complete");
  assert.equal(second.activeIdentity, first.activeIdentity);

  const orphan = createFixture(context, 111);
  const plan = compileContentStoreFirstActivation(
    orphan.request.stateRoot,
    orphan.candidate,
    orphan.request.attemptId,
  ).plan;
  const pack = plan.publications.find((publication) => publication.kind === "pack")!;
  writeFileSync(
    join(orphan.stateRootPath, pack.relativePath),
    readContentPackBytes(orphan.candidate.packs[0]!),
    { flag: "wx", mode: 0o600 },
  );
  assert.equal(readdirSync(orphan.stateRootPath).some((name) => name.startsWith("journal-")), false);
  const result = withMechanismRuntime(() => recoverContentStoreFirstActivation(orphan.request));
  assert.equal(result.status, "synthetic-first-activation-complete");
  assert.equal(sha256(readFileSync(join(orphan.stateRootPath, pack.relativePath))), pack.sha256);
});

test("journal readback rejects duplicate unknown out-of-order and conflicting phases", (context) => {
  const duplicate = crashAfter(context, 120, "journal-prepared");
  const duplicatePrepared = publicationPath(duplicate, "journal-prepared");
  copyFileSync(
    duplicatePrepared,
    join(duplicate.stateRootPath, `journal-${duplicate.request.transactionId}-99-duplicate.json`),
  );
  chmodSync(join(duplicate.stateRootPath, `journal-${duplicate.request.transactionId}-99-duplicate.json`), 0o600);
  assertRecoveryCode(duplicate, "content_store_journal_phase_duplicate");

  const unknown = crashAfter(context, 121, "journal-prepared");
  const unknownJournal = mutateJournal(readFileSync(publicationPath(unknown, "journal-prepared")), {
    phase: "future-phase",
  });
  writeFileSync(
    join(unknown.stateRootPath, `journal-${unknown.request.transactionId}-99-future.json`),
    unknownJournal,
    { flag: "wx", mode: 0o600 },
  );
  assertRecoveryCode(unknown, "content_store_journal_phase_unknown");

  const outOfOrder = crashAfter(context, 122, "journal-objects-published");
  unlinkSync(publicationPath(outOfOrder, "journal-prepared"));
  assertRecoveryCode(outOfOrder, "content_store_journal_phase_out_of_order");

  const conflict = crashAfter(context, 123, "journal-prepared");
  writeFileSync(
    publicationPath(conflict, "journal-prepared"),
    mutateJournal(readFileSync(publicationPath(conflict, "journal-prepared")), {
      attemptId: attemptId(999),
    }),
  );
  assertRecoveryCode(conflict, "content_store_journal_phase_conflict");
});

test("claimed durable objects and exclusive active bytes fail closed on conflict", (context) => {
  const missing = crashAfter(context, 130, "journal-objects-published");
  unlinkSync(publicationPath(missing, "pack-0"));
  assertRecoveryCode(missing, "content_store_journal_phase_conflict");

  const objectConflict = createFixture(context, 131);
  const objectPath = publicationPath(objectConflict, "pack-0");
  writeFileSync(objectPath, Buffer.from("foreign-object"), { flag: "wx", mode: 0o600 });
  assertRecoveryCode(objectConflict, "content_store_immutable_object_conflict");

  const activeConflict = createFixture(context, 132);
  writeFileSync(join(activeConflict.stateRootPath, "active.json"), Buffer.from("foreign-active"), {
    flag: "wx",
    mode: 0o600,
  });
  assertRecoveryCode(activeConflict, "content_store_active_replacement_authority_absent");
  assert.deepEqual(readdirSync(activeConflict.qualificationRootPath), []);
});

function createFixture(context: TestContext, ordinal: number): TransactionFixture {
  const fixtureRoot = createRepositoryLocalTemporaryDirectory(`cas-recovery-${ordinal}-`);
  context.after(() => removeRepositoryLocalTemporaryDirectory(fixtureRoot));
  const sourceRoot = join(fixtureRoot, "source");
  const stateRootPath = join(fixtureRoot, "state");
  const qualificationRootPath = join(fixtureRoot, "qualification");
  mkdirSync(join(sourceRoot, "nested"), { recursive: true, mode: 0o755 });
  mkdirSync(stateRootPath, { mode: 0o700 });
  mkdirSync(qualificationRootPath, { mode: 0o700 });
  chmodSync(stateRootPath, 0o700);
  chmodSync(qualificationRootPath, 0o700);
  const bytes = Buffer.from([0, 1, 2, 3, ordinal & 0xff]);
  writeFileSync(join(sourceRoot, "nested", "payload.bin"), bytes, { mode: 0o640 });
  writeFileSync(join(sourceRoot, "duplicate.bin"), bytes, { mode: 0o640 });
  const scan = scanContentTree(sourceRoot);
  const candidate = admittedCandidate(scan.tree, scan.blobs);
  const stateRoot = observeContentRoot(stateRootPath);
  const syntheticAttemptId = attemptId(ordinal);
  const authorization = compileContentStoreFirstActivation(stateRoot, candidate, syntheticAttemptId);
  const qualificationRoot = observeContentRoot(qualificationRootPath);
  const qualificationPath = `qualification-${ordinal}`;
  const request: ContentStoreFirstActivationRequest = {
    mode: "synthetic-fixture-only",
    attemptId: syntheticAttemptId,
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
    sourceRoot,
    candidate,
  };
  return { candidate, qualificationPath, qualificationRootPath, request, stateRootPath };
}

function admittedCandidate(
  tree: ReturnType<typeof scanContentTree>["tree"],
  blobs: ReturnType<typeof scanContentTree>["blobs"],
): ContentStoreCandidate {
  const authority = createContentAdmissionAuthority({
    classificationProviderIdentity: "a".repeat(64),
    licenseProviderIdentity: "b".repeat(64),
  });
  const evidence = collectContentAdmissionEvidence(blobs, {
    classification: {
      providerIdentity: authority.classificationProviderIdentity,
      policyIdentity: authority.classificationPolicyIdentity,
      schemaIdentity: authority.classificationSchemaIdentity,
      collect: (values) => values.map((blob) => createClassificationReceipt({
        blobSha256: blob.sha256,
        scannerRevision: "synthetic-recovery-classifier/v1",
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
      collect: (values) => values.map((blob) => createLicenseReceipt({
        blobSha256: blob.sha256,
        decision: "admit",
        licenseExpression: "MIT",
        licenseTextSha256: sha256("synthetic-license"),
        noticeTextSha256: sha256("synthetic-notice"),
        externalLeaseIdentity: sha256("synthetic-external-lease"),
      })),
    },
  });
  const prepared = prepareContentStoreCandidate({ tree, blobs, authority, evidence, packCeilingBytes: 1_024 });
  if (prepared.status !== "admitted") throw new Error("synthetic candidate unexpectedly blocked");
  return prepared.candidate;
}

function crashAfter(context: TestContext, ordinal: number, publicationId: string): TransactionFixture {
  const fixture = createFixture(context, ordinal);
  assert.throws(
    () => withMechanismRuntime(() => publishContentStoreFirstActivation({
      ...fixture.request,
      hooks: {
        afterPublication: (event) => {
          if (event.id === publicationId) throw new SimulatedCrash();
        },
      },
    })),
    (error: unknown) => error instanceof SimulatedCrash,
  );
  return fixture;
}

function publicationPath(fixture: TransactionFixture, publicationId: string): string {
  const plan = compileContentStoreFirstActivation(
    fixture.request.stateRoot,
    fixture.candidate,
    fixture.request.attemptId,
  ).plan;
  const publication = plan.publications.find((candidate) => candidate.id === publicationId);
  if (publication === undefined) throw new Error(`publication missing: ${publicationId}`);
  return join(fixture.stateRootPath, publication.relativePath);
}

function assertRecoveryCode(fixture: TransactionFixture, code: string): void {
  assert.throws(
    () => withMechanismRuntime(() => recoverContentStoreFirstActivation(fixture.request)),
    (error: unknown) => error instanceof Error && "code" in error && error.code === code,
  );
}

function mutateJournal(bytes: Buffer, changes: Readonly<Record<string, unknown>>): Buffer {
  const journal = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  const { journalIdentity: _identity, ...payload } = { ...journal, ...changes };
  return Buffer.from(`${canonicalJson({
    ...payload,
    journalIdentity: canonicalDomainHash("content-store.journal/v1", payload),
  })}\n`, "utf8");
}

function attemptId(ordinal: number): string {
  return `00000000-0000-4000-8000-${ordinal.toString(16).padStart(12, "0")}`;
}

function withMechanismRuntime<Result>(operation: () => Result): Result {
  return withCurrentNodeRuntimeForFilesystemMechanismTest(operation);
}

function assertBoundarySequence(
  expected: readonly Readonly<{ id: string }>[],
  observed: readonly Readonly<{ id: string }>[],
): void {
  assert.deepEqual(observed.map((value) => value.id), expected.map((value) => value.id));
}
