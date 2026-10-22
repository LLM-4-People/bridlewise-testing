/**
 * THE HISTORY IMPORTER — `harness forge import-history <source> --to <target>`,
 * the ONE path by which a history enters the forge (github-only §8.3, runbook
 * P6.1): the coordination repository, each lab, the Gitea archive, any private
 * branch. Nothing is pushed until the history has been scanned, purged and
 * re-scanned to zero:
 *
 * 1. MIRROR the source into a run folder of the private import home (never a
 *    checkout, never the system temp folder: it will hold secret values).
 * 2. ENUMERATE every object reachable from every ref (`rev-list --objects
 *    --all`: branches, tags, notes, `refs/pull/*`, a stash) and every name
 *    (each path and each ref name).
 * 3. SCAN every blob, commit and tag object, read ONCE and decoded into
 *    every text it holds before any matching (`decodedTexts`: a BOM's
 *    encoding, else strict UTF-8, plus UTF-16 by the NULs' shape; an object
 *    nothing decodes is matched byte for byte and refused unless the review
 *    exempts it by id), with the secret CATALOGUE (the redaction engine's
 *    format layer, `detectSensitiveSpans`, admission profile: the same rows
 *    every other scanner uses) and with the INDEPENDENT ORACLE (gitleaks,
 *    pinned, `stdin` mode over the same texts, configured from the same
 *    catalogue: `gitleaks-config.ts`). The catalogue decides what is purged;
 *    an oracle hit no catalogue value contains is a REFUSAL — a format the
 *    catalogue lacks becomes a catalogue row first — unless the review names
 *    it (a false positive, by the digest of its value, never the value).
 * 4. PURGE with `git filter-repo --sensitive-data-removal`, from a generated
 *    0600 expressions file in the run folder (never committed, never logged):
 *    each value becomes `[REMOVED:<entry>]`; a short value is replaced only
 *    inside its line (a lone `1` would shred the history); a blob holding a
 *    hit filter-repo cannot rewrite in place (a NUL in its first bytes, any
 *    encoding but UTF-8) is stripped whole and named in the receipt.
 * 5. RE-SCAN to zero with both scanners (`purgeResidue`); anything left is a
 *    refusal.
 * 6. RECEIPT: the refs before and after, the object counts, the hits per entry
 *    and per oracle rule (never a value), the expressions' digest, the
 *    stripped blobs and the tools' pins; a local repository is recorded by
 *    its folder name only. It is itself SCANNED before any push
 *    (`receiptRefusal`: no absolute or home path, no catalogue hit), then
 *    committed to the imported history on `receipt.ref`
 *    (`<folder>/<run id>.json`).
 * 7. PUSH every ref with an explicit refspec, atomically and never forced,
 *    into a target that must be EMPTY (the importer never rewrites a
 *    published history), then read the target's refs back.
 *
 * Every tool process is bounded by its CPU time and a stall check, never by
 * wall time (`history-tools.ts`).
 *
 * A name (a path, a ref name) that holds a secret is a refusal: renaming is
 * a person's decision. A URL that carries credentials is a refusal: it would
 * be recorded.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { atomicWriteFile } from "../../filesystem/atomic-write.ts";
import { admitPrivateHome, IMPORT_HOME, privateHomeLocation } from "../../filesystem/private-home.ts";
import { ensurePrivateStateDirectory, PRIVATE_STATE_FILE_MODE } from "../../filesystem/private-state.ts";
import { gitOutput, writeBlob, writeTree, type GitRepository } from "../../git/tree-reader.ts";
import { parsePushPorcelain } from "../../git/git-port.ts";
import { canonicalHash, canonicalJson, deepFreeze, randomBytes, sha256 } from "../../kernel/integrity.ts";
import { schemaId } from "../../kernel/product-identity.ts";
import { ROOT_POLICY } from "../../kernel/root-policy.ts";
import { DEFAULT_PRIVACY_POLICY } from "../../privacy/privacy-policy.ts";
import { detectSensitiveSpans } from "../../privacy/redaction-engine.ts";
import { MIN_KNOWN_SECRET_LENGTH } from "../../privacy/secret-intelligence.ts";
import { SECRET_TEXT_SIGNAL_CATALOG } from "../../privacy/secret-signals.ts";
import { COMMAND_ENVIRONMENT, GIT_NETWORK_ENVIRONMENT, projectEnvironment } from "../../process/environment-projection.ts";
import { debugLog } from "../../shared/debug/debug-system.ts";
import { FORGE_LOG_CATEGORY, ForgeError, type ForgeCode, type ForgeFacts } from "./codes.ts";
import { GITLEAKS_CATALOGUE_RULE_PREFIX, gitleaksConfigText } from "./gitleaks-config.ts";
import { hostProgramVersion, resolveHistoryTool, runHistoryTool, type ResolvedHistoryTool } from "./history-tools.ts";

const POLICY = ROOT_POLICY.workflow.historyImport;

const HISTORY_IMPORT_RECEIPT_SCHEMA = schemaId("history-import-receipt", 1);
export const IMPORT_REVIEW_SCHEMA = schemaId("history-import-review", 1);

// ── Where ────────────────────────────────────────────────────────────────

/**
 * The admitted import home (created private when absent; refused when it is
 * a link, another user's, open to others, or overlapping `neighbours`: the
 * harness checkout and the system temp folder). A process under test without
 * `HARNESS_IMPORT_HOME` is refused (`history_import_home_unset_under_test`).
 */
export function admitImportHome(harnessTop: string, location: string = privateHomeLocation(IMPORT_HOME)): string {
  return admitPrivateHome(IMPORT_HOME, location, [
    { path: harnessTop, what: "the harness checkout" },
    { path: tmpdir(), what: "the system temp folder" },
  ]);
}

/** A URL whose userinfo is present (`scheme://user[:pass]@host`): a credential would be recorded. */
const URL_WITH_USERINFO = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/iu;

function refuseCredentialedLocation(location: string, what: string): void {
  if (location.length === 0) throw new ForgeError("history_import_usage", `the ${what} is empty`);
  if (URL_WITH_USERINFO.test(location)) {
    throw new ForgeError("history_import_credentials_in_url", `the ${what} URL carries a user or password; credentials reach git through its credential helper, never a URL (D-09)`);
  }
}

// ── Enumerate ────────────────────────────────────────────────────────────

export type HistoryObjectType = "blob" | "commit" | "tag" | "tree";
export type HistoryObject = Readonly<{ oid: string; type: HistoryObjectType; size: number }>;

/** Every ref and object of a repository, and every name it carries (paths and ref names). */
export type HistoryInventory = Readonly<{
  refs: Readonly<Record<string, string>>;
  objects: readonly HistoryObject[];
  /** Each distinct path any tree records, and the object it names there. */
  paths: readonly Readonly<{ path: string; oid: string }>[];
}>;

