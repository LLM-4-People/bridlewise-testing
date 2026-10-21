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
 * ── PROVENANCE IS PRODUCED, NOT REUSED ───────────────────────────────────
 *
 * The first version of this script read `generatedAt` back out of the existing
 * document and reused every prior entry's `origin` wholesale by digest. Bytes
 * that did not change therefore kept whatever `origin` the document held — so
 * a hand-edited `generatedAt`, `origin.license` or `origin.producingTool`
 * passed `--check` (the rebuild read the edit back), passed `harness check`
 * (the same), and survived `harness regenerate` (the "prior origin" became
 * the produced one). Meanwhile `artifactAdmissionViolations` refused the very
 * same bytes (`origin.license: "unknown"`), because the two readers answered
 * different questions.
 *
 * Now: the document's `generatedAt` is DERIVED from its entries (the latest
 * `capturedAt`); a prior origin is reused only when it matches a pinned origin
 * shape in `artifact-admission.ts`; anything else is replaced by a fresh
 * mechanical capture. The build's own provenance policy is checked before a
 * write, so this producer can never emit a document the admission policy
 * refuses.
 *
 * ── A DROPPED ARTIFACT IS A DECISION ─────────────────────────────────────
 *
 * The rebuild compares its entry set with the previous document's. An entry
 * that disappeared from the governed roots is a DELETION: it is refused unless
 * each removed path is named with `--prune <path>`. The flag mirrors the test
 * surface's `harness sync --prune` and the same asymmetry applies — adding an
 * artifact is safe, dropping one is how the inventory silently loses an
 * authority. A canonical artifact's retention is append-only governed
 * supersession, so `--prune` does not apply to it at all: it must be restored.
 *
 * DETERMINISM. `generatedAt` = the latest entry capture, so two runs over one
 * tree produce identical bytes and `harness sync` converges. A capture stamp
 * moves only when an artifact's bytes (or its admitted origin) move.
 *
 * Usage: `node scripts/tooling/artifact-manifest.ts --check|--write [--prune <path>]…`
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
  artifactProvenanceViolations,
  buildArtifactAdmissionManifest,
} from "./verification/artifact-admission.ts";
import { rawSafeRepositoryRootAccess } from "../verification/safe-repository-reader.ts";

const ENGINE_ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
/** The retention policy that forbids a pruned drop (canonical artifacts are append-only). */
const CANONICAL_RETENTION = "retain-canonical-with-append-only-governed-supersession";

type ArtifactManifestReport = Readonly<{
  allCurrent: boolean;
  status: "current" | "stale" | "missing" | "written";
  changed: readonly string[];
  entries: number;
  generatedAt: string;
  policyHash: string;
  /** sha256 of the canonical bytes this run judged (or wrote). */
  integrityHash: string;
  /** The previous-entry paths that disappeared, named whether or not they were pruned. */
  dropped: readonly string[];
}>;

/** A refusal with a stable code: the CLI reports it as a typed stderr record. */
class ArtifactManifestRefusal extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ArtifactManifestRefusal";
    this.code = code;
  }
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/u, "Z");
}

/** The previous document's entries — path + retention only, the facts a prune decides on. */
function previousEntries(path: string): readonly Readonly<{ path: string; retention: string }>[] {
  if (!existsSync(path)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // A malformed manifest is not a previous document: the rebuild replaces it.
    return [];
  }
  const entries = (parsed as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    const record = entry as { path?: unknown; retention?: { policy?: unknown } } | null;
    return typeof record?.path === "string" && typeof record.retention?.policy === "string"
      ? [{ path: record.path, retention: record.retention.policy }]
      : [];
  });
}

/**
 * Refuse a population drop the operator did not name, and refuse a named drop
 * of an artifact whose retention forbids it. Every refusal names the way out.
 */
