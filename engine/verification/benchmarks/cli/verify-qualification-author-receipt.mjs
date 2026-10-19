import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { QUALIFICATION_PATHS } from "./interaction-command-job-qualification-paths.mjs";

export class AuthorReceiptError extends Error {
  constructor(code) {
    super(code);
    this.name = "AuthorReceiptError";
    this.code = code;
  }
}

function reject(code) {
  throw new AuthorReceiptError(code);
}

export function sha256(bytes) {
  return "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex");
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) =>
    JSON.stringify(key) + ":" + canonicalJson(value[key])
  ).join(",") + "}";
}

function isWhitespace(character) {
  return character === " " || character === "\n" || character === "\r" || character === "\t";
}

export function assertNoDuplicateJsonKeys(bytes) {
  const source = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes);
  let index = 0;

  function skipWhitespace() {
    while (index < source.length && isWhitespace(source[index])) index += 1;
  }

  function parseString() {
    if (source[index] !== '"') reject("json_string_expected");
    const start = index;
    index += 1;
    while (index < source.length) {
      const character = source[index];
      if (character === '"') {
        index += 1;
        try {
          return JSON.parse(source.slice(start, index));
        } catch {
          reject("json_string_invalid");
        }
      }
      if (character === "\\") {
        index += 1;
        if (index >= source.length) reject("json_escape_incomplete");
        if (source[index] === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(source.slice(index + 1, index + 5))) reject("json_unicode_escape_invalid");
          index += 5;
          continue;
        }
        if (!/["\\/bfnrt]/.test(source[index])) reject("json_escape_invalid");
        index += 1;
        continue;
      }
      if (source.charCodeAt(index) < 0x20) reject("json_control_character");
      index += 1;
    }
    reject("json_string_unterminated");
  }

  function parseNumber() {
    const match = source.slice(index).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
    if (!match) reject("json_number_invalid");
    index += match[0].length;
  }

  function parseArray() {
    index += 1;
    skipWhitespace();
    if (source[index] === "]") {
      index += 1;
      return;
    }
    while (true) {
      parseValue();
      skipWhitespace();
      if (source[index] === "]") {
        index += 1;
        return;
      }
      if (source[index] !== ",") reject("json_array_separator");
      index += 1;
      skipWhitespace();
    }
  }

  function parseObject() {
    index += 1;
    skipWhitespace();
    const keys = new Set();
    if (source[index] === "}") {
      index += 1;
      return;
    }
    while (true) {
      const key = parseString();
      if (keys.has(key)) reject("json_duplicate_key");
      keys.add(key);
      skipWhitespace();
      if (source[index] !== ":") reject("json_object_colon");
      index += 1;
      parseValue();
      skipWhitespace();
      if (source[index] === "}") {
        index += 1;
        return;
      }
      if (source[index] !== ",") reject("json_object_separator");
      index += 1;
      skipWhitespace();
    }
  }

  function parseValue() {
    skipWhitespace();
    if (source[index] === "{") return parseObject();
    if (source[index] === "[") return parseArray();
    if (source[index] === '"') return void parseString();
    if (source.startsWith("true", index)) return void (index += 4);
    if (source.startsWith("false", index)) return void (index += 5);
    if (source.startsWith("null", index)) return void (index += 4);
    parseNumber();
  }

  parseValue();
  skipWhitespace();
  if (index !== source.length) reject("json_trailing_bytes");
}

function parseJson(bytes) {
  assertNoDuplicateJsonKeys(bytes);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    reject("json_parse_invalid");
  }
}

function assertKeys(value, keys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject(code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) reject(code);
}

function resolveInsideRoot(rootRealpath, relativePath) {
  if (path.isAbsolute(relativePath)) reject("receipt_path_absolute");
  const parts = relativePath.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) reject("receipt_path_segment");
  let current = rootRealpath;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) reject("receipt_path_symlink");
  }
  const realpath = fs.realpathSync(current);
  if (!realpath.startsWith(rootRealpath + path.sep)) reject("receipt_path_outside_root");
  return realpath;
}

function walkRegularFiles(rootRealpath, relativeRoot) {
  const root = resolveInsideRoot(rootRealpath, relativeRoot);
  const paths = [];
  function visit(directory, relativeDirectory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) reject("receipt_tree_symlink");
      if (entry.isDirectory()) visit(absolutePath, relativePath);
      else if (entry.isFile()) paths.push(relativePath);
      else reject("receipt_tree_special_file");
    }
  }
  visit(root, relativeRoot);
  return paths.sort();
}

