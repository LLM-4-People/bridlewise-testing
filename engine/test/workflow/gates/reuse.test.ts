/**
 * REUSE BY K: the locator, the eligibility, the proof and the reused plan.
 *
 *   - the locator is found by its exact name, newest first, never an expired
 *     one; a key that is not a full digest is refused;
 *   - a fork, a CI-changing tree, a cold run and a key with a failed verdict
 *     on record are each ineligible, by name;
 *   - a proof is accepted only when the key document hashes to K and a
 *     verified statement for subject K carries the door's predicate type and
 *     a successful verdict for K — each other shape is `gate_reuse_unproven`;
 *   - a reused plan runs no cell; its seal reuses every light and suite gate,
 *     still judges the action gates, and refuses any result that ran anyway;
 *   - the pipeline's owner is compared by object id between a commit and its
 *     base, on real git history;
 *   - the post-land seal: a main commit is sealed only by the door App's
 *     successful check keyed by K and the proven verdict for K naming main's
 *     own tree; each other case is a finding by name.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { canonicalJson, sha256 } from "../../../src/kernel/integrity.ts";
import { githubClient } from "../../../src/workflow/forge/github.ts";
import { memoryCredential } from "../../../src/workflow/forge/credentials.ts";
import { GATE_CATALOGUE } from "../../../src/workflow/gates/catalogue.ts";
import { parsePlan, planGates, reusedPlan } from "../../../src/workflow/gates/plan.ts";
import { DOOR_CHECK, doorCheckOn, judgeMainIntegrity } from "../../../src/workflow/gates/main-integrity.ts";
import { DOOR_PREDICATE_TYPE, findVerdictLocator, judgeReuseProof, pipelineChanged, reuseEligibility, verdictLocatorName } from "../../../src/workflow/gates/reuse.ts";
import { sealReceipt } from "../../../src/workflow/gates/seal.ts";
import { fakeGithub } from "../../forge/fake-github.ts";
import { mkGitTempDir } from "../../support/git-fixtures.ts";
import { testGitIdentityEnvironment } from "../../support/test-git-identity.ts";
import { plantedKey } from "./gate-fixtures.ts";

const TREE = "b".repeat(40);
const KEY_DOCUMENT = canonicalJson(plantedKey(TREE));
const KEY = sha256(KEY_DOCUMENT);

function refusedWith(code: string): (error: unknown) => boolean {
  return (error: unknown) => (error as { code?: string }).code === code;
}

function statement(overrides: Readonly<Record<string, unknown>> = {}, predicate: Readonly<Record<string, unknown>> = {}) {
  return { verificationResult: { statement: { subject: [{ name: "keydoc.json", digest: { sha256: KEY } }], predicateType: DOOR_PREDICATE_TYPE, predicate: { verdict: "success", key: KEY, ...predicate }, ...overrides } } };
}

test("the locator is found by its exact name, newest first, never expired", async () => {
  const fake = fakeGithub();
  const name = verdictLocatorName(KEY, "success");
  fake.route("GET", /^\/repos\/o\/r\/actions\/artifacts$/u, (request) => {
    assert.equal(request.query.get("name"), name, "the API's own name filter is used");
    return { status: 200, body: { total_count: 3, artifacts: [
      { id: 1, name, expired: false, created_at: "2026-10-20T00:00:00Z", workflow_run: { id: 11 } },
      { id: 2, name, expired: false, created_at: "2026-10-21T00:00:00Z", workflow_run: { id: 12 } },
      { id: 3, name, expired: true, created_at: "2026-10-22T00:00:00Z", workflow_run: { id: 13 } },
    ] } };
  });
  const client = githubClient(fake.endpoint(), memoryCredential("ci", fake.userToken("ci")));
  assert.deepEqual(await findVerdictLocator(client, { owner: "o", name: "r" }, KEY, "success"), { artifactId: 2, runId: 12, name });
  assert.equal(name, `door-verdict-${KEY}-success`);
  assert.throws(() => verdictLocatorName("abc", "success"), refusedWith("gate_reuse_invalid"));
});

test("eligibility names each reason a run goes cold", () => {
  assert.deepEqual(reuseEligibility({ fork: false, generatorChanged: false, cold: false, failedBefore: false }), { eligible: true, reasons: [] });
  for (const fact of ["fork", "generatorChanged", "cold", "failedBefore"] as const) {
    const verdict = reuseEligibility({ fork: false, generatorChanged: false, cold: false, failedBefore: false, [fact]: true });
    assert.equal(verdict.eligible, false, fact);
    assert.equal(verdict.reasons.length, 1, fact);
  }
});

test("a proof is accepted only for the key's own successful door verdict", () => {
  assert.equal(judgeReuseProof(KEY, KEY_DOCUMENT, [statement()]).key, KEY);
  const unproven = refusedWith("gate_reuse_unproven");
  assert.throws(() => judgeReuseProof(KEY, `${KEY_DOCUMENT} `, [statement()]), unproven, "a key document that does not hash to K");
  assert.throws(() => judgeReuseProof(KEY, KEY_DOCUMENT, []), unproven, "nothing verified");
  assert.throws(() => judgeReuseProof(KEY, KEY_DOCUMENT, [statement({}, { verdict: "failure" })]), unproven, "a failed verdict");
  assert.throws(() => judgeReuseProof(KEY, KEY_DOCUMENT, [statement({}, { key: "0".repeat(64) })]), unproven, "a verdict for another key");
  assert.throws(() => judgeReuseProof(KEY, KEY_DOCUMENT, [statement({ predicateType: "https://slsa.dev/provenance/v1" })]), unproven, "another predicate type");
  assert.throws(() => judgeReuseProof(KEY, KEY_DOCUMENT, [statement({ subject: [{ digest: { sha256: "1".repeat(64) } }] })]), unproven, "another subject");
  assert.equal(judgeReuseProof(KEY, KEY_DOCUMENT, [statement({}, { verdict: "failure" }), statement()]).key, KEY, "any one verified statement for K suffices");
});

test("a reused plan runs no cell; its seal reuses every gate it ran before and refuses a result that ran anyway", () => {
  const plan = planGates({ headSha: "a".repeat(40), treeId: TREE, key: plantedKey(TREE), populations: [
    { population: "web-tests", source: "planted", files: ["tests/unit/a.test.ts", "tests/unit/b.test.ts"], excluded: [] },
    { population: "engine-tests", source: "planted", files: ["engine/test/a.test.ts", "engine/test/b.test.ts"], excluded: [] },
  ] });
  const reused = reusedPlan(plan, { key: plan.keyDigest, doorRun: 12, predicate: { verdict: "success" } });
  assert.deepEqual(reused.cells, []);
  assert.deepEqual(parsePlan(JSON.parse(JSON.stringify(reused))), reused);
  assert.throws(() => reusedPlan(plan, { key: "0".repeat(64), doorRun: 12, predicate: {} }), refusedWith("gate_plan_invalid"));
  assert.throws(() => parsePlan({ ...JSON.parse(JSON.stringify(reused)), cells: plan.cells }), refusedWith("gate_plan_invalid"), "a reuse with cells left to run");
  const receipt = sealReceipt({ plan: reused, results: [], jobs: { "dependency-review": { result: "success" } }, event: "pull_request" });
  assert.equal(receipt.verdict, "passed", receipt.refusals.join("; "));
  assert.deepEqual(receipt.gates.filter((gate) => gate.status === "reused").map((gate) => gate.id), GATE_CATALOGUE.filter((gate) => gate.class !== "action").map((gate) => gate.id));
  assert.equal(sealReceipt({ plan: reused, results: [], jobs: { "dependency-review": { result: "failure" } }, event: "pull_request" }).verdict, "failed", "an action gate is never reused");
  const ranAnyway = { schemaVersion: "bridlewise-gate-result/v1", gate: "docs-links", cell: "docs-links", catalogueDigest: plan.catalogueDigest, headSha: plan.headSha, treeId: plan.treeId, status: "passed", startedAt: "x", finishedAt: "y", steps: [] };
  assert.equal(sealReceipt({ plan: reused, results: [ranAnyway], jobs: { "dependency-review": { result: "success" } }, event: "pull_request" }).verdict, "failed");
});

test("the pipeline's owner is compared by object id against the base, on real history", () => {
  const root = mkGitTempDir("reuse-owner");
  const git = (...argv: string[]) => {
    const result = spawnSync("git", ["-C", root, "-c", "commit.gpgsign=false", ...argv], { encoding: "utf8", env: { ...process.env, ...testGitIdentityEnvironment() } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  git("init", "-q", "-b", "main");
  write("engine/src/workflow/gates/catalogue.ts", "export {};\n");
  write("src/app.ts", "export const a = 1;\n");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");
  write("src/app.ts", "export const a = 2;\n");
  git("commit", "-q", "-am", "app only");
  const appOnly = git("rev-parse", "HEAD");
  write("engine/src/workflow/gates/catalogue.ts", "export const changed = true;\n");
  git("commit", "-q", "-am", "pipeline");
  const pipeline = git("rev-parse", "HEAD");
  const repository = { root, executable: "git", timeoutMs: 30_000 };
  assert.equal(pipelineChanged(repository, appOnly, base), false);
  assert.equal(pipelineChanged(repository, pipeline, base), true);
});

// ── the post-land seal ─────────────────────────────────────────────────────

test("the post-land seal: main is sealed only by the door's success for K, proven, naming main's tree", () => {
  const check = { key: KEY, conclusion: "success", appSlug: DOOR_CHECK.appSlug };
  const judge = (overrides: Partial<Parameters<typeof judgeMainIntegrity>[0]> = {}) =>
    judgeMainIntegrity({ treeId: TREE, check, keyDocument: KEY_DOCUMENT, verified: [statement()], ...overrides });
  assert.deepEqual(judge(), { sealed: true, findings: [] });
  const cases: readonly (readonly [Partial<Parameters<typeof judgeMainIntegrity>[0]>, RegExp])[] = [
    [{ check: null }, /carries no bridlewise\/door check/u],
    [{ check: { ...check, appSlug: "someone-else" } }, /posted by someone-else, not the door App/u],
    [{ check: { ...check, conclusion: "failure" } }, /concluded failure/u],
    [{ check: { ...check, key: "" } }, /names no key/u],
    [{ keyDocument: null }, /could not be located/u],
    [{ verified: [] }, /./u],
    [{ treeId: "c".repeat(40) }, new RegExp(`the door judged tree ${TREE}, but main holds c{40}`, "u")],
  ];
  for (const [overrides, finding] of cases) {
    const verdict = judge(overrides);
    assert.equal(verdict.sealed, false, JSON.stringify(overrides));
    assert.equal(verdict.findings.length, 1, verdict.findings.join("; "));
    assert.match(verdict.findings[0]!, finding);
  }
});

test("the post-land seal reads the door's latest check on the commit, or none", async () => {
  const fake = fakeGithub();
  const sha = "d".repeat(40);
  fake.route("GET", new RegExp(`^/repos/o/r/commits/${sha}/check-runs$`, "u"), (request) => {
    assert.equal(request.query.get("check_name"), DOOR_CHECK.name);
    assert.equal(request.query.get("filter"), "latest");
    return { status: 200, body: { total_count: 1, check_runs: [{ external_id: KEY, conclusion: "success", app: { slug: DOOR_CHECK.appSlug } }] } };
  });
  fake.route("GET", new RegExp(`^/repos/o/r/commits/${"e".repeat(40)}/check-runs$`, "u"), () => ({ status: 200, body: { total_count: 0, check_runs: [] } }));
  const client = githubClient(fake.endpoint(), memoryCredential("ci", fake.userToken("ci")));
  assert.deepEqual(await doorCheckOn(client, { owner: "o", name: "r" }, sha), { key: KEY, conclusion: "success", appSlug: DOOR_CHECK.appSlug });
  assert.equal(await doorCheckOn(client, { owner: "o", name: "r" }, "e".repeat(40)), null);
});
