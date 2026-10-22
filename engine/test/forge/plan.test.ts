/**
 * `harness forge plan|apply|audit` (`plan.ts`, `live-state.ts`) against the
 * fake GitHub: create, update, unchanged, refused (an unresolved reference,
 * a plan refusal on one object), unmanaged and retired objects; apply sends
 * only a whole plan and verifies it; a budget refusal stops the run typed;
 * and the whole declaration set plans, applies and converges to zero drift.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { forgeDeclarations } from "../../src/workflow/forge/declarations.ts";
import { isForgeError } from "../../src/workflow/forge/codes.ts";
import { memoryCredential } from "../../src/workflow/forge/credentials.ts";
import type { ForgeObject } from "../../src/workflow/forge/forge-state.ts";
import { githubClient } from "../../src/workflow/forge/github.ts";
import { forgeApply, forgePlan } from "../../src/workflow/forge/plan.ts";
import { looseningOf, movedPremisesUnmet } from "../../src/workflow/forge/strictness.ts";
import { fakeGithub, type FakeGithub } from "./fake-github.ts";
import { SOURCES } from "./forge-settings.ts";

const ORG = "LLM-4-People";
const REPO = "bridlewise-testing";

function contextOf(fake: FakeGithub) {
  return { client: githubClient(fake.endpoint(), memoryCredential("user:maintainer", fake.userToken("maintainer"))), organization: ORG, maxPages: 10 };
}

function object(kind: ForgeObject["kind"], key: string, desired: unknown, scope: ForgeObject["scope"] = { kind: "repo", repository: REPO }, unavailableOnPlan: readonly string[] = []): ForgeObject {
  return { kind, scope, key, file: `${kind}/${key}.json`, desired, unavailableOnPlan };
}

function entry(plan: Awaited<ReturnType<typeof forgePlan>>, kind: string, key: string) {
  const found = plan.entries.find((candidate) => candidate.kind === kind && candidate.key === key);
  assert.ok(found !== undefined, `${kind} ${key} is planned`);
  return found;
}

test("plan, apply, verify: create and update what differs, leave the rest, report the undeclared, retire the declared retired, and refuse a partial plan", async () => {
  const fake = fakeGithub();
  const rulesets = `/repos/${ORG}/${REPO}/rulesets`;
  fake.collection(rulesets, [
    { name: "trunk", source_type: "Repository", target: "branch", enforcement: "active", rules: [{ type: "deletion" }], bypass_actors: [] },
    { name: "protect-release-tags", source_type: "Repository", target: "tag", rules: [] },
    { name: "hand-made", source_type: "Repository", target: "branch", rules: [] },
    { name: "baseline", source_type: "Organization", target: "branch", rules: [] },
  ], "id", { source_type: "Repository" });
  fake.collection(`/repos/${ORG}/${REPO}/labels`, [{ name: "bug", color: "d73a4a", description: "" }, { name: "lane:gh-1", color: "000000", description: "old" }], "name");
  fake.objects.set(`/repos/${ORG}/${REPO}`, { name: REPO, allow_squash_merge: true, has_wiki: false });
  fake.objects.set(`/orgs/${ORG}/installations`, { total_count: 0, installations: [] });
  const objects: ForgeObject[] = [
    object("repository-settings", REPO, { allow_squash_merge: false, has_wiki: false }),
    object("ruleset", "trunk", { name: "trunk", target: "branch", enforcement: "active", rules: [{ type: "deletion" }], bypass_actors: [] }),
    object("ruleset", "product", { name: "product", target: "branch", enforcement: "active", rules: [{ type: "creation" }], bypass_actors: [{ actor_id: { $ref: "app", name: "publisher" }, actor_type: "Integration", bypass_mode: "always" }] }),
    object("label", "lane:gh-1", { name: "lane:gh-1", color: "5319e7", description: "Work of the GH-1 writer lane" }),
    object("label", "area:engine", { name: "area:engine", color: "1d76db", description: "The engine" }),
  ];
  const retired = [{ kind: "ruleset", repository: REPO, name: "protect-release-tags" }] as const;
  const context = contextOf(fake);
  const plan = await forgePlan(context, objects, retired);
  assert.equal(entry(plan, "repository-settings", REPO).action, "update");
  assert.deepEqual(entry(plan, "repository-settings", REPO).differences, ["/allow_squash_merge"]);
  assert.equal(entry(plan, "ruleset", "trunk").action, "unchanged");
  assert.equal(entry(plan, "ruleset", "product").action, "refused");
  assert.equal(entry(plan, "ruleset", "product").code, "forge_reference_unresolved");
  assert.equal(entry(plan, "label", "lane:gh-1").action, "update");
  assert.deepEqual([...entry(plan, "label", "lane:gh-1").differences!].sort(), ["/color", "/description"]);
  assert.equal(entry(plan, "label", "area:engine").action, "create");
  assert.equal(entry(plan, "ruleset", "protect-release-tags").action, "retire");
  assert.equal(entry(plan, "ruleset", "hand-made").action, "unmanaged");
  assert.equal(entry(plan, "label", "bug").action, "unmanaged");
  assert.ok(!plan.entries.some((candidate) => candidate.key === "baseline"), "the organisation's ruleset is not the repository's");
  assert.equal(plan.complete, false);
  assert.ok(plan.drift.some((candidate) => candidate.key === "hand-made"), "an undeclared ruleset is drift");
  assert.ok(!plan.drift.some((candidate) => candidate.key === "bug"), "an undeclared label is reported, not drift");
  // A partial plan is never applied: nothing was written.
  const writesBefore = fake.requests.filter((request) => request.method !== "GET").length;
  await assert.rejects(forgeApply(context, objects, retired), (error: unknown) => isForgeError(error, "forge_plan_incomplete"));
  assert.equal(fake.requests.filter((request) => request.method !== "GET").length, writesBefore);
  // Once the App exists, the whole plan applies and verifies.
  fake.objects.set(`/orgs/${ORG}/installations`, { total_count: 1, installations: [{ id: 77, app_id: 1234, app_slug: "bridlewise-publisher" }] });
  // Retiring a ruleset weakens protection: refused, nothing written, until it is acknowledged by id.
  const before = fake.requests.filter((request) => request.method !== "GET").length;
  await assert.rejects(forgeApply(context, objects, retired), (error: unknown) => isForgeError(error, "forge_loosening_unacknowledged") && /ruleset:bridlewise-testing:protect-release-tags/u.test(error.message));
  assert.equal(fake.requests.filter((request) => request.method !== "GET").length, before, "nothing was written");
  const outcome = await forgeApply(context, objects, retired, new Set(["ruleset:bridlewise-testing:protect-release-tags"]));
  assert.deepEqual(outcome.acceptedLoosening, [{ id: "ruleset:bridlewise-testing:protect-release-tags", loosening: ["deletes the ruleset"] }], "the acknowledgement is in the receipt");
  assert.deepEqual(outcome.applied.map((applied) => `${applied.action} ${applied.kind} ${applied.key}`).sort(), [
    "create label area:engine", "create ruleset product", "retire ruleset protect-release-tags", "update label lane:gh-1", "update repository-settings bridlewise-testing",
  ]);
  const created = (fake.objects.get(rulesets) as { name: string; bypass_actors?: { actor_id: number }[] }[]).find((ruleset) => ruleset.name === "product");
  assert.equal(created?.bypass_actors?.[0]?.actor_id, 1234, "the reference was resolved to the App's id");
  assert.deepEqual(outcome.verification.drift.map((drift) => `${drift.action} ${drift.key}`), ["unmanaged hand-made"]);
  assert.ok(outcome.verification.entries.filter((verified) => verified.action !== "unmanaged").every((verified) => verified.action === "unchanged"));
});

test("one object's refusal is that object's (plan, permission); a budget refusal stops the whole run with when to resume", async () => {
  const fake = fakeGithub();
  fake.objects.set(`/orgs/${ORG}/installations`, { total_count: 0, installations: [] });
  const objects: ForgeObject[] = [
    object("actions-permissions", REPO, { enabled: true }),
    object("actions-workflow", REPO, { default_workflow_permissions: "read" }),
    object("immutable-releases", REPO, { enabled: true }),
  ];
  fake.objects.set(`/repos/${ORG}/${REPO}/actions/permissions/workflow`, { default_workflow_permissions: "read" });
  fake.refuseNext({ path: /\/actions\/permissions$/u }, { status: 403, message: "Upgrade to GitHub Pro or make this repository public to enable this feature." });
  // The allowed-actions list answers 409 until "selected" is on (measured live): it reads as not declared yet, a create.
  objects.push(object("actions-selected", REPO, { github_owned_allowed: true, verified_allowed: false, patterns_allowed: [] }));
  fake.refuseNext({ path: /\/actions\/permissions\/selected-actions$/u }, { status: 409, message: "Selected actions are not enabled for this repository." });
  const plan = await forgePlan(contextOf(fake), objects, []);
  assert.equal(entry(plan, "actions-permissions", REPO).action, "refused");
  assert.equal(entry(plan, "actions-permissions", REPO).code, "unavailable_on_plan");
  assert.equal(entry(plan, "actions-workflow", REPO).action, "unchanged");
  assert.equal(entry(plan, "immutable-releases", REPO).action, "update", "absent immutable releases read as disabled");
  assert.equal(entry(plan, "actions-selected", REPO).action, "create");
  fake.refuseNext({ path: /\/actions\/permissions\/workflow$/u }, { status: 403, message: "API rate limit exceeded", headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600) } });
  await assert.rejects(forgePlan(contextOf(fake), objects, []), (error: unknown) => isForgeError(error, "github_rate_limited") && typeof error.facts.resetAt === "string");
});

test("fields the plan does not allow are recorded and never written", async () => {
  const fake = fakeGithub();
  fake.objects.set(`/orgs/${ORG}/installations`, { total_count: 0, installations: [] });
  fake.collection(`/orgs/${ORG}/code-security/configurations`, []);
  fake.route("POST", /\/code-security\/configurations\/\d+\/attach$/u, () => ({ status: 202, body: {} }));
  fake.route("PUT", /\/code-security\/configurations\/\d+\/defaults$/u, () => ({ status: 200, body: {} }));
  const security = object("security-configuration", "baseline", { name: "baseline", secret_scanning: "enabled", secret_scanning_validity_checks: "enabled" }, { kind: "org" }, ["secret_scanning_validity_checks"]);
  const context = contextOf(fake);
  const plan = await forgePlan(context, [security], []);
  assert.deepEqual(entry(plan, "security-configuration", "baseline").unavailableOnPlan, ["secret_scanning_validity_checks"]);
  const outcome = await forgeApply(context, [security], []);
  assert.equal(outcome.verification.drift.length, 0);
  const sent = fake.requests.find((request) => request.method === "POST" && request.path.endsWith("/code-security/configurations"));
  assert.deepEqual(sent?.body, { name: "baseline", secret_scanning: "enabled" });
  assert.ok(fake.requests.some((request) => request.path.endsWith("/attach") && JSON.stringify(request.body) === JSON.stringify({ scope: "all" })));
  assert.ok(fake.requests.some((request) => request.path.endsWith("/defaults") && JSON.stringify(request.body) === JSON.stringify({ default_for_new_repos: "all" })));
});

/** A fake GitHub that answers every kind the declarations use, statefully. */
function wholeGithub(): FakeGithub {
  const fake = fakeGithub();
  fake.objects.set(`/orgs/${ORG}`, { login: ORG });
  fake.objects.set(`/users/amberflag48`, { login: "amberflag48", id: 99 });
  fake.objects.set(`/orgs/${ORG}/installations`, { total_count: 4, installations: ["agent", "verifier", "door", "publisher"].map((role, index) => ({ id: 70 + index, app_id: 1000 + index, app_slug: `bridlewise-${role}` })) });
  fake.collection(`/orgs/${ORG}/teams`, [], "name");
  fake.collection(`/orgs/${ORG}/rulesets`, [], "id", { source_type: "Organization" });
  fake.collection(`/orgs/${ORG}/issue-types`, [{ name: "Task", color: "yellow", is_enabled: true, description: "" }]);
  fake.collection(`/orgs/${ORG}/issue-fields`, []);
  fake.collection(`/orgs/${ORG}/code-security/configurations`, []);
  fake.route("POST", /\/code-security\/configurations\/\d+\/(attach)$/u, () => ({ status: 202, body: {} }));
  fake.route("PUT", /\/code-security\/configurations\/\d+\/defaults$/u, () => ({ status: 200, body: {} }));
  const propertyValues = new Map<string, Record<string, unknown>[]>();
  fake.route("GET", /^\/repos\/[^/]+\/([^/]+)\/properties\/values$/u, (_request, match) => ({ status: 200, body: propertyValues.get(match[1]!) ?? [] }));
  fake.route("PATCH", /^\/repos\/[^/]+\/([^/]+)\/properties\/values$/u, (request, match) => {
    propertyValues.set(match[1]!, (request.body as { properties: Record<string, unknown>[] }).properties);
    return { status: 204 };
  });
  const teamGrants = new Map<string, string>();
  const ROLE: Record<string, string> = { pull: "read", triage: "triage", push: "write", maintain: "maintain", admin: "admin" };
  fake.route("GET", /^\/orgs\/[^/]+\/teams\/([^/]+)\/repos\/[^/]+\/([^/]+)$/u, (_request, match) => {
    const grant = teamGrants.get(`${match[1]!}/${match[2]!}`);
    return grant === undefined ? { status: 404, body: { message: "Not Found" } } : { status: 200, body: { role_name: ROLE[grant] } };
  });
  fake.route("PUT", /^\/orgs\/[^/]+\/teams\/([^/]+)\/repos\/[^/]+\/([^/]+)$/u, (request, match) => {
    teamGrants.set(`${match[1]!}/${match[2]!}`, (request.body as { permission: string }).permission);
    return { status: 204 };
  });
  const immutable = new Set<string>();
  fake.route("GET", /^\/repos\/[^/]+\/([^/]+)\/immutable-releases$/u, (_request, match) => ({ status: 200, body: { enabled: immutable.has(match[1]!) } }));
  fake.route("PUT", /^\/repos\/[^/]+\/([^/]+)\/immutable-releases$/u, (_request, match) => { immutable.add(match[1]!); return { status: 204 }; });
  const branchPolicies = new Map<string, string[]>();
  fake.route("GET", /^\/repos\/[^/]+\/[^/]+\/environments\/([^/]+)\/deployment-branch-policies$/u, (_request, match) => ({ status: 200, body: { total_count: 0, branch_policies: (branchPolicies.get(match[1]!) ?? []).map((name) => ({ name })) } }));
  fake.route("POST", /^\/repos\/[^/]+\/[^/]+\/environments\/([^/]+)\/deployment-branch-policies$/u, (request, match) => {
    branchPolicies.set(match[1]!, [...(branchPolicies.get(match[1]!) ?? []), (request.body as { name: string }).name]);
    return { status: 200, body: request.body };
  });
  fake.route("PUT", /^\/repos\/[^/]+\/[^/]+\/environments\/([^/]+)$/u, (request, match) => {
    const body = request.body as { reviewers?: { type: string; id: number }[] } & Record<string, unknown>;
    const stored = { name: match[1]!, deployment_branch_policy: body.deployment_branch_policy, can_admins_bypass: body.can_admins_bypass,
      protection_rules: body.reviewers === undefined ? [] : [{ type: "required_reviewers", reviewers: body.reviewers.map((reviewer) => ({ type: reviewer.type, reviewer: { id: reviewer.id } })) }] };
    fake.objects.set(request.path, stored);
    return { status: 200, body: stored };
  });
  for (const repository of SOURCES.settings.repositories) {
    const base = `/repos/${ORG}/${repository.name}`;
    fake.objects.set(base, { name: repository.name });
    fake.collection(`${base}/rulesets`, [], "id", { source_type: "Repository" });
    fake.collection(`${base}/labels`, [], "name");
    fake.collection(`${base}/autolinks`, [], "id");
  }
  // The Project, through GraphQL.
  const project = { id: "PVT_1", title: "", public: false, created: false, fields: [{ id: "F_status", name: "Status", dataType: "SINGLE_SELECT", options: [{ name: "Todo" }] }] as { id: string; name: string; dataType: string; options?: { name: string }[] }[] };
  fake.route("POST", /^\/graphql$/u, (request) => {
    const { query, variables } = request.body as { query: string; variables: Record<string, unknown> };
    if (query.includes("projectsV2(")) return { status: 200, body: { data: { organization: { id: "O_1", projectsV2: { nodes: project.created ? [{ id: project.id, title: project.title, public: project.public, fields: { nodes: project.fields } }] : [] } } } } };
    if (query.includes("createProjectV2(")) { project.created = true; project.title = String(variables.title); return { status: 200, body: { data: { createProjectV2: { projectV2: { id: project.id } } } } }; }
    if (query.includes("updateProjectV2(")) { project.public = variables.public === true; return { status: 200, body: { data: { updateProjectV2: { projectV2: { id: project.id } } } } }; }
    const options = (variables.options as { name: string }[] | null)?.map((option) => ({ name: option.name }));
    if (query.includes("updateProjectV2Field(")) {
      const field = project.fields.find((candidate) => candidate.id === variables.fieldId)!;
      if (options === undefined) delete field.options; else field.options = options;
      return { status: 200, body: { data: {} } };
    }
    if (query.includes("createProjectV2Field(")) { project.fields.push({ id: `F_${String(project.fields.length)}`, name: String(variables.name), dataType: String(variables.dataType), ...(options === undefined ? {} : { options }) }); return { status: 200, body: { data: {} } }; }
    return { status: 200, body: { errors: [{ type: "UNPROCESSABLE", message: "unexpected query" }] } };
  });
  return fake;
}

