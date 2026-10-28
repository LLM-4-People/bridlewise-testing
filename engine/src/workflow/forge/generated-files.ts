/**
 * THE FORGE'S GENERATED FILES — written here, from their owners, never by
 * hand:
 *
 * - under `.github/forge/`: the four App manifests (`apps/<role>.json`, from
 *   the App registry and the `forge` section); every declared GitHub object
 *   (`<kind>/<scope>.<key>.json`, `declarations.ts`: rulesets, settings,
 *   environments, the security configuration, properties, teams, labels,
 *   issue types and fields, autolinks, the Project); and the index of them
 *   all (`manifest.json`: each file's sha256 — the one record `harness forge
 *   plan|apply|audit` bind to);
 * - beside it: `.github/dependabot.yml` and `.github/CODEOWNERS`
 *   (`repository-files.ts`).
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
import { workingTreeReader } from "../../git/tree-reader.ts";
import { COMMUNITY_DIRECTORY, readIntake, readRoles, type CommunityRoles } from "../community/sources.ts";
import { FORGE_APP_ROLES, FORGE_APPS, type ForgeAppRole } from "./app-registry.ts";
import { ForgeError } from "./codes.ts";
import { forgeDeclarations, type DeclarationSources } from "./declarations.ts";
import { trunkRepository, type ForgeSettings } from "./forge-config.ts";
import { CODEOWNERS_FILE, codeownersFile, DEPENDABOT_FILE, dependabotFile, forgeTreeFacts, isDependencyLockfile, type ForgeTreeFacts } from "./repository-files.ts";

/** Where the generated files live, relative to the repository top. */
const FORGE_FILES_DIRECTORY = ".github/forge";
const INDEX_FILE = "manifest.json";
const INDEX_SCHEMA = schemaId("forge-generated-files", 1);

/** The local callback every App manifest redirects to (the Apps page, `apps-page.ts`). */
export function appsPageOrigin(settings: ForgeSettings): string {
  return `http://127.0.0.1:${String(settings.appsPage.port)}`;
}

/** The trunk's web URL. */
function trunkWebUrl(settings: ForgeSettings): string {
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

/** Everything the generated files are a function of. */
export type ForgeFileSources = DeclarationSources & Readonly<{ roles: CommunityRoles; facts: ForgeTreeFacts }>;

/** The sources as the repository at `top` holds them (its `forge` section given). */
/**
 * Every repository path the forge-files arm reads or writes outside the
 * engine: the community sources (`readIntake`, `readRoles`), `.github/` (the
 * workflows `forgeTreeFacts` reads, and the files this arm generates there)
 * and every dependency lockfile (the roots Dependabot must cover). A tree
 * missing one of them makes the arm refuse, loudly. The population of a
 * generator test's repository copy is derived from this
 * (`GENERATOR_INPUTS_BEYOND_ENGINE`).
 */
export function forgeFilesInput(path: string): boolean {
  return path.startsWith(`${COMMUNITY_DIRECTORY}/`) || path.startsWith(".github/") || isDependencyLockfile(path);
}

export function forgeFileSources(top: string, settings: ForgeSettings): ForgeFileSources {
  const facts = forgeTreeFacts(workingTreeReader(top), settings);
  return deepFreeze({ settings, intake: readIntake(top), roles: readRoles(top), workflowActions: facts.workflowActions, facts });
}

/** Every generated file, by its repository-relative path, with its exact bytes (the index last). */
export function forgeGeneratedFiles(sources: ForgeFileSources): ReadonlyMap<string, string> {
  const forge = new Map<string, string>();
  for (const role of FORGE_APP_ROLES) forge.set(`apps/${role}.json`, jsonText(appManifest(role, sources.settings)));
  for (const declared of forgeDeclarations(sources)) {
    forge.set(declared.file, jsonText({ kind: declared.kind, scope: declared.scope, key: declared.key, unavailableOnPlan: declared.unavailableOnPlan, desired: declared.desired }));
  }
  const files = new Map<string, string>([...forge].map(([path, text]) => [`${FORGE_FILES_DIRECTORY}/${path}`, text]));
  files.set(DEPENDABOT_FILE, dependabotFile(sources.settings, sources.facts));
  files.set(CODEOWNERS_FILE, codeownersFile(sources.settings, sources.roles));
  const entries = [...files].map(([path, text]) => ({ path, sha256: sha256(text) }));
  files.set(`${FORGE_FILES_DIRECTORY}/${INDEX_FILE}`, jsonText({
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
 * Compare the generated files under `top` with their owners' bytes
 * (`sources`, from {@link forgeFileSources}); with `write`, write what
 * differs and remove what under `.github/forge/` is not generated. `sources`
 * absent (a checkout without a `forge` section):
 * converged only when `.github/forge/` is absent too (the renders beside it
 * are then not the forge's).
 */
export function syncForgeFiles(top: string, sources: ForgeFileSources | undefined, write: boolean): ForgeFilesReport {
  const wanted = sources === undefined ? new Map<string, string>() : forgeGeneratedFiles(sources);
  const changed: string[] = [];
  for (const [path, text] of wanted) {
    const file = join(top, path);
    if (existsSync(file) && readFileSync(file, "utf8") === text) continue;
    changed.push(path);
    if (write) {
      const written = atomicWriteFile(file, text, { createMode: 0o666 });
      if (!written.success) throw new ForgeError("forge_request_invalid", `The generated forge file ${path} could not be written (${written.reason ?? "unknown"}).`, { path });
    }
  }
  const directory = join(top, FORGE_FILES_DIRECTORY);
  for (const path of filesUnder(directory).map((entry) => `${FORGE_FILES_DIRECTORY}/${entry}`)) {
    if (wanted.has(path)) continue;
    changed.push(path);
    if (write) rmSync(join(top, path));
  }
  const status = changed.length === 0 ? "current" : write ? "regenerated" : "stale";
  return deepFreeze({ status, converged: status !== "stale", changed: changed.sort() });
}
