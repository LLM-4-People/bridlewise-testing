/**
 * ONE DEFINITION OF HOW A FLOOR LINK RESOLVES, TWO JUDGES THAT AGREE
 * (UR-16). The guardian (C, `resolve_entry`) and the
 * TypeScript keep-out list (`keepOutLinkPlaces`, read by the project door's
 * `grantVerdict` and by the spec compiler) resolve a link under the floor the
 * same way: each link's folder on the way, and the target — or a dangling
 * link's would-be target's deepest existing folder.
 *
 * On the same worlds (a temporary HOME whose `~/.local/state/bridlewise-*`
 * floor holds the link, a project P and a secret folder), both refuse P when
 * P holds what decides the floor member's content: its target (C1a), a hop's
 * folder (C7) or a dangling link's would-be target's folder (C2); both accept
 * P when the link leads elsewhere, and both refuse P when P lies AT OR UNDER a
 * floor link's target (part of the kept-out state would be P's — no
 * difference between the judges, UR-16).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveGuardianBinaryPath } from "../../../src/filesystem/self-protection/guardian-binary.ts";
import { emittedKeepOut, keepOutLinkPlaces, keepOutPolicyFor, type KeepOutFacts } from "../../../src/filesystem/self-protection/keep-out.ts";
import { DEFAULT_SELF_PROTECTION_CONFIG, parseSelfProtectionConfig } from "../../../src/filesystem/self-protection/self-protection-config.ts";
import { canonicalJson } from "../../../src/kernel/integrity.ts";
import { PRODUCT_NAME } from "../../../src/kernel/product-identity.ts";
import { ROOT_POLICY } from "../../../src/kernel/root-policy.ts";
import { emptyKeepOutFacts } from "../../support/keep-out-facts.ts";
import { requireHost, requireLinuxHost } from "../../support/host-requirement.ts";
import { createTempDir } from "../../support/temp-dir.ts";

const ENGINE = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const PAYLOAD = join(ENGINE, "guardian", "build", "test_payload");

type World = Readonly<{ home: string; floor: string; project: string; secret: string; harness: string }>;

function world(t: { after: (fn: () => void) => void }): World {
  const root = realpathSync(createTempDir("keep-out-link-contract-"));
  const home = join(root, "home");
  const floor = join(home, ".local", "state");
  const project = join(root, "project");
  const secret = join(root, "secret");
  const harness = join(root, "harness");
  for (const folder of [floor, join(project, "inner"), secret, join(harness, "src")]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(project, "inner", "data"), "HARNESS-STATE");
  const previous = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return { home, floor, project, secret, harness };
}

let lastDoorRefusal = "";

/** The project door's judgement of `project` (the one keep-out list, under this world's HOME): refused by a verdict, or by the list itself refusing to judge (an unsearchable folder this user owns, MF-B). */
function doorRefuses(w: World, facts: Partial<KeepOutFacts> = {}): boolean {
  const config = parseSelfProtectionConfig({ ...DEFAULT_SELF_PROTECTION_CONFIG, enabled: true });
  lastDoorRefusal = "";
  try {
    return keepOutPolicyFor(config, { ...emptyKeepOutFacts(), harnessRoot: w.harness, ...facts }).grantVerdict(w.project) !== undefined;
  } catch (error) {
    if ((error as { code?: string }).code !== "self_protection_keep_out_folder_unsearchable") throw error;
    lastDoorRefusal = (error as Error).message;
    return true;
  }
}

let lastGuardianLog = "";

/** A project grant that can make and remove entries (a FIFO's folder inside it is then judged, MF-B). */
const ENTRY_CHANGING = ["READ_FILE", "READ_DIR", "WRITE_FILE", "MAKE_REG", "REMOVE_FILE"] as const;

