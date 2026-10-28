/**
 * THE PROMOTER HOME (src/workflow/promotion/promoter-home.ts, T-K5): S's
 * committed code promotes S. Over the fixture repository, whose folder `tool`
 * stands for the engine (its entry `tool/promote.mjs` answers one promotion
 * envelope naming the code that ran): `apply` runs here only when this engine
 * already is S's — the variable names it, or its checkout is clean at S, or
 * the promoted repository does not host it — and otherwise re-executes in the
 * detached home worktree at S, under the home's lock, prepared with the setup
 * commands the engine's own inputs declare (re-run when those inputs changed
 * since the last source whose preparation PASSED). The REAL engine entry is
 * exercised too: spawned directly (both of its doors), and re-executed by
 * `runInPromoterHome` in a home whose engine folder is this engine.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import test, { before } from "node:test";

import { WorktreeGitError, WorktreeGitTimeout, configuredWorktreeGitPort, type WorktreeGitPort } from "../../../src/git/worktree-port.ts";
import { engineRoot } from "../../../src/kernel/engine-root.ts";
import { getConfigDocumentSchema } from "../../../src/kernel/config-contracts.ts";
import { workingTreeReader } from "../../../src/git/tree-reader.ts";
import { loadPromotionProfiles } from "../../../src/workflow/promotion/profile.ts";
import { classifyTree } from "../../../src/workflow/promotion/projection.ts";
import { ROOT_POLICY } from "../../../src/kernel/root-policy.ts";
import { acquireLock } from "../../../src/workflow/resource-lock.ts";
import { repositoryRegistry, repositoryRegistryArea } from "../../../src/workflow/repository-registry.ts";
import { PromotionError, promotionExitCode, type PromotionCode } from "../../../src/workflow/promotion/codes.ts";
import { resolvePromotionContext, type PromotionDocument } from "../../../src/workflow/promotion/context.ts";
import { engineCheckout, promoterHomeEnvironment, promoterPlacement, runInPromoterHome, type PromoterEngine, type PromoterPlacement } from "../../../src/workflow/promotion/promoter-home.ts";
import { unattendedEnvironment, withUnattendedChain } from "../../../src/workflow/promotion/trigger.ts";
import type { PromotionRequest } from "../../../src/workflow/promotion/promote-arguments.ts";
import { promotionFolder } from "../../../src/workflow/promotion/promotion-run.ts";
import { checkoutCommandEnvironment, runCheckoutCommand } from "../../../src/workflow/checkout-setup.ts";
import { createTempDir } from "../../support/temp-dir.ts";
import { ensureTestProcessSupervisor } from "../../../guardian/build.ts";
import { PROFILE_NAME, SOURCE, promotionFixture, type FixtureOptions, type PromotionFixture } from "./promotion-fixture.ts";

const VARIABLE = ROOT_POLICY.workflow.promotion.promoterHomeEnvironmentVariable;
const APPLY: PromotionRequest = { verb: "apply", noPublish: true };

/** The fake engine's entry: one envelope naming the HEAD it ran at, its argv, the variable and which copy of itself ran. */
function entry(copy: string): string {
  return [
    'import { execFileSync } from "node:child_process";',
    'const here = new URL(".", import.meta.url).pathname;',
    'const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: here, encoding: "utf8" }).trim();',
    `const result = { ok: true, code: "promotion_committed", class: "ok", message: "ran at " + head, remedy: "", data: { argv: process.argv.slice(2), home: process.env.${VARIABLE}, copy: ${JSON.stringify(copy)} } };`,
    "process.stdout.write(JSON.stringify({ result }) + \"\\n\");",
    "",
  ].join("\n");
}

const RUNNER = () => ({ supervisor: ensureTestProcessSupervisor(), killGraceMs: 500, outputCharacters: 4_000, retries: { retries: 0, backoffMs: 1 } });

