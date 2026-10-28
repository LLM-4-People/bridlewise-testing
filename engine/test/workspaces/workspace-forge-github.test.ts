import assert from "node:assert/strict";
import test from "node:test";

import { isForgeError } from "../../src/workflow/forge/codes.ts";
import { memoryCredential } from "../../src/workflow/forge/credentials.ts";
import { githubClient } from "../../src/workflow/forge/github.ts";
import { forgeRepositoryOfRemote, githubWorkspaceForge, githubWorkspaceForgeFactory } from "../../src/workflow/workspace-forge-github.ts";
import { fakeGithub, type FakeGithub, type FakeRequest } from "../forge/fake-github.ts";

/**
 * The workspace's forge on GitHub (`workspace-forge-github.ts`) through the
 * forge client's own transport, against the fake GitHub of the forge port
 * (`../forge/fake-github.ts`) on a real loopback server: what each operation
 * sends, how GitHub's answers and refusals are read, and the factory's
 * refusal of a remote that is not the forge's trunk.
 */

const SHA = (digit: string): string => digit.repeat(40);

function forgeOn(fake: FakeGithub) {
  return githubWorkspaceForge(githubClient(fake.endpoint(), memoryCredential("user:maintainer", fake.userToken("maintainer"))), { owner: "o", name: "r" });
}

type GraphqlBody = Readonly<{ query: string; variables: Readonly<Record<string, unknown>> }>;

/** Answers GraphQL by the operation the query names: `answers` maps a field name (e.g. `enqueuePullRequest`) to its answer. */
function graphqlRoutes(fake: FakeGithub, answers: Readonly<Record<string, (variables: Readonly<Record<string, unknown>>) => unknown>>): GraphqlBody[] {
  const seen: GraphqlBody[] = [];
  fake.route("POST", /^\/graphql$/u, (request: FakeRequest) => {
    const body = request.body as GraphqlBody;
    seen.push(body);
    const field = Object.keys(answers).find((name) => body.query.includes(name));
    if (field === undefined) return { status: 200, body: { data: null, errors: [{ type: "NOT_FOUND", message: "unrouted" }] } };
    return { status: 200, body: answers[field]!(body.variables) };
  });
  return seen;
}

/** A pull request node as GitHub's GraphQL answers it. */
function pullNode(overrides: Readonly<Record<string, unknown>> = {}) {
  return { id: "PR_node7", number: 7, url: "https://github.com/o/r/pull/7", headRefOid: SHA("a"), baseRefName: "main", isDraft: false, state: "OPEN", merged: false, mergeCommit: null, isInMergeQueue: false, ...overrides };
}

test("the Git Data API: a blob in base64, a tree on its base with a deletion's own mode, a commit with NO author, committer or signature, its verification read", async () => {
  const fake = fakeGithub();
  fake.route("POST", /^\/repos\/o\/r\/git\/blobs$/u, () => ({ status: 201, body: { sha: SHA("1") } }));
  fake.route("POST", /^\/repos\/o\/r\/git\/trees$/u, () => ({ status: 201, body: { sha: SHA("2") } }));
  fake.route("POST", /^\/repos\/o\/r\/git\/commits$/u, () => ({ status: 201, body: { sha: SHA("3"), tree: { sha: SHA("2") }, verification: { verified: true, reason: "valid" } } }));
  const forge = forgeOn(fake);
  assert.equal(await forge.createBlob(Buffer.from([0, 1, 2, 255])), SHA("1"));
  assert.deepEqual(fake.requests.at(-1)!.body, { content: Buffer.from([0, 1, 2, 255]).toString("base64"), encoding: "base64" });
  assert.equal(await forge.createTree({ baseTree: SHA("9"), entries: [{ path: "src/a.ts", mode: "100755", sha: SHA("1") }, { path: "old", mode: "120000", sha: null }, { path: "sub", mode: "160000", sha: SHA("4") }] }), SHA("2"));
  assert.deepEqual(fake.requests.at(-1)!.body, { base_tree: SHA("9"), tree: [
    { path: "src/a.ts", mode: "100755", type: "blob", sha: SHA("1") },
    { path: "old", mode: "120000", type: "blob", sha: null },
    { path: "sub", mode: "160000", type: "commit", sha: SHA("4") },
  ] });
  const commit = await forge.createCommit({ message: "The work\n", tree: SHA("2"), parents: [SHA("8")] });
  assert.deepEqual(commit, { sha: SHA("3"), tree: SHA("2"), verified: true, verificationReason: "valid" });
  assert.deepEqual(fake.requests.at(-1)!.body, { message: "The work\n", tree: SHA("2"), parents: [SHA("8")] }, "no author, committer or signature: GitHub signs the App's commit");
});

