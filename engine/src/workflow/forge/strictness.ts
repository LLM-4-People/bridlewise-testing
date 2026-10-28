/**
 * THE STRICTNESS ORDER of the forge's protections: whether a desired body
 * is AT LEAST AS STRICT as the live one, field by field. Tighten-first apply
 * (`plan.ts`) and its moved-rule premises both judge through it.
 *
 * TOTAL BY CONSTRUCTION. Every kind is classified in {@link KIND_FIELDS}.
 * The Record is exhaustive over `ForgeObjectKind`, so a new kind does not
 * compile until it is classified. For a protection kind, every field either
 * side carries is judged:
 * - a field the table orders is judged by its order;
 * - a field the table calls neutral never weakens anything;
 * - ANY OTHER field that differs is a loosening, because it is not proven
 *   stricter or equal.
 * The rules of a ruleset are judged the same way, parameter by parameter
 * ({@link RULE_PARAMETERS}). A list of known weakenings would miss the
 * weakening nobody listed; this order cannot.
 */
import { canonicalJson } from "../../kernel/integrity.ts";
import type { ForgeObjectKind } from "./forge-state.ts";

/** Whether `next` is at least as strict as `now` for one field. */
type Order = (next: unknown, now: unknown) => boolean;

const same = (left: unknown, right: unknown): boolean => canonicalJson(left ?? null) === canonicalJson(right ?? null);
const entries = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);
const contains = (list: readonly unknown[], item: unknown): boolean => list.some((candidate) => same(candidate, item));

/** Equal, or a loosening: the order for every field nobody has proven an order for. */
const EQUAL: Order = (next, now) => same(next, now);
/** Never a loosening (a field that guards nothing). */
const NEUTRAL: Order = () => true;
/** `true` is the strict value: turning it off loosens. */
const TRUE_IS_STRICT: Order = (next, now) => now !== true || next === true;
/** `false` is the strict value: turning it on loosens (`can_admins_bypass`, `do_not_enforce_on_create`). */
const FALSE_IS_STRICT: Order = (next, now) => now !== false || next === false;
/** A larger number is stricter (approvals, a wait timer). */
const HIGHER_IS_STRICT: Order = (next, now) => now === undefined || (typeof next === "number" && typeof now === "number" && next >= now);
/** A smaller number is stricter (a size or length limit). */
const LOWER_IS_STRICT: Order = (next, now) => now === undefined || (typeof next === "number" && typeof now === "number" && next <= now);
/** Every entry `now` requires is still required (checks, restricted paths, reviewers). */
const SUPERSET_IS_STRICT: Order = (next, now) => entries(now).every((item) => contains(entries(next), item));
/** Nothing `now` forbids becomes allowed (bypass actors, merge methods, allowed actions, deployment branches). */
const SUBSET_IS_STRICT: Order = (next, now) => entries(next).every((item) => contains(entries(now), item));
/** Levels from loosest to strictest; an unknown value is never proven stricter. */
const levels = (...ordered: readonly string[]): Order => (next, now) => {
  if (same(next, now)) return true;
  const at = ordered.indexOf(String(next));
  const was = ordered.indexOf(String(now));
  return at !== -1 && was !== -1 && at >= was;
};
/**
 * A required check is still required when one of the same context is: a
 * check bound to an App is at least as strict as the same context unbound
 * (fewer reporters satisfy it), but another App, or dropping the binding, is
 * not.
 */
