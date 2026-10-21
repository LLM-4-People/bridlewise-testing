// @vitest-environment node
/**
 * THE BRIEFING NAMES WHAT EXISTS.
 *
 * An agent with no prior context is briefed by the repository itself: the
 * root `AGENTS.md`, every document it links (the "Read first" list and the
 * hazards' references), every process document (`docs/process/`: all of them,
 * so a page no index links is still judged), and every decision — derived
 * from the links, never listed (wf-1b3a-design M9: a hand list missed the
 * three largest briefing documents). A path, a script or a command in them
 * that no longer exists misroutes every agent that reads it (a stale hazard in
 * a brief and a `/tmp` rule in a contract both did). Checked here, for each of
 * those documents:
 *
 * - every Markdown link to a local file resolves, by the one link resolution
 *   (`engine/src/workflow/record-links.ts`: a file or folder git holds, or
 *   `evidence:<path>` an evidence manifest records);
 * - a process document's hand-written absolute GitHub URL that names another
 *   process document is refused (`scripts/repository-links.ts`): the relative
 *   link is the one this guard can resolve, and the absolute ones once all
 *   pointed at the product repository's `CONTRIBUTING.md`;
 * - every backticked path under one of the repository's own top-level
 *   entries names something git holds (a tracked file, or a folder holding
 *   one) at the repository root or under `engine/` (the engine's own
 *   documents and commands name paths relative to it), or a path an evidence
 *   manifest records (its bytes are in the evidence store, and
 *   `harness evidence materialize` brings them back); runtime state
 *   (`.bridlewise/`) and placeholders (`<x>`, `*`, `…`, `~`, `$`) are not
 *   paths;
 * - every backticked command's `npm run <script>` names a script of the
 *   `package.json` it runs in, and its `node <file>` names a file git holds
 *   (a leading `cd <dir> &&` sets where both are resolved);
 * - a fenced `ts`/`js` example's relative import specifier names a file git
 *   holds: the example is written as a test beside its subject, so
 *   `../../server/x.ts` is repository path `server/x.ts` (the leading `./`
 *   and `../` segments are stripped and the remainder is resolved at the root
 *   or under `engine/`).
 */
import { describe, expect, test } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { trackedFiles } from "../../engine/src/git/repository-ownership.ts";
import { recordedEvidence, recordedUnder } from "../../engine/src/workflow/evidence-store.ts";
import { deadLinkReason, type LinkHoldings } from "../../engine/src/workflow/record-links.ts";
import { absoluteProcessDocLinkReason } from "../../scripts/repository-links.ts";
import { extractMarkdown, parseProse } from "../../shared/markdown.ts";

const ROOT = process.cwd();

/** A briefing document's text (Markdown: prose is the subject, so no source view applies). */
function readDocument(root: string, path: string): string {
  return readFileSync(join(root, path), "utf8");
}

/** The local Markdown documents the document at `path` (repository-relative) with `text` links to, repository-relative. */
function linkedDocuments(root: string, path: string, text: string): readonly string[] {
  return extractMarkdown(text).links
    .map((link) => link.target.split("#")[0]!)
    .filter((target) => target.endsWith(".md") && !/^[a-z]+:/u.test(target))
    .map((target) => normalize(join(dirname(path), target)).split("\\").join("/"))
    .filter((target) => existsSync(join(root, target)));
}

/**
 * The briefing documents, repository-relative: the root `AGENTS.md`, every
 * document it links, every process document (`docs/process/`), and every
 * decision. Every process document is included by the directory, not only the
 * ones an index happens to link, so an orphaned page such as MERGE-GUIDE.md is
 * still held to the same liveness.
 */
function briefingDocuments(root: string): readonly string[] {
  const linksOf = (path: string): readonly string[] => linkedDocuments(root, path, readDocument(root, path));
  const first = linksOf("AGENTS.md");
  const second = first.flatMap(linksOf).filter((path) => path.startsWith("docs/process/"));
  const processDocuments = readdirSync(join(root, "docs/process")).filter((name) => name.endsWith(".md")).map((name) => `docs/process/${name}`);
  const decisions = readdirSync(join(root, "docs/decisions")).filter((name) => name.endsWith(".md")).map((name) => `docs/decisions/${name}`);
  return [...new Set(["AGENTS.md", ...first, ...second, ...processDocuments, ...decisions])].sort();
}

