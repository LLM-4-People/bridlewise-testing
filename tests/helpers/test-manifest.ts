// @vitest-environment node
/**
 * THE SHARD POPULATION, DERIVED — the owner of the two populations a test run
 * can judge, as every consumer in this suite reads them.
 *
 * Nothing here is a list anyone edits. Every file the runner's include binding
 * selects is SUPPORTED (a full run covers it) unless it declares its own
 * exclusion in a `// @shard-exclude: <reason> (evidence: …)` header line
 * (private artifacts, a WSL host, a generated profile). The one derivation is
 * `scripts/test-shard-manifest.mjs` (`readShardPopulation`), which the shard
 * plan, the merge and `verify` read too; the budget's population count and the
 * flaky memory guard read it here instead of deriving it again.
 */
import { resolve } from "node:path";

import { readShardPopulation, type ShardPopulation } from "../../scripts/test-shard-manifest.mjs";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..", "..");

function population(): ShardPopulation {
  return readShardPopulation(REPOSITORY_ROOT);
}

/** Every file a full run judges. */
export function supportedTestFiles(): readonly string[] {
  return population().files.map((file) => file.path);
}

/** Every declared exclusion, keyed by path, with the reason it cannot be judged here. */
export function excludedTestFiles(): ReadonlyMap<string, string> {
  return new Map(population().excluded.map((file) => [file.path, file.reason]));
}
