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

const FORGE_OBJECT_KINDS = deepFreeze([
  "custom-property", "custom-property-values", "org-settings", "team", "team-repository", "security-configuration", "security-configuration-repositories",
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

/** THE FORGE'S ONE JSON FILE TEXT: two-space indented, one final newline (every generated file and identity copy). */
export function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * GITHUB'S RULESET DEFAULTS: the rule parameters GitHub stores and answers
 * NOTHING for when they hold their default (measured on the live org,
 * 2026-10-29; a rule whose parameters all hold theirs comes back with no
 * `parameters` at all). Each is filled at its default on both sides by
 * {@link rulesetWithGithubDefaults}, so an omitted default reads as declared
 * and a non-default value GitHub answers is still a difference.
 */
const RULE_PARAMETER_DEFAULTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = deepFreeze({
  pull_request: { dismissal_restriction: { enabled: false, allowed_actors: [] } },
  update: { update_allows_fetch_and_merge: false },
  max_file_size: { ignored_file_paths: [] },
  file_path_restriction: { ignored_file_paths: [] },
});
/** The source GitHub answers for a repository-property condition that names none (an organisation's custom property). */
const REPOSITORY_PROPERTY_SOURCE = "custom";

/**
 * THE ONE RULESET NORMALISER, for a declared ruleset and a ruleset GitHub
 * answers alike: every omitted rule parameter at GitHub's default
 * ({@link RULE_PARAMETER_DEFAULTS}), a repository-property condition's
 * omitted `source` as `custom`, and `conditions: null` (a repository
 * ruleset with none) as absent.
 */
export function rulesetWithGithubDefaults<T>(ruleset: T): T {
  if (typeof ruleset !== "object" || ruleset === null || Array.isArray(ruleset)) return ruleset;
  const withSource = (entries: unknown): unknown => Array.isArray(entries)
    ? entries.map((entry) => typeof entry === "object" && entry !== null && !("source" in entry) ? { ...(entry as object), source: REPOSITORY_PROPERTY_SOURCE } : entry)
    : entries;
  const conditionsOf = (conditions: Record<string, unknown>): Record<string, unknown> => {
    const property = conditions.repository_property as Record<string, unknown> | undefined;
    return property === undefined ? conditions : { ...conditions, repository_property: { ...property, include: withSource(property.include), exclude: withSource(property.exclude) } };
  };
  const ruleOf = (rule: unknown): unknown => {
    const typed = rule as Readonly<{ type?: unknown; parameters?: Record<string, unknown> }>;
    const defaults = RULE_PARAMETER_DEFAULTS[String(typed.type)];
    if (defaults === undefined) return rule;
    // GitHub answers a rule whose parameters all hold their defaults with no `parameters` at all (`{"type":"update"}`).
    const parameters = typed.parameters ?? {};
    // A parameter the rule names keeps its value and place; an omitted one is appended at GitHub's default.
    return { ...typed, parameters: { ...parameters, ...Object.fromEntries(Object.entries(defaults).filter(([name]) => !(name in parameters))) } };
  };
  // Each field keeps its place: a null `conditions` is dropped, the rest normalised where they stand.
  return Object.fromEntries(Object.entries(ruleset as Record<string, unknown>).flatMap(([field, value]) => {
    if (field === "conditions") return value === null ? [] : [[field, typeof value === "object" ? conditionsOf(value as Record<string, unknown>) : value]];
    if (field === "rules") return [[field, Array.isArray(value) ? value.map(ruleOf) : value]];
    return [[field, value]];
  })) as T;
}
