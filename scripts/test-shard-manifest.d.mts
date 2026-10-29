/**
 * The typed face of `test-shard-manifest.mjs` (plain Node ESM, so the shard
 * toolchain's merge job runs it with no package installed) for the TypeScript
 * consumers that read the derived population: the suite's population helper
 * (`tests/helpers/test-manifest.ts`).
 */
export type ShardPopulation = Readonly<{
  measuredHeadSha: string;
  measuredAt: string;
  files: readonly Readonly<{ path: string; weightMs: number }>[];
  excluded: readonly Readonly<{ path: string; reason: string; evidence: string }>[];
  unmeasured: readonly string[];
  stale: readonly string[];
  hash: string;
}>;

/** The derived shard population at the tree `root`, weighed by the measured weights file. */
export declare function readShardPopulation(root: string, weightsPath?: string): ShardPopulation;
