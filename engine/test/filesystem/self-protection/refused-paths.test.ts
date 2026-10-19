/**
 * THE ONE KEEP-OUT LIST AND W^X, AT THE COMPILER FLOOR, BY IDENTITY.
 *
 * Every confined consumer (the web server's commands and its stdio MCP
 * servers, the engine) compiles its spec through
 * `compileSelfProtectionConfigToSpec`, so these properties are asserted there:
 *
 *   - the floor's home list is unremovable (an operator's empty
 *     `additionalProtectedSubtrees` removes nothing; an entry ADDS);
 *   - the key home and every harness store registered there are refused —
 *     at ANY depth: a folder above a checkout is refused (the one-level
 *     `db-key` heuristic this replaced missed it, secc-design H3);
 *   - every entry that exists is emitted into the spec, so the C guardian
 *     enforces it too;
 *   - the host's own refused files (a database and its missing `-wal`) are
 *     refused to any rule that equals or contains them;
 *   - no EXECUTE rule may overlap a writable one (W^X), whichever rule it is;
 *   - every one of those — and the protected-subtree floor — compares
 *     LOCATIONS by (device, inode), so a bind-mount alias (WSL's
 *     `/mnt/wslg/distro`) cannot dodge it. The alias is made for real in a
 *     private mount namespace (`unshare -rm`), so the test needs no WSL.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { createTempDir, systemTempRoot } from "../../support/temp-dir.ts";
import { InputError } from "../../../src/kernel/errors.ts";
import { ROOT_POLICY } from "../../../src/kernel/root-policy.ts";
import { compileSelfProtectionConfigToSpec } from "../../../src/filesystem/self-protection/guardian-binary.ts";
import {
  DEFAULT_SELF_PROTECTION_CONFIG,
  parseSelfProtectionConfig,
  type SelfProtectionConfig,
} from "../../../src/filesystem/self-protection/self-protection-config.ts";
import { identityOverlapIndex, resolveLocation } from "../../../src/filesystem/path-identity.ts";
import { admitKeyHome, openStoreRegistry, registerHarnessStore } from "../../../src/filesystem/self-protection/key-home.ts";
import { emptyKeepOutFacts } from "../../support/keep-out-facts.ts";
import { PRODUCT_NAME, STATE_DIRECTORY_NAME } from "../../../src/kernel/product-identity.ts";
import { keepOutPolicyFor } from "../../../src/filesystem/self-protection/keep-out.ts";
import { legacyInstallIn } from "../../../src/filesystem/database-files.ts";
import { configureDebugSystem, createCollectingSink, getAuditEvents, resetDebugSystem } from "../../../src/shared/debug/debug-system.ts";
import { DEBUG_CONFIG_DEFAULTS } from "../../../src/shared/debug/debug-config.ts";

const NODE_BIN = "/usr/bin/node";

function config(overrides: Partial<SelfProtectionConfig> = {}): SelfProtectionConfig {
  return parseSelfProtectionConfig({ ...DEFAULT_SELF_PROTECTION_CONFIG, enabled: true, ...overrides });
}

/** A harness with a protected `src` holding a file, a project, and a fake home. */
function world(): Readonly<{ harness: string; project: string; home: string; cleanup: () => void }> {
  const harness = realpathSync(createTempDir("refused-harness-"));
  mkdirSync(join(harness, "src"), { recursive: true });
  writeFileSync(join(harness, "src", "owned.ts"), "export const owned = 1;\n");
  const project = realpathSync(createTempDir("refused-project-"));
  const home = realpathSync(createTempDir("refused-home-"));
  mkdirSync(join(home, ".ssh"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  return {
    harness, project, home,
    cleanup: () => {
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
      for (const dir of [harness, project, home]) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** No host facts beyond the floor and an empty registry (a test names its own). */
const NO_HOST = emptyKeepOutFacts();

function refusedWith(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof InputError && error.code === code;
}

test("keep-out: the floor's list is unremovable and an operator's entry only adds", () => {
  const w = world();
  try {
    const floor: readonly string[] = ROOT_POLICY.selfProtection.minimumRefusedPaths;
    for (const home of ["~/.ssh", "~/.claude", "~/.codex", "~/.git-credentials", "~/.config/gh"]) {
      assert.ok(floor.includes(home), `${home} is on the floor`);
    }
    const ssh = join(w.home, ".ssh");
    for (const additionalProtectedSubtrees of [undefined, []]) {
      assert.throws(
        () => compileSelfProtectionConfigToSpec(
          config({ tempDir: w.project, ...(additionalProtectedSubtrees === undefined ? {} : { additionalProtectedSubtrees }), additionalAllowRules: [{ path: ssh, access: ["READ_FILE", "READ_DIR"] }] }),
          w.harness, w.project, NODE_BIN, NO_HOST,
        ),
        refusedWith("self_protection_rule_overlaps_refused_path"),
        `~/.ssh stays refused with additionalProtectedSubtrees=${JSON.stringify(additionalProtectedSubtrees)}`,
      );
    }
    // Every entry that exists reaches the guardian spec, so the binary refuses it too.
    const spec = compileSelfProtectionConfigToSpec(config({ tempDir: w.project }), w.harness, w.project, NODE_BIN, NO_HOST);
    assert.ok((spec.keep_out ?? []).includes(ssh), "~/.ssh is emitted into the spec (keep_out)");
    assert.ok(spec.protected_subtrees.includes(join(w.harness, "src")), "the harness floor is emitted");
    // The home that CONTAINS ~/.ssh is refused too (the other direction).
    assert.throws(
      () => compileSelfProtectionConfigToSpec(config({ tempDir: w.project, additionalAllowRules: [{ path: w.home, access: ["READ_FILE"] }] }), w.harness, w.project, NODE_BIN, NO_HOST),
      refusedWith("self_protection_rule_overlaps_refused_path"),
    );
    const extra = join(w.home, "tokens");
    mkdirSync(extra);
    const allowExtra = config({ tempDir: w.project, additionalAllowRules: [{ path: extra, access: ["READ_FILE"] }] });
    assert.ok(compileSelfProtectionConfigToSpec(allowExtra, w.harness, w.project, NODE_BIN, NO_HOST), "control: an unlisted folder compiles");
    assert.throws(
      () => compileSelfProtectionConfigToSpec(config({ tempDir: w.project, additionalProtectedSubtrees: ["~/tokens"], additionalAllowRules: [{ path: extra, access: ["READ_FILE"] }] }), w.harness, w.project, NODE_BIN, NO_HOST),
      refusedWith("self_protection_rule_overlaps_refused_path"),
      "an operator addition refuses it",
    );
  } finally {
    w.cleanup();
  }
});

test("keep-out: the key home and every registered harness store are refused at any depth, the host's files too", () => {
  const w = world();
  const other = realpathSync(createTempDir("refused-other-checkout-"));
  const keyHome = admitKeyHome(realpathSync(createTempDir("refused-key-home-")), []);
  try {
    // Another checkout TWO levels down, its database registered by identity (no name rule).
    const state = join(other, "work", "checkout", STATE_DIRECTORY_NAME);
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "web.db"), "");
    registerHarnessStore(keyHome, join(state, "web.db"));
    for (const path of [other, join(other, "work"), state, join(state, "web.db"), keyHome]) {
      assert.throws(
        () => compileSelfProtectionConfigToSpec(config({ tempDir: w.project, additionalAllowRules: [{ path, access: ["READ_FILE"] }] }), w.harness, w.project, NODE_BIN, { hostPaths: [], registry: openStoreRegistry(keyHome) }),
        refusedWith("self_protection_rule_overlaps_refused_path"),
        path,
      );
    }
    // A pre-migration copy of the registered database is its family too.
    writeFileSync(join(state, "web.db.pre-v19"), "");
    assert.throws(
      () => compileSelfProtectionConfigToSpec(config({ tempDir: w.project, additionalAllowRules: [{ path: join(state, "web.db.pre-v19"), access: ["READ_FILE"] }] }), w.harness, w.project, NODE_BIN, { hostPaths: [], registry: openStoreRegistry(keyHome) }),
      refusedWith("self_protection_rule_overlaps_refused_path"),
    );
    // …and so is an unrelocated legacy key (and its salt) beside it: the file, not its name, is refused.
    for (const legacy of ["db-key", "db-key.salt"]) {
      writeFileSync(join(state, legacy), "");
      assert.throws(
        () => compileSelfProtectionConfigToSpec(config({ tempDir: w.project, additionalAllowRules: [{ path: join(state, legacy), access: ["READ_FILE"] }] }), w.harness, w.project, NODE_BIN, { hostPaths: [], registry: openStoreRegistry(keyHome) }),
        refusedWith("self_protection_rule_overlaps_refused_path"),
        legacy,
      );
    }
    // Control: a folder beside the store compiles.
    const beside = join(other, "notes");
    mkdirSync(beside);
    assert.ok(compileSelfProtectionConfigToSpec(config({ tempDir: w.project, additionalAllowRules: [{ path: beside, access: ["READ_FILE"] }] }), w.harness, w.project, NODE_BIN, { hostPaths: [], registry: openStoreRegistry(keyHome) }));
    // The host's refused files: a database that exists and its -wal that does not (yet).
    const db = join(w.home, "data", "web.db");
    mkdirSync(join(w.home, "data"));
    writeFileSync(db, "");
    for (const host of [[db], [`${db}-wal`]]) {
      assert.throws(
        () => compileSelfProtectionConfigToSpec(config({ tempDir: w.project, additionalAllowRules: [{ path: join(w.home, "data"), access: ["READ_FILE"] }] }), w.harness, w.project, NODE_BIN, { hostPaths: host, registry: openStoreRegistry(keyHome) }),
        refusedWith("self_protection_rule_overlaps_refused_path"),
        `the folder holding ${host[0]}`,
      );
    }
    // …and the project root itself is a rule: a project holding the database is refused.
    assert.throws(
      () => compileSelfProtectionConfigToSpec(config({ tempDir: w.project }), w.harness, w.project, NODE_BIN, { hostPaths: [join(w.project, "web.db")], registry: openStoreRegistry(keyHome) }),
      refusedWith("self_protection_rule_overlaps_refused_path"),
    );
  } finally {
    rmSync(other, { recursive: true, force: true });
    rmSync(keyHome, { recursive: true, force: true });
    w.cleanup();
  }
});

/** A real SQLite database (a table written, so the file carries its header). */
function sqliteDatabase(path: string): void {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE rows (value TEXT)");
  db.close();
}

test("keep-out: an install STILL KEEPING ITS KEY BESIDE ITS DATABASE is refused with an EMPTY registry (secd-security 1a), down to the bounded depth", () => {
  const w = world();
  const other = realpathSync(createTempDir("refused-unregistered-"));
  try {
    // The old layout: a key-sized `db-key` beside a SQLite database, nothing registered.
    const state = join(other, "a", "checkout", STATE_DIRECTORY_NAME);
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "db-key"), randomBytes(32), { mode: 0o600 });
    sqliteDatabase(join(state, "web.db"));
    const grant = (path: string) => () => compileSelfProtectionConfigToSpec(config({ tempDir: w.project, additionalAllowRules: [{ path, access: ["READ_FILE", "READ_DIR"] }] }), w.harness, w.project, NODE_BIN, NO_HOST);
    // Inside (any depth), and containing it down to `containedSearchDepth` folders.
    const depth = ROOT_POLICY.selfProtection.legacyInstalls.containedSearchDepth;
    assert.equal(depth, 3, "the fixture below is laid out for the declared depth");
    for (const path of [join(state, "db-key"), join(state, "web.db"), state, join(other, "a", "checkout"), join(other, "a"), other]) {
      assert.throws(grant(path), refusedWith("self_protection_rule_overlaps_refused_path"), path);
    }
    // The project root is a grant too.
    assert.throws(() => compileSelfProtectionConfigToSpec(config({ tempDir: join(w.project) }), w.harness, join(other, "a"), NODE_BIN, NO_HOST), refusedWith("self_protection_rule_overlaps_refused_path"));
    // One folder deeper than the bounded look is found only once registered (`db-key scan --apply`).
    const deeper = join(other, "b", "c", "d", "e", STATE_DIRECTORY_NAME);
    mkdirSync(deeper, { recursive: true });
    writeFileSync(join(deeper, "db-key"), randomBytes(32), { mode: 0o600 });
    sqliteDatabase(join(deeper, "web.db"));
    assert.ok(grant(join(other, "b"))(), "past the bounded depth: not found by the look");
    assert.throws(grant(join(other, "b", "c")), refusedWith("self_protection_rule_overlaps_refused_path"), "within it: found");
    // Not an install: a wrong-sized key, or a key beside no database.
    const odd = join(other, "odd");
    mkdirSync(odd);
    writeFileSync(join(odd, "db-key"), "short");
    sqliteDatabase(join(odd, "app.db"));
    assert.ok(grant(odd)(), "a file named db-key that is not key-sized is not a key");
    const lone = join(other, "lone");
    mkdirSync(lone);
    writeFileSync(join(lone, "db-key"), randomBytes(32));
    assert.ok(grant(lone)(), "a key beside no database is not an install");
  } finally {
    rmSync(other, { recursive: true, force: true });
    w.cleanup();
  }
});

test("keep-out: the shape check fails CLOSED past its bounds (sec-e-correctness M-4): fillers never hide the database, a key beside too many files is kept out, a LINKED key is a key, and the folder budget is audited", (t) => {
  const w = world();
  const other = realpathSync(createTempDir("refused-bounds-"));
  resetDebugSystem();
  t.after(resetDebugSystem);
  configureDebugSystem({ ...DEBUG_CONFIG_DEFAULTS, sinks: { enabledSinks: ["collecting"] } }, [createCollectingSink()]);
  try {
    const grant = (path: string) => () => compileSelfProtectionConfigToSpec(config({ tempDir: w.project, additionalAllowRules: [{ path, access: ["READ_FILE", "READ_DIR"] }] }), w.harness, w.project, NODE_BIN, NO_HOST);
    const refused = refusedWith("self_protection_rule_overlaps_refused_path");
    const bound = ROOT_POLICY.selfProtection.legacyInstalls.maximumSiblingsRead;
    const folder = (name: string) => { const path = join(other, name); mkdirSync(path); return path; };
    const fill = (at: string, count: number) => { for (let i = 0; i < count; i += 1) writeFileSync(join(at, `filler-${String(i).padStart(4, "0")}.txt`), ""); };
    // 1. Filler files beside a key and its database: the database-named sibling is read first.
    const crowded = folder("crowded");
    writeFileSync(join(crowded, "db-key"), randomBytes(32), { mode: 0o600 });
    fill(crowded, bound * 3);
    sqliteDatabase(join(crowded, "web.db"));
    assert.deepEqual(legacyInstallIn(crowded)?.databases, [join(crowded, "web.db")], "found past the fillers");
    assert.throws(grant(crowded), refused, "filler files do not admit the install");
    // 2. A key beside exactly `bound` files, none a database, is not an install; one more file
    //    than one look reads is kept out FAIL CLOSED — whatever the extra files are called.
    const full = folder("full");
    writeFileSync(join(full, "db-key"), randomBytes(32), { mode: 0o600 });
    fill(full, bound);
    assert.equal(legacyInstallIn(full), undefined, "within the bound: every sibling read, none a database");
    assert.ok(grant(full)(), "within the bound: a key beside no database compiles");
    writeFileSync(join(full, "one-more.txt"), "");
    assert.deepEqual(legacyInstallIn(full), { key: join(full, "db-key"), databases: [], searchExhausted: true }, "past the bound, no database found: exhausted, never admitted");
    assert.throws(grant(full), refused, "a key beside more files than one look reads is kept out");
    sqliteDatabase(join(full, "store"));
    assert.throws(grant(full), refused, "a database not named like one among them: kept out whichever way the look ends");
    // 3. A key that is a LINK to a key-sized file is a key (followed for its size only).
    const keys = folder("keys");
    writeFileSync(join(keys, "k"), randomBytes(32), { mode: 0o600 });
    writeFileSync(join(keys, "short"), "short");
    const linked = folder("linked");
    symlinkSync(join(keys, "k"), join(linked, "db-key"));
    sqliteDatabase(join(linked, "web.db"));
    assert.throws(grant(linked), refused, "a linked key is recognised");
    for (const [name, target] of [["linked-short", join(keys, "short")], ["linked-dangling", join(keys, "absent")]] as const) {
      const at = folder(name);
      symlinkSync(target, join(at, "db-key"));
      sqliteDatabase(join(at, "web.db"));
      assert.ok(grant(at)(), `${name}: a link to no key-sized file is not a key`);
    }
    // 4. The contained look's folder budget: past it the look stops (the residual registration
    //    closes, as for depth) — AUDITED, never silent.
    const wide = folder("wide");
    for (let i = 0; i <= ROOT_POLICY.selfProtection.legacyInstalls.containedSearchFolders; i += 1) mkdirSync(join(wide, `d${String(i).padStart(5, "0")}`));
    const install = join(wide, "d00000", "state");
    mkdirSync(install);
    writeFileSync(join(install, "db-key"), randomBytes(32), { mode: 0o600 });
    sqliteDatabase(join(install, "web.db"));
    assert.ok(grant(wide)(), "past the folder budget: not found by the look");
    assert.ok(getAuditEvents().some((event) => event.category === "self-protection.legacy-search-budget" && event.context.grant === wide), "the stop is audited, naming the grant");
    assert.throws(grant(join(wide, "d00000")), refused, "found by a narrower grant");
  } finally {
    rmSync(other, { recursive: true, force: true });
    w.cleanup();
  }
});

test("keep-out: store NAMES count only directly inside a home-like folder (secd-design H1): a project's .claude/.npmrc/.docker compile", () => {
  const w = world();
  const outside = realpathSync(createTempDir("refused-home-like-"));
  try {
    for (const name of [".claude", ".docker", ".kube", ".cursor", ".codex", ".gemini"]) mkdirSync(join(w.project, name));
    writeFileSync(join(w.project, ".npmrc"), "registry=https://example.invalid/\n");
    assert.ok(compileSelfProtectionConfigToSpec(config({ tempDir: w.project, additionalAllowRules: [{ path: join(w.project, ".claude"), access: ["READ_FILE"] }] }), w.harness, w.project, NODE_BIN, NO_HOST));
    // Another account's home, copied or mounted anywhere: `<…>/home/<u>/.ssh`.
    const copied = join(outside, "backup", "home", "someone", ".ssh");
    mkdirSync(copied, { recursive: true });
    assert.throws(
      () => compileSelfProtectionConfigToSpec(config({ tempDir: w.project, additionalAllowRules: [{ path: copied, access: ["READ_FILE"] }] }), w.harness, w.project, NODE_BIN, NO_HOST),
      refusedWith("self_protection_rule_overlaps_refused_path"),
    );
  } finally {
    rmSync(outside, { recursive: true, force: true });
    w.cleanup();
  }
});

test("keep-out: a home-like folder INSIDE the served project is its content (sec-e-design M1); a copied home outside it, or in a project inside a store or at a home, stays refused", () => {
  const w = world();
  const outside = realpathSync(createTempDir("refused-served-"));
  try {
    const policy = keepOutPolicyFor(config({ tempDir: w.project }), { ...NO_HOST, harnessRoot: w.harness });
    const project = join(outside, "dotfiles");
    const shapes = ["home/alice/.npmrc", "home/alice/.ssh/config", "test/fixtures/home/user/.docker/config.json", "test/fixtures/home/user/.claude/settings.json", "Users/bob/.kube/dev.yaml"];
    for (const shape of shapes) mkdirSync(join(project, shape, ".."), { recursive: true });
    const served = policy.operation({ servedProject: project });
    for (const shape of shapes) {
      assert.equal(served.verdict(join(project, shape)), undefined, `${shape}: project content`);
      assert.equal(policy.operation().verdict(join(project, shape))?.entry.source, "home", `${shape}: refused where no project is served`);
    }
    // Outside the served project a copied home is still a home.
    const copied = join(outside, "backup", "home", "u", ".ssh", "id_rsa");
    mkdirSync(join(copied, ".."), { recursive: true });
    assert.equal(served.verdict(copied)?.relation, "under", "a copied home beside the project");
    // A project that itself lies inside a named store keeps the arm: its root is below the home, not above it.
    const inside = join(outside, "backup", "home", "u", ".ssh");
    assert.equal(policy.operation({ servedProject: inside }).verdict(copied)?.relation, "under", "a project inside a store");
    // …and so does an old project AT a home (it holds that home's own stores, secc-design M3): a copied home inside it is refused.
    const atHome = join(w.home, "backup", "home", "u", ".npmrc");
    mkdirSync(join(atHome, ".."), { recursive: true });
    assert.equal(policy.operation({ servedProject: w.home }).verdict(atHome)?.entry.source, "home", "a project at a home");
  } finally {
    rmSync(outside, { recursive: true, force: true });
    w.cleanup();
  }
});

test("keep-out: a home entry that is a link to a device (~/.mysql_history -> /dev/null) stores nothing and refuses nothing (secd-security 1c)", () => {
  const w = world();
  try {
    symlinkSync("/dev/null", join(w.home, ".mysql_history"));
    const spec = compileSelfProtectionConfigToSpec(config({ tempDir: w.project }), w.harness, w.project, NODE_BIN, NO_HOST);
    assert.ok(spec.allow_rules.some((rule) => rule.path === "/dev"), "the floor's /dev grant still compiles");
  } finally {
    w.cleanup();
  }
});

test("keep-out: NO temp folder is granted unless the host names a private one (secd-design M1): a store under /tmp refuses nothing", () => {
  const w = world();
  const keyHome = admitKeyHome(realpathSync(createTempDir("refused-tmp-store-keys-")), []);
  const inTemp = realpathSync(createTempDir("refused-tmp-store-"));
  try {
    writeFileSync(join(inTemp, "web.db"), "");
    registerHarnessStore(keyHome, join(inTemp, "web.db"));
    const facts = { hostPaths: [], registry: openStoreRegistry(keyHome) };
    const spec = compileSelfProtectionConfigToSpec(config({}), w.harness, w.project, NODE_BIN, facts);
    assert.equal(spec.temp_dir, undefined, "the system temp folder is never granted by default");
    assert.ok(!spec.allow_rules.some((rule) => rule.path === realpathSync(systemTempRoot())), "nor as a rule");
    // A private per-spawn folder beside the store is fine; the store stays refused.
    const privateTemp = realpathSync(createTempDir("refused-private-temp-"));
    try {
      assert.equal(compileSelfProtectionConfigToSpec(config({ tempDir: privateTemp }), w.harness, w.project, NODE_BIN, facts).temp_dir, privateTemp);
    } finally {
      rmSync(privateTemp, { recursive: true, force: true });
    }
    assert.throws(
      () => compileSelfProtectionConfigToSpec(config({ tempDir: realpathSync(systemTempRoot()) }), w.harness, w.project, NODE_BIN, facts),
      InputError,
      "an operator who names all of /tmp is still refused while a store (or anything kept out) sits there",
    );
  } finally {
    rmSync(inTemp, { recursive: true, force: true });
    rmSync(keyHome, { recursive: true, force: true });
    w.cleanup();
  }
});

test("keep-out: W^X — no executable rule may overlap a writable one, whichever rule it is", () => {
  const w = world();
  try {
    const tool = join(w.project, "bin");
    mkdirSync(tool);
    // An operator read+execute rule inside the (writable) project.
    assert.throws(
      () => compileSelfProtectionConfigToSpec(config({ tempDir: w.project, additionalAllowRules: [{ path: tool, access: ["READ_FILE", "READ_DIR", "EXECUTE"] }] }), w.harness, w.project, NODE_BIN, NO_HOST),
      refusedWith("self_protection_execute_overlaps_writable"),
    );
    // The node binary (EXECUTE) placed inside the writable temp directory.
    const temp = realpathSync(createTempDir("refused-temp-"));
    try {
      const node = join(temp, "node");
      writeFileSync(node, "");
      assert.throws(
        () => compileSelfProtectionConfigToSpec(config({ tempDir: temp }), w.harness, w.project, node, NO_HOST),
        refusedWith("self_protection_execute_overlaps_writable"),
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
    // The same path named twice — once writable, once executable — MERGES its
    // access (a first-wins dedup dropped EXECUTE and hid this very violation).
    const shared = join(w.home, "tools");
    mkdirSync(shared);
    assert.throws(
      () => compileSelfProtectionConfigToSpec(config({ tempDir: w.project, additionalAllowRules: [
        { path: shared, access: ["READ_FILE", "WRITE_FILE"] },
        { path: shared, access: ["READ_FILE", "EXECUTE"] },
      ] }), w.harness, w.project, NODE_BIN, NO_HOST),
      refusedWith("self_protection_execute_overlaps_writable"),
    );
    // Control: an executable rule outside every writable rule compiles.
    assert.ok(compileSelfProtectionConfigToSpec(config({ tempDir: w.project, additionalAllowRules: [{ path: "/usr/local", access: ["READ_FILE", "EXECUTE"] }] }), w.harness, w.project, NODE_BIN, NO_HOST));
  } finally {
    w.cleanup();
  }
});

const UNSHARE_AVAILABLE = spawnSync("unshare", ["-rm", "true"]).status === 0;

test("keep-out: a bind-mount alias is the same location (identity, not spelling)", () => {
  // A capability this test needs, never a reason to skip it (UR-20): a host
  // without unprivileged user namespaces cannot prove the alias, and says so.
  assert.ok(UNSHARE_AVAILABLE, "`unshare -rm` is unavailable on this host: the keep-out alias proof needs unprivileged user and mount namespaces");
  const w = world();
  const aliasRoot = realpathSync(createTempDir("refused-alias-"));
  try {
    // A private mount namespace: `<aliasRoot>/view` becomes a second spelling of `/` scoped subtree `w.home`.
    const view = join(aliasRoot, "view");
    mkdirSync(view);
    const probe = fileURLToPath(new URL("../../support/refused-alias-probe.ts", import.meta.url));
    const result = spawnSync("unshare", ["-rm", "sh", "-c", 'mount --bind "$1" "$2" && exec "$3" --no-warnings "$4"', "sh", w.home, view, process.execPath, probe], {
      encoding: "utf8",
      env: { ...process.env, HOME: w.home, REFUSED_ALIAS_VIEW: view, REFUSED_ALIAS_HARNESS: w.harness, REFUSED_ALIAS_PROJECT: w.project },
    });
    assert.equal(result.status, 0, result.stderr);
    const verdicts = JSON.parse(result.stdout) as Record<string, string>;
    assert.deepEqual(verdicts, {
      sameIdentity: "true",
      stringCompareSeesNothing: "true",
      aliasOfSsh: "self_protection_rule_overlaps_refused_path",
      aliasOfHome: "self_protection_rule_overlaps_refused_path",
      aliasOfProtectedSrc: "self_protection_allow_rule_under_protected_subtree",
      aliasOfProjectExecutable: "self_protection_execute_overlaps_writable",
    });
  } finally {
    rmSync(aliasRoot, { recursive: true, force: true });
    w.cleanup();
  }
});

test("keep-out: identity overlap answers for missing paths by their existing anchor", () => {
  const w = world();
  try {
    const identity = identityOverlapIndex();
    const missing = resolveLocation(join(w.home, ".codex", "auth.json"));
    assert.equal(identity.atOrUnder(missing, resolveLocation(join(w.home, ".codex"))), true, "under a missing ancestor, by tail");
    assert.equal(identity.overlaps(resolveLocation(w.home), resolveLocation(join(w.home, ".codex"))), true, "a home contains its missing .codex");
    assert.equal(identity.overlaps(resolveLocation(join(w.home, ".ssh")), resolveLocation(join(w.home, ".codex"))), false, "siblings do not overlap");
    assert.equal(identity.atOrUnder(resolveLocation(join(w.home, ".codexx")), resolveLocation(join(w.home, ".codex"))), false, "a name prefix is not a parent");
  } finally {
    w.cleanup();
  }
});

test("keep-out: a `~/.local/state/<product>-*` folder holding ANY of the host's harness code is the harness's installation, not a refused entry", () => {
  const w = world();
  try {
    // A candidate checkout under the state folder whose web server code the host names (the harness root elsewhere,
    // as when a test points the config at a scratch folder): its folder is not refused wholesale; a sibling is.
    const own = join(w.home, ".local", "state", `${PRODUCT_NAME}-candidate`);
    const sibling = join(w.home, ".local", "state", `${PRODUCT_NAME}-backup`);
    mkdirSync(join(own, "repo", "server"), { recursive: true });
    mkdirSync(sibling, { recursive: true });
    mkdirSync(join(own, "repo", "notes"));
    const policy = keepOutPolicyFor(config({ tempDir: w.project }), { ...NO_HOST, harnessRoot: w.harness, harnessPaths: [join(own, "repo", "server")] });
    assert.equal(policy.verdict(join(own, "repo", "notes")), undefined, "the folder holding the host's harness code is not refused wholesale");
    assert.equal(policy.verdict(join(own, "repo", "server"))?.entry.source, "harness", "its harness code is the harness's");
    assert.equal(policy.verdict(sibling)?.entry.source, "home", "an unrelated state folder of the product still is");
    assert.equal(policy.verdict(join(w.home, ".local", "state", `${PRODUCT_NAME}-created-later`, "x"))?.relation, "under", "one created after the list was built too (a prefix, not a listing)");
  } finally {
    w.cleanup();
  }
});