const checkCovered = (next: readonly unknown[], check: unknown): boolean => {
  const want = check as Readonly<{ context?: unknown; integration_id?: unknown }>;
  return next.some((candidate) => {
    const have = candidate as Readonly<{ context?: unknown; integration_id?: unknown }>;
    return have.context === want.context && (want.integration_id === undefined || same(have.integration_id, want.integration_id));
  });
};
/** Every check `now` requires is still required, by {@link checkCovered}. */
const CHECKS_KEPT: Order = (next, now) => entries(now).every((check) => checkCovered(entries(next), check));
/** A dismissal restriction: an unrestricted one (`enabled: false`) restricts nothing; an enabled one must stay enabled, its allowed actors only shrinking. */
const DISMISSAL_RESTRICTION: Order = (next, now) => {
  const was = now as Readonly<{ enabled?: unknown; allowed_actors?: unknown }> | undefined;
  if (was?.enabled !== true) return true;
  const will = next as Readonly<{ enabled?: unknown; allowed_actors?: unknown }> | undefined;
  return will?.enabled === true && SUBSET_IS_STRICT(will.allowed_actors, was.allowed_actors);
};

/** A value set where none was: joining is never a loosening; changing a set value is unproven (it may leave what governed it). */
const SET_ONCE: Order = (next, now) => now === undefined || now === null || same(next, now);
/** Security-configuration features: `enabled` is strict; every other value is the same "off". */
const FEATURE: Order = (next, now) => now !== "enabled" || next === "enabled";

/** The rule parameters with a proven order; any other parameter must be equal. */
const RULE_PARAMETERS: Readonly<Record<string, Order>> = Object.freeze({
  required_approving_review_count: HIGHER_IS_STRICT,
  dismiss_stale_reviews_on_push: TRUE_IS_STRICT,
  require_code_owner_review: TRUE_IS_STRICT,
  require_last_push_approval: TRUE_IS_STRICT,
  required_review_thread_resolution: TRUE_IS_STRICT,
  allowed_merge_methods: SUBSET_IS_STRICT,
  required_reviewers: SUPERSET_IS_STRICT,
  automatic_copilot_code_review_enabled: NEUTRAL,
  strict_required_status_checks_policy: TRUE_IS_STRICT,
  do_not_enforce_on_create: FALSE_IS_STRICT,
  required_status_checks: CHECKS_KEPT,
  require_extra_approval_for_unattributed_changes: TRUE_IS_STRICT,
  dismissal_restriction: DISMISSAL_RESTRICTION,
  update_allows_fetch_and_merge: FALSE_IS_STRICT,
  required_deployment_environments: SUPERSET_IS_STRICT,
  workflows: SUPERSET_IS_STRICT,
  code_scanning_tools: SUPERSET_IS_STRICT,
  max_file_size: LOWER_IS_STRICT,
  max_file_path_length: LOWER_IS_STRICT,
  restricted_file_extensions: SUPERSET_IS_STRICT,
  restricted_file_paths: SUPERSET_IS_STRICT,
  grouping_strategy: levels("HEADGREEN", "ALLGREEN"),
});

type Rule = Readonly<{ type?: unknown; parameters?: Readonly<Record<string, unknown>> }>;
type Conditions = Readonly<Record<string, Readonly<Record<string, unknown>> | undefined>>;

const rulesOf = (body: Readonly<Record<string, unknown>>): readonly Rule[] => (Array.isArray(body.rules) ? body.rules as Rule[] : []);

/** What `next` weakens in one rule `now` carries (the same type). */
function ruleLoosening(next: Rule, now: Rule): readonly string[] {
  const want = next.parameters ?? {};
  const have = now.parameters ?? {};
  const type = String(now.type);
  const reasons: string[] = [];
  for (const parameter of [...new Set([...Object.keys(have), ...Object.keys(want)])].sort()) {
    const order = RULE_PARAMETERS[parameter] ?? EQUAL;
    if (!order(want[parameter], have[parameter])) reasons.push(`weakens rule ${type}: ${parameter} ${canonicalJson(have[parameter] ?? null)} -> ${canonicalJson(want[parameter] ?? null)}`);
  }
  if (type === "required_status_checks") {
    // Name the checks a reviewer must look at (a dropped context, or one whose app binding changed), not only the list.
    for (const check of entries(have.required_status_checks) as readonly Readonly<{ context?: unknown }>[]) {
      if (!checkCovered(entries(want.required_status_checks), check)) reasons.push(`drops required check ${canonicalJson(check)}`);
    }
  }
  return reasons;
}

