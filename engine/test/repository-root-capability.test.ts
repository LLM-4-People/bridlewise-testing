import assert from "node:assert/strict";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readLinuxMountPoints } from "../src/filesystem/linux-path.ts";
import test from "node:test";

import {
  acquireQualifiedTestRepositoryRootCapability,
  acquireRepositoryLocalTestRootCapability,
  borrowRepositoryRootCapability,
  deriveQualifiedTestRepositoryReadCapability,
  deriveRepositoryRootCapabilityLeaseIdentity,
  inspectRepositoryRootCapabilityAdapterAvailability,
  releaseRepositoryRootCapabilityBorrow,
  repositoryRootCapabilityAdapterAvailabilityForObservedState,
  repositoryRootCapabilityBorrowChain,
  repositoryRootCapabilityBorrowLimitViolation,
  repositoryRootCapabilityExpectedRawFileMode,
  repositoryRootPathForInternalUse,
  terminateRepositoryRootCapability,
  type RepositoryRootCapability,
  type RepositoryRootCapabilityLeaseIdentityInput,
} from "../src/filesystem/repository-root-capability-internal.ts";
import {
  decideRepositoryRootCapabilityBudgetOperation,
  type RepositoryRootCapabilityBudgetDecision,
  type RepositoryRootCapabilityBudgetLimits,
  type RepositoryRootCapabilityBudgetOperation,
  type RepositoryRootCapabilityBudgetState,
} from "../src/filesystem/repository-root-capability-contracts.ts";
import { getConfigDocumentSchema } from "../src/kernel/config-contracts.ts";
import { HarnessError } from "../src/kernel/errors.ts";
import { ROOT_POLICY } from "../src/kernel/root-policy.ts";
import {
  inspectSafeRepositoryRootBoundary,
  qualifiedSafeRepositoryRootAccess,
  readSafeRepositoryFile,
  safeRepositoryRootPathForInternalUse,
} from "../scripts/verification/safe-repository-reader.ts";
import {
  createTestSurfaceDispositionManifest,
  parseTestSurfaceDispositionManifest,
  type TestSurfaceDispositionEntry,
} from "../scripts/verification/test-surface.ts";
import { dispositionRecordPath, parseDispositionRecord, serializeDispositionRecord } from "../src/kernel/test-surface-manifest.ts";
import {
  createQualifiedRepositoryLocalTemporaryDirectory,
  createRepositoryLocalTemporaryDirectory,
  qualifiedTestRepositoryRootCreationCapabilityForQualification,
  removeRepositoryLocalTemporaryDirectory,
  removeRepositoryLocalTemporaryRoot,
  TEST_REPOSITORY_ROOT,
  terminateQualifiedRepositoryLocalTemporaryDirectory,
  type QualifiedRepositoryLocalTemporaryDirectory,
} from "./support/repository-local-temporary.ts";
import { withProductionRejectFloor } from "./support/test-env-helpers.ts";

const CONFIG_DOCUMENT_SCHEMA = getConfigDocumentSchema();

const POLICY = ROOT_POLICY.verification.testFixtures.repositoryRootCapability;
const BUDGET_LIMIT_CEILINGS = POLICY.budget.limitCeilings;
const CONFIGURED_BUDGET = CONFIG_DOCUMENT_SCHEMA.parse(JSON.parse(readFileSync(
  new URL("../bridlewise.config.json", import.meta.url),
  "utf8",
))).repositoryRootCapability;
const PROC_FILE_DESCRIPTOR_ROOT = ROOT_POLICY.verification.safeRepositoryRead.procFileDescriptorRoot;
const CANDIDATE_ROOT = resolve(TEST_REPOSITORY_ROOT);

test.after(removeRepositoryLocalTemporaryRoot);

test("Linux test adapter is explicit, path-closed, and has typed unavailable outcomes", () => {
  assert.deepEqual(inspectRepositoryRootCapabilityAdapterAvailability(), {
    available: true,
    adapter: POLICY.adapter,
    openat2Equivalent: false,
    renameRaceClosure: false,
  });
  assert.deepEqual(repositoryRootCapabilityAdapterAvailabilityForObservedState("procfs-unavailable"), {
    available: false,
    code: "safe_path_root_capability_procfs_unavailable",
    fallbackAttempted: false,
  });
  assert.deepEqual(repositoryRootCapabilityAdapterAvailabilityForObservedState("procfs-invalid"), {
    available: false,
    code: "safe_path_root_capability_procfs_invalid",
    fallbackAttempted: false,
  });
  assert.deepEqual(repositoryRootCapabilityAdapterAvailabilityForObservedState("platform-unsupported"), {
    available: false,
    code: "safe_path_root_capability_platform_unsupported",
    fallbackAttempted: false,
  });
  expectCode(
    () => Reflect.apply(inspectRepositoryRootCapabilityAdapterAvailability, undefined, ["/tmp"]),
    "safe_path_root_capability_adapter_probe_invalid",
  );
  expectCode(
    () => Reflect.apply(acquireQualifiedTestRepositoryRootCapability, undefined, ["/tmp"]),
    "safe_path_root_capability_acquisition_invalid",
  );
  // The mount facts come from THIS system's mount table, never an assumed
  // layout (/tmp is a mount point on some hosts and a plain folder on others):
  // a top-level mount point is refused as a root, and as an ancestor of one.
  const topLevelMount = [...readLinuxMountPoints()].filter((point) => point !== "/" && dirname(point) === "/").sort()[0];
  assert.ok(topLevelMount !== undefined, "this system's mount table names a top-level mount point (procfs at least)");
  assert.deepEqual(inspectSafeRepositoryRootBoundary(join(topLevelMount, "untrusted-candidate")), {
    ok: false,
    code: "safe_path_root_ancestor_mountpoint",
  });
  assert.deepEqual(inspectSafeRepositoryRootBoundary(topLevelMount), {
    ok: false,
    code: "safe_path_root_mountpoint",
  });
  const invalidDiscriminant = captureCode(
    () => Reflect.apply(repositoryRootCapabilityAdapterAvailabilityForObservedState, undefined, ["/private/path"]),
    "safe_path_root_capability_discriminant_invalid",
  );
  assert.equal(JSON.stringify(invalidDiscriminant).includes("/private/path"), false);
  assert.deepEqual(
    Reflect.apply(inspectSafeRepositoryRootBoundary, undefined, [{
      acquisition: "raw-path",
      root: "/tmp/untrusted-candidate",
      ambient: "/private/path",
    }]),
    { ok: false, code: "safe_path_root_access_invalid" },
  );
  let accessorRead = false;
  const accessorAccess = { acquisition: "raw-path" };
  Object.defineProperty(accessorAccess, "root", {
    enumerable: true,
    get: () => {
      accessorRead = true;
      return "/tmp/untrusted-candidate";
    },
  });
  assert.deepEqual(
    Reflect.apply(inspectSafeRepositoryRootBoundary, undefined, [accessorAccess]),
    { ok: false, code: "safe_path_root_access_invalid" },
  );
  assert.equal(accessorRead, false);
});

