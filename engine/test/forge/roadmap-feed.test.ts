/**
 * THE ROADMAP DATA FEED (src/workflow/forge/projector/roadmap-feed.ts): a pure
 * function of a commit and its first-parent history, computed confined —
 * computed states with their reasons (a close is shipped only when proven),
 * milestone progress, the critical path through blocked-by, decisions with the
 * items that carry them out, the exact per-landing history (decision-only
 * landings included), and throughput and ETA bands from git LANDING times —
 * never a typed date, `unknown` until there is enough history.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { HarnessError } from "../../src/kernel/errors.ts";
import { configuredGitRepository } from "../../src/git/worktree-port.ts";
import { TRACKER_BOARD } from "../../src/kernel/verification-paths.ts";
import { computeRoadmapFeed, roadmapFeedInput } from "../../src/workflow/forge/projector/projection.ts";
import { configuredConfinement, type ProjectorConfinement } from "../../src/workflow/forge/projector/confined.ts";
import { ROADMAP_FEED_INPUT_SCHEMA, roadmapFeed, type FeedItem, type FeedSnapshot, type RoadmapFeedInput } from "../../src/workflow/forge/projector/roadmap-feed.ts";
import type { StatusItem } from "../../src/workflow/tracker-status.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { emptyKeepOutFacts } from "../support/keep-out-facts.ts";
import { testGitIdentityEnvironment } from "../support/test-git-identity.ts";

const SOURCE = "0123456789abcdef0123456789abcdef01234567";
const ENGINE_ROOT = join(import.meta.dirname, "..", "..");
const CONFINEMENT: ProjectorConfinement = configuredConfinement(ENGINE_ROOT, emptyKeepOutFacts(), 60);

const feedItem = (id: string, fields: Partial<FeedItem> = {}): FeedItem => ({
  id, type: "Task", state: "open", resolution: null, parent: null, milestone: "M1", blockedBy: [], decisions: [], title: null, lane: "roadmap",
  relates: [], horizon: null, order: null, ownerRole: null, area: [], severity: null, evidence: null, tests: [], rfc: null, gh: null,
  path: `${TRACKER_BOARD.items}/${id}.md`, ...fields,
});
/** A close PROVEN by its tests: shipped. */
const shipped = (id: string, fields: Partial<FeedItem> = {}): FeedItem => feedItem(id, { state: "closed", resolution: "completed", tests: [`tests/${id}.test.ts`], ...fields });
const facts = (item: FeedItem): StatusItem => ({ id: item.id, type: item.type, state: item.state, resolution: item.resolution, parent: item.parent, milestone: item.milestone, blockedBy: item.blockedBy, decisions: item.decisions, tests: item.tests, evidence: item.evidence });
const snapshot = (commit: string, date: string, items: readonly FeedItem[], decisions: FeedSnapshot["decisions"] = []): FeedSnapshot => ({ commit, date, items: items.map(facts), decisions, recordedEvidence: [] });
const MILESTONE = feedItem("M1", { type: "Milestone", state: null, milestone: null, lane: null, title: "First milestone", order: 0 });
const input = (items: readonly FeedItem[], fields: Partial<RoadmapFeedInput> = {}): RoadmapFeedInput => ({
  schema: ROADMAP_FEED_INPUT_SCHEMA, source: SOURCE, sourceDate: "2026-10-21T12:00:00Z", repositoryUrl: "https://github.com/owner/repo",
  items: [MILESTONE, ...items], decisions: [{ id: "D-1", status: "in-force", implementation: "partial", title: "A decision" }],
  recordedEvidence: [], history: [], minimumWeeks: 4, ...fields,
});

