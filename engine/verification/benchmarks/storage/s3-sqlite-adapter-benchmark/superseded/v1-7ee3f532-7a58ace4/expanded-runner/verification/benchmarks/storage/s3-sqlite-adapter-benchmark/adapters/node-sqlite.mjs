import { backup as sqliteBackup, constants, DatabaseSync } from 'node:sqlite';
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

export function openNodeSqlite(databasePath) {
  const db = new DatabaseSync(databasePath, {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    timeout: 5000,
  });
  db.exec(CONFIGURE_SQL);
  db.exec(SCHEMA_SQL);
  db.setAuthorizer((action, arg1, arg2) => {
    const functionName = action === constants.SQLITE_FUNCTION ? (arg2 ?? arg1) : null;
    if (
      action === constants.SQLITE_ATTACH
      || action === constants.SQLITE_DETACH
      || (typeof functionName === 'string' && functionName.toLowerCase() === 'load_extension')
    ) return constants.SQLITE_DENY;
    return constants.SQLITE_OK;
  });

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
    name: 'node:sqlite',
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
        journalMode: db.prepare('PRAGMA journal_mode').get().journal_mode,
        synchronous: db.prepare('PRAGMA synchronous').get().synchronous,
        foreignKeys: db.prepare('PRAGMA foreign_keys').get().foreign_keys,
        trustedSchema: db.prepare('PRAGMA trusted_schema').get().trusted_schema,
        databases: db.prepare('PRAGMA database_list').all().map(normalizeRow),
        strictTables: db.prepare('PRAGMA table_list').all()
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
        compileOptions: db.prepare('PRAGMA compile_options').all()
          .map((row) => row.compile_options).sort(),
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
      return sqliteBackup(db, destination, { source: 'main', target: 'main', rate: 100 });
    },
    checkpointPassive() {
      return normalizeRow(db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get());
    },
    close() {
      db.close();
    },
  });
}

export function inspectNodeSqlite(databasePath) {
  const db = new DatabaseSync(databasePath, {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    readOnly: true,
    timeout: 5000,
  });
  try {
    return {
      counts: normalizeRow(db.prepare(SQL.counts).get()),
      quickCheck: db.prepare('PRAGMA quick_check').all().map(normalizeRow),
      cross: normalizeRow(db.prepare(SQL.crossInvariant).get()),
    };
  } finally {
    db.close();
  }
}
