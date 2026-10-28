/**
 * THE ARCHITECTURE'S MODULE DECISIONS, AS TEXT: their one reader and their
 * one form.
 *
 * `src/architecture-modules.ts` holds what is AUTHORED about the modules, and
 * only that: one line per folder classification (realm, layer, owner every
 * module under it takes) and one line per module whose id, classification,
 * role, effects, ports, owned state or authority differs from what its path
 * and folder derive. Both lists are sorted. A module that is only what its
 * folder says has no line, so adding modules A and B in two branches changes
 * nothing here (#221), and two branches that decide about different modules
 * touch different lines.
 *
 * What the source itself says (its exports, its imports) is never written:
 * the architecture check derives it every time. The module list itself is the
 * tree's (`architectureManifestOf`).
 *
 * The module registrar (`harness sync`) writes the file: it removes the entry
 * of a deleted module, marks a detected entry point a composition root, and
 * writes both lists in the one form {@link architectureModulesText} renders
 * (a field equal to what is derived is dropped, an entry left with nothing is
 * dropped). It reads the TEXT here, never the module it rewrites; a guard
 * that needs the decisions reads them here too, without executing the module.
 */
import { parse as parseModule } from "@babel/parser";
import { z } from "zod";

import { architectureDirectoryDefault, architectureModuleId, type ArchitectureDirectoryDefault, type ArchitectureModuleEntry } from "../architecture-manifest.ts";
import { InputError } from "../kernel/errors.ts";
import { astNode, astNodeArray, type AstNode } from "../quality-packs/prevention/ast-helpers.ts";

/** The authored module decisions, engine-relative. */
export const ARCHITECTURE_MODULES_PATH = "src/architecture-modules.ts";

const REALM = z.enum(["builder", "runtime", "shared", "safety"]);
const LAYER = z.enum(["trusted-kernel", "domain", "ports", "application", "infrastructure", "interface", "verification"]);
const NAMES = z.array(z.string().min(1));
const DIRECTORY_SCHEMA = z.strictObject({
  directory: z.string().regex(/^(?:[^/]+\/)+$/u),
  realm: REALM,
  layer: LAYER,
  owner: z.string().min(1),
});
/** Every authored field of a module, in the one order a line renders them. */
const ENTRY_SCHEMA = z.strictObject({
  path: z.string().min(1),
  id: z.string().min(1).optional(),
  realm: REALM.optional(),
  layer: LAYER.optional(),
  owner: z.string().min(1).optional(),
  executionBoundary: z.enum(["pure", "read-adapter", "effect-adapter", "interface", "composition-root", "verification"]).optional(),
  compositionRoot: z.boolean().optional(),
  ports: z.strictObject({ requires: NAMES, provides: NAMES }).optional(),
  effects: z.array(z.enum([
    "child-process", "cryptography", "environment-access", "filesystem-read", "filesystem-write", "git", "network",
    "process-control", "process-status",
  ])).optional(),
  configPaths: NAMES.optional(),
  stateOwners: NAMES.optional(),
  projectionOwners: NAMES.optional(),
  authorityFamilies: z.array(z.enum(["configuration", "data-classification", "errors", "events"])).optional(),
  authorityIdentifiers: NAMES.optional(),
  responsibilities: NAMES.optional(),
});
const FIELD_ORDER = Object.keys(ENTRY_SCHEMA.shape) as readonly (keyof ArchitectureModuleEntry)[];

/** The module decisions read from the file's text. */
export type ArchitectureModuleDecisions = Readonly<{
  defaults: readonly ArchitectureDirectoryDefault[];
  entries: readonly ArchitectureModuleEntry[];
}>;

const HEADER = `/**
 * THE ARCHITECTURE'S MODULE DECISIONS: one line each, sorted.
 *
 * A folder line classifies every module under it (the deepest folder wins).
 * A module line records only what differs from what its path and folder
 * derive: an id, a realm, layer or owner, a composition-root role or
 * execution boundary, ports, effects, config paths, owned state and
 * projections, authority, responsibilities. A module that is only what its
 * folder says has no line. What a source says (exports, imports) is derived
 * by the architecture check and never written here.
 *
 * \`harness sync\` (the module registrar) removes the line of a deleted
 * module, marks a detected entry point a composition root, and writes this
 * file in its one form (src/workflow/architecture-module-entries.ts);
 * \`harness check\` refuses any other. Edit a line to change a decision.
 */
import type { ArchitectureDirectoryDefault, ArchitectureModuleEntry } from "./architecture-manifest.ts";

`;

function refused(message: string): InputError {
  return new InputError(`${ARCHITECTURE_MODULES_PATH}: ${message}`, "architecture_modules_invalid");
}

/** A literal's value: a string, a boolean, an array or an object of them. Anything else is refused. */
function literalValue(node: AstNode | undefined): unknown {
  switch (node?.type) {
    case "StringLiteral":
    case "BooleanLiteral":
      return node.value;
    case "ArrayExpression":
      return astNodeArray(node.elements).map((element) => literalValue(element));
    case "ObjectExpression":
      return Object.fromEntries(astNodeArray(node.properties).map((property) => {
        const key = astNode(property.key);
        if (property.type !== "ObjectProperty" || property.computed === true || (key?.type !== "Identifier" && key?.type !== "StringLiteral")) {
          throw refused(`a property is not a plain key: ${String(property.type)}`);
        }
        return [String(key.type === "Identifier" ? key.name : key.value), literalValue(astNode(property.value))];
      }));
    default:
      throw refused(`a line holds a ${String(node?.type)}, not a literal`);
  }
}

