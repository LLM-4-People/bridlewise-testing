/**
 * NO TEST RUNNER IS STARTED OUTSIDE THE ONE TEST-EXECUTION DOOR (decision
 * TEST-CONFINEMENT-SELF-BIND, coverage): `node --test`, vitest and the
 * Playwright test runner are started only through `runTestCommand`
 * (engine/src/process/supervised-run.ts), directly or through a runner that
 * calls it (the guard runner, the web runner, `harness slot run`). Confinement
 * is never opt-in per caller, so a new spawn of a test runner anywhere else —
 * a script, a package script, a CI step, a configured phase — is refused here.
 *
 * Scanned: every tracked file that can run OUTSIDE a test run, which is
 * every file outside the test trees AND everything those files and the
 * unconfined live suite (engine/live/) import, followed through the one
 * module-specifier reader. Nothing is exempt by its directory: a test helper,
 * or a file under tests/, that a runner or a live test imports is scanned like
 * the runner. Only a file nothing unconfined reaches (a test, a helper and a
 * fixture used by tests alone) is not scanned, because it runs only inside a
 * confined run and so starts its children confined. Each remaining site is
 * named below with how it reaches the door, so a reviewer checks each one.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import test from "node:test";

import { readSourceView } from "../../scripts/verification/source-view.ts";
import { moduleSpecifiers } from "../../src/workflow/reachability.ts";
import { createTempDir } from "../support/temp-dir.ts";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: new URL(".", import.meta.url), encoding: "utf8" }).trim();

/** A test runner started from code: an argv element, or a string that begins with a runner's command line. */
const CODE_SPAWN: readonly RegExp[] = [
  /["'`]--test["'`]/u,
  /vitest\.mjs|["'`]vitest["'`]\s*,\s*(?:["'`\[.]|\.\.\.)/u,
  /["'`]playwright["'`]\s*,\s*\[?\s*["'`]test["'`]/u,
  /(?:^|[(=,[:?]\s*)["'`]\s*(?:npx\s+)?(?:node(?:\s+--?[\w=./-]+)*\s+--test|vitest\s+(?:run|list|watch|bench)|playwright\s+test)(?:\s|["'`$]|$)/u,
  // A test file named as a program: node runs its tests with no `--test` (the file imports node:test).
  /(?:process\.execPath|["'`]node["'`])\s*,\s*\[[^\]]*["'`][^"'`\s]*\.(?:test|spec)\.[cm]?[jt]s["'`]|["'`]\s*node\s+(?:\S+\s+)*?[^\s"'`]+\.(?:test|spec)\.[cm]?[jt]s\b/u,
  // The runner's package binary by any path.
  /\.bin\/(?:vitest|playwright)\b|["'`]\.bin["'`]\s*,\s*["'`](?:vitest|playwright)["'`]/u,
  // A runner flag built from pieces.
  /["'`]-{1,2}["'`]\s*\+\s*["'`]-?test|["'`]tes["'`]\s*\+\s*["'`]t["'`]/u,
  // node:test's programmatic runner: `run` imported from it, or called on it.
  /\{[^}]*\brun\b[^}]*\}\s*from\s*["'`]node:test["'`]|["'`]node:test["'`]\s*\)\s*\)?\s*\.run\b/u,
];

/** A test runner started from a command line: a package script, a CI step, a configured phase, a shell script. */
const SHELL_SPAWN: readonly RegExp[] = [
  /\bnode\b(?:\s+--?[\w=./-]+)*\s+--test(?:\s|["']|$)/u,
  /vitest\.mjs|\bnpx\s+vitest\b|(?:^|[\s"'`;&|(])vitest\s+(?:run|list|watch|bench)\b|["']vitest["']\s*[,\]]|:\s*["']vitest(?:\s|["'])/u,
  /\bplaywright\s+test\b|["']playwright["']\s*,\s*["']test["']/u,
];

function isCode(path: string): boolean {
  return /\.[cm]?[jt]s$/u.test(path);
}

/** A record, never a command: documentation, traceability data and the lockfiles. */
function isRecord(path: string): boolean {
  return /^(?:docs|engine\/traceability)\//u.test(path) || /\.md$/u.test(path) || path === "package-lock.json" || path === "engine/package-lock.json";
}

/** The test trees: what runs inside a confined run, UNLESS something unconfined reaches it (see the header). */
function inATestTree(path: string): boolean {
  return /^(?:tests|engine\/test|engine\/live)\//u.test(path) || /\.(?:test|spec)\.[cm]?[jt]s$/u.test(path);
}

/** The unconfined live suite: run by `test:live:*` outside any confined run. */
function isLiveTest(path: string): boolean {
  return /^engine\/live\/.*\.test\.[cm]?[jt]s$/u.test(path);
}

/**
 * Every tracked code file `starts` reach through their imports (static, dynamic with a literal, re-exports and
 * `new URL(literal, import.meta.url)`), by the one module-specifier reader; a package is not followed (it is not this
 * repository's code), and an import no literal names cannot be followed and is reported by the caller's guard.
 */
export function importClosure(root: string, starts: readonly string[], tracked: ReadonlySet<string>): ReadonlySet<string> {
  const reached = new Set<string>();
  const queue = [...starts];
  while (queue.length > 0) {
    const path = queue.pop()!;
    if (reached.has(path) || !tracked.has(path)) continue;
    reached.add(path);
    const edges = moduleSpecifiers(path, readFileSync(join(root, path), "utf8"));
    for (const specifier of [...edges.imports, ...edges.urls]) {
      if (specifier.startsWith(".")) queue.push(posix.normalize(posix.join(dirname(path), specifier)));
    }
  }
  return reached;
}

/** What can run outside a confined run: every non-record file outside the test trees, and all they and the live suite import. */
function runsUnconfined(root: string): readonly string[] {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter((path) => path.length > 0);
  const candidates = tracked.filter((path) => /\.(?:[cm]?[jt]s|json|ya?ml|sh)$|(?:^|\/)Makefile$/u.test(path) && !isRecord(path));
  const outside = candidates.filter((path) => !inATestTree(path));
  const closure = importClosure(root, [...outside.filter(isCode), ...candidates.filter(isLiveTest)], new Set(tracked));
  return [...new Set([...outside, ...closure])].sort();
}

/** The door and every site that reaches it, each with how (a substring of the line, so moving the line keeps it). */
const THROUGH_THE_DOOR: readonly Readonly<{ path: string; line: string; how: string }>[] = [
  { path: "engine/src/process/supervised-run.ts", line: "vitest.mjs", how: "the door's one vitest command (`vitestCommand`)" },
  { path: "engine/scripts/tooling/test-guards.ts", line: "\"--test\", `--test-timeout=", how: "doorNodeArgs, run through runTestCommand; the live suite through superviseCommand, the declared exception" },
  { path: "engine/scripts/tooling/test-guards.ts", line: "?? \"node --test\"}", how: "the run's label for the instrument lock; starts nothing" },
  { path: "engine/src/workflow/flake-cli.ts", line: "\"--test\", ...preload", how: "runInWorld calls runTestCommand" },
  { path: "engine/src/workflow/flake-cli.ts", line: "flag === \"--test\"", how: "parses its own `--test <identity>` option; starts nothing" },
  { path: "engine/src/shared/workflow/e2e-runner.mjs", line: "\"--test\",", how: "runE2e hands its argv to the caller's runSuite (the merge round's, through runTestCommand)" },
  { path: "engine/src/kernel/root-policy.ts", line: "nodeTestRunnerFlag: \"--test\"", how: "the flag the checkout write door recognises; starts nothing" },
  { path: "scripts/testing/perf-profile.ts", line: "\"playwright\", \"test\"", how: "runToExit calls runTestCommand" },
  { path: "scripts/testing/test-listing.mjs", line: "vitest list ended by", how: "names the listing in a message; listThroughTheDoor calls runTestCommand" },
  { path: "engine/scripts/tooling/inventory-test-run.ts", line: "import { run } from \"node:test\"", how: "node:test's runner in the engine worker process (test-worker.ts), which the engine runner starts through runTestCommand" },
  { path: "engine/src/workflow/test-result-collector.ts", line: "import { run } from \"node:test\"", how: "node:test's runner in the engine worker process (test-worker.ts), which the engine runner starts through runTestCommand" },
  { path: "engine/live/door-canaries.test.ts", line: "\"--fix\", \"HEAD\", \"--test\",", how: "the flake CLI's own `--test <identity>` option, parsed; runReproductionTests starts the run through runTestCommand" },
  { path: "engine/live/door-canaries.test.ts", line: "\"vitest\", \"vitest.mjs\"),", how: "plants a stand-in vitest the listing starts through runTestCommand; starts nothing itself" },
  { path: "engine/live/test-run-lock.test.ts", line: "process.argv = [argv[0]!, \"vitest\", ...args];", how: "sets this process's argv for the lock's argv reader; starts nothing" },
  { path: "engine/live/test-run-lock.test.ts", line: "wrapper.includes('\"--test\"')", how: "reads a wrapper's text; starts nothing" },
  { path: "tests/setup/concurrency-lock.ts", line: "parseCLI([\"vitest\", ...argv])", how: "parses vitest's own argv in the run's lock (imported by vitest.config.ts and the Playwright configs, which run under runTestCommand, and by a live test that reads it); starts nothing" },
  { path: "package.json", line: "harness slot run -- npx playwright test", how: "`harness slot run`, confined always (test:e2e, test:all)" },
  { path: "package.json", line: "harness slot run -- node node_modules/vitest/vitest.mjs", how: "`harness slot run`, confined always (test:raw, test:supported)" },
];

function codeLines(path: string, text: string): readonly Readonly<{ number: number; line: string }>[] {
  const comment = isCode(path) ? /^\s*(?:\/\/|\*|\/\*)/u : /\.ya?ml$|(?:^|\/)Makefile$/u.test(path) ? /^\s*#/u : undefined;
  return text.split("\n").map((line, index) => ({ number: index + 1, line })).filter(({ line }) => comment === undefined || !comment.test(line));
}

test("no test runner is started outside the one test-execution door: every site is named with how it reaches it", () => {
  const tracked = runsUnconfined(ROOT);
  // The scan is not vacuous: it reaches into the test trees through what the live suite and the runners import.
  assert.ok(tracked.some((path) => isLiveTest(path)) && tracked.some((path) => path.startsWith("engine/test/support/")), "the import closure reached no live test or test helper");
  const offenders: string[] = [];
  const used = new Set<number>();
  for (const path of tracked) {
    // Through the one source view (comments blanked, quoted strings and templates kept: a spawn's argv IS strings).
    const text = readSourceView(join(ROOT, path)).codeWithStringsAndTemplates();
    for (const { number, line } of codeLines(path, text)) {
      if (!(isCode(path) ? CODE_SPAWN : SHELL_SPAWN).some((pattern) => pattern.test(line))) continue;
      const declared = THROUGH_THE_DOOR.findIndex((site) => site.path === path && line.includes(site.line));
      if (declared === -1) offenders.push(`${path}:${String(number)}: ${line.trim().slice(0, 160)}`);
      else used.add(declared);
    }
  }
  assert.deepEqual(offenders, [], `a test runner started outside the one test-execution door (route it through runTestCommand or a runner that calls it):\n${offenders.join("\n")}`);
  const stale = THROUGH_THE_DOOR.filter((_, index) => !used.has(index)).map((site) => `${site.path}: ${site.line}`);
  assert.deepEqual(stale, [], `a named door site no longer exists (remove it from the list):\n${stale.join("\n")}`);
});

test("the guard has teeth: each spelling of a runner start is caught", () => {
  for (const line of [
    "spawn(\"node\", [\"--test\", file])",
    "execFileSync(\"npx\", [\"vitest\", \"run\"])",
    "spawn(process.execPath, [join(root, \"node_modules\", \"vitest\", \"vitest.mjs\")])",
    "runToExit(\"npx\", [\"playwright\", \"test\"])",
    "const cmd = `node --test ${stripFlag} ${files}`;",
    "execSync(\"npx vitest run\")",
    "spawn(process.execPath, [\"--experimental-strip-types\", \"x.test.ts\"])",
    "execSync(`node ${flags} tests/a.spec.mjs`)",
    "spawn(join(root, \"node_modules/.bin/vitest\"), [\"run\"])",
    "spawn(join(root, \"node_modules\", \".bin\", \"vitest\"))",
    "spawn(process.execPath, [\"--\" + \"test\", file])",
    "import { run } from \"node:test\";",
    "const stream = (await import(\"node:test\")).run({ files });",
  ]) assert.ok(CODE_SPAWN.some((pattern) => pattern.test(line)), line);
  // An ordinary line is not a spawn (the patterns do not refuse everything).
  for (const line of ["import test from \"node:test\";", "const files = sources.filter((path) => path.endsWith(\".ts\"));"]) {
    assert.ok(!CODE_SPAWN.some((pattern) => pattern.test(line)), line);
  }
  for (const line of [
    "\"test:x\": \"node --experimental-strip-types --test a.test.ts\"",
    "run: node --test tests/public/*.test.mjs",
    "\"test:watch\": \"vitest\",",
    "\"argv\": [\"npx\", \"vitest\", \"list\"]",
    "          \"vitest\",",
    "\"e2e\": \"npx playwright test\"",
  ]) assert.ok(SHELL_SPAWN.some((pattern) => pattern.test(line)), line);
});

test("the scanned set has no directory exemption: a test-tree file an unconfined file imports is scanned (planted)", () => {
  const dir = createTempDir("door-closure-");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "tests", "helpers"), { recursive: true });
  writeFileSync(join(dir, "scripts", "runner.ts"), "import { start } from \"../tests/helpers/start.ts\";\nawait import(\"./late.ts\");\n");
  writeFileSync(join(dir, "scripts", "late.ts"), "export {};\n");
  writeFileSync(join(dir, "tests", "helpers", "start.ts"), "export const start = 1;\n");
  writeFileSync(join(dir, "tests", "helpers", "unused.ts"), "export const unused = 1;\n");
  const tracked = new Set(["scripts/runner.ts", "scripts/late.ts", "tests/helpers/start.ts", "tests/helpers/unused.ts"]);
  assert.deepEqual([...importClosure(dir, ["scripts/runner.ts"], tracked)].sort(), ["scripts/late.ts", "scripts/runner.ts", "tests/helpers/start.ts"]);
});
