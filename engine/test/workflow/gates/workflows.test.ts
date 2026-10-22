/**
 * THE WORKFLOW GENERATOR — `.github/workflows/` is wholly the gate
 * catalogue's output:
 *
 *   - the live tree holds exactly the generated files, byte for byte (what
 *     `harness check`'s generated-workflows step asserts);
 *   - a planted hand edit, a deleted file and a foreign file are each drift,
 *     named by path, and the check step FAILS on them (runbook P3.1's check);
 *   - `harness sync`'s write arm repairs all three (and deletes the foreign
 *     file), after which the folder is current;
 *   - every generated workflow passes the generator's own lint, and each lint
 *     refuses its planted violation (an unpinned action, an expression in
 *     `run:`, `pull_request_target`, a pull-request workflow without
 *     `merge_group`, a cancelling non-PR group, a shared group without
 *     `queue: max`, a job without permissions).
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import { GENERATED_WORKFLOW_FILES } from "../../../src/kernel/verification-paths.ts";
import { generatedWorkflowsStep } from "../../../src/workflow/harness-commands.ts";
import { catalogueCommandNames, GATE_CATALOGUE } from "../../../src/workflow/gates/catalogue.ts";
import {
  auditWorkflow,
  ciWorkflow,
  failureIssueWorkflow,
  forkSafetyViolations,
  promotionGateWorkflow,
  reusableFailureWorkflow,
  codeqlWorkflow,
  doorWorkflow,
  GENERATED_HEADER,
  GENERATED_WORKFLOW_PATHS,
  lintWorkflow,
  lintWorkflowSet,
  publishWorkflow,
  syncGeneratedWorkflows,
  workflowText,
} from "../../../src/workflow/gates/workflows.ts";
import { DOOR_PREDICATE_TYPE } from "../../../src/workflow/gates/reuse.ts";
import { Commented } from "../../../src/text/yaml-emit.ts";
import { createTempDir } from "../../support/temp-dir.ts";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../../..");

function refusedWith(code: string): (error: unknown) => boolean {
  return (error: unknown) => (error as { code?: string }).code === code;
}

/** A scratch repository holding the generated workflows (and nothing else). */
function generatedTree(): string {
  const root = createTempDir("gates-workflows-");
  const report = syncGeneratedWorkflows(root, true);
  assert.equal(report.status, "regenerated");
  assert.deepEqual(report.changed, GENERATED_WORKFLOW_PATHS);
  return root;
}

test("the generator's file list is the one declaration (verification-paths), and every file starts with the header", () => {
  assert.deepEqual(GENERATED_WORKFLOW_PATHS, GENERATED_WORKFLOW_FILES.files.map((file) => `${GENERATED_WORKFLOW_FILES.directory}/${file}`).toSorted());
  for (const path of GENERATED_WORKFLOW_PATHS) {
    const text = workflowText(path.split("/").at(-1)!);
    assert.ok(text.startsWith(`${GENERATED_HEADER}\n`), path);
    assert.equal(text, workflowText(path.split("/").at(-1)!), `${path} is deterministic`);
  }
});

test("the live tree's workflow folder is exactly the generator's output", () => {
  const report = syncGeneratedWorkflows(REPOSITORY_ROOT, false);
  assert.deepEqual(report, { allCurrent: true, status: "current", changed: [] }, "run harness sync: the committed workflows drifted from the gate catalogue");
});

