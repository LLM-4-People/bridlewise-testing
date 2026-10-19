import assert from "node:assert/strict";
import { chmodSync, closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { Core } from "./support/legacy-core.ts";
import { InputError } from "../src/kernel/errors.ts";
import { NotFoundError, RequestBusyError, TransitionError, VersionError } from "./support/legacy-errors.ts";
import { stateLocationFromPath } from "./support/legacy-state-boundary.ts";
import { Store } from "./support/legacy-store.ts";
import { createTempDir } from "./support/temp-dir.ts";

function databasePath(): string {
  return join(createTempDir("bridlewise-core-"), "harness.sqlite");
}

function open(path = databasePath()): { core: Core; store: Store; path: string } {
  const store = new Store(stateLocationFromPath(path));
  return { core: new Core(store), store, path };
}

function expireClaim(path: string, requestId: string): void {
  const database = new DatabaseSync(path);
  database.prepare("UPDATE requests SET run_expires_at = 0 WHERE id = ?").run(requestId);
  database.close();
}

test("request follows ready, waiting, answered, and completed transitions", () => {
  const { core, store } = open();
  const session = core.createSession();
  const request = core.submitRequest(session.id, "prompt exact\nline two");
  assert.deepEqual(core.resumeRequest(request.id), {
    state: "ready",
    requestId: request.id,
    answer: null,
  });

  const wait = core.waitForUser(request.id, "question exact?");
  assert.deepEqual(core.resumeRequest(request.id), { state: "waiting", requestId: request.id, wait });
  const answered = core.answerWait(wait.id, "answer exact");
  assert.equal(answered.answer, "answer exact");
  assert.deepEqual(core.resumeRequest(request.id), {
    state: "ready",
    requestId: request.id,
    answer: "answer exact",
  });

  const completed = core.finishRequest(request.id, "completed", "result exact");
  assert.equal(completed.status, "completed");
  assert.equal(completed.result, "result exact");
  assert.deepEqual(core.resumeRequest(request.id), {
    state: "terminal",
    requestId: request.id,
    status: "completed",
    result: "result exact",
  });
  store.close();
});

test("repeated resume is read-only and restart preserves the identical wait and snapshot", () => {
  const first = open();
  const session = first.core.createSession();
  const request = first.core.submitRequest(session.id, "restart prompt");
  const wait = first.core.waitForUser(request.id, "restart question");
  const before = first.core.sessionSnapshot(session.id);

  assert.deepEqual(first.core.resumeRequest(request.id), first.core.resumeRequest(request.id));
  assert.deepEqual(first.core.sessionSnapshot(session.id), before);
  first.store.close();

  const restarted = open(first.path);
  assert.deepEqual(restarted.core.resumeRequest(request.id), {
    state: "waiting",
    requestId: request.id,
    wait,
  });
  assert.deepEqual(restarted.core.sessionSnapshot(session.id), before);
  restarted.store.close();
});

test("answer survives restart and becomes ready with exact persisted text", () => {
  const first = open();
  const session = first.core.createSession();
  const request = first.core.submitRequest(session.id, "p");
  const wait = first.core.waitForUser(request.id, "q");
  first.core.answerWait(wait.id, "  exact answer\nwith spacing  ");
  const before = first.core.sessionSnapshot(session.id);
  first.store.close();

  const restarted = open(first.path);
  assert.deepEqual(restarted.core.resumeRequest(request.id), {
    state: "ready",
    requestId: request.id,
    answer: "  exact answer\nwith spacing  ",
  });
  assert.deepEqual(restarted.core.sessionSnapshot(session.id), before);
  restarted.store.close();
});

test("duplicate answer, second open wait, and finish while waiting fail without mutation", () => {
  const { core, store } = open();
  const session = core.createSession();
  const request = core.submitRequest(session.id, "p");
  const wait = core.waitForUser(request.id, "q");
  const waiting = core.sessionSnapshot(session.id);

  assert.throws(() => core.waitForUser(request.id, "second"), TransitionError);
  assert.throws(() => core.finishRequest(request.id, "completed", "result"), TransitionError);
  assert.deepEqual(core.sessionSnapshot(session.id), waiting);

  core.answerWait(wait.id, "answer");
  const answered = core.sessionSnapshot(session.id);
  assert.throws(() => core.answerWait(wait.id, "duplicate"), TransitionError);
  assert.deepEqual(core.sessionSnapshot(session.id), answered);

  core.finishRequest(request.id, "completed", "done");
  const terminal = core.sessionSnapshot(session.id);
  assert.throws(() => core.waitForUser(request.id, "late"), TransitionError);
  assert.throws(() => core.finishRequest(request.id, "failed", "again"), TransitionError);
  assert.deepEqual(core.sessionSnapshot(session.id), terminal);
  store.close();
});

test("one open request per session is enforced", () => {
  const { core, store } = open();
  const session = core.createSession();
  core.submitRequest(session.id, "first");
  assert.throws(() => core.submitRequest(session.id, "second"), TransitionError);
  store.close();
});

test("expired claim cannot complete before reclaim", () => {
  const { core, store, path } = open();
  const session = core.createSession();
  const request = core.submitRequest(session.id, "prompt");
  const claim = core.claimRequest(request.id);
  assert.equal(claim.state, "claimed");
  if (claim.state !== "claimed") return;
  expireClaim(path, request.id);

  assert.throws(
    () => core.finishRequest(request.id, "completed", "expired result", claim.runToken),
    RequestBusyError,
  );
  assert.equal(core.resumeRequest(request.id).state, "ready");
  store.close();
});

test("expired claim cannot wait before reclaim", () => {
  const { core, store, path } = open();
  const session = core.createSession();
  const request = core.submitRequest(session.id, "prompt");
  const claim = core.claimRequest(request.id);
  assert.equal(claim.state, "claimed");
  if (claim.state !== "claimed") return;
  expireClaim(path, request.id);

  assert.throws(
    () => core.waitForUser(request.id, "expired question", claim.runToken),
    RequestBusyError,
  );
  assert.equal(core.resumeRequest(request.id).state, "ready");
  store.close();
});

test("expired claim cannot release ownership before reclaim", () => {
  const { core, store, path } = open();
  const session = core.createSession();
  const request = core.submitRequest(session.id, "prompt");
  const claim = core.claimRequest(request.id);
  assert.equal(claim.state, "claimed");
  if (claim.state !== "claimed") return;
  expireClaim(path, request.id);

  assert.throws(() => core.releaseRequest(request.id, claim.runToken), RequestBusyError);
  const database = new DatabaseSync(path);
  const persisted = database.prepare(`
    SELECT run_token, run_expires_at FROM requests WHERE id = ?
  `).get(request.id) as { run_token: string | null; run_expires_at: number | null };
  assert.equal(persisted.run_token, claim.runToken);
  assert.equal(persisted.run_expires_at, 0);
  database.close();
  store.close();
});

test("expired claims are reclaimable and stale runners cannot persist transitions", () => {
  const first = open();
  const session = first.core.createSession();
  const request = first.core.submitRequest(session.id, "prompt", "/tmp/workspace");
  const stale = first.core.claimRequest(request.id);
  assert.equal(stale.state, "claimed");
  if (stale.state !== "claimed") return;

  expireClaim(first.path, request.id);
  const second = open(first.path);
  const current = second.core.claimRequest(request.id);
  assert.equal(current.state, "claimed");
  if (current.state !== "claimed") return;
  assert.notEqual(current.runToken, stale.runToken);

  assert.throws(
    () => first.core.waitForUser(request.id, "stale question", stale.runToken),
    RequestBusyError,
  );
  assert.throws(
    () => first.core.finishRequest(request.id, "completed", "stale result", stale.runToken),
    RequestBusyError,
  );
  assert.throws(() => first.core.releaseRequest(request.id, stale.runToken), RequestBusyError);
  const failed = second.core.finishRequest(request.id, "failed", "current result", current.runToken);
  assert.equal(failed.status, "failed");

  const verification = new DatabaseSync(first.path);
  const persisted = verification.prepare(`
    SELECT run_token, run_expires_at FROM requests WHERE id = ?
  `).get(request.id) as { run_token: string | null; run_expires_at: number | null };
  assert.equal(persisted.run_token, null);
  assert.equal(persisted.run_expires_at, null);
  verification.close();
  second.store.close();
  first.store.close();
});

test("optional canonical agent workspace is persisted and readable for resume", () => {
  const { core, store } = open();
  const session = core.createSession();
  const request = core.submitRequest(session.id, "agent prompt", "/tmp/canonical-workspace");
  assert.equal(request.workspaceRoot, "/tmp/canonical-workspace");
  assert.deepEqual(core.requestContext(request.id), {
    id: request.id,
    sessionId: session.id,
    prompt: "agent prompt",
    workspaceRoot: "/tmp/canonical-workspace",
  });
  store.close();
});

test("completed and failed requests stay terminal across restart", () => {
  const first = open();
  const session = first.core.createSession();
  const completed = first.core.submitRequest(session.id, "complete");
  first.core.finishRequest(completed.id, "completed", "done");
  const failed = first.core.submitRequest(session.id, "fail");
  first.core.finishRequest(failed.id, "failed", "failure result");
  first.store.close();

  const restarted = open(first.path);
  assert.equal(restarted.core.resumeRequest(completed.id).state, "terminal");
  assert.deepEqual(restarted.core.resumeRequest(failed.id), {
    state: "terminal",
    requestId: failed.id,
    status: "failed",
    result: "failure result",
  });
  assert.throws(() => restarted.core.waitForUser(failed.id, "late"), TransitionError);
  assert.throws(() => restarted.core.finishRequest(failed.id, "failed", "again"), TransitionError);
  restarted.store.close();
});

test("snapshots retain stable request and wait ordinal order", () => {
  const { core, store } = open();
  const session = core.createSession();
  const first = core.submitRequest(session.id, "first");
  const firstWait = core.waitForUser(first.id, "first question");
  core.answerWait(firstWait.id, "first answer");
  const secondWait = core.waitForUser(first.id, "second question");
  core.answerWait(secondWait.id, "second answer");
  assert.deepEqual(core.resumeRequest(first.id), {
    state: "ready",
    requestId: first.id,
    answer: "second answer",
  });
  core.finishRequest(first.id, "completed", "first result");
  const second = core.submitRequest(session.id, "second");
  core.finishRequest(second.id, "failed", "second result");

  const snapshot = core.sessionSnapshot(session.id);
  assert.deepEqual(snapshot.requests.map((request) => request.ordinal), [1, 2]);
  assert.deepEqual(snapshot.requests[0]!.waits.map((wait) => wait.ordinal), [1, 2]);
  assert.deepEqual(snapshot.requests.map((request) => request.prompt), ["first", "second"]);
  store.close();
});

test("missing identifiers fail without changing existing state", () => {
  const { core, store } = open();
  const session = core.createSession();
  const before = core.sessionSnapshot(session.id);
  assert.throws(() => core.submitRequest("missing", "p"), NotFoundError);
  assert.throws(() => core.resumeRequest("missing"), NotFoundError);
  assert.throws(() => core.answerWait("missing", "answer"), NotFoundError);
  assert.throws(() => core.waitForUser("missing", "question"), NotFoundError);
  assert.throws(() => core.finishRequest("missing", "completed", "result"), NotFoundError);
  assert.throws(() => core.sessionSnapshot("missing"), NotFoundError);
  assert.deepEqual(core.sessionSnapshot(session.id), before);
  store.close();
});

test("empty and whitespace-only prompt, question, answer, result, and IDs fail without mutation", () => {
  const { core, store } = open();
  const session = core.createSession();
  const invalid = ["", " ", "\t", "\n", " \r\n\t "];

  for (const value of invalid) {
    const before = core.sessionSnapshot(session.id);
    assert.throws(() => core.submitRequest(session.id, value), InputError);
    assert.deepEqual(core.sessionSnapshot(session.id), before);
  }

  const request = core.submitRequest(session.id, "prompt");
  for (const value of invalid) {
    const before = core.sessionSnapshot(session.id);
    assert.throws(() => core.waitForUser(request.id, value), InputError);
    assert.deepEqual(core.sessionSnapshot(session.id), before);
  }

  const wait = core.waitForUser(request.id, "question");
  for (const value of invalid) {
    const before = core.sessionSnapshot(session.id);
    assert.throws(() => core.answerWait(wait.id, value), InputError);
    assert.deepEqual(core.sessionSnapshot(session.id), before);
  }
  core.answerWait(wait.id, "answer");

  for (const value of invalid) {
    const before = core.sessionSnapshot(session.id);
    assert.throws(() => core.finishRequest(request.id, "completed", value), InputError);
    assert.deepEqual(core.sessionSnapshot(session.id), before);
  }

  for (const value of invalid) {
    assert.throws(() => core.submitRequest(value, "prompt"), InputError);
    assert.throws(() => core.waitForUser(value, "question"), InputError);
    assert.throws(() => core.answerWait(value, "answer"), InputError);
    assert.throws(() => core.resumeRequest(value), InputError);
    assert.throws(() => core.finishRequest(value, "completed", "result"), InputError);
    assert.throws(() => core.sessionSnapshot(value), InputError);
  }
  store.close();
});

test("meaningful prompt, question, answer, and result whitespace persists exactly", () => {
  const { core, store } = open();
  const text = {
    prompt: "  prompt line one\nprompt line two  ",
    question: "\n  question line one\nquestion line two\t",
    answer: "\tanswer line one\nanswer line two  \n",
    result: "  result line one\n\nresult line three\t",
  };
  const session = core.createSession();
  const request = core.submitRequest(session.id, text.prompt);
  const wait = core.waitForUser(request.id, text.question);
  core.answerWait(wait.id, text.answer);
  core.finishRequest(request.id, "completed", text.result);

  const persisted = core.sessionSnapshot(session.id).requests[0]!;
  assert.equal(persisted.prompt, text.prompt);
  assert.equal(persisted.waits[0]!.question, text.question);
  assert.equal(persisted.waits[0]!.answer, text.answer);
  assert.equal(persisted.result, text.result);
  store.close();
});

test("direct Store text methods reject blank values and preserve meaningful whitespace", () => {
  const { store } = open();
  const session = store.createSession();
  const invalid = ["", " ", "\t\n", "\u00a0", "\u2003\u2028"];

  for (const value of invalid) {
    assert.throws(() => store.submitRequest(session.id, value), InputError);
    assert.throws(() => store.submitRequest(value, "prompt"), InputError);
  }
  const prompt = "\0  direct prompt\n  ";
  const request = store.submitRequest(session.id, prompt);
  for (const value of invalid) {
    assert.throws(() => store.waitForUser(request.id, value), InputError);
    assert.throws(() => store.waitForUser(value, "question"), InputError);
  }
  const question = "\0\n direct question\t";
  const wait = store.waitForUser(request.id, question);
  for (const value of invalid) {
    assert.throws(() => store.answerWait(wait.id, value), InputError);
    assert.throws(() => store.answerWait(value, "answer"), InputError);
  }
  const answer = "\0\t direct answer \n";
  store.answerWait(wait.id, answer);
  for (const value of invalid) {
    assert.throws(() => store.finishRequest(request.id, "completed", value), InputError);
    assert.throws(() => store.finishRequest(value, "completed", "result"), InputError);
  }
  const result = "\0  direct result\n";
  store.finishRequest(request.id, "completed", result);

  const persisted = store.sessionSnapshot(session.id).requests[0]!;
  assert.equal(persisted.prompt, prompt);
  assert.equal(persisted.waits[0]!.question, question);
  assert.equal(persisted.waits[0]!.answer, answer);
  assert.equal(persisted.result, result);
  store.close();
});

test("database uses strict v1 schema and required SQLite settings", () => {
  const instance = open();
  instance.store.close();
  const database = new DatabaseSync(instance.path);
  const scalar = (sql: string, key: string): unknown =>
    (database.prepare(sql).get() as Record<string, unknown>)[key];

  assert.equal(scalar("PRAGMA user_version", "user_version"), 1);
  assert.equal(scalar("PRAGMA journal_mode", "journal_mode"), "delete");
  assert.equal(scalar("PRAGMA synchronous", "synchronous"), 2);
  assert.equal(scalar("PRAGMA foreign_keys", "foreign_keys"), 1);
  const tables = database.prepare("PRAGMA table_list").all() as Array<Record<string, unknown>>;
  for (const name of ["sessions", "requests", "user_waits"]) {
    assert.equal(tables.find((row) => row.name === name)?.strict, 1);
  }
  const indexes = database.prepare(`
    SELECT name FROM sqlite_schema WHERE type = 'index' AND sql LIKE 'CREATE UNIQUE INDEX%WHERE%'
    ORDER BY name
  `).all() as Array<{ name: string }>;
  assert.deepEqual(indexes.map((row) => row.name), [
    "one_open_request_per_session",
    "one_unanswered_wait_per_request",
  ]);
  database.close();
});

test("unsupported database versions are rejected", () => {
  const path = databasePath();
  closeSync(openSync(path, "wx", 0o600));
  chmodSync(path, 0o600);
  const database = new DatabaseSync(path);
  database.exec("PRAGMA user_version = 2");
  database.close();
  assert.throws(() => new Store(stateLocationFromPath(path)), VersionError);
});
