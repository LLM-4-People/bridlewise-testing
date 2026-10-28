/**
 * THE HISTORY IMPORTER'S ADDRESS GATE: no address leaves the host unless it
 * is ALLOWED, or a person reviewed it.
 *
 * A history can carry a person's own address anywhere a byte is published:
 * a commit's author or committer, a tag's tagger, a header continuation, a
 * trailer in any shape (indented, bare, with a comment, CRLF), free text in a
 * message, a note, a file's content in any encoding, a path, a ref name. So
 * the gate judges EVERY published byte, the way the secret oracle does: every
 * ADDRESS-SHAPED string ({@link addressSpans}: plain, percent-encoded, or in
 * an RFC 2047 encoded word; found from its `@`, bounded, so a text costs its
 * length) in every object, in every reading of it, in every path (every
 * name every tree records) and in every ref name, compared under the ONE
 * Unicode case fold (`unicodeCaseFold`, after NFKC) against the ONE allowed
 * list (`forge.historyImport.allowedIdentities`). An address not on it must
 * be:
 *
 * - MAPPED by the ONE identity mapping (a mailmap-style file kept outside the
 *   public tree, since it holds the address it replaces), which the importer
 *   applies itself in its one rewrite; or
 * - DISPOSED by a reviewed disposition (the review file's `addresses`: the
 *   folded address's sha256 and the reason, never the address), kept outside
 *   the public tree as well.
 *
 * A MAPPED-FROM address is KNOWN, so it is also searched as that value in
 * every spelling a reader would recognise ({@link knownAddresses}: escapes,
 * entities, quoted-printable, base64, compatibility forms, `[at]`/`[dot]`,
 * a folded line, a quoted local part): one the rewrite cannot reach is
 * refused, before the rewrite and again after it. The shape stays the
 * defence in depth for every address nobody named.
 *
 * Anything else is refused before anything is rewritten or pushed, naming
 * objects by id (never an address), and the rewritten history, and the
 * receipt, are judged again by the same census before the push.
 *
 * This module holds the pure parts: the address shapes, the fold, the
 * mapping file and the judgement. The importer (history-import.ts) reads
 * the objects, the paths and the ref names, and runs the rewrite.
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { decodeHtmlEntities } from "../../../../shared/markup.ts";
import { deepFreeze, sha256 } from "../../kernel/integrity.ts";
import { pathHasSecondName } from "../../filesystem/link-containment.ts";
import { unicodeCaseFold } from "../../repository-path/index.ts";
import { ForgeError, type ForgeCode } from "./codes.ts";

/** An address as it is compared: NFKC (a compatibility form, such as the Kelvin sign, is its letter), then the one Unicode case fold, then NFKC again. */
export function foldAddress(address: string): string {
  return unicodeCaseFold(address.trim().normalize("NFKC")).normalize("NFKC");
}

/** The digest a reviewed disposition names an address by (of its folded form): never the address itself. */
export function addressDigest(address: string): string {
  return sha256(foldAddress(address));
}

/** The comparator every generated filter-repo list is sorted by: longest first (a text contained in another is replaced after it), then by text. */
export function longestFirst(a: string, b: string): number {
  return b.length - a.length || (a < b ? -1 : a > b ? 1 : 0);
}

// THE SHAPE, BOUNDED: an address is found from its `@` outwards, never by a pattern that may start anywhere
// (an unbounded run before `@` made a long line of letters cost the square of its length). The local part
// is at most 64 characters, a label at most 63 and the domain at most 253 (RFC 5321's limits), so each `@`
// costs a bounded amount of work and a text costs its length.
const LOCAL_MAX = 64;
const DOMAIN_MAX = 253;
const LOCAL_CHARACTER = /^[\p{L}\p{N}\p{M}._+\-]$/u;
const LABEL = "[\\p{L}\\p{N}\\p{M}](?:[\\p{L}\\p{N}\\p{M}\\-]{0,61}[\\p{L}\\p{N}\\p{M}])?";
/** A domain of at least two labels, read from just after an `@` (sticky). */
const DOMAIN = new RegExp(`${LABEL}(?:\\.${LABEL}){1,126}`, "uy");
const DOMAIN_WHOLE = new RegExp(`^${LABEL}(?:\\.${LABEL}){1,126}$`, "u");
/** An RFC 2047 encoded word (`=?charset?Q|B?text?=`), bounded (a word is at most 75 characters; the bounds are generous). */
const ENCODED_WORD = /=\?([^?\s]{1,64})\?([QqBb])\?([^?\s]{0,2048})\?=/gu;

