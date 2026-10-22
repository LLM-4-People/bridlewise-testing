/**
 * THE ROADMAP STATE OF A TRACKER ITEM — computed from evidence.
 *
 * An item's file records facts: open or closed (and how), what it blocks on,
 * its parent, its milestone, the decisions it carries out, its tests, its
 * evidence. A close is a CLAIM the file types; whether it SHIPPED is proven
 * by linked evidence or it is not ({@link closeProof}). The roadmap state is
 * DERIVED here, once, with the reason it holds:
 *
 *   - `shipped`: closed as completed AND proven — a decision it carries out
 *     is built (`done`), its `tests` exist (judged by the item format), its
 *     `evidence:` record is recorded in a tracked evidence manifest, or its
 *     evidence is THIS repository's own pull request, run or release;
 *   - `claimed`: closed as completed with no linked evidence proving it —
 *     shown as an unverified claim, never as shipped;
 *   - `not planned`: closed as not planned or as a duplicate;
 *   - `blocked`: open, and something it is blocked by has not shipped;
 *   - `in progress`: open, and part of it has PROVABLY landed — a sub-item
 *     shipped or in progress, or a decision it carries out built or partly
 *     built (a claimed sub-item is no proof);
 *   - `planned`: open, and none of the above.
 * A Milestone's state is its members': `shipped` when every member that is
 * planned at all shipped; `claimed` when every one is closed but some only
 * claimed; `in progress` when any member shipped or is in progress;
 * `blocked` when every open member is blocked; else `planned`.
 *
 * A decision record's progress reads its own front matter: `superseded`,
 * `built` (done), `partly built` (partial), `designed` (pending) or
 * `standing` (a rule that binds all work and is never "done").
 *
 * PURE: no import, no I/O, no clock. The roadmap data feed and the GitHub
 * projector's sealed realm (src/workflow/forge/projector/) read states from
 * this one function; the roadmap page (engine/scripts/roadmap/) renders the
 * feed and computes none.
 */

export const ROADMAP_STATES = Object.freeze(["shipped", "claimed", "in progress", "planned", "blocked", "not planned"] as const);
export type RoadmapState = typeof ROADMAP_STATES[number];

export type DecisionProgress = "superseded" | "built" | "partly built" | "designed" | "standing";

/** The facts the state is computed from (a tracker item's, src/workflow/failure-owners.ts `TrackerItem`). */
export type StatusItem = Readonly<{
  id: string;
  type: string;
  state: "open" | "closed" | null;
  resolution: "completed" | "not-planned" | "duplicate" | null;
  parent: string | null;
  milestone: string | null;
  blockedBy: readonly string[];
  decisions: readonly string[];
  tests: readonly string[];
  evidence: string | null;
}>;

export type StatusDecision = Readonly<{ id: string; status: string; implementation: string }>;

/** What a close is proven against: the decision records, the evidence paths recorded in tracked manifests, and this repository's URL. */
export type StatusFacts = Readonly<{
  decisions: readonly StatusDecision[];
  recordedEvidence: ReadonlySet<string>;
  /** `https://github.com/<owner>/<repo>`: only its own pull requests, runs and releases are evidence. */
  repositoryUrl: string;
}>;

/** An item's computed state and the evidence it rests on, in words. */
export type ItemStatus = Readonly<{ state: RoadmapState; because: string }>;

/** How far a decision record is carried out, from its own front matter. */
export function decisionProgress(decision: StatusDecision): DecisionProgress {
  if (decision.status === "superseded") return "superseded";
  if (decision.implementation === "done") return "built";
  if (decision.implementation === "partial") return "partly built";
  if (decision.implementation === "standing") return "standing";
  return "designed";
}

/**
 * What proves `item`'s close, in words, or `null` when nothing linked does:
 * a decision it carries out that is built, its tests (whose existence the
 * item format judges), its `evidence:` record when a tracked manifest records
 * it, or evidence that is this repository's own pull request, run or release.
 * A documentation anchor or any other URL proves nothing.
 */
