import Database from 'better-sqlite3';
import { CONFIGURE_SQL, SCHEMA_SQL, SQL, TRANSACTION_SQL } from '../schema.mjs';
import { normalizeRow } from '../common.mjs';

function appendStatements(db) {
  return {
    ledger: db.prepare(SQL.insertLedger),
    projection: db.prepare(SQL.upsertProjection),
    outbox: db.prepare(SQL.insertOutbox),
  };
}

function insertEvent(statements, event) {
  const inserted = statements.ledger.run(
    event.eventId,
    event.entityKey,
    event.eventType,
    event.createdAtMs,
    event.payload,
    event.payloadHash,
  );
  const seq = Number(inserted.lastInsertRowid);
  statements.projection.run(
    event.entityKey,
    seq,
    event.payload,
    event.payloadHash,
    event.createdAtMs,
  );
  statements.outbox.run(seq, event.objectKey, event.payload, event.payloadHash);
  return seq;
}

export function openBetterSqlite3(databasePath) {
  const db = new Database(databasePath, { timeout: 5000 });
  db.unsafeMode(false);
  db.exec(CONFIGURE_SQL);
  db.exec(SCHEMA_SQL);

  const statements = appendStatements(db);
  const searchEntity = db.prepare(SQL.searchEntity);
  const searchOutbox = db.prepare(SQL.searchOutbox);
  const counts = db.prepare(SQL.counts);
  const crossInvariant = db.prepare(SQL.crossInvariant);
  let staged = false;

  const transact = (operation) => {
    db.exec(TRANSACTION_SQL.begin);
    try {
      const result = operation();
      db.exec(TRANSACTION_SQL.commit);
      return result;
    } catch (error) {
      db.exec(TRANSACTION_SQL.rollback);
      throw error;
    }
  };

  return Object.freeze({
    name: 'better-sqlite3',
    append(event) {
      return transact(() => insertEvent(statements, event));
    },
    appendBatch(events) {
      return transact(() => events.map((event) => insertEvent(statements, event)));
    },
    searchEntity(entityKey, maximumSeq, limit) {
      return searchEntity.all(entityKey, maximumSeq, limit).map(normalizeRow);
    },
    searchOutbox(afterSeq, limit) {
      return searchOutbox.all(afterSeq, limit).map(normalizeRow);
    },
    counts() {
      return normalizeRow(counts.get());
    },
    check() {
      return {
        quickCheck: db.prepare('PRAGMA quick_check').all().map(normalizeRow),
        foreignKeyErrors: db.prepare('PRAGMA foreign_key_check').all().map(normalizeRow),
        cross: normalizeRow(crossInvariant.get()),
        journalMode: db.pragma('journal_mode', { simple: true }),
        synchronous: db.pragma('synchronous', { simple: true }),
        foreignKeys: db.pragma('foreign_keys', { simple: true }),
        trustedSchema: db.pragma('trusted_schema', { simple: true }),
        databases: db.pragma('database_list').map(normalizeRow),
        strictTables: db.pragma('table_list')
          .filter((row) => ['ledger', 'projection', 'outbox'].includes(row.name))
          .map(normalizeRow),
      };
    },
    identity() {
      const identity = db.prepare(
        'SELECT sqlite_version() AS sqliteVersion, sqlite_source_id() AS sqliteSourceId',
      ).get();
      return {
        ...identity,
        compileOptions: db.pragma('compile_options').map((row) => row.compile_options).sort(),
      };
    },
    strictProbeRejected() {
      try {
        db.prepare(SQL.strictProbe).run();
        return false;
      } catch {
        return true;
      }
    },
    stageForKill(event) {
      if (staged) throw new Error('transaction already staged');
      db.exec(TRANSACTION_SQL.begin);
      staged = true;
      return insertEvent(statements, event);
    },
    commitStaged() {
      if (!staged) throw new Error('no staged transaction');
      db.exec(TRANSACTION_SQL.commit);
      staged = false;
    },
    async backup(destination) {
      return db.backup(destination);
    },
    checkpointPassive() {
      return normalizeRow(db.pragma('wal_checkpoint(PASSIVE)')[0]);
    },
    close() {
      db.close();
    },
  });
}

export function inspectBetterSqlite3(databasePath) {
  const db = new Database(databasePath, { fileMustExist: true, readonly: true, timeout: 5000 });
  try {
    return {
      counts: normalizeRow(db.prepare(SQL.counts).get()),
      quickCheck: db.pragma('quick_check').map(normalizeRow),
      cross: normalizeRow(db.prepare(SQL.crossInvariant).get()),
    };
  } finally {
    db.close();
  }
}
