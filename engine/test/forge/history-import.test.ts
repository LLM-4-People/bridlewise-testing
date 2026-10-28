/**
 * THE HISTORY IMPORTER, HERMETIC (`src/workflow/forge/history-import.ts`,
 * `history-tools.ts`, `gitleaks-config.ts`, `generated-files.ts`) — every
 * step that needs only git, driven over planted repositories; the whole
 * pipeline with the pinned tools is the live suite's (`live/history-import.test.ts`).
 *
 *   - ENUMERATE + CATALOGUE SCAN: secrets planted in a text blob, a binary
 *     blob, a commit message, a tag message, a note and on a `refs/pull/*`
 *     ref are each found with their entry; near-misses (a `cb_` callback
 *     name, `risk-…`, `desk_…`) are not; a secret in a
 *     PATH or a REF NAME is a name hit (refused, never purged);
 *   - THE PURGE PLAN: deterministic; long values replaced alone, longest
 *     first; a short value only inside its line window; a binary blob with a
 *     hit stripped whole; an inexpressible line refused;
 *   - THE ORACLE JUDGEMENT: a finding a catalogue value contains is covered;
 *     one wider than every catalogue value, or unknown to it, is a gap (a
 *     `bridlewise-` rule's gap is a projection divergence); a reviewed
 *     disposition excuses exactly its rule and value digest;
 *   - REFS: kept namespaces keep their names, others move under the
 *     imported prefix, collisions (the receipt's own ref included) refused;
 *   - THE ORACLE'S CONFIGURATION: every catalogue row is projected or named
 *     with its reason (a lookaround is never approximated), and the text is
 *     deterministic;
 *   - THE PINNED TOOLS: absent → the provisioning command; other bytes → a
 *     digest refusal; an unpinned platform → its refusal;
 *   - THE DOOR: credentials in a URL refused before anything runs; usage.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { createOwnedTemporaryDirectory } from "../../src/filesystem/private-state.ts";
import { sha256 } from "../../src/kernel/integrity.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { SECRET_TEXT_SIGNAL_CATALOG } from "../../src/privacy/secret-signals.ts";
import { parseImportHistoryArguments } from "../../src/workflow/forge/cli.ts";
import { gitleaksConfigText, gitleaksProjection } from "../../src/workflow/forge/gitleaks-config.ts";
import { addressDigest, addressSpans, allowedAddresses, base64Payloads, foldAddress, hexPayloads, insideTree, judgeAddresses, knownAddresses, knownMatches, planAddressRewrite, readIdentityMap, unescapedText, withoutAddresses, type AddressOccurrence } from "../../src/workflow/forge/history-identities.ts";
import {
  addressCensus,
  enumerateHistory,
  namesOldId,
  oldIdIndex,
  runAddressCensus,
  runHistoryScan,
  importHistory,
  judgeOracle,
  decodedTexts,
  IMPORT_REVIEW_SCHEMA,
  parseOracleReport,
  planPurge,
  planRefs,
  purgeResidue,
  readImportReview,
  receiptRefusal,
  recordedLocation,
  removedMarker,
  scanHistory,
  type CatalogueHit,
  type HistoryScan,
  type OracleRunner,
} from "../../src/workflow/forge/history-import.ts";
import { historyToolPath, historyToolPin, resolveHistoryTool, runBounded } from "../../src/workflow/forge/history-tools.ts";
import { isProcessAlive } from "../../src/process/process-facts.ts";
import { runCpuBounded } from "../../src/process/supervised-run.ts";
import { boundedEnding, type SubprocessBounds } from "../../src/process/subprocess-bounds.ts";
import { armTestKeyHome } from "../support/test-key-home.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { AT_REFERENCES, CORAL_KEY, entryOf, FIXTURE_ADDRESS, GIT, git, GITHUB_TOKEN, importOptions, MAKORA_KEY, MAPPED_ADDRESS, NON_ASCII_ADDRESS, pemLine, plantedRepository, repository, SHORT_PASSWORD, UNALLOWED_ADDRESS, write } from "./history-fixture.ts";

/** The catalogue's own row for each planted value (never a spelling the catalogue may rename). */
const GITHUB = entryOf(GITHUB_TOKEN);
const CORAL = entryOf(CORAL_KEY);
const MAKORA = entryOf(MAKORA_KEY);
const DSN = entryOf(`Pwd=${SHORT_PASSWORD};`);

test("the four planted values belong to four DISTINCT catalogue rows (a merge of two rows would let a location list match the wrong one)", () => {
  assert.equal(new Set([GITHUB, CORAL, MAKORA, DSN]).size, 4, JSON.stringify([GITHUB, CORAL, MAKORA, DSN]));
});

const POLICY = ROOT_POLICY.workflow.historyImport;
/** The harness checkout: the public tree a review or a mapping is refused inside. */
const PUBLIC_TREE = join(import.meta.dirname, "..", "..", "..");
/** An oracle that finds nothing (the catalogue's own tests). */
const NO_ORACLE: OracleRunner = async () => "[]";

/** A stand-in oracle: every line of its input holding `needle` is a finding (gitleaks' report shape, 1-based lines). */
function needleOracle(needle: string, seen: Buffer[]): OracleRunner {
  return async (input) => {
    seen.push(input);
    const report = input.toString("utf8").split("\n").flatMap((line, index) => line.includes(needle) ? [{ RuleID: "github-pat", Secret: needle, StartLine: index + 1, File: "" }] : []);
    return JSON.stringify(report);
  };
}

const ENTRIES = (hits: readonly CatalogueHit[]) => [...new Set(hits.map((hit) => `${hit.type}:${hit.entry}`))].sort();

test("enumerate + catalogue scan: every planted place is found with its entry, and no near-miss is", async () => {
  const root = plantedRepository();
  const inventory = enumerateHistory(repository(root));
  assert.deepEqual(Object.keys(inventory.refs), ["refs/heads/main", "refs/notes/commits", "refs/pull/1/head", "refs/tags/v1"]);
  const scan = (await scanHistory(repository(root), inventory, NO_ORACLE)).catalogue;
  assert.deepEqual(ENTRIES(scan.hits), [`blob:${CORAL}`, `blob:${DSN}`, `blob:${GITHUB}`, `commit:${MAKORA}`, `tag:${GITHUB}`].sort());
  assert.deepEqual(scan.nameHits, []);
  // The near-misses: nothing in src/callback.ts, and the `risk-…` line is not a token.
  const callback = inventory.paths.find((entry) => entry.path === "src/callback.ts")!.oid;
  assert.equal(scan.hits.filter((hit) => hit.oid === callback).length, 0);
  assert.ok(!scan.hits.some((hit) => hit.value.startsWith("risk")));
  // The binary blob and the note: both blobs, the binary one marked.
  const binary = scan.hits.filter((hit) => hit.binary);
  assert.deepEqual(binary.map((hit) => hit.entry), [CORAL]);
  assert.equal(scan.hits.filter((hit) => hit.entry === CORAL && !hit.binary).length, 1, "the note's blob is text");
  // The short DSN value carries its line window; the long tokens do not.
  for (const hit of scan.hits) assert.equal(hit.anchor === null, hit.value.length >= 12, `${hit.entry} anchoring`);
  const dsn = scan.hits.filter((hit) => hit.entry === DSN);
  assert.equal(dsn.length, 2, "both lines of db.txt are hits");
  assert.ok(dsn.every((hit) => hit.anchor !== null && hit.anchor.replacement.includes(removedMarker(DSN)) && !hit.anchor.replacement.includes("s3cr")));
  assert.ok(scan.scanned.bytes > 0 && scan.scanned.objects === inventory.objects.filter((object) => object.type !== "tree").length);
});

test("the oracle reads every object and name once, in chunks of whole objects, and each finding names its object", async () => {
  const root = plantedRepository();
  const inventory = enumerateHistory(repository(root));
  const scanned = inventory.objects.filter((object) => object.type !== "tree");
  for (const chunkBytes of [64, 1 << 26]) {
    const seen: Buffer[] = [];
    const scan = await scanHistory(repository(root), inventory, needleOracle(GITHUB_TOKEN, seen), chunkBytes);
    // The token is in config/app.txt's blob and in the tag message: both, and only both, are named.
    const blob = inventory.paths.find((entry) => entry.path === "config/app.txt")!.oid;
    const tag = inventory.objects.find((object) => object.type === "tag")!.oid;
    assert.deepEqual(scan.oracle.map((finding) => finding.location).sort(), [`blob ${blob}`, `tag ${tag}`].sort(), `chunkBytes ${String(chunkBytes)}`);
    // Every object and name went in exactly once, whole: its bytes, plus a newline where it lacks one.
    const names = [...new Set(inventory.paths.map((entry) => entry.path)), ...Object.keys(inventory.refs)];
    const expected = scan.catalogue.scanned.bytes + scanned.length - endingInNewline(root, scanned) + names.reduce((sum, name) => sum + Buffer.byteLength(name) + 1, 0);
    assert.equal(Buffer.concat(seen).length, expected);
    assert.equal(seen.length > 1, chunkBytes === 64, "small chunks split the input; a large chunk holds it whole");
  }
});

/** How many of `objects` already end in a newline (the chunker adds none to those). */
function endingInNewline(root: string, objects: readonly { oid: string; type: string }[]): number {
  return objects.filter((object) => git(root, "cat-file", object.type, object.oid).endsWith("\n")).length;
}

