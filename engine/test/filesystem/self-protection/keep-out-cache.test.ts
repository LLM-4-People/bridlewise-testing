/**
 * THE KEEP-OUT LIST IS BUILT ONCE PER GENERATION (secd-design H4: it was
 * rebuilt for every file-door check — readdir of the registry, every store's
 * folder, realpath of every entry — 5.7 ms a verdict with this host's 35
 * stores, per directory entry of a search walk). Deterministic, by the build
 * counter: asking again changes nothing; a registration, a new wildcard
 * folder or a re-created base folder moves the generation exactly once.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createTempDir } from "../../support/temp-dir.ts";
import { admitKeyHome, openStoreRegistry, registerHarnessStore } from "../../../src/filesystem/self-protection/key-home.ts";
import { keepOutListBuilds, keepOutPolicyFor } from "../../../src/filesystem/self-protection/keep-out.ts";
import { DEFAULT_SELF_PROTECTION_CONFIG } from "../../../src/filesystem/self-protection/self-protection-config.ts";

test("keep-out cache: asked 1,000 times with 50 registered stores, the list is built once; each change rebuilds it once", () => {
  const root = realpathSync(createTempDir("keep-out-cache-"));
  try {
    const keyHome = admitKeyHome(join(root, "keys"), []);
    for (let index = 0; index < 50; index += 1) {
      const store = join(root, `install-${index}`, "web.db");
      mkdirSync(join(root, `install-${index}`));
      writeFileSync(store, "");
      registerHarnessStore(keyHome, store);
    }
    const facts = { harnessRoot: join(root, "harness"), hostPaths: [], registry: openStoreRegistry(keyHome) };
    keepOutPolicyFor(DEFAULT_SELF_PROTECTION_CONFIG, facts);
    const built = keepOutListBuilds();
    const operation = keepOutPolicyFor(DEFAULT_SELF_PROTECTION_CONFIG, facts).operation();
    for (let index = 0; index < 1000; index += 1) {
      assert.equal(keepOutPolicyFor(DEFAULT_SELF_PROTECTION_CONFIG, facts).verdict(join(root, "notes", `${index}.md`)), undefined);
      assert.equal(operation.verdict(join(root, "install-7", "web.db-wal"))?.relation, "under");
    }
    assert.equal(keepOutListBuilds(), built, "no rebuild while nothing it is built from moved");
    // A new registration moves the generation once.
    mkdirSync(join(root, "late"));
    writeFileSync(join(root, "late", "web.db"), "");
    registerHarnessStore(keyHome, join(root, "late", "web.db"));
    assert.equal(keepOutPolicyFor(DEFAULT_SELF_PROTECTION_CONFIG, facts).verdict(join(root, "late", "web.db"))?.relation, "under");
    assert.equal(keepOutListBuilds(), built + 1);
    keepOutPolicyFor(DEFAULT_SELF_PROTECTION_CONFIG, facts);
    assert.equal(keepOutListBuilds(), built + 1);
    // A base folder deleted and re-created (a new identity) is measured again: never a stale identity.
    rmSync(join(root, "install-3"), { recursive: true });
    mkdirSync(join(root, "install-3"));
    assert.equal(keepOutPolicyFor(DEFAULT_SELF_PROTECTION_CONFIG, facts).verdict(join(root, "install-3", "web.db"))?.relation, "under");
    assert.equal(keepOutListBuilds(), built + 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
