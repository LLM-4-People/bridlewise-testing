/**
 * `harness forge plan|apply|audit` (`plan.ts`, `live-state.ts`) against the
 * fake GitHub: create, update, unchanged, refused (an unresolved reference,
 * a plan refusal on one object), unmanaged and retired objects; apply sends
 * only a whole plan and verifies it; a budget refusal stops the run typed;
 * and the whole declaration set plans, applies and converges to zero drift.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { runForgeCli } from "../../src/workflow/forge/cli.ts";
import { forgeDeclarations } from "../../src/workflow/forge/declarations.ts";
import { forgeFileSources, syncForgeFiles } from "../../src/workflow/forge/generated-files.ts";
import { isForgeError } from "../../src/workflow/forge/codes.ts";
import { memoryCredential } from "../../src/workflow/forge/credentials.ts";
import type { ForgeObject } from "../../src/workflow/forge/forge-state.ts";
import { githubClient } from "../../src/workflow/forge/github.ts";
import { maintainerCli } from "../../src/workflow/forge/maintainer-cli.ts";
import { forgeApply, forgePlan } from "../../src/workflow/forge/plan.ts";
import { looseningOf, movedPremisesUnmet } from "../../src/workflow/forge/strictness.ts";
import { fakeGithub, type FakeGithub } from "./fake-github.ts";
import { temporaryKeyHome } from "./forge-key-home.ts";
import { SETTINGS, SOURCES, TRUNK } from "./forge-settings.ts";
import { createTempDir } from "../support/temp-dir.ts";

const ORG = "LLM-4-People";
const REPO = TRUNK;

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
  await assert.rejects(forgeApply(context, objects, retired), (error: unknown) => isForgeError(error, "forge_loosening_unacknowledged") && error.message.includes(`ruleset:${REPO}:protect-release-tags`));
  assert.equal(fake.requests.filter((request) => request.method !== "GET").length, before, "nothing was written");
  const outcome = await forgeApply(context, objects, retired, new Set([`ruleset:${REPO}:protect-release-tags`]));
  assert.deepEqual(outcome.acceptedLoosening, [{ id: `ruleset:${REPO}:protect-release-tags`, loosening: ["deletes the ruleset"] }], "the acknowledgement is in the receipt");
  assert.deepEqual(outcome.applied.map((applied) => `${applied.action} ${applied.kind} ${applied.key}`).sort(), [
    "create label area:engine", "create ruleset product", "retire ruleset protect-release-tags", "update label lane:gh-1", `update repository-settings ${REPO}`,
  ]);
  const created = (fake.objects.get(rulesets) as { name: string; bypass_actors?: { actor_id: number }[] }[]).find((ruleset) => ruleset.name === "product");
  assert.equal(created?.bypass_actors?.[0]?.actor_id, 1234, "the reference was resolved to the App's id");
  assert.deepEqual(outcome.verification.drift.map((drift) => `${drift.action} ${drift.key}`), ["unmanaged hand-made"]);
  assert.equal(outcome.verified, false, "the undeclared ruleset is still drift after the apply: the apply did not converge");
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
  fake.refuseNext({ path: new RegExp(`^/repos/${ORG}/${REPO}/actions/permissions$`, "u") }, { status: 403, message: "Upgrade to GitHub Pro or make this repository public to enable this feature." });
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
  const security = object("security-configuration", "baseline", { name: "baseline", secret_scanning: "enabled", secret_scanning_validity_checks: "enabled" }, { kind: "org" }, ["secret_scanning_validity_checks"]);
  // Its attachment is its own object: the declared repositories only (the organisation holds others), selected by id.
  fake.objects.set(`/repos/${ORG}/${REPO}`, { name: REPO });
  fake.objects.set(`/repos/${ORG}/not-governed`, { name: "not-governed" });
  const attachment = object("security-configuration-repositories", "baseline", { repositories: [REPO], default_for_new_repos: "none" }, { kind: "org" });
  const context = contextOf(fake);
  const plan = await forgePlan(context, [security, attachment], []);
  assert.deepEqual(entry(plan, "security-configuration", "baseline").unavailableOnPlan, ["secret_scanning_validity_checks"]);
  const outcome = await forgeApply(context, [security, attachment], []);
  assert.equal(outcome.verification.drift.length, 0);
  assert.equal(outcome.verified, true);
  const sent = fake.requests.find((request) => request.method === "POST" && request.path.endsWith("/code-security/configurations"));
  assert.deepEqual(sent?.body, { name: "baseline", secret_scanning: "enabled" });
  const repositoryId = (await contextOf(fake).client.rest<{ id: number }>({ method: "GET", path: `/repos/${ORG}/${REPO}` })).data.id;
  assert.ok(fake.requests.some((request) => request.path.endsWith("/attach") && JSON.stringify(request.body) === JSON.stringify({ scope: "selected", selected_repository_ids: [repositoryId] })), "the declared repository, by id");
  assert.ok(!fake.requests.some((request) => request.path.endsWith("/attach") && (request.body as { scope?: string }).scope === "all"), "never every repository");
  assert.ok(fake.requests.some((request) => request.path.endsWith("/defaults") && JSON.stringify(request.body) === JSON.stringify({ default_for_new_repos: "none" })));
  // A repository attached by hand is drift, and detaching it is a loosening the plan names.
  const notGoverned = (await contextOf(fake).client.rest<{ id: number }>({ method: "GET", path: `/repos/${ORG}/not-governed` })).data.id;
  const configurationId = (fake.objects.get(`/orgs/${ORG}/code-security/configurations`) as { id: number; name: string }[]).find((item) => item.name === "baseline")!.id;
  await contextOf(fake).client.rest({ method: "POST", path: `/orgs/${ORG}/code-security/configurations/${String(configurationId)}/attach`, body: { scope: "selected", selected_repository_ids: [notGoverned] } });
  const drifted = entry(await forgePlan(contextOf(fake), [security, attachment], []), "security-configuration-repositories", "baseline");
  assert.equal(drifted.action, "update");
  assert.deepEqual(drifted.loosening, [`repositories ["${REPO}","not-governed"] -> ["${REPO}"]`]);
  // The detach is applied only with its acknowledgement, and leaves the declared repositories alone.
  await assert.rejects(forgeApply(contextOf(fake), [security, attachment], []), (error: unknown) => isForgeError(error, "forge_loosening_unacknowledged"));
  await forgeApply(contextOf(fake), [security, attachment], [], new Set(["security-configuration-repositories:org:baseline"]));
  assert.ok(fake.requests.some((request) => request.method === "DELETE" && request.path === `/orgs/${ORG}/code-security/configurations/detach` && JSON.stringify(request.body) === JSON.stringify({ selected_repository_ids: [notGoverned] })), "the hand-attached repository is detached by id");
  assert.equal(entry(await forgePlan(contextOf(fake), [security, attachment], []), "security-configuration-repositories", "baseline").action, "unchanged", "only the declared repository is attached");
  // A FAILED attach (a feature GitHub cannot enable there) is never a success: the plan refuses it loudly, naming it.
  fake.objects.set(`/repos/${ORG}/failing`, { name: "failing" });
  fake.failSecurityAttach(ORG, "failing");
  const withFailing = object("security-configuration-repositories", "baseline", { repositories: [REPO, "failing"].sort(), default_for_new_repos: "none" }, { kind: "org" });
  const failedOutcome = await forgeApply(contextOf(fake), [security, withFailing], []);
  assert.equal(failedOutcome.verified, false, "a failed attach does not verify");
  const refused = entry(await forgePlan(contextOf(fake), [security, withFailing], []), "security-configuration-repositories", "baseline");
  assert.equal(refused.code, "forge_security_attach_failed");
  assert.match(refused.message ?? "", /failing/u);
});

test("an issue field's update sends each existing option's id (an option sent without it is a new option, and every issue's value would be wiped); options compare without ids", async () => {
  const fake = fakeGithub();
  fake.objects.set(`/orgs/${ORG}/installations`, { total_count: 0, installations: [] });
  fake.collection(`/orgs/${ORG}/issue-fields`, [{ id: 7, name: "Severity", data_type: "single_select", visibility: "organization_members_only", description: "How bad it is (P0 worst)", options: [{ id: 71, name: "P0", color: "gray", priority: 1 }, { id: 72, name: "P1", color: "orange", priority: 2 }] }], "id");
  const declared = object("issue-field", "Severity", { name: "Severity", data_type: "single_select", visibility: "organization_members_only", description: "How bad it is (P0 worst)", options: [{ name: "P0", color: "red", priority: 1 }, { name: "P1", color: "orange", priority: 2 }, { name: "P2", color: "yellow", priority: 3 }] }, { kind: "org" });
  const context = contextOf(fake);
  const planned = entry(await forgePlan(context, [declared], []), "issue-field", "Severity");
  assert.equal(planned.action, "update");
  await forgeApply(context, [declared], []);
  const patch = fake.requests.find((request) => request.method === "PATCH" && request.path === `/orgs/${ORG}/issue-fields/7`);
  assert.deepEqual((patch?.body as { options: unknown[] }).options, [{ id: 71, name: "P0", color: "red", priority: 1 }, { id: 72, name: "P1", color: "orange", priority: 2 }, { name: "P2", color: "yellow", priority: 3 }]);
  assert.equal((patch?.body as Record<string, unknown>).data_type, undefined, "the data type is never sent on an update");
});

test("a team's members are data: a member added in the UI is drift that apply removes, and declaring a new member is a loosening", async () => {
  const fake = fakeGithub();
  fake.objects.set(`/orgs/${ORG}/installations`, { total_count: 0, installations: [] });
  fake.collection(`/orgs/${ORG}/teams`, [{ name: "reviewers", privacy: "closed", description: "The reviewer role" }], "name");
  const context = contextOf(fake);
  // Someone added in the UI (or the creator GitHub adds to a team made through the API).
  await context.client.rest({ method: "PUT", path: `/orgs/${ORG}/teams/reviewers/memberships/somebody`, body: { role: "member" } });
  const declared = object("team", "reviewers", { name: "reviewers", privacy: "closed", description: "The reviewer role", members: [] }, { kind: "org" });
  const drift = entry(await forgePlan(context, [declared], []), "team", "reviewers");
  assert.equal(drift.action, "update");
  assert.equal(drift.loosening, undefined, "removing a member is never a loosening");
  await forgeApply(context, [declared], []);
  assert.equal(entry(await forgePlan(context, [declared], []), "team", "reviewers").action, "unchanged", "the member was removed");
  assert.ok(fake.requests.some((request) => request.method === "DELETE" && request.path === `/orgs/${ORG}/teams/reviewers/memberships/somebody`));
  // Declaring a member grants access: a loosening, applied only with its acknowledgement.
  const widened = object("team", "reviewers", { name: "reviewers", privacy: "closed", description: "The reviewer role", members: ["newcomer"] }, { kind: "org" });
  assert.deepEqual(entry(await forgePlan(context, [widened], []), "team", "reviewers").loosening, ['members [] -> ["newcomer"]']);
});

test("a security configuration's two features read back as GitHub answers them (advanced_security only, the per-feature fields null): the declared features match, and a change of either is drift", async () => {
  const fake = fakeGithub();
  fake.objects.set(`/orgs/${ORG}/installations`, { total_count: 0, installations: [] });
  const declared = { name: "baseline", code_security: "disabled", secret_protection: "enabled", secret_scanning: "enabled" };
  // GitHub's read: advanced_security "secret_protection" (Secret Protection on, Code Security off); code_security and secret_protection null.
  fake.collection(`/orgs/${ORG}/code-security/configurations`, [{ id: 31, name: "baseline", advanced_security: "secret_protection", code_security: null, secret_protection: null, secret_scanning: "enabled" }], "id");
  const object_ = object("security-configuration", "baseline", declared, { kind: "org" });
  assert.equal(entry(await forgePlan(contextOf(fake), [object_], []), "security-configuration", "baseline").action, "unchanged");
  // GitHub reading both features enabled: Code Security differs from the declaration.
  const both = fakeGithub();
  both.objects.set(`/orgs/${ORG}/installations`, { total_count: 0, installations: [] });
  both.collection(`/orgs/${ORG}/code-security/configurations`, [{ id: 31, name: "baseline", advanced_security: "enabled", code_security: null, secret_protection: null, secret_scanning: "enabled" }], "id");
  assert.deepEqual(entry(await forgePlan(contextOf(both), [object_], []), "security-configuration", "baseline").differences, ["/code_security"]);
  // Every direction is drift, for each feature. A feature GitHub reads OFF while declared ON is a tightening to apply; one
  // read ON while declared OFF is drift too (and turning it off would be the loosening, judged by the strictness order).
  for (const [advanced, declaredFeatures, differing] of [
    ["disabled", { code_security: "disabled", secret_protection: "enabled" }, ["/secret_protection"]],
    ["secret_protection", { code_security: "disabled", secret_protection: "disabled" }, ["/secret_protection"]],
    ["code_security", { code_security: "disabled", secret_protection: "enabled" }, ["/code_security", "/secret_protection"]],
    ["disabled", { code_security: "enabled", secret_protection: "disabled" }, ["/code_security"]],
  ] as const) {
    const live = fakeGithub();
    live.objects.set(`/orgs/${ORG}/installations`, { total_count: 0, installations: [] });
    live.collection(`/orgs/${ORG}/code-security/configurations`, [{ id: 31, name: "baseline", advanced_security: advanced, code_security: null, secret_protection: null, secret_scanning: "enabled" }], "id");
    const planned = entry(await forgePlan(contextOf(live), [object("security-configuration", "baseline", { ...declared, ...declaredFeatures }, { kind: "org" })], []), "security-configuration", "baseline");
    assert.equal(planned.action, "update", `${advanced} vs ${JSON.stringify(declaredFeatures)}`);
    assert.deepEqual([...(planned.differences ?? [])].sort(), differing, `${advanced} vs ${JSON.stringify(declaredFeatures)}`);
    // Declared on, read off: a tightening, never a loosening.
    if (advanced === "disabled" && declaredFeatures.secret_protection === "enabled") assert.equal(planned.loosening, undefined, "turning Secret Protection on is a tightening");
  }
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
      protection_rules: body.reviewers === undefined ? [] : [{ type: "required_reviewers", prevent_self_review: body.prevent_self_review === true, reviewers: body.reviewers.map((reviewer) => ({ type: reviewer.type, reviewer: { id: reviewer.id } })) }] };
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
  // A new project carries GitHub's own default fields (as GitHub creates them): the forge declares none of them but Status.
  const builtIn = [["Title", "TITLE"], ["Assignees", "ASSIGNEES"], ["Labels", "LABELS"], ["Linked pull requests", "LINKED_PULL_REQUESTS"], ["Milestone", "MILESTONE"], ["Repository", "REPOSITORY"], ["Reviewers", "REVIEWERS"], ["Parent issue", "PARENT_ISSUE"], ["Sub-issues progress", "SUB_ISSUES_PROGRESS"]]
    .map(([name, dataType], index) => ({ id: `F_builtin_${String(index)}`, name: name!, dataType: dataType! }));
  const project = { id: "PVT_1", title: "", public: false, created: false, fields: [...builtIn, { id: "F_status", name: "Status", dataType: "SINGLE_SELECT", options: [{ name: "Todo" }] }] as { id: string; name: string; dataType: string; options?: { name: string }[] }[] };
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
  assert.equal(outcome.verified, true);
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
  assert.deepEqual(outcome.movedLoosening, [`ruleset:${REPO}:trunk`]);
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
  await assert.rejects(forgeApply(context, weakened, []), (error: unknown) => isForgeError(error, "forge_loosening_unacknowledged") && error.message.includes(`ruleset:${REPO}:trunk`));
  assert.ok(!fake.requests.some((request) => request.method !== "GET"), "nothing was written, the baseline included");
  const outcome = await forgeApply(context, weakened, [], new Set([`ruleset:${REPO}:trunk`]));
  assert.equal(outcome.acceptedLoosening[0]?.id, `ruleset:${REPO}:trunk`);
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
  await assert.rejects(forgeApply(context, objects, [], new Set([`custom-property-values:${REPO}:kind`])),
    (error: unknown) => isForgeError(error, "forge_tighten_unverified") && /does not include kind tool/u.test(error.message) && error.message.includes(`ruleset:${REPO}:trunk`));
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
  assert.deepEqual(looseningOf("repository-settings", { has_wiki: true, allow_auto_merge: true }, { has_wiki: false, allow_auto_merge: false }), []);
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
  named(unmet({ bypass_actors: [{ actor_id: 8, actor_type: "Integration", bypass_mode: "always" }] }), /lets \{"actor_id":8,"actor_type":"Integration","bypass_mode":"always"\} bypass/u);
  named(unmet({}, "trunk", ["adds bypass {}"]), /is not a rule a baseline carries/u);
  named(unmet({ rules: [{ type: "deletion" }] }), /has no pull_request rule/u);
  named(unmet({ rules: [{ type: "deletion" }, { type: "pull_request", parameters: { required_approving_review_count: 0, dismiss_stale_reviews_on_push: true } }] }), /pull_request rule is weaker: weakens rule pull_request: required_approving_review_count 1 -> 0/u);
  named(movedPremisesUnmet(reasons, { ...repo, rules: [{ type: "deletion" }] }, baseline, "trunk"), /has no pull_request rule to move/u);
  named(movedPremisesUnmet(reasons, { ...repo, conditions: {} }, baseline, "trunk"), /names no refs/u);
  // Near misses that hold: `~ALL` covers any ref, and the baseline's bypass actor is one the ruleset already has.
  assert.deepEqual(unmet({ conditions: { ...baseline.conditions, ref_name: { include: ["~ALL"], exclude: [] } }, bypass_actors: [repo.bypass_actors[0]] }), []);
});

test("the CLI door: plan, audit and apply through runForgeCli, a stale tree and a malformed request refused before GitHub is asked, a loosening accepted by its flag", async () => {
  // A checkout of its own: the community sources the generated files read, and those files generated for the test section.
  const top = createTempDir("forge-cli-");
  execFileSync("git", ["init", "-q"], { cwd: top });
  mkdirSync(join(top, "docs/community"), { recursive: true });
  for (const file of ["intake.json", "roles.json"]) copyFileSync(join(import.meta.dirname, "../../../docs/community", file), join(top, "docs/community", file));
  // The lockfiles the section's Dependabot entries name (`/` and `/engine`), tracked.
  mkdirSync(join(top, "engine"));
  for (const lockfile of ["package-lock.json", "engine/package-lock.json"]) writeFileSync(join(top, lockfile), "{}\n");
  // One workflow (the section declares the github-actions ecosystem), pinning one third-party action.
  mkdirSync(join(top, ".github/workflows"), { recursive: true });
  writeFileSync(join(top, ".github/workflows/ci.yml"), "on: push\njobs:\n  scan:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ossf/scorecard-action@0123456789abcdef0123456789abcdef01234567\n");
  execFileSync("git", ["add", "package-lock.json", "engine/package-lock.json", ".github/workflows/ci.yml"], { cwd: top });
  syncForgeFiles(top, forgeFileSources(top, SETTINGS), true);
  const fake = wholeGithub();
  const wiring = { settings: () => SETTINGS, endpoint: () => fake.endpoint(), keyHome: () => temporaryKeyHome(), maintainerCli: () => assert.fail("plan, apply and audit never run gh"), appsPage: () => assert.fail("plan, apply and audit serve no page") };
  const progress: string[] = [];
  const run = (...argv: string[]) => runForgeCli(top, argv, (line) => progress.push(line), wiring);
  const variable = "FORGE_CLI_TEST_TOKEN";
  process.env[variable] = fake.userToken("maintainer");
  try {
    const writes = () => fake.requests.filter((request) => request.method !== "GET" && request.path !== "/graphql").length;
    // Malformed: no credential, two, a bad variable name, an acknowledgement outside apply. Refused typed, nothing asked.
    for (const argv of [["plan"], ["plan", "--token-env", variable, "--token-stdin"], ["plan", "--token-env", "lower-case"], ["audit", "--accept-loosening", "ruleset:x:y", "--token-env", variable], ["settle"]]) {
      await assert.rejects(run(...argv), (error: unknown) => isForgeError(error, "forge_usage"), argv.join(" "));
    }
    assert.equal(fake.requests.length, 0, "a malformed request never reaches GitHub");
    const planned = await run("plan", "--token-env", variable);
    assert.equal(planned.result.status, "pass");
    assert.ok((planned.result.result as { counts: { create: number } }).counts.create > 30);
    assert.equal((await run("audit", "--token-env", variable)).result.status, "fail", "a fresh organisation is drift");
    assert.equal(writes(), 0, "plan and audit write nothing");
    const applied = await run("apply", "--token-env", variable);
    assert.equal(applied.result.status, "pass");
    assert.deepEqual((applied.result.result as { verification: { drift: unknown[] } }).verification.drift, []);
    assert.equal((await run("audit", "--token-env", variable)).result.status, "pass");
    // A retired ruleset reappears: the apply refuses until its id is accepted by the flag, and the receipt names it.
    (fake.objects.get(`/repos/${ORG}/${REPO}/rulesets`) as Record<string, unknown>[]).push({ id: 4242, name: "protect-release-tags", source_type: "Repository", target: "tag", enforcement: "active", rules: [] });
    fake.objects.set(`/repos/${ORG}/${REPO}/rulesets/4242`, (fake.objects.get(`/repos/${ORG}/${REPO}/rulesets`) as Record<string, unknown>[]).at(-1));
    await assert.rejects(run("apply", "--token-env", variable), (error: unknown) => isForgeError(error, "forge_loosening_unacknowledged"));
    const accepted = await run("apply", "--accept-loosening", `ruleset:${REPO}:protect-release-tags`, "--token-env", variable);
    assert.equal(accepted.result.status, "pass");
    assert.deepEqual((accepted.result.result as { acceptedLoosening: { id: string }[] }).acceptedLoosening.map((entry) => entry.id), [`ruleset:${REPO}:protect-release-tags`]);
    // A planted drift the apply cannot remove (a write GitHub answers but ignores): the apply's verdict is its post-apply audit, so it FAILS.
    fake.route("PATCH", /^\/repos\/[^/]+\/[^/]+\/labels\/[^/]+$/u, () => ({ status: 200, body: {} }));
    const label = (fake.objects.get(`/repos/${ORG}/${REPO}/labels`) as Record<string, unknown>[]).find((candidate) => candidate.name === "area:engine")!;
    label.color = "000000";
    const unconverged = await run("apply", "--token-env", variable);
    assert.equal(unconverged.result.status, "fail");
    const verdict = unconverged.result.result as { verified: boolean; verification: { drift: { action: string; key: string }[] } };
    assert.equal(verdict.verified, false);
    assert.deepEqual(verdict.verification.drift.map((drift) => `${drift.action} ${drift.key}`), ["update area:engine"]);
    // The Apps verbs go through the same wiring: the manifests check reads the wired section, and apps create asks the
    // WIRED gh (here a recording one): not logged in is refused typed; logged in but without the door's environment too.
    assert.equal((await run("apps", "manifests", "--check")).result.status, "pass");
    const ghCalls: string[][] = [];
    const recordingGh = (answer: (args: readonly string[]) => Readonly<{ status: number; stdout?: string; stderr?: string }>) => (settings: typeof SETTINGS) => maintainerCli(settings.webUrl, settings.maintainerCli, async (args) => {
      ghCalls.push([...args]);
      const reply = answer(args);
      return { status: reply.status, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "", missing: false, ending: "exited" as const };
    });
    const notLoggedIn = { ...wiring, maintainerCli: recordingGh(() => ({ status: 1, stderr: "not logged in" })) };
    await assert.rejects(runForgeCli(top, ["apps", "create"], () => {}, notLoggedIn), (error: unknown) => isForgeError(error, "forge_maintainer_cli_failed"));
    assert.deepEqual(ghCalls.map((args) => args.slice(0, 2).join(" ")), ["auth status"], "the wired gh, and nothing else, was asked");
    const noDoor = { ...wiring, maintainerCli: recordingGh((args) => args[0] === "auth" ? { status: 0 } : { status: 1, stderr: "gh: Not Found (HTTP 404)" }) };
    await assert.rejects(runForgeCli(top, ["apps", "create"], () => {}, noDoor), (error: unknown) => isForgeError(error, "forge_environment_missing") && error.message.includes(REPO));
    // Every input of apps create is the WIRED one: a section whose trunk has a name the configuration never uses, the
    // wired endpoint and key home handed to the page (recorded, not served), and the wired gh asked about that trunk.
    const wiredSettings = { ...SETTINGS, repositories: SETTINGS.repositories.map((repository) => repository.kind === "trunk" ? { ...repository, name: "wired-trunk" } : repository) };
    const wiredEndpoint = fake.endpoint();
    const wiredKeyHome = temporaryKeyHome();
    let handed: Readonly<{ settings: unknown; endpoint: unknown; keyHome: unknown }> | undefined;
    ghCalls.length = 0;
    const allWired = {
      ...wiring,
      settings: () => wiredSettings,
      endpoint: () => wiredEndpoint,
      keyHome: () => wiredKeyHome,
      maintainerCli: recordingGh((args) => args[0] === "auth" ? { status: 0 } : { status: 0, stdout: `${String(args[3]).split("/").at(-1)}\n` }),
      appsPage: async (options: Readonly<{ settings: unknown; endpoint: unknown; keyHome: unknown }>) => {
        handed = options;
        return { url: "http://127.0.0.1:1/?t=recorded", done: Promise.resolve({ created: [], pending: [] }), close: async () => {} };
      },
    };
    const created = await runForgeCli(top, ["apps", "create"], () => {}, allWired);
    assert.equal(created.result.status, "pass");
    assert.ok(ghCalls.some((args) => args.includes("repos/LLM-4-People/wired-trunk/environments/door")), JSON.stringify(ghCalls));
    assert.ok(!ghCalls.some((args) => args.some((arg) => arg.includes(REPO))), "the configured trunk is never asked about");
    assert.equal(handed?.settings, wiredSettings, "the page gets the wired section");
    assert.equal(handed?.endpoint, wiredEndpoint, "the page gets the wired endpoint");
    assert.equal(handed?.keyHome, wiredKeyHome, "the page gets the wired key home");
    // And a bypass of the wired gh cannot hang: under test the real gh is refused at once, typed.
    await assert.rejects(maintainerCli(SETTINGS.webUrl, SETTINGS.maintainerCli).ready(), (error: unknown) => isForgeError(error, "forge_maintainer_cli_failed") && error.facts.underTest === true);
    // A hand edit of a generated file: refused before the credential is read or GitHub is asked.
    writeFileSync(join(top, `.github/forge/label/${REPO}.area_ci.json`), "{}\n");
    const asked = fake.requests.length;
    await assert.rejects(run("plan", "--token-env", variable), (error: unknown) => isForgeError(error, "forge_declaration_invalid") && error.message.includes(`label/${REPO}.area_ci.json`));
    assert.equal(fake.requests.length, asked);
  } finally {
    delete process.env[variable];
  }
});

/** A stateful Pages API for `repository` on the fake: GitHub's answers, its domain verification and its certificate. */
function pagesApi(fake: FakeGithub, repository: string, world: { domainState: string; certificate: string | null; restore?: "ignored" | "fails" }) {
  const path = `/repos/${ORG}/${repository}/pages`;
  let site: Record<string, unknown> | undefined;
  const answer = () => site === undefined ? { status: 404, body: { message: "Not Found" } } : { status: 200, body: { ...site, ...(typeof site.cname === "string" ? { protected_domain_state: world.domainState, https_certificate: world.certificate === null ? null : { state: world.certificate } } : { protected_domain_state: null }) } };
  // One fixed pattern for every repository's Pages endpoint; each route answers only its own exact path (no pattern built from a name).
  const pages = /^\/repos\/[^/]+\/[^/]+\/pages$/u;
  fake.route("GET", pages, (request) => request.path === path ? answer() : undefined);
  fake.route("POST", pages, (request) => {
    if (request.path !== path) return undefined;
    const body = request.body as Record<string, unknown>;
    site = { build_type: body.build_type, ...(body.source === undefined ? {} : { source: body.source }), cname: null, https_enforced: true };
    return { status: 201, body: site };
  });
  fake.route("PUT", pages, (request) => {
    if (request.path !== path) return undefined;
    const body = request.body as Record<string, unknown>;
    if (site === undefined) return { status: 404, body: { message: "Not Found" } };
    // A restore (the domain put back to what it was before) that GitHub ignores, or refuses.
    const restoring = Object.keys(body).length === 1 && "cname" in body && body.cname !== site.cname;
    if (restoring && typeof site.cname === "string" && world.restore === "ignored") return { status: 204 };
    if (restoring && typeof site.cname === "string" && world.restore === "fails") return { status: 500, body: { message: "Server Error" } };
    if ("cname" in body && body.cname !== site.cname) site = { ...site, cname: body.cname, https_enforced: body.cname === null ? site.https_enforced : false };
    if ("https_enforced" in body) {
      if (typeof site.cname === "string" && world.certificate !== "approved") return { status: 404, body: { message: "The certificate does not exist yet" } };
      site = { ...site, https_enforced: body.https_enforced };
    }
    for (const field of ["build_type", "source"]) if (field in body) site = { ...site, [field]: body[field] };
    return { status: 204 };
  });
  return { set: (value: Record<string, unknown>) => { site = value; }, get: () => site };
}

