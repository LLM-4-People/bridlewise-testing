import {
  branchTip,
  countOpenAlerts,
  latestByWorkflow,
  listReleases,
  readFailureCode,
  workflowJobs,
  workflowRuns,
} from "../../engine/src/workflow/forge/repository-reads.ts";
import { repoInfo } from "./files.mjs";
import { REPOSITORY } from "./repository.mjs";

export const STATUS_SCHEMA = "bridlewise-floor-status/v1";

/** The promotion this snapshot reports: `main` projected onto the `product` branch of the same repository. */
export const PROMOTION = Object.freeze({ profile: "main-to-product", source: "refs/heads/main", target: "refs/heads/product" });

const REQUIRED = [
  { id: "ci", label: "CI", workflow: "CI", required: true },
  { id: "codeql", label: "CodeQL", workflow: "CodeQL", required: true },
  { id: "docs", label: "Docs links", workflow: "Docs links", required: true },
  { id: "secret", label: "Secret scan", workflow: "Secret scan", required: true },
  { id: "pages", label: "Pages", workflow: "Docs site", required: false },
];

/** The workflows the status reads, by name (the names GitHub reports and `on.workflow_run` matches). */
export const STATUS_WORKFLOWS = Object.freeze(REQUIRED.map((definition) => definition.workflow));
/** The site's own workflow (`.github/workflows/pages.yml`). */
export const SITE_WORKFLOW = REQUIRED.find((definition) => definition.id === "pages").workflow;

