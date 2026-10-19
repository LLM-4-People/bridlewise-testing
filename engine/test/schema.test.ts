import assert from "node:assert/strict";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { StoreError } from "./support/legacy-errors.ts";
import { stateLocationFromPath } from "./support/legacy-state-boundary.ts";
import { Store } from "./support/legacy-store.ts";
import { createTempDir } from "./support/temp-dir.ts";

function databasePath(): string {
  return join(createTempDir("bridlewise-schema-"), "harness.sqlite");
}

function initializeDatabase(): string {
  const path = databasePath();
  const store = new Store(stateLocationFromPath(path));
  store.close();
  return path;
}

function openDatabase(): DatabaseSync {
  return new DatabaseSync(initializeDatabase(), { enableForeignKeyConstraints: true });
}

const MALFORMED_V1_CASES: ReadonlyArray<Readonly<{
  name: string;
  prepare: (database: DatabaseSync) => void;
  initializeFirst?: boolean;
}>> = [
  {
    name: "empty v1 database",
    prepare: (database) => database.exec("PRAGMA user_version = 1"),
  },
  {
    name: "missing table",
    initializeFirst: true,
    prepare: (database) => database.exec("DROP TABLE user_waits"),
  },
  {
    name: "altered column",
    initializeFirst: true,
    prepare: (database) => database.exec("ALTER TABLE sessions ADD COLUMN label TEXT"),
  },
  {
    name: "altered check constraint",
    initializeFirst: true,
    prepare: (database) => database.exec(`
      PRAGMA writable_schema = ON;
      UPDATE sqlite_schema
      SET sql = replace(sql, 'ordinal > 0', 'ordinal >= 0')
      WHERE name = 'requests';
      PRAGMA writable_schema = OFF;
    `),
  },
  {
    name: "altered partial index predicate",
    initializeFirst: true,
    prepare: (database) => database.exec(`
      DROP INDEX one_open_request_per_session;
      CREATE UNIQUE INDEX one_open_request_per_session
        ON requests(session_id) WHERE status = 'completed';
    `),
  },
  {
    name: "extra table",
    initializeFirst: true,
    prepare: (database) => database.exec("CREATE TABLE extra (id INTEGER) STRICT"),
  },
  {
    name: "extra table resembling SQLite's reserved prefix",
    initializeFirst: true,
    prepare: (database) => database.exec("CREATE TABLE sqliteX (id INTEGER) STRICT"),
  },
  {
    name: "extra index",
    initializeFirst: true,
    prepare: (database) => database.exec("CREATE INDEX extra_index ON sessions(created_at)"),
  },
];

for (const malformed of MALFORMED_V1_CASES) {
  test(`schema validation rejects ${malformed.name}`, () => {
    const path = malformed.initializeFirst ? initializeDatabase() : databasePath();
    if (!malformed.initializeFirst) closeSync(openSync(path, "wx", 0o600));
    const database = new DatabaseSync(path, { defensive: false });
    malformed.prepare(database);
    database.close();

    assert.throws(
      () => new Store(stateLocationFromPath(path)),
      (error: unknown) => error instanceof StoreError && error.message === "Database schema does not match version 1",
    );
  });
}

test("schema validation accepts a valid v1 reopen", () => {
  const path = initializeDatabase();
  const reopened = new Store(stateLocationFromPath(path));
  reopened.close();
});

test("v1 requests has nullable workspace and consistent execution claim columns", () => {
  const database = openDatabase();
  const columns = database.prepare("PRAGMA table_info(requests)").all() as Array<{
    name: string;
    notnull: number;
  }>;
  assert.deepEqual(
    columns
      .filter((column) => ["workspace_root", "run_token", "run_expires_at"].includes(column.name))
      .map(({ name, notnull }) => ({ name, notnull })),
    [
      { name: "workspace_root", notnull: 0 },
      { name: "run_token", notnull: 0 },
      { name: "run_expires_at", notnull: 0 },
    ],
  );
  database.prepare("INSERT INTO sessions (id, created_at) VALUES ('session', 1)").run();
  database.prepare(`
    INSERT INTO requests (id, session_id, ordinal, prompt, status, created_at)
    VALUES ('request', 'session', 1, 'prompt', 'open', 1)
  `).run();
  assert.throws(
    () => database.prepare("UPDATE requests SET run_token = 'token' WHERE id = 'request'").run(),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => database.prepare("UPDATE requests SET run_expires_at = 1 WHERE id = 'request'").run(),
    /CHECK constraint failed/,
  );
  database.close();
});

test("foreign keys reject orphans and cascade request and wait deletion", () => {
  const database = openDatabase();
  const insertRequest = database.prepare(`
    INSERT INTO requests
      (id, session_id, ordinal, prompt, status, result, created_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertWait = database.prepare(`
    INSERT INTO user_waits
      (id, request_id, ordinal, question, answer, created_at, answered_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  assert.throws(
    () => insertRequest.run("orphan-request", "missing", 1, "p", "open", null, 1, null),
    /FOREIGN KEY constraint failed/,
  );
  assert.throws(
    () => insertWait.run("orphan-wait", "missing", 1, "q", null, 1, null),
    /FOREIGN KEY constraint failed/,
  );

  database.prepare("INSERT INTO sessions (id, created_at) VALUES (?, ?)").run("session", 1);
  insertRequest.run("request-one", "session", 1, "p1", "open", null, 1, null);
  insertWait.run("wait-one", "request-one", 1, "q1", null, 1, null);
  database.prepare("DELETE FROM requests WHERE id = ?").run("request-one");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM user_waits").get()!.count, 0);

  insertRequest.run("request-two", "session", 1, "p2", "open", null, 2, null);
  insertWait.run("wait-two", "request-two", 1, "q2", null, 2, null);
  database.prepare("DELETE FROM sessions WHERE id = ?").run("session");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM requests").get()!.count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM user_waits").get()!.count, 0);
  database.close();
});

