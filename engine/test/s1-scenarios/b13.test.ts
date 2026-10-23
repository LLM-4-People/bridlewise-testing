import assert from "node:assert/strict";
import { linkSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { verifyS1Structure } from "../../scripts/tooling/s1-verification.ts";
import { analyzeArchitectureSource, verifyArchitectureSources } from "../../scripts/verification/architecture.ts";
import { ARCHITECTURE_MANIFEST, EMPTY_COMPOSITION_ROOTS, type ArchitectureManifest } from "../../src/architecture-manifest.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { ARCHITECTURE_SOURCE_EXTENSIONS } from "../../src/shared/source-extensions.ts";
import { makeRuntimeCandidate, createOwnedTemporaryDirectory, removeOwnedTemporaryDirectories, historicalApplicationName, appendCandidateSource, mountedRootBoundaryEvidence, repositoryArchitectureSources, REPOSITORY_ROOT, candidateModulePath, assertArchitectureBaselineClean } from "../support/s1-scenario-shared.ts";

const scenarios: Readonly<Record<string, () => void | Promise<void>>> = {
  "S1-B13-CONTROL": assertArchitectureBaselineClean,
  "S1-B13-FAILURE": () => {
    const cycleRoot = makeRuntimeCandidate();
    const kernelErrors = candidateModulePath("kernel/errors.ts");
    // The cycle mutant imports cli.ts from the kernel folder, so the specifier
    // must reach `src/cli.ts` from `src/kernel/` — "../cli.ts".
    appendCandidateSource(cycleRoot, kernelErrors, [
      'import { runCli } from "../cli.ts";',
      "void runCli;",
    ].join("\n"));
    const cycle = verifyS1Structure(cycleRoot).violations;
    assert.ok(cycle.some((entry) => entry.startsWith("architecture-import-cycle:")), JSON.stringify(cycle));

    const reverseRoot = makeRuntimeCandidate();
    // root-policy.ts lives at src/kernel/ post-fold, so reaching src/cli.ts
    // from it is "../cli.ts". The reverse-layer diagnostic still names the
    // target by its canonical src/-relative path.
    appendCandidateSource(reverseRoot, ROOT_POLICY.sourcePath, [
      'import { runCli } from "../cli.ts";',
      "void runCli;",
    ].join("\n"));
    const reverse = verifyS1Structure(reverseRoot).violations;
    assert.ok(reverse.includes(`architecture-reverse-layer:${ROOT_POLICY.sourcePath}->src/cli.ts`));

    const adapterRoot = makeRuntimeCandidate();
    const kernelContracts = candidateModulePath("kernel/contracts.ts");
    appendCandidateSource(adapterRoot, kernelContracts, [
      "class SqliteAdapter {}",
      "const misplacedAdapter = new SqliteAdapter();",
      "void misplacedAdapter;",
    ].join("\n"));
    assert.ok(verifyS1Structure(adapterRoot).violations.includes(
      `architecture-adapter-construction:${kernelContracts}`,
    ));

    const effectRoot = makeRuntimeCandidate();
    appendCandidateSource(effectRoot, kernelContracts, [
      'import { readFileSync as directArchitectureRead } from "node:fs";',
      "void directArchitectureRead;",
    ].join("\n"));
    const effect = verifyS1Structure(effectRoot).violations;
    assert.ok(effect.includes(`architecture-effect-owner:${kernelContracts}:node:fs:filesystem-read`));

    const existingFilesystemDependencyRoot = makeRuntimeCandidate();
    const kernelConfig = candidateModulePath("kernel/config.ts");
    appendCandidateSource(existingFilesystemDependencyRoot, kernelConfig, [
      'import { writeFileSync as architectureWriteMutant } from "node:fs";',
      'void architectureWriteMutant("architecture-mutant", "must-not-execute");',
    ].join("\n"));
    const existingFilesystemDependency = verifyS1Structure(existingFilesystemDependencyRoot).violations;
    // The appended write merges with config.ts's pre-existing filesystem-read,
    // so the owner effect-set is read+write. The invariant: the appended write
    // IS detected and attributed to the module (not dropped, not misattributed).
    assert.ok(existingFilesystemDependency.includes(
      `architecture-effect-owner:${kernelConfig}:node:fs:filesystem-read,filesystem-write`,
    ));
    assert.ok(existingFilesystemDependency.includes(
      `architecture-effect-boundary:${kernelConfig}:pure:filesystem-read,filesystem-write`,
    ));

    const builtinFilesystemRoot = makeRuntimeCandidate();
    appendCandidateSource(builtinFilesystemRoot, kernelConfig, [
      'process.getBuiltinModule("node:fs").writeFileSync("architecture-mutant", "must-not-execute");',
    ].join("\n"));
    const builtinFilesystem = verifyS1Structure(builtinFilesystemRoot).violations;
    assert.ok(builtinFilesystem.includes(
      `architecture-effect-owner:${kernelConfig}:node:fs:filesystem-read,filesystem-write`,
    ));
    assert.ok(builtinFilesystem.includes(
      `architecture-effect-boundary:${kernelConfig}:pure:filesystem-read,filesystem-write`,
    ));

    const extensionSources = new Map([
      [".cjs", "export const registeredExtension = true;"],
      [".cts", "export const registeredExtension: boolean = true;"],
      [".js", "export const registeredExtension = true;"],
      [".jsx", "export const registeredExtension = <Widget value={1} />;"],
      [".mjs", "export const registeredExtension = true;"],
      [".mts", "export const registeredExtension: boolean = true;"],
      [".ts", "export const registeredExtension: boolean = true;"],
      [".tsx", "export const registeredExtension = <Widget value={1} />;"],
    ] as const);
    assert.deepEqual([...extensionSources.keys()], [...ARCHITECTURE_SOURCE_EXTENSIONS]);
    for (const [extension, source] of extensionSources) {
      const facts = analyzeArchitectureSource(`verification/architecture-extension${extension}`, source);
      assert.deepEqual(facts.exportedNames, ["registeredExtension"]);
      const unregistered = verifyArchitectureSources([
        ...repositoryArchitectureSources(),
        { path: `verification/unregistered-extension${extension}`, source },
      ]).violations;
      assert.ok(unregistered.includes("architecture-module-registration-drift"));
    }

    for (const extension of [".jsx", ".tsx"] as const) {
      const path = `verification/registered-extension${extension}`;
      const source = 'export const registeredExtension = <Widget value={1} />;';
      const template = ARCHITECTURE_MANIFEST.modules.find((module) => module.path === kernelErrors)!;
      const fixtureManifest: ArchitectureManifest = {
        ...ARCHITECTURE_MANIFEST,
        compositionRoots: EMPTY_COMPOSITION_ROOTS,
        modules: [{
          ...template,
          id: `registered-extension-${extension.slice(1)}`,
          path,
        }],
      };
      const registered = verifyArchitectureSources([{ path, source }], fixtureManifest).violations;
      assert.equal(registered.includes(`architecture-source-parse:${path}`), false);
      assert.equal(registered.includes(`architecture-independent-export-disagreement:${path}`), false);
      assert.equal(registered.includes(`architecture-independent-import-disagreement:${path}`), false);
    }

    const unregisteredCoreRoot = makeRuntimeCandidate();
    writeFileSync(
      join(unregisteredCoreRoot, "src", "unregistered-core.ts"),
      "export const unregisteredCore = true;\n",
    );
    assert.ok(verifyS1Structure(unregisteredCoreRoot).violations.includes(
      "architecture-module-registration-drift",
    ));

    const unregisteredVerificationRoot = makeRuntimeCandidate();
    const unregisteredVerificationDirectory = join(
      unregisteredVerificationRoot,
      "verification",
      "benchmarks",
      "architecture-mutant",
    );
    mkdirSync(unregisteredVerificationDirectory, { recursive: true });
    writeFileSync(
      join(unregisteredVerificationDirectory, "unregistered-verifier.ts"),
      "export const unregisteredVerifier = true;\n",
    );
    assert.ok(verifyS1Structure(unregisteredVerificationRoot).violations.includes(
      "architecture-module-registration-drift",
    ));

    const unregisteredMjsRoot = makeRuntimeCandidate();
    const unregisteredMjsDirectory = join(
      unregisteredMjsRoot,
      "verification",
      "benchmarks",
      "architecture-mutant",
    );
    mkdirSync(unregisteredMjsDirectory, { recursive: true });
    writeFileSync(
      join(unregisteredMjsDirectory, "unregistered-runner.mjs"),
      "export const unregisteredRunner = true;\n",
    );
    assert.ok(verifyS1Structure(unregisteredMjsRoot).violations.includes(
      "architecture-module-registration-drift",
    ));

    const externalArchitectureRoot = createOwnedTemporaryDirectory("architecture-external-");
    const rootNameCanary = "ROOT_DIRECTORY_NAME_CANARY_must_not_escape";
    writeFileSync(join(externalArchitectureRoot, rootNameCanary), "external\n");
    const rootSymlinkParent = createOwnedTemporaryDirectory("root-symlink-parent-");
    const linkedRepositoryRoot = join(rootSymlinkParent, "candidate");
    symlinkSync(externalArchitectureRoot, linkedRepositoryRoot, "dir");
    const staleAtime = new Date("2000-01-01T00:00:00.000Z");
    utimesSync(externalArchitectureRoot, staleAtime, new Date());
    for (let replay = 0; replay < 3; replay += 1) {
      const externalRootAtime = lstatSync(externalArchitectureRoot, { bigint: true }).atimeNs;
      const linkedRootVerification = verifyS1Structure(linkedRepositoryRoot);
      assert.deepEqual(linkedRootVerification.violations, ["repository-root-boundary:safe_path_root_symlink"]);
      assert.equal(JSON.stringify(linkedRootVerification).includes(rootNameCanary), false);
      assert.equal(lstatSync(externalArchitectureRoot, { bigint: true }).atimeNs, externalRootAtime);
    }

    const externalAncestorParent = createOwnedTemporaryDirectory("root-ancestor-external-");
    const externalAncestorRepository = join(externalAncestorParent, "repo");
    mkdirSync(externalAncestorRepository);
    const ancestorNameCanary = "ROOT_ANCESTOR_NAME_CANARY_must_not_escape";
    const ancestorCanaryPath = join(externalAncestorRepository, ancestorNameCanary);
    writeFileSync(ancestorCanaryPath, "external ancestor content must not be read\n");
    const symlinkAncestorContainer = createOwnedTemporaryDirectory("root-ancestor-container-");
    const symlinkAncestorPath = join(symlinkAncestorContainer, "link");
    symlinkSync(externalAncestorParent, symlinkAncestorPath, "dir");
    const symlinkAncestorRepository = join(symlinkAncestorPath, "repo");
    utimesSync(ancestorCanaryPath, staleAtime, new Date());
    utimesSync(externalAncestorRepository, staleAtime, new Date());
    utimesSync(externalAncestorParent, staleAtime, new Date());
    for (let replay = 0; replay < 3; replay += 1) {
      const before = {
        parent: lstatSync(externalAncestorParent, { bigint: true }).atimeNs,
        repository: lstatSync(externalAncestorRepository, { bigint: true }).atimeNs,
        canary: lstatSync(ancestorCanaryPath, { bigint: true }).atimeNs,
      };
      const ancestorVerification = verifyS1Structure(symlinkAncestorRepository);
      assert.deepEqual(ancestorVerification.violations, ["repository-root-boundary:safe_path_ancestor_symlink"]);
      assert.equal(JSON.stringify(ancestorVerification).includes(ancestorNameCanary), false);
      assert.deepEqual({
        parent: lstatSync(externalAncestorParent, { bigint: true }).atimeNs,
        repository: lstatSync(externalAncestorRepository, { bigint: true }).atimeNs,
        canary: lstatSync(ancestorCanaryPath, { bigint: true }).atimeNs,
      }, before);
    }

    const rootCanaryPath = join(externalArchitectureRoot, rootNameCanary);
    utimesSync(rootCanaryPath, staleAtime, new Date());
    utimesSync(externalArchitectureRoot, staleAtime, new Date());
    const mountParent = createOwnedTemporaryDirectory("root-mount-parent-");
    const mountedRepositoryRoot = join(mountParent, "candidate");
    mkdirSync(mountedRepositoryRoot);
    const mountedRootAtime = lstatSync(externalArchitectureRoot, { bigint: true }).atimeNs.toString();
    const mountedCanaryAtime = lstatSync(rootCanaryPath, { bigint: true }).atimeNs.toString();
    const rootMountEvidence = mountedRootBoundaryEvidence(
      externalArchitectureRoot,
      mountedRepositoryRoot,
      mountedRepositoryRoot,
      { root: externalArchitectureRoot, canary: rootCanaryPath },
    );
    assert.equal(rootMountEvidence.results.length, 3);
    for (const result of rootMountEvidence.results) {
      assert.deepEqual(result.violations, ["repository-root-boundary:safe_path_root_mountpoint"]);
    }
    assert.equal(JSON.stringify(rootMountEvidence).includes(rootNameCanary), false);
    assert.deepEqual(rootMountEvidence.before, {
      root: mountedRootAtime,
      canary: mountedCanaryAtime,
    });
    assert.deepEqual(rootMountEvidence.after, rootMountEvidence.before);

    utimesSync(ancestorCanaryPath, staleAtime, new Date());
    utimesSync(externalAncestorRepository, staleAtime, new Date());
    utimesSync(externalAncestorParent, staleAtime, new Date());
    const mountAncestorContainer = createOwnedTemporaryDirectory("root-mount-ancestor-");
    const mountAncestorTarget = join(mountAncestorContainer, "mounted-parent");
    mkdirSync(mountAncestorTarget);
    const mountedAncestorRepository = join(mountAncestorTarget, "repo");
    const mountAncestorBefore = {
      parent: lstatSync(externalAncestorParent, { bigint: true }).atimeNs.toString(),
      repository: lstatSync(externalAncestorRepository, { bigint: true }).atimeNs.toString(),
      canary: lstatSync(ancestorCanaryPath, { bigint: true }).atimeNs.toString(),
    };
    const mountAncestorEvidence = mountedRootBoundaryEvidence(
      externalAncestorParent,
      mountAncestorTarget,
      mountedAncestorRepository,
      {
        parent: externalAncestorParent,
        repository: externalAncestorRepository,
        canary: ancestorCanaryPath,
      },
    );
    assert.equal(mountAncestorEvidence.results.length, 3);
    for (const result of mountAncestorEvidence.results) {
      assert.deepEqual(result.violations, ["repository-root-boundary:safe_path_root_ancestor_mountpoint"]);
    }
    assert.equal(JSON.stringify(mountAncestorEvidence).includes(ancestorNameCanary), false);
    assert.deepEqual(mountAncestorEvidence.before, mountAncestorBefore);
    assert.deepEqual(mountAncestorEvidence.after, mountAncestorEvidence.before);

    const externalArchitectureSource = join(externalArchitectureRoot, "external.ts");
    writeFileSync(externalArchitectureSource, "this is deliberately invalid TypeScript {{{\n");
    utimesSync(externalArchitectureSource, staleAtime, new Date());
    const linkedArchitectureRoot = makeRuntimeCandidate();
    const linkedArchitecturePath = "verification/linked-external.ts";
    symlinkSync(externalArchitectureSource, join(linkedArchitectureRoot, linkedArchitecturePath));
    const linkedArchitectureAtime = lstatSync(externalArchitectureSource, { bigint: true }).atimeNs;
    const linkedArchitectureViolations = verifyS1Structure(linkedArchitectureRoot).violations;
    assert.ok(linkedArchitectureViolations.includes(`repository-symlink:${linkedArchitecturePath}`));
    assert.equal(linkedArchitectureViolations.includes(`architecture-source-unreadable:${linkedArchitecturePath}`), false);
    assert.equal(linkedArchitectureViolations.includes(`architecture-source-parse:${linkedArchitecturePath}`), false);
    assert.equal(lstatSync(externalArchitectureSource, { bigint: true }).atimeNs, linkedArchitectureAtime);

    const hardlinkedArchitectureRoot = makeRuntimeCandidate();
    const hardlinkedArchitecturePath = "verification/hardlinked-external.ts";
    linkSync(externalArchitectureSource, join(hardlinkedArchitectureRoot, hardlinkedArchitecturePath));
    const hardlinkedArchitectureAtime = lstatSync(externalArchitectureSource, { bigint: true }).atimeNs;
    const hardlinkedArchitectureViolations = verifyS1Structure(hardlinkedArchitectureRoot).violations;
    assert.ok(hardlinkedArchitectureViolations.includes(`repository-hardlink:${hardlinkedArchitecturePath}`));
    assert.equal(hardlinkedArchitectureViolations.some((violation) =>
      violation.startsWith(`architecture-source-`)), false);
    assert.equal(lstatSync(externalArchitectureSource, { bigint: true }).atimeNs, hardlinkedArchitectureAtime);

    const externalPackagePath = join(externalArchitectureRoot, "package.json");
    writeFileSync(externalPackagePath, readFileSync(join(REPOSITORY_ROOT, "package.json")));
    utimesSync(externalPackagePath, staleAtime, new Date());
    const linkedPackageRoot = makeRuntimeCandidate();
    rmSync(join(linkedPackageRoot, "package.json"));
    symlinkSync(externalPackagePath, join(linkedPackageRoot, "package.json"));
    const linkedPackageAtime = lstatSync(externalPackagePath, { bigint: true }).atimeNs;
    assert.ok(verifyS1Structure(linkedPackageRoot).violations.includes("repository-symlink:package.json"));
    assert.equal(lstatSync(externalPackagePath, { bigint: true }).atimeNs, linkedPackageAtime);

    const hardlinkedPackageRoot = makeRuntimeCandidate();
    rmSync(join(hardlinkedPackageRoot, "package.json"));
    linkSync(externalPackagePath, join(hardlinkedPackageRoot, "package.json"));
    const hardlinkedPackageAtime = lstatSync(externalPackagePath, { bigint: true }).atimeNs;
    assert.ok(verifyS1Structure(hardlinkedPackageRoot).violations.includes("repository-hardlink:package.json"));
    assert.equal(lstatSync(externalPackagePath, { bigint: true }).atimeNs, hardlinkedPackageAtime);
  },
  "S1-B13-HOSTILE-REAL": () => {
    const contractsPath = candidateModulePath("kernel/contracts.ts");
    const dataPolicyPath = candidateModulePath("privacy/data-policy.ts");
    const authorityVariants = [
      [contractsPath, "class ShadowHarnessError extends Error {}", `architecture-local-errors-authority:${contractsPath}:ShadowHarnessError`],
      [dataPolicyPath, "const localConfigAuthority = Object.freeze({});", `architecture-local-configuration-authority:${dataPolicyPath}:localConfigAuthority`],
      [dataPolicyPath, "const localEventRegistry = Object.freeze({});", `architecture-local-events-authority:${dataPolicyPath}:localEventRegistry`],
    ] as const;
    for (const [path, source, diagnostic] of authorityVariants) {
      const root = makeRuntimeCandidate();
      appendCandidateSource(root, path, source);
      assert.ok(verifyS1Structure(root).violations.includes(diagnostic));
    }

    // A module's public API is derived from its source, never committed
    // (#221): a new export is no architecture violation of its own.
    const ofDataPolicy = (violations: readonly string[]): readonly string[] =>
      violations.filter((violation) => violation.startsWith("architecture-") && violation.includes(dataPolicyPath));
    const exportRoot = makeRuntimeCandidate();
    appendCandidateSource(exportRoot, dataPolicyPath, "export const unregisteredSurface = true;");
    assert.deepEqual(ofDataPolicy(verifyS1Structure(exportRoot).violations), ofDataPolicy(verifyS1Structure(makeRuntimeCandidate()).violations));

    const sqliteRoot = makeRuntimeCandidate();
    appendCandidateSource(sqliteRoot, contractsPath, [
      'import { DatabaseSync as HiddenDatabase } from "node:sqlite";',
      "void HiddenDatabase;",
    ].join("\n"));
    const sqlite = verifyS1Structure(sqliteRoot).violations;
    assert.ok(sqlite.includes(
      `architecture-effect-owner:${contractsPath}:node:sqlite:filesystem-read,filesystem-write`,
    ));
    assert.ok(sqlite.includes(
      `architecture-effect-boundary:${contractsPath}:pure:filesystem-read,filesystem-write`,
    ));

    const directEffectsRoot = makeRuntimeCandidate();
    appendCandidateSource(directEffectsRoot, contractsPath, [
      'import { spawnSync as directGit } from "node:child_process";',
      'import { readFileSync as directFilesystemRead } from "node:fs";',
      'void directGit("git", ["status"]);',
      "void directFilesystemRead;",
    ].join("\n"));
    const directEffects = verifyS1Structure(directEffectsRoot).violations;
    assert.ok(directEffects.includes(
      `architecture-effect-owner:${contractsPath}:node:child_process:child-process`,
    ));
    assert.ok(directEffects.includes(
      `architecture-effect-owner:${contractsPath}:node:fs:filesystem-read`,
    ));
    assert.ok(directEffects.includes(
      `architecture-effect-owner:${contractsPath}:git-invocation:git`,
    ));
    assert.ok(directEffects.includes(
      `architecture-effect-boundary:${contractsPath}:pure:child-process,filesystem-read,git`,
    ));

    const existingChildProcessRoot = makeRuntimeCandidate();
    // A module that already imports `spawn` (recorded-command.ts and the guard
    // runner test-guards.ts no longer do: they run only through the supervisor,
    // wf-1b3a-design M3, LAND-OC-FIX round 12).
    const spawner = "scripts/commit-guard.ts";
    appendCandidateSource(existingChildProcessRoot, spawner, [
      'void spawn("git", ["status", "--short"]);',
    ].join("\n"));
    const existingChildProcess = verifyS1Structure(existingChildProcessRoot).violations;
    assert.ok(existingChildProcess.includes(
      `architecture-effect-owner:${spawner}:git-invocation:git`,
    ));

    const aliasedGitPathRoot = makeRuntimeCandidate();
    appendCandidateSource(aliasedGitPathRoot, spawner, [
      'import { execFile as architectureExecFile } from "node:child_process";',
      'const architectureGitExecutable = "/usr/bin/git";',
      'void architectureExecFile(architectureGitExecutable, ["status", "--short"]);',
    ].join("\n"));
    const aliasedGitPath = verifyS1Structure(aliasedGitPathRoot).violations;
    assert.ok(aliasedGitPath.includes(
      `architecture-effect-owner:${spawner}:git-invocation:git`,
    ));

    const dynamicChildExecutableRoot = makeRuntimeCandidate();
    appendCandidateSource(dynamicChildExecutableRoot, spawner, [
      'import { execFile as architectureDynamicExecFile } from "node:child_process";',
      "const architectureDynamicExecutable = process.env.ARCHITECTURE_GIT;",
      'void architectureDynamicExecFile(architectureDynamicExecutable, ["status"]);',
    ].join("\n"));
    const dynamicChildExecutable = verifyS1Structure(dynamicChildExecutableRoot).violations;
    assert.ok(dynamicChildExecutable.includes(
      `architecture-effect-owner:${spawner}:git-invocation:git`,
    ));
    assert.ok(dynamicChildExecutable.includes(
      `architecture-effect-unmodeled:${spawner}:node:child_process:dynamic-executable-execFile`,
    ));

    const dynamicFilesystemRoot = makeRuntimeCandidate();
    const kernelConfig = candidateModulePath("kernel/config.ts");
    appendCandidateSource(dynamicFilesystemRoot, kernelConfig, [
      'import * as architectureFs from "node:fs";',
      "const architectureFsMember = String(Date.now());",
      'void architectureFs[architectureFsMember]("architecture-mutant");',
    ].join("\n"));
    const dynamicFilesystem = verifyS1Structure(dynamicFilesystemRoot).violations;
    assert.ok(dynamicFilesystem.includes(
      `architecture-effect-unmodeled:${kernelConfig}:node:fs:dynamic-member`,
    ));
    assert.ok(dynamicFilesystem.includes(
      `architecture-effect-owner:${kernelConfig}:node:fs:filesystem-read,filesystem-write`,
    ));
    assert.ok(dynamicFilesystem.includes(
      `architecture-effect-boundary:${kernelConfig}:pure:filesystem-read,filesystem-write`,
    ));

    for (const [source, expectedEffect] of [
      ['import { promises as fs } from "node:fs"; void fs.readFile("fixture");', "filesystem-read"],
      ['import { promises as fs } from "node:fs"; void fs.writeFile("fixture", "value");', "filesystem-write"],
    ] as const) {
      const facts = analyzeArchitectureSource("verification/fs-promises-alias.ts", source);
      assert.ok(facts.directEffectFacts.some((fact) => fact.ownerLabel === "node:fs/promises" &&
        fact.effects.includes(expectedEffect)));
      assert.deepEqual(facts.unmodeledEffects, []);
    }
    const temporaryFileFacts = analyzeArchitectureSource(
      "verification/fs-open-flags.ts",
      [
        'import { constants, openSync } from "node:fs";',
        'void openSync("fixture", constants.O_TMPFILE | constants.O_WRONLY);',
      ].join("\n"),
    );
    assert.ok(temporaryFileFacts.directEffectFacts.some((fact) =>
      fact.ownerLabel === "node:fs" && fact.effects.includes("filesystem-write")));
    assert.deepEqual(temporaryFileFacts.unmodeledEffects, []);

    const createRequireFacts = analyzeArchitectureSource(
      "verification/fs-create-require.ts",
      [
        'import { createRequire } from "node:module";',
        "const load = createRequire(import.meta.url);",
        'const { writeFileSync: writeFixture } = load("node:fs");',
        'void writeFixture("fixture", "value");',
      ].join("\n"),
    );
    assert.ok(createRequireFacts.directEffectFacts.some((fact) =>
      fact.ownerLabel === "node:fs" && fact.effects.includes("filesystem-write")));
    assert.deepEqual(createRequireFacts.unmodeledEffects, []);

    const gitShellFacts = analyzeArchitectureSource(
      "verification/git-shell.ts",
      [
        'import { exec as runShell } from "node:child_process";',
        'const command = "git status --short";',
        "void runShell(command);",
      ].join("\n"),
    );
    assert.ok(gitShellFacts.directEffectFacts.some((fact) =>
      fact.ownerLabel === "git-invocation" && fact.effects.includes("git")));

    for (const source of [
      [
        'import { getBuiltinModule } from "node:process";',
        'getBuiltinModule("node:fs").writeFileSync("fixture", "value");',
      ].join("\n"),
      [
        "const { getBuiltinModule } = process;",
        'getBuiltinModule("node:fs").writeFileSync("fixture", "value");',
      ].join("\n"),
      [
        'import * as fs from "node:fs";',
        "const { writeFileSync = () => undefined } = fs;",
        'writeFileSync("fixture", "value");',
      ].join("\n"),
    ]) {
      const facts = analyzeArchitectureSource("verification/fs-loader-carrier.ts", source);
      assert.ok(facts.directEffectFacts.some((fact) =>
        fact.ownerLabel === "node:fs" && fact.effects.includes("filesystem-write")));
      assert.deepEqual(facts.unmodeledEffects, []);
    }

    for (const [source, reason] of [
      [[
        'import * as fs from "node:fs";',
        "const { ...ops } = fs;",
        'ops.writeFileSync("fixture", "value");',
      ].join("\n"), "node:fs:rest-carrier-ops"],
      [[
        'import * as fs from "node:fs";',
        "let ops = fs;",
        "if (Date.now()) ops = fs;",
        'ops.writeFileSync("fixture", "value");',
      ].join("\n"), "node:fs:mutable-carrier-ops"],
    ] as const) {
      const facts = analyzeArchitectureSource("verification/fs-uncertain-carrier.ts", source);
      assert.ok(facts.directEffectFacts.some((fact) => fact.ownerLabel === "node:fs" &&
        fact.effects.includes("filesystem-read") && fact.effects.includes("filesystem-write")));
      assert.ok(facts.unmodeledEffects.includes(reason));
    }

    for (const source of [
      'import { execFile } from "node:child_process"; execFile("/usr/bin/env", ["git", "status"]);',
      'import { exec } from "node:child_process"; exec("env git status");',
    ]) {
      const facts = analyzeArchitectureSource("verification/git-environment-wrapper.ts", source);
      assert.ok(facts.directEffectFacts.some((fact) =>
        fact.ownerLabel === "git-invocation" && fact.effects.includes("git")));
      assert.deepEqual(facts.unmodeledEffects, []);
    }

    const dynamicChildFacts = analyzeArchitectureSource(
      "verification/dynamic-child-executable.ts",
      [
        'import { execFile } from "node:child_process";',
        "const binary = process.env.GIT;",
        'execFile(binary, ["status"]);',
      ].join("\n"),
    );
    assert.ok(dynamicChildFacts.directEffectFacts.some((fact) =>
      fact.ownerLabel === "git-invocation" && fact.effects.includes("git")));
    assert.ok(dynamicChildFacts.unmodeledEffects.includes(
      "node:child_process:dynamic-executable-execFile",
    ));

    const commandRoot = makeRuntimeCandidate();
    appendCandidateSource(commandRoot, "scripts/tooling/recorded-command.ts", [
      'import { pathToFileURL as mutantPathToFileURL } from "node:url";',
      "if (process.argv[1] && import.meta.url === mutantPathToFileURL(process.argv[1]).href) {",
      "  process.exitCode = 0;",
      "}",
    ].join("\n"));
    assert.ok(verifyS1Structure(commandRoot).violations.includes(
      "architecture-unregistered-command-root:scripts/tooling/recorded-command.ts",
    ));

    const packageCommandRoot = makeRuntimeCandidate();
    const packagePath = join(packageCommandRoot, "package.json");
    const packageDocument = JSON.parse(readFileSync(packagePath, "utf8")) as {
      scripts: Record<string, string>;
    };
    packageDocument.scripts["architecture-mutant"] = "node scripts/tooling/recorded-command.ts";
    writeFileSync(packagePath, `${JSON.stringify(packageDocument, null, 2)}\n`);
    assert.ok(verifyS1Structure(packageCommandRoot).violations.includes(
      "architecture-package-command-root-unregistered:scripts/tooling/recorded-command.ts",
    ));

    const registryBoundaryRoot = makeRuntimeCandidate();
    appendCandidateSource(
      registryBoundaryRoot,
      "src/architecture-manifest.ts",
      `export const forbiddenRuntimeReference = "${historicalApplicationName("-")}-runtime";`,
    );
    assert.ok(verifyS1Structure(registryBoundaryRoot).violations.includes(
      "standalone-product-boundary-reference:src/architecture-manifest.ts",
    ));

    const thirdRootPath = "scripts/tooling/recorded-command.ts";
    const modulesWithThirdRoot = ARCHITECTURE_MANIFEST.modules.map((module) =>
      module.path === thirdRootPath
        ? { ...module, compositionRoot: true as const, executionBoundary: "composition-root" as const }
        : module
    );
    const registeredThirdRoot: ArchitectureManifest = {
      ...ARCHITECTURE_MANIFEST,
      compositionRoots: {
        ...ARCHITECTURE_MANIFEST.compositionRoots,
        builder: [...ARCHITECTURE_MANIFEST.compositionRoots.builder, thirdRootPath].toSorted(),
      },
      modules: modulesWithThirdRoot,
    };
    assert.deepEqual(
      verifyArchitectureSources(repositoryArchitectureSources(registeredThirdRoot), registeredThirdRoot).violations
        .filter((entry) => entry.startsWith("architecture-composition-root")),
      [],
    );
    const omittedThirdRoot: ArchitectureManifest = {
      ...registeredThirdRoot,
      compositionRoots: ARCHITECTURE_MANIFEST.compositionRoots,
    };
    assert.ok(verifyArchitectureSources(
      repositoryArchitectureSources(omittedThirdRoot),
      omittedThirdRoot,
    ).violations.includes("architecture-composition-root-drift"));
  },
};

for (const scenarioId of Object.keys(scenarios).toSorted()) {
  test(scenarioId, scenarios[scenarioId]!);
}

test.afterEach(removeOwnedTemporaryDirectories);
test.after(removeOwnedTemporaryDirectories);
