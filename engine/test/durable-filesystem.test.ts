import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, lstatSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

import * as durableFilesystem from "../src/filesystem/durable-filesystem.ts";
import {
  createExclusiveDurableFile,
  enumerateDurableDirectory,
  readDurableFile,
  withDurableDirectory,
  withDurableDirectoryAsync,
  type DurableDirectory,
} from "../src/filesystem/durable-filesystem.ts";
import { withCurrentNodeRuntimeForFilesystemMechanismTest } from
  "../src/filesystem/durable-filesystem-internal.ts";
import { ROOT_POLICY } from "../src/kernel/root-policy.ts";
import {
  compilePinnedProcessProfile,
  runPinnedProcess,
  withPinnedProcessExecutable,
  type PinnedProcessBinding,
  type PinnedProcessExecutable,
  type PinnedProcessProfile,
} from "../src/process/pinned-process-internal.ts";
import { isProcessAlive } from "../src/process/process-facts.ts";
import {
  verifyArchitectureSources,
} from "../scripts/verification/architecture.ts";
import type { ArchitectureManifest, ArchitectureModule } from "../src/architecture-manifest.ts";
import { EMPTY_COMPOSITION_ROOTS } from "../src/architecture-manifest.ts";
import { createTempDir } from "./support/temp-dir.ts";

const TEMPORARY_PATHS = new Set<string>();

test.after(() => {
  for (const path of TEMPORARY_PATHS) rmSync(path, { recursive: true, force: true });
});

test("production directory creation has one runtime-not-admitted outcome and no effects x3", () => {
  for (let repetition = 0; repetition < 3; repetition += 1) {
    const root = temporaryRoot(`durable-filesystem-production-denial-${repetition}-`);
    const before = readdirSync(root);
    assert.throws(
      () => withDurableDirectory({ absoluteRoot: root, relativeSegments: ["state"], create: true }, () => {}),
      hasCode("filesystem_runtime_not_admitted"),
    );
    assert.deepEqual(readdirSync(root), before);
  }
});

test("mechanism-only worker creates exact private modes under hostile umasks x3", () => {
  const masks = [0o000, 0o777, 0o027] as const;
  for (const [repetition, mask] of masks.entries()) {
    const root = temporaryRoot(`durable-filesystem-mechanism-${repetition}-`);
    const previous = process.umask(mask);
    try {
      withCurrentNodeRuntimeForFilesystemMechanismTest(() => withDurableDirectory(
        { absoluteRoot: root, relativeSegments: ["state"], create: true },
        (directory) => {
          assert.equal(lstatSync(join(root, "state")).mode & 0o7777, 0o700);
          const created = createExclusiveDurableFile(directory, "value.bin", Buffer.from("complete"));
          assert.equal(created.disposition, "created");
          assert.equal(lstatSync(join(root, "state/value.bin")).mode & 0o7777, 0o600);
          const observed = readDurableFile(directory, "value.bin");
          assert.equal(observed.disposition, "present");
          assert.deepEqual(enumerateDurableDirectory(directory), [{ name: "value.bin", kind: "file" }]);
        },
      ));
    } finally {
      process.umask(previous);
    }
  }
});

