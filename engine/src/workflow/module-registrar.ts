/**
 * THE MODULE REGISTRAR: the architecture's module decisions
 * (`src/architecture-modules.ts`) agree with the tree, in their one form.
 *
 * Every source module under the source roots IS a module (the census,
 * `architectureSourcePaths`), classified by its folder unless a decision says
 * otherwise, so a new module needs nothing written (#221). The registrar
 * writes only what follows from the tree: the removal of the decision of a
 * deleted or experiment-excluded module, and the composition-root role of a
 * module that became a direct-execution entry point. What a module's source
 * says (its exports, its imports) is never written: the architecture check
 * derives it every time.
 */
import { existsSync, lstatSync, readFileSync, type BigIntStats } from "node:fs";
import { resolve } from "node:path";

import type { ArchitectureModuleEntry } from "../architecture-manifest.ts";
import { atomicWriteFile } from "../filesystem/atomic-write.ts";
import { sameIdentity } from "../shared/identity.ts";
import { canonicalJson, deepFreeze, sha256 } from "../kernel/integrity.ts";
import { InputError } from "../kernel/errors.ts";
import { parseSignedReport } from "./command-result.ts";
import { analyzeArchitectureSource, architectureSourcePaths } from "../../scripts/verification/architecture.ts";
import { schemaId } from "../kernel/product-identity.ts";
import { ARCHITECTURE_MODULES_PATH, architectureModulesText, readArchitectureModuleDecisions, type ArchitectureModuleDecisions } from "./architecture-module-entries.ts";

export const MODULE_REGISTRAR_SCHEMA_VERSION = schemaId("module-registrar", 4);

/** A module the registrar has to act on: a decision whose source is gone, or a detected entry point its decisions do not mark. */
export type ModuleRegistration = Readonly<{
  path: string;
  /** Is the module a direct-execution entry point (an `import.meta.url`/`process.argv` guard)? Its decisions must make it a composition root. */
  compositionRoot: boolean;
}>;

export type ModuleRegistrarPostWrite = Readonly<{
  removedModules: number;
  markedModules: number;
  clean: boolean;
}>;

export type ModuleRegistrarReport = Readonly<{
  schemaVersion: typeof MODULE_REGISTRAR_SCHEMA_VERSION;
  root: string;
  /** The census: every source module under the source roots. */
  totalSourceModules: number;
  /** The module decisions recorded (a module that is only what its folder says has none). */
  moduleDecisions: number;
  /** Decisions to remove (source deleted or experiment-excluded) or entry points to mark a composition root. */
  driftedModules: number;
  /** Whether the decisions file is byte-equal to its one form. */
  entriesCurrent: boolean;
  drift: readonly ModuleRegistration[];
  postWrite: ModuleRegistrarPostWrite | null;
  generatedAt: string;
  integrityHash: string;
}>;

export type ModuleRegistrarOptions = Readonly<{
  write?: boolean;
}>;

/** The decisions file's text under `root`, or a typed refusal when it is absent. */
function decisionsText(root: string): string {
  const path = resolve(root, ARCHITECTURE_MODULES_PATH);
  if (!existsSync(path)) throw new InputError(`architecture module decisions not found: ${ARCHITECTURE_MODULES_PATH}`, "architecture_modules_missing");
  return readFileSync(path, "utf8");
}

/** The decisions recorded under `root`, read from the file's TEXT (never the module this process imported). */
function registeredModuleDecisions(root: string): ArchitectureModuleDecisions {
  return readArchitectureModuleDecisions(decisionsText(root));
}