test("the whole declaration set plans, applies in order and converges: zero drift on the second plan", async () => {
  const fake = wholeGithub();
  const context = contextOf(fake);
  const objects = forgeDeclarations(SOURCES);
  const plan = await forgePlan(context, objects, SOURCES.settings.retired);
  assert.equal(plan.complete, true, JSON.stringify(plan.entries.filter((planned) => planned.action === "refused")));
  assert.ok(plan.counts.create > 30, `a fresh organisation is mostly creates (${String(plan.counts.create)})`);
  const outcome = await forgeApply(context, objects, SOURCES.settings.retired);
  assert.deepEqual(outcome.verification.drift, [], JSON.stringify(outcome.verification.drift));
  assert.equal(outcome.verification.counts.unchanged, objects.length);
  // The baseline was created as an organisation ruleset, the agent ruleset with the agent App's id.
  const agentRuleset = (fake.objects.get(`/repos/${ORG}/${REPO}/rulesets`) as { name: string; bypass_actors: { actor_id: number }[] }[]).find((ruleset) => ruleset.name === "agent-branches");
  assert.equal(agentRuleset?.bypass_actors[0]?.actor_id, 1000);
  assert.ok((fake.objects.get(`/orgs/${ORG}/rulesets`) as { name: string }[]).some((ruleset) => ruleset.name === "baseline"));
  // Idempotent: a third plan makes no write and finds nothing.
  const writes = fake.requests.filter((request) => request.method !== "GET" && request.path !== "/graphql").length;
  const again = await forgePlan(context, objects, SOURCES.settings.retired);
  assert.deepEqual(again.drift, []);
  assert.equal(fake.requests.filter((request) => request.method !== "GET" && request.path !== "/graphql").length, writes);
});