type Holdings = LinkHoldings & Readonly<{
  /** The top-level entries of the repository. */
  topLevel: ReadonlySet<string>;
  /** The scripts of the `package.json` in `directory` (repository-relative; "" is the root). */
  scripts: (directory: string) => ReadonlySet<string>;
}>;

const PLACEHOLDER = /[<>*…~$\s]|^https?:/u;

/** Every way the document at `path` (repository-relative) with `text` names what does not exist. */
export function briefingViolations(path: string, text: string, holdings: Holdings): readonly string[] {
  const problems: string[] = [];
  const repositoryPath = (base: string, target: string): string => normalize(join(base, target)).split("\\").join("/").replace(/\/$/u, "");
  const parsed = extractMarkdown(text);
  for (const link of parsed.links) {
    const absolute = absoluteProcessDocLinkReason(path, link.target);
    if (absolute !== undefined) problems.push(`${path}: the link ${absolute}`);
    const reason = deadLinkReason(path, link.target, holdings);
    if (reason !== undefined) problems.push(`${path}: the link ${reason}`);
  }
  /** Held at the repository root (or recorded by an evidence manifest), or under the engine (the engine's documents and commands name paths relative to it). */
  const heldAnywhere = (relativePath: string): boolean => holdings.holds(relativePath) || holdings.recorded(relativePath) || holdings.holds(repositoryPath("engine", relativePath));
  // The code spans, from the one Markdown parser (a span may wrap across
  // lines; a fenced block is an example, not a claim, and holds none).
  for (const codeSpan of parsed.codeSpans) {
    const span = codeSpan.text.replace(/\s+/gu, " ").trim();
    if (/\s/u.test(span)) {
      const cd = /^cd\s+(\S+)\s*&&\s*/u.exec(span);
      const base = cd === null ? "" : repositoryPath("", cd[1]!);
      if (cd !== null && PLACEHOLDER.test(cd[1]!)) continue;
      for (const run of span.matchAll(/\bnpm run ([\w:.-]+)/gu)) {
        if (!holdings.scripts(base).has(run[1]!)) problems.push(`${path}: \`${span}\` runs the npm script ${run[1]!}, which ${base || "the root"}'s package.json does not declare`);
      }
      for (const node of span.matchAll(/\bnode(?:\s+--[\w-]+(?:=\S+)?)*\s+([^\s-][^\s]*)/gu)) {
        const file = node[1]!;
        if (PLACEHOLDER.test(file) || !/\.[cm]?[jt]s$/u.test(file)) continue;
        const resolved = repositoryPath(base, file);
        if (!(cd === null ? heldAnywhere(resolved) : holdings.holds(resolved))) problems.push(`${path}: \`${span}\` runs ${resolved}, which git does not hold`);
      }
      continue;
    }
    if (PLACEHOLDER.test(span) || !span.includes("/")) continue;
    const first = span.split("/")[0]!;
    if (first === ".bridlewise" || !holdings.topLevel.has(first)) continue;
    if (!heldAnywhere(repositoryPath("", span))) problems.push(`${path}: \`${span}\` names a path git does not hold`);
  }
  // A fenced example is executable prose, not an arbitrary quotation: its
  // relative imports must name a file this repository holds. The example is
  // written beside its subject (`tests/unit/x.test.ts`), so
  // `../../server/x.ts` is repository path `server/x.ts`; strip the leading
  // `./` and `../` segments and ask git at the root or under `engine/`.
  for (const block of parseProse(text)) {
    if (block.type !== "code" || !/^(?:ts|typescript|tsx|js|javascript)$/u.test(block.lang)) continue;
    for (const match of block.code.matchAll(/\bfrom\s+["']([^"']+)["']/gu)) {
      const specifier = match[1]!;
      if (!specifier.startsWith(".")) continue;
      const resolved = specifier.replace(/^(?:\.\.?\/)+/u, "");
      if (resolved.length === 0 || PLACEHOLDER.test(resolved)) continue;
      if (!heldAnywhere(resolved)) problems.push(`${path}: the fenced example imports ${specifier}, which resolves to ${resolved}, a file git does not hold`);
    }
  }
  return problems;
}

