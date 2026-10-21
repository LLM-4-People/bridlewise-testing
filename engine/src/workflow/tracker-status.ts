/**
 * THE ROADMAP STATE OF A TRACKER ITEM — computed from evidence, never typed.
 *
 * An item's file records facts: open or closed (and how), what it blocks on,
 * its parent, its milestone, the decisions it carries out. Its roadmap state
 * is DERIVED from them, here, once, with the reason it holds:
 *
 *   - `shipped`: closed as completed;
 *   - `not planned`: closed as not planned or as a duplicate;
 *   - `blocked`: open, and something it is blocked by is not shipped;
 *   - `in progress`: open, and part of it has landed — a sub-item shipped or
 *     in progress, or a decision it carries out built or partly built;
 *   - `planned`: open, and none of the above.
 * A Milestone's state is its members': `shipped` when every member that is
 * planned at all shipped, `in progress` when any member shipped or is in
 * progress, `blocked` when every open member is blocked, else `planned`.
 *
 * A decision record's progress reads its own front matter: `superseded`,
 * `built` (done), `partly built` (partial), `designed` (pending) or
 * `standing` (a rule that binds all work and is never "done").
 *
 * PURE: no import, no I/O, no clock. The roadmap page
 * (scripts/floor/roadmap-status.ts), the roadmap data feed and the GitHub
 * projector's sealed realm (src/workflow/forge/projector/) all read states
 * from this one function.
 */

export const ROADMAP_STATES = Object.freeze(["shipped", "in progress", "planned", "blocked", "not planned"] as const);
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
}>;

export type StatusDecision = Readonly<{ id: string; status: string; implementation: string }>;

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

/** Every item's computed state (Milestones included), by id. */
export function itemStatuses(items: readonly StatusItem[], decisions: readonly StatusDecision[]): ReadonlyMap<string, ItemStatus> {
  const byId = new Map(items.map((item) => [item.id, item]));
  const decisionById = new Map(decisions.map((decision) => [decision.id, decision]));
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
      return item.resolution === "completed"
        ? { state: "shipped", because: "closed as completed" }
        : { state: "not planned", because: `closed as ${item.resolution ?? "not planned"}` };
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
    const tally = `${String(shipped)} of ${String(planned.length)} members shipped, ${String(count("in progress"))} in progress, ${String(count("blocked"))} blocked`;
    if (shipped > 0 || count("in progress") > 0) return { state: "in progress", because: tally };
    if (count("blocked") === planned.length) return { state: "blocked", because: tally };
    return { state: "planned", because: tally };
  };
  for (const item of items) statusOf(item.id);
  return computed;
}
