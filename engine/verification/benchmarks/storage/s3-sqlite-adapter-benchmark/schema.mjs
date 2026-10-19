// One closed schema and one closed SQL set are shared by both benchmark adapters.

export const CONFIGURE_SQL = `
PRAGMA foreign_keys = ON;
PRAGMA trusted_schema = OFF;
PRAGMA busy_timeout = 5000;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA wal_autocheckpoint = 1000;
`;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ledger (
  seq INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE
    CHECK(length(event_id) BETWEEN 16 AND 160),
  entity_key TEXT NOT NULL
    CHECK(length(entity_key) BETWEEN 1 AND 160),
  event_type TEXT NOT NULL
    CHECK(length(event_type) BETWEEN 1 AND 80),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  payload BLOB NOT NULL CHECK(length(payload) >= 1),
  payload_sha256 TEXT NOT NULL
    CHECK(length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*')
) STRICT;

CREATE INDEX IF NOT EXISTS ledger_entity_seq
  ON ledger(entity_key, seq DESC);
CREATE INDEX IF NOT EXISTS ledger_created_seq
  ON ledger(created_at_ms, seq);

CREATE TABLE IF NOT EXISTS projection (
  entity_key TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL REFERENCES ledger(seq) ON DELETE RESTRICT,
  state BLOB NOT NULL CHECK(length(state) >= 1),
  state_sha256 TEXT NOT NULL
    CHECK(length(state_sha256) = 64 AND state_sha256 NOT GLOB '*[^0-9a-f]*'),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
) STRICT, WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS outbox (
  seq INTEGER PRIMARY KEY REFERENCES ledger(seq) ON DELETE RESTRICT,
  object_key TEXT NOT NULL UNIQUE
    CHECK(length(object_key) BETWEEN 1 AND 512),
  payload BLOB NOT NULL CHECK(length(payload) >= 1),
  payload_sha256 TEXT NOT NULL
    CHECK(length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  delivered_at_ms INTEGER CHECK(delivered_at_ms IS NULL OR delivered_at_ms >= 0)
) STRICT;

CREATE INDEX IF NOT EXISTS outbox_pending
  ON outbox(seq) WHERE delivered_at_ms IS NULL;
`;

export const SQL = Object.freeze({
  insertLedger: `
    INSERT INTO ledger(
      event_id, entity_key, event_type, created_at_ms, payload, payload_sha256
    ) VALUES (?, ?, ?, ?, ?, ?)
  `,
  upsertProjection: `
    INSERT INTO projection(
      entity_key, last_seq, state, state_sha256, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(entity_key) DO UPDATE SET
      last_seq = excluded.last_seq,
      state = excluded.state,
      state_sha256 = excluded.state_sha256,
      updated_at_ms = excluded.updated_at_ms
    WHERE excluded.last_seq > projection.last_seq
  `,
  insertOutbox: `
    INSERT INTO outbox(seq, object_key, payload, payload_sha256)
    VALUES (?, ?, ?, ?)
  `,
  searchEntity: `
    SELECT seq, event_id, entity_key, event_type, created_at_ms,
           length(payload) AS payload_bytes, payload_sha256
    FROM ledger
    WHERE entity_key = ? AND seq <= ?
    ORDER BY seq DESC
    LIMIT ?
  `,
  searchOutbox: `
    SELECT seq, object_key, length(payload) AS payload_bytes, payload_sha256
    FROM outbox
    WHERE delivered_at_ms IS NULL AND seq > ?
    ORDER BY seq
    LIMIT ?
  `,
  counts: `
    SELECT
      (SELECT count(*) FROM ledger) AS ledger_count,
      (SELECT count(*) FROM projection) AS projection_count,
      (SELECT count(*) FROM outbox) AS outbox_count,
      (SELECT coalesce(max(seq), 0) FROM ledger) AS max_seq
  `,
  crossInvariant: `
    SELECT
      (SELECT count(*) FROM outbox AS o
       LEFT JOIN ledger AS l ON l.seq = o.seq
       WHERE l.seq IS NULL
          OR l.payload_sha256 <> o.payload_sha256
          OR length(l.payload) <> length(o.payload)) AS outbox_mismatch,
      (SELECT count(*) FROM projection AS p
       LEFT JOIN (
         SELECT entity_key, max(seq) AS max_seq
         FROM ledger GROUP BY entity_key
       ) AS latest ON latest.entity_key = p.entity_key
       WHERE latest.max_seq IS NULL OR latest.max_seq <> p.last_seq) AS projection_mismatch,
      (SELECT count(*) FROM ledger
       WHERE seq < 1 OR typeof(payload) <> 'blob'
          OR length(payload_sha256) <> 64) AS ledger_mismatch
  `,
  strictProbe: `
    INSERT INTO ledger(
      event_id, entity_key, event_type, created_at_ms, payload, payload_sha256
    ) VALUES ('strict-probe-event-0001', 'probe', 'probe', 1,
              'not-a-blob', '0000000000000000000000000000000000000000000000000000000000000000')
  `,
  schemaVersion: `PRAGMA user_version`,
});

export const TRANSACTION_SQL = Object.freeze({
  begin: `BEGIN IMMEDIATE`,
  commit: `COMMIT`,
  rollback: `ROLLBACK`,
});

export const STATIC_SQL_TEXT = [
  CONFIGURE_SQL,
  SCHEMA_SQL,
  ...Object.values(SQL),
  ...Object.values(TRANSACTION_SQL),
].join('\n');

export function assertClosedSqlSurface() {
  const forbidden = /\b(?:ATTACH|DETACH)\b|load_extension\s*\(/iu;
  if (forbidden.test(STATIC_SQL_TEXT)) {
    throw new Error('closed SQL surface contains a forbidden operation');
  }
  return true;
}
