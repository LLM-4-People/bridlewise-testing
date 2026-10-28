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
 *    --all`: branches, tags, notes, `refs/pull/*`, a stash) and every name:
 *    each ref name, and EVERY path every tree records (`treePaths`: each
 *    tree read, never rev-list's one name per object, which hides a name
 *    beside a shared blob or tree).
 * 2b. THE ADDRESS GATE (`addressCensus`, `history-identities.ts`): EVERY
 *    published byte is judged, not only the identity headers: every
 *    address-shaped string (plain, percent-encoded, in an RFC 2047 encoded
 *    word) in every blob, commit and tag (read as UTF-8, UTF-16LE/BE at both
 *    alignments and latin1), in every path and in every ref name, folded
 *    (NFKC and the Unicode case fold) and compared against the ONE allowed
 *    list (`forge.historyImport.allowedIdentities`). An address not on it is
 *    MAPPED by the ONE mapping (`--identity-map`) or DISPOSED by the review
 *    (by its digest); anything else is refused, the address never echoed
 *    (`addresses.json` lists digests and objects). A MAPPED-FROM address is
 *    also searched as that value in every spelling (escaped, encoded,
 *    obfuscated, folded): one the rewrite cannot reach is refused. The census
 *    runs in a bounded child (`runAddressCensus`), its shape found from each
 *    `@` with bounded parts, so a history costs its length.
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
 *    encoding but UTF-8) is stripped whole, and only once the review
 *    acknowledges it by id (`strips`; `strip.json` lists each with its
 *    paths): nothing is dropped silently.
 * 5. RE-SCAN to zero with both scanners (`purgeResidue`), and the SAME
 *    address census over the rewritten history (an address no rewrite
 *    reaches — a path, a ref name — is refused), and again over the receipt
 *    before the push; filter-repo's commit map (old id → new id) is kept
 *    beside the receipt; anything left is a refusal.
 * 6. RECEIPT: counts and public facts only (the object counts, the hits per
 *    entry and per oracle rule, never a value; the refs as pushed; the tools'
 *    pins); a local repository is recorded by its folder name only. Nothing
 *    in it confirms a guess of what the rewrite removed: the ids from before
 *    the rewrite, the stripped blobs' ids and the mapping's, the review's and
 *    the expressions' digests are in the PRIVATE record (`record.json`, with
 *    `commit-map`, in the run folder), never published. It is itself
 *    SCANNED before any push
 *    (`receiptRefusal`: no absolute or home path, no catalogue hit), then
 *    committed to the imported history on `receipt.ref`
 *    (`<folder>/<run id>.json`).
 * A DRY RUN (`--dry-run`) stops after the scans and answers COUNTS (never an
 * object id): the catalogue hits, the oracle gaps, the undecodable objects,
 * the names holding a secret, every unallowed address by what resolves it
 * (the mapping, the review, or nothing), the places a mapped-from address
 * sits where the rewrite cannot reach, and the blobs it would strip; the
 * run folder holds `addresses.json` and `strip.json` for the reviewer. It
 * rewrites and pushes nothing.
 *
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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
import type { SubprocessBounds } from "../../process/subprocess-bounds.ts";
import { FORGE_LOG_CATEGORY, ForgeError, type ForgeCode, type ForgeFacts } from "./codes.ts";
import { GITLEAKS_CATALOGUE_RULE_PREFIX, gitleaksConfigText } from "./gitleaks-config.ts";
import { addressDigest, addressSpans, allowedAddresses, base64Payloads, canonicalText, foldAddress, judgeAddresses, knownAddresses, knownMatches, longestFirst, occurrenceObjects, planAddressRewrite, readIdentityMap, refDigest, refuseInsidePublicTree, unescapedText, type AddressJudgement, type AddressOccurrence, type AddressPlace, type AddressSpan, type IdentityMap, type KnownAddress } from "./history-identities.ts";
import { hostProgramVersion, resolveHistoryTool, runBounded, runHistoryTool, type ResolvedHistoryTool } from "./history-tools.ts";

const POLICY = ROOT_POLICY.workflow.historyImport;

const HISTORY_IMPORT_RECEIPT_SCHEMA = schemaId("history-import-receipt", 3);
const HISTORY_IMPORT_DRY_RUN_SCHEMA = schemaId("history-import-dry-run", 2);
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
  /**
   * EVERY path every tree records, with the object it names there: each (path, object) pair once, whichever
   * commits share it. Not `rev-list`'s one name per object: an object shared by two paths is printed under the
   * first name met, so a name holding an address or a secret beside a shared blob or tree would go unread.
   */
  paths: readonly Readonly<{ path: string; oid: string }>[];
}>;

function lines(output: Buffer): readonly string[] {
  return output.toString("utf8").split("\n").filter((line) => line.length > 0);
}

/** The entries of a tree object's bytes: each name, the object it names, and whether that is a tree. */
function treeEntries(bytes: Buffer, hashBytes: number): readonly Readonly<{ name: string; oid: string; tree: boolean }>[] {
  const entries: { name: string; oid: string; tree: boolean }[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    const nul = bytes.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 1 + hashBytes > bytes.length) throw new ForgeError("history_import_git_answer", "a tree object is not git's tree format");
    const mode = bytes.subarray(offset, space).toString("latin1");
    entries.push({ name: bytes.subarray(space + 1, nul).toString("utf8"), oid: bytes.subarray(nul + 1, nul + 1 + hashBytes).toString("hex"), tree: mode === "40000" });
    offset = nul + 1 + hashBytes;
  }
  return entries;
}

/**
 * Every (path, object) pair the trees of `trees` record: each tree read once, then walked from every tree no
 * other tree holds (a commit's root, a tagged tree), each (tree, folder) pair once, so the work is the trees'
 * size. A tree that is also a commit's root is walked under the folder that holds it: its names are read
 * whole inside that longer path.
 */
function treePaths(repository: GitRepository, trees: readonly HistoryObject[]): readonly Readonly<{ path: string; oid: string }>[] {
  const entries = new Map<string, readonly Readonly<{ name: string; oid: string; tree: boolean }>[]>();
  for (const batch of objectBatches(repository, trees)) {
    for (const { object, bytes } of batch) entries.set(object.oid, treeEntries(bytes, object.oid.length / 2));
  }
  const held = new Set<string>();
  for (const list of entries.values()) for (const entry of list) if (entry.tree) held.add(entry.oid);
  const pairs = new Map<string, Readonly<{ path: string; oid: string }>>();
  const walked = new Set<string>();
  const pending: [string, string][] = [...entries.keys()].filter((oid) => !held.has(oid)).map((oid) => [oid, ""]);
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [tree, folder] = next;
    for (const entry of entries.get(tree) ?? []) {
      const path = `${folder}${entry.name}`;
      pairs.set(`${path}\0${entry.oid}`, { path, oid: entry.oid });
      if (entry.tree && !walked.has(`${entry.oid}\0${path}/`)) {
        walked.add(`${entry.oid}\0${path}/`);
        pending.push([entry.oid, `${path}/`]);
      }
    }
  }
  return [...pairs.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
}

