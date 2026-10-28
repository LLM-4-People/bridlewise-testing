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
 *     id, and its byte-level credential is still found and stripped;
 *   - nothing is pushed when the purge leaves residue (a token in an author
 *     name) or when the receipt would carry a home path (a ref named after one);
 *   - no blob is stripped whole until the review acknowledges it by id;
 *   - the published receipt holds no id from before the rewrite and no digest
 *     of the mapping (they are in the private record);
 *   - THE ADDRESS GATE, end to end: every shape and place an independent
 *     review found escaping, kept as tests.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { createOwnedTemporaryDirectory } from "../src/filesystem/private-state.ts";
import { sha256 } from "../src/kernel/integrity.ts";
import { ROOT_POLICY } from "../src/kernel/root-policy.ts";
import { importHistory, IMPORT_REVIEW_SCHEMA, removedMarker, type HistoryImportRecord } from "../src/workflow/forge/history-import.ts";
import { addressDigest } from "../src/workflow/forge/history-identities.ts";
import { historyToolPath, historyToolPin, resolveHistoryTool, type HistoryToolName } from "../src/workflow/forge/history-tools.ts";
import { armTestKeyHome } from "../test/support/test-key-home.ts";
import { createTempDir } from "../test/support/temp-dir.ts";
import { AT_REFERENCES, CORAL_KEY, entryOf, FIXTURE_ADDRESS, GIT, git, GITHUB_TOKEN, importOptions, MAKORA_KEY, MAPPED_ADDRESS, NON_ASCII_ADDRESS, pemLine, plantedRepository, SHORT_PASSWORD, UNALLOWED_ADDRESS, write } from "../test/forge/history-fixture.ts";

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

function review(entries: Readonly<{ dispositions?: readonly unknown[]; binaries?: readonly unknown[]; strips?: readonly string[]; addresses?: readonly unknown[] }>): string {
  const path = join(createTempDir("history-import-review-"), "review.json");
  writeFileSync(path, JSON.stringify({
    schema: IMPORT_REVIEW_SCHEMA, dispositions: entries.dispositions ?? [], binaries: entries.binaries ?? [],
    ...(entries.strips === undefined ? {} : { strips: entries.strips.map((oid) => ({ oid, reason: "read in strip.json: dropped from the published history on purpose" })) }),
    ...(entries.addresses === undefined ? {} : { addresses: entries.addresses }),
  }));
  return path;
}

/** What the import of `request` would strip whole, as its dry run lists it privately (`strip.json`): each blob's id, paths and why. */
async function stripListed(home: string, request: Readonly<{ source: string; identityMap?: string; review?: string }>, options = importOptions(home)): Promise<readonly Readonly<{ oid: string; paths: readonly string[]; why: readonly string[]; acknowledged: boolean }>[]> {
  const dry = await importHistory({ ...request, dryRun: true }, options);
  const listed = JSON.parse(readFileSync(join(home, POLICY.runsFolder, dry.id, "strip.json"), "utf8")) as { strip: { oid: string; paths: string[]; why: string[]; acknowledged: boolean }[] };
  assert.equal(dry.strip.blobs, listed.strip.length, "the dry run counts what strip.json lists");
  return listed.strip;
}

/** What the import answered by `receipt` measured before the rewrite: its private record's counts (never published). */
function measured(home: string, receipt: Readonly<{ id: string }>): HistoryImportRecord["measured"] {
  return (JSON.parse(readFileSync(join(home, POLICY.runsFolder, receipt.id, "record.json"), "utf8")) as HistoryImportRecord).measured;
}

/** The private record of the import answered by `receipt` (never published). */
function privateRecord(home: string, receipt: Readonly<{ id: string }>): Readonly<{ beforeRefs: Readonly<Record<string, string>>; firstChangedCommits: readonly string[]; strippedBlobs: readonly { oid: string; paths: string[] }[]; mapSha256: string | null }> {
  return JSON.parse(readFileSync(join(home, POLICY.runsFolder, receipt.id, "record.json"), "utf8")) as ReturnType<typeof privateRecord>;
}

