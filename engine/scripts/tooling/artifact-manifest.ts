/**
 * The artifact-admission manifest's ONE producer.
 *
 * `traceability/artifacts/manifest.json` is the canonical important-artifact
 * inventory (`ROOT_POLICY.artifactGovernance.canonicalInventory`), and the
 * candidate verifier and the S1 structure check consume it through
 * `artifactAdmissionViolations`. Until round 5 nothing in the tree WROTE it:
 * `buildArtifactAdmissionManifest` had no production caller, the file sat at
 * policy hash `5bb6ab90…` against a canonical `0c6cc522…`, and the real-tree
 * S1 baseline classified every `artifact-` violation as a "moving projection"
 * (272 of them). This script is that missing caller: it builds the manifest
 * from the governed roots' repository listing, compares it with the committed
 * bytes, and writes it only when it changed.
 *
 * DETERMINISM. `generatedAt` is read back from the existing manifest and only
 * restamped when the document's content (entries/origins) actually moved, so
 * two runs over one tree produce identical bytes and `harness sync` converges.
 * Origin capture is content-addressed (`previousManifest`), so unchanged
 * artifacts keep their recorded provenance.
 *
 * Usage: `node scripts/tooling/artifact-manifest.ts --check|--write`
 * Prints ONE JSON line: `{ allCurrent, status, changed, entries, generatedAt, policyHash }`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { atomicWriteFile } from "../../src/filesystem/atomic-write.ts";
import { canonicalJson, sha256 } from "../../src/kernel/integrity.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";
import {
  ARTIFACT_MANIFEST_PATH,
  buildArtifactAdmissionManifest,
} from "./verification/artifact-admission.ts";
import { rawSafeRepositoryRootAccess } from "../verification/safe-repository-reader.ts";

const ENGINE_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
/** The pinned timestamp shape the manifest schema accepts. */
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;

type ArtifactManifestReport = Readonly<{
  allCurrent: boolean;
  status: "current" | "stale" | "missing" | "written";
  changed: readonly string[];
  entries: number;
  generatedAt: string;
  policyHash: string;
  /** sha256 of the canonical bytes this run judged (or wrote). */
  integrityHash: string;
}>;

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
}

function readPrevious(path: string): Readonly<{ text: string; generatedAt: string }> | undefined {
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8");
  try {
    const parsed = JSON.parse(text) as { generatedAt?: unknown };
    if (typeof parsed.generatedAt === "string" && TIMESTAMP.test(parsed.generatedAt)) {
      return { text, generatedAt: parsed.generatedAt };
    }
  } catch {
    // A malformed manifest is not a previous document: rebuild it.
  }
  return undefined;
}

function build(root: string, generatedAt: string, previousText: string | undefined) {
  const previousManifest = previousText === undefined ? undefined : (JSON.parse(previousText) as unknown);
  return buildArtifactAdmissionManifest({
    root: rawSafeRepositoryRootAccess(root),
    generatedAt,
    ...(previousManifest !== undefined ? { previousManifest } : {}),
  });
}

export function syncArtifactManifest(
  root: string,
  options: Readonly<{ write?: boolean }> = {},
): ArtifactManifestReport {
  const write = options.write ?? false;
  const manifestPath = join(root, ARTIFACT_MANIFEST_PATH);
  const previous = readPrevious(manifestPath);
  const generatedAt = previous?.generatedAt ?? nowIso();
  let manifest = build(root, generatedAt, previous?.text);
  let bytes = `${canonicalJson(manifest)}\n`;
  if (previous !== undefined && bytes !== previous.text) {
    // The governed population or one artifact's bytes moved. Restamp so the
    // document records WHEN it changed (and new origins share that stamp); the
    // NEXT run reads this stamp back and is byte-stable.
    const restamped = build(root, nowIso(), previous.text);
    const restampedBytes = `${canonicalJson(restamped)}\n`;
    if (restampedBytes !== bytes) {
      manifest = restamped;
      bytes = restampedBytes;
    }
  }
  const current = previous !== undefined && bytes === previous.text;
  let status: ArtifactManifestReport["status"];
  if (current) {
    status = "current";
  } else if (previous === undefined) {
    status = "missing";
  } else {
    status = "stale";
  }
  if (write && !current) {
    const result = atomicWriteFile(manifestPath, bytes);
    if (!result.success) {
      throw new Error(`could not write ${ARTIFACT_MANIFEST_PATH}: ${result.reason ?? "atomic write failed"}`);
    }
    status = "written";
  }
  return Object.freeze({
    allCurrent: current,
    status,
    changed: current ? [] : [ARTIFACT_MANIFEST_PATH],
    entries: manifest.entries.length,
    generatedAt: manifest.generatedAt,
    policyHash: manifest.policyHash,
    integrityHash: sha256(bytes),
  });
}

function main(argv: readonly string[]): number {
  if (argv.length !== 1 || !["--check", "--write"].includes(argv[0]!)) {
    throw new Error("Usage: artifact-manifest --check|--write");
  }
  const write = argv[0] === "--write";
  const report = syncArtifactManifest(ENGINE_ROOT, { write });
  process.stdout.write(`${canonicalJson(report)}\n`);
  return report.allCurrent || report.status === "written" ? 0 : 1;
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      error: "artifact_manifest_generation_failed",
      message: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = 1;
  }
}
