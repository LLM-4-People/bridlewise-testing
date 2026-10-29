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
import { chmodSync, existsSync, linkSync, mkdirSync, openSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import { createServer as createUnixServer } from "node:net";
import { join } from "node:path";
import test from "node:test";

import { ensureTestProcessSupervisor } from "../../guardian/build.ts";
import { readSupervisorReceipt, runTestCommand, testConfinement, type SupervisedCommand } from "../../src/process/supervised-run.ts";
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
async function confined(checkout: string, script: string): Promise<Readonly<{ stdout: string; exitCode: number; supervision: SupervisedCommand["supervision"] }>> {
  const out: Buffer[] = [];
  const run = await runTestCommand({
    supervisor: SUPERVISOR, checkout, command: "sh", args: ["-c", script], cwd: checkout,
    hardCeilingMs: 60_000, killGraceMs: 2_000,
    onStdout: (chunk) => out.push(chunk), onStderr: (chunk) => out.push(chunk),
  });
  return { stdout: Buffer.concat(out).toString("utf8"), exitCode: run.exitCode, supervision: run.supervision };
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

test("THE SCRATCH GOES WITH THE RUN, and a folder the test left unlistable (mode 000) neither keeps it nor replaces the run's result", async () => {
  const { repository } = fixtureCheckouts();
  const { stdout, exitCode } = await confined(repository, [
    "echo \"scratch=$BRIDLEWISE_TEST_SCRATCH\"",
    "mkdir -p \"$TMPDIR/locked/inner\" && echo x > \"$TMPDIR/locked/inner/file\" && chmod 000 \"$TMPDIR/locked/inner\" \"$TMPDIR/locked\"",
    "exit 3",
  ].join("\n"));
  assert.equal(exitCode, 3, `the run's own result is what the door answers:\n${stdout}`);
  const scratch = /^scratch=(.+)$/mu.exec(stdout)?.[1];
  assert.ok(scratch !== undefined && scratch.length > 0, stdout);
  assert.equal(existsSync(scratch), false, `the scratch root ${scratch} outlived its run`);
});

test("THE RUN'S CGROUP: the run is the root of a cgroup namespace of its own, and its root's interface files (limits, freeze) refuse a write (review of #734; the scope case: live/door-canaries)", async () => {
  const { repository } = fixtureCheckouts();
  // Each file is written with the value it holds (a refused write changes nothing; a taken one would be the escape).
  const { stdout, supervision } = await confined(repository, [
    `grep -qx '0::/' /proc/self/cgroup; echo cgroup_namespace_root=$?`,
    ...["cgroup.freeze", "memory.max", "memory.swap.max", "pids.max", "cpu.weight", "cpu.max"].map((file) =>
      `if [ -e /sys/fs/cgroup/${file} ]; then (cat /sys/fs/cgroup/${file} > /sys/fs/cgroup/${file}) 2>/dev/null; echo limit_${file.replace(".", "_")}_written=$?; fi`),
  ].join("\n"));
  taken(stdout, "cgroup_namespace_root");
  // The receipt says which layout the run had: whether its worker leaves were its own to make.
  assert.ok(supervision?.runCgroup === "own-leaf" || supervision?.runCgroup === "started-cgroup", `the receipt names no cgroup layout: ${String(supervision?.runCgroup)}`);
  // cgroup.freeze is every non-root cgroup's, so at least one write was tried.
  refused(stdout, "limit_cgroup_freeze_written");
  for (const line of stdout.split("\n").filter((entry) => entry.startsWith("limit_"))) assert.match(line, /=[1-9]\d*$/u, `a limit of the run's cgroup root took a write: ${line}`);
});

test("EACH ISOLATION HOLDS ON ITS OWN: a host SysV queue is out of reach (IPC namespace), an inherited descriptor is closed (close_range), /dev/shm is fresh, and an ABSOLUTE-path socket's folder is masked", async (t) => {
  const { repository } = fixtureCheckouts();
  // A SysV queue of the run that starts the confined command: another IPC namespace sees none of it.
  const queue = execFileSync("ipcmk", ["-Q"], { encoding: "utf8" }).match(/(\d+)\s*$/u)?.[1];
  assert.ok(queue !== undefined, "ipcmk made no queue");
  t.after(() => { spawnSync("ipcrm", ["-q", queue]); });
  // A file in this run's /dev/shm.
  const shm = `/dev/shm/bridlewise-confinement-${String(process.pid)}`;
  writeFileSync(shm, "host\n");
  t.after(() => { unlinkSync(shm); });
  // A socket bound by an ABSOLUTE path (short: through this process's cwd link) in a folder the run can see.
  const socketDir = createRepositoryLocalTemporaryDirectory("confinement-abs-socket-");
  const home = process.cwd();
  process.chdir(socketDir);
  const server = createUnixServer((socket) => { socket.end("reached\n"); });
  t.after(() => { process.chdir(home); server.close(); });
  await new Promise<void>((resolveListen) => server.listen(`/proc/${String(process.pid)}/cwd/abs.sock`, resolveListen));
  const { stdout } = await confined(repository, [
    `ipcrm -q ${queue} 2>/dev/null; echo host_queue_removed=$?`,
    `[ ! -e ${shm} ]; echo shm_fresh=$?`,
    `[ -z "$(ls -A ${JSON.stringify(socketDir)})" ]; echo abs_socket_folder_masked=$?`,
    // The mask is read-only itself: nothing can be bound or planted in its place (round 2, #16).
    // The run owns the mask's tmpfs, so its mode alone would not hold: it could chmod it first.
    `(chmod 0755 ${JSON.stringify(socketDir)} && : > ${JSON.stringify(join(socketDir, "planted"))}) 2>/dev/null; echo socket_mask_written=$?`,
  ].join("\n"));
  refused(stdout, "host_queue_removed");
  taken(stdout, "shm_fresh");
  taken(stdout, "abs_socket_folder_masked");
  refused(stdout, "socket_mask_written");
  // The native supervisor with a descriptor of its caller's beyond 0–3: the command sees none of it.
  const scratch = createTempDir("confinement-fds-scratch-");
  const extra = join(createTempDir("confinement-fds-"), "held");
  writeFileSync(extra, "held\n");
  const run = spawnSync(SUPERVISOR, ["--checkout", repository, "--scratch", scratch, "60000", "1000", "sh", "-c", "ls /proc/self/fd | sort -n | tr '\\n' ' '"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe", "pipe", "pipe", openSync(extra, "r")] });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^0 1 2 3? ?\d* ?$/u, `only the standard descriptors (and the listing's own) reached the command: ${run.stdout}`);
  assert.ok(!/\b5\b/u.test(run.stdout), `the caller's descriptor 5 reached the command: ${run.stdout}`);
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
  // A link ON THE WAY (round 2, #16): a real final folder reached through a link inside the checkout, to a folder
  // outside it. Only the canonical-path check catches it (O_NOFOLLOW sees the final folder only).
  mkdirSync(join(root, "outside-target", "place"), { recursive: true });
  symlinkSync(join(root, "outside-target"), join(checkout, "lnk"));
  refusedWith(probe(join(checkout, "lnk", "place")), "resolves through a link");
  // The run's own roots: a scratch root inside the checkout, and a checkout or scratch root not named canonically.
  const roots = (checkoutRoot: string, scratchRoot: string): Readonly<{ status: number | null; stderr: string }> => {
    const run = spawnSync(SUPERVISOR, ["--probe-confinement", "--checkout", checkoutRoot, "--scratch", scratchRoot], { encoding: "utf8" });
    return { status: run.status, stderr: run.stderr };
  };
  mkdirSync(join(checkout, "inner-scratch"));
  refusedWith(roots(checkout, join(checkout, "inner-scratch")), "the scratch root must lie outside the checkout");
  symlinkSync(checkout, join(root, "co-link"));
  refusedWith(roots(join(root, "co-link"), scratch), "the checkout must be named by its canonical path");
  const scratchLink = join(createTempDir("confinement-native-scratch-link-"), "scratch-link");
  symlinkSync(scratch, scratchLink);
  refusedWith(roots(checkout, scratchLink), "the scratch root must be named by its canonical path");
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
  // Typed in the receipt (round 2, #18), and told apart from a confined command that exits 125 itself.
  const refusedReceipt = readSupervisorReceipt(String(run.output[3])).receipt;
  assert.equal(refusedReceipt?.status, 125, String(run.output[3]));
  assert.equal(refusedReceipt?.confinementRefused, true, String(run.output[3]));
  const own = spawnSync(SUPERVISOR, ["--checkout", checkout, "--scratch", createTempDir("confinement-never-scratch-"), "60000", "1000", "sh", "-c", "exit 125"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe", "pipe"] });
  const ownReceipt = readSupervisorReceipt(String(own.output[3])).receipt;
  assert.equal(ownReceipt?.status, 125, `${own.stderr}${String(own.output[3])}`);
  assert.equal(ownReceipt?.confinementRefused, false, String(own.output[3]));
});

test("a run refused at its own setup is the typed refusal on the run path too, never an exit code (planted receipt; round 2, #18)", async () => {
  // A supervisor whose probe passes and whose run is refused at setup: the receipt says so.
  const folder = createTempDir("confinement-run-refused-");
  const fake = join(folder, "run-refusing-supervisor");
  writeFileSync(fake, [
    "#!/bin/sh",
    "[ \"$1\" = --probe-confinement ] && exit 0",
    "echo 'test supervisor: confinement refused: a writable place holds a file with more than one name' >&2",
    "printf '{\"announcedCommandPid\":1,\"announcedCommandStartTime\":null}\\n{\"commandPid\":1,\"status\":125,\"timedOut\":false,\"interrupted\":false,\"commandKilled\":false,\"reaped\":[],\"noOwnedChildren\":true,\"runCgroup\":\"started-cgroup\",\"confinementRefused\":true,\"waitedCpuUs\":0,\"supervisorCpuUsBeforeReceipt\":0}\\n' >&3",
    "exit 0",
  ].join("\n"));
  chmodSync(fake, 0o755);
  const { repository } = fixtureCheckouts();
  await assert.rejects(runTestCommand({ supervisor: fake, checkout: repository, command: "true", args: [], cwd: repository, hardCeilingMs: 30_000, killGraceMs: 1_000, onStdout: () => {}, onStderr: () => {} }),
    (error: unknown) => (error as { code?: string }).code === "test_confinement_unavailable" && /at its own setup/u.test((error as Error).message));
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
