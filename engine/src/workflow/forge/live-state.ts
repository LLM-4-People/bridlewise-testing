/**
 * THE LIVE SIDE OF EACH DECLARED KIND — how `plan.ts` reads one declared
 * object from GitHub (normalized to the declared shape), and how `apply`
 * creates, updates or retires it. One adapter per kind; every request goes
 * through the forge port (`port.ts`), so every refusal is a typed forge code.
 *
 * Reading answers `undefined` when the object does not exist (a 404 on its
 * own path, or no entry of its name in its list). A kind that can list its
 * objects (`names`) lets the plan report the ones nobody declared.
 */
import { isPlainObject } from "../../shared/type-guards.ts";
import { FORGE_APPS, type ForgeAppRole } from "./app-registry.ts";
import { ForgeError, isForgeError } from "./codes.ts";
import { rulesetWithGithubDefaults, type ForgeObject, type ForgeObjectKind, type ForgeScope } from "./forge-state.ts";
import type { ForgeClient, ForgeRequest } from "./port.ts";

export type LiveContext = Readonly<{ client: ForgeClient; organization: string; maxPages: number }>;

/** What a read found: the live object in the declared shape, and its GitHub id when writes address it by id. */
export type LiveObject = Readonly<{ live: unknown; id?: string | number }>;

export type KindAdapter = Readonly<{
  read: (context: LiveContext, object: ForgeObject) => Promise<LiveObject | undefined>;
  create: (context: LiveContext, object: ForgeObject, body: unknown) => Promise<void>;
  update: (context: LiveContext, object: ForgeObject, body: unknown, found: LiveObject) => Promise<void>;
  /** The names of every live object of the kind in `scope` (for the unmanaged report). */
  names?: (context: LiveContext, scope: ForgeScope) => Promise<readonly string[]>;
  /** Delete a live object (a retired one) found by `read`. */
  remove?: (context: LiveContext, found: LiveObject, scope: ForgeScope) => Promise<void>;
  /**
   * How GitHub compares two names of this kind (the key matching and the
   * unmanaged report use it): absent, exactly; a label's name is compared
   * without case, so "Bug" on GitHub IS the declared "bug", and the
   * difference in spelling is an update, never a missing label.
   */
  nameKey?: (name: string) => string;
  /**
   * The declared fields GitHub cannot take YET, each with why (a certificate
   * still being issued). The plan leaves them out of what it writes and
   * reports them `pending`: a convergence still under way, never a failure.
   * A field that can no longer converge (a failed certificate) is a typed
   * refusal the hook throws: drift, never pending forever.
   */
  pending?: (desired: unknown, live: unknown) => Readonly<Record<string, string>>;
}>;

const segment = encodeURIComponent;

function repositoryOf(object: Readonly<{ scope: ForgeScope }>): string {
  if (object.scope.kind !== "repo") throw new ForgeError("forge_declaration_invalid", "A repository-scoped kind was declared at the organisation.", {});
  return object.scope.repository;
}

function repoPath(context: LiveContext, repository: string): string {
  return `/repos/${segment(context.organization)}/${segment(repository)}`;
}

function orgPath(context: LiveContext): string {
  return `/orgs/${segment(context.organization)}`;
}

/** GET `path`, or `undefined` on a 404. */
async function getOrAbsent<T>(context: LiveContext, path: string, accept?: string): Promise<T | undefined> {
  try {
    return (await context.client.rest<T>({ method: "GET", path, ...(accept === undefined ? {} : { accept }) })).data;
  } catch (error) {
    if (isForgeError(error, "github_not_found")) return undefined;
    throw error;
  }
}

async function send(context: LiveContext, method: ForgeRequest["method"], path: string, body?: unknown): Promise<unknown> {
  return (await context.client.rest({ method, path, ...(body === undefined ? {} : { body }) })).data;
}

async function list<T>(context: LiveContext, path: string, items?: (data: unknown) => readonly T[]): Promise<readonly T[]> {
  return context.client.paginate<T>({ path }, { maxPages: context.maxPages, perPage: 100, ...(items === undefined ? {} : { items }) });
}

/** A singleton read with GET `path(object)` and written with `method`. */
function singleton(path: (context: LiveContext, object: ForgeObject) => string, method: "PUT" | "PATCH"): KindAdapter {
  const write = async (context: LiveContext, object: ForgeObject, body: unknown): Promise<void> => { await send(context, method, path(context, object), body); };
  return {
    read: async (context, object) => {
      const live = await getOrAbsent(context, path(context, object));
      return live === undefined ? undefined : { live };
    },
    create: write,
    update: write,
  };
}

/** A kind listed at `collection`, named by `nameOf`, written at `collection` (create) and `itemPath(id)` (update). */
function namedCollection<T extends Record<string, unknown>>(options: Readonly<{
  collection: (context: LiveContext, scope: ForgeScope) => string;
  nameOf: (item: T) => string;
  idOf: (item: T) => string | number;
  itemPath: (context: LiveContext, scope: ForgeScope, id: string | number) => string;
  updateMethod: "PUT" | "PATCH";
  /** Read the full object by id (a ruleset's list entry carries no rules). */
  detailed?: boolean;
  items?: (data: unknown) => readonly T[];
  /** What an update may not send (an issue field's data type). */
  updateOmits?: readonly string[];
  /** The update body as the endpoint names its fields (a label is renamed through `new_name`). */
  updateBody?: (body: Record<string, unknown>) => Record<string, unknown>;
  normalize?: (item: T) => unknown;
  nameKey?: (name: string) => string;
}>): KindAdapter {
  const key = options.nameKey ?? ((name: string) => name);
  const find = async (context: LiveContext, scope: ForgeScope, name: string): Promise<T | undefined> => {
    const found = (await list<T>(context, options.collection(context, scope), options.items)).find((item) => key(options.nameOf(item)) === key(name));
    if (found === undefined || options.detailed !== true) return found;
    return (await context.client.rest<T>({ method: "GET", path: options.itemPath(context, scope, options.idOf(found)) })).data;
  };
  return {
    read: async (context, object) => {
      const item = await find(context, object.scope, object.key);
      return item === undefined ? undefined : { live: options.normalize === undefined ? item : options.normalize(item), id: options.idOf(item) };
    },
    create: async (context, object, body) => { await send(context, "POST", options.collection(context, object.scope), body); },
    update: async (context, object, body, found) => {
      const kept = options.updateOmits === undefined ? body : Object.fromEntries(Object.entries(body as Record<string, unknown>).filter(([field]) => !options.updateOmits!.includes(field)));
      const sent = options.updateBody === undefined ? kept : options.updateBody(kept as Record<string, unknown>);
      await send(context, options.updateMethod, options.itemPath(context, object.scope, found.id!), sent);
    },
    names: async (context, scope) => (await list<T>(context, options.collection(context, scope), options.items)).map(options.nameOf),
    remove: async (context, found, scope) => { await send(context, "DELETE", options.itemPath(context, scope, found.id!)); },
    ...(options.nameKey === undefined ? {} : { nameKey: options.nameKey }),
  };
}

/** The live name-to-ID binding wins over a declaration: omitting an existing ID replaces that option and loses its assignments. */
function withExistingOptionIds<Option extends Readonly<{ name?: unknown }>, Id>(declared: readonly Option[], live: readonly Readonly<{ name?: unknown; id?: Id }>[]): readonly (Option & Readonly<{ id?: Id }>)[] {
  const byName = new Map<unknown, Id | undefined>();
  for (const option of live) if (!byName.has(option.name)) byName.set(option.name, option.id);
  return declared.map((option) => {
    const id = byName.get(option.name);
    return id === undefined ? option : { ...option, id };
  });
}

