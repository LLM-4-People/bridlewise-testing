/**
 * PUBLICATION (src/workflow/promotion/publication.ts over tree-landing.ts):
 * the remote first — one atomic, never-forced push of C, its receipt and S
 * when the remote's source lags — then the checkout W that holds the target
 * (a fast-forward; a torn one completed with git alone; overlapping local
 * edits PARK it), then the finish (the config mode, the build outputs, the
 * stale setup named, the pin gone). One test per failure mode of
 * merge-door-final §17.2: T-U1..T-U11, T-R2, T-R4, T-R5, T-D1, T-D2, T-D4,
 * T-G1, T-G2 — on the landing fixture with a bare remote `origin` and W.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { configuredWorktreeGitPort, type WorktreeGitPort } from "../../../src/git/worktree-port.ts";
import { sha256 } from "../../../src/kernel/integrity.ts";
import { engineRoot } from "../../../src/kernel/engine-root.ts";
import { ROOT_POLICY } from "../../../src/kernel/root-policy.ts";
import { PromotionError, promotionExitCode, type PromotionAnswer } from "../../../src/workflow/promotion/codes.ts";
import { resolvePromotionContext } from "../../../src/workflow/promotion/context.ts";
import { readLastRun } from "../../../src/workflow/promotion/last-run.ts";
import { promotionRefs } from "../../../src/workflow/promotion/promotion-run.ts";
import { holdPromotion } from "../../../src/workflow/promotion/rollback.ts";
import { unattendedEnvironment, withUnattendedChain } from "../../../src/workflow/promotion/trigger.ts";
import { repositoryRegistry, repositoryRegistryArea } from "../../../src/workflow/repository-registry.ts";
import { acquireLock } from "../../../src/workflow/resource-lock.ts";
import { landCommit, landingGitOperationCount } from "../../../src/workflow/tree-landing.ts";
import { apply, candidates, committed, documentOf, landing, refused } from "./apply-support.ts";
import { PROFILE_NAME, SOURCE, SOURCE_LOCK, SOURCE_MANIFEST, TARGET, json, type PromotionFixture } from "./promotion-fixture.ts";

const PUBLISH = { request: { noPublish: false } } as const;
const REFS = promotionRefs(PROFILE_NAME);

type Published = Readonly<{ commit: string; pushed: boolean; landing: string | null; landedIn: string | null; resumed: boolean; targetCheckout: { path: string | null; depsStale: readonly string[] }; installed: readonly string[] }>;

function published(result: { code: string; message: string; data: unknown }): Published {
  assert.equal(result.code, "promotion_published", result.message);
  return result.data as Published;
}

/** A publication fixture: the landing fixture with the bare remote `origin` and the target checkout W (unless told otherwise). */
function world(prefix: string, overrides: Readonly<Record<string, unknown>> = {}, options: Readonly<{ targetCheckout?: boolean; remote?: boolean; setupInputs?: readonly string[] }> = {}): PromotionFixture {
  return landing(prefix, overrides, { remote: options.remote ?? true, targetCheckout: options.targetCheckout ?? true, ...(options.setupInputs === undefined ? {} : { setupInputs: options.setupInputs }) });
}

/** W's path (the fixture's target checkout). */
function w(fixture: PromotionFixture): string {
  assert.ok(fixture.targetCheckout !== null);
  return fixture.targetCheckout;
}

function pendingRef(fixture: PromotionFixture): string {
  return fixture.git(["for-each-ref", "--format=%(objectname)", REFS.pending]);
}

/** A commit on the remote's target made elsewhere: an empty commit on its tip (no path changes: no target edit). */
function moveRemoteTarget(fixture: PromotionFixture, message: string): string {
  const tip = fixture.remoteGit(["rev-parse", `refs/heads/${TARGET}`]);
  const moved = fixture.git(["commit-tree", `${tip}^{tree}`, "-p", tip, "-m", message]);
  fixture.git(["push", "-q", "origin", `${moved}:refs/heads/${TARGET}`]);
  return moved;
}

test("T-U1: with a remote at T: ONE atomic push of C, its receipt and S (the remote's source lagged); ls-remote reads C; W fast-forwarded; the pin and the candidate gone; a rerun is up to date", async () => {
  const fixture = world("promotion-publish-happy");
  const source = fixture.tip(SOURCE);
  const target = fixture.tip(TARGET);
  assert.notEqual(fixture.remoteGit(["rev-parse", `refs/heads/${SOURCE}`]), source, "the remote's source lags S");
  const done = published(await apply(fixture, PUBLISH));
  assert.equal(done.pushed, true);
  assert.equal(done.landing, "fast-forward");
  assert.equal(done.landedIn, w(fixture));
  assert.equal(fixture.git(["rev-parse", `${done.commit}^1`]), target);
  assert.equal(fixture.remoteGit(["rev-parse", `refs/heads/${TARGET}`]), done.commit);
  assert.equal(fixture.remoteGit(["rev-parse", `refs/heads/${SOURCE}`]), source, "S went with C (a fast-forward of the remote's source)");
  assert.equal(fixture.remoteGit(["rev-parse", REFS.receipt(done.commit)]), fixture.git(["rev-parse", REFS.receipt(done.commit)]), "the receipt went with C");
  assert.equal(fixture.git(["-C", w(fixture), "rev-parse", "HEAD"]), done.commit);
  assert.equal(fixture.git(["-C", w(fixture), "status", "--porcelain"]), "");
  assert.equal(pendingRef(fixture), "");
  assert.deepEqual(candidates(fixture), []);
  const record = readLastRun(resolvePromotionContext(fixture.root, PROFILE_NAME, SOURCE, fixture.document).workDirectory);
  assert.equal(record?.result?.code, "promotion_published");
  assert.equal(record?.pushed, true);
  assert.deepEqual(Object.keys(record?.durations ?? {}), ["start", "reconcile", "plan", "candidate", "settle", "commit", "publish", "finish"], "every phase is recorded with its duration");
  assert.equal((await apply(fixture, PUBLISH)).code, "promotion_up_to_date");
});

