/**
 * THE PRODUCT PUBLICATION (`src/workflow/forge/publish/`): a built promotion
 * commit carried to the forge through the Git Data API as a commit GitHub
 * signs, the product branch moved only forward, and the projection receipt.
 *
 * The forge is the fake GitHub with Git Data routes backed by a REAL bare
 * repository (`forge.git`): blobs, trees and commits are git's own objects,
 * so "the forge built the same tree" is git's answer, not the fake's.
 * The local repository holds a `main` commit S and the product tip T, both
 * pushed to the forge, and the promotion commit C (parents [T, S], the
 * trailers a promotion writes), which the forge does not hold yet.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { memoryCredential } from "../../../src/workflow/forge/credentials.ts";
import { githubClient } from "../../../src/workflow/forge/github.ts";
import { forgePublishVerb, publishProduct, receiptBytes, type ProductForge } from "../../../src/workflow/forge/publish/product.ts";
import { treeDelta } from "../../../src/workflow/forge/publish/git-data.ts";
import { PromotionError } from "../../../src/workflow/promotion/codes.ts";
import { parsePromoteArguments, formatPromoteArguments } from "../../../src/workflow/promotion/promote-arguments.ts";
import { parsePromotionProfile } from "../../../src/workflow/promotion/profile.ts";
import { promotionRefs } from "../../../src/workflow/promotion/promotion-run.ts";
import type { GitRepository } from "../../../src/git/tree-reader.ts";
import { createTempDir } from "../../support/temp-dir.ts";
import { testGitIdentityEnvironment } from "../../support/test-git-identity.ts";
import { fakeGithub, type FakeGithub } from "../fake-github.ts";
import { fixtureProfile, json, PROFILE_DIRECTORY, PROFILE_PATH } from "../../workflow/promotion/promotion-fixture.ts";

const REPOSITORY = "owner/product-repo";
const BRANCH = "product";

type World = Readonly<{ fake: FakeGithub; forge: ProductForge; local: GitRepository; root: string; bare: string; source: string; target: string; commit: string; git: (args: readonly string[], cwd?: string, input?: string) => string; knobs: { unverified: boolean; wrongTree: boolean } }>;

function world(prefix: string): World {
  const root = createTempDir(`${prefix}-local-`);
  const bare = join(createTempDir(`${prefix}-forge-`), "forge.git");
  const environment = { ...process.env, ...testGitIdentityEnvironment() };
  const git = (args: readonly string[], cwd = root, input?: string): string => execFileSync("git", ["-c", "gc.auto=0", ...args], { cwd, encoding: "utf8", env: environment, ...(input === undefined ? {} : { input }) }).trim();
  git(["init", "-q", "-b", "main"]);
  writeFileSync(join(root, "app.ts"), "export const app = 1;\n");
  writeFileSync(join(root, "dev.ts"), "export const dev = 1;\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "main: the first source"]);
  git(["checkout", "-q", "--orphan", BRANCH]);
  git(["rm", "-q", "--cached", "dev.ts"]);
  git(["commit", "-q", "-m", "the seeded product"]);
  const target = git(["rev-parse", "HEAD"]);
  git(["checkout", "-q", "-f", "main"]);
  writeFileSync(join(root, "app.ts"), "export const app = 2;\n");
  writeFileSync(join(root, "new.ts"), "export const fresh = 1;\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "main: the next source"]);
  const source = git(["rev-parse", "HEAD"]);
  execFileSync("git", ["init", "-q", "--bare", bare]);
  git(["push", "-q", bare, "main", BRANCH]);
  // The promotion commit: the product tree with app.ts changed and new.ts added, parents [T, S].
  const productTree = git(["rev-parse", `${target}^{tree}`]);
  const index = join(createTempDir(`${prefix}-index-`), "index");
  const withIndex = { ...environment, GIT_INDEX_FILE: index };
  execFileSync("git", ["read-tree", productTree], { cwd: root, env: withIndex });
  for (const path of ["app.ts", "new.ts"]) execFileSync("git", ["update-index", "--add", "--cacheinfo", `100644,${git(["rev-parse", `${source}:${path}`])},${path}`], { cwd: root, env: withIndex });
  const tree = execFileSync("git", ["write-tree"], { cwd: root, env: withIndex, encoding: "utf8" }).trim();
  const commit = git(["commit-tree", tree, "-p", target, "-p", source, "-m", `promote main ${source.slice(0, 8)}\n\nProjected-From: ${source}\nPromotion-Profile: main-to-product@0123456`]);
  const knobs = { unverified: false, wrongTree: false };
  const fake = fakeGithub();
  const inForge = (args: readonly string[], options: Readonly<{ input?: string | Buffer; env?: NodeJS.ProcessEnv }> = {}): string => execFileSync("git", ["-c", "gc.auto=0", ...args], { cwd: bare, encoding: "utf8", env: { ...environment, ...options.env }, ...(options.input === undefined ? {} : { input: options.input }) }).trim();
  const refOf = (branch: string): string | null => { try { return inForge(["rev-parse", "-q", "--verify", `refs/heads/${branch}`]); } catch { return null; } };
  const base = `/repos/${REPOSITORY}/git`;
  fake.route("GET", new RegExp(`^${base}/ref/heads/(.+)$`, "u"), (_request, match) => {
    const sha = refOf(match[1]!);
    return sha === null ? { status: 404, body: { message: "Not Found" } } : { status: 200, body: { ref: `refs/heads/${match[1]!}`, object: { sha, type: "commit" } } };
  });
  fake.route("POST", new RegExp(`^${base}/blobs$`, "u"), (request) => {
    const body = request.body as { content: string; encoding: string };
    return { status: 201, body: { sha: inForge(["hash-object", "-w", "--stdin"], { input: Buffer.from(body.content, body.encoding === "base64" ? "base64" : "utf8") }) } };
  });
  fake.route("POST", new RegExp(`^${base}/trees$`, "u"), (request) => {
    const body = request.body as { base_tree: string; tree: { path: string; mode: string; sha: string | null }[] };
    const treeIndex = join(createTempDir(`${prefix}-forge-index-`), "index");
    const env = { GIT_INDEX_FILE: treeIndex };
    inForge(["read-tree", body.base_tree], { env });
    for (const entry of body.tree) {
      if (entry.sha === null) inForge(["update-index", "--force-remove", entry.path], { env });
      else inForge(["update-index", "--add", "--cacheinfo", `${entry.mode},${entry.sha},${entry.path}`], { env });
    }
    return { status: 201, body: { sha: knobs.wrongTree ? body.base_tree : inForge(["write-tree"], { env }) } };
  });
  fake.route("POST", new RegExp(`^${base}/commits$`, "u"), (request) => {
    const body = request.body as { message: string; tree: string; parents: string[]; author?: unknown; committer?: unknown; signature?: unknown };
    if (body.author !== undefined || body.committer !== undefined || body.signature !== undefined) return { status: 422, body: { message: "the test forge refuses an author, committer or signature: the publisher never sends one" } };
    const sha = inForge(["commit-tree", body.tree, ...body.parents.flatMap((parent) => ["-p", parent])], { input: body.message, env: { GIT_AUTHOR_NAME: "bridlewise-publisher[bot]", GIT_COMMITTER_NAME: "GitHub" } });
    return { status: 201, body: { sha, tree: { sha: body.tree }, verification: knobs.unverified ? { verified: false, reason: "unsigned" } : { verified: true, reason: "valid" } } };
  });
  fake.route("PATCH", new RegExp(`^${base}/refs/heads/(.+)$`, "u"), (request, match) => {
    const body = request.body as { sha: string; force: boolean };
    const current = refOf(match[1]!);
    if (current === null) return { status: 422, body: { message: "Reference does not exist" } };
    let fastForward = true;
    try { inForge(["merge-base", "--is-ancestor", current, body.sha]); } catch { fastForward = false; }
    if (!fastForward && body.force !== true) return { status: 422, body: { message: "Update is not a fast forward" } };
    inForge(["update-ref", `refs/heads/${match[1]!}`, body.sha]);
    return { status: 200, body: { ref: `refs/heads/${match[1]!}`, object: { sha: body.sha } } };
  });
  const client = githubClient(fake.endpoint(), memoryCredential("app:bridlewise-publisher", fake.userToken("publisher")));
  const local: GitRepository = { root, executable: "git", timeoutMs: 30_000 };
  return { fake, forge: { client, repository: REPOSITORY }, local, root, bare, source, target, commit, git: (args, cwd, input) => git(args, cwd, input), knobs };
}

async function refusedWith(code: string, run: () => Promise<unknown>): Promise<PromotionError> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof PromotionError, `expected a promotion refusal, got ${String(error)}`);
    assert.equal(error.promotionCode, code, error.message);
    return error;
  }
  assert.fail(`expected ${code}`);
}

const forgeHead = (w: World): string => w.git(["rev-parse", `refs/heads/${BRANCH}`], w.bare);
const posted = (w: World, kind: string): number => w.fake.requests.filter((request) => request.method === "POST" && request.path.endsWith(`/git/${kind}`)).length;

test("the built promotion is re-made on the forge as a signed commit with the built tree, the branch moves forward, and the receipt names it", async () => {
  const w = world("publish-happy");
  const receipt = await publishProduct({ client: w.forge.client, repository: REPOSITORY, branch: BRANCH, local: w.local, commit: w.commit });
  const head = forgeHead(w);
  assert.equal(receipt.commit, head, "the receipt names the branch's head as the forge holds it");
  assert.notEqual(head, w.commit, "the forge made its own (signed) commit");
  assert.equal(w.git(["rev-parse", `${head}^{tree}`], w.bare), w.git(["rev-parse", `${w.commit}^{tree}`]), "the published tree is the built tree");
  assert.deepEqual(w.git(["rev-list", "--parents", "-n", "1", head], w.bare).split(" ").slice(1), [w.target, w.source], "parents [the product tip, the source]");
  assert.match(w.git(["log", "-1", "--format=%B", head], w.bare), new RegExp(`Projected-From: ${w.source}`, "u"), "the message and its trailers are the built commit's");
  assert.deepEqual({ ...receipt }, { schema: "bridlewise-product-projection/v1", repository: REPOSITORY, branch: BRANCH, commit: head, built: w.commit, tree: receipt.tree, source: w.source, profile: "main-to-product@0123456", target: w.target });
  assert.equal(posted(w, "blobs"), treeDelta(w.local, w.target, w.commit).filter((entry) => entry.sha !== null).length, "only the blobs the commit changes are uploaded");
  assert.equal(receiptBytes(receipt), receiptBytes({ ...receipt }), "the receipt's bytes are canonical");
});

test("a product branch that moved since the build is refused, and nothing is written", async () => {
  const w = world("publish-moved");
  const other = w.git(["commit-tree", w.git(["rev-parse", `${w.target}^{tree}`]), "-p", w.target, "-m", "another publication"]);
  w.git(["push", "-q", w.bare, `${other}:refs/heads/${BRANCH}`]);
  await refusedWith("promotion_forge_target_moved", () => publishProduct({ client: w.forge.client, repository: REPOSITORY, branch: BRANCH, local: w.local, commit: w.commit }));
  assert.equal(posted(w, "blobs") + posted(w, "trees") + posted(w, "commits"), 0);
  assert.equal(forgeHead(w), other);
});

test("an unsigned commit, or a tree other than the built one, is an integrity refusal and the branch stays", async () => {
  for (const knob of ["unverified", "wrongTree"] as const) {
    const w = world(`publish-${knob}`);
    w.knobs[knob] = true;
    await refusedWith("promotion_forge_mismatch", () => publishProduct({ client: w.forge.client, repository: REPOSITORY, branch: BRANCH, local: w.local, commit: w.commit }));
    assert.equal(forgeHead(w), w.target, `${knob}: the product branch did not move`);
  }
});

test("only a promotion commit is published: no trailers, or parents other than [tip, source], is refused before any request", async () => {
  const w = world("publish-unproven");
  const tree = w.git(["rev-parse", `${w.commit}^{tree}`]);
  const plain = w.git(["commit-tree", tree, "-p", w.target, "-p", w.source, "-m", "no trailers"]);
  const swapped = w.git(["commit-tree", tree, "-p", w.source, "-p", w.target, "-m", `promote\n\nProjected-From: ${w.source}\nPromotion-Profile: main-to-product@0123456`]);
  for (const commit of [plain, swapped]) await refusedWith("promotion_source_unproven_commit", () => publishProduct({ client: w.forge.client, repository: REPOSITORY, branch: BRANCH, local: w.local, commit }));
  assert.equal(w.fake.requests.length, 0);
});

test("the forge's refusals keep their class: a failure is errored, a permission refusal is refused", async () => {
  const errored = world("publish-errored");
  errored.fake.refuseNext({ method: "POST", path: /\/git\/blobs$/u }, { status: 503, message: "unavailable" });
  const failure = await refusedWith("promotion_forge_errored", () => publishProduct({ client: errored.forge.client, repository: REPOSITORY, branch: BRANCH, local: errored.local, commit: errored.commit }));
  assert.equal(failure.facts["forgeCode"], "github_unavailable");
  const refused = world("publish-refused");
  refused.fake.refuseNext({ method: "PATCH" }, { status: 403, message: "Resource not accessible by integration" });
  await refusedWith("promotion_forge_refused", () => publishProduct({ client: refused.forge.client, repository: REPOSITORY, branch: BRANCH, local: refused.local, commit: refused.commit }));
  assert.equal(forgeHead(refused), refused.target);
});

test("the verb: nothing pending is refused; the pending promotion is published and its receipt written for the attestation", async () => {
  const w = world("publish-verb");
  const loaded = { profile: parsePromotionProfile(json({ ...fixtureProfile(), target: { ref: `refs/heads/${BRANCH}` } }), { path: PROFILE_PATH, profileDirectory: PROFILE_DIRECTORY, commandNames: new Set(["lockfile", "gate"]) }), path: PROFILE_PATH, blob: null };
  const out = join(createTempDir("publish-verb-out-"), "receipt.json");
  await refusedWith("promotion_forge_nothing_pending", () => forgePublishVerb({ local: w.local, loaded, out, forge: w.forge }));
  w.git(["update-ref", promotionRefs(loaded.profile.name).pending, w.commit]);
  const answered = await forgePublishVerb({ local: w.local, loaded, out, forge: w.forge });
  assert.equal(answered.code, "promotion_forge_published");
  const receipt = JSON.parse(readFileSync(out, "utf8")) as { commit: string; source: string };
  assert.deepEqual([receipt.commit, receipt.source], [forgeHead(w), w.source]);
  assert.equal(readFileSync(out, "utf8"), receiptBytes(answered.data as Parameters<typeof receiptBytes>[0]));
});

test("the grammar: forge-publish needs --out, takes --profile, and spells back to itself", () => {
  assert.throws(() => parsePromoteArguments(["forge-publish"]), (error: unknown) => error instanceof PromotionError && error.promotionCode === "promotion_usage");
  assert.throws(() => parsePromoteArguments(["plan", "--out", "x"]), (error: unknown) => error instanceof PromotionError && error.promotionCode === "promotion_usage", "--out belongs to forge-publish only");
  const request = parsePromoteArguments(["forge-publish", "--profile", "main-to-product", "--out", "receipt.json"]);
  assert.deepEqual(parsePromoteArguments(formatPromoteArguments(request)), request);
});
