/**
 * THE WORKSPACE'S PROVING-GROUND SCENARIOS (github-only §11: V-6, V-14,
 * V-15), each run by the real `ws` code (`provingWorkspace`) against the
 * proving ground on real GitHub, as the `agent` App. Each answers its
 * verdict and its evidence (the pull requests, commits and merge commits as
 * GitHub's web URLs); a refusal on the way is the scenario's failure, with
 * its code. Not a test file: `run.ts` runs them by name.
 *
 * - V-6: the agent's commits, published through the Git Data API with no
 *   author or committer, are Verified on GitHub, and a queue merge of them
 *   lands under `required_signatures`.
 * - V-15: a pull request entered into the REQUIRED merge queue by `ws land`
 *   (GraphQL `enqueuePullRequest` with `expectedHeadOid`, the land's one entry
 *   to the queue) is seen queued, and its outcome is reported: merged at
 *   exactly the published head (the merge commit's second parent).
 * - V-14: a two-part stack lands through the real queue with
 *   `delete_branch_on_merge` on: the child (its pull request against `main`)
 *   is refused until its parent lands, survives the deletion of its parent's
 *   branch, and then lands its own change.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { configuredGitRepository } from "../../../src/git/worktree-port.ts";
import { gitOutput } from "../../../src/git/tree-reader.ts";
import { loadPinnedConfigSnapshot } from "../../../src/kernel/config.ts";

import { generateId } from "../../../src/kernel/integrity.ts";
import type { WorkspaceForgeState } from "../../../src/workflow/workspace-contracts.ts";
import type { WorkspaceManager } from "../../../src/workflow/workspace-manager.ts";
import { commitVerification, requireConfigured, provingWorkspace, type ProvingGround } from "./proving-ground.ts";

export type Verdict = Readonly<{ v: string; status: "pass" | "fail"; detail: string; evidence: readonly string[] }>;

type Context = Readonly<{ ground: ProvingGround; manager: WorkspaceManager; clone: string; runId: string; progress: string[] }>;

async function withWorkspace(ground: ProvingGround, scratch: string, run: (context: Context) => Promise<Verdict>): Promise<Verdict> {
  await requireConfigured(ground);
  const runId = generateId("proving").replaceAll("-", "").slice(-10);
  const progress: string[] = [];
  const { clone, manager } = provingWorkspace(ground, join(scratch, runId), (line) => {
    progress.push(line);
    process.stderr.write(`${line}\n`);
  });
  return run({ ground, manager, clone, runId, progress });
}

/** The agent's local commit: `file` written with `content` in the worktree, then committed. */
function writeAndCommit(worktree: string, file: string, content: string, message: string): void {
  mkdirSync(dirname(join(worktree, file)), { recursive: true });
  writeFileSync(join(worktree, file), content);
  const repository = configuredGitRepository(loadPinnedConfigSnapshot().document, worktree);
  gitOutput(repository, ["add", "--", file]);
  gitOutput(repository, ["commit", "-q", "-m", message]);
}

function web(ground: ProvingGround, rest: string): string {
  return `${ground.webUrl}/${ground.owner}/${ground.name}/${rest}`;
}

/** A workspace with one committed file, published, validated and ready: its id and published head. */
async function readyWorkspace(context: Context, agent: string, file: string, stackOn?: string): Promise<Readonly<{ workspaceId: string; head: string; commits: readonly string[] }>> {
  const { manager } = context;
  const record = await manager.create({ agentName: agent, mode: "feature", writeSet: [file.slice(0, file.lastIndexOf("/"))], ...(stackOn === undefined ? {} : { stackOn }) });
  writeAndCommit(record.lease.worktreePath, file, `proving ground ${context.runId}: ${agent}\n`, `${agent}: ${file}`);
  const { round } = await manager.publish(record.workspaceId);
  const report = await manager.validate(record.workspaceId);
  if (report.status !== "pass") throw new Error(`the validation of ${record.workspaceId} did not pass`);
  await manager.ready(record.workspaceId);
  return { workspaceId: record.workspaceId, head: round.head, commits: round.commits.map((entry) => entry.twin) };
}

