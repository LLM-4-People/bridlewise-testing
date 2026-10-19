import assert from "node:assert/strict";
import { rmSync, readdirSync, lstatSync, existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  withDurableDirectory,
  createExclusiveDurableFile,
  readDurableFile,
  enumerateDurableDirectory,
} from "../../src/filesystem/durable-filesystem.ts";
import { withCurrentNodeRuntimeForFilesystemMechanismTest } from
  "../../src/filesystem/durable-filesystem-internal.ts";
import { canonicalHash } from "../../src/kernel/integrity.ts";
import { ROOT_POLICY, ROOT_POLICY_HASH } from "../../src/kernel/root-policy.ts";
import { createTempDir } from "../support/temp-dir.ts";
import {
  admittedNodeRuntimeAdmissionRecordIdentity,
  admittedNodeRuntimeExecutable,
  admittedNodeRuntimePrincipal,
  configuredRuntimeAdmission,
  currentAdmittedNodeRuntime,
  currentAdmittedNodeRuntimeRecord,
  hasAdmittedNodeRuntime,
  withAdmittedNodeRuntime,
  type AdmittedNodeRuntimeRecord,
  type AdmittedRuntimePrincipal,
  type ConfiguredRuntimeAdmission,
} from "../../src/runtime/admitted-node-runtime.ts";

const TEMPORARY_PATHS = new Set<string>();

function temporaryRoot(prefix: string): string {
  const root = createTempDir(`${prefix}-`);
  TEMPORARY_PATHS.add(root);
  return root;
}

test.after(() => {
  for (const path of TEMPORARY_PATHS) rmSync(path, { recursive: true, force: true });
});

function hasCode(code: string): assert.AssertPredicate {
  return (error: unknown) =>
    error instanceof Error && "code" in error && (error as { code: string }).code === code;
}

const RUNTIME_LAUNCH = ROOT_POLICY.filesystemInfrastructure.runtimeLaunch;
const ADMISSION_CONFIG = RUNTIME_LAUNCH.configuredInternalAdmission;

test("root-policy runtimeLaunch is configured-internal-admission-pending-external-verification", () => {
  assert.equal(
    RUNTIME_LAUNCH.currentProductionState,
    "configured-internal-admission-pending-external-verification",
  );
  assert.equal(RUNTIME_LAUNCH.callerSuppliedAdmissionAllowed, false);
  assert.equal(RUNTIME_LAUNCH.internalMechanismTestCapabilityMayAdmitProductionOrReceipts, false);
  assert.ok(ADMISSION_CONFIG !== undefined, "configuredInternalAdmission must be defined");
});

test("configuredInternalAdmission has a modeled principal with identity and capabilities", () => {
  assert.ok(ADMISSION_CONFIG !== undefined);
  const principal = ADMISSION_CONFIG.principal;
  assert.ok(principal.identity.length > 0, "principal identity must be non-empty");
  assert.ok(principal.capabilities.length > 0, "principal must have capabilities");
  assert.ok(principal.sourceAuthority.length > 0, "principal sourceAuthority must be non-empty");
  for (const capability of principal.capabilities) {
    assert.ok(capability.length > 0, "each capability must be non-empty");
  }
});

test("configuredInternalAdmission runtimeExecutable is process-exec-path with mechanismTestOnly false", () => {
  assert.ok(ADMISSION_CONFIG !== undefined);
  const exec = ADMISSION_CONFIG.runtimeExecutable;
  assert.equal(exec.source, "process-exec-path");
  assert.equal(exec.mechanismTestOnly, false);
  assert.ok(exec.maximumBytes > 0, "maximumBytes must be positive");
});

test("configuredInternalAdmission externalBootstrap records four honest blockers", () => {
  assert.ok(ADMISSION_CONFIG !== undefined);
  const bootstrap = ADMISSION_CONFIG.externalBootstrap;
  assert.equal(bootstrap.status, "not-started");
  assert.equal(bootstrap.blockers.length, 4, "exactly four admission blockers");
  assert.ok(bootstrap.qualifiedNodeRuntimeIdentity !== undefined);
  assert.ok(bootstrap.qualifiedNodeRuntimeIdentity.releaseArchiveSha256.length === 64);
  assert.ok(bootstrap.qualifiedNodeRuntimeIdentity.memberSha256.length === 64);
  assert.ok(bootstrap.qualifiedNodeRuntimeIdentity.signerFingerprint.length > 0);
});

