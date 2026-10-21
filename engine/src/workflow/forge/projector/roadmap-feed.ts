/**
 * THE ROADMAP DATA FEED — `roadmap.json`, the one stable feed the public
 * roadmap page renders (its design and renderer are the site's; its build
 * publishes the file), a pure function of the source commit and the items'
 * own history (github-only §9.6: the dashboard is a pure function of commits).
 *
 * PURE: it runs confined like the projection (`confined.ts`,
 * `ROADMAP_FEED_PROGRAM`), computed twice. Its input is read from git by the
 * host (`projection.ts` `roadmapFeedInput`): the items, decision records and
 * recorded evidence at S, S's committer date, and a SNAPSHOT of every item's
 * status facts, the decisions and the recorded evidence at each commit of
 * S's first-parent history that changed an item, a decision or an evidence
 * manifest. NO TYPED DATE is an input: when an item appeared and when it
 * shipped are the LANDING times of those commits, never an `opened` or
 * `closed` an item's file says.
 *
 * What it answers (`bridlewise-roadmap-feed/v1`):
 *   - every item with its COMPUTED state and the reason it holds
 *     (src/workflow/tracker-status.ts), its links (milestone, parent,
 *     blocked-by, relates, decisions, tests, rfc, evidence) and its record's
 *     permalink at S;
 *   - every milestone with its state, its member counts and its progress;
 *   - each milestone's CRITICAL PATH: the longest chain of open work through
 *     `blocked-by` among its open members (and what blocks them);
 *   - every decision record with its progress (built, partly built,
 *     designed, standing, superseded) and the items that carry it out;
 *   - the HISTORY: one entry per commit that changed an item's state — what
 *     changed in that landing — so burn-up, the roadmap at any commit, and
 *     "what changed since" are exact replays, never estimates;
 *   - THROUGHPUT (items that became `shipped` — proven — per week, by the
 *     landing time of the commit that made them so) and, per milestone, an
 *     ETA BAND in weeks — never a date, and `unknown` until enough weeks of
 *     history exist.
 */
import { decisionProgress, itemStatuses, ROADMAP_STATES, type ItemStatus, type RoadmapState, type StatusDecision, type StatusFacts, type StatusItem } from "../../tracker-status.ts";
import { compareUtf8Bytes } from "../../../kernel/ordered.ts";
import { schemaId } from "../../../kernel/product-identity.ts";

export const ROADMAP_FEED_SCHEMA = schemaId("roadmap-feed", 1);
export const ROADMAP_FEED_INPUT_SCHEMA = schemaId("roadmap-feed-input", 1);

/** An item as the feed reads it at S: its status facts and everything a reader follows. */
export type FeedItem = StatusItem & Readonly<{
  title: string | null;
  lane: string | null;
  relates: readonly string[];
  horizon: string | null;
  order: number | null;
  ownerRole: string | null;
  area: readonly string[];
  severity: string | null;
  evidence: string | null;
  tests: readonly string[];
  rfc: string | null;
  gh: string | null;
  path: string;
}>;

export type FeedDecision = StatusDecision & Readonly<{ title: string }>;

/** One commit of S's first-parent history that changed an item, a decision or an evidence manifest: its id, its landing time, and every item's status facts, the decisions and the recorded evidence then. */
export type FeedSnapshot = Readonly<{ commit: string; date: string; items: readonly StatusItem[]; decisions: readonly StatusDecision[]; recordedEvidence: readonly string[] }>;

export type RoadmapFeedInput = Readonly<{
  schema: typeof ROADMAP_FEED_INPUT_SCHEMA;
  source: string;
  /** S's committer date (ISO 8601): the feed's "now", from the input, never a clock. */
  sourceDate: string;
  repositoryUrl: string;
  items: readonly FeedItem[];
  decisions: readonly FeedDecision[];
  /** The evidence paths recorded in tracked manifests at S (a close's proof). */
  recordedEvidence: readonly string[];
  /** Oldest first. */
  history: readonly FeedSnapshot[];
  /** How many weeks of throughput an ETA needs before it is answered. */
  minimumWeeks: number;
}>;

/** The calendar day of a `YYYY-MM-DD` or ISO 8601 date-time. */
function dayOf(date: string): string {
  return date.split("T")[0]!;
}