test("a planted history (UTF-16LE included) is found, purged, re-scanned to zero and pushed; the target holds no planted value", async () => {
  const home = testImportHome();
  const source = plantedRepository();
  write(source, "windows/settings.txt", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`token = ${GITHUB_TOKEN}\r\n`, "utf16le")]));
  write(source, "windows/bare.txt", Buffer.from(`key = ${MAKORA_KEY}\r\n`, "utf16le"));
  git(source, "add", ".");
  git(source, "commit", "-q", "-m", "UTF-16LE settings, with and without a BOM");
  // Nothing is stripped silently: the three blobs the rewrite cannot rewrite in place are refused until acknowledged.
  const unacknowledged = await refusalFolder(importHistory({ source, target: bareTarget() }, importOptions(home)), "history_import_strip_unreviewed");
  const strip = (JSON.parse(readFileSync(join(unacknowledged, "strip.json"), "utf8")) as { strip: { oid: string; paths: string[]; why: string[] }[] }).strip;
  assert.deepEqual(strip.map((blob) => [blob.paths, blob.why]).sort(), [[["assets/blob.bin"], ["secret"]], [["windows/bare.txt"], ["secret"]], [["windows/settings.txt"], ["secret"]]].sort(), "each blob to strip, with its paths and why");
  assert.deepEqual((await stripListed(home, { source })).map((blob) => blob.oid), strip.map((blob) => blob.oid), "the dry run lists the same blobs");
  const target = bareTarget();
  const receipt = await importHistory({ source, target, review: review({ strips: strip.map((blob) => blob.oid) }) }, importOptions(home));

  assert.deepEqual(measured(home, receipt).findings.catalogue, Object.fromEntries([[entryOf(CORAL_KEY), 2], [entryOf(`Pwd=${SHORT_PASSWORD};`), 2], [entryOf(MAKORA_KEY), 2], [entryOf(GITHUB_TOKEN), 3]].sort(([a], [b]) => (String(a) < String(b) ? -1 : 1))));
  assert.ok((measured(home, receipt).findings.oracle.covered["github-pat"] ?? 0) >= 1, "the oracle saw the token and the catalogue covers it");
  assert.equal(measured(home, receipt).purge.strippedBlobs, 3, "the binary blob and both UTF-16LE blobs are stripped whole");
  assert.equal(measured(home, receipt).findings.review.strips, 3);
  assert.equal(receipt.after.catalogueHits, 0);
  assert.equal(receipt.after.oracleGaps, 0);
  assert.equal(measured(home, receipt).before.objects.blob - 3, receipt.after.objects.blob);

  const content = everything(target);
  for (const value of [GITHUB_TOKEN, CORAL_KEY, MAKORA_KEY, `Pwd=${SHORT_PASSWORD}`]) assert.ok(!holds(content, value), "a planted value reached the target");
  for (const entry of [GITHUB_TOKEN, MAKORA_KEY, CORAL_KEY, `Pwd=${SHORT_PASSWORD};`].map(entryOf)) assert.ok(content.includes(removedMarker(entry)), `${entry} has its marker`);
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
  // NO CONFIRMATION ORACLE: no id from before the rewrite (a commit's, a stripped blob's) is published; the private record keeps them.
  const record = privateRecord(home, receipt);
  const oldIds = git(source, "rev-list", "--objects", "--all", "--no-object-names").trim().split("\n");
  const newIds = new Set(git(target, "rev-list", "--objects", "--all", "--no-object-names").trim().split("\n"));
  const removed = oldIds.filter((oid) => !newIds.has(oid));
  assert.ok(removed.length > 0 && removed.every((oid) => !recorded.includes(oid)), "an id the rewrite replaced is in the published receipt");
  assert.deepEqual(record.beforeRefs, Object.fromEntries(git(source, "for-each-ref", "--format=%(refname) %(objectname)").trim().split("\n").map((line) => line.split(" ")).sort(([a], [b]) => (a! < b! ? -1 : 1))));
  assert.deepEqual(record.strippedBlobs.map((blob) => blob.oid).sort(), strip.map((blob) => blob.oid).sort());

  await assert.rejects(importHistory({ source, target }, importOptions(home)), refusedWith("history_import_target_not_empty"));
});

test("an undecodable object is refused until the review exempts it by id; its credential is still found and stripped", async () => {
  const home = testImportHome();
  const source = createTempDir("history-import-undecodable-");
  git(source, "init", "-q", "-b", "main");
  write(source, "logo.png", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xc3, 0x28]), Buffer.from(` ${CORAL_KEY} `, "latin1"), Buffer.from([0xfe, 0x00])]));
  write(source, "README.md", "a logo\n");
  git(source, "add", ".");
  git(source, "commit", "-q", "-m", "a logo");
  const folder = await refusalFolder(importHistory({ source, target: bareTarget() }, importOptions(home)), "history_import_undecodable");
  const listed = JSON.parse(readFileSync(join(folder, "undecodable.json"), "utf8")) as { undecodable: { oid: string; paths: string[] }[] };
  assert.deepEqual(listed.undecodable.map((entry) => entry.paths), [["logo.png"]]);
  const target = bareTarget();
  const exempted = { binaries: [{ oid: listed.undecodable[0]!.oid, reason: "the project logo, reviewed" }] };
  await assert.rejects(importHistory({ source, target: bareTarget(), review: review(exempted) }, importOptions(home)), refusedWith("history_import_strip_unreviewed"));
  const receipt = await importHistory({ source, target, review: review({ ...exempted, strips: [listed.undecodable[0]!.oid] }) }, importOptions(home));
  assert.equal(measured(home, receipt).purge.strippedBlobs, 1, "its credential was found byte for byte, so it is stripped");
  assert.deepEqual(privateRecord(home, receipt).strippedBlobs, [{ oid: listed.undecodable[0]!.oid, paths: ["logo.png"] }]);
  assert.equal(measured(home, receipt).findings.review.binaries, 1);
  assert.ok(!holds(everything(target), CORAL_KEY));
});

test("an oracle-only secret and a key wider than its catalogue row are refused until a reviewed disposition names the oracle-only value", async () => {
  const home = testImportHome();
  // A Linear API key: a format gitleaks' own rules know and the catalogue does not (the catalogue grows: a
  // format it gains is no longer oracle-only, and this test then needs another one).
  const oracleOnly = ["lin", "_api_"].join("") + "Zq3Wx8Rt6Yv1Nm5Kp9Lb4Hd2Fg7Jk0Ps3Uv6Xa8Bc".slice(0, 40);
  const source = createTempDir("history-import-gap-");
  git(source, "init", "-q", "-b", "main");
  write(source, "notify.txt", `linear: ${oracleOnly}\n`);
  git(source, "add", ".");
  git(source, "commit", "-q", "-m", "a key only the oracle knows");
  const gapFolder = await refusalFolder(importHistory({ source, target: bareTarget() }, importOptions(home)), "history_import_catalogue_gap");
  // The reviewer's file: each gap's rule, object and value digest — the value itself never.
  const gaps = readFileSync(join(gapFolder, "oracle-gaps.json"), "utf8");
  assert.ok(gaps.includes(sha256(oracleOnly)) && gaps.includes("linear-api-key") && !gaps.includes(oracleOnly));

  const target = bareTarget();
  const receipt = await importHistory({ source, target, review: review({ dispositions: [{ rule: "linear-api-key", secretSha256: sha256(oracleOnly), reason: "a revoked test key, kept for the record" }] }) }, importOptions(home));
  assert.deepEqual(measured(home, receipt).findings.oracle.disposed, { "linear-api-key": 1 });
  assert.deepEqual(receipt.after.oracleDisposed, { "linear-api-key": 1 });
  assert.ok(holds(everything(target), oracleOnly), "a disposed value is not purged");

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
    await importHistory({ source: keyed, target: keyTarget }, importOptions(home));
  } catch (error) {
    refusal = (error as { code?: string }).code;
  }
  if (refusal === undefined) assert.ok(!holds(everything(keyTarget), body.split("\n")[3]!), "a key's body reached the target");
  else assert.equal(refusal, "history_import_catalogue_gap");
});

