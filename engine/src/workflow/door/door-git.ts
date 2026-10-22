/**
 * THE DOOR'S GIT READS — on the door's own checkout of `main`, through the one
 * git door (`../../git/tree-reader.ts` `gitOutput`): fetching the judged
 * commits without their blobs (`--filter=blob:none`; a blob is fetched only
 * when a read needs it), reading a commit's files, its diff against a base,
 * the object id of a path (the ratchet's "did the pipeline's owner change"),
 * and composing two commits' merge tree (the queue-integrity check).
 *
 * Nothing here executes what it reads: a blob is bytes, a tree is ids.
 */
import { deepFreeze } from "../../kernel/integrity.ts";
import { InputError } from "../../kernel/errors.ts";
import { gitOutput, type GitRepository } from "../../git/tree-reader.ts";
import { pathObjectId } from "../gates/reuse.ts";

const SHA = /^[0-9a-f]{40}$/u;

function requireSha(value: string, what: string): string {
  if (!SHA.test(value)) throw new InputError(`${what} is not a full object id`, "door_git_input_invalid");
  return value;
}

/** Fetches `commits` (and their trees) from `origin` without blobs. */
export function fetchCommits(repository: GitRepository, commits: readonly string[]): void {
  if (commits.length === 0) return;
  gitOutput(repository, ["fetch", "--no-tags", "--quiet", "--filter=blob:none", "origin", ...commits.map((commit) => requireSha(commit, "a fetched commit"))]);
}

/** The bytes of `<commit>:<path>`, or null when absent. */
export function readBlob(repository: GitRepository, commit: string, path: string): Buffer | null {
  const id = pathObjectId(repository, commit, path);
  if (id === null) return null;
  return gitOutput(repository, ["cat-file", "blob", id]).stdout;
}

/** The file names directly under `directory` at `commit` (none when the directory is absent). */
export function listDirectory(repository: GitRepository, commit: string, directory: string): readonly string[] {
  const answer = gitOutput(repository, ["ls-tree", "-z", "--name-only", `${requireSha(commit, "a commit")}:${directory}`], { allowed: [0, 128] });
  if (answer.status !== 0) return [];
  return answer.stdout.toString("utf8").split("\0").filter((name) => name.length > 0);
}

export type DiffEntry = Readonly<{ path: string; status: "added" | "modified" | "removed" | "renamed"; blob: string | null; sizeBytes: number }>;

/** The files `head` changes against `base` (renames detected), with each new blob's id and size. */
export function diffFiles(repository: GitRepository, base: string, head: string): readonly DiffEntry[] {
  const raw = gitOutput(repository, ["diff", "--no-ext-diff", "--raw", "-z", "-M", "--no-abbrev", requireSha(base, "a base"), requireSha(head, "a head")]).stdout.toString("utf8").split("\0");
  const entries: DiffEntry[] = [];
  for (let index = 0; index < raw.length - 1;) {
    const header = raw[index]!;
    if (!header.startsWith(":")) { index += 1; continue; }
    const [, , , newBlob, statusField] = header.slice(1).split(" ");
    const code = (statusField ?? "")[0];
    const renamed = code === "R" || code === "C";
    const path = renamed ? raw[index + 2]! : raw[index + 1]!;
    index += renamed ? 3 : 2;
    const status = code === "A" ? "added" : code === "D" ? "removed" : renamed ? "renamed" : "modified";
    const blob = status === "removed" || newBlob === undefined || /^0+$/u.test(newBlob) ? null : newBlob;
    const sizeBytes = blob === null ? 0 : Number.parseInt(gitOutput(repository, ["cat-file", "-s", blob]).stdout.toString("utf8").trim(), 10);
    entries.push({ path, status, blob, sizeBytes });
  }
  return deepFreeze(entries);
}

/** A blob's text when it is UTF-8 text (no NUL), else null. */
export function blobText(repository: GitRepository, blob: string): string | null {
  const bytes = gitOutput(repository, ["cat-file", "blob", requireSha(blob, "a blob")]).stdout;
  return bytes.includes(0) ? null : bytes.toString("utf8");
}

/** The tree a three-way merge of `ours` and `theirs` writes (git's merge-base), or null when they conflict. */
export function mergeTree(repository: GitRepository, ours: string, theirs: string): string | null {
  const answer = gitOutput(repository, ["merge-tree", "--write-tree", "--no-messages", requireSha(ours, "a merged commit"), requireSha(theirs, "a merged commit")], { allowed: [0, 1] });
  if (answer.status !== 0) return null;
  const tree = answer.stdout.toString("utf8").split("\n")[0]!.trim();
  return SHA.test(tree) ? tree : null;
}
