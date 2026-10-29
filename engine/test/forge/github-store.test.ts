/**
 * THE GITHUB PROJECTION STORE (src/workflow/forge/projector/github-store.ts):
 * the projector's one apply algorithm on the forge port's real client,
 * through the one outbound door, against GitHub's issues on the fake GitHub
 * (`./fake-github-issues.ts`) on a real loopback server.
 *
 *   - the first run builds every class (milestones, issues with their type,
 *     labels, milestone, sub-issue parent, dependencies, state and pin) and
 *     verifies it by re-reading;
 *   - a label is the forge's (labels.json, `forge apply`): an issue carries an
 *     existing one as GitHub spells it, and one missing is refused typed,
 *     never created;
 *   - V-25 on GitHub: a second run makes zero writes, and its list reads are
 *     conditional (only the GraphQL relation reads cost rate limit);
 *   - the reporter's text above the marker is GitHub's and is kept;
 *   - V-28 on GitHub: a field GitHub silently does not keep is unverified;
 *   - V-27 on GitHub: a person's edit is a foreign edit, proposed or restored;
 *   - a budget refusal is the adapter's typed, retryable refusal, and the
 *     next run resumes;
 *   - a person's issue and label are never the projector's; a duplicate
 *     marker and a relation longer than one page are refused typed.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import type { HarnessError } from "../../src/kernel/errors.ts";
import { TRACKER_BOARD } from "../../src/kernel/verification-paths.ts";
import { isForgeError } from "../../src/workflow/forge/codes.ts";
import { memoryCredential } from "../../src/workflow/forge/credentials.ts";
import { FORGE_APPS } from "../../src/workflow/forge/app-registry.ts";
import { githubClient } from "../../src/workflow/forge/github.ts";
import { applyProjection, projectionFailure, type ProjectionReceipt } from "../../src/workflow/forge/projector/apply.ts";
import { configuredConfinement, type ProjectorConfinement } from "../../src/workflow/forge/projector/confined.ts";
import { githubProjectionStore } from "../../src/workflow/forge/projector/github-store.ts";
import { PROJECTION_CLASSES, PROJECTION_INPUT_SCHEMA, type Projection, type ProjectionInput } from "../../src/workflow/forge/projector/model.ts";
import { computeProjection } from "../../src/workflow/forge/projector/projection.ts";
import { emptyKeepOutFacts } from "../support/keep-out-facts.ts";
import { fakeGithub } from "./fake-github.ts";
import { installIssues, type FakeIssuesOptions } from "./fake-github-issues.ts";

const REPOSITORY = "owner/repo";
/** The publisher App's bot: the one author whose issues and milestones are the projector's (the client runs as it). */
const PROJECTOR = `${FORGE_APPS.publisher.name}[bot]`;
const SOURCE = "0123456789abcdef0123456789abcdef01234567";
const CONFINEMENT: ProjectorConfinement = configuredConfinement(join(import.meta.dirname, "..", ".."), emptyKeepOutFacts(), 60);

const item = (id: string, overrides: Partial<ProjectionInput["items"][number]> = {}): ProjectionInput["items"][number] => ({
  id, type: "Task", title: `The ${id} outcome`, state: "open", resolution: null, lane: "floor", milestone: null, parent: null, blockedBy: [], decisions: [], tests: [], evidence: null,
  body: `What ${id} delivers.`, path: `${TRACKER_BOARD.items}/${id}.md`, ...overrides,
});
const input = (items: ProjectionInput["items"]): ProjectionInput => ({
  schema: PROJECTION_INPUT_SCHEMA, source: SOURCE, ledger: "c".repeat(40), repositoryUrl: `https://github.com/${REPOSITORY}`,
  items, decisions: [], recordedEvidence: [],
  mainRuns: [{ workflow: "door", commit: "a".repeat(40), conclusion: "failure", runUrl: `https://github.com/${REPOSITORY}/actions/runs/1`, failedTests: [{ path: "tests/a.test.ts", message: "boom", owners: [] }] }],
});
const ITEMS = [
  item("M1", { type: "Milestone", title: "The first milestone", state: null, lane: null }),
  item("WS-A", { type: "Workstream", milestone: "M1" }),
  item("T-B", { milestone: "M1", parent: "WS-A", blockedBy: ["T-C"] }),
  item("T-C", { milestone: "M1", parent: "WS-A", state: "closed", resolution: "not-planned" }),
];
const project = (items = ITEMS): Projection => computeProjection(input(items), CONFINEMENT).projection;

