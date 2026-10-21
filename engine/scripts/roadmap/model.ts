/**
 * THE ROADMAP MODEL — a pure function of the repository's records at one
 * commit (and, when given, its history, its checks and the live snapshot).
 *
 * Status is computed from evidence, never typed:
 * - a closed item is `done` only while every check it binds passed on the
 *   rendered commit; otherwise it is `retracted` (struck through, publicly);
 * - an open item is `in-flight` when an open pull request names it, `blocked`
 *   while an open item blocks it, and `ready` otherwise.
 * The three horizons are computed from that status and the milestone order:
 * NOW is what is moving (in flight, or retracted and needing a fix), NEXT is
 * what can start in the earliest open milestone (plus anything on a critical
 * path, marked P0/P1, or unblocking P0/P1 work), LATER is everything else, each with its reason in
 * one sentence. No date is ever promised: a forecast is a measured band or an
 * honest unknown (forecast.ts).
 */
import type { TrackerItem } from "../../src/workflow/failure-owners.ts";
import type { Claim } from "../brand/claims.ts";
import type { CheckResult, LiveSnapshot } from "./inputs.ts";
import {
  ROADMAP_SCHEMA,
  type AreaRatio,
  type BoundCheck,
  type BurnPoint,
  type ComputedStatus,
  type DecisionRef,
  type Forecast,
  type Gap,
  type Horizon,
  type InFlight,
  type Participation,
  type Roadmap,
  type RoadmapChange,
  type RoadmapItem,
  type RoadmapMilestone,
} from "./types.ts";

export const ITEMS_DIRECTORY = "docs/trackers/items";

/** What the history replay contributes; absent when the model is built without history. */
export type HistoryFacts = Readonly<{
  /** Every change up to the rendered commit, oldest first. */
  changes: readonly RoadmapChange[];
  burnUp: (milestoneId: string) => readonly BurnPoint[];
  /** Commits/PRs that named an item in an `Item:` trailer, newest first, as display references. */
  trailers: Readonly<Record<string, readonly string[]>>;
  /** Closed-as-completed per ISO week (oldest→newest) and how many weeks of history exist. */
  throughput: Readonly<{ weekly: readonly number[]; weeksOfData: number; asOfWeek: string }>;
}>;

export type RoadmapInputs = Readonly<{
  repository: string;
  commit: string;
  committedAt: string;
  items: readonly TrackerItem[];
  decisions: readonly DecisionRef[];
  claims: readonly Claim[];
  /** The checks snapshot, or `null` when none was given (bound checks then read `unknown`, and the page says so). */
  checks: readonly CheckResult[] | null;
  live: LiveSnapshot | null;
  /** Why there is no live snapshot (shown on the page) when `live` is null. */
  liveReason: string;
  history: HistoryFacts | null;
  /** The critical path of a milestone over the open items (graph.ts). */
  criticalPath: (items: readonly RoadmapItem[], milestoneId: string) => readonly string[];
  /** A milestone forecast from measured throughput (forecast.ts). */
  forecast: (remaining: number, throughput: HistoryFacts["throughput"] | null, seed: string) => Forecast;
}>;

const byId = <T extends { id: string }>(left: T, right: T): number => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
const SEVERITY_RANK: Readonly<Record<string, number>> = { P0: 0, P1: 1, P2: 2, P3: 3 };

function boundCheck(id: string, checks: readonly CheckResult[] | null, commit: string): BoundCheck {
  if (checks === null) return { id, status: "unknown", runUrl: null };
  const found = checks.find((check) => check.id === id);
  if (found === undefined) return { id, status: "not-run", runUrl: null };
  if (found.headSha !== null && found.headSha !== commit) return { id, status: "not-run", runUrl: found.runUrl };
  const status = found.status === "pass" ? "pass" : found.status === "fail" ? "fail" : found.status === "not-run" ? "not-run" : "unknown";
  return { id, status, runUrl: found.runUrl };
}

function inFlightFor(id: string, live: LiveSnapshot | null): readonly InFlight[] {
  if (live === null) return [];
  return live.pulls
    .filter((pull) => pull.items.includes(id))
    .map((pull) => ({ number: pull.number, url: pull.url, title: pull.title, lane: pull.lane, author: pull.author, draft: pull.draft, checks: pull.checks.conclusion, failed: pull.checks.failed }))
    .sort((left, right) => left.number - right.number);
}

function participationFor(id: string, live: LiveSnapshot | null): Participation | null {
  if (live === null) return null;
  const issue = live.issues[id];
  const discussion = live.discussions[id];
  if (issue === undefined && discussion === undefined) return null;
  return {
    issueUrl: issue?.url ?? null,
    reactions: issue === undefined ? 0 : Object.values(issue.reactions).reduce((sum, n) => sum + n, 0),
    discussionUrl: discussion?.url ?? null,
    upvotes: discussion?.upvotes ?? 0,
    comments: discussion?.comments ?? 0,
  };
}

