/**
 * DECLARED DELETIONS, DRIVEN (`src/git/declared-deletions.ts`).
 *
 * Planted repositories with committed files, driven through the module the
 * CLI verbs, the exposure actions and the hooks call:
 *
 *   - a declaration records the path, HEAD's blob there and HEAD, in the
 *     checkout's OWN git directory: the tree, the index and every other
 *     worktree stay untouched;
 *   - it is literal and all-or-nothing: a folder is never expanded, a pattern
 *     is not a path, a second spelling of a path is refused, a file that was
 *     not deleted is refused, and one refused path records nothing;
 *   - the ONE state rule (pending, mismatched, stale, expired, consumed) and
 *     the guard's verdicts (declared, undeclared, mismatched, stale, expired,
 *     copies changed, foreign);
 *   - a declaration is bound to HEAD's move count (a `reset --soft` back to the
 *     declared commit leaves it stale for good) and to the ignored copies it
 *     found (recorded at declare time);
 *   - consumption and expiry after a commit, withdrawal, a torn record and a
 *     record copied from another git directory, each typed;
 *   - ONE WRITER AT A TIME: parallel declares lose nothing, and a clear racing
 *     declares never resurrects what it withdrew.
 *
 * The commit guard's acceptance through a real `git commit` is driven in
 * `test/prevention/commit-move-guard.test.ts`.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  clearDeclaredDeletions,
  consumeDeclaredDeletions,
  declarationState,
  declaredDeletionsPath,
  declaredDeletionsStatus,
  declaredDeletionsSummary,
  declareDeletions,
  judgeDeclaration,
  readDeclaredDeletions,
  type DeclaredDeletionsView,
} from "../../src/git/declared-deletions.ts";
import { headVersions } from "../../src/git/repository-ownership.ts";
import { declarationPaths } from "../../src/workflow/harness-commands.ts";
import { createTempDir } from "../support/temp-dir.ts";

function git(root: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-c", "user.name=Declared Test", "-c", "user.email=declared@example.invalid", ...args], { cwd: root, encoding: "utf8" });
}

/** A repository with two committed files under `docs/` and one at the top. */
function plantedRepository(): string {
  // git answers with physical paths; a temp root reached through a symlink
  // would otherwise compare unequal.
  const root = realpathSync(createTempDir("declared-deletions-"));
  git(root, "init", "-q");
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "paper.md"), "# the paper\n");
  writeFileSync(join(root, "docs", "notes.md"), "# the notes\n");
  writeFileSync(join(root, "top.md"), "# top\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

const headOf = (root: string): string => git(root, "rev-parse", "HEAD").trim();
const movesOf = (root: string): number => Number(git(root, "rev-list", "--walk-reflogs", "--count", "HEAD").trim());
const blobAt = (root: string, path: string): string => git(root, "rev-parse", `HEAD:${path}`).trim();

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code ?? `untyped: ${(error as Error).message}`;
  }
  return "(no refusal)";
}

test("a declaration records the path, HEAD's blob and HEAD in the checkout's own git directory, and touches neither the tree nor the index", () => {
  const root = plantedRepository();
  rmSync(join(root, "docs", "paper.md"));
  // `git status` may refresh the index's stat data, so it runs BEFORE the bytes are read.
  const status = git(root, "status", "--porcelain");
  const index = readFileSync(join(root, ".git", "index"));
  const declared = declareDeletions(root, ["docs/paper.md"]);
  assert.deepEqual(declared.declared, [{ path: "docs/paper.md", blob: blobAt(root, "docs/paper.md"), copies: [] }]);
  assert.equal(declared.head, headOf(root));
  assert.equal(declared.recordPath, join(root, ".git", "bridlewise", "declared-deletions.json"));
  assert.equal(declaredDeletionsPath(root), declared.recordPath);
  assert.deepEqual(readFileSync(join(root, ".git", "index")), index, "declaring changed the index");
  assert.equal(git(root, "status", "--porcelain"), status, "declaring changed what git reports for the tree");
  assert.equal(git(root, "status", "--porcelain", "--ignored").includes("bridlewise"), false, "the record is inside the working tree");
  const recorded = declaredDeletionsStatus(root).declarations;
  assert.deepEqual(recorded, [{ path: "docs/paper.md", blob: blobAt(root, "docs/paper.md"), head: headOf(root), moves: movesOf(root), copies: [], state: "pending" }]);
  assert.equal(declaredDeletionsSummary(root), "1 declared: 1 pending");
});