/** {@link HistoryInventory} of `repository`: `for-each-ref`, every object (`rev-list --objects --all`, typed by one `cat-file --batch-check`), and every name every tree records ({@link treePaths}). */
export function enumerateHistory(repository: GitRepository): HistoryInventory {
  const refs: Record<string, string> = {};
  for (const line of lines(gitOutput(repository, ["for-each-ref", "--format=%(objectname) %(refname)"]).stdout)) {
    const space = line.indexOf(" ");
    refs[line.slice(space + 1)] = line.slice(0, space);
  }
  const oids = lines(gitOutput(repository, ["rev-list", "--objects", "--all", "--no-object-names"]).stdout);
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
  return deepFreeze({ refs: sortedRefs, objects, paths: treePaths(repository, objects.filter((object) => object.type === "tree")) });
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

// ── Addresses (the identity gate) ────────────────────────────────────────

const IDENTITY_HEADER = /^(author|committer|tagger) (.*?) ?<([^<>\n]*)>/u;

/**
 * Every reading of `bytes` the address census searches: the strict decodes (`decodedTexts`); UTF-8 read
 * lossily when it is not valid UTF-8 (a non-ASCII address beside a stray byte is still read whole); latin1
 * only when nothing decodes (a valid UTF-8 text read as latin1 invents addresses that are not there); and
 * UTF-16LE/BE at both alignments when the bytes hold a NUL (lossy: an address in a UTF-16 run of any script
 * is still read).
 */
function addressTexts(bytes: Buffer): readonly DecodedText[] {
  const decoded = decodedTexts(bytes);
  const texts = [...decoded.texts];
  const add = (encoding: string, text: string): void => {
    if (!texts.some((one) => one.text === text)) texts.push({ encoding, text, rewritable: false });
  };
  if (!texts.some((one) => one.encoding === "utf-8")) add("utf-8-lossy", bytes.toString("utf8"));
  if (bytes.includes(0)) {
    for (const offset of [0, 1]) {
      const slice = bytes.subarray(offset, offset + Math.floor((bytes.length - offset) / 2) * 2);
      add(`utf-16le@${String(offset)}`, slice.toString("utf16le"));
      add(`utf-16be@${String(offset)}`, Buffer.from(slice).swap16().toString("utf16le"));
    }
  }
  return texts;
}

/** Where in a commit or tag object's text an offset sits: an identity header (with the name it carries), another header, or the message. */
function commitRegion(text: string, offset: number): Readonly<{ region: "identity-header" | "header" | "message"; name: string | null }> {
  const split = text.indexOf("\n\n");
  if (split >= 0 && offset > split) return { region: "message", name: null };
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const lineEnd = text.indexOf("\n", offset);
  const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
  const header = IDENTITY_HEADER.exec(line);
  if (header !== null) {
    const open = lineStart + line.indexOf("<");
    if (offset > open && offset <= open + 1 + header[3]!.length) return { region: "identity-header", name: header[2]! };
  }
  return { region: "header", name: null };
}

/** Where a KNOWN address was found: an object, a path (the object it names), or a ref name (by its digest). */
export type KnownPlace = Readonly<{ kind: "object" | "path"; oid: string }> | Readonly<{ kind: "ref"; refSha256: string }>;

/**
 * A known (mapped-from) address found in a place. `variant`: in a spelling the rewrite does not reach there
 * (another spelling, an encoded or escaped reading, more matches than the shape census read in that reading,
 * or a name, which no rewrite reaches).
 */
export type KnownOccurrence = Readonly<{ key: string; place: KnownPlace; variant: boolean }>;

/** What the address census found: every address-shaped occurrence, and every known address in any spelling. */
export type AddressCensus = Readonly<{ occurrences: readonly AddressOccurrence[]; known: readonly KnownOccurrence[] }>;

/**
 * Notes in `found` each known address one raw reading `text` holds, in it or in any reading derived from it
 * (escapes decoded, base64 runs decoded), and whether some match is a {@link KnownOccurrence} variant: a raw
 * match the shape census did not read as that address (`spans`, this reading's), or more matches in the
 * unescaped reading than every form the shape read, or a match only base64 holds outside an encoded word.
 */
function knownInReading(text: string, spans: readonly AddressSpan[], known: readonly KnownAddress[], found: Map<string, boolean>): void {
  const note = (key: string, variant: boolean): void => {
    found.set(key, (found.get(key) ?? false) || variant);
  };
  const shaped = (key: string, forms: readonly AddressSpan["form"][]): number => spans.filter((span) => forms.includes(span.form) && foldAddress(span.address) === key).length;
  for (const match of knownMatches(canonicalText(text), known)) note(match.key, match.other > 0 || match.exact > shaped(match.key, ["plain"]));
  const unescaped = unescapedText(text);
  if (unescaped !== text) {
    for (const match of knownMatches(canonicalText(unescaped), known)) note(match.key, match.other > 0 || match.exact > shaped(match.key, ["plain", "percent", "rfc2047"]));
  }
  for (const payload of base64Payloads(text)) {
    for (const reading of addressTexts(payload)) {
      for (const match of knownMatches(canonicalText(reading.text), known)) note(match.key, shaped(match.key, ["rfc2047"]) === 0);
    }
  }
}

/**
 * THE ADDRESS CENSUS of a history: every address-shaped string
 * (`addressSpans`) in every blob, commit and tag (every reading:
 * `addressTexts`), in every path a tree records, and in every ref name; each
 * with its folded key, the exact spelling, and its place (a commit or tag's
 * region; whether filter-repo rewrites that text in place). And every KNOWN
 * address (`known`: the mapped-from addresses) in any spelling, in the same
 * places. `only`, when given, limits the census to what is new since the rest
 * was judged (the receipt's): those objects, the paths that name them, and
 * those ref names. In-process; the importer runs it in a bounded child
 * ({@link runAddressCensus}).
 */
export function addressCensus(repository: GitRepository, inventory: HistoryInventory, known: readonly KnownAddress[], only?: Readonly<{ objects: ReadonlySet<string>; refs: ReadonlySet<string> }>): AddressCensus {
  const found = new Map<string, AddressOccurrence>();
  const add = (address: string, spelling: string, form: AddressOccurrence["form"], name: string | null, place: AddressPlace): void => {
    const occurrence: AddressOccurrence = { key: foldAddress(address), address, spelling, form, name, place };
    found.set(JSON.stringify([occurrence.key, spelling, place]), occurrence);
  };
  const knownFound: KnownOccurrence[] = [];
  const noteKnown = (place: KnownPlace, keys: ReadonlyMap<string, boolean>): void => {
    for (const [key, variant] of keys) knownFound.push({ key, place, variant });
  };
  const objects = inventory.objects.filter((object) => object.type !== "tree" && (only === undefined || only.objects.has(object.oid)));
  for (const batch of objectBatches(repository, objects)) {
    for (const { object, bytes } of batch) {
      const type = object.type as "blob" | "commit" | "tag";
      const nulProbe = type === "blob" && bytes.subarray(0, POLICY.binaryProbeBytes).includes(0);
      const keys = new Map<string, boolean>();
      for (const decoded of addressTexts(bytes)) {
        const spans = addressSpans(decoded.text);
        for (const span of spans) {
          const where = type === "blob" ? { region: "content" as const, name: null } : commitRegion(decoded.text, span.start);
          add(span.address, span.spelling, span.form, where.name, { kind: "object", oid: object.oid, type, region: where.region, encoding: decoded.encoding, rewritable: decoded.rewritable && !nulProbe });
        }
        if (known.length > 0) knownInReading(decoded.text, spans, known, keys);
      }
      noteKnown({ kind: "object", oid: object.oid }, keys);
    }
  }
  // A name is never rewritten: every known address in one is a variant. Each distinct path is read once.
  const byPath = new Map<string, string[]>();
  for (const { path, oid } of inventory.paths.filter((entry) => only === undefined || only.objects.has(entry.oid))) byPath.set(path, [...(byPath.get(path) ?? []), oid]);
  const nameKnown = (name: string): ReadonlyMap<string, boolean> => {
    const keys = new Map<string, boolean>();
    if (known.length > 0) knownInReading(name, [], known, keys);
    return keys;
  };
  for (const [path, oids] of byPath) {
    const spans = addressSpans(path);
    const keys = nameKnown(path);
    for (const oid of oids) {
      for (const span of spans) add(span.address, span.spelling, span.form, null, { kind: "path", oid });
      noteKnown({ kind: "path", oid }, keys);
    }
  }
  for (const ref of Object.keys(inventory.refs).filter((name) => only === undefined || only.refs.has(name))) {
    for (const span of addressSpans(ref)) add(span.address, span.spelling, span.form, null, { kind: "ref", refSha256: refDigest(ref) });
    noteKnown({ kind: "ref", refSha256: refDigest(ref) }, nameKnown(ref));
  }
  return deepFreeze({ occurrences: [...found.values()], known: knownFound });
}

/** The address census's request to its bounded child (`history-census-child.ts`), on its stdin. */
export type AddressCensusRequest = Readonly<{ repository: GitRepository; known: readonly string[]; only?: Readonly<{ objects: readonly string[]; refs: readonly string[] }> }>;

/** Runs {@link addressCensus} for `request` (the child's side): the inventory enumerated afresh, the answer as JSON. */
export function answerAddressCensus(request: AddressCensusRequest): string {
  const only = request.only === undefined ? undefined : { objects: new Set(request.only.objects), refs: new Set(request.only.refs) };
  return JSON.stringify(addressCensus(request.repository, enumerateHistory(request.repository), knownAddresses(request.known), only));
}

/** The address census's child program. */
const CENSUS_CHILD = join(dirname(fileURLToPath(import.meta.url)), "history-census-child.ts");

/**
 * THE ADDRESS CENSUS, BOUNDED: {@link addressCensus} runs in a child process under the one bounded run
 * (`runBounded`: its CPU budget, the stall check, the kernel's CPU limit, the hang backstop), never in this
 * process unbounded. The request (the known addresses) goes on its stdin and the answer comes back on its
 * stdout, held in memory only; the child prints no address anywhere else. `bounds` are the tools' (the
 * importer's policy) unless given.
 */
export async function runAddressCensus(
  repository: GitRepository,
  known: readonly string[],
  only?: Readonly<{ objects: ReadonlySet<string>; refs: ReadonlySet<string> }>,
  bounds?: SubprocessBounds,
): Promise<AddressCensus> {
  const request: AddressCensusRequest = { repository, known: [...known].sort(), ...(only === undefined ? {} : { only: { objects: [...only.objects].sort(), refs: [...only.refs].sort() } }) };
  const run = await runBounded("the address census", [process.execPath, CENSUS_CHILD], {
    cwd: repository.root, env: projectEnvironment(process.env, COMMAND_ENVIRONMENT), input: Buffer.from(JSON.stringify(request), "utf8"),
    ...(bounds === undefined ? {} : { bounds }),
  });
  try {
    return deepFreeze(JSON.parse(run.stdout) as AddressCensus);
  } catch {
    throw new ForgeError("history_import_git_answer", "the address census answered something that is not its JSON answer");
  }
}

/**
 * Writes `addresses.json` (each address by its digest, never the address, with the objects and the trees
 * whose paths carry it, and how many ref names) and refuses with `code`. The message counts and names no
 * object: an old object id that held an address confirms a guess of it, and a message is printed.
 */
function refuseAddresses(runFolder: string, found: readonly Readonly<{ key: string; place: AddressPlace | KnownPlace }>[], code: ForgeCode, message: string): never {
  const listed = addressListing(found);
  writePrivate(join(runFolder, "addresses.json"), `${JSON.stringify({ addresses: listed }, null, 2)}\n`);
  const where = occurrenceObjects(found);
  refuse(runFolder, `${message}: ${String(listed.length)} address(es) in ${String(where.objects.length)} object(s)${where.refs > 0 ? ` and ${String(where.refs)} ref name(s)` : ""} (each address by its digest, with its objects, is in addresses.json)`, code, { addresses: listed.length, objects: where.objects.length, refs: where.refs });
}

/** Each address of `found` by its digest, with the objects (and the trees whose paths) that carry it, the number of ref names, and the kinds of place. */
function addressListing(found: readonly Readonly<{ key: string; place: AddressPlace | KnownPlace }>[]): readonly Readonly<{ addressSha256: string; objects: readonly string[]; refs: number; places: readonly string[] }>[] {
  const byKey = new Map<string, Readonly<{ key: string; place: AddressPlace | KnownPlace }>[]>();
  for (const one of found) byKey.set(one.key, [...(byKey.get(one.key) ?? []), one]);
  return [...byKey].map(([key, list]) => {
    const where = occurrenceObjects(list);
    return { addressSha256: addressDigest(key), objects: where.objects, refs: where.refs, places: [...new Set(list.map(({ place }) => ("region" in place ? `${place.type}:${place.region}` : place.kind)))].sort() };
  }).sort((a, b) => (a.addressSha256 < b.addressSha256 ? -1 : 1));
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

/** Whether the NULs of `bytes` (the WHOLE content) sit at alternate positions, as in UTF-16 text without a BOM (`le`: the high byte, odd positions, is the zero one). */
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
 * EVERY TEXT `bytes` HOLD, before any matching, judged over the WHOLE
 * content (never a leading probe): the encoding a BOM names (UTF-8,
 * UTF-16LE/BE, UTF-32LE/BE), else UTF-8 when the bytes are valid UTF-8, plus
 * UTF-16LE/BE when the NULs sit at alternate positions and the bytes decode;
 * and, in every case, the printable runs written as UTF-16 ANYWHERE in the
 * bytes, both byte orders, both alignments (`utf16Runs`: a UTF-16 section
 * after 8 KiB of ASCII, or at an odd offset). Each full decode is strict;
 * nothing is guessed lossily. Bytes no full decode reads are UNDECODABLE:
 * they are still matched byte for byte (`latin1`, so an ASCII credential
 * inside a binary is seen), and the import refuses them unless a reviewed
 * exemption names the object.
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
    for (const order of ["le", "be"] as const) {
      if (!bytes.includes(0) || !looksUtf16(bytes, order)) continue;
      const text = strictDecode(bytes, order === "le" ? "utf-16le" : "utf-16be");
      if (text !== undefined) texts.push({ encoding: `utf-16${order}`, text, rewritable: false });
    }
  }
  const decoded = texts.length > 0;
  if (!decoded) texts.push({ encoding: "latin1", text: bytes.toString("latin1"), rewritable: false });
  // UTF-16 text ANYWHERE in the bytes, whatever came before it and at either byte alignment
  // (a UTF-16 section after 8 KiB of ASCII, an odd offset): its ASCII runs, read in both orders.
  // (Not when a full UTF-16/UTF-32 decode already read every character: each value would count twice.)
  const runs = texts.some((text) => text.encoding.startsWith("utf-16") || text.encoding.startsWith("utf-32")) ? [] : utf16Runs(bytes);
  if (runs.length > 0) texts.push({ encoding: "utf-16-runs", text: runs.join("\n"), rewritable: false });
  return deepFreeze({ texts, undecodable: !decoded });
}

