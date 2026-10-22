/**
 * THE ONE GENERATOR of the committed projection artifacts: the four schema
 * files and the slice traces built from the same inputs.
 *
 *   - `traceability/self-protection/guardian-spec-schema.json` — the Draft
 *     2020-12 projection of `GUARDIAN_SPEC_SCHEMA`
 *     (`buildGuardianSpecSchemaArtifact`);
 *   - `traceability/s2.4-requirements-schema.json`,
 *     `traceability/s2-contract-schemas.json`,
 *     `traceability/s3.1-forensic-schemas.json` and the traces `s2.json`,
 *     `s2.4.json`, `s3.1.json` — the slice projection
 *     (`buildSliceProjection`) of the tree's own inputs, read here
 *     (`readSliceProjectionInput`).
 *
 * WHY ONE GENERATOR, and why here. The slice projection's schema files and
 * traces had no writer in `harness sync`; only a test-only reader built them,
 * and the test that compared them tolerated drift, so nothing kept them true
 * (#221). The guardian schema had two writers (this script and the bundle
 * build). Now `harness regenerate` writes every artifact through this module
 * (`--write`), and `harness check` refuses any whose committed bytes are not
 * its output, byte for byte (`--check`). The schema files are laid out one
 * entry per line (`schemaArtifactText`), so parallel changes merge.
 *
 * Usage: `node scripts/verification/projection-artifacts.ts --check|--write`
 * Prints ONE JSON line: `{ allCurrent, status, changed, artifacts }`.
 */
import { existsSync, globSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { atomicWriteFile } from "../../src/filesystem/atomic-write.ts";
import { canonicalJson } from "../../src/kernel/integrity.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";
import { parseS2OfficialFragmentManifestText } from "./official-fragment-manifest.ts";
import { parseSliceDeclarationsText } from "./slice-declarations.ts";
import { SLICE_PROJECTION_PATHS } from "./slice-projection-paths.ts";
import {
  buildGuardianSpecSchemaArtifact,
  buildSliceProjection,
  createSliceProjectionCapturedValues,
  deriveSliceProjectionInputPaths,
  SLICE_PROJECTION_CAPTURED_VALUES_SCHEMA_VERSION,
  type ProjectionArtifact,
  type SliceProjectionCapturedFile,
  type SliceProjectionInput,
} from "./slice-projections.ts";
import { parseS2ResearchManifestText, parseS31SourceManifestText, S2_RESEARCH_MANIFEST_PATH } from "./slice-source-contracts.ts";

const ENGINE_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));

export type ProjectionArtifactsReport = Readonly<{
  allCurrent: boolean;
  status: "current" | "stale" | "written";
  changed: readonly string[];
  artifacts: readonly Readonly<{ path: string; sha256: string }>[];
}>;

function read(root: string, path: string): string {
  return readFileSync(join(root, path), "utf8");
}

/** The engine-relative files the slice projection of the engine at `root` reads, derived from its declarations and manifests. */
export function sliceProjectionInputPaths(root: string): readonly string[] {
  const declarations = parseSliceDeclarationsText(read(root, SLICE_PROJECTION_PATHS.declarations));
  return deriveSliceProjectionInputPaths({
    declarations,
    sources: {
      s2Research: { path: S2_RESEARCH_MANIFEST_PATH, manifest: parseS2ResearchManifestText(read(root, S2_RESEARCH_MANIFEST_PATH)) },
      s2Official: { path: SLICE_PROJECTION_PATHS.s2OfficialManifest, manifest: parseS2OfficialFragmentManifestText(read(root, SLICE_PROJECTION_PATHS.s2OfficialManifest)) },
      s31: { path: SLICE_PROJECTION_PATHS.s31SourceManifest, manifest: parseS31SourceManifestText(read(root, SLICE_PROJECTION_PATHS.s31SourceManifest)) },
    },
    fixturePaths: globSync("test/fixtures/s2/**/*.json", { cwd: root }),
  });
}

/** The slice projection's input: the exact bytes of every file it reads, from the engine at `root`. */
export function readSliceProjectionInput(root: string): SliceProjectionInput {
  const files: SliceProjectionCapturedFile[] = sliceProjectionInputPaths(root).map((path) => ({
    path,
    contentBase64: readFileSync(join(root, path)).toString("base64"),
  }));
  return { captured: createSliceProjectionCapturedValues({ schemaVersion: SLICE_PROJECTION_CAPTURED_VALUES_SCHEMA_VERSION, files }) };
}

/**
 * Every artifact this generator owns, built from the engine at `root`: the
 * guardian schema, then the slice projection's. A tree without the engine's
 * test surface (a product tree ships the traces without the fixtures they pin)
 * cannot rebuild the slice projection, so only the guardian schema is its own.
 */
export function projectionArtifacts(root: string): readonly ProjectionArtifact[] {
  const guardian = buildGuardianSpecSchemaArtifact();
  if (!existsSync(join(root, SLICE_PROJECTION_PATHS.testSurface))) return [guardian];
  return [guardian, ...Object.values(buildSliceProjection(readSliceProjectionInput(root)).artifactsByPath)];
}

/** Judges (and with `write`, rewrites) every projection artifact of the engine at `root`: current only when byte-equal. */
export function syncProjectionArtifacts(root: string, options: Readonly<{ write?: boolean }> = {}): ProjectionArtifactsReport {
  const write = options.write ?? false;
  const artifacts = projectionArtifacts(root);
  const changed = artifacts.filter((artifact) => {
    const absolute = join(root, artifact.path);
    return !existsSync(absolute) || readFileSync(absolute, "utf8") !== artifact.bytes;
  }).map((artifact) => artifact.path);
  if (write) {
    for (const artifact of artifacts.filter((entry) => changed.includes(entry.path))) {
      const result = atomicWriteFile(join(root, artifact.path), artifact.bytes);
      if (!result.success) throw new Error(`could not write ${artifact.path}: ${result.reason ?? "atomic write failed"}`);
    }
  }
  return Object.freeze({
    allCurrent: changed.length === 0,
    status: changed.length === 0 ? "current" : write ? "written" : "stale",
    changed,
    artifacts: artifacts.map((artifact) => ({ path: artifact.path, sha256: artifact.sha256 })),
  });
}

function main(argv: readonly string[]): number {
  if (argv.length !== 1 || !["--check", "--write"].includes(argv[0]!)) {
    throw new Error("Usage: projection-artifacts --check|--write");
  }
  const report = syncProjectionArtifacts(ENGINE_ROOT, { write: argv[0] === "--write" });
  process.stdout.write(`${canonicalJson(report)}\n`);
  return report.allCurrent || report.status === "written" ? 0 : 1;
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      error: "projection_artifacts_generation_failed",
      message: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = 1;
  }
}