/**
 * What a ruleset's conditions narrow. A protection that covers fewer refs or
 * repositories is a loosening:
 * - every live include must still be included (or `~ALL` must be);
 * - no new exclude may appear;
 * - a repository property's values may only grow;
 * - a condition GitHub added that this order does not know must stay equal.
 */
function conditionsLoosening(next: Conditions | undefined, now: Conditions | undefined): readonly string[] {
  const want = next ?? {};
  const have = now ?? {};
  const reasons: string[] = [];
  for (const name of [...new Set([...Object.keys(have), ...Object.keys(want)])].sort()) {
    const wanted = want[name] ?? undefined;
    const had = have[name] ?? undefined;
    if (same(wanted, had)) continue;
    if ((name === "ref_name" || name === "repository_name") && wanted !== undefined && had !== undefined) {
      const include = entries(wanted.include);
      const covered = contains(include, "~ALL") || entries(had.include).every((ref) => contains(include, ref));
      const fieldsKnown = Object.keys({ ...wanted, ...had }).every((field) => field === "include" || field === "exclude" || (field === "protected" && same(wanted[field], had[field])));
      if (covered && SUBSET_IS_STRICT(wanted.exclude, had.exclude) && fieldsKnown) continue;
    }
    if (name === "repository_property" && wanted !== undefined && had !== undefined) {
      type Property = Readonly<{ name?: unknown; property_values?: unknown }>;
      const included = (list: unknown, property: Property): boolean => (entries(list) as Property[]).some((candidate) =>
        candidate.name === property.name && SUPERSET_IS_STRICT(candidate.property_values, property.property_values) && same({ ...candidate, property_values: null }, { ...property, property_values: null }));
      const fieldsKnown = Object.keys({ ...wanted, ...had }).every((field) => field === "include" || field === "exclude");
      if (fieldsKnown && (entries(had.include) as Property[]).every((property) => included(wanted.include, property)) && SUBSET_IS_STRICT(wanted.exclude, had.exclude)) continue;
    }
    reasons.push(`narrows condition ${name}: ${canonicalJson(had ?? null)} -> ${canonicalJson(wanted ?? null)}`);
  }
  return reasons;
}

/** A ruleset's own fields (beyond its conditions and rules); GitHub's bookkeeping fields are neutral. */
const RULESET_FIELDS: Readonly<Record<string, Order>> = Object.freeze({
  name: EQUAL,
  target: EQUAL,
  enforcement: levels("disabled", "evaluate", "active"),
  bypass_actors: SUBSET_IS_STRICT,
  id: NEUTRAL, node_id: NEUTRAL, source: NEUTRAL, source_type: NEUTRAL, _links: NEUTRAL,
  created_at: NEUTRAL, updated_at: NEUTRAL, current_user_can_bypass: NEUTRAL,
});

function rulesetLoosening(next: Readonly<Record<string, unknown>>, now: Readonly<Record<string, unknown>>): readonly string[] {
  const reasons: string[] = [];
  for (const field of [...new Set([...Object.keys(now), ...Object.keys(next)])].sort()) {
    if (field === "rules" || field === "conditions") continue;
    if (field === "bypass_actors") {
      for (const actor of entries(next.bypass_actors)) if (!contains(entries(now.bypass_actors), actor)) reasons.push(`adds bypass ${canonicalJson(actor)}`);
      continue;
    }
    if (field === "enforcement" && now.enforcement === "active" && next.enforcement !== "active") { reasons.push("enforcement off"); continue; }
    const order = RULESET_FIELDS[field] ?? EQUAL;
    if (!order(next[field], now[field])) reasons.push(`changes ${field}: ${canonicalJson(now[field] ?? null)} -> ${canonicalJson(next[field] ?? null)}`);
  }
  reasons.push(...conditionsLoosening(next.conditions as Conditions | undefined, now.conditions as Conditions | undefined));
  const wanted = rulesOf(next);
  for (const rule of rulesOf(now)) {
    const kept = wanted.find((candidate) => candidate.type === rule.type);
    if (kept === undefined) reasons.push(`removes rule ${String(rule.type)}`);
    else reasons.push(...ruleLoosening(kept, rule));
  }
  return reasons;
}

