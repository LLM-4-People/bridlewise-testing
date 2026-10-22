/**
 * THE GITHUB PROJECTION STORE (src/workflow/forge/projector/github-store.ts):
 * the projector's one apply algorithm on the forge port's real client,
 * through the one outbound door, against GitHub's issues on the fake GitHub
 * (`./fake-github-issues.ts`) on a real loopback server.
 *
 *   - the first run builds every class (labels, milestones, issues with their
 *     type, labels, milestone, sub-issue parent, dependencies, state and pin)
 *     and verifies it by re-reading;
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
import { githubClient } from "../../src/workflow/forge/github.ts";
import { applyProjection, projectionFailure, type ProjectionReceipt } from "../../src/workflow/forge/projector/apply.ts";
import type { ProjectorConfinement } from "../../src/workflow/forge/projector/confined.ts";
import { githubProjectionStore } from "../../src/workflow/forge/projector/github-store.ts";
import { PROJECTION_CLASSES, PROJECTION_INPUT_SCHEMA, type Projection, type ProjectionInput } from "../../src/workflow/forge/projector/model.ts";
import { computeProjection } from "../../src/workflow/forge/projector/projection.ts";
import { emptyKeepOutFacts } from "../support/keep-out-facts.ts";
import { fakeGithub } from "./fake-github.ts";
import { installIssues, type FakeIssuesOptions } from "./fake-github-issues.ts";

const REPOSITORY = "owner/repo";
const SOURCE = "0123456789abcdef0123456789abcdef01234567";
const CONFINEMENT: ProjectorConfinement = { harnessRoot: join(import.meta.dirname, "..", ".."), keepOut: emptyKeepOutFacts(), cpuSeconds: 60, memoryBytes: 1_610_612_736 };

const item = (id: string, overrides: Partial<ProjectionInput["items"][number]> = {}): ProjectionInput["items"][number] => ({
  id, type: "Task", title: `The ${id} outcome`, state: "open", resolution: null, lane: "floor", milestone: null, parent: null, blockedBy: [], decisions: [], tests: [], evidence: null,
  body: `What ${id} delivers.`, path: `${TRACKER_BOARD.items}/${id}.md`, ...overrides,
});
const input = (items: ProjectionInput["items"]): ProjectionInput => ({
  schema: PROJECTION_INPUT_SCHEMA, source: SOURCE, ledger: "c".repeat(40), repositoryUrl: `https://github.com/${REPOSITORY}`,
  items, lanes: [{ lane: "floor", color: "1d76db", description: "Tracker lane: open work" }], decisions: [], recordedEvidence: [],
  mainRuns: [{ workflow: "door", commit: "a".repeat(40), conclusion: "failure", runUrl: `https://github.com/${REPOSITORY}/actions/runs/1`, failedTests: [{ path: "tests/a.test.ts", message: "boom", owners: [] }] }],
});
const ITEMS = [
  item("M1", { type: "Milestone", title: "The first milestone", state: null, lane: null }),
  item("WS-A", { type: "Workstream", milestone: "M1" }),
  item("T-B", { milestone: "M1", parent: "WS-A", blockedBy: ["T-C"] }),
  item("T-C", { milestone: "M1", parent: "WS-A", state: "closed", resolution: "not-planned" }),
];
const project = (items = ITEMS): Projection => computeProjection(input(items), CONFINEMENT).projection;

function github(options: FakeIssuesOptions = {}) {
  const fake = fakeGithub();
  const issues = installIssues(fake, REPOSITORY, options);
  const client = githubClient(fake.endpoint(), memoryCredential("user:publisher", fake.userToken("publisher")));
  const store = githubProjectionStore(client, { repository: REPOSITORY, maxPages: 10 });
  const issue = (key: string) => [...issues.issues.values()].find((candidate) => candidate.body?.includes(`<!-- bridlewise:item=${key} `) === true)!;
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
  issues.open({ title: "A copy", body: issue("T-B").body ?? "" });
  await assert.rejects(read, (error: HarnessError) => error.code === "projection_store_duplicate_marker" && !isForgeError(error));
});
