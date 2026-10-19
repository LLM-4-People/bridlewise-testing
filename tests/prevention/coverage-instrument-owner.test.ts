// @vitest-environment node
/**
 * Mechanical enforcement: DARKFIELD/ANNUNCIATOR are instruments, and
 * instruments must not lie. (Sibling of `lens-provenance-owner.test.ts` at
 * the system level.)
 *
 * The behavioural halves of these properties live in
 * `tests/unit/coverage-blocks-real-ledger.test.ts` (real temp ledger) and in
 * the harness's `timeline-coverage-counts.test.ts` (EXPLAIN-verified plans,
 * beside the SQL's owner). This file guards the STRUCTURES that make the
 * behaviour trustworthy, each mutation-verified (reintroduce the defect → the
 * named test FAILS):
 *
 *   A. NO HAND-LISTS. The declared vocabularies are enumerated from the
 *      harness registry exports; no registry member is restated as a string
 *      literal (one named exception: the "tool" defect lane).
 *   B. THE GATE. Every block read applies `requireUserContext` — one gate per
 *      declaration, so a new read cannot ship ungated.
 *   C. COUNTS ONLY. No score/percentage/ratio/threshold surfaces in the
 *      module — the instrument reports numbers, never judgments.
 *   D. WIRED, NOT ORPHANED. The registry actually registers the blocks.
 *   E. ONE DOOR TO THE LEDGER. The module reaches the ledger only through
 *      the bridge's canonical store — no sqlite import, no prepared SQL.
 */
import { describe, test, expect } from "vitest";

import {
  TIMELINE_EVENT_TYPES,
  TIMELINE_RECORD_KINDS,
  TIMELINE_EDGE_TYPES,
} from "../../server/kernel/canonical.ts";
import { read, stripCommentsAndStringsFor, stripCommentsOnly } from "../helpers/source-scan.ts";

import { modulePathMatching } from "../helpers/module-resolver.ts";
const COVERAGE_MODULE = modulePathMatching("server/blocks/coverage.ts");
const ROUTE_REGISTRY = modulePathMatching("server/routes/registry.ts");

/** The one registry member the module may name: the tool defect lane. */
const ALLOWED_LITERALS = new Set(["tool"]);

describe("A. the declared vocabularies are enumerated, never restated", () => {
  test("coverage.ts reads all three registries from the canonical exports", () => {
    const src = stripCommentsOnly(read(COVERAGE_MODULE));
    for (const name of ["TIMELINE_EVENT_TYPES", "TIMELINE_RECORD_KINDS", "TIMELINE_EDGE_TYPES"]) {
      expect(
        src.includes(name),
        `${COVERAGE_MODULE} no longer references ${name} — the declared set must come\n` +
          `from the harness export, not a local restatement.`,
      ).toBe(true);
    }
  });

  test('no registry member appears as a string literal (except the named "tool" lane)', () => {
    // MUTATION: replacing the registry import with a copied literal list goes
    // stale silently the moment the harness vocabulary moves. A literal here
    // is the seed of that copy, so it is refused outright.
    const src = stripCommentsOnly(read(COVERAGE_MODULE));
    const offenders: string[] = [];
    const members = new Set<string>([
      ...TIMELINE_EVENT_TYPES,
      ...TIMELINE_RECORD_KINDS,
      ...TIMELINE_EDGE_TYPES,
    ]);
    for (const member of members) {
      if (ALLOWED_LITERALS.has(member)) continue;
      if (new RegExp(`["'\`]${member}["'\`]`).test(src)) {
        offenders.push(member);
      }
    }
    expect(
      offenders,
      `Registry members restated as literals in ${COVERAGE_MODULE}: ${offenders.join(", ")}.\n` +
        `Enumerate the registry export instead — a literal list is a hand-list waiting to rot.`,
    ).toEqual([]);
  });

  test("the tool lane literal stays compile-checked against the registry", () => {
    // "tool" is allowed only in its typed form, where a vocabulary change is
    // a compile error rather than a silent zero.
    const src = stripCommentsOnly(read(COVERAGE_MODULE));
    expect(src).toMatch(/TOOL_EVENT_TYPE\s*:\s*TimelineEventType\s*=\s*"tool"/);
  });
});

describe("B. every block read applies the authentication gate", () => {
  test("one requireUserContext per defineBlock, and at least one block", () => {
    // MUTATION: deleting the requireUserContext call inside one handler makes
    // the counts diverge and this fails — a read cannot ship ungated. (The
    // behavioural half — an unauthenticated call actually throwing — is in
    // the real-ledger suite.)
    const src = stripCommentsOnly(read(COVERAGE_MODULE));
    const blocks = (src.match(/\bdefineBlock\s*\(/g) ?? []).length;
    const gates = (src.match(/\brequireUserContext\s*\(/g) ?? []).length;
    expect(blocks).toBeGreaterThan(0);
    expect(
      gates,
      `${COVERAGE_MODULE} declares ${blocks} block(s) but applies requireUserContext ` +
        `${gates} time(s) — every read handler must gate first.`,
    ).toBe(blocks);
  });
});

describe("C. counts only — the instrument reports numbers, never judgments", () => {
  test("no score, percentage, ratio or threshold identifier in the module", () => {
    // MUTATION: adding a `healthScore` or `coveragePercent` field fails here.
    // A derived judgment invites a threshold, a threshold invites a colour,
    // and the number stops being a measurement. Strings are stripped too: the
    // block DESCRIPTION legitimately promises "no scores, no thresholds", and
    // prose must not count as a violation of the promise it states.
    const src = stripCommentsAndStringsFor(read(COVERAGE_MODULE), COVERAGE_MODULE);
    expect(src).not.toMatch(/score|percent|ratio|threshold|grade/i);
  });
});

describe("D. wired, not orphaned", () => {
  test("the route registry registers the coverage blocks", () => {
    const src = stripCommentsOnly(read(ROUTE_REGISTRY));
    expect(
      /\bdefineCoverageBlocks\s*\(\s*db\s*\)/.test(src),
      `${ROUTE_REGISTRY} must call defineCoverageBlocks(db) — declared-but-unmounted\n` +
        `blocks 404, which for a coverage instrument reads exactly like the absence it\n` +
        `is meant to measure.`,
    ).toBe(true);
  });
});

describe("E. one door to the ledger", () => {
  test("coverage.ts opens no database and prepares no SQL", () => {
    // The ledger's SQL owner is the harness store; the repo-wide raw-SQL
    // guard enforces this for all of server/, but this pins the DOOR the
    // module uses so a future refactor cannot swap it quietly.
    const src = stripCommentsOnly(read(COVERAGE_MODULE));
    expect(src).not.toMatch(/node:sqlite|DatabaseSync|\.prepare\s*\(|SELECT\s+/i);
    expect(
      src.includes("getTimelineStore"),
      "the module must reach the ledger through the bridge's canonical store",
    ).toBe(true);
  });
});