/** A fixture whose `tool` folder is the engine, with a setup command the engine's inputs declare (failing while its marker exists) and one they do not; `options` as the fixture's (a remote, the trigger). */
function hostedFixture(prefix: string, overrides: Readonly<Record<string, unknown>> = {}, options: FixtureOptions = {}): Readonly<{ fixture: PromotionFixture; engine: PromoterEngine; document: PromotionDocument; setupRuns: () => readonly string[] }> {
  const fixture = promotionFixture(prefix, overrides, options);
  const counter = join(fixture.commandsDirectory, "tool-deps.mjs");
  writeFileSync(counter, [
    'import { appendFileSync, existsSync } from "node:fs";',
    `appendFileSync(${JSON.stringify(join(fixture.commandsDirectory, "tool-deps-runs"))}, process.cwd() + "\\n");`,
    `if (existsSync(${JSON.stringify(join(fixture.commandsDirectory, "tool-deps-fail"))})) { console.error("tool-deps: the engine's dependencies do not install"); process.exit(1); }`,
    "",
  ].join("\n"));
  const isolation = fixture.document.workspaceIsolation!;
  const document: PromotionDocument = {
    ...fixture.document,
    workspaceIsolation: {
      ...isolation,
      commands: {
        ...isolation.commands,
        "tool-deps": { cwd: "tool", argv: [process.execPath, counter], timeoutMs: 30_000, inputs: ["tool/package.json"] },
        "web-deps": { cwd: ".", argv: ["false"], timeoutMs: 30_000, inputs: ["package.json"] },
      },
      phases: { ...isolation.phases, setup: ["web-deps", "tool-deps"] },
    },
  };
  fixture.commit(SOURCE, { "tool/promote.mjs": entry("committed"), "tool/package.json": "{\"name\":\"tool\"}\n" }, "the engine");
  return {
    fixture,
    document,
    engine: { root: join(fixture.root, "tool"), entry: "promote.mjs", command: ["promote"] },
    setupRuns: () => (fixture.commandOutput("tool-deps-runs") ?? "").trim().split("\n").filter((line) => line.length > 0),
  };
}

/** The home placement of a dirty invoker over the hosted fixture. */
function homePlacement(fixture: PromotionFixture, engine: PromoterEngine, document: PromotionDocument) {
  writeFileSync(join(fixture.root, "tool/promote.mjs"), entry("dirty"));
  const git = configuredWorktreeGitPort(document);
  const context = resolvePromotionContext(fixture.root, PROFILE_NAME, SOURCE, document);
  const placement = promoterPlacement(context, git, engine, {});
  if (placement.kind !== "home") throw new Error(`expected the home: ${placement.reason}`);
  return { git, context, placement };
}

async function refusedWith(promise: Promise<unknown>, code: PromotionCode): Promise<PromotionError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof PromotionError, String(error));
    assert.equal(error.promotionCode, code, error.message);
    return error;
  }
  assert.fail(`did not refuse with ${code}`);
}

test("T-K5: here when this engine is S's (clean at S, or named by the variable); in the home otherwise — dirty, or at another commit", () => {
  const { fixture, engine, document } = hostedFixture("promotion-home-placement");
  const git = configuredWorktreeGitPort(document);
  const context = resolvePromotionContext(fixture.root, PROFILE_NAME, SOURCE, document);
  const clean = promoterPlacement(context, git, engine, {});
  assert.equal(clean.kind, "here", "the checkout is clean at S");
  assert.equal(clean.engineRelative, "tool", "a placement here names the engine's folder too (the candidate's config document lives there)");
  writeFileSync(join(fixture.root, "tool/promote.mjs"), entry("dirty"));
  const dirty = promoterPlacement(context, git, engine, {});
  assert.equal(dirty.kind, "home");
  assert.match(dirty.reason, /has changes/u);
  assert.equal(promoterPlacement(context, git, engine, { [VARIABLE]: join(fixture.root, "tool") }).kind, "here", "the re-executed child does not re-execute again");
  fixture.git(["add", "tool/promote.mjs"]);
  assert.equal(promoterPlacement(context, git, engine, {}).kind, "home", "a change staged only (its files equal to the index) is a change too");
  fixture.git(["checkout", "-q", "HEAD", "--", "tool/promote.mjs"]);
  const older = fixture.tip(SOURCE);
  fixture.commit(SOURCE, { "product/lib/helper.ts": "export const helper = 7;\n" }, "S moves on");
  fixture.git(["checkout", "-q", "--detach", older]);
  const elsewhere = promoterPlacement(resolvePromotionContext(fixture.root, PROFILE_NAME, SOURCE, document), git, engine, {});
  assert.equal(elsewhere.kind, "home");
  assert.match(elsewhere.reason, /not the source/u);
});

