/**
 * THE BUILD-AND-COMMIT STAGE (`harness promote apply --no-publish`,
 * src/workflow/promotion/apply.ts over src/workflow/tree-landing.ts), on the
 * landing fixture (`dev` → `prod`): one test per failure mode of
 * merge-door-final §17.2 for the candidate, settle and commit phases
 * (T-C1..T-C10, T-K1..T-K4, T-G3) plus the pending ref's resume (and its
 * drop when T moved), the reasoned overrides, the lock, the short-circuits,
 * and the typed failures a port injects (a git step the machine ended, git's
 * own refusal, a candidate that does not hold P, a concurrent pin: the
 * integrity answers keep their candidate as the evidence). After every failing
 * build the invariant sweep (T-K2) holds: no checkout but the candidate has a
 * merge in progress, the invoking checkout's index and files are byte-
 * identical, no branch moved and no pending ref was written.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { WorktreeGitError, WorktreeGitTimeout, configuredWorktreeGitPort, type WorktreeGitPort } from "../../../src/git/worktree-port.ts";
import { isProcessAlive } from "../../../src/process/process-facts.ts";
import { acquireLock } from "../../../src/workflow/resource-lock.ts";
import { repositoryRegistry, repositoryRegistryArea } from "../../../src/workflow/repository-registry.ts";
import { promotionExitCode } from "../../../src/workflow/promotion/codes.ts";
import { HarnessError } from "../../../src/kernel/errors.ts";
import { DEFAULT_LOCK_TIMEOUT_MS } from "../../../src/workflow/workflow-config.ts";
import { applyCeilingMs } from "../../../src/workflow/promotion/apply.ts";
import { promotionRefs } from "../../../src/workflow/promotion/promotion-run.ts";
import { resolvePromotionContext, type PromotionDocument } from "../../../src/workflow/promotion/context.ts";
import { TEST_GIT_IDENTITY } from "../../support/test-git-identity.ts";
import { createTempDir } from "../../support/temp-dir.ts";
import { assertCancelledCheckoutFailure, runCancelledCheckoutScenario } from "../checkout-cancellation.ts";
import { FIXTURE_ENGINE, FIXTURE_GENERATED, PROFILE_NAME, PROFILE_PATH, SOURCE, TARGET, promotionFixture, type PromotionFixture } from "./promotion-fixture.ts";
import { apply, assertUntouched, candidates, committed, documentOf, folderOf, landing, receiptOf, refused, untouched, fixtureRun, type Committed } from "./apply-support.ts";


test("happy build: ONE commit with parents [T, S], the trailers, the settled tree, the hook run in the candidate; pending + receipt refs; nothing published", async () => {
  const fixture = landing("promotion-apply-happy");
  const before = untouched(fixture);
  const target = fixture.tip(TARGET);
  const source = fixture.tip(SOURCE);
  const built = committed(await apply(fixture));
  assert.deepEqual(built.parents, [target, source]);
  assert.equal(fixture.git(["rev-parse", `${built.commit}^1`]), target);
  assert.equal(fixture.git(["rev-parse", `${built.commit}^2`]), source);
  assert.equal(fixture.git(["rev-parse", `${built.commit}^{tree}`]), built.tree);
  const message = fixture.git(["log", "-1", "--format=%B", built.commit]);
  assert.match(message, /^promote\(dev-to-prod\): dev@[0-9a-f]{8} into prod\n/u);
  assert.match(message, /\n\+0 ~1 -0 \(derived: package\.json, package-lock\.json; regenerated: 1\)\n/u);
  assert.match(message, /a product change \([0-9a-f]{8}\)/u);
  assert.equal(fixture.git(["log", "-1", "--format=%(trailers:key=Projected-From,valueonly)", built.commit]), source);
  assert.equal(fixture.git(["log", "-1", "--format=%(trailers:key=Promotion-Profile,valueonly)", built.commit]), `${PROFILE_NAME}@${fixture.loaded().blob!}`);
  // The settled tree: P plus the regenerated output, the product change carried.
  assert.deepEqual(built.regenerated, ["gen/pin.txt"]);
  assert.equal(fixture.git(["show", `${built.commit}:product/lib/helper.ts`]), "export const helper = 3;");
  assert.match(fixture.git(["show", `${built.commit}:gen/pin.txt`]), /^[0-9a-f]{64}$/u);
  assert.equal(fixture.git(["ls-tree", "--name-only", built.commit, "dev"]), "", "an excluded folder never ships");
  // The repository's own pre-commit hook judged the exact tree, in the candidate.
  const hookRuns = (fixture.commandOutput("hook-runs") ?? "").trim().split("\n");
  assert.ok(hookRuns.some((line) => line.startsWith(join(folderOf(fixture), `${PROFILE_NAME}-`))), hookRuns.join("\n"));
  assert.equal(built.hookOutput, "the fixture commit guard certifies this tree", "what the hook said is answered");
  // Pinned and described; nothing published: the branches did not move.
  const refs = promotionRefs(PROFILE_NAME);
  assert.equal(fixture.git(["rev-parse", refs.pending]), built.commit);
  const receipt = receiptOf(fixture, built.commit);
  assert.equal(receipt["schema"], "bridlewise-promotion-receipt/v1");
  assert.equal(receipt["commit"], built.commit);
  assert.equal(receipt["publication"], "none");
  assert.deepEqual((receipt["convergence"] as { passes: number }).passes, 2);
  assert.equal(fixture.tip(TARGET), target);
  assert.equal(fixture.tip(SOURCE), source);
  assert.deepEqual({ ...untouched(fixture), refs: "" }, { ...before, refs: "" });
  assert.deepEqual(candidates(fixture), [], "a successful candidate is removed");
  assert.equal(fixture.git(["cat-file", "-t", built.commit]), "commit");
});

test("T-C1: setup runs in the candidate (its ignored build output made there) and the config document gets its required mode", async () => {
  const fixture = landing("promotion-apply-setup");
  const built = committed(await apply(fixture));
  const setupRuns = (fixture.commandOutput("setup-runs") ?? "").trim().split("\n");
  assert.equal(setupRuns.length, 1);
  assert.ok(setupRuns[0]!.startsWith(join(folderOf(fixture), `${PROFILE_NAME}-`)), setupRuns[0]);
  assert.ok(built.steps.some((step) => step.step === "config-mode" && step.status === "pass" && step.message === `0600 ${FIXTURE_ENGINE}/bridlewise.config.json`), JSON.stringify(built.steps));
  assert.ok(built.steps.some((step) => step.step === "setup" && step.status === "pass"));
  assert.equal(fixture.git(["ls-tree", "-r", "--name-only", built.commit, "build"]), "", "an ignored build output is never committed");
});

test("T-C2: converge stops at the pass that changes nothing (2 passes); an oscillating generator is promotion_not_converged naming the file", async () => {
  const fixture = landing("promotion-apply-converge");
  const before = untouched(fixture);
  fixture.mark("gen-oscillate");
  const error = await refused(fixture, "promotion_not_converged");
  assert.deepEqual(error.facts["paths"], ["gen/pin.txt"]);
  assert.match(error.message, /oscillate/u);
  assert.equal(error.facts["passes"], 3, "the first tree that recurs (pass 3: -1, -0, -1) stops it, at the bound (3) by the oscillation rule, never by the bound");
  assertUntouched(fixture, before);
  fixture.mark("gen-oscillate", null);
  const built = committed(await apply(fixture));
  assert.equal((receiptOf(fixture, built.commit)["convergence"] as { passes: number }).passes, 2);
});

test("T-C3: a source carrying a stale generated output is regenerated in the candidate and advised (source_generated_outputs_stale)", async () => {
  const fixture = landing("promotion-apply-stale");
  fixture.commit(SOURCE, { "gen/pin.txt": "stale\n" }, "a stale generated output");
  const built = committed(await apply(fixture));
  assert.match(fixture.git(["show", `${built.commit}:gen/pin.txt`]), /^[0-9a-f]{64}$/u);
  assert.ok(built.advisories.some((advisory) => advisory.kind === "source_generated_outputs_stale" && advisory.path === "gen/pin.txt"), JSON.stringify(built.advisories));
});

test("T-C4: a pin-bearing hand-authored file changed on the source keeps its authored change, and its pin is re-derived", async () => {
  const fixture = landing("promotion-apply-pin");
  fixture.commit(SOURCE, { "tool/policy.ts": 'export const PIN = "stale";\nexport const AUTHORED = "kept";\n' }, "an authored policy edit");
  const built = committed(await apply(fixture));
  const policy = fixture.git(["show", `${built.commit}:tool/policy.ts`]);
  assert.match(policy, /^export const PIN = "[0-9a-f]{64}";\nexport const AUTHORED = "kept";$/u);
  assert.equal(policy.match(/[0-9a-f]{64}/u)![0], fixture.git(["show", `${built.commit}:gen/pin.txt`]));
});

test("T-C5/T-C8: a gate that fails on the exact tree is promotion_gate_failed, never retried; the candidate is kept for inspection and the target untouched", async () => {
  const fixture = landing("promotion-apply-gate");
  const before = untouched(fixture);
  fixture.mark("gate-mode", "exit1");
  const error = await refused(fixture, "promotion_gate_failed", { preserve: true });
  assert.equal(error.facts["step"], "gate");
  assert.match(String(error.facts["tail"]), /gate: a real defect in the tree/u);
  assert.equal((fixture.commandOutput("gate-runs") ?? "").trim().split("\n").length, 1, "a failure is never re-run away");
  const kept = candidates(fixture);
  assert.equal(kept.length, 1);
  assert.equal(error.facts["candidate"], join(folderOf(fixture), kept[0]!));
  assertUntouched(fixture, before);
});

test("T-C6: a generator writing an undeclared tracked path, and a setup leaving an untracked file that is not ignored, are promotion_undeclared_write with the paths", async () => {
  const fixture = landing("promotion-apply-undeclared");
  const before = untouched(fixture);
  fixture.mark("gen-undeclared");
  const generated = await refused(fixture, "promotion_undeclared_write");
  assert.deepEqual(generated.facts["paths"], ["product/undeclared.txt"]);
  fixture.mark("gen-undeclared", null);
  fixture.mark("setup-untracked");
  const stray = await refused(fixture, "promotion_undeclared_write");
  assert.deepEqual(stray.facts["paths"], ["stray.txt"]);
  assertUntouched(fixture, before);
  assert.deepEqual(candidates(fixture), [], "without preserveOnFailure a failed candidate is removed");
});

test("N8 (PROMO-3+4-FIX): with NO generated output declared, a converge command's write is promotion_undeclared_write naming the path, never a misleading not_converged", async () => {
  const fixture = landing("promotion-apply-undeclared-none");
  fixture.commit(SOURCE, { "gen/pin.txt": "stale\n" }, "a stale pin");
  const error = await refused(fixture, "promotion_undeclared_write", { run: { generatedOutputs: () => new Set<string>() } });
  assert.deepEqual(error.facts["paths"], ["gen/pin.txt"]);
  assert.equal(error.facts["phase"], "converge");
});

test("T-C7: a gate that writes a tracked file is promotion_undeclared_write (a gate must not change the tree it judges)", async () => {
  const fixture = landing("promotion-apply-gate-write");
  const before = untouched(fixture);
  fixture.mark("gate-mode", "write");
  const error = await refused(fixture, "promotion_undeclared_write");
  assert.equal(error.facts["phase"], "verify");
  assert.deepEqual(error.facts["paths"], ["product/lib/helper.ts"]);
  assertUntouched(fixture, before);
});

test("T-C9: a first environmental error, native signal or cancellation is a terminal promotion error (exit 4)", async () => {
  for (const mode of ["enospc", "kill"]) {
    const fixture = landing(`promotion-apply-errored-${mode}`);
    const before = untouched(fixture);
    fixture.mark("gate-mode", mode);
    const waits: number[] = [];
    // Deliberately planted old runtime data: the retired policy cannot turn
    // the first failed native gate into two more physical attempts.
    const runner = { ...fixtureRun(fixture).runner, retries: { retries: 2, backoffMs: 7, sleep: async (ms: number) => { waits.push(ms); } } };
    const error = await refused(fixture, "promotion_gate_errored", { run: { runner } });
    assert.equal(promotionExitCode(error.promotionCode), 4);
    assert.deepEqual(waits, []);
    assert.equal((fixture.commandOutput("gate-runs") ?? "").trim().split("\n").length, 1, `${mode}: the first physical attempt is terminal`);
    assertUntouched(fixture, before);
  }
  for (const phase of ["setup", "gate"] as const) {
    const evidenceRoot = createTempDir(`promotion-apply-cancelled-${phase}-`);
    const cancelled = runCancelledCheckoutScenario(evidenceRoot, `
    const { default: assert } = await import("node:assert/strict");
      const { landing, refused, untouched, assertUntouched } = await import(${JSON.stringify(new URL("./apply-support.ts", import.meta.url).href)});
      const { promotionExitCode } = await import(${JSON.stringify(new URL("../../../src/workflow/promotion/codes.ts", import.meta.url).href)});
      const phase = ${JSON.stringify(phase)};
      const original = landing("promotion-apply-cancelled-" + phase);
      const commands = { ...original.commands, [phase]: command };
      const fixture = {
        ...original,
        commands,
        document: { ...original.document, workspaceIsolation: { ...original.document.workspaceIsolation, commands } },
      };
      const before = untouched(fixture);
      const expectedCode = phase === "setup" ? "promotion_setup_errored" : "promotion_gate_errored";
      const error = await refused(fixture, expectedCode, { run: { runner } });
      assertUntouched(fixture, before);
      return { code: error.promotionCode, exitCode: promotionExitCode(error.promotionCode), facts: error.facts };
    `) as Readonly<{ code: string; exitCode: number; facts: Readonly<Record<string, unknown>> }>;
    assert.equal(cancelled.code, phase === "setup" ? "promotion_setup_errored" : "promotion_gate_errored");
    assert.equal(cancelled.exitCode, 4);
    assertCancelledCheckoutFailure(cancelled.facts["commandFailure"], cancelled.facts["commandEvidence"]);
  }
});

test("T-C9/T-C10: a gate past its ceiling is ERRORED, and nothing it started survives (its child and its detached grandchild are gone)", async () => {
  const fixture = landing("promotion-apply-timeout", {}, { gateTimeoutMs: 1_500 });
  fixture.mark("gate-mode", "sleep");
  const error = await refused(fixture, "promotion_gate_errored");
  assert.match(error.message, /ceiling/u);
  const pids = (fixture.commandOutput("gate-pids") ?? "").trim().split(" ").map(Number);
  assert.equal(pids.length, 2);
  for (const pid of pids) {
    assert.equal(isProcessAlive(pid), false, `process ${String(pid)} outlived the gate`);
  }
});

test("T-K1: a pre-commit hook refusal is promotion_commit_refused with the hook's words; no checkout but the candidate has a merge in progress; the target and pending are untouched", async () => {
  const fixture = landing("promotion-apply-hook");
  const before = untouched(fixture);
  fixture.mark("refuse-commit");
  const error = await refused(fixture, "promotion_commit_refused", { preserve: true });
  assert.match(error.message, /the fixture commit guard refuses this tree/u);
  const kept = join(folderOf(fixture), candidates(fixture)[0]!);
  assert.equal(fixture.git(["-C", kept, "rev-parse", "MERGE_HEAD"]), fixture.tip(SOURCE), "the merge in progress is the candidate's alone");
  assertUntouched(fixture, before);
});

test("T-K3/T-K4: with NO git identity configured, the commit is S's committer at S's committer date, and two independent builds (another HOME with its own identity) give the SAME commit", async () => {
  const fixture = landing("promotion-apply-identity");
  assert.throws(() => fixture.git(["config", "user.name"]), "the fixture repository configures no identity");
  const source = fixture.tip(SOURCE);
  const first = committed(await apply(fixture));
  assert.equal(fixture.git(["log", "-1", "--format=%an <%ae>|%cn <%ce>", first.commit]), `${TEST_GIT_IDENTITY.name} <${TEST_GIT_IDENTITY.email}>|${TEST_GIT_IDENTITY.name} <${TEST_GIT_IDENTITY.email}>`);
  assert.equal(fixture.git(["log", "-1", "--format=%aI|%cI", first.commit]), `${fixture.git(["log", "-1", "--format=%cI", source])}|${fixture.git(["log", "-1", "--format=%cI", source])}`);
  // Drop the pin and the receipt, then rebuild in a fresh candidate under another HOME that names another identity.
  const refs = promotionRefs(PROFILE_NAME);
  const firstReceipt = fixture.git(["rev-parse", refs.receipt(first.commit)]);
  fixture.git(["update-ref", "-d", refs.pending]);
  fixture.git(["update-ref", "-d", refs.receipt(first.commit)]);
  const home = createTempDir("promotion-apply-home-");
  writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Someone Else\n\temail = else@example.invalid\n");
  const savedHome = process.env["HOME"];
  process.env["HOME"] = home;
  let second: Committed;
  try {
    second = committed(await apply(fixture));
  } finally {
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
  }
  assert.equal(second.commit, first.commit, "the same inputs give the same commit");
  // The receipt records each command's evidence (its duration and the load it met): the rest is the same.
  const withoutEvidence = (blob: string): unknown => {
    const receipt = JSON.parse(fixture.git(["cat-file", "blob", blob])) as { commands: readonly Record<string, unknown>[] };
    return { ...receipt, commands: receipt.commands.map(({ evidence: _evidence, ...step }) => step) };
  };
  assert.deepEqual(withoutEvidence(fixture.git(["rev-parse", refs.receipt(second.commit)])), withoutEvidence(firstReceipt));
  const evidence = (JSON.parse(fixture.git(["cat-file", "blob", firstReceipt])) as { commands: readonly { step: string; evidence?: { argv: readonly string[]; attempts: number; durationMs: number; load: number | null; parallelism: number } }[] }).commands.find((step) => step.step === "gate")!.evidence!;
  assert.equal(evidence.attempts, 1);
  // The load is the shared producer's raw one-minute leg or null when
  // unreadable; a negative number would be the defect, absence is not.
  assert.ok(evidence.argv.length > 0 && evidence.durationMs >= 0 && (evidence.load === null || evidence.load >= 0) && evidence.parallelism >= 1, JSON.stringify(evidence));
});

test("resume: a pending commit built for this S on this T is the answer (nothing rebuilt); a pending commit for an older source is dropped and rebuilt", async () => {
  const fixture = landing("promotion-apply-resume");
  const first = committed(await apply(fixture));
  const runs = fixture.commandOutput("gate-runs");
  const again = committed(await apply(fixture));
  assert.equal(again.commit, first.commit);
  assert.equal(again.resumed, true);
  assert.equal(fixture.commandOutput("gate-runs"), runs, "a resumed build runs no gate");
  fixture.commit(SOURCE, { "product/lib/helper.ts": "export const helper = 4;\n" }, "another product change");
  const rebuilt = committed(await apply(fixture));
  assert.notEqual(rebuilt.commit, first.commit);
  assert.equal(rebuilt.resumed, false);
  assert.equal(fixture.git(["rev-parse", promotionRefs(PROFILE_NAME).pending]), rebuilt.commit);
  assert.equal(fixture.git(["for-each-ref", "--format=%(refname)", promotionRefs(PROFILE_NAME).receipt(first.commit)]), "", "the dropped commit's receipt went with it (never published, now unreachable)");
});

test("PROMOFIX-L11 retention: under the lock, the lockfile memos and target-edit patches the latest plan did not use are removed; what it used is kept", async () => {
  const fixture = landing("promotion-apply-retention");
  committed(await apply(fixture));
  const area = join(repositoryRegistryArea(repositoryRegistry(join(fixture.root, ".git")), "promotion"), PROFILE_NAME);
  const used = readdirSync(join(area, "lockfiles"));
  assert.equal(used.length, 1, "the plan memoized its lockfile");
  const old = new Date("2001-01-01T00:00:00Z");
  for (const name of ["target-edits-old-old.patch", join("lockfiles", "0".repeat(64))]) {
    writeFileSync(join(area, name), "stale\n");
    utimesSync(join(area, name), old, old);
  }
  utimesSync(join(area, "lockfiles", used[0]!), old, old);
  fixture.commit(SOURCE, { "product/lib/helper.ts": "export const helper = 6;\n" }, "another product change");
  committed(await apply(fixture));
  assert.equal(existsSync(join(area, "target-edits-old-old.patch")), false);
  assert.deepEqual(readdirSync(join(area, "lockfiles")), used, "the memo the plan used again is kept (marked used); the unused one is gone");
});

test("the target's direct edits: refused; accepted ONLY with the plan's exact list and a reason (the trailer and the receipt record them)", async () => {
  const fixture = landing("promotion-apply-edits");
  fixture.commit(TARGET, { "README.md": "# edited on the target\n" }, "a direct target edit");
  const before = untouched(fixture);
  await refused(fixture, "promotion_target_edits");
  const wrong = await refused(fixture, "promotion_target_edits", { request: { acceptTargetEdits: ["README.md", "product/main.ts"], reason: "review" } });
  assert.match(wrong.message, /not edits product\/main\.ts/u);
  assertUntouched(fixture, before);
  const built = committed(await apply(fixture, { request: { acceptTargetEdits: ["README.md"], reason: "the target adopts the source's README" } }));
  assert.equal(fixture.git(["log", "-1", "--format=%(trailers:key=Promotion-Accepted-Target-Edits,valueonly)", built.commit]), "README.md");
  assert.deepEqual(receiptOf(fixture, built.commit)["acceptedTargetEdits"], { paths: ["README.md"], reason: "the target adopts the source's README" });
  assert.equal(fixture.git(["show", `${built.commit}:README.md`]), "# fixture product", "the source's bytes win");
});

test("the deletion budget: refused, then built with --allow-deletions and its reason recorded", async () => {
  const fixture = landing("promotion-apply-budget", { safety: { maxDeletedFraction: 0.05 } });
  fixture.commit(SOURCE, { "product/pages/a.ts": null, "assets/logo.png": null }, "deletions");
  await refused(fixture, "promotion_deletion_budget");
  const built = committed(await apply(fixture, { request: { allowDeletions: true, reason: "the assets moved" } }));
  assert.deepEqual(receiptOf(fixture, built.commit)["allowedDeletions"], { deleted: 2, reason: "the assets moved" });
});

test("short-circuits: an unchanged projection answers promotion_unchanged and creates no candidate", async () => {
  const fixture = promotionFixture("promotion-apply-unchanged", {}, { landing: true });
  const result = await apply(fixture);
  assert.equal(result.code, "promotion_unchanged");
  assert.deepEqual(candidates(fixture), []);
  assert.equal(fixture.commandOutput("setup-runs"), null, "nothing was set up");
});

test("the lock: a live holder of the target's lock refuses the run (promotion_locked) and is never broken", async () => {
  const fixture = landing("promotion-apply-lock");
  const registry = repositoryRegistry(join(fixture.root, ".git"));
  const held = await acquireLock(fixture.root, "promotion-refs-heads-prod", { lockDirectory: repositoryRegistryArea(registry, "locks"), owner: "another promotion" });
  try {
    await refused(fixture, "promotion_locked");
  } finally {
    held.release();
  }
  committed(await apply(fixture));
});

test("a failed candidate is kept only while preserveOnFailure, and the next run sweeps it (the newest is kept)", async () => {
  const fixture = landing("promotion-apply-sweep");
  fixture.mark("gate-mode", "exit1");
  await refused(fixture, "promotion_gate_failed", { preserve: true });
  assert.equal(candidates(fixture).length, 1);
  fixture.commit(SOURCE, { "product/lib/helper.ts": "export const helper = 5;\n" }, "a fix attempt");
  await refused(fixture, "promotion_gate_failed", { preserve: true });
  assert.equal(candidates(fixture).length, 1, "the older failed candidate was swept; the newest kept");
  fixture.mark("gate-mode", null);
  committed(await apply(fixture));
  assert.deepEqual(candidates(fixture), []);
});

test("T-G3: the commands honour TMPDIR, and nothing is written in the invoking checkout", async () => {
  const fixture = landing("promotion-apply-tmpdir");
  const before = untouched(fixture);
  fixture.mark("gate-mode", "tmpdir");
  committed(await apply(fixture));
  assert.equal(fixture.commandOutput("gate-tmpdir"), process.env["TMPDIR"] ?? "(unset)", "the candidate's commands see the promoter's temp folder");
  assert.deepEqual({ ...untouched(fixture), refs: "" }, { ...before, refs: "" });
});

test("apply (no remote, no checkout of the target) publishes by a compare-and-swap of the target ref, and finishes (pending gone)", async () => {
  const fixture = landing("promotion-apply-verb");
  const result = await apply(fixture, { request: { noPublish: false } });
  assert.equal(result.code, "promotion_published", result.message);
  const data = result.data as { commit: string; pushed: boolean; landing: string };
  assert.equal(data.pushed, false);
  assert.equal(data.landing, "update-ref");
  assert.equal(fixture.tip(TARGET), data.commit);
  assert.equal(fixture.git(["for-each-ref", "--format=%(refname)", promotionRefs(PROFILE_NAME).pending]), "");
  assert.deepEqual(candidates(fixture), [], "the finish removed the candidate");
});

test("a folder at the candidate's path that is not this repository's candidate (another checkout sharing the workspace root) is promotion_work_path_occupied, never overwritten", async () => {
  const fixture = landing("promotion-apply-foreign");
  const planId = (await fixture.plan()).planId;
  const foreign = join(folderOf(fixture), `${PROFILE_NAME}-${planId.slice(0, 8)}`);
  mkdirSync(foreign, { recursive: true });
  writeFileSync(join(foreign, "theirs.txt"), "another repository's candidate\n");
  const error = await refused(fixture, "promotion_work_path_occupied");
  assert.equal(error.facts["candidate"], foreign);
  assert.equal(readFileSync(join(foreign, "theirs.txt"), "utf8"), "another repository's candidate\n");
});

test("N5: a converge that never settles and never repeats (a new value every pass) is promotion_not_converged at its bound — one pass per generated output, plus the one that changes nothing (the one loop's bound)", async () => {
  const fixture = landing("promotion-apply-drift");
  const before = untouched(fixture);
  fixture.mark("gen-drift");
  const error = await refused(fixture, "promotion_not_converged");
  assert.equal(error.facts["passes"], FIXTURE_GENERATED.size + 1);
  assert.match(error.message, new RegExp(`did not converge in ${String(FIXTURE_GENERATED.size + 1)} passes`, "u"));
  assert.equal(fixture.commandOutput("gen-count"), String(FIXTURE_GENERATED.size + 1), "the generator ran exactly the bound's passes");
  assertUntouched(fixture, before);
});

test("N5: a setup command that fails on the projected tree is promotion_setup_failed (exit 5) naming the step and its tail; the candidate is swept", async () => {
  const fixture = landing("promotion-apply-setup-fail");
  const before = untouched(fixture);
  fixture.mark("setup-fail");
  const error = await refused(fixture, "promotion_setup_failed");
  assert.equal(promotionExitCode(error.promotionCode), 5);
  assert.equal(error.facts["step"], "setup");
  assert.match(String(error.facts["tail"]), /the build tool is broken/u);
  assert.deepEqual(candidates(fixture), []);
  assertUntouched(fixture, before);
});

test("N5: a pending commit the target already carries (published) is finished: its pin goes, its receipt stays (it describes a published commit); the next plan is up to date", async () => {
  const fixture = landing("promotion-apply-target-moved");
  const first = committed(await apply(fixture));
  // The target moves to the pending commit (as a publication by another run would).
  fixture.git(["update-ref", `refs/heads/${TARGET}`, first.commit]);
  const result = await apply(fixture, { request: { noPublish: false } });
  assert.equal(result.code, "promotion_published", result.message);
  assert.equal((result.data as { resumed: boolean }).resumed, true);
  assert.equal(fixture.git(["for-each-ref", "--format=%(refname)", promotionRefs(PROFILE_NAME).pending]), "", "the served pin is gone");
  assert.equal(fixture.git(["for-each-ref", "--format=%(refname)", promotionRefs(PROFILE_NAME).receipt(first.commit)]), promotionRefs(PROFILE_NAME).receipt(first.commit), "a published commit keeps its receipt");
  assert.equal((await apply(fixture)).code, "promotion_up_to_date");
});

test("N5: a pending commit built on an OLDER target tip (the target moved elsewhere) is dropped with its receipt, never answered as this run's", async () => {
  const fixture = landing("promotion-apply-target-elsewhere");
  const first = committed(await apply(fixture));
  fixture.commit(TARGET, {}, "the target moves on (an empty commit)");
  const rebuilt = committed(await apply(fixture));
  assert.notEqual(rebuilt.commit, first.commit);
  assert.equal(fixture.git(["for-each-ref", "--format=%(refname)", promotionRefs(PROFILE_NAME).receipt(first.commit)]), "", "the dropped commit's receipt went with it (never published, now unreachable)");
});

test("L2: a target that does not exist is promotion_target_missing (input), never a missing source", async () => {
  const fixture = landing("promotion-apply-no-target");
  fixture.git(["branch", "-D", TARGET]);
  const error = await refused(fixture, "promotion_target_missing");
  assert.equal(promotionExitCode(error.promotionCode), 2);
});

/** The fixture's port with `method` replaced: `fail(call)` answers the call's replacement result, or `undefined` to let the real port answer. */
function injected(fixture: PromotionFixture, method: keyof WorktreeGitPort, fail: (call: number, real: (...args: never[]) => unknown, args: never[]) => unknown): WorktreeGitPort {
  const real = configuredWorktreeGitPort(documentOf(fixture, false));
  let calls = 0;
  const original = real[method] as (...args: never[]) => unknown;
  return { ...real, [method]: (...args: never[]) => {
    calls += 1;
    const replaced = fail(calls, original, args);
    return replaced === undefined ? original(...args) : replaced;
  } } as WorktreeGitPort;
}

