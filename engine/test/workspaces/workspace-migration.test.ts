import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createHash } from "node:crypto";

import { migrateWorkspaceRecord, OLDER_WORKSPACE_SCHEMA_VERSIONS, WORKSPACE_SCHEMA_VERSION, type OlderWorkspaceSchemaVersion } from "../../src/workflow/workspace-contracts.ts";
import { createWorkspaceRecordStore, workspaceRecordStores, type WorkspaceRecordStores } from "../../src/workflow/workspace-registry.ts";
import { commitFile, initTempRepo, makeManager, makeTestConfig, mkWorkspaceTempDir, rawGit, registryOf } from "./workspace-test-support.ts";

/**
 * THE ONE MIGRATION CHAIN v2 → v3 → v4 of stored workspace records and
 * PER-VERSION STORAGE, over REAL v2 records (copied from a host's registry:
 * arrays trimmed, home paths replaced, no credential) and v3 records this
 * code's own workspaces turned into the v3 shape: every shape the host held —
 * read-only and feature, active, aborted, quarantined, merged with its
 * receipt, an overlay — is read and migrated in memory by the one record
 * reader and NEVER rewritten (older code still reads its own store); a
 * workspace only an older store knows is read-only here; every verb that
 * lists the registry (create's admission, list, sweep) works beside them.
 */

const [WORKSPACE_SCHEMA_V3, WORKSPACE_SCHEMA_V2] = OLDER_WORKSPACE_SCHEMA_VERSIONS;
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "v2-records");
const fixtureNames = readdirSync(FIXTURES).filter((name) => name.endsWith(".json")).toSorted();
const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as Record<string, unknown>;

/** Matches a HarnessError by its typed code. */
function throwsCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof Error && (error as { code?: unknown }).code === code;
}

test("the fixtures are real v2 records of every shape the host held", () => {
  assert.ok(fixtureNames.length >= 5);
  const shapes = fixtureNames.map((name) => {
    const record = fixture(name) as { schemaVersion: string; state: string; lease: { kind: string; overlay: unknown }; mergeReceipt: unknown };
    assert.equal(record.schemaVersion, "bridlewise-workspace/v2", name);
    return `${record.state}/${record.lease.kind}${record.lease.overlay === null ? "" : "/overlay"}${record.mergeReceipt === null ? "" : "/receipt"}`;
  });
  for (const wanted of ["active/read-only", "active/feature", "merged/feature/receipt", "quarantined/feature/overlay"]) {
    assert.ok(shapes.includes(wanted), `a ${wanted} record is among the fixtures (${shapes.join(", ")})`);
  }
});

test("a v2 record migrates deterministically: re-tagged, the forge state null (read-only) or the legacy marker (feature), a receipt kept verbatim", () => {
  for (const name of fixtureNames) {
    const raw = fixture(name) as { lease: { kind: string }; mergeReceipt: Record<string, unknown> | null; revision: number; history: unknown };
    const { record, migrated } = migrateWorkspaceRecord(raw);
    assert.equal(migrated, true, name);
    assert.equal(record.schemaVersion, WORKSPACE_SCHEMA_VERSION);
    assert.equal(record.lease.schemaVersion, WORKSPACE_SCHEMA_VERSION);
    if (record.validationReport !== null) assert.equal(record.validationReport.schemaVersion, WORKSPACE_SCHEMA_VERSION);
    assert.deepEqual(record.forge, raw.lease.kind === "read-only" ? null : { legacy: true }, name);
    assert.deepEqual(record.mergeReceipt, raw.mergeReceipt, `${name}: the receipt is kept as it was written (its hash binds its version)`);
    assert.equal(record.revision, raw.revision, "the same record: its revision is unchanged");
    assert.deepEqual(record.history, raw.history);
    assert.deepEqual(migrateWorkspaceRecord(raw), { record, migrated: true }, "deterministic");
    assert.deepEqual(migrateWorkspaceRecord(JSON.parse(JSON.stringify(record))), { record, migrated: false }, "a migrated record is current");
  }
  assert.throws(() => migrateWorkspaceRecord({ ...fixture(fixtureNames[0]!), schemaVersion: "bridlewise-workspace/v1" }), throwsCode("workspace_record_invalid"));
  assert.throws(() => migrateWorkspaceRecord({ ...fixture(fixtureNames[0]!), schemaVersion: "bridlewise-workspace/v9" }), throwsCode("workspace_record_invalid"));
  assert.throws(() => migrateWorkspaceRecord({ ...fixture(fixtureNames[0]!), unexpected: 1 }), throwsCode("workspace_record_invalid"), "a v2 record is still a closed shape");
});

