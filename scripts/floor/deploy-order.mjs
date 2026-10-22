#!/usr/bin/env node
/**
 * THE PAGES DEPLOY ORDER — a site built from an older `main` commit never
 * replaces one built from a newer commit.
 *
 * `main` builds run in parallel and their deploys wait in one queue, in the
 * order the builds FINISHED, which is not the order of their commits. So the
 * deploy job asks GitHub, just before it deploys, which commit the live site
 * was built from, and compares the commit it carries. The live site is the
 * newest `github-pages` deployment that reached `success` WITH a page URL:
 * every deploy job is a deployment of that environment, but only one whose
 * deploy step ran reports the site's URL (a superseded job succeeds with
 * none), and the queue creates them in the order they run. Then:
 * - nothing published yet, or this commit is the published one or descends
 *   from it (`identical` / `ahead`): deploy;
 * - this commit is an ancestor of the published one (`behind`): a newer site
 *   is already live, so this deploy is superseded and skipped, with a notice;
 * - otherwise the relation is unknown — the histories diverged, GitHub no
 *   longer holds the published commit (a history rewrite: runbook P6), or no
 *   recent deployment published a site — and the deploy is REFUSED with a
 *   typed code naming its one remedy. Unknown is never "deploy anyway".
 *
 * THE REMEDY is a recorded override: dispatch the Pages workflow from `main`
 * with `supersede_published` set to the exact commit the refusal names (or
 * `unknown` when it names none). The dispatch runs through the
 * `pages-override` environment, whose reviewer approves it, and the run
 * records who asked, for which commit, and why it was refused. An override
 * that names a different commit than the live one is refused: it would be a
 * blind replace.
 *
 * Every GitHub read goes through the forge's one client
 * (`engine/src/workflow/forge/repository-reads.ts`). The deploy queue
 * serialises the checks, so the answer cannot go stale between the check and
 * the deploy of the same job. Nothing here reads a clock.
 *
 *   node scripts/floor/deploy-order.mjs --sha <commit> [--supersede <published commit|unknown>]
 *   (GH_TOKEN; writes deploy=true|false to $GITHUB_OUTPUT)
 */
import { appendFileSync } from "node:fs";

import { configuredForgeClient } from "../../engine/src/workflow/forge/configured-forge.ts";
import { environmentCredential } from "../../engine/src/workflow/forge/credentials.ts";
import { compareCommits, deploymentStatuses, deployments } from "../../engine/src/workflow/forge/repository-reads.ts";
import { isEntryPoint } from "../../engine/src/runtime/entry-point.ts";
import { REPOSITORY } from "./repository.mjs";

export const PAGES_ENVIRONMENT = "github-pages";
const COMMIT = /^[0-9a-f]{40}$/u;

const OVERRIDE_REMEDY = (published) =>
  `if the published site is meant to be replaced (e.g. after a history rewrite, runbook P6), dispatch the Pages workflow from main with supersede_published=${published ?? "unknown"}; the pages-override environment's reviewer approves the run, which records the override`;

/** The deploy order's typed refusals, each with its one remedy. */
export const DEPLOY_ORDER_CODES = Object.freeze({
  site_deploy_sha_invalid: "pass the full commit id of the build (--sha \"$GITHUB_SHA\")",
  site_deploy_history_rewritten: OVERRIDE_REMEDY,
  site_deploy_diverged: OVERRIDE_REMEDY,
  site_deploy_published_unknown: OVERRIDE_REMEDY,
  site_deploy_override_mismatch: (published) => `name the commit the live site was built from (${published ?? "unknown"}) in supersede_published, or leave it empty`,
});

export class DeployOrderRefusal extends Error {
  constructor(code, message, published = null) {
    const remedy = DEPLOY_ORDER_CODES[code];
    super(`${code}: ${message}. Remedy: ${typeof remedy === "function" ? remedy(published) : remedy}`);
    this.code = code;
    this.published = published;
  }
}

