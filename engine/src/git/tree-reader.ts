/**
 * TREE READERS — one port over "the files of a tree": a COMMIT's (read from
 * the object store: one `git ls-tree` for the listing, `git cat-file --batch`
 * for the bytes, batched, never one process per file) or a WORKING TREE's (the
 * files `git add -A` would commit, read from disk). A consumer that classifies
 * or walks a tree (the promotion projection, the source-side boundary guard)
 * is written once against {@link TreeReader} and runs over either.
 *
 * Entries keep git's own identity: a commit entry is its mode and object id,
 * never re-encoded (a binary blob is compared by id, its bytes are never a
 * string); `text` decodes UTF-8 for the files a walk parses. A working-tree
 * entry carries the mode git would record and no object id (nothing is
 * hashed until something asks for one). A path is UTF-8 or refused
 * (`tree_reader_path_not_utf8`): a decoded-and-re-encoded path would name
 * another file in a tree written from it.
 *
 * Every git process runs through the one git door (`gitOutput`,
 * src/git/git-door.ts), as the one bounded run.
 */
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

import { HarnessError } from "../kernel/errors.ts";
import { deepFreeze } from "../kernel/integrity.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { createOwnedTemporaryDirectory, removeOwnedTemporaryDirectory } from "../filesystem/private-state.ts";
import { RAW_DIFF_RECORD_QUOTE_CHARACTERS, TREE_MISMATCH_ENTRIES_NAMED } from "./git-config.ts";
import { ownedFiles } from "./repository-ownership.ts";
import { gitOutput, type GitRepository } from "./git-door.ts";

/** The gitlink (submodule) mode: an entry with no bytes in this repository. */
export const GITLINK_MODE = "160000";
/** The symbolic-link mode: the entry's bytes are the link target. */
export const SYMLINK_MODE = "120000";

/** One file of a tree, as git records it. */
export type TreeEntry = Readonly<{
  /** Git's mode: `100644`, `100755`, `120000` (a symlink) or `160000` (a gitlink). */
  mode: string;
  /** The object id (a commit reader); `null` for a working-tree file nobody has hashed. */
  oid: string | null;
}>;

export type TreeReader = Readonly<{
  /** What is read: a commit id, or `working tree <root>`. */
  label: string;
  /** Every file path of the tree, repository-relative, sorted. */
  paths(): readonly string[];
  /** The entry at `path`, or `null` when the tree holds none. */
  entry(path: string): TreeEntry | null;
  /** The UTF-8 text at `path` (a symlink's target), or `null` when absent or a gitlink. Served from the batch cache when prefetched. */
  text(path: string): string | null;
  /** Reads `paths` in as few processes as the output bound allows, so the following `text` calls are cache hits. */
  prefetch(paths: Iterable<string>): void;
}>;

/** The object `rev` names in `repository`, peeled to `kind` (a commit by default), or `null` when it names none. */
/** Whether `ancestor` is `descendant` or one of its ancestors (`merge-base --is-ancestor`); an unknown commit is git's typed failure. */
export function isAncestor(repository: GitRepository, ancestor: string, descendant: string): boolean {
  return gitOutput(repository, ["merge-base", "--is-ancestor", ancestor, descendant], { allowed: [0, 1] }).status === 0;
}

export function resolveRevision(repository: GitRepository, rev: string, kind: "commit" | "tree" | "object" = "commit"): string | null {
  const found = gitOutput(repository, ["rev-parse", "-q", "--verify", `${rev}^{${kind}}`], { allowed: [0, 1] });
  return found.status === 0 ? found.stdout.toString("utf8").trim() : null;
}

function gitBytes(repository: GitRepository, argv: readonly string[], input?: Buffer): Buffer {
  return gitOutput(repository, argv, input === undefined ? {} : { input }).stdout;
}

