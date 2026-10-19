// @vitest-environment node
/**
 * THE SWITCH — the CPU budgets for the river's PURE DERIVE, and nothing else.
 *
 * ── WHAT THIS FILE BOUNDS, AND WHAT IT EMPHATICALLY DOES NOT ──────────────
 *
 * POPULATION: `filterRiver` + `flattenVisible` + `buildRiver`, called
 * directly, over 500 reels held in memory. No DOM, no components, no mount.
 *
 * This file used to describe itself as bounding "type-to-filter", which is
 * the name of a SURFACE. It has never measured that surface, and the gap is
 * not marginal: at its own 500-reel fixture the derive measures 0.054 ms
 * against a 50 ms budget — 926x of headroom — and at 12,000 reels it is
 * 1.749 ms, still 28x inside. No growth this product will ever see can make
 * these numbers fire. Meanwhile the surface they were named after blocks for
 * seconds, because the cost is the MOUNT, not the filter: at 3,000
 * conversations one keystroke mounts 3,000 reels while the entire derive
 * that precedes them accounts for 0.011% of the time.
 *
 * A budget with that much headroom is not a budget; it is a green light with
 * a number printed on it. The numbers below are still worth keeping — a
 * derive that went quadratic would be a real regression and this would catch
 * it — but they are worth keeping HONESTLY LABELLED, so nobody reads a green
 * run here as evidence about what typing costs.
 *
 * THE MOUNT IS BOUNDED NEXT DOOR, against the rendered DOM:
 * `switch-mount-population.test.ts`.
 *
 * The measurement harness is MUTATION-TESTED: a deliberately slowed filter
 * measured by the same harness exceeds the budget, proving the guard can
 * fail — a stopwatch that cannot fail measures nothing. That property is
 * real, and it was never the problem: the harness could always fail, it was
 * simply pointed at something that never would.
 */
import { describe, expect, test } from "vitest";

import {
  buildRiver,
  filterRiver,
  flattenVisible,
  stableCapOrder,
  type ProjectCap,
} from "../../src/cockpit/rooms/switch-data.ts";
import type { ProjectSummary } from "../../src/state/projects.ts";
import type { ChatSummary } from "../../src/state/chats.ts";

const FILTER_BUDGET_MS = 50;
const BUILD_BUDGET_MS = 200;

const T = Date.parse("2026-07-26T12:00:00Z");
const iso = (msAgo: number): string => new Date(T - msAgo).toISOString();

// 100 projects × 5 conversations = 500 reels — the ~90-project workspace,
// with headroom.
const projects: ProjectSummary[] = Array.from({ length: 100 }, (_, i) => ({
  id: `p${i}`,
  name: `project ${i} ${i % 7 === 0 ? "reader" : "misc"}`,
  path: `/tmp/p${i}`,
  createdAt: iso(i * 10_000 + 1000),
  updatedAt: iso(i * 10_000),
}));

const chatsByProject: Record<string, readonly ChatSummary[]> = {};
for (const p of projects) {
  chatsByProject[p.id] = Array.from({ length: 5 }, (_, j) => ({
    id: `${p.id}-c${j}`,
    projectId: p.id,
    title: `conversation ${j} ${j % 2 === 0 ? "parser fix" : "cleanup pass"}`,
    createdAt: iso(j * 60_000 + 1000),
    updatedAt: iso(j * 60_000),
    modelId: null,
    pinned: false,
  }));
}

function buildOnce(): readonly ProjectCap[] {
  const order = stableCapOrder([], projects, chatsByProject);
  return buildRiver(projects, chatsByProject, order, new Set(), () => "loaded");
}

/** Best-of-N wall time — the honest CI shape (absorbs scheduler noise
 * without loosening the budget). */
function measureMs(fn: () => void, runs = 5): number {
  let best = Infinity;
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

describe("switch latency budgets (CI)", () => {
  const caps = buildOnce();

  test("fixture sanity: 500 reels are really there", () => {
    let n = 0;
    for (const c of caps) n += c.reels.length;
    expect(n).toBe(500);
  });

  test(`filterRiver + flattenVisible over 500 reels < ${FILTER_BUDGET_MS}ms — the DERIVE only, not the mount`, () => {
    for (const q of ["p", "par", "parser fix", "project 42", "zzz-no-hit"]) {
      const ms = measureMs(() => {
        const hit = filterRiver(caps, q);
        flattenVisible(hit); // the focus sequence recomputes per keystroke too
      });
      expect(ms, `query "${q}" took ${ms.toFixed(2)}ms`).toBeLessThan(FILTER_BUDGET_MS);
    }
  });

  test(`full river build from stores < ${BUILD_BUDGET_MS}ms (the <200ms room-open law's CPU half)`, () => {
    const ms = measureMs(() => buildOnce());
    expect(ms, `river build took ${ms.toFixed(2)}ms`).toBeLessThan(BUILD_BUDGET_MS);
  });

  test("mutation: the stopwatch CAN fail — a slowed filter blows the budget", () => {
    const slowed = (q: string): void => {
      filterRiver(caps, q);
      const until = performance.now() + FILTER_BUDGET_MS + 10;
      while (performance.now() < until) {
        /* the injected slowness a real regression would introduce */
      }
    };
    const ms = measureMs(() => slowed("parser"), 1);
    expect(ms).toBeGreaterThan(FILTER_BUDGET_MS);
  });
});