/** The existing identity owner's full stat identity, or absence from the plain-file population. */
function sourceIdentity(root: string, path: string): BigIntStats | undefined {
  try {
    const stats = lstatSync(resolve(root, path), { bigint: true });
    return stats.isFile() ? Object.freeze(stats) : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Missing snapshots never establish that two source observations agree. */
function sameSourceIdentity(left: BigIntStats | undefined, right: BigIntStats | undefined): boolean {
  return left !== undefined && right !== undefined && sameIdentity(left, right);
}

/** Every census module that is a direct-execution entry point, by path. Write mode also binds the facts to the source identities it read. */
function detectedEntryPoints(root: string, census: readonly string[], identities?: Map<string, BigIntStats>): ReadonlySet<string> {
  return new Set(census.filter((path) => {
    const before = identities === undefined ? undefined : sourceIdentity(root, path);
    const source = readFileSync(resolve(root, path), "utf8");
    if (identities !== undefined) {
      const after = sourceIdentity(root, path);
      if (after === undefined || !sameSourceIdentity(before, after)) throw new InputError(`architecture module source changed while it was read: ${path}`, "architecture_modules_changed");
      identities.set(path, after);
    }
    return analyzeArchitectureSource(path, source).directExecutionEntrypoint;
  }));
}

/** The one drift judgement over a census and the facts derived from that same observation. */
function registrationDrift(decisions: ArchitectureModuleDecisions, census: readonly string[], entryPoints: ReadonlySet<string>): readonly ModuleRegistration[] {
  const inCensus = new Set(census);
  const byPath = new Map(decisions.entries.map((entry) => [entry.path, entry] as const));
  const drift: ModuleRegistration[] = [
    ...decisions.entries.filter((entry) => !inCensus.has(entry.path)).map((entry) => ({ path: entry.path, compositionRoot: entry.compositionRoot === true })),
    ...[...entryPoints].filter((path) => byPath.get(path)?.compositionRoot !== true).map((path) => ({ path, compositionRoot: true })),
  ];
  return deepFreeze(drift.toSorted((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/**
 * What the registrar has to act on under `root`: each decision whose module
 * is not in the census (deleted, or experiment-excluded), and each detected
 * entry point its decisions do not mark a composition root. One direction
 * only: a declared root the detector cannot see (a top-level program, a worker
 * entry) is kept.
 */
export function compareModuleRegistrations(
  root: string,
  decisions: ArchitectureModuleDecisions = registeredModuleDecisions(root),
  census: readonly string[] = architectureSourcePaths(root),
): readonly ModuleRegistration[] {
  return registrationDrift(decisions, census, detectedEntryPoints(root, census));
}

export function generateModuleRegistrarReport(
  root: string,
  options: ModuleRegistrarOptions = {},
): ModuleRegistrarReport {
  const text = decisionsText(root);
  const decisions = readArchitectureModuleDecisions(text);
  const census = architectureSourcePaths(root);
  const identities = options.write ? new Map<string, BigIntStats>() : undefined;
  const entryPoints = detectedEntryPoints(root, census, identities);
  const drift = registrationDrift(decisions, census, entryPoints);
  const entriesCurrent = architectureModulesText(decisions) === text;

  // The counts above describe the tree BEFORE any write; with write=true the
  // report also carries what the write achieved, re-read from disk.
  let postWrite: ModuleRegistrarPostWrite | null = null;
  if (options.write) {
    const outcome = updateModuleDecisions(root, decisions, census, drift);
    const decisionIdentity = sourceIdentity(root, ARCHITECTURE_MODULES_PATH);
    const afterText = decisionsText(root);
    const afterDecisions = readArchitectureModuleDecisions(afterText);
    const afterCensus = architectureSourcePaths(root);
    // Only the decisions module may have changed through this registrar. A
    // fresh population and the existing full identities protect reuse of the
    // other source facts, including an unrelated edit during this read-back.
    const stable = census.length === afterCensus.length && census.every((path, index) => path === afterCensus[index]) &&
      sameSourceIdentity(decisionIdentity, sourceIdentity(root, ARCHITECTURE_MODULES_PATH)) &&
      census.every((path) => path === ARCHITECTURE_MODULES_PATH || sameSourceIdentity(identities?.get(path), sourceIdentity(root, path)));
    let clean = false;
    if (stable) {
      const afterEntryPoints = new Set(entryPoints);
      if (!sameSourceIdentity(identities?.get(ARCHITECTURE_MODULES_PATH), decisionIdentity)) {
        if (analyzeArchitectureSource(ARCHITECTURE_MODULES_PATH, afterText).directExecutionEntrypoint) afterEntryPoints.add(ARCHITECTURE_MODULES_PATH);
        else afterEntryPoints.delete(ARCHITECTURE_MODULES_PATH);
      }
      clean = registrationDrift(afterDecisions, afterCensus, afterEntryPoints).length === 0 && architectureModulesText(afterDecisions) === afterText;
    }
    postWrite = deepFreeze({ ...outcome, clean });
  }

  const unsigned = {
    schemaVersion: MODULE_REGISTRAR_SCHEMA_VERSION,
    root,
    totalSourceModules: census.length,
    moduleDecisions: decisions.entries.length,
    driftedModules: drift.length,
    entriesCurrent,
    drift,
    postWrite,
    generatedAt: new Date().toISOString(),
  } as const;
  return deepFreeze({ ...unsigned, integrityHash: sha256(canonicalJson(unsigned)) } as ModuleRegistrarReport);
}

export function parseModuleRegistrarReport(value: unknown): ModuleRegistrarReport {
  return parseSignedReport<ModuleRegistrarReport>(value, MODULE_REGISTRAR_SCHEMA_VERSION, "module registrar report");
}

/**
 * The decisions with `drift` resolved — a gone module's decision removed, a
 * detected entry point marked a composition root — written in the one form
 * when that changes the file.
 */
function updateModuleDecisions(
  root: string,
  decisions: ArchitectureModuleDecisions,
  census: readonly string[],
  drift: readonly ModuleRegistration[],
): Omit<ModuleRegistrarPostWrite, "clean"> {
  const inCensus = new Set(census);
  const toMark = new Set(drift.filter((module) => inCensus.has(module.path)).map((module) => module.path));
  const removed = decisions.entries.filter((entry) => !inCensus.has(entry.path)).length;
  const kept = decisions.entries.filter((entry) => inCensus.has(entry.path));
  const marked: ArchitectureModuleEntry[] = [...toMark].map((path) => ({
    ...(kept.find((entry) => entry.path === path) ?? { path }),
    executionBoundary: "composition-root",
    compositionRoot: true,
  }));
  const text = architectureModulesText({ defaults: decisions.defaults, entries: [...kept.filter((entry) => !toMark.has(entry.path)), ...marked] });
  const path = resolve(root, ARCHITECTURE_MODULES_PATH);
  if (text !== readFileSync(path, "utf8")) {
    const written = atomicWriteFile(path, text);
    if (!written.success) throw new InputError(`Failed to write ${ARCHITECTURE_MODULES_PATH}: ${written.reason ?? "unknown error"}`, "input_error");
  }
  return deepFreeze({ removedModules: removed, markedModules: toMark.size });
}
