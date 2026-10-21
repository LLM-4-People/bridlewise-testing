/**
 * THE ROADMAP'S DATA MODEL — the one shape every roadmap surface is rendered
 * from (the page, the print one-pager, the README block, the Atom feed,
 * `roadmap.json` for the projector's milestones and Project view).
 *
 * Every field is computed from the repository's own records: the tracker
 * items (`docs/trackers/items/`, the tracker's one parser), the decision
 * records (`docs/decisions/`), git history, a checks snapshot and an
 * optional live snapshot. Nothing here is typed by hand, and no field is a
 * promised date.
 */

/** A schema id this module writes or reads. */
export const ROADMAP_SCHEMA = "bridlewise-roadmap/v1";
export const ROADMAP_HISTORY_SCHEMA = "bridlewise-roadmap-history/v1";
export const ROADMAP_LIVE_SCHEMA = "bridlewise-roadmap-live/v1";

/**
 * What an item's evidence says right now:
 * - `done`: closed as completed, and every bound check passes at this commit;
 * - `retracted`: closed as completed, but a bound check is red or did not run
 *   on this commit (shown struck through, publicly, until it passes again);
 * - `in-flight`: open, with an open pull request naming it;
 * - `ready`: open, nothing open blocks it;
 * - `blocked`: open, another open item blocks it;
 * - `dropped`: closed as not planned or duplicate.
 */
export type ComputedStatus = "done" | "retracted" | "in-flight" | "ready" | "blocked" | "dropped";

/** The three lanes of the summary, computed (never a field anyone types). */
export type Horizon = "now" | "next" | "later" | "done";

/** One check bound to an item, as the checks snapshot reports it at the rendered commit. */
export type BoundCheck = Readonly<{
  id: string;
  /** `pass` only when the check passed on exactly the rendered commit. */
  status: "pass" | "fail" | "not-run" | "unknown";
  runUrl: string | null;
}>;

/** One open pull request that names an item (live snapshot). */
export type InFlight = Readonly<{
  number: number;
  url: string;
  title: string;
  lane: string | null;
  author: string | null;
  draft: boolean;
  checks: "success" | "failure" | "pending" | "none";
  failed: readonly string[];
}>;

/** Participation signals for one item (live snapshot): shown, never used to order. */
export type Participation = Readonly<{
  issueUrl: string | null;
  reactions: number;
  discussionUrl: string | null;
  upvotes: number;
  comments: number;
}>;

/** A decision record, as far as the roadmap reads it. */
export type DecisionRef = Readonly<{
  id: string;
  title: string;
  group: string;
  status: "in-force" | "superseded";
  implementation: "standing" | "pending" | "partial" | "done";
  by: "user" | "coordinator";
  /** The record's first paragraph after its title: the plain-language why. */
  why: string;
  path: string;
}>;

export type RoadmapItem = Readonly<{
  id: string;
  title: string;
  type: string;
  milestone: string | null;
  lane: string;
  area: readonly string[];
  severity: string | null;
  computedStatus: ComputedStatus;
  horizon: Horizon;
  /** Why the item sits in its horizon, in one plain sentence. */
  reason: string;
  blockers: readonly string[];
  parent: string | null;
  decisions: readonly string[];
  /** The why, from the first linked decision; `null` when no decision is linked yet (a visible gap). */
  why: string | null;
  tests: readonly string[];
  checks: readonly BoundCheck[];
  /** Pull requests and commits that carried an `Item: <id>` trailer (from history), newest first. */
  prs: readonly string[];
  inFlight: readonly InFlight[];
  participation: Participation | null;
  rfc: string | null;
  goodFirst: boolean;
  opened: string;
  closed: string | null;
  path: string;
  body: string;
}>;

/** A forecast is a measured band or an honest unknown; never a promise. */
export type Forecast =
  | Readonly<{ kind: "band"; remaining: number; p50Weeks: number; p85Weeks: number; p50Week: string; p85Week: string; weeksOfData: number; method: string }>
  | Readonly<{ kind: "unknown"; remaining: number; reason: string; weeksOfData: number; method: string }>
  | Readonly<{ kind: "complete" }>;

/** One point of a burn-up: the milestone's scope and its done count at a commit. */
export type BurnPoint = Readonly<{ commit: string; date: string; scope: number; done: number }>;

export type RoadmapMilestone = Readonly<{
  id: string;
  title: string;
  order: number;
  /** `shipped` only when every item is done and none is retracted. */
  state: "shipped" | "in progress" | "not started";
  progress: Readonly<{ done: number; retracted: number; total: number }>;
  forecast: Forecast;
  /** The longest chain of open items (through blockers) to finish the milestone, first to last. */
  criticalPath: readonly string[];
  burnUp: readonly BurnPoint[];
  why: string | null;
  path: string;
}>;

/** Designed-vs-built for one decision group. */
export type AreaRatio = Readonly<{ group: string; done: number; partial: number; pending: number; standing: number }>;

/** A claim the project explicitly does not make, with the reason. */
export type Gap = Readonly<{ statement: string; reason: string; evidence: string | null }>;

/** A change between two versions of the roadmap. */
export type RoadmapChange = Readonly<{
  commit: string;
  date: string;
  item: string;
  kind: "added" | "closed" | "reopened" | "retitled" | "moved" | "blocked" | "unblocked" | "removed";
  detail: string;
}>;

export type Roadmap = Readonly<{
  schema: typeof ROADMAP_SCHEMA;
  repository: string;
  commit: string;
  /** The rendered commit's own time: never the clock, so a render is reproducible. */
  generatedAt: string;
  live: Readonly<{ available: boolean; generatedAt: string | null; reason: string | null }>;
  milestones: readonly RoadmapMilestone[];
  items: readonly RoadmapItem[];
  decisions: readonly DecisionRef[];
  areas: readonly AreaRatio[];
  risks: readonly RoadmapItem[];
  gaps: readonly Gap[];
  /** Changes in the 7 days before the rendered commit, newest first. */
  thisWeek: readonly RoadmapChange[];
}>;