test("the branch move is a compare-and-swap: created with POST /git/refs, moved with GraphQL updateRefs beforeOid (never REST PATCH), forced only when the caller allows a non-forward move; a refused swap is read back — moved elsewhere is applied:false, still in place is the error", async () => {
  const fake = fakeGithub();
  let remoteHead = SHA("b");
  fake.route("POST", /^\/repos\/o\/r\/git\/refs$/u, () => ({ status: 201, body: { ref: "refs/heads/agent/x", object: { sha: SHA("a") } } }));
  fake.route("GET", /^\/repos\/o\/r\/git\/ref\/heads\/agent\/x$/u, () => ({ status: 200, body: { ref: "refs/heads/agent/x", object: { sha: remoteHead } } }));
  let refuse = false;
  const graphql = graphqlRoutes(fake, {
    "repository(owner: $owner, name: $name) { id }": () => ({ data: { repository: { id: "R_node" } } }),
    updateRefs: () => (refuse ? { data: null, errors: [{ type: "UNPROCESSABLE", message: "Expected branch to point to bbbb" }] } : { data: { updateRefs: { clientMutationId: null } } }),
  });
  const forge = forgeOn(fake);
  assert.deepEqual(await forge.setBranch({ branch: "agent/x", sha: SHA("a"), previous: null, forwardOnly: false }), { applied: true });
  assert.deepEqual(fake.requests.at(-1)!.body, { ref: "refs/heads/agent/x", sha: SHA("a") });
  assert.deepEqual(await forge.setBranch({ branch: "agent/x", sha: SHA("c"), previous: SHA("b"), forwardOnly: false }), { applied: true });
  assert.deepEqual(graphql.at(-1)!.variables, { repositoryId: "R_node", name: "refs/heads/agent/x", after: SHA("c"), before: SHA("b"), force: true }, "a workspace head may be rebased");
  assert.deepEqual(await forge.setBranch({ branch: "agent/x", sha: SHA("c"), previous: SHA("b"), forwardOnly: true }), { applied: true });
  assert.equal(graphql.at(-1)!.variables["force"], false, "forward only: GitHub refuses a move that is not a fast-forward");
  assert.ok(!fake.requests.some((request) => request.method === "PATCH"), "REST PATCH of a ref is never sent");
  refuse = true;
  remoteHead = SHA("d");
  assert.deepEqual(await forge.setBranch({ branch: "agent/x", sha: SHA("c"), previous: SHA("b"), forwardOnly: false }), { applied: false }, "another writer moved it: an answer");
  remoteHead = SHA("b");
  await assert.rejects(() => forge.setBranch({ branch: "agent/x", sha: SHA("c"), previous: SHA("b"), forwardOnly: false }), (error: unknown) => isForgeError(error, "github_validation_failed"), "refused while in place: GitHub's error stands");
  fake.route("GET", /^\/repos\/o\/r\/git\/ref\/heads\/agent\/gone$/u, () => ({ status: 404, body: { message: "Not Found" } }));
  assert.equal(await forge.branchHead("agent/gone"), null);
});

test("ONE GraphQL read of a pull request's whole state: open, queued, merged (GitHub's MERGED is closed and merged, with its merge commit)", async () => {
  const fake = fakeGithub();
  let node: Record<string, unknown> = pullNode({ isInMergeQueue: true });
  const graphql = graphqlRoutes(fake, { "pullRequest(number: $number)": () => ({ data: { repository: { pullRequest: node } } }) });
  const forge = forgeOn(fake);
  assert.deepEqual(await forge.pullRequest(7), { number: 7, url: "https://github.com/o/r/pull/7", headSha: SHA("a"), base: "main", draft: false, state: "open", merged: false, mergeCommitSha: null, queued: true });
  assert.deepEqual(graphql.at(-1)!.variables, { owner: "o", name: "r", number: 7 });
  node = pullNode({ state: "MERGED", merged: true, mergeCommit: { oid: SHA("m") } });
  const merged = await forge.pullRequest(7);
  assert.deepEqual([merged.state, merged.merged, merged.mergeCommitSha, merged.queued], ["closed", true, SHA("m"), false]);
  assert.equal(graphql.length, 2, "one request per read");
  node = pullNode({ state: "WEIRD" });
  await assert.rejects(() => forge.pullRequest(7), (error: unknown) => isForgeError(error, "github_response_invalid"));
  const missing = fakeGithub();
  graphqlRoutes(missing, { "pullRequest(number: $number)": () => ({ data: { repository: { pullRequest: null } } }) });
  await assert.rejects(() => forgeOn(missing).pullRequest(9), (error: unknown) => isForgeError(error, "github_not_found"));
});

