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
import { existsSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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

test("`harness slot run` (the door of coverage, test:raw, test:supported, the browser routes and the perf profile) runs its command confined", (t) => {
  // Under a regression the probe WOULD land in the checkout: it goes with the test either way.
  t.after(() => { try { unlinkSync(join(CHECKOUT, ".door-canary-probe")); } catch { /* absent: the write was refused */ } });
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

test("an inherited run-scratch variable is refused outside a confined run: a launcher cannot name its own writable scratch (round 2, #12, #13)", () => {
  // A folder outside the checkout the launcher would have had bound writable on the variable's word.
  const named = createTempDir("door-canary-inherited-scratch-");
  const run = spawnSync(process.execPath, ["--experimental-strip-types", join(ENGINE, "scripts", "tooling", "test-guards.ts"), CANARY], { cwd: ENGINE, encoding: "utf8", env: { ...RUNNER_ENV, BRIDLEWISE_TEST_SCRATCH: named } });
  assert.notEqual(run.status, 0, `the run started on an inherited scratch:\n${run.stdout.slice(-800)}`);
  assert.match(`${run.stdout}${run.stderr}`, /test_run_scratch_unconfined/u);
});

test("THE RUN'S CGROUP in a capped scope (`harness slot run`, #564's per-run cap; review of #734): the run cannot write its limits, can make and enter a worker leaf, and its supervisor is outside its namespace", () => {
  // The run's parent is its native supervisor; each limit file is written with the value it holds.
  const script = [
    "root=/sys/fs/cgroup",
    "echo \"cgroup=$(cat /proc/self/cgroup)\"",
    "for f in cgroup.freeze memory.max memory.swap.max pids.max cpu.weight cpu.max; do [ -e $root/$f ] || continue; if (cat $root/$f > $root/$f) 2>/dev/null; then echo \"limit-written=$f\"; else echo \"limit-refused=$f\"; fi; done",
    "if mkdir $root/worker-1 && echo $$ > $root/worker-1/cgroup.procs; then echo \"worker=$(cat /proc/self/cgroup)\"; echo $$ > $root/cgroup.procs; rmdir $root/worker-1; fi",
    "if grep -qx \"$PPID\" $root/cgroup.procs; then echo supervisor=inside; else echo supervisor=outside; fi",
  ].join("\n");
  const run = spawnSync(process.execPath, ["--experimental-strip-types", join(ENGINE, "src", "cli.ts"), "harness", "slot", "run", "--", "sh", "-c", script], { cwd: ENGINE, encoding: "utf8", env: RUNNER_ENV });
  const said = `${run.stdout.slice(-1500)}${run.stderr.slice(-800)}`;
  assert.match(run.stdout, /^cgroup=0::\/$/mu, said);
  assert.match(run.stdout, /^limit-refused=cgroup\.freeze$/mu, said);
  assert.doesNotMatch(run.stdout, /^limit-written=/mu, said);
  assert.match(run.stdout, /^worker=0::\/worker-1$/mu, said);
  assert.match(run.stdout, /^supervisor=outside$/mu, said);
});

test("the live door's child loads no module named by an inherited NODE_OPTIONS (round 3, must-fix 2)", () => {
  // The probe marks every process but the door's own (which loads it too, being started with that NODE_OPTIONS):
  // the live child, and the process node:test starts for each file.
  const folder = createTempDir("door-canary-node-options-");
  const marker = join(folder, "loaded-in-the-live-child");
  const probe = join(folder, "probe.mjs");
  writeFileSync(probe, `import { writeFileSync } from "node:fs"; if (!process.argv.some((arg) => arg.endsWith("test-guards.ts"))) writeFileSync(${JSON.stringify(marker)}, String(process.pid));\n`);
  const run = spawnSync(process.execPath, ["--experimental-strip-types", join(ENGINE, "scripts", "tooling", "test-guards.ts"), "--test-name-pattern=^no test has this name$", "live/long-task-runner.test.ts"],
    { cwd: ENGINE, encoding: "utf8", env: { ...RUNNER_ENV, NODE_OPTIONS: `--import=${probe}` } });
  assert.equal(run.status, 0, `${run.stdout.slice(-800)}${run.stderr.slice(-800)}`);
  assert.equal(existsSync(marker), false, "the live child loaded the module an inherited NODE_OPTIONS named");
});