test("catalogue scan: a secret in a path or a ref name is a name hit (refused, never purged)", async () => {
  const root = createTempDir("history-import-names-");
  git(root, "init", "-q", "-b", "main");
  write(root, `keys/${GITHUB_TOKEN}.txt`, "plain\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "a file named after a token");
  git(root, "update-ref", `refs/heads/leak-${MAKORA_KEY}`, "HEAD");
  const scan = (await scanHistory(repository(root), enumerateHistory(repository(root)), NO_ORACLE)).catalogue;
  assert.deepEqual(scan.nameHits.map((hit) => `${hit.kind}:${hit.entry}`).sort(), [`path:${GITHUB}`, `ref:${MAKORA}`].sort());
});

test("purge plan: deterministic, anchored short values, longest-first values, binary blobs stripped", async () => {
  const root = plantedRepository();
  const scan = (await scanHistory(repository(root), enumerateHistory(repository(root)), NO_ORACLE)).catalogue;
  const plan = planPurge(scan.hits);
  assert.deepEqual(planPurge([...scan.hits].reverse()), plan, "the same hits in another order give the same bytes");
  const lines = plan.expressions.trimEnd().split("\n");
  assert.equal(lines.length, plan.expressionCount);
  assert.ok(lines.every((line) => line.startsWith("literal:") && line.includes("==>")));
  // The two anchored windows (one per db.txt line) come first, then the values alone, longest first.
  const anchoredCount = lines.filter((line) => line.includes(removedMarker(DSN))).length;
  assert.equal(anchoredCount, 2);
  assert.ok(lines.slice(0, 2).every((line) => line.includes("Pwd=")));
  const alone = lines.slice(2).map((line) => line.slice("literal:".length, line.lastIndexOf("==>")));
  assert.deepEqual(alone, [...alone].sort((a, b) => b.length - a.length || (a < b ? -1 : 1)));
  assert.ok(alone.includes(GITHUB_TOKEN) && alone.includes(MAKORA_KEY) && alone.includes(CORAL_KEY));
  assert.ok(!alone.includes("s3cr"), "a short value is never replaced alone");
  assert.equal(plan.strippedBlobs.length, 1);
  // A line window holding "==>" cannot be an expression.
  const bad: CatalogueHit = { entry: "dsn-credential", value: "x", oid: "a".repeat(40), type: "blob", binary: false, anchor: { literal: "Pwd=x ==> y", replacement: "Pwd=[REMOVED:dsn-credential] ==> y" } };
  assert.throws(() => planPurge([bad]), (error: Error & { code?: string }) => error.code === "history_import_purge_inexpressible" && !error.message.includes("Pwd=x"));
  assert.deepEqual(planPurge([]), { expressions: "", expressionCount: 0, strippedBlobs: [] });
});

test("oracle judgement: contained is covered, wider or unknown is a gap, a disposition excuses exactly its rule and value", () => {
  const values = [`token = ${GITHUB_TOKEN}`, pemLine("BEGIN")];
  const pem = [pemLine("BEGIN"), "MIIB".repeat(20), pemLine("END")].join("\n");
  const findings = [
    { rule: "github-pat", secret: GITHUB_TOKEN, location: "blob a" },
    { rule: "private-key", secret: pem, location: "blob k" },
    { rule: "generic-api-key", secret: "Zx81Lq0Vb7Nm3Kp2", location: "blob g" },
    { rule: "bridlewise-makora-key", secret: MAKORA_KEY, location: "commit m" },
  ];
  const judged = judgeOracle(findings, values, [{ rule: "generic-api-key", secretSha256: sha256("Zx81Lq0Vb7Nm3Kp2"), reason: "a fixture seed, not a credential" }]);
  assert.deepEqual(judged.covered, { "github-pat": 1 });
  assert.deepEqual(judged.disposed, { "generic-api-key": 1 });
  assert.deepEqual(judged.gaps.map((gap) => `${gap.rule}:${gap.kind}`), ["private-key:catalogue-gap", "bridlewise-makora-key:projection-divergence"]);
  assert.deepEqual(judged.gaps.map((gap) => gap.secretSha256), [sha256(pem), sha256(MAKORA_KEY)], "a gap carries its value's digest (what a disposition names), never the value");
  // A disposition for another rule, or another value, excuses nothing.
  const other = judgeOracle(findings.slice(2, 3), [], [{ rule: "github-pat", secretSha256: sha256("Zx81Lq0Vb7Nm3Kp2"), reason: "wrong rule" }, { rule: "generic-api-key", secretSha256: sha256("other"), reason: "wrong value" }]);
  assert.equal(other.gaps.length, 1);
  const locate = (line: number) => `line ${String(line)}`;
  assert.deepEqual(parseOracleReport("", locate), []);
  assert.deepEqual(parseOracleReport(JSON.stringify([{ RuleID: "r", Secret: "s", StartLine: 3, File: "", Extra: 1 }]), locate), [{ rule: "r", secret: "s", location: "line 3" }]);
  for (const bad of [JSON.stringify([{ RuleID: "r" }]), JSON.stringify([{ RuleID: "r", Secret: "s", StartLine: 0 }]), "not json"]) {
    assert.throws(() => parseOracleReport(bad, locate), (error: Error & { code?: string }) => error.code === "history_import_oracle_report", bad);
  }
});

test("the import review: its schema is enforced (dispositions by digest, binaries by object id, never a value)", () => {
  const dir = createTempDir("history-import-review-");
  const good = join(dir, "good.json");
  writeFileSync(good, JSON.stringify({ schema: IMPORT_REVIEW_SCHEMA, dispositions: [{ rule: "generic-api-key", secretSha256: "a".repeat(64), reason: "reviewed" }], binaries: [{ oid: "b".repeat(40), reason: "a logo" }], addresses: [{ addressSha256: "c".repeat(64), reason: "an image name, not an address" }], strips: [{ oid: "d".repeat(40), reason: "read: a UTF-16 contact list, dropped on purpose" }] }));
  const review = readImportReview(good, PUBLIC_TREE);
  assert.deepEqual([...review.addresses], ["c".repeat(64)]);
  assert.deepEqual([...review.strips], ["d".repeat(40)]);
  assert.equal(review.dispositions.length, 1);
  assert.deepEqual([...review.binaries], ["b".repeat(40)]);
  assert.equal(review.sha256, sha256(readFileSync(good)));
  for (const [name, body] of [
    ["no-reason", { schema: IMPORT_REVIEW_SCHEMA, dispositions: [{ rule: "r", secretSha256: "a".repeat(64), reason: "" }] }],
    ["a-value", { schema: IMPORT_REVIEW_SCHEMA, dispositions: [{ rule: "r", secretSha256: "a".repeat(64), reason: "x", secret: "the value" }] }],
    ["wrong-schema", { schema: "other", dispositions: [] }],
    ["binary-by-path", { schema: IMPORT_REVIEW_SCHEMA, dispositions: [], binaries: [{ oid: "assets/logo.png", reason: "x" }] }],
    ["binary-no-reason", { schema: IMPORT_REVIEW_SCHEMA, dispositions: [], binaries: [{ oid: "b".repeat(40), reason: "" }] }],
    ["an-address", { schema: IMPORT_REVIEW_SCHEMA, dispositions: [], addresses: [{ addressSha256: UNALLOWED_ADDRESS, reason: "x" }] }],
    ["strip-by-path", { schema: IMPORT_REVIEW_SCHEMA, dispositions: [], strips: [{ oid: "contacts.txt", reason: "x" }] }],
    ["strip-no-reason", { schema: IMPORT_REVIEW_SCHEMA, dispositions: [], strips: [{ oid: "d".repeat(40), reason: "" }] }],
  ] as const) {
    const path = join(dir, `${name}.json`);
    writeFileSync(path, JSON.stringify(body));
    assert.throws(() => readImportReview(path, PUBLIC_TREE), (error: Error & { code?: string }) => error.code === "history_import_review_invalid", name);
  }
  // The review names digests of secrets and addresses: it is never read from the public tree.
  assert.throws(() => readImportReview(join(PUBLIC_TREE, "engine", "bridlewise.config.json"), PUBLIC_TREE), (error: Error & { code?: string }) => error.code === "history_import_review_public");
});

test("encodings: a token is found in UTF-16LE (with and without a BOM), UTF-16BE, UTF-32 and UTF-8 with a BOM; such a blob is stripped whole; the oracle reads it decoded", async () => {
  const root = createTempDir("history-import-encodings-");
  git(root, "init", "-q", "-b", "main");
  const line = `token = ${GITHUB_TOKEN}\n`;
  const utf16be = (text: string): Buffer => Buffer.from(text, "utf16le").swap16();
  const utf32 = (text: string, order: "le" | "be"): Buffer => Buffer.concat([...text].map((char) => {
    const unit = Buffer.alloc(4);
    if (order === "le") unit.writeUInt32LE(char.codePointAt(0)!);
    else unit.writeUInt32BE(char.codePointAt(0)!);
    return unit;
  }));
  const planted: Readonly<Record<string, Buffer>> = {
    "utf16le-bom.txt": Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(line, "utf16le")]),
    "utf16le-bare.txt": Buffer.from(line, "utf16le"),
    "utf16be-bom.txt": Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be(line)]),
    "utf32le-bom.txt": Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x00]), utf32(line, "le")]),
    "utf32be-bom.txt": Buffer.concat([Buffer.from([0x00, 0x00, 0xfe, 0xff]), utf32(line, "be")]),
    "utf8-bom.txt": Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(line, "utf8")]),
  };
  for (const [path, bytes] of Object.entries(planted)) write(root, path, bytes);
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "every encoding");
  const inventory = enumerateHistory(repository(root));
  const seen: Buffer[] = [];
  const scan = await scanHistory(repository(root), inventory, needleOracle(GITHUB_TOKEN, seen));
  for (const [path] of Object.entries(planted)) {
    const oid = inventory.paths.find((entry) => entry.path === path)!.oid;
    const hits = scan.catalogue.hits.filter((hit) => hit.oid === oid);
    assert.deepEqual(hits.map((hit) => hit.entry), [GITHUB], `${path}: the token is found`);
    assert.equal(hits[0]!.binary, path !== "utf8-bom.txt", `${path}: only UTF-8 bytes are rewritten in place; any other encoding strips the blob`);
    assert.ok(scan.oracle.some((finding) => finding.location === `blob ${oid}`), `${path}: the oracle read it decoded`);
  }
  assert.deepEqual(scan.catalogue.undecodable, [], "every planted encoding decodes");
  assert.equal(planPurge(scan.catalogue.hits).strippedBlobs.length, 5);
});

