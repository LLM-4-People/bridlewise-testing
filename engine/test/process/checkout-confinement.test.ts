/**
 * THE CHECKOUT IS READ-ONLY TO A TEST RUN (#293's class): under the one
 * supervisor's `readOnlyCheckout`, the command and every descendant may change
 * nothing in the checkout, its git directories or borrowed objects — writes,
 * chmods, utimes and HEAD moves are all EROFS — while the declared state
 * directories and everything outside the checkout stay writable. Driven on
 * scratch checkouts (a repository and a linked worktree whose git directory
 * lies outside it), and on the live checkout for what must keep working under
 * the bind: the configuration bootstrap and an up-to-date make.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { ensureTestProcessSupervisor } from "../../guardian/build.ts";
import { checkoutConfinement, superviseCommand } from "../../src/process/supervised-run.ts";
import { createTempDir } from "../support/temp-dir.ts";

const ENGINE = new URL("../..", import.meta.url).pathname.replace(/\/$/u, "");
const LIVE = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: ENGINE, encoding: "utf8" }).trim();

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A scratch checkout with one commit, and a linked worktree of it (its git directory lives in the repository). */
function scratchCheckouts(): Readonly<{ repository: string; worktree: string }> {
  const folder = createTempDir("confinement-");
  const repository = join(folder, "repository");
  mkdirSync(repository);
  git(repository, "init", "-q", "-b", "main");
  writeFileSync(join(repository, "tracked.txt"), "tracked\n");
  writeFileSync(join(repository, "config.json"), "{}\n", { mode: 0o600 });
  writeFileSync(join(repository, ".gitignore"), ".bridlewise/\n");
  git(repository, "add", "-A");
  git(repository, "commit", "-q", "-m", "base");
  const worktree = join(folder, "worktree");
  git(repository, "worktree", "add", "-q", "-b", "side", worktree);
  return { repository, worktree };
}

/** `script` (sh) run under the one supervisor with `checkout` read-only; its stdout and exit code. */
async function confined(checkout: string, script: string, readOnly = true): Promise<Readonly<{ stdout: string; exitCode: number }>> {
  const out: Buffer[] = [];
  const run = await superviseCommand({
    supervisor: ensureTestProcessSupervisor(), command: "sh", args: ["-c", script], cwd: checkout,
    hardCeilingMs: 60_000, killGraceMs: 2_000,
    onStdout: (chunk) => out.push(chunk), onStderr: (chunk) => out.push(chunk),
    ...(readOnly ? { readOnlyCheckout: checkout } : {}),
  });
  return { stdout: Buffer.concat(out).toString("utf8"), exitCode: run.exitCode };
}

const HEAD_MOVES = [
  "git -c user.name=t -c user.email=t@example.invalid commit -q --allow-empty -m moved; echo commit=$?",
  "git update-ref refs/heads/main HEAD~0 HEAD; echo update_ref=$?",
  "git -c user.name=t -c user.email=t@example.invalid stash -q; echo stash=$?",
].join("\n");

test("under the bind every change to the checkout is EROFS at its own line; the state directory and the outside stay writable", async () => {
  const { repository } = scratchCheckouts();
  const outside = createTempDir("confinement-outside-");
  const before = statSync(join(repository, "config.json"), { bigint: true });
  const { stdout } = await confined(repository, [
    "echo x >> tracked.txt; echo write=$?",
    "chmod 600 config.json; echo chmod=$?",
    "touch -a config.json; echo utime=$?",
    "ln tracked.txt alias.txt; echo link=$?",
    "sh -c 'echo y > child.txt'; echo child=$?",
    "node -e 'require(\"node:fs\").writeFileSync(\"node.txt\", \"n\")' 2>/dev/null; echo node=$?",
    "echo s > .bridlewise/state.txt; echo state=$?",
    `echo o > ${outside}/outside.txt; echo outside=$?`,
  ].join("\n"));
  for (const refused of ["write", "chmod", "utime", "link", "child", "node"]) assert.match(stdout, new RegExp(`^${refused}=[1-9]`, "mu"), `${refused} was not refused:\n${stdout}`);
  assert.match(stdout, /Read-only file system/u, stdout);
  assert.match(stdout, /^state=0$/mu, stdout);
  assert.match(stdout, /^outside=0$/mu, stdout);
  const after = statSync(join(repository, "config.json"), { bigint: true });
  assert.equal(after.ctimeNs, before.ctimeNs, "the configuration's ctime moved under the bind");
  assert.equal(git(repository, "status", "--porcelain"), "", "the checkout changed under the bind");
});