test("T-K5: an engine of ANOTHER repository runs here (the promoted repository does not host its promoter)", () => {
  const { fixture, document } = hostedFixture("promotion-home-foreign");
  const context = resolvePromotionContext(fixture.root, PROFILE_NAME, SOURCE, document);
  const placement = promoterPlacement(context, configuredWorktreeGitPort(document));
  assert.equal(placement.kind, "here");
  assert.match(placement.reason, /another repository/u);
});

test("T-K5: a dirty invoker re-executes S's COMMITTED promoter in the home at S (the request's own flags, --source S and the variable); the home follows S; the engine's own setup re-runs only when its inputs changed", async () => {
  const { fixture, engine, document, setupRuns } = hostedFixture("promotion-home-run");
  const run = async (request: PromotionRequest = APPLY) => {
    const { git, context, placement } = homePlacement(fixture, engine, document);
    const answer = await runInPromoterHome(context, git, placement, request, RUNNER(), engine);
    return { context, placement, answer };
  };
  const first = await run({ verb: "apply", noPublish: true, acceptTargetEdits: ["README.md", "package.json"], reason: "the target adopts them" });
  const home = join(promotionFolder(first.context), `${PROFILE_NAME}-home`);
  assert.equal(first.placement.home, home);
  // Structural, never a pattern built from a temporary path (a `+`, `(`, `[` or `$` in it is no regular expression: N4).
  assert.equal(dirname(dirname(home)), fixture.workRoot, "the home lives in the repository's own promotion folder (M5-NAMING)");
  assert.match(basename(dirname(home)), /^promote-[0-9a-f]{8}$/u);
  assert.equal(basename(home), `${PROFILE_NAME}-home`);
  assert.equal(first.answer.code, "promotion_committed");
  assert.equal(first.answer.message, `ran at ${first.context.source}`);
  const data = first.answer.data as { argv: string[]; home: string; copy: string; promoterHome: string };
  assert.equal(data.copy, "committed", "the source's committed promoter ran, never the invoker's dirty copy");
  assert.deepEqual(data.argv, ["promote", "apply", "--profile", PROFILE_NAME, "--source", first.context.source, "--no-publish", "--accept-target-edits", "README.md", "package.json", "--reason", "the target adopts them"], "the overrides and their reason reach S's promoter");
  assert.equal(data.home, join(home, "tool"));
  assert.equal(data.promoterHome, home);
  assert.deepEqual(setupRuns(), [join(home, "tool")], "a fresh home runs the engine's own setup, never another folder's");
  await run();
  assert.equal(setupRuns().length, 1, "an unchanged, prepared home re-runs nothing");
  fixture.git(["checkout", "-q", "--", "tool/promote.mjs"]);
  fixture.commit(SOURCE, { "tool/package.json": "{\"name\":\"tool\",\"version\":\"2\"}\n" }, "the engine's inputs change");
  const moved = await run();
  assert.equal(moved.answer.message, `ran at ${fixture.tip(SOURCE)}`, "the home follows S");
  assert.equal(fixture.git(["-C", home, "rev-parse", "HEAD"]), fixture.tip(SOURCE));
  assert.equal(setupRuns().length, 2, "a changed input re-runs its setup command");
});

