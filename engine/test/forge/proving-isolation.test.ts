import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { ownedFiles } from "../../src/git/repository-ownership.ts";
import { reachabilityClosure, type Reachability } from "../../src/workflow/reachability.ts";

/**
 * THE PROVING SCENARIOS NEVER RUN OFFLINE: `engine/test/forge/proving/`
 * reaches real GitHub as the agent App, so no offline test may load it —
 * not directly, not through a helper. The walk is the repository's one
 * reachability walk (`src/workflow/reachability.ts`) from every test file
 * of the tree, with the proving folder as its exclusion: any edge into it
 * is reported, never followed. Its witnesses prove a direct and a
 * transitive import are caught; its tree check proves none exists.
 */

const PROVING = "engine/test/forge/proving/";
const REPOSITORY = join(fileURLToPath(new URL("../../..", import.meta.url)));

/** The tests' entry points among `files`: every test file of the engine and root suites. */
function testEntries(files: readonly string[]): readonly string[] {
  const roots = ["engine/test/", "engine/live/", "tests/"];
  return files.filter((path) => roots.some((root) => path.startsWith(root)) && /\.test\.(ts|mts|mjs|js)$/u.test(path));
}

/** The walk from `entries` over `files`, the proving folder excluded. */
function walk(files: readonly string[], entries: readonly string[], text: (path: string) => string | null): Reachability {
  return reachabilityClosure({
    entryPoints: entries,
    files,
    readTexts: (paths) => new Map(paths.map((path) => [path, text(path)] as const)),
    isExcluded: (path) => path.startsWith(PROVING),
  });
}

test("witness: a test importing the proving folder, directly or through a helper, is caught", () => {
  const tree = new Map<string, string>([
    ["engine/test/direct.test.ts", `import { v6 } from "./forge/proving/workspace-scenarios.ts";\nvoid v6;\n`],
    ["engine/test/helper.ts", `export { provingGround } from "./forge/proving/proving-ground.ts";\n`],
    ["engine/test/transitive.test.ts", `import { provingGround } from "./helper.ts";\nvoid provingGround;\n`],
    ["engine/test/clean.test.ts", `import { mainHead } from "./forge/proving-ground-api.ts";\nvoid mainHead;\n`],
    ["engine/test/forge/proving-ground-api.ts", `export const mainHead = 1;\n`],
    ["engine/test/forge/proving/workspace-scenarios.ts", `export const v6 = 1;\n`],
    ["engine/test/forge/proving/proving-ground.ts", `export const provingGround = 1;\n`],
  ]);
  const files = [...tree.keys()];
  const reached = walk(files, testEntries(files), (path) => tree.get(path) ?? null);
  assert.deepEqual(reached.intoExcluded.map((edge) => edge.importer).toSorted(), ["engine/test/direct.test.ts", "engine/test/helper.ts"]);
  assert.ok(!reached.closure.has("engine/test/forge/proving/workspace-scenarios.ts"), "an excluded module is never entered");
});

test("no test of the tree reaches engine/test/forge/proving/, and none lives in it", () => {
  // The repository's population from the one ownership reader (what the repository owns, on every checkout alike).
  const files = ownedFiles(REPOSITORY);
  assert.ok(files !== undefined, "the repository is a work tree");
  const entries = testEntries(files);
  assert.ok(entries.length > 100, `the walk starts from the tree's test files (${String(entries.length)})`);
  assert.ok(files.some((path) => path.startsWith(PROVING)), "the proving folder is in the universe");
  assert.deepEqual(entries.filter((path) => path.startsWith(PROVING)), [], "a test file inside the proving folder would be run offline");
  const reached = walk(files, entries, (path) => {
    try {
      return readFileSync(join(REPOSITORY, path), "utf8");
    } catch {
      return null;
    }
  });
  assert.deepEqual(reached.intoExcluded.map((edge) => `${edge.importer} -> ${edge.target}`), [], "an offline test reaches the proving scenarios");
});
