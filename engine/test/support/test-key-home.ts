/**
 * A TEST RUN NEVER TOUCHES THE USER'S KEY HOME. Our runners (the root vitest
 * config, the engine runner's worker) arm a private key home for the run — an
 * owned temporary (`private-state.ts`: owner pid + start time) under the
 * user's cache home (never the system temp folder: the key home must be
 * disjoint from it, and a confined command's temp grant must never contain
 * one) — exported to every descendant and removed when the arming process
 * exits; one a crashed run left is swept by the next. A process under test
 * WITHOUT one is refused by `keyHomeLocation` (`key_home_unset_under_test`):
 * production code never chooses a key home by detecting a test.
 */
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

import { PRODUCT_NAME } from "../../src/kernel/product-identity.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { ownedTemporaryName, PRIVATE_STATE_DIRECTORY_MODE, sweepAbandonedTemporaries } from "../../src/filesystem/private-state.ts";
import { userCacheFolder } from "../../src/filesystem/user-folders.ts";

const POLICY = ROOT_POLICY.selfProtection.keyHome;
const TEST_KEY_HOME_PREFIX = `${PRODUCT_NAME}-test-keys-`;

function isTestKeyHome(path: string | undefined): path is string {
  return path !== undefined && basename(path).startsWith(TEST_KEY_HOME_PREFIX) && existsSync(path);
}

/** Arm a private key home for this test run (idempotent within a run: an inherited one is kept). */
export function armTestKeyHome(): string {
  const inherited = process.env[POLICY.environmentVariable];
  if (isTestKeyHome(inherited)) return inherited;
  const parent = join(userCacheFolder(), ...POLICY.testRelative.split("/"));
  mkdirSync(parent, { recursive: true, mode: PRIVATE_STATE_DIRECTORY_MODE });
  sweepAbandonedTemporaries(parent, TEST_KEY_HOME_PREFIX);
  const home = join(parent, ownedTemporaryName(TEST_KEY_HOME_PREFIX));
  mkdirSync(home, { mode: PRIVATE_STATE_DIRECTORY_MODE });
  chmodSync(home, PRIVATE_STATE_DIRECTORY_MODE);
  process.env[POLICY.environmentVariable] = home;
  process.once("exit", () => rmSync(home, { recursive: true, force: true }));
  return home;
}
