import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createHash } from "node:crypto";

import { migrateWorkspaceRecord, WORKSPACE_SCHEMA_VERSION } from "../../src/workflow/workspace-contracts.ts";
import { createWorkspaceRecordStore, workspaceRecordStores } from "../../src/workflow/workspace-registry.ts";
import { commitFile, initTempRepo, makeManager, makeTestConfig, mkWorkspaceTempDir, rawGit, registryOf } from "./workspace-test-support.ts";

/**
 * THE v2 → v3 MIGRATION of stored workspace records and PER-VERSION
 * STORAGE, over REAL v2 records (copied from a host's registry: arrays
 * trimmed, home paths replaced, no credential): every shape the host held —
 * read-only and feature, active, aborted, quarantined, merged with its
 * receipt, an overlay — is read and migrated in memory by the one record
 * reader and NEVER rewritten (older code still reads the v2 store); a changed
 * one is a new record in the current store; every verb that lists the
 * registry (create's admission, list, sweep) works beside them.
 */

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

/** Each file of `directory` with the sha256 of its bytes. */
function fileDigests(directory: string): ReadonlyMap<string, string> {
  return new Map(readdirSync(directory).toSorted().map((name) => [name, createHash("sha256").update(readFileSync(join(directory, name))).digest("hex")]));
}

test("PER-VERSION STORAGE: v2 records are read and migrated in memory and are READ-ONLY: a save is refused naming the owner, no v3 twin is made, every v2 file stays byte-identical", () => {
  const legacy = mkWorkspaceTempDir("ws-migrate-legacy");
  const current = join(mkWorkspaceTempDir("ws-migrate-current"), "workspaces-v3");
  for (const name of fixtureNames) copyFileSync(join(FIXTURES, name), join(legacy, `${String(fixture(name)["workspaceId"])}.json`));
  const before = fileDigests(legacy);
  const store = createWorkspaceRecordStore({ current, legacy });
  const listed = store.list();
  assert.equal(listed.length, fixtureNames.length);
  assert.ok(listed.every((record) => record.schemaVersion === WORKSPACE_SCHEMA_VERSION));
  assert.ok(listed.every((record) => store.legacyRecordPath(record.workspaceId) === join(legacy, `${record.workspaceId}.json`)));
  for (const record of listed) {
    assert.throws(() => store.save({ ...record, abortReason: "touched by the new code" }), (error: unknown) =>
      throwsCode("workspace_owned_by_v2_checkout")(error) && String((error as Error).message).includes(join(legacy, `${record.workspaceId}.json`)), `${record.workspaceId}: the refusal names the owner's record`);
  }
  assert.deepEqual(readdirSync(current).filter((entry) => entry.endsWith(".json")), [], "no v3 twin was made");
  assert.deepEqual(fileDigests(legacy), before, "every v2 file is byte-identical: older code reads them as they were");
  // The current store holds only current records: a planted v2 file there is refused, never silently migrated.
  copyFileSync(join(FIXTURES, fixtureNames[0]!), join(current, `${String(fixture(fixtureNames[0]!)["workspaceId"])}.json`));
  assert.throws(() => store.load(String(fixture(fixtureNames[0]!)["workspaceId"])), throwsCode("workspace_record_invalid"));
});

/** A REAL v2 workspace: made by this code (a worktree and a branch), then its record turned into the v2 shape and moved to the legacy store — what a checkout of the older version left. */
async function realV2Workspace(prefix: string) {
  const { root } = initTempRepo(prefix);
  const stores = workspaceRecordStores(registryOf(root));
  const { manager } = makeManager(root, { config: makeTestConfig(mkWorkspaceTempDir(`${prefix}-wt`)) });
  const made = await manager.create({ agentName: "older", mode: "feature", writeSet: ["src/older"] });
  commitFile(made.lease.worktreePath, "src/older/a.ts", "export const a = 1;\n");
  const v3 = JSON.parse(readFileSync(join(stores.current, `${made.workspaceId}.json`), "utf8")) as Record<string, unknown>;
  const { forge: _forge, ...rest } = v3;
  const v2 = { ...rest, schemaVersion: "bridlewise-workspace/v2", lease: { ...(v3["lease"] as Record<string, unknown>), schemaVersion: "bridlewise-workspace/v2" } };
  mkdirSync(stores.legacy, { recursive: true });
  writeFileSync(join(stores.legacy, `${made.workspaceId}.json`), `${JSON.stringify(v2)}\n`);
  rmSync(join(stores.current, `${made.workspaceId}.json`));
  return { root, stores, manager, made };
}

