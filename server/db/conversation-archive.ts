/**
 * THE CONVERSATION ARCHIVE — archive conversations to a file, prove the file
 * whole against the database, and only then remove them (UD-S15).
 *
 * The product path never removes a conversation: deleting one moves it to the
 * recycle bin (`trashed_at`). Removing rows for good needs an owner that
 * cannot lose them, so this is the ONE door for it, run by the maintenance
 * shell (`npm run db-archive`) with the server STOPPED:
 *
 *   1. the server is stopped — proved, not assumed: the database is held
 *      alone (`holdDatabaseAlone`; a running server's connection refuses it);
 *   2. a verified copy of the database as it stood is kept beside it
 *      (`<db>.pre-archive`, written by the one copy writer, its row counts
 *      checked against the source);
 *   3. the database is opened through the product's own client (its
 *      migrations, with their own verified copies; its key proof; its
 *      provenance stamp);
 *   4. every row each conversation owns (`DbClient.conversationRows`: the
 *      schema's own foreign keys, sealed fields as stored, so the archive is
 *      as protected as the database) is written to ONE file in the database's
 *      archive area (`<db>.archive/`, a member of its family, so the keep-out
 *      list holds it), atomically and durably, 0600, with a digest;
 *   5. the file is read back and compared, row by row, with the database —
 *      any difference refuses before anything is removed;
 *   6. the conversations are removed through the owner's deletion
 *      (`DbClient.purgeConversations`: trashed ones only, all or none, one
 *      transaction), and the removed counts must equal the archived ones.
 */
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

import { databaseArchiveFolder, ensurePrivateStateDirectory, establishWalJournal, preArchiveCopyPath } from "../kernel/canonical.ts";
import { schemaId } from "../../engine/src/kernel/product-identity.ts";
import { atomicWriteFile } from "../../engine/src/filesystem/atomic-write.ts";
import { HarnessError } from "../../engine/src/kernel/errors.ts";
import { sha256 } from "../kernel/digest.ts";
import { readFileText } from "../filesystem/file-read.ts";
import { serverConfig } from "../kernel/config.ts";
import { webAuditEvent } from "../observability/debug-bridge.ts";
import { DbClient, type ConversationRows } from "./client.ts";
import { databaseTableCounts, holdDatabaseAlone, writeVerifiedCopy } from "./db-files.ts";
import type { AdmittedKeyHome } from "../kernel/canonical.ts";

export const CONVERSATION_ARCHIVE_SCHEMA = schemaId("conversation-archive", 1);

export type ConversationArchiveResult = Readonly<{
  database: string;
  /** The verified copy of the database as it stood before anything changed. */
  copy: string;
  archive: string;
  digest: string;
  conversations: number;
  /** Rows archived, per table. */
  archived: Readonly<Record<string, number>>;
  /** Rows removed, per table (equal to `archived`, or nothing was removed). */
  removed: Readonly<Record<string, number>>;
}>;

function refuseArchive(message: string, code: string): never {
  throw new HarnessError(message, code);
}

/** A stored value as JSON, losslessly (a blob, an integer past 2^53). */
function encodeValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return { $blob: Buffer.from(value).toString("base64") };
  if (typeof value === "bigint") return { $int: value.toString(10) };
  return value;
}

function encodeRow(row: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(row).map(([column, value]) => [column, encodeValue(value)]));
}

function countsOf(rows: ConversationRows): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const entry of rows.tables) counts[entry.table] = (counts[entry.table] ?? 0) + entry.rows.length;
  return Object.freeze(counts);
}

/** The archive's text: a header line, one line per row (parents first), and the digest of everything before it. */
function archiveText(database: string, rows: ConversationRows, createdAt: string): Readonly<{ text: string; digest: string }> {
  const lines = [JSON.stringify({ schema: CONVERSATION_ARCHIVE_SCHEMA, database: basename(database), createdAt, sealedFieldsAsStored: true, chatIds: rows.chatIds, counts: countsOf(rows) })];
  for (const entry of rows.tables) for (const row of entry.rows) lines.push(JSON.stringify({ table: entry.table, row: encodeRow(row) }));
  const body = `${lines.join("\n")}\n`;
  const digest = sha256(body);
  return { text: `${body}${JSON.stringify({ digest })}\n`, digest };
}

/**
 * READ AN ARCHIVE BACK AND PROVE IT WHOLE against `rows`: its digest, its
 * header, and every row equal, in order. Exported so a later reader (a
 * restore, an audit) checks an archive the same way.
 */
