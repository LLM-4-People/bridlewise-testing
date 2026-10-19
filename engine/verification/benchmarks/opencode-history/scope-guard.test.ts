import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, open, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  assertSterileProcessSurface,
  IsolationPlanError,
  prepareIsolationPlanFromDeclarations,
  REQUIRED_OS_TOOLS,
  type IsolationCapabilityDeclarations,
} from "./isolation-plan.ts";
import { runSyntheticRootBoundary, toContentFreeRootBoundaryFailureReceipt } from "./root-runner.ts";
import {
  assertExactOperation,
  parseScopeGuardRequestJson,
  parseSyntheticScopeManifest,
  ScopeGuardError,
  toContentFreeFailureReceipt,
  validateAbsoluteScopePath,
  validateRelativePath,
  verifySyntheticExactScope,
} from "./scope-guard.ts";
import { prepareSyntheticManifest } from "./synthetic-manifest.ts";

const cleanupRoots: string[] = [];

after(async () => {
  await Promise.all(cleanupRoots.map((path) => rm(path, { force: true, recursive: true })));
});

interface Fixture {
  readonly sandbox: string;
  readonly root: string;
  readonly relativePaths: readonly string[];
  readonly fileIds: readonly string[];
  readonly manifestJson: string;
}

async function fixture(repetition: number, relativePaths = [`controls-${repetition}.json`]): Promise<Fixture> {
  const sandbox = await mkdtemp(join(tmpdir(), `harness-sec001-synthetic-${repetition}-`));
  cleanupRoots.push(sandbox);
  const root = join(sandbox, `admitted-${repetition}`);
  await mkdir(root);
  const fileIds: string[] = [];
  for (const [index, relativePath] of relativePaths.entries()) {
    const parent = relativePath.includes("/") ? relativePath.slice(0, relativePath.lastIndexOf("/")) : "";
    if (parent) await mkdir(join(root, parent), { recursive: true });
    await writeFile(join(root, relativePath), `generated-synthetic-${repetition}-${index}\n`, { flag: "wx" });
    fileIds.push(`control-${repetition}-${index}`);
  }
  const manifestJson = await prepareSyntheticManifest({
    syntheticSandboxRoot: sandbox,
    root,
    exactFiles: relativePaths.map((relativePath, index) => ({ id: fileIds[index]!, relativePath })),
  });
  return { sandbox, root, relativePaths, fileIds, manifestJson };
}

function request(value: Fixture) {
  return {
    syntheticSandboxRoot: value.sandbox,
    manifestJson: value.manifestJson,
    operation: "verify_manifest",
    requestedFileIds: value.fileIds,
  } as const;
}

function completeIsolationDeclarations(): IsolationCapabilityDeclarations {
  return {
    platform: "linux",
    declaredEffectiveUid: 0,
    targetUid: 65534,
    declaredAvailableTools: REQUIRED_OS_TOOLS,
    declaresMountNamespace: true,
    declaresUserNamespace: true,
    declaresReadOnlyBindMount: true,
    declaresNetworkNamespace: true,
    declaresNoNewPrivileges: true,
    declaresSeparateOsIdentity: true,
  };
}

async function rejectsCode(action: () => Promise<unknown>, expected: string): Promise<void> {
  await assert.rejects(action, (error: unknown) => {
    assert.equal(error instanceof Error ? error.message : "", expected);
    return true;
  });
}

