/**
 * THE FORGE'S DECLARATIONS — the complete desired GitHub configuration, as a
 * pure function of its owners (github-only §3, §4, §8.1, §9.2; runbook P2.1,
 * P2.2):
 *
 * - the `forge` configuration section (`forge-config.ts`): the topology, the
 *   stage, the plan, the merge-queue parameters, the areas, labels, autolinks
 *   and the Project;
 * - the App registry (`app-registry.ts`): every App id a ruleset names is a
 *   reference to it, resolved at plan time;
 * - the community sources (`../community/sources.ts`, GH-9): the teams the
 *   role table declares, and the issue types the issue forms set (every one
 *   must be in {@link FORGE_ISSUE_TYPES}, or the declarations are refused);
 * - the workflows in the tree: the third-party actions they pin are the
 *   allowed-actions list.
 *
 * Each object is written to `.github/forge/<kind>/<scope>.<key>.json` by
 * `generated-files.ts`, and compared with GitHub by `plan.ts`.
 */
import { deepFreeze } from "../../kernel/integrity.ts";
import type { CommunityIntake, CommunityRoles } from "../community/sources.ts";
import { teamsOf } from "../community/sources.ts";
import { ForgeError } from "./codes.ts";
import { FORGE_REPOSITORY_KINDS, trunkRepository, type ForgeRepository, type ForgeSettings } from "./forge-config.ts";
import { scopeName, type ForgeObject, type ForgeObjectKind, type ForgeReference, type ForgeScope } from "./forge-state.ts";

/** GitHub's issue-type colours. */
type IssueTypeColor = "gray" | "blue" | "green" | "yellow" | "orange" | "red" | "pink" | "purple";

/**
 * THE ISSUE-TYPE REGISTRY (github-only §9.2): every type the projection
 * writes and every type an issue form sets. A form naming a type outside it
 * is refused here (GitHub would drop the type silently, issue #57).
 */
export const FORGE_ISSUE_TYPES: readonly Readonly<{ name: string; color: IssueTypeColor; description: string }>[] = deepFreeze([
  { name: "Workstream", color: "purple", description: "A body of work with sub-issues (a tracker workstream)" },
  { name: "Task", color: "yellow", description: "A unit of work" },
  { name: "Bug", color: "red", description: "Something does not work as documented" },
  { name: "Flake", color: "orange", description: "A test whose outcome changes without a code change" },
  { name: "Lesson", color: "green", description: "A workflow lesson; closed when a commit names it in a Lesson: trailer" },
  { name: "Risk", color: "pink", description: "A risk, including forge drift and key rotation" },
  { name: "Finding", color: "blue", description: "A finding from a review or an audit" },
  { name: "Security", color: "red", description: "A security issue (published only after its advisory)" },
  { name: "Intake", color: "gray", description: "Outside input waiting for /accept, /decline or /duplicate" },
]);

/** The repository kinds the org baseline ruleset governs once the door is in place (github-only §3.2). */
const GOVERNED_KINDS: readonly string[] = ["trunk", "notes", "evidence", "meta"];

/** The fields of the security configuration the Secret Protection add-on carries (github-only §8.1). */
const SECRET_PROTECTION_FIELDS: readonly string[] = [
  "secret_scanning_non_provider_patterns", "secret_scanning_validity_checks", "secret_scanning_generic_secrets",
  "secret_scanning_delegated_bypass", "secret_scanning_delegated_alert_dismissal",
];

/** GitHub's own action owners (always allowed by `github_owned_allowed`). */
const GITHUB_OWNED_ACTIONS = /^(?:actions|github)\//u;

const app = (role: string): ForgeReference => ({ $ref: "app", name: role });

function object(kind: ForgeObjectKind, scope: ForgeScope, key: string, desired: unknown, unavailableOnPlan: readonly string[] = []): ForgeObject {
  const safeKey = key.replace(/[^A-Za-z0-9._-]+/gu, "_");
  return deepFreeze({ kind, scope, key, file: `${kind}/${scopeName(scope)}.${safeKey}.json`, desired, unavailableOnPlan });
}

export type DeclarationSources = Readonly<{
  settings: ForgeSettings;
  intake: CommunityIntake;
  roles: CommunityRoles;
  /** Every `uses:` reference in the tree's workflows (`owner/repo@ref`, `owner/repo/path@ref`, `./local`). */
  workflowActions: readonly string[];
}>;

/** The third-party action patterns the workflows pin (`owner/repo@*`), sorted. */
export function allowedActionPatterns(uses: readonly string[]): readonly string[] {
  const patterns = new Set<string>();
  for (const reference of uses) {
    if (reference.startsWith("./") || reference.startsWith("docker://")) continue;
    const [path] = reference.split("@");
    const [owner, repository] = (path ?? "").split("/");
    if (owner === undefined || repository === undefined || GITHUB_OWNED_ACTIONS.test(`${owner}/`)) continue;
    patterns.add(`${owner}/${repository}@*`);
  }
  return [...patterns].sort();
}

