/**
 * The one working-copy builder (`src/git/working-copy.ts`), the checkout setup
 * (`src/workflow/checkout-setup.ts`) and the `workspaceIsolation` setup
 * declaration they read, driven on planted repositories and on a mirror of
 * this checkout.
 *
 * The property the builder exists for: a copy answers every git question
 * the way the checkout it mirrors does — a copy without its own `.git` was
 * answered by the LIVE repository from an ignored directory, which switched
 * the conservation identity off without a word.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { pathToFileURL } from "node:url";

import { getConfigDocumentSchema } from "../../src/kernel/config.ts";
import { atomicWriteFile } from "../../src/filesystem/atomic-write.ts";
import { QUALIFICATION_INVOCATION_ENV, qualificationInvocation } from "../../src/shared/run-history.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { InputError } from "../../src/kernel/errors.ts";
import { createWorkingCopy, refreshWorkingCopy, snapshotWorkingTree, stageInCopy, workingCopyDifferences } from "../../src/git/working-copy.ts";
import { STATE_DIRECTORY_NAME } from "../../src/kernel/product-identity.ts";
import { checkoutCommandRunner, commandFailureClass, commandsRun, gateLogDirectory, owedSetup, prepareCheckout, rerunChangedSetup, runCheckoutCommand, runCheckoutPhase, unconsumedCommands, type CheckoutCommandRunner, type CommandRetryPolicy } from "../../src/workflow/checkout-setup.ts";
import { convergenceReport, convergeUntilStable } from "../../src/workflow/checkout-setup.ts";
import { ensureTestProcessSupervisor } from "../../guardian/build.ts";
import { createRepositoryWorkingCopy, removeRepositoryLocalTemporaryDirectory, TEST_REPOSITORY_ROOT } from "../support/repository-local-temporary.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { ownedTemporaryName } from "../../src/filesystem/private-state.ts";
import { configureDebugSystem, createCollectingSink, resetDebugSystem } from "../../src/shared/debug/debug-system.ts";
import { DEBUG_CONFIG_DEFAULTS } from "../../src/shared/debug/debug-config.ts";
import { SUBPROCESS_BOUNDS } from "../../src/workflow/workflow-config.ts";

function git(cwd: string, ...argv: string[]): string {
  return execFileSync("git", ["-c", "user.name=Working Copy Test", "-c", "user.email=wc.invalid@example.invalid", ...argv], {
    cwd, encoding: "utf8", maxBuffer: 1 << 26,
  });
}

/** Untracked, not-ignored paths, as `git status` reports them. */
function untracked(root: string): readonly string[] {
  return git(root, "status", "--porcelain", "--untracked-files=all").split("\n").filter((line) => line.startsWith("?? "));
}

function fileSha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function objectCount(repository: string): number {
  const objects = join(repository, ".git", "objects");
  return readdirSync(objects).filter((entry) => /^[0-9a-f]{2}$/u.test(entry))
    .reduce((total, entry) => total + readdirSync(join(objects, entry)).length, 0);
}

