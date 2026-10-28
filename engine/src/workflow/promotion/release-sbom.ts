/**
 * THE RELEASE SBOM — an SPDX 2.3 JSON document of exactly what the product
 * commit ships, derived from the product commit's own lockfiles (every
 * `package-lock.json` in its tree), never from the forge's dependency graph
 * (GitHub's SBOM export describes the default branch, `main`, whose
 * manifests the projection narrows: a second, wrong source).
 *
 * Each lockfile's root package is DESCRIBED by the document; every package
 * installed under its `node_modules/` is a package with its purl, its
 * `resolved` location, the checksums its `integrity` names and its declared
 * licence (an SPDX expression, else NOASSERTION), related to that root as
 * DEPENDENCY_OF, DEV_DEPENDENCY_OF or OPTIONAL_DEPENDENCY_OF. A workspace
 * link (`link: true`) is the product's own source, described by its root,
 * and is not a package of its own.
 *
 * Deterministic: the creation time is the product commit's committer time,
 * the namespace is the release asset's own address, and every order is by UTF-8 bytes
 * (`compareUtf8Bytes`, never the host's locale), so the same commit gives
 * the same bytes on any machine; no clock is read. Fail closed: a lockfile
 * that is not a v2/v3 `packages` map, an installed entry with no version, or
 * an integrity of an unknown algorithm is
 * `promotion_release_sbom_lockfile_invalid`.
 *
 * The SBOM is a PUBLIC release asset, so a `resolved` location carrying a
 * credential never reaches it. That is `promotion_release_sbom_credential`,
 * naming the lockfile and the entry, never the value, for:
 * - a URL whose userinfo (`user:pass@`, or a user alone: fail closed), query
 *   or fragment carries a credential: `urlCredentialSpellings` over the URL
 *   without its path (cut by the privacy owner's one splitter, `splitUrl`; a
 *   package tarball's path is its name), read at the privacy owner's deepest
 *   decode;
 * - any location the one secret catalogue flags (`hasSecretTextSignal`).
 * Nothing is stripped: a lockfile that records a credentialed registry is
 * fixed on main.
 */
import { deepFreeze, sha256 } from "../../kernel/integrity.ts";
import { SBOM_ELEMENT_ID_DIGEST_LENGTH } from "../workflow-config.ts";
import { compareUtf8Bytes } from "../../kernel/ordered.ts";
import { MAXIMUM_PRIVACY_URL_DECODE_LEVELS } from "../../privacy/privacy-config.ts";
import { splitUrl, urlCredentialSpellings } from "../../privacy/secret-parts.ts";
import { hasSecretTextSignal } from "../../privacy/secret-signals.ts";
import { PRODUCT_NAME } from "../../kernel/product-identity.ts";
import { commitTreeReader, gitOutput, type GitRepository } from "../../git/tree-reader.ts";
import { PromotionError } from "./codes.ts";
import type { ReleasePlan } from "./release-train.ts";

const LOCKFILE = "package-lock.json";
const NODE_MODULES = "node_modules/";
/** The integrity algorithms npm writes, by their SPDX checksum names. */
const CHECKSUM_ALGORITHMS: Readonly<Record<string, string>> = { sha1: "SHA1", sha256: "SHA256", sha384: "SHA384", sha512: "SHA512" };
/** An SPDX licence expression of plain identifiers joined by AND, OR or WITH (anything else is NOASSERTION, never guessed). */
const LICENSE_EXPRESSION = /^\(?[A-Za-z0-9][A-Za-z0-9.+-]*(?: (?:AND|OR|WITH) [A-Za-z0-9][A-Za-z0-9.+-]*)*\)?$/u;
const NOT_LICENSES: ReadonlySet<string> = new Set(["UNLICENSED", "UNLICENSE", "NONE", "SEE"]);

type LockEntry = Readonly<{ name?: unknown; version?: unknown; resolved?: unknown; integrity?: unknown; license?: unknown; dev?: unknown; devOptional?: unknown; optional?: unknown; link?: unknown }>;