/** Where the run of `accepts` characters that ends at `end` starts, at most `most` code points back. */
function runStart(text: string, end: number, accepts: RegExp, most: number): number {
  let start = end;
  for (let taken = 0; start > 0 && taken < most; taken += 1) {
    let previous = start - 1;
    const low = text.charCodeAt(previous);
    if (low >= 0xdc00 && low <= 0xdfff && previous > 0) {
      const high = text.charCodeAt(previous - 1);
      if (high >= 0xd800 && high <= 0xdbff) previous -= 1;
    }
    if (!accepts.test(text.slice(previous, start))) break;
    start = previous;
  }
  return start;
}

/** Whether `address` is address-shaped as a whole (a mapping's addresses must be). */
function addressShaped(address: string): boolean {
  const at = address.lastIndexOf("@");
  if (at <= 0 || runStart(address, at, LOCAL_CHARACTER, LOCAL_MAX) !== 0) return false;
  const domain = address.slice(at + 1);
  return domain.length <= DOMAIN_MAX && DOMAIN_WHOLE.test(domain);
}

/** Every plain address in `text`, each read from an `@`: the local part before it, the domain after it. */
function plainAddresses(text: string): readonly Readonly<{ address: string; start: number; end: number }>[] {
  const found: { address: string; start: number; end: number }[] = [];
  for (let at = text.indexOf("@"); at >= 0; at = text.indexOf("@", at + 1)) {
    const start = runStart(text, at, LOCAL_CHARACTER, LOCAL_MAX);
    if (start === at) continue;
    DOMAIN.lastIndex = at + 1;
    const domain = DOMAIN.exec(text);
    if (domain === null) continue;
    found.push({ address: text.slice(start, at + 1 + domain[0].length), start, end: at + 1 + domain[0].length });
  }
  return found;
}

/** One address-shaped string in a text: the address it names, the exact spelling it was found in, where, and in which form. */
export type AddressSpan = Readonly<{ address: string; spelling: string; start: number; end: number; form: "plain" | "percent" | "rfc2047" }>;

/**
 * A run of percent-encodable characters decoded (`%XX` as UTF-8 bytes; an invalid sequence is U+FFFD per
 * byte), with where each decoded UTF-16 unit starts in the run (and the run's length last), so an address
 * found in the decoded text is replaced by its exact encoded spelling.
 */
function percentDecodedRun(run: string): Readonly<{ decoded: string; from: readonly number[] }> {
  let decoded = "";
  const from: number[] = [];
  let bytes: { byte: number; at: number }[] = [];
  const emit = (text: string, at: number): void => {
    for (let unit = 0; unit < text.length; unit += 1) from.push(at);
    decoded += text;
  };
  const flush = (): void => {
    for (let index = 0; index < bytes.length;) {
      const { byte, at } = bytes[index]!;
      const length = byte < 0x80 ? 1 : byte >= 0xf0 && byte <= 0xf7 ? 4 : byte >= 0xe0 && byte <= 0xef ? 3 : byte >= 0xc0 && byte <= 0xdf ? 2 : 0;
      let text = "\ufffd";
      if (length === 1) text = String.fromCharCode(byte);
      else if (length > 1 && index + length <= bytes.length) {
        // A sequence is valid when it decodes to ONE code point that is not the replacement character.
        const sequence = new TextDecoder("utf-8").decode(Buffer.from(bytes.slice(index, index + length).map((one) => one.byte)));
        if ([...sequence].length === 1 && sequence !== "\ufffd") text = sequence;
      }
      emit(text, at);
      index += text === "\ufffd" ? 1 : length;
    }
    bytes = [];
  };
  for (let index = 0; index < run.length; index += 1) {
    if (run[index] === "%" && /^[0-9A-Fa-f]{2}$/u.test(run.slice(index + 1, index + 3))) {
      bytes.push({ byte: Number.parseInt(run.slice(index + 1, index + 3), 16), at: index });
      index += 2;
    } else {
      flush();
      emit(run[index]!, index);
    }
  }
  flush();
  from.push(run.length);
  return { decoded, from };
}

