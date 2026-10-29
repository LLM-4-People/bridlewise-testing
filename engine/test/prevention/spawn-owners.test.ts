/**
 * ONE DOOR FOR EVERY PROCESS (#653, rules are retroactive): a module takes a
 * value from `node:child_process` only when it is a declared owner
 * (`scripts/verification/spawn-owners.ts`, each with its reason); every other
 * process runs through the one bounded run or the git door built on it. The
 * scan reads the module's syntax tree and names each form it finds. The forms
 * it cannot read reliably (a computed specifier, `process.binding`, `vm`, an
 * eval'd worker, `cluster`, a module it cannot parse) are refused outside
 * their own declared list rather than let through. It is a consistency aid:
 * the boundary against hostile code is #634's kernel confinement.
 *
 * Each form has a planted case, and a mutation: with that one form switched
 * off, its planted case is no longer seen. An entry whose file no longer
 * holds its form is refused too, so both lists stay exact.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { importsChildProcessValue, isTestSource, SPAWN_FORMS, SPAWN_OWNERS, spawnFormHolders, spawnFormsIn, UNREADABLE_LOADERS, type SpawnForm } from "../../scripts/verification/spawn-owners.ts";

const REPOSITORY_ROOT = join(import.meta.dirname, "..", "..", "..");

test("no module spawns directly, or holds an unreadable form, outside its declared list; every declared entry still does", () => {
  const { spawners, unreadable } = spawnFormHolders(REPOSITORY_ROOT);
  const owners = Object.keys(SPAWN_OWNERS);
  const loaders = Object.keys(UNREADABLE_LOADERS);
  assert.deepEqual(spawners.filter((path) => !owners.includes(path)), [], "route these through runCpuBounded / runCpuBoundedSync or the git door (gitOutput), or declare them with a reason");
  assert.deepEqual(owners.filter((path) => !spawners.includes(path)), [], "these owners no longer spawn: remove their entries");
  assert.deepEqual(unreadable.filter((path) => !loaders.includes(path)), [], "these hold a form the scan cannot read: make it readable, or declare it with a reason");
  assert.deepEqual(loaders.filter((path) => !unreadable.includes(path)), [], "these no longer hold an unreadable form: remove their entries");
  for (const [path, reason] of [...Object.entries(SPAWN_OWNERS), ...Object.entries(UNREADABLE_LOADERS)]) assert.ok(reason.length > 0, `${path} is declared without a reason`);
});

/** One planted case per form, each holding that form and no other the scan reads. */
const PLANTED: Readonly<Record<SpawnForm, readonly string[]>> = {
  "static-import": [
    `import { spawnSync } from "node:child_process";`,
    `import * as cp from "child_process";`,
    `import "node:child_process";`,
    `import { type ChildProcess, spawn } from "node:child_process";`,
  ],
  "re-export": [`export { spawn } from "node:child_process";`, `export * from "child_process";`],
  "dynamic-import": [`const cp = await import("node:child_process");`, "const cp = await import(`node:child_process`);"],
  "named-call": [
    `const cp = require("child_process");`,
    `const cp = module.require("node:child_process");`,
    `import { createRequire } from "node:module"; const cp = createRequire(import.meta.url)("child_process");`,
    `const cp = process.getBuiltinModule("node:child_process");`,
    "const cp = require(`child_process`);",
  ],
  "computed-import": [`const name = "node:" + "child_process"; await import(name);`, "const n = 'child_process'; await import(`node:${n}`);"],
  "computed-require": [`const name = "child_" + "process"; require(name);`, `import { createRequire } from "node:module"; const r = createRequire(import.meta.url); const n = "x"; r(n);`, `process.getBuiltinModule(["child", "process"].join("_"));`],
  "process-binding": [`process.binding("spawn_sync");`, `process["binding"]("spawn_sync");`],
  "vm-module": [`import { runInNewContext } from "node:vm";`, `const vm = require("vm");`, `const vm = await import("node:vm");`],
  "eval-worker": [`import { Worker } from "node:worker_threads"; new Worker("require('child_process')", { eval: true });`, `import * as wt from "node:worker_threads"; new wt.Worker(code, { "eval": true });`],
  "cluster-module": [`import cluster from "node:cluster"; cluster.fork();`, `const cluster = require("cluster");`],
  "unparsable": [`<<<< this is not a module >>>> ) ( }`],
};

test("each form has planted cases the scan sees, and each is a mutation's witness: with that form switched off, its case is no longer seen", () => {
  for (const form of SPAWN_FORMS) {
    const cases = PLANTED[form];
    assert.ok(cases.length > 0, `${form} has a planted case`);
    for (const source of cases) {
      assert.ok(spawnFormsIn(source, "probe.ts").has(form), `${form} is seen in: ${source}`);
      assert.equal(spawnFormsIn(source, "probe.ts", form).has(form), false, `with ${form} switched off, it is not seen in: ${source}`);
    }
  }
  assert.equal(importsChildProcessValue(`const cp = require("child_process");`, "probe.cjs"), true, "plain JavaScript too");
});

test("what is not a spawn is not seen as one", () => {
  const quiet = [
    `import type { ChildProcess } from "node:child_process";`,
    `import { type ChildProcess } from "node:child_process";`,
    `export type { SpawnOptions } from "node:child_process";`,
    "const fixture = `import { exec } from \"node:child_process\";`;",
    `// import { spawn } from "node:child_process";`,
    `const name = "child_process";`,
    `const m = await import("./sibling.ts"); const n = require("node:fs");`,
    `import { Worker } from "node:worker_threads"; new Worker(new URL("./w.ts", import.meta.url), { workerData: {} });`,
  ];
  for (const source of quiet) assert.deepEqual([...spawnFormsIn(source, "probe.ts")], [], source);
});

test("test code is out of scope; source beside it is not", () => {
  assert.equal(isTestSource("engine/test/process/bounded-run.test.ts"), true);
  assert.equal(isTestSource("tests/helpers/native-script.ts"), true);
  assert.equal(isTestSource("engine/live/mcp-servers.test.ts"), true);
  assert.equal(isTestSource("engine/src/process/supervised-run.ts"), false);
  assert.equal(isTestSource("scripts/testing/perf-profile.ts"), false);
});
