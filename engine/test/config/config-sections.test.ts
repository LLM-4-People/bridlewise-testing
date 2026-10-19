import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { getConfigDocumentSchema } from "../../src/kernel/config-contracts.ts";

const CONFIG_DOCUMENT_SCHEMA = getConfigDocumentSchema();

/**
 * INVARIANTS #67–71: config sections (editor, timeline, resourceLock,
 * sseLimits, evaluation) must exist in the config schema, have the expected
 * fields, validate correct values, and reject invalid values.
 *
 * The approach: load the real config document (which has all sections), parse
 * it with CONFIG_DOCUMENT_SCHEMA to confirm the sections validate, then clone
 * the raw JSON and mutate individual fields to confirm invalid values are
 * rejected.
 */

const CONFIG_PATH = join(process.cwd(), "bridlewise.config.json");

function readRawConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
}

function cloneConfig(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(readRawConfig())) as Record<string, unknown>;
}

function assertValid(doc: Record<string, unknown>): void {
  const result = CONFIG_DOCUMENT_SCHEMA.safeParse(doc);
  assert.ok(result.success, `expected config to validate, got: ${JSON.stringify(result.error?.issues?.slice(0, 3))}`);
}

function assertInvalid(doc: Record<string, unknown>, hint: string): void {
  const result = CONFIG_DOCUMENT_SCHEMA.safeParse(doc);
  assert.ok(!result.success, `expected config to be REJECTED (${hint}), but it validated`);
}

// ============================================================================
// #67: editor section
// ============================================================================

test("ConfigSection editor: exists and has expected fields", () => {
  const doc = readRawConfig();
  assert.ok(typeof doc.editor === "object" && doc.editor !== null, "editor section must exist");
  const editor = doc.editor as Record<string, unknown>;
  assert.ok("maxFileBytes" in editor);
  assert.ok("maxPatchBytes" in editor);
  assert.ok("maxInsertTextBytes" in editor);
});

test("ConfigSection editor: valid values pass schema", () => {
  const doc = cloneConfig();
  (doc.editor as Record<string, unknown>).maxFileBytes = 4096;
  (doc.editor as Record<string, unknown>).maxPatchBytes = 2048;
  (doc.editor as Record<string, unknown>).maxInsertTextBytes = 1024;
  assertValid(doc);
});

test("ConfigSection editor: rejects non-integer maxFileBytes", () => {
  const doc = cloneConfig();
  (doc.editor as Record<string, unknown>).maxFileBytes = 1.5;
  assertInvalid(doc, "non-integer maxFileBytes");
});

test("ConfigSection editor: rejects zero maxPatchBytes", () => {
  const doc = cloneConfig();
  (doc.editor as Record<string, unknown>).maxPatchBytes = 0;
  assertInvalid(doc, "zero maxPatchBytes (must be positive)");
});

test("ConfigSection editor: rejects unknown extra field", () => {
  const doc = cloneConfig();
  (doc.editor as Record<string, unknown>).bogusField = 123;
  assertInvalid(doc, "unknown extra field in editor (strictObject)");
});

// ============================================================================
// #68: timeline section
// ============================================================================

test("ConfigSection timeline: exists and has expected fields", () => {
  const doc = readRawConfig();
  assert.ok(typeof doc.timeline === "object" && doc.timeline !== null, "timeline section must exist");
  const timeline = doc.timeline as Record<string, unknown>;
  assert.ok("maxDocumentBytes" in timeline);
  assert.ok("maxDocuments" in timeline);
  assert.ok("maxEdges" in timeline);
  assert.ok("dbFilename" in timeline);
  assert.ok("sqliteCacheSize" in timeline);
  assert.ok("sqliteBusyTimeoutMs" in timeline);
});

test("ConfigSection timeline: valid values pass schema", () => {
  const doc = cloneConfig();
  (doc.timeline as Record<string, unknown>).maxDocumentBytes = 65536;
  (doc.timeline as Record<string, unknown>).dbFilename = "my.db";
  assertValid(doc);
});

test("ConfigSection timeline: rejects empty dbFilename", () => {
  const doc = cloneConfig();
  (doc.timeline as Record<string, unknown>).dbFilename = "";
  assertInvalid(doc, "empty dbFilename");
});

test("ConfigSection timeline: rejects zero maxDocuments", () => {
  const doc = cloneConfig();
  (doc.timeline as Record<string, unknown>).maxDocuments = 0;
  assertInvalid(doc, "zero maxDocuments (must be positive)");
});