/** The guardian's judgement of a spawn granted `project` (to read, unless `projectAccess` says more), keeping out `member`: refused (exit 10) or run. */
function guardianRefuses(w: World, member: string | readonly string[], projectAccess: readonly string[] = ["READ_FILE", "READ_DIR"]): boolean {
  const binary = resolveGuardianBinaryPath(ENGINE);
  assert.ok(binary !== undefined, "the guardian binary is built");
  const spec = {
    abi_version_hint: 0,
    handled_access_fs: [...new Set(["EXECUTE", "READ_FILE", "READ_DIR", ...projectAccess])],
    allow_rules: [
      { path: "/usr", access: ["EXECUTE", "READ_FILE", "READ_DIR"] },
      { path: realpathSync("/lib"), access: ["EXECUTE", "READ_FILE", "READ_DIR"] },
      { path: PAYLOAD, access: ["EXECUTE", "READ_FILE"] },
      { path: w.project, access: projectAccess },
    ],
    protected_subtrees: [],
    keep_out: typeof member === "string" ? [member] : member,
    keep_out_retries: ROOT_POLICY.selfProtection.keepOutRetries,
  };
  const specPath = join(dirname(w.home), "spec.json");
  writeFileSync(specPath, canonicalJson(spec), { mode: 0o600 });
  const result = spawnSync(binary, ["apply", "--spec", specPath, "--exec", PAYLOAD, "read", PAYLOAD], { encoding: "utf8", timeout: 30_000 });
  lastGuardianLog = result.stderr;
  assert.ok(result.status === 10 || result.status === 0, `the guardian either refused this spawn (10) or ran it: ${String(result.status)} ${result.stderr}`);
  return result.status === 10;
}

test("the one definition: a link's folders on the way and its target, or a dangling link's would-be target's deepest folder — the same places the guardian judges", (t) => {
  requireLinuxHost();
  const w = world(t);
  const hop = join(w.project, "hop");
  symlinkSync(w.secret, hop);
  const chained = join(w.floor, `${PRODUCT_NAME}-chained`);
  symlinkSync(hop, chained);
  assert.deepEqual(keepOutLinkPlaces(chained), { hops: [{ link: chained, folder: w.floor }, { link: hop, folder: w.project }], target: w.secret, dangling: false, looping: false, unsearchable: false, blocked: null, inert: false });
  const dangling = join(w.floor, `${PRODUCT_NAME}-not-yet`);
  symlinkSync(join(w.project, "missing", "deeper"), dangling);
  assert.deepEqual(keepOutLinkPlaces(dangling), { hops: [{ link: dangling, folder: w.floor }], target: w.project, dangling: true, looping: false, unsearchable: false, blocked: null, inert: false });
  // A `..` that leaves a folder: the folder holding it decides where the `..` lands (MF-1).
  mkdirSync(join(w.project, "sub"));
  const dotted = join(w.floor, `${PRODUCT_NAME}-dotted`);
  symlinkSync(`${w.project}/sub/../../secret`, dotted);
  assert.deepEqual(keepOutLinkPlaces(dotted), {
    hops: [{ link: dotted, folder: w.floor }, { link: join(w.project, "sub"), folder: w.project }, { link: w.project, folder: dirname(w.project) }],
    target: w.secret, dangling: false, looping: false, unsearchable: false, blocked: null, inert: false,
  });
  assert.equal(keepOutLinkPlaces(w.secret), undefined, "no link on the way");
});

/** Both judges on a world whose floor member links to `target(w)`. */
function bothJudge(t: { after: (fn: () => void) => void }, target: (w: World) => string, refused: boolean): void {
  requireLinuxHost();
  const w = world(t);
  const member = join(w.floor, `${PRODUCT_NAME}-member`);
  symlinkSync(target(w), member);
  assert.equal(guardianRefuses(w, member), refused, "the guardian");
  assert.equal(doorRefuses(w), refused, "the project door");
}

test("both judges agree — C1a: a floor link INTO the project is refused by both", (t) => {
  bothJudge(t, (w) => join(w.project, "inner"), true);
});

