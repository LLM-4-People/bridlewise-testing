import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { generateId, sha256 } from "../../src/kernel/integrity.ts";
import { DEFAULT_TIMELINE_QUERY_LIMIT } from "../../src/kernel/config-contracts.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { CORRELATION_FIELD_NAMES, computeChainHash } from "../../src/timeline/ledger-primitives.ts";
import { TIMELINE_RECORD_KINDS, TIMELINE_DOMAIN, TIMELINE_SCHEMA_VERSION, type TimelineStandaloneEventInput } from "../../src/timeline/timeline-types.ts";
import { createTimelineStore } from "../../src/timeline/timeline-store.ts";
import { createTimelineRecorder } from "../../src/timeline/timeline-recorder.ts";
import {
  importWorkspaceTimelineShard,
  openWorkspaceTimelineShard,
  verifyWorkspaceShardChain,
  workspaceShardDbPath,
  workspaceShardLedgerId,
  WORKSPACE_SHARD_DB_FILENAME,
  WORKSPACE_SHARDS_DIRECTORY,
} from "../../src/workflow/timeline-shard.ts";
import { mkWorkspaceTempDir } from "./workspace-test-support.ts";

function appendShardEvent(shard: ReturnType<typeof openWorkspaceTimelineShard>, description: string, extras: Record<string, unknown> = {}) {
  return shard.appendEvent({
    eventId: generateId("ws-event"),
    ledgerId: shard.ledgerId,
    eventType: "agent",
    actor: { kind: "harness", id: "workspace-manager" },
    correlation: { agentId: "worker", taskId: "worker-abc123def456" },
    description,
    wallTime: new Date().toISOString(),
    ...extras,
  } as Parameters<typeof shard.appendEvent>[0]);
}

function fixedEvent(eventId: string, ledgerId: string): TimelineStandaloneEventInput {
  return {
    eventId, ledgerId, eventType: "agent", actor: { kind: "harness", id: "workspace-manager", role: "integrator" },
    correlation: { runId: "run-shard", sessionId: "session-shard", turnId: "turn-shard", messageId: "message-shard", taskId: "task-shard", attemptId: "attempt-shard", agentId: "agent-shard", parentEffectId: "effect-upstream" },
    description: eventId, wallTime: "2026-09-26T12:00:00.000Z", monotonicNanoseconds: "1234", traceId: "trace-shard", spanId: "span-shard",
  };
}

for (const fullPages of [1, 2]) {
  test(`shard import walks ${fullPages} full query pages plus one row including an already imported page and cross-page raw attachments`, () => {
    const total = DEFAULT_TIMELINE_QUERY_LIMIT * fullPages + 1;
    const root = mkWorkspaceTempDir("ws-shard-pages");
    const shard = openWorkspaceTimelineShard({ stateRootAbsolute: root, workspaceId: "pages" });
    const targetPath = join(root, "canonical.db");
    let canonical = createTimelineStore({ path: targetPath, ledgerId: "canonical" });
    try {
      for (let index = 0; index < total; index++) {
        const eventId = `page-${index}`;
        const raw = `  {\"index\":${index},\"a\":1} \u0000suffix`;
        const input = {
          ...fixedEvent(eventId, shard.ledgerId),
          ...(index > 0 ? { parentEventId: `page-${index - 1}`, edges: [{ edgeType: "causal" as const, targetEventId: `page-${index - 1}` }] } : {}),
          documents: [{ name: "empty", contentJson: "", contentDigest: sha256("") }, { name: "ordered", orderedJson: raw, contentDigest: sha256(raw) }, { name: "reference", contentDigest: sha256("external") }],
        };
        shard.appendEvent(input);
        if (index < DEFAULT_TIMELINE_QUERY_LIMIT) canonical.appendEvent({ ...input, ledgerId: canonical.ledgerId });
      }
      const source = shard.query({ limit: total });
      assert.deepEqual(importWorkspaceTimelineShard({ shard, canonical }), { sourceEvents: total, imported: total - DEFAULT_TIMELINE_QUERY_LIMIT, skipped: DEFAULT_TIMELINE_QUERY_LIMIT });
      canonical.close();
      canonical = createTimelineStore({ path: targetPath, ledgerId: "canonical" });
      assert.equal(canonical.count(), total);
      assert.deepEqual(canonical.query({ limit: total }).map(event => event.eventId), source.map(event => event.eventId));
      for (const index of [DEFAULT_TIMELINE_QUERY_LIMIT, total - 1]) {
        const event = canonical.getEvent(`page-${index}`)!;
        assert.equal(event.parentEventId, `page-${index - 1}`);
        assert.equal(event.edges[0]!.targetEventId, `page-${index - 1}`);
        assert.deepEqual(event.documents.map(({ name, contentJson, orderedJson, contentDigest }) => ({ name, contentJson, orderedJson, contentDigest })), source[index]!.documents.map(({ name, contentJson, orderedJson, contentDigest }) => ({ name, contentJson, orderedJson, contentDigest })));
      }
      assert.deepEqual(importWorkspaceTimelineShard({ shard, canonical }), { sourceEvents: total, imported: 0, skipped: total });
      assert.deepEqual(shard.query({ limit: total }), source);
      assert.equal(shard.verifyChain().valid, true);
      assert.equal(canonical.verifyChain().valid, true);
    } finally { shard.close(); canonical.close(); }
  });
}