/**
 * An issue field. Its options are compared by what is declared (name, color,
 * priority), never by their ids. An update sends each existing option's id
 * (matched by name), because an option sent without its id is a new option,
 * and every issue's value of the old one would be wiped.
 */
function issueField(): KindAdapter {
  type FieldOption = Readonly<{ id?: unknown; name?: unknown; color?: unknown; priority?: unknown }>;
  const withoutIds = (item: Record<string, unknown>): unknown => Array.isArray(item.options)
    ? { ...item, options: (item.options as FieldOption[]).map(({ id: _id, ...option }) => option) }
    : item;
  const base = namedCollection<Record<string, unknown>>({
    collection: (context) => `${orgPath(context)}/issue-fields`,
    nameOf: (item) => String(item.name),
    idOf: (item) => item.id as number,
    itemPath: (context, _scope, id) => `${orgPath(context)}/issue-fields/${String(id)}`,
    updateMethod: "PATCH",
    updateOmits: ["data_type"],
    normalize: withoutIds,
  });
  return {
    ...base,
    update: async (context, object, body, found) => {
      const raw = (await list<Record<string, unknown>>(context, `${orgPath(context)}/issue-fields`)).find((item) => item.name === object.key);
      const liveOptions = Array.isArray(raw?.options) ? (raw.options as FieldOption[]) : [];
      const declared = body as Record<string, unknown>;
      const withIds = Array.isArray(declared.options)
        ? { ...declared, options: withExistingOptionIds(declared.options as FieldOption[], liveOptions) }
        : declared;
      await base.update(context, object, withIds, found);
    },
  };
}

type Environment = Readonly<{ deployment_branch_policy?: unknown; can_admins_bypass?: unknown; protection_rules?: readonly Readonly<{ type?: string; prevent_self_review?: unknown; reviewers?: readonly Readonly<{ type?: string; reviewer?: { id?: number } }>[] }>[] }>;

const environment: KindAdapter = {
  read: async (context, object) => {
    const path = `${repoPath(context, repositoryOf(object))}/environments/${segment(object.key)}`;
    const found = await getOrAbsent<Environment>(context, path);
    if (found === undefined) return undefined;
    const policies = await list<{ name: string }>(context, `${path}/deployment-branch-policies`, (data) => (data as { branch_policies?: { name: string }[] }).branch_policies ?? []);
    const reviewerRules = (found.protection_rules ?? []).filter((rule) => rule.type === "required_reviewers");
    const reviewers = reviewerRules.flatMap((rule) => rule.reviewers ?? []).map((entry) => ({ type: entry.type, id: entry.reviewer?.id }));
    return { live: {
      deployment_branch_policy: found.deployment_branch_policy, can_admins_bypass: found.can_admins_bypass, branch_policies: policies.map((policy) => policy.name).sort(),
      ...(reviewers.length === 0 ? {} : { reviewers, prevent_self_review: reviewerRules.some((rule) => rule.prevent_self_review === true) }),
    } };
  },
  create: async (context, object, body) => environment.update(context, object, body, { live: { branch_policies: [] } }),
  update: async (context, object, body, found) => {
    const path = `${repoPath(context, repositoryOf(object))}/environments/${segment(object.key)}`;
    const { branch_policies: policies, ...settings } = body as { branch_policies: readonly string[] } & Record<string, unknown>;
    await send(context, "PUT", path, settings);
    const existing = ((found.live as { branch_policies?: readonly string[] }).branch_policies) ?? [];
    for (const name of policies.filter((policy) => !existing.includes(policy))) await send(context, "POST", `${path}/deployment-branch-policies`, { name, type: "branch" });
  },
};

const ROLE_PERMISSION: Readonly<Record<string, string>> = { read: "pull", triage: "triage", write: "push", maintain: "maintain", admin: "admin" };

const teamSlug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/gu, "-");

/**
 * A team, with its MEMBERS as data: read back (so a member added in the UI is
 * drift) and reconciled after every write: the declared members are added and
 * every other member is removed. That includes the account GitHub adds as
 * maintainer when a team is created through the API.
 */
const team: KindAdapter = {
  read: async (context, object) => {
    const path = `${orgPath(context)}/teams/${segment(teamSlug(object.key))}`;
    const found = await getOrAbsent<Record<string, unknown>>(context, path);
    if (found === undefined) return undefined;
    const members = (await list<{ login?: unknown }>(context, `${path}/members`)).flatMap((member) => typeof member.login === "string" ? [member.login] : []).sort();
    return { live: { ...found, members }, id: found.id as number };
  },
  create: async (context, object, body) => {
    const { members, ...fields } = body as { members: readonly string[] } & Record<string, unknown>;
    await send(context, "POST", `${orgPath(context)}/teams`, fields);
    await reconcileMembers(context, object, members);
  },
  update: async (context, object, body) => {
    const { members, ...fields } = body as { members: readonly string[] } & Record<string, unknown>;
    await send(context, "PATCH", `${orgPath(context)}/teams/${segment(teamSlug(object.key))}`, fields);
    await reconcileMembers(context, object, members);
  },
};

/** The team's members made exactly the declared ones. */
async function reconcileMembers(context: LiveContext, object: ForgeObject, declared: readonly string[]): Promise<void> {
  const path = `${orgPath(context)}/teams/${segment(teamSlug(object.key))}`;
  const current = (await list<{ login?: unknown }>(context, `${path}/members`)).flatMap((member) => typeof member.login === "string" ? [member.login] : []);
  for (const login of declared) if (!current.includes(login)) await send(context, "PUT", `${path}/memberships/${segment(login)}`, { role: "member" });
  for (const login of current) if (!declared.includes(login)) await send(context, "DELETE", `${path}/memberships/${segment(login)}`);
}

const teamRepository: KindAdapter = {
  read: async (context, object) => {
    const path = `${orgPath(context)}/teams/${segment(teamSlug(object.key))}/repos/${segment(context.organization)}/${segment(repositoryOf(object))}`;
    const found = await getOrAbsent<{ role_name?: string }>(context, path, "application/vnd.github.v3.repository+json");
    return found === undefined ? undefined : { live: { permission: ROLE_PERMISSION[found.role_name ?? ""] ?? found.role_name } };
  },
  create: async (context, object, body) => teamRepository.update(context, object, body, { live: undefined }),
  update: async (context, object, body) => {
    await send(context, "PUT", `${orgPath(context)}/teams/${segment(teamSlug(object.key))}/repos/${segment(context.organization)}/${segment(repositoryOf(object))}`, body);
  },
};

const customPropertyValues: KindAdapter = {
  read: async (context, object) => {
    const values = await getOrAbsent<readonly Readonly<{ property_name: string; value: unknown }>[]>(context, `${repoPath(context, repositoryOf(object))}/properties/values`);
    return values === undefined ? undefined : { live: Object.fromEntries(values.map((entry) => [entry.property_name, entry.value])) };
  },
  create: async (context, object, body) => customPropertyValues.update(context, object, body, { live: undefined }),
  update: async (context, object, body) => {
    const properties = Object.entries(body as Record<string, unknown>).map(([property_name, value]) => ({ property_name, value }));
    await send(context, "PATCH", `${repoPath(context, repositoryOf(object))}/properties/values`, { properties });
  },
};

const immutableReleases: KindAdapter = {
  read: async (context, object) => {
    const found = await getOrAbsent<{ enabled?: boolean }>(context, `${repoPath(context, repositoryOf(object))}/immutable-releases`);
    return { live: { enabled: found?.enabled === true } };
  },
  create: async (context, object) => { await send(context, "PUT", `${repoPath(context, repositoryOf(object))}/immutable-releases`); },
  update: async (context, object) => { await send(context, "PUT", `${repoPath(context, repositoryOf(object))}/immutable-releases`); },
};

