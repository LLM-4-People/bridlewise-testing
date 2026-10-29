/**
 * WHAT A COMMIT ADDS (scripts/verification/added-content.ts): no host's home,
 * no raw dump over the bound, no `.ts` file that is not TypeScript — refused
 * at the hook and over a range, never echoing what it found; the declared
 * synthetic exemptions pass; main's tree passes retroactively.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";

import { changeProblems, decodedForms, homePathFindings, identityOf, rangeProblems, stagedChangeProblems, throwawayReading, treeFiles, type ChangedFile } from "../../scripts/verification/added-content.ts";
import { COMMIT_GUARD_PATH } from "../../scripts/verification/staged-move-loss.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { HOME_PATH_PLACEHOLDERS } from "../../src/privacy/secret-signals.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { markThrowawayRepository } from "../support/throwaway-repository.ts";

const NOBODY = { home: null, accountName: null } as const;
/** A real-looking account name no placeholder list holds, and its Windows short name. */
const PERSON = "mkeller7";
const SHORT = "MKELLE~1";
/** The separators, spelled from parts so no committed line of this file has a shape it plants. */
const H = ["", "home", ""].join("/");
const POLICY = ROOT_POLICY.verification.addedContent;

function file(path: string, text: string): ChangedFile {
  const bytes = Buffer.from(text, "utf8");
  return { path, bytes, addedLines: text.split("\n").map((line, index) => ({ line: index + 1, text: line })) };
}

test("an added line naming a host's home is refused in every spelling, encoded or not, with or without a trailing separator; the declared placeholders and relative folders pass", () => {
  const percent = (text: string): string => text.replaceAll("/", "%2F");
  for (const line of [
    `see ${H}${PERSON}/project`,
    `ends at ${H}${PERSON}`,
    `"${H}${PERSON}"`,
    `file://${H}${PERSON}/x`,
    `at /Users/${PERSON}/Library`,
    `C:\\Users\\${PERSON}\\AppData`,
    `C:/Users/${PERSON}/AppData`,
    `c:\\users\\${SHORT}\\AppData`,
    `C:\\Users\\${PERSON}`,
    percent(`${H}${PERSON}/x`),
    percent(`${H}${PERSON}`).replaceAll("%", "%25"),
    percent(`${H}${PERSON}`).replaceAll("%", "%25").replaceAll("%", "%25"),
    `${H}${PERSON}/x`.replaceAll("/", "\\/"),
    `${H}${PERSON}/x`.replaceAll("/", "\\u002f"),
    `${H}${PERSON}/x`.replaceAll("/", "\\x2F"),
    `C:\\\\Users\\\\${PERSON}\\\\AppData`,
  ]) {
    assert.equal(homePathFindings(line, NOBODY).length, 1, `${line} passed`);
  }
  for (const name of HOME_PATH_PLACEHOLDERS) {
    assert.deepEqual(homePathFindings(`fixture ${H}${name}/repo, then ${H}${name}.`, NOBODY), [], `the placeholder ${name} was refused`);
  }
  for (const line of ["a word with home in it, and /homework/ too", `src${H}page.tsx`, `app/Users/list.ts`, `~${H}x`]) {
    assert.deepEqual(homePathFindings(line, NOBODY), [], `${line}: no home shape, no finding`);
  }
});

test("a text encoded deeper than the bound is refused, never judged half-decoded", () => {
  // Twenty layers of percent-encoding around one slash: each round peels exactly one.
  const deep = `%${"25".repeat(20)}2F`;
  assert.equal(decodedForms(deep), null);
  assert.deepEqual(homePathFindings(deep, NOBODY), ["text encoded more than 16 layers deep (it cannot be judged)"]);
  assert.deepEqual(decodedForms("%252F"), ["%252F", "%2F", "/"]);
});

test("at the local hook the running user's own home and account name are refused wherever they appear, an encoded separator before the name included", () => {
  const local = identityOf("alice", "/home/alice");
  assert.deepEqual(local, { home: "/home/alice", accountName: null }, "alice is a placeholder: only the bare name goes unjudged");
  const person = identityOf(PERSON, `${H}${PERSON}`);
  assert.deepEqual(homePathFindings(`cd ${H}${PERSON}/work`, person).toSorted(), ["an absolute home path [home-path]", "the running user's account name", "the running user's home directory"]);
  assert.deepEqual(homePathFindings(`signed by ${PERSON.toUpperCase()} today`, person), ["the running user's account name"]);
  assert.deepEqual(homePathFindings(`split: "2Fhome2F${PERSON}"`, person), ["the running user's account name"], "2F before the name");
  assert.deepEqual(homePathFindings(`a piece: "${PERSON}"`, person), ["the running user's account name"], "a split string's piece");
  assert.deepEqual(homePathFindings(`x${PERSON}y is no name`, person), [], "a name inside a longer word is not the name");
});

