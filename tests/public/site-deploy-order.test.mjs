import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";

import { checkDeployOrder, deployDecision, publishedCommit } from "../../scripts/floor/deploy-order.mjs";
import { memoryCredential } from "../../engine/src/workflow/forge/credentials.ts";
import { githubClient } from "../../engine/src/workflow/forge/github.ts";
import { fakeGithub } from "../../engine/test/forge/fake-github.ts";

/**
 * THE PAGES DEPLOY ORDER: a site built from an older `main` commit never
 * replaces a newer one. The check reads GitHub's own records (the
 * `github-pages` deployments and the compare API) through the forge's one
 * client, so these tests drive it against the forge's fake GitHub: each shape
 * the review named, the ways the published commit can be unknown, and the
 * recorded override that is the refusals' one remedy.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const PAGE = "https://llm-4-people.github.io/bridlewise/";

/** A fake GitHub: `deployments` newest first, each `{ id, sha, statuses }`; `compare` maps `base...head` to a status (absent: 404). */
function github({ deployments, compare = {} }) {
  const fake = fakeGithub();
  const requested = [];
  fake.route("GET", /^\/repos\/o\/r\//u, (request) => {
    requested.push(request.path);
    if (request.path.endsWith("/deployments")) return { status: 200, body: deployments.map(({ id, sha }) => ({ id, sha })) };
    const statuses = /\/deployments\/(\d+)\/statuses$/u.exec(request.path);
    if (statuses) return { status: 200, body: deployments.find((entry) => String(entry.id) === statuses[1])?.statuses ?? [] };
    const compared = /\/compare\/([0-9a-f]{40}\.\.\.[0-9a-f]{40})$/u.exec(decodeURIComponent(request.path));
    if (compared && compare[compared[1]] !== undefined) return { status: 200, body: { status: compare[compared[1]] } };
    return { status: 404, body: { message: "Not Found" } };
  });
  return { client: githubClient(fake.endpoint(), memoryCredential("test", fake.userToken("test"))), requested };
}

const published = (url = PAGE) => [{ state: "inactive" }, { state: "success", environment_url: url }, { state: "in_progress" }];
const superseded = [{ state: "success", environment_url: "" }, { state: "in_progress" }];
const check = (sha, world, supersede = null) => checkDeployOrder({ sha, repository: "o/r", supersede, client: github(world).client });

test("the decision follows the commit graph, never the order builds finished", () => {
  assert.equal(deployDecision({ sha: A, published: null, comparison: null }).deploy, true);
  assert.equal(deployDecision({ sha: A, published: A, comparison: "identical" }).deploy, true);
  assert.equal(deployDecision({ sha: B, published: A, comparison: "ahead" }).deploy, true);
  assert.equal(deployDecision({ sha: A, published: B, comparison: "behind" }).deploy, false);
  // Each refusal is its code, and its remedy names the exact override to record.
  assert.throws(() => deployDecision({ sha: A, published: B, comparison: "diverged" }), (error) => error.code === "site_deploy_diverged" && error.published === B && error.message.includes(`supersede_published=${B}`));
  assert.throws(() => deployDecision({ sha: A, published: B, comparison: null }), (error) => error.code === "site_deploy_history_rewritten" && error.message.includes("runbook P6") && error.message.includes(`supersede_published=${B}`));
});

test("B's build finished first and is live: A's later deploy is superseded, not published", async () => {
  const world = { deployments: [{ id: 3, sha: A, statuses: [{ state: "in_progress" }] }, { id: 2, sha: B, statuses: published() }], compare: { [`${B}...${A}`]: "behind" } };
  const { client, requested } = github(world);
  const result = await checkDeployOrder({ sha: A, repository: "o/r", client });
  assert.equal(result.published, B);
  assert.equal(result.deploy, false);
  assert.match(result.reason, /superseded/u);
  assert.ok(requested.some((path) => decodeURIComponent(path).endsWith(`/compare/${B}...${A}`)));
});

test("a superseded job's own deployment record is not mistaken for the live site", async () => {
  const world = {
    deployments: [{ id: 4, sha: C, statuses: [{ state: "in_progress" }] }, { id: 3, sha: A, statuses: superseded }, { id: 2, sha: B, statuses: published() }],
    compare: { [`${B}...${C}`]: "ahead" },
  };
  const result = await check(C, world);
  assert.equal(result.published, B);
  assert.equal(result.deploy, true);
  assert.equal(await publishedCommit({ repository: "o/r", client: github(world).client }), B);
});

test("a first deploy, a re-deploy and a newer commit deploy", async () => {
  assert.equal((await check(A, { deployments: [] })).deploy, true);
  const live = [{ id: 1, sha: A, statuses: published() }];
  assert.equal((await check(A, { deployments: live, compare: { [`${A}...${A}`]: "identical" } })).deploy, true);
  assert.equal((await check(B, { deployments: live, compare: { [`${A}...${B}`]: "ahead" } })).deploy, true);
});