test("configuredRuntimeAdmission returns central configured admission not caller-supplied", () => {
  const admission = configuredRuntimeAdmission();
  assert.equal(admission.principal.identity, ADMISSION_CONFIG.principal.identity);
  assert.equal(admission.principal.capabilities, ADMISSION_CONFIG.principal.capabilities);
  assert.equal(admission.principal.sourceAuthority, ADMISSION_CONFIG.principal.sourceAuthority);
  assert.equal(admission.executableSource, "process-exec-path");
  assert.equal(admission.mechanismTestOnly, false);
  assert.equal(admission.executableMaximumBytes, ADMISSION_CONFIG.runtimeExecutable.maximumBytes);
});

test("configuredRuntimeAdmission is a frozen object", () => {
  const admission = configuredRuntimeAdmission();
  assert.ok(Object.isFrozen(admission));
  assert.ok(Object.isFrozen(admission.principal));
});

test("configuredRuntimeAdmission returns the same identity each call", () => {
  const a = configuredRuntimeAdmission();
  const b = configuredRuntimeAdmission();
  assert.equal(a.principal.identity, b.principal.identity);
  assert.equal(a.executableSource, b.executableSource);
  assert.equal(a.executableMaximumBytes, b.executableMaximumBytes);
});

test("hasAdmittedNodeRuntime is false before activation", () => {
  assert.equal(hasAdmittedNodeRuntime(), false);
});

test("currentAdmittedNodeRuntime is undefined before activation", () => {
  assert.equal(currentAdmittedNodeRuntime(), undefined);
});

test("currentAdmittedNodeRuntimeRecord is undefined before activation", () => {
  assert.equal(currentAdmittedNodeRuntimeRecord(), undefined);
});

test("admittedNodeRuntimePrincipal is undefined before activation", () => {
  assert.equal(admittedNodeRuntimePrincipal(), undefined);
});

test("admittedNodeRuntimeExecutable is undefined before activation", () => {
  assert.equal(admittedNodeRuntimeExecutable(), undefined);
});

test("withAdmittedNodeRuntime activates and deactivates the runtime", () => {
  const admission = configuredRuntimeAdmission();
  let observedInside = false;
  withAdmittedNodeRuntime(admission, () => {
    observedInside = hasAdmittedNodeRuntime();
  });
  assert.equal(observedInside, true);
  assert.equal(hasAdmittedNodeRuntime(), false);
});

test("withAdmittedNodeRuntime makes currentAdmittedNodeRuntime available inside", () => {
  const admission = configuredRuntimeAdmission();
  let capturedIdentity: string | undefined;
  withAdmittedNodeRuntime(admission, () => {
    const state = currentAdmittedNodeRuntime();
    assert.ok(state !== undefined);
    assert.equal(state!.active, true);
    capturedIdentity = state!.principal.identity;
  });
  assert.equal(capturedIdentity, admission.principal.identity);
});

test("withAdmittedNodeRuntime makes admittedNodeRuntimePrincipal available inside", () => {
  const admission = configuredRuntimeAdmission();
  let captured: AdmittedRuntimePrincipal | undefined;
  withAdmittedNodeRuntime(admission, () => {
    captured = admittedNodeRuntimePrincipal();
  });
  assert.ok(captured !== undefined);
  assert.equal(captured!.identity, admission.principal.identity);
  assert.deepEqual(captured!.capabilities, admission.principal.capabilities);
});

test("withAdmittedNodeRuntime makes admittedNodeRuntimeExecutable available inside", () => {
  const admission = configuredRuntimeAdmission();
  let captured: ReturnType<typeof admittedNodeRuntimeExecutable>;
  withAdmittedNodeRuntime(admission, () => {
    captured = admittedNodeRuntimeExecutable();
  });
  assert.ok(captured !== undefined);
  assert.equal(captured!.mechanismTestOnly, false);
  assert.ok(captured!.identityHash.length === 64);
});

