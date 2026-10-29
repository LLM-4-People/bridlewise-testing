/**
 * THE COMMUNITY SOURCES AND THEIR GENERATED FILES, driven
 * (`src/workflow/community/`, `src/text/yaml-emit.ts`): the role table and the
 * intake registry refuse what they cannot mean; the health files and forms are
 * a pure function of the templates and the facts; `harness sync`'s arm writes
 * them, `harness check`'s arm names a hand edit or a stale form, and the
 * repository's own files are current.
 */
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { HarnessError } from "../../src/kernel/errors.ts";
import { emitYaml } from "../../src/text/yaml-emit.ts";
import { fillTemplate, syncCommunityFiles, TEMPLATED_FILES } from "../../src/workflow/community/health-files.ts";
import { FEATURES_PATH, INTAKE_PATH, readIntake, readRoles, ROLES_PATH, roleForPermission, teamsOf } from "../../src/workflow/community/sources.ts";
import { communityFilesStep } from "../../src/workflow/harness-commands.ts";
import { withTempDir } from "../support/temp-dir.ts";
import { configuredRepositoryIdentity } from "../../src/workflow/forge/repository-identity.ts";

const REPOSITORY = dirname(fileURLToPath(new URL("../../", import.meta.url)));

/** A planted repository carrying the real community sources and the two facts' owners. */
function plant(root: string): void {
  cpSync(join(REPOSITORY, "docs/community"), join(root, "docs/community"), { recursive: true });
  cpSync(join(REPOSITORY, "package.json"), join(root, "package.json"));
  mkdirSync(join(root, "engine/guardian"), { recursive: true });
  cpSync(join(REPOSITORY, "engine/guardian/Makefile"), join(root, "engine/guardian/Makefile"));
}

function edit(root: string, path: string, change: (json: Record<string, unknown>) => void): void {
  const json = JSON.parse(readFileSync(join(root, path), "utf8")) as Record<string, unknown>;
  change(json);
  writeFileSync(join(root, path), JSON.stringify(json));
}

function refusedWith(code: string, pattern: RegExp): (error: unknown) => boolean {
  return (error) => error instanceof HarnessError && error.code === code && pattern.test(error.message);
}

test("the YAML emitter quotes every string, keeps key order and refuses what JSON cannot hold", () => {
  assert.equal(
    emitYaml({ name: "no", version: "1.0", star: "*x", list: [{ a: 1, b: [true, null] }, "two"], empty: [], none: {} }, ["generated", ""]),
    [
      "# generated",
      "#",
      'name: "no"',
      'version: "1.0"',
      'star: "*x"',
      "list:",
      "  - a: 1",
      "    b:",
      "      - true",
      "      - null",
      "  - two",
      "empty: []",
      "none: {}",
      "",
    ].join("\n"),
  );
  assert.equal(emitYaml({ text: "line\n\"quoted\"" }), 'text: |-\n  line\n  "quoted"\n');
  assert.equal(emitYaml({ "bad key": 1, on: "on" }), '"bad key": 1\n"on": "on"\n', "an unsafe or reserved key is quoted");
  assert.throws(() => emitYaml({ n: Number.NaN }), refusedWith("yaml_unrepresentable", /NaN/u));
  assert.throws(() => emitYaml({ u: undefined as never }), refusedWith("yaml_unrepresentable", /undefined/u));
});

test("the role table refuses a repeated role, a falling ladder and a member with no declared role", () => {
  withTempDir("community-roles-", (root) => {
    plant(root);
    const roles = readRoles(root);
    assert.deepEqual(teamsOf(roles).map((team) => [team.team, team.permission]), [["triagers", "triage"], ["reviewers", "write"]]);
    assert.equal(roleForPermission(roles, "read").id, "contributor");
    assert.equal(roleForPermission(roles, "triage").id, "triager");
    assert.equal(roleForPermission(roles, "maintain").id, "reviewer");
    assert.equal(roleForPermission(roles, "admin").id, "maintainer");

    edit(root, ROLES_PATH, (json) => { (json.members as unknown[]).push({ login: "someone", role: "owner" }); });
    assert.throws(() => readRoles(root), refusedWith("community_source_invalid", /someone → owner/u));
    plant(root);
    edit(root, ROLES_PATH, (json) => { const list = json.roles as Record<string, unknown>[]; list[2]!.permission = "triage"; });
    assert.throws(() => readRoles(root), refusedWith("community_source_invalid", /reviewer must grant more than triager/u));
    plant(root);
    edit(root, ROLES_PATH, (json) => { const list = json.roles as Record<string, unknown>[]; list.push({ ...list[0]!, permission: "admin", team: "x" }); });
    assert.throws(() => readRoles(root), refusedWith("community_source_invalid", /declared twice: contributor/u));
    plant(root);
    edit(root, ROLES_PATH, (json) => { json.extra = true; });
    assert.throws(() => readRoles(root), refusedWith("community_source_invalid", /extra|Unrecognized/u));
    rmSync(join(root, ROLES_PATH));
    assert.throws(() => readRoles(root), refusedWith("community_source_invalid", /missing/u));
  });
});

