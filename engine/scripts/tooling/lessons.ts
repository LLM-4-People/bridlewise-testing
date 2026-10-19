#!/usr/bin/env -S node --experimental-strip-types
/**
 * LESSONS REPORT — the workflow lessons still waiting for their change.
 *
 *   npm run lessons -- pending [--root <checkout>]
 *
 * Reads every `docs/trackers/workflow-lessons/*.md` through the one entry
 * reader (`scripts/verification/tracker-entries.ts`) and prints, as JSON, each
 * `pending` lesson's id, route (the task that acts on it), kind and age in
 * days, oldest first. The coordinator runs it between rounds; a lesson that
 * sits pending round after round is visible here, never in a date-dependent
 * gate (a test that turns red on a calendar day with no code change is not
 * hermetic).
 */

import { canonicalJson } from "../../src/kernel/integrity.ts";
import { InputError } from "../../src/kernel/errors.ts";
import { bootstrapProcess, isEntryPoint } from "../../src/runtime/cli-debug.ts";
import { lessonId, LESSONS_DIRECTORY, parseFrontMatter, readEntries } from "../verification/tracker-entries.ts";

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
    process.stdout.write(`${lessonsReport(process.argv.slice(2), new Date())}\n`);
  } catch (error) {
    process.stderr.write(`${canonicalJson({ error: (error as { code?: string }).code ?? "lessons_failed", message: (error as Error).message })}\n`);
    process.exitCode = 1;
  }
}
