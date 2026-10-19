/**
 * THE KEY HOME (`src/filesystem/self-protection/key-home.ts`): where every
 * harness key lives — one private folder, outside every checkout, state
 * folder, grant and the system temp folder — its ONE admission, its registry
 * of harness stores (an explicit dependency that never prunes on a read and
 * records which stores share a key), and the keep-out list's hold on both.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createTempDir } from "../../support/temp-dir.ts";
import { SecurityError } from "../../../src/kernel/errors.ts";
import { ROOT_POLICY } from "../../../src/kernel/root-policy.ts";
import {
  admitHarnessKeyHome,
  admitKeyHome,
  databaseKeyFile,
  databaseKeyName,
  forgetHarnessStore,
  openStoreRegistry,
  registerHarnessStore,
} from "../../../src/filesystem/self-protection/key-home.ts";
import { keepOutPolicyFor } from "../../../src/filesystem/self-protection/keep-out.ts";
import { DEFAULT_SELF_PROTECTION_CONFIG } from "../../../src/filesystem/self-protection/self-protection-config.ts";
import { resolvePersistedKey } from "../../../src/filesystem/persisted-key.ts";

const POLICY = ROOT_POLICY.selfProtection.keyHome;
const refused = (code: string) => (error: unknown) => error instanceof SecurityError && error.code === code;

/** Run `body` with the key home location pointed at `location`. */
function withKeyHomeLocation<T>(location: string, body: () => T): T {
  const previous = process.env[POLICY.environmentVariable];
  process.env[POLICY.environmentVariable] = location;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env[POLICY.environmentVariable]; else process.env[POLICY.environmentVariable] = previous;
  }
}

