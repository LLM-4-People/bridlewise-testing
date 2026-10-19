import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { sha256 } from "../../src/kernel/integrity.ts";
import { deepFreeze } from "../../src/kernel/integrity.ts";
import { createTimelineStore } from "../../src/timeline/timeline-store.ts";
import {
  createTimelineRecorder,
  type TimelineRecorder,
} from "../../src/timeline/timeline-recorder.ts";
import { mkTempDir } from "../support/temp-dir.ts";

/**
 * CRIT-1 regression: every timeline document stored on disk must satisfy the
 * invariant `content_digest === sha256(exact inline text)`. Before the fix 144/732
 * documents had a mismatched digest. This test creates a document of every
 * recorder-produced type and recomputes the digest from the stored
 * chosen `content_json` or `ordered_json`, including empty text; references
 * without inline content cannot be checked here. Any future producer that fabricates or omits the digest
 * fails mechanically.
 */

function mkRecorder(dir: string, ledgerId = "ledger-digest"): TimelineRecorder {
  const store = createTimelineStore({
    path: join(dir, `digest-${Date.now()}-${Math.random().toString(36).slice(2)}.db`),
    ledgerId,
  });
  return createTimelineRecorder({ store });
}

const VALID_HASH = "a".repeat(64);

function assertEveryDocumentDigestIsValid(rec: TimelineRecorder): void {
  const all = rec.store.query({ limit: 10000 });
  for (const event of all) {
    for (const doc of event.documents) {
      assert.ok(doc.contentJson === null || doc.orderedJson === null, "at most one inline representation");
      const text = doc.contentJson ?? doc.orderedJson;
      if (text === null) continue;
      const recomputed = sha256(text);
      assert.equal(
        doc.contentDigest,
        recomputed,
        `digest mismatch for document "${doc.name}" in event ${event.eventId} (seq ${event.sequence}): ` +
          `stored=${doc.contentDigest} recomputed=${recomputed}`,
      );
    }
  }
}