function governedRepositories(settings: ForgeSettings): readonly ForgeRepository[] {
  return settings.repositories.filter((repository) => GOVERNED_KINDS.includes(repository.kind));
}

function rulesetConditions(include: readonly string[]): unknown {
  return { ref_name: { include, exclude: [] } };
}

function pullRequestRule(settings: ForgeSettings): unknown {
  const door = settings.stage === "door";
  return {
    type: "pull_request",
    parameters: {
      required_approving_review_count: door ? 1 : 0,
      dismiss_stale_reviews_on_push: true,
      require_code_owner_review: false,
      require_last_push_approval: door,
      required_review_thread_resolution: true,
      allowed_merge_methods: ["merge"],
    },
  };
}

function requiredChecksRule(settings: ForgeSettings): unknown {
  const checks = settings.stage === "door"
    ? [{ context: "bridlewise/door", integration_id: app("door") }]
    : settings.p0RequiredChecks.map((check) => ({ context: check.context, integration_id: check.integrationId }));
  return { type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, do_not_enforce_on_create: false, required_status_checks: checks } };
}

/** The rulesets (github-only §3.2): the org baseline, R1 trunk, R2 product, R3 ledger, R4 release tags, R5 agent branches. */
function rulesets(settings: ForgeSettings): readonly ForgeObject[] {
  const trunk = trunkRepository(settings).name;
  const door = settings.stage === "door";
  const queue = settings.mergeQueue;
  const publisherBypass = [{ actor_id: app("publisher"), actor_type: "Integration", bypass_mode: "always" }];
  const protectedBranch = (name: string): unknown => ({
    name, target: "branch", enforcement: "active", bypass_actors: publisherBypass,
    conditions: rulesetConditions([`refs/heads/${name}`]),
    rules: [{ type: "creation" }, { type: "update", parameters: { update_allows_fetch_and_merge: false } }, { type: "deletion" }, { type: "non_fast_forward" }, { type: "required_signatures" }],
  });
  // A repository's own branch protection (the notes repository's working branch, live `protect-coordination`).
  const branchProtections = settings.repositories.filter((repository) => repository.protectedBranch !== undefined).map((repository) =>
    object("ruleset", { kind: "repo", repository: repository.name }, `protect-${repository.protectedBranch!}`, {
      name: `protect-${repository.protectedBranch!}`, target: "branch", enforcement: "active", bypass_actors: [],
      conditions: rulesetConditions([`refs/heads/${repository.protectedBranch!}`]),
      rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
    }));
  return [
    object("org-ruleset", { kind: "org" }, "baseline", {
      name: "baseline", target: "branch", enforcement: "active", bypass_actors: [],
      // Before the flip only the trunk is governed: the other repositories have no door yet, and a required check they never run would freeze them.
      conditions: { repository_property: { include: [{ name: "kind", property_values: door ? [...GOVERNED_KINDS] : ["trunk"] }], exclude: [] }, ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
      rules: [{ type: "deletion" }, { type: "non_fast_forward" }, ...(door ? [{ type: "required_signatures" }] : []), pullRequestRule(settings), requiredChecksRule(settings)],
    }),
    object("ruleset", { kind: "repo", repository: trunk }, "trunk", {
      name: "trunk", target: "branch", enforcement: "active", bypass_actors: [],
      conditions: rulesetConditions(["~DEFAULT_BRANCH"]),
      rules: [
        { type: "merge_queue", parameters: {
          merge_method: "MERGE", grouping_strategy: "ALLGREEN", max_entries_to_build: queue.maxEntriesToBuild,
          min_entries_to_merge: queue.minEntriesToMerge, max_entries_to_merge: queue.maxEntriesToMerge,
          min_entries_to_merge_wait_minutes: queue.minEntriesToMergeWaitMinutes, check_response_timeout_minutes: queue.checkResponseTimeoutMinutes,
        } },
        { type: "code_scanning", parameters: { code_scanning_tools: [{ tool: "CodeQL", alerts_threshold: "errors", security_alerts_threshold: "high_or_higher" }] } },
      ],
    }),
    object("ruleset", { kind: "repo", repository: trunk }, "product", protectedBranch("product")),
    object("ruleset", { kind: "repo", repository: trunk }, "ledger", protectedBranch("ledger")),
    object("ruleset", { kind: "repo", repository: trunk }, "release-tags", {
      name: "release-tags", target: "tag", enforcement: "active", bypass_actors: publisherBypass,
      conditions: rulesetConditions(["refs/tags/v*"]),
      rules: [{ type: "creation" }, { type: "update", parameters: { update_allows_fetch_and_merge: false } }, { type: "deletion" }, { type: "non_fast_forward" }],
    }),
    object("ruleset", { kind: "repo", repository: trunk }, "agent-branches", {
      name: "agent-branches", target: "branch", enforcement: "active",
      bypass_actors: [{ actor_id: app("agent"), actor_type: "Integration", bypass_mode: "always" }],
      conditions: rulesetConditions(["refs/heads/agent/**"]),
      rules: [{ type: "creation" }, { type: "deletion" }],
    }),
    ...branchProtections,
    ...contentPolicyRulesets(settings),
  ];
}

/**
 * The push ruleset of every PRIVATE governed repository (github-only §3.2;
 * GitHub's push rulesets apply to private repositories only, where Team has
 * no secret scanning): the content policy's size, extension and path limits.
 */
function contentPolicyRulesets(settings: ForgeSettings): readonly ForgeObject[] {
  const policy = settings.contentPolicy;
  return governedRepositories(settings).filter((repository) => repository.visibility === "private").map((repository) =>
    object("ruleset", { kind: "repo", repository: repository.name }, "content-policy", {
      name: "content-policy", target: "push", enforcement: "active", bypass_actors: [],
      rules: [
        { type: "max_file_size", parameters: { max_file_size: policy.maxFileMegabytes } },
        { type: "file_extension_restriction", parameters: { restricted_file_extensions: policy.forbiddenExtensions.map((extension) => `*${extension}`) } },
        { type: "file_path_restriction", parameters: { restricted_file_paths: [...policy.forbiddenPaths] } },
      ],
    }));
}

/** Repository, Actions and release settings (github-only §3.3) for every governed repository. */
function repositorySettings(settings: ForgeSettings, actionPatterns: readonly string[]): readonly ForgeObject[] {
  const trunk = trunkRepository(settings).name;
  return governedRepositories(settings).flatMap((repository) => {
    const scope: ForgeScope = { kind: "repo", repository: repository.name };
    const objects: ForgeObject[] = [
      object("repository-settings", scope, repository.name, {
        allow_merge_commit: true, allow_rebase_merge: false, allow_squash_merge: false,
        merge_commit_title: "PR_TITLE", merge_commit_message: "PR_BODY",
        allow_auto_merge: false, delete_branch_on_merge: true, allow_update_branch: true,
        // DCO for web commits (U-7): the repository flag, beside the organisation's.
        web_commit_signoff_required: true, has_wiki: false,
        has_discussions: repository.name === trunk, has_projects: repository.name === trunk,
      }),
      object("actions-permissions", scope, repository.name, { enabled: true, allowed_actions: "selected", sha_pinning_required: true }),
      object("actions-selected", scope, repository.name, { github_owned_allowed: true, verified_allowed: false, patterns_allowed: actionPatterns }),
      object("actions-workflow", scope, repository.name, { default_workflow_permissions: "read", can_approve_pull_request_reviews: false }),
      object("custom-property-values", scope, "kind", { kind: repository.kind }),
    ];
    if (repository.visibility === "public") {
      objects.push(object("actions-fork-approval", scope, repository.name, { approval_policy: "first_time_contributors" }));
      objects.push(object("immutable-releases", scope, repository.name, { enabled: true }));
    }
    return objects;
  });
}

/** The environments of the trunk (github-only §3.3; runbook P1.4). */
function environments(settings: ForgeSettings): readonly ForgeObject[] {
  const scope: ForgeScope = { kind: "repo", repository: trunkRepository(settings).name };
  const base = { deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }, can_admins_bypass: false, branch_policies: ["main"] };
  return [
    object("environment", scope, "door", base),
    object("environment", scope, "publish", base),
    object("environment", scope, "release", base),
    object("environment", scope, "rotation", { ...base, reviewers: [{ type: "User", id: { $ref: "user", name: settings.maintainer } }] }),
  ];
}

