import { globSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { parseS2OfficialFragmentManifestText } from "../../scripts/verification/official-fragment-manifest.ts";
import { parseSliceDeclarationsText } from "../../scripts/verification/slice-declarations.ts";
import { SLICE_PROJECTION_PATHS } from "../../scripts/verification/slice-projection-paths.ts";
import {
  createSliceProjectionCapturedValues,
  deriveSliceProjectionInputPaths,
  type SliceProjectionCapturedFile,
  type SliceProjectionInput,
} from "../../scripts/verification/slice-projections.ts";
import {
  parseS2ResearchManifestText,
  parseS31SourceManifestText,
  S2_RESEARCH_MANIFEST_PATH,
} from "../../scripts/verification/slice-source-contracts.ts";

/**
 * Test-only ambient reader. It assembles exact bytes for the pure projection but
 * deliberately makes no safe-acquisition, repository-identity, lease, ABA,
 * recovery, admission, qualification, or readiness claim.
 */
export function currentSliceProjectionInput(candidateRoot = resolve(".")): SliceProjectionInput {
  const root = resolve(candidateRoot);
  const paths = currentSliceProjectionDerivedPaths(root);
  const files: SliceProjectionCapturedFile[] = paths.map((path) => ({
    path,
    contentBase64: readFileSync(join(root, path)).toString("base64"),
  }));
  return {
    captured: createSliceProjectionCapturedValues({
      schemaVersion: "bridlewise-slice-projection-captured-values/v1",
      files,
    }),
  };
}

export function currentSliceProjectionDerivedPaths(candidateRoot = resolve(".")): readonly string[] {
  const root = resolve(candidateRoot);
  const declarations = parseSliceDeclarationsText(read(root, SLICE_PROJECTION_PATHS.declarations));
  const s2Research = parseS2ResearchManifestText(read(root, S2_RESEARCH_MANIFEST_PATH));
  const s2Official = parseS2OfficialFragmentManifestText(read(root, SLICE_PROJECTION_PATHS.s2OfficialManifest));
  const s31 = parseS31SourceManifestText(read(root, SLICE_PROJECTION_PATHS.s31SourceManifest));
  return deriveSliceProjectionInputPaths({
    declarations,
    sources: {
      s2Research: { path: S2_RESEARCH_MANIFEST_PATH, manifest: s2Research },
      s2Official: { path: SLICE_PROJECTION_PATHS.s2OfficialManifest, manifest: s2Official },
      s31: { path: SLICE_PROJECTION_PATHS.s31SourceManifest, manifest: s31 },
    },
    fixturePaths: globSync("test/fixtures/s2/**/*.json", { cwd: root }),
  });
}

function read(root: string, path: string): string {
  return readFileSync(join(root, path), "utf8");
}
