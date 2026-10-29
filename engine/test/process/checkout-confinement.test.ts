/**
 * THE CONFINED TEST RUN (decision TEST-CONFINEMENT-SELF-BIND; the user's rule
 * that a malicious module cannot bypass core): through the one test-execution
 * door (`runTestCommand`), a command and every descendant see the whole
 * filesystem read-only but their own scratch root and the checkout's declared
 * writable places; no same-user service is reachable by path or network; the
 * mounts are locked. Driven on fixture checkouts in the declared fixture root
 * (outside the enclosing run's scratch, so their confinement is real) and on
 * the live checkout, and on the native supervisor directly, so each of its own
 * refusals has a test that does not lean on the door's first check.
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import { createServer as createUnixServer } from "node:net";
import { join } from "node:path";
import test from "node:test";

import { ensureTestProcessSupervisor } from "../../guardian/build.ts";
import { runTestCommand, testConfinement } from "../../src/process/supervised-run.ts";
import { createRepositoryLocalTemporaryDirectory } from "../support/repository-local-temporary.ts";
import { createTempDir } from "../support/temp-dir.ts";

const ENGINE = new URL("../..", import.meta.url).pathname.replace(/\/$/u, "");
const LIVE = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: ENGINE, encoding: "utf8" }).trim();
const SUPERVISOR = ensureTestProcessSupervisor();

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A fixture checkout with one commit and a linked worktree, in the declared fixture root (outside the run's scratch). */
function fixtureCheckouts(): Readonly<{ repository: string; worktree: string }> {
  const folder = createRepositoryLocalTemporaryDirectory("confinement-");
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

/** `script` (sh) run through the one test-execution door in `checkout`; its output and exit code. */
async function confined(checkout: string, script: string): Promise<Readonly<{ stdout: string; exitCode: number }>> {
  const out: Buffer[] = [];
  const run = await runTestCommand({
    supervisor: SUPERVISOR, checkout, command: "sh", args: ["-c", script], cwd: checkout,
    hardCeilingMs: 60_000, killGraceMs: 2_000,
    onStdout: (chunk) => out.push(chunk), onStderr: (chunk) => out.push(chunk),
  });
  return { stdout: Buffer.concat(out).toString("utf8"), exitCode: run.exitCode };
}

const refused = (stdout: string, name: string): void => assert.match(stdout, new RegExp(`^${name}=[1-9]`, "mu"), `${name} was not refused:\n${stdout}`);
const taken = (stdout: string, name: string): void => assert.match(stdout, new RegExp(`^${name}=0$`, "mu"), `${name} was not taken:\n${stdout}`);

test("the whole filesystem is read-only to a confined run: the checkout (write, chmod, utime, link, a child, node), beside it, HOME and the trusted state; its scratch and the declared places take writes", async () => {
  const { repository } = fixtureCheckouts();
  mkdirSync(join(repository, ".bridlewise", "state"), { recursive: true });
  const before = statSync(join(repository, "config.json"), { bigint: true });
  const { stdout } = await confined(repository, [
    "echo x >> tracked.txt; echo write=$?",
    "chmod 600 config.json; echo chmod=$?",
    "touch -a config.json; echo utime=$?",
    "ln tracked.txt alias.txt; echo link=$?",
    "sh -c 'echo y > child.txt'; echo child=$?",
    "node -e 'require(\"node:fs\").writeFileSync(\"node.txt\", \"n\")' 2>/dev/null; echo node=$?",
    "echo b > ../beside.txt; echo beside=$?",
    "echo h > \"$HOME/.bridlewise-confinement-probe\"; echo home=$?",
    "echo s > .bridlewise/test-fixtures/state.txt; echo state=$?",
    "echo f > .bridlewise/state/forged.json; echo trusted_state=$?",
    "echo t > \"$TMPDIR/scratch.txt\"; echo scratch=$?",
  ].join("\n"));
  for (const name of ["write", "chmod", "utime", "link", "child", "node", "beside", "home", "trusted_state"]) refused(stdout, name);
  for (const name of ["state", "scratch"]) taken(stdout, name);
  assert.match(stdout, /Read-only file system/u);
  assert.equal(statSync(join(repository, "config.json"), { bigint: true }).ctimeNs, before.ctimeNs, "the configuration's ctime moved");
  assert.equal(git(repository, "status", "--porcelain"), "", "the checkout changed");
  assert.equal(existsSync(join(process.env["HOME"]!, ".bridlewise-confinement-probe")), false);
});

test("a HEAD move — commit, update-ref, stash — is refused in a repository AND in a linked worktree, and the main working tree beside a worktree is read-only too", async () => {
  const { repository, worktree } = fixtureCheckouts();
  for (const checkout of [repository, worktree]) {
    const head = git(checkout, "rev-parse", "HEAD");
    writeFileSync(join(checkout, "tracked.txt"), "changed before the run\n");
    const { stdout } = await confined(checkout, [
      "git -c user.name=t -c user.email=t@example.invalid commit -q --allow-empty -m moved; echo commit=$?",
      "git update-ref refs/heads/main HEAD~0 HEAD; echo update_ref=$?",
      "git -c user.name=t -c user.email=t@example.invalid stash -q; echo stash=$?",
      `echo p > ${JSON.stringify(join(repository, "planted-by-worktree"))}; echo main_tree=$?`,
    ].join("\n"));
    for (const move of ["commit", "update_ref", "stash", "main_tree"]) refused(stdout, move);
    assert.equal(git(checkout, "rev-parse", "HEAD"), head, `HEAD moved in ${checkout}`);
    assert.equal(git(checkout, "stash", "list"), "", `a stash was recorded in ${checkout}`);
  }
  assert.equal(existsSync(join(repository, "planted-by-worktree")), false);
});

test("a repository a test makes in its own temporary folder inits and commits", async () => {
  const { repository } = fixtureCheckouts();
  const { stdout } = await confined(repository, [
    "cd \"$TMPDIR\" && mkdir own && cd own && git init -q && echo a > a.txt && git add a.txt && git -c user.name=t -c user.email=t@example.invalid commit -q -m own; echo own_commit=$?",
  ].join("\n"));
  taken(stdout, "own_commit");
});

test("a checkout in the test's OWN temporary folder (a nested run's fixture) is read-only to the nested run, its sibling folders stay the test's to write", async () => {
  const folder = createTempDir("confinement-nested-");
  const checkout = join(folder, "checkout");
  mkdirSync(checkout);
  writeFileSync(join(checkout, "tracked.txt"), "tracked\n");
  const sibling = join(folder, "sibling");
  mkdirSync(sibling);
  const { stdout } = await confined(checkout, [
    "echo x >> tracked.txt; echo nested_checkout=$?",
    `echo y > ${JSON.stringify(join(sibling, "made.txt"))}; echo sibling=$?`,
  ].join("\n"));
  refused(stdout, "nested_checkout");
  taken(stdout, "sibling");
});

test("the result channel is a pipe the command can open BY ITS PATH (`/dev/fd/3`, what vitest's --outputFile and node --test's reporter destination do) and write by its descriptor", async () => {
  const { repository } = fixtureCheckouts();
  const reported: Buffer[] = [];
  const run = await runTestCommand({
    supervisor: SUPERVISOR, checkout: repository, command: process.execPath,
    args: ["-e", "require('node:fs').writeFileSync('/dev/fd/3', 'by-path\\n'); require('node:fs').writeSync(3, 'by-descriptor\\n')"],
    cwd: repository, hardCeilingMs: 60_000, killGraceMs: 2_000,
    onStdout: () => undefined, onStderr: () => undefined, onResult: (chunk) => { reported.push(chunk); },
  });
  assert.equal(run.exitCode, 0);
  assert.equal(Buffer.concat(reported).toString("utf8"), "by-path\nby-descriptor\n");
});

test("THE LOCK: the confined command can neither remount anything read-write nor detach a mount", async () => {
  const { repository } = fixtureCheckouts();
  const { stdout } = await confined(repository, [
    "mount -o remount,rw / 2>/dev/null; echo remount_root=$?",
    "mount -o remount,bind,rw \"$PWD\" 2>/dev/null; echo remount_checkout=$?",
    "umount -l \"$PWD\" 2>/dev/null; echo umount=$?",
    "unshare -Urm sh -c 'mount -o remount,bind,rw \"$PWD\"' 2>/dev/null; echo nested_remount=$?",
    "echo x >> tracked.txt; echo still_read_only=$?",
  ].join("\n"));
  for (const name of ["remount_root", "remount_checkout", "umount", "nested_remount", "still_read_only"]) refused(stdout, name);
});

test("NO SAME-USER SERVICE IS REACHABLE (B12, #654): the user's service manager, an abstract socket, a loopback port and a pathname socket listening outside the run when it starts are not; /run, /run/user and /tmp are fresh", async (t) => {
  const { repository } = fixtureCheckouts();
  // An abstract socket (the network namespace scopes them) and a loopback port, each answering "reached".
  const name = `bridlewise-confinement-${String(process.pid)}`;
  const abstract = createUnixServer((socket) => { socket.end("reached\n"); });
  await new Promise<void>((resolveListen) => abstract.listen(`\0${name}`, resolveListen));
  const tcp = createTcpServer((socket) => { socket.end("reached\n"); });
  await new Promise<void>((resolveListen) => tcp.listen(0, "127.0.0.1", resolveListen));
  // A PATHNAME socket listening in a folder the run can see (#654): its folder is masked when the run starts. Bound by
  // a path relative to its folder (the fixture root's absolute path is longer than a socket address holds).
  const socketDir = createRepositoryLocalTemporaryDirectory("confinement-socket-");
  const pathname = createUnixServer((socket) => { socket.end("reached\n"); });
  // Bound by a path relative to its folder (the fixture root's absolute path is longer than a socket address holds),
  // and this process stays there until the run has started: the supervisor places a relative socket by its holder's
  // working directory.
  const home = process.cwd();
  process.chdir(socketDir);
  t.after(() => { process.chdir(home); abstract.close(); tcp.close(); pathname.close(); });
  await new Promise<void>((resolveListen) => pathname.listen("outside.sock", resolveListen));
  const port = (tcp.address() as AddressInfo).port;
  const reach = (target: string): string =>
    `node -e 'const s=require("node:net").connect(${target});s.on("data",()=>process.exit(0));s.on("error",()=>process.exit(3));setTimeout(()=>process.exit(4),3000)'`;
  const { stdout } = await confined(repository, [
    // The review's reproduction: a unit the user's service manager starts runs outside every namespace.
    "systemd-run --user --wait --quiet --collect /bin/true 2>/dev/null; echo service_manager=$?",
    `${reach(`"\\0${name}"`)}; echo abstract_socket=$?`,
    `${reach(`${String(port)},"127.0.0.1"`)}; echo loopback_port=$?`,
    `(cd ${JSON.stringify(socketDir)} && ${reach(JSON.stringify("outside.sock"))}); echo pathname_socket=$?`,
    `[ -z "$(ls -A ${JSON.stringify(socketDir)})" ]; echo socket_folder_masked=$?`,
    "[ -z \"$(ls -A /run)\" ]; echo run_empty=$?",
    `[ ! -e /run/user/${String(process.getuid?.() ?? 0)} ] || [ -z "$(ls -A /run/user/${String(process.getuid?.() ?? 0)})" ]; echo run_user_empty=$?`,
    "[ -z \"$(ls -A /tmp)\" ]; echo tmp_empty=$?",
    // The run's own network namespace (/proc/net is per namespace; /sys is the host's, mounted before it).
    "awk -F: 'NR>2{gsub(/ /,\"\",$1); printf \"%s \", $1}' /proc/net/dev; echo",
  ].join("\n"));
  for (const name of ["service_manager", "abstract_socket", "loopback_port", "pathname_socket"]) refused(stdout, name);
  for (const name of ["run_empty", "run_user_empty", "tmp_empty", "socket_folder_masked"]) taken(stdout, name);
  assert.match(stdout, /^lo $/mu, `the run sees a network device beyond its own loopback:\n${stdout}`);
});

test("each writable-place refusal holds on its own: a link, a non-directory, a link on the way (the door's check), and the native supervisor refuses a link, a place outside the checkout and a hard-linked file by itself", () => {
  // The door's first check, one case at a time.
  for (const plant of ["link", "file", "link-on-the-way"] as const) {
    const root = createRepositoryLocalTemporaryDirectory(`confinement-place-${plant}-`);
    const checkout = join(root, "co");
    mkdirSync(checkout);
    mkdirSync(join(checkout, ".bridlewise"));
    if (plant === "link") symlinkSync(checkout, join(checkout, ".bridlewise", "test-fixtures"));
    if (plant === "file") writeFileSync(join(checkout, ".bridlewise", "test-fixtures"), "not a directory\n");
    if (plant === "link-on-the-way") {
      // A package whose state root is a link elsewhere: nothing may be made through it.
      mkdirSync(join(root, "elsewhere"));
      mkdirSync(join(checkout, "real-pkg"));
      writeFileSync(join(checkout, "real-pkg", "package.json"), "{}\n");
      symlinkSync(join(root, "elsewhere"), join(checkout, "real-pkg", ".bridlewise"));
    }
    assert.throws(() => testConfinement(SUPERVISOR, checkout, createTempDir("confinement-scratch-")),
      (error: unknown) => (error as { code?: string }).code === "test_confinement_writable_unsafe", plant);
    if (plant === "link-on-the-way") assert.equal(existsSync(join(root, "elsewhere", "test-fixtures")), false, "a place was made through a link");
  }
  // The native supervisor's own checks, with no door in front of it.
  const root = createRepositoryLocalTemporaryDirectory("confinement-native-");
  const checkout = join(root, "co");
  mkdirSync(join(checkout, "state"), { recursive: true });
  writeFileSync(join(checkout, "tracked.txt"), "tracked\n");
  const scratch = createTempDir("confinement-native-scratch-");
  const probe = (...writable: string[]): Readonly<{ status: number | null; stderr: string }> => {
    const run = spawnSync(SUPERVISOR, ["--probe-confinement", "--checkout", checkout, "--scratch", scratch, ...writable.flatMap((place) => ["--writable", place])], { encoding: "utf8" });
    return { status: run.status, stderr: run.stderr };
  };
  const refusedWith = (answer: Readonly<{ status: number | null; stderr: string }>, words: string): void => {
    assert.equal(answer.status, 125, answer.stderr);
    assert.ok(answer.stderr.includes(words), `${words} is not named: ${answer.stderr}`);
  };
  assert.equal(probe(join(checkout, "state")).status, 0, "control: a real state folder is admitted");
  symlinkSync(join(checkout, "state"), join(checkout, "state-link"));
  refusedWith(probe(join(checkout, "state-link")), "writable place");
  refusedWith(probe(join(root, "outside")), "inside the checkout");
  linkSync(join(checkout, "tracked.txt"), join(checkout, "state", "alias.txt"));
  refusedWith(probe(join(checkout, "state")), "more than one name");
  unlinkSync(join(checkout, "state", "alias.txt"));
});

test("a pathname socket bound INSIDE the checkout, outside its writable places, cannot be masked without hiding the checkout: the run is refused (125)", async (t) => {
  const root = createRepositoryLocalTemporaryDirectory("confinement-socket-in-");
  const checkout = join(root, "co");
  mkdirSync(join(checkout, "sub"), { recursive: true });
  const server = createUnixServer(() => undefined);
  const home = process.cwd();
  process.chdir(join(checkout, "sub"));
  t.after(() => { process.chdir(home); server.close(); });
  await new Promise<void>((resolveListen) => server.listen("inside.sock", resolveListen));
  const run = spawnSync(SUPERVISOR, ["--probe-confinement", "--checkout", checkout, "--scratch", createTempDir("confinement-socket-in-scratch-")], { encoding: "utf8" });
  assert.equal(run.status, 125, run.stderr);
  assert.ok(run.stderr.includes("bound inside the checkout"), run.stderr);
});

test("NEVER AN UNCONFINED RUN: when the native supervisor cannot confine, it refuses with 125 and the command never starts", () => {
  const root = createRepositoryLocalTemporaryDirectory("confinement-never-");
  const checkout = join(root, "co");
  mkdirSync(checkout);
  const marker = join(createTempDir("confinement-never-marker-"), "ran");
  // A writable place outside the checkout: refused at the run's own setup, before the command.
  const run = spawnSync(SUPERVISOR, ["--checkout", checkout, "--scratch", createTempDir("confinement-never-scratch-"), "--writable", root,
    "60000", "1000", "sh", "-c", `echo ran > ${JSON.stringify(marker)}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe", "pipe"] });
  assert.match(run.stderr, /confinement refused/u);
  assert.equal(existsSync(marker), false, "the command ran although its confinement was refused");
});

test("a recursive read-only remount: a mount already beneath the checkout is read-only too", () => {
  const root = createRepositoryLocalTemporaryDirectory("confinement-submount-");
  mkdirSync(join(root, "co", "sub"), { recursive: true });
  mkdirSync(join(root, "other"));
  const scratch = createTempDir("confinement-submount-scratch-");
  const script = [
    `mount --bind ${JSON.stringify(join(root, "other"))} ${JSON.stringify(join(root, "co", "sub"))}`,
    `${JSON.stringify(SUPERVISOR)} --checkout ${JSON.stringify(join(root, "co"))} --scratch ${JSON.stringify(scratch)} 60000 1000 sh -c 'touch ${join(root, "co", "sub", "planted")} 2>/dev/null; echo submount=$?' 3>/dev/null`,
  ].join(" && ");
  const run = spawnSync("unshare", ["-Urm", "sh", "-c", script], { encoding: "utf8" });
  assert.match(run.stdout, /^submount=[1-9]/mu, `${run.stdout}${run.stderr}`);
  assert.equal(existsSync(join(root, "other", "planted")), false);
});

test("on the LIVE checkout: the configuration bootstrap reads it (no mountpoint refusal) and an up-to-date make writes nothing", async () => {
  const guardianBuild = join(ENGINE, "guardian", "build");
  const before = statSync(guardianBuild, { bigint: true });
  const { stdout, exitCode } = await confined(LIVE, [
    `cd ${ENGINE} && node --input-type=module -e 'const { loadPinnedConfigSnapshot } = await import("./src/kernel/config.ts"); loadPinnedConfigSnapshot(); console.log("bootstrap=ok")'; echo bootstrap_exit=$?`,
    `make --no-print-directory -C ${join(ENGINE, "guardian")} test_process_supervisor; echo make=$?`,
  ].join("\n"));
  assert.equal(exitCode, 0, stdout);
  assert.match(stdout, /^bootstrap=ok$/mu, stdout);
  taken(stdout, "make");
  assert.equal(statSync(guardianBuild, { bigint: true }).mtimeNs, before.mtimeNs, "an in-run make changed the build folder");
});

test("a host or a place that refuses is a typed refusal naming why, never an unconfined run", () => {
  const folder = createTempDir("confinement-refused-");
  const fake = join(folder, "refusing-supervisor");
  writeFileSync(fake, "#!/bin/sh\necho 'test supervisor: confinement refused: unshare user, mount, network and IPC namespaces: Operation not permitted' >&2\nexit 125\n");
  chmodSync(fake, 0o755);
  const { repository } = fixtureCheckouts();
  assert.throws(() => testConfinement(fake, repository, createTempDir("confinement-refused-scratch-")), (error: unknown) =>
    (error as { code?: string }).code === "test_confinement_unavailable" && /no test runs/u.test((error as Error).message) && /Operation not permitted/u.test((error as Error).message));
});
