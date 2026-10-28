/**
 * THE ONE MODE OWNER (src/filesystem/file-mode.ts): a file already at the
 * required mode is left untouched — no fchmod, so its ctime does not move —
 * and a file at another mode is settled. #293: an unconditional same-mode
 * chmod of the live configuration moved its ctime mid-run, and a concurrent
 * configuration bootstrap refused an unrelated commit.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, constants, openSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { CHECKOUT_WRITE_REFUSAL_CODE } from "../../src/filesystem/checkout-write-door.ts";
import { settleDescriptorMode, settleFileMode } from "../../src/filesystem/file-mode.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { createTempDir } from "../support/temp-dir.ts";

const OWNER = pathToFileURL(new URL("../../src/filesystem/file-mode.ts", import.meta.url).pathname).href;
const LIVE_CONFIG = new URL(`../../${ROOT_POLICY.configuration.basename}`, import.meta.url).pathname;
const REQUIRED = Number.parseInt(ROOT_POLICY.configuration.requiredConfigFileMode, 8);

/** The owner run in a child whose `fs.fchmodSync` is counted: how many mode changes reached the kernel. */
function fchmodCalls(path: string, mode: number): Readonly<{ changed: boolean; calls: number }> {
  const script = `import fs from "node:fs";import {syncBuiltinESMExports} from "node:module";
    let calls=0;const real=fs.fchmodSync;fs.fchmodSync=(...a)=>{calls++;return real(...a);};syncBuiltinESMExports();
    const {settleFileMode}=await import(${JSON.stringify(OWNER)});
    const changed=settleFileMode(${JSON.stringify(path)},${mode});console.log(JSON.stringify({changed,calls}));`;
  const child = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout.trim().split("\n").at(-1)!) as { changed: boolean; calls: number };
}

test("a file already at the required mode is left untouched: no fchmod reaches the kernel and its ctime does not move", () => {
  const file = join(createTempDir("file-mode-"), "settled.json");
  writeFileSync(file, "{}\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  const before = statSync(file, { bigint: true });
  assert.deepEqual(fchmodCalls(file, 0o600), { changed: false, calls: 0 });
  assert.equal(settleFileMode(file, 0o600), false);
  const after = statSync(file, { bigint: true });
  assert.equal(after.ctimeNs, before.ctimeNs, "a settle of an already-settled file moved its ctime");
  assert.equal(Number(after.mode & 0o7777n), 0o600);
});

test("a file at another mode is settled to the required one, with one fchmod", () => {
  const file = join(createTempDir("file-mode-"), "loose.json");
  writeFileSync(file, "{}\n");
  chmodSync(file, 0o644);
  assert.deepEqual(fchmodCalls(file, 0o600), { changed: true, calls: 1 });
  assert.equal(Number(statSync(file).mode & 0o7777), 0o600);
  chmodSync(file, 0o664);
  assert.equal(settleFileMode(file, 0o600), true);
  assert.equal(Number(statSync(file).mode & 0o7777), 0o600);
});

test("the descriptor form compares before it changes (the trusted bootstrap's own verified descriptor)", () => {
  const file = join(createTempDir("file-mode-"), "held.json");
  writeFileSync(file, "{}\n");
  chmodSync(file, 0o644);
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    assert.equal(settleDescriptorMode(descriptor, 0o600), true);
    const settled = statSync(file, { bigint: true });
    assert.equal(settleDescriptorMode(descriptor, 0o600), false);
    assert.equal(statSync(file, { bigint: true }).ctimeNs, settled.ctimeNs);
  } finally {
    closeSync(descriptor);
  }
});

test("a link planted at the path is refused by the open, never followed to its target", () => {
  const folder = createTempDir("file-mode-");
  const target = join(folder, "target.json");
  writeFileSync(target, "{}\n");
  chmodSync(target, 0o644);
  symlinkSync(target, join(folder, "link.json"));
  assert.throws(() => settleFileMode(join(folder, "link.json"), 0o600), (error: unknown) => (error as NodeJS.ErrnoException).code === "ELOOP");
  assert.equal(Number(statSync(target).mode & 0o7777), 0o644);
});

test("settling the LIVE configuration's mode from a test changes nothing about it (#293)", () => {
  // The live document is at its required mode (the checkout setup and CI set it before any run): the owner's
  // answer is "already", and the identity every configuration bootstrap compares is exactly what it was.
  const before = statSync(LIVE_CONFIG, { bigint: true });
  assert.equal(Number(before.mode & 0o7777n), REQUIRED, "the live configuration is not at its required mode; run the checkout setup");
  assert.deepEqual(fchmodCalls(LIVE_CONFIG, REQUIRED), { changed: false, calls: 0 });
  assert.equal(statSync(LIVE_CONFIG, { bigint: true }).ctimeNs, before.ctimeNs);
});

test("the #293 shape: a mode change reaching the LIVE configuration through a linked engine folder is refused by the checkout write door", () => {
  // A fixture home whose `engine` is a link to the live engine (promoter-home's N3/T-K5 before #506): settling the
  // config "in the home" lands on the live document. The mode differs from the live one, so a change is needed and
  // the door must refuse it, before any fchmod, and leave the live document exactly as it was.
  const home = createTempDir("file-mode-home-");
  symlinkSync(new URL("../..", import.meta.url).pathname, join(home, "engine"));
  const throughLink = join(home, "engine", ROOT_POLICY.configuration.basename);
  const before = statSync(LIVE_CONFIG, { bigint: true });
  const other = REQUIRED === 0o600 ? 0o640 : 0o600;
  try {
    assert.throws(() => settleFileMode(throughLink, other), (error: unknown) =>
      (error as { code?: string }).code === CHECKOUT_WRITE_REFUSAL_CODE, "the door did not refuse a mode change into the live checkout");
  } finally {
    // Only a regression gets here with the live document changed: put its mode back at once, then fail below.
    if (Number(statSync(LIVE_CONFIG).mode & 0o7777) !== REQUIRED) chmodSync(LIVE_CONFIG, REQUIRED);
  }
  const after = statSync(LIVE_CONFIG, { bigint: true });
  assert.equal(after.ctimeNs, before.ctimeNs, "the live configuration's ctime moved");
  assert.equal(Number(after.mode & 0o7777n), REQUIRED);
});