test("H1 (PROMO-3+4-FIX): an unattended run placed in the home whose source moved meanwhile chains from the TOP-LEVEL process after the child exited and the home's lock is free — the new run at the new S, never inheriting the child's placement", async () => {
  const { fixture, engine, document } = hostedFixture("promotion-home-chain", { trigger: "on-source-publish" }, { remote: true });
  // S's committed promoter pushes a newer source while it runs (another writer's push), then answers a publication.
  fixture.commit(SOURCE, { "tool/promote.mjs": [
    'import { execFileSync } from "node:child_process";',
    'execFileSync("git", ["push", "-q", "origin", "refs/heads/next:refs/heads/' + SOURCE + '"]);',
    `process.stdout.write(JSON.stringify({ result: { ok: true, code: "promotion_published", class: "ok", message: "published", remedy: "", data: { home: process.env.${VARIABLE} } } }) + "\\n");`,
    "",
  ].join("\n") }, "S's promoter");
  fixture.publish(SOURCE);
  const source = fixture.tip(SOURCE);
  const next = fixture.git(["commit-tree", `${source}^{tree}`, "-p", source, "-m", "a newer source"]);
  fixture.git(["branch", "next", next]);
  const { git, context, placement } = homePlacement(fixture, engine, document);
  const locks = repositoryRegistryArea(repositoryRegistry(join(fixture.root, ".git")), "locks");
  const launched: { source: string; homeLockFree: Promise<boolean>; placement: PromoterPlacement }[] = [];
  const contextOf = (profile: string, at: string) => resolvePromotionContext(fixture.root, profile, at, document);
  const result = await withUnattendedChain(context, git, () => runInPromoterHome(context, git, placement, { verb: "apply", auto: true }, RUNNER(), engine), contextOf, (chained, at) => {
    launched.push({
      source: at,
      homeLockFree: acquireLock(fixture.root, `promotion-home-${PROFILE_NAME}`, { lockDirectory: locks, owner: "the chain's probe", timeoutMs: 0 }).then((lock) => { lock.release(); return true; }, () => false),
      // Where the chained run would run: its environment is a top-level run's (the child's placement variable dropped).
      placement: promoterPlacement(chained, git, engine, unattendedEnvironment({ [VARIABLE]: engine.root }, "/chained.log")),
    });
    return 4242;
  });
  assert.equal(result.code, "promotion_published", result.message);
  assert.equal((result.data as { home: string }).home, join(placement.home, "tool"), "the child ran in the home");
  assert.equal(launched.length, 1, "one more run");
  assert.equal(launched[0]!.source, next, "for the newer source");
  assert.equal(await launched[0]!.homeLockFree, true, "launched once the home's lock is released (the child is gone)");
  assert.equal(launched[0]!.placement.kind, "home", "the chained run finds its own promoter: the home at the new S, never `here` by an inherited variable");
  assert.equal(promoterPlacement(contextOf(PROFILE_NAME, next), git, engine, { [VARIABLE]: engine.root }).kind, "here", "(what an inherited variable naming the running engine would have done)");
});

test("H1 (PROMO-3+4-FIX): an unattended run never waits for the home's lock: a live holder coalesces it (promotion_locked) at once", async () => {
  const { fixture, engine, document } = hostedFixture("promotion-home-auto-lock");
  const { git, context, placement } = homePlacement(fixture, engine, document);
  const locks = repositoryRegistryArea(repositoryRegistry(join(fixture.root, ".git")), "locks");
  const held = await acquireLock(fixture.root, `promotion-home-${PROFILE_NAME}`, { lockDirectory: locks, owner: "a live promoter" });
  try {
    const locked = await refusedWith(runInPromoterHome(context, git, placement, { verb: "apply", auto: true }, RUNNER(), engine), "promotion_locked");
    assert.match(locked.message, /after 0ms/u, "no wait for the lock (a manual run waits resourceLock.timeoutMs)");
  } finally {
    held.release();
  }
});

test("N1: a home whose setup FAILED is prepared again by the next run at the same S (and after S moved), never run half-prepared", async () => {
  const { fixture, engine, document, setupRuns } = hostedFixture("promotion-home-retry");
  fixture.mark("tool-deps-fail");
  const first = homePlacement(fixture, engine, document);
  const failed = await refusedWith(runInPromoterHome(first.context, first.git, first.placement, APPLY, RUNNER(), engine), "promotion_home_setup_failed");
  assert.equal(failed.facts["step"], "tool-deps");
  assert.match(String(failed.facts["tail"]), /do not install/u);
  assert.equal(promotionExitCode(failed.promotionCode), 5);
  // Still broken at the same S: refused again, never answered by a half-prepared home.
  const again = homePlacement(fixture, engine, document);
  await refusedWith(runInPromoterHome(again.context, again.git, again.placement, APPLY, RUNNER(), engine), "promotion_home_setup_failed");
  assert.equal(setupRuns().length, 2, "the failed setup was re-run, not skipped because HEAD already was S");
  // S moves (a change outside the engine's inputs) while the setup is still broken: still re-run.
  fixture.git(["checkout", "-q", "--", "tool/promote.mjs"]);
  fixture.commit(SOURCE, { "product/lib/helper.ts": "export const helper = 8;\n" }, "S moves on");
  const moved = homePlacement(fixture, engine, document);
  await refusedWith(runInPromoterHome(moved.context, moved.git, moved.placement, APPLY, RUNNER(), engine), "promotion_home_setup_failed");
  assert.equal(setupRuns().length, 3);
  fixture.mark("tool-deps-fail", null);
  const fixed = homePlacement(fixture, engine, document);
  assert.equal((await runInPromoterHome(fixed.context, fixed.git, fixed.placement, APPLY, RUNNER(), engine)).code, "promotion_committed");
  assert.equal(setupRuns().length, 4, "the repaired setup ran before the child");
  const settled = homePlacement(fixture, engine, document);
  await runInPromoterHome(settled.context, settled.git, settled.placement, APPLY, RUNNER(), engine);
  assert.equal(setupRuns().length, 4, "once prepared, the same S re-runs nothing");
});