/** One same-ID divergence: the second ledger's copy differs in `difference` only. */
function assertSameIdDivergenceRefused(difference: string): void {
  const root = mkWorkspaceTempDir("ws-shard-conflict");
  const shard = openWorkspaceTimelineShard({ stateRootAbsolute: root, workspaceId: "conflict" });
  const canonical = createTimelineStore({ path: join(root, "canonical.db"), ledgerId: "canonical" });
  try {
    const docs = [{ name: "first", contentJson: " \u0000raw", contentDigest: sha256(" \u0000raw") }, { name: "second", contentJson: "", contentDigest: sha256("") }];
    const input = { ...fixedEvent("same-id", shard.ledgerId), documents: docs };
    shard.appendEvent(input);
    const writer = difference === "foreign-ledger" ? createTimelineStore({ path: join(root, "canonical.db"), ledgerId: "foreign" }) : canonical;
    try { writer.appendEvent({ ...input, ledgerId: writer.ledgerId,
      ...(difference === "actor" ? { actor: { kind: "harness", id: "different" } } : {}),
      ...(difference === "actor-role" ? { actor: { ...input.actor, role: "different" } } : {}),
      ...(CORRELATION_FIELD_NAMES.some(name => name === difference) ? { correlation: { ...input.correlation, [difference]: "different" } } : {}),
      ...(difference === "event-type" ? { eventType: "cost" } : {}),
      ...(difference === "description" ? { description: "different" } : {}),
      ...(difference === "wall-time" ? { wallTime: "2026-09-26T12:00:01.000Z" } : {}),
      ...(difference === "monotonic-time" ? { monotonicNanoseconds: "1235" } : {}),
      ...(difference === "trace" ? { traceId: "different" } : {}),
      ...(difference === "span" ? { spanId: "different" } : {}),
      ...(difference === "parent" ? { parentEventId: "same-id" } : {}),
      ...(difference === "payload-ref" ? { payloadRef: "different" } : {}),
      ...(difference === "payload-digest" ? { payloadDigest: sha256("different") } : {}),
      ...(difference === "outcome" ? { outcome: "succeeded" } : {}),
      ...(difference === "error" ? { error: { category: "external", code: "changed", message: "changed", retryable: false } } : {}),
      ...(difference === "edge" ? { edges: [{ edgeType: "causal", targetKind: "external", targetId: "different" }] } : {}),
      ...(difference === "document-text" ? { documents: [{ ...docs[0]!, contentJson: "changed", contentDigest: sha256("changed") }, docs[1]!] } : {}),
      ...(difference === "document-representation" ? { documents: [{ name: "first", orderedJson: docs[0]!.contentJson, contentDigest: docs[0]!.contentDigest }, docs[1]!] } : {}),
      ...(difference === "document-order" ? { documents: [...docs].reverse() } : {}),
    }); } finally { if (writer !== canonical) writer.close(); }
    const before = canonical.getEvent("same-id");
    assert.throws(() => importWorkspaceTimelineShard({ shard, canonical }), difference === "foreign-ledger" ? { code: "ERR_SQLITE_ERROR", errcode: 1555 } : { code: "workspace_shard_identity_conflict" });
    assert.deepEqual(canonical.getEvent("same-id"), before);
    assert.equal(shard.count(), 1);
    assert.equal(canonical.count({ ledgerId: difference === "foreign-ledger" ? "foreign" : "canonical" }), 1);
  } finally { shard.close(); canonical.close(); }
}

