// @vitest-environment node
/**
 * THE DATABASE'S UPGRADE SAFETY NET IS VISIBLE (secc-design M9): the
 * `database.*` signals serve the kept-copy count and the newest verified
 * pre-upgrade copy beside the database — read live, so the copy the upgrade
 * just made is what the signal names.
 */
import { afterEach, expect, test } from "vitest";
import { join } from "node:path";

import { createTempDir } from "../helpers/temp-dir.ts";
import { preBindingCrypto } from "../helpers/data-loss-helpers.ts";
import { DbClient } from "../../server/db/client.ts";
import { BOUND_FIELDS_SCHEMA_VERSION } from "../../server/db/schema.ts";
import { installDatabaseFactsSource, preMigrationBackups } from "../../server/kernel/canonical.ts";
import { registerAllExposure, resetAllRegistrations } from "../../engine/src/shared/exposure/registrations/index.ts";
import { readSignal } from "../../engine/src/shared/exposure/signal.ts";

afterEach(() => resetAllRegistrations());

test("the newest pre-upgrade copy and the retention are served by the database signals", () => {
  const path = join(createTempDir("database-exposure-"), "web.db");
  installDatabaseFactsSource(() => ({ backupRetention: 3, newestPreMigrationCopy: preMigrationBackups(path).at(-1) }));
  resetAllRegistrations();
  registerAllExposure();
  expect(readSignal("database.newestPreMigrationCopy")).toBe("");
  new DbClient({ path, schemaVersion: BOUND_FIELDS_SCHEMA_VERSION - 1, crypto: preBindingCrypto(path) }).close();
  new DbClient({ path }).close();
  expect(readSignal("database.newestPreMigrationCopy")).toBe(`before schema ${BOUND_FIELDS_SCHEMA_VERSION}: ${path}.pre-v${BOUND_FIELDS_SCHEMA_VERSION}`);
  expect(readSignal("database.backupRetention")).toBe(3);
});

test("the key tool is exposed: admin actions over the one key-rotation owner, key-home signals, and host paths served to admins only (secd-design M9, secd-security SECD-C5)", async () => {
  const { installServerKeyTool } = await import("../../server/db/key-tool.ts");
  const { executeAction, getAction } = await import("../../engine/src/shared/exposure/action.ts");
  const { buildUiSchemaValues } = await import("../../server/schema/ui-schema.ts");
  const { installKeepOutSource } = await import("../../engine/src/shared/exposure/registrations/safety.ts");
  const { randomBytes } = await import("node:crypto");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { DatabaseSync } = await import("node:sqlite");
  resetAllRegistrations();
  registerAllExposure();
  installServerKeyTool("server");
  for (const id of ["database.key.relocate", "database.key.scan", "database.key.forget", "database.key.rekey"]) expect(getAction(id), id).toBeDefined();
  // A scan through the ACTION finds an install keeping its key beside its database, and never moves it.
  const root = createTempDir("database-exposure-scan-");
  mkdirSync(join(root, "old", ".bridlewise"), { recursive: true });
  writeFileSync(join(root, "old", ".bridlewise", "db-key"), randomBytes(32), { mode: 0o600 });
  const db = new DatabaseSync(join(root, "old", ".bridlewise", "web.db"));
  db.exec("CREATE TABLE users (id TEXT)");
  db.close();
  // The walk runs OFF the event loop (sec-e-design H3): the loop turns while the scan is pending.
  const order: string[] = [];
  setImmediate(() => order.push("the event loop turned"));
  const found = await executeAction("database.key.scan", { folders: root, apply: false }).then((result) => { order.push("the scan answered"); return result; }) as Readonly<{ installs: readonly { folder: string }[]; truncated: boolean }>;
  expect(order).toEqual(["the event loop turned", "the scan answered"]);
  expect(found.truncated).toBe(false);
  expect(found.installs.map((install) => install.folder)).toEqual([join(root, "old", ".bridlewise")]);
  expect(readSignal("database.legacyKeysFound")).toBe(1);
  // relocate and rekey are the db-key shell's only: the server refuses them typed, naming the command (428, a guided remedy).
  const { statusForCode } = await import("../../shared/errors.ts");
  for (const id of ["database.key.relocate", "database.key.rekey"]) {
    const refusal = await Promise.resolve().then(() => executeAction(id, { database: join(root, "old", ".bridlewise", "web.db") })).then(() => undefined, (error: unknown) => error as Error & { code?: string });
    expect(refusal?.code, id).toBe("database_action_shell_only");
    expect(refusal?.message, id).toContain("npm run db-key --");
  }
  // The conversation archive takes the SAME slot and refusal (SCALE-CR1-FIX M7).
  const archiveRefusal = await Promise.resolve().then(() => executeAction("database.conversations.archive", { database: "x.db", chatIds: "c1" })).then(() => undefined, (error: unknown) => error as Error & { code?: string });
  expect(archiveRefusal?.code).toBe("database_action_shell_only");
  expect(archiveRefusal?.message).toContain("npm run db-archive --");
  expect(statusForCode("database_action_shell_only")).toBe(428);
  // Per caller: the key home and the keep-out list name the host's layout — an admin reads them, anyone else does not.
  installKeepOutSource(() => [{ path: "/home/u/other-install/.bridlewise/web.db*", source: "store" }, { path: "/home/u/.ssh", source: "home" }]);
  const admin = buildUiSchemaValues({ isAdmin: true }).signals;
  const user = buildUiSchemaValues({ isAdmin: false }).signals;
  expect(admin.find((signal) => signal.id === "database.keyHome")?.value).toMatch(/\//u);
  expect(user.some((signal) => signal.id === "database.keyHome"), "the key home is not served to a non-admin").toBe(false);
  expect(String(admin.find((signal) => signal.id === "safety.keepOut")?.value)).toContain("other-install");
  const served = String(user.find((signal) => signal.id === "safety.keepOut")?.value);
  expect(served).not.toContain("/");
  expect(served).toBe("store: 1, home: 1");
});

test("every refusal of the key tool's family is mapped to its status, never a bare 500 by omission (sec-e-design M5)", async () => {
  const { readFileSync } = await import("node:fs");
  const { statusForCode } = await import("../../shared/errors.ts");
  const owners = ["server/db/key-rotation.ts", "server/db/key-tool.ts", "server/db/bootstrap-key.ts", "engine/src/filesystem/persisted-key.ts", "engine/src/filesystem/self-protection/key-home.ts", "engine/src/shared/exposure/registrations/database.ts"];
  const codes = new Set(owners.flatMap((owner) => [...readFileSync(join(process.cwd(), owner), "utf8").matchAll(/["'`]((?:db_key|db_rekey|persisted_key|key_home|database_key)_[a-z_]+)["'`]/gu)].map((match) => match[1]!)));
  expect(codes.size, "the family's codes were found (liveness)").toBeGreaterThan(20);
  expect([...codes].filter((code) => statusForCode(code) === undefined), "map each in shared/errors.ts CODE_STATUS_MAP").toEqual([]);
});