function github(options: FakeIssuesOptions = {}, maxPages = 10, before: (fake: ReturnType<typeof fakeGithub>) => void = () => {}) {
  const fake = fakeGithub();
  // A route of the test's own answers before the installed issues' routes.
  before(fake);
  const issues = installIssues(fake, REPOSITORY, options);
  // The declared lane label, as `harness forge apply` leaves it (labels.json is its one declaration).
  issues.labels.set("lane:floor", { name: "lane:floor", color: "1d76db", description: "Tracker lane: the public floor's open work" });
  const client = githubClient(fake.endpoint(), memoryCredential(PROJECTOR, fake.userToken(PROJECTOR)));
  const store = githubProjectionStore(client, { repository: REPOSITORY, maxPages });
  const issue = (key: string) => [...issues.issues.values()].find((candidate) => candidate.user.login === PROJECTOR && candidate.body?.includes(`<!-- bridlewise:item=${key} `) === true)!;
  return { fake, issues, store, issue };
}
const run = (projection: Projection, store: ReturnType<typeof github>["store"], previous: ProjectionReceipt | null = null, foreignEdit: "approval" | "auto" | "manual" = "approval") =>
  applyProjection(projection, store, { allowance: 100, previous, foreignEdit });

test("the first run builds every class on GitHub through the client and verifies it; a second run makes zero writes, its list reads conditional", async () => {
  const { fake, issues, store, issue } = github();
  const projection = project();
  const first = await run(projection, store);
  assert.equal(first.verified, true, JSON.stringify({ refusals: first.refusals, unverified: first.unverified }));
  assert.deepEqual([...issues.labels.keys()], ["lane:floor"]);
  assert.deepEqual([...issues.milestones.values()].map((milestone) => [milestone.title, milestone.state]), [["M1 · The first milestone", "open"]]);
  const [m1, a, b, c, red] = ["M1", "WS-A", "T-B", "T-C", "MAIN-RED/door"].map(issue);
  assert.equal(issues.issues.size, 5);
  assert.deepEqual([a!.parent, b!.parent, c!.parent, m1!.parent], [m1!.number, a!.number, a!.number, null], "milestone → workstream → task, as sub-issues");
  assert.deepEqual(b!.blockedBy, [c!.number], "a dependency link");
  assert.deepEqual([b!.type?.name, b!.labels.map((label) => label.name), b!.milestone?.number], ["Task", ["lane:floor"], 1]);
  assert.deepEqual([c!.state, c!.state_reason], ["closed", "not_planned"]);
  assert.deepEqual([red!.pinned, red!.type?.name, red!.state], [true, "Bug", "open"], "MAIN-RED is pinned while red");
  // V-25: nothing changed, nothing is written; every REST list answers 304 (no rate limit), only the GraphQL relation reads count.
  const remaining = fake.rate.remaining;
  const sent = fake.requests.length;
  const second = await run(project(), store, first);
  assert.deepEqual([second.writes, second.verified], [[], true]);
  const requests = fake.requests.slice(sent);
  assert.ok(requests.every((request) => request.method === "GET" || request.path === "/graphql"), "a second run only reads");
  assert.equal(remaining - fake.rate.remaining, requests.filter((request) => request.path === "/graphql").length, "the REST reads were conditional");
});

test("the reporter's text above the marker is GitHub's: a changed record rewrites only the block", async () => {
  const { store, issue } = github();
  const first = await run(project(), store);
  const reporter = "Reported by a person, with context.\n\n";
  issue("T-B").body = `${reporter}${issue("T-B").body!}`;
  const changed = await run(project(ITEMS.map((entry) => (entry.id === "T-B" ? { ...entry, body: "A sharper outcome." } : entry))), store, first);
  assert.equal(changed.verified, true);
  assert.deepEqual(changed.writes.map((write) => `${write.class}/${write.key}:${write.fields.join(",")}`), ["issue/T-B:block"]);
  assert.ok(issue("T-B").body!.startsWith(`${reporter}<!-- bridlewise:item=T-B `), "the reporter's text is kept, the block follows it");
  assert.match(issue("T-B").body!, /A sharper outcome\./u);
});

test("V-28 on GitHub: a field GitHub silently does not keep is projection_unverified, never a success", async () => {
  const { store } = github({ drops: ["issue.type"] });
  const receipt = await run(project(), store);
  assert.equal(receipt.verified, false);
  assert.ok(receipt.unverified.some((field) => field.class === "issue" && field.key === "T-B" && field.field === "type"), JSON.stringify(receipt.unverified));
  assert.equal(projectionFailure(receipt)?.code, "projection_unverified");
});

