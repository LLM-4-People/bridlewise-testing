// RE-RUN THE MUTATION PLANTS OF EVERY CONSUMER OF A CHANGED MODULE.
//
// ── The rule this exists to make cheap (contract §28) ──────────────────────
//
// "When you add a throw to a shared helper, re-run the mutation plants of
// every guard that already calls it." That rule was reached the expensive way:
// one step made a shared walker refuse a shrunken universe, another set
// `process.exitCode` by hand in a teardown, each was green on its own subject,
// and composed they produced a run that DELETED a tracked source file and
// exited 0. Neither step's mutation set could have found it, because each
// mutated only its own subject.
//
// A rule that costs an agent twenty minutes of hand-assembled `vitest run`
// invocations gets skipped. This turns it into one command:
//
//     node scripts/verification/consumer-plants.ts <path-to-changed-module>
//
// ── Why the consumer set is DERIVED and never listed ──────────────────────
//
// §31b: a guard that lists its own universe by hand contains the defect it
// exists to end. The consumer set here is the reverse-reachability closure of
// the changed module over BYTE-READ import specifiers, across BOTH
// repositories, because the reach that mattered in the incident above crossed
// the repository boundary. A hand list would have been correct on the day it
// was written.
//
// ── What it refuses ───────────────────────────────────────────────────────
//
// An empty universe on either input: zero files scanned, or zero consumers
// found for a module that exists. "No consumers" and "the scan stopped
// working" are the same green run otherwise, and the second is the one that
// matters.
//
// ── Stated limits ─────────────────────────────────────────────────────────
//
//   * Only STATIC import/export specifiers are followed. A module reached by
//     `await import(expr)` with a computed specifier is invisible here, and so
//     is one reached by shelling out.
//   * A consumer with no test that imports it is REPORTED as uncovered rather
//     than silently dropped — that is a finding about the tree, not a reason
//     to say nothing.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { walk as ownedSourceWalk } from "./source-walk.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";

/**
 * The two TREES a run here can write to, and where their tests live.
 *
 * Before the monorepo assembly these were two sibling repositories. They are
 * now one repository with the engine nested inside it, so the second entry is
 * the enclosing root itself and its `sources` list is what NAMES it — the
 * engine tree is deliberately absent from that list, which is the only thing
 * keeping the two universes disjoint now that one contains the other.
 */
export type Repository = Readonly<{
  name: string;
  root: string;
  /** Subdirectories walked for source. */
  sources: readonly string[];
  /** How a test file in this repository is recognised, and how it is run. */
  testFile: (path: string) => boolean;
  runner: "vitest" | "node-test";
}>;

const INTEGRATION_ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");
const MONOREPO_ROOT = resolve(INTEGRATION_ROOT, "..");

const REPOSITORIES: readonly Repository[] = [
  {
    name: "integration",
    root: INTEGRATION_ROOT,
    sources: ["src", "test", "scripts"],
    testFile: (path) => path.endsWith(".test.ts"),
    runner: "node-test",
  },
  {
    name: "web",
    root: MONOREPO_ROOT,
    sources: ["src", "server", "shared", "tests", "scripts"],
    testFile: (path) => path.endsWith(".test.ts"),
    runner: "vitest",
  },
];

const SOURCE_EXTENSION = /\.(?:ts|tsx|mts|cts|js|mjs|svelte)$/u;

function walk(directory: string, out: string[]): string[] {
  // What the repository does not own (dependencies, build output) is pruned
  // by the shared ownership-pruned walk. An absent source root contributes
  // nothing here and the caller's zero-scanned refusal names it.
  if (!existsSync(directory)) return out;
  for (const path of ownedSourceWalk(directory, { exts: [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".svelte"] })) {
    if (SOURCE_EXTENSION.test(path)) out.push(path);
  }
  return out;
}

/**
 * Every static import/export specifier in a file's BYTES.
 *
 * Read as bytes rather than parsed: this tool must run before, during and
 * after edits that may not typecheck, so it cannot depend on a program that
 * builds. The cost is that a specifier written inside a template literal or a
 * comment is counted — which errs toward running MORE consumer plants, the
 * safe direction for this tool's purpose.
 */
// DRIVEN, and the first spelling was wrong in the direction that matters. It
// was `(?:^|\n)\s*(?:import|export)\b[^;\n]*?["']…["']`, whose `[^;\n]` cannot
// cross a newline — so every MULTI-LINE `import {\n  a,\n} from "…"` was
// invisible. Against `gitignore-anchoring.ts` that reported 2 consumers where
// the tree holds 6, and the two it missed in the other repository are exactly
// the ones §28b was written about. Anchoring on `from "…"` instead crosses
// lines by construction.
const SPECIFIER = /\bfrom\s*["']([^"']+)["']|(?:^|[\n;{])\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gu;

function specifiersOf(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(SPECIFIER)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (specifier !== undefined && specifier.startsWith(".")) out.push(specifier);
  }
  return out;
}

/** Resolve a relative specifier to a real file, or null. */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

export type ConsumerClosure = Readonly<{
  /** Every source file scanned, across both repositories. */
  scanned: readonly string[];
  /** Files that reach the subject through one or more static imports. */
  consumers: readonly string[];
  /** The consumers that are test files — the plants to re-run. */
  plants: readonly string[];
  /** Consumers that are NOT test files and that no test file reaches. */
  uncovered: readonly string[];
  /** Plain-words reason the closure cannot be believed, or `null`. */
  failure: string | null;
}>;

