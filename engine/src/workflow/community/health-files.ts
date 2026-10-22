/**
 * THE COMMUNITY HEALTH FILES AND FORMS, generated (github-only §10.3): every
 * file GitHub shows a contributor — CONTRIBUTING, CODE_OF_CONDUCT, SECURITY,
 * SUPPORT, GOVERNANCE, the pull-request template, the issue forms, the
 * chooser's `config.yml` and the Discussion forms — is written by
 * `harness sync` from its single sources and judged by `harness check`, never
 * edited by hand.
 *
 * The sources:
 *   - the prose: `docs/community/templates/<file>.tmpl`, with `{{slot}}` slots
 *     (not `.md`, so the link guards judge the rendered file, never a slot);
 *   - the facts that fill the slots, each from its one owner: the role table
 *     and the intake registry (`sources.ts`), the repository identity and the
 *     supported Node range (`package.json`), the guardian's declared compiler
 *     (`engine/guardian/Makefile`).
 *
 * A template naming an unknown slot is the typed `community_template_invalid`;
 * a tree without community sources is converged by absence.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { atomicWriteFile } from "../../filesystem/atomic-write.ts";
import { HarnessError, InputError } from "../../kernel/errors.ts";
import { emitYaml, type YamlValue } from "../../text/yaml-emit.ts";
import {
  COMMUNITY_DIRECTORY,
  hasCommunitySources,
  readIntake,
  readRoles,
  type CommunityIntake,
  type CommunityRoles,
  type FormField,
} from "./sources.ts";

export const TEMPLATES_DIRECTORY = `${COMMUNITY_DIRECTORY}/templates`;
export const ISSUE_FORMS_DIRECTORY = ".github/ISSUE_TEMPLATE";
export const DISCUSSION_FORMS_DIRECTORY = ".github/DISCUSSION_TEMPLATE";

/** The Markdown files rendered from a template of the same name, repository-relative. */
export const TEMPLATED_FILES = Object.freeze([
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "SECURITY.md",
  "SUPPORT.md",
  "GOVERNANCE.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
] as const);

export type CommunityFacts = Readonly<{
  roles: CommunityRoles;
  intake: CommunityIntake;
  /** `owner/name` of the GitHub repository (`package.json` `repository.url`). */
  repository: string;
  nodeRange: string;
  compiler: string;
}>;

export type CommunityFilesReport = Readonly<{
  status: "current" | "regenerated" | "stale" | "absent";
  converged: boolean;
  changed: readonly string[];
}>;

function templateInvalid(path: string, why: string): never {
  throw new InputError(`${path}: ${why}`, "community_template_invalid", { path });
}

/** The facts the generated files carry, each read from its one owner. */
export function readCommunityFacts(repositoryRoot: string): CommunityFacts {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as { repository?: { url?: unknown }; engines?: { node?: unknown } };
  const url = typeof manifest.repository?.url === "string" ? manifest.repository.url : "";
  const repository = /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+?)(?:\.git)?$/u.exec(url)?.[1];
  if (repository === undefined) templateInvalid("package.json", "repository.url names no GitHub repository");
  const nodeRange = manifest.engines?.node;
  if (typeof nodeRange !== "string") templateInvalid("package.json", "engines.node is not declared");
  const makefile = "engine/guardian/Makefile";
  const compiler = /^CC\s*:=\s*(\S+)$/mu.exec(readFileSync(join(repositoryRoot, makefile), "utf8"))?.[1];
  if (compiler === undefined) templateInvalid(makefile, "declares no CC := … line");
  return Object.freeze({ roles: readRoles(repositoryRoot), intake: readIntake(repositoryRoot), repository, nodeRange, compiler });
}

const repositoryUrl = (facts: CommunityFacts): string => `https://github.com/${facts.repository}`;
const advisoryUrl = (facts: CommunityFacts): string => `${repositoryUrl(facts)}/security/advisories/new`;
const categoryUrl = (facts: CommunityFacts, slug: string): string => `${repositoryUrl(facts)}/discussions/new?category=${slug}`;