test("V-27 on GitHub: a person's retitle is a foreign edit — approval proposes it and writes nothing, auto restores it with a comment", async () => {
  const { store, issue } = github();
  const first = await run(project(), store);
  issue("T-B").title = "Retitled by a person";
  const proposed = await run(project(), store, first, "approval");
  assert.deepEqual(proposed.foreignEdits.map((edit) => [edit.class, edit.key, edit.fields, edit.action]), [["issue", "T-B", ["title"], "proposed"]]);
  assert.deepEqual(proposed.writes, []);
  assert.equal(issue("T-B").title, "Retitled by a person");
  const restored = await run(project(), store, proposed, "auto");
  assert.deepEqual([restored.foreignEdits.map((edit) => edit.action), restored.verified], [["restored"], true]);
  assert.equal(issue("T-B").title, "The T-B outcome");
  assert.equal(issue("T-B").comments.length, 1, "the restore is announced on the issue");
});

test("a budget refusal is the adapter's typed, retryable refusal; the next run resumes the difference", async () => {
  const { fake, issues, store } = github();
  fake.refuseNext({ method: "POST", path: /\/issues$/u }, { status: 403, message: "You have exceeded a secondary rate limit.", headers: { "retry-after": "60" } });
  const refused = await run(project(), store);
  assert.deepEqual(refused.refusals.map((refusal) => [refusal.code, refusal.retryable]), [["github_content_budget_exhausted", true]], "a content-creating write refused by a secondary limit is the content budget");
  assert.equal(refused.verified, false);
  assert.equal(issues.issues.size, 0, "nothing past the refusal was written");
  const resumed = await run(project(), store, refused);
  assert.equal(resumed.verified, true);
  assert.equal(issues.issues.size, 5);
});

test("a person's issue and label are never the projector's; a duplicate marker and a relation longer than a page are refused typed", async () => {
  const { issues, store, issue } = github();
  issues.labels.set("bug", { name: "bug", color: "d73a4a", description: "Something is broken" });
  const person = issues.open({ title: "A person's report", body: "It broke." });
  const first = await run(project(), store);
  assert.deepEqual([first.verified, first.orphans], [true, []], "a person's label is not an orphan");
  assert.deepEqual([person.title, person.body, person.labels, person.parent], ["A person's report", "It broke.", [], null], "a person's issue is never touched");
  const read = async (): Promise<unknown> => store.read(PROJECTION_CLASSES);
  const blockers = Array.from({ length: 101 }, (_, index) => issues.open({ title: `blocker ${String(index)}`, body: "" }).number);
  issue("T-B").blockedBy.push(...blockers);
  await assert.rejects(read, (error: HarnessError) => error.code === "projection_store_relation_truncated");
  issue("T-B").blockedBy = [issue("T-C").number];
  issues.open({ title: "Quoting a marker", body: "It reads `<!-- bridlewise:item=T-B digest=not-a-digest -->`." });
  assert.equal((await store.read(PROJECTION_CLASSES)).filter((object) => object.key === "T-B").length, 1, "a malformed marker is a person's text, not a second T-B");
  // Two of the projector's OWN issues carrying one marker are its own mistake, refused typed.
  issues.open({ title: "A copy", body: issue("T-B").body ?? "", login: PROJECTOR });
  await assert.rejects(read, (error: HarnessError) => error.code === "projection_store_duplicate_marker" && !isForgeError(error));
});

test("a marker is trusted only on the projector's own issues: a planted phishing issue is never adopted, and a copied marker never halts a run", async () => {
  const { issues, store, issue } = github();
  // Before the first run, a person opens an issue carrying T-B's marker, phrased to phish.
  const phish = issues.open({ title: "Action required: re-authenticate here", body: `${"Log in at https://evil.example to keep your access."}\n\n<!-- bridlewise:item=T-B digest=${"0".repeat(64)} -->\nT-B` });
  const first = await run(project(), store);
  assert.equal(first.verified, true, JSON.stringify(first.refusals));
  assert.notEqual(issue("T-B").number, phish.number, "the projector opened its own T-B");
  assert.deepEqual([phish.title, phish.parent, phish.labels, phish.state], ["Action required: re-authenticate here", null, [], "open"], "the planted issue is never written");
  // After it, a person copies T-B's whole body, marker included: the next run neither halts nor takes it for T-B.
  issues.open({ title: "A copy", body: issue("T-B").body ?? "" });
  const second = await run(project(), store, first);
  assert.deepEqual([second.verified, second.refusals, second.writes], [true, [], []]);
});

