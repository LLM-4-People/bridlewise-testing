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
 *
 * ── THE OWNERS ───────────────────────────────────────────────────────────
 *
 *   - `docs/trackers/TASKS.md` open rows own open work. They are read through
 *     the one task-row parser (`engine/src/workflow/failure-owners.ts`
 *     `taskRows`), never a private list.
 *   - the page's own `ROADMAP-PLAN` block owns the workstreams, exit criteria,
 *     milestone focus, not-planned statements, and the state rule for each
 *     tracker section;
 *   - `docs/floor/evidence.md` owns the statements it explicitly refuses to
 *     prove.
 *
 * ── THE PLANT AND THE DRIVEN BEHAVIOR ────────────────────────────────────
 *
 * The guard regenerates the page and compares it byte for byte with the
 * committed page (`npm run docs:roadmap`). A hand edit inside a generated
 * block, a new open TASKS.md row whose section has no state rule, a plan row
 * that points at a missing evidence anchor, and a removed marker all turn it
 * red. The plants below are synthetic: a stale summary heading, a new open
 * row in a new tracker section, and a new evidence non-proof. Each must be
 * observed by the renderer or the drift report; a guard that cannot see its
 * plant is not a guard.
 *
 * ── LIVENESS ─────────────────────────────────────────────────────────────
 *
 * The completeness arms walk the real TASKS.md and the real evidence page,
 * so an empty population is impossible to pass silently: the tests assert the
 * population first (`openRows.length > 0`, `nonProofs.length > 0`) and then
 * require every member in the rendered page.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { openTaskRows } from "../../engine/src/workflow/failure-owners.ts";
import {
  EVIDENCE_PATH,
  ROADMAP_BLOCKS,
  ROADMAP_PATH,
  TASKS_PATH,
  extractEvidenceNonProofs,
  headingSlug,
  readRoadmapPlan,
  renderRoadmapPage,
  roadmapDrift,
} from "../../scripts/floor/roadmap-status.ts";

const ROOT = process.cwd();
const page = readFileSync(join(ROOT, ROADMAP_PATH), "utf8");
const trackerText = readFileSync(join(ROOT, TASKS_PATH), "utf8");
const evidenceText = readFileSync(join(ROOT, EVIDENCE_PATH), "utf8");
const sources = { trackerText, evidenceText };

describe("docs/floor/roadmap.md status is generated from its owners", () => {
  test("the page is the renderer's output, and every owner row is present", () => {
    const openRows = openTaskRows(trackerText);
    expect(openRows.length, "TASKS.md holds no open row — the completeness population is empty").toBeGreaterThan(0);
    const nonProofs = extractEvidenceNonProofs(evidenceText);
    expect(nonProofs.length, "the evidence page names no non-proof — the completeness population is empty").toBeGreaterThan(0);
    const plan = readRoadmapPlan(page);
    expect(plan.workstreams.length, "the plan holds no workstream").toBeGreaterThan(0);
    expect(plan.exitCriteria.length, "the plan holds no exit criterion").toBeGreaterThan(0);

    const report = roadmapDrift(page, sources, ROOT);
    expect(report.violations, `the roadmap plan does not cover its owners:\n${report.violations.join("\n")}`).toEqual([]);
    expect(
      report.staleBlocks,
      `docs/floor/roadmap.md's generated blocks are stale: run npm run docs:roadmap (stale: ${report.staleBlocks.join(", ")})`,
    ).toEqual([]);

    for (const row of openRows) {
      expect(page, `open TASKS.md row "${row.id}" is missing from the roadmap`).toContain(row.id);
    }
    for (const nonProof of nonProofs) {
      expect(page, `the evidence non-proof "${nonProof.text}" is missing from the roadmap`).toContain(nonProof.text);
    }
  });

  test("the #snapshot anchor and the milestone headings survive the generated tables", () => {
    const anchors = new Set(
      [...page.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gmu)].map((match) => headingSlug(match[1]!)),
    );
    expect(anchors.has("snapshot"), "the #snapshot inbound anchor is gone").toBe(true);
    for (const milestone of ["m0--public-floor-online", "m1--reproducible-sharded-floor", "m2--admission-evidence", "m3--product-hardening", "m4--sustainable-contribution"]) {
      expect(anchors.has(milestone), `the milestone anchor #${milestone} is gone`).toBe(true);
    }
  });

  test("a hand edit inside a generated block is refused (planted)", () => {
    const handEdited = page.replace("### Where the floor stands", "### Where the floor stood");
    expect(handEdited, "the stale-summary plant did not land").not.toBe(page);
    const report = roadmapDrift(handEdited, sources, ROOT);
    expect(report.staleBlocks).toContain("summary");
  });

  test("a new open TASKS.md row with no section rule is refused (planted)", () => {
    const plantedTracker = `${trackerText}\n\n## A new lane\n\n- [ ] **PLANTED-OPEN-ROW** — a new open row with no state rule.\n`;
    const report = roadmapDrift(page, { trackerText: plantedTracker, evidenceText }, ROOT);
    const observed = report.violations.join("\n");
    expect(observed, `the planted row was not observed:\n${observed}`).toContain("PLANTED-OPEN-ROW");
    expect(observed).toContain("A new lane");
  });

  test("a new evidence non-proof is rendered, not omitted (planted)", () => {
    const plantedEvidence = `${evidenceText}\n\n## A new check\n\nWhat this does not prove: the planted claim.\n`;
    const rendered = renderRoadmapPage(page, { trackerText, evidenceText: plantedEvidence });
    expect(rendered).toContain("the planted claim");
  });

  test("a page without its plan block or a generated marker is refused (planted)", () => {
    expect(() => renderRoadmapPage(page.replace("<!-- ROADMAP-PLAN-BEGIN", "<!-- plan removed"), sources)).toThrow(/ROADMAP-PLAN/u);
    const missingSummary = page.replace(ROADMAP_BLOCKS.summary.begin, "<!-- summary marker removed -->");
    expect(missingSummary, "the marker-removal plant did not land").not.toBe(page);
    expect(roadmapDrift(missingSummary, sources, ROOT).violations.join("\n")).toMatch(/summary/u);
  });
});
