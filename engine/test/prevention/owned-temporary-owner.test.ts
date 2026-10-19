/**
 * ONE TEMP-NAMING AND OWNER-LIVENESS RULE (`src/filesystem/private-state.ts`).
 *
 * wf1b-design M5: beside the owned naming, the atomic writer named its temps
 * `Date.now()-Math.random`, the durable filesystem and the immutable receipts
 * each spelled `.<name>.pending-<pid>-<hex>.tmp` (pid only: a recycled pid is
 * another owner), the persisted key `<path>.<hex>.stage`, three places called
 * `mkdtemp` (164 of whose guardian directories were found leaked in /tmp,
 * owner unknowable), and three lock owners judged a holder by pid alone.
 * Every one now asks the one owner. This guard refuses the old shapes coming
 * back, in the engine's code, the web server's and the engine's test support
 * (its `mkdtemp` roots were the ones a killed test process left for ever: 360
 * MB of `engine/.bridlewise/test-fixtures/owner-*` working copies, WF-DEL F-8):
 *
 *   - `mkdtemp` anywhere but the owner (`createOwnedTemporaryDirectory`);
 *   - a name built from `process.pid` as a temp/pending/stage/staging file;
 *   - `Math.random().toString(36)` (a name with no owner and no policy nonce).
 *
 * The experiment scripts (`engine/scripts/exp*`) are research records outside
 * the product and are not scanned for those shapes. They ARE scanned, with
 * the experiment library (`engine/_experiments`), for a fixed path in the
 * shared `/tmp` (wf-1b3a-correctness M3): a key file read from there is one
 * any local user can plant, and a fixed data folder there is removed by the
 * next run of anybody's copy. They take their key from the environment
 * (`engine/_experiments/experiment-environment.ts`) and their scratch from an
 * owned folder under `os.tmpdir()`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { walk } from "../../scripts/verification/source-walk.ts";
import { sourceViewOf } from "../../scripts/verification/source-view.ts";
import { atomicWriteFile } from "../../src/filesystem/atomic-write.ts";
import { abandonedSiblingTemporaries, createOwnedTemporaryDirectory, isOwnedSiblingTemporary, isOwnedTemporaryLive, ownedSiblingTemporaryName, ownedTemporaryOwnerOf, sweepAbandonedTemporaries } from "../../src/filesystem/private-state.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { createTempDir } from "../support/temp-dir.ts";

const ENGINE_ROOT = join(import.meta.dirname, "..", "..");
const REPOSITORY_ROOT = join(ENGINE_ROOT, "..");
const OWNER = "engine/src/filesystem/private-state.ts";
const SHAPES: ReadonlyArray<readonly [string, RegExp]> = [
  ["mkdtemp outside the owner", /\bmkdtemp(?:Sync)?\(/u],
  ["a temp name built from the pid", /(?:pending|stage|staging|tmp)[-.]\$\{(?:String\()?process\.pid/u],
  ["a Math.random() name", /Math\.random\(\)\.toString\(36\)/u],
];

function scanned(): ReadonlyArray<Readonly<{ path: string; text: string }>> {
  const roots = [join(ENGINE_ROOT, "src"), join(ENGINE_ROOT, "scripts"), join(ENGINE_ROOT, "test", "support"), join(REPOSITORY_ROOT, "server")];
  return roots.flatMap((root) => walk(root, { exts: [".ts", ".mts", ".mjs"] }))
    .map((file) => ({ path: relative(REPOSITORY_ROOT, file).split("\\").join("/"), text: readFileSync(file, "utf8") }))
    .filter((file) => !/^engine\/scripts\/exp/u.test(file.path) && file.path !== OWNER);
}

test("no temp name, pending file or temp directory is named outside the one owned-temporary rule", () => {
  const files = scanned();
  assert.ok(files.length > 300, `the scan saw ${String(files.length)} files: it is not seeing the code`);
  const found = files.flatMap((file) => SHAPES.filter(([, shape]) => shape.test(file.text)).map(([what]) => `${file.path}: ${what}`));
  assert.deepEqual(found, [], "name it through ownedTemporaryName / ownedSiblingTemporaryName / createOwnedTemporaryDirectory (src/filesystem/private-state.ts)");
});

/** A quoted fixed path in the shared temp folder, as the code-with-strings view shows it (comments blanked). */
const SHARED_TMP_LITERAL = /["'`]\/tmp\//u;

function sharedTmpLiterals(path: string, text: string): boolean {
  return SHARED_TMP_LITERAL.test(sourceViewOf(text, path).codeWithStringsAndTemplates());
}

test("no experiment names a fixed path in the shared /tmp: keys come from the environment, scratch from an owned folder", () => {
  const roots = [join(ENGINE_ROOT, "scripts"), join(ENGINE_ROOT, "_experiments"), join(ENGINE_ROOT, "test")];
  const files = roots.flatMap((root) => walk(root, { exts: [".ts", ".mts", ".mjs", ".js"] }))
    .map((file) => ({ path: relative(REPOSITORY_ROOT, file).split("\\").join("/"), file }))
    .filter(({ path }) => /^engine\/(?:scripts\/exp|_experiments\/|test\/[^/]+\.m?js$)/u.test(path));
  assert.ok(files.length > 20, `the scan saw ${String(files.length)} experiment files: it is not seeing them`);
  const found = files.filter(({ path, file }) => sharedTmpLiterals(path, readFileSync(file, "utf8"))).map(({ path }) => path);
  assert.deepEqual(found, [], "read the key through experimentApiFromEnvironment (engine/_experiments/experiment-environment.ts) and put scratch in an owned folder of the system temp root (createOwnedTemporaryDirectory)");
  // Planted: the three spellings that were in the tree are caught; a comment is not.
  assert.ok(sharedTmpLiterals("p.mjs", `const k = JSON.parse(readFileSync("/tmp/bridlewise/llm-api-config.json", "utf8"));`));
  assert.ok(sharedTmpLiterals("p.mjs", "const p = `/tmp/exp445-i1-${process.pid}.bin`;"));
  assert.ok(sharedTmpLiterals("p.ts", `const d = { dataDir: '/tmp/bridlewise/exp452-1m' };`));
  assert.equal(sharedTmpLiterals("p.ts", `// once read /tmp/bridlewise/llm-api-config.json\nconst x = 1;`), false);
});

test("no PRODUCT code defaults a path into the shared /tmp: a data folder is an owned folder or a required path (WF1B3AFIX-TMP-DEFAULTS)", () => {
  // The memory backends, the scale and unified stores and the long-task CLI
  // defaulted to fixed `/tmp/bridlewise/...` paths: one file every user and run
  // shared (and the next run of anybody's copy overwrote). The generated
  // architecture manifest is data (it records a benchmark's dependency path).
  const files = [join(ENGINE_ROOT, "src"), join(REPOSITORY_ROOT, "server")]
    .flatMap((root) => walk(root, { exts: [".ts", ".mts", ".mjs", ".js"] }))
    .map((file) => ({ path: relative(REPOSITORY_ROOT, file).split("\\").join("/"), file }))
    .filter(({ path }) => path !== "engine/src/architecture-manifest.ts");
  assert.ok(files.length > 600, `the scan saw ${String(files.length)} product files: it is not seeing them`);
  const found = files.filter(({ path, file }) => sharedTmpLiterals(path, readFileSync(file, "utf8"))).map(({ path }) => path);
  assert.deepEqual(found, [], "default a data path to an owned folder of the system temp root (createOwnedTemporaryDirectory) or require it");
});

test("the guard's shapes catch what they name (planted)", () => {
  const planted = [
    "const dir = mkdtempSync(join(root, 'x-'));",
    "const t = `.${name}.pending-${process.pid}-${hex}.tmp`;",
    "const t = join(dir, `x-${Math.random().toString(36).slice(2)}`);",
  ];
  for (const [index, [what, shape]] of SHAPES.entries()) assert.ok(shape.test(planted[index]!), `${what} was not caught`);
});

test("a sweep never fails its caller: an abandoned temporary it cannot remove is skipped and reported (wf1b2-design T-H1)", () => {
  // A dead owner's folder holding a subtree this user cannot empty (chmod 500):
  // the next creation in the same parent must still succeed.
  const parent = createTempDir("owned-temporary-unremovable-");
  const abandoned = join(parent, "probe-99999999-1-00aa");
  mkdirSync(join(abandoned, "locked"), { recursive: true });
  writeFileSync(join(abandoned, "locked", "file"), "x");
  chmodSync(join(abandoned, "locked"), 0o500);
  try {
    const created = createOwnedTemporaryDirectory(parent, "probe-");
    assert.ok(existsSync(created), "the creation went through");
    assert.ok(existsSync(abandoned), "the unremovable leftover was skipped, not fatal");
    assert.deepEqual(sweepAbandonedTemporaries(parent, "probe-"), [], "and a later sweep skips it again");
  } finally {
    chmodSync(join(abandoned, "locked"), 0o700);
  }
});

test("an owned temporary directory DIES WITH ITS PROCESS: removed at exit when nobody released it; a KILLED owner's is swept by the next creation", () => {
  // The leak source of the `harness-web-guardian-*` directories: a confined
  // spawn plan whose `release` nobody called (a test that returned early, a
  // path that threw before the child's terminal state) outlived its process.
  const parent = createTempDir("owned-temporary-lifetime-");
  const owner = new URL("../../src/filesystem/private-state.ts", import.meta.url).href;
  const child = (ending: string): string[] => {
    const script = `const m = await import(${JSON.stringify(owner)});
      const kept = m.createOwnedTemporaryDirectory(${JSON.stringify(parent)}, "life-");
      const released = m.createOwnedTemporaryDirectory(${JSON.stringify(parent)}, "life-");
      m.removeOwnedTemporaryDirectory(released);
      process.stdout.write(JSON.stringify([kept, released]));
      ${ending}`;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 60_000 });
    assert.ok(run.stdout.length > 0, `the child printed nothing: ${run.stderr}`);
    return JSON.parse(run.stdout) as string[];
  };
  const [exited, releasedEarly] = child("");
  assert.equal(existsSync(releasedEarly!), false, "a released directory is gone");
  assert.equal(existsSync(exited!), false, "a directory nobody released outlived its process");
  const [killed] = child(`process.kill(process.pid, "SIGKILL");`);
  assert.equal(existsSync(killed!), true, "a killed process cannot remove anything: its directory is left for the sweep");
  createOwnedTemporaryDirectory(parent, "life-");
  assert.equal(existsSync(killed!), false, "the next creation under the parent swept the killed owner's directory");
});

