/**
 * THE TRIGGER (merge-door-final §11, T-T1..T-T4): the tracked
 * `reference-transaction` hook (`trigger-hook.ts`'s canonical text) and
 * `harness promote auto` (`trigger.ts`).
 *
 * - T-T1: the hook exits 0 in every state — `prepared`, `aborted`, without
 *   node on PATH, with a failing CLI — so no ref update is ever aborted (J15);
 *   a non-canonical hook that fails in `prepared` blocks the push (why the
 *   commit guard holds the text).
 * - T-T2: a push of the source moves a remote-tracking ref: the hook starts
 *   `harness promote auto --refs <that ref>` in the background, and `auto`
 *   launches ONE unattended apply of the profile whose source it is.
 * - T-T3: ordinary commits and checkouts start nothing; neither do the
 *   promoter's own fetches and pushes (the run variable), a `manual` profile,
 *   or one already carrying that source. A LOCAL hold is no reason (M2): the
 *   run reads the remote's hold and answers it.
 * - T-T4: a profile whose previous run ended blocked gives exactly one notice
 *   line: `auto --text` (what the hook prints on the pusher's stderr) is that
 *   line alone, and nothing after an ok run.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";

import { configuredWorktreeGitPort } from "../../../src/git/worktree-port.ts";
import { ROOT_POLICY } from "../../../src/kernel/root-policy.ts";
import { answer } from "../../../src/workflow/promotion/codes.ts";
import { promotionAuto, resolvePromotionContext, resolveRepositoryContext } from "../../../src/workflow/promotion/context.ts";
import { lastRunRecorder, openUnattendedLog, readLastRun } from "../../../src/workflow/promotion/last-run.ts";
import { profileWorkDirectory, promotionRefs } from "../../../src/workflow/promotion/promotion-run.ts";
import { launchUnattendedApply } from "../../../src/workflow/promotion/trigger.ts";
import { PromotionError } from "../../../src/workflow/promotion/codes.ts";
import { runPromoteCli } from "../../../src/workflow/promotion/promote-cli.ts";
import { renderCommandAnswer } from "../../../src/workflow/command-result.ts";
import { PROMOTION_TRIGGER_HOOK, promotionTriggerHookText } from "../../../src/workflow/promotion/trigger-hook.ts";
import { createTempDir } from "../../support/temp-dir.ts";
import { testGitIdentityEnvironment } from "../../support/test-git-identity.ts";
import { apply, landing } from "./apply-support.ts";
import { PROFILE_NAME, PROFILE_PATH, SOURCE, fixtureProfile, json, type PromotionFixture } from "./promotion-fixture.ts";

const RUN_VARIABLE = ROOT_POLICY.workflow.promotion.runEnvironmentVariable;
const STATES = ["prepared", "committed", "aborted"] as const;

/** A folder of programs the hook may need (`git`, `cat`, `grep`), and a fake `node` that records its argv (or fails) — never the real node. */
function bin(mode: "record" | "fail" | "absent"): Readonly<{ path: string; calls: () => readonly string[] }> {
  const directory = createTempDir("promotion-trigger-bin-");
  for (const tool of ["git", "cat", "grep"]) {
    const found = execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
    symlinkSync(found, join(directory, tool));
  }
  const log = join(directory, "node-calls");
  if (mode !== "absent") {
    writeFileSync(join(directory, "node"), mode === "record" ? `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n` : "#!/bin/sh\nexit 1\n");
    chmodSync(join(directory, "node"), 0o755);
  }
  return { path: directory, calls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((line) => line.length > 0) : []) };
}