test("a Pages site (W2): created built its declared way; a custom domain set, its HTTPS pending until the certificate is approved (never drift, never a failure), then enforced", async () => {
  const fake = fakeGithub();
  fake.objects.set(`/orgs/${ORG}/installations`, { total_count: 0, installations: [] });
  const world = { domainState: "verified", certificate: "new" };
  const proving = pagesApi(fake, "forge-proving-ground", world);
  const trunk = pagesApi(fake, REPO, world);
  trunk.set({ build_type: "workflow", cname: null, https_enforced: true });
  const objects = [
    object("pages", "forge-proving-ground", { build_type: "workflow", cname: null, https_enforced: true }, { kind: "repo", repository: "forge-proving-ground" }),
    object("pages", REPO, { build_type: "workflow", cname: "bridlewise.llm4people.dev", https_enforced: true }),
  ];
  const context = contextOf(fake);
  const plan = await forgePlan(context, objects, []);
  assert.equal(entry(plan, "pages", "forge-proving-ground").action, "create");
  assert.deepEqual(entry(plan, "pages", REPO).differences, ["/cname"], "the trunk's plan: cname null → host");
  const outcome = await forgeApply(context, objects, []);
  // The proving ground: POST, then PUT (build_type under workflow), then HTTPS.
  const provingWrites = fake.requests.filter((request) => request.path === `/repos/${ORG}/forge-proving-ground/pages` && request.method !== "GET");
  assert.deepEqual(provingWrites.map((request) => [request.method, request.body]), [["POST", { build_type: "workflow" }], ["PUT", { build_type: "workflow", cname: null }], ["PUT", { https_enforced: true }]]);
  assert.equal(proving.get()?.https_enforced, true);
  // The trunk: its domain set and verified; HTTPS waits for the certificate, reported pending, and the apply verified.
  assert.equal(trunk.get()?.cname, "bridlewise.llm4people.dev");
  assert.equal(outcome.verified, true, "a pending certificate is not drift");
  const waiting = entry(await forgePlan(context, objects, []), "pages", REPO);
  assert.equal(waiting.action, "pending");
  assert.match(waiting.pending?.[0] ?? "", /https_enforced: the certificate for bridlewise\.llm4people\.dev is new/u);
  // The certificate approved: HTTPS is enforced on the next apply, and nothing is left.
  world.certificate = "approved";
  assert.deepEqual(entry(await forgePlan(context, objects, []), "pages", REPO).differences, ["/https_enforced"]);
  await forgeApply(context, objects, []);
  assert.equal(entry(await forgePlan(context, objects, []), "pages", REPO).action, "unchanged");
});