/** The shortest UTF-16 run of printable ASCII worth reading (a credential is far longer; a stray `a\0` pair is not text). */
const UTF16_RUN_MINIMUM = 4;

/**
 * Every run of printable ASCII (tab, newline, carriage return, space to `~`)
 * written as UTF-16 anywhere in `bytes`, read as character-then-zero pairs at
 * BOTH byte alignments — which covers both byte orders, because big-endian
 * text at one alignment is little-endian text at the other (a zero, then the
 * character, is the previous pair's tail). Nothing is found in bytes with no
 * NUL.
 */
function utf16Runs(bytes: Buffer): readonly string[] {
  if (!bytes.includes(0)) return [];
  const printable = (byte: number): boolean => byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte <= 0x7e);
  const runs: string[] = [];
  for (const alignment of [0, 1]) {
    let run = "";
    for (let index = alignment; index + 1 < bytes.length; index += 2) {
      if (bytes[index + 1] === 0 && printable(bytes[index]!)) {
        run += String.fromCharCode(bytes[index]!);
        continue;
      }
      if (run.length >= UTF16_RUN_MINIMUM) runs.push(run);
      run = "";
    }
    if (run.length >= UTF16_RUN_MINIMUM) runs.push(run);
  }
  return runs;
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
  // Each distinct path once (it names its first object), whatever number of objects it names.
  const paths = new Map<string, string>();
  for (const { path, oid } of inventory.paths) if (!paths.has(path)) paths.set(path, oid);
  for (const [path, oid] of paths) {
    for (const span of catalogueSpans(path)) nameHits.push({ entry: span.entry, kind: "path", oid });
    await chunk.add(`the path of ${oid}`, Buffer.from(path, "utf8"));
  }
  for (const [ref, oid] of Object.entries(inventory.refs)) {
    for (const span of catalogueSpans(ref)) nameHits.push({ entry: span.entry, kind: "ref", oid });
    await chunk.add(`the name of a ref at ${oid}`, Buffer.from(ref, "utf8"));
  }
  await chunk.flush();
  return deepFreeze({
    catalogue: { hits, nameHits, undecodable: undecodable.sort(), scanned: { objects: scanned.length, bytes, names: paths.size + Object.keys(inventory.refs).length } },
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
  /** Address-shaped strings a person reviewed and let through (not a person's address: a placeholder, an image name), each by the sha256 of its folded form (`addressDigest`), never the address. */
  addresses: z.array(z.strictObject({ addressSha256: z.string().regex(/^[0-9a-f]{64}$/u), reason: z.string().min(1) })).optional(),
  /** Blobs the rewrite strips WHOLE (a hit it cannot rewrite in place), each acknowledged by its object id after reading `strip.json`: no file leaves the history unreviewed. */
  strips: z.array(z.strictObject({ oid: z.string().regex(GIT_OID), reason: z.string().min(1) })).optional(),
});

