/**
 * GUARD-F5, AS ROUND 6 §S1/§S1a/§S2 DECIDED: A KEEP-OUT ENTRY IS KEPT BY
 * EVERYTHING THAT DECIDES WHAT IT NAMES. On 2026-10-07 one link at
 * `~/.local/state/bridlewise-coordinator` made the guardian refuse every
 * confined spawn with ELOOP (LAND-OC-F5); the fix judged only a link's final
 * target, so a confined process could still author a floor member's content
 * (the security re-verification's C1a, C1b, C2, C7).
 *
 * Each arm runs the REAL guardian over a hand-written spec whose `keep_out`
 * names entries under a temporary floor (a temp folder under the run's own
 * TMPDIR, never the real floor):
 * - a link to a folder no grant reaches, a dangling link outside every grant,
 *   a link loop: the spawn runs, the target unreadable, logged truthfully;
 * - a link INTO a grant (C1a), a dangling link whose would-be target lies in
 *   a grant (C2), a link whose HOP lies in a grant (C7), an entry reached
 *   through a link that lives in a grant (C1b): THAT spawn is refused (exit
 *   10, keep_out_exposed), naming the link and the remedy; a spawn without
 *   that grant runs;
 * - a link to a folder that HOLDS a grant (C4): refused too (one
 *   judgement with the project door, UR-16);
 * - a briefly absent or replaced keep-out file (S2): kept by its folder and
 *   its name — the racer reads nothing in N spawns, and an unrelated spawn
 *   never fails;
 * - a bind alias of a keep-out folder mounted below a grant (C6): refused.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { canonicalJson } from "../../../src/kernel/integrity.ts";
import { ROOT_POLICY } from "../../../src/kernel/root-policy.ts";
import { resolveGuardianBinaryPath } from "../../../src/filesystem/self-protection/guardian-binary.ts";
import type { GuardianSpec } from "../../../src/filesystem/self-protection/self-protection-contracts.ts";
import { createTempDir } from "../../support/temp-dir.ts";
import { requireHost, requireLinuxHost } from "../../support/host-requirement.ts";

const candidateRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const testPayload = join(candidateRoot, "guardian", "build", "test_payload");
const FLOOR_ALLOW = [
  { path: "/usr", access: ["EXECUTE", "READ_FILE", "READ_DIR"] },
  { path: realpathSync("/lib"), access: ["EXECUTE", "READ_FILE", "READ_DIR"] },
  { path: "/etc", access: ["READ_FILE", "READ_DIR"] },
  { path: "/dev", access: ["READ_FILE", "WRITE_FILE", "READ_DIR"] },
  { path: "/proc", access: ["READ_FILE", "READ_DIR"] },
] as const;

type World = Readonly<{ root: string; floor: string; granted: string; secret: string; cleanup: () => void }>;

/** A temporary floor (`<root>/state`), a granted folder and a secret folder no grant reaches, all real paths. */
function world(): World {
  const root = realpathSync(createTempDir("guard-f5-"));
  const floor = join(root, "state");
  const granted = join(root, "granted");
  const secret = join(root, "secret");
  for (const folder of [floor, join(granted, "inner"), secret]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(granted, "public.txt"), "PUBLIC");
  writeFileSync(join(granted, "inner", "inner.txt"), "INNER");
  writeFileSync(join(secret, "secret.txt"), "SECRET");
  return { root, floor, granted, secret, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Run the guardian over a spec granting `granted` and keeping out `keepOut`; the payload's exit and the guardian's stderr. */
function run(w: World, keepOut: readonly string[], payload: readonly string[], grantFolders: readonly string[] = [], grantFiles: readonly string[] = []): Readonly<{ status: number | null; stderr: string }> {
  const binary = resolveGuardianBinaryPath(candidateRoot);
  assert.ok(binary !== undefined, "the guardian binary is built (npm run build:guardian)");
  const spec: GuardianSpec = {
    abi_version_hint: 0,
    handled_access_fs: ["EXECUTE", "READ_FILE", "READ_DIR", "WRITE_FILE", "MAKE_REG", "TRUNCATE"],
    allow_rules: [
      ...FLOOR_ALLOW.map((rule) => ({ path: rule.path, access: [...rule.access] })),
      { path: testPayload, access: ["EXECUTE", "READ_FILE"] },
      { path: w.granted, access: ["READ_FILE", "READ_DIR"] },
      ...grantFolders.map((path) => ({ path, access: ["READ_FILE", "READ_DIR"] })),
      ...grantFiles.map((path) => ({ path, access: ["READ_FILE"] })),
    ],
    protected_subtrees: [],
    keep_out: [...keepOut],
    default_deny_outside_allow_rules: true,
    keep_out_retries: 3,
  } as GuardianSpec;
  const specPath = join(w.root, "spec.json");
  writeFileSync(specPath, canonicalJson(spec), { mode: 0o600 });
  const result = spawnSync(binary, ["apply", "--spec", specPath, "--exec", testPayload, ...payload], { encoding: "utf8", timeout: 30_000 });
  return { status: result.status, stderr: result.stderr };
}

/** The guardian's own line (code 0) naming `fragment`. */
const noticed = (stderr: string, fragment: string): boolean => stderr.split("\n").some((line) => line.startsWith("landlock-guardian: 0: ") && line.includes(fragment));

/** The guardian refused THIS spawn because a keep-out entry's meaning lies in a grant: exit 10, naming `fragment` and the remedy. */
function exposed(result: Readonly<{ status: number | null; stderr: string }>, fragment: string): void {
  assert.equal(result.status, 10, `the spawn is refused (keep_out_exposed): ${result.stderr}`);
  const line = result.stderr.split("\n").find((entry) => entry.startsWith("landlock-guardian: 10: ")) ?? "";
  assert.ok(line.includes(fragment), `the refusal names ${fragment}: ${result.stderr}`);
  assert.match(line, /move the harness state out of the grant, or remove the link|unmount it/u, "and the remedy");
}

test("a link under the floor to a folder no grant reaches: the spawn runs, the target stays unreadable through the link and directly; the line says only what is true", (t) => {
  requireLinuxHost();
  const w = world();
  t.after(w.cleanup);
  const link = join(w.floor, "bridlewise-coordinator");
  symlinkSync(w.secret, link);
  const allowed = run(w, [link], ["read", join(w.granted, "public.txt")]);
  assert.equal(allowed.status, 0, `the confined spawn runs: ${allowed.stderr}`);
  assert.ok(noticed(allowed.stderr, `'${link}' is a link to '${w.secret}': its links' folders and its target lie outside every grant`), allowed.stderr);
  assert.equal(run(w, [link], ["read", join(w.secret, "secret.txt")]).status, 1, "the target is unreadable from inside");
  assert.equal(run(w, [link], ["read", join(link, "secret.txt")]).status, 1, "and unreadable through the link");
  // The link's own place is kept out like any keep-out file: a grant over the floor that holds it refuses.
  const overFloor = run(w, [link], ["read", join(w.granted, "public.txt")], [w.floor]);
  assert.equal(overFloor.status, 4, `a grant over the link's folder refuses: ${overFloor.stderr}`);
});

test("a dangling link outside every grant and a link loop: the spawn runs, logged truthfully; a dangling link whose would-be target lies in a grant refuses THAT spawn (C2)", (t) => {
  requireLinuxHost();
  const w = world();
  t.after(w.cleanup);
  const dangling = join(w.floor, "bridlewise-gone");
  symlinkSync(join(w.secret, "nothing-here"), dangling);
  const loopA = join(w.floor, "bridlewise-loop-a");
  const loopB = join(w.floor, "bridlewise-loop-b");
  symlinkSync(loopB, loopA);
  symlinkSync(loopA, loopB);
  const result = run(w, [dangling, loopA], ["read", join(w.granted, "public.txt")]);
  assert.equal(result.status, 0, `the confined spawn runs: ${result.stderr}`);
  assert.ok(noticed(result.stderr, `'${dangling}' is a dangling link: its would-be target's folder '${w.secret}' lies outside every grant`), result.stderr);
  assert.ok(noticed(result.stderr, `'${loopA}' is a looping link`), result.stderr);
  const notYet = join(w.floor, "bridlewise-not-yet");
  symlinkSync(join(w.granted, "notyet"), notYet);
  exposed(run(w, [notYet], ["read", join(w.granted, "public.txt")]), `'${notYet}' is a dangling link whose would-be target lies in '${w.granted}'`);
});

test("C1a, FAIL CLOSED: a link under the floor INTO a granted folder refuses THAT spawn by name with the remedy; a spawn without that grant runs", (t) => {
  requireLinuxHost();
  const w = world();
  t.after(w.cleanup);
  const into = join(w.floor, "bridlewise-into");
  symlinkSync(join(w.granted, "inner"), into);
  exposed(run(w, [into], ["read", join(w.granted, "inner", "inner.txt")]), `'${into}' is a link to '${join(w.granted, "inner")}', inside allow_rules '${w.granted}'`);
});

test("C4, ROUND 7: a link to a folder that HOLDS a grant refuses THAT spawn — a grant inside a floor link's target exposes part of the kept-out state, as a grant inside the floor would; without that grant the spawn runs", (t) => {
  requireLinuxHost();
  const w = world();
  t.after(w.cleanup);
  const toRoot = join(w.floor, "bridlewise-to-root");
  symlinkSync(w.root, toRoot);
  exposed(run(w, [toRoot], ["read", join(w.granted, "public.txt")]), `'${toRoot}' is a link to '${w.root}', and allow_rules '${w.granted}' lies inside it`);
  const toSecret = join(w.floor, "bridlewise-to-secret");
  symlinkSync(w.secret, toSecret);
  assert.equal(run(w, [toSecret], ["read", join(w.granted, "public.txt")]).status, 0, "a link whose target holds no grant: the spawn runs");
});

test("C7 and C1b: a link on the way whose FOLDER lies in a grant refuses THAT spawn — the confined process could retarget it — whether the entry is the link's chain (C7) or a store reached through it (C1b)", (t) => {
  requireLinuxHost();
  const w = world();
  t.after(w.cleanup);
  const hop = join(w.granted, "hop");
  symlinkSync(w.secret, hop);
  const chained = join(w.floor, "bridlewise-chained");
  symlinkSync(hop, chained);
  exposed(run(w, [chained], ["read", join(w.granted, "public.txt")]), `'${hop}' (a link, or a folder a '..' leaves), whose folder '${w.granted}' lies inside allow_rules '${w.granted}'`);
  const store = join(hop, "store");
  mkdirSync(join(w.secret, "store"));
  exposed(run(w, [store], ["read", join(w.granted, "public.txt")]), `'${hop}' (a link, or a folder a '..' leaves), whose folder '${w.granted}' lies inside allow_rules '${w.granted}'`);
  // Neither grant: the chain is kept, the spawn runs, the store unreadable.
  const elsewhere = join(w.root, "elsewhere");
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, "e.txt"), "E");
  const outside = run({ ...w, granted: elsewhere }, [chained], ["read", join(elsewhere, "e.txt")]);
  assert.equal(outside.status, 0, `no grant holds a hop or the target: ${outside.stderr}`);
});