test("a custom domain GitHub does not hold as verified is refused, typed, and the previous domain restored; the organisation site's domain is strictly none", async () => {
  const fake = fakeGithub();
  fake.objects.set(`/orgs/${ORG}/installations`, { total_count: 0, installations: [] });
  const world: { domainState: string; certificate: string | null } = { domainState: "unverified", certificate: "new" };
  const trunk = pagesApi(fake, REPO, world);
  trunk.set({ build_type: "workflow", cname: null, https_enforced: true });
  const declared = [object("pages", REPO, { build_type: "workflow", cname: "bridlewise.llm4people.dev", https_enforced: true })];
  await assert.rejects(forgeApply(contextOf(fake), declared, []), (error: unknown) => isForgeError(error, "forge_pages_domain_unverified") && /bridlewise\.llm4people\.dev/u.test(error.message));
  assert.equal(trunk.get()?.cname, null, "the previous domain (none) is restored");
  // The organisation site: a VERIFIED domain set on it is drift whose removal is a named loosening, never a quiet change.
  const orgSite = pagesApi(fake, "LLM-4-People.github.io", { domainState: "verified", certificate: "approved" });
  orgSite.set({ build_type: "legacy", source: { branch: "main", path: "/" }, cname: "someone.example", https_enforced: true });
  const site = entry(await forgePlan(contextOf(fake), [object("pages", "LLM-4-People.github.io", { build_type: "legacy", source: { branch: "main", path: "/" }, cname: null, https_enforced: true }, { kind: "repo", repository: "LLM-4-People.github.io" })], []), "pages", "LLM-4-People.github.io");
  assert.deepEqual(site.differences, ["/cname"]);
  assert.ok((site.loosening ?? []).length > 0, "removing a domain is a loosening the plan names");
});