/** The roadmap at one commit. Pure: the same inputs give the same model. */
export function buildRoadmap(inputs: RoadmapInputs): Roadmap {
  const { items, decisions, checks, live, commit } = inputs;
  const itemById = new Map(items.map((item) => [item.id, item]));
  const decisionById = new Map(decisions.map((decision) => [decision.id, decision]));
  const milestoneItems = items.filter((item) => item.type === "Milestone").sort((l, r) => (l.order! - r.order!) || byId(l, r));
  const milestoneOrder = new Map(milestoneItems.map((m) => [m.id, m.order!]));
  const work = items.filter((item) => item.type !== "Milestone");

  // Pass 1: each item's evidence status.
  const statusOf = new Map<string, ComputedStatus>();
  const boundOf = new Map<string, readonly BoundCheck[]>();
  const flightOf = new Map<string, readonly InFlight[]>();
  for (const item of work) {
    const bound = item.checks.map((id) => boundCheck(id, checks, commit));
    boundOf.set(item.id, bound);
    flightOf.set(item.id, inFlightFor(item.id, live));
    if (item.state === "closed") {
      statusOf.set(item.id, item.resolution !== "completed" ? "dropped" : bound.some((c) => c.status === "fail" || c.status === "not-run") ? "retracted" : "done");
    }
  }
  for (const item of work) {
    if (item.state === "closed") continue;
    const openBlockers = item.blockedBy.filter((id) => itemById.get(id)?.state === "open");
    statusOf.set(item.id, flightOf.get(item.id)!.length > 0 ? "in-flight" : openBlockers.length > 0 ? "blocked" : "ready");
  }

  /** Still to do: open, or closed but retracted. An id the tracker does not hold counts as open (the parser refuses one anyway). */
  const isOpen = (id: string): boolean => {
    const status = statusOf.get(id);
    return status !== "done" && status !== "dropped";
  };

  // Pass 2: the items, before horizons (critical paths need statuses).
  const draft: RoadmapItem[] = work.map((item) => {
    const linked = item.decisions.map((id) => decisionById.get(id)).filter((d): d is DecisionRef => d !== undefined);
    return {
      id: item.id,
      title: item.title ?? item.id,
      type: item.type,
      milestone: item.milestone,
      lane: item.lane,
      area: item.area,
      severity: item.severity,
      computedStatus: statusOf.get(item.id)!,
      horizon: "later" as Horizon,
      reason: "",
      blockers: item.blockedBy.filter((id) => itemById.get(id)?.type !== "Milestone"),
      // Milestone membership is the `milestone` field; a parent that is a Milestone item is that, not a dependency.
      parent: item.parent !== null && itemById.get(item.parent)?.type === "Milestone" ? null : item.parent,
      decisions: item.decisions,
      why: linked[0]?.why ?? null,
      tests: item.tests,
      checks: boundOf.get(item.id)!,
      prs: inputs.history?.trailers[item.id] ?? [],
      inFlight: flightOf.get(item.id)!,
      participation: participationFor(item.id, live),
      rfc: item.rfc,
      goodFirst: item.goodFirst,
      opened: item.opened,
      closed: item.closed,
      path: `${ITEMS_DIRECTORY}/${item.id}.md`,
      body: item.body,
    };
  });

  const openMilestones = milestoneItems.filter((m) => draft.some((i) => i.milestone === m.id && isOpen(i.id)));
  const current = openMilestones[0]?.id ?? null;
  // A critical path is a CHAIN: one item alone waits on nothing and is no path (an arbitrary single item would read as "critical").
  const critical = new Map(milestoneItems.map((m) => {
    const path = inputs.criticalPath(draft, m.id);
    return [m.id, path.length >= 2 ? path : []] as const;
  }));
  const onCriticalPath = new Set([...critical.values()].flat());

  const placed: RoadmapItem[] = draft.map((item) => {
    const where = item.milestone === null ? "it is in no milestone yet" : `it belongs to ${item.milestone}`;
    let horizon: Horizon;
    let reason: string;
    switch (item.computedStatus) {
      case "done":
        horizon = "done";
        reason = item.checks.length === 0 ? "Closed; no check is bound to it yet." : `Closed; ${item.checks.map((c) => c.id).join(", ")} ${item.checks.some((c) => c.status === "unknown") ? "not reported in this build" : "passed on this commit"}.`;
        break;
      case "dropped":
        horizon = "done";
        reason = "Closed without doing it (not planned or a duplicate).";
        break;
      case "retracted": {
        const red = item.checks.filter((c) => c.status === "fail" || c.status === "not-run").map((c) => `${c.id} (${c.status === "fail" ? "red" : "not run on this commit"})`);
        horizon = "now";
        reason = `Closed, but ${red.join(", ")}: retracted until it passes again.`;
        break;
      }
      case "in-flight":
        horizon = "now";
        reason = `Pull request ${item.inFlight.map((p) => `#${p.number}`).join(", ")} is open for it.`;
        break;
      case "blocked": {
        const open = item.blockers.filter((id) => isOpen(id));
        horizon = "later";
        reason = `Waiting on ${open.join(", ")}.`;
        break;
      }
      case "ready": {
        const urgent = item.severity === "P0" || item.severity === "P1";
        const unblocks = draft.filter((other) => isOpen(other.id) && (other.severity === "P0" || other.severity === "P1") && other.blockers.includes(item.id));
        const critic = onCriticalPath.has(item.id);
        const inCurrent = current !== null && item.milestone === current;
        horizon = urgent || unblocks.length > 0 || critic || inCurrent ? "next" : "later";
        reason = urgent
          ? `Nothing blocks it and it is ${item.severity}.`
          : unblocks.length > 0
            ? `Nothing blocks it and it unblocks ${unblocks.map((other) => `${other.id} (${other.severity})`).join(", ")}.`
            : critic
            ? `Nothing blocks it and it is on the critical path of ${[...critical.entries()].filter(([, path]) => path.includes(item.id)).map(([m]) => m).join(", ")}.`
            : inCurrent
              ? `Nothing blocks it and ${current} is the earliest open milestone.`
              : `Nothing blocks it, but ${where}, after ${current ?? "the open milestones"}.`;
        break;
      }
    }
    return { ...item, horizon, reason };
  });

  const order = (item: RoadmapItem): [number, number, number, string] => [
    item.milestone === null ? Number.MAX_SAFE_INTEGER : milestoneOrder.get(item.milestone) ?? Number.MAX_SAFE_INTEGER,
    onCriticalPath.has(item.id) ? 0 : 1,
    SEVERITY_RANK[item.severity ?? ""] ?? 9,
    item.id,
  ];
  placed.sort((left, right) => {
    const a = order(left);
    const b = order(right);
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
    return 0;
  });

  const milestones: RoadmapMilestone[] = milestoneItems.map((m) => {
    const own = placed.filter((item) => item.milestone === m.id && item.computedStatus !== "dropped");
    const done = own.filter((item) => item.computedStatus === "done").length;
    const retracted = own.filter((item) => item.computedStatus === "retracted").length;
    const moving = own.some((item) => item.computedStatus === "in-flight");
    const remaining = own.length - done;
    const linked = m.decisions.map((id) => decisionById.get(id)).find((d) => d !== undefined);
    return {
      id: m.id,
      title: m.title ?? m.id,
      order: m.order!,
      state: own.length > 0 && remaining === 0 ? "shipped" : done > 0 || retracted > 0 || moving ? "in progress" : "not started",
      progress: { done, retracted, total: own.length },
      forecast: remaining === 0 && own.length > 0 ? { kind: "complete" } : inputs.forecast(remaining, inputs.history?.throughput ?? null, `${commit}:${m.id}`),
      criticalPath: critical.get(m.id) ?? [],
      burnUp: inputs.history?.burnUp(m.id) ?? [],
      why: linked?.why ?? (m.body.split(/\n\s*\n/u)[0] ?? "").replace(/\*\*/gu, "").trim(),
      path: `${ITEMS_DIRECTORY}/${m.id}.md`,
    };
  });

  const groups = [...new Set(decisions.map((d) => d.group))].sort();
  const areas: AreaRatio[] = groups.map((group) => {
    const inForce = decisions.filter((d) => d.group === group && d.status === "in-force");
    const count = (implementation: DecisionRef["implementation"]): number => inForce.filter((d) => d.implementation === implementation).length;
    return { group, done: count("done"), partial: count("partial"), pending: count("pending"), standing: count("standing") };
  });

  const gaps: Gap[] = inputs.claims.flatMap((claim) => (claim.kind === "not-claimed" ? [{ statement: claim.text, reason: claim.reason, evidence: claim.evidence }] : []));
  // The week before the rendered commit, from its own time (history is what says what changed; no history, no week).
  const thisWeek = inputs.history === null ? [] : (() => {
    const weekAgo = new Date(Date.parse(inputs.committedAt) - 7 * 24 * 3600 * 1000).toISOString();
    return inputs.history.changes.filter((change) => change.date > weekAgo).slice().reverse();
  })();

  return Object.freeze({
    schema: ROADMAP_SCHEMA,
    repository: inputs.repository,
    commit,
    generatedAt: inputs.committedAt,
    live: { available: live !== null, generatedAt: live?.generatedAt ?? null, reason: live === null ? inputs.liveReason : null },
    milestones,
    items: placed,
    decisions: decisions.slice().sort(byId),
    areas,
    risks: placed.filter((item) => item.type === "Risk" && item.computedStatus !== "done" && item.computedStatus !== "dropped"),
    gaps,
    thisWeek,
  });
}
