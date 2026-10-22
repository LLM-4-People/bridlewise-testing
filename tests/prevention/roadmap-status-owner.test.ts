// @vitest-environment node
/**
 * THE ROADMAP'S STATUS BLOCKS ARE GENERATED, AND THE PAGE CANNOT DRIFT FROM
 * ITS OWNERS.
 *
 * ── THE DEFECT THIS GUARDS ────────────────────────────────────────────────
 *
 * The public roadmap read as prose with a status that drifted. It claimed
 * "Next" for work whose task row had closed, listed "Now" items that were
 * already done, and repeated a hand-typed snapshot that no longer matched the
 * evidence page. A reader could not tell what had shipped from what was
 * planned, and every status was a second owner of a fact held somewhere else.
 * Its successor, a plan block with a hand-typed `state` on every row, still
 * let a state be typed instead of shown.
 *
 * ── THE OWNERS ───────────────────────────────────────────────────────────
 *
 *   - the structured tracker items (`docs/trackers/items/`, read through the
 *     tracker's one parser, `engine/src/workflow/failure-owners.ts`) own the
 *     milestones, workstreams, exit criteria, not-planned statements and every
 *     open task;
 *   - every STATE is computed from the items' evidence
 *     (`engine/src/workflow/tracker-status.ts`): closed or open, what an item
 *     is blocked by, its sub-items, the decision records it carries out;
 *   - `docs/floor/evidence.md` owns the statements it explicitly refuses to
 *     prove.
 *
 * ── THE PLANT AND THE DRIVEN BEHAVIOR ────────────────────────────────────
 *
 * The guard regenerates the page and compares it byte for byte with the
 * committed page (`npm run docs:roadmap`). A hand edit inside a generated
 * block, an open roadmap item without a milestone, an item whose evidence
 * names a missing anchor, and a removed marker all turn it red; a state moves
 * only when its evidence does. The plants are synthetic items and texts,
 * never a tracked file.
 *
 * ── LIVENESS ─────────────────────────────────────────────────────────────
 *
 * The completeness arms walk the real items and the real evidence page, so an
 * empty population is impossible to pass silently: the tests assert the
 * population first and then require every member in the rendered page.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { readDecisionRecords, readTrackerItems, type TrackerItem } from "../../engine/src/workflow/failure-owners.ts";
import { itemStatuses } from "../../engine/src/workflow/tracker-status.ts";
import {
  EVIDENCE_PATH,
  ROADMAP_BLOCKS,
  ROADMAP_PATH,
  extractEvidenceNonProofs,
  headingSlug,
  renderRoadmapPage,
  roadmapDrift,
} from "../../scripts/floor/roadmap-status.ts";
import { escapeSiteText } from "../../shared/markup.ts";

const ROOT = process.cwd();
const page = readFileSync(join(ROOT, ROADMAP_PATH), "utf8");
const items = readTrackerItems(ROOT);
const decisions = readDecisionRecords(ROOT);
const evidenceText = readFileSync(join(ROOT, EVIDENCE_PATH), "utf8");
const sources = { items, decisions, recordedEvidence: new Set<string>(), evidenceText };

/** A synthetic item: an open roadmap task by default. */
const planted = (id: string, fields: Partial<TrackerItem> = {}): TrackerItem => ({
  id, type: "Task", title: null, state: "open", resolution: null, lane: "roadmap", ownerRole: null, milestone: "M1", parent: null,
  blockedBy: [], relates: [], severity: null, area: [], evidence: null, order: null, horizon: null, decisions: [], tests: [], rfc: null,
  gh: null, opened: "2026-10-21", closed: null, body: `The planted outcome of ${id}.`, ...fields,
});

