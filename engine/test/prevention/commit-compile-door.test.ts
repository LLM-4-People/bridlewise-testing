/**
 * THE COMPILE DOOR'S REFUSAL BRANCHES ARE DRIVEN AT THE REAL DOOR.
 *
 * The compile leg of `engine/scripts/commit-guard.ts` had no in-suite drive:
 * running the REAL umbrella from inside the suites would cost their runtime
 * budget, so refusal was live-verified by hand once. The plumbing itself is
 * cheap to drive honestly: a fixture repository whose OWN `typecheck` script
 * decides pass/fail and records its invocation — the door really invokes
 * `npm run typecheck` in both trees; the fixture's script is its own, which
 * is a fixture, not a stub of the door.
 *
 * Claims driven here (the move half's crash branch lives in
 * `commit-move-guard.test.ts`; the door is one program):
 *
 *   A. a staged code change whose first tree does not compile is REFUSED —
 *      and BOTH trees' legs were still attempted (the witness lists both
 *      working directories), so a one-legged refusal can never hide the
 *      other tree's state;
 *   B. a commit staging NO code runs neither leg — the refusal machinery
 *      never pays the compiler when nothing it certifies changed;
 *   C. a crash anywhere in the door's own machinery refuses on the EXIT
 *      CODE, not only the message — here the staged-list read, via a git on
 *      PATH that answers the move check and fails the staged-list read.
 *
 * The witness file is the liveness anchor throughout: an arm that asserts
 * the legs did NOT run is preceded (in the same fixture) by a commit where
 * they provably DID.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { GUARDED_HOOKS, HOOKS_DIRECTORY, HOOK_NAME, guardHookText } from "../../scripts/verification/staged-move-loss.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { ownedTemporaryName } from "../../src/filesystem/private-state.ts";
import { recordIndexBaseline } from "../../src/git/index-baseline.ts";

const INTEGRATION_ROOT = resolve(import.meta.dirname, "..", "..");
const COMMIT_GUARD = join(INTEGRATION_ROOT, "scripts", "commit-guard.ts");

/** `git commit` as DATA: the status is the verdict, so it must not throw. */
function commit(root: string, message: string): Readonly<{ status: number; stderr: string }> {
  const result = spawnSync("git", ["commit", "-q", "-m", message], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1 << 24,
  });
  return { status: result.status ?? -1, stderr: result.stderr };
}

function writeFile(root: string, rel: string, body: string): void {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), body);
}

/**
 * A throwaway repository wired to the REAL guard program, whose OWN two
 * `typecheck` scripts record their working directory in `<root>/witness.txt`
 * and then decide by the pass/fail spelling the caller planted.
 */
function compileFixtureRepository(spell: "pass" | "fail"): string {
  const root = createTempDir("ch-commit-compile-door-");
  const run = (...args: readonly string[]): void => {
    execFileSync("git", [...args], { cwd: root, stdio: "pipe" });
  };
  run("init", "-q");
  run("config", "user.email", "guard@example.invalid");
  run("config", "user.name", "guard");
  for (const hook of GUARDED_HOOKS) {
    writeFile(root, join(HOOKS_DIRECTORY, hook), guardHookText(hook, JSON.stringify(COMMIT_GUARD)));
    chmodSync(join(root, HOOKS_DIRECTORY, hook), 0o755);
  }
  run("config", "core.hooksPath", HOOKS_DIRECTORY);
  // The fixture's OWN legs: record the real working directory npm hands the
  // script (this is what proves BOTH trees were attempted), then decide.
  const decision = spell === "pass" ? "" : "exit 3\n";
  const script = `pwd >> "${root}/witness.txt"\n${decision}`;
  writeFile(root, "run-tc.sh", script);
  writeFile(root, "package.json", `{"name":"x","private":true,"scripts":{"typecheck":"sh run-tc.sh"}}\n`);
  writeFile(root, "engine/run-tc.sh", script);
  writeFile(root, "engine/package.json", `{"name":"x-engine","private":true,"scripts":{"typecheck":"sh run-tc.sh"}}\n`);
  return root;
}

/**
 * Both legs ran IN A MATERIALIZATION OF THE INDEX: two witness lines, one
 * the staged tree's top, one its `engine/`, both under the repository's
 * private commit-guard state directory — never the working tree itself.
 */
function bothStagedLegs(root: string, witness: string, checkout = root): boolean {
  const lines = witness.split("\n").filter((line) => line.length > 0);
  const staged = `${checkout}/.bridlewise/state/commit-guard/staged-`;
  return lines.length === 2 && lines.every((line) => line.startsWith(staged)) &&
    lines.filter((line) => line.endsWith("/engine")).length === 1;
}

test("the door's own header admits the --no-verify bypass and names its legitimate use — never as a route around a refusal", () => {
  // The door can always be skipped (`git commit --no-verify` reaches no hook).
  // Hiding that fact teaches the operator nothing; the honest contract is
  // prose ON the door: when the bypass exists and what it is never for. This
  // pin keeps the door's header carrying that admission. It judges THE
  // HEADER, not the whole file: an unbounded match would let the admission
  // weaken while incidental prose elsewhere satisfies the pattern.
  const source = readFileSync(COMMIT_GUARD, "utf8");
  const headerStart = source.indexOf("/**");
  const headerEnd = source.indexOf("*/");
  assert.ok(headerStart !== -1 && headerEnd > headerStart, "the door carries a header contract block");
  const header = source.slice(headerStart, headerEnd);
  assert.match(
    header,
    /--no-verify/u,
    "the door's header must admit that --no-verify skips it — an unadmitted bypass is discovered, not documented",
  );
  assert.match(
    header,
    /never[^.\n]*refusal/iu,
    "the header must name what --no-verify is NEVER for: routing around a refusal",
  );
  assert.match(
    header,
    /refusal[\s\S]*?(fix the code|fix the door)/iu,
    "…and the remedy clause must ride along: fix the code, or fix the door — never the flag around either",
  );
});

