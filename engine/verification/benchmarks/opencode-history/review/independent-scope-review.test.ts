import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";

const reviewDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(reviewDirectory, "../../../..");
const implementationDirectory = join(
  repositoryRoot,
  "verification",
  "benchmarks",
  "opencode-history",
);

const integrityUrl = pathToFileURL(join(repositoryRoot, "src", "integrity.ts")).href;
const jsonIntegrityUrl = pathToFileURL(join(repositoryRoot, "src", "json-integrity.ts")).href;
const virtualInputErrorUrl = "data:text/javascript," + encodeURIComponent([
  "export class InputError extends Error {",
  "  constructor(message, code) {",
  "    super(message);",
  '    this.name = "InputError";',
  "    this.code = code;",
  "  }",
  "}",
].join("\n"));

// The reviewed shared helpers depend only on this error shape. Supplying it as
// an in-memory module keeps this review's repository reads on the exact list.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "./errors.ts" &&
      (context.parentURL === integrityUrl || context.parentURL === jsonIntegrityUrl)
    ) {
      return { shortCircuit: true, url: virtualInputErrorUrl };
    }
    return nextResolve(specifier, context);
  },
});

const scopeGuard = await import("../scope-guard.ts");
const syntheticManifest = await import("../synthetic-manifest.ts");
const isolationPlan = await import("../isolation-plan.ts");
const rootRunner = await import("../root-runner.ts");

const cleanupDirectories: string[] = [];

after(async () => {
  await Promise.all(cleanupDirectories.map((path) => rm(path, { force: true, recursive: true })));
});

interface GeneratedFixture {
  readonly sandbox: string;
  readonly root: string;
  readonly exactFiles: readonly Readonly<{ id: string; relativePath: string }>[];
  readonly manifestJson: string;
}

async function generatedFixture(label: string): Promise<GeneratedFixture> {
  // The run's temp root, never the live tree: a sandbox made and removed inside the repository changes the source tree
  // under every other run's walk (measured: the inventory refused "source tree changed during discovery").
  const sandbox = await mkdtemp(join(tmpdir(), `scope-review-${label}-`));
  cleanupDirectories.push(sandbox);
  const root = join(sandbox, "admitted-root");
  await mkdir(join(root, "nested-a"), { recursive: true });
  const exactFiles = Object.freeze([
    Object.freeze({ id: "control-a", relativePath: "control-a.json" }),
    Object.freeze({ id: "control-b", relativePath: "nested-a/control-b.txt" }),
  ]);
  await writeFile(join(root, exactFiles[0]!.relativePath), "generated-alpha\n", { flag: "wx" });
  await writeFile(join(root, exactFiles[1]!.relativePath), "generated-beta\n", { flag: "wx" });
  const manifestJson = await syntheticManifest.prepareSyntheticManifest({
    syntheticSandboxRoot: sandbox,
    root,
    exactFiles,
  });
  return { sandbox, root, exactFiles, manifestJson };
}

function requestFor(value: GeneratedFixture) {
  return {
    syntheticSandboxRoot: value.sandbox,
    manifestJson: value.manifestJson,
    operation: scopeGuard.VERIFY_OPERATION,
    requestedFileIds: value.exactFiles.map(({ id }) => id),
  };
}

function declarations() {
  return {
    platform: "linux",
    declaredEffectiveUid: 0,
    targetUid: 65534,
    declaredAvailableTools: isolationPlan.REQUIRED_OS_TOOLS,
    declaresMountNamespace: true,
    declaresUserNamespace: true,
    declaresReadOnlyBindMount: true,
    declaresNetworkNamespace: true,
    declaresNoNewPrivileges: true,
    declaresSeparateOsIdentity: true,
  } as const;
}

function hasCode(expected: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.equal(error instanceof Error ? error.message : "", expected);
    assert.equal(
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code: unknown }).code
        : undefined,
      expected,
    );
    return true;
  };
}

test("canonical spellings and safe ASCII relative segments are exact", () => {
  assert.deepEqual(
    scopeGuard.validateRelativePath("Alpha-1/beta_2/control.v3"),
    ["Alpha-1", "beta_2", "control.v3"],
  );
  scopeGuard.validateAbsoluteScopePath(reviewDirectory);

  for (const value of [
    "",
    ".",
    "..",
    "nested-a//control.txt",
    "nested-a/./control.txt",
    "nested-a/../control.txt",
    "nested-a/control.txt/",
    "nested-a\\control.txt",
    "nested a/control.txt",
    "nested-a/control?.txt",
    "nested-a/café.txt",
  ]) {
    assert.throws(() => scopeGuard.validateRelativePath(value), scopeGuard.ScopeGuardError);
  }

  for (const value of [
    `${reviewDirectory}/`,
    `${reviewDirectory}/.`,
    `${reviewDirectory}//child/..`,
  ]) {
    assert.throws(() => scopeGuard.validateAbsoluteScopePath(value), hasCode("scope_ambiguous"));
  }
});