test("file mutation requires explicit intent, a private terminal, and an active runtime x3", async () => {
  for (let repetition = 0; repetition < 3; repetition += 1) {
    const root = temporaryRoot(`durable-filesystem-mutation-authority-${repetition}-`);
    chmodSync(root, 0o755);
    const rootFixture = join(root, "readable.bin");
    writeFileSync(rootFixture, Buffer.from("read-only"), { mode: 0o600 });
    chmodSync(rootFixture, 0o600);

    withDurableDirectory({ absoluteRoot: root, relativeSegments: [], create: false }, (directory) => {
      assert.equal(readDurableFile(directory, "readable.bin").disposition, "present");
      assert.deepEqual(enumerateDurableDirectory(directory), [{ name: "readable.bin", kind: "file" }]);
      assert.throws(
        () => createExclusiveDurableFile(directory, "denied.bin", Buffer.from("x")),
        hasCode("filesystem_file_mutation_not_requested"),
      );
    });
    assert.equal(lstatSync(join(root, "denied.bin"), { throwIfNoEntry: false }), undefined);

    withCurrentNodeRuntimeForFilesystemMechanismTest(() => withDurableDirectory(
      { absoluteRoot: root, relativeSegments: [], create: true },
      (directory) => assert.throws(
        () => createExclusiveDurableFile(directory, "unsafe.bin", Buffer.from("x")),
        hasCode("filesystem_directory_unsafe"),
      ),
    ));
    assert.equal(lstatSync(join(root, "unsafe.bin"), { throwIfNoEntry: false }), undefined);

    chmodSync(root, 0o700);
    withCurrentNodeRuntimeForFilesystemMechanismTest(() => withDurableDirectory(
      { absoluteRoot: root, relativeSegments: ["state"], create: true },
      () => {},
    ));
    withDurableDirectory(
      { absoluteRoot: root, relativeSegments: ["state"], create: true },
      (directory) => assert.throws(
        () => createExclusiveDurableFile(directory, "no-runtime.bin", Buffer.from("x")),
        hasCode("filesystem_runtime_not_admitted"),
      ),
    );
    assert.equal(lstatSync(join(root, "state/no-runtime.bin"), { throwIfNoEntry: false }), undefined);

    withCurrentNodeRuntimeForFilesystemMechanismTest(() => withDurableDirectory(
      { absoluteRoot: root, relativeSegments: ["state"], create: false },
      (directory) => assert.throws(
        () => createExclusiveDurableFile(directory, "read-session.bin", Buffer.from("x")),
        hasCode("filesystem_file_mutation_not_requested"),
      ),
    ));
    assert.equal(lstatSync(join(root, "state/read-session.bin"), { throwIfNoEntry: false }), undefined);

    await assert.rejects(
      withDurableDirectoryAsync(
        { absoluteRoot: root, relativeSegments: ["state"], create: true },
        async (directory) => createExclusiveDurableFile(directory, "async-no-runtime.bin", Buffer.from("x")),
      ),
      hasCode("filesystem_runtime_not_admitted"),
    );
    assert.equal(lstatSync(join(root, "state/async-no-runtime.bin"), { throwIfNoEntry: false }), undefined);
  }
});

test("pinned process profile identity is compiled from every semantic field x3", () => {
  const input = {
    allowedSignals: [] as readonly NodeJS.Signals[],
    allowedStatuses: [0],
    bindingTargets: [] as const,
    environment: {},
    executableTargetDescriptor: 3,
    maximumErrorBytes: 1_024,
    maximumInputBytes: 1_024,
    maximumOutputBytes: 1_024,
    timeoutMilliseconds: 1_000,
    workingDirectory: "/",
  } as const;
  const variants = [
    { ...input, allowedSignals: ["SIGTERM"] as const },
    { ...input, allowedStatuses: [0, 1] },
    { ...input, bindingTargets: [{ id: "state", targetDescriptor: 4 }] as const },
    { ...input, environment: { LANG: "C" } },
    { ...input, executableTargetDescriptor: 4 },
    { ...input, maximumErrorBytes: 2_048 },
    { ...input, maximumInputBytes: 2_048 },
    { ...input, maximumOutputBytes: 2_048 },
    { ...input, timeoutMilliseconds: 2_000 },
    { ...input, workingDirectory: "/tmp" },
  ] as const;

  for (let repetition = 0; repetition < 3; repetition += 1) {
    const profile = compilePinnedProcessProfile(input);
    assert.equal(
      "pinnedNodeExecutablePath" in ROOT_POLICY.filesystemInfrastructure.privateState.directoryWorker,
      false,
    );
    assert.equal(profile.executablePath, "/proc/self/fd/3");
    assert.equal(profile.timeoutKillSignal, "SIGKILL");
    assert.throws(() => compilePinnedProcessProfile({ ...input, timeoutKillSignal: "SIGTERM" } as never), hasCode("pinned_process_profile_input_invalid"));
    assert.equal(Object.isFrozen(profile), true);
    assert.equal(Object.isFrozen(profile.allowedStatuses), true);
    for (const variant of variants) {
      assert.notEqual(compilePinnedProcessProfile(variant).profileIdentity, profile.profileIdentity);
    }

    const sameIdentityDifferentProfile = Object.freeze({
      ...profile,
      maximumOutputBytes: profile.maximumOutputBytes + 1,
    }) as PinnedProcessProfile;
    const forgedExecutable = Object.freeze({
      identityHash: "0".repeat(64),
      mechanismTestOnly: true,
    }) as PinnedProcessExecutable;
    assert.throws(
      () => runPinnedProcess(sameIdentityDifferentProfile, forgedExecutable, {}, [], Buffer.alloc(0)),
      hasCode("pinned_process_profile_identity_mismatch"),
    );
    assert.throws(
      () => compilePinnedProcessProfile({ ...input, profileIdentity: profile.profileIdentity } as never),
      hasCode("pinned_process_profile_input_invalid"),
    );

    withPinnedProcessExecutable(process.execPath, 268_435_456, true, (executable) => {
      const clonedExecutable = Object.freeze({ ...executable }) as PinnedProcessExecutable;
      assert.throws(
        () => runPinnedProcess(profile, clonedExecutable, {}, [], Buffer.alloc(0)),
        hasCode("pinned_process_executable_capability_invalid"),
      );
      const bindingProfile = compilePinnedProcessProfile({
        ...input,
        bindingTargets: [{ id: "state", targetDescriptor: 4 }],
      });
      const forgedBinding = Object.freeze({ identityHash: "0".repeat(64) }) as PinnedProcessBinding;
      assert.throws(
        () => runPinnedProcess(bindingProfile, executable, { state: forgedBinding }, [], Buffer.alloc(0)),
        hasCode("pinned_process_binding_capability_invalid"),
      );
    });
  }
});