test("DRIVEN: a staged code change whose compile leg fails is REFUSED — and BOTH trees' legs were attempted", () => {
  const root = compileFixtureRepository("pass");
  // The liveness witness FIRST: a passing-door commit provably runs both
  // legs — the absence assertions below are about THIS fixture, never about
  // a witness that was never seen working.
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  const baseline = commit(root, "baseline with code-shaped files");
  assert.equal(baseline.status, 0, `the passing baseline was refused: ${baseline.stderr}`);
  assert.equal(
    existsSync(join(root, "witness.txt")),
    true,
    "the passing baseline ran NO compile leg — the witness mechanism never proved it can record",
  );
  const baselineWitness = readFileSync(join(root, "witness.txt"), "utf8");
  assert.ok(
    bothStagedLegs(root, baselineWitness),
    `a passing commit did not attempt BOTH trees' legs — the witness records:${JSON.stringify(baselineWitness)}`,
  );

  // Now the failing leg, staged through a code-shaped change.
  rmSync(join(root, "witness.txt"));
  writeFile(root, "run-tc.sh", `pwd >> "${root}/witness.txt"\nexit 3\n`);
  writeFile(root, "src/code.ts", "export const x = 1;\n");
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  const refused = commit(root, "code change that does not compile");
  assert.notEqual(refused.status, 0, "a code commit whose first tree does not compile was ACCEPTED");
  assert.match(refused.stderr, /COMMIT REFUSED/u);
  assert.match(refused.stderr, /does not compile/u);
  // The refusal is the exit code: the commit never landed.
  assert.equal(
    execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    "1",
    "the refused commit landed anyway",
  );
  // A refusal earned in the FIRST tree must not hide the second tree's
  // state: the door still attempts both legs — the witness records both
  // working directories even on the refusing run.
  const refusedWitness = readFileSync(join(root, "witness.txt"), "utf8");
  assert.ok(
    bothStagedLegs(root, refusedWitness),
    `a refusing run did not attempt BOTH trees' legs — the witness records:${JSON.stringify(refusedWitness)}`,
  );
});

test("DRIVEN: the compile legs judge the STAGED bytes — an unstaged fix does not pass a broken commit, an unstaged break does not refuse a sound one", () => {
  const root = compileFixtureRepository("pass");
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  assert.equal(commit(root, "baseline").status, 0);
  // Staged: a failing leg. Working tree: the passing one (an unstaged "fix").
  writeFile(root, "run-tc.sh", `pwd >> "${root}/witness.txt"\nexit 3\n`);
  writeFile(root, "src/a.ts", "export const a = 1;\n");
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  writeFile(root, "run-tc.sh", `pwd >> "${root}/witness.txt"\n`);
  const refused = commit(root, "a broken staged tree with an unstaged fix");
  assert.notEqual(refused.status, 0, "the working tree's fix certified a staged tree that does not compile");
  assert.match(refused.stderr, /staged web tree does not compile/u);
  // Staged: the passing leg. Working tree: a failing one (an unstaged break).
  execFileSync("git", ["add", "run-tc.sh"], { cwd: root, stdio: "pipe" });
  writeFile(root, "run-tc.sh", `pwd >> "${root}/witness.txt"\nexit 3\n`);
  const accepted = commit(root, "a sound staged tree with an unstaged break");
  assert.equal(accepted.status, 0, `an unstaged break refused a staged tree that compiles: ${accepted.stderr}`);
});

test("DRIVEN: a commit staging no code runs NEITHER compile leg — the machinery never pays the compiler", () => {
  const root = compileFixtureRepository("pass");
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  assert.equal(commit(root, "baseline").status, 0);
  // The absence verdict below needs its own witness in THIS fixture: the
  // code-shaped baseline provably ran the legs, so their machinery is live.
  assert.equal(
    existsSync(join(root, "witness.txt")),
    true,
    "the baseline ran NO compile leg — 'the legs did not run' below would then prove a dead door, not a skipped one",
  );
  rmSync(join(root, "witness.txt"));

  writeFile(root, "docs/notes.md", "# documentation only\n");
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  const accepted = commit(root, "docs only");
  assert.equal(accepted.status, 0, `a docs-only commit was refused: ${accepted.stderr}`);
  assert.equal(
    existsSync(join(root, "witness.txt")),
    false,
    "a docs-only commit RAN a compile leg — the door pays the compiler for commits it does not certify",
  );
});

test("DRIVEN: a lock-only staged change stages the compile legs — dependency resolution IS code-shaped", () => {
  // A package-lock.json edit can change what the SAME sources compile to
  // (a tightened or shifted dependency graph) — so the door must not wave
  // it past the compiler merely because no .ts file moved. Fail-closed is
  // the door's contract; it already pays the legs for package.json.
  const root = compileFixtureRepository("pass");
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  assert.equal(commit(root, "baseline").status, 0);
  // Liveness witness: the baseline provably ran both legs on a code-shaped
  // commit, so the witness mechanism is known-live before the lock drive.
  assert.equal(existsSync(join(root, "witness.txt")), true, "the baseline ran NO compile leg — the witness mechanism never proved it can record");
  rmSync(join(root, "witness.txt"));

  writeFile(root, "run-tc.sh", `pwd >> "${root}/witness.txt"\nexit 3\n`);
  writeFile(root, "package-lock.json", `{"name":"x","lockfileVersion":3,"packages":{}}\n`);
  // The failing leg is staged with the lock (a `.sh` is not code-shaped, so
  // the commit is still lock-only as far as the door's trigger is concerned):
  // the door judges the STAGED bytes.
  execFileSync("git", ["add", "package-lock.json", "run-tc.sh"], { cwd: root, stdio: "pipe" });
  const refused = commit(root, "lockfile-only change");
  assert.notEqual(
    refused.status,
    0,
    "a lock-only commit whose trees do not compile was ACCEPTED — the door rated dependency resolution as not code-shaped",
  );
  assert.match(refused.stderr, /does not compile/u);
  const refusedWitness = readFileSync(join(root, "witness.txt"), "utf8");
  assert.ok(
    bothStagedLegs(root, refusedWitness),
    `a lock-only commit did not attempt BOTH trees' legs — the witness records:${JSON.stringify(refusedWitness)}`,
  );
});

