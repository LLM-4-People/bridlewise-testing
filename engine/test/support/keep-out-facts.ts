/**
 * THE HOST FACTS OF A COMPILE IN A TEST, STATED: no host files and the
 * registry of a fresh, EMPTY key home of the test's own (inside the run's
 * private key home, removed with it). The registry is an explicit dependency
 * of the keep-out list, so a test names exactly the stores it means — a
 * compiler-semantics test sees none, whatever other test files registered.
 */
import { createOwnedTemporaryDirectory } from "../../src/filesystem/private-state.ts";
import { admitKeyHome, openStoreRegistry } from "../../src/filesystem/self-protection/key-home.ts";
import type { KeepOutFacts } from "../../src/filesystem/self-protection/keep-out.ts";
import { armTestKeyHome } from "./test-key-home.ts";

/** A fresh, empty, admitted key home of the test's own. */
export function emptyTestKeyHome(): string {
  return admitKeyHome(createOwnedTemporaryDirectory(armTestKeyHome(), "empty-"), []);
}

/** `{ hostPaths: [], registry: <the registry of a fresh, empty key home> }`. */
export function emptyKeepOutFacts(): Omit<KeepOutFacts, "harnessRoot"> {
  return Object.freeze({ hostPaths: [], registry: openStoreRegistry(emptyTestKeyHome()) });
}
