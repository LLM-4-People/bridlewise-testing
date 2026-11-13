import { InputError } from "../kernel/errors.ts";

export type FilesystemBoundaryCode = "path_cross_device_denied" | "path_mountpoint_denied";
export type RelativePathViolationKind =
  | "absolute"
  | "backslash"
  | "control-character"
  | "dot-segment"
  | "empty"
  | "empty-segment";

const PATH_CONTROL = /[\u0000-\u001f\u007f]/u;

export function decideFilesystemBoundary(
  rootDevice: bigint,
  targetDevice: bigint,
  targetIsMountPoint: boolean,
): FilesystemBoundaryCode | undefined {
  if (targetDevice !== rootDevice) return "path_cross_device_denied";
  if (targetIsMountPoint) return "path_mountpoint_denied";
  return undefined;
}

export function relativePathViolationKinds(path: string): readonly RelativePathViolationKind[] {
  const reasons: RelativePathViolationKind[] = [];
  if (path === "") reasons.push("empty");
  if (path.startsWith("/")) reasons.push("absolute");
  if (path.includes("\\")) reasons.push("backslash");
  if (PATH_CONTROL.test(path)) reasons.push("control-character");
  const segments = path.split("/");
  if (segments.some((segment) => segment === "")) reasons.push("empty-segment");
  if (segments.some((segment) => segment === "." || segment === "..")) reasons.push("dot-segment");
  return Object.freeze(reasons.toSorted());
}
/**
 * Relate logical repository keys by whole components, never locations on disk.
 * Empty and `.` name the repository root; every other key uses the relative
 * path grammar above. An empty suffix means the same key, null means outside.
 * This cannot authorize a filesystem operation: links and inode identity are
 * questions for the path-identity owner.
 */
export function relativeKeySuffix(key: string, ancestor: string): string | null {
  const parts = (value: string): readonly string[] => {
    if (value === "" || value === ".") return [];
    if (relativePathViolationKinds(value).length > 0) {
      throw new InputError("A repository key must use the relative path grammar", "repository_key_invalid");
    }
    return value.split("/");
  };
  const names = parts(key);
  const prefix = parts(ancestor);
  if (prefix.length > names.length || prefix.some((name, index) => name !== names[index])) return null;
  return names.slice(prefix.length).join("/");
}
