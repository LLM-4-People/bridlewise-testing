/**
 * Contract test for config accessors.
 *
 * Verifies that the DEFAULT_* accessor constants in config-contracts.ts
 * match the values declared in the REAL bridlewise.config.json file, and
 * that the minimumLongTaskHeartbeatMs safety invariant in root-policy.ts
 * is present. This is the "no drift" pattern: if someone changes
 * the config file without updating the accessor (or vice versa), the test
 * catches the drift.
 *
 * Dynamic: reads the real config file + root-policy at test time — no
 * hardcoded expected values in the test itself.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  DEFAULT_LONG_TASK_HEARTBEAT_MS,
  DEFAULT_LONG_TASK_PROBE_TIMEOUT_MS,
  DEFAULT_LONG_TASK_SPAWN_TIMEOUT_MS,
  DEFAULT_LONG_TASK_KILL_TIMEOUT_MS,
  DEFAULT_LONG_TASK_LIST_TIMEOUT_MS,
  DEFAULT_DISPATCHER_MIN_CONTENT_CHARS,
  DEFAULT_DISPATCHER_TRUNCATION_OVERHEAD_CHARS,
  DEFAULT_TIMELINE_QUERY_LIMIT,
} from "../../src/kernel/config-contracts.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";

const ROOT = process.cwd();

function readConfigDocument(): Record<string, unknown> {
  const configPath = join(ROOT, "bridlewise.config.json");
  const raw = readFileSync(configPath, "utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function readToolsSection(): Record<string, unknown> {
  const doc = readConfigDocument();
  return doc["tools"] as Record<string, unknown>;
}

function readTimelineSection(): Record<string, unknown> {
  const doc = readConfigDocument();
  return doc["timeline"] as Record<string, unknown>;
}

test("config-contract: DEFAULT_LONG_TASK_HEARTBEAT_MS matches bridlewise.config.json", () => {
  const tools = readToolsSection();
  const ltr = tools["longTaskRunner"] as Record<string, unknown>;
  assert.equal(ltr["defaultHeartbeatMs"], DEFAULT_LONG_TASK_HEARTBEAT_MS);
});

test("config-contract: DEFAULT_LONG_TASK_PROBE_TIMEOUT_MS matches bridlewise.config.json", () => {
  const tools = readToolsSection();
  const ltr = tools["longTaskRunner"] as Record<string, unknown>;
  assert.equal(ltr["probeTimeoutMs"], DEFAULT_LONG_TASK_PROBE_TIMEOUT_MS);
});

test("config-contract: DEFAULT_LONG_TASK_SPAWN_TIMEOUT_MS matches bridlewise.config.json", () => {
  const tools = readToolsSection();
  const ltr = tools["longTaskRunner"] as Record<string, unknown>;
  assert.equal(ltr["spawnTimeoutMs"], DEFAULT_LONG_TASK_SPAWN_TIMEOUT_MS);
});

test("config-contract: DEFAULT_LONG_TASK_KILL_TIMEOUT_MS matches bridlewise.config.json", () => {
  const tools = readToolsSection();
  const ltr = tools["longTaskRunner"] as Record<string, unknown>;
  assert.equal(ltr["killTimeoutMs"], DEFAULT_LONG_TASK_KILL_TIMEOUT_MS);
});

test("config-contract: DEFAULT_LONG_TASK_LIST_TIMEOUT_MS matches bridlewise.config.json", () => {
  const tools = readToolsSection();
  const ltr = tools["longTaskRunner"] as Record<string, unknown>;
  assert.equal(ltr["listTimeoutMs"], DEFAULT_LONG_TASK_LIST_TIMEOUT_MS);
});

test("config-contract: DEFAULT_DISPATCHER_MIN_CONTENT_CHARS matches bridlewise.config.json", () => {
  const tools = readToolsSection();
  const disp = tools["dispatcher"] as Record<string, unknown>;
  assert.equal(disp["minContentChars"], DEFAULT_DISPATCHER_MIN_CONTENT_CHARS);
});

test("config-contract: DEFAULT_DISPATCHER_TRUNCATION_OVERHEAD_CHARS matches bridlewise.config.json", () => {
  const tools = readToolsSection();
  const disp = tools["dispatcher"] as Record<string, unknown>;
  assert.equal(disp["truncationOverheadChars"], DEFAULT_DISPATCHER_TRUNCATION_OVERHEAD_CHARS);
});

test("config-contract: DEFAULT_TIMELINE_QUERY_LIMIT matches bridlewise.config.json", () => {
  const timeline = readTimelineSection();
  assert.equal(timeline["queryDefaultLimit"], DEFAULT_TIMELINE_QUERY_LIMIT);
});

test("config-contract: minimumLongTaskHeartbeatMs safety invariant is present in root-policy", () => {
  assert.equal(
    ROOT_POLICY.tools.limits.minimumLongTaskHeartbeatMs,
    1000,
    "The minimum heartbeat floor (1000ms) is a safety invariant that must live in root-policy.ts. " +
      "It prevents a heartbeat faster than 1s from keeping the Node event loop alive after the task completes.",
  );
});

test("config-contract: long-task-runner.ts imports the config accessors (no hardcoded values)", () => {
  const source = readFileSync(join(ROOT, "src/tools/concurrent/long-task-runner.ts"), "utf8");
  assert.ok(
    source.includes("DEFAULT_LONG_TASK_HEARTBEAT_MS"),
    "long-task-runner.ts must import DEFAULT_LONG_TASK_HEARTBEAT_MS from config-contracts.ts",
  );
  assert.ok(
    source.includes("DEFAULT_LONG_TASK_PROBE_TIMEOUT_MS"),
    "long-task-runner.ts must import DEFAULT_LONG_TASK_PROBE_TIMEOUT_MS from config-contracts.ts",
  );
  assert.ok(
    source.includes("ROOT_POLICY.tools.limits.minimumLongTaskHeartbeatMs"),
    "long-task-runner.ts must use ROOT_POLICY.tools.limits.minimumLongTaskHeartbeatMs for the heartbeat floor",
  );
  // No hardcoded timeout values remain
  assert.ok(
    !/\btimeout:\s*\d{4,5}\b/.test(source),
    "long-task-runner.ts must not contain hardcoded timeout values (e.g. timeout: 5000)",
  );
});

test("config-contract: dispatcher.ts imports the config accessors (no hardcoded values)", () => {
  const source = readFileSync(join(ROOT, "src/tools/concurrent/dispatcher.ts"), "utf8");
  assert.ok(
    source.includes("DEFAULT_DISPATCHER_MIN_CONTENT_CHARS"),
    "dispatcher.ts must import DEFAULT_DISPATCHER_MIN_CONTENT_CHARS from config-contracts.ts",
  );
  assert.ok(
    source.includes("DEFAULT_DISPATCHER_TRUNCATION_OVERHEAD_CHARS"),
    "dispatcher.ts must import DEFAULT_DISPATCHER_TRUNCATION_OVERHEAD_CHARS from config-contracts.ts",
  );
  // No hardcoded Math.max(100, ...) or Math.max(0, maxChars - 20) remains
  assert.ok(
    !/Math\.max\(100\b/.test(source),
    "dispatcher.ts must not contain hardcoded Math.max(100, ...) — use DEFAULT_DISPATCHER_MIN_CONTENT_CHARS",
  );
});

test("config-contract: the timeline query default has ONE resolution, the store's (no hardcoded values)", () => {
  // a2-design H1: the store resolves `timeline.queryDefaultLimit` once (the
  // contract default as its fallback) and the query layer passes an absent
  // limit THROUGH. A second default in the query layer is how the configured
  // value was ignored before; the behaviour is pinned by
  // test/timeline/timeline-query.test.ts.
  const store = readFileSync(join(ROOT, "src/timeline/timeline-store.ts"), "utf8");
  assert.ok(
    /queryDefaultLimit\s*\?\?\s*DEFAULT_TIMELINE_QUERY_LIMIT/.test(store),
    "timeline-store.ts must resolve timeline.queryDefaultLimit with DEFAULT_TIMELINE_QUERY_LIMIT (config-contracts.ts) as its fallback",
  );
  const query = readFileSync(join(ROOT, "src/timeline/timeline-query.ts"), "utf8");
  assert.ok(
    !query.includes("DEFAULT_TIMELINE_QUERY_LIMIT"),
    "timeline-query.ts must not resolve a default of its own — an absent limit is the store's configured default",
  );
  assert.ok(
    !/\?\?\s*1000\b/.test(store + query),
    "no hardcoded `?? 1000` default limit — use DEFAULT_TIMELINE_QUERY_LIMIT",
  );
});