for (const difference of [
  "actor", "actor-role", "document-text", "document-representation", "document-order", "foreign-ledger", "event-type",
  "description", "wall-time", "monotonic-time", "trace", "span", "parent", "payload-ref", "payload-digest", "outcome", "error", "edge",
] as const) {
  test(`same ID refuses divergent ${difference} without changing either ledger`, () => assertSameIdDivergenceRefused(difference));
}

// One registration over the OWNER's list, so a correlation field added
// tomorrow is covered without restating the list here.
test("same ID refuses a divergent value in every correlation field without changing either ledger", () => {
  for (const field of CORRELATION_FIELD_NAMES) assertSameIdDivergenceRefused(field);
});

test("bounded import detects a real second-connection append at the page boundary without chasing it", () => {
  const root = mkWorkspaceTempDir("ws-shard-growing");
  const shard = openWorkspaceTimelineShard({ stateRootAbsolute: root, workspaceId: "growing" });
  const writer = openWorkspaceTimelineShard({ stateRootAbsolute: root, workspaceId: "growing" });
  const canonical = createTimelineStore({ path: join(root, "canonical.db"), ledgerId: "canonical" });
  try {
    for (let index = 0; index < 5; index++) shard.appendEvent(fixedEvent(`initial-${index}`, shard.ledgerId));
    const initialTip = shard.querySummaries({ ascending: false, limit: 1 })[0]!.sequence;
    const requests: Parameters<typeof shard.query>[0][] = [];
    const source = { ...shard, query(filter: Parameters<typeof shard.query>[0]) {
      requests.push(filter);
      const page = shard.query(filter);
      if (requests.length === 1) writer.appendEvent(fixedEvent("late-write", writer.ledgerId));
      return page;
    } };
    assert.throws(() => importWorkspaceTimelineShard({ shard: source, canonical, queryDefaultLimit: 2 }), { code: "workspace_shard_source_changed" });
    assert.equal(requests.length, 3, "the finite initial tip needs exactly three pages");
    assert.ok(requests.every(request => request?.limit === 2 && request.ascending === true && request.toSequence === initialTip));
    assert.deepEqual(requests.map(request => request?.cursor), [undefined, "2", "4"]);
    assert.equal(canonical.count(), 5, "the committed initial prefix remains");
    assert.equal(canonical.getEvent("late-write"), undefined);
    assert.equal(shard.count(), 6);
    assert.deepEqual(importWorkspaceTimelineShard({ shard, canonical, queryDefaultLimit: 2 }), { sourceEvents: 6, imported: 1, skipped: 5 });
    assert.equal(shard.verifyChain().valid, true);
    assert.equal(canonical.verifyChain().valid, true);
  } finally { writer.close(); shard.close(); canonical.close(); }
});

for (const fault of ["empty", "repeat", "outside-tip", "wrong-ledger", "oversized-page"] as const) {
  test(`bounded import refuses ${fault} page progress and retains its valid prefix`, () => {
    const root = mkWorkspaceTempDir("ws-shard-progress");
    const shard = openWorkspaceTimelineShard({ stateRootAbsolute: root, workspaceId: "progress" });
    const canonical = createTimelineStore({ path: join(root, "canonical.db"), ledgerId: "canonical" });
    try {
      for (let index = 0; index < 3; index++) shard.appendEvent(fixedEvent(`progress-${index}`, shard.ledgerId));
      let calls = 0;
      const source = { ...shard, query(filter: Parameters<typeof shard.query>[0]) {
        if (++calls === 1) return shard.query(filter);
        const page = shard.query(filter);
        switch (fault) {
          case "empty": return [];
          case "repeat": return shard.query({ limit: 1 });
          case "outside-tip": return [{ ...page[0]!, sequence: "4" }];
          case "wrong-ledger": return [{ ...page[0]!, ledgerId: "other" }];
          case "oversized-page": return shard.query({ limit: 3 });
        }
      } };
      assert.throws(() => importWorkspaceTimelineShard({ shard: source, canonical, queryDefaultLimit: 1 }), { code: "workspace_shard_progress_invalid" });
      assert.equal(calls, 2);
      assert.equal(canonical.count(), 1);
      assert.equal(shard.count(), 3);
    } finally { shard.close(); canonical.close(); }
  });
}

