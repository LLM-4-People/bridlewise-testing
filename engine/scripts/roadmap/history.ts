/**
 * THE ROADMAP THROUGH GIT HISTORY — exact, replayed from git; nothing inferred.
 *
 * {@link replayHistory} walks the first-parent line up to a commit, over the
 * commits that changed the tracker items (`TRACKER_BOARD.items`), in ONE
 * `git log --raw` and one batched `git cat-file --batch` (the tree reader's
 * `readBlobTexts`, sized by `blobSizes`): a name → blob map is updated with
 * only the files each commit changed, and the item set at that commit is read
 * by the tracker's ONE parser (`trackerItems`, src/workflow/failure-owners.ts).
 * A set the parser refuses (an older schema, a broken commit) is recorded as
 * `unparseable` with the parser's own reason and the walk goes on: it is
 * never guessed at. Every date is the commit's committer time in UTC; no clock
 * is read, so the same commit replays to the same history.
 *
 * What is derived from the replay is derived from consecutive PARSABLE
 * snapshots only (an unparseable commit changes nothing; what changed across
 * it is attributed to the next parsable commit, the first that shows it):
 * - {@link changesBetween} / {@link historyChanges}: added, removed, closed,
 *   reopened, retitled, moved (milestone), blocked / unblocked (blocked-by);
 * - {@link burnUp}: a milestone's scope (its items, minus those closed as not
 *   planned or duplicate) and done count (closed as completed), at each commit
 *   either changed;
 * - {@link weeklyThroughput}: closed-as-completed TRANSITIONS per ISO week — an
 *   item that existed and was not closed as completed, and is at this commit.
 *   An item that first appears already closed (an import, or one opened and
 *   closed in one commit) is not a transition git shows, and is not counted.
 *
 * {@link itemTrailers} reads which commits name an item in an `Item: <ID>`
 * trailer (git's own trailer parse; the key exactly `Item`), and
 * {@link historyDocument} folds it all into one compact JSON document
 * (`ROADMAP_HISTORY_SCHEMA`) a browser can time-travel with:
 * {@link foldHistory}(doc, k) is the item state at commit k.
 */
import { blobSizes } from "../../src/git/ignored-copies.ts";
import { gitOutput, readBlobTexts, resolveRevision } from "../../src/git/tree-reader.ts";
import { configuredGitRepository } from "../../src/git/worktree-port.ts";
import { HarnessError, InputError } from "../../src/kernel/errors.ts";
import { deepFreeze } from "../../src/kernel/integrity.ts";
import { TRACKER_BOARD } from "../../src/kernel/verification-paths.ts";
import { TRACKER_ITEM_ID, trackerItems, type TrackerItem } from "../../src/workflow/failure-owners.ts";

import { isoTime, isoWeek, isoWeeksBetween, addIsoWeeks } from "./forecast.ts";
import { ROADMAP_HISTORY_SCHEMA, type BurnPoint, type RoadmapChange } from "./types.ts";

/** The fields of an item the roadmap follows through history. */
export type ItemState = Readonly<Pick<TrackerItem, "state" | "resolution" | "milestone" | "blockedBy" | "title" | "type" | "parent">>;

/** Every item of a snapshot by id (ids in order). */
export type ItemStates = Readonly<Record<string, ItemState>>;

/** The items at a commit that changed them. */
export type Snapshot = Readonly<{ sha: string; date: string; items: ItemStates }>;

/** A commit whose items the tracker's parser refuses, with its reason. */
export type UnparseableSnapshot = Readonly<{ sha: string; date: string; unparseable: string }>;

export type HistoryEntry = Snapshot | UnparseableSnapshot;

/** The first-parent replay up to `until` (a full commit id), oldest first. */
export type History = Readonly<{ until: string; snapshots: readonly HistoryEntry[] }>;

/** One commit naming an item in an `Item:` trailer. */
export type ItemTrailer = Readonly<{ sha: string; date: string; subject: string; pr: number | null }>;

/** Per item id, the commits that named it, newest first. */
export type ItemTrailers = Readonly<Record<string, readonly ItemTrailer[]>>;

const FIELDS = ["state", "resolution", "milestone", "blockedBy", "title", "type", "parent"] as const satisfies readonly (keyof ItemState)[];
const ITEM_TRAILER = "Item";
const RECORD = "\x1e";