export function verifyConversationArchive(path: string, rows: ConversationRows): string {
  const text = readFileText(path);
  const lines = text.split("\n");
  if (lines.at(-1) !== "") refuseArchive(`${path} does not end with its digest line`, "db_archive_unverified");
  const trailer = JSON.parse(lines.at(-2) ?? "{}") as { digest?: unknown };
  const body = `${lines.slice(0, -2).join("\n")}\n`;
  const digest = sha256(body);
  if (trailer.digest !== digest) refuseArchive(`${path}: its digest does not match its contents`, "db_archive_unverified");
  const header = JSON.parse(lines[0]!) as { schema?: unknown; chatIds?: unknown; counts?: unknown };
  if (header.schema !== CONVERSATION_ARCHIVE_SCHEMA || !isDeepStrictEqual(header.chatIds, rows.chatIds) || !isDeepStrictEqual(header.counts, countsOf(rows))) {
    refuseArchive(`${path}: its header does not describe these conversations`, "db_archive_unverified");
  }
  const expected = rows.tables.flatMap((entry) => entry.rows.map((row) => ({ table: entry.table, row: encodeRow(row) })));
  const archived = lines.slice(1, -2).map((line) => JSON.parse(line) as unknown);
  if (archived.length !== expected.length || archived.some((line, index) => !isDeepStrictEqual(line, JSON.parse(JSON.stringify(expected[index]))))) {
    refuseArchive(`${path}: its rows differ from the database's (${String(archived.length)} archived, ${String(expected.length)} in the database)`, "db_archive_unverified");
  }
  return digest;
}

/** Archive `chatIds` (trashed conversations) from the database at `dbPath`, verify the archive, then remove them. */
export function archiveConversations(options: Readonly<{ dbPath: string; chatIds: readonly string[]; keyHome?: AdmittedKeyHome; passphrase?: string; now?: () => Date }>): ConversationArchiveResult {
  const database = resolve(options.dbPath);
  const chatIds = [...new Set(options.chatIds)];
  if (chatIds.length === 0 || chatIds.length !== options.chatIds.length) refuseArchive("Name each conversation to archive once (at least one).", "db_archive_chats_invalid");
  const copy = preArchiveCopyPath(database);
  // 1 + 2: the server is stopped, and the database as it stands is copied and proved.
  const raw = new DatabaseSync(database);
  let owner: string;
  try {
    holdDatabaseAlone(raw, database, "db_archive_database_busy");
    // ONE OWNER PER ARCHIVE: the client's reads and removal are scoped to the
    // user who owns the conversations (the Single-Party-Owner rule of every
    // user-data method); named conversations of two users are two archives.
    const owners = (raw.prepare("SELECT DISTINCT p.user_id AS owner FROM chats c JOIN projects p ON p.id = c.project_id WHERE c.id IN (SELECT value FROM json_each(?))").all(JSON.stringify(chatIds)) as { owner: string }[]).map((row) => row.owner);
    if (owners.length !== 1) refuseArchive(`The named conversations belong to ${String(owners.length)} users; archive one user's conversations at a time. Nothing was changed.`, "db_archive_owner_ambiguous");
    owner = owners[0]!;
    const before = databaseTableCounts(raw);
    writeVerifiedCopy(raw, copy, (verified) => isDeepStrictEqual(databaseTableCounts(verified), before), "the pre-archive copy of the database");
  } finally {
    try { establishWalJournal(raw, serverConfig.dbBusyTimeoutMs); } finally { raw.close(); }
  }
  // 3: the product's own client.
  const client = new DbClient({ path: database, ...(options.keyHome !== undefined ? { keyHome: options.keyHome } : {}), ...(options.passphrase !== undefined && options.passphrase.length > 0 ? { passphrase: options.passphrase } : {}) });
  try {
    const rows = client.conversationRows(chatIds, owner);
    const chats = rows.tables.find((entry) => entry.table === "chats")?.rows ?? [];
    const notTrashed = chatIds.filter((id) => !chats.some((row) => row.id === id && row.trashed_at !== null));
    if (notTrashed.length > 0) refuseArchive(`${String(notTrashed.length)} of the named conversations are not in the recycle bin (or do not exist), e.g. ${notTrashed[0]!}; only trashed conversations are archived and removed. Nothing was changed.`, "db_archive_not_trashed");
    // 4: the archive, written whole.
    const createdAt = (options.now?.() ?? new Date()).toISOString();
    const folder = ensurePrivateStateDirectory(databaseArchiveFolder(database));
    const archive = join(folder, `conversations-${createdAt.replace(/[:.]/gu, "-")}.jsonl`);
    const { text, digest } = archiveText(database, rows, createdAt);
    const written = atomicWriteFile(archive, text, { exclusive: true, durable: true, exactMode: 0o600, createParentDirectories: false });
    if (!written.success) refuseArchive(`The archive could not be written at ${archive}; nothing was removed.`, "db_archive_unwritten");
    // 5: proved whole before anything is removed.
    verifyConversationArchive(archive, rows);
    // 6: removed through the owner; the counts must agree.
    const archived = countsOf(rows);
    const removed = client.purgeConversations(chatIds, owner);
    if (!isDeepStrictEqual({ ...removed }, { ...archived })) {
      refuseArchive(`The removal took ${JSON.stringify(removed)} rows, the archive holds ${JSON.stringify(archived)}; restore ${copy}.`, "db_archive_removal_mismatch");
    }
    // A PERMANENT removal of user data: the audit floor records it (always on
    // where audit is; the shell's bootstrap configures it), never a
    // debug-gated warning (SCALE-CR1-FIX M2).
    webAuditEvent("database.conversations.archived", { database, archive, digest, conversations: chatIds.length, owner, rows: archived });
    return Object.freeze({ database, copy, archive, digest, conversations: chatIds.length, archived, removed });
  } finally {
    client.close();
  }
}
