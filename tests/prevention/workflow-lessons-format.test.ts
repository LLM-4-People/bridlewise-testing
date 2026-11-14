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
import { lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readEntries } from "../../engine/src/workflow/failure-owners.ts";
import { LESSON_KINDS, LESSON_STATUSES, LESSONS_DIRECTORY, lessonId, lessonViolations } from "../../engine/scripts/verification/tracker-entries.ts";
import { createLesson, lessonsCommand, lessonsReport, renderLesson, type LessonDraft } from "../../engine/scripts/tooling/lessons.ts";
import { modulePath } from "../helpers/module-resolver.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

import { sha256 } from "../../engine/src/kernel/integrity.ts";

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


const DRAFT: LessonDraft = {
  name: "2026-01-01-generated.md", source: "local fixture", kind: "tooling", status: "pending", route: "WF-1",
  observation: "Metadata was handwritten.", lesson: "Use its existing schema.", change: "Generate and validate before writing.",
};

function creationRoot(): string {
  const root = createTempDir("lessons-create-");
  mkdirSync(join(root, LESSONS_DIRECTORY), { recursive: true });
  return root;
}

function createArgs(root: string): string[] {
  return ["create", "--root", root, "--name", DRAFT.name, "--source", DRAFT.source, "--kind", DRAFT.kind,
    "--status", DRAFT.status, "--route", "WF-1", "--observation", DRAFT.observation, "--lesson", DRAFT.lesson,
    "--change", DRAFT.change, "--preimage-sha256", sha256("")];
}

