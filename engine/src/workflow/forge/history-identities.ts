/**
 * THE HISTORY IMPORTER'S IDENTITY GATE: no address leaves the host unless it
 * is ALLOWED.
 *
 * A history can carry a person's own address in places a secret scan never
 * looks: a commit's author and committer, a tag's tagger, and every trailer a
 * message holds (`Signed-off-by:`, `Co-authored-by:`, any `Key: Name <addr>`
 * line). Before anything is pushed, every address in every commit and tag to
 * be published is judged against ONE declared list of allowed identities
 * (`forge.historyImport.allowedIdentities`, the public identities the
 * project's history may carry). An address not on it must be MAPPED, through
 * ONE declared mapping: a mailmap-style file kept outside the public tree
 * (the mapping itself holds the address it replaces), which the importer
 * reads, validates and applies itself, deterministically, in its one rewrite
 * (`git filter-repo --mailmap` for the headers, the same expressions file for
 * every other occurrence). An address with no mapping to an allowed one is
 * refused (`history_import_identity_unallowed`), naming the commits and tags
 * by id: an address is never echoed into a message, a log, a record or the
 * receipt.
 *
 * This module holds the pure parts: reading an object's identities, the
 * mapping file, and the judgement. The importer (history-import.ts) reads the
 * objects and runs the rewrite.
 */
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";

import { deepFreeze, sha256 } from "../../kernel/integrity.ts";
import { ForgeError } from "./codes.ts";

/** Where an address sits in an object. */
export type IdentityField = "author" | "committer" | "tagger" | "trailer";

/** One identity an object carries. The name and the address are held in memory only: never logged, recorded or echoed. */
export type IdentityUse = Readonly<{ oid: string; type: "commit" | "tag"; field: IdentityField; name: string; address: string }>;

/** An address as it is compared: trimmed and lower-cased (a mail domain is case-insensitive, and a person's local part is too in practice). */
export function comparableAddress(address: string): string {
  return address.trim().toLowerCase();
}

const HEADER = /^(author|committer|tagger) (.*?) ?<([^<>\n]*)> -?\d+ [+-]\d{4}$/u;
const TRAILER = /^[A-Za-z][A-Za-z0-9-]*:[ \t]*(.*?)[ \t]*<([^<>\s]+@[^<>\s]+)>[ \t]*$/u;

/**
 * Every identity a commit or tag object carries: its `author`/`committer`
 * (a commit) or `tagger` (a tag) header, and every trailer-shaped line of its
 * message that names an address (anywhere in the message, not only the last
 * paragraph: a trailer that git would not parse as one is still published).
 */
export function identityUses(oid: string, type: "commit" | "tag", bytes: Buffer): readonly IdentityUse[] {
  const text = bytes.toString("utf8");
  const split = text.indexOf("\n\n");
  const headers = (split < 0 ? text : text.slice(0, split)).split("\n");
  const message = split < 0 ? "" : text.slice(split + 2);
  const uses: IdentityUse[] = [];
  for (const line of headers) {
    const header = HEADER.exec(line);
    if (header !== null) uses.push({ oid, type, field: header[1] as "author" | "committer" | "tagger", name: header[2]!, address: header[3]! });
  }
  for (const line of message.split("\n")) {
    const trailer = TRAILER.exec(line);
    if (trailer !== null) uses.push({ oid, type, field: "trailer", name: trailer[1]!, address: trailer[2]! });
  }
  return deepFreeze(uses);
}

/** One mapping line: the identity it replaces (an address, and a name when the line names one) and what replaces it. */
export type IdentityMapEntry = Readonly<{ line: number; properName: string | null; properAddress: string | null; commitName: string | null; commitAddress: string }>;

/** The ONE declared identity mapping, read and validated: its entries, its text (handed to filter-repo) and its digest (recorded). */
export type IdentityMap = Readonly<{ entries: readonly IdentityMapEntry[]; text: string; sha256: string }>;

