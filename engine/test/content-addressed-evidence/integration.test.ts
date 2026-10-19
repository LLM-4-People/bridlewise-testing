import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import test, { type TestContext } from "node:test";
import { inspect } from "node:util";
import { pathToFileURL } from "node:url";

import {
  bindTransientWriteRootCapability,
  compileExactWriteLease,
} from "../../src/modules/effect-boundary/index.ts";
import { DATA_CLASSIFICATION } from "../../src/privacy/classification-catalog.ts";
import { canonicalJson, sha256 } from "../../src/kernel/integrity.ts";
import { extractErrorMessage } from "../../src/kernel/errors.ts";
import { withCurrentNodeRuntimeForFilesystemMechanismTest } from
  "../../src/filesystem/durable-filesystem-internal.ts";
import {
  createRepositoryLocalTemporaryDirectory,
  removeRepositoryLocalTemporaryDirectory,
} from "../support/repository-local-temporary.ts";
import {
  compileContentStoreFirstActivation,
  compileContentStoreSyntheticQualificationLease,
  CONTENT_STORE_SYNTHETIC_QUALIFICATION_RESIDUE_DISPOSITION,
  reconstructContentTree,
  isExactRootOrDescendantDestinationParent,
  observeContentRoot,
  publishContentStoreFirstActivation,
  projectContentStorePublicError,
  scanContentTree,
  type ContentStoreFirstActivationRequest,
} from "../../verification/core/artifact-governance/content-store/node-adapter/index.ts";
import {
  collectContentAdmissionEvidence,
  createClassificationReceipt,
  createContentAdmissionAuthority,
  createLicenseReceipt,
  prepareContentStoreCandidate,
  type ContentStoreCandidate,
} from "../../verification/core/artifact-governance/content-store/application.ts";
import {
  buildContentPacks,
  readContentPackBytes,
} from "../../verification/core/artifact-governance/content-store/pack.ts";
import { contentTreeBytes } from "../../verification/core/artifact-governance/content-store/tree.ts";
import {
  oracleParseContentPack,
  oracleParseContentTree,
} from "../../verification/oracles/content-addressed-evidence.ts";

test("synthetic tree packs reconstructs and rescans with independent agreement", (context) => {
  const fixtureRoot = createRepositoryLocalTemporaryDirectory("cas-e2e-");
  context.after(() => removeRepositoryLocalTemporaryDirectory(fixtureRoot));
  const source = join(fixtureRoot, "source");
  mkdirSync(join(source, "nested"), { recursive: true, mode: 0o755 });
  writeFileSync(join(source, "nested", "alpha.bin"), Buffer.from([0, 1, 2, 3]), { mode: 0o640 });
  writeFileSync(join(source, "duplicate.bin"), Buffer.from([0, 1, 2, 3]), { mode: 0o640 });
  chmodSync(join(source, "nested"), 0o755);
  symlinkSync("nested/alpha.bin", join(source, "alpha-link"));

  const scan = scanContentTree(source);
  assert.equal(scan.blobs.length, 1);
  const packs = buildContentPacks(scan.blobs, 512);
  assert.equal(packs.length, 1);
  const oraclePack = oracleParseContentPack(readContentPackBytes(packs[0]!), 512);
  assert.deepEqual(
    oraclePack.records.map((record) => record.blobSha256),
    scan.blobs.map((blob) => blob.sha256),
  );
  const oracleTree = oracleParseContentTree(contentTreeBytes(scan.tree));
  assert.equal(oracleTree.treeIdentity, scan.tree.treeIdentity);

  const root = observeContentRoot(fixtureRoot);
  const destinationRelativePath = "reconstructed";
  const lease = compileExactWriteLease(root, [{
    operation: "create-directory",
    relativePath: destinationRelativePath,
  }]);
  reconstructContentTree({
    root,
    destinationRelativePath,
    lease,
    tree: scan.tree,
    blobs: scan.blobs,
  });
  const rescan = scanContentTree(join(fixtureRoot, destinationRelativePath));
  assert.equal(rescan.tree.treeIdentity, scan.tree.treeIdentity);
  assert.deepEqual(
    rescan.blobs.map((blob) => blob.sha256),
    scan.blobs.map((blob) => blob.sha256),
  );
});

