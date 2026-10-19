// @vitest-environment node
/**
 * Prevention test: THE WAL STAYS BOUNDED UNDER SUSTAINED WRITES WITH READERS.
 *
 * The named failure of a read-pool + single-writer design: a PASSIVE checkpoint
 * that can never complete because some reader always holds the WAL open, so the
 * WAL grows without limit and every read pays to walk it. Driving both at once
 * and measuring the file is the only way to see it — every ordering assertion
 * passes on an unbounded WAL.
 *
 * ── WHY THIS IS ITS OWN FILE ──────────────────────────────────────────────
 *
 * It lived inside `async-db-ordering.test.ts`, whose subject is the DISPATCH
 * BOUNDARY (W1/W2/W3 — the orderings a threaded facade must re-establish).
 * This one's subject is the FILE ON DISK, and the difference is not academic:
 * every ordering test can share one facade and isolate itself with a fresh
 * chat, while this one needs a database whose WAL nothing else has touched.
 * Keeping it there forced the whole file to carry a private-facade escape
 * hatch, and made it the single most expensive module in the web-UI suite —
 * ~24s, of which ~10s was thread-spawn paid eleven times over.
 *
 * Its nearest sibling is `db-durability-window.test.ts`, which owns the other
 * half of the same property (the TIME bound), for the reason stated below.
 */
import { describe, test, expect, afterEach } from "vitest";
import { join } from "node:path";
import { statSync, existsSync } from "node:fs";

import { AsyncDbClient } from "../../server/db/async-client.ts";
import { DbClient } from "../../server/db/client.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

const open: AsyncDbClient[] = [];

afterEach(async () => {
  while (open.length > 0) await open.pop()!.close();
});

describe("the read pool cannot write, and the WAL stays bounded", () => {
  test("SQLite itself refuses a write on a read-pool connection", () => {
    const dir = createTempDir("ch-asyncdb-ro-");
    const path = join(dir, "ro.db");
    const seed = new DbClient({ path });
    seed.createUser("owner", "hash");
    seed.close();

    const reader = new DbClient({ path, readOnly: true });
    try {
      expect(() => reader.createUser("intruder", "hash")).toThrow(/readonly/i);
      // ...while reads on the same connection still work, so the refusal is
      // the write and not a broken connection.
      expect(reader.countUsers()).toBe(1);
    } finally {
      reader.close();
    }
  });

  test("sustained writes with readers active leave the WAL bounded", async () => {
    // What this does and does not attribute. It proves that ACTIVE READERS do
    // not prevent the WAL from being bounded — the failure specific to this
    // architecture. It does NOT prove the time-bounded window: at this volume
    // SQLite's own `wal_autocheckpoint` (a PAGE-count bound) would hold the
    // line by itself, which mutation testing confirmed by disabling the timer
    // and watching this test stay green. The time bound has its own owner,
    // `db-durability-window.test.ts`, which writes far too little to trip the
    // page threshold and so can only pass if the clock is what checkpointed.
    const dir = createTempDir("ch-asyncdb-wal-");
    const path = join(dir, "async.db");
    const seed = new DbClient({ path });
    const user = seed.createUser("owner", "hash");
    const project = seed.createProject({ name: "p", path: join(dir, "proj") }, user.id);
    const chat = seed.createChat({ project_id: project.id, title: "c" }, user.id);
    seed.close();

    const db = await AsyncDbClient.open({ path, readers: 4 });
    open.push(db);

    const walPath = join(dir, "async.db-wal");
    const content = "x".repeat(2000);

    for (let round = 0; round < 12; round += 1) {
      const writes = Array.from({ length: 250 }, () =>
        db.createMessage({ chat_id: chat.id, role: "assistant", content }, user.id),
      );
      const reads = Array.from({ length: 20 }, () => db.listMessages(chat.id, user.id));
      await Promise.all([...writes, ...reads]);
      // The window is bounded by TIME (1000ms), so give the checkpoint timer
      // room to be the thing that bounds it.
      await new Promise((r) => setTimeout(r, 120));
    }
    await new Promise((r) => setTimeout(r, 1500));

    const walBytes = existsSync(walPath) ? statSync(walPath).size : 0;
    // 3,000 writes of 2KB is ~6MB of content. An unbounded WAL would hold all
    // of it and more; a checkpointing one stays a small multiple of the page
    // cache. 24MB is a generous ceiling that still fails an un-checkpointed WAL.
    expect(walBytes).toBeLessThan(24 * 1024 * 1024);
    expect(await db.countMessages(chat.id, user.id)).toBe(3000);
  }, 60_000);
});
