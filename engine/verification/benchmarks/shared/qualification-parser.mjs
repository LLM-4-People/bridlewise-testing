import { createHash } from "node:crypto";
import { createRequire, findPackageJSON } from "node:module";
import { lstatSync, realpathSync } from "node:fs";
import { basename, relative, resolve, sep } from "node:path";

import { canonicalHash, canonicalJson, sha256 } from "../../../src/kernel/integrity.ts";
import { assertNoDuplicateJsonObjectKeys } from "../../../src/kernel/json-integrity.ts";
import { relativePathViolationKinds } from "../../../src/filesystem/path-boundary.ts";
import { ROOT_POLICY } from "../../../src/kernel/root-policy.ts";
import {
  listSafeRepositoryTree,
  readSafeRepositoryFile
} from "../../../scripts/verification/safe-repository-reader.ts";
import { createUtf8OffsetMap, utf8ByteSpanFromMap } from "../../../src/text/utf8-offsets.ts";

export const QUALIFICATION_PARSER_PACKAGE_NAME = "@babel/parser";
export const QUALIFICATION_PARSER_BOUNDARY_SCHEMA_VERSION =
  "bridlewise-qualification-parser-boundary/v1";
export const QUALIFICATION_PARSER_SOURCE_EXTENSIONS = Object.freeze([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx"
]);

const MAXIMUM_FILE_BYTES = ROOT_POLICY.verification.testDiscovery.maximumSourceBytes;
const TREE_LIMITS = Object.freeze({
  maximumDepth: ROOT_POLICY.verification.testDiscovery.maximumDepth,
  maximumEntries: ROOT_POLICY.verification.testDiscovery.maximumEntries
});
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function assertRepositoryRoot(root) {
  const stats = lstatSync(root, { bigint: true, throwIfNoEntry: false });
  if (!stats?.isDirectory() || stats.isSymbolicLink() || realpathSync(root) !== root) {
    fail("qualification_parser_repository_root_unsafe");
  }
}

function canonicalRepositoryRelativePath(root, input, allowDirectory = false) {
  if (typeof input !== "string" || input.normalize("NFC") !== input ||
    relativePathViolationKinds(input).length > 0) {
    fail("qualification_parser_path_invalid");
  }
  const absolutePath = resolve(root, input);
  const roundTrip = relative(root, absolutePath).split(sep).join("/");
  if (roundTrip !== input || absolutePath === root && !allowDirectory ||
    absolutePath !== root && !absolutePath.startsWith(root + sep)) {
    fail("qualification_parser_path_outside_root");
  }
  return Object.freeze({ relativePath: input, absolutePath });
}

function strictJson(bytes, sourceId) {
  const text = STRICT_UTF8.decode(bytes);
  if (text.codePointAt(0) === 0xfeff || text.includes("\0")) {
    fail("qualification_parser_json_encoding_invalid");
  }
  assertNoDuplicateJsonObjectKeys(
    text,
    `${sourceId} contains duplicate JSON keys`,
    "qualification_parser_json_duplicate_key"
  );
  const value = JSON.parse(text);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("qualification_parser_json_shape_invalid");
  }
  return value;
}

function fileObservation(root, relativePath) {
  const path = canonicalRepositoryRelativePath(root, relativePath);
  const read = readSafeRepositoryFile(root, path.relativePath, MAXIMUM_FILE_BYTES);
  if (read.realPath !== path.absolutePath) fail("qualification_parser_file_physical_alias");
  return Object.freeze({
    relativePath: path.relativePath,
    byteLength: read.bytes.length,
    sha256: sha256(read.bytes),
    bytes: Buffer.from(read.bytes)
  });
}

function publicFileRecord(observation) {
  return Object.freeze({
    relativePath: observation.relativePath,
    byteLength: observation.byteLength,
    sha256: observation.sha256
  });
}

function byteSort(values) {
  return values.toSorted((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
  );
}

function scanPackage(root, packageRootRelativePath) {
  canonicalRepositoryRelativePath(root, packageRootRelativePath, true);
  const before = listSafeRepositoryTree(root, packageRootRelativePath, TREE_LIMITS);
  const paths = before.filter((entry) => entry.kind === "file").map((entry) => entry.path);
  if (paths.length === 0) fail("qualification_parser_package_empty");
  const files = byteSort(paths).map((path) => fileObservation(root, path));
  const after = listSafeRepositoryTree(root, packageRootRelativePath, TREE_LIMITS);
  if (canonicalJson(before) !== canonicalJson(after)) fail("qualification_parser_package_tree_changed");
  const relativeFiles = files.map((file) => Object.freeze({
    relativePath: file.relativePath.slice(packageRootRelativePath.length + 1),
    byteLength: file.byteLength,
    sha256: file.sha256
  }));
  return Object.freeze({
    observations: Object.freeze(files),
    records: Object.freeze(relativeFiles),
    fileCount: relativeFiles.length,
    byteLength: relativeFiles.reduce((sum, file) => sum + file.byteLength, 0),
    treeIdentity: canonicalHash(relativeFiles)
  });
}

function requireLockEntry(lock, packagePath) {
  const entry = lock.packages?.[packagePath];
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    fail("qualification_parser_lock_entry_missing");
  }
  return entry;
}