test("key-home: admitted private (0700); refused when shared, a LINK, another user's or overlapping a neighbour", () => {
  const root = realpathSync(createTempDir("key-home-admit-"));
  try {
    const home = admitKeyHome(join(root, "keys"), []);
    assert.equal(statSync(home).mode & 0o777, 0o700);
    chmodSync(home, 0o750);
    assert.throws(() => admitKeyHome(home, []), refused("key_home_unsafe"), "group-readable");
    chmodSync(home, 0o700);
    const link = join(root, "linked-keys");
    symlinkSync(home, link);
    // A link planted where the key home is expected would move every key to its target (secd-security 1j).
    assert.throws(() => admitKeyHome(link, []), refused("key_home_unsafe"), "a key home that is a link");
    const state = join(root, "state");
    mkdirSync(state, { mode: 0o700 });
    chmodSync(state, 0o700);
    chmodSync(root, 0o700);
    assert.throws(() => admitKeyHome(join(state, "keys"), [{ path: state, what: "the database's folder" }]), refused("key_home_not_disjoint"));
    assert.throws(() => admitKeyHome(root, [{ path: state, what: "the database's folder" }]), refused("key_home_not_disjoint"), "a key home CONTAINING the state folder");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("key-home: THE ONE admission keeps keys out of the system temp folder, every store's folder and a host's project roots", () => {
  // Off the system temp folder (inside the run's own key home), so each arm
  // is refused for its own neighbour, not for being under /tmp.
  const root = realpathSync(mkdtempSync(join(process.env[POLICY.environmentVariable]!, "one-admission-")));
  try {
    const state = join(root, "state");
    mkdirSync(state, { mode: 0o700 });
    // Under the system temp folder (a grant of it, or a store kept there, would reach it).
    const inTemp = join(realpathSync(createTempDir("key-home-in-temp-")), "keys");
    assert.throws(() => withKeyHomeLocation(inTemp, () => admitHarnessKeyHome([])), refused("key_home_not_disjoint"), "a key home under /tmp");
    // A key beside its database is exactly what the key home replaces: refused at the key's own admission.
    assert.throws(() => withKeyHomeLocation(state, () => resolvePersistedKey({ dbPath: join(state, "web.db"), disposition: "create-or-load" })), refused("key_home_not_disjoint"));
    // A key home inside a project a host declares.
    const project = join(root, "project");
    mkdirSync(project, { mode: 0o700 });
    assert.throws(() => withKeyHomeLocation(join(project, "keys"), () => admitHarnessKeyHome([], [{ path: project, what: "a declared project root" }])), refused("key_home_not_disjoint"), "a key home inside a project");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("key-home: the registry is explicit, records which key seals each store, never prunes on a read; forget is the tool's", () => {
  const root = realpathSync(createTempDir("key-home-registry-"));
  try {
    const home = admitKeyHome(join(root, "keys"), []);
    const state = join(root, "state"), elsewhere = join(root, "timelines");
    mkdirSync(state); mkdirSync(elsewhere);
    const web = join(state, "web.db"), timeline = join(elsewhere, "timeline.db");
    assert.equal(databaseKeyFile(home, web), join(home, `${databaseKeyName(web)}${POLICY.keySuffix}`), "a key is named by its database's folder");
    writeFileSync(web, ""); writeFileSync(timeline, "");
    const registry = openStoreRegistry(home);
    const before = registry.generation();
    registerHarnessStore(home, web);
    registerHarnessStore(home, web);
    registerHarnessStore(home, timeline, web);
    assert.notEqual(registry.generation(), before, "a registration moves the generation");
    assert.deepEqual(registry.records().map((record) => record.path), [web, timeline].sort());
    assert.deepEqual([...registry.sharingKey(databaseKeyName(web))].sort(), [web, timeline].sort(), "the timeline shares the web database's key, wherever it lives");
    // A store briefly absent (a restore by mv, an unmounted drive) stays registered and kept out.
    rmSync(web);
    const listed = readdirSync(join(home, POLICY.storesDirectory)).sort();
    assert.deepEqual(registry.records().map((record) => record.path), [web, timeline].sort(), "a read never removes a record");
    assert.deepEqual(readdirSync(join(home, POLICY.storesDirectory)).sort(), listed, "the key home is unchanged by a read");
    const policy = keepOutPolicyFor(DEFAULT_SELF_PROTECTION_CONFIG, { harnessRoot: join(root, "harness"), hostPaths: [], registry });
    assert.equal(policy.verdict(web)?.relation, "under", "a store that comes back is still kept out");
    assert.equal(forgetHarnessStore(home, web), true);
    assert.equal(forgetHarnessStore(home, web), false);
    assert.deepEqual(registry.records().map((record) => record.path), [timeline]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("key-home: a first-format record is brought to the current format at admission (its key: its own folder's)", () => {
  const root = realpathSync(createTempDir("key-home-upgrade-"));
  try {
    const home = admitKeyHome(join(root, "keys"), []);
    const store = join(root, "state", "web.db");
    mkdirSync(join(root, "state"));
    writeFileSync(store, "");
    registerHarnessStore(home, store);
    const [name] = readdirSync(join(home, POLICY.storesDirectory));
    const file = join(home, POLICY.storesDirectory, name!);
    writeFileSync(file, JSON.stringify({ path: store, schemaVersion: "bridlewise-harness-store-record/v1" }));
    admitKeyHome(home, []);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { key: databaseKeyName(store), path: store, schemaVersion: "bridlewise-harness-store-record/v2" });
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("key-home: the keep-out list holds the key home and every registered store's WHOLE family (by prefix, whenever a member appears)", () => {
  const root = realpathSync(createTempDir("key-home-keep-out-"));
  try {
    const home = admitKeyHome(join(root, "keys"), []);
    const store = join(root, "lab", "deep", "checkout", ".code-harness", "web.db");
    mkdirSync(join(store, ".."), { recursive: true });
    writeFileSync(store, "");
    registerHarnessStore(home, store);
    const policy = keepOutPolicyFor(DEFAULT_SELF_PROTECTION_CONFIG, { harnessRoot: join(root, "harness"), hostPaths: [], registry: openStoreRegistry(home) });
    // Members written AFTER the list was built: a prefix, not a listing.
    writeFileSync(`${store}.pre-v18`, "");
    writeFileSync(join(store, "..", "db-key.next"), "");
    for (const place of [home, join(home, "anything.key"), store, `${store}-wal`, `${store}.pre-v18`, `${store}.staging-x`, join(store, "..", "db-key.next"), join(root, "lab")]) {
      assert.ok(policy.verdict(place) !== undefined, `${place} is kept out`);
    }
    assert.equal(policy.verdict(join(root, "lab", "notes")), undefined, "a folder beside the store is not");
    assert.equal(policy.verdict(join(store, "..", "notes.md")), undefined, "a file beside the store that is not of its family is not");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("key-home: a process under test with no key home is REFUSED — production never picks one by detecting a test", () => {
  // This file runs under the engine runner: a child inherits the runner's
  // ancestry, so the write door says "under test". Without the variable the
  // key home is refused, and nothing is created at the default location.
  const root = realpathSync(createTempDir("key-home-unset-"));
  try {
    const keyHome = fileURLToPath(new URL("../../../src/filesystem/self-protection/key-home.ts", import.meta.url));
    const env: NodeJS.ProcessEnv = { ...process.env, [POLICY.baseVariable]: root };
    delete env[POLICY.environmentVariable];
    const child = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e",
      `import(${JSON.stringify(keyHome)}).then((m) => { try { m.keyHomeLocation(); console.log("picked"); } catch (e) { console.log(e.code); } })`], { encoding: "utf8", env });
    assert.equal(child.stdout.trim(), "key_home_unset_under_test", child.stderr);
    assert.equal(existsSync(join(root, POLICY.relative)), false, "no key home was created");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