test("end to end, nothing is pushed when the purge leaves residue (a token in an author name, which a message rewrite never reaches) or when the receipt would carry a home path (a ref named after one)", async () => {
  const home = testImportHome();
  // Residue: filter-repo's --replace-message rewrites messages, never an author; the re-scan finds the token still there.
  const authored = createTempDir("history-import-residue-");
  git(authored, "init", "-q", "-b", "main");
  write(authored, "README.md", "plain\n");
  git(authored, "add", ".");
  execFileSync(GIT, ["-c", `user.name=ci ${GITHUB_TOKEN}`, "-c", "user.email=ci@example.invalid", "commit", "-q", "-m", "authored by a token"], { cwd: authored });
  const residueTarget = bareTarget();
  await assert.rejects(importHistory({ source: authored, target: residueTarget }, importOptions(home, ["ci@example.invalid"])), refusedWith("history_import_residue"));
  assert.equal(git(residueTarget, "for-each-ref").trim(), "", "nothing was pushed");
  // The receipt: a ref git accepts whose name carries a home path would put it in the pushed receipt.
  const named = createTempDir("history-import-receipt-");
  git(named, "init", "-q", "-b", "main");
  write(named, "README.md", "plain\n");
  git(named, "add", ".");
  git(named, "commit", "-q", "-m", "plain");
  git(named, "branch", "notes=/home/user/drafts"); // a documented placeholder home: the tree holds no real one
  const receiptTarget = bareTarget();
  await assert.rejects(importHistory({ source: named, target: receiptTarget }, importOptions(home)), (error: Error & { code?: string }) => error.code === "history_import_receipt_unsafe" && error.message.includes("is an absolute or home path"));
  assert.equal(git(receiptTarget, "for-each-ref").trim(), "", "nothing was pushed");
});

test("end to end, an undecodable object the review exempted is refused AFTER the rewrite when the rewrite gave it a new id (a latin1 tag on a rewritten commit), until the review names the new id, which the deterministic rewrite keeps", async () => {
  const home = testImportHome();
  const source = createTempDir("history-import-latin1-");
  git(source, "init", "-q", "-b", "main");
  write(source, "config.txt", `token = ${GITHUB_TOKEN}\n`);
  git(source, "add", ".");
  git(source, "commit", "-q", "-m", "a token to purge, so every later object that reaches it is rewritten");
  // An annotated tag whose message is latin1 (not UTF-8; a tag has no encoding header for the rewrite to re-encode).
  const message = join(createTempDir("history-import-latin1-message-"), "message");
  writeFileSync(message, Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a])); // "café" in latin1
  execFileSync(GIT, ["-c", "user.name=Import Test", "-c", "user.email=import@example.invalid", "tag", "-a", "v1", "-F", message], { cwd: source });
  const before = git(source, "rev-parse", "refs/tags/v1").trim();
  // Without a review it is refused BEFORE the rewrite, listed with its stage.
  const beforeFolder = await refusalFolder(importHistory({ source, target: bareTarget() }, importOptions(home)), "history_import_undecodable");
  const first = JSON.parse(readFileSync(join(beforeFolder, "undecodable.json"), "utf8")) as { stage: string; undecodable: { oid: string; type: string }[] };
  assert.deepEqual([first.stage, first.undecodable.map((entry) => [entry.oid, entry.type])], ["before the rewrite", [[before, "tag"]]]);
  // A review exempting the tag by its id passes that check; the rewrite gives the tag a new id, which is refused after it.
  let afterFolder = "";
  await assert.rejects(importHistory({ source, target: bareTarget(), review: review({ binaries: [{ oid: before, reason: "a latin1 tag message, reviewed" }] }) }, importOptions(home)), (error: Error & { code?: string; facts?: Readonly<Record<string, unknown>> }) => {
    afterFolder = String(error.facts?.["runFolder"] ?? "");
    return error.code === "history_import_undecodable" && error.message.includes("after the rewrite");
  });
  const listed = JSON.parse(readFileSync(join(afterFolder, "undecodable.json"), "utf8")) as { stage: string; undecodable: { oid: string; type: string }[] };
  assert.equal(listed.stage, "after the rewrite");
  assert.deepEqual(listed.undecodable.map((entry) => entry.type), ["tag"]);
  assert.notEqual(listed.undecodable[0]!.oid, before, "the rewritten tag has a new id");
  // The rewrite is deterministic: a review naming both ids lets the same import through, and the new id is what was pushed.
  const target = bareTarget();
  const receipt = await importHistory({ source, target, review: review({ binaries: [{ oid: before, reason: "a latin1 tag message, reviewed" }, { oid: listed.undecodable[0]!.oid, reason: "the same tag after the rewrite" }] }) }, importOptions(home));
  assert.equal(measured(home, receipt).findings.review.binaries, 2);
  assert.equal(git(target, "rev-parse", "refs/tags/v1").trim(), listed.undecodable[0]!.oid);
});

// ── THE ADDRESS GATE, end to end (every shape the independent review found escaping, P1–P17, kept as tests) ──

/** Everything a reader of `repository` could see: every object's bytes (a tree's listing names every entry), every ref name. */
function published(repository: string): Buffer {
  const listed = git(repository, "rev-list", "--objects", "--all", "--no-object-names").split("\n").filter((line) => line.length > 0);
  const parts = listed.map((oid) => execFileSync(GIT, ["cat-file", "-p", oid], { cwd: repository }));
  parts.push(Buffer.from(git(repository, "for-each-ref", "--format=%(refname)"), "utf8"));
  return Buffer.concat(parts);
}

/** Whether `bytes` hold `address` in any case or reading the review probed: UTF-8 or latin1 (case-folded), UTF-16LE/BE, percent-encoded. */
function holdsAddress(bytes: Buffer, address: string): boolean {
  const folded = (text: string): string => text.normalize("NFKC").toLocaleLowerCase("en-US");
  const target = folded(address);
  return folded(bytes.toString("utf8")).includes(target) || folded(bytes.toString("latin1")).includes(target)
    || bytes.includes(Buffer.from(address, "utf16le")) || bytes.includes(Buffer.from(address, "utf16le").swap16())
    || folded(bytes.toString("utf8")).includes(target.replaceAll("@", "%40"));
}

