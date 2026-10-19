// @vitest-environment node
/**
 * "SEE WHAT CHANGED" AGAINST A REAL REPOSITORY (§7.2).
 *
 * The Custody room reported that `see` "is not working". It was: for three
 * whole classes of changed file the diff route answered with an EMPTY patch
 * and the sheet printed "no difference to show — the file matches its last
 * saved state" over a file that had plainly changed.
 *
 * The cause was a disagreement between two owners of the SAME question:
 *   - the room's ± counts are measured with `git diff --numstat HEAD` —
 *     against the LAST SAVE;
 *   - `getDiffPatch` ran `git diff` with no ref at all — against the INDEX.
 * So a staged edit counted as "+1 −0" in the room and as nothing at all in
 * the sheet. Its own sibling `getDiffSummary` had defaulted to HEAD all
 * along; nothing but this function disagreed.
 *
 * Every case below is measured against a REAL temp repository through the
 * real bridge — a stubbed git would confirm exactly the assumptions that
 * were wrong.
 */
import { beforeAll, describe, expect, test } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getDiffPatch, getGitStatus } from "../../server/intelligence/git-ops-bridge.ts";
import {
  normalizeStatusEntry,
  numstatDestination,
  workingCounts,
} from "../../server/blocks/custody.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
import { createTempGitRepo, type TempGitRepo } from "../helpers/temp-git-repo.ts";

let repo: string;
let firstSave: string;
let repoGit: TempGitRepo["git"];

function git(...args: string[]): string {
  return repoGit(...args).trim();
}