test("encodings: a UTF-16 token anywhere in the blob is found — after 8 KiB of ASCII, at an even and an odd offset, little- and big-endian — and its blob is stripped", async () => {
  const root = createTempDir("history-import-utf16-anywhere-");
  git(root, "init", "-q", "-b", "main");
  const ascii = "x".repeat(8192);
  const planted: Readonly<Record<string, Buffer>> = {
    "after-8k-even.txt": Buffer.concat([Buffer.from(ascii), Buffer.from(`token = ${GITHUB_TOKEN}\n`, "utf16le")]),
    "after-8k-odd.txt": Buffer.concat([Buffer.from(`${ascii}y`), Buffer.from(`token = ${GITHUB_TOKEN}\n`, "utf16le")]),
    "after-8k-be.txt": Buffer.concat([Buffer.from(`${ascii}y`), Buffer.from(`token = ${GITHUB_TOKEN}\n`, "utf16le").swap16()]),
  };
  for (const [path, bytes] of Object.entries(planted)) write(root, path, bytes);
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "UTF-16 sections past the first 8 KiB");
  const inventory = enumerateHistory(repository(root));
  const scan = (await scanHistory(repository(root), inventory, NO_ORACLE)).catalogue;
  for (const path of Object.keys(planted)) {
    const oid = inventory.paths.find((entry) => entry.path === path)!.oid;
    const hits = scan.hits.filter((hit) => hit.oid === oid);
    assert.deepEqual(hits.map((hit) => [hit.entry, hit.value, hit.binary]), [[GITHUB, GITHUB_TOKEN, true]], path);
  }
});

test("encodings: an object nothing decodes is undecodable (listed for review), yet still matched byte for byte", async () => {
  const root = createTempDir("history-import-binary-");
  git(root, "init", "-q", "-b", "main");
  write(root, "image.png", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0xc3]), Buffer.from(` ${CORAL_KEY} `, "latin1"), Buffer.from([0xff, 0x00, 0xd8])]));
  write(root, "plain.txt", "nothing here\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "a binary");
  const inventory = enumerateHistory(repository(root));
  const image = inventory.paths.find((entry) => entry.path === "image.png")!.oid;
  const scan = (await scanHistory(repository(root), inventory, NO_ORACLE)).catalogue;
  assert.deepEqual(scan.undecodable, [image]);
  assert.deepEqual(scan.hits.filter((hit) => hit.oid === image).map((hit) => [hit.entry, hit.binary]), [[CORAL, true]]);
  assert.equal(decodedTexts(Buffer.from("plain\n")).undecodable, false);
  assert.equal(decodedTexts(Buffer.from([0x61, 0xff, 0x62])).undecodable, true, "an invalid UTF-8 byte with no NUL pattern is undecodable, never a lossy guess");
});

/** A synthetic re-scan holding exactly what `parts` names. */
function rescanOf(parts: Partial<Readonly<{ hits: readonly CatalogueHit[]; nameHits: HistoryScan["catalogue"]["nameHits"]; oracle: HistoryScan["oracle"] }>>): HistoryScan {
  return { catalogue: { hits: parts.hits ?? [], nameHits: parts.nameHits ?? [], undecodable: [], scanned: { objects: 1, bytes: 1, names: 1 } }, oracle: parts.oracle ?? [] };
}

test("re-scan to zero: a catalogue hit, a name hit or an undisposed oracle finding is residue; a disposed finding is not", () => {
  const none = { dispositions: [], binaries: new Set<string>(), addresses: new Set<string>(), strips: new Set<string>(), sha256: null };
  const hit: CatalogueHit = { entry: GITHUB, value: GITHUB_TOKEN, oid: "c".repeat(40), type: "blob", binary: false, anchor: null };
  assert.deepEqual(purgeResidue(rescanOf({}), none), { left: {}, disposed: {} });
  assert.deepEqual(purgeResidue(rescanOf({ hits: [hit, hit] }), none).left, { [GITHUB]: 2 });
  assert.deepEqual(purgeResidue(rescanOf({ nameHits: [{ entry: MAKORA, kind: "path", oid: "d".repeat(40) }] }), none).left, { [`${MAKORA} (in a name)`]: 1 });
  const finding = { rule: "generic-api-key", secret: "Zx81Lq0Vb7Nm3Kp2", location: "blob e" };
  assert.deepEqual(purgeResidue(rescanOf({ oracle: [finding] }), none).left, { "generic-api-key (oracle)": 1 });
  const reviewed = { dispositions: [{ rule: "generic-api-key", secretSha256: sha256("Zx81Lq0Vb7Nm3Kp2"), reason: "reviewed" }], binaries: new Set<string>(), addresses: new Set<string>(), strips: new Set<string>(), sha256: null };
  assert.deepEqual(purgeResidue(rescanOf({ oracle: [finding] }), reviewed), { left: {}, disposed: { "generic-api-key": 1 } });
  assert.deepEqual(purgeResidue(rescanOf({ hits: [hit], oracle: [finding] }), reviewed).left, { [GITHUB]: 1 }, "a disposition never excuses a catalogue hit");
});

test("the receipt: locations are recorded without a path, and a receipt with an absolute or home path or a catalogue hit is refused", () => {
  assert.equal(recordedLocation("/home/user/repos/coordination.git"), "local:coordination.git");
  assert.equal(recordedLocation("C:\\work\\lab\\"), "local:lab");
  assert.equal(recordedLocation("file:///srv/git/archive.git"), "local:archive.git");
  assert.equal(recordedLocation("https://github.com/LLM-4-People/bridlewise-archive.git"), "https://github.com/LLM-4-People/bridlewise-archive.git");
  const clean = { source: "local:src", target: "https://github.com/o/r.git", refMap: [{ source: "refs/heads/home/x", target: "refs/heads/home/x" }], tools: { git: "git version 2.47.3" } };
  assert.equal(receiptRefusal(clean), undefined);
  for (const [field, value] of [["source", "/home/user/src"], ["target", "~/archive.git"], ["source", "D:\\repos\\x"], ["source", "file:///x"], ["note", "copied from /home/user/x"]] as const) {
    assert.match(receiptRefusal({ ...clean, [field]: value }) ?? "", new RegExp(`\\$\\.${field} is an absolute or home path`), `${field}: ${value}`);
  }
  assert.ok((receiptRefusal({ ...clean, note: `token = ${GITHUB_TOKEN}` }) ?? "").includes(`catalogue hit (${GITHUB})`));
});

test("refs: kept namespaces keep their names, others move under the imported prefix, collisions are refused", () => {
  const oid = "b".repeat(40);
  assert.deepEqual(planRefs({ "refs/heads/main": oid, "refs/notes/commits": oid, "refs/pull/7/head": oid, "refs/stash": oid, "refs/tags/v1": oid }).map((ref) => ref.target), [
    "refs/heads/main", "refs/notes/commits", `${POLICY.importedRefPrefix}pull/7/head`, `${POLICY.importedRefPrefix}stash`, "refs/tags/v1",
  ]);
  assert.throws(() => planRefs({ [`${POLICY.importedRefPrefix}stash`]: oid, "refs/stash": oid }), (error: Error & { code?: string }) => error.code === "history_import_ref_collision");
  assert.throws(() => planRefs({ [POLICY.receipt.ref]: oid }), (error: Error & { code?: string }) => error.code === "history_import_ref_collision");
});

test("the oracle's configuration: every catalogue row projected or named, never approximated, deterministic", () => {
  const projection = gitleaksProjection();
  const named = new Set([...projection.rules.map((rule) => rule.id.replace(/^bridlewise-/u, "")), ...projection.notProjected.map((row) => row.id)]);
  assert.deepEqual([...named].sort(), SECRET_TEXT_SIGNAL_CATALOG.map((row) => row.id).sort());
  for (const row of projection.notProjected) assert.ok(/lookaround|backreference|escape|flag|delimiter/u.test(row.reason), row.reason);
  // A row with a lookaround is never approximated; one without is projected with its flags inline.
  const synthetic = [
    { id: "plain", description: "plain", admission: /\bab_[a-z]{4}\b/iu },
    { id: "look", description: "look", admission: /(?<=key=)[a-z]+/u },
  ];
  assert.deepEqual(gitleaksProjection(synthetic), { rules: [{ id: "bridlewise-plain", description: "plain", regex: "(?i)\\bab_[a-z]{4}\\b" }], notProjected: [{ id: "look", reason: "a lookaround (RE2 has none)" }] });
  const text = gitleaksConfigText();
  assert.equal(text, gitleaksConfigText());
  assert.ok(text.includes("useDefault = true") && !text.includes("[allowlist]"));
  for (const row of projection.notProjected) assert.ok(text.includes(`#   ${row.id}: `));
});

