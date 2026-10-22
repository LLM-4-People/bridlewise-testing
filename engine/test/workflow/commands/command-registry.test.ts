/**
 * THE VERB REGISTRY IS DERIVED (#221): every module of src/workflow/commands/
 * IS a verb, found by location and judged by the value it exports, and
 * `harness-verbs.ts` is that folder's generated listing. A verb can never
 * vanish while every test stays green: a module that exports no
 * HarnessCommand is a typed refusal, and the registry equals the folder.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { HARNESS_COMMANDS } from "../../../src/workflow/harness-verbs.ts";
import { COMMAND_REGISTRY_PATH, COMMANDS_FOLDER, commandRegistryText, declaredVerbs, syncCommandRegistry } from "../../../scripts/verification/command-registry.ts";
import { harnessCheck, harnessRegenerate, HARNESS_SUBCOMMANDS } from "../../../src/workflow/harness-commands.ts";
import { createTempDir } from "../../support/temp-dir.ts";
import { createRepositoryWorkingCopy, engineGeneratorPopulation, removeRepositoryLocalTemporaryDirectory } from "../../support/repository-local-temporary.ts";

const ENGINE = join(import.meta.dirname, "..", "..", "..");
const FOLDER = join(ENGINE, COMMANDS_FOLDER);

/** A scratch folder of ES modules, as the engine's own (its package.json declares the type). */
function moduleFolder(prefix: string): string {
  const folder = createTempDir(prefix);
  writeFileSync(join(folder, "package.json"), '{ "type": "module" }\n');
  return folder;
}

const verbModule = (verb: string, exportName = "COMMAND", typed = true): string =>
  [`export const ${exportName}${typed ? ": { verb: string; run: () => Promise<unknown> }" : ""} = {`, `  verb: "${verb}",`, "  run: async () => ({ result: null }),", "};", ""].join("\n");

test("the registry IS the commands folder: one verb per module, the CLI's verbs, its generator's bytes", async () => {
  // `declaredVerbs` reads EVERY module of the folder and refuses one that is not a verb, so its answer is the folder.
  const modules = await declaredVerbs(FOLDER);
  assert.ok(modules.length >= 20, `the verb population collapsed to ${String(modules.length)}`);
  assert.deepEqual(HARNESS_COMMANDS.map((command) => command.verb), modules, "every module of the folder is a registered verb, and nothing else is");
  assert.deepEqual([...HARNESS_SUBCOMMANDS], modules, "the CLI's verbs are the registry's");
  assert.equal(readFileSync(join(ENGINE, COMMAND_REGISTRY_PATH), "utf8"), commandRegistryText(modules), "the committed registry is its generator's output");
});

test("a module is a verb by location and type: a missing, renamed or second export, or a value of another shape, is refused", async () => {
  const refused = async (files: Readonly<Record<string, string>>, pattern: RegExp): Promise<void> => {
    const folder = moduleFolder("command-registry-plant-");
    for (const [name, text] of Object.entries(files)) writeFileSync(join(folder, name), text);
    await assert.rejects(declaredVerbs(folder), (error: unknown) => (error as { code?: string }).code === "command_registry_invalid" && pattern.test((error as Error).message));
  };
  // The spelling is not the test: an unannotated declaration is still a verb when its value is one.
  const loose = moduleFolder("command-registry-loose-");
  writeFileSync(join(loose, "workspace.ts"), verbModule("workspace", "COMMAND", false));
  assert.deepEqual(await declaredVerbs(loose), ["workspace"]);
  await refused({ "workspace.ts": verbModule("workspace", "COMMANDS") }, /exports COMMANDS/u);
  await refused({ "workspace.ts": "export const unrelated = 1;\n" }, /exports unrelated/u);
  await refused({ "workspace.ts": "const COMMAND = 1;\nvoid COMMAND;\n" }, /exports nothing/u);
  await refused({ "workspace.ts": `${verbModule("workspace")}export const helper = 1;\n` }, /exports COMMAND, helper/u);
  await refused({ "workspace.ts": 'export const COMMAND = { verb: "workspace" };\n' }, /not a HarnessCommand/u);
  await refused({ "workspace.ts": verbModule("other") }, /declares the verb other/u);
  await assert.rejects(declaredVerbs(moduleFolder("command-registry-empty-")), (error: unknown) => (error as { code?: string }).code === "command_registry_invalid");
});

test("a new verb module is one import and one entry; a stale registry is refused until sync rewrites it", async () => {
  const root = moduleFolder("command-registry-");
  const folder = join(root, COMMANDS_FOLDER);
  mkdirSync(folder, { recursive: true });
  for (const verb of ["check", "sync"]) writeFileSync(join(folder, `${verb}.ts`), verbModule(verb));
  writeFileSync(join(root, COMMAND_REGISTRY_PATH), commandRegistryText(["check", "sync"]));
  assert.equal((await syncCommandRegistry(root, false)).status, "current");
  const before = readFileSync(join(root, COMMAND_REGISTRY_PATH), "utf8");
  writeFileSync(join(folder, "new-verb.ts"), verbModule("new-verb"));
  assert.deepEqual(await syncCommandRegistry(root, false), { allCurrent: false, status: "stale", changed: [COMMAND_REGISTRY_PATH], verbs: ["check", "new-verb", "sync"] });
  assert.equal((await syncCommandRegistry(root, true)).status, "written");
  const added = readFileSync(join(root, COMMAND_REGISTRY_PATH), "utf8").split("\n").filter((line) => !before.split("\n").includes(line));
  assert.deepEqual(added, ['import { COMMAND as newVerbCommand } from "./commands/new-verb.ts";', "  newVerbCommand,"], "a new verb adds its import and its entry, nothing else");
});

// THE WIRING (#372 review): `harness check` reds a stale registry (its step is never forced to pass) and `harness
// regenerate` writes it (its arm is never a check-only call).
test("harness check reds a stale verb registry, and harness regenerate rewrites it", async () => {
  const copy = createRepositoryWorkingCopy("command-registry-wiring-", { include: engineGeneratorPopulation });
  try {
    const engine = copy.engineRoot;
    const path = join(engine, COMMAND_REGISTRY_PATH);
    const registry = readFileSync(path, "utf8");
    const options = { skipTypecheck: true, skipArchitecture: true, skipInventory: true } as const;
    assert.equal((await harnessCheck(engine, options)).result.commandRegistry.status, "pass", "a fresh copy's registry is current (liveness)");
    // A registry that lost a verb: the generator's text for every verb but one.
    writeFileSync(path, commandRegistryText(HARNESS_COMMANDS.map((command) => command.verb).filter((verb) => verb !== "workspace")));
    const stale = await harnessCheck(engine, options);
    assert.equal(stale.result.commandRegistry.status, "fail", "a registry missing a verb is refused");
    const regenerated = harnessRegenerate(engine, { write: true });
    assert.equal(regenerated.result.commandRegistry.status, "written", "regenerate writes the registry");
    assert.equal(readFileSync(path, "utf8"), registry, "the registry is its generator's output again");
  } finally {
    removeRepositoryLocalTemporaryDirectory(copy.root);
  }
});
