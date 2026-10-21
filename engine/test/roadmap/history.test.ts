/**
 * THE ROADMAP THROUGH GIT HISTORY (scripts/roadmap/history.ts), replayed on a
 * scratch repository built here, commit by commit at fixed times: items added,
 * closed, unblocked, retitled, moved, reopened and removed; a commit whose
 * items an older schema breaks (recorded unparseable, never guessed); a commit
 * that touches no item (no snapshot); a merged side branch (seen at its merge,
 * first-parent); `Item:` trailers with their near-misses (a lower-case key, a
 * trailer-like line that is not in the trailer block). Every output is
 * asserted exactly, and the compact document's fold is proved equal to the
 * snapshot at every commit.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { gitOutput } from "../../src/git/tree-reader.ts";
import { configuredGitRepository } from "../../src/git/worktree-port.ts";
import { TRACKER_BOARD } from "../../src/kernel/verification-paths.ts";
import {
  burnUp, changesBetween, foldHistory, historyChanges, historyDocument, itemTrailers, replayHistory, snapshotAt, weeklyThroughput,
  type HistoryEntry, type ItemStates,
} from "../../scripts/roadmap/history.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { testGitIdentityEnvironment } from "../support/test-git-identity.ts";

const code = (expected: string) => (error: unknown): boolean => (error as { code?: string }).code === expected;

type Scratch = Readonly<{
  root: string;
  git: (argv: readonly string[], date?: string) => string;
  write: (id: string, fields: Record<string, string>, schema?: string) => void;
  remove: (id: string) => void;
  commit: (message: string, date: string) => string;
}>;

/** A scratch repository with its own git (no global or system config), every commit at a fixed time. */
function scratch(prefix: string): Scratch {
  const root = createTempDir(`${prefix}-`);
  const repository = configuredGitRepository({}, root);
  const git = (argv: readonly string[], date = "2026-01-01T00:00:00Z"): string => gitOutput(repository, argv, {
    environment: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, ...testGitIdentityEnvironment() },
  }).stdout.toString("utf8").trim();
  git(["init", "-q", "-b", "main"]);
  // Every later git command runs in THIS repository, never a checkout above it.
  assert.ok(existsSync(join(root, ".git")), "the scratch repository exists before any git command runs in it");
  const items = join(root, TRACKER_BOARD.items);
  mkdirSync(items, { recursive: true });
  return {
    root,
    git,
    write(id, fields, schema = "bridlewise-tracker-item/v1") {
      const front = { schema, id, type: "Task", state: "open", lane: "floor", opened: "2026-01-05", ...fields };
      writeFileSync(join(items, `${id}.md`), `---\n${Object.entries(front).filter(([, value]) => value.length > 0).map(([name, value]) => `${name}: ${value}`).join("\n")}\n---\n\nThe outcome of ${id}.\n`);
    },
    remove(id) {
      rmSync(join(items, `${id}.md`));
    },
    commit(message, date) {
      git(["add", "--all"]);
      git(["commit", "-q", "--allow-empty", "-m", message], date);
      return git(["rev-parse", "HEAD"]);
    },
  };
}

const CLOSED = { state: "closed", resolution: "completed", closed: "2026-01-13" };