/**
 * The two Advanced Security features GitHub reads back only as `advanced_security` (its per-feature `code_security` and
 * `secret_protection` come back null): `enabled` is both, `code_security` or `secret_protection` the one, `disabled`
 * neither. A per-feature value GitHub does answer is kept as answered.
 */
const ADVANCED_SECURITY_FEATURES: Readonly<Record<string, Readonly<{ code_security: string; secret_protection: string }>>> = {
  enabled: { code_security: "enabled", secret_protection: "enabled" },
  code_security: { code_security: "enabled", secret_protection: "disabled" },
  secret_protection: { code_security: "disabled", secret_protection: "enabled" },
  disabled: { code_security: "disabled", secret_protection: "disabled" },
};
const securityConfigurationCollection: KindAdapter = {
  ...namedCollection<Record<string, unknown>>({
    collection: (context) => `${orgPath(context)}/code-security/configurations`,
    nameOf: (item) => String(item.name),
    idOf: (item) => item.id as number,
    itemPath: (context, _scope, id) => `${orgPath(context)}/code-security/configurations/${String(id)}`,
    updateMethod: "PATCH",
    normalize: (item) => {
      const derived = ADVANCED_SECURITY_FEATURES[String(item.advanced_security)];
      return {
        ...item,
        code_security: typeof item.code_security === "string" ? item.code_security : derived?.code_security,
        secret_protection: typeof item.secret_protection === "string" ? item.secret_protection : derived?.secret_protection,
      };
    },
  }),
};
const securityConfiguration: KindAdapter = {
  ...securityConfigurationCollection,
  update: async (context, object, body, found) => whenEnablementSettled(context, object.key, found.id, async () => securityConfigurationCollection.update(context, object, body, found)),
};
/**
 * WHICH REPOSITORIES a security configuration is attached to, as data
 * (`security-configuration-repositories`, keyed by the configuration's
 * name): the declared repositories exactly, attached with the `selected`
 * scope (never `all`: the organisation holds repositories the forge does not
 * govern), any other repository detached, and its default for new
 * repositories. Read back the same way, so a repository attached or detached
 * in the UI is drift.
 */
type AttachmentDesired = Readonly<{ repositories: readonly string[]; default_for_new_repos: string }>;
/** Where the organisation answers each policy a repository setting is bound by. */
export type OrgPolicySource = "organization" | "actions-permissions" | "actions-workflow" | "fork-approval" | "immutable-releases";
/** Each policy source's path under the organisation. */
const ORG_POLICY_PATHS: Readonly<Record<OrgPolicySource, string>> = {
  "organization": "",
  "actions-permissions": "/actions/permissions",
  "actions-workflow": "/actions/permissions/workflow",
  "fork-approval": "/actions/permissions/fork-pr-contributor-approval",
  "immutable-releases": "/settings/immutable-releases",
};
const ACTIONS_BREADTH: Readonly<Record<string, number>> = { local_only: 0, selected: 1, all: 2 };
const FORK_APPROVAL_STRICTNESS: Readonly<Record<string, number>> = { first_time_contributors_new_to_github: 0, first_time_contributors: 1, all_external_contributors: 2 };

/**
 * THE ORGANISATION'S POLICY OVER REPOSITORY SETTINGS: each repository field
 * an organisation setting binds, with whether a declared value is allowed
 * under the organisation's value (`allows`, judged only when the organisation
 * answers one; `"unknown"` for a value of either side the forge does not know,
 * which is refused, never read permissively) and whether GitHub then refuses
 * ANY repository write of the field, even the same value (`locks`: commit
 * sign-off, 422 "Commit signoff is enforced by the organization and cannot be
 * disabled").
 */
export type OrgPolicyRule = Readonly<{
  kind: ForgeObjectKind;
  field: string;
  source: OrgPolicySource;
  orgField: string;
  allows: (declared: unknown, org: unknown, answer: Readonly<Record<string, unknown>>, repository: string) => boolean | "unknown";
  locks?: (org: unknown) => boolean;
}>;
export const ORG_POLICY_RULES: readonly OrgPolicyRule[] = Object.freeze([
  { kind: "repository-settings", field: "web_commit_signoff_required", source: "organization", orgField: "web_commit_signoff_required", allows: (declared, org) => org !== true || declared === true, locks: (org) => org === true },
  // Actions on for a repository the organisation does not enable them for: none, or `selected` without it.
  { kind: "actions-permissions", field: "enabled", source: "actions-permissions", orgField: "enabled_repositories", allows: (declared, org, answer, repository) => {
    if (declared !== true || org === "all") return true;
    if (org === "none") return false;
    if (org !== "selected" || !Array.isArray(answer.selected_repositories)) return "unknown";
    return answer.selected_repositories.includes(repository);
  } },
  { kind: "actions-permissions", field: "allowed_actions", source: "actions-permissions", orgField: "allowed_actions", allows: (declared, org) => {
    const [mine, theirs] = [ACTIONS_BREADTH[String(declared)], ACTIONS_BREADTH[String(org)]];
    return mine === undefined || theirs === undefined ? "unknown" : mine <= theirs;
  } },
  { kind: "actions-permissions", field: "sha_pinning_required", source: "actions-permissions", orgField: "sha_pinning_required", allows: (declared, org) => org !== true || declared === true },
  { kind: "actions-workflow", field: "default_workflow_permissions", source: "actions-workflow", orgField: "default_workflow_permissions", allows: (declared, org) => org !== "read" || declared === "read" },
  { kind: "actions-workflow", field: "can_approve_pull_request_reviews", source: "actions-workflow", orgField: "can_approve_pull_request_reviews", allows: (declared, org) => org !== false || declared === false },
  { kind: "actions-fork-approval", field: "approval_policy", source: "fork-approval", orgField: "approval_policy", allows: (declared, org) => {
    const [mine, theirs] = [FORK_APPROVAL_STRICTNESS[String(declared)], FORK_APPROVAL_STRICTNESS[String(org)]];
    return mine === undefined || theirs === undefined ? "unknown" : mine >= theirs;
  } },
  { kind: "immutable-releases", field: "enabled", source: "immutable-releases", orgField: "enforced_repositories", allows: (declared, org) => org !== "all" || declared === true },
] satisfies readonly OrgPolicyRule[]);

/** The organisation's answer for every policy source a rule over `kinds` reads (a source GitHub does not answer is absent). */
export async function organisationPolicy(context: LiveContext, kinds: ReadonlySet<ForgeObjectKind>): Promise<ReadonlyMap<OrgPolicySource, Readonly<Record<string, unknown>>>> {
  const sources = [...new Set(ORG_POLICY_RULES.filter((rule) => kinds.has(rule.kind)).map((rule) => rule.source))];
  const answers = await Promise.all(sources.map(async (source) => [source, await getOrAbsent<Record<string, unknown>>(context, `${orgPath(context)}${ORG_POLICY_PATHS[source]}`)] as const));
  return new Map(await Promise.all(answers.flatMap(([source, answer]) => answer === undefined ? [] : [(async () => {
    // Actions enabled for SELECTED repositories only: the selection, by name, beside the answer.
    if (source !== "actions-permissions" || answer.enabled_repositories !== "selected") return [source, answer] as const;
    const selected = await list<{ name?: unknown }>(context, `${orgPath(context)}/actions/permissions/repositories`, (data) => (data as { repositories?: { name?: unknown }[] }).repositories ?? []);
    return [source, { ...answer, selected_repositories: selected.flatMap((repository) => typeof repository.name === "string" ? [repository.name] : []) }] as const;
  })()])));
}