test("every lease-identity authority field has independent hash influence", () => {
  const base: RepositoryRootCapabilityLeaseIdentityInput = {
    schemaVersion: POLICY.schemaVersion,
    issuer: POLICY.capabilityIssuer,
    scope: "repository-local-test-root",
    purpose: "safe-repository-read",
    acquisition: "exclusive-create-beneath-qualified-root",
    adapter: POLICY.adapter,
    openat2Equivalent: false,
    renameRaceClosure: false,
    principal: { uid: "1000", gid: "1000" },
    rootIdentity: {
      device: "1",
      inode: "2",
      type: "directory",
      mode: "40700",
      ownerUid: "1000",
      ownerGid: "1000",
    },
    nonceHex: "11".repeat(POLICY.nonceBytes),
  };
  const baseline = deriveRepositoryRootCapabilityLeaseIdentity(base);
  const influentialMutations: readonly unknown[] = [
    { ...base, scope: "qualified-test-repository-root" },
    { ...base, purpose: "repository-local-test-root-creation" },
    { ...base, acquisition: "module-relative-qualified-root" },
    { ...base, principal: { ...base.principal, uid: "1001" } },
    { ...base, principal: { ...base.principal, gid: "1001" } },
    { ...base, rootIdentity: { ...base.rootIdentity, device: "3" } },
    { ...base, rootIdentity: { ...base.rootIdentity, inode: "3" } },
    { ...base, rootIdentity: { ...base.rootIdentity, mode: "40755" } },
    { ...base, rootIdentity: { ...base.rootIdentity, ownerUid: "1001" } },
    { ...base, rootIdentity: { ...base.rootIdentity, ownerGid: "1001" } },
    { ...base, nonceHex: "22".repeat(POLICY.nonceBytes) },
  ];
  const rejectedMutations: readonly unknown[] = [
    { ...base, schemaVersion: "bridlewise-repository-root-capability/v2" },
    { ...base, issuer: "forged-issuer" },
    { ...base, adapter: "caller-controlled-adapter" },
    { ...base, openat2Equivalent: true },
    { ...base, renameRaceClosure: true },
    { ...base, rootIdentity: { ...base.rootIdentity, type: "file" } },
    { ...base, nonceHex: "11".repeat(POLICY.nonceBytes - 1) },
    { ...base, ambient: "/private/path" },
    { ...base, rootIdentity: { ...base.rootIdentity, ambient: "/private/path" } },
  ];
  assert.match(baseline, /^[0-9a-f]{64}$/u);
  for (const mutation of influentialMutations) {
    assert.notEqual(
      Reflect.apply(deriveRepositoryRootCapabilityLeaseIdentity, undefined, [mutation]),
      baseline,
    );
  }
  for (const mutation of rejectedMutations) {
    expectCode(
      () => Reflect.apply(deriveRepositoryRootCapabilityLeaseIdentity, undefined, [mutation]),
      "safe_path_root_capability_lease_identity_invalid",
    );
  }
});

test("capabilities are opaque, nonserializable, scope-bound, and collision-fenced", () => {
  const fixture = createQualifiedRepositoryLocalTemporaryDirectory("capability-scope-");
  const capability = capabilityOf(fixture);
  const parent = qualifiedTestRepositoryRootCreationCapabilityForQualification();
  try {
    assert.equal(Object.isFrozen(capability), true);
    assert.deepEqual(Object.keys(capability).toSorted(), [
      "acquisition",
      "adapter",
      "issuer",
      "leaseIdentityReference",
      "lifecycle",
      "openat2Equivalent",
      "purpose",
      "renameRaceClosure",
      "schemaVersion",
      "scope",
      "serializable",
    ]);
    assert.equal(Object.values(capability).includes(fixture.path), false);
    assert.equal("uid" in capability || "gid" in capability || "root" in capability || "path" in capability, false);
    expectCode(() => JSON.stringify(capability), "safe_path_root_capability_serialization_denied");
    expectCode(
      () => readSafeRepositoryFile(qualifiedSafeRepositoryRootAccess(parent), ".", 64),
      "safe_path_root_capability_invalid",
    );
    expectCode(
      () => acquireRepositoryLocalTestRootCapability(capability, fixture.path),
      "safe_path_root_capability_invalid",
    );
    expectCode(
      () => acquireRepositoryLocalTestRootCapability(parent, fixture.path),
      "safe_path_root_capability_lease_collision",
    );
    const forged = Object.freeze({ ...capability, issuer: "forged-issuer" });
    expectCode(
      () => Reflect.apply(borrowRepositoryRootCapability, undefined, [forged, "."]),
      "safe_path_root_capability_invalid",
    );
  } finally {
    removeRepositoryLocalTemporaryDirectory(fixture.path);
  }
});

test("repository-local issuance enforces central scope, mode, and exact fixture ownership", () => {
  const parent = qualifiedTestRepositoryRootCreationCapabilityForQualification();
  const wrongModePath = createRepositoryLocalTemporaryDirectory("capability-wrong-mode-");
  try {
    chmodSync(wrongModePath, 0o755);
    expectCode(
      () => acquireRepositoryLocalTestRootCapability(parent, wrongModePath),
      "safe_path_root_capability_mode_invalid",
    );
    expectCode(
      () => acquireRepositoryLocalTestRootCapability(parent, "/tmp"),
      "safe_path_root_capability_scope_invalid",
    );
    assert.throws(
      () => removeRepositoryLocalTemporaryDirectory(`${wrongModePath}/../not-owned`),
      /outside its authority/u,
    );
  } finally {
    chmodSync(wrongModePath, 0o700);
    removeRepositoryLocalTemporaryDirectory(wrongModePath);
  }
});

test("fresh qualified roots enforce expired, revoked, and closed lifecycle dispositions", () => {
  for (const disposition of POLICY.terminationDispositions) {
    const fixture = createQualifiedRepositoryLocalTemporaryDirectory(`capability-${disposition}-`);
    const file = join(fixture.path, "value.txt");
    writeFileSync(file, `${disposition}\n`);
    assert.equal(readSafeRepositoryFile(fixture.access, "value.txt", 64).bytes.toString(), `${disposition}\n`);
    const leaseIdentity = capabilityOf(fixture).leaseIdentityReference;
    terminateQualifiedRepositoryLocalTemporaryDirectory(fixture, disposition);
    const error = captureCode(
      () => readSafeRepositoryFile(fixture.access, "value.txt", 64),
      `safe_path_root_capability_${disposition}`,
    );
    const safeError = JSON.stringify({ message: error.message, code: error.code, safeDetails: error.safeDetails });
    assert.equal(safeError.includes(fixture.path), false);
    assert.equal(safeError.includes(leaseIdentity), false);
    assert.equal(safeError.includes(String(process.getuid?.())), false);
    assert.equal(safeError.includes(String(process.getgid?.())), false);
    assert.equal(existsSync(fixture.path), false);
  }
});