for (let repetition = 1; repetition <= 3; repetition += 1) {
  test(`exact allowlist verifies generated synthetic files, repetition ${repetition}`, async () => {
    const value = await fixture(repetition, [
      `control-${repetition}.json`,
      `nested-${repetition}/identity-${repetition}.txt`,
    ]);
    const receipt = await verifySyntheticExactScope(request(value));
    assert.deepEqual(
      {
        admitted: receipt.admittedFileCount,
        verified: receipt.verifiedFileCount,
        hashes: receipt.allHashesMatched,
        ancestorBound: receipt.descriptorRelativeAncestorBinding,
        stableParents: receipt.stableParentChainVerified,
        isolation: receipt.fullIsolationVerified,
        declarationsAreProof: receipt.callerIsolationDeclarationsAreProof,
        synthetic: receipt.syntheticQualificationOnly,
        realReady: receipt.realHistoryReady,
        open: receipt.sec001Open,
      },
      {
        admitted: 2,
        verified: 2,
        hashes: true,
        ancestorBound: false,
        stableParents: false,
        isolation: false,
        declarationsAreProof: false,
        synthetic: true,
        realReady: false,
        open: true,
      },
    );
    assert.match(receipt.manifestSha256, /^[0-9a-f]{64}$/u);
  });

  test(`symlink escape is denied, repetition ${repetition}`, async () => {
    const value = await fixture(10 + repetition);
    const original = join(value.root, value.relativePaths[0]!);
    const moved = join(value.sandbox, `outside-${repetition}.txt`);
    await rename(original, moved);
    await symlink(moved, original);
    await rejectsCode(() => verifySyntheticExactScope(request(value)), "scope_symlink_denied");
  });

  test(`hardlink ambiguity is denied, repetition ${repetition}`, async () => {
    const value = await fixture(20 + repetition);
    await link(
      join(value.root, value.relativePaths[0]!),
      join(value.sandbox, `second-link-${repetition}.txt`),
    );
    await rejectsCode(() => verifySyntheticExactScope(request(value)), "scope_hardlink_denied");
  });

  test(`rename or replacement race is denied, repetition ${repetition}`, async () => {
    const value = await fixture(30 + repetition);
    const original = join(value.root, value.relativePaths[0]!);
    if (repetition === 1) {
      await writeFile(original, "changed-after-manifest\n");
    } else if (repetition === 2) {
      await rename(original, `${original}.old`);
      await writeFile(original, `generated-synthetic-${30 + repetition}-0\n`);
    } else {
      await rename(value.root, `${value.root}-renamed`);
    }
    await assert.rejects(() => verifySyntheticExactScope(request(value)));
  });

  test(`proc-fd and path traversal are denied before access, repetition ${repetition}`, () => {
    for (const path of [
      `proc/self/fd/${repetition + 2}`,
      `fd/${repetition}`,
      `../sibling-${repetition}`,
      `nested-${repetition}/../../outside`,
      `/absolute-${repetition}`,
    ]) {
      assert.throws(() => validateRelativePath(path), ScopeGuardError);
    }
  });

  test(`noncanonical absolute and relative spellings are denied, repetition ${repetition}`, async () => {
    const value = await fixture(90 + repetition);
    const ambiguousSandbox = repetition === 1
      ? `${value.sandbox}/.`
      : repetition === 2
      ? `${value.sandbox}/`
      : `${value.sandbox}//child/..`;
    assert.throws(() => validateAbsoluteScopePath(ambiguousSandbox), /scope_ambiguous/u);
    await rejectsCode(
      () => verifySyntheticExactScope({ ...request(value), syntheticSandboxRoot: ambiguousSandbox }),
      "scope_ambiguous",
    );
    const ambiguousRelative = repetition === 1
      ? "nested//control.txt"
      : repetition === 2
      ? "nested/./control.txt"
      : "nested/../control.txt";
    assert.throws(() => validateRelativePath(ambiguousRelative), /scope_traversal_denied/u);
  });

  test(`non-ASCII and confusable allowlist names are denied, repetition ${repetition}`, () => {
    const confusable = repetition === 1
      ? "safe/оutput.txt"
      : repetition === 2
      ? "safe/ｏutput.txt"
      : "safe/ou̇tput.txt";
    assert.throws(() => validateRelativePath(confusable), ScopeGuardError);
  });

  test(`argv and environment carriers are rejected without leakage, repetition ${repetition}`, () => {
    const canary = `private-carrier-${repetition}`;
    for (const surface of [
      { controlFd: 3, receiptFd: 4, argv: [`--root=${canary}`], environment: {} },
      { controlFd: 3, receiptFd: 4, argv: [], environment: { SOURCE_ROOT: canary } },
    ]) {
      let caught: unknown;
      try {
        assertSterileProcessSurface(surface);
      } catch (error) {
        caught = error;
      }
      const serialized = JSON.stringify(toContentFreeFailureReceipt(caught));
      assert.doesNotMatch(serialized, new RegExp(canary, "u"));
      assert.equal(JSON.parse(serialized).realHistoryReady, false);
    }
  });

  test(`errors and receipts never contain fixture bytes, repetition ${repetition}`, async () => {
    const canary = `SENSITIVE-SYNTHETIC-CONTENT-${repetition}`;
    const value = await fixture(40 + repetition);
    await writeFile(join(value.root, value.relativePaths[0]!), canary);
    let caught: unknown;
    try {
      await verifySyntheticExactScope(request(value));
    } catch (error) {
      caught = error;
    }
    const output = JSON.stringify(toContentFreeFailureReceipt(caught));
    assert.doesNotMatch(output, new RegExp(canary, "u"));
    assert.deepEqual(Object.keys(JSON.parse(output)).toSorted(), [
      "errorCode",
      "realHistoryReady",
      "sec001Open",
      "syntheticQualificationOnly",
    ]);
  });

  test(`broad discovery operations are denied, repetition ${repetition}`, () => {
    for (const operation of ["rg", "find", "glob", "search", "scan", "read_tree"]) {
      assert.throws(() => assertExactOperation(operation), /scope_discovery_denied/u);
    }
    assert.throws(() => assertExactOperation(`other-${repetition}`), /scope_unlisted_denied/u);
  });

  test(`nested forbidden names are denied, repetition ${repetition}`, () => {
    const variants = repetition === 1
      ? ["nested/review-packets/item.txt", "nested/output/item.txt", "nested/packet/item.txt"]
      : repetition === 2
      ? ["safe/deeper/source.sqlite", "safe/deeper/source.db-wal", "safe/deeper/source.sqlite-shm"]
      : ["safe/private-token.txt", "safe/credentials.json", "safe/run.log", "safe/review-packet.json"];
    for (const path of variants) assert.throws(() => validateRelativePath(path), /scope_forbidden_name/u);
  });

  test(`case ambiguity is denied, repetition ${repetition}`, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), `harness-sec001-synthetic-case-${repetition}-`));
    cleanupRoots.push(sandbox);
    const root = join(sandbox, `admitted-case-${repetition}`);
    await mkdir(root);
    await writeFile(join(root, `Control-${repetition}.txt`), "generated-upper\n");
    await writeFile(join(root, `control-${repetition}.txt`), "generated-lower\n");
    await rejectsCode(
      () => prepareSyntheticManifest({
        syntheticSandboxRoot: sandbox,
        root,
        exactFiles: [
          { id: `upper-${repetition}`, relativePath: `Control-${repetition}.txt` },
          { id: `lower-${repetition}`, relativePath: `control-${repetition}.txt` },
        ],
      }),
      "scope_case_ambiguous",
    );
  });

  test(`malformed manifests fail closed, repetition ${repetition}`, async () => {
    const value = await fixture(50 + repetition);
    const parsed = JSON.parse(value.manifestJson) as Record<string, unknown>;
    const malformed = repetition === 1
      ? "{"
      : repetition === 2
      ? value.manifestJson.replace('"format":', '"format":"duplicate","format":')
      : JSON.stringify({ ...parsed, unknown: true });
    assert.throws(() => parseSyntheticScopeManifest(malformed), /scope_invalid_manifest/u);
  });

  test(`root-runner request JSON rejects duplicates and extras, repetition ${repetition}`, async () => {
    const value = await fixture(100 + repetition);
    const validJson = JSON.stringify(request(value));
    assert.deepEqual(parseScopeGuardRequestJson(validJson), request(value));
    const parsed = JSON.parse(validJson) as Record<string, unknown>;
    const invalid = repetition === 1
      ? validJson.replace(
        '"syntheticSandboxRoot":',
        `"syntheticSandboxRoot":${JSON.stringify(value.sandbox)},"syntheticSandboxRoot":`,
      )
      : repetition === 2
      ? JSON.stringify({ ...parsed, unexpected: true })
      : "{";
    assert.throws(() => parseScopeGuardRequestJson(invalid), /scope_invalid_manifest/u);
  });

  test(`builder filesystem failures normalize without path leakage, repetition ${repetition}`, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), `harness-sec001-synthetic-builder-${repetition}-`));
    cleanupRoots.push(sandbox);
    const missingRoot = join(sandbox, `missing-private-canary-${repetition}`);
    let caught: unknown;
    try {
      await prepareSyntheticManifest({
        syntheticSandboxRoot: sandbox,
        root: missingRoot,
        exactFiles: [{ id: `missing-${repetition}`, relativePath: `control-${repetition}.txt` }],
      });
    } catch (error) {
      caught = error;
    }
    const serialized = JSON.stringify(toContentFreeFailureReceipt(caught));
    assert.equal(JSON.parse(serialized).errorCode, "scope_internal_failure");
    assert.doesNotMatch(serialized, new RegExp(`missing-private-canary-${repetition}`, "u"));
  });

  test(`missing isolation capabilities fail closed, repetition ${repetition}`, () => {
    const tools = repetition === 1 ? REQUIRED_OS_TOOLS.slice(1) : repetition === 2 ? [] : ["node"];
    assert.throws(
      () => prepareIsolationPlanFromDeclarations({
        ...completeIsolationDeclarations(),
        declaredAvailableTools: tools,
      }),
      IsolationPlanError,
    );
  });

  test(`root boundary failures are typed and content-free, repetition ${repetition}`, () => {
    const canary = `root-boundary-private-${repetition}`;
    const unknownFailure = toContentFreeRootBoundaryFailureReceipt(new Error(canary));
    assert.equal(unknownFailure.errorCode, "scope_internal_failure");
    assert.doesNotMatch(JSON.stringify(unknownFailure), new RegExp(canary, "u"));
    const declarationFailure = toContentFreeRootBoundaryFailureReceipt(
      new IsolationPlanError("isolation_declaration_incomplete"),
    );
    assert.equal(declarationFailure.errorCode, "isolation_declaration_incomplete");
  });

  test(`root runner contains preflight failures in its receipt boundary, repetition ${repetition}`, async () => {
    const sandbox = await mkdtemp(join(tmpdir(), `harness-sec001-synthetic-receipt-${repetition}-`));
    cleanupRoots.push(sandbox);
    const receiptPath = join(sandbox, `receipt-${repetition}.json`);
    const receiptHandle = await open(receiptPath, "w+");
    try {
      const receipt = await runSyntheticRootBoundary({
        controlFd: -1,
        receiptFd: receiptHandle.fd,
        declarations: completeIsolationDeclarations(),
      });
      assert.equal("errorCode" in receipt ? receipt.errorCode : "", "scope_ambiguous");
    } finally {
      await receiptHandle.close();
    }
    const persisted = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
    assert.equal(persisted.errorCode, "scope_ambiguous");
    assert.equal(persisted.realHistoryReady, false);
  });

  test(`stable ancestor race closure remains explicitly unproven, repetition ${repetition}`, async () => {
    const value = await fixture(110 + repetition, [
      `ancestor-${repetition}/nested-${repetition}/control-${repetition}.txt`,
    ]);
    const receipt = await verifySyntheticExactScope(request(value));
    assert.equal(receipt.descriptorRelativeAncestorBinding, false);
    assert.equal(receipt.stableParentChainVerified, false);
    assert.equal(receipt.realHistoryReady, false);
  });

  test(`stale hashes and identities fail closed, repetition ${repetition}`, async () => {
    const value = await fixture(60 + repetition);
    const parsed = JSON.parse(value.manifestJson) as {
      files: Array<Record<string, unknown>>;
    } & Record<string, unknown>;
    if (repetition === 1) parsed.files[0]!.sha256 = "0".repeat(64);
    else if (repetition === 2) parsed.files[0]!.inode = "1";
    else parsed.files[0]!.byteLength = 999;
    await assert.rejects(() => verifySyntheticExactScope({ ...request(value), manifestJson: JSON.stringify(parsed) }));
  });

  test(`stale canonical root identity fails closed, repetition ${repetition}`, async () => {
    const value = await fixture(65 + repetition);
    const parsed = JSON.parse(value.manifestJson) as Record<string, unknown>;
    parsed.rootInode = String(repetition);
    await rejectsCode(
      () => verifySyntheticExactScope({ ...request(value), manifestJson: JSON.stringify(parsed) }),
      "scope_identity_mismatch",
    );
  });

  test(`tainted transcript claims cannot establish readiness, repetition ${repetition}`, async () => {
    const value = await fixture(70 + repetition);
    const parsed = JSON.parse(value.manifestJson) as Record<string, unknown>;
    parsed.transcriptTainted = true;
    await rejectsCode(
      () => verifySyntheticExactScope({ ...request(value), manifestJson: JSON.stringify(parsed) }),
      "scope_tainted_claim_denied",
    );
  });

  test(`unlisted and partial file requests are denied, repetition ${repetition}`, async () => {
    const value = await fixture(80 + repetition, [`a-${repetition}.txt`, `b-${repetition}.txt`]);
    await rejectsCode(
      () => verifySyntheticExactScope({ ...request(value), requestedFileIds: [value.fileIds[0]!] }),
      "scope_unlisted_denied",
    );
    await rejectsCode(
      () => verifySyntheticExactScope({ ...request(value), requestedFileIds: [...value.fileIds, "not-admitted"] }),
      "scope_unlisted_denied",
    );
  });
}

test("complete caller declarations prepare a plan but prove no isolation", () => {
  const receipt = prepareIsolationPlanFromDeclarations(completeIsolationDeclarations());
  assert.equal(receipt.ready, false);
  assert.equal(receipt.callerDeclarationsOnly, true);
  assert.equal(receipt.measuredCapabilityCount, 0);
  assert.equal(receipt.isolationVerified, false);
  assert.match(receipt.planSha256, /^[0-9a-f]{64}$/u);
  assert.equal("root" in receipt, false);
  assert.equal("path" in receipt, false);
});