test("T-U2/T-U6: W's own work that the landing does not touch (an unstaged edit, untracked tool state, an editor file, an ignored file, a folder the profile excludes) survives byte for byte", async () => {
  const fixture = world("promotion-publish-dirt");
  const dirt: Readonly<Record<string, string>> = {
    "product/pages/a.ts": "export const a = 'edited in W';\n",
    ".code-harness/state.json": "{}\n",
    "notes.md.swp": "editor\n",
    "build/keep.txt": "ignored, kept\n",
    "dev/local.md": "an excluded folder's local file\n",
  };
  for (const [path, content] of Object.entries(dirt)) {
    mkdirSync(join(w(fixture), path, ".."), { recursive: true });
    writeFileSync(join(w(fixture), path), content);
  }
  const digest = (): Readonly<Record<string, string>> => Object.fromEntries(Object.keys(dirt).map((path) => [path, sha256(readFileSync(join(w(fixture), path)))]));
  const before = digest();
  // A failed run first (a gate refuses): the dirt survives the failure path too.
  fixture.mark("gate-mode", "exit1");
  await refused(fixture, "promotion_gate_failed", PUBLISH);
  assert.deepEqual(digest(), before);
  fixture.mark("gate-mode", null);
  const done = published(await apply(fixture, PUBLISH));
  assert.equal(done.landing, "fast-forward");
  assert.equal(fixture.git(["-C", w(fixture), "rev-parse", "HEAD"]), done.commit);
  assert.deepEqual(digest(), before, "the checkout's own bytes are never touched");
});

test("T-U3: a TORN W (a crash mid fast-forward: dirty paths already at C's bytes, a symlink and a deletion among them; with the index at T, and at C) is completed with git alone; an unrelated file is preserved", async () => {
  for (const staged of [false, true]) {
    const fixture = world(`promotion-publish-torn-${String(staged)}`);
    fixture.commit(SOURCE, { "product/link.ts": null, "product/run.sh": null }, "a symlink retargeted, a script removed");
    symlinkSync("worker.ts", join(fixture.root, "product/link.ts"));
    fixture.git(["add", "product/link.ts"]);
    fixture.git(["commit", "-q", "-m", "the link retargeted"]);
    const built = committed(await apply(fixture));
    const target = fixture.tip(TARGET);
    const delta = fixture.git(["diff", "--name-only", target, built.commit]).split("\n");
    assert.ok(delta.includes("product/link.ts") && delta.includes("product/run.sh") && delta.includes("product/lib/helper.ts"), delta.join(", "));
    // The torn state: some of C's paths written, one deleted, the rest still T's.
    writeFileSync(join(w(fixture), "product/lib/helper.ts"), fixture.git(["show", `${built.commit}:product/lib/helper.ts`]) + "\n");
    rmSync(join(w(fixture), "product/link.ts"));
    symlinkSync("worker.ts", join(w(fixture), "product/link.ts"));
    rmSync(join(w(fixture), "product/run.sh"));
    writeFileSync(join(w(fixture), "unrelated.txt"), "mine\n");
    if (staged) fixture.git(["-C", w(fixture), "add", "-A", "--", "product/lib/helper.ts", "product/link.ts", "product/run.sh"]);
    const done = published(await apply(fixture, PUBLISH));
    assert.equal(done.commit, built.commit, "the pinned commit is published (nothing rebuilt)");
    // Index at T: git refuses the fast-forward and the landing completes it; index already at C: git's own fast-forward takes it.
    assert.equal(done.landing, staged ? "fast-forward" : "torn-completion", `staged=${String(staged)}`);
    assert.equal(fixture.git(["-C", w(fixture), "rev-parse", "HEAD"]), built.commit);
    assert.equal(fixture.git(["-C", w(fixture), "status", "--porcelain=v1", "--untracked-files=all"]), "?? unrelated.txt", "clean but for the unrelated file");
    assert.equal(readFileSync(join(w(fixture), "gen/pin.txt"), "utf8").trim(), fixture.git(["show", `${built.commit}:gen/pin.txt`]), "a path still at T's bytes was brought to C's");
  }
});

test("N1 (PROMO-3+4-FIX): a W whose worktree is at C's bytes but whose index STAGES a version neither T nor C records is never completed — the promotion parks and the staged blob stays staged; the rerun lands once it is unstaged", async () => {
  const fixture = world("promotion-publish-torn-staged");
  const built = committed(await apply(fixture));
  const path = "product/lib/helper.ts";
  writeFileSync(join(w(fixture), path), "export const helper = 'staged in W, nowhere else';\n");
  fixture.git(["-C", w(fixture), "add", "--", path]);
  const staged = fixture.git(["-C", w(fixture), "rev-parse", `:${path}`]);
  writeFileSync(join(w(fixture), path), fixture.git(["show", `${built.commit}:${path}`]) + "\n");
  const parked = await refused(fixture, "promotion_parked", PUBLISH);
  assert.deepEqual(parked.facts["overlap"], [path], "the staged path is named as W's own work");
  assert.equal(fixture.git(["-C", w(fixture), "rev-parse", `:${path}`]), staged, "the staged blob is never overwritten");
  assert.equal(fixture.git(["-C", w(fixture), "rev-parse", "HEAD"]), fixture.tip(TARGET), "W's branch did not move");
  fixture.git(["-C", w(fixture), "reset", "-q", "--", path]);
  const done = published(await apply(fixture, PUBLISH));
  assert.equal(done.commit, built.commit);
  assert.equal(done.landing, "torn-completion", "the index back at T, the worktree at C: the torn fast-forward completes");
  assert.equal(fixture.git(["-C", w(fixture), "status", "--porcelain=v1", "--untracked-files=all"]), "");
});

