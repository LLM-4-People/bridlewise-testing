import { writeFileSync } from "node:fs";

import {
  countOpenAlerts,
  latestByWorkflow,
  listRuns,
} from "./floor/github.mjs";
import { stableJson } from "./floor/files.mjs";

const REQUIRED_WORKFLOWS = [
  { id: "product.ci", label: "Product CI", workflow: "CI" },
  { id: "product.codeql", label: "Product CodeQL", workflow: "CodeQL" },
  { id: "product.docs", label: "Product docs links", workflow: "Docs links" },
  { id: "product.secret", label: "Product secret scan", workflow: "Secret scan" },
];

function parseArgs(argv) {
  const out = {
    product: "LLM-4-People/bridlewise",
    sha: null,
    tag: null,
    out: "promotion-receipt.json",
    token: process.env.GH_TOKEN || null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--product") out.product = argv[++index];
    else if (arg === "--sha") out.sha = argv[++index];
    else if (arg === "--tag") out.tag = argv[++index];
    else if (arg === "--out") out.out = argv[++index];
    else if (arg === "--token") out.token = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!out.sha) throw new Error("--sha is required");
  if (!out.token) throw new Error("GH_TOKEN or --token is required");
  return out;
}

function checkFromRun(definition, run, sha) {
  if (!run) {
    return {
      id: definition.id,
      label: definition.label,
      status: "unknown",
      conclusion: null,
      headSha: null,
      runUrl: null,
      note: "No run for this workflow was returned.",
    };
  }
  if (run.headSha !== sha) {
    return {
      id: definition.id,
      label: definition.label,
      status: "unknown",
      conclusion: run.conclusion,
      headSha: run.headSha,
      runUrl: run.url,
      note: "The latest run is for a different commit.",
    };
  }
  if (run.status !== "completed") {
    return {
      id: definition.id,
      label: definition.label,
      status: "unknown",
      conclusion: run.conclusion,
      headSha: run.headSha,
      runUrl: run.url,
      note: "The run is not complete.",
    };
  }
  return {
    id: definition.id,
    label: definition.label,
    status: run.conclusion === "success" ? "pass" : "fail",
    conclusion: run.conclusion,
    headSha: run.headSha,
    runUrl: run.url,
    note: null,
  };
}

async function alerts(repository, kind, token, fetchImpl) {
  try {
    const value = await countOpenAlerts(repository, kind, token, { fetchImpl });
    return {
      status: value.critical > 0 || value.high > 0 ? "fail" : "pass",
      ...value,
      note: value.truncated ? "The API returned 100 alerts; the count may be truncated." : null,
    };
  } catch (error) {
    return {
      status: "unknown",
      total: null,
      high: null,
      critical: null,
      truncated: false,
      note: `The alert API did not answer: ${error.status ?? "network"}.`,
    };
  }
}

export async function buildPromotionReceipt({
  product,
  sha,
  tag,
  token,
  fetchImpl = fetch,
  now = new Date(),
}) {
  const runs = await listRuns(product, token, { fetchImpl });
  const latest = latestByWorkflow(runs);
  const checks = REQUIRED_WORKFLOWS.map((definition) =>
    checkFromRun(definition, latest.get(definition.workflow), sha),
  );
  const codeScanning = await alerts(product, "code-scanning", token, fetchImpl);
  const dependabot = await alerts(product, "dependabot", token, fetchImpl);
  const blockers = [
    ...checks.filter((check) => check.status !== "pass").map((check) => `${check.id}:${check.status}`),
    ...(codeScanning.status === "pass" ? [] : [`product.code_scanning:${codeScanning.status}`]),
    ...(dependabot.status === "pass" ? [] : [`product.dependabot:${dependabot.status}`]),
  ];
  return {
    schemaVersion: "bridlewise-promotion-receipt/v1",
    generatedAt: now.toISOString(),
    mode: "release",
    product: { repository: product, sha, tag: tag ?? null },
    checks: [
      ...checks,
      { id: "product.code_scanning", label: "Product code scanning", ...codeScanning },
      { id: "product.dependabot", label: "Product Dependabot", ...dependabot },
    ],
    verdict: blockers.length === 0 ? "pass" : "blocked",
    blockers,
    note:
      "This receipt checks the public product workflows and the product security queues. It does not replace the build, the attestation, or a human release approval.",
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const receipt = await buildPromotionReceipt(args);
  writeFileSync(args.out, stableJson(receipt));
  process.stdout.write(
    `promotion gate: ${receipt.verdict} (${receipt.checks.length} checks, ${receipt.blockers.length} blockers)\n`,
  );
  if (receipt.verdict !== "pass") process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`promotion gate failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