describe("docs/floor/roadmap.md status is generated from its owners", () => {
  test("the page is the renderer's output, and every owner item is present", () => {
    const open = items.filter((item) => item.state === "open");
    const roadmap = items.filter((item) => item.lane === "roadmap");
    expect(open.length, "the tracker holds no open item — the completeness population is empty").toBeGreaterThan(0);
    expect(roadmap.length, "the tracker holds no roadmap item").toBeGreaterThan(0);
    const nonProofs = extractEvidenceNonProofs(evidenceText);
    expect(nonProofs.length, "the evidence page names no non-proof — the completeness population is empty").toBeGreaterThan(0);

    const report = roadmapDrift(page, sources, ROOT);
    expect(report.violations, `the roadmap items do not cover their owners:\n${report.violations.join("\n")}`).toEqual([]);
    expect(report.staleBlocks, `docs/floor/roadmap.md's generated blocks are stale: run npm run docs:roadmap (stale: ${report.staleBlocks.join(", ")})`).toEqual([]);

    for (const item of [...open, ...roadmap]) expect(page, `item ${item.id} is missing from the roadmap`).toContain(`items/${item.id}.md`);
    for (const nonProof of nonProofs) expect(page, `the evidence non-proof "${nonProof.text}" is missing from the roadmap`).toContain(escapeSiteText(nonProof.text));
  });

  test("the #snapshot anchor and the milestone headings survive the generated tables", () => {
    const anchors = new Set([...page.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gmu)].map((match) => headingSlug(match[1]!)));
    expect(anchors.has("snapshot"), "the #snapshot inbound anchor is gone").toBe(true);
    for (const milestone of ["m0--public-floor-online", "m1--reproducible-sharded-floor", "m2--admission-evidence", "m3--product-hardening", "m4--sustainable-contribution"]) {
      expect(anchors.has(milestone), `the milestone anchor #${milestone} is gone`).toBe(true);
    }
  });

  test("a hand edit inside a generated block is refused (planted)", () => {
    const handEdited = page.replace("### Where the floor stands", "### Where the floor stood");
    expect(handEdited, "the stale-summary plant did not land").not.toBe(page);
    expect(roadmapDrift(handEdited, sources, ROOT).staleBlocks).toContain("summary");
  });

  test("a state moves only with its evidence: a shipped sub-item puts its parent in progress, an open blocker blocks it (planted)", () => {
    const parent = planted("PLANTED-WORK", { type: "Workstream", title: "Planted workstream" });
    const planned = renderRoadmapPage(page, { ...sources, items: [...items, parent] });
    expect(planned).toMatch(/Planted workstream\]\([^)]*\)\*\*<br>Exit: [^|]*\| planned \|/u);
    const child = planted("PLANTED-CHILD", { lane: "floor", milestone: null, parent: "PLANTED-WORK", state: "closed", resolution: "completed", closed: "2026-10-21", tests: ["tests/prevention/roadmap-status-owner.test.ts"] });
    const progressing = renderRoadmapPage(page, { ...sources, items: [...items, parent, child] });
    expect(progressing).toContain(escapeSiteText("in progress (PLANTED-CHILD shipped)"));
    const blocker = planted("PLANTED-BLOCKER", { lane: "floor", milestone: null });
    const blocked = renderRoadmapPage(page, { ...sources, items: [...items, { ...parent, blockedBy: ["PLANTED-BLOCKER"] }, child, blocker] });
    expect(blocked).toContain(escapeSiteText("blocked (blocked by PLANTED-BLOCKER)"));
  });

  test("a close is a claim until linked evidence proves it: shipped only by a built decision, existing tests, a recorded evidence record or this repository's own PR, run or release (planted)", () => {
    const facts = { decisions: [{ id: "D-BUILT", status: "in-force", implementation: "done" }, { id: "D-DESIGNED", status: "in-force", implementation: "pending" }], recordedEvidence: new Set(["runs/receipt.json"]), repositoryUrl: "https://github.com/LLM-4-People/bridlewise-testing" };
    const closed = (id: string, fields: Partial<TrackerItem> = {}): TrackerItem => planted(id, { state: "closed", resolution: "completed", closed: "2026-10-21", ...fields });
    const states = itemStatuses([
      closed("BARE"),
      closed("UNRECORDED", { evidence: "evidence:nope/never.json" }),
      closed("FOREIGN-URL", { evidence: "https://example.invalid/x" }),
      closed("DOC-ANCHOR", { evidence: "docs/floor/evidence.md#guardian" }),
      closed("OTHER-REPO-PR", { evidence: "https://github.com/someone/else/pull/1" }),
      closed("DESIGNED", { decisions: ["D-DESIGNED"] }),
      closed("BY-DECISION", { decisions: ["D-BUILT"] }),
      closed("BY-TESTS", { tests: ["tests/prevention/roadmap-status-owner.test.ts"] }),
      closed("BY-RECORD", { evidence: "evidence:runs/receipt.json" }),
      closed("BY-PR", { evidence: "https://github.com/LLM-4-People/bridlewise-testing/pull/130" }),
      closed("BY-RUN", { evidence: "https://github.com/LLM-4-People/bridlewise-testing/actions/runs/39690870022" }),
      closed("BY-RELEASE", { evidence: "https://github.com/LLM-4-People/bridlewise-testing/releases/tag/v0.0.3-preview" }),
    ], facts);
    for (const id of ["BARE", "UNRECORDED", "FOREIGN-URL", "DOC-ANCHOR", "OTHER-REPO-PR", "DESIGNED"]) expect(states.get(id), id).toEqual({ state: "claimed", because: "closed as completed; no linked evidence proves it" });
    for (const id of ["BY-DECISION", "BY-TESTS", "BY-RECORD", "BY-PR", "BY-RUN", "BY-RELEASE"]) expect(states.get(id)?.state, id).toBe("shipped");
    expect(states.get("BY-PR")?.because).toBe("proven by this repository's pull request https://github.com/LLM-4-People/bridlewise-testing/pull/130");
    // A hand-closed sub-item proves no progress; hand-closing every member of a milestone makes it claimed, never shipped.
    const parent = planted("PARENT", { type: "Workstream" });
    const progress = itemStatuses([parent, closed("CHILD", { parent: "PARENT", lane: "floor", milestone: null })], facts);
    expect(progress.get("PARENT")?.state).toBe("planned");
    const milestone = planted("MS", { type: "Milestone", state: null, lane: null, milestone: null });
    const handClosed = itemStatuses([milestone, closed("A", { milestone: "MS" }), closed("B", { milestone: "MS" })], facts);
    expect(handClosed.get("MS")?.state).toBe("claimed");
    expect(itemStatuses([milestone, closed("A", { milestone: "MS", tests: ["x"] }), closed("B", { milestone: "MS", decisions: ["D-BUILT"] })], facts).get("MS")?.state).toBe("shipped");
  });

  test("no spelling of an item publishes markup: raw HTML, an unclosed fence, a kramdown attribute list and Liquid in a title or a body render as text (planted)", () => {
    const plantedItems = [
      planted("PLANTED-SCRIPT", { title: "x <img src=x onerror=alert(1)> {{ site.github }} y", body: "<script>alert(2)</script> the outcome {% include evil.html %}." }),
      planted("PLANTED-FENCE", { body: "```\n<script>alert(3)</script> a fence never closed" }),
      planted("PLANTED-IAL", { body: "the outcome.\n{: onclick=\"alert(4)\" .x}\n\n[a link](javascript:alert(5)) <!-- a comment -->" }),
      planted("M9", { type: "Milestone", title: "Planted {% raw %}{{ site.x }}{% endraw %} milestone", state: null, lane: null, milestone: null, order: 9, body: "Prose with <iframe src=x></iframe> and {{ site.github.token }}.\n\n```\nunclosed <b>" }),
    ];
    const rendered = renderRoadmapPage(page, { ...sources, items: [...items, ...plantedItems] });
    const generated = rendered.slice(rendered.indexOf("<!-- BEGIN GENERATED"));
    for (const raw of ["<script", "<img", "<iframe", "<b>", "<!-- a comment", "{% include", "{% raw", "{{ site.github", "{{ site.x", "{:", "javascript:"]) {
      expect(generated, `${raw} reached the page raw`).not.toContain(raw);
    }
    // The planted text is still on the page, as text.
    expect(generated).toContain(escapeSiteText("Planted {% raw %}"));
  });

  test("an open roadmap item without a milestone, and evidence that names no anchor, are refused (planted)", () => {
    const report = roadmapDrift(page, { ...sources, items: [...items, planted("PLANTED-LOOSE", { milestone: null }), planted("PLANTED-EVIDENCE", { evidence: "docs/floor/evidence.md#no-such-anchor" })] }, ROOT);
    const observed = report.violations.join("\n");
    expect(observed).toContain("roadmap item PLANTED-LOOSE is open and names no milestone");
    expect(observed).toContain("PLANTED-EVIDENCE: docs/floor/evidence.md#no-such-anchor: no heading anchor #no-such-anchor");
  });

  test("a new evidence non-proof is rendered, not omitted (planted)", () => {
    const rendered = renderRoadmapPage(page, { ...sources, evidenceText: `${evidenceText}\n\n## A new check\n\nWhat this does not prove: the planted claim.\n` });
    expect(rendered).toContain("the planted claim");
  });

  test("a page without a generated marker is refused (planted)", () => {
    const missingSummary = page.replace(ROADMAP_BLOCKS.summary.begin, "<!-- summary marker removed -->");
    expect(missingSummary, "the marker-removal plant did not land").not.toBe(page);
    expect(roadmapDrift(missingSummary, sources, ROOT).violations.join("\n")).toMatch(/summary/u);
  });
});