/** A commit time (`%ct`, seconds) as an ISO timestamp in UTC, to the second. */
function commitDate(seconds: string): string {
  const value = Number(seconds);
  if (!Number.isSafeInteger(value)) throw new HarnessError(`git answered ${JSON.stringify(seconds)} for a commit time`, "roadmap_history_git_output");
  return new Date(value * 1000).toISOString().replace(/\.000Z$/u, "Z");
}

function isParsable(entry: HistoryEntry): entry is Snapshot {
  return "items" in entry;
}

function sameValue(left: ItemState[keyof ItemState], right: ItemState[keyof ItemState]): boolean {
  return Array.isArray(left) && Array.isArray(right) ? left.length === right.length && left.every((value, index) => value === right[index]) : left === right;
}

function sameItem(left: ItemState, right: ItemState): boolean {
  return FIELDS.every((field) => sameValue(left[field], right[field]));
}

function revision(root: string, until: string): Readonly<{ repository: ReturnType<typeof configuredGitRepository>; head: string }> {
  const repository = configuredGitRepository({}, root);
  const head = resolveRevision(repository, until);
  if (head === null) throw new InputError(`${JSON.stringify(until)} names no commit in ${root}`, "roadmap_history_revision_unknown");
  return { repository, head };
}

/** A commit of the repository at `root` and its committer time (UTC ISO): what a render is stamped with, never the clock. */
export function commitAt(root: string, rev: string): Readonly<{ sha: string; date: string }> {
  const { repository, head } = revision(root, rev);
  const seconds = Number(gitOutput(repository, ["show", "-s", "--no-color", "--format=%ct", head]).stdout.toString("utf8").trim());
  if (!Number.isInteger(seconds)) throw new HarnessError(`git did not give ${head}'s commit time`, "roadmap_history_git_failed");
  return deepFreeze({ sha: head, date: new Date(seconds * 1000).toISOString() });
}

type CommitChanges = { sha: string; date: string; changes: { path: string; oid: string | null }[] };

/** The `-z --raw` log's commits and their changed paths (`null`: deleted), read in order. */
function rawLog(output: string): readonly CommitChanges[] {
  const tokens = output.split("\0");
  const commits: CommitChanges[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!.replace(/^\n+/u, "");
    if (token.length === 0) continue;
    if (token.startsWith(RECORD)) {
      const [sha, seconds] = token.slice(1).split(" ");
      commits.push({ sha: sha!, date: commitDate(seconds ?? ""), changes: [] });
      continue;
    }
    const meta = /^:\d{6} (\d{6}) [0-9a-f]+ ([0-9a-f]+) ([ADMT])$/u.exec(token);
    const path = tokens[index + 1];
    if (meta === null || path === undefined || commits.length === 0) throw new HarnessError(`git log --raw answered an unexpected record ${JSON.stringify(token)}`, "roadmap_history_git_output");
    index += 1;
    commits.at(-1)!.changes.push({ path, oid: meta[3] === "D" ? null : meta[2]! });
  }
  return commits;
}

/** The item file name of a repository path: a direct `.md` child of the items folder other than its README (the tracker's `readEntries` rule). */
function itemFileName(path: string): string | null {
  const prefix = `${TRACKER_BOARD.items}/`;
  if (!path.startsWith(prefix)) return null;
  const name = path.slice(prefix.length);
  return !name.includes("/") && name.endsWith(".md") && name !== "README.md" ? name : null;
}

/**
 * The tracker items through the first-parent history of `until` in the
 * repository at `root`, one snapshot per commit that changed an item file
 * (see the header).
 */