test("qualified reads reject symlink, hardlink, mounted raw roots, and root substitution", () => {
  withProductionRejectFloor(() => {
  const entryFixture = createQualifiedRepositoryLocalTemporaryDirectory("capability-entry-hostile-");
  try {
    writeFileSync(join(entryFixture.path, "source.txt"), "source\n");
    linkSync(join(entryFixture.path, "source.txt"), join(entryFixture.path, "alias.txt"));
    expectCode(
      () => readSafeRepositoryFile(entryFixture.access, "source.txt", 64),
      "safe_path_hardlink",
    );
    symlinkSync("source.txt", join(entryFixture.path, "leaf-link.txt"));
    expectCode(
      () => readSafeRepositoryFile(entryFixture.access, "leaf-link.txt", 64),
      "safe_path_symlink",
    );
    mkdirSync(join(entryFixture.path, "real"));
    writeFileSync(join(entryFixture.path, "real", "nested.txt"), "nested\n");
    symlinkSync("real", join(entryFixture.path, "ancestor-link"));
    expectCode(
      () => readSafeRepositoryFile(entryFixture.access, "ancestor-link/nested.txt", 64),
      "safe_path_ancestor_symlink",
    );
    for (const hostilePath of ["", "/absolute", "../escape", "real/./nested.txt", "real//nested.txt"]) {
      const error = captureCode(
        () => readSafeRepositoryFile(entryFixture.access, hostilePath, 64),
        "safe_path_invalid",
      );
      assert.deepEqual(Object.keys(error.safeDetails), ["pathHash"]);
      assert.match(String(error.safeDetails.pathHash), /^[0-9a-f]{64}$/u);
      if (hostilePath.length > 0) {
        assert.equal(JSON.stringify(error.safeDetails).includes(hostilePath), false);
      }
    }
  } finally {
    removeRepositoryLocalTemporaryDirectory(entryFixture.path);
  }

  const replacementFixture = createQualifiedRepositoryLocalTemporaryDirectory("capability-replacement-");
  const movedReplacement = `${replacementFixture.path}-original`;
  try {
    renameSync(replacementFixture.path, movedReplacement);
    expectCode(
      () => readSafeRepositoryFile(replacementFixture.access, ".", 64),
      "safe_path_root_capability_identity_changed",
    );
    mkdirSync(replacementFixture.path, { mode: 0o700 });
    expectCode(
      () => readSafeRepositoryFile(replacementFixture.access, ".", 64),
      "safe_path_root_capability_identity_changed",
    );
    rmSync(replacementFixture.path, { recursive: true });
    renameSync(movedReplacement, replacementFixture.path);
  } finally {
    if (existsSync(movedReplacement) && !existsSync(replacementFixture.path)) {
      renameSync(movedReplacement, replacementFixture.path);
    }
    removeRepositoryLocalTemporaryDirectory(replacementFixture.path);
  }

  const symlinkFixture = createQualifiedRepositoryLocalTemporaryDirectory("capability-root-symlink-");
  const movedSymlink = `${symlinkFixture.path}-original`;
  try {
    renameSync(symlinkFixture.path, movedSymlink);
    symlinkSync(movedSymlink, symlinkFixture.path);
    expectCode(
      () => readSafeRepositoryFile(symlinkFixture.access, ".", 64),
      "safe_path_root_capability_identity_changed",
    );
    unlinkSync(symlinkFixture.path);
    renameSync(movedSymlink, symlinkFixture.path);
  } finally {
    if (existsSync(symlinkFixture.path)) {
      try {
        unlinkSync(symlinkFixture.path);
      } catch {
        // It is already the restored directory.
      }
    }
    if (existsSync(movedSymlink) && !existsSync(symlinkFixture.path)) {
      renameSync(movedSymlink, symlinkFixture.path);
    }
    removeRepositoryLocalTemporaryDirectory(symlinkFixture.path);
  }

  const modeFixture = createQualifiedRepositoryLocalTemporaryDirectory("capability-mode-");
  try {
    chmodSync(modeFixture.path, 0o755);
    expectCode(
      () => readSafeRepositoryFile(modeFixture.access, ".", 64),
      "safe_path_root_capability_identity_changed",
    );
    chmodSync(modeFixture.path, 0o700);
  } finally {
    removeRepositoryLocalTemporaryDirectory(modeFixture.path);
  }
  });
});