test("empty import and invalid query capacities do not append or silently ignore invalid limits", () => {
  const root = mkWorkspaceTempDir("ws-shard-empty");
  const shard = openWorkspaceTimelineShard({ stateRootAbsolute: root, workspaceId: "empty" });
  const canonical = createTimelineStore({ path: join(root, "canonical.db"), ledgerId: "canonical" });
  try {
    assert.deepEqual(importWorkspaceTimelineShard({ shard, canonical }), { sourceEvents: 0, imported: 0, skipped: 0 });
    for (const queryDefaultLimit of [0, -1, 0.5, NaN, Infinity, ROOT_POLICY.timeline.limits.maxDocuments + 1]) {
      assert.throws(() => importWorkspaceTimelineShard({ shard, canonical, queryDefaultLimit }), { code: "workspace_shard_query_limit_invalid" });
    }
    assert.equal(canonical.count(), 0);
  } finally { shard.close(); canonical.close(); }
});

test("valid-chain legacy invalid non-null outcome is refused before matching-ID comparison", () => {
  const root = mkWorkspaceTempDir("ws-shard-outcome");
  const shard = openWorkspaceTimelineShard({ stateRootAbsolute: root, workspaceId: "outcome" });
  const canonical = createTimelineStore({ path: join(root, "canonical.db"), ledgerId: "canonical" });
  const raw = new DatabaseSync(workspaceShardDbPath(root, "outcome"));
  try {
    const input = fixedEvent("legacy-outcome", shard.ledgerId);
    const original = shard.appendEvent(input);
    canonical.appendEvent(fixedEvent("legacy-outcome", canonical.ledgerId));
    const trigger = raw.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name='event_log' AND sql LIKE '%BEFORE UPDATE%'").get() as { name: string; sql: string };
    raw.exec(`DROP TRIGGER ${trigger.name}`);
    // A narrowly authored legacy envelope uses the shared hash authority,
    // so source-chain refusal cannot make the outcome guard vacuous.
    const hash = computeChainHash(TIMELINE_DOMAIN, original.previousChainHash, { ...input, schemaVersion: TIMELINE_SCHEMA_VERSION, recordKind: "event", sequence: original.sequence, outcome: "legacy-invalid", previousChainHash: "" });
    try { raw.prepare("UPDATE event_log SET outcome = ?, chain_hash = ? WHERE event_id = ?").run("legacy-invalid", hash, "legacy-outcome"); }
    finally { raw.exec(trigger.sql); }
    const before = shard.getEvent("legacy-outcome");
    assert.equal(shard.verifyChain().valid, true, "outcome admission is independently exercised on a valid chain");
    assert.throws(() => importWorkspaceTimelineShard({ shard, canonical }), { code: "workspace_shard_outcome_invalid" });
    assert.deepEqual(shard.getEvent("legacy-outcome"), before);
    assert.equal(canonical.getEvent("legacy-outcome")!.outcome, null);
    assert.equal(canonical.count(), 1);
  } finally { raw.close(); shard.close(); canonical.close(); }
});

for (const corruption of ["sequence", "previous-hash", "record-hash"] as const) {
  for (const badIndex of [0, 2]) {
    for (const existing of [false, true]) {
      test(`source chain ${corruption} at ${badIndex} refuses before destination access with existing=${existing}`, () => {
        const root = mkWorkspaceTempDir("ws-chain-refusal");
        const shard = openWorkspaceTimelineShard({ stateRootAbsolute: root, workspaceId: "corruption" });
        const canonical = createTimelineStore({ path: join(root, "canonical.db"), ledgerId: "canonical" });
        const raw = new DatabaseSync(workspaceShardDbPath(root, "corruption"));
        try {
          for (let index = 0; index < 3; index++) {
            shard.appendEvent(fixedEvent(`chain-${index}`, shard.ledgerId));
            if (existing) canonical.appendEvent(fixedEvent(`chain-${index}`, canonical.ledgerId));
          }
          const trigger = raw.prepare("SELECT sql FROM sqlite_master WHERE name='event_log_no_update'").get()!;
          raw.exec("DROP TRIGGER event_log_no_update");
          try {
            if (corruption === "sequence") raw.prepare("UPDATE event_log SET sequence=? WHERE event_id=?").run(badIndex === 0 ? 0 : 4, `chain-${badIndex}`);
            if (corruption === "previous-hash") raw.prepare("UPDATE event_log SET previous_chain_hash=? WHERE event_id=?").run("f".repeat(64), `chain-${badIndex}`);
            if (corruption === "record-hash") raw.prepare("UPDATE event_log SET chain_hash=? WHERE event_id=?").run("f".repeat(64), `chain-${badIndex}`);
          } finally { raw.exec(String(trigger.sql)); }
          assert.equal(shard.verifyChain().valid, false);
          const sourceBefore = shard.query(), targetBefore = canonical.query();
          let targetAccesses = 0;
          const target = { ...canonical, getEvent(id: string) { targetAccesses++; return canonical.getEvent(id); }, appendEvent(input: Parameters<typeof canonical.appendEvent>[0]) { targetAccesses++; return canonical.appendEvent(input); } };
          assert.throws(() => importWorkspaceTimelineShard({ shard, canonical: target, queryDefaultLimit: 1 }), { code: "workspace_shard_chain_invalid" });
          assert.equal(targetAccesses, 0, "verification finishes before any target lookup, skip or append");
          assert.deepEqual(shard.query(), sourceBefore);
          assert.deepEqual(canonical.query(), targetBefore);
          assert.equal(canonical.verifyChain().valid, true);
        } finally { raw.close(); shard.close(); canonical.close(); }
      });
    }
  }
}