test("N4/H3: a git step the machine ended inside the landing is promotion_git_errored (exit 4): typed, swept, and nothing else touched", async () => {
  const fixture = landing("promotion-apply-git-timeout");
  const before = untouched(fixture);
  // The second staging (settle's first) reaches its ceiling.
  const git = injected(fixture, "stageAll", (call) => { if (call === 2) throw new WorktreeGitTimeout("add -A", 30_000); return undefined; });
  const error = await refused(fixture, "promotion_git_errored", { run: { git } });
  assert.equal(promotionExitCode(error.promotionCode), 4);
  assert.equal(error.facts["phase"], "settle");
  assert.deepEqual(candidates(fixture), [], "without preserveOnFailure an errored candidate is removed");
  assertUntouched(fixture, before);
  committed(await apply(fixture));
});

test("N4/M4: git's own refusal inside the landing is promotion_git_failed (integrity, exit 6), and an integrity answer KEEPS its candidate as the evidence even without preserveOnFailure", async () => {
  const fixture = landing("promotion-apply-git-refused");
  const before = untouched(fixture);
  const git = injected(fixture, "stageAll", (call) => {
    if (call === 2) throw new WorktreeGitError("add -A", "unexpected exit status 128", { status: 128, signal: null, timedOut: false, stdout: "", stderr: "fatal: unable to read tree" });
    return undefined;
  });
  const error = await refused(fixture, "promotion_git_failed", { run: { git } });
  assert.equal(promotionExitCode(error.promotionCode), 6);
  assert.match(String(error.facts["tail"]), /unable to read tree/u);
  const kept = candidates(fixture);
  assert.equal(kept.length, 1, "the integrity answer's candidate is kept");
  assert.equal(error.facts["candidate"], join(folderOf(fixture), kept[0]!));
  assertUntouched(fixture, before);
  committed(await apply(fixture));
  assert.deepEqual(candidates(fixture), [], "the next run sweeps the kept evidence once it builds");
});

