/**
 * THE DOOR'S CANARY THROUGH EACH RUNNER'S REAL ENTRY (review of #634, round 2,
 * blocker 5). These run UNCONFINED (the live suite: `npm run test:live:host`),
 * so the confinement they see is the one each runner itself applies: the guard
 * runner, `harness slot run` (the door of coverage, test:raw, test:supported,
 * the browser routes and the perf profile), the flake door's test run, and the
 * shard manifest's listing. Each drives the canary, a write into the checkout,
 * and must see the kernel refuse it (EROFS); a runner switched back to an
 * unconfined launch turns its test red.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { ensureTestProcessSupervisor } from "../guardian/build.ts";
import { parseFlakeReproduceArgs, runReproductionTests } from "../src/workflow/flake-cli.ts";
import { readTestExecutionConfig } from "../src/workflow/test-result-collector.ts";
import { createTempDir } from "../test/support/temp-dir.ts";

const ENGINE = join(import.meta.dirname, "..");
const CHECKOUT = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: ENGINE, encoding: "utf8" }).trim();
const CANARY = "test/process/confinement-canary.test.ts";
/** This process's environment without its node:test context: a nested `node --test` inheriting it runs no file. */
const RUNNER_ENV: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "NODE_TEST_CONTEXT"));
const WRITE_CHECKOUT = `try { require("node:fs").writeFileSync(${JSON.stringify(join(CHECKOUT, ".door-canary-probe"))}, "x"); console.log("canary=WROTE"); } catch (e) { console.log("canary=" + e.code); }`;

test("the guard runner (test-guards.ts) runs a hermetic file confined: the engine canary passes", () => {
  const run = spawnSync(process.execPath, ["--experimental-strip-types", join(ENGINE, "scripts", "tooling", "test-guards.ts"), CANARY], { cwd: ENGINE, encoding: "utf8", env: RUNNER_ENV });
  assert.equal(run.status, 0, `the canary failed under the guard runner:\n${run.stdout.slice(-1500)}${run.stderr.slice(-800)}`);
  assert.match(run.stdout, /pass 2\b/u, `the canary's two tests did not run:\n${run.stdout.slice(-800)}`);
});

test("`harness slot run` (the door of coverage, test:raw, test:supported, the browser routes and the perf profile) runs its command confined", () => {
  const run = spawnSync(process.execPath, ["--experimental-strip-types", join(ENGINE, "src", "cli.ts"), "harness", "slot", "run", "--", process.execPath, "-e", WRITE_CHECKOUT], { cwd: ENGINE, encoding: "utf8", env: RUNNER_ENV });
  assert.match(run.stdout, /^canary=EROFS$/mu, `${run.stdout.slice(-800)}${run.stderr.slice(-800)}`);
});

test("the flake door's test run (`runReproductionTests`, what `harness flake reproduce` runs on each side) runs the named tests confined", async () => {
  const name = "a test cannot write the checkout: the kernel refuses it (EROFS)";
  const request = parseFlakeReproduceArgs(["reproduce", "--suite", "engine", "--fix", "HEAD", "--test", `${CANARY}::${name}`, "--cause", CANARY]);
  // As the CLI runs it: from no node:test process (a nested `node --test` inheriting this file's context runs nothing).
  const context = process.env["NODE_TEST_CONTEXT"];
  delete process.env["NODE_TEST_CONTEXT"];
  let report: Record<string, unknown>;
  try {
    ({ report } = await runReproductionTests(CHECKOUT, "engine", request, null, [CANARY], ensureTestProcessSupervisor(), readTestExecutionConfig(ENGINE).engineSuiteWatchdog));
  } finally {
    if (context !== undefined) process.env["NODE_TEST_CONTEXT"] = context;
  }
  assert.equal((report[`${CANARY}::${name}`] as { outcome?: string } | undefined)?.outcome, "passed", JSON.stringify(report));
  for (const [identity, outcome] of Object.entries(report)) assert.equal((outcome as { outcome: string }).outcome, "passed", identity);
});

test("the shard manifest's listing (scripts/testing/test-listing.mjs) runs vitest confined: a listing whose vitest writes its checkout is refused that write", async () => {
  // A project of the test's own whose vitest entry tries to write its checkout and prints the listing it got to.
  const project = createTempDir("door-canary-listing-");
  symlinkSync(ENGINE, join(project, "engine"));
  mkdirSync(join(project, "node_modules", "vitest"), { recursive: true });
  writeFileSync(join(project, "node_modules", "vitest", "vitest.mjs"),
    `import { writeFileSync } from "node:fs"; let code = "WROTE"; try { writeFileSync("written-by-listing", "x"); } catch (e) { code = e.code; } console.log(JSON.stringify([{ file: code }]));`);
  const listing: string = new URL("../../scripts/testing/test-listing.mjs", import.meta.url).href;
  const { listThroughTheDoor } = await import(listing) as { listThroughTheDoor: (root: string) => Promise<{ stdout: string }> };
  const listed = await listThroughTheDoor(project);
  assert.deepEqual(JSON.parse(listed.stdout), [{ file: "EROFS" }], listed.stdout);
});
