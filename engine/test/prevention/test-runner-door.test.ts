/**
 * PREVENTION — the engine's test runner is `node --test`, and a vitest
 * invocation rooted here must dead-end, never silently run the wrong suite.
 *
 * THE MEASURED DEFECT: a writer who ran `npx vitest run test/editor/` from
 * this directory hit a wrong-runner dead-end — the engine has no vitest of
 * its own, so `npx` walked up to the WEB repo's vitest, which loaded the WEB
 * repo's include globs (`tests/unit/**` and siblings), matched nothing under
 * the engine's `test/`, and exited 1 with "No test files found". The failure
 * never named the actual mistake: the RUNNER was wrong, not the filter. The
 * editor suite was green the whole time under its own door
 * (`npm run test:editor`).
 *
 * ── WHY THE FIX LIVES IN THE WEB CONFIG, NOT AN ENGINE CONFIG ────────────
 *
 * The obvious fix — an `engine/vitest.config.ts` with `include: []` — is
 * refused by the engine's own no-stray-root-scripts guard, which admits no
 * `.ts` file at the repository root. The honest root fix sits one level up:
 * vitest reaches the engine's tree ONLY because it walks up and finds the
 * WEB repo's config. Pinning THAT config's `root` to its own directory makes
 * its include globs resolve against the monorepo root regardless of the
 * caller's cwd, so the engine's `test/**` is unreachable BY CONSTRUCTION —
 * and `passWithNoTests` turns the resulting empty suite into a clean exit,
 * not a red herring.
 *
 * WHAT THIS GUARD PINS:
 *
 *   1. The web config's `root` is pinned and `passWithNoTests` is set — the
 *      dead-end. Verified by LIVE DRIVE from a scratch cwd outside the web
 *      root, because the whole point is a caller whose cwd is NOT the web
 *      root.
 *   2. The editor test suite — discovered DYNAMICALLY from `test/editor/`,
 *      never a hardcoded list — is reachable through a `node --test` door:
 *      `package.json` carries a `test:editor` script whose arguments cover
 *      every discovered editor test file, routed through the lock wrapper.
 *   3. The general subset door (`test:unit`) stays routed through the same
 *      lock wrapper.
 *
 * The runner convention itself (one `node --test` wrapper holding the
 * one-instrument lock) is owned by `test-run-lock.test.ts`; this guard owns
 * the WRONG-RUNNER dead-end and the editor door's coverage.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { engineTestBoundsImport } from "../../scripts/tooling/engine-test-bounds.ts";
import { doorNodeArgs, doorRun } from "../../scripts/tooling/test-guards.ts";
import { readSourceView } from "../../scripts/verification/source-view.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { DEFAULT_TEST_HANG_BACKSTOP_MS } from "../../src/workflow/workflow-config.ts";
import { createRepositoryLocalTemporaryDirectory, removeRepositoryLocalTemporaryDirectory } from "../support/repository-local-temporary.ts";

const ROOT = process.cwd();
const PKG_PATH = join(ROOT, "package.json");
// The web repo root is the engine's parent in this monorepo layout.
const WEB_ROOT = join(ROOT, "..");
// The build config pins the root; the runner's config extends it and owns
// the no-tests exit (vitest resolves `vitest.config.ts` first).
const WEB_BUILD_CONFIG_PATH = join(WEB_ROOT, "vite.config.ts");
const WEB_RUNNER_CONFIG_PATH = join(WEB_ROOT, "vitest.config.ts");
const EDITOR_TEST_DIR = join(ROOT, "test", "editor");

/** The scripts block of the engine's own package.json. */
function packageScripts(): Readonly<Record<string, string>> {
  const pkg = JSON.parse(readFileSync(PKG_PATH, "utf8")) as { scripts?: Record<string, string> };
  return pkg.scripts ?? {};
}

/** Every editor test file, discovered from disk on every run. */
function editorTestFiles(): readonly string[] {
  return readdirSync(EDITOR_TEST_DIR)
    .filter((name) => name.endsWith(".test.ts"))
    .sort();
}

