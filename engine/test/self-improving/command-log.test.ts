/**
 * EXP424 — Command Log test: append-only log of all commands.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildCommandRecord, CommandLog } from "../../src/self-improving/command-log.ts";

function rec(id: string, runId = "run-1", turn = 1, args: Record<string, unknown> = {}) {
  return buildCommandRecord({
    runId, turn, taskIndex: 0, command: `cmd-${id}`, type: "search",
    args, task: "test-task",
    result: { ok: true, output: "ok", durationMs: 10 },
  });
}

test("command log: records + retrieves by id", () => {
  const log = new CommandLog();
  const r1 = log.record(rec("1"));
  assert.equal(log.size(), 1);
  assert.equal(log.all()[0]!.id, r1.id);
});

test("command log: dedup by id throws", () => {
  const log = new CommandLog();
  const r1 = log.record(rec("1"));
  assert.throws(() => log.record({ ...rec("1"), id: r1.id }), /already recorded/);
});

test("command log: byRunId filters", () => {
  const log = new CommandLog();
  log.record(rec("1", "run-A"));
  log.record(rec("2", "run-A"));
  log.record(rec("3", "run-B"));
  assert.equal(log.byRunId("run-A").length, 2);
  assert.equal(log.byRunId("run-B").length, 1);
  assert.equal(log.byRunId("run-C").length, 0);
});

test("command log: byType filters", () => {
  const log = new CommandLog();
  log.record(buildCommandRecord({
    runId: "r1", turn: 1, taskIndex: 0, command: "c1", type: "search",
    args: {}, task: "t", result: { ok: true, output: "ok", durationMs: 1 },
  }));
  log.record(buildCommandRecord({
    runId: "r1", turn: 1, taskIndex: 0, command: "c2", type: "edit",
    args: {}, task: "t", result: { ok: true, output: "ok", durationMs: 1 },
  }));
  assert.equal(log.byType("search").length, 1);
  assert.equal(log.byType("edit").length, 1);
});

test("command log: duplicates finds same args", () => {
  const log = new CommandLog();
  const args = { query: "foo", viewport: 50 };
  // Use the SAME command for r1 + r2 so they share an argsHash.
  log.record(buildCommandRecord({
    id: "1", runId: "run-1", turn: 1, taskIndex: 0, command: "search_code",
    type: "search", args, task: "t", result: { ok: true, output: "ok", durationMs: 1 },
  }));
  log.record(buildCommandRecord({
    id: "2", runId: "run-1", turn: 2, taskIndex: 0, command: "search_code",
    type: "search", args, task: "t", result: { ok: true, output: "ok", durationMs: 1 },
  }));
  log.record(buildCommandRecord({
    id: "3", runId: "run-1", turn: 1, taskIndex: 0, command: "search_code",
    type: "search", args: { query: "bar" }, task: "t", result: { ok: true, output: "ok", durationMs: 1 },
  }));
  const dups = log.duplicates();
  assert.equal(dups.length, 1, `expected 1 duplicate group, got ${dups.length}`);
  assert.equal(dups[0]!.length, 2);
});

test("command log: hashArgs matches stored argsHash", () => {
  const log = new CommandLog();
  const args = { query: "foo" };
  const r = log.record(rec("1", "run-1", 1, args));
  const hash = log.hashArgs(r.command, args);
  assert.equal(hash, r.argsHash);
  // Different args → different hash
  const hash2 = log.hashArgs(r.command, { query: "bar" });
  assert.notEqual(hash, hash2);
});

test("command log: invalid record throws InputError", () => {
  const log = new CommandLog();
  assert.throws(() => log.record({ ...rec("1"), turn: 0 } as any));
});