/**
 * The commit the live site was built from: the newest deployment of the
 * environment that reached `success` with a page URL (a later deploy marks
 * it `inactive`, so its LATEST status is not the test); `null` when the
 * environment has never been deployed. Refuses when deployments exist but
 * none of the recent ones (one page of 100) ever published a site.
 */
export async function publishedCommit({ client, repository = REPOSITORY, environment = PAGES_ENVIRONMENT }) {
  const recent = await deployments(client, repository, environment);
  if (recent.length === 0) return null;
  for (const deployment of recent) {
    const statuses = await deploymentStatuses(client, repository, deployment.id);
    if (statuses.some((status) => status.state === "success" && status.environmentUrl !== null)) return deployment.sha;
  }
  throw new DeployOrderRefusal("site_deploy_published_unknown", `none of the ${String(recent.length)} most recent ${environment} deployments (one page) ever published a site, so the live commit cannot be established`);
}

/**
 * The decision for `sha` against the published commit and their relation
 * (`null`: GitHub no longer holds the published commit), with the recorded
 * override `supersede` (the published commit, `unknown`, or `null`).
 */
export function deployDecision({ sha, published, comparison, supersede = null }) {
  if (published === null) return { deploy: true, reason: "nothing is published yet" };
  if (comparison === "identical") return { deploy: true, reason: `${sha} is the published commit (a re-deploy)` };
  if (comparison === "ahead") return { deploy: true, reason: `${sha} descends from the published ${published}` };
  if (comparison === "behind") return { deploy: false, reason: `the published ${published} already descends from ${sha}: this deploy is superseded` };
  const refusal = comparison === null
    ? new DeployOrderRefusal("site_deploy_history_rewritten", `GitHub no longer holds the published commit ${published}, so whether ${sha} continues it is unknown`, published)
    : new DeployOrderRefusal("site_deploy_diverged", `${sha} and the published ${published} have diverged`, published);
  if (supersede === null) throw refusal;
  if (supersede !== published) throw new DeployOrderRefusal("site_deploy_override_mismatch", `the override names ${supersede}, but the live site was built from ${published}`, published);
  return { deploy: true, reason: `override: ${sha} replaces the published ${published} (${refusal.code}), as the approved dispatch recorded` };
}

/** The whole check: the published commit, the comparison, the decision. */
export async function checkDeployOrder({ sha, client, repository = REPOSITORY, supersede = null }) {
  if (!COMMIT.test(sha)) throw new DeployOrderRefusal("site_deploy_sha_invalid", `--sha must be a full commit id, got ${JSON.stringify(sha)}`);
  let published;
  try {
    published = await publishedCommit({ client, repository });
  } catch (error) {
    if (!(error instanceof DeployOrderRefusal) || error.code !== "site_deploy_published_unknown") throw error;
    if (supersede !== "unknown") throw supersede === null ? error : new DeployOrderRefusal("site_deploy_override_mismatch", `the override names ${supersede}, but the live commit is unknown`);
    return { published: null, deploy: true, reason: "override: the live commit is unknown, and the approved dispatch recorded supersede_published=unknown" };
  }
  if (published === null) return { published, ...deployDecision({ sha, published, comparison: null }) };
  const comparison = await compareCommits(client, repository, published, sha);
  return { published, ...deployDecision({ sha, published, comparison, supersede }) };
}

if (isEntryPoint(import.meta.url)) {
  const value = (flag) => {
    const index = process.argv.indexOf(flag);
    return index === -1 ? null : process.argv[index + 1] ?? "";
  };
  const supersede = value("--supersede");
  try {
    const client = configuredForgeClient(environmentCredential("pages:GH_TOKEN", "GH_TOKEN"));
    const result = await checkDeployOrder({ sha: value("--sha") ?? "", client, supersede: supersede === "" ? null : supersede });
    process.stdout.write(`${result.deploy ? "" : "::notice title=Pages deploy superseded::"}deploy order: ${result.reason}\n`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `deploy=${String(result.deploy)}\n`);
  } catch (error) {
    process.stderr.write(`::error title=Pages deploy order::deploy order refused: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
