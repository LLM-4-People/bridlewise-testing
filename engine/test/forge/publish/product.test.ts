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
import { advanceBranch, remakeCommit, treeDelta } from "../../../src/workflow/forge/publish/git-data.ts";
import { publishProduct, receiptBytes, type ProjectionReceipt } from "../../../src/workflow/forge/publish/product.ts";
import { isForgeError } from "../../../src/workflow/forge/codes.ts";
import { PromotionError, answer, type PromotionAnswer } from "../../../src/workflow/promotion/codes.ts";
import { promotionForgePublish, resolvePromotionContext, resolveRepositoryContext, verifyBuiltProjection } from "../../../src/workflow/promotion/context.ts";
import { formatPromoteArguments, parsePromoteArguments, type PromotionRequest } from "../../../src/workflow/promotion/promote-arguments.ts";
import { promotionRefs } from "../../../src/workflow/promotion/promotion-run.ts";
import { createTempDir } from "../../support/temp-dir.ts";
import { testGitIdentityEnvironment } from "../../support/test-git-identity.ts";
import { PROFILE_NAME, SOURCE, TARGET, promotionFixture, type PromotionFixture } from "../../workflow/promotion/promotion-fixture.ts";
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

async function forgeRefusal(code: string, run: () => Promise<unknown>): Promise<void> {
  await assert.rejects(run, (error: unknown) => isForgeError(error, code as never) || (assert.fail(`expected ${code}, got ${String(error)}`)));
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
  assert.equal(w.forge.count("blobs"), treeDelta(w.local, w.target, w.commit).filter((entry) => entry.sha !== null).length, "only the changed blobs are uploaded");
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
  }
});

test("BARRIER force: false — a branch is only ever moved forward (a non-descendant is refused by the forge)", async () => {
  const w = world("publish-force");
  const unrelated = w.git(["commit-tree", w.git(["rev-parse", `${w.source}^{tree}`]), "-m", "no common history"]);
  w.git(["push", "-q", w.forge.bare, `${unrelated}:refs/heads/scratch`]);
  await forgeRefusal("github_validation_failed", () => advanceBranch(w.forge.forge.client, REPOSITORY, BRANCH, w.target, unrelated));
  assert.equal(head(w), w.target, "a force-moved branch would now name the unrelated commit");
  const sent = w.forge.fake.requests.filter((request) => request.method === "PATCH").map((request) => (request.body as { force?: unknown }).force);
  assert.deepEqual(sent, [false], "the request says force: false");
});

test("BARRIER the head check — a branch that no longer names the expected head is refused before any update", async () => {
  const w = world("publish-cas");
  const moved = w.git(["commit-tree", w.git(["rev-parse", `${w.target}^{tree}`]), "-p", w.target, "-m", "moved meanwhile"]);
  w.git(["push", "-q", w.forge.bare, `${moved}:refs/heads/${BRANCH}`]);
  const onTop = w.git(["commit-tree", w.git(["rev-parse", `${w.target}^{tree}`]), "-p", moved, "-m", "a descendant of the moved head"]);
  w.git(["push", "-q", w.forge.bare, `${onTop}:refs/heads/scratch`]);
  await forgeRefusal("forge_branch_moved", () => advanceBranch(w.forge.forge.client, REPOSITORY, BRANCH, w.target, onTop));
  assert.equal(w.forge.count("refs"), 0, "without the check this fast-forward would have been applied over a head nobody read");
  assert.equal(head(w), moved);
});

test("BARRIER the re-read — a ref update the forge answers but never applies is an integrity refusal", async () => {
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
  refused.forge.fake.refuseNext({ method: "PATCH" }, { status: 403, message: "Resource not accessible by integration" });
  await refusedWith("promotion_forge_refused", () => publish(refused));
  assert.equal(head(refused), refused.target);
});

test("remakeCommit carries a commit whose parents the forge already holds, with the local message, and never an author", async () => {
  const w = world("publish-remake");
  const made = await remakeCommit({ client: w.forge.forge.client, repository: REPOSITORY, local: w.local, commit: w.commit, parents: [w.target, w.source] });
  assert.equal(made.verified, true);
  for (const request of w.forge.fake.requests.filter((entry) => entry.path.endsWith("/git/commits"))) {
    const body = request.body as Record<string, unknown>;
    assert.deepEqual([body["author"], body["committer"], body["signature"]], [undefined, undefined, undefined]);
  }
});

/** The fixture's forge: its `dev` (source) and `prod` (product) branches on a git-backed forge. */
function fixtureWithForge(prefix: string): Readonly<{ fixture: PromotionFixture; forge: GitForge }> {
  const fixture = promotionFixture(prefix);
  fixture.commit(SOURCE, { "product/lib/helper.ts": "export const helper = 4;\n" }, "a product change");
  const forge = gitForge(prefix, REPOSITORY);
  fixture.git(["push", "-q", forge.bare, SOURCE, TARGET]);
  fixture.git(["checkout", "-q", SOURCE]);
  return { fixture, forge };
}