test("central budget fields have distinct typed influence and rotation preserves the task aggregate", () => {
  const fieldCases: ReadonlyArray<Readonly<{
    field: Exclude<keyof RepositoryRootCapabilityBudgetLimits, "schemaVersion">;
    state: RepositoryRootCapabilityBudgetState;
    operation: RepositoryRootCapabilityBudgetOperation;
    code: Exclude<RepositoryRootCapabilityBudgetDecision, { allowed: true }>["code"];
  }>> = [
    {
      field: "maximumConcurrentBorrowsPerCapability",
      state: budgetState({ activeBorrowOperations: [0] }),
      operation: { kind: "borrow", path: "." },
      code: "safe_path_root_capability_busy",
    },
    {
      field: "maximumOperationsPerBorrow",
      state: budgetState({ activeBorrowOperations: [CONFIGURED_BUDGET.maximumOperationsPerBorrow] }),
      operation: { kind: "operate", borrowIndex: 0 },
      code: "safe_path_root_capability_borrow_operation_limit",
    },
    {
      field: "maximumBorrowOperationsPerCapability",
      state: budgetState({
        borrowOperationsForCapability: CONFIGURED_BUDGET.maximumBorrowOperationsPerCapability,
      }),
      operation: { kind: "borrow", path: "." },
      code: "safe_path_root_capability_capability_operation_limit",
    },
    {
      field: "maximumBorrowOperationsPerTask",
      state: budgetState({
        borrowOperationsForTask: CONFIGURED_BUDGET.maximumBorrowOperationsPerTask,
      }),
      operation: { kind: "borrow", path: "." },
      code: "safe_path_root_capability_task_operation_limit",
    },
    {
      field: "maximumCapabilityRotationsPerTask",
      state: budgetState({
        capabilityRotationsForTask: CONFIGURED_BUDGET.maximumCapabilityRotationsPerTask,
      }),
      operation: { kind: "rotate" },
      code: "safe_path_root_capability_rotation_limit",
    },
    {
      field: "maximumBorrowedPathBytes",
      state: budgetState(),
      operation: {
        kind: "borrow",
        path: "a".repeat(CONFIGURED_BUDGET.maximumBorrowedPathBytes + 1),
      },
      code: "safe_path_root_capability_path_bytes_limit",
    },
    {
      field: "maximumBorrowedPathSegments",
      state: budgetState(),
      operation: {
        kind: "borrow",
        path: Array.from(
          { length: CONFIGURED_BUDGET.maximumBorrowedPathSegments + 1 },
          () => "a",
        ).join("/"),
      },
      code: "safe_path_root_capability_path_segments_limit",
    },
  ];
  const observedCodes = new Set<string>();
  for (const fixture of fieldCases) {
    const denied = decideRepositoryRootCapabilityBudgetOperation(
      CONFIGURED_BUDGET,
      fixture.state,
      fixture.operation,
    );
    assert.equal(denied.allowed, false, `${fixture.field}: configured denial`);
    if (denied.allowed) assert.fail(`${fixture.field}: expected denial`);
    assert.equal(denied.code, fixture.code, `${fixture.field}: typed outcome`);
    observedCodes.add(denied.code);
    const widened = {
      ...CONFIGURED_BUDGET,
      [fixture.field]: CONFIGURED_BUDGET[fixture.field] + 1,
    };
    assert.equal(
      decideRepositoryRootCapabilityBudgetOperation(
        widened,
        fixture.state,
        fixture.operation,
      ).allowed,
      true,
      `${fixture.field}: independent field influence`,
    );
  }
  assert.equal(observedCodes.size, fieldCases.length);

  const rotationLimits: RepositoryRootCapabilityBudgetLimits = {
    ...CONFIGURED_BUDGET,
    maximumBorrowOperationsPerCapability: 1,
    maximumBorrowOperationsPerTask: 2,
    maximumCapabilityRotationsPerTask: 2,
  };
  const firstBorrow = requireAllowed(decideRepositoryRootCapabilityBudgetOperation(
    rotationLimits,
    budgetState(),
    { kind: "borrow", path: "." },
  ));
  const firstRelease = requireAllowed(decideRepositoryRootCapabilityBudgetOperation(
    rotationLimits,
    firstBorrow,
    { kind: "release", borrowIndex: 0 },
  ));
  assert.equal(
    decideRepositoryRootCapabilityBudgetOperation(
      rotationLimits,
      firstRelease,
      { kind: "borrow", path: "." },
    ).allowed,
    false,
    "per-capability budget is finite before rotation",
  );
  const firstRotation = requireAllowed(decideRepositoryRootCapabilityBudgetOperation(
    rotationLimits,
    firstRelease,
    { kind: "rotate" },
  ));
  assert.equal(firstRotation.borrowOperationsForCapability, 0);
  assert.equal(firstRotation.borrowOperationsForTask, 1);
  const secondBorrow = requireAllowed(decideRepositoryRootCapabilityBudgetOperation(
    rotationLimits,
    firstRotation,
    { kind: "borrow", path: "." },
  ));
  const secondRelease = requireAllowed(decideRepositoryRootCapabilityBudgetOperation(
    rotationLimits,
    secondBorrow,
    { kind: "release", borrowIndex: 0 },
  ));
  const secondRotation = requireAllowed(decideRepositoryRootCapabilityBudgetOperation(
    rotationLimits,
    secondRelease,
    { kind: "rotate" },
  ));
  assert.equal(secondRotation.borrowOperationsForCapability, 0);
  assert.equal(secondRotation.borrowOperationsForTask, 2);
  assert.deepEqual(
    decideRepositoryRootCapabilityBudgetOperation(
      rotationLimits,
      secondRotation,
      { kind: "borrow", path: "." },
    ),
    {
      allowed: false,
      code: "safe_path_root_capability_task_operation_limit",
      state: secondRotation,
    },
  );
  assert.equal(
    decideRepositoryRootCapabilityBudgetOperation(
      rotationLimits,
      secondRotation,
      { kind: "rotate" },
    ).allowed,
    false,
    "rotation ceiling remains finite",
  );
});

test("pre-migration runtime retains finite root ceilings without claiming config migration", () => {
  const limits = {
    maximumConcurrentBorrowsPerCapability: 2,
    maximumBorrowOperationsPerCapability: 2,
    maximumBorrowedPathBytes: 3,
    maximumBorrowedPathSegments: 2,
  } as const;
  assert.equal(repositoryRootCapabilityBorrowLimitViolation(limits, {
    activeBorrows: 1, borrowOperations: 1, path: "a/b",
  }), null);
  assert.equal(repositoryRootCapabilityBorrowLimitViolation({
    ...limits, maximumConcurrentBorrowsPerCapability: 1,
  }, { activeBorrows: 1, borrowOperations: 1, path: "a/b" }), "safe_path_root_capability_busy");
  assert.equal(repositoryRootCapabilityBorrowLimitViolation({
    ...limits, maximumBorrowOperationsPerCapability: 1,
  }, { activeBorrows: 0, borrowOperations: 1, path: "a/b" }),
  "safe_path_root_capability_operation_limit");
  assert.equal(repositoryRootCapabilityBorrowLimitViolation({
    ...limits, maximumBorrowedPathBytes: 1,
  }, { activeBorrows: 0, borrowOperations: 0, path: "ab" }),
  "safe_path_root_capability_operation_limit");
  assert.equal(repositoryRootCapabilityBorrowLimitViolation({
    ...limits, maximumBorrowedPathSegments: 1,
  }, { activeBorrows: 0, borrowOperations: 0, path: "a/b" }),
  "safe_path_root_capability_operation_limit");

  const concurrencyFixture = createQualifiedRepositoryLocalTemporaryDirectory("capability-concurrency-");
  const concurrencyCapability = capabilityOf(concurrencyFixture);
  try {
    assert.equal(BUDGET_LIMIT_CEILINGS.maximumConcurrentBorrowsPerCapability, 1);
    const borrow = borrowRepositoryRootCapability(concurrencyCapability, ".");
    expectCode(
      () => terminateRepositoryRootCapability(concurrencyCapability, "closed"),
      "safe_path_root_capability_lifecycle_invalid",
    );
    expectCode(
      () => borrowRepositoryRootCapability(concurrencyCapability, "."),
      "safe_path_root_capability_busy",
    );
    releaseRepositoryRootCapabilityBorrow(borrow);
    expectCode(
      () => releaseRepositoryRootCapabilityBorrow(borrow),
      "safe_path_root_capability_borrow_invalid",
    );
    expectCode(
      () => borrowRepositoryRootCapability(
        concurrencyCapability,
        "a".repeat(BUDGET_LIMIT_CEILINGS.maximumBorrowedPathBytes + 1),
      ),
      "safe_path_root_capability_operation_limit",
    );
    expectCode(
      () => borrowRepositoryRootCapability(
        concurrencyCapability,
        Array.from(
          { length: BUDGET_LIMIT_CEILINGS.maximumBorrowedPathSegments + 1 },
          () => "a",
        ).join("/"),
      ),
      "safe_path_root_capability_operation_limit",
    );
  } finally {
    removeRepositoryLocalTemporaryDirectory(concurrencyFixture.path);
  }

  const operationFixture = createQualifiedRepositoryLocalTemporaryDirectory("capability-operation-limit-");
  const operationCapability = capabilityOf(operationFixture);
  try {
    for (let index = 0;
      index < BUDGET_LIMIT_CEILINGS.maximumBorrowOperationsPerCapability;
      index += 1) {
      const borrow = borrowRepositoryRootCapability(operationCapability, ".");
      releaseRepositoryRootCapabilityBorrow(borrow);
    }
    expectCode(
      () => borrowRepositoryRootCapability(operationCapability, "."),
      "safe_path_root_capability_operation_limit",
    );
  } finally {
    removeRepositoryLocalTemporaryDirectory(operationFixture.path);
  }
});