/**
 * How each kind is judged: `"neutral"` (it guards nothing: labels, issue
 * types and fields, the project, autolinks, a team), `"ruleset"`, or a field
 * table whose missing fields must be equal.
 */
const KIND_FIELDS: Readonly<Record<ForgeObjectKind, "neutral" | "ruleset" | Readonly<Record<string, Order>>>> = Object.freeze({
  "label": "neutral",
  "issue-type": "neutral",
  "issue-field": "neutral",
  "project": "neutral",
  "autolink": "neutral",
  // A member added is access granted: membership may only shrink without an acknowledgement.
  "team": { name: NEUTRAL, privacy: NEUTRAL, description: NEUTRAL, members: SUBSET_IS_STRICT },
  "ruleset": "ruleset",
  "org-ruleset": "ruleset",
  // A repository's `kind` decides which org rulesets govern it: setting one where none was only joins; changing one is unproven.
  // The property's allowed values are a SET: a reorder changes nothing, dropping a value narrows what a repository may be, and a
  // new value widens it (a loosening). Any other change to the schema must be equal.
  "custom-property": { allowed_values: SUBSET_IS_STRICT },
  "custom-property-values": { kind: SET_ONCE },
  "team-repository": { permission: levels("admin", "maintain", "push", "triage", "pull") },
  "org-settings": {
    members_can_create_public_repositories: FALSE_IS_STRICT, members_can_create_private_repositories: FALSE_IS_STRICT,
    members_can_create_repositories: FALSE_IS_STRICT, members_can_fork_private_repositories: FALSE_IS_STRICT,
    web_commit_signoff_required: TRUE_IS_STRICT, two_factor_requirement_enabled: TRUE_IS_STRICT,
    default_repository_permission: levels("admin", "write", "read", "none"),
  },
  "security-configuration": {
    name: NEUTRAL, description: NEUTRAL, id: NEUTRAL, target_type: NEUTRAL, url: NEUTRAL, html_url: NEUTRAL, created_at: NEUTRAL, updated_at: NEUTRAL,
    enforcement: levels("unenforced", "enforced"),
    advanced_security: FEATURE, dependency_graph: FEATURE, dependency_graph_autosubmit_action: FEATURE,
    dependabot_alerts: FEATURE, dependabot_security_updates: FEATURE, code_scanning_default_setup: FEATURE,
    code_security: FEATURE, secret_protection: FEATURE, code_scanning_delegated_alert_dismissal: FEATURE, dependabot_delegated_alert_dismissal: FEATURE,
    secret_scanning: FEATURE, secret_scanning_push_protection: FEATURE, secret_scanning_non_provider_patterns: FEATURE,
    secret_scanning_validity_checks: FEATURE, secret_scanning_generic_secrets: FEATURE, secret_scanning_delegated_bypass: FEATURE,
    secret_scanning_delegated_alert_dismissal: FEATURE, private_vulnerability_reporting: FEATURE,
  },
  // Detaching a repository from its security configuration loosens it; the default for new repositories governs no declared repository.
  "security-configuration-repositories": { repositories: SUPERSET_IS_STRICT, default_for_new_repos: NEUTRAL },
  "repository-settings": {
    // The feature switches decide how work flows, not what is protected.
    // Merge commits only (#486): allowing squash or rebase breaks verify's first-parent rule, so it loosens.
    allow_merge_commit: NEUTRAL, allow_rebase_merge: FALSE_IS_STRICT, allow_squash_merge: FALSE_IS_STRICT, merge_commit_title: NEUTRAL,
    merge_commit_message: NEUTRAL, squash_merge_commit_title: NEUTRAL, squash_merge_commit_message: NEUTRAL, allow_auto_merge: NEUTRAL,
    delete_branch_on_merge: NEUTRAL, allow_update_branch: NEUTRAL, has_wiki: NEUTRAL, has_discussions: NEUTRAL, has_projects: NEUTRAL,
    has_issues: NEUTRAL, description: NEUTRAL, homepage: NEUTRAL,
    web_commit_signoff_required: TRUE_IS_STRICT, allow_forking: FALSE_IS_STRICT,
  },
  "actions-permissions": {
    enabled: FALSE_IS_STRICT, enabled_repositories: levels("all", "selected", "none"),
    allowed_actions: levels("all", "selected", "local_only"), sha_pinning_required: TRUE_IS_STRICT,
  },
  "actions-selected": { github_owned_allowed: FALSE_IS_STRICT, verified_allowed: FALSE_IS_STRICT, patterns_allowed: SUBSET_IS_STRICT },
  "actions-workflow": { default_workflow_permissions: levels("write", "read"), can_approve_pull_request_reviews: FALSE_IS_STRICT },
  "actions-fork-approval": { approval_policy: levels("first_time_contributors_new_to_github", "first_time_contributors", "all_external_contributors") },
  "immutable-releases": { enabled: TRUE_IS_STRICT },
  "environment": {
    can_admins_bypass: FALSE_IS_STRICT, branch_policies: SUBSET_IS_STRICT, reviewers: SUPERSET_IS_STRICT,
    wait_timer: HIGHER_IS_STRICT, prevent_self_review: TRUE_IS_STRICT,
  },
});

