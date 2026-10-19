import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

import { canonicalHash, canonicalJson, sha256 } from "../../../../src/kernel/integrity.ts";
import { assertNoDuplicateJsonObjectKeys } from "../../../../src/kernel/json-integrity.ts";
import {
  assertRepositoryFactsDerivedFromCommands,
  deriveScenarioAssertions,
  REPOSITORY_FACTS_ROLES,
  REPOSITORY_FACTS_SCENARIOS,
} from "./repository-facts-contract.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "../../../..");
const RUNNER_RELATIVE_PATH =
  "verification/benchmarks/coordination/migration-write-authority/repository-facts.mjs";
const CONTRACT_SOURCE_RELATIVE_PATH =
  "verification/benchmarks/coordination/migration-write-authority/repository-facts-contract.mjs";
const SCHEMA_RELATIVE_PATH =
  "verification/benchmarks/coordination/migration-write-authority/schemas/repository-facts-run.schema.json";
const EVIDENCE_PREFIX =
  "traceability/evidence/research/coordination/migration-write-authority/repository-facts/attempts/";

function fail(code, detail) {
  throw new Error(`${code}:${detail}`);
}

function assertNoDuplicateKeys(bytes, subject) {
  assertNoDuplicateJsonObjectKeys(
    bytes,
    `Duplicate JSON object key in migration write-authority ${subject}`,
    `MWA_DUPLICATE_JSON_KEY_${subject.toUpperCase().replaceAll("-", "_")}`,
  );
}

function parseExactEvidenceArgument(argv) {
  if (argv.length !== 1 || !argv[0].startsWith("--evidence=")) fail("argument_set_invalid", argv.join(" "));
  const input = argv[0].slice("--evidence=".length);
  if (input.length === 0 || isAbsolute(input)) fail("evidence_path_invalid", input);
  const normalized = relative(REPOSITORY_ROOT, resolve(REPOSITORY_ROOT, input));
  if (!normalized.startsWith(EVIDENCE_PREFIX) || normalized.includes("..") ||
    !/\/attempts\/[0-9a-f-]{36}\/repository-facts-run\.json$/u.test(normalized)) {
    fail("evidence_path_outside_closed_root", normalized);
  }
  const lexical = resolve(REPOSITORY_ROOT, normalized);
  const stats = lstatSync(lexical, { bigint: true });
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n) fail("evidence_file_unsafe", normalized);
  if (realpathSync(lexical) !== lexical) fail("evidence_file_alias", normalized);
  return Object.freeze({ lexical, normalized });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fileIdentity(stats) {
  return {
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    mode: Number(stats.mode & 0o7777n),
    ownerUid: stats.uid.toString(),
    ownerGid: stats.gid.toString(),
    links: stats.nlink.toString(),
  };
}

function assertExecutableIdentity(executable, label) {
  if (!isAbsolute(executable.lexicalPath) || !isAbsolute(executable.canonicalPath)) {
    fail("executable_path_not_absolute", label);
  }
  let canonical;
  let stats;
  try {
    canonical = realpathSync(executable.lexicalPath);
    stats = statSync(canonical, { bigint: true });
  } catch (error) {
    fail("executable_identity_unattested", `${label}:${error.code ?? "unknown"}`);
  }
  if (canonical !== executable.canonicalPath || !stats.isFile() || (stats.mode & 0o111n) === 0n ||
    Number(stats.size) !== executable.byteLength ||
    sha256(readFileSync(canonical)) !== executable.sha256 ||
    canonicalJson(fileIdentity(stats)) !== canonicalJson(executable.identity)) {
    fail("executable_identity_mismatch", label);
  }
}

function assertSourceIdentity(binding, pathKey, hashKey, expectedPath, label) {
  if (binding[pathKey] !== expectedPath ||
    sha256(readFileSync(resolve(REPOSITORY_ROOT, expectedPath))) !== binding[hashKey]) {
    fail("source_identity_mismatch", label);
  }
}

