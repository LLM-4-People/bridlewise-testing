/**
 * THE FORGE'S GENERATED FILES — everything under `.github/forge/` is written
 * here, from its owners, never by hand: the four App manifests
 * (`apps/<role>.json`, from the App registry and the `forge` section), and
 * the index of them (`manifest.json`: each file's sha256 and its owner, the
 * one record `harness forge plan|apply|audit` bind to).
 *
 * `syncForgeFiles` is one arm of `harness regenerate` (written by `harness
 * sync`) and of `harness check` (refused when a file differs from its
 * owner's bytes, or when a file under `.github/forge/` is not one of them).
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { atomicWriteFile } from "../../filesystem/atomic-write.ts";
import { deepFreeze, sha256 } from "../../kernel/integrity.ts";
import { schemaId } from "../../kernel/product-identity.ts";
import { FORGE_APP_ROLES, FORGE_APPS, type ForgeAppRole } from "./app-registry.ts";
import { ForgeError } from "./codes.ts";
import { trunkRepository, type ForgeSettings } from "./forge-config.ts";

/** Where the generated files live, relative to the repository top. */
export const FORGE_FILES_DIRECTORY = ".github/forge";
const INDEX_FILE = "manifest.json";
const INDEX_SCHEMA = schemaId("forge-generated-files", 1);

/** The local callback every App manifest redirects to (the Apps page, `apps-page.ts`). */
export function appsPageOrigin(settings: ForgeSettings): string {
  return `http://127.0.0.1:${String(settings.appsPage.port)}`;
}

/** The trunk's web URL. */
export function trunkWebUrl(settings: ForgeSettings): string {
  return `${settings.webUrl.replace(/\/$/u, "")}/${settings.organization}/${trunkRepository(settings).name}`;
}

/**
 * THE APP MANIFEST of `role` (GitHub's "registering a GitHub App from a
 * manifest"): the registry's name, description and exact permissions, no
 * webhook (inactive), owner-only (`public: false`), and the local callback.
 */
export function appManifest(role: ForgeAppRole, settings: ForgeSettings): Readonly<Record<string, unknown>> {
  const app = FORGE_APPS[role];
  const home = trunkWebUrl(settings);
  return deepFreeze({
    name: app.name,
    url: home,
    description: app.description,
    public: false,
    hook_attributes: { url: home, active: false },
    redirect_url: `${appsPageOrigin(settings)}/callback`,
    default_permissions: Object.fromEntries(Object.entries(app.permissions).sort(([left], [right]) => left.localeCompare(right))),
    default_events: [],
    request_oauth_on_install: false,
    setup_on_update: false,
  });
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Every generated file, by its path under {@link FORGE_FILES_DIRECTORY}, with its exact bytes (the index last). */
export function forgeGeneratedFiles(settings: ForgeSettings): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  for (const role of FORGE_APP_ROLES) files.set(`apps/${role}.json`, jsonText(appManifest(role, settings)));
  const entries = [...files].map(([path, text]) => ({ path, sha256: sha256(text), owner: "engine/src/workflow/forge/generated-files.ts" }));
  files.set(INDEX_FILE, jsonText({
    schemaVersion: INDEX_SCHEMA,
    generator: "harness sync (engine/src/workflow/forge/generated-files.ts); never edit by hand",
    files: entries,
  }));
  return files;
}

export type ForgeFilesReport = Readonly<{
  status: "current" | "regenerated" | "stale";
  converged: boolean;
  /** Paths (repository-relative) that differ, are missing, or are not generated. */
  changed: readonly string[];
}>;

function filesUnder(directory: string): readonly string[] {
  if (!existsSync(directory)) return [];
  const found: string[] = [];
  const walk = (folder: string): void => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      if (statSync(path).isDirectory()) walk(path);
      else found.push(relative(directory, path).replaceAll("\\", "/"));
    }
  };
  walk(directory);
  return found.sort();
}

/**
 * Compare `.github/forge/` under `top` with its owners' bytes; with `write`,
 * write what differs and remove what is not generated. `settings` absent
 * (a checkout without a `forge` section): converged only when the folder is
 * absent too.
 */
export function syncForgeFiles(top: string, settings: ForgeSettings | undefined, write: boolean): ForgeFilesReport {
  const directory = join(top, FORGE_FILES_DIRECTORY);
  const wanted = settings === undefined ? new Map<string, string>() : forgeGeneratedFiles(settings);
  const changed: string[] = [];
  for (const [path, text] of wanted) {
    const file = join(directory, path);
    if (existsSync(file) && readFileSync(file, "utf8") === text) continue;
    changed.push(`${FORGE_FILES_DIRECTORY}/${path}`);
    if (write) {
      const written = atomicWriteFile(file, text, { createMode: 0o666 });
      if (!written.success) throw new ForgeError("forge_request_invalid", `The generated forge file ${path} could not be written (${written.reason ?? "unknown"}).`, { path });
    }
  }
  for (const path of filesUnder(directory)) {
    if (wanted.has(path)) continue;
    changed.push(`${FORGE_FILES_DIRECTORY}/${path}`);
    if (write) rmSync(join(directory, path));
  }
  const status = changed.length === 0 ? "current" : write ? "regenerated" : "stale";
  return deepFreeze({ status, converged: status !== "stale", changed: changed.sort() });
}