test("public namespace and opaque capability reject raw-descriptor forgery and retention x3", () => {
  assert.deepEqual(Object.keys(durableFilesystem).toSorted(), [
    "createExclusiveDurableFile",
    "enumerateDurableDirectory",
    "readDurableFile",
    "withDurableDirectory",
    "withDurableDirectoryAsync",
  ]);
  assert.equal(Object.keys(durableFilesystem).some((name) => /descriptor|internal|runtime/iu.test(name)), false);

  for (let repetition = 0; repetition < 3; repetition += 1) {
    const root = temporaryRoot(`durable-filesystem-opaque-${repetition}-`);
    const forged = Object.freeze({
      identity: Object.freeze({ device: "0", inode: "0", mode: "0700", ownerUid: "0", ownerGid: "0" }),
      lexicalPath: root,
      descriptor: 3,
    }) as unknown as DurableDirectory;
    assert.throws(() => enumerateDurableDirectory(forged), hasCode("filesystem_directory_capability_invalid"));
    assert.throws(() => readDurableFile(forged, "value.bin"), hasCode("filesystem_directory_capability_invalid"));
    assert.throws(
      () => withCurrentNodeRuntimeForFilesystemMechanismTest(() =>
        createExclusiveDurableFile(forged, "value.bin", Buffer.from("x"))),
      hasCode("filesystem_directory_capability_invalid"),
    );

    let retained: DurableDirectory | undefined;
    withDurableDirectory({ absoluteRoot: root, relativeSegments: [], create: false }, (directory) => {
      retained = directory;
      assert.deepEqual(Object.keys(directory).toSorted(), ["identity", "lexicalPath"]);
    });
    assert.ok(retained);
    assert.throws(() => enumerateDurableDirectory(retained!), hasCode("filesystem_directory_capability_invalid"));
  }
});

test("async scope remains usable while pending and revokes after resolve or reject x3", async () => {
  for (let repetition = 0; repetition < 3; repetition += 1) {
    const root = temporaryRoot(`durable-filesystem-async-${repetition}-`);
    let retained: DurableDirectory | undefined;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    const pending = withCurrentNodeRuntimeForFilesystemMechanismTest(() => withDurableDirectoryAsync(
      { absoluteRoot: root, relativeSegments: ["state"], create: true },
      async (directory) => {
        retained = directory;
        await Promise.resolve();
        assert.deepEqual(enumerateDurableDirectory(directory), []);
        await gate;
        return repetition;
      },
    ));
    await Promise.resolve();
    assert.ok(retained);
    assert.deepEqual(enumerateDurableDirectory(retained!), []);
    release!();
    assert.equal(await pending, repetition);
    assert.throws(() => enumerateDurableDirectory(retained!), hasCode("filesystem_directory_capability_invalid"));

    let rejected: DurableDirectory | undefined;
    const marker = new Error(`reject-${repetition}`);
    await assert.rejects(
      withCurrentNodeRuntimeForFilesystemMechanismTest(() => withDurableDirectoryAsync(
        { absoluteRoot: root, relativeSegments: ["state"], create: false },
        async (directory) => {
          rejected = directory;
          await Promise.resolve();
          throw marker;
        },
      )),
      (error) => error === marker,
    );
    assert.ok(rejected);
    assert.throws(() => enumerateDurableDirectory(rejected!), hasCode("filesystem_directory_capability_invalid"));
  }
});