test("enqueue: GraphQL enqueuePullRequest with expectedHeadOid, the enqueued head read back from GitHub's answer; GitHub's judgement of the pull request is a refusal, a permission or a budget stays the forge's error", async () => {
  const fake = fakeGithub();
  let answer: unknown = { data: { enqueuePullRequest: { mergeQueueEntry: { state: "QUEUED", pullRequest: { headRefOid: SHA("a") } } } } };
  const graphql = graphqlRoutes(fake, {
    "pullRequest(number: $number)": () => ({ data: { repository: { pullRequest: pullNode() } } }),
    enqueuePullRequest: () => answer,
  });
  const forge = forgeOn(fake);
  assert.deepEqual(await forge.enqueue(7, { expectedHeadSha: SHA("a") }), { kind: "enqueued", headSha: SHA("a") });
  assert.deepEqual(graphql.at(-1)!.variables, { id: "PR_node7", head: SHA("a") }, "the pull request's node id, read once, and the expected head");
  answer = { data: { enqueuePullRequest: { mergeQueueEntry: { state: "QUEUED", pullRequest: { headRefOid: SHA("f") } } } } };
  assert.deepEqual(await forge.enqueue(7, { expectedHeadSha: SHA("a") }), { kind: "enqueued", headSha: SHA("f") }, "what GitHub says it queued, never what was asked");
  answer = { data: null, errors: [{ type: "UNPROCESSABLE", message: "Pull request is not mergeable" }] };
  const refused = await forge.enqueue(7, { expectedHeadSha: SHA("a") });
  assert.equal(refused.kind, "refused");
  assert.match(refused.kind === "refused" ? refused.message : "", /not mergeable/u);
  answer = { data: null, errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }] };
  await assert.rejects(() => forge.enqueue(7, { expectedHeadSha: SHA("a") }), (error: unknown) => isForgeError(error, "github_forbidden"));
  answer = { data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] };
  await assert.rejects(() => forge.enqueue(7, { expectedHeadSha: SHA("a") }), (error: unknown) => isForgeError(error, "github_rate_limited"));
  answer = { data: { enqueuePullRequest: { mergeQueueEntry: null } } };
  await assert.rejects(() => forge.enqueue(7, { expectedHeadSha: SHA("a") }), (error: unknown) => isForgeError(error, "github_response_invalid"));
});

test("the merge queue: ONE GraphQL read of the branch's queue, in GitHub's own positions, each head fetched from refs/pull/<n>/head; an empty or absent queue is none; a malformed answer is the forge's error", async () => {
  const fake = fakeGithub();
  let answer: unknown = { data: { repository: { mergeQueue: { entries: { nodes: [
    { position: 2, pullRequest: { number: 9, headRefOid: SHA("b") } },
    { position: 1, pullRequest: { number: 8, headRefOid: SHA("c") } },
  ] } } } } };
  const graphql = graphqlRoutes(fake, { "mergeQueue(branch: $branch)": () => answer });
  const forge = forgeOn(fake);
  assert.deepEqual(await forge.mergeQueue("main"), [
    { number: 8, headSha: SHA("c"), fetchRef: "refs/pull/8/head" },
    { number: 9, headSha: SHA("b"), fetchRef: "refs/pull/9/head" },
  ], "queue order is GitHub's positions, not the answer's order");
  assert.deepEqual(graphql.at(-1)!.variables, { owner: "o", name: "r", branch: "main" });
  answer = { data: { repository: { mergeQueue: null } } };
  assert.deepEqual(await forge.mergeQueue("main"), [], "a branch with no queue has none queued");
  answer = { data: { repository: { mergeQueue: { entries: { nodes: [{ position: 1, pullRequest: null }] } } } } };
  await assert.rejects(() => forge.mergeQueue("main"), (error: unknown) => isForgeError(error, "github_response_invalid"));
});

