#!/usr/bin/env -S node --experimental-strip-types
/**
 * LESSONS — validated creation and the pending workflow report.
 *
 *   npm run lessons -- pending [--root <checkout>]
 *   npm run lessons -- create --help
 *
 * Reads every `docs/trackers/workflow-lessons/*.md` through the one entry
 * reader (`scripts/verification/tracker-entries.ts`) and prints, as JSON, each
 * `pending` lesson's id, route (the task that acts on it), kind and age in
 * days, oldest first. The coordinator runs it between rounds; a lesson that
 * sits pending round after round is visible here, never in a date-dependent
 * gate (a test that turns red on a calendar day with no code change is not
 * hermetic).
 */

import { atomicWriteFile } from "../../src/filesystem/atomic-write.ts";
import { createTransactionalEditor, type EditResult } from "../../src/editor/transactional-editor.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { canonicalJson, deepFreeze, sha256 } from "../../src/kernel/integrity.ts";
import { InputError } from "../../src/kernel/errors.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";
import { listValue, parseFrontMatter, readEntries } from "../../src/workflow/failure-owners.ts";
import { lessonId, lessonViolations, LESSON_KINDS, LESSON_STATUSES, LESSONS_DIRECTORY } from "../verification/tracker-entries.ts";


/** Metadata types come from the same values the commit guard judges. */
export type LessonDraft = Readonly<{
  name: string;
  source: string;
  kind: (typeof LESSON_KINDS)[number];
  observation: string;
  lesson: string;
  change: string;
} & (
  | { status: "pending"; route: string; actedIn?: never; reason?: never }
  | { status: "acted"; actedIn: readonly string[]; route?: never; reason?: never }
  | { status: "wontfix"; reason: string; route?: never; actedIn?: never }
)>;

export type RenderedLesson = Readonly<{ id: string; path: string; content: string }>;
export type LessonCreation = Readonly<{ id: string; path: string; edit: EditResult }>;

function metadataString(value: string, field: string): string {
  if (typeof value !== "string" || value.includes("\r") || value.includes("\n")) {
    throw new InputError(field + " must be a single-line string", "lessons_metadata_invalid");
  }
  return value;
}

/** Render first, then judge the result through the existing lesson schema.
 * The optional tracked set belongs to the caller; staged path existence is
 * still judged by the normal commit guard when the record is committed. */
export function renderLesson(draft: LessonDraft, tracked?: ReadonlySet<string>): RenderedLesson {
  const name = metadataString(draft.name, "name");
  const id = lessonId(name);
  const fields: [string, string][] = [
    ["id", id], ["date", name.slice(0, 10)],
    ["source", metadataString(draft.source, "source")],
    ["kind", metadataString(draft.kind, "kind")],
    ["status", metadataString(draft.status, "status")],
  ];
  if (draft.route !== undefined) fields.push(["route", metadataString(draft.route, "route")]);
  if (draft.actedIn !== undefined) {
    if (!Array.isArray(draft.actedIn)) throw new InputError("actedIn must be a list", "lessons_metadata_invalid");
    const items = draft.actedIn.map((item) => metadataString(item, "actedIn"));
    const value = "[" + items.join(", ") + "]";
    if (JSON.stringify(listValue(value)) !== JSON.stringify(items)) {
      throw new InputError("actedIn items must roundtrip through the existing list format", "lessons_metadata_invalid");
    }
    fields.push(["acted_in", value]);
  }
  if (draft.reason !== undefined) fields.push(["reason", metadataString(draft.reason, "reason")]);
  const sections = [["Observation", draft.observation], ["Lesson", draft.lesson], ["Change", draft.change]] as const;
  for (const [name, body] of sections) if (typeof body !== "string") {
    throw new InputError(name + " must be a string", "lessons_metadata_invalid");
  }
  const content = "---\n" + fields.map(([field, value]) => field + ": " + value).join("\n")
    + "\n---\n\n" + sections.map(([name, body]) => "## " + name + "\n\n" + body + "\n").join("\n");
  const problems = lessonViolations(name, content, tracked);
  if (problems.length > 0) throw new InputError(problems.join("\n"), "lessons_metadata_invalid");
  return deepFreeze({ id, path: LESSONS_DIRECTORY + "/" + name, content });
}

/** Create only: no caller can turn this path into a replacement operation.
 * The existing editor owns preimages and verification; its shared exclusive
 * atomic writer also refuses a target created after the preimage was read. */
export function createLesson(root: string, draft: LessonDraft, preimageHash: string): LessonCreation {
  const rendered = renderLesson(draft);
  if (typeof preimageHash !== "string" || preimageHash.toLowerCase() !== sha256("")) {
    throw new InputError("creation requires the explicit SHA-256 of the empty preimage", "lessons_preimage_invalid");
  }
  const editor = createTransactionalEditor({
    repositoryRoot: root,
    writeSet: new Set([rendered.path]),
    skipUnknownExtensions: true,
    atomicWriter: (path, content) => atomicWriteFile(path, content, {
      exclusive: true, createParentDirectories: false,
      createMode: ROOT_POLICY.filesystem.rawFileModes.source,
    }),
  });
  const edit = editor.applyEdit({ path: rendered.path, preimageHash, operation: { kind: "replaceFile", newContent: rendered.content } });
  return deepFreeze({ id: rendered.id, path: rendered.path, edit });
}