function sameLockBinding(left, right, metadata) {
  return left.version === metadata.version && right.version === metadata.version &&
    left.license === metadata.license && right.license === metadata.license &&
    typeof left.integrity === "string" && left.integrity.length > 0 &&
    left.integrity === right.integrity;
}

function parserPlugins(relativePath) {
  const plugins = [];
  if (/\.(?:ts|mts|cts|tsx)$/u.test(relativePath)) {
    plugins.push(["typescript", {
      dts: /\.d\.(?:ts|mts|cts)$/u.test(relativePath)
    }]);
  }
  if (/\.(?:jsx|tsx)$/u.test(relativePath)) plugins.push("jsx");
  return plugins;
}

function sourceText(input) {
  const text = typeof input === "string" ? input :
    input instanceof Uint8Array ? STRICT_UTF8.decode(input) : null;
  if (text === null || text.codePointAt(0) === 0xfeff || text.includes("\0")) {
    fail("qualification_parser_source_encoding_invalid");
  }
  return text;
}

function parseBinding(root) {
  const rootPackage = fileObservation(root, "package.json");
  const rootLock = fileObservation(root, "package-lock.json");
  const installedLock = fileObservation(root, "node_modules/.package-lock.json");
  const rootPackageValue = strictJson(rootPackage.bytes, rootPackage.relativePath);
  const rootLockValue = strictJson(rootLock.bytes, rootLock.relativePath);
  const installedLockValue = strictJson(installedLock.bytes, installedLock.relativePath);
  const loader = createRequire(resolve(root, "package.json"));
  const locatedPackageJson = findPackageJSON("@babel/parser", resolve(root, "package.json"));
  if (locatedPackageJson === undefined) fail("qualification_parser_package_resolution_missing");
  const packageJsonAbsolute = realpathSync(locatedPackageJson);
  const packageJsonRelativePath = relative(root, packageJsonAbsolute).split(sep).join("/");
  canonicalRepositoryRelativePath(root, packageJsonRelativePath);
  if (!packageJsonRelativePath.endsWith("/package.json")) fail("qualification_parser_package_root_invalid");
  const packageRootRelativePath = packageJsonRelativePath.slice(0, -"/package.json".length);
  const packagePath = packageRootRelativePath;
  const packageJson = fileObservation(root, packageJsonRelativePath);
  const metadata = strictJson(packageJson.bytes, packageJson.relativePath);
  if (typeof metadata.main !== "string" || metadata.main.length === 0) {
    fail("qualification_parser_entry_metadata_invalid");
  }
  const lexicalEntryAbsolute = resolve(root, packageRootRelativePath, metadata.main);
  const resolvedEntryAbsolute = realpathSync(lexicalEntryAbsolute);
  if (lexicalEntryAbsolute !== resolvedEntryAbsolute) fail("qualification_parser_entry_physical_alias");
  const entryRelativePath = relative(root, resolvedEntryAbsolute).split(sep).join("/");
  canonicalRepositoryRelativePath(root, entryRelativePath);
  if (!entryRelativePath.startsWith(packageRootRelativePath + "/")) {
    fail("qualification_parser_entry_outside_package");
  }
  const packageScan = scanPackage(root, packageRootRelativePath);
  const entry = packageScan.observations.find((file) => file.relativePath === entryRelativePath);
  const licenses = packageScan.observations.filter((file) =>
    /^(?:licen[cs]e|copying)(?:[._-].*)?$/iu.test(basename(file.relativePath))
  );
  if (entry === undefined || licenses.length !== 1 || metadata.name !== QUALIFICATION_PARSER_PACKAGE_NAME ||
    typeof metadata.version !== "string" || metadata.version.length === 0 ||
    typeof metadata.license !== "string" || metadata.license.length === 0 ||
    rootPackageValue.devDependencies?.[QUALIFICATION_PARSER_PACKAGE_NAME] === undefined) {
    fail("qualification_parser_package_binding_invalid");
  }
  const rootLockEntry = requireLockEntry(rootLockValue, packagePath);
  const installedLockEntry = requireLockEntry(installedLockValue, packagePath);
  if (!sameLockBinding(rootLockEntry, installedLockEntry, metadata)) {
    fail("qualification_parser_lock_binding_invalid");
  }
  const withoutIdentity = Object.freeze({
    schemaVersion: QUALIFICATION_PARSER_BOUNDARY_SCHEMA_VERSION,
    originClass: "installed-development-dependency",
    packageName: QUALIFICATION_PARSER_PACKAGE_NAME,
    version: metadata.version,
    licenseExpression: metadata.license,
    packagePath,
    packageJson: publicFileRecord(packageJson),
    resolvedEntry: publicFileRecord(entry),
    license: publicFileRecord(licenses[0]),
    rootPackage: publicFileRecord(rootPackage),
    rootLock: publicFileRecord(rootLock),
    installedLock: publicFileRecord(installedLock),
    installedPackage: Object.freeze({
      fileCount: packageScan.fileCount,
      byteLength: packageScan.byteLength,
      treeIdentity: packageScan.treeIdentity
    }),
    parserOptions: Object.freeze({
      sourceType: "unambiguous",
      errorRecovery: false,
      attachComment: false,
      ranges: true,
      tokens: false,
      createImportExpressions: true
    })
  });
  const loaded = loader("@babel/parser");
  if (typeof loaded.parse !== "function") fail("qualification_parser_entry_api_invalid");
  return Object.freeze({
    binding: Object.freeze({
      ...withoutIdentity,
      parserBoundaryIdentity: canonicalHash(withoutIdentity)
    }),
    parse: loaded.parse
  });
}

