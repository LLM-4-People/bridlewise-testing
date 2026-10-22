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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { createOwnedTemporaryDirectory } from "../../src/filesystem/private-state.ts";
import { sha256 } from "../../src/kernel/integrity.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { SECRET_TEXT_SIGNAL_CATALOG } from "../../src/privacy/secret-signals.ts";
import { parseImportHistoryArguments } from "../../src/workflow/forge/cli.ts";
import { gitleaksConfigText, gitleaksProjection } from "../../src/workflow/forge/gitleaks-config.ts";
import {
  enumerateHistory,
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
import { runCpuBounded, type CpuBounds } from "../../src/process/supervised-run.ts";
import { armTestKeyHome } from "../support/test-key-home.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { CORAL_KEY, GIT, git, GITHUB_TOKEN, MAKORA_KEY, pemLine, plantedRepository, repository, write } from "./history-fixture.ts";

const POLICY = ROOT_POLICY.workflow.historyImport;
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
  assert.deepEqual(ENTRIES(scan.hits), ["blob:coralbricks-key", "blob:dsn-credential", "blob:token-prefix", "commit:makora-key", "tag:token-prefix"]);
  assert.deepEqual(scan.nameHits, []);
  // The near-misses: nothing in src/callback.ts, and the `risk-…` line is not a token.
  const callback = inventory.paths.find((entry) => entry.path === "src/callback.ts")!.oid;
  assert.equal(scan.hits.filter((hit) => hit.oid === callback).length, 0);
  assert.ok(!scan.hits.some((hit) => hit.value.startsWith("risk")));
  // The binary blob and the note: both blobs, the binary one marked.
  const binary = scan.hits.filter((hit) => hit.binary);
  assert.deepEqual(binary.map((hit) => hit.entry), ["coralbricks-key"]);
  assert.equal(scan.hits.filter((hit) => hit.entry === "coralbricks-key" && !hit.binary).length, 1, "the note's blob is text");
  // The short DSN value carries its line window; the long tokens do not.
  for (const hit of scan.hits) assert.equal(hit.anchor === null, hit.value.length >= 12, `${hit.entry} anchoring`);
  const dsn = scan.hits.filter((hit) => hit.entry === "dsn-credential");
  assert.equal(dsn.length, 2, "both lines of db.txt are hits");
  assert.ok(dsn.every((hit) => hit.anchor !== null && hit.anchor.replacement.includes(removedMarker("dsn-credential")) && !hit.anchor.replacement.includes("s3cr")));
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
    const names = [...inventory.paths.map((entry) => entry.path), ...Object.keys(inventory.refs)];
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
  assert.deepEqual(scan.nameHits.map((hit) => `${hit.kind}:${hit.entry}`).sort(), ["path:token-prefix", "ref:makora-key"]);
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
  const anchoredCount = lines.filter((line) => line.includes(removedMarker("dsn-credential"))).length;
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
  writeFileSync(good, JSON.stringify({ schema: IMPORT_REVIEW_SCHEMA, dispositions: [{ rule: "generic-api-key", secretSha256: "a".repeat(64), reason: "reviewed" }], binaries: [{ oid: "b".repeat(40), reason: "a logo" }] }));
  const review = readImportReview(good);
  assert.equal(review.dispositions.length, 1);
  assert.deepEqual([...review.binaries], ["b".repeat(40)]);
  assert.equal(review.sha256, sha256(readFileSync(good)));
  for (const [name, body] of [
    ["no-reason", { schema: IMPORT_REVIEW_SCHEMA, dispositions: [{ rule: "r", secretSha256: "a".repeat(64), reason: "" }] }],
    ["a-value", { schema: IMPORT_REVIEW_SCHEMA, dispositions: [{ rule: "r", secretSha256: "a".repeat(64), reason: "x", secret: "the value" }] }],
    ["wrong-schema", { schema: "other", dispositions: [] }],
    ["binary-by-path", { schema: IMPORT_REVIEW_SCHEMA, dispositions: [], binaries: [{ oid: "assets/logo.png", reason: "x" }] }],
    ["binary-no-reason", { schema: IMPORT_REVIEW_SCHEMA, dispositions: [], binaries: [{ oid: "b".repeat(40), reason: "" }] }],
  ] as const) {
    const path = join(dir, `${name}.json`);
    writeFileSync(path, JSON.stringify(body));
    assert.throws(() => readImportReview(path), (error: Error & { code?: string }) => error.code === "history_import_review_invalid", name);
  }
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
    assert.deepEqual(hits.map((hit) => hit.entry), ["token-prefix"], `${path}: the token is found`);
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
    assert.deepEqual(hits.map((hit) => [hit.entry, hit.value, hit.binary]), [["token-prefix", GITHUB_TOKEN, true]], path);
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
  assert.deepEqual(scan.hits.filter((hit) => hit.oid === image).map((hit) => [hit.entry, hit.binary]), [["coralbricks-key", true]]);
  assert.equal(decodedTexts(Buffer.from("plain\n")).undecodable, false);
  assert.equal(decodedTexts(Buffer.from([0x61, 0xff, 0x62])).undecodable, true, "an invalid UTF-8 byte with no NUL pattern is undecodable, never a lossy guess");
});

