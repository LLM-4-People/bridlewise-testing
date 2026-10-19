import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { readSourceView, sourceViewOf, type SourceView } from "../../scripts/verification/source-view.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { walk } from "../../scripts/verification/source-walk.ts";

// ---------------------------------------------------------------------------
// PREVENTION: test/support/temp-dir.ts is the single owner of test temp dirs.
//
// WHY — a measured defect. Temp dirs were created directly with
// `mkdtempSync(join(tmpdir(), prefix))` at 193 call sites, and through a
// `mkTempDir` helper that registered no cleanup at 688 more. Each site was one
// forgotten `finally` away from leaking, and six files leaked outright.
// Measured in /tmp (a 36G tmpfs): 74,476 stale directories across both repos —
// 6,377 `eval-executor-test-*`, 3,825 `bridlewise-core-*`, 2,847
// `bridlewise-schema-*` from this repo. The filesystem hit 100% and runs
// began failing with ENOSPC.
//
// The previous version of this test only looked for MODULE-LEVEL creation and
// only asked whether the file contained a cleanup token ANYWHERE. Every one of
// the six real leaks was helper-scoped, so all six passed it. It also carried
// a two-entry allowlist whose stated justifications were both false. Both
// weaknesses are gone: the rule below is now positional-independent and has no
// allowlist at all.
//
// DYNAMIC DISCOVERY — the file list is walked from disk on every run. Adding a
// test file can never require editing this test.
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = join(HERE, "..");

/** The one module allowed to reach the system temp root. Derived, not spelled. */
const OWNER = join(TEST_ROOT, "support", "temp-dir.ts");

/** This guard, which must quote the patterns it bans. Structural self-exclusion. */
const GUARD = fileURLToPath(import.meta.url);

function listTestTree(dir: string, acc: string[] = []): string[] {
  acc.push(...walk(dir, { exts: [".ts"] }));
  return acc;
}

/**
 * The view every rule below matches against: ONLY comments blanked, through
 * the sanctioned lexer — prose about temp dirs never trips the scan, while
 * strings AND template interiors stay visible, because a hardcoded
 * `` `/tmp/...` `` path IS a template interior and rule 2's whole subject.
 * (The hand-rolled stripper this replaces also mis-lexed any string
 * containing a slash-star — a glob pattern in a string literal opened a
 * "comment" that swallowed real code until the next star-slash.)
 */
function guardView(view: SourceView): string {
  return view.codeWithStringsAndTemplates();
}

/** Every BANNED hit in one file, through the ONE view — the same function the
 * witness test drives over planted text, so the scan and its proof cannot use
 * different readers. */
function bannedViolations(view: SourceView): ReadonlyArray<{ line: number; excerpt: string; why: string }> {
  const code = guardView(view);
  const out: Array<{ line: number; excerpt: string; why: string }> = [];
  for (const { rule, why } of BANNED) {
    const hit = rule.exec(code);
    if (hit === null) continue;
    out.push({ line: view.lineAt(hit.index), excerpt: hit[0].trim(), why });
  }
  return out;
}

/**
 * The rules target the SYSTEM temp root specifically, because that is where
 * the measured leak accumulated. Reaching it is the only way to leak into it,
 * so denying every route to it is the lowest available choke point.
 *
 * Deliberately NOT banned: `mkdtempSync` into a repository-controlled root.
 * `test/support/repository-local-temporary.ts` does that on purpose — those
 * directories live under the repo, never in /tmp, and are governed by their
 * own capability mechanism. Banning the bare identifier would have flagged it
 * for a leak it cannot cause.
 */