/** The attachment statuses that mean GitHub is still rolling the configuration out (it refuses another change meanwhile). */
const ENABLEMENT_IN_PROGRESS: ReadonlySet<string> = new Set(["attaching", "updating"]);

/** The repositories whose attachment to configuration `id` GitHub is still rolling out. */
async function enablementInProgress(context: LiveContext, id: unknown): Promise<readonly string[]> {
  const path = `${orgPath(context)}/code-security/configurations/${String(id)}/repositories`;
  const attached = await context.client.paginate<{ status?: unknown; repository?: { name?: unknown } }>({ path, query: { status: "all" } }, { maxPages: context.maxPages, perPage: 100 });
  return attached.filter((entry) => typeof entry.status === "string" && ENABLEMENT_IN_PROGRESS.has(entry.status)).flatMap((entry) => typeof entry.repository?.name === "string" ? [entry.repository.name] : []).sort();
}

/**
 * A write to security configuration `id`, judged by STATE: refused, typed and
 * retryable (`forge_security_enablement_in_progress`), while any of its
 * attachments reads in progress, and a 409 GitHub answers is judged by the
 * states read right after it (an enablement still rolling out is the typed
 * refusal; any other conflict stays GitHub's own). Never a timed wait or a
 * blind retry: the apply defers the object and continues it only once the
 * states read settled.
 */
async function whenEnablementSettled(context: LiveContext, key: string, id: unknown, write: () => Promise<void>): Promise<void> {
  const refusal = (repositories: readonly string[]): ForgeError => new ForgeError("forge_security_enablement_in_progress", `GitHub is still rolling the security configuration ${key} out to ${repositories.join(", ")}.`, { key, repositories: repositories.join(",") });
  const before = await enablementInProgress(context, id);
  if (before.length > 0) throw refusal(before);
  try {
    await write();
  } catch (error) {
    if (isForgeError(error, "github_conflict")) {
      const now = await enablementInProgress(context, id);
      if (now.length > 0) throw refusal(now);
    }
    throw error;
  }
}

/** The attachment statuses that mean the configuration governs the repository (or is about to). */
const EFFECTIVE_ATTACHMENT: ReadonlySet<string> = new Set(["attached", "attaching", "enforced", "updating"]);
const securityConfigurationRepositories: KindAdapter = {
  read: async (context, object) => {
    const configuration = await securityConfiguration.read(context, { ...object, kind: "security-configuration" });
    if (configuration === undefined) return undefined;
    const path = `${orgPath(context)}/code-security/configurations/${String(configuration.id)}`;
    // Every status (GitHub's default lists failed, detached and removed ones too): only an EFFECTIVE attachment counts,
    // and a failed one is a loud refusal, never a success.
    const attached = await context.client.paginate<{ status?: unknown; repository?: { name?: unknown } }>({ path: `${path}/repositories`, query: { status: "all" } }, { maxPages: context.maxPages, perPage: 100 });
    const failed = attached.filter((entry) => entry.status === "failed").flatMap((entry) => typeof entry.repository?.name === "string" ? [entry.repository.name] : []);
    if (failed.length > 0) {
      throw new ForgeError("forge_security_attach_failed", `The security configuration ${object.key} failed to attach to ${failed.sort().join(", ")} (a configuration GitHub cannot enable there, such as secret scanning on a private repository without Secret Protection).`, { key: object.key, repositories: failed.sort().join(",") });
    }
    const effective = attached.filter((entry) => typeof entry.status === "string" && EFFECTIVE_ATTACHMENT.has(entry.status));
    const defaults = await getOrAbsent<readonly { default_for_new_repos?: unknown; configuration?: { id?: unknown } }[]>(context, `${orgPath(context)}/code-security/configurations/defaults`);
    const defaultFor = (defaults ?? []).find((entry) => entry.configuration?.id === configuration.id)?.default_for_new_repos;
    return {
      live: { repositories: effective.flatMap((entry) => typeof entry.repository?.name === "string" ? [entry.repository.name] : []).sort(), default_for_new_repos: typeof defaultFor === "string" ? defaultFor : "none" },
      ...(configuration.id === undefined ? {} : { id: configuration.id }),
    };
  },
  create: async (context, object, body) => { await attachExactly(context, object, body as AttachmentDesired, []); },
  update: async (context, object, body, found) => { await attachExactly(context, object, body as AttachmentDesired, (found.live as AttachmentDesired).repositories); },
};

/** Attach exactly the declared repositories (by id, the `selected` scope), detach the others the configuration holds, set its default. */
async function attachExactly(context: LiveContext, object: ForgeObject, desired: AttachmentDesired, attached: readonly string[]): Promise<void> {
  const configuration = await securityConfiguration.read(context, { ...object, kind: "security-configuration" });
  if (configuration === undefined) throw new ForgeError("forge_reference_unresolved", `The security configuration ${object.key} does not exist yet; it is created first.`, { key: object.key });
  const idOf = async (name: string): Promise<number> => {
    const repository = await getOrAbsent<{ id?: unknown }>(context, repoPath(context, name));
    if (typeof repository?.id !== "number") throw new ForgeError("forge_reference_unresolved", `The repository ${name} does not exist, so it cannot carry a security configuration.`, { repository: name });
    return repository.id;
  };
  const path = `${orgPath(context)}/code-security/configurations/${String(configuration.id)}`;
  const extra = attached.filter((name) => !desired.repositories.includes(name));
  await whenEnablementSettled(context, object.key, configuration.id, async () => {
    if (desired.repositories.length > 0) await send(context, "POST", `${path}/attach`, { scope: "selected", selected_repository_ids: await Promise.all(desired.repositories.map(idOf)) });
    if (extra.length > 0) await send(context, "DELETE", `${orgPath(context)}/code-security/configurations/detach`, { selected_repository_ids: await Promise.all(extra.map(idOf)) });
    await send(context, "PUT", `${path}/defaults`, { default_for_new_repos: desired.default_for_new_repos });
  });
}

type ProjectOption = Readonly<{ id: string; name: string; color: string; description: string }>;
type ProjectField = Readonly<{ id: string; name: string; dataType: string; options?: readonly ProjectOption[] }>;
type ProjectIdentity = Readonly<{ id: string; title: string; public: boolean; owner: Readonly<{ id: string }> }>;
type ProjectNode = ProjectIdentity & Readonly<{ fields: { nodes: readonly ProjectField[] }; items?: Readonly<{ totalCount?: unknown }> }>;
type ProjectDesired = Readonly<{ title: string; public: boolean; status: readonly string[]; fields: readonly Readonly<{ name: string; dataType: string; options?: readonly string[] }>[] }>;
type ProjectOptionInput = Readonly<{ id?: string; name: string; color: string; description: string }>;

// GitHub permits at most 100 connection entries per query; the configured maxPages bounds each traversal.
const PROJECTS_QUERY = `query ProjectDiscovery($login: String!, $after: String) { organization(login: $login) { id projectsV2(first: 100, after: $after) { nodes { id title public owner { id } } pageInfo { hasNextPage endCursor } } } }`;
const PROJECT_NODE_QUERY = `query ProjectById($login: String!, $projectId: ID!, $after: String) { organization(login: $login) { id } node(id: $projectId) { __typename ... on ProjectV2 { id title public owner { id } items(first: 1, archivedStates: [ARCHIVED, NOT_ARCHIVED], query: "") { totalCount } fields(first: 100, after: $after) { nodes { ... on ProjectV2FieldCommon { id name dataType } ... on ProjectV2SingleSelectField { options { id name color description } } } pageInfo { hasNextPage endCursor } } } } }`;