test("withAdmittedNodeRuntime produces an admission record", () => {
  const admission = configuredRuntimeAdmission();
  let record: AdmittedNodeRuntimeRecord | undefined;
  withAdmittedNodeRuntime(admission, () => {
    record = currentAdmittedNodeRuntimeRecord();
  });
  assert.ok(record !== undefined);
  assert.equal(record!.schemaVersion, "bridlewise-admitted-node-runtime-record/v1");
  assert.equal(record!.principal.identity, admission.principal.identity);
  assert.equal(record!.admissionClass, ADMISSION_CONFIG.admissionClass);
  assert.equal(record!.policyHash, ROOT_POLICY_HASH);
  assert.equal(record!.externalBootstrapStatus, "not-started");
  assert.equal(record!.externalBootstrapBlockers.length, 4);
  assert.ok(record!.executableIdentityHash.length === 64);
  assert.ok(record!.admittedAt.length > 0);
});

test("withAdmittedNodeRuntime record is frozen", () => {
  const admission = configuredRuntimeAdmission();
  let record: AdmittedNodeRuntimeRecord | undefined;
  withAdmittedNodeRuntime(admission, () => {
    record = currentAdmittedNodeRuntimeRecord();
  });
  assert.ok(record !== undefined);
  assert.ok(Object.isFrozen(record));
  assert.ok(Object.isFrozen(record!.principal));
});

test("admittedNodeRuntimeAdmissionRecordIdentity produces a stable 64-char hex hash", () => {
  const admission = configuredRuntimeAdmission();
  let record: AdmittedNodeRuntimeRecord | undefined;
  withAdmittedNodeRuntime(admission, () => {
    record = currentAdmittedNodeRuntimeRecord();
  });
  assert.ok(record !== undefined);
  const hash = admittedNodeRuntimeAdmissionRecordIdentity(record!);
  assert.match(hash, /^[0-9a-f]{64}$/u);
  assert.equal(hash, canonicalHash(record!));
});

test("admitted runtime records share stable fields across activations except timestamp", () => {
  const admission = configuredRuntimeAdmission();
  let record1: AdmittedNodeRuntimeRecord | undefined;
  withAdmittedNodeRuntime(admission, () => {
    record1 = currentAdmittedNodeRuntimeRecord();
  });
  let record2: AdmittedNodeRuntimeRecord | undefined;
  withAdmittedNodeRuntime(admission, () => {
    record2 = currentAdmittedNodeRuntimeRecord();
  });
  assert.ok(record1 !== undefined && record2 !== undefined);
  assert.equal(record1!.schemaVersion, record2!.schemaVersion);
  assert.equal(record1!.principal.identity, record2!.principal.identity);
  assert.equal(record1!.admissionClass, record2!.admissionClass);
  assert.equal(record1!.policyHash, record2!.policyHash);
  assert.equal(record1!.externalBootstrapStatus, record2!.externalBootstrapStatus);
  assert.deepEqual(record1!.externalBootstrapBlockers, record2!.externalBootstrapBlockers);
  assert.equal(record1!.executableIdentityHash, record2!.executableIdentityHash);
});

test("withAdmittedNodeRuntime supports async operations", async () => {
  const admission = configuredRuntimeAdmission();
  let observedInside = false;
  await withAdmittedNodeRuntime(admission, async () => {
    observedInside = hasAdmittedNodeRuntime();
    await Promise.resolve();
    assert.equal(hasAdmittedNodeRuntime(), true, "runtime must remain active across await");
  });
  assert.equal(observedInside, true);
  assert.equal(hasAdmittedNodeRuntime(), false, "runtime must deactivate after async");
});

test("withAdmittedNodeRuntime deactivates even on sync throw", () => {
  const admission = configuredRuntimeAdmission();
  assert.throws(
    () => withAdmittedNodeRuntime(admission, () => {
      throw new Error("test error");
    }),
    /test error/,
  );
  assert.equal(hasAdmittedNodeRuntime(), false, "runtime must deactivate after sync throw");
});

test("withAdmittedNodeRuntime deactivates even on async rejection", async () => {
  const admission = configuredRuntimeAdmission();
  await assert.rejects(
    withAdmittedNodeRuntime(admission, async () => {
      throw new Error("async test error");
    }),
    /async test error/,
  );
  assert.equal(hasAdmittedNodeRuntime(), false, "runtime must deactivate after async rejection");
});

test("withAdmittedNodeRuntime rejects nested admission", () => {
  const admission = configuredRuntimeAdmission();
  assert.throws(
    () => withAdmittedNodeRuntime(admission, () => {
      withAdmittedNodeRuntime(admission, () => {});
    }),
    hasCode("runtime_admission_nested"),
  );
  assert.equal(hasAdmittedNodeRuntime(), false);
});