test("the web vitest config pins its root and neutralizes the no-tests exit", () => {
  // The source half: the dead-end mechanism must be DECLARED. Read the web
  // config through the sanctioned view — `codeWithStrings()` because the pin's
  // subject (`import.meta.dirname`) is real code and `passWithNoTests` is a
  // plain property — and require the pin + the neutralizer to be present.
  const source = readSourceView(WEB_BUILD_CONFIG_PATH).codeWithStrings();
  const runner = readSourceView(WEB_RUNNER_CONFIG_PATH).codeWithStrings();
  assert.ok(
    /mergeConfig\(\s*BUILD_CONFIG\b/.test(runner) && /import\s+\{\s*BUILD_CONFIG\s*\}\s+from\s+["']\.\/vite\.config\.ts["']/.test(runner),
    "the web vitest.config.ts must extend the build config (`mergeConfig(BUILD_CONFIG, …)` over `./vite.config.ts`), " +
      "or the root pin below does not reach the runner",
  );
  assert.ok(
    /root:\s*import\.meta\.dirname/.test(source),
    "the web vite.config.ts must pin `root: import.meta.dirname` so its include globs " +
      "resolve against the monorepo root regardless of the caller's cwd — without it, a " +
      "vitest run rooted in engine/ matches the engine's tree against the web's globs",
  );
  assert.ok(
    /passWithNoTests:\s*true/.test(runner),
    "the web vitest.config.ts must set `passWithNoTests: true` so the wrong-runner dead-end " +
      "exits clean (a signpost) instead of a misleading 'No test files found' failure",
  );
});

test("a vitest run rooted in the engine dead-ends clean (live drive)", () => {
  // The behavioural half: drive vitest from a scratch cwd INSIDE the engine —
  // the honest shape, because the defect only ever fires for a caller whose
  // cwd is under the engine but not the web root, so vitest's upward config
  // walk lands on the web config. The pinned root must make it match nothing
  // and exit 0 — never the misleading exit 1 of the defect.
  // The scratch sits in the engine's repository-local fixture root (inside
  // the engine, outside the web root), never in the live source tree.
  const scratch = createRepositoryLocalTemporaryDirectory("vitest-dead-end-");
  try {
    const run = spawnSync(
      process.execPath,
      [
        join(WEB_ROOT, "node_modules", "vitest", "dist", "cli.js"),
        "run",
        "test/editor/",
        // Loaded by vite's module runner, as every vitest route of the one test-execution door loads it: this test runs
        // confined, and the default loader bundles the config into the read-only node_modules/.vite-temp.
        "--configLoader=runner",
      ],
      { cwd: scratch, encoding: "utf8", timeout: 120_000 },
    );
    const output = `${run.stdout}\n${run.stderr}`;
    assert.equal(
      run.status,
      0,
      `vitest rooted in the engine exited ${run.status} (expected 0 — a clean dead-end): ${output.slice(-600)}`,
    );
    assert.ok(
      /No test files found/i.test(output),
      `the dead-end should report an empty suite, got: ${output.slice(-600)}`,
    );
  } finally {
    removeRepositoryLocalTemporaryDirectory(scratch);
  }
});

test("every editor test file is reachable through the test:editor door", () => {
  const files = editorTestFiles();
  assert.ok(files.length > 0, "test/editor/ holds no .test.ts files — the discovery is broken");
  const script = packageScripts()["test:editor"];
  assert.ok(
    script !== undefined,
    "package.json carries no `test:editor` script — the editor suite has no documented door",
  );
  assert.ok(
    !script.includes("vitest"),
    `test:editor must run on node --test, never vitest (the wrong-runner defect), got: ${script}`,
  );
  assert.ok(
    script.includes("test-guards.ts"),
    `test:editor must route through the node --test lock wrapper (test-guards.ts), got: ${script}`,
  );
  // Every discovered editor file is covered by the script's arguments — either
  // by an explicit name or by the `test/editor/` glob. A hardcoded file LIST
  // in the script would rot; require the directory glob OR per-file coverage.
  const coversAll =
    script.includes("test/editor/") ||
    files.every((file) => script.includes(`test/editor/${file}`));
  assert.ok(
    coversAll,
    `test:editor does not cover every discovered editor test file. Script: ${script}; files: ${files.join(", ")}`,
  );
});

test("the general subset door routes through the lock wrapper", () => {
  const script = packageScripts()["test:unit"];
  assert.ok(
    script !== undefined,
    "package.json carries no `test:unit` script — the single-file/pattern subset door is undocumented",
  );
  assert.ok(
    script.includes("test-guards.ts"),
    `test:unit must route through the one-instrument lock wrapper (test-guards.ts), got: ${script}`,
  );
});

test("the subset door REFUSES a no-argument run (it would discover non-test .mjs files)", () => {
  // A bare `node --test` (no file argument) discovers the whole tree —
  // including `verification/benchmarks/**` `.mjs` scripts that are not
  // node:test files — and fails on them. The lock wrapper must refuse the
  // no-argument `test:unit` invocation with a guided message instead. Drive
  // the wrapper directly (it is not the lock-holder in this guard's own run)
  // and require the refusal.
  const run = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "scripts/tooling/test-guards.ts"],
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, npm_lifecycle_event: "test:unit" },
    },
  );
  assert.equal(
    run.status,
    1,
    `a no-argument test:unit must exit 1 (the guided refusal), got ${run.status}: ${run.stdout.slice(-400)}`,
  );
  assert.ok(
    run.stderr.includes("requires an explicit test file or pattern"),
    `the refusal must name the remedy, got: ${run.stderr.slice(-400)}`,
  );
});