/** One bounded connection owner for discovery and fields; a partial, cyclic or malformed population never means absence. */
async function projectConnection<Node extends Readonly<{ id: string }>>(context: LiveContext, subject: string, load: (after: string | null) => Promise<unknown>, decode: (node: unknown) => Node): Promise<readonly Node[]> {
  if (!Number.isSafeInteger(context.maxPages) || context.maxPages < 1) throw new ForgeError("forge_request_invalid", "A Project connection requires a positive safe page bound.", { connection: subject });
  const nodes: Node[] = [], identities = new Set<string>(), cursors = new Set<string>();
  let after: string | null = null;
  for (let page = 0; page < context.maxPages; page++) {
    const connection = await load(after);
    if (!isPlainObject(connection) || !Array.isArray(connection.nodes) || !isPlainObject(connection.pageInfo) || typeof connection.pageInfo.hasNextPage !== "boolean") throw new ForgeError("github_response_invalid", `The ${subject} connection answered no complete page.`, { connection: subject, page: page + 1 });
    const { hasNextPage, endCursor } = connection.pageInfo;
    if (endCursor !== null && (typeof endCursor !== "string" || endCursor.length === 0)) throw new ForgeError("github_response_invalid", `The ${subject} connection answered an invalid cursor.`, { connection: subject, page: page + 1 });
    const current = connection.nodes.map(decode);
    for (const node of current) {
      if (identities.has(node.id)) throw new ForgeError("github_response_invalid", `The ${subject} connection repeated a native identity.`, { connection: subject, page: page + 1 });
      identities.add(node.id); nodes.push(node);
    }
    if (typeof endCursor === "string" && cursors.has(endCursor)) throw new ForgeError("github_response_invalid", `The ${subject} connection repeated a cursor.`, { connection: subject, page: page + 1 });
    if (!hasNextPage) return nodes;
    if (current.length === 0 || typeof endCursor !== "string" || endCursor === after) throw new ForgeError("github_response_invalid", `The ${subject} connection did not advance.`, { connection: subject, page: page + 1 });
    cursors.add(endCursor); after = endCursor;
  }
  throw new ForgeError("forge_list_oversized", `The ${subject} connection exceeds its configured page bound.`, { connection: subject, maxPages: context.maxPages });
}

function projectOrganization(data: unknown, expectedId?: string): Record<string, unknown> & Readonly<{ id: string }> {
  if (!isPlainObject(data) || !isPlainObject(data.organization) || typeof data.organization.id !== "string" || data.organization.id.length === 0 || (expectedId !== undefined && data.organization.id !== expectedId)) throw new ForgeError("github_response_invalid", "The Project organization answered no stable native identity.", {});
  return data.organization as Record<string, unknown> & Readonly<{ id: string }>;
}

function projectIdentity(value: unknown, organizationId: string): ProjectIdentity {
  if (!isPlainObject(value) || typeof value.id !== "string" || value.id.length === 0 || typeof value.title !== "string" || value.title.length === 0 || typeof value.public !== "boolean" || !isPlainObject(value.owner) || value.owner.id !== organizationId) throw new ForgeError("github_response_invalid", "A Project answered malformed identity or belongs to another owner.", { organizationId });
  return { id: value.id, title: value.title, public: value.public, owner: { id: organizationId } };
}

/** Discovery reads only identity, and completes the caller-visible population before deciding absence or uniqueness. */
async function projectOf(context: LiveContext, title: string): Promise<Readonly<{ organizationId: string; project: ProjectIdentity | undefined }>> {
  let organizationId: string | undefined;
  const projects = await projectConnection(context, "organization Projects", async (after) => {
    const data = await context.client.graphql<unknown>(PROJECTS_QUERY, { login: context.organization, after });
    const organization = projectOrganization(data, organizationId); organizationId = organization.id;
    return organization.projectsV2;
  }, (node) => projectIdentity(node, organizationId!));
  const matches = projects.filter((node) => node.title === title);
  if (matches.length > 1) throw new ForgeError("github_response_invalid", `Project title ${title} is not unique; no Project was selected.`, { matches: matches.length });
  return { organizationId: organizationId!, project: matches[0] };
}

/** Once selected or created, only this native node can satisfy prewrite and readback; titles never redirect the operation. */
async function projectById(context: LiveContext, title: string, projectId: string, expectedOrganizationId?: string): Promise<ProjectNode> {
  let organizationId = expectedOrganizationId, identity: ProjectIdentity | undefined, items: Readonly<{ totalCount?: unknown }> | undefined;
  const fields = await projectConnection(context, `Project ${projectId} fields`, async (after) => {
    const data = await context.client.graphql<unknown>(PROJECT_NODE_QUERY, { login: context.organization, projectId, after });
    const organization = projectOrganization(data, organizationId); organizationId = organization.id;
    if (!isPlainObject(data) || !isPlainObject(data.node) || data.node.__typename !== "ProjectV2") throw new ForgeError("github_response_invalid", `Project ${projectId} disappeared or changed type.`, { projectId });
    const current = projectIdentity(data.node, organizationId);
    if (current.id !== projectId || current.title !== title || (identity !== undefined && current.public !== identity.public)) throw new ForgeError("github_response_invalid", `Project ${projectId} changed identity or metadata while its fields were read.`, { projectId });
    identity = current;
    items = isPlainObject(data.node.items) ? { totalCount: data.node.items.totalCount } : undefined;
    return data.node.fields;
  }, (node) => {
    if (!isPlainObject(node) || typeof node.id !== "string" || node.id.length === 0 || typeof node.name !== "string" || node.name.length === 0 || typeof node.dataType !== "string" || node.dataType.length === 0) throw new ForgeError("github_response_invalid", `Project ${projectId} answered a field with no native identity.`, { projectId });
    return node as ProjectField;
  });
  if (identity === undefined) throw new ForgeError("github_response_invalid", `Project ${projectId} did not read back.`, { projectId });
  return { ...identity, fields: { nodes: fields }, ...(items === undefined ? {} : { items }) };
}

/** A field's name and ID must be unambiguous before it can be updated. Unmanaged fields are never rewritten. */
function projectField(current: ProjectNode, name: string): ProjectField | undefined {
  if (!Array.isArray(current.fields?.nodes) || current.fields.nodes.some((field) => field === null || typeof field !== "object")) throw new ForgeError("github_response_invalid", `Project ${current.id} answered malformed fields.`, { projectId: current.id });
  const matches = current.fields.nodes.filter((field) => field.name === name);
  if (matches.length > 1 || (matches[0] !== undefined && (typeof matches[0].id !== "string" || matches[0].id.length === 0 || current.fields.nodes.filter((field) => field.id === matches[0]!.id).length !== 1))) {
    throw new ForgeError("github_response_invalid", `Project ${current.id}: field ${name} has no unambiguous identity.`, { projectId: current.id, field: name });
  }
  return matches[0];
}

/** Validate one provider option population once, before deriving its IDs or presentation. */
function projectOptionMap(live: readonly ProjectOption[], projectId: string, field: string): ReadonlyMap<string, ProjectOption> {
  const byName = new Map<string, ProjectOption>(), ids = new Set<string>();
  for (const option of live) {
    if (option === null || typeof option !== "object" || typeof option.id !== "string" || option.id.length === 0 || typeof option.name !== "string" || option.name.length === 0 || typeof option.color !== "string" || option.color.length === 0 || typeof option.description !== "string" || ids.has(option.id) || byName.has(option.name)) {
      throw new ForgeError("github_response_invalid", `Project ${projectId}: field ${field} has malformed or ambiguous options.`, { projectId, field });
    }
    byName.set(option.name, option); ids.add(option.id);
  }
  return byName;
}

