import { createHash } from 'node:crypto';
import { EVENT_TYPES, MAX_SIGNED_INT64, sha256Bytes, sha256Hex } from './schema.mjs';

export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non-finite JSON number');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new TypeError(`unsupported JSON type: ${typeof value}`);
}

function hexDigest(label) {
  return createHash('sha256').update(label).digest('hex');
}

export function makeEvent({
  ledgerId = 'main',
  ordinal,
  eventType = EVENT_TYPES[ordinal % EVENT_TYPES.length],
  causationEventId = null,
  subjectKind = 'task',
  subjectId = `task-${String(ordinal).padStart(8, '0')}`,
  actorKind = 'agent',
  actorId = `agent-${ordinal % 5}`,
  query = null,
  headers = null,
  documentBytes = 0,
} = {}) {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) throw new TypeError('ordinal must be positive');
  const eventId = `evt-${hexDigest(`${ledgerId}|${ordinal}|${eventType}`).slice(0, 40)}`;
  const redacted = query ?? {
    eventType,
    ordinal,
    summary: `synthetic qualification event ${ordinal}`,
    padding: documentBytes > 0 ? 'x'.repeat(documentBytes) : undefined,
  };
  if (redacted.padding === undefined) delete redacted.padding;
  const redactedJson = canonicalJson(redacted);
  const orderedHeaders = headers ?? [
    ['x-repeat', 'first'],
    ['X-Repeat', 'second'],
    ['content-type', 'application/json'],
  ];
  const headersJson = canonicalJson(orderedHeaders);
  const rawDigest = sha256Bytes(`raw|${ledgerId}|${ordinal}|${eventType}`);
  const redactedDigest = sha256Bytes(redactedJson);
  return {
    ledgerId,
    ordinal,
    eventId,
    eventType,
    eventSchemaVersion: 1n,
    occurredAtUs: 1_800_000_000_000_000n + BigInt(ordinal * 10),
    recordedAtUs: 1_800_000_000_000_000n + BigInt(ordinal * 10 + 1),
    monotonicNs: 5_000_000_000_000n + BigInt(ordinal),
    traceId: hexDigest(`trace|${ledgerId}|${Math.floor(ordinal / 5)}`).slice(0, 32),
    spanId: hexDigest(`span|${ledgerId}|${ordinal}`).slice(0, 16),
    parentSpanId: ordinal === 1 ? null : hexDigest(`span|${ledgerId}|${ordinal - 1}`).slice(0, 16),
    correlationId: hexDigest(`correlation|${ledgerId}`).slice(0, 32),
    causationEventId,
    subjectKind,
    subjectId,
    actorKind,
    actorId,
    rawPayloadRef: `vault:sha256:${rawDigest.toString('hex')}`,
    rawDigest,
    redactedDigest,
    redactedJson,
    headersJson,
  };
}

export function currentHead(driver, ledgerId) {
  return driver.get(
    `SELECT sequence, event_id, chain_mac FROM event_log
     WHERE ledger_id = ? ORDER BY sequence DESC LIMIT 1`,
    ledgerId,
  );
}

export function nextChainMac(event, previousChainMac) {
  const hash = createHash('sha256');
  hash.update(previousChainMac ?? Buffer.alloc(0));
  hash.update(event.ledgerId);
  hash.update('\0');
  hash.update(event.eventId);
  hash.update('\0');
  hash.update(event.eventType);
  hash.update(event.rawDigest);
  hash.update(event.redactedDigest);
  return hash.digest();
}

