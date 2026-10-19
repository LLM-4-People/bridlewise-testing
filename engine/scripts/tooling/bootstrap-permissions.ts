import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { canonicalJson, sha256 } from "../../src/kernel/integrity.ts";
import { SecurityError } from "../../src/kernel/errors.ts";
import { hasSecondName } from "../../src/filesystem/link-containment.ts";
import { readLinuxMountPoints } from "../../src/filesystem/linux-path.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";

type BootstrapErrorCode =
  | "bootstrap_arguments_invalid"
  | "bootstrap_config_cross_device_denied"
  | "bootstrap_config_hardlink_denied"
  | "bootstrap_config_invalid"
  | "bootstrap_config_too_large"
  | "bootstrap_identity_changed"
  | "bootstrap_io_denied"
  | "bootstrap_mountpoint_denied"
  | "bootstrap_owner_mismatch"
  | "bootstrap_platform_unsupported"
  | "bootstrap_root_invalid";

class BootstrapDenied extends SecurityError {
  readonly code: BootstrapErrorCode;

  constructor(code: BootstrapErrorCode) {
    super(code, code);
    this.code = code;
  }
}

const AUDIT_ACTION = "bootstrap-config-permissions";
const REQUIRED_MODE = Number.parseInt(ROOT_POLICY.configuration.requiredConfigFileMode, 8);

function runBootstrap(argv: readonly string[]): number {
  try {
    if (argv.length !== 0) throw new BootstrapDenied("bootstrap_arguments_invalid");
    repairPinnedConfigPermissions();
    process.stdout.write(`${canonicalJson({
      action: AUDIT_ACTION,
      requiredMode: ROOT_POLICY.configuration.requiredConfigFileMode,
      result: "verified",
      schemaVersion: 1,
    })}\n`);
    return 0;
  } catch (error) {
    const code = error instanceof BootstrapDenied ? error.code : "bootstrap_io_denied";
    process.stderr.write(`${canonicalJson({
      action: AUDIT_ACTION,
      error: code,
      result: "denied",
      schemaVersion: 1,
    })}\n`);
    return 1;
  }
}