test("DRIVEN: a staged code file whose PATH holds a newline still stages the legs — the index read never mis-decodes it", () => {
  // git C-quotes a newline-bearing path in `--name-only` output; a reader
  // that splits that output on `\n` sees a trailing `"` and every extension
  // filter misses the file — the commit would pay NO compile leg (the move
  // check reads the same index with `-z`, so the two reads disagreed).
  const root = compileFixtureRepository("pass");
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  assert.equal(commit(root, "baseline").status, 0);
  rmSync(join(root, "witness.txt"));

  writeFile(root, "run-tc.sh", `pwd >> "${root}/witness.txt"\nexit 3\n`);
  writeFile(root, join("src", "odd\nname.ts"), "export const odd = 1;\n");
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  const refused = commit(root, "an oddly-named code change that does not compile");
  // Not WHICH name mattered, only WHICH answer: the legs ran (the witness
  // recorded them), so the failing tree REFUSED the commit.
  assert.notEqual(refused.status, 0, "a newline-named code file skipped the compile legs — the commit was ACCEPTED unexamined");
  assert.match(refused.stderr, /does not compile/u);
  assert.equal(
    existsSync(join(root, "witness.txt")),
    true,
    "the compile legs never ran for a code-shaped commit — the staged-list read mis-decoded the path",
  );
});

test("DRIVEN: a crashed staged-list read refuses on the EXIT CODE — the message alone is not the refusal", () => {
  // The move check's first git call (`diff --cached --raw …`) answers
  // "nothing staged" through the shim, so the crash can come ONLY from the
  // door's OWN staged-list read (`diff --cached --name-only`) — the branch
  // this arm watches. Real `git` never runs at all here; the shim is the
  // whole toolchain, which is exactly how a hook sees a broken machine.
  const root = createTempDir("ch-commit-staged-crash-");
  writeFile(root, "shim/git", `#!/bin/sh\ncase " $* " in\n  *" --raw "*) exit 0 ;;\n  *) echo shim-unavailable >&2; exit 128 ;;\nesac\n`);
  chmodSync(join(root, "shim/git"), 0o755);
  const result = spawnSync("node", ["--experimental-strip-types", COMMIT_GUARD, root], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1 << 24,
    env: { ...process.env, PATH: `${join(root, "shim")}:${process.env["PATH"] ?? ""}` },
  });
  const status = result.status ?? -1;
  assert.notEqual(status, 0, "the guard exited 0 although its staged-list read crashed — the door failed open");
  assert.match(result.stderr, /COMMIT REFUSED/u);
  // The crash branch's OWN wording, not another branch's: a refusal earned
  // by a different check would satisfy everything above.
  assert.match(result.stderr, /staged file list could not be read/u);
});

test("DRIVEN: a staged RENAME of a code file out of every code-shaped path still stages the legs — both sides of a move are judged", () => {
  // With rename detection, `git diff --cached --name-only` names ONLY the new
  // path: moving `engine/src/mod.ts` to `attic/mod.txt` looked like a docs
  // change, and neither leg ran although every importer lost its module
  // (wf1a-correctness §3). The old path is a deletion, and deletions count.
  const root = compileFixtureRepository("pass");
  writeFile(root, "engine/src/mod.ts", "export const mod = 1;\n");
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  assert.equal(commit(root, "baseline").status, 0);
  assert.equal(existsSync(join(root, "witness.txt")), true, "the baseline ran NO compile leg — the witness mechanism is not live");
  rmSync(join(root, "witness.txt"));
  mkdirSync(join(root, "attic"));
  execFileSync("git", ["mv", "engine/src/mod.ts", "attic/mod.txt"], { cwd: root, stdio: "pipe" });
  const moved = commit(root, "move a code file to a non-code path");
  assert.equal(moved.status, 0, moved.stderr);
  assert.ok(
    bothStagedLegs(root, readFileSync(join(root, "witness.txt"), "utf8")),
    "a staged move of a code file ran no compile leg — only the new, non-code path was examined",
  );
});

test("DRIVEN: a killed guard's materialized tree is swept by the next guard — a live guard's tree is never touched", () => {
  const root = compileFixtureRepository("pass");
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  assert.equal(commit(root, "baseline").status, 0);
  const parent = join(root, ".bridlewise", "state", "commit-guard");
  // A pid that WAS a process and is not any more.
  const exited = spawnSync(process.execPath, ["-e", "0"]);
  assert.equal(exited.status, 0);
  const abandoned = join(parent, `staged-${String(exited.pid)}-1-abad0ed`);
  // A LIVE owner: this process, with its real start time (the owned name).
  const live = join(parent, ownedTemporaryName("staged-"));
  // A RECYCLED pid: this process's pid with another start time is a dead owner.
  const recycled = join(parent, `staged-${String(process.pid)}-1-5eed`);
  for (const directory of [abandoned, live, recycled]) writeFile(directory, "tree/file.ts", "export {};\n");
  writeFile(root, "src/next.ts", "export const next = 1;\n");
  execFileSync("git", ["add", "src/next.ts"], { cwd: root, stdio: "pipe" });
  assert.equal(commit(root, "a code commit materializes the staged tree").status, 0);
  assert.equal(existsSync(abandoned), false, "the abandoned tree of a dead guard survived the next guard");
  assert.equal(existsSync(recycled), false, "a tree whose pid was recycled by a later process survived (pid alone is not an owner)");
  assert.equal(existsSync(live), true, "a live guard's tree was removed");
  rmSync(live, { recursive: true, force: true });
});

