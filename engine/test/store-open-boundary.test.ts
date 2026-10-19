import assert from "node:assert/strict";
import { closeSync, openSync, renameSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SecurityError } from "../src/kernel/errors.ts";
import { stateLocationFromPath } from "./support/legacy-state-boundary.ts";
import { createTempDir } from "./support/temp-dir.ts";

test("Store closes SQLite when the database path changes immediately after open", async () => {
  const databasePath = join(createTempDir("bridlewise-open-"), "harness.sqlite");
  const displacedPath = `${databasePath}.opened`;
  const sqlite = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: typeof DatabaseSync };
  const OriginalDatabase = sqlite.DatabaseSync;
  let openedDatabase: DatabaseSync | undefined;

  sqlite.DatabaseSync = class extends OriginalDatabase {
    constructor(...args: ConstructorParameters<typeof DatabaseSync>) {
      super(...args);
      openedDatabase = this;
      renameSync(databasePath, displacedPath);
      closeSync(openSync(databasePath, "wx", 0o600));
    }
  };
  syncBuiltinESMExports();
  try {
    const { Store } = await import("./support/legacy-store.ts");
    assert.throws(
      () => new Store(stateLocationFromPath(databasePath)),
      (error: unknown) =>
        error instanceof SecurityError && error.message === "Database path changed during database open",
    );
    const database = openedDatabase;
    assert.ok(database);
    assert.throws(() => database.exec("SELECT 1"), /database is not open/);
  } finally {
    sqlite.DatabaseSync = OriginalDatabase;
    syncBuiltinESMExports();
  }
});
