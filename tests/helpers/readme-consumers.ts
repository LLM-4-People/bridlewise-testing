/**
 * GENERATE the README "what consumes it" section from the import graph.
 *
 * ── THE DEFECT THIS ENDS ──────────────────────────────────────────────────
 *
 * Each product folder's README carries a "Where it lives and what consumes it"
 * section listing, per file, the modules that import it. Those lists were
 * generated ONCE at folder-organization time and then frozen as prose. A
 * consumer added or removed afterwards never updates the prose, so the README
 * silently rots — a reader trusts a list that no longer matches the tree, and
 * no guard noticed (the freshness guard only checks the FILE list, not the
 * consumer list). That is a generated-then-frozen static list: a second source
 * of truth that drifts.
 *
 * The fix is to make the consumer section a PROJECTION of the import graph —
 * generated from the resolver's reverse-lookup (`module-resolver.ts`), never
 * hand-maintained. A projection cannot drift: this generator recomputes it,
 * and `--check` (wired into the freshness guard) reds the moment the README
 * and the graph disagree.
 *
 * ── THE GENERATED MARKERS ─────────────────────────────────────────────────
 *
 * The consumer section is bracketed by markers so the generator owns exactly
 * that block and nothing else in the README:
 *
 *   <!-- consumers:generated --> … <!-- /consumers:generated -->
 *
 * Everything between the markers is regenerated; everything outside is the
 * folder's hand-authored prose and is never touched. A README without the
 * markers is left alone (the generator only refreshes sections that OPT IN by
 * carrying the markers), and the `--check` mode reports a README whose
 * generated block is stale. The markers and this generator's path are
 * declared ONCE, in the engine (`README_CONSUMER_BLOCK`,
 * engine/src/kernel/verification-paths.ts).
 *
 * THE BLOCKS ARE GENERATED OUTPUTS OF `harness sync` (WF-DEL leftover): the
 * sync pass runs `--write`, `harness check` runs `--check` (drift is a failing
 * `readme-consumers` step), and every README carrying the marker is in the
 * generated-output set (`generatedOutputPaths`), so a candidate's copy-back
 * carries its regenerated blocks. Nobody runs this by hand any more; the
 * flags below are the arm's protocol (one JSON line on stdout):
 *   node tests/helpers/readme-consumers.ts --write [--root=<repository root>]  # rewrite in place
 *   node tests/helpers/readme-consumers.ts --check [--root=<repository root>]  # report drift, exit 1
 */
import { existsSync, readdirSync } from "node:fs";
import { atomicWriteFile } from "../../engine/src/filesystem/atomic-write.ts";
import { README_CONSUMER_BLOCK } from "../../engine/src/kernel/verification-paths.ts";
import { generatedReadmePaths } from "../../engine/src/workflow/hash-binding-registry.ts";
import { join, posix, relative, sep, isAbsolute } from "node:path";

import { consumersOfKnownPath, productRoots } from "./module-resolver.ts";
import { moduleSpecifiers, read } from "./source-scan.ts";
import { bootstrapProcess, isEntryPoint } from "../../engine/src/runtime/cli-debug.ts";

// The repository root the generator projects against. Default is the testing
// tree (process.cwd()); the master tree passes its own root so the SAME
// generator writes both trees' READMEs (the generated content is a projection
// of one import graph, not two hand-maintained lists).
let REPO = process.cwd();

/** Point the generator at a different repository root (the master tree). */
export function setReadmeRepoRoot(root: string): void {
  REPO = root;
}

/** A path made repo-relative and forward-slashed, for the shared reader. */
function relativeToRepo(path: string): string {
  return relative(REPO, path).split(sep).join("/");
}

/** Read a file that lives under REPO (the target tree). `relativeToRepo`
 *  produces a path relative to REPO, but `read()` resolves against the
 *  process cwd — which is the WRONG tree when the generator targets a
 *  different root (master). Anchor the read at REPO so the bytes come from
 *  the tree being documented. */
function readInRepo(path: string): string {
  return read(isAbsolute(path) ? path : join(REPO, path));
}
const BEGIN = README_CONSUMER_BLOCK.begin;
const END = README_CONSUMER_BLOCK.end;