test("N2: the home is prepared and used under its lock: a live holder refuses the run (promotion_locked) and the home is never made or moved under it", async () => {
  const { fixture, engine, document } = hostedFixture("promotion-home-lock");
  const { git, context, placement } = homePlacement(fixture, engine, document);
  const held = await acquireLock(fixture.root, `promotion-home-${PROFILE_NAME}`, { lockDirectory: repositoryRegistryArea(repositoryRegistry(join(fixture.root, ".git")), "locks"), owner: "a running promotion" });
  try {
    await refusedWith(runInPromoterHome(context, git, placement, APPLY, RUNNER(), engine), "promotion_locked");
  } finally {
    held.release();
  }
  assert.equal(existsSync(placement.home), false, "nothing was prepared while another run held the home");
  assert.equal((await runInPromoterHome(context, git, placement, APPLY, RUNNER(), engine)).code, "promotion_committed");
});

test("a folder at the home's path that is not this repository's worktree is promotion_work_path_occupied, never overwritten", async () => {
  const { fixture, engine, document } = hostedFixture("promotion-home-occupied");
  const { git, context, placement } = homePlacement(fixture, engine, document);
  mkdirSync(placement.home, { recursive: true });
  writeFileSync(join(placement.home, "theirs.txt"), "another checkout's home\n");
  const error = await refusedWith(runInPromoterHome(context, git, placement, APPLY, RUNNER(), engine), "promotion_work_path_occupied");
  assert.equal(error.facts["home"], placement.home);
  assert.equal(promotionExitCode(error.promotionCode), 3);
});

test("T-K5: a child that answers no envelope is promotion_promoter_failed naming how it ended, never a crash and never blamed on the candidate's setup", async () => {
  const { fixture, engine, document } = hostedFixture("promotion-home-silent");
  fixture.commit(SOURCE, { "tool/promote.mjs": "process.exit(3);\n" }, "a promoter that answers nothing");
  const { git, context, placement } = homePlacement(fixture, engine, document);
  const error = await refusedWith(runInPromoterHome(context, git, placement, APPLY, RUNNER(), engine), "promotion_promoter_failed");
  assert.match(error.message, /answered no promotion envelope \(exit 3\)/u);
  assert.equal(promotionExitCode(error.promotionCode), 5);
});

test("T-K5: a child ended by a signal (or its ceiling) is promotion_promoter_errored (exit 4): the machine's, never blamed on the source", async () => {
  const { fixture, engine, document } = hostedFixture("promotion-home-killed");
  fixture.commit(SOURCE, { "tool/promote.mjs": "process.kill(process.pid, \"SIGKILL\");\n" }, "a promoter the machine kills");
  const { git, context, placement } = homePlacement(fixture, engine, document);
  const error = await refusedWith(runInPromoterHome(context, git, placement, APPLY, RUNNER(), engine), "promotion_promoter_errored");
  assert.equal(promotionExitCode(error.promotionCode), 4);
});

test("I-5: a failure of the home run that no code names (here: a runner the ceiling cannot be derived from) is promotion_unexpected, never an untyped exit", async () => {
  const { fixture, engine, document } = hostedFixture("promotion-home-unexpected");
  const prepared = homePlacement(fixture, engine, document);
  assert.equal((await runInPromoterHome(prepared.context, prepared.git, prepared.placement, APPLY, RUNNER(), engine)).code, "promotion_committed");
  const { retries: _retries, ...broken } = RUNNER();
  const again = homePlacement(fixture, engine, document);
  const error = await refusedWith(runInPromoterHome(again.context, again.git, again.placement, APPLY, broken as ReturnType<typeof RUNNER>, engine), "promotion_unexpected");
  assert.equal(error.facts["home"], again.placement.home);
});