/** A dirty source: a staged add, an unstaged edit, a deletion, an untracked file, an ignored file. */
function plantDirtySource(): string {
  const root = createTempDir("working-copy-source-");
  git(root, "init", "-q", "--initial-branch=main");
  writeFileSync(join(root, ".gitignore"), "/build/\n");
  mkdirSync(join(root, "lib"), { recursive: true });
  writeFileSync(join(root, "lib", "kept.ts"), "export const kept = 1;\n");
  writeFileSync(join(root, "lib", "edited.ts"), "export const edited = 1;\n");
  writeFileSync(join(root, "lib", "deleted.ts"), "export const deleted = 1;\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  writeFileSync(join(root, "lib", "staged.ts"), "export const staged = 1;\n");
  git(root, "add", "lib/staged.ts");
  writeFileSync(join(root, "lib", "edited.ts"), "export const edited = 2;\n");
  rmSync(join(root, "lib", "deleted.ts"));
  writeFileSync(join(root, "lib", "untracked.ts"), "export const untracked = 1;\n");
  mkdirSync(join(root, "build"), { recursive: true });
  writeFileSync(join(root, "build", "out.js"), "ignored\n");
  return root;
}

test("working copy (mirror): its own git answers tracked, staged and untracked exactly as the source", () => {
  const source = plantDirtySource();
  const target = join(createTempDir("working-copy-target-"), "copy");
  const copy = createWorkingCopy({ sourceRoot: source, targetRoot: target, git: "mirror" });
  assert.equal(git(target, "rev-parse", "--show-toplevel").trim(), target);
  assert.equal(copy.head, git(source, "rev-parse", "HEAD").trim());
  assert.equal(git(target, "symbolic-ref", "HEAD").trim(), "refs/heads/main");
  assert.equal(git(target, "status", "--porcelain"), git(source, "status", "--porcelain"));
  assert.deepEqual(copy.paths.toSorted(), [".gitignore", "lib/edited.ts", "lib/kept.ts", "lib/staged.ts", "lib/untracked.ts"]);
  assert.equal(lstatSync(join(target, "build"), { throwIfNoEntry: false }), undefined, "an ignored path is never carried unless named");
});

test("working copy (stage-all): the copy's own index stages the whole dirty tree; the source is never written", () => {
  const source = plantDirtySource();
  const indexBefore = fileSha(join(source, ".git", "index"));
  const objectsBefore = objectCount(source);
  const target = join(createTempDir("working-copy-target-"), "copy");
  createWorkingCopy({ sourceRoot: source, targetRoot: target, git: "stage-all" });
  assert.equal(git(target, "diff", "--name-only"), "", "nothing is left unstaged in the copy");
  assert.deepEqual(untracked(target), [], "nothing is left untracked in the copy");
  assert.equal(git(target, "diff", "--cached", "--name-status").trim().split("\n").toSorted().join("\n"),
    ["D\tlib/deleted.ts", "M\tlib/edited.ts", "A\tlib/staged.ts", "A\tlib/untracked.ts"].toSorted().join("\n"));
  assert.equal(fileSha(join(source, ".git", "index")), indexBefore, "the source index is byte-identical");
  assert.equal(objectCount(source), objectsBefore, "new objects land in the copy's own object store");
  assert.throws(() => createWorkingCopy({ sourceRoot: source, targetRoot: target, git: "stage-all" }), { code: "working_copy_target_not_empty" });
});

test("working copy (narrowed mirror): paths left out are skip-worktree, never a mass deletion", () => {
  const source = plantDirtySource();
  const target = join(createTempDir("working-copy-target-"), "copy");
  createWorkingCopy({ sourceRoot: source, targetRoot: target, git: "mirror", include: (path) => path !== "lib/kept.ts" });
  assert.equal(lstatSync(join(target, "lib", "kept.ts"), { throwIfNoEntry: false }), undefined);
  assert.equal(git(target, "status", "--porcelain"), git(source, "status", "--porcelain"));
  assert.ok(git(target, "ls-files").split("\n").includes("lib/kept.ts"), "the tracked set is still the source's");
});

test("working copy: differences and refresh follow the source's later edits", () => {
  const source = plantDirtySource();
  const target = join(createTempDir("working-copy-target-"), "copy");
  createWorkingCopy({ sourceRoot: source, targetRoot: target, git: "stage-all" });
  assert.deepEqual(workingCopyDifferences(source, target), []);
  writeFileSync(join(source, "lib", "kept.ts"), "export const kept = 3;\n");
  writeFileSync(join(source, "lib", "new.ts"), "export const fresh = 1;\n");
  rmSync(join(source, "lib", "untracked.ts"));
  assert.deepEqual(refreshWorkingCopy(source, target), [
    { path: "lib/kept.ts", state: "changed" },
    { path: "lib/new.ts", state: "only-in-source" },
    { path: "lib/untracked.ts", state: "only-in-copy" },
  ]);
  assert.deepEqual(workingCopyDifferences(source, target), []);
  assert.equal(git(target, "diff", "--name-only"), "");
  assert.deepEqual(untracked(target), []);
});

/** The production runner: every command under the native supervisor (no retry unless a test asks for one). */
/**
 * Every gate-log folder this file's runs make (under TMPDIR, outside the temp
 * folders the runs use), removed when its tests end: housekeeping, so a run
 * leaves no folder behind (round 13 item 18).
 */
const GATE_LOG_FOLDERS = new Set<string>();
test.after(() => {
  for (const folder of GATE_LOG_FOLDERS) rmSync(folder, { recursive: true, force: true });
});

/** Remembers `root`'s gate-log folder for removal when the file ends. */
function trackGateLogs(root: string): void {
  GATE_LOG_FOLDERS.add(gateLogDirectory(root));
}

/** A temp folder a gate command runs in, its gate logs tracked. */
function gateRoot(prefix: string): string {
  const root = createTempDir(prefix);
  trackGateLogs(root);
  return root;
}

function supervisedRunner(retries: CommandRetryPolicy = { retries: 0, backoffMs: 0 }): CheckoutCommandRunner {
  return { supervisor: ensureTestProcessSupervisor(), killGraceMs: 1_000, outputCharacters: 4_096, retries };
}

test("checkout setup: links, the config mode, then the declared commands in order; after the first failure the rest are skipped", async () => {
  const source = plantDirtySource();
  mkdirSync(join(source, "corpus"), { recursive: true });
  const target = join(createTempDir("working-copy-target-"), "copy");
  createWorkingCopy({ sourceRoot: source, targetRoot: target, git: "stage-all" });
  trackGateLogs(target);
  mkdirSync(join(target, "engine"), { recursive: true });
  // A fresh checkout's config: git gives it 0644 (planted through the atomic writer, then opened up).
  const configPath = join(target, "engine", ROOT_POLICY.configuration.basename);
  assert.equal(atomicWriteFile(configPath, "{}\n").success, true);
  chmodSync(configPath, 0o644);
  const steps = await prepareCheckout(target, source, "engine", {
    links: ["corpus"],
    commands: {
      marker: { cwd: ".", argv: [process.execPath, "-e", "require('node:fs').writeFileSync('marker', 'ran')"], timeoutMs: 60_000, inputs: [] },
      broken: { cwd: ".", argv: [process.execPath, "-e", "process.exit(3)"], timeoutMs: 60_000, inputs: [] },
      never: { cwd: ".", argv: [process.execPath, "-e", "require('node:fs').writeFileSync('never', 'ran')"], timeoutMs: 60_000, inputs: [] },
    },
    phases: { setup: ["marker", "broken", "never"], validate: [], regenerate: [], merge: [] },
  }, checkoutCommandRunner(target, supervisedRunner()));
  assert.deepEqual(steps.map((step) => [step.step, step.status]), [
    ["link corpus", "pass"], ["config-mode", "pass"], ["marker", "pass"], ["broken", "fail"], ["never", "skip"],
  ]);
  assert.match(steps[3]!.message, /exited 3/u);
  assert.equal(readlinkSync(join(target, "corpus")), join(source, "corpus"));
  assert.equal(statSync(join(target, "engine", ROOT_POLICY.configuration.basename)).mode & 0o777,
    Number.parseInt(ROOT_POLICY.configuration.requiredConfigFileMode, 8));
  assert.equal(readFileSync(join(target, "marker"), "utf8"), "ran");
  assert.equal(lstatSync(join(target, "never"), { throwIfNoEntry: false }), undefined);
});

test("checkout setup refuses a declared link whose target is a regular file, naming the path", async () => {
  // The declared link was assumed to already be a symlink. A regular file at
  // the target escaped `readlinkSync` as a raw EINVAL, so the operator got a
  // syscall error with no path and no remedy. The setup reads the actual
  // type first and refuses with a typed error naming the file it will not
  // replace.
  const source = plantDirtySource();
  mkdirSync(join(source, "corpus"), { recursive: true });
  const target = join(createTempDir("working-copy-target-"), "copy");
  createWorkingCopy({ sourceRoot: source, targetRoot: target, git: "stage-all" });
  trackGateLogs(target);
  const conflict = join(target, "corpus");
  mkdirSync(join(target, "engine"), { recursive: true });
  writeFileSync(conflict, "a regular file the setup must not overwrite\n");
  await assert.rejects(
    () => prepareCheckout(target, source, "engine", {
      links: ["corpus"],
      commands: {},
      phases: { setup: [], validate: [], regenerate: [], merge: [] },
    }, checkoutCommandRunner(target, supervisedRunner())),
    (error: unknown) => {
      const typed = error as { code?: unknown; message?: unknown };
      return typed.code === "checkout_link_target_conflict" &&
        typeof typed.message === "string" &&
        typed.message.includes(conflict) &&
        typed.message.includes("regular file");
    },
  );
  assert.equal(readFileSync(conflict, "utf8"), "a regular file the setup must not overwrite\n");
});

// FR-15 / NF-08: a fresh checkout must reproduce every generated value from
// its sources, so a first sync pass that rewrites a tracked output is a NAMED
// finding (the source was not synced, or a generated value depends on
// history), and "converged on the first pass" is stated, not inferred.
test("sync convergence: a first pass that rewrote tracked outputs is a named finding; a current source converges on the first pass", () => {
  const current = convergenceReport([[]]);
  assert.deepEqual(current, { passes: 1, changedByPass: [[]], convergedOnFirstPass: true, findings: [] });
  const stale = convergenceReport([["engine/src/kernel/root-policy.ts"], []]);
  assert.equal(stale.passes, 2);
  assert.equal(stale.convergedOnFirstPass, false);
  assert.deepEqual(stale.findings, [{ code: "source_generated_outputs_stale", paths: ["engine/src/kernel/root-policy.ts"] }]);
  assert.equal(Object.isFrozen(stale.findings[0]!.paths), true);
});

const SYNC = { subject: "harness sync", code: "harness_sync_not_converged" };

test("sync fixed point: passes repeat until one changes nothing (its status decides), a red pass that changed outputs is followed, and an oscillation is refused by name", async () => {
  const states = ["a", "b", "b"];
  let pass = 0;
  const converging = await convergeUntilStable(async () => { pass += 1; return { allPassed: true, pass }; }, () => new Map([["out.json", states[Math.min(pass, 2)]!]]), 5, SYNC);
  assert.equal(converging.output.pass, 2);
  assert.deepEqual(converging.convergence.changedByPass, [["out.json"], []]);
  let redPass = 0;
  const redThenGreen = await convergeUntilStable(async () => { redPass += 1; return { allPassed: redPass > 1 }; }, () => new Map([["out.json", redPass === 0 ? "old" : "new"]]), 5, SYNC);
  assert.equal(redThenGreen.output.allPassed, true, "a red pass that changed outputs is followed: the next pass judges the re-derived tree");
  assert.equal(redThenGreen.convergence.passes, 2);
  const stuckRed = await convergeUntilStable(async () => ({ allPassed: false }), () => new Map([["out.json", "same"]]), 5, SYNC);
  assert.equal(stuckRed.output.allPassed, false, "a red pass that changed nothing is a real red, returned as it is");
  assert.equal(stuckRed.convergence.passes, 1);
  let flip = 0;
  await assert.rejects(() => convergeUntilStable(async () => { flip += 1; return { allPassed: true }; }, () => new Map([["out.json", String(flip % 2)], ["steady.json", "x"]]), 121, SYNC),
    (error: unknown) => (error as { code?: unknown }).code === "harness_sync_not_converged" && /oscillates.*: out\.json$/u.test(String((error as Error).message)));
  assert.equal(flip, 2, "an oscillation is refused the pass it repeats a state, whatever the bound (production: one per output, ~121)");
  let drift = 0;
  await assert.rejects(() => convergeUntilStable(async () => { drift += 1; return { allPassed: true }; }, () => new Map([["out.json", String(drift)]]), 4, SYNC),
    (error: unknown) => (error as { code?: unknown }).code === "harness_sync_not_converged");
  assert.equal(drift, 4, "a generator that never repeats a state stops at the structural bound");
});

test("the command runner: a command past its ceiling is killed with every descendant and fails", async () => {
  const root = gateRoot("checkout-command-ceiling-");
  const sleeper = { cwd: ".", argv: [process.execPath, "-e", "setTimeout(() => {}, 60_000)"], timeoutMs: 300 };
  const outcome = await runCheckoutCommand(root, "sleeper", sleeper, supervisedRunner());
  assert.equal(outcome.status, "fail");
  // The ceiling ended it, not the command (which would exit 0 after 60 s):
  // the outcome names the ceiling, its path, never a wall clock (NO-LOAD-BLOCK).
  assert.match(outcome.message, /ceiling/u);
});

test("the command runner's classes: the environment's ending (a ceiling, a signal, no receipt, a REPORTED environmental error) is ERRORED; any other non-zero exit FAILED", async () => {
  assert.equal(commandFailureClass("ceiling", ""), "errored");
  assert.equal(commandFailureClass("signal", ""), "errored");
  assert.equal(commandFailureClass("unverified", ""), "errored");
  for (const code of ROOT_POLICY.workflow.commandRunner.environmentalErrorCodes) {
    assert.equal(commandFailureClass("exited", `added 3 packages\nnpm error code ${code}\nnpm error A complete log`), "errored", code);
    assert.equal(commandFailureClass("exited", `npm ERR! errno ${code}`), "errored", code);
    assert.equal(commandFailureClass("exited", `node:fs:1\nError: ${code}: the system said so, write`), "errored", code);
    // M3: a line that merely MENTIONS a code (a test named after it, an assertion quoting it) is a real failure.
    assert.equal(commandFailureClass("exited", `✖ the writer refuses on ${code} (12ms)\n  error: 'expected ${code} to be retried'\nnot ok 3 - handles ${code}`), "failed", code);
  }
  assert.equal(commandFailureClass("exited", "cp: error writing 'x': No space left on device"), "errored");
  assert.equal(commandFailureClass("exited", "TS2551: Property 'x' does not exist"), "failed");
  const root = gateRoot("checkout-command-classes-");
  const failing = await runCheckoutCommand(root, "failing", { cwd: ".", argv: [process.execPath, "-e", "process.exit(3)"], timeoutMs: 30_000 }, supervisedRunner());
  assert.equal(failing.failure, "failed");
  const ceiling = await runCheckoutCommand(root, "sleeper", { cwd: ".", argv: [process.execPath, "-e", "setTimeout(() => {}, 60_000)"], timeoutMs: 300 }, supervisedRunner());
  assert.equal(ceiling.failure, "errored");
  const passing = await runCheckoutCommand(root, "passing", { cwd: ".", argv: ["true"], timeoutMs: 30_000 }, supervisedRunner());
  assert.equal("failure" in passing, false, "only a failed step carries a class");
});

test("the command runner's retries: an errored run is retried with a doubling backoff and stops at the first success; a failed run is never retried", async () => {
  const root = gateRoot("checkout-command-retries-");
  // Errors (npm reporting a network reset) until its third attempt.
  const flaky = { cwd: ".", ledger: "web" as const, argv: [process.execPath, "-e", `const fs=require('node:fs');const n=Number(fs.existsSync('n')?fs.readFileSync('n','utf8'):0)+1;fs.writeFileSync('n',String(n));fs.appendFileSync('invocations',String(process.env[${JSON.stringify(QUALIFICATION_INVOCATION_ENV)}])+'\\n');if(n<3){console.error('npm error code ECONNRESET');process.exit(1)}`], timeoutMs: 30_000 };
  const waits: number[] = [];
  const recovered = await runCheckoutCommand(root, "flaky", flaky, supervisedRunner({ retries: 3, backoffMs: 5, sleep: async (ms) => { waits.push(ms); } }));
  assert.equal(recovered.status, "pass");
  assert.deepEqual(waits, [5, 10]);
  assert.equal(readFileSync(join(root, "n"), "utf8"), "3");
  const invocations = readFileSync(join(root, "invocations"), "utf8").trim().split("\n");
  assert.equal(invocations.length, 3);
  assert.equal(new Set(invocations).size, 3, "each physical retry gets a new private correlation token");
  for (const invocation of invocations) assert.equal(qualificationInvocation({ [QUALIFICATION_INVOCATION_ENV]: invocation }), invocation);
  assert.equal(recovered.evidence?.invocationId, invocations.at(-1), "only the final actual attempt supplies current evidence");
  assert.equal(recovered.evidence?.terminal?.ending, "exited");
  assert.equal(recovered.evidence?.terminal?.outputComplete, true);
  assert.equal(recovered.evidence?.terminal?.supervision?.noOwnedChildren, true);
  assert.deepEqual(recovered.evidence?.terminal?.supervision?.killed, []);
  const failing = { cwd: ".", argv: [process.execPath, "-e", "const fs=require('node:fs');fs.appendFileSync('f','x');process.exit(2)"], timeoutMs: 30_000 };
  const failed = await runCheckoutCommand(root, "failing", failing, supervisedRunner({ retries: 3, backoffMs: 5, sleep: async () => { assert.fail("a failure is never retried"); } }));
  assert.equal(failed.failure, "failed");
  assert.equal(readFileSync(join(root, "f"), "utf8"), "x");
});

test("M4: the runner logs every attempt once (its class, ending, exit, duration, load) and every retry wait, through the central logger", async (t) => {
  resetDebugSystem();
  t.after(resetDebugSystem);
  const sink = createCollectingSink();
  configureDebugSystem({ ...DEBUG_CONFIG_DEFAULTS, enabled: true, level: "info", categories: ["workflow"], sinks: { enabledSinks: ["collecting"] } }, [sink]);
  const root = gateRoot("checkout-command-logged-");
  const flaky = { cwd: ".", argv: [process.execPath, "-e", "const fs=require('node:fs');if(!fs.existsSync('n')){fs.writeFileSync('n','1');console.error('npm error code EAI_AGAIN');process.exit(1)}"], timeoutMs: 30_000 };
  await runCheckoutCommand(root, "flaky", flaky, supervisedRunner({ retries: 1, backoffMs: 3, sleep: async () => undefined }));
  const events = sink.events.filter((event) => event.category === "workflow").map((event) => [event.level, event.message, (event.context as { attempt?: number; class?: string }).attempt, (event.context as { class?: string }).class]);
  assert.deepEqual(events, [["warn", "flaky errored", 1, "errored"], ["warn", "flaky errored; retrying after 3ms", 1, undefined], ["info", "flaky passed", 2, "pass"]]);
  for (const event of sink.events.filter((entry) => entry.message.endsWith("passed") || entry.message.endsWith("errored"))) {
    for (const key of ["command", "ending", "exit", "durationMs", "load"]) assert.ok(key in (event.context as object), `${event.message} carries ${key}`);
  }
});

test("V18: a run its ceiling ended is ERRORED and retried; the last attempt's answer names how many ran", async () => {
  const root = gateRoot("checkout-command-ceiling-retry-");
  // Hangs past its ceiling on the first attempt, passes on the second.
  const slowOnce = { cwd: ".", argv: [process.execPath, "-e", "const fs=require('node:fs');if(!fs.existsSync('ran')){fs.writeFileSync('ran','1');setTimeout(()=>{},60_000)}"], timeoutMs: 400 };
  const waits: number[] = [];
  const recovered = await runCheckoutCommand(root, "slow-once", slowOnce, supervisedRunner({ retries: 1, backoffMs: 7, sleep: async (ms) => { waits.push(ms); } }));
  assert.equal(recovered.status, "pass");
  assert.deepEqual(waits, [7]);
  const hangs = { cwd: ".", argv: [process.execPath, "-e", "setTimeout(()=>{},60_000)"], timeoutMs: 300 };
  const exhausted = await runCheckoutCommand(root, "hangs", hangs, supervisedRunner({ retries: 1, backoffMs: 1, sleep: async () => undefined }));
  assert.equal(exhausted.failure, "errored");
  assert.match(exhausted.message, /attempt 2 of 2/u);
});

test("H3: a WORKSPACE phase's command rides out an errored run through the one runner's policy", async () => {
  const root = gateRoot("checkout-phase-retry-");
  const install = { cwd: ".", argv: [process.execPath, "-e", "const fs=require('node:fs');if(!fs.existsSync('tried')){fs.writeFileSync('tried','1');console.error('npm error code ENOTCACHED');process.exit(1)}"], timeoutMs: 30_000 };
  const isolation = { commands: { "web-deps": install }, phases: { setup: ["web-deps"], validate: [], regenerate: [], merge: [] } };
  const steps = await runCheckoutPhase(isolation, "setup", checkoutCommandRunner(root, supervisedRunner({ retries: 2, backoffMs: 1, sleep: async () => undefined })));
  assert.deepEqual(steps.map((entry) => [entry.step, entry.status]), [["web-deps", "pass"]]);
  const without = await runCheckoutPhase(isolation, "setup", checkoutCommandRunner(gateRoot("checkout-phase-no-retry-"), supervisedRunner()));
  assert.deepEqual(without.map((entry) => [entry.step, entry.status, entry.failure]), [["web-deps", "fail", "errored"]], "with no retry the same run fails, errored");
});

test("checkout setup re-run: only the commands whose declared inputs changed run again, in order", async () => {
  const target = gateRoot("working-copy-rerun-");
  const writer = (name: string) => [process.execPath, "-e", `require('node:fs').appendFileSync('ran', '${name}\\n')`];
  const isolation = {
    links: [],
    commands: {
      deps: { cwd: ".", argv: writer("deps"), timeoutMs: 60_000, inputs: ["package-lock.json"] },
      native: { cwd: ".", argv: writer("native"), timeoutMs: 60_000, inputs: ["engine/guardian"] },
      bundle: { cwd: ".", argv: writer("bundle"), timeoutMs: 60_000, inputs: [] },
    },
    phases: { setup: ["deps", "native", "bundle"], validate: [], regenerate: [], merge: [] },
  };
  const run = checkoutCommandRunner(target, supervisedRunner());
  assert.deepEqual(await rerunChangedSetup(isolation, ["lib/a.ts"], run), []);
  assert.deepEqual((await rerunChangedSetup(isolation, ["engine/guardian/src/guardian.c", "package-lock.json"], run)).map((step) => step.step), ["deps", "native"]);
  assert.deepEqual(await rerunChangedSetup(isolation, ["engine/guardian-other.c"], run), [], "a directory input is a path prefix, not a string prefix");
  assert.equal(readFileSync(join(target, "ran"), "utf8"), "deps\nnative\n");
});

test("checkout setup re-run: a command OWED (failed, or skipped after a failure, at its last attempt) runs again whatever its inputs say, until it succeeds (PROMO2FIX-N8)", async () => {
  const target = gateRoot("working-copy-owed-");
  const flag = join(target, "native-fails");
  writeFileSync(flag, "");
  const writer = (name: string) => [process.execPath, "-e", `const fs = require('node:fs'); if ('${name}' === 'native' && fs.existsSync('native-fails')) process.exit(3); fs.appendFileSync('ran', '${name}\\n')`];
  const isolation = {
    links: [],
    commands: {
      deps: { cwd: ".", argv: writer("deps"), timeoutMs: 60_000, inputs: ["package-lock.json"] },
      native: { cwd: ".", argv: writer("native"), timeoutMs: 60_000, inputs: ["engine/guardian"] },
      bundle: { cwd: ".", argv: writer("bundle"), timeoutMs: 60_000 },
    },
    phases: { setup: ["deps", "native", "bundle"], validate: [], regenerate: [], merge: [] },
  };
  const run = checkoutCommandRunner(target, supervisedRunner());
  const created = await runCheckoutPhase(isolation, "setup", run);
  const owed = owedSetup(isolation, created);
  assert.deepEqual(owed, ["native", "bundle"], "the failed step and the one skipped after it are owed");
  unlinkSync(flag);
  // Nothing an input names changed: only the owed steps run, in order.
  const rerun = await rerunChangedSetup(isolation, ["lib/a.ts"], run, undefined, new Set(owed));
  assert.deepEqual(rerun.map((step) => [step.step, step.status]), [["native", "pass"], ["bundle", "pass"]]);
  assert.deepEqual(owedSetup(isolation, rerun, new Set(owed)), [], "a success clears what it owed");
  assert.deepEqual(owedSetup(isolation, [], new Set(["bundle"])), ["bundle"], "a step not run stays owed");
  assert.equal(readFileSync(join(target, "ran"), "utf8"), "deps\nnative\nbundle\n");
});

test("a command's WHOLE output is kept OUTSIDE the checkout, redacted: the step carries the bounded tail and names the full log, which holds the failure the tail dropped and never a credential, even one split across two writes", async () => {
  const target = gateRoot("working-copy-full-log-");
  // A synthetic key made at run time (never a literal in a tracked file), written in two parts with a pause between (its last 8 characters alone),
  // so they arrive as separate chunks: a per-chunk redaction would keep that tail, which alone reads as no key.
  const key = `sk-${"ant-api03-"}${randomBytes(30).toString("base64url")}`;
  const [head, rest] = [key.slice(0, -8), key.slice(-8)];
  // process.exitCode, never process.exit: an exit drops stdout still queued on a pipe, and the fixture would lose its own lines.
  const script = `console.log('FIRST FAILURE: the line a tail would drop'); process.stdout.write('ANTHROPIC_API_KEY=${head}'); setTimeout(() => { process.stdout.write('${rest}\\n'); for (let i = 0; i < 2000; i++) console.log('filler line ' + i); console.error('ANTHROPIC_API_KEY=${key}'); process.exitCode = 1; }, 200)`;
  const [step] = await runCheckoutPhase({ commands: { noisy: { cwd: ".", argv: [process.execPath, "-e", script], timeoutMs: 60_000 } }, phases: { setup: ["noisy"], validate: [], regenerate: [], merge: [] } }, "setup", checkoutCommandRunner(target, supervisedRunner()));
  assert.equal(step!.status, "fail");
  assert.ok(!step!.details.join("\n").includes("FIRST FAILURE"), "the fixture's tail should not reach the first line");
  const named = step!.details.find((detail) => detail.startsWith("full output ("));
  assert.ok(named !== undefined, "the step names its full log");
  const path = named.slice(named.indexOf("): ") + 3);
  assert.ok(path.startsWith(`${gateLogDirectory(target)}/`), path);
  assert.ok(!path.startsWith(`${realpathSync(target)}/`), `the log lies outside the checkout: ${path}`);
  assert.ok(!existsSync(join(target, STATE_DIRECTORY_NAME)), "the gate wrote nothing into the checkout");
  const log = readFileSync(path, "utf8");
  assert.ok(log.includes("FIRST FAILURE: the line a tail would drop"), "the full log holds the line the tail dropped");
  // Every line, unless the streams outlived the exit's grace — and then the step says the log is incomplete.
  assert.ok(log.includes("filler line 1999") || named.includes("INCOMPLETE"), named);
  for (const kept of [log, step!.details.join("\n")]) {
    assert.ok(!kept.includes(rest) && !kept.includes(key), "no credential reaches the log or the tail (D-09)");
  }
  assert.match(log, /\[REDACTED:credential\]/u, "the key is redacted in place, never the log withheld (UR-21)");
});

test("the gate log redacts across chunk boundaries: a line of nearly 64 KiB reaches the redaction WHOLE (`password=`, `password: `, `password = ` and a JSON password field each kept with its value), and a character split across two writes is kept whole", async () => {
  const forms = [
    { key: " db password=", tail: " ok", redacted: / db \[REDACTED:credential\] ok\n/u },
    { key: " db password: ", tail: " ok", redacted: / db \[REDACTED:credential\] ok\n/u },
    { key: " db password = ", tail: " ok", redacted: / db \[REDACTED:credential\] ok\n/u },
    { key: ' {"password": "', tail: '"}', redacted: / \{"password": "\[REDACTED:credential\]"\}\n/u },
  ];
  for (const form of forms) {
    const target = gateRoot("working-copy-long-line-");
    // A synthetic password made at run time, `&`-free and ending in a letter (REDACT-AMPERSAND-TAIL owns the spans the
    // redaction drops: after an `&`, and a final `-` or `_`); the line before it is nearly the 64 KiB bound, and the
    // value arrives after a pause, in another write.
    const password = `Tr0ub4dor3-${randomBytes(9).toString("base64url")}Z`;
    // Just under the unended-line bound (the 64 KiB window), so it is held whole and redacted with its value.
    const filler = "x".repeat(ROOT_POLICY.filesystemInfrastructure.gateLogLineMaximumCharacters - 1_000);
    const script = `process.stdout.write(Buffer.from([0xf0, 0x9f])); setTimeout(() => { process.stdout.write(Buffer.from([0x98, 0x80, 0x0a])); process.stdout.write(${JSON.stringify(filler + form.key)}); setTimeout(() => { process.stdout.write(${JSON.stringify(password + form.tail)} + "\\n"); process.exitCode = 1; }, 300); }, 200)`;
    const [step] = await runCheckoutPhase({ commands: { long: { cwd: ".", argv: [process.execPath, "-e", script], timeoutMs: 60_000 } }, phases: { setup: ["long"], validate: [], regenerate: [], merge: [] } }, "setup", checkoutCommandRunner(target, supervisedRunner()));
    const named = step!.details.find((detail) => detail.startsWith("full output ("))!;
    const log = readFileSync(named.slice(named.indexOf("): ") + 3), "utf8");
    for (const kept of [log, step!.details.join("\n")]) assert.ok(!kept.includes(password), `the password never reaches the log or the tail (D-09): ${JSON.stringify(form.key)}`);
    assert.match(log, form.redacted, `the pair is redacted in place, never split (UR-21): ${JSON.stringify(form.key)}`);
    assert.ok(log.startsWith("\u{1F600}\n"), "the character split across two writes is decoded whole");
    assert.ok(!log.includes("\uFFFD"), "never a replacement character");
  }
});

test("a temp root inside the checkout would put the gate logs back inside it: refused by name", () => {
  const target = createTempDir("working-copy-log-place-");
  const saved = process.env["TMPDIR"];
  process.env["TMPDIR"] = join(target, "tmp");
  try {
    assert.throws(() => gateLogDirectory(target), (error: unknown) => error instanceof InputError && error.code === "gate_log_inside_checkout");
  } finally {
    if (saved === undefined) delete process.env["TMPDIR"]; else process.env["TMPDIR"] = saved;
  }
});

test("a gate that REQUIRES a producer: the producer runs first, once per sequence; a failed producer skips its gate and the rest; a producer is consumed, counted and checked by the schema", async () => {
  const target = gateRoot("working-copy-producers-");
  const writer = (name: string, fails = false) => [process.execPath, "-e", `require('node:fs').appendFileSync('ran', '${name}\\n'); process.exit(${fails ? 3 : 0})`];
  const isolation = {
    links: [],
    commands: {
      profile: { cwd: ".", argv: writer("profile"), timeoutMs: 60_000 },
      suite: { cwd: ".", argv: writer("suite"), timeoutMs: 60_000, requires: ["profile"] },
      again: { cwd: ".", argv: writer("again"), timeoutMs: 60_000, requires: ["profile"] },
      broken: { cwd: ".", argv: writer("broken", true), timeoutMs: 60_000 },
      judged: { cwd: ".", argv: writer("judged"), timeoutMs: 60_000, requires: ["broken"] },
      after: { cwd: ".", argv: writer("after"), timeoutMs: 60_000 },
    },
    phases: { setup: [], validate: ["suite", "again"], regenerate: [], merge: ["judged", "after"] },
  };
  const run = checkoutCommandRunner(target, supervisedRunner());
  const validated = await runCheckoutPhase(isolation, "validate", run);
  assert.deepEqual(validated.map((step) => [step.step, step.status]), [["profile", "pass"], ["suite", "pass"], ["again", "pass"]], "the producer runs before its first gate, once");
  const merged = await runCheckoutPhase(isolation, "merge", run);
  assert.deepEqual(merged.map((step) => [step.step, step.status]), [["broken", "fail"], ["judged", "skip"], ["after", "skip"]], "a gate never judges what no step produced");
  assert.match(merged[1]!.message, /broken, which produces what it judges, failed/u);
  assert.equal(readFileSync(join(target, "ran"), "utf8"), "profile\nsuite\nagain\nbroken\n");
  assert.deepEqual(commandsRun(isolation.commands as never, ["suite", "again", "judged"]), ["profile", "suite", "again", "broken", "judged"], "what a sequence runs: each producer before its first gate, every name once");
  assert.deepEqual(unconsumedCommands({ ...isolation, phases: { ...isolation.phases, merge: [] } } as never, []), ["after", "broken", "judged"], "a producer is consumed by the gate that requires it");

  const document = JSON.parse(readFileSync(join(TEST_REPOSITORY_ROOT, ROOT_POLICY.configuration.basename), "utf8")) as {
    workspaceIsolation: { commands: Record<string, Record<string, unknown>>; phases: Record<string, string[]> };
  };
  const refused = (mutate: (isolationDocument: typeof document.workspaceIsolation) => void, why: RegExp): void => {
    const changed = structuredClone(document);
    mutate(changed.workspaceIsolation);
    const parsed = getConfigDocumentSchema().safeParse(changed);
    assert.equal(parsed.success, false, String(why));
    assert.match(JSON.stringify(parsed.error?.issues), why);
  };
  const gate = (isolationDocument: typeof document.workspaceIsolation): Record<string, unknown> => isolationDocument.commands[isolationDocument.phases["merge"]![0]!]!;
  refused((d) => { gate(d)["requires"] = ["missing-producer"]; }, /requires missing-producer, which is not declared/u);
  refused((d) => { gate(d)["requires"] = [d.phases["merge"]![0]!]; }, /which is the gate itself/u);
  refused((d) => { d.commands["p1"] = { cwd: ".", argv: ["true"], timeoutMs: 1000, requires: ["harness-sync"] }; gate(d)["requires"] = ["p1"]; }, /requires producers itself/u);
  refused((d) => { d.commands["p2"] = { cwd: ".", argv: ["true"], timeoutMs: 1000, ledger: "web" }; gate(d)["requires"] = ["p2"]; }, /is a judged gate, not a producer/u);
  refused((d) => { d.commands[d.phases["setup"]![0]!]!["requires"] = ["harness-sync"]; }, /only the validate and merge phases may run it/u);
  // A producer runs only for the gates that require it (correctness B-L11): one a phase also names would run twice,
  // and a setup command is the checkout's, never a gate's input.
  refused((d) => { gate(d)["requires"] = [d.phases["setup"]![0]!]; }, /is named by a phase itself/u);
  refused((d) => { d.commands["p3"] = { cwd: ".", argv: ["true"], timeoutMs: 1000 }; d.phases["validate"] = [...d.phases["validate"]!, "p3"]; gate(d)["requires"] = ["p3"]; }, /is named by a phase itself/u);
});

test("workspaceIsolation: an undeclared command, dead inputs, an undeclared phase, a focused selector or a rerun-alone declaration, a ledger off a gate or spelled as a path, or no land target is a schema refusal", () => {
  const document = JSON.parse(readFileSync(join(TEST_REPOSITORY_ROOT, ROOT_POLICY.configuration.basename), "utf8")) as {
    workspaceIsolation: { commands: Record<string, unknown>; phases: { setup: string[] } };
  };
  assert.equal(getConfigDocumentSchema().safeParse(document).success, true, "the live declaration is valid");
  const undeclared = structuredClone(document);
  undeclared.workspaceIsolation.phases.setup = [...undeclared.workspaceIsolation.phases.setup, "missing-command"];
  assert.equal(getConfigDocumentSchema().safeParse(undeclared).success, false);
  const noInputs = structuredClone(document) as unknown as { workspaceIsolation: { commands: Record<string, unknown>; phases: Record<string, string[]> } };
  noInputs.workspaceIsolation.commands["focused"] = { cwd: "engine", argv: ["node", "--test"], timeoutMs: 1000 };
  // A command no WORKSPACE phase runs may be a promotion profile's (a data
  // file the schema cannot see): `unconsumedCommands` judges it where both
  // are visible (the promotion boundary guard), below.
  assert.equal(getConfigDocumentSchema().safeParse(noInputs).success, true, "a command no workspace phase runs is the promotion's to consume");
  assert.ok(unconsumedCommands(noInputs.workspaceIsolation as never, []).includes("focused"), "…and dead config when no profile names it either");
  assert.equal(unconsumedCommands(noInputs.workspaceIsolation as never, ["focused"]).includes("focused"), false, "a consumer's name is consumed");
  noInputs.workspaceIsolation.phases["validate"] = [...noInputs.workspaceIsolation.phases["validate"]!, "focused"];
  assert.equal(getConfigDocumentSchema().safeParse(noInputs).success, true, "a command need not declare inputs (only the setup re-run reads them)");
  const deadInputs = structuredClone(document);
  deadInputs.workspaceIsolation.commands["focused"] = { cwd: "engine", argv: ["node", "--test"], timeoutMs: 1000, inputs: ["engine/test"] };
  assert.equal(getConfigDocumentSchema().safeParse(deadInputs).success, false, "inputs on a command no setup phase runs are dead config");
  const deadPhase = structuredClone(document) as unknown as { workspaceIsolation: { phases: Record<string, string[]> } };
  deadPhase.workspaceIsolation.phases["deploy"] = [];
  assert.equal(getConfigDocumentSchema().safeParse(deadPhase).success, false, "a phase without a consumer is not declarable");
  // ONE judge (UR-17): a focused subset selector and a rerun-alone declaration are no longer declarable.
  const focused = structuredClone(document) as unknown as { workspaceIsolation: { commands: Record<string, unknown>; phases: Record<string, string[]> } };
  focused.workspaceIsolation.commands["focused"] = { cwd: "engine", argv: ["node", "--test", "{changed}"], timeoutMs: 1000, changed: { prefix: "engine/test/", suffix: ".test.ts" }, ledger: "engine" };
  focused.workspaceIsolation.phases["validate"] = [...focused.workspaceIsolation.phases["validate"]!, "focused"];
  assert.equal(getConfigDocumentSchema().safeParse(focused).success, false, "a changed-path selector (a subset gate) is refused");
  const rerun = structuredClone(document) as unknown as { workspaceIsolation: { commands: Record<string, Record<string, unknown>> } };
  rerun.workspaceIsolation.commands["web-suite"] = { ...rerun.workspaceIsolation.commands["web-suite"], rerun: { argv: ["npx", "vitest", "run", "{file}"], maxFiles: 5 } };
  assert.equal(getConfigDocumentSchema().safeParse(rerun).success, false, "a rerun-alone declaration (flaky forgiveness) is refused");
  const escaping = structuredClone(document);
  escaping.workspaceIsolation.commands["escape"] = { cwd: "../outside", argv: ["true"], timeoutMs: 1000 };
  assert.equal(getConfigDocumentSchema().safeParse(escaping).success, false);
  // A ledger names a suite (its path is the run-history owner's), and only a gate is judged by one.
  for (const phase of ["setup", "regenerate"] as const) {
    const ledgered = structuredClone(document) as unknown as { workspaceIsolation: { commands: Record<string, unknown>; phases: Record<string, string[]> } };
    ledgered.workspaceIsolation.commands["suite-copy"] = { cwd: ".", argv: ["npm", "test"], timeoutMs: 1000, ledger: "web" };
    ledgered.workspaceIsolation.phases[phase] = [...ledgered.workspaceIsolation.phases[phase]!, "suite-copy"];
    assert.equal(getConfigDocumentSchema().safeParse(ledgered).success, false, `a ${phase} command is never judged by a ledger`);
    ledgered.workspaceIsolation.phases[phase] = ledgered.workspaceIsolation.phases[phase]!.filter((name) => name !== "suite-copy");
    ledgered.workspaceIsolation.phases["merge"] = [...ledgered.workspaceIsolation.phases["merge"]!, "suite-copy"];
    assert.equal(getConfigDocumentSchema().safeParse(ledgered).success, true, "the same command as a merge gate is");
    ledgered.workspaceIsolation.commands["suite-copy"] = { cwd: ".", argv: ["npm", "test"], timeoutMs: 1000, ledger: ".bridlewise/web-test-results/run-history.json" };
    assert.equal(getConfigDocumentSchema().safeParse(ledgered).success, false, "a ledger is a suite name, never a path");
  }
  const landless = structuredClone(document) as unknown as { workspaceIsolation: Record<string, unknown> };
  landless.workspaceIsolation["landTargets"] = [];
  assert.equal(getConfigDocumentSchema().safeParse(landless).success, false, "a workspace must have somewhere to land");
  delete landless.workspaceIsolation["landTargets"];
  assert.equal(getConfigDocumentSchema().safeParse(landless).success, false, "the land targets are declared, never defaulted");
});

test("working copy of THIS checkout: the conservation identity answers exactly as in the checkout", () => {
  // The whole answer — the conservation receipt, or the refusal that came
  // before it — must be the same in the copy as in the checkout it mirrors.
  const inventory = (engineRoot: string): { conservation?: { kind?: string }; error?: string } => {
    const run = spawnSync(process.execPath, ["scripts/test-inventory.ts", "--check"], {
      cwd: engineRoot, encoding: "utf8", maxBuffer: 1 << 26, timeout: 600_000,
    });
    const last = `${run.stdout}${run.stderr}`.trim().split("\n").at(-1)!;
    const parsed = JSON.parse(last) as { conservation?: { kind?: string }; error?: string };
    return parsed.conservation !== undefined ? { conservation: parsed.conservation } : { error: parsed.error ?? last };
  };
  const copy = createRepositoryWorkingCopy("working-copy-conservation-");
  try {
    const inCopy = inventory(copy.engineRoot);
    assert.notEqual(inCopy.conservation?.kind, "unavailable", "a copy without its own git answered 'no instrument'");
    assert.deepEqual(inCopy, inventory(TEST_REPOSITORY_ROOT));
  } finally {
    removeRepositoryLocalTemporaryDirectory(copy.root);
  }
});

test("working copy (staged): the files ARE the index — staged adds present, unstaged edits and deletions not applied, untracked absent", () => {
  const source = plantDirtySource();
  const target = join(createTempDir("working-copy-target-"), "staged");
  createWorkingCopy({ sourceRoot: source, targetRoot: target, git: "staged" });
  assert.equal(readFileSync(join(target, "lib", "staged.ts"), "utf8"), "export const staged = 1;\n");
  assert.equal(readFileSync(join(target, "lib", "edited.ts"), "utf8"), "export const edited = 1;\n", "the unstaged edit is not committed");
  assert.equal(readFileSync(join(target, "lib", "deleted.ts"), "utf8"), "export const deleted = 1;\n", "the unstaged deletion is not committed");
  assert.equal(lstatSync(join(target, "lib", "untracked.ts"), { throwIfNoEntry: false }), undefined);
  assert.equal(git(target, "diff", "--name-only"), "", "the files equal the index they were materialized from");
  assert.equal(git(target, "write-tree"), git(source, "write-tree"), "the same tree the next commit records");
});

test("working copy: objects are borrowed from the CANONICAL store only — a copy of a copy survives the intermediate copy's deletion", () => {
  const source = plantDirtySource();
  const sourceObjects = join(source, ".git", "objects");
  const first = join(createTempDir("working-copy-first-"), "copy");
  createWorkingCopy({ sourceRoot: source, targetRoot: first, git: "stage-all" });
  // A blob only the first copy holds (its own stage-all wrote it).
  writeFileSync(join(first, "lib", "only-in-first.ts"), "export const onlyInFirst = 1;\n");
  git(first, "add", "lib/only-in-first.ts");
  const second = join(createTempDir("working-copy-second-"), "copy");
  createWorkingCopy({ sourceRoot: first, targetRoot: second, git: "stage-all" });
  assert.equal(readFileSync(join(second, ".git", "objects", "info", "alternates"), "utf8").trim(), sourceObjects,
    "the second copy borrows the canonical store, never the first copy's");
  rmSync(first, { recursive: true, force: true });
  assert.equal(git(second, "fsck", "--connectivity-only", "--no-dangling").trim(), "");
  assert.equal(git(second, "show", ":lib/only-in-first.ts"), "export const onlyInFirst = 1;\n");
});

test("working copy: the source's store is never written or freshened, and machine-local excludes are honoured when staging", () => {
  const source = plantDirtySource();
  // A machine-local ignore rule (the same view a global excludes file gives).
  writeFileSync(join(source, ".git", "info", "exclude"), "/personal.local.json\n");
  writeFileSync(join(source, "personal.local.json"), "{}\n");
  // A file whose working bytes REVERT to a blob the store already holds (an
  // older version): git freshens the pack of any existing blob it is asked
  // to write, so this is the case that touched the live store's packs.
  writeFileSync(join(source, "lib", "kept.ts"), "export const kept = 2;\n");
  git(source, "commit", "-q", "-am", "kept v2");
  writeFileSync(join(source, "lib", "kept.ts"), "export const kept = 1;\n");
  git(source, "gc", "-q");
  // An ordinary tree: its files were written before this second (a file newer
  // than an index is racily clean in ANY repository, and git re-hashes it).
  const past = new Date(Date.now() - 3_600_000);
  for (const path of ["lib/kept.ts", "lib/edited.ts", "lib/staged.ts", "lib/untracked.ts", ".gitignore", "personal.local.json"]) utimesSync(join(source, path), past, past);
  const objects = join(source, ".git", "objects");
  const listing = (): string => execFileSync("find", [objects, "-type", "f", "-printf", "%p %s %T@\n"], { encoding: "utf8" }).split("\n").sort().join("\n");
  const before = listing();
  const target = join(createTempDir("working-copy-target-"), "copy");
  createWorkingCopy({ sourceRoot: source, targetRoot: target, git: "stage-all" });
  assert.equal(listing(), before, "no object or pack of the source was written or freshened");
  assert.equal(readFileSync(join(target, "personal.local.json"), "utf8"), "{}\n", "the repository-owned view copies it");
  assert.equal(git(target, "ls-files", "--", "personal.local.json"), "", "the git staging view never stages it");
  assert.deepEqual(untracked(target), [], "and git reports it ignored, as in the source");
});

test("working copy: an interrupted stage never breaks the copy — the alternates are never edited, and the next stage absorbs what was written", () => {
  const source = plantDirtySource();
  const target = join(createTempDir("working-copy-interrupt-"), "copy");
  createWorkingCopy({ sourceRoot: source, targetRoot: target, git: "mirror" });
  const alternates = join(target, ".git", "objects", "info", "alternates");
  const borrowed = readFileSync(alternates, "utf8");
  // A `git` that hangs in `add` (the window a Ctrl-C lands in), then a
  // SIGKILL of the stager mid-add: no `finally` runs.
  const shim = createTempDir("working-copy-git-shim-");
  const addPid = join(shim, "add.pid");
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(join(shim, "git"), `#!/bin/sh\ncase " $* " in *" add "*) echo $$ > ${JSON.stringify(addPid)}; exec sleep 30 ;; esac\nexec ${JSON.stringify(realGit)} "$@"\n`);
  chmodSync(join(shim, "git"), 0o755);
  writeFileSync(join(target, "lib", "late.ts"), "export const late = 1;\n");
  const stager = spawnSync("sh", ["-c", '"$0" --input-type=module -e "$1" & stager=$!; while [ ! -s "$2" ]; do sleep 0.1; done; kill -KILL $stager; kill -KILL "$(cat "$2")"; wait', process.execPath,
    `const { stageInCopy } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "..", "..", "src", "git", "working-copy.ts")).href)}); stageInCopy(${JSON.stringify(target)});`, addPid], {
    cwd: target, encoding: "utf8", timeout: 60_000, env: { ...process.env, PATH: `${shim}:${process.env["PATH"] ?? ""}` },
  });
  assert.equal(stager.status, 0, stager.stderr);
  assert.equal(readFileSync(alternates, "utf8"), borrowed, "the interrupted stage edited the copy's alternates");
  git(target, "log", "-1", "--format=%H");
  // The next stage (real git) completes and leaves a consistent store.
  stageInCopy(target);
  assert.match(git(target, "ls-files", "--", "lib/late.ts"), /lib\/late\.ts/u);
  git(target, "fsck", "--connectivity-only", "--no-dangling");
  assert.deepEqual(readdirSync(join(target, ".git")).filter((name) => name.startsWith("bridlewise-staging-objects")), [], "the dead stager's private object directory is absorbed");
});

test("snapshotWorkingTree: each call stages in its OWN directory — a live owner's is never touched, a dead owner's is absorbed, and a snapshot with a missing object is refused", () => {
  // wf1c-design H-2: one shared staging directory, removed by whichever call
  // finished first, could delete the objects a concurrent call had just
  // written, and `write-tree --missing-ok` then recorded a tree with lost
  // blobs without complaint.
  const source = plantDirtySource();
  const gitDir = join(source, ".git");
  const plantObject = (directory: string): string => {
    mkdirSync(join(directory, "ab"), { recursive: true });
    writeFileSync(join(directory, "ab", "cdef"), "not a real object");
    return join(directory, "ab", "cdef");
  };
  const exited = spawnSync(process.execPath, ["-e", "0"]);
  const live = join(gitDir, ownedTemporaryName("bridlewise-staging-objects-"));
  const dead = join(gitDir, `bridlewise-staging-objects-${String(exited.pid)}-1-dead`);
  const liveObject = plantObject(live);
  plantObject(dead);
  const identity = { name: "Snapshot Test", email: "snapshot@example.invalid" };
  snapshotWorkingTree(source, { message: "one", name: "one", identity });
  assert.equal(existsSync(liveObject), true, "a LIVE owner's staging directory was absorbed or removed by another call");
  assert.equal(existsSync(dead), false, "a dead owner's staging directory was left behind");
  assert.equal(existsSync(join(gitDir, "objects", "ab", "cdef")), true, "a dead owner's objects were not absorbed into the store");
  rmSync(live, { recursive: true, force: true });
  rmSync(join(gitDir, "objects", "ab", "cdef"), { force: true });
  // An index entry naming a blob the store does not hold (kept by
  // skip-worktree, so `add -A` does not re-hash it): refused, not recorded.
  git(source, "update-index", "--add", "--cacheinfo", `100644,${"1".repeat(40)},lib/phantom.ts`);
  git(source, "update-index", "--skip-worktree", "lib/phantom.ts");
  writeFileSync(join(source, "lib", "phantom.ts"), "export {};\n");
  assert.throws(() => snapshotWorkingTree(source, { message: "two", name: "two", identity }), (error: unknown) => (error as { code?: unknown }).code === "snapshot_objects_missing");
  assert.equal(spawnSync("git", ["rev-parse", "--verify", "-q", `${ROOT_POLICY.verification.workingTreeSnapshot.refNamespace}/two`], { cwd: source }).status, 1, "a refused snapshot was recorded");
});

test("snapshotWorkingTree: a snapshot is named in the one namespace, and moving the checked-out branch is refused unless the index records its tree", () => {
  // wf1c-design H-3: `ref: "HEAD"` moved the branch under an index that
  // described another tree — every change then showed as a staged reversal,
  // and commit-tree ran no hook.
  const source = plantDirtySource();
  const identity = { name: "Snapshot Test", email: "snapshot@example.invalid" };
  const head = git(source, "rev-parse", "HEAD").trim();
  assert.throws(() => snapshotWorkingTree(source, { message: "x", name: "refs/heads/main" }), (error: unknown) => (error as { code?: unknown }).code === "snapshot_name_invalid");
  assert.throws(() => snapshotWorkingTree(source, { message: "x", advanceHead: true, identity }), (error: unknown) => (error as { code?: unknown }).code === "snapshot_ref_checked_out");
  assert.equal(git(source, "rev-parse", "HEAD").trim(), head, "a refused snapshot moved the branch");
  const named = snapshotWorkingTree(source, { message: "named", name: "wf", identity });
  assert.equal(named.ref, `${ROOT_POLICY.verification.workingTreeSnapshot.refNamespace}/wf`);
  assert.equal(git(source, "rev-parse", named.ref!).trim(), named.commit);
  assert.equal(git(source, "rev-parse", "HEAD").trim(), head, "a named snapshot moved the branch");
  // With the index recording exactly the tree (everything staged), HEAD may move.
  git(source, "add", "-A");
  const advanced = snapshotWorkingTree(source, { message: "advance", advanceHead: true, identity });
  assert.equal(git(source, "rev-parse", "HEAD").trim(), advanced.commit);
  assert.equal(git(source, "status", "--porcelain"), "", "the branch moved under an index that describes it: nothing to commit");
});

test("snapshotWorkingTree: the tree `add -A` would commit, as a commit and a ref — the real index untouched, the store never freshened", () => {
  const source = plantDirtySource();
  // A dirty file whose bytes equal a HISTORICAL blob: the freshening case.
  writeFileSync(join(source, "lib", "kept.ts"), "export const kept = 2;\n");
  git(source, "commit", "-q", "-am", "kept v2");
  writeFileSync(join(source, "lib", "kept.ts"), "export const kept = 1;\n");
  git(source, "gc", "-q");
  const past = new Date(Date.now() - 3_600_000);
  for (const path of ["lib/kept.ts", "lib/edited.ts", "lib/staged.ts", "lib/untracked.ts", ".gitignore"]) utimesSync(join(source, path), past, past);
  const packs = join(source, ".git", "objects", "pack");
  const packTimes = (): string => readdirSync(packs).map((name) => `${name} ${statSync(join(packs, name)).mtimeMs}`).sort().join("\n");
  const beforePacks = packTimes();
  const indexPath = join(source, ".git", "index");
  const indexBefore = fileSha(indexPath);
  const head = git(source, "rev-parse", "HEAD").trim();
  const snapshot = snapshotWorkingTree(source, { message: "snapshot", name: "test", identity: { name: "Snapshot Test", email: "snapshot@example.invalid" } });
  assert.equal(fileSha(indexPath), indexBefore, "the real index was touched");
  assert.equal(packTimes(), beforePacks, "the store's packs were freshened");
  assert.equal(snapshot.parent, head);
  assert.equal(git(source, "rev-parse", "refs/bridlewise/snapshots/test").trim(), snapshot.commit);
  assert.equal(git(source, "rev-parse", `${snapshot.commit}^{tree}`).trim(), snapshot.tree);
  // The reference answer: `add -A` + `write-tree` in a throwaway copy.
  const reference = join(createTempDir("working-copy-snapshot-ref-"), "copy");
  createWorkingCopy({ sourceRoot: source, targetRoot: reference, git: "stage-all" });
  assert.equal(git(reference, "write-tree").trim(), snapshot.tree, "the snapshot is the tree `git add -A` would commit");
  git(source, "fsck", "--connectivity-only", "--no-dangling");
  assert.deepEqual(readdirSync(join(source, ".git")).filter((name) => name.startsWith("bridlewise-")), [], "no private index or object directory is left");
  assert.match(git(source, "status", "--porcelain"), /lib\/untracked\.ts/u, "the working tree and its status are unchanged");
});

test("working copy (snapshot): a RACILY CLEAN edit — same size, the same instant as the index that recorded the old bytes — is recorded with its NEW bytes (the private index keeps the real index's timestamp)", () => {
  const root = createTempDir("working-copy-racy-");
  git(root, "init", "-q", "--initial-branch=main");
  git(root, "config", "core.trustctime", "false"); // the plant moves a file's mtime, which moves its ctime too
  const file = join(root, "edited.ts");
  // The old bytes, dated well before the index records them (so git keeps their stat, unsmudged).
  const then = new Date(Date.now() - 600_000);
  writeFileSync(file, "export const edited = 1;\n");
  utimesSync(file, then, then);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  // The edit git cannot see by its stat alone: the same size, and the very mtime the index recorded for the old
  // bytes; the index itself stamped that same instant, which is what makes git re-read the file ("racily clean").
  writeFileSync(file, "export const edited = 2;\n");
  utimesSync(file, then, then);
  utimesSync(join(root, ".git", "index"), then, then);
  // (Nothing may read the real index between the plant and the snapshot: a `git status` would rewrite it, smudging the
  // racy entry, and the plant would prove nothing.)
  const snapshot = snapshotWorkingTree(root, { message: "racy", identity: { name: "Snapshot Test", email: "snapshot@example.invalid" } });
  assert.equal(git(root, "show", `${snapshot.commit}:edited.ts`), "export const edited = 2;\n", "the snapshot records the file's bytes, never the index's stale belief");
});

test("working copy (snapshot): the files and the index ARE the snapshot's tree, HEAD its parent — whatever the source holds later", () => {
  const source = plantDirtySource();
  const head = git(source, "rev-parse", "HEAD").trim();
  const snapshot = snapshotWorkingTree(source, { message: "for a verifier", name: "verify-me", identity: { name: "Snapshot Test", email: "snapshot@example.invalid" } });
  // The source moves on after the snapshot: a verifier's copy must not see it.
  writeFileSync(join(source, "lib", "edited.ts"), "export const edited = 3;\n");
  writeFileSync(join(source, "lib", "later.ts"), "export const later = 1;\n");
  const verifierCopy = join(createTempDir("working-copy-snapshot-"), "copy");
  const made = createWorkingCopy({ sourceRoot: source, targetRoot: verifierCopy, git: "snapshot", commit: "refs/bridlewise/snapshots/verify-me" });
  assert.equal(made.head, head, "HEAD is the snapshot's parent");
  assert.equal(git(verifierCopy, "write-tree").trim(), snapshot.tree, "the copy's index is the snapshot's tree");
  assert.equal(readFileSync(join(verifierCopy, "lib", "edited.ts"), "utf8"), "export const edited = 2;\n", "the copy holds the SNAPSHOT's bytes, not the source's later edit");
  assert.equal(existsSync(join(verifierCopy, "lib", "later.ts")), false, "a file the source gained after the snapshot is absent");
  assert.equal(existsSync(join(verifierCopy, "lib", "deleted.ts")), false, "a deletion the snapshot recorded is applied");
  assert.equal(readFileSync(join(verifierCopy, "lib", "untracked.ts"), "utf8"), "export const untracked = 1;\n", "an untracked file the snapshot staged is present");
  assert.deepEqual(git(verifierCopy, "status", "--porcelain", "--untracked-files=all").split("\n").filter((line) => line.length > 0 && !line.startsWith("M ") && !line.startsWith("A ") && !line.startsWith("D ")), [], "the worktree equals the index");
  assert.throws(() => createWorkingCopy({ sourceRoot: source, targetRoot: join(createTempDir("working-copy-snapshot-missing-"), "copy"), git: "snapshot", commit: "refs/bridlewise/snapshots/none" }),
    (error: unknown) => (error as { code?: string }).code === "working_copy_snapshot_missing");
});

test("working copy: the source's remotes and upstreams are mirrored", () => {
  const source = plantDirtySource();
  git(source, "remote", "add", "origin", "https://example.invalid/repo.git");
  git(source, "update-ref", "refs/remotes/origin/main", git(source, "rev-parse", "HEAD").trim());
  git(source, "branch", "--set-upstream-to=origin/main", "main");
  const target = join(createTempDir("working-copy-target-"), "copy");
  createWorkingCopy({ sourceRoot: source, targetRoot: target, git: "mirror" });
  assert.equal(git(target, "remote", "-v"), git(source, "remote", "-v"));
  assert.equal(git(target, "rev-parse", "--abbrev-ref", "@{upstream}").trim(), "origin/main");
  assert.equal(git(target, "status", "--porcelain=v2", "--branch").split("\n").filter((line) => line.startsWith("# branch.")).join("\n"),
    git(source, "status", "--porcelain=v2", "--branch").split("\n").filter((line) => line.startsWith("# branch.")).join("\n"));
});

test("working copy refresh: paths the copy authors are neither overwritten nor deleted by the source", () => {
  const source = plantDirtySource();
  const target = join(createTempDir("working-copy-target-"), "copy");
  createWorkingCopy({ sourceRoot: source, targetRoot: target, git: "stage-all" });
  writeFileSync(join(target, "lib", "kept.ts"), "export const kept = 'regenerated';\n");
  writeFileSync(join(target, "lib", "authored-only.ts"), "export const authored = 1;\n");
  writeFileSync(join(source, "lib", "edited.ts"), "export const edited = 3;\n");
  const refreshed = refreshWorkingCopy(source, target, new Set(["lib/kept.ts", "lib/authored-only.ts"]));
  assert.deepEqual(refreshed.map(({ path }) => path), ["lib/edited.ts"]);
  assert.equal(readFileSync(join(target, "lib", "kept.ts"), "utf8"), "export const kept = 'regenerated';\n");
  assert.equal(readFileSync(join(target, "lib", "authored-only.ts"), "utf8"), "export const authored = 1;\n");
  assert.equal(readFileSync(join(target, "lib", "edited.ts"), "utf8"), "export const edited = 3;\n");
});

test("snapshotWorkingTree: HEAD moves by COMPARE-AND-SWAP; a refused advance records no name; names git refuses and a checked-out name are typed refusals", () => {
  // wf1b-correctness §4: `update-ref HEAD <commit>` without the old value
  // dropped a `git commit` made while the snapshot was taken.
  const source = plantDirtySource();
  const identity = { name: "Snapshot Test", email: "snapshot@example.invalid" };
  for (const name of ["x.lock", "a..b", "x."]) {
    assert.throws(() => snapshotWorkingTree(source, { message: "x", name, identity }), (error: unknown) => (error as { code?: unknown }).code === "snapshot_name_invalid", name);
  }
  // A refused advance (the index does not record the tree) records no name either.
  assert.throws(() => snapshotWorkingTree(source, { message: "x", name: "refused", advanceHead: true, identity }), (error: unknown) => (error as { code?: unknown }).code === "snapshot_ref_checked_out");
  assert.equal(spawnSync("git", ["rev-parse", "--verify", "-q", `${ROOT_POLICY.verification.workingTreeSnapshot.refNamespace}/refused`], { cwd: source }).status, 1, "a refused advance still wrote the named ref");
  // A concurrent commit lands while the snapshot is taken (a git on PATH that commits first when asked to commit-tree).
  git(source, "add", "-A");
  const shim = createTempDir("snapshot-git-shim-");
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(join(shim, "git"), `#!/bin/sh\ncase " $* " in *" commit-tree "*) "${realGit}" -c user.name=c -c user.email=c@example.invalid commit -q --allow-empty -m concurrent ;; esac\nexec "${realGit}" "$@"\n`);
  chmodSync(join(shim, "git"), 0o755);
  const path = process.env["PATH"];
  process.env["PATH"] = `${shim}:${path ?? ""}`;
  try {
    assert.throws(() => snapshotWorkingTree(source, { message: "advance", advanceHead: true, identity }), (error: unknown) => (error as { code?: unknown }).code === "snapshot_head_moved");
  } finally {
    process.env["PATH"] = path;
  }
  assert.equal(git(source, "log", "-1", "--format=%s").trim(), "concurrent", "the concurrent commit was dropped from the branch");
  // A name that IS the checked-out ref moves nothing.
  git(source, "update-ref", `${ROOT_POLICY.verification.workingTreeSnapshot.refNamespace}/cur`, "HEAD");
  git(source, "symbolic-ref", "HEAD", `${ROOT_POLICY.verification.workingTreeSnapshot.refNamespace}/cur`);
  const head = git(source, "rev-parse", "HEAD").trim();
  assert.throws(() => snapshotWorkingTree(source, { message: "x", name: "cur", identity }), (error: unknown) => (error as { code?: unknown }).code === "snapshot_ref_checked_out");
  assert.equal(git(source, "rev-parse", "HEAD").trim(), head);
});

test("a heavy setup command is ADMITTED AT ONCE beside a live run — it never waits for another run — and runs once per tree", async () => {
  const target = gateRoot("working-copy-heavy-setup-");
  execFileSync("git", ["init", "-q"], { cwd: target, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  writeFileSync(join(target, "a.txt"), "a\n");
  const lockPath = join(createTempDir("working-copy-heavy-lock-"), "instrument.lock");
  const runner: CheckoutCommandRunner = { ...supervisedRunner(), instrumentLock: { lockPath, perRun: { memoryMaxPercent: 50, cpuWeight: 100 } } };
  const counter = join(target, "..", `${String(process.pid)}-runs.txt`);
  // The command counts its runs (outside the checkout, so the tree it ran for does not change).
  const command = { cwd: ".", argv: [process.execPath, "-e", `require("fs").appendFileSync(${JSON.stringify(counter)}, Date.now() + "\\n")`], timeoutMs: 60_000, holdsInstrumentLock: true as const };
  // Another admitted run is live for the whole test: the setup command runs beside it.
  const lockModule = pathToFileURL(join(import.meta.dirname, "..", "..", "src", "process", "instrument-lock.ts")).href;
  const configModule = pathToFileURL(join(import.meta.dirname, "..", "..", "src", "workflow", "workflow-config.ts")).href;
  const holder = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `const m = await import(${JSON.stringify(lockModule)}); const c = await import(${JSON.stringify(configModule)}); m.admitInstrumentRun(${JSON.stringify(lockPath)}, "a validate", { memoryMaxPercent: 50, cpuWeight: 100 }, c.SUBPROCESS_BOUNDS); console.log("admitted"); setTimeout(() => process.exit(0), 60_000);`], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    await new Promise<void>((resolveHeld) => holder.stdout.once("data", () => resolveHeld()));
    const first = await runCheckoutCommand(target, "warm", command, runner);
    assert.equal(first.status, "pass", first.message);
    assert.equal(holder.exitCode, null, "it ran while the other run was still live: nothing waited");
    assert.equal(readFileSync(counter, "utf8").trim().split("\n").length, 1, "it ran once");
    const again = await runCheckoutCommand(target, "warm", command, runner);
    assert.equal(again.status, "pass");
    assert.match(again.message, /already run for this tree/u);
    assert.equal(readFileSync(counter, "utf8").trim().split("\n").length, 1, "the same tree is not run again");
    writeFileSync(join(target, "a.txt"), "b\n");
    assert.equal((await runCheckoutCommand(target, "warm", command, runner)).status, "pass");
    assert.equal(readFileSync(counter, "utf8").trim().split("\n").length, 2, "another tree runs it");
  } finally {
    holder.kill("SIGKILL");
    rmSync(counter, { force: true });
  }
});

test("a heavy setup command's OWN nested admission BORROWS the run its checkout command was admitted under: owns nothing, inside the run's scope, under its caps (NO-LOAD-BLOCK; a nested admission that refused or took a run of its own would leave the outer cap)", async () => {
  const target = gateRoot("working-copy-nested-admission-");
  execFileSync("git", ["init", "-q"], { cwd: target, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
  writeFileSync(join(target, "a.txt"), "a\n");
  const lockPath = join(createTempDir("working-copy-nested-lock-"), "instrument.lock");
  const runner: CheckoutCommandRunner = { ...supervisedRunner(), instrumentLock: { lockPath, perRun: { memoryMaxPercent: 37, cpuWeight: 42 } } };
  const answer = join(target, "..", `${String(process.pid)}-nested.json`);
  const engine = join(import.meta.dirname, "..", "..");
  const lockModule = pathToFileURL(join(engine, "src", "process", "instrument-lock.ts")).href;
  const factsModule = pathToFileURL(join(engine, "src", "process", "process-facts.ts")).href;
  const configModule = pathToFileURL(join(engine, "src", "workflow", "workflow-config.ts")).href;
  // The checkout command itself is a nested heavy run (a validate's suite does exactly this): it admits on the same registry.
  const script = [
    `const { admitInstrumentRun, admittedRuns } = await import(${JSON.stringify(lockModule)});`,
    `const { ownCgroupPath, ownCpuTimeLimit } = await import(${JSON.stringify(factsModule)});`,
    `const { SUBPROCESS_BOUNDS } = await import(${JSON.stringify(configModule)});`,
    `const { readFileSync, writeFileSync } = await import("node:fs");`,
    `const nested = admitInstrumentRun(${JSON.stringify(lockPath)}, "a nested suite", { memoryMaxPercent: 99, cpuWeight: 999 }, SUBPROCESS_BOUNDS);`,
    "const cgroup = ownCgroupPath();",
    `writeFileSync(${JSON.stringify(answer)}, JSON.stringify({ owns: nested.owns, cgroup, weight: readFileSync("/sys/fs/cgroup" + cgroup + "/cpu.weight", "utf8").trim(), limit: ownCpuTimeLimit(), runs: admittedRuns(${JSON.stringify(lockPath)}).length }));`,
    "nested.release();",
  ].join("\n");
  const command = { cwd: ".", argv: [process.execPath, "--input-type=module", "-e", script], timeoutMs: 60_000, holdsInstrumentLock: true as const };
  try {
    const ran = await runCheckoutCommand(target, "nested", command, runner);
    assert.equal(ran.status, "pass", ran.message);
    const seen = JSON.parse(readFileSync(answer, "utf8")) as { owns: boolean; cgroup: string; weight: string; limit: { soft: string; hard: string }; runs: number };
    assert.equal(seen.owns, false, "the nested admission borrows: it owns nothing");
    assert.match(seen.cgroup, /\/bridlewise-run-[0-9a-f-]+\.scope$/u, "the nested run is inside the outer run's scope");
    assert.equal(seen.weight, "42", "under the OUTER run's caps (its own requested 999 never applied)");
    assert.deepEqual(seen.limit, { soft: String(SUBPROCESS_BOUNDS.cpuLimitSeconds), hard: String(SUBPROCESS_BOUNDS.cpuLimitSeconds + SUBPROCESS_BOUNDS.cpuKillGraceSeconds) }, "under the CPU-time limit");
    assert.equal(seen.runs, 1, "one record: the outer run's; the nested admission wrote none");
  } finally {
    rmSync(answer, { force: true });
  }
});

test("a gate-log line that grows past the bound with no end is WITHHELD whole, never split and never held without limit: the place says so, the rest of that line is discarded, and the next line is logged", async () => {
  const target = gateRoot("working-copy-unended-line-");
  const password = `Tr0ub4dor3-${randomBytes(9).toString("base64url")}`;
  const bound = ROOT_POLICY.filesystemInfrastructure.gateLogLineMaximumCharacters;
  // Words and spaces past the bound, the key last: a cut at the last whitespace would part the key from its value.
  const script = `process.stdout.write("z ".repeat(${String(bound)}) + "db password: "); setTimeout(() => { process.stdout.write(${JSON.stringify(password)} + " tail\\nthe next line\\n"); process.exitCode = 1; }, 200)`;
  const [step] = await runCheckoutPhase({ commands: { long: { cwd: ".", argv: [process.execPath, "-e", script], timeoutMs: 60_000 } }, phases: { setup: ["long"], validate: [], regenerate: [], merge: [] } }, "setup", checkoutCommandRunner(target, supervisedRunner()));
  const named = step!.details.find((detail) => detail.startsWith("full output ("))!;
  const log = readFileSync(named.slice(named.indexOf("): ") + 3), "utf8");
  assert.ok(!log.includes(password) && !step!.details.join("\n").includes(password), "the password never reaches the log or the tail");
  assert.match(log, new RegExp(`\\[withheld: a line of more than ${String(bound)} characters with no end`, "u"));
  assert.ok(!log.includes("z z z z z z z z"), "none of the withheld line is kept");
  assert.match(log, /the next line\n/u, "the next line is logged");
});