function durationMs(run) {
  if (!run?.createdAt || !run?.updatedAt) return null;
  const start = Date.parse(run.createdAt);
  const end = Date.parse(run.updatedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

/**
 * One workflow's check at `repositoryCommit` from its latest run there.
 * `runsRead` is whether GitHub answered the run list: no run in an answer is
 * a workflow that did not run at this commit (`not-run`); no answer at all
 * says nothing (`unknown`). A run still going is `unknown` too.
 */
function checkFromRun(definition, run, repositoryCommit, runsRead) {
  if (!run) {
    return {
      id: definition.id,
      label: definition.label,
      status: runsRead ? "not-run" : "unknown",
      required: definition.required,
      conclusion: null,
      headSha: null,
      runUrl: null,
      durationMs: null,
      note: runsRead ? "This workflow did not run at this commit." : "The API did not answer for the workflow runs.",
    };
  }
  let status = "unknown";
  if (run.headSha !== repositoryCommit) status = "not-run";
  else if (run.status !== "completed") status = "unknown";
  else if (run.conclusion === "success") status = "pass";
  else if (run.conclusion === "failure") status = "fail";
  else status = "unknown";
  return {
    id: definition.id,
    label: definition.label,
    status,
    required: definition.required,
    conclusion: run.conclusion,
    headSha: run.headSha,
    runUrl: run.url,
    durationMs: durationMs(run),
    note:
      status === "not-run"
        ? "The latest run is for a different commit. Rerun the workflow for the current commit."
        : null,
  };
}

function securityCheck(id, label, result, required) {
  if (!result.ok) {
    return {
      id,
      label,
      status: "unknown",
      required,
      conclusion: null,
      headSha: null,
      runUrl: null,
      durationMs: null,
      note: result.code === "authentication" ? "The build token could not read this endpoint." : "The API did not answer.",
    };
  }
  const { high, critical, total, judged, declaredTotal, complete } = result.value;
  if (!complete) {
    return {
      id,
      label,
      status: "unknown",
      required,
      conclusion: null,
      headSha: null,
      runUrl: null,
      durationMs: null,
      note:
        declaredTotal === null
          ? "The alert endpoint declared no completeness marker; the population may be truncated."
          : `The alert population is incomplete: ${judged} of ${declaredTotal} declared alert(s) were judged.`,
      high,
      critical,
      total,
    };
  }
  return {
    id,
    label,
    status: critical > 0 || high > 0 ? "fail" : "pass",
    required,
    conclusion: null,
    headSha: null,
    runUrl: null,
    durationMs: null,
    note: `${total} open alert(s).`,
    high,
    critical,
    total,
  };
}

/** Why a run's jobs could not be reported, by the read's typed failure — each cause in its own words. */
const JOBS_NOTES = Object.freeze({
  authentication: () => "The build token could not read this run's jobs.",
  oversized: (maxPages) => `This run has more jobs than ${String(maxPages)} page(s) of 100 hold (forge.request.maxPages); none is reported rather than a partial list.`,
  unavailable: () => "The API did not answer for this run's jobs.",
  timeout: () => "The API did not answer for this run's jobs.",
  "api-error": () => "The API did not answer for this run's jobs.",
});

function settled(result, code = "api-error") {
  if (result.status === "fulfilled") return { ok: true, value: result.value };
  return { ok: false, code: readFailureCode(result.reason) === "authentication" ? "authentication" : code };
}

/**
 * The floor status of this repository (its coordinates from the repository identity):
 * the required workflow runs and alert queues at the source commit, and the
 * `product` branch's tip. GitHub is read through the forge port with
 * `client` (the build's token), each list up to `maxPages` pages (the
 * configured `forge.request.maxPages`, from the caller that built the
 * client); offline, nothing is asked.
 */
export async function buildStatus({
  root,
  client = null,
  maxPages = null,
  now = new Date(),
  counts = null,
  offline = false,
}) {
  const source = repoInfo(root);
  if (!offline && (client === null || maxPages === null)) throw new Error("buildStatus needs the forge client and its page bound unless offline");
  const offlineResult = { status: "rejected", reason: Object.assign(new Error("offline"), { code: "offline" }) };
  const [runsResult, codeResult, dependencyResult, releasesResult, productResult] = offline
    ? [offlineResult, offlineResult, offlineResult, offlineResult, offlineResult]
    : await Promise.allSettled([
        // The runs AT the source commit: the newest run of a workflow may be
        // a pull request's or the merge queue's, which proves nothing here.
        workflowRuns(client, REPOSITORY, source.commit),
        countOpenAlerts(client, REPOSITORY, "code-scanning"),
        countOpenAlerts(client, REPOSITORY, "dependabot"),
        listReleases(client, REPOSITORY, maxPages),
        branchTip(client, REPOSITORY, PROMOTION.target.slice("refs/heads/".length)),
      ]);

  const runs = settled(runsResult);
  const codeScanning = settled(codeResult);
  const dependencies = settled(dependencyResult);
  const releases = settled(releasesResult);
  const product = settled(productResult);
  const latest = runs.ok ? latestByWorkflow(runs.value) : new Map();

  const checks = REQUIRED.map((definition) => checkFromRun(definition, latest.get(definition.workflow), source.commit, runs.ok));
  // Each job's own conclusion, for every workflow run at the source commit, so a claim can be bound to the
  // job that proves it (a workflow passing says nothing about which of its jobs ran what). A run at another
  // commit, or offline, has no jobs to report; a read that fails says so, never an empty list.
  await Promise.all(checks.map(async (check) => {
    const run = latest.get(REQUIRED.find((definition) => definition.id === check.id).workflow);
    if (offline || run === undefined || run.headSha !== source.commit) {
      check.jobs = null;
      return;
    }
    const [answer] = await Promise.allSettled([workflowJobs(client, REPOSITORY, run.id, maxPages)]);
    check.jobs = answer.status === "fulfilled"
      ? answer.value.map((job) => ({ name: job.name, status: job.status, conclusion: job.conclusion, url: job.url })).sort((left, right) => String(left.name).localeCompare(String(right.name)))
      : null;
    if (answer.status === "rejected") check.jobsNote = JOBS_NOTES[readFailureCode(answer.reason)](maxPages);
  }));
  checks.push(
    securityCheck("code_scanning", "Code scanning", codeScanning, true),
    securityCheck("dependabot", "Dependabot", dependencies, true),
  );

  const required = checks.filter((check) => check.required);
  const failed = required.filter((check) => check.status === "fail");
  const unknown = required.filter((check) => check.status !== "pass" && check.status !== "fail");
  const promotionState = failed.length > 0 ? "blocked" : unknown.length > 0 ? "unknown" : "ready";

  const workflowRunRows = [...latest.values()]
    .map((run) => ({
      repository: REPOSITORY,
      workflow: run.name ?? "unknown",
      runId: run.id,
      status: run.status,
      conclusion: run.conclusion,
      headSha: run.headSha,
      url: run.url,
    }))
    .sort((left, right) => left.workflow.localeCompare(right.workflow));

  return {
    schemaVersion: STATUS_SCHEMA,
    generatedAt: now.toISOString(),
    mode: "public-pages",
    source: {
      repository: REPOSITORY,
      ref: PROMOTION.source,
      commit: source.commit,
      committedAt: source.committedAt,
    },
    product: {
      repository: REPOSITORY,
      ref: PROMOTION.target,
      commit: product.ok ? product.value?.commit ?? null : null,
      committedAt: product.ok ? product.value?.committedAt ?? null : null,
    },
    promotion: {
      profile: PROMOTION.profile,
      state: promotionState,
      pending: { commits: null, oldestPendingAgeHours: null },
      hold: null,
      lastRun: null,
      reason: product.ok && product.value === null
        ? `${PROMOTION.target} does not exist yet: no promotion has been published.`
        : `The public Pages snapshot is not a release gate. ${PROMOTION.target} is the projection of ${PROMOTION.source} (profile ${PROMOTION.profile}).`,
      failed: failed.map((check) => check.id),
      unknown: unknown.map((check) => check.id),
    },
    checks,
    github: {
      available: runs.ok,
      checkedAt: now.toISOString(),
      reason: runs.ok ? null : runs.code,
      runs: workflowRunRows,
    },
    release: releases.ok ? releases.value.find((release) => !release.draft) ?? null : null,
    counts: counts ?? null,
  };
}