/** The planted history; each commit's sha by name. */
function planted(): Readonly<{ repo: Scratch; c: Readonly<Record<string, string>> }> {
  const repo = scratch("roadmap-history");
  const c: Record<string, string> = {};
  // An item's milestone names a Milestone item (the tracker's one parser refuses one that names none).
  repo.write("M1", { type: "Milestone", title: "Milestone one", order: "1" });
  repo.write("M2", { type: "Milestone", title: "Milestone two", order: "2" });
  repo.write("A-ONE", { title: "First", milestone: "M1" });
  repo.write("B-TWO", { title: "Second", milestone: "M1", "blocked-by": "[A-ONE]" });
  writeFileSync(join(repo.root, TRACKER_BOARD.items, "README.md"), "# Items\n");
  writeFileSync(join(repo.root, "notes.txt"), "one\n");
  c.c1 = repo.commit("Add the first items", "2026-01-05T10:00:00Z");
  writeFileSync(join(repo.root, "notes.txt"), "two\n");
  c.c2 = repo.commit("Tidy notes\n\nitem: A-ONE\nItems: B-TWO", "2026-01-07T10:00:00Z");
  repo.write("A-ONE", { title: "First", milestone: "M1", ...CLOSED });
  repo.write("B-TWO", { title: "Second", milestone: "M1" });
  repo.write("C-THREE", { milestone: "M1", ...CLOSED });
  c.c3 = repo.commit("Close the first item (#12)\n\nItem: A-ONE\nItem: C-THREE", "2026-01-13T10:00:00Z");
  repo.write("B-TWO", { title: "Second, renamed", milestone: "M1" });
  repo.write("D-FOUR", { milestone: "M1" }, "bridlewise-tracker-item/v0");
  c.c4 = repo.commit("Plant an item of an older schema", "2026-01-20T10:00:00Z");
  repo.write("B-TWO", { title: "Second, renamed", milestone: "M1", ...CLOSED, closed: "2026-01-27" });
  repo.write("D-FOUR", { milestone: "M1" });
  c.c5 = repo.commit("Close B (#13)\n\nItem: B-TWO\nSigned-off-by: Bridlewise Test <test@example.invalid>", "2026-01-27T10:00:00Z");
  repo.write("A-ONE", { title: "First", milestone: "M1" });
  repo.write("B-TWO", { title: "Second, renamed", milestone: "M2", ...CLOSED, closed: "2026-01-27" });
  repo.remove("C-THREE");
  repo.write("D-FOUR", { milestone: "M1", state: "closed", resolution: "not-planned", closed: "2026-02-03" });
  c.c6 = repo.commit("Reopen the first\n\nItem: A-ONE\n\nThe line above is prose, not a trailer.", "2026-02-03T10:00:00Z");
  repo.git(["switch", "-q", "-c", "lane/five"]);
  repo.write("E-FIVE", { title: "Five", "blocked-by": "[A-ONE]" });
  c.side = repo.commit("feat: five\n\nItem: E-FIVE", "2026-02-10T10:00:00Z");
  repo.git(["switch", "-q", "main"]);
  repo.git(["merge", "-q", "--no-ff", "-m", "Merge pull request #7 from lane/five\n\nItem: E-FIVE", "lane/five"], "2026-02-11T10:00:00Z");
  c.merge = repo.git(["rev-parse", "HEAD"]);
  repo.write("E-FIVE", { title: "Five", milestone: "M2", "blocked-by": "[D-FOUR]" });
  c.c8 = repo.commit("Move five", "2026-02-12T10:00:00Z");
  return { repo, c };
}

const state = (fields: Partial<Record<string, unknown>>): Record<string, unknown> => ({
  state: "open", resolution: null, milestone: null, blockedBy: [], title: null, type: "Task", parent: null, ...fields,
});

