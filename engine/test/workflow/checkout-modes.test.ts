import assert from "node:assert/strict";
import { chmodSync, linkSync, lstatSync, readFileSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { armCheckoutUnderTest, assertCheckoutWriteAllowed, CHECKOUT_WRITE_REFUSAL_CODE } from "../../src/filesystem/checkout-write-door.ts";
import { relativeKeySuffix } from "../../src/filesystem/path-boundary.ts";
import { indexFilePath } from "../../src/git/repository-ownership.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { settleCheckout } from "../../src/workflow/checkout-setup.ts";
import { initTempRepo, mkWorkspaceTempDir, rawGit, writeFile } from "../workspaces/workspace-test-support.ts";

const ENGINE = "engine";
const CONFIG = `${ENGINE}/${ROOT_POLICY.configuration.basename}`;
const SOURCE = `${ENGINE}/src/sample.ts`;
const FILES = [
  [SOURCE, ROOT_POLICY.filesystem.rawFileModes.source],
  [`${ENGINE}/test/sample.test.ts`, ROOT_POLICY.filesystem.rawFileModes.test],
  [`${ENGINE}/traceability/sample.md`, ROOT_POLICY.filesystem.rawFileModes.traceability],
  [`${ENGINE}/traceability/sample.receipt.json`, ROOT_POLICY.filesystem.rawFileModes.evidence],
  [CONFIG, Number.parseInt(ROOT_POLICY.configuration.requiredConfigFileMode, 8)],
] as const;
const EXECUTABLE = "run.sh";

test("repository key relations compare whole components and refuse malformed operands", () => {
  for (const [key, ancestor, expected] of [
    ["engine/src/a.ts", "engine", "src/a.ts"],
    ["engine/src", "engine/src", ""],
    ["engine-other/a.ts", "engine", null],
    ["engine", "engine/src", null],
    ["Engine/a.ts", "engine", null],
    ["engine/é.ts", "engine", "é.ts"],
    ["engine/a.ts", "", "engine/a.ts"],
    ["engine/a.ts", ".", "engine/a.ts"],
    [".", "", ""],
    ["", "engine", null],
  ] as const) assert.equal(relativeKeySuffix(key, ancestor), expected);
  for (const malformed of ["/engine", "engine/", "engine//src", "engine/./src", "engine/../src", "engine\\src", "engine\0src"]) {
    for (const [key, ancestor] of [[malformed, "engine"], ["engine/src", malformed]]) {
      assert.throws(() => relativeKeySuffix(key!, ancestor!),
        (error: unknown) => (error as { code?: string }).code === "repository_key_invalid");
    }
  }
});

/** Real Git creates every tested worktree; all writes stay in owned fixture roots. */
function checkout(mask: number): string {
  const { root } = initTempRepo("checkout-modes");
  for (const [path] of FILES) writeFile(root, path, path === CONFIG ? "{}\n" : "fixture\n");
  writeFile(root, EXECUTABLE, "#!/bin/sh\nexit 0\n");
  chmodSync(join(root, EXECUTABLE), 0o755);
  rawGit(root, ["add", "--", ...FILES.map(([path]) => path), EXECUTABLE]);
  rawGit(root, ["commit", "-m", "Declare checkout mode fixture"]);
  const target = mkWorkspaceTempDir("checkout-modes-target");
  const previous = process.umask(mask);
  try {
    rawGit(root, ["worktree", "add", "--quiet", "--detach", target, "HEAD"]);
  } finally {
    process.umask(previous);
  }
  return target;
}

for (const [label, mask] of [["002", 0o002], ["027", 0o027], ["077", 0o077]] as const) {
  test(`checkout settles tracked file modes from policy after Git creates them under umask ${label}`, () => {
    const root = checkout(mask);
    const before = new Map(FILES.map(([path]) => [path, {
      bytes: readFileSync(join(root, path)), identity: statSync(join(root, path), { bigint: true }),
    }]));
    const index = indexFilePath(root, "directory");
    const indexBytes = readFileSync(index);
    const creatorMask = process.umask();
    const steps = settleCheckout(root, ENGINE);
    for (const [path, mode] of FILES) {
      const after = statSync(join(root, path), { bigint: true });
      assert.equal(Number(after.mode & 0o7777n), mode, path);
      assert.equal(after.ino, before.get(path)!.identity.ino, `${path}: settling must keep the inode`);
      assert.deepEqual(readFileSync(join(root, path)), before.get(path)!.bytes, `${path}: bytes changed`);
    }
    assert.equal(statSync(join(root, EXECUTABLE)).mode & 0o7777, 0o755, "Git's executable mode survives a private creator umask");
    assert.deepEqual(readFileSync(index), indexBytes, "settling modes must not edit the index");
    assert.ok(steps.some(step => step.step === "config-mode" && step.status === "pass"));
    assert.equal(process.umask(), creatorMask, "settling must not change the caller's process-wide umask");
  });
}

test("checkout settling leaves untracked and ignored private files private", () => {
  const root = checkout(0o077);
  const privateFiles = ["operator-secret.txt", ".bridlewise/private.txt", "node_modules/private.txt"];
  for (const path of privateFiles) {
    writeFile(root, path, "private fixture, no credential\n");
    chmodSync(join(root, path), 0o600);
  }
  const before = privateFiles.map(path => statSync(join(root, path), { bigint: true }));
  settleCheckout(root, ENGINE);
  privateFiles.forEach((path, index) => {
    const after = statSync(join(root, path), { bigint: true });
    assert.equal(Number(after.mode & 0o7777n), 0o600, path);
    assert.equal(after.ctimeNs, before[index]!.ctimeNs, `${path}: private file was touched`);
  });
});

test("a second checkout settle changes no tracked inode, ctime or bytes", () => {
  const root = checkout(0o077);
  settleCheckout(root, ENGINE);
  const before = FILES.map(([path]) => ({ stat: statSync(join(root, path), { bigint: true }), bytes: readFileSync(join(root, path)) }));
  settleCheckout(root, ENGINE);
  FILES.forEach(([path], index) => {
    const after = statSync(join(root, path), { bigint: true });
    assert.equal(after.ino, before[index]!.stat.ino, path);
    assert.equal(after.ctimeNs, before[index]!.stat.ctimeNs, `${path}: same-mode chmod moved ctime`);
    assert.deepEqual(readFileSync(join(root, path)), before[index]!.bytes, path);
  });
});

test("contained checkout mode changes obey the armed checkout write door before changing a descriptor", () => {
  const root = checkout(0o077);
  const protectedPaths = [...FILES.map(([path]) => path), EXECUTABLE];
  const before = protectedPaths.map(path => ({
    stat: statSync(join(root, path), { bigint: true }), bytes: readFileSync(join(root, path)),
  }));
  const index = indexFilePath(root, "directory");
  const indexBytes = readFileSync(index);
  assert.equal(statSync(join(root, SOURCE)).mode & 0o7777, 0o600, "the fixture needs a source-mode change");
  armCheckoutUnderTest(root);
  const refusesCheckoutWrite = (error: unknown): boolean =>
    (error as { code?: string }).code === CHECKOUT_WRITE_REFUSAL_CODE;
  assert.throws(() => assertCheckoutWriteAllowed(join(root, SOURCE)), refusesCheckoutWrite,
    "positive control: the ordinary pathname is protected by the same armed door");
  assert.throws(() => settleCheckout(root, ENGINE), refusesCheckoutWrite,
    "the contained descriptor must authorize its held file, not the procfs link name");
  protectedPaths.forEach((path, position) => {
    const after = statSync(join(root, path), { bigint: true });
    assert.equal(after.mode, before[position]!.stat.mode, `${path}: permissions changed`);
    assert.equal(after.ino, before[position]!.stat.ino, `${path}: inode changed`);
    assert.equal(after.ctimeNs, before[position]!.stat.ctimeNs, `${path}: ctime changed`);
    assert.deepEqual(readFileSync(join(root, path)), before[position]!.bytes, `${path}: bytes changed`);
  });
  assert.deepEqual(readFileSync(index), indexBytes, "the protected index must remain exact");
});

test("a deleted tracked file remains deleted and its protected index entry is untouched", () => {
  const root = checkout(0o077);
  const index = indexFilePath(root, "directory");
  const before = readFileSync(index);
  unlinkSync(join(root, SOURCE));
  settleCheckout(root, ENGINE);
  assert.equal(lstatSync(join(root, SOURCE), { throwIfNoEntry: false }), undefined);
  assert.deepEqual(readFileSync(index), before);
});

for (const shape of ["file-link", "parent-link", "hard-link"] as const) {
  test(`checkout mode settling refuses a tracked regular file replaced with a ${shape}`, () => {
    const root = checkout(0o077);
    const outside = mkWorkspaceTempDir("checkout-mode-outside");
    const external = join(outside, "sample.ts");
    writeFileSync(external, "outside fixture\n", { mode: 0o600 });
    chmodSync(external, 0o600);
    if (shape === "parent-link") {
      renameSync(join(root, ENGINE, "src"), join(root, ENGINE, "saved-src"));
      symlinkSync(outside, join(root, ENGINE, "src"));
    } else {
      unlinkSync(join(root, SOURCE));
      if (shape === "file-link") symlinkSync(external, join(root, SOURCE));
      else linkSync(external, join(root, SOURCE));
    }
    const before = statSync(external, { bigint: true });
    const code = shape === "file-link" ? "ELOOP" : shape === "parent-link" ? "path_through_link" : "file_mode_unsafe_file";
    assert.throws(() => settleCheckout(root, ENGINE), (error: unknown) => (error as { code?: string }).code === code);
    const after = statSync(external, { bigint: true });
    assert.equal(after.mode, before.mode, "outside/private file permissions widened");
    assert.equal(after.ctimeNs, before.ctimeNs, "outside/private file was touched");
    assert.equal(readFileSync(external, "utf8"), "outside fixture\n");
  });
}

test("checkout settling ignores inherited Git index redirection", () => {
  const root = checkout(0o077);
  const { root: other } = initTempRepo("checkout-foreign-index");
  writeFile(other, SOURCE, "private untracked fixture\n");
  chmodSync(join(other, SOURCE), 0o600);
  const foreignIndex = indexFilePath(other, "directory");
  const foreignBytes = readFileSync(foreignIndex);
  const previous = process.env.GIT_INDEX_FILE;
  try {
    process.env.GIT_INDEX_FILE = foreignIndex;
    settleCheckout(root, ENGINE);
  } finally {
    if (previous === undefined) delete process.env.GIT_INDEX_FILE;
    else process.env.GIT_INDEX_FILE = previous;
  }
  assert.equal(statSync(join(root, SOURCE)).mode & 0o7777, ROOT_POLICY.filesystem.rawFileModes.source);
  assert.equal(statSync(join(other, SOURCE)).mode & 0o7777, 0o600, "the foreign checkout was touched");
  assert.deepEqual(readFileSync(foreignIndex), foreignBytes);
});

test("a declared Git checkout with unreadable ownership metadata refuses instead of reporting a config-only settle", () => {
  const root = checkout(0o077);
  const metadata = join(root, ".git");
  const gitFile = readFileSync(metadata);
  const index = indexFilePath(root, "directory");
  const indexBytes = readFileSync(index);
  try {
    // Corrupt only the real fixture's Git pointer, never the source checkout.
    writeFileSync(metadata, "invalid fixture Git pointer\n");
    assert.throws(() => settleCheckout(root, ENGINE), (error: unknown) =>
      (error as { code?: string }).code === "checkout_mode_repository_unavailable");
    assert.equal(statSync(join(root, SOURCE)).mode & 0o7777, 0o600);
    assert.deepEqual(readFileSync(index), indexBytes);
  } finally {
    writeFileSync(metadata, gitFile);
  }
});

test("a non-Git staging home retains its private config contract without adopting its untracked source", () => {
  const root = mkWorkspaceTempDir("checkout-mode-staging");
  writeFile(root, CONFIG, "{}\n");
  chmodSync(join(root, CONFIG), 0o644);
  writeFile(root, SOURCE, "private staging fixture\n");
  chmodSync(join(root, SOURCE), 0o600);
  const steps = settleCheckout(root, ENGINE);
  assert.equal(statSync(join(root, CONFIG)).mode & 0o7777, Number.parseInt(ROOT_POLICY.configuration.requiredConfigFileMode, 8));
  assert.equal(statSync(join(root, SOURCE)).mode & 0o7777, 0o600);
  assert.deepEqual(steps.map(step => step.step), ["config-mode"]);
});
