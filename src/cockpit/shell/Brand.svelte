<script lang="ts">
  /**
   * The brand mark, shared by entry and workspace chrome. Drawn inline from
   * the one geometry (`brand-mark.ts`): each part is painted with the token
   * the geometry names for it, read live, so the Logbook theme gets a paper
   * tile rather than a dark square and the mark never disagrees with the
   * generated icons.
   */
  import { BRAND_MARK, inkOf, strokePath } from "./brand-mark.ts";

  let { wordmark = false }: { wordmark?: boolean } = $props();
</script>

<span class="brand" class:wordmark>
  <svg
    viewBox="0 0 {BRAND_MARK.grid} {BRAND_MARK.grid}"
    role={wordmark ? undefined : "img"}
    aria-label={wordmark ? undefined : "Bridlewise"}
    aria-hidden={wordmark ? "true" : undefined}
  >
    <rect width={BRAND_MARK.grid} height={BRAND_MARK.grid} rx={BRAND_MARK.tileRadius} style:fill={inkOf(BRAND_MARK.tile)} />
    <path d={strokePath(BRAND_MARK.rein)} stroke-width={BRAND_MARK.stroke} style:stroke={inkOf(BRAND_MARK.rein.ink)} />
    {#each BRAND_MARK.lines as line (strokePath(line))}
      <path d={strokePath(line)} stroke-width={BRAND_MARK.stroke} style:stroke={inkOf(line.ink)} />
    {/each}
    <circle cx={BRAND_MARK.beam.at[0]} cy={BRAND_MARK.beam.at[1]} r={BRAND_MARK.beam.r} style:fill={inkOf(BRAND_MARK.beam.ink)} />
  </svg>
  {#if wordmark}<span>bridlewise</span>{/if}
</span>

<style>
  .brand { display: inline-flex; align-items: center; gap: var(--sp-3); min-width: 0; color: var(--ink-1); font: var(--f-prose-size) var(--face-sans); }
  svg { display: block; width: var(--monitor-h); height: var(--monitor-h); flex: none; }
  .wordmark svg { width: var(--horizon-h); height: var(--horizon-h); }
  path { fill: none; stroke-linecap: round; }
</style>
