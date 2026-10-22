/**
 * THE GIT DATA API ON THE FORGE PORT — the publisher's typed operations for
 * re-making a local commit on GitHub as a commit GitHub signs, and for moving
 * a branch only forward (github-only §6.2, §9.4).
 *
 * {@link remakeCommit} carries one local commit to the forge:
 *   1. `POST /git/blobs` for each blob its tree adds or changes against its
 *      first parent's tree — GitHub's answered id must be the local blob id;
 *   2. `POST /git/trees` on the first parent's tree (`base_tree`) with exactly
 *      that delta — the answered tree must be the local commit's tree;
 *   3. `POST /git/commits` with the local message and the given parents, and
 *      NO author, committer or signature field: the forge makes the commit as
 *      the credential's App and signs it. An answer that is not verified is a
 *      refusal: a published commit must be Verified (the rulesets require it).
 * Every mismatch is `forge_publication_mismatch` (integrity), naming the
 * object: the forge stored something other than what was built.
 *
 * {@link advanceBranch} moves a branch with `force: false` (GitHub refuses
 * anything but a fast-forward) after checking it still names `from`, then
 * re-reads it: the answer is the branch's head as GitHub holds it.
 *
 * Nothing here retries or waits: a budget or a GitHub failure is the forge's
 * typed refusal, for the caller's scheduler.
 */
import { gitOutput, type GitRepository } from "../../../git/tree-reader.ts";
import { deepFreeze } from "../../../kernel/integrity.ts";
import { ForgeError } from "../codes.ts";
import type { ForgeClient } from "../port.ts";

/** One entry of a tree request: a file (or gitlink) at `path`, or its deletion (`sha: null`). */
export type ForgeTreeEntry = Readonly<{ path: string; mode: "100644" | "100755" | "120000" | "160000"; type: "blob" | "commit"; sha: string | null }>;

/** A commit the forge made: its id, its tree, and whether GitHub signed it. */
export type ForgeMadeCommit = Readonly<{ sha: string; tree: string; verified: boolean; reason: string }>;

function mismatch(message: string, facts: Readonly<Record<string, string>>): ForgeError {
  return new ForgeError("forge_publication_mismatch", message, facts);
}

function text(local: GitRepository, argv: readonly string[]): string {
  return gitOutput(local, argv).stdout.toString("utf8");
}

/** The entries `commit`'s tree changes against `parent`'s (recursive, no renames): each file's new mode and id, or its deletion. */
export function treeDelta(local: GitRepository, parent: string, commit: string): readonly ForgeTreeEntry[] {
  const raw = gitOutput(local, ["diff-tree", "-r", "-z", "--no-renames", "--no-abbrev", "--raw", parent, commit]).stdout;
  const fields: Buffer[] = [];
  for (let start = 0, end = raw.indexOf(0); end !== -1; start = end + 1, end = raw.indexOf(0, start)) fields.push(raw.subarray(start, end));
  const entries: ForgeTreeEntry[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const header = fields[index]!.toString("utf8");
    const path = fields[index + 1]!.toString("utf8");
    if (!header.startsWith(":")) continue;
    if (!Buffer.from(path, "utf8").equals(fields[index + 1]!)) throw mismatch(`${commit} holds a path that is not UTF-8 (${fields[index + 1]!.toString("hex")}): the forge's API carries UTF-8 paths only`, { commit });
    const [, mode, , sha, status] = header.slice(1).split(" ");
    if (status === "D") {
      entries.push({ path, mode: "100644", type: "blob", sha: null });
      continue;
    }
    if (mode !== "100644" && mode !== "100755" && mode !== "120000" && mode !== "160000") throw mismatch(`${commit} records ${path} with the mode ${String(mode)}, which a forge tree cannot hold`, { commit, path });
    entries.push({ path, mode, type: mode === "160000" ? "commit" : "blob", sha: sha! });
  }
  return deepFreeze(entries);
}

type CommitAnswer = { sha?: unknown; tree?: { sha?: unknown }; verification?: { verified?: unknown; reason?: unknown } };

/**
 * Re-makes the local `commit` on the forge with `parents` (ids the forge
 * already holds) and its own message (see the header); answers the forge's
 * commit, signed, holding exactly the local tree.
 */