test("manifest construction is deterministic for stable exact identities", async () => {
  const value = await generatedFixture("identity");
  const rebuilt = await syntheticManifest.prepareSyntheticManifest({
    syntheticSandboxRoot: value.sandbox,
    root: value.root,
    exactFiles: value.exactFiles,
  });
  assert.equal(rebuilt, value.manifestJson);

  const first = scopeGuard.parseSyntheticScopeManifest(value.manifestJson);
  const second = scopeGuard.parseSyntheticScopeManifest(rebuilt);
  assert.deepEqual(second, first);
  assert.deepEqual(first.files.map(({ id, relativePath }) => ({ id, relativePath })), value.exactFiles);
  for (const file of first.files) {
    assert.match(file.sha256, /^[0-9a-f]{64}$/u);
    assert.match(file.device, /^[0-9]+$/u);
    assert.match(file.inode, /^[0-9]+$/u);
    assert.ok(file.byteLength > 0);
  }
});

test("request JSON is a closed exact-key boundary with duplicate-key rejection", async () => {
  const value = await generatedFixture("request");
  const request = requestFor(value);
  const valid = JSON.stringify(request);
  assert.deepEqual(scopeGuard.parseScopeGuardRequestJson(valid), request);

  const duplicateLiteral = valid.replace(
    '"operation":"verify_manifest"',
    '"operation":"verify_manifest","operation":"verify_manifest"',
  );
  const duplicateEscaped = valid.replace(
    '"operation":"verify_manifest"',
    '"operation":"verify_manifest","\\u006fperation":"verify_manifest"',
  );
  const withExtra = JSON.stringify({ ...request, unexpected: false });
  const { operation: omitted, ...withoutRequired } = request;
  assert.equal(omitted, scopeGuard.VERIFY_OPERATION);

  for (const invalid of [duplicateLiteral, duplicateEscaped, withExtra, JSON.stringify(withoutRequired), "{"]) {
    assert.throws(
      () => scopeGuard.parseScopeGuardRequestJson(invalid),
      hasCode("scope_invalid_manifest"),
    );
  }

  const repeatedIdRequest = {
    ...request,
    requestedFileIds: [request.requestedFileIds[0]!, request.requestedFileIds[0]!],
  };
  await assert.rejects(
    () => scopeGuard.verifySyntheticExactScope(repeatedIdRequest),
    hasCode("scope_duplicate"),
  );
});

test("manifest JSON rejects duplicate, extra, and case-ambiguous identities", async () => {
  const value = await generatedFixture("manifest-schema");
  const parsed = JSON.parse(value.manifestJson) as {
    files: Array<Record<string, unknown>>;
  } & Record<string, unknown>;
  const duplicateKey = value.manifestJson.replace(
    '"relativePath":',
    '"relativePath":"control-a.json","relativePath":',
  );
  const withExtra = JSON.stringify({ ...parsed, unexpected: false });
  const caseAmbiguous = structuredClone(parsed);
  caseAmbiguous.files[1]!.relativePath = "CONTROL-A.JSON";

  assert.throws(() => scopeGuard.parseSyntheticScopeManifest(duplicateKey), hasCode("scope_invalid_manifest"));
  assert.throws(() => scopeGuard.parseSyntheticScopeManifest(withExtra), hasCode("scope_invalid_manifest"));
  assert.throws(() => scopeGuard.parseSyntheticScopeManifest(JSON.stringify(caseAmbiguous)), hasCode("scope_case_ambiguous"));
});

test("successful verification preserves every not-ready limitation", async () => {
  const value = await generatedFixture("receipt");
  const receipt = await scopeGuard.verifySyntheticExactScope(requestFor(value));
  assert.deepEqual(
    {
      admittedFileCount: receipt.admittedFileCount,
      verifiedFileCount: receipt.verifiedFileCount,
      allHashesMatched: receipt.allHashesMatched,
      descriptorRelativeAncestorBinding: receipt.descriptorRelativeAncestorBinding,
      stableParentChainVerified: receipt.stableParentChainVerified,
      fullIsolationVerified: receipt.fullIsolationVerified,
      callerIsolationDeclarationsAreProof: receipt.callerIsolationDeclarationsAreProof,
      syntheticQualificationOnly: receipt.syntheticQualificationOnly,
      realHistoryReady: receipt.realHistoryReady,
      sec001Open: receipt.sec001Open,
    },
    {
      admittedFileCount: 2,
      verifiedFileCount: 2,
      allHashesMatched: true,
      descriptorRelativeAncestorBinding: false,
      stableParentChainVerified: false,
      fullIsolationVerified: false,
      callerIsolationDeclarationsAreProof: false,
      syntheticQualificationOnly: true,
      realHistoryReady: false,
      sec001Open: true,
    },
  );
});