test("sync API denies native custom and cross-realm PromiseLike results and always revokes x3", () => {
  const results: readonly (() => unknown)[] = [
    () => Promise.resolve("native"),
    () => ({ then(resolve: (value: string) => void) { resolve("custom"); } }),
    () => runInNewContext("Promise.resolve('cross-realm')") as PromiseLike<string>,
  ];
  for (const [repetition, result] of results.entries()) {
    const root = temporaryRoot(`durable-filesystem-thenable-${repetition}-`);
    let retained: DurableDirectory | undefined;
    assert.throws(
      () => withDurableDirectory(
        { absoluteRoot: root, relativeSegments: [], create: false },
        ((directory: DurableDirectory) => {
          retained = directory;
          return result();
        }) as (directory: DurableDirectory) => never,
      ),
      hasCode("filesystem_async_callback_requires_async_api"),
    );
    assert.ok(retained);
    assert.throws(() => enumerateDurableDirectory(retained!), hasCode("filesystem_directory_capability_invalid"));
  }
});

test("sync misuse observes a post-await revoked-capability rejection without process failure x3", async () => {
  for (let repetition = 0; repetition < 3; repetition += 1) {
    const root = temporaryRoot(`durable-filesystem-sync-misuse-${repetition}-`);
    let resumed = false;
    assert.throws(
      () => withDurableDirectory(
        { absoluteRoot: root, relativeSegments: [], create: false },
        (async (directory: DurableDirectory) => {
          await Promise.resolve();
          resumed = true;
          enumerateDurableDirectory(directory);
        }) as unknown as (directory: DurableDirectory) => never,
      ),
      hasCode("filesystem_async_callback_requires_async_api"),
    );
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    assert.equal(resumed, true);
  }
});

test("callback throws and throwing then accessors close exactly once x3", () => {
  for (let repetition = 0; repetition < 3; repetition += 1) {
    const root = temporaryRoot(`durable-filesystem-callback-throw-${repetition}-`);
    let retained: DurableDirectory | undefined;
    const marker = new Error(`callback-${repetition}`);
    assert.throws(() => withDurableDirectory(
      { absoluteRoot: root, relativeSegments: [], create: false },
      (directory) => {
        retained = directory;
        if (repetition === 0) throw marker;
        return Object.defineProperty({}, "then", { get() { throw marker; } }) as never;
      },
    ), (error) => error === marker);
    assert.ok(retained);
    assert.throws(() => enumerateDurableDirectory(retained!), hasCode("filesystem_directory_capability_invalid"));
  }
});

test("private worker refuses direct standalone execution x3", () => {
  const worker = join(process.cwd(), ROOT_POLICY.filesystemInfrastructure.privateState.directoryWorker.sourcePath);
  for (let repetition = 0; repetition < 3; repetition += 1) {
    const child = spawnSync(process.execPath, [worker], { encoding: "utf8", env: {} });
    assert.equal(child.status, 64);
    assert.equal(child.stdout, "");
    assert.equal(child.stderr, "private_directory_worker_standalone_denied\n");
  }
});

test("architecture denies generated internal and mechanism-test imports while allowing the facade bridge x3", () => {
  const target = "src/filesystem/durable-filesystem-internal.ts";
  for (let repetition = 0; repetition < 3; repetition += 1) {
    const attacker = `src/generated-${repetition}.ts`;
    const denied = architectureFixture(attacker,
      `import { withDurableDirectoryInternal } from "./filesystem/durable-filesystem-internal.ts";\n`);
    assert.ok(denied.includes(`architecture-filesystem-internal-import-denied:${attacker}`));

    const mechanism = architectureFixture("src/filesystem/immutable-receipt.ts",
      `import { withCurrentNodeRuntimeForFilesystemMechanismTest } from ${JSON.stringify(target)};\n`);
    assert.ok(mechanism.includes(
      "architecture-filesystem-mechanism-test-import-denied:src/filesystem/immutable-receipt.ts",
    ));

    const allowed = architectureFixture("src/filesystem/durable-filesystem.ts",
      `import { withDurableDirectoryInternal } from "./durable-filesystem-internal.ts";\n`);
    assert.equal(allowed.some((violation) => violation.includes("filesystem-internal-import-denied") ||
      violation.includes("filesystem-mechanism-test-import-denied")), false);

    const processAttacker = `src/process/generated-${repetition}.ts`;
    const processDenied = architectureFixture(
      processAttacker,
      `import { runPinnedProcess } from "./pinned-process-internal.ts";\n`,
    );
    assert.ok(processDenied.includes(`architecture-pinned-process-internal-import-denied:${processAttacker}`));
  }
});

function temporaryRoot(prefix: string): string {
  const path = createTempDir(prefix);
  TEMPORARY_PATHS.add(path);
  return path;
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error !== null && typeof error === "object" && "code" in error && error.code === code;
}

