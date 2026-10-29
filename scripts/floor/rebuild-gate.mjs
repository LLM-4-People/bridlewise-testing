#!/usr/bin/env node
/**
 * THE PAGES REBUILD GATE — when a status workflow finishes, whether the Docs
 * site is built again from `main`'s tip.
 *
 * A push to `main` builds the site at once, in the same moment its checks
 * start, so that build judges every claim while its checks still run. The
 * site is rebuilt when they finish: `pages.yml` also runs on the completion
 * of each workflow the floor status reads (`REBUILD_WORKFLOWS`), and this
 * gate decides from TRUSTED data only, `main`'s tip as GitHub reports it and
 * the completed run's id. It never reads the completed run's head commit,
 * branch or repository, which a fork's pull request controls. Then:
 * - a run at `main`'s tip that fires this gate ({@link firesRebuild}: a
 *   status workflow's run on `main`; the merge queue's runs at the same
 *   commit fire nothing and count for nothing) is still going: no rebuild yet
 *   (its own completion runs this gate again; nothing waits or polls);
 * - the completed run is not the status run at the tip that finished last
 *   (a run at another commit, a fork's, or one that finished before the
 *   last): no rebuild, since the last one's own gate rebuilds;
 * - otherwise: rebuild `main`'s tip. So a burst of completions builds once,
 *   after the last one, and two that finish together pick one between them
 *   (the later finish, then the higher run id) with no cancelled run.
 * The completed run is finished whatever GitHub's list still says (its own
 * completion event is the proof), and then it is the last to finish: a list
 * that lags never leaves the tip unbuilt.
 *
 * Every GitHub read goes through the forge's one client
 * (`engine/src/workflow/forge/repository-reads.ts`).
 *
 *   node scripts/floor/rebuild-gate.mjs
 *   (GH_TOKEN; the completed run's id as RUN_ID; writes build=true|false and
 *   sha=<main's tip> to $GITHUB_OUTPUT)
 */
import { appendFileSync } from "node:fs";

import { configuredForgeClient } from "../../engine/src/workflow/forge/configured-forge.ts";
import { environmentCredential } from "../../engine/src/workflow/forge/credentials.ts";
import { branchTip, workflowRuns } from "../../engine/src/workflow/forge/repository-reads.ts";
import { bootstrapProcess, isEntryPoint } from "../../engine/src/runtime/cli-debug.ts";
import { DEFAULT_BRANCH, REPOSITORY } from "./repository.mjs";
import { MAIN_RUN_BRANCHES, STATUS_WORKFLOWS, SITE_WORKFLOW, reportsMain } from "./status.mjs";

/** The workflows whose completion rebuilds the site: every one the floor status reads, but the site's own. */
export const REBUILD_WORKFLOWS = Object.freeze(STATUS_WORKFLOWS.filter((workflow) => workflow !== SITE_WORKFLOW));

/**
 * THE RUNS WHOSE COMPLETION REBUILDS, the one definition: a rebuild workflow's
 * run on a branch that reports main ({@link reportsMain}). `pages.yml`'s
 * `on.workflow_run` is exactly this (`workflows`, `branches`; a test holds it
 * to it), and the gate counts exactly these runs, so every run the gate waits
 * for fires the gate when it completes.
 */
export const REBUILD_TRIGGER = Object.freeze({ workflows: REBUILD_WORKFLOWS, branches: MAIN_RUN_BRANCHES });

/** Whether `run` (`{ name, headBranch }`) is one {@link REBUILD_TRIGGER} fires on. */
export function firesRebuild(run) {
  return REBUILD_TRIGGER.workflows.includes(run.name) && reportsMain(run);
}

/** Finish order: the later `updatedAt`, then the higher run id. */
const finishedAfter = (left, right) => String(left.updatedAt) > String(right.updatedAt) || (String(left.updatedAt) === String(right.updatedAt) && left.id > right.id);

/**
 * The gate's decision (see the header) for the completed run `runId`,
 * `main`'s tip `mainHead` and the workflow runs at that tip `runs`
 * (`{ id, name, headBranch, status, updatedAt }`). Pure.
 */
export function rebuildDecision({ runId, mainHead, runs, branch = DEFAULT_BRANCH }) {
  if (typeof mainHead !== "string") return { build: false, sha: "", reason: `GitHub named no tip for ${branch}: nothing to rebuild` };
  const status = runs.filter(firesRebuild);
  const completed = status.find((run) => run.id === runId);
  if (completed === undefined) return { build: false, sha: mainHead, reason: `run ${String(runId)} is not a status run at ${branch}'s tip ${mainHead}: nothing to rebuild` };
  const running = [...new Set(status.filter((run) => run.id !== runId && run.status !== "completed").map((run) => run.name))].sort();
  if (running.length > 0) return { build: false, sha: mainHead, reason: `${running.join(", ")} still running at ${mainHead}: its completion rebuilds the site` };
  if (completed.status === "completed") {
    const last = status.reduce((latest, run) => (finishedAfter(run, latest) ? run : latest));
    if (last.id !== runId) return { build: false, sha: mainHead, reason: `${String(last.name)} (run ${String(last.id)}) finished last at ${mainHead}: its completion rebuilds the site` };
  }
  return { build: true, sha: mainHead, reason: `every status workflow at ${mainHead} has finished: rebuilding the site with their results` };
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  try {
    const runId = Number(process.env.RUN_ID ?? "");
    if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error(`RUN_ID ${JSON.stringify(process.env.RUN_ID ?? null)} is not a run id`);
    const client = configuredForgeClient(environmentCredential("pages:GH_TOKEN", "GH_TOKEN"));
    const tip = await branchTip(client, REPOSITORY, DEFAULT_BRANCH);
    const runs = tip === null ? [] : await workflowRuns(client, REPOSITORY, tip.commit);
    const result = rebuildDecision({ runId, mainHead: tip?.commit ?? null, runs });
    process.stdout.write(`${result.build ? "" : "::notice title=Pages rebuild skipped::"}rebuild gate: ${result.reason}\n`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `build=${String(result.build)}\nsha=${result.sha}\n`);
  } catch (error) {
    process.stderr.write(`::error title=Pages rebuild gate::rebuild gate failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