test("withAdmittedNodeRuntime rejects mechanismTestOnly admission", () => {
  const fakeAdmission: ConfiguredRuntimeAdmission = {
    principal: configuredRuntimeAdmission().principal,
    executableSource: "process-exec-path",
    executableMaximumBytes: 268_435_456,
    mechanismTestOnly: true,
  };
  assert.throws(
    () => withAdmittedNodeRuntime(fakeAdmission, () => {}),
    hasCode("runtime_admission_mechanism_test_only_not_allowed"),
  );
});

test("admitted runtime enables durable filesystem directory creation x3", () => {
  const admission = configuredRuntimeAdmission();
  for (let rep = 0; rep < 3; rep += 1) {
    const root = temporaryRoot(`admitted-fs-dir-${rep}-`);
    withAdmittedNodeRuntime(admission, () => {
      withDurableDirectory({ absoluteRoot: root, relativeSegments: ["state"], create: true }, (dir) => {
        assert.equal(lstatSync(join(root, "state")).mode & 0o7777, 0o700);
        const created = createExclusiveDurableFile(dir, "test.bin", Buffer.from("data"));
        assert.equal(created.disposition, "created");
        assert.equal(lstatSync(join(root, "state/test.bin")).mode & 0o7777, 0o600);
      });
    });
  }
});

test("admitted runtime enables durable filesystem file read and enumerate x3", () => {
  const admission = configuredRuntimeAdmission();
  for (let rep = 0; rep < 3; rep += 1) {
    const root = temporaryRoot(`admitted-fs-rw-${rep}-`);
    withAdmittedNodeRuntime(admission, () => {
      withDurableDirectory({ absoluteRoot: root, relativeSegments: ["data"], create: true }, (dir) => {
        createExclusiveDurableFile(dir, "a.bin", Buffer.from("alpha"));
        createExclusiveDurableFile(dir, "b.bin", Buffer.from("beta"));
        const readA = readDurableFile(dir, "a.bin");
        assert.equal(readA.disposition, "present");
        if (readA.disposition === "present") {
          assert.equal(Buffer.from(readA.bytes).toString(), "alpha");
        }
        const entries = enumerateDurableDirectory(dir);
        assert.deepEqual(entries, [{ name: "a.bin", kind: "file" }, { name: "b.bin", kind: "file" }]);
      });
    });
  }
});

test("without any runtime, durable filesystem creation fails with filesystem_runtime_not_admitted x3", () => {
  for (let rep = 0; rep < 3; rep += 1) {
    const root = temporaryRoot(`no-runtime-denial-${rep}-`);
    const before = readdirSync(root);
    assert.throws(
      () => withDurableDirectory({ absoluteRoot: root, relativeSegments: ["state"], create: true }, () => {}),
      hasCode("filesystem_runtime_not_admitted"),
    );
    assert.deepEqual(readdirSync(root), before, "no side effects on denial");
  }
});

test("mechanism-test runtime still works independently for tests x3", () => {
  for (let rep = 0; rep < 3; rep += 1) {
    const root = temporaryRoot(`mechanism-test-${rep}-`);
    withCurrentNodeRuntimeForFilesystemMechanismTest(() => {
      withDurableDirectory({ absoluteRoot: root, relativeSegments: ["state"], create: true }, (dir) => {
        assert.equal(lstatSync(join(root, "state")).mode & 0o7777, 0o700);
        createExclusiveDurableFile(dir, "test.bin", Buffer.from("ok"));
      });
    });
    assert.equal(hasAdmittedNodeRuntime(), false, "mechanism-test must not set admitted runtime");
  }
});

test("admitted runtime and mechanism-test runtime do not interfere", () => {
  const admission = configuredRuntimeAdmission();
  const root = temporaryRoot("mixed-runtime-");
  withAdmittedNodeRuntime(admission, () => {
    assert.equal(hasAdmittedNodeRuntime(), true);
    withDurableDirectory({ absoluteRoot: root, relativeSegments: ["admitted"], create: true }, (dir) => {
      createExclusiveDurableFile(dir, "a.bin", Buffer.from("from-admitted"));
    });
  });
  assert.equal(hasAdmittedNodeRuntime(), false);
  withCurrentNodeRuntimeForFilesystemMechanismTest(() => {
    assert.equal(hasAdmittedNodeRuntime(), false);
    withDurableDirectory({ absoluteRoot: root, relativeSegments: ["mechanism"], create: true }, (dir) => {
      createExclusiveDurableFile(dir, "m.bin", Buffer.from("from-mechanism"));
    });
  });
  assert.ok(existsSync(join(root, "admitted", "a.bin")));
  assert.ok(existsSync(join(root, "mechanism", "m.bin")));
});