test("a v2-only workspace is read-only to every saving or destructive verb: abort, extend, validate, publish, ready, merge, recover and snapshot refuse BEFORE touching anything; the worktree, the branch and the v2 record stay intact", async () => {
  const { root, stores, manager, made } = await realV2Workspace("ws-v2-readonly");
  const v2Path = join(stores.legacy, `${made.workspaceId}.json`);
  const before = fileDigests(stores.legacy);
  const branchTip = rawGit(root, ["rev-parse", made.lease.branch!]);
  assert.equal(manager.status(made.workspaceId).state, "active", "it is read");
  const refused = (error: unknown): boolean => throwsCode("workspace_owned_by_v2_checkout")(error) && String((error as Error).message).includes(v2Path) && String((error as Error).message).includes(made.lease.worktreePath);
  // The reviewer's case: an abort from v3 used to delete the worktree.
  assert.throws(() => manager.abort(made.workspaceId), refused, "abort");
  assert.throws(() => manager.abort(made.workspaceId, { quarantine: true }), refused, "abort --quarantine");
  await assert.rejects(() => manager.extend(made.workspaceId, ["src/more"]), refused, "extend");
  await assert.rejects(() => manager.validate(made.workspaceId), refused, "validate");
  await assert.rejects(() => manager.publish(made.workspaceId), refused, "publish");
  await assert.rejects(() => manager.ready(made.workspaceId), refused, "ready");
  await assert.rejects(() => manager.merge(made.workspaceId), refused, "merge");
  await assert.rejects(() => manager.recover(made.workspaceId), refused, "recover");
  assert.throws(() => manager.snapshot(made.workspaceId, "probe"), refused, "snapshot");
  assert.ok(existsSync(made.lease.worktreePath), "the worktree is intact");
  assert.equal(rawGit(root, ["rev-parse", made.lease.branch!]), branchTip, "the branch is intact");
  assert.equal(rawGit(made.lease.worktreePath, ["status", "--porcelain"]), "", "the worktree is as it was");
  assert.deepEqual(fileDigests(stores.legacy), before, "the v2 record is byte-identical");
  assert.equal(existsSync(join(stores.current, `${made.workspaceId}.json`)), false, "no v3 twin");
  // A sweep with its lease expired still never ends it.
  const later = makeManager(root, { config: makeTestConfig(mkWorkspaceTempDir("ws-v2-readonly-later")), now: () => new Date(Date.now() + 10 * 86_400_000) }).manager;
  assert.deepEqual((await later.sweep()).swept, []);
  assert.ok(existsSync(made.lease.worktreePath));
  assert.deepEqual(fileDigests(stores.legacy), before);
});

test("create, list and sweep work beside a registry of v2 records, which they never write; a live v3 workspace whose worktree is gone is reported by the sweep, not dropped", async () => {
  const { root } = initTempRepo("ws-migrate-registry");
  const stores = workspaceRecordStores(registryOf(root));
  mkdirSync(stores.legacy, { recursive: true });
  for (const name of fixtureNames) copyFileSync(join(FIXTURES, name), join(stores.legacy, `${String(fixture(name)["workspaceId"])}.json`));
  const before = fileDigests(stores.legacy);
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
  assert.deepEqual(fileDigests(stores.legacy), before, "after create, list, publish, sweep: every v2 file is byte-identical");
  assert.deepEqual(readdirSync(stores.current).filter((entry) => entry.endsWith(".json")).toSorted(), [`${created.workspaceId}.json`, `${orphan.workspaceId}.json`].toSorted(), "only this code's records are in the current store");
  writeFileSync(join(stores.legacy, "README.txt"), "not a record\n");
  assert.equal(manager.list().length, fixtureNames.length + 2, "only records are read");
});
