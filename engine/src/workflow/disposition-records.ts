/**
 * THE TEST-SURFACE DISPOSITION RECORDS ON DISK — the one reader and the one
 * writer of `dispositionRegistry.recordsPath` (one record per decided source;
 * the shape and every judgement are the kernel owner's,
 * `src/kernel/test-surface-manifest.ts`).
 *
 * A record decided under another discovery policy is refused by the kernel
 * owner whenever it is read, so neither the reader nor the writer here can
 * re-bless a stale decision: the writer rewrites a record only in its one form
 * under the current policy, and only after the whole directory read clean.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFile } from "../filesystem/atomic-write.ts";
import { HarnessError } from "../kernel/errors.ts";
import { sha256 } from "../kernel/integrity.ts";
import {
  createTestSurfaceDispositionManifest,
  DISPOSITION_RECORDS_PATH,
  dispositionManifestFromRecords,
  dispositionRecordsOf,
  type TestSurfaceDispositionManifest,
} from "../kernel/test-surface-manifest.ts";

/** Every record file under the engine at `engineRoot`: its engine-relative path and bytes, sorted by path. */
export function dispositionRecordFiles(engineRoot: string): readonly Readonly<{ path: string; text: string }>[] {
  const directory = join(engineRoot, DISPOSITION_RECORDS_PATH);
  if (!existsSync(directory)) return [];
  // One flat directory: every file but the folder's README is a record (a stray file is refused by the owner's parse).
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.name !== "README.md")
    .map((entry) => `${DISPOSITION_RECORDS_PATH}/${entry.name}`)
    .toSorted()
    .map((path) => ({ path, text: readFileSync(join(engineRoot, path), "utf8") }));
}

/** The disposition manifest the records hold (every record judged by the kernel owner: a stale policy refuses by name). */
export function readDispositionManifest(engineRoot: string): TestSurfaceDispositionManifest {
  return dispositionManifestFromRecords(dispositionRecordFiles(engineRoot));
}

/** The records' identity: every record's path and bytes (what a test inventory binds itself to). */
export function dispositionRecordsDigest(engineRoot: string): string {
  return sha256(dispositionRecordFiles(engineRoot).map((record) => `${record.path}\0${record.text}`).join("\0"));
}

/**
 * Write `manifest` as its records: each record whose bytes differ is written
 * (atomically), each record file no entry names is removed. Returns the
 * engine-relative paths it changed.
 */
export function writeDispositionManifest(engineRoot: string, manifest: TestSurfaceDispositionManifest): readonly string[] {
  const wanted = dispositionRecordsOf(manifest);
  const wantedPaths = new Set(wanted.map((record) => record.path));
  const present = dispositionRecordFiles(engineRoot);
  const changed: string[] = [];
  for (const record of wanted) {
    if (present.find((file) => file.path === record.path)?.text === record.text) continue;
    const written = atomicWriteFile(join(engineRoot, record.path), record.text, { createParentDirectories: true });
    if (!written.success) throw new HarnessError(`could not write the disposition record ${record.path}: ${written.reason ?? "unknown"}`, "test_surface_disposition_write_failed", false, { path: record.path });
    changed.push(record.path);
  }
  for (const file of present) {
    if (wantedPaths.has(file.path)) continue;
    rmSync(join(engineRoot, file.path));
    changed.push(file.path);
  }
  return changed.toSorted();
}

/**
 * Rewrite the records in their one form: a hand edit (a reordered key, a
 * default decision written out) heals; a record whose policy moved refuses
 * (the read refuses before anything is written). `write: false` only reports.
 */
export function rewriteDispositionRecords(engineRoot: string, write: boolean): Readonly<{ status: "current" | "regenerated"; changed: readonly string[] }> {
  // The one form: every record read (a stale policy refuses here), then the exceptions only.
  const manifest = createTestSurfaceDispositionManifest(readDispositionManifest(engineRoot).entries);
  const present = dispositionRecordFiles(engineRoot);
  const wanted = dispositionRecordsOf(manifest);
  const differs = wanted.length !== present.length || wanted.some((record, index) => present[index]?.path !== record.path || present[index]?.text !== record.text);
  if (!differs) return { status: "current", changed: [] };
  if (!write) return { status: "regenerated", changed: [] };
  return { status: "regenerated", changed: writeDispositionManifest(engineRoot, manifest) };
}