const BANNED: ReadonlyArray<{ readonly rule: RegExp; readonly why: string }> = [
  {
    // Covers `tmpdir()`, `os.tmpdir()`, and any aliased import of it — the
    // import itself is the reachability edge, so aliasing cannot evade it.
    //
    // ⚠ THE BOUND IS `;`, NOT `\n`. This read `[^\n]*`, so a MULTI-LINE
    // aliased import — `import {\n  tmpdir as t,\n} from "node:os"` — was
    // invisible while this very comment claimed aliasing cannot evade it,
    // and the `t()` call site never matches `\btmpdir\b`. The same
    // `\n`-exclusion hole was found and fixed in the debug subtree's import
    // reader; an import clause can span lines but can never contain a
    // semicolon, so `;` bounds the match to one statement without letting it
    // run into an unrelated string.
    rule: /\btmpdir\b(?:\s*\(|[^;]*from\s*["']node:os["'])/,
    why:
      "os.tmpdir() is the system temp root — use createTempDir(prefix) from " +
      "test/support/temp-dir.ts to create, or systemTempRoot() if you only " +
      "need a path string and create nothing",
  },
  {
    // The other route in: skip `tmpdir` and hardcode the path.
    rule: /\b(?:mkdtempSync|mkdirSync|mkdtemp|mkdir)\s*\(\s*(?:join\s*\(\s*)?["'`]\/tmp[/"'`]/,
    why: 'a hardcoded "/tmp/..." path is unowned and collides between concurrent runs',
  },
];

const FILES = listTestTree(TEST_ROOT);

test("prevention: the test tree is actually discovered (the walk is not vacuous)", () => {
  // Without this, every rule below would pass trivially if the walk broke.
  assert.ok(FILES.length > 100, `expected to walk the test tree, found ${FILES.length} files`);
  assert.ok(FILES.includes(OWNER), "the temp-dir owner must be discovered by the walk");
});

test("prevention: the rules are WITNESSED both directions — including the multi-line aliased import that used to be invisible", () => {
  // §36: a scan returning zero violations is indistinguishable from one whose
  // pattern stopped matching. Each shape below is driven through the SAME
  // `bannedViolations` the tree scan uses, so the proof and the scan cannot
  // drift apart.
  const detected: ReadonlyArray<readonly [string, string]> = [
    ["single-line import", `import { tmpdir } from "node:os";\n`],
    // The U-38 shape: the reachability edge spans lines and the binding is
    // aliased, so neither the old single-line clause nor `\btmpdir\b(` at the
    // call site could ever see it.
    ["multi-line aliased import", `import {\n  tmpdir as t,\n} from "node:os";\nconst d = t();\n`],
    // A different alias and a different statement kind, so the guard catches
    // the CLASS and not the one spelling that was driven.
    ["multi-line aliased re-export", `export {\n  tmpdir as systemTemporaryRoot,\n} from "node:os";\n`],
    ["namespace call", `import * as os from "node:os";\nconst d = os.tmpdir();\n`],
    ["hardcoded /tmp string", `mkdtempSync(join("/tmp", "leak-"));\n`],
    // A template interior — the reason the view keeps templates. Reading
    // through `codeWithStrings()` blanks this and the rule goes blind.
    ["hardcoded /tmp template", "mkdirSync(`/tmp/leak-dir`);\n"],
  ];
  for (const [name, plant] of detected) {
    const hits = bannedViolations(sourceViewOf(plant, "planted.ts"));
    assert.ok(hits.length > 0, `${name}: must be detected — the plant was\n${plant}`);
  }
  const invisible: ReadonlyArray<readonly [string, string]> = [
    ["commented multi-line import", `/*\nimport {\n  tmpdir as t,\n} from "node:os";\n*/\nexport const x = 1;\n`],
    ["line-commented call", `// const d = tmpdir();\nexport const x = 1;\n`],
    ["glob string does not open a comment", `const g = "src/*/x";\nconst h = "y/*";\nexport const x = 1;\n`],
    ["innocuous module", `import { join } from "node:path";\nexport const x = join("a", "b");\n`],
  ];
  for (const [name, plant] of invisible) {
    const hits = bannedViolations(sourceViewOf(plant, "planted.ts"));
    assert.deepEqual(hits, [], `${name}: prose and strings about temp dirs are not reachability`);
  }
});

test("prevention: no test file reaches the system temp root except the owner", () => {
  const violations: string[] = [];
  for (const file of FILES) {
    if (file === OWNER || file === GUARD) continue;
    for (const { line, excerpt, why } of bannedViolations(readSourceView(file))) {
      violations.push(`${relative(TEST_ROOT, file)}:${line}  ${excerpt} — ${why}`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    "Temp directories must come from test/support/temp-dir.ts, which creates the " +
      "directory AND registers its removal in the same call:\n" +
      violations.join("\n"),
  );
});

test("prevention: every temp-dir creator in the owner registers its own removal", () => {
  // Structural, not textual. If someone re-adds a bare creator that only calls
  // mkdtempSync — which is exactly how `mkTempDir` leaked 688 call sites — this
  // fails, even though the owner is exempt from the scan above.
  const source = guardView(readSourceView(OWNER));
  const creators = [...source.matchAll(/export function (\w+)[\s\S]*?\n}/g)];
  // A creator makes a directory: with `mkdtempSync`, or with `mkdirSync`
  // inside the process's owned root (the owner's current shape).
  const dirCreators = creators.filter((match) => /\b(?:mkdtempSync|mkdirSync)\s*\(/.test(match[0]));
  assert.ok(dirCreators.length > 0, "the owner must contain at least one temp-dir creator");
  for (const match of dirCreators) {
    assert.ok(
      /LIVE\.add\s*\(/.test(match[0]),
      `owner export ${match[1]} creates a temp dir without registering it for removal`,
    );
  }
});

test("prevention: a temp dir is removed even when the test that made it FAILS", () => {
  // This is the case that actually caused the leak: cleanup written on the
  // happy path disappears the moment a test throws, and tests throw. Proven
  // by running a real, deliberately-failing test file in a child process and
  // checking the filesystem afterwards — not by inspecting source.
  //
  // The fixture is generated into an owned temp dir at run time, so this test
  // adds no file to the tree and cannot go stale.
  const scratch = createTempDir("temp-dir-failure-proof-");
  const marker = join(scratch, "subject-path.txt");
  const fixture = join(scratch, "deliberately-failing.test.ts");
  writeFileSync(
    fixture,
    [
      `import test from "node:test";`,
      `import assert from "node:assert/strict";`,
      `import { writeFileSync } from "node:fs";`,
      `import { createTempDir } from ${JSON.stringify(OWNER)};`,
      `test("deliberately failing", () => {`,
      `  const dir = createTempDir("temp-dir-failure-subject-");`,
      `  writeFileSync(${JSON.stringify(marker)}, dir);`,
      `  assert.equal(1, 2, "this test is meant to fail");`,
      `});`,
      ``,
    ].join("\n"),
    "utf8",
  );

  // The child must NOT inherit this runner's test context, or node:test puts
  // it in child-reporter mode and it exits 0 even when its test fails, which
  // would make the assertion below vacuous. Same guard as the other
  // subprocess tests in this repo (test/workflow/inventory-test-run.test.ts).
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_TEST_WORKER_ID;

  const run = spawnSync(process.execPath, ["--experimental-strip-types", "--test", fixture], {
    encoding: "utf8",
    timeout: 60_000,
    env: childEnv,
  });

  assert.notEqual(run.status, 0, `the fixture was supposed to fail but exited ${run.status}`);
  assert.ok(existsSync(marker), `the fixture never recorded its temp dir:\n${run.stderr}`);

  const subject = readFileSync(marker, "utf8").trim();
  assert.ok(subject.length > 0, "the fixture recorded an empty temp-dir path");
  assert.equal(
    existsSync(subject),
    false,
    `${subject} survived a FAILING test — this is exactly the leak this owner exists to prevent`,
  );
});

test("prevention: the owner registers a file-scope cleanup hook", () => {
  // node:test has no per-test equivalent of vitest's onTestFinished that a
  // bare helper can reach, so the root `after` hook IS the cleanup mechanism.
  // If it is ever removed, nothing else removes the directories.
  const source = guardView(readSourceView(OWNER));
  assert.match(
    source,
    /test\.after\s*\(/,
    "test/support/temp-dir.ts must register a root test.after hook to drain live temp dirs",
  );
});
