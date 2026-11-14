/**
 * THE INTAKE RECORD, LANDED (`src/workflow/community/record.ts`): a triage
 * decision becomes a tracker item the tracker's own reader accepts, the board
 * is regenerated with it, and the commit reaches the forge only as a signed
 * twin on `intake/<id>`, with one ready pull request (found again on a
 * re-run) — against GH-3's fake forge over a real bare repository.
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveGitExecutable } from "../../src/git/git-adapter.ts";
import { configuredWorktreeGitPort } from "../../src/git/worktree-port.ts";
import { HarnessError } from "../../src/kernel/errors.ts";
import { DECISION_INDEX, ROADMAP_PAGE, TRACKER_BOARD } from "../../src/kernel/verification-paths.ts";
import { parseFrontMatter, readEntries, readTrackerItems } from "../../src/workflow/failure-owners.ts";
import type { IntakeRecord } from "../../src/workflow/community/issue-ops.ts";
import { regenerateRoadmapPage } from "../../src/workflow/roadmap-page.ts";
import { intakeItemText, itemPath, landIntakeRecord, recordBranch, writeIntakeRecord } from "../../src/workflow/community/record.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { forgeAt, initTempRepo, rawGit } from "../workspaces/workspace-test-support.ts";

const REPOSITORY = dirname(fileURLToPath(new URL("../../", import.meta.url)));
const DATES = { opened: "2026-10-21", closed: "2026-10-22" };

const ACCEPTED: IntakeRecord = {
  id: "ISSUE-40", type: "Flake", title: "Flaky record-links test 3 fails", state: "open", resolution: null,
  severity: "P2", milestone: "M1", parent: null, gh: "issue-40",
  body: "Reported in #40 through the Flake report form; the report is the issue's own text.",
};

/** A repository carrying the tracker's real reference closure, committed on `main`, tracking a bare forge remote. */
function trackerRepository(prefix: string, sourceRoot = REPOSITORY): Readonly<{ root: string; bare: string }> {
  // Read through the strict owner before copying: item relations are closed
  // by the complete item population; external decision and test references
  // are copied from those same parsed records, never a fixture spelling list.
  const items = readTrackerItems(sourceRoot);
  const decisions = new Set(items.flatMap((item) => item.decisions));
  const decisionDirectory = dirname(DECISION_INDEX.path);
  const decisionPaths = decisions.size === 0 ? [] : readEntries(sourceRoot, decisionDirectory)
    .filter(({ text }) => decisions.has(parseFrontMatter(text)?.fields.get("id") ?? ""))
    .map(({ name }) => join(decisionDirectory, name));
  const files = [...new Set([TRACKER_BOARD.path, ...decisionPaths, ...items.flatMap((item) => item.tests)])].sort();
  const { root, bare } = initTempRepo(prefix);
  mkdirSync(dirname(join(root, TRACKER_BOARD.items)), { recursive: true });
  cpSync(join(sourceRoot, TRACKER_BOARD.items), join(root, TRACKER_BOARD.items), { recursive: true });
  for (const path of files) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(sourceRoot, path), join(root, path));
  }
  assert.deepEqual(readTrackerItems(root), items, "the fixture retains the real tracker's validated reference closure");
  rawGit(root, ["add", "--", TRACKER_BOARD.items, ...files]);
  rawGit(root, ["commit", "-q", "-m", "tracker"]);
  rawGit(root, ["push", "-q", "origin", "main"]);
  return { root, bare };
}

