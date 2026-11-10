/**
 * THE ONE WAY A TEST BUILDS A CUSTOMIZATION CONFIG STORE — for both suites
 * (engine/test and tests/), each handing in a fixture folder its own temp
 * owner made.
 *
 * A store's writes take the config write lock, which lives in the state
 * folder BESIDE the store's `configFilePath`
 * (src/kernel/config-write-lock.ts). A test store that named the real
 * `engine/bridlewise.config.json` (even an in-memory one) made its first
 * write create `engine/.bridlewise` on a fresh checkout. The store's write
 * door now refuses, under test, a store whose config lies inside the
 * checkout under test (`customization_store_checkout_under_test`,
 * src/shared/exposure/config-binding.ts), whatever spelled it; this module is
 * the one place a test names a fixture config instead.
 */
import { resolve } from "node:path";

import type { CustomizationConfigStore } from "../../src/shared/exposure/config-binding.ts";

/** The config file a test store names in `root`, a fixture folder its suite's temp owner made. */
export function fixtureConfigPath(root: string): string {
  return resolve(root, "bridlewise.config.json");
}

/** A store with the test's own read and write, its lock keyed on the fixture config at `path` (a file in a fixture folder, e.g. an isolated copy of the config). */
export function configStoreAt(path: string, readDocument: () => Record<string, unknown>, writeDocument: (doc: Record<string, unknown>) => void): CustomizationConfigStore {
  const config = fixtureConfigPath(resolve(path, ".."));
  if (config !== resolve(path)) throw new Error(`a test config store names a bridlewise.config.json in its fixture folder, not ${path}`);
  return Object.freeze({ configFilePath: config, readDocument, writeDocument });
}
