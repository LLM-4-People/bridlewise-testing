/**
 * THE PAGES REBUILD GATE (#675): a push builds the site while its checks
 * still run, so the site is rebuilt from `main`'s tip when the last of them
 * finishes, once, deciding from trusted data only (never a run's head).
 * Proven on the decision (`rebuildDecision`) and on the workflow's wiring
 * (`pages.yml` read as YAML).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { REBUILD_TRIGGER, REBUILD_WORKFLOWS, rebuildDecision } from "../../scripts/floor/rebuild-gate.mjs";
import { SITE_WORKFLOW, STATUS_WORKFLOWS } from "../../scripts/floor/status.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOW = join(ROOT, ".github/workflows/pages.yml");
const TIP = "a".repeat(40);
const QUEUE = "gh-readonly-queue/main/pr-1-0123456789abcdef0123456789abcdef01234567";
const run = (id, name, status = "completed", updatedAt = `2026-01-01T00:0${String(id)}:00Z`, headBranch = "main") => ({ id, name, headBranch, status, updatedAt });
const finished = () => REBUILD_WORKFLOWS.map((name, index) => run(index + 1, name));
const decide = (runId, runs, mainHead = TIP) => rebuildDecision({ runId, mainHead, runs, branch: "main" });

test("the last status workflow to finish at main's tip rebuilds it; an earlier one does not, and nothing waits", () => {
  const runs = finished();
  const last = runs.at(-1);
  assert.deepEqual(decide(last.id, runs), { build: true, sha: TIP, reason: `every status workflow at ${TIP} has finished: rebuilding the site with their results` });
  const earlier = decide(runs[0].id, runs);
  assert.equal(earlier.build, false);
  assert.match(earlier.reason, new RegExp(`^${last.name} \\(run ${String(last.id)}\\) finished last at ${TIP}: its completion rebuilds the site$`, "u"));
  // One still running: no completion builds yet, and it is named once.
  const going = [...runs.slice(0, -1), run(last.id, last.name, "in_progress"), run(99, last.name, "queued")];
  const blocked = decide(runs[0].id, going);
  assert.equal(blocked.build, false);
  assert.match(blocked.reason, new RegExp(`^${last.name} still running at ${TIP}: its completion rebuilds the site$`, "u"));
  // Near misses: the site's own run or a workflow the status does not read, still running, blocks nothing.
  assert.equal(decide(last.id, [...runs, run(50, SITE_WORKFLOW, "in_progress"), run(51, "Commit records", "in_progress")]).build, true);
});

test("two completions that finish together pick one between them: the later finish, then the higher run id", () => {
  const [first, second] = REBUILD_WORKFLOWS;
  const tie = [run(7, first, "completed", "2026-01-01T00:05:00Z"), run(8, second, "completed", "2026-01-01T00:05:00Z")];
  assert.deepEqual([decide(7, tie).build, decide(8, tie).build], [false, true]);
  const ordered = [run(9, first, "completed", "2026-01-01T00:06:00Z"), run(8, second, "completed", "2026-01-01T00:05:00Z")];
  assert.deepEqual([decide(9, ordered).build, decide(8, ordered).build], [true, false]);
});

test("the merge queue's runs at the tip count for nothing: one finishing last, or still going, never holds the rebuild back", () => {
  // main's tip IS the queue's commit, so the queue's runs sit at it too; their completion fires nothing on main.
  const runs = finished();
  const queueLast = [...runs, run(70, REBUILD_WORKFLOWS[0], "completed", "2026-01-01T00:59:00Z", QUEUE)];
  assert.equal(decide(runs.at(-1).id, queueLast).build, true, "the last run on main rebuilds, though a queue run finished after it");
  assert.match(decide(70, queueLast).reason, /^run 70 is not a status run at main's tip/u, "and the queue run itself is no status run");
  assert.equal(decide(runs.at(-1).id, [...runs, run(71, REBUILD_WORKFLOWS[0], "in_progress", "2026-01-01T00:59:00Z", QUEUE)]).build, true, "a queue run still going blocks nothing");
});

test("the completed run is finished whatever a lagging list says, and then it is the last", () => {
  const runs = finished();
  const lagging = runs.map((entry, index) => (index === 0 ? { ...entry, status: "in_progress" } : entry));
  assert.equal(decide(runs[0].id, lagging).build, true, "its own completion is the proof");
});

test("a run that is not a status run at main's tip, or a main GitHub does not name, rebuilds nothing", () => {
  const runs = finished();
  const stranger = decide(4242, runs);
  assert.equal(stranger.build, false);
  assert.match(stranger.reason, /^run 4242 is not a status run at main's tip a{40}: nothing to rebuild$/u, "a fork's run, or a run at another commit");
  assert.equal(decide(50, [...runs, run(50, SITE_WORKFLOW)]).build, false, "the site's own run is no status run");
  assert.deepEqual(decide(runs.at(-1).id, runs, null), { build: false, sha: "", reason: "GitHub named no tip for main: nothing to rebuild" });
});

test("the workflow rebuilds on every workflow the status reads but its own, and builds what the gate chose", () => {
  const workflow = parse(readFileSync(WORKFLOW, "utf8"));
  assert.equal(workflow.name, SITE_WORKFLOW, "the status names the site's workflow as GitHub does");
  assert.deepEqual([...REBUILD_WORKFLOWS].sort(), STATUS_WORKFLOWS.filter((name) => name !== SITE_WORKFLOW).sort());
  // The trigger IS the gate's definition: every run the gate counts fires it, and it fires on nothing the gate ignores.
  assert.deepEqual(workflow.on.workflow_run, { workflows: [...REBUILD_TRIGGER.workflows], types: ["completed"], branches: [...REBUILD_TRIGGER.branches] });
  assert.ok("push" in workflow.on && "pull_request" in workflow.on, "the push build stays");

  const gate = workflow.jobs["rebuild-gate"];
  assert.match(gate.if, /github\.event_name == 'workflow_run'/u);
  const decideStep = gate.steps.find((step) => step.id === "gate");
  assert.equal(decideStep.run, "node scripts/floor/rebuild-gate.mjs");
  // Trusted data only: the completed run's id; never its head commit, branch or repository (a fork's to choose).
  assert.deepEqual(decideStep.env, { GH_TOKEN: "${{ github.token }}", RUN_ID: "${{ github.event.workflow_run.id }}" });
  assert.ok(!/head_/u.test(readFileSync(WORKFLOW, "utf8")), "the workflow names no run head");

  const build = workflow.jobs.build;
  assert.match(build.if.replace(/\s+/gu, " "), /\(github\.event_name != 'workflow_run' \|\| needs\.rebuild-gate\.outputs\.build == 'true'\)/u);
  assert.equal(build.concurrency.group, "pages-build-${{ github.event_name == 'pull_request' && github.ref || github.run_id }}", "a main build is never cancelled");
  const chosen = "${{ github.event_name == 'workflow_run' && needs.rebuild-gate.outputs.sha || '' }}";
  for (const name of ["build", "deploy"]) {
    const checkout = workflow.jobs[name].steps.find((step) => String(step.uses ?? "").startsWith("actions/checkout@"));
    assert.equal(checkout.with.ref, chosen, `${name} checks out the commit the gate chose`);
  }
  assert.equal(build.steps.find((step) => String(step.uses ?? "").startsWith("actions/jekyll-build-pages@")).with.build_revision, "${{ env.SITE_SHA }}");
  assert.match(workflow.jobs.deploy.if, /github\.event_name == 'workflow_run'/u, "a rebuild deploys");
});