test("source verification uses one finite native snapshot and refuses second-connection growth before target access", (t) => {
  const root = mkWorkspaceTempDir("ws-chain-snapshot");
  const shard = openWorkspaceTimelineShard({ stateRootAbsolute: root, workspaceId: "snapshot" });
  const writer = openWorkspaceTimelineShard({ stateRootAbsolute: root, workspaceId: "snapshot" });
  const canonical = createTimelineStore({ path: join(root, "canonical.db"), ledgerId: "canonical" });
  let steps = 0, targetAccesses = 0, returns = 0;
  try {
    for (let index = 0; index < 3; index++) shard.appendEvent(fixedEvent(`snapshot-${index}`, shard.ledgerId));
    const prepare = DatabaseSync.prototype.prepare;
    const injection = t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      const statement = prepare.call(this, sql);
      if (sql.startsWith("SELECT ledger_id, event_id, record_kind, event_type")) {
        const iterate = statement.iterate;
        t.mock.method(statement, "iterate", function (this: typeof statement, ...args: Parameters<typeof iterate>) {
          const rows = iterate.apply(this, args) as ReturnType<typeof iterate> & Required<Pick<ReturnType<typeof iterate>, "return">>;
          const next = rows.next, finish = rows.return;
          assert.equal(typeof finish, "function");
          t.mock.method(rows, "next", function () {
            const result = next.call(rows);
            if (++steps === 1) writer.appendEvent(fixedEvent("after-snapshot", writer.ledgerId));
            return result;
          });
          t.mock.method(rows, "return", function () { returns++; return finish.call(rows); });
          return rows;
        });
      }
      return statement;
    });
    const target = { ...canonical, getEvent(id: string) { targetAccesses++; return canonical.getEvent(id); }, appendEvent(input: Parameters<typeof canonical.appendEvent>[0]) { targetAccesses++; return canonical.appendEvent(input); } };
    assert.throws(() => importWorkspaceTimelineShard({ shard, canonical: target }), { code: "workspace_shard_source_changed" });
    assert.equal(steps, 4, "native snapshot visits three original rows then done");
    assert.equal(returns, 1);
    assert.equal(targetAccesses, 0);
    assert.equal(shard.count(), 4);
    assert.equal(canonical.count(), 0);
    injection.mock.restore();
    assert.deepEqual(importWorkspaceTimelineShard({ shard, canonical }), { sourceEvents: 4, imported: 4, skipped: 0 });
  } finally { writer.close(); shard.close(); canonical.close(); }
});

