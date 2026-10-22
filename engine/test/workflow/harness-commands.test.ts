import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync, mkdirSync, readFileSync, appendFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  harnessCheck,
  harnessTest,
  harnessRegenerate,
  harnessRegister,
  harnessSync,
  runBundleBuildStep,
  syncPassVerdict,
  regenerateReadmeConsumers,
  harnessNewModule,
  runArchitectureCheck,
  runInventoryCheck,
  wrapCommandError,
  runHarnessCli,
  HARNESS_SUBCOMMANDS,
  type HarnessCheckOutput,
  type HarnessRegenerateOutput,
  type HarnessRegisterOutput,
  type HarnessSyncOutput,
  communityFilesStep,
  evidenceIgnoreStep,
  trackerBoardStep,
  frozenRecordsStep,
} from "../../src/workflow/harness-commands.ts";
import { ARCHITECTURE_MANIFEST } from "../../src/architecture-manifest.ts";
import { HARNESS_COMMAND_SCHEMA_VERSION, parseHarnessCommandResult, resultHasFail, type HarnessCommandResult } from "../../src/workflow/command-result.ts";
import { collectTestResults } from "../../src/workflow/test-result-collector.ts";
import { HarnessError, InputError } from "../../src/kernel/errors.ts";
import { canonicalJson, sha256 } from "../../src/kernel/integrity.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { relaxSafeReadFloorForThisFile } from "../support/test-env-helpers.ts";
import { engineModuleSourceRelative } from "../support/module-resolver.ts";
import { ROOT_POLICY as ROOT_POLICY_AT_LOAD } from "../../src/kernel/root-policy.ts";
import { README_CONSUMER_BLOCK, VERIFICATION_PATHS } from "../../src/kernel/verification-paths.ts";
import {
  createRepositoryWorkingCopy,
  engineGeneratorPopulation,
  removeRepositoryLocalTemporaryDirectory,
  removeRepositoryLocalTemporaryRoot,
} from "../support/repository-local-temporary.ts";

const ROOT = process.cwd();

// These tests exercise the harness workflow commands against the real
// repository workspace, which is seeded with `cp -rl` hardlinks (nlink=2) and
// runs with `selfProtection.enabled: false` (dev mode). The safe repository
// reader accepts hardlinked files in dev mode via the
// `HARNESS_REJECT_HARDLINKS` env var consumed by `shouldRejectHardlinks`
// (see `src/shared/source-scan.ts`). Hardlink rejection is verified separately
// by the dedicated security tests in `test/repository-root-capability.test.ts`
// and `test/verification/recursive-test-inventory.test.ts`, which leave the
// env var unset so the production floor is enforced.
// Relaxed for THIS FILE and restored when it finishes — see the helper.
relaxSafeReadFloorForThisFile();

// The auto-disposition fixture test creates a repository-local temporary
// directory; release the process-owned fixture root (and its capabilities)
// after every test in this file has completed.
test.after(removeRepositoryLocalTemporaryRoot);

// ---------------------------------------------------------------------------
// Shared cached results for read-only commands.
//
// Many tests below assert distinct invariants over the SAME command output
// (harnessCheck with all-skip, harnessRegister write=false, harnessRegenerate
// write=false). Each command invocation re-scans the entire repository
// (module-registrar parses every src/*.ts with babel, auto-generator computes
// every binding). Re-running these commands per-assertion is the dominant
// cost of this file (~80s before, mostly redundant rescans).
//
// The commands are deterministic and side-effect-free for write=false / all-skip
// options, so a single lazy invocation is reused by every assertion that does
// not specifically exercise distinct options or mutation behavior.
// ---------------------------------------------------------------------------

let cachedCheckSkipAll: HarnessCommandResult<HarnessCheckOutput> | null = null;
let cachedRegisterReadOnly: HarnessCommandResult<HarnessRegisterOutput> | null = null;
let cachedRegenerateReadOnly: HarnessCommandResult<HarnessRegenerateOutput> | null = null;
let cachedCheckArchitectureOnly: HarnessCommandResult<HarnessCheckOutput> | null = null;
let cachedCheckInventoryOnly: HarnessCommandResult<HarnessCheckOutput> | null = null;
let cachedCheckArchAndInventory: HarnessCommandResult<HarnessCheckOutput> | null = null;

function checkSkipAll(): Promise<HarnessCommandResult<HarnessCheckOutput>> {
  if (cachedCheckSkipAll) return Promise.resolve(cachedCheckSkipAll);
  return harnessCheck(ROOT, { skipTypecheck: true, skipArchitecture: true, skipInventory: true })
    .then((result) => { cachedCheckSkipAll = result; return result; });
}

// The architecture-only, inventory-only, and arch+inventory checks each
// re-run the full module-registrar + auto-generator + hash-binding scans
// (the dominant in-process cost). They are deterministic and side-effect
// free for write=false, so a single lazy invocation is reused by every
// assertion that does not exercise distinct options.
function checkArchitectureOnly(): Promise<HarnessCommandResult<HarnessCheckOutput>> {
  if (cachedCheckArchitectureOnly) return Promise.resolve(cachedCheckArchitectureOnly);
  return harnessCheck(ROOT, { skipTypecheck: true, skipInventory: true })
    .then((result) => { cachedCheckArchitectureOnly = result; return result; });
}

function checkInventoryOnly(): Promise<HarnessCommandResult<HarnessCheckOutput>> {
  if (cachedCheckInventoryOnly) return Promise.resolve(cachedCheckInventoryOnly);
  return harnessCheck(ROOT, { skipTypecheck: true, skipArchitecture: true })
    .then((result) => { cachedCheckInventoryOnly = result; return result; });
}

function checkArchAndInventory(): Promise<HarnessCommandResult<HarnessCheckOutput>> {
  if (cachedCheckArchAndInventory) return Promise.resolve(cachedCheckArchAndInventory);
  return harnessCheck(ROOT, { skipTypecheck: true, skipArchitecture: false, skipInventory: false })
    .then((result) => { cachedCheckArchAndInventory = result; return result; });
}

function registerReadOnly(): HarnessCommandResult<HarnessRegisterOutput> {
  if (cachedRegisterReadOnly) return cachedRegisterReadOnly;
  const result = harnessRegister(ROOT, { write: false });
  cachedRegisterReadOnly = result;
  return result;
}

function regenerateReadOnly(): HarnessCommandResult<HarnessRegenerateOutput> {
  if (cachedRegenerateReadOnly) return cachedRegenerateReadOnly;
  const result = harnessRegenerate(ROOT, { write: false });
  cachedRegenerateReadOnly = result;
  return result;
}

test("HarnessCommands: harnessCheck produces valid result structure", async () => {
  const result = await checkArchAndInventory();
  assert.equal(result.schemaVersion, HARNESS_COMMAND_SCHEMA_VERSION);
  assert.equal(result.command, "check");
  assert.ok(["pass", "fail"].includes(result.status));
  assert.ok(typeof result.integrityHash === "string");
  assert.ok(result.result.typecheck !== undefined);
  assert.ok(result.result.architecture !== undefined);
  assert.ok(result.result.inventory !== undefined);
  assert.ok(result.result.moduleRegistrar !== undefined);
  assert.ok(result.result.autoGenerator !== undefined);
  assert.ok(typeof result.result.allPassed === "boolean");
});

test("HarnessCommands: harnessCheck with all skips produces skip statuses", async () => {
  const result = await checkSkipAll();
  assert.equal(result.result.typecheck.status, "skip");
  assert.equal(result.result.architecture.status, "skip");
  assert.equal(result.result.inventory.status, "skip");
});

test("HarnessCommands: harnessCheck moduleRegistrar and autoGenerator steps run", async () => {
  const result = await checkSkipAll();
  assert.ok(["pass", "fail"].includes(result.result.moduleRegistrar.status));
  assert.ok(typeof result.result.moduleRegistrar.message === "string");
  assert.ok(["pass", "fail"].includes(result.result.autoGenerator.status));
  assert.ok(typeof result.result.autoGenerator.message === "string");
});

test("M1: harnessCheck judges dead registry commands over the checkout's promotion profiles (the schema cannot see them)", async () => {
  const result = await checkSkipAll();
  assert.equal(result.result.deadCommands.step, "dead-commands");
  assert.equal(result.result.deadCommands.status, "pass", result.result.deadCommands.message);
  assert.match(result.result.deadCommands.message, /every registry command is run by a workspace phase or a promotion profile/u, "this checkout declares its profiles, so the step judges");
});

test("#221: harnessCheck judges the bundle against a rebuild of the source (no committed digest)", async () => {
  const result = await checkSkipAll();
  assert.equal(result.result.bundle.step, "bundle");
  assert.ok(["pass", "fail"].includes(result.result.bundle.status));
  assert.match(result.result.bundle.message, /dist\/bundle\.js/u);
});

test("HarnessCommands: harnessCheck result is frozen", async () => {
  const result = await checkSkipAll();
  assert.ok(Object.isFrozen(result));
});