test("N1 (PROMO-3+4-FIX): a W whose index holds a CONFLICT on a delta path (its last stage C's own entry, the worktree at C's bytes) is never completed: the promotion parks and the conflict stays", async () => {
  const fixture = world("promotion-publish-torn-conflict");
  const built = committed(await apply(fixture));
  const path = "product/lib/helper.ts";
  const theirs = fixture.git(["rev-parse", `${built.commit}:${path}`]);
  const base = fixture.git(["rev-parse", `${fixture.tip(TARGET)}:${path}`]);
  writeFileSync(join(w(fixture), "ours.ts"), "export const helper = 'ours, in a conflict';\n");
  const ours = fixture.git(["-C", w(fixture), "hash-object", "-w", "ours.ts"]);
  rmSync(join(w(fixture), "ours.ts"));
  execFileSync("git", ["-C", w(fixture), "update-index", "--index-info"], { input: `0 ${"0".repeat(40)}\t${path}\n100644 ${base} 1\t${path}\n100644 ${ours} 2\t${path}\n100644 ${theirs} 3\t${path}\n` });
  writeFileSync(join(w(fixture), path), fixture.git(["show", `${built.commit}:${path}`]) + "\n");
  const parked = await refused(fixture, "promotion_parked", PUBLISH);
  assert.deepEqual(parked.facts["overlap"], [path]);
  assert.match(fixture.git(["-C", w(fixture), "ls-files", "--stage", "--", path]), new RegExp(`100644 ${ours} 2\t`, "u"), "the conflict's stages are never overwritten");
});

test("N6 (PROMO-3+4-FIX): W's index held by another git is promotion_target_index_locked (the lock never deleted, the pin kept); the rerun lands once it is released", async () => {
  const fixture = world("promotion-publish-index-locked");
  const lock = fixture.git(["-C", w(fixture), "rev-parse", "--path-format=absolute", "--git-path", "index.lock"]);
  writeFileSync(lock, "");
  const locked = await refused(fixture, "promotion_target_index_locked", PUBLISH);
  assert.equal(promotionExitCode(locked.promotionCode), 4, "the environment's, never the source's");
  assert.equal(existsSync(lock), true, "another git's lock is never deleted");
  const commit = pendingRef(fixture);
  assert.equal(fixture.remoteGit(["rev-parse", `refs/heads/${TARGET}`]), commit, "the remote already carries C");
  rmSync(lock);
  const done = published(await apply(fixture, PUBLISH));
  assert.equal(done.commit, commit);
  assert.equal(fixture.git(["-C", w(fixture), "rev-parse", "HEAD"]), commit);
});

test("T-U4: W holding OVERLAPPING local edits parks the promotion (exit 7; the remote already carries C; the pin kept); once the edit is gone the rerun lands it without rebuilding", async () => {
  const fixture = world("promotion-publish-parked", {}, { setupInputs: ["product/lib/helper.ts"] });
  writeFileSync(join(w(fixture), "product/lib/helper.ts"), "export const helper = 'W has its own idea';\n");
  const parked = await refused(fixture, "promotion_parked", { ...PUBLISH, run: { buildOutputs: () => ["build/out.txt"] } });
  assert.equal(promotionExitCode(parked.promotionCode), 7);
  assert.equal(promotionExitCode(parked.promotionCode, true), 0, "an unattended run is not failed by a parked landing");
  assert.deepEqual(parked.facts["overlap"], ["product/lib/helper.ts"]);
  const commit = String(parked.facts["commit"]);
  assert.equal(fixture.remoteGit(["rev-parse", `refs/heads/${TARGET}`]), commit, "the remote is already right");
  assert.equal(pendingRef(fixture), commit);
  assert.equal(readFileSync(join(w(fixture), "product/lib/helper.ts"), "utf8"), "export const helper = 'W has its own idea';\n", "W's edit is never touched");
  const setups = fixture.commandOutput("setup-runs");
  fixture.git(["-C", w(fixture), "checkout", "--", "product/lib/helper.ts"]);
  const done = published(await apply(fixture, { ...PUBLISH, run: { buildOutputs: () => ["build/out.txt"] } }));
  assert.equal(done.commit, commit);
  assert.equal(done.resumed, true);
  assert.equal(fixture.commandOutput("setup-runs"), setups, "nothing was rebuilt");
  assert.equal(fixture.git(["-C", w(fixture), "rev-parse", "HEAD"]), commit);
  // The rerun says how it landed (its reconcile caught W up), installs the kept candidate's build outputs, and measures
  // W's stale setup from W's tip BEFORE that landing (the promotion changed the setup's input).
  assert.equal(done.landing, "fast-forward");
  assert.equal(done.landedIn, w(fixture));
  assert.deepEqual(done.installed, ["build/out.txt"]);
  assert.deepEqual(done.targetCheckout.depsStale, ["setup"]);
});

test("T-U5: the remote's target moved between the plan and the push: the atomic push is rejected, the run re-plans ONCE on the new tip and publishes", async () => {
  const fixture = world("promotion-publish-moved", {}, { targetCheckout: false });
  let plans = 0;
  let moved = "";
  const done = published(await apply(fixture, {
    ...PUBLISH,
    run: {
      plan: (context) => {
        plans += 1;
        if (plans === 1) moved = moveRemoteTarget(fixture, "someone else's promotion");
        return fixture.plan({ source: context.source, target: context.target });
      },
    },
  }));
  assert.equal(plans, 2, "one re-plan");
  assert.equal(fixture.git(["rev-parse", `${done.commit}^1`]), moved, "built on the new tip");
  assert.equal(fixture.remoteGit(["rev-parse", `refs/heads/${TARGET}`]), done.commit);
  assert.equal(fixture.tip(TARGET), done.commit, "the local branch (checked out nowhere) moved by a compare-and-swap");
});

test("T-U5: a remote that moves AGAIN after the re-plan is promotion_push_rejected (never forced)", async () => {
  const fixture = world("promotion-publish-moved-twice", {}, { targetCheckout: false });
  const error = await refused(fixture, "promotion_push_rejected", {
    ...PUBLISH,
    run: {
      plan: (context) => {
        moveRemoteTarget(fixture, "a moving remote");
        return fixture.plan({ source: context.source, target: context.target });
      },
    },
  });
  assert.match(error.message, /re-planned once/u);
});

