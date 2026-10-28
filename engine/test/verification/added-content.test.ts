/**
 * WHAT A COMMIT ADDS (scripts/verification/added-content.ts): no host's home,
 * no raw dump over the bound, no `.ts` file that is not TypeScript — refused
 * at the hook and over a range, never echoing what it found; the declared
 * synthetic exemptions pass; main's tree passes retroactively.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { changeProblems, homePathFindings, localIdentity, rangeProblems, stagedChangeProblems, treeFiles, type ChangedFile } from "../../scripts/verification/added-content.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { createTempDir } from "../support/temp-dir.ts";

const NOBODY = { home: null, accountName: null } as const;
/** A real-looking account name no placeholder list holds. */
const PERSON = "mkeller7";

function file(path: string, text: string): ChangedFile {
  const bytes = Buffer.from(text, "utf8");
  return { path, bytes, addedLines: text.split("\n").map((line, index) => ({ line: index + 1, text: line })) };
}

test("an added line naming a host's home is refused in every spelling; the declared placeholders pass", () => {
  for (const line of [`see /home/${PERSON}/project`, `at /Users/${PERSON}/Library`, `C:\\Users\\${PERSON}\\AppData`, `C:/Users/${PERSON}/AppData`]) {
    assert.equal(homePathFindings(line, NOBODY).length, 1, `${line} passed`);
  }
  for (const name of ROOT_POLICY.verification.addedContent.syntheticHomeNames) {
    assert.deepEqual(homePathFindings(`fixture /home/${name}/repo`, NOBODY), [], `the placeholder ${name} was refused`);
  }
  assert.deepEqual(homePathFindings("a word with home in it, and /homework/ too", NOBODY), [], "no home shape, no finding");
});

test("at the local hook the running user's own home and account name are refused wherever they appear — never exempt", () => {
  const local = { home: "/home/alice", accountName: "alice" };
  assert.deepEqual(homePathFindings("cd /home/alice/work", local).toSorted(), ["the running user's account name", "the running user's home directory"]);
  assert.deepEqual(homePathFindings("signed by ALICE today", local), ["the running user's account name"]);
  assert.deepEqual(homePathFindings("malice is no name", local), [], "a name inside a longer word is not the name");
});

test("a scratch repository inside the temp root may name its own temp paths and the driving harness; anything else of the home stays refused, and a repository outside the temp root gets no such reading", () => {
  const scratch = { home: "/home/alice", accountName: "alice", scratchPaths: ["/home/alice/.cache/tmp", "/home/alice/src/harness"] };
  assert.deepEqual(homePathFindings("pwd >> /home/alice/.cache/tmp/fixture-1/witness.txt", scratch), [], "the scratch tree's own path");
  assert.deepEqual(homePathFindings('exec node "/home/alice/src/harness/engine/scripts/commit-guard.ts"', scratch), [], "the driving harness's own guard");
  assert.deepEqual(homePathFindings("cd /home/alice/project", scratch).toSorted(), ["the running user's account name", "the running user's home directory"]);
  assert.equal(localIdentity(join(import.meta.dirname, "..", "..")).scratchPaths, undefined, "this checkout lies outside the temp root");
  assert.equal(localIdentity(createTempDir("added-content-scratch-")).scratchPaths !== undefined, true, "a test's scratch repository lies inside it");
});

test("a text blob over the bound is refused, the declared vendored exemption passes, a binary is never measured as text", () => {
  const bound = ROOT_POLICY.verification.addedContent.maximumTextBlobBytes;
  const big = "x".repeat(bound + 1);
  assert.match(changeProblems([file("engine/test/listing.json", big)], NOBODY).join("\n"), /listing\.json: a text blob of \d+ bytes, over the \d+-byte bound .*added_content_text_oversized/u);
  assert.deepEqual(changeProblems([file(ROOT_POLICY.verification.addedContent.oversizedTextExemptions[0]!, big)], NOBODY), []);
  const binary = Buffer.alloc(bound + 1);
  assert.deepEqual(changeProblems([{ path: "docs/assets/x.png", bytes: binary, addedLines: [] }], NOBODY), []);
});