test("M4/L5: a candidate that does not hold the computed tree is promotion_candidate_mismatch (integrity) and keeps its candidate", async () => {
  const fixture = landing("promotion-apply-mismatch");
  const git = injected(fixture, "stageAll", (call) => (call === 1 ? "0".repeat(40) : undefined));
  await refused(fixture, "promotion_candidate_mismatch", { run: { git } });
  assert.equal(candidates(fixture).length, 1);
});

test("M5/L11: a pending ref pinned by another run while this one held the lock is promotion_pending_conflict (integrity): the receipt this run created is removed, the candidate kept", async () => {
  const fixture = landing("promotion-apply-pin-conflict");
  const refs = promotionRefs(PROFILE_NAME);
  const git = injected(fixture, "createRef", (_call, _real, args) => ((args as unknown as string[])[1] === refs.pending ? { refusal: "another run's pin" } : undefined));
  const error = await refused(fixture, "promotion_pending_conflict", { run: { git } });
  assert.equal(promotionExitCode(error.promotionCode), 6);
  const commit = String(error.facts["commit"]);
  assert.equal(fixture.git(["for-each-ref", "--format=%(refname)", refs.receipt(commit)]), "", "no orphan receipt describes an unpinned commit");
  assert.equal(fixture.git(["for-each-ref", "--format=%(refname)", refs.pending]), "");
  assert.equal(candidates(fixture).length, 1, "the evidence is kept");
});

