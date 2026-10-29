import { SecurityError } from "../kernel/errors.ts";
import { mountInfoDocument } from "../process/process-facts.ts";
import { handleError } from "../shared/debug/debug-system.ts";

export function hasTraversalSegment(path: string): boolean {
  return path.split(/[\\/]/u).some((component) => component === "..");
}

/** One mount of this process's mount namespace (`/proc/self/mountinfo`). */
export type LinuxMount = Readonly<{
  /** The mount's id and the id of the mount it is mounted on (mountinfo fields 1 and 2). */
  id: string;
  parentId: string;
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
      id: fields[0] ?? "",
      parentId: fields[1] ?? "",
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
 * A SELF-BIND: a mount of a directory onto ITS OWN PATH, showing exactly what
 * that path named before it — so it cannot change what any path resolves to,
 * only the mount's flags. The test confinement binds its writable places this
 * way (`engine/guardian/test-process-supervisor.c`). It is one only when ALL
 * hold (decision TEST-CONFINEMENT-SELF-BIND, "a visible mount of that
 * filesystem's root"):
 *
 * - the mount it is MOUNTED ON (its parent, mountinfo field 2) is the same
 *   filesystem — major:minor, type and source — so the path resolved through
 *   that very filesystem before;
 * - it shows the directory that path named through the parent: the parent's
 *   own directory (its `root`: `/` for the filesystem's root, a directory for a
 *   bind, so a self-bind nested in a self-bind is one too) joined with the
 *   mount point's path beneath the parent's mount point;
 * - the parent is VISIBLE: nothing is stacked over it at its own mount point,
 *   and no other mount lies on the path between the parent's mount point and
 *   this one (a mount in between, a tmpfs over a lower directory, would make
 *   the path name something else before the bind: a content swap).
 *
 * A bind of another directory, of another filesystem, onto a mount that is
 * not that filesystem's visible root, and every mount nested under a
 * self-bind are NOT self-binds: they can put different content at a path.
 */
function isSelfBind(mount: LinuxMount, mounts: readonly LinuxMount[]): boolean {
  const parent = mounts.find((candidate) => candidate.id === mount.parentId && candidate !== mount);
  if (parent === undefined) return false;
  if (parent.device !== mount.device || parent.fsType !== mount.fsType || parent.source !== mount.source) return false;
  const beneath = mount.mountPoint === parent.mountPoint ? "" : strictlyBeneath(mount.mountPoint, parent.mountPoint)
    ? mount.mountPoint.slice(parent.mountPoint === "/" ? 0 : parent.mountPoint.length) : undefined;
  if (beneath === undefined || mount.root !== (beneath === "" ? parent.root : joinedMountPath(parent.root, beneath))) return false;
  return !mounts.some((other) => other !== mount && other !== parent && (
    (other.parentId === parent.id && other.mountPoint === parent.mountPoint)
    || (strictlyBeneath(other.mountPoint, parent.mountPoint) && strictlyBeneath(mount.mountPoint, other.mountPoint))));
}

/** `inner` lies strictly beneath `outer` (path components; `/` contains every other absolute path). */
function strictlyBeneath(inner: string, outer: string): boolean {
  return inner !== outer && (outer === "/" ? inner.startsWith("/") : inner.startsWith(`${outer}/`));
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
