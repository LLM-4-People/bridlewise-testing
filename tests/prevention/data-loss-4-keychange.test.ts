// @vitest-environment node
/**
 * Data loss #4: encryption key change — key A encrypts; key B is refused at
 * open (nothing is read or sealed under it); key A still reads everything. Split from data-loss-mechanical.test.ts for parallelism.
 */
import { describe, test, expect } from "vitest";
import { createTempDir } from "../helpers/temp-dir.ts";
import { DbClient } from "../../server/db/client.ts";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

describe("data loss #4: encryption key change (key A vs key B)", () => {
  test("data encrypted with key A is unreadable with key B, readable with key A", () => {
    const dir = createTempDir("ch-data-loss-keychange-");
    const dbPath = join(dir, "keychange.db");
    const secret = "this is a top secret project path /home/example/secrets";
    {
      const db = new DbClient({ path: dbPath, passphrase: "passphrase-A" });
      try {
        const p = db.createProject({ name: "secret-proj", path: secret }, "sess-key");
        expect(p.path).toBe(secret);
      } finally { db.close(); }
    }
    const disk = new DatabaseSync(dbPath);
    try {
      const beforeWrongKey = disk.prepare("SELECT name,path FROM projects").all();
      // Key B is refused AT OPEN (the key proves itself before anything is
      // sealed under it), not at the first read.
      expect(() => new DbClient({ path: dbPath, passphrase: "passphrase-B" })).toThrow(expect.objectContaining({ name: "WebError", code: "db_key_wrong" }));
      expect(disk.prepare("SELECT name,path FROM projects").all()).toEqual(beforeWrongKey);
    } finally { disk.close(); }
    {
      const db = new DbClient({ path: dbPath, passphrase: "passphrase-A" });
      try {
        const p = db.getProject(db.listProjects("sess-key")[0]!.id, "sess-key");
        expect(p?.path).toBe(secret);
        expect(p?.name).toBe("secret-proj");
      } finally { db.close(); }
    }
  });
});
