/**
 * THE STRUCTURED TRACKER (src/workflow/failure-owners.ts): one item file per
 * task (`bridlewise-tracker-item/v1`), refused whole when any item breaks the
 * format, and the task board rendered from the items alone — so a board row is
 * exactly its item, the guards that read rows read the items, and a stale
 * board fails `harness check`.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { TRACKER_BOARD } from "../../src/kernel/verification-paths.ts";
import {
  itemRow, readEntries, readTrackerItems, rebaseRelativeLinks, renderTrackerBoard, syncTrackerBoard, taskRows,
  trackerItems, trackerItemViolations, withTrackerBoard, type TrackerItem,
} from "../../src/workflow/failure-owners.ts";
import { createTempDir } from "../support/temp-dir.ts";

const REPOSITORY_ROOT = join(import.meta.dirname, "..", "..", "..");

const item = (id: string, fields: Record<string, string>, body = "The outcome."): { name: string; text: string } => ({
  name: `${id}.md`,
  text: `---\n${Object.entries({ schema: "bridlewise-tracker-item/v1", id, type: "Task", state: "open", lane: "floor", opened: "2026-10-20", ...fields })
    .filter(([, value]) => value.length > 0).map(([name, value]) => `${name}: ${value}`).join("\n")}\n---\n\n${body}\n`,
});

test("a well-formed set of items is read in id order with every field typed", () => {
  const items = trackerItems([
    item("B-TWO", { state: "closed", resolution: "completed", closed: "2026-10-21", parent: "A-ONE", "blocked-by": "[A-ONE]", severity: "P1", area: "[engine, web]", gh: "#31", evidence: "evidence:runs/a.json" }),
    item("A-ONE", { title: "Give the board a source", type: "Workstream" }),
  ]);
  assert.deepEqual(items.map((entry) => entry.id), ["A-ONE", "B-TWO"]);
  assert.equal(items[0]!.title, "Give the board a source");
  assert.deepEqual({ ...items[1]!, body: undefined }, {
    id: "B-TWO", type: "Task", order: null, title: null, state: "closed", resolution: "completed", lane: "floor", ownerRole: null, milestone: null,
    parent: "A-ONE", blockedBy: ["A-ONE"], relates: [], severity: "P1", area: ["engine", "web"], evidence: "evidence:runs/a.json", gh: "#31",
    decisions: [], tests: [], checks: [], rfc: null, goodFirst: false, closedBy: null,
    opened: "2026-10-20", closed: "2026-10-21", body: undefined,
  });
});

test("the roadmap fields: a Milestone with its order, a milestone reference, and the evidence links", () => {
  const items = trackerItems([
    item("M1", { type: "Milestone", title: "Reproducible floor", order: "1" }),
    item("W-ONE", { milestone: "M1", decisions: "[UR-17, Q-TX1]", tests: "[engine/test/a.test.ts]", checks: "[testing.ci, web-suite]", rfc: "discussion#4", "good-first": "true" }),
    item("W-TWO", { milestone: "M1", state: "closed", resolution: "completed", closed: "2026-10-21", "closed-by": "0123abcd" }),
  ]);
  const [milestone, one, two] = items;
  assert.equal(milestone!.type, "Milestone");
  assert.equal(milestone!.order, 1);
  assert.equal(one!.milestone, "M1");
  assert.deepEqual([one!.decisions, one!.tests, one!.checks, one!.rfc, one!.goodFirst], [["UR-17", "Q-TX1"], ["engine/test/a.test.ts"], ["testing.ci", "web-suite"], "discussion#4", true]);
  assert.equal(two!.closedBy, "0123abcd");
  assert.equal(two!.goodFirst, false);
  for (const [entries, why] of [
    [[item("M1", { type: "Milestone" })], /order is required/u],
    [[item("A-ONE", { order: "2" })], /order does not belong/u],
    [[item("M1", { type: "Milestone", order: "01" })], /order 01 does not match/u],
    [[item("A-ONE", { milestone: "M9" })], /M9 names no Milestone item/u],
    [[item("A-ONE", { milestone: "B-TWO" }), item("B-TWO", {})], /B-TWO names no Milestone item/u],
    [[item("M1", { type: "Milestone", order: "1", milestone: "M1" })], /milestone does not belong/u],
    [[item("A-ONE", { decisions: "[not-an-id]" })], /decisions not-an-id does not match/u],
    [[item("A-ONE", { tests: "[/etc/passwd]" })], /tests \/etc\/passwd does not match/u],
    [[item("A-ONE", { tests: "[engine/../x.ts]" })], /tests engine\/\.\.\/x\.ts does not match/u],
    [[item("A-ONE", { checks: "[Testing CI]" })], /must be a non-empty|does not match/u],
    [[item("A-ONE", { rfc: "#4" })], /rfc #4 does not match/u],
    [[item("A-ONE", { "good-first": "yes" })], /good-first must be one of true/u],
    [[item("A-ONE", { "closed-by": "0123abcd" })], /closed-by does not belong/u],
    [[item("A-ONE", { state: "closed", resolution: "completed", closed: "2026-10-21", "closed-by": "XYZ" })], /closed-by XYZ does not match/u],
  ] as const) {
    assert.throws(() => trackerItems(entries), (error: unknown) => error instanceof Error && why.test(error.message), String(why));
  }
  // Near-misses: a three-word decision id with a lower-case suffix letter, a nested repository path, a dotted check id.
  assert.doesNotThrow(() => trackerItems([item("A-ONE", { decisions: "[D-W1, UR-24-BUDGETS, Q6]", tests: "[tests/unit/a-b.test.ts]", checks: "[product.code_scanning]" })]));
});

test("every way an item breaks the format is refused, and the whole set is refused typed", () => {
  for (const [entries, why] of [
    [[{ name: "lower-case.md", text: "" }], /named <ID>\.md/u],
    [[item("A-ONE", { id: "A-TWO" })], /id must be one of A-ONE/u],
    [[item("A-ONE", { type: "Chore" })], /type must be one of/u],
    [[item("A-ONE", { lane: "nowhere" })], /lane must be one of/u],
    [[item("A-ONE", { state: "closed" })], /closed is required/u],
    [[item("A-ONE", { resolution: "completed" })], /resolution does not belong/u],
    [[item("A-ONE", { closed: "2026-10-21" })], /closed does not belong/u],
    [[item("A-ONE", { state: "closed", resolution: "completed", closed: "2026-10-19" })], /closed 2026-10-19 is before opened 2026-10-20/u],
    [[item("A-ONE", { parent: "A-ONE" })], /A-ONE is this item itself/u],
    [[item("A-ONE", { "blocked-by": "[B-NONE]" })], /B-NONE names no item/u],
    [[item("A-ONE", { parent: "B-TWO" }), item("B-TWO", { parent: "A-ONE" })], /parent chain returns to/u],
    [[item("A-ONE", { title: "Colon: then a space" })], /not a plain YAML scalar/u],
    [[item("A-ONE", { gh: "31" })], /gh 31 does not match/u],
    [[item("A-ONE", { owner: "someone" })], /owner is not a field of this record/u],
    [[item("A-ONE", {}, "")], /the body is empty/u],
    [[{ name: "A-ONE.md", text: "no front matter\n" }], /no front matter/u],
  ] as const) {
    const problems = trackerItemViolations(entries);
    assert.ok(problems.some((problem) => why.test(problem)), `${String(why)} in ${problems.join(" | ")}`);
    assert.throws(() => trackerItems(entries), (error: Error & { code?: string }) => error.code === "tracker_item_invalid");
  }
});

test("a relative link in an item's body is rewritten to the same file as seen from the board", () => {
  assert.equal(rebaseRelativeLinks("see [x](../../floor/a.md#b), [y](https://e.org/z), [z](#here)", TRACKER_BOARD.items, "docs/trackers"),
    "see [x](../floor/a.md#b), [y](https://e.org/z), [z](#here)");
  assert.equal(rebaseRelativeLinks("[x](../floor/a.md)", "docs/trackers", TRACKER_BOARD.items), "[x](../../floor/a.md)");
});

test("the board renders open rows per lane (oldest first) and every closed row under Done (newest first)", () => {
  const items: TrackerItem[] = [...trackerItems([
    item("FLAKY-B", { lane: "flaky-burn-down", type: "Flake", opened: "2026-10-01" }),
    item("FLAKY-A", { lane: "flaky-burn-down", type: "Flake", opened: "2026-10-02" }),
    item("OLD-DONE", { state: "closed", resolution: "completed", closed: "2026-10-30" }),
    item("NEW-DONE", { state: "closed", resolution: "not-planned", closed: "2026-11-02", title: "Retire the thing" }, "Two lines,\nkept as continuation."),
  ])];
  assert.equal(renderTrackerBoard(items), [
    "## Flaky burn-down owners\n\n- [ ] **FLAKY-B** — The outcome.\n- [ ] **FLAKY-A** — The outcome.\n",
    "## Done\n\n- [x] **Retire the thing** — Two lines,\n  kept as continuation.\n- [x] **OLD-DONE** — The outcome.\n",
  ].join("\n"));
  // The row a guard reads back is the item: its id or title, its state, its whole text.
  const rows = taskRows(renderTrackerBoard(items));
  assert.deepEqual(rows.map((row) => [row.id, row.done]), [["FLAKY-B", false], ["FLAKY-A", false], ["Retire the thing", true], ["OLD-DONE", true]]);
  assert.equal(rows[2]!.text, itemRow(items.find((entry) => entry.id === "NEW-DONE")!));
});

test("a board without its block is refused, and a stale one is caught by check and rewritten by sync", () => {
  assert.equal(withTrackerBoard("# Tasks\n", "x"), null);
  const root = createTempDir("tracker-board-");
  mkdirSync(join(root, TRACKER_BOARD.items), { recursive: true });
  writeFileSync(join(root, TRACKER_BOARD.items, "A-ONE.md"), item("A-ONE", {}).text);
  writeFileSync(join(root, TRACKER_BOARD.path), `# Tasks\n\nprose\n\n${TRACKER_BOARD.begin}\n${TRACKER_BOARD.end}\n`);
  assert.deepEqual(syncTrackerBoard(root, false), { status: "stale", converged: false, changed: [TRACKER_BOARD.path] });
  assert.deepEqual(syncTrackerBoard(root, true), { status: "regenerated", converged: true, changed: [TRACKER_BOARD.path] });
  assert.equal(readFileSync(join(root, TRACKER_BOARD.path), "utf8"), `# Tasks\n\nprose\n\n${TRACKER_BOARD.begin}\n\n## Open\n\n- [ ] **A-ONE** — The outcome.\n\n${TRACKER_BOARD.end}\n`);
  assert.deepEqual(syncTrackerBoard(root, false), { status: "current", converged: true, changed: [] });
  writeFileSync(join(root, TRACKER_BOARD.path), "# Tasks\n");
  assert.throws(() => syncTrackerBoard(root, false), (error: Error & { code?: string }) => error.code === "tracker_board_block_missing");
  assert.deepEqual(syncTrackerBoard(createTempDir("tracker-board-none-"), false), { status: "absent", converged: true, changed: [] }, "a tree without items is converged by absence");
});

test("this repository's items are well formed and its board is their render, row for row", () => {
  const entries = readEntries(REPOSITORY_ROOT, TRACKER_BOARD.items);
  assert.deepEqual(trackerItemViolations(entries), []);
  assert.deepEqual(syncTrackerBoard(REPOSITORY_ROOT, false).status, "current");
  const items = readTrackerItems(REPOSITORY_ROOT);
  const rows = taskRows(readFileSync(join(REPOSITORY_ROOT, TRACKER_BOARD.path), "utf8"));
  assert.equal(rows.length, items.length, "every row is an item and every item a row");
  for (const entry of items) assert.ok(rows.some((row) => row.text === itemRow(entry) && row.done === (entry.state === "closed")), `${entry.id} is on the board`);
});
