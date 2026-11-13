/**
 * THE ONE OWNER OF "THIS FILE HOLDS EXACTLY THIS MODE".
 *
 * A file's mode is settled ONLY WHEN IT DIFFERS: the mode is read from the
 * open descriptor first, and `fchmod` runs only when it is not already the
 * required one. A chmod to the mode a file already has is not a no-op: it
 * moves the file's ctime, and a ctime is part of the identity every
 * configuration bootstrap compares before and after its reads
 * (`src/kernel/config.ts`). An unconditional chmod of the live configuration,
 * repeated by a test in the middle of a run, made a concurrent commit guard's
 * bootstrap refuse an unrelated commit ("Repository root changed during
 * configuration bootstrap", #293, #132; attributed on the hosted runner to a
 * same-mode chmod 0600, notify_change ia_valid ATTR_MODE|ATTR_CTIME).
 *
 * Every settle of the configuration document's required mode goes through
 * here: the checkout settle after every tree move
 * (`src/workflow/checkout-setup.ts` `settleCheckout`) and the trusted
 * permission bootstrap (`scripts/tooling/bootstrap-permissions.ts`), which
 * holds its own verified descriptor and passes it in.
 */

import { closeSync, constants, fchmodSync, fstatSync, openSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { assertCheckoutWriteAllowed } from "./checkout-write-door.ts";
import { InputError, SecurityError } from "../kernel/errors.ts";
import { relativePathViolationKinds } from "./path-boundary.ts";
import { openContainedFolder, type ResolvedAbsolutePath } from "./path-identity.ts";
import { fileDescriptorPath } from "./linux-path.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";

/** The permission bits a mode settle compares and sets (the file type is not a mode to settle). */
const PERMISSION_BITS = 0o7777;

/**
 * Settles the mode of the file open at `descriptor` to `mode`, only when it
 * differs. Returns whether the mode was changed (false: the file already held
 * it, and nothing about it moved).
 */
export function settleDescriptorMode(descriptor: number, mode: number): boolean {
  if ((fstatSync(descriptor).mode & PERMISSION_BITS) === mode) return false;
  fchmodSync(descriptor, mode);
  return true;
}

/**
 * Settles the mode of the regular file at `path` to `mode`, only when it
 * differs, through a descriptor opened without following a final symlink (a
 * link planted at the path is refused by the open, never followed to its
 * target). A mode that must change is a write, so it passes the checkout
 * write door first: a test process never changes a file of the checkout it
 * runs in (`checkout-write-door.ts`). Returns whether the mode was changed.
 */
export function settleFileMode(path: string, mode: number): boolean {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if ((fstatSync(descriptor).mode & PERMISSION_BITS) === mode) return false;
    assertCheckoutWriteAllowed(path);
    return settleDescriptorMode(descriptor, mode);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Settle one declared regular file beneath a resolved checkout root through
 * the Linux descriptor-pinned path adapter. Every
 * parent is descriptor-pinned without following links; the leaf must be a
 * single-name regular file, so settling cannot widen an outside hard link.
 * Missing files stay missing. The checkout write door judges the held file,
 * rather than a pathname that could be replaced after it was opened.
 */
export function settleContainedFileMode(root: ResolvedAbsolutePath, path: string, mode: number): boolean | undefined {
  if (relativePathViolationKinds(path).length > 0) {
    throw new InputError("A mode-settle path must be relative to its checkout", "file_mode_path_invalid");
  }
  const names = path.split("/");
  const name = names.pop()!;
  const parent = openContainedFolder(root, names, false);
  if (parent === undefined) return undefined;
  try {
    let descriptor: number;
    try {
      descriptor = openSync(join(parent.path, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      const observed = fstatSync(descriptor);
      if (!observed.isFile() || observed.nlink !== 1) {
        throw new SecurityError("A checkout mode settle requires an unshared regular file", "file_mode_unsafe_file");
      }
      if ((observed.mode & PERMISSION_BITS) === mode) return false;
      // The pathname door deliberately keeps a final symlink's own location
      // (unlink/rename write that name). A descriptor mutation instead writes
      // its held file: resolve that identity before asking, then chmod the
      // same descriptor, without reopening the resolved pathname.
      const heldFile = realpathSync(fileDescriptorPath(ROOT_POLICY.receipts.immutableExecution.procFileDescriptorRoot, descriptor));
      assertCheckoutWriteAllowed(heldFile);
      return settleDescriptorMode(descriptor, mode);
    } finally {
      closeSync(descriptor);
    }
  } finally {
    parent.close();
  }
}
