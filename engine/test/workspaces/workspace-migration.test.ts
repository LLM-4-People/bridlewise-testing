import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { migrateWorkspaceRecord, WORKSPACE_SCHEMA_VERSION } from "../../src/workflow/workspace-contracts.ts";
import { createWorkspaceRecordStore } from "../../src/workflow/workspace-registry.ts";
import { commitFile, initTempRepo, makeManager, makeTestConfig, mkWorkspaceTempDir, registryRoot } from "./workspace-test-support.ts";

/**
 * THE v2 → v3 MIGRATION of stored workspace records, over REAL v2 records
 * (copied from a host's registry: arrays trimmed, home paths replaced, no
 * credential): every shape the host held — read-only and feature, active,
 * aborted, quarantined, merged with its receipt, an overlay — is read,
 * migrated and written back by the one record reader, and every verb that
 * lists the registry (create's admission, list, sweep) works beside them.
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

test("the one record reader migrates on read and writes the record back atomically: once, then it is current", () => {
  const directory = mkWorkspaceTempDir("ws-migrate-store");
  for (const name of fixtureNames) copyFileSync(join(FIXTURES, name), join(directory, `${String(fixture(name)["workspaceId"])}.json`));
  const store = createWorkspaceRecordStore(directory);
  const listed = store.list();
  assert.equal(listed.length, fixtureNames.length);
  for (const record of listed) {
    const onDisk = JSON.parse(readFileSync(join(directory, `${record.workspaceId}.json`), "utf8")) as { schemaVersion: string };
    assert.equal(onDisk.schemaVersion, WORKSPACE_SCHEMA_VERSION, `${record.workspaceId} was written back migrated`);
    assert.deepEqual(store.load(record.workspaceId), record);
  }
  assert.deepEqual(readdirSync(directory).filter((entry) => !entry.endsWith(".json") && !entry.endsWith(".lock")), [], "no temporary file is left");
  // A migrated record is saved like any other (its revision is the compare-and-swap token).
  const active = listed.find((record) => record.state === "active" && record.lease.kind === "feature")!;
  assert.equal(store.save({ ...active, abortReason: "touched" }).revision, active.revision + 1);
});

test("create, list and sweep work beside a registry of v2 records; a legacy feature workspace refuses the forge; a live workspace whose worktree is gone is reported by the sweep, not dropped", async () => {
  const { root } = initTempRepo("ws-migrate-registry");
  const directory = join(registryRoot(root), "workspaces");
  mkdirSync(directory, { recursive: true });
  for (const name of fixtureNames) copyFileSync(join(FIXTURES, name), join(directory, `${String(fixture(name)["workspaceId"])}.json`));
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
  writeFileSync(join(directory, "README.txt"), "not a record\n");
  assert.equal(manager.list().length, fixtureNames.length + 2, "only records are read");
});
