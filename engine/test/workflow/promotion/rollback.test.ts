/**
 * ROLLBACK AND HOLD (src/workflow/promotion/rollback.ts; merge-door-final §10,
 * T-H1..T-H4): a rollback is a NEW forward commit R whose tree is the
 * restored promotion's, with one parent (the target's tip) and the trailers,
 * built and published like a promotion, with the hold pushed atomically with
 * it; a hold stops an unattended run (an ok answer) and a manual one without
 * `--release-hold --reason`; a rollback of a rollback is refused; `hold` and
 * `release-hold` set and delete the hold, on the remote too.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { configuredWorktreeGitPort } from "../../../src/git/worktree-port.ts";
import { PromotionError, promotionExitCode, type PromotionAnswer, type PromotionCode } from "../../../src/workflow/promotion/codes.ts";
import { resolvePromotionContext } from "../../../src/workflow/promotion/context.ts";
import { promotionRefs, type ApplyRun } from "../../../src/workflow/promotion/promotion-run.ts";
import { holdPromotion, releaseHold, rollbackPromotion } from "../../../src/workflow/promotion/rollback.ts";
import { testProcessSupervisorBinary } from "../../../guardian/build.ts";
import { apply, landing, refused } from "./apply-support.ts";
import { FIXTURE_ENGINE, FIXTURE_GENERATED, PROFILE_NAME, SOURCE, TARGET, type PromotionFixture } from "./promotion-fixture.ts";

const PUBLISH = { request: { noPublish: false } } as const;
const REFS = promotionRefs(PROFILE_NAME);

function runOf(fixture: PromotionFixture): ApplyRun {
  return {
    git: configuredWorktreeGitPort(fixture.document),
    runner: { supervisor: testProcessSupervisorBinary(), killGraceMs: 500, outputCharacters: 4_000, retries: { retries: 0, backoffMs: 1 } },
    generatedOutputs: () => FIXTURE_GENERATED,
    buildOutputs: () => [],
    engineRelative: FIXTURE_ENGINE,
    toolchain: { node: process.version },
    plan: (context) => fixture.plan({ source: context.source, target: context.target }),
  };
}

function contextOf(fixture: PromotionFixture) {
  return resolvePromotionContext(fixture.root, PROFILE_NAME, SOURCE, fixture.document);
}

async function refusedWith(promise: Promise<PromotionAnswer>, code: PromotionCode): Promise<PromotionError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof PromotionError, String(error));
    assert.equal(error.promotionCode, code, error.message);
    return error;
  }
  assert.fail(`did not refuse with ${code}`);
}

/** Two promotions published (Pg1, then Pg2 on it), on the remote and in W. */
async function twoPromotions(prefix: string): Promise<Readonly<{ fixture: PromotionFixture; first: string; second: string }>> {
  const fixture = landing(prefix, {}, { remote: true, targetCheckout: true });
  const first = ((await apply(fixture, PUBLISH)).data as { commit: string }).commit;
  fixture.commit(SOURCE, { "product/lib/helper.ts": "export const helper = 'a defect';\n" }, "a defect");
  const second = ((await apply(fixture, PUBLISH)).data as { commit: string }).commit;
  return { fixture, first, second };
}