for (const representation of ["content", "ordered", "empty", "dual", "digest-shape", "later-digest", "valid-over-current-cap"] as const) {
  test(`matching historical ${representation} documents receive integrity admission before skip`, () => {
    const root = mkWorkspaceTempDir("ws-matching-documents");
    const shard = openWorkspaceTimelineShard({ stateRootAbsolute: root, workspaceId: "documents" });
    const targetPath = join(root, "canonical.db");
    const canonical = createTimelineStore({ path: targetPath, ledgerId: "canonical", timelineConfig: { maxDocumentBytes: 1 } });
    const sourceRaw = new DatabaseSync(workspaceShardDbPath(root, "documents")), targetRaw = new DatabaseSync(targetPath);
    try {
      shard.appendEvent(fixedEvent("historical", shard.ledgerId)); canonical.appendEvent(fixedEvent("historical", canonical.ledgerId));
      const content = representation === "ordered" ? null : representation === "empty" ? "" : " exact \u0000 historical bytes ";
      const ordered = representation === "ordered" || representation === "dual" ? " ordered \u0000 bytes " : null;
      const digest = representation === "valid-over-current-cap" ? sha256(content!) : representation === "digest-shape" ? "invalid" : sha256("different");
      for (const raw of [sourceRaw, targetRaw]) {
        if (representation === "later-digest") raw.prepare("INSERT INTO event_documents (event_id,position,name,content_json,content_digest) VALUES ('historical',0,'first','valid',?)").run(sha256("valid"));
        raw.prepare("INSERT INTO event_documents (event_id,position,name,content_json,ordered_json,content_digest) VALUES ('historical',?,'legacy',?,?,?)").run(representation === "later-digest" ? 1 : 0, content, ordered, digest);
      }
      const before = [shard.getEvent("historical"), canonical.getEvent("historical")];
      assert.equal(shard.verifyChain().valid, true, "event chain excludes attachment bytes");
      if (representation === "valid-over-current-cap") assert.deepEqual(importWorkspaceTimelineShard({ shard, canonical }), { sourceEvents: 1, imported: 0, skipped: 1 });
      else assert.throws(() => importWorkspaceTimelineShard({ shard, canonical }), { code: representation === "dual" || representation === "digest-shape" ? "timeline_document_invalid" : "timeline_document_digest_mismatch" });
      assert.deepEqual([shard.getEvent("historical"), canonical.getEvent("historical")], before);
      assert.equal(canonical.count(), 1);
      assert.equal(canonical.verifyChain().valid, true);
    } finally { sourceRaw.close(); targetRaw.close(); shard.close(); canonical.close(); }
  });
}

/** The shard refuses importing an actual `recordKind` record. */
function assertShardRecordKindRefused(recordKind: (typeof TIMELINE_RECORD_KINDS)[number], alreadyPresent: boolean): void {
  const root = mkWorkspaceTempDir("ws-shard-kind");
  const shard = openWorkspaceTimelineShard({ stateRootAbsolute: root, workspaceId: "kind" });
  const canonical = createTimelineStore({ path: join(root, "canonical.db"), ledgerId: "canonical" });
  try {
    shard.appendIntent({ ...fixedEvent("intent", shard.ledgerId), effectKind: "agent", effectId: "effect", intentHash: sha256("intent") });
    shard.appendTerminal({ eventId: "terminal", ledgerId: shard.ledgerId, eventType: "agent", effectId: "effect", outcome: "succeeded", resultHash: sha256("result"), wallTime: "2026-09-26T12:00:00.000Z" });
    shard.appendObservation({ ...fixedEvent("observation", shard.ledgerId), effectId: "effect", observationId: "observation-id", evidenceHash: sha256("observation") });
    if (alreadyPresent) canonical.appendEvent(fixedEvent(recordKind, canonical.ledgerId));
    const selected = { ...shard, query: (filter: Parameters<typeof shard.query>[0]) => shard.query({ ...filter, recordKind }), querySummaries: (filter: Parameters<typeof shard.querySummaries>[0]) => shard.querySummaries({ ...filter, recordKind }) };
    assert.throws(() => importWorkspaceTimelineShard({ shard: selected, canonical }), { code: "workspace_shard_record_kind_unsupported" });
    assert.equal(canonical.count(), alreadyPresent ? 1 : 0);
    assert.equal(shard.count(), 3);
    assert.equal(shard.verifyChain().valid, true);
  } finally { shard.close(); canonical.close(); }
}

for (const alreadyPresent of [false, true]) {
  test(`shard import refuses every non-event record kind with existing ID=${alreadyPresent}`, () => {
    for (const recordKind of TIMELINE_RECORD_KINDS.filter((kind) => kind !== "event")) {
      assertShardRecordKindRefused(recordKind, alreadyPresent);
    }
  });
}

test("shard ledger id and db path are derived from the workspace id", () => {
  assert.equal(workspaceShardLedgerId("worker-abc123def456"), "workspace-worker-abc123def456");
  const dbPath = workspaceShardDbPath("/state", "worker-abc123def456");
  assert.equal(dbPath, join("/state", WORKSPACE_SHARDS_DIRECTORY, "worker-abc123def456", WORKSPACE_SHARD_DB_FILENAME));
});

