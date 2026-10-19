import { createHash } from 'node:crypto';

export const MAX_SIGNED_INT64 = 9_223_372_036_854_775_807n;

export const CONFIGURATION_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA trusted_schema = OFF;
PRAGMA busy_timeout = 5000;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA wal_autocheckpoint = 1000;
PRAGMA recursive_triggers = ON;
`;

const MIGRATION_001 = `
CREATE TABLE event_log (
  ledger_id TEXT NOT NULL
    CHECK(length(ledger_id) BETWEEN 1 AND 128),
  sequence INTEGER NOT NULL
    CHECK(sequence BETWEEN 1 AND 9223372036854775807),
  event_id TEXT NOT NULL UNIQUE
    CHECK(length(event_id) BETWEEN 16 AND 160),
  event_type TEXT NOT NULL
    CHECK(length(event_type) BETWEEN 3 AND 120
      AND event_type = lower(event_type)
      AND event_type NOT GLOB '*[^a-z0-9._-]*'),
  event_schema_version INTEGER NOT NULL
    CHECK(event_schema_version BETWEEN 1 AND 2147483647),
  occurred_at_us INTEGER NOT NULL CHECK(occurred_at_us >= 0),
  recorded_at_us INTEGER NOT NULL CHECK(recorded_at_us >= occurred_at_us),
  monotonic_ns INTEGER NOT NULL CHECK(monotonic_ns >= 0),
  trace_id TEXT NOT NULL
    CHECK(length(trace_id) = 32 AND trace_id NOT GLOB '*[^0-9a-f]*'),
  span_id TEXT NOT NULL
    CHECK(length(span_id) = 16 AND span_id NOT GLOB '*[^0-9a-f]*'),
  parent_span_id TEXT
    CHECK(parent_span_id IS NULL OR
      (length(parent_span_id) = 16 AND parent_span_id NOT GLOB '*[^0-9a-f]*')),
  correlation_id TEXT NOT NULL
    CHECK(length(correlation_id) = 32 AND correlation_id NOT GLOB '*[^0-9a-f]*'),
  causation_event_id TEXT REFERENCES event_log(event_id)
    DEFERRABLE INITIALLY DEFERRED,
  subject_kind TEXT NOT NULL
    CHECK(length(subject_kind) BETWEEN 1 AND 64
      AND subject_kind = lower(subject_kind)
      AND subject_kind NOT GLOB '*[^a-z0-9._-]*'),
  subject_id TEXT NOT NULL CHECK(length(subject_id) BETWEEN 1 AND 512),
  actor_kind TEXT NOT NULL
    CHECK(length(actor_kind) BETWEEN 1 AND 64
      AND actor_kind = lower(actor_kind)
      AND actor_kind NOT GLOB '*[^a-z0-9._-]*'),
  actor_id TEXT NOT NULL CHECK(length(actor_id) BETWEEN 1 AND 512),
  raw_payload_ref TEXT NOT NULL CHECK(length(raw_payload_ref) BETWEEN 1 AND 1024),
  raw_content_sha256 BLOB NOT NULL CHECK(length(raw_content_sha256) = 32),
  redacted_content_sha256 BLOB NOT NULL CHECK(length(redacted_content_sha256) = 32),
  previous_chain_mac BLOB,
  chain_mac BLOB NOT NULL CHECK(length(chain_mac) = 32),
  flags INTEGER NOT NULL DEFAULT 0 CHECK(flags BETWEEN 0 AND 2147483647),
  PRIMARY KEY (ledger_id, sequence),
  CHECK(
    (sequence = 1 AND previous_chain_mac IS NULL)
    OR (sequence > 1 AND length(previous_chain_mac) = 32)
  ),
  CHECK(causation_event_id IS NULL OR causation_event_id <> event_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE event_documents (
  event_id TEXT NOT NULL REFERENCES event_log(event_id) ON DELETE RESTRICT,
  document_kind TEXT NOT NULL
    CHECK(document_kind IN ('redacted.query.v1', 'redacted.headers.v1')),
  canonical_json TEXT NOT NULL CHECK(json_valid(canonical_json)),
  content_sha256 BLOB NOT NULL CHECK(length(content_sha256) = 32),
  PRIMARY KEY (event_id, document_kind)
) STRICT, WITHOUT ROWID;

CREATE TABLE event_edges (
  edge_id TEXT PRIMARY KEY CHECK(length(edge_id) BETWEEN 16 AND 160),
  source_event_id TEXT NOT NULL REFERENCES event_log(event_id) ON DELETE RESTRICT,
  relation_type TEXT NOT NULL
    CHECK(length(relation_type) BETWEEN 1 AND 80
      AND relation_type = lower(relation_type)
      AND relation_type NOT GLOB '*[^a-z0-9._-]*'),
  target_kind TEXT NOT NULL
    CHECK(length(target_kind) BETWEEN 1 AND 64
      AND target_kind = lower(target_kind)
      AND target_kind NOT GLOB '*[^a-z0-9._-]*'),
  target_id TEXT NOT NULL CHECK(length(target_id) BETWEEN 1 AND 512),
  target_event_id TEXT REFERENCES event_log(event_id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 2147483647),
  evidence_event_id TEXT NOT NULL REFERENCES event_log(event_id) ON DELETE RESTRICT,
  UNIQUE(source_event_id, relation_type, ordinal),
  CHECK(
    (target_kind = 'event' AND target_event_id IS NOT NULL AND target_id = target_event_id)
    OR target_kind <> 'event'
  )
) STRICT, WITHOUT ROWID;

CREATE TRIGGER event_log_contiguous_before_insert
BEFORE INSERT ON event_log
BEGIN
  SELECT CASE WHEN NEW.sequence <> COALESCE(
    (SELECT MAX(sequence) + 1 FROM event_log WHERE ledger_id = NEW.ledger_id), 1
  ) THEN RAISE(ABORT, 'event sequence must be contiguous') END;
  SELECT CASE WHEN NEW.sequence > 1 AND NOT EXISTS (
    SELECT 1 FROM event_log
    WHERE ledger_id = NEW.ledger_id
      AND sequence = NEW.sequence - 1
      AND chain_mac = NEW.previous_chain_mac
  ) THEN RAISE(ABORT, 'previous chain MAC mismatch') END;
  SELECT CASE WHEN NEW.causation_event_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM event_log WHERE event_id = NEW.causation_event_id
  ) THEN RAISE(ABORT, 'causation event must already exist') END;
END;

CREATE TRIGGER event_log_no_update
BEFORE UPDATE ON event_log
BEGIN SELECT RAISE(ABORT, 'event_log is append-only'); END;

CREATE TRIGGER event_log_no_delete
BEFORE DELETE ON event_log
BEGIN SELECT RAISE(ABORT, 'event_log is append-only'); END;

CREATE TRIGGER event_documents_no_update
BEFORE UPDATE ON event_documents
BEGIN SELECT RAISE(ABORT, 'event_documents is append-only'); END;

CREATE TRIGGER event_documents_no_delete
BEFORE DELETE ON event_documents
BEGIN SELECT RAISE(ABORT, 'event_documents is append-only'); END;

CREATE TRIGGER event_edges_no_update
BEFORE UPDATE ON event_edges
BEGIN SELECT RAISE(ABORT, 'event_edges is append-only'); END;

CREATE TRIGGER event_edges_no_delete
BEFORE DELETE ON event_edges
BEGIN SELECT RAISE(ABORT, 'event_edges is append-only'); END;

CREATE TRIGGER event_edges_target_exists_before_insert
BEFORE INSERT ON event_edges
BEGIN
  SELECT CASE WHEN NEW.target_kind <> 'event' AND NOT EXISTS (
    SELECT 1 FROM event_log
    WHERE (subject_kind = NEW.target_kind AND subject_id = NEW.target_id)
       OR (actor_kind = NEW.target_kind AND actor_id = NEW.target_id)
  ) THEN RAISE(ABORT, 'edge target identity has no source event') END;
  SELECT CASE WHEN NEW.target_kind <> 'event' AND NEW.target_event_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM event_log
      WHERE event_id = NEW.target_event_id
        AND (
          (subject_kind = NEW.target_kind AND subject_id = NEW.target_id)
          OR (actor_kind = NEW.target_kind AND actor_id = NEW.target_id)
        )
    ) THEN RAISE(ABORT, 'edge target event does not prove target identity') END;