/** A reviewed oracle false positive: its rule, the sha256 of its value (never the value) and why it is not a secret. */
export type OracleDisposition = z.infer<typeof REVIEW>["dispositions"][number];

/** A person's reviewed decisions for one import: the oracle dispositions, the undecodable objects exempted, the address-shaped strings let through (by digest), and the blobs whose stripping is acknowledged. */
export type ImportReview = Readonly<{ dispositions: readonly OracleDisposition[]; binaries: ReadonlySet<string>; addresses: ReadonlySet<string>; strips: ReadonlySet<string>; sha256: string | null }>;

const NO_REVIEW: ImportReview = deepFreeze({ dispositions: [], binaries: new Set<string>(), addresses: new Set<string>(), strips: new Set<string>(), sha256: null });

/**
 * The review file at `path` (`history_import_review_invalid` when it is not the schema). It names what must
 * never be published (digests of secrets and of addresses), so it is refused inside `publicTree`
 * (`history_import_review_public`).
 */
export function readImportReview(path: string, publicTree: string): ImportReview {
  refuseInsidePublicTree(path, publicTree, "import review", "history_import_review_public");
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
  return Object.freeze({ dispositions: deepFreeze(checked.data.dispositions), binaries: new Set((checked.data.binaries ?? []).map((entry) => entry.oid)), addresses: new Set((checked.data.addresses ?? []).map((entry) => entry.addressSha256)), strips: new Set((checked.data.strips ?? []).map((entry) => entry.oid)), sha256: sha256(bytes) });
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
  for (const hit of hits) {
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
    ...[...anchored.keys()].sort(longestFirst).map((literal) => expression(literal, anchored.get(literal)!, hitOf((hit) => hit.anchor?.literal === literal))),
    ...[...alone.keys()].sort(longestFirst).map((value) => expression(value, alone.get(value)!, hitOf((hit) => hit.value === value))),
  ];
  return deepFreeze({
    expressions: lines.length === 0 ? "" : `${lines.join("\n")}\n`,
    expressionCount: lines.length,
    strippedBlobs: blobsStrippedFor(hits),
  });
}

/** The blobs `hits` strip whole: each holding a hit filter-repo cannot rewrite in place (`binary`), sorted. */
function blobsStrippedFor(hits: readonly CatalogueHit[]): readonly string[] {
  return [...new Set(hits.filter((hit) => hit.binary).map((hit) => hit.oid))].sort();
}

/** Writes `content` at `path`, private (0600) whatever the umask. */
function writePrivate(path: string, content: string): void {
  const written = atomicWriteFile(path, content, { requiredMode: PRIVATE_STATE_FILE_MODE });
  if (!written.success) throw new ForgeError("history_import_write_failed", `${path} could not be written: ${written.reason ?? "unknown"}`);
}

