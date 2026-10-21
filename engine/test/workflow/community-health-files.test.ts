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
import { INTAKE_PATH, readIntake, readRoles, ROLES_PATH, roleForPermission, teamsOf } from "../../src/workflow/community/sources.ts";
import { communityFilesStep } from "../../src/workflow/harness-commands.ts";
import { withTempDir } from "../support/temp-dir.ts";

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
      '  - "two"',
      "empty: []",
      "none: {}",
      "",
    ].join("\n"),
  );
  assert.equal(emitYaml({ text: "line\n\"quoted\"" }), 'text: "line\\n\\"quoted\\""\n');
  assert.throws(() => emitYaml({ "bad key": 1 }), refusedWith("yaml_value_unrepresentable", /bad key/u));
  assert.throws(() => emitYaml({ n: Number.NaN }), refusedWith("yaml_value_unrepresentable", /non-finite/u));
  assert.throws(() => emitYaml({ u: undefined as never }), refusedWith("yaml_value_unrepresentable", /undefined/u));
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
    assert.throws(() => readIntake(root), refusedWith("community_source_invalid", /Lost names no declared category/u));
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

test("sync writes every generated file, check names a hand edit and a stale form, and a tree without sources is absent", () => {
  withTempDir("community-sync-", (root) => {
    assert.deepEqual(syncCommunityFiles(root, false), { status: "absent", converged: true, changed: [] });
    plant(root);
    mkdirSync(join(root, ".github/ISSUE_TEMPLATE"), { recursive: true });
    writeFileSync(join(root, ".github/ISSUE_TEMPLATE/old_form.yml"), "name: old\n");

    const first = syncCommunityFiles(root, true);
    assert.equal(first.status, "regenerated");
    assert.ok(first.changed.includes(".github/ISSUE_TEMPLATE/old_form.yml"), "a form the registry dropped is removed");
    assert.equal(existsSync(join(root, ".github/ISSUE_TEMPLATE/old_form.yml")), false);
    for (const path of [...TEMPLATED_FILES, ".github/ISSUE_TEMPLATE/config.yml", ".github/ISSUE_TEMPLATE/bug.yml", ".github/DISCUSSION_TEMPLATE/rfcs.yml"]) {
      assert.ok(existsSync(join(root, path)), `${path} is generated`);
    }
    assert.deepEqual(syncCommunityFiles(root, false), { status: "current", converged: true, changed: [] });

    const conduct = readFileSync(join(root, "CODE_OF_CONDUCT.md"), "utf8");
    assert.doesNotMatch(conduct, /INSERT CONTACT|\{\{/u, "the conduct contact comes from the role table");
    assert.match(readFileSync(join(root, "GOVERNANCE.md"), "utf8"), /\| Reviewer \| team `reviewers`/u);
    edit(root, ROLES_PATH, (json) => { const list = json.roles as Record<string, unknown>[]; list[1]!.earnedBy = "a|b\\c\nd"; });
    syncCommunityFiles(root, true);
    assert.ok(readFileSync(join(root, "GOVERNANCE.md"), "utf8").includes("| a\\|b\\\\c d |"), "a table cell escapes a pipe and a backslash and folds a line break");
    plant(root);
    syncCommunityFiles(root, true);
    assert.match(readFileSync(join(root, ".github/ISSUE_TEMPLATE/bug.yml"), "utf8"), /^type: "Bug"$/mu);
    assert.doesNotMatch(readFileSync(join(root, ".github/ISSUE_TEMPLATE/bug.yml"), "utf8"), /^labels:/mu, "labels are the projector's, never a form's");

    writeFileSync(join(root, "SUPPORT.md"), "hand edit\n");
    writeFileSync(join(root, ".github/DISCUSSION_TEMPLATE/stray.yml"), "title: x\n");
    const stale = syncCommunityFiles(root, false);
    assert.deepEqual(stale, { status: "stale", converged: false, changed: [".github/DISCUSSION_TEMPLATE/stray.yml", "SUPPORT.md"] });
    const step = communityFilesStep(stale);
    assert.equal(step.status, "fail");
    assert.match(step.message, /SUPPORT\.md/u);
    assert.equal(syncCommunityFiles(root, true).status, "regenerated");
    assert.equal(syncCommunityFiles(root, false).status, "current");
  });
});

test("the repository's own community files are current against their sources", () => {
  const report = syncCommunityFiles(REPOSITORY, false);
  assert.deepEqual(report.changed, [], "run harness sync");
  assert.equal(report.status, "current");
});
