/**
 * THE SUITE POPULATIONS — which test files a suite gate runs, read from the
 * owners the runners themselves read, never from a hand-kept list:
 *
 *   - `web-tests`: every file of the tree that matches the web runner's
 *     declared globs (`TEST_INCLUDE`, `tests/test-include.ts` — the one binding
 *     `vitest.config.ts` spreads into `include`), less the catalogue's declared
 *     exclusions;
 *   - `engine-tests`: every source the engine's test inventory
 *     (`VERIFICATION_PATHS.testInventory` under the engine folder, regenerated
 *     by `harness sync`) runs.
 *
 * An exclusion that names a file the globs no longer match is a refusal: a
 * stale exclusion is a false statement about the population, and the seal
 * prints every exclusion on every receipt.
 */
import { readFileSync } from "node:fs";
import { matchesGlob } from "node:path";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { InputError } from "../../kernel/errors.ts";
import { deepFreeze } from "../../kernel/integrity.ts";
import { ownedFiles } from "../../git/repository-ownership.ts";
import { VERIFICATION_PATHS } from "../../kernel/verification-paths.ts";
import { ENGINE_FOLDER, POPULATION_EXCLUSIONS, type Population } from "./catalogue.ts";

/** Where each population's source of truth lives, repository-relative. */
const POPULATION_SOURCES = deepFreeze({
  "web-tests": "tests/test-include.ts",
  "engine-tests": `${ENGINE_FOLDER}/${VERIFICATION_PATHS.testInventory}`,
} as const satisfies Readonly<Record<Population, string>>);

export type PopulationListing = Readonly<{
  population: Population;
  source: string;
  files: readonly string[];
  excluded: readonly Readonly<{ path: string; reason: string; evidence: string }>[];
}>;

/** The web runner's globs, from the module the runner itself imports. */
async function webIncludeGlobs(repositoryRoot: string): Promise<readonly string[]> {
  const module = await import(pathToFileURL(join(repositoryRoot, POPULATION_SOURCES["web-tests"])).href) as { TEST_INCLUDE?: unknown };
  const globs = module.TEST_INCLUDE;
  if (!Array.isArray(globs) || globs.length === 0 || globs.some((glob) => typeof glob !== "string" || glob.length === 0)) {
    throw new InputError(`${POPULATION_SOURCES["web-tests"]} exports no TEST_INCLUDE glob list`, "gate_population_unreadable");
  }
  return globs as readonly string[];
}

/** The engine inventory's test sources (engine-relative there), repository-relative here, sorted and unique. */
function engineInventorySources(repositoryRoot: string): readonly string[] {
  const path = POPULATION_SOURCES["engine-tests"];
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(join(repositoryRoot, path), "utf8"));
  } catch (error) {
    throw new InputError(`${path} is not readable JSON (${(error as Error).message})`, "gate_population_unreadable");
  }
  const tests = (document as { tests?: unknown }).tests;
  if (!Array.isArray(tests) || tests.length === 0) throw new InputError(`${path} lists no tests`, "gate_population_unreadable");
  const sources = new Set<string>();
  for (const entry of tests) {
    const sourceId = (entry as { sourceId?: unknown }).sourceId;
    if (typeof sourceId !== "string" || sourceId.length === 0 || sourceId.startsWith("/") || sourceId.split("/").includes("..")) {
      throw new InputError(`${path} has a test without a repository-relative sourceId`, "gate_population_unreadable");
    }
    sources.add(`${ENGINE_FOLDER}/${sourceId}`);
  }
  return [...sources].toSorted();
}

/** The listing of `population` from the files it `selected`, less its declared exclusions (a stale exclusion is a refusal). */
function excludeDeclared(population: Population, selected: readonly string[]): PopulationListing {
  const excluded: readonly Readonly<{ path: string; reason: string; evidence: string }>[] = POPULATION_EXCLUSIONS[population];
  const selectedSet = new Set(selected);
  const stale = excluded.filter((entry) => !selectedSet.has(entry.path));
  if (stale.length > 0) {
    throw new InputError(`${population}: excluded file(s) the population no longer selects (remove the exclusion): ${stale.map((entry) => entry.path).join(", ")}`, "gate_population_stale_exclusion");
  }
  const excludedSet = new Set<string>(excluded.map((entry) => entry.path));
  const files = selected.filter((path) => !excludedSet.has(path));
  if (files.length === 0) throw new InputError(`${population} selects no test file`, "gate_population_empty");
  return deepFreeze({ population, source: POPULATION_SOURCES[population], files, excluded: excluded.map((entry) => ({ ...entry })) });
}

/**
 * The web population of the working tree at `repositoryRoot` for the runner's
 * `globs` (the caller passes `TEST_INCLUDE`; a test helper imports it
 * statically, the CLI loads it from the tree). Synchronous: the budget
 * reporter counts it inside a run.
 */
export function webPopulation(repositoryRoot: string, globs: readonly string[]): PopulationListing {
  const owned = ownedFiles(repositoryRoot);
  if (owned === undefined) throw new InputError(`${repositoryRoot} is not a git working tree`, "gate_population_unreadable");
  return excludeDeclared("web-tests", owned.filter((path) => globs.some((glob) => matchesGlob(path, glob))).toSorted());
}

/** Lists `population` for the working tree at `repositoryRoot` (the files a clone of it would hold). */
export async function listPopulation(repositoryRoot: string, population: Population): Promise<PopulationListing> {
  if (population === "web-tests") return webPopulation(repositoryRoot, await webIncludeGlobs(repositoryRoot));
  return excludeDeclared(population, engineInventorySources(repositoryRoot));
}