export function createQualificationParserBoundary(repositoryRoot) {
  const root = resolve(repositoryRoot);
  assertRepositoryRoot(root);
  const parser = parseBinding(root);
  return Object.freeze({
    binding: parser.binding,
    parseModule(input, relativePath) {
      canonicalRepositoryRelativePath(root, relativePath);
      if (!QUALIFICATION_PARSER_SOURCE_EXTENSIONS.some((extension) => relativePath.endsWith(extension))) {
        fail("qualification_parser_source_extension_unsupported");
      }
      const text = sourceText(input);
      if (Buffer.byteLength(text, "utf8") > MAXIMUM_FILE_BYTES) {
        fail("qualification_parser_source_byte_limit");
      }
      let parsed;
      try {
        parsed = parser.parse(text, {
          sourceType: "unambiguous",
          sourceFilename: relativePath,
          plugins: parserPlugins(relativePath),
          errorRecovery: false,
          attachComment: false,
          ranges: true,
          tokens: false,
          createImportExpressions: true
        });
      } catch {
        fail("qualification_parser_source_parse_failed");
      }
      if (parsed?.program?.type !== "Program" || parsed.errors?.length > 0) {
        fail("qualification_parser_source_parse_failed");
      }
      return Object.freeze({
        source: text,
        sourceSha256: createHash("sha256").update(text, "utf8").digest("hex"),
        program: parsed.program,
        offsetMap: createUtf8OffsetMap(text)
      });
    }
  });
}

export function astNode(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    typeof value.type === "string" ? value : undefined;
}

export function astNodeArray(value) {
  return Array.isArray(value) ? value.map(astNode).filter((entry) => entry !== undefined) : [];
}

export function astChildren(node) {
  const children = [];
  for (const [key, value] of Object.entries(node)) {
    if (["loc", "start", "end", "range", "extra", "errors", "comments", "tokens"].includes(key)) continue;
    const direct = astNode(value);
    if (direct) children.push(direct);
    else if (Array.isArray(value)) {
      for (const entry of value) {
        const child = astNode(entry);
        if (child) children.push(child);
      }
    }
  }
  return children;
}

export function portableAstSpan(node, offsetMap) {
  if (!Number.isSafeInteger(node?.start) || !Number.isSafeInteger(node?.end) ||
    node.start < 0 || node.end < node.start || !Number.isSafeInteger(node.loc?.start?.line) ||
    !Number.isSafeInteger(node.loc?.start?.column) || !Number.isSafeInteger(node.loc?.end?.line) ||
    !Number.isSafeInteger(node.loc?.end?.column)) {
    fail("qualification_parser_ast_span_invalid");
  }
  const byteSpan = utf8ByteSpanFromMap(offsetMap, node.start, node.end);
  return Object.freeze({
    startByte: byteSpan.startByte,
    endByte: byteSpan.endByte,
    startLine: node.loc.start.line,
    startColumn: node.loc.start.column,
    endLine: node.loc.end.line,
    endColumn: node.loc.end.column
  });
}