test("the declaration records the IGNORED COPIES the guard would pair it with, at declare time — the machine-local excludes included", () => {
  const root = plantedRepository();
  writeFileSync(join(root, ".gitignore"), "/.bkp/\n");
  git(root, "add", ".gitignore");
  git(root, "commit", "-q", "-m", "ignore the backups");
  mkdirSync(join(root, ".bkp"));
  mkdirSync(join(root, "scratch"));
  // One copy under a versioned rule, one under a rule only this machine has.
  writeFileSync(join(root, ".git", "info", "exclude"), "/scratch/\n");
  copyFileSync(join(root, "docs", "paper.md"), join(root, ".bkp", "paper.md"));
  copyFileSync(join(root, "docs", "paper.md"), join(root, "scratch", "paper-kept.md"));
  writeFileSync(join(root, ".bkp", "other.md"), "# not the same bytes\n");
  rmSync(join(root, "docs", "paper.md"));
  const declared = declareDeletions(root, ["docs/paper.md"]);
  assert.deepEqual(declared.declared, [{ path: "docs/paper.md", blob: blobAt(root, "docs/paper.md"), copies: [".bkp/paper.md", "scratch/paper-kept.md"] }]);
  assert.deepEqual(declaredDeletionsStatus(root).declarations.map((entry) => entry.copies), [[".bkp/paper.md", "scratch/paper-kept.md"]]);
});

test("a deletion staged with git rm can be declared; a file still on disk cannot (not even an in-place untracking): a declaration names a file that is GONE", () => {
  const root = plantedRepository();
  git(root, "rm", "-q", "docs/paper.md");
  git(root, "rm", "-q", "--cached", "docs/notes.md");
  assert.equal(existsSync(join(root, "docs", "notes.md")), true);
  assert.equal(codeOf(() => declareDeletions(root, ["docs/notes.md"])), "declared_deletion_not_deleted");
  // Anything at the path counts, a symbolic link left where the file was too.
  rmSync(join(root, "docs", "notes.md"));
  execFileSync("ln", ["-s", "elsewhere.md", join(root, "docs", "notes.md")]);
  assert.equal(codeOf(() => declareDeletions(root, ["docs/notes.md"])), "declared_deletion_not_deleted");
  const declared = declareDeletions(root, ["docs/paper.md"]);
  assert.deepEqual(declared.declared.map((entry) => entry.path), ["docs/paper.md"]);
});

test("NO WILDCARD, NO FOLDER, ONE SPELLING: each refusal is typed and records nothing", () => {
  const root = plantedRepository();
  rmSync(join(root, "docs"), { recursive: true });
  const refusals: ReadonlyArray<readonly [readonly string[], string]> = [
    [[], "declared_deletion_usage"],
    [["docs"], "declared_deletion_not_a_file"],
    [["docs/*"], "declared_deletion_not_in_head"],
    [["docs/*.md"], "declared_deletion_not_in_head"],
    [["*"], "declared_deletion_not_in_head"],
    [["./docs/paper.md"], "declared_deletion_path_invalid"],
    [["docs//paper.md"], "declared_deletion_path_invalid"],
    [["docs/../docs/paper.md"], "declared_deletion_path_invalid"],
    [["docs/"], "declared_deletion_path_invalid"],
    [[join(root, "docs", "paper.md")], "declared_deletion_path_invalid"],
    [["top.md"], "declared_deletion_not_deleted"],
    [["docs/missing.md"], "declared_deletion_not_in_head"],
  ];
  for (const [paths, code] of refusals) {
    assert.equal(codeOf(() => declareDeletions(root, paths)), code, `declare ${JSON.stringify(paths)}`);
    assert.equal(existsSync(declaredDeletionsPath(root)), false, `a refused declare ${JSON.stringify(paths)} recorded something`);
  }
  // ALL OR NOTHING: one refused path among good ones records none of them,
  // and every refused path is named with its code.
  let message = "";
  const code = codeOf(() => {
    try {
      declareDeletions(root, ["docs/paper.md", "docs", "top.md"]);
    } catch (error) {
      message = (error as Error).message;
      throw error;
    }
  });
  assert.equal(code, "declared_deletion_refused");
  assert.match(message, /"docs": declared_deletion_not_a_file/u);
  assert.match(message, /"top\.md": declared_deletion_not_deleted/u);
  assert.equal(existsSync(declaredDeletionsPath(root)), false);
});