function refuseDroppedArtifacts(
  dropped: readonly Readonly<{ path: string; retention: string }>[],
  currentPaths: ReadonlySet<string>,
  prune: readonly string[],
): void {
  const stillPresent = prune.filter((path) => currentPaths.has(path));
  if (stillPresent.length > 0) {
    throw new ArtifactManifestRefusal(
      "artifact_manifest_prune_not_deleted",
      `artifact-manifest prune refused: ${stillPresent.join(", ")} still exist under the governed roots; ` +
        "--prune names an artifact that was DELETED on purpose, never one that is present.",
    );
  }
  const unnamed = dropped.filter((entry) => !prune.includes(entry.path));
  if (unnamed.length > 0) {
    throw new ArtifactManifestRefusal(
      "artifact_manifest_prune_refused",
      `artifact-manifest refused: ${String(unnamed.length)} governed artifact(s) disappeared from the roots, and ` +
        "dropping them would shrink the canonical inventory silently: " +
        `${unnamed.slice(0, 10).map((entry) => entry.path).join(", ")}${unnamed.length > 10 ? ", …" : ""}. ` +
        "Restore them, or name each deliberate deletion: node scripts/tooling/artifact-manifest.ts --write " +
        `${unnamed.slice(0, 10).map((entry) => `--prune ${entry.path}`).join(" ")}` +
        `${unnamed.length > 10 ? " …" : ""} (then run harness sync).`,
    );
  }
  const canonical = dropped.filter((entry) => prune.includes(entry.path) && entry.retention === CANONICAL_RETENTION);
  if (canonical.length > 0) {
    throw new ArtifactManifestRefusal(
      "artifact_manifest_canonical_drop_refused",
      `artifact-manifest refused: ${canonical.map((entry) => entry.path).join(", ")} ` +
        `${canonical.length === 1 ? "is a canonical artifact" : "are canonical artifacts"} with retention ` +
        `${CANONICAL_RETENTION}: a canonical authority is append-only and cannot be pruned. Restore ` +
        `${canonical.length === 1 ? "it" : "them"} from version control; a genuine supersession must change the ` +
        "authority itself, not the inventory entry.",
    );
  }
}

export function syncArtifactManifest(
  root: string,
  options: Readonly<{ write?: boolean; prune?: readonly string[] }> = {},
): ArtifactManifestReport {
  const write = options.write ?? false;
  const prune = [...new Set(options.prune ?? [])].toSorted();
  const manifestPath = join(root, ARTIFACT_MANIFEST_PATH);
  const previousText = existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : undefined;
  const previous = previousEntries(manifestPath);
  const access = rawSafeRepositoryRootAccess(root);
  let previousManifest: unknown;
  if (previousText !== undefined) {
    try {
      previousManifest = JSON.parse(previousText);
    } catch {
      previousManifest = undefined;
    }
  }
  // The stale first pass uses a fresh stamp; a second pass is not needed: the
  // document's stamp is derived from the captures, so the bytes are stable
  // when no artifact moved.
  const manifest = buildArtifactAdmissionManifest({
    root: access,
    generatedAt: nowIso(),
    ...(previousManifest !== undefined ? { previousManifest } : {}),
  });
  const violations = artifactProvenanceViolations(manifest);
  if (violations.length > 0) {
    throw new ArtifactManifestRefusal(
      "artifact_manifest_provenance_refused",
      `artifact-manifest refused: the rebuilt provenance is not admissible: ${violations.join(", ")}`,
    );
  }
  const currentPaths = new Set(manifest.entries.map((entry) => entry.path));
  const dropped = previous.filter((entry) => !currentPaths.has(entry.path)).toSorted((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  refuseDroppedArtifacts(dropped, currentPaths, prune);
  const bytes = `${canonicalJson(manifest)}\n`;
  const current = previousText !== undefined && bytes === previousText;
  let status: ArtifactManifestReport["status"];
  if (current) {
    status = "current";
  } else if (previousText === undefined) {
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
    dropped: dropped.map((entry) => entry.path),
  });
}

function parseArguments(argv: readonly string[]): Readonly<{ write: boolean; prune: readonly string[] }> {
  let mode: "--check" | "--write" | undefined;
  const prune: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--check" || argument === "--write") {
      if (mode !== undefined) throw new Error("Usage: artifact-manifest --check|--write [--prune <path>]…");
      mode = argument;
      continue;
    }
    if (argument === "--prune") {
      const path = argv[index + 1];
      if (path === undefined || path.startsWith("--")) {
        throw new Error("--prune needs the repository-relative path of a deleted artifact");
      }
      prune.push(path);
      index += 1;
      continue;
    }
    throw new Error("Usage: artifact-manifest --check|--write [--prune <path>]…");
  }
  if (mode === undefined) throw new Error("Usage: artifact-manifest --check|--write [--prune <path>]…");
  return Object.freeze({ write: mode === "--write", prune: Object.freeze(prune) });
}

function main(argv: readonly string[]): number {
  const options = parseArguments(argv);
  const report = syncArtifactManifest(ENGINE_ROOT, options);
  process.stdout.write(`${canonicalJson(report)}\n`);
  return report.allCurrent || report.status === "written" ? 0 : 1;
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      error: error instanceof ArtifactManifestRefusal ? error.code : "artifact_manifest_generation_failed",
      message: error instanceof Error ? error.message : String(error),
    })}\n`);
    process.exitCode = 1;
  }
}