test("T-U7: the config document's mode in W is restored to 0600 after the fast-forward (a checkout write leaves the umask's mode)", async () => {
  const fixture = world("promotion-publish-mode");
  const config = join(w(fixture), "tool/bridlewise.config.json");
  chmodSync(config, 0o644);
  published(await apply(fixture, PUBLISH));
  assert.equal(statSync(config).mode & 0o777, 0o600);
});

test("T-U8: an unreachable remote is promotion_push_errored (exit 4): the pin is kept and a later run pushes the SAME commit", async () => {
  const fixture = world("promotion-publish-unreachable");
  const real = configuredWorktreeGitPort(documentOf(fixture, false));
  const offline: WorktreeGitPort = { ...real, pushAtomic: () => ({ status: 128, refs: [], stderr: "fatal: unable to access 'https://example.invalid/r.git/': Could not resolve host: example.invalid" }) };
  const error = await refused(fixture, "promotion_push_errored", { ...PUBLISH, run: { git: offline } });
  assert.equal(promotionExitCode(error.promotionCode), 4);
  const commit = pendingRef(fixture);
  assert.match(commit, /^[0-9a-f]{40}$/u);
  assert.equal(fixture.remoteGit(["rev-parse", `refs/heads/${TARGET}`]), fixture.tip(TARGET), "nothing reached the remote");
  const done = published(await apply(fixture, PUBLISH));
  assert.equal(done.commit, commit, "the same commit is pushed");
});

test("T-U9: the remote's hook refusing is promotion_remote_refused (the pin kept); a local target apart from its remote is promotion_target_diverged", async () => {
  const refusing = world("promotion-publish-refused");
  const hook = join(refusing.remote!, "hooks", "pre-receive");
  writeFileSync(hook, "#!/bin/sh\necho 'the remote declines' >&2\nexit 1\n");
  chmodSync(hook, 0o755);
  const error = await refused(refusing, "promotion_remote_refused", PUBLISH);
  assert.match(error.message, /remote rejected/u);
  assert.notEqual(pendingRef(refusing), "");
  const diverged = world("promotion-publish-diverged");
  diverged.commit(TARGET, {}, "a local commit on the target");
  moveRemoteTarget(diverged, "a remote commit on the target");
  await refused(diverged, "promotion_target_diverged", PUBLISH);
});

test("N6 (PROMO-3+4-FIX): `--no-push` publishes locally only (W lands C, the remote untouched); the next run, with nothing to build, pushes that SAME commit", async () => {
  const fixture = world("promotion-publish-no-push");
  const remoteTarget = fixture.remoteGit(["rev-parse", `refs/heads/${TARGET}`]);
  const local = published(await apply(fixture, { request: { noPublish: false, noPush: true } }));
  assert.equal(local.pushed, false);
  assert.equal(fixture.git(["-C", w(fixture), "rev-parse", "HEAD"]), local.commit, "landed here");
  assert.equal(fixture.remoteGit(["rev-parse", `refs/heads/${TARGET}`]), remoteTarget, "the remote is untouched");
  const pushed = published(await apply(fixture, PUBLISH));
  assert.equal(pushed.commit, local.commit, "the local promotion is carried, never rebuilt");
  assert.equal(pushed.pushed, true);
  assert.equal(fixture.remoteGit(["rev-parse", `refs/heads/${TARGET}`]), local.commit);
  assert.equal(fixture.remoteGit(["rev-parse", REFS.receipt(local.commit)]), fixture.git(["rev-parse", REFS.receipt(local.commit)]), "its receipt went with it");
});

test("N6 (PROMO-3+4-FIX): a source apart from its remote's (each holds a commit the other lacks) is promotion_source_diverged; nothing is built or pushed", async () => {
  const fixture = world("promotion-publish-source-apart");
  const remoteTip = fixture.remoteGit(["rev-parse", `refs/heads/${SOURCE}`]);
  const elsewhere = fixture.git(["commit-tree", `${remoteTip}^{tree}`, "-p", remoteTip, "-m", "pushed from another machine"]);
  fixture.git(["push", "-q", "origin", `${elsewhere}:refs/heads/${SOURCE}`]);
  const target = fixture.remoteGit(["rev-parse", `refs/heads/${TARGET}`]);
  await refused(fixture, "promotion_source_diverged", PUBLISH);
  assert.equal(fixture.remoteGit(["rev-parse", `refs/heads/${SOURCE}`]), elsewhere);
  assert.equal(fixture.remoteGit(["rev-parse", `refs/heads/${TARGET}`]), target);
  assert.equal(pendingRef(fixture), "");
});

test("L5 (PROMO-3+4-FIX): after an accepted push, a remote tip that CARRIES C (another machine built on it meanwhile) is a publication; one that does not is promotion_post_publish_mismatch", async () => {
  const racing = world("promotion-publish-built-upon");
  const real = configuredWorktreeGitPort(documentOf(racing, false));
  let builtOn = "";
  const racingGit: WorktreeGitPort = { ...real, pushAtomic: (...args) => { const outcome = real.pushAtomic(...args); builtOn = moveRemoteTarget(racing, "another machine builds on C"); return outcome; } };
  const done = published(await apply(racing, { ...PUBLISH, run: { git: racingGit } }));
  assert.equal(racing.remoteGit(["rev-parse", `${builtOn}^1`]), done.commit, "the remote carries C");
  const lying = world("promotion-publish-mismatch");
  const honest = configuredWorktreeGitPort(documentOf(lying, false));
  const before = lying.tip(TARGET);
  let pushedOnce = false;
  const lyingGit: WorktreeGitPort = {
    ...honest,
    pushAtomic: (...args) => { pushedOnce = true; return honest.pushAtomic(...args); },
    lsRemote: (...args) => (pushedOnce ? { refs: new Map([[`refs/heads/${TARGET}`, before]]), refusal: null } : honest.lsRemote(...args)),
  };
  const error = await refused(lying, "promotion_post_publish_mismatch", { ...PUBLISH, run: { git: lyingGit } });
  assert.equal(error.facts["remote"], before);
});