/** A source with one base commit by the fixture identity. */
function baseSource(): string {
  const source = createTempDir("history-import-address-src-");
  git(source, "init", "-q", "-b", "main");
  write(source, "README.md", "a history with addresses\n");
  git(source, "add", ".");
  git(source, "commit", "-q", "-m", "base");
  return source;
}

/** A source whose one commit is authored by `address` (committed by the fixture identity), with `message`. */
function authoredSource(address: string, message = "base"): string {
  const source = createTempDir("history-import-authored-src-");
  git(source, "init", "-q", "-b", "main");
  write(source, "README.md", "a history with addresses\n");
  git(source, "add", ".");
  execFileSync(GIT, ["commit", "-q", "--author", `Somebody <${address}>`, "-m", message], { cwd: source, env: { ...process.env, GIT_COMMITTER_NAME: "Import Test", GIT_COMMITTER_EMAIL: FIXTURE_ADDRESS } });
  return source;
}

/** A commit of `message` exactly as given (no cleanup of a CRLF, an indent or a trailer shape). */
function commitMessage(source: string, message: string): void {
  writeFileSync(join(source, ".message"), message);
  git(source, "commit", "-q", "--allow-empty", "--cleanup=verbatim", "-F", join(source, ".message"));
}

/** The one identity mapping file, kept OUTSIDE the public tree (as the coordination repository keeps it). */
function identityMapFile(lines: readonly string[]): string {
  const path = join(createTempDir("history-import-identity-map-"), "identities.mailmap");
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

/** The import of `source` is refused with `code`, naming objects (never `address`, in the message or in addresses.json), and nothing reaches the target. */
async function refusedWithoutEcho(home: string, source: string, address: string, code: string, extra: Readonly<{ identityMap?: string; options?: ReturnType<typeof importOptions> }> = {}): Promise<Readonly<{ objects: readonly string[]; refs: number }>> {
  const target = bareTarget();
  let message = "";
  let folder = "";
  await assert.rejects(importHistory({ source, target, ...(extra.identityMap === undefined ? {} : { identityMap: extra.identityMap }) }, extra.options ?? importOptions(home)), (error: Error & { code?: string; facts?: Readonly<Record<string, unknown>> }) => {
    message = error.message;
    folder = String(error.facts?.["runFolder"] ?? "");
    return error.code === code;
  });
  assert.ok(!holdsAddress(Buffer.from(message, "utf8"), address), `${code}: the refusal never echoes the address`);
  const listed = readFileSync(join(folder, "addresses.json"));
  assert.ok(!holdsAddress(listed, address), `${code}: addresses.json names digests and objects, never the address`);
  assert.equal(git(target, "for-each-ref").trim(), "", `${code}: nothing was pushed`);
  const parsed = JSON.parse(listed.toString("utf8")) as { addresses: { addressSha256: string; objects: string[]; refs: number }[] };
  assert.ok(parsed.addresses.some((entry) => entry.addressSha256 === addressDigest(address)), "the address is listed by its digest");
  return { objects: parsed.addresses.flatMap((entry) => entry.objects), refs: parsed.addresses.reduce((sum, entry) => sum + entry.refs, 0) };
}

const MAP = (): string => identityMapFile([`Mapped Person <${MAPPED_ADDRESS}> <${UNALLOWED_ADDRESS}>`, `<${MAPPED_ADDRESS}> <${NON_ASCII_ADDRESS}>`]);

test("THE ADDRESS GATE refuses, before anything is rewritten or pushed and by object id, an unallowed address in every shape and place the review found escaping (P1–P7, P12, P14, P16, the author, a trailer)", async () => {
  const home = testImportHome();
  const cases: readonly (readonly [string, () => string])[] = [
    ["the author", () => authoredSource(UNALLOWED_ADDRESS)],
    ["a trailer alone", () => { const s = baseSource(); commitMessage(s, `change\n\nSigned-off-by: Somebody <${UNALLOWED_ADDRESS}>\n`); return s; }],
    ["P1 free text in a message", () => { const s = baseSource(); commitMessage(s, `free text: contact ${UNALLOWED_ADDRESS} for details\n`); return s; }],
    ["P2 a CRLF trailer", () => { const s = baseSource(); commitMessage(s, `change\r\n\r\nSigned-off-by: Somebody <${UNALLOWED_ADDRESS}>\r\n`); return s; }],
    ["P2b a CRLF trailer through commit-tree", () => {
      const s = baseSource();
      const oid = execFileSync(GIT, ["-c", "user.name=Import Test", "-c", `user.email=${FIXTURE_ADDRESS}`, "commit-tree", git(s, "rev-parse", "HEAD^{tree}").trim(), "-p", git(s, "rev-parse", "HEAD").trim()], { cwd: s, input: `change\r\n\r\nSigned-off-by: Somebody <${UNALLOWED_ADDRESS}>\r\n` }).toString().trim();
      git(s, "update-ref", "refs/heads/main", oid);
      return s;
    }],
    ["P3 an indented trailer", () => { const s = baseSource(); commitMessage(s, `change\n\n    Signed-off-by: Somebody <${UNALLOWED_ADDRESS}>\n`); return s; }],
    ["P4 a bare-address trailer", () => { const s = baseSource(); commitMessage(s, `change\n\nSigned-off-by: ${UNALLOWED_ADDRESS}\n`); return s; }],
    ["P4b a trailer with a comment", () => { const s = baseSource(); commitMessage(s, `change\n\nReviewed-by: Somebody <${UNALLOWED_ADDRESS}> (on the list)\n`); return s; }],
    ["P5 a tag message", () => { const s = baseSource(); git(s, "tag", "-a", "v1", "-m", `release by ${UNALLOWED_ADDRESS}`); return s; }],
    ["P6 a note", () => { const s = baseSource(); git(s, "notes", "add", "-m", `noted by Somebody <${UNALLOWED_ADDRESS}>`, "HEAD"); return s; }],
    ["P7 file content", () => { const s = baseSource(); write(s, "AUTHORS", `Somebody <${UNALLOWED_ADDRESS}>\n`); git(s, "add", "."); git(s, "commit", "-q", "-m", "authors"); return s; }],
    ["P12 a mergetag continuation line", () => {
      const s = baseSource();
      const tree = git(s, "rev-parse", "HEAD^{tree}").trim();
      const parent = git(s, "rev-parse", "HEAD").trim();
      const body = `tree ${tree}\nparent ${parent}\nparent ${parent}\nauthor Import Test <${FIXTURE_ADDRESS}> 1700000000 +0000\ncommitter Import Test <${FIXTURE_ADDRESS}> 1700000000 +0000\nmergetag object ${parent}\n type commit\n tag v9\n tagger Somebody <${UNALLOWED_ADDRESS}> 1700000000 +0000\n \n a merged tag\n\nmerge\n`;
      git(s, "update-ref", "refs/heads/main", execFileSync(GIT, ["hash-object", "-t", "commit", "-w", "--literally", "--stdin"], { cwd: s, input: body }).toString().trim());
      return s;
    }],
    ["P16 a UTF-16LE tag message", () => {
      const s = baseSource();
      const body = Buffer.concat([Buffer.from(`object ${git(s, "rev-parse", "HEAD").trim()}\ntype commit\ntag v2\ntagger Import Test <${FIXTURE_ADDRESS}> 1700000000 +0000\n\n`), Buffer.from(`release\nSigned-off-by: Somebody <${UNALLOWED_ADDRESS}>\n`, "utf16le")]);
      git(s, "update-ref", "refs/tags/v2", execFileSync(GIT, ["hash-object", "-t", "tag", "-w", "--stdin"], { cwd: s, input: body }).toString().trim());
      return s;
    }],
  ];
  for (const [name, make] of cases) {
    const source = make();
    const { objects } = await refusedWithoutEcho(home, source, UNALLOWED_ADDRESS, "history_import_identity_unallowed");
    assert.ok(objects.length > 0, `${name}: the refusal names the object`);
  }
  // P14: a compatibility spelling (the Kelvin sign) is folded before it is compared: still not on the list.
  const kelvin = "\u212Amport.private@example.invalid";
  await refusedWithoutEcho(home, authoredSource(kelvin), kelvin, "history_import_identity_unallowed", { options: importOptions(home, ["kmport@example.invalid"]) });
});

test("THE ADDRESS MAPPING is applied by the importer itself in its one rewrite, for every shape it can reach (P0, P10, P11, P13, P13b, P17): nothing of the mapped-from address reaches the target, in any case, reading or encoding; the rewrite is deterministic", async () => {
  const home = testImportHome();
  const cases: readonly (readonly [string, string, () => string])[] = [
    ["P0 the author", UNALLOWED_ADDRESS, () => authoredSource(UNALLOWED_ADDRESS)],
    ["P10 a UTF-16LE file (stripped whole)", UNALLOWED_ADDRESS, () => { const s = authoredSource(UNALLOWED_ADDRESS); write(s, "contacts.txt", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`owner = ${UNALLOWED_ADDRESS}\r\n`, "utf16le")])); git(s, "add", "."); git(s, "commit", "-q", "-m", "utf16"); return s; }],
    ["P11 RFC 2047 and percent-encoded in a message", UNALLOWED_ADDRESS, () => { const s = authoredSource(UNALLOWED_ADDRESS); commitMessage(s, `change\n\nreported as =?UTF-8?Q?${UNALLOWED_ADDRESS.replaceAll("@", "=40")}?= and ${UNALLOWED_ADDRESS.replaceAll("@", "%40")}\n`); return s; }],
    ["P13 a non-ASCII address, upper case, in a file", NON_ASCII_ADDRESS, () => { const s = authoredSource(NON_ASCII_ADDRESS); write(s, "MAINTAINERS", `maintainer ${NON_ASCII_ADDRESS.toUpperCase()}\n`); git(s, "add", "."); git(s, "commit", "-q", "-m", "maintainers"); return s; }],
    ["P13b a non-ASCII address in a binary blob (stripped whole)", NON_ASCII_ADDRESS, () => { const s = authoredSource(NON_ASCII_ADDRESS); write(s, "bin.dat", Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(` ${NON_ASCII_ADDRESS}\n`, "utf8")])); git(s, "add", "."); git(s, "commit", "-q", "-m", "binary"); return s; }],
    ["P17 a non-ASCII trailer in upper case", NON_ASCII_ADDRESS, () => authoredSource(NON_ASCII_ADDRESS, `base\n\nSigned-off-by: Jose <${NON_ASCII_ADDRESS.toUpperCase()}>`)],
  ];
  for (const [name, address, make] of cases) {
    const source = make();
    const target = bareTarget();
    const identityMap = MAP();
    // A blob no rewrite reaches in place is stripped whole, and only once the review acknowledges it by id.
    const strips = (await stripListed(home, { source, identityMap })).map((blob) => blob.oid);
    assert.equal(strips.length, name.includes("stripped whole") ? 1 : 0, `${name}: the blobs to strip`);
    const receipt = await importHistory({ source, target, identityMap, ...(strips.length === 0 ? {} : { review: review({ strips }) }) }, importOptions(home));
    assert.ok(!holdsAddress(published(target), address) && !holdsAddress(published(target), address.toUpperCase()), `${name}: the mapped-from address reached the target`);
    assert.ok(holdsAddress(published(target), MAPPED_ADDRESS), `${name}: the mapped address is published in its place`);
    assert.ok(measured(home, receipt).identities.mappedAddresses >= 1 && measured(home, receipt).identities.rewrittenObjects >= 1, name);
  }
  // Deterministic: the same source and mapping give the same ids.
  const source = authoredSource(UNALLOWED_ADDRESS, `a change\n\nSigned-off-by: Somebody <${UNALLOWED_ADDRESS}>`);
  const ids = [];
  for (let index = 0; index < 2; index += 1) {
    const receipt = await importHistory({ source, target: bareTarget(), identityMap: MAP() }, importOptions(home));
    ids.push(receipt.refMap.map((ref) => `${ref.target} ${ref.oid}`).join("\n"));
    assert.ok(measured(home, receipt).identities.changedCommits >= 1, "the commit map records the rewritten commits");
  }
  assert.equal(ids[0], ids[1]);
});

