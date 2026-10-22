/**
 * The forge's declarations (`declarations.ts`), the in-tree renders
 * (`repository-files.ts`) and the desired-state comparison (`forge-state.ts`):
 * pure functions of their owners, judged without GitHub.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { allowedActionPatterns, FORGE_ISSUE_TYPES, forgeDeclarations } from "../../src/workflow/forge/declarations.ts";
import { differences, referencesOf, resolveReferences, writableBody, type ForgeObject } from "../../src/workflow/forge/forge-state.ts";
import { codeownersFile, dependabotFile, forgeTreeFacts } from "../../src/workflow/forge/repository-files.ts";
import { isForgeError } from "../../src/workflow/forge/codes.ts";
import type { TreeReader } from "../../src/git/tree-reader.ts";
import { SETTINGS, SOURCES } from "./forge-settings.ts";

function find(objects: readonly ForgeObject[], kind: string, key: string): ForgeObject {
  const found = objects.find((entry) => entry.kind === kind && entry.key === key);
  assert.ok(found !== undefined, `${kind} ${key} is declared`);
  return found;
}

test("the declarations: every object once, in apply order, with the plan's unavailable fields and the registry's references", () => {
  const objects = forgeDeclarations(SOURCES);
  const files = objects.map((entry) => entry.file);
  assert.equal(new Set(files).size, files.length);
  // What a later object references exists first: the property before its values and the baseline, teams before their repository grants.
  const index = (kind: string, key: string): number => objects.indexOf(find(objects, kind, key));
  assert.ok(index("custom-property", "kind") < index("custom-property-values", "kind"));
  assert.ok(index("custom-property", "kind") < index("org-ruleset", "baseline"));
  assert.ok(index("team", "reviewers") < index("team-repository", "reviewers"));
  // The plan: Team without Secret Protection records the five add-on fields, never drops them from the file.
  const security = find(objects, "security-configuration", "bridlewise-baseline");
  assert.deepEqual([...security.unavailableOnPlan].sort(), ["secret_scanning_delegated_alert_dismissal", "secret_scanning_delegated_bypass", "secret_scanning_generic_secrets", "secret_scanning_non_provider_patterns", "secret_scanning_validity_checks"]);
  assert.equal((security.desired as Record<string, unknown>).secret_scanning_validity_checks, "enabled");
  assert.equal((writableBody(security, security.desired) as Record<string, unknown>).secret_scanning_validity_checks, undefined);
  // Every governed repository gets its settings; the archive never does; only public ones get fork approval and immutable releases.
  const settingsScopes = objects.filter((entry) => entry.kind === "repository-settings").map((entry) => entry.key);
  assert.deepEqual(settingsScopes, ["bridlewise-testing", ".github", "bridlewise-evidence", "bridlewise-coordination"]);
  assert.ok(!objects.some((entry) => entry.kind === "actions-fork-approval" && entry.key === "bridlewise-coordination"));
  assert.equal((find(objects, "repository-settings", "bridlewise-testing").desired as Record<string, unknown>).has_discussions, true);
  assert.equal((find(objects, "repository-settings", ".github").desired as Record<string, unknown>).has_discussions, false);
  // The allowed actions come from the workflows: third parties only, as owner/repo@*.
  assert.deepEqual((find(objects, "actions-selected", "bridlewise-testing").desired as { patterns_allowed: string[] }).patterns_allowed, ["ossf/scorecard-action@*"]);
  // References: the rulesets name Apps by role, the rotation environment the maintainer by login.
  assert.deepEqual(referencesOf(find(objects, "ruleset", "product").desired), [{ $ref: "app", name: "publisher" }]);
  assert.deepEqual(referencesOf(find(objects, "ruleset", "agent-branches").desired), [{ $ref: "app", name: "agent" }]);
  assert.deepEqual(referencesOf(find(objects, "environment", "rotation").desired), [{ $ref: "user", name: "amberflag48" }]);
  // Labels: one per area plus the declared ones; issue types: the registry, which holds every form's type.
  assert.ok(objects.some((entry) => entry.kind === "label" && entry.key === "area:engine"));
  assert.ok(objects.some((entry) => entry.kind === "label" && entry.key === "lane:gh-1"));
  for (const form of SOURCES.intake.issueForms) assert.ok(FORGE_ISSUE_TYPES.some((type) => type.name === form.type), `the ${form.type} form type is in the registry`);
  for (const name of ["Workstream", "Flake", "Lesson", "Bug", "Task"]) assert.ok(objects.some((entry) => entry.kind === "issue-type" && entry.key === name), name);
  assert.deepEqual((find(objects, "issue-field", "Area").desired as { options: { name: string }[] }).options.map((option) => option.name), ["engine", "docs"]);
  assert.equal((find(objects, "issue-field", "Severity").desired as { visibility: string }).visibility, "all");
});

test("the stage decides the flip: p0 keeps the P0 contexts on the trunk only, door requires the door App's check everywhere with signatures and one approval", () => {
  const baseline = (stage: "p0" | "door"): Record<string, unknown> => find(forgeDeclarations({ ...SOURCES, settings: { ...SETTINGS, stage } }), "org-ruleset", "baseline").desired as Record<string, unknown>;
  const rules = (ruleset: Record<string, unknown>): Record<string, Record<string, unknown>> => Object.fromEntries((ruleset.rules as { type: string }[]).map((rule) => [rule.type, rule as Record<string, unknown>]));
  const p0 = baseline("p0");
  const door = baseline("door");
  assert.deepEqual((p0.conditions as { repository_property: { include: { property_values: string[] }[] } }).repository_property.include[0]!.property_values, ["trunk"]);
  assert.deepEqual((door.conditions as { repository_property: { include: { property_values: string[] }[] } }).repository_property.include[0]!.property_values, ["trunk", "notes", "evidence", "meta"]);
  assert.equal(rules(p0).required_signatures, undefined);
  assert.ok(rules(door).required_signatures !== undefined);
  const checks = (ruleset: Record<string, unknown>): unknown => (rules(ruleset).required_status_checks!.parameters as { required_status_checks: unknown }).required_status_checks;
  assert.deepEqual(checks(p0), SETTINGS.p0RequiredChecks.map((check) => ({ context: check.context, integration_id: check.integrationId })));
  assert.deepEqual(checks(door), [{ context: "bridlewise/door", integration_id: { $ref: "app", name: "door" } }]);
  assert.equal((rules(p0).pull_request!.parameters as { required_approving_review_count: number }).required_approving_review_count, 0);
  assert.equal((rules(door).pull_request!.parameters as { required_approving_review_count: number }).required_approving_review_count, 1);
  // The trunk's own ruleset keeps only what an org ruleset cannot carry.
  assert.deepEqual((find(forgeDeclarations(SOURCES), "ruleset", "trunk").desired as { rules: { type: string }[] }).rules.map((rule) => rule.type), ["merge_queue", "code_scanning"]);
});

test("a form naming a type outside the registry, or two labels with one name, refuses the declarations", () => {
  const intake = { ...SOURCES.intake, issueForms: [...SOURCES.intake.issueForms, { ...SOURCES.intake.issueForms[0]!, type: "Epic" }] };
  assert.throws(() => forgeDeclarations({ ...SOURCES, intake }), (error: unknown) => isForgeError(error, "forge_declaration_invalid") && /Epic/u.test(error.message));
  const labels = [...SETTINGS.labels, { name: "AREA:engine", color: "000000", description: "" }];
  assert.throws(() => forgeDeclarations({ ...SOURCES, settings: { ...SETTINGS, labels } }), (error: unknown) => isForgeError(error, "forge_declaration_invalid"));
});

test("allowed actions: third-party pins only, local and docker actions and GitHub's own skipped", () => {
  assert.deepEqual(allowedActionPatterns(["actions/checkout@abc", "github/codeql-action/analyze@abc", "ossf/scorecard-action@abc", "ossf/scorecard-action@def", "./local", "docker://alpine:3", "sigstore/cosign-installer@abc"]),
    ["ossf/scorecard-action@*", "sigstore/cosign-installer@*"]);
});

function tree(files: Readonly<Record<string, string>>): TreeReader {
  return { label: "test", paths: () => Object.keys(files).sort(), entry: (path) => (path in files ? { mode: "100644", oid: null } : null), text: (path) => files[path] ?? null, prefetch: () => undefined };
}

test("Dependabot covers exactly the tracked lockfiles (frozen benchmarks excluded), and CODEOWNERS routes to the verifying roles", () => {
  const files = {
    "package-lock.json": "{}", "engine/package-lock.json": "{}",
    "engine/verification/benchmarks/x/package-lock.json": "{}",
    ".github/workflows/ci.yml": "jobs:\n  a:\n    steps:\n      - uses: actions/checkout@abc\n      - uses: \"ossf/scorecard-action@def\" # pinned\n",
  };
  const facts = forgeTreeFacts(tree(files), SETTINGS);
  assert.deepEqual(facts.lockfileDirectories.npm, ["/", "/engine"]);
  assert.deepEqual(facts.workflowActions, ["actions/checkout@abc", "ossf/scorecard-action@def"]);
  const yaml = dependabotFile(SETTINGS, facts);
  assert.match(yaml, /^# GENERATED by harness sync/u);
  assert.equal((yaml.match(/package-ecosystem:/gu) ?? []).length, 3);
  assert.match(yaml, /open-pull-requests-limit: 5/u);
  assert.match(yaml, /default-days: 3\n {6}semver-major-days: 7/u);
  // A lockfile nobody declared (in another place than the root), and a declared root without one: both refused.
  assert.throws(() => dependabotFile(SETTINGS, forgeTreeFacts(tree({ ...files, "server/package-lock.json": "{}" }), SETTINGS)), (error: unknown) => isForgeError(error, "forge_declaration_invalid") && /\/server/u.test(error.message));
  const withoutEngine: Record<string, string> = { ...files };
  delete withoutEngine["engine/package-lock.json"];
  assert.throws(() => dependabotFile(SETTINGS, forgeTreeFacts(tree(withoutEngine), SETTINGS)), (error: unknown) => isForgeError(error, "forge_declaration_invalid") && /\/engine/u.test(error.message));
  // A lockfile inside node_modules is never a root (near miss).
  assert.deepEqual(forgeTreeFacts(tree({ ...files, "node_modules/x/package-lock.json": "{}" }), SETTINGS).lockfileDirectories.npm, ["/", "/engine"]);
  const owners = codeownersFile(SETTINGS, SOURCES.roles);
  assert.match(owners, /^\* @LLM-4-People\/reviewers @amberflag48$/mu);
  assert.throws(() => codeownersFile(SETTINGS, { ...SOURCES.roles, roles: SOURCES.roles.roles.map((role) => ({ ...role, verifies: false })) }), (error: unknown) => isForgeError(error, "forge_declaration_invalid"));
});

test("the comparison: desired values must be in the live object; GitHub's extra fields are never drift; named arrays compare as sets", () => {
  assert.deepEqual(differences({ a: 1, b: { c: true } }, { a: 1, b: { c: true, extra: 2 }, id: 9 }), []);
  assert.deepEqual(differences({ a: 1, b: { c: true } }, { a: 2, b: {} }), ["/a", "/b/c"]);
  assert.deepEqual(differences({ rules: [{ type: "deletion" }, { type: "pull_request", parameters: { x: 1 } }] }, { rules: [{ type: "pull_request", parameters: { x: 1, y: 2 } }, { type: "deletion" }] }), []);
  assert.deepEqual(differences({ rules: [{ type: "deletion" }] }, { rules: [{ type: "deletion" }, { type: "creation" }] }), ["/rules"]);
  assert.deepEqual(differences(["a", "b"], ["b", "a"]), ["/0", "/1"], "plain arrays keep their order");
  assert.deepEqual(differences({ "a/b": 1 }, {}), ["/a~1b"]);
  const resolved = resolveReferences({ bypass: [{ actor_id: { $ref: "app", name: "publisher" } }] }, new Map([["app:publisher", 42]]));
  assert.deepEqual(resolved, { bypass: [{ actor_id: 42 }] });
});