function repairPinnedConfigPermissions(): void {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid === undefined || gid === undefined) throw new BootstrapDenied("bootstrap_platform_unsupported");

  // The script lives under `scripts/tooling/`, so `dirname(dirname())` would
  // resolve to `scripts/`, NOT the repository root that owns the config. The
  // config-owning root is the directory that actually holds the pinned config
  // basename; walking up for it is correct at any script depth. The walk
  // refuses an ambiguous answer (a config basename at more than one depth) by
  // taking the SHALLOWEST ancestor that holds it, matching the runtime root
  // the pinned-config reader resolves for the same tree.
  const configBasename = ROOT_POLICY.configuration.basename;
  let declaredRoot = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(declaredRoot, configBasename))) break;
    const parent = dirname(declaredRoot);
    if (parent === declaredRoot) throw new BootstrapDenied("bootstrap_root_invalid");
    declaredRoot = parent;
  }
  const rootBefore = inspectRoot(declaredRoot, uid, gid);
  const mountPoints = readLinuxMountPoints();
  if (mountPoints.has(declaredRoot)) throw new BootstrapDenied("bootstrap_mountpoint_denied");

  let rootDescriptor: number | undefined;
  let configDescriptor: number | undefined;
  let verificationDescriptor: number | undefined;
  try {
    rootDescriptor = openSync(declaredRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const openedRoot = fstatSync(rootDescriptor, { bigint: true });
    if (!sameIdentity(rootBefore, openedRoot) || !openedRoot.isDirectory()) {
      throw new BootstrapDenied("bootstrap_identity_changed");
    }

    const configPath = join(declaredRoot, ROOT_POLICY.configuration.basename);
    const configBefore = inspectConfig(configPath, rootBefore, uid, gid, mountPoints);
    configDescriptor = openSync(configPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedBefore = fstatSync(configDescriptor, { bigint: true });
    if (!openedBefore.isFile() || !sameIdentity(configBefore, openedBefore)) {
      throw new BootstrapDenied("bootstrap_identity_changed");
    }
    const sourceHash = descriptorHash(configDescriptor, openedBefore.size);

    fchmodSync(configDescriptor, REQUIRED_MODE);

    const openedAfter = fstatSync(configDescriptor, { bigint: true });
    const pathAfter = inspectConfig(configPath, rootBefore, uid, gid, mountPoints);
    if (!sameFileIdentityAllowingModeChange(openedBefore, openedAfter) ||
      !sameIdentity(openedAfter, pathAfter) || modeOf(openedAfter) !== REQUIRED_MODE ||
      descriptorHash(configDescriptor, openedAfter.size) !== sourceHash) {
      throw new BootstrapDenied("bootstrap_identity_changed");
    }

    verificationDescriptor = openSync(configPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const verified = fstatSync(verificationDescriptor, { bigint: true });
    if (!verified.isFile() || !sameIdentity(openedAfter, verified) || modeOf(verified) !== REQUIRED_MODE ||
      descriptorHash(verificationDescriptor, verified.size) !== sourceHash) {
      throw new BootstrapDenied("bootstrap_identity_changed");
    }

    const rootAfter = inspectRoot(declaredRoot, uid, gid);
    const openedRootAfter = fstatSync(rootDescriptor, { bigint: true });
    if (!sameIdentity(rootBefore, rootAfter) || !sameIdentity(rootAfter, openedRootAfter)) {
      throw new BootstrapDenied("bootstrap_identity_changed");
    }
  } catch (error) {
    if (error instanceof BootstrapDenied) throw error;
    throw new BootstrapDenied("bootstrap_io_denied");
  } finally {
    if (verificationDescriptor !== undefined) closeSync(verificationDescriptor);
    if (configDescriptor !== undefined) closeSync(configDescriptor);
    if (rootDescriptor !== undefined) closeSync(rootDescriptor);
  }
}

function inspectRoot(path: string, uid: number, gid: number): BigIntStats {
  const stats = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new BootstrapDenied("bootstrap_root_invalid");
  }
  if (stats.uid !== BigInt(uid) || stats.gid !== BigInt(gid)) {
    throw new BootstrapDenied("bootstrap_owner_mismatch");
  }
  if (realpathSync(path) !== path) throw new BootstrapDenied("bootstrap_root_invalid");
  const parent = lstatSync(dirname(path), { bigint: true, throwIfNoEntry: false });
  if (!parent || parent.isSymbolicLink() || !parent.isDirectory() || parent.dev !== stats.dev) {
    throw new BootstrapDenied("bootstrap_root_invalid");
  }
  return stats;
}

function inspectConfig(
  path: string,
  root: BigIntStats,
  uid: number,
  gid: number,
  mountPoints: ReadonlySet<string>,
): BigIntStats {
  const stats = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (!stats || stats.isSymbolicLink() || !stats.isFile()) {
    throw new BootstrapDenied("bootstrap_config_invalid");
  }
  if (realpathSync(path) !== path) throw new BootstrapDenied("bootstrap_config_invalid");
  if (stats.uid !== BigInt(uid) || stats.gid !== BigInt(gid)) {
    throw new BootstrapDenied("bootstrap_owner_mismatch");
  }
  if (stats.dev !== root.dev) throw new BootstrapDenied("bootstrap_config_cross_device_denied");
  if (hasSecondName(stats.nlink)) throw new BootstrapDenied("bootstrap_config_hardlink_denied");
  if (mountPoints.has(path)) throw new BootstrapDenied("bootstrap_mountpoint_denied");
  if (stats.size > BigInt(ROOT_POLICY.configuration.maximumBytes)) {
    throw new BootstrapDenied("bootstrap_config_too_large");
  }
  return stats;
}

function descriptorHash(descriptor: number, size: bigint): string {
  const length = Number(size);
  if (!Number.isSafeInteger(length) || length < 0 || length > ROOT_POLICY.configuration.maximumBytes) {
    throw new BootstrapDenied("bootstrap_config_too_large");
  }
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < bytes.length) {
    const read = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (read === 0) throw new BootstrapDenied("bootstrap_identity_changed");
    offset += read;
  }
  return sha256(bytes);
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink && left.size === right.size;
}

function sameFileIdentityAllowingModeChange(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid &&
    left.gid === right.gid && left.nlink === right.nlink && left.size === right.size;
}

function modeOf(stats: BigIntStats): number {
  return Number(stats.mode & 0o7777n);
}

// Its own main test, not `isEntryPoint`: the trusted bootstrap's import
// surface is a fixed, verified set (s1-verification's
// `trusted-bootstrap-import-surface`), and the runtime's CLI module is not in it.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runBootstrap(process.argv.slice(2));
}