const TRUNK_REFS = { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } };

/** A trunk whose repository ruleset holds the review rules today, and the declarations that move them into the org baseline. */
function movingFixture() {
  const fake = fakeGithub();
  /** The repository's kind as GitHub holds it (a test changes it to plant a mismatch). */
  const live = { kind: "trunk" };
  fake.objects.set(`/orgs/${ORG}/installations`, { total_count: 0, installations: [] });
  const checks = [{ context: "CI", integration_id: 15368 }];
  const review = { type: "pull_request", parameters: { required_approving_review_count: 0, dismiss_stale_reviews_on_push: true, require_code_owner_review: false, require_last_push_approval: false, required_review_thread_resolution: true, allowed_merge_methods: ["merge"] } };
  const status = { type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, do_not_enforce_on_create: false, required_status_checks: checks } };
  fake.collection(`/repos/${ORG}/${REPO}/rulesets`, [{ name: "trunk", source_type: "Repository", target: "branch", enforcement: "active", bypass_actors: [], conditions: TRUNK_REFS, rules: [{ type: "deletion" }, review, status] }], "id", { source_type: "Repository" });
  fake.collection(`/orgs/${ORG}/rulesets`, [], "id", { source_type: "Organization" });
  fake.route("GET", /^\/repos\/[^/]+\/[^/]+\/properties\/values$/u, () => ({ status: 200, body: [{ property_name: "kind", value: live.kind }] }));
  const objects: ForgeObject[] = [
    object("custom-property-values", "kind", { kind: "trunk" }),
    object("org-ruleset", "baseline", { name: "baseline", target: "branch", enforcement: "active", bypass_actors: [], rules: [{ type: "deletion" }, review, status],
      conditions: { repository_property: { include: [{ name: "kind", property_values: ["trunk"] }], exclude: [] }, ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } } }, { kind: "org" }),
    object("ruleset", "trunk", { name: "trunk", target: "branch", enforcement: "active", bypass_actors: [], conditions: TRUNK_REFS, rules: [{ type: "deletion" }] }),
  ];
  return { fake, objects, live };
}