test("a planted hand edit is drift, the check step fails naming it, and sync repairs it", () => {
  const root = generatedTree();
  assert.equal(syncGeneratedWorkflows(root, false).status, "current");
  const ci = join(root, ".github/workflows/ci.yml");
  writeFileSync(ci, readFileSync(ci, "utf8").replace("timeout-minutes: 60", "timeout-minutes: 600"));
  const stale = syncGeneratedWorkflows(root, false);
  assert.deepEqual(stale, { allCurrent: false, status: "stale", changed: [".github/workflows/ci.yml"] });
  const step = generatedWorkflowsStep({ status: stale.status, converged: stale.allCurrent, changed: stale.changed });
  assert.equal(step.status, "fail");
  assert.match(step.message, /\.github\/workflows\/ci\.yml/u);
  assert.match(step.message, /edit engine\/src\/workflow\/gates\//u);
  assert.equal(syncGeneratedWorkflows(root, true).status, "regenerated");
  assert.equal(syncGeneratedWorkflows(root, false).status, "current");
  assert.equal(readFileSync(ci, "utf8"), workflowText("ci.yml"));
});

test("a deleted workflow and a hand-added workflow are drift; sync restores the one and deletes the other", () => {
  const root = generatedTree();
  rmSync(join(root, ".github/workflows/codeql.yml"));
  writeFileSync(join(root, ".github/workflows/extra.yml"), "name: hand-written\n");
  const stale = syncGeneratedWorkflows(root, false);
  assert.deepEqual(stale.changed, [".github/workflows/codeql.yml", ".github/workflows/extra.yml"]);
  assert.equal(generatedWorkflowsStep({ status: stale.status, converged: stale.allCurrent, changed: stale.changed }).status, "fail");
  syncGeneratedWorkflows(root, true);
  assert.ok(existsSync(join(root, ".github/workflows/codeql.yml")));
  assert.ok(!existsSync(join(root, ".github/workflows/extra.yml")));
  assert.equal(syncGeneratedWorkflows(root, false).status, "current");
});

test("a tree with no workflow folder is stale (the folder is never an opt-out), and the write creates it", () => {
  const root = createTempDir("gates-workflows-empty-");
  mkdirSync(join(root, ".github"), { recursive: true });
  const stale = syncGeneratedWorkflows(root, false);
  assert.equal(stale.status, "stale");
  assert.deepEqual(stale.changed, GENERATED_WORKFLOW_PATHS);
  syncGeneratedWorkflows(root, true);
  assert.equal(syncGeneratedWorkflows(root, false).status, "current");
});

test("every generated workflow passes the lint", () => {
  for (const [name, build] of [["ci.yml", ciWorkflow], ["codeql.yml", codeqlWorkflow], ["door.yml", doorWorkflow], ["publish.yml", publishWorkflow], ["audit.yml", auditWorkflow]] as const) {
    assert.doesNotThrow(() => lintWorkflow(name, build()), name);
  }
});

type Mutable = Record<string, unknown>;

function plant(mutate: (workflow: Mutable) => void): Mutable {
  const workflow = structuredClone(ciWorkflow()) as Mutable;
  // structuredClone drops the Commented class; restore the pins so only the planted violation differs.
  const real = ciWorkflow() as Mutable;
  const jobs = workflow.jobs as Record<string, Mutable>;
  for (const [id, job] of Object.entries(jobs)) {
    const steps = (job.steps ?? []) as Mutable[];
    const realSteps = ((real.jobs as Record<string, Mutable>)[id]!.steps ?? []) as Mutable[];
    steps.forEach((step, index) => {
      if (realSteps[index]!.uses !== undefined) step.uses = realSteps[index]!.uses;
    });
  }
  mutate(workflow);
  return workflow;
}

test("each lint refuses its planted violation", () => {
  const cases: Readonly<Record<string, (workflow: Mutable) => void>> = {
    "pull_request_target": (workflow) => { (workflow.on as Mutable).pull_request_target = {}; },
    "merge_group missing": (workflow) => { delete (workflow.on as Mutable).merge_group; },
    "no workflow permissions": (workflow) => { delete workflow.permissions; },
    "no concurrency": (workflow) => { delete workflow.concurrency; },
    "a group that always cancels": (workflow) => { (workflow.concurrency as Mutable)["cancel-in-progress"] = true; },
    "a shared group without queue: max": (workflow) => { workflow.concurrency = { group: "ci" }; },
    "a job without permissions": (workflow) => { delete ((workflow.jobs as Record<string, Mutable>).light!).permissions; },
    "a branch filter on pull_request": (workflow) => { (workflow.on as Mutable).pull_request = { branches: ["main"] }; },
    "a type filter on merge_group": (workflow) => { (workflow.on as Mutable).merge_group = { types: ["checks_requested"] }; },
    "a path filter on push": (workflow) => { (workflow.on as Mutable).push = { branches: ["main"], paths: ["src/**"] }; },
    "a push on another branch": (workflow) => { (workflow.on as Mutable).push = { branches: ["develop"] }; },
    "an expression inside run:": (workflow) => { (((workflow.jobs as Record<string, Mutable>).light!).steps as Mutable[]).push({ name: "x", run: "echo ${{ github.event.pull_request.title }}" }); },
    "an action without its pin comment": (workflow) => { (((workflow.jobs as Record<string, Mutable>).light!).steps as Mutable[]).push({ uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1" }); },
    "an action pinned to a SHA the table does not hold": (workflow) => { (((workflow.jobs as Record<string, Mutable>).light!).steps as Mutable[]).push({ uses: new Commented("actions/checkout@0000000000000000000000000000000000000000", "v7") }); },
    "an action pinned to a tag": (workflow) => { (((workflow.jobs as Record<string, Mutable>).light!).steps as Mutable[]).push({ uses: new Commented("actions/checkout@v7", "v7") }); },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    assert.throws(() => lintWorkflow("ci.yml", plant(mutate) as never), refusedWith("workflow_lint_refused"), name);
  }
  // The near miss: an expression passed through env: is the allowed spelling.
  assert.doesNotThrow(() => lintWorkflow("ci.yml", plant((workflow) => {
    (((workflow.jobs as Record<string, Mutable>).light!).steps as Mutable[]).push({ name: "x", env: { TITLE: "${{ github.event.pull_request.title }}" }, run: "echo \"$TITLE\"" });
  }) as never));
});

test("ci.yml: plan and seal run the harness on a VM (never the slim container); the light gates run in turn, each even after a failure; the seal always runs and needs every job", () => {
  const ci = ciWorkflow() as Mutable;
  const jobs = ci.jobs as Record<string, Mutable>;
  assert.equal(jobs.plan!["runs-on"], "ubuntu-24.04");
  assert.equal(jobs.seal!["runs-on"], "ubuntu-24.04");
  assert.ok(Object.values(jobs).every((job) => job["runs-on"] !== "ubuntu-slim"), "no CI job runs the harness in the slim container");
  assert.equal(jobs.seal!.if, "${{ always() }}");
  assert.deepEqual(jobs.seal!.needs, Object.keys(jobs).filter((id) => id !== "seal"));
  const lightSteps = jobs.light!.steps as Mutable[];
  assert.ok(lightSteps.every((step) => step.background === undefined), "no background step: the gates share one checkout");
  const gateRuns = lightSteps.filter((step) => /harness gates run /u.test(String(step.run)));
  assert.deepEqual(gateRuns.map((step) => String(step.run).split(" ")[5]), GATE_CATALOGUE.filter((gate) => gate.class === "light").map((gate) => gate.id));
  assert.ok(gateRuns.every((step) => step.if === "${{ !cancelled() }}"));
  const uploadIndex = lightSteps.findIndex((step) => step.name === "Upload the gate results");
  assert.ok(uploadIndex > lightSteps.indexOf(gateRuns.at(-1)!));
  assert.equal(lightSteps[uploadIndex]!.if, "${{ always() }}");
  // Registry setup runs through the harness, once per command the job's gates need.
  const setups = lightSteps.filter((step) => /harness gates setup /u.test(String(step.run))).map((step) => String(step.run).split(" ").at(-1));
  assert.deepEqual(setups, [...new Set(GATE_CATALOGUE.filter((gate) => gate.class === "light").flatMap((gate) => gate.setup))]);
  // Every action gate is its own job, gated to its events.
  for (const gate of GATE_CATALOGUE.filter((entry) => entry.class === "action")) {
    assert.ok(jobs[gate.id] !== undefined, gate.id);
    assert.match(String(jobs[gate.id]!.if), /github\.event_name == 'pull_request'/u);
  }
  // A suite toolchain one suite does not need runs only for the cells that do.
  const corpus = (jobs.shard!.steps as Mutable[]).find((step) => String(step.name).startsWith("Fetch and verify the pinned corpus"));
  assert.match(String(corpus?.if), /contains\(fromJSON\('\["engine-suite"\]'\), matrix\.gate\)/u);
  const compiler = (jobs.shard!.steps as Mutable[]).find((step) => step.name === "Install the pinned compiler");
  assert.equal(compiler?.if, undefined, "every cell builds the runner's supervisor with the pinned compiler");
});

test("publish.yml queues every land and never cancels; codeql covers the three languages with security-extended", () => {
  const publish = publishWorkflow() as Mutable;
  assert.deepEqual(publish.concurrency, { group: "publish-main", queue: "max" });
  const codeql = codeqlWorkflow() as Mutable;
  const analyze = (codeql.jobs as Record<string, Mutable>).analyze!;
  const languages = ((analyze.strategy as Mutable).matrix as { include: readonly Mutable[] }).include.map((cell) => cell.language);
  assert.deepEqual(languages, ["javascript-typescript", "actions", "c-cpp"]);
  const init = (analyze.steps as Mutable[]).find((step) => step.name === "Initialize CodeQL")!;
  assert.equal((init.with as Mutable).queries, "security-extended");
  assert.ok("merge_group" in (codeql.on as Mutable));
});

test("every command the catalogue runs is declared in the live command registry (one registry, one runner)", () => {
  const config = JSON.parse(readFileSync(join(REPOSITORY_ROOT, "engine/bridlewise.config.json"), "utf8")) as { workspaceIsolation: { commands: Record<string, unknown> } };
  const declared = new Set(Object.keys(config.workspaceIsolation.commands));
  const missing = catalogueCommandNames().filter((name) => !declared.has(name));
  assert.deepEqual(missing, []);
  assert.ok(catalogueCommandNames().includes("guardian-pass-log"));
});

test("no two generated workflows share a concurrency group prefix (one would cancel the other's runs)", () => {
  assert.doesNotThrow(() => lintWorkflowSet({ "ci.yml": ciWorkflow(), "codeql.yml": codeqlWorkflow(), "publish.yml": publishWorkflow(), "audit.yml": auditWorkflow(), "door.yml": doorWorkflow() }));
  assert.throws(() => lintWorkflowSet({ "ci.yml": ciWorkflow(), "copy.yml": ciWorkflow() }), refusedWith("workflow_lint_refused"));
});

test("door.yml is the trusted judge: main's code on workflow_run, its key only in the door environment, id-token only to attest", () => {
  const door = doorWorkflow() as Mutable;
  assert.deepEqual(Object.keys(door.on as Mutable).toSorted(), ["check_run", "workflow_run"], "no pull_request, push or merge_group: the door never runs a pull request's code");
  assert.deepEqual(((door.on as Mutable).workflow_run as Mutable).workflows, ["CI"]);
  assert.deepEqual(door.permissions, {}, "nothing by default; each job states its own");
  const jobs = door.jobs as Record<string, Mutable>;
  for (const [id, job] of Object.entries(jobs)) {
    assert.equal(job.environment, "door", `${id} reaches the door key only through the door environment`);
    assert.equal(job["runs-on"], "ubuntu-24.04");
    const permissions = job.permissions as Mutable;
    assert.equal(permissions["id-token"] === "write", id === "judge", `${id}: id-token only for the attestation`);
  }
  const judge = jobs.judge!.steps as Mutable[];
  const downloads = judge.filter((step) => step.uses instanceof Commented && (step.uses as Commented).value.startsWith("actions/download-artifact@"));
  const ofTheRun = downloads.filter((step) => (step.with as Mutable)["run-id"] === "${{ github.event.workflow_run.id }}");
  assert.equal(ofTheRun.length, 2);
  assert.ok(ofTheRun.every((step) => step.if === "${{ steps.preflight.outputs.accepted == 'true' }}"), "downloaded by the run id GitHub named, only after the preflight accepted the artifacts");
  const claimed = downloads.filter((step) => (step.with as Mutable)["run-id"] === "${{ steps.claim.outputs.door-run }}");
  assert.equal(claimed.length, 1, "a claimed reuse's verdict is downloaded from the door run the door located itself");
  const locator = judge.find((step) => step.name === "Publish the verdict's locator")!;
  assert.equal((locator.with as Mutable).name, "door-verdict-${{ steps.judge.outputs.key }}-${{ steps.judge.outputs.verdict }}");
  const attest = judge.find((step) => step.uses instanceof Commented && (step.uses as Commented).value.startsWith("actions/attest@"))!;
  assert.equal((attest.with as Mutable)["subject-path"], "${{ runner.temp }}/door/keydoc.json", "the subject is the key document itself");
  assert.equal((attest.with as Mutable)["predicate-type"], DOOR_PREDICATE_TYPE);
  const checkout = judge[0]!;
  assert.deepEqual(checkout.with, { "persist-credentials": false, "fetch-depth": 0, filter: "blob:none" }, "a partial clone of main: the judged commits are fetched without their blobs");
});

test("the failure reporter watches every generated workflow by name, and the promotion gate splices no input into its script (#67 takes over main's hand-written ones)", () => {
  const issue = failureIssueWorkflow() as Mutable;
  const watched = ((issue.on as Mutable).workflow_run as Mutable).workflows as string[];
  assert.deepEqual(watched, [ciWorkflow(), codeqlWorkflow(), publishWorkflow(), auditWorkflow()].map((workflow) => (workflow as Mutable).name), "derived from the generated set, never a hand list");
  assert.equal(((issue.jobs as Mutable).report as Mutable).uses, "./.github/workflows/reusable-workflow-failure.yml");
  const reporter = reusableFailureWorkflow() as Mutable;
  assert.deepEqual(Object.keys(reporter.on as Mutable), ["workflow_call"]);
  assert.equal(reporter.concurrency, undefined, "a reusable workflow runs in its caller's group");
  const gate = promotionGateWorkflow() as Mutable;
  const steps = ((gate.jobs as Mutable).gate as Mutable).steps as Mutable[];
  const evaluate = steps.find((step) => step.id === "gate")!;
  assert.doesNotMatch(String(evaluate.run), /\$\{\{/u, "the caller's inputs reach the script as environment data");
  assert.equal((evaluate.env as Mutable).PRODUCT_SHA, "${{ inputs.product_sha }}");
  for (const [name, build] of [["workflow-failure-issue.yml", failureIssueWorkflow], ["reusable-workflow-failure.yml", reusableFailureWorkflow], ["promotion-gate.yml", promotionGateWorkflow]] as const) {
    assert.doesNotThrow(() => lintWorkflow(name, build()), name);
  }
});

test("fork safety (main's policy, owned by the generator): a privileged run names no pull-request value outside the declared data-only job", () => {
  const set = { "workflow-failure-issue.yml": failureIssueWorkflow(), "reusable-workflow-failure.yml": reusableFailureWorkflow(), "ci.yml": ciWorkflow() };
  assert.deepEqual(forkSafetyViolations(set), [], "the generated set is fork-safe");
  // A checkout of the run's head in the reporter (privileged through its workflow_run caller) is refused.
  const checkoutHead = structuredClone(set["reusable-workflow-failure.yml"]) as Mutable;
  (((checkoutHead.jobs as Mutable).report as Mutable).steps as Mutable[]).unshift({ name: "x", uses: new Commented("actions/checkout@0", "v0"), with: { ref: "${{ github.event.workflow_run.head_sha }}" } });
  assert.ok(forkSafetyViolations({ ...set, "reusable-workflow-failure.yml": checkoutHead as never }).length > 0, "a head checkout in a privileged run");
  // The data-only exception holds only for its declared variables: another env value naming a head is refused.
  const extraEnv = structuredClone(set["reusable-workflow-failure.yml"]) as Mutable;
  ((extraEnv.jobs as Mutable).report as Mutable).env = { ...(((extraEnv.jobs as Mutable).report as Mutable).env as Mutable), OTHER: "${{ github.head_ref }}" };
  assert.ok(forkSafetyViolations({ ...set, "reusable-workflow-failure.yml": extraEnv as never }).some((violation) => violation.includes("OTHER")));
  // A scheduled workflow (privileged) that reads a fork's head is refused; an uncalled reusable one is judged privileged.
  const scheduled = structuredClone(set["ci.yml"]) as Mutable;
  (scheduled.jobs as Mutable).probe = { "runs-on": "x", permissions: {}, steps: [{ name: "fetch", run: "git fetch origin refs/pull/1/head" }] };
  assert.ok(forkSafetyViolations({ "ci.yml": scheduled as never }).length > 0);
  assert.ok(forkSafetyViolations({ "reusable-workflow-failure.yml": extraEnv as never }).length > 0, "uncalled, the reusable reporter is judged privileged");
});