test("closed descriptor-number reuse cannot revive a capability and leaves no descriptor residue", () => {
  const fixture = createQualifiedRepositoryLocalTemporaryDirectory("capability-descriptor-reuse-");
  const targetDescriptors = descriptorsTargeting(fixture.path);
  assert.equal(targetDescriptors.length, 1);
  const retainedDescriptor = targetDescriptors[0]!;
  terminateQualifiedRepositoryLocalTemporaryDirectory(fixture, "closed");
  assert.deepEqual(descriptorsTargeting(fixture.path), []);

  const opened: number[] = [];
  try {
    for (let index = 0; index < 64 && !opened.includes(retainedDescriptor); index += 1) {
      opened.push(openSync("/", constants.O_RDONLY | constants.O_DIRECTORY));
    }
    assert.equal(opened.includes(retainedDescriptor), true);
    expectCode(
      () => readSafeRepositoryFile(fixture.access, ".", 64),
      "safe_path_root_capability_closed",
    );
  } finally {
    for (const descriptor of opened) closeSync(descriptor);
  }
  assert.deepEqual(descriptorsTargeting(fixture.path), []);
  assert.equal(existsSync(fixture.path), false);
});

test("hostile lifecycle: acquire, use, release, and re-acquire an opaque borrow", () => {
  const fixture = createQualifiedRepositoryLocalTemporaryDirectory("capability-lifecycle-");
  const capability = capabilityOf(fixture);
  try {
    writeFileSync(join(fixture.path, "file.txt"), "lifecycle\n");
    const borrow1 = borrowRepositoryRootCapability(capability, ".");
    const chain1 = repositoryRootCapabilityBorrowChain(borrow1);
    assert.equal(chain1.leafLexicalPath, fixture.path);
    releaseRepositoryRootCapabilityBorrow(borrow1);
    const borrow2 = borrowRepositoryRootCapability(capability, ".");
    assert.notEqual(borrow1, borrow2);
    const chain2 = repositoryRootCapabilityBorrowChain(borrow2);
    assert.equal(chain2.leafLexicalPath, fixture.path);
    releaseRepositoryRootCapabilityBorrow(borrow2);
    assert.equal(
      readSafeRepositoryFile(fixture.access, "file.txt", 64).bytes.toString(),
      "lifecycle\n",
    );
  } finally {
    removeRepositoryLocalTemporaryDirectory(fixture.path);
  }
});

test("hostile alias: opaque borrow rejects forged, proxy, and post-release chain access", () => {
  const fixture = createQualifiedRepositoryLocalTemporaryDirectory("capability-alias-");
  const capability = capabilityOf(fixture);
  try {
    const borrow = borrowRepositoryRootCapability(capability, ".");
    assert.deepEqual(Object.keys(borrow).toSorted(), ["serializable"]);
    assert.equal("chain" in borrow, false);
    const chain = repositoryRootCapabilityBorrowChain(borrow);
    assert.equal(chain.leafLexicalPath, fixture.path);
    const forged = Object.freeze({ serializable: false as const, toJSON: () => undefined });
    expectCode(
      () => repositoryRootCapabilityBorrowChain(forged as never),
      "safe_path_root_capability_borrow_invalid",
    );
    const proxied = new Proxy(borrow, {});
    expectCode(
      () => repositoryRootCapabilityBorrowChain(proxied),
      "safe_path_root_capability_invalid",
    );
    releaseRepositoryRootCapabilityBorrow(borrow);
    expectCode(
      () => repositoryRootCapabilityBorrowChain(borrow),
      "safe_path_root_capability_borrow_invalid",
    );
  } finally {
    removeRepositoryLocalTemporaryDirectory(fixture.path);
  }
});

test("hostile exhaustion: exhausting borrow operations then borrowing fails closed", () => {
  const fixture = createQualifiedRepositoryLocalTemporaryDirectory("capability-exhaustion-");
  const capability = capabilityOf(fixture);
  try {
    for (let index = 0; index < CONFIGURED_BUDGET.maximumBorrowOperationsPerCapability; index += 1) {
      const borrow = borrowRepositoryRootCapability(capability, ".");
      releaseRepositoryRootCapabilityBorrow(borrow);
    }
    expectCode(
      () => borrowRepositoryRootCapability(capability, "."),
      "safe_path_root_capability_operation_limit",
    );
  } finally {
    removeRepositoryLocalTemporaryDirectory(fixture.path);
  }
});

test("hostile rotation: terminating a capability invalidates all old handles", () => {
  const fixture1 = createQualifiedRepositoryLocalTemporaryDirectory("capability-rotation-1-");
  const capability1 = capabilityOf(fixture1);
  writeFileSync(join(fixture1.path, "file.txt"), "rotation\n");
  const borrow = borrowRepositoryRootCapability(capability1, ".");
  releaseRepositoryRootCapabilityBorrow(borrow);
  terminateQualifiedRepositoryLocalTemporaryDirectory(fixture1, "closed");
  expectCode(
    () => borrowRepositoryRootCapability(capability1, "."),
    "safe_path_root_capability_closed",
  );
  expectCode(
    () => repositoryRootCapabilityBorrowChain(borrow),
    "safe_path_root_capability_borrow_invalid",
  );

  const fixture2 = createQualifiedRepositoryLocalTemporaryDirectory("capability-rotation-2-");
  try {
    writeFileSync(join(fixture2.path, "file.txt"), "rotation-2\n");
    assert.equal(
      readSafeRepositoryFile(fixture2.access, "file.txt", 64).bytes.toString(),
      "rotation-2\n",
    );
  } finally {
    removeRepositoryLocalTemporaryDirectory(fixture2.path);
  }
});

test("hostile release: double-release, release-then-use, and foreign release all fail closed", () => {
  const fixture = createQualifiedRepositoryLocalTemporaryDirectory("capability-release-");
  const capability = capabilityOf(fixture);
  try {
    releaseRepositoryRootCapabilityBorrow(undefined);
    const borrow = borrowRepositoryRootCapability(capability, ".");
    releaseRepositoryRootCapabilityBorrow(borrow);
    expectCode(
      () => releaseRepositoryRootCapabilityBorrow(borrow),
      "safe_path_root_capability_borrow_invalid",
    );
    expectCode(
      () => repositoryRootCapabilityBorrowChain(borrow),
      "safe_path_root_capability_borrow_invalid",
    );
    const foreignBorrow = Object.freeze({ serializable: false as const, toJSON: () => undefined });
    expectCode(
      () => releaseRepositoryRootCapabilityBorrow(foreignBorrow as never),
      "safe_path_root_capability_borrow_invalid",
    );
  } finally {
    removeRepositoryLocalTemporaryDirectory(fixture.path);
  }
});

