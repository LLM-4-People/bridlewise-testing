/**
 * THE JUDGE — one completed CI run, judged by `main`'s code from what the
 * door reads itself (github-only §5.3 step 3). The CI run's artifacts are
 * DATA: parsed, bounded and checked against GitHub's own record of the run;
 * nothing in them is executed, and nothing the run reports about itself
 * (its `seal` job, its receipt file) is believed.
 *
 *   1. the run, re-read from GitHub by the id the event named, and every
 *      attempt of it (the attempt discipline);
 *   2. the plan, whose tree must be the tree GitHub says the run built: the
 *      pull request's test merge of the base and exactly the head GitHub
 *      named; a merge group's head commit, which must ALSO be the merge of its
 *      base and the queued head (the queue-integrity check: a queue that
 *      composed another tree is refused, the 2026-04 silent-revert class);
 *      any other event's head commit;
 *   3. the key document, re-derived where the door can (its tree, catalogue,
 *      lockfiles and config from the commit itself);
 *   4. the receipt, re-sealed here from the results and GitHub's job outcomes;
 *   5. the ratchet against main's generator and catalogue;
 *   6. the tree judge over the diff the land would bring, the pull request's
 *      own commits (never GitHub's merge commit) and the open alerts.
 *
 * The artifacts are laid out by `door.yml`: `gate-plan/plan.json` and every
 * cell's files merged under `results/`. Their names and sizes were refused
 * before download when out of bounds (`preflightArtifacts`).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { InputError } from "../../kernel/errors.ts";
import { deepFreeze } from "../../kernel/integrity.ts";
import { GENERATED_WORKFLOW_FILES } from "../../kernel/verification-paths.ts";
import { gitOutput, type GitRepository } from "../../git/tree-reader.ts";
import type { ForgeClient } from "../forge/port.ts";
import { GATE_CATALOGUE } from "../gates/catalogue.ts";
import { gateKey, treeKeyInputs } from "../gates/key.ts";
import { catalogueDigest, parsePlan, type GatePlan } from "../gates/plan.ts";
import { readResults, sealReceipt, type GateReceipt, type JobOutcome } from "../gates/seal.ts";
import { workflowText } from "../gates/workflows.ts";
import { blobText, diffFiles, fetchCommits, listDirectory, mergeTree, pathObjectId, readBlob } from "./door-git.ts";
import { getGitCommit, getWorkflowRun, listRunAttempts, listRunJobs, mergeQueueEntries, openAlertCommits, type Repository, type WorkflowRunFacts } from "./door-github.ts";
import { GENERATOR_SOURCES, judgeRatchet } from "./ratchet.ts";
import { judgeTree, TREE_POLICY, type ChangedFile, type CommitRecord } from "./tree-judge.ts";
import { failedTestFiles, judgeAttempts, judgeRun, verdictCheckRun, type DoorVerdict, type IdentityFinding, type QueueFinding } from "./verdict.ts";
import type { CheckRunWrite } from "./door-github.ts";

/** How much the door reads before it judges (pages of API lists). */
export const DOOR_READ_PAGES = 20;

export type JudgeContext = Readonly<{
  client: ForgeClient;
  repository: Repository;
  /** The door's own checkout of `main` (a partial clone: the judged commits are fetched without blobs). */
  git: GitRepository;
  /** The commit the door's code is (main's tip it checked out). */
  mainSha: string;
  /** Where `door.yml` downloaded the run's accepted artifacts (`gate-plan/`, `gate-results-*`). */
  artifactsDirectory: string;
  runId: number;
  /** The run's page, for the check's details. */
  runUrl: string;
}>;

export type Judgement = Readonly<{
  verdict: DoorVerdict;
  receipt: GateReceipt;
  check: CheckRunWrite;
  /** The commit the check is posted on (the pull request's head, or the group's). */
  checkSha: string;
  /** The key document's canonical bytes (the attestation's subject), and the predicate. */
  keyDocument: unknown;
}>;

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * The pull request's commits `base..head` (never a merge GitHub made for the
 * test or the queue: `head` is the pull request's own head), with their
 * authors' addresses and messages, and whether each is a MECHANICAL merge
 * (see `tree-judge.ts`): two parents, one an ancestor of (or equal to)
 * main's tip, the other a commit of this range, and a tree equal to their
 * clean merge.
 */
