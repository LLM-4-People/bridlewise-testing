<script lang="ts">
  /**
   * The brand mark, shared by entry and workspace chrome. Drawn inline from
   * the one geometry (`brand-mark.ts`) in the live theme's tokens, so the
   * Logbook theme gets a paper tile rather than a dark square.
   */
  import { BRAND_MARK, strokePath } from "./brand-mark.ts";

  let { wordmark = false }: { wordmark?: boolean } = $props();
</script>

<span class="brand" class:wordmark>
  <svg
    viewBox="0 0 {BRAND_MARK.grid} {BRAND_MARK.grid}"
    role={wordmark ? undefined : "img"}
    aria-label={wordmark ? undefined : "Bridlewise"}
    aria-hidden={wordmark ? "true" : undefined}
  >
    <rect class="tile" width={BRAND_MARK.grid} height={BRAND_MARK.grid} rx={BRAND_MARK.tileRadius} />
    <path class="rein" d={strokePath(BRAND_MARK.rein)} stroke-width={BRAND_MARK.stroke} />
    {#each BRAND_MARK.lines as line (strokePath(line))}
      <path class="line" d={strokePath(line)} stroke-width={BRAND_MARK.stroke} />
    {/each}
    <circle class="beam" cx={BRAND_MARK.beam.at[0]} cy={BRAND_MARK.beam.at[1]} r={BRAND_MARK.beam.r} />
  </svg>
  {#if wordmark}<span>bridlewise</span>{/if}
</span>

<style>
  .brand { display: inline-flex; align-items: center; gap: var(--sp-3); min-width: 0; color: var(--ink-1); font: var(--f-prose-size) var(--face-sans); }
  svg { display: block; width: var(--monitor-h); height: var(--monitor-h); flex: none; }
  .wordmark svg { width: var(--horizon-h); height: var(--horizon-h); }
  .tile { fill: var(--ground-2); }
  .rein, .line { fill: none; stroke-linecap: round; }
  .rein { stroke: var(--ink-1); }
  .line { stroke: var(--ink-2); }
  .beam { fill: var(--beam); }
</style>