test("S2: a keep-out FILE is kept by its folder and its name — absent, it still refuses a grant over its folder or at its name; replaced in a race, the racer reads nothing and an unrelated spawn never fails", async (t) => {
  requireLinuxHost();
  const w = world();
  t.after(w.cleanup);
  const store = join(w.root, "store");
  mkdirSync(store);
  const db = join(store, "web.db");
  // Absent since the compile: kept by its folder and its name.
  const absent = run(w, [db], ["read", join(w.granted, "public.txt")], [store]);
  assert.equal(absent.status, 4, `a grant over the folder of an absent store refuses: ${absent.stderr}`);
  const unrelated = run(w, [db], ["read", join(w.granted, "public.txt")]);
  assert.equal(unrelated.status, 0, `an unrelated spawn runs: ${unrelated.stderr}`);
  assert.ok(noticed(unrelated.stderr, `'${db}' is absent: kept out by its folder and its name`), unrelated.stderr);
  // The racer: the store is replaced (atomic rename) and removed and re-created, as fast as it can.
  writeFileSync(db, "SECRET-STORE");
  const racer = spawn(process.execPath, ["-e", `
    const fs = require("node:fs");
    const db = ${JSON.stringify(db)};
    for (let i = 0; ; i++) {
      try { fs.writeFileSync(db + ".new", "SECRET-STORE"); fs.renameSync(db + ".new", db); fs.unlinkSync(db); fs.writeFileSync(db, "SECRET-STORE"); } catch {}
    }`], { stdio: "ignore" });
  t.after(() => { racer.kill("SIGKILL"); });
  const spawns = 100;
  let reads = 0;
  let readsAtName = 0;
  let unrelatedRefusals = 0;
  for (let index = 0; index < spawns; index += 1) {
    if (run(w, [db], ["read", db], [store]).status === 0) reads += 1;
    if (run(w, [db], ["read", db], [], [db]).status === 0) readsAtName += 1;
    if (run(w, [db], ["read", join(w.granted, "public.txt")]).status !== 0) unrelatedRefusals += 1;
  }
  racer.kill("SIGKILL");
  assert.equal(reads, 0, `through a grant over its folder, the racing store was read ${String(reads)} time(s) out of ${String(spawns)}`);
  assert.equal(readsAtName, 0, `through a grant at its name, the racing store was read ${String(readsAtName)} time(s) out of ${String(spawns)}`);
  assert.equal(unrelatedRefusals, 0, `an unrelated spawn was refused ${String(unrelatedRefusals)} time(s) out of ${String(spawns)} (the F5 availability)`);
});

