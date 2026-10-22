/**
 * ONE CELL AND THE SEAL — a cell runs only on its planned tree and writes its
 * result on every ending; a web shard is judged by its report's rows; the
 * seal merges every result into one receipt and refuses each way a run can
 * lie about what it covered (missing, duplicate, unexpected, wrong-commit,
 * failed, other files, an action gate on the wrong event).
 *
 * Every refusal the old shard merge (`scripts/test-shard-merge.mjs`) made is
 * here, judged by the gates owner: a failed or skipped test, an absent count,
 * a failed suite under a green summary, an omitted row, a passed row with a
 * failure message, a file with no assertions, a duplicate, a missing or an
 * unexpected file, a path outside the checkout.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { GATE_CATALOGUE } from "../../../src/workflow/gates/catalogue.ts";
import { planGates, type GatePlan } from "../../../src/workflow/gates/plan.ts";
import type { CheckoutCommand, CheckoutStep } from "../../../src/workflow/checkout-setup.ts";
import { engineFailureReport, registryCommand, runLightGate, runShard, type GateResult, type RunEnvironment } from "../../../src/workflow/gates/cell-run.ts";
import { parseJobOutcomes, readResults, renderReceipt, sealReceipt } from "../../../src/workflow/gates/seal.ts";
import { judgeVitestReport } from "../../../src/workflow/gates/vitest-report.ts";
import { createTempDir } from "../../support/temp-dir.ts";

const HEAD = "a".repeat(40);
const TREE = "b".repeat(40);
const ROOT = "/checkout";

function plan(webFiles = 6, engineFiles = 2): GatePlan {
  const files = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => `${prefix}/f${index}.test.ts`);
  return planGates({
    headSha: HEAD,
    treeId: TREE,
    populations: [
      { population: "web-tests", source: "planted", files: files("tests/unit", webFiles), excluded: [{ path: "tests/unit/x.test.ts", reason: "planted reason", evidence: "planted evidence" }] },
      { population: "engine-tests", source: "planted", files: files("engine/test", engineFiles), excluded: [] },
    ],
  });
}

type Ran = Readonly<{ name: string; argv: readonly string[]; cwd: string }>;

/** The registry the tests run against: the gates' own command names, with planted argv. */
const REGISTRY: Readonly<Record<string, CheckoutCommand>> = Object.fromEntries(
  ["web-typecheck", "engine-typecheck", "engine-check", "secret-scan", "docs-links", "public-tests", "web-build", "guardian", "guardian-tests", "guardian-pass-log", "web-shard", "engine-cell", "bundle"]
    .map((name) => [name, { cwd: name.startsWith("guardian") ? "engine/guardian" : ".", argv: ["planted", name], timeoutMs: 1000 }]),
);

function step(name: string, status: CheckoutStep["status"], logPath: string, cpuUs = 1234): CheckoutStep {
  return {
    step: name, status, message: `${name} ${status}`, details: [],
    ...(status === "fail" ? { failure: "failed" as const } : {}),
    evidence: { argv: [], cwd: ".", attempts: 1, durationMs: 1, load: null, parallelism: 1, logPath, terminal: { exitCode: status === "pass" ? 0 : 1, ending: "exited", elapsedMs: 1, supervision: { commandPid: 1, status: 0, timedOut: false, interrupted: false, reaped: [], commandKilled: false, waitedCpuUs: cpuUs, supervisorCpuUsBeforeReceipt: 0, killed: [], noOwnedChildren: true }, orphanedGroupKilled: false, status: 0, signal: null, outputComplete: true } },
  };
}

function environment(out: string, failing: ReadonlySet<string> = new Set(), identity = { headSha: HEAD, treeId: TREE }, onRun?: (ran: Ran) => void): RunEnvironment & { ran: Ran[] } {
  const ran: Ran[] = [];
  return {
    repositoryRoot: ROOT,
    outDirectory: out,
    registry: REGISTRY,
    identity: () => identity,
    ran,
    run: async (name, command) => {
      const entry = { name, argv: command.argv, cwd: command.cwd };
      ran.push(entry);
      onRun?.(entry);
      return step(name, failing.has(name) ? "fail" : "pass", `/logs/${name}.log`);
    },
  };
}

// ── a light gate ──────────────────────────────────────────────────────────