export function insertEventRows(driver, event, { includeDocuments = true, includeEdge = false } = {}) {
  const head = currentHead(driver, event.ledgerId);
  const sequence = head ? head.sequence + 1n : 1n;
  if (sequence > MAX_SIGNED_INT64) throw new RangeError('ledger sequence exhausted');
  const previousChainMac = head?.chain_mac ?? null;
  const chainMac = nextChainMac(event, previousChainMac);
  driver.run(
    `INSERT INTO event_log(
      ledger_id, sequence, event_id, event_type, event_schema_version,
      occurred_at_us, recorded_at_us, monotonic_ns,
      trace_id, span_id, parent_span_id, correlation_id, causation_event_id,
      subject_kind, subject_id, actor_kind, actor_id,
      raw_payload_ref, raw_content_sha256, redacted_content_sha256,
      previous_chain_mac, chain_mac, flags
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    event.ledgerId, sequence, event.eventId, event.eventType, event.eventSchemaVersion,
    event.occurredAtUs, event.recordedAtUs, event.monotonicNs,
    event.traceId, event.spanId, event.parentSpanId, event.correlationId, event.causationEventId,
    event.subjectKind, event.subjectId, event.actorKind, event.actorId,
    event.rawPayloadRef, event.rawDigest, event.redactedDigest,
    previousChainMac, chainMac, 0n,
  );
  if (includeDocuments) {
    driver.run(
      `INSERT INTO event_documents(event_id, document_kind, canonical_json, content_sha256)
       VALUES (?, 'redacted.query.v1', ?, ?)`,
      event.eventId, event.redactedJson, sha256Bytes(event.redactedJson),
    );
    driver.run(
      `INSERT INTO event_documents(event_id, document_kind, canonical_json, content_sha256)
       VALUES (?, 'redacted.headers.v1', ?, ?)`,
      event.eventId, event.headersJson, sha256Bytes(event.headersJson),
    );
  }
  if (includeEdge) {
    driver.run(
      `INSERT INTO event_edges(
        edge_id, source_event_id, relation_type, target_kind, target_id,
        target_event_id, ordinal, evidence_event_id
      ) VALUES (?, ?, 'performed_by', 'agent', ?, NULL, 0, ?)`,
      `edge-${hexDigest(`${event.eventId}|performed_by`).slice(0, 40)}`,
      event.eventId, event.actorId, event.eventId,
    );
  }
  return { sequence, chainMac };
}

export function appendEvent(driver, event, options = {}) {
  driver.exec('BEGIN IMMEDIATE');
  try {
    const result = insertEventRows(driver, event, options);
    driver.exec('COMMIT');
    return result;
  } catch (error) {
    try { driver.exec('ROLLBACK'); } catch { /* transaction already closed */ }
    throw error;
  }
}

export function rebuildProjections(driver, rebuiltAtUs = 1_900_000_000_000_000n) {
  driver.exec('BEGIN IMMEDIATE');
  try {
    driver.exec(`
      DELETE FROM timeline_projection;
      DELETE FROM entity_latest_projection;
      DELETE FROM attempt_projection;
      DELETE FROM memory_projection;
      DELETE FROM projection_offsets;
    `);
    driver.exec(`
      INSERT INTO timeline_projection(
        event_id, ledger_id, sequence, event_type, recorded_at_us,
        trace_id, correlation_id, subject_kind, subject_id, actor_kind, actor_id,
        redacted_query_json, ordered_headers_json
      )
      SELECT
        e.event_id, e.ledger_id, e.sequence, e.event_type, e.recorded_at_us,
        e.trace_id, e.correlation_id, e.subject_kind, e.subject_id, e.actor_kind, e.actor_id,
        q.canonical_json, h.canonical_json
      FROM event_log AS e
      JOIN event_documents AS q
        ON q.event_id = e.event_id AND q.document_kind = 'redacted.query.v1'
      LEFT JOIN event_documents AS h
        ON h.event_id = e.event_id AND h.document_kind = 'redacted.headers.v1';

      INSERT INTO entity_latest_projection(
        subject_kind, subject_id, event_id, recorded_at_us, redacted_state_json
      )
      SELECT subject_kind, subject_id, event_id, recorded_at_us, redacted_query_json
      FROM (
        SELECT t.*,
          row_number() OVER (
            PARTITION BY subject_kind, subject_id
            ORDER BY recorded_at_us DESC, ledger_id DESC, sequence DESC
          ) AS rank
        FROM timeline_projection AS t
      )
      WHERE rank = 1;
    `);
    const attemptRows = driver.all(`
      SELECT event_id, redacted_query_json
      FROM timeline_projection
      WHERE event_type IN ('task.completed', 'tool.error')
      ORDER BY recorded_at_us, event_id
    `);
    for (const row of attemptRows) {
      const document = JSON.parse(row.redacted_query_json);
      if (!document.attempt) continue;
      const attempt = document.attempt;
      driver.run(
        `INSERT INTO attempt_projection(
          attempt_id, task_id, result_event_id, previous_attempt_id, status,
          input_digest, context_digest, tool_digest, outcome_digest, searchable_summary
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        attempt.attemptId, attempt.taskId, row.event_id, attempt.previousAttemptId ?? null,
        attempt.status, attempt.inputDigest, attempt.contextDigest, attempt.toolDigest,
        attempt.outcomeDigest, attempt.summary,
      );
    }
    const memoryRows = driver.all(`
      SELECT event_id, redacted_query_json
      FROM timeline_projection
      WHERE event_type IN ('memory.recorded', 'memory.superseded')
      ORDER BY recorded_at_us, event_id
    `);
    for (const row of memoryRows) {
      const document = JSON.parse(row.redacted_query_json);
      if (!document.memory) continue;
      const memory = document.memory;
      driver.run(
        `INSERT INTO memory_projection(
          memory_id, version, source_event_id, parent_memory_id, parent_version,
          status, evidence_event_ids_json, searchable_summary
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        memory.memoryId, BigInt(memory.version), row.event_id,
        memory.parentMemoryId ?? null,
        memory.parentVersion === undefined || memory.parentVersion === null
          ? null : BigInt(memory.parentVersion),
        memory.status, canonicalJson(memory.evidenceEventIds), memory.summary,
      );
    }
    const ledgers = driver.all(
      `SELECT ledger_id, MAX(sequence) AS maximum_sequence
       FROM event_log GROUP BY ledger_id ORDER BY ledger_id`,
    );
    for (const ledger of ledgers) {
      const head = driver.get(
        'SELECT chain_mac FROM event_log WHERE ledger_id = ? AND sequence = ?',
        ledger.ledger_id, ledger.maximum_sequence,
      );
      for (const projectionName of ['timeline', 'entity-latest']) {
        driver.run(
          `INSERT INTO projection_offsets(
            projection_name, ledger_id, through_sequence, source_chain_mac, rebuilt_at_us
          ) VALUES (?, ?, ?, ?, ?)`,
          projectionName, ledger.ledger_id, ledger.maximum_sequence, head.chain_mac, rebuiltAtUs,
        );
      }
    }
    driver.exec('COMMIT');
  } catch (error) {
    try { driver.exec('ROLLBACK'); } catch { /* transaction already closed */ }
    throw error;
  }
}

export function schemaIdentity(driver) {
  const rows = driver.all(
    `SELECT type, name, tbl_name, sql FROM sqlite_schema
     WHERE name NOT LIKE 'sqlite_autoindex_%'
     ORDER BY type, name`,
  );
  const normalized = rows.map((row) => ({
    type: row.type,
    name: row.name,
    table: row.tbl_name,
    sql: row.sql,
  }));
  return { rows: normalized, sha256: sha256Hex(canonicalJson(normalized)) };
}

export function logicalDigest(driver) {
  const tables = ['schema_migrations', 'event_log', 'event_documents', 'event_edges',
    'timeline_projection', 'entity_latest_projection', 'attempt_projection',
    'memory_projection', 'projection_offsets'];
  const hash = createHash('sha256');
  const counts = {};
  for (const table of tables) {
    const rows = driver.all(`SELECT * FROM ${table} ORDER BY 1, 2`);
    counts[table] = rows.length;
    hash.update(table);
    hash.update('\0');
    for (const row of rows) {
      const encoded = Object.fromEntries(Object.entries(row).map(([key, value]) => [
        key,
        typeof value === 'bigint' ? `${value}n`
          : Buffer.isBuffer(value) ? `hex:${value.toString('hex')}` : value,
      ]));
      hash.update(canonicalJson(encoded));
      hash.update('\n');
    }
  }
  return { sha256: hash.digest('hex'), counts };
}

export function verifyInvariants(driver) {
  const failures = [];
  const integrity = driver.all('PRAGMA integrity_check');
  if (integrity.length !== 1 || Object.values(integrity[0])[0] !== 'ok') failures.push('integrity-check');
  const foreignKeys = driver.all('PRAGMA foreign_key_check');
  if (foreignKeys.length !== 0) failures.push(`foreign-key:${foreignKeys.length}`);
  const sequenceFailures = driver.get(`
    WITH ordered AS (
      SELECT ledger_id, sequence,
        row_number() OVER (PARTITION BY ledger_id ORDER BY sequence) AS expected
      FROM event_log
    )
    SELECT count(*) AS count FROM ordered WHERE sequence <> expected
  `).count;
  if (sequenceFailures !== 0n) failures.push(`sequence:${sequenceFailures}`);
  const chainRows = driver.all(`
    SELECT ledger_id, sequence, event_id, event_type, raw_content_sha256,
      redacted_content_sha256, previous_chain_mac, chain_mac,
      lag(chain_mac) OVER (PARTITION BY ledger_id ORDER BY sequence) AS expected_previous
    FROM event_log ORDER BY ledger_id, sequence
  `);
  for (const row of chainRows) {
    const actual = row.previous_chain_mac;
    const expected = row.expected_previous;
    if (row.sequence === 1n ? actual !== null : !Buffer.from(actual).equals(Buffer.from(expected))) {
      failures.push(`chain-link:${row.ledger_id}:${row.sequence}`);
    }
    const expectedMac = createHash('sha256')
      .update(row.expected_previous ?? Buffer.alloc(0))
      .update(row.ledger_id)
      .update('\0')
      .update(row.event_id)
      .update('\0')
      .update(row.event_type)
      .update(row.raw_content_sha256)
      .update(row.redacted_content_sha256)
      .digest();
    if (!expectedMac.equals(Buffer.from(row.chain_mac))) {
      failures.push(`chain-mac:${row.ledger_id}:${row.sequence}`);
    }
  }
  const missingDocuments = driver.get(`
    SELECT count(*) AS count FROM event_log AS e
    WHERE NOT EXISTS (
      SELECT 1 FROM event_documents AS d
      WHERE d.event_id = e.event_id AND d.document_kind = 'redacted.query.v1'
    )
  `).count;
  if (missingDocuments !== 0n) failures.push(`documents:${missingDocuments}`);
  const documents = driver.all(
    'SELECT event_id, document_kind, canonical_json, content_sha256 FROM event_documents',
  );
  for (const document of documents) {
    if (!sha256Bytes(document.canonical_json).equals(Buffer.from(document.content_sha256))) {
      failures.push(`document-digest:${document.event_id}:${document.document_kind}`);
    }
  }
  const edgeFailures = driver.get(`
    SELECT count(*) AS count FROM event_edges AS x
    LEFT JOIN event_log AS s ON s.event_id = x.source_event_id
    LEFT JOIN event_log AS t ON t.event_id = x.target_event_id
    LEFT JOIN event_log AS e ON e.event_id = x.evidence_event_id
    WHERE s.event_id IS NULL OR e.event_id IS NULL
      OR (x.target_event_id IS NOT NULL AND t.event_id IS NULL)
      OR (x.target_kind <> 'event' AND x.target_event_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM event_log AS target_proof
        WHERE target_proof.event_id = x.target_event_id
          AND (
            (target_proof.subject_kind = x.target_kind AND target_proof.subject_id = x.target_id)
            OR (target_proof.actor_kind = x.target_kind AND target_proof.actor_id = x.target_id)
          )
      ))
      OR (x.target_kind <> 'event' AND NOT EXISTS (
        SELECT 1 FROM event_log AS identity
        WHERE (identity.subject_kind = x.target_kind AND identity.subject_id = x.target_id)
           OR (identity.actor_kind = x.target_kind AND identity.actor_id = x.target_id)
      ))
  `).count;
  if (edgeFailures !== 0n) failures.push(`edges:${edgeFailures}`);
  return { ok: failures.length === 0, failures, integrity, foreignKeyErrors: foreignKeys.length };
}

export function queryCoverageDocument() {
  return {
    exactRawLocation: 'encrypted payload vault addressed by raw_payload_ref and raw_content_sha256',
    queryLocation: 'event_documents redacted source facts and rebuildable projections',
    orderedHeaders: 'redacted.headers.v1 canonical JSON array preserves order and duplicates',
    eventTypes: EVENT_TYPES,
  };
}