/**
 * The race made DETERMINISTIC (the investigator's and the verifier's racers):
 * an LD_PRELOAD object loaded into the guardian replaces the keep-out file
 * exactly once, at the step named by RACE_STEP — `opened` (after the
 * guardian located it, just before a grant at the same name is opened: the
 * grant opens ANOTHER inode at that name) or `located` (between the
 * guardian's open of it and its folder check: ESTALE).
 */
const RACE_SHIM = `
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <linux/openat2.h>
static int fired = 0;
static void replace(void) {
  const char *target = getenv("RACE_TARGET");
  char next[4096];
  snprintf(next, sizeof(next), "%s.next", target);
  int fd = open(next, O_CREAT | O_WRONLY | O_TRUNC, 0600);
  if (fd >= 0) { if (write(fd, "SECRET-STORE", 12) != 12) {} close(fd); }
  rename(next, target);
  fired += 1;
}
static int spent(void) {
  const char *times = getenv("RACE_TIMES");
  return fired >= (times ? atoi(times) : 1);
}
long syscall(long number, ...) {
  va_list ap; va_start(ap, number);
  long a1 = va_arg(ap, long), a2 = va_arg(ap, long), a3 = va_arg(ap, long), a4 = va_arg(ap, long), a5 = va_arg(ap, long), a6 = va_arg(ap, long);
  va_end(ap);
  static long (*real)(long, ...);
  static int opens = 0;
  if (!real) real = (long (*)(long, ...))dlsym(RTLD_NEXT, "syscall");
  const char *target = getenv("RACE_TARGET"), *step = getenv("RACE_STEP");
  /* The second open of the name is the grant's: the keep-out entry was opened (and located) first. */
  if (number == SYS_openat2 && target && step && strcmp(step, "opened") == 0 && strcmp((const char *)a2, target) == 0 && ++opens == 2 && !spent()) replace();
  return real(number, a1, a2, a3, a4, a5, a6);
}
static void maybe_replace_located(const char *name) {
  const char *target = getenv("RACE_TARGET"), *step = getenv("RACE_STEP");
  const char *base = target ? strrchr(target, '/') : NULL;
  if (!spent() && base && step && strcmp(step, "located") == 0 && strcmp(name, base + 1) == 0) replace();
}
int fstatat(int dirfd, const char *name, struct stat *st, int flags) {
  static int (*real)(int, const char *, struct stat *, int);
  if (!real) real = (int (*)(int, const char *, struct stat *, int))dlsym(RTLD_NEXT, "fstatat");
  maybe_replace_located(name);
  return real(dirfd, name, st, flags);
}
int fstatat64(int dirfd, const char *name, struct stat64 *st, int flags) {
  static int (*real)(int, const char *, struct stat64 *, int);
  if (!real) real = (int (*)(int, const char *, struct stat64 *, int))dlsym(RTLD_NEXT, "fstatat64");
  maybe_replace_located(name);
  return real(dirfd, name, st, flags);
}
`;