test("M6: where the engine lives — git's answer that it is in no checkout is an installed engine (null); a git step the machine ended propagates, never a silent 'here'", () => {
  const answering = (toplevel: () => string): WorktreeGitPort => ({ toplevel } as unknown as WorktreeGitPort);
  assert.equal(engineCheckout(answering(() => { throw new WorktreeGitError("rev-parse", "unexpected exit status 128", { status: 128, signal: null, timedOut: false, stdout: "", stderr: "fatal: not a git repository (or any of the parent directories): .git" }); }), "/engine", 5), null);
  assert.throws(() => engineCheckout(answering(() => { throw new WorktreeGitTimeout("rev-parse", 5); }), "/engine", 5), WorktreeGitTimeout);
  assert.throws(() => engineCheckout(answering(() => { throw new WorktreeGitError("rev-parse", "unexpected exit status (signal)", { status: null, signal: "SIGKILL", timedOut: false, stdout: "", stderr: "" }); }), "/engine", 5), WorktreeGitError);
  const top = join(engineRoot(), "..");
  assert.deepEqual(engineCheckout(answering(() => top), join(top, "engine"), 5), { top, engineRelative: "engine" });
});

/**
 * What a promoter's engine holds: the paths under `engine/` and `shared/` (the
 * repository folder the engine imports from outside itself) that the product
 * profile PROJECTS from this checkout. The population is the one ownership
 * reader's (`workingTreeReader`, over `ownedFiles`), and the profile's own
 * classification decides what ships, so the engine under test is the engine
 * a promotion carries. It is never a second listing of its own.
 */
function promotedEnginePaths(top: string): readonly string[] {
  const document = getConfigDocumentSchema().parse(JSON.parse(readFileSync(join(engineRoot(), ROOT_POLICY.configuration.basename), "utf8")));
  const tree = workingTreeReader(top);
  const profiles = loadPromotionProfiles(tree, document.promotion!.profileDirectory, new Set(Object.keys(document.workspaceIsolation?.commands ?? {})));
  assert.ok(profiles.length > 0, "the checkout declares the product's profile");
  const projected = new Set(profiles.flatMap((loaded) => [...classifyTree(tree, loaded.profile).projected.keys()]));
  return [...projected].filter((path) => path.startsWith("engine/") || path.startsWith("shared/")).sort();
}

/**
 * A fixture whose source profile only names commands both registries declare
 * (the fixture's and this engine's own), and whose source HOLDS this engine
 * as a promotion carries it ({@link promotedEnginePaths}), committed at
 * `engine/` (and `shared/`), with its installed dependencies through a
 * committed `engine/node_modules` link (a promoter home installs them; the
 * link stands in). The engine answers for the repository it lives in
 * (`HARNESS_ROOT`, never the caller's working directory: #54), so the engine
 * under test must live in the fixture, as the promoter's does in production.
 * Built ONCE for this file (`before`): N3 only reads it, and T-K5's home is a
 * worktree of its own.
 */
function realEngineFixture(prefix: string): Readonly<{ fixture: PromotionFixture; document: PromotionDocument; engine: string }> {
  const fixture = promotionFixture(prefix, { phases: { setup: [], converge: [], verify: ["engine-check"] } });
  const isolation = fixture.document.workspaceIsolation!;
  const document: PromotionDocument = { ...fixture.document, workspaceIsolation: { ...isolation, commands: { ...isolation.commands, "engine-check": { cwd: ".", argv: ["true"], timeoutMs: 30_000 } } } };
  const engine = join(fixture.root, "engine");
  const top = dirname(engineRoot());
  for (const path of promotedEnginePaths(top)) {
    mkdirSync(dirname(join(fixture.root, path)), { recursive: true });
    copyFileSync(join(top, path), join(fixture.root, path));
  }
  symlinkSync(join(engineRoot(), "node_modules"), join(engine, "node_modules"));
  fixture.git(["checkout", "-q", SOURCE]);
  fixture.git(["add", "engine", "shared"]);
  fixture.git(["commit", "-q", "-m", "the engine"]);
  // A checkout gives the configuration its default mode; the engine refuses anything but its own (a home settles it the same way).
  chmodSync(join(engine, ROOT_POLICY.configuration.basename), Number.parseInt(ROOT_POLICY.configuration.requiredConfigFileMode, 8));
  return { fixture, document, engine };
}

let realEngine: ReturnType<typeof realEngineFixture>;
before(() => {
  realEngine = realEngineFixture("promotion-home-real");
});