test("digest-consistency: recordTokenUsage usage document digest matches sha256(content_json)", () => {
  const dir = mkTempDir("tl-digest-");
  try {
    const rec = mkRecorder(dir);
    rec.recordTokenUsage({
      promptTokens: 11,
      completionTokens: 22,
      totalTokens: 33,
      correlation: { runId: "run-1", turnId: "turn-1" },
    });
    assertEveryDocumentDigestIsValid(rec);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("digest-consistency: recordResource metric document digest matches sha256(content_json)", () => {
  const dir = mkTempDir("tl-digest-");
  try {
    const rec = mkRecorder(dir);
    rec.recordResource({
      metric: "memory",
      value: 128,
      unit: "MB",
      correlation: { runId: "run-1" },
    });
    assertEveryDocumentDigestIsValid(rec);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("digest-consistency: recordTest result document digest matches sha256(content_json)", () => {
  const dir = mkTempDir("tl-digest-");
  try {
    const rec = mkRecorder(dir);
    rec.recordTest({
      description: "unit tests",
      passed: true,
      testCount: 42,
      correlation: { runId: "run-1" },
    });
    assertEveryDocumentDigestIsValid(rec);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("digest-consistency: recordGitOperation operation document digest matches sha256(content_json)", () => {
  const dir = mkTempDir("tl-digest-");
  try {
    const rec = mkRecorder(dir);
    rec.recordGitOperation({
      operation: "commit",
      description: "commit changes",
      correlation: {},
    });
    assertEveryDocumentDigestIsValid(rec);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("digest-consistency: recordCommit commit document digest matches sha256(content_json)", () => {
  const dir = mkTempDir("tl-digest-");
  try {
    const rec = mkRecorder(dir);
    rec.recordCommit({
      commitSha: "abc123def456",
      description: "commit",
      correlation: {},
    });
    assertEveryDocumentDigestIsValid(rec);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("digest-consistency: recordFileEffect effect + preimage documents have valid digests", () => {
  const dir = mkTempDir("tl-digest-");
  try {
    const rec = mkRecorder(dir);
    const preimageContent = "old content bytes";
    const preimageDigest = sha256(preimageContent);
    rec.recordFileEffect({
      effectId: "fx-1",
      path: "/test/file.txt",
      operation: "write",
      preimageDigest,
      postimageDigest: "b".repeat(64),
      description: "write file.txt",
      correlation: { runId: "run-1" },
      preimageContent,
    });
    assertEveryDocumentDigestIsValid(rec);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("digest-consistency: recordFileEffect effect document (recorder-constructed) always has a valid digest even without preimage content", () => {
  const dir = mkTempDir("tl-digest-");
  try {
    const rec = mkRecorder(dir);
    rec.recordFileEffect({
      effectId: "fx-no-pre",
      path: "/test/other.txt",
      operation: "write",
      preimageDigest: VALID_HASH,
      postimageDigest: "c".repeat(64),
      description: "write without preimage content",
      correlation: { runId: "run-1" },
      // preimageContent omitted → only the recorder-constructed 'effect' doc exists.
    });
    // The 'effect' document is recorder-constructed: contentJson = JSON of the
    // effect object, contentDigest = sha256(effectJson). This must always hold.
    assertEveryDocumentDigestIsValid(rec);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("digest-consistency: recordFileEffect mkdir has only the effect document with valid digest", () => {
  const dir = mkTempDir("tl-digest-");
  try {
    const rec = mkRecorder(dir);
    rec.recordFileEffect({
      effectId: "fx-2",
      path: "/test/dir",
      operation: "mkdir",
      preimageDigest: VALID_HASH,
      postimageDigest: "c".repeat(64),
      description: "mkdir",
      correlation: {},
    });
    assertEveryDocumentDigestIsValid(rec);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("digest-consistency: recordRun/turn/message with prompt/response/temperature documents have valid digests", () => {
  const dir = mkTempDir("tl-digest-");
  try {
    const rec = mkRecorder(dir);
    const tempJson = JSON.stringify({ temperature: 0 });
    rec.recordRun({
      description: "run-1",
      correlation: { runId: "run-1" },
      outcome: "succeeded",
      documents: deepFreeze([
        { name: "temperature", contentJson: tempJson, contentDigest: sha256(tempJson) },
      ]),
    });
    const promptJson = JSON.stringify({ role: "user", content: "hello" });
    rec.recordMessage({
      description: "prompt",
      correlation: { runId: "run-1", messageId: "msg-1" },
      outcome: "succeeded",
      documents: deepFreeze([
        { name: "prompt", contentJson: promptJson, contentDigest: sha256(promptJson) },
      ]),
    });
    const respJson = JSON.stringify({ role: "assistant", content: "world" });
    rec.recordMessage({
      description: "response",
      correlation: { runId: "run-1", messageId: "msg-2" },
      outcome: "succeeded",
      documents: deepFreeze([
        { name: "response", contentJson: respJson, contentDigest: sha256(respJson) },
      ]),
    });
    assertEveryDocumentDigestIsValid(rec);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("digest-consistency: recordEvent with probe-response / request-body / tool-call / agent-role / topology / error documents have valid digests", () => {
  const dir = mkTempDir("tl-digest-");
  try {
    const rec = mkRecorder(dir);
    const probeObj = { content: "IDENTITY_PROBE_OK", model: "zai-org/GLM-5.2-NVFP4" };
    const probeJson = JSON.stringify(probeObj);
    rec.recordEvent({
      eventType: "provider",
      description: "capability probe",
      correlation: { runId: "run-1" },
      documents: deepFreeze([
        { name: "probe-response", contentJson: probeJson, contentDigest: sha256(probeJson) },
      ]),
    });
    const reqObj = { model: "test", messages: [], max_tokens: 256, temperature: 0, stream: true };
    const reqJson = JSON.stringify(reqObj);
    rec.recordEvent({
      eventType: "provider",
      description: "request body",
      correlation: { runId: "run-1" },
      documents: deepFreeze([
        { name: "request-body", contentJson: reqJson, contentDigest: sha256(reqJson) },
      ]),
    });
    const tcObj = { id: "call-1", name: "read_file", arguments: '{"path":"a"}' };
    const tcJson = JSON.stringify(tcObj);
    rec.recordEvent({
      eventType: "tool",
      description: "tool call",
      correlation: { runId: "run-1" },
      documents: deepFreeze([
        { name: "tool-call", contentJson: tcJson, contentDigest: sha256(tcJson) },
      ]),
    });
    const roleObj = { roleId: "r1", specialty: "implementer" };
    const roleJson = JSON.stringify(roleObj);
    rec.recordEvent({
      eventType: "agent",
      description: "agent role",
      correlation: { runId: "run-1", agentId: "r1" },
      documents: deepFreeze([
        { name: "agent-role", contentJson: roleJson, contentDigest: sha256(roleJson) },
      ]),
    });
    const topoObj = { agentCount: 3, communicationGraph: "pipeline" };
    const topoJson = JSON.stringify(topoObj);
    rec.recordEvent({
      eventType: "task",
      description: "topology",
      correlation: { runId: "run-1" },
      documents: deepFreeze([
        { name: "topology", contentJson: topoJson, contentDigest: sha256(topoJson) },
      ]),
    });
    rec.recordEvent({
      eventType: "error",
      description: "provider error",
      correlation: { runId: "run-1" },
      outcome: "failed",
      error: {
        category: "provider",
        code: "timeout",
        message: "request timed out",
        retryable: false,
      },
    });
    assertEveryDocumentDigestIsValid(rec);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("digest-consistency: full lifecycle produces no mismatched digests across every event type", () => {
  const dir = mkTempDir("tl-digest-");
  try {
    const rec = mkRecorder(dir);
    const runId = `run-${randomUUID().slice(0, 8)}`;
    rec.recordRun({ description: "run started", correlation: { runId } });
    rec.recordTurn({ description: "turn-1", correlation: { runId, turnId: "turn-1" } });
    const tempJson = JSON.stringify({ temperature: 0 });
    rec.recordEvent({
      eventType: "run",
      description: "temperature",
      correlation: { runId },
      documents: deepFreeze([
        { name: "temperature", contentJson: tempJson, contentDigest: sha256(tempJson) },
      ]),
    });
    rec.beginEffect({
      effectId: "fx-prov",
      kind: "provider",
      actor: { kind: "harness", id: "session" },
      correlation: { runId, turnId: "turn-1" },
      description: "provider request",
      intentHash: VALID_HASH,
    });
    rec.endEffect("fx-prov", { outcome: "succeeded", resultHash: VALID_HASH });
    rec.recordTokenUsage({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      correlation: { runId, turnId: "turn-1" },
    });
    rec.recordResource({
      metric: "duration_ms",
      value: 42,
      unit: "ms",
      correlation: { runId },
    });
    rec.recordTest({
      description: "oracles",
      passed: true,
      testCount: 3,
      correlation: { runId },
    });
    rec.recordGitOperation({ operation: "commit", description: "commit", correlation: {} });
    rec.recordCommit({ commitSha: "deadbeef", description: "commit", correlation: {} });
    rec.recordFileEffect({
      effectId: "fx-file",
      path: "/x/y.txt",
      operation: "write",
      preimageDigest: sha256("old"),
      postimageDigest: "b".repeat(64),
      description: "write y.txt",
      correlation: { runId },
      preimageContent: "old",
    });
    const verification = rec.verifyTimelineChain();
    assert.equal(verification.valid, true, `chain must be valid before digest check: ${verification.code}`);
    assertEveryDocumentDigestIsValid(rec);
    rec.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const kind of ["event", "intent", "terminal", "observation"] as const) {
  for (const defect of ["digest", "dual-inline", "unicode", "ordered-digest", "ordered-unicode", "ordered-limit", "empty-digest", "name-unicode"] as const) {
    test(`document admission: ${kind} refuses ${defect} before rows or chain advance`, () => {
      const dir = mkTempDir("tl-document-admission-");
      const store = createTimelineStore({ path: join(dir, "timeline.db"), ledgerId: "document", timelineConfig: { maxDocumentBytes: 64 } });
      const common = { ledgerId: "document", eventType: "provider" as const, wallTime: "2026-09-26", actor: { kind: "test", id: "author" }, description: "request" };
      try {
        if (kind === "terminal") store.appendIntent({ ...common, eventId: "origin", effectKind: "provider", effectId: "effect", intentHash: sha256("intent") });
        const text = defect.endsWith("unicode") ? "before\ud800after" : defect === "ordered-limit" ? "界".repeat(22) : defect === "empty-digest" ? "" : "{ \"b\": 2, \"a\": 1 }\n";
        const documents = [
          { name: "valid-first", contentJson: "first", contentDigest: sha256("first") },
          { name: defect === "name-unicode" ? "name\ud800" : "proof", ...(defect.startsWith("ordered-") ? { orderedJson: text } : { contentJson: defect === "name-unicode" ? "valid" : text }), contentDigest: defect.endsWith("digest") ? sha256("wrong") : sha256(defect === "name-unicode" ? "valid" : text), ...(defect === "dual-inline" ? { orderedJson: text } : {}) },
        ];
        const before = store.query(), next = store.nextSequence(), chain = store.verifyChain();
        const append = () => {
          if (kind === "intent") return store.appendIntent({ ...common, eventId: "candidate", effectKind: "provider", effectId: "effect", intentHash: sha256("intent"), documents });
          if (kind === "terminal") return store.appendTerminal({ eventId: "candidate", ledgerId: "document", eventType: "provider", effectId: "effect", outcome: "succeeded", resultHash: sha256("result"), wallTime: "2026-09-26", documents });
          if (kind === "observation") return store.appendObservation({ ...common, eventId: "candidate", observationId: "observation", evidenceHash: sha256("evidence"), documents });
          return store.appendEvent({ ...common, eventId: "candidate", documents });
        };
        assert.throws(append, (error: unknown) => error instanceof Error && "code" in error && error.code === (defect.endsWith("unicode") ? "ledger_json_unicode_invalid" : defect.endsWith("digest") ? "timeline_document_digest_mismatch" : "timeline_document_invalid"));
        assert.deepEqual(store.query(), before); assert.equal(store.nextSequence(), next); assert.deepEqual(store.verifyChain(), chain);
      } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
    });
  }
}

test("document admission: paired evidence refusal leaves the durable intents unchanged", () => {
  const dir = mkTempDir("tl-document-paired-"); const rec = mkRecorder(dir);
  try {
    const pendingIds = () => rec.pendingEffects().map((event) => event.eventId);
    const input = { effectId: "effect", kind: "provider" as const, actor: { kind: "test", id: "author" }, description: "operation", intentHash: sha256("intent") };
    const evidence = { documents: [{ name: "proof", contentJson: "actual", contentDigest: sha256("wrong") }] };
    assert.throws(() => rec.beginEffect(input, evidence), (error: unknown) => error instanceof Error && "code" in error && error.code === "timeline_document_digest_mismatch");
    assert.deepEqual(pendingIds(), []); assert.equal(rec.store.count(), 0);
    rec.beginEffect(input);
    const pending = pendingIds();
    assert.throws(() => rec.endEffect("effect", { outcome: "succeeded", resultHash: sha256("result") }, evidence), (error: unknown) => error instanceof Error && "code" in error && error.code === "timeline_document_digest_mismatch");
    assert.deepEqual(pendingIds(), pending); assert.equal(rec.store.count(), 1);
    rec.endEffect("effect", { outcome: "succeeded", resultHash: sha256("result") }, { documents: [{ name: "proof", contentJson: "actual", contentDigest: sha256("actual") }] });
    assert.equal(rec.store.count(), 2); assert.equal(rec.verifyTimelineChain().valid, true);
  } finally { rec.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("document admission: exact inline representations survive query and reopen including empty and NUL", () => {
  const dir = mkTempDir("tl-document-exact-"); const path = join(dir, "timeline.db");
  let store = createTimelineStore({ path, ledgerId: "exact" });
  const values = ["", "\u0000", "before\u0000after", "😀界", "�", "é", "e\u0301", "\ufeffraw\r\nfile\n", "{ \"b\": 2, \"a\": 1 }\n", '"\\ud800"', "{not json"];
  const documents = values.flatMap((text, index) => [
    { name: `content-${index}`, contentJson: text, contentDigest: sha256(text) },
    { name: `ordered-${index}`, orderedJson: text, contentDigest: sha256(text) },
  ]);
  documents.push({ name: "digest-only", contentDigest: sha256("reference") } as typeof documents[number]);
  try {
    const event = store.appendEvent({ eventId: "exact-event", ledgerId: "exact", eventType: "artifact", actor: { kind: "test", id: "author" }, description: "exact text", wallTime: "2026-09-26", documents });
    const expected = event.documents;
    assert.deepEqual(expected.map(({ name, contentJson, orderedJson, contentDigest }) => ({ name, contentJson, orderedJson, contentDigest })), documents.map((doc) => ({ name: doc.name, contentJson: "contentJson" in doc ? doc.contentJson : null, orderedJson: "orderedJson" in doc ? doc.orderedJson : null, contentDigest: doc.contentDigest })));
    assert.equal(expected.at(-1)!.contentJson, null); assert.equal(expected.at(-1)!.orderedJson, null);
    assert.equal(expected[0]!.contentJson, ""); assert.equal(expected[1]!.orderedJson, "");
    store.close(); store = createTimelineStore({ path, ledgerId: "exact" });
    assert.deepEqual(store.getEvent("exact-event")!.documents, expected);
    assert.deepEqual(store.query()[0]!.documents, expected);
    const raw = new DatabaseSync(path);
    try {
      assert.equal(raw.prepare("PRAGMA encoding").get()!.encoding, "UTF-8");
      const rows = raw.prepare("SELECT content_json, ordered_json, CAST(content_json AS BLOB) AS content_bytes, CAST(ordered_json AS BLOB) AS ordered_bytes FROM event_documents WHERE event_id = ? ORDER BY position").all("exact-event");
      for (const [index, text] of values.entries()) {
        assert.equal(rows[index * 2]!.content_json, text); assert.equal(rows[index * 2 + 1]!.ordered_json, text);
        assert.deepEqual(Buffer.from(rows[index * 2]!.content_bytes as Uint8Array), Buffer.from(text, "utf8"));
        assert.deepEqual(Buffer.from(rows[index * 2 + 1]!.ordered_bytes as Uint8Array), Buffer.from(text, "utf8"));
      }
    } finally { raw.close(); }
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});


test("document byte caps refuse direct store configuration before creating a database", () => {
  const dir = mkTempDir("tl-document-cap-"); const path = join(dir, "invalid.db");
  try {
    for (const maxDocumentBytes of [NaN, Infinity, -Infinity, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, ROOT_POLICY.timeline.limits.maxDocumentBytes + 1]) {
      assert.throws(() => createTimelineStore({ path, timelineConfig: { maxDocumentBytes } }), (error: unknown) => error instanceof Error && "code" in error && error.code === "timeline_document_limit_invalid");
      assert.equal(existsSync(path), false);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