/** A repository whose hooks folder holds the canonical trigger (and an optional extra hook), with a bare remote `origin`. */
function hookedRepository(prefix: string, hookText = promotionTriggerHookText()): Readonly<{ root: string; remote: string; git: (args: readonly string[], path: string, extra?: Readonly<Record<string, string>>) => ReturnType<typeof spawnSync> }> {
  const root = createTempDir(`${prefix}-repo-`);
  const remote = createTempDir(`${prefix}-remote-`);
  execFileSync("git", ["init", "-q", "--bare", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  mkdirSync(join(root, ".githooks"));
  writeFileSync(join(root, ".githooks", PROMOTION_TRIGGER_HOOK), hookText);
  chmodSync(join(root, ".githooks", PROMOTION_TRIGGER_HOOK), 0o755);
  const git = (args: readonly string[], path: string, extra: Readonly<Record<string, string>> = {}) => spawnSync(join(path.split(":")[0]!, "git"), ["-c", "gc.auto=0", "-c", "core.hooksPath=.githooks", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: path, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...testGitIdentityEnvironment(), ...extra },
  });
  return { root, remote, git };
}

test("T-T1: the trigger exits 0 in every state, with node absent and with a failing CLI; a non-canonical hook failing in `prepared` would abort the update (J15)", () => {
  const hook = (variant: "record" | "fail" | "absent") => {
    const programs = bin(variant);
    const { root } = hookedRepository(`promotion-trigger-states-${variant}`);
    for (const state of STATES) {
      const run = spawnSync("/bin/sh", [join(root, ".githooks", PROMOTION_TRIGGER_HOOK), state], {
        cwd: root, input: `${"0".repeat(40)} ${"1".repeat(40)} refs/remotes/origin/dev\n`, encoding: "utf8", env: { PATH: programs.path },
      });
      assert.equal(run.status, 0, `${variant} ${state}: ${run.stderr}`);
    }
    return programs;
  };
  assert.equal(hook("record").calls().length, 1, "only `committed` starts the trigger");
  assert.deepEqual(hook("absent").calls(), [], "no node: nothing runs, nothing fails");
  hook("fail");
  // A real push through the hook, its CLI failing: the push succeeds.
  const programs = bin("fail");
  const { git, remote } = hookedRepository("promotion-trigger-push");
  assert.equal(git(["remote", "add", "origin", remote], programs.path).status, 0);
  assert.equal(git(["commit", "-q", "--allow-empty", "-m", "a commit"], programs.path).status, 0);
  const pushed = git(["push", "-q", "origin", "main"], programs.path);
  assert.equal(pushed.status, 0, String(pushed.stderr));
  // What the commit guard keeps out: a hook that fails in `prepared` aborts every ref update.
  const broken = hookedRepository("promotion-trigger-broken", "#!/bin/sh\nset -e\n[ \"$1\" = committed ]\n");
  const blocked = broken.git(["commit", "-q", "--allow-empty", "-m", "a commit"], programs.path);
  assert.notEqual(blocked.status, 0);
  // git names the abort in its own words, which differ by version ("ref updates aborted by hook" in 2.47, "in
  // 'preparing' phase, update aborted by the reference-transaction hook" on the hosted runner's): the behaviour is the
  // fact judged — no commit landed — and the words only say it was the hook (#149).
  assert.match(String(blocked.stderr), /aborted by (?:the reference-transaction )?hook/u);
  assert.notEqual(broken.git(["rev-parse", "--verify", "-q", "HEAD"], programs.path).status, 0, "the aborted commit did not land");
});

test("T-T2/T-T3: a push moving a remote-tracking ref starts `harness promote auto --refs <the ref>` in the background; ordinary commits, checkouts and the promoter's own fetch start nothing", () => {
  const programs = bin("record");
  const { root, git, remote } = hookedRepository("promotion-trigger-push-record");
  assert.equal(git(["remote", "add", "origin", remote], programs.path).status, 0);
  assert.equal(git(["commit", "-q", "--allow-empty", "-m", "a commit"], programs.path).status, 0);
  assert.equal(git(["checkout", "-q", "-b", "other"], programs.path).status, 0);
  assert.equal(git(["checkout", "-q", "main"], programs.path).status, 0);
  assert.deepEqual(programs.calls(), [], "a commit and checkouts move no remote-tracking ref");
  assert.equal(git(["push", "-q", "origin", "main"], programs.path).status, 0);
  // The background start lands shortly after the push returns.
  for (let waited = 0; programs.calls().length === 0 && waited < 50; waited += 1) spawnSync("sleep", ["0.1"]);
  assert.deepEqual(programs.calls(), [`--experimental-strip-types ${root}/engine/src/cli.ts harness promote auto --refs  refs/remotes/origin/main --text`]);
  // The promoter's own fetch (the port: the run variable set) starts nothing.
  const before = programs.calls().length;
  assert.equal(git(["commit", "-q", "--allow-empty", "-m", "another"], programs.path).status, 0);
  assert.equal(git(["push", "-q", "origin", "main:elsewhere"], programs.path, { [RUN_VARIABLE]: "1" }).status, 0);
  const port = configuredWorktreeGitPort({});
  const fetchEnv = process.env["PATH"];
  process.env["PATH"] = `${programs.path}:${fetchEnv ?? ""}`;
  try {
    assert.equal(port.fetchRefs(root, "origin", ["+refs/heads/elsewhere:refs/remotes/origin/elsewhere"], 30_000).refusal, null);
  } finally {
    process.env["PATH"] = fetchEnv;
  }
  spawnSync("sleep", ["0.5"]);
  assert.equal(programs.calls().length, before, "the promoter's own fetch and a run-marked push start nothing");
});

/** A fixture whose profile is triggered by the remote's source (`on-source-publish`), the source published. */
function triggered(prefix: string, trigger: "on-source-publish" | "manual" = "on-source-publish"): PromotionFixture {
  const fixture = landing(prefix, { trigger }, { remote: true });
  fixture.publish(SOURCE);
  fixture.git(["fetch", "-q", "origin"]);
  return fixture;
}

test("T-T2: `auto` over the moved refs launches ONE unattended apply of the profile whose source moved (the profile read from that commit), and nothing for other refs", () => {
  const fixture = triggered("promotion-auto-launch");
  // Refs that RESOLVE (X24): another remote's branch of the same name, and the remote's HEAD.
  fixture.git(["update-ref", `refs/remotes/elsewhere/${SOURCE}`, fixture.tip(SOURCE)]);
  fixture.git(["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${SOURCE}`]);
  const launched: string[] = [];
  const result = promotionAuto(fixture.root, ` refs/remotes/origin/${SOURCE}\n refs/remotes/origin/prod\n refs/remotes/elsewhere/${SOURCE}\n refs/remotes/origin/HEAD`, fixture.document, (context, source) => {
    launched.push(`${context.profile}@${source}`);
    return 4242;
  }, {});
  assert.equal(result.code, "promotion_triggered", result.message);
  assert.deepEqual(launched, [`${PROFILE_NAME}@${fixture.tip(SOURCE)}`]);
  assert.deepEqual((result.data as { started: readonly { pid: number }[] }).started.map((entry) => entry.pid), [4242]);
});

test("T-T3: nothing is launched for a manual profile, one already carrying that source, or within a promotion run (the run variable); a local hold launches the run that reads the remote's (M2)", async () => {
  const never = () => assert.fail("nothing may be launched");
  const manual = triggered("promotion-auto-manual", "manual");
  assert.equal(promotionAuto(manual.root, ` refs/remotes/origin/${SOURCE}`, manual.document, never, {}).code, "promotion_not_due");
  const inRun = triggered("promotion-auto-in-run");
  assert.equal(promotionAuto(inRun.root, ` refs/remotes/origin/${SOURCE}`, inRun.document, never, { [RUN_VARIABLE]: "1" }).code, "promotion_not_due");
  const held = triggered("promotion-auto-held");
  const blob = held.git(["hash-object", "-w", "--", PROFILE_PATH]);
  held.git(["update-ref", promotionRefs(PROFILE_NAME).hold, blob]);
  const heldLaunches: string[] = [];
  const heldAnswer = promotionAuto(held.root, ` refs/remotes/origin/${SOURCE}`, held.document, (_context, source) => { heldLaunches.push(source); return 1; }, {});
  assert.equal(heldAnswer.code, "promotion_triggered", "a local hold is a mirror: the run decides on the remote's");
  assert.deepEqual(heldLaunches, [held.tip(SOURCE)]);
  const done = triggered("promotion-auto-done");
  const published = await apply(done, { request: { noPublish: false } });
  assert.equal(published.code, "promotion_published", published.message);
  done.git(["fetch", "-q", "origin"]);
  const upToDate = promotionAuto(done.root, ` refs/remotes/origin/${SOURCE}`, done.document, never, {});
  assert.deepEqual((upToDate.data as { skipped: readonly { reason: string }[] }).skipped.map((entry) => entry.reason), ["up to date"]);
  // The profile's own trigger is read from the commit that moved: a source that switches it on triggers.
  manual.commit(SOURCE, { [PROFILE_PATH]: json(fixtureProfile({ trigger: "on-source-publish", remote: "origin", phases: { setup: ["setup"], converge: ["gen"], verify: ["gate"] }, boundary: { include: [".gitignore", "assets/", "product/run.sh", "product/link.ts", "package.json", "package-lock.json", "gen/", ".githooks/", "tool/"] } })) }, "switch the trigger on");
  manual.publish(SOURCE);
  manual.git(["fetch", "-q", "origin"]);
  let launches = 0;
  promotionAuto(manual.root, ` refs/remotes/origin/${SOURCE}`, manual.document, () => { launches += 1; return 1; }, {});
  assert.equal(launches, 1);
});

test("T-T4: a profile whose previous run ended blocked gives exactly ONE notice line, naming its state, code and the status command — `auto --text` prints it alone, and nothing after an ok run", async () => {
  const fixture = triggered("promotion-auto-notice");
  const context = resolvePromotionContext(fixture.root, PROFILE_NAME, SOURCE, fixture.document);
  const recorder = lastRunRecorder(context.workDirectory, PROFILE_NAME, "apply");
  recorder.end(answer("promotion_gate_failed", "the web-build command failed in the candidate", {}));
  const result = promotionAuto(fixture.root, ` refs/remotes/origin/${SOURCE}`, fixture.document, () => 1, {});
  const notices = (result.data as { notices: readonly string[] }).notices;
  assert.equal(notices.length, 1);
  assert.equal(notices[0], `promotion ${PROFILE_NAME}: failed — promotion_gate_failed (the web-build command failed in the candidate); run: harness promote status --profile ${PROFILE_NAME}`);
  // The hook prints `auto --text` on the pusher's stderr: that report is the notice line alone (the launch a spy here).
  const blockedText = await runPromoteCli(fixture.root, ["auto", "--refs", ` refs/remotes/origin/${SOURCE}`], fixture.document, () => 1);
  assert.equal(renderCommandAnswer(blockedText, "text"), `${notices[0]!}\n`);
  assert.equal(blockedText.exitCode, 0);
  recorder.end(answer("promotion_published", "published", {}));
  assert.deepEqual((promotionAuto(fixture.root, ` refs/remotes/origin/${SOURCE}`, fixture.document, () => 1, {}).data as { notices: readonly string[] }).notices, [], "an ok run gives none");
  assert.equal(renderCommandAnswer(await runPromoteCli(fixture.root, ["auto", "--refs", ` refs/remotes/origin/${SOURCE}`], fixture.document, () => 1), "text"), "", "and prints nothing");
});

/** `fixture`'s source profile rewritten with `fields` (a newer schema the engine cannot read, a key it does not know), committed, published and fetched. */
function publishProfile(fixture: PromotionFixture, fields: Readonly<Record<string, unknown>>, message: string): void {
  const current = JSON.parse(fixture.git(["show", `${SOURCE}:${PROFILE_PATH}`])) as Record<string, unknown>;
  fixture.commit(SOURCE, { [PROFILE_PATH]: json({ ...current, ...fields }) }, message);
  fixture.publish(SOURCE);
  fixture.git(["fetch", "-q", "origin"]);
}

test("#259/#121: a fetched ref's profiles are FILTERED by their trigger fields before anything judges them — a newer schema behind a manual trigger, or an unreadable profile on another ref, refuses nothing and prints nothing", async () => {
  const never = () => assert.fail("nothing may be launched");
  // A checkout behind main fetches a main whose (manual) profile is a schema this engine does not know.
  const behind = triggered("promotion-auto-newer-manual", "manual");
  publishProfile(behind, { schema: "bridlewise-promotion-profile/v999", futureField: { judged: "by its own code" } }, "a newer profile");
  const quiet = await runPromoteCli(behind.root, ["auto", "--refs", ` refs/remotes/origin/${SOURCE}`], behind.document, never);
  assert.equal(quiet.result.result.code, "promotion_not_due", quiet.result.result.message);
  assert.equal(renderCommandAnswer(quiet, "text"), "", "the hook prints nothing on the fetcher's terminal");
  assert.equal(quiet.exitCode, 0);
  // #121: a PR ref holding an unreadable profile next to a real source move: the source move still triggers.
  const host = triggered("promotion-auto-pr-ref");
  const scratch = createTempDir("promotion-auto-pr-");
  const prEnv = { GIT_INDEX_FILE: join(scratch, "index") };
  writeFileSync(join(scratch, "profile.json"), "{ not json");
  host.git(["read-tree", host.tip(SOURCE)], prEnv);
  host.git(["update-index", "--add", "--cacheinfo", `100644,${host.git(["hash-object", "-w", join(scratch, "profile.json")])},${PROFILE_PATH}`], prEnv);
  const prCommit = host.git(["commit-tree", host.git(["write-tree"], prEnv), "-p", host.tip(SOURCE), "-m", "a PR whose profile is unreadable"]);
  host.git(["update-ref", "refs/remotes/pr/7", prCommit]);
  const launched: string[] = [];
  const both = promotionAuto(host.root, ` refs/remotes/pr/7\n refs/remotes/origin/${SOURCE}`, host.document, (pair, source) => { launched.push(`${pair.profile}@${source}`); return 1; }, {});
  assert.equal(both.code, "promotion_triggered", both.message);
  assert.deepEqual(launched, [`${PROFILE_NAME}@${host.tip(SOURCE)}`], "the unreadable profile ends nothing; the real source move triggers");
  assert.deepEqual((both.data as { notices: readonly string[] }).notices, [], "a foreign ref's unreadable profile stays silent");
});

test("SECURITY (planted): a profile name is never a path until the schema's rule holds — `..`, an absolute path and an over-long name start nothing and touch nothing", () => {
  const host = triggered("promotion-auto-name-escape");
  const repository = resolveRepositoryContext(host.root, host.document);
  const area = dirname(profileWorkDirectory(repository.registry, PROFILE_NAME));
  const longName = `a${"b".repeat(63)}`;
  const current = JSON.parse(host.git(["show", `${SOURCE}:${PROFILE_PATH}`])) as Record<string, unknown>;
  const planted = {
    [`${dirname(PROFILE_PATH)}/escape.json`]: json({ ...current, name: "../../../../escaped-dir" }),
    [`${dirname(PROFILE_PATH)}/absolute.json`]: json({ ...current, name: join(createTempDir("promotion-auto-absolute-"), "escaped") }),
    [`${dirname(PROFILE_PATH)}/${longName}.json`]: json({ ...current, name: longName }),
  };
  host.commit(SOURCE, planted, "profiles whose names are paths");
  host.publish(SOURCE);
  host.git(["fetch", "-q", "origin"]);
  const launched: string[] = [];
  const result = promotionAuto(host.root, ` refs/remotes/origin/${SOURCE}`, host.document, (pair) => { launched.push(pair.profile); return 1; }, {});
  assert.deepEqual(launched, [PROFILE_NAME], `only the real profile starts: ${result.message}`);
  assert.equal(existsSync(resolve(area, "../../../../escaped-dir")), false, "nothing is made where `..` points");
  assert.equal(existsSync(join(area, longName)), false);
  for (const name of ["../../../../escaped-dir", "/an/absolute/path", longName, "Upper", "a/b"]) {
    assert.throws(() => profileWorkDirectory(repository.registry, name), (error: unknown) => error instanceof PromotionError && error.promotionCode === "promotion_profile_invalid", name);
  }
});

test("SECURITY (planted): a link where the profile's folder belongs is refused before any log is made — the launch is that profile's notice, and nothing lands outside", () => {
  const host = triggered("promotion-auto-folder-link");
  const repository = resolveRepositoryContext(host.root, host.document);
  const folder = profileWorkDirectory(repository.registry, PROFILE_NAME);
  const outside = createTempDir("promotion-auto-outside-");
  mkdirSync(dirname(folder), { recursive: true });
  if (existsSync(folder)) renameSync(folder, `${folder}.set-aside`);
  symlinkSync(outside, folder);
  const result = promotionAuto(host.root, ` refs/remotes/origin/${SOURCE}`, host.document, launchUnattendedApply, {});
  const notices = (result.data as { notices: readonly string[] }).notices;
  assert.equal(notices.length, 1, result.message);
  assert.match(notices[0]!, /could not be started/u);
  assert.doesNotThrow(() => rmdirSync(outside), "no log, no sweep, nothing written through the link: the outside folder is still empty");
});

test("an unreadable profile on the HOST'S OWN source is said loudly: one notice, nothing started (a foreign ref's stays silent)", async () => {
  const host = triggered("promotion-auto-host-unreadable");
  host.commit(SOURCE, { [PROFILE_PATH]: "{ not json" }, "the host's profile breaks");
  host.publish(SOURCE);
  host.git(["fetch", "-q", "origin"]);
  // HEAD is still the checkout's own (readable) commit: it names what this checkout hosts.
  host.git(["checkout", "-q", "--detach", `${SOURCE}~1`]);
  const never = () => assert.fail("nothing may be launched");
  const answered = await runPromoteCli(host.root, ["auto", "--refs", ` refs/remotes/origin/${SOURCE}`], host.document, never);
  const text = renderCommandAnswer(answered, "text");
  assert.match(text, new RegExp(`^promotion ${PROFILE_NAME}: origin/${SOURCE} moved to [0-9a-f]{40}, whose ${PROFILE_NAME} profile cannot be read`, "u"));
  assert.equal(text.trim().split("\n").length, 1, "one line");
});

test("#259: the host's own source move with a profile this engine cannot judge still starts its promotion — the run, the source's own code, judges it", () => {
  const host = triggered("promotion-auto-newer-host");
  publishProfile(host, { schema: "bridlewise-promotion-profile/v999" }, "a newer profile on the host's source");
  const launched: { profile: string; workDirectory: string; source: string }[] = [];
  const result = promotionAuto(host.root, ` refs/remotes/origin/${SOURCE}`, host.document, (pair, source) => { launched.push({ profile: pair.profile, workDirectory: pair.workDirectory, source }); return 1; }, {});
  assert.equal(result.code, "promotion_triggered", result.message);
  assert.deepEqual(launched.map((entry) => [entry.profile, entry.source]), [[PROFILE_NAME, host.tip(SOURCE)]]);
  assert.equal(basename(launched[0]!.workDirectory), PROFILE_NAME, "the pair names the profile's own private directory");
});

test("M3 (PROMO-3+4-FIX): an unattended run's log lives as long as the record that may point at it — a launch removes only the logs older than the record's start, never the record's own, never a newer one", () => {
  const workDirectory = join(createTempDir("promotion-logs-"), PROFILE_NAME);
  const variable = ROOT_POLICY.workflow.promotion.logEnvironmentVariable;
  const opened = (now: number): string => {
    const log = openUnattendedLog(workDirectory, now);
    closeSync(log.fd);
    return log.path;
  };
  const old = opened(1_000);
  const recorded = opened(2_000);
  const previous = process.env[variable];
  process.env[variable] = recorded;
  try {
    lastRunRecorder(workDirectory, PROFILE_NAME, "apply", () => new Date(3_000)).end(answer("promotion_gate_failed", "the gate failed", {}));
  } finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  }
  assert.equal(readLastRun(workDirectory)?.log, recorded, "the record names its log");
  const coalesced = opened(4_000);
  opened(5_000);
  assert.equal(existsSync(old), false, "a log no record can point at goes");
  assert.equal(existsSync(recorded), true, "the record's own log stays: the failure notice points at it");
  assert.equal(existsSync(coalesced), true, "a log newer than the record stays");
});