test("both judges agree — C2: a dangling floor link whose would-be target lies in the project is refused by both", (t) => {
  bothJudge(t, (w) => join(w.project, "notyet"), true);
});

test("both judges agree — a floor link to a folder no grant reaches is accepted by both", (t) => {
  bothJudge(t, (w) => w.secret, false);
});

test("both judges agree — C7: a floor link whose HOP lives in the project is refused by both", (t) => {
  requireLinuxHost();
  const w = world(t);
  const hop = join(w.project, "hop");
  symlinkSync(w.secret, hop);
  const member = join(w.floor, `${PRODUCT_NAME}-chained`);
  symlinkSync(hop, member);
  assert.equal(guardianRefuses(w, member), true, "the guardian");
  assert.equal(doorRefuses(w), true, "the project door");
});

test("both judges agree — a project INSIDE a floor link's target is refused by both (no difference)", (t) => {
  requireLinuxHost();
  const w = world(t);
  const member = join(w.floor, `${PRODUCT_NAME}-around`);
  symlinkSync(dirname(w.project), member);
  assert.equal(guardianRefuses(w, member), true, "the guardian");
  assert.equal(doorRefuses(w), true, "the project door");
});

test("both judges agree — C8 (MF-1): a floor link whose text passes THROUGH the project and leaves it by `..` is refused by both", (t) => {
  requireLinuxHost();
  const w = world(t);
  mkdirSync(join(w.project, "sub"));
  const member = join(w.floor, `${PRODUCT_NAME}-dd`);
  symlinkSync(`${w.project}/sub/../../secret`, member);
  assert.equal(guardianRefuses(w, member), true, "the guardian");
  assert.match(lastGuardianLog, /a folder a '\.\.' leaves/u);
  assert.equal(doorRefuses(w), true, "the project door");
  // The relative spelling too.
  rmSync(member);
  symlinkSync(`../../../project/sub/../../secret`, member);
  assert.equal(guardianRefuses(w, member), true, "the guardian, relative");
  assert.equal(doorRefuses(w), true, "the project door, relative");
});

test("MF-2, the reviewer's repro end to end: a home credential store that is a link chain THROUGH the granted project keeps every hop — the door refuses the project, the emitted list names the store by its links, and the guardian refuses the spawn", (t) => {
  requireLinuxHost();
  const w = world(t);
  const other = join(dirname(w.project), "other");
  mkdirSync(join(other, "ssh"), { recursive: true });
  writeFileSync(join(other, "ssh", "config"), "Host *\n");
  symlinkSync(join(other, "ssh"), join(w.project, "l"));
  symlinkSync(join(w.project, "l"), join(w.home, ".ssh"));
  assert.equal(doorRefuses(w), true, "the project door refuses the project that holds a hop of ~/.ssh");
  const config = parseSelfProtectionConfig({ ...DEFAULT_SELF_PROTECTION_CONFIG, enabled: true });
  const emitted = emittedKeepOut(keepOutPolicyFor(config, { ...emptyKeepOutFacts(), harnessRoot: w.harness }).entries).keepOut;
  assert.ok(emitted.includes(join(w.home, ".ssh")), `the store is emitted as it is named, its links kept: ${emitted.join(", ")}`);
  assert.equal(guardianRefuses(w, emitted), true, "the guardian refuses a spawn granted the project");
  assert.match(lastGuardianLog, /\.ssh/u);
  assert.equal(readFileSync(join(other, "ssh", "config"), "utf8"), "Host *\n", "nothing ran, so nothing rewrote the store");
});

