/**
 * NO TEST RUNNER IS STARTED OUTSIDE THE ONE TEST-EXECUTION DOOR (decision
 * TEST-CONFINEMENT-SELF-BIND, coverage): `node --test`, vitest and the
 * Playwright test runner are started only through `runTestCommand`
 * (engine/src/process/supervised-run.ts), directly or through a runner that
 * calls it (the guard runner, the web runner, `harness slot run`). Confinement
 * is never opt-in per caller, so a new spawn of a test runner anywhere else —
 * a script, a package script, a CI step, a configured phase — is refused here.
 *
 * Scanned: every tracked file that runs OUTSIDE a test run. A test file, a
 * test helper and a fixture run only inside a confined run, so what they start
 * is confined with them; the live suite (engine/live/) is the declared
 * unconfined exception and starts no runner. Each remaining site is named
 * below with how it reaches the door, so a reviewer checks each one.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

import { readSourceView } from "../../scripts/verification/source-view.ts";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: new URL(".", import.meta.url), encoding: "utf8" }).trim();

/** A test runner started from code: an argv element, or a string that begins with a runner's command line. */
const CODE_SPAWN: readonly RegExp[] = [
  /["'`]--test["'`]/u,
  /vitest\.mjs|["'`]vitest["'`]\s*,\s*(?:["'`\[.]|\.\.\.)/u,
  /["'`]playwright["'`]\s*,\s*\[?\s*["'`]test["'`]/u,
  /(?:^|[(=,[:?]\s*)["'`]\s*(?:npx\s+)?(?:node(?:\s+--?[\w=./-]+)*\s+--test|vitest\s+(?:run|list|watch|bench)|playwright\s+test)(?:\s|["'`$]|$)/u,
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

/** What runs inside a confined run (or is a record, not a command), never outside one. */
function insideATestRun(path: string): boolean {
  return /^(?:tests|engine\/test|engine\/live|docs|engine\/traceability)\//u.test(path)
    || /\.(?:test|spec)\.[cm]?[jt]s$/u.test(path)
    || /\.md$/u.test(path)
    || path === "package-lock.json" || path === "engine/package-lock.json";
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
  { path: "package.json", line: "harness slot run -- npx playwright test", how: "`harness slot run`, confined always (test:e2e, test:all)" },
  { path: "package.json", line: "harness slot run -- node node_modules/vitest/vitest.mjs", how: "`harness slot run`, confined always (test:raw, test:supported)" },
];

function codeLines(path: string, text: string): readonly Readonly<{ number: number; line: string }>[] {
  const comment = isCode(path) ? /^\s*(?:\/\/|\*|\/\*)/u : /\.ya?ml$|(?:^|\/)Makefile$/u.test(path) ? /^\s*#/u : undefined;
  return text.split("\n").map((line, index) => ({ number: index + 1, line })).filter(({ line }) => comment === undefined || !comment.test(line));
}

test("no test runner is started outside the one test-execution door: every site is named with how it reaches it", () => {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0")
    .filter((path) => /\.(?:[cm]?[jt]s|json|ya?ml|sh)$|(?:^|\/)Makefile$/u.test(path) && !insideATestRun(path));
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
  ]) assert.ok(CODE_SPAWN.some((pattern) => pattern.test(line)), line);
  for (const line of [
    "\"test:x\": \"node --experimental-strip-types --test a.test.ts\"",
    "run: node --test tests/public/*.test.mjs",
    "\"test:watch\": \"vitest\",",
    "\"argv\": [\"npx\", \"vitest\", \"list\"]",
    "          \"vitest\",",
    "\"e2e\": \"npx playwright test\"",
  ]) assert.ok(SHELL_SPAWN.some((pattern) => pattern.test(line)), line);
});