/**
 * The kinds whose write REPLACES the object (a PUT): a protecting field the
 * live object holds and the desired body omits is reset by the write, so it
 * is judged too. A PATCH changes only the fields it sends.
 */
const REPLACED_BY_WRITE: ReadonlySet<ForgeObjectKind> = new Set(["environment", "actions-permissions", "actions-selected", "actions-workflow", "actions-fork-approval", "team-repository", "custom-property"]);

/**
 * WHAT `desired` WEAKENS against `live`: empty when the desired body is
 * proven at least as strict, field by field (see the module header).
 * Judged: every field `desired` declares; for a kind a write replaces, every
 * protecting field the live object holds as well; for a ruleset, its whole
 * structure. GitHub answers more fields than it takes, and a field a PATCH
 * never sends is never changed by it.
 */
export function looseningOf(kind: ForgeObjectKind, desired: unknown, live: unknown): readonly string[] {
  const next = (desired ?? {}) as Readonly<Record<string, unknown>>;
  const now = (live ?? {}) as Readonly<Record<string, unknown>>;
  const fields = KIND_FIELDS[kind];
  if (fields === "neutral") return [];
  if (fields === "ruleset") return rulesetLoosening(next, now);
  const reasons: string[] = [];
  const reset = REPLACED_BY_WRITE.has(kind) ? Object.keys(now).filter((field) => fields[field] !== undefined && fields[field] !== NEUTRAL) : [];
  for (const field of [...new Set([...Object.keys(next), ...reset])].sort()) {
    const order = fields[field] ?? EQUAL;
    if (!order(next[field], now[field])) reasons.push(`${field} ${canonicalJson(now[field] ?? null)} -> ${canonicalJson(next[field] ?? null)}`);
  }
  return reasons;
}

/** The rule type a loosening reason is about, when it is one a baseline rule can carry. */
function ruleTypeOf(reason: string): string | undefined {
  if (reason.startsWith("removes rule ")) return reason.slice("removes rule ".length);
  if (reason.startsWith("drops required check ")) return "required_status_checks";
  const weakened = /^weakens rule ([a-z_]+): /u.exec(reason);
  return weakened?.[1];
}