type SpdxPackage = {
  SPDXID: string;
  name: string;
  versionInfo: string;
  downloadLocation: string;
  filesAnalyzed: false;
  licenseConcluded: "NOASSERTION";
  licenseDeclared: string;
  copyrightText: "NOASSERTION";
  checksums?: { algorithm: string; checksumValue: string }[];
  externalRefs?: { referenceCategory: "PACKAGE-MANAGER"; referenceType: "purl"; referenceLocator: string }[];
  primaryPackagePurpose?: "APPLICATION" | "LIBRARY";
};

type SpdxRelationship = { spdxElementId: string; relationshipType: string; relatedSpdxElement: string };

function invalid(path: string, why: string): PromotionError {
  return new PromotionError("promotion_release_sbom_lockfile_invalid", `${path} ${why}: the SBOM describes only what it can read exactly`, { lockfile: path });
}

/** An SPDX element id (letters, digits, `.`, `-`) unique to `key`. */
function spdxId(kind: string, label: string, key: string): string {
  return `SPDXRef-${kind}-${label.replace(/[^A-Za-z0-9.-]+/gu, "-").replace(/^-+|-+$/gu, "")}-${sha256(key).slice(0, SBOM_ELEMENT_ID_DIGEST_LENGTH)}`;
}

/** The npm purl of `name@version` (a scope's `@` percent-encoded). */
function purl(name: string, version: string): string {
  return `pkg:npm/${name.startsWith("@") ? `%40${name.slice(1)}` : name}@${version}`;
}

function declaredLicense(value: unknown): string {
  if (typeof value !== "string" || !LICENSE_EXPRESSION.test(value)) return "NOASSERTION";
  return value.replace(/[()]/gu, " ").split(" ").some((word) => NOT_LICENSES.has(word.toUpperCase())) ? "NOASSERTION" : value;
}

function checksums(path: string, integrity: unknown): { algorithm: string; checksumValue: string }[] {
  if (integrity === undefined) return [];
  if (typeof integrity !== "string") throw invalid(path, "holds an integrity that is not a string");
  return integrity.split(/\s+/u).filter((part) => part !== "").map((part) => {
    const dash = part.indexOf("-");
    const algorithm = CHECKSUM_ALGORITHMS[part.slice(0, dash)];
    if (dash <= 0 || algorithm === undefined) throw invalid(path, `holds an integrity of an unknown algorithm (${part.slice(0, Math.max(dash, 0))})`);
    return { algorithm, checksumValue: Buffer.from(part.slice(dash + 1), "base64").toString("hex") };
  });
}

/** `resolved` as a public download location (see the header): the URL itself, or the refusal that names where a credential sits. */
function downloadLocation(path: string, key: string, resolved: unknown): string {
  if (typeof resolved !== "string" || resolved === "") return "NOASSERTION";
  const split = splitUrl(resolved);
  const offPath = split === undefined ? "" : `${resolved.slice(0, split.path.start)}/${resolved.slice(split.path.end)}`;
  if ((offPath !== "" && urlCredentialSpellings(offPath, MAXIMUM_PRIVACY_URL_DECODE_LEVELS).length > 0) || hasSecretTextSignal(resolved, "classification")) {
    throw new PromotionError("promotion_release_sbom_credential", `${path} resolves ${key} from a location that carries a credential: a public SBOM never publishes it`, { lockfile: path, entry: key });
  }
  return resolved;
}

/** The product commit's committer time as SPDX writes it (`YYYY-MM-DDThh:mm:ssZ`). */
function committedAt(repository: GitRepository, commit: string): string {
  const seconds = Number(gitOutput(repository, ["show", "-s", "--format=%ct", commit]).stdout.toString("utf8").trim());
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/u, "Z");
}

/**
 * The SPDX 2.3 document of `plan`'s product commit (see the header), as its
 * canonical bytes. Its namespace is `location`, the SBOM asset's own download
 * address (`releaseAssetUrl`): a URI the product owns, one per release.
 */