test("a custom domain a site HOLDS unverified is a typed refusal in plan and audit, even when it is the declared one, never unchanged", async () => {
  const fake = fakeGithub();
  fake.objects.set(`/orgs/${ORG}/installations`, { total_count: 0, installations: [] });
  const trunk = pagesApi(fake, REPO, { domainState: "unverified", certificate: "approved" });
  trunk.set({ build_type: "workflow", cname: "bridlewise.llm4people.dev", https_enforced: true });
  const declared = [object("pages", REPO, { build_type: "workflow", cname: "bridlewise.llm4people.dev", https_enforced: true })];
  const plan = await forgePlan(contextOf(fake), declared, []);
  assert.equal(entry(plan, "pages", REPO).action, "refused");
  assert.equal(entry(plan, "pages", REPO).code, "forge_pages_domain_unverified");
  assert.ok(plan.drift.some((drifted) => drifted.kind === "pages"), "the audit fails on it");
  assert.equal(plan.complete, false, "an apply refuses before any write");
});

test("a restore that fails or does not hold is a loud typed failure, never a quiet refusal that leaves the unverified domain", async () => {
  for (const restore of ["ignored", "fails"] as const) {
    const fake = fakeGithub();
    fake.objects.set(`/orgs/${ORG}/installations`, { total_count: 0, installations: [] });
    const trunk = pagesApi(fake, REPO, { domainState: "unverified", certificate: "new", restore });
    trunk.set({ build_type: "workflow", cname: null, https_enforced: true });
    const declared = [object("pages", REPO, { build_type: "workflow", cname: "bridlewise.llm4people.dev", https_enforced: true })];
    await assert.rejects(forgeApply(contextOf(fake), declared, []), (error: unknown) => isForgeError(error, "forge_pages_domain_restore_failed") && error.forgeClass === "integrity", restore);
    // What GitHub now holds is refused by every later plan and audit, too.
    assert.equal(entry(await forgePlan(contextOf(fake), declared, []), "pages", REPO).code, "forge_pages_domain_unverified", restore);
  }
});