test("the shared HEAD reader answers exactly the paths asked: a folder asked with its own file is still a folder, and no sibling is added", () => {
  // Found by the all-or-nothing arm above: `ls-tree` takes its paths as
  // patterns that DESCEND, so `docs` asked together with `docs/paper.md` came
  // back absent (and every other child of `docs` came back unasked).
  const root = plantedRepository();
  const versions = headVersions(root, ["docs", "docs/paper.md", "top.md", "nope"], "directory");
  assert.deepEqual([...versions.keys()].sort(), ["docs", "docs/paper.md", "top.md"]);
  assert.equal(versions.get("docs")?.mode, "040000");
  assert.equal(versions.get("docs/paper.md")?.objectId, blobAt(root, "docs/paper.md"));
  assert.equal(versions.get("top.md")?.mode, "100644");
  assert.deepEqual([...headVersions(root, ["docs/paper.md", "docs/notes.md"], "directory").keys()].sort(), ["docs/notes.md", "docs/paper.md"]);
  // A pattern-shaped spelling (`docs/` lists the folder's CHILDREN in ls-tree)
  // names no entry git holds: the answer never carries a path nobody asked for.
  assert.deepEqual([...headVersions(root, ["docs/"], "directory").keys()], []);
});

test("an unborn branch has nothing to delete; outside a repository the refusal is typed", () => {
  const unborn = createTempDir("declared-deletions-unborn-");
  git(unborn, "init", "-q");
  assert.equal(codeOf(() => declareDeletions(unborn, ["a.md"])), "declared_deletion_unborn");
  const outside = createTempDir("declared-deletions-outside-");
  assert.equal(codeOf(() => declareDeletions(outside, ["a.md"])), "declared_deletion_not_a_repository");
  assert.equal(declaredDeletionsSummary(outside), "not a git checkout");
});