test("pinned tools: absent names the provisioning command, other bytes are refused, an unpinned platform is refused", () => {
  const home = createOwnedTemporaryDirectory(armTestKeyHome(), "import-home-");
  assert.throws(() => resolveHistoryTool(home, "gitleaks"), (error: Error & { code?: string }) => error.code === "history_tool_missing" && error.message.includes(historyToolPin("gitleaks").archiveSha256) && error.message.includes("sha256sum -c"));
  const path = historyToolPath(home, historyToolPin("git-filter-repo"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "#!/usr/bin/env python3\nprint('not the pinned script')\n");
  assert.throws(() => resolveHistoryTool(home, "git-filter-repo"), (error: Error & { code?: string }) => error.code === "history_tool_digest_mismatch");
  assert.throws(() => historyToolPin("gitleaks", "plan9-mips"), (error: Error & { code?: string }) => error.code === "history_tool_platform_unpinned");
  assert.equal(historyToolPin("git-filter-repo", "plan9-mips").platform, "any", "a script's pin serves every platform");
});

test("the door: credentials in a URL are refused before anything runs; usage is enforced", async () => {
  const home = createOwnedTemporaryDirectory(armTestKeyHome(), "import-home-");
  for (const [source, target] of [["https://user:pw@example.invalid/a.git", "/x"], ["/x", "https://token@example.invalid/b.git"]] as const) {
    await assert.rejects(importHistory({ source, target }, importOptions(home)), (error: Error & { code?: string }) => error.code === "history_import_credentials_in_url" && !error.message.includes("pw@"));
  }
  assert.deepEqual(parseImportHistoryArguments(["/src", "--to", "/dst"]), { source: "/src", target: "/dst" });
  assert.deepEqual(parseImportHistoryArguments(["/src", "--dry-run"]), { source: "/src", dryRun: true }, "a dry run needs no target");
  assert.deepEqual(parseImportHistoryArguments(["/src", "--to", "/dst", "--identity-map", "/maps/identities.mailmap"]), { source: "/src", target: "/dst", identityMap: "/maps/identities.mailmap" });
  for (const argv of [[], ["/src"], ["/src", "--to"], ["/src", "/other", "--to", "/dst"], ["/src", "--to", "/dst", "--force"], ["/src", "--to", "/dst", "--identity-map"]]) {
    assert.throws(() => parseImportHistoryArguments(argv), (error: Error & { code?: string }) => error.code === "history_import_usage", JSON.stringify(argv));
  }
});

/** Tight bounds for the runner's tests: a 400 ms CPU budget, a 600 ms stall window under a 5% CPU floor, read every 50 ms; a 2 min hang backstop. */
const TIGHT: SubprocessBounds = { cpuBudgetMs: 400, minimumCpuRate: 0.05, stallMs: 600, hangBackstopMs: 120_000, pollMs: 50, killGraceMs: 200, outputBytes: 1 << 20 };
const NODE = process.execPath;
const ENV = { PATH: process.env["PATH"] ?? "" };

/**
 * A node one-liner that burns `cpuMs` of its OWN CPU, user plus system (never a wall-clock wait), then runs
 * `after`. Both halves count: the loop's own `cpuUsage()` calls are system time, and a user-only loop
 * measured several times its intended work.
 */
function burn(cpuMs: number, after = ""): string {
  return `const used = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; }; const until = used() + ${String(cpuMs)}; while (used() < until) {} ${after}`;
}

/**
 * Every child these tests start ENDS ON ITS OWN, so a mutated bound fails its test by name instead of hanging the file:
 * a busy child burns at most `SPIN_CAP_MS` of CPU (ten budgets, then it exits); a quiet one exits after `QUIET_LIFE_MS`
 * (it only has to outlive a stall window). Neither judges anything: the run's ending and the assertions do.
 */
const SPIN_CAP_MS = 4_000;
const QUIET_LIFE_MS = 30_000;
const SPIN = burn(SPIN_CAP_MS);
const QUIET = `setTimeout(() => {}, ${String(QUIET_LIFE_MS)});`;

/** The pid a script prints first (its own), so a test can prove the whole group is gone. */
async function refusedRun(script: string, bounds: SubprocessBounds): Promise<Readonly<{ code: string | undefined }>> {
  try {
    await runBounded("probe", [NODE, "-e", script], { cwd: process.cwd(), env: ENV, bounds });
    return { code: undefined };
  } catch (error) {
    return { code: (error as { code?: string }).code };
  }
}

test("the bounded runner: CPU spent past its budget stops the group; no output and no CPU is a stall; progress is never a stall, however long; no wall clock", async () => {
  // A busy loop: CPU past the budget, stopped through the owned group (with the child it spawned).
  const pidFile = join(createTempDir("bounded-runner-"), "pids");
  const burner = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(SPIN)}], { stdio: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); ${SPIN}`;
  assert.equal((await refusedRun(burner, TIGHT)).code, "history_tool_cpu_exhausted");
  const leader = Number(readFileSync(pidFile, "utf8"));
  assert.equal(isProcessAlive(leader), false, "the tool is gone");
  // Asleep: no output and no CPU for the stall window.
  assert.equal((await refusedRun(QUIET, TIGHT)).code, "history_tool_stalled");
  // Slow but progressing: a line every 200 ms for 2.4 s — four stall windows of wall time, never a stall.
  const progressing = await runBounded("probe", [NODE, "-e", "let n = 0; const t = setInterval(() => { console.log(n); if (++n === 12) clearInterval(t); }, 200)"], { cwd: process.cwd(), env: ENV, bounds: TIGHT });
  assert.equal(progressing.stdout.trim().split("\n").length, 12);
  // Output past its bound, a failing status, and stdin reaching the tool.
  assert.equal((await refusedRun("for (let n = 0; n < 1024; n += 1) process.stdout.write('x'.repeat(65536))", { ...TIGHT, cpuBudgetMs: 60_000, outputBytes: 1 << 16 })).code, "history_tool_output_exceeded");
  assert.equal((await refusedRun("process.exit(3)", TIGHT)).code, "history_tool_failed");
  const echoed = await runBounded("probe", [NODE, "-e", "process.stdin.pipe(process.stdout)"], { cwd: process.cwd(), env: ENV, bounds: TIGHT, input: Buffer.from("through stdin") });
  assert.equal(echoed.stdout, "through stdin");
});

test("the work-bounded run: a command that exits at once is never mistaken for an unowned or unmeasurable one (the kernel reaps before Node's exit event)", async () => {
  // Reproduced: with a 1 ms watch, an instant exit raced ownedChild (taken after the reap) and the CPU read
  // (no group member left while Node had not yet seen the exit). Both now ask procfs whether it is gone.
  const endings = new Map<string, number>();
  for (let index = 0; index < 200; index += 1) {
    const run = await runCpuBounded("true", [], { cwd: process.cwd(), env: ENV, bounds: { ...TIGHT, pollMs: 1 } });
    endings.set(run.ending, (endings.get(run.ending) ?? 0) + 1);
  }
  assert.deepEqual([...endings], [["exited", 200]]);
});

/**
 * A leader that starts a grandchild INHERITING its pipes (same process group), records the
 * grandchild's pid in `pidFile`, optionally burns `leaderBurnMs` of CPU, and exits. The
 * grandchild runs `grandchild` (a node one-liner) while holding the pipes open.
 */
function leaderWithGrandchild(pidFile: string, grandchild: string, leaderBurnMs = 0): string {
  return [
    `const { spawn } = require("node:child_process");`,
    `const g = spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "inherit" });`,
    `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));`,
    `const used = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; }; const until = used() + ${String(leaderBurnMs)}; while (used() < until) {}`,
    `process.exit(0);`,
  ].join(" ");
}

test("the work-bounded run bounds the whole GROUP: a grandchild holding the pipe asleep is a stall, one burning CPU is over budget, and the leader's CPU never leaves the total when it exits", async () => {
  const dir = createTempDir("bounded-group-");
  // 1. The leader exits at once; the grandchild sleeps holding the pipe: the run lasts, then stalls, and the group dies.
  const sleeper = join(dir, "sleeper");
  const asleep = await runCpuBounded(NODE, ["-e", leaderWithGrandchild(sleeper, QUIET)], { cwd: dir, env: ENV, bounds: TIGHT });
  assert.equal(asleep.ending, "stalled");
  assert.equal(isProcessAlive(Number(readFileSync(sleeper, "utf8"))), false, "the grandchild was stopped with its group");
  // 2. The grandchild burns CPU after the leader exits: over budget, the group dies.
  const burner = join(dir, "burner");
  const burning = await runCpuBounded(NODE, ["-e", leaderWithGrandchild(burner, SPIN)], { cwd: dir, env: ENV, bounds: TIGHT });
  assert.equal(burning.ending, "cpu-exhausted");
  assert.equal(isProcessAlive(Number(readFileSync(burner, "utf8"))), false, "the burning grandchild was stopped with its group");
  // 3. The leader burns past the budget, then exits (reaped by this process) while an idle grandchild holds the pipe:
  //    its CPU stays in the total, so the run is over budget, never merely stalled.
  const spent = join(dir, "spent");
  const leaderSpent = await runCpuBounded(NODE, ["-e", leaderWithGrandchild(spent, QUIET, 700)], { cwd: dir, env: ENV, bounds: { ...TIGHT, stallMs: 5_000 } });
  assert.equal(leaderSpent.ending, "cpu-exhausted");
  assert.ok((leaderSpent.cpuMs ?? 0) > TIGHT.cpuBudgetMs, `the total kept the exited leader's work (${String(leaderSpent.cpuMs)} ms)`);
  assert.equal(isProcessAlive(Number(readFileSync(spent, "utf8"))), false);
});

test("a stopped run answers only once its GROUP is gone: a member that closes its pipes on SIGTERM and keeps running is killed before the run answers", async () => {
  const dir = createTempDir("bounded-linger-");
  const member = join(dir, "member");
  // The grandchild works in slices (so its SIGTERM handler runs), closes its stdout and stderr on SIGTERM (the run's
  // pipes close at once) and keeps working, up to its own CPU cap. Only the terminator's SIGKILL ends it.
  const lingering = `const fs = require("node:fs"); process.on("SIGTERM", () => { fs.closeSync(1); fs.closeSync(2); }); const used = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; }; const t = setInterval(() => { const until = used() + 20; while (used() < until) {} if (used() > ${String(SPIN_CAP_MS)}) clearInterval(t); }, 0);`;
  const run = await runCpuBounded(NODE, ["-e", leaderWithGrandchild(member, lingering)], { cwd: dir, env: ENV, bounds: TIGHT });
  assert.equal(run.ending, "cpu-exhausted");
  assert.equal(isProcessAlive(Number(readFileSync(member, "utf8"))), false, "the member that let go of the pipes was still running when the run answered");
});