/** A synthetic re-scan holding exactly what `parts` names. */
function rescanOf(parts: Partial<Readonly<{ hits: readonly CatalogueHit[]; nameHits: HistoryScan["catalogue"]["nameHits"]; oracle: HistoryScan["oracle"] }>>): HistoryScan {
  return { catalogue: { hits: parts.hits ?? [], nameHits: parts.nameHits ?? [], undecodable: [], scanned: { objects: 1, bytes: 1, names: 1 } }, oracle: parts.oracle ?? [] };
}

test("re-scan to zero: a catalogue hit, a name hit or an undisposed oracle finding is residue; a disposed finding is not", () => {
  const none = { dispositions: [], binaries: new Set<string>(), sha256: null };
  const hit: CatalogueHit = { entry: "token-prefix", value: GITHUB_TOKEN, oid: "c".repeat(40), type: "blob", binary: false, anchor: null };
  assert.deepEqual(purgeResidue(rescanOf({}), none), { left: {}, disposed: {} });
  assert.deepEqual(purgeResidue(rescanOf({ hits: [hit, hit] }), none).left, { "token-prefix": 2 });
  assert.deepEqual(purgeResidue(rescanOf({ nameHits: [{ entry: "makora-key", kind: "path", oid: "d".repeat(40) }] }), none).left, { "makora-key (in a name)": 1 });
  const finding = { rule: "generic-api-key", secret: "Zx81Lq0Vb7Nm3Kp2", location: "blob e" };
  assert.deepEqual(purgeResidue(rescanOf({ oracle: [finding] }), none).left, { "generic-api-key (oracle)": 1 });
  const reviewed = { dispositions: [{ rule: "generic-api-key", secretSha256: sha256("Zx81Lq0Vb7Nm3Kp2"), reason: "reviewed" }], binaries: new Set<string>(), sha256: null };
  assert.deepEqual(purgeResidue(rescanOf({ oracle: [finding] }), reviewed), { left: {}, disposed: { "generic-api-key": 1 } });
  assert.deepEqual(purgeResidue(rescanOf({ hits: [hit], oracle: [finding] }), reviewed).left, { "token-prefix": 1 }, "a disposition never excuses a catalogue hit");
});

