/**
 * THE HISTORY IMPORTER, LIVE (`src/workflow/forge/history-import.ts`) — the
 * whole pipeline with the PINNED TOOLS (gitleaks, git-filter-repo), which
 * live outside the checkout, so this file is the live suite's (LIVE-SUITE):
 * it runs only where the operator has provisioned them, in the import home
 * `HARNESS_IMPORT_HOME` names, and REFUSES LOUDLY otherwise — the resolver's
 * own refusal names the provisioning command. Nothing here reaches a network:
 * the source and every target are local repositories.
 *
 *   - a history with a credential in every place a history holds one (the
 *     shared planted fixture) is mirrored, found by both scanners, purged,
 *     re-scanned to zero and pushed into an empty bare target: the target
 *     holds no planted value anywhere (every object read back), each value
 *     is its `[REMOVED:<entry>]` marker, the binary blob is gone, every ref
 *     arrived (`refs/pull/*` under the imported prefix) and the receipt on
 *     the ledger ref is the one answered;
 *   - a second import into the same target is refused (never rewritten);
 *   - a secret only the oracle knows is a refusal (a catalogue gap) and a
 *     PEM key the catalogue sees only by its header is one too (the row is
 *     narrower than the secret), until a reviewed disposition names the
 *     oracle-only value — which then stays, counted in the receipt;
 *   - an object nothing decodes is refused until the review exempts it by
 *     id, and its byte-level credential is still found and stripped.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { createOwnedTemporaryDirectory } from "../src/filesystem/private-state.ts";
import { sha256 } from "../src/kernel/integrity.ts";
import { ROOT_POLICY } from "../src/kernel/root-policy.ts";
import { importHistory, IMPORT_REVIEW_SCHEMA, removedMarker } from "../src/workflow/forge/history-import.ts";
import { historyToolPath, historyToolPin, resolveHistoryTool, type HistoryToolName } from "../src/workflow/forge/history-tools.ts";
import { armTestKeyHome } from "../test/support/test-key-home.ts";
import { createTempDir } from "../test/support/temp-dir.ts";
import { CORAL_KEY, GIT, git, GITHUB_TOKEN, MAKORA_KEY, pemLine, plantedRepository, SHORT_PASSWORD, write } from "../test/forge/history-fixture.ts";

const POLICY = ROOT_POLICY.workflow.historyImport;
const OPERATOR_HOME = process.env[POLICY.environmentVariable];
if (OPERATOR_HOME === undefined || OPERATOR_HOME.length === 0) {
  throw new Error(`the history importer's live test needs the pinned tools: set ${POLICY.environmentVariable} to the import home that holds them (a missing tool's refusal prints its provisioning command)`);
}

/** A private import home of this run (outside the system temp folder), holding verified copies of the operator's pinned tools. */
function testImportHome(): string {
  const home = createOwnedTemporaryDirectory(armTestKeyHome(), "import-home-");
  for (const name of ["gitleaks", "git-filter-repo"] as const satisfies readonly HistoryToolName[]) {
    const verified = resolveHistoryTool(OPERATOR_HOME!, name);
    const path = historyToolPath(home, historyToolPin(name));
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    copyFileSync(verified.path, path);
  }
  return home;
}

function bareTarget(): string {
  const target = join(createTempDir("history-import-target-"), "target.git");
  git(dirname(target), "init", "-q", "--bare", target);
  return target;
}

/** Every object of `repository`, its raw bytes concatenated (what a reader of the target could see). */
function everything(repository: string): Buffer {
  const oids = git(repository, "rev-list", "--objects", "--all").split("\n").filter((line) => line.length > 0).map((line) => line.split(" ")[0]!);
  return Buffer.concat(oids.map((oid) => execFileSync(GIT, ["cat-file", "-p", oid], { cwd: repository })));
}

/** Whether `bytes` hold `value` in UTF-8 or UTF-16LE. */
function holds(bytes: Buffer, value: string): boolean {
  return bytes.includes(Buffer.from(value, "utf8")) || bytes.includes(Buffer.from(value, "utf16le"));
}

