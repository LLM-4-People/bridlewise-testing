import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import Ajv2020 from "ajv/dist/2020.js";

import { canonicalJson, sha256 } from "../../../../src/kernel/integrity.ts";
import { assertNoDuplicateJsonObjectKeys } from "../../../../src/kernel/json-integrity.ts";
import {
  ensureReceiptAuthority,
  readImmutableEvidence,
  remediateImmutableEvidenceMode,
  writeImmutableEvidence,
} from "../../../../src/filesystem/immutable-receipt.ts";
import {
  assertPinnedArtifactBytes,
  assertPinnedVerifierTrustBase,
  validateAuthorContracts,
} from "./validate-contracts.mjs";
import {
  MIGRATION_WRITE_AUTHORITY_RECEIPT_CONTRACT,
  MIGRATION_WRITE_AUTHORITY_RECEIPT_COMMAND_EFFECTS,
  trustCanonicalHash,
  trustSha256
} from "./author-trust-base.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT_PATH), "../../../..");
const RECEIPT_RELATIVE_PATH = MIGRATION_WRITE_AUTHORITY_RECEIPT_CONTRACT.receiptRelativePath;
const CONTRACT_RELATIVE_PATH =
  "verification/benchmarks/coordination/migration-write-authority/qualification-contract.v2.json";
const CONTRACT_SCHEMA_RELATIVE_PATH =
  "verification/benchmarks/coordination/migration-write-authority/schemas/qualification-contract.schema.json";
const RECEIPT_SCHEMA_RELATIVE_PATH = MIGRATION_WRITE_AUTHORITY_RECEIPT_CONTRACT.schemaRelativePath;

