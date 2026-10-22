/**
 * THE JUDGE, END TO END, against GH-1's fake GitHub and a real scratch
 * `origin`: a pull request's CI run whose artifacts and GitHub's record agree
 * is judged success; each lie or violation turns it into failure, by name —
 *
 *   - an unsigned PR commit (DCO), and a hand-edited workflow (the ratchet,
 *     V-7);
 *   - a re-run after a failed attempt (the attempt discipline, V-23);
 *   - a plan that names another tree than the one GitHub built, and a key
 *     document whose lockfile digest is not the commit's own;
 *   - a merge group whose head is not the clean merge of its parents (the
 *     queue-integrity check, V-22), against the clean group that passes;
 *   - an artifact listing with a foreign name or an oversized payload, refused
 *     before anything is downloaded (V-19), and the streamer's dequeue of a
 *     destroyed group (V-10's display path) and the cold button's refusal of a
 *     fork.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { githubClient } from "../../../src/workflow/forge/github.ts";
import { memoryCredential } from "../../../src/workflow/forge/credentials.ts";
import { GATE_CATALOGUE } from "../../../src/workflow/gates/catalogue.ts";
import { gateKeyDocument } from "../../../src/workflow/gates/key.ts";
import { catalogueDigest, planGates, type GatePlan } from "../../../src/workflow/gates/plan.ts";
import { GATE_RESULT_SCHEMA } from "../../../src/workflow/gates/cell-run.ts";
import { workflowText } from "../../../src/workflow/gates/workflows.ts";
import { GENERATED_WORKFLOW_FILES } from "../../../src/kernel/verification-paths.ts";
import { judgeCompletedRun, type JudgeContext } from "../../../src/workflow/door/judge.ts";
import { judgeArtifacts, rerunCold, streamProgress } from "../../../src/workflow/door/stream.ts";
import { fakeGithub, type FakeGithub } from "../../forge/fake-github.ts";
import { mkGitTempDir } from "../../support/git-fixtures.ts";
import { testGitIdentityEnvironment } from "../../support/test-git-identity.ts";

const REPOSITORY = { owner: "o", name: "r" } as const;

function git(root: string, ...argv: string[]): string {
  const result = spawnSync("git", ["-C", root, "-c", "commit.gpgsign=false", ...argv], { encoding: "utf8", env: { ...process.env, ...testGitIdentityEnvironment() } });
  assert.equal(result.status, 0, `git ${argv.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

type Scene = Readonly<{
  origin: string;
  work: string;
  door: string;
  main: string;
  head: string;
  testMerge: string;
}>;

/** main (the generated workflows and the key inputs), a PR commit, and GitHub's test merge, pushed to a scratch origin. */
function scene(options: Readonly<{ signed?: boolean; workflowEdit?: boolean }> = {}): Scene {
  const root = mkGitTempDir("door-judge");
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  spawnSync("git", ["init", "-q", "--bare", origin]);
  spawnSync("git", ["init", "-q", "-b", "main", work]);
  for (const name of GENERATED_WORKFLOW_FILES.files) write(work, `${GENERATED_WORKFLOW_FILES.directory}/${name}`, workflowText(name));
  write(work, ".nvmrc", "24.20.0\n");
  write(work, "package-lock.json", "{}\n");
  write(work, "engine/package-lock.json", "{}\n");
  write(work, "engine/bridlewise.config.json", "{}\n");
  git(work, "add", ".");
  git(work, "commit", "-q", "-s", "-m", "main");
  const main = git(work, "rev-parse", "HEAD");
  git(work, "checkout", "-q", "-b", "pr");
  write(work, "src/feature.ts", "export const feature = 1;\n");
  if (options.workflowEdit === true) write(work, ".github/workflows/ci.yml", `${workflowText("ci.yml")}# a hand edit\n`);
  git(work, "add", ".");
  git(work, "commit", "-q", ...(options.signed === false ? [] : ["-s"]), "-m", "feature");
  const head = git(work, "rev-parse", "HEAD");
  git(work, "checkout", "-q", "--detach", main);
  git(work, "merge", "-q", "--no-ff", "-m", `Merge ${head} into ${main}`, head);
  const testMerge = git(work, "rev-parse", "HEAD");
  git(work, "push", "-q", origin, "main", "pr", `${testMerge}:refs/pull/1/merge`);
  const door = join(root, "door");
  spawnSync("git", ["clone", "-q", "--filter=blob:none", origin, door]);
  return { origin, work, door, main, head, testMerge };
}

