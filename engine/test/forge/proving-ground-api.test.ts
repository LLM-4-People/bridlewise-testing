import assert from "node:assert/strict";
import test from "node:test";

import { isForgeError } from "../../src/workflow/forge/codes.ts";
import { configuredForge } from "../../src/workflow/forge/configured-forge.ts";
import { memoryCredential } from "../../src/workflow/forge/credentials.ts";
import type { ForgeSettings } from "../../src/workflow/forge/forge-config.ts";
import { githubClient } from "../../src/workflow/forge/github.ts";
import type { ProjectionReceipt } from "../../src/workflow/forge/projector/apply.ts";
import { schemaId } from "../../src/kernel/product-identity.ts";
import { fakeGithub, type FakeGithub } from "./fake-github.ts";
import {
  branchGone,
  mainHead,
  provingGroundRepository,
  requireConfigured,
  seedMain,
  v14Verdict,
  v15Verdict,
  v25Verdict,
  v28Verdict,
  v6Verdict,
  type ProvingGround,
} from "./proving-ground-api.ts";

/**
 * The proving ground's API rules (`proving-ground-api.ts`) OFFLINE, against
 * the fake GitHub on the loopback upstream: the repository identity, the
 * seed, the read-only configuration check, a deleted branch, and the verdict
 * rules of V-6, V-14 and V-15. The scenarios that run them on real GitHub
 * (`proving/`) are never loaded here.
 */

const SHA = (digit: string): string => digit.repeat(40);
const REPO = "/repos/o/forge-proving-ground";

function groundOn(fake: FakeGithub): ProvingGround {
  return { owner: "o", name: "forge-proving-ground", webUrl: "https://github.com", client: githubClient(fake.endpoint(), memoryCredential("user:maintainer", fake.userToken("maintainer"))) };
}

function refusedWith(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof Error && ((error as { code?: unknown }).code === code || (isForgeError(error) && error.forgeCode === code));
}

/** The configured forge section with `repositories` replaced. */
function withRepositories(repositories: ForgeSettings["repositories"]): ForgeSettings {
  return { ...configuredForge(), repositories };
}

test("the proving ground's identity is the forge section's one provingGround repository, never the trunk", () => {
  const settings = configuredForge();
  assert.equal(provingGroundRepository(settings), "forge-proving-ground");
  const trunk = settings.repositories.find((repository) => repository.kind === "trunk")!;
  const others = settings.repositories.filter((repository) => repository.provingGround !== true);
  assert.throws(() => provingGroundRepository(withRepositories(others)), refusedWith("proving_ground_undeclared"), "none declared");
  assert.throws(() => provingGroundRepository(withRepositories([...settings.repositories, { name: "second-ground", kind: "none", visibility: "public", provingGround: true }])), refusedWith("proving_ground_undeclared"), "two declared");
  assert.throws(() => provingGroundRepository(withRepositories(settings.repositories.map((repository) => repository.kind === "trunk" ? { ...repository, provingGround: true } : { ...repository, provingGround: false }))), refusedWith("proving_ground_is_trunk"), "the trunk declared");
  assert.throws(() => provingGroundRepository(withRepositories([...others, { name: trunk.name.toUpperCase(), kind: "none", visibility: "public", provingGround: true }])), refusedWith("proving_ground_is_trunk"), "the trunk's name, another kind");
});

test("main's head: an empty repository (409) and a missing branch (404) are no head; any other refusal is the forge's error", async () => {
  const fake = fakeGithub();
  let answer: { status: number; body?: unknown } = { status: 409, body: { message: "Git Repository is empty." } };
  fake.route("GET", new RegExp(`^${REPO}/git/ref/heads/main$`, "u"), () => answer);
  const ground = groundOn(fake);
  assert.equal(await mainHead(ground), null);
  answer = { status: 404, body: { message: "Not Found" } };
  assert.equal(await mainHead(ground), null);
  answer = { status: 200, body: { ref: "refs/heads/main", object: { sha: SHA("a") } } };
  assert.equal(await mainHead(ground), SHA("a"));
  answer = { status: 403, body: { message: "Resource not accessible by integration" } };
  await assert.rejects(() => mainHead(ground), refusedWith("github_forbidden"));
});

