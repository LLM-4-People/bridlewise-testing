/**
 * WHAT A COMMIT ADDS NEVER CARRIES A HOST'S HOME, A RAW DUMP, OR A `.ts` FILE
 * THAT IS NOT TYPESCRIPT.
 *
 * A lane once replaced a test file with a 2.5 MB `vitest list --json` listing
 * full of absolute host paths: the user's home directory and account name
 * reached a public commit, and neither the hooks nor CI refused it. One judge
 * ({@link changeProblems}) refuses, for every file a change adds or modifies:
 *
 * - an ADDED line naming an absolute home path — `/home/<name>`,
 *   `/Users/<name>`, `C:\Users\<name>` (either slash, a `~1` short name),
 *   with or without a trailing separator, in its text or any decoded form
 *   (percent-encoded, repeatedly; JSON, JavaScript and backslash escapes) —
 *   unless `<name>` is a documented placeholder. The shapes and placeholders
 *   are the ONE publication-privacy catalogue's (`src/privacy/secret-signals.ts`,
 *   which the secret scan reads too), and every other privacy row of it (an
 *   internal host, …) is refused the same way; and, at the local hook, the
 *   running user's own home and account name wherever they appear (never
 *   exempt). A binary blob is read whole, byte
 *   for byte: a NUL is never a reason not to look. A path split across string
 *   pieces (`"/home/" + name`) has no shape to match: CI's shape match does not
 *   see it (a stated residual); the local hook still refuses the account name
 *   in any piece;
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
 * (`verification.addedContent`), reviewed like any policy change. No location
 * exempts anything: only a throwaway repository that says so in its own
 * `.git/config`, and is one by identity, may name its own root and this
 * harness's guard ({@link throwawayReading}).
 */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";

import { parse as parseModule } from "@babel/parser";

import { HarnessError, InputError } from "../../src/kernel/errors.ts";
import { canonicalJson } from "../../src/kernel/integrity.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { pendingCommitParents, repositoryToplevel } from "../../src/git/repository-ownership.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";
import { collapsedPathText, HOME_PATH_PLACEHOLDERS, publicationPrivacyFindings } from "../../src/privacy/secret-signals.ts";
import { COMMIT_GUARD_PATH, COMMIT_GUARD_REPOSITORY_PATH } from "./staged-move-loss.ts";

const POLICY = ROOT_POLICY.verification.addedContent;
const OVERSIZED_TEXT_EXEMPTIONS: ReadonlySet<string> = new Set(POLICY.oversizedTextExemptions);
const NOT_TYPESCRIPT_EXEMPTIONS: ReadonlySet<string> = new Set(POLICY.notTypeScriptExemptions);

/** git's own text heuristic: no NUL byte in the first 8000 bytes. It decides only HOW a blob is read, never whether. */
const TEXT_PROBE_BYTES = 8000;

/** The characters of one path segment: the running user's home ends where they end. */
const SEGMENT = "A-Za-z0-9._~\\-";

/**
 * The layers an encoded path hides behind, peeled one at a time until nothing changes: percent-encoding
 * (`%2Fhome%2F…`, repeatedly: `%252F` is one more layer), JSON and JavaScript escapes (`\u002f`, `\x2f`) and
 * backslash escapes (`\/home\/…`, `C:\\Users\\…`). Every round shortens the text, so it ends; a text still
 * changing after {@link MAXIMUM_DECODING_ROUNDS} rounds is refused, never judged half-decoded.
 */
const MAXIMUM_DECODING_ROUNDS = 16;

