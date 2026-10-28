/**
 * THE ENGINE'S CLI PROCESSES LOG CENTRALLY (`src/runtime/cli-debug.ts`).
 *
 * wf1b-design M4 (reproduced): `auditEvent` is a no-op until a host
 * configures the debug system, and only the web server did, so every audit
 * event the engine's own tools emit (a sweep of a dead owner's temporaries,
 * a journaled transaction rolled back or recovered) went nowhere. Driven:
 *
 *   - a CLI process that runs the one bootstrap hears a real sweep's audit
 *     event on stderr (the declared console sink); the same sweep in a
 *     process that did not bootstrap emits nothing (the liveness contrast);
 *   - EVERY process entry point of the engine (the `import.meta.url` main
 *     guard, derived by scanning — never a hand list) runs the bootstrap
 *     first, and the top-level commit guard does, except the declared
 *     exceptions below, each with its reason.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { walk } from "../../scripts/verification/source-walk.ts";
import { readSourceView } from "../../scripts/verification/source-view.ts";
import { moduleSpecifiers } from "../../src/workflow/reachability.ts";
import { createTempDir } from "../support/temp-dir.ts";

const ENGINE_ROOT = join(import.meta.dirname, "..", "..");
const BOOTSTRAP = pathToFileURL(join(ENGINE_ROOT, "src", "runtime", "cli-debug.ts")).href;
const PRIVATE_STATE = pathToFileURL(join(ENGINE_ROOT, "src", "filesystem", "private-state.ts")).href;

/** Entry points that must NOT configure the process's debug system, with the reason. */
/** Entry points that run no bootstrap, keyed by their path from the repository root, each with its reason. */
const NOT_BOOTSTRAPPED: Readonly<Record<string, string>> = {
  "engine/scripts/tooling/test-worker.ts": "it hosts the test files' own process: configuring its debug system would change the state every test in it starts from",
  "scripts/check-docs-links.mjs": "a dependency-free CI utility: it runs as the gate's first step and in docs-links.yml, before or without any package install, so it reaches only node built-ins and the leaf entry-point module; its findings go to stderr and its exit code",
  "scripts/floor/site-links.mjs": "a dependency-free CI utility: the Pages job builds with Jekyll and installs no package; its findings go to stderr and its exit code",
  "scripts/test-shard-manifest.mjs": "a dependency-free CI utility: the shard toolchain's merge job (the required receipt check) installs no package; its refusals go to stderr and its exit code",
  "scripts/test-shard-merge.mjs": "a dependency-free CI utility: the shard merge job (the required receipt check) installs no package; its refusals go to stderr and its exit code",
};
/** Top-level programs (no main guard: the whole module is the program). */
const TOP_LEVEL_PROGRAMS = ["scripts/commit-guard.ts", "src/intelligence/farm-child.ts", "src/tools/concurrent/long-task-wrapper.mjs"] as const;
/**
 * The one bootstrap call, with the process's fault role (`src/process/fault-policy.ts`; its literal is
 * type-checked as a `ProcessFaultRole`). Matched on the CODE view, where a string's content is blanked.
 */
const BOOTSTRAP_CALL = /^bootstrapProcess\(\{ role: "[^"]*" \}\);/u;

function sweepIn(bootstrap: boolean): string {
  const parent = createTempDir("cli-debug-sweep-");
  const exited = spawnSync(process.execPath, ["-e", "0"]);
  mkdirSync(join(parent, `swept-${String(exited.pid)}-1-abcd`));
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", [
    bootstrap ? `(await import(${JSON.stringify(BOOTSTRAP)})).bootstrapProcess({ role: "cli" });` : "",
    `const { sweepAbandonedTemporaries } = await import(${JSON.stringify(PRIVATE_STATE)});`,
    `process.stdout.write(JSON.stringify(sweepAbandonedTemporaries(${JSON.stringify(parent)}, "swept-")));`,
  ].join("\n")], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), [`swept-${String(exited.pid)}-1-abcd`], "the sweep itself did not run");
  return child.stderr;
}

test("a CLI process that runs the bootstrap hears a sweep's audit event; one that did not hears nothing", () => {
  assert.match(sweepIn(true), /audit:abandoned-temporaries-swept/u, "the audit event went nowhere in a bootstrapped CLI process");
  assert.doesNotMatch(sweepIn(false), /audit:abandoned-temporaries-swept/u, "an unconfigured process emitted: the contrast is not measuring the bootstrap");
});

