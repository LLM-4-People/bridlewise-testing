/**
 * EVERY `include` PATTERN IN EVERY TSCONFIG MUST SELECT AT LEAST ONE FILE.
 *
 * ── THE DEFECT, DRIVEN ────────────────────────────────────────────────────
 *
 * TypeScript reports `TS18003 No inputs were found` only when a config's
 * include patterns select nothing AT ALL. When ONE pattern of several dies,
 * `tsc` compiles the survivors and EXITS 0. Measured on a throwaway tree, a
 * planted type error in the dropped half:
 *
 *   both patterns live  → exit non-zero, the planted error is reported
 *   one pattern dead    → EXIT 0, the planted error is simply not compiled
 *   all patterns dead   → exit non-zero, TS18003
 *
 * So a rename as ordinary as `test/` → `tests/` takes this project's
 * typecheck from 1,064 files to 588 AND LEAVES IT GREEN, carrying the
 * composite `check` gate green with it. Fourteen include patterns are
 * declared across the two repositories; twelve of them can die this way in
 * silence. Only the two that are a config's SOLE pattern are loud.
 *
 * That is the shape every silent failure here shares: a PARTIAL loss of a
 * universe is invisible, and only a TOTAL loss is caught. A file count on the
 * whole program cannot see it either — the surviving patterns keep the total
 * comfortably large — so the check has to be keyed to the PART.
 *
 * ── WHERE THIS RUNS, AND WHY HERE ─────────────────────────────────────────
 *
 * Chained ahead of `tsc` in each repository's `typecheck` script: the one
 * door every gate goes through. `tsc` itself cannot be made to refuse a
 * partially-dead include — there is no compiler flag for it, which is why
 * this is a runtime refusal at the choke point rather than a compiler
 * setting.
 *
 * ── AND THE CONFIGS ARE DISCOVERED, NEVER LISTED ──────────────────────────
 *
 * The set of tsconfigs is read from the filesystem, so adding
 * `tsconfig.<anything>.json` is covered without anybody remembering to add
 * it here. Finding NONE is a refusal, not a pass: a checker that examined
 * nothing and reported success is the failure this file exists to end,
 * committed by the file itself.
 *
 * Usage: `node scripts/verification/tsconfig-include-liveness.ts [root]`
 * (root defaults to the working directory).
 */
import { globSync, readFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { globMatchCounts, patternLivenessFailure } from "./pattern-liveness.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";

/**
 * Parse, or say plainly that it could not be parsed.
 *
 * TypeScript accepts comments and trailing commas in a tsconfig, so a strict
 * `JSON.parse` alone would refuse a legitimate file; `readTsconfig` below
 * tries the strict form first (every config in this project takes that path)
 * and the tolerant form second. Absence is returned rather than a default,
 * because a config that cannot be read has an UNKNOWN file set and treating
 * that as an empty one is how a checker comes to examine nothing and pass.
 */
function parseOrNull(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    // REPORTED BY RETURNING ABSENCE, never swallowed: the caller decides
    // whether a failed parse is recoverable, and the one place that decides
    // raises an error naming the file. A `catch` that produced a value here
    // would turn "this config is malformed" into "this config is empty",
    // which is the shape that makes a checker examine nothing and pass.
    void error;
    return null;
  }
}

function readTsconfig(path: string): Record<string, unknown> {
  const text = readFileSync(path, "utf8");
  const direct = parseOrNull(text);
  if (direct !== null) return direct;
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/,(\s*[}\]])/g, "$1");
  const tolerant = parseOrNull(stripped);
  if (tolerant !== null) return tolerant;
  throw new Error(
    `${path} is not parseable as a tsconfig, with or without comments and trailing commas. ` +
    `A config that cannot be read has an unknown file set, which is not the same as an empty one.`,
  );
}

/** A string array field, or `undefined` when the field is absent. */
function stringArray(config: Record<string, unknown>, key: string): readonly string[] | undefined {
  const value = config[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`tsconfig field ${JSON.stringify(key)} must be an array of strings`);
  }
  return value as readonly string[];
}

/**
 * The `include`/`exclude`/`files` a config EFFECTIVELY declares, following
 * `extends` for any field the config does not state itself — which is
 * TypeScript's own rule, and the reason a config that only overrides
 * `compilerOptions` still has a file set to check.
 *
 * Each field is resolved against the directory of the config that DECLARED
 * it, again matching TypeScript, so an inherited pattern is judged where its
 * author meant it rather than where the extending file happens to sit.
 */