/** A Markdown table cell: a backslash and a pipe escaped in one pass and line breaks folded, so a source string never breaks the table. */
function cell(text: string): string {
  return text.replace(/[\\|]/gu, (character) => `\\${character}`).replace(/\s*\n\s*/gu, " ");
}

/** Every slot a template may name, rendered from the facts. */
export function communitySlots(facts: CommunityFacts): ReadonlyMap<string, string> {
  const { roles, intake } = facts;
  const titleOf = new Map(roles.roles.map((role) => [role.id, role.title]));
  return new Map([
    ["repository", facts.repository],
    ["repositoryName", facts.repository.split("/")[1]!],
    ["repositoryUrl", repositoryUrl(facts)],
    ["advisoryUrl", advisoryUrl(facts)],
    ["nodeRange", facts.nodeRange],
    ["compiler", facts.compiler],
    ["conductContact", roles.conduct.contact],
    [
      "roleTable",
      [
        "| Role | GitHub access | Approval counts as verification | Earned by |",
        "|---|---|---|---|",
        ...roles.roles.map((role) => `| ${cell(role.title)} | ${cell(role.access)} | ${role.verifies ? "yes, on pull requests they did not author" : "no"} | ${cell(role.earnedBy)} |`),
      ].join("\n"),
    ],
    ["members", roles.members.map((member) => `- [@${member.login}](https://github.com/${member.login}), ${titleOf.get(member.role)!}`).join("\n")],
    [
      "discussionCategories",
      [
        "| Category | Who posts | Use |",
        "|---|---|---|",
        ...intake.discussionCategories.map((category) => `| [${cell(category.name)}](${repositoryUrl(facts)}/discussions/categories/${category.slug}) | ${cell(category.postedBy)} | ${cell(category.use)} |`),
      ].join("\n"),
    ],
    ["issueForms", intake.issueForms.map((form) => `- [${form.name}](${repositoryUrl(facts)}/issues/new?template=${form.file}): ${form.description}`).join("\n")],
  ]);
}

const SLOT = /\{\{([A-Za-z]+)\}\}/gu;

/** `template` with every slot filled; an unknown slot is `community_template_invalid`. */
export function fillTemplate(path: string, template: string, slots: ReadonlyMap<string, string>): string {
  return template.replace(SLOT, (_whole, name: string) => slots.get(name) ?? templateInvalid(path, `names the unknown slot {{${name}}} (known: ${[...slots.keys()].join(", ")})`));
}

function generatedNotice(sources: string): string {
  return `GENERATED by \`harness sync\` from ${sources}. Edit the sources, never this file.`;
}

function formBody(fields: readonly FormField[]): YamlValue[] {
  return fields.map((field) => {
    const attributes: { [key: string]: YamlValue } = { label: field.label };
    if (field.description !== undefined) attributes.description = field.description;
    if (field.placeholder !== undefined) attributes.placeholder = field.placeholder;
    if (field.render !== undefined) attributes.render = field.render;
    if (field.options !== undefined) attributes.options = field.options;
    return { type: field.kind, id: field.id, attributes, validations: { required: field.required } };
  });
}

function confirmations(intake: CommunityIntake): YamlValue {
  return {
    type: "checkboxes",
    id: "confirmations",
    attributes: { label: "Confirmations", options: intake.confirmations.map((label) => ({ label, required: true })) },
  };
}