/**
 * The stable parse + read functions the consumer graph is keyed on. They are
 * module-level (not per-call closures) so the graph cache in the resolver hits
 * across every README refresh in a run — one walk of the tree, shared.
 * `readModuleSource` reads a module's bytes for the import-graph; the graph
 * reads CODE, which is what the specifier parse needs.
 */
function parseAll(source: string): readonly string[] {
  return moduleSpecifiers(source, "all");
}
function readModuleSource(path: string): string {
  // The suite's single sanctioned file-read, so the import graph is built
  // through the one utility the prevention suite owns for reading source
  // bytes (UTF-8, decided once) — not a local readFileSync. The graph passes
  // an absolute candidate (it walks from the anchored root); a repo-relative
  // path (a direct caller) is joined onto REPO first.
  return read(isAbsolute(path) ? path : join(REPO, path));
}

/** How many consumers to list before collapsing the rest into "and N more". */
const SHOWN = 6;

/** The per-file consumer line, in the README's established voice. */
function consumerLine(fileName: string, consumers: readonly string[]): string {
  if (consumers.length === 0) {
    return `- \`${fileName}\` is consumed by nothing yet.`;
  }
  const shown = consumers.slice(0, SHOWN).map((c) => `\`${c}\``);
  const rest = consumers.length - shown.length;
  const list = shown.join(", ");
  return rest > 0
    ? `- \`${fileName}\` is consumed by ${list} and ${rest} more.`
    : `- \`${fileName}\` is consumed by ${list}.`;
}

/** The source files directly inside a folder (one level), sorted. */
function folderFiles(dir: string): readonly string[] {
  return readdirSync(join(REPO, dir), { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(ts|mts|cts|mjs)$/.test(e.name) && e.name !== "README.md")
    .map((e) => e.name)
    .sort();
}

/** The generated consumer block for one folder's README. */
function generatedBlock(dir: string, folderLabel: string): string {
  const lines: string[] = [
    BEGIN,
    "",
    `The folder lives at \`${folderLabel}/\`.`,
    "",
  ];
  // The graph is built ONCE per process and cached (keyed on the stable
  // module-level `parse`/`readSource` functions below), so refreshing many
  // READMEs shares one walk of the tree rather than re-walking per folder.
  for (const fileName of folderFiles(dir)) {
    const consumers = consumersOfKnownPath(`${dir}/${fileName}`, parseAll, readModuleSource, REPO);
    lines.push(consumerLine(fileName, consumers));
  }
  lines.push("", END);
  return lines.join("\n");
}

/**
 * Refresh one README's generated consumer block. Returns the new content, or
 * null when the README carries no generated markers (it opts out). Throws when
 * a README has a BEGIN with no END (a half-written block is a defect, not a
 * skip).
 */
export function refreshReadmeConsumers(readmeAbs: string, dir: string, folderLabel: string): string | null {
  const text = readInRepo(readmeAbs);
  const beginAt = text.indexOf(BEGIN);
  if (beginAt === -1) return null;
  const endAt = text.indexOf(END);
  if (endAt === -1) {
    throw new Error(
      `readme-consumers: ${readmeAbs} has a ${BEGIN} marker with no closing ${END} — a ` +
        `half-written generated block. Restore the closing marker so the generator owns a ` +
        `well-delimited section.`,
    );
  }
  const block = generatedBlock(dir, folderLabel);
  // The generated section owns the file's tail newline: a README that hands
  // its block to the generator gets exactly one final newline back, no matter
  // how many blank lines the previous bytes carried. The block is the
  // projection; a run of trailing blank lines after the closing marker is
  // generator output too, not author content, so it is normalized away here
  // rather than left to accumulate one per refresh.
  let afterEnd = endAt + END.length;
  const rest = text.slice(afterEnd);
  if (rest.length > 0 && rest.trim().length === 0) afterEnd = text.length;
  const next = text.slice(0, beginAt) + block + text.slice(afterEnd);
  return next.endsWith("\n") ? next : `${next}\n`;
}

/**
 * Bootstrap a README whose hand-written `## Where it lives and what consumes
 * it` section predates the generator: replace that section (which runs to the
 * next heading or end-of-file) with the marker-delimited generated block.
 * Returns the new content, or null when the README has no such section or is
 * already generated. The hand-written list is discarded — it is the
 * generated-then-frozen static list this generator exists to replace.
 */

/** Every README write goes through the shared write primitive (and so the
 * checkout write door: a test cannot regenerate the live READMEs). */
function writeReadme(path: string, text: string): void {
  const result = atomicWriteFile(path, text);
  if (!result.success) throw new Error(`could not write ${path}: ${result.reason ?? "unknown"}`);
}

export function bootstrapReadmeConsumers(readmeAbs: string, dir: string, folderLabel: string): string | null {
  const text = readInRepo(readmeAbs);
  if (text.includes(BEGIN)) return null; // already generated
  const heading = "## Where it lives and what consumes it";
  const start = text.indexOf(heading);
  if (start === -1) return null;
  const afterHeading = start + heading.length;
  const nextHeading = text.indexOf("\n## ", afterHeading);
  const sectionEnd = nextHeading === -1 ? text.length : nextHeading + 1;
  const block = generatedBlock(dir, folderLabel);
  const next = `${text.slice(0, afterHeading)}\n\n${block}\n\n${text.slice(sectionEnd)}`;
  return next.endsWith("\n") ? next : `${next}\n`;
}

/** Recursively yield every directory under `abs` that holds a README.md,
 *  at any depth — a domain folder at a root's first level and a populated
 *  subfolder beneath it are both subject to the same consumer projection. */
function* readmesUnder(abs: string, root: string): Generator<{ abs: string; dir: string; label: string }> {
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return;
  }
  const readme = join(abs, "README.md");
  const dir = relativeToRepo(abs);
  if (existsSync(readme)) yield { abs: readme, dir, label: dir };
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    yield* readmesUnder(join(abs, entry.name), root);
  }
}

