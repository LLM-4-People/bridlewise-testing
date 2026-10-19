/**
 * Causal ribbon path — pure functions behind CausalRibbon.svelte (§6.5).
 *
 * Selecting a beat lights its causal chain: the parent path
 * (run → turn → call → effect) drawn in the beam color. The chain is an
 * exact walk of recorded `parentEventId` edges — no inferred causality, no
 * fabricated links. One chain at a time.
 */

import type { SweepEvent } from "./types";

/** Walk depth cap — a recorded chain deeper than this indicates corruption;
 * the walk stops rather than looping. */
export const MAX_CHAIN_DEPTH = 64;

/**
 * The causal chain for a focused event: the event and its recorded
 * ancestors, ordered root-first. Cycle-safe (a repeated id stops the walk);
 * a missing parent stops the walk (the chain honestly ends where the
 * recorded window ends). Returns [] when the focused id is not in the set —
 * an unknown focus lights nothing.
 *
 * (Named `sweepCausalChain`: the flow surface has its own `causalChain`
 * over its beat log — same concept, different input shape; the scattered-
 * helpers guard rightly demands distinct names for distinct owners.)
 */
export function sweepCausalChain(
  focusedEventId: string,
  events: readonly SweepEvent[],
): readonly SweepEvent[] {
  const byId = new Map<string, SweepEvent>();
  for (const e of events) byId.set(e.eventId, e);

  const focused = byId.get(focusedEventId);
  if (focused === undefined) return [];

  const chain: SweepEvent[] = [];
  const seen = new Set<string>();
  let cursor: SweepEvent | undefined = focused;
  while (cursor !== undefined && chain.length < MAX_CHAIN_DEPTH) {
    if (seen.has(cursor.eventId)) break; // cycle guard
    seen.add(cursor.eventId);
    chain.push(cursor);
    cursor = cursor.parentEventId === null
      ? undefined
      : byId.get(cursor.parentEventId);
  }
  chain.reverse(); // root first
  return Object.freeze(chain);
}

/** A resolved point on the ribbon: an event anchored where its beat/tick
 * renders. Layout comes from the CONSUMER (the flow gutter knows its y
 * positions; the sweep knows its x positions) — this module never invents
 * geometry. */
export type RibbonPoint = Readonly<{
  eventId: string;
  x: number;
  y: number;
}>;

/**
 * SVG path (`d`) through the chain's points — a vertical spine with gentle
 * curvature between anchors (quadratic joins at the midpoints, flat caps).
 * Returns "" for fewer than 2 points: a one-event chain has no edge to
 * draw, and an empty path is the honest output.
 */
export function ribbonPathD(points: readonly RibbonPoint[]): string {
  if (points.length < 2) return "";
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const first = points[0]!;
  let d = `M ${r2(first.x)} ${r2(first.y)}`;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!;
    const next = points[i]!;
    const midY = (prev.y + next.y) / 2;
    // Two quadratic segments through the vertical midpoint: leaves the
    // previous anchor vertically, arrives at the next anchor vertically —
    // the gutter-spine look, with no overshoot.
    d += ` Q ${r2(prev.x)} ${r2(midY)} ${r2((prev.x + next.x) / 2)} ${r2(midY)}`;
    d += ` Q ${r2(next.x)} ${r2(midY)} ${r2(next.x)} ${r2(next.y)}`;
  }
  return d;
}

/**
 * Chain + consumer layout → drawable points, in chain order. Chain members
 * the consumer cannot place (offscreen / virtualized-away) are skipped —
 * the ribbon shows only real, currently-placeable anchors.
 */
export function ribbonPoints(
  chain: readonly SweepEvent[],
  place: (eventId: string) => Readonly<{ x: number; y: number }> | null,
): readonly RibbonPoint[] {
  const out: RibbonPoint[] = [];
  for (const e of chain) {
    const p = place(e.eventId);
    if (p !== null) out.push(Object.freeze({ eventId: e.eventId, x: p.x, y: p.y }));
  }
  return Object.freeze(out);
}