test("the kernel backstop: a process that LEFT the group (setsid, NB-1) is still ended at its own CPU-time limit (RLIMIT_CPU, SIGXCPU); the command itself is exec'd", async () => {
  const dir = createTempDir("bounded-rlimit-");
  // The leader starts, in a session of its own (out of the group: no budget, no stop reaches it), a shell that runs a
  // burner and records how it ended, then exits. The burner burns up to SPIN_CAP_MS of CPU; at its soft limit (2 s for
  // TIGHT: ceil((400 + 2 × 50 + 200) / 1000) + 1) the kernel ends it with SIGXCPU (status 128 + 24). Without the
  // backstop it burns its cap and exits 0. (A JavaScript SIGXCPU handler never runs: the busy loop holds the event loop.)
  const escapee = join(dir, "escapee");
  const record = join(dir, "ended");
  const parent = join(dir, "parent");
  const run = await runCpuBounded(NODE, ["-e", [
    `require("node:fs").writeFileSync(${JSON.stringify(parent)}, String(process.ppid));`,
    `const g = require("node:child_process").spawn("/bin/sh", ["-c", '"$0" -e "$1"; echo $? > "$2"', process.execPath, ${JSON.stringify(SPIN)}, ${JSON.stringify(record)}], { detached: true, stdio: "ignore" });`,
    `require("node:fs").writeFileSync(${JSON.stringify(escapee)}, String(g.pid)); g.unref();`,
  ].join(" ")], { cwd: dir, env: ENV, bounds: TIGHT });
  assert.equal(run.ending, "exited");
  assert.equal(Number(readFileSync(parent, "utf8")), process.pid, "the command was exec'd: its parent is this process, no shell between");
  const pid = Number(readFileSync(escapee, "utf8"));
  // The escapee ends on its own either way (the burner's CPU cap): wait for that, never for a clock.
  while (isProcessAlive(pid)) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(readFileSync(record, "utf8").trim(), String(128 + constants.signals.SIGXCPU), "the escapee's burner was ended by the kernel's CPU-time limit (SIGXCPU), not its own cap");
});

