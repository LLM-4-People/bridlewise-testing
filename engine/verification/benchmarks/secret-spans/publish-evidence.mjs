#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256 } from "../../../src/kernel/integrity.ts";
import {
  inspectReceiptAuthority,
  readImmutableEvidence
} from "../../../src/filesystem/immutable-receipt.ts";
import {
  CommandEffectContractError,
  resolveCommandEffectMode
} from "../shared/command-effect-contract.mjs";
import {
  SECRET_SPAN_EVIDENCE_COMMAND_EFFECTS,
  SECRET_SPAN_PATHS
} from "./foundation-paths.mjs";
import { parseQualificationArguments, runQualification } from "./run-qualification.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCRIPT_PATH = fileURLToPath(import.meta.url);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function parseCommandArguments(argv) {
  if (!Array.isArray(argv) || argv.some((argument) => typeof argument !== "string")) {
    fail("command_effect_arguments_invalid");
  }
  if (argv.includes("--write")) {
    resolveCommandEffectMode(SECRET_SPAN_EVIDENCE_COMMAND_EFFECTS, ["--write"]);
  }
  const effectArguments = argv.filter((argument) => argument.startsWith("--effect-mode="));
  const mode = resolveCommandEffectMode(SECRET_SPAN_EVIDENCE_COMMAND_EFFECTS, effectArguments);
  const qualificationArguments = argv.filter((argument) => !argument.startsWith("--effect-mode="));
  return Object.freeze({ mode, qualificationArguments: Object.freeze(qualificationArguments) });
}

export async function executeSecretSpanEvidenceCommand(argv) {
  const invocation = parseCommandArguments(argv);
  if (invocation.mode.availability === "blocked") fail(invocation.mode.unavailableCode);
  const qualification = await runQualification(parseQualificationArguments(invocation.qualificationArguments));
  if (invocation.mode.name === "derive") return Buffer.from(qualification.serialized, "utf8");
  if (invocation.mode.name !== "check") fail("command_effect_mode_unimplemented");
  const bytes = Buffer.from(qualification.serialized, "utf8");
  const identity = sha256(bytes);
  const objectPath = `objects/sha256/${identity}.json`;
  const authority = inspectReceiptAuthority(
    path.join(ROOT, SECRET_SPAN_PATHS.evidenceAuthorityRoot),
    SECRET_SPAN_PATHS.evidenceRelativeRoot
  );
  const existing = readImmutableEvidence(authority, objectPath, "canonical-json");
  if (!existing.equals(bytes)) fail("secret_span_evidence_drift");
  return Buffer.from(`${canonicalJson({
    status: "current-read-only",
    effectMode: invocation.mode.name,
    effects: invocation.mode.effects,
    repositoryAdmission: false,
    path: `${SECRET_SPAN_PATHS.evidenceAuthorityRoot}/${SECRET_SPAN_PATHS.evidenceRelativeRoot}/${objectPath}`,
    byteLength: bytes.length,
    sha256: identity
  })}\n`, "utf8");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SCRIPT_PATH)) {
  try {
    process.stdout.write(await executeSecretSpanEvidenceCommand(process.argv.slice(2)));
  } catch (error) {
    const code = error instanceof CommandEffectContractError ||
      (error instanceof Error && typeof error.code === "string") ? error.code :
      error instanceof Error && typeof error.message === "string" ? error.message.split(":", 1)[0] :
      "secret_span_evidence_command_internal_error";
    process.stderr.write(`${canonicalJson({ status: "blocked", code })}\n`);
    process.exitCode = 1;
  }
}
