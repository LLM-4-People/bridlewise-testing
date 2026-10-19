import { lstatSync, mkdirSync, type BigIntStats } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";

import { InputError, SecurityError } from "../../src/kernel/errors.ts";
import { deepFreeze } from "../../src/kernel/integrity.ts";

/** Byte-exact legacy v1 storage contract retained for migration tests only. */
export const LEGACY_STATE_INVARIANTS = deepFreeze({
  directoryMode: 0o700,
  databaseMode: 0o600,
});

const STATE_LOCATION_BRAND: unique symbol = Symbol("test-only-state-location");

export type StateLocation = Readonly<{
  [STATE_LOCATION_BRAND]: true;
  databasePath: string;
  stateDirectory: string;
}>;

type PathIdentity = Readonly<{
  path: string;
  dev: bigint;
  ino: bigint;
  mode: bigint;
  uid: bigint;
}>;

export type StateBoundarySnapshot = Readonly<{
  directories: readonly PathIdentity[];
  database?: PathIdentity;
}>;

export function stateLocationFromPath(candidate: string): StateLocation {
  if (candidate.trim() === "" || candidate.includes("\0") || !isAbsolute(candidate)) {
    throw new InputError("Database path must be an absolute Linux path");
  }
  const databasePath = resolve(candidate);
  if (databasePath === "/mnt" || databasePath.startsWith("/mnt/")) {
    throw new SecurityError("Windows-mounted database paths are not allowed");
  }
  const stateDirectory = dirname(databasePath);
  inspectExistingComponents(stateDirectory);
  validateStateDirectory(stateDirectory);
  validateDatabaseFile(databasePath);
  return deepFreeze({ [STATE_LOCATION_BRAND]: true as const, databasePath, stateDirectory });
}

export function prepareState(location: StateLocation): StateBoundarySnapshot {
  assertStateLocation(location);
  inspectExistingComponents(location.stateDirectory);
  validateStateDirectory(location.stateDirectory);
  validateDatabaseFile(location.databasePath);
  mkdirSync(location.stateDirectory, {
    recursive: true,
    mode: LEGACY_STATE_INVARIANTS.directoryMode,
  });
  return captureStateBoundary(location);
}

export function revalidateStateBoundary(
  location: StateLocation,
  expected: StateBoundarySnapshot,
  allowDatabaseCreation = false,
): StateBoundarySnapshot {
  assertStateLocation(location);
  const actual = captureStateBoundary(location);
  if (!sameIdentities(actual.directories, expected.directories)) {
    throw new SecurityError("State directory path changed during database open");
  }
  if (expected.database) {
    if (!actual.database || !sameIdentity(actual.database, expected.database)) {
      throw new SecurityError("Database path changed during database open");
    }
  } else if (!allowDatabaseCreation || !actual.database) {
    throw new SecurityError("Database path changed during database creation");
  }
  return actual;
}

function inspectExistingComponents(path: string): void {
  const paths = directoryPaths(path);
  for (const [index, current] of paths.entries()) {
    const stats = lstatOptional(current);
    if (!stats) return;
    if (stats.isSymbolicLink()) throw new SecurityError("Symlinked state paths are not allowed");
    if (!stats.isDirectory()) throw new SecurityError("State path is not a directory");
    if (index < paths.length - 1) validateAncestor(stats);
  }
}

function validateStateDirectory(path: string): void {
  const stats = lstatOptional(path);
  if (!stats) return;
  if (!stats.isDirectory()) throw new SecurityError("State path is not a directory");
  validateOwnerAndMode(stats, LEGACY_STATE_INVARIANTS.directoryMode, "state directory");
}

function validateDatabaseFile(path: string): void {
  const stats = lstatOptional(path);
  if (!stats) return;
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new SecurityError("Database path is not a regular file");
  }
  validateOwnerAndMode(stats, LEGACY_STATE_INVARIANTS.databaseMode, "database file");
}

function validateOwnerAndMode(stats: BigIntStats, mode: number, label: string): void {
  const uid = process.getuid?.();
  if (uid === undefined || stats.uid !== BigInt(uid)) {
    throw new SecurityError(`Foreign-owned ${label} is not allowed`);
  }
  if ((stats.mode & 0o777n) !== BigInt(mode)) throw new SecurityError(`Insecure ${label} mode`);
}

function captureStateBoundary(location: StateLocation): StateBoundarySnapshot {
  assertStateLocation(location);
  const paths = directoryPaths(location.stateDirectory);
  const directories = paths.map((path, index) => {
    const stats = lstatOptional(path);
    if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new SecurityError("State directory path changed during database open");
    }
    if (index < paths.length - 1) validateAncestor(stats);
    else validateOwnerAndMode(stats, LEGACY_STATE_INVARIANTS.directoryMode, "state directory");
    return identity(path, stats);
  });
  const databaseStats = lstatOptional(location.databasePath);
  if (!databaseStats) return { directories };
  if (databaseStats.isSymbolicLink() || !databaseStats.isFile()) {
    throw new SecurityError("Database path is not a regular file");
  }
  validateOwnerAndMode(databaseStats, LEGACY_STATE_INVARIANTS.databaseMode, "database file");
  return { directories, database: identity(location.databasePath, databaseStats) };
}

function assertStateLocation(location: StateLocation): void {
  if (location[STATE_LOCATION_BRAND] !== true || dirname(location.databasePath) !== location.stateDirectory) {
    throw new SecurityError("Invalid test-only state location binding");
  }
}

function directoryPaths(path: string): readonly string[] {
  const root = parse(path).root;
  const paths = [root];
  let current = root;
  for (const part of path.slice(root.length).split("/").filter(Boolean)) {
    current = join(current, part);
    paths.push(current);
  }
  return paths;
}

function lstatOptional(path: string): BigIntStats | undefined {
  return lstatSync(path, { bigint: true, throwIfNoEntry: false });
}

function validateAncestor(stats: BigIntStats): void {
  if ((stats.mode & 0o002n) !== 0n && (stats.uid !== 0n || (stats.mode & 0o1000n) === 0n)) {
    throw new SecurityError("World-writable non-sticky state ancestors are not allowed");
  }
}

function identity(path: string, stats: BigIntStats): PathIdentity {
  return { path, dev: stats.dev, ino: stats.ino, mode: stats.mode, uid: stats.uid };
}

function sameIdentities(actual: readonly PathIdentity[], expected: readonly PathIdentity[]): boolean {
  return actual.length === expected.length &&
    actual.every((current, index) => sameIdentity(current, expected[index]!));
}

function sameIdentity(actual: PathIdentity, expected: PathIdentity): boolean {
  return actual.path === expected.path && actual.dev === expected.dev && actual.ino === expected.ino &&
    actual.mode === expected.mode && actual.uid === expected.uid;
}