test("T-H1: a rollback to Pg is a NEW commit R (Pg's tree, ONE parent: the tip; the trailers), published with the hold in ONE push; W lands it", async () => {
  const { fixture, first, second } = await twoPromotions("promotion-rollback");
  const result = await rollbackPromotion(contextOf(fixture), { to: first, reason: "the defect shipped in the second promotion" }, runOf(fixture));
  assert.equal(result.code, "promotion_rolled_back", result.message);
  const rollback = (result.data as { commit: string }).commit;
  assert.equal(fixture.git(["rev-parse", `${rollback}^{tree}`]), fixture.git(["rev-parse", `${first}^{tree}`]), "Pg's tree");
  assert.equal(fixture.git(["rev-list", "--parents", "-n", "1", rollback]).split(" ").length, 2, "one parent");
  assert.equal(fixture.git(["rev-parse", `${rollback}^1`]), second, "forward: on the tip, never a forced push");
  const trailers = (key: string): string => fixture.git(["log", "-1", `--format=%(trailers:key=${key},valueonly)`, rollback]);
  assert.equal(trailers("Promotion-Restores"), first);
  assert.equal(trailers("Projected-From"), fixture.git(["log", "-1", "--format=%(trailers:key=Projected-From,valueonly)", first]));
  assert.match(trailers("Promotion-Profile"), new RegExp(`^${PROFILE_NAME}@[0-9a-f]{40}$`, "u"));
  assert.match(fixture.git(["log", "-1", "--format=%B", rollback]), /the defect shipped in the second promotion/u);
  assert.equal(fixture.remoteGit(["rev-parse", `refs/heads/${TARGET}`]), rollback);
  const hold = fixture.remoteGit(["rev-parse", REFS.hold]);
  assert.equal(fixture.git(["rev-parse", REFS.hold]), hold, "the hold is on the remote and here");
  const record = JSON.parse(fixture.git(["cat-file", "blob", hold])) as { heldSource: string; restores: string; reason: string; by: string };
  assert.equal(record.restores, first);
  assert.equal(record.reason, "the defect shipped in the second promotion");
  assert.equal(fixture.git(["-C", fixture.targetCheckout!, "rev-parse", "HEAD"]), rollback);
});

test("H2 (PROMO-3+4-FIX): a rollback reconciles the target and the hold only — a local source commit never pushed stays unpublished, and a local source apart from its remote's refuses nothing", async () => {
  for (const diverged of [false, true]) {
    const { fixture, first } = await twoPromotions(`promotion-rollback-source-${String(diverged)}`);
    const local = fixture.commit(SOURCE, { "product/lib/helper.ts": "export const helper = 'local work in progress';\n" }, "local wip, not pushed");
    if (diverged) {
      const remoteTip = fixture.remoteGit(["rev-parse", `refs/heads/${SOURCE}`]);
      const elsewhere = fixture.git(["commit-tree", `${remoteTip}^{tree}`, "-p", remoteTip, "-m", "pushed from another machine"]);
      fixture.git(["push", "-q", "origin", `${elsewhere}:refs/heads/${SOURCE}`]);
    }
    const remoteSource = fixture.remoteGit(["rev-parse", `refs/heads/${SOURCE}`]);
    const result = await rollbackPromotion(contextOf(fixture), { to: first, reason: "a defect" }, runOf(fixture));
    assert.equal(result.code, "promotion_rolled_back", result.message);
    const rollback = (result.data as { commit: string }).commit;
    assert.equal(fixture.remoteGit(["rev-parse", `refs/heads/${TARGET}`]), rollback, "R is published");
    assert.equal(fixture.remoteGit(["rev-parse", REFS.hold]), fixture.git(["rev-parse", REFS.hold]), "with its hold");
    assert.equal(fixture.remoteGit(["rev-parse", `refs/heads/${SOURCE}`]), remoteSource, `the remote's source is untouched (diverged=${String(diverged)})`);
    assert.notEqual(fixture.remoteGit(["rev-parse", `refs/heads/${SOURCE}`]), local, "the local commit was never published");
  }
});

