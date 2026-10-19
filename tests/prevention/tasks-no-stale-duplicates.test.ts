// @vitest-environment node
/**
 * Prevention: a task must not be listed in BOTH the open
 * (`[ ]`) and completed (`[x]`) sections of TASKS.md. This round hit that
 * drift"Menu arrows" and "hamburger menu" were unchecked in the Active
 * section AND marked done in the Completed section, making a fix agent
 * believe they were undone and re-verify them. This test mechanically catches
 * the drift so a task marked done in one place cannot stay open in another.
 *
 * Scans docs/trackers/TASKS.md (the task tracker) through the one task-row
 * parser. A task title is the `**Title**` run of each checkbox row. A title appearing on
 * both a `[ ]` and a `[x]` line is a stale duplicate → fail.
 */
import { describe, test, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { taskRows } from "../../engine/src/workflow/failure-owners.ts";

const tasksPath = resolve(__dirname, "../../docs/trackers/TASKS.md");

/** Open and closed titles, read by the ONE task-row parser (engine/src/workflow/failure-owners.ts `taskRows`). */
function collectTitles(): { open: Set<string>; done: Set<string> } {
  const open = new Set<string>();
  const done = new Set<string>();
  if (!existsSync(tasksPath)) return { open, done };
  for (const row of taskRows(readFileSync(tasksPath, "utf8"))) {
    // normalize: lowercase, collapse whitespace for a stable comparison key
    const key = row.id.trim().toLowerCase().replace(/\s+/g, " ");
    (row.done ? done : open).add(key);
  }
  return { open, done };
}

describe("TASKS.md — no stale duplicate entries", () => {
  test("no task title appears in both the open ([ ]) and done ([x]) sections", () => {
    const { open, done } = collectTitles();
    const dups: string[] = [];
    for (const title of open) {
      if (done.has(title)) dups.push(title);
    }
    expect(
      dups,
      `These task titles are listed in BOTH [ ] and [x] sections (stale duplicates — mark one consistently):\n${dups.join("\n")}`,
    ).toEqual([]);
  });

  test("TASKS.md exists at the expected path", () => {
    expect(existsSync(tasksPath), `TASKS.md not found at ${tasksPath}`).toBe(true);
  });
});