function exportedArray(program: AstNode, name: string): readonly AstNode[] {
  const declarations = astNodeArray(program.body).flatMap((statement) =>
    statement.type === "ExportNamedDeclaration" && astNode(statement.declaration)?.type === "VariableDeclaration"
      ? astNodeArray(astNode(statement.declaration)!.declarations)
      : []);
  const array = astNode(declarations.find((declaration) => astNode(declaration.id)?.name === name)?.init);
  if (array?.type !== "ArrayExpression") throw refused(`no \`export const ${name} = [...]\` array`);
  return astNodeArray(array.elements);
}

function parsed<T>(schema: z.ZodType<T>, node: AstNode, what: string): T {
  const result = schema.safeParse(literalValue(node));
  if (!result.success) throw refused(`a line is not ${what}: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  return result.data;
}

/**
 * The decisions of `text` (the file's contents), in file order, each checked
 * against its fields: a line that is not a plain literal, misses a field or
 * carries an unknown one is refused (`architecture_modules_invalid`).
 */
export function readArchitectureModuleDecisions(text: string): ArchitectureModuleDecisions {
  const program = parseModule(text, { sourceType: "module", plugins: ["typescript"], errorRecovery: false }).program as unknown as AstNode;
  return {
    defaults: exportedArray(program, "ARCHITECTURE_DIRECTORY_DEFAULTS").map((node) => parsed(DIRECTORY_SCHEMA, node, "a folder classification") as ArchitectureDirectoryDefault),
    entries: exportedArray(program, "ARCHITECTURE_MODULES").map((node) => parsed(ENTRY_SCHEMA, node, "a module decision") as ArchitectureModuleEntry),
  };
}

/** Is `field` of `entry` exactly what the module takes without it (from its path, its folder or the contract's default)? */
function isDerived(entry: ArchitectureModuleEntry, field: keyof ArchitectureModuleEntry, defaults: readonly ArchitectureDirectoryDefault[]): boolean {
  const value = entry[field];
  if (value === undefined) return true;
  const folder = architectureDirectoryDefault(entry.path, defaults);
  switch (field) {
    case "path": return false;
    case "id": return value === architectureModuleId(entry.path);
    case "realm": case "layer": case "owner": return folder !== undefined && value === folder[field];
    case "executionBoundary": return value === "pure";
    case "compositionRoot": return value === false;
    case "ports": return entry.ports!.requires.length === 0 && entry.ports!.provides.length === 0;
    case "responsibilities": return entry.responsibilities!.length === 1 && entry.responsibilities![0] === (entry.id ?? architectureModuleId(entry.path));
    default: return Array.isArray(value) && value.length === 0;
  }
}

const byKey = <T>(key: (item: T) => string) => (left: T, right: T): number => key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0;

/** Each item rendered `{ field: value, … }` on one line. */
const line = (fields: readonly (readonly [string, unknown])[]): string => `  { ${fields.map(([field, value]) => `${field}: ${JSON.stringify(value)}`).join(", ")} },`;

/**
 * THE ONE FORM of the decisions: the fixed header, the folder lines sorted by
 * folder, then the module lines sorted by path, each holding only what is not
 * derived (an entry left with nothing is dropped). Two lines for one folder or
 * one path are refused.
 */
export function architectureModulesText(decisions: ArchitectureModuleDecisions): string {
  const defaults = decisions.defaults.toSorted(byKey((entry) => entry.directory));
  const entries = decisions.entries
    .map((entry) => Object.fromEntries(FIELD_ORDER.filter((field) => !isDerived(entry, field, defaults)).map((field) => [field, entry[field]])) as ArchitectureModuleEntry)
    .filter((entry) => Object.keys(entry).length > 1)
    .toSorted(byKey((entry) => entry.path));
  for (const [keys, what] of [[defaults.map((entry) => entry.directory), "folder"], [entries.map((entry) => entry.path), "path"]] as const) {
    const duplicate = keys.find((value, index) => index > 0 && keys[index - 1] === value);
    if (duplicate !== undefined) throw refused(`two lines decide the ${what} ${duplicate}`);
  }
  const block = (name: string, type: string, lines: readonly string[]): string =>
    `export const ${name}: readonly ${type}[] = [\n${lines.map((text) => `${text}\n`).join("")}];\n`;
  return `${HEADER}${block("ARCHITECTURE_DIRECTORY_DEFAULTS", "ArchitectureDirectoryDefault", defaults.map((entry) => line([["directory", entry.directory], ["realm", entry.realm], ["layer", entry.layer], ["owner", entry.owner]])))}\n` +
    block("ARCHITECTURE_MODULES", "ArchitectureModuleEntry", entries.map((entry) => line(FIELD_ORDER.filter((field) => entry[field] !== undefined).map((field) => [field, entry[field]] as const))));
}