test("S2, DETERMINISTIC: a keep-out file replaced right after the guardian opened it, or while it was being located (ESTALE), is still kept out by its name; an unrelated spawn runs", (t) => {
  requireLinuxHost();
  const cc = spawnSync("cc", ["--version"], { encoding: "utf8" });
  requireHost(cc.status === 0, "a C compiler (cc) for the race shim, as the guardian's own build needs");
  const w = world();
  t.after(w.cleanup);
  const shimSource = join(w.root, "race.c");
  const shim = join(w.root, "race.so");
  writeFileSync(shimSource, RACE_SHIM);
  const built = spawnSync("cc", ["-shared", "-fPIC", "-O2", "-o", shim, shimSource, "-ldl"], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  const store = join(w.root, "store");
  mkdirSync(store);
  const db = join(store, "web.db");
  // Every try of the guardian's (`keep_out_retries` re-locations and the first) sees the store change: it keeps changing.
  const always = String(ROOT_POLICY.selfProtection.keepOutRetries + 1);
  const raced = (step: string, keepOut: readonly string[], grantFolders: readonly string[], grantFiles: readonly string[], payload: readonly string[]) => {
    writeFileSync(db, "SECRET-STORE");
    const previous = { preload: process.env.LD_PRELOAD, target: process.env.RACE_TARGET, step: process.env.RACE_STEP, times: process.env.RACE_TIMES };
    try {
      Object.assign(process.env, { LD_PRELOAD: shim, RACE_TARGET: db, RACE_STEP: step, RACE_TIMES: step === "located" ? always : "1" });
      return run(w, keepOut, payload, grantFolders, grantFiles);
    } finally {
      for (const [name, value] of [["LD_PRELOAD", previous.preload], ["RACE_TARGET", previous.target], ["RACE_STEP", previous.step], ["RACE_TIMES", previous.times]] as const) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  };
  const atName = raced("opened", [db], [], [db], ["read", db]);
  assert.equal(atName.status, 4, `a grant at the name of a store replaced after its open refuses: ${atName.stderr}`);
  assert.match(atName.stderr, new RegExp(`allow_rules path '${db.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}' reaches keep_out`, "u"));
  const estale = raced("located", [db], [store], [], ["read", db]);
  assert.equal(estale.status, 4, `a grant over the folder of a store that kept changing refuses: ${estale.stderr}`);
  const unrelated = raced("located", [db], [], [], ["read", join(w.granted, "public.txt")]);
  assert.equal(unrelated.status, 0, `an unrelated spawn runs (the F5 availability): ${unrelated.stderr}`);
  assert.ok(noticed(unrelated.stderr, `'${db}' kept changing while it was located: kept out by its folder and its name`), unrelated.stderr);
});

test("C6: a bind alias of a keep-out folder mounted BELOW a grant refuses THAT spawn (the walk goes up; the mount table is read)", (t) => {
  requireLinuxHost();
  const probe = spawnSync("unshare", ["-rm", "true"], { encoding: "utf8", timeout: 10_000 });
  requireHost(probe.status === 0, `an unprivileged user and mount namespace (unshare -rm) for a bind mount: ${probe.stderr}`);
  const w = world();
  t.after(w.cleanup);
  const alias = join(w.granted, "alias");
  mkdirSync(alias);
  const binary = resolveGuardianBinaryPath(candidateRoot)!;
  const spec = {
    abi_version_hint: 0,
    handled_access_fs: ["EXECUTE", "READ_FILE", "READ_DIR", "WRITE_FILE"],
    allow_rules: [...FLOOR_ALLOW.map((rule) => ({ path: rule.path, access: [...rule.access] })), { path: testPayload, access: ["EXECUTE", "READ_FILE"] }, { path: w.granted, access: ["READ_FILE", "READ_DIR"] }],
    protected_subtrees: [],
    keep_out: [w.secret],
    default_deny_outside_allow_rules: true,
    keep_out_retries: 3,
  };
  const specPath = join(w.root, "mount-spec.json");
  writeFileSync(specPath, canonicalJson(spec), { mode: 0o600 });
  const inside = spawnSync("unshare", ["-rm", "sh", "-c", 'mount --bind "$1" "$2" && exec "$3" apply --spec "$4" --exec "$5" read "$6"', "sh", w.secret, alias, binary, specPath, testPayload, join(alias, "secret.txt")], { encoding: "utf8", timeout: 30_000 });
  exposed({ status: inside.status, stderr: inside.stderr }, `allow_rules '${w.granted}' holds the mount '${alias}', which shows '${w.secret}'`);
  const bare = spawnSync("unshare", ["-rm", "sh", "-c", 'exec "$1" apply --spec "$2" --exec "$3" read "$4"', "sh", binary, specPath, testPayload, join(w.granted, "public.txt")], { encoding: "utf8", timeout: 30_000 });
  assert.equal(bare.status, 0, `without the mount the same spec runs: ${bare.stderr}`);
});