test("A MAPPED-FROM ADDRESS the rewrite cannot reach is refused BEFORE the rewrite, in every spelling and place (P8 a path, P9 a ref name, a shared tree's folder name, and every encoding, escape and obfuscation the second review pushed)", async () => {
  const home = testImportHome();
  const [local, domain] = UNALLOWED_ADDRESS.split("@") as [string, string];
  const inFile = (text: string) => (): string => { const s = authoredSource(UNALLOWED_ADDRESS); write(s, "contacts.txt", text); git(s, "add", "."); git(s, "commit", "-q", "-m", "contacts"); return s; };
  const cases: readonly (readonly [string, () => string])[] = [
    ["P8 a path", () => { const s = authoredSource(UNALLOWED_ADDRESS); write(s, `people/${UNALLOWED_ADDRESS}`, "hello\n"); git(s, "add", "."); git(s, "commit", "-q", "-m", "a path"); return s; }],
    ["P9 a ref name", () => { const s = authoredSource(UNALLOWED_ADDRESS); git(s, "branch", `${UNALLOWED_ADDRESS}/topic`); return s; }],
    ["N8c a folder named after it whose tree another folder shares", () => { const s = authoredSource(UNALLOWED_ADDRESS); write(s, "a/same.txt", "y\n"); write(s, `${UNALLOWED_ADDRESS}/same.txt`, "y\n"); git(s, "add", "."); git(s, "commit", "-q", "-m", "a shared tree"); return s; }],
    ["an HTML entity", inFile(`${local}${AT_REFERENCES.decimal}${domain}\n`)],
    ["quoted-printable =40", inFile(`${local}=40${domain}\n`)],
    ["a quoted-printable soft break before @", inFile(`${local}=\n@${domain}\n`)],
    ["base64", inFile(`${Buffer.from(`write to ${UNALLOWED_ADDRESS} please`).toString("base64")}\n`)],
    ["a line folded after @", inFile(`${local}@\n ${domain}\n`)],
    ["fullwidth @", inFile(`${local}\uff20${domain}\n`)],
    ["[at] and [dot]", inFile(`${local} [at] ${domain.replaceAll(".", " [dot] ")}\n`)],
    ["a quoted local part", inFile(`"${local}"@${domain}\n`)],
    ["base64 in a git note", () => { const s = authoredSource(UNALLOWED_ADDRESS); git(s, "notes", "add", "-m", Buffer.from(`by ${UNALLOWED_ADDRESS}`).toString("base64"), "HEAD"); return s; }],
    // The third review's escapes (K1, K4, K13, K15, K19): the skeleton search reads each.
    ["K1 mixed case, a soft hyphen reference, an @ reference", inFile(`SomeOne.Pri${AT_REFERENCES.softHyphen}vate${AT_REFERENCES.decimal}Example.INVALID\n`)],
    ["K4 a reference without its semicolon", inFile(`${local}${AT_REFERENCES.decimal.slice(0, -1)}${domain}\n`)],
    ["K13 letter-spaced", inFile(`${[...UNALLOWED_ADDRESS].join(" ")}\n`)],
    ["K15 ideographic full stops", inFile(`${local.replaceAll(".", "\u3002")}@${domain.replaceAll(".", "\u3002")}\n`)],
    ["K19 an octal escape", inFile(`${local}\\100${domain}\n`)],
  ];
  for (const [name, make] of cases) {
    const { objects, refs } = await refusedWithoutEcho(home, make(), UNALLOWED_ADDRESS, "history_import_identity_unreachable", { identityMap: MAP() });
    assert.ok(objects.length > 0 || refs > 0, `${name}: the refusal names the object (or counts the ref name)`);
  }
});

