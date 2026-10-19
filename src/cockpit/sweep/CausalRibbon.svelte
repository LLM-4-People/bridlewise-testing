<script lang="ts">
  /**
   * Causal ribbon (§6.5): the SVG spine-path highlight for ONE focused
   * event's recorded causal chain. Pure component: the consumer (the flow
   * gutter, later) supplies the events and a `place` function mapping
   * eventId → gutter coordinates; the path math lives in ribbon.ts (pure,
   * tested). No placeable anchors → renders nothing (honest absence).
   *
   * Beam-colored by spec (§12.2: causal ribbons are a beam surface).
   */
  import { ribbonPathD, ribbonPoints, sweepCausalChain } from "./ribbon";
  import type { SweepEvent } from "./types";

  let {
    focusedEventId,
    events,
    place,
    width,
    height,
  }: {
    focusedEventId: string | null;
    events: readonly SweepEvent[];
    /** Consumer layout: gutter coordinates for an event, or null when the
     * beat is not currently placeable (virtualized away). */
    place: (eventId: string) => Readonly<{ x: number; y: number }> | null;
    width: number;
    height: number;
  } = $props();

  const chain = $derived(
    focusedEventId === null ? [] : sweepCausalChain(focusedEventId, events),
  );
  const points = $derived(ribbonPoints(chain, place));
  const pathD = $derived(ribbonPathD(points));
</script>

{#if pathD !== ""}
  <svg
    class="ribbon"
    {width}
    {height}
    viewBox={`0 0 ${width} ${height}`}
    aria-hidden="true"
  >
    <path d={pathD} class="spine" />
    {#each points as p (p.eventId)}
      <circle
        cx={p.x}
        cy={p.y}
        r={p.eventId === focusedEventId ? 3 : 2}
        class="anchor"
        class:focused={p.eventId === focusedEventId}
      />
    {/each}
  </svg>
{/if}

<style>
  .ribbon {
    position: absolute;
    inset: 0;
    pointer-events: none;
    overflow: visible;
  }
  .spine {
    fill: none;
    stroke: var(--beam);
    stroke-width: 1.5;
    opacity: var(--opacity-ribbon-veil);
  }
  .anchor {
    fill: var(--ground-0);
    stroke: var(--beam);
    stroke-width: 1;
  }
  .anchor.focused {
    fill: var(--beam);
  }
</style>