/**
 * Every README this generator projects: THE ONE SELECTION the engine's
 * generated-output set also reads (`generatedReadmePaths`: every owned
 * README.md carrying the begin marker), so no marked README is an output
 * nobody regenerates (wf-del2-design D2: `shared/README.md` sat outside the
 * product roots this used to walk, and its block was never projected).
 */
function* readmesWithMarkers(): Generator<{ abs: string; dir: string; label: string }> {
  const repository = REPO;
  for (const path of generatedReadmePaths(repository)) {
    const dir = posix.dirname(path);
    yield { abs: join(repository, path), dir, label: dir };
  }
}

// Compared by REAL path: Node runs a script reached through a symbolic link
// under its real path, so the literal `argv[1]` of a linked checkout never
// equalled `import.meta.url` and the generator silently did nothing, exit 0.
if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const write = args.includes("--write");
  const bootstrap = args.includes("--bootstrap");
  if (check === write || (bootstrap && check)) {
    // A refusal is thrown, never `process.exit()`, which can deadlock at shutdown (Node #54918, #351).
    throw new Error("usage: readme-consumers.ts --check|--write [--bootstrap] [--root=<repository root>] (harness sync runs --write, harness check runs --check)");
  }
  const rootFlag = args.find((a) => a.startsWith("--root="));
  if (rootFlag !== undefined) setReadmeRepoRoot(rootFlag.slice("--root=".length));
  const changed: string[] = [];
  let readmes = 0;
  let bootstrapped = 0;
  // In bootstrap mode, first convert every folder README that still carries a
  // hand-written consumer section, then refresh all generated blocks.
  if (bootstrap) {
    for (const root of productRoots()) {
      const absRoot = join(REPO, root);
      if (!existsSync(absRoot)) continue;
      for (const { abs: readme, dir } of readmesUnder(absRoot, root)) {
        const next = bootstrapReadmeConsumers(readme, dir, dir);
        if (next === null) continue;
        writeReadme(readme, next);
        bootstrapped += 1;
      }
    }
  }
  for (const { abs, dir, label } of readmesWithMarkers()) {
    const next = refreshReadmeConsumers(abs, dir, label);
    if (next === null) continue;
    readmes += 1;
    if (next === readInRepo(abs)) continue;
    changed.push(relativeToRepo(abs));
    if (write) writeReadme(abs, next);
  }
  // ONE JSON line (the harness sync/check arm parses it): `changed` is what a
  // --write rewrote, or what a --check found stale (the import graph moved).
  console.log(JSON.stringify({ allCurrent: write || changed.length === 0, status: changed.length === 0 ? "current" : write ? "regenerated" : "stale", readmes, bootstrapped, changed }));
  if (check && changed.length > 0) process.exitCode = 1;
}