test("the intake registry refuses a contact link to no category and a form named config.yml", () => {
  withTempDir("community-intake-", (root) => {
    plant(root);
    assert.ok(readIntake(root).issueForms.length > 0);
    edit(root, INTAKE_PATH, (json) => { (json.contactLinks as unknown[]).push({ name: "Lost", category: "nowhere", about: "x" }); });
    assert.throws(() => readIntake(root), refusedWith("community_source_invalid", /Lost names no live category/u));
    plant(root);
    edit(root, INTAKE_PATH, (json) => { (json.contactLinks as unknown[]).push({ name: "Both", category: "ideas", advisory: true, about: "x" }); });
    assert.throws(() => readIntake(root), refusedWith("community_source_invalid", /exactly one/u));
    plant(root);
    edit(root, INTAKE_PATH, (json) => { const forms = json.issueForms as Record<string, unknown>[]; forms[0]!.file = "config.yml"; });
    assert.throws(() => readIntake(root), refusedWith("community_source_invalid", /config\.yml/u));
  });
});

test("a template naming an unknown slot is refused, and a known one is filled", () => {
  const slots = new Map([["repository", "o/r"]]);
  assert.equal(fillTemplate("t.md", "see {{repository}}.", slots), "see o/r.");
  assert.throws(() => fillTemplate("t.md", "{{nope}}", slots), refusedWith("community_template_invalid", /\{\{nope\}\}/u));
});

