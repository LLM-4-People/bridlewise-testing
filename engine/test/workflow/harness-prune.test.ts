/**
 * A DELIBERATE TEST DELETION IS NAMED, AND THE REFUSAL SAYS HOW.
 *
 * `harness regenerate`/`sync` refuse to shrink the test surface silently
 * (`test_surface_prune_refused`): a directory rename looks exactly like a
 * mass deletion. Two defects made the refusal useless in practice (SEC round):
 *
 *   A. the typed refusal was lost: the subprocess boundary reported the LAST
 *      stderr line, which was a Node warning, so `harness sync` said "failed
 *      without a status payload" — now the typed record is found and passed
 *      through with its own code;
 *   B. there was no way through: the only escape was a blanket
 *      `--allow-prune` the sync never forwarded — now each deleted test is
 *      named (`--prune <path>`), a present file cannot be pruned, and an
 *      unnamed stale path is still refused.
 *
 * Driven in a working copy (never the live checkout).
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { FRONT_DOOR_GENERATOR, VERIFICATION_PATHS } from "../../src/kernel/verification-paths.ts";

import { GENERATOR_INPUTS_BEYOND_ENGINE, harnessRegenerate, harnessRegister } from "../../src/workflow/harness-commands.ts";
import { stageInCopy } from "../../src/git/working-copy.ts";
import { trackedFiles } from "../../src/git/repository-ownership.ts";
import { reachabilityClosure } from "../../src/workflow/reachability.ts";
import { frontDoorGeneratorModules } from "../../src/workflow/messaging.ts";
import { createRepositoryWorkingCopy, engineGeneratorPopulation, removeRepositoryLocalTemporaryDirectory } from "../support/repository-local-temporary.ts";
import { createTempDir } from "../support/temp-dir.ts";

/** A recorded exception (a pending source): deleting it is a decision that must be named. A canonical-by-default test has no entry to prune. */
const DELETED = "test/shared-memory/shared-memory.test.ts";

test("a generator test's repository copy carries every path an arm declares it needs, derived from the arms' own declarations", () => {
  // The forge arm refuses without its community sources, its workflows and every lockfile root (it read them since #123, and
  // a hand-listed population went red): the population is DERIVED from GENERATOR_INPUTS_BEYOND_ENGINE, never listed.
  for (const path of ["docs/community/intake.json", "docs/community/roles.json", ".github/workflows/ci.yml", "package-lock.json", ".github/CODEOWNERS", "CONTRIBUTING.md", "engine/src/cli.ts", "shared/markup.ts", VERIFICATION_PATHS.architectureJudgeBaseline, "docs/brand/messaging.json", "docs/brand/claims.json", "tests/public/cli.test.mjs"]) {
    assert.equal(engineGeneratorPopulation(path), true, path);
  }
  // Near misses: the web tree no generator reads stays out.
  for (const path of ["src/main.ts", "server/index.ts", "docs/floor/roadmap.md", "tests/unit/x.test.ts"]) assert.equal(engineGeneratorPopulation(path), false, path);
  // Every arm that declares inputs is honoured: each declared path of each arm is in the population.
  for (const [arm, input] of Object.entries(GENERATOR_INPUTS_BEYOND_ENGINE)) {
    if (input === null) continue;
    assert.ok(["docs/community/intake.json", ".github/workflows/ci.yml", "package-lock.json", "CONTRIBUTING.md", VERIFICATION_PATHS.architectureJudgeBaseline, "docs/brand/messaging.json"].some((path) => input(path) && engineGeneratorPopulation(path)), arm);
  }
});

test("the front-door arm's copy carries every module its generator reaches, derived from the generator's own imports (a hand list went stale)", () => {
  // scripts/brand/claims.ts came to import scripts/floor/status.mjs (and it scripts/floor/files.mjs): the hand-listed
  // generator modules missed them, and every generator test's copy failed with ERR_MODULE_NOT_FOUND in CI.
  const reached = reachabilityClosure({
    entryPoints: [`engine/${FRONT_DOOR_GENERATOR.generator}`],
    files: trackedFiles(join(import.meta.dirname, "..", "..", "..")) ?? [],
    readTexts: (paths) => new Map(paths.map((path) => [path, readFileSync(join(import.meta.dirname, "..", "..", "..", path), "utf8")])),
  });
  const beyond = [...reached.closure].filter((path) => !path.startsWith("engine/") && !path.startsWith("shared/"));
  assert.ok(beyond.includes("scripts/floor/status.mjs") && beyond.includes("scripts/floor/files.mjs"), `the generator reaches the floor modules (liveness): ${beyond.join(", ")}`);
  for (const path of beyond) assert.equal(engineGeneratorPopulation(path), true, `${path} is a module the front-door generator loads`);
});