/** The repository path of a NUL-terminated git record's path bytes, refused (`tree_reader_path_not_utf8`) unless they are UTF-8. */
function utf8Path(bytes: Buffer, where: string): string {
  const path = bytes.toString("utf8");
  if (!Buffer.from(path, "utf8").equals(bytes)) {
    throw new HarnessError(`${where} holds a path that is not UTF-8 (${bytes.toString("hex")}): rename it on its branch; a tree written from a decoded path would name another file`, "tree_reader_path_not_utf8");
  }
  return path;
}

/** The records of a `-z` listing: each NUL-terminated record's bytes. */
function nulRecords(output: Buffer): readonly Buffer[] {
  const records: Buffer[] = [];
  for (let start = 0; start < output.length;) {
    const end = output.indexOf(0, start);
    const stop = end < 0 ? output.length : end;
    if (stop > start) records.push(output.subarray(start, stop));
    start = stop + 1;
  }
  return records;
}

/** One entry of git's raw diff: both sides' mode and object id (`000000` and the null id where a side has none), the status letter, the path. */
export type RawDiffEntry = Readonly<{ srcMode: string; dstMode: string; srcOid: string; dstOid: string; status: string; path: string }>;

/**
 * THE ONE READER of git's raw diff (`--raw -z --no-abbrev --no-renames`):
 * its NUL-separated records, `:<src mode> <dst mode> <src id> <dst id>
 * <status>` then the path, as entries. Every consumer of a raw diff (the
 * index baseline's protected entries, the worktree port's deleted blobs, the
 * workspace publisher's tree delta) reads it here; {@link treeDiff} is the
 * binary-safe door that also checks each path.
 */
export function rawDiffEntries(records: readonly string[]): readonly RawDiffEntry[] {
  const entries: RawDiffEntry[] = [];
  for (let index = 0; index + 1 < records.length; index += 2) {
    const header = records[index]!;
    if (!header.startsWith(":")) {
      throw new HarnessError(`git's raw diff holds a record that is not a header where one was expected: ${header.slice(0, RAW_DIFF_RECORD_QUOTE_CHARACTERS)}`, "tree_reader_raw_diff_invalid");
    }
    const [srcMode, dstMode, srcOid, dstOid, status] = header.slice(1).split(" ");
    entries.push(deepFreeze({ srcMode: srcMode!, dstMode: dstMode!, srcOid: srcOid!, dstOid: dstOid!, status: status!, path: records[index + 1]! }));
  }
  return deepFreeze(entries);
}

/** The raw tree diff (recursive, no renames) from `from` to `to` in `repository`, each path checked UTF-8 (`tree_reader_path_not_utf8`). */
export function treeDiff(repository: GitRepository, from: string, to: string): readonly RawDiffEntry[] {
  const records = nulRecords(gitBytes(repository, ["diff-tree", "-r", "-z", "--raw", "--no-abbrev", "--no-renames", from, to]));
  return rawDiffEntries(records.map((record, index) => (index % 2 === 1 ? utf8Path(record, to) : record.toString("utf8"))));
}

type CommitEntry = Readonly<{ mode: string; type: string; oid: string; size: number }>;

/**
 * THE ONE BATCHED BLOB READ: the bytes of each object `names` names (an object
 * id, `<commit>:<path>`, or `:<path>` for the index), in order, through
 * `git cat-file --batch`, in batches whose sizes fit half the git output
 * bound. `sizes` are the objects' sizes when the caller has them (a tree
 * listing); otherwise one `--batch-check` asks for them. A name that is not a
 * blob is a typed refusal (`tree_reader_git_failed`).
 */