/** A run of characters a percent-encoded address may be written in (any byte may be `%XX`). */
const PERCENT_RUN = /[\p{L}\p{N}\p{M}._+\-%]+/gu;

/** An RFC 2047 word's text decoded (Q or B) in its charset (UTF-8 or latin1; any other charset is read as latin1, so an ASCII address is still seen). */
function encodedWordText(charset: string, encoding: string, payload: string): string {
  const bytes = encoding.toUpperCase() === "B"
    ? Buffer.from(payload, "base64")
    : Buffer.from(payload.replace(/_/gu, " ").replace(/=([0-9A-Fa-f]{2})/gu, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))), "latin1");
  if (/^utf-?8$/iu.test(charset)) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return bytes.toString("latin1");
    }
  }
  return bytes.toString("latin1");
}

/** Every address-shaped string in `text`: plain, percent-encoded, and inside RFC 2047 encoded words. Linear in the text's length. */
export function addressSpans(text: string): readonly AddressSpan[] {
  const spans: AddressSpan[] = [];
  for (const plain of plainAddresses(text)) spans.push({ address: plain.address, spelling: plain.address, start: plain.start, end: plain.end, form: "plain" });
  for (const run of text.matchAll(PERCENT_RUN)) {
    if (!run[0].includes("%40")) continue;
    // Every `@` in the decoded run was a `%40` (a literal `@` ends a run): each address there is percent-encoded.
    const { decoded, from } = percentDecodedRun(run[0]);
    for (const inner of plainAddresses(decoded)) {
      const start = run.index + from[inner.start]!;
      const end = run.index + from[inner.end]!;
      spans.push({ address: inner.address, spelling: text.slice(start, end), start, end, form: "percent" });
    }
  }
  for (const match of text.matchAll(ENCODED_WORD)) {
    const decoded = encodedWordText(match[1]!, match[2]!, match[3]!);
    for (const inner of plainAddresses(decoded)) spans.push({ address: inner.address, spelling: match[0], start: match.index, end: match.index + match[0].length, form: "rfc2047" });
  }
  return deepFreeze(spans);
}

/** `text` with every address-shaped string replaced by `[address]`: a tool's or a child's message may quote one, and a message is printed. */
export function withoutAddresses(text: string): string {
  const spans = [...addressSpans(text)].sort((a, b) => a.start - b.start);
  let out = "";
  let last = 0;
  for (const span of spans) {
    if (span.end <= last) continue;
    out += `${text.slice(last, Math.max(last, span.start))}[address]`;
    last = span.end;
  }
  return `${out}${text.slice(last)}`;
}

// ── A KNOWN address, in any spelling ─────────────────────────────────────
//
// The shape finds an address that is written as one. An address the gate KNOWS (a mapped-from address: the
// mapping names it) is searched as that value, in every spelling a reader would still recognise: entities
// (`&#64;`), quoted-printable (`=40`, soft line breaks), percent and backslash escapes, base64 at any
// alignment, a compatibility form (fullwidth `＠`) after NFKC, any case, invisible characters removed, a line
// folded inside it, `[at]`/`[dot]` and `at`/`dot` words, `_` or `-` for a dot, a quoted local part.

/** What a text is searched in for a known address: NFKC, the one case fold, then default-ignorable characters (zero-width spaces, soft hyphens) removed. */
export function canonicalText(text: string): string {
  return unicodeCaseFold(text.normalize("NFKC")).normalize("NFKC").replace(/\p{Default_Ignorable_Code_Point}/gu, "");
}