describe("workflow lesson creation", () => {
  test("the renderer derives identity and path and accepts the canonical kinds and status-specific fields", () => {
    for (const kind of LESSON_KINDS) {
      const rendered = renderLesson({ ...DRAFT, kind });
      expect(rendered.id).toBe(lessonId(DRAFT.name));
      expect(rendered.path).toBe(LESSONS_DIRECTORY + "/" + DRAFT.name);
      expect(lessonViolations(DRAFT.name, rendered.content)).toEqual([]);
      expect(rendered.content).toContain("date: 2026-01-01\n");
      expect(rendered.content).toContain("kind: " + kind + "\n");
    }
    const { route: _route, ...base } = DRAFT;
    const states: readonly LessonDraft[] = [DRAFT,
      { ...base, status: "acted", actedIn: [modulePath("lessons.ts")] },
      { ...base, status: "wontfix", reason: "Already covered by its owner." },
    ];
    expect(states.map((state) => state.status)).toEqual(LESSON_STATUSES);
    for (const draft of states) expect(lessonViolations(draft.name, renderLesson(draft).content)).toEqual([]);
    expect(renderLesson({ ...base, status: "acted", actedIn: ["unheld.ts"] }).content).toContain("acted_in: [unheld.ts]");
    expect(() => renderLesson({ ...base, status: "acted", actedIn: ["unheld.ts"] }, new Set())).toThrow(/not a path git holds/u);
  });

  test("invalid enum, name, state, metadata encoding and body inputs refuse before any write", () => {
    const root = createTempDir("lessons-invalid-");
    const invalid = [
      { ...DRAFT, kind: "fix" }, { ...DRAFT, kind: "code" }, { ...DRAFT, status: "done" },
      { ...DRAFT, name: "../2026-01-01-escape.md" }, { ...DRAFT, source: "" },
      { ...DRAFT, status: "acted", actedIn: ["engine/a.ts"] },
      { ...DRAFT, route: undefined }, { ...DRAFT, source: "s\n---\nkind: code" },
      { ...DRAFT, source: "s\rkind: code" }, { ...DRAFT, source: 42 }, { ...DRAFT, observation: null },
      { ...DRAFT, route: undefined, status: "acted", actedIn: ["engine/a,b.ts"] },
      { ...DRAFT, route: undefined, status: "acted", actedIn: [" engine/a.ts"] },
    ] as unknown as readonly LessonDraft[];
    for (const draft of invalid) {
      expect(() => createLesson(root, draft, sha256(""))).toThrowError(expect.objectContaining({ code: "lessons_metadata_invalid" }));
      expect(readdirSync(root)).toEqual([]);
    }
  });

  test("creation requires the explicit empty preimage and an existing lesson directory", () => {
    const root = createTempDir("lessons-preimage-");
    expect(() => createLesson(root, DRAFT, sha256("other"))).toThrowError(expect.objectContaining({ code: "lessons_preimage_invalid" }));
    expect(readdirSync(root)).toEqual([]);
    expect(createLesson(root, DRAFT, sha256("")).edit.success).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  test("the normal editor creates canonical output once and refuses another creation", () => {
    const root = creationRoot();
    const result = createLesson(root, DRAFT, sha256(""));
    expect(result.edit.success).toBe(true);
    const target = join(root, result.path);
    const bytes = readFileSync(target);
    expect(result.edit.postimageHash).toBe(sha256(bytes.toString("utf8")));
    expect(lessonViolations(DRAFT.name, bytes.toString("utf8"))).toEqual([]);
    expect(createLesson(root, { ...DRAFT, observation: "Changed" }, sha256("")).edit.success).toBe(false);
    expect(readFileSync(target)).toEqual(bytes);
  });

  test("empty, nonempty, symlink and directory entries cannot be overwritten", () => {
    for (const kind of ["empty", "nonempty", "symlink", "directory"] as const) {
      const root = creationRoot();
      const target = join(root, LESSONS_DIRECTORY, DRAFT.name);
      const sentinel = join(root, "sentinel");
      writeFileSync(sentinel, "preserve sentinel\n");
      if (kind === "directory") mkdirSync(target);
      else if (kind === "symlink") symlinkSync(sentinel, target);
      else writeFileSync(target, kind === "empty" ? "" : "preserve record\n");
      const before = lstatSync(target);
      const bytes = kind === "directory" ? null : readFileSync(target);
      expect(createLesson(root, DRAFT, sha256("")).edit.success).toBe(false);
      const after = lstatSync(target);
      expect([after.dev, after.ino, after.mode]).toEqual([before.dev, before.ino, before.mode]);
      if (bytes !== null) expect(readFileSync(target)).toEqual(bytes);
      expect(readFileSync(sentinel, "utf8")).toBe("preserve sentinel\n");
    }
  });

  test("CLI help exposes canonical choices and invalid options leave the destination unchanged", () => {
    const root = creationRoot();
    const help = JSON.parse(lessonsCommand(["create", "--help"], new Date()));
    expect(help.kinds).toEqual(LESSON_KINDS);
    expect(help.statuses).toEqual(LESSON_STATUSES);
    expect(help.preimageSha256).toBe(sha256(""));
    const normal = createArgs(root);
    const invalid = [
      [...normal, "--unknown", "x"], [...normal, "--source", "duplicate"], [...normal, "--reason"],
      normal.filter((part, index) => part !== "--preimage-sha256" && normal[index - 1] !== "--preimage-sha256"),
      normal.map((part, index) => normal[index - 1] === "--kind" ? "code" : part),
    ];
    for (const args of invalid) {
      expect(() => lessonsCommand(args, new Date())).toThrowError(expect.objectContaining({ code: "lessons_usage" }));
      expect(readdirSync(join(root, LESSONS_DIRECTORY))).toEqual([]);
    }
    const output = JSON.parse(lessonsCommand(normal, new Date()));
    expect(output.created.id).toBe(lessonId(DRAFT.name));
    const text = readFileSync(join(root, output.created.path), "utf8");
    expect(lessonViolations(DRAFT.name, text)).toEqual([]);
    expect(output.created.postimageHash).toBe(sha256(text));
    expect(() => lessonsCommand(normal, new Date())).toThrowError(expect.objectContaining({ code: "lessons_write_refused" }));
  });
});