test("a .ts file that is not TypeScript is refused; a declaration file and the declared excerpts pass", () => {
  // The incident's shape: a test file replaced with a JSON listing.
  assert.match(changeProblems([file("engine/test/x.test.ts", "{\n  \"tests\": [\n    {\"name\": \"a\"}\n  ]\n}\n,")], NOBODY).join("\n"), /x\.test\.ts: is not TypeScript: it does not parse \(added_content_not_typescript\)/u);
  assert.deepEqual(changeProblems([file("engine/src/x.ts", "export const x: number = 1;\n")], NOBODY), []);
  assert.deepEqual(changeProblems([file("engine/src/x.d.mts", "export declare const x: number;\n")], NOBODY), [], "a declaration file is TypeScript");
  for (const path of ROOT_POLICY.verification.addedContent.notTypeScriptExemptions) {
    assert.deepEqual(changeProblems([file(path, "not ( typescript")], NOBODY), [], `${path} is a declared exemption`);
  }
});

test("a refusal names file, line and kind, never what it found", () => {
  const problems = changeProblems([file("docs/notes.md", `one\nrun from /home/${PERSON}/checkout\n`)], { home: `/home/${PERSON}`, accountName: PERSON });
  assert.ok(problems.some((problem) => problem.startsWith("docs/notes.md:2: an added line names")), problems.join("\n"));
  assert.doesNotMatch(problems.join("\n"), new RegExp(PERSON, "u"), "the account name was echoed");
});

/** A scratch repository (hooks off INSIDE it only) with one committed file. */
function repository(): Readonly<{ root: string; git: (...args: readonly string[]) => string; write: (path: string, text: string) => void }> {
  const root = createTempDir("added-content-");
  const git = (...args: readonly string[]): string => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: root, encoding: "utf8" });
  const write = (path: string, text: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  git("init", "-q", "-b", "main");
  write("docs/readme.md", "base\n");
  git("add", "--", "docs/readme.md");
  git("commit", "-q", "-m", "base");
  return { root, git, write };
}

test("the range door refuses a commit that added a home path, names it without echoing it, and judges a merge only on what it adds beyond every parent", () => {
  const { root, git, write } = repository();
  const base = git("rev-parse", "HEAD").trim();
  git("checkout", "-q", "-b", "side");
  write("docs/notes.md", `ran in /home/${PERSON}/checkout\n`);
  git("add", "--", "docs/notes.md");
  git("commit", "-q", "-m", "a note");
  const leaking = git("rev-parse", "HEAD").trim();
  git("checkout", "-q", "main");
  write("docs/other.md", "unrelated\n");
  git("add", "--", "docs/other.md");
  git("commit", "-q", "-m", "trunk moves");
  git("merge", "-q", "--no-ff", "-m", "merge side", "side");
  const refused = rangeProblems(root, `${base}..HEAD`);
  assert.deepEqual(refused.map((entry) => entry.commit), [leaking], "only the commit that added the line; the merge adds nothing beyond its parents");
  assert.deepEqual(refused[0]!.problems, ["docs/notes.md:1: an added line names a /home/<name>/ path (added_content_home_path)"]);
  assert.doesNotMatch(JSON.stringify(refused), new RegExp(PERSON, "u"));
});

test("the hook's question: the staged change, judged with the running user's own identity", () => {
  const { root, git, write } = repository();
  write("docs/readme.md", "base\ncontact alice for access\n");
  git("add", "--", "docs/readme.md");
  assert.deepEqual(stagedChangeProblems(root, { home: null, accountName: "alice" }), ["docs/readme.md:2: an added line names the running user's account name (added_content_home_path)"]);
  assert.deepEqual(stagedChangeProblems(root, NOBODY), [], "without the local identity a name is only a name");
});

test("main's tree passes retroactively: every line of every tracked file, judged as added", () => {
  const root = join(import.meta.dirname, "..", "..", "..");
  const files = treeFiles(root, "HEAD");
  assert.ok(files.length > 1000, `the tree is judged whole (liveness): ${String(files.length)} files`);
  assert.deepEqual(changeProblems(files, NOBODY), []);
});