test("opaque root capabilities resist serialization logging and error disclosure", (context) => {
  const fixtureRoot = createRepositoryLocalTemporaryDirectory("cas-root-");
  context.after(() => removeRepositoryLocalTemporaryDirectory(fixtureRoot));
  const root = observeContentRoot(fixtureRoot);
  assert.throws(() => JSON.stringify(root), /not serializable/u);
  const logged = inspect(root, { depth: 4 });
  for (const forbidden of [
    fixtureRoot,
    pathToFileURL(fixtureRoot).href,
    basename(fixtureRoot),
    "/home/",
    "exampleuser",
  ]) {
    assert.equal(logged.includes(forbidden), false);
  }
  assert.equal(/[0-9a-f]{64}/u.test(logged), false);

  const otherRoot = bindTransientWriteRootCapability(Object.freeze({ isolated: true }));
  const lease = compileExactWriteLease(root, [{
    operation: "create-directory",
    relativePath: "destination",
  }]);
  let message = "";
  try {
    reconstructContentTree({
      root: otherRoot,
      destinationRelativePath: "destination",
      lease,
      tree: scanContentTree(fixtureRoot).tree,
      blobs: [],
    });
  } catch (error) {
    message = extractErrorMessage(error);
  }
  assert.notEqual(message, "");
  assert.equal(message.includes(fixtureRoot), false);
  assert.equal(message.includes(basename(fixtureRoot)), false);
});

test("destination-parent containment mode distinguishes root descendants and lookalikes", () => {
  const root = "/controlled/root";
  assert.equal(isExactRootOrDescendantDestinationParent(root, root), true);
  assert.equal(isExactRootOrDescendantDestinationParent(root, `${root}/child`), true);
  assert.equal(isExactRootOrDescendantDestinationParent(root, `${root}/child/deep`), true);
  assert.equal(isExactRootOrDescendantDestinationParent(root, "/controlled/sibling"), false);
  assert.equal(isExactRootOrDescendantDestinationParent(root, "/controlled/root-prefix"), false);

  const capability = bindTransientWriteRootCapability(Object.freeze({ isolated: true }));
  for (const relativePath of ["", ".", "../escape", "child/../escape", "child\\alternate"]) {
    assert.throws(() => compileExactWriteLease(capability, [{
      operation: "create-directory",
      relativePath,
    }]));
  }
});

test("symlinked destination parents fail before reconstruction effects", (context) => {
  const fixtureRoot = createRepositoryLocalTemporaryDirectory("cas-parent-");
  context.after(() => removeRepositoryLocalTemporaryDirectory(fixtureRoot));
  mkdirSync(join(fixtureRoot, "source"));
  mkdirSync(join(fixtureRoot, "real-parent"));
  symlinkSync("real-parent", join(fixtureRoot, "alias-parent"));
  const scan = scanContentTree(join(fixtureRoot, "source"));
  const root = observeContentRoot(fixtureRoot);
  const destinationRelativePath = "alias-parent/destination";
  const lease = compileExactWriteLease(root, [{
    operation: "create-directory",
    relativePath: destinationRelativePath,
  }]);
  assert.throws(
    () => reconstructContentTree({ root, destinationRelativePath, lease, tree: scan.tree, blobs: scan.blobs }),
    (error: unknown) => error instanceof Error &&
      "code" in error && error.code === "content_store_destination_parent_invalid",
  );
  assert.equal(existsSync(join(fixtureRoot, "real-parent", "destination")), false);
});

test("post-observation root swaps fail with a typed residual", (context) => {
  const fixtureRoot = createRepositoryLocalTemporaryDirectory("cas-swap-");
  context.after(() => removeRepositoryLocalTemporaryDirectory(fixtureRoot));
  const observedRoot = join(fixtureRoot, "observed");
  const movedRoot = join(fixtureRoot, "observed-old");
  const source = join(fixtureRoot, "source");
  mkdirSync(observedRoot);
  mkdirSync(source);
  const scan = scanContentTree(source);
  const root = observeContentRoot(observedRoot);
  const destinationRelativePath = "destination";
  const lease = compileExactWriteLease(root, [{
    operation: "create-directory",
    relativePath: destinationRelativePath,
  }]);
  renameSync(observedRoot, movedRoot);
  mkdirSync(observedRoot);
  assert.throws(
    () => reconstructContentTree({ root, destinationRelativePath, lease, tree: scan.tree, blobs: scan.blobs }),
    (error: unknown) => error instanceof Error &&
      "code" in error && error.code === "content_store_root_identity_changed",
  );
  assert.equal(existsSync(join(observedRoot, destinationRelativePath)), false);
});

