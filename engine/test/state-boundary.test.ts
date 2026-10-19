import assert from "node:assert/strict";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, renameSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { InputError, SecurityError } from "../src/kernel/errors.ts";
import {
  prepareState,
  revalidateStateBoundary,
  stateLocationFromPath,
  type StateLocation,
} from "./support/legacy-state-boundary.ts";
import { Store } from "./support/legacy-store.ts";
import { createTempDir } from "./support/temp-dir.ts";

function temporaryDirectory(): string {
  return createTempDir("bridlewise-state-");
}

test("legacy state location rejects empty, relative, mounted, and symlink paths", () => {
  assert.throws(() => stateLocationFromPath(""), InputError);
  assert.throws(() => stateLocationFromPath("relative.sqlite"), InputError);
  assert.throws(() => stateLocationFromPath("/mnt/c/harness.sqlite"), SecurityError);

  const root = temporaryDirectory();
  const real = join(root, "real");
  const linked = join(root, "linked");
  mkdirSync(real, { mode: 0o700 });
  symlinkSync(real, linked);
  assert.throws(() => stateLocationFromPath(join(linked, "harness.sqlite")), SecurityError);

  const target = join(root, "target.sqlite");
  closeSync(openSync(target, "wx", 0o600));
  const databaseLink = join(root, "database.sqlite");
  symlinkSync(target, databaseLink);
  assert.throws(() => stateLocationFromPath(databaseLink), SecurityError);

  const legitimate = stateLocationFromPath(join(real, "legitimate.sqlite"));
  const forgedDirectory = { ...legitimate, stateDirectory: root } as StateLocation;
  assert.throws(() => prepareState(forgedDirectory), SecurityError);
  const structurallyForged = {
    databasePath: join(real, "structural.sqlite"),
    stateDirectory: real,
  } as unknown as StateLocation;
  assert.throws(() => prepareState(structurallyForged), SecurityError);
});

test("legacy state boundary rejects insecure mode, ownership, and ancestors", { concurrency: false }, () => {
  const root = temporaryDirectory();
  chmodSync(root, 0o755);
  assert.throws(() => stateLocationFromPath(join(root, "harness.sqlite")), SecurityError);
  chmodSync(root, 0o700);

  const databasePath = join(root, "harness.sqlite");
  closeSync(openSync(databasePath, "wx", 0o600));
  chmodSync(databasePath, 0o644);
  assert.throws(() => stateLocationFromPath(databasePath), SecurityError);
  chmodSync(databasePath, 0o600);

  const original = process.getuid!;
  Object.defineProperty(process, "getuid", { configurable: true, value: () => original() + 1 });
  try {
    assert.throws(() => stateLocationFromPath(databasePath), SecurityError);
  } finally {
    Object.defineProperty(process, "getuid", { configurable: true, value: original });
  }

  const writable = join(root, "writable");
  mkdirSync(writable, { mode: 0o700 });
  chmodSync(writable, 0o777);
  assert.throws(() => stateLocationFromPath(join(writable, "state", "harness.sqlite")), SecurityError);
});

test("legacy Store creates private state and database files", () => {
  const root = temporaryDirectory();
  const stateDirectory = join(root, "nested", "state");
  const databasePath = join(stateDirectory, "harness.sqlite");
  const store = new Store(stateLocationFromPath(databasePath));
  store.close();
  assert.equal(lstatSync(stateDirectory).mode & 0o777, 0o700);
  assert.equal(lstatSync(databasePath).mode & 0o777, 0o600);
});

test("legacy state snapshots retain bigint identity and detect substitutions", () => {
  const root = temporaryDirectory();
  const stateDirectory = join(root, "state");
  const databasePath = join(stateDirectory, "harness.sqlite");
  const location = stateLocationFromPath(databasePath);
  const prepared = prepareState(location);
  const identity = prepared.directories.at(-1)!;
  assert.equal(typeof identity.dev, "bigint");
  assert.equal(typeof identity.ino, "bigint");

  closeSync(openSync(databasePath, "wx", 0o600));
  const created = revalidateStateBoundary(location, prepared, true);
  const originalDatabase = join(stateDirectory, "original.sqlite");
  renameSync(databasePath, originalDatabase);
  closeSync(openSync(databasePath, "wx", 0o600));
  assert.throws(() => revalidateStateBoundary(location, created), SecurityError);

  const originalState = join(root, "original-state");
  renameSync(stateDirectory, originalState);
  mkdirSync(stateDirectory, { mode: 0o700 });
  closeSync(openSync(databasePath, "wx", 0o600));
  assert.throws(() => revalidateStateBoundary(location, created), SecurityError);
});
