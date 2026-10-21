// @vitest-environment node
/**
 * THE WEB POPULATION, FROM ITS ONE OWNER — the files a full web run judges
 * and the files it deliberately leaves out.
 *
 * The population is the gate catalogue's (`engine/src/workflow/gates/`):
 * every file of the tree the runner's own globs (`TEST_INCLUDE`) select, less
 * the catalogue's declared exclusions, each with its reason (private
 * artifacts, a WSL host, a generated profile). The CI plan shards exactly
 * this population, so the budget's population count, the flaky memory guard
 * and CI can never disagree about it.
 */
import { resolve } from "node:path";

import { webPopulation } from "../../engine/src/workflow/gates/populations.ts";
import { TEST_INCLUDE } from "../test-include.ts";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..", "..");

/** Every file a full run judges. */
export function supportedTestFiles(): readonly string[] {
  return webPopulation(REPOSITORY_ROOT, TEST_INCLUDE).files;
}

/** Every declared exclusion, keyed by path, with the reason it cannot be judged here. */
export function excludedTestFiles(): ReadonlyMap<string, string> {
  return new Map(webPopulation(REPOSITORY_ROOT, TEST_INCLUDE).excluded.map((file) => [file.path, file.reason]));
}