test("EVERY NAME is judged, whatever object it shares (N8, SP1): an address or a secret in a file name beside a blob another path holds is refused, never pushed", async () => {
  const home = testImportHome();
  const shared = (name: string): string => { const s = baseSource(); write(s, name, "a history with addresses\n"); git(s, "add", "."); git(s, "commit", "-q", "-m", "a shared blob under another name"); return s; };
  await refusedWithoutEcho(home, shared(`people/${UNALLOWED_ADDRESS}.txt`), `${UNALLOWED_ADDRESS}.txt`, "history_import_identity_unallowed");
  const target = bareTarget();
  await assert.rejects(importHistory({ source: shared(`keys/${GITHUB_TOKEN}`), target }, importOptions(home)), refusedWith("history_import_secret_in_name"));
  assert.equal(git(target, "for-each-ref").trim(), "", "nothing was pushed");
});

test("THE CENSUS AFTER THE REWRITE has teeth: a mapped address the plan reads but the rewrite does not replace (a latin1 commit message, exempted as undecodable; a bare base64 run beside an encoded word) is refused before the push; one the rewrite drops (a mergetag header, a UTF-16 tag message) is proven gone by it and never published", async () => {
  const home = testImportHome();
  const latin1 = authoredSource(UNALLOWED_ADDRESS);
  const messageFile = join(createTempDir("history-import-latin1-address-"), "message");
  writeFileSync(messageFile, Buffer.concat([Buffer.from("caf"), Buffer.from([0xe9]), Buffer.from(` by ${UNALLOWED_ADDRESS}\n`)]));
  execFileSync(GIT, ["-c", "i18n.commitEncoding=ISO-8859-1", "-c", "user.name=Import Test", "-c", `user.email=${FIXTURE_ADDRESS}`, "commit", "-q", "--allow-empty", "-F", messageFile], { cwd: latin1 });
  const latin1Commit = git(latin1, "rev-parse", "HEAD").trim();
  const exempt = review({ binaries: [{ oid: latin1Commit, reason: "a latin1 message, reviewed" }] });
  let message = "";
  const target = bareTarget();
  await assert.rejects(importHistory({ source: latin1, target, identityMap: MAP(), review: exempt }, importOptions(home)), (error: Error & { code?: string }) => {
    message = error.message;
    return error.code === "history_import_identity_residue";
  });
  assert.ok(!holdsAddress(Buffer.from(message), UNALLOWED_ADDRESS), "the refusal never echoes the address");
  assert.equal(git(target, "for-each-ref").trim(), "", "nothing was pushed");
  // Only the KNOWN search reads base64: beside an RFC 2047 B-word the rewrite replaces, a bare base64 run of the
  // address passes the plan, and the census after the rewrite refuses what is left.
  const beside = authoredSource(UNALLOWED_ADDRESS);
  commitMessage(beside, `change\n\nreported as =?utf-8?B?${Buffer.from(UNALLOWED_ADDRESS).toString("base64")}?=\nraw ${Buffer.from(`by ${UNALLOWED_ADDRESS} today`).toString("base64")}\n`);
  await refusedWithoutEcho(home, beside, UNALLOWED_ADDRESS, "history_import_identity_residue", { identityMap: MAP() });
  const dropped: readonly (readonly [string, () => string])[] = [
    ["a mergetag header", () => {
      const s = authoredSource(UNALLOWED_ADDRESS);
      const tree = git(s, "rev-parse", "HEAD^{tree}").trim();
      const parent = git(s, "rev-parse", "HEAD").trim();
      const body = `tree ${tree}\nparent ${parent}\nparent ${parent}\nauthor Import Test <${FIXTURE_ADDRESS}> 1700000000 +0000\ncommitter Import Test <${FIXTURE_ADDRESS}> 1700000000 +0000\nmergetag object ${parent}\n type commit\n tag v9\n tagger Somebody <${UNALLOWED_ADDRESS}> 1700000000 +0000\n \n a merged tag\n\nmerge\n`;
      git(s, "update-ref", "refs/heads/main", execFileSync(GIT, ["hash-object", "-t", "commit", "-w", "--literally", "--stdin"], { cwd: s, input: body }).toString().trim());
      return s;
    }],
    ["a UTF-16LE tag message", () => {
      const s = authoredSource(UNALLOWED_ADDRESS);
      const body = Buffer.concat([Buffer.from(`object ${git(s, "rev-parse", "HEAD").trim()}\ntype commit\ntag v2\ntagger Import Test <${FIXTURE_ADDRESS}> 1700000000 +0000\n\n`), Buffer.from(`release\nSigned-off-by: Somebody <${UNALLOWED_ADDRESS}>\n`, "utf16le")]);
      git(s, "update-ref", "refs/tags/v2", execFileSync(GIT, ["hash-object", "-t", "tag", "-w", "--stdin"], { cwd: s, input: body }).toString().trim());
      return s;
    }],
  ];
  for (const [name, make] of dropped) {
    const target = bareTarget();
    await importHistory({ source: make(), target, identityMap: MAP() }, importOptions(home));
    assert.ok(!holdsAddress(published(target), UNALLOWED_ADDRESS), `${name}: the address reached the target`);
  }
});