test("the receipt: locations are recorded without a path, and a receipt with an absolute or home path or a catalogue hit is refused", () => {
  assert.equal(recordedLocation("/home/someone/repos/coordination.git"), "local:coordination.git");
  assert.equal(recordedLocation("C:\\work\\lab\\"), "local:lab");
  assert.equal(recordedLocation("file:///srv/git/archive.git"), "local:archive.git");
  assert.equal(recordedLocation("https://github.com/LLM-4-People/bridlewise-archive.git"), "https://github.com/LLM-4-People/bridlewise-archive.git");
  const clean = { source: "local:src", target: "https://github.com/o/r.git", refMap: [{ source: "refs/heads/home/x", target: "refs/heads/home/x" }], tools: { git: "git version 2.47.3" } };
  assert.equal(receiptRefusal(clean), undefined);
  for (const [field, value] of [["source", "/home/someone/src"], ["target", "~/archive.git"], ["source", "D:\\repos\\x"], ["source", "file:///x"], ["note", "copied from /home/someone/x"]] as const) {
    assert.match(receiptRefusal({ ...clean, [field]: value }) ?? "", new RegExp(`\\$\\.${field} is an absolute or home path`), `${field}: ${value}`);
  }
  assert.match(receiptRefusal({ ...clean, note: `token = ${GITHUB_TOKEN}` }) ?? "", /catalogue hit \(token-prefix\)/u);
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
    await assert.rejects(importHistory({ source, target }, { home, git: GIT }), (error: Error & { code?: string }) => error.code === "history_import_credentials_in_url" && !error.message.includes("pw@"));
  }
  assert.deepEqual(parseImportHistoryArguments(["/src", "--to", "/dst"]), { source: "/src", target: "/dst" });
  for (const argv of [[], ["/src"], ["/src", "--to"], ["/src", "/other", "--to", "/dst"], ["/src", "--to", "/dst", "--force"]]) {
    assert.throws(() => parseImportHistoryArguments(argv), (error: Error & { code?: string }) => error.code === "history_import_usage", JSON.stringify(argv));
  }
});

/** Tight bounds for the runner's tests: a 400 ms CPU budget, a 600 ms stall window, read every 50 ms. */
const TIGHT: CpuBounds = { cpuBudgetMs: 400, stallMs: 600, pollMs: 50, killGraceMs: 200, outputBytes: 1 << 20 };
const NODE = process.execPath;
const ENV = { PATH: process.env["PATH"] ?? "" };

/** The pid a script prints first (its own), so a test can prove the whole group is gone. */
async function refusedRun(script: string, bounds: CpuBounds): Promise<Readonly<{ code: string | undefined }>> {
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
  const burner = `require("node:child_process").spawn(process.execPath, ["-e", "for(;;){}"], { stdio: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); for(;;){}`;
  assert.equal((await refusedRun(burner, TIGHT)).code, "history_tool_cpu_exhausted");
  const leader = Number(readFileSync(pidFile, "utf8"));
  assert.equal(isProcessAlive(leader), false, "the tool is gone");
  // Asleep: no output and no CPU for the stall window.
  assert.equal((await refusedRun("setTimeout(() => {}, 60000)", TIGHT)).code, "history_tool_stalled");
  // Slow but progressing: a line every 200 ms for 2.4 s — four stall windows of wall time, never a stall.
  const progressing = await runBounded("probe", [NODE, "-e", "let n = 0; const t = setInterval(() => { console.log(n); if (++n === 12) clearInterval(t); }, 200)"], { cwd: process.cwd(), env: ENV, bounds: TIGHT });
  assert.equal(progressing.stdout.trim().split("\n").length, 12);
  // Output past its bound, a failing status, and stdin reaching the tool.
  assert.equal((await refusedRun("for(;;) process.stdout.write('x'.repeat(65536))", { ...TIGHT, cpuBudgetMs: 60_000, outputBytes: 1 << 16 })).code, "history_tool_output_exceeded");
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
  const asleep = await runCpuBounded(NODE, ["-e", leaderWithGrandchild(sleeper, "setTimeout(() => {}, 120000)")], { cwd: dir, env: ENV, bounds: TIGHT });
  assert.equal(asleep.ending, "stalled");
  assert.equal(isProcessAlive(Number(readFileSync(sleeper, "utf8"))), false, "the grandchild was stopped with its group");
  // 2. The grandchild burns CPU after the leader exits: over budget, the group dies.
  const burner = join(dir, "burner");
  const burning = await runCpuBounded(NODE, ["-e", leaderWithGrandchild(burner, "for(;;){}")], { cwd: dir, env: ENV, bounds: TIGHT });
  assert.equal(burning.ending, "cpu-exhausted");
  assert.equal(isProcessAlive(Number(readFileSync(burner, "utf8"))), false, "the burning grandchild was stopped with its group");
  // 3. The leader burns past the budget, then exits (reaped by this process) while an idle grandchild holds the pipe:
  //    its CPU stays in the total, so the run is over budget, never merely stalled.
  const spent = join(dir, "spent");
  const leaderSpent = await runCpuBounded(NODE, ["-e", leaderWithGrandchild(spent, "setTimeout(() => {}, 120000)", 700)], { cwd: dir, env: ENV, bounds: { ...TIGHT, stallMs: 5_000 } });
  assert.equal(leaderSpent.ending, "cpu-exhausted");
  assert.ok((leaderSpent.cpuMs ?? 0) > TIGHT.cpuBudgetMs, `the total kept the exited leader's work (${String(leaderSpent.cpuMs)} ms)`);
  assert.equal(isProcessAlive(Number(readFileSync(spent, "utf8"))), false);
});

