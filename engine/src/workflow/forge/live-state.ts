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
import { ForgeError, isForgeError } from "./codes.ts";
import type { ForgeObject, ForgeObjectKind, ForgeScope } from "./forge-state.ts";
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
        ? { ...declared, options: (declared.options as FieldOption[]).map((option) => {
          const existing = liveOptions.find((candidate) => candidate.name === option.name);
          return existing?.id === undefined ? option : { id: existing.id, ...option };
        }) }
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

type ProjectNode = Readonly<{ id: string; title: string; public: boolean; fields: { nodes: readonly Readonly<{ id?: string; name?: string; dataType?: string; options?: readonly Readonly<{ name: string }>[] }>[] } }>;
type ProjectDesired = Readonly<{ title: string; public: boolean; status: readonly string[]; fields: readonly Readonly<{ name: string; dataType: string; options?: readonly string[] }>[] }>;

const PROJECT_QUERY = `query($login: String!, $title: String!) { organization(login: $login) { id projectsV2(first: 20, query: $title) { nodes { id title public fields(first: 50) { nodes { ... on ProjectV2FieldCommon { id name dataType } ... on ProjectV2SingleSelectField { options { name } } } } } } } }`;

async function projectOf(context: LiveContext, title: string): Promise<Readonly<{ organizationId: string; project: ProjectNode | undefined }>> {
  const data = await context.client.graphql<{ organization: { id: string; projectsV2: { nodes: readonly ProjectNode[] } } }>(PROJECT_QUERY, { login: context.organization, title });
  return { organizationId: data.organization.id, project: data.organization.projectsV2.nodes.find((node) => node.title === title) };
}

const options = (names: readonly string[]): unknown => names.map((name) => ({ name, color: "GRAY", description: "" }));

const project: KindAdapter = {
  read: async (context, object) => {
    const { project: found } = await projectOf(context, object.key);
    if (found === undefined) return undefined;
    const fields = found.fields.nodes.filter((field) => field.name !== undefined);
    const status = fields.find((field) => field.name === "Status")?.options?.map((option) => option.name) ?? [];
    // Only the DECLARED fields, by name and in the declared order: GitHub's own fields (Title, Assignees, Labels, …) are
    // its, never drift; a declared field it lacks is absent here, and the update creates it.
    const declared = (object.desired as ProjectDesired).fields.map((field) => field.name);
    return {
      id: found.id,
      live: {
        title: found.title, public: found.public, status,
        fields: declared.flatMap((name) => {
          const field = fields.find((candidate) => candidate.name === name);
          return field === undefined ? [] : [{ name: field.name, dataType: field.dataType, ...(field.options === undefined ? {} : { options: field.options.map((option) => option.name) }) }];
        }),
      },
    };
  },
  create: async (context, object, body) => {
    const { organizationId } = await projectOf(context, object.key);
    await context.client.graphql(`mutation($ownerId: ID!, $title: String!) { createProjectV2(input: { ownerId: $ownerId, title: $title }) { projectV2 { id } } }`, { ownerId: organizationId, title: (body as ProjectDesired).title });
    const created = await project.read(context, object);
    if (created !== undefined) await project.update(context, object, body, created);
  },
  update: async (context, object, body, found) => {
    const desired = body as ProjectDesired;
    const live = found.live as ProjectDesired;
    const projectId = String(found.id);
    if (live.public !== desired.public) await context.client.graphql(`mutation($projectId: ID!, $public: Boolean!) { updateProjectV2(input: { projectId: $projectId, public: $public }) { projectV2 { id } } }`, { projectId, public: desired.public });
    const { project: current } = await projectOf(context, object.key);
    const fieldId = (name: string): string | undefined => current?.fields.nodes.find((field) => field.name === name)?.id;
    if (JSON.stringify(live.status) !== JSON.stringify(desired.status) && fieldId("Status") !== undefined) {
      await context.client.graphql(`mutation($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]) { updateProjectV2Field(input: { fieldId: $fieldId, singleSelectOptions: $options }) { projectV2Field { ... on ProjectV2SingleSelectField { id } } } }`, { fieldId: fieldId("Status"), options: options(desired.status) });
    }
    for (const field of desired.fields) {
      const existing = live.fields.find((entry) => entry.name === field.name);
      if (existing === undefined) {
        await context.client.graphql(`mutation($projectId: ID!, $name: String!, $dataType: ProjectV2CustomFieldType!, $options: [ProjectV2SingleSelectFieldOptionInput!]) { createProjectV2Field(input: { projectId: $projectId, name: $name, dataType: $dataType, singleSelectOptions: $options }) { projectV2Field { ... on ProjectV2FieldCommon { id } } } }`,
          { projectId, name: field.name, dataType: field.dataType, options: field.options === undefined ? null : options(field.options) });
      } else if (field.options !== undefined && JSON.stringify(existing.options) !== JSON.stringify(field.options) && fieldId(field.name) !== undefined) {
        await context.client.graphql(`mutation($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]) { updateProjectV2Field(input: { fieldId: $fieldId, singleSelectOptions: $options }) { projectV2Field { ... on ProjectV2SingleSelectField { id } } } }`, { fieldId: fieldId(field.name), options: options(field.options) });
      }
    }
  },
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
});

/** Kinds whose undeclared live objects are drift (a ruleset or autolink nobody declared); the others are reported only. */
export const EXCLUSIVE_KINDS: ReadonlySet<ForgeObjectKind> = new Set(["org-ruleset", "ruleset", "autolink"]);