test("L1 (PROMO-3+4-FIX): a run that pushed C and died before its finish, then another machine built on C: the rerun drops the pin but KEEPS C's receipt (the record of what shipped)", async () => {
  const fixture = world("promotion-publish-died-after-push");
  const died = await refused(fixture, "promotion_unexpected", { ...PUBLISH, run: { checkpoint: (name) => { if (name === "pushed") throw new Error("the process died after its push"); } } });
  assert.match(died.message, /died after its push/u);
  const commit = pendingRef(fixture);
  assert.equal(fixture.remoteGit(["rev-parse", `refs/heads/${TARGET}`]), commit, "C was published");
  moveRemoteTarget(fixture, "another machine promotes on top of C");
  const rerun = await apply(fixture, PUBLISH);
  assert.equal(rerun.code, "promotion_up_to_date", rerun.message);
  assert.equal(pendingRef(fixture), "", "the stale pin is dropped");
  assert.notEqual(fixture.git(["for-each-ref", "--format=%(objectname)", REFS.receipt(commit)]), "", "C's receipt is kept: C shipped");
});

test("T-U10: a target checked out nowhere moves by a compare-and-swap; a compare-and-swap against a wrong old value is refused and moves nothing", async () => {
  const fixture = world("promotion-publish-cas", {}, { targetCheckout: false, remote: false });
  const built = committed(await apply(fixture));
  const git = configuredWorktreeGitPort(fixture.document);
  const target = fixture.tip(TARGET);
  const wrong = landCommit(git, fixture.root, TARGET, built.commit, fixture.tip(SOURCE), "", 30_000);
  assert.equal(wrong.landing, "update-ref");
  assert.notEqual(wrong.refusal, null);
  assert.equal(fixture.tip(TARGET), target, "nothing moved");
  const done = published(await apply(fixture, PUBLISH));
  assert.equal(done.landing, "update-ref");
  assert.equal(done.pushed, false, "a local-only pair publishes by the ref");
  assert.equal(fixture.tip(TARGET), built.commit);
});

test("T-U11: the candidate's pinned build outputs are installed into W (journaled, all at once); a changed lockfile names the stale setup (depsStale), never run; W's node_modules untouched", async () => {
  const fixture = world("promotion-publish-install", {}, { setupInputs: ["package-lock.json"] });
  fixture.commit(SOURCE, {
    "package.json": json({ ...SOURCE_MANIFEST, dependencies: { ...SOURCE_MANIFEST.dependencies, leftpad: "^1.0.0" } }),
    "package-lock.json": json({ ...SOURCE_LOCK, packages: { ...SOURCE_LOCK.packages, "node_modules/leftpad": { version: "1.0.0" } } }),
    "product/lib/helper.ts": 'import pad from "leftpad";\nexport const helper = pad;\n',
  }, "a new runtime dependency");
  mkdirSync(join(w(fixture), "node_modules"), { recursive: true });
  writeFileSync(join(w(fixture), "node_modules", "marker"), "installed by hand\n");
  const done = published(await apply(fixture, { ...PUBLISH, run: { buildOutputs: () => ["build/out.txt"] } }));
  assert.deepEqual(done.installed, ["build/out.txt"]);
  assert.equal(readFileSync(join(w(fixture), "build/out.txt"), "utf8"), "built\n");
  assert.deepEqual(done.targetCheckout.depsStale, ["setup"]);
  assert.equal(readFileSync(join(w(fixture), "node_modules", "marker"), "utf8"), "installed by hand\n");
  assert.equal(existsSync(join(w(fixture), ".bridlewise/state/journals/promotion-build-outputs.json")), false, "the transaction committed and cleaned up");
});

test("T-R2/T-R4: a dead holder's lock is reclaimed; two runs at once give exactly ONE new commit — the unattended one answers promotion_locked (exit 0), the next is up to date", async () => {
  const fixture = world("promotion-publish-locks");
  const locks = repositoryRegistryArea(repositoryRegistry(join(fixture.root, ".git")), "locks");
  // A holder that died with the lock taken (a crashed run).
  execFileSync(process.execPath, ["-e", `import(${JSON.stringify(new URL("../../../src/workflow/resource-lock.ts", import.meta.url).href)}).then(async ({ acquireLock }) => { await acquireLock(${JSON.stringify(fixture.root)}, "promotion-refs-heads-${TARGET}", { lockDirectory: ${JSON.stringify(locks)}, owner: "a crashed run" }); process.exit(0); })`]);
  const [first, second] = await Promise.all([
    apply(fixture, PUBLISH),
    new Promise((resolve) => setTimeout(resolve, 50)).then(() => apply(fixture, { request: { noPublish: false, auto: true } }).catch((error: unknown) => error)),
  ]);
  const done = published(first);
  assert.equal((second as { promotionCode?: string }).promotionCode, "promotion_locked");
  assert.equal(promotionExitCode("promotion_locked", true), 0);
  assert.equal(fixture.git(["rev-list", "--first-parent", "--count", `${done.commit}^1..${fixture.remoteGit(["rev-parse", `refs/heads/${TARGET}`])}`]), "1", "exactly one new commit on the target");
  assert.equal((await apply(fixture, PUBLISH)).code, "promotion_up_to_date");
  const held = await acquireLock(fixture.root, `promotion-refs-heads-${TARGET}`, { lockDirectory: locks, owner: "a live run" });
  try {
    const locked = await refused(fixture, "promotion_locked", { request: { noPublish: false, auto: true } });
    assert.match(locked.message, /timed out/u, "an unattended run never waits");
  } finally {
    held.release();
  }
});

/** What an unattended apply's entry did: its answer (or refusal), and the runs its chain launched — each with whether the target's lock was free at the launch. */
type Chained = Readonly<{ outcome: PromotionAnswer | PromotionError; launches: readonly Readonly<{ source: string; lockFree: boolean }>[] }>;