/** Where process entry points live: the engine, the server, the scripts, the benches, the test helpers' generators. */
const ENTRY_ROOTS = ["engine/src", "engine/scripts", "server", "scripts", "bench", "tests/helpers"] as const;
const REPOSITORY_ROOT = join(ENGINE_ROOT, "..");
/** THE one main-ness test (`isEntryPoint`), and the block every entry point opens with. */
const ENTRY_GUARD = "if (isEntryPoint(import.meta.url)) {";
/** Any OTHER way to ask "am I the program?": a private spelling of argv[1] against the module, `import.meta.main`, `require.main`. */
const PRIVATE_MAIN_TEST = /\bprocess\.argv\[1\]|\bimport\.meta\.main\b|\brequire\.main\b/u;
/** Files that read `process.argv[1]` for another reason, with it. */
const ARGV_READERS: Readonly<Record<string, string>> = {
  "engine/src/runtime/entry-point.ts": "the owner of the one main-ness test",
  "engine/src/filesystem/checkout-write-door.ts": "it describes this process's own command line (the script it runs) to the write door, never to decide main-ness",
  "engine/scripts/tooling/bootstrap-permissions.ts": "the trusted bootstrap: its import surface is a fixed verified set (s1-verification trusted-bootstrap-import-surface) that excludes the runtime's CLI module, and it exists to repair the settings file's mode (reading the settings first would refuse the repair), so it keeps its own main test and runs no bootstrap",
  "engine/src/shared/workflow/e2e-runner.mjs": "a standalone utility that stays OUTSIDE the harness module graph (entrypoint-recording-wiring: an argv-dispatching .mjs may import no harness module unless it is fully wired), so it keeps its own main test and runs no bootstrap",
};

function entryFiles(): ReadonlyArray<Readonly<{ path: string; code: string }>> {
  return ENTRY_ROOTS.flatMap((root) => walk(join(REPOSITORY_ROOT, root), { exts: [".ts", ".mts", ".mjs"] }))
    .map((file) => relative(REPOSITORY_ROOT, file).split("\\").join("/"))
    .filter((path) => !path.includes("/node_modules/") && (!path.includes("/fixtures/") || path.startsWith("bench/fixtures/")))
    // CODE ONLY (the source-view owner): a guard or a bootstrap call quoted in
    // a comment or a string is not the program running it.
    .map((path) => ({ path, code: readSourceView(join(REPOSITORY_ROOT, path)).code() }));
}

test("ONE main-ness test: no entry point decides it is the program by any spelling but isEntryPoint (wf1b2-design L2)", () => {
  const files = entryFiles();
  assert.ok(files.length > 800, `the scan saw ${String(files.length)} files: it is not seeing the tree`);
  const privateTests = files.filter((file) => !(file.path in ARGV_READERS) && PRIVATE_MAIN_TEST.test(file.code)).map((file) => file.path);
  assert.deepEqual(privateTests, [], "ask isEntryPoint(import.meta.url) (engine/src/runtime/cli-debug.ts): a private spelling hides an entry point from the logging guard");
  for (const planted of ["if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {", "const isMain = import.meta.url === `file://${process.argv[1]}`;", "if (import.meta.main) {", "if (require.main === module) {", "if (process.argv[1]?.endsWith(\"x.ts\")) {"]) {
    assert.ok(PRIVATE_MAIN_TEST.test(planted), `the private spelling ${planted} is not caught`);
  }
});

/**
 * The packages a source reaches through its imports, from `root`: every
 * edge the ONE module-specifier reader (`src/workflow/reachability.ts`
 * `moduleSpecifiers`, which reads tokens) names, in every form (single,
 * double or backtick quotes, `export … from`, dynamic `import()` of a
 * literal), relative edges followed, bare non-`node:` specifiers collected.
 * An import the reader cannot name (a computed `import()`) is reported too:
 * what is not read is not certified.
 */
function reachedPackages(start: string, root: string = REPOSITORY_ROOT): readonly string[] {
  const packages = new Set<string>();
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const path = queue.pop()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const edges = moduleSpecifiers(path, readFileSync(join(root, path), "utf8"));
    for (const specifier of edges.imports) {
      if (specifier.startsWith(".")) queue.push(relative(root, resolve(root, dirname(path), specifier)).split("\\").join("/"));
      else if (!specifier.startsWith("node:")) packages.add(`${path} -> ${specifier}`);
    }
    for (const opaque of edges.opaque) packages.add(`${path} -> ${opaque}`);
  }
  return [...packages].sort();
}

test("the import-graph reader follows every import form, through the one specifier reader (planted)", () => {
  const dir = createTempDir("import-graph-");
  writeFileSync(join(dir, "a.mjs"), "import x from './b.mjs';\nexport { y } from \"./c.mjs\";\nawait import(`./d.mjs`);\n// import 'commented-out';\n");
  writeFileSync(join(dir, "b.mjs"), "import z from 'zod';\nexport const x = z;\n");
  writeFileSync(join(dir, "c.mjs"), "export * from \"yaml\";\nexport const y = 1;\n");
  writeFileSync(join(dir, "d.mjs"), "await import('picomatch');\nconst name = 'x';\nawait import(name);\n");
  assert.deepEqual(reachedPackages("a.mjs", dir), [
    "b.mjs -> zod",
    "c.mjs -> yaml",
    "d.mjs -> import(<computed>)",
    "d.mjs -> picomatch",
  ]);
});

