/**
 * `harness deps adopt <pr>` — the real ports of the dependency adoption
 * (`deps-adopt.ts` holds the judgement and the order): the agent's forge
 * client on the trunk repository, the one configured workspace manager and its
 * declared-command runner, `harness sync` in the workspace, and a commit as the
 * agent identity with sign-off through the hooks.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { HarnessError, InputError } from "../kernel/errors.ts";
import { configuredForge } from "./forge/configured-forge.ts";
import { repositoryIdentity } from "./forge/repository-identity.ts";
import { fileAtRef, pullRequestFacts } from "./forge/repository-reads.ts";
import { wrapResult, type HarnessCommandResult } from "./command-result.ts";
import { adoptDependabotPullRequest, DEPS_ADOPT_SYNC_COMMAND, type AdoptReceipt, type DepsAdoptPorts } from "./deps-adopt.ts";
import { configuredWorkspaceManager } from "./workspace-cli.ts";
import { configuredAgentForgeClient, githubWorkspaceForge } from "./workspace-forge-github.ts";

/** git in the workspace, as the agent checkout's own identity (the workspace writer set it), through the hooks; a failure refuses, naming the step. */
function git(step: string, args: readonly string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 26 });
  if (result.status !== 0) throw new HarnessError(`deps adopt: ${step} failed in ${cwd}: ${(result.stderr || result.stdout || "").trim().slice(-2000)}`, "deps_step_failed", false, { step });
  return result.stdout;
}

export async function runDepsCli(root: string, argv: readonly string[]): Promise<HarnessCommandResult<AdoptReceipt>> {
  if (argv[0] !== "adopt" || argv[1] === undefined || !/^[1-9]\d*$/u.test(argv[1]) || argv.length !== 2) {
    throw new InputError("Usage: harness deps adopt <pull request number>", "deps_usage");
  }
  const number = Number(argv[1]);
  const settings = configuredForge();
  const identity = repositoryIdentity(settings);
  const repository = `${identity.owner}/${identity.name}`;
  const client = configuredAgentForgeClient();
  const forge = githubWorkspaceForge(client, { owner: identity.owner, name: identity.name });
  const { manager, declaredCommand, runCommand } = configuredWorkspaceManager(root);
  const declared = async (worktree: string, name: string): Promise<void> => {
    const outcome = await runCommand(worktree, name);
    if (outcome.status === "fail") throw new HarnessError(`deps adopt: the declared command ${name} failed: ${outcome.message}`, "deps_step_failed", false, { step: name });
  };
  const ports: DepsAdoptPorts = {
    readPullRequest: (pull) => pullRequestFacts(client, repository, pull, settings.request.maxPages),
    readFileAt: (path, ref) => fileAtRef(client, repository, path, ref),
    createWorkspace: async (writeSet) => {
      const record = await manager.create({ agentName: `deps-${String(number)}`, mode: "feature", writeSet });
      return { id: record.workspaceId, worktree: record.lease.worktreePath };
    },
    readWorkspaceFile: (worktree, path) => readFileSync(join(worktree, path), "utf8"),
    writeWorkspaceFile: (worktree, path, text) => writeFileSync(join(worktree, path), text),
    declaredArgv: (name) => declaredCommand(name).argv,
    runDeclaredCommand: (worktree, name) => declared(worktree, name),
    // The workspace's own declared regenerate command (`harness-sync`), through the one runner.
    sync: (worktree) => declared(worktree, DEPS_ADOPT_SYNC_COMMAND),
    commit: async (worktree, message) => {
      // Every change the bump made, by its path (`git diff --name-only`), never a blanket add.
      const changed = git("git diff", ["diff", "--name-only", "-z"], worktree).split("\0").filter((path) => path.length > 0);
      if (changed.length === 0) throw new HarnessError("deps adopt: the bump changed nothing in the workspace", "deps_bump_empty");
      git("git add", ["add", "--", ...changed], worktree);
      git("git commit", ["commit", "-s", "-q", "-m", message], worktree);
    },
    publish: async (id) => {
      const publication = await manager.publish(id);
      const pull = publication.record.forge !== null && "pullRequest" in publication.record.forge ? publication.record.forge.pullRequest : null;
      if (pull === null || pull === undefined) throw new HarnessError(`deps adopt: publishing workspace ${id} opened no pull request`, "deps_publish_no_pull_request");
      return { number: pull.number };
    },
    closePullRequest: (pull, comment) => forge.closePullRequest(pull, comment),
  };
  return wrapResult("deps adopt", await adoptDependabotPullRequest(number, ports), { status: "pass" });
}