test("only a certificate GitHub is still issuing leaves HTTPS pending; a failed, revoked or absent one is a typed refusal that fails the audit", async () => {
  for (const [certificate, expected] of [
    ["authorization_pending", "pending"], ["issued", "pending"], ["approved", "unchanged"],
    ["errored", "refused"], ["bad_authz", "refused"], ["authorization_revoked", "refused"], ["destroy_pending", "refused"], ["dns_changed", "refused"], [null, "refused"],
  ] as const) {
    const fake = fakeGithub();
    fake.objects.set(`/orgs/${ORG}/installations`, { total_count: 0, installations: [] });
    const trunk = pagesApi(fake, REPO, { domainState: "verified", certificate });
    trunk.set({ build_type: "workflow", cname: "bridlewise.llm4people.dev", https_enforced: certificate === "approved" });
    const plan = await forgePlan(contextOf(fake), [object("pages", REPO, { build_type: "workflow", cname: "bridlewise.llm4people.dev", https_enforced: true })], []);
    const planned = entry(plan, "pages", REPO);
    assert.equal(planned.action, expected, String(certificate));
    if (expected === "refused") {
      assert.equal(planned.code, "forge_pages_certificate_failed", String(certificate));
      assert.ok(plan.drift.length > 0, `${String(certificate)}: the audit fails`);
    } else {
      assert.equal(plan.drift.length, 0, String(certificate));
    }
  }
});