test("items, milestones and decisions carry computed states (a close shipped only when proven), progress, the critical path and their links", () => {
  const feed = roadmapFeed(input([
    shipped("A"),
    feedItem("B", { blockedBy: ["C"], decisions: ["D-1"], tests: ["engine/test/b.test.ts"], rfc: "discussion-4" }),
    feedItem("C", { blockedBy: ["E"] }),
    feedItem("E"),
    feedItem("N", { state: "closed", resolution: "not-planned" }),
    feedItem("CLAIM", { state: "closed", resolution: "completed" }),
  ]));
  const item = (id: string) => feed.items.find((entry) => entry.id === id)!;
  assert.deepEqual([item("B").state, item("B").because], ["blocked", "blocked by C"]);
  assert.deepEqual([item("CLAIM").state, item("A").state, item("A").because], ["claimed", "shipped", "proven by tests tests/A.test.ts"]);
  assert.deepEqual(item("B").tests, [{ path: "engine/test/b.test.ts", url: `https://github.com/owner/repo/blob/${SOURCE}/engine/test/b.test.ts` }]);
  assert.equal(item("B").record, `https://github.com/owner/repo/blob/${SOURCE}/${TRACKER_BOARD.items}/B.md`);
  assert.equal("opened" in item("A") || "closed" in item("A"), false, "no typed date reaches the feed");
  const milestone = feed.milestones[0]!;
  assert.deepEqual([milestone.id, milestone.state, milestone.counts.shipped, milestone.counts.claimed, milestone.counts["not planned"]], ["M1", "in progress", 1, 1, 1]);
  assert.equal(milestone.progress, 1 / 5, "progress is proven shipped over the planned members (not-planned outside it; a claim is not progress)");
  assert.deepEqual(milestone.criticalPath, ["E", "C", "B"], "the longest chain of open work through blocked-by, the blocker first");
  assert.deepEqual(feed.decisions, [{ id: "D-1", title: "A decision", status: "in-force", progress: "partly built", carriedBy: ["B"] }]);
  assert.deepEqual(feed.totals, { shipped: 1, claimed: 1, "in progress": 0, planned: 1, blocked: 2, "not planned": 1 });
});

test("throughput counts proven ships by their LANDING week; an ETA is a band only with enough history, `unknown` before, `done` when nothing remains", () => {
  // Six landing weeks shipping 2, 2, 1, 1, 3, 1 items; six remain open.
  const weeks = [["2026-09-09", 2], ["2026-09-16", 2], ["2026-09-23", 1], ["2026-09-30", 1], ["2026-10-07", 3], ["2026-10-14", 1]] as const;
  const ids = weeks.flatMap(([, count], week) => Array.from({ length: count }, (_, index) => `S-${String(week)}-${String(index)}`));
  const remaining = Array.from({ length: 6 }, (_, index) => feedItem(`R-${String(index)}`));
  const history: FeedSnapshot[] = [snapshot("c0", "2026-09-01T00:00:00Z", [MILESTONE, ...ids.map((id) => feedItem(id)), ...remaining])];
  let done = 0;
  for (const [date, count] of weeks) {
    done += count;
    history.push(snapshot(`c-${date}`, `${date}T10:00:00Z`, [MILESTONE, ...ids.map((id, index) => (index < done ? shipped(id) : feedItem(id))), ...remaining]));
  }
  const band = roadmapFeed(input([...ids.map((id) => shipped(id)), ...remaining], { sourceDate: "2026-10-20T00:00:00Z", history }));
  assert.deepEqual(band.throughput.weekly, [2, 2, 1, 1, 3, 1], "six whole weeks from the first shipping landing to S");
  assert.equal(band.throughput.enoughHistory, true);
  assert.deepEqual(band.milestones[0]!.eta, { state: "band", weeks: { low: 3, high: 6 } }, "6 remaining at the 75th (2/week) and 25th (1/week) percentile weeks");
  const few = roadmapFeed(input([shipped("A"), feedItem("B")], { history: [snapshot("c1", "2026-10-20T00:00:00Z", [MILESTONE, shipped("A"), feedItem("B")])] }));
  assert.deepEqual(few.milestones[0]!.eta, { state: "unknown", weeks: null, because: "fewer than 4 weeks of shipped history" });
  assert.deepEqual(roadmapFeed(input([shipped("A")])).milestones[0]!.eta, { state: "done", weeks: null });
});

test("a typed date is never an input: a backdated close counts in the week it LANDED, and an input carrying a date is refused", () => {
  // The record says it closed in 2020; it landed, proven, on 2026-10-21.
  const history = [
    snapshot("c1", "2026-10-14T09:00:00Z", [MILESTONE, feedItem("OLD")]),
    snapshot("c2", "2026-10-21T09:00:00Z", [MILESTONE, shipped("OLD")]),
  ];
  const feed = roadmapFeed(input([shipped("OLD")], { history }));
  assert.deepEqual(feed.items.find((item) => item.id === "OLD")!.landed, { first: "2026-10-14T09:00:00Z", shipped: "2026-10-21T09:00:00Z" });
  assert.deepEqual(feed.throughput.weekly, [1], "counted in its landing week, never in 2020");
  const dated = input([{ ...shipped("OLD"), closed: "2020-01-01" } as FeedItem]);
  assert.throws(() => computeRoadmapFeed(dated, CONFINEMENT), (error: HarnessError) => error.code === "roadmap_feed_typed_date" && /OLD/u.test(error.message));
});