test("NO CONFIRMATION ORACLE (O1-O3): the published receipt of a mapped import holds no id from before the rewrite and no digest of the mapping, so a guessed address put back into a public commit confirms nothing; the private record keeps them", async () => {
  const home = testImportHome();
  const source = authoredSource(UNALLOWED_ADDRESS, `a change\n\nSigned-off-by: Somebody <${UNALLOWED_ADDRESS}>`);
  const identityMap = MAP();
  const target = bareTarget();
  const receipt = await importHistory({ source, target, identityMap }, importOptions(home));
  const published_ = git(target, "show", `${POLICY.receipt.ref}:${POLICY.receipt.folder}/${receipt.id}.json`);
  const oldIds = git(source, "rev-list", "--objects", "--all", "--no-object-names").trim().split("\n");
  const oldCommit = git(source, "rev-parse", "HEAD").trim();
  assert.notEqual(git(target, "rev-parse", "refs/heads/main").trim(), oldCommit, "the commit was rewritten");
  for (const oid of oldIds.filter((one) => !git(target, "rev-list", "--objects", "--all", "--no-object-names").includes(one))) assert.ok(!published_.includes(oid), "an old id is published");
  assert.ok(!published_.includes(sha256(readFileSync(identityMap, "utf8"))), "the mapping's digest is published");
  // Put the guessed address back into the public commit: its hash would equal the old id, which is nowhere public.
  const guessed = git(target, "cat-file", "commit", "refs/heads/main").replaceAll(`Mapped Person <${MAPPED_ADDRESS}>`, `Somebody <${UNALLOWED_ADDRESS}>`).replaceAll(MAPPED_ADDRESS, UNALLOWED_ADDRESS);
  const rehashed = execFileSync(GIT, ["hash-object", "-t", "commit", "--stdin"], { cwd: target, input: guessed }).toString().trim();
  assert.ok(!published_.includes(rehashed), "the receipt confirms the guess");
  const record = privateRecord(home, receipt);
  assert.equal(record.beforeRefs["refs/heads/main"], oldCommit, "the private record keeps the old ids");
  assert.equal(record.mapSha256, sha256(readFileSync(identityMap, "utf8")));
});