test("the endings no budget decides, each pinned (review findings 2 and 3): SIGXCPU is `cpu-rlimit`; a poller under the CPU floor is a stall; a run past the wall backstop is hung", async () => {
  const dir = createTempDir("bounded-endings-");
  // Finding 2: a command the kernel's CPU limit ends (SIGXCPU) ends `cpu-rlimit`, worded as the kernel's limit, never `exited`.
  const xcpu = await runCpuBounded(NODE, ["-e", `process.kill(process.pid, "SIGXCPU"); ${QUIET}`], { cwd: dir, env: ENV, bounds: TIGHT });
  assert.equal(xcpu.ending, "cpu-rlimit");
  assert.match(boundedEnding(xcpu, TIGHT), /CPU-time limit of 2 s of CPU work \(RLIMIT_CPU, the kernel backstop\) and was ended by SIGXCPU/u);
  // Finding 3: a poller that wakes every 200 ms for 2 ms of work (~1% of a core) prints nothing and is NOT progressing
  // under the 5% floor: it is stalled within the window. Without the floor every tick counts and it runs its whole life.
  const poller = await runCpuBounded(NODE, ["-e", `const used = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; }; setInterval(() => { const until = used() + 2; while (used() < until) {} }, 200); setTimeout(() => process.exit(0), 10_000);`], { cwd: dir, env: ENV, bounds: { ...TIGHT, cpuBudgetMs: 60_000, stallMs: 1_500 } });
  assert.equal(poller.ending, "stalled", `a 1% poller is not working (${String(poller.cpuMs)} ms of CPU)`);
  assert.match(boundedEnding(poller, { ...TIGHT, stallMs: 1_500 }), /less than 5% of a core's CPU work for 1500 ms \(stalled\)/u);
  // The hang backstop, the one wall bound: a run that keeps printing (progress) is still stopped at it, as hung.
  const chatty = await runCpuBounded(NODE, ["-e", `setInterval(() => console.log("."), 100); setTimeout(() => process.exit(0), 10_000);`], { cwd: dir, env: ENV, bounds: { ...TIGHT, cpuBudgetMs: 60_000, hangBackstopMs: 1_000 } });
  assert.equal(chatty.ending, "hung");
  assert.match(boundedEnding(chatty, { ...TIGHT, hangBackstopMs: 1_000 }), /^HUNG: it was still running at the 1 s hang backstop \(wall\)/u);
});

test("the work-bounded run's bounds, each pinned by a test a mutation turns red (S1, S2, P1, G1)", async () => {
  const dir = createTempDir("bounded-bounds-");
  // S1: a missing, non-finite or zero bound is refused at call time, before anything runs (never a hang).
  const marker = join(dir, "ran");
  for (const name of ["cpuBudgetMs", "minimumCpuRate", "stallMs", "hangBackstopMs", "pollMs", "killGraceMs", "outputBytes"] as const) {
    for (const value of [undefined, Number.NaN, 0]) {
      const bounds = { ...TIGHT, [name]: value } as unknown as SubprocessBounds;
      await assert.rejects(runCpuBounded(NODE, ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`], { cwd: dir, env: ENV, bounds }), (error: Error & { code?: string }) => error.code === "cpu_bounds_invalid" && error.message.includes(name), `${name}=${String(value)}`);
    }
  }
  await assert.rejects(runCpuBounded(NODE, ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`], { cwd: dir, env: ENV, bounds: { ...TIGHT, pollMs: TIGHT.stallMs } }), (error: Error & { code?: string }) => error.code === "cpu_bounds_invalid" && error.message.includes("pollMs"));
  await assert.rejects(runCpuBounded(NODE, ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`], { cwd: dir, env: ENV, bounds: { ...TIGHT, minimumCpuRate: 1.5 } }), (error: Error & { code?: string }) => error.code === "cpu_bounds_invalid" && error.message.includes("minimumCpuRate"));
  assert.equal(existsSync(marker), false, "nothing was spawned under an invalid bound");
  // S2: CPU is progress: a child busy for four stall windows of CPU, printing nothing, exits; it is never stalled.
  const busy = await runCpuBounded(NODE, ["-e", burn(1_200)], { cwd: dir, env: ENV, bounds: { ...TIGHT, cpuBudgetMs: 60_000, stallMs: 300 } });
  assert.equal(busy.ending, "exited");
  // P1: a child the leader forks in a group of its OWN (so no member sample ever sees it), which burns CPU, exits and is
  //     reaped by the leader, counts — only through the leader's reaped-child time (proc(5) cutime/cstime).
  const reaped = await runCpuBounded(NODE, ["-e", `require("node:child_process").spawnSync(process.execPath, ["-e", ${JSON.stringify(burn(700))}], { stdio: "ignore", detached: true }); ${QUIET}`], { cwd: dir, env: ENV, bounds: { ...TIGHT, stallMs: 5_000 } });
  assert.equal(reaped.ending, "cpu-exhausted", "the reaped child's 700 ms passed the 400 ms budget");
  // G1: two live grandchildren each burn under the budget (900 ms of work plus node's start, under 1,500 ms);
  //     their SUM is over it (a maximum per member would never see the budget spent).
  const pids = join(dir, "split");
  const split = await runCpuBounded(NODE, ["-e", [
    `const { spawn } = require("node:child_process");`,
    `const a = spawn(process.execPath, ["-e", ${JSON.stringify(burn(900, QUIET))}], { stdio: "inherit" });`,
    `const b = spawn(process.execPath, ["-e", ${JSON.stringify(burn(900, QUIET))}], { stdio: "inherit" });`,
    `require("node:fs").writeFileSync(${JSON.stringify(pids)}, a.pid + " " + b.pid);`,
    `process.exit(0);`,
  ].join(" ")], { cwd: dir, env: ENV, bounds: { ...TIGHT, cpuBudgetMs: 1_500, stallMs: 5_000 } });
  assert.equal(split.ending, "cpu-exhausted", "two members' work, each under the 1,500 ms budget, passed it together");
  for (const pid of readFileSync(pids, "utf8").split(" ").map(Number)) assert.equal(isProcessAlive(pid), false, "both grandchildren were stopped with the group");
  // G1, a VANISHED member: the leader burns 60% of the budget and exits; only then does its grandchild burn another 60%.
  //     The grandchild learns the leader is gone from its stdin, a pipe only the leader holds, reaching end of file
  //     (Node caches `process.ppid`, so a reparenting is never seen). The leader's work must stay in the sum after it
  //     is gone: a maximum per member, or a total of live members only, sees about 60% and passes it.
  const later = join(dir, "later");
  const vanished = await runCpuBounded(NODE, ["-e", [
    `const { spawn } = require("node:child_process");`,
    burn(900),
    `const g = spawn(process.execPath, ["-e", ${JSON.stringify(`process.stdin.on("end", () => { ${burn(900, QUIET)} }); process.stdin.resume();`)}], { stdio: ["pipe", "inherit", "inherit"] });`,
    `require("node:fs").writeFileSync(${JSON.stringify(later)}, String(g.pid));`,
    `process.exit(0);`,
  ].join(" ")], { cwd: dir, env: ENV, bounds: { ...TIGHT, cpuBudgetMs: 1_500, stallMs: 5_000 } });
  assert.equal(vanished.ending, "cpu-exhausted", "the exited leader's 900 ms and its grandchild's later 900 ms passed the 1,500 ms budget together");
  assert.equal(isProcessAlive(Number(readFileSync(later, "utf8"))), false, "the grandchild was stopped with the group");
});

test("THE ADDRESS GATE, its parts: every address shape is found (plain, percent-encoded, RFC 2047; Unicode; any case), compared under the one case fold; the mapping is one validated mailmap file outside the public tree (by path segment); the rewrite is planned per exact spelling", () => {
  // The shapes the review found escaping, each found by the census's reader.
  const shapes = [
    `free text: contact ${UNALLOWED_ADDRESS} for details`,
    `    Signed-off-by: Somebody <${UNALLOWED_ADDRESS}>`,
    `Signed-off-by: ${UNALLOWED_ADDRESS}`,
    `Reviewed-by: Somebody <${UNALLOWED_ADDRESS}> (on the list)`,
    `Signed-off-by: Somebody <${UNALLOWED_ADDRESS}>\r`,
    `people/${UNALLOWED_ADDRESS}`,
    `refs/heads/${UNALLOWED_ADDRESS}/topic`,
  ];
  for (const text of shapes) assert.deepEqual(addressSpans(text).map((span) => foldAddress(span.address)), [UNALLOWED_ADDRESS], JSON.stringify(text));
  const percent = addressSpans(`see ${UNALLOWED_ADDRESS.replaceAll("@", "%40")} here`);
  assert.deepEqual(percent.map((span) => [span.form, span.address, span.spelling]), [["percent", UNALLOWED_ADDRESS, UNALLOWED_ADDRESS.replaceAll("@", "%40")]]);
  const encodedWord = `=?UTF-8?Q?${UNALLOWED_ADDRESS.replaceAll("@", "=40")}?=`;
  assert.deepEqual(addressSpans(`reported as ${encodedWord}`).map((span) => [span.form, span.address, span.spelling]), [["rfc2047", UNALLOWED_ADDRESS, encodedWord]]);
  const base64Word = `=?utf-8?B?${Buffer.from(NON_ASCII_ADDRESS, "utf8").toString("base64")}?=`;
  assert.deepEqual(addressSpans(base64Word).map((span) => span.address), [NON_ASCII_ADDRESS]);
  // Unicode: a non-ASCII address in any case is one address; a compatibility character is its letter.
  assert.deepEqual(addressSpans(`maintainer ${NON_ASCII_ADDRESS.toUpperCase()}`).map((span) => foldAddress(span.address)), [foldAddress(NON_ASCII_ADDRESS)]);
  assert.equal(foldAddress(NON_ASCII_ADDRESS.toUpperCase()), foldAddress(NON_ASCII_ADDRESS));
  assert.equal(foldAddress("\u212Aate@example.invalid"), foldAddress("kate@example.invalid"), "the Kelvin sign folds to k");
  assert.equal(foldAddress("STRASSE@EXAMPLE.INVALID"), foldAddress("straße@example.invalid"), "full case folding: ß is ss");
  assert.equal(foldAddress("ﬁnn@example.invalid"), foldAddress("FINN@example.invalid"), "a ligature (NFKC) is its letters");
  assert.equal(addressDigest(UNALLOWED_ADDRESS.toUpperCase()), addressDigest(UNALLOWED_ADDRESS), "a disposition names the folded address");

  // The judgement: allowed, disposed by digest, mapped to an allowed address, or unresolved.
  const occurrence = (address: string, oid: string, region: "identity-header" | "message" | "content" = "message", rewritable = true): AddressOccurrence =>
    ({ key: foldAddress(address), address, spelling: address, form: "plain", name: region === "identity-header" ? "Somebody" : null, place: { kind: "object", oid, type: region === "content" ? "blob" : "commit", region, encoding: "utf-8", rewritable } });
  const allowed = allowedAddresses([FIXTURE_ADDRESS, MAPPED_ADDRESS.toUpperCase()]);
  const folder = createTempDir("identity-map-");
  const mapPath = join(folder, "identities.mailmap");
  writeFileSync(mapPath, `# the one mapping\nMapped Person <${MAPPED_ADDRESS}> Somebody <${UNALLOWED_ADDRESS}>\n<${MAPPED_ADDRESS}> <${NON_ASCII_ADDRESS}>\n`);
  const map = readIdentityMap(mapPath, PUBLIC_TREE);
  const placeholder = "placeholder@example.invalid";
  const all = [occurrence(FIXTURE_ADDRESS, "a".repeat(40)), occurrence(UNALLOWED_ADDRESS, "b".repeat(40), "identity-header"), occurrence(NON_ASCII_ADDRESS.toUpperCase(), "c".repeat(40)), occurrence(placeholder, "d".repeat(40), "content"), occurrence("other.person@example.invalid", "e".repeat(40), "content")];
  const judged = judgeAddresses(all, allowed, new Set([addressDigest(placeholder)]), map);
  assert.deepEqual([...judged.disposed], [placeholder]);
  assert.deepEqual([...judged.mapped].sort(), [foldAddress(NON_ASCII_ADDRESS), UNALLOWED_ADDRESS].sort(), "the named entry maps the header, the address-only entry maps the upper-case non-ASCII spelling");
  assert.deepEqual([...judged.unresolved], ["other.person@example.invalid"]);
  assert.deepEqual(judgeAddresses(all, allowed, new Set(), undefined).unresolved.size, 4, "with no mapping and no review, every unallowed address is unresolved");
  // The rewrite: a generated mailmap line per exact header spelling, a literal per exact spelling in rewritable text, a non-rewritable blob stripped.
  const rewrite = planAddressRewrite([...judged.needing, occurrence(NON_ASCII_ADDRESS, "f".repeat(40), "content", false)], allowed, map);
  assert.equal(rewrite.mailmap, `Mapped Person <${MAPPED_ADDRESS}> <${UNALLOWED_ADDRESS}>\n`);
  assert.equal(rewrite.expressions, `literal:${NON_ASCII_ADDRESS.toUpperCase()}==>${MAPPED_ADDRESS}\n`);
  assert.deepEqual(rewrite.strippedBlobs, ["f".repeat(40)]);
  // A spelling that differs only beyond lower-casing (full case folding: ß is ss) is the same address to the mapping.
  const foldMap = join(folder, "fold.mailmap");
  writeFileSync(foldMap, `<${MAPPED_ADDRESS}> <straße@example.invalid>\n`);
  assert.deepEqual([...judgeAddresses([occurrence("STRASSE@EXAMPLE.INVALID", "9".repeat(40))], allowed, new Set(), readIdentityMap(foldMap, PUBLIC_TREE)).mapped], [foldAddress("straße@example.invalid")]);
  // A mapping to an address that is itself not allowed resolves nothing.
  const elsewhere = join(folder, "elsewhere.mailmap");
  writeFileSync(elsewhere, `<also.private@example.invalid> <${UNALLOWED_ADDRESS}>\n`);
  assert.equal(judgeAddresses([occurrence(UNALLOWED_ADDRESS, "b".repeat(40))], allowed, new Set(), readIdentityMap(elsewhere, PUBLIC_TREE)).unresolved.size, 1);

  // A malformed line is refused by its number, never its text; the public tree is judged by path SEGMENT.
  const bad = join(folder, "bad.mailmap");
  writeFileSync(bad, `Mapped <${MAPPED_ADDRESS}> <${UNALLOWED_ADDRESS}>\nnot a mailmap line ${UNALLOWED_ADDRESS}\n`);
  assert.throws(() => readIdentityMap(bad, PUBLIC_TREE), (error: Error & { code?: string }) => error.code === "history_import_identity_map_invalid" && error.message.includes("line 2") && !error.message.includes(UNALLOWED_ADDRESS));
  assert.throws(() => readIdentityMap(join(PUBLIC_TREE, "engine", "bridlewise.config.json"), PUBLIC_TREE), (error: Error & { code?: string }) => error.code === "history_import_identity_map_public");
  const tree = createTempDir("public-tree-");
  mkdirSync(join(tree, "..dir"));
  writeFileSync(join(tree, "..dir", "m.mailmap"), `<${MAPPED_ADDRESS}> <${UNALLOWED_ADDRESS}>\n`);
  assert.equal(insideTree(join(tree, "..dir", "m.mailmap"), tree), true, "a folder spelled ..dir is inside the tree");
  assert.throws(() => readIdentityMap(join(tree, "..dir", "m.mailmap"), tree), (error: Error & { code?: string }) => error.code === "history_import_identity_map_public");
  assert.equal(insideTree(mapPath, tree), false);
  // By IDENTITY, never by spelling: the tree named through a link (or another case of its name, on a
  // case-insensitive filesystem: the same inode) holds the file; a sibling whose name only starts like the
  // tree's does not; a file with a second name (a hard link) outside the tree may have one inside it.
  const alias = join(folder, "alias-of-tree");
  symlinkSync(tree, alias);
  assert.equal(insideTree(join(tree, "..dir", "m.mailmap"), alias), true, "the tree given through a link");
  assert.equal(insideTree(join(alias, "..dir", "m.mailmap"), tree), true, "the file reached through a link to the tree");
  const sibling = `${tree}-sibling`;
  mkdirSync(sibling);
  writeFileSync(join(sibling, "m.mailmap"), "\n");
  assert.equal(insideTree(join(sibling, "m.mailmap"), tree), false, "a sibling named like the tree is outside it");
  const linked = join(folder, "linked.mailmap");
  linkSync(join(tree, "..dir", "m.mailmap"), linked);
  assert.equal(insideTree(linked, tree), true, "a hard link outside the tree to a file inside it");
  assert.throws(() => readIdentityMap(linked, tree), (error: Error & { code?: string }) => error.code === "history_import_identity_map_public" && error.message.includes("hard link"));
  assert.throws(() => allowedAddresses([]), (error: Error & { code?: string }) => error.code === "history_import_identity_map_invalid");
});

test("THE ADDRESS CENSUS on a real repository: every object in every reading (UTF-8, UTF-16LE/BE, latin1), every path and every ref name; regions of a commit; a blob filter-repo cannot rewrite in place is marked so", () => {
  const root = createTempDir("identity-history-");
  git(root, "init", "-q", "-b", "main");
  write(root, "AUTHORS", `Somebody <${UNALLOWED_ADDRESS}>\n`);
  write(root, "contacts.txt", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`owner = ${NON_ASCII_ADDRESS}\r\n`, "utf16le")]));
  write(root, "be.txt", Buffer.from(`x ${UNALLOWED_ADDRESS}`, "utf16le").swap16());
  write(root, `people/${UNALLOWED_ADDRESS}`, "hello\n");
  write(root, "latin.txt", Buffer.from(`l ${NON_ASCII_ADDRESS}\n`, "latin1"));
  write(root, "mixed.bin", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0xfd]), Buffer.alloc(64, 0x7f), Buffer.from(` ${NON_ASCII_ADDRESS} `, "utf16le"), Buffer.alloc(64, 0xc3)]));
  write(root, "renee.txt", "maintainer ren\u00e9e@example.invalid\n");
  git(root, "add", ".");
  execFileSync(GIT, ["commit", "-q", "--author", `Somebody <${UNALLOWED_ADDRESS}>`, "-m", `a change\n\n    Signed-off-by: ${UNALLOWED_ADDRESS}`], { cwd: root, env: { ...process.env, GIT_COMMITTER_NAME: "Import Test", GIT_COMMITTER_EMAIL: FIXTURE_ADDRESS } });
  git(root, "branch", `${UNALLOWED_ADDRESS}/topic`);
  const inventory = enumerateHistory(repository(root));
  const census = addressCensus(repository(root), inventory, { known: [] }).occurrences;
  const head = git(root, "rev-parse", "HEAD").trim();
  const blobOf = (path: string): string => git(root, "rev-parse", `HEAD:${path}`).trim();
  const at = (oid: string): readonly AddressOccurrence[] => census.filter((occurrence) => occurrence.place.kind === "object" && occurrence.place.oid === oid);
  const regions = at(head).map((occurrence) => (occurrence.place as { region: string }).region);
  assert.ok(regions.includes("identity-header") && regions.includes("message"), "the author header and the indented bare trailer");
  assert.ok(at(head).some((occurrence) => occurrence.place.kind === "object" && occurrence.place.region === "identity-header" && occurrence.name === "Somebody"));
  assert.ok(at(blobOf("AUTHORS")).some((occurrence) => occurrence.key === UNALLOWED_ADDRESS && occurrence.place.kind === "object" && occurrence.place.rewritable));
  assert.ok(at(blobOf("contacts.txt")).some((occurrence) => occurrence.key === foldAddress(NON_ASCII_ADDRESS) && occurrence.place.kind === "object" && !occurrence.place.rewritable), "UTF-16LE, non-ASCII, not rewritable in place");
  assert.ok(at(blobOf("be.txt")).some((occurrence) => occurrence.key === UNALLOWED_ADDRESS), "UTF-16BE without a BOM");
  assert.ok(at(blobOf("latin.txt")).some((occurrence) => occurrence.key === foldAddress(NON_ASCII_ADDRESS)), "latin1");
  assert.ok(at(blobOf("mixed.bin")).some((occurrence) => occurrence.key === foldAddress(NON_ASCII_ADDRESS)), "a non-ASCII UTF-16LE run inside a binary (only the UTF-16 reading of the whole bytes sees it)");
  // A valid UTF-8 text is not also read as latin1 (which would invent `e@example.invalid` from `renée@`).
  assert.deepEqual(at(blobOf("renee.txt")).map((occurrence) => occurrence.key), ["ren\u00e9e@example.invalid"]);
  assert.ok(census.some((occurrence) => occurrence.place.kind === "path" && occurrence.key === UNALLOWED_ADDRESS), "a path");
  assert.equal(census.filter((occurrence) => occurrence.place.kind === "ref").length, 1, "a ref name, by digest");
  const refPlace = census.find((occurrence) => occurrence.place.kind === "ref")!.place as { refSha256: string };
  assert.equal(refPlace.refSha256, sha256(`refs/heads/${UNALLOWED_ADDRESS}/topic`));
  // `only` limits the census to what is new (the receipt's): those objects, their paths, those ref names.
  const onlyHead = addressCensus(repository(root), inventory, { known: [], only: { objects: new Set([head]), refs: new Set() } }).occurrences;
  assert.ok(onlyHead.length > 0 && onlyHead.every((occurrence) => occurrence.place.kind === "object" && occurrence.place.oid === head));
});