test("I-5: an error no code names inside the landing (a generator registry that throws) is promotion_unexpected (integrity, exit 6): typed, audited, its candidate kept", async () => {
  const fixture = landing("promotion-apply-unexpected");
  const before = untouched(fixture);
  const generatedOutputs = (): never => { throw new HarnessError("a declared source is missing from the working tree", "hash_binding_source_missing"); };
  const error = await refused(fixture, "promotion_unexpected", { run: { generatedOutputs } });
  assert.equal(promotionExitCode(error.promotionCode), 6);
  assert.equal(error.facts["kind"], "hash_binding_source_missing");
  assert.match(error.message, /missing from the working tree/u);
  assert.equal(candidates(fixture).length, 1, "kept as the evidence");
  assertUntouched(fixture, before);
});

test("I-5: a sweep that fails after a failed landing never replaces the landing's own answer", async () => {
  const fixture = landing("promotion-apply-sweep-fails");
  const timedOut = injected(fixture, "stageAll", (call) => { if (call === 2) throw new WorktreeGitTimeout("add -A", 30_000); return undefined; });
  // The sweep's own failure (git refusing the removal) would answer git_failed: the landing's git_errored stands.
  const git = { ...timedOut, worktreeRemove: () => { throw new WorktreeGitError("worktree remove", "unexpected exit status 128", { status: 128, signal: null, timedOut: false, stdout: "", stderr: "fatal: cannot remove" }); } } as WorktreeGitPort;
  await refused(fixture, "promotion_git_errored", { run: { git } });
});