function assertSemanticContract(report, options) {
  const withoutIdentity = clone(report);
  delete withoutIdentity.reportIdentity;
  if (canonicalHash(withoutIdentity) !== report.reportIdentity) fail("report_identity_mismatch", report.reportIdentity);
  if (options.expectedReportIdentity !== undefined && report.reportIdentity !== options.expectedReportIdentity) {
    fail("externally_pinned_report_identity_mismatch", report.reportIdentity);
  }
  assertSourceIdentity(report.runner, "relativePath", "sha256", RUNNER_RELATIVE_PATH, "runner");
  assertSourceIdentity(
    report.runner,
    "contractRelativePath",
    "contractSha256",
    CONTRACT_SOURCE_RELATIVE_PATH,
    "repository-facts-contract",
  );
  assertExecutableIdentity(report.capabilities.node, "node");
  assertExecutableIdentity(report.capabilities.git, "git");
  if (report.capabilities.node.canonicalPath === realpathSync(process.execPath) &&
    report.capabilities.nodeVersion !== process.version) fail("node_version_identity_mismatch", report.capabilities.nodeVersion);
  const startedAt = Date.parse(report.startedAt);
  const finishedAt = Date.parse(report.finishedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) {
    fail("process_clock_order_invalid", `${report.startedAt}:${report.finishedAt}`);
  }

  const processIds = new Set();
  for (let repetitionIndex = 0; repetitionIndex < report.repetitions.length; repetitionIndex += 1) {
    const repetition = report.repetitions[repetitionIndex];
    if (repetition.ordinal !== repetitionIndex + 1) fail("repetition_order_invalid", repetition.ordinal);
    if (canonicalJson(repetition.scenarios.map((scenario) => scenario.scenarioId)) !==
      canonicalJson(REPOSITORY_FACTS_SCENARIOS)) fail("scenario_set_or_order_invalid", repetition.ordinal);
    for (const scenario of repetition.scenarios) {
      if (canonicalJson(scenario.processes.map((entry) => entry.role)) !==
        canonicalJson(REPOSITORY_FACTS_ROLES[scenario.scenarioId])) {
        fail("scenario_role_order_invalid", scenario.scenarioId);
      }
      for (const observation of scenario.processes) {
        if (processIds.has(observation.processId)) fail("child_process_identity_reused", observation.processId);
        processIds.add(observation.processId);
        assertRepositoryFactsDerivedFromCommands(scenario.scenarioId, observation.role, observation.facts);
      }
      const expectedAssertions = deriveScenarioAssertions(scenario.scenarioId, scenario.processes);
      if (canonicalJson(scenario.assertions) !== canonicalJson(expectedAssertions)) {
        fail("scenario_assertions_not_recomputed", scenario.scenarioId);
      }
      const expectedPassed = expectedAssertions.every((assertion) => assertion.ok);
      if (scenario.passed !== expectedPassed) fail("scenario_pass_disagreement", scenario.scenarioId);
    }
    if (repetition.passed !== repetition.scenarios.every((scenario) => scenario.passed)) {
      fail("repetition_pass_disagreement", repetition.ordinal);
    }
  }
  if (processIds.size !== 30 || report.summary.childProcessesObserved !== processIds.size ||
    report.summary.passed !== report.repetitions.every((repetition) => repetition.passed) ||
    report.summary.passed !== true) {
    fail("summary_derivation_invalid", String(processIds.size));
  }
}

export function validateRepositoryFactsReport(report, options = {}) {
  const schemaBytes = readFileSync(resolve(REPOSITORY_ROOT, SCHEMA_RELATIVE_PATH), "utf8");
  assertNoDuplicateKeys(schemaBytes, "repository-schema");
  const schema = JSON.parse(schemaBytes);
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  if (!validate(report)) fail("schema_validation_failed", canonicalJson(validate.errors ?? []));
  assertSemanticContract(report, options);
  return Object.freeze({
    schemaSha256: sha256(schemaBytes),
    reportIdentity: report.reportIdentity,
    executableIdentityAttestation: "verified-against-current-filesystem",
    pathIdentityAttestation: "lstat-plus-realpath-path-snapshot-only-no-held-descriptor-no-aba-proof",
    valid: true,
  });
}

function main() {
  const evidence = parseExactEvidenceArgument(process.argv.slice(2));
  const bytes = readFileSync(evidence.lexical, "utf8");
  assertNoDuplicateKeys(bytes, "repository-evidence");
  const result = validateRepositoryFactsReport(JSON.parse(bytes));
  process.stdout.write(`${canonicalJson({ evidence: evidence.normalized, ...result })}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(SCRIPT_PATH)) main();