function lines(output: Buffer): readonly string[] {
  return output.toString("utf8").split("\n").filter((line) => line.length > 0);
}

/** {@link HistoryInventory} of `repository`: `for-each-ref`, then `rev-list --objects --all` typed by one `cat-file --batch-check`. */
export function enumerateHistory(repository: GitRepository): HistoryInventory {
  const refs: Record<string, string> = {};
  for (const line of lines(gitOutput(repository, ["for-each-ref", "--format=%(objectname) %(refname)"]).stdout)) {
    const space = line.indexOf(" ");
    refs[line.slice(space + 1)] = line.slice(0, space);
  }
  const listed = lines(gitOutput(repository, ["rev-list", "--objects", "--all"]).stdout);
  const paths: { path: string; oid: string }[] = [];
  const oids: string[] = [];
  for (const line of listed) {
    const space = line.indexOf(" ");
    const oid = space < 0 ? line : line.slice(0, space);
    oids.push(oid);
    if (space >= 0 && line.length > space + 1) paths.push({ path: line.slice(space + 1), oid });
  }
  const objects: HistoryObject[] = [];
  if (oids.length > 0) {
    const checked = lines(gitOutput(repository, ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], { input: Buffer.from(`${oids.join("\n")}\n`, "utf8") }).stdout);
    for (const line of checked) {
      const [oid, type, size] = line.split(" ");
      if (type !== "blob" && type !== "commit" && type !== "tag" && type !== "tree") {
        throw new ForgeError("history_import_git_answer", `git cat-file --batch-check answered "${line}" in ${repository.root}`);
      }
      objects.push({ oid: oid!, type, size: Number(size) });
    }
  }
  const sortedRefs = Object.fromEntries(Object.entries(refs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return deepFreeze({ refs: sortedRefs, objects, paths });
}

/**
 * The bytes of every object of `objects`, batch by batch, read with
 * `cat-file --batch` in batches whose declared sizes fit half the git output
 * bound (a larger object is read alone; one larger than the bound itself is
 * the refusal `history_import_object_too_large`).
 */
function* objectBatches(repository: GitRepository, objects: readonly HistoryObject[]): Generator<readonly Readonly<{ object: HistoryObject; bytes: Buffer }>[]> {
  const bound = ROOT_POLICY.runtime.limits.maximumGitOutputBytes;
  const half = Math.floor(bound / 2);
  const read = (batch: readonly HistoryObject[]): readonly Readonly<{ object: HistoryObject; bytes: Buffer }>[] => {
    const output = gitOutput(repository, ["cat-file", "--batch"], { input: Buffer.from(`${batch.map((object) => object.oid).join("\n")}\n`, "utf8") }).stdout;
    let offset = 0;
    return batch.map((object) => {
      const newline = output.indexOf(0x0a, offset);
      const size = Number(output.subarray(offset, newline).toString("utf8").split(" ")[2]);
      const bytes = output.subarray(newline + 1, newline + 1 + size);
      offset = newline + 1 + size + 1;
      return { object, bytes };
    });
  };
  let batch: HistoryObject[] = [];
  let bytes = 0;
  for (const object of objects) {
    if (object.size + 128 > bound) {
      throw new ForgeError("history_import_object_too_large", `the ${object.type} ${object.oid} is ${String(object.size)} bytes, above the git output bound of ${String(bound)}; it cannot be scanned in one read`, { oid: object.oid, size: object.size });
    }
    if (batch.length > 0 && bytes + object.size > half) {
      yield read(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(object);
    bytes += object.size;
  }
  if (batch.length > 0) yield read(batch);
}

// ── Scan (the catalogue) ─────────────────────────────────────────────────

/** One catalogue hit in one object: the entry, the value (held in memory only), and how it is purged. */
export type CatalogueHit = Readonly<{
  entry: string;
  value: string;
  oid: string;
  type: HistoryObjectType;
  /** filter-repo leaves a blob with a NUL in its first bytes untouched: such a blob is stripped whole. */
  binary: boolean;
  /** A short value's in-line expression (its line window and that window with the value replaced), or `null` for a value replaced alone. */
  anchor: Readonly<{ literal: string; replacement: string }> | null;
}>;

/** A name (a path or a ref name) holding a hit: never purged, refused (renaming is a person's decision). */
export type NameHit = Readonly<{ entry: string; kind: "path" | "ref"; oid: string }>;

export type CatalogueScan = Readonly<{
  hits: readonly CatalogueHit[];
  nameHits: readonly NameHit[];
  /** Objects no candidate encoding decodes (matched byte for byte; refused unless exempted), sorted. */
  undecodable: readonly string[];
  scanned: Readonly<{ objects: number; bytes: number; names: number }>;
}>;

/** What a purged value of `entry` becomes. */
export function removedMarker(entry: string): string {
  return `${POLICY.removedMarker.open}${entry}${POLICY.removedMarker.close}`;
}

type Span = Readonly<{ entry: string; start: number; end: number }>;

/** The catalogue's spans in `text`: the ONE format scan (the redaction engine's, admission profile, every secret category). */
function catalogueSpans(text: string): readonly Span[] {
  return detectSensitiveSpans(text, DEFAULT_PRIVACY_POLICY).map((span) => ({ entry: span.signalId, start: span.startUtf16, end: span.endUtf16 }));
}

/** The line around `index` in `text`, without its newline or a trailing carriage return. */
function lineAround(text: string, index: number): Readonly<{ start: number; end: number }> {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  const newline = text.indexOf("\n", index);
  let end = newline < 0 ? text.length : newline;
  if (end > start && text[end - 1] === "\r") end -= 1;
  return { start, end };
}

/**
 * The in-line expressions of `text`'s SHORT spans: one per line holding any,
 * its window running `anchorContextCharacters` past the outermost short spans
 * (never past the line, never ending in a carriage return), its replacement
 * the window with each short value replaced by its marker. A long value in
 * the same window is left to its own expression, which runs after.
 */
function anchoredExpressions(text: string, short: readonly Span[]): ReadonlyMap<Span, Readonly<{ literal: string; replacement: string }>> {
  const byLine = new Map<number, Span[]>();
  for (const span of short) {
    const line = lineAround(text, span.start);
    byLine.set(line.start, [...(byLine.get(line.start) ?? []), span]);
  }
  const out = new Map<Span, Readonly<{ literal: string; replacement: string }>>();
  for (const [lineStart, spans] of byLine) {
    const line = lineAround(text, lineStart);
    const first = Math.min(...spans.map((span) => span.start));
    const last = Math.max(...spans.map((span) => span.end));
    const start = Math.max(line.start, first - POLICY.anchorContextCharacters);
    let end = Math.min(line.end, last + POLICY.anchorContextCharacters);
    while (end > last && text[end - 1] === "\r") end -= 1;
    let replacement = text.slice(start, end);
    for (const span of [...spans].sort((a, b) => b.start - a.start)) {
      replacement = replacement.slice(0, span.start - start) + removedMarker(span.entry) + replacement.slice(span.end - start);
    }
    const expression = deepFreeze({ literal: text.slice(start, end), replacement });
    for (const span of spans) out.set(span, expression);
  }
  return out;
}

/** One way an object's bytes read as text: its encoding, the text, and whether filter-repo can rewrite a value in place (UTF-8 bytes only). */
export type DecodedText = Readonly<{ encoding: string; text: string; rewritable: boolean }>;

const BOMS: readonly Readonly<{ bytes: readonly number[]; encoding: "utf-8" | "utf-16le" | "utf-16be" | "utf-32le" | "utf-32be" }>[] = deepFreeze([
  { bytes: [0x00, 0x00, 0xfe, 0xff], encoding: "utf-32be" },
  { bytes: [0xff, 0xfe, 0x00, 0x00], encoding: "utf-32le" },
  { bytes: [0xef, 0xbb, 0xbf], encoding: "utf-8" },
  { bytes: [0xfe, 0xff], encoding: "utf-16be" },
  { bytes: [0xff, 0xfe], encoding: "utf-16le" },
]);

/** `bytes` decoded as `encoding`, or `undefined` when they are not valid in it (never a lossy guess). */
function strictDecode(bytes: Buffer, encoding: "utf-8" | "utf-16le" | "utf-16be" | "utf-32le" | "utf-32be"): string | undefined {
  if (encoding === "utf-32le" || encoding === "utf-32be") {
    if (bytes.length % 4 !== 0) return undefined;
    const points: number[] = [];
    for (let offset = 0; offset < bytes.length; offset += 4) {
      const point = encoding === "utf-32le" ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset);
      if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return undefined;
      points.push(point);
    }
    return points.map((point) => String.fromCodePoint(point)).join("");
  }
  try {
    return new TextDecoder(encoding, { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Whether the NULs of `probe` sit at alternate positions, as in UTF-16 text without a BOM (`le`: the high byte, odd positions, is the zero one). */
function looksUtf16(probe: Buffer, order: "le" | "be"): boolean {
  let zeroHigh = 0;
  let zeroLow = 0;
  for (let index = 0; index + 1 < probe.length; index += 2) {
    const [low, high] = order === "le" ? [probe[index]!, probe[index + 1]!] : [probe[index + 1]!, probe[index]!];
    if (high === 0) zeroHigh += 1;
    if (low === 0) zeroLow += 1;
  }
  const pairs = Math.floor(probe.length / 2);
  return pairs > 0 && zeroHigh * 10 >= pairs * 3 && zeroLow * 20 <= pairs;
}

/**
 * EVERY TEXT `bytes` HOLD, before any matching: the encoding a BOM names
 * (UTF-8, UTF-16LE/BE, UTF-32LE/BE), else UTF-8 when the bytes are valid
 * UTF-8, plus UTF-16LE/BE when the NULs sit at alternate positions and the
 * bytes decode. Each decode is strict; nothing is guessed lossily. Bytes no
 * candidate decodes are UNDECODABLE: they are still matched byte for byte
 * (`latin1`, so an ASCII credential inside a binary is seen), and the import
 * refuses them unless a reviewed exemption names the object.
 */
export function decodedTexts(bytes: Buffer): Readonly<{ texts: readonly DecodedText[]; undecodable: boolean }> {
  const bom = BOMS.find((candidate) => candidate.bytes.every((byte, index) => bytes[index] === byte));
  const texts: DecodedText[] = [];
  if (bom !== undefined) {
    const text = strictDecode(bytes.subarray(bom.bytes.length), bom.encoding);
    if (text !== undefined) texts.push({ encoding: bom.encoding, text, rewritable: bom.encoding === "utf-8" });
  } else {
    const utf8 = strictDecode(bytes, "utf-8");
    if (utf8 !== undefined) texts.push({ encoding: "utf-8", text: utf8, rewritable: true });
    const probe = bytes.subarray(0, POLICY.binaryProbeBytes);
    for (const order of ["le", "be"] as const) {
      if (!probe.includes(0) || !looksUtf16(probe, order)) continue;
      const text = strictDecode(bytes, order === "le" ? "utf-16le" : "utf-16be");
      if (text !== undefined) texts.push({ encoding: `utf-16${order}`, text, rewritable: false });
    }
  }
  if (texts.length > 0) return deepFreeze({ texts, undecodable: false });
  return deepFreeze({ texts: [{ encoding: "latin1", text: bytes.toString("latin1"), rewritable: false }], undecodable: true });
}

/**
 * The catalogue hits of one object's bytes, in every text they hold
 * ({@link decodedTexts}). A hit in a text filter-repo cannot rewrite in place
 * (any encoding but UTF-8, or a blob with a NUL in its first bytes) marks
 * the blob for stripping whole.
 */
function objectHits(object: HistoryObject, bytes: Buffer, texts: readonly DecodedText[]): readonly CatalogueHit[] {
  const nulProbe = object.type === "blob" && bytes.subarray(0, POLICY.binaryProbeBytes).includes(0);
  const hits: CatalogueHit[] = [];
  for (const decoded of texts) {
    const spans = catalogueSpans(decoded.text);
    if (spans.length === 0) continue;
    const anchors = decoded.rewritable ? anchoredExpressions(decoded.text, spans.filter((span) => span.end - span.start < MIN_KNOWN_SECRET_LENGTH)) : new Map();
    for (const span of spans) {
      hits.push(deepFreeze({
        entry: span.entry,
        value: decoded.text.slice(span.start, span.end),
        oid: object.oid,
        type: object.type,
        binary: nulProbe || !decoded.rewritable,
        anchor: anchors.get(span) ?? null,
      }));
    }
  }
  return hits;
}

/** Both scans of one history: the catalogue's hits and the oracle's findings, over the same bytes. */
export type HistoryScan = Readonly<{ catalogue: CatalogueScan; oracle: readonly OracleFinding[] }>;

/**
 * THE SCAN of `inventory`, ONE read of every blob, commit and tag object
 * (and every path and ref name) feeding BOTH scanners: the catalogue per
 * object, and the oracle over chunks of objects (`oracleChunkBytes` each, an
 * object never split) through `oracle`, which answers gitleaks' JSON report
 * of the chunk it is handed (`stdin` mode). Each finding is located by its
 * line in its chunk, so it names the object it is in. Every object is scanned
 * once, whatever number of commits carry it (the oracle's `git` mode re-reads
 * every commit's diff: measured more than 25 minutes, unfinished, on a 2,778
 * commit history whose objects `stdin` scans at about 7 MB/s).
 */
export async function scanHistory(repository: GitRepository, inventory: HistoryInventory, oracle: OracleRunner, chunkBytes: number = POLICY.oracleChunkBytes): Promise<HistoryScan> {
  const hits: CatalogueHit[] = [];
  const findings: OracleFinding[] = [];
  const chunk = oracleChunk(oracle, findings, chunkBytes);
  let bytes = 0;
  const scanned = inventory.objects.filter((object) => object.type !== "tree");
  const undecodable: string[] = [];
  for (const batch of objectBatches(repository, scanned)) {
    for (const { object, bytes: content } of batch) {
      bytes += content.length;
      const decoded = decodedTexts(content);
      if (decoded.undecodable) undecodable.push(object.oid);
      hits.push(...objectHits(object, content, decoded.texts));
      // The oracle reads the same texts: each decoded text as UTF-8, an undecodable object as its bytes.
      for (const text of decoded.texts) await chunk.add(`${object.type} ${object.oid}`, decoded.undecodable ? content : Buffer.from(text.text, "utf8"));
    }
  }
  const nameHits: NameHit[] = [];
  for (const { path, oid } of inventory.paths) {
    for (const span of catalogueSpans(path)) nameHits.push({ entry: span.entry, kind: "path", oid });
    await chunk.add(`the path of ${oid}`, Buffer.from(path, "utf8"));
  }
  for (const [ref, oid] of Object.entries(inventory.refs)) {
    for (const span of catalogueSpans(ref)) nameHits.push({ entry: span.entry, kind: "ref", oid });
    await chunk.add(`the name of a ref at ${oid}`, Buffer.from(ref, "utf8"));
  }
  await chunk.flush();
  return deepFreeze({
    catalogue: { hits, nameHits, undecodable: undecodable.sort(), scanned: { objects: scanned.length, bytes, names: inventory.paths.length + Object.keys(inventory.refs).length } },
    oracle: findings,
  });
}

/** How many hits each entry had (the receipt's and the refusals' only view of the hits). */
function countByEntry(hits: readonly Readonly<{ entry: string }>[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const hit of hits) counts[hit.entry] = (counts[hit.entry] ?? 0) + 1;
  return deepFreeze(Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1))));
}

// ── The oracle ───────────────────────────────────────────────────────────

/** One oracle finding: its rule, its value (in memory only), and where it is (an object, or a name). */
export type OracleFinding = Readonly<{ rule: string; secret: string; location: string }>;

/** The oracle over one chunk: its bytes in, gitleaks' JSON report out. */
export type OracleRunner = (input: Buffer) => Promise<string>;

const GITLEAKS_REPORT = z.array(z.looseObject({ RuleID: z.string(), Secret: z.string(), StartLine: z.number().int().min(1) }));

/** The findings of a gitleaks JSON report (`[]` for no finding), each located by `locate` from its 1-based start line. */
export function parseOracleReport(text: string, locate: (line: number) => string): readonly OracleFinding[] {
  let report: unknown;
  try {
    report = JSON.parse(text.trim().length === 0 ? "[]" : text);
  } catch {
    throw new ForgeError("history_import_oracle_report", "the oracle's report is not JSON");
  }
  const parsed = GITLEAKS_REPORT.safeParse(report);
  if (!parsed.success) throw new ForgeError("history_import_oracle_report", "the oracle's report is not gitleaks' JSON finding list");
  return deepFreeze(parsed.data.map((finding) => ({ rule: finding.RuleID, secret: finding.Secret, location: locate(finding.StartLine) })));
}

/**
 * The oracle's chunker: objects are appended whole (each ending in a newline)
 * with the line range each occupies; a chunk is handed to `oracle` when the
 * next object would take it past `chunkBytes` (an object larger than
 * that is a chunk of its own), and every finding is located by its line.
 */
function oracleChunk(oracle: OracleRunner, findings: OracleFinding[], chunkBytes: number): Readonly<{ add: (location: string, content: Buffer) => Promise<void>; flush: () => Promise<void> }> {
  let parts: Buffer[] = [];
  let size = 0;
  let ranges: { last: number; location: string }[] = [];
  let lines = 0;
  const flush = async (): Promise<void> => {
    if (parts.length === 0) return;
    const held = ranges;
    const locate = (line: number): string => {
      let low = 0;
      let high = held.length - 1;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (held[middle]!.last < line) low = middle + 1;
        else high = middle;
      }
      return held[low]!.location;
    };
    findings.push(...parseOracleReport(await oracle(Buffer.concat(parts)), locate));
    parts = [];
    size = 0;
    ranges = [];
    lines = 0;
  };
  const add = async (location: string, content: Buffer): Promise<void> => {
    const body = content.length > 0 && content[content.length - 1] === 0x0a ? content : Buffer.concat([content, Buffer.from("\n")]);
    if (size > 0 && size + body.length > chunkBytes) await flush();
    let newlines = 0;
    for (let index = body.indexOf(0x0a); index >= 0; index = body.indexOf(0x0a, index + 1)) newlines += 1;
    lines += newlines;
    ranges.push({ last: lines, location });
    parts.push(body);
    size += body.length;
  };
  return { add, flush };
}

const GIT_OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

const REVIEW = z.strictObject({
  schema: z.literal(IMPORT_REVIEW_SCHEMA),
  /** Oracle false positives: the rule and the sha256 of the value (never the value), with why it is not a secret. */
  dispositions: z.array(z.strictObject({
    rule: z.string().min(1),
    secretSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    reason: z.string().min(1),
  })),
  /** Objects no encoding decodes (an image, a database), each named by its object id, with why its bytes may enter the forge. */
  binaries: z.array(z.strictObject({ oid: z.string().regex(GIT_OID), reason: z.string().min(1) })).optional(),
});

/** A reviewed oracle false positive: its rule, the sha256 of its value (never the value) and why it is not a secret. */
export type OracleDisposition = z.infer<typeof REVIEW>["dispositions"][number];

/** A person's reviewed decisions for one import: the oracle dispositions and the undecodable objects exempted. */
export type ImportReview = Readonly<{ dispositions: readonly OracleDisposition[]; binaries: ReadonlySet<string>; sha256: string | null }>;

const NO_REVIEW: ImportReview = deepFreeze({ dispositions: [], binaries: new Set<string>(), sha256: null });

/** The review file at `path` (`history_import_review_invalid` when it is not the schema). */
export function readImportReview(path: string): ImportReview {
  let bytes: Buffer;
  let parsed: unknown;
  try {
    bytes = readFileSync(path);
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new ForgeError("history_import_review_invalid", `the import review ${path} is not readable JSON (${(error as Error).message})`);
  }
  const checked = REVIEW.safeParse(parsed);
  if (!checked.success) throw new ForgeError("history_import_review_invalid", `the import review ${path} is not ${IMPORT_REVIEW_SCHEMA}: ${checked.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  return Object.freeze({ dispositions: deepFreeze(checked.data.dispositions), binaries: new Set((checked.data.binaries ?? []).map((entry) => entry.oid)), sha256: sha256(bytes) });
}

/** An oracle finding no catalogue value contains (and no disposition excuses): the catalogue lacks the format, or its projection diverged. */
export type OracleGap = Readonly<{ rule: string; location: string; secretSha256: string; kind: "catalogue-gap" | "projection-divergence" }>;

export type OracleJudgement = Readonly<{
  covered: Readonly<Record<string, number>>;
  disposed: Readonly<Record<string, number>>;
  gaps: readonly OracleGap[];
}>;

/**
 * Judges each oracle finding against the catalogue's VALUES: covered when a
 * catalogue value CONTAINS the oracle's (the purge of that value removes it;
 * an oracle span wider than every catalogue span is a gap — the catalogue's
 * row is too narrow, e.g. a key's header without its body), disposed when a
 * reviewed disposition names its rule and value digest, else a gap.
 */
export function judgeOracle(findings: readonly OracleFinding[], catalogueValues: readonly string[], dispositions: readonly OracleDisposition[]): OracleJudgement {
  const disposedKeys = new Set(dispositions.map((disposition) => `${disposition.rule}\0${disposition.secretSha256}`));
  const covered: Record<string, number> = {};
  const disposed: Record<string, number> = {};
  const gaps: OracleGap[] = [];
  for (const finding of findings) {
    if (catalogueValues.some((value) => value.includes(finding.secret))) {
      covered[finding.rule] = (covered[finding.rule] ?? 0) + 1;
    } else if (disposedKeys.has(`${finding.rule}\0${sha256(finding.secret)}`)) {
      disposed[finding.rule] = (disposed[finding.rule] ?? 0) + 1;
    } else {
      gaps.push({ rule: finding.rule, location: finding.location, secretSha256: sha256(finding.secret), kind: finding.rule.startsWith(GITLEAKS_CATALOGUE_RULE_PREFIX) ? "projection-divergence" : "catalogue-gap" });
    }
  }
  const sorted = (counts: Record<string, number>) => Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1)));
  return deepFreeze({ covered: sorted(covered), disposed: sorted(disposed), gaps });
}

/**
 * The pinned gitleaks as an {@link OracleRunner}: `stdin` mode with the
 * generated configuration (written once in the run folder), inline
 * `gitleaks:allow` comments ignored (an imported history must not silence
 * its oracle). Its report comes back on stdout and is held in memory only:
 * it carries the values, so no file of it is ever written.
 */
function gitleaksOracle(gitleaks: ResolvedHistoryTool, runFolder: string): OracleRunner {
  const config = join(runFolder, "gitleaks.toml");
  if (!existsSync(config)) writePrivate(config, gitleaksConfigText());
  return async (input) => (await runHistoryTool(gitleaks, [
    "stdin", "--no-banner", "--log-level", "error", "--exit-code", "0", "--ignore-gitleaks-allow",
    "--config", config, "--report-format", "json", "--report-path", "-",
  ], { cwd: runFolder, env: projectEnvironment(process.env, COMMAND_ENVIRONMENT), input })).stdout;
}

// ── Purge ────────────────────────────────────────────────────────────────

export type PurgePlan = Readonly<{
  /** The filter-repo expressions file's text (secret values: written 0600 in the run folder only). */
  expressions: string;
  expressionCount: number;
  /** Blobs stripped whole (a binary blob holding a hit). */
  strippedBlobs: readonly string[];
}>;

const byLengthThenText = (a: string, b: string): number => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0);

/**
 * THE PURGE PLAN of `hits` (deterministic: the same hits give the same
 * bytes). The in-line expressions come first, longest first; then every
 * value replaced alone, longest first (a value contained in another is
 * replaced after it). Each line is `literal:<text>==><replacement>`:
 * filter-repo splits at the LAST `==>`, so a replacement holding one, or a
 * literal holding a newline, cannot be expressed
 * (`history_import_purge_inexpressible`, naming the entry and the object).
 */
export function planPurge(hits: readonly CatalogueHit[]): PurgePlan {
  const anchored = new Map<string, string>();
  const alone = new Map<string, string>();
  const stripped = new Set<string>();
  for (const hit of hits) {
    if (hit.binary) stripped.add(hit.oid);
    if (hit.anchor !== null) {
      if (!anchored.has(hit.anchor.literal)) anchored.set(hit.anchor.literal, hit.anchor.replacement);
    } else {
      const marker = removedMarker(hit.entry);
      const previous = alone.get(hit.value);
      if (previous === undefined || marker < previous) alone.set(hit.value, marker);
    }
  }
  const expression = (literal: string, replacement: string, hit: CatalogueHit | undefined): string => {
    if (replacement.includes("==>") || /[\r\n]/u.test(literal) || /[\r\n]/u.test(replacement)) {
      throw new ForgeError("history_import_purge_inexpressible", `a ${hit?.entry ?? "catalogue"} hit in ${hit?.oid ?? "the history"} cannot be written as a filter-repo expression (its line holds "==>" or a line break); purge it by hand before importing`, hit === undefined ? {} : { entry: hit.entry, oid: hit.oid });
    }
    return `literal:${literal}==>${replacement}`;
  };
  const hitOf = (predicate: (hit: CatalogueHit) => boolean) => hits.find(predicate);
  const lines = [
    ...[...anchored.keys()].sort(byLengthThenText).map((literal) => expression(literal, anchored.get(literal)!, hitOf((hit) => hit.anchor?.literal === literal))),
    ...[...alone.keys()].sort(byLengthThenText).map((value) => expression(value, alone.get(value)!, hitOf((hit) => hit.value === value))),
  ];
  return deepFreeze({
    expressions: lines.length === 0 ? "" : `${lines.join("\n")}\n`,
    expressionCount: lines.length,
    strippedBlobs: [...stripped].sort(),
  });
}

/** Writes `content` at `path`, private (0600) whatever the umask. */
function writePrivate(path: string, content: string): void {
  const written = atomicWriteFile(path, content, { requiredMode: PRIVATE_STATE_FILE_MODE });
  if (!written.success) throw new ForgeError("history_import_write_failed", `${path} could not be written: ${written.reason ?? "unknown"}`);
}

/** filter-repo's own record of the rewrite (`<git dir>/filter-repo/first-changed-commits`), for the receipt. */
function firstChangedCommits(repository: GitRepository): readonly string[] {
  const path = join(repository.root, "filter-repo", "first-changed-commits");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0).sort() : [];
}

// ── Refs, receipt, push ──────────────────────────────────────────────────

export type RefMapping = Readonly<{ source: string; target: string; oid: string }>;

/**
 * Where each ref goes: a ref in a kept namespace (`keptRefNamespaces`) keeps
 * its name; any other (`refs/pull/1/head`, `refs/stash`) goes under
 * `importedRefPrefix` (GitHub refuses `refs/pull/*`). Two refs landing on one
 * name, or a ref on the receipt's own ref, is `history_import_ref_collision`.
 */
export function planRefs(refs: Readonly<Record<string, string>>): readonly RefMapping[] {
  const mapped: RefMapping[] = [];
  const seen = new Map<string, string>([[POLICY.receipt.ref, "the import receipt"]]);
  for (const [source, oid] of Object.entries(refs)) {
    const target = POLICY.keptRefNamespaces.some((namespace) => source.startsWith(namespace)) ? source : `${POLICY.importedRefPrefix}${source.slice("refs/".length)}`;
    const holder = seen.get(target);
    if (holder !== undefined) throw new ForgeError("history_import_ref_collision", `${source} and ${holder} would both be pushed as ${target}`);
    seen.set(target, source);
    mapped.push({ source, target, oid });
  }
  return deepFreeze(mapped);
}

export type HistoryImportReceipt = Readonly<{
  schema: typeof HISTORY_IMPORT_RECEIPT_SCHEMA;
  id: string;
  importedAt: string;
  /** Where the history came from and went: a URL as given (never with credentials), or `local:<folder name>` (never an absolute path). */
  source: string;
  target: string;
  before: Readonly<{ refs: Readonly<Record<string, string>>; objects: Readonly<Record<HistoryObjectType, number>>; scannedBytes: number }>;
  findings: Readonly<{
    catalogue: Readonly<Record<string, number>>;
    oracle: Readonly<{ covered: Readonly<Record<string, number>>; disposed: Readonly<Record<string, number>> }>;
    review: Readonly<{ dispositions: number; binaries: number; sha256: string | null }>;
  }>;
  purge: Readonly<{ expressionsSha256: string; expressions: number; strippedBlobs: readonly string[]; firstChangedCommits: readonly string[] }>;
  /** After the purge: no catalogue hit and no oracle finding left, except the reviewed dispositions (counted per rule); the exempted undecodable objects. */
  after: Readonly<{ objects: Readonly<Record<HistoryObjectType, number>>; catalogueHits: 0; oracleGaps: 0; oracleDisposed: Readonly<Record<string, number>>; undecodableExempted: number }>;
  refMap: readonly RefMapping[];
  tools: Readonly<{
    git: string;
    python: string;
    gitleaks: Readonly<{ version: string; sha256: string }>;
    filterRepo: Readonly<{ version: string; sha256: string }>;
    oracleConfigSha256: string;
    catalogueSha256: string;
  }>;
}>;

function objectCounts(inventory: HistoryInventory): Readonly<Record<HistoryObjectType, number>> {
  const counts: Record<HistoryObjectType, number> = { blob: 0, commit: 0, tag: 0, tree: 0 };
  for (const object of inventory.objects) counts[object.type] += 1;
  return deepFreeze(counts);
}

/** The catalogue as it judged this import: each row's id, category and admission pattern, digested. */
function catalogueDigest(): string {
  return canonicalHash(SECRET_TEXT_SIGNAL_CATALOG.map((row) => ({ id: row.id, category: row.category, admission: `/${row.admission.source}/${row.admission.flags}` })));
}

/** Commits `receipt` on the receipt ref of `repository` (created; never moved): `<folder>/<id>.json` alone in its tree. */
function recordReceipt(repository: GitRepository, receipt: HistoryImportReceipt, runFolder: string): string {
  const blob = writeBlob(repository, `${JSON.stringify(receipt, null, 2)}\n`);
  const tree = writeTree(repository, new Map([[`${POLICY.receipt.folder}/${receipt.id}.json`, { mode: "100644", oid: blob }]]), runFolder);
  const identity = {
    GIT_AUTHOR_NAME: POLICY.identity.name, GIT_AUTHOR_EMAIL: POLICY.identity.email,
    GIT_COMMITTER_NAME: POLICY.identity.name, GIT_COMMITTER_EMAIL: POLICY.identity.email,
  };
  const commit = gitOutput(repository, ["commit-tree", tree, "-m", `history import ${receipt.id}: scanned, purged and re-scanned to zero`], { environment: identity }).stdout.toString("utf8").trim();
  gitOutput(repository, ["update-ref", POLICY.receipt.ref, commit, "0".repeat(commit.length)]);
  return commit;
}

/** The refs `target` holds (`ls-remote`), name → object. */
function remoteRefs(repository: GitRepository, target: string): Readonly<Record<string, string>> {
  const refs: Record<string, string> = {};
  for (const line of lines(gitOutput(repository, ["ls-remote", "--", target]).stdout)) {
    const [oid, ref] = line.split("\t");
    if (ref !== undefined && ref !== "HEAD" && !ref.endsWith("^{}")) refs[ref] = oid!;
  }
  return refs;
}

/** Pushes `mappings` to `target` atomically (explicit refspecs, never forced), then reads the target back: every ref at its object, and nothing else. */
function pushHistory(repository: GitRepository, target: string, mappings: readonly RefMapping[]): void {
  const pushed = gitOutput(repository, ["push", "--atomic", "--porcelain", "--", target, ...mappings.map((mapping) => `${mapping.source}:${mapping.target}`)], { allowed: [0, 1] });
  const refused = parsePushPorcelain(pushed.stdout.toString("utf8")).filter((ref) => ref.flag === "!");
  if (pushed.status !== 0 || refused.length > 0) {
    throw new ForgeError("history_import_push_refused", `the push to ${target} was refused (${refused.map((ref) => `${ref.destination}: ${ref.summary}`).join("; ") || `git exited ${String(pushed.status)}`}); a push-protection refusal is a catalogue defect, never a bypass`);
  }
  const landed = remoteRefs(repository, target);
  const wrong = mappings.filter((mapping) => landed[mapping.target] !== mapping.oid).map((mapping) => mapping.target);
  const extra = Object.keys(landed).filter((ref) => !mappings.some((mapping) => mapping.target === ref));
  if (wrong.length > 0 || extra.length > 0) {
    throw new ForgeError("history_import_push_mismatch", `${target} does not hold exactly the pushed refs (differing: ${wrong.join(", ") || "none"}; unexpected: ${extra.join(", ") || "none"})`);
  }
}

/**
 * WHAT IS LEFT AFTER THE PURGE (the re-scan to zero): every catalogue hit,
 * every name hit and every oracle finding no reviewed disposition names,
 * counted per entry or rule; `disposed` counts what the review excused. An
 * import pushes only when `left` is empty.
 */
export function purgeResidue(rescan: HistoryScan, review: ImportReview): Readonly<{ left: Readonly<Record<string, number>>; disposed: Readonly<Record<string, number>> }> {
  const oracle = judgeOracle(rescan.oracle, [], review.dispositions);
  const left: Record<string, number> = {};
  for (const [entry, count] of [
    ...Object.entries(countByEntry(rescan.catalogue.hits)),
    ...Object.entries(countByEntry(rescan.catalogue.nameHits)).map(([entry, count]) => [`${entry} (in a name)`, count] as const),
    ...Object.entries(countByEntry(oracle.gaps.map((gap) => ({ entry: `${gap.rule} (oracle)` })))),
  ]) left[entry] = (left[entry] ?? 0) + count;
  return deepFreeze({ left, disposed: oracle.disposed });
}

/** How a repository location is recorded: a URL as given, a local folder by its name only (`local:<name>`), never an absolute path. */
export function recordedLocation(location: string): string {
  return /^[a-z][a-z0-9+.-]*:\/\//iu.test(location) && !/^file:/iu.test(location) ? location : `local:${location.replace(/[\\/]+$/u, "").split(/[\\/]/u).pop() ?? ""}`;
}

/** A string that is an absolute or home path (posix, a drive, `~`, `file:`), or carries one after a space, quote, `=`, `:` or `(` (`see /home/u/x`). A ref such as `refs/heads/home/x` is neither. */
const ABSOLUTE_OR_HOME = /^(?:\/|[A-Za-z]:[\\/]|~|file:)|[\s"'=(](?:\/|[A-Za-z]:[\\/]|~\/)|:(?:\/(?!\/)|[A-Za-z]:[\\/]|~\/)/u;

/**
 * THE RECEIPT IS SCANNED BEFORE ANY PUSH: every string it holds (keys
 * included) must be no absolute or home path, and its text must hold no
 * catalogue hit. Answers the offending field (`$.source`, …), or `undefined`.
 */
export function receiptRefusal(receipt: unknown): string | undefined {
  const visit = (value: unknown, path: string): string | undefined => {
    if (typeof value === "string") return ABSOLUTE_OR_HOME.test(value) ? path : undefined;
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) {
        const found = visit(item, `${path}[${String(index)}]`);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        const found = ABSOLUTE_OR_HOME.test(key) ? `${path} (a key)` : visit(item, `${path}.${key}`);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  const path = visit(receipt, "$");
  if (path !== undefined) return `${path} is an absolute or home path`;
  const spans = catalogueSpans(JSON.stringify(receipt));
  return spans.length === 0 ? undefined : `its text holds a catalogue hit (${spans.map((span) => span.entry).join(", ")})`;
}

// ── The import ───────────────────────────────────────────────────────────

export type HistoryImportRequest = Readonly<{
  source: string;
  target: string;
  /** A reviewed decisions file (`IMPORT_REVIEW_SCHEMA`: oracle dispositions, exempted undecodable objects), or none. */
  review?: string | undefined;
}>;

export type HistoryImportOptions = Readonly<{
  /** The admitted import home ({@link admitImportHome}). */
  home: string;
  /** The git executable. */
  git: string;
  onProgress?: (line: string) => void;
}>;

/** A refusal that leaves the run folder for inspection (it holds the mirror and the values: private). */
function refuse(runFolder: string, message: string, code: ForgeCode, details: ForgeFacts = {}): never {
  throw new ForgeError(code, `${message} (the run folder ${runFolder} is kept for inspection; it is private and holds secret values)`, { runFolder, ...details });
}

/**
 * THE IMPORT (see the header): mirror, enumerate, scan twice, purge, re-scan
 * to zero, record the receipt, push. Answers the receipt; on success the run
 * folder keeps only `receipt.json` (the mirror and the values are removed).
 */
export async function importHistory(request: HistoryImportRequest, options: HistoryImportOptions): Promise<HistoryImportReceipt> {
  refuseCredentialedLocation(request.source, "source");
  refuseCredentialedLocation(request.target, "target");
  const gitleaks = resolveHistoryTool(options.home, "gitleaks");
  const filterRepo = resolveHistoryTool(options.home, "git-filter-repo");
  const review = request.review === undefined ? NO_REVIEW : readImportReview(request.review);
  const id = `${new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d+Z$/u, "Z")}-${Buffer.from(randomBytes(4)).toString("hex")}`;
  // Each step: an info record (the run and the step; never a value) and the caller's progress line.
  const progress = (step: string): void => {
    debugLog(FORGE_LOG_CATEGORY, "info", "history_import_step", () => ({ run: id, step }));
    options.onProgress?.(`import ${id}: ${step}`);
  };
  const runFolder = ensurePrivateStateDirectory(join(options.home, POLICY.runsFolder, id));
  const at = (root: string): GitRepository => deepFreeze({ root, executable: options.git, timeoutMs: POLICY.gitCallCeilingMs });
  const run = at(runFolder);

  const occupied = remoteRefs(run, request.target);
  if (Object.keys(occupied).length > 0) {
    refuse(runFolder, `${request.target} already holds ${String(Object.keys(occupied).length)} ref(s); the importer writes only into an empty repository (a published history is never rewritten)`, "history_import_target_not_empty");
  }

  progress("mirroring the source");
  const mirrorPath = join(runFolder, "mirror.git");
  gitOutput(run, ["clone", "--mirror", "--no-local", "--quiet", "--", request.source, mirrorPath]);
  const mirror = at(mirrorPath);

  progress("enumerating and scanning (the catalogue and the oracle)");
  const before = enumerateHistory(mirror);
  if (Object.keys(before.refs).length === 0) refuse(runFolder, `${request.source} holds no ref; there is nothing to import`, "history_import_source_empty");
  const mappings = planRefs(before.refs);
  const oracle = gitleaksOracle(gitleaks, runFolder);
  const both = await scanHistory(mirror, before, oracle);
  const scan = both.catalogue;
  if (scan.nameHits.length > 0) {
    refuse(runFolder, `${String(scan.nameHits.length)} name(s) hold a secret (${Object.entries(countByEntry(scan.nameHits)).map(([entry, count]) => `${entry}: ${String(count)}`).join(", ")}; objects ${[...new Set(scan.nameHits.map((hit) => hit.oid))].slice(0, 8).join(", ")}); rename them in the source first`, "history_import_secret_in_name");
  }

  const unreviewed = scan.undecodable.filter((oid) => !review.binaries.has(oid));
  if (unreviewed.length > 0) {
    const named = new Map<string, string[]>();
    for (const { path, oid } of before.paths) named.set(oid, [...(named.get(oid) ?? []), path]);
    const sizes = new Map(before.objects.map((object) => [object.oid, object.size]));
    writePrivate(join(runFolder, "undecodable.json"), `${JSON.stringify({ undecodable: unreviewed.map((oid) => ({ oid, size: sizes.get(oid), paths: named.get(oid) ?? [] })) }, null, 2)}\n`);
    refuse(runFolder, `${String(unreviewed.length)} object(s) no encoding decodes (UTF-8, UTF-16, UTF-32, by BOM or by shape) and no review exempts; they are listed with their paths in undecodable.json`, "history_import_undecodable", { undecodable: unreviewed.length });
  }
  const values = [...new Set(scan.hits.map((hit) => hit.value))];
  const judgement = judgeOracle(both.oracle, values, review.dispositions);
  if (judgement.gaps.length > 0) {
    // What a reviewer needs to judge each gap, and nothing a reader could use: the rule, the object, the value's digest.
    writePrivate(join(runFolder, "oracle-gaps.json"), `${JSON.stringify({ gaps: judgement.gaps }, null, 2)}\n`);
    const rules = countByEntry(judgement.gaps.map((gap) => ({ entry: `${gap.rule} (${gap.kind})` })));
    refuse(runFolder, `the oracle found ${String(judgement.gaps.length)} secret(s) no catalogue hit contains: ${Object.entries(rules).map(([rule, count]) => `${rule}: ${String(count)}`).join(", ")} (first in ${judgement.gaps[0]!.location}; every gap, with its rule, object and value sha256, is in oracle-gaps.json). Add a catalogue row (or widen the row) for a real format, or record a reviewed disposition (that rule and sha256, with the reason) for a false positive`, "history_import_catalogue_gap", { gaps: judgement.gaps.length });
  }

  progress(`purging ${String(scan.hits.length)} hit(s)`);
  const plan = planPurge(scan.hits);
  const expressionsPath = join(runFolder, "purge-expressions");
  writePrivate(expressionsPath, plan.expressions);
  const stripPath = join(runFolder, "strip-blob-ids");
  writePrivate(stripPath, plan.strippedBlobs.map((oid) => `${oid}\n`).join(""));
  await runHistoryTool(filterRepo, [
    "--sensitive-data-removal", "--replace-text", expressionsPath, "--replace-message", expressionsPath,
    ...(plan.strippedBlobs.length > 0 ? ["--strip-blobs-with-ids", stripPath] : []),
  ], { cwd: mirrorPath, env: projectEnvironment(process.env, GIT_NETWORK_ENVIRONMENT) });

  progress("re-scanning to zero");
  const after = enumerateHistory(mirror);
  const rescanned = await scanHistory(mirror, after, oracle);
  const residue = purgeResidue(rescanned, review);
  if (Object.keys(residue.left).length > 0) {
    refuse(runFolder, `the purged history still holds secrets: ${Object.entries(residue.left).map(([entry, count]) => `${entry}: ${String(count)}`).join(", ")}`, "history_import_residue");
  }
  const stillUndecodable = rescanned.catalogue.undecodable.filter((oid) => !review.binaries.has(oid));
  if (stillUndecodable.length > 0) refuse(runFolder, `${String(stillUndecodable.length)} undecodable object(s) appeared in the rewrite`, "history_import_residue");

  const afterMappings = planRefs(after.refs);
  const receipt: HistoryImportReceipt = deepFreeze({
    schema: HISTORY_IMPORT_RECEIPT_SCHEMA,
    id,
    importedAt: new Date().toISOString(),
    source: recordedLocation(request.source),
    target: recordedLocation(request.target),
    before: { refs: before.refs, objects: objectCounts(before), scannedBytes: scan.scanned.bytes },
    findings: {
      catalogue: countByEntry(scan.hits),
      oracle: { covered: judgement.covered, disposed: judgement.disposed },
      review: { dispositions: review.dispositions.length, binaries: review.binaries.size, sha256: review.sha256 },
    },
    purge: { expressionsSha256: sha256(plan.expressions), expressions: plan.expressionCount, strippedBlobs: plan.strippedBlobs, firstChangedCommits: firstChangedCommits(mirror) },
    after: { objects: objectCounts(after), catalogueHits: 0, oracleGaps: 0, oracleDisposed: residue.disposed, undecodableExempted: rescanned.catalogue.undecodable.length },
    refMap: afterMappings,
    tools: {
      git: gitOutput(run, ["--version"]).stdout.toString("utf8").trim(),
      python: await hostProgramVersion("python3", projectEnvironment(process.env, COMMAND_ENVIRONMENT)),
      gitleaks: { version: gitleaks.pin.version, sha256: gitleaks.pin.sha256 },
      filterRepo: { version: filterRepo.pin.version, sha256: filterRepo.pin.sha256 },
      oracleConfigSha256: sha256(gitleaksConfigText()),
      catalogueSha256: catalogueDigest(),
    },
  });
  const refNames = (refs: readonly RefMapping[]): string => refs.map((ref) => ref.target).join("\n");
  if (refNames(mappings) !== refNames(afterMappings)) {
    refuse(runFolder, `the rewrite changed the set of refs (${String(mappings.length)} before, ${String(afterMappings.length)} after)`, "history_import_refs_changed");
  }

  const unsafe = receiptRefusal(receipt);
  if (unsafe !== undefined) refuse(runFolder, `the receipt cannot be pushed: ${unsafe}`, "history_import_receipt_unsafe");
  progress(`recording the receipt and pushing ${String(afterMappings.length + 1)} ref(s)`);
  const receiptCommit = recordReceipt(mirror, receipt, runFolder);
  pushHistory(mirror, request.target, [...afterMappings, { source: POLICY.receipt.ref, target: POLICY.receipt.ref, oid: receiptCommit }]);

  writePrivate(join(runFolder, "receipt.json"), `${canonicalJson(receipt)}\n`);
  for (const entry of ["mirror.git", "purge-expressions", "strip-blob-ids", "gitleaks.toml"]) {
    rmSync(join(runFolder, entry), { recursive: true, force: true });
  }
  progress(`done (${String(scan.hits.length)} hit(s) purged, receipt on ${POLICY.receipt.ref})`);
  return receipt;
}