test("the replay is one snapshot per first-parent commit that changed an item, an older schema recorded unparseable", () => {
  const { repo, c } = planted();
  const history = replayHistory(repo.root, "main");
  assert.equal(history.until, c.c8);
  assert.deepEqual(history.snapshots.map((snapshot) => snapshot.sha), [c.c1, c.c3, c.c4, c.c5, c.c6, c.merge, c.c8], "no snapshot for the notes-only commit or the side branch's own commit");
  assert.deepEqual(history.snapshots.map((snapshot) => snapshot.date), [
    "2026-01-05T10:00:00Z", "2026-01-13T10:00:00Z", "2026-01-20T10:00:00Z", "2026-01-27T10:00:00Z", "2026-02-03T10:00:00Z", "2026-02-11T10:00:00Z", "2026-02-12T10:00:00Z",
  ]);
  const unparseable = history.snapshots[2] as { unparseable?: string };
  assert.match(unparseable.unparseable ?? "", /D-FOUR\.md: schema must be one of bridlewise-tracker-item\/v1 \(was bridlewise-tracker-item\/v0\)/u);
  assert.equal("items" in history.snapshots[2]!, false, "an unparseable commit carries no guessed items");
  const milestones = { M1: state({ type: "Milestone", title: "Milestone one" }), M2: state({ type: "Milestone", title: "Milestone two" }) };
  assert.deepEqual((history.snapshots[0] as { items: ItemStates }).items, {
    "A-ONE": state({ title: "First", milestone: "M1" }),
    "B-TWO": state({ title: "Second", milestone: "M1", blockedBy: ["A-ONE"] }),
    ...milestones,
  });
  assert.deepEqual((history.snapshots[4] as { items: ItemStates }).items, {
    "A-ONE": state({ title: "First", milestone: "M1" }),
    "B-TWO": state({ title: "Second, renamed", milestone: "M2", state: "closed", resolution: "completed" }),
    "D-FOUR": state({ milestone: "M1", state: "closed", resolution: "not-planned" }),
    ...milestones,
  });
  assert.deepEqual(replayHistory(repo.root, c.c3!).snapshots.map((snapshot) => snapshot.sha), [c.c1, c.c3], "until bounds the walk");
  assert.throws(() => replayHistory(repo.root, "no-such-branch"), code("roadmap_history_revision_unknown"));
});

test("every change is named in order, the unparseable commit's edits attributed to the next parsable one", () => {
  const { repo, c } = planted();
  const at = (sha: string, date: string) => (item: string, kind: string, detail: string) => ({ commit: sha, date, item, kind, detail });
  const c1 = at(c.c1!, "2026-01-05T10:00:00Z");
  const c3 = at(c.c3!, "2026-01-13T10:00:00Z");
  const c5 = at(c.c5!, "2026-01-27T10:00:00Z");
  const c6 = at(c.c6!, "2026-02-03T10:00:00Z");
  const merge = at(c.merge!, "2026-02-11T10:00:00Z");
  const c8 = at(c.c8!, "2026-02-12T10:00:00Z");
  assert.deepEqual(historyChanges(replayHistory(repo.root, "main")), [
    c1("A-ONE", "added", "First (open)"),
    c1("B-TWO", "added", "Second (open)"),
    c1("M1", "added", "Milestone one (open)"),
    c1("M2", "added", "Milestone two (open)"),
    c3("A-ONE", "closed", "as completed"),
    c3("B-TWO", "unblocked", "A-ONE no longer blocks it"),
    c3("C-THREE", "added", "C-THREE (closed as completed)"),
    c5("B-TWO", "closed", "as completed"),
    c5("B-TWO", "retitled", "Second → Second, renamed"),
    c5("D-FOUR", "added", "D-FOUR (open)"),
    c6("A-ONE", "reopened", "was closed as completed"),
    c6("B-TWO", "moved", "M1 → M2"),
    c6("C-THREE", "removed", "C-THREE"),
    c6("D-FOUR", "closed", "as not-planned"),
    merge("E-FIVE", "added", "Five (open)"),
    c8("E-FIVE", "moved", "none → M2"),
    c8("E-FIVE", "blocked", "by D-FOUR"),
    c8("E-FIVE", "unblocked", "A-ONE no longer blocks it"),
  ]);
});

test("changesBetween: identical states change nothing; blockers added and removed are named apart", () => {
  const items = { "A-ONE": state({ title: "First" }) } as unknown as ItemStates;
  assert.deepEqual(changesBetween(items, items, "abc", "2026-01-01T00:00:00Z"), []);
  assert.deepEqual(changesBetween({}, {}, "abc", "2026-01-01T00:00:00Z"), []);
  const several = changesBetween(
    { "A-ONE": state({ blockedBy: ["B", "C"] }) } as unknown as ItemStates,
    { "A-ONE": state({ blockedBy: ["C", "D", "E"] }) } as unknown as ItemStates, "abc", "2026-01-01T00:00:00Z");
  assert.deepEqual(several.map((change) => [change.kind, change.detail]), [["blocked", "by D, E"], ["unblocked", "B no longer blocks it"]]);
});