/**
 * A fixture whose leg script FAILS when the materialized tree holds a
 * `src/*.ts` file containing BROKEN, or `src/user.ts` without `src/dep.ts`
 * (a side-effect import compiles against an EMPTY file, so only a missing one fails). What the
 * legs judge is then exactly the tree the materialization wrote.
 */
function contentJudgedRepository(): string {
  const root = compileFixtureRepository("pass");
  const script = `pwd >> "${root}/witness.txt"\n` +
    `if grep -qs BROKEN src/*.ts; then exit 3; fi\n` +
    `if [ -f src/user.ts ] && [ ! -e src/dep.ts ]; then exit 4; fi\n`;
  writeFile(root, "run-tc.sh", script);
  writeFile(root, "engine/run-tc.sh", script);
  writeFile(root, "src/a.ts", "export const a = 1;\n");
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  assert.equal(commit(root, "baseline").status, 0);
  assert.equal(existsSync(join(root, "witness.txt")), true, "the baseline ran NO compile leg — the witness mechanism is not live");
  return root;
}

/** `git commit` with extra arguments, as data. */
function commitWith(root: string, args: readonly string[]): Readonly<{ status: number; stderr: string }> {
  const result = spawnSync("git", ["commit", "-q", ...args], { cwd: root, encoding: "utf8", maxBuffer: 1 << 24 });
  return { status: result.status ?? -1, stderr: result.stderr };
}

