import { findPackageJSON } from "node:module";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync
} from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalHash, canonicalJson, sha256 } from "../../../src/kernel/integrity.ts";
import { assertNoDuplicateJsonObjectKeys } from "../../../src/kernel/json-integrity.ts";
import { relativePathViolationKinds } from "../../../src/filesystem/path-boundary.ts";
import { ROOT_POLICY } from "../../../src/kernel/root-policy.ts";
import {
  listSafeRepositoryTree,
  readSafeRepositoryFile
} from "../../../scripts/verification/safe-repository-reader.ts";
import {
  QUALIFICATION_AUTHORITY_OWNER as CONTRACT_AUTHORITY_OWNER,
  trustBaseDerivationOptions
} from "./qualification-authority-contract.mjs";

const ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const MAXIMUM_FILE_BYTES = ROOT_POLICY.verification.testDiscovery.maximumSourceBytes;
const TREE_LIMITS = Object.freeze({
  maximumDepth: ROOT_POLICY.verification.testDiscovery.maximumDepth,
  maximumEntries: ROOT_POLICY.verification.testDiscovery.maximumEntries
});
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export const QUALIFICATION_AUTHORITY_OWNER = CONTRACT_AUTHORITY_OWNER;
export const QUALIFICATION_PORTABLE_DISCLOSURE_SCHEMA_VERSION =
  "bridlewise-qualification-portable-disclosure/v1";

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function byteCompare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function byteSort(values) {
  return values.toSorted(byteCompare);
}

function assertRepositoryRoot(root) {
  const stats = lstatSync(root, { bigint: true, throwIfNoEntry: false });
  if (!stats?.isDirectory() || stats.isSymbolicLink() || realpathSync(root) !== root) {
    fail("qualification_repository_root_unsafe");
  }
}

function canonicalRepositoryRelativePath(root, input) {
  if (typeof input !== "string" || input.normalize("NFC") !== input ||
    relativePathViolationKinds(input).length > 0) {
    fail("qualification_path_invalid");
  }
  const absolutePath = resolve(root, input);
  const roundTrip = relative(root, absolutePath).split(sep).join("/");
  if (roundTrip !== input || absolutePath === root || !absolutePath.startsWith(root + sep)) {
    fail("qualification_path_outside_root");
  }
  return Object.freeze({ relativePath: input, absolutePath });
}

function strictJson(bytes, sourceId) {
  let text;
  try {
    text = STRICT_UTF8.decode(bytes);
  } catch {
    fail("qualification_json_encoding_invalid");
  }
  if (text.codePointAt(0) === 0xfeff || text.includes("\0")) fail("qualification_json_encoding_invalid");
  assertNoDuplicateJsonObjectKeys(
    text,
    `${sourceId} contains duplicate JSON keys`,
    "qualification_json_duplicate_key"
  );
  const value = JSON.parse(text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("qualification_json_shape_invalid");
  }
  return value;
}

function qualificationFileObservation(root, relativePath) {
  assertRepositoryRoot(root);
  const path = canonicalRepositoryRelativePath(root, relativePath);
  const read = readSafeRepositoryFile(root, path.relativePath, MAXIMUM_FILE_BYTES);
  if (read.realPath !== path.absolutePath) fail("qualification_file_physical_alias");
  return Object.freeze({
    record: Object.freeze({
      relativePath: path.relativePath,
      byteLength: read.bytes.length,
      sha256: sha256(read.bytes)
    }),
    bytes: Buffer.from(read.bytes),
    physical: Object.freeze({
      realPath: read.realPath,
      device: read.device,
      inode: read.inode
    })
  });
}

function newPhysicalRegistry() {
  return { realPaths: new Set(), inodes: new Set() };
}

function registerPhysicalIdentity(registry, observation) {
  const inodeKey = `${observation.physical.device}:${observation.physical.inode}`;
  if (registry.realPaths.has(observation.physical.realPath) || registry.inodes.has(inodeKey)) {
    fail("qualification_file_physical_alias");
  }
  registry.realPaths.add(observation.physical.realPath);
  registry.inodes.add(inodeKey);
}

function collectObservations(root, relativePaths, preserveOrder, physicalRegistry = newPhysicalRegistry()) {
  if (!Array.isArray(relativePaths)) fail("qualification_file_universe_invalid");
  const validated = relativePaths.map((entry) => canonicalRepositoryRelativePath(root, entry).relativePath);
  if (new Set(validated).size !== validated.length) fail("qualification_file_universe_duplicate");
  const ordered = preserveOrder ? validated : byteSort(validated);
  return Object.freeze(ordered.map((relativePath) => {
    const observation = qualificationFileObservation(root, relativePath);
    registerPhysicalIdentity(physicalRegistry, observation);
    return observation;
  }));
}