test("THE ONE STATE RULE: pending, mismatched, stale, expired, consumed; and the guard's verdicts", () => {
  const declaration = { path: "docs/paper.md", blob: "a".repeat(40), head: "1".repeat(40), moves: 3, copies: [".bkp/paper.md"] };
  const now = { blob: "a".repeat(40), head: "1".repeat(40), moves: 3, present: false };
  assert.equal(declarationState(declaration, now), "pending");
  assert.equal(declarationState(declaration, { ...now, blob: "b".repeat(40) }), "mismatched");
  assert.equal(declarationState(declaration, { ...now, head: "2".repeat(40) }), "stale");
  // THE SAME COMMIT, AFTER HEAD MOVED AND CAME BACK (`reset --soft`): stale for good.
  assert.equal(declarationState(declaration, { ...now, moves: 5 }), "stale");
  assert.equal(declarationState(declaration, { ...now, moves: null }), "stale", "a HEAD whose moves cannot be counted is never the declared one");
  // A changed blob is reported as mismatched even when HEAD also moved: the
  // content is the stronger reason, and it is the one to check.
  assert.equal(declarationState(declaration, { ...now, blob: "b".repeat(40), head: "2".repeat(40) }), "mismatched");
  assert.equal(declarationState(declaration, { ...now, present: true }), "expired");
  assert.equal(declarationState(declaration, { ...now, blob: undefined, head: "2".repeat(40) }), "consumed");

  const view = (head: string, foreignGitDirectory: string | null = null, moves = 3): DeclaredDeletionsView => ({
    recordPath: "/r", head, moves, foreignGitDirectory, entries: new Map([[declaration.path, declaration]]),
  });
  const deletion = { path: "docs/paper.md", blob: "a".repeat(40), copies: [".bkp/paper.md"], present: false };
  assert.equal(judgeDeclaration(view("1".repeat(40)), deletion).verdict, "declared");
  assert.equal(judgeDeclaration(view("1".repeat(40)), { ...deletion, copies: [] }).verdict, "declared", "a declared copy removed since is no new copy");
  const changed = judgeDeclaration(view("1".repeat(40)), { ...deletion, copies: [".bkp/paper.md", "archive/paper.md"] });
  assert.equal(changed.verdict, "copies-changed");
  assert.deepEqual(changed.undeclaredCopies, ["archive/paper.md"]);
  assert.equal(judgeDeclaration(view("1".repeat(40)), { ...deletion, blob: "b".repeat(40) }).verdict, "mismatched");
  assert.equal(judgeDeclaration(view("2".repeat(40)), deletion).verdict, "stale");
  assert.equal(judgeDeclaration(view("1".repeat(40), null, 4), deletion).verdict, "stale");
  assert.equal(judgeDeclaration(view("1".repeat(40)), { ...deletion, present: true }).verdict, "expired");
  assert.equal(judgeDeclaration(view("1".repeat(40), "/elsewhere/.git"), deletion).verdict, "foreign");
  // Exact path, never a prefix, a basename or a case-folded spelling.
  for (const path of ["docs/paper.m", "docs/paper.md.bak", "paper.md", "Docs/paper.md", "docs"]) {
    assert.equal(judgeDeclaration(view("1".repeat(40)), { ...deletion, path }).verdict, "undeclared", path);
  }
  assert.equal(judgeDeclaration(view("1".repeat(40)), deletion).declaration, declaration);
});

test("BOUND TO HEAD'S MOVES: a reset --soft back to the declared commit leaves the declaration stale for good; declaring again re-binds it", () => {
  const root = plantedRepository();
  rmSync(join(root, "docs", "paper.md"));
  declareDeletions(root, ["docs/paper.md"]);
  const declaredAt = headOf(root);
  git(root, "commit", "-q", "--allow-empty", "-m", "HEAD moves");
  git(root, "reset", "-q", "--soft", declaredAt);
  assert.equal(headOf(root), declaredAt, "the fixture did not bring HEAD back");
  assert.deepEqual(declaredDeletionsStatus(root).declarations.map((entry) => entry.state), ["stale"], "a HEAD that moved and came back revived the declaration");
  declareDeletions(root, ["docs/paper.md"]);
  assert.deepEqual(declaredDeletionsStatus(root).declarations.map((entry) => [entry.state, entry.moves]), [["pending", movesOf(root)]]);
});

test("a declaration whose file came back is EXPIRED, and the next change to the record drops it (never waits for an accident)", () => {
  const root = plantedRepository();
  rmSync(join(root, "docs", "paper.md"));
  rmSync(join(root, "docs", "notes.md"));
  declareDeletions(root, ["docs/paper.md", "docs/notes.md"]);
  git(root, "checkout", "--", "docs/paper.md");
  assert.deepEqual(declaredDeletionsStatus(root).declarations.map((entry) => [entry.path, entry.state]), [["docs/notes.md", "pending"], ["docs/paper.md", "expired"]]);
  assert.equal(declaredDeletionsSummary(root), "2 declared: 1 pending, 1 expired");
  // The next declare drops what expired; consumption after a commit does too.
  rmSync(join(root, "top.md"));
  declareDeletions(root, ["top.md"]);
  assert.deepEqual(declaredDeletionsStatus(root).declarations.map((entry) => entry.path), ["docs/notes.md", "top.md"]);
  git(root, "checkout", "--", "top.md");
  const after = consumeDeclaredDeletions(root);
  assert.deepEqual([after.consumed, after.expired, after.remaining], [[], ["top.md"], 1]);
});