test("shard import is idempotent by event identity and preserves the chain", () => {
  const stateRoot = mkWorkspaceTempDir("ws-shard");
  const shard = openWorkspaceTimelineShard({ stateRootAbsolute: stateRoot, workspaceId: "worker-abc123def456" });
  const first = appendShardEvent(shard, "workspace-created", {
    documents: [{ name: "lease", contentDigest: sha256("lease-bytes") }],
  });
  appendShardEvent(shard, "workspace-validated", {
    parentEventId: first.eventId,
    edges: [{ edgeType: "causal", targetEventId: first.eventId }],
    outcome: "succeeded",
  });
  appendShardEvent(shard, "workspace-merged");

  const shardVerification = verifyWorkspaceShardChain(shard);
  assert.equal(shardVerification.valid, true);
  assert.equal(shardVerification.verifiedRecords, 3);

  const canonical = createTimelineStore({ path: join(stateRoot, "canonical.db"), ledgerId: "workspace-integrator" });
  try {
    const firstImport = importWorkspaceTimelineShard({ shard, canonical });
    assert.deepEqual(firstImport, { sourceEvents: 3, imported: 3, skipped: 0 });

    const secondImport = importWorkspaceTimelineShard({ shard, canonical });
    assert.deepEqual(secondImport, { sourceEvents: 3, imported: 0, skipped: 3 });

    const canonicalVerification = canonical.verifyChain();
    assert.equal(canonicalVerification.valid, true);
    assert.equal(canonicalVerification.verifiedRecords, 3);

    const imported = canonical.getEvent(first.eventId);
    assert.ok(imported !== undefined);
    assert.equal(imported.description, "workspace-created");
    assert.equal(imported.documents.length, 1);
    assert.equal(imported.documents[0]!.name, "lease");

    const events = canonical.query({ ledgerId: "workspace-integrator" });
    const withEdge = events.find((event) => event.description === "workspace-validated");
    assert.ok(withEdge !== undefined);
    assert.equal(withEdge.edges.length, 1);
    assert.equal(withEdge.edges[0]!.edgeType, "causal");
    assert.equal(withEdge.edges[0]!.targetEventId, first.eventId);
    assert.equal(withEdge.outcome, "succeeded");
    assert.equal(withEdge.agentId, "worker");
  } finally {
    shard.close();
    canonical.close();
  }
});

test("a protected pre-image crosses a shard import with its ORIGINAL: re-sealed in the canonical ledger, restored exactly there, skipped on re-import; a seal that cannot be opened refuses the import (a3-correctness H-1)", () => {
  const stateRoot = mkWorkspaceTempDir("ws-shard-sealed");
  const env = "APP=1\nGITHUB_TOKEN=ghp_AAAAAAAAAAAAAAAAAAAAAAAA\n";
  const record = (workspaceId: string) => {
    const shard = openWorkspaceTimelineShard({ stateRootAbsolute: stateRoot, workspaceId });
    createTimelineRecorder({ store: shard }).recordFileEffect({ effectId: `fx-${workspaceId}`, path: "/p/.env", operation: "write", preimageDigest: sha256(env), postimageDigest: "a".repeat(64), description: "agent edits .env", correlation: {}, preimageContent: env });
    return shard;
  };
  const preimageOf = (store: ReturnType<typeof createTimelineStore>) => store.query({ eventType: "file-effect" })[0]!.documents.find((document) => document.name === "preimage")!;
  const shard = record("sealed");
  const canonical = createTimelineStore({ path: join(stateRoot, "canonical.db"), ledgerId: "workspace-integrator" });
  const tampered = record("tampered");
  const refusing = createTimelineStore({ path: join(stateRoot, "refusing.db"), ledgerId: "workspace-integrator" });
  try {
    assert.equal(preimageOf(shard).projectionDisposition, "protected", "the shard masked and sealed it");
    assert.deepEqual(importWorkspaceTimelineShard({ shard, canonical }), { sourceEvents: 1, imported: 1, skipped: 0 });
    const imported = preimageOf(canonical);
    assert.equal(imported.projectionDisposition, "protected", "re-projected and re-sealed under the canonical key, never labelled exact");
    assert.equal(imported.contentJson!.includes("ghp_"), false);
    let restored: string | undefined;
    createTimelineRecorder({ store: canonical }).rollback.execute({ targetSequence: "0", fileRestorer: { canRestore: () => true, restore: (effect) => { restored = effect.documents.find((document) => document.name === "preimage")!.contentJson!; return true; } } });
    assert.equal(restored, env, "a canonical rollback restores the exact bytes");
    assert.deepEqual(importWorkspaceTimelineShard({ shard, canonical }), { sourceEvents: 1, imported: 0, skipped: 1 }, "a re-import compares originals and skips");
    // A seal that cannot be opened (an extra chunk the append-only triggers let in) refuses the import; nothing is imported.
    const raw = new DatabaseSync(workspaceShardDbPath(stateRoot, "tampered"));
    try {
      const { doc_id: docId } = raw.prepare("SELECT doc_id FROM event_document_originals LIMIT 1").get() as { doc_id: number };
      raw.prepare("INSERT INTO event_document_originals (doc_id, chunk, sealed) VALUES (?, 7, 'not-a-seal')").run(docId);
    } finally { raw.close(); }
    assert.throws(() => importWorkspaceTimelineShard({ shard: tampered, canonical: refusing }), { code: "workspace_shard_original_unavailable" });
    assert.equal(refusing.query().length, 0, "a masked copy is never imported in the original's place");
  } finally {
    shard.close(); canonical.close(); tampered.close(); refusing.close();
  }
});

