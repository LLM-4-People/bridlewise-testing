#!/usr/bin/env node
/**
 * The conversation-archive CLI — archive trashed conversations to a file
 * beside the database, prove the file whole, then remove them (UD-S15).
 *
 *   npm run db-archive -- --db <database> --chats-file <file: one conversation id per line>
 *
 * Stop the server first: the archive refuses a database another process
 * holds. A verified copy of the database as it stood is kept at
 * `<database>.pre-archive`; the archive is written to `<database>.archive/`.
 * Passphrase installs (`HARNESS_WEB_DB_KEY`) and the key home
 * (`HARNESS_KEY_HOME`) are read as the server reads them.
 *
 * A THIN SHELL OVER THE EXPOSURE ACTION `database.conversations.archive`
 * (the server refuses it): argument parsing and the exit code (0 done, 1
 * refused or invalid arguments). Every decision lives in
 * `server/db/conversation-archive.ts`. The result is one JSON line.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { executeAction, installDatabaseShellOperations, registerDatabaseExposure } from "../server/kernel/canonical.ts";
import { serverKeyHome } from "../server/db/bootstrap-key.ts";
import { serverConfig } from "../server/kernel/config.ts";
import { archiveConversations } from "../server/db/conversation-archive.ts";
import { bootstrapProcess, isEntryPoint } from "../engine/src/runtime/cli-debug.ts";

const USAGE = "usage: db-archive --db <database> --chats-file <file: one conversation id per line>";

export async function runDbArchiveCli(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({ args: [...argv], options: { db: { type: "string" }, "chats-file": { type: "string" } }, allowPositionals: false });
  if (values.db === undefined || values["chats-file"] === undefined) {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }
  registerDatabaseExposure();
  installDatabaseShellOperations({
    archiveConversations: ({ database, chatIds }) => archiveConversations({ dbPath: database, chatIds, keyHome: serverKeyHome(), passphrase: serverConfig.dbEncryptionKey }),
  });
  const print = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value)}\n`); };
  try {
    print(await executeAction("database.conversations.archive", { database: values.db, chatIds: readFileSync(values["chats-file"], "utf8") }));
    return 0;
  } catch (error) {
    // A typed refusal (engine or server) is an answer; anything else is a bug.
    if (!(error instanceof Error) || typeof (error as { code?: unknown }).code !== "string") throw error;
    print({ refused: (error as Error & { code: string }).code, message: error.message });
    return 1;
  }
}

// Run when invoked as the main module (an import runs nothing).
if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  process.exitCode = await runDbArchiveCli(process.argv.slice(2));
}