export function collectTreeReceipt(rootRealpath, relativeRoot) {
  const files = walkRegularFiles(rootRealpath, relativeRoot).map((relativePath) => {
    const bytes = fs.readFileSync(resolveInsideRoot(rootRealpath, relativePath));
    return { relativePath: relativePath.slice(relativeRoot.length + 1), byteLength: bytes.length, sha256: sha256(bytes) };
  });
  return {
    fileCount: files.length,
    byteLength: files.reduce((total, file) => total + file.byteLength, 0),
    treeIdentity: sha256(Buffer.from(canonicalJson(files), "utf8"))
  };
}

export function collectGovernedFileReceipts(rootRealpath) {
  const paths = [
    ...QUALIFICATION_PATHS.governedSourcePaths,
    ...QUALIFICATION_PATHS.governedInputPaths,
    ...walkRegularFiles(rootRealpath, QUALIFICATION_PATHS.packageRoot)
  ].sort();
  return paths.map((relativePath) => {
    const bytes = fs.readFileSync(resolveInsideRoot(rootRealpath, relativePath));
    return { relativePath, byteLength: bytes.length, sha256: sha256(bytes) };
  });
}

function assertFileReceipt(rootRealpath, receipt) {
  assertKeys(receipt, ["relativePath", "byteLength", "sha256"], "receipt_file_shape");
  const bytes = fs.readFileSync(resolveInsideRoot(rootRealpath, receipt.relativePath));
  if (receipt.byteLength !== bytes.length || receipt.sha256 !== sha256(bytes)) reject("receipt_file_identity");
}

function fileIdentity(receipt, relativePath) {
  const entry = receipt.governedFiles.find((candidate) => candidate.relativePath === relativePath);
  if (!entry) reject("receipt_subject_path_missing");
  return entry.sha256;
}

export function assertAuthorReceiptPin(receiptBytes, pinText) {
  const match = pinText.match(/^([0-9a-f]{64})  ([^\r\n]+)\n$/u);
  if (!match || match[2] !== QUALIFICATION_PATHS.authorReceiptPath) reject("author_pin_shape");
  if ("sha256:" + match[1] !== sha256(receiptBytes)) reject("author_receipt_pin");
}