/** The commit a faithful build makes for the fixture: the plan's projection tree on [prod, dev], with the promotion's trailers. */
async function builtCommit(fixture: PromotionFixture, extra: Readonly<Record<string, string>> = {}, profile = `${PROFILE_NAME}@${fixture.loaded().blob!}`): Promise<string> {
  let tree = (await fixture.plan()).projection.tree;
  if (Object.keys(extra).length > 0) {
    const env = { GIT_INDEX_FILE: join(createTempDir("publish-extra-index-"), "index") };
    fixture.git(["read-tree", tree], env);
    for (const [path, content] of Object.entries(extra)) {
      const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: fixture.root, input: content, encoding: "utf8" }).trim();
      fixture.git(["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], env);
    }
    tree = fixture.git(["write-tree"], env);
  }
  const source = fixture.tip(SOURCE);
  return fixture.git(["commit-tree", tree, "-p", fixture.tip(TARGET), "-p", source, "-m", `promote\n\nProjected-From: ${source}\nPromotion-Profile: ${profile}`]);
}

test("the publisher's check: the built tree must BE the projection recomputed from the source, under the profile read from it", async () => {
  const { fixture } = fixtureWithForge("publish-verify");
  const context = resolvePromotionContext(fixture.root, PROFILE_NAME, SOURCE, fixture.document);
  const plan = await fixture.plan();
  verifyBuiltProjection(context, await builtCommit(fixture), plan);
  for (const [why, extra] of [["an excluded file", { "dev/tool.ts": "export const leaked = 1;\n" }], ["internal notes", { "NOTES.md": "internal\n" }], ["a shipped file changed", { "product/main.ts": "export {};\n" }]] as const) {
    const error = await refusedWith("promotion_forge_projection_mismatch", async () => verifyBuiltProjection(context, await builtCommit(fixture, extra), plan));
    assert.deepEqual(error.facts["paths"], Object.keys(extra), `${why}: named`);
  }
  await refusedWith("promotion_forge_profile_mismatch", async () => verifyBuiltProjection(context, await builtCommit(fixture, {}, `${PROFILE_NAME}@0000000`), plan));
  await refusedWith("promotion_forge_profile_mismatch", async () => verifyBuiltProjection(context, await builtCommit(fixture, {}, `another-profile@${fixture.loaded().blob!}`), plan));
});

test("the verb builds the promotion itself: a pending commit planted earlier is dropped, never carried; a faithful build is checked, published and its receipt written", async () => {
  const { fixture, forge } = fixtureWithForge("publish-verb");
  const planted = await builtCommit(fixture, { "dev/tool.ts": "export const leaked = 1;\n" });
  const pendingRef = promotionRefs(PROFILE_NAME).pending;
  fixture.git(["update-ref", pendingRef, planted]);
  const out = join(createTempDir("publish-verb-out-"), "receipt.json");
  const request: PromotionRequest = parsePromoteArguments(["forge-publish", "--out", out]);
  const builds: PromotionRequest[] = [];
  const faithful = async (_context: unknown, applyRequest: PromotionRequest): Promise<PromotionAnswer> => {
    builds.push(applyRequest);
    assert.equal(fixture.git(["for-each-ref", pendingRef]), "", "the planted pending commit was dropped before the build");
    const commit = await builtCommit(fixture);
    fixture.git(["update-ref", pendingRef, commit]);
    return answer("promotion_committed", "built", { commit });
  };
  const answered = await promotionForgePublish(resolveRepositoryContext(fixture.root, fixture.document), request, forge.forge, undefined, faithful);
  assert.equal(answered.code, "promotion_forge_published", answered.message);
  assert.deepEqual(builds.map((entry) => [entry.verb, entry.noPublish]), [["apply", true]], "built once, never published by the build");
  const receipt = JSON.parse(readFileSync(out, "utf8")) as ProjectionReceipt;
  assert.equal(receipt.commit, forge.git(["rev-parse", `refs/heads/${TARGET}`]));
  assert.equal(readFileSync(out, "utf8"), receiptBytes(receipt));
  assert.throws(() => forge.git(["cat-file", "-e", `${receipt.commit}:dev/tool.ts`]), "the excluded file the planted commit carried was never published");

  const second = fixtureWithForge("publish-verb-malicious");
  await refusedWith("promotion_forge_projection_mismatch", () => promotionForgePublish(resolveRepositoryContext(second.fixture.root, second.fixture.document), request, second.forge.forge, undefined, async () => {
    const commit = await builtCommit(second.fixture, { "NOTES.md": "internal\n" });
    return answer("promotion_committed", "built", { commit });
  }));
  assert.equal(second.forge.count("commits") + second.forge.count("refs"), 0, "a build departing from the projection publishes nothing");
});

test("a build that refuses is the verb's answer, and nothing is published", async () => {
  const { fixture, forge } = fixtureWithForge("publish-build-refused");
  const out = join(createTempDir("publish-refused-out-"), "receipt.json");
  const answered = await promotionForgePublish(resolveRepositoryContext(fixture.root, fixture.document), parsePromoteArguments(["forge-publish", "--out", out]), forge.forge, undefined, async () => answer("promotion_target_edits", "edited", {}));
  assert.equal(answered.code, "promotion_target_edits");
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