/** What may stand between two parts of a known address's local part or domain: up to 8 separators, or a `dot` word. */
const KNOWN_SEPARATOR = String.raw`(?:[\s"'._+\-\\=()\[\]{}<>]{0,8}|[\s"'._\-()\[\]{}<>]{0,4}dot[\s"'._\-()\[\]{}<>]{0,4})`;
/** What may stand for its `@`: `@` (any compatibility form, after NFKC) or an `at` word, with up to 8 separators on each side (a line fold, brackets, a quote). */
const KNOWN_AT = String.raw`[\s"'._\-\\=()\[\]{}<>]{0,8}(?:@|at)[\s"'._\-\\=()\[\]{}<>]{0,8}`;

/** A known address (its folded form) and the pattern that finds it, in any spelling, in a {@link canonicalText}. */
export type KnownAddress = Readonly<{ key: string; pattern: RegExp }>;

/** The search for each of `keys` (folded addresses): its local part's and its domain's letter-and-digit runs, in order, with any separator spelling between them. */
export function knownAddresses(keys: Iterable<string>): readonly KnownAddress[] {
  const runs = (part: string): string => part.split(/[^\p{L}\p{N}\p{M}]+/u).filter((run) => run.length > 0)
    .map((run) => run.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join(KNOWN_SEPARATOR);
  return deepFreeze([...new Set(keys)].sort().map((key) => {
    const at = key.lastIndexOf("@");
    return { key, pattern: new RegExp(`${runs(key.slice(0, at))}${KNOWN_AT}${runs(key.slice(at + 1))}`, "gu") };
  }));
}

/** Each known address `canonical` holds, and whether every match is the address exactly as folded (`exact`), or some match is another spelling. */
export function knownMatches(canonical: string, known: readonly KnownAddress[]): readonly Readonly<{ key: string; exact: number; other: number }>[] {
  const found: { key: string; exact: number; other: number }[] = [];
  for (const { key, pattern } of known) {
    let exact = 0;
    let other = 0;
    for (const match of canonical.matchAll(pattern)) {
      if (match[0] === key) exact += 1;
      else other += 1;
    }
    if (exact + other > 0) found.push({ key, exact, other });
  }
  return found;
}

/** A byte escape (`%XX`, quoted-printable `=XX` and its soft line break, `\\xXX`). */
const BYTE_ESCAPE = /%([0-9A-Fa-f]{2})|=([0-9A-Fa-f]{2})|=\r?\n|\\x([0-9A-Fa-f]{2})/gu;
/** A backslash escape (`\\uXXXX`, `\\u{X}`, a backslash before a character). */
const BACKSLASH_ESCAPE = /\\u\{([0-9A-Fa-f]{1,6})\}|\\u([0-9A-Fa-f]{4})|\\([^\n])/gu;

/**
 * `text` with every escape decoded: byte escapes as UTF-8 bytes (lossy), then character references (by the
 * ONE markup owner, `decodeHtmlEntities`), then backslash escapes.
 */
export function unescapedText(text: string): string {
  const parts: Buffer[] = [];
  let last = 0;
  for (const match of text.matchAll(BYTE_ESCAPE)) {
    parts.push(Buffer.from(text.slice(last, match.index), "utf8"));
    const hex = match[1] ?? match[2] ?? match[3];
    if (hex !== undefined) parts.push(Buffer.from([Number.parseInt(hex, 16)]));
    last = match.index + match[0].length;
  }
  const bytesDecoded = last === 0 ? text : Buffer.concat([...parts, Buffer.from(text.slice(last), "utf8")]).toString("utf8");
  const point = (value: number): string => (value <= 0x10ffff && (value < 0xd800 || value > 0xdfff) ? String.fromCodePoint(value) : "");
  return decodeHtmlEntities(bytesDecoded).replace(BACKSLASH_ESCAPE, (whole, braced?: string, four?: string, escaped?: string) => {
    if (braced !== undefined) return point(Number.parseInt(braced, 16));
    if (four !== undefined) return point(Number.parseInt(four, 16));
    return escaped ?? whole;
  });
}

/** A run of base64 (standard or URL-safe), possibly wrapped over lines (MIME, PEM, a folded header). */
const BASE64_RUN = /[A-Za-z0-9+/_-]{8,}={0,2}(?:\r?\n[ \t]*[A-Za-z0-9+/_-]+={0,2})*/gu;

/** The bytes of every base64 run in `text`, each decoded from each of its first four characters (so a run that does not start on a quantum still decodes). */
export function base64Payloads(text: string): readonly Buffer[] {
  const payloads: Buffer[] = [];
  for (const match of text.matchAll(BASE64_RUN)) {
    const run = match[0].replace(/[\s=]/gu, "").replaceAll("-", "+").replaceAll("_", "/");
    for (let offset = 0; offset < 4 && run.length - offset >= 8; offset += 1) payloads.push(Buffer.from(run.slice(offset), "base64"));
  }
  return payloads;
}

/**
 * Whether `path` may lie inside `tree`, judged by IDENTITY, never by spelling: the file and each folder above
 * it (links resolved) is compared by (device, inode) with the tree's root, so another case of the same name
 * on a case-insensitive filesystem, `..` or a link changes nothing. A file with more than one name (a hard
 * link) may have one inside the tree, which no walk up from this name can see, so it counts as inside.
 */
export function insideTree(path: string, tree: string): boolean {
  const root = statSync(tree, { bigint: true });
  let current = realpathSync(path);
  if (pathHasSecondName(current)) return true;
  for (;;) {
    const here = statSync(current, { bigint: true });
    if (here.dev === root.dev && here.ino === root.ino) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** Refuses (`code`) a reviewed file that lies inside the public tree (or has another name that may): it names what must never be published. */
export function refuseInsidePublicTree(path: string, publicTree: string, what: string, code: ForgeCode): void {
  if (insideTree(path, publicTree)) {
    throw new ForgeError(code, `the ${what} lies inside the public tree, or has another name (a hard link) that may; it names what must never be published, so it is kept, as its only name, in the coordination repository, never in a tree that is published`, {});
  }
}

/** One mapping line: the identity it replaces (an address, and a name when the line names one) and what replaces it. */
export type IdentityMapEntry = Readonly<{ line: number; properName: string | null; properAddress: string | null; commitName: string | null; commitAddress: string }>;

/** The ONE declared identity mapping, read and validated: its entries and its digest (recorded). */
export type IdentityMap = Readonly<{ entries: readonly IdentityMapEntry[]; sha256: string }>;

/**
 * A mailmap line (its comment already cut) as its `name <address>` parts, read by index (never a pattern that
 * would match markup): one or two parts, each name possibly empty, each address bracketed with no space or
 * bracket inside, nothing after the last. Undefined when the line is not that.
 */
function mailmapParts(line: string): readonly Readonly<{ name: string; address: string }>[] | undefined {
  const parts: { name: string; address: string }[] = [];
  let rest = line;
  while (rest.trim().length > 0) {
    const open = rest.indexOf("<");
    const close = rest.indexOf(">", open + 1);
    if (open < 0 || close < 0) return undefined;
    const address = rest.slice(open + 1, close);
    if (address.length === 0 || /[\s<>]/u.test(address)) return undefined;
    parts.push({ name: rest.slice(0, open).trim(), address });
    rest = rest.slice(close + 1);
  }
  return parts.length === 1 || parts.length === 2 ? parts : undefined;
}

/**
 * The mapping at `path`, in git's mailmap forms (`Proper Name <proper> Commit
 * Name <commit>`, `Proper Name <proper> <commit>`, `<proper> <commit>`, or
 * `Proper Name <commit>`). Refused when it lies inside `publicTree`
 * (`history_import_identity_map_public`), or when a line is not one of those
 * forms or an address in it is not address-shaped
 * (`history_import_identity_map_invalid`, naming the line number, never its
 * text).
 */
export function readIdentityMap(path: string, publicTree: string): IdentityMap {
  refuseInsidePublicTree(path, publicTree, "identity mapping", "history_import_identity_map_public");
  const text = readFileSync(realpathSync(path), "utf8");
  const entries: IdentityMapEntry[] = [];
  text.split("\n").forEach((raw, index) => {
    // A comment runs from `#` to the end of the line (cut by index: no unbounded pattern).
    const hash = raw.indexOf("#");
    const line = (hash < 0 ? raw : raw.slice(0, hash)).trim();
    if (line.length === 0) return;
    const parsed = mailmapParts(line);
    const invalid = (): never => {
      throw new ForgeError("history_import_identity_map_invalid", `line ${String(index + 1)} of the identity mapping is not a mailmap line of address-shaped addresses (Proper Name <proper> Commit Name <commit>, or a shorter form)`, { line: index + 1 });
    };
    if (parsed === undefined) invalid();
    const [first, second] = parsed!;
    const firstName = first!.name;
    const firstAddress = first!.address;
    const secondName = second?.name;
    const secondAddress = second?.address;
    if (!addressShaped(firstAddress!) || (secondAddress !== undefined && !addressShaped(secondAddress))) invalid();
    const name = (value: string | undefined): string | null => (value === undefined || value.trim().length === 0 ? null : value.trim());
    entries.push(secondAddress === undefined
      ? { line: index + 1, properName: name(firstName), properAddress: null, commitName: null, commitAddress: firstAddress! }
      : { line: index + 1, properName: name(firstName), properAddress: firstAddress!, commitName: name(secondName), commitAddress: secondAddress });
  });
  return deepFreeze({ entries, sha256: sha256(text) });
}

/**
 * The entry the mapping uses for `address` (folded), as `name` writes it: git's mailmap rule, an entry naming
 * the commit name wins over one naming only the address. Undefined when no entry maps it.
 */
function mappingEntry(map: IdentityMap | undefined, address: string, name: string | null = null): IdentityMapEntry | undefined {
  if (map === undefined) return undefined;
  const key = foldAddress(address);
  const candidates = map.entries.filter((entry) => foldAddress(entry.commitAddress) === key && entry.properAddress !== null);
  return candidates.find((entry) => entry.commitName !== null && name !== null && entry.commitName === name.trim())
    ?? candidates.find((entry) => entry.commitName === null);
}

/** The allowed list as compared: each address folded, and refused when empty (an empty list would refuse every history, or be a typo). */
export function allowedAddresses(identities: readonly string[]): ReadonlySet<string> {
  if (identities.length === 0) throw new ForgeError("history_import_identity_map_invalid", "the allowed identities (forge.historyImport.allowedIdentities) are empty", {});
  return new Set(identities.map(foldAddress));
}

/** Where an address was found: an object (its id, type and the region of a commit or tag), a path (the tree that names it), or a ref name (by its digest). */
export type AddressPlace =
  | Readonly<{ kind: "object"; oid: string; type: "blob" | "commit" | "tag"; region: "identity-header" | "header" | "message" | "content"; encoding: string; rewritable: boolean }>
  | Readonly<{ kind: "path"; oid: string }>
  | Readonly<{ kind: "ref"; refSha256: string }>;

/** One address occurrence: its folded key, the address as found, the exact spelling (what a rewrite replaces), its form, and its place. The address and the spelling are held in memory only. */
export type AddressOccurrence = Readonly<{ key: string; address: string; spelling: string; form: AddressSpan["form"]; name: string | null; place: AddressPlace }>;

/** The judgement of every address occurrence: what is allowed, disposed, mapped, and what nothing resolves. */
export type AddressJudgement = Readonly<{
  /** Distinct unallowed addresses (folded keys; held in memory only). */
  unallowed: ReadonlySet<string>;
  disposed: ReadonlySet<string>;
  mapped: ReadonlySet<string>;
  /** Unallowed, undisposed and unmapped: each a refusal. */
  unresolved: ReadonlySet<string>;
  /** The occurrences of unallowed addresses that are not disposed (each needs the mapping, or is a refusal). */
  needing: readonly AddressOccurrence[];
}>;

/** {@link AddressJudgement} of `occurrences` against `allowed` (folded), the reviewed `disposed` digests, and `map`. */
export function judgeAddresses(occurrences: readonly AddressOccurrence[], allowed: ReadonlySet<string>, disposed: ReadonlySet<string>, map: IdentityMap | undefined): AddressJudgement {
  const unallowed = new Set<string>();
  const disposedKeys = new Set<string>();
  const mapped = new Set<string>();
  const unresolved = new Set<string>();
  const needing: AddressOccurrence[] = [];
  for (const occurrence of occurrences) {
    if (allowed.has(occurrence.key)) continue;
    unallowed.add(occurrence.key);
    if (disposed.has(sha256(occurrence.key))) {
      disposedKeys.add(occurrence.key);
      continue;
    }
    needing.push(occurrence);
    const entry = mappingEntry(map, occurrence.address, occurrence.name);
    if (entry !== undefined && allowed.has(foldAddress(entry.properAddress!))) mapped.add(occurrence.key);
    else unresolved.add(occurrence.key);
  }
  return deepFreeze({ unallowed, disposed: disposedKeys, mapped, unresolved, needing });
}

/** The ids a refusal names: the objects (and the trees whose paths) that carry an occurrence, sorted; ref names are counted, never named. */
export function occurrenceObjects(occurrences: readonly Readonly<{ place: Readonly<{ kind: "object" | "path"; oid: string }> | Readonly<{ kind: "ref"; refSha256: string }> }>[]): Readonly<{ objects: readonly string[]; refs: number }> {
  const objects = new Set<string>();
  const refs = new Set<string>();
  for (const { place } of occurrences) {
    if (place.kind === "ref") refs.add(place.refSha256);
    else objects.add(place.oid);
  }
  return deepFreeze({ objects: [...objects].sort(), refs: refs.size });
}

/** The rewrite of the mapped addresses an import plans: filter-repo expressions, the generated mailmap, and the blobs it must strip whole. */
export type AddressRewrite = Readonly<{ expressions: string; mailmap: string; strippedBlobs: readonly string[]; rewrittenObjects: number }>;

/**
 * The rewrite of every MAPPED occurrence in `needing`: each exact spelling
 * found in text filter-repo rewrites in place (a message, a UTF-8 blob) gets a
 * literal expression to its mapped address; each exact spelling in an
 * identity header (author, committer, tagger) gets a generated mailmap line
 * (exact, so no case rule of git's is relied on); a blob whose occurrence
 * filter-repo cannot rewrite in place (UTF-16, a NUL in its first bytes, a
 * spelling no UTF-8 reading holds) is stripped whole. What no rewrite reaches
 * (a path, a ref name, another header) is left, and the census after the
 * rewrite refuses it.
 */
export function planAddressRewrite(needing: readonly AddressOccurrence[], allowed: ReadonlySet<string>, map: IdentityMap | undefined): AddressRewrite {
  const expressions = new Map<string, string>();
  const mailmap = new Map<string, string>();
  const stripped = new Set<string>();
  const rewritten = new Set<string>();
  for (const occurrence of needing) {
    const entry = mappingEntry(map, occurrence.address, occurrence.name);
    if (entry === undefined || !allowed.has(foldAddress(entry.properAddress!))) continue;
    const { place } = occurrence;
    if (place.kind !== "object") continue;
    rewritten.add(place.oid);
    if (place.region === "identity-header") {
      mailmap.set(occurrence.spelling, `${entry.properName === null ? "" : `${entry.properName} `}<${entry.properAddress!}> <${occurrence.spelling}>`);
    } else if (place.rewritable) {
      expressions.set(occurrence.spelling, entry.properAddress!);
    } else if (place.type === "blob") {
      stripped.add(place.oid);
    }
  }
  return deepFreeze({
    expressions: [...expressions].sort(([a], [b]) => longestFirst(a, b)).map(([from, to]) => `literal:${from}==>${to}\n`).join(""),
    mailmap: [...mailmap.values()].sort().map((line) => `${line}\n`).join(""),
    strippedBlobs: [...stripped].sort(),
    rewrittenObjects: rewritten.size,
  });
}

/** The digest a ref name is listed by (a ref name may hold an address). */
export function refDigest(ref: string): string {
  return sha256(ref);
}