function write(rel: string, body: string): void {
  const abs = join(repo, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

beforeAll(() => {
  ({ dir: repo, git: repoGit } = createTempGitRepo("custody-see"));

  write("kept.ts", "export const a = 1;\n");
  write("moved-from.ts", "export const m = 1;\n");
  write("doomed.ts", "export const d = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "the first save");
  firstSave = git("rev-parse", "HEAD");

  // A SECOND save, so the repository has a non-root commit too.
  write("later.ts", "export const l = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "a later save");

  // The four states the room can show, all live at once:
  //  staged   — edited AND added to the index
  //  unstaged — edited only
  //  new      — never saved at all
  //  moved    — one porcelain entry spelled "old -> new"
  write("kept.ts", "export const a = 1;\n// staged edit\n");
  git("add", "kept.ts");
  write("later.ts", "export const l = 1;\n// unstaged edit\n");
  write("brand-new.ts", "export const n = 1;\nexport const n2 = 2;\n");
  git("mv", "moved-from.ts", "moved-to.ts");
  rmSync(join(repo, "doomed.ts"));
});

describe("the comparison base is the LAST SAVE, not the index", () => {
  test("a STAGED edit has a patch — the defect the room reported", () => {
    const { patch } = getDiffPatch(repo, "kept.ts");
    expect(patch, "a staged edit must not read as no difference").not.toBe("");
    expect(patch).toContain("+// staged edit");
  });

  test("the sheet's patch and the room's ± counts now measure the same thing", () => {
    // The self-contradiction that was visible on one screen: a row that
    // says "+1 −0" whose `see` says "no difference to show".
    const counted = workingCounts(repo).get("kept.ts");
    expect(counted).toEqual({ path: "kept.ts", insertions: 1, deletions: 0 });
    const { patch } = getDiffPatch(repo, "kept.ts");
    const added = patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    expect(added.length).toBe(counted!.insertions);
  });

  test("an UNSTAGED edit still reads exactly as before (no regression)", () => {
    expect(getDiffPatch(repo, "later.ts").patch).toContain("+// unstaged edit");
  });

  test("a DELETED file reads as its removal", () => {
    const { patch } = getDiffPatch(repo, "doomed.ts");
    expect(patch).toContain("-export const d = 1;");
  });
});

describe("a file with no earlier saved version", () => {
  test("a NEW file's patch is its real content, every line added", () => {
    const { patch } = getDiffPatch(repo, "brand-new.ts");
    expect(patch, "a new file must not read as no difference").not.toBe("");
    expect(patch).toContain("new file mode");
    expect(patch).toContain("+export const n = 1;");
    expect(patch).toContain("+export const n2 = 2;");
  });

  test("the added lines are the file's REAL line count, not a guess", () => {
    const added = getDiffPatch(repo, "brand-new.ts")
      .patch
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    expect(added.length).toBe(2);
  });

  test("a path git does not report as untracked gets NO invented patch", () => {
    // The untracked fill can only ever turn an empty answer into a real
    // one — a path that simply does not exist stays empty.
    expect(getDiffPatch(repo, "no-such-file.ts").patch).toBe("");
  });
});

describe("a MOVED file is addressed by a path that exists", () => {
  test("porcelain's 'old -> new' entry is normalised to the destination", () => {
    const raw = getGitStatus(repo).entries.find((e) => e.path.includes("moved-to.ts"));
    expect(raw, "the fixture must produce a move entry").toBeDefined();
    expect(raw!.path, "porcelain really does spell it this way").toContain(" -> ");
    const entry = normalizeStatusEntry(raw!);
    expect(entry.path).toBe("moved-to.ts");
    expect(entry.status).toBe("moved");
  });

  test("a non-move entry passes through the normaliser untouched", () => {
    const before = { status: "modified", path: "later.ts", staged: false } as const;
    expect(normalizeStatusEntry(before)).toEqual(before);
  });

  test("the destination path is one `see` can actually ask about", () => {
    // Before the fix the room asked the route about a file literally named
    // "moved-from.ts -> moved-to.ts", which cannot match anything.
    expect(getDiffPatch(repo, "moved-from.ts -> moved-to.ts").patch).toBe("");
    expect(getDiffPatch(repo, "moved-to.ts").patch).not.toBe("");
  });

  test("a move's counts are found under its destination, not reported absent", () => {
    expect(workingCounts(repo).has("moved-to.ts")).toBe(true);
  });

  test("numstat's FOLDED move spelling resolves to the destination too", () => {
    // git compresses a move's shared path parts — `src/rooms/{A.ts => B.ts}`
    // — and nearly every real move is inside a directory, so reading only
    // the unfolded spelling meant "not counted" on almost all of them.
    expect(numstatDestination("src/rooms/{RoomA.ts => RoomB.ts}")).toBe("src/rooms/RoomB.ts");
    expect(numstatDestination("gamma.ts => delta.ts")).toBe("delta.ts");
    expect(numstatDestination("{old => new}/leaf.ts")).toBe("new/leaf.ts");
    expect(numstatDestination("src/{ => nested}/leaf.ts")).toBe("src/nested/leaf.ts");
    expect(numstatDestination("plain/file.ts"), "a non-move line names no move").toBeNull();
  });

  test("a move INSIDE a directory carries its counts (the folded spelling, live)", () => {
    // The fixture's own folded case, measured through the real bridge.
    const folded = [...workingCounts(repo).keys()].filter((k) => k.includes("=>"));
    for (const key of folded) {
      const dest = numstatDestination(key);
      expect(dest, `every folded numstat key must resolve: ${key}`).not.toBeNull();
      expect(workingCounts(repo).has(dest!)).toBe(true);
    }
  });
});

describe("`<hash>^!` — one save against what came before it", () => {
  test("a NON-root save diffs against its parent", () => {
    const later = git("rev-parse", "HEAD");
    const { patch } = getDiffPatch(repo, undefined, `${later}^!`);
    expect(patch).toContain("later.ts");
    expect(patch).toContain("+export const l = 1;");
    // …and NOT the reader's current uncommitted edits.
    expect(patch).not.toContain("// unstaged edit");
  });

  test("the FIRST save diffs against the empty tree, not against the working tree", () => {
    // `A^!` expands to `A ^A^1`; a root commit has no `A^1`, so git silently
    // dropped the exclusion and ran `git diff A` — the save against the
    // WORKING TREE. The reader was shown their own uncommitted edits as the
    // content of the project's first save.
    const { patch } = getDiffPatch(repo, undefined, `${firstSave}^!`);
    expect(patch).toContain("+export const a = 1;");
    expect(patch).toContain("new file mode");
    expect(patch, "the first save cannot contain later work").not.toContain("// staged edit");
    expect(patch, "the first save cannot contain later work").not.toContain("later.ts");
  });
});

describe("a project with NO repository — the wire names the real cause, not 'no difference'", () => {
  // The same question this file has asked against a real repository, asked
  // of a plain folder no repository tracks. The wire used to answer a bare
  // empty patch — indistinguishable from "the file matches its last save" —
  // so the flow's effect beat told a commit/revert story that cannot be
  // true there, for a file the run had just created. The typed fact and the
  // door's own sentence are what let every reader say the honest thing.
  let plain: string;

  beforeAll(() => {
    plain = createTempDir("custody-see-nogit");
    writeFileSync(join(plain, "summary.md"), "one\n", "utf8");
  });

  test("the answer carries the typed no-repository fact, never a bare patch", () => {
    const answer = getDiffPatch(plain, "summary.md");
    expect(answer.repository, "the typed fact is what a reader needs to say 'not under version control'").toBe(false);
    expect(answer.patch).toBe("");
  });

  test("the served sentence names version control — the real cause — and never commits or reverts", () => {
    const answer = getDiffPatch(plain, "summary.md");
    expect(answer.reason, "the door serves its own words for the fact").toBeDefined();
    expect(answer.reason!).toContain("not under version control");
    expect(answer.reason!, "no repository means no commit or revert can have happened").not.toMatch(/commit|revert/i);
  });

  test("a repository-backed answer carries the POSITIVE fact and no reason to give", () => {
    // The git-backed path is untouched: same patch, plus the positive fact a
    // consumer can assert. A reason belongs only to the no-repository branch.
    const answer = getDiffPatch(repo, "kept.ts");
    expect(answer.repository).toBe(true);
    expect(answer.reason).toBeUndefined();
    expect(answer.patch).toContain("+// staged edit");
  });
});
