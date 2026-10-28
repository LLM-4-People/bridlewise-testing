import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { Core } from "./support/legacy-core.ts";
import { stateLocationFromPath } from "./support/legacy-state-boundary.ts";
import { Store } from "./support/legacy-store.ts";
import { createTempDir } from "./support/temp-dir.ts";

const CLI = new URL("./support/legacy-store-worker.ts", import.meta.url);
const PROCESS_TIMEOUT_MS = 15_000;

type ChildResult = Readonly<{
  status: number | null;
  stdout: string;
  stderr: string;
}>;

function databasePath(prefix: string): string {
  return join(createTempDir(prefix), "state", "harness.sqlite");
}

function open(path: string): { core: Core; store: Store } {
  const store = new Store(stateLocationFromPath(path));
  return { core: new Core(store), store };
}

function invoke(path: string, ...args: string[]): Promise<ChildResult> {
  return collect(spawn(process.execPath, [CLI.pathname, path, ...args]));
}

function collect(child: ChildProcessWithoutNullStreams): Promise<ChildResult> {
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => stdout += chunk);
  child.stderr.on("data", (chunk: string) => stderr += chunk);
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, PROCESS_TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Child process exceeded ${PROCESS_TIMEOUT_MS}ms`));
      } else {
        resolve({ status, stdout, stderr });
      }
    });
  });
}

function json(result: ChildResult): Record<string, unknown> {
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

function assertOneWinner(results: readonly ChildResult[]): ChildResult {
  assert.deepEqual(results.map((result) => result.status).toSorted(), [0, 1]);
  const rejected = results.find((result) => result.status === 1)!;
  assert.equal((JSON.parse(rejected.stderr) as Record<string, unknown>).errorClass, "TransitionError");
  return results.find((result) => result.status === 0)!;
}

test("concurrent initialization of an absent database is idempotent", async () => {
  const path = databasePath("bridlewise-init-");
  const results = await Promise.all(Array.from({ length: 8 }, () => invoke(path, "init")));
  for (const result of results) {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(json(result).schemaVersion, 1);
  }

  const database = new DatabaseSync(path);
  assert.equal(database.prepare("PRAGMA user_version").get()!.user_version, 1);
  const tables = database.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name IN ('sessions', 'requests', 'user_waits')
  `).all();
  assert.equal(tables.length, 3);
  database.close();
});

test("concurrent request submissions create one open request", async () => {
  const path = databasePath("bridlewise-submit-");
  const initial = open(path);
  const session = initial.core.createSession();
  initial.store.close();

  const winner = assertOneWinner(await Promise.all([
    invoke(path, "request-submit", session.id, "first"),
    invoke(path, "request-submit", session.id, "second"),
  ]));
  const current = open(path);
  const requests = current.core.sessionSnapshot(session.id).requests;
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.id, json(winner).id);
  assert.equal(requests[0]!.ordinal, 1);
  assert.equal(requests[0]!.status, "open");
  current.store.close();
});

test("concurrent wait and completion commit exactly one valid transition", async () => {
  const path = databasePath("bridlewise-wait-finish-");
  const initial = open(path);
  const session = initial.core.createSession();
  const request = initial.core.submitRequest(session.id, "prompt");
  initial.store.close();

  const winner = assertOneWinner(await Promise.all([
    invoke(path, "request-wait", request.id, "question"),
    invoke(path, "request-complete", request.id, "result"),
  ]));
  const current = open(path);
  const persisted = current.core.sessionSnapshot(session.id).requests[0]!;
  if (json(winner).status === "completed") {
    assert.equal(persisted.status, "completed");
    assert.equal(persisted.result, "result");
    assert.deepEqual(persisted.waits, []);
  } else {
    assert.equal(persisted.status, "open");
    assert.equal(persisted.result, null);
    assert.equal(persisted.waits.length, 1);
    assert.equal(persisted.waits[0]!.answer, null);
  }
  current.store.close();
});

test("concurrent answers change an unanswered wait once", async () => {
  const path = databasePath("bridlewise-answer-");
  const initial = open(path);
  const session = initial.core.createSession();
  const request = initial.core.submitRequest(session.id, "prompt");
  const wait = initial.core.waitForUser(request.id, "question");
  initial.store.close();

  const winner = assertOneWinner(await Promise.all([
    invoke(path, "request-answer", wait.id, "first answer"),
    invoke(path, "request-answer", wait.id, "second answer"),
  ]));
  const current = open(path);
  const waits = current.core.sessionSnapshot(session.id).requests[0]!.waits;
  assert.equal(waits.length, 1);
  assert.equal(waits[0]!.answer, json(winner).answer);
  assert.notEqual(waits[0]!.answeredAt, null);
  current.store.close();
});