test("barrier 1, tighten first: the baseline is created and read back BEFORE the repository rules move out; a move needs no acknowledgement", async () => {
  const { fake, objects } = movingFixture();
  const context = contextOf(fake);
  const plan = await forgePlan(context, objects, []);
  const trunk = entry(plan, "ruleset", "trunk");
  assert.deepEqual([...trunk.loosening!].sort(), ["removes rule pull_request", "removes rule required_status_checks"]);
  assert.equal(trunk.moved, true, "every removed rule is carried by the baseline for this repository's kind");
  const outcome = await forgeApply(context, objects, []);
  assert.deepEqual(outcome.movedLoosening, ["ruleset:bridlewise-testing:trunk"]);
  const writes = fake.requests.map((request, index) => ({ request, index })).filter(({ request }) => request.method !== "GET");
  const baselineWrite = writes.find(({ request }) => request.method === "POST" && request.path === `/orgs/${ORG}/rulesets`)!.index;
  const trunkWrite = writes.find(({ request }) => request.method === "PUT" && request.path.startsWith(`/repos/${ORG}/${REPO}/rulesets/`))!.index;
  assert.ok(baselineWrite < trunkWrite, "the baseline is written first");
  assert.ok(fake.requests.slice(baselineWrite + 1, trunkWrite).some((request) => request.method === "GET" && request.path.startsWith(`/orgs/${ORG}/rulesets`)), "and read back before the trunk is weakened");
  assert.deepEqual(outcome.verification.drift, []);
});