/** An unattended apply over the fixture through the entry's chain (`trigger.ts` `withUnattendedChain`), the launch a spy; `environment` the entry's (default: a top-level process's). */
async function unattended(fixture: PromotionFixture, options: Parameters<typeof apply>[1] = {}, environment: NodeJS.ProcessEnv = {}): Promise<Chained> {
  const contextOf = (profile: string, source: string) => resolvePromotionContext(fixture.root, profile, source, fixture.document);
  const locks = repositoryRegistryArea(repositoryRegistry(join(fixture.root, ".git")), "locks");
  const sources: string[] = [];
  const probes: Promise<boolean>[] = [];
  const launch = (_context: unknown, source: string): number => {
    sources.push(source);
    probes.push(acquireLock(fixture.root, `promotion-refs-heads-${TARGET}`, { lockDirectory: locks, owner: "the chain's probe", timeoutMs: 0 }).then((lock) => { lock.release(); return true; }, () => false));
    return 4242;
  };
  let outcome: PromotionAnswer | PromotionError;
  try {
    outcome = await withUnattendedChain(contextOf(PROFILE_NAME, SOURCE), configuredWorktreeGitPort(fixture.document), () => apply(fixture, { ...options, request: { noPublish: false, auto: true, ...options.request } }), contextOf, launch, environment);
  } catch (error) {
    assert.ok(error instanceof PromotionError, String(error));
    outcome = error;
  }
  const free = await Promise.all(probes);
  return { outcome, launches: sources.map((source, index) => ({ source, lockFree: free[index]! })) };
}

/** A commit on the remote's source made elsewhere (the local source branch does not move): an empty commit on the remote's tip. */
function pushSourceElsewhere(fixture: PromotionFixture, message: string): string {
  const tip = fixture.remoteGit(["rev-parse", `refs/heads/${SOURCE}`]);
  const moved = fixture.git(["commit-tree", `${tip}^{tree}`, "-p", tip, "-m", message]);
  fixture.git(["push", "-q", "origin", `${moved}:refs/heads/${SOURCE}`]);
  return moved;
}

const ON_PUSH = { trigger: "on-source-publish" } as const;

test("T-R5: the source advancing during an unattended run: S stays pinned, and the entry chains ONE more run for the new tip — after the run's lock is released", async () => {
  const fixture = world("promotion-publish-chain", ON_PUSH);
  fixture.publish(SOURCE);
  const source = fixture.tip(SOURCE);
  let next = "";
  const { outcome, launches } = await unattended(fixture, {
    run: {
      plan: (context) => {
        if (next === "") next = pushSourceElsewhere(fixture, "the source moves on");
        return fixture.plan({ source: context.source, target: context.target });
      },
    },
  });
  const done = published(outcome as PromotionAnswer);
  assert.equal(fixture.git(["log", "-1", "--format=%(trailers:key=Promoted-From,valueonly)", done.commit]), source, "S stayed pinned");
  assert.deepEqual(launches, [{ source: next, lockFree: true }], "one more run for the new tip, once the lock is free");
  assert.equal(((outcome as PromotionAnswer).data as { chained: { started: readonly unknown[] } }).chained.started.length, 1, "the answer says what it chained");
});

test("N2 (PROMO-3+4-FIX): latest wins — a source that reached the remote BEFORE the run's reconcile is chained; so is the fix pushed while the run FAILED; a run whose S is still the remote's chains nothing", async () => {
  const early = world("promotion-publish-chain-early", ON_PUSH);
  early.publish(SOURCE);
  const s2 = pushSourceElsewhere(early, "pushed before the reconcile");
  const first = await unattended(early);
  published(first.outcome as PromotionAnswer);
  assert.deepEqual(first.launches.map((entry) => entry.source), [s2], "the remote's newer source is chained, though the reconcile already saw it");
  const failing = world("promotion-publish-chain-failed", ON_PUSH);
  failing.publish(SOURCE);
  failing.mark("gate-mode", "exit1");
  const fix = { value: "" };
  const failed = await unattended(failing, {
    run: {
      plan: (context) => {
        if (fix.value === "") fix.value = pushSourceElsewhere(failing, "the fix");
        return failing.plan({ source: context.source, target: context.target });
      },
    },
  });
  assert.equal((failed.outcome as PromotionError).promotionCode, "promotion_gate_failed");
  assert.deepEqual(failed.launches.map((entry) => entry.source), [fix.value], "a failed run still chains the newer source");
  failing.git(["merge", "-q", "--ff-only", fix.value]);
  const again = await unattended(failing);
  assert.equal((again.outcome as PromotionError).promotionCode, "promotion_gate_failed");
  assert.deepEqual(again.launches, [], "S is the remote's: no chain (a failing source is never retried in a loop)");
});

test("H1 (PROMO-3+4-FIX): the promoter home's CHILD owes no chain (its descendants die with it under the supervisor): only a top-level process chains", async () => {
  const fixture = world("promotion-publish-chain-child", ON_PUSH);
  fixture.publish(SOURCE);
  const s2 = pushSourceElsewhere(fixture, "a newer source");
  const child = await unattended(fixture, {}, { [ROOT_POLICY.workflow.promotion.promoterHomeEnvironmentVariable]: engineRoot() });
  published(child.outcome as PromotionAnswer);
  assert.deepEqual(child.launches, [], "the child chains nothing");
  assert.equal(((child.outcome as PromotionAnswer).data as { chained?: unknown }).chained, undefined);
  const parent = await unattended(fixture);
  assert.equal((parent.outcome as PromotionAnswer).code, "promotion_up_to_date");
  assert.deepEqual(parent.launches.map((entry) => entry.source), [s2], "its top-level parent chains");
});