/** Preserve the existing option's identity and presentation; removal is only safe during this call's newly created, verified-empty initialization. */
function projectOptions(names: readonly string[], live: readonly ProjectOption[], initializing: boolean, projectId: string, field: string): readonly ProjectOptionInput[] {
  if (!Array.isArray(names) || names.length === 0 || names.some((name) => typeof name !== "string" || name.length === 0) || new Set(names).size !== names.length) throw new ForgeError("forge_declaration_invalid", `Project field ${field}: option names must be nonempty and unique.`, { field });
  const byName = projectOptionMap(live, projectId, field);
  const removed = live.filter((option) => !names.includes(option.name));
  if (!initializing && removed.length > 0) throw new ForgeError("forge_declaration_invalid", `Project ${projectId}: field ${field} would remove existing options; preserve them before applying.`, { projectId, field, removedOptions: removed.length });
  return withExistingOptionIds(names.map((name) => ({ name })), live).map((option) => {
    const existing = byName.get(option.name);
    return { ...option, color: existing?.color ?? "GRAY", description: existing?.description ?? "" };
  });
}

type ProjectOptionUpdate = Readonly<{ name: string; id: string; options: readonly ProjectOptionInput[] }>;

/** A successful HTTP mutation is not preservation: read back actual option IDs, names and presentation, including newly assigned identities. */
async function verifyProjectOptions(context: LiveContext, object: ForgeObject, projectId: string, expected: readonly ProjectOptionUpdate[], organizationId: string): Promise<void> {
  const after = await projectById(context, object.key, projectId, organizationId);
  for (const item of expected) {
    const field = projectField(after, item.name);
    if (field?.id !== item.id || !Array.isArray(field.options)) throw new ForgeError("github_response_invalid", `Project ${projectId}: field ${item.name} identity did not read back.`, { projectId, field: item.name });
    projectOptionMap(field.options, projectId, item.name);
    if (field.options.length !== item.options.length || item.options.some((option, index) => {
      const actual = field.options![index];
      return actual?.name !== option.name || (option.id !== undefined && actual.id !== option.id) || actual.color !== option.color || actual.description !== option.description;
    })) throw new ForgeError("github_response_invalid", `Project ${projectId}: field ${item.name} did not preserve its option identities or presentation.`, { projectId, field: item.name });
  }
}

/** One update owner for normal reconciliation and the private capability returned by this module's create flow. */
async function updateProject(context: LiveContext, object: ForgeObject, body: unknown, found: LiveObject, createdProjectId?: string, organizationId?: string): Promise<void> {
  const desired = body as ProjectDesired, projectId = found.id;
  if (typeof projectId !== "string" || projectId.length === 0 || (createdProjectId !== undefined && createdProjectId !== projectId)) {
    throw new ForgeError("github_response_invalid", `Project ${createdProjectId ?? String(projectId)} changed identity or disappeared before initialization.`, { projectId: createdProjectId ?? String(projectId) });
  }
  const current = await projectById(context, object.key, projectId, organizationId);
  const initializing = createdProjectId !== undefined;
  if (initializing && (!Number.isSafeInteger(current.items?.totalCount) || current.items?.totalCount !== 0)) {
    throw new ForgeError("forge_declaration_invalid", `New Project ${projectId} is not verified empty, including archived items; initialization was refused.`, { projectId });
  }
  const names = ["Status", ...desired.fields.map((field) => field.name)];
  if (new Set(names).size !== names.length) throw new ForgeError("forge_declaration_invalid", "Project field names must be unique and must not redeclare Status.", { projectId });
  const declarations = [{ name: "Status", dataType: "SINGLE_SELECT", options: desired.status }, ...desired.fields];
  // Every reconciliation is validated before visibility or any field is written, including an invalid later field.
  const planned = declarations.map((field) => {
    const existing = projectField(current, field.name);
    if (existing !== undefined && existing.dataType !== field.dataType) throw new ForgeError("forge_declaration_invalid", `Project ${projectId}: field ${field.name} has another data type.`, { projectId, field: field.name });
    if (field.name === "Status" && existing === undefined) throw new ForgeError("github_response_invalid", `Project ${projectId} has no Status field.`, { projectId });
    if (field.options !== undefined && existing !== undefined && !Array.isArray(existing.options)) throw new ForgeError("github_response_invalid", `Project ${projectId}: field ${field.name} has no option identities.`, { projectId, field: field.name });
    return { field, existing, options: field.options === undefined ? undefined : projectOptions(field.options, existing?.options ?? [], initializing, projectId, field.name) };
  });
  const ids = planned.flatMap(({ existing }) => existing?.id === undefined ? [] : [existing.id]);
  if (new Set(ids).size !== ids.length) throw new ForgeError("github_response_invalid", `Project ${projectId} has duplicated field identities.`, { projectId });
  if (current.public !== desired.public) await context.client.graphql(`mutation($projectId: ID!, $public: Boolean!) { updateProjectV2(input: { projectId: $projectId, public: $public }) { projectV2 { id } } }`, { projectId, public: desired.public });
  const expected: ProjectOptionUpdate[] = [];
  for (const { field, existing, options } of planned) {
    if (existing === undefined) {
      const created = await context.client.graphql<{ createProjectV2Field: { projectV2Field: { id?: unknown } } }>(`mutation($projectId: ID!, $name: String!, $dataType: ProjectV2CustomFieldType!, $options: [ProjectV2SingleSelectFieldOptionInput!]) { createProjectV2Field(input: { projectId: $projectId, name: $name, dataType: $dataType, singleSelectOptions: $options }) { projectV2Field { ... on ProjectV2FieldCommon { id } } } }`, { projectId, name: field.name, dataType: field.dataType, options: options ?? null });
      const id = created.createProjectV2Field?.projectV2Field?.id;
      if (typeof id !== "string" || id.length === 0) throw new ForgeError("github_response_invalid", `Project ${projectId}: created field ${field.name} answered no identity.`, { projectId, field: field.name });
      if (options !== undefined) expected.push({ name: field.name, id, options });
    } else if (options !== undefined) {
      if (JSON.stringify(existing.options?.map((option) => option.name)) !== JSON.stringify(field.options)) await context.client.graphql(`mutation($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]) { updateProjectV2Field(input: { fieldId: $fieldId, singleSelectOptions: $options }) { projectV2Field { ... on ProjectV2SingleSelectField { id } } } }`, { fieldId: existing.id, options });
      expected.push({ name: field.name, id: existing.id!, options });
    }
  }
  if (expected.length > 0) await verifyProjectOptions(context, object, projectId, expected, current.owner.id);
}

