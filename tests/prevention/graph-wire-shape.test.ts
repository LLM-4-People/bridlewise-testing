// @vitest-environment node
/**
 * Prevention: the dependency-graph wire shape MUST stay aligned between
 * the server route (`server/routes/intelligence.ts`) and its consumers
 * (the wire is #88's substrate — the old panel consumer is gone).
 *
 * Root cause this pins: the server returned `cycles` as
 * `{ hasCycles, cycles: string[][] }` (the `detectCycles` shape) but the
 * panel treated it as `{ nodes: string[] }[]` (an array of cycle
 * objects), so `graphData.cycles.length` was always `undefined` → the
 * cycle count tile showed `0` and the cycle list never rendered even on
 * a repo with real cycles. Separately, the route never sent
 * `stats.density`, so the density tile read `undefined` → "—". Both were
 * silent because the client's `getDependencyGraph` returned `unknown`
 * (no type to catch the drift).
 *
 * This test pins:
 *  A — the `DependencyGraphData` wire type exists in the single owner
 *      (`shared/wire-types.ts`) and carries `stats.density` +
 *      `cycles: { hasCycles, cycles: string[][] }`.
 *  B — the route computes + sends `stats.density` (no longer missing).
 *  C — the panel reads `graphData.cycles.cycles.length` (NOT the old
 *      `graphData.cycles.length`) and iterates `graphData.cycles.cycles`
 *      (each cycle is a `string[]`, rendered directly — NOT `cycle.nodes`).
 *  D — the panel reads `graphData.stats.density` (the real field).
 *  (Classes C–F — the panel and the per-route client wrapper — died with
 *  the old tree; the wire types stay pinned because they are the contract
 *  a future cockpit consumer plugs into.)
 */
import { describe, test, expect } from "vitest";
import { readFileSync } from "node:fs";

import { modulePathMatching } from "../helpers/module-resolver.ts";
describe("Dependency graph wire shape (server ↔ frontend no drift)", () => {
  const wireSource = readFileSync("shared/wire-types.ts", "utf8");
  // The graph projection (density, node capping, edge filtering) moved to
  // server/blocks/intelligence.ts — the block owns the single implementation
  // and the legacy route delegates to it.
  const routeSource = readFileSync(modulePathMatching("server/blocks/intelligence.ts"), "utf8");

  test("wire-types declares DependencyGraphData with stats.density + the cycles object shape", () => {
    expect(wireSource).toContain("export type DependencyGraphData");
    expect(wireSource).toMatch(/density:\s*number;/);
    // cycles is an object with hasCycles + cycles array (NOT a bare array).
    expect(wireSource).toContain("export type CycleResultView");
    expect(wireSource).toMatch(/hasCycles:\s*boolean;/);
    expect(wireSource).toMatch(/cycles:\s*ReadonlyArray<readonly string\[\]>;/);
  });

  test("wire-types declares IndexingResponse (the 202 discriminated union partner)", () => {
    expect(wireSource).toContain("export type IndexingResponse");
    expect(wireSource).toMatch(/status:\s*"indexing"/);
  });

  test("the route computes + sends stats.density (the field the panel reads)", () => {
    // density is derived from the full graph, not the capped subset.
    expect(routeSource).toContain("density");
    expect(routeSource).toMatch(/graph\.nodeCount\s*\*\s*\(graph\.nodeCount\s*-\s*1\)/);
    // the route spreads stats + adds density (stats is frozen from the backend).
    expect(routeSource).toMatch(/stats:\s*\{\s*\.\.\.\s*stats,\s*density\s*\}/);
  });

  // (The panel/client consumer halves died with the old tree; the wire
  //  declarations and the block's density computation above are the #88
  //  substrate this file keeps pinned.)
});

// (The DependencyGraph drawTick classes died with the component.)