export function replayHistory(root: string, until: string): History {
  const { repository, head } = revision(root, until);
  const log = gitOutput(repository, [
    "-c", "log.showRoot=true", "log", "--reverse", "--first-parent", "--diff-merges=first-parent", "--raw", "--no-renames", "--no-abbrev",
    "--no-color", "-z", `--format=${RECORD}%H %ct`, head, "--", `${TRACKER_BOARD.items}/`,
  ]).stdout.toString("utf8");
  const commits = rawLog(log).map((commit) => ({ ...commit, changes: commit.changes.flatMap(({ path, oid }) => {
    const name = itemFileName(path);
    return name === null ? [] : [{ name, oid }];
  }) })).filter((commit) => commit.changes.length > 0);
  const oids = [...new Set(commits.flatMap((commit) => commit.changes.flatMap(({ oid }) => (oid === null ? [] : [oid]))))];
  const sizes = blobSizes(root, oids, "directory");
  const read = readBlobTexts(repository, oids.map((oid) => ({ oid, size: sizes.get(oid)! })), `${TRACKER_BOARD.items} history`);
  const texts = new Map(oids.map((oid, index) => [oid, read[index]!]));
  const files = new Map<string, string>();
  const snapshots: HistoryEntry[] = [];
  let previous: ItemStates = {};
  for (const commit of commits) {
    for (const { name, oid } of commit.changes) {
      if (oid === null) files.delete(name);
      else files.set(name, oid);
    }
    const entries = [...files.keys()].sort().map((name) => ({ name, text: texts.get(files.get(name)!)! }));
    let items: readonly TrackerItem[];
    try {
      items = trackerItems(entries);
    } catch (error) {
      if (!(error instanceof InputError) || error.code !== "tracker_item_invalid") throw error;
      snapshots.push(deepFreeze({ sha: commit.sha, date: commit.date, unparseable: error.message }));
      continue;
    }
    const states: Record<string, ItemState> = {};
    for (const item of items) {
      const state: ItemState = deepFreeze({ state: item.state, resolution: item.resolution, milestone: item.milestone, blockedBy: [...item.blockedBy], title: item.title, type: item.type, parent: item.parent });
      const before = previous[item.id];
      // An unchanged item keeps its previous object: snapshots share what did not change.
      states[item.id] = before !== undefined && sameItem(before, state) ? before : state;
    }
    previous = deepFreeze(states);
    snapshots.push(deepFreeze({ sha: commit.sha, date: commit.date, items: previous }));
  }
  return deepFreeze({ until: head, snapshots });
}

const listed = (values: readonly string[]): string => values.join(", ");
const shown = (value: string | null): string => value ?? "none";
const titled = (id: string, state: ItemState): string => state.title ?? id;

/** What changed from the items `a` to the items `b` at commit `sha` (`date`), item by item in id order. */
export function changesBetween(a: ItemStates, b: ItemStates, sha: string, date: string): readonly RoadmapChange[] {
  const changes: RoadmapChange[] = [];
  const change = (item: string, kind: RoadmapChange["kind"], detail: string): void => {
    changes.push({ commit: sha, date, item, kind, detail });
  };
  for (const id of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const before = a[id];
    const after = b[id];
    if (before === undefined) {
      change(id, "added", `${titled(id, after!)} (${after!.state === "open" ? "open" : `closed as ${String(after!.resolution)}`})`);
      continue;
    }
    if (after === undefined) {
      change(id, "removed", titled(id, before));
      continue;
    }
    if (before.state === "open" && after.state === "closed") change(id, "closed", `as ${String(after.resolution)}`);
    if (before.state === "closed" && after.state === "open") change(id, "reopened", `was closed as ${String(before.resolution)}`);
    if (before.title !== after.title) change(id, "retitled", `${titled(id, before)} → ${titled(id, after)}`);
    if (before.milestone !== after.milestone) change(id, "moved", `${shown(before.milestone)} → ${shown(after.milestone)}`);
    const blocking = after.blockedBy.filter((blocker) => !before.blockedBy.includes(blocker));
    const freed = before.blockedBy.filter((blocker) => !after.blockedBy.includes(blocker));
    if (blocking.length > 0) change(id, "blocked", `by ${listed(blocking)}`);
    if (freed.length > 0) change(id, "unblocked", `${listed(freed)} no longer block${freed.length === 1 ? "s" : ""} it`);
  }
  return deepFreeze(changes);
}

/** Every change of `history`, oldest first (each parsable snapshot against the parsable one before it). */
export function historyChanges(history: History): readonly RoadmapChange[] {
  let previous: ItemStates = {};
  const changes: RoadmapChange[] = [];
  for (const snapshot of history.snapshots.filter(isParsable)) {
    changes.push(...changesBetween(previous, snapshot.items, snapshot.sha, snapshot.date));
    previous = snapshot.items;
  }
  return deepFreeze(changes);
}

function newestFirst(left: ItemTrailer, right: ItemTrailer): number {
  return left.date < right.date ? 1 : left.date > right.date ? -1 : 0;
}

/**
 * Every commit reachable from `until` (all parents) whose message carries an
 * `Item: <ID>` trailer — one or more; the key exactly `Item` — grouped by item
 * id, newest first. `pr` is the pull request the subject names (`… (#123)` or
 * `Merge pull request #123 …`), `null` when it names none. A trailer value
 * that is not an item id is refused (`roadmap_item_trailer_invalid`), naming
 * its commit.
 */
