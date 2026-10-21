/**
 * THE COMMUNITY SOURCES: the role table (`docs/community/roles.json`) and the
 * intake registry (`docs/community/intake.json`), read and validated in ONE
 * place. Every consumer — the generated health files and forms, the IssueOps
 * authorisation, the teams the forge applies — reads them through here, so a
 * role, a form or a Discussion category is declared once.
 *
 * A source that is missing where it is required, malformed, or inconsistent
 * (a member naming no role, two roles on one team, a contact link naming no
 * category) is the typed `community_source_invalid`, naming the file.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { InputError } from "../../kernel/errors.ts";

/** The community sources' folder, repository-relative. */
export const COMMUNITY_DIRECTORY = "docs/community";
export const ROLES_PATH = `${COMMUNITY_DIRECTORY}/roles.json`;
export const INTAKE_PATH = `${COMMUNITY_DIRECTORY}/intake.json`;

/** GitHub's repository permission levels, weakest first (`GET …/collaborators/{u}/permission` answers one). */
export const PERMISSION_LEVELS = Object.freeze(["read", "triage", "write", "maintain", "admin"] as const);
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];

const ROLE = z.strictObject({
  id: z.string().regex(/^[a-z][a-z-]*$/u),
  title: z.string().min(1),
  team: z.string().regex(/^[a-z][a-z0-9-]*$/u).nullable(),
  permission: z.enum(PERMISSION_LEVELS),
  access: z.string().min(1),
  earnedBy: z.string().min(1),
  /** Whether this role's approval counts as independent verification (UR-09) on a pull request its holder did not author. */
  verifies: z.boolean(),
});

const ROLES = z.strictObject({
  schema: z.literal("bridlewise-community-roles/v1"),
  roles: z.array(ROLE).min(1),
  members: z.array(z.strictObject({ login: z.string().regex(/^[A-Za-z0-9-]+$/u), role: z.string() })),
  conduct: z.strictObject({ contact: z.string().min(1) }),
});

const FIELD = z.strictObject({
  kind: z.enum(["textarea", "input", "dropdown"]),
  id: z.string().regex(/^[a-z][a-z0-9-]*$/u),
  label: z.string().min(1),
  description: z.string().optional(),
  placeholder: z.string().optional(),
  render: z.string().optional(),
  options: z.array(z.string()).optional(),
  required: z.boolean(),
});

const ISSUE_FORM = z.strictObject({
  file: z.string().regex(/^[a-z][a-z0-9-]*\.yml$/u),
  name: z.string().min(1),
  description: z.string().min(1),
  /** The issue type the form sets (the org's issue-type registry names it). */
  type: z.string().min(1),
  fields: z.array(FIELD).min(1),
});

const CATEGORY = z.strictObject({
  slug: z.string().regex(/^[a-z][a-z0-9-]*$/u),
  name: z.string().min(1),
  /** GitHub's category format, as its UI names it. */
  format: z.enum(["announcement", "open-ended", "question-answer", "poll"]),
  postedBy: z.string().min(1),
  use: z.string().min(1),
  form: z.strictObject({ title: z.string(), fields: z.array(FIELD).min(1) }).optional(),
});

const CONTACT_LINK = z.strictObject({
  name: z.string().min(1),
  about: z.string().min(1),
  category: z.string().optional(),
  advisory: z.literal(true).optional(),
});

const INTAKE = z.strictObject({
  schema: z.literal("bridlewise-community-intake/v1"),
  warning: z.string().min(1),
  issueForms: z.array(ISSUE_FORM).min(1),
  confirmations: z.array(z.string().min(1)),
  contactLinks: z.array(CONTACT_LINK),
  discussionCategories: z.array(CATEGORY).min(1),
});

export type CommunityRole = z.infer<typeof ROLE>;
export type CommunityRoles = z.infer<typeof ROLES>;
export type FormField = z.infer<typeof FIELD>;
export type IssueForm = z.infer<typeof ISSUE_FORM>;
export type DiscussionCategory = z.infer<typeof CATEGORY>;
export type CommunityIntake = z.infer<typeof INTAKE>;

