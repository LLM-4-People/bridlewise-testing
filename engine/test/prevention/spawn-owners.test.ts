/**
 * ONE DOOR FOR EVERY PROCESS (#653, rules are retroactive): a module takes a
 * value from `node:child_process` only when it is a declared owner
 * (`scripts/verification/spawn-owners.ts`, each with its reason); every other
 * process runs through the one bounded run or the git door built on it. The
 * scan is structural (the module's syntax tree): a static or dynamic import, a
 * re-export and a `require` all count, a type-only import does not, and a
 * fixture's source text in a string is never mistaken for an import. An owner
 * entry whose file no longer spawns is refused too, so the list stays exact.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { directSpawnImporters, importsChildProcessValue, isTestSource, SPAWN_OWNERS } from "../../scripts/verification/spawn-owners.ts";

const REPOSITORY_ROOT = join(import.meta.dirname, "..", "..", "..");

test("no module spawns a process directly outside the declared owners, and every declared owner still does", () => {
  const found = directSpawnImporters(REPOSITORY_ROOT);
  const owners = Object.keys(SPAWN_OWNERS);
  assert.deepEqual(found.filter((path) => !owners.includes(path)), [], "route these through runCpuBounded / runCpuBoundedSync or the git door (gitOutput), or declare them with a reason");
  assert.deepEqual(owners.filter((path) => !found.includes(path)), [], "these owners no longer spawn: remove their entries");
  for (const [path, reason] of Object.entries(SPAWN_OWNERS)) assert.ok(reason.length > 0, `${path} is declared without a reason`);
});

test("the scan sees every way to take a value from child_process, and nothing else", () => {
  const spawning = [
    `import { spawnSync } from "node:child_process";`,
    `import * as cp from "child_process";`,
    `import cp from "node:child_process";`,
    `import "node:child_process";`,
    `import { type ChildProcess, spawn } from "node:child_process";`,
    `export { spawn } from "node:child_process";`,
    `export * from "child_process";`,
    `const { execFileSync } = await import("node:child_process");`,
    `const cp = require("child_process");`,
  ];
  for (const source of spawning) assert.equal(importsChildProcessValue(source, "probe.ts"), true, source);
  assert.equal(importsChildProcessValue(`const cp = require("child_process");`, "probe.cjs"), true, "plain JavaScript too");
  const quiet = [
    `import type { ChildProcess } from "node:child_process";`,
    `import { type ChildProcess } from "node:child_process";`,
    `export type { SpawnOptions } from "node:child_process";`,
    "const fixture = `import { exec } from \"node:child_process\";`;",
    `// import { spawn } from "node:child_process";`,
    `const name = "child_process";`,
  ];
  for (const source of quiet) assert.equal(importsChildProcessValue(source, "probe.ts"), false, source);
});

test("test code is out of scope; source beside it is not", () => {
  assert.equal(isTestSource("engine/test/process/bounded-run.test.ts"), true);
  assert.equal(isTestSource("tests/helpers/native-script.ts"), true);
  assert.equal(isTestSource("engine/live/mcp-servers.test.ts"), true);
  assert.equal(isTestSource("engine/src/process/supervised-run.ts"), false);
  assert.equal(isTestSource("scripts/testing/perf-profile.ts"), false);
});
