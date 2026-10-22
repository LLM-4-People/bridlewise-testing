/**
 * THE ROADMAP STATE (src/workflow/tracker-status.ts): computed from an item's
 * evidence, never typed — closed (shipped / not planned), blocked by what is
 * not shipped, in progress when a sub-item landed or a decision it carries out
 * is built, otherwise planned; a Milestone's state is its members'; every
 * state says why.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { decisionProgress, itemStatuses as statusesWith, type StatusDecision, type StatusItem } from "../../src/workflow/tracker-status.ts";

const item = (id: string, fields: Partial<StatusItem> = {}): StatusItem => ({
  id, type: "Task", state: "open", resolution: null, parent: null, milestone: null, blockedBy: [], decisions: [], tests: [], evidence: null, ...fields,
});
/** A close PROVEN (its tests exist), so it is shipped. */
const shipped = (id: string, fields: Partial<StatusItem> = {}): StatusItem => item(id, { state: "closed", resolution: "completed", tests: [`tests/${id}.test.ts`], ...fields });
/** A close with nothing linked: a claim. */
const claimed = (id: string, fields: Partial<StatusItem> = {}): StatusItem => item(id, { state: "closed", resolution: "completed", ...fields });
const itemStatuses = (items: readonly StatusItem[], decisions: readonly StatusDecision[]) => statusesWith(items, { decisions, recordedEvidence: new Set(), repositoryUrl: "https://github.com/owner/repo" });

test("a closed item is shipped or not planned; an open one with nothing landed is planned", () => {
  const states = itemStatuses([shipped("A"), item("B", { state: "closed", resolution: "not-planned" }), item("C", { state: "closed", resolution: "duplicate" }), item("D")], []);
  assert.deepEqual([...states.entries()].map(([id, status]) => [id, status.state, status.because]), [
    ["A", "shipped", "proven by tests tests/A.test.ts"],
    ["B", "not planned", "closed as not-planned"],
    ["C", "not planned", "closed as duplicate"],
    ["D", "planned", "nothing of it has landed"],
  ]);
});

test("a close with no linked proof is claimed, never shipped; a claim is no progress for a parent and unblocks nothing", () => {
  const states = itemStatuses([claimed("C"), item("W", { blockedBy: ["C"] }), item("P"), claimed("K", { parent: "P" })], []);
  assert.deepEqual(states.get("C"), { state: "claimed", because: "closed as completed; no linked evidence proves it" });
  assert.deepEqual(states.get("W"), { state: "blocked", because: "blocked by C" });
  assert.equal(states.get("P")?.state, "planned");
  const milestone = item("M1", { type: "Milestone", state: null });
  assert.equal(itemStatuses([milestone, { ...claimed("A"), milestone: "M1" }, { ...shipped("B"), milestone: "M1" }], []).get("M1")?.state, "claimed", "every member closed, one only claimed");
});

test("blocked while a blocker is not shipped, whatever else landed; free once it ships", () => {
  const blocked = itemStatuses([item("W", { blockedBy: ["B"] }), item("B"), shipped("CHILD", { parent: "W" })], []);
  assert.deepEqual(blocked.get("W"), { state: "blocked", because: "blocked by B" });
  const free = itemStatuses([item("W", { blockedBy: ["B"] }), shipped("B"), shipped("CHILD", { parent: "W" })], []);
  assert.deepEqual(free.get("W"), { state: "in progress", because: "CHILD shipped" });
});

test("in progress when a sub-item landed (transitively) or a decision it carries out is built or partly built", () => {
  const nested = itemStatuses([item("W"), item("T", { parent: "W" }), shipped("S", { parent: "T" })], []);
  assert.deepEqual(nested.get("W"), { state: "in progress", because: "T in progress" });
  const decisions = [{ id: "D-1", status: "in-force", implementation: "partial" }, { id: "D-2", status: "in-force", implementation: "pending" }];
  assert.deepEqual(itemStatuses([item("W", { decisions: ["D-1", "D-2"] })], decisions).get("W"), { state: "in progress", because: "decision D-1 partly built" });
  assert.equal(itemStatuses([item("W", { decisions: ["D-2"] })], decisions).get("W")?.state, "planned", "a designed decision is not progress");
});

test("a Milestone's state is its members': shipped when all planned members shipped, in progress when any landed, blocked when all are", () => {
  const milestone = item("M1", { type: "Milestone", state: null });
  const of = (...members: StatusItem[]) => itemStatuses([milestone, ...members.map((member) => ({ ...member, milestone: "M1" }))], []).get("M1");
  assert.deepEqual(of(), { state: "planned", because: "no member yet" });
  assert.deepEqual(of(shipped("A"), item("NP", { state: "closed", resolution: "not-planned" })), { state: "shipped", because: "all 1 members shipped" });
  assert.equal(of(shipped("A"), item("B"))?.state, "in progress");
  assert.match(of(shipped("A"), item("B"))!.because, /1 of 2 members shipped/u);
  assert.equal(of(item("A", { blockedBy: ["X"] }), item("X"))?.state, "planned", "one blocked member beside a planned one: the milestone is planned");
  assert.equal(of(item("A", { blockedBy: ["Z"] }))?.state, "blocked");
});

test("a decision's progress reads its own front matter", () => {
  assert.deepEqual(["done", "partial", "pending", "standing"].map((implementation) => decisionProgress({ id: "D", status: "in-force", implementation })), ["built", "partly built", "designed", "standing"]);
  assert.equal(decisionProgress({ id: "D", status: "superseded", implementation: "done" }), "superseded");
});
