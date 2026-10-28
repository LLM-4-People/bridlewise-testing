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
 * an RFC 2047 encoded word) in every object, read as UTF-8, UTF-16LE/BE and
 * latin1, in every path and in every ref name, compared under the ONE Unicode
 * case fold (`unicodeCaseFold`, after NFKC) against the ONE allowed list
 * (`forge.historyImport.allowedIdentities`). An address not on it must be:
 *
 * - MAPPED by the ONE identity mapping (a mailmap-style file kept outside the
 *   public tree, since it holds the address it replaces), which the importer
 *   applies itself in its one rewrite; or
 * - DISPOSED by a reviewed disposition (the review file's `addresses`: the
 *   folded address's sha256 and the reason, never the address), kept outside
 *   the public tree as well.
 *
 * Anything else is refused before anything is rewritten or pushed, naming
 * objects by id (never an address), and the rewritten history, and the
 * receipt, are judged again by the same census before the push.
 *
 * This module holds the pure parts: the address shapes, the fold, the
 * mapping file and the judgement. The importer (history-import.ts) reads
 * the objects, the paths and the ref names, and runs the rewrite.
 */
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

import { deepFreeze, sha256 } from "../../kernel/integrity.ts";
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

const LOCAL = "[\\p{L}\\p{N}\\p{M}._+\\-]+";
const LABEL = "[\\p{L}\\p{N}\\p{M}](?:[\\p{L}\\p{N}\\p{M}\\-]*[\\p{L}\\p{N}\\p{M}])?";
/** An address-shaped string: a local part, `@`, and a domain of at least two labels (Unicode letters, digits and marks). */
const ADDRESS_SOURCE = `${LOCAL}@${LABEL}(?:\\.${LABEL})+`;
const ADDRESS = new RegExp(ADDRESS_SOURCE, "gu");
const ADDRESS_WHOLE = new RegExp(`^${ADDRESS_SOURCE}$`, "u");
/** A percent-encoded address: `%40` for `@`, any other byte percent-encoded too. */
const PERCENT_CANDIDATE = /[\p{L}\p{N}\p{M}._+\-%]+%40[\p{L}\p{N}\p{M}.\-%]+/giu;
/** An RFC 2047 encoded word (`=?charset?Q|B?text?=`). */
const ENCODED_WORD = /=\?([^?\s]+)\?([QqBb])\?([^?\s]*)\?=/gu;

/** One address-shaped string in a text: the address it names, the exact spelling it was found in, where, and in which form. */
export type AddressSpan = Readonly<{ address: string; spelling: string; start: number; end: number; form: "plain" | "percent" | "rfc2047" }>;

/** `text` with every `%XX` decoded as UTF-8 bytes, or undefined when it is not valid UTF-8 after decoding. */
function percentDecoded(text: string): string | undefined {
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === "%" && /^[0-9A-Fa-f]{2}$/u.test(text.slice(index + 1, index + 3))) {
      bytes.push(Number.parseInt(text.slice(index + 1, index + 3), 16));
      index += 2;
    } else {
      bytes.push(...Buffer.from(character, "utf8"));
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(bytes));
  } catch {
    return undefined;
  }
}

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

/** Every address-shaped string in `text`: plain, percent-encoded, and inside RFC 2047 encoded words. */
export function addressSpans(text: string): readonly AddressSpan[] {
  const spans: AddressSpan[] = [];
  for (const match of text.matchAll(ADDRESS)) {
    spans.push({ address: match[0], spelling: match[0], start: match.index, end: match.index + match[0].length, form: "plain" });
  }
  for (const match of text.matchAll(PERCENT_CANDIDATE)) {
    const decoded = percentDecoded(match[0]);
    if (decoded === undefined) continue;
    for (const inner of decoded.matchAll(ADDRESS)) spans.push({ address: inner[0], spelling: match[0], start: match.index, end: match.index + match[0].length, form: "percent" });
  }
  for (const match of text.matchAll(ENCODED_WORD)) {
    const decoded = encodedWordText(match[1]!, match[2]!, match[3]!);
    for (const inner of decoded.matchAll(ADDRESS)) spans.push({ address: inner[0], spelling: match[0], start: match.index, end: match.index + match[0].length, form: "rfc2047" });
  }
  return deepFreeze(spans);
}

/** Whether `path` lies inside `tree` (both resolved through links; compared by path segment, never by spelling). */
export function insideTree(path: string, tree: string): boolean {
  const within = relative(realpathSync(tree), realpathSync(path));
  return within === "" || !(within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within));
}

/** Refuses (`code`) a reviewed file that lies inside the public tree: it names what must never be published. */
export function refuseInsidePublicTree(path: string, publicTree: string, what: string, code: ForgeCode): void {
  if (insideTree(path, publicTree)) {
    throw new ForgeError(code, `the ${what} lies inside the public tree; it names what must never be published, so it is kept in the coordination repository, never in a tree that is published`, {});
  }
}

/** One mapping line: the identity it replaces (an address, and a name when the line names one) and what replaces it. */
export type IdentityMapEntry = Readonly<{ line: number; properName: string | null; properAddress: string | null; commitName: string | null; commitAddress: string }>;

/** The ONE declared identity mapping, read and validated: its entries and its digest (recorded). */
export type IdentityMap = Readonly<{ entries: readonly IdentityMapEntry[]; sha256: string }>;

const MAILMAP_LINE = /^([^<#]*?)\s*<([^<>\s]+)>(?:\s*([^<#]*?)\s*<([^<>\s]+)>)?\s*(?:#.*)?$/u;

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
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) return;
    const parsed = MAILMAP_LINE.exec(line);
    const invalid = (): never => {
      throw new ForgeError("history_import_identity_map_invalid", `line ${String(index + 1)} of the identity mapping is not a mailmap line of address-shaped addresses (Proper Name <proper> Commit Name <commit>, or a shorter form)`, { line: index + 1 });
    };
    if (parsed === null) invalid();
    const [, firstName, firstAddress, secondName, secondAddress] = parsed!;
    if (!ADDRESS_WHOLE.test(firstAddress!) || (secondAddress !== undefined && !ADDRESS_WHOLE.test(secondAddress))) invalid();
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
export function mappingEntry(map: IdentityMap | undefined, address: string, name: string | null = null): IdentityMapEntry | undefined {
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
export function occurrenceObjects(occurrences: readonly AddressOccurrence[]): Readonly<{ objects: readonly string[]; refs: number }> {
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
  const byText = (a: string, b: string): number => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0);
  return deepFreeze({
    expressions: [...expressions].sort(([a], [b]) => byText(a, b)).map(([from, to]) => `literal:${from}==>${to}\n`).join(""),
    mailmap: [...mailmap.values()].sort().map((line) => `${line}\n`).join(""),
    strippedBlobs: [...stripped].sort(),
    rewrittenObjects: rewritten.size,
  });
}

/** The digest a ref name is listed by (a ref name may hold an address). */
export function refDigest(ref: string): string {
  return sha256(ref);
}
