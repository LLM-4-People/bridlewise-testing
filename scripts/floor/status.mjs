import {
  countOpenAlerts,
  latestByWorkflow,
  listReleases,
  readFailureCode,
  workflowRuns,
} from "../../engine/src/workflow/forge/repository-reads.ts";
import { configuredRepositoryIdentity } from "../../engine/src/workflow/forge/repository-identity.ts";
import { repoInfo } from "./files.mjs";

export const STATUS_SCHEMA = "bridlewise-floor-status/v1";
/** This repository (`owner/name`), from the one repository identity (the forge configuration). */
const TESTING_REPOSITORY = configuredRepositoryIdentity().fullName;
export const PRODUCT_REPOSITORY = "LLM-4-People/bridlewise";

const REQUIRED = [
  { id: "testing.ci", label: "Testing CI", repository: TESTING_REPOSITORY, workflow: "CI", required: true },
  { id: "testing.codeql", label: "Testing CodeQL", repository: TESTING_REPOSITORY, workflow: "CodeQL", required: true },
  { id: "testing.docs", label: "Testing docs links", repository: TESTING_REPOSITORY, workflow: "Docs links", required: true },
  { id: "testing.secret", label: "Testing secret scan", repository: TESTING_REPOSITORY, workflow: "Secret scan", required: true },
  { id: "product.ci", label: "Product CI", repository: PRODUCT_REPOSITORY, workflow: "CI", required: true },
  { id: "product.codeql", label: "Product CodeQL", repository: PRODUCT_REPOSITORY, workflow: "CodeQL", required: true },
  { id: "product.docs", label: "Product docs links", repository: PRODUCT_REPOSITORY, workflow: "Docs links", required: true },
  { id: "product.secret", label: "Product secret scan", repository: PRODUCT_REPOSITORY, workflow: "Secret scan", required: true },
  { id: "testing.pages", label: "Testing Pages", repository: TESTING_REPOSITORY, workflow: "Docs site", required: false },
  { id: "product.pages", label: "Product Pages", repository: PRODUCT_REPOSITORY, workflow: "Docs site", required: false },
];