test("sync writes every generated file, check names a hand edit, and the generator's own stale output is deleted", () => {
  withTempDir("community-sync-", (root) => {
    plant(root);
    mkdirSync(join(root, ".github/ISSUE_TEMPLATE"), { recursive: true });
    writeFileSync(join(root, ".github/ISSUE_TEMPLATE/old_form.yml"), "# GENERATED by `harness sync` from an older registry\nname: old\n");

    const first = syncCommunityFiles(root, true);
    assert.equal(first.status, "regenerated");
    assert.ok(first.changed.includes(".github/ISSUE_TEMPLATE/old_form.yml"), "a form the registry dropped is removed");
    assert.equal(existsSync(join(root, ".github/ISSUE_TEMPLATE/old_form.yml")), false);
    for (const path of [...TEMPLATED_FILES, ".github/ISSUE_TEMPLATE/config.yml", ".github/ISSUE_TEMPLATE/bug.yml", ".github/DISCUSSION_TEMPLATE/ideas.yml"]) {
      assert.ok(existsSync(join(root, path)), `${path} is generated`);
    }
    assert.deepEqual(syncCommunityFiles(root, false), { status: "current", converged: true, changed: [] });

    const conduct = readFileSync(join(root, "CODE_OF_CONDUCT.md"), "utf8");
    assert.doesNotMatch(conduct, /INSERT CONTACT|\{\{/u, "the conduct contact comes from the role table, its slots filled");
    assert.match(conduct, /security\/advisories\/new/u);
    edit(root, ROLES_PATH, (json) => { const list = json.roles as Record<string, unknown>[]; list[1]!.earnedBy = "a|b\\c\nd"; });
    syncCommunityFiles(root, true);
    assert.ok(readFileSync(join(root, "GOVERNANCE.md"), "utf8").includes("| a\\|b\\\\c d |"), "a table cell escapes a pipe and a backslash and folds a line break");
    plant(root);
    syncCommunityFiles(root, true);
    assert.match(readFileSync(join(root, ".github/ISSUE_TEMPLATE/bug.yml"), "utf8"), /^type: Bug$/mu);
    assert.doesNotMatch(readFileSync(join(root, ".github/ISSUE_TEMPLATE/bug.yml"), "utf8"), /^labels:/mu, "labels are the projector's, never a form's");

    writeFileSync(join(root, "SUPPORT.md"), "hand edit\n");
    const stale = syncCommunityFiles(root, false);
    assert.deepEqual(stale, { status: "stale", converged: false, changed: ["SUPPORT.md"] });
    const step = communityFilesStep({ ...stale, refusal: "" });
    assert.equal(step.status, "fail");
    assert.match(step.message, /SUPPORT\.md/u);
    assert.equal(syncCommunityFiles(root, true).status, "regenerated");
    assert.equal(syncCommunityFiles(root, false).status, "current");
  });
});

test("a missing source is a typed failure once any community surface exists; only a tree with none at all is absent", () => {
  withTempDir("community-missing-", (root) => {
    assert.deepEqual(syncCommunityFiles(root, false), { status: "absent", converged: true, changed: [] });
    plant(root);
    syncCommunityFiles(root, true);
    for (const source of [ROLES_PATH, INTAKE_PATH, FEATURES_PATH]) {
      plant(root);
      rmSync(join(root, source));
      writeFileSync(join(root, "CONTRIBUTING.md"), "hand edit with the source gone\n");
      assert.throws(() => syncCommunityFiles(root, false), (error: unknown) => error instanceof HarnessError && error.code === "community_source_invalid" && error.message.includes(source) && error.message.includes("missing"), source);
    }
    // The whole folder gone, a generated file left behind: still refused, never "absent".
    rmSync(join(root, "docs/community"), { recursive: true });
    assert.throws(() => syncCommunityFiles(root, false), (error: unknown) => error instanceof HarnessError && /^community_/u.test(error.code));
    const refused = communityFilesStep({ status: "refused", converged: false, changed: [], refusal: "community_source_invalid: docs/community/roles.json is invalid: the file is missing" });
    assert.equal(refused.status, "fail");
    assert.match(refused.message, /cannot be generated: community_source_invalid/u);
  });
});

test("every place GitHub reads a health file or template is the generator's: a shadow is drift, and sync refuses a hand-made one", () => {
  const shadows = [".github/CONTRIBUTING.md", ".github/SECURITY.md", "docs/SUPPORT.md", ".github/ISSUE_TEMPLATE/evil.md", ".github/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE/x.md", "docs/Code_Of_Conduct.txt", ".github/DISCUSSION_TEMPLATE/stray.yml"];
  withTempDir("community-shadow-", (root) => {
    plant(root);
    syncCommunityFiles(root, true);
    for (const shadow of shadows) {
      mkdirSync(dirname(join(root, shadow)), { recursive: true });
      writeFileSync(join(root, shadow), "a hand-made page GitHub would show\n");
      const report = syncCommunityFiles(root, false);
      assert.deepEqual(report, { status: "stale", converged: false, changed: [shadow] }, shadow);
      assert.throws(() => syncCommunityFiles(root, true), (error: unknown) => error instanceof HarnessError && error.code === "community_shadow_file" && error.message.includes(shadow), shadow);
      assert.ok(existsSync(join(root, shadow)), "a person's file is never deleted");
      rmSync(join(root, shadow));
    }
    assert.equal(syncCommunityFiles(root, false).status, "current");
    // Near misses: names GitHub does not read as health files.
    for (const near of ["docs/contributing-guide/intro.md", "docs/SUPPORTED.md", ".github/workflows/support.yml", "engine/SECURITY.md"]) {
      mkdirSync(dirname(join(root, near)), { recursive: true });
      writeFileSync(join(root, near), "x\n");
    }
    assert.equal(syncCommunityFiles(root, false).status, "current");
  });
});

test("a template that names no generated file is drift, and the form schema refuses what GitHub would", () => {
  withTempDir("community-schema-", (root) => {
    plant(root);
    writeFileSync(join(root, "docs/community/templates/EXTRA.md.tmpl"), "orphan\n");
    assert.throws(() => syncCommunityFiles(root, false), refusedWith("community_template_invalid", /EXTRA\.md\.tmpl/u));
    const field = (changes: Record<string, unknown>) => (json: Record<string, unknown>) => {
      const forms = json.issueForms as { fields: Record<string, unknown>[] }[];
      Object.assign(forms[0]!.fields[0]!, changes);
    };
    for (const [why, change] of [
      ["a dropdown with no options", field({ kind: "dropdown" })],
      ["options on an input", field({ kind: "input", options: ["a"] })],
      ["render on an input", field({ kind: "input", render: "shell" })],
      ["a textarea without render (it would take attachments)", field({ kind: "textarea", render: undefined })],
      ["the confirmations id", field({ id: "confirmations" })],
      ["a repeated field id", (json: Record<string, unknown>) => { const forms = json.issueForms as { fields: Record<string, unknown>[] }[]; forms[0]!.fields[1]!.id = forms[0]!.fields[0]!.id; }],
      ["a planned claim with no tracking issue number", (json: Record<string, unknown>) => { (json.issueForms as Record<string, unknown>[])[0]!.typeStatus = { planned: "soon" }; }],
      ["a planned claim that spells a URL instead of an issue number", (json: Record<string, unknown>) => { (json.issueForms as Record<string, unknown>[])[0]!.typeStatus = { planned: "https://github.com/o/r/issues/1" }; }],
      ["a contact link to a planned category", (json: Record<string, unknown>) => { (json.contactLinks as Record<string, unknown>[])[0]!.category = "rfcs"; }],
    ] as const) {
      plant(root);
      rmSync(join(root, "docs/community/templates/EXTRA.md.tmpl"), { force: true });
      edit(root, INTAKE_PATH, change);
      assert.throws(() => readIntake(root), refusedWith("community_source_invalid", /./u), why);
    }
  });
});

test("the pages state live facts only: a planned category, type or feature is listed as planned with its tracking link, never stated or linked", () => {
  withTempDir("community-planned-", (root) => {
    plant(root);
    syncCommunityFiles(root, true);
    const intake = readIntake(root);
    const support = readFileSync(join(root, "SUPPORT.md"), "utf8");
    for (const category of intake.discussionCategories) {
      const linked = support.includes(`/discussions/categories/${category.slug})`);
      assert.equal(linked, "live" in category.status, `${category.slug} is linked only while live`);
      if ("planned" in category.status) assert.ok(support.includes(`${configuredRepositoryIdentity().issuesUrl}/${String(category.status.planned)}.`), `${category.slug}'s tracking link is listed, generated from the repository identity`);
      assert.equal(existsSync(join(root, `.github/DISCUSSION_TEMPLATE/${category.slug}.yml`)), category.form !== undefined && "live" in category.status, `${category.slug}'s form exists only while live`);
    }
    for (const form of intake.issueForms) {
      const yaml = readFileSync(join(root, `.github/ISSUE_TEMPLATE/${form.file}`), "utf8");
      assert.equal(/^type: /mu.test(yaml), "live" in form.typeStatus, `${form.file} names its type only while it is live`);
    }
    const contributing = () => readFileSync(join(root, "CONTRIBUTING.md"), "utf8");
    assert.match(contributing(), /signed off by GitHub/u);
    edit(root, FEATURES_PATH, (json) => { const list = json.features as Record<string, unknown>[]; list.find((feature) => feature.id === "web-signoff")!.status = { planned: 1 }; });
    syncCommunityFiles(root, true);
    assert.doesNotMatch(contributing(), /signed off by GitHub\./u, "a planned feature's sentence is not stated");
    assert.ok(readFileSync(join(root, "SUPPORT.md"), "utf8").includes(`signed off by GitHub. Planned; tracked in ${configuredRepositoryIdentity().issuesUrl}/1.`), "the tracking link is generated from the issue number and the repository identity");
    assert.doesNotMatch(readFileSync(join(root, "GOVERNANCE.md"), "utf8"), /team `/u, "the teams are planned, so no role names one");
  });
});

test("the repository's own community files are current against their sources", () => {
  const report = syncCommunityFiles(REPOSITORY, false);
  assert.deepEqual(report.changed, [], "run harness sync");
  assert.equal(report.status, "current");
});