function invalid(path: string, why: string): never {
  throw new InputError(`${path} is invalid: ${why}`, "community_source_invalid", { path });
}

function readSource<T>(repositoryRoot: string, path: string, schema: z.ZodType<T>): T {
  const file = join(repositoryRoot, path);
  if (!existsSync(file)) invalid(path, "the file is missing");
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    invalid(path, `not JSON (${(error as Error).message})`);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) invalid(path, parsed.error.issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`).join("; "));
  return parsed.data;
}

function duplicates(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
}

/** Whether the repository carries community sources at all (a tree without the folder is converged by absence). */
export function hasCommunitySources(repositoryRoot: string): boolean {
  return existsSync(join(repositoryRoot, ROLES_PATH));
}

/** The role table, validated: unique ids and teams, permissions strictly rising, every member's role declared. */
export function readRoles(repositoryRoot: string): CommunityRoles {
  const roles = readSource(repositoryRoot, ROLES_PATH, ROLES);
  const ids = roles.roles.map((role) => role.id);
  const repeated = [...duplicates(ids), ...duplicates(roles.roles.flatMap((role) => (role.team === null ? [] : [role.team])))];
  if (repeated.length > 0) invalid(ROLES_PATH, `declared twice: ${repeated.join(", ")}`);
  roles.roles.forEach((role, index) => {
    const previous = roles.roles[index - 1];
    if (previous !== undefined && PERMISSION_LEVELS.indexOf(role.permission) <= PERMISSION_LEVELS.indexOf(previous.permission)) {
      invalid(ROLES_PATH, `role ${role.id} must grant more than ${previous.id} (the ladder rises)`);
    }
  });
  const unknown = roles.members.filter((member) => !ids.includes(member.role));
  if (unknown.length > 0) invalid(ROLES_PATH, `members name undeclared roles: ${unknown.map((member) => `${member.login} → ${member.role}`).join(", ")}`);
  return roles;
}

/** The intake registry, validated: unique form files and category slugs, every contact link resolvable. */
export function readIntake(repositoryRoot: string): CommunityIntake {
  const intake = readSource(repositoryRoot, INTAKE_PATH, INTAKE);
  const slugs = intake.discussionCategories.map((category) => category.slug);
  const repeated = [...duplicates(intake.issueForms.map((form) => form.file)), ...duplicates(slugs)];
  if (repeated.length > 0) invalid(INTAKE_PATH, `declared twice: ${repeated.join(", ")}`);
  if (intake.issueForms.some((form) => form.file === "config.yml")) invalid(INTAKE_PATH, "config.yml is the chooser's file, never a form");
  for (const link of intake.contactLinks) {
    if ((link.category === undefined) === (link.advisory === undefined)) invalid(INTAKE_PATH, `contact link ${link.name} must name exactly one of a category or the advisory`);
    if (link.category !== undefined && !slugs.includes(link.category)) invalid(INTAKE_PATH, `contact link ${link.name} names no declared category (${link.category})`);
  }
  return intake;
}

/** The weakest role whose permission `level` reaches (the role a collaborator's permission answer grants), or the first role. */
export function roleForPermission(roles: CommunityRoles, level: PermissionLevel): CommunityRole {
  const rank = PERMISSION_LEVELS.indexOf(level);
  const reached = roles.roles.filter((role) => PERMISSION_LEVELS.indexOf(role.permission) <= rank);
  return reached.at(-1) ?? roles.roles[0]!;
}

/** The teams the role table declares, for the forge to apply: each team with its repository permission. */
export function teamsOf(roles: CommunityRoles): readonly Readonly<{ team: string; permission: PermissionLevel; role: string }>[] {
  return roles.roles.flatMap((role) => (role.team === null ? [] : [Object.freeze({ team: role.team, permission: role.permission, role: role.id })]));
}
