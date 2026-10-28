/**
 * WHAT A COMMIT ADDS NEVER CARRIES A HOST'S HOME, A RAW DUMP, OR A `.ts` FILE
 * THAT IS NOT TYPESCRIPT.
 *
 * A lane once replaced a test file with a 2.5 MB `vitest list --json` listing
 * full of absolute host paths: the user's home directory and account name
 * reached a public commit, and neither the hooks nor CI refused it. One judge
 * ({@link changeProblems}) refuses, for every file a change adds or modifies:
 *
 * - an ADDED line naming an absolute home path — `/home/<name>/`,
 *   `/Users/<name>/`, `C:\Users\<name>\` (either slash) — unless `<name>` is
 *   one of the declared synthetic placeholders fixtures and docs use; and, at
 *   the local hook, the running user's own home and account name wherever
 *   they appear (never exempt);
 * - a text blob over the declared bound (raw output belongs in the evidence
 *   store), unless the path is a declared exemption (vendored source data);
 * - a `.ts`, `.tsx`, `.mts` or `.cts` file that does not parse as TypeScript
 *   (a declaration file read as one), unless the path is a declared exemption
 *   (an excerpt of an upstream source; the fixture that is a syntax error).
 *
 * NO REFUSAL ECHOES WHAT IT FOUND. A refusal is printed into a public log, so
 * it names the file, the line and the kind of finding, never the matched text.
 *
 * Three places ask it: the `commit-msg` door (the index against `HEAD` and any
 * `MERGE_HEAD`), the required `commit-records` workflow (`--range
 * <base>..<head>`, main's code over a pull request's or merge group's
 * commits), and `--tree`, the retroactive judgement of a whole tree (every
 * line counts as added). The declarations live in the root policy
 * (`verification.addedContent`), reviewed like any policy change.
 */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseModule } from "@babel/parser";

import { HarnessError, InputError } from "../../src/kernel/errors.ts";
import { canonicalJson } from "../../src/kernel/integrity.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { pendingCommitParents, repositoryToplevel } from "../../src/git/repository-ownership.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";

const POLICY = ROOT_POLICY.verification.addedContent;
const SYNTHETIC_HOME_NAMES: ReadonlySet<string> = new Set(POLICY.syntheticHomeNames.map((name) => name.toLowerCase()));
const OVERSIZED_TEXT_EXEMPTIONS: ReadonlySet<string> = new Set(POLICY.oversizedTextExemptions);
const NOT_TYPESCRIPT_EXEMPTIONS: ReadonlySet<string> = new Set(POLICY.notTypeScriptExemptions);

/** git's own text heuristic: no NUL byte in the first 8000 bytes. */
const TEXT_PROBE_BYTES = 8000;