test("N2 (PROMO-3+4-FIX): a remote source the run's S already contains is never chained (a `--no-push` run of a local S ahead of the remote would otherwise launch the OLDER tip)", async () => {
  const fixture = world("promotion-publish-chain-contained", ON_PUSH);
  const remoteSource = fixture.remoteGit(["rev-parse", `refs/heads/${SOURCE}`]);
  assert.notEqual(remoteSource, fixture.tip(SOURCE), "the local source is ahead of the remote's");
  const local = await unattended(fixture, { request: { noPush: true } });
  assert.equal((local.outcome as PromotionAnswer).code, "promotion_published");
  assert.deepEqual(local.launches, [], "the remote's older tip is not chained");
});

test("N2 (PROMO-3+4-FIX): a held run and a run coalesced into a running one chain nothing (the holder chains)", async () => {
  const fixture = world("promotion-publish-chain-quiet", ON_PUSH);
  fixture.publish(SOURCE);
  pushSourceElsewhere(fixture, "a newer source");
  const locks = repositoryRegistryArea(repositoryRegistry(join(fixture.root, ".git")), "locks");
  const held = await acquireLock(fixture.root, `promotion-refs-heads-${TARGET}`, { lockDirectory: locks, owner: "a live run" });
  try {
    const coalesced = await unattended(fixture);
    assert.equal((coalesced.outcome as PromotionError).promotionCode, "promotion_locked");
    assert.deepEqual(coalesced.launches, []);
  } finally {
    held.release();
  }
  await holdPromotion(resolvePromotionContext(fixture.root, PROFILE_NAME, SOURCE, fixture.document), "a freeze", { git: configuredWorktreeGitPort(fixture.document) });
  const quiet = await unattended(fixture);
  assert.equal((quiet.outcome as PromotionError).promotionCode, "promotion_held");
  assert.deepEqual(quiet.launches, []);
});

test("H1 (PROMO-3+4-FIX): the unattended run's own environment never carries the promoter home's variable (a chained run finds its own promoter) and names its own log", () => {
  const { promoterHomeEnvironmentVariable, logEnvironmentVariable } = ROOT_POLICY.workflow.promotion;
  const own = unattendedEnvironment({ PATH: "/bin", [promoterHomeEnvironmentVariable]: "/home/app", [logEnvironmentVariable]: "/old.log" }, "/new.log");
  assert.deepEqual(own, { PATH: "/bin", [logEnvironmentVariable]: "/new.log" });
});

test("M1 (PROMO-3+4-FIX): `apply --no-publish` with the local target BEHIND its remote's builds on the remote's tip and moves nothing — the target ref, W and the local hold untouched", async () => {
  const fixture = world("promotion-publish-no-publish-behind");
  const remoteTip = moveRemoteTarget(fixture, "a promotion published from another machine");
  // A local hold the remote no longer has (released elsewhere): a read-only run never deletes it.
  writeFileSync(join(fixture.commandsDirectory, "stale-hold.json"), `${JSON.stringify({ reason: "released elsewhere since" })}\n`);
  const stale = fixture.git(["hash-object", "-w", join(fixture.commandsDirectory, "stale-hold.json")]);
  fixture.git(["update-ref", REFS.hold, stale]);
  const target = fixture.tip(TARGET);
  const before = fixture.git(["-C", w(fixture), "rev-parse", "HEAD"]);
  const built = committed(await apply(fixture));
  assert.equal(fixture.git(["rev-parse", `${built.commit}^1`]), remoteTip, "built on the remote's tip");
  assert.equal(fixture.tip(TARGET), target, "the local target ref did not move");
  assert.equal(fixture.git(["-C", w(fixture), "rev-parse", "HEAD"]), before, "W did not move");
  assert.equal(fixture.git(["rev-parse", REFS.hold]), stale, "the local hold is not deleted by a read-only run");
  const done = published(await apply(fixture, PUBLISH));
  assert.equal(done.commit, built.commit, "a publishing run resumes the pinned commit");
  assert.equal(fixture.git(["-C", w(fixture), "rev-parse", "HEAD"]), built.commit);
  assert.equal(fixture.git(["for-each-ref", "--format=%(refname)", REFS.hold]), "", "a publishing run synchronizes it: released remotely");
});

test("T-D1: a direct target edit is refused with a patch; the patch landed on the source is promoted with nothing to accept (the target's tree, recorded as the source's promotion), and a later source change to that same path is no target edit", async () => {
  const fixture = world("promotion-publish-edits", {}, { targetCheckout: false, remote: false });
  const hotfix = fixture.commit(TARGET, { "product/lib/helper.ts": "export const helper = 'fixed on the target';\n" }, "a hotfix on the target");
  const error = await refused(fixture, "promotion_target_edits");
  const patch = String(error.facts["targetEditsPatch"]);
  assert.ok(existsSync(patch), patch);
  assert.deepEqual(error.facts["targetEdits"], ["product/lib/helper.ts"]);
  fixture.git(["checkout", "-q", SOURCE]);
  fixture.git(["apply", "--index", patch]);
  fixture.git(["commit", "-q", "-m", "the target's hotfix landed on the source"]);
  // The source now reproduces the target: the promotion records it (the target's own tree), so the hotfix is no longer measured.
  const absorbed = published(await apply(fixture, PUBLISH));
  assert.equal(fixture.git(["show", `${absorbed.commit}:product/lib/helper.ts`]), "export const helper = 'fixed on the target';");
  assert.deepEqual(fixture.git(["diff", "--name-only", hotfix, absorbed.commit]).split("\n").filter((path) => path !== "" && !path.startsWith("gen/") && path !== "tool/policy.ts"), [], "the target's tree, its generated outputs regenerated aside");
  assert.equal(fixture.git(["rev-parse", `${absorbed.commit}^1`]), hotfix);
  assert.equal(fixture.git(["log", "-1", "--format=%(trailers:key=Promotion-Accepted-Target-Edits,valueonly)", absorbed.commit]), "", "nothing was accepted: the source carries it");
  assert.equal((await apply(fixture, PUBLISH)).code, "promotion_up_to_date");
  // The source keeps editing the hotfixed file: a source change, never the target's edit again.
  fixture.commit(SOURCE, { "product/lib/helper.ts": "export const helper = 'fixed, then improved on the source';\n", "product/pages/a.ts": "export const a = 2;\n" }, "the next product change");
  const done = published(await apply(fixture, PUBLISH));
  assert.equal(fixture.git(["show", `${done.commit}:product/lib/helper.ts`]), "export const helper = 'fixed, then improved on the source';");
  assert.equal(fixture.git(["log", "-1", "--format=%(trailers:key=Promotion-Accepted-Target-Edits,valueonly)", done.commit]), "");
});