export function pullCommitRecords(git: GitRepository, mainSha: string, base: string, head: string): readonly CommitRecord[] {
  const raw = gitOutput(git, ["log", "--format=%H%x1f%T%x1f%P%x1f%ae%x1f%B%x1e", `${base}..${head}`]).stdout.toString("utf8");
  const entries = raw.split("\u001e").map((entry) => entry.replace(/^\n/u, "")).filter((entry) => entry.length > 0).map((entry) => {
    const [sha, tree, parents, authorEmail, message] = entry.split("\u001f");
    return { sha: sha!, tree: tree!, parents: (parents ?? "").split(" ").filter((parent) => parent.length > 0), authorEmail: authorEmail ?? "", message: message ?? "" };
  });
  const own = new Set(entries.map((entry) => entry.sha));
  const onMain = (commit: string): boolean => gitOutput(git, ["merge-base", "--is-ancestor", commit, mainSha], { allowed: [0, 1] }).status === 0;
  return entries.map((entry) => {
    const [first, second] = entry.parents;
    const mechanical = entry.parents.length === 2
      && ((onMain(first!) && own.has(second!)) || (onMain(second!) && own.has(first!)))
      && mergeTree(git, first!, second!) === entry.tree;
    return { sha: entry.sha, authorEmail: entry.authorEmail, message: entry.message, mechanical };
  });
}

type Identity = Readonly<{ findings: readonly IdentityFinding[]; queue: readonly QueueFinding[]; base: string | null; head: string | null; checkSha: string }>;

/** Step 2: does the plan name the tree GitHub says the run built? */
async function judgeIdentity(context: JudgeContext, run: WorkflowRunFacts, plan: GatePlan): Promise<Identity> {
  const findings: IdentityFinding[] = [];
  const queue: QueueFinding[] = [];
  const refuse = (detail: string): void => void findings.push({ rule: "identity", detail });
  fetchCommits(context.git, [...new Set([plan.headSha, run.headSha])]);
  const built = await getGitCommit(context.client, context.repository, plan.headSha);
  if (built.tree !== plan.treeId) refuse(`the plan names tree ${plan.treeId}, but commit ${plan.headSha} holds ${built.tree}`);
  if (run.headRepositoryId !== run.repositoryId) refuse("the run was produced from a fork: its receipt is judged, but it is never trusted for reuse");
  if (run.event === "pull_request") {
    if (built.parents.length !== 2 || built.parents[1] !== run.headSha) {
      refuse(`the run built ${plan.headSha}, which is not GitHub's test merge of the head ${run.headSha} (parents: ${built.parents.join(", ")})`);
      return { findings, queue, base: null, head: null, checkSha: run.headSha };
    }
    return { findings, queue, base: built.parents[0]!, head: built.parents[1]!, checkSha: run.headSha };
  }
  if (plan.headSha !== run.headSha) refuse(`the plan names ${plan.headSha}, but the run built ${run.headSha}`);
  if (run.event === "merge_group") {
    if (built.parents.length !== 2) {
      queue.push({ rule: "queue-integrity", detail: `the group head ${run.headSha} is not a two-parent merge (parents: ${built.parents.join(", ")})` });
      return { findings, queue, base: null, head: null, checkSha: run.headSha };
    }
    const [base, pull] = built.parents as [string, string];
    const composed = mergeTree(context.git, base, pull);
    if (composed !== built.tree) {
      queue.push({ rule: "queue-integrity", detail: `the queue composed a different tree: merging ${base} with ${pull} gives ${String(composed)}, the group head holds ${built.tree}` });
    }
    const entries = await mergeQueueEntries(context.client, context.repository, "main");
    const entry = entries.find((candidate) => candidate.headCommit === run.headSha);
    if (entry !== undefined && (entry.baseCommit !== base || entry.pullHead !== pull)) {
      queue.push({ rule: "queue-integrity", detail: `the queue entry for #${String(entry.pullNumber)} is built on ${entry.baseCommit} with head ${entry.pullHead}, but the group head merges ${base} and ${pull}` });
    }
    return { findings, queue, base, head: pull, checkSha: run.headSha };
  }
  const mainBase = gitOutput(context.git, ["merge-base", context.mainSha, run.headSha], { allowed: [0, 1] }).stdout.toString("utf8").trim();
  return { findings, queue, base: mainBase.length === 40 ? mainBase : null, head: run.headSha, checkSha: run.headSha };
}