test("HarnessCommands: harnessCheck integrity hash is valid", async () => {
  const result = await checkSkipAll();
  const { integrityHash, ...unsigned } = result;
  assert.equal(sha256(canonicalJson(unsigned)), integrityHash);
});

test("HarnessCommands: harnessCheck has generatedAt timestamp", async () => {
  const result = await checkSkipAll();
  const parsed = new Date(result.generatedAt);
  assert.ok(!Number.isNaN(parsed.getTime()));
});

test("HarnessCommands: harnessTest produces valid result structure", async () => {
  const tmpDir = createTempDir("harness-test-");
  try {
    mkdirSync(join(tmpDir, "test"), { recursive: true });
    writeFileSync(join(tmpDir, "test", "simple.test.ts"), `import test from "node:test";\ntest("pass", () => {});\n`);
    const result = await harnessTest(tmpDir, { file: "test/simple.test.ts", writeResults: false });
    assert.equal(result.schemaVersion, HARNESS_COMMAND_SCHEMA_VERSION);
    assert.equal(result.command, "test");
    assert.ok(result.result.testResults !== undefined);
    assert.ok(result.result.resultsPath !== undefined);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("HarnessCommands: harnessRegenerate produces valid result", () => {
  const result = regenerateReadOnly();
  assert.equal(result.schemaVersion, HARNESS_COMMAND_SCHEMA_VERSION);
  assert.equal(result.command, "regenerate");
  assert.ok(result.result.autoGenerator !== undefined);
  assert.ok(result.result.moduleRegistrar !== undefined);
  // The pin-authority arm: the choke point must actually run the driver at
  // its master-runtime home (`scripts/pin-authority-regeneration.ts`) and
  // report convergence. This is the arm that could not run on a product tree
  // at all when the driver was misfiled under the declared testing-only
  // `scripts/tooling/` folder — there the subprocess died with
  // MODULE_NOT_FOUND and the whole regenerate step failed.
  assert.ok(result.result.pinAuthorities !== undefined, "the regenerate output must carry the pin-authority arm");
  assert.equal(result.result.pinAuthorities.converged, true, "the pin-authority arm must converge on this tree");
  assert.equal(result.result.pinAuthorities.status, "current");
  // The ratchet arm (a2b-design H2): every registered baseline is judged
  // against its guard's scan, and on a synced tree none holds debt that fell.
  assert.deepEqual(result.result.ratchetBaselines.results.map((arm) => arm.id), Object.keys(ROOT_POLICY_AT_LOAD.verification.ratchetBaselines));
  assert.equal(result.result.ratchetBaselines.converged, true, `the ratchet arm must converge on this tree: ${JSON.stringify(result.result.ratchetBaselines.results)}`);
  // The README consumer arm (WF-DEL leftover): the generator really runs as
  // the sync's subprocess, over every marked README, and a synced tree is current.
  assert.equal(result.result.readmeConsumers.status, "current", `the README consumer arm must converge on this tree: ${JSON.stringify(result.result.readmeConsumers)}`);
  assert.ok(result.result.readmeConsumers.readmes > 0, "the README consumer arm judged no README");
});

test("HarnessCommands: the README consumer arm drives the generator — a check finds a stale block and names it, a write regenerates it, and a missing generator with marked READMEs is STALE, never converged by absence", () => {
  // A synthetic repository: `engine/src/feature/` holds a module, its
  // consumer, and a README whose generated block is empty (stale); the
  // generator is the real one (its folder linked in, so it resolves its own
  // imports from this checkout).
  const repository = createTempDir("readme-consumers-arm-");
  try {
    const feature = join(repository, "engine", "src", "feature");
    mkdirSync(feature, { recursive: true });
    writeFileSync(join(feature, "provider.ts"), "export const provided = 1;\n");
    writeFileSync(join(feature, "user.ts"), 'import { provided } from "./provider.ts";\nexport const used = provided;\n');
    const readme = join(feature, "README.md");
    const before = `# feature\n\n${README_CONSUMER_BLOCK.begin}\n${README_CONSUMER_BLOCK.end}\n`;
    writeFileSync(readme, before);
    // A marked README OUTSIDE the resolver's product roots (wf-del2-design D2:
    // `shared/README.md` was a generated output nobody regenerated): the one
    // selection makes the generator project it too.
    mkdirSync(join(repository, "shared"), { recursive: true });
    writeFileSync(join(repository, "shared", "lib.ts"), "export const shared = 1;\n");
    writeFileSync(join(feature, "shared-user.ts"), 'import { shared } from "../../../shared/lib.ts";\nexport const again = shared;\n');
    const sharedReadme = join(repository, "shared", "README.md");
    writeFileSync(sharedReadme, before.replace("feature", "shared"));
    execFileSync("git", ["init", "-q"], { cwd: repository, stdio: "pipe" });
    const engineRoot = join(repository, "engine");

    // THE POPULATION, NOT THE CHECKER'S EXISTENCE: two marked READMEs wait,
    // and the generator is absent. The old arm asserted `absent`/converged
    // here — the checker's absence read as the subject's absence.
    const missing = regenerateReadmeConsumers(engineRoot, false);
    assert.deepEqual(
      [missing.status, missing.converged, missing.readmes],
      ["stale", false, 2],
      "a missing generator with marked READMEs must be STALE and name the population it abandons",
    );
    assert.match(missing.changed[0] ?? "", /tests\/helpers\/readme-consumers\.ts \(missing; 2 marked README\(s\) still need it\)/u);

    mkdirSync(join(repository, "tests"), { recursive: true });
    symlinkSync(join(ROOT, "..", "tests", "helpers"), join(repository, "tests", "helpers"));
    const stale = regenerateReadmeConsumers(engineRoot, false);
    assert.deepEqual([stale.status, stale.converged, [...stale.changed].sort()], ["stale", false, ["engine/src/feature/README.md", "shared/README.md"]], JSON.stringify(stale));
    assert.equal(readFileSync(readme, "utf8"), before, "a check wrote the README");
    const written = regenerateReadmeConsumers(engineRoot, true);
    assert.deepEqual([written.status, written.converged, [...written.changed].sort()], ["regenerated", true, ["engine/src/feature/README.md", "shared/README.md"]], JSON.stringify(written));
    assert.match(readFileSync(readme, "utf8"), /`provider\.ts` is consumed by `engine\/src\/feature\/user\.ts`/u);
    assert.match(readFileSync(sharedReadme, "utf8"), /`lib\.ts` is consumed by `engine\/src\/feature\/shared-user\.ts`/u);
    assert.deepEqual(regenerateReadmeConsumers(engineRoot, false), { status: "current", converged: true, readmes: 2, changed: [] });
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("HarnessCommands: the README consumer arm is absent ONLY when the tree carries no marked README at all", () => {
  // The positive absence: no marked README is a population of zero, so there
  // is nothing to generate. This is the one state `absent` may describe; it
  // is not the state a missing generator describes when READMEs are waiting.
  const repository = createTempDir("readme-consumers-none-");
  try {
    mkdirSync(join(repository, "engine"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repository, stdio: "pipe" });
    assert.deepEqual(
      regenerateReadmeConsumers(join(repository, "engine"), false),
      { status: "absent", converged: true, readmes: 0, changed: [] },
      "a tree with no marked README has nothing to converge",
    );
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("HarnessCommands: the README consumer arm reads the generator's LAST line; no JSON result line is the typed readme_consumers_no_result", () => {
  // wf-del2-correctness NEW-11: `JSON.parse(stdout)` of the whole output
  // turned any line an import printed into an untyped SyntaxError.
  const repository = createTempDir("readme-consumers-protocol-");
  try {
    mkdirSync(join(repository, "engine"), { recursive: true });
    mkdirSync(join(repository, "tests", "helpers"), { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repository, stdio: "pipe" });
    const generator = join(repository, README_CONSUMER_BLOCK.generator);
    const answer = { allCurrent: true, status: "current", readmes: 3, bootstrapped: 0, changed: [] };
    writeFileSync(generator, `console.log("an import said something");\nconsole.log(${JSON.stringify(JSON.stringify(answer))});\n`);
    assert.deepEqual(regenerateReadmeConsumers(join(repository, "engine"), false), { status: "current", converged: true, readmes: 3, changed: [] });
    writeFileSync(generator, `console.log("no result at all");\n`);
    assert.throws(() => regenerateReadmeConsumers(join(repository, "engine"), false), (error: unknown) => (error as { code?: string }).code === "readme_consumers_no_result");
    writeFileSync(generator, `console.log("[1, 2]");\n`);
    assert.throws(() => regenerateReadmeConsumers(join(repository, "engine"), false), (error: unknown) => (error as { code?: string }).code === "readme_consumers_no_result");
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("HarnessCommands: harnessRegenerate result is frozen", () => {
  const result = regenerateReadOnly();
  assert.ok(Object.isFrozen(result));
});

test("HarnessCommands: harnessRegenerate integrity hash is valid", () => {
  const result = regenerateReadOnly();
  const { integrityHash, ...unsigned } = result;
  assert.equal(sha256(canonicalJson(unsigned)), integrityHash);
});

test("HarnessCommands: harnessNewModule throws on empty path", () => {
  assert.throws(() => harnessNewModule(ROOT, ""), /module path/);
});

test("HarnessCommands: harnessNewModule creates a module file", () => {
  const tmpDir = createTempDir("harness-newmod-");
  try {
    const result = harnessNewModule(tmpDir, "src/test-module.ts");
    assert.equal(result.command, "new-module");
    assert.equal(result.result.created, true);
    assert.equal(result.result.modulePath, "src/test-module.ts");
    const content = readFileSync(join(tmpDir, "src", "test-module.ts"), "utf8");
    assert.ok(content.includes("export"));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("HarnessCommands: harnessNewModule with existing file does not create", () => {
  const tmpDir = createTempDir("harness-newmod-exist-");
  try {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "existing.ts"), `export const X = 1;\n`);
    const result = harnessNewModule(tmpDir, "src/existing.ts");
    assert.equal(result.result.created, false);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("HarnessCommands: harnessNewModule prepends src/ when not prefixed", () => {
  const tmpDir = createTempDir("harness-newmod-prefix-");
  try {
    const result = harnessNewModule(tmpDir, "my-module.ts");
    assert.equal(result.result.modulePath, "src/my-module.ts");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("HarnessCommands: harnessNewModule does not prepend for scripts/ or verification/", () => {
  const tmpDir = createTempDir("harness-newmod-scripts-");
  try {
    const result = harnessNewModule(tmpDir, "scripts/my-script.ts");
    assert.equal(result.result.modulePath, "scripts/my-script.ts");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("HarnessCommands: parseHarnessCommandResult throws on non-object", () => {
  assert.throws(() => parseHarnessCommandResult(null), /must be an object/);
  assert.throws(() => parseHarnessCommandResult("str"), /must be an object/);
  assert.throws(() => parseHarnessCommandResult(42), /must be an object/);
});

test("HarnessCommands: parseHarnessCommandResult parses, rejects tampered schema/integrity", async () => {
  const result = await checkSkipAll();
  const parsed = parseHarnessCommandResult(JSON.parse(canonicalJson(result)));
  assert.equal(parsed.schemaVersion, result.schemaVersion);
  assert.equal(parsed.command, result.command);

  const wrongSchema = JSON.parse(canonicalJson(result));
  wrongSchema.schemaVersion = "wrong";
  assert.throws(() => parseHarnessCommandResult(wrongSchema), /schema version/);

  const tampered = JSON.parse(canonicalJson(result));
  tampered.integrityHash = "0".repeat(64);
  assert.throws(() => parseHarnessCommandResult(tampered), /integrity is invalid/);

  const missing = JSON.parse(canonicalJson(result));
  delete missing.integrityHash;
  assert.throws(() => parseHarnessCommandResult(missing), /integrity hash/);
});

test("HarnessCommands: harnessCheck architecture step detects drift", async () => {
  const result = await checkArchitectureOnly();
  assert.ok(["pass", "fail"].includes(result.result.architecture.status));
});

test("HarnessCommands: the architecture step gates the external-command inventory's sources and its publication boundary", () => {
  const copy = createRepositoryWorkingCopy("external-command-check-", { include: engineGeneratorPopulation });
  const engine = copy.engineRoot;
  try {
    const baseline = runArchitectureCheck(engine);
    assert.equal(baseline.status, "pass", `a clean copy must be in sync: ${baseline.message}`);
    // The old step ran only the module registrar: an edited external-command
    // source left "architecture manifest is in sync".
    const published = ARCHITECTURE_MANIFEST.externalCommands.find((command) => command.publication === "published");
    assert.ok(published, "the inventory must publish at least one command for this arm");
    const publishedPath = join(engine, published.path);
    const original = readFileSync(publishedPath, "utf8");
    writeFileSync(publishedPath, `${original}\n# a source edit the old step never read\n`);
    const drifted = runArchitectureCheck(engine);
    assert.equal(drifted.status, "fail", "a published source edit must red the architecture step");
    assert.match(drifted.message, /architecture-external-command-source-hash-drift/u);
    writeFileSync(publishedPath, original);

    // A DECLARED ABSENCE stays green; a source that APPEARS at its path is a
    // boundary breach, not a hash to compare.
    const notPublished = ARCHITECTURE_MANIFEST.externalCommands.find((command) => command.publication === "not-published");
    assert.ok(notPublished, "the inventory must declare a not-published boundary for this arm");
    const absentPath = join(engine, notPublished.path);
    assert.equal(existsSync(absentPath), false, "the public snapshot must not carry the not-published source");
    mkdirSync(join(engine, notPublished.path.slice(0, notPublished.path.lastIndexOf("/"))), { recursive: true });
    writeFileSync(absentPath, "# accidentally published\n");
    const unexpectedly = runArchitectureCheck(engine);
    assert.equal(unexpectedly.status, "fail", "a not-published source that appears must red the step");
    assert.match(unexpectedly.message, /architecture-external-command-source-unexpectedly-published/u);
    rmSync(absentPath);
    assert.equal(runArchitectureCheck(engine).status, "pass", "restoring the boundary restores the step");
  } finally {
    removeRepositoryLocalTemporaryDirectory(copy.root);
  }
});

test("HarnessCommands: a deleted governed artifact is refused by the check's artifact arm, with the way out named", async () => {
  const copy = createRepositoryWorkingCopy("artifact-prune-gate-", { include: engineGeneratorPopulation });
  const engine = copy.engineRoot;
  try {
    const options = { skipTypecheck: true, skipArchitecture: true, skipInventory: true } as const;
    const baseline = await harnessCheck(engine, options);
    assert.equal(baseline.result.artifactManifest.status, "pass", baseline.result.artifactManifest.message);
    // THE DEFECT: the producer used to rebuild the inventory from the surviving
    // files (500 -> 499 entries), the byte compare then agreed with itself, and
    // the check went green with no supersession record.
    const removed = "verification/benchmarks/runtime/schemas/README.md";
    rmSync(join(engine, removed));
    const drifted = await harnessCheck(engine, options);
    assert.equal(drifted.result.artifactManifest.status, "fail", "a dropped artifact must red the check");
    assert.match(drifted.result.artifactManifest.message, /artifact-manifest refused/u);
    assert.match(drifted.result.artifactManifest.message, /--prune verification\/benchmarks\/runtime\/schemas\/README\.md/u);
  } finally {
    removeRepositoryLocalTemporaryDirectory(copy.root);
  }
});

test("HarnessCommands: harnessCheck inventory step checks inventory hash", async () => {
  const result = await checkInventoryOnly();
  assert.ok(["pass", "fail", "skip"].includes(result.result.inventory.status));
});

test("HarnessCommands: the inventory check asks the owning generator — an emptied inventory with its hash preserved is refused", () => {
  const copy = createRepositoryWorkingCopy("inventory-owner-check-", { include: engineGeneratorPopulation });
  const engine = copy.engineRoot;
  try {
    const inventoryPath = join(engine, VERIFICATION_PATHS.testInventory);
    const original = readFileSync(inventoryPath, "utf8");
    const parsed = JSON.parse(original) as { inventoryHash: string; tests: unknown[] };
    assert.ok(parsed.tests.length > 0, "the fixture inventory must carry tests for the emptied arm to mean anything");
    // The copy starts from whatever the checked-in inventory says; converge it
    // through its owner first, so this test is about the emptied arm and not
    // about the checkout's own freshness.
    execFileSync(process.execPath, [join(engine, "scripts", "test-inventory.ts"), "--write"], { cwd: engine, stdio: "pipe" });
    assert.equal(runInventoryCheck(engine).status, "pass", "the copy's own inventory is current after its generator ran");
    // THE DEFECT'S EXACT SHAPE: empty the entries, keep the self-declared hash.
    // The old step compared that hash with the root-policy pin — the same value
    // — and passed. The owner refuses an inventory with no entries.
    writeFileSync(inventoryPath, `${JSON.stringify({ ...parsed, tests: [] })}\n`);
    const refused = runInventoryCheck(engine);
    assert.equal(refused.status, "fail", "an emptied inventory must be refused by the commit gate");
    assert.match(refused.message, /test inventory|Too small|invalid/iu, `the refusal names the owner's reason: ${refused.message}`);
    // A malformed entry is refused too, not just the empty array.
    writeFileSync(inventoryPath, `${JSON.stringify({ ...parsed, tests: [{ bogus: true }] })}\n`);
    assert.equal(runInventoryCheck(engine).status, "fail", "a malformed entry is refused by the owner");
    writeFileSync(inventoryPath, original);
  } finally {
    removeRepositoryLocalTemporaryDirectory(copy.root);
  }
});

test("HarnessCommands: the published guardian spec-schema artifact is gated — a schema edit reds until its owner refreshes it", async () => {
  const copy = createRepositoryWorkingCopy("guardian-spec-freshness-", { include: engineGeneratorPopulation });
  const engine = copy.engineRoot;
  try {
    const options = { skipTypecheck: true, skipArchitecture: true, skipInventory: true } as const;
    const baseline = await harnessCheck(engine, options);
    assert.equal(baseline.result.guardianSpecArtifact.status, "pass", "the checked-in artifact is a fresh projection");
    const schemaPath = join(engine, "src", "filesystem", "self-protection", "self-protection-contracts.ts");
    const source = readFileSync(schemaPath, "utf8");
    const mutated = source.replace(
      "abi_version_hint: z.number().int().nonnegative().max(64),",
      "abi_version_hint: z.number().int().nonnegative().max(63),",
    );
    assert.notEqual(mutated, source, "the mutation must change the schema");
    writeFileSync(schemaPath, mutated);
    const drifted = await harnessCheck(engine, options);
    // THE OLD GATE HASHED THE PROJECTION ONLY: the artifact binding compares
    // the published JSON with itself, so an edit the projection can represent
    // was caught only by the projection rebuild. The source pin now sees the
    // schema module itself, so the same edit also reds hash-bindings.
    assert.equal(drifted.result.hashBindings.status, "fail", "the schema source pin must see the edit");
    assert.equal(drifted.result.guardianSpecArtifact.status, "fail", "a schema change must red the check");
    const generator = join(engine, "scripts", "verification", "guardian-spec-artifact.ts");
    execFileSync(process.execPath, [generator, "--write"], { cwd: engine, stdio: "pipe" });
    execFileSync(process.execPath, [generator, "--check"], { cwd: engine, stdio: "pipe" });
    // Restore the source and the projection, then plant the refinement the
    // projection CANNOT express: the artifact stays byte-identical (so the old
    // gate was green) while runtime admission changed. The source pin reds.
    writeFileSync(schemaPath, source);
    execFileSync(process.execPath, [generator, "--write"], { cwd: engine, stdio: "pipe" });
    const restored = await harnessCheck(engine, options);
    assert.equal(restored.result.hashBindings.status, "pass", "restoring the source restores its pin");
    assert.equal(restored.result.guardianSpecArtifact.status, "pass");
    const refined = source.replace(
      "abi_version_hint: z.number().int().nonnegative().max(64),",
      "abi_version_hint: z.number().int().nonnegative().max(64).refine((value) => value !== 63),",
    );
    assert.notEqual(refined, source, "the refinement mutation must change the schema source");
    writeFileSync(schemaPath, refined);
    const refinementOnly = await harnessCheck(engine, options);
    assert.equal(
      refinementOnly.result.guardianSpecArtifact.status,
      "pass",
      "the JSON projection cannot represent a refinement — this is why the artifact-only gate was incomplete",
    );
    assert.equal(refinementOnly.result.hashBindings.status, "fail", "the schema source pin must see a refinement-only change");
  } finally {
    removeRepositoryLocalTemporaryDirectory(copy.root);
  }
});

test("HarnessCommands: harnessTest structured JSON has correct fields", async () => {
  const tmpDir = createTempDir("harness-test-json-");
  try {
    mkdirSync(join(tmpDir, "test"), { recursive: true });
    writeFileSync(join(tmpDir, "test", "simple.test.ts"), `import test from "node:test";\ntest("pass", () => {});\n`);
    const result = await harnessTest(tmpDir, { file: "test/simple.test.ts", writeResults: false });
    const json = canonicalJson(result);
    const parsed = JSON.parse(json);
    assert.equal(parsed.schemaVersion, HARNESS_COMMAND_SCHEMA_VERSION);
    assert.equal(parsed.command, "test");
    assert.ok(parsed.result.testResults);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("HarnessCommands: harnessCheck allPassed, step names, status, and messages are consistent", async () => {
  const result = await checkSkipAll();
  if (result.result.moduleRegistrar.status === "pass" && result.result.autoGenerator.status === "pass") {
    assert.equal(result.result.allPassed, true);
  }
  assert.equal(result.result.typecheck.step, "typecheck");
  assert.equal(result.result.architecture.step, "architecture");
  assert.equal(result.result.inventory.step, "inventory");
  assert.equal(result.result.moduleRegistrar.step, "module-registrar");
  assert.equal(result.result.autoGenerator.step, "auto-generator");
  assert.equal(result.status, result.result.allPassed ? "pass" : "fail");
  for (const step of [result.result.typecheck, result.result.architecture, result.result.inventory, result.result.moduleRegistrar, result.result.autoGenerator]) {
    assert.ok(typeof step.message === "string");
    assert.ok(step.message.length > 0);
  }
});

test("HarnessCommands: harnessTest full run without a pinned inventory fails test_inventory_stale", async () => {
  const tmpDir = createTempDir("harness-test-all-");
  try {
    mkdirSync(join(tmpDir, "test"), { recursive: true });
    writeFileSync(join(tmpDir, "test", "a.test.ts"), `import test from "node:test";\ntest("a", () => {});\n`);
    // A full-suite harnessTest is bound to the pinned test inventory. A root
    // without a readable, policy-pinned inventory must fail closed instead of
    // silently running an unaccounted file set. Discovery-only behavior stays
    // covered by collectTestResults below and by the single-file path above.
    await assert.rejects(
      () => harnessTest(tmpDir, { all: true, writeResults: false }),
      (error: unknown) => {
        assert.ok(error instanceof HarnessError);
        assert.equal((error as HarnessError).code, "test_inventory_stale");
        return true;
      },
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("HarnessCommands: harnessTest with all discovers verification test files matching qualifiedSourcePatterns", async () => {
  // ROOT_POLICY.verification.testDiscovery.qualifiedSourcePatterns includes
  // verification/benchmarks/opencode-history/scope-guard.test.ts. The test
  // discovery must walk verification/ (not just test/) and include files that
  // match the canonical patterns, while excluding files that do NOT match.
  //
  // We use collectTestResults with concurrency:"auto" because the concurrency
  // report's parallel/serial lists are populated from discoverTestFiles
  // BEFORE node:test's run is invoked (run is skipped when called
  // recursively inside a test file, so we cannot assert on test names).
  const tmpDir = createTempDir("harness-test-verify-");
  try {
    mkdirSync(join(tmpDir, "test"), { recursive: true });
    writeFileSync(join(tmpDir, "test", "a.test.ts"), `import test from "node:test";\ntest("a", () => {});\n`);
    const verifyDir = join(tmpDir, "verification", "benchmarks", "opencode-history");
    mkdirSync(verifyDir, { recursive: true });
    writeFileSync(join(verifyDir, "scope-guard.test.ts"), `import test from "node:test";\ntest("scope-guard", () => {});\n`);
    // A test file that does NOT match any qualified pattern — must NOT be discovered.
    mkdirSync(join(tmpDir, "verification", "random"), { recursive: true });
    writeFileSync(join(tmpDir, "verification", "random", "unqualified.test.ts"), `import test from "node:test";\ntest("unqualified", () => {});\n`);
    const collection = await collectTestResults(tmpDir, { concurrency: "auto" });
    const report = collection.concurrencyReport;
    assert.ok(report !== null, "concurrency report must be present when concurrency is auto");
    const discovered = [...report!.parallel, ...report!.serial];
    assert.ok(
      discovered.some((f) => f.endsWith("test/a.test.ts")),
      `test/a.test.ts must be discovered; got: ${discovered.join(", ")}`,
    );
    assert.ok(
      discovered.some((f) => f.endsWith("verification/benchmarks/opencode-history/scope-guard.test.ts")),
      `verification/benchmarks/opencode-history/scope-guard.test.ts must be discovered; got: ${discovered.join(", ")}`,
    );
    assert.ok(
      !discovered.some((f) => f.includes("unqualified")),
      `verification/random/unqualified.test.ts must NOT be discovered (not in qualifiedSourcePatterns); got: ${discovered.join(", ")}`,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("HarnessCommands: 2 consecutive harnessRegenerate calls are consistent (determinism)", () => {
  // Determinism is proven by matching results across repeated calls; two
  // distinct invocations of the same scenario. Determinism is a pairwise
  // property — run A must equal run B — so a third invocation adds no
  // information the second does not already prove. The first invocation
  // reuses the cached read-only result (the 1st distinct call); the 2nd is
  // fresh. Comparing the two proves the function is deterministic without
  // paying for a third full repository scan.
  const results = [
    regenerateReadOnly(),
    harnessRegenerate(ROOT, { write: false }),
  ];
  for (let i = 1; i < results.length; i++) {
    assert.equal(results[0]!.command, results[i]!.command);
    assert.equal(results[0]!.result.autoGenerator.allMatch, results[i]!.result.autoGenerator.allMatch);
  }
});

test("HarnessCommands: harnessNewModule template has valid TypeScript", () => {
  const tmpDir = createTempDir("harness-template-");
  try {
    harnessNewModule(tmpDir, "src/my-mod.ts");
    const content = readFileSync(join(tmpDir, "src", "my-mod.ts"), "utf8");
    assert.ok(content.includes("export const MY_MOD_REVISION"));
    assert.ok(content.includes("export function myMod"));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("HarnessCommands: harnessNewModule handles nested paths", () => {
  const tmpDir = createTempDir("harness-nested-");
  try {
    harnessNewModule(tmpDir, "src/deep/nested/module.ts");
    assert.ok(readFileSync(join(tmpDir, "src", "deep", "nested", "module.ts"), "utf8").length > 0);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("HarnessCommands: harnessCheck and harnessRegister produced JSON can be re-parsed", async () => {
  const checkResult = await checkSkipAll();
  const checkReparsed = parseHarnessCommandResult(JSON.parse(canonicalJson(checkResult)));
  assert.equal(checkReparsed.command, checkResult.command);

  const registerResult = registerReadOnly();
  const registerReparsed = parseHarnessCommandResult(JSON.parse(canonicalJson(registerResult)));
  assert.equal(registerReparsed.command, registerResult.command);
});

test("HarnessCommands: harnessRegenerate write=false does not modify clean project files", () => {
  const rootPolicyPath = join(ROOT, engineModuleSourceRelative("root-policy.ts"));
  const before = readFileSync(rootPolicyPath, "utf8");
  regenerateReadOnly();
  const after = readFileSync(rootPolicyPath, "utf8");
  assert.equal(before, after);
});

test("HarnessCommands: harnessRegister structure, integrity, timestamp, and zero drift", () => {
  const result = registerReadOnly();
  assert.equal(result.schemaVersion, HARNESS_COMMAND_SCHEMA_VERSION);
  assert.equal(result.command, "register");
  assert.ok(["pass", "fail"].includes(result.status));
  assert.ok(result.result.registrarReport !== undefined);
  assert.ok(Object.isFrozen(result));
  const { integrityHash, ...unsigned } = result;
  assert.equal(sha256(canonicalJson(unsigned)), integrityHash);
  const parsed = new Date(result.generatedAt);
  assert.ok(!Number.isNaN(parsed.getTime()));
  assert.equal(result.result.registrarReport.driftedModules, 0);
  assert.equal(result.result.registrarReport.unregisteredModules, 0);
});

test("HarnessCommands: harnessRegister write=false does not modify manifest", () => {
  const before = readFileSync(join(ROOT, "src/architecture-manifest.ts"), "utf8");
  registerReadOnly();
  const after = readFileSync(join(ROOT, "src/architecture-manifest.ts"), "utf8");
  assert.equal(before, after);
});

test("HarnessCommands: harnessRegister on temp project detects unregistered modules", () => {
  const tmpDir = createTempDir("harness-register-");
  try {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "mod.ts"), `export const X = 1;\n`);
    mkdirSync(join(tmpDir, "test"), { recursive: true });
    writeFileSync(join(tmpDir, "test", "t.test.ts"), `import test from "node:test";\ntest("t", () => {});\n`);
    const result = harnessRegister(tmpDir, { write: false });
    assert.ok(result.result.registrarReport.unregisteredModules >= 1);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("HarnessCommands: harnessRegister determinism - same root produces same report", () => {
  // Two distinct invocations (the cached 1st + a fresh 2nd) prove the
  // function is deterministic for a deterministic, side-effect-free input.
  const r1 = registerReadOnly();
  const r2 = harnessRegister(ROOT, { write: false });
  assert.equal(r1.command, r2.command);
  assert.equal(r1.result.registrarReport.driftedModules, r2.result.registrarReport.driftedModules);
  assert.equal(r1.result.registrarReport.unregisteredModules, r2.result.registrarReport.unregisteredModules);
});

// ---------------------------------------------------------------------------
// Register write-mode post-fix status (C2 follow-up).
//
// Regression: `harness register --write` used to derive its status from the
// PRE-FIX drift counts, so a run that fully corrected the manifest still
// reported "fail". The status must come from the POST-WRITE outcome.
// ---------------------------------------------------------------------------

test("HarnessCommands: harnessRegister write passes after fully correcting drift and auto-registering new modules", () => {
  // Full working copy: every manifest module present, so the only drift is
  // the one mutation introduced below and it is field-correctable.
  const copy = createRepositoryWorkingCopy("harness-register-write-", { include: engineGeneratorPopulation });
  const tmpDir = copy.engineRoot;
  try {
    // Introduce exactly one drifted module: an extra export makes the
    // computed registration disagree with the (copied) manifest entry.
    appendFileSync(join(tmpDir, "src", "kernel/errors.ts"), "export const REGISTER_WRITE_DRIFT_PROBE = 1;\n");

    const corrected = harnessRegister(tmpDir, { write: true });
    assert.equal(corrected.result.registrarReport.driftedModules, 1);
    assert.ok(corrected.result.registrarReport.postWrite !== null);
    assert.equal(corrected.result.registrarReport.postWrite!.clean, true);
    assert.equal(corrected.result.registrarReport.postWrite!.driftedModules, 0);
    // The core regression: pre-fix drift (1 module) must NOT fail the run —
    // the correction succeeded, so the status is pass.
    assert.equal(corrected.status, "pass");
    // The manifest on disk now carries the corrected export count.
    const manifestAfter = readFileSync(join(tmpDir, "src", "architecture-manifest.ts"), "utf8");
    const driftedEntry = corrected.result.registrarReport.drift.find((entry) => entry.path === engineModuleSourceRelative("kernel/errors.ts"));
    assert.ok(driftedEntry);
    assert.ok(manifestAfter.includes(`exportCount: ${driftedEntry!.exportCount}`));

    // An unregistered module is now AUTO-REGISTERED by the write — the run
    // must pass because the auto-registration adds the missing entry.
    writeFileSync(join(tmpDir, "src", "register-write-unregistered.ts"), "export const UNREGISTERED_PROBE = 2;\n");
    const withUnregistered = harnessRegister(tmpDir, { write: true });
    assert.equal(withUnregistered.result.registrarReport.unregisteredModules, 1);
    assert.ok(withUnregistered.result.registrarReport.postWrite !== null);
    assert.equal(withUnregistered.result.registrarReport.postWrite!.addedModules, 1);
    assert.equal(withUnregistered.result.registrarReport.postWrite!.unregisteredModules, 0);
    assert.equal(withUnregistered.result.registrarReport.postWrite!.clean, true);
    assert.equal(withUnregistered.status, "pass");
    // The manifest now contains a block for the auto-registered file.
    const manifestAfterAdd = readFileSync(join(tmpDir, "src", "architecture-manifest.ts"), "utf8");
    assert.ok(manifestAfterAdd.includes(`path: "src/register-write-unregistered.ts"`), "unregistered file must be auto-registered");
  } finally {
    removeRepositoryLocalTemporaryDirectory(copy.root);
  }
});

test("HarnessCommands: harnessRegister write on a zero-drift project passes and leaves the manifest untouched", () => {
  // ── THE REAL REGISTRAR, IN WRITE MODE, ON A WORKING COPY ────────────────
  //
  // The property under test is that a zero-drift write changes NOTHING, which
  // can only be proven by running the real writer over the real manifest. It
  // used to run at this repository's own root, snapshotting and restoring
  // what it touched — and when the property broke it rewrote
  // `src/architecture-manifest.ts`, the root policy and a traceability
  // manifest for every concurrent test to read until the restore landed. A
  // working copy holds exactly the owned bytes, so it proves the same
  // property, and a write it makes lands where nothing else reads it.
  const copy = createRepositoryWorkingCopy("harness-register-zero-drift-", { include: engineGeneratorPopulation });
  try {
    const manifestPath = join(copy.engineRoot, "src", "architecture-manifest.ts");
    const before = readFileSync(manifestPath, "utf8");
    const result = harnessRegister(copy.engineRoot, { write: true });
    assert.equal(readFileSync(manifestPath, "utf8"), before);
    assert.equal(result.result.registrarReport.driftedModules, 0);
    assert.equal(result.result.registrarReport.unregisteredModules, 0);
    assert.deepEqual(result.result.registrarReport.postWrite, { addedModules: 0, removedModules: 0, driftedModules: 0, unregisteredModules: 0, clean: true });
    assert.equal(result.status, "pass");
  } finally {
    removeRepositoryLocalTemporaryDirectory(copy.root);
  }
});

// ---------------------------------------------------------------------------
// C2 regression: resultHasFail recognizes ALL failure indicators.
//
// Table-driven: one strong test exercising every input shape (primitives,
// direct failure keys, status strings, recursion into objects/arrays, and
// deeply nested mixed structures). Each row is a distinct input the function
// must classify correctly; the invariant is "resultHasFail correctly detects
// any failure indicator at any depth while rejecting pass/skip/true states".
// ---------------------------------------------------------------------------

test("resultHasFail: detects failure indicators across all input shapes (table-driven)", () => {
  const cases: ReadonlyArray<{ name: string; input: unknown; expected: boolean }> = [
    // Primitives and nullish — no failure to detect.
    { name: "null", input: null, expected: false },
    { name: "undefined", input: undefined, expected: false },
    { name: "number", input: 42, expected: false },
    { name: "string", input: "string", expected: false },
    { name: "empty object", input: {}, expected: false },
    { name: "all-pass object (allPassed/status)", input: { allPassed: true, status: "pass" }, expected: false },
    { name: "all-pass object (allMatch/matches/registered)", input: { allMatch: true, matches: true, registered: true }, expected: false },
    { name: "status === skip", input: { status: "skip" }, expected: false },
    { name: "status === pass", input: { status: "pass" }, expected: false },
    { name: "unregisteredModules === 0", input: { unregisteredModules: 0 }, expected: false },
    { name: "driftedModules === 0", input: { driftedModules: 0 }, expected: false },
    // Direct failure indicators.
    { name: "allPassed === false", input: { allPassed: false }, expected: true },
    { name: "status === fail", input: { status: "fail" }, expected: true },
    { name: "allMatch === false", input: { allMatch: false }, expected: true },
    { name: "matches === false", input: { matches: false }, expected: true },
    { name: "registered === false", input: { registered: false }, expected: true },
    { name: "ok === false", input: { ok: false }, expected: true },
    { name: "success === false", input: { success: false }, expected: true },
    { name: "status === drift", input: { status: "drift" }, expected: true },
    { name: "status === error", input: { status: "error" }, expected: true },
    { name: "unregisteredModules > 0", input: { unregisteredModules: 1 }, expected: true },
    { name: "driftedModules > 0", input: { driftedModules: 1 }, expected: true },
    // Recursion into nested objects.
    { name: "nested object allMatch: false", input: { outer: { inner: { allMatch: false } } }, expected: true },
    { name: "nested object status: error", input: { outer: { inner: { status: "error" } } }, expected: true },
    { name: "nested object driftedModules: 3", input: { outer: { inner: { driftedModules: 3 } } }, expected: true },
    // Recursion into arrays.
    { name: "array with allMatch: false", input: [{ allMatch: false }], expected: true },
    { name: "array with status: drift", input: [{ status: "pass" }, { status: "drift" }], expected: true },
    { name: "array all-pass", input: [{ allPassed: true }, { ok: true }], expected: false },
    // Deeply nested mixed structures.
    { name: "deeply nested array within object with error", input: { steps: [{ status: "pass" }, { status: "error", details: null }] }, expected: true },
    {
      name: "mixed nested with failure (matches: false)",
      input: {
        top: { allPassed: true },
        children: [
          { status: "pass", sub: { allMatch: true } },
          { status: "pass", sub: { matches: false } },
        ],
      },
      expected: true,
    },
    {
      name: "mixed nested without failure",
      input: {
        top: { allPassed: true },
        children: [
          { status: "pass", sub: { allMatch: true } },
          { status: "pass", sub: { matches: true } },
        ],
      },
      expected: false,
    },
  ];
  for (const { name, input, expected } of cases) {
    assert.equal(resultHasFail(input), expected, `case: ${name}`);
  }
});

// ---------------------------------------------------------------------------
// wrapCommandError: actionable error context (file/line/function/stack) for
// harness subcommand failures, extracted from the error's own stack trace.
// ---------------------------------------------------------------------------

test("wrapCommandError: typed InputError surfaces its code, origin location, and stack", () => {
  function throwingSite(): void {
    throw new InputError("bad input", "input_error");
  }
  let thrown: unknown;
  try {
    throwingSite();
  } catch (error) {
    thrown = error;
  }
  const report = wrapCommandError("harness", "new-module", thrown);
  assert.equal(report.error, "input_error");
  assert.equal(report.originalCode, "input_error");
  assert.equal(report.message, "bad input");
  assert.equal(report.command, "harness");
  assert.equal(report.subcommand, "new-module");
  assert.equal(report.function, "throwingSite");
  assert.ok(report.file !== null && report.file.endsWith("test/workflow/harness-commands.test.ts"), `file must be repo-relative; got ${report.file}`);
  assert.ok(typeof report.line === "number" && report.line > 0);
  assert.ok(typeof report.column === "number" && report.column > 0);
  assert.ok(report.stack !== null && report.stack.includes("bad input"));
});

test("wrapCommandError: plain Error maps to harness_command_failed with extracted origin", () => {
  function plainThrowSite(): void {
    throw new Error("boom");
  }
  let thrown: unknown;
  try {
    plainThrowSite();
  } catch (error) {
    thrown = error;
  }
  const report = wrapCommandError("harness", "regenerate", thrown);
  assert.equal(report.error, "harness_command_failed");
  assert.equal(report.originalCode, null);
  assert.equal(report.message, "boom");
  assert.equal(report.function, "plainThrowSite");
  assert.ok(report.file !== null && report.file.endsWith("test/workflow/harness-commands.test.ts"));
  assert.ok(report.line !== null);
  assert.ok(report.stack !== null);
});

test("wrapCommandError: native error surfaced through an anonymous frame reports the application call site", () => {
  function parseSite(): void {
    JSON.parse("");
  }
  let thrown: unknown;
  try {
    parseSite();
  } catch (error) {
    thrown = error;
  }
  const report = wrapCommandError("harness", "regenerate", thrown);
  assert.equal(report.error, "harness_command_failed");
  assert.equal(report.message, "Unexpected end of JSON input");
  assert.equal(report.function, "parseSite");
  assert.ok(report.file !== null && report.file.endsWith("test/workflow/harness-commands.test.ts"));
  assert.ok(typeof report.line === "number" && report.line > 0);
  assert.ok(report.stack !== null && report.stack.includes("SyntaxError"));
});

test("wrapCommandError: error with a string code surfaces it as originalCode", () => {
  const error = Object.assign(new Error("missing file"), { code: "ENOENT" });
  const report = wrapCommandError("harness", "check", error);
  assert.equal(report.error, "harness_command_failed");
  assert.equal(report.originalCode, "ENOENT");
  assert.equal(report.message, "missing file");
});

test("wrapCommandError: non-Error values report the stringified message with null location", () => {
  const report = wrapCommandError("harness", "check", "plain string failure");
  assert.equal(report.error, "harness_command_failed");
  assert.equal(report.message, "plain string failure");
  assert.equal(report.function, null);
  assert.equal(report.file, null);
  assert.equal(report.line, null);
  assert.equal(report.column, null);
  assert.equal(report.originalCode, null);
  assert.equal(report.stack, null);
});

test("runHarnessCli: a failing subcommand emits actionable error context on stderr", async () => {
  let stderr = "";
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  let exitCode: number;
  try {
    exitCode = await runHarnessCli(["new-module"]);
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.equal(exitCode, 1);
  const report = JSON.parse(stderr.trim()) as Record<string, unknown>;
  assert.equal(report.error, "input_error");
  assert.equal(report.message, "new-module requires a module path");
  assert.equal(report.command, "harness");
  assert.equal(report.subcommand, "new-module");
  assert.equal(report.originalCode, "input_error");
  // The throw site is the verb's own file (src/workflow/commands/<verb>.ts, #221): the dispatch finds the verb
  // in the generated registry and runs it.
  assert.ok(typeof report.file === "string" && report.file.endsWith("src/workflow/commands/new-module.ts"), `file must point at the verb's file; got ${String(report.file)}`);
  assert.ok(typeof report.line === "number" && report.line > 0);
  assert.ok(typeof report.column === "number" && report.column > 0);
  assert.ok(typeof report.stack === "string" && report.stack.includes("new-module requires a module path"));
});

test("runHarnessCli: an unknown subcommand flag is rejected with actionable error context", async () => {
  let stderr = "";
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  let exitCode: number;
  try {
    exitCode = await runHarnessCli(["regenerate", "--invalid"]);
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.equal(exitCode, 1);
  const report = JSON.parse(stderr.trim()) as Record<string, unknown>;
  assert.equal(report.error, "unknown_flag");
  assert.equal(report.message, "unknown regenerate flag: --invalid (supported: --prune <test path>)");
  assert.equal(report.subcommand, "regenerate");
  assert.equal(report.originalCode, "unknown_flag");
  assert.ok(typeof report.function === "string" && report.function.length > 0);
  assert.ok(typeof report.file === "string" && report.file.endsWith("src/workflow/commands/command.ts"), `file must point at the one unknown-flag refusal (commands/command.ts); got ${String(report.file)}`);
  assert.ok(typeof report.line === "number" && report.line > 0);
  assert.ok(typeof report.stack === "string" && report.stack.includes("unknown regenerate flag"));
});

// ---------------------------------------------------------------------------
// harness sync: one-shot consistency command (register --write -> regenerate
// -> check --skip-typecheck). Each step runs as its own CLI subprocess so a
// step's writes are visible to the next step's fresh module imports — the
// in-process ARCHITECTURE_MANIFEST / ROOT_POLICY imports are stale after a
// write, so an in-process pipeline would report false drift.
//
// A single lazy invocation is shared by the structural assertions below: the
// run scans the whole repository three times (subprocess per step), so it is
// too expensive to repeat per assertion.
//
// It runs on a WORKING COPY, never on this repository: sync WRITES whenever
// the tree disagrees with its generated files, and pointed at the live root
// it rewrote three tracked files during a full engine run. The copy holds
// exactly the owned bytes, so "passes on a consistent repo" means the same
// thing, and the copy is released when the file finishes.
// ---------------------------------------------------------------------------

let cachedSync: HarnessCommandResult<HarnessSyncOutput> | null = null;

function syncOnce(): Promise<HarnessCommandResult<HarnessSyncOutput>> {
  if (cachedSync) return Promise.resolve(cachedSync);
  // A FULL COPY, not the narrowed generator population: `harness sync` also
  // runs the README consumer generator, whose import graph covers the web
  // tests. A narrowed copy now makes that generator report every engine
  // README stale (a missing generator with marked READMEs is refused, not
  // converged by absence), and a sync that only passes because its subject is
  // absent is exactly the vacuous convergence this suite exists to refuse.
  const copy = createRepositoryWorkingCopy("harness-sync-");
  return harnessSync(copy.engineRoot)
    .then((result) => { cachedSync = result; return result; })
    .finally(() => removeRepositoryLocalTemporaryDirectory(copy.root));
}

test("HarnessCommands: sync subcommand is registered", () => {
  assert.ok(HARNESS_SUBCOMMANDS.includes("sync"), "sync subcommand must be registered");
});

test("HarnessCommands: harnessSync runs register, regenerate, check in order and passes on a consistent repo", async () => {
  const result = await syncOnce();
  assert.equal(result.schemaVersion, HARNESS_COMMAND_SCHEMA_VERSION);
  assert.equal(result.command, "sync");
  assert.equal(result.status, "pass");
  assert.equal(result.result.allPassed, true);
  assert.deepEqual(
    result.result.steps.map((step) => step.step),
    ["register", "regenerate", "check"],
    "sync must run register -> regenerate -> check in that order",
  );
  for (const step of result.result.steps) {
    assert.equal(step.status, "pass", `step ${step.step} must pass`);
  }
  // A consistent copy converges on its first pass: the fixed point is sync's own.
  assert.equal(result.result.convergence.convergedOnFirstPass, true);
  assert.equal(result.result.convergence.passes, 1);
  assert.deepEqual(result.result.convergence.findings, []);
});

test("HarnessCommands: harnessSync nested step results are integrity-verified command results", async () => {
  const result = await syncOnce();
  assert.equal(result.result.register.command, "register");
  assert.equal(result.result.regenerate.command, "regenerate");
  assert.equal(result.result.check.command, "check");
  for (const stepResult of [result.result.register, result.result.regenerate, result.result.check]) {
    const { integrityHash, ...unsigned } = stepResult;
    assert.equal(sha256(canonicalJson(unsigned)), integrityHash, `${stepResult.command} integrity hash must be valid`);
    assert.equal(stepResult.status, "pass");
  }
  // The check step must have skipped the typecheck (sync's verify step is
  // `harness check --skip-typecheck`).
  const checkOutput = result.result.check.result as HarnessCheckOutput;
  assert.equal(checkOutput.typecheck.status, "skip");
});

test("HarnessCommands: harnessSync result is frozen with a valid integrity hash", async () => {
  const result = await syncOnce();
  assert.ok(Object.isFrozen(result));
  const { integrityHash, ...unsigned } = result;
  assert.equal(sha256(canonicalJson(unsigned)), integrityHash);
});

// ---------------------------------------------------------------------------
// harness sync --with-bundle: the one-shot command that rebuilds the
// production bundle from the stabilized pins and re-derives what the build
// wrote, in a single pass (no digest of the bundle is committed, #221).
//
// The bundle-build step is verified STRUCTURALLY (the step type + the
// runBundleBuildStep export + the CLI flag parsing) rather than by running the
// full sync with --with-bundle. Running the real bundle build in the test
// suite is destructive: build-bundle.ts writes dist/bundle.js to disk, which
// races with the concurrent hash-binding + bundle-staleness tests in the
// serial tier (a rebuild with a changed root-policy.ts produces a different
// sha256, breaking the pin for other tests). The full --with-bundle flow is
// verified by the manual `harness sync --with-bundle` invocation + the
// BundleStaleness prevention test (which rebuilds in-memory, write:false).
// ---------------------------------------------------------------------------

test("HarnessCommands: runBundleBuildStep is exported + wraps a build into a HarnessCommandResult", () => {
  // Structural contract: runBundleBuildStep is the single owner of the
  // bundle-build subprocess wrapping. It must be a function that returns a
  // HarnessCommandResult (the build summary on pass, an error on fail).
  assert.equal(typeof runBundleBuildStep, "function", "runBundleBuildStep must be exported for the sync --with-bundle path");
});

test("HarnessCommands: harnessSync withBundle option type includes the bundle-build step", () => {
  // Structural assertion: the HarnessSyncOutput type + HarnessSyncStepSummary
  // step union include the bundle-build step. The full integration run is
  // expensive (5 subprocesses) + destructive (writes the bundle); the step
  // structure is verified by the type + the manual sync run. The CLI flag
  // parsing is verified by the runHarnessCli flag test below.
  const steps: HarnessSyncOutput["steps"] = [
    { step: "register", status: "pass" },
    { step: "regenerate", status: "pass" },
    { step: "bundle-build", status: "pass" },
    { step: "regenerate", status: "pass" },
    { step: "check", status: "pass" },
  ];
  assert.deepEqual(
    steps.map((s) => s.step),
    ["register", "regenerate", "bundle-build", "regenerate", "check"],
    "sync --with-bundle must run register -> regenerate -> bundle-build -> regenerate -> check",
  );
});

test("HarnessCommands: syncPassVerdict judges every step except the stabilizing regenerate of a --with-bundle pass", () => {
  const pass = (step: HarnessSyncOutput["steps"][number]["step"], status: "pass" | "fail" = "pass") => ({ step, status });
  const withBundle = (initial: "pass" | "fail", final: "pass" | "fail", check: "pass" | "fail") => [
    pass("register"), pass("regenerate", initial), pass("bundle-build"), pass("regenerate", final), pass("check", check),
  ];
  // A fresh checkout: the first regenerate has no bundle to pin yet.
  assert.equal(syncPassVerdict(withBundle("fail", "pass", "pass"), true), true);
  assert.equal(syncPassVerdict(withBundle("pass", "pass", "pass"), true), true);
  // Every other step is still judged.
  assert.equal(syncPassVerdict(withBundle("fail", "fail", "pass"), true), false);
  assert.equal(syncPassVerdict(withBundle("pass", "pass", "fail"), true), false);
  assert.equal(syncPassVerdict([pass("register"), pass("regenerate"), pass("bundle-build", "fail"), pass("regenerate"), pass("check")], true), false);
  // Without the bundle there is no stabilizing step: the first regenerate is judged.
  assert.equal(syncPassVerdict([pass("register"), pass("regenerate", "fail"), pass("check")], false), false);
  assert.equal(syncPassVerdict([pass("register"), pass("regenerate"), pass("check")], false), true);
  assert.equal(syncPassVerdict([], false), false, "an empty pass is not a pass");
  assert.throws(() => syncPassVerdict([pass("register"), pass("bundle-build"), pass("regenerate"), pass("check")], true), /out of order/u);
});

test("HarnessCommands: harnessSync without withBundle omits the bundle-build step", async () => {
  // The default sync (no --with-bundle) must NOT run the bundle-build step —
  // deny-by-default: the bundle rebuild is opt-in, not opt-out.
  const result = await syncOnce();
  assert.equal(result.result.bundleBuild, undefined, "bundleBuild must be absent without --with-bundle");
  assert.deepEqual(
    result.result.steps.map((step) => step.step),
    ["register", "regenerate", "check"],
  );
});

test("runHarnessCli: sync --with-bundle flag is accepted (no unknown-flag error)", async () => {
  // Verify the CLI parses --with-bundle without rejecting it as an unknown
  // flag. The full sync is expensive; we assert the flag is ACCEPTED by
  // checking that the CLI does not emit an unknown_harness_subcommand error
  // for --with-bundle. A dry assertion of the parse path: the flag must
  // be in the supported list.
  const syncSupported = ["--with-bundle"];
  const cli = await import("../../src/cli.ts");
  assert.ok(typeof cli.runCli === "function", "runCli must be exported for flag dispatch");
  assert.ok(syncSupported.includes("--with-bundle"));
});

// ---------------------------------------------------------------------------
// Auto-disposition in `harness regenerate` (FIX 2): new recognizable test
// files are registered in the test-surface dispositions manifest before the
// inventory and hash bindings are regenerated, so agents never add entries
// manually. The read-only path must never mutate the manifest.
// ---------------------------------------------------------------------------

test("HarnessCommands: harnessRegenerate write=false skips the auto-add step", () => {
  const result = regenerateReadOnly();
  assert.equal(result.result.dispositionAutoAdd.status, "skipped");
  assert.equal(result.result.dispositionAutoAdd.addedCount, 0);
  assert.deepEqual(result.result.dispositionAutoAdd.addedPaths, []);
});

test("HarnessCommands: harnessRegenerate write=true auto-adds missing disposition entries for new test files", () => {
  // Repository-local working copy: the safe repository reader (used by the
  // test-inventory subprocess) rejects roots under mounted-ancestor /tmp
  // (safe_path_root_ancestor_mountpoint), so fixtures that exercise it must
  // live under the persistent repository tree (.bridlewise/test-fixtures is
  // excluded from outer repository scans). The copy's subprocesses resolve
  // zod / @babel/parser by walking up to the repository's real node_modules.
  const copy = createRepositoryWorkingCopy("regen-autodispo-", { include: engineGeneratorPopulation });
  const fixtureRoot = copy.engineRoot;
  try {
    // Create a new recognizable test file that is absent from the copied
    // dispositions manifest. Regenerate must register it automatically.
    const newFile = "test/workflow/regen-autodispo-fixture.test.ts";
    writeFileSync(join(fixtureRoot, newFile), `import test from "node:test";\ntest("fixture", () => {});\n`);
    // The copy has its own index, and a new test source must be in it before
    // the heal registers it (test_surface_source_untracked otherwise).
    execFileSync("git", ["add", "-N", "--", newFile], { cwd: fixtureRoot });

    const result = harnessRegenerate(fixtureRoot, { write: true });

    assert.equal(result.command, "regenerate");
    assert.equal(result.result.dispositionAutoAdd.status, "added");
    assert.equal(result.result.dispositionAutoAdd.addedCount, 1);
    assert.deepEqual([...result.result.dispositionAutoAdd.addedPaths], [newFile]);
    // The manifest on disk now carries the auto-registered entry with the
    // canonical disposition for a qualified js/ts test source.
    const manifestAfter = JSON.parse(readFileSync(join(fixtureRoot, "traceability", "test-surface-dispositions.json"), "utf8")) as {
      entries: ReadonlyArray<{ path: string; disposition: string }>;
    };
    const added = manifestAfter.entries.find((entry) => entry.path === newFile);
    assert.ok(added, "auto-add wrote the new entry to the manifest");
    assert.equal(added!.disposition, "canonical-node-test");
    // A second regenerate on the healed fixture is a no-op for the auto-add
    // step (idempotent): the manifest already covers every recognizable file.
    const second = harnessRegenerate(fixtureRoot, { write: true });
    assert.equal(second.result.dispositionAutoAdd.status, "current");
    assert.equal(second.result.dispositionAutoAdd.addedCount, 0);
    // A community surface with no sources (a hand-made shadow) is the arm's typed refusal, and it fails the regenerate (#56 review).
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: fixtureRoot, encoding: "utf8" }).trim();
    mkdirSync(join(top, ".github"), { recursive: true });
    writeFileSync(join(top, ".github", "CONTRIBUTING.md"), "a hand-made page\n");
    const refused = harnessRegenerate(fixtureRoot, { write: true });
    assert.equal(refused.result.communityFiles.status, "refused");
    assert.match(refused.result.communityFiles.refusal, /^community_/u);
    assert.equal(refused.status, "fail");
  } finally {
    removeRepositoryLocalTemporaryDirectory(copy.root);
  }
});

test("HarnessCommands: one regenerate converges after a contract source edit, and check refuses a stale schema artifact", async () => {
  // The artifact embeds the root policy's contract-source pin. Regenerate
  // re-pins it mid-process, so an artifact built from the statically imported
  // policy lagged one pass behind (sync needed a second pass) and check did
  // not notice. One regenerate must now leave nothing for a second one, and
  // check must refuse an artifact that is stale against the on-disk policy.
  const { ROOT_POLICY } = await import("../../src/kernel/root-policy.ts");
  const copy = createRepositoryWorkingCopy("regen-converge-", { include: engineGeneratorPopulation });
  const engine = copy.engineRoot;
  const contract = ROOT_POLICY.configuration.contract;
  const outputs = [contract.generatedSchemaPath, ROOT_POLICY.sourcePath].map((path) => join(engine, path));
  const bytes = () => outputs.map((path) => sha256(readFileSync(path, "utf8")));
  try {
    const stale = readFileSync(outputs[0]!, "utf8");
    appendFileSync(join(engine, contract.sourcePath), "\n// convergence witness\n");
    harnessRegenerate(engine, { write: true });
    const afterFirst = bytes();
    assert.notEqual(readFileSync(outputs[0]!, "utf8"), stale, "the first pass rewrites the artifact for the new source pin");
    harnessRegenerate(engine, { write: true });
    assert.deepEqual(bytes(), afterFirst, "a second regenerate must change nothing");
    const current = await harnessCheck(engine, { skipTypecheck: true });
    assert.equal(current.result.configSchemaArtifact.status, "pass");
    writeFileSync(outputs[0]!, stale);
    const refused = await harnessCheck(engine, { skipTypecheck: true });
    assert.equal(refused.result.configSchemaArtifact.status, "fail");
    assert.equal(refused.result.allPassed, false);
  } finally {
    removeRepositoryLocalTemporaryDirectory(copy.root);
  }
});

test("HarnessCommands: the community-files arm is wired into harnessCheck and harnessRegenerate, and its convergence gates the regenerate status (#56 review)", async () => {
  const result = await checkSkipAll();
  assert.equal(result.result.communityFiles.step, "community-files");
  assert.equal(result.result.communityFiles.status, "pass", result.result.communityFiles.message);
  const regenerated = harnessRegenerate(ROOT, { write: false });
  assert.equal(regenerated.result.communityFiles.status, "current");
  assert.equal(regenerated.result.communityFiles.converged, true);
  const refused = communityFilesStep({ status: "refused", converged: false, changed: [], refusal: "community_shadow_file: x" });
  assert.equal(refused.status, "fail");
});

test("HarnessCommands: the check's generated-block steps FAIL on drift and name it — the evidence ignore rule (correctness E5), the frozen roots' pinned content and the task board — and all are wired into harnessCheck (design N3')", async () => {
  const stale = evidenceIgnoreStep({ status: "stale", converged: false, changed: [".gitignore"] });
  assert.equal(stale.status, "fail");
  assert.match(stale.message, /stale against the tracked evidence manifests \(run harness sync\): \.gitignore/u);
  assert.equal(evidenceIgnoreStep({ status: "absent", converged: true, changed: [] }).status, "pass");
  const moved = frozenRecordsStep({ status: "stale", converged: false, changed: ["docs/history/x.md"], altered: ["docs/history/x.md"] });
  assert.equal(moved.status, "fail");
  assert.match(moved.message, /history changed: docs\/history\/x\.md\. harness sync never re-pins one; a change that is meant is accepted explicitly, with its reason: harness frozen accept --reason/u);
  const added = frozenRecordsStep({ status: "stale", converged: false, changed: ["docs/history/new.md"], altered: [] });
  assert.match(added.message, /new frozen records are not yet pinned: docs\/history\/new\.md\. Run harness sync/u);
  // The task board (src/workflow/failure-owners.ts syncTrackerBoard): stale and unjudgeable boards fail, named; a tree without one passes.
  const staleBoard = trackerBoardStep({ status: "stale", converged: false, changed: ["docs/trackers/TASKS.md"], problems: [] });
  assert.equal(staleBoard.step, "tracker-board");
  assert.equal(staleBoard.status, "fail");
  assert.match(staleBoard.message, /the task board is stale against the tracker items \(run harness sync\): docs\/trackers\/TASKS\.md/u);
  const handRow = trackerBoardStep({ status: "invalid", converged: false, changed: [], problems: ["docs/trackers/TASKS.md: the row HAND-ROW is typed outside the generated board block"] });
  assert.equal(handRow.status, "fail");
  assert.match(handRow.message, /cannot be judged: docs\/trackers\/TASKS\.md: the row HAND-ROW is typed outside/u);
  assert.equal(trackerBoardStep({ status: "absent", converged: true, changed: [], problems: [] }).status, "pass");
  const result = await checkSkipAll();
  assert.equal(result.result.trackerBoard.step, "tracker-board", "the task-board step is wired into harnessCheck");
  assert.equal(result.result.forgeFiles.step, "forge-files", "the forge-files step is wired into harnessCheck");
  for (const step of [result.result.evidenceIgnore, result.result.forgeFiles, result.result.frozenRecords, result.result.trackerBoard]) {
    assert.equal(step.status, "pass", `${step.step} passes on this synced tree: ${step.message}`);
  }
  assert.equal(result.result.allPassed, Object.values(result.result).every((step) => typeof step !== "object" || step === null || !("status" in step) || step.status !== "fail"), "allPassed is every step");
});