function planFor(sceneValue: Scene, commit: string, overrides: Readonly<{ tree?: string; lockfile?: string }> = {}): GatePlan {
  const tree = git(sceneValue.work, "rev-parse", `${commit}^{tree}`);
  const read = (path: string): string | null => {
    if (path === "package-lock.json" && overrides.lockfile !== undefined) return overrides.lockfile;
    const result = spawnSync("git", ["-C", sceneValue.work, "show", `${commit}:${path}`], { encoding: "utf8" });
    return result.status === 0 ? result.stdout : null;
  };
  const planTree = overrides.tree ?? tree;
  return planGates({
    headSha: commit,
    treeId: planTree,
    key: gateKeyDocument({ treeId: planTree, catalogueDigest: catalogueDigest(), read, node: "v24.20.0", runnerImage: "ubuntu24/1", probes: { cpuModel: "c", cgroupV2: true, landlock: true, userNamespaces: true, cpuCounters: false } }),
    populations: [
      { population: "web-tests", source: "planted", files: ["tests/unit/a.test.ts", "tests/unit/b.test.ts"], excluded: [] },
      { population: "engine-tests", source: "planted", files: ["engine/test/a.test.ts"], excluded: [] },
    ],
  });
}

/** The artifacts as `door.yml` lays them out: the plan and every passed result. */
function artifacts(plan: GatePlan): string {
  const directory = mkGitTempDir("door-artifacts");
  write(directory, "gate-plan/plan.json", JSON.stringify(plan));
  const base = { schemaVersion: GATE_RESULT_SCHEMA, catalogueDigest: plan.catalogueDigest, headSha: plan.headSha, treeId: plan.treeId, status: "passed", startedAt: "2026-10-21T00:00:00.000Z", finishedAt: "2026-10-21T00:00:01.000Z", steps: [] };
  for (const gate of GATE_CATALOGUE.filter((entry) => entry.class === "light")) write(directory, `results/${gate.id}.result.json`, JSON.stringify({ ...base, gate: gate.id, cell: gate.id }));
  for (const cell of plan.cells) write(directory, `results/${cell.cell}.result.json`, JSON.stringify({ ...base, gate: cell.gate, cell: cell.cell, suite: { population: "x", files: cell.files, tests: 3, perFile: [] } }));
  return directory;
}

function github(sceneValue: Scene, run: Readonly<{ event: string; headSha: string; attempts?: readonly (string | null)[]; fork?: boolean }>): FakeGithub {
  const fake = fakeGithub();
  const attempts = run.attempts ?? [null];
  const runBody = (attempt: number) => ({
    id: 1, run_attempt: attempt, name: "CI", path: ".github/workflows/ci.yml", event: run.event, status: attempt === attempts.length ? "completed" : "completed",
    conclusion: attempts[attempt - 1] ?? "success", head_sha: run.headSha, head_branch: run.event === "merge_group" ? "gh-readonly-queue/main/pr-1-x" : "pr",
    head_repository: { id: run.fork === true ? 2 : 1 }, repository: { id: 1 }, pull_requests: [],
  });
  fake.objects.set("/repos/o/r/actions/runs/1", runBody(attempts.length));
  attempts.forEach((_, index) => fake.objects.set(`/repos/o/r/actions/runs/1/attempts/${String(index + 1)}`, runBody(index + 1)));
  fake.objects.set("/repos/o/r/actions/runs/1/jobs", { total_count: 1, jobs: [{ id: 9, name: "dependency-review", status: "completed", conclusion: run.event === "pull_request" ? "success" : "skipped", run_attempt: attempts.length }] });
  fake.objects.set("/repos/o/r/secret-scanning/alerts", []);
  for (const commit of [sceneValue.testMerge, sceneValue.head, sceneValue.main]) {
    const tree = git(sceneValue.work, "rev-parse", `${commit}^{tree}`);
    const parents = git(sceneValue.work, "rev-list", "--parents", "-n", "1", commit).split(" ").slice(1);
    fake.objects.set(`/repos/o/r/git/commits/${commit}`, { sha: commit, tree: { sha: tree }, parents: parents.map((sha) => ({ sha })) });
  }
  fake.route("POST", /^\/graphql$/u, () => ({ status: 200, body: { data: { repository: { mergeQueue: { entries: { nodes: [] } } } } } }));
  return fake;
}