test("admitted runtime does not survive across async boundaries after completion", async () => {
  const admission = configuredRuntimeAdmission();
  await withAdmittedNodeRuntime(admission, async () => {
    assert.equal(hasAdmittedNodeRuntime(), true);
  });
  assert.equal(hasAdmittedNodeRuntime(), false);
  await Promise.resolve();
  assert.equal(hasAdmittedNodeRuntime(), false);
});

test("admitted runtime record binds to current root-policy hash", () => {
  const admission = configuredRuntimeAdmission();
  let record: AdmittedNodeRuntimeRecord | undefined;
  withAdmittedNodeRuntime(admission, () => {
    record = currentAdmittedNodeRuntimeRecord();
  });
  assert.ok(record !== undefined);
  assert.equal(record!.policyHash, ROOT_POLICY_HASH);
  assert.equal(record!.policyHash, canonicalHash(ROOT_POLICY));
});

test("admitted runtime record includes external bootstrap blockers honestly", () => {
  const admission = configuredRuntimeAdmission();
  let record: AdmittedNodeRuntimeRecord | undefined;
  withAdmittedNodeRuntime(admission, () => {
    record = currentAdmittedNodeRuntimeRecord();
  });
  assert.ok(record !== undefined);
  assert.equal(record!.externalBootstrapStatus, "not-started");
  assert.equal(record!.externalBootstrapBlockers.length, 4);
  const blockerTexts = record!.externalBootstrapBlockers.join("\n");
  assert.ok(blockerTexts.includes("bootstrap-installer-principal"));
  assert.ok(blockerTexts.includes("modeled-runtime-principal"));
  assert.ok(blockerTexts.includes("record-locator"));
  assert.ok(blockerTexts.includes("bootstrap-toolchain"));
});

test("admitted runtime admission class is configured-internal-pending-external-verification", () => {
  const admission = configuredRuntimeAdmission();
  let record: AdmittedNodeRuntimeRecord | undefined;
  withAdmittedNodeRuntime(admission, () => {
    record = currentAdmittedNodeRuntimeRecord();
  });
  assert.ok(record !== undefined);
  assert.equal(record!.admissionClass, "configured-internal-pending-external-verification");
});

test("admitted runtime executable identity hash is non-empty and hex", () => {
  const admission = configuredRuntimeAdmission();
  let record: AdmittedNodeRuntimeRecord | undefined;
  withAdmittedNodeRuntime(admission, () => {
    record = currentAdmittedNodeRuntimeRecord();
  });
  assert.ok(record !== undefined);
  assert.match(record!.executableIdentityHash, /^[0-9a-f]{64}$/u);
});

test("admitted runtime principal capabilities include durable-filesystem-mutation", () => {
  const admission = configuredRuntimeAdmission();
  assert.ok(admission.principal.capabilities.includes("durable-filesystem-mutation"));
});

test("admitted runtime principal capabilities include receipt-creation", () => {
  const admission = configuredRuntimeAdmission();
  assert.ok(admission.principal.capabilities.includes("receipt-creation"));
});

test("admitted runtime principal capabilities include evidence-publication", () => {
  const admission = configuredRuntimeAdmission();
  assert.ok(admission.principal.capabilities.includes("evidence-publication"));
});

test("concurrent admitted runtime activations in different async contexts are isolated", async () => {
  const admission = configuredRuntimeAdmission();
  const results: boolean[] = [];
  await Promise.all([
    withAdmittedNodeRuntime(admission, async () => {
      await Promise.resolve();
      results.push(hasAdmittedNodeRuntime());
    }),
    withAdmittedNodeRuntime(admission, async () => {
      await Promise.resolve();
      results.push(hasAdmittedNodeRuntime());
    }),
    withAdmittedNodeRuntime(admission, async () => {
      await Promise.resolve();
      results.push(hasAdmittedNodeRuntime());
    }),
  ]);
  assert.equal(results.length, 3);
  assert.deepEqual(results, [true, true, true]);
  assert.equal(hasAdmittedNodeRuntime(), false);
});