export function releaseSbom(repository: GitRepository, plan: ReleasePlan, location: string): string {
  const reader = commitTreeReader(repository, plan.product.commit);
  const lockfiles = reader.paths().filter((path) => path === LOCKFILE || path.endsWith(`/${LOCKFILE}`)).sort(compareUtf8Bytes);
  if (lockfiles.length === 0) throw invalid(plan.product.commit, "holds no package-lock.json");
  const packages = new Map<string, SpdxPackage>();
  const relationships: SpdxRelationship[] = [];
  for (const path of lockfiles) {
    let lock: { lockfileVersion?: unknown; packages?: unknown };
    try {
      lock = JSON.parse(reader.text(path) ?? "") as typeof lock;
    } catch {
      throw invalid(path, "is not JSON");
    }
    if ((lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3) || typeof lock.packages !== "object" || lock.packages === null) throw invalid(path, "is not a lockfile v2/v3 with a packages map");
    const entries = lock.packages as Readonly<Record<string, LockEntry>>;
    const root = entries[""];
    if (root === undefined || typeof root.name !== "string" || typeof root.version !== "string") throw invalid(path, "names no root package with a name and a version");
    const rootId = spdxId("Package", root.name, `root:${path}`);
    packages.set(rootId, {
      SPDXID: rootId, name: root.name, versionInfo: root.version, downloadLocation: "NOASSERTION", filesAnalyzed: false,
      licenseConcluded: "NOASSERTION", licenseDeclared: declaredLicense(root.license), copyrightText: "NOASSERTION", primaryPackagePurpose: "APPLICATION",
    });
    relationships.push({ spdxElementId: "SPDXRef-DOCUMENT", relationshipType: "DESCRIBES", relatedSpdxElement: rootId });
    for (const [key, entry] of Object.entries(entries)) {
      if (!key.includes(NODE_MODULES) || entry.link === true) continue;
      const name = typeof entry.name === "string" ? entry.name : key.slice(key.lastIndexOf(NODE_MODULES) + NODE_MODULES.length);
      if (typeof entry.version !== "string" || entry.version === "") throw invalid(path, `installs ${key} with no version`);
      const sums = checksums(path, entry.integrity);
      // Every entry's location is judged, a duplicate's too: the first one kept is not the only one written to the lockfile.
      const location = downloadLocation(path, key, entry.resolved);
      const id = spdxId("npm", `${name}-${entry.version}`, `${name}@${entry.version} ${sums.map((sum) => sum.checksumValue).join(" ")}`);
      if (!packages.has(id)) {
        packages.set(id, {
          SPDXID: id, name, versionInfo: entry.version,
          downloadLocation: location,
          filesAnalyzed: false, licenseConcluded: "NOASSERTION", licenseDeclared: declaredLicense(entry.license), copyrightText: "NOASSERTION",
          ...(sums.length === 0 ? {} : { checksums: sums }),
          externalRefs: [{ referenceCategory: "PACKAGE-MANAGER", referenceType: "purl", referenceLocator: purl(name, entry.version) }],
          primaryPackagePurpose: "LIBRARY",
        });
      }
      const kind = entry.dev === true || entry.devOptional === true ? "DEV_DEPENDENCY_OF" : entry.optional === true ? "OPTIONAL_DEPENDENCY_OF" : "DEPENDENCY_OF";
      relationships.push({ spdxElementId: id, relationshipType: kind, relatedSpdxElement: rootId });
    }
  }
  const unique = [...new Map(relationships.map((relationship) => [`${relationship.spdxElementId} ${relationship.relationshipType} ${relationship.relatedSpdxElement}`, relationship])).entries()]
    .sort(([left], [right]) => compareUtf8Bytes(left, right)).map(([, relationship]) => relationship);
  const document = deepFreeze({
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `${PRODUCT_NAME}-${plan.version}`,
    documentNamespace: location,
    creationInfo: { created: committedAt(repository, plan.product.commit), creators: [`Tool: ${PRODUCT_NAME}-harness`] },
    packages: [...packages.values()].sort((left, right) => compareUtf8Bytes(left.SPDXID, right.SPDXID)),
    relationships: unique,
  });
  return `${JSON.stringify(document, null, 2)}\n`;
}