test("Item trailers: every commit (all parents), newest first, with the pull request its subject names; near-misses ignored", () => {
  const { repo, c } = planted();
  const trailers = itemTrailers(repo.root, "main");
  assert.deepEqual(trailers, {
    "A-ONE": [{ sha: c.c3, date: "2026-01-13T10:00:00Z", subject: "Close the first item (#12)", pr: 12 }],
    "B-TWO": [{ sha: c.c5, date: "2026-01-27T10:00:00Z", subject: "Close B (#13)", pr: 13 }],
    "C-THREE": [{ sha: c.c3, date: "2026-01-13T10:00:00Z", subject: "Close the first item (#12)", pr: 12 }],
    "E-FIVE": [
      { sha: c.merge, date: "2026-02-11T10:00:00Z", subject: "Merge pull request #7 from lane/five", pr: 7 },
      { sha: c.side, date: "2026-02-10T10:00:00Z", subject: "feat: five", pr: null },
    ],
  }, "c2's lower-case `item:` and `Items:`, and c6's trailer-like line above prose, name nothing");
  assert.deepEqual(Object.keys(itemTrailers(repo.root, c.c5!)), ["A-ONE", "B-TWO", "C-THREE"], "until bounds the trailers too");
});

test("an Item trailer that names no item id is refused, naming its commit", () => {
  const repo = scratch("roadmap-trailer");
  const sha = repo.commit("Mislabelled\n\nItem: not an id", "2026-01-05T10:00:00Z");
  assert.throws(() => itemTrailers(repo.root, "main"), (error: Error & { code?: string }) => error.code === "roadmap_item_trailer_invalid" && error.message.includes(sha));
});

test("burn-up: a point wherever the milestone's scope or done count changed; dropped items leave the scope", () => {
  const { repo, c } = planted();
  const history = replayHistory(repo.root, "main");
  assert.deepEqual(burnUp(history, "M1"), [
    { commit: c.c1, date: "2026-01-05T10:00:00Z", scope: 2, done: 0 },
    { commit: c.c3, date: "2026-01-13T10:00:00Z", scope: 3, done: 2 },
    { commit: c.c5, date: "2026-01-27T10:00:00Z", scope: 4, done: 3 },
    { commit: c.c6, date: "2026-02-03T10:00:00Z", scope: 1, done: 0 },
  ]);
  assert.deepEqual(burnUp(history, "M2"), [
    { commit: c.c6, date: "2026-02-03T10:00:00Z", scope: 1, done: 1 },
    { commit: c.c8, date: "2026-02-12T10:00:00Z", scope: 2, done: 1 },
  ]);
  assert.deepEqual(burnUp(history, "M9"), []);
});

test("weekly throughput counts closed-as-completed transitions only, in the ISO week of their commit", () => {
  const { repo } = planted();
  const history = replayHistory(repo.root, "main");
  // W03: A-ONE closes (C-THREE appears already closed: no transition); W05: B-TWO closes; W06: D-FOUR is dropped, not done.
  assert.deepEqual(weeklyThroughput(history, "2026-02-11", 6), {
    weeks: [
      { week: "2026-W02", closed: 0 }, { week: "2026-W03", closed: 1 }, { week: "2026-W04", closed: 0 },
      { week: "2026-W05", closed: 1 }, { week: "2026-W06", closed: 0 }, { week: "2026-W07", closed: 0 },
    ],
    weeksOfData: 6,
  });
  assert.deepEqual(weeklyThroughput(history, "2026-01-27", 2), { weeks: [{ week: "2026-W04", closed: 0 }, { week: "2026-W05", closed: 1 }], weeksOfData: 4 }, "the until day is counted whole");
  assert.deepEqual(weeklyThroughput(history, "2026-01-27T09:59:59Z", 2), { weeks: [{ week: "2026-W04", closed: 0 }, { week: "2026-W05", closed: 0 }], weeksOfData: 4 }, "a timestamp before the commit excludes it");
  assert.deepEqual(weeklyThroughput(history, "2026-01-04", 1), { weeks: [{ week: "2026-W01", closed: 0 }], weeksOfData: 0 }, "before any parsable snapshot");
  assert.throws(() => weeklyThroughput(history, "2026-02-11", 0), code("roadmap_week_count_invalid"));
  assert.throws(() => weeklyThroughput(history, "2026-02-30", 4), code("roadmap_date_invalid"));
});