test("admitted runtime with multiple sequential operations x3", () => {
  const admission = configuredRuntimeAdmission();
  for (let rep = 0; rep < 3; rep += 1) {
    const root = temporaryRoot(`admitted-sequential-${rep}-`);
    withAdmittedNodeRuntime(admission, () => {
      withDurableDirectory({ absoluteRoot: root, relativeSegments: ["dir"], create: true }, (dir) => {
        createExclusiveDurableFile(dir, "file.bin", Buffer.from(`data-${rep}`));
      });
    });
    assert.equal(hasAdmittedNodeRuntime(), false, "runtime deactivated between iterations");
  }
});

test("admitted runtime allows nested durable directory operations", () => {
  const admission = configuredRuntimeAdmission();
  const root = temporaryRoot("admitted-nested-");
  withAdmittedNodeRuntime(admission, () => {
    withDurableDirectory({ absoluteRoot: root, relativeSegments: ["parent"], create: true }, (parent) => {
      createExclusiveDurableFile(parent, "outer.bin", Buffer.from("outer"));
      withDurableDirectory({ absoluteRoot: root, relativeSegments: ["parent", "child"], create: true }, (child) => {
        createExclusiveDurableFile(child, "inner.bin", Buffer.from("inner"));
        assert.ok(existsSync(join(root, "parent", "child", "inner.bin")));
      });
    });
  });
  assert.ok(existsSync(join(root, "parent", "outer.bin")));
});

test("admitted runtime handles duplicate file creation as existing not error", () => {
  const admission = configuredRuntimeAdmission();
  const root = temporaryRoot("admitted-dup-");
  withAdmittedNodeRuntime(admission, () => {
    withDurableDirectory({ absoluteRoot: root, relativeSegments: ["dir"], create: true }, (dir) => {
      createExclusiveDurableFile(dir, "file.bin", Buffer.from("first"));
      const second = createExclusiveDurableFile(dir, "file.bin", Buffer.from("second"));
      assert.equal(second.disposition, "existing");
      const read = readDurableFile(dir, "file.bin");
      assert.equal(read.disposition, "present");
      if (read.disposition === "present") {
        assert.equal(Buffer.from(read.bytes).toString(), "first", "original content preserved");
      }
    });
  });
  assert.equal(hasAdmittedNodeRuntime(), false);
});

test("admitted runtime does not set mechanism-test runtime state", () => {
  const admission = configuredRuntimeAdmission();
  withAdmittedNodeRuntime(admission, () => {
    assert.equal(hasAdmittedNodeRuntime(), true);
  });
});

test("root-policy hash includes the new configuredInternalAdmission section", () => {
  const tampered = { ...ROOT_POLICY } as Record<string, unknown>;
  const fsInfra = { ...tampered.filesystemInfrastructure as Record<string, unknown> };
  const launch = { ...fsInfra.runtimeLaunch as Record<string, unknown> };
  launch.currentProductionState = "runtime-not-admitted";
  fsInfra.runtimeLaunch = launch;
  tampered.filesystemInfrastructure = fsInfra;
  const tamperedHash = canonicalHash(tampered);
  assert.notEqual(tamperedHash, ROOT_POLICY_HASH, "changing currentProductionState must change hash");
});

test("root-policy hash changes when external bootstrap blockers are modified", () => {
  const tampered = { ...ROOT_POLICY } as Record<string, unknown>;
  const fsInfra = { ...tampered.filesystemInfrastructure as Record<string, unknown> };
  const launch = { ...fsInfra.runtimeLaunch as Record<string, unknown> };
  const config = { ...launch.configuredInternalAdmission as Record<string, unknown> };
  const bootstrap = { ...config.externalBootstrap as Record<string, unknown> };
  bootstrap.status = "started";
  config.externalBootstrap = bootstrap;
  launch.configuredInternalAdmission = config;
  fsInfra.runtimeLaunch = launch;
  tampered.filesystemInfrastructure = fsInfra;
  const tamperedHash = canonicalHash(tampered);
  assert.notEqual(tamperedHash, ROOT_POLICY_HASH);
});