test("barrier 2, the read-back: a baseline that does not hold what was declared stops the apply before anything is loosened", async () => {
  const { fake, objects } = movingFixture();
  // GitHub stores the baseline without its review rule (a plan limit, an API quirk): the read-back must catch it.
  fake.route("POST", new RegExp(`^/orgs/${ORG}/rulesets$`, "u"), (request) => {
    const body = request.body as { rules: { type: string }[] };
    // It drops `deletion`, a rule no move relies on: only the read-back of the whole declared baseline can see it.
    const stored = { ...body, id: 9001, source_type: "Organization", rules: body.rules.filter((rule) => rule.type !== "deletion") };
    (fake.objects.get(`/orgs/${ORG}/rulesets`) as unknown[]).push(stored);
    fake.objects.set(`/orgs/${ORG}/rulesets/9001`, stored);
    return { status: 201, body: stored };
  });
  await assert.rejects(forgeApply(contextOf(fake), objects, []), (error: unknown) => isForgeError(error, "forge_tighten_unverified"));
  assert.ok(!fake.requests.some((request) => request.method === "PUT" && request.path.startsWith(`/repos/${ORG}/${REPO}/rulesets/`)), "the trunk kept its rules");
});

test("barrier 3, acknowledgement: a weakening that is not a move is refused before anything is written, and applies only with its id", async () => {
  const { fake, objects } = movingFixture();
  // The trunk also drops `deletion`, which the baseline does carry, and gains a bypass actor, which nothing excuses.
  const weakened = objects.map((candidate) => candidate.kind === "ruleset" ? { ...candidate, desired: { ...(candidate.desired as object), bypass_actors: [{ actor_id: 5, actor_type: "Integration", bypass_mode: "always" }] } } : candidate);
  const context = contextOf(fake);
  const plan = await forgePlan(context, weakened, []);
  assert.equal(entry(plan, "ruleset", "trunk").moved, false);
  assert.ok(entry(plan, "ruleset", "trunk").loosening!.some((reason) => reason.startsWith("adds bypass")));
  await assert.rejects(forgeApply(context, weakened, []), (error: unknown) => isForgeError(error, "forge_loosening_unacknowledged") && /ruleset:bridlewise-testing:trunk/u.test(error.message));
  assert.ok(!fake.requests.some((request) => request.method !== "GET"), "nothing was written, the baseline included");
  const outcome = await forgeApply(context, weakened, [], new Set(["ruleset:bridlewise-testing:trunk"]));
  assert.equal(outcome.acceptedLoosening[0]?.id, "ruleset:bridlewise-testing:trunk");
  // The classifier, directly: tightening and neutral changes are not loosenings (near misses).
  assert.deepEqual(looseningOf("ruleset", { enforcement: "active", rules: [{ type: "deletion" }, { type: "creation" }] }, { enforcement: "active", rules: [{ type: "deletion" }] }), []);
  assert.deepEqual(looseningOf("actions-permissions", { sha_pinning_required: true, allowed_actions: "selected" }, { sha_pinning_required: false, allowed_actions: "all" }), []);
  assert.deepEqual(looseningOf("actions-permissions", { sha_pinning_required: false, allowed_actions: "all" }, { sha_pinning_required: true, allowed_actions: "selected" }), ['allowed_actions "selected" -> "all"', "sha_pinning_required true -> false"]);
  assert.deepEqual(looseningOf("security-configuration", { secret_scanning: "disabled" }, { secret_scanning: "enabled" }), ['secret_scanning "enabled" -> "disabled"']);
});

