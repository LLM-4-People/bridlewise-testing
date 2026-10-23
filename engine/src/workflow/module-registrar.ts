/**
 * THE MODULE REGISTRAR: every source module has exactly one authored entry in
 * `src/architecture-modules.ts`, and the file is in its one form.
 *
 * It writes only what follows from the tree: the entry of a new source module
 * (classified like its nearest registered neighbour), the removal of a deleted
 * or experiment-excluded module's entry, and the composition-root role of a
 * module that became a direct-execution entry point. What a module's source
 * says (its exports, its imports) is never written: the architecture check
 * derives it every time (#221), so no per-module aggregate can conflict
 * between two branches or go stale.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { ARCHITECTURE_MANIFEST, type ArchitectureLayer, type ArchitectureModuleEntry, type ArchitectureRealm } from "../architecture-manifest.ts";
import { atomicWriteFile } from "../filesystem/atomic-write.ts";
import { ARCHITECTURE_SOURCE_EXTENSIONS } from "../shared/source-extensions.ts";
import { canonicalJson, deepFreeze, sha256 } from "../kernel/integrity.ts";
import { InputError } from "../kernel/errors.ts";
import { parseSignedReport } from "./command-result.ts";
import { getExtension } from "../shared/path-utils.ts";
import { shouldExcludeExperiment } from "../shared/source-scan.ts";
import { analyzeArchitectureSource } from "../../scripts/verification/architecture.ts";
import { schemaId } from "../kernel/product-identity.ts";
import { ARCHITECTURE_MODULES_PATH, architectureModulesText, readArchitectureModuleEntries } from "./architecture-module-entries.ts";

export const MODULE_REGISTRAR_SCHEMA_VERSION = schemaId("module-registrar", 3);

export type ModuleRegistration = Readonly<{
  path: string;
  registered: boolean;
  /** True when the module is a direct-execution entry point (an
   *  `import.meta.url`/`process.argv` guard): its entry must declare the
   *  composition-root role. */
  compositionRoot: boolean;
}>;

export type ManifestUpdateOutcome = Readonly<{
  added: readonly string[];
  removed: readonly string[];
  marked: readonly string[];
}>;

export type ModuleRegistrarPostWrite = Readonly<{
  addedModules: number;
  removedModules: number;
  markedModules: number;
  clean: boolean;
}>;

export type ModuleRegistrarReport = Readonly<{
  schemaVersion: typeof MODULE_REGISTRAR_SCHEMA_VERSION;
  root: string;
  totalSourceModules: number;
  totalRegisteredModules: number;
  registeredModules: number;
  unregisteredModules: number;
  /** Entries to remove (source deleted or experiment-excluded) or to mark a composition root. */
  driftedModules: number;
  /** Whether the entries file is byte-equal to its one form (sorted, one entry per line). */
  entriesCurrent: boolean;
  drift: readonly ModuleRegistration[];
  unregistered: readonly ModuleRegistration[];
  postWrite: ModuleRegistrarPostWrite | null;
  generatedAt: string;
  integrityHash: string;
}>;

export type ModuleRegistrarOptions = Readonly<{
  write?: boolean;
}>;

/** The entries file's text under `root`, or a typed refusal when it is absent. */
function entriesText(root: string): string {
  const path = resolve(root, ARCHITECTURE_MODULES_PATH);
  if (!existsSync(path)) throw new InputError(`architecture module entries not found: ${ARCHITECTURE_MODULES_PATH}`, "architecture_modules_missing");
  return readFileSync(path, "utf8");
}

/** The entries registered under `root`, read from the file's TEXT (never the module this process imported). */
export function registeredModuleEntries(root: string): readonly ArchitectureModuleEntry[] {
  return readArchitectureModuleEntries(entriesText(root));
}

export function scanSourceModules(root: string, entries: readonly ArchitectureModuleEntry[] = registeredModuleEntries(root)): readonly ModuleRegistration[] {
  const extensions = new Set<string>(ARCHITECTURE_SOURCE_EXTENSIONS);
  const modules: ModuleRegistration[] = [];
  const registeredPaths = new Set(entries.map((entry) => entry.path));
  const scannedPaths = new Set<string>();

  for (const sourceRoot of ARCHITECTURE_MANIFEST.sourceRoots) {
    const absoluteRoot = resolve(root, sourceRoot);
    if (!existsSync(absoluteRoot)) continue;
    for (const file of walkDirectory(absoluteRoot, root)) {
      const relativePath = relative(root, file).replaceAll("\\", "/");
      if (!extensions.has(getExtension(relativePath))) continue;
      const baseName = relativePath.slice(relativePath.lastIndexOf("/") + 1);
      if (baseName.startsWith(".")) continue;
      if (shouldExcludeExperiment(relativePath)) continue;
      modules.push(computeModuleRegistration(root, relativePath, registeredPaths.has(relativePath)));
      scannedPaths.add(relativePath);
    }
  }

  for (const entry of entries) {
    if (scannedPaths.has(entry.path)) continue;
    // Experiment modules pruned from the walk must not be re-added from the
    // entries: that would defeat the experiment exclusion.
    if (shouldExcludeExperiment(entry.path)) continue;
    if (!existsSync(resolve(root, entry.path))) continue;
    modules.push(computeModuleRegistration(root, entry.path, true));
    scannedPaths.add(entry.path);
  }

  return deepFreeze(modules.toSorted((left, right) => left.path.localeCompare(right.path)));
}

