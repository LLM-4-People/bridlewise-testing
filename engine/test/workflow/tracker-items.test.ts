/**
 * THE STRUCTURED TRACKER (src/workflow/failure-owners.ts): one item file per
 * task (`bridlewise-tracker-item/v1`), refused whole when any item breaks the
 * format, and the task board rendered from the items alone — so a board row is
 * exactly its item, the guards that read rows read the items, and a stale
 * board fails `harness check`.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { spliceGeneratedBlock, TRACKER_BOARD } from "../../src/kernel/verification-paths.ts";
import {
  boardRows, declaredNames, itemRow, ownersOf, readEntries, readTrackerItems, renderTrackerBoard, syncTrackerBoard, taskRows,
  trackerItems, trackerItemViolations, type TrackerItem,
} from "../../src/workflow/failure-owners.ts";
import { createTempDir } from "../support/temp-dir.ts";

const REPOSITORY_ROOT = join(import.meta.dirname, "..", "..", "..");

const item = (id: string, fields: Record<string, string>, body = "The outcome."): { name: string; text: string } => ({
  name: `${id}.md`,
  text: `---\n${Object.entries({ schema: "bridlewise-tracker-item/v1", published: "false", id, type: "Task", state: "open", lane: "floor", opened: "2026-10-20", ...fields })
    .filter(([, value]) => value.length > 0).map(([name, value]) => `${name}: ${value}`).join("\n")}\n---\n\n${body}\n`,
});

test("a well-formed set of items is read in id order with every field typed", () => {
  const items = trackerItems([
    item("B-TWO", { state: "closed", resolution: "completed", closed: "2026-10-21", parent: "A-ONE", "blocked-by": "[A-ONE]", severity: "P1", area: "[engine, web]", gh: "issue-31", evidence: "evidence:runs/a.json" }),
    item("A-ONE", { title: "Give the board a source", type: "Workstream" }),
  ]);
  assert.deepEqual(items.map((entry) => entry.id), ["A-ONE", "B-TWO"]);
  assert.equal(items[0]!.title, "Give the board a source");
  assert.deepEqual({ ...items[1]!, body: undefined }, {
    id: "B-TWO", type: "Task", title: null, state: "closed", resolution: "completed", lane: "floor", ownerRole: null, milestone: null,
    parent: "A-ONE", blockedBy: ["A-ONE"], relates: [], severity: "P1", area: ["engine", "web"], evidence: "evidence:runs/a.json", gh: "issue-31",
    order: null, horizon: null, decisions: [], tests: [], rfc: null, opened: "2026-10-20", closed: "2026-10-21", body: undefined,
  });
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
    // An item is a record, never a site page: the site renders its text only through the escaping renderers.
    [[item("A-ONE", { published: "" })], /published is required/u],
    [[item("A-ONE", { published: "true" })], /published must be one of false/u],
    // YAML reads ` #31` as a comment: the item would lose its GitHub link on the site.
    [[item("A-ONE", { gh: "#31" })], /gh #31 does not match/u],
    [[item("A-ONE", { title: "No" })], /reads as a YAML boolean, null or number/u],
    [[item("A-ONE", { title: "1.5" })], /reads as a YAML boolean, null or number/u],
    // A flaky owner is matched by its row id, so it is headed by its id.
    [[item("FLAKY-A", { lane: "flaky-burn-down", title: "A flaky lane" })], /title does not belong on this entry/u],
    // A body line shaped like a task row would be a second, phantom row on the board.
    [[item("A-ONE", { state: "closed", resolution: "completed", closed: "2026-10-21" }, "Done.\n- [ ] **PHANTOM** engine/test/x.test.ts")], /is a task row; a row is an item of its own/u],
    [[item("A-ONE", { owner: "someone" })], /owner is not a field of this record/u],
    [[item("A-ONE", {}, "")], /the body is empty/u],
    [[{ name: "A-ONE.md", text: "no front matter\n" }], /no front matter/u],
  ] as const) {
    const problems = trackerItemViolations(entries);
    assert.ok(problems.some((problem) => why.test(problem)), `${String(why)} in ${problems.join(" | ")}`);
    assert.throws(() => trackerItems(entries), (error: Error & { code?: string }) => error.code === "tracker_item_invalid");
  }
});

test("the roadmap's fields: a Milestone groups by `milestone` and has no lane or state; links, ranks and horizons are judged", () => {
  const milestone = (id: string, fields: Record<string, string> = {}): { name: string; text: string } => item(id, { type: "Milestone", state: "", lane: "", ...fields });
  const items = trackerItems([
    milestone("M1", { title: "Reproducible floor", order: "1" }),
    item("M1-WORK", { type: "Workstream", lane: "roadmap", milestone: "M1", horizon: "now", order: "0", decisions: "[D-04]", tests: "[engine/test/a.test.ts]", rfc: "discussion-7", evidence: "docs/floor/evidence.md#the-sharded-gate" }),
  ], { decisions: new Set(["D-04"]), exists: (path) => path === "engine/test/a.test.ts" });
  assert.deepEqual([items[0]!.state, items[0]!.lane, items[0]!.order], [null, null, 1]);
  assert.deepEqual([items[1]!.milestone, items[1]!.horizon, items[1]!.order, items[1]!.decisions, items[1]!.tests, items[1]!.rfc], ["M1", "now", 0, ["D-04"], ["engine/test/a.test.ts"], "discussion-7"]);
  assert.equal(renderTrackerBoard(items).includes("Reproducible floor"), false, "a Milestone is no board row");
  const context = { decisions: new Set(["D-04"]), exists: () => false };
  for (const [entries, why] of [
    [[milestone("M1", { state: "open" })], /state does not belong/u],
    [[milestone("M1", { lane: "roadmap" })], /lane does not belong/u],
    [[milestone("M1", { milestone: "M1" })], /milestone does not belong/u],
    [[item("A-ONE", { milestone: "B-TWO" }), item("B-TWO", {})], /B-TWO names no Milestone item/u],
    [[item("A-ONE", { parent: "M1" }), milestone("M1")], /M1 is a Milestone \(name it in milestone\)/u],
    [[item("A-ONE", { "blocked-by": "[M1]" }), milestone("M1")], /M1 is a Milestone/u],
    [[item("A-ONE", { "blocked-by": "[B-TWO]" }), item("B-TWO", { "blocked-by": "[A-ONE]" })], /blocked-by chain returns to/u],
    [[item("A-ONE", { state: "closed", resolution: "completed", closed: "2026-10-21", horizon: "now" })], /horizon does not belong/u],
    [[item("A-ONE", { horizon: "soon" })], /horizon must be one of now, next, later/u],
    [[item("A-ONE", { order: "-1" })], /order -1 does not match/u],
    [[item("A-ONE", { decisions: "[D-99]" })], /D-99 names no decision record/u],
    [[item("A-ONE", { tests: "[engine/test/missing.test.ts]" })], /is not a file of the repository/u],
    [[item("A-ONE", { tests: "[../outside.ts]" })], /is not a repository-relative path/u],
    [[item("A-ONE", { rfc: "discussion#7" })], /rfc discussion#7 does not match/u],
    [[item("A-ONE", { evidence: "/abs/path.md" })], /evidence \/abs\/path\.md does not match/u],
  ] as const) {
    const problems = trackerItemViolations(entries, context);
    assert.ok(problems.some((problem) => why.test(problem)), `${String(why)} in ${problems.join(" | ")}`);
  }
});

test("a relative link in an item's body reaches the board as the same file seen from the board; code is never a link", () => {
  const [row] = trackerItems([item("A-ONE", {}, "see [x](../../floor/a.md#b), [y](https://e.org/z) and `[c](../../a.md)`.")]);
  assert.equal(itemRow(row!), "- [ ] **A-ONE** — see [x](../floor/a.md#b), [y](https://e.org/z) and <code>[c](../../a.md)</code>\\.");
});

test("the board renders open rows per lane (oldest first) and every closed row under Done (newest first)", () => {
  const items: TrackerItem[] = [...trackerItems([
    item("FLAKY-B", { lane: "flaky-burn-down", type: "Flake", opened: "2026-10-01" }),
    item("FLAKY-A", { lane: "flaky-burn-down", type: "Flake", opened: "2026-10-02" }),
    item("OLD-DONE", { state: "closed", resolution: "completed", closed: "2026-10-30" }),
    item("NEW-DONE", { state: "closed", resolution: "not-planned", closed: "2026-11-02", title: "Retire the thing" }, "Two lines,\nkept as continuation."),
  ])];
  assert.equal(renderTrackerBoard(items), [
    "## Flaky burn-down owners\n\n- [ ] **FLAKY-B** — The outcome\\.\n- [ ] **FLAKY-A** — The outcome\\.\n",
    "## Done\n\n- [x] **Retire the thing** — Two lines, kept as continuation\\.\n- [x] **OLD-DONE** — The outcome\\.\n",
  ].join("\n"));
  // The row a guard reads back is the item: its id or title, its state, its whole text.
  const rows = taskRows(renderTrackerBoard(items));
  assert.deepEqual(rows.map((row) => [row.id, row.done]), [["FLAKY-B", false], ["FLAKY-A", false], ["Retire the thing", true], ["OLD-DONE", true]]);
  assert.equal(rows[2]!.text, itemRow(items.find((entry) => entry.id === "NEW-DONE")!));
});

test("no spelling of an item publishes markup on the board: raw HTML, an unclosed fence, Liquid and a kramdown attribute list are text", () => {
  const planted = [
    "<script>alert(1)</script> and <img src=x onerror=alert(1)>",
    "{% include evil.html %} {{ site.github }} {: onclick=\"alert(3)\"}",
    "[a link](javascript:alert(4)) and <!-- a comment -->",
    // Last: a fence never closed runs to the end of the body.
    "```\n<script>alert(2)</script> in a fence never closed",
  ].join("\n\n");
  const [planted0] = trackerItems([item("A-ONE", { title: "<b>bold</b> {{ site.x }} {% raw %}" }, planted)]);
  const row = itemRow(planted0!);
  for (const raw of ["<script", "<img", "<b>", "<!--", "{%", "{{", "{:", "javascript:"]) assert.ok(!row.includes(raw), `${raw} reached the board raw:\n${row}`);
  // What the board shows is still the item's text, read back by the owners judge (a test's path, whole).
  const [owner] = trackerItems([item("FLAKY-A", { lane: "flaky-burn-down", type: "Flake" }, "Owns engine/test/a_b.test.ts and `engine/test/c.test.ts`.")]);
  const read = declaredNames(taskRows(itemRow(owner!))[0]!);
  assert.ok(read.has("engine/test/a_b.test.ts") && read.has("engine/test/c.test.ts"), [...read].join(" "));
});

test("a phantom row in a body never reaches the board's owners: the item is refused before it renders", () => {
  const phantom = [item("A-ONE", { state: "closed", resolution: "completed", closed: "2026-10-21" }, "Done.\n- [ ] **PHANTOM** engine/test/x.test.ts")];
  assert.throws(() => trackerItems(phantom), (error: Error & { code?: string }) => error.code === "tracker_item_invalid");
});

test("a board without its block is refused, and a stale one is caught by check and rewritten by sync", () => {
  assert.equal(spliceGeneratedBlock("# Tasks\n", TRACKER_BOARD, "x"), null);
  const root = createTempDir("tracker-board-");
  mkdirSync(join(root, TRACKER_BOARD.items), { recursive: true });
  writeFileSync(join(root, TRACKER_BOARD.items, "A-ONE.md"), item("A-ONE", {}).text);
  writeFileSync(join(root, TRACKER_BOARD.path), `# Tasks\n\nprose\n\n${TRACKER_BOARD.begin}\n${TRACKER_BOARD.end}\n`);
  assert.deepEqual(syncTrackerBoard(root, false), { status: "stale", converged: false, changed: [TRACKER_BOARD.path], problems: [] });
  assert.deepEqual(syncTrackerBoard(root, true), { status: "regenerated", converged: true, changed: [TRACKER_BOARD.path], problems: [] });
  assert.equal(readFileSync(join(root, TRACKER_BOARD.path), "utf8"), `# Tasks\n\nprose\n\n${TRACKER_BOARD.begin}\n\n## Open\n\n- [ ] **A-ONE** — The outcome\\.\n\n${TRACKER_BOARD.end}\n`);
  assert.deepEqual(syncTrackerBoard(root, false), { status: "current", converged: true, changed: [], problems: [] });
  const synced = readFileSync(join(root, TRACKER_BOARD.path), "utf8");
  // A row typed by hand above or below the block owns nothing, and the check refuses it, unwritten.
  const handRow = "- [ ] **HAND-ROW** engine/test/x.test.ts\n";
  for (const planted of [`${handRow}\n${synced}`, `${synced}\n${handRow}`]) {
    writeFileSync(join(root, TRACKER_BOARD.path), planted);
    assert.deepEqual(ownersOf(boardRows(planted), "engine/test/x.test.ts"), [], "a hand row outside the block owns no failure");
    assert.equal(ownersOf(taskRows(planted), "engine/test/x.test.ts").length, 1, "the plant is a row the grammar sees");
    const refused = syncTrackerBoard(root, true);
    assert.equal(refused.status, "invalid");
    assert.match(refused.problems.join("\n"), /the row HAND-ROW is typed outside the generated board block/u);
    assert.equal(readFileSync(join(root, TRACKER_BOARD.path), "utf8"), planted, "an invalid board is never written");
  }
  writeFileSync(join(root, TRACKER_BOARD.path), "# Tasks\n");
  assert.match(syncTrackerBoard(root, false).problems.join(""), /carries no generated board block/u);
  assert.throws(() => boardRows("# Tasks\n"), (error: Error & { code?: string }) => error.code === "tracker_board_block_missing");
  rmSync(join(root, TRACKER_BOARD.path));
  assert.match(syncTrackerBoard(root, false).problems.join(""), /is missing while/u);
  // Deleting the items folder must not silence the check of a board that still carries its block.
  writeFileSync(join(root, TRACKER_BOARD.path), synced);
  rmSync(join(root, TRACKER_BOARD.items), { recursive: true });
  assert.match(syncTrackerBoard(root, false).problems.join(""), /carries the generated board block but docs\/trackers\/items is missing/u);
  assert.deepEqual(syncTrackerBoard(createTempDir("tracker-board-none-"), false), { status: "absent", converged: true, changed: [], problems: [] }, "a tree with neither items nor a block is converged by absence");
});

test("this repository's items are well formed and its board is their render, row for row", () => {
  const entries = readEntries(REPOSITORY_ROOT, TRACKER_BOARD.items);
  assert.deepEqual(trackerItemViolations(entries), []);
  assert.deepEqual(syncTrackerBoard(REPOSITORY_ROOT, false).status, "current");
  const items = readTrackerItems(REPOSITORY_ROOT);
  const board = readFileSync(join(REPOSITORY_ROOT, TRACKER_BOARD.path), "utf8");
  const rows = boardRows(board);
  assert.equal(taskRows(board).length, rows.length, "no row sits outside the generated block");
  const work = items.filter((entry) => entry.type !== "Milestone");
  assert.equal(rows.length, work.length, "every row is an item and every item but a Milestone a row");
  for (const entry of work) assert.ok(rows.some((row) => row.text === itemRow(entry) && row.done === (entry.state === "closed")), `${entry.id} is on the board`);
});