/** The engine's two doors, spawned for real from the engine that lives in `engine`'s repository: each answers ONE envelope and exits with its class's code (N3: the command table run as the entry used to deadlock on its own top-level await, exit 13, no output). */
function spawnEntry(engine: string, script: string, args: readonly string[]): Readonly<{ status: number | null; code: string }> {
  const run = spawnSync(process.execPath, [join(engine, script), ...args], { cwd: engine, encoding: "utf8", timeout: 120_000, killSignal: "SIGKILL" });
  assert.equal(run.signal, null, `${script} ${args.join(" ")} was killed: ${run.stderr}`);
  const envelope = JSON.parse(run.stdout) as { result: { code: string } };
  return { status: run.status, code: envelope.result.code };
}

test("N3: the REAL entry — `src/cli.ts harness promote` and the command table run as its own entry — answers one envelope with its class's exit code", () => {
  const { fixture, engine } = realEngine;
  const source = fixture.tip(SOURCE);
  for (const [script, words] of [["src/cli.ts", ["harness", "promote"]], ["src/workflow/harness-commands.ts", ["promote"]]] as const) {
    const answered = spawnEntry(engine, script, [...words, "status", "--profile", PROFILE_NAME, "--source", source]);
    assert.equal(answered.code, "promotion_status", script);
    assert.equal(answered.status, 0, script);
    const refused = spawnEntry(engine, script, [...words, "status", "--source", "no-such-revision"]);
    assert.equal(refused.code, "promotion_source_missing", script);
    assert.equal(refused.status, promotionExitCode("promotion_source_missing"), script);
  }
});

test("N3/T-K5: runInPromoterHome re-executes the REAL engine entry in the home (a real engine folder of the same repository, as in production) and answers its envelope", async () => {
  const { fixture, document } = realEngine;
  const git = configuredWorktreeGitPort(document);
  const context = resolvePromotionContext(fixture.root, PROFILE_NAME, SOURCE, document);
  const placement: Extract<PromoterPlacement, { kind: "home" }> = { kind: "home", reason: "the real entry", home: join(fixture.workRoot, `promote-${PROFILE_NAME}-home`), engineRelative: "engine" };
  const answered = await runInPromoterHome(context, git, placement, { verb: "status" }, RUNNER());
  assert.equal(answered.code, "promotion_status", answered.message);
  const data = answered.data as { source: string; promoterHome: string };
  assert.equal(data.source, context.source, "the child answered for S, named with --source");
  assert.equal(data.promoterHome, placement.home);
});

/** Credentials a maintainer's or a job's process holds (planted for these tests only; none is real). */
const PLANTED: Readonly<Record<string, string>> = {
  BRIDLEWISE_PUBLISHER_TOKEN: "planted-publisher-token-value",
  GH_TOKEN: "planted-gh-token-value",
  GITHUB_TOKEN: "planted-github-token-value",
  OPENAI_API_KEY: "planted-provider-key-value",
  HARNESS_KEY_HOME: "/planted/key/home",
  NPM_TOKEN: "planted-npm-token-value",
  https_proxy: "http://proxyuser:planted-proxy-password@proxy.example:8080",
};

test("SECURITY: the home's child inherits no credential — the one projection (COMMAND_ENVIRONMENT), the proxy without its userinfo, and the variable naming it the home's child", () => {
  const environment = promoterHomeEnvironment({ PATH: "/usr/bin", HOME: "/srv/test-home", LANG: "C.UTF-8", ...PLANTED }, "/srv/promoter-engine");
  assert.deepEqual(Object.keys(environment).sort(), ["HOME", "LANG", "PATH", VARIABLE, "https_proxy"].sort());
  assert.equal(environment[VARIABLE], "/srv/promoter-engine");
  assert.ok(!JSON.stringify(environment).includes("planted-proxy-password") && !JSON.stringify(environment).includes("proxyuser"), "the proxy leaves without its userinfo");
});