test("a placeholder-named real account keeps its home judged: exactly (case-sensitively) a placeholder skips only the bare-name check", () => {
  const runner = identityOf("runner", "/home/runner");
  assert.deepEqual(runner, { home: "/home/runner", accountName: null });
  assert.deepEqual(homePathFindings("cd /home/runner/work/x", runner), ["the running user's home directory"]);
  assert.deepEqual(homePathFindings("the runner ran", runner), []);
  assert.deepEqual(identityOf("Runner", `${H}Runner`), { home: `${H}Runner`, accountName: "Runner" }, "Runner is not the placeholder runner");
});

test("a text blob over the bound is refused, the declared vendored exemption passes, a binary is never measured as text", () => {
  const bound = POLICY.maximumTextBlobBytes;
  const big = "x".repeat(bound + 1);
  assert.deepEqual(changeProblems([file("engine/test/listing.json", big)], NOBODY), [
    `engine/test/listing.json: a text blob of ${String(bound + 1)} bytes, over the ${String(bound)}-byte bound (raw output belongs in the evidence store) (added_content_text_oversized)`,
  ]);
  assert.deepEqual(changeProblems([file(POLICY.oversizedTextExemptions[0]!, big)], NOBODY), []);
  assert.deepEqual(changeProblems([{ path: "docs/assets/x.png", bytes: Buffer.alloc(bound + 1), addedLines: [] }], NOBODY), []);
});

test("a binary blob is read whole: a home inside it is refused, NULs and UTF-16 included; a clean binary passes", () => {
  const binary = (text: string): ChangedFile => ({ path: "docs/assets/x.bin", bytes: Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(text, "latin1"), Buffer.alloc(9000)]), addedLines: [] });
  const finding = ["docs/assets/x.bin: its binary content names an absolute home path [home-path] (added_content_private)"];
  assert.deepEqual(changeProblems([binary(`${H}${PERSON}/x`)], NOBODY), finding);
  assert.deepEqual(changeProblems([{ ...binary(""), bytes: Buffer.concat([Buffer.from([0, 0]), Buffer.from(`${H}${PERSON}/x`, "utf16le")]) }], NOBODY), finding);
  assert.deepEqual(changeProblems([binary("a clean binary")], NOBODY), []);
});

test("a .ts file that is not TypeScript is refused; a declaration file and the declared excerpts pass", () => {
  // The incident's shape: a test file replaced with a JSON listing.
  assert.deepEqual(changeProblems([file("engine/test/x.test.ts", "{\n  \"tests\": [\n    {\"name\": \"a\"}\n  ]\n}\n,")], NOBODY), ["engine/test/x.test.ts: is not TypeScript: it does not parse (added_content_not_typescript)"]);
  assert.deepEqual(changeProblems([file("engine/src/x.ts", "export const x: number = 1;\n")], NOBODY), []);
  assert.deepEqual(changeProblems([file("engine/src/x.d.mts", "export declare const x: number;\n")], NOBODY), [], "a declaration file is TypeScript");
  for (const path of POLICY.notTypeScriptExemptions) {
    assert.deepEqual(changeProblems([file(path, "not ( typescript")], NOBODY), [], `${path} is a declared exemption`);
  }
});

test("a refusal names file, line and kind, never what it found", () => {
  const problems = changeProblems([file("docs/notes.md", `one\nrun from ${H}${PERSON}/checkout\n`)], identityOf(PERSON, `${H}${PERSON}`));
  assert.deepEqual(problems, [
    "docs/notes.md:2: an added line names an absolute home path [home-path] (added_content_private)",
    "docs/notes.md:2: an added line names the running user's home directory (added_content_private)",
    "docs/notes.md:2: an added line names the running user's account name (added_content_private)",
  ]);
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
  write("docs/notes.md", `ran in ${H}${PERSON}/checkout\n`);
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
  assert.deepEqual(refused[0]!.problems, ["docs/notes.md:1: an added line names an absolute home path [home-path] (added_content_private)"]);
  assert.doesNotMatch(JSON.stringify(refused), new RegExp(PERSON, "u"));
});