/** Days since 1970-01-01 of a `YYYY-MM-DD` (or ISO) date, by arithmetic (no clock, no `Date`). */
function epochDays(date: string): number {
  const [year, month, day] = dayOf(date).split("-").map(Number) as [number, number, number];
  // Howard Hinnant's days-from-civil.
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** The q-quantile (0..1) of sorted `values`, nearest rank. */
function quantile(sorted: readonly number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

/** Each item's landing times from the history: when it first appeared, and when it became shipped (proven); null when the history holds neither. */
function landings(history: readonly HistoryEntry[]): ReadonlyMap<string, Readonly<{ first: string | null; shipped: string | null }>> {
  const out = new Map<string, { first: string | null; shipped: string | null }>();
  for (const entry of history) {
    for (const change of entry.changes) {
      const known = out.get(change.id) ?? { first: null, shipped: null };
      if (change.from === null && known.first === null) known.first = entry.date;
      if (change.to === "shipped") known.shipped = entry.date;
      else if (change.from === "shipped") known.shipped = null;
      out.set(change.id, known);
    }
  }
  return out;
}

/** Work items (never a Milestone) that became shipped in each whole week (by landing time), from the first such landing to S, oldest first; null when none has. */
function weeklyThroughput(landed: ReadonlyMap<string, Readonly<{ shipped: string | null }>>, milestones: ReadonlySet<string>, sourceDate: string): readonly number[] | null {
  const shippedDays = [...landed.entries()].flatMap(([id, entry]) => (entry.shipped === null || milestones.has(id) ? [] : [epochDays(entry.shipped)]));
  if (shippedDays.length === 0) return null;
  const end = epochDays(sourceDate);
  const start = Math.min(...shippedDays);
  const weeks = Math.max(1, Math.floor((end - start) / 7) + 1);
  const counts = new Array<number>(weeks).fill(0);
  for (const day of shippedDays) {
    const week = Math.floor((day - start) / 7);
    if (week >= 0 && week < weeks) counts[week]! += 1;
  }
  return counts;
}

/** The longest chain of open work through `blocked-by` ending at each open item (the item last). */
function longestChains(items: readonly FeedItem[], statuses: ReadonlyMap<string, ItemStatus>): ReadonlyMap<string, readonly string[]> {
  const byId = new Map(items.map((item) => [item.id, item]));
  const open = (id: string): boolean => ["planned", "in progress", "blocked"].includes(statuses.get(id)?.state ?? "");
  const chains = new Map<string, readonly string[]>();
  const chainOf = (id: string): readonly string[] => {
    const known = chains.get(id);
    if (known !== undefined) return known;
    chains.set(id, [id]); // the format refuses blocked-by cycles; this only bounds the walk
    const blockers = (byId.get(id)?.blockedBy ?? []).filter(open).sort(compareUtf8Bytes);
    let best: readonly string[] = [];
    for (const blocker of blockers) {
      const chain = chainOf(blocker);
      if (chain.length > best.length) best = chain;
    }
    const chain = [...best, id];
    chains.set(id, chain);
    return chain;
  };
  for (const item of items) if (open(item.id)) chainOf(item.id);
  return chains;
}

function countStates(ids: readonly string[], statuses: ReadonlyMap<string, ItemStatus>): Record<RoadmapState, number> {
  return Object.fromEntries(ROADMAP_STATES.map((state) => [state, ids.filter((id) => statuses.get(id)?.state === state).length])) as Record<RoadmapState, number>;
}

/** The feed for `input`. */
type HistoryEntry = { commit: string; date: string; changes: { id: string; from: RoadmapState | null; to: RoadmapState | null }[] };

export function roadmapFeed(input: RoadmapFeedInput) {
  const facts = (decisions: readonly StatusDecision[], recordedEvidence: readonly string[]): StatusFacts => ({ decisions, recordedEvidence: new Set(recordedEvidence), repositoryUrl: input.repositoryUrl });
  // The history first: the landing times of every state move are the feed's only times.
  const history: HistoryEntry[] = [];
  let previous = new Map<string, RoadmapState>();
  for (const snapshot of input.history) {
    const now = new Map([...itemStatuses(snapshot.items, facts(snapshot.decisions, snapshot.recordedEvidence)).entries()].map(([id, value]) => [id, value.state]));
    const ids = [...new Set([...previous.keys(), ...now.keys()])].sort(compareUtf8Bytes);
    const changes = ids.filter((id) => previous.get(id) !== now.get(id)).map((id) => ({ id, from: previous.get(id) ?? null, to: now.get(id) ?? null }));
    if (changes.length > 0) history.push({ commit: snapshot.commit, date: snapshot.date, changes });
    previous = now;
  }
  const landed = landings(history);
  const statuses = itemStatuses(input.items, facts(input.decisions, input.recordedEvidence));
  const status = (id: string): ItemStatus => statuses.get(id) ?? { state: "planned", because: `${id} is not judged` };
  const blob = `${input.repositoryUrl}/blob/${input.source}`;
  const work = input.items.filter((item) => item.type !== "Milestone");
  const milestoneIds = new Set([...input.items, ...input.history.flatMap((snapshot) => snapshot.items)].filter((item) => item.type === "Milestone").map((item) => item.id));
  const weekly = weeklyThroughput(landed, milestoneIds, input.sourceDate);
  const sortedWeekly = weekly === null ? [] : [...weekly].sort((left, right) => left - right);
  const enoughHistory = weekly !== null && weekly.length >= input.minimumWeeks;
  const chains = longestChains(input.items, statuses);
  const milestones = input.items.filter((item) => item.type === "Milestone").sort((left, right) => (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER) || compareUtf8Bytes(left.id, right.id)).map((milestone) => {
    const members = work.filter((item) => item.milestone === milestone.id).map((item) => item.id).sort(compareUtf8Bytes);
    const counts = countStates(members, statuses);
    const planned = members.length - counts["not planned"];
    const remaining = counts.planned + counts["in progress"] + counts.blocked;
    const openMembers = members.filter((id) => ["planned", "in progress", "blocked"].includes(status(id).state));
    let criticalPath: readonly string[] = [];
    for (const id of openMembers) if ((chains.get(id)?.length ?? 0) > criticalPath.length) criticalPath = chains.get(id)!;
    const fast = enoughHistory ? quantile(sortedWeekly, 0.75) : 0;
    const slow = enoughHistory ? quantile(sortedWeekly, 0.25) : 0;
    const eta = remaining === 0
      ? { state: "done" as const, weeks: null }
      : !enoughHistory || fast === 0
        ? { state: "unknown" as const, weeks: null, because: enoughHistory ? "no week of the window shipped enough to project" : `fewer than ${String(input.minimumWeeks)} weeks of shipped history` }
        : { state: "band" as const, weeks: { low: Math.ceil(remaining / fast), high: slow === 0 ? null : Math.ceil(remaining / slow) } };
    return {
      id: milestone.id,
      title: milestone.title ?? milestone.id,
      order: milestone.order,
      state: status(milestone.id).state,
      because: status(milestone.id).because,
      members,
      counts,
      progress: planned === 0 ? null : counts.shipped / planned,
      criticalPath,
      eta,
      record: `${blob}/${milestone.path}`,
    };
  });
  const decisions = [...input.decisions].sort((left, right) => compareUtf8Bytes(left.id, right.id)).map((decision) => ({
    id: decision.id,
    title: decision.title,
    status: decision.status,
    progress: decisionProgress(decision),
    carriedBy: work.filter((item) => item.decisions.includes(decision.id)).map((item) => item.id).sort(compareUtf8Bytes),
  }));
  return {
    schema: ROADMAP_FEED_SCHEMA,
    source: input.source,
    sourceDate: input.sourceDate,
    states: ROADMAP_STATES,
    totals: countStates(work.map((item) => item.id), statuses),
    milestones,
    items: [...input.items].sort((left, right) => compareUtf8Bytes(left.id, right.id)).map((item) => ({
      id: item.id,
      type: item.type,
      title: item.title ?? item.id,
      lane: item.lane,
      milestone: item.milestone,
      parent: item.parent,
      children: work.filter((child) => child.parent === item.id).map((child) => child.id).sort(compareUtf8Bytes),
      blockedBy: item.blockedBy,
      relates: item.relates,
      horizon: item.horizon,
      order: item.order,
      owner: item.ownerRole,
      area: item.area,
      severity: item.severity,
      state: status(item.id).state,
      because: status(item.id).because,
      /** Landing times from git (first appearance, becoming shipped), never a typed date. */
      landed: landed.get(item.id) ?? { first: null, shipped: null },
      decisions: item.decisions,
      tests: item.tests.map((path) => ({ path, url: `${blob}/${path}` })),
      rfc: item.rfc,
      gh: item.gh,
      evidence: item.evidence,
      record: `${blob}/${item.path}`,
    })),
    decisions,
    history,
    throughput: { weekly, minimumWeeks: input.minimumWeeks, enoughHistory, windowEnds: dayOf(input.sourceDate) },
  };
}

export type RoadmapFeed = ReturnType<typeof roadmapFeed>;

/** The confined program's entry: the input's JSON text in, the feed's JSON text out. */
export function roadmapFeedText(inputText: string): string {
  return JSON.stringify(roadmapFeed(JSON.parse(inputText) as RoadmapFeedInput));
}