test("a light gate runs its registry commands in order through the runner, and writes a passed result", async () => {
  const out = createTempDir("gates-cell-");
  const env = environment(out);
  const result = await runLightGate(plan(), "guardian", env);
  assert.equal(result.status, "passed");
  assert.deepEqual(env.ran.map((entry) => entry.name), GATE_CATALOGUE.find((gate) => gate.id === "guardian")!.commands.map((entry) => entry.command));
  assert.deepEqual(env.ran[2]!.argv, ["planted", "guardian-pass-log", "/logs/guardian-tests.log"], "the pass-log check takes the test run's full log");
  assert.deepEqual(env.ran[0]!.argv, ["planted", "guardian"], "a command without logOf runs as declared");
  assert.deepEqual(result.steps.map((entry) => entry.cpuUs), [1234, 1234, 1234], "each command's process-tree CPU time is recorded");
  const written = JSON.parse(readFileSync(join(out, "guardian.result.json"), "utf8")) as GateResult;
  assert.deepEqual(written, JSON.parse(JSON.stringify(result)));
  assert.equal(written.headSha, HEAD);
  assert.equal(written.treeId, TREE);
});

test("the first failing command ends the cell, and the result names it", async () => {
  const out = createTempDir("gates-cell-");
  const env = environment(out, new Set(["guardian-tests"]));
  const result = await runLightGate(plan(), "guardian", env);
  assert.equal(result.status, "failed");
  assert.equal(env.ran.length, 2);
  assert.equal(result.steps.at(-1)!.command, "guardian-tests");
  assert.equal(result.steps.at(-1)!.failure, "failed");
});

test("a command the registry does not declare is a typed refusal", async () => {
  assert.throws(() => registryCommand(REGISTRY, "no-such-command"), (error: unknown) => (error as { code?: string }).code === "gate_command_undeclared");
  const out = createTempDir("gates-cell-");
  const env = { ...environment(out), registry: {} };
  await assert.rejects(runLightGate(plan(), "docs-links", env), (error: unknown) => (error as { code?: string }).code === "gate_command_undeclared");
});

test("a job on another tree runs nothing and writes a refused result", async () => {
  const out = createTempDir("gates-cell-");
  const env = environment(out, new Set(), { headSha: HEAD, treeId: "c".repeat(40) });
  const result = await runLightGate(plan(), "docs-links", env);
  assert.equal(result.status, "failed");
  assert.match(result.refusal ?? "", /is not the planned tree/u);
  assert.equal(env.ran.length, 0);
});

test("only a planned light gate runs as a step list", async () => {
  const out = createTempDir("gates-cell-");
  await assert.rejects(runLightGate(plan(), "web-suite", environment(out)), (error: unknown) => (error as { code?: string }).code === "gate_not_runnable");
  await assert.rejects(runLightGate(plan(), "no-such-gate", environment(out)), (error: unknown) => (error as { code?: string }).code === "gate_unknown");
});

// ── the vitest report ─────────────────────────────────────────────────────

function report(files: readonly string[], overrides: Record<string, unknown> = {}, rowOverride?: (row: Record<string, unknown>, index: number) => void): Record<string, unknown> {
  const rows = files.map((file, index) => {
    const row: Record<string, unknown> = { name: `/home/runner/work/x/x/${file}`, status: "passed", message: "", assertionResults: [{ status: "passed", failureMessages: [] }, { status: "passed", failureMessages: [] }] };
    rowOverride?.(row, index);
    return row;
  });
  const total = rows.reduce((sum, row) => sum + (row.assertionResults as unknown[]).length, 0);
  return { success: true, numFailedTests: 0, numFailedTestSuites: 0, numPendingTests: 0, numTodoTests: 0, numTotalTests: total, numPassedTests: total, testResults: rows, ...overrides };
}

test("a green report whose rows record exactly the planned files passes, counted from the rows", () => {
  const files = ["tests/unit/a.test.ts", "tests/unit/b.test.ts"];
  const judged = judgeVitestReport(report(files), ROOT, files);
  assert.deepEqual(judged, { ok: true, files: [{ path: files[0], tests: 2 }, { path: files[1], tests: 2 }], tests: 4 });
  assert.equal(judgeVitestReport(report(files.map((file) => `${ROOT}/${file}`)), ROOT, files).ok, true, "a path inside the checkout is taken as is");
});