test("hostile race: interleaved acquire and release does not corrupt borrow state", () => {
  const fixture = createQualifiedRepositoryLocalTemporaryDirectory("capability-race-");
  const capability = capabilityOf(fixture);
  try {
    const borrows: ReturnType<typeof borrowRepositoryRootCapability>[] = [];
    for (let round = 0; round < 16; round += 1) {
      const borrow = borrowRepositoryRootCapability(capability, ".");
      borrows.push(borrow);
      assert.equal(borrows.length, 1);
      const chain = repositoryRootCapabilityBorrowChain(borrow);
      assert.equal(chain.leafLexicalPath, fixture.path);
      releaseRepositoryRootCapabilityBorrow(borrow);
      borrows.pop();
    }
    assert.equal(borrows.length, 0);
    for (let round = 0; round < 8; round += 1) {
      const borrow = borrowRepositoryRootCapability(capability, ".");
      releaseRepositoryRootCapabilityBorrow(borrow);
      const reBorrow = borrowRepositoryRootCapability(capability, ".");
      releaseRepositoryRootCapabilityBorrow(reBorrow);
    }
    const finalBorrow = borrowRepositoryRootCapability(capability, ".");
    releaseRepositoryRootCapabilityBorrow(finalBorrow);
  } finally {
    removeRepositoryLocalTemporaryDirectory(fixture.path);
  }
});

test("central raw file mode policy classifies paths and enforces exact modes", () => {
  assert.equal(repositoryRootCapabilityExpectedRawFileMode("src/index.ts"), 0o644);
  assert.equal(repositoryRootCapabilityExpectedRawFileMode("test/foo.test.ts"), 0o644);
  assert.equal(repositoryRootCapabilityExpectedRawFileMode("traceability/data.json"), 0o644);
  assert.equal(repositoryRootCapabilityExpectedRawFileMode("bridlewise.config.json"), 0o600);
  assert.equal(repositoryRootCapabilityExpectedRawFileMode("traceability/run.receipt.json"), 0o644);
  assert.equal(repositoryRootCapabilityExpectedRawFileMode("src/config.ts"), 0o644);
  expectCode(
    () => repositoryRootCapabilityExpectedRawFileMode("../escape"),
    "safe_path_root_capability_raw_file_mode_invalid",
  );
  expectCode(
    () => Reflect.apply(repositoryRootCapabilityExpectedRawFileMode, undefined, [null]),
    "safe_path_root_capability_raw_file_mode_invalid",
  );
});

test("deriveQualifiedTestRepositoryReadCapability derives a valid safe-read capability from a qualified creation parent", () => {
  const parent = qualifiedTestRepositoryRootCreationCapabilityForQualification();
  const derived = deriveQualifiedTestRepositoryReadCapability(parent);
  try {
    assert.equal(derived.schemaVersion, POLICY.schemaVersion);
    assert.equal(derived.issuer, POLICY.capabilityIssuer);
    assert.equal(derived.scope, "qualified-test-repository-root");
    assert.equal(derived.purpose, "safe-repository-read");
    assert.equal(derived.acquisition, "module-relative-qualified-root");
    assert.equal(derived.adapter, POLICY.adapter);
    assert.equal(derived.openat2Equivalent, POLICY.openat2Equivalent);
    assert.equal(derived.renameRaceClosure, POLICY.renameRaceClosure);
    assert.equal(derived.lifecycle, POLICY.publicLifecycle);
    assert.equal(derived.serializable, false);
    assert.equal(Object.isFrozen(derived), true);
    assert.equal(repositoryRootPathForInternalUse(derived), CANDIDATE_ROOT);
    const borrow = borrowRepositoryRootCapability(derived, ".");
    try {
      const chain = repositoryRootCapabilityBorrowChain(borrow);
      assert.equal(chain.leafLexicalPath, CANDIDATE_ROOT);
    } finally {
      releaseRepositoryRootCapabilityBorrow(borrow);
    }
  } finally {
    terminateRepositoryRootCapability(derived, "closed");
  }
});

test("deriveQualifiedTestRepositoryReadCapability rejects forged, foreign, wrong-purpose, terminated, and proxy parents", () => {
  const parent = qualifiedTestRepositoryRootCreationCapabilityForQualification();
  const validDerived = deriveQualifiedTestRepositoryReadCapability(parent);
  terminateRepositoryRootCapability(validDerived, "closed");
  const terminatedParentError = captureCode(
    () => deriveQualifiedTestRepositoryReadCapability(validDerived),
    "safe_path_root_capability_closed",
  );
  const localFixture = createQualifiedRepositoryLocalTemporaryDirectory("capability-derive-foreign-");
  try {
    const localCapability = capabilityOf(localFixture);
    const forged = Object.freeze({
      schemaVersion: POLICY.schemaVersion,
      issuer: POLICY.capabilityIssuer,
      scope: "qualified-test-repository-root",
      purpose: "repository-local-test-root-creation",
      acquisition: "module-relative-qualified-root",
      adapter: POLICY.adapter,
      openat2Equivalent: POLICY.openat2Equivalent,
      renameRaceClosure: POLICY.renameRaceClosure,
      leaseIdentityReference: "0".repeat(64),
      lifecycle: POLICY.publicLifecycle,
      serializable: false as const,
    });
    const rejectionCases: ReadonlyArray<Readonly<{ name: string; run: () => unknown; code: string }>> = [
      { name: "forged-plain-object", run: () => deriveQualifiedTestRepositoryReadCapability(forged as never), code: "safe_path_root_capability_invalid" },
      { name: "null", run: () => Reflect.apply(deriveQualifiedTestRepositoryReadCapability, undefined, [null]), code: "safe_path_root_capability_invalid" },
      { name: "undefined", run: () => Reflect.apply(deriveQualifiedTestRepositoryReadCapability, undefined, [undefined]), code: "safe_path_root_capability_invalid" },
      { name: "foreign-scope-repo-local", run: () => deriveQualifiedTestRepositoryReadCapability(localCapability), code: "safe_path_root_capability_invalid" },
      { name: "wrong-purpose-read-capability", run: () => {
        const readCap = deriveQualifiedTestRepositoryReadCapability(parent);
        try { deriveQualifiedTestRepositoryReadCapability(readCap); } finally { terminateRepositoryRootCapability(readCap, "closed"); }
      }, code: "safe_path_root_capability_invalid" },
      { name: "proxy-parent", run: () => deriveQualifiedTestRepositoryReadCapability(new Proxy(parent, {})), code: "safe_path_root_capability_invalid" },
    ];
    for (const testCase of rejectionCases) {
      expectCode(testCase.run, testCase.code);
    }
    assert.equal(terminatedParentError.code, "safe_path_root_capability_closed");
  } finally {
    removeRepositoryLocalTemporaryDirectory(localFixture.path);
  }
});