/** The organisation: its settings, the `kind` property, the security configuration, the teams. */
function organisation(settings: ForgeSettings, roles: CommunityRoles): readonly ForgeObject[] {
  const org: ForgeScope = { kind: "org" };
  const trunk = trunkRepository(settings).name;
  const security = {
    name: "bridlewise-baseline",
    description: "GENERATED by harness sync from engine/src/workflow/forge/declarations.ts",
    dependency_graph: "enabled", dependabot_alerts: "enabled", dependabot_security_updates: "enabled",
    secret_scanning: "enabled", secret_scanning_push_protection: "enabled",
    secret_scanning_non_provider_patterns: "enabled", secret_scanning_validity_checks: "enabled", secret_scanning_generic_secrets: "enabled",
    secret_scanning_delegated_bypass: "enabled", secret_scanning_delegated_alert_dismissal: "enabled",
    private_vulnerability_reporting: "enabled", code_scanning_default_setup: "disabled", enforcement: "enforced",
  };
  const teams = teamsOf(roles);
  const repositoryPermission = (level: string): string => ({ read: "pull", triage: "triage", write: "push", maintain: "maintain", admin: "admin" })[level] ?? level;
  return [
    object("org-settings", org, settings.organization, {
      members_can_create_public_repositories: false, members_can_create_private_repositories: false,
      members_can_fork_private_repositories: false, web_commit_signoff_required: true,
    }),
    object("custom-property", org, "kind", {
      property_name: "kind", value_type: "single_select", required: true, default_value: "none",
      allowed_values: [...FORGE_REPOSITORY_KINDS], values_editable_by: "org_actors", description: "Bridlewise topology role",
    }),
    object("security-configuration", org, security.name, security, settings.plan.secretProtection ? [] : SECRET_PROTECTION_FIELDS),
    ...teams.map((team) => object("team", org, team.team, { name: team.team, privacy: "closed", description: `The ${team.role} role (docs/community/roles.json)` })),
    ...teams.map((team) => object("team-repository", { kind: "repo", repository: trunk }, team.team, { permission: repositoryPermission(team.permission) })),
  ];
}

