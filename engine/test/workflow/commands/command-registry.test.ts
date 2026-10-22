/**
 * THE VERB REGISTRY IS DERIVED (#221): every verb is one file of
 * src/workflow/commands/ declaring `COMMAND`, and `registry.ts` is that
 * folder's generated listing. A new verb is one new file and one generated
 * line, so two branches that each add a verb never edit a shared hand-kept
 * list or dispatch chain.
 */
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { HARNESS_COMMANDS } from "../../../src/workflow/commands/registry.ts";
import { COMMAND_REGISTRY_FILE, COMMANDS_FOLDER, commandRegistryText, declaredVerbs, syncCommandRegistry } from "../../../src/workflow/commands/command-registry.ts";
import { HARNESS_SUBCOMMANDS } from "../../../src/workflow/harness-commands.ts";
import { createTempDir } from "../../support/temp-dir.ts";

const ENGINE = join(import.meta.dirname, "..", "..", "..");
const FOLDER = join(ENGINE, COMMANDS_FOLDER);

function verbFile(verb: string): string {
  return ['import type { HarnessCommand } from "./command.ts";', "", "export const COMMAND: HarnessCommand = {", `  verb: "${verb}",`, "  run: async () => ({ result: null as never }),", "};", ""].join("\n");
}

test("the registry lists exactly the verb files, in verb order, and the verbs are its names", () => {
  const declared = declaredVerbs(FOLDER);
  assert.ok(declared.length >= 20, `the verb population collapsed to ${String(declared.length)}`);
  assert.deepEqual(HARNESS_COMMANDS.map((command) => command.verb), declared);
  assert.deepEqual([...HARNESS_SUBCOMMANDS], declared, "the CLI's verbs are the registry's");
  assert.equal(readFileSync(join(FOLDER, COMMAND_REGISTRY_FILE), "utf8"), commandRegistryText(FOLDER), "the committed registry is its generator's output");
});

test("a new verb file is one generated line; a stale registry is refused until sync rewrites it", () => {
  const root = createTempDir("command-registry-");
  try {
    const folder = join(root, COMMANDS_FOLDER);
    mkdirSync(folder, { recursive: true });
    for (const name of ["command.ts", "check.ts", "sync.ts"]) copyFileSync(join(FOLDER, name), join(folder, name));
    writeFileSync(join(folder, COMMAND_REGISTRY_FILE), commandRegistryText(folder));
    assert.equal(syncCommandRegistry(root, false).status, "current");
    const before = readFileSync(join(folder, COMMAND_REGISTRY_FILE), "utf8");
    writeFileSync(join(folder, "new-verb.ts"), verbFile("new-verb"));
    assert.deepEqual(syncCommandRegistry(root, false), { status: "stale", converged: false, changed: [`${COMMANDS_FOLDER}/${COMMAND_REGISTRY_FILE}`] });
    assert.equal(syncCommandRegistry(root, true).status, "regenerated");
    const after = readFileSync(join(folder, COMMAND_REGISTRY_FILE), "utf8");
    const added = after.split("\n").filter((line) => !before.split("\n").includes(line));
    assert.deepEqual(added, ['import { COMMAND as newVerbCommand } from "./new-verb.ts";', "  newVerbCommand,"], "a new verb adds its import and its entry, nothing else");
    // A verb declared in a file named otherwise is refused: the file is the verb.
    writeFileSync(join(folder, "misnamed.ts"), verbFile("other"));
    assert.throws(() => syncCommandRegistry(root, false), (error: unknown) => (error as { code?: string }).code === "command_registry_invalid");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
