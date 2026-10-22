import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createHash } from "node:crypto";

import { LEGACY_WORKSPACE_SCHEMA_VERSION, migrateWorkspaceRecord, WORKSPACE_SCHEMA_VERSION } from "../../src/workflow/workspace-contracts.ts";
import { createWorkspaceRecordStore, workspaceRecordStores } from "../../src/workflow/workspace-registry.ts";
import { commitFile, initTempRepo, makeManager, makeTestConfig, mkWorkspaceTempDir, registryOf } from "./workspace-test-support.ts";

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
    assert.equal(record.migratedFrom, null, "the origin is noted only when a v3 record is written from it");
  }
  assert.throws(() => migrateWorkspaceRecord({ ...fixture(fixtureNames[0]!), schemaVersion: "bridlewise-workspace/v1" }), throwsCode("workspace_record_invalid"));
  assert.throws(() => migrateWorkspaceRecord({ ...fixture(fixtureNames[0]!), schemaVersion: "bridlewise-workspace/v9" }), throwsCode("workspace_record_invalid"));
  assert.throws(() => migrateWorkspaceRecord({ ...fixture(fixtureNames[0]!), unexpected: 1 }), throwsCode("workspace_record_invalid"), "a v2 record is still a closed shape");
});

/** Each file of `directory` with the sha256 of its bytes. */
function fileDigests(directory: string): ReadonlyMap<string, string> {
  return new Map(readdirSync(directory).toSorted().map((name) => [name, createHash("sha256").update(readFileSync(join(directory, name))).digest("hex")]));
}

test("PER-VERSION STORAGE: v2 records are read and migrated in memory, never rewritten; a changed one becomes a NEW v3 record noting its origin; the v2 files stay byte-identical", () => {
  const legacy = mkWorkspaceTempDir("ws-migrate-legacy");
  const current = join(mkWorkspaceTempDir("ws-migrate-current"), "workspaces-v3");
  for (const name of fixtureNames) copyFileSync(join(FIXTURES, name), join(legacy, `${String(fixture(name)["workspaceId"])}.json`));
  const before = fileDigests(legacy);
  const store = createWorkspaceRecordStore({ current, legacy });
  const listed = store.list();
  assert.equal(listed.length, fixtureNames.length);
  assert.ok(listed.every((record) => record.schemaVersion === WORKSPACE_SCHEMA_VERSION && record.migratedFrom === null));
  assert.ok(listed.every((record) => store.isLegacyOnly(record.workspaceId)));
  assert.deepEqual(readdirSync(current), [], "reading wrote nothing");
  assert.deepEqual(fileDigests(legacy), before, "every v2 file is byte-identical: older code reads them as they were");

  // A change of a legacy workspace is a NEW record in the current store; the v2 file is untouched.
  const active = listed.find((record) => record.state === "active" && record.lease.kind === "feature")!;
  const saved = store.save({ ...active, abortReason: "touched by the new code" });
  assert.equal(saved.revision, active.revision + 1);
  assert.deepEqual(saved.migratedFrom, { schemaVersion: LEGACY_WORKSPACE_SCHEMA_VERSION, revision: active.revision });
  assert.deepEqual(readdirSync(current).filter((entry) => entry.endsWith(".json")), [`${active.workspaceId}.json`]);
  assert.deepEqual(fileDigests(legacy), before, "the v2 file is still byte-identical after the save");
  assert.deepEqual(store.load(active.workspaceId), saved, "the current record wins from now on");
  assert.equal(store.isLegacyOnly(active.workspaceId), false);
  assert.equal(store.list().length, fixtureNames.length, "no workspace is listed twice");
  // A stale revision of the legacy view is refused (the current record moved on).
  assert.throws(() => store.save(active), throwsCode("workspace_record_changed"));
  // A second save keeps its origin note.
  assert.deepEqual(store.save({ ...saved, abortReason: "again" }).migratedFrom, saved.migratedFrom);
  // The current store holds only current records: a planted v2 file there is refused, never silently migrated.
  copyFileSync(join(FIXTURES, fixtureNames[0]!), join(current, `${String(fixture(fixtureNames[0]!)["workspaceId"])}.json`));
  assert.throws(() => store.load(String(fixture(fixtureNames[0]!)["workspaceId"])), throwsCode("workspace_record_invalid"));
});

test("create, list and sweep work beside a registry of v2 records, which they never write; a legacy feature workspace refuses the forge; a live workspace whose worktree is gone is reported by the sweep, not dropped", async () => {
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
  await assert.rejects(() => manager.publish(legacy.workspaceId), throwsCode("workspace_legacy_record"));

  const orphan = await manager.create({ agentName: "orphan", mode: "feature", writeSet: ["src/orphan"] });
  commitFile(orphan.lease.worktreePath, "src/orphan/a.ts", "export const a = 1;\n");
  rmSync(orphan.lease.worktreePath, { recursive: true, force: true });
  const swept = await manager.sweep();
  assert.ok(swept.orphaned.includes(orphan.workspaceId), "the sweep reports the orphan");
  assert.equal(manager.status(orphan.workspaceId).state, "active", "and leaves it to its owner");
  assert.ok(!swept.orphaned.includes(created.workspaceId), "a live workspace with its worktree is no orphan");
  assert.ok(!swept.swept.some((id) => before.has(`${id}.json`)), "the sweep never ends a legacy workspace: older code owns it until the P7 cutover");
  assert.deepEqual(fileDigests(stores.legacy), before, "after create, list, publish, sweep: every v2 file is byte-identical");
  assert.deepEqual(readdirSync(stores.current).filter((entry) => entry.endsWith(".json")).toSorted(), [`${created.workspaceId}.json`, `${orphan.workspaceId}.json`].toSorted(), "only this code's records are in the current store");
  writeFileSync(join(stores.legacy, "README.txt"), "not a record\n");
  assert.equal(manager.list().length, fixtureNames.length + 2, "only records are read");
});