test("an App installed on a repository: added to its installation when missing; an App the organisation does not have is refused, typed", async () => {
  const fake = fakeGithub();
  fake.objects.set(`/repos/${ORG}/LLM-4-People.github.io`, { name: "LLM-4-People.github.io" });
  const repositories: string[] = [REPO];
  fake.objects.set(`/orgs/${ORG}/installations`, { total_count: 1, installations: [{ id: 73, app_id: 1003, app_slug: "bridlewise-publisher", repository_selection: "selected" }] });
  fake.route("GET", /^\/user\/installations\/73\/repositories$/u, () => ({ status: 200, body: { total_count: repositories.length, repositories: repositories.map((name) => ({ name })) } }));
  fake.route("PUT", /^\/user\/installations\/73\/repositories\/(\d+)$/u, () => { repositories.push("LLM-4-People.github.io"); return { status: 204 }; });
  const installed = object("app-installation", "publisher", { installed: true }, { kind: "repo", repository: "LLM-4-People.github.io" });
  const context = contextOf(fake);
  assert.deepEqual(entry(await forgePlan(context, [installed], []), "app-installation", "publisher").differences, ["/installed"]);
  await forgeApply(context, [installed], []);
  assert.ok(fake.requests.some((request) => request.method === "PUT" && /^\/user\/installations\/73\/repositories\/\d+$/u.test(request.path)));
  assert.equal(entry(await forgePlan(context, [installed], []), "app-installation", "publisher").action, "unchanged");
  // No publisher installation on the organisation at all: refused, typed.
  fake.objects.set(`/orgs/${ORG}/installations`, { total_count: 0, installations: [] });
  const refused = entry(await forgePlan(context, [installed], []), "app-installation", "publisher");
  assert.equal(refused.code, "forge_app_installation_missing");
});
test("the public configuration GitHub holds (advanced_security enabled, read back as both features on) plans no loosening: Code Security stays on, and only declared tightenings differ", async () => {
  const fake = fakeGithub();
  fake.objects.set(`/orgs/${ORG}/installations`, { total_count: 0, installations: [] });
  // GitHub's answer for the live public configuration, as the 2026-10-28 apply left it (configuration 288622).
  const live = {
    id: 288622, name: "bridlewise-baseline", description: "GENERATED by harness sync from engine/src/workflow/forge/declarations.ts", advanced_security: "enabled", code_security: null, secret_protection: null,
    code_scanning_default_setup: "not_set", code_scanning_default_setup_options: { runner_label: null, runner_type: "not_set" },
    code_scanning_delegated_alert_dismissal: "disabled", dependabot_alerts: "enabled", dependabot_delegated_alert_dismissal: "disabled",
    dependabot_security_updates: "enabled", dependency_graph: "enabled", dependency_graph_autosubmit_action: "disabled",
    enforcement: "enforced", private_vulnerability_reporting: "enabled", secret_scanning: "enabled",
    secret_scanning_delegated_alert_dismissal: "disabled", secret_scanning_delegated_bypass: "disabled", secret_scanning_extended_metadata: "disabled",
    secret_scanning_generic_secrets: "disabled", secret_scanning_generic_secrets_push_protection: "disabled", secret_scanning_non_provider_patterns: "disabled",
    secret_scanning_push_protection: "enabled", secret_scanning_validity_checks: "disabled",
  };
  fake.collection(`/orgs/${ORG}/code-security/configurations`, [live], "id");
  const declared = forgeDeclarations(SOURCES).find((entry) => entry.kind === "security-configuration" && entry.key === "bridlewise-baseline")!;
  const planned = entry(await forgePlan(contextOf(fake), [declared], []), "security-configuration", "bridlewise-baseline");
  assert.equal(planned.loosening, undefined, `no loosening: ${JSON.stringify(planned.loosening)}`);
  assert.ok(!(planned.differences ?? []).includes("/code_security"), "Code Security on, as GitHub holds it");
  assert.ok(!(planned.differences ?? []).includes("/secret_protection"));
  // What differs is declared work only: default setup pinned disabled, and Secret Protection's refinements turned on.
  for (const difference of planned.differences ?? []) {
    assert.ok(difference === "/code_scanning_default_setup" || difference.startsWith("/secret_scanning_"), difference);
  }
});