test("root-policy hash changes when principal identity is modified", () => {
  const tampered = { ...ROOT_POLICY } as Record<string, unknown>;
  const fsInfra = { ...tampered.filesystemInfrastructure as Record<string, unknown> };
  const launch = { ...fsInfra.runtimeLaunch as Record<string, unknown> };
  const config = { ...launch.configuredInternalAdmission as Record<string, unknown> };
  const principal = { ...config.principal as Record<string, unknown> };
  principal.identity = "tampered-principal";
  config.principal = principal;
  launch.configuredInternalAdmission = config;
  fsInfra.runtimeLaunch = launch;
  tampered.filesystemInfrastructure = fsInfra;
  const tamperedHash = canonicalHash(tampered);
  assert.notEqual(tamperedHash, ROOT_POLICY_HASH);
});

test("root-policy hash changes when principal capabilities are modified", () => {
  const tampered = { ...ROOT_POLICY } as Record<string, unknown>;
  const fsInfra = { ...tampered.filesystemInfrastructure as Record<string, unknown> };
  const launch = { ...fsInfra.runtimeLaunch as Record<string, unknown> };
  const config = { ...launch.configuredInternalAdmission as Record<string, unknown> };
  const principal = { ...config.principal as Record<string, unknown> };
  principal.capabilities = [...(principal.capabilities as string[]), "extra-capability"];
  config.principal = principal;
  launch.configuredInternalAdmission = config;
  fsInfra.runtimeLaunch = launch;
  tampered.filesystemInfrastructure = fsInfra;
  const tamperedHash = canonicalHash(tampered);
  assert.notEqual(tamperedHash, ROOT_POLICY_HASH);
});

test("root-policy implementationStage reflects configured-internal admission", () => {
  assert.ok(
    ROOT_POLICY.filesystemInfrastructure.implementationStage.includes("configured-internal"),
    "implementationStage must include configured-internal",
  );
  assert.ok(
    !ROOT_POLICY.filesystemInfrastructure.implementationStage.includes("unavailable"),
    "implementationStage must not say unavailable",
  );
});

test("admitted runtime record admittedAt is a valid ISO timestamp", () => {
  const admission = configuredRuntimeAdmission();
  let record: AdmittedNodeRuntimeRecord | undefined;
  withAdmittedNodeRuntime(admission, () => {
    record = currentAdmittedNodeRuntimeRecord();
  });
  assert.ok(record !== undefined);
  assert.ok(!isNaN(Date.parse(record!.admittedAt)), "admittedAt must be a valid ISO timestamp");
});

test("admitted runtime record schemaVersion is stable", () => {
  const admission = configuredRuntimeAdmission();
  let record: AdmittedNodeRuntimeRecord | undefined;
  withAdmittedNodeRuntime(admission, () => {
    record = currentAdmittedNodeRuntimeRecord();
  });
  assert.ok(record !== undefined);
  assert.equal(record!.schemaVersion, "bridlewise-admitted-node-runtime-record/v1");
});

test("admitted runtime with deeply nested directory creation", () => {
  const admission = configuredRuntimeAdmission();
  const root = temporaryRoot("admitted-deep-");
  withAdmittedNodeRuntime(admission, () => {
    withDurableDirectory(
      { absoluteRoot: root, relativeSegments: ["a", "b", "c", "d"], create: true },
      (dir) => {
        createExclusiveDurableFile(dir, "deep.bin", Buffer.from("deep"));
        assert.ok(existsSync(join(root, "a", "b", "c", "d", "deep.bin")));
      },
    );
  });
});

test("admitted runtime record executable identity differs from mechanism-test executable", () => {
  const admission = configuredRuntimeAdmission();
  let admittedHash: string | undefined;
  withAdmittedNodeRuntime(admission, () => {
    admittedHash = admittedNodeRuntimeExecutable()?.identityHash;
  });
  withCurrentNodeRuntimeForFilesystemMechanismTest(() => {
    const exec = admittedNodeRuntimeExecutable();
    assert.equal(exec, undefined, "mechanism-test must not set admitted executable");
  });
  assert.ok(admittedHash !== undefined);
  assert.ok(admittedHash.length === 64);
});

test("admitted runtime does not leak across test boundaries", () => {
  const admission = configuredRuntimeAdmission();
  withAdmittedNodeRuntime(admission, () => {
    assert.equal(hasAdmittedNodeRuntime(), true);
  });
  assert.equal(hasAdmittedNodeRuntime(), false);
  assert.equal(currentAdmittedNodeRuntime(), undefined);
  assert.equal(currentAdmittedNodeRuntimeRecord(), undefined);
  assert.equal(admittedNodeRuntimePrincipal(), undefined);
  assert.equal(admittedNodeRuntimeExecutable(), undefined);
});

