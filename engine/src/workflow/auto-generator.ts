import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { canonicalJson, deepFreeze, sha256 } from "../kernel/integrity.ts";
import { parseSignedReport } from "./command-result.ts";
import { ROOT_POLICY } from "../kernel/root-policy.ts";
import { buildConfigContract, getConfigContractArtifact } from "../kernel/config-contracts.ts";
import { verifyBindingById } from "./hash-binding-registry.ts";
import { handleError } from "../shared/debug/debug-system.ts";
import { schemaId } from "../kernel/product-identity.ts";

export const AUTO_GENERATOR_SCHEMA_VERSION = schemaId("auto-generator", 2);

export type ConfigSchemaBinding = Readonly<{
  schemaHash: string;
  identityHash: string;
  current: Readonly<{ sourceSha256: string; schemaHash: string }>;
  matches: boolean;
}>;

export type AutoGeneratorStep = Readonly<{
  step: string;
  status: "pass" | "drift" | "error";
  message: string;
  details: unknown;
}>;

export type AutoGeneratorReport = Readonly<{
  schemaVersion: typeof AUTO_GENERATOR_SCHEMA_VERSION;
  root: string;
  steps: readonly AutoGeneratorStep[];
  configSchemaBinding: ConfigSchemaBinding | null;
  allMatch: boolean;
  generatedAt: string;
  integrityHash: string;
}>;


/**
 * The config-contract artifact the ON-DISK root policy declares.
 *
 * The artifact embeds the root policy's `configuration.contract.sourceSha256`
 * pin. A generator step earlier in the same process may have re-pinned it, and
 * the statically imported ROOT_POLICY still holds the old value, so an artifact
 * built from the import would lag one pass behind the policy it sits beside
 * (the defect that made `harness sync` need a second pass). The pin is read
 * through the file-truthful hash-binding registry instead, like every other
 * baseline in this module.
 */
export function currentConfigContractArtifact(root: string): ReturnType<typeof getConfigContractArtifact> {
  const pin = verifyBindingById(root, "root-policy-config-contracts-source-sha256");
  const contract = ROOT_POLICY.configuration.contract;
  // A tree that carries no readable pin (a product-only fixture without the
  // policy file) declares nothing on disk; the imported policy is its only one.
  if (pin.error !== undefined || pin.actual === contract.sourceSha256) return getConfigContractArtifact();
  const sourceSha256 = pin.actual;
  return buildConfigContract({ ...ROOT_POLICY, configuration: { ...ROOT_POLICY.configuration, contract: { ...contract, sourceSha256 } } }).artifact;
}

export function computeConfigSchemaBinding(root: string = process.cwd()): ConfigSchemaBinding {
  const { schemaHash, identityHash } = currentConfigContractArtifact(root);
  const currentContract = ROOT_POLICY.configuration.contract;
  const sourcePath = resolve(root, currentContract.sourcePath);
  let actualSourceSha256: string;
  try {
    actualSourceSha256 = existsSync(sourcePath) ? sha256(readFileSync(sourcePath, "utf8")) : "";
  } catch (e) {handleError(e, { module: "workflow-auto-generator", operation: "catch" });
    actualSourceSha256 = "";
  }
  // File-truthful baseline: read the current on-disk root-policy literal via
  // the hash-binding registry (see computeDispositionBinding).
  const currentSourceSha256 = verifyBindingById(root, "root-policy-config-contracts-source-sha256").actual;
  return deepFreeze({
    schemaHash,
    identityHash,
    current: deepFreeze({ sourceSha256: currentSourceSha256, schemaHash }),
    matches: actualSourceSha256 !== "" && actualSourceSha256 === currentSourceSha256,
  });
}

export function generateAutoGeneratorReport(root: string): AutoGeneratorReport {
  const steps: AutoGeneratorStep[] = [];

  // The test inventory and the dispositions carry no root-policy copy of their hashes (#221): each is verified
  // against a fresh build of itself where it is read, and `harness check` judges their drift.
  const configSchemaBinding = computeConfigSchemaBinding(root);
  steps.push(deepFreeze({
    step: "config-schema-binding",
    status: configSchemaBinding.matches ? "pass" : "drift",
    message: configSchemaBinding.matches ? "config schema binding matches root policy" : "config schema binding has drifted from root policy",
    details: configSchemaBinding,
  }));

  // The qualification-authority inventory is a VERIFICATION subject (a
  // benchmark manifest under `verification/benchmarks/`). A product-only tree
  // carries no verification tree, so the file is absent BY DESIGN there — the
  // step reports a guided skip, not an error. On a tree that carries the
  // verification surface the file must exist and is hashed.
  const qualificationInventoryPath = resolve(root, "verification/benchmarks/shared/qualification-authority-inventory.mjs");
  const verificationTreePresent = existsSync(resolve(root, "verification"));
  if (existsSync(qualificationInventoryPath)) {
    const fileBytes = readFileSync(qualificationInventoryPath, "utf8");
    steps.push(deepFreeze({
      step: "qualification-authority-inventory",
      status: "pass",
      message: "qualification authority inventory file exists",
      details: deepFreeze({ fileSha256: sha256(fileBytes), byteLength: fileBytes.length }),
    }));
  } else if (!verificationTreePresent) {
    steps.push(deepFreeze({
      step: "qualification-authority-inventory",
      status: "pass",
      message: "no verification tree on this branch (the verification suite lives on the testing branch)",
      details: null,
    }));
  } else {
    steps.push(deepFreeze({
      step: "qualification-authority-inventory",
      status: "error",
      message: "qualification authority inventory file not found",
      details: null,
    }));
  }

  const allMatch = steps.every((step) => step.status === "pass");

  const unsigned = {
    schemaVersion: AUTO_GENERATOR_SCHEMA_VERSION,
    root,
    steps: deepFreeze(steps),
    configSchemaBinding,
    allMatch,
    generatedAt: new Date().toISOString(),
  } as const;
  return deepFreeze({ ...unsigned, integrityHash: sha256(canonicalJson(unsigned)) } as AutoGeneratorReport);
}

export function parseAutoGeneratorReport(value: unknown): AutoGeneratorReport {
  return parseSignedReport<AutoGeneratorReport>(value, AUTO_GENERATOR_SCHEMA_VERSION, "auto generator report");
}