test("a committed deletion is consumed and the record goes; an unused declaration stays, stale, and is re-bound only by declaring again", () => {
  const root = plantedRepository();
  rmSync(join(root, "docs", "paper.md"));
  rmSync(join(root, "docs", "notes.md"));
  declareDeletions(root, ["docs/paper.md", "docs/notes.md"]);
  assert.deepEqual(consumeDeclaredDeletions(root).consumed, [], "nothing was committed yet");
  git(root, "add", "docs/paper.md");
  git(root, "commit", "-q", "-m", "delete the paper");
  const consumed = consumeDeclaredDeletions(root);
  assert.deepEqual(consumed.consumed, ["docs/paper.md"]);
  assert.equal(consumed.remaining, 1);
  const left = declaredDeletionsStatus(root).declarations;
  assert.deepEqual(left.map((entry) => [entry.path, entry.state]), [["docs/notes.md", "stale"]]);
  assert.equal(declaredDeletionsSummary(root), "1 declared: 1 stale");
  // Declaring again re-binds it to the HEAD of now.
  declareDeletions(root, ["docs/notes.md"]);
  assert.deepEqual(declaredDeletionsStatus(root).declarations.map((entry) => [entry.path, entry.state, entry.head]), [["docs/notes.md", "pending", headOf(root)]]);
  git(root, "add", "docs/notes.md");
  git(root, "commit", "-q", "-m", "delete the notes");
  assert.deepEqual(consumeDeclaredDeletions(root).consumed, ["docs/notes.md"]);
  assert.equal(existsSync(declaredDeletionsPath(root)), false, "an empty record must be deleted");
  assert.equal(declaredDeletionsSummary(root), "none");
});

test("a checkout with no declarations is consumed by the lock-free reader alone: no state folder, no lock file", () => {
  // wf-del2-design D8: every commit's post-commit used to create the folder and
  // write and fsync a lock file even when nothing was ever declared.
  const root = plantedRepository();
  const stateFolder = dirname(declaredDeletionsPath(root));
  assert.equal(existsSync(stateFolder), false, "the fixture already has a state folder");
  assert.deepEqual(consumeDeclaredDeletions(root), { head: headOf(root), consumed: [], expired: [], remaining: 0 });
  assert.equal(existsSync(stateFolder), false, "consuming nothing created the state folder (and a lock file)");
});

test("a declaration whose file changed in a commit is mismatched", () => {
  const root = plantedRepository();
  rmSync(join(root, "docs", "paper.md"));
  declareDeletions(root, ["docs/paper.md"]);
  writeFileSync(join(root, "docs", "paper.md"), "# the paper, revised\n");
  git(root, "add", "docs/paper.md");
  git(root, "commit", "-q", "-m", "revise the paper");
  assert.deepEqual(consumeDeclaredDeletions(root).consumed, []);
  assert.deepEqual(declaredDeletionsStatus(root).declarations.map((entry) => entry.state), ["mismatched"]);
});