function durationMs(run) {
  if (!run?.createdAt || !run?.updatedAt) return null;
  const start = Date.parse(run.createdAt);
  const end = Date.parse(run.updatedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

function checkFromRun(definition, run, repositoryCommit) {
  if (!run) {
    return {
      id: definition.id,
      label: definition.label,
      status: "unknown",
      required: definition.required,
      conclusion: null,
      headSha: null,
      runUrl: null,
      durationMs: null,
      note: "No run was returned for this workflow.",
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

function settled(result, code = "api-error") {
  if (result.status === "fulfilled") return { ok: true, value: result.value };
  return { ok: false, code: readFailureCode(result.reason) === "authentication" ? "authentication" : code };
}

/**
 * The floor status. GitHub is read through the forge port: `client` (the
 * build's token) for the testing repository, `publicClient` (no credential)
 * for the product's public reads. Offline, neither is asked.
 */
export async function buildStatus({
  testingRoot,
  productRoot = null,
  client = null,
  publicClient = null,
  now = new Date(),
  counts = null,
  offline = false,
}) {
  const testing = repoInfo(testingRoot);
  const product = repoInfo(productRoot);
  if (!offline && (client === null || publicClient === null)) throw new Error("buildStatus needs the forge clients unless offline");

  const offlineResult = { status: "rejected", reason: Object.assign(new Error("offline"), { code: "offline" }) };
  const [testingRunsResult, productRunsResult, testingCodeResult, testingDepResult, releasesResult] =
    offline
      ? [offlineResult, offlineResult, offlineResult, offlineResult, offlineResult]
      : await Promise.allSettled([
          workflowRuns(client, TESTING_REPOSITORY),
          workflowRuns(publicClient, PRODUCT_REPOSITORY),
          countOpenAlerts(client, TESTING_REPOSITORY, "code-scanning"),
          countOpenAlerts(client, TESTING_REPOSITORY, "dependabot"),
          listReleases(publicClient, PRODUCT_REPOSITORY),
        ]);

  const testingRuns = settled(testingRunsResult);
  const productRuns = settled(productRunsResult);
  const testingCode = settled(testingCodeResult);
  const testingDependencies = settled(testingDepResult);
  const releases = settled(releasesResult);

  const testingLatest = testingRuns.ok ? latestByWorkflow(testingRuns.value) : new Map();
  const productLatest = productRuns.ok ? latestByWorkflow(productRuns.value) : new Map();

  const checks = [];
  for (const definition of REQUIRED) {
    const latest = definition.repository === TESTING_REPOSITORY ? testingLatest : productLatest;
    const commit = definition.repository === TESTING_REPOSITORY ? testing.commit : product.commit;
    checks.push(checkFromRun(definition, latest.get(definition.workflow), commit));
  }
  checks.push(
    securityCheck(
      "testing.code_scanning",
      "Testing code scanning",
      testingCode,
      true,
    ),
    securityCheck(
      "testing.dependabot",
      "Testing Dependabot",
      testingDependencies,
      true,
    ),
    securityCheck(
      "product.code_scanning",
      "Product code scanning",
      { ok: false, code: "authentication" },
      false,
    ),
    securityCheck(
      "product.dependabot",
      "Product Dependabot",
      { ok: false, code: "authentication" },
      false,
    ),
  );

  const required = checks.filter((check) => check.required);
  const failed = required.filter((check) => check.status === "fail");
  const unknown = required.filter((check) => check.status !== "pass" && check.status !== "fail");
  const promotionState =
    failed.length > 0 ? "blocked" : unknown.length > 0 ? "unknown" : "ready";

  const runs = [];
  for (const run of testingLatest.values()) {
    runs.push({
      repository: TESTING_REPOSITORY,
      workflow: run.name ?? "unknown",
      runId: run.id,
      status: run.status,
      conclusion: run.conclusion,
      headSha: run.headSha,
      url: run.url,
    });
  }
  for (const run of productLatest.values()) {
    runs.push({
      repository: PRODUCT_REPOSITORY,
      workflow: run.name ?? "unknown",
      runId: run.id,
      status: run.status,
      conclusion: run.conclusion,
      headSha: run.headSha,
      url: run.url,
    });
  }
  runs.sort((left, right) =>
    `${left.repository}:${left.workflow}`.localeCompare(`${right.repository}:${right.workflow}`),
  );

  const githubAvailable = testingRuns.ok && productRuns.ok;
  const githubReasons = [];
  if (!testingRuns.ok) githubReasons.push(`testing ${testingRuns.code}`);
  if (!productRuns.ok) githubReasons.push(`product ${productRuns.code}`);

  return {
    schemaVersion: STATUS_SCHEMA,
    generatedAt: now.toISOString(),
    mode: "public-pages",
    source: {
      repository: TESTING_REPOSITORY,
      ref: "refs/heads/main",
      commit: testing.commit,
      committedAt: testing.committedAt,
    },
    product: {
      repository: PRODUCT_REPOSITORY,
      ref: "refs/heads/main",
      commit: product.commit,
      committedAt: product.committedAt,
    },
    promotion: {
      profile: "public-preview",
      state: promotionState,
      pending: { commits: null, oldestPendingAgeHours: null },
      hold: null,
      lastRun: null,
      reason:
        "The public Pages snapshot is not a release gate. The product release workflow runs the promotion gate with a product-scoped token.",
      failed: failed.map((check) => check.id),
      unknown: unknown.map((check) => check.id),
    },
    checks,
    github: {
      available: githubAvailable,
      checkedAt: now.toISOString(),
      reason: githubAvailable ? null : githubReasons.join(", "),
      runs,
    },
    release: releases.ok
      ? releases.value.find((release) => !release.draft) ?? null
      : null,
    counts: counts ?? null,
  };
}