test("T-D2: after a promotion, a raw merge of the source planted on the target (excluded paths now on it) is promotion_target_edits", async () => {
  const fixture = world("promotion-publish-raw-merge", {}, { targetCheckout: true, remote: false });
  published(await apply(fixture, PUBLISH));
  fixture.commit(SOURCE, { "dev/more.ts": "export const more = 1;\n" }, "more development");
  fixture.git(["-C", w(fixture), "merge", "-q", "--no-ff", "-m", "a raw merge", SOURCE]);
  const error = await refused(fixture, "promotion_target_edits");
  // The merge base is S (the promotion's second parent): what the raw merge brought is the source's work since, the excluded file included.
  assert.deepEqual(error.facts["targetEdits"], ["dev/more.ts"]);
});

test("T-D4: bootstrap (no promotion trailer yet): the target's README and ignore file changed since the merge base are listed exactly, accepted once; the second promotion needs nothing", async () => {
  const fixture = world("promotion-publish-bootstrap");
  fixture.commit(TARGET, { "README.md": "# the target's own README\n", ".gitignore": "node_modules/\nbuild/\n/local-only/\n" }, "hand-made files on the target");
  fixture.publish(TARGET);
  const refusal = await refused(fixture, "promotion_target_edits", PUBLISH);
  assert.deepEqual(refusal.facts["targetEdits"], [".gitignore", "README.md"]);
  const first = published(await apply(fixture, { request: { noPublish: false, acceptTargetEdits: [".gitignore", "README.md"], reason: "bootstrap: the target adopts the source's shared files" } }));
  assert.equal(fixture.git(["log", "-1", "--format=%(trailers:key=Promotion-Accepted-Target-Edits,valueonly)", first.commit]), ".gitignore, README.md");
  fixture.commit(SOURCE, { "product/lib/helper.ts": "export const helper = 10;\n" }, "the next product change");
  const second = published(await apply(fixture, PUBLISH));
  assert.equal(fixture.git(["rev-parse", `${second.commit}^1`]), first.commit);
});

test("T-G1: a full run from the source checkout while it is dirty and has 3 staged files leaves its index bytes and porcelain identical", async () => {
  const fixture = world("promotion-publish-dirty-source");
  writeFileSync(join(fixture.root, "product/pages/a.ts"), "export const a = 'unstaged';\n");
  for (const name of ["one", "two", "three"]) writeFileSync(join(fixture.root, `staged-${name}.txt`), `${name}\n`);
  fixture.git(["add", "staged-one.txt", "staged-two.txt", "staged-three.txt"]);
  const index = (): string => sha256(readFileSync(join(fixture.root, ".git", "index")));
  // GIT_OPTIONAL_LOCKS=0: this test's own status never refreshes the index it digests.
  const porcelain = (): string => fixture.git(["status", "--porcelain=v1", "--untracked-files=all"], { GIT_OPTIONAL_LOCKS: "0" });
  const before = { porcelain: porcelain(), index: index() };
  published(await apply(fixture, PUBLISH));
  assert.deepEqual({ porcelain: porcelain(), index: index() }, before);
});

test("T-G2: from the TARGET's checkout (no profile at its HEAD: found by its last promotion's trailer) and from a fresh detached worktree, the same pair and the same answers", async () => {
  const fixture = world("promotion-publish-anywhere");
  const first = published(await apply(fixture, PUBLISH));
  fixture.commit(SOURCE, { "product/lib/helper.ts": "export const helper = 11;\n" }, "another product change");
  const fromTarget = resolvePromotionContext(w(fixture), undefined, undefined, fixture.document);
  assert.equal(fromTarget.loaded.profile.name, PROFILE_NAME, "the profile its last promotion names");
  assert.equal(fromTarget.source, fixture.tip(SOURCE));
  const detached = join(fixture.workRoot, "detached");
  fixture.git(["worktree", "add", "-q", "--detach", detached, fixture.tip(SOURCE)]);
  const fromDetached = resolvePromotionContext(detached, undefined, undefined, fixture.document);
  assert.equal(fromDetached.source, fromTarget.source);
  assert.equal(fromDetached.loaded.blob, fromTarget.loaded.blob);
  const second = published(await apply(fixture, { ...PUBLISH, from: w(fixture) }));
  assert.equal(fixture.git(["rev-parse", `${second.commit}^1`]), first.commit);
  assert.equal((await apply(fixture, { ...PUBLISH, from: detached })).code, "promotion_up_to_date");
});

test("L1: the git operations a full promotion runs through the port (reconcile, build, publish, land, finish) stay within the landing's declared count, the one a ceiling over a whole run is derived from", async () => {
  const fixture = world("promotion-publish-git-count");
  const real = configuredWorktreeGitPort(documentOf(fixture, false));
  const calls: string[] = [];
  const counting = Object.fromEntries(Object.entries(real).map(([name, value]) => [
    name,
    typeof value === "function" ? (...args: unknown[]) => { calls.push(name); return (value as (...a: unknown[]) => unknown)(...args); } : value,
  ])) as WorktreeGitPort;
  const done = published(await apply(fixture, { ...PUBLISH, run: { git: counting } }));
  const passes = (JSON.parse(fixture.git(["cat-file", "blob", REFS.receipt(done.commit)])) as { convergence: { passes: number } }).convergence.passes;
  assert.ok(calls.length <= landingGitOperationCount(passes), `${String(calls.length)} git operations (${calls.join(", ")}) > the declared ${String(landingGitOperationCount(passes))}`);
});