test("repositoryRootPathForInternalUse returns the correct root path for valid safe-read capabilities", () => {
  const parent = qualifiedTestRepositoryRootCreationCapabilityForQualification();
  const qualifiedRead = deriveQualifiedTestRepositoryReadCapability(parent);
  try {
    assert.equal(repositoryRootPathForInternalUse(qualifiedRead), CANDIDATE_ROOT);
  } finally {
    terminateRepositoryRootCapability(qualifiedRead, "closed");
  }

  const localFixture = createQualifiedRepositoryLocalTemporaryDirectory("capability-path-internal-");
  try {
    assert.equal(repositoryRootPathForInternalUse(capabilityOf(localFixture)), localFixture.path);
    assert.equal(safeRepositoryRootPathForInternalUse(localFixture.access), localFixture.path);
  } finally {
    removeRepositoryLocalTemporaryDirectory(localFixture.path);
  }
});

test("repositoryRootPathForInternalUse rejects forged, foreign, wrong-purpose, terminated, and proxy capabilities", () => {
  const parent = qualifiedTestRepositoryRootCreationCapabilityForQualification();
  const qualifiedRead = deriveQualifiedTestRepositoryReadCapability(parent);
  terminateRepositoryRootCapability(qualifiedRead, "closed");
  const localFixture = createQualifiedRepositoryLocalTemporaryDirectory("capability-path-reject-");
  try {
    const localCap = capabilityOf(localFixture);
    const forged = Object.freeze({
      schemaVersion: POLICY.schemaVersion, issuer: POLICY.capabilityIssuer,
      scope: "qualified-test-repository-root", purpose: "safe-repository-read",
      acquisition: "module-relative-qualified-root", adapter: POLICY.adapter,
      openat2Equivalent: POLICY.openat2Equivalent, renameRaceClosure: POLICY.renameRaceClosure,
      leaseIdentityReference: "0".repeat(64), lifecycle: POLICY.publicLifecycle, serializable: false as const,
    });
    const cases: ReadonlyArray<Readonly<{ name: string; run: () => unknown; code: string }>> = [
      { name: "forged-plain-object", run: () => repositoryRootPathForInternalUse(forged as never), code: "safe_path_root_capability_invalid" },
      { name: "null", run: () => Reflect.apply(repositoryRootPathForInternalUse, undefined, [null]), code: "safe_path_root_capability_invalid" },
      { name: "wrong-purpose-create-parent", run: () => repositoryRootPathForInternalUse(parent), code: "safe_path_root_capability_invalid" },
      { name: "terminated-capability", run: () => repositoryRootPathForInternalUse(qualifiedRead), code: "safe_path_root_capability_closed" },
      { name: "proxy-of-valid", run: () => repositoryRootPathForInternalUse(new Proxy(localCap, {})), code: "safe_path_root_capability_invalid" },
    ];
    for (const c of cases) {
      expectCode(c.run, c.code);
    }
  } finally {
    removeRepositoryLocalTemporaryDirectory(localFixture.path);
  }
});

test("borrowRepositoryRootCapability rejects hostile borrow paths", () => {
  const fixture = createQualifiedRepositoryLocalTemporaryDirectory("capability-borrow-paths-");
  const capability = capabilityOf(fixture);
  try {
    const hostilePaths: ReadonlyArray<Readonly<{ name: string; path: string; code: string }>> = [
      { name: "parent-escape", path: "..", code: "safe_path_invalid" },
      { name: "absolute", path: "/absolute", code: "safe_path_invalid" },
      { name: "empty", path: "", code: "safe_path_invalid" },
      { name: "dot-dot-slash-escape", path: "../escape", code: "safe_path_invalid" },
      { name: "double-slash", path: "a//b", code: "safe_path_invalid" },
      { name: "dot-segment", path: "./b", code: "safe_path_invalid" },
    ];
    for (const c of hostilePaths) {
      expectCode(() => borrowRepositoryRootCapability(capability, c.path), c.code);
    }
    const borrow = borrowRepositoryRootCapability(capability, ".");
    try {
      assert.equal(borrow.serializable, false);
    } finally {
      releaseRepositoryRootCapabilityBorrow(borrow);
    }
  } finally {
    removeRepositoryLocalTemporaryDirectory(fixture.path);
  }
});

test("budget decision supports concurrent borrows when the limit is greater than 1", () => {
  const limits: RepositoryRootCapabilityBudgetLimits = {
    ...CONFIGURED_BUDGET,
    maximumConcurrentBorrowsPerCapability: 2,
    maximumBorrowOperationsPerCapability: 10,
    maximumBorrowOperationsPerTask: 10,
  };
  const firstBorrow = requireAllowed(decideRepositoryRootCapabilityBudgetOperation(
    limits, budgetState(), { kind: "borrow", path: "." },
  ));
  assert.equal(firstBorrow.activeBorrowOperations.length, 1);
  const secondBorrow = requireAllowed(decideRepositoryRootCapabilityBudgetOperation(
    limits, firstBorrow, { kind: "borrow", path: "subdir" },
  ));
  assert.equal(secondBorrow.activeBorrowOperations.length, 2);
  const thirdDecision = decideRepositoryRootCapabilityBudgetOperation(
    limits, secondBorrow, { kind: "borrow", path: "." },
  );
  assert.equal(thirdDecision.allowed, false);
  if (!thirdDecision.allowed) {
    assert.equal(thirdDecision.code, "safe_path_root_capability_busy");
  }
  const firstRelease = requireAllowed(decideRepositoryRootCapabilityBudgetOperation(
    limits, secondBorrow, { kind: "release", borrowIndex: 0 },
  ));
  assert.equal(firstRelease.activeBorrowOperations.length, 1);
  const thirdBorrow = requireAllowed(decideRepositoryRootCapabilityBudgetOperation(
    limits, firstRelease, { kind: "borrow", path: "." },
  ));
  assert.equal(thirdBorrow.activeBorrowOperations.length, 2);
});