END;
`;

const MIGRATION_002 = `
CREATE INDEX event_log_recorded_sequence
  ON event_log(recorded_at_us, ledger_id, sequence);
CREATE INDEX event_log_type_recorded
  ON event_log(event_type, recorded_at_us);
CREATE INDEX event_log_subject_recorded
  ON event_log(subject_kind, subject_id, recorded_at_us);
CREATE INDEX event_log_trace
  ON event_log(trace_id, recorded_at_us);
CREATE INDEX event_log_correlation
  ON event_log(correlation_id, recorded_at_us);
CREATE INDEX event_log_causation
  ON event_log(causation_event_id) WHERE causation_event_id IS NOT NULL;
CREATE INDEX event_edges_source
  ON event_edges(source_event_id, relation_type, ordinal);
CREATE INDEX event_edges_target
  ON event_edges(target_kind, target_id, relation_type);

CREATE TABLE timeline_projection (
  event_id TEXT PRIMARY KEY REFERENCES event_log(event_id) ON DELETE CASCADE,
  ledger_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  recorded_at_us INTEGER NOT NULL,
  trace_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  redacted_query_json TEXT NOT NULL CHECK(json_valid(redacted_query_json)),
  ordered_headers_json TEXT CHECK(
    ordered_headers_json IS NULL OR
    (json_valid(ordered_headers_json) AND json_type(ordered_headers_json) = 'array')
  ),
  UNIQUE(ledger_id, sequence)
) STRICT, WITHOUT ROWID;