test("EVERY NAME: a path whose blob or tree another path shares is still read (rev-list prints an object under one name only), for the address census and for the secret name scan", async () => {
  const root = createTempDir("identity-names-");
  git(root, "init", "-q", "-b", "main");
  write(root, "README.md", "x\n");
  write(root, `people/${UNALLOWED_ADDRESS}.txt`, "x\n");
  write(root, `keys/${GITHUB_TOKEN}`, "x\n");
  write(root, "a/same.txt", "y\n");
  write(root, `${UNALLOWED_ADDRESS.replaceAll("@", "@dir.")}/same.txt`, "y\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "shared objects under several names");
  const inventory = enumerateHistory(repository(root));
  const blob = git(root, "rev-parse", "HEAD:README.md").trim();
  const tree = git(root, "rev-parse", "HEAD:a").trim();
  assert.deepEqual(inventory.paths.filter((entry) => entry.oid === blob).map((entry) => entry.path).sort(), ["README.md", `keys/${GITHUB_TOKEN}`, `people/${UNALLOWED_ADDRESS}.txt`].sort(), "every name of the shared blob");
  assert.equal(inventory.paths.filter((entry) => entry.oid === tree).length, 2, "both names of the shared tree");
  const census = addressCensus(repository(root), inventory, { known: [] }).occurrences.filter((occurrence) => occurrence.place.kind === "path");
  assert.ok(census.some((occurrence) => occurrence.place.kind === "path" && occurrence.place.oid === blob), "the address in a file name beside a shared blob");
  assert.ok(census.some((occurrence) => occurrence.place.kind === "path" && occurrence.place.oid === tree), "the address in a folder name beside a shared tree");
  const scan = (await scanHistory(repository(root), inventory, NO_ORACLE)).catalogue;
  assert.deepEqual(scan.nameHits.map((hit) => `${hit.kind}:${hit.entry}`), [`path:${GITHUB}`], "the token in a file name beside a shared blob");
});

test("A KNOWN ADDRESS in any spelling: every encoding, escape and obfuscation of a mapped-from address is found as that value; another address is not", () => {
  const known = knownAddresses([UNALLOWED_ADDRESS]);
  const [local, domain] = UNALLOWED_ADDRESS.split("@") as [string, string];
  const found = (text: string): boolean => [text, unescapedText(text), ...[...base64Payloads(text), ...hexPayloads(text)].flatMap((payload) => [payload.toString("utf8"), unescapedText(payload.toString("utf8"))])]
    .some((reading) => knownMatches(reading, known).length > 0);
  const base64 = (prefix: string): string => Buffer.from(`${prefix}write to ${UNALLOWED_ADDRESS} please`).toString("base64");
  for (const [name, text] of [
    ["an HTML entity", `${local}${AT_REFERENCES.decimal}${domain}`],
    ["a hex entity", `${local}${AT_REFERENCES.hex}${domain}`],
    ["a named entity", `${local}${AT_REFERENCES.named}${domain}`],
    ["quoted-printable", `${local}=40${domain}`],
    ["a quoted-printable soft break before @", `${local}=\n@${domain}`],
    ["a quoted-printable soft break inside the local part", `${local.slice(0, 4)}=\r\n${local.slice(4)}@${domain}`],
    ["percent", `${local}%40${domain}`],
    ["a backslash escape", `${local}\\u0040${domain}`],
    ["base64 at alignment 0", base64("")],
    ["base64 at alignment 1", base64("x")],
    ["base64 at alignment 2", base64("xy")],
    ["base64 wrapped over lines", base64("").replace(/(.{8})/gu, "$1\n")],
    ["fullwidth @ (NFKC)", `${local}\uff20${domain}`],
    ["fullwidth letters (NFKC)", `${local.toUpperCase()}@${domain}`.replace(/[A-Z]/gu, (letter) => String.fromCharCode(letter.charCodeAt(0) + 0xfee0))],
    ["a zero-width space inside it", `${local.slice(0, 3)}\u200b${local.slice(3)}@${domain}`],
    ["a folded line after @", `${local}@\n ${domain}`],
    ["[at] and [dot]", `${local} [at] ${domain.replaceAll(".", " [dot] ")}`],
    ["at and dot words", `${local} at ${domain.replaceAll(".", " dot ")}`],
    ["underscores for dots", `${local.replaceAll(".", "_")}@${domain.replaceAll(".", "_")}`],
    ["a quoted local part", `"${local}"@${domain}`],
    ["upper case", UNALLOWED_ADDRESS.toUpperCase()],
    // The third review's forms (K1, K4, K10, K11, K13, K14, K15, K19, K20): a skeleton search reads them all.
    ["mixed case, a soft hyphen reference and an @ reference (K1)", `SomeOne.Pri${AT_REFERENCES.softHyphen}vate${AT_REFERENCES.decimal}Example.INVALID`],
    ["a reference without its semicolon (K4)", `${local}${AT_REFERENCES.decimal.slice(0, -1)}${domain}`],
    ["a double percent encoding (K10)", `${local}%2540${domain}`],
    ["hex of the address (K11)", Buffer.from(UNALLOWED_ADDRESS).toString("hex")],
    ["letter-spaced (K13)", [...UNALLOWED_ADDRESS].join(" ")],
    ["base64 of the reference form (K14)", Buffer.from(`${local}${AT_REFERENCES.decimal}${domain}`).toString("base64")],
    ["ideographic full stops (K15)", `${local.replaceAll(".", "\u3002")}@${domain.replaceAll(".", "\u3002")}`],
    ["an octal escape (K19)", `${local}\\100${domain}`],
    ["a CSS escape (K20)", `${local}\\40 ${domain}`],
  ] as const) assert.ok(found(text), name);
  assert.ok(!found(`${local}ly@${domain}`), "a longer local part is another address");
  assert.ok(!found(`${local}@other.invalid`), "another domain");
  assert.ok(!found(`${local} wrote about ${domain}`), "the parts in prose, with other words between them");
  // A refusal or a quoted tool message withholds every address-shaped string.
  assert.equal(withoutAddresses(`bad line: Somebody <${UNALLOWED_ADDRESS}> and ${UNALLOWED_ADDRESS.replaceAll("@", "%40")}`), "bad line: Somebody <[address]> and [address]");
});

test("THE SHAPE IS BOUNDED: a long run of address characters, of percent signs, or of `@`s costs its length, not its square (CPU work, never wall time)", () => {
  const known = knownAddresses([UNALLOWED_ADDRESS]);
  for (const [name, text] of [
    ["letters", "a".repeat(200_000)],
    ["percent signs", "%".repeat(200_000)],
    ["local parts and @", "ab.c+".repeat(40_000).replace(/\+/gu, "@")],
    ["percent-encoded @", "a%40".repeat(50_000)],
    ["labels", `a@${"b.".repeat(100_000)}`],
  ] as const) {
    const before = process.cpuUsage();
    addressSpans(text);
    knownMatches(text, known);
    base64Payloads(text);
    const spent = process.cpuUsage(before);
    assert.ok((spent.user + spent.system) / 1000 < 3_000, `${name}: ${String((spent.user + spent.system) / 1000)} ms of CPU for 200,000 characters`);
  }
});

test("THE ADDRESS CENSUS RUNS BOUNDED, in a child under the one bounded run; known addresses: a spelling the shape census reads is not a variant, any other spelling and any name is", async () => {
  const root = createTempDir("identity-known-");
  git(root, "init", "-q", "-b", "main");
  write(root, "plain.txt", `mail ${UNALLOWED_ADDRESS.toUpperCase()}\n`);
  write(root, "entity.html", `mail ${UNALLOWED_ADDRESS.replaceAll("@", AT_REFERENCES.decimal)}\n`);
  write(root, "both.txt", `mail ${UNALLOWED_ADDRESS} or ${UNALLOWED_ADDRESS.replaceAll("@", "\uff20")}\n`);
  write(root, `people/${UNALLOWED_ADDRESS.replaceAll("@", "%40")}`, "z\n");
  git(root, "add", ".");
  execFileSync(GIT, ["commit", "-q", "--author", `Somebody <${UNALLOWED_ADDRESS}>`, "-m", "a change"], { cwd: root, env: { ...process.env, GIT_COMMITTER_NAME: "Import Test", GIT_COMMITTER_EMAIL: FIXTURE_ADDRESS } });
  const inventory = enumerateHistory(repository(root));
  const inProcess = addressCensus(repository(root), inventory, { known: knownAddresses([UNALLOWED_ADDRESS]) });
  const bounded = await runAddressCensus(repository(root), { known: [UNALLOWED_ADDRESS] });
  assert.deepEqual(bounded, JSON.parse(JSON.stringify(inProcess)), "the child answers exactly the in-process census");
  const variant = (oid: string): boolean | undefined => bounded.known.find((one) => one.place.kind !== "ref" && one.place.oid === oid)?.variant;
  const blobOf = (path: string): string => git(root, "rev-parse", `HEAD:${path}`).trim();
  assert.equal(variant(blobOf("plain.txt")), false, "a plain spelling (any case) the shape census reads and the rewrite replaces");
  assert.equal(variant(git(root, "rev-parse", "HEAD").trim()), false, "the author header the mailmap rewrites");
  assert.equal(variant(blobOf("entity.html")), true, "an entity no rewrite replaces");
  assert.equal(variant(blobOf(`people/${UNALLOWED_ADDRESS.replaceAll("@", "%40")}`)), true, "a name (percent-encoded), which no rewrite reaches");
  assert.equal(variant(blobOf("both.txt")), true, "a fullwidth spelling beside a plain one: more matches than the shape read");
  // It is a CHILD under the one bounded run: a CPU budget smaller than its work stops it, typed.
  const tiny: SubprocessBounds = { cpuBudgetMs: 30, minimumCpuRate: 0.05, stallMs: 600_000, hangBackstopMs: 600_000, pollMs: 10, killGraceMs: 500, outputBytes: 1 << 20 };
  await assert.rejects(runAddressCensus(repository(root), { known: [UNALLOWED_ADDRESS] }, tiny), (error: Error & { code?: string }) => error.code === "history_tool_cpu_exhausted" && error.message.includes("the address census"));
  // So is the catalogue scan (quadratic on address-dense text in the redaction engine: never in the importer's own process).
  await assert.rejects(runHistoryScan(repository(root), createTempDir("history-scan-home-"), createTempDir("history-scan-run-"), tiny), (error: Error & { code?: string }) => error.code === "history_tool_cpu_exhausted" && error.message.includes("the catalogue scan"));
});

test("a failed tool's quoted stderr withholds every address (filter-repo quotes a mailmap line it cannot parse)", async () => {
  await assert.rejects(runBounded("a tool", ["/bin/sh", "-c", `echo "cannot parse: Somebody <${UNALLOWED_ADDRESS}>" >&2; exit 3`], { cwd: createTempDir("history-tool-stderr-"), env: { PATH: process.env["PATH"] ?? "" } }),
    (error: Error & { code?: string }) => error.code === "history_tool_failed" && error.message.includes("cannot parse: Somebody <[address]>") && !error.message.includes(UNALLOWED_ADDRESS));
});

test("THE ORACLE CLASS: every place naming an old object id, whole or abbreviated to 7 or more characters, is found (a notes tree fans the id out over folders; a list of ids in a file); another id, or a shorter abbreviation, is not", () => {
  const old = "3d5aadf5e5b8c0a1f2e3d4c5b6a7980112233445";
  const index = oldIdIndex([old.toUpperCase()]);
  for (const [name, text] of [
    ["the whole id", `see ${old}.`],
    ["an abbreviation of 7", `fixup ${old.slice(0, 7)} done`],
    ["an abbreviation of 12, upper case", `(${old.slice(0, 12).toUpperCase()})`],
    ["inside a longer hex run", `0000${old}ffff`],
  ] as const) assert.equal(namesOldId(text, index), true, name);
  for (const [name, text] of [["6 characters", old.slice(0, 6)], ["another id", "3d5aadf0000000"], ["a run that only starts like it", `${old.slice(0, 9)}0`]] as const) assert.equal(namesOldId(text, index), false, name);

  const root = createTempDir("identity-old-ids-");
  git(root, "init", "-q", "-b", "main");
  write(root, "README.md", "x\n");
  write(root, ".git-blame-ignore-revs", `${old}\n`);
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "lists an id");
  // A notes tree with fan-out names the annotated commit over two folders.
  const blob = git(root, "rev-parse", "HEAD:README.md").trim();
  const fanned = execFileSync(GIT, ["mktree"], { cwd: root, input: `100644 blob ${blob}\t${old.slice(2)}\n` }).toString().trim();
  const notes = execFileSync(GIT, ["mktree"], { cwd: root, input: `040000 tree ${fanned}\t${old.slice(0, 2)}\n` }).toString().trim();
  git(root, "update-ref", "refs/notes/commits", execFileSync(GIT, ["commit-tree", notes, "-m", "notes"], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "N", GIT_AUTHOR_EMAIL: FIXTURE_ADDRESS, GIT_COMMITTER_NAME: "N", GIT_COMMITTER_EMAIL: FIXTURE_ADDRESS } }).toString().trim());
  const census = addressCensus(repository(root), enumerateHistory(repository(root)), { known: [], oldIds: index });
  assert.ok(census.oldIds.some((place) => place.kind === "object" && place.oid === git(root, "rev-parse", "HEAD:.git-blame-ignore-revs").trim()), "a file listing the id");
  assert.ok(census.oldIds.some((place) => place.kind === "path" && place.oid === blob), "the notes tree's fanned-out path");
  assert.equal(addressCensus(repository(root), enumerateHistory(repository(root)), { known: [] }).oldIds.length, 0, "no old id is searched for without the rewrite's list");
});