function commitCount(root: string): string {
  return execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

test("DRIVEN: every commit form certifies the index git is COMMITTING — `-a`, `-- <path>` and `-i <path>` hand the hook a temporary GIT_INDEX_FILE", () => {
  // wf1c-correctness §3 (HIGH, reproduced): the materialization copied
  // `.git/index` with GIT_* stripped, so `git commit -a` and
  // `git commit -- <path>` certified the OLD index and committed a broken
  // file (exit 0). Each form below leaves the break UNSTAGED in `.git/index`.
  const root = contentJudgedRepository();
  for (const [form, args] of [
    ["commit -a", ["-a", "-m", "all tracked changes"]],
    ["commit -- <path>", ["-m", "only this path", "--", "src/a.ts"]],
    ["commit -i <path>", ["-m", "include this path", "-i", "src/a.ts"]],
  ] as const) {
    writeFile(root, "src/a.ts", "export const a = 'BROKEN';\n");
    const refused = commitWith(root, args);
    assert.notEqual(refused.status, 0, `\`git ${form}\` committed a tree whose leg fails — the guard judged another index`);
    assert.match(refused.stderr, /does not compile/u, form);
    assert.equal(commitCount(root), "1", `\`git ${form}\` landed although refused`);
  }
  // Control: the same unstaged break with a plain commit of ANOTHER staged
  // file is accepted — the plain form still judges `.git/index`.
  writeFile(root, "src/b.ts", "export const b = 2;\n");
  execFileSync("git", ["add", "src/b.ts"], { cwd: root, stdio: "pipe" });
  const accepted = commitWith(root, ["-m", "plain commit of a sound staged file"]);
  assert.equal(accepted.status, 0, `a plain commit was refused for an unstaged break: ${accepted.stderr}`);
  // …and `-a` with the break REPAIRED is accepted (the form itself is fine).
  writeFile(root, "src/a.ts", "export const a = 3;\n");
  assert.equal(commitWith(root, ["-a", "-m", "all tracked, sound"]).status, 0);
});

test("DRIVEN: an intent-to-add file is NOT in the certified tree — the commit does not carry it, so neither does the materialization", () => {
  // `git add -N src/dep.ts` puts an entry in the index that `write-tree`
  // omits; `checkout-index --all` wrote it as an empty file, so a staged
  // `src/user.ts` depending on it looked sound (wf1c-correctness §3).
  const root = contentJudgedRepository();
  writeFile(root, "src/dep.ts", "export const dep = 1;\n");
  writeFile(root, "src/user.ts", "import './dep.ts';\n");
  execFileSync("git", ["add", "src/user.ts"], { cwd: root, stdio: "pipe" });
  execFileSync("git", ["add", "-N", "src/dep.ts"], { cwd: root, stdio: "pipe" });
  const refused = commit(root, "user staged, its dependency only intended");
  assert.notEqual(refused.status, 0, "a commit that does not carry an imported module passed — the intent-to-add entry was certified as a file");
  assert.equal(commitCount(root), "1");
  execFileSync("git", ["add", "src/dep.ts"], { cwd: root, stdio: "pipe" });
  const accepted = commit(root, "both staged");
  assert.equal(accepted.status, 0, `the real dependency did not satisfy the leg: ${accepted.stderr}`);
});

test("DRIVEN: in a LINKED WORKTREE and under --git-dir/--work-tree the engine leg judges the ENGINE — the hook's GIT_DIR never relocates it", () => {
  // wf1b-correctness §2 N1 (HIGH, reproduced): git hands the hook GIT_DIR
  // (a linked worktree) or GIT_DIR + GIT_WORK_TREE (the flags); the guard
  // asked `--show-toplevel` from its engine WITH that environment, got the
  // engine folder itself, and ran the web leg twice — an engine break
  // committed with exit 0, in every linked worktree (the live checkout is one).
  const root = compileFixtureRepository("pass");
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  assert.equal(commit(root, "baseline").status, 0);
  assert.ok(bothStagedLegs(root, readFileSync(join(root, "witness.txt"), "utf8")), "the main checkout's baseline did not run both legs");
  const worktree = `${root}-linked`;
  execFileSync("git", ["worktree", "add", "-q", "-b", "linked", worktree], { cwd: root, stdio: "pipe" });
  try {
    // An ENGINE-only break: only the engine leg can see it.
    const engineBreak = `pwd >> "${root}/witness.txt"\nexit 3\n`;
    for (const [form, run] of [
      ["linked worktree", (): Readonly<{ status: number; stderr: string }> => commitWith(worktree, ["-a", "-m", "engine break from a linked worktree"])],
      ["--git-dir/--work-tree", (): Readonly<{ status: number; stderr: string }> => {
        const result = spawnSync("git", ["--git-dir", join(root, ".git"), "--work-tree", root, "commit", "-q", "-a", "-m", "engine break via flags"], {
          cwd: createTempDir("ch-commit-elsewhere-"), encoding: "utf8", maxBuffer: 1 << 24,
        });
        return { status: result.status ?? -1, stderr: result.stderr };
      }],
    ] as const) {
      const checkout = form === "linked worktree" ? worktree : root;
      rmSync(join(root, "witness.txt"), { force: true });
      writeFile(checkout, "engine/run-tc.sh", engineBreak);
      writeFile(checkout, "engine/src/code.ts", `export const form = ${JSON.stringify(form)};\n`);
      execFileSync("git", ["add", "-A"], { cwd: checkout, stdio: "pipe" });
      const before = commitCount(checkout);
      const refused = run();
      assert.notEqual(refused.status, 0, `${form}: an ENGINE compile break was committed — the engine leg did not run`);
      assert.match(refused.stderr, /staged engine tree does not compile/u, form);
      assert.equal(commitCount(checkout), before, `${form}: the refused commit landed`);
      assert.ok(
        bothStagedLegs(root, readFileSync(join(root, "witness.txt"), "utf8"), checkout),
        `${form}: the legs were not the staged top and its engine/ — the witness records ${readFileSync(join(root, "witness.txt"), "utf8")}`,
      );
      writeFile(checkout, "engine/run-tc.sh", `pwd >> "${root}/witness.txt"\n`);
      execFileSync("git", ["add", "-A"], { cwd: checkout, stdio: "pipe" });
      assert.equal(run().status, 0, `${form}: the repaired engine was refused`);
    }
  } finally {
    execFileSync("git", ["worktree", "remove", "--force", worktree], { cwd: root, stdio: "pipe" });
  }
});

test("DRIVEN: git's automatic MERGE commit runs the same door (pre-merge-commit) — a merge bringing a break is REFUSED", () => {
  // wf1b-correctness §2 N2: `git merge --no-ff` without a conflict runs no
  // `pre-commit`; the break it brought committed with exit 0.
  const root = contentJudgedRepository();
  execFileSync("git", ["switch", "-q", "-c", "side"], { cwd: root, stdio: "pipe" });
  writeFile(root, "src/side.ts", "export const side = 'BROKEN';\n");
  execFileSync("git", ["add", "src/side.ts"], { cwd: root, stdio: "pipe" });
  assert.equal(commitWith(root, ["--no-verify", "-m", "an uncertified side commit"]).status, 0);
  execFileSync("git", ["switch", "-q", "-"], { cwd: root, stdio: "pipe" });
  const before = commitCount(root);
  const merged = spawnSync("git", ["merge", "--no-ff", "-q", "-m", "merge the side", "side"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 24 });
  assert.notEqual(merged.status, 0, "an automatic merge commit carrying a break was made — no hook ran");
  assert.match(merged.stderr, /does not compile/u);
  assert.equal(commitCount(root), before, "the refused merge commit landed");
  execFileSync("git", ["merge", "--abort"], { cwd: root, stdio: "pipe" });
});

test("DRIVEN: a commit that DELETES a guarded hook, or stages one that no longer runs the guard, is REFUSED", () => {
  // wf1b-correctness §2 N5: `git rm --cached` of the hook and an index-only
  // rewrite to `exit 0` both committed (the real hook still ran, and passed).
  const root = compileFixtureRepository("pass");
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  assert.equal(commit(root, "baseline").status, 0);
  for (const hook of GUARDED_HOOKS) {
    const path = `${HOOKS_DIRECTORY}/${hook}`;
    execFileSync("git", ["rm", "-q", "--cached", "--", path], { cwd: root, stdio: "pipe" });
    const deleted = commit(root, `delete ${hook}`);
    assert.notEqual(deleted.status, 0, `a commit deleting ${path} was accepted`);
    assert.match(deleted.stderr, new RegExp(`${path}: deleted`, "u"));
    execFileSync("git", ["add", "--", path], { cwd: root, stdio: "pipe" });
    // `exit 0`; the substring bypass wf1b2-design G6 found (the program named
    // in a comment beside `exit 0`); and WF-1b3b verify H1's two committed
    // bypasses of the structural parse: an interpreter that never runs the
    // body (`#!/bin/true`), and a comment ending in `\` hiding `exit 0`.
    const canonical = readFileSync(join(root, path), "utf8");
    for (const text of [
      "#!/bin/sh\nexit 0\n",
      `#!/bin/sh\n# ${"commit-guard.ts"}\nexit 0\n`,
      canonical.replace(/^#!\/bin\/sh\n/u, "#!/bin/true\n"),
      canonical.replace(/^#!\/bin\/sh\n/u, "#!/bin/sh\n# note \\\nexit 0\n"),
    ]) {
      const neutered = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: root, input: text, encoding: "utf8" }).trim();
      execFileSync("git", ["update-index", "--cacheinfo", `100755,${neutered},${path}`], { cwd: root, stdio: "pipe" });
      const rewritten = commit(root, `neuter ${hook}`);
      assert.notEqual(rewritten.status, 0, `a commit staging ${path} as ${JSON.stringify(text)} was accepted`);
      assert.match(rewritten.stderr, /no longer hands over to commit-guard\.ts/u);
      execFileSync("git", ["add", "--", path], { cwd: root, stdio: "pipe" });
    }
    assert.equal(commitCount(root), "1");
  }
  // A hook edited but still handing over is an ordinary change.
  writeFile(root, join(HOOKS_DIRECTORY, HOOK_NAME), `${readFileSync(join(root, HOOKS_DIRECTORY, HOOK_NAME), "utf8")}# a comment\n`);
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  const accepted = commit(root, "comment in the hook");
  assert.equal(accepted.status, 0, accepted.stderr);
});

test("DRIVEN: a commit that turns a workflow lesson to acted must name it in a Lesson: trailer (commit-msg)", () => {
  const root = compileFixtureRepository("pass");
  const path = "docs/trackers/workflow-lessons/2026-01-01-x.md";
  const lesson = (status: string): string => `---\nid: L-2026-01-01-x\ndate: 2026-01-01\nsource: s\nkind: guard\nstatus: ${status}\n---\n## Observation\n## Lesson\n## Change\n`;
  writeFile(root, path, lesson("pending\nroute: T-1"));
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  assert.equal(commit(root, "baseline").status, 0);
  writeFile(root, path, lesson("acted\nacted_in: [run-tc.sh]"));
  execFileSync("git", ["add", "--", path], { cwd: root, stdio: "pipe" });
  const unnamed = commit(root, "act on the lesson\n\nLesson: L-2026-01-01-other");
  assert.notEqual(unnamed.status, 0, "a commit acting on a lesson without its trailer was accepted");
  assert.match(unnamed.stderr, /does not name them:\n {2}- L-2026-01-01-x/u);
  assert.equal(commitCount(root), "1");
  // A commented-out line is not a trailer.
  const commented = commit(root, "act on the lesson\n\n# Lesson: L-2026-01-01-x");
  assert.notEqual(commented.status, 0, "a commented-out trailer was accepted");
  const named = commit(root, "act on the lesson\n\nLesson: L-2026-01-01-x");
  assert.equal(named.status, 0, named.stderr);
  assert.match(execFileSync("git", ["log", "-1", "--format=%B"], { cwd: root, encoding: "utf8" }), /^Lesson: L-2026-01-01-x$/mu);
  // A later edit of an already-acted lesson needs no trailer.
  writeFile(root, path, `${lesson("acted\nacted_in: [run-tc.sh]")}more\n`);
  execFileSync("git", ["add", "--", path], { cwd: root, stdio: "pipe" });
  assert.equal(commit(root, "edit the acted lesson").status, 0);
});

/** A lesson file's text in the given status (`acted` names a tracked path). */
function lessonText(id: string, status: "pending" | "acted"): string {
  const state = status === "acted" ? "acted\nacted_in: [run-tc.sh]" : "pending\nroute: T-1";
  return `---\nid: L-${id}\ndate: 2026-01-01\nsource: s\nkind: guard\nstatus: ${state}\n---\n## Observation\n## Lesson\n## Change\n`;
}

/** A fixture whose baseline commit holds the pending lesson `id`; returns the root and the default branch. */
function lessonFixture(id: string): Readonly<{ root: string; path: string; main: string }> {
  const root = compileFixtureRepository("pass");
  const path = `docs/trackers/workflow-lessons/${id}.md`;
  writeFile(root, path, lessonText(id, "pending"));
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  assert.equal(commit(root, "baseline").status, 0);
  return { root, path, main: execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, encoding: "utf8" }).trim() };
}