test("every way a report can claim more than it records is refused", () => {
  const files = ["tests/unit/a.test.ts", "tests/unit/b.test.ts"];
  const cases: Readonly<Record<string, Record<string, unknown>>> = {
    "success=false": report(files, { success: false }),
    "a failed test": report(files, { numFailedTests: 1 }),
    "a failed suite": report(files, { numFailedTestSuites: 1 }),
    "a skipped test": report(files, { numPendingTests: 1 }),
    "a todo test": report(files, { numTodoTests: 1 }),
    "an absent failed-suite count": report(files, { numFailedTestSuites: undefined }),
    "a fractional total": report(files, { numTotalTests: 3.5 }),
    "a string count": report(files, { numPassedTests: "4" }),
    "no rows": report(files, { testResults: undefined }),
    "a failed suite under a green summary": report(files, {}, (row, index) => { if (index === 0) row.status = "failed"; }),
    "a passed suite with a message": report(files, {}, (row, index) => { if (index === 0) row.message = "boom"; }),
    "a file with no assertions": report(files, { numTotalTests: 2, numPassedTests: 2 }, (row, index) => { if (index === 0) row.assertionResults = []; }),
    "a failed assertion": report(files, {}, (row, index) => { if (index === 0) row.assertionResults = [{ status: "failed" }, { status: "passed" }]; }),
    "a passed assertion with failure messages": report(files, {}, (row, index) => { if (index === 0) row.assertionResults = [{ status: "passed", failureMessages: ["x"] }, { status: "passed" }]; }),
    "a summary that declares more tests than the rows": report(files, { numTotalTests: 9, numPassedTests: 9 }),
    "an omitted row": report([files[0]!], { numTotalTests: 4, numPassedTests: 4 }),
    "a missing file": report([files[0]!]),
    "an unexpected file": report([...files, "tests/unit/c.test.ts"]),
    "a duplicate file": report([files[0]!, files[0]!, files[1]!]),
    "a path matching no planned file": report(["elsewhere/z.test.ts", files[1]!]),
  };
  for (const [name, candidate] of Object.entries(cases)) {
    const judged = judgeVitestReport(candidate, ROOT, files);
    assert.equal(judged.ok, false, name);
  }
  assert.equal(judgeVitestReport(null, ROOT, files).ok, false);
});

// ── a shard ───────────────────────────────────────────────────────────────

test("a web shard runs the web runner on exactly its files and passes only on its judged report", async () => {
  const gatePlan = plan();
  const cell = gatePlan.cells.find((entry) => entry.gate === "web-suite")!;
  const out = createTempDir("gates-shard-");
  const env = environment(out, new Set(), { headSha: HEAD, treeId: TREE }, ({ argv }) => {
    const outputFile = argv.find((argument) => argument.startsWith("--outputFile="))!.slice("--outputFile=".length);
    writeFileSync(outputFile, JSON.stringify(report(cell.files)));
  });
  const result = await runShard(gatePlan, cell.cell, env);
  assert.equal(result.status, "passed", result.refusal);
  assert.equal(env.ran[0]!.name, "web-shard");
  assert.deepEqual(env.ran[0]!.argv.slice(0, 2), ["planted", "web-shard"]);
  assert.deepEqual(env.ran[0]!.argv.slice(-cell.files.length), cell.files);
  assert.equal(result.suite?.tests, cell.files.length * 2);
  assert.deepEqual(result.suite?.files, cell.files);
});

test("a web shard whose runner exits 0 with a lying or absent report fails", async () => {
  const gatePlan = plan();
  const cell = gatePlan.cells.find((entry) => entry.gate === "web-suite")!;
  const lying = await runShard(gatePlan, cell.cell, environment(createTempDir("gates-shard-"), new Set(), { headSha: HEAD, treeId: TREE }, ({ argv }) => {
    const outputFile = argv.find((argument) => argument.startsWith("--outputFile="))!.slice("--outputFile=".length);
    writeFileSync(outputFile, JSON.stringify(report(cell.files.slice(1))));
  }));
  assert.equal(lying.status, "failed");
  assert.match(lying.refusal ?? "", /did not run/u);
  const absent = await runShard(gatePlan, cell.cell, environment(createTempDir("gates-shard-")));
  assert.equal(absent.status, "failed");
  assert.match(absent.refusal ?? "", /wrote no vitest report/u);
});