const CREATE_USAGE = "lessons create --name <YYYY-MM-DD-slug.md> --source <text> --kind <" + LESSON_KINDS.join("|")
  + "> --status <" + LESSON_STATUSES.join("|") + "> --observation <text> --lesson <text> --change <text>"
  + " --preimage-sha256 <empty SHA-256> [--root <checkout>] [--route <task> | --acted-in <path>... | --reason <text>]";
const CREATE_OPTIONS = new Set(["--name", "--source", "--kind", "--status", "--observation", "--lesson", "--change", "--preimage-sha256", "--root", "--route", "--acted-in", "--reason"]);

function createArguments(argv: readonly string[]): Readonly<{ root: string; draft: LessonDraft; preimageHash: string }> {
  const values = new Map<string, string>();
  const actedIn: string[] = [];
  const usage = (message: string): never => { throw new InputError(message + "\nusage: " + CREATE_USAGE, "lessons_usage"); };
  for (let at = 0; at < argv.length; at += 2) {
    const option = argv[at]!;
    const value = argv[at + 1];
    if (!CREATE_OPTIONS.has(option)) usage("unknown create option " + option);
    if (value === undefined || value.startsWith("--")) return usage(option + " needs a value");
    if (option === "--acted-in") actedIn.push(value);
    else {
      if (values.has(option)) usage("duplicate create option " + option);
      values.set(option, value);
    }
  }
  const required = (option: string): string => values.get(option) ?? usage(option + " is required");
  const enumeration = <T extends string>(option: string, allowed: readonly T[]): T => {
    const value = required(option);
    if (!(allowed as readonly string[]).includes(value)) usage(option + " must be one of " + allowed.join(", "));
    return value as T;
  };
  // CLI strings are still untrusted here. renderLesson performs the canonical
  // runtime judgement, including each status-specific field, before any write.
  const draft = {
    name: required("--name"), source: required("--source"), kind: enumeration("--kind", LESSON_KINDS),
    status: enumeration("--status", LESSON_STATUSES), observation: required("--observation"),
    lesson: required("--lesson"), change: required("--change"),
    ...(values.has("--route") ? { route: values.get("--route")! } : {}),
    ...(actedIn.length > 0 ? { actedIn } : {}),
    ...(values.has("--reason") ? { reason: values.get("--reason")! } : {}),
  } as LessonDraft;
  return { root: values.get("--root") ?? process.cwd(), draft, preimageHash: required("--preimage-sha256") };
}

/** Existing reporting plus validated, new-file-only creation. */
export function lessonsCommand(argv: readonly string[], now: Date): string {
  if (argv[0] === "pending") return lessonsReport(argv, now);
  if (argv[0] !== "create") throw new InputError("usage: lessons pending [--root <checkout>] | " + CREATE_USAGE, "lessons_usage");
  if (argv.length === 2 && argv[1] === "--help") return canonicalJson({
    usage: CREATE_USAGE, kinds: LESSON_KINDS, statuses: LESSON_STATUSES, preimageSha256: sha256(""),
  });
  const { root, draft, preimageHash } = createArguments(argv.slice(1));
  const result = createLesson(root, draft, preimageHash);
  if (!result.edit.success) throw new InputError(result.edit.feedback?.message ?? "lesson creation refused", "lessons_write_refused");
  return canonicalJson({ created: { id: result.id, path: result.path, postimageHash: result.edit.postimageHash } });
}

const DAY_MS = 86_400_000;

export type PendingLesson = Readonly<{ id: string; route: string | null; kind: string | null; ageDays: number | null }>;

/** The pending lessons of the checkout at `root`, oldest first, aged at `now`. */
export function pendingLessons(root: string, now: Date): readonly PendingLesson[] {
  return readEntries(root, LESSONS_DIRECTORY)
    .flatMap(({ name, text }) => {
      const fields = parseFrontMatter(text)?.fields;
      if (fields?.get("status") !== "pending") return [];
      const date = Date.parse(`${fields.get("date") ?? ""}T00:00:00Z`);
      return [{
        id: lessonId(name),
        route: fields.get("route") ?? null,
        kind: fields.get("kind") ?? null,
        ageDays: Number.isNaN(date) ? null : Math.floor((now.getTime() - date) / DAY_MS),
      }];
    })
    .sort((left, right) => (right.ageDays ?? 0) - (left.ageDays ?? 0) || left.id.localeCompare(right.id));
}

export function lessonsReport(argv: readonly string[], now: Date): string {
  const [command] = argv;
  if (command !== "pending") throw new InputError("usage: lessons pending [--root <checkout>]", "lessons_usage");
  const at = argv.indexOf("--root");
  const root = at < 0 ? process.cwd() : argv[at + 1];
  if (root === undefined) throw new InputError("--root needs a checkout path", "lessons_usage");
  return canonicalJson({ pending: pendingLessons(root, now) });
}

if (isEntryPoint(import.meta.url)) {
  bootstrapProcess({ role: "cli" });
  try {
    process.stdout.write(`${lessonsCommand(process.argv.slice(2), new Date())}\n`);
  } catch (error) {
    process.stderr.write(`${canonicalJson({ error: (error as { code?: string }).code ?? "lessons_failed", message: (error as Error).message })}\n`);
    process.exitCode = 1;
  }
}