test("N7: the derived ceiling counts the lock wait, command invocations per possible build and one converge pass per generated output", () => {
  const fixture = landing("promotion-apply-ceiling");
  const context = (document: PromotionDocument) => resolvePromotionContext(fixture.root, PROFILE_NAME, SOURCE, document);
  const declaredDocument = { ...fixture.document, resourceLock: { timeoutMs: 0, pollIntervalMs: 50, staleMs: 60_000 } };
  const declared = context(declaredDocument);
  const { resourceLock: _dropped, ...undeclaredDocument } = fixture.document;
  const undeclared = context(undeclaredDocument);
  assert.equal(applyCeilingMs(undeclared, 2) - applyCeilingMs(declared, 2), DEFAULT_LOCK_TIMEOUT_MS, "an undeclared lock section still waits the lock owner's default");
  const isolation = declaredDocument.workspaceIsolation!;
  const gate = isolation.commands["gate"]!;
  const shorter = context({ ...declaredDocument, workspaceIsolation: { ...isolation, commands: { ...isolation.commands, gate: { ...gate, timeoutMs: gate.timeoutMs - 1 } } } });
  assert.equal(applyCeilingMs(declared, 2) - applyCeilingMs(shorter, 2), 2, "one millisecond of gate ceiling counts once in each of the two possible builds, including a remote replan");
  const perPass = applyCeilingMs(declared, 3) - applyCeilingMs(declared, 2);
  const gen = fixture.commands["gen"]!.timeoutMs;
  assert.ok(perPass >= gen, `one more generated output adds a converge pass (${String(perPass)} >= ${String(gen)})`);
});