function scanPackageFiles(root, packageRootRelativePath, physicalRegistry) {
  const before = listSafeRepositoryTree(root, packageRootRelativePath, TREE_LIMITS);
  const filePaths = byteSort(before.filter((entry) => entry.kind === "file").map((entry) => entry.path));
  if (filePaths.length === 0) fail("qualification_package_empty");
  const files = [];
  let packageJsonBytes;
  for (const repositoryRelativePath of filePaths) {
    const observation = qualificationFileObservation(root, repositoryRelativePath);
    registerPhysicalIdentity(physicalRegistry, observation);
    const packageRelativePath = repositoryRelativePath.slice(packageRootRelativePath.length + 1);
    if (packageRelativePath === "package.json") packageJsonBytes = observation.bytes;
    files.push(Object.freeze({
      relativePath: packageRelativePath,
      byteLength: observation.record.byteLength,
      sha256: observation.record.sha256
    }));
  }
  const after = listSafeRepositoryTree(root, packageRootRelativePath, TREE_LIMITS);
  if (canonicalJson(before) !== canonicalJson(after) || packageJsonBytes === undefined) {
    fail("qualification_package_tree_changed");
  }
  return Object.freeze({ files: Object.freeze(files), packageJsonBytes });
}

function resolvePackageRoot(root, packageName, basePackageJson) {
  if (typeof packageName !== "string" || packageName.length === 0 || packageName.normalize("NFC") !== packageName) {
    fail("qualification_package_name_invalid");
  }
  const locatedPackageJson = findPackageJSON(packageName, basePackageJson);
  if (locatedPackageJson === undefined) fail("qualification_package_resolution_missing");
  const lexicalPackageJson = resolve(locatedPackageJson);
  const realPackageJson = realpathSync(lexicalPackageJson);
  if (lexicalPackageJson !== realPackageJson) fail("qualification_package_physical_alias");
  const packageJsonRelativePath = relative(root, realPackageJson).split(sep).join("/");
  canonicalRepositoryRelativePath(root, packageJsonRelativePath);
  if (!packageJsonRelativePath.endsWith("/package.json")) fail("qualification_package_root_invalid");
  const rootRelativePath = packageJsonRelativePath.slice(0, -"/package.json".length);
  canonicalRepositoryRelativePath(root, rootRelativePath);
  return Object.freeze({
    packageJsonRelativePath,
    rootRelativePath,
    internalRootRealPath: resolve(root, rootRelativePath)
  });
}

function packageRecord(common, packageDetail) {
  const withoutIdentity = packageDetail === "full" ? Object.freeze({
    originClass: "installed-package-closure-member",
    name: common.name,
    version: common.version,
    packageJsonSha256: common.packageJsonSha256,
    declaredRuntimeDependencies: common.declaredRuntimeDependencies,
    files: common.files,
    contentIdentity: common.treeIdentity
  }) : Object.freeze({
    originClass: "installed-package-closure-member",
    name: common.name,
    version: common.version,
    packageJsonSha256: common.packageJsonSha256,
    declaredRuntimeDependencies: common.declaredRuntimeDependencies,
    fileCount: common.fileCount,
    byteLength: common.byteLength,
    treeIdentity: common.treeIdentity
  });
  return Object.freeze({ ...withoutIdentity, portableIdentity: canonicalHash(withoutIdentity) });
}