test("THE BOUNDS CLASS: the trees' paths are read with a declared count and depth bound, a typed refusal past either (a tree bomb never exhausts memory)", () => {
  const root = createTempDir("identity-tree-bomb-");
  git(root, "init", "-q", "-b", "main");
  write(root, "a/b/c/d/leaf.txt", "x\n");
  write(root, "w1.txt", "1\n");
  write(root, "w2.txt", "2\n");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "deep and wide");
  assert.ok(enumerateHistory(repository(root), { paths: 100, depth: 10 }).paths.length >= 7);
  assert.throws(() => enumerateHistory(repository(root), { paths: 100, depth: 3 }), (error: Error & { code?: string }) => error.code === "history_import_tree_bound" && error.message.includes("deeper"));
  assert.throws(() => enumerateHistory(repository(root), { paths: 4, depth: 10 }), (error: Error & { code?: string }) => error.code === "history_import_tree_bound" && error.message.includes("pairs"));
  // A real bomb: each level holds the one below eight times; 8^7 paths are never materialised.
  let tree = execFileSync(GIT, ["mktree"], { cwd: root, input: `100644 blob ${git(root, "rev-parse", "HEAD:w1.txt").trim()}\tf\n` }).toString().trim();
  for (let level = 0; level < 7; level += 1) tree = execFileSync(GIT, ["mktree"], { cwd: root, input: Array.from({ length: 8 }, (_, index) => `040000 tree ${tree}\td${String(index)}\n`).join("") }).toString().trim();
  git(root, "update-ref", "refs/heads/bomb", execFileSync(GIT, ["commit-tree", tree, "-m", "bomb"], { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "N", GIT_AUTHOR_EMAIL: FIXTURE_ADDRESS, GIT_COMMITTER_NAME: "N", GIT_COMMITTER_EMAIL: FIXTURE_ADDRESS } }).toString().trim());
  const before = process.memoryUsage().rss;
  assert.throws(() => enumerateHistory(repository(root), { paths: 10_000, depth: 128 }), (error: Error & { code?: string }) => error.code === "history_import_tree_bound");
  assert.ok(process.memoryUsage().rss - before < 256 * 1024 * 1024, "the refusal comes before the paths fill memory");
});