test("the record writer's output carries a fresh roadmap: the real generator, run through the arm harness sync runs, shows the new record", async () => {
  // A small world with the real roadmap generator (linked, so it resolves its imports from this tree) and the
  // real page's generated markers: one milestone, the board, an evidence page without non-proofs.
  const root = createTempDir("community-record-roadmap-");
  rawGit(root, ["init", "-q", "-b", "main"]);
  mkdirSync(join(root, TRACKER_BOARD.items), { recursive: true });
  cpSync(join(REPOSITORY, TRACKER_BOARD.items, "M1.md"), join(root, TRACKER_BOARD.items, "M1.md"));
  cpSync(join(REPOSITORY, TRACKER_BOARD.path), join(root, TRACKER_BOARD.path));
  mkdirSync(join(root, ROADMAP_PAGE.generator, ".."), { recursive: true });
  symlinkSync(join(REPOSITORY, ROADMAP_PAGE.generator), join(root, ROADMAP_PAGE.generator));
  mkdirSync(join(root, ROADMAP_PAGE.path, ".."), { recursive: true });
  const markers = readFileSync(join(REPOSITORY, ROADMAP_PAGE.path), "utf8").split("\n").filter((line) => line.startsWith("<!-- BEGIN GENERATED: roadmap") || line.startsWith("<!-- END GENERATED: roadmap"));
  assert.equal(markers.length, 8, "the real page's four generated blocks");
  writeFileSync(join(root, ROADMAP_PAGE.path), `# Roadmap\n\n${markers.join("\n\n")}\n`);
  writeFileSync(join(root, "docs/floor/evidence.md"), "# Evidence\n");
  assert.equal((await regenerateRoadmapPage(root, true)).converged, true, "the world's page starts current");
  assert.doesNotMatch(readFileSync(join(root, ROADMAP_PAGE.path), "utf8"), /ISSUE-40/u);

  // Outside the milestone plan, so the page's open task board names it.
  const written = await writeIntakeRecord(root, { ...ACCEPTED, milestone: null }, DATES);
  assert.deepEqual(written, [itemPath("ISSUE-40"), TRACKER_BOARD.path, ROADMAP_PAGE.path]);
  assert.match(readFileSync(join(root, ROADMAP_PAGE.path), "utf8"), /items\/ISSUE-40\.md/u, "the roadmap shows the new record");
  assert.deepEqual(await regenerateRoadmapPage(root, false), { status: "current", converged: true, changed: [] }, "the record left the roadmap fresh: harness check would pass");
});

test("the tracker fixture follows arbitrary decision IDs and nested test paths while missing references still refuse", () => {
  const source = createTempDir("community-record-reference-source-");
  const decisionDirectory = dirname(DECISION_INDEX.path);
  const decisionPath = join(decisionDirectory, "an-arbitrary-filename.md");
  const testPath = "tests/future/nested/reference.test.ts";
  mkdirSync(join(source, TRACKER_BOARD.items), { recursive: true });
  mkdirSync(join(source, decisionDirectory), { recursive: true });
  mkdirSync(dirname(join(source, testPath)), { recursive: true });
  const text = intakeItemText({ ...ACCEPTED, id: "FIXTURE-CLOSURE", type: "Bug", milestone: null, parent: null }, DATES)
    .replace("\n---\n", `\ndecisions: [D-FIXTURE]\ntests: [${testPath}]\n---\n`);
  writeFileSync(join(source, itemPath("FIXTURE-CLOSURE")), text);
  cpSync(join(REPOSITORY, TRACKER_BOARD.path), join(source, TRACKER_BOARD.path));
  writeFileSync(join(source, decisionPath), "---\nid: D-FIXTURE\nstatus: in-force\nimplementation: standing\n---\n\n# Fixture decision\n");
  writeFileSync(join(source, testPath), 'import test from "node:test";\ntest("fixture reference", () => {});\n');

  const { root } = trackerRepository("community-record-reference-target", source);
  assert.deepEqual(readTrackerItems(root), readTrackerItems(source));
  assert.equal(rawGit(root, ["status", "--porcelain"]).trim(), "", "copied references belong to the fixture's committed baseline");
  assert.equal(readFileSync(join(root, decisionPath), "utf8"), readFileSync(join(source, decisionPath), "utf8"), "decision IDs resolve through their real filename");
  assert.equal(readFileSync(join(root, testPath), "utf8"), readFileSync(join(source, testPath), "utf8"));

  rmSync(join(root, testPath));
  assert.throws(() => readTrackerItems(root), (error: unknown) => error instanceof HarnessError && error.code === "tracker_item_invalid" && error.message.includes(`${testPath} is not a file of the repository`));
  cpSync(join(source, testPath), join(root, testPath));
  rmSync(join(root, decisionPath));
  assert.throws(() => readTrackerItems(root), (error: unknown) => error instanceof HarnessError && error.code === "tracker_item_invalid" && error.message.includes("D-FIXTURE names no decision record"));
});

