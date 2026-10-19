/**
 * ONE EXCLUSIVE WRITER FOR A RECORD WHOSE PRESENCE IS THE FACT
 * (`src/filesystem/atomic-write.ts`, `exclusive` + `durable`): the content is
 * complete and fsynced in a private owned temporary, `link(2)` names it only
 * if the name is free, and the FOLDER is fsynced after — so a power cut can
 * lose neither the bytes nor the name (wf1b2-design T-H2: the persisted key's
 * hand-written publication skipped the folder fsync, and the config write
 * lock and the test-run lock each carried their own stage-and-link copy).
 *
 *   - the guard: no `link(2)` publication (`linkSync`) and no `"wx"` create
 *     outside the owner and the DECLARED descriptor-pinned protocols (each
 *     with its reason: they hold the descriptor they checked, which the
 *     generic writer does not do);
 *   - the behaviour: each of the three former copies publishes through the
 *     owner — the folder is fsynced once its record is named.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { walk } from "../../scripts/verification/source-walk.ts";
import { createTempDir } from "../support/temp-dir.ts";

const ENGINE_ROOT = join(import.meta.dirname, "..", "..");
const REPOSITORY_ROOT = join(ENGINE_ROOT, "..");
const OWNER = "engine/src/filesystem/atomic-write.ts";

/** Exclusive creators that keep their own descriptor-pinned protocol, each with its reason. */
const DECLARED: Readonly<Record<string, string>> = {
  "engine/src/filesystem/immutable-receipt.ts": "writes through the descriptor it verified (O_NOFOLLOW, pinned chain) before linking",
  "engine/src/filesystem/durable-filesystem-internal.ts": "publishes relative to the pinned folder DESCRIPTOR it verified (and fsyncs that descriptor), which a path-based writer cannot do",
};

const SHAPES: ReadonlyArray<readonly [string, RegExp]> = [
  ["a link(2) publication", /(?<![A-Za-z])linkSync\(/u],
  ["a \"wx\" exclusive create", /["']wx["']/u],
];

test("no hand-written exclusive publication outside the one writer and the declared protocols", () => {
  const roots = [join(ENGINE_ROOT, "src"), join(ENGINE_ROOT, "scripts"), join(REPOSITORY_ROOT, "server")];
  const offenders = roots.flatMap((root) => walk(root, { exts: [".ts", ".mts", ".mjs"] }))
    .map((file) => ({ path: relative(REPOSITORY_ROOT, file).split("\\").join("/"), text: readFileSync(file, "utf8") }))
    .filter((file) => !/^engine\/scripts\/exp/u.test(file.path) && file.path !== OWNER && DECLARED[file.path] === undefined)
    .flatMap((file) => SHAPES.filter(([, shape]) => shape.test(file.text)).map(([what]) => `${file.path}: ${what}`));
  assert.deepEqual(offenders, []);
  // The guard sees the shapes (planted).
  for (const [what, shape] of SHAPES) {
    assert.ok(shape.test(what === "a link(2) publication" ? "linkSync(stage, target)" : "openSync(p, \"wx\")"), what);
  }
  assert.equal(SHAPES[0]![1].test("unlinkSync(p)"), false, "unlink is not a publication");
});

test("the three former copies publish through the owner: the folder is fsynced once the record is named", () => {
  const root = createTempDir("exclusive-create-owner-");
  const keyHome = join(root, "keys");
  mkdirSync(keyHome, { mode: 0o700 });
  const cases = [
    {
      what: "the persisted key",
      folder: keyHome,
      body: `const {resolvePersistedKey}=await import(${JSON.stringify(join(ENGINE_ROOT, "src/filesystem/persisted-key.ts"))});const {admitKeyHome}=await import(${JSON.stringify(join(ENGINE_ROOT, "src/filesystem/self-protection/key-home.ts"))});resolvePersistedKey({dbPath:${JSON.stringify(join(root, "db", "web.db"))},keyHome:admitKeyHome(${JSON.stringify(keyHome)},[]),disposition:"create-or-load"});`,
    },
    {
      what: "the config write lock",
      folder: join(root, "config", ".bridlewise"),
      body: `const {withConfigWriteLock}=await import(${JSON.stringify(join(ENGINE_ROOT, "src/kernel/config-write-lock.ts"))});withConfigWriteLock(${JSON.stringify(join(root, "config", "harness.json"))},()=>0);`,
    },
    {
      what: "the test-run lock",
      folder: join(root, "locks"),
      body: `const {enforceTestRunLock}=await import(${JSON.stringify(join(ENGINE_ROOT, "scripts/tooling/test-run-lock.ts"))});const lock=await enforceTestRunLock("probe",{lockDir:${JSON.stringify(join(root, "locks"))},testFileCount:Number.POSITIVE_INFINITY});lock.release();`,
    },
  ];
  mkdirSync(join(root, "config"));
  for (const { what, folder, body } of cases) {
    const script = `import fs from "node:fs";import {syncBuiltinESMExports} from "node:module";
      const folder=${JSON.stringify(folder)};const opens=new Map(),open=fs.openSync,sync=fs.fsyncSync;let folderSyncs=0;
      fs.openSync=(p,...a)=>{const fd=open(p,...a);opens.set(fd,String(p));return fd;};
      fs.fsyncSync=(fd)=>{if(opens.get(fd)===folder)folderSyncs++;return sync(fd);};syncBuiltinESMExports();
      ${body}console.log(JSON.stringify({folderSyncs}));`;
    const child = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, HARNESS_KEY_HOME: keyHome } });
    assert.equal(child.status, 0, `${what}: ${child.stderr}`);
    const { folderSyncs } = JSON.parse(child.stdout.trim().split("\n").at(-1)!) as { folderSyncs: number };
    assert.ok(folderSyncs >= 1, `${what}: its folder was fsynced after the record was named (${folderSyncs})`);
  }
});
