import { backup as nodeBackup, constants, DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { CONFIGURATION_SQL } from './schema.mjs';

const require = createRequire(import.meta.url);
const BetterSqlite3 = require('/tmp/s3-sqlite-adapter-benchmark/node_modules/better-sqlite3');

function normalize(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint' || typeof value === 'string' || typeof value === 'number'
    || typeof value === 'boolean') return value;
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
  }
  return value;
}

function nodeStatement(db, sql) {
  const statement = db.prepare(sql);
  statement.setReadBigInts(true);
  statement.setAllowUnknownNamedParameters(false);
  return statement;
}

function configure(driver, { synchronous = 'FULL', walAutoCheckpoint = 1000, timeoutMs = 5000 } = {}) {
  driver.exec(CONFIGURATION_SQL);
  driver.exec(`PRAGMA busy_timeout = ${timeoutMs}`);
  driver.exec(`PRAGMA synchronous = ${synchronous}`);
  driver.exec(`PRAGMA wal_autocheckpoint = ${walAutoCheckpoint}`);
}

function installNodeAuthorizer(db) {
  const denied = new Set([
    constants.SQLITE_ATTACH,
    constants.SQLITE_DETACH,
  ]);
  db.setAuthorizer((action, argument1, argument2) => {
    const functionName = action === constants.SQLITE_FUNCTION ? (argument2 ?? argument1) : null;
    if (denied.has(action)) return constants.SQLITE_DENY;
    if (typeof functionName === 'string' && functionName.toLowerCase() === 'load_extension') {
      return constants.SQLITE_DENY;
    }
    return constants.SQLITE_OK;
  });
}

function makeNodeDriver(databasePath, options) {
  const db = new DatabaseSync(databasePath, {
    allowExtension: false,
    defensive: true,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
    readOnly: options.readOnly ?? false,
    timeout: options.timeoutMs ?? 5000,
  });
  if (!options.readOnly) configure({ exec: (sql) => db.exec(sql) }, options);
  else db.exec('PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF;');
  if (db.limits) {
    db.limits.attach = 0;
    db.limits.sqlLength = Math.min(db.limits.sqlLength, 1_000_000);
    db.limits.length = Math.min(db.limits.length, 16 * 1024 * 1024);
  }
  let authorizerInstalled = false;
  return {
    kind: 'node:sqlite',
    databasePath,
    exec(sql) { return db.exec(sql); },
    run(sql, ...parameters) { return normalize(nodeStatement(db, sql).run(...parameters)); },
    get(sql, ...parameters) { return normalize(nodeStatement(db, sql).get(...parameters)); },
    all(sql, ...parameters) { return normalize(nodeStatement(db, sql).all(...parameters)); },
    installRuntimeAuthorizer() {
      if (!authorizerInstalled) {
        installNodeAuthorizer(db);
        authorizerInstalled = true;
      }
    },
    securityState() {
      return {
        authorizer: authorizerInstalled ? 'enforced' : 'available-not-installed',
        defensive: true,
        extensionConstructorPermission: false,
        attachLimit: db.limits?.attach ?? null,
      };
    },
    async backup(destination) { return nodeBackup(db, destination, { rate: 100 }); },
    checkpoint(mode = 'PASSIVE') {
      return normalize(nodeStatement(db, `PRAGMA wal_checkpoint(${mode})`).get());
    },
    close() { db.close(); },
  };
}

function makeBetterDriver(databasePath, options) {
  const db = new BetterSqlite3(databasePath, {
    fileMustExist: options.fileMustExist ?? false,
    readonly: options.readOnly ?? false,
    timeout: options.timeoutMs ?? 5000,
  });
  db.defaultSafeIntegers(true);
  db.unsafeMode(false);
  if (!options.readOnly) configure({ exec: (sql) => db.exec(sql) }, options);
  else db.exec('PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF;');
  return {
    kind: 'better-sqlite3',
    databasePath,
    exec(sql) { return db.exec(sql); },
    run(sql, ...parameters) { return normalize(db.prepare(sql).run(...parameters)); },
    get(sql, ...parameters) { return normalize(db.prepare(sql).get(...parameters)); },
    all(sql, ...parameters) { return normalize(db.prepare(sql).all(...parameters)); },
    installRuntimeAuthorizer() { /* not exposed by better-sqlite3 */ },
    securityState() {
      return {
        authorizer: 'not-exposed',
        defensive: 'not-exposed',
        extensionConstructorPermission: 'hidden-by-closed-port',
        attachLimit: 'not-exposed',
      };
    },
    async backup(destination) { return db.backup(destination); },
    checkpoint(mode = 'PASSIVE') {
      return normalize(db.pragma(`wal_checkpoint(${mode})`)[0]);
    },
    close() { db.close(); },
  };
}

export function openDriver(kind, databasePath, options = {}) {
  if (kind === 'node:sqlite') return makeNodeDriver(databasePath, options);
  if (kind === 'better-sqlite3') return makeBetterDriver(databasePath, options);
  throw new Error(`unsupported adapter: ${kind}`);
}

export const ADAPTERS = Object.freeze(['node:sqlite', 'better-sqlite3']);

export function closedPortSurface(driver) {
  const port = {
    append: (...args) => driver.__append(...args),
    readTimeline: (...args) => driver.__readTimeline(...args),
    verify: (...args) => driver.__verify(...args),
    backup: (...args) => driver.__backup(...args),
    close: () => driver.__close(),
  };
  return Object.freeze(port);
}

export function isBusy(error) {
  return error?.code === 'SQLITE_BUSY'
    || error?.errcode === 5
    || /database is (?:busy|locked)/iu.test(String(error?.message));
}

export function isConstraint(error) {
  return String(error?.code ?? '').startsWith('SQLITE_CONSTRAINT')
    || /constraint|append-only|contiguous|chain MAC|causation event|edge target (?:identity|event)|cannot store .* value in/iu
      .test(String(error?.message));
}