test("the end-of-run sweep (no prefix) removes every DEAD owner's owned temporary, of any prefix, and nothing else", () => {
  const parent = createTempDir("owned-temporary-any-prefix-");
  const nonce = "0".repeat(ROOT_POLICY.filesystemInfrastructure.privateState.temporaryRandomBytes * 2);
  const dead = ["harness-web-guardian-99999999-1-" + nonce, "owner-99999999-1-" + nonce];
  const kept = [
    "notes-99999999-1-abc",            // a short suffix is not an owned name
    "plain-folder",
    createOwnedTemporaryDirectory(parent, "live-").slice(parent.length + 1),
  ];
  for (const name of [...dead, ...kept.slice(0, 2)]) mkdirSync(join(parent, name));
  assert.deepEqual([...sweepAbandonedTemporaries(parent)].sort(), [...dead].sort());
  for (const name of dead) assert.equal(existsSync(join(parent, name)), false, `${name} survived`);
  for (const name of kept) assert.equal(existsSync(join(parent, name)), true, `${name} was removed`);
});

test("ONE parse of both owned forms: owner and kind of a sibling, owner of a per-run name, nothing for another name", () => {
  const nonce = "a".repeat(ROOT_POLICY.filesystemInfrastructure.privateState.temporaryRandomBytes * 2);
  assert.deepEqual(ownedTemporaryOwnerOf(`.key.json.write-4242-77-${nonce}.tmp`), { pid: 4242, startTime: 77, kind: "write" });
  assert.deepEqual(ownedTemporaryOwnerOf(`.a.b.c.pending-9-0-${nonce}.tmp`), { pid: 9, startTime: null, kind: "pending" });
  assert.deepEqual(ownedTemporaryOwnerOf(`harness-web-guardian-12-34-${nonce}`), { pid: 12, startTime: 34, kind: null });
  for (const other of ["key.json", ".key.json.write-12-34-abc.tmp", `.key.json.write-12-x-${nonce}.tmp`, "notes-99-1-abc"]) {
    assert.equal(ownedTemporaryOwnerOf(other), undefined, `${other} was read as an owned temporary`);
  }
  const mine = ownedSiblingTemporaryName("x.json", "write");
  assert.equal(isOwnedSiblingTemporary(mine, "write"), true);
  assert.equal(isOwnedSiblingTemporary(mine, "pending"), false);
  assert.equal(isOwnedTemporaryLive(mine), true, "this process's own temporary is live");
});

