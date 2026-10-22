/**
 * THE VENDORED FONTS, PINNED TO IBM'S RELEASE — the one writer of
 * `public/fonts/` and its lock (`public/fonts/fonts.lock.json`).
 *
 * The lock names, for each vendored file, the npm package and the path inside
 * it that the bytes come from (the human choice: which package, which
 * version, which file), and records what is GENERATED from that choice: the
 * registry's integrity for the package version (`npm view … dist.integrity`)
 * and each file's sha256. "Unmodified" is a receipt, not a claim:
 *
 *   node scripts/vendor-fonts.ts --write            fetch each pinned package (npm pack), verify the
 *                                                   tarball against the registry's integrity, copy the
 *                                                   files, record the digests, refresh the worker's digest
 *   node scripts/vendor-fonts.ts --check            offline: every vendored file matches its pin
 *   node scripts/vendor-fonts.ts --verify-upstream  network: the registry's integrity still equals the
 *                                                   pin, the tarball matches it, and every vendored file
 *                                                   is byte-identical to the file in the package
 *
 * Each prints ONE JSON line (the receipt). tests/cockpit/cockpit-fonts-owner.test.ts
 * judges the pins offline on every run.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { atomicWriteFile } from "../engine/src/filesystem/atomic-write.ts";
import { HarnessError } from "../engine/src/kernel/errors.ts";
import { syncServiceWorker } from "./service-worker-cache.ts";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const FONT_DIR = join(ROOT, "public", "fonts");
const LOCK_PATH = join(FONT_DIR, "fonts.lock.json");
export const FONT_LOCK_SCHEMA = "bridlewise-font-lock/v1";

export type FontLock = {
  schema: typeof FONT_LOCK_SCHEMA;
  packages: { name: string; version: string; integrity: string }[];
  files: { file: string; package: string; path: string; sha256: string }[];
};

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const sha512Integrity = (bytes: Uint8Array): string => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

function readLock(): FontLock {
  const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8")) as FontLock;
  if (lock.schema !== FONT_LOCK_SCHEMA) throw new HarnessError(`${LOCK_PATH} is not a ${FONT_LOCK_SCHEMA} lock`, "font_lock_invalid");
  return lock;
}

/** The registry's integrity for a package version, as npm reports it. */
function registryIntegrity(name: string, version: string): string {
  const integrity = execFileSync("npm", ["view", `${name}@${version}`, "dist.integrity"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
  if (!/^sha512-[A-Za-z0-9+/]+=*$/u.test(integrity)) throw new HarnessError(`npm gave no sha512 integrity for ${name}@${version} (got ${JSON.stringify(integrity)})`, "font_registry_integrity_missing");
  return integrity;
}

/** The files of a package version (path inside the package → bytes), from a tarball verified against `integrity`. */
function packageFiles(name: string, version: string, integrity: string, paths: readonly string[]): Map<string, Buffer> {
  const work = mkdtempSync(join(tmpdir(), "bridlewise-fonts-"));
  try {
    const tarball = execFileSync("npm", ["pack", `${name}@${version}`, "--pack-destination", work, "--silent"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim().split("\n").pop()!;
    const bytes = readFileSync(join(work, tarball));
    if (sha512Integrity(bytes) !== integrity) throw new HarnessError(`${name}@${version}'s tarball does not match its integrity ${integrity}`, "font_tarball_integrity_mismatch");
    execFileSync("tar", ["-xzf", join(work, tarball), "-C", work]);
    return new Map(paths.map((path) => [path, readFileSync(join(work, "package", path))]));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function write(): unknown {
  const lock = readLock();
  const packages = lock.packages.map((pkg) => ({ ...pkg, integrity: registryIntegrity(pkg.name, pkg.version) }));
  const files = lock.files.map((entry) => ({ ...entry }));
  for (const pkg of packages) {
    const own = files.filter((f) => f.package === pkg.name);
    const bytes = packageFiles(pkg.name, pkg.version, pkg.integrity, own.map((f) => f.path));
    for (const entry of own) {
      const data = bytes.get(entry.path)!;
      // Served files: world-readable like every other file under public/.
      const written = atomicWriteFile(join(FONT_DIR, entry.file), data, { exactMode: 0o644 });
      if (!written.success) throw new HarnessError(`could not write ${entry.file}: ${written.reason ?? "unknown"}`, "font_write_failed");
      entry.sha256 = sha256(data);
    }
  }
  const next: FontLock = { schema: FONT_LOCK_SCHEMA, packages, files };
  const text = `${JSON.stringify(next, null, 2)}\n`;
  const written = atomicWriteFile(LOCK_PATH, text, { exactMode: 0o644 });
  if (!written.success) throw new HarnessError(`could not write ${LOCK_PATH}: ${written.reason ?? "unknown"}`, "font_write_failed");
  return { status: "written", packages: packages.map((p) => `${p.name}@${p.version}`), worker: syncServiceWorker(ROOT).status };
}

/** Offline: every vendored font file matches its pin, and every pinned file is vendored. */
export function checkFonts(): { allCurrent: boolean; changed: string[] } {
  const lock = readLock();
  const vendored = readdirSync(FONT_DIR).filter((name) => /\.(?:woff2?|ttf|otf)$/u.test(name)).sort();
  const changed = [
    ...lock.files.filter((f) => !vendored.includes(f.file) || sha256(readFileSync(join(FONT_DIR, f.file))) !== f.sha256).map((f) => f.file),
    ...vendored.filter((name) => !lock.files.some((f) => f.file === name)),
  ];
  return { allCurrent: changed.length === 0, changed };
}

function verifyUpstream(): unknown {
  const lock = readLock();
  const receipt = lock.packages.map((pkg) => {
    const registry = registryIntegrity(pkg.name, pkg.version);
    const own = lock.files.filter((f) => f.package === pkg.name);
    const bytes = packageFiles(pkg.name, pkg.version, registry, own.map((f) => f.path));
    return {
      package: `${pkg.name}@${pkg.version}`,
      integrity: registry,
      pinned: registry === pkg.integrity,
      files: own.map((f) => ({ file: f.file, sha256: f.sha256, identical: Buffer.compare(bytes.get(f.path)!, readFileSync(join(FONT_DIR, f.file))) === 0 })),
    };
  });
  const verified = receipt.every((r) => r.pinned && r.files.every((f) => f.identical));
  return { verified, receipt };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  const result = mode === "--write" ? write() : mode === "--check" ? checkFonts() : mode === "--verify-upstream" ? verifyUpstream() : null;
  if (result === null) throw new HarnessError("Usage: vendor-fonts --write | --check | --verify-upstream", "input_error");
  console.log(JSON.stringify(result));
  const failed = (result as { allCurrent?: boolean; verified?: boolean });
  if (failed.allCurrent === false || failed.verified === false) process.exitCode = 1;
}
