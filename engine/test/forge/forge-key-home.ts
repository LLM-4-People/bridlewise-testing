/**
 * THE FORGE TESTS' KEY HOMES (a test helper, not a test file). Every forge
 * test that stores an App key does it in a key home THIS helper has just
 * created, empty, under the test process's own temporary root: no test ever
 * writes, reads or deletes a record in a key home it did not create.
 *
 * And it refuses to run at all unless the process is under the runners'
 * private test key home (`HARNESS_KEY_HOME` naming a `bridlewise-test-keys-*`
 * folder): a forge test started by hand against a real key home stops
 * before it touches anything.
 */
import { basename } from "node:path";

import { admitKeyHome, type AdmittedKeyHome } from "../../src/filesystem/self-protection/key-home.ts";
import { engineRoot } from "../../src/kernel/engine-root.ts";
import { PRODUCT_NAME } from "../../src/kernel/product-identity.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { createTempDir } from "../support/temp-dir.ts";

const VARIABLE = ROOT_POLICY.selfProtection.keyHome.environmentVariable;

/** Throws unless this process runs under the runners' private test key home. */
export function requireTestKeyHome(): void {
  const armed = process.env[VARIABLE];
  if (armed === undefined || !basename(armed).startsWith(`${PRODUCT_NAME}-test-keys-`)) {
    throw new Error(`refused: the forge tests run only under the runners' private test key home (${VARIABLE}=${armed ?? "unset"}); run them through the test runner, never against a real key home`);
  }
}

/** A NEW, EMPTY key home of this test's own (0700, under the process's temporary root), admitted like the real one. */
export function temporaryKeyHome(): AdmittedKeyHome {
  requireTestKeyHome();
  return admitKeyHome(createTempDir("forge-key-home-"), [{ path: engineRoot(), what: "the harness checkout" }]);
}