for (const [profile, ordinal] of [
  ["duplicate-heavy", 201],
  ["binary-path-boundary", 202],
  ["confined-symlink", 203],
] as const) {
  test(`synthetic transaction profile ${profile} completes without production claims`, (context) => {
    const fixture = transactionProfileFixture(context, profile, ordinal);
    const result = withCurrentNodeRuntimeForFilesystemMechanismTest(
      () => publishContentStoreFirstActivation(fixture.request),
    );
    assert.equal(result.status, "synthetic-first-activation-complete");
    assert.equal(result.productionActivation, false);
    assert.equal(result.replacementAuthorityAvailable, false);
    assert.equal(result.renameAuthorityAvailable, false);
    assert.equal(result.deleteOrCleanupAuthorityAvailable, false);
    assert.equal(existsSync(join(fixture.stateRoot, "active.json")), true);
    const replay = compileContentStoreFirstActivation(
      fixture.request.stateRoot,
      fixture.request.candidate,
      fixture.request.attemptId,
    );
    assert.equal(sha256(canonicalJson(replay.plan)), fixture.governedPlanProjectionSha256);
  });
}

test("absent admitted durable runtime leaves state empty and only caller-owned qualification residue", (context) => {
  const fixture = transactionProfileFixture(context, "duplicate-heavy", 204);
  let observed: unknown;
  try {
    publishContentStoreFirstActivation(fixture.request);
  } catch (error) {
    observed = error;
  }
  assert.equal(
    observed instanceof Error && "code" in observed && observed.code,
    "content_store_runtime_not_admitted",
  );
  assert.deepEqual(readdirSync(fixture.stateRoot), []);
  assert.equal(existsSync(join(fixture.qualificationRoot, fixture.qualificationPath)), true);
  const projection = projectContentStorePublicError(observed);
  assert.equal("stack" in projection, false);
  assert.equal("cause" in projection, false);
  const rendered = inspect(projection, { depth: 5 });
  for (const [index, forbidden] of [
    fixture.stateRoot,
    fixture.qualificationRoot,
    basename(fixture.stateRoot),
    basename(fixture.qualificationRoot),
    "/home/",
    "exampleuser",
  ].entries()) assert.equal(rendered.includes(forbidden), false, `locator-canary-${index}`);
});

type SyntheticProfile = "duplicate-heavy" | "binary-path-boundary" | "confined-symlink";

function transactionProfileFixture(
  context: TestContext,
  profile: SyntheticProfile,
  ordinal: number,
): Readonly<{
  request: ContentStoreFirstActivationRequest;
  stateRoot: string;
  qualificationRoot: string;
  qualificationPath: string;
  governedPlanProjectionSha256: string;
}> {
  const fixtureRoot = createRepositoryLocalTemporaryDirectory(`cas-profile-${profile}-`);
  context.after(() => removeRepositoryLocalTemporaryDirectory(fixtureRoot));
  const source = join(fixtureRoot, "source");
  const stateCanary = locatorCanary("state", ordinal);
  const qualificationCanary = locatorCanary("qualification", ordinal);
  assertCanariesAreIndependent([stateCanary, qualificationCanary]);
  const stateRoot = join(fixtureRoot, stateCanary);
  const qualificationRoot = join(fixtureRoot, qualificationCanary);
  mkdirSync(source, { mode: 0o755 });
  mkdirSync(stateRoot, { mode: 0o700 });
  mkdirSync(qualificationRoot, { mode: 0o700 });
  chmodSync(stateRoot, 0o700);
  chmodSync(qualificationRoot, 0o700);
  populateProfile(source, profile);
  const scan = scanContentTree(source);
  const candidate = admittedProfileCandidate(scan.tree, scan.blobs);
  const stateCapability = observeContentRoot(stateRoot);
  const attemptId = `00000000-0000-4000-8000-${ordinal.toString(16).padStart(12, "0")}`;
  const authorization = compileContentStoreFirstActivation(stateCapability, candidate, attemptId);
  const qualificationCapability = observeContentRoot(qualificationRoot);
  const qualificationPath = `qualification-${ordinal}`;
  return {
    stateRoot,
    qualificationRoot,
    qualificationPath,
    governedPlanProjectionSha256: sha256(canonicalJson(authorization.plan)),
    request: {
      mode: "synthetic-fixture-only",
      attemptId,
      transactionId: authorization.plan.transactionId,
      stateRoot: stateCapability,
      stateLease: authorization.lease,
      qualification: {
        mode: "caller-owned-transient-synthetic-qualification",
        root: qualificationCapability,
        lease: compileContentStoreSyntheticQualificationLease(qualificationCapability, qualificationPath),
        destinationRelativePath: qualificationPath,
        residueDisposition: CONTENT_STORE_SYNTHETIC_QUALIFICATION_RESIDUE_DISPOSITION,
      },
      sourceRoot: source,
      candidate,
    },
  };
}