test("capability declarations remain separate from measured evidence", () => {
  const first = isolationPlan.prepareIsolationPlanFromDeclarations(declarations());
  const second = isolationPlan.prepareIsolationPlanFromDeclarations(declarations());
  assert.equal(first.planSha256, second.planSha256);
  assert.deepEqual(
    {
      callerDeclarationsOnly: first.callerDeclarationsOnly,
      measuredCapabilityCount: first.measuredCapabilityCount,
      isolationVerified: first.isolationVerified,
      ready: first.ready,
      rootRunnerRequired: first.rootRunnerRequired,
      separateOsIdentityRequired: first.separateOsIdentityRequired,
      readOnlyMountRequired: first.readOnlyMountRequired,
      networkIsolationRequired: first.networkIsolationRequired,
    },
    {
      callerDeclarationsOnly: true,
      measuredCapabilityCount: 0,
      isolationVerified: false,
      ready: false,
      rootRunnerRequired: true,
      separateOsIdentityRequired: true,
      readOnlyMountRequired: true,
      networkIsolationRequired: true,
    },
  );
  assert.throws(
    () => isolationPlan.prepareIsolationPlanFromDeclarations({
      ...declarations(),
      declaredAvailableTools: isolationPlan.REQUIRED_OS_TOOLS.slice(1),
    }),
    (error: unknown) => {
      assert.ok(error instanceof isolationPlan.IsolationPlanError);
      assert.equal(error.code, "isolation_declaration_incomplete");
      return true;
    },
  );
});

test("failure receipts contain only typed codes and fixed qualification flags", async () => {
  const value = await generatedFixture("failure");
  const marker = "UNIQUE-MARKER-7841";
  let caught: unknown;
  try {
    await syntheticManifest.prepareSyntheticManifest({
      syntheticSandboxRoot: value.sandbox,
      root: join(value.sandbox, `absent-${marker}`),
      exactFiles: [{ id: "control-c", relativePath: "control-c.txt" }],
    });
  } catch (error) {
    caught = error;
  }
  const scopeReceipt = scopeGuard.toContentFreeFailureReceipt(caught);
  assert.deepEqual(Object.keys(scopeReceipt).toSorted(), [
    "errorCode",
    "realHistoryReady",
    "sec001Open",
    "syntheticQualificationOnly",
  ]);
  assert.equal(scopeReceipt.errorCode, "scope_internal_failure");
  assert.equal(scopeReceipt.realHistoryReady, false);
  assert.doesNotMatch(JSON.stringify(scopeReceipt), new RegExp(marker, "u"));

  const isolationReceipt = rootRunner.toContentFreeRootBoundaryFailureReceipt(
    new isolationPlan.IsolationPlanError("isolation_declaration_incomplete"),
  );
  assert.equal(isolationReceipt.errorCode, "isolation_declaration_incomplete");
  assert.equal(isolationReceipt.realHistoryReady, false);
  assert.equal(isolationReceipt.syntheticQualificationOnly, true);
  assert.equal(isolationReceipt.sec001Open, true);
});

test("implementation imports contain no enumeration or subprocess surface", async () => {
  const sourcePaths = [
    "scope-guard.ts",
    "synthetic-manifest.ts",
    "isolation-plan.ts",
    "root-runner.ts",
  ].map((name) => join(implementationDirectory, name));
  const deniedImportSpecifiers = new Set([
    "node:child_process",
    "child_process",
    "node:cluster",
    "cluster",
    "node:worker_threads",
    "worker_threads",
  ]);

  for (const sourcePath of sourcePaths) {
    const source = await readFile(sourcePath, "utf8");
    const importSpecifiers = [...source.matchAll(/\bfrom\s+["']([^"']+)["']/gu)]
      .map((match) => match[1]!);
    assert.equal(importSpecifiers.some((specifier) => deniedImportSpecifiers.has(specifier)), false);
    assert.doesNotMatch(source, /\b(?:readdir|readdirSync|opendir|opendirSync)\s*\(/u);
    assert.doesNotMatch(source, /\b(?:exec|execFile|fork|spawn|spawnSync)\s*\(/u);
    assert.doesNotMatch(source, /\bimport\s*\(/u);
    assert.doesNotMatch(source, /\brequire\s*\(/u);
  }
});