/** The v3 shape of a current (v4) record: re-tagged, its forge state without `land` (what a v3 checkout wrote). */
function asV3(v4: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const retag = (part: unknown): unknown => (part !== null && typeof part === "object" ? { ...part, schemaVersion: WORKSPACE_SCHEMA_V3 } : part);
  const forge = v4["forge"] as Readonly<Record<string, unknown>> | null;
  const { land: _land, ...v3Forge } = forge ?? {};
  return { ...v4, schemaVersion: WORKSPACE_SCHEMA_V3, lease: retag(v4["lease"]), validationReport: retag(v4["validationReport"]), conflictReport: retag(v4["conflictReport"]), forge: forge === null ? null : v3Forge };
}

/** The v2 shape of a current (v4) record: re-tagged, no forge state at all. */
function asV2(v4: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const { forge: _forge, ...rest } = asV3(v4);
  const retag = (part: unknown): unknown => (part !== null && typeof part === "object" ? { ...part, schemaVersion: WORKSPACE_SCHEMA_V2 } : part);
  return { ...rest, schemaVersion: WORKSPACE_SCHEMA_V2, lease: retag(rest["lease"]), validationReport: retag(rest["validationReport"]), conflictReport: retag(rest["conflictReport"]) };
}

/** The folder of the older store of `version`. */
function olderStore(stores: WorkspaceRecordStores, version: OlderWorkspaceSchemaVersion): string {
  return stores.older.find((store) => store.version === version)!.directory;
}

test("THE CHAIN: a v3 record migrates through the same reader — re-tagged, its forge state kept with no land in flight, a v3 receipt kept verbatim — and a v2 record reaches v4 through v3", () => {
  for (const name of fixtureNames) {
    const v2 = fixture(name);
    const viaChain = migrateWorkspaceRecord(v2).record;
    const v3 = migrateWorkspaceRecord(asV3(viaChain as unknown as Record<string, unknown>));
    assert.deepEqual(v3, { record: viaChain, migrated: true }, `${name}: v2 → v4 is v2 → v3 → v4`);
  }
  const forge = { remote: "origin", trunk: "main", pullRequest: { number: 7, url: "https://forge.test/pull/7" }, publishedHead: "a".repeat(40), ready: true };
  const feature = migrateWorkspaceRecord(fixture("active-feature.json")).record as unknown as Record<string, unknown>;
  const published = migrateWorkspaceRecord({ ...asV3(feature), forge });
  assert.equal(published.migrated, true);
  assert.deepEqual(published.record.forge, { ...forge, land: null });
  assert.throws(() => migrateWorkspaceRecord({ ...asV3(feature), forge: { ...forge, land: { head: "a".repeat(40) } } }), throwsCode("workspace_record_invalid"), "a v3 record never carried a land: it is a closed shape");
  assert.throws(() => migrateWorkspaceRecord({ ...asV3(feature), forge: null }), throwsCode("workspace_record_invalid"), "a v3 feature record has a forge state");
});

/** Each file of `directory` with the sha256 of its bytes. */
function fileDigests(directory: string): ReadonlyMap<string, string> {
  return new Map(readdirSync(directory).toSorted().map((name) => [name, createHash("sha256").update(readFileSync(join(directory, name))).digest("hex")]));
}