type ResolvedFileSet = Readonly<{
  include: readonly string[] | undefined;
  exclude: readonly string[];
  files: readonly string[] | undefined;
  /** Directory the patterns are relative to. */
  baseDir: string;
  /** The config that actually declared `include`, for the failure message. */
  declaredIn: string;
}>;

function resolveFileSet(path: string, seen: Set<string> = new Set()): ResolvedFileSet {
  const real = resolve(path);
  if (seen.has(real)) throw new Error(`tsconfig extends cycle at ${real}`);
  seen.add(real);
  const config = readTsconfig(real);
  const include = stringArray(config, "include");
  const files = stringArray(config, "files");
  const exclude = stringArray(config, "exclude");
  const baseDir = dirname(real);
  if (include !== undefined || files !== undefined) {
    return { include, files, exclude: exclude ?? [], baseDir, declaredIn: real };
  }
  const extendsField = config["extends"];
  if (typeof extendsField !== "string") {
    // Neither stated nor inherited: TypeScript defaults to everything under
    // the config's directory. There is no declared pattern to be dead, so
    // there is nothing here for this check to judge — and saying so is the
    // honest answer rather than inventing a pattern to pass.
    return { include: undefined, files: undefined, exclude: exclude ?? [], baseDir, declaredIn: real };
  }
  const parentPath = isAbsolute(extendsField) ? extendsField : join(baseDir, extendsField);
  const parent = resolveFileSet(existsSync(parentPath) ? parentPath : `${parentPath}.json`, seen);
  return { ...parent, exclude: exclude ?? parent.exclude };
}

/**
 * A tsconfig `exclude` entry naming a bare directory excludes everything
 * BENEATH it, which the glob matcher only does when it is told to. Expanding
 * both spellings keeps this check's arithmetic the same as the compiler's; a
 * narrower exclude here would call a pattern live on files `tsc` never reads.
 */
function expandExcludes(exclude: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const entry of exclude) {
    out.push(entry);
    if (!entry.includes("*")) out.push(`${entry}/**`);
  }
  return out;
}

export type TsconfigLivenessReport = Readonly<{
  config: string;
  /** null when the config declares no include patterns to judge. */
  failure: string | null;
  perPattern: readonly (readonly [string, number])[];
}>;

/** Judge ONE tsconfig. Exported so a guard can drive it without a subprocess. */
export function checkTsconfigIncludeLiveness(path: string): TsconfigLivenessReport {
  const set = resolveFileSet(path);
  if (set.include === undefined) {
    return { config: resolve(path), failure: null, perPattern: [] };
  }
  const matches = globMatchCounts(set.include, set.baseDir, expandExcludes(set.exclude));
  return {
    config: resolve(path),
    failure: patternLivenessFailure(`${set.declaredIn} include`, matches),
    perPattern: matches.map((m) => [m.pattern, m.matched] as const),
  };
}

/** Every tsconfig at a repository root, discovered rather than listed. */
export function discoverTsconfigs(root: string): readonly string[] {
  return globSync("tsconfig*.json", { cwd: root })
    .map((name) => join(root, name))
    .sort();
}

export function checkRepository(root: string): readonly TsconfigLivenessReport[] {
  const configs = discoverTsconfigs(root);
  if (configs.length === 0) {
    throw new Error(
      `no tsconfig*.json found under ${resolve(root)}. A liveness check that examined ` +
      `nothing and reported success is the defect it exists to prevent.`,
    );
  }
  return configs.map(checkTsconfigIncludeLiveness);
}

function main(): void {
  const root = process.argv[2] ?? process.cwd();
  const reports = checkRepository(root);
  const failures = reports.filter((r) => r.failure !== null);
  for (const report of reports) {
    const detail = report.perPattern.map(([p, n]) => `${p}→${n}`).join(" ");
    process.stdout.write(
      `tsconfig include liveness: ${report.config} ${detail.length === 0 ? "(no include patterns declared)" : detail}\n`,
    );
  }
  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`${failure.failure}\n`);
    process.exitCode = 1;
  }
}

// Run only when invoked directly, so importing this module for a test does
// not set an exit code on the importing process.
if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  main();
}
