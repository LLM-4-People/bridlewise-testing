/**
 * THE TREE READERS (src/git/tree-reader.ts): a commit's files by object id and
 * mode (bytes binary-safe), a working tree's as `git add -A` would commit
 * them, and the tree writer that builds a tree in a PRIVATE index.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { commitTreeReader, gitOutput, nativeObjectRepository, rawDiffEntries, treeDiff, workingTreeReader, writeBlob, writeTree, type GitRepository } from "../../src/git/tree-reader.ts";
import { configuredGitRepository } from "../../src/git/worktree-port.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { testGitIdentityEnvironment } from "../support/test-git-identity.ts";

function repository(objectView: "configured" | "ordinary" = "configured"): Readonly<{ root: string; repo: GitRepository; git: (...args: string[]) => string }> {
  const root = createTempDir("tree-reader-");
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...testGitIdentityEnvironment() } }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(root, "text.ts"), "export const é = 'ünïcode';\n");
  writeFileSync(join(root, "binary.bin"), Buffer.from([0, 255, 254, 10, 0x80, 0x81]));
  writeFileSync(join(root, "run.sh"), "#!/bin/sh\n");
  chmodSync(join(root, "run.sh"), 0o755);
  symlinkSync("text.ts", join(root, "link.ts"));
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  const configured = configuredGitRepository({}, root);
  // An explicit ordinary test oracle proves the hostile view actually exists;
  // normal fixtures retain the configured factory's semantics.
  const repo = objectView === "ordinary" ? { root: configured.root, executable: configured.executable, timeoutMs: configured.timeoutMs } : configured;
  return { root, repo, git };
}

test("a commit reader lists every file with git's mode and object id, and reads text by batch", () => {
  const { repo, git } = repository();
  const reader = commitTreeReader(repo, git("rev-parse", "HEAD"));
  assert.deepEqual(reader.paths(), [".gitignore", "binary.bin", "link.ts", "run.sh", "text.ts"]);
  assert.deepEqual(reader.entry("run.sh"), { mode: "100755", oid: git("rev-parse", "HEAD:run.sh") });
  assert.deepEqual(reader.entry("link.ts"), { mode: "120000", oid: git("rev-parse", "HEAD:link.ts") });
  assert.equal(reader.entry("absent.ts"), null);
  reader.prefetch(["text.ts", "link.ts", "binary.bin", "absent.ts"]);
  assert.equal(reader.text("text.ts"), "export const é = 'ünïcode';\n", "multi-byte text after a binary blob in the same batch");
  assert.equal(reader.text("link.ts"), "text.ts", "a symlink's bytes are its target");
  assert.equal(reader.text("absent.ts"), null);
});

test("a working-tree reader holds what `git add -A` would commit: untracked and unignored in, ignored and deleted out", () => {
  const { root } = repository();
  writeFileSync(join(root, "new.ts"), "export {};\n");
  writeFileSync(join(root, "ignored.txt"), "x");
  rmSync(join(root, "binary.bin"));
  const reader = workingTreeReader(root);
  assert.deepEqual(reader.paths(), [".gitignore", "link.ts", "new.ts", "run.sh", "text.ts"]);
  assert.deepEqual(reader.entry("run.sh"), { mode: "100755", oid: null });
  assert.equal(reader.entry("link.ts")?.mode, "120000");
  assert.equal(reader.text("new.ts"), "export {};\n");
});

test("the tree writer builds exactly the entries given, binary-safe, in a private index the repository never sees", () => {
  const { root, repo, git } = repository();
  const indexBefore = readFileSync(join(root, ".git", "index"));
  const head = commitTreeReader(repo, git("rev-parse", "HEAD"));
  const blob = writeBlob(repo, Buffer.from([1, 2, 3, 0, 255]));
  const scratch = createTempDir("tree-writer-scratch-");
  const tree = writeTree(repo, new Map([
    ["binary.bin", { mode: "100644", oid: head.entry("binary.bin")!.oid! }],
    ["deep/new.bin", { mode: "100755", oid: blob }],
  ]), scratch);
  assert.equal(git("ls-tree", "-r", tree), [`100644 blob ${head.entry("binary.bin")!.oid!}\tbinary.bin`, `100755 blob ${blob}\tdeep/new.bin`].join("\n"));
  assert.deepEqual(execFileSync("git", ["cat-file", "blob", blob], { cwd: root }), Buffer.from([1, 2, 3, 0, 255]));
  assert.deepEqual(readFileSync(join(root, ".git", "index")), indexBefore, "the repository's index is untouched");
  assert.deepEqual(readdirSync(scratch), [], "the private index is removed after the call");
});

test("PC-1: concurrent writers and a crashed writer's leftover index never leak into a written tree", async () => {
  const { repo, git } = repository();
  const head = commitTreeReader(repo, git("rev-parse", "HEAD"));
  const scratch = createTempDir("tree-writer-race-");
  // A crash between `update-index` and the clean-up leaves an index behind: a
  // writer that reused a predictable name would EXTEND it (a stale entry ships).
  const stale = join(scratch, "index-stale");
  mkdirSync(stale);
  execFileSync("git", ["update-index", "--add", "--cacheinfo", `100644,${head.entry("text.ts")!.oid!},docs/PLANTED-STALE.md`], { cwd: repo.root, env: { ...process.env, GIT_INDEX_FILE: join(stale, "index") } });
  // A crashed writer's OWNED leftover (its owner is dead) is swept by the next writer.
  const crashed = join(scratch, "index-999999999-1-abcdef");
  mkdirSync(crashed);
  const entries = new Map([["run.sh", { mode: "100755", oid: head.entry("run.sh")!.oid! }]]);
  const expected = `100755 blob ${head.entry("run.sh")!.oid!}\trun.sh`;
  // Eight writers of the same entries in one scratch directory, from parallel processes.
  const script = `import { writeTree } from ${JSON.stringify(new URL("../../src/git/tree-reader.ts", import.meta.url).href)};
const repo = JSON.parse(process.argv[1]); const entries = new Map(JSON.parse(process.argv[2]));
process.stdout.write(writeTree(repo, entries, process.argv[3]));`;
  const trees = await Promise.all(Array.from({ length: 8 }, () => new Promise<string>((resolveTree, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(repo), JSON.stringify([...entries]), scratch], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString("utf8"); });
    child.on("close", (status) => (status === 0 ? resolveTree(out.trim()) : reject(new Error(err))));
  })));
  for (const tree of trees) assert.equal(git("ls-tree", "-r", tree), expected, "every concurrent writer answers the planned tree, never the empty one");
  assert.equal(git("ls-tree", "-r", writeTree(repo, entries, scratch)), expected, "a leftover index is never extended");
  assert.deepEqual(readdirSync(scratch), ["index-stale"], "each call removes its own index, a dead owner's is swept, and nothing else is touched");
  assert.equal(existsSync(crashed), false);
});

test("PC-1: a written tree that does not hold exactly the entries given is refused, never answered", () => {
  const { repo, git } = repository();
  const blob = commitTreeReader(repo, git("rev-parse", "HEAD")).entry("run.sh")!.oid!;
  // git's index silently resolves a file/folder conflict by keeping the folder's
  // entry: the tree it writes holds `run.sh/inner.sh` and not `run.sh`.
  assert.throws(
    () => writeTree(repo, new Map([["run.sh", { mode: "100755", oid: blob }], ["run.sh/inner.sh", { mode: "100644", oid: blob }]]), createTempDir("tree-writer-mismatch-")),
    (error: unknown) => (error as { code?: string }).code === "tree_writer_mismatch" && /run\.sh/u.test((error as Error).message),
  );
});

test("PC-7: a path that is not UTF-8 is refused by name, never renamed", () => {
  const { root, repo, git } = repository();
  const blob = git("rev-parse", "HEAD:run.sh");
  execFileSync("git", ["update-index", "-z", "--index-info"], { cwd: root, input: Buffer.concat([Buffer.from(`100644 ${blob}\t`), Buffer.from([0x63, 0x61, 0x66, 0xe9]), Buffer.from(".txt\0")]) });
  const commit = execFileSync("git", ["commit-tree", git("write-tree"), "-p", "HEAD", "-m", "latin-1"], { cwd: root, encoding: "utf8", env: { ...process.env, ...testGitIdentityEnvironment() } }).trim();
  assert.throws(() => commitTreeReader(repo, commit), (error: unknown) => (error as { code?: string }).code === "tree_reader_path_not_utf8");
});

test("PC-8: every tree-reader git call runs the configured executable under its ceiling", () => {
  const { root } = repository();
  const hung = createTempDir("tree-reader-hung-git-");
  const fake = join(hung, "git");
  writeFileSync(fake, "#!/bin/sh\nsleep 30\n");
  chmodSync(fake, 0o755);
  // The refusal names the CEILING: that is the path that ended the hung git
  // (left alone it would end itself after 30 s, with no such refusal), never
  // a wall clock (NO-LOAD-BLOCK).
  assert.throws(() => commitTreeReader({ root, executable: fake, timeoutMs: 300 }, "HEAD"), (error: unknown) => (error as { code?: string; message?: string }).code === "tree_reader_git_failed" && /ceiling/u.test((error as Error).message));
});

test("the one raw-diff reader: both sides' modes and ids, the status and the path; a deletion keeps its source mode; a non-UTF-8 path and a malformed record are refused", () => {
  const { root, repo, git } = repository();
  const before = git("rev-parse", "HEAD");
  rmSync(join(root, "link.ts"));
  chmodSync(join(root, "run.sh"), 0o644);
  writeFileSync(join(root, "new é.ts"), "export const n = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "change");
  const after = git("rev-parse", "HEAD");
  const entries = treeDiff(repo, before, after);
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  assert.deepEqual(byPath.get("link.ts"), { srcMode: "120000", dstMode: "000000", srcOid: git("rev-parse", `${before}:link.ts`), dstOid: "0".repeat(40), status: "D", path: "link.ts" });
  assert.deepEqual([byPath.get("run.sh")!.srcMode, byPath.get("run.sh")!.dstMode, byPath.get("run.sh")!.status], ["100755", "100644", "M"]);
  assert.equal(byPath.get("new é.ts")!.status, "A", "a UTF-8 path is read as git keeps it");
  assert.equal(entries.length, 3);

  // A path whose bytes are not UTF-8 is refused, never decoded into another name.
  const raw = Buffer.concat([Buffer.from("raw-"), Buffer.from([0xff]), Buffer.from(".txt")]);
  writeFileSync(Buffer.concat([Buffer.from(`${root}/`), raw]), "y\n");
  execFileSync("git", ["add", "-A"], { cwd: root });
  git("commit", "-q", "-m", "a raw byte name");
  assert.throws(() => treeDiff(repo, after, git("rev-parse", "HEAD")), { code: "tree_reader_path_not_utf8" });

  assert.throws(() => rawDiffEntries(["not a header", "path"]), { code: "tree_reader_raw_diff_invalid" });
  assert.deepEqual(rawDiffEntries([]), []);
});

test("a native object view binds raw commits, recursive tree reads and blob bytes despite replacement refs", () => {
  const { root, repo, git } = repository("ordinary");
  const first = git("rev-parse", "HEAD");
  const original = gitOutput(repo, ["cat-file", "commit", first]).stdout;
  const originalBlob = git("rev-parse", `${first}:text.ts`);
  const originalText = commitTreeReader(repo, first).text("text.ts");
  writeFileSync(join(root, "text.ts"), "replacement tree\n");
  git("add", "--", "text.ts");
  git("commit", "-q", "-m", "Replacement tree");
  const second = git("rev-parse", "HEAD");
  git("replace", first, second);
  const replacementBlob = writeBlob(repo, Buffer.from("replacement blob\n"));
  git("replace", originalBlob, replacementBlob);
  assert.notDeepEqual(gitOutput(repo, ["cat-file", "commit", first]).stdout, original, "ordinary Git semantics remain available");
  assert.equal(gitOutput(repo, ["cat-file", "blob", originalBlob]).stdout.toString("utf8"), "replacement blob\n");
  const native = nativeObjectRepository(repo);
  assert.deepEqual(gitOutput(native, ["cat-file", "commit", first], { environment: { GIT_NO_REPLACE_OBJECTS: "0" } }).stdout, original, "caller environment cannot enable replacement objects");
  assert.deepEqual(gitOutput(nativeObjectRepository(configuredGitRepository({}, root)), ["cat-file", "commit", first]).stdout, original, "the explicit wrapper around the configured factory preserves native commit identity");
  assert.equal(commitTreeReader(native, first).text("text.ts"), originalText);
  assert.equal(gitOutput(native, ["cat-file", "blob", originalBlob]).stdout.toString("utf8"), originalText);
  assert.deepEqual(treeDiff(native, first, second).map((entry) => entry.path), ["text.ts"]);
  assert.equal(repo.nativeObjectIdentity, undefined, "the source handle is unchanged");
  assert.equal(Object.isFrozen(native), true);
});


function commitHistory(repository: GitRepository, head: string, environment: Readonly<Record<string, string>> = {}): readonly string[] {
  return gitOutput(repository, ["rev-list", head], { environment }).stdout.toString("ascii").trim().split("\n");
}

test("a native object view ignores legacy graft history even when a caller supplies its path", () => {
  const { root, repo, git } = repository("ordinary");
  const first = git("rev-parse", "HEAD");
  const tree = git("rev-parse", "HEAD^{tree}");
  const second = git("commit-tree", tree, "-p", first, "-m", "Native child");
  const foreign = git("commit-tree", tree, "-p", first, "-m", "Foreign history");
  const grafts = join(root, ".git", "info", "grafts");
  writeFileSync(grafts, `${second} ${foreign}\n`);
  assert.deepEqual(commitHistory(repo, second), [second, foreign, first], "ordinary Git honors the planted legacy graft");
  assert.deepEqual(commitHistory(nativeObjectRepository(repo), second, { GIT_GRAFT_FILE: grafts }), [second, first], "native ancestry comes from the commit, not a caller's graft file");
  assert.deepEqual(commitHistory(nativeObjectRepository(configuredGitRepository({}, root)), second, { GIT_GRAFT_FILE: grafts }), [second, first], "explicit configured native authority cannot inherit a graft");
});

test("a native object view ignores shallow boundaries and refuses incomplete ancestry", () => {
  const { root, repo, git } = repository("ordinary");
  const first = git("rev-parse", "HEAD");
  const second = git("commit-tree", git("rev-parse", "HEAD^{tree}"), "-p", first, "-m", "Complete native child");
  const shallow = join(root, ".git", "shallow");
  writeFileSync(shallow, `${second}\n`);
  const historyEnvironment = { GIT_SHALLOW_FILE: shallow };
  assert.deepEqual(commitHistory(repo, second, historyEnvironment), [second], "ordinary Git honors the shallow boundary");
  const native = nativeObjectRepository(repo);
  assert.deepEqual(commitHistory(native, second, historyEnvironment), [second, first], "a caller cannot truncate native ancestry");
  assert.deepEqual(commitHistory(nativeObjectRepository(configuredGitRepository({}, root)), second, historyEnvironment), [second, first], "explicit configured native authority cannot inherit a shallow boundary");
  const raw = gitOutput(native, ["cat-file", "commit", second]).stdout.toString("utf8").replace(`parent ${first}\n`, `parent ${"f".repeat(40)}\n`);
  const broken = gitOutput(native, ["hash-object", "-w", "-t", "commit", "--stdin"], { input: Buffer.from(raw) }).stdout.toString("ascii").trim();
  writeFileSync(shallow, `${broken}\n`);
  assert.deepEqual(commitHistory(repo, broken, historyEnvironment), [broken], "a shallow boundary can conceal the fixture's missing parent");
  assert.throws(() => commitHistory(native, broken, historyEnvironment), (error: unknown) => error instanceof Error && (error as { code?: unknown }).code === "tree_reader_git_failed", "missing native parents are a typed refusal, never a fabricated root");
});

test("native Git status preserves raw index metadata despite a caller requesting optional locks", () => {
  const { root, repo, git } = repository();
  const native = nativeObjectRepository(repo);
  const path = join(root, "text.ts");
  const beforeFile = statSync(path);
  const replacement = join(root, "native-index-refresh-replacement");
  writeFileSync(replacement, readFileSync(path));
  renameSync(replacement, path);
  assert.notEqual(statSync(path).ino, beforeFile.ino, "the same bytes now have a different inode");
  const index = git("rev-parse", "--path-format=absolute", "--git-path", "index");
  const indexBefore = readFileSync(index);
  const stageBefore = gitOutput(native, ["ls-files", "--stage", "-z"]).stdout;
  const compared = gitOutput(native, ["status", "--porcelain=v2", "--untracked-files=no", "--no-renames", "-z"], { environment: { GIT_OPTIONAL_LOCKS: "1" } });
  assert.equal(compared.stdout.length, 0, "there is no content change to report");
  assert.deepEqual(readFileSync(index), indexBefore, "native status cannot refresh raw index stat metadata");
  assert.deepEqual(gitOutput(native, ["ls-files", "--stage", "-z"]).stdout, stageBefore, "all staged object IDs and modes are preserved");
});