test("derived ceiling follows physical command occurrences across setup and verify, including a repeated phase entry", async () => {
  const fixture = landing("promotion-apply-ceiling-phase-occurrences", {
    phases: { setup: ["gate"], converge: ["gen"], verify: ["gate", "gate"] },
  });
  const built = committed(await apply(fixture));
  const gateSteps = built.steps.filter((step) => step.step === "gate");
  assert.equal(gateSteps.length, 3, "setup and verify each run their own list, including repeated direct entries");
  assert.equal((fixture.commandOutput("gate-runs") ?? "").trim().split("\n").length, gateSteps.length, "the native fixture command records each physical invocation");
  const document = documentOf(fixture, false);
  const context = resolvePromotionContext(fixture.root, PROFILE_NAME, SOURCE, document);
  const isolation = document.workspaceIsolation!;
  const gate = isolation.commands["gate"]!;
  const shorter = resolvePromotionContext(fixture.root, PROFILE_NAME, SOURCE, {
    ...document,
    workspaceIsolation: { ...isolation, commands: { ...isolation.commands, gate: { ...gate, timeoutMs: gate.timeoutMs - 1 } } },
  });
  assert.equal(applyCeilingMs(context, FIXTURE_GENERATED.size) - applyCeilingMs(shorter, FIXTURE_GENERATED.size), 2 * gateSteps.length, "each observed invocation has its ceiling in each possible build; names are not deduplicated across phases");
});