function closeProof(item: StatusItem, facts: StatusFacts): string | null {
  const built = item.decisions.filter((id) => facts.decisions.some((decision) => decision.id === id && decisionProgress(decision) === "built"));
  if (built.length > 0) return `decision ${built.join(", ")} built`;
  if (item.tests.length > 0) return `tests ${item.tests.join(", ")}`;
  const evidence = item.evidence;
  if (evidence === null) return null;
  if (evidence.startsWith("evidence:") && facts.recordedEvidence.has(evidence.slice("evidence:".length))) return `evidence ${evidence} recorded`;
  const prefix = `${facts.repositoryUrl}/`;
  if (!evidence.startsWith(prefix)) return null;
  const own = /^(?:pull\/[1-9]\d*|actions\/runs\/[1-9]\d*|releases\/tag\/[^/\s]+)$/u.exec(evidence.slice(prefix.length));
  if (own === null) return null;
  const kind = own[0].startsWith("pull/") ? "pull request" : own[0].startsWith("actions/") ? "run" : "release";
  return `this repository's ${kind} ${evidence}`;
}

/** Every item's computed state (Milestones included), by id. */
export function itemStatuses(items: readonly StatusItem[], facts: StatusFacts): ReadonlyMap<string, ItemStatus> {
  const byId = new Map(items.map((item) => [item.id, item]));
  const decisionById = new Map(facts.decisions.map((decision) => [decision.id, decision]));
  const children = new Map<string, StatusItem[]>();
  const members = new Map<string, StatusItem[]>();
  for (const item of items) {
    if (item.parent !== null) children.set(item.parent, [...(children.get(item.parent) ?? []), item]);
    if (item.milestone !== null) members.set(item.milestone, [...(members.get(item.milestone) ?? []), item]);
  }
  const computed = new Map<string, ItemStatus>();
  const inFlight = new Set<string>();
  const statusOf = (id: string): ItemStatus => {
    const known = computed.get(id);
    if (known !== undefined) return known;
    const item = byId.get(id);
    // A cycle or a dangling name is refused by the item format; answered conservatively if it is ever reached.
    if (item === undefined || inFlight.has(id)) return { state: "planned", because: `${id} is not judged` };
    inFlight.add(id);
    const status = item.type === "Milestone" ? milestoneStatus(item) : workStatus(item);
    inFlight.delete(id);
    computed.set(id, status);
    return status;
  };
  const workStatus = (item: StatusItem): ItemStatus => {
    if (item.state === "closed") {
      if (item.resolution !== "completed") return { state: "not planned", because: `closed as ${item.resolution ?? "not planned"}` };
      const proof = closeProof(item, facts);
      return proof === null
        ? { state: "claimed", because: "closed as completed; no linked evidence proves it" }
        : { state: "shipped", because: `proven by ${proof}` };
    }
    const blockers = item.blockedBy.filter((blocker) => statusOf(blocker).state !== "shipped");
    if (blockers.length > 0) return { state: "blocked", because: `blocked by ${blockers.join(", ")}` };
    const landed = (children.get(item.id) ?? []).filter((child) => ["shipped", "in progress"].includes(statusOf(child.id).state));
    if (landed.length > 0) return { state: "in progress", because: `${landed.map((child) => `${child.id} ${statusOf(child.id).state}`).join(", ")}` };
    const built = item.decisions.flatMap((id) => {
      const decision = decisionById.get(id);
      const progress = decision === undefined ? null : decisionProgress(decision);
      return progress === "built" || progress === "partly built" ? [`decision ${id} ${progress}`] : [];
    });
    if (built.length > 0) return { state: "in progress", because: built.join(", ") };
    return { state: "planned", because: "nothing of it has landed" };
  };
  const milestoneStatus = (milestone: StatusItem): ItemStatus => {
    const planned = (members.get(milestone.id) ?? []).map((member) => ({ member, status: statusOf(member.id) })).filter(({ status }) => status.state !== "not planned");
    if (planned.length === 0) return { state: "planned", because: "no member yet" };
    const count = (state: RoadmapState): number => planned.filter(({ status }) => status.state === state).length;
    const shipped = count("shipped");
    if (shipped === planned.length) return { state: "shipped", because: `all ${String(shipped)} members shipped` };
    const tally = `${String(shipped)} of ${String(planned.length)} members shipped, ${String(count("claimed"))} claimed, ${String(count("in progress"))} in progress, ${String(count("blocked"))} blocked`;
    if (shipped + count("claimed") === planned.length) return { state: "claimed", because: tally };
    if (shipped > 0 || count("in progress") > 0) return { state: "in progress", because: tally };
    if (count("blocked") === planned.length) return { state: "blocked", because: tally };
    return { state: "planned", because: tally };
  };
  for (const item of items) statusOf(item.id);
  return computed;
}