export async function remakeCommit(input: Readonly<{ client: ForgeClient; repository: string; local: GitRepository; commit: string; parents: readonly string[] }>): Promise<ForgeMadeCommit> {
  const { client, repository, local, commit } = input;
  const base = `/repos/${repository}/git`;
  const firstParent = text(local, ["rev-parse", `${commit}^1`]).trim();
  const tree = text(local, ["rev-parse", `${commit}^{tree}`]).trim();
  const baseTree = text(local, ["rev-parse", `${firstParent}^{tree}`]).trim();
  const message = gitOutput(local, ["cat-file", "commit", commit]).stdout;
  const body = message.subarray(message.indexOf("\n\n") + 2).toString("utf8");
  const entries = treeDelta(local, firstParent, commit);
  const uploaded = new Set<string>();
  for (const entry of entries) {
    if (entry.sha === null || entry.type === "commit" || uploaded.has(entry.sha)) continue;
    const content = gitOutput(local, ["cat-file", "blob", entry.sha]).stdout;
    const answered = await client.rest<{ sha?: unknown }>({ method: "POST", path: `${base}/blobs`, body: { content: content.toString("base64"), encoding: "base64" } });
    if (answered.data.sha !== entry.sha) throw mismatch(`the forge stored ${entry.path} as the blob ${String(answered.data.sha)}, not ${entry.sha}`, { commit, path: entry.path });
    uploaded.add(entry.sha);
  }
  let madeTree = baseTree;
  if (entries.length > 0) {
    const answered = await client.rest<{ sha?: unknown }>({ method: "POST", path: `${base}/trees`, body: { base_tree: baseTree, tree: entries } });
    madeTree = String(answered.data.sha);
  }
  if (madeTree !== tree) throw mismatch(`the forge built the tree ${madeTree} for ${commit}, whose tree is ${tree}`, { commit, tree, madeTree });
  const answered = await client.rest<CommitAnswer>({ method: "POST", path: `${base}/commits`, body: { message: body, tree, parents: input.parents } });
  const made = deepFreeze({
    sha: String(answered.data.sha),
    tree: String(answered.data.tree?.sha),
    verified: answered.data.verification?.verified === true,
    reason: String(answered.data.verification?.reason ?? "unknown"),
  });
  if (made.tree !== tree) throw mismatch(`the forge's commit ${made.sha} holds the tree ${made.tree}, not ${tree}`, { commit, twin: made.sha });
  if (!made.verified) throw mismatch(`the forge did not sign the commit ${made.sha} (${made.reason}): a published commit must be Verified`, { commit, twin: made.sha, reason: made.reason });
  return made;
}

/** The branch's head on the forge, or `null` when it does not exist. */
export async function branchHead(client: ForgeClient, repository: string, branch: string): Promise<string | null> {
  try {
    const answered = await client.rest<{ object?: { sha?: unknown } }>({ method: "GET", path: `/repos/${repository}/git/ref/heads/${branch}` });
    return String(answered.data.object?.sha);
  } catch (error) {
    if (error instanceof ForgeError && error.forgeCode === "github_not_found") return null;
    throw error;
  }
}

/**
 * Moves `branch` from `from` to `to`, only forward (`force: false`): refused
 * when the branch no longer names `from` (`forge_branch_moved`), refused by
 * GitHub when `to` does not descend from it; answers the head re-read.
 */
export async function advanceBranch(client: ForgeClient, repository: string, branch: string, from: string, to: string): Promise<string> {
  const current = await branchHead(client, repository, branch);
  if (current !== from) throw new ForgeError("forge_branch_moved", `${branch} on ${repository} is ${String(current)}, not ${from}: it moved since it was read`, { branch, expected: from, found: String(current) });
  await client.rest({ method: "PATCH", path: `/repos/${repository}/git/refs/heads/${branch}`, body: { sha: to, force: false } });
  const after = await branchHead(client, repository, branch);
  if (after !== to) throw mismatch(`${branch} on ${repository} is ${String(after)} after the update to ${to}`, { branch, expected: to, found: String(after) });
  return after;
}