test("the seed commits a README on main through the contents API only while the repository is empty, and reads back the commit", async () => {
  const fake = fakeGithub();
  let empty = true;
  let seedAnswer: unknown = { commit: { sha: SHA("b") } };
  fake.route("GET", new RegExp(`^${REPO}/git/ref/heads/main$`, "u"), () => (empty ? { status: 409, body: { message: "Git Repository is empty." } } : { status: 200, body: { object: { sha: SHA("c") } } }));
  fake.route("PUT", new RegExp(`^${REPO}/contents/README\\.md$`, "u"), () => ({ status: 201, body: seedAnswer }));
  const ground = groundOn(fake);
  assert.deepEqual(await seedMain(ground), { head: SHA("b"), created: true });
  const put = fake.requests.find((request) => request.method === "PUT")!;
  const body = put.body as { message: string; content: string; branch: string };
  assert.equal(body.branch, "main");
  assert.match(Buffer.from(body.content, "base64").toString("utf8"), /forge-proving-ground/u);
  assert.ok(!("committer" in body) && !("author" in body), "no identity: the App's commit is GitHub's to sign");
  empty = false;
  const puts = fake.requests.filter((request) => request.method === "PUT").length;
  assert.deepEqual(await seedMain(ground), { head: SHA("c"), created: false }, "an existing main is never seeded again");
  assert.equal(fake.requests.filter((request) => request.method === "PUT").length, puts);
  empty = true;
  seedAnswer = { commit: {} };
  await assert.rejects(() => seedMain(ground), refusedWith("github_response_invalid"), "an answer naming no commit");
});

/** A fake proving ground configured by `config` (each field the scenarios need). */
function configured(config: Readonly<{ main: boolean; deleteBranchOnMerge: boolean; rules: readonly string[] }>): ProvingGround {
  const fake = fakeGithub();
  fake.route("GET", new RegExp(`^${REPO}/git/ref/heads/main$`, "u"), () => (config.main ? { status: 200, body: { object: { sha: SHA("a") } } } : { status: 409, body: { message: "Git Repository is empty." } }));
  fake.route("GET", new RegExp(`^${REPO}$`, "u"), () => ({ status: 200, body: { delete_branch_on_merge: config.deleteBranchOnMerge } }));
  fake.route("GET", new RegExp(`^${REPO}/rules/branches/main$`, "u"), () => ({ status: 200, body: config.rules.map((type) => ({ type })) }));
  return groundOn(fake);
}

test("the configuration check passes only with main, both rules in force on it and delete_branch_on_merge — each missing piece is named", async () => {
  const full = { main: true, deleteBranchOnMerge: true, rules: ["merge_queue", "required_signatures", "pull_request"] };
  await requireConfigured(configured(full));
  for (const [broken, named] of [
    [{ ...full, main: false }, /a main branch/u],
    [{ ...full, deleteBranchOnMerge: false }, /delete_branch_on_merge/u],
    [{ ...full, rules: ["required_signatures"] }, /the merge_queue rule/u],
    [{ ...full, rules: ["merge_queue"] }, /the required_signatures rule/u],
  ] as const) {
    await assert.rejects(() => requireConfigured(configured(broken)), (error: unknown) => refusedWith("proving_ground_unconfigured")(error) && named.test((error as Error).message), String(named));
  }
});

test("a branch is gone only when GitHub answers 404 for it; any other refusal fails, never counts as gone", async () => {
  const fake = fakeGithub();
  let answer: { status: number; body?: unknown } = { status: 404, body: { message: "Not Found" } };
  fake.route("GET", new RegExp(`^${REPO}/git/ref/heads/agent/x$`, "u"), () => answer);
  const ground = groundOn(fake);
  assert.equal(await branchGone(ground, "agent/x"), true);
  answer = { status: 200, body: { object: { sha: SHA("a") } } };
  assert.equal(await branchGone(ground, "agent/x"), false);
  for (const status of [403, 500]) {
    answer = { status, body: { message: "refused" } };
    await assert.rejects(() => branchGone(ground, "agent/x"), (error: unknown) => isForgeError(error), String(status));
  }
});

test("V-6's verdict: every API commit Verified AND the queue's merge commit Verified; anything less fails, naming what", () => {
  const signed = [{ sha: SHA("a"), verified: true }, { sha: SHA("b"), verified: true }];
  assert.equal(v6Verdict({ commits: signed, merge: { verified: true } }, []).status, "pass");
  for (const [input, named] of [
    [{ commits: [{ sha: SHA("a"), verified: true }, { sha: SHA("b"), verified: false }], merge: { verified: true } }, /every API commit/u],
    [{ commits: signed, merge: { verified: false } }, /merge commit is Verified/u],
    [{ commits: [], merge: { verified: true } }, /at least one API commit/u],
  ] as const) {
    const verdict = v6Verdict(input, []);
    assert.equal(verdict.status, "fail");
    assert.match(verdict.detail, named);
  }
});

test("V-15's verdict: seen in the queue AND merged at exactly the published head", () => {
  assert.equal(v15Verdict({ seenQueued: true, publishedHead: SHA("a"), landedHead: SHA("a") }, []).status, "pass");
  assert.match(v15Verdict({ seenQueued: false, publishedHead: SHA("a"), landedHead: SHA("a") }, []).detail, /failed: the pull request was seen in the merge queue/u);
  assert.match(v15Verdict({ seenQueued: true, publishedHead: SHA("a"), landedHead: SHA("b") }, []).detail, /failed: the outcome names the merge at exactly the published head/u);
});