test("the item is the tracker's format: the reader accepts it, the reported text is fenced, the board is regenerated", async () => {
  const { root } = trackerRepository("community-record-write");
  const text = intakeItemText(ACCEPTED, DATES);
  assert.match(text, /^---\nschema: bridlewise-tracker-item\/v1\npublished: false\nid: ISSUE-40\ntype: Flake\n/u);
  assert.doesNotMatch(text, /^resolution:|^closed:/mu, "an open record names neither");
  assert.match(text, /\n---\n\nReported in #40 through the Flake report form; the report is the issue's own text\.\n$/u);
  const written = await writeIntakeRecord(root, ACCEPTED, DATES);
  assert.deepEqual(written, [itemPath("ISSUE-40"), TRACKER_BOARD.path]);
  const item = readTrackerItems(root).find((candidate) => candidate.id === "ISSUE-40");
  assert.equal(item?.gh, "issue-40");
  assert.equal(item?.lane, "floor");
  // The board renders the item escaped (the tracker's one escaping renderer).
  assert.ok(readFileSync(join(root, TRACKER_BOARD.path), "utf8").includes("**Flaky record\\-links test 3 fails** — Reported in \\#40"));
  await assert.rejects(writeIntakeRecord(root, ACCEPTED, DATES), (error: unknown) => error instanceof HarnessError && error.code === "community_record_exists");

  const declined = intakeItemText({ ...ACCEPTED, id: "ISSUE-41", type: "Intake", state: "closed", resolution: "not-planned", severity: null, milestone: null, gh: "issue-41" }, DATES);
  assert.ok(declined.includes("\nresolution: not-planned\n") && declined.includes("\nclosed: 2026-10-22\n"), "a closed record names how and when");
  await assert.rejects(writeIntakeRecord(root, { ...ACCEPTED, id: "ISSUE-42", gh: "issue-42", parent: "NO-SUCH-ITEM" }, DATES), (error: unknown) => error instanceof HarnessError && error.code === "tracker_item_invalid");
});

test("landing publishes a signed twin on intake/<id> and opens one ready pull request; a re-run finds it", async () => {
  const { root, bare } = trackerRepository("community-record-land");
  const forge = forgeAt(bare);
  const landing = {
    forge,
    repository: { root, executable: resolveGitExecutable(), timeoutMs: 30_000 },
    git: configuredWorktreeGitPort({}),
    target: { remote: "origin", remoteUrl: bare, trunk: "main" },
    fetchMs: 30_000,
    author: { name: "bridlewise-publisher[bot]", email: "publisher@example.invalid" },
  };
  const pull = await landIntakeRecord(landing, ACCEPTED, DATES, "/accept");
  assert.equal(pull.draft, false, "marked ready");
  assert.equal(pull.state, "open");
  const branch = recordBranch("ISSUE-40");
  assert.equal(branch, "intake/issue-40");
  const twin = rawGit(bare, ["rev-parse", `refs/heads/${branch}`]);
  assert.equal(rawGit(bare, ["log", "-1", "--format=%an", twin]), "forge-app[bot]", "the forge made the commit");
  assert.deepEqual(rawGit(bare, ["diff", "--name-only", "main", twin]).split("\n").sort(), [TRACKER_BOARD.path, itemPath("ISSUE-40")].sort());
  const commitCall = forge.calls.find((call) => call.op === "createCommit");
  assert.deepEqual(Object.keys(commitCall?.request as object).sort(), ["message", "parents", "tree"], "no author, committer or signature field reaches the forge");
  assert.equal(forge.pulls.size, 1);
  const opened = [...forge.pulls.values()][0]!;
  assert.match(opened.title, /ISSUE-40/u);
  assert.match(opened.body, /adopts #40/u);

  // A re-run on a fresh checkout of main (the event re-delivered) publishes again and finds the same pull request.
  rawGit(root, ["switch", "-q", "main"]);
  rawGit(root, ["branch", "-q", "-D", branch]);
  const again = await landIntakeRecord(landing, ACCEPTED, DATES, "/accept");
  assert.equal(again.number, pull.number);
  assert.equal(forge.pulls.size, 1);
  assert.equal(rawGit(bare, ["rev-parse", `refs/heads/${branch}^{tree}`]), rawGit(bare, ["rev-parse", `${twin}^{tree}`]), "the same record");
});