export function readBlobs(repository: GitRepository, names: readonly string[], sizes?: readonly number[]): readonly Buffer[] {
  if (names.length === 0) return [];
  // The batch protocol is one name per line: a name holding a newline cannot be asked this way.
  const unaskable = names.find((name) => name.includes("\n"));
  if (unaskable !== undefined) throw new HarnessError(`a blob name holds a newline, which git cat-file --batch cannot read: ${JSON.stringify(unaskable)}`, "tree_reader_name_unaskable");
  const known = sizes ?? gitBytes(repository, ["cat-file", "--batch-check"], Buffer.from(`${names.join("\n")}\n`)).toString("utf8").split("\n").slice(0, names.length).map((line, index) => {
    const [, type, size] = line.split(" ");
    if (type !== "blob" || size === undefined) throw new HarnessError(`git cat-file --batch-check answered "${line}" for ${names[index]!}`, "tree_reader_git_failed");
    return Number(size);
  });
  const batchBytes = Math.floor(ROOT_POLICY.runtime.limits.maximumGitOutputBytes / 2);
  const read: Buffer[] = [];
  let start = 0;
  while (start < names.length) {
    let end = start + 1;
    let bytes = known[start]!;
    while (end < names.length && bytes + known[end]! <= batchBytes) bytes += known[end++]!;
    const batch = names.slice(start, end);
    const output = gitBytes(repository, ["cat-file", "--batch"], Buffer.from(`${batch.join("\n")}\n`));
    let offset = 0;
    for (const name of batch) {
      const newline = output.indexOf(0x0a, offset);
      const header = output.subarray(offset, newline).toString("utf8").split(" ");
      const size = Number(header[2]);
      if (header[1] !== "blob" || !Number.isInteger(size)) throw new HarnessError(`git cat-file --batch answered "${header.join(" ")}" for ${name}`, "tree_reader_git_failed");
      read.push(output.subarray(newline + 1, newline + 1 + size));
      offset = newline + 1 + size + 1;
    }
    start = end;
  }
  return read;
}

/**
 * The files of `commit` in `repository`. The listing is one
 * `git ls-tree -r -l -z --full-tree`; bytes are read by object id through
 * `git cat-file --batch`, in batches whose declared sizes fit half the git
 * output bound.
 */
export function commitTreeReader(repository: GitRepository, commit: string): TreeReader {
  const listing = new Map<string, CommitEntry>();
  for (const record of nulRecords(gitBytes(repository, ["ls-tree", "-r", "-l", "-z", "--full-tree", commit]))) {
    const tab = record.indexOf(0x09);
    const [mode, type, oid, size] = record.subarray(0, tab).toString("utf8").split(/ +/u);
    listing.set(utf8Path(record.subarray(tab + 1), commit), deepFreeze({ mode: mode!, type: type!, oid: oid!, size: size === "-" ? 0 : Number(size) }));
  }
  const sorted = deepFreeze([...listing.keys()].sort());
  const texts = new Map<string, string | null>();
  const batchBytes = Math.floor(ROOT_POLICY.runtime.limits.maximumGitOutputBytes / 2);
  const readBatch = (paths: readonly string[]): void => {
    const blobs = paths.filter((path) => listing.get(path)!.type === "blob");
    for (const path of paths) if (listing.get(path)!.type !== "blob") texts.set(path, null);
    if (blobs.length === 0) return;
    const bytes = readBlobs(repository, blobs.map((path) => listing.get(path)!.oid), blobs.map((path) => listing.get(path)!.size));
    blobs.forEach((path, index) => texts.set(path, bytes[index]!.toString("utf8")));
  };
  const prefetch = (wanted: Iterable<string>): void => {
    let batch: string[] = [];
    let bytes = 0;
    for (const path of new Set(wanted)) {
      const entry = listing.get(path);
      if (entry === undefined || texts.has(path)) continue;
      if (batch.length > 0 && bytes + entry.size > batchBytes) {
        readBatch(batch);
        batch = [];
        bytes = 0;
      }
      batch.push(path);
      bytes += entry.size;
    }
    if (batch.length > 0) readBatch(batch);
  };
  return deepFreeze({
    label: commit,
    paths: () => sorted,
    entry(path: string): TreeEntry | null {
      const entry = listing.get(path);
      return entry === undefined ? null : deepFreeze({ mode: entry.mode, oid: entry.oid });
    },
    text(path: string): string | null {
      if (!listing.has(path)) return null;
      if (!texts.has(path)) prefetch([path]);
      return texts.get(path) ?? null;
    },
    prefetch,
  });
}