test("the front-door generator's modules are derived or refused, never guessed: an unreadable tracked set and an import the walk cannot follow refuse by name", () => {
  const root = createTempDir("front-door-modules-");
  const write = (path: string, text: string): void => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const generator = `engine/${FRONT_DOOR_GENERATOR.generator}`;
  write(generator, 'import { x } from "../../../scripts/floor/present.mjs";\nexport { x };\n');
  write("scripts/floor/present.mjs", "export const x = 1;\n");
  assert.deepEqual([...frontDoorGeneratorModules(root, [generator, "scripts/floor/present.mjs"])].toSorted(), [generator, "scripts/floor/present.mjs"], "a followable import is carried (liveness)");
  assert.throws(() => frontDoorGeneratorModules(root, undefined), (error: unknown) => (error as { code?: string }).code === "front_door_generator_unreadable", "no tracked set, no empty fallback");
  write(generator, 'import { x } from "../../../scripts/floor/absent.mjs";\nexport { x };\n');
  assert.throws(() => frontDoorGeneratorModules(root, [generator, "scripts/floor/present.mjs"]), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "front_door_generator_import_unfollowed");
    assert.match((error as Error).message, /engine\/scripts\/brand\/cli\.ts imports \.\.\/\.\.\/\.\.\/scripts\/floor\/absent\.mjs, which names no file the tree holds/u);
    return true;
  });
  write(generator, "const name = 'x';\nawait import(`../../../scripts/floor/${name}.mjs`);\n");
  assert.throws(() => frontDoorGeneratorModules(root, [generator]), (error: unknown) => (error as { code?: string }).code === "front_door_generator_import_unfollowed", "a computed import from the generator refuses");
});

test("harness regenerate: a deleted test is refused with the typed code and the exact command; a named prune goes through", async () => {
  const copy = createRepositoryWorkingCopy("harness-prune-", { include: engineGeneratorPopulation });
  const nodeOptions = process.env["NODE_OPTIONS"];
  try {
    // The copy's OWN index stages the tree as it stands (never the live
    // index), through the one staging door: a raw `git add` here freshened
    // the borrowed store's packs (wf1a-correctness §5).
    stageInCopy(copy.root, ["engine", "shared"]);
    rmSync(join(copy.engineRoot, DELETED));
    // A runtime warning printed AFTER the typed refusal, in every subprocess.
    const warner = join(createTempDir("harness-prune-warning-"), "warn-last.mjs");
    writeFileSync(warner, "process.on('exit', () => process.stderr.write('(node:1) Warning: planted after the refusal\\n'));\n");
    process.env["NODE_OPTIONS"] = `${nodeOptions ?? ""} --import=${warner}`.trim();
    await assert.rejects(harnessRegenerate(copy.engineRoot, { write: true }), (error: unknown) => {
      const { code, message } = error as { code?: string; message?: string };
      assert.equal(code, "test_surface_prune_refused", String(message));
      assert.match(String(message), new RegExp(`--prune ${DELETED.replaceAll(".", "\\.")}`, "u"));
      return true;
    });
    const present = "test/shared-suite/best-effort.test.ts";
    await assert.rejects(harnessRegenerate(copy.engineRoot, { write: true, prune: [DELETED, present] }),
      (error: unknown) => (error as { code?: string }).code === "test_surface_prune_not_deleted");
    // The named prune goes through the dispositions; the pinned non-canonical set then asks to be restated by hand
    // (the conservation identity: a pin a generator can rewrite refuses nothing).
    await assert.rejects(harnessRegenerate(copy.engineRoot, { write: true, prune: [DELETED] }), /the pinned non-canonical test-source set moved/u);
    const manifest = readFileSync(join(copy.engineRoot, "traceability", "test-surface-dispositions.json"), "utf8");
    assert.equal(manifest.includes(`"${DELETED}"`), false, "the named deletion left the manifest");
  } finally {
    if (nodeOptions === undefined) delete process.env["NODE_OPTIONS"];
    else process.env["NODE_OPTIONS"] = nodeOptions;
    removeRepositoryLocalTemporaryDirectory(copy.root);
  }
});

test("harness register: a syntax error in a module is refused NAMING that module and line, never the step's entry point", () => {
  const copy = createRepositoryWorkingCopy("harness-syntax-", { include: engineGeneratorPopulation });
  try {
    const module = join(copy.engineRoot, "src", "evaluation", "matrix-generator.ts");
    const lines = readFileSync(module, "utf8").split("\n");
    const at = lines.findIndex((line) => line.startsWith("export function"));
    lines.splice(at + 1, 0, '  import planted from "planted";');
    writeFileSync(module, lines.join("\n"));
    assert.throws(() => harnessRegister(copy.engineRoot, { write: false }), (error: unknown) => {
      const { code, message } = error as { code?: string; message?: string };
      assert.equal(code, "source_syntax_invalid", String(message));
      assert.match(String(message), new RegExp(`src/evaluation/matrix-generator\\.ts:${String(at + 2)}:`, "u"), "the refusal names the file and line");
      assert.doesNotMatch(String(message), /^src\/cli\.ts:/u, "the step's entry point is not presented as the location");
      return true;
    });
  } finally {
    removeRepositoryLocalTemporaryDirectory(copy.root);
  }
});
