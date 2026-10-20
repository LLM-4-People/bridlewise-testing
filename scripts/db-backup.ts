#!/usr/bin/env node
/**
 * The database backup/restore CLI — one folder that holds a verified copy of
 * the database and the key material that opens it, and the flow that puts it
 * back.
 *
 *   npm run db-backup -- backup --db <database> --to <new folder>
 *   npm run db-backup -- restore --from <backup folder> --db <database>
 *
 * Stop the server first: both commands hold the database alone, so a running
 * server's open connection refuses them. A backup writes a NEW folder (it
 * never overwrites one); a restore keeps the database it replaces as
 * `<database>.pre-restore`, proved, and puts it back if the restored copy
 * does not verify. The key home is `HARNESS_KEY_HOME`, else
 * `$XDG_CONFIG_HOME/bridlewise/keys`, else `~/.config/bridlewise/keys`;
 * `HARNESS_WEB_DB_KEY` selects passphrase mode and the backup carries that
 * database's salt.
 *
 * A THIN SHELL OVER `server/db/backup-restore.ts` (every decision lives
 * there): argument parsing and the exit code (0 done, 1 refused or invalid
 * arguments). The result is one JSON line.
 */
import { parseArgs } from "node:util";

import { bootstrapProcess, isEntryPoint } from "../engine/src/runtime/cli-debug.ts";
import { createDatabaseBackup, restoreDatabaseBackup } from "../server/db/backup-restore.ts";
import { serverConfig } from "../server/kernel/config.ts";

const USAGE = "usage: db-backup backup --db <database> --to <new folder> | restore --from <backup folder> --db <database>";

export async function runDbBackupCli(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  let values: Readonly<{ db?: string; to?: string; from?: string }>;
  try {
    ({ values } = parseArgs({ args: [...rest], options: { db: { type: "string" }, to: { type: "string" }, from: { type: "string" } }, allowPositionals: false }));
  } catch {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }
  const print = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value)}\n`); };
  try {
    if (command === "backup" && values.db !== undefined && values.to !== undefined) {
      print(createDatabaseBackup({ dbPath: values.db, to: values.to, passphrase: serverConfig.dbEncryptionKey }));
      return 0;
    }
    if (command === "restore" && values.db !== undefined && values.from !== undefined) {
      print(restoreDatabaseBackup({ from: values.from, dbPath: values.db, passphrase: serverConfig.dbEncryptionKey }));
      return 0;
    }
  } catch (error) {
    // A typed refusal (engine or server) is an answer; anything else is a bug.
    if (!(error instanceof Error) || typeof (error as { code?: unknown }).code !== "string") throw error;
    print({ refused: (error as Error & { code: string }).code, message: error.message });
    return 1;
  }
  process.stderr.write(`${USAGE}\n`);
  return 1;
}

// Run when invoked as the main module (an import runs nothing).
if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  process.exitCode = await runDbBackupCli(process.argv.slice(2));
}