/**
 * The files of the working tree at `root` (its top level): what the repository
 * OWNS (`ownedFiles`: the tracked files still on disk and the untracked files
 * no versioned ignore rule names — what any clone would commit) — read from
 * disk.
 */
export function workingTreeReader(root: string): TreeReader {
  const listed = ownedFiles(root);
  if (listed === undefined) throw new HarnessError(`${root} is not inside a git working tree`, "tree_reader_git_failed");
  const entries = new Map<string, TreeEntry>();
  for (const path of listed) {
    const stats = lstatSync(join(root, path), { throwIfNoEntry: false });
    if (stats === undefined) continue;
    const mode = stats.isSymbolicLink() ? SYMLINK_MODE : stats.isDirectory() ? GITLINK_MODE : (stats.mode & 0o111) !== 0 ? "100755" : "100644";
    entries.set(path, deepFreeze({ mode, oid: null }));
  }
  const sorted = deepFreeze([...entries.keys()].sort());
  const texts = new Map<string, string | null>();
  const text = (path: string): string | null => {
    const entry = entries.get(path);
    if (entry === undefined || entry.mode === GITLINK_MODE) return null;
    if (!texts.has(path)) texts.set(path, entry.mode === SYMLINK_MODE ? readlinkSync(join(root, path)) : readFileSync(join(root, path), "utf8"));
    return texts.get(path) ?? null;
  };
  return deepFreeze({
    label: `working tree ${root}`,
    paths: () => sorted,
    entry: (path: string): TreeEntry | null => entries.get(path) ?? null,
    text,
    prefetch(paths: Iterable<string>): void {
      for (const path of paths) text(path);
    },
  });
}

/** Writes `bytes` to the object store of `repository` (binary-safe) and answers the blob id. */
export function writeBlob(repository: GitRepository, bytes: Buffer | string): string {
  return gitBytes(repository, ["hash-object", "-w", "--stdin"], Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8")).toString("utf8").trim();
}

/**
 * Writes the tree holding exactly `entries` (path → mode and object id) and
 * answers its id. It is built in a private index of its own — an owned
 * temporary directory under `scratchDirectory` per call (the one
 * owned-temporary rule: removed after, and a crashed call's swept by the
 * next) — so neither the repository's index nor a concurrent or crashed
 * call's can leak into it; and
 * the written tree is read back and compared with `entries` before it is
 * answered (`tree_writer_mismatch`: a tree that holds anything else is never
 * returned).
 */
export function writeTree(repository: GitRepository, entries: ReadonlyMap<string, Readonly<{ mode: string; oid: string }>>, scratchDirectory: string): string {
  const directory = createOwnedTemporaryDirectory(scratchDirectory, "index-");
  const environment = { GIT_INDEX_FILE: join(directory, "index") };
  try {
    const info = [...entries].map(([path, entry]) => `${entry.mode} ${entry.oid}\t${path}\0`).join("");
    gitOutput(repository, ["update-index", "-z", "--index-info"], { input: Buffer.from(info, "utf8"), environment });
    const tree = gitOutput(repository, ["write-tree"], { environment }).stdout.toString("utf8").trim();
    const written = commitTreeReader(repository, tree);
    const stray = written.paths().filter((path) => {
      const entry = written.entry(path)!;
      const expected = entries.get(path);
      return expected === undefined || expected.mode !== entry.mode || expected.oid !== entry.oid;
    });
    const missing = [...entries.keys()].filter((path) => written.entry(path) === null);
    if (stray.length > 0 || missing.length > 0) {
      throw new HarnessError(`the tree ${tree} written in ${repository.root} does not hold exactly the ${String(entries.size)} entries given (missing: ${missing.slice(0, TREE_MISMATCH_ENTRIES_NAMED).join(", ") || "none"}; differing or unexpected: ${stray.slice(0, TREE_MISMATCH_ENTRIES_NAMED).join(", ") || "none"})`, "tree_writer_mismatch");
    }
    return tree;
  } finally {
    removeOwnedTemporaryDirectory(directory);
  }
}
