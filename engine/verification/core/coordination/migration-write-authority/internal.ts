/**
 * MigrationWriteAuthority — shared internal helpers.
 *
 * One canonical owner for helpers duplicated across the MWA modules:
 * `pathIdentityFromStat` (was copied in effects, repository-facts, and the
 * genesis script), `stateIdentity` (was duplicated in the backend and
 * recovery), and `denied` (was duplicated in the backend and authority).
 *
 * Design authority: MWA-DESIGN §2. These helpers are internal to the MWA
 * package; they are not part of the port interfaces and must not be re-exported
 * to consumers.
 */

import { statSync } from "node:fs";

import { canonicalHash, deepFreeze } from "../../../../src/kernel/integrity.ts";
import {
  type BackendError,
  type PathIdentity,
  type Sha256,
  type TargetState,
} from "./contracts.ts";

/**
 * Descriptor-verified path identity from a `Stats`-like object. Uses
 * `BigInt` for `dev`/`ino`/`nlink` to avoid precision loss on 32-bit
 * platforms. The `kind` is derived from `isDirectory()`.
 */
export function pathIdentityFromStat(stats: { dev: number; ino: number; mode: number; uid: number; gid: number; nlink: number; isDirectory(): boolean }): PathIdentity {
  return deepFreeze({
    device: BigInt(stats.dev).toString(10),
    inode: BigInt(stats.ino).toString(10),
    mode: stats.mode,
    ownerUid: stats.uid.toString(10),
    ownerGid: stats.gid.toString(10),
    links: BigInt(stats.nlink).toString(10),
    kind: stats.isDirectory() ? "directory" : "file",
  });
}

/**
 * Convenience: stat a path and return its `PathIdentity`. Used by the genesis
 * tool which has the absolute path but not a pre-fetched `Stats` object.
 */
export function pathIdentityFromPath(absolutePath: string): PathIdentity {
  return pathIdentityFromStat(statSync(absolutePath));
}

/**
 * Canonical state identity (sha256 of the canonical JSON of the state).
 * Returns `null` for a `null` state (typed absence permitted by some plans).
 */
export function stateIdentity(state: TargetState | null): Sha256 | null {
  return state === null ? null : canonicalHash(state);
}

/**
 * Constructs a denied `BackendResult`-compatible object. Used by both the
 * backend and the authority to return typed denials with
 * `partialReservationRetained: false`.
 */
export function denied(error: BackendError): { outcome: "denied"; error: BackendError; partialReservationRetained: false } {
  return deepFreeze({ outcome: "denied", error, partialReservationRetained: false });
}