function git(root: string, ...args: readonly string[]): Readonly<{ status: number; stderr: string }> {
  const result = spawnSync("git", [...args], { cwd: root, encoding: "utf8", maxBuffer: 1 << 24 });
  return { status: result.status ?? -1, stderr: result.stderr };
}

test("DRIVEN: the records a commit writes name paths it holds — judged by that commit, never reopened by a later deletion (commit-msg)", () => {
  // wf-1b3a-design M2: the whole-tree format test judged acted_in against
  // TODAY's tree, so any later rename of a named file turned closed records red.
  const { root, path } = lessonFixture("2026-01-01-held");
  writeFile(root, path, lessonText("2026-01-01-held", "acted").replace("[run-tc.sh]", "[no/such/file.ts]"));
  execFileSync("git", ["add", "--", path], { cwd: root, stdio: "pipe" });
  const unheld = commit(root, "act on the lesson\n\nLesson: L-2026-01-01-held");
  assert.notEqual(unheld.status, 0, "a lesson naming a path the commit does not hold was committed");
  assert.match(unheld.stderr, /no\/such\/file\.ts is not a path git holds/u);
  writeFile(root, path, lessonText("2026-01-01-held", "acted"));
  execFileSync("git", ["add", "--", path], { cwd: root, stdio: "pipe" });
  assert.equal(commit(root, "act on the lesson\n\nLesson: L-2026-01-01-held").status, 0);
  // The named file is later moved away: the closed lesson is not reopened.
  execFileSync("git", ["mv", "run-tc.sh", "run-typecheck.sh"], { cwd: root, stdio: "pipe" });
  writeFile(root, "package.json", `{"name":"x","private":true,"scripts":{"typecheck":"sh run-typecheck.sh"}}\n`);
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  const moved = commit(root, "rename the typecheck script");
  assert.equal(moved.status, 0, moved.stderr);
});