test("N3 (PROMO-3+4-FIX): a rollback whose push did not reach the remote keeps its pinned R AND its hold; the rerun publishes R with the hold in one push, so automation stays paused — also when the run died between the pin and the hold's ref", async () => {
  for (const lostRef of [false, true]) {
    const { fixture, first } = await twoPromotions(`promotion-rollback-resume-${String(lostRef)}`);
    const real = runOf(fixture);
    const offline: ApplyRun = { ...real, git: { ...real.git, pushAtomic: () => ({ status: 128, refs: [], stderr: "fatal: unable to access 'https://example.invalid/r.git/': Could not resolve host: example.invalid" }) } };
    await refusedWith(rollbackPromotion(contextOf(fixture), { to: first, reason: "a defect" }, offline), "promotion_push_errored");
    const pinned = fixture.git(["rev-parse", REFS.pending]);
    const hold = fixture.git(["rev-parse", REFS.hold]);
    assert.equal(fixture.remoteGit(["for-each-ref", "--format=%(refname)", REFS.hold]), "", "nothing reached the remote");
    if (lostRef) {
      fixture.git(["update-ref", "-d", REFS.hold]);
    } else {
      // Meanwhile an unattended apply: the unpublished rollback's hold is in force here (never "released remotely"), its pin kept.
      await refused(fixture, "promotion_held", { request: { noPublish: false, auto: true } });
      assert.equal(fixture.git(["rev-parse", REFS.pending]), pinned, "the rollback's pin survives the apply");
      assert.equal(fixture.git(["rev-parse", REFS.hold]), hold);
    }
    const resumed = await rollbackPromotion(contextOf(fixture), { to: first, reason: "a defect" }, runOf(fixture));
    assert.equal(resumed.code, "promotion_rolled_back", resumed.message);
    assert.equal((resumed.data as { commit: string }).commit, pinned, "the pinned R is published, never rebuilt");
    assert.equal(fixture.remoteGit(["rev-parse", `refs/heads/${TARGET}`]), pinned);
    assert.equal(fixture.remoteGit(["rev-parse", REFS.hold]), hold, `the hold went with R (lost ref: ${String(lostRef)})`);
    assert.equal(fixture.git(["rev-parse", REFS.hold]), hold, "and is in force here");
    await refused(fixture, "promotion_held", { request: { noPublish: false, auto: true } });
  }
});

test("L2 (PROMO-3+4-FIX): a rollback whose build FAILS leaves no hold behind (its ref is created only once R is pinned); the rerun rolls back with the hold", async () => {
  const { fixture, first } = await twoPromotions("promotion-rollback-failed");
  fixture.mark("gate-mode", "exit1");
  await refusedWith(rollbackPromotion(contextOf(fixture), { to: first, reason: "a defect" }, runOf(fixture)), "promotion_gate_failed");
  assert.equal(fixture.git(["for-each-ref", "--format=%(refname)", REFS.hold]), "", "no hold here");
  assert.equal(fixture.remoteGit(["for-each-ref", "--format=%(refname)", REFS.hold]), "", "nor on the remote");
  fixture.mark("gate-mode", null);
  const rolled = await rollbackPromotion(contextOf(fixture), { to: first, reason: "a defect" }, runOf(fixture));
  assert.equal(rolled.code, "promotion_rolled_back", rolled.message);
  assert.equal(fixture.remoteGit(["rev-parse", REFS.hold]), fixture.git(["rev-parse", REFS.hold]));
});

test("X18 (PROMO-3+4-FIX): a hold the remote never received is not in force here either (all or nothing)", async () => {
  const fixture = landing("promotion-hold-offline", {}, { remote: true });
  const real = configuredWorktreeGitPort(fixture.document);
  const offline = { ...real, pushAtomic: () => ({ status: 128, refs: [], stderr: "fatal: unable to access 'https://example.invalid/r.git/': Could not resolve host: example.invalid" }) };
  await refusedWith(holdPromotion(contextOf(fixture), "a freeze", { git: offline }), "promotion_push_errored");
  assert.equal(fixture.git(["for-each-ref", "--format=%(refname)", REFS.hold]), "");
});