test("derived ceiling counts distinct lockfile transformations that use the same direct command", async () => {
  const fixture = landing("promotion-apply-ceiling-lockfile-occurrences");
  const profile = fixture.loaded().profile;
  const manifest = profile.transforms.find((transform) => transform.kind === "package-manifest");
  assert.ok(manifest?.kind === "package-manifest");
  const sourceManifest = JSON.parse(fixture.git(["show", `${fixture.tip(SOURCE)}:package.json`])) as Record<string, unknown>;
  const sourceLock = fixture.git(["show", `${fixture.tip(SOURCE)}:package-lock.json`]);
  fixture.commit(SOURCE, {
    [PROFILE_PATH]: `${JSON.stringify({
      ...profile,
      boundary: { ...profile.boundary, include: [...profile.boundary.include, "other/"] },
      transforms: [...profile.transforms,
        { ...manifest, path: "other/package.json" },
        { kind: "lockfile", path: "other/package-lock.json", manifest: "other/package.json", command: "lockfile" },
      ],
    }, null, 2)}\n`,
    "other/package.json": `${JSON.stringify({ ...sourceManifest, name: "other-fixture" })}\n`,
    "other/package-lock.json": sourceLock,
  }, "a second lockfile with distinct manifest inputs");
  const commands = {
    ...fixture.commands,
    lockfile: { ...fixture.commands["lockfile"]!, requires: ["lock-prerequisite"] },
    "lock-prerequisite": { cwd: ".", argv: [process.execPath, "-e", "throw new Error('current lockfile adapter does not execute prerequisites')"], timeoutMs: 60_000 },
  };
  // This binds the ceiling to the current direct adapter. The separate
  // REQUIRES obligation must update this control with its executor repair.
  // The explicit typed boundary below is not full harness/config admission.
  const plan = await fixture.plan({ commands });
  assert.deepEqual(plan.refusals, [], "both real lockfile derivations complete; their direct adapter did not run the prerequisite bait");
  const physicalInvocations = fixture.lockfileAttempts();
  assert.equal(physicalInvocations, 2, "distinct input digests cannot share the same command's memo");
  const document = { ...fixture.document, workspaceIsolation: { ...fixture.document.workspaceIsolation!, commands } };
  const context = resolvePromotionContext(fixture.root, PROFILE_NAME, SOURCE, document);
  const shorter = resolvePromotionContext(fixture.root, PROFILE_NAME, SOURCE, {
    ...document,
    workspaceIsolation: { ...document.workspaceIsolation, commands: { ...commands, lockfile: { ...commands.lockfile, timeoutMs: commands.lockfile.timeoutMs - 1 } } },
  });
  assert.equal(applyCeilingMs(context, FIXTURE_GENERATED.size) - applyCeilingMs(shorter, FIXTURE_GENERATED.size), 2 * physicalInvocations, "the ceiling counts each real lockfile invocation in each possible build");
  const shorterPrerequisite = resolvePromotionContext(fixture.root, PROFILE_NAME, SOURCE, {
    ...document,
    workspaceIsolation: { ...document.workspaceIsolation, commands: { ...commands, "lock-prerequisite": { ...commands["lock-prerequisite"], timeoutMs: commands["lock-prerequisite"].timeoutMs - 1 } } },
  });
  assert.equal(applyCeilingMs(context, FIXTURE_GENERATED.size), applyCeilingMs(shorterPrerequisite, FIXTURE_GENERATED.size), "an unexecuted lockfile prerequisite is not invented by the bound");
});
