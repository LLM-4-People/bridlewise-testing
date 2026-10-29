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

import { closeSync, constants, fchmodSync, fstatSync, openSync } from "node:fs";

import { assertCheckoutWriteAllowed } from "./checkout-write-door.ts";

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