test("a sibling temporary of a LONG target stays within NAME_MAX, and the write succeeds (wf1b2-design T-L8)", () => {
  const dir = createTempDir("owned-sibling-long-");
  const target = `${"n".repeat(250)}.txt`;
  assert.ok(Buffer.byteLength(ownedSiblingTemporaryName(target, "write")) <= 255);
  assert.equal(atomicWriteFile(join(dir, target), "long").success, true);
  assert.equal(readFileSync(join(dir, target), "utf8"), "long");
});

test("the first write into a directory removes what DEAD writers OF ITS KIND left beside their targets, never a live writer's and never another owner's kind (wf1b2-design T-M1; WF-1b3b design LOW 5)", () => {
  const dir = createTempDir("owned-sibling-sweep-");
  const nonce = "0".repeat(ROOT_POLICY.filesystemInfrastructure.privateState.temporaryRandomBytes * 2);
  const deadWrite = `.key.json.write-99999999-1-${nonce}.tmp`;
  const deadPending = `.receipt.json.pending-99999999-1-${nonce}.tmp`;
  const live = ownedSiblingTemporaryName("other.json", "write");
  const unrelated = ".config.json.swp";
  for (const name of [deadWrite, deadPending, live, unrelated]) writeFileSync(join(dir, name), "left");
  assert.deepEqual([...abandonedSiblingTemporaries(dir)].sort(), [deadWrite, deadPending].sort());
  assert.deepEqual(abandonedSiblingTemporaries(dir, "write"), [deadWrite]);
  assert.equal(atomicWriteFile(join(dir, "key.json"), "fresh").success, true);
  assert.equal(existsSync(join(dir, deadWrite)), false, "a dead atomic writer's temporary survived the first write");
  // The receipts' own `pending` evidence is their owner's to judge (orphan-publication-temporary).
  for (const name of [deadPending, live, unrelated, "key.json"]) assert.equal(existsSync(join(dir, name)), true, `${name} was removed`);
});