test("the hook's question: the staged change, judged with the running user's own identity", () => {
  const { root, git, write } = repository();
  write("docs/readme.md", "base\ncontact alice for access\n");
  git("add", "--", "docs/readme.md");
  assert.deepEqual(stagedChangeProblems(root, { home: null, accountName: "alice" }), ["docs/readme.md:2: an added line names the running user's account name (added_content_private)"]);
  assert.deepEqual(stagedChangeProblems(root, NOBODY), [], "without the local identity a name is only a name");
});

test("only a repository marked throwaway in its own .git/config may name its own root and this harness's guard; anything else of the home stays refused, and nothing is exempt by location", () => {
  const { root, git, write } = repository();
  const local = identityOf(PERSON, `${H}${PERSON}`);
  write("hook.sh", `exec node "${COMMIT_GUARD_PATH}"\npwd >> "${root}/witness.txt"\n`);
  git("add", "--", "hook.sh");
  assert.equal(throwawayReading(root), null, "an unmarked repository has no references");
  assert.ok(stagedChangeProblems(root, identityOf(PERSON, dirname(root))).length > 0, "an unmarked repository under the home names it");
  markThrowawayRepository(root);
  const reading = throwawayReading(root);
  assert.ok(reading !== null && "references" in reading);
  assert.deepEqual([...reading.references].toSorted(), [...new Set([root, realpathSync(root), COMMIT_GUARD_PATH, realpathSync(COMMIT_GUARD_PATH)])].toSorted());
  assert.deepEqual(stagedChangeProblems(root, identityOf(PERSON, dirname(root))), [], "its own root and the guard are its references");
  assert.deepEqual(homePathFindings(`cd ${H}${PERSON}/project`, { ...local, references: reading.references }).toSorted(), ["an absolute home path [home-path]", "the running user's account name", "the running user's home directory"]);
});

test("the throwaway marker is refused, typed, wherever the repository is not a throwaway one: a workspace, a candidate, a project and its worktrees, a home, a scope outside its .git", () => {
  const refusedFor = (root: string): string => {
    const reading = throwawayReading(root);
    assert.ok(reading !== null && "refusal" in reading, JSON.stringify(reading));
    assert.match(reading.refusal, /\(added_content_throwaway_marker_misplaced\)$/u);
    assert.deepEqual(stagedChangeProblems(root, NOBODY), [reading.refusal], "the hook refuses with it");
    return reading.refusal;
  };
  const agent = repository();
  markThrowawayRepository(agent.root);
  execFileSync("git", ["config", "--local", ROOT_POLICY.workflow.commitIdentity.agentCheckoutKey, "true"], { cwd: agent.root });
  assert.match(refusedFor(agent.root), /an agent's checkout/u);

  const project = repository();
  project.write("engine/scripts/commit-guard.ts", "export {};\n");
  project.git("add", "--", "engine/scripts/commit-guard.ts");
  markThrowawayRepository(project.root);
  assert.match(refusedFor(project.root), /a project/u);

  // A linked worktree of a project is that project (its index holds the guard), wherever it lies.
  const linked = join(createTempDir("added-content-linked-"), "w");
  project.git("commit", "-q", "-m", "the guard");
  project.git("worktree", "add", "-q", "-b", "w", linked);
  assert.match(refusedFor(linked), /a project/u);

  const home = repository();
  markThrowawayRepository(home.root);
  mkdirSync(join(home.root, "me"));
  const savedHome = process.env["HOME"];
  process.env["HOME"] = join(home.root, "me");
  try {
    assert.match(refusedFor(home.root), /holds the running user's home/u);
  } finally {
    process.env["HOME"] = savedHome;
  }

  const scoped = repository();
  const globalConfig = join(createTempDir("added-content-global-"), "gitconfig");
  writeFileSync(globalConfig, `[${POLICY.throwawayRepositoryKey.split(".")[0]!}]\n\t${POLICY.throwawayRepositoryKey.split(".")[1]!} = true\n`);
  const savedGlobal = process.env["GIT_CONFIG_GLOBAL"];
  process.env["GIT_CONFIG_GLOBAL"] = globalConfig;
  try {
    assert.match(refusedFor(scoped.root), /outside the repository's own \.git\/config/u);
  } finally {
    if (savedGlobal === undefined) delete process.env["GIT_CONFIG_GLOBAL"];
    else process.env["GIT_CONFIG_GLOBAL"] = savedGlobal;
  }
});

test("main's tree passes retroactively: every line of every tracked file, judged as added", () => {
  const root = join(import.meta.dirname, "..", "..", "..");
  const files = treeFiles(root, "HEAD");
  assert.ok(files.length > 1000, `the tree is judged whole (liveness): ${String(files.length)} files`);
  assert.deepEqual(changeProblems(files, NOBODY), []);
});