const refusedWith = (code: string) => (error: Error & { code?: string }) => error.code === code;

/** The run folder a refusal names (its facts), so a test can read the reviewer's file. */
async function refusalFolder(run: Promise<unknown>, code: string): Promise<string> {
  let folder = "";
  await assert.rejects(run, (error: Error & { code?: string; facts?: Readonly<Record<string, unknown>> }) => {
    folder = String(error.facts?.["runFolder"] ?? "");
    return error.code === code;
  });
  return folder;
}

function review(entries: Readonly<{ dispositions?: readonly unknown[]; binaries?: readonly unknown[] }>): string {
  const path = join(createTempDir("history-import-review-"), "review.json");
  writeFileSync(path, JSON.stringify({ schema: IMPORT_REVIEW_SCHEMA, dispositions: entries.dispositions ?? [], binaries: entries.binaries ?? [] }));
  return path;
}

test("a planted history (UTF-16LE included) is found, purged, re-scanned to zero and pushed; the target holds no planted value", async () => {
  const home = testImportHome();
  const source = plantedRepository();
  write(source, "windows/settings.txt", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`token = ${GITHUB_TOKEN}\r\n`, "utf16le")]));
  write(source, "windows/bare.txt", Buffer.from(`key = ${MAKORA_KEY}\r\n`, "utf16le"));
  git(source, "add", ".");
  git(source, "commit", "-q", "-m", "UTF-16LE settings, with and without a BOM");
  const target = bareTarget();
  const receipt = await importHistory({ source, target }, { home, git: GIT });

  assert.deepEqual(receipt.findings.catalogue, { "coralbricks-key": 2, "dsn-credential": 2, "makora-key": 2, "token-prefix": 3 });
  assert.ok((receipt.findings.oracle.covered["github-pat"] ?? 0) >= 1, "the oracle saw the token and the catalogue covers it");
  assert.equal(receipt.purge.strippedBlobs.length, 3, "the binary blob and both UTF-16LE blobs are stripped whole");
  assert.equal(receipt.after.catalogueHits, 0);
  assert.equal(receipt.after.oracleGaps, 0);
  assert.equal(receipt.before.objects.blob - 3, receipt.after.objects.blob);

  const content = everything(target);
  for (const value of [GITHUB_TOKEN, CORAL_KEY, MAKORA_KEY, `Pwd=${SHORT_PASSWORD}`]) assert.ok(!holds(content, value), "a planted value reached the target");
  for (const entry of ["token-prefix", "makora-key", "coralbricks-key", "dsn-credential"]) assert.ok(content.includes(removedMarker(entry)), `${entry} has its marker`);
  assert.ok(content.includes("risk-assessment-report-for-the-quarter") && content.includes("cb_handle_click_event_listener"), "the near-misses are untouched");

  // The receipt: recorded without a path, and the one on the ledger is the one answered.
  assert.equal(receipt.source, `local:${source.split("/").pop()!}`);
  assert.equal(receipt.target, "local:target.git");
  const refs = Object.fromEntries(git(target, "for-each-ref", "--format=%(refname) %(objectname)").trim().split("\n").map((line) => line.split(" ")));
  for (const mapping of receipt.refMap) assert.equal(refs[mapping.target], mapping.oid, mapping.target);
  assert.ok(`${POLICY.importedRefPrefix}pull/1/head` in refs);
  const recorded = git(target, "show", `${POLICY.receipt.ref}:${POLICY.receipt.folder}/${receipt.id}.json`);
  assert.deepEqual(JSON.parse(recorded) as unknown, JSON.parse(JSON.stringify(receipt)));
  assert.ok(!recorded.includes(source) && !recorded.includes(target), "no absolute path in the pushed receipt");

  await assert.rejects(importHistory({ source, target }, { home, git: GIT }), refusedWith("history_import_target_not_empty"));
});