/**
 * WHETHER A REPOSITORY RULESET'S LOOSENING ONLY MOVES PROTECTION INTO THE ORG
 * BASELINE: every premise the move relies on, each unmet one named (empty:
 * the move holds). Judged on whatever the caller passes: the declarations at
 * plan time, and what GitHub holds right before the apply loosens anything.
 * The premises:
 * - the baseline is active and has the ruleset's target;
 * - its conditions are only a `kind` repository property and refs;
 * - it includes this repository's kind and excludes nothing;
 * - it covers every ref the ruleset covers;
 * - it lets no actor bypass that the ruleset does not already let bypass;
 * - every reason is a rule (removed or weakened) whose baseline rule is at
 *   least as strict as the ruleset's rule today. Any other reason (a bypass
 *   added, a condition narrowed, enforcement off) is never a move.
 */
export function movedPremisesUnmet(reasons: readonly string[], ruleset: unknown, baseline: unknown, repositoryKind: string | undefined): readonly string[] {
  if (typeof baseline !== "object" || baseline === null) return ["there is no org baseline"];
  if (typeof ruleset !== "object" || ruleset === null) return ["there is no repository ruleset"];
  const base = baseline as Readonly<Record<string, unknown>>;
  const repo = ruleset as Readonly<Record<string, unknown>>;
  const unmet: string[] = [];
  if (base.enforcement !== "active") unmet.push(`the baseline's enforcement is ${canonicalJson(base.enforcement ?? null)}, not active`);
  if (!same(base.target, repo.target)) unmet.push(`the baseline targets ${canonicalJson(base.target ?? null)}, the ruleset ${canonicalJson(repo.target ?? null)}`);
  const conditions = (base.conditions ?? {}) as Conditions;
  const unknownConditions = Object.keys(conditions).filter((name) => name !== "repository_property" && name !== "ref_name" && conditions[name] !== null && conditions[name] !== undefined);
  if (unknownConditions.length > 0) unmet.push(`the baseline has conditions a move cannot judge: ${unknownConditions.join(", ")}`);
  type Property = Readonly<{ name?: unknown; property_values?: unknown }>;
  const property = conditions.repository_property ?? {};
  const include = entries(property.include) as readonly Property[];
  if (repositoryKind === undefined) unmet.push("the repository has no kind property");
  else if (include.length === 0 || !include.every((entry) => entry.name === "kind") || !include.some((entry) => contains(entries(entry.property_values), repositoryKind))) {
    unmet.push(`the baseline does not include kind ${repositoryKind}`);
  }
  if (entries(property.exclude).length > 0) unmet.push("the baseline excludes repositories by property");
  const refs = conditions.ref_name ?? {};
  const baseRefs = entries(refs.include);
  const repoRefs = entries(((repo.conditions ?? {}) as Conditions).ref_name?.include);
  if (entries(refs.exclude).length > 0) unmet.push("the baseline excludes refs");
  if (repoRefs.length === 0 && repo.target !== "push") unmet.push("the ruleset names no refs a baseline could cover");
  if (!contains(baseRefs, "~ALL") && !repoRefs.every((ref) => contains(baseRefs, ref))) unmet.push(`the baseline does not cover the refs ${canonicalJson(repoRefs)}`);
  for (const actor of entries(base.bypass_actors)) if (!contains(entries(repo.bypass_actors), actor)) unmet.push(`the baseline lets ${canonicalJson(actor)} bypass`);
  const types = new Set<string>();
  for (const reason of reasons) {
    const type = ruleTypeOf(reason);
    if (type === undefined) unmet.push(`"${reason}" is not a rule a baseline carries`);
    else types.add(type);
  }
  for (const type of [...types].sort()) {
    const held = rulesOf(base).find((rule) => rule.type === type);
    const had = rulesOf(repo).find((rule) => rule.type === type);
    if (held === undefined) { unmet.push(`the baseline has no ${type} rule`); continue; }
    if (had === undefined) { unmet.push(`the ruleset has no ${type} rule to move`); continue; }
    const weaker = ruleLoosening(held, had);
    if (weaker.length > 0) unmet.push(`the baseline's ${type} rule is weaker: ${weaker.join("; ")}`);
  }
  return unmet;
}