test("barrier 4, the move's premises are READ FROM GITHUB: a repository whose live kind is not the baseline's keeps its rules, whatever the declarations say", async () => {
  const { fake, objects, live } = movingFixture();
  // The probe's case: the repository's live kind is `tool`, and GitHub answers the PATCH that sets `trunk` without changing it.
  live.kind = "tool";
  fake.route("PATCH", /^\/repos\/[^/]+\/[^/]+\/properties\/values$/u, () => ({ status: 204 }));
  const context = contextOf(fake);
  const plan = await forgePlan(context, objects, []);
  assert.equal(entry(plan, "ruleset", "trunk").moved, true, "by the declarations, the move holds");
  assert.deepEqual(entry(plan, "custom-property-values", "kind").loosening, ['kind "tool" -> "trunk"'], "changing a set kind is not proven stricter");
  await assert.rejects(forgeApply(context, objects, [], new Set(["custom-property-values:bridlewise-testing:kind"])),
    (error: unknown) => isForgeError(error, "forge_tighten_unverified") && /does not include kind tool/u.test(error.message) && /ruleset:bridlewise-testing:trunk/u.test(error.message));
  assert.ok(fake.requests.some((request) => request.method === "PATCH" && request.path.endsWith("/properties/values")), "the acknowledged kind change was sent");
  assert.ok(!fake.requests.some((request) => request.method === "PUT" && request.path.startsWith(`/repos/${ORG}/${REPO}/rulesets/`)), "the trunk kept its rules: main is never left unprotected");
});