test("import into a canonical ledger that already holds unrelated events keeps both", () => {
  const stateRoot = mkWorkspaceTempDir("ws-shard-mix");
  const canonical = createTimelineStore({ path: join(stateRoot, "canonical.db"), ledgerId: "workspace-integrator" });
  const shard = openWorkspaceTimelineShard({ stateRootAbsolute: stateRoot, workspaceId: "worker-abc123def456" });
  try {
    canonical.appendEvent({
      eventId: generateId("pre-existing"),
      ledgerId: canonical.ledgerId,
      eventType: "agent",
      actor: { kind: "harness", id: "workspace-manager" },
      description: "unrelated canonical event",
      wallTime: new Date().toISOString(),
    });
    appendShardEvent(shard, "workspace-created");
    const result = importWorkspaceTimelineShard({ shard, canonical });
    assert.equal(result.imported, 1);
    const verification = canonical.verifyChain();
    assert.equal(verification.valid, true);
    assert.equal(verification.verifiedRecords, 2);
  } finally {
    shard.close();
    canonical.close();
  }
});


test("shard import refuses legacy invalid inline documents without rewriting source or its valid prefix", () => {
  const stateRoot = mkWorkspaceTempDir("ws-shard-documents"); const workspaceId = "worker-abc123def456";
  const shard = openWorkspaceTimelineShard({ stateRootAbsolute: stateRoot, workspaceId });
  const canonical = createTimelineStore({ path: join(stateRoot, "canonical.db"), ledgerId: "integrator" });
  const raw = new DatabaseSync(workspaceShardDbPath(stateRoot, workspaceId));
  try {
    const prefix = appendShardEvent(shard, "valid prefix", { documents: [{ name: "ordered", orderedJson: " \u0000ordered\r\n", contentDigest: sha256(" \u0000ordered\r\n") }] });
    const invalid = appendShardEvent(shard, "legacy invalid");
    const later = appendShardEvent(shard, "later");
    // Simulate an old writer's permitted attachment without editing its event
    // or disabling any append-only trigger. Document bytes are outside the chain.
    raw.prepare("INSERT INTO event_documents (event_id, position, name, content_json, ordered_json, content_digest) VALUES (?, 0, 'legacy', ?, NULL, ?)").run(invalid.eventId, "original\u0000bytes", sha256("different"));
    const before = shard.query();
    const bytesBefore = raw.prepare("SELECT *, CAST(content_json AS BLOB) AS raw_bytes FROM event_documents ORDER BY doc_id").all();
    assert.equal(shard.verifyChain().valid, true, "chain validity does not authenticate attachments");
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.throws(() => importWorkspaceTimelineShard({ shard, canonical }), (error: unknown) => error instanceof Error && "code" in error && error.code === "timeline_document_digest_mismatch");
      assert.equal(canonical.count(), 1, "imports commit one event at a time; the valid prefix remains");
      assert.deepEqual(canonical.getEvent(prefix.eventId)!.documents.map(({ docId: _id, eventId: _event, ...document }) => document), prefix.documents.map(({ docId: _id, eventId: _event, ...document }) => document));
      assert.equal(canonical.getEvent(invalid.eventId), undefined); assert.equal(canonical.getEvent(later.eventId), undefined);
      assert.deepEqual(shard.query(), before);
      assert.deepEqual(raw.prepare("SELECT *, CAST(content_json AS BLOB) AS raw_bytes FROM event_documents ORDER BY doc_id").all(), bytesBefore);
      assert.equal(canonical.verifyChain().valid, true);
    }
  } finally { raw.close(); shard.close(); canonical.close(); }
});