// ============================================================================
// #69: resourceLock section
// ============================================================================

test("ConfigSection resourceLock: exists and has expected fields", () => {
  const doc = readRawConfig();
  assert.ok(typeof doc.resourceLock === "object" && doc.resourceLock !== null, "resourceLock section must exist");
  const lock = doc.resourceLock as Record<string, unknown>;
  assert.ok("timeoutMs" in lock);
  assert.ok("pollIntervalMs" in lock);
  assert.ok("staleMs" in lock);
});

test("ConfigSection resourceLock: valid values pass schema", () => {
  const doc = cloneConfig();
  (doc.resourceLock as Record<string, unknown>).timeoutMs = 5000;
  (doc.resourceLock as Record<string, unknown>).pollIntervalMs = 50;
  (doc.resourceLock as Record<string, unknown>).staleMs = 1000;
  assertValid(doc);
});

test("ConfigSection resourceLock: rejects zero timeoutMs", () => {
  const doc = cloneConfig();
  (doc.resourceLock as Record<string, unknown>).timeoutMs = 0;
  assertInvalid(doc, "zero timeoutMs (must be positive)");
});

test("ConfigSection resourceLock: rejects non-integer pollIntervalMs", () => {
  const doc = cloneConfig();
  (doc.resourceLock as Record<string, unknown>).pollIntervalMs = 2.5;
  assertInvalid(doc, "non-integer pollIntervalMs");
});

// ============================================================================
// #70: sseLimits (nested in runtime.limits)
// ============================================================================

test("ConfigSection sseLimits: exists under runtime.limits and has expected fields", () => {
  const doc = readRawConfig();
  const runtime = doc.runtime as Record<string, unknown> | undefined;
  assert.ok(runtime, "runtime section must exist");
  const limits = runtime!.limits as Record<string, unknown> | undefined;
  assert.ok(limits, "runtime.limits must exist");
  assert.ok(typeof limits!.sseLimits === "object" && limits!.sseLimits !== null, "sseLimits must exist under runtime.limits");
  const sse = limits!.sseLimits as Record<string, unknown>;
  assert.ok("maxEventBytes" in sse);
  assert.ok("maxLineBytes" in sse);
});

test("ConfigSection sseLimits: valid values pass schema", () => {
  const doc = cloneConfig();
  const runtime = doc.runtime as Record<string, unknown>;
  const limits = runtime.limits as Record<string, unknown>;
  limits.sseLimits = { maxEventBytes: 8192, maxLineBytes: 4096 };
  assertValid(doc);
});

test("ConfigSection sseLimits: rejects zero maxEventBytes", () => {
  const doc = cloneConfig();
  const runtime = doc.runtime as Record<string, unknown>;
  const limits = runtime.limits as Record<string, unknown>;
  (limits.sseLimits as Record<string, unknown>).maxEventBytes = 0;
  assertInvalid(doc, "zero maxEventBytes (must be positive)");
});

test("ConfigSection sseLimits: rejects unknown extra field", () => {
  const doc = cloneConfig();
  const runtime = doc.runtime as Record<string, unknown>;
  const limits = runtime.limits as Record<string, unknown>;
  (limits.sseLimits as Record<string, unknown>).bogus = 1;
  assertInvalid(doc, "unknown extra field in sseLimits");
});

// ============================================================================
// #71: evaluation section
// ============================================================================

test("ConfigSection evaluation: exists and has expected fields", () => {
  const doc = readRawConfig();
  assert.ok(typeof doc.evaluation === "object" && doc.evaluation !== null, "evaluation section must exist");
  const evaluation = doc.evaluation as Record<string, unknown>;
  assert.ok("identityAttestationTimeoutMs" in evaluation);
});

test("ConfigSection evaluation: valid values pass schema", () => {
  const doc = cloneConfig();
  (doc.evaluation as Record<string, unknown>).identityAttestationTimeoutMs = 10_000;
  assertValid(doc);
});

test("ConfigSection evaluation: rejects zero identityAttestationTimeoutMs", () => {
  const doc = cloneConfig();
  (doc.evaluation as Record<string, unknown>).identityAttestationTimeoutMs = 0;
  assertInvalid(doc, "zero identityAttestationTimeoutMs (must be positive)");
});

test("ConfigSection evaluation: rejects unknown extra field", () => {
  const doc = cloneConfig();
  (doc.evaluation as Record<string, unknown>).bogusField = true;
  assertInvalid(doc, "unknown extra field in evaluation");
});