test("barrier 5, the live baseline must carry what moves: a baseline rule weaker than the one leaving the repository stops the move", async () => {
  const { fake, objects } = movingFixture();
  // The baseline already exists on GitHub exactly as declared, but declared with ONE approval fewer than the trunk has today.
  const trunkToday = (fake.objects.get(`/repos/${ORG}/${REPO}/rulesets`) as { rules: { type: string; parameters?: Record<string, unknown> }[] }[])[0]!;
  trunkToday.rules = trunkToday.rules.map((rule) => rule.type === "pull_request" ? { ...rule, parameters: { ...rule.parameters, required_approving_review_count: 1 } } : rule);
  const context = contextOf(fake);
  const plan = await forgePlan(context, objects, []);
  assert.equal(entry(plan, "ruleset", "trunk").moved, false, "the declared baseline asks fewer approvals: not a move");
  await assert.rejects(forgeApply(context, objects, []), (error: unknown) => isForgeError(error, "forge_loosening_unacknowledged"));
  assert.ok(!fake.requests.some((request) => request.method !== "GET"), "nothing was written");
});

test("the strictness order is TOTAL: what is not proven stricter or equal is a loosening, named", () => {
  const checks = (...entries: unknown[]) => ({ type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, do_not_enforce_on_create: false, required_status_checks: entries } });
  const ruleset = (conditions: unknown, ...rules: unknown[]) => ({ name: "trunk", target: "branch", enforcement: "active", bypass_actors: [], conditions, rules });
  const ci = { context: "CI", integration_id: 15368 };
  const live = ruleset(TRUNK_REFS, checks(ci));
  // The three weakenings a list of known ones missed: a conditions retarget, a lost integration_id, strict turned off.
  assert.deepEqual(looseningOf("ruleset", ruleset({ ref_name: { include: ["refs/heads/other"], exclude: [] } }, checks(ci)), live), [
    'narrows condition ref_name: {"exclude":[],"include":["~DEFAULT_BRANCH"]} -> {"exclude":[],"include":["refs/heads/other"]}',
  ]);
  assert.deepEqual(looseningOf("ruleset", ruleset(TRUNK_REFS, checks({ context: "CI" })), live), [
    'weakens rule required_status_checks: required_status_checks [{"context":"CI","integration_id":15368}] -> [{"context":"CI"}]',
    'drops required check {"context":"CI","integration_id":15368}',
  ]);
  const notStrict = checks(ci);
  (notStrict.parameters as Record<string, unknown>).strict_required_status_checks_policy = false;
  assert.deepEqual(looseningOf("ruleset", ruleset(TRUNK_REFS, notStrict), live), ["weakens rule required_status_checks: strict_required_status_checks_policy true -> false"]);
  // A field or parameter nobody ordered is unproven, so it is a loosening; a condition GitHub added that the order does not know, too.
  assert.deepEqual(looseningOf("ruleset", ruleset(TRUNK_REFS, { type: "merge_queue", parameters: { max_entries_to_merge: 4 } }), ruleset(TRUNK_REFS, { type: "merge_queue", parameters: { max_entries_to_merge: 5 } })), ["weakens rule merge_queue: max_entries_to_merge 5 -> 4"]);
  assert.deepEqual(looseningOf("ruleset", ruleset({ ...TRUNK_REFS, repository_id: { repository_ids: [2] } }, checks(ci)), ruleset({ ...TRUNK_REFS, repository_id: { repository_ids: [1] } }, checks(ci))), ['narrows condition repository_id: {"repository_ids":[1]} -> {"repository_ids":[2]}']);
  assert.deepEqual(looseningOf("actions-workflow", { default_workflow_permissions: "read", new_field: 1 }, { default_workflow_permissions: "read", new_field: 2 }), ["new_field 2 -> 1"]);
  // A replacing write resets what it omits: an environment that drops its reviewers loosens.
  assert.deepEqual(looseningOf("environment", { can_admins_bypass: false }, { can_admins_bypass: false, reviewers: [{ type: "User", id: 99 }] }), ['reviewers [{"id":99,"type":"User"}] -> null']);
  assert.deepEqual(looseningOf("ruleset", { ...live, enforcement: "evaluate" }, live), ["enforcement off"]);
  assert.deepEqual(looseningOf("ruleset", { ...live, enforcement: "evaluate" }, { ...live, enforcement: "disabled" }), [], "evaluate is stricter than disabled");
  // Near misses: wider refs, an extra check, strict on, a new rule, a neutral setting, a kind set where none was: none weakens.
  assert.deepEqual(looseningOf("ruleset", ruleset({ ref_name: { include: ["~ALL"], exclude: [] } }, checks(ci, { context: "More" }), { type: "deletion" }), live), []);
  assert.deepEqual(looseningOf("repository-settings", { has_wiki: true, allow_squash_merge: true }, { has_wiki: false, allow_squash_merge: false }), []);
  assert.deepEqual(looseningOf("custom-property-values", { kind: "trunk" }, {}), []);
  assert.deepEqual(looseningOf("label", { color: "000000" }, { color: "ffffff" }), [], "a label guards nothing");
});

