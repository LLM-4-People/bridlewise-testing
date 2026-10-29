/**
 * THE INTAKE RECORD, LANDED (`src/workflow/community/record.ts`): a triage
 * decision becomes a tracker item the tracker's own reader accepts, the board
 * is regenerated with it, and the commit reaches the forge only as a signed
 * twin on `intake/<id>`, with one ready pull request (found again on a
 * re-run) — against GH-3's fake forge over a real bare repository.
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveGitExecutable } from "../../src/git/git-adapter.ts";
import { configuredWorktreeGitPort } from "../../src/git/worktree-port.ts";
import { HarnessError } from "../../src/kernel/errors.ts";
import { ROADMAP_PAGE, TRACKER_BOARD } from "../../src/kernel/verification-paths.ts";
import { readTrackerItems } from "../../src/workflow/failure-owners.ts";
import type { IntakeRecord } from "../../src/workflow/community/issue-ops.ts";
import { regenerateRoadmapPage } from "../../src/workflow/harness-commands.ts";
import { intakeItemText, itemPath, landIntakeRecord, recordBranch, writeIntakeRecord } from "../../src/workflow/community/record.ts";
import { forgeAt, initTempRepo, rawGit } from "../workspaces/workspace-test-support.ts";

const REPOSITORY = dirname(fileURLToPath(new URL("../../", import.meta.url)));
const DATES = { opened: "2026-10-21", closed: "2026-10-22" };

const ACCEPTED: IntakeRecord = {
  id: "ISSUE-40", type: "Flake", title: "Flaky record-links test 3 fails", state: "open", resolution: null,
  severity: "P2", milestone: "M1", parent: null, gh: "issue-40",
  body: "Reported in #40 through the Flake report form; the report is the issue's own text.",
};

/** A repository carrying this tree's tracker (the items and the board), committed on `main`, tracking a bare forge remote. */
function trackerRepository(prefix: string): Readonly<{ root: string; bare: string }> {
  const { root, bare } = initTempRepo(prefix);
  mkdirSync(join(root, "docs/trackers"), { recursive: true });
  cpSync(join(REPOSITORY, TRACKER_BOARD.items), join(root, TRACKER_BOARD.items), { recursive: true });
  cpSync(join(REPOSITORY, TRACKER_BOARD.path), join(root, TRACKER_BOARD.path));
  rawGit(root, ["add", "docs"]);
  rawGit(root, ["commit", "-q", "-m", "tracker"]);
  rawGit(root, ["push", "-q", "origin", "main"]);
  return { root, bare };
}

test("the record writer regenerates every generated view of the tracker: the roadmap page too, through the arm harness sync runs", () => {
  const { root } = trackerRepository("community-record-roadmap");
  // A stand-in roadmap generator at the arm's own path (the protocol only; the real rendering is proved beside its owner):
  // the page does not exist yet, so the run that the record makes writes it, and only a --write run may.
  const generator = join(root, ROADMAP_PAGE.generator);
  mkdirSync(join(generator, ".."), { recursive: true });
  mkdirSync(join(root, ROADMAP_PAGE.path, ".."), { recursive: true });
  writeFileSync(generator, [
    'import { existsSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'const root = process.argv.find((a) => a.startsWith("--root="))?.slice("--root=".length);',
    `const file = join(root, ${JSON.stringify(ROADMAP_PAGE.path)});`,
    'let out;',
    'if (existsSync(file)) out = { allCurrent: true, status: "current", changed: [] };',
    'else if (process.argv.includes("--write")) { writeFileSync(file, "rendered\\n"); out = { allCurrent: true, status: "regenerated", changed: ["open work"] }; }',
    'else out = { allCurrent: false, status: "stale", changed: ["open work"] };',
    'process.stdout.write(JSON.stringify(out) + "\\n");',
    "process.exitCode = out.allCurrent ? 0 : 1;",
    "",
  ].join("\n"));
  const written = writeIntakeRecord(root, ACCEPTED, DATES, regenerateRoadmapPage);
  assert.deepEqual(written, [itemPath("ISSUE-40"), TRACKER_BOARD.path, ROADMAP_PAGE.path]);
  assert.equal(readFileSync(join(root, ROADMAP_PAGE.path), "utf8"), "rendered\n", "the record writer ran the roadmap arm with --write");
});

test("the item is the tracker's format: the reader accepts it, the reported text is fenced, the board is regenerated", () => {
  const { root } = trackerRepository("community-record-write");
  const text = intakeItemText(ACCEPTED, DATES);
  assert.match(text, /^---\nschema: bridlewise-tracker-item\/v1\npublished: false\nid: ISSUE-40\ntype: Flake\n/u);
  assert.doesNotMatch(text, /^resolution:|^closed:/mu, "an open record names neither");
  assert.match(text, /\n---\n\nReported in #40 through the Flake report form; the report is the issue's own text\.\n$/u);
  const written = writeIntakeRecord(root, ACCEPTED, DATES, regenerateRoadmapPage);
  assert.deepEqual(written, [itemPath("ISSUE-40"), TRACKER_BOARD.path]);
  const item = readTrackerItems(root).find((candidate) => candidate.id === "ISSUE-40");
  assert.equal(item?.gh, "issue-40");
  assert.equal(item?.lane, "floor");
  // The board renders the item escaped (the tracker's one escaping renderer).
  assert.ok(readFileSync(join(root, TRACKER_BOARD.path), "utf8").includes("**Flaky record\\-links test 3 fails** — Reported in \\#40"));
  assert.throws(() => writeIntakeRecord(root, ACCEPTED, DATES, regenerateRoadmapPage), (error: unknown) => error instanceof HarnessError && error.code === "community_record_exists");

  const declined = intakeItemText({ ...ACCEPTED, id: "ISSUE-41", type: "Intake", state: "closed", resolution: "not-planned", severity: null, milestone: null, gh: "issue-41" }, DATES);
  assert.ok(declined.includes("\nresolution: not-planned\n") && declined.includes("\nclosed: 2026-10-22\n"), "a closed record names how and when");
  assert.throws(() => writeIntakeRecord(root, { ...ACCEPTED, id: "ISSUE-42", gh: "issue-42", parent: "NO-SUCH-ITEM" }, DATES, regenerateRoadmapPage), (error: unknown) => error instanceof HarnessError && error.code === "tracker_item_invalid");
});

test("landing publishes a signed twin on intake/<id> and opens one ready pull request; a re-run finds it", async () => {
  const { root, bare } = trackerRepository("community-record-land");
  const forge = forgeAt(bare);
  const landing = {
    forge,
    roadmap: regenerateRoadmapPage,
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