/** The home-path shapes, each naming its account in group 1. */
const HOME_PATHS: readonly Readonly<{ kind: string; pattern: RegExp }>[] = [
  { kind: "a /home/<name>/ path", pattern: /\/home\/([A-Za-z0-9._-]+)\//gu },
  // Not after a drive letter: `C:/Users/<name>/` is the Windows shape below, one path, one finding.
  { kind: "a /Users/<name>/ path", pattern: /(?<![A-Za-z]:)\/Users\/([A-Za-z0-9._-]+)\//gu },
  { kind: "a C:\\Users\\<name>\\ path", pattern: /[A-Za-z]:[\\/]+Users[\\/]+([A-Za-z0-9._ -]+?)[\\/]/gu },
];

/**
 * The running user's own home and account name, known only where the judge runs locally (the hook); empty in
 * CI. `scratchPaths` exist only when the repository being committed lies INSIDE the process's temp root (a
 * test's scratch repository, which is never published): its own temp paths and the checkout of the harness
 * that drives it (a fixture's hook shim names this harness's guard by its absolute path, the one spelling
 * the hook check accepts besides the repository's own) are its references, never a home it publishes. A
 * repository outside the temp root (the project, a workspace, a candidate) gets no such reading.
 */
export type LocalIdentity = Readonly<{ home: string | null; accountName: string | null; scratchPaths?: readonly string[] }>;

/** This process's user, for the hook. */
export function localIdentity(repositoryRoot?: string): LocalIdentity {
  const account = userInfo().username;
  const home = homedir();
  // A declared placeholder account (a CI runner's `runner`) names nobody: judging its every mention would
  // refuse the word itself. Its home's /home/<name>/ shape is exempt like any placeholder's.
  const placeholder = SYNTHETIC_HOME_NAMES.has(account.toLowerCase());
  const temp = [...new Set([tmpdir(), realpathSync(tmpdir())])];
  const scratch = repositoryRoot !== undefined && temp.some((root) => isInside(realpathSync(repositoryRoot), realpathSync(root)));
  const harness = repositoryToplevel(fileURLToPath(new URL("../../", import.meta.url)), "directory");
  return {
    home: home.length > 1 && !placeholder ? home : null,
    accountName: account.length >= 3 && !placeholder ? account : null,
    ...(scratch ? { scratchPaths: [...temp, ...(harness === undefined ? [] : [harness])] } : {}),
  };
}

function isInside(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

/** The refusals of one added line: each kind of home it names (never the name itself). */
export function homePathFindings(added: string, local: LocalIdentity): readonly string[] {
  const kinds = new Set<string>();
  // A scratch repository's own references are not a home it publishes (see LocalIdentity).
  const line = (local.scratchPaths ?? []).reduce((text, path) => text.split(path).join("<scratch>"), added);
  for (const { kind, pattern } of HOME_PATHS) {
    for (const match of line.matchAll(pattern)) {
      if (!SYNTHETIC_HOME_NAMES.has(match[1]!.toLowerCase())) kinds.add(kind);
    }
  }
  if (local.home !== null && line.includes(local.home)) kinds.add("the running user's home directory");
  if (local.accountName !== null && new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(local.accountName)}(?![A-Za-z0-9])`, "iu").test(line)) {
    kinds.add("the running user's account name");
  }
  return [...kinds];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isTypeScriptPath(path: string): boolean {
  return /\.(?:ts|tsx|mts|cts)$/u.test(path);
}

/** Does `text` parse as TypeScript (JSX allowed in `.tsx`; a `.d.ts` read as a declaration file)? */
export function parsesAsTypeScript(path: string, text: string): boolean {
  const declaration = /\.d\.(?:ts|mts|cts)$/u.test(path);
  try {
    parseModule(text, { sourceType: "unambiguous", plugins: path.endsWith(".tsx") ? ["typescript", "jsx"] : [["typescript", { dts: declaration }]], errorRecovery: false });
    return true;
  } catch {
    return false;
  }
}

/** One file a change adds or modifies: its new bytes, and the lines it adds (all of them for a new file or a tree). */
export type ChangedFile = Readonly<{ path: string; bytes: Buffer; addedLines: ReadonlyArray<Readonly<{ line: number; text: string }>> }>;

/** THE judge: the refusals of the files a change adds or modifies, each naming file, line and kind — never the content. */
export function changeProblems(files: readonly ChangedFile[], local: LocalIdentity): readonly string[] {
  const problems: string[] = [];
  for (const file of files) {
    const text = !file.bytes.subarray(0, TEXT_PROBE_BYTES).includes(0);
    if (text && file.bytes.length > POLICY.maximumTextBlobBytes && !OVERSIZED_TEXT_EXEMPTIONS.has(file.path)) {
      problems.push(`${file.path}: a text blob of ${String(file.bytes.length)} bytes, over the ${String(POLICY.maximumTextBlobBytes)}-byte bound (raw output belongs in the evidence store) (added_content_text_oversized)`);
    }
    if (isTypeScriptPath(file.path) && !NOT_TYPESCRIPT_EXEMPTIONS.has(file.path) && !parsesAsTypeScript(file.path, file.bytes.toString("utf8"))) {
      problems.push(`${file.path}: is not TypeScript: it does not parse (added_content_not_typescript)`);
    }
    if (!text) continue;
    for (const { line, text: added } of file.addedLines) {
      for (const kind of homePathFindings(added, local)) problems.push(`${file.path}:${String(line)}: an added line names ${kind} (added_content_home_path)`);
    }
  }
  return problems;
}

function git(root: string, args: readonly string[]): Buffer {
  const answer = spawnSync("git", args, { cwd: root, maxBuffer: ROOT_POLICY.runtime.limits.maximumGitOutputBytes });
  if (answer.status !== 0) throw new HarnessError(`git ${args[0] ?? ""} failed: ${(answer.stderr ?? Buffer.alloc(0)).toString("utf8").trim()}`, "added_content_git_failed");
  return answer.stdout;
}

/** The tree a judgement reads: the index (the commit being made) or a recorded commit. */
type Tree = Readonly<{ kind: "index" }> | Readonly<{ kind: "commit"; commit: string }>;

/** The paths `tree` adds or modifies against `parent` (renames off: a renamed file is judged whole). */
function changedPaths(root: string, parent: string, tree: Tree): ReadonlySet<string> {
  const options = ["--name-only", "--no-renames", "--diff-filter=AMT", "-z"];
  const listing = tree.kind === "index" ? git(root, ["diff", "--cached", ...options, parent]) : git(root, ["diff-tree", "-r", ...options, parent, tree.commit]);
  return new Set(listing.toString("utf8").split("\0").filter((path) => path.length > 0));
}

/** The lines `tree`'s `path` adds against `parent` (git's own -U0 hunks), numbered in the new file. */
function addedLinesOf(root: string, parent: string, tree: Tree, path: string): ChangedFile["addedLines"] {
  const args = ["-U0", "--no-color", "--no-ext-diff", "--text", "--no-renames"];
  const patch = (tree.kind === "index" ? git(root, ["diff", "--cached", ...args, parent, "--", path]) : git(root, ["diff", ...args, parent, tree.commit, "--", path])).toString("utf8");
  const added: { line: number; text: string }[] = [];
  let next = 0;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
    if (hunk !== null) {
      next = Number(hunk[1]);
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) added.push({ line: next++, text: line.slice(1) });
  }
  return added;
}

/**
 * The files `tree` adds or modifies against EVERY one of `parents` (a merge
 * judges only what it changes beyond all of them; a root commit, everything),
 * each with the lines it adds against the first parent.
 */
export function changedFiles(root: string, parents: readonly string[], tree: Tree): readonly ChangedFile[] {
  const spec = (path: string): string => tree.kind === "index" ? `:${path}` : `${tree.commit}:${path}`;
  const [first, ...others] = parents;
  if (first === undefined) return treeFiles(root, tree.kind === "index" ? null : tree.commit);
  const changed = [...changedPaths(root, first, tree)].filter((path) => others.every((parent) => changedPaths(root, parent, tree).has(path)));
  return changed.map((path) => ({ path, bytes: git(root, ["cat-file", "blob", spec(path)]), addedLines: addedLinesOf(root, first, tree, path) }));
}

/** Every file of a commit's tree (or the index), every line counted as added: the retroactive judgement. */
export function treeFiles(root: string, commit: string | null): readonly ChangedFile[] {
  const listing = (commit === null ? git(root, ["ls-files", "-z"]) : git(root, ["ls-tree", "-r", "-z", "--name-only", commit])).toString("utf8");
  return listing.split("\0").filter((path) => path.length > 0).map((path) => {
    const bytes = git(root, ["cat-file", "blob", commit === null ? `:${path}` : `${commit}:${path}`]);
    const text = bytes.toString("utf8");
    return { path, bytes, addedLines: text.split("\n").map((line, index) => ({ line: index + 1, text: line })) };
  });
}

/** The `commit-msg` question: the staged change (parents `HEAD` and any `MERGE_HEAD`), judged with the running user's identity. */
export function stagedChangeProblems(root: string, local: LocalIdentity = localIdentity(root)): readonly string[] {
  return changeProblems(changedFiles(root, pendingCommitParents(root, "inherited"), { kind: "index" }), local);
}

/** Every commit of `range` (`<base>..<head>`) whose changes are refused, each named with its refusals. CI knows no local identity. */
export function rangeProblems(root: string, range: string): ReadonlyArray<Readonly<{ commit: string; problems: readonly string[] }>> {
  const commits = git(root, ["rev-list", "--reverse", range, "--"]).toString("utf8").split("\n").filter((line) => line.length > 0);
  return commits.flatMap((commit) => {
    const parents = git(root, ["rev-list", "--parents", "-n", "1", commit]).toString("utf8").trim().split(" ").slice(1);
    const problems = changeProblems(changedFiles(root, parents, { kind: "commit", commit }), { home: null, accountName: null });
    return problems.length === 0 ? [] : [{ commit, problems }];
  });
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  const argv = process.argv.slice(2);
  const root = repositoryToplevel(process.cwd(), "directory");
  if (root === undefined) throw new InputError("added-content runs inside a git working tree", "added_content_usage");
  const at = argv.indexOf("--range");
  if (at >= 0 && argv[at + 1] !== undefined) {
    const refused = rangeProblems(root, argv[at + 1]!);
    for (const { commit, problems } of refused) process.stderr.write(`${commit}:\n${problems.map((problem) => `  - ${problem}`).join("\n")}\n`);
    process.stdout.write(`${canonicalJson({ range: argv[at + 1]!, refusedCommits: refused.length })}\n`);
    if (refused.length > 0) process.exitCode = 1;
  } else if (argv.includes("--tree")) {
    // The retroactive judgement of HEAD's whole tree: every line counts as added.
    const problems = changeProblems(treeFiles(root, "HEAD"), { home: null, accountName: null });
    for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
    process.stdout.write(`${canonicalJson({ tree: "HEAD", refused: problems.length })}\n`);
    if (problems.length > 0) process.exitCode = 1;
  } else {
    throw new InputError("Usage: added-content --range <base>..<head> | --tree", "added_content_usage");
  }
}