test("a dependency-free utility reaches no package: its whole import graph is node built-ins and the leaf entry-point module", () => {
  const utilities = Object.entries(NOT_BOOTSTRAPPED).filter(([, reason]) => reason.startsWith("a dependency-free CI utility")).map(([path]) => path);
  assert.ok(utilities.length >= 4, "the dependency-free utilities are no longer declared");
  for (const path of utilities) assert.deepEqual(reachedPackages(path), [], `${path} is declared dependency-free but reaches a package`);
  // The reader is not vacuous: an entry point that runs the bootstrap reaches packages through it.
  assert.ok(reachedPackages("engine/scripts/verification/corpus.ts").length > 0, "the import-graph reader saw no package behind the bootstrap");
});

test("every process entry point runs the process bootstrap first (derived by scanning), bar the declared exceptions", () => {
  const entries = entryFiles().filter((file) => file.code.includes(ENTRY_GUARD));
  assert.ok(entries.length >= 35, `the scan found ${String(entries.length)} entry points: it is not seeing them`);
  for (const path of Object.keys(NOT_BOOTSTRAPPED)) {
    assert.ok(entries.some((entry) => entry.path === path), `the declared exception ${path} is no longer an entry point: remove it`);
  }
  const missing = entries
    .filter((entry) => !(entry.path in NOT_BOOTSTRAPPED))
    .filter((entry) => !BOOTSTRAP_CALL.test(entry.code.slice(entry.code.indexOf(ENTRY_GUARD) + ENTRY_GUARD.length).trimStart()))
    .map((entry) => entry.path);
  for (const program of TOP_LEVEL_PROGRAMS) {
    if (!readSourceView(join(ENGINE_ROOT, program)).code().split("\n").some((line) => BOOTSTRAP_CALL.test(line.trim()))) missing.push(program);
  }
  assert.deepEqual(missing, [], "these entry points run without the process bootstrap (central logging and the fault policy): call bootstrapProcess({ role }) first");
});

test("isEntryPoint: the program by real path (a relative or symlinked invocation too); an imported module or an eval is not", () => {
  const dir = createTempDir("entry-point-");
  const program = join(dir, "program.mjs");
  writeFileSync(program, `import { isEntryPoint } from ${JSON.stringify(pathToFileURL(join(ENGINE_ROOT, "src", "runtime", "cli-debug.ts")).href)};\nprocess.stdout.write(String(isEntryPoint(import.meta.url)));\n`);
  const link = join(dir, "linked.mjs");
  symlinkSync(program, link);
  const importer = join(dir, "importer.mjs");
  writeFileSync(importer, `await import(${JSON.stringify(pathToFileURL(program).href)});\n`);
  const run = (script: string, cwd = dir): string => spawnSync(process.execPath, [script], { cwd, encoding: "utf8" }).stdout;
  assert.equal(run(program), "true");
  assert.equal(run("./program.mjs"), "true", "a relative invocation is the program");
  assert.equal(run(link), "true", "a symlinked invocation is the program");
  assert.equal(run(importer), "false", "an imported module is not the program");
});

test("isEntryPointAmong: whether the program is one of a set of files, compared as isEntryPoint compares (a relative or symlinked invocation too); a program outside the set is not", () => {
  const dir = createTempDir("entry-point-among-");
  const owner = JSON.stringify(pathToFileURL(join(ENGINE_ROOT, "src", "runtime", "entry-point.ts")).href);
  const program = join(dir, "program.mjs");
  const other = join(dir, "other.mjs");
  const ask = (set: readonly string[]): string => `import { isEntryPointAmong } from ${owner};\nprocess.stdout.write(String(isEntryPointAmong(${JSON.stringify(set)})));\n`;
  writeFileSync(program, ask([join(dir, "elsewhere.mjs"), program]));
  writeFileSync(other, ask([program]));
  const link = join(dir, "linked.mjs");
  symlinkSync(program, link);
  const run = (script: string): string => spawnSync(process.execPath, [script], { cwd: dir, encoding: "utf8" }).stdout;
  assert.equal(run(program), "true");
  assert.equal(run("./program.mjs"), "true", "a relative invocation is the program");
  assert.equal(run(link), "true", "a symlinked invocation is the program");
  assert.equal(run(other), "false", "a program outside the set is not one of them");
});
