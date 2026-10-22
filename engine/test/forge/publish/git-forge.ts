/**
 * A GIT-BACKED FORGE for the publisher's tests (not a test file): the fake
 * GitHub (`../fake-github.ts`) with the Git Data routes the publisher uses,
 * answered by a REAL bare repository — blobs (`hash-object`), trees (a
 * private index over `base_tree`), commits (`commit-tree`, the forge's own
 * identity) and branch refs (a fast-forward check unless `force`). So "the
 * forge built the same tree" is git's answer, not the fake's. Knobs plant the
 * forge misbehaving: an unsigned commit, a wrong tree, a wrong blob id, a ref
 * update it answers but never applies.
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { memoryCredential } from "../../../src/workflow/forge/credentials.ts";
import { githubClient } from "../../../src/workflow/forge/github.ts";
import type { ProductForge } from "../../../src/workflow/forge/publish/product.ts";
import { createTempDir } from "../../support/temp-dir.ts";
import { testGitIdentityEnvironment } from "../../support/test-git-identity.ts";
import { fakeGithub, type FakeGithub } from "../fake-github.ts";

export type ForgeKnobs = { unverified: boolean; wrongTree: boolean; wrongBlob: boolean; ignoreRefUpdate: boolean };

export type GitForge = Readonly<{
  fake: FakeGithub;
  forge: ProductForge;
  /** The bare repository the forge's objects and refs live in. */
  bare: string;
  knobs: ForgeKnobs;
  /** `git <args>` in the forge's bare repository. */
  git: (args: readonly string[]) => string;
  /** The requests of one Git Data kind (`blobs`, `trees`, `commits`) or a ref update (`refs`). */
  count: (kind: "blobs" | "trees" | "commits" | "refs") => number;
}>;

/** A forge holding `repository` (`owner/name`) in a fresh bare repository. */
export function gitForge(prefix: string, repository: string): GitForge {
  const bare = join(createTempDir(`${prefix}-forge-`), "forge.git");
  execFileSync("git", ["init", "-q", "--bare", bare]);
  const environment = { ...process.env, ...testGitIdentityEnvironment() };
  const git = (args: readonly string[], options: Readonly<{ input?: string | Buffer; env?: NodeJS.ProcessEnv }> = {}): string => execFileSync("git", ["-c", "gc.auto=0", ...args], { cwd: bare, encoding: "utf8", env: { ...environment, ...options.env }, ...(options.input === undefined ? {} : { input: options.input }) }).trim();
  const refOf = (branch: string): string | null => { try { return git(["rev-parse", "-q", "--verify", `refs/heads/${branch}`]); } catch { return null; } };
  const knobs: ForgeKnobs = { unverified: false, wrongTree: false, wrongBlob: false, ignoreRefUpdate: false };
  const fake = fakeGithub();
  const base = `/repos/${repository}/git`;
  fake.route("GET", new RegExp(`^${base}/ref/heads/(.+)$`, "u"), (_request, match) => {
    const sha = refOf(match[1]!);
    return sha === null ? { status: 404, body: { message: "Not Found" } } : { status: 200, body: { ref: `refs/heads/${match[1]!}`, object: { sha, type: "commit" } } };
  });
  fake.route("POST", new RegExp(`^${base}/blobs$`, "u"), (request) => {
    const body = request.body as { content: string; encoding: string };
    const sha = git(["hash-object", "-w", "--stdin"], { input: Buffer.from(body.content, body.encoding === "base64" ? "base64" : "utf8") });
    return { status: 201, body: { sha: knobs.wrongBlob ? git(["hash-object", "-w", "--stdin"], { input: "another blob\n" }) : sha } };
  });
  fake.route("POST", new RegExp(`^${base}/trees$`, "u"), (request) => {
    const body = request.body as { base_tree: string; tree: { path: string; mode: string; sha: string | null }[] };
    const env = { GIT_INDEX_FILE: join(createTempDir(`${prefix}-forge-index-`), "index") };
    git(["read-tree", body.base_tree], { env });
    for (const entry of body.tree) {
      if (entry.sha === null) git(["update-index", "--force-remove", entry.path], { env });
      else git(["update-index", "--add", "--cacheinfo", `${entry.mode},${entry.sha},${entry.path}`], { env });
    }
    return { status: 201, body: { sha: knobs.wrongTree ? body.base_tree : git(["write-tree"], { env }) } };
  });
  fake.route("POST", new RegExp(`^${base}/commits$`, "u"), (request) => {
    const body = request.body as { message: string; tree: string; parents: string[]; author?: unknown; committer?: unknown; signature?: unknown };
    if (body.author !== undefined || body.committer !== undefined || body.signature !== undefined) return { status: 422, body: { message: "this forge refuses an author, committer or signature: the publisher never sends one" } };
    const sha = git(["commit-tree", body.tree, ...body.parents.flatMap((parent) => ["-p", parent])], { input: body.message, env: { GIT_AUTHOR_NAME: "bridlewise-publisher[bot]", GIT_COMMITTER_NAME: "GitHub" } });
    return { status: 201, body: { sha, tree: { sha: body.tree }, verification: knobs.unverified ? { verified: false, reason: "unsigned" } : { verified: true, reason: "valid" } } };
  });
  fake.route("PATCH", new RegExp(`^${base}/refs/heads/(.+)$`, "u"), (request, match) => {
    const body = request.body as { sha: string; force?: boolean };
    const current = refOf(match[1]!);
    if (current === null) return { status: 422, body: { message: "Reference does not exist" } };
    let fastForward = true;
    try { git(["merge-base", "--is-ancestor", current, body.sha]); } catch { fastForward = false; }
    if (!fastForward && body.force !== true) return { status: 422, body: { message: "Update is not a fast forward" } };
    if (!knobs.ignoreRefUpdate) git(["update-ref", `refs/heads/${match[1]!}`, body.sha]);
    return { status: 200, body: { ref: `refs/heads/${match[1]!}`, object: { sha: body.sha } } };
  });
  const client = githubClient(fake.endpoint(), memoryCredential("app:bridlewise-publisher", fake.userToken("publisher")));
  const count = (kind: "blobs" | "trees" | "commits" | "refs"): number => fake.requests.filter((request) => (kind === "refs" ? request.method === "PATCH" && request.path.includes("/git/refs/") : request.method === "POST" && request.path.endsWith(`/git/${kind}`))).length;
  return { fake, forge: { client, repository }, bare, knobs, git: (args) => git(args), count };
}