test("the subset door runs its test files under the SUITE'S OWN bounds: a per-test wall timeout is refused and the CPU judgement reads every test, exactly as in the suite", () => {
  // Before, a targeted run (`test:unit`, and `harness flake reproduce`, which
  // runs here) ran plain `node --test`: no CPU judgement and no backstop, so
  // a CPU-class failure could never be seen or reproduced (#615).
  const dir = createTempDir("subset-door-bounds-");
  const file = join(dir, "bounded.test.mjs");
  writeFileSync(file, [
    'import test from "node:test";',
    'test("declares its own wall timeout", { timeout: 1234 }, () => {});',
    'test("clean", () => {});',
  ].join("\n"));
  // The door is a runner of its own, never a test file of this run.
  const { NODE_TEST_CONTEXT: _ownContext, ...env } = process.env;
  const run = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/tooling/test-guards.ts", file], { cwd: ROOT, encoding: "utf8", env, timeout: DEFAULT_TEST_HANG_BACKSTOP_MS });
  assert.equal(run.status, 1, `the refused timeout fails the run: ${run.stdout.slice(-600)}`);
  assert.match(run.stdout, /bounded by a 1234 ms wall timeout: a per-test wall timeout is not allowed/u, "the suite's wall-bound refusal ran in the targeted file's process");
  assert.match(run.stdout, /cpu-work \d+ ms; wall \d+ ms \(recorded, not judged\)/u, "the suite's CPU judgement read the test");
});

test("the subset door hands node EXACTLY the files it bounds: a file as given and a glob's matches, each flag a known boolean or --name=value; a folder, an unmatched pattern, a space-form flag value and a run naming no file are each refused typed", () => {
  const dir = createTempDir("subset-door-files-");
  mkdirSync(join(dir, "nested"));
  for (const name of ["a.test.ts", "nested/b.test.mjs", "nested/helper.ts"]) writeFileSync(join(dir, name), "");
  assert.deepEqual(doorRun([join(dir, "a.test.ts"), "--test-name-pattern=x", "--test-only"], dir), { flags: ["--test-name-pattern=x", "--test-only"], files: [join(dir, "a.test.ts")] });
  assert.deepEqual(doorRun(["nested/*.mjs"], dir).files, [join(dir, "nested", "b.test.mjs")]);
  const refused = (args: readonly string[]): string | undefined => {
    try {
      doorRun(args, dir);
      return undefined;
    } catch (error) {
      return (error as { code?: string }).code;
    }
  };
  assert.equal(refused([dir]), "test_guards_folder_argument");
  assert.equal(refused(["nothing/*.test.ts"]), "test_guards_pattern_unmatched");
  assert.equal(refused(["--import", "nested/helper.ts", "a.test.ts"]), "test_guards_flag_value");
  assert.equal(refused(["--test-name-pattern=x"]), "test_guards_no_test_file");
});

test("THE SPACE-FORM HOLE (review of #626): `--import ./noop.mjs` from a folder holding test files is refused before node runs — node would read the value as the flag's and discover every test there unbounded", () => {
  const dir = createTempDir("subset-door-space-form-");
  writeFileSync(join(dir, "noop.mjs"), "");
  writeFileSync(join(dir, "discovered.test.mjs"), 'import test from "node:test"; test("discovered", () => { console.log("RAN-UNBOUNDED"); });\n');
  const { NODE_TEST_CONTEXT: _ownContext, ...env } = process.env;
  const run = spawnSync(process.execPath, ["--experimental-strip-types", join(ROOT, "scripts", "tooling", "test-guards.ts"), "--import", "./noop.mjs"], { cwd: dir, encoding: "utf8", env, timeout: DEFAULT_TEST_HANG_BACKSTOP_MS });
  assert.equal(run.status, 1, `${run.stdout.slice(-400)}${run.stderr.slice(-400)}`);
  assert.ok(run.stderr.includes("write a flag's value in the same argument"), run.stderr.slice(-400));
  assert.ok(!run.stdout.includes("RAN-UNBOUNDED"), "a discovered test ran outside the bounds");
});

test("the door hands node EXACTLY its own argv — the bounds' preload, --test with the backstop, the door's flags, then the files it bounds — and main runs THAT, never the arguments it was given", () => {
  const dir = createTempDir("subset-door-argv-");
  writeFileSync(join(dir, "a.test.ts"), "");
  const door = doorRun(["a.test.ts", "--test-name-pattern=x"], dir);
  const bounds = { hangBackstopMs: 600_000, cpuClasses: null, repositoryRoot: dir, files: door.files };
  assert.deepEqual(doorNodeArgs(bounds, door), [
    "--experimental-strip-types",
    engineTestBoundsImport(bounds),
    "--test",
    "--test-timeout=600000",
    "--test-name-pattern=x",
    join(dir, "a.test.ts"),
  ]);
  // The run main makes is that argv: a door that handed node its raw arguments again would not call it.
  const source = readSourceView(join(ROOT, "scripts", "tooling", "test-guards.ts")).code();
  const mainBody = source.slice(source.indexOf("export async function main"));
  assert.ok(mainBody.includes("args: doorNodeArgs(bounds, door)"), "main hands node the door's own argv");
  assert.ok(!mainBody.includes("process.argv.slice(2)]") && !mainBody.includes("...process.argv"), "main never spreads the arguments it was given into node's argv");
});
