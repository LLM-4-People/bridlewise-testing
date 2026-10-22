/**
 * THE FORGE'S DESIRED-STATE MODEL — what `.github/forge/` declares and what
 * `harness forge plan|apply|audit` compares with GitHub:
 *
 * - a {@link ForgeObject} is one GitHub object the forge owns: its kind, its
 *   scope (the organisation, or one repository), its key (the object's name
 *   there), the generated file that holds it, and its desired body;
 * - a desired body may hold REFERENCES (`{"$ref":"app","name":"door"}`): ids
 *   that exist only on GitHub (an App's id, an installation's, a team's, a
 *   user's), resolved at plan time from the registry's names, never written
 *   by hand;
 * - fields the plan does not allow are listed per object
 *   (`unavailableOnPlan`): they stay in the file (buying the add-on later is
 *   one `forge apply`) and are stripped before any write;
 * - {@link differences} is THE comparison: every desired value must be in
 *   the live object (GitHub answers more fields than it takes; those extras
 *   are never drift), compared by JSON pointer.
 */
import { deepFreeze } from "../../kernel/integrity.ts";

export const FORGE_OBJECT_KINDS = deepFreeze([
  "custom-property", "custom-property-values", "org-settings", "team", "team-repository", "security-configuration",
  "org-ruleset", "repository-settings", "actions-permissions", "actions-selected", "actions-workflow", "actions-fork-approval",
  "immutable-releases", "environment", "ruleset", "label", "issue-type", "issue-field", "autolink", "project",
] as const);
export type ForgeObjectKind = typeof FORGE_OBJECT_KINDS[number];

export type ForgeScope = Readonly<{ kind: "org" }> | Readonly<{ kind: "repo"; repository: string }>;

/** A reference to a GitHub-side id, resolved at plan time. */
export type ForgeReference = Readonly<{ $ref: "app" | "installation" | "team" | "user"; name: string }>;

export type ForgeObject = Readonly<{
  kind: ForgeObjectKind;
  scope: ForgeScope;
  /** The object's name in its scope (a ruleset's, a label's, an environment's; the scope's own for a singleton). */
  key: string;
  /** Its generated file, relative to `.github/forge/`. */
  file: string;
  desired: unknown;
  /** Top-level fields of `desired` the plan does not allow (recorded, never written). */
  unavailableOnPlan: readonly string[];
}>;

/** A scope's name in a plan and a file name: `org`, or the repository's name. */
export function scopeName(scope: ForgeScope): string {
  return scope.kind === "org" ? "org" : scope.repository;
}

export function isReference(value: unknown): value is ForgeReference {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 2 && keys.includes("$ref") && keys.includes("name");
}

/** Every reference `value` holds. */
export function referencesOf(value: unknown): readonly ForgeReference[] {
  if (isReference(value)) return [value];
  if (Array.isArray(value)) return value.flatMap(referencesOf);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(referencesOf);
  return [];
}

export function referenceKey(reference: ForgeReference): string {
  return `${reference.$ref}:${reference.name}`;
}

/** `value` with every reference replaced by its resolved id. */
export function resolveReferences(value: unknown, resolved: ReadonlyMap<string, number>): unknown {
  if (isReference(value)) return resolved.get(referenceKey(value));
  if (Array.isArray(value)) return value.map((entry) => resolveReferences(entry, resolved));
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveReferences(entry, resolved)]));
  return value;
}

/** `desired` without the fields the plan does not allow. */
export function writableBody(object: ForgeObject, desired: unknown): unknown {
  if (object.unavailableOnPlan.length === 0 || typeof desired !== "object" || desired === null) return desired;
  return Object.fromEntries(Object.entries(desired).filter(([key]) => !object.unavailableOnPlan.includes(key)));
}

function pointer(path: readonly (string | number)[]): string {
  return path.length === 0 ? "" : `/${path.map((part) => String(part).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
}

/**
 * THE COMPARISON: the JSON pointers where `live` does not hold `desired`.
 * Objects: every desired key, recursively (extra live keys are GitHub's).
 * Arrays: the same length, element by element (an array of objects named by
 * `name`, `context` or `type` is compared as a set by that name).
 */
export function differences(desired: unknown, live: unknown, path: readonly (string | number)[] = []): readonly string[] {
  if (Array.isArray(desired)) {
    if (!Array.isArray(live) || live.length !== desired.length) return [pointer(path)];
    const named = (entry: unknown): string | undefined => {
      if (typeof entry !== "object" || entry === null) return undefined;
      const record = entry as Record<string, unknown>;
      for (const field of ["name", "context", "type"]) if (typeof record[field] === "string") return `${field}:${String(record[field])}`;
      return undefined;
    };
    if (desired.every((entry) => named(entry) !== undefined)) {
      return desired.flatMap((entry, index) => {
        const match = live.find((candidate) => named(candidate) === named(entry));
        return match === undefined ? [pointer([...path, index])] : differences(entry, match, [...path, index]);
      });
    }
    return desired.flatMap((entry, index) => differences(entry, live[index], [...path, index]));
  }
  if (typeof desired === "object" && desired !== null) {
    if (typeof live !== "object" || live === null || Array.isArray(live)) return [pointer(path)];
    return Object.entries(desired).flatMap(([key, value]) => differences(value, (live as Record<string, unknown>)[key], [...path, key]));
  }
  return Object.is(desired, live) ? [] : [pointer(path)];
}