function fail(code, detail) {
  throw new Error(`${code}:${detail}`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function argumentsMap(argv) {
  const values = new Map();
  for (const argument of argv) {
    const separator = argument.indexOf("=");
    if (!argument.startsWith("--") || separator < 3) fail("argument_invalid", argument);
    const key = argument.slice(2, separator);
    if (!["expected-author-receipt-sha256", "write-evidence"].includes(key) || values.has(key)) {
      fail("argument_invalid", argument);
    }
    values.set(key, argument.slice(separator + 1));
  }
  const expectedSha = values.get("expected-author-receipt-sha256");
  if (!/^[0-9a-f]{64}$/u.test(expectedSha ?? "")) fail("expected_receipt_hash_invalid", String(expectedSha));
  if (values.has("write-evidence") && !["false", "true"].includes(values.get("write-evidence"))) {
    fail("argument_invalid", `write-evidence=${values.get("write-evidence")}`);
  }
  return values;
}

function expectSchemaBlocked(name, baseline, mutate, validate) {
  const candidate = clone(baseline);
  mutate(candidate);
  if (validate(candidate)) fail("contract_mutant_false_green", name);
  return { name, boundary: "closed-qualification-contract-schema", blocked: true };
}

function expectReceiptSchemaBlocked(name, baseline, mutate, validate) {
  const candidate = clone(baseline);
  mutate(candidate);
  if (validate(candidate)) fail("receipt_schema_mutant_false_green", name);
  return { name, boundary: "externally-pinned-author-receipt-schema", blocked: true };
}

function expectReceiptPathBlocked(name, relativePath, expectedCode, expectedReceiptSha) {
  try {
    validateAuthorContracts(new Map([
      ["author-receipt", relativePath],
      ["expected-author-receipt-sha256", expectedReceiptSha],
    ]));
  } catch (error) {
    const diagnosticCode = String(error.message).split(":", 1)[0];
    if (diagnosticCode !== expectedCode) throw error;
    return {
      name,
      boundary: "author-receipt-path-before-dereference",
      blocked: true,
      diagnosticCode,
    };
  }
  fail("receipt_path_mutant_false_green", name);
}

function expectArtifactPinBlocked(name, receipt, relativePath, mutateBytes) {
  const binding = receipt.artifacts.find((entry) => entry.relativePath === relativePath);
  if (!binding) fail("receipt_binding_missing", relativePath);
  const mutated = mutateBytes(readFileSync(resolve(ROOT, relativePath)));
  try {
    assertPinnedArtifactBytes(binding, mutated);
  } catch (error) {
    return {
      name,
      boundary: "externally-pinned-author-receipt-artifact",
      blocked: true,
      diagnosticCode: String(error.message).split(":", 1)[0],
    };
  }
  fail("artifact_pin_mutant_false_green", name);
}

function sameLengthMutation(bytes) {
  const mutated = Buffer.from(bytes);
  mutated[0] ^= 1;
  return mutated;
}

function expectPackageContentPinBlocked(name, receipt, packageName, relativePath) {
  const derived = clone(receipt.verifierTrustBase);
  const packageRecord = derived.packages.find((entry) => entry.name === packageName);
  if (!packageRecord) fail("trust_package_missing", packageName);
  const file = packageRecord.files.find((entry) => entry.relativePath === relativePath);
  if (!file) fail("trust_package_file_missing", `${packageName}:${relativePath}`);
  file.sha256 = `${file.sha256[0] === "0" ? "1" : "0"}${file.sha256.slice(1)}`;
  packageRecord.contentIdentity = trustCanonicalHash(packageRecord.files);
  const packageWithoutIdentity = clone(packageRecord);
  delete packageWithoutIdentity.portableIdentity;
  packageRecord.portableIdentity = trustCanonicalHash(packageWithoutIdentity);
  const withoutIdentity = clone(derived);
  delete withoutIdentity.trustBaseIdentity;
  derived.trustBaseIdentity = trustCanonicalHash(withoutIdentity);
  try {
    assertPinnedVerifierTrustBase(receipt.verifierTrustBase, derived);
  } catch (error) {
    return {
      name,
      boundary: "internally-derived-package-content-set",
      blocked: true,
      diagnosticCode: String(error.message).split(":", 1)[0],
    };
  }
  fail("package_content_mutant_false_green", name);
}

function expectRootMetadataPinBlocked(name, receipt, relativePath) {
  const derived = clone(receipt.verifierTrustBase);
  const file = derived.rootMetadata.find((entry) => entry.relativePath === relativePath);
  if (!file) fail("trust_root_metadata_missing", relativePath);
  file.sha256 = trustSha256(sameLengthMutation(readFileSync(resolve(ROOT, relativePath))));
  const withoutIdentity = clone(derived);
  delete withoutIdentity.trustBaseIdentity;
  derived.trustBaseIdentity = trustCanonicalHash(withoutIdentity);
  try {
    assertPinnedVerifierTrustBase(receipt.verifierTrustBase, derived);
  } catch (error) {
    return {
      name,
      boundary: "internally-derived-root-metadata-set",
      blocked: true,
      diagnosticCode: String(error.message).split(":", 1)[0],
    };
  }
  fail("root_metadata_mutant_false_green", name);
}

function publishContentAddressed(authority, bytes) {
  return writeImmutableEvidence(authority, {
    mode: "content-addressed",
    namespace: "objects",
    extension: ".json",
    bytes,
    contentKind: "canonical-json",
  });
}

function assertAppendOnlyPublisher() {
  const parent = mkdtempSync(resolve(tmpdir(), "mwa-content-addressed-scope-"));
  const root = mkdtempSync(resolve(parent, "authority-"));
  try {
    const bytes = Buffer.from("{\"probe\":\"append-only\"}\n", "utf8");
    const previousUmask = process.umask(0o777);
    let authority;
    let first;
    let second;
    try {
      authority = ensureReceiptAuthority(root, "evidence");
      first = publishContentAddressed(authority, bytes);
      second = publishContentAddressed(authority, bytes);
    } finally {
      process.umask(previousUmask);
    }
    if (first.disposition !== "created" || second.disposition !== "existing-identical" ||
      first.path !== second.path) fail("content_addressed_idempotency_invalid", first.sha256);
    const absolute = resolve(authority.absoluteRoot, first.path);
    for (const directory of [
      authority.absoluteRoot,
      resolve(authority.absoluteRoot, "objects"),
      resolve(authority.absoluteRoot, "objects/sha256"),
    ]) {
      if ((lstatSync(directory).mode & 0o7777) !== 0o700) {
        fail("content_addressed_directory_mode_invalid", directory);
      }
    }
    if ((lstatSync(absolute).mode & 0o7777) !== 0o600) {
      fail("content_addressed_file_mode_invalid", first.path);
    }
    let overwriteCode = null;
    try {
      writeImmutableEvidence(authority, {
        mode: "exclusive-path",
        path: first.path,
        bytes,
        contentKind: "canonical-json",
      });
    } catch (error) {
      overwriteCode = error.code;
    }
    if (overwriteCode !== "receipt_path_exists" ||
      !readImmutableEvidence(authority, first.path, "canonical-json").equals(bytes)) {
      fail("content_addressed_overwrite_not_blocked", String(overwriteCode));
    }
    chmodSync(absolute, 0o664);
    let unsafeModeCode = null;
    try {
      readImmutableEvidence(authority, first.path, "canonical-json");
    } catch (error) {
      unsafeModeCode = error.code;
    }
    if (unsafeModeCode !== "receipt_file_unsafe") {
      fail("content_addressed_unsafe_mode_false_green", String(unsafeModeCode));
    }
    const remediation = remediateImmutableEvidenceMode(authority, {
      path: first.path,
      contentKind: "canonical-json",
      expectedBeforeMode: 0o664,
      expectedByteLength: bytes.length,
      expectedSha256: first.sha256,
      authorizedReason: "hostile-fixture-authorized-mode-correction",
    });
    if (remediation.before.mode !== "0664" || remediation.after.mode !== "0600" ||
      remediation.beforeSha256 !== first.sha256 || remediation.afterSha256 !== first.sha256 ||
      remediation.byteHashUnchanged !== true ||
      !readImmutableEvidence(authority, first.path, "canonical-json").equals(bytes)) {
      fail("content_addressed_mode_remediation_invalid", first.path);
    }
    return [
      { name: "content-addressed-repeat-is-existing-identical", boundary: "append-only-publisher", blocked: true,
        temporaryEffectScope: "isolated-system-temporary-directory", repositoryTreeExcluded: true,
        cleanupRequired: true },
      { name: "content-addressed-overwrite-denied", boundary: "shared-immutable-receipt-authority", blocked: true,
        diagnosticCode: overwriteCode, temporaryEffectScope: "isolated-system-temporary-directory",
        repositoryTreeExcluded: true, cleanupRequired: true },
      { name: "content-addressed-hostile-umask-enforces-0700-and-0600", boundary: "shared-immutable-receipt-authority",
        blocked: true, temporaryEffectScope: "isolated-system-temporary-directory", repositoryTreeExcluded: true,
        cleanupRequired: true },
      { name: "content-addressed-0664-rejected-before-read", boundary: "shared-immutable-receipt-authority",
        blocked: true, diagnosticCode: unsafeModeCode, temporaryEffectScope: "isolated-system-temporary-directory",
        repositoryTreeExcluded: true, cleanupRequired: true },
      { name: "content-addressed-mode-remediation-preserves-bytes", boundary: "shared-immutable-receipt-authority",
        blocked: true, temporaryEffectScope: "isolated-system-temporary-directory", repositoryTreeExcluded: true,
        cleanupRequired: true },
    ];
  } finally {
    rmSync(root, { force: true, recursive: true });
    if (existsSync(root)) fail("temporary_effect_cleanup_failed", root);
    rmSync(parent, { force: true, recursive: true });
    if (existsSync(parent)) fail("temporary_effect_cleanup_failed", parent);
  }
}

function assertReceiptBuilderEffectContract() {
  const receiptPath = resolve(ROOT, RECEIPT_RELATIVE_PATH);
  const builderPath = resolve(ROOT, MIGRATION_WRITE_AUTHORITY_RECEIPT_CONTRACT.builderRelativePath);
  const before = receiptSnapshot(receiptPath);
  const blockedFixtures = [
    [["--effect-mode=write"], "production_migration_write_authority_unavailable"],
    [["--write"], "command_effect_arguments_invalid"],
    [["--effect-mode=unknown"], "command_effect_mode_unknown"],
    [["--effect-mode=check", "unexpected"], "command_effect_arguments_invalid"]
  ];
  const execution = withTemporaryWorkingTree("mwa-builder-absent-tree-", (workingTree) => {
    const treeBefore = completeTreeSnapshot(workingTree);
    const run = (argumentsList) => spawnSync(process.execPath, [builderPath, ...argumentsList], {
      cwd: workingTree,
      encoding: null,
      env: {},
      maxBuffer: 2 * 1024 * 1024
    });
    const result = {
      defaultDerive: run([]),
      explicitDerive: run(["--effect-mode=derive"]),
      check: run(["--effect-mode=check"]),
      blocked: blockedFixtures.map(([argumentsList]) => run(argumentsList)),
    };
    const treeAfter = completeTreeSnapshot(workingTree);
    if (!isDeepStrictEqual(treeAfter, treeBefore)) {
      fail("receipt_builder_absent_working_tree_mutated", workingTree);
    }
    return result;
  });
  const { defaultDerive, explicitDerive, check } = execution;
  for (const result of [defaultDerive, explicitDerive]) {
    if (result.error || result.status !== 0 || !result.stdout.equals(before.bytes) || result.stderr.length !== 0) {
      fail("receipt_builder_read_only_derivation_invalid", String(result.error ?? result.status));
    }
  }
  if (check.error || check.status !== 0 || check.stderr.length !== 0) {
    fail("receipt_builder_read_only_check_invalid", String(check.error ?? check.status));
  }
  const checkResult = JSON.parse(check.stdout.toString("utf8"));
  if (checkResult.status !== "current-read-only" || checkResult.effectMode !== "check" ||
    checkResult.expectedAuthorReceiptSha256 !== trustSha256(before.bytes)) {
    fail("receipt_builder_read_only_check_output_invalid", check.stdout.toString("utf8"));
  }
  const blocked = blockedFixtures.map(([argumentsList, expectedCode], index) => {
    const result = execution.blocked[index];
    let output;
    try {
      output = JSON.parse(result.stderr.toString("utf8"));
    } catch {
      fail("receipt_builder_blocked_mode_output_invalid", result.stderr.toString("utf8"));
    }
    if (result.error || result.status !== 1 || result.stdout.length !== 0 ||
      output.status !== "blocked" || output.code !== expectedCode) {
      fail("receipt_builder_blocked_mode_false_green", argumentsList.join(" "));
    }
    return Object.freeze({ arguments: Object.freeze([...argumentsList]), code: expectedCode, blocked: true });
  });
  const after = receiptSnapshot(receiptPath);
  if (!after.bytes.equals(before.bytes) || !isDeepStrictEqual(after.identity, before.identity)) {
    fail("receipt_builder_default_or_blocked_mode_mutated_receipt", RECEIPT_RELATIVE_PATH);
  }
  const defaultMode = MIGRATION_WRITE_AUTHORITY_RECEIPT_COMMAND_EFFECTS.modes.find((mode) =>
    mode.name === MIGRATION_WRITE_AUTHORITY_RECEIPT_COMMAND_EFFECTS.defaultMode
  );
  if (MIGRATION_WRITE_AUTHORITY_RECEIPT_COMMAND_EFFECTS.commandClass !== "build" ||
    defaultMode?.name !== "derive" || defaultMode.invocation !== "default-or-explicit" ||
    defaultMode.availability !== "available" || defaultMode.effects.includes("filesystem-write")) {
    fail("receipt_builder_effect_contract_invalid", MIGRATION_WRITE_AUTHORITY_RECEIPT_COMMAND_EFFECTS.defaultMode);
  }
  return Object.freeze({
    schemaVersion: MIGRATION_WRITE_AUTHORITY_RECEIPT_COMMAND_EFFECTS.schemaVersion,
    defaultMode: defaultMode.name,
    defaultEffects: defaultMode.effects,
    controlsAccepted: 3,
    blockedMutants: Object.freeze(blocked),
    receiptPrePostIdentityEqual: true,
    absentWorkingTreePrePostIdentityEqual: true,
    absentWorkingTreeControlCount: 3,
    temporaryWorkingTreeCleanupVerified: true,
    mutationPublicationAvailable: false
  });
}

function withTemporaryWorkingTree(prefix, operation) {
  const root = mkdtempSync(resolve(tmpdir(), prefix));
  try {
    return operation(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
    if (existsSync(root)) fail("temporary_effect_cleanup_failed", root);
  }
}

function completeTreeSnapshot(root) {
  const records = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const stats = lstatSync(current, { bigint: true });
    records.push(Object.freeze({
      relativePath: current === root ? "." : current.slice(root.length + 1),
      kind: stats.isDirectory() ? "directory" : stats.isFile() ? "file" :
        stats.isSymbolicLink() ? "symlink" : "other",
      device: stats.dev.toString(10),
      inode: stats.ino.toString(10),
      links: stats.nlink.toString(10),
      mode: stats.mode.toString(8),
      size: stats.size.toString(10),
      modifiedNanoseconds: stats.mtimeNs.toString(10),
      changedNanoseconds: stats.ctimeNs.toString(10),
      sha256: stats.isFile() ? trustSha256(readFileSync(current)) : null,
      linkTarget: stats.isSymbolicLink() ? readlinkSync(current) : null,
    }));
    if (stats.isDirectory()) {
      for (const name of readdirSync(current).toSorted().toReversed()) pending.push(resolve(current, name));
    }
  }
  return Object.freeze(records);
}

function receiptSnapshot(path) {
  const stats = lstatSync(path, { bigint: true });
  return Object.freeze({
    bytes: readFileSync(path),
    identity: Object.freeze({
      device: stats.dev.toString(10),
      inode: stats.ino.toString(10),
      links: stats.nlink.toString(10),
      size: stats.size.toString(10),
      modifiedNanoseconds: stats.mtimeNs.toString(10),
      changedNanoseconds: stats.ctimeNs.toString(10)
    })
  });
}

const values = argumentsMap(process.argv.slice(2));
const expectedReceiptSha = values.get("expected-author-receipt-sha256");
const validation = validateAuthorContracts(new Map([
  ["author-receipt", RECEIPT_RELATIVE_PATH],
  ["expected-author-receipt-sha256", expectedReceiptSha],
]));
const receiptBytes = readFileSync(resolve(ROOT, RECEIPT_RELATIVE_PATH));
if (trustSha256(receiptBytes) !== expectedReceiptSha) fail("external_receipt_pin_mismatch", expectedReceiptSha);
const receipt = JSON.parse(receiptBytes);
const contract = JSON.parse(readFileSync(resolve(ROOT, CONTRACT_RELATIVE_PATH), "utf8"));
const contractSchema = JSON.parse(readFileSync(resolve(ROOT, CONTRACT_SCHEMA_RELATIVE_PATH), "utf8"));
const contractValidate = new Ajv2020({ allErrors: true, strict: true }).compile(contractSchema);
const receiptSchema = JSON.parse(readFileSync(resolve(ROOT, RECEIPT_SCHEMA_RELATIVE_PATH), "utf8"));
const receiptValidate = new Ajv2020({ allErrors: true, strict: true }).compile(receiptSchema);
const commandEffectQualification = assertReceiptBuilderEffectContract();

const mutants = [
  expectSchemaBlocked("all-gaps-closed", contract, (value) => {
    for (const gap of value.decisionStatus) gap.status = "closed";
  }, contractValidate),
  expectSchemaBlocked("readiness-claimed", contract, (value) => { value.claims.readiness = true; }, contractValidate),
  expectSchemaBlocked("placement-admitted", contract, (value) => { value.claims.placementAdmission = true; }, contractValidate),
  expectSchemaBlocked("backend-selection-injected", contract, (value) => { value.backendQualification = { selectedCandidate: "lmdb" }; }, contractValidate),
  expectSchemaBlocked("serialized-grant-contract-weakened", contract, (value) => {
    value.protocol.liveGrant = "serialized-receipt-is-authority";
  }, contractValidate),
  expectSchemaBlocked("descriptor-gap-falsely-closed", contract, (value) => {
    value.claims.descriptorHeldIdentityQualified = true;
    value.decisionStatus[2].status = "author-qualified";
  }, contractValidate),
  expectReceiptSchemaBlocked("receipt-artifact-absolute-path", receipt, (value) => {
    value.artifacts[0].relativePath = "/etc/hosts";
  }, receiptValidate),
  expectReceiptSchemaBlocked("receipt-artifact-traversal-path", receipt, (value) => {
    value.artifacts[0].relativePath = "src/../../../../etc/hosts";
  }, receiptValidate),
  expectReceiptSchemaBlocked("receipt-artifact-lexical-alias-path", receipt, (value) => {
    value.artifacts[0].relativePath = `./${value.artifacts[0].relativePath}`;
  }, receiptValidate),
  expectReceiptSchemaBlocked("receipt-version-downgrade", receipt, (value) => {
    value.schemaVersion = "migration-write-authority-author-receipt/v1";
  }, receiptValidate),
  expectReceiptSchemaBlocked("trust-base-version-downgrade", receipt, (value) => {
    value.verifierTrustBase.schemaVersion = "migration-write-authority-verifier-trust-base/v1";
  }, receiptValidate),
  expectReceiptPathBlocked(
    "receipt-argument-absolute-path",
    "/etc/hosts",
    "author_receipt_path_invalid",
    expectedReceiptSha,
  ),
  expectReceiptPathBlocked(
    "receipt-argument-traversal-path",
    "../../../etc/hosts",
    "qualification_path_invalid",
    expectedReceiptSha,
  ),
  expectReceiptPathBlocked(
    "receipt-argument-lexical-alias-path",
    `./${RECEIPT_RELATIVE_PATH}`,
    "qualification_path_invalid",
    expectedReceiptSha,
  ),
  expectArtifactPinBlocked("contract-and-schema-co-weakening-contract-bytes", receipt, CONTRACT_RELATIVE_PATH,
    (bytes) => Buffer.concat([bytes, Buffer.from(" ")])),
  expectArtifactPinBlocked("contract-and-schema-co-weakening-schema-bytes", receipt, CONTRACT_SCHEMA_RELATIVE_PATH,
    (bytes) => Buffer.concat([bytes, Buffer.from(" ")])),
  expectArtifactPinBlocked(
    "protocol-schema-and-fixture-co-weakening-schema-bytes",
    receipt,
    "verification/benchmarks/coordination/migration-write-authority/schemas/authority-protocol.schema.json",
    (bytes) => Buffer.concat([bytes, Buffer.from(" ")]),
  ),
  expectArtifactPinBlocked(
    "protocol-schema-and-fixture-co-weakening-fixture-bytes",
    receipt,
    "verification/benchmarks/coordination/migration-write-authority/fixtures/authority-protocol-fixtures.v2.json",
    (bytes) => Buffer.concat([bytes, Buffer.from(" ")]),
  ),
  expectArtifactPinBlocked(
    "validator-co-weakened",
    receipt,
    "verification/benchmarks/coordination/migration-write-authority/validate-contracts.mjs",
    (bytes) => Buffer.concat([bytes, Buffer.from(" ")]),
  ),
  expectArtifactPinBlocked(
    "same-length-validator-and-hash-helper-co-weakening-validator",
    receipt,
    "verification/benchmarks/coordination/migration-write-authority/validate-contracts.mjs",
    sameLengthMutation,
  ),
  expectArtifactPinBlocked(
    "same-length-validator-and-hash-helper-co-weakening-hash-helper",
    receipt,
    "src/integrity.ts",
    sameLengthMutation,
  ),
  expectArtifactPinBlocked(
    "same-length-json-integrity-helper-co-weakening",
    receipt,
    "src/json-integrity.ts",
    sameLengthMutation,
  ),
  expectRootMetadataPinBlocked(
    "same-length-root-lock-metadata-mutation",
    receipt,
    "package-lock.json",
  ),
  expectPackageContentPinBlocked(
    "dependency-only-ajv-content-mutation",
    receipt,
    "ajv",
    "dist/2020.js",
  ),
];
mutants.push(...assertAppendOnlyPublisher());

let duplicateKeyDiagnostic;
try {
  assertNoDuplicateJsonObjectKeys(
    "{\"operation\":\"acquire\",\"\\u006fperation\":\"recover\"}",
    "Duplicate JSON object key in migration write-authority hostile control",
    "MWA_DUPLICATE_JSON_KEY_HOSTILE_CONTROL",
  );
  fail("duplicate_key_false_green", "escaped-equivalent");
} catch (error) {
  if (error.code !== "MWA_DUPLICATE_JSON_KEY_HOSTILE_CONTROL") throw error;
  duplicateKeyDiagnostic = { name: "escaped-equivalent-duplicate-key", blocked: true, diagnosticCode: error.code };
}

const output = {
  schemaVersion: "migration-write-authority-hostile-replay/v4",
  status: "author-hostile-replay-unadmitted",
  identities: {
    runner: { relativePath: "verification/benchmarks/coordination/migration-write-authority/test-contracts.mjs", sha256: sha256(readFileSync(SCRIPT_PATH)) },
    authorReceipt: { relativePath: RECEIPT_RELATIVE_PATH, externalPinVerified: true },
    protocolSchemaSha256: validation.protocolSchemaSha256,
    protocolFixtureSha256: validation.protocolFixtureSha256,
    qualificationContractSha256: validation.qualificationContract.sha256,
  },
  positiveValidation: validation,
  commandEffectQualification,
  mutants: [...mutants, duplicateKeyDiagnostic],
  summary: {
    positiveControlsAccepted: validation.summary.validAccepted,
    protocolMutantsBlocked: validation.summary.invalidBlocked,
    independentMutantsBlocked: mutants.length + 1,
    commandEffectControlsAccepted: 3,
    commandEffectMutantsBlocked: 4,
    independentAcceptance: false,
  },
};
const outputBytes = Buffer.from(`${canonicalJson(output)}\n`, "utf8");
if (values.get("write-evidence") === "true") {
  const governedReceiptAuthority = ensureReceiptAuthority(
    ROOT,
    "traceability/evidence/research/coordination/migration-write-authority/protocol-failures",
  );
  publishContentAddressed(governedReceiptAuthority, outputBytes);
}
process.stdout.write(outputBytes);