test("an unknown relation refuses with its code and remedy: a rewritten history, divergence, no live deployment, a malformed sha", async () => {
  const live = [{ id: 1, sha: B, statuses: published() }];
  // P6 rewrites history: GitHub answers 404 for the published commit.
  await assert.rejects(check(A, { deployments: live }), (error) => error.code === "site_deploy_history_rewritten" && /runbook P6/u.test(error.message) && error.published === B);
  await assert.rejects(check(A, { deployments: live, compare: { [`${B}...${A}`]: "diverged" } }), (error) => error.code === "site_deploy_diverged");
  await assert.rejects(check(A, { deployments: [{ id: 1, sha: B, statuses: superseded }] }), (error) => error.code === "site_deploy_published_unknown" && /one page/u.test(error.message));
  await assert.rejects(check("main", { deployments: [] }), (error) => error.code === "site_deploy_sha_invalid");
});

test("the recorded override is the remedy: it must name the live commit exactly", async () => {
  const live = [{ id: 1, sha: B, statuses: published() }];
  const rewritten = await check(A, { deployments: live }, B);
  assert.equal(rewritten.deploy, true);
  assert.ok(rewritten.reason.startsWith("override: ") && rewritten.reason.includes("(site_deploy_history_rewritten)"), rewritten.reason);
  assert.equal((await check(A, { deployments: live, compare: { [`${B}...${A}`]: "diverged" } }, B)).deploy, true);
  assert.equal((await check(A, { deployments: [{ id: 1, sha: B, statuses: superseded }] }, "unknown")).deploy, true);
  // A blind replace is refused: the wrong commit, or "unknown" when the live one is known.
  await assert.rejects(check(A, { deployments: live }, C), (error) => error.code === "site_deploy_override_mismatch");
  await assert.rejects(check(A, { deployments: live }, "unknown"), (error) => error.code === "site_deploy_override_mismatch");
  // An override never turns a known order around: behind stays superseded, ahead deploys anyway.
  assert.equal((await check(A, { deployments: live, compare: { [`${B}...${A}`]: "behind" } }, B)).deploy, false);
});

/**
 * The workflow wiring: every job that runs `actions/deploy-pages` runs the
 * order check first, in the same job, and deploys only on its answer. Read as
 * YAML (the one YAML reader), so a flow mapping or a reordered step is the
 * same document to the guard as to GitHub.
 */
function deployWiringViolations(text) {
  const workflow = parse(text);
  const found = [];
  for (const [name, job] of Object.entries(workflow?.jobs ?? {})) {
    const steps = Array.isArray(job?.steps) ? job.steps : [];
    const deployAt = steps.findIndex((step) => String(step?.uses ?? "").startsWith("actions/deploy-pages@"));
    if (deployAt === -1) continue;
    const orderAt = steps.findIndex((step) => /node scripts\/floor\/deploy-order\.mjs --sha "\$GITHUB_SHA"/u.test(String(step?.run ?? "")));
    if (orderAt === -1 || orderAt > deployAt) found.push(`${name}: the deploy runs without the order check before it`);
    else if (String(steps[deployAt].if ?? "").replace(/\s+/gu, " ") !== `steps.${String(steps[orderAt].id)}.outputs.deploy == 'true'`) found.push(`${name}: the deploy does not wait for the order check's answer`);
    if (job?.concurrency?.queue !== "max" || job?.concurrency?.["cancel-in-progress"] !== false) found.push(`${name}: deploys are not serialised in one queue`);
    // An override reaches the check only through a job the override environment approves.
    if (orderAt !== -1 && /--supersede\b/u.test(String(steps[orderAt].run))) {
      const needs = [job?.needs ?? []].flat();
      const approved = needs.some((need) => String(workflow.jobs[need]?.environment?.name ?? workflow.jobs[need]?.environment ?? "") === "pages-override");
      if (!approved) found.push(`${name}: an override reaches the deploy order without the pages-override approval`);
    }
  }
  return found;
}

test("the Pages workflow deploys only on the order check's answer", async () => {
  const text = readFileSync(join(ROOT, ".github/workflows/pages.yml"), "utf8");
  assert.deepEqual(deployWiringViolations(text), []);
  // Plants: the deploy no longer waits for the answer; the check removed; the check after the deploy; the queue dropped.
  const condition = "        if: steps.order.outputs.deploy == 'true'\n";
  assert.ok(text.includes(condition));
  assert.match(deployWiringViolations(text.replace(condition, "")).join(), /does not wait/u);
  const check = /      - name: Check the deploy order\n[\s\S]*?run: node scripts\/floor\/deploy-order\.mjs --sha "\$GITHUB_SHA"[^\n]*\n\n/u;
  assert.match(text, check);
  assert.match(deployWiringViolations(text.replace(check, "")).join(), /without the order check/u);
  assert.match(deployWiringViolations(text.replace("      queue: max\n", "")).join(), /not serialised/u);
  assert.match(deployWiringViolations(text.replace("    needs: [build, approve-override]\n", "    needs: build\n")).join(), /without the pages-override approval/u);
  assert.match(deployWiringViolations(text.replace("      name: pages-override\n", "      name: github-pages\n")).join(), /without the pages-override approval/u);
  // Near miss: the same wiring in flow style is the same document.
  assert.deepEqual(deployWiringViolations(text.replace(condition, "        if: \"steps.order.outputs.deploy == 'true'\"\n")), []);
});