/**
 * A node one-liner that burns `cpuMs` of its OWN CPU, user plus system (never a wall-clock wait), then runs
 * `after`. Both halves count: the loop's own `cpuUsage()` calls are system time, and a user-only loop
 * measured several times its intended work.
 */
function burn(cpuMs: number, after = ""): string {
  return `const used = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; }; const until = used() + ${String(cpuMs)}; while (used() < until) {} ${after}`;
}

test("the work-bounded run's bounds, each pinned by a test a mutation turns red (S1, S2, P1, G1)", async () => {
  const dir = createTempDir("bounded-bounds-");
  // S1: a missing, non-finite or zero bound is refused at call time, before anything runs (never a hang).
  const marker = join(dir, "ran");
  for (const name of ["cpuBudgetMs", "stallMs", "pollMs", "killGraceMs", "outputBytes"] as const) {
    for (const value of [undefined, Number.NaN, 0]) {
      const bounds = { ...TIGHT, [name]: value } as unknown as CpuBounds;
      await assert.rejects(runCpuBounded(NODE, ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`], { cwd: dir, env: ENV, bounds }), (error: Error & { code?: string }) => error.code === "cpu_bounds_invalid" && error.message.includes(name), `${name}=${String(value)}`);
    }
  }
  assert.equal(existsSync(marker), false, "nothing was spawned under an invalid bound");
  // S2: CPU is progress: a child busy for four stall windows of CPU, printing nothing, exits; it is never stalled.
  const busy = await runCpuBounded(NODE, ["-e", burn(1_200)], { cwd: dir, env: ENV, bounds: { ...TIGHT, cpuBudgetMs: 60_000, stallMs: 300 } });
  assert.equal(busy.ending, "exited");
  // P1: a child the leader forks in a group of its OWN (so no member sample ever sees it), which burns CPU, exits and is
  //     reaped by the leader, counts — only through the leader's reaped-child time (proc(5) cutime/cstime).
  const reaped = await runCpuBounded(NODE, ["-e", `require("node:child_process").spawnSync(process.execPath, ["-e", ${JSON.stringify(burn(700))}], { stdio: "ignore", detached: true }); setTimeout(() => {}, 120000);`], { cwd: dir, env: ENV, bounds: { ...TIGHT, stallMs: 5_000 } });
  assert.equal(reaped.ending, "cpu-exhausted", "the reaped child's 700 ms passed the 400 ms budget");
  // G1: two live grandchildren each burn under the budget (900 ms of work plus node's start, under 1,500 ms);
  //     their SUM is over it (a maximum per member would never see the budget spent).
  const pids = join(dir, "split");
  const split = await runCpuBounded(NODE, ["-e", [
    `const { spawn } = require("node:child_process");`,
    `const a = spawn(process.execPath, ["-e", ${JSON.stringify(burn(900, "setTimeout(() => {}, 120000);"))}], { stdio: "inherit" });`,
    `const b = spawn(process.execPath, ["-e", ${JSON.stringify(burn(900, "setTimeout(() => {}, 120000);"))}], { stdio: "inherit" });`,
    `require("node:fs").writeFileSync(${JSON.stringify(pids)}, a.pid + " " + b.pid);`,
    `process.exit(0);`,
  ].join(" ")], { cwd: dir, env: ENV, bounds: { ...TIGHT, cpuBudgetMs: 1_500, stallMs: 5_000 } });
  assert.equal(split.ending, "cpu-exhausted", "two members' work, each under the 1,500 ms budget, passed it together");
  for (const pid of readFileSync(pids, "utf8").split(" ").map(Number)) assert.equal(isProcessAlive(pid), false, "both grandchildren were stopped with the group");
});