function decodedOnce(text: string): string {
  return text
    .replace(/%([0-9A-Fa-f]{2})/gu, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\u([0-9A-Fa-f]{4})/gu, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\x([0-9A-Fa-f]{2})/gu, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\([\\/"'])/gu, "$1");
}

/** `text` and each of its decoded forms (see {@link MAXIMUM_DECODING_ROUNDS}); null when it is encoded deeper than the bound. */
export function decodedForms(text: string): readonly string[] | null {
  const forms = [collapsedPathText(text)];
  for (let round = 0; round < MAXIMUM_DECODING_ROUNDS; round += 1) {
    const next = collapsedPathText(decodedOnce(forms.at(-1)!));
    if (next === forms.at(-1)) return forms;
    forms.push(next);
  }
  return null;
}

/**
 * The running user's own home and account name, known only where the judge runs locally (the hook); null in CI.
 * `accountName` is null only when the account is EXACTLY (case-sensitively) a declared placeholder (a CI
 * runner's `runner`): only the bare-name word check is skipped then, and the home stays judged. `references`
 * are the literal paths a marked throwaway repository may name (see {@link throwawayReading}); nobody else has any.
 */
export type LocalIdentity = Readonly<{ home: string | null; accountName: string | null; references?: readonly string[] }>;

/** A name shorter than this is not judged as a bare word (it would refuse ordinary text); its home still is. */
const MINIMUM_JUDGED_ACCOUNT_NAME = 3;

/** The identity of `account` at `home`: a placeholder account (compared exactly) loses only its bare-name check. */
export function identityOf(account: string, home: string): LocalIdentity {
  const placeholder = (HOME_PATH_PLACEHOLDERS as readonly string[]).includes(account);
  return {
    home: home.length > 1 ? home : null,
    accountName: account.length >= MINIMUM_JUDGED_ACCOUNT_NAME && !placeholder ? account : null,
  };
}

/** This process's user, for the hook. */
export function localIdentity(): LocalIdentity {
  return identityOf(userInfo().username, homedir());
}

function gitText(root: string, args: readonly string[]): Readonly<{ status: number | null; text: string }> {
  const answer = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return { status: answer.status, text: (answer.stdout ?? "").trim() };
}

/**
 * THE THROWAWAY MARKER. A test's throwaway repository whose hook must name this harness's guard by its
 * absolute path (it has no `engine/scripts/` of its own), or whose fixture must name its own root, says so
 * explicitly: its fixture helper sets `verification.addedContent.throwawayRepositoryKey` in the repository's
 * own `.git/config` (never committed). Only such a repository may name exactly two things of the host: its
 * own root and this harness's guard program. The marker is judged by the repository's IDENTITY, never its
 * location, and refused wherever the repository is not a throwaway one:
 *
 * - set in any scope but the repository's own `.git/config` (global, system, a worktree's config);
 * - an agent's checkout (the workspace and candidate writers' `agentCheckoutKey`);
 * - a project: it holds the harness's own guard (`engine/scripts/commit-guard.ts`) in its index or `HEAD`;
 * - a repository at or above the running user's home (it would exempt the home itself).
 *
 * Null for an unmarked repository; its references when the marker holds; its refusal otherwise.
 */
export function throwawayReading(root: string): Readonly<{ references: readonly string[] }> | Readonly<{ refusal: string }> | null {
  const key = POLICY.throwawayRepositoryKey;
  const scopes = gitText(root, ["config", "--show-scope", "--get-all", key]);
  if (scopes.status !== 0 || scopes.text.length === 0) return null;
  const refuse = (why: string): Readonly<{ refusal: string }> => ({ refusal: `the throwaway-repository marker (${key}) is refused here: ${why} (added_content_throwaway_marker_misplaced)` });
  const entries = scopes.text.split("\n").map((line) => line.split("\t"));
  if (entries.some(([scope]) => scope !== "local")) return refuse("it is set outside the repository's own .git/config");
  if (entries.some(([, value]) => value !== "true")) return refuse("its only value is true");
  if (gitText(root, ["config", "--get", ROOT_POLICY.workflow.commitIdentity.agentCheckoutKey]).text === "true") return refuse("this is an agent's checkout (a workspace or a candidate)");
  const holdsGuard = gitText(root, ["ls-files", "--", COMMIT_GUARD_REPOSITORY_PATH]).text.length > 0 ||
    gitText(root, ["cat-file", "-e", `HEAD:${COMMIT_GUARD_REPOSITORY_PATH}`]).status === 0;
  if (holdsGuard) return refuse("this repository is a project (it holds the harness's own guard)");
  const real = realpathSync(root);
  const home = realpathSync(homedir());
  if (home === real || home.startsWith(`${real}/`)) return refuse("this repository holds the running user's home");
  return { references: [...new Set([root, real, COMMIT_GUARD_PATH, realpathSync(COMMIT_GUARD_PATH)])].toSorted((a, b) => b.length - a.length) };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * The bare account name as a word: not inside a longer name, except after an encoded separator whose `%`
 * or backslash was lost (`2F`, `5C`: `…2Fhome2F<name>`) — a lookbehind on letters alone would let it through.
 */
function accountNamePattern(name: string): RegExp {
  return new RegExp(`(?<=^|[^A-Za-z0-9]|2F|5C)${escapeRegExp(name)}(?=$|[^A-Za-z0-9]|2F|5C)`, "iu");
}

/**
 * One form's findings: each publication-privacy row of the one catalogue it matches (`src/privacy/secret-signals.ts`:
 * an absolute home path whose name is not a documented placeholder, an internal host…), and the running user's own
 * home and account name — each named by its kind, never by what it matched.
 */
function formFindings(form: string, local: LocalIdentity, kinds: Set<string>): void {
  for (const signal of publicationPrivacyFindings(form, "text")) kinds.add(`${articled(signal.description)} [${signal.id}]`);
  if (local.home !== null && new RegExp(`${escapeRegExp(local.home)}(?![${SEGMENT}])`, "u").test(form)) kinds.add("the running user's home directory");
  if (local.accountName !== null && accountNamePattern(local.accountName).test(form)) kinds.add("the running user's account name");
}

function articled(description: string): string {
  return `${/^[aeiou]/iu.test(description) ? "an" : "a"} ${description}`;
}

/** The refusals of one added line (or a binary blob's content): each kind of home it names, in any decoded form (never the name itself). */
export function homePathFindings(added: string, local: LocalIdentity): readonly string[] {
  // A marked throwaway repository's own references are not a home it publishes (see throwawayReading).
  const line = (local.references ?? []).reduce((text, path) => text.split(path).join("<reference>"), added);
  const forms = decodedForms(line);
  if (forms === null) return [`text encoded more than ${String(MAXIMUM_DECODING_ROUNDS)} layers deep (it cannot be judged)`];
  const kinds = new Set<string>();
  for (const form of forms) formFindings(form, local, kinds);
  return [...kinds];
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
    if (!text) {
      // A binary is read whole, byte for byte, and once more with its NULs dropped (UTF-16 text): a NUL is
      // never a reason not to look.
      const raw = file.bytes.toString("latin1");
      const kinds = new Set([...homePathFindings(raw, local), ...homePathFindings(raw.replaceAll("\0", ""), local)]);
      for (const kind of kinds) problems.push(`${file.path}: its binary content names ${kind} (added_content_private)`);
      continue;
    }
    for (const { line, text: added } of file.addedLines) {
      for (const kind of homePathFindings(added, local)) problems.push(`${file.path}:${String(line)}: an added line names ${kind} (added_content_private)`);
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
export function stagedChangeProblems(root: string, local: LocalIdentity = localIdentity()): readonly string[] {
  const throwaway = throwawayReading(root);
  if (throwaway !== null && "refusal" in throwaway) return [throwaway.refusal];
  return changeProblems(changedFiles(root, pendingCommitParents(root, "inherited"), { kind: "index" }), { ...local, ...(throwaway === null ? {} : { references: throwaway.references }) });
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