test("PER-VERSION STORAGE: v2 records are read and migrated in memory and are READ-ONLY: a save is refused naming the owner, no current twin is made, every v2 file stays byte-identical", () => {
  const root = mkWorkspaceTempDir("ws-migrate-stores");
  const stores: WorkspaceRecordStores = { current: join(root, "workspaces-v4"), older: [{ version: WORKSPACE_SCHEMA_V3, directory: join(root, "workspaces-v3") }, { version: WORKSPACE_SCHEMA_V2, directory: join(root, "workspaces") }] };
  const legacy = olderStore(stores, WORKSPACE_SCHEMA_V2);
  mkdirSync(legacy, { recursive: true });
  for (const name of fixtureNames) copyFileSync(join(FIXTURES, name), join(legacy, `${String(fixture(name)["workspaceId"])}.json`));
  const before = fileDigests(legacy);
  const store = createWorkspaceRecordStore(stores);
  const listed = store.list();
  assert.equal(listed.length, fixtureNames.length);
  assert.ok(listed.every((record) => record.schemaVersion === WORKSPACE_SCHEMA_VERSION));
  assert.ok(listed.every((record) => store.olderRecord(record.workspaceId)?.path === join(legacy, `${record.workspaceId}.json`)));
  for (const record of listed) {
    assert.throws(() => store.save({ ...record, abortReason: "touched by the new code" }), (error: unknown) =>
      throwsCode("workspace_owned_by_v2_checkout")(error) && String((error as Error).message).includes(join(legacy, `${record.workspaceId}.json`)), `${record.workspaceId}: the refusal names the owner's record`);
  }
  assert.deepEqual(readdirSync(stores.current).filter((entry) => entry.endsWith(".json")), [], "no current twin was made");
  assert.deepEqual(fileDigests(legacy), before, "every v2 file is byte-identical: older code reads them as they were");
  // Each store holds only its own version: a planted v2 file in the current or the v3 store is refused, never silently migrated.
  const planted = String(fixture(fixtureNames[0]!)["workspaceId"]);
  copyFileSync(join(FIXTURES, fixtureNames[0]!), join(stores.current, `${planted}.json`));
  assert.throws(() => store.load(planted), throwsCode("workspace_record_invalid"));
  rmSync(join(stores.current, `${planted}.json`));
  mkdirSync(olderStore(stores, WORKSPACE_SCHEMA_V3), { recursive: true });
  copyFileSync(join(FIXTURES, fixtureNames[0]!), join(olderStore(stores, WORKSPACE_SCHEMA_V3), `${planted}.json`));
  assert.throws(() => store.load(planted), throwsCode("workspace_record_invalid"), "the v3 store is read before the v2 one, and holds only v3 records");
});

