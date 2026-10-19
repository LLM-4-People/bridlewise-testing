/**
 * THE FLAKY MEMORY'S BURN-DOWN LIST (src/workflow/flaky-burn-down.ts): a red
 * suspect passes only as an entry owned by an open row naming its test and the
 * guard, added by the commit that added that row; a new suspect, a closed or
 * mis-naming owner, or an entry added without its row fails. Nothing ages out.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { configuredGitRepository } from "../../src/git/worktree-port.ts";
import { burnDownLine, entryAddedWithOwner, FLAKY_BURN_DOWN_SCHEMA_VERSION, flakyBurnDownPath, judgeBurnDown, judgeFlakyMemory, type BurnDownEntry, type BurnDownList } from "../../src/workflow/flaky-burn-down.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";

const ENGINE_ROOT = join(import.meta.dirname, "..", "..");
import { createTempDir } from "../support/temp-dir.ts";
import { testGitIdentityEnvironment } from "../support/test-git-identity.ts";

const GUARD = "tests/prevention/flaky-test-memory.test.ts";
const SUSPECT = "tests/unit/a.test.ts::suite > flakes";
const OTHER = "tests/unit/b.test.ts::suite > also flakes";
const entry: BurnDownEntry = { identity: SUSPECT, owner: "FLAKY-A" };
const list = (...entries: BurnDownEntry[]): BurnDownList => ({ schemaVersion: FLAKY_BURN_DOWN_SCHEMA_VERSION, entries });
const red = (identity: string) => ({ identity, failedAt: ["2026-10-08T10:00:00.000Z"] });
const fileOf = (identity: string): string | null => identity.includes("::") ? identity.slice(0, identity.indexOf("::")) : null;
const OPEN_ROW = `# Tasks\n\n- [ ] **FLAKY-A** tests/unit/a.test.ts flakes; owned in the burn-down of ${GUARD}.\n`;

test("an owned entry passes and is said; a NEW suspect fails; nothing needs the suspect to be red now", () => {
  const owned = judgeBurnDown([red(SUSPECT)], list(entry), OPEN_ROW, GUARD, fileOf, () => true);
  assert.deepEqual(owned.newSuspects, []);
  assert.deepEqual(owned.problems, []);
  assert.deepEqual(owned.owned, [{ ...entry, red: true }]);
  assert.match(burnDownLine(owned), /1 owned entry: tests\/unit\/a\.test\.ts::suite > flakes \(owner FLAKY-A, red now\)/u);
  const fresh = judgeBurnDown([red(SUSPECT), red(OTHER)], list(entry), OPEN_ROW, GUARD, fileOf, () => true);
  assert.deepEqual(fresh.newSuspects.map((suspect) => suspect.identity), [OTHER], "a red suspect no entry names is new, and fails");
  const quiet = judgeBurnDown([], list(entry), OPEN_ROW, GUARD, fileOf, () => true);
  assert.deepEqual(quiet.owned, [{ ...entry, red: false }], "an entry stays (and is said) after its suspect left the window: nothing ages out");
});

test("an entry whose owner is closed, missing, or does not name both the test and the guard fails", () => {
  for (const [tracker, why] of [
    [OPEN_ROW.replace("- [ ]", "- [x]"), /is closed while the entry remains/u],
    ["# Tasks\n", /is no row of the tracker/u],
    [`# Tasks\n\n- [ ] **FLAKY-A** tests/unit/a.test.ts flakes.\n`, /does not name both/u],
    [`# Tasks\n\n- [ ] **FLAKY-A** owned in ${GUARD}.\n`, /does not name both/u],
  ] as const) {
    const judged = judgeBurnDown([red(SUSPECT)], list(entry), tracker, GUARD, fileOf, () => true);
    assert.equal(judged.problems.length, 1, tracker);
    assert.match(judged.problems[0]!, why);
    assert.deepEqual(judged.owned, []);
  }
  const unadded = judgeBurnDown([red(SUSPECT)], list(entry), OPEN_ROW, GUARD, fileOf, () => false);
  assert.match(unadded.problems[0]!, /was not added by the commit that added its owner row FLAKY-A/u);
});

test("an entry counts as added with its owner only when the commit that first held it also added the owner's row", () => {
  const root = createTempDir("flaky-burn-down-");
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...testGitIdentityEnvironment() } }).trim();
  const commit = (files: Readonly<Record<string, string>>, message: string): void => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    git("add", "--", ...Object.keys(files));
    git("commit", "-q", "-m", message);
  };
  git("init", "-q", "-b", "main");
  const listPath = "engine/traceability/flaky-burn-down/web.json";
  const listText = (...entries: BurnDownEntry[]): string => `${JSON.stringify(list(...entries), null, 2)}\n`;
  commit({ "docs/trackers/TASKS.md": "# Tasks\n", [listPath]: listText() }, "init");
  commit({ [listPath]: listText(entry), "docs/trackers/TASKS.md": OPEN_ROW }, "an entry with its owner row");
  const other: BurnDownEntry = { identity: OTHER, owner: "FLAKY-B" };
  commit({ [listPath]: listText(entry, other) }, "an entry without its row");
  commit({ "docs/trackers/TASKS.md": `${OPEN_ROW}- [ ] **FLAKY-B** tests/unit/b.test.ts in ${GUARD}.\n` }, "the row, later");
  const repository = configuredGitRepository({}, root);
  assert.equal(entryAddedWithOwner(repository, listPath, "docs/trackers/TASKS.md", entry), true);
  assert.equal(entryAddedWithOwner(repository, listPath, "docs/trackers/TASKS.md", other), false, "a row added after the entry did not come with it");
  assert.equal(entryAddedWithOwner(repository, listPath, "docs/trackers/TASKS.md", { identity: "tests/unit/never.test.ts::x", owner: "FLAKY-A" }), false, "an entry never committed was added with nothing");
  // A list that spells a character as a JSON escape holds the same identity: the history is read PARSED, never by text.
  const dashed: BurnDownEntry = { identity: "tests/unit/c.test.ts::a suite \u2014 its test", owner: "FLAKY-C" };
  commit({ [listPath]: listText(entry, other, dashed).replace("\u2014", "\\u2014"), "docs/trackers/TASKS.md": `${OPEN_ROW}- [ ] **FLAKY-B** tests/unit/b.test.ts in ${GUARD}.\n- [ ] **FLAKY-C** tests/unit/c.test.ts in ${GUARD}.\n` }, "an escaped entry with its row");
  assert.ok(execFileSync("git", ["show", `HEAD:${listPath}`], { cwd: root, encoding: "utf8" }).includes("\\u2014"), "the plant spells the dash as an escape");
  assert.equal(entryAddedWithOwner(repository, listPath, "docs/trackers/TASKS.md", dashed), true);
  // RE-OWNING (design LOW 4): an entry moves to a new owner only by the commit that adds the new owner's row.
  const reowned: BurnDownEntry = { identity: OTHER, owner: "FLAKY-D" };
  commit({ [listPath]: listText(entry, reowned, dashed), "docs/trackers/TASKS.md": `${OPEN_ROW}- [ ] **FLAKY-B** tests/unit/b.test.ts in ${GUARD}.\n- [ ] **FLAKY-C** tests/unit/c.test.ts in ${GUARD}.\n- [ ] **FLAKY-D** tests/unit/b.test.ts in ${GUARD}.\n` }, "re-owned with its new row");
  assert.equal(entryAddedWithOwner(repository, listPath, "docs/trackers/TASKS.md", reowned), true, "re-owned by the commit that added the new row");
  // An EDITED row head or a line that merely cites the id is no added row (F-L6).
  const cited: BurnDownEntry = { identity: "tests/unit/e.test.ts::e", owner: "FLAKY-A" };
  commit({ [listPath]: listText(entry, reowned, dashed, cited), "docs/trackers/TASKS.md": `${OPEN_ROW.replace("**FLAKY-A**", "**FLAKY-A** (edited)")}- [ ] **FLAKY-B** tests/unit/b.test.ts in ${GUARD}.\n- [ ] **FLAKY-C** tests/unit/c.test.ts in ${GUARD}.\n- [ ] **FLAKY-D** tests/unit/b.test.ts in ${GUARD}; see FLAKY-A.\n` }, "an entry under an existing owner whose row head was only edited");
  assert.equal(entryAddedWithOwner(repository, listPath, "docs/trackers/TASKS.md", cited), false, "an edited existing row head adds no row");
});

test("THE ONE JUDGEMENT, driven on a planted repository: one failure followed by many green runs STAYS RED until it is owned — nothing ages out of a window (design NH-E); an owned entry added with its row passes; a closed owner fails again", async () => {
  const root = createTempDir("flaky-memory-");
  const engine = join(root, "engine");
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...testGitIdentityEnvironment() } }).trim();
  const write = (path: string, text: string): void => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  git("init", "-q", "-b", "main");
  write("engine/bridlewise.config.json", readFileSync(join(ENGINE_ROOT, "bridlewise.config.json"), "utf8"));
  write(`engine/${flakyBurnDownPath("engine")}`, `${JSON.stringify(list())}\n`);
  write(ROOT_POLICY.workflow.failureOwners.tracker, "# Tasks\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  const identity = "test/a.test.ts::flakes";
  const at = (minute: number): string => new Date(Date.UTC(2026, 9, 8, 10, minute)).toISOString();
  // One failure, then far more green runs than any window the memory once had (10).
  const entries = [{ timestamp: at(0), failures: [identity], provisional: false, mutation: false }, ...Array.from({ length: 55 }, (_, index) => ({ timestamp: at(index + 1), failures: [], provisional: false, mutation: false }))];
  const judge = () => judgeFlakyMemory({ suite: "engine", engineRoot: engine, entries, ownPrefix: "test/prevention/flaky-test-memory.test.ts::", guardFile: "test/prevention/flaky-test-memory.test.ts", regenerated: [], suites: null });
  const unowned = await judge();
  assert.match(unowned.failure ?? "", /test\/a\.test\.ts::flakes/u, "a failure 55 green runs ago is still red");
  write(`engine/${flakyBurnDownPath("engine")}`, `${JSON.stringify(list({ identity, owner: "FLAKY-A" }))}\n`);
  write(ROOT_POLICY.workflow.failureOwners.tracker, "# Tasks\n\n- [ ] **FLAKY-A** engine/test/a.test.ts flakes; owned by engine/test/prevention/flaky-test-memory.test.ts.\n");
  git("add", "-A");
  git("commit", "-q", "-m", "own it");
  const owned = await judge();
  assert.equal(owned.failure, null, owned.failure ?? "");
  assert.match(owned.lines.at(-1)!, /1 owned entry: test\/a\.test\.ts::flakes \(owner FLAKY-A, red now\)/u);
  write(ROOT_POLICY.workflow.failureOwners.tracker, "# Tasks\n\n- [x] **FLAKY-A** engine/test/a.test.ts flakes; owned by engine/test/prevention/flaky-test-memory.test.ts.\n");
  git("add", "-A");
  git("commit", "-q", "-m", "close the row, keep the entry");
  assert.match((await judge()).failure ?? "", /closed while the entry remains/u);
});