test("the pull request: opened as a draft, regenerated, readied and drafted by node id, closed with its comment", async () => {
  const fake = fakeGithub();
  fake.route("POST", /^\/repos\/o\/r\/pulls$/u, () => ({ status: 201, body: { number: 7 } }));
  fake.route("PATCH", /^\/repos\/o\/r\/pulls\/7$/u, () => ({ status: 200, body: { number: 7 } }));
  fake.route("POST", /^\/repos\/o\/r\/issues\/7\/comments$/u, () => ({ status: 201, body: { id: 1 } }));
  fake.route("GET", /^\/repos\/o\/r\/pulls$/u, () => ({ status: 200, body: [{ number: 7 }] }));
  const graphql = graphqlRoutes(fake, {
    "pullRequest(number: $number)": () => ({ data: { repository: { pullRequest: pullNode({ isDraft: true }) } } }),
    markPullRequestReadyForReview: () => ({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } }),
    convertPullRequestToDraft: () => ({ data: { convertPullRequestToDraft: { pullRequest: { isDraft: true } } } }),
  });
  const forge = forgeOn(fake);
  const opened = await forge.openDraftPullRequest({ head: "agent/x", base: "main", title: "T", body: "B" });
  assert.equal(opened.number, 7);
  assert.deepEqual(fake.requests.find((request) => request.method === "POST" && request.path === "/repos/o/r/pulls")!.body, { title: "T", head: "agent/x", base: "main", body: "B", draft: true });
  assert.equal((await forge.findPullRequest("agent/x"))!.number, 7);
  const listed = fake.requests.find((request) => request.method === "GET" && request.path === "/repos/o/r/pulls")!;
  assert.equal(listed.query.get("head"), "o:agent/x");
  assert.equal(listed.query.get("state"), "open");
  await forge.updatePullRequest(7, { title: "T2", body: "B2" });
  assert.deepEqual(fake.requests.at(-1)!.body, { title: "T2", body: "B2" });
  await forge.markReadyForReview(7);
  await forge.convertToDraft(7);
  assert.deepEqual(graphql.slice(-2).map((body) => body.variables), [{ id: "PR_node7" }, { id: "PR_node7" }]);
  await forge.closePullRequest(7, "Workspace ended.");
  assert.deepEqual(fake.requests.slice(-2).map((request) => [request.method, request.path, request.body]), [
    ["POST", "/repos/o/r/issues/7/comments", { body: "Workspace ended." }],
    ["PATCH", "/repos/o/r/pulls/7", { state: "closed" }],
  ]);
});

test("a remote names the forge's repository in its https or ssh form on the forge's host, or none", () => {
  for (const url of ["https://github.com/LLM-4-People/bridlewise-testing.git", "https://github.com/LLM-4-People/bridlewise-testing", "git@github.com:LLM-4-People/bridlewise-testing.git", "https://GitHub.com/LLM-4-People/bridlewise-testing/"]) {
    assert.deepEqual(forgeRepositoryOfRemote(url, "https://github.com"), { owner: "LLM-4-People", name: "bridlewise-testing" }, url);
  }
  for (const url of ["https://gitea.example/LLM-4-People/bridlewise-testing.git", "/srv/git/bridlewise.git", "https://user@github.com/o/r.git", "https://github.com/o/r/extra", "file:///github.com/o/r"]) {
    assert.equal(forgeRepositoryOfRemote(url, "https://github.com"), null, url);
  }
});

test("the CLI's factory refuses a remote that is not the forge's trunk repository, and makes the forge of the trunk without reading a key", () => {
  const factory = githubWorkspaceForgeFactory(["main"]);
  for (const remoteUrl of ["https://github.com/LLM-4-People/elsewhere.git", "https://github.com/someone/bridlewise-testing.git", "https://gitea.example/LLM-4-People/bridlewise-testing.git", "/srv/git/bridlewise.git"]) {
    assert.throws(() => factory({ remote: "origin", remoteUrl, trunk: "testing" }), (error: unknown) =>
      error instanceof Error && (error as { code?: unknown }).code === "workspace_forge_remote_unknown"
      && error.message.includes("https://github.com/LLM-4-People/bridlewise-testing main"), `${remoteUrl}: refused, naming the GitHub trunk as the remedy`);
  }
  const previous = process.env["HARNESS_KEY_HOME"];
  delete process.env["HARNESS_KEY_HOME"];
  try {
    assert.equal(typeof factory({ remote: "origin", remoteUrl: "git@github.com:LLM-4-People/bridlewise-testing.git", trunk: "main" }).enqueue, "function", "no key home is admitted until a forge call is made");
  } finally {
    if (previous !== undefined) process.env["HARNESS_KEY_HOME"] = previous;
  }
});