/** A REAL older workspace: made by this code (a worktree and a branch), then its record turned into the older shape and moved to that version's store — what a checkout of the older version left. */
async function realOlderWorkspace(prefix: string, version: OlderWorkspaceSchemaVersion) {
  const { root } = initTempRepo(prefix);
  const stores = workspaceRecordStores(registryOf(root));
  const { manager } = makeManager(root, { config: makeTestConfig(mkWorkspaceTempDir(`${prefix}-wt`)) });
  const made = await manager.create({ agentName: "older", mode: "feature", writeSet: ["src/older"] });
  commitFile(made.lease.worktreePath, "src/older/a.ts", "export const a = 1;\n");
  const current = JSON.parse(readFileSync(join(stores.current, `${made.workspaceId}.json`), "utf8")) as Record<string, unknown>;
  const directory = olderStore(stores, version);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${made.workspaceId}.json`), `${JSON.stringify(version === WORKSPACE_SCHEMA_V2 ? asV2(current) : asV3(current))}\n`);
  rmSync(join(stores.current, `${made.workspaceId}.json`));
  return { root, stores, directory, manager, made };
}

/** An older version's workspace is read-only here (see the two tests below). */
async function olderWorkspaceIsReadOnly(version: OlderWorkspaceSchemaVersion, code: string): Promise<void> {
  const { root, stores, directory, manager, made } = await realOlderWorkspace(`ws-${version.slice(-2)}-readonly`, version);
  const olderPath = join(directory, `${made.workspaceId}.json`);
  const before = fileDigests(directory);
  const branchTip = rawGit(root, ["rev-parse", made.lease.branch!]);
  assert.equal(manager.status(made.workspaceId).state, "active", "it is read");
  const refused = (error: unknown): boolean => throwsCode(code)(error) && String((error as Error).message).includes(olderPath) && String((error as Error).message).includes(made.lease.worktreePath);
  // The reviewer's case: an abort from a newer version used to delete the worktree.
  await assert.rejects(() => manager.abort(made.workspaceId), refused, "abort");
  await assert.rejects(() => manager.abort(made.workspaceId, { quarantine: true }), refused, "abort --quarantine");
  await assert.rejects(() => manager.extend(made.workspaceId, ["src/more"]), refused, "extend");
  await assert.rejects(() => manager.validate(made.workspaceId), refused, "validate");
  await assert.rejects(() => manager.publish(made.workspaceId), refused, "publish");
  await assert.rejects(() => manager.ready(made.workspaceId), refused, "ready");
  await assert.rejects(() => manager.land(made.workspaceId), refused, "land");
  await assert.rejects(() => manager.merge(made.workspaceId), refused, "merge");
  await assert.rejects(() => manager.recover(made.workspaceId), refused, "recover");
  assert.throws(() => manager.snapshot(made.workspaceId, "probe"), refused, "snapshot");
  assert.ok(existsSync(made.lease.worktreePath), "the worktree is intact");
  assert.equal(rawGit(root, ["rev-parse", made.lease.branch!]), branchTip, "the branch is intact");
  assert.equal(rawGit(made.lease.worktreePath, ["status", "--porcelain"]), "", "the worktree is as it was");
  assert.deepEqual(fileDigests(directory), before, "the older record is byte-identical");
  assert.equal(existsSync(join(stores.current, `${made.workspaceId}.json`)), false, "no current twin");
  // A sweep with its lease expired still never ends it.
  const later = makeManager(root, { config: makeTestConfig(mkWorkspaceTempDir(`ws-${version.slice(-2)}-readonly-later`)), now: () => new Date(Date.now() + 10 * 86_400_000) }).manager;
  assert.deepEqual((await later.sweep()).swept, []);
  assert.ok(existsSync(made.lease.worktreePath));
  assert.deepEqual(fileDigests(directory), before);
}

test("a v2-only workspace is read-only to every saving or destructive verb: abort, extend, validate, publish, ready, land, merge, recover and snapshot refuse BEFORE touching anything; the worktree, the branch and the v2 record stay intact", async () => {
  await olderWorkspaceIsReadOnly(WORKSPACE_SCHEMA_V2, "workspace_owned_by_v2_checkout");
});

test("a v3-only workspace is read-only the same way (workspace_owned_by_v3_checkout): its worktree, its branch and its v3 record stay intact", async () => {
  await olderWorkspaceIsReadOnly(WORKSPACE_SCHEMA_V3, "workspace_owned_by_v3_checkout");
});

test("create, list and sweep work beside a registry of v2 records, which they never write; a live v3 workspace whose worktree is gone is reported by the sweep, not dropped", async () => {
  const { root } = initTempRepo("ws-migrate-registry");
  const stores = workspaceRecordStores(registryOf(root));
  const legacyStore = olderStore(stores, WORKSPACE_SCHEMA_V2);
  mkdirSync(legacyStore, { recursive: true });
  for (const name of fixtureNames) copyFileSync(join(FIXTURES, name), join(legacyStore, `${String(fixture(name)["workspaceId"])}.json`));
  const before = fileDigests(legacyStore);
  const { manager } = makeManager(root, { config: makeTestConfig(mkWorkspaceTempDir("ws-migrate-registry-wt")) });
  assert.equal(manager.list().length, fixtureNames.length, "list reads every record");
  const created = await manager.create({ agentName: "fresh", mode: "feature", writeSet: ["src/fresh"] });
  assert.equal(created.state, "active", "admission reads every record");
  const legacy = manager.list().find((record) => record.forge !== null && "legacy" in record.forge && record.state === "active")!;
  await assert.rejects(() => manager.publish(legacy.workspaceId), throwsCode("workspace_owned_by_v2_checkout"));

  const orphan = await manager.create({ agentName: "orphan", mode: "feature", writeSet: ["src/orphan"] });
  commitFile(orphan.lease.worktreePath, "src/orphan/a.ts", "export const a = 1;\n");
  rmSync(orphan.lease.worktreePath, { recursive: true, force: true });
  const swept = await manager.sweep();
  assert.ok(swept.orphaned.includes(orphan.workspaceId), "the sweep reports the orphan");
  assert.equal(manager.status(orphan.workspaceId).state, "active", "and leaves it to its owner");
  assert.ok(!swept.orphaned.includes(created.workspaceId), "a live workspace with its worktree is no orphan");
  assert.ok(!swept.swept.some((id) => before.has(`${id}.json`)), "the sweep never ends a v2 workspace: older code owns it until the P7 cutover");
  assert.deepEqual(fileDigests(legacyStore), before, "after create, list, publish, sweep: every v2 file is byte-identical");
  assert.deepEqual(readdirSync(stores.current).filter((entry) => entry.endsWith(".json")).toSorted(), [`${created.workspaceId}.json`, `${orphan.workspaceId}.json`].toSorted(), "only this code's records are in the current store");
  writeFileSync(join(legacyStore, "README.txt"), "not a record\n");
  assert.equal(manager.list().length, fixtureNames.length + 2, "only records are read");
});
