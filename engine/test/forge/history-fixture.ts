/**
 * THE PLANTED HISTORY the importer's tests share (the hermetic
 * `history-import.test.ts` and the live `live/history-import.test.ts`): a
 * repository with a credential in every place a history holds one — a text
 * blob, a short connection-string password, a binary blob, a commit message,
 * a tag message, a note — on branches, a tag, notes and a `refs/pull/*` ref,
 * beside near-misses the catalogue must not flag. Every credential is
 * assembled at runtime: the tree holds none.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolveGitExecutable } from "../../src/git/git-adapter.ts";
import type { GitRepository } from "../../src/git/tree-reader.ts";
import { DEFAULT_PRIVACY_POLICY } from "../../src/privacy/privacy-policy.ts";
import { detectSensitiveSpans } from "../../src/privacy/redaction-engine.ts";
import { createTempDir } from "../support/temp-dir.ts";

export const GIT = resolveGitExecutable();

/** A credential-shaped value assembled at runtime (the tree holds none). */
export function planted(prefix: string, unit: string, repeat: number): string {
  return `${prefix}${unit.repeat(repeat)}`;
}
export const GITHUB_TOKEN = planted(["gh", "p_"].join(""), "Q7w9E2r4", 5);
export const CORAL_KEY = planted(["cb", "_"].join(""), "Ab3De5Fg7Hj9", 3);
export const MAKORA_KEY = planted(["mb", "h_"].join(""), "k2L8m4N6", 4);
/** The short connection-string password: replaced only inside its line. */
export const SHORT_PASSWORD = "s3cr";

/** One armour line of a PEM private key (`BEGIN` or `END`), assembled at runtime: the tree holds no such literal. */
export function pemLine(kind: "BEGIN" | "END"): string {
  const dashes = "-".repeat(5);
  return `${dashes}${kind} RSA ${["PRIV", "ATE"].join("")} KEY${dashes}`;
}

/**
 * The catalogue row that owns `value`, as the importer's catalogue scan reports it (the redaction engine's
 * format layer): the tests name rows through the catalogue, never by a spelling it may rename. A value the
 * catalogue does not see as exactly one span fails here, loudly.
 */
export function entryOf(value: string): string {
  const spans = detectSensitiveSpans(value, DEFAULT_PRIVACY_POLICY);
  if (spans.length !== 1) throw new Error(`the catalogue reads ${String(spans.length)} span(s) in a planted value, not one`);
  return spans[0]!.signalId;
}

/** The identity the fixtures commit as: on the tests' allowed list. */
export const FIXTURE_ADDRESS = "import@example.invalid";
/** An address the tests do NOT allow (a stand-in for a person's own address; never a real one). */
export const UNALLOWED_ADDRESS = "someone.private@example.invalid";
/** The address the tests' identity mapping brings the unallowed one to. */
export const MAPPED_ADDRESS = "mapped@example.invalid";

/** The importer's options for a test: the admitted `home`, the git, and the tests' allowed identities (the fixture's, the mapped one, the receipt commit's); the harness checkout is the public tree. */
export function importOptions(home: string, alsoAllowed: readonly string[] = []): Readonly<{ home: string; git: string; allowedIdentities: readonly string[]; publicTree: string }> {
  return { home, git: GIT, allowedIdentities: [FIXTURE_ADDRESS, MAPPED_ADDRESS, "history-import@example.invalid", ...alsoAllowed], publicTree: join(import.meta.dirname, "..", "..", "..") };
}

export function git(root: string, ...args: readonly string[]): string {
  return execFileSync(GIT, ["-c", "user.name=Import Test", "-c", "user.email=import@example.invalid", ...args], { cwd: root, encoding: "utf8" });
}

export function write(root: string, path: string, content: string | Buffer): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

export function repository(root: string): GitRepository {
  return { root, executable: GIT, timeoutMs: 60_000 };
}

/** A repository with every planted place, plus the near-misses beside them. */
export function plantedRepository(): string {
  const root = createTempDir("history-import-src-");
  git(root, "init", "-q", "-b", "main");
  write(root, "config/app.txt", `token = ${GITHUB_TOKEN}\nthe risk-assessment-report-for-the-quarter is public\n`);
  write(root, "config/db.txt", `Server=db;Uid=app;Pwd=${SHORT_PASSWORD};\nPwd=${SHORT_PASSWORD} is repeated here\n`);
  write(root, "src/callback.ts", "export const cb_handle_click_event_listener = () => 0;\nconst desk_lookup_table_for_the_floor = new Map();\n");
  write(root, "assets/blob.bin", Buffer.concat([Buffer.from("bin"), Buffer.from([0]), Buffer.from(` ${CORAL_KEY}\n`)]));
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", `first commit mentions ${MAKORA_KEY}`);
  git(root, "tag", "-a", "v1", "-m", `release notes carry ${GITHUB_TOKEN}`);
  git(root, "notes", "add", "-m", `a note with ${CORAL_KEY}`, "HEAD");
  git(root, "update-ref", "refs/pull/1/head", "HEAD");
  return root;
}