export function compareModuleRegistrations(
  root: string,
  entries: readonly ArchitectureModuleEntry[] = registeredModuleEntries(root),
  computed: readonly ModuleRegistration[] = scanSourceModules(root, entries),
): { drift: readonly ModuleRegistration[]; unregistered: readonly ModuleRegistration[] } {
  const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));
  const computedByPath = new Map(computed.map((module) => [module.path, module]));
  const drift: ModuleRegistration[] = [];
  const unregistered: ModuleRegistration[] = [];

  for (const module of computed) {
    const entry = entryByPath.get(module.path);
    if (entry === undefined) {
      unregistered.push(module);
    } else if (module.compositionRoot && entry.compositionRoot !== true) {
      // A DETECTED direct-execution entry point is a composition root,
      // whenever it became one. One direction only: the declared roots the
      // detector cannot see (top-level programs, worker entries) are kept.
      drift.push(module);
    }
  }
  for (const entry of entries) {
    if (!computedByPath.has(entry.path)) {
      drift.push(deepFreeze({ path: entry.path, registered: true, compositionRoot: entry.compositionRoot === true }));
    }
  }
  const byPath = (left: ModuleRegistration, right: ModuleRegistration): number => left.path.localeCompare(right.path);
  return { drift: deepFreeze(drift.toSorted(byPath)), unregistered: deepFreeze(unregistered.toSorted(byPath)) };
}

export function generateModuleRegistrarReport(
  root: string,
  options: ModuleRegistrarOptions = {},
): ModuleRegistrarReport {
  const text = entriesText(root);
  const entries = readArchitectureModuleEntries(text);
  const computed = scanSourceModules(root, entries);
  const { drift, unregistered } = compareModuleRegistrations(root, entries, computed);
  const entriesCurrent = architectureModulesText(entries) === text;

  // The counts above describe the tree BEFORE any write; with write=true the
  // report also carries what the write achieved, re-read from disk.
  let postWrite: ModuleRegistrarPostWrite | null = null;
  if (options.write) {
    const outcome = updateModuleEntries(root, entries, drift, unregistered);
    const after = generateModuleRegistrarReport(root);
    postWrite = deepFreeze({
      addedModules: outcome.added.length,
      removedModules: outcome.removed.length,
      markedModules: outcome.marked.length,
      clean: after.unregisteredModules === 0 && after.driftedModules === 0 && after.entriesCurrent,
    });
  }

  const unsigned = {
    schemaVersion: MODULE_REGISTRAR_SCHEMA_VERSION,
    root,
    totalSourceModules: computed.length,
    totalRegisteredModules: entries.length,
    registeredModules: computed.length - unregistered.length,
    unregisteredModules: unregistered.length,
    driftedModules: drift.length,
    entriesCurrent,
    drift,
    unregistered,
    postWrite,
    generatedAt: new Date().toISOString(),
  } as const;
  return deepFreeze({ ...unsigned, integrityHash: sha256(canonicalJson(unsigned)) } as ModuleRegistrarReport);
}

export function parseModuleRegistrarReport(value: unknown): ModuleRegistrarReport {
  return parseSignedReport<ModuleRegistrarReport>(value, MODULE_REGISTRAR_SCHEMA_VERSION, "module registrar report");
}

function computeModuleRegistration(root: string, relativePath: string, registered: boolean): ModuleRegistration {
  const facts = analyzeArchitectureSource(relativePath, readFileSync(resolve(root, relativePath), "utf8"));
  return deepFreeze({ path: relativePath, registered, compositionRoot: facts.directExecutionEntrypoint });
}

/**
 * The entries with `drift` and `unregistered` resolved — a deleted or
 * experiment-excluded module's entry removed, a detected entry point marked a
 * composition root, a new module's entry added — written in the one form when
 * that changes the file.
 */