function repositoryHoldings(root: string): Holdings {
  const tracked = trackedFiles(root) ?? [];
  const files = new Set(tracked);
  const folders = new Set<string>();
  for (const file of tracked) {
    const parts = file.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) folders.add(parts.slice(0, depth).join("/"));
  }
  const cache = new Map<string, ReadonlySet<string>>();
  const recorded = recordedEvidence(root);
  return {
    holds: (path) => files.has(path) || folders.has(path),
    recorded: (path) => recordedUnder(recorded, path).length > 0,
    topLevel: new Set(tracked.map((file) => file.split("/")[0]!)),
    scripts: (directory) => {
      let scripts = cache.get(directory);
      if (scripts === undefined) {
        const manifest = join(root, directory, "package.json");
        scripts = new Set(existsSync(manifest) ? Object.keys((JSON.parse(readFileSync(manifest, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {}) : []);
        cache.set(directory, scripts);
      }
      return scripts;
    },
  };
}

/**
 * The `concurrency` block of a workflow file, exactly as its YAML states it:
 * the group and whether a newer run cancels the one in flight.
 */
function workflowConcurrency(path: string): Readonly<{ group: string; cancelInProgress: boolean }> {
  const lines = readFileSync(join(ROOT, path), "utf8").split("\n");
  const start = lines.findIndex((line) => /^concurrency:\s*$/u.test(line));
  // Read the block line by line: the YAML keys are the anchors, and a regex
  // spanning them would be a proximity window no matter how it is bounded.
  const block: string[] = [];
  for (let index = start + 1; start >= 0 && index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || !/^[ \t]+\S/u.test(line)) break;
    block.push(line);
  }
  const group = block.map((line) => /^[ \t]+group:\s*(.+?)\s*$/u.exec(line)?.[1]).find((value) => value !== undefined);
  const cancel = block.map((line) => /^[ \t]+cancel-in-progress:\s*(true|false)\s*$/u.exec(line)?.[1]).find((value) => value !== undefined);
  expect(group, `${path} states no concurrency group`).toBeDefined();
  expect(cancel, `${path} states no cancel-in-progress`).toBeDefined();
  if (group === undefined || cancel === undefined) return { group: "", cancelInProgress: false };
  return { group: group!, cancelInProgress: cancel === "true" };
}

/** The concurrency values `docs/process/AGENTS.md` states for `workflow`, from its table row. */
function statedConcurrency(page: string, workflow: string): Readonly<{ group: string; cancelInProgress: boolean }> | undefined {
  const row = page.split("\n").find((line) => line.trim().startsWith(`| \`${workflow}\``));
  if (row === undefined) return undefined;
  const cells = row.split("|").slice(1, -1).map((cell) => cell.trim().replace(/^`|`$/gu, ""));
  const group = cells[1];
  const cancel = cells[2];
  if (group === undefined || cancel === undefined) return undefined;
  return { group, cancelInProgress: cancel === "true" };
}

describe("the agent briefing names what exists", () => {
  test("every link, path, npm script and node file in the briefing documents exists", () => {
    const holdings = repositoryHoldings(ROOT);
    expect(holdings.topLevel.size, "git answered no tracked files").toBeGreaterThan(0);
    const documents = briefingDocuments(ROOT);
    expect(documents.length).toBeGreaterThan(10);
    // The derivation reaches the "Read first" documents, every process document,
    // and the page that is not linked from any index (it once cited a private-only feature).
    for (const reached of [
      "docs/process/AGENTS.md",
      "docs/process/WORKFLOW.md",
      "docs/process/ROLES.md",
      "docs/process/MERGE-GUIDE.md",
      "engine/AGENTS.md",
      "docs/process/TIER1-AGENT-CONTRACT.md",
    ]) {
      expect(documents, `the briefing derivation no longer reaches ${reached}`).toContain(reached);
    }
    expect(documents.flatMap((path) => briefingViolations(relative(ROOT, join(ROOT, path)), readDocument(ROOT, path), holdings))).toEqual([]);
  });

  test("the check refuses what it names (planted)", () => {
    const holdings: Holdings = {
      holds: (path) => ["docs", "docs/a.md", "engine", "engine/src", "engine/src/entry.ts", "scripts/run.ts", "scripts", "shared", "shared/when-eval.ts"].includes(path),
      recorded: (path) => path === "docs/evidence" || path === "docs/evidence/run.log.txt",
      topLevel: new Set(["docs", "engine", "scripts", "shared"]),
      scripts: (directory) => new Set(directory === "" ? ["test"] : ["typecheck"]),
    };
    const clean = [
      "[a](../a.md) [web](https://example.invalid/x) [anchor](#here)",
      "`engine/src/entry.ts` `engine/src/` `origin/testing` `~/.cache/x/<task>` `.bridlewise/state/x` `docs/*.md` `docs/evidence/run.log.txt` `docs/evidence/`",
      "[stored](evidence:docs/evidence/run.log.txt)",
      "`npm test` `npm run test` `cd engine && npm run typecheck` `cd engine && node src/entry.ts harness sync` `node --experimental-strip-types scripts/run.ts .`",
      "`node scripts/run.ts create --target\n  ~/.local/state/<name>/repo`",
      "`src/entry.ts` `node src/entry.ts harness check`",
      "```text\n`engine/src/gone.ts`\n```",
      "```ts\nimport { evalWhen } from \"../../shared/when-eval.ts\";\n```",
    ].join("\n");
    expect(briefingViolations("docs/process/X.md", clean, holdings)).toEqual([]);
    // A site page may keep an absolute repository URL (Pages needs one); the
    // refusal is scoped to process documents and the documents they name.
    expect(briefingViolations("docs/floor/X.md", "[roles](https://github.com/LLM-4-People/bridlewise/blob/main/CONTRIBUTING.md)", holdings)).toEqual([]);
    const broken: Record<string, string> = {
      "a dead link": "[a](../gone.md)",
      "a link into stored evidence by its relative path": "[run](../evidence/run.log.txt)",
      "an unrecorded evidence link": "[run](evidence:docs/evidence/gone.txt)",
      "an absolute URL that names a process document": "[roles](https://github.com/LLM-4-People/bridlewise/blob/main/CONTRIBUTING.md)",
      "a dead path": "`engine/src/gone.ts`",
      "an unknown npm script": "`npm run lessons -- pending`",
      "an npm script of the wrong package": "`npm run typecheck`",
      "a dead node file": "`node scripts/gone.ts`",
      "a dead node file under cd": "`cd engine && node src/gone.ts`",
      "a fenced example importing a dead module": "```ts\nimport { gone } from \"../../server/gone.ts\";\n```",
    };
    for (const [shape, text] of Object.entries(broken)) expect(briefingViolations("docs/process/X.md", text, holdings).length, shape).toBe(1);
  });

  test("the documented cancellation rule matches the workflow files", () => {
    const page = readDocument(ROOT, "docs/process/AGENTS.md");
    for (const workflow of ["ci.yml", "test-shards.yml"]) {
      const actual = workflowConcurrency(`.github/workflows/${workflow}`);
      const stated = statedConcurrency(page, workflow);
      expect(stated, `docs/process/AGENTS.md must state ${workflow}'s group and cancel-in-progress in its concurrency table`).toEqual(actual);
    }
    expect(page, "the page must say a superseded shard run is cancelled by hand").toMatch(/superseded shard run is cancelled by hand/u);
  });

  test("the E2E retry claim matches playwright.config.ts, and CI does not run the suite", () => {
    const config = readFileSync(join(ROOT, "playwright.config.ts"), "utf8");
    const retries = /retries:\s*process\.env\.CI\s*\?\s*(\d+)\s*:\s*(\d+)/u.exec(config);
    expect(retries, "playwright.config.ts states no `retries: process.env.CI ? n : n`").not.toBeNull();
    const page = readDocument(ROOT, "docs/testing.md");
    expect(page, "the test map must quote the retry pair the E2E config sets").toContain(`retries: process.env.CI ? ${retries![1]!} : ${retries![2]!}`);
    expect(page, "the test map must say the E2E suite is not exercised here").toMatch(/not run by this repository's CI/u);
    for (const workflow of readdirSync(join(ROOT, ".github/workflows"))) {
      expect(readFileSync(join(ROOT, ".github/workflows", workflow), "utf8"), `${workflow} runs Playwright, but the test map says this repository's CI does not`).not.toMatch(/\bplaywright\b/iu);
    }
  });
});