const project: KindAdapter = {
  read: async (context, object) => {
    const { organizationId, project: selected } = await projectOf(context, object.key);
    if (selected === undefined) return undefined;
    const found = await projectById(context, object.key, selected.id, organizationId);
    const statusField = projectField(found, "Status");
    const namesOf = (field: ProjectField): readonly string[] | undefined => {
      if (field.options === undefined) return undefined;
      if (!Array.isArray(field.options)) throw new ForgeError("github_response_invalid", `Project ${found.id} answered malformed options.`, { projectId: found.id });
      projectOptionMap(field.options, found.id, field.name ?? "");
      return field.options.map((option) => option.name);
    };
    const status = statusField === undefined ? [] : namesOf(statusField) ?? [];
    const declared = (object.desired as ProjectDesired).fields.map((field) => field.name);
    return { id: found.id, live: { title: found.title, public: found.public, status, fields: declared.flatMap((name) => {
      const field = projectField(found, name);
      if (field === undefined) return [];
      const options = namesOf(field);
      return [{ name: field.name, dataType: field.dataType, ...(options === undefined ? {} : { options }) }];
    }) } };
  },
  create: async (context, object, body) => {
    const { organizationId, project: existing } = await projectOf(context, object.key);
    if (existing !== undefined) throw new ForgeError("github_response_invalid", `Project ${object.key} already exists; creation was refused.`, { projectId: existing.id });
    const created = await context.client.graphql<{ createProjectV2: { projectV2: { id?: unknown } } }>(`mutation($ownerId: ID!, $title: String!) { createProjectV2(input: { ownerId: $ownerId, title: $title }) { projectV2 { id } } }`, { ownerId: organizationId, title: (body as ProjectDesired).title });
    const createdProjectId = created.createProjectV2?.projectV2?.id;
    if (typeof createdProjectId !== "string" || createdProjectId.length === 0) throw new ForgeError("github_response_invalid", "The created Project answered no identity; no initialization was attempted.", { creationMayHaveOccurred: true });
    try {
      await updateProject(context, object, body, { id: createdProjectId, live: undefined }, createdProjectId, organizationId);
    } catch (error) {
      // Creation has already happened. Preserve that native identity even when a later read/write fails, including the original typed budget/refusal facts.
      if (isForgeError(error)) throw new ForgeError(error.forgeCode, error.message, { ...error.facts, createdProjectId, creationMayHaveOccurred: true });
      throw new ForgeError("github_response_invalid", `New Project ${createdProjectId}: initialization failed after creation; preserve and inspect it before continuing.`, { createdProjectId, creationMayHaveOccurred: true });
    }
  },
  update: async (context, object, body, found) => updateProject(context, object, body, found),
};

/** Rulesets of one source: a repository's list also holds the organisation's rulesets that apply to it, which are not its own. */
/**
 * The allowed-actions list: GitHub answers its read with 409 while the
 * repository does not allow "selected" actions yet (measured on the live
 * plan, 2026-10-22). That is "not declared yet", read as absent: the plan
 * creates it, after `actions-permissions` (declared first) selects it.
 */
const selectedActions: KindAdapter = (() => {
  const base = singleton((context, object) => `${repoPath(context, repositoryOf(object))}/actions/permissions/selected-actions`, "PUT");
  return {
    ...base,
    read: async (context, object) => {
      try {
        return await base.read(context, object);
      } catch (error) {
        if (isForgeError(error, "github_conflict")) return undefined;
        throw error;
      }
    },
  };
})();

const rulesetOf = (base: (context: LiveContext, scope: ForgeScope) => string, sourceType: "Organization" | "Repository"): KindAdapter => namedCollection<Record<string, unknown>>({
  collection: (context, scope) => `${base(context, scope)}/rulesets`,
  items: (data) => (Array.isArray(data) ? data as Record<string, unknown>[] : []).filter((item) => item.source_type === sourceType),
  nameOf: (item) => String(item.name),
  idOf: (item) => item.id as number,
  itemPath: (context, scope, id) => `${base(context, scope)}/rulesets/${String(id)}`,
  updateMethod: "PUT",
  detailed: true,
  normalize: rulesetWithGithubDefaults,
});

const repoBase = (context: LiveContext, scope: ForgeScope): string => repoPath(context, repositoryOf({ scope }));

/** THE ADAPTERS, one per declared kind. */
export const KIND_ADAPTERS: Readonly<Record<ForgeObjectKind, KindAdapter>> = Object.freeze({
  "org-settings": singleton((context) => orgPath(context), "PATCH"),
  "custom-property": singleton((context, object) => `${orgPath(context)}/properties/schema/${segment(object.key)}`, "PUT"),
  "custom-property-values": customPropertyValues,
  team,
  "team-repository": teamRepository,
  "security-configuration": securityConfiguration,
  "security-configuration-repositories": securityConfigurationRepositories,
  "org-ruleset": rulesetOf((context) => orgPath(context), "Organization"),
  "repository-settings": singleton((context, object) => repoPath(context, repositoryOf(object)), "PATCH"),
  "actions-permissions": singleton((context, object) => `${repoPath(context, repositoryOf(object))}/actions/permissions`, "PUT"),
  "actions-selected": selectedActions,
  "actions-workflow": singleton((context, object) => `${repoPath(context, repositoryOf(object))}/actions/permissions/workflow`, "PUT"),
  "actions-fork-approval": singleton((context, object) => `${repoPath(context, repositoryOf(object))}/actions/permissions/fork-pr-contributor-approval`, "PUT"),
  "immutable-releases": immutableReleases,
  environment,
  ruleset: rulesetOf(repoBase, "Repository"),
  label: namedCollection<Record<string, unknown>>({
    collection: (context, scope) => `${repoBase(context, scope)}/labels`,
    nameOf: (item) => String(item.name),
    idOf: (item) => String(item.name),
    itemPath: (context, scope, id) => `${repoBase(context, scope)}/labels/${segment(String(id))}`,
    updateMethod: "PATCH",
    // GitHub compares label names without case; the item path names the LIVE spelling (the id) and `new_name`
    // carries the declared one, so a case-only rename is one PATCH, never a create GitHub would refuse (422).
    nameKey: (name) => name.toLowerCase(),
    updateBody: ({ name, ...fields }) => ({ ...fields, new_name: name }),
  }),
  "issue-type": namedCollection<Record<string, unknown>>({
    collection: (context) => `${orgPath(context)}/issue-types`,
    nameOf: (item) => String(item.name),
    idOf: (item) => item.id as number,
    itemPath: (context, _scope, id) => `${orgPath(context)}/issue-types/${String(id)}`,
    updateMethod: "PUT",
  }),
  "issue-field": issueField(),
  autolink: {
    ...namedCollection<Record<string, unknown>>({
      collection: (context, scope) => `${repoBase(context, scope)}/autolinks`,
      nameOf: (item) => String(item.key_prefix),
      idOf: (item) => item.id as number,
      itemPath: (context, scope, id) => `${repoBase(context, scope)}/autolinks/${String(id)}`,
      updateMethod: "PUT",
    }),
    // GitHub has no autolink update: the old one is deleted and the declared one created.
    update: async (context, object, body, found) => {
      await send(context, "DELETE", `${repoBase(context, object.scope)}/autolinks/${String(found.id)}`);
      await send(context, "POST", `${repoBase(context, object.scope)}/autolinks`, body);
    },
  },
  project,
  pages: pagesSite(),
  "app-installation": appInstallation(),
});

type PagesAnswer = Readonly<{
  build_type?: unknown; cname?: unknown; https_enforced?: unknown; source?: Readonly<{ branch?: unknown; path?: unknown }> | null;
  protected_domain_state?: unknown; https_certificate?: Readonly<{ state?: unknown }> | null;
}>;
type PagesDesired = Readonly<{ build_type: string; source?: Readonly<{ branch: string; path: string }>; cname: string | null; https_enforced: boolean }>;

/**
 * A repository's Pages site (GET/POST/PUT `/pages`). Read in the declared
 * shape, beside two facts the plan judges: the certificate's state and
 * whether GitHub holds the custom domain as verified.
 * - A custom domain is set first. If GitHub does not then hold it as
 *   verified, the previous domain is restored and the write refused
 *   (`forge_pages_domain_unverified`): a domain that is not verified could
 *   be taken by another account.
 * - HTTPS is enforced only once the certificate is approved. Until then the
 *   field is `pending` (a convergence under way, never a failure).
 */