/**
 * Which files reach `subject`, and which of those are the plants to re-run.
 *
 * Exported and pure so a prevention test can drive it over planted trees; the
 * CLI below is a thin shell over it.
 */
export function consumerClosure(subject: string, repositories: readonly Repository[] = REPOSITORIES): ConsumerClosure {
  const scanned: string[] = [];
  for (const repository of repositories) {
    for (const source of repository.sources) walk(join(repository.root, source), scanned);
  }
  if (scanned.length === 0) {
    return {
      scanned,
      consumers: [],
      plants: [],
      uncovered: [],
      failure:
        "consumer-plants: scanned ZERO source files across " +
        `${String(repositories.length)} repository/ies. An empty universe agrees with every ` +
        "claim about it; either the roots moved or this scan has gone blind.",
    };
  }
  const target = resolve(subject);
  if (!existsSync(target)) {
    return { scanned, consumers: [], plants: [], uncovered: [], failure: `consumer-plants: ${target} does not exist.` };
  }

  // importer -> imported. Built once; the closure is walked backwards.
  const importedBy = new Map<string, Set<string>>();
  for (const file of scanned) {
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const specifier of specifiersOf(source)) {
      const imported = resolveSpecifier(file, specifier);
      if (imported === null) continue;
      const importers = importedBy.get(imported) ?? new Set<string>();
      importers.add(file);
      importedBy.set(imported, importers);
    }
  }

  const reached = new Set<string>();
  const queue = [target];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const importer of importedBy.get(current) ?? []) {
      if (reached.has(importer)) continue;
      reached.add(importer);
      queue.push(importer);
    }
  }

  const isTest = (path: string): boolean =>
    repositories.some((repository) => path.startsWith(repository.root + "/") && repository.testFile(path));

  const consumers = [...reached].sort();
  const plants = consumers.filter(isTest);
  const uncovered = consumers.filter((path) => !isTest(path) && !plants.some((plant) => plant === path));

  if (consumers.length === 0) {
    return {
      scanned,
      consumers,
      plants,
      uncovered: [],
      failure:
        `consumer-plants: ${target} exists and NOT ONE of ${String(scanned.length)} scanned files ` +
        "imports it, directly or transitively. A module with no consumers is a real state, and " +
        "so is a resolver that stopped resolving; they are the same empty answer here. If this " +
        "module is genuinely unreached, say so at the call site rather than reading this as a " +
        "clean bill of health.",
    };
  }
  if (plants.length === 0) {
    return {
      scanned,
      consumers,
      plants,
      uncovered,
      failure:
        `consumer-plants: ${String(consumers.length)} file(s) reach ${target} and NOT ONE of them ` +
        "is a test. There are no plants to re-run, which means this module's consumers are " +
        "unguarded — the answer §28 exists to prevent, arriving as an empty work list.",
    };
  }
  return { scanned, consumers, plants, uncovered, failure: null };
}

function repositoryOf(path: string): Repository | null {
  return REPOSITORIES.find((repository) => path.startsWith(repository.root + "/")) ?? null;
}

function main(): void {
  const subject = process.argv[2];
  if (subject === undefined) {
    process.stderr.write("usage: consumer-plants.ts <path-to-changed-module>\n");
    process.exitCode = 2;
    return;
  }
  const closure = consumerClosure(subject);
  process.stdout.write(
    `[consumer-plants] subject ${resolve(subject)}\n` +
      `  scanned   ${String(closure.scanned.length)} source files across ${String(REPOSITORIES.length)} repositories\n` +
      `  consumers ${String(closure.consumers.length)}\n` +
      `  plants    ${String(closure.plants.length)}\n`,
  );
  if (closure.failure !== null) {
    process.stderr.write(`${closure.failure}\n`);
    process.exitCode = 1;
    return;
  }
  for (const plant of closure.plants) {
    const repository = repositoryOf(plant)!;
    process.stdout.write(`    ${repository.name}: ${relative(repository.root, plant)}\n`);
  }
  if (closure.uncovered.length > 0) {
    process.stdout.write(`  UNCOVERED (reached by no test): ${String(closure.uncovered.length)}\n`);
    for (const path of closure.uncovered) process.stdout.write(`    ${path}\n`);
  }

  // Group by repository so each suite is invoked ONCE, and run them
  // sequentially — two full suites in parallel on one box measures the
  // neighbours (§26b).
  let failed = 0;
  for (const repository of REPOSITORIES) {
    const files = closure.plants
      .filter((plant) => plant.startsWith(repository.root + "/"))
      .map((plant) => relative(repository.root, plant));
    if (files.length === 0) continue;
    const [command, args] =
      repository.runner === "vitest"
        ? ["npx", ["vitest", "run", ...files, "--reporter=dot"]]
        : ["node", ["--experimental-strip-types", "--test", ...files]];
    process.stdout.write(`\n[consumer-plants] ${repository.name}: ${command} ${args.join(" ")}\n`);
    try {
      execFileSync(command, args, { cwd: repository.root, stdio: "inherit" });
    } catch {
      failed += 1;
      process.stdout.write(`[consumer-plants] ${repository.name}: FAILED\n`);
    }
  }
  process.stdout.write(
    failed === 0
      ? `\n[consumer-plants] RECEIPT: ${String(closure.plants.length)} consumer plant file(s) re-run, all green.\n`
      : `\n[consumer-plants] RECEIPT: ${String(failed)} repository/ies FAILED.\n`,
  );
  if (failed > 0) process.exitCode = 1;
}

// Run only when invoked as the entry point, so a test can import the closure
// without launching two suites.
if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  main();
}
