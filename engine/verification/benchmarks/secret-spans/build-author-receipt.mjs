#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256 } from "../../../src/kernel/integrity.ts";
import { readQualificationFile } from "../shared/qualification-authority.mjs";
import {
  CommandEffectContractError,
  resolveCommandEffectMode
} from "../shared/command-effect-contract.mjs";
import { buildAuthorReceiptValue } from "./author-receipt.mjs";
import {
  SECRET_SPAN_AUTHOR_RECEIPT_COMMAND_EFFECTS,
  SECRET_SPAN_PATHS
} from "./foundation-paths.mjs";

const SCRIPT_PATH = resolve(fileURLToPath(import.meta.url));

function receiptBytes() {
  return Buffer.from(`${canonicalJson(buildAuthorReceiptValue())}\n`, "utf8");
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

export function executeSecretSpanAuthorReceiptCommand(argv) {
  const mode = resolveCommandEffectMode(SECRET_SPAN_AUTHOR_RECEIPT_COMMAND_EFFECTS, argv);
  if (mode.availability === "blocked") fail(mode.unavailableCode);
  const derived = receiptBytes();
  if (mode.name === "derive") return derived;
  if (mode.name !== "check") fail("command_effect_mode_unimplemented");
  const current = readQualificationFile(SECRET_SPAN_PATHS.authorReceipt);
  const pin = readQualificationFile(SECRET_SPAN_PATHS.authorPin);
  const expectedPin = Buffer.from(`${sha256(derived)}  ${SECRET_SPAN_PATHS.authorReceipt}\n`, "utf8");
  if (!current.equals(derived) || !pin.equals(expectedPin)) fail("secret_span_author_receipt_drift");
  return Buffer.from(`${canonicalJson({
    status: "current-read-only",
    effectMode: mode.name,
    effects: mode.effects,
    authorReceiptRelativePath: SECRET_SPAN_PATHS.authorReceipt,
    authorPinRelativePath: SECRET_SPAN_PATHS.authorPin,
    byteLength: derived.length,
    expectedAuthorReceiptSha256: sha256(derived),
    generatorSha256: sha256(readQualificationFile(
      "verification/benchmarks/secret-spans/build-author-receipt.mjs"
    ))
  })}\n`, "utf8");
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    process.stdout.write(executeSecretSpanAuthorReceiptCommand(process.argv.slice(2)));
  } catch (error) {
    const code = error instanceof CommandEffectContractError ||
      (error instanceof Error && typeof error.code === "string") ? error.code :
      "secret_span_author_receipt_builder_internal_error";
    process.stderr.write(`${canonicalJson({ status: "blocked", code })}\n`);
    process.exitCode = 1;
  }
}