test("a HEAD move — commit, update-ref, stash — is refused under the bind, in a repository AND in a linked worktree whose git directory lies outside it", async () => {
  const { repository, worktree } = scratchCheckouts();
  for (const checkout of [repository, worktree]) {
    const head = git(checkout, "rev-parse", "HEAD");
    const branch = git(checkout, "symbolic-ref", "--short", "HEAD");
    // A change for `git stash` to take, made before the run (outside the bind).
    writeFileSync(join(checkout, "tracked.txt"), "changed before the run\n");
    const { stdout } = await confined(checkout, HEAD_MOVES);
    for (const move of ["commit", "update_ref", "stash"]) assert.match(stdout, new RegExp(`^${move}=[1-9]`, "mu"), `${move} was not refused in ${checkout}:\n${stdout}`);
    assert.equal(git(checkout, "rev-parse", "HEAD"), head, `HEAD moved in ${checkout}`);
    assert.equal(git(checkout, "symbolic-ref", "--short", "HEAD"), branch);
    assert.equal(git(checkout, "stash", "list"), "", `a stash was recorded in ${checkout}`);
    assert.equal(git(checkout, "status", "--porcelain"), "M tracked.txt", `the change before the run was not left in place in ${checkout}`);
  }
});

test("a repository a test makes in its own temporary folder still inits and commits under the bind", async () => {
  const { repository } = scratchCheckouts();
  const own = createTempDir("confinement-own-repo-");
  const { stdout } = await confined(repository, [
    `cd ${own} && git init -q && echo a > a.txt && git add a.txt && git -c user.name=t -c user.email=t@example.invalid commit -q -m own; echo own_commit=$?`,
  ].join("\n"));
  assert.match(stdout, /^own_commit=0$/mu, stdout);
});

test("THE CONTROL: without the bind the same writes and HEAD move land (the bind is what refuses them)", async () => {
  const { repository } = scratchCheckouts();
  const head = git(repository, "rev-parse", "HEAD");
  const { stdout } = await confined(repository, ["echo x >> tracked.txt; echo write=$?", HEAD_MOVES].join("\n"), false);
  assert.match(stdout, /^write=0$/mu, stdout);
  assert.notEqual(git(repository, "rev-parse", "HEAD"), head, "the control's commit did not land");
});

test("on the LIVE checkout under the bind: the configuration bootstrap reads it (no mountpoint refusal) and an up-to-date make writes nothing", async () => {
  const guardianBuild = join(ENGINE, "guardian", "build");
  const before = statSync(guardianBuild, { bigint: true });
  const { stdout, exitCode } = await confined(LIVE, [
    `cd ${ENGINE} && node --input-type=module -e 'const { loadPinnedConfigSnapshot } = await import("./src/kernel/config.ts"); loadPinnedConfigSnapshot(); console.log("bootstrap=ok")'; echo bootstrap_exit=$?`,
    `make --no-print-directory -C ${join(ENGINE, "guardian")} test_process_supervisor; echo make=$?`,
  ].join("\n"));
  assert.equal(exitCode, 0, stdout);
  assert.match(stdout, /^bootstrap=ok$/mu, stdout);
  assert.match(stdout, /^make=0$/mu, stdout);
  const after = statSync(guardianBuild, { bigint: true });
  assert.equal(after.mtimeNs, before.mtimeNs, "an in-run make changed the build folder");
});

test("a host that refuses the confinement is a typed refusal naming its fix, never an unconfined run", () => {
  const folder = createTempDir("confinement-refused-");
  const fake = join(folder, "refusing-supervisor");
  writeFileSync(fake, "#!/bin/sh\necho 'test supervisor: confinement refused: unshare a user and mount namespace: Operation not permitted' >&2\nexit 125\n");
  chmodSync(fake, 0o755);
  const { repository } = scratchCheckouts();
  assert.throws(() => checkoutConfinement(fake, repository), (error: unknown) =>
    (error as { code?: string }).code === "test_confinement_unavailable" && /no test runs/u.test((error as Error).message) && /Operation not permitted/u.test((error as Error).message));
});

test("vite's scratch is writable under the bind and nothing beside it in node_modules is; a link planted at .vite refuses the run", async () => {
  const { repository } = scratchCheckouts();
  mkdirSync(join(repository, "node_modules", "some-package"), { recursive: true });
  writeFileSync(join(repository, ".gitignore"), ".bridlewise/\nnode_modules/\n");
  const { stdout } = await confined(repository, [
    "echo t > node_modules/.vite-temp/config.mjs; echo vite_temp=$?",
    "mkdir -p node_modules/.vite/vitest && echo c > node_modules/.vite/vitest/results.json; echo vite_cache=$?",
    "echo x > node_modules/some-package/index.js; echo beside=$?",
    "echo x > node_modules/planted.js; echo node_modules=$?",
  ].join("\n"));
  assert.match(stdout, /^vite_temp=0$/mu, stdout);
  assert.match(stdout, /^vite_cache=0$/mu, stdout);
  assert.match(stdout, /^beside=[1-9]/mu, stdout);
  assert.match(stdout, /^node_modules=[1-9]/mu, stdout);

  const planted = scratchCheckouts().repository;
  mkdirSync(join(planted, "node_modules"), { recursive: true });
  symlinkSync(join(planted, "tracked.txt"), join(planted, "node_modules", ".vite"));
  assert.throws(() => checkoutConfinement(ensureTestProcessSupervisor(), planted), (error: unknown) =>
    (error as { code?: string }).code === "test_confinement_writable_unsafe" && /a link/u.test((error as Error).message));
});