test("the history is one entry per landing that moved a state — first appearances, removals and decision-only landings included", () => {
  const work = feedItem("W", { decisions: ["D-2"] });
  const feed = roadmapFeed(input([work], { history: [
    snapshot("c1", "2026-10-01T00:00:00Z", [work], [{ id: "D-2", status: "in-force", implementation: "pending" }]),
    snapshot("c2", "2026-10-02T00:00:00Z", [work, feedItem("B")], [{ id: "D-2", status: "in-force", implementation: "pending" }]),
    // A landing that changed only the decision record: D-2 partly built, so W is in progress.
    snapshot("c3", "2026-10-03T00:00:00Z", [work, feedItem("B")], [{ id: "D-2", status: "in-force", implementation: "partial" }]),
    snapshot("c4", "2026-10-04T00:00:00Z", [work], [{ id: "D-2", status: "in-force", implementation: "partial" }]),
  ] }));
  assert.deepEqual(feed.history, [
    { commit: "c1", date: "2026-10-01T00:00:00Z", changes: [{ id: "W", from: null, to: "planned" }] },
    { commit: "c2", date: "2026-10-02T00:00:00Z", changes: [{ id: "B", from: null, to: "planned" }] },
    { commit: "c3", date: "2026-10-03T00:00:00Z", changes: [{ id: "W", from: "planned", to: "in progress" }] },
    { commit: "c4", date: "2026-10-04T00:00:00Z", changes: [{ id: "B", from: "planned", to: null }] },
  ]);
});

test("the feed is read from the commit's first-parent history (a decision-only commit included, a past spelling read as written) and computed confined: one digest per commit", () => {
  const root = createTempDir("roadmap-feed-");
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...testGitIdentityEnvironment() } }).trim();
  git("init", "-q", "-b", "main");
  mkdirSync(join(root, TRACKER_BOARD.items), { recursive: true });
  mkdirSync(join(root, "docs/decisions"), { recursive: true });
  const write = (id: string, front: string): void => writeFileSync(join(root, TRACKER_BOARD.items, `${id}.md`), `---\nschema: bridlewise-tracker-item/v1\npublished: false\nid: ${id}\n${front}\nopened: 2026-10-01\n---\n\nThe outcome.\n`);
  const decision = (implementation: string): void => writeFileSync(join(root, "docs/decisions/D-9-a-decision.md"), `---\nid: D-9\ndate: 2026-10-01\nby: user\ngroup: engine\nstatus: in-force\nimplementation: ${implementation}\n${implementation === "partial" ? "route: A-ONE\nacted_in: [docs]\n" : "route: A-ONE\n"}---\n# A decision\n`);
  // A past spelling the format now refuses (`gh: #31`) is history, read as written.
  write("A-ONE", "type: Task\nstate: open\nlane: floor\ndecisions: [D-9]\ngh: #31");
  decision("pending");
  git("add", "."); git("commit", "-q", "-m", "open, in a spelling refused today");
  write("A-ONE", "type: Task\nstate: open\nlane: floor\ndecisions: [D-9]\ngh: issue-31");
  git("add", "."); git("commit", "-q", "-m", "respelled, no state moved");
  decision("partial");
  git("add", "."); git("commit", "-q", "-m", "the decision only: partly built");
  const repository = configuredGitRepository({}, root);
  const read = roadmapFeedInput(repository, "HEAD", "https://github.com/owner/repo", 4);
  assert.equal(read.history.length, 3, "every landing that changed an item or a decision is a snapshot");
  const first = computeRoadmapFeed(read, CONFINEMENT);
  assert.deepEqual(first.feed.history.map((entry) => entry.changes), [[{ id: "A-ONE", from: null, to: "planned" }], [{ id: "A-ONE", from: "planned", to: "in progress" }]], "a landing that moved no state is no entry; the decision-only landing is one");
  assert.equal(computeRoadmapFeed(roadmapFeedInput(repository, "HEAD", "https://github.com/owner/repo", 4), CONFINEMENT).digest, first.digest, "the same commit gives the same feed in other processes");
  assert.equal(computeRoadmapFeed(roadmapFeedInput(repository, "HEAD~1", "https://github.com/owner/repo", 4), CONFINEMENT).feed.items[0]?.state, "planned", "the roadmap at an earlier commit is that commit's");
  // The feed AT a commit judges its items by today's format; its history never does.
  assert.throws(() => roadmapFeedInput(repository, "HEAD~2", "https://github.com/owner/repo", 4), (error: Error & { code?: string }) => error.code === "tracker_item_invalid");
});