/** filter-repo's commit map (`<git dir>/filter-repo/commit-map`: a header, then `<old id> <new id>` per commit), as written. */
function readCommitMap(repository: GitRepository): string {
  const path = join(repository.root, "filter-repo", "commit-map");
  return existsSync(path) ? readFileSync(path, "utf8") : "old new\n";
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

/**
 * THE PUBLISHED RECEIPT: what the import did, in counts and public facts only. It is pushed with the
 * history, so it holds nothing that confirms a guess of what the rewrite removed: no id of an object before
 * the rewrite (a commit's old id is the hash of its old text, so with the public rewritten commit it would
 * confirm a guessed address), no digest of the mapping, the review or the expressions, no stripped blob's id
 * (its id is the hash of its content). Those are in the PRIVATE record beside it in the run folder
 * ({@link HistoryImportRecord}), never published.
 */
export type HistoryImportReceipt = Readonly<{
  schema: typeof HISTORY_IMPORT_RECEIPT_SCHEMA;
  id: string;
  importedAt: string;
  /** Where the history came from and went: a URL as given (never with credentials), or `local:<folder name>` (never an absolute path). */
  source: string;
  target: string;
  before: Readonly<{ refs: number; objects: Readonly<Record<HistoryObjectType, number>>; scannedBytes: number }>;
  findings: Readonly<{
    catalogue: Readonly<Record<string, number>>;
    oracle: Readonly<{ covered: Readonly<Record<string, number>>; disposed: Readonly<Record<string, number>> }>;
    review: Readonly<{ dispositions: number; binaries: number; addresses: number; strips: number }>;
  }>;
  purge: Readonly<{ expressions: number; strippedBlobs: number }>;
  /** After the purge: no catalogue hit and no oracle finding left, except the reviewed dispositions (counted per rule); the exempted undecodable objects. */
  after: Readonly<{ objects: Readonly<Record<HistoryObjectType, number>>; catalogueHits: 0; oracleGaps: 0; oracleDisposed: Readonly<Record<string, number>>; undecodableExempted: number }>;
  /** The refs as published (their new ids: public, they are pushed). */
  refMap: readonly RefMapping[];
  /** The identity gate, in counts: the allowed list's digest (the list is public: it is what is published). */
  identities: Readonly<{
    allowedSha256: string;
    /** Distinct unallowed addresses the census found, how many the review disposed and how many the mapping rewrote. */
    unallowedAddresses: number;
    disposedAddresses: number;
    mappedAddresses: number;
    /** Objects the mapping rewrote, blobs stripped whole because no rewrite reaches their occurrence in place, and commits the rewrite gave a new id. */
    rewrittenObjects: number;
    strippedBlobs: number;
    changedCommits: number;
  }>;
  tools: Readonly<{
    git: string;
    python: string;
    gitleaks: Readonly<{ version: string; sha256: string }>;
    filterRepo: Readonly<{ version: string; sha256: string }>;
    oracleConfigSha256: string;
    catalogueSha256: string;
  }>;
}>;

/**
 * THE PRIVATE RECORD of an import (`record.json` in its run folder, 0600, never published): the published
 * receipt, and what it must not carry: the refs before the rewrite, filter-repo's first changed commits, the
 * stripped blobs (with their paths), and the digests of the mapping, the review and the expressions. The
 * rewrite's commit map (old id, new id) is `commit-map` beside it.
 */
export type HistoryImportRecord = Readonly<{
  receipt: HistoryImportReceipt;
  beforeRefs: Readonly<Record<string, string>>;
  firstChangedCommits: readonly string[];
  strippedBlobs: readonly Readonly<{ oid: string; paths: readonly string[] }>[];
  mapSha256: string | null;
  reviewSha256: string | null;
  expressionsSha256: string;
  commitMapSha256: string;
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
  /** Where the history goes: required unless this is a dry run. */
  target?: string | undefined;
  /** The ONE declared identity mapping (a mailmap-style file outside the public tree), or none. */
  identityMap?: string | undefined;
  /** Scan and count only: nothing is rewritten or pushed. */
  dryRun?: boolean | undefined;
  /** A reviewed decisions file (`IMPORT_REVIEW_SCHEMA`: oracle dispositions, exempted undecodable objects), or none. */
  review?: string | undefined;
}>;

export type HistoryImportOptions = Readonly<{
  /** The admitted import home ({@link admitImportHome}). */
  home: string;
  /** The git executable. */
  git: string;
  /** The ONE allowed-identity list (`forge.historyImport.allowedIdentities`). */
  allowedIdentities: readonly string[];
  /** The public tree (the harness checkout): the identity mapping is refused inside it. */
  publicTree: string;
  onProgress?: (line: string) => void;
}>;

/**
 * What a dry run answers: COUNTS only (never a value, never an address, never an object id: an old id that
 * held an address confirms a guess of it, and an answer is printed). What a person needs to act on each count
 * is in the private run folder: `addresses.json` (each unresolved or unreachable address by its digest, with
 * its objects) and `strip.json` (each blob the rewrite would strip whole, with its paths).
 */
export type HistoryImportDryRun = Readonly<{
  schema: typeof HISTORY_IMPORT_DRY_RUN_SCHEMA;
  id: string;
  source: string;
  refs: number;
  objects: Readonly<Record<HistoryObjectType, number>>;
  catalogue: Readonly<Record<string, number>>;
  namesHoldingSecrets: number;
  oracleGaps: number;
  undecodableUnreviewed: number;
  /**
   * The address gate's counts: distinct unallowed addresses (and how many are disposed, mapped, or resolved by
   * nothing), the objects carrying an address that needs the mapping, the objects and ref names carrying an
   * unresolved one, and the places (objects, paths, ref names) holding a mapped-from address in a spelling the
   * rewrite cannot reach.
   */
  identities: Readonly<{
    unallowedAddresses: number;
    disposedAddresses: number;
    mappedAddresses: number;
    unresolvedAddresses: number;
    needingMapping: number;
    unresolvedObjects: number;
    unresolvedRefs: number;
    unreachablePlaces: number;
  }>;
  /** The blobs the rewrite would strip whole, and how many of them no review acknowledges yet. */
  strip: Readonly<{ blobs: number; unreviewed: number }>;
}>;

/** The dry run's identity counts. */
function dryRunIdentities(addresses: readonly AddressOccurrence[], judgement: AddressJudgement, unreachable: readonly KnownOccurrence[]): HistoryImportDryRun["identities"] {
  const needing = occurrenceObjects(judgement.needing.filter((occurrence) => judgement.mapped.has(occurrence.key)));
  const unresolved = occurrenceObjects(addresses.filter((occurrence) => judgement.unresolved.has(occurrence.key)));
  return {
    unallowedAddresses: judgement.unallowed.size,
    disposedAddresses: judgement.disposed.size,
    mappedAddresses: judgement.mapped.size,
    unresolvedAddresses: judgement.unresolved.size,
    needingMapping: needing.objects.length,
    unresolvedObjects: unresolved.objects.length,
    unresolvedRefs: unresolved.refs,
    unreachablePlaces: unreachable.length,
  };
}

/** Why a blob is stripped whole: a secret, or a mapped address, the rewrite cannot replace in place. */
type StripReason = "secret" | "address";

/** Each blob the rewrite strips whole, with why. */
function stripPlan(secrets: readonly string[], addresses: readonly string[]): ReadonlyMap<string, readonly StripReason[]> {
  const plan = new Map<string, StripReason[]>();
  for (const oid of secrets) plan.set(oid, [...(plan.get(oid) ?? []), "secret"]);
  for (const oid of addresses) plan.set(oid, [...(plan.get(oid) ?? []), "address"]);
  return new Map([...plan].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** The paths that name each object of `inventory`. */
function pathsByObject(inventory: HistoryInventory): ReadonlyMap<string, readonly string[]> {
  const named = new Map<string, string[]>();
  for (const { path, oid } of inventory.paths) named.set(oid, [...(named.get(oid) ?? []), path]);
  return named;
}

/**
 * Writes `strip.json` (private): each blob the rewrite strips whole, with its size, its paths, why, and
 * whether the review acknowledges it (`strips`, by id). Answers how many no review acknowledges: NOTHING IS
 * STRIPPED SILENTLY, so the import refuses until each is (`history_import_strip_unreviewed`).
 */
function writeStripListing(runFolder: string, inventory: HistoryInventory, plan: ReadonlyMap<string, readonly StripReason[]>, review: ImportReview): number {
  const named = pathsByObject(inventory);
  const sizes = new Map(inventory.objects.map((object) => [object.oid, object.size]));
  const strip = [...plan].map(([oid, why]) => ({ oid, size: sizes.get(oid), paths: named.get(oid) ?? [], why, acknowledged: review.strips.has(oid) }));
  writePrivate(join(runFolder, "strip.json"), `${JSON.stringify({ strip }, null, 2)}\n`);
  return strip.filter((blob) => !blob.acknowledged).length;
}

/** The KNOWN addresses of an import: every address the mapping maps from (folded), unless it is allowed or disposed (then it may be published, and is not searched). */
function mappedFromAddresses(map: IdentityMap | undefined, allowed: ReadonlySet<string>, review: ImportReview): readonly string[] {
  return [...new Set((map?.entries ?? []).map((entry) => foldAddress(entry.commitAddress)))]
    .filter((key) => !allowed.has(key) && !review.addresses.has(sha256(key))).sort();
}

/**
 * Refuses (`history_import_undecodable`) when `scan` holds an undecodable
 * object the review does not exempt by id, writing each one's id, type,
 * size and paths, with `stage`, to `undecodable.json` in the run folder:
 * what a reviewer needs to exempt it, never its content.
 */
function refuseUnreviewedUndecodable(runFolder: string, inventory: HistoryInventory, scan: CatalogueScan, review: ImportReview, stage: string): void {
  const unreviewed = scan.undecodable.filter((oid) => !review.binaries.has(oid));
  if (unreviewed.length === 0) return;
  const named = pathsByObject(inventory);
  const objects = new Map(inventory.objects.map((object) => [object.oid, object]));
  const note = "an exempted object's bytes enter the forge as they are: the secret scan and the address gate read only their raw readings (a compressed member, such as a gzip or zip entry, is not decompressed), so review its content before exempting it";
  writePrivate(join(runFolder, "undecodable.json"), `${JSON.stringify({ stage, note, undecodable: unreviewed.map((oid) => ({ oid, type: objects.get(oid)?.type, size: objects.get(oid)?.size, paths: named.get(oid) ?? [] })) }, null, 2)}\n`);
  refuse(runFolder, `${String(unreviewed.length)} object(s) ${stage} no encoding decodes (UTF-8, UTF-16, UTF-32, by BOM or by shape) and no review exempts; they are listed with their ids and paths in undecodable.json`, "history_import_undecodable", { undecodable: unreviewed.length, stage });
}

/** A refusal that leaves the run folder for inspection (it holds the mirror and the values: private). */
function refuse(runFolder: string, message: string, code: ForgeCode, details: ForgeFacts = {}): never {
  throw new ForgeError(code, `${message} (the run folder ${runFolder} is kept for inspection; it is private and holds secret values)`, { runFolder, ...details });
}

/**
 * THE IMPORT (see the header): mirror, enumerate, scan twice, purge, re-scan
 * to zero, record the receipt, push. Answers the receipt; on success the run
 * folder keeps the private record (`record.json`, `commit-map`); the mirror and the values are removed.
 */
export async function importHistory(request: HistoryImportRequest & Readonly<{ dryRun: true }>, options: HistoryImportOptions): Promise<HistoryImportDryRun>;
export async function importHistory(request: HistoryImportRequest, options: HistoryImportOptions): Promise<HistoryImportReceipt>;
export async function importHistory(request: HistoryImportRequest, options: HistoryImportOptions): Promise<HistoryImportReceipt | HistoryImportDryRun> {
  refuseCredentialedLocation(request.source, "source");
  if (request.target !== undefined) refuseCredentialedLocation(request.target, "target");
  else if (request.dryRun !== true) throw new ForgeError("history_import_usage", "a target is required unless this is a dry run");
  const allowed = allowedAddresses(options.allowedIdentities);
  const identityMap = request.identityMap === undefined ? undefined : readIdentityMap(request.identityMap, options.publicTree);
  const gitleaks = resolveHistoryTool(options.home, "gitleaks");
  const filterRepo = resolveHistoryTool(options.home, "git-filter-repo");
  const review = request.review === undefined ? NO_REVIEW : readImportReview(request.review, options.publicTree);
  const id = `${new Date().toISOString().replace(/[-:]/gu, "").replace(/\.\d+Z$/u, "Z")}-${Buffer.from(randomBytes(4)).toString("hex")}`;
  // Each step: an info record (the run and the step; never a value) and the caller's progress line.
  const progress = (step: string): void => {
    debugLog(FORGE_LOG_CATEGORY, "info", "history_import_step", () => ({ run: id, step }));
    options.onProgress?.(`import ${id}: ${step}`);
  };
  const runFolder = ensurePrivateStateDirectory(join(options.home, POLICY.runsFolder, id));
  const at = (root: string): GitRepository => deepFreeze({ root, executable: options.git, timeoutMs: POLICY.gitCallCeilingMs });
  const run = at(runFolder);

  const target = request.target;
  if (target !== undefined) {
    const occupied = remoteRefs(run, target);
    if (Object.keys(occupied).length > 0) {
      refuse(runFolder, `${target} already holds ${String(Object.keys(occupied).length)} ref(s); the importer writes only into an empty repository (a published history is never rewritten)`, "history_import_target_not_empty");
    }
  }

  progress("mirroring the source");
  const mirrorPath = join(runFolder, "mirror.git");
  gitOutput(run, ["clone", "--mirror", "--no-local", "--quiet", "--", request.source, mirrorPath]);
  const mirror = at(mirrorPath);

  progress("enumerating and scanning (the catalogue and the oracle)");
  const before = enumerateHistory(mirror);
  if (Object.keys(before.refs).length === 0) refuse(runFolder, `${request.source} holds no ref; there is nothing to import`, "history_import_source_empty");
  const mappings = planRefs(before.refs);
  progress("judging every address (every object in every reading, every path, every ref name)");
  const known = mappedFromAddresses(identityMap, allowed, review);
  const census = await runAddressCensus(mirror, known);
  const addresses = census.occurrences;
  const addressJudgement = judgeAddresses(addresses, allowed, review.addresses, identityMap);
  const oracle = gitleaksOracle(gitleaks, runFolder);
  const both = await scanHistory(mirror, before, oracle);
  const scan = both.catalogue;
  // The mapped addresses ride the one rewrite: a generated mailmap (exact spellings) for the identity headers,
  // literal expressions for every exact spelling in text filter-repo rewrites in place, and the blobs it cannot
  // rewrite stripped whole (each acknowledged). A mapped-from address in a spelling none of that reaches is
  // UNREACHABLE: refused now, and the census after the rewrite refuses whatever is left.
  const addressRewrite = planAddressRewrite(addressJudgement.needing, allowed, identityMap);
  const strips = stripPlan(blobsStrippedFor(scan.hits), addressRewrite.strippedBlobs);
  const unreachable = census.known.filter((one) => one.variant && !(one.place.kind === "object" && strips.has(one.place.oid)));
  const unresolved = addresses.filter((occurrence) => addressJudgement.unresolved.has(occurrence.key));
  if (request.dryRun === true) {
    const values = [...new Set(scan.hits.map((hit) => hit.value))];
    writePrivate(join(runFolder, "addresses.json"), `${JSON.stringify({ addresses: addressListing(unresolved), unreachable: addressListing(unreachable) }, null, 2)}\n`);
    const report: HistoryImportDryRun = deepFreeze({
      schema: HISTORY_IMPORT_DRY_RUN_SCHEMA,
      id,
      source: recordedLocation(request.source),
      refs: Object.keys(before.refs).length,
      objects: objectCounts(before),
      catalogue: countByEntry(scan.hits),
      namesHoldingSecrets: scan.nameHits.length,
      oracleGaps: judgeOracle(both.oracle, values, review.dispositions).gaps.length,
      undecodableUnreviewed: scan.undecodable.filter((oid) => !review.binaries.has(oid)).length,
      identities: dryRunIdentities(addresses, addressJudgement, unreachable),
      strip: { blobs: strips.size, unreviewed: writeStripListing(runFolder, before, strips, review) },
    });
    writePrivate(join(runFolder, "dry-run.json"), `${canonicalJson(report)}\n`);
    for (const entry of ["mirror.git", "gitleaks.toml"]) rmSync(join(runFolder, entry), { recursive: true, force: true });
    progress(`dry run done: ${String(report.identities.unallowedAddresses)} unallowed address(es) (${String(report.identities.mappedAddresses)} mapped, ${String(report.identities.disposedAddresses)} disposed, ${String(report.identities.unresolvedAddresses)} unresolved) in ${String(report.identities.needingMapping)} object(s) needing the mapping; ${String(report.identities.unreachablePlaces)} place(s) holding a mapped-from address the rewrite cannot reach; ${String(report.strip.blobs)} blob(s) to strip whole (${String(report.strip.unreviewed)} unacknowledged, listed in strip.json); ${String(scan.hits.length)} catalogue hit(s)`);
    return report;
  }
  if (unresolved.length > 0) {
    refuseAddresses(runFolder, unresolved, "history_import_identity_unallowed",
      `addresses not on the allowed identities (forge.historyImport.allowedIdentities), not mapped to one${identityMap === undefined ? " (no --identity-map was given)" : ""} and not disposed in the review`);
  }
  if (unreachable.length > 0) {
    refuseAddresses(runFolder, unreachable, "history_import_identity_unreachable",
      "a mapped-from address is written where the rewrite cannot reach it (escaped, encoded, obfuscated, split over a line, in another spelling, or in a name); remove it from the source, or dispose of the address in the review");
  }
  if (scan.nameHits.length > 0) {
    refuse(runFolder, `${String(scan.nameHits.length)} name(s) hold a secret (${Object.entries(countByEntry(scan.nameHits)).map(([entry, count]) => `${entry}: ${String(count)}`).join(", ")}; objects ${[...new Set(scan.nameHits.map((hit) => hit.oid))].slice(0, POLICY.refusalObjectsNamed).join(", ")}); rename them in the source first`, "history_import_secret_in_name");
  }

  refuseUnreviewedUndecodable(runFolder, before, scan, review, "before the rewrite");
  const values = [...new Set(scan.hits.map((hit) => hit.value))];
  const judgement = judgeOracle(both.oracle, values, review.dispositions);
  if (judgement.gaps.length > 0) {
    // What a reviewer needs to judge each gap, and nothing a reader could use: the rule, the object, the value's digest.
    writePrivate(join(runFolder, "oracle-gaps.json"), `${JSON.stringify({ gaps: judgement.gaps }, null, 2)}\n`);
    const rules = countByEntry(judgement.gaps.map((gap) => ({ entry: `${gap.rule} (${gap.kind})` })));
    refuse(runFolder, `the oracle found ${String(judgement.gaps.length)} secret(s) no catalogue hit contains: ${Object.entries(rules).map(([rule, count]) => `${rule}: ${String(count)}`).join(", ")} (first in ${judgement.gaps[0]!.location}; every gap, with its rule, object and value sha256, is in oracle-gaps.json). Add a catalogue row (or widen the row) for a real format, or record a reviewed disposition (that rule and sha256, with the reason) for a false positive`, "history_import_catalogue_gap", { gaps: judgement.gaps.length });
  }
  const unacknowledged = writeStripListing(runFolder, before, strips, review);
  if (unacknowledged > 0) {
    refuse(runFolder, `${String(unacknowledged)} of the ${String(strips.size)} blob(s) the rewrite would strip whole (a secret or a mapped address it cannot replace in place: UTF-16, a NUL in the first bytes) are not acknowledged; read each one's paths in strip.json and acknowledge it by id in the review's "strips", or fix the source`, "history_import_strip_unreviewed", { strip: strips.size, unacknowledged });
  }

  progress(`purging ${String(scan.hits.length)} hit(s) and stripping ${String(strips.size)} acknowledged blob(s)`);
  const plan = planPurge(scan.hits);
  const expressionsPath = join(runFolder, "purge-expressions");
  writePrivate(expressionsPath, `${plan.expressions}${addressRewrite.expressions}`);
  const mailmapPath = join(runFolder, "identity-mailmap");
  if (addressRewrite.mailmap.length > 0) writePrivate(mailmapPath, addressRewrite.mailmap);
  const strippedBlobs = [...strips.keys()];
  const stripPath = join(runFolder, "strip-blob-ids");
  writePrivate(stripPath, strippedBlobs.map((oid) => `${oid}\n`).join(""));
  await runHistoryTool(filterRepo, [
    "--sensitive-data-removal", "--replace-text", expressionsPath, "--replace-message", expressionsPath,
    ...(strippedBlobs.length > 0 ? ["--strip-blobs-with-ids", stripPath] : []),
    ...(addressRewrite.mailmap.length > 0 ? ["--mailmap", mailmapPath] : []),
  ], { cwd: mirrorPath, env: projectEnvironment(process.env, GIT_NETWORK_ENVIRONMENT) });

  progress("re-scanning to zero");
  const after = enumerateHistory(mirror);
  const rescanned = await scanHistory(mirror, after, oracle);
  const residue = purgeResidue(rescanned, review);
  if (Object.keys(residue.left).length > 0) {
    refuse(runFolder, `the purged history still holds secrets: ${Object.entries(residue.left).map(([entry, count]) => `${entry}: ${String(count)}`).join(", ")}`, "history_import_residue");
  }
  // The rewrite gives a commit or tag a new id whenever anything it reaches changed: an undecodable one the
  // review exempted by its old id is a NEW object to review (listed, with the stage, in undecodable.json).
  refuseUnreviewedUndecodable(runFolder, after, rescanned.catalogue, review, "after the rewrite");
  // THE SAME CENSUS over the rewritten history: every address allowed or disposed, and no mapped-from address
  // in ANY spelling, anywhere; anything the rewrite did not reach is refused.
  progress("judging every address again (the rewritten history)");
  const afterCensus = await runAddressCensus(mirror, known);
  const leftAfter = addressesLeft(afterCensus, allowed, review);
  if (leftAfter.length > 0) {
    refuseAddresses(runFolder, leftAfter, "history_import_identity_residue", "the rewritten history still carries addresses not on the allowed identities, or a mapped-from address in some spelling (in a place no rewrite reaches: a path, a ref name, a header other than an identity, an encoding it does not rewrite in place; rename them in the source, or dispose of them in the review)");
  }
  // The rewrite's own record of every commit's old and new id: PRIVATE (an old id confirms a guessed address).
  const commitMapText = readCommitMap(mirror);
  writePrivate(join(runFolder, "commit-map"), commitMapText);

  const afterMappings = planRefs(after.refs);
  const receipt: HistoryImportReceipt = deepFreeze({
    schema: HISTORY_IMPORT_RECEIPT_SCHEMA,
    id,
    importedAt: new Date().toISOString(),
    source: recordedLocation(request.source),
    target: recordedLocation(target!),
    before: { refs: Object.keys(before.refs).length, objects: objectCounts(before), scannedBytes: scan.scanned.bytes },
    findings: {
      catalogue: countByEntry(scan.hits),
      oracle: { covered: judgement.covered, disposed: judgement.disposed },
      review: { dispositions: review.dispositions.length, binaries: review.binaries.size, addresses: review.addresses.size, strips: review.strips.size },
    },
    purge: { expressions: plan.expressionCount, strippedBlobs: strippedBlobs.length },
    after: { objects: objectCounts(after), catalogueHits: 0, oracleGaps: 0, oracleDisposed: residue.disposed, undecodableExempted: rescanned.catalogue.undecodable.length },
    refMap: afterMappings,
    identities: {
      allowedSha256: sha256([...allowed].sort().join("\n")),
      unallowedAddresses: addressJudgement.unallowed.size,
      disposedAddresses: addressJudgement.disposed.size,
      mappedAddresses: addressJudgement.mapped.size,
      rewrittenObjects: addressRewrite.rewrittenObjects,
      strippedBlobs: addressRewrite.strippedBlobs.length,
      changedCommits: commitMapText.split("\n").slice(1).filter((line) => { const [old, now] = line.split(" "); return old !== undefined && now !== undefined && old !== now; }).length,
    },
    tools: {
      git: gitOutput(run, ["--version"]).stdout.toString("utf8").trim(),
      python: await hostProgramVersion("python3", projectEnvironment(process.env, COMMAND_ENVIRONMENT)),
      gitleaks: { version: gitleaks.pin.version, sha256: gitleaks.pin.sha256 },
      filterRepo: { version: filterRepo.pin.version, sha256: filterRepo.pin.sha256 },
      oracleConfigSha256: sha256(gitleaksConfigText()),
      catalogueSha256: catalogueDigest(),
    },
  });
  const named = pathsByObject(before);
  const record: HistoryImportRecord = deepFreeze({
    receipt,
    beforeRefs: before.refs,
    firstChangedCommits: firstChangedCommits(mirror),
    strippedBlobs: strippedBlobs.map((oid) => ({ oid, paths: named.get(oid) ?? [] })),
    mapSha256: identityMap?.sha256 ?? null,
    reviewSha256: review.sha256,
    expressionsSha256: sha256(`${plan.expressions}${addressRewrite.expressions}`),
    commitMapSha256: sha256(commitMapText),
  });
  const refNames = (refs: readonly RefMapping[]): string => refs.map((ref) => ref.target).join("\n");
  if (refNames(mappings) !== refNames(afterMappings)) {
    refuse(runFolder, `the rewrite changed the set of refs (${String(mappings.length)} before, ${String(afterMappings.length)} after)`, "history_import_refs_changed");
  }

  const unsafe = receiptRefusal(receipt);
  if (unsafe !== undefined) refuse(runFolder, `the receipt cannot be pushed: ${unsafe}`, "history_import_receipt_unsafe");
  progress(`recording the receipt and pushing ${String(afterMappings.length + 1)} ref(s)`);
  const receiptCommit = recordReceipt(mirror, receipt, runFolder);
  // The receipt is published too: its commit, its tree and its blob, and its ref name pass the same census.
  const withReceipt = enumerateHistory(mirror);
  const judged = new Set(after.objects.map((object) => object.oid));
  const receiptCensus = await runAddressCensus(mirror, known, {
    objects: new Set(withReceipt.objects.map((object) => object.oid).filter((oid) => !judged.has(oid))),
    refs: new Set(Object.keys(withReceipt.refs).filter((ref) => !(ref in after.refs))),
  });
  const leftReceipt = addressesLeft(receiptCensus, allowed, review);
  if (leftReceipt.length > 0) {
    refuseAddresses(runFolder, leftReceipt, "history_import_identity_residue", "the receipt carries addresses not on the allowed identities (the receipt commit's identity is historyImport.identity in the root policy)");
  }
  pushHistory(mirror, target!, [...afterMappings, { source: POLICY.receipt.ref, target: POLICY.receipt.ref, oid: receiptCommit }]);

  writePrivate(join(runFolder, "record.json"), `${canonicalJson(record)}\n`);
  for (const entry of ["mirror.git", "purge-expressions", "strip-blob-ids", "gitleaks.toml", "identity-mailmap"]) {
    rmSync(join(runFolder, entry), { recursive: true, force: true });
  }
  progress(`done (${String(scan.hits.length)} hit(s) purged, receipt on ${POLICY.receipt.ref}; the private record is record.json in the run folder)`);
  return receipt;
}

/** What a census after the rewrite leaves: every address neither allowed nor disposed, and every mapped-from address in any spelling. */
function addressesLeft(census: AddressCensus, allowed: ReadonlySet<string>, review: ImportReview): readonly Readonly<{ key: string; place: AddressPlace | KnownPlace }>[] {
  return [
    ...census.occurrences.filter((occurrence) => !allowed.has(occurrence.key) && !review.addresses.has(addressDigest(occurrence.key))),
    ...census.known,
  ];
}