/** Step 3: the parts of K the door can re-derive from the commit itself. */
function judgeKey(context: JudgeContext, plan: GatePlan, ciChanging: boolean): readonly IdentityFinding[] {
  const findings: IdentityFinding[] = [];
  const derived = treeKeyInputs((path) => readBlob(context.git, plan.headSha, path));
  const claimed = plan.key;
  if (claimed.treeId !== plan.treeId) findings.push({ rule: "identity", detail: "the key document names another tree" });
  if (claimed.toolchain.nodeVersionFile !== derived.nodeVersionFile || claimed.toolchain.webLockfile !== derived.webLockfile
    || claimed.toolchain.engineLockfile !== derived.engineLockfile || claimed.config !== derived.config) {
    findings.push({ rule: "identity", detail: "the key document's toolchain or config digests are not the commit's own files" });
  }
  if (!ciChanging && claimed.catalogue.digest !== catalogueDigest(GATE_CATALOGUE)) findings.push({ rule: "identity", detail: "the key names another gate catalogue than main's, while the tree does not change it" });
  if (plan.keyDigest !== gateKey(claimed)) findings.push({ rule: "identity", detail: "the plan's key is not its key document's digest" });
  return findings;
}

/** The repository path a runner's absolute report path names (the checkout's root differs per runner). */
function repositoryPathOf(planFiles: ReadonlySet<string>): (name: string) => string | null {
  return (name) => [...planFiles].find((path) => name === path || name.endsWith(`/${path}`)) ?? null;
}

export async function judgeCompletedRun(context: JudgeContext): Promise<Judgement> {
  const run = await getWorkflowRun(context.client, context.repository, context.runId);
  const attempts = await listRunAttempts(context.client, context.repository, run);
  const attemptFindings = judgeAttempts(attempts.map((attempt) => ({ attempt: attempt.attempt, conclusion: attempt.conclusion })), run.attempt);
  const planPath = join(context.artifactsDirectory, "gate-plan", "plan.json");
  if (!existsSync(planPath)) throw new InputError("the CI run uploaded no plan (gate-plan/plan.json): nothing to judge", "door_plan_missing");
  const plan = parsePlan(readJson(planPath));
  const identity = await judgeIdentity(context, run, plan);
  const generatorChanged = GENERATOR_SOURCES.some((path) => pathObjectId(context.git, plan.headSha, path) !== pathObjectId(context.git, context.mainSha, path));
  const keyFindings = judgeKey(context, plan, generatorChanged);
  const jobs = await listRunJobs(context.client, context.repository, run.id, DOOR_READ_PAGES);
  const outcomes: Record<string, { result: JobOutcome }> = {};
  for (const job of jobs) {
    const conclusion = job.conclusion;
    if (conclusion === "success" || conclusion === "failure" || conclusion === "cancelled" || conclusion === "skipped") outcomes[job.name] = { result: conclusion };
  }
  const resultsDirectory = join(context.artifactsDirectory, "results");
  const receipt = sealReceipt({ plan, results: existsSync(resultsDirectory) ? readResults(resultsDirectory) : [], jobs: outcomes, event: run.event });
  const treeWorkflows = new Map(listDirectory(context.git, plan.headSha, GENERATED_WORKFLOW_FILES.directory).map((name) => [name, readBlob(context.git, plan.headSha, `${GENERATED_WORKFLOW_FILES.directory}/${name}`)!.toString("utf8")]));
  const mainWorkflows = new Map(GENERATED_WORKFLOW_FILES.files.map((name) => [name, workflowText(name)]));
  const ratchet = judgeRatchet({ generatorChanged, treeWorkflows, mainWorkflows, mainCatalogue: GATE_CATALOGUE, treeGates: plan.gates });
  let tree: ReturnType<typeof judgeTree> = [];
  if (identity.base !== null && identity.head !== null) {
    const files: ChangedFile[] = diffFiles(context.git, identity.base, identity.head).map((entry) => ({
      path: entry.path,
      status: entry.status,
      sizeBytes: entry.sizeBytes,
      text: entry.blob === null || entry.sizeBytes > TREE_POLICY.maxFileBytes ? null : blobText(context.git, entry.blob),
    }));
    tree = judgeTree(files, pullCommitRecords(context.git, context.mainSha, identity.base, identity.head), await openAlertCommits(context.client, context.repository, DOOR_READ_PAGES));
  }
  const planFiles = new Set(plan.cells.flatMap((cell) => cell.files));
  const failedTests = plan.cells.flatMap((cell) => {
    const report = join(resultsDirectory, `${cell.cell}.vitest.json`);
    return existsSync(report) ? failedTestFiles(readJson(report), repositoryPathOf(planFiles)) : [];
  });
  const verdict = judgeRun({
    key: plan.keyDigest,
    receipt,
    identity: [...identity.findings, ...keyFindings],
    attempts: attemptFindings,
    ratchet,
    tree,
    queue: identity.queue,
    runUrl: context.runUrl,
    failedTests,
  });
  return deepFreeze({ verdict, receipt, check: verdictCheckRun(verdict, receipt, failedTests), checkSha: identity.checkSha, keyDocument: plan.key });
}