export function verifyAuthorReceipt({ root = QUALIFICATION_PATHS.rootRealpath } = {}) {
  const rootRealpath = fs.realpathSync(root);
  if (rootRealpath !== QUALIFICATION_PATHS.rootRealpath) reject("receipt_root_realpath");
  const receiptBytes = fs.readFileSync(resolveInsideRoot(rootRealpath, QUALIFICATION_PATHS.authorReceiptPath));
  const pinText = fs.readFileSync(resolveInsideRoot(rootRealpath, QUALIFICATION_PATHS.authorPinPath), "utf8");
  assertAuthorReceiptPin(receiptBytes, pinText);
  const receipt = parseJson(receiptBytes);

  assertKeys(receipt, ["schemaVersion", "status", "observedAt", "rootBinding", "runtime", "packageContract", "governedFiles", "dependencyTrees", "subjectIdentities", "claims"], "author_receipt_shape");
  if (receipt.schemaVersion !== "cli-qualification-author-receipt/v1" || receipt.status !== "author-snapshot-unadmitted-external-pin") reject("author_receipt_version");
  assertKeys(receipt.rootBinding, ["resolverVersion", "expectedRealpath", "identity"], "receipt_root_shape");
  const expectedRootIdentity = sha256(Buffer.from(QUALIFICATION_PATHS.rootResolverVersion + "\0" + rootRealpath, "utf8"));
  if (receipt.rootBinding.resolverVersion !== QUALIFICATION_PATHS.rootResolverVersion || receipt.rootBinding.expectedRealpath !== rootRealpath || receipt.rootBinding.identity !== expectedRootIdentity) reject("receipt_root_identity");

  if (!Array.isArray(receipt.governedFiles)) reject("receipt_files_shape");
  const expectedPaths = collectGovernedFileReceipts(rootRealpath).map((entry) => entry.relativePath);
  const actualPaths = receipt.governedFiles.map((entry) => entry.relativePath);
  if (actualPaths.length !== expectedPaths.length || actualPaths.some((value, index) => value !== expectedPaths[index])) reject("receipt_file_universe");
  for (const file of receipt.governedFiles) assertFileReceipt(rootRealpath, file);

  assertKeys(receipt.packageContract, ["packageJsonIdentity", "packageLockIdentity", "dependencyNames"], "receipt_package_shape");
  if (receipt.packageContract.packageJsonIdentity !== fileIdentity(receipt, "package.json") || receipt.packageContract.packageLockIdentity !== fileIdentity(receipt, "package-lock.json")) reject("receipt_package_identity");
  if (canonicalJson(receipt.packageContract.dependencyNames) !== canonicalJson(QUALIFICATION_PATHS.dependencyPackageNames)) reject("receipt_dependency_names");

  if (!Array.isArray(receipt.dependencyTrees) || receipt.dependencyTrees.length !== QUALIFICATION_PATHS.dependencyPackageNames.length) reject("receipt_dependency_shape");
  for (let index = 0; index < receipt.dependencyTrees.length; index += 1) {
    const dependency = receipt.dependencyTrees[index];
    const packageName = QUALIFICATION_PATHS.dependencyPackageNames[index];
    assertKeys(dependency, ["packageName", "packageVersion", "packageJsonIdentity", "fileCount", "byteLength", "treeIdentity"], "receipt_dependency_entry_shape");
    if (dependency.packageName !== packageName) reject("receipt_dependency_order");
    const relativeRoot = "node_modules/" + packageName;
    const packageBytes = fs.readFileSync(resolveInsideRoot(rootRealpath, relativeRoot + "/package.json"));
    const packageJson = parseJson(packageBytes);
    const tree = collectTreeReceipt(rootRealpath, relativeRoot);
    if (dependency.packageVersion !== packageJson.version || dependency.packageJsonIdentity !== sha256(packageBytes) || dependency.fileCount !== tree.fileCount || dependency.byteLength !== tree.byteLength || dependency.treeIdentity !== tree.treeIdentity) reject("receipt_dependency_identity");
  }

  assertKeys(receipt.runtime, ["nodeExecutable", "nodeVersion", "v8Version", "opensslVersion", "platform", "architecture"], "receipt_runtime_shape");
  assertKeys(receipt.runtime.nodeExecutable, ["path", "realpath", "byteLength", "sha256"], "receipt_node_executable_shape");
  const executableRealpath = fs.realpathSync(process.execPath);
  const executableBytes = fs.readFileSync(executableRealpath);
  if (receipt.runtime.nodeExecutable.path !== process.execPath || receipt.runtime.nodeExecutable.realpath !== executableRealpath || receipt.runtime.nodeExecutable.byteLength !== executableBytes.length || receipt.runtime.nodeExecutable.sha256 !== sha256(executableBytes) || receipt.runtime.nodeVersion !== process.version || receipt.runtime.v8Version !== process.versions.v8 || receipt.runtime.opensslVersion !== process.versions.openssl || receipt.runtime.platform !== process.platform || receipt.runtime.architecture !== process.arch) reject("receipt_runtime_identity");

  assertKeys(receipt.subjectIdentities, ["validator", "sharedVerifier", "schema", "catalog", "document", "root"], "receipt_subject_shape");
  const subjects = {
    validator: QUALIFICATION_PATHS.validatorPath,
    sharedVerifier: QUALIFICATION_PATHS.sharedVerifierPath,
    schema: QUALIFICATION_PATHS.schemaPath,
    catalog: QUALIFICATION_PATHS.catalogPath,
    document: QUALIFICATION_PATHS.documentPath
  };
  for (const [name, relativePath] of Object.entries(subjects)) {
    assertKeys(receipt.subjectIdentities[name], ["relativePath", "identity"], "receipt_subject_entry_shape");
    if (receipt.subjectIdentities[name].relativePath !== relativePath || receipt.subjectIdentities[name].identity !== fileIdentity(receipt, relativePath)) reject("receipt_subject_identity");
  }
  if (receipt.subjectIdentities.root !== expectedRootIdentity) reject("receipt_subject_root_identity");

  assertKeys(receipt.claims, ["architectureRegistered", "artifactAdmitted", "independentlyAccepted", "runtimeQualified", "externalPinRequired", "serializedReceiptConfersAuthority"], "receipt_claims_shape");
  if (receipt.claims.architectureRegistered !== false || receipt.claims.artifactAdmitted !== false || receipt.claims.independentlyAccepted !== false || receipt.claims.runtimeQualified !== false || receipt.claims.externalPinRequired !== true || receipt.claims.serializedReceiptConfersAuthority !== false) reject("receipt_claims");
  return Object.freeze({ receipt, receiptIdentity: sha256(receiptBytes), rootRealpath });
}
