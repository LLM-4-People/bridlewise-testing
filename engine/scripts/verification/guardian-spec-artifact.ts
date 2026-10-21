/**
 * The published guardian spec-schema artifact's ONE producer/verifier.
 *
 * `traceability/self-protection/guardian-spec-schema.json` is a Draft 2020-12
 * projection of `GUARDIAN_SPEC_SCHEMA` (`src/filesystem/self-protection/
 * self-protection-contracts.ts`). Until round 5 only `scripts/build-bundle.ts`
 * wrote it, and the only gate compared the FILE with its root-policy pin — so
 * changing the schema (`max(64)` -> `max(63)`) left artifact and pin stale
 * together and `harness check` stayed green, while the builder's own comment
 * claimed the pin "detects drift between the contracts module and the
 * published artifact". It did not: it compared the artifact to itself.
 *
 * This script rebuilds `buildGuardianSpecSchemaArtifact()` in memory from the
 * live module and compares the bytes. `--check` refuses a stale artifact;
 * `--write` refreshes it (plain `harness regenerate`, before the binding
 * repair re-pins `selfProtection.specSchemaArtifactSha256`). The bundle build
 * keeps calling the same owner function, so build and sync cannot disagree.
 *
 * Usage: `node scripts/verification/guardian-spec-artifact.ts --check|--write`
 * Prints ONE JSON line: `{ allCurrent, status, changed, sha256, path }`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { atomicWriteFile } from "../../src/filesystem/atomic-write.ts";
import { canonicalJson, sha256 } from "../../src/kernel/integrity.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";
import { buildGuardianSpecSchemaArtifact } from "./slice-projections.ts";

const ENGINE_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));

export type GuardianSpecArtifactReport = Readonly<{
  allCurrent: boolean;
  status: "current" | "stale" | "written";
  changed: readonly string[];
  sha256: string;
  path: string;
}>;

export function syncGuardianSpecSchemaArtifact(
  root: string,
  options: Readonly<{ write?: boolean }> = {},
): GuardianSpecArtifactReport {
  const write = options.write ?? false;
  const artifact = buildGuardianSpecSchemaArtifact();
  const absolutePath = join(root, artifact.path);
  const current = existsSync(absolutePath) && readFileSync(absolutePath, "utf8") === artifact.bytes;
  let status: GuardianSpecArtifactReport["status"] = current ? "current" : "stale";
  if (!current && write) {
    const result = atomicWriteFile(absolutePath, artifact.bytes);
    if (!result.success) {
      throw new Error(`could not write ${artifact.path}: ${result.reason ?? "atomic write failed"}`);
    }
    status = "written";
  }
  return Object.freeze({
    allCurrent: current,
    status,
    changed: current ? [] : [artifact.path],
    sha256: sha256(artifact.bytes),
    path: artifact.path,
  });
}

function main(argv: readonly string[]): number {
  if (argv.length !== 1 || !["--check", "--write"].includes(argv[0]!)) {
    throw new Error("Usage: guardian-spec-artifact --check|--write");
  }
  const report = syncGuardianSpecSchemaArtifact(ENGINE_ROOT, { write: argv[0] === "--write" });
  process.stdout.write(`${canonicalJson(report)}\n`);
  return report.allCurrent || report.status === "written" ? 0 : 1;
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      error: "guardian_spec_artifact_generation_failed",
      message: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = 1;
  }
}