test("DRIVEN: a --no-ff MERGE of a branch whose own commit acted on a lesson (with its trailer) needs no trailer; one whose commit had none is still REFUSED", () => {
  // wf-1b3a-design H1: commit-msg runs for `git merge` too, and the lesson
  // compared to the first parent alone looked "turned to acted" by the merge.
  const { root, path, main } = lessonFixture("2026-01-01-merged");
  git(root, "checkout", "-q", "-b", "side");
  writeFile(root, path, lessonText("2026-01-01-merged", "acted"));
  execFileSync("git", ["add", "--", path], { cwd: root, stdio: "pipe" });
  assert.equal(commit(root, "act on the lesson\n\nLesson: L-2026-01-01-merged").status, 0);
  git(root, "checkout", "-q", main);
  writeFile(root, "note.md", "unrelated\n");
  execFileSync("git", ["add", "--", "note.md"], { cwd: root, stdio: "pipe" });
  assert.equal(commit(root, "an unrelated change on the main line").status, 0);
  const merged = git(root, "merge", "--no-ff", "-q", "-m", "merge: workspace side", "side");
  assert.equal(merged.status, 0, `the merge of a branch that already named its lesson was refused:\n${merged.stderr}`);

  // The branch's commit acted WITHOUT the trailer (landed around the hook):
  // the merge is the first commit on this line to carry that act, and it is refused.
  const other = lessonFixture("2026-01-01-unnamed");
  git(other.root, "checkout", "-q", "-b", "side");
  writeFile(other.root, other.path, lessonText("2026-01-01-unnamed", "acted"));
  execFileSync("git", ["add", "--", other.path], { cwd: other.root, stdio: "pipe" });
  assert.equal(git(other.root, "commit", "-q", "--no-verify", "-m", "act without the trailer").status, 0);
  git(other.root, "checkout", "-q", other.main);
  writeFile(other.root, "note.md", "unrelated\n");
  execFileSync("git", ["add", "--", "note.md"], { cwd: other.root, stdio: "pipe" });
  assert.equal(commit(other.root, "an unrelated change on the main line").status, 0);
  const before = commitCount(other.root);
  const refused = git(other.root, "merge", "--no-ff", "-q", "-m", "merge: workspace side", "side");
  assert.notEqual(refused.status, 0, "a merge bringing an unnamed act was accepted");
  assert.match(refused.stderr, /does not name them:\n {2}- L-2026-01-01-unnamed/u);
  assert.equal(commitCount(other.root), before, "the refused merge commit landed");
  // The route: the merge stays in progress; conclude it naming the lesson.
  const concluded = commit(other.root, "merge: workspace side\n\nLesson: L-2026-01-01-unnamed");
  assert.equal(concluded.status, 0, concluded.stderr);
});

test("DRIVEN: the trailer is git's own parse — a verbose (-v) editor commit keeps it; a lower-case key is refused and named case-sensitive", () => {
  const { root, path } = lessonFixture("2026-01-01-verbose");
  writeFile(root, path, lessonText("2026-01-01-verbose", "acted"));
  execFileSync("git", ["add", "--", path], { cwd: root, stdio: "pipe" });
  const lower = commit(root, "act on the lesson\n\nlesson: L-2026-01-01-verbose");
  assert.notEqual(lower.status, 0, "a lower-case key, which git log --grep '^Lesson:' never finds, was accepted");
  assert.match(lower.stderr, /the key is case-sensitive/u);
  // wf-1b3a-correctness M1: `git commit -v` puts the diff under a scissors
  // line (a `#` line); dropping every `#` line first made the diff the last
  // paragraph, and the real trailer was never found. The editor keeps git's template.
  const verbose = spawnSync("git", ["commit", "-q", "-v", "-e", "-m", "act on the lesson", "-m", "Lesson: L-2026-01-01-verbose"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_EDITOR: "true" },
    maxBuffer: 1 << 24,
  });
  assert.equal(verbose.status, 0, `a verbose commit naming its lesson was refused:\n${verbose.stderr}`);
});

test("DRIVEN: an --amend that drops a lesson's trailer is REPORTED by post-commit (git tells commit-msg nothing of an amend)", () => {
  const { root, path } = lessonFixture("2026-01-01-amended");
  writeFile(root, join(HOOKS_DIRECTORY, "post-commit"), `#!/bin/sh\nexec node --experimental-strip-types ${JSON.stringify(join(INTEGRATION_ROOT, "scripts", "post-commit.ts"))} "$(git rev-parse --show-toplevel)"\n`);
  chmodSync(join(root, HOOKS_DIRECTORY, "post-commit"), 0o755);
  writeFile(root, path, lessonText("2026-01-01-amended", "acted"));
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  const named = commit(root, "act on the lesson\n\nLesson: L-2026-01-01-amended");
  assert.equal(named.status, 0, named.stderr);
  assert.doesNotMatch(named.stderr, /LESSON TRAILER MISSING/u, "a commit naming its lesson was reported");
  const amended = git(root, "commit", "-q", "--amend", "-m", "act on the lesson (reworded, trailer dropped)");
  for (const part of ["LESSON TRAILER MISSING", "- L-2026-01-01-amended", "Repair it now: git commit --amend"]) {
    assert.ok(amended.stderr.includes(part), `an amend dropping the trailer went unreported (no "${part}"): ${amended.stderr}`);
  }
  // The repair the report names clears it.
  const repaired = git(root, "commit", "-q", "--amend", "-m", "act on the lesson\n\nLesson: L-2026-01-01-amended");
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.doesNotMatch(repaired.stderr, /LESSON TRAILER MISSING/u);
});

test("DRIVEN: a commit that removes the execute bit from a tracked hook is REFUSED — git would silently stop running it", () => {
  const root = compileFixtureRepository("pass");
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  assert.equal(commit(root, "baseline").status, 0);
  execFileSync("git", ["update-index", "--chmod=-x", "--", join(HOOKS_DIRECTORY, HOOK_NAME)], { cwd: root, stdio: "pipe" });
  const refused = commit(root, "drop the hook's execute bit");
  assert.notEqual(refused.status, 0, "a commit disabling the commit hook in every clone was ACCEPTED");
  assert.match(refused.stderr, /disables a tracked hook/u);
  assert.match(refused.stderr, /removes the execute bit/u);
  assert.match(refused.stderr, new RegExp(`${HOOKS_DIRECTORY}/${HOOK_NAME}`, "u"));
  assert.equal(commitCount(root), "1");
  // A non-executable document beside the hooks is not a hook: adding one passes.
  execFileSync("git", ["update-index", "--chmod=+x", "--", join(HOOKS_DIRECTORY, HOOK_NAME)], { cwd: root, stdio: "pipe" });
  writeFile(root, join(HOOKS_DIRECTORY, "README.md"), "# hooks\n");
  execFileSync("git", ["add", join(HOOKS_DIRECTORY, "README.md")], { cwd: root, stdio: "pipe" });
  const accepted = commit(root, "a plain document beside the hooks");
  assert.equal(accepted.status, 0, accepted.stderr);
});