test("milestones are the projector's only by its own creation: a person's M1 is never overwritten, and two of its own for one id are refused typed", async () => {
  const squatted = github();
  const persons = squatted.issues.milestone({ title: "M1 · The first milestone" });
  const refused = await run(project(), squatted.store);
  assert.equal(refused.verified, false);
  assert.deepEqual(refused.refusals.map((refusal) => refusal.code), ["github_validation_failed"], "GitHub refuses a second milestone of that title: the run stops typed");
  assert.deepEqual([persons.title, persons.description, persons.creator.login], ["M1 · The first milestone", null, "a-person"], "the person's milestone is untouched");
  const doubled = github();
  doubled.issues.milestone({ title: "M1 · one", login: PROJECTOR });
  doubled.issues.milestone({ title: "M1 · two", login: PROJECTOR });
  await assert.rejects(doubled.store.read(PROJECTION_CLASSES), (error: HarnessError) => error.code === "projection_store_duplicate_milestone");
});

test("a label is the forge's: an existing `Lane:Floor` is carried as GitHub spells it and never written; a missing one is refused typed, never created", async () => {
  const { issues, store, issue } = github();
  issues.labels.set("lane:floor", { name: "Lane:Floor", color: "ffffff", description: "an older spelling" });
  const receipt = await run(project(), store);
  assert.equal(receipt.verified, true, JSON.stringify(receipt.refusals));
  assert.deepEqual([...issues.labels.values()].map((label) => [label.name, label.color, label.description]), [["Lane:Floor", "ffffff", "an older spelling"]], "the label is neither duplicated nor rewritten");
  assert.deepEqual(issue("T-B").labels.map((label) => label.name), ["Lane:Floor"]);
  // No declared label on GitHub: GitHub would create it on the issue write, so the store refuses before it.
  const bare = github();
  bare.issues.labels.clear();
  const refused = await run(project(), bare.store);
  assert.equal(projectionFailure(refused)?.code, "projection_label_missing");
  assert.deepEqual([...bare.issues.labels.keys()], [], "no label was created on the way");
});

test("the store's edges: a list past maxPages is refused typed, a pull request is no issue, an unchanged parent or dependency sends nothing, an unknown field is refused", async () => {
  const bounded = github({}, 1);
  for (let index = 0; index < 101; index += 1) bounded.issues.open({ title: `a person's ${String(index)}`, body: "" });
  await assert.rejects(bounded.store.read(PROJECTION_CLASSES), (error: unknown) => isForgeError(error, "forge_list_oversized"));
  const { fake, issues, store, issue } = github();
  const first = await run(project(), store);
  // A pull request opened by the projector's own App, carrying a marker, is still no issue of the projection.
  const pull = issues.open({ title: "A pull request", body: issue("T-C").body ?? "", login: PROJECTOR });
  pull.pull_request = { url: "https://api.github.com/repos/owner/repo/pulls/1" };
  assert.equal((await store.read(PROJECTION_CLASSES)).filter((object) => object.key === "T-C").length, 1);
  const sent = fake.requests.length;
  await store.write({ phase: "link", kind: "update", class: "issue", key: "T-B", fields: { parent: "WS-A", blockedBy: ["T-C"] } });
  assert.deepEqual(fake.requests.slice(sent).map((request) => `${request.method} ${request.path}`), [], "the parent and the dependency are already so");
  await assert.rejects(store.write({ phase: "create", kind: "update", class: "issue", key: "T-B", fields: { bogus: 1 } }), (error: HarnessError) => error.code === "projection_store_field_unknown");
  assert.equal(first.verified, true);
});

test("the GraphQL relations read is bounded by maxPages: a repository whose relation pages outrun the bound is refused typed, never read without end", async () => {
  // A GitHub whose relations query keeps answering "there is a next page", for six pages: past a two-page bound.
  let served = 0;
  const { store } = github({}, 2, (fake) => fake.route("POST", /^\/graphql$/u, (request) => {
    if (!String((request.body as { query?: string }).query).includes("issues(first:")) return undefined;
    served += 1;
    return { status: 200, body: { data: { repository: { issues: { pageInfo: { hasNextPage: served < 6, endCursor: String(served) }, nodes: [] } } } } };
  }));
  await assert.rejects(store.read(PROJECTION_CLASSES), (error: HarnessError) => error.code === "projection_store_too_many_issues");
  assert.equal(served, 2, "the read stopped at its bound: no third page was asked for");
});
