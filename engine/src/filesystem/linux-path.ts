import { SecurityError } from "../kernel/errors.ts";
import { mountInfoDocument } from "../process/process-facts.ts";
import { handleError } from "../shared/debug/debug-system.ts";

export function hasTraversalSegment(path: string): boolean {
  return path.split(/[\\/]/u).some((component) => component === "..");
}

/** One mount of this process's mount namespace (`/proc/self/mountinfo`). */
export type LinuxMount = Readonly<{
  mountPoint: string;
  /** `major:minor` of the mounted filesystem. */
  device: string;
  /** The directory of that filesystem the mount shows (`/` for the filesystem's own root). */
  root: string;
  fsType: string;
  source: string;
  superOptions: string;
}>;

/**
 * THE MOUNT TABLE, parsed once per call: `id parent major:minor root
 * mountpoint options [optional…] - fstype source superoptions`.
 */
function readLinuxMounts(): readonly LinuxMount[] {
  const mountInfo = mountInfoDocument();
  if (mountInfo === undefined) throw new SecurityError("Linux mount information is required", "mount_information_unavailable");
  return parseMountInfo(mountInfo);
}

/** The mountinfo document's mounts (exported for the reader's own tests: a planted table, never a live one). */
export function parseMountInfo(mountInfo: string): readonly LinuxMount[] {
  return mountInfo.split("\n").flatMap((line) => {
    const fields = line.split(" ");
    const mountPath = fields[4];
    const separator = fields.indexOf("-", 6);
    if (mountPath === undefined || separator < 0) return [];
    return [{
      mountPoint: decodeMountPath(mountPath),
      device: fields[2] ?? "",
      root: decodeMountPath(fields[3] ?? ""),
      fsType: fields[separator + 1] ?? "",
      source: fields[separator + 2] ?? "",
      superOptions: fields[separator + 3] ?? "",
    }];
  });
}

/**
 * A SELF-BIND: a mount of a directory onto ITS OWN PATH — the same filesystem
 * (major:minor, type and source) as a mount of that filesystem's root, showing
 * exactly the directory that path already names on it (its `root` is the mount
 * point's path relative to where the filesystem's root is mounted). It cannot
 * change what any path resolves to — the same superblock, the same inode tree —
 * only the mount's flags (read-only). The test confinement makes the checkout
 * and its git directories read-only this way
 * (`engine/guardian/test-process-supervisor.c`, `--read-only-root`).
 *
 * A bind of ANOTHER directory of the same filesystem onto the path (its `root`
 * differs), any other filesystem, and every mount nested under a self-bind are
 * NOT self-binds: they can put different content at a path.
 */
function isSelfBind(mount: LinuxMount, mounts: readonly LinuxMount[]): boolean {
  if (mount.root === "/") return false;
  return mounts.some((primary) => primary !== mount && primary.root === "/" &&
    primary.device === mount.device && primary.fsType === mount.fsType && primary.source === mount.source &&
    joinedMountPath(primary.mountPoint, mount.root) === mount.mountPoint);
}

function joinedMountPath(base: string, inner: string): string {
  return base === "/" ? inner : `${base}${inner}`;
}

/**
 * THE ONE ANSWER TO "IS SOMETHING MOUNTED HERE" for S1's refusals of a mounted
 * runtime root, repository root or ancestor, configuration and receipt chain
 * (`config.ts`, `pinned-path-internal.ts`, `immutable-receipt.ts`, the
 * permission bootstrap): every mount point of this namespace EXCEPT the
 * self-binds ({@link isSelfBind}). Those refusals exist to stop a path
 * resolving to different content — another filesystem or another subtree
 * swapped in; a self-bind is content-neutral, so a read-only test checkout is
 * still the same checkout (decision TEST-CONFINEMENT-SELF-BIND).
 */
export function readLinuxMountPoints(): ReadonlySet<string> {
  return mountPointsOf(readLinuxMounts());
}

/** {@link readLinuxMountPoints} over a given table (the reader's own tests plant one). */
export function mountPointsOf(mounts: readonly LinuxMount[]): ReadonlySet<string> {
  return new Set(mounts.filter((mount) => !isSelfBind(mount, mounts)).map((mount) => mount.mountPoint));
}

/**
 * A WINDOWS DRIVE MOUNTED INTO WSL (DrvFs): the Windows filesystem, whose
 * names compare case-insensitively (`.CODEX` is `.codex`). WSL1 names the
 * type `drvfs`; WSL2 mounts it over 9p with `aname=drvfs`.
 */
function isWindowsDriveMount(mount: LinuxMount): boolean {
  return mount.fsType === "drvfs" || (mount.fsType === "9p" && mount.superOptions.split(/[;,]/u).includes("aname=drvfs"));
}

let windowsDriveMountPointsCache: readonly string[] | undefined;

/**
 * THE WINDOWS DRIVES OF THIS HOST (DrvFs mount points), read once per process:
 * they are mounted when WSL starts, and every consumer (the path locator, the
 * keep-out list, the long-name resolution below) asks this one answer. A
 * mount table that cannot be read yields none — the strict reading for every
 * consumer (names then compare exactly) — and the gap is reported.
 */
export function windowsDriveMountPoints(): readonly string[] {
  if (windowsDriveMountPointsCache === undefined) {
    let mounts: readonly LinuxMount[] = [];
    try { mounts = readLinuxMounts(); } catch (error) {
      handleError(error, { module: "filesystem/linux-path", operation: "windowsDriveMountPoints" });
    }
    windowsDriveMountPointsCache = Object.freeze(mounts.filter(isWindowsDriveMount).map((mount) => mount.mountPoint));
  }
  return windowsDriveMountPointsCache;
}

function decodeMountPath(path: string): string {
  return path.replace(/\\([0-7]{3})/gu, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}