test("repositoryRootCapabilityBorrowChain exposes all chain fields including descriptors and root descriptor index", () => {
  const fixture = createQualifiedRepositoryLocalTemporaryDirectory("capability-chain-fields-");
  const capability = capabilityOf(fixture);
  try {
    writeFileSync(join(fixture.path, "file.txt"), "chain\n");
    const borrow = borrowRepositoryRootCapability(capability, ".");
    try {
      const chain = repositoryRootCapabilityBorrowChain(borrow);
      assert.equal(chain.leafLexicalPath, fixture.path);
      assert.ok(chain.descriptors.length > 0, "descriptors array is non-empty");
      assert.ok(chain.lexicalPaths.length > 0, "lexicalPaths array is non-empty");
      assert.ok(chain.rootDescriptorIndex >= 0, "rootDescriptorIndex is non-negative");
      assert.ok(chain.rootDescriptorIndex < chain.descriptors.length, "rootDescriptorIndex is within bounds");
      assert.equal(chain.descriptors.length, chain.lexicalPaths.length);
      const rootDescriptor = chain.descriptors[chain.rootDescriptorIndex]!;
      assert.equal(typeof rootDescriptor, "number");
      const rootStat = fstatSync(rootDescriptor, { bigint: true });
      assert.equal(rootStat.isDirectory(), true);
      assert.equal(chain.lexicalPaths[chain.rootDescriptorIndex], fixture.path);
      assert.equal(chain.leafLexicalPath, chain.lexicalPaths.at(-1));
      for (const desc of chain.descriptors) {
        assert.equal(typeof desc, "number");
        assert.equal(fstatSync(desc, { bigint: true }).isDirectory(), true);
      }
    } finally {
      releaseRepositoryRootCapabilityBorrow(borrow);
    }
  } finally {
    removeRepositoryLocalTemporaryDirectory(fixture.path);
  }
});

test("terminateRepositoryRootCapability rejects invalid disposition strings", () => {
  const fixture = createQualifiedRepositoryLocalTemporaryDirectory("capability-termination-");
  try {
    const invalidDispositions: readonly string[] = [
      "invalid", "", "active", "pending", "running", "OPEN", "closed ", " closed",
      "not-a-disposition", "expired2", "revoke", "CLOSED",
    ];
    for (const disposition of invalidDispositions) {
      expectCode(
        () => Reflect.apply(terminateRepositoryRootCapability, undefined, [capabilityOf(fixture), disposition]),
        "safe_path_root_capability_lifecycle_invalid",
      );
    }
  } finally {
    removeRepositoryLocalTemporaryDirectory(fixture.path);
  }
});

test("proxy capabilities are rejected by acquire, borrow, and path-for-internal-use", () => {
  const parent = qualifiedTestRepositoryRootCreationCapabilityForQualification();
  const localFixture = createQualifiedRepositoryLocalTemporaryDirectory("capability-proxy-reject-");
  try {
    const capability = capabilityOf(localFixture);
    const proxyParent = new Proxy(parent, {});
    const proxyCapability = new Proxy(capability, {});
    expectCode(
      () => acquireRepositoryLocalTestRootCapability(proxyParent, localFixture.path),
      "safe_path_root_capability_invalid",
    );
    expectCode(
      () => borrowRepositoryRootCapability(proxyCapability, "."),
      "safe_path_root_capability_invalid",
    );
    expectCode(
      () => repositoryRootPathForInternalUse(proxyCapability),
      "safe_path_root_capability_invalid",
    );
    expectCode(
      () => terminateRepositoryRootCapability(proxyCapability, "closed"),
      "safe_path_root_capability_invalid",
    );
  } finally {
    removeRepositoryLocalTemporaryDirectory(localFixture.path);
  }
});

test("a test-surface disposition record rejects a stale policyHash, by the source it names (hostile drift regression)", () => {
  const entry: TestSurfaceDispositionEntry = { path: "test/x/oracle.test.ts", language: "javascript-typescript", disposition: "qualified-external-oracle", rationale: "x", evidenceLinks: ["x"], blocksFullRepositoryClaim: false };
  const recordPath = dispositionRecordPath(entry.path);
  const text = serializeDispositionRecord(entry);
  assert.deepEqual(parseDispositionRecord(recordPath, text), entry);
  const staleError = captureCode(
    () => parseDispositionRecord(recordPath, text.replace(/"policyHash": "[0-9a-f]{64}"/u, `"policyHash": "${"0".repeat(64)}"`)),
    "test_surface_disposition_policy_stale",
  );
  assert.equal(staleError.retryable, false);
  assert.equal(staleError.safeDetails.path, entry.path);
  assert.equal(staleError.safeDetails.recordPolicyHash, "0".repeat(64));
  assert.match(String(staleError.safeDetails.currentPolicyHash), /^[0-9a-f]{64}$/u);
  assert.throws(() => parseDispositionRecord(recordPath, text.replace(/"policyHash": "[0-9a-f]{64}"/u, `"policyHash": "not-a-hash"`)));
  const validManifest = createTestSurfaceDispositionManifest([]);
  assert.throws(
    () => parseTestSurfaceDispositionManifest({ ...validManifest, entries: [{ path: "fake.test.ts", language: "javascript-typescript", disposition: "canonical-node-test", rationale: "x", evidenceLinks: ["x"], blocksFullRepositoryClaim: false }] }),
    /test-surface canonical disposition is invalid/u,
  );
  assert.throws(() => parseTestSurfaceDispositionManifest({ ...validManifest, policyHash: "0".repeat(64) }), "no whole-manifest policy hash: each record carries its own");
});

function budgetState(
  overrides: Partial<RepositoryRootCapabilityBudgetState> = {},
): RepositoryRootCapabilityBudgetState {
  return {
    activeBorrowOperations: [],
    borrowOperationsForCapability: 0,
    borrowOperationsForTask: 0,
    capabilityRotationsForTask: 0,
    ...overrides,
  };
}

function requireAllowed(
  decision: RepositoryRootCapabilityBudgetDecision,
): RepositoryRootCapabilityBudgetState {
  if (!decision.allowed) assert.fail(`expected allowed budget decision, received ${decision.code}`);
  return decision.state;
}

function capabilityOf(fixture: QualifiedRepositoryLocalTemporaryDirectory): RepositoryRootCapability {
  assert.equal(fixture.access.acquisition, "qualified-capability");
  if (fixture.access.acquisition !== "qualified-capability") throw new Error("qualified access is required");
  return fixture.access.capability;
}

function expectCode(run: () => unknown, code: string): void {
  captureCode(run, code);
}

function captureCode(run: () => unknown, code: string): HarnessError {
  let captured: unknown;
  try {
    run();
  } catch (error) {
    captured = error;
  }
  if (!(captured instanceof HarnessError)) assert.fail(`expected HarnessError ${code}`);
  assert.equal(captured.code, code);
  if (code.startsWith("safe_path_root_capability_")) {
    assert.ok(
      captured.message === "Repository root capability denied" ||
        captured.message === "Proxy values are forbidden",
      `unexpected message for ${code}: ${captured.message}`,
    );
    assert.equal(captured.retryable, false);
    assert.deepEqual(captured.safeDetails, {});
  }
  return captured;
}

function descriptorsTargeting(path: string): readonly number[] {
  const descriptors: number[] = [];
  for (const name of readdirSync(PROC_FILE_DESCRIPTOR_ROOT)) {
    if (!/^[0-9]+$/u.test(name)) continue;
    try {
      if (readlinkSync(join(PROC_FILE_DESCRIPTOR_ROOT, name)) === path) descriptors.push(Number(name));
    } catch {
      // Descriptor disappeared between the directory read and link read.
    }
  }
  return descriptors.toSorted((left, right) => left - right);
}