test("admitted runtime record is stable within a single activation", () => {
  const admission = configuredRuntimeAdmission();
  let record1: AdmittedNodeRuntimeRecord | undefined;
  let record2: AdmittedNodeRuntimeRecord | undefined;
  withAdmittedNodeRuntime(admission, () => {
    record1 = currentAdmittedNodeRuntimeRecord();
    record2 = currentAdmittedNodeRuntimeRecord();
  });
  assert.ok(record1 !== undefined && record2 !== undefined);
  assert.equal(record1, record2, "record must be the same object within activation");
});

test("admitted runtime principal is frozen and immutable", () => {
  const admission = configuredRuntimeAdmission();
  assert.ok(Object.isFrozen(admission.principal));
  assert.ok(Object.isFrozen(admission.principal.capabilities));
});

test("admitted runtime allows large file creation up to policy limits", () => {
  const admission = configuredRuntimeAdmission();
  const root = temporaryRoot("admitted-large-");
  withAdmittedNodeRuntime(admission, () => {
    withDurableDirectory({ absoluteRoot: root, relativeSegments: ["data"], create: true }, (dir) => {
      const data = Buffer.alloc(1024, 0x42);
      createExclusiveDurableFile(dir, "large.bin", data);
      const read = readDurableFile(dir, "large.bin");
      assert.equal(read.disposition, "present");
      if (read.disposition === "present") {
        assert.equal(read.bytes.length, 1024);
      }
    });
  });
});

test("multiple admitted runtime activations produce consistent principal bindings x3", () => {
  const admission = configuredRuntimeAdmission();
  const identities: string[] = [];
  for (let rep = 0; rep < 3; rep += 1) {
    withAdmittedNodeRuntime(admission, () => {
      identities.push(admittedNodeRuntimePrincipal()!.identity);
    });
  }
  assert.equal(identities.length, 3);
  assert.deepEqual(identities, [admission.principal.identity, admission.principal.identity, admission.principal.identity]);
});

test("admitted runtime is active during durable directory enumeration", () => {
  const admission = configuredRuntimeAdmission();
  const root = temporaryRoot("admitted-enumerate-");
  withAdmittedNodeRuntime(admission, () => {
    withDurableDirectory({ absoluteRoot: root, relativeSegments: ["data"], create: true }, (dir) => {
      createExclusiveDurableFile(dir, "x.bin", Buffer.from("x"));
      assert.equal(hasAdmittedNodeRuntime(), true, "runtime must be active during enumerate");
      const entries = enumerateDurableDirectory(dir);
      assert.equal(entries.length, 1);
    });
  });
});

test("admitted runtime is active during durable file read", () => {
  const admission = configuredRuntimeAdmission();
  const root = temporaryRoot("admitted-read-");
  withAdmittedNodeRuntime(admission, () => {
    withDurableDirectory({ absoluteRoot: root, relativeSegments: ["data"], create: true }, (dir) => {
      createExclusiveDurableFile(dir, "x.bin", Buffer.from("content"));
      assert.equal(hasAdmittedNodeRuntime(), true, "runtime must be active during read");
      const read = readDurableFile(dir, "x.bin");
      assert.equal(read.disposition, "present");
      if (read.disposition === "present") {
        assert.equal(Buffer.from(read.bytes).toString(), "content");
      }
    });
  });
});

test("durable file mutation requires admitted or mechanism-test runtime", () => {
  const root = temporaryRoot("mutation-runtime-");
  withDurableDirectory({ absoluteRoot: root, relativeSegments: [], create: true }, (dir) => {
    assert.throws(
      () => createExclusiveDurableFile(dir, "denied.bin", Buffer.from("x")),
      hasCode("filesystem_runtime_not_admitted"),
    );
  });
});

test("durable file mutation works under admitted runtime", () => {
  const admission = configuredRuntimeAdmission();
  const root = temporaryRoot("mutation-admitted-");
  withAdmittedDirectoryMutation(root, admission);
});

function withAdmittedDirectoryMutation(root: string, admission: ConfiguredRuntimeAdmission): void {
  withAdmittedNodeRuntime(admission, () => {
    withDurableDirectory({ absoluteRoot: root, relativeSegments: ["data"], create: true }, (dir) => {
      const result = createExclusiveDurableFile(dir, "ok.bin", Buffer.from("ok"));
      assert.equal(result.disposition, "created");
    });
  });
}