/** Every generated file's text, keyed by its repository-relative path (a pure function of the templates and the facts). */
export function renderCommunityFiles(templates: ReadonlyMap<string, string>, facts: CommunityFacts): ReadonlyMap<string, string> {
  const slots = communitySlots(facts);
  const files = new Map<string, string>();
  for (const path of TEMPLATED_FILES) {
    const templatePath = `${TEMPLATES_DIRECTORY}/${path.replace(/^\.github\//u, "")}.tmpl`;
    const template = templates.get(templatePath);
    if (template === undefined) templateInvalid(templatePath, `the template of ${path} is missing`);
    files.set(path, `<!-- ${generatedNotice(`${templatePath} and the community sources (docs/community/)`)} -->\n${fillTemplate(templatePath, template, slots)}`);
  }
  const { intake } = facts;
  const intakeNotice = [generatedNotice(`docs/community/intake.json (engine/src/workflow/community/health-files.ts)`)];
  for (const form of intake.issueForms) {
    files.set(`${ISSUE_FORMS_DIRECTORY}/${form.file}`, emitYaml({
      name: form.name,
      description: form.description,
      type: form.type,
      body: [{ type: "markdown", attributes: { value: `> [!WARNING]\n> ${intake.warning}` } }, ...formBody(form.fields), confirmations(intake)],
    }, intakeNotice));
  }
  files.set(`${ISSUE_FORMS_DIRECTORY}/config.yml`, emitYaml({
    blank_issues_enabled: false,
    contact_links: intake.contactLinks.map((link) => ({
      name: link.name,
      url: link.advisory === true ? advisoryUrl(facts) : categoryUrl(facts, link.category!),
      about: link.about,
    })),
  }, intakeNotice));
  for (const category of intake.discussionCategories) {
    if (category.form === undefined) continue;
    files.set(`${DISCUSSION_FORMS_DIRECTORY}/${category.slug}.yml`, emitYaml({
      title: category.form.title,
      body: [{ type: "markdown", attributes: { value: `> [!WARNING]\n> ${intake.warning}` } }, ...formBody(category.form.fields)],
    }, intakeNotice));
  }
  return files;
}

function readTemplates(repositoryRoot: string): ReadonlyMap<string, string> {
  const directory = join(repositoryRoot, TEMPLATES_DIRECTORY);
  const templates = new Map<string, string>();
  for (const name of readdirSync(directory, { recursive: true, encoding: "utf8" })) {
    const file = join(directory, name);
    if (name.endsWith(".tmpl")) templates.set(`${TEMPLATES_DIRECTORY}/${name}`, readFileSync(file, "utf8"));
  }
  return templates;
}

/** The generated YAML files currently on disk in the two form folders (a form the registry dropped is a stale file to delete). */
function formFilesOnDisk(repositoryRoot: string): readonly string[] {
  return [ISSUE_FORMS_DIRECTORY, DISCUSSION_FORMS_DIRECTORY].flatMap((folder) => {
    const directory = join(repositoryRoot, folder);
    return existsSync(directory) ? readdirSync(directory).filter((name) => /\.ya?ml$/u.test(name)).map((name) => `${folder}/${name}`) : [];
  });
}

/**
 * Judges (and with `write`, rewrites) every generated community file of the
 * repository at `repositoryRoot`: a file whose text differs is rewritten, and
 * a form file the registry no longer declares is deleted (the form folders
 * hold generated files only).
 */
export function syncCommunityFiles(repositoryRoot: string, write: boolean): CommunityFilesReport {
  if (!hasCommunitySources(repositoryRoot)) return Object.freeze({ status: "absent", converged: true, changed: [] });
  const files = renderCommunityFiles(readTemplates(repositoryRoot), readCommunityFacts(repositoryRoot));
  const changed: string[] = [];
  for (const [path, text] of files) {
    const file = join(repositoryRoot, path);
    if (existsSync(file) && readFileSync(file, "utf8") === text) continue;
    changed.push(path);
    if (!write) continue;
    mkdirSync(dirname(file), { recursive: true });
    const written = atomicWriteFile(file, text);
    if (!written.success) throw new HarnessError(`Failed to write ${path}: ${written.reason ?? "unknown error"}`, "community_file_write_failed");
  }
  for (const path of formFilesOnDisk(repositoryRoot)) {
    if (files.has(path)) continue;
    changed.push(path);
    if (write) rmSync(join(repositoryRoot, path));
  }
  changed.sort();
  if (changed.length === 0) return Object.freeze({ status: "current", converged: true, changed: [] });
  return Object.freeze(write ? { status: "regenerated", converged: true, changed } : { status: "stale", converged: false, changed });
}
