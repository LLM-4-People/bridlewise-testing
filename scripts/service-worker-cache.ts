/**
 * THE SERVICE WORKER'S CACHE VERSION, DERIVED — the one place it is computed.
 *
 * `public/sw.js` names its caches `harness-{static,runtime}-<generation>-<digest>`.
 * The generation (`CACHE_GENERATION`) is raised by hand only when the
 * worker's own caching logic changes. The digest (`ASSETS_DIGEST`) is never
 * typed: it is the content hash of EVERY asset the worker caches, so a changed
 * icon, font or bundle is a new cache and an installed app refreshes.
 *
 * Two writers share this one computation, each for its own artifact:
 * - the committed `public/sw.js` carries the digest of the public assets it
 *   precaches and caches (`public/` minus the worker and the READMEs):
 *   `node scripts/service-worker-cache.ts --write|--check`, run by the
 *   generators that change those assets (the icon generator, the font
 *   vendoring) and judged by tests/prevention/pwa.test.ts;
 * - the production build rewrites the BUILT worker's line with the digest of
 *   every file the build emits next to it (the public assets AND the hashed
 *   bundles): `serviceWorkerDigestPlugin()`, in vite.config.ts.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { atomicWriteFile } from "../engine/src/filesystem/atomic-write.ts";
import { HarnessError } from "../engine/src/kernel/errors.ts";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const SERVICE_WORKER_PATH = "public/sw.js";
export const ASSETS_DIGEST_BLOCK = Object.freeze({
  begin: "// BEGIN GENERATED: the cached assets' digest (scripts/service-worker-cache.ts)",
  end: "// END GENERATED: the cached assets' digest",
});
const NOT_CACHED = new Set(["sw.js", "README.md"]);
/** How many hex characters of the sha256 name a cache: enough to tell asset sets apart, short enough to read. */
const DIGEST_HEX_LENGTH = 12;

/** The digest (sha256, 12 hex) of `files` (name → bytes): each name and its bytes, in name order. */
export function assetsDigest(files: ReadonlyMap<string, Uint8Array>): string {
  const hash = createHash("sha256");
  for (const name of [...files.keys()].sort()) {
    hash.update(name);
    hash.update("\0");
    hash.update(files.get(name)!);
  }
  return hash.digest("hex").slice(0, DIGEST_HEX_LENGTH);
}

/** Every file under `directory` the worker caches (relative POSIX names → bytes): all but the worker itself and READMEs. */
export function cachedFiles(directory: string): ReadonlyMap<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (!NOT_CACHED.has(name)) files.set(relative(directory, path).split(sep).join("/"), readFileSync(path));
    }
  };
  walk(directory);
  return files;
}

/** The worker's text with its digest line set to `digest`; refused when the generated block is missing. */
export function withAssetsDigest(worker: string, digest: string): string {
  const begin = worker.indexOf(ASSETS_DIGEST_BLOCK.begin);
  const end = worker.indexOf(ASSETS_DIGEST_BLOCK.end);
  if (begin < 0 || end < begin) throw new HarnessError(`the service worker carries no "${ASSETS_DIGEST_BLOCK.begin}" block`, "service_worker_digest_block_missing");
  return `${worker.slice(0, begin + ASSETS_DIGEST_BLOCK.begin.length)}\nconst ASSETS_DIGEST = "${digest}";\n${worker.slice(end)}`;
}

/** The committed worker as it should read for the public assets of the repository at `root`. */
export function committedServiceWorker(root: string = ROOT): string {
  return withAssetsDigest(readFileSync(join(root, SERVICE_WORKER_PATH), "utf8"), assetsDigest(cachedFiles(join(root, "public"))));
}

/** Writes (or with `check`, judges) the committed worker's digest line; one JSON line, the generator protocol. */
export function syncServiceWorker(root: string = ROOT, check = false): Readonly<{ allCurrent: boolean; status: string; changed: readonly string[] }> {
  const path = join(root, SERVICE_WORKER_PATH);
  const next = committedServiceWorker(root);
  if (next === readFileSync(path, "utf8")) return { allCurrent: true, status: "current", changed: [] };
  if (check) return { allCurrent: false, status: "stale", changed: [SERVICE_WORKER_PATH] };
  // Served files: world-readable like every other file under public/.
  const written = atomicWriteFile(path, next, { exactMode: 0o644 });
  if (!written.success) throw new HarnessError(`could not write ${path}: ${written.reason ?? "unknown"}`, "service_worker_write_failed");
  return { allCurrent: true, status: "regenerated", changed: [SERVICE_WORKER_PATH] };
}

/**
 * The build's writer: after the bundle is written, the built worker's digest
 * line is set from every file emitted next to it (public assets and hashed
 * bundles alike), so a new bundle is a new cache.
 */
export function serviceWorkerDigestPlugin(): { name: string; apply: "build"; writeBundle: (options: { dir?: string }) => void } {
  return {
    name: "bridlewise-service-worker-digest",
    apply: "build",
    writeBundle(options) {
      if (options.dir === undefined) throw new HarnessError("the service worker digest needs the build's output directory", "service_worker_build_dir_missing");
      const worker = join(options.dir, "sw.js");
      const next = withAssetsDigest(readFileSync(worker, "utf8"), assetsDigest(cachedFiles(options.dir)));
      const written = atomicWriteFile(worker, next, { exactMode: 0o644 });
      if (!written.success) throw new HarnessError(`could not write ${worker}: ${written.reason ?? "unknown"}`, "service_worker_write_failed");
    },
  };
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = syncServiceWorker(ROOT, process.argv.includes("--check"));
  console.log(JSON.stringify(report));
  if (!report.allCurrent) process.exitCode = 1;
}
