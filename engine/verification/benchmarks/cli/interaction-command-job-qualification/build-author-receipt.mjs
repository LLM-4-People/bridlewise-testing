#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { QUALIFICATION_PATHS } from "../interaction-command-job-qualification-paths.mjs";
import {
  collectGovernedFileReceipts,
  collectTreeReceipt,
  sha256
} from "../verify-qualification-author-receipt.mjs";

class ReceiptBuildError extends Error {
  constructor(code) {
    super(code);
    this.name = "ReceiptBuildError";
    this.code = code;
  }
}

function reject(code) {
  throw new ReceiptBuildError(code);
}

function readInsideRoot(rootRealpath, relativePath) {
  if (path.isAbsolute(relativePath) || relativePath.split("/").some((part) => !part || part === "." || part === "..")) reject("path_invalid");
  const absolutePath = path.resolve(rootRealpath, relativePath);
  if (!absolutePath.startsWith(rootRealpath + path.sep) || fs.lstatSync(absolutePath).isSymbolicLink()) reject("path_invalid");
  return fs.readFileSync(absolutePath);
}

function identityFor(files, relativePath) {
  const entry = files.find((file) => file.relativePath === relativePath);
  if (!entry) reject("governed_file_missing");
  return entry.sha256;
}

function dependencyReceipt(rootRealpath, packageName) {
  const packageRoot = "node_modules/" + packageName;
  const packageBytes = readInsideRoot(rootRealpath, packageRoot + "/package.json");
  const packageJson = JSON.parse(packageBytes);
  return {
    packageName,
    packageVersion: packageJson.version,
    packageJsonIdentity: sha256(packageBytes),
    ...collectTreeReceipt(rootRealpath, packageRoot)
  };
}

function buildReceipt(rootRealpath) {
  const governedFiles = collectGovernedFileReceipts(rootRealpath);
  const executableRealpath = fs.realpathSync(process.execPath);
  const executableBytes = fs.readFileSync(executableRealpath);
  const catalog = JSON.parse(readInsideRoot(rootRealpath, QUALIFICATION_PATHS.catalogPath));
  const rootIdentity = sha256(Buffer.from(QUALIFICATION_PATHS.rootResolverVersion + "\0" + rootRealpath, "utf8"));
  const subject = (relativePath) => ({ relativePath, identity: identityFor(governedFiles, relativePath) });
  return {
    schemaVersion: "cli-qualification-author-receipt/v1",
    status: "author-snapshot-unadmitted-external-pin",
    observedAt: catalog.observedAt,
    rootBinding: {
      resolverVersion: QUALIFICATION_PATHS.rootResolverVersion,
      expectedRealpath: rootRealpath,
      identity: rootIdentity
    },
    runtime: {
      nodeExecutable: {
        path: process.execPath,
        realpath: executableRealpath,
        byteLength: executableBytes.length,
        sha256: sha256(executableBytes)
      },
      nodeVersion: process.version,
      v8Version: process.versions.v8,
      opensslVersion: process.versions.openssl,
      platform: process.platform,
      architecture: process.arch
    },
    packageContract: {
      packageJsonIdentity: identityFor(governedFiles, "package.json"),
      packageLockIdentity: identityFor(governedFiles, "package-lock.json"),
      dependencyNames: [...QUALIFICATION_PATHS.dependencyPackageNames]
    },
    governedFiles,
    dependencyTrees: QUALIFICATION_PATHS.dependencyPackageNames.map((packageName) => dependencyReceipt(rootRealpath, packageName)),
    subjectIdentities: {
      validator: subject(QUALIFICATION_PATHS.validatorPath),
      sharedVerifier: subject(QUALIFICATION_PATHS.sharedVerifierPath),
      schema: subject(QUALIFICATION_PATHS.schemaPath),
      catalog: subject(QUALIFICATION_PATHS.catalogPath),
      document: subject(QUALIFICATION_PATHS.documentPath),
      root: rootIdentity
    },
    claims: {
      architectureRegistered: false,
      artifactAdmitted: false,
      independentlyAccepted: false,
      runtimeQualified: false,
      externalPinRequired: true,
      serializedReceiptConfersAuthority: false
    }
  };
}

function main() {
  if (process.argv.length !== 3 || process.argv[2] !== "--write") reject("arguments_invalid");
  const rootRealpath = fs.realpathSync(QUALIFICATION_PATHS.rootRealpath);
  if (rootRealpath !== QUALIFICATION_PATHS.rootRealpath) reject("root_identity");
  const outputPath = path.join(rootRealpath, QUALIFICATION_PATHS.authorReceiptPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const output = Buffer.from(JSON.stringify(buildReceipt(rootRealpath), null, 2) + "\n", "utf8");
  fs.writeFileSync(outputPath, output, { flag: "wx" });
  process.stdout.write(JSON.stringify({ status: "written-unadmitted", bytes: output.length, identity: sha256(output) }) + "\n");
}

try {
  main();
} catch (error) {
  const code = error instanceof ReceiptBuildError ? error.code : "author_receipt_builder_internal_error";
  process.stderr.write(JSON.stringify({ status: "invalid", code }) + "\n");
  process.exitCode = 1;
}