test("a repository setting the organisation enforces: a contradicting declaration is refused at PLAN time, and a field GitHub locks (commit sign-off) is never written, even unchanged", async () => {
  const world = (orgSignoff: boolean | undefined): FakeGithub => {
    const fake = fakeGithub();
    fake.objects.set(`/orgs/${ORG}/installations`, { total_count: 0, installations: [] });
    fake.objects.set(`/orgs/${ORG}`, { login: ORG, ...(orgSignoff === undefined ? {} : { web_commit_signoff_required: orgSignoff }) });
    fake.objects.set(`/repos/${ORG}/${REPO}`, { name: REPO, merge_commit_title: "MERGE_MESSAGE", web_commit_signoff_required: true });
    // GitHub refuses ANY repository write of the field while the organisation enforces it (2026-10-28, request 45ED:218A39).
    fake.route("PATCH", new RegExp(`^/repos/${ORG}/${REPO}$`, "u"), (request) => {
      const enforced = (fake.objects.get(`/orgs/${ORG}`) as Record<string, unknown>).web_commit_signoff_required === true;
      return enforced && "web_commit_signoff_required" in (request.body as object) ? { status: 422, body: { message: "Commit signoff is enforced by the organization and cannot be disabled" } } : undefined;
    });
    return fake;
  };
  const settings = (signoff: boolean): ForgeObject => object("repository-settings", REPO, { merge_commit_title: "PR_TITLE", web_commit_signoff_required: signoff });
  // Enforced by the organisation, declared true: planned without the field, written without it, and the apply verifies.
  const enforced = world(true);
  const planned = entry(await forgePlan(contextOf(enforced), [settings(true)], []), "repository-settings", REPO);
  assert.deepEqual(planned.differences, ["/merge_commit_title"]);
  const outcome = await forgeApply(contextOf(enforced), [settings(true)], []);
  assert.equal(outcome.verified, true);
  const patch = enforced.requests.find((request) => request.method === "PATCH" && request.path === `/repos/${ORG}/${REPO}`);
  assert.ok(patch !== undefined && !("web_commit_signoff_required" in (patch.body as object)), "the locked field is never sent");
  // Declared against the organisation: refused at plan time, typed, and an apply writes nothing.
  const contradicted = world(true);
  const refused = entry(await forgePlan(contextOf(contradicted), [settings(false)], []), "repository-settings", REPO);
  assert.equal(refused.code, "forge_org_policy_contradicted");
  assert.match(refused.message ?? "", /web_commit_signoff_required false \(the organisation's web_commit_signoff_required is true\)/u);
  await assert.rejects(forgeApply(contextOf(contradicted), [settings(false)], []), (error: unknown) => isForgeError(error, "forge_plan_incomplete"));
  assert.ok(!contradicted.requests.some((request) => request.method !== "GET"), "nothing written");
  // The organisation does not enforce it YET, but the declared org settings do: the apply turns it on first, so the
  // repository write leaves the field out too.
  const turnedOn = world(false);
  const objects = [object("org-settings", ORG, { web_commit_signoff_required: true }, { kind: "org" }), settings(true)];
  await forgeApply(contextOf(turnedOn), objects, []);
  const repositoryPatch = turnedOn.requests.find((request) => request.method === "PATCH" && request.path === `/repos/${ORG}/${REPO}`);
  assert.ok(repositoryPatch !== undefined && !("web_commit_signoff_required" in (repositoryPatch.body as object)));
});

test("every organisation policy over a declared repository setting is judged at plan time: a weaker repository value is refused, an equal or stricter one passes", async () => {
  const cases: readonly (readonly [string, ForgeObject["kind"], Record<string, unknown>, string, Record<string, unknown>, boolean])[] = [
    ["Actions off", "actions-permissions", { enabled: true }, "actions/permissions", { enabled_repositories: "none" }, true],
    ["an allowed-actions value the forge does not know", "actions-permissions", { allowed_actions: "selected" }, "actions/permissions", { allowed_actions: "enterprise_only" }, true],
    ["a fork-approval value the forge does not know", "actions-fork-approval", { approval_policy: "first_time_contributors" }, "actions/permissions/fork-pr-contributor-approval", { approval_policy: "new_policy" }, true],
    ["all actions under selected", "actions-permissions", { allowed_actions: "all" }, "actions/permissions", { allowed_actions: "selected" }, true],
    ["selected actions under all", "actions-permissions", { allowed_actions: "selected" }, "actions/permissions", { allowed_actions: "all" }, false],
    ["no SHA pinning under pinning", "actions-permissions", { sha_pinning_required: false }, "actions/permissions", { sha_pinning_required: true }, true],
    ["SHA pinning under none", "actions-permissions", { sha_pinning_required: true }, "actions/permissions", { sha_pinning_required: false }, false],
    ["a write token under read", "actions-workflow", { default_workflow_permissions: "write" }, "actions/permissions/workflow", { default_workflow_permissions: "read" }, true],
    ["approving under no approving", "actions-workflow", { can_approve_pull_request_reviews: true }, "actions/permissions/workflow", { can_approve_pull_request_reviews: false }, true],
    ["read under read", "actions-workflow", { default_workflow_permissions: "read", can_approve_pull_request_reviews: false }, "actions/permissions/workflow", { default_workflow_permissions: "read", can_approve_pull_request_reviews: false }, false],
    ["a weaker fork approval", "actions-fork-approval", { approval_policy: "first_time_contributors_new_to_github" }, "actions/permissions/fork-pr-contributor-approval", { approval_policy: "first_time_contributors" }, true],
    ["a stricter fork approval", "actions-fork-approval", { approval_policy: "all_external_contributors" }, "actions/permissions/fork-pr-contributor-approval", { approval_policy: "first_time_contributors" }, false],
    ["mutable releases under enforcement", "immutable-releases", { enabled: false }, "settings/immutable-releases", { enforced_repositories: "all" }, true],
    ["immutable releases under none", "immutable-releases", { enabled: true }, "settings/immutable-releases", { enforced_repositories: "none" }, false],
  ];
  for (const [name, kind, desired, orgPath, orgAnswer, refusedExpected] of cases) {
    const fake = fakeGithub();
    fake.objects.set(`/orgs/${ORG}/installations`, { total_count: 0, installations: [] });
    fake.objects.set(`/orgs/${ORG}/${orgPath}`, orgAnswer);
    const planned = entry(await forgePlan(contextOf(fake), [object(kind, REPO, desired)], []), kind, REPO);
    assert.equal(planned.code === "forge_org_policy_contradicted", refusedExpected, `${name}: ${planned.action} ${planned.code ?? ""}`);
  }
  // Actions enabled for SELECTED repositories only: a repository outside the selection with Actions declared on is refused.
  for (const [selection, refusedExpected] of [[[REPO, "other"], false], [["other"], true]] as const) {
    const fake = fakeGithub();
    fake.objects.set(`/orgs/${ORG}/installations`, { total_count: 0, installations: [] });
    fake.objects.set(`/orgs/${ORG}/actions/permissions`, { enabled_repositories: "selected", allowed_actions: "all" });
    fake.objects.set(`/orgs/${ORG}/actions/permissions/repositories`, { total_count: selection.length, repositories: selection.map((name) => ({ name })) });
    const planned = entry(await forgePlan(contextOf(fake), [object("actions-permissions", REPO, { enabled: true })], []), "actions-permissions", REPO);
    assert.equal(planned.code === "forge_org_policy_contradicted", refusedExpected, selection.join(","));
  }
});

test("only an enablement still in progress is deferred: any other write error (a 422, a 409 whose states read settled) surfaces at once, and no later object is written", async () => {
  for (const failure of ["422", "409 settled"] as const) {
    const fake = fakeGithub();
    fake.objects.set(`/orgs/${ORG}/installations`, { total_count: 0, installations: [] });
    fake.collection(`/orgs/${ORG}/code-security/configurations`, [{ id: 31, name: "baseline", secret_scanning: "disabled" }], "id");
    fake.route("GET", /^\/orgs\/[^/]+\/code-security\/configurations\/31\/repositories$/u, () => ({ status: 200, body: [{ status: "enforced", repository: { id: 7, name: REPO } }] }));
    fake.route("PATCH", /^\/orgs\/[^/]+\/code-security\/configurations\/31$/u, () => (failure === "422"
      ? { status: 422, body: { message: "Validation Failed" } }
      : { status: 409, body: { message: "Conflict" } }));
    const later: string[] = [];
    fake.route("PUT", /\/immutable-releases$/u, () => { later.push("written"); return undefined; });
    const objects = [
      object("security-configuration", "baseline", { name: "baseline", secret_scanning: "enabled" }, { kind: "org" }),
      object("immutable-releases", REPO, { enabled: true }),
    ];
    await assert.rejects(forgeApply(contextOf(fake), objects, []), (error: unknown) => isForgeError(error, failure === "422" ? "github_validation_failed" : "github_conflict"), failure);
    assert.deepEqual(later, [], `${failure}: surfaced at once, never deferred past a later write`);
  }
});

test("a security configuration GitHub is still rolling out is deferred past the other writes and continued only once its attachments read settled; still in progress, the run stops typed and retryable", async () => {
  for (const settles of [true, false]) {
    const fake = fakeGithub();
    fake.objects.set(`/orgs/${ORG}/installations`, { total_count: 0, installations: [] });
    fake.collection(`/orgs/${ORG}/code-security/configurations`, [{ id: 31, name: "baseline", code_security: "disabled", secret_protection: "disabled", secret_scanning: "disabled" }], "id");
    let status = "updating";
    const order: string[] = [];
    fake.route("GET", /^\/orgs\/[^/]+\/code-security\/configurations\/31\/repositories$/u, () => ({ status: 200, body: [{ status, repository: { id: 7, name: REPO } }] }));
    fake.route("PATCH", /^\/orgs\/[^/]+\/code-security\/configurations\/31$/u, () => { order.push("configuration"); return undefined; });
    // Another object's write: by then GitHub has (or has not) finished the rollout.
    fake.route("PUT", /\/immutable-releases$/u, () => { order.push("other"); if (settles) status = "enforced"; return undefined; });
    const objects = [
      object("security-configuration", "baseline", { name: "baseline", secret_scanning: "enabled" }, { kind: "org" }),
      object("immutable-releases", REPO, { enabled: true }),
    ];
    if (settles) {
      await forgeApply(contextOf(fake), objects, []);
      assert.deepEqual(order, ["other", "configuration"], "deferred past the other writes, then written once settled");
    } else {
      await assert.rejects(forgeApply(contextOf(fake), objects, []), (error: unknown) => isForgeError(error, "forge_security_enablement_in_progress") && error.forgeClass === "budget" && error.retryable && new RegExp(REPO, "u").test(error.message));
      assert.deepEqual(order, ["other"], "the configuration is never written while its rollout is in progress");
    }
  }
});

test("a 409 on a security configuration is judged by the attachment states read right after it: an enablement in progress is the typed refusal, any other conflict stays GitHub's", async () => {
  for (const rollingOut of [true, false]) {
    const fake = fakeGithub();
    fake.objects.set(`/orgs/${ORG}/installations`, { total_count: 0, installations: [] });
    fake.collection(`/orgs/${ORG}/code-security/configurations`, [{ id: 31, name: "baseline", secret_scanning: "disabled" }], "id");
    let status = "enforced";
    fake.route("GET", /^\/orgs\/[^/]+\/code-security\/configurations\/31\/repositories$/u, () => ({ status: 200, body: [{ status, repository: { id: 7, name: REPO } }] }));
    fake.route("PATCH", /^\/orgs\/[^/]+\/code-security\/configurations\/31$/u, () => { if (rollingOut) status = "updating"; return { status: 409, body: { message: "Another enablement event is in progress" } }; });
    const objects = [object("security-configuration", "baseline", { name: "baseline", secret_scanning: "enabled" }, { kind: "org" })];
    await assert.rejects(forgeApply(contextOf(fake), objects, []), (error: unknown) => isForgeError(error, rollingOut ? "forge_security_enablement_in_progress" : "github_conflict"), String(rollingOut));
  }
});