test("MF-3: a floor member linked to /dev/null, linked to a FIFO no grant can replace, that IS a FIFO, or linked into a folder ANOTHER user owns and this user cannot search is kept out by its name and said — it never refuses an unrelated spawn, in either judge, and never makes /dev ungrantable", (t) => {
  requireLinuxHost();
  const w = world(t);
  const fifo = join(dirname(w.project), "pipe");
  spawnSync("mkfifo", [fifo]);
  const members = [join(w.floor, `${PRODUCT_NAME}-null`), join(w.floor, `${PRODUCT_NAME}-fifo-link`), join(w.floor, `${PRODUCT_NAME}-fifo`)];
  symlinkSync("/dev/null", members[0]!);
  symlinkSync(fifo, members[1]!);
  spawnSync("mkfifo", [members[2]!]);
  assert.equal(guardianRefuses(w, members, ENTRY_CHANGING), false, `the guardian runs the unrelated spawn: ${lastGuardianLog}`);
  assert.match(lastGuardianLog, /no grant can make or remove entries in its folder/u);
  assert.equal(doorRefuses(w), false, "the project door accepts the unrelated project");
  const config = parseSelfProtectionConfig({ ...DEFAULT_SELF_PROTECTION_CONFIG, enabled: true });
  assert.equal(keepOutPolicyFor(config, { ...emptyKeepOutFacts(), harnessRoot: w.harness }).grantVerdict("/dev", ["READ_FILE", "WRITE_FILE", "READ_DIR"]), undefined, "a member linked to /dev/null never makes /dev (granted to read and write files) ungrantable");
  // A folder ANOTHER user owns (root's home) is no folder a confined process can change: kept out by its name.
  const foreign = "/root";
  const foreignStat = statSync(foreign, { throwIfNoEntry: false });
  requireHost(foreignStat !== undefined && foreignStat.uid !== process.geteuid?.() && spawnSync("ls", [foreign]).status !== 0, "a folder another user owns that this user cannot search (/root)");
  const closed = join(w.floor, `${PRODUCT_NAME}-foreign`);
  symlinkSync(join(foreign, "inside", "x"), closed);
  assert.equal(guardianRefuses(w, closed), false, `the guardian runs the unrelated spawn: ${lastGuardianLog}`);
  assert.match(lastGuardianLog, /a folder another user owns that this user cannot search/u);
  assert.equal(doorRefuses(w), false, "the project door accepts the unrelated project");
});

/** Runs `judge` with `folder` made unsearchable (mode 000) the way a confined process could, and restores it. */
function whileClosed<T>(folder: string, judge: () => T): T {
  chmodSync(folder, 0o000);
  try { return judge(); } finally { chmodSync(folder, 0o700); }
}

test("MF-B: an unsearchable folder THIS user owns never hides what lies behind it — the reviewer's chmod-000 worlds (a deeper folder, the floor folder holding a link into the project or a dangling link into it) are refused by both judges, named", (t) => {
  requireLinuxHost();
  // A deeper folder: the floor member links through W/d/hop/data, and d/hop leads into the project.
  {
    const w = world(t);
    const outer = join(dirname(w.project), "W");
    mkdirSync(join(outer, "d"), { recursive: true });
    symlinkSync(join(w.project, "inner"), join(outer, "d", "hop"));
    const member = join(w.floor, `${PRODUCT_NAME}-deep`);
    symlinkSync(join(outer, "d", "hop", "data"), member);
    assert.equal(guardianRefuses(w, member), true, "the guardian refuses while the hop is visible");
    assert.equal(whileClosed(join(outer, "d"), () => guardianRefuses(w, member)), true, `the guardian refuses with d closed: ${lastGuardianLog}`);
    assert.match(lastGuardianLog, /a folder this user owns but cannot search/u);
    assert.equal(whileClosed(join(outer, "d"), () => doorRefuses(w)), true, "the project door refuses with d closed");
    assert.match(lastDoorRefusal, /a folder this user owns but cannot search/u);
  }
  // The floor folder itself, holding a link into the project (C1a) and a dangling link into it (C2).
  for (const [name, into] of [["c1a", "inner"], ["c2", "notyet"]] as const) {
    const w = world(t);
    const member = join(w.floor, `${PRODUCT_NAME}-${name}`);
    symlinkSync(join(w.project, into), member);
    assert.equal(whileClosed(w.floor, () => guardianRefuses(w, member)), true, `${name}: the guardian refuses with the floor folder closed: ${lastGuardianLog}`);
    assert.match(lastGuardianLog, /a folder this user owns but cannot search/u);
    assert.equal(whileClosed(w.floor, () => doorRefuses(w)), true, `${name}: the project door refuses with the floor folder closed`);
  }
});