test("THE ORACLE CLASS (O2, O3): notes follow their rewritten commits (each note names the NEW id; no old id is published), and an old commit id left anywhere else (a .git-blame-ignore-revs) is refused before the push; THE SIDE-CHANNEL CLASS (O5): the published receipt carries nothing measured before the rewrite", async () => {
  const home = testImportHome();
  // O2: a note on the commit the mapping rewrites.
  const noted = authoredSource(UNALLOWED_ADDRESS);
  git(noted, "notes", "add", "-m", "reviewed by the team", "HEAD");
  const oldCommit = git(noted, "rev-parse", "HEAD").trim();
  const notedTarget = bareTarget();
  const notedReceipt = await importHistory({ source: noted, target: notedTarget, identityMap: MAP() }, importOptions(home));
  const newCommit = git(notedTarget, "rev-parse", "refs/heads/main").trim();
  assert.notEqual(newCommit, oldCommit, "the commit was rewritten");
  assert.equal(git(notedTarget, "notes", "show", newCommit).trim(), "reviewed by the team", "the note annotates the rewritten commit");
  const everyId = git(notedTarget, "rev-list", "--objects", "--all").toLowerCase();
  const allPaths = git(notedTarget, "log", "--all", "--format=%T").trim().split("\n").flatMap((tree) => git(notedTarget, "ls-tree", "-r", "-t", "--name-only", tree).split("\n")).join("\n").replaceAll("/", "");
  assert.ok(!everyId.includes(oldCommit) && !allPaths.includes(oldCommit.slice(0, 7)) && !published(notedTarget).includes(oldCommit.slice(0, 7)), "the old commit id is published nowhere");
  assert.ok(measured(home, notedReceipt).identities.notesCommitsRewritten >= 1);
  // O3: a list of commit ids names the old root commit.
  const listed = authoredSource(UNALLOWED_ADDRESS);
  write(listed, ".git-blame-ignore-revs", `${git(listed, "rev-parse", "HEAD").trim()}\n`);
  git(listed, "add", ".");
  git(listed, "commit", "-q", "-m", "ignore the first commit in blame");
  const listedTarget = bareTarget();
  let message = "";
  await assert.rejects(importHistory({ source: listed, target: listedTarget, identityMap: MAP() }, importOptions(home)), (error: Error & { code?: string }) => {
    message = error.message;
    return error.code === "history_import_old_id_residue";
  });
  assert.ok(!message.includes(git(listed, "rev-parse", "HEAD~1").trim().slice(0, 7)), "the refusal names no old id");
  assert.equal(git(listedTarget, "for-each-ref").trim(), "", "nothing was pushed");
  // O5: no count measured before the rewrite is published (the byte total's difference is the replaced identities' length).
  const target = bareTarget();
  const receipt = await importHistory({ source: authoredSource(UNALLOWED_ADDRESS), target, identityMap: MAP() }, importOptions(home));
  const published_ = JSON.parse(git(target, "show", `${POLICY.receipt.ref}:${POLICY.receipt.folder}/${receipt.id}.json`)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(published_).sort(), ["after", "allowedIdentitiesSha256", "id", "importedAt", "refMap", "schema", "source", "target", "tools"]);
  assert.ok(measured(home, receipt).before.scannedBytes > 0, "the private record keeps it");
});

test("NOTHING IS STRIPPED SILENTLY (S1, S2): a blob holding a mapped address the rewrite cannot replace in place is counted and listed with its paths by the dry run, refused until the review acknowledges it by id, then stripped", async () => {
  const home = testImportHome();
  const source = authoredSource(UNALLOWED_ADDRESS);
  write(source, "contacts.txt", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`owner = ${UNALLOWED_ADDRESS}\r\nother data\r\n`, "utf16le")]));
  git(source, "add", ".");
  git(source, "commit", "-q", "-m", "contacts");
  const identityMap = MAP();
  const dry = await importHistory({ source, identityMap, dryRun: true }, importOptions(home));
  assert.deepEqual(dry.strip, { blobs: 1, unreviewed: 1 });
  const listed = await stripListed(home, { source, identityMap });
  assert.deepEqual(listed.map((blob) => [blob.paths, blob.why, blob.acknowledged]), [[["contacts.txt"], ["address"], false]]);
  const unacknowledged = bareTarget();
  await assert.rejects(importHistory({ source, target: unacknowledged, identityMap }, importOptions(home)), refusedWith("history_import_strip_unreviewed"));
  assert.equal(git(unacknowledged, "for-each-ref").trim(), "", "nothing was pushed");
  const target = bareTarget();
  const receipt = await importHistory({ source, target, identityMap, review: review({ strips: [listed[0]!.oid] }) }, importOptions(home));
  assert.equal(measured(home, receipt).identities.strippedBlobs, 1);
  assert.ok(!holdsAddress(published(target), UNALLOWED_ADDRESS));
});

test("THE RECEIPT passes the same census: a receipt identity not on the allowed list is refused before the push", async () => {
  const home = testImportHome();
  const options = { ...importOptions(home), allowedIdentities: [FIXTURE_ADDRESS] };
  await refusedWithoutEcho(home, baseSource(), POLICY.identity.email, "history_import_identity_residue", { options });
});

test("THE REVIEW disposes of an address-shaped string that is not a person's (by the digest of its folded form), and the dry run counts every address and what resolves it", async () => {
  const home = testImportHome();
  const placeholder = "Placeholder@Example.invalid";
  const source = authoredSource(UNALLOWED_ADDRESS);
  write(source, "docs/usage.md", `send the report to ${placeholder}\n`);
  git(source, "add", ".");
  git(source, "commit", "-q", "-m", "usage");
  const dry = await importHistory({ source, dryRun: true }, importOptions(home));
  assert.deepEqual([dry.identities.unallowedAddresses, dry.identities.mappedAddresses, dry.identities.disposedAddresses, dry.identities.unresolvedAddresses], [2, 0, 0, 2]);
  assert.ok(!holdsAddress(Buffer.from(JSON.stringify(dry)), UNALLOWED_ADDRESS) && !holdsAddress(Buffer.from(JSON.stringify(dry)), placeholder), "the dry run's report holds no address");
  const reviewPath = join(createTempDir("history-import-address-review-"), "review.json");
  writeFileSync(reviewPath, JSON.stringify({ schema: IMPORT_REVIEW_SCHEMA, dispositions: [], addresses: [{ addressSha256: addressDigest(placeholder.toLowerCase()), reason: "a documentation placeholder, not a person's address" }] }));
  const mapped = await importHistory({ source, dryRun: true, review: reviewPath, identityMap: MAP() }, importOptions(home));
  assert.deepEqual([mapped.identities.unallowedAddresses, mapped.identities.mappedAddresses, mapped.identities.disposedAddresses, mapped.identities.unresolvedAddresses], [2, 1, 1, 0]);
  const target = bareTarget();
  const receipt = await importHistory({ source, target, review: reviewPath, identityMap: MAP() }, importOptions(home));
  assert.equal(measured(home, receipt).identities.disposedAddresses, 1);
  assert.ok(holdsAddress(published(target), placeholder), "a disposed string is published as it was");
  assert.ok(!holdsAddress(published(target), UNALLOWED_ADDRESS));
});