function updateModuleEntries(
  root: string,
  entries: readonly ArchitectureModuleEntry[],
  drift: readonly ModuleRegistration[],
  unregistered: readonly ModuleRegistration[],
): ManifestUpdateOutcome {
  const removed: string[] = [];
  const marked: string[] = [];
  const added: string[] = [];
  const driftByPath = new Map(drift.map((module) => [module.path, module]));
  const next: ArchitectureModuleEntry[] = [];
  for (const entry of entries) {
    const drifted = driftByPath.get(entry.path);
    if (drifted !== undefined && (shouldExcludeExperiment(entry.path) || !existsSync(resolve(root, entry.path)))) {
      removed.push(entry.path);
    } else if (drifted !== undefined && drifted.compositionRoot && entry.compositionRoot !== true) {
      next.push({ ...entry, executionBoundary: "composition-root", compositionRoot: true });
      marked.push(entry.path);
    } else {
      next.push(entry);
    }
  }
  for (const module of unregistered) {
    const classification = classifyModuleFromPath(module.path, next);
    next.push({
      id: deriveModuleId(module.path, next),
      path: module.path,
      ...classification,
      ...(module.compositionRoot ? { executionBoundary: "composition-root", compositionRoot: true } as const : {}),
    });
    added.push(module.path);
  }
  const text = architectureModulesText(next);
  const path = resolve(root, ARCHITECTURE_MODULES_PATH);
  if (text !== readFileSync(path, "utf8")) {
    const written = atomicWriteFile(path, text);
    if (!written.success) throw new InputError(`Failed to write ${ARCHITECTURE_MODULES_PATH}: ${written.reason ?? "unknown error"}`, "input_error");
  }
  return deepFreeze({ added: added.toSorted(), removed: removed.toSorted(), marked: marked.toSorted() });
}

function walkDirectory(dir: string, root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Prune experiment subdirectories (and their entire subtree) at the
      // walk boundary unless HARNESS_INCLUDE_EXPERIMENTS opts back in.
      const rel = relative(root, fullPath).replaceAll("\\", "/");
      if (shouldExcludeExperiment(rel)) continue;
      files.push(...walkDirectory(fullPath, root));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

// --- Auto-registration helpers (EXP473) ------------------------------------
// A new source module is classified like its nearest registered neighbour: the
// realm/layer/owner of the entry with the longest common directory prefix — no
// hardcoded path patterns. The fallback takes the most common (realm, layer,
// owner) among the entries of the same source root.

function directoryPrefix(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index + 1);
}

function classifyModuleFromPath(
  path: string,
  entries: readonly ArchitectureModuleEntry[],
): { realm: ArchitectureRealm; layer: ArchitectureLayer; owner: string } {
  const dir = directoryPrefix(path);
  let best: ArchitectureModuleEntry | null = null;
  let bestLen = -1;
  for (const entry of entries) {
    const entryDir = directoryPrefix(entry.path);
    if (dir.startsWith(entryDir) && entryDir.length > bestLen) {
      best = entry;
      bestLen = entryDir.length;
    }
  }
  if (best) {
    return { realm: best.realm, layer: best.layer, owner: best.owner };
  }
  const sourceRoot = ARCHITECTURE_MANIFEST.sourceRoots.find((root) => path.startsWith(root));
  const sameRoot = sourceRoot
    ? entries.filter((entry) => entry.path.startsWith(sourceRoot))
    : entries;
  const pool = sameRoot.length > 0 ? sameRoot : entries;
  if (pool.length === 0) {
    return { realm: "runtime", layer: "domain", owner: "unified-harness" };
  }
  const realmLayerCounts = new Map<string, number>();
  const ownerCounts = new Map<string, number>();
  for (const entry of pool) {
    const key = `${entry.realm}:${entry.layer}`;
    realmLayerCounts.set(key, (realmLayerCounts.get(key) ?? 0) + 1);
    ownerCounts.set(entry.owner, (ownerCounts.get(entry.owner) ?? 0) + 1);
  }
  const bestRealmLayer = [...realmLayerCounts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const bestOwner = [...ownerCounts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  const [realm, layer] = bestRealmLayer.split(":") as [ArchitectureRealm, ArchitectureLayer];
  return { realm, layer, owner: bestOwner };
}

function deriveModuleId(path: string, entries: readonly ArchitectureModuleEntry[]): string {
  // A deterministic id from the path: the extension stripped, separators and
  // non-alphanumerics replaced with hyphens; on a collision with an existing
  // id, a short hash of the full path keeps it unique.
  const dotIndex = path.lastIndexOf(".");
  const stem = dotIndex > 0 ? path.slice(0, dotIndex) : path;
  const baseId = stem.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const existingIds = new Set(entries.map((entry) => entry.id));
  if (!existingIds.has(baseId)) return baseId;
  return `${baseId}-${sha256(path).slice(0, 8)}`;
}