test("MF-B: a floor link to a FIFO INSIDE a project granted to make or remove entries is refused by both judges (whoever can replace it there owns what it names)", (t) => {
  requireLinuxHost();
  const w = world(t);
  const fifo = join(w.project, "pipe");
  spawnSync("mkfifo", [fifo]);
  const member = join(w.floor, `${PRODUCT_NAME}-pipe`);
  symlinkSync(fifo, member);
  assert.equal(guardianRefuses(w, member, ENTRY_CHANGING), true, `the guardian refuses: ${lastGuardianLog}`);
  assert.match(lastGuardianLog, /can make or remove entries there/u);
  assert.equal(guardianRefuses(w, member), false, "a grant that can only read cannot replace it");
  assert.equal(doorRefuses(w), true, "the project door refuses the project (a project is granted every access)");
});

test("MF-C: a host store reached through a link chain THROUGH the granted project is judged hop by hop — the door refuses the project, the emitted list names the store by its links, and the guardian refuses the spawn", (t) => {
  requireLinuxHost();
  const w = world(t);
  const other = join(dirname(w.project), "other");
  mkdirSync(join(other, "data"), { recursive: true });
  writeFileSync(join(other, "data", "bw.db"), "SQLite format 3\u0000");
  symlinkSync(join(other, "data"), join(w.project, "l"));
  symlinkSync(join(w.project, "l"), join(w.home, "data"));
  const store = join(w.home, "data", "bw.db");
  assert.equal(doorRefuses(w, { hostStores: [store] }), true, "the project door refuses the project that holds a hop of the store's folder");
  const config = parseSelfProtectionConfig({ ...DEFAULT_SELF_PROTECTION_CONFIG, enabled: true });
  const emitted = emittedKeepOut(keepOutPolicyFor(config, { ...emptyKeepOutFacts(), harnessRoot: w.harness, hostStores: [store] }).entries).keepOut;
  assert.ok(emitted.includes(store), `the store is emitted as it is named, its links kept: ${emitted.join(", ")}`);
  assert.equal(guardianRefuses(w, emitted), true, `the guardian refuses a spawn granted the project: ${lastGuardianLog}`);
  assert.match(lastGuardianLog, /bw\.db/u);
});

test("both judges follow the SAME number of links (design LOW 10: the bound is the kernel's, MAXSYMLINKS 40, written once per language): a chain of exactly 40 links into the project is refused by both; one more link is a loop to both, and neither refuses the project for it", (t) => {
  requireLinuxHost();
  for (const [links, refused] of [[40, true], [41, false]] as const) {
    const w = world(t);
    // The floor member is the first link; the rest live in a folder no grant reaches; the last points into the project.
    let next = join(w.project, "inner");
    for (let index = links - 1; index >= 1; index -= 1) {
      const hop = join(w.secret, `l${String(index)}`);
      symlinkSync(next, hop);
      next = hop;
    }
    const member = join(w.floor, `${PRODUCT_NAME}-member`);
    symlinkSync(next, member);
    assert.equal(keepOutLinkPlaces(member)?.looping, !refused, `the TypeScript walk at ${String(links)} links`);
    assert.equal(guardianRefuses(w, member), refused, `the guardian at ${String(links)} links: ${lastGuardianLog}`);
    assert.equal(doorRefuses(w), refused, `the project door at ${String(links)} links`);
  }
});
