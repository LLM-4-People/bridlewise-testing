/**
 * WORKFLOW LESSONS ARE ONE FILE PER LESSON, IN ONE FORMAT.
 *
 * Lessons used to be appended to monolithic trackers that every parallel
 * branch edited (guaranteed conflicts) and whose rows nobody could query.
 * `docs/trackers/workflow-lessons/<YYYY-MM-DD>-<slug>.md` holds one lesson per
 * file with a front matter a machine can read; `npm run lessons -- pending`
 * lists the pending ones with their route, kind and age.
 *
 * The format is judged by the one checker (`engine/scripts/verification/tracker-entries.ts`):
 * `id` is `L-` plus the file stem; the date matches the name; `kind` and
 * `status` are enumerations; a `pending` lesson names its `route` (the task
 * that acts on it); an `acted` lesson names `acted_in` repository paths —
 * never a commit SHA (the commit carries a `Lesson:` trailer instead), and
 * held by git in the commit that writes the lesson (the commit door judges
 * that, once: a later rename never reopens a closed record); a `wontfix`
 * lesson gives a `reason`; the three sections are present. Nothing here
 * depends on the calendar: a lesson's age belongs to the report, not the gate.
 */
import { describe, expect, test } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LESSONS_DIRECTORY, lessonViolations, readEntries } from "../../engine/scripts/verification/tracker-entries.ts";
import { lessonsReport } from "../../engine/scripts/tooling/lessons.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

const ROOT = process.cwd();

describe("workflow lessons", () => {
  test("the format check refuses each broken shape (planted)", () => {
    const tracked = new Set(["engine/src/a.ts"]);
    const good = "---\nid: L-2026-01-01-a\ndate: 2026-01-01\nsource: x\nkind: tooling\nstatus: pending\nroute: WF-1\n---\n## Observation\n## Lesson\n## Change\n";
    const acted = good.replace("status: pending\nroute: WF-1", "status: acted\nacted_in: [engine/src/a.ts]");
    expect(lessonViolations("2026-01-01-a.md", good, tracked)).toEqual([]);
    expect(lessonViolations("2026-01-01-a.md", acted, tracked)).toEqual([]);
    const broken: Record<string, string> = {
      "unknown status": good.replace("status: pending", "status: done"),
      "pending without a route": good.replace("route: WF-1\n", ""),
      "no kind": good.replace("kind: tooling\n", ""),
      "unknown kind": good.replace("kind: tooling", "kind: vibes"),
      "acted without acted_in": acted.replace("acted_in: [engine/src/a.ts]\n", ""),
      "acted_in names an untracked path": acted.replace("engine/src/a.ts", "no/such/path.ts"),
      "acted_in names a commit id": acted.replace("engine/src/a.ts", "1af9184b"),
      "acted_in is not a list": acted.replace("[engine/src/a.ts]", "engine/src/a.ts"),
      "wontfix without a reason": good.replace("status: pending\nroute: WF-1", "status: wontfix"),
      "a missing section": good.replace("## Change\n", ""),
      "an id that is not the stem": good.replace("id: L-2026-01-01-a", "id: L-2026-01-01-b"),
      "a date that is not the name's": good.replace("date: 2026-01-01", "date: 2026-01-02"),
      // wf-1b3a-correctness L4: each conditional field belongs to its status alone, and a field is spelled once.
      "a route on an acted lesson": acted.replace("status: acted", "status: acted\nroute: WF-1"),
      "acted_in on a pending lesson": good.replace("route: WF-1", "route: WF-1\nacted_in: [engine/src/a.ts]"),
      "a reason on a pending lesson": good.replace("route: WF-1", "route: WF-1\nreason: r"),
      "a field spelled twice": good.replace("kind: tooling", "kind: tooling\nkind: guard"),
    };
    for (const [shape, text] of Object.entries(broken)) expect(lessonViolations("2026-01-01-a.md", text, tracked).length, shape).toBe(1);
    expect(lessonViolations("lesson.md", good, tracked).length).toBe(1);
  });

  test("every lesson file is well formed (its acted_in paths judged by shape: whether git holds them is judged by the commit that writes them)", () => {
    const lessons = readEntries(ROOT, LESSONS_DIRECTORY);
    expect(lessons.length).toBeGreaterThan(0);
    expect(lessons.flatMap(({ name, text }) => lessonViolations(name, text))).toEqual([]);
  });

  test("a closed record stays green when a path it names is later renamed or deleted; a path of the wrong shape never passes", () => {
    // wf-1b3a-design M2: the tree check belongs to the commit that writes the record (commit-compile-door.test.ts).
    const acted = "---\nid: L-2026-01-01-a\ndate: 2026-01-01\nsource: x\nkind: tooling\nstatus: acted\nacted_in: [engine/src/since-deleted.ts]\n---\n## Observation\n## Lesson\n## Change\n";
    expect(lessonViolations("2026-01-01-a.md", acted)).toEqual([]);
    for (const wrong of ["/abs/engine/src/a.ts", "~/x.ts", "engine/../x.ts"]) expect(lessonViolations("2026-01-01-a.md", acted.replace("engine/src/since-deleted.ts", wrong)).length, wrong).toBe(1);
  });

  test("the pending report lists pending lessons only, oldest first, with route, kind and age", () => {
    const root = createTempDir("lessons-report-");
    const directory = join(root, LESSONS_DIRECTORY);
    mkdirSync(directory, { recursive: true });
    const lesson = (date: string, status: string): string =>
      `---\nid: L-${date}-x\ndate: ${date}\nsource: s\nkind: guard\nstatus: ${status}\n---\n## Observation\n## Lesson\n## Change\n`;
    writeFileSync(join(directory, "2026-01-02-x.md"), lesson("2026-01-02", "pending\nroute: T-1"));
    writeFileSync(join(directory, "2026-01-01-x.md"), lesson("2026-01-01", "pending\nroute: T-2"));
    writeFileSync(join(directory, "2026-01-03-x.md"), lesson("2026-01-03", "acted\nacted_in: [a.ts]"));
    const report = JSON.parse(lessonsReport(["pending", "--root", root], new Date("2026-01-11T12:00:00Z"))) as { pending: unknown[] };
    expect(report.pending).toEqual([
      { ageDays: 10, id: "L-2026-01-01-x", kind: "guard", route: "T-2" },
      { ageDays: 9, id: "L-2026-01-02-x", kind: "guard", route: "T-1" },
    ]);
    let refusal: unknown;
    try { lessonsReport(["stale"], new Date()); } catch (error) { refusal = error; }
    expect((refusal as { code?: unknown } | undefined)?.code).toBe("lessons_usage");
  });
});