test("a torn record and a record copied from another git directory are typed refusals; clear withdraws either", () => {
  const root = plantedRepository();
  rmSync(join(root, "docs", "paper.md"));
  declareDeletions(root, ["docs/paper.md"]);
  const recordPath = declaredDeletionsPath(root);

  // A record copied into ANOTHER checkout's git directory belongs to this one.
  const other = plantedRepository();
  rmSync(join(other, "docs", "paper.md"));
  mkdirSync(dirname(declaredDeletionsPath(other)), { recursive: true });
  copyFileSync(recordPath, declaredDeletionsPath(other));
  assert.equal(codeOf(() => declaredDeletionsStatus(other)), "declared_deletions_foreign");
  assert.equal(codeOf(() => declareDeletions(other, ["docs/paper.md"])), "declared_deletions_foreign");
  assert.equal(readDeclaredDeletions(other, "directory").foreignGitDirectory, join(root, ".git"));
  assert.match(declaredDeletionsSummary(other), /^refused: /u);
  assert.deepEqual(clearDeclaredDeletions(other).cleared, ["docs/paper.md"]);
  assert.equal(existsSync(declaredDeletionsPath(other)), false);

  // A hand edit that breaks the digest is torn, not trusted.
  const text = readFileSync(recordPath, "utf8");
  writeFileSync(recordPath, text.replace("docs/paper.md", "docs/notes.md"));
  assert.equal(codeOf(() => readDeclaredDeletions(root, "directory")), "declared_deletions_unreadable");
  assert.equal(codeOf(() => declaredDeletionsStatus(root)), "declared_deletions_unreadable");
  writeFileSync(recordPath, "{ not json");
  assert.equal(codeOf(() => readDeclaredDeletions(root, "directory")), "declared_deletions_unreadable");
  assert.equal(codeOf(() => consumeDeclaredDeletions(root)), "declared_deletions_unreadable");
  assert.deepEqual(clearDeclaredDeletions(root).cleared, [], "an unreadable record names nothing, and is still removed");
  assert.equal(existsSync(recordPath), false);
});

test("BOUND TO ITS INDEX: a linked worktree's declarations live in its own git directory and never reach the main checkout", () => {
  const root = plantedRepository();
  const linked = join(realpathSync(createTempDir("declared-deletions-linked-")), "tree");
  git(root, "worktree", "add", "-q", "-b", "side", linked);
  rmSync(join(linked, "docs", "paper.md"));
  const declared = declareDeletions(linked, ["docs/paper.md"]);
  assert.match(declared.recordPath, /\/\.git\/worktrees\/[^/]+\/bridlewise\/declared-deletions\.json$/u);
  assert.equal(readDeclaredDeletions(root, "directory").entries.size, 0, "a linked worktree's declaration reached the main checkout");
  assert.equal(existsSync(declaredDeletionsPath(root)), false);
  assert.equal(readDeclaredDeletions(linked, "directory").entries.size, 1);
});

test("the CLI's paths are taken literally: arguments, one path per line of each --paths-file, one per NUL of each --paths-file-nul, and anything after --", () => {
  const folder = createTempDir("declared-deletions-cli-");
  const file = join(folder, "paths.txt");
  writeFileSync(file, "docs/a.md\ndocs/b c.md\n");
  assert.deepEqual(declarationPaths(["x.md", "--paths-file", file, "y*.md"]), ["x.md", "docs/a.md", "docs/b c.md", "y*.md"]);
  writeFileSync(file, "docs/a.md\n\ndocs/b.md");
  assert.deepEqual(declarationPaths(["--paths-file", file]), ["docs/a.md", "", "docs/b.md"], "a blank line is passed on (and refused as a path), never skipped");
  // An EMPTY file names no path: the declare that follows is a usage refusal,
  // never a refused "" path (wf-del-verify N2).
  writeFileSync(file, "");
  assert.deepEqual(declarationPaths(["--paths-file", file]), []);
  // What `git diff -z --name-only` writes: no path is ever quoted, a newline
  // inside one survives (N3).
  const nul = join(folder, "paths.nul");
  writeFileSync(nul, "docs/a.md\0odd\nname.md\0\"quoted\".md\0");
  assert.deepEqual(declarationPaths(["--paths-file-nul", nul]), ["docs/a.md", "odd\nname.md", "\"quoted\".md"]);
  // `--` ends the options: a path beginning with `--` can be declared (N1).
  assert.deepEqual(declarationPaths(["a.md", "--", "--weird.md", "--paths-file"]), ["a.md", "--weird.md", "--paths-file"]);
  assert.equal(codeOf(() => declarationPaths(["--paths-file"])), "declared_deletion_usage");
  assert.equal(codeOf(() => declarationPaths(["--paths-file-nul"])), "declared_deletion_usage");
  assert.equal(codeOf(() => declarationPaths(["--all"])), "unknown_flag");
});