test("DRIVEN: an index entry that left its recorded baseline and is not part of the commit is WARNED about — never a refusal", () => {
  const root = compileFixtureRepository("pass");
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  assert.equal(commit(root, "baseline").status, 0);
  writeFile(root, "src/committed.ts", "export const committed = 1;\n");
  writeFile(root, "src/inherited.ts", "export const inherited = 1;\n");
  execFileSync("git", ["add", "src/committed.ts", "src/inherited.ts"], { cwd: root, stdio: "pipe" });
  recordIndexBaseline(root);
  // The slip: an inherited staged entry leaves the index, nobody commits it.
  execFileSync("git", ["restore", "--staged", "src/inherited.ts"], { cwd: root, stdio: "pipe" });
  const warned = commitWith(root, ["-m", "commit only src/committed.ts", "--", "src/committed.ts"]);
  assert.equal(warned.status, 0, warned.stderr);
  assert.match(warned.stderr, /INDEX WARNING — staged blobs recorded in the live index baseline are no longer staged/u);
  assert.match(warned.stderr, /src\/inherited\.ts/u);
  assert.match(warned.stderr, /harness index repair/u);
  assert.doesNotMatch(warned.stderr, /- src\/committed\.ts/u, "a path the commit carries whole is not lost");
});

test("DRIVEN: a commit that itself drops a protected staged blob (a committed `git rm --cached` of an inherited modification) is WARNED about", () => {
  // wf1b-correctness §2 N4: the natural slip was committed with no word —
  // the change was "part of the commit", and after it nothing says so again.
  const root = compileFixtureRepository("pass");
  writeFile(root, "docs/tracked.md", "# committed\n");
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "pipe" });
  assert.equal(commit(root, "baseline").status, 0);
  writeFile(root, "docs/tracked.md", "# committed\nan inherited staged edit\n");
  execFileSync("git", ["add", "docs/tracked.md"], { cwd: root, stdio: "pipe" });
  recordIndexBaseline(root);
  execFileSync("git", ["rm", "-q", "--cached", "docs/tracked.md"], { cwd: root, stdio: "pipe" });
  const warned = commit(root, "commits the deletion");
  assert.equal(warned.status, 0, warned.stderr);
  assert.match(warned.stderr, /INDEX WARNING/u);
  assert.match(warned.stderr, /docs\/tracked\.md \(THIS commit records the change\)/u);
});

const BOUNDED_LEG_START = "// --- bounded typecheck leg (extracted and driven by engine/test/prevention/commit-compile-door.test.ts) ---";
const BOUNDED_LEG_END = "// --- end bounded typecheck leg ---";

test("DRIVEN: a compile leg that outlives its bound is KILLED and REFUSED — a hanging compiler cannot hold a commit", () => {
  const source = readFileSync(COMMIT_GUARD, "utf8");
  const from = source.indexOf(BOUNDED_LEG_START);
  const to = source.indexOf(BOUNDED_LEG_END);
  assert.ok(from !== -1 && to > from, "the guard carries the bounded typecheck leg block this test drives");
  // The door must resolve the bound from the harness's own typecheck timeout
  // and refuse the timed-out outcome by name — not merely print its output.
  assert.match(source, /runTypecheckLeg\(stagedTree, "web", timeoutMs\)/u);
  assert.match(source, /runTypecheckLeg\(join\(stagedTree, engineRelative\), "engine", timeoutMs\)/u);
  assert.match(source, /harness\?\.typecheckTimeoutMs/u);
  assert.match(source, /outcome\.timedOut/u);
  assert.match(source, /typecheckLegRefusal\(outcome\)/u);

  // Drive the REAL block, extracted from the guard's source, with a short
  // bound: a fixture `typecheck` that sleeps for a minute must be killed and
  // answered as a timed-out refusal well before it finishes.
  const root = createTempDir("ch-typecheck-bound-");
  const block = source.slice(from + BOUNDED_LEG_START.length, to);
  const leg = join(root, "typecheck-leg.ts");
  writeFileSync(leg, `import { spawn } from "node:child_process";\n${block}\nexport { runTypecheckLeg, typecheckLegRefusal };\n`);
  const tree = join(root, "tree");
  writeFile(root, "tree/package.json", `${JSON.stringify({ name: "bounded-leg-fixture", private: true, scripts: { typecheck: 'node -e "setTimeout(() => {}, 60000)"' } })}\n`);
  const driver = join(root, "drive.ts");
  writeFileSync(driver, [
    `import { runTypecheckLeg, typecheckLegRefusal } from ${JSON.stringify(pathToFileURL(leg).href)};`,
    "const started = Date.now();",
    `const outcome = await runTypecheckLeg(${JSON.stringify(tree)}, "web", 250);`,
    "process.stdout.write(JSON.stringify({ timedOut: outcome.timedOut, status: outcome.status, elapsedMs: Date.now() - started, refusal: typecheckLegRefusal(outcome) }));",
    "",
  ].join("\n"));
  const run = spawnSync(process.execPath, ["--experimental-strip-types", driver], { encoding: "utf8", timeout: 20_000 });
  assert.equal(run.status, 0, `the bounded-leg driver failed:\n${run.stderr}`);
  const outcome = JSON.parse(run.stdout);
  assert.equal(outcome.timedOut, true, "the leg was not killed at its bound");
  assert.equal(outcome.status, null, "a killed leg must not report an exit status");
  assert.ok(outcome.elapsedMs < 10_000, `the leg outlived its bound: ${String(outcome.elapsedMs)}ms`);
  assert.match(outcome.refusal, /remained unfinished after its 250ms bound/u);
});