export function itemTrailers(root: string, until: string): ItemTrailers {
  const { repository, head } = revision(root, until);
  const log = gitOutput(repository, [
    "log", "--no-color", "--extended-regexp", `--grep=^${ITEM_TRAILER}:`, `--format=%H%x00%ct%x00%s%x00%(trailers:only,unfold)${RECORD}`, head, "--",
  ]).stdout.toString("utf8");
  const named = new Map<string, ItemTrailer[]>();
  for (const record of log.split(RECORD).map((entry) => entry.replace(/^\n+/u, "")).filter((entry) => entry.length > 0)) {
    const [sha, seconds, subject, trailers] = record.split("\0");
    const pr = /\(#([1-9]\d*)\)\s*$/u.exec(subject!) ?? /^Merge pull request #([1-9]\d*)\b/u.exec(subject!);
    const commit: ItemTrailer = deepFreeze({ sha: sha!, date: commitDate(seconds ?? ""), subject: subject!, pr: pr === null ? null : Number(pr[1]) });
    for (const line of (trailers ?? "").split("\n")) {
      const trailer = /^([^:]+):(.*)$/u.exec(line);
      if (trailer?.[1] !== ITEM_TRAILER) continue;
      const id = trailer[2]!.trim();
      if (!TRACKER_ITEM_ID.test(id)) throw new InputError(`commit ${sha!} carries "${line}": an ${ITEM_TRAILER} trailer names one item id`, "roadmap_item_trailer_invalid");
      const commits = named.get(id) ?? [];
      if (!commits.some((entry) => entry.sha === commit.sha)) commits.push(commit);
      named.set(id, commits);
    }
  }
  return deepFreeze(Object.fromEntries([...named.keys()].sort().map((id) => [id, [...named.get(id)!].sort(newestFirst)])));
}

/** A milestone's burn-up: a point at each commit where its scope or done count changed (from nothing). */
export function burnUp(history: History, milestoneId: string): readonly BurnPoint[] {
  const points: BurnPoint[] = [];
  let last = { scope: 0, done: 0 };
  for (const snapshot of history.snapshots.filter(isParsable)) {
    const items = Object.values(snapshot.items).filter((item) => item.milestone === milestoneId);
    const scope = items.filter((item) => item.resolution !== "not-planned" && item.resolution !== "duplicate").length;
    const done = items.filter((item) => item.state === "closed" && item.resolution === "completed").length;
    if (scope === last.scope && done === last.done) continue;
    last = { scope, done };
    points.push({ commit: snapshot.sha, date: snapshot.date, scope, done });
  }
  return deepFreeze(points);
}

const completed = (item: ItemState | undefined): boolean => item?.state === "closed" && item.resolution === "completed";

/**
 * Closed-as-completed transitions (see the header) per ISO week, for the
 * `weeks` weeks ending with the one holding `untilDate` (oldest first; an ISO
 * date counts its whole day), and `weeksOfData`: the ISO weeks from the first
 * parsable snapshot to `untilDate`, both inclusive (0 when none is that old).
 */
export function weeklyThroughput(history: History, untilDate: string, weeks: number): Readonly<{ weeks: readonly Readonly<{ week: string; closed: number }>[]; weeksOfData: number }> {
  if (!Number.isSafeInteger(weeks) || weeks < 1) throw new InputError(`a throughput window is at least one week (was ${String(weeks)})`, "roadmap_week_count_invalid");
  const cutoff = isoTime(untilDate, "end");
  const last = isoWeek(untilDate);
  const counts = new Map<string, number>(Array.from({ length: weeks }, (_, index) => [addIsoWeeks(last, index - weeks + 1), 0]));
  const parsable = history.snapshots.filter(isParsable).filter((snapshot) => isoTime(snapshot.date, "start") <= cutoff);
  let previous: ItemStates = {};
  for (const snapshot of parsable) {
    const week = isoWeek(snapshot.date);
    const closed = Object.entries(snapshot.items).filter(([id, item]) => completed(item) && previous[id] !== undefined && !completed(previous[id])).length;
    if (counts.has(week)) counts.set(week, counts.get(week)! + closed);
    previous = snapshot.items;
  }
  const weeksOfData = parsable.length === 0 ? 0 : isoWeeksBetween(isoWeek(parsable[0]!.date), last) + 1;
  return deepFreeze({ weeks: [...counts].map(([week, closed]) => ({ week, closed })), weeksOfData });
}

/**
 * The last PARSABLE snapshot at or before `commitOrDate`: a commit id (a
 * unique prefix of at least 4 hex digits) of a commit that changed the items,
 * or an ISO date / timestamp (a date holds its whole day). Refused typed when
 * the commit is not one of the history's or no parsable snapshot is that old.
 */
export function snapshotAt(history: History, commitOrDate: string): Snapshot {
  let end: number;
  if (/^[0-9a-f]{4,64}$/u.test(commitOrDate)) {
    const matches = history.snapshots.flatMap((snapshot, index) => (snapshot.sha.startsWith(commitOrDate) ? [index] : []));
    if (matches.length !== 1) {
      throw new InputError(`${commitOrDate} names ${matches.length === 0 ? "no commit" : `${String(matches.length)} commits`} of this history (the first-parent commits that changed the tracker items); name one, or a date`, "roadmap_snapshot_commit_unknown");
    }
    end = matches[0]!;
  } else {
    const cutoff = isoTime(commitOrDate, "end");
    end = history.snapshots.findLastIndex((snapshot) => isoTime(snapshot.date, "start") <= cutoff);
  }
  const found = history.snapshots.slice(0, end + 1).findLast(isParsable);
  if (found === undefined) throw new InputError(`no parsable snapshot of the tracker items is at or before ${commitOrDate}`, "roadmap_snapshot_none");
  return found;
}

type HistoryEvent = Readonly<{ c: number; id: string; set: Partial<ItemState> }> | Readonly<{ c: number; id: string; removed: true }>;

/** The compact time-travel document (`ROADMAP_HISTORY_SCHEMA`): the state at commit k is the fold of the events with `c ≤ k` ({@link foldHistory}). */
export type HistoryDocument = Readonly<{
  schema: typeof ROADMAP_HISTORY_SCHEMA;
  until: string;
  commits: readonly Readonly<{ sha: string; date: string; unparseable?: string }>[];
  events: readonly HistoryEvent[];
  trailers: ItemTrailers;
}>;

/** `history` and `trailers` as the compact document: per commit, only the fields that changed. */
export function historyDocument(history: History, trailers: ItemTrailers): HistoryDocument {
  const events: HistoryEvent[] = [];
  let previous: ItemStates = {};
  history.snapshots.forEach((snapshot, c) => {
    if (!isParsable(snapshot)) return;
    for (const id of [...new Set([...Object.keys(previous), ...Object.keys(snapshot.items)])].sort()) {
      const before = previous[id];
      const after = snapshot.items[id];
      if (after === undefined) {
        events.push({ c, id, removed: true });
        continue;
      }
      const set = Object.fromEntries(FIELDS.filter((field) => before === undefined || !sameValue(before[field], after[field])).map((field) => [field, after[field]]));
      if (Object.keys(set).length > 0) events.push({ c, id, set });
    }
    previous = snapshot.items;
  });
  return deepFreeze({
    schema: ROADMAP_HISTORY_SCHEMA,
    until: history.until,
    commits: history.snapshots.map((snapshot) => (isParsable(snapshot) ? { sha: snapshot.sha, date: snapshot.date } : { sha: snapshot.sha, date: snapshot.date, unparseable: snapshot.unparseable })),
    events,
    trailers,
  });
}

/** The items at commit `commitIndex` of `doc`: the fold of every event with `c ≤ commitIndex`, ids in order. */
export function foldHistory(doc: HistoryDocument, commitIndex: number): ItemStates {
  if (doc.schema !== ROADMAP_HISTORY_SCHEMA) throw new InputError(`a history document is ${ROADMAP_HISTORY_SCHEMA} (was ${String(doc.schema)})`, "roadmap_history_schema");
  if (!Number.isSafeInteger(commitIndex) || commitIndex < 0 || commitIndex >= doc.commits.length) {
    throw new InputError(`commit index ${String(commitIndex)} is outside the document's ${String(doc.commits.length)} commits`, "roadmap_history_index");
  }
  const state = new Map<string, ItemState>();
  for (const event of doc.events) {
    if (event.c > commitIndex) break;
    if ("removed" in event) state.delete(event.id);
    else state.set(event.id, { ...state.get(event.id), ...event.set } as ItemState);
  }
  return deepFreeze(Object.fromEntries([...state.keys()].sort().map((id) => [id, state.get(id)!])));
}