test("the status verb fails for any declaration that is not pending (stale, mismatched, expired), and passes otherwise", async () => {
  const { harnessDeletions } = await import("../../src/workflow/harness-commands.ts");
  const root = plantedRepository();
  rmSync(join(root, "docs", "paper.md"));
  harnessDeletions(root, ["declare", "--", "docs/paper.md"]);
  assert.equal(harnessDeletions(root, ["status"]).status, "pass");
  git(root, "checkout", "--", "docs/paper.md");
  assert.equal(harnessDeletions(root, ["status"]).status, "fail", "an expired declaration passed the status verb");
  const emptyFile = join(createTempDir("declared-deletions-empty-"), "none.txt");
  writeFileSync(emptyFile, "");
  assert.equal(codeOf(() => harnessDeletions(root, ["declare", "--paths-file", emptyFile])), "declared_deletion_usage");
});

/** Runs `harness deletions <verb>`'s primitive in a child process of its own: one real contender. */
function contender(root: string, call: string): Promise<string> {
  const module = pathToFileURL(join(import.meta.dirname, "..", "..", "src", "git", "declared-deletions.ts")).href;
  const code = `import(${JSON.stringify(module)}).then((m) => process.stdout.write(JSON.stringify(${call})), (e) => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (status) => (status === 0 ? resolve(out) : reject(new Error(`contender ${call} exited ${String(status)}: ${err}`))));
  });
}

/** A repository with `count` committed files `docs/f<N>.md`, every one deleted from the disk. */
function manyDeletions(count: number): string {
  const root = realpathSync(createTempDir("declared-deletions-many-"));
  git(root, "init", "-q");
  mkdirSync(join(root, "docs"));
  for (let index = 1; index <= count; index += 1) writeFileSync(join(root, "docs", `f${String(index)}.md`), `# file ${String(index)}\n`);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  for (let index = 1; index <= count; index += 1) rmSync(join(root, "docs", `f${String(index)}.md`));
  return root;
}

test("ONE WRITER AT A TIME: twelve declares in parallel processes all land in the record", async () => {
  // wf-del-verify V3 A7a: without the lock, 12 exited 0 and the record held 7.
  const root = manyDeletions(12);
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => contender(root, `m.declareDeletions(${JSON.stringify(root)}, ["docs/f${String(index + 1)}.md"]).total`)));
  assert.equal(results.length, 12);
  assert.deepEqual(declaredDeletionsStatus(root).declarations.map((entry) => entry.path).sort(), Array.from({ length: 12 }, (_, index) => `docs/f${String(index + 1)}.md`).sort(), "a parallel declare was lost");
  assert.equal(existsSync(`${declaredDeletionsPath(root)}.lock`), false, "a released lock leaves nothing behind");
});

test("ONE WRITER AT A TIME: a clear racing parallel declares never brings back what it reported withdrawn", async () => {
  // wf-del-verify V3 A7c: a declare that read the record before the clear wrote
  // the withdrawn entries back (2 of 12 trials).
  for (let trial = 0; trial < 3; trial += 1) {
    const root = manyDeletions(9);
    declareDeletions(root, ["docs/f1.md"]);
    const declares = Array.from({ length: 8 }, (_, index) => contender(root, `m.declareDeletions(${JSON.stringify(root)}, ["docs/f${String(index + 2)}.md"]).total`));
    const cleared = contender(root, `m.clearDeclaredDeletions(${JSON.stringify(root)}).cleared`);
    const [withdrawn] = await Promise.all([cleared.then((text) => JSON.parse(text) as string[]), ...declares]);
    const after = new Set(declaredDeletionsStatus(root).declarations.map((entry) => entry.path));
    assert.equal(withdrawn.includes("docs/f1.md"), true, "the clear ran after the first declaration, so it withdrew it");
    assert.equal(after.has("docs/f1.md"), false, `trial ${String(trial)}: the clear reported docs/f1.md withdrawn and a racing declare wrote it back`);
    for (const path of withdrawn) assert.equal(after.has(path), false, `trial ${String(trial)}: ${path} was reported withdrawn and is declared again`);
  }
});