CREATE INDEX timeline_projection_subject
  ON timeline_projection(subject_kind, subject_id, recorded_at_us DESC);
CREATE INDEX timeline_projection_type
  ON timeline_projection(event_type, recorded_at_us DESC);
CREATE INDEX timeline_projection_trace
  ON timeline_projection(trace_id, recorded_at_us);

CREATE TABLE entity_latest_projection (
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  event_id TEXT NOT NULL REFERENCES event_log(event_id) ON DELETE CASCADE,
  recorded_at_us INTEGER NOT NULL,
  redacted_state_json TEXT NOT NULL CHECK(json_valid(redacted_state_json)),
  PRIMARY KEY(subject_kind, subject_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE attempt_projection (
  attempt_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  result_event_id TEXT NOT NULL REFERENCES event_log(event_id) ON DELETE CASCADE,
  previous_attempt_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('started', 'succeeded', 'failed', 'cancelled')),
  input_digest TEXT NOT NULL CHECK(length(input_digest) = 64),
  context_digest TEXT NOT NULL CHECK(length(context_digest) = 64),
  tool_digest TEXT NOT NULL CHECK(length(tool_digest) = 64),
  outcome_digest TEXT NOT NULL CHECK(length(outcome_digest) = 64),
  searchable_summary TEXT NOT NULL,
  FOREIGN KEY(previous_attempt_id) REFERENCES attempt_projection(attempt_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX attempt_projection_task
  ON attempt_projection(task_id, result_event_id);

CREATE TABLE memory_projection (
  memory_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  source_event_id TEXT NOT NULL REFERENCES event_log(event_id) ON DELETE CASCADE,
  parent_memory_id TEXT,
  parent_version INTEGER,
  status TEXT NOT NULL CHECK(status IN ('active', 'superseded', 'invalidated')),
  evidence_event_ids_json TEXT NOT NULL CHECK(
    json_valid(evidence_event_ids_json) AND json_type(evidence_event_ids_json) = 'array'
  ),
  searchable_summary TEXT NOT NULL,
  PRIMARY KEY(memory_id, version),
  FOREIGN KEY(parent_memory_id, parent_version)
    REFERENCES memory_projection(memory_id, version),
  CHECK(
    (parent_memory_id IS NULL AND parent_version IS NULL)
    OR (parent_memory_id IS NOT NULL AND parent_version IS NOT NULL)
  )
) STRICT, WITHOUT ROWID;

CREATE TABLE projection_offsets (
  projection_name TEXT NOT NULL,
  ledger_id TEXT NOT NULL,
  through_sequence INTEGER NOT NULL CHECK(through_sequence >= 0),
  source_chain_mac BLOB CHECK(source_chain_mac IS NULL OR length(source_chain_mac) = 32),
  rebuilt_at_us INTEGER NOT NULL CHECK(rebuilt_at_us >= 0),
  PRIMARY KEY(projection_name, ledger_id)
) STRICT, WITHOUT ROWID;

CREATE VIEW browsable_timeline AS
SELECT
  t.recorded_at_us,
  t.ledger_id,
  t.sequence,
  t.event_id,
  t.event_type,
  t.trace_id,
  t.correlation_id,
  e.causation_event_id,
  t.subject_kind,
  t.subject_id,
  t.actor_kind,
  t.actor_id,
  t.redacted_query_json,
  t.ordered_headers_json
FROM timeline_projection AS t
JOIN event_log AS e ON e.event_id = t.event_id;
`;

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256Bytes(value) {
  return createHash('sha256').update(value).digest();
}

export const MIGRATIONS = Object.freeze([
  Object.freeze({ version: 1, name: 'canonical-event-sources', sql: MIGRATION_001, sha256: sha256Hex(MIGRATION_001) }),
  Object.freeze({ version: 2, name: 'query-and-learning-projections', sql: MIGRATION_002, sha256: sha256Hex(MIGRATION_002) }),
]);

export const EVENT_TYPES = Object.freeze([
  'interaction.input', 'interaction.output', 'transport.headers',
  'usage.tokens', 'usage.throughput', 'provider.request', 'provider.response',
  'model.invocation', 'task.started', 'task.completed', 'subtask.started',
  'subtask.completed', 'agent.started', 'agent.message', 'agent.completed',
  'tool.call', 'tool.result', 'tool.error', 'context.snapshot',
  'memory.recorded', 'memory.superseded', 'research.query', 'research.result',
  'repository.snapshot', 'repository.edit', 'test.started', 'test.result',
  'vcs.commit', 'vcs.tag', 'vcs.checkpoint', 'vcs.rollback',
  'deployment.started', 'deployment.completed', 'error.observed',
]);

export const RELATION_TYPES = Object.freeze([
  'caused_by', 'correlated_with', 'parent_of', 'performed_by', 'used_context',
  'used_model', 'used_provider', 'invoked_tool', 'produced_edit',
  'validated_by_test', 'materialized_commit', 'tagged_as', 'checkpoint_of',
  'rolled_back_to', 'deployed_as', 'derived_from', 'attempted_after', 'remembers',
]);

export function bootstrapMigrationTable(driver) {
  driver.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY CHECK(version >= 1),
      name TEXT NOT NULL UNIQUE,
      sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
      applied_at_us INTEGER NOT NULL CHECK(applied_at_us >= 0)
    ) STRICT;
  `);
}

export function applyMigrations(driver, appliedAtUs = 1_800_000_000_000_000n) {
  bootstrapMigrationTable(driver);
  for (const migration of MIGRATIONS) {
    const existing = driver.get(
      'SELECT version, name, sha256 FROM schema_migrations WHERE version = ?',
      BigInt(migration.version),
    );
    if (existing) {
      if (existing.name !== migration.name || existing.sha256 !== migration.sha256) {
        throw new Error(`migration ${migration.version} identity mismatch`);
      }
      continue;
    }
    driver.exec('BEGIN IMMEDIATE');
    try {
      driver.exec(migration.sql);
      driver.run(
        'INSERT INTO schema_migrations(version, name, sha256, applied_at_us) VALUES (?, ?, ?, ?)',
        BigInt(migration.version), migration.name, migration.sha256, appliedAtUs + BigInt(migration.version),
      );
      driver.exec(`PRAGMA user_version = ${migration.version}`);
      driver.exec('COMMIT');
    } catch (error) {
      try { driver.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw error;
    }
  }
}