const MAILMAP_LINE = /^([^<#]*?)\s*<([^<>\s]+)>(?:\s*([^<#]*?)\s*<([^<>\s]+)>)?\s*(?:#.*)?$/u;

/**
 * The mapping at `path`, in git's mailmap forms (`Proper Name <proper> Commit
 * Name <commit>`, `Proper Name <proper> <commit>`, `<proper> <commit>`, or
 * `Proper Name <commit>`). Refused when it lies inside `publicTree`
 * (`history_import_identity_map_public`: the mapping holds the address it
 * replaces, so it is never part of a public tree), or when a line is not one
 * of those forms (`history_import_identity_map_invalid`, naming the line
 * number, never its text).
 */
export function readIdentityMap(path: string, publicTree: string): IdentityMap {
  const real = realpathSync(path);
  const within = relative(realpathSync(publicTree), real);
  if (within === "" || (!within.startsWith("..") && !isAbsolute(within))) {
    throw new ForgeError("history_import_identity_map_public", "the identity mapping lies inside the public tree; it holds the addresses it replaces, so it is kept in the coordination repository, never in a tree that is published", {});
  }
  const text = readFileSync(real, "utf8");
  const entries: IdentityMapEntry[] = [];
  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) return;
    const parsed = MAILMAP_LINE.exec(line);
    if (parsed === null) throw new ForgeError("history_import_identity_map_invalid", `line ${String(index + 1)} of the identity mapping is not a mailmap line (Proper Name <proper> Commit Name <commit>, or a shorter form)`, { line: index + 1 });
    const [, firstName, firstAddress, secondName, secondAddress] = parsed;
    const name = (value: string | undefined): string | null => (value === undefined || value.trim().length === 0 ? null : value.trim());
    entries.push(secondAddress === undefined
      ? { line: index + 1, properName: name(firstName), properAddress: null, commitName: null, commitAddress: firstAddress! }
      : { line: index + 1, properName: name(firstName), properAddress: firstAddress!, commitName: name(secondName), commitAddress: secondAddress });
  });
  return deepFreeze({ entries, text, sha256: sha256(text) });
}

/** The address `use` is published with after the mapping (git's mailmap rule: an entry naming the commit name wins over one naming only the address). */
export function mappedAddress(use: Pick<IdentityUse, "name" | "address">, map: IdentityMap | undefined): string {
  if (map === undefined) return use.address;
  const address = comparableAddress(use.address);
  const candidates = map.entries.filter((entry) => comparableAddress(entry.commitAddress) === address);
  const named = candidates.find((entry) => entry.commitName !== null && entry.commitName === use.name.trim());
  const entry = named ?? candidates.find((one) => one.commitName === null);
  return entry?.properAddress ?? use.address;
}

/** The judgement of every identity to be published: the objects whose address is not allowed, and those the mapping does not bring to an allowed one. */
export type IdentityJudgement = Readonly<{
  /** Commits and tags that carry an address not on the allowed list (each needs a mapping). */
  needingMapping: readonly string[];
  /** Of those, the ones some address of which the mapping leaves unallowed. */
  unmapped: readonly string[];
}>;

/** {@link IdentityJudgement} of `uses` against `allowed` (comparable addresses) under `map`. */
export function judgeIdentities(uses: readonly IdentityUse[], allowed: ReadonlySet<string>, map: IdentityMap | undefined): IdentityJudgement {
  const needing = new Set<string>();
  const unmapped = new Set<string>();
  for (const use of uses) {
    if (allowed.has(comparableAddress(use.address))) continue;
    needing.add(use.oid);
    if (!allowed.has(comparableAddress(mappedAddress(use, map)))) unmapped.add(use.oid);
  }
  return deepFreeze({ needingMapping: [...needing].sort(), unmapped: [...unmapped].sort() });
}

/** The allowed list as compared: each address made comparable, and refused when empty (an empty list would refuse every history, or be a typo). */
export function allowedAddresses(identities: readonly string[]): ReadonlySet<string> {
  if (identities.length === 0) throw new ForgeError("history_import_identity_map_invalid", "the allowed identities (forge.historyImport.allowedIdentities) are empty", {});
  return new Set(identities.map(comparableAddress));
}

/** A literal escaped for a Python `re` pattern (filter-repo's `regex:` expressions): every character that is not a word character. */
function pythonRegexLiteral(text: string): string {
  return text.replace(/[^A-Za-z0-9_]/gu, (character) => `\\${character}`);
}

/**
 * The filter-repo expressions that replace, everywhere outside the headers
 * (messages, trailers, file content), each mapped address the history
 * actually carries with the address it maps to, in any case. The headers are
 * rewritten by `--mailmap` itself.
 */
export function identityExpressions(uses: readonly IdentityUse[], allowed: ReadonlySet<string>, map: IdentityMap): string {
  const replaced = new Map<string, string>();
  for (const use of uses) {
    if (allowed.has(comparableAddress(use.address))) continue;
    const target = mappedAddress(use, map);
    if (comparableAddress(target) !== comparableAddress(use.address)) replaced.set(comparableAddress(use.address), target);
  }
  return [...replaced].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([from, to]) => `regex:(?i)${pythonRegexLiteral(from)}==>${to}\n`).join("");
}

/** The mapped-from addresses the history carries (comparable): none may remain anywhere after the rewrite. */
export function mappedFromAddresses(uses: readonly IdentityUse[], allowed: ReadonlySet<string>): readonly string[] {
  return [...new Set(uses.map((use) => comparableAddress(use.address)).filter((address) => !allowed.has(address)))].sort();
}