function populateProfile(source: string, profile: SyntheticProfile): void {
  if (profile === "duplicate-heavy") {
    mkdirSync(join(source, "nested"), { mode: 0o755 });
    const bytes = Buffer.from("duplicate-heavy", "utf8");
    for (const path of ["alpha.bin", "beta.bin", "nested/gamma.bin"]) {
      writeFileSync(join(source, path), bytes, { mode: 0o640 });
    }
    return;
  }
  if (profile === "binary-path-boundary") {
    const rawPath = Buffer.concat([Buffer.from(`${source}/raw-`, "utf8"), Buffer.from([0xff, 0xfe])]);
    writeFileSync(rawPath, Buffer.from([0, 255, 1, 254]), { mode: 0o640 });
    return;
  }
  mkdirSync(join(source, "target"), { mode: 0o755 });
  writeFileSync(join(source, "target/payload.bin"), Buffer.from("symlink-target"), { mode: 0o640 });
  symlinkSync("target/payload.bin", join(source, "payload-link"));
}

function admittedProfileCandidate(
  tree: ReturnType<typeof scanContentTree>["tree"],
  blobs: ReturnType<typeof scanContentTree>["blobs"],
): ContentStoreCandidate {
  const authority = createContentAdmissionAuthority({
    classificationProviderIdentity: "e".repeat(64),
    licenseProviderIdentity: "f".repeat(64),
  });
  const evidence = collectContentAdmissionEvidence(blobs, {
    classification: {
      providerIdentity: authority.classificationProviderIdentity,
      policyIdentity: authority.classificationPolicyIdentity,
      schemaIdentity: authority.classificationSchemaIdentity,
      collect: (values) => values.map((blob) => createClassificationReceipt({
        blobSha256: blob.sha256,
        scannerRevision: "synthetic-profile-classifier/v1",
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
        licenseTextSha256: sha256("profile-license"),
        noticeTextSha256: sha256("profile-notice"),
        externalLeaseIdentity: sha256("profile-external-lease"),
      })),
    },
  });
  const prepared = prepareContentStoreCandidate({ tree, blobs, authority, evidence, packCeilingBytes: 1_024 });
  if (prepared.status !== "admitted") throw new Error("profile candidate blocked");
  return prepared.candidate;
}

function locatorCanary(label: "qualification" | "state", ordinal: number): string {
  return `synthetic-locator-${label}-${sha256(`content-store-locator-canary/${label}/${ordinal}`).slice(0, 24)}`;
}

function assertCanariesAreIndependent(canaries: readonly string[]): void {
  const unrelatedProtocolVocabulary = [
    "Content store durable runtime is not admitted",
    "content_store_runtime_not_admitted",
    "caller-owned-no-delete-cleanup-authority",
    "synthetic-first-activation-complete",
  ];
  for (const canary of canaries) {
    assert.equal(unrelatedProtocolVocabulary.some((value) => value.includes(canary)), false);
  }
}