function derivePackageClosure(root, rootPackages, packageDetail, physicalRegistry) {
  if (!Array.isArray(rootPackages) || rootPackages.length === 0 ||
    new Set(rootPackages).size !== rootPackages.length) {
    fail("qualification_root_package_universe_invalid");
  }
  const pending = byteSort([...rootPackages]).map((name) => ({
    name,
    basePackageJson: resolve(root, "package.json")
  }));
  const visitedRoots = new Set();
  const rootsByName = new Map();
  const packages = [];
  while (pending.length > 0) {
    const request = pending.shift();
    const resolved = resolvePackageRoot(root, request.name, request.basePackageJson);
    const previousRoot = rootsByName.get(request.name);
    if (previousRoot !== undefined && previousRoot !== resolved.internalRootRealPath) {
      fail("qualification_package_name_ambiguous");
    }
    rootsByName.set(request.name, resolved.internalRootRealPath);
    if (visitedRoots.has(resolved.internalRootRealPath)) continue;
    visitedRoots.add(resolved.internalRootRealPath);
    const scanned = scanPackageFiles(root, resolved.rootRelativePath, physicalRegistry);
    const metadata = strictJson(scanned.packageJsonBytes, resolved.packageJsonRelativePath);
    if (metadata.name !== request.name || typeof metadata.version !== "string" || metadata.version.length === 0) {
      fail("qualification_package_metadata_invalid");
    }
    const dependencies = byteSort(Object.keys(metadata.dependencies ?? {}));
    pending.push(...dependencies.map((dependency) => ({
      name: dependency,
      basePackageJson: resolve(root, resolved.packageJsonRelativePath)
    })));
    pending.sort((left, right) => byteCompare(left.name, right.name));
    const common = Object.freeze({
      name: request.name,
      version: metadata.version,
      packageJsonSha256: sha256(scanned.packageJsonBytes),
      declaredRuntimeDependencies: Object.freeze(dependencies),
      fileCount: scanned.files.length,
      byteLength: scanned.files.reduce((total, file) => total + file.byteLength, 0),
      treeIdentity: canonicalHash(scanned.files),
      files: scanned.files
    });
    packages.push(packageRecord(common, packageDetail));
  }
  return Object.freeze(packages.toSorted((left, right) => byteCompare(left.name, right.name)));
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.uid === right.uid && left.gid === right.gid && left.nlink === right.nlink &&
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function nodeIdentity(nodeDetail) {
  const lexicalPath = resolve(process.execPath);
  const realPath = realpathSync(lexicalPath);
  const lexicalBefore = lstatSync(lexicalPath, { bigint: true, throwIfNoEntry: false });
  if (!lexicalBefore?.isFile() || lexicalBefore.isSymbolicLink() || lexicalBefore.nlink !== 1n ||
    lexicalPath !== realPath || (lexicalBefore.mode & 0o111n) === 0n ||
    !Array.isArray(process.execArgv) || process.execArgv.some((entry) => typeof entry !== "string")) {
    fail("qualification_node_invocation_invalid");
  }
  let descriptor;
  try {
    descriptor = openSync(realPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedBefore = fstatSync(descriptor, { bigint: true });
    if (!sameFileIdentity(lexicalBefore, openedBefore)) fail("qualification_node_identity_changed");
    const bytes = readFileSync(descriptor);
    const openedAfter = fstatSync(descriptor, { bigint: true });
    const lexicalAfter = lstatSync(lexicalPath, { bigint: true, throwIfNoEntry: false });
    if (!lexicalAfter || !sameFileIdentity(openedBefore, openedAfter) ||
      !sameFileIdentity(lexicalBefore, lexicalAfter) || bytes.length !== Number(openedAfter.size)) {
      fail("qualification_node_identity_changed");
    }
    const common = Object.freeze({
      originClass: "host-runtime-executable",
      execArgv: Object.freeze([...process.execArgv]),
      byteLength: bytes.length,
      sha256: sha256(bytes)
    });
    const withoutIdentity = nodeDetail === "legacy" ? Object.freeze({
      ...common,
      version: process.version
    }) : Object.freeze({
      ...common,
      nodeVersion: process.version,
      v8Version: process.versions.v8,
      opensslVersion: process.versions.openssl,
      platform: process.platform,
      architecture: process.arch
    });
    return Object.freeze({ ...withoutIdentity, portableIdentity: canonicalHash(withoutIdentity) });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function disclosureKind(value, root) {
  if (value.includes(root)) return "repository-root-absolute-path";
  if (value.startsWith("file:///")) return "absolute-file-url";
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\")) {
    return "host-absolute-path";
  }
  return null;
}

function normalizedDisclosureValue(value, kind, root) {
  if (kind === "repository-root-absolute-path") return value.replaceAll(root, "<repository-root>");
  if (kind === "absolute-file-url") return "<absolute-file-url>";
  return "<host-absolute-path>";
}

function pointerToken(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

function scanDisclosure(value, pointer, startByte, root, findings) {
  if (typeof value === "string") {
    const encoded = JSON.stringify(value);
    const kind = disclosureKind(value, root);
    if (kind !== null) {
      findings.push(Object.freeze({
        jsonPointer: pointer,
        kind,
        normalizedIdentity: canonicalHash({
          kind,
          normalizedValue: normalizedDisclosureValue(value, kind, root)
        }),
        span: Object.freeze({
          startByte,
          endByte: startByte + Buffer.byteLength(encoded, "utf8")
        })
      }));
    }
    return Buffer.byteLength(encoded, "utf8");
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return Buffer.byteLength(canonicalJson(value), "utf8");
  }
  if (Array.isArray(value)) {
    let cursor = startByte + 1;
    for (let index = 0; index < value.length; index += 1) {
      cursor += scanDisclosure(value[index], `${pointer}/${index}`, cursor, root, findings);
      if (index + 1 < value.length) cursor += 1;
    }
    return cursor - startByte + 1;
  }
  if (value === null || typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    fail("qualification_portable_disclosure_value_invalid");
  }
  const keys = Object.keys(value).toSorted();
  let cursor = startByte + 1;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    cursor += Buffer.byteLength(JSON.stringify(key), "utf8") + 1;
    cursor += scanDisclosure(value[key], `${pointer}/${pointerToken(key)}`, cursor, root, findings);
    if (index + 1 < keys.length) cursor += 1;
  }
  return cursor - startByte + 1;
}

export function auditQualificationPortableDisclosure(value, repositoryRoot = ROOT) {
  const root = resolve(repositoryRoot);
  assertRepositoryRoot(root);
  const findings = [];
  const consumedBytes = scanDisclosure(value, "", 0, root, findings);
  if (consumedBytes !== Buffer.byteLength(canonicalJson(value), "utf8")) {
    fail("qualification_portable_disclosure_span_invalid");
  }
  return Object.freeze({
    schemaVersion: QUALIFICATION_PORTABLE_DISCLOSURE_SCHEMA_VERSION,
    normalizedRootIdentity: canonicalHash({
      originClass: "repository-root",
      normalizedIdentity: "<repository-root>"
    }),
    findingCount: findings.length,
    findings: Object.freeze(findings)
  });
}

function deriveTrustBase(root, lease) {
  const options = trustBaseDerivationOptions(lease);
  if (options.packageDetail !== "summary" && options.packageDetail !== "full") {
    fail("qualification_package_detail_invalid");
  }
  if (options.nodeDetail !== "complete" && options.nodeDetail !== "legacy") {
    fail("qualification_node_detail_invalid");
  }
  const physicalRegistry = newPhysicalRegistry();
  const withoutPortability = Object.freeze({
    schemaVersion: options.schemaVersion,
    originClass: "portable-repository-qualification-trust-base",
    ...(options.includeAuthorityOwner ? { authorityOwner: QUALIFICATION_AUTHORITY_OWNER } : {}),
    lease: Object.freeze({
      leaseId: options.lease.leaseId,
      leaseIdentity: options.lease.leaseIdentity,
      requiredUseCardinality: options.lease.requiredUseCardinality
    }),
    environmentBindings: Object.freeze({
      mode: options.lease.environmentPolicy.mode,
      names: Object.freeze([...options.lease.environmentPolicy.names])
    }),
    node: nodeIdentity(options.nodeDetail),
    ...(options.rootMetadataPaths.length > 0 ? {
      rootMetadata: Object.freeze(collectObservations(
        root,
        options.rootMetadataPaths,
        options.preserveRootMetadataOrder,
        physicalRegistry
      ).map((entry) => entry.record))
    } : {}),
    ...(options.packageRootsDerivedInternally ? { packageRootsDerivedInternally: true } : {}),
    packages: derivePackageClosure(root, options.rootPackages, options.packageDetail, physicalRegistry)
  });
  const portability = auditQualificationPortableDisclosure(withoutPortability, root);
  if (portability.findingCount !== 0) fail("qualification_portable_disclosure_detected");
  const withoutIdentity = Object.freeze({ ...withoutPortability, portability });
  return Object.freeze({ ...withoutIdentity, trustBaseIdentity: canonicalHash(withoutIdentity) });
}

export function createQualificationAuthority(repositoryRoot) {
  const root = resolve(repositoryRoot);
  assertRepositoryRoot(root);
  return Object.freeze({
    qualificationFileRecord(relativePath) {
      return qualificationFileObservation(root, relativePath).record;
    },
    readQualificationFile(relativePath) {
      return Buffer.from(qualificationFileObservation(root, relativePath).bytes);
    },
    collectQualificationFileRecords(relativePaths) {
      return Object.freeze(collectObservations(root, relativePaths, false).map((entry) => entry.record));
    },
    collectQualificationFileSnapshot(relativePaths) {
      return Object.freeze(collectObservations(root, relativePaths, false).map((entry) => Object.freeze({
        ...entry.record,
        bytes: Buffer.from(entry.bytes)
      })));
    },
    deriveQualificationTrustBase(lease) {
      return deriveTrustBase(root, lease);
    }
  });
}

export const createQualificationFileAuthority = createQualificationAuthority;

const DEFAULT_AUTHORITY = createQualificationAuthority(ROOT);

export function qualificationFileRecord(relativePath) {
  return DEFAULT_AUTHORITY.qualificationFileRecord(relativePath);
}

export function readQualificationFile(relativePath) {
  return DEFAULT_AUTHORITY.readQualificationFile(relativePath);
}

export function collectQualificationFileRecords(relativePaths) {
  return DEFAULT_AUTHORITY.collectQualificationFileRecords(relativePaths);
}

export function collectQualificationFileSnapshot(relativePaths) {
  return DEFAULT_AUTHORITY.collectQualificationFileSnapshot(relativePaths);
}

export function deriveQualificationTrustBase(lease) {
  return DEFAULT_AUTHORITY.deriveQualificationTrustBase(lease);
}