export async function v6(ground: ProvingGround, scratch: string): Promise<Verdict> {
  return withWorkspace(ground, scratch, async (context) => {
    const { manager, runId } = context;
    const made = await readyWorkspace(context, "provingv6", `proving/v6/${runId}.md`);
    const verifications = await Promise.all(made.commits.map(async (sha) => ({ sha, ...(await commitVerification(ground, sha)) })));
    const unsigned = verifications.filter((entry) => !entry.verified);
    const receipt = await manager.land(made.workspaceId);
    const merge = await commitVerification(ground, receipt.mergeCommitSha);
    const evidence = [receipt.pullRequest.url, ...made.commits.map((sha) => web(ground, `commit/${sha}`)), web(ground, `commit/${receipt.mergeCommitSha}`)];
    if (unsigned.length > 0) {
      return { v: "V-6", status: "fail", detail: `not Verified: ${unsigned.map((entry) => `${entry.sha} (${entry.reason})`).join(", ")}`, evidence };
    }
    return {
      v: "V-6", status: "pass", evidence,
      detail: `${String(made.commits.length)} API commit(s) by the agent App are Verified (${verifications.map((entry) => entry.reason).join(", ")}); the queue merged them under required_signatures (merge commit verified: ${String(merge.verified)}, ${merge.reason})`,
    };
  });
}

export async function v15(ground: ProvingGround, scratch: string): Promise<Verdict> {
  return withWorkspace(ground, scratch, async (context) => {
    const { manager, runId, progress } = context;
    const made = await readyWorkspace(context, "provingv15", `proving/v15/${runId}.md`);
    const receipt = await manager.land(made.workspaceId);
    const queued = progress.some((line) => line.includes("is in the merge queue"));
    const evidence = [receipt.pullRequest.url, web(ground, `commit/${receipt.mergeCommitSha}`)];
    const exact = receipt.landedHead === made.head;
    return {
      v: "V-15", status: queued && exact ? "pass" : "fail", evidence,
      detail: `enqueued by ws land (GraphQL enqueuePullRequest, expectedHeadOid ${made.head.slice(0, 12)}) under the required merge queue; seen queued: ${String(queued)}; outcome reported: merged as ${receipt.mergeCommitSha.slice(0, 12)} at ${receipt.landedHead.slice(0, 12)} (the published head: ${String(exact)})`,
    };
  });
}

export async function v14(ground: ProvingGround, scratch: string): Promise<Verdict> {
  return withWorkspace(ground, scratch, async (context) => {
    const { manager, runId } = context;
    const parent = await readyWorkspace(context, "provingbase", `proving/v14/${runId}/parent.md`);
    const child = await readyWorkspace(context, "provingnext", `proving/v14/${runId}/child.md`, parent.workspaceId);
    const childState = manager.status(child.workspaceId).forge as WorkspaceForgeState;
    const parentState = manager.status(parent.workspaceId).forge as WorkspaceForgeState;
    const childPull = await ground.client.rest<{ base?: { ref?: unknown } }>({ method: "GET", path: `/repos/${ground.owner}/${ground.name}/pulls/${String(childState.pullRequest!.number)}` });
    let refusedFirst = false;
    try {
      await manager.land(child.workspaceId);
    } catch (error) {
      refusedFirst = (error as { code?: unknown }).code === "workspace_stack_parent_unlanded";
    }
    const parentReceipt = await manager.land(parent.workspaceId);
    const branchGone = await ground.client.rest({ method: "GET", path: `/repos/${ground.owner}/${ground.name}/git/ref/heads/${manager.status(parent.workspaceId).lease.branch!}` })
      .then(() => false, () => true);
    const childAfter = await ground.client.rest<{ state?: unknown }>({ method: "GET", path: `/repos/${ground.owner}/${ground.name}/pulls/${String(childState.pullRequest!.number)}` });
    const childReceipt = await manager.land(child.workspaceId);
    const evidence = [parentState.pullRequest!.url, childState.pullRequest!.url, web(ground, `commit/${parentReceipt.mergeCommitSha}`), web(ground, `commit/${childReceipt.mergeCommitSha}`)];
    const checks = {
      "child against main": childPull.data?.base?.ref === "main",
      "child refused before its parent": refusedFirst,
      "parent's branch deleted on merge": branchGone,
      "child open after its parent landed": childAfter.data?.state === "open",
      "child landed at its own head": childReceipt.landedHead === child.head,
      "child landed only its own change": childReceipt.changedPaths.length === 1 && childReceipt.changedPaths[0] === `proving/v14/${runId}/child.md`,
    };
    const failed = Object.entries(checks).filter(([, held]) => !held).map(([name]) => name);
    return { v: "V-14", status: failed.length === 0 ? "pass" : "fail", evidence, detail: failed.length === 0 ? `a two-part stack landed through the real queue: ${Object.keys(checks).join("; ")}` : `failed: ${failed.join("; ")}` };
  });
}