function architectureFixture(path: string, source: string): readonly string[] {
  const module: ArchitectureModule = {
    id: `fixture-${path}`,
    path,
    realm: path.startsWith("src/") ? "shared" : "builder",
    layer: path.startsWith("src/") ? "infrastructure" : "verification",
    owner: "fixture",
    executionBoundary: "pure",
    compositionRoot: false,
    allowedDependencyLayers: [
      "trusted-kernel", "domain", "ports", "application", "infrastructure", "interface", "verification",
    ],
    ports: { requires: [], provides: [] },
    effects: [],
    configPaths: [],
    stateOwners: [],
    projectionOwners: [],
    authorityFamilies: [],
    authorityIdentifiers: [],
    responsibilities: [`fixture-${path}`],
  };
  const manifest: ArchitectureManifest = {
    schemaVersion: "bridlewise-architecture-manifest/v4",
    sourceRoots: ["scripts/", "src/", "verification/"],
    graphPolicy: "derived-edges-no-cycles",
    publicApiPolicy: "derived-from-source-never-committed",
    analysisLimits: { maximumSourceBytes: 1_048_576, maximumAstNodes: 100_000 },
    responsibilityPolicy: "one-registered-cohesive-owner-per-responsibility",
    physicalLayoutStatus: "open-blocking-architecture-v1-migration-required",
    compositionRoots: EMPTY_COMPOSITION_ROOTS,
    externalCommands: [],
    modules: [module],
    findings: [],
  };
  return verifyArchitectureSources([{ path, source }], manifest).violations;
}


test("pinned process hard timeout joins a child that ignores SIGTERM and distinguishes output limits", () => {
  const root = temporaryRoot("pinned-process-timeout-");
  const ready = join(root, "ready.json");
  const fallback = join(root, "fallback"), ignoredTerm = join(root, "ignored-term");
  const childScript = `const fs=require("node:fs"); process.on("SIGTERM", () => fs.writeFileSync(${JSON.stringify(ignoredTerm)}, "ignored")); fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({pid:process.pid,ready:true})); setTimeout(() => { fs.writeFileSync(${JSON.stringify(fallback)}, "fallback-reached"); process.exit(42); }, 3000);`;
  const module = new URL("../src/process/pinned-process-internal.ts", import.meta.url).href;
  const program = `import {compilePinnedProcessProfile,runPinnedProcess,withPinnedProcessExecutable} from ${JSON.stringify(module)};
    const profile=compilePinnedProcessProfile({allowedSignals:[],allowedStatuses:[0],bindingTargets:[],environment:{},executableTargetDescriptor:3,maximumErrorBytes:1024,maximumInputBytes:1024,maximumOutputBytes:1024,timeoutMilliseconds:1000,workingDirectory:${JSON.stringify(root)}});
    withPinnedProcessExecutable(process.execPath,268435456,true, executable => {
      try { runPinnedProcess(profile,executable,{},["-e",${JSON.stringify(childScript)}],Buffer.alloc(0)); }
      catch(error) { process.stdout.write(JSON.stringify({code:error.code})); }
    });`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
    encoding: "utf8", timeout: 6000, killSignal: "SIGKILL", env: {},
  });
  assert.equal(result.error, undefined); assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), { code: "pinned_process_timed_out" });
  const handshake = JSON.parse(readFileSync(ready, "utf8")); assert.equal(handshake.ready, true);
  assert.equal(lstatSync(fallback, { throwIfNoEntry: false }), undefined, "hard timeout must precede finite fallback");
  assert.equal(lstatSync(ignoredTerm, { throwIfNoEntry: false }), undefined, "hard timeout must not deliver catchable SIGTERM");
  assert.equal(isProcessAlive(handshake.pid), false, "the timed-out process must be gone");
  withPinnedProcessExecutable(process.execPath, 268435456, true, (executable) => {
    const profile = compilePinnedProcessProfile({ allowedSignals: [], allowedStatuses: [0], bindingTargets: [], environment: {},
      executableTargetDescriptor: 3, maximumErrorBytes: 1024, maximumInputBytes: 1024, maximumOutputBytes: 1024,
      timeoutMilliseconds: 1000, workingDirectory: root });
    assert.throws(() => runPinnedProcess(profile, executable, {}, ["-e", 'process.stdout.write("x".repeat(100000))'], Buffer.alloc(0)), hasCode("pinned_process_output_too_large"));
    const { executablePath: _path, profileIdentity: _identity, timeoutKillSignal: _signal, ...input } = profile;
    const missingDirectory = compilePinnedProcessProfile({ ...input, workingDirectory: join(root, "missing") });
    assert.throws(() => runPinnedProcess(missingDirectory, executable, {}, [], Buffer.alloc(0)), hasCode("pinned_process_launch_failed"));
  });
});
