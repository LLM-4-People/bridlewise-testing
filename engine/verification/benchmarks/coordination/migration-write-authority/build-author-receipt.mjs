#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../../../../src/kernel/integrity.ts";
import {
  CommandEffectContractError,
  resolveCommandEffectMode
} from "../../shared/command-effect-contract.mjs";
import {
  MIGRATION_WRITE_AUTHORITY_RECEIPT_COMMAND_EFFECTS,
  MIGRATION_WRITE_AUTHORITY_RECEIPT_CONTRACT,
  readMigrationWriteAuthorityFile,
  trustSha256
} from "./author-trust-base.mjs";
import { buildMigrationWriteAuthorityAuthorReceiptValue } from "./author-receipt.mjs";

const SCRIPT_PATH = resolve(fileURLToPath(import.meta.url));

function receiptBytes() {
  return Buffer.from(`${canonicalJson(buildMigrationWriteAuthorityAuthorReceiptValue())}\n`, "utf8");
}

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function main(argv) {
  const mode = resolveCommandEffectMode(MIGRATION_WRITE_AUTHORITY_RECEIPT_COMMAND_EFFECTS, argv);
  if (mode.availability === "blocked") fail(mode.unavailableCode);
  const derived = receiptBytes();
  if (mode.name === "derive") {
    process.stdout.write(derived);
    return;
  }
  if (mode.name !== "check") fail("command_effect_mode_unimplemented");
  const current = readMigrationWriteAuthorityFile(MIGRATION_WRITE_AUTHORITY_RECEIPT_CONTRACT.receiptRelativePath);
  if (!current.equals(derived)) fail("migration_write_authority_author_receipt_drift");
  process.stdout.write(`${canonicalJson({
    status: "current-read-only",
    effectMode: mode.name,
    effects: mode.effects,
    authorReceiptRelativePath: MIGRATION_WRITE_AUTHORITY_RECEIPT_CONTRACT.receiptRelativePath,
    byteLength: derived.length,
    expectedAuthorReceiptSha256: trustSha256(derived),
    generatorSha256: trustSha256(readMigrationWriteAuthorityFile(
      MIGRATION_WRITE_AUTHORITY_RECEIPT_CONTRACT.builderRelativePath
    ))
  })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    const code = error instanceof CommandEffectContractError ||
      (error instanceof Error && typeof error.code === "string") ? error.code :
      "migration_write_authority_receipt_builder_internal_error";
    process.stderr.write(`${canonicalJson({ status: "blocked", code })}\n`);
    process.exitCode = 1;
  }
}