test("an undecodable object is refused until the review exempts it by id; its credential is still found and stripped", async () => {
  const home = testImportHome();
  const source = createTempDir("history-import-undecodable-");
  git(source, "init", "-q", "-b", "main");
  write(source, "logo.png", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xc3, 0x28]), Buffer.from(` ${CORAL_KEY} `, "latin1"), Buffer.from([0xfe, 0x00])]));
  write(source, "README.md", "a logo\n");
  git(source, "add", ".");
  git(source, "commit", "-q", "-m", "a logo");
  const folder = await refusalFolder(importHistory({ source, target: bareTarget() }, { home, git: GIT }), "history_import_undecodable");
  const listed = JSON.parse(readFileSync(join(folder, "undecodable.json"), "utf8")) as { undecodable: { oid: string; paths: string[] }[] };
  assert.deepEqual(listed.undecodable.map((entry) => entry.paths), [["logo.png"]]);
  const target = bareTarget();
  const receipt = await importHistory({ source, target, review: review({ binaries: [{ oid: listed.undecodable[0]!.oid, reason: "the project logo, reviewed" }] }) }, { home, git: GIT });
  assert.deepEqual(receipt.purge.strippedBlobs, [listed.undecodable[0]!.oid], "its credential was found byte for byte, so it is stripped");
  assert.equal(receipt.findings.review.binaries, 1);
  assert.ok(!holds(everything(target), CORAL_KEY));
});

test("an oracle-only secret and a key wider than its catalogue row are refused until a reviewed disposition names the oracle-only value", async () => {
  const home = testImportHome();
  const webhook = `https://hooks.slack.com/services/${["T0", "1ABCDEFGH"].join("")}/${["B0", "1ABCDEFGH"].join("")}/${"Zq3Wx8Rt6Yv1Nm5Kp9Lb4Hd2".slice(0, 24)}`;
  const source = createTempDir("history-import-gap-");
  git(source, "init", "-q", "-b", "main");
  write(source, "notify.txt", `hook: ${webhook}\n`);
  git(source, "add", ".");
  git(source, "commit", "-q", "-m", "a webhook only the oracle knows");
  const gapFolder = await refusalFolder(importHistory({ source, target: bareTarget() }, { home, git: GIT }), "history_import_catalogue_gap");
  // The reviewer's file: each gap's rule, object and value digest — the value itself never.
  const gaps = readFileSync(join(gapFolder, "oracle-gaps.json"), "utf8");
  assert.ok(gaps.includes(sha256(webhook)) && gaps.includes("slack-webhook-url") && !gaps.includes(webhook));

  const target = bareTarget();
  const receipt = await importHistory({ source, target, review: review({ dispositions: [{ rule: "slack-webhook-url", secretSha256: sha256(webhook), reason: "a revoked test webhook, kept for the record" }] }) }, { home, git: GIT });
  assert.deepEqual(receipt.findings.oracle.disposed, { "slack-webhook-url": 1 });
  assert.deepEqual(receipt.after.oracleDisposed, { "slack-webhook-url": 1 });
  assert.ok(holds(everything(target), webhook), "a disposed value is not purged");

  // A PEM key: never pushed with its body. While the catalogue's private-key
  // row spans only the header, the oracle's wider span is a gap (refused);
  // once the row spans the block, the import purges the whole key.
  const keyed = createTempDir("history-import-pem-");
  git(keyed, "init", "-q", "-b", "main");
  const body = Array.from({ length: 8 }, (_, line) => "MIIEpAIBAAKCAQEA".concat(String(line)).padEnd(64, "x")).join("\n");
  write(keyed, "key.txt", [pemLine("BEGIN"), body, pemLine("END"), ""].join("\n"));
  git(keyed, "add", ".");
  git(keyed, "commit", "-q", "-m", "a key");
  const keyTarget = bareTarget();
  let refusal: string | undefined;
  try {
    await importHistory({ source: keyed, target: keyTarget }, { home, git: GIT });
  } catch (error) {
    refusal = (error as { code?: string }).code;
  }
  if (refusal === undefined) assert.ok(!holds(everything(keyTarget), body.split("\n")[3]!), "a key's body reached the target");
  else assert.equal(refusal, "history_import_catalogue_gap");
});