test("partial unique indexes enforce exactly their open and unanswered predicates", () => {
  const database = openDatabase();
  database.prepare("INSERT INTO sessions (id, created_at) VALUES (?, ?)").run("session", 1);
  const insertRequest = database.prepare(`
    INSERT INTO requests
      (id, session_id, ordinal, prompt, status, result, created_at, finished_at)
    VALUES (?, 'session', ?, 'p', ?, ?, 1, ?)
  `);
  insertRequest.run("open-one", 1, "open", null, null);
  assert.throws(
    () => insertRequest.run("open-two", 2, "open", null, null),
    /UNIQUE constraint failed: requests.session_id/,
  );
  insertRequest.run("completed", 2, "completed", "done", 2);
  insertRequest.run("failed", 3, "failed", "failed", 3);

  const insertWait = database.prepare(`
    INSERT INTO user_waits
      (id, request_id, ordinal, question, answer, created_at, answered_at)
    VALUES (?, 'open-one', ?, 'q', ?, 1, ?)
  `);
  insertWait.run("unanswered-one", 1, null, null);
  assert.throws(
    () => insertWait.run("unanswered-two", 2, null, null),
    /UNIQUE constraint failed: user_waits.request_id/,
  );
  insertWait.run("answered-two", 2, "a2", 2);
  insertWait.run("answered-three", 3, "a3", 3);

  const indexes = database.prepare(`
    SELECT name, sql FROM sqlite_schema
    WHERE name IN ('one_open_request_per_session', 'one_unanswered_wait_per_request')
    ORDER BY name
  `).all() as Array<{ name: string; sql: string }>;
  assert.match(indexes[0]!.sql, /WHERE status = 'open'$/);
  assert.match(indexes[1]!.sql, /WHERE answer IS NULL$/);
  database.close();
});

test("request and wait checks reject invalid rows without changing state", () => {
  const database = openDatabase();
  database.prepare("INSERT INTO sessions (id, created_at) VALUES (?, ?)").run("session", 1);
  const insertRequest = database.prepare(`
    INSERT INTO requests
      (id, session_id, ordinal, prompt, status, result, created_at, finished_at)
    VALUES (?, 'session', ?, 'p', ?, ?, 1, ?)
  `);
  const invalidRequests: ReadonlyArray<readonly [string, number, string, string | null, number | null]> = [
    ["zero-ordinal", 0, "open", null, null],
    ["bad-status", 1, "unknown", null, null],
    ["open-result", 1, "open", "result", null],
    ["open-finished", 1, "open", null, 1],
    ["terminal-no-result", 1, "completed", null, 1],
    ["terminal-no-time", 1, "failed", "result", null],
  ];
  for (const row of invalidRequests) {
    assert.throws(() => insertRequest.run(...row), /CHECK constraint failed/);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM requests").get()!.count, 0);
  }

  insertRequest.run("request", 1, "open", null, null);
  const insertWait = database.prepare(`
    INSERT INTO user_waits
      (id, request_id, ordinal, question, answer, created_at, answered_at)
    VALUES (?, 'request', ?, 'q', ?, 1, ?)
  `);
  const invalidWaits: ReadonlyArray<readonly [string, number, string | null, number | null]> = [
    ["zero-ordinal", 0, null, null],
    ["answer-no-time", 1, "answer", null],
    ["time-no-answer", 1, null, 1],
  ];
  for (const row of invalidWaits) {
    assert.throws(() => insertWait.run(...row), /CHECK constraint failed/);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM user_waits").get()!.count, 0);
  }
  database.close();
});

test("SQL text checks reject empty strings without reproducing Unicode blank rules", () => {
  const database = openDatabase();
  database.prepare("INSERT INTO sessions (id, created_at) VALUES (?, ?)").run("session", 1);
  const insertRequest = database.prepare(`
    INSERT INTO requests
      (id, session_id, ordinal, prompt, status, result, created_at, finished_at)
    VALUES (?, 'session', ?, ?, ?, ?, 1, ?)
  `);
  assert.throws(
    () => insertRequest.run("empty-prompt", 1, "", "open", null, null),
    /CHECK constraint failed/,
  );
  insertRequest.run("request", 1, "prompt", "open", null, null);
  assert.throws(
    () => database.prepare("UPDATE requests SET status = 'completed', result = '', finished_at = 1 WHERE id = 'request'").run(),
    /CHECK constraint failed/,
  );

  const insertWait = database.prepare(`
    INSERT INTO user_waits
      (id, request_id, ordinal, question, answer, created_at, answered_at)
    VALUES (?, 'request', ?, ?, ?, 1, ?)
  `);
  assert.throws(
    () => insertWait.run("empty-question", 1, "", null, null),
    /CHECK constraint failed/,
  );
  insertWait.run("wait", 1, "question", null, null);
  assert.throws(
    () => database.prepare("UPDATE user_waits SET answer = '', answered_at = 1 WHERE id = 'wait'").run(),
    /CHECK constraint failed/,
  );
  database.prepare("UPDATE user_waits SET answer = ?, answered_at = 1 WHERE id = 'wait'").run("\0nonempty");
  assert.equal(
    database.prepare("SELECT answer FROM user_waits WHERE id = 'wait'").get()!.answer,
    "\0nonempty",
  );
  database.close();
});
