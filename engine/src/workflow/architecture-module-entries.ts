/**
 * THE ARCHITECTURE'S MODULE ENTRIES, AS TEXT: their one reader and their one
 * form.
 *
 * `src/architecture-modules.ts` holds what is AUTHORED about each module (its
 * realm, layer, owner, roles, effects, ports, owned state and authority) as
 * ONE ENTRY PER LINE, SORTED BY PATH (#221): two branches that register,
 * remove or reclassify different modules touch different lines and merge.
 * What the source itself says (its exports, its imports) is never written
 * there: the architecture check derives it from the source every time, so no
 * per-module count, name hash or edge list can conflict or go stale.
 *
 * The module registrar (`harness sync`) is the file's writer: it reads the
 * entries here (from the TEXT, never by importing the module it rewrites),
 * adds, removes or marks entries, and writes them back in the one form
 * {@link architectureModulesText} renders. `harness check` refuses a file
 * that is not in that form. A reader that only needs the entries' facts (a
 * guard mapping the web hub's namespaces to module ids) reads them here too,
 * without executing the module or carrying it into a browser-side closure.
 */
import { parse as parseModule } from "@babel/parser";
import { z } from "zod";

import type { ArchitectureModuleEntry } from "../architecture-manifest.ts";
import { InputError } from "../kernel/errors.ts";
import { astNode, astNodeArray, type AstNode } from "../quality-packs/prevention/ast-helpers.ts";

/** The authored module entries, engine-relative. */
export const ARCHITECTURE_MODULES_PATH = "src/architecture-modules.ts";

const NAMES = z.array(z.string().min(1));
/** Every authored field, in the one order a line renders them; the optional ones are written only when not their default. */
const ENTRY_SCHEMA = z.strictObject({
  id: z.string().min(1),
  path: z.string().min(1),
  realm: z.enum(["builder", "runtime", "shared", "safety"]),
  layer: z.enum(["trusted-kernel", "domain", "ports", "application", "infrastructure", "interface", "verification"]),
  owner: z.string().min(1),
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

const HEADER = `/**
 * THE ARCHITECTURE'S MODULES: one authored entry per line, sorted by path.
 *
 * Each line is what is decided about one module: its realm, layer and owner,
 * and, when not the default, its execution boundary and composition-root
 * role, ports, effects, config paths, owned state and projections, authority
 * and responsibilities. What its source says (exports, imports) is derived
 * by the architecture check and never written here.
 *
 * \`harness sync\` (the module registrar) adds the line of a new source module
 * (classified like its nearest registered neighbour), removes the line of a
 * deleted one, marks a detected entry point a composition root, and writes
 * this file in its one form (src/workflow/architecture-module-entries.ts);
 * \`harness check\` refuses any other. Edit a line to change a decision.
 */
import type { ArchitectureModuleEntry } from "./architecture-manifest.ts";

export const ARCHITECTURE_MODULES: readonly ArchitectureModuleEntry[] = [
`;
const FOOTER = "];\n";

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
          throw refused(`an entry property is not a plain key: ${String(property.type)}`);
        }
        return [String(key.type === "Identifier" ? key.name : key.value), literalValue(astNode(property.value))];
      }));
    default:
      throw refused(`an entry holds a ${String(node?.type)}, not a literal`);
  }
}

/**
 * The entries of `text` (the file's contents), in file order, each checked
 * against the authored fields: an entry that is not a plain literal, misses a
 * field or carries an unknown one is refused (`architecture_modules_invalid`).
 */
export function readArchitectureModuleEntries(text: string): readonly ArchitectureModuleEntry[] {
  const program = parseModule(text, { sourceType: "module", plugins: ["typescript"], errorRecovery: false }).program;
  const declarations = astNodeArray(program.body).flatMap((statement) =>
    statement.type === "ExportNamedDeclaration" && astNode(statement.declaration)?.type === "VariableDeclaration"
      ? astNodeArray(astNode(statement.declaration)!.declarations)
      : []);
  const modules = declarations.find((declaration) => astNode(declaration.id)?.name === "ARCHITECTURE_MODULES");
  const array = astNode(modules?.init);
  if (array?.type !== "ArrayExpression") throw refused("no `export const ARCHITECTURE_MODULES = [...]` array");
  return astNodeArray(array.elements).map((element) => {
    const parsed = ENTRY_SCHEMA.safeParse(literalValue(element));
    if (!parsed.success) throw refused(`an entry is not an architecture module entry: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
    return parsed.data as ArchitectureModuleEntry;
  });
}

/** Is `value` the default `moduleContract` gives the field when the entry leaves it out? */
function isDefault(entry: ArchitectureModuleEntry, field: keyof ArchitectureModuleEntry): boolean {
  const value = entry[field];
  if (value === undefined) return true;
  switch (field) {
    case "executionBoundary": return value === "pure";
    case "compositionRoot": return value === false;
    case "ports": return entry.ports!.requires.length === 0 && entry.ports!.provides.length === 0;
    case "responsibilities": return entry.responsibilities!.length === 1 && entry.responsibilities![0] === entry.id;
    case "id": case "path": case "realm": case "layer": case "owner": return false;
    default: return Array.isArray(value) && value.length === 0;
  }
}

/** One entry's line: its fields in the one order, each optional field only when it is not its default. */
function entryLine(entry: ArchitectureModuleEntry): string {
  const fields = FIELD_ORDER.filter((field) => !isDefault(entry, field)).map((field) => `${field}: ${JSON.stringify(entry[field])}`);
  return `  { ${fields.join(", ")} },`;
}

/**
 * THE ONE FORM of the module entries: the fixed header, then one line per
 * entry sorted by path. Two entries with one path are refused.
 */
export function architectureModulesText(entries: readonly ArchitectureModuleEntry[]): string {
  const sorted = entries.toSorted((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const duplicate = sorted.find((entry, index) => index > 0 && sorted[index - 1]!.path === entry.path);
  if (duplicate !== undefined) throw refused(`two entries register ${duplicate.path}`);
  return `${HEADER}${sorted.map(entryLine).join("\n")}${sorted.length === 0 ? "" : "\n"}${FOOTER}`;
}
