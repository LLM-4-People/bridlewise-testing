/**
 * THE ROADMAP MODEL (scripts/roadmap/model.ts): status computed from evidence
 * (a closed item is done only while its bound checks passed on the rendered
 * commit; otherwise retracted), Now/Next/Later computed with a reason each,
 * milestone progress and state, designed-vs-built by area, the gaps from the
 * claims register, and purity (the same inputs give the same model).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { trackerItems, type TrackerItem } from "../../src/workflow/failure-owners.ts";
import type { Claim } from "../../scripts/brand/claims.ts";
import { forecast } from "../../scripts/roadmap/forecast.ts";
import { criticalPath, dependencyGraph } from "../../scripts/roadmap/graph.ts";
import type { CheckResult, LiveSnapshot } from "../../scripts/roadmap/inputs.ts";
import { buildRoadmap, type RoadmapInputs } from "../../scripts/roadmap/model.ts";
import type { DecisionRef } from "../../scripts/roadmap/types.ts";

const COMMIT = "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00";

const entry = (id: string, fields: Record<string, string>, body = "The outcome."): { name: string; text: string } => ({
  name: `${id}.md`,
  text: `---\n${Object.entries({ schema: "bridlewise-tracker-item/v1", id, type: "Task", state: "open", lane: "floor", opened: "2026-10-01", ...fields })
    .map(([name, value]) => `${name}: ${value}`).join("\n")}\n---\n\n${body}\n`,
});
const closed = { state: "closed", resolution: "completed", closed: "2026-10-10" };

const ITEMS: readonly TrackerItem[] = trackerItems([
  entry("M1", { type: "Milestone", title: "First", order: "1" }, "**Problem:** the first thing."),
  entry("M2", { type: "Milestone", title: "Second", order: "2" }, "The second thing."),
  entry("A-DONE", { ...closed, milestone: "M1", checks: "[testing.ci]", decisions: "[UR-17]" }),
  entry("B-RED", { ...closed, milestone: "M1", checks: "[testing.ci, testing.codeql]" }),
  entry("C-STALE", { ...closed, milestone: "M1", checks: "[testing.docs]" }),
  entry("D-READY", { milestone: "M1", title: "Ready one" }),
  entry("E-BLOCKED", { milestone: "M1", "blocked-by": "[D-READY]" }),
  entry("F-FLIGHT", { milestone: "M2" }),
  entry("G-LATER", { milestone: "M2" }),
  entry("H-URGENT", { milestone: "M2", severity: "P1" }),
  entry("I-DROPPED", { state: "closed", resolution: "not-planned", closed: "2026-10-10", milestone: "M2" }),
  entry("J-LOOSE", {}),
  entry("K-RISK", { type: "Risk", severity: "P0", "blocked-by": "[J-LOOSE]" }),
]);

const DECISIONS: readonly DecisionRef[] = [
  { id: "UR-17", title: "No fallbacks", group: "user-rules", status: "in-force", implementation: "standing", by: "user", why: "A missing capability is a loud failure.", path: "docs/decisions/UR-17-no-fallbacks.md" },
  { id: "D-1", title: "Built", group: "engine", status: "in-force", implementation: "done", by: "coordinator", why: "x", path: "docs/decisions/D-1.md" },
  { id: "D-2", title: "Designed", group: "engine", status: "in-force", implementation: "pending", by: "coordinator", why: "y", path: "docs/decisions/D-2.md" },
  { id: "D-3", title: "Gone", group: "engine", status: "superseded", implementation: "pending", by: "coordinator", why: "z", path: "docs/decisions/D-3.md" },
];

const CLAIMS: readonly Claim[] = [{ id: "release-dates", kind: "not-claimed", text: "A release date", reason: "Intent, not a schedule.", evidence: null }];

const CHECKS: readonly CheckResult[] = [
  { id: "testing.ci", status: "pass", headSha: COMMIT, runUrl: "https://example.test/run/1" },
  { id: "testing.codeql", status: "fail", headSha: COMMIT, runUrl: "https://example.test/run/2" },
  { id: "testing.docs", status: "pass", headSha: "0000000000000000000000000000000000000000", runUrl: "https://example.test/run/3" },
];

const LIVE: LiveSnapshot = {
  generatedAt: "2026-10-21T10:00:00Z",
  commit: COMMIT,
  pulls: [{ number: 62, url: "https://example.test/pull/62", title: "Do F", branch: "gh/f", lane: "gh-5", author: "a", draft: false, items: ["F-FLIGHT"], headSha: "x", checks: { conclusion: "failure", failed: ["web"], pending: [] } }],
  issues: { "G-LATER": { number: 9, url: "https://example.test/issues/9", reactions: { "+1": 3, heart: 1 } } },
  discussions: {},
};

const inputs = (overrides: Partial<RoadmapInputs> = {}): RoadmapInputs => ({
  repository: "https://github.com/o/r",
  commit: COMMIT,
  committedAt: "2026-10-21T12:00:00Z",
  items: ITEMS,
  decisions: DECISIONS,
  claims: CLAIMS,
  checks: CHECKS,
  live: LIVE,
  liveReason: "",
  history: null,
  criticalPath: (items, milestone) => criticalPath(dependencyGraph(items), milestone),
  forecast: (remaining, throughput, seed) => forecast({ remaining, weekly: [...(throughput?.weekly ?? [])], weeksOfData: throughput?.weeksOfData ?? 0, seed, asOfWeek: throughput?.asOfWeek ?? "2026-W43" }),
  ...overrides,
});

const byId = (model: ReturnType<typeof buildRoadmap>, id: string) => model.items.find((item) => item.id === id)!;

test("a closed item is done only while every bound check passed on this commit; otherwise it is retracted, under Now", () => {
  const model = buildRoadmap(inputs());
  assert.equal(byId(model, "A-DONE").computedStatus, "done");
  assert.equal(byId(model, "A-DONE").horizon, "done");
  assert.equal(byId(model, "B-RED").computedStatus, "retracted");
  assert.equal(byId(model, "B-RED").horizon, "now");
  assert.match(byId(model, "B-RED").reason, /testing\.codeql \(red\)/u);
  assert.equal(byId(model, "C-STALE").computedStatus, "retracted", "a check that passed on another commit did not run on this one");
  assert.match(byId(model, "C-STALE").reason, /not run on this commit/u);
  assert.equal(byId(model, "I-DROPPED").computedStatus, "dropped");
});

test("without a checks snapshot a bound check reads unknown and nothing is retracted by absence", () => {
  const model = buildRoadmap(inputs({ checks: null }));
  assert.equal(byId(model, "B-RED").computedStatus, "done");
  assert.deepEqual(byId(model, "B-RED").checks.map((c) => c.status), ["unknown", "unknown"]);
  assert.match(byId(model, "B-RED").reason, /not reported in this build/u);
});

test("open items: in flight from the live snapshot, blocked while an open item blocks, ready otherwise", () => {
  const model = buildRoadmap(inputs());
  const flight = byId(model, "F-FLIGHT");
  assert.equal(flight.computedStatus, "in-flight");
  assert.equal(flight.horizon, "now");
  assert.deepEqual(flight.inFlight.map((p) => [p.number, p.checks, p.failed]), [[62, "failure", ["web"]]]);
  assert.equal(byId(model, "E-BLOCKED").computedStatus, "blocked");
  assert.match(byId(model, "E-BLOCKED").reason, /Waiting on D-READY/u);
  assert.equal(byId(model, "D-READY").computedStatus, "ready");
  const without = buildRoadmap(inputs({ live: null, liveReason: "no snapshot at build" }));
  assert.equal(byId(without, "F-FLIGHT").computedStatus, "ready");
  assert.deepEqual(without.live, { available: false, generatedAt: null, reason: "no snapshot at build" });
});

test("next is the earliest open milestone's ready work, P0/P1 and critical paths; later says why", () => {
  const model = buildRoadmap(inputs());
  assert.equal(byId(model, "D-READY").horizon, "next");
  assert.match(byId(model, "D-READY").reason, /M1 is the earliest open milestone|critical path/u);
  assert.equal(byId(model, "H-URGENT").horizon, "next");
  assert.match(byId(model, "H-URGENT").reason, /it is P1/u);
  assert.equal(byId(model, "G-LATER").horizon, "later");
  assert.match(byId(model, "G-LATER").reason, /belongs to M2, after M1/u);
  assert.equal(byId(model, "J-LOOSE").horizon, "next", "loose work that unblocks a P0 item is next");
  assert.match(byId(model, "J-LOOSE").reason, /it unblocks K-RISK \(P0\)/u);
  const calm = buildRoadmap(inputs({ items: ITEMS.filter((i) => i.id !== "K-RISK") }));
  assert.equal(byId(calm, "J-LOOSE").horizon, "later");
  assert.match(byId(calm, "J-LOOSE").reason, /it is in no milestone yet/u);
});

test("milestones: progress counts done and retracted, state is computed, the why comes from the body", () => {
  const model = buildRoadmap(inputs());
  const [m1, m2] = model.milestones;
  assert.deepEqual(m1!.progress, { done: 1, retracted: 2, total: 5 });
  assert.equal(m1!.state, "in progress");
  assert.equal(m1!.why, "Problem: the first thing.");
  assert.deepEqual(m2!.progress, { done: 0, retracted: 0, total: 3 }, "a dropped item leaves the scope");
  assert.equal(m2!.state, "in progress", "an in-flight item starts a milestone");
  assert.equal(m1!.forecast.kind, "unknown", "no history, no forecast");
  assert.deepEqual(m1!.criticalPath, ["D-READY", "E-BLOCKED"]);
  assert.deepEqual(m2!.criticalPath, [], "a lone item is no chain: M2 has no critical path");
});

test("areas count in-force decisions only; gaps come from the claims register; risks are open Risk items", () => {
  const model = buildRoadmap(inputs());
  assert.deepEqual(model.areas, [
    { group: "engine", done: 1, partial: 0, pending: 1, standing: 0 },
    { group: "user-rules", done: 0, partial: 0, pending: 0, standing: 1 },
  ]);
  assert.deepEqual(model.gaps, [{ statement: "A release date", reason: "Intent, not a schedule.", evidence: null }]);
  assert.deepEqual(model.risks.map((r) => r.id), ["K-RISK"]);
  assert.equal(byId(model, "A-DONE").why, "A missing capability is a loud failure.");
  assert.equal(byId(model, "D-READY").why, null, "no decision linked is a visible gap, never a guess");
  assert.equal(byId(model, "G-LATER").participation?.reactions, 4);
});

test("the model is pure: the same inputs give the same model, and no clock is read", () => {
  assert.deepEqual(buildRoadmap(inputs()), buildRoadmap(inputs()));
  assert.equal(buildRoadmap(inputs()).generatedAt, "2026-10-21T12:00:00Z");
});