/** The certificate states GitHub reports while it is still ISSUING one (GitHub's `https_certificate.state`); every other state is a failure. */
const CERTIFICATE_ISSUING: ReadonlySet<string> = new Set(["new", "authorization_created", "authorization_pending", "authorized", "issued", "uploaded"]);

function pagesSite(): KindAdapter {
  const path = (context: LiveContext, object: ForgeObject): string => `${repoPath(context, repositoryOf(object))}/pages`;
  const shape = (found: PagesAnswer): Record<string, unknown> => ({
    build_type: found.build_type,
    ...(found.source === null || found.source === undefined ? {} : { source: { branch: found.source.branch, path: found.source.path } }),
    cname: typeof found.cname === "string" ? found.cname : null,
    https_enforced: found.https_enforced === true,
    certificate: typeof found.https_certificate?.state === "string" ? found.https_certificate.state : null,
    protected_domain_state: typeof found.protected_domain_state === "string" ? found.protected_domain_state : null,
  });
  const write = async (context: LiveContext, object: ForgeObject, body: Partial<PagesDesired>, before: string | null): Promise<void> => {
    const { https_enforced, ...site } = body;
    await send(context, "PUT", path(context, object), site);
    const after = await getOrAbsent<PagesAnswer>(context, path(context, object));
    if (typeof site.cname === "string" && after?.protected_domain_state !== "verified") {
      // Never leave a domain GitHub does not hold as verified: the previous one is restored (and read back), and the write refused.
      const restored = await send(context, "PUT", path(context, object), { cname: before })
        .then(async () => getOrAbsent<PagesAnswer>(context, path(context, object)))
        .catch((error: unknown) => { throw new ForgeError("forge_pages_domain_restore_failed", `${repositoryOf(object)}: ${site.cname} is not verified, and restoring ${String(before)} failed: ${error instanceof Error ? error.message : String(error)}`, { repository: repositoryOf(object), domain: site.cname ?? "", previous: String(before) }); });
      const now = typeof restored?.cname === "string" ? restored.cname : null;
      if (now !== before) throw new ForgeError("forge_pages_domain_restore_failed", `${repositoryOf(object)}: ${site.cname} is not verified, and after restoring ${String(before)} GitHub holds ${String(now)}.`, { repository: repositoryOf(object), domain: site.cname, previous: String(before), held: String(now) });
      throw new ForgeError("forge_pages_domain_unverified", `${repositoryOf(object)}: GitHub does not hold ${site.cname} as verified (protected_domain_state ${String(after?.protected_domain_state ?? null)}); the previous domain was restored.`, { repository: repositoryOf(object), domain: site.cname });
    }
    // HTTPS on a custom domain waits for its certificate (a domain just set has none yet): the next plan reports it pending.
    const domain = typeof after?.cname === "string" ? after.cname : null;
    if (https_enforced !== undefined && (domain === null || after?.https_certificate?.state === "approved")) await send(context, "PUT", path(context, object), { https_enforced });
  };
  return {
    read: async (context, object) => {
      const found = await getOrAbsent<PagesAnswer>(context, path(context, object));
      if (found === undefined) return undefined;
      // A custom domain the site HOLDS that GitHub does not hold as verified is refused wherever it came from: never unchanged.
      if (typeof found.cname === "string" && found.protected_domain_state !== "verified") {
        throw new ForgeError("forge_pages_domain_unverified", `${repositoryOf(object)} holds ${found.cname}, which GitHub does not hold as verified (protected_domain_state ${String(found.protected_domain_state ?? null)}).`, { repository: repositoryOf(object), domain: found.cname });
      }
      return { live: shape(found) };
    },
    create: async (context, object, body) => {
      const desired = body as PagesDesired;
      await send(context, "POST", path(context, object), { build_type: desired.build_type, ...(desired.source === undefined ? {} : { source: desired.source }) });
      const created = await getOrAbsent<PagesAnswer>(context, path(context, object));
      // HTTPS on a custom domain waits for its certificate (the plan reports it pending until then).
      const certified = desired.cname === null || created?.https_certificate?.state === "approved";
      const { https_enforced: _https, ...withoutHttps } = desired;
      await write(context, object, certified ? desired : withoutHttps, null);
    },
    update: async (context, object, body, found) => {
      await write(context, object, body as Partial<PagesDesired>, (found.live as { cname: string | null }).cname);
    },
    // Only a certificate GitHub is still issuing leaves HTTPS pending; a failed one (or none at all) is refused, never pending forever.
    pending: (desired, live) => {
      const want = desired as PagesDesired;
      const have = live as Readonly<{ cname?: unknown; https_enforced?: unknown; certificate?: unknown }>;
      if (want.cname === null || have.cname !== want.cname || have.certificate === "approved") return {};
      if (typeof have.certificate !== "string" || !CERTIFICATE_ISSUING.has(have.certificate)) {
        throw new ForgeError("forge_pages_certificate_failed", `The certificate for ${want.cname} is ${typeof have.certificate === "string" ? have.certificate : "absent"}: GitHub is not issuing one.`, { domain: want.cname, certificate: typeof have.certificate === "string" ? have.certificate : "absent" });
      }
      return want.https_enforced === true && have.https_enforced !== true ? { https_enforced: `the certificate for ${want.cname} is ${have.certificate}` } : {};
    },
  };
}

/**
 * An App installed on a repository (`key` is the App's role): read through
 * the organisation's installations, made by adding the repository to the
 * installation (`PUT /user/installations/{id}/repositories/{repository_id}`,
 * which needs the maintainer's credential, the one an apply runs with). An
 * App not installed on the organisation at all is refused
 * (`forge_app_installation_missing`).
 */
function appInstallation(): KindAdapter {
  type Installation = Readonly<{ id: number; app_slug: string; repository_selection?: string }>;
  const installationOf = async (context: LiveContext, object: ForgeObject): Promise<Installation> => {
    const slug = FORGE_APPS[object.key as ForgeAppRole]?.name;
    const installations = await list<Installation>(context, `${orgPath(context)}/installations`, (data) => (data as { installations?: Installation[] }).installations ?? []);
    const found = installations.find((entry) => entry.app_slug === slug);
    if (found === undefined) throw new ForgeError("forge_app_installation_missing", `The ${object.key} App (${String(slug)}) is not installed on ${context.organization}, so it cannot be installed on ${repositoryOf(object)}.`, { role: object.key, repository: repositoryOf(object) });
    return found;
  };
  return {
    read: async (context, object) => {
      const installation = await installationOf(context, object);
      if (installation.repository_selection === "all") return { live: { installed: true }, id: installation.id };
      const repositories = await list<{ name?: unknown }>(context, `/user/installations/${String(installation.id)}/repositories`, (data) => (data as { repositories?: { name?: unknown }[] }).repositories ?? []);
      return { live: { installed: repositories.some((repository) => repository.name === repositoryOf(object)) }, id: installation.id };
    },
    create: async () => { throw new ForgeError("forge_declaration_invalid", "An App installation is read as a fact; it is never created.", {}); },
    update: async (context, object, _body, found) => {
      const repository = await getOrAbsent<{ id?: unknown }>(context, repoPath(context, repositoryOf(object)));
      if (typeof repository?.id !== "number") throw new ForgeError("forge_reference_unresolved", `The repository ${repositoryOf(object)} does not exist.`, { repository: repositoryOf(object) });
      await send(context, "PUT", `/user/installations/${String(found.id)}/repositories/${String(repository.id)}`);
    },
  };
}

/** Kinds whose undeclared live objects are drift (a ruleset or autolink nobody declared); the others are reported only. */
export const EXCLUSIVE_KINDS: ReadonlySet<ForgeObjectKind> = new Set(["org-ruleset", "ruleset", "autolink"]);
