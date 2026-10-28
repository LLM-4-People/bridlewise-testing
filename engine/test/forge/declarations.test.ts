/**
 * The forge's declarations (`declarations.ts`), the in-tree renders
 * (`repository-files.ts`) and the desired-state comparison (`forge-state.ts`):
 * pure functions of their owners, judged without GitHub.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { allowedActionPatterns, FORGE_ISSUE_TYPES, forgeDeclarations } from "../../src/workflow/forge/declarations.ts";
import { differences, referencesOf, resolveReferences, scopeName, writableBody, type ForgeObject } from "../../src/workflow/forge/forge-state.ts";
import { codeownersFile, dependabotEntryViolations, dependabotFile, dependabotUpdates, forgeTreeFacts, workflowUsesOf } from "../../src/workflow/forge/repository-files.ts";
import { isForgeError } from "../../src/workflow/forge/codes.ts";
import { looseningOf } from "../../src/workflow/forge/strictness.ts";
import { workingTreeReader, type TreeReader } from "../../src/git/tree-reader.ts";
import { join } from "node:path";
import { trackedTop } from "../../src/workflow/evidence-store.ts";
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
  assert.deepEqual(settingsScopes, ["bridlewise-testing", ".github", "bridlewise-evidence", "bridlewise-coordination", "forge-proving-ground"]);
  // The proving ground (P1.11): only its main's queue and signatures, and merged branches deleted; nothing a governed repository gets.
  assert.deepEqual(find(objects, "repository-settings", "forge-proving-ground").desired, { delete_branch_on_merge: true });
  const proving = find(objects, "ruleset", "proving-main");
  assert.deepEqual(proving.scope, { kind: "repo", repository: "forge-proving-ground" });
  assert.deepEqual((proving.desired as { rules: { type: string }[] }).rules.map((rule) => rule.type), ["merge_queue", "required_signatures"]);
  assert.deepEqual((proving.desired as { rules: unknown[] }).rules[0], (find(objects, "ruleset", "trunk").desired as { rules: unknown[] }).rules[0], "the trunk's own merge queue");
  assert.ok(!objects.some((entry) => entry.scope.kind === "repo" && entry.scope.repository === "forge-proving-ground" && entry.kind === "custom-property-values"), "never given a kind the baseline governs");
  // The Pages override (GH-5's #62): the maintainer reviews, main only, no admin bypass; self-review allowed until P3.9 (#310).
  assert.deepEqual(find(objects, "environment", "pages-override").desired, {
    deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }, can_admins_bypass: false, branch_policies: ["main"],
    reviewers: [{ type: "User", id: { $ref: "user", name: "amberflag48" } }], prevent_self_review: false,
  });
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
  // The content policy: one push ruleset per PRIVATE governed repository (the notes one), from the config section; never on a public or ungoverned one.
  const pushRulesets = objects.filter((entry) => entry.kind === "ruleset" && (entry.desired as { target: string }).target === "push");
  assert.deepEqual(pushRulesets.map((entry) => `${scopeName(entry.scope)}:${entry.key}`), ["bridlewise-coordination:content-policy"]);
  assert.deepEqual((pushRulesets[0]!.desired as { rules: unknown[] }).rules, [
    { type: "max_file_size", parameters: { max_file_size: 10 } },
    { type: "file_extension_restriction", parameters: { restricted_file_extensions: ["*.pem", "*.key", "*.env"] } },
    { type: "file_path_restriction", parameters: { restricted_file_paths: ["**/secrets/**", "**/tokens/**"] } },
  ]);
});

/**
 * THE ORG BASELINE AS github-only §3.2 SPECIFIES IT ("The org baseline ruleset (Team, decision A)"), written out
 * whole, so ANY rule the generator drops, adds or changes is a red here:
 * - target `branch`, empty bypass list, conditions: the `kind` property plus `~DEFAULT_BRANCH`;
 * - rules `deletion`, `non_fast_forward`, `required_signatures`, `pull_request` (R1's review parameters) and
 *   `required_status_checks` (`bridlewise/door`, the door App).
 * Before the flip (stage `p0`, runbook P0.2) the same baseline governs the trunk only, without
 * `required_signatures`, with no approval and no last-push approval (no App can approve yet), and requires the P0
 * contexts instead of the door's check.
 */
function specifiedBaseline(stage: "p0" | "door"): unknown {
  const door = stage === "door";
  return {
    name: "baseline", target: "branch", enforcement: "active", bypass_actors: [],
    conditions: {
      repository_property: { include: [{ name: "kind", property_values: door ? ["trunk", "notes", "evidence", "meta"] : ["trunk"] }], exclude: [] },
      ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] },
    },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      ...(door ? [{ type: "required_signatures" }] : []),
      { type: "pull_request", parameters: {
        required_approving_review_count: door ? 1 : 0, dismiss_stale_reviews_on_push: true, require_code_owner_review: false,
        require_last_push_approval: door, required_review_thread_resolution: true, allowed_merge_methods: ["merge"],
      } },
      { type: "required_status_checks", parameters: {
        strict_required_status_checks_policy: false, do_not_enforce_on_create: false,
        required_status_checks: door
          ? [{ context: "bridlewise/door", integration_id: { $ref: "app", name: "door" } }]
          : SETTINGS.p0RequiredChecks.map((check) => ({ context: check.context, integration_id: check.integrationId })),
      } },
    ],
  };
}