/** The vocabulary: labels, issue types and fields, autolinks, the Project (github-only §9.2). */
function vocabulary(settings: ForgeSettings, intake: CommunityIntake): readonly ForgeObject[] {
  const org: ForgeScope = { kind: "org" };
  const trunk: ForgeScope = { kind: "repo", repository: trunkRepository(settings).name };
  const typeNames = new Set(FORGE_ISSUE_TYPES.map((type) => type.name));
  const unknown = intake.issueForms.map((form) => form.type).filter((type) => !typeNames.has(type));
  if (unknown.length > 0) {
    throw new ForgeError("forge_declaration_invalid", `Issue forms set types the issue-type registry does not hold (GitHub would drop them): ${unknown.join(", ")}.`, { types: unknown });
  }
  const labels = [
    ...settings.areas.map((area) => ({ name: `area:${area.id}`, color: area.color, description: area.description })),
    ...settings.labels,
  ];
  const names = labels.map((label) => label.name.toLowerCase());
  if (new Set(names).size !== names.length) throw new ForgeError("forge_declaration_invalid", "Two labels share a name.", {});
  return [
    ...labels.map((label) => object("label", trunk, label.name, { name: label.name, color: label.color, description: label.description })),
    ...FORGE_ISSUE_TYPES.map((type) => object("issue-type", org, type.name, { name: type.name, color: type.color, description: type.description, is_enabled: true })),
    object("issue-field", org, "Severity", { name: "Severity", data_type: "single_select", visibility: "all", description: "How bad it is (P0 worst)", options: ["P0", "P1", "P2", "P3"].map((name) => ({ name })) }),
    object("issue-field", org, "Area", { name: "Area", data_type: "single_select", visibility: "all", description: "Where it lives (the areas table)", options: settings.areas.map((area) => ({ name: area.id })) }),
    object("issue-field", org, "Evidence", { name: "Evidence", data_type: "text", visibility: "all", description: "The evidence record (evidence:<path>)" }),
    object("issue-field", org, "CPU headroom", { name: "CPU headroom", data_type: "number", visibility: "all", description: "CPU budget headroom, percent" }),
    ...settings.autolinks.map((link) => object("autolink", trunk, link.keyPrefix, { key_prefix: link.keyPrefix, url_template: link.urlTemplate, is_alphanumeric: link.isAlphanumeric })),
    object("project", org, settings.project.title, {
      title: settings.project.title, public: true, status: settings.project.statusOptions,
      fields: [
        { name: "Lane", dataType: "TEXT" },
        { name: "Severity", dataType: "SINGLE_SELECT", options: ["P0", "P1", "P2", "P3"] },
        { name: "Area", dataType: "SINGLE_SELECT", options: settings.areas.map((area) => area.id) },
        { name: "CPU headroom", dataType: "NUMBER" },
      ],
    }),
  ];
}

/** THE DECLARATIONS: every object the forge owns, in apply order (what a later object references exists first). */
export function forgeDeclarations(sources: DeclarationSources): readonly ForgeObject[] {
  const { settings } = sources;
  const objects = [
    ...organisation(settings, sources.roles),
    ...repositorySettings(settings, allowedActionPatterns(sources.workflowActions)),
    ...environments(settings),
    ...rulesets(settings),
    ...vocabulary(settings, sources.intake),
  ];
  const files = objects.map((entry) => entry.file);
  if (new Set(files).size !== files.length) throw new ForgeError("forge_declaration_invalid", "Two declared objects share a file.", {});
  return deepFreeze(objects);
}
