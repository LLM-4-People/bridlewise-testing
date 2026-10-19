import { createHash, createHmac } from "node:crypto";
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export const GENESIS_TIP = "0".repeat(64);
const SYNTHETIC_HMAC_KEY = Buffer.from(
  "e04df1e0d87af5148fb7f4cc434084c77ec664ba0cd8b3dc924dacb57c2aa119",
  "hex",
);

function payloadHash(label) {
  return createHash("sha256").update(`s3q-synthetic:${label}`, "utf8").digest("hex");
}

function entryTip(sequence, previousTip, payloadDigest) {
  return createHmac("sha256", SYNTHETIC_HMAC_KEY)
    .update(`${sequence}\0${previousTip}\0${payloadDigest}`, "utf8")
    .digest("hex");
}

export function openLedger(path) {
  const database = new DatabaseSync(path, {
    open: true,
    allowExtension: false,
    readOnly: false,
    enableForeignKeyConstraints: true,
    defensive: true,
  });
  database.prepare("PRAGMA journal_mode = WAL").get();
  database.exec("PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA trusted_schema = OFF; PRAGMA wal_autocheckpoint = 1;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS ledger (
      seq INTEGER PRIMARY KEY CHECK (seq > 0),
      previous_tip TEXT NOT NULL CHECK (length(previous_tip) = 64),
      payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
      tip TEXT NOT NULL UNIQUE CHECK (length(tip) = 64),
      anchored INTEGER NOT NULL DEFAULT 0 CHECK (anchored IN (0, 1))
    ) STRICT;
  `);
  chmodSync(path, 0o600);
  return database;
}

export function insertNextInCurrentTransaction(database, label) {
  const latest = database.prepare("SELECT seq, tip FROM ledger ORDER BY seq DESC LIMIT 1").get();
  const sequence = latest ? Number(latest.seq) + 1 : 1;
  const previousTip = latest ? latest.tip : GENESIS_TIP;
  const digest = payloadHash(label);
  const tip = entryTip(sequence, previousTip, digest);
  database.prepare(`
    INSERT INTO ledger (seq, previous_tip, payload_hash, tip, anchored)
    VALUES (?, ?, ?, ?, 0)
  `).run(sequence, previousTip, digest, tip);
  return { sequence, previousTip, payloadHash: digest, tip };
}

export function appendCommitted(path, label) {
  const database = openLedger(path);
  try {
    database.exec("BEGIN IMMEDIATE");
    const entry = insertNextInCurrentTransaction(database, label);
    database.exec("COMMIT");
    return entry;
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    database.close();
  }
}

export function markAnchored(path, sequence) {
  const database = openLedger(path);
  try {
    const result = database.prepare("UPDATE ledger SET anchored = 1 WHERE seq = ?").run(sequence);
    if (Number(result.changes) !== 1) throw new Error("anchor mark did not update exactly one row");
  } finally {
    database.close();
  }
}

export function inspectLedger(path) {
  const database = openLedger(path);
  try {
    const rows = database.prepare("SELECT seq, previous_tip AS previousTip, payload_hash AS payloadHash, tip, anchored FROM ledger ORDER BY seq").all();
    let previous = GENESIS_TIP;
    let valid = true;
    let expectedSequence = 1;
    for (const row of rows) {
      const sequence = Number(row.seq);
      const expectedTip = entryTip(sequence, row.previousTip, row.payloadHash);
      if (sequence !== expectedSequence || row.previousTip !== previous || row.tip !== expectedTip) valid = false;
      previous = row.tip;
      expectedSequence += 1;
    }
    const quickCheck = database.prepare("PRAGMA quick_check").get().quick_check;
    return {
      valid,
      quickCheck,
      generation: rows.length,
      tip: rows.length === 0 ? GENESIS_TIP : rows.at(-1).tip,
      unanchoredSequences: rows.filter((row) => Number(row.anchored) === 0).map((row) => Number(row.seq)),
      rows: rows.map((row) => ({ ...row, seq: Number(row.seq), anchored: Number(row.anchored) })),
    };
  } finally {
    database.close();
  }
}

export function checkpoint(path) {
  const database = openLedger(path);
  try {
    return database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  } finally {
    database.close();
  }
}

export function deleteTail(path) {
  const database = openLedger(path);
  try {
    database.prepare("DELETE FROM ledger WHERE seq = (SELECT max(seq) FROM ledger)").run();
  } finally {
    database.close();
  }
}