test("snapshotAt: the last parsable snapshot at or before a commit or a date, refused typed when none", () => {
  const { repo, c } = planted();
  const history = replayHistory(repo.root, "main");
  const sha = (entry: HistoryEntry): string => entry.sha;
  assert.equal(sha(snapshotAt(history, c.c5!)), c.c5);
  assert.equal(sha(snapshotAt(history, c.c4!.slice(0, 10))), c.c3, "an unparseable commit answers the parsable one before it");
  assert.equal(sha(snapshotAt(history, "2026-01-20")), c.c3);
  assert.equal(sha(snapshotAt(history, "2026-01-13")), c.c3, "a date holds its whole day");
  assert.equal(sha(snapshotAt(history, "2026-01-13T09:59:59Z")), c.c1, "a timestamp is its own instant");
  assert.equal(sha(snapshotAt(history, "2030-01-01")), c.c8);
  assert.throws(() => snapshotAt(history, "2026-01-04"), code("roadmap_snapshot_none"));
  assert.throws(() => snapshotAt(history, c.c2!), code("roadmap_snapshot_commit_unknown"), "a commit that changed no item is not one of the history's");
  assert.throws(() => snapshotAt(history, "2026-02-30"), code("roadmap_date_invalid"));
});

test("the compact document folds to exactly the snapshot at every commit, through JSON", () => {
  const { repo, c } = planted();
  const history = replayHistory(repo.root, "main");
  const doc = historyDocument(history, itemTrailers(repo.root, "main"));
  assert.equal(doc.schema, "bridlewise-roadmap-history/v1");
  assert.deepEqual(doc.commits.map((commit) => commit.sha), history.snapshots.map((snapshot) => snapshot.sha));
  assert.match(doc.commits[2]!.unparseable ?? "", /bridlewise-tracker-item\/v0/u);
  assert.deepEqual(doc.events.filter((event) => event.c === 1), [
    { c: 1, id: "A-ONE", set: { state: "closed", resolution: "completed" } },
    { c: 1, id: "B-TWO", set: { blockedBy: [] } },
    { c: 1, id: "C-THREE", set: state({ milestone: "M1", state: "closed", resolution: "completed" }) },
  ], "only what changed is written");
  assert.deepEqual(doc.events.filter((event) => event.c === 4).find((event) => event.id === "C-THREE"), { c: 4, id: "C-THREE", removed: true });
  assert.deepEqual(doc.trailers["E-FIVE"]!.map((trailer) => trailer.sha), [c.merge, c.side]);
  const wire = JSON.parse(JSON.stringify(doc)) as typeof doc;
  let last: ItemStates = {};
  history.snapshots.forEach((snapshot, k) => {
    if ("items" in snapshot) last = snapshot.items;
    assert.deepEqual(foldHistory(doc, k), last, `commit ${String(k)}`);
    assert.deepEqual(foldHistory(wire, k), last, `commit ${String(k)} through JSON`);
  });
  assert.throws(() => foldHistory(doc, history.snapshots.length), code("roadmap_history_index"));
  assert.throws(() => foldHistory(doc, -1), code("roadmap_history_index"));
  assert.throws(() => foldHistory({ ...doc, schema: "bridlewise-roadmap-history/v0" } as unknown as typeof doc, 0), code("roadmap_history_schema"));
});

test("a repository whose history never held the items replays to nothing", () => {
  const repo = scratch("roadmap-empty");
  repo.commit("Nothing tracked yet", "2026-01-05T10:00:00Z");
  const history = replayHistory(repo.root, "HEAD");
  assert.deepEqual(history.snapshots, []);
  assert.deepEqual(historyChanges(history), []);
  assert.deepEqual(historyDocument(history, {}).events, []);
  assert.deepEqual(weeklyThroughput(history, "2026-01-05", 2).weeksOfData, 0);
});