test("a move's premises, one by one: each unmet one is named, and only a baseline that carries every moved rule at least as strictly holds", () => {
  const review = { type: "pull_request", parameters: { required_approving_review_count: 1, dismiss_stale_reviews_on_push: true } };
  const repo = { name: "trunk", target: "branch", enforcement: "active", bypass_actors: [{ actor_id: 7, actor_type: "Integration", bypass_mode: "always" }], conditions: TRUNK_REFS, rules: [{ type: "deletion" }, review] };
  const baseline = { name: "baseline", target: "branch", enforcement: "active", bypass_actors: [] as unknown[],
    conditions: { repository_property: { include: [{ name: "kind", property_values: ["trunk"] }], exclude: [] as unknown[] }, ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] as unknown[] } },
    rules: [{ type: "deletion" }, review] };
  const reasons = ["removes rule pull_request"];
  assert.deepEqual(movedPremisesUnmet(reasons, repo, baseline, "trunk"), [], "the positive control holds");
  const unmet = (changed: Record<string, unknown>, kind = "trunk", why = reasons) => movedPremisesUnmet(why, repo, { ...baseline, ...changed }, kind);
  const named = (found: readonly string[], pattern: RegExp) => assert.ok(found.length === 1 && pattern.test(found[0]!), JSON.stringify(found));
  named(unmet({ enforcement: "evaluate" }), /enforcement is "evaluate"/u);
  named(unmet({ target: "tag" }), /baseline targets "tag"/u);
  named(unmet({ conditions: { ...baseline.conditions, repository_name: { include: ["x"], exclude: [] } } }), /conditions a move cannot judge: repository_name/u);
  named(unmet({}, "tool"), /does not include kind tool/u);
  named(movedPremisesUnmet(reasons, repo, baseline, undefined), /no kind property/u);
  named(unmet({ conditions: { ...baseline.conditions, repository_property: { include: [{ name: "kind", property_values: ["trunk"] }, { name: "team", property_values: ["x"] }], exclude: [] } } }), /does not include kind trunk/u);
  named(unmet({ conditions: { ...baseline.conditions, repository_property: { include: [{ name: "kind", property_values: ["trunk"] }], exclude: [{ name: "kind", property_values: ["x"] }] } } }), /excludes repositories/u);
  named(unmet({ conditions: { ...baseline.conditions, ref_name: { include: ["~DEFAULT_BRANCH"], exclude: ["refs/heads/x"] } } }), /excludes refs/u);
  named(unmet({ conditions: { ...baseline.conditions, ref_name: { include: ["refs/heads/other"], exclude: [] } } }), /does not cover the refs/u);
  named(unmet({ bypass_actors: [{ actor_id: 8, actor_type: "Integration", bypass_mode: "always" }] }), /lets .* bypass/u);
  named(unmet({}, "trunk", ["adds bypass {}"]), /is not a rule a baseline carries/u);
  named(unmet({ rules: [{ type: "deletion" }] }), /has no pull_request rule/u);
  named(unmet({ rules: [{ type: "deletion" }, { type: "pull_request", parameters: { required_approving_review_count: 0, dismiss_stale_reviews_on_push: true } }] }), /pull_request rule is weaker: .*required_approving_review_count/u);
  named(movedPremisesUnmet(reasons, { ...repo, rules: [{ type: "deletion" }] }, baseline, "trunk"), /has no pull_request rule to move/u);
  named(movedPremisesUnmet(reasons, { ...repo, conditions: {} }, baseline, "trunk"), /names no refs/u);
  // Near misses that hold: `~ALL` covers any ref, and the baseline's bypass actor is one the ruleset already has.
  assert.deepEqual(unmet({ conditions: { ...baseline.conditions, ref_name: { include: ["~ALL"], exclude: [] } }, bypass_actors: [repo.bypass_actors[0]] }), []);
});