function context(sceneValue: Scene, fake: FakeGithub, directory: string): JudgeContext {
  return {
    client: githubClient(fake.endpoint(), memoryCredential("door", fake.userToken("door"))),
    repository: REPOSITORY,
    git: { root: sceneValue.door, executable: "git", timeoutMs: 30_000 },
    mainSha: sceneValue.main,
    artifactsDirectory: directory,
    runId: 1,
    runUrl: "https://github.com/o/r/actions/runs/1",
  };
}

async function judge(sceneValue: Scene, run: Parameters<typeof github>[1], plan: GatePlan) {
  return judgeCompletedRun(context(sceneValue, github(sceneValue, run), artifacts(plan)));
}

test("a pull request's run whose record and artifacts agree is judged success, on the head GitHub named", async () => {
  const value = scene();
  const judged = await judge(value, { event: "pull_request", headSha: value.head }, planFor(value, value.testMerge));
  assert.deepEqual(judged.verdict.findings, []);
  assert.equal(judged.verdict.conclusion, "success");
  assert.equal(judged.checkSha, value.head);
  assert.equal(judged.check.conclusion, "success");
  assert.equal(judged.verdict.key, judged.check.externalId);
});

test("an unsigned PR commit and a hand-edited workflow are each refused by name", async () => {
  const unsigned = scene({ signed: false });
  const dco = await judge(unsigned, { event: "pull_request", headSha: unsigned.head }, planFor(unsigned, unsigned.testMerge));
  assert.deepEqual(dco.verdict.findings.map((finding) => finding.rule), ["dco"]);
  assert.equal(dco.verdict.conclusion, "failure");
  const edited = scene({ workflowEdit: true });
  const ratchet = await judge(edited, { event: "pull_request", headSha: edited.head }, planFor(edited, edited.testMerge));
  assert.deepEqual(ratchet.verdict.findings.map((finding) => [finding.rule, finding.path]), [["workflow-hand-edit", ".github/workflows/ci.yml"]]);
});

test("a re-run after a failed attempt stays failure (V-23)", async () => {
  const value = scene();
  const judged = await judge(value, { event: "pull_request", headSha: value.head, attempts: ["failure", null] }, planFor(value, value.testMerge));
  assert.deepEqual(judged.verdict.findings.map((finding) => finding.rule), ["attempt-laundering"]);
});