test("an engine cell lists its sources for the runner's --cell and passes only on the cell rule's summary", async () => {
  const gatePlan = plan();
  const cell = gatePlan.cells.find((entry) => entry.gate === "engine-suite")!;
  const root = createTempDir("gates-engine-");
  const summaryDirectory = join(root, "engine/.bridlewise/state/test-results");
  mkdirSync(summaryDirectory, { recursive: true });
  const run = async (summary: unknown, exitCode = 0) => {
    writeFileSync(join(summaryDirectory, "latest-summary.json"), JSON.stringify(summary));
    const out = createTempDir("gates-engine-out-");
    const env = { ...environment(out, exitCode === 0 ? new Set<string>() : new Set(["engine-cell"])), repositoryRoot: root };
    const result = await runShard(gatePlan, cell.cell, env);
    const listPath = join(out, `${cell.cell}.cell`);
    assert.deepEqual(env.ran.map((entry) => entry.argv), [["planted", "engine-cell", listPath]], "the cell's list appended to the registry command");
    assert.deepEqual(readFileSync(listPath, "utf8").trim().split("\n"), cell.files.map((path) => path.replace(/^engine\//u, "")), "engine-relative sources, as the inventory names them");
    return result;
  };
  const passed = await run({ status: "passed", testCount: 10_000, passCount: 40, failCount: 0 });
  assert.equal(passed.status, "passed", passed.refusal);
  assert.equal(passed.suite?.tests, 40, "the cell's own passed tests (the withheld rest is the other cells')");
  assert.equal((await run({ status: "failed", testCount: 10_000, passCount: 39, failCount: 1 })).status, "failed");
  // A red cell tells each failure with the message the summary recorded, and says when it recorded none (#149).
  assert.deepEqual(engineFailureReport({ failures: ["test/a.test.ts::refuses", "test/b.test.ts::counts"], failureMessages: { "test/a.test.ts::refuses": "AssertionError: expected 1\nto equal 2" }, reasons: ["test_failed"] }), [
    "FAILED test/a.test.ts::refuses", "    AssertionError: expected 1", "    to equal 2",
    "FAILED test/b.test.ts::counts", "    (the runner recorded no message for this failure)",
    "reason: test_failed",
  ]);
  assert.equal((await run({ status: "passed", testCount: 10_000, passCount: 40, failCount: 1 })).status, "failed");
  assert.equal((await run({ status: "passed", testCount: 10_000, passCount: 0, failCount: 0 })).status, "failed");
  assert.equal((await run({ status: "passed", testCount: 10_000, passCount: 40, failCount: 0 }, 1)).status, "failed");
});

// ── the seal ──────────────────────────────────────────────────────────────

function results(gatePlan: GatePlan): GateResult[] {
  const base = { schemaVersion: "bridlewise-gate-result/v1", catalogueDigest: gatePlan.catalogueDigest, headSha: gatePlan.headSha, treeId: gatePlan.treeId, startedAt: "2026-10-21T00:00:00.000Z", finishedAt: "2026-10-21T00:00:01.000Z", steps: [] } as const;
  return [
    ...GATE_CATALOGUE.filter((gate) => gate.class === "light").map((gate) => ({ ...base, gate: gate.id, cell: gate.id, status: "passed" as const })),
    ...gatePlan.cells.map((cell) => ({ ...base, gate: cell.gate, cell: cell.cell, status: "passed" as const, suite: { population: "x", files: cell.files, tests: cell.files.length, perFile: [] } })),
  ];
}

const SUCCESS = { "dependency-review": { result: "success" as const } };

test("every cell passed: one passed receipt that names the exclusions and the test count", () => {
  const gatePlan = plan();
  const receipt = sealReceipt({ plan: gatePlan, results: results(gatePlan), jobs: SUCCESS, event: "pull_request" });
  assert.equal(receipt.verdict, "passed", receipt.refusals.join("; "));
  assert.deepEqual(receipt.refusals, []);
  assert.equal(receipt.tests, 8);
  assert.deepEqual(receipt.exclusions, [{ population: "web-tests", path: "tests/unit/x.test.ts", reason: "planted reason", evidence: "planted evidence" }]);
  assert.match(renderReceipt(receipt), /## Gates: passed/u);
  // On the merge queue the dependency review does not run, and must not.
  const queued = sealReceipt({ plan: gatePlan, results: results(gatePlan), jobs: { "dependency-review": { result: "skipped" } }, event: "merge_group" });
  assert.equal(queued.verdict, "passed", queued.refusals.join("; "));
  assert.equal(queued.gates.find((gate) => gate.id === "dependency-review")!.status, "not-run");
});

test("each way a run can lie about its coverage fails the seal", () => {
  const gatePlan = plan();
  const all = results(gatePlan);
  const without = (cell: string) => all.filter((result) => result.cell !== cell);
  const cases: Readonly<Record<string, Parameters<typeof sealReceipt>[0]>> = {
    "a missing light result": { plan: gatePlan, results: without("typecheck-web"), jobs: SUCCESS, event: "pull_request" },
    "a missing shard": { plan: gatePlan, results: without("web-suite-1"), jobs: SUCCESS, event: "pull_request" },
    "a duplicate result": { plan: gatePlan, results: [...all, all[0]!], jobs: SUCCESS, event: "pull_request" },
    "an unexpected cell": { plan: gatePlan, results: [...all, { ...all[0]!, cell: "web-suite-99", gate: "web-suite" }], jobs: SUCCESS, event: "pull_request" },
    "another commit": { plan: gatePlan, results: all.map((result, index) => (index === 0 ? { ...result, headSha: "c".repeat(40) } : result)), jobs: SUCCESS, event: "pull_request" },
    "another catalogue": { plan: gatePlan, results: all.map((result, index) => (index === 0 ? { ...result, catalogueDigest: "d".repeat(64) } : result)), jobs: SUCCESS, event: "pull_request" },
    "a failed cell": { plan: gatePlan, results: all.map((result) => (result.cell === "docs-links" ? { ...result, status: "failed" as const, steps: [{ command: "docs-links", status: "fail" as const, message: "x", cpuUs: 1 }] } : result)), jobs: SUCCESS, event: "pull_request" },
    "a shard that ran other files": { plan: gatePlan, results: all.map((result) => (result.cell === "web-suite-1" ? { ...result, suite: { ...result.suite!, files: ["tests/unit/other.test.ts"] } } : result)), jobs: SUCCESS, event: "pull_request" },
    "a result of another shape": { plan: gatePlan, results: [...all, { schemaVersion: "x" }], jobs: SUCCESS, event: "pull_request" },
    "an unreadable result": { plan: gatePlan, results: [...all, { unreadable: "x.result.json" }], jobs: SUCCESS, event: "pull_request" },
    "a failed dependency review": { plan: gatePlan, results: all, jobs: { "dependency-review": { result: "failure" } }, event: "pull_request" },
    "a dependency review with no job result": { plan: gatePlan, results: all, jobs: {}, event: "pull_request" },
    "a dependency review on an event it does not run on": { plan: gatePlan, results: all, jobs: SUCCESS, event: "merge_group" },
    "a plan whose shards double-cover a file": { plan: { ...gatePlan, cells: gatePlan.cells.map((cell, index) => (index === 1 ? { ...cell, files: [...cell.files, gatePlan.cells[0]!.files[0]!] } : cell)) }, results: all, jobs: SUCCESS, event: "pull_request" },
    "a plan whose shards miss a population file": { plan: { ...gatePlan, populations: gatePlan.populations.map((listing) => (listing.population === "web-tests" ? { ...listing, files: [...listing.files, "tests/unit/uncovered.test.ts"] } : listing)) }, results: all, jobs: SUCCESS, event: "pull_request" },
  };
  for (const [name, inputs] of Object.entries(cases)) {
    assert.equal(sealReceipt(inputs).verdict, "failed", name);
  }
});

test("a signal gate's failure is recorded and shown, never judged", () => {
  const gatePlan = plan();
  const catalogue = GATE_CATALOGUE.map((gate) => (gate.id === "docs-links" ? { ...gate, role: "signal" as const } : gate));
  const failing = results(gatePlan).map((result) => (result.cell === "docs-links" ? { ...result, status: "failed" as const, steps: [{ command: "docs-links", status: "fail" as const, message: "x", cpuUs: 1 }] } : result));
  const receipt = sealReceipt({ plan: gatePlan, results: failing, jobs: SUCCESS, event: "pull_request", catalogue });
  assert.equal(receipt.verdict, "passed");
  assert.equal(receipt.gates.find((gate) => gate.id === "docs-links")!.status, "failed");
});

test("the seal reads every result under the folder, and the job outcomes from toJSON(needs)", () => {
  const directory = createTempDir("gates-seal-");
  mkdirSync(join(directory, "light"));
  writeFileSync(join(directory, "light/a.result.json"), JSON.stringify({ cell: "a" }));
  writeFileSync(join(directory, "b.result.json"), "{not json");
  writeFileSync(join(directory, "b.log"), "ignored");
  assert.deepEqual(readResults(directory), [{ unreadable: "b.result.json" }, { cell: "a" }]);
  assert.deepEqual(parseJobOutcomes(JSON.stringify({ light: { result: "success", outputs: {} }, shard: { result: "skipped" } })), { light: { result: "success" }, shard: { result: "skipped" } });
  assert.deepEqual(parseJobOutcomes(undefined), {});
  for (const bad of ["{", "[]", JSON.stringify({ light: { result: "unknown" } })]) {
    assert.throws(() => parseJobOutcomes(bad), (error: unknown) => (error as { code?: string }).code === "gate_seal_input_invalid");
  }
});
