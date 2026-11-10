/**
 * UNDER TEST, A CUSTOMIZATION STORE WHOSE CONFIG IS INSIDE THE CHECKOUT UNDER
 * TEST IS REFUSED AT ITS WRITE, WHATEVER SPELLED IT
 * (src/shared/exposure/config-binding.ts, before the config write lock).
 *
 * A config store's write takes the lock in the state folder beside its
 * config; a test store that named the real `engine/bridlewise.config.json`
 * made `engine/.bridlewise` on a fresh checkout, under every concurrent
 * reader of the real config (FLAKY-CONFIG-PARENT-CHURN). A static scan loses
 * to a spelling; the refusal sits at the store's one write door, so the
 * engine's own store factory, a spread of it, a computed key and a path
 * computed under the engine folder all fail the same way, before the store is
 * read or written. A store over a config in the test's own fixture writes.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { engineConfigDocumentPath } from "../../src/kernel/config.ts";
import { engineRoot } from "../../src/kernel/engine-root.ts";
import {
  createEngineCustomizationConfigStore,
  installCustomizationConfigStore,
  resetCustomizationConfigStore,
  writeConfigCustomization,
  type CustomizationConfigStore,
} from "../../src/shared/exposure/config-binding.ts";
import { fixtureConfigPath } from "../support/fixture-config-store.ts";
import { mkTempDir } from "../support/temp-dir.ts";

const REFUSED = (error: unknown): boolean => (error as { code?: unknown }).code === "customization_store_checkout_under_test";

test("a store write is refused at its door whatever spelled the store — the engine factory, a spread, a computed key, a computed path — before it reads or writes", () => {
  let touched = 0;
  const counting = (store: CustomizationConfigStore): CustomizationConfigStore => ({
    ...store,
    readDocument: () => { touched += 1; return {}; },
    writeDocument: () => { touched += 1; },
  });
  const key = ["config", "File", "Path"].join("");
  const spellings: readonly CustomizationConfigStore[] = [
    counting(createEngineCustomizationConfigStore()),
    counting({ ...createEngineCustomizationConfigStore() }),
    counting({ [key]: engineConfigDocumentPath(), readDocument: () => ({}), writeDocument: () => {} } as unknown as CustomizationConfigStore),
    counting({ configFilePath: join(engineRoot(), "test", "..", "bridlewise.config.json"), readDocument: () => ({}), writeDocument: () => {} }),
  ];
  try {
    for (const store of spellings) {
      installCustomizationConfigStore(store);
      assert.throws(() => writeConfigCustomization("memory.trimThreshold", 0.5), REFUSED);
    }
    assert.equal(touched, 0, "a refused store is neither read nor written");
    // The same write through a fixture config goes through.
    let written: Record<string, unknown> | undefined;
    installCustomizationConfigStore({ configFilePath: fixtureConfigPath(mkTempDir("config-lock-store-")), readDocument: () => ({}), writeDocument: (doc) => { written = doc; } });
    writeConfigCustomization("memory.trimThreshold", 0.5);
    assert.deepEqual(written, { memory: { trimThreshold: 0.5 } });
  } finally {
    resetCustomizationConfigStore();
  }
});