test("T-H2: held — an unattended apply answers promotion_held (exit 0); a manual one refuses without --release-hold --reason, and with them releases the hold (on the remote too) and promotes", async () => {
  const { fixture, first } = await twoPromotions("promotion-held");
  await rollbackPromotion(contextOf(fixture), { to: first, reason: "a defect" }, runOf(fixture));
  fixture.commit(SOURCE, { "product/lib/helper.ts": "export const helper = 'fixed';\n" }, "the fix");
  const unattended = await refused(fixture, "promotion_held", { request: { noPublish: false, auto: true } });
  assert.equal(promotionExitCode(unattended.promotionCode, true), 0);
  await refused(fixture, "promotion_held", PUBLISH);
  const released = await apply(fixture, { request: { noPublish: false, releaseHold: true, reason: "the fix is on the source" } });
  assert.equal(released.code, "promotion_published", released.message);
  assert.equal(fixture.git(["for-each-ref", "--format=%(refname)", REFS.hold]), "");
  assert.equal(fixture.remoteGit(["for-each-ref", "--format=%(refname)", REFS.hold]), "", "released on the remote");
});

test("T-H3: a rollback of a rollback is refused; so is a rollback to the tip, to a commit that is no promotion of the profile, and to nothing", async () => {
  const { fixture, first, second } = await twoPromotions("promotion-rollback-twice");
  const invalid = async (to: string, why: RegExp): Promise<void> => {
    const error = await refusedWith(rollbackPromotion(contextOf(fixture), { to, reason: "again" }, runOf(fixture)), "promotion_rollback_invalid");
    assert.match(error.message, why);
  };
  await invalid(second, /tip: there is nothing to roll back/u);
  await invalid(fixture.tip(SOURCE), /not a promotion/u);
  await invalid("no-such-commit", /names no commit/u);
  const rolled = await rollbackPromotion(contextOf(fixture), { to: first, reason: "a defect" }, runOf(fixture));
  await invalid((rolled.data as { commit: string }).commit, /itself a rollback/u);
  // Restoring the second promotion (a promotion, no longer the tip) is a valid forward restore.
  const forward = await rollbackPromotion(contextOf(fixture), { to: second, reason: "it was not the defect after all" }, runOf(fixture));
  assert.equal(forward.code, "promotion_rolled_back");
});

test("T-H4: hold and release-hold without a rollback create and delete the ref, here and on the remote; an absent hold releases nothing", async () => {
  const fixture = landing("promotion-hold", {}, { remote: true });
  const git = { git: configuredWorktreeGitPort(fixture.document) };
  const held = await holdPromotion(contextOf(fixture), "a freeze before the release", git);
  assert.equal(held.code, "promotion_hold_set");
  assert.equal(fixture.remoteGit(["rev-parse", REFS.hold]), fixture.git(["rev-parse", REFS.hold]));
  assert.equal((await holdPromotion(contextOf(fixture), "again", git)).code, "promotion_hold_set", "already held: still held");
  await refused(fixture, "promotion_held", PUBLISH);
  const released = await releaseHold(contextOf(fixture), "the release is out", git);
  assert.equal(released.code, "promotion_hold_released");
  assert.equal(fixture.git(["for-each-ref", "--format=%(refname)", REFS.hold]), "");
  assert.equal(fixture.remoteGit(["for-each-ref", "--format=%(refname)", REFS.hold]), "");
  assert.equal((await releaseHold(contextOf(fixture), "nothing to release", git)).code, "promotion_not_held");
  // A hold set on ANOTHER machine (only on the remote) is in force here at the next run; released there, it goes here too.
  const record = join(fixture.commandsDirectory, "hold.json");
  writeFileSync(record, `${JSON.stringify({ reason: "set on another machine", at: "2026-10-01T00:00:00.000Z", by: "someone" })}\n`);
  const blob = fixture.git(["hash-object", "-w", record]);
  fixture.git(["push", "-q", "origin", `${blob}:${REFS.hold}`]);
  const elsewhere = await refused(fixture, "promotion_held", PUBLISH);
  assert.match(elsewhere.message, /set on another machine/u);
  assert.equal(fixture.git(["rev-parse", REFS.hold]), blob, "fetched here");
  fixture.git(["push", "-q", "origin", `:${REFS.hold}`]);
  const promoted = await apply(fixture, PUBLISH);
  assert.equal(promoted.code, "promotion_published", promoted.message);
  assert.equal(fixture.git(["for-each-ref", "--format=%(refname)", REFS.hold]), "", "released remotely: gone here too");
});