test("SECURITY (planted): S's committed engine, run in the home, sees none of the credentials this process holds", async () => {
  const { fixture, engine, document } = hostedFixture("promotion-home-environment");
  // S's engine reports every variable it inherited.
  fixture.commit(SOURCE, { "tool/promote.mjs": [
    `const result = { ok: true, code: "promotion_committed", class: "ok", message: "inherited", remedy: "", data: { names: Object.keys(process.env).sort(), values: Object.values(process.env).join("\\n"), home: process.env.${VARIABLE} ?? null } };`,
    "process.stdout.write(JSON.stringify({ result }) + \"\\n\");",
    "",
  ].join("\n") }, "an engine that reports what it inherits");
  const saved = Object.fromEntries(Object.keys(PLANTED).map((name) => [name, process.env[name]]));
  Object.assign(process.env, PLANTED);
  try {
    const { git, context, placement } = homePlacement(fixture, engine, document);
    const answer = await runInPromoterHome(context, git, placement, APPLY, RUNNER(), engine);
    const seen = answer.data as { names: string[]; values: string; home: string | null };
    for (const name of Object.keys(PLANTED).filter((name) => name !== "https_proxy")) assert.ok(!seen.names.includes(name), `${name} never reaches S's engine`);
    for (const value of [...Object.values(PLANTED), "proxyuser"].filter((value) => !value.startsWith("http"))) assert.ok(!seen.values.includes(value), "no planted value reaches it, under any name");
    assert.ok(!seen.values.includes("planted-proxy-password"), "nor the proxy's password");
    assert.equal(seen.home, join(placement.home, placement.engineRelative), "it knows it is the home's child");
    assert.ok(seen.names.includes("PATH"));
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

/** A command (node) that writes every variable it inherited, name and value, to `report`. */
function envReporter(directory: string, report: string): string {
  const script = join(directory, "report-env.mjs");
  writeFileSync(script, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(report)}, JSON.stringify(process.env));\n`);
  return script;
}

function assertNothingPlanted(seen: Readonly<Record<string, string>>, where: string): void {
  for (const name of Object.keys(PLANTED).filter((name) => name !== "https_proxy")) assert.ok(!(name in seen), `${where}: ${name} never reaches it`);
  const values = Object.values(seen).join("\n");
  for (const value of Object.values(PLANTED).filter((value) => !value.startsWith("http"))) assert.ok(!values.includes(value), `${where}: no planted value, under any name`);
  assert.ok(!values.includes("planted-proxy-password") && !values.includes("proxyuser"), `${where}: nor the proxy's credentials`);
}

test("SECURITY: every checkout command's environment is the one projection, plus only the harness's credential-free coordination values", () => {
  const environment = checkoutCommandEnvironment({ PATH: "/usr/bin", HOME: "/srv/test-home", TMPDIR: "/var/tmp/run", ...PLANTED, HARNESS_INSTRUMENT_LOCK_TOKEN: "nonce-1", GIT_DIR: "/elsewhere/.git" }, "invocation-1");
  assert.deepEqual(Object.keys(environment).sort(), ["HARNESS_RUN_INVOCATION", "HOME", "PATH", "TMPDIR", "https_proxy"].sort());
  assert.equal(environment["TMPDIR"], "/var/tmp/run", "the operator's temp root stays");
  assert.equal(environment["HARNESS_INSTRUMENT_LOCK_TOKEN"], undefined, "no lock token passes: a run is borrowed from inside its scope, never by an environment value");
  assertNothingPlanted(environment, "the projection");
});

test("SECURITY (planted): a checkout command run by the ONE runner sees none of the credentials this process holds", async () => {
  const directory = createTempDir("checkout-command-env-");
  const report = join(directory, "env.json");
  const saved = Object.fromEntries(Object.keys(PLANTED).map((name) => [name, process.env[name]]));
  Object.assign(process.env, PLANTED);
  try {
    const step = await runCheckoutCommand(directory, "report-env", { cwd: ".", argv: [process.execPath, envReporter(directory, report)], timeoutMs: 30_000 }, RUNNER());
    assert.equal(step.status, "pass", step.message);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  assertNothingPlanted(JSON.parse(readFileSync(report, "utf8")) as Record<string, string>, "a checkout command");
});

test("SECURITY (planted): the promoter home's SETUP (S's engine dependencies, run in S's tree) sees none of the credentials this process holds", async () => {
  const { fixture, engine, document } = hostedFixture("promotion-home-setup-environment");
  const report = join(fixture.commandsDirectory, "setup-env.json");
  // The engine's dependency install, as S's tree runs it: it reports what it inherited.
  writeFileSync(join(fixture.commandsDirectory, "tool-deps.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(report)}, JSON.stringify(process.env));\n`);
  const saved = Object.fromEntries(Object.keys(PLANTED).map((name) => [name, process.env[name]]));
  Object.assign(process.env, PLANTED);
  try {
    const { git, context, placement } = homePlacement(fixture, engine, document);
    await runInPromoterHome(context, git, placement, APPLY, RUNNER(), engine);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  assertNothingPlanted(JSON.parse(readFileSync(report, "utf8")) as Record<string, string>, "the home's setup");
});