test("snapshot and resume reads never combine separately committed graph versions", async () => {
  const path = databasePath("bridlewise-snapshot-");
  const reader = open(path);
  const session = reader.core.createSession();
  const request = reader.core.submitRequest(session.id, "initial");
  const wait = reader.core.waitForUser(request.id, "initial");
  reader.core.answerWait(wait.id, "initial");

  const writerSource = `
    import { DatabaseSync } from "node:sqlite";
    const [path, sessionId, requestId, waitId] = process.argv.slice(1);
    const database = new DatabaseSync(path, { timeout: 5000, enableForeignKeyConstraints: true });
    // The property is isolation, not durability: the writer's commits skip the
    // fsync so their lock windows do not depend on the temp root's disk (on a
    // real disk, 1000 back-to-back fsynced commits starved the reader past its
    // busy timeout; tmpfs had hidden it). The reader keeps synchronous=FULL.
    database.exec("PRAGMA synchronous = OFF");
    const remove = database.prepare("DELETE FROM sessions WHERE id = ?");
    const addSession = database.prepare("INSERT INTO sessions (id, created_at) VALUES (?, ?)");
    const addRequest = database.prepare("INSERT INTO requests (id, session_id, ordinal, prompt, status, result, created_at, finished_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?)");
    const addWait = database.prepare("INSERT INTO user_waits (id, request_id, ordinal, question, answer, created_at, answered_at) VALUES (?, ?, 1, ?, ?, ?, ?)");
    const replace = (marker) => {
      database.exec("BEGIN IMMEDIATE");
      try {
        remove.run(sessionId);
        addSession.run(sessionId, marker);
        if (marker === 1) {
          addRequest.run(requestId, sessionId, "1", "open", null, 1, null);
          addWait.run(waitId, requestId, "1", null, 1, null);
        } else {
          addRequest.run(requestId, sessionId, "2", "completed", "2", 2, 2);
        }
        database.exec("COMMIT");
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK");
        throw error;
      }
    };
    replace(1);
    process.stdout.write("ready\\n");
    for (let index = 0; index < 1000; index += 1) replace(index % 2 + 1);
    database.close();
  `;
  const writer = spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    writerSource,
    path,
    session.id,
    request.id,
    wait.id,
  ]);
  const completion = collect(writer);
  await new Promise<void>((resolve, reject) => {
    writer.stdout.once("data", (chunk: Buffer) => {
      if (chunk.toString().includes("ready")) resolve();
      else reject(new Error("Snapshot writer did not become ready"));
    });
    writer.once("error", reject);
  });

  let reads = 0;
  for (let batch = 0; batch < 500 && writer.exitCode === null; batch += 1) {
    for (let index = 0; index < 10; index += 1) {
      const snapshot = reader.core.sessionSnapshot(session.id);
      const marker = String(snapshot.session.createdAt);
      assert.ok(marker === "1" || marker === "2");
      assert.equal(snapshot.requests.length, 1);
      assert.equal(snapshot.requests[0]!.prompt, marker);
      const resumed = reader.core.resumeRequest(request.id);
      if (marker === "1") {
        assert.equal(snapshot.requests[0]!.status, "open");
        assert.equal(snapshot.requests[0]!.waits.length, 1);
        assert.equal(snapshot.requests[0]!.waits[0]!.question, "1");
        assert.equal(snapshot.requests[0]!.waits[0]!.answer, null);
      } else {
        assert.equal(snapshot.requests[0]!.status, "completed");
        assert.equal(snapshot.requests[0]!.result, "2");
        assert.deepEqual(snapshot.requests[0]!.waits, []);
      }
      if (resumed.state === "waiting") {
        assert.equal(resumed.wait.question, "1");
      } else {
        assert.equal(resumed.state, "terminal");
        if (resumed.state === "terminal") assert.equal(resumed.result, "2");
      }
      reads += 1;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  const result = await completion;
  assert.equal(result.status, 0, result.stderr);
  assert.ok(reads > 0);
  reader.store.close();
});