test("the org baseline is exactly §3.2's, at both stages: a rule removed, added or changed by the generator is red", () => {
  for (const stage of ["p0", "door"] as const) {
    const generated = find(forgeDeclarations({ ...SOURCES, settings: { ...SETTINGS, stage } }), "org-ruleset", "baseline");
    assert.deepEqual(generated.desired, specifiedBaseline(stage), stage);
  }
  // The trunk's own ruleset keeps only what an org ruleset cannot carry.
  assert.deepEqual((find(forgeDeclarations(SOURCES), "ruleset", "trunk").desired as { rules: { type: string }[] }).rules.map((rule) => rule.type), ["merge_queue", "code_scanning"]);
});

test("merge commits only (#486): the settings, the baseline's pull-request rule and the merge queue allow merge alone, and widening any is a loosening", () => {
  // `harness promote verify` relies on it: main's first-parent line is its published history only if every landing is a merge commit.
  for (const stage of ["p0", "door"] as const) {
    const objects = forgeDeclarations({ ...SOURCES, settings: { ...SETTINGS, stage } });
    for (const repository of objects.filter((entry) => entry.kind === "repository-settings")) {
      assert.deepEqual(Object.fromEntries(Object.entries(repository.desired as Record<string, unknown>).filter(([key]) => /^allow_(?:merge_commit|rebase_merge|squash_merge)$/u.test(key))),
        { allow_merge_commit: true, allow_rebase_merge: false, allow_squash_merge: false }, `${stage} ${repository.key}`);
    }
    const rules = (key: string, kind: string) => (find(objects, kind, key).desired as { rules: { type: string; parameters?: Record<string, unknown> }[] }).rules;
    assert.deepEqual(rules("baseline", "org-ruleset").find((rule) => rule.type === "pull_request")?.parameters?.allowed_merge_methods, ["merge"], stage);
    assert.equal(rules("trunk", "ruleset").find((rule) => rule.type === "merge_queue")?.parameters?.merge_method, "MERGE", stage);
  }
  // A plan that would allow squash or rebase again is a loosening: never applied without its acknowledgement.
  assert.deepEqual(looseningOf("repository-settings", { allow_squash_merge: true }, { allow_squash_merge: false }), ["allow_squash_merge false -> true"]);
  assert.deepEqual(looseningOf("repository-settings", { allow_rebase_merge: true }, { allow_rebase_merge: false }), ["allow_rebase_merge false -> true"]);
  assert.deepEqual(looseningOf("repository-settings", { allow_squash_merge: false, allow_rebase_merge: false }, { allow_squash_merge: true, allow_rebase_merge: true }), [], "narrowing back to merge is not");
  // The same for the two rules: widening the baseline's pull-request merge methods, or the trunk queue's merge method, is a loosening.
  const declared = forgeDeclarations(SOURCES);
  type Ruleset = { rules: { type: string; parameters?: Record<string, unknown> }[] };
  const widened = (kind: string, key: string, type: string, parameters: Record<string, unknown>): Ruleset => {
    const ruleset = find(declared, kind, key).desired as Ruleset;
    return { ...ruleset, rules: ruleset.rules.map((rule) => rule.type === type ? { ...rule, parameters: { ...rule.parameters, ...parameters } } : rule) };
  };
  const baseline = find(declared, "org-ruleset", "baseline").desired;
  const trunk = find(declared, "ruleset", "trunk").desired;
  assert.notDeepEqual(looseningOf("org-ruleset", widened("org-ruleset", "baseline", "pull_request", { allowed_merge_methods: ["merge", "squash"] }), baseline), [], "the baseline allowing squash again");
  assert.notDeepEqual(looseningOf("ruleset", widened("ruleset", "trunk", "merge_queue", { merge_method: "SQUASH" }), trunk), [], "the trunk queue squashing");
  assert.deepEqual(looseningOf("org-ruleset", baseline, widened("org-ruleset", "baseline", "pull_request", { allowed_merge_methods: ["merge", "squash"] })), [], "narrowing the baseline back to merge is not");
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
  // Dependabot's documented per-ecosystem support holds for every emitted entry: the SemVer cooldown only where it is
  // supported (npm yes, GitHub Actions no; default-days everywhere), so the file parses on GitHub.
  const updates = dependabotUpdates(SETTINGS, facts);
  assert.deepEqual(updates.flatMap((entry, index) => dependabotEntryViolations(entry, index)), []);
  assert.deepEqual(updates.map((entry) => `${String(entry["package-ecosystem"])}:${Object.keys(entry.cooldown as object).join("+")}`),
    ["npm:default-days+semver-major-days", "npm:default-days+semver-major-days", "github-actions:default-days"]);
  // Planted: the main bug (github-actions with semver-major-days), and each other way an entry breaks the reference.
  assert.deepEqual(dependabotEntryViolations({ "package-ecosystem": "github-actions", directory: "/", cooldown: { "default-days": 3, "semver-major-days": 7 } }, 2),
    ["updates[2]: cooldown.semver-major-days is not supported for the package ecosystem 'github-actions'"]);
  assert.deepEqual(dependabotEntryViolations({ "package-ecosystem": "npm", directory: "/engine", cooldown: { "default-days": 3, "semver-major-days": 7, "semver-patch-days": 1 } }, 0), [], "near miss: npm takes them");
  assert.equal(dependabotEntryViolations({ "package-ecosystem": "cargo", directory: "/", cooldown: { "semver-major-days": 7 } }, 0).length, 0, "near miss: Cargo takes them");
  assert.deepEqual(dependabotEntryViolations({ "package-ecosystem": "github-actions", directory: "/.github", cooldown: {} }, 1), ['updates[1]: github-actions takes directory "/" only']);
  assert.deepEqual(dependabotEntryViolations({ "package-ecosystem": "npm", directory: "/", cooldown: { "semver-major": 7 } }, 0), ["updates[0]: cooldown.semver-major is not a Dependabot cooldown key"]);
  assert.deepEqual(dependabotEntryViolations({ "package-ecosystem": "npm", directory: "/", "versioning-strategy": "increase" }, 0), ["updates[0]: versioning-strategy is not a key the forge writes"]);
  assert.equal(dependabotEntryViolations({ "package-ecosystem": "docker", directory: "/" }, 0).length, 1, "an ecosystem the forge does not classify is refused");
  // The generator itself refuses a reachable declaration Dependabot would not take: the forge section's github-actions entry
  // at "/.github" makes dependabotFile throw, naming the entry (never a file GitHub refuses on push).
  const misplaced = { ...SETTINGS, dependabot: { ...SETTINGS.dependabot, packages: SETTINGS.dependabot.packages.map((entry) => entry.ecosystem === "github-actions" ? { ...entry, directory: "/.github" } : entry) } };
  assert.throws(() => dependabotFile(misplaced, facts), (error: unknown) => isForgeError(error, "forge_declaration_invalid") && error.message.includes('github-actions takes directory "/" only'));
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

test("the allowed actions come from parsed `uses:` keys only: text in a run block, a quoted script or a one-line run never widens them", () => {
  const planted = [
    "name: planted",
    "on: push",
    "jobs:",
    "  a:",
    "    runs-on: ubuntu-24.04",
    "    steps:",
    "      - uses: actions/checkout@0123456789abcdef0123456789abcdef01234567 # v7",
    "      - name: block script",
    "        run: |",
    "          echo uses: evil/one@main",
    "            uses: evil/two@main",
    "      - name: folded script",
    "        run: >-",
    "          uses: evil/three@main",
    "      - run: echo \"uses: evil/four@main\"",
    "      - name: quoted multi-line",
    "        run: \"echo first",
    "          uses: evil/five@main\"",
    "      - name: real one after the scripts",
    "        uses: 'ossf/scorecard-action@0123456789abcdef0123456789abcdef01234567'",
    "        with:",
    "          results_file: results.sarif",
    "  b:",
    "    uses: ./.github/workflows/reusable.yml",
  ].join("\n");
  const uses = workflowUsesOf(planted, ".github/workflows/planted.yml");
  assert.deepEqual(uses, ["actions/checkout@0123456789abcdef0123456789abcdef01234567", "ossf/scorecard-action@0123456789abcdef0123456789abcdef01234567", "./.github/workflows/reusable.yml"]);
  assert.deepEqual(allowedActionPatterns(uses), ["ossf/scorecard-action@*"], "no planted evil/* pattern");
  // Forms the reader does not decide are refused, never guessed.
  for (const [text, form] of [
    ["steps:\n  - { uses: evil/flow@main }", "a flow mapping"],
    ["steps:\n  - uses: *anchor", "an alias"],
    ["steps:\n  - uses: \"evil/x@main; rm -rf /\"", "a value that is not a reference"],
  ] as const) {
    assert.throws(() => workflowUsesOf(text, "w.yml"), (error: unknown) => isForgeError(error, "forge_declaration_invalid"), form);
  }
  // The repository's own workflows read without refusal (a near miss across every real form).
  const tree = workingTreeReader(trackedTop(join(import.meta.dirname, "..", "..")));
  const facts = forgeTreeFacts(tree, SETTINGS);
  assert.ok(facts.workflowActions.length > 10);
  assert.ok(facts.workflowActions.every((reference) => !reference.startsWith("evil/")));
});
