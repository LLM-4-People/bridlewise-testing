/**
 * THE UNPUBLISHED PATH-POLICY SOURCES, FETCHED (#149).
 *
 * The repository path policy is pinned to Git 2.55.0's own path handling
 * (`path.c`, its upstream test `t/t0060-path-utils.sh`, and their
 * GPL-2.0-only licence). The manifest
 * (`traceability/sources/path-policy/manifest.json`) records each file's
 * upstream commit, size and sha256, but the files themselves are not
 * published in this AGPL-3.0 tree. A checkout that does not hold them cannot
 * run the repository-path suite: on the hosted runner it failed at module load
 * with ENOENT.
 *
 * `fetch` materialises exactly the pinned files from the pinned commit through
 * the one pinned-blob fetch (`fetchPinnedBlobs`, the corpus owner's), verified
 * against the manifest before any is written, into the paths the manifest
 * names, all in the one never-committed folder
 * (`VERIFICATION_PATHS.unpublishedPathPolicySources`: ignored by git and
 * excluded from the artifact inventory). `verify` is the one
 * judgement of "the sources are what the manifest says". A test that reads
 * them refuses by name when they are absent (`requirePathPolicySources`).
 *
 * Usage: `node scripts/verification/path-policy-sources.ts fetch|verify`
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { atomicWriteFile } from "../../src/filesystem/atomic-write.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";
import { parsePathPolicySourceManifest } from "../generation/repository-path-unicode.ts";
import { ownedTemporaryName } from "../../src/filesystem/private-state.ts";
import { VERIFICATION_PATHS } from "../../src/kernel/verification-paths.ts";
import { fetchPinnedBlobs, sha256Hex } from "./corpus.ts";

/** The manifest of the path-policy sources, engine-relative. */
export const PATH_POLICY_MANIFEST_PATH = "traceability/sources/path-policy/manifest.json";
/** The command that fetches them. */
export const PATH_POLICY_FETCH_COMMAND = "npm run sources:fetch";

type PinnedSource = Readonly<{ upstreamPath: string; path: string; sizeBytes: number; sha256: string }>;

/** The Git source set's pinned files (the licence included), with the upstream they come from. */
function gitSources(engineRoot: string): Readonly<{ upstream: string; commit: string; files: readonly PinnedSource[] }> {
  const manifest = parsePathPolicySourceManifest(readFileSync(join(engineRoot, PATH_POLICY_MANIFEST_PATH), "utf8"));
  const git = manifest.sourceSets.git;
  const files: PinnedSource[] = [
    { upstreamPath: "COPYING", path: git.license.path, sizeBytes: git.license.byteLength, sha256: git.license.sha256 },
    ...git.sources.map((source) => ({ upstreamPath: source.upstreamPath, path: source.path, sizeBytes: source.byteLength, sha256: source.sha256 })),
  ];
  // Each lands in the one never-committed folder (ignored, and excluded from the artifact inventory): never elsewhere.
  const outside = files.filter((file) => !file.path.startsWith(VERIFICATION_PATHS.unpublishedPathPolicySources));
  if (outside.length > 0) {
    throw new Error(`path-policy sources outside ${VERIFICATION_PATHS.unpublishedPathPolicySources}: ${outside.map((file) => file.path).join(", ")}`);
  }
  return { upstream: git.upstream.repository, commit: git.upstream.commit, files };
}

/** Each pinned file that is absent or does not match the manifest, engine-relative. */
export function pathPolicySourceProblems(engineRoot: string): readonly string[] {
  return gitSources(engineRoot).files.flatMap((file) => {
    const absolute = join(engineRoot, file.path);
    if (!existsSync(absolute)) return [`${file.path}: absent`];
    const bytes = readFileSync(absolute);
    return bytes.byteLength === file.sizeBytes && sha256Hex(bytes) === file.sha256 ? [] : [`${file.path}: does not match the manifest`];
  });
}

/**
 * The refusal of a reader of the sources on a checkout that lacks them: the
 * capability is required, so it is said with its remedy, never skipped.
 */
export function requirePathPolicySources(engineRoot: string): void {
  const problems = pathPolicySourceProblems(engineRoot);
  if (problems.length > 0) {
    throw new Error(`the unpublished path-policy sources are not here (${problems.join("; ")}): run \`${PATH_POLICY_FETCH_COMMAND}\` from the repository root`);
  }
}

/** Fetches the pinned files into the paths the manifest names (only those absent or wrong); answers what it wrote. */
export function fetchPathPolicySources(engineRoot: string, log: (line: string) => void = () => {}): readonly string[] {
  const { upstream, commit, files } = gitSources(engineRoot);
  if (pathPolicySourceProblems(engineRoot).length === 0) {
    log("path-policy sources already verified");
    return [];
  }
  // The partial clone lives in the run's own temporary root (an owned name: a dead run's is never mistaken for it).
  const checkout = join(tmpdir(), ownedTemporaryName("path-policy-fetch"));
  try {
    log(`fetching ${upstream} @ ${commit}`);
    const blobs = fetchPinnedBlobs(upstream, commit, files.map((file) => ({ path: file.upstreamPath, sizeBytes: file.sizeBytes, sha256: file.sha256 })), checkout);
    for (const file of files) {
      mkdirSync(dirname(join(engineRoot, file.path)), { recursive: true });
      const written = atomicWriteFile(join(engineRoot, file.path), blobs.get(file.upstreamPath)!);
      if (!written.success) throw new Error(`could not write ${file.path}: ${written.reason ?? "atomic write failed"}`);
    }
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
  const problems = pathPolicySourceProblems(engineRoot);
  if (problems.length > 0) throw new Error(`the fetch did not produce verifiable sources: ${problems.join("; ")}`);
  return files.map((file) => file.path);
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  const engineRoot = resolve(import.meta.dirname, "..", "..");
  const [verb] = process.argv.slice(2);
  if (verb === "fetch") {
    const written = fetchPathPolicySources(engineRoot, (line) => process.stdout.write(`path-policy-sources: ${line}\n`));
    process.stdout.write(`path-policy-sources: ${written.length === 0 ? "nothing to fetch" : `wrote ${written.join(", ")}`}\n`);
  } else if (verb === "verify") {
    const problems = pathPolicySourceProblems(engineRoot);
    process.stdout.write(problems.length === 0 ? "path-policy-sources: verified\n" : `path-policy-sources: ${problems.join("; ")}\n`);
    process.exitCode = problems.length === 0 ? 0 : 1;
  } else {
    throw new Error("Usage: path-policy-sources fetch|verify");
  }
}