test("a plan for another tree, a lying key and a fork are each named", async () => {
  const value = scene();
  const otherTree = await judge(value, { event: "pull_request", headSha: value.head }, planFor(value, value.testMerge, { tree: "f".repeat(40) }));
  assert.ok(otherTree.verdict.findings.some((finding) => finding.rule === "identity" && /holds/u.test(finding.detail)));
  const lyingKey = await judge(value, { event: "pull_request", headSha: value.head }, planFor(value, value.testMerge, { lockfile: "{\"forged\":true}\n" }));
  assert.ok(lyingKey.verdict.findings.some((finding) => finding.rule === "identity" && /toolchain or config/u.test(finding.detail)));
  const fork = await judge(value, { event: "pull_request", headSha: value.head, fork: true }, planFor(value, value.testMerge));
  assert.ok(fork.verdict.findings.some((finding) => /fork/u.test(finding.detail)));
  const notTheHead = await judge(value, { event: "pull_request", headSha: value.main }, planFor(value, value.testMerge));
  assert.ok(notTheHead.verdict.findings.some((finding) => /not GitHub's test merge/u.test(finding.detail)));
});

test("a merge group: the clean merge of its parents passes; a group whose tree differs is a queue-integrity failure (V-22)", async () => {
  const value = scene();
  const clean = await judge(value, { event: "merge_group", headSha: value.testMerge }, planFor(value, value.testMerge));
  assert.deepEqual(clean.verdict.findings, [], JSON.stringify(clean.verdict.findings));
  // A group head whose tree is not the merge of its parents (the queue composed another tree).
  git(value.work, "checkout", "-q", "--detach", value.testMerge);
  write(value.work, "src/reverted.ts", "silently changed by the queue\n");
  git(value.work, "add", ".");
  const wrongTree = git(value.work, "write-tree");
  const wrong = git(value.work, "commit-tree", wrongTree, "-p", value.main, "-p", value.head, "-m", "group");
  git(value.work, "push", "-q", value.origin, `${wrong}:refs/heads/gh-readonly-queue/main/pr-1-x`);
  const fake = github(value, { event: "merge_group", headSha: wrong });
  fake.objects.set(`/repos/o/r/git/commits/${wrong}`, { sha: wrong, tree: { sha: wrongTree }, parents: [{ sha: value.main }, { sha: value.head }] });
  const plan = planGates({ ...planFor(value, value.testMerge), headSha: wrong, treeId: wrongTree, key: { ...planFor(value, value.testMerge).key, treeId: wrongTree }, populations: planFor(value, value.testMerge).populations });
  const judged = await judgeCompletedRun(context(value, fake, artifacts(plan)));
  assert.ok(judged.verdict.findings.some((finding) => finding.rule === "queue-integrity" && /composed a different tree/u.test(finding.detail)), JSON.stringify(judged.verdict.findings));
  assert.equal(judged.verdict.conclusion, "failure");
});

test("hostile artifacts are refused before anything is downloaded (V-19)", () => {
  const ok = [{ id: 1, name: "gate-plan", sizeInBytes: 10, expired: false, digest: null }, { id: 2, name: "gate-results-web-suite-1", sizeInBytes: 10, expired: false, digest: null }];
  assert.deepEqual(judgeArtifacts(ok), []);
  assert.deepEqual(judgeArtifacts([...ok, { id: 3, name: "../../etc/passwd", sizeInBytes: 1, expired: false, digest: null }]).map((finding) => finding.rule), ["artifact-name"]);
  assert.deepEqual(judgeArtifacts([...ok, { id: 3, name: "payload.exe", sizeInBytes: 1, expired: false, digest: null }]).map((finding) => finding.rule), ["artifact-name"]);
  assert.deepEqual(judgeArtifacts([{ ...ok[0]!, sizeInBytes: 9 * 1024 * 1024 }, ok[1]!]).map((finding) => finding.rule), ["artifact-size"]);
  assert.deepEqual(judgeArtifacts([ok[1]!]).map((finding) => finding.rule), ["artifact-plan-missing"]);
  assert.deepEqual(judgeArtifacts([{ ...ok[0]!, expired: true }, ok[1]!]).map((finding) => finding.rule), ["artifact-expired"]);
});

test("the streamer shows progress, cancels a destroyed group's run and says dequeued; the cold button dispatches only the judged commit of our own branch", async () => {
  const value = scene();
  const fake = github(value, { event: "merge_group", headSha: value.testMerge });
  fake.objects.set("/repos/o/r/actions/runs/1", { ...(fake.objects.get("/repos/o/r/actions/runs/1") as object), status: "in_progress", conclusion: null });
  fake.objects.set(`/repos/o/r/commits/${value.testMerge}/check-runs`, { total_count: 0, check_runs: [] });
  fake.objects.set("/repos/o/r/check-runs", []);
  let cancelled = false;
  fake.route("POST", /^\/repos\/o\/r\/actions\/runs\/1\/cancel$/u, () => { cancelled = true; return { status: 202, body: {} }; });
  const client = githubClient(fake.endpoint(), memoryCredential("door", fake.userToken("door")));
  assert.equal(await streamProgress(client, REPOSITORY, 1, { intervalMs: 1, deadline: Date.now() + 60_000, sleep: async () => undefined }), "dequeued");
  assert.ok(cancelled, "the destroyed group's run was cancelled");
  const written = (fake.objects.get("/repos/o/r/check-runs") as { conclusion?: string; output?: { title?: string } }[]).at(-1)!;
  assert.equal(written.conclusion, "cancelled");
  assert.match(written.output?.title ?? "", /Dequeued/u);
  const refusedRerun = (error: unknown) => (error as { code?: string }).code === "door_rerun_refused";
  await assert.rejects(rerunCold(client, REPOSITORY, { headBranch: "fork-branch", headSha: value.head }), refusedRerun, "no such branch here (a fork's)");
  fake.objects.set("/repos/o/r/git/ref/heads/pr", { ref: "refs/heads/pr", object: { sha: value.main } });
  await assert.rejects(rerunCold(client, REPOSITORY, { headBranch: "pr", headSha: value.head }), refusedRerun, "the branch moved since the judged commit");
  await assert.rejects(rerunCold(client, REPOSITORY, { headBranch: null, headSha: value.head }), refusedRerun);
  fake.objects.set("/repos/o/r/git/ref/heads/pr", { ref: "refs/heads/pr", object: { sha: value.head } });
  fake.route("POST", /^\/repos\/o\/r\/actions\/workflows\/ci\.yml\/dispatches$/u, (request) => {
    assert.deepEqual(request.body, { ref: "pr", inputs: { cold: "true" }, return_run_details: true });
    return { status: 200, body: { workflow_run_id: 77 } };
  });
  assert.equal(await rerunCold(client, REPOSITORY, { headBranch: "pr", headSha: value.head }), 77, "dispatched cold on the judged branch, answering the run id");
});