test("V-14's verdict: every one of the stack's six facts must hold; each that does not is named", () => {
  const held = {
    childBase: "main", refusedBeforeParent: true, parentBranchGone: true, childStateAfterParent: "open",
    childHead: SHA("c"), childLandedHead: SHA("c"), childChangedPaths: ["proving/v14/x/child.md"], childPath: "proving/v14/x/child.md",
  };
  assert.equal(v14Verdict(held, []).status, "pass");
  for (const [broken, named] of [
    [{ ...held, childBase: "parent-branch" }, /is against main/u],
    [{ ...held, refusedBeforeParent: false }, /refused before its parent/u],
    [{ ...held, parentBranchGone: false }, /branch was deleted on merge/u],
    [{ ...held, childStateAfterParent: "closed" }, /stayed open/u],
    [{ ...held, childLandedHead: SHA("d") }, /its own published head/u],
    [{ ...held, childChangedPaths: ["proving/v14/x/child.md", "proving/v14/x/parent.md"] }, /only its own change/u],
  ] as const) {
    const verdict = v14Verdict(broken, []);
    assert.equal(verdict.status, "fail", String(named));
    assert.match(verdict.detail, named);
  }
});

/** A receipt with only what the verdict rules read set; the rest is a verified, empty run. */
function receipt(overrides: Partial<ProjectionReceipt> = {}): ProjectionReceipt {
  return {
    schema: schemaId("projection-receipt", 1) as ProjectionReceipt["schema"], source: SHA("5"), ledger: null, digest: "d".repeat(64), observedDigest: "d".repeat(64),
    writes: [], refusals: [], pending: [], orphans: [], unverified: [], foreignEdits: [], proposals: [], objects: {}, verified: true, ...overrides,
  };
}
const write = (key: string, fields: readonly string[]): ProjectionReceipt["writes"][number] => ({ phase: "create", kind: "create", class: "issue", key, fields });

test("V-25's verdict: a verified first run, the same D, and a second run with zero writes that is verified", () => {
  const first = receipt({ writes: [write("PG25-T1", ["title", "block", "type"])] });
  assert.equal(v25Verdict({ first, second: receipt() }, []).status, "pass");
  for (const [broken, named] of [
    [{ first: receipt({ verified: false }), second: receipt() }, /the first run is verified at D/u],
    [{ first, second: receipt({ digest: "e".repeat(64) }) }, /both runs projected the same D/u],
    [{ first, second: receipt({ writes: [write("PG25-T1", ["block"])] }) }, /the second run made zero writes/u],
    [{ first, second: receipt({ verified: false }) }, /the second run is verified/u],
  ] as const) {
    const verdict = v25Verdict(broken, []);
    assert.equal(verdict.status, "fail", String(named));
    assert.match(verdict.detail, named);
  }
});

test("V-28's verdict: the written candidate GitHub did not keep is caught as projection_unverified, naming only fields the run wrote", () => {
  const candidate = "issue/PG28-PROBE.type";
  const dropped = { class: "issue" as const, key: "PG28-PROBE", field: "type", expected: "Task", observed: null };
  const caught = receipt({ writes: [write("PG28-PROBE", ["title", "block", "type", "labels"])], unverified: [dropped], verified: false });
  assert.equal(v28Verdict({ receipt: caught, candidate }, []).status, "pass");
  for (const [broken, named] of [
    // GitHub KEPT the type: the candidate is no silent drop, and V-28 says so.
    [receipt({ writes: [write("PG28-PROBE", ["title", "block", "type"])] }), /GitHub did not keep issue\/PG28-PROBE\.type/u],
    [receipt({ writes: [write("PG28-PROBE", ["block"])], unverified: [dropped], verified: false }), /the run wrote issue\/PG28-PROBE\.type/u],
    // GitHub dropped a DIFFERENT field it was written, and kept the candidate: the drop caught is not the candidate's.
    [receipt({ ...caught, unverified: [{ ...dropped, field: "labels", expected: ["lane:floor"], observed: [] }] }), /GitHub did not keep issue\/PG28-PROBE\.type/u],
    [receipt({ ...caught, unverified: [dropped, { ...dropped, key: "PG25-T1" }] }), /every unverified field is one the run wrote/u],
    // A refusal is not a caught drop: its failure is the refusal's own code.
    [receipt({ ...caught, unverified: [], refusals: [{ code: "forge_rate_limited", message: "x", retryable: true }] }), /its failure is projection_unverified/u],
  ] as const) {
    const verdict = v28Verdict({ receipt: broken, candidate }, []);
    assert.equal(verdict.status, "fail", String(named));
    assert.match(verdict.detail, named);
  }
});
