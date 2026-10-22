/**
 * THE GITHUB ADAPTER OF THE GIT DATA PORT (`GitDataForge`,
 * `workflow/workspace-forge.ts`) on the forge client: the five operations the
 * one re-make (`remakeCommit`) and a branch move need, each one request (or
 * one mutation) of the Git Data API, as the client's principal.
 *
 * - `createBlob` — `POST /git/blobs` (base64), answering the blob id;
 * - `createTree` — `POST /git/trees` on `base_tree`, a gitlink entry typed
 *   `commit`, a deletion `sha: null`;
 * - `createCommit` — `POST /git/commits` with NO author, committer or
 *   signature (the port's request has none): GitHub makes the commit as the
 *   App and signs it; its `verification` is answered as is;
 * - `branchHead` — `GET /git/ref/heads/<branch>` (absent: `null`);
 * - `setBranch` — a COMPARE-AND-SWAP: created only while absent
 *   (`POST /git/refs`), else moved only while it is at `previous` (GraphQL
 *   `updateRefs` with `beforeOid`; REST `PATCH` has no compare-and-swap and
 *   is never used). A compare-and-swap that did not hold (422 or 409) is
 *   answered by re-reading the branch: `applied` only when it now names
 *   `sha`, never an overwrite; any other refusal (a permission, a budget) is
 *   the forge's typed error.
 *
 * Nothing here retries or waits: a budget or a GitHub failure is the forge's
 * typed refusal, for the caller's scheduler.
 */
import { ForgeError } from "../codes.ts";
import type { ForgeClient } from "../port.ts";
import type { ForgeCommit, GitDataForge } from "../../workspace-forge.ts";

type CommitAnswer = { sha?: unknown; tree?: { sha?: unknown }; verification?: { verified?: unknown; reason?: unknown } };

/** The Git Data port over `client` for `repository` (`owner/name`). */
export function githubGitData(client: ForgeClient, repository: string): GitDataForge {
  const base = `/repos/${repository}/git`;
  let nodeId: string | null = null;
  const branchHead = async (branch: string): Promise<string | null> => {
    try {
      const answered = await client.rest<{ object?: { sha?: unknown } }>({ method: "GET", path: `${base}/ref/heads/${branch}` });
      return String(answered.data.object?.sha);
    } catch (error) {
      if (error instanceof ForgeError && error.forgeCode === "github_not_found") return null;
      throw error;
    }
  };
  const settled = async (branch: string, sha: string): Promise<Readonly<{ applied: boolean }>> => Object.freeze({ applied: (await branchHead(branch)) === sha });
  return Object.freeze({
    createBlob: async (content: Buffer): Promise<string> => String((await client.rest<{ sha?: unknown }>({ method: "POST", path: `${base}/blobs`, body: { content: content.toString("base64"), encoding: "base64" } })).data.sha),
    createTree: async (request): Promise<string> => String((await client.rest<{ sha?: unknown }>({
      method: "POST",
      path: `${base}/trees`,
      body: { base_tree: request.baseTree, tree: request.entries.map((entry) => ({ path: entry.path, mode: entry.mode, type: entry.mode === "160000" ? "commit" : "blob", sha: entry.sha })) },
    })).data.sha),
    createCommit: async (request): Promise<ForgeCommit> => {
      const answered = await client.rest<CommitAnswer>({ method: "POST", path: `${base}/commits`, body: { message: request.message, tree: request.tree, parents: request.parents } });
      return Object.freeze({
        sha: String(answered.data.sha),
        tree: String(answered.data.tree?.sha),
        verified: answered.data.verification?.verified === true,
        verificationReason: String(answered.data.verification?.reason ?? "unknown"),
      });
    },
    branchHead,
    setBranch: async (request): Promise<Readonly<{ applied: boolean }>> => {
      try {
        if (request.previous === null) {
          await client.rest({ method: "POST", path: `${base}/refs`, body: { ref: `refs/heads/${request.branch}`, sha: request.sha } });
        } else {
          nodeId ??= String((await client.rest<{ node_id?: unknown }>({ method: "GET", path: `/repos/${repository}` })).data.node_id);
          await client.graphql(
            "mutation($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }",
            { input: { repositoryId: nodeId, refUpdates: [{ name: `refs/heads/${request.branch}`, beforeOid: request.previous, afterOid: request.sha, force: false }] } },
          );
        }
      } catch (error) {
        // A compare-and-swap that did not hold (the ref exists, or is elsewhere): answered by the read-back. Any other refusal is the caller's.
        if (!(error instanceof ForgeError) || !["github_validation_failed", "github_conflict"].includes(error.forgeCode)) throw error;
        return settled(request.branch, request.sha);
      }
      return settled(request.branch, request.sha);
    },
  });
}
