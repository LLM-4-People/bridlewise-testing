// Mechanical prevention: no destructive test writes to production artifacts.
//
// A test that writes to a shared production artifact (dist/bundle.js,
// node_modules/, bridlewise.config.json, the on-disk bundle, etc.) races
// with other tests that verify the artifact. The runBundleBuildStep test
// (removed in a prior round) rebuilt the on-disk dist/bundle.js during the test
// suite, racing with the tests that verify the on-disk bundle.
//
// This test scans every test file dynamically (readdirSync — no hardcoded
// list, deny-by-default) for filesystem-write calls where the path argument
// is a RELATIVE string literal starting with a production segment (e.g.
// `writeFileSync("dist/bundle.js", ...)`). A relative literal resolves to
// the repo root (`process.cwd()`), so the write hits the PRODUCTION artifact.
// A write wrapped in `join(<temp-var>, "dist", ...)` is safe — the temp
// variable scopes the write to a temp copy, not the production tree.
//
// Opt-out: a write marked with a `@destructive-test-allowed <reason>` JSDoc
// marker within 5 lines before the write is exempt (same pattern as the global-store marker).
// `@global-store`). Adding a new destructive test (a relative-literal write
// to a production artifact without a marker) is caught automatically — the
// test fails. This is the deny-by-default + dynamic-discovery pattern: a new
// test file is scanned without anyone remembering to add it to a list.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { bodyCalls, enclosingFunctionOf } from "../../src/shared/source-structure.ts";
import { FILESYSTEM_WRITE_APIS } from "../../scripts/verification/effect-surface.ts";
import { generatedOutputPaths } from "../../src/workflow/hash-binding-registry.ts";
import {
  armCheckoutUnderTest,
  assertCheckoutWriteAllowed,
  CHECKOUT_WRITE_REFUSAL_CODE,
  nodeCommandLineOf,
  PROCFS_UNAVAILABLE_WARNING_CODE,
  protectedCheckoutsOfThisProcess,
  testFilesRun,
} from "../../src/filesystem/checkout-write-door.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { stageInCopy } from "../../src/git/working-copy.ts";
import { atomicWriteFile } from "../../src/filesystem/atomic-write.ts";
import { movePath } from "../../src/filesystem/move-path.ts";
import { regenerateHandoffManifest } from "../../scripts/regenerate-handoff-manifest.ts";
import { buildTestInventory, writeTestInventoryTransaction } from "../../scripts/test-inventory.ts";
import { VERIFICATION_PATHS } from "../../src/kernel/verification-paths.ts";
import { isProcessAlive } from "../../src/process/process-facts.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { createRepositoryWorkingCopy, removeRepositoryLocalTemporaryDirectory } from "../support/repository-local-temporary.ts";
import { experimentExclusion, walk } from "../../scripts/verification/source-walk.ts";

const ROOT = process.cwd();

// Production path segments — a relative-literal write starting with one of
// these resolves to the repo root and hits the PRODUCTION artifact. These are
// the shared artifacts that other tests verify + that production code
// consumes. The segments are matched at the START of the string literal
// (after the opening quote), so `"dist/bundle.js"` matches but `"distance"`
// does NOT match (a path segment, not a substring).
const PRODUCTION_SEGMENT_START = "dist|node_modules|bridlewise\\.config\\.json|bundle\\.js";

// Filesystem-write API call pattern. Built from the shared
// FILESYSTEM_WRITE_APIS owner (effect-surface.ts) so a new write API added
// there is automatically scanned here (dynamic discovery). Plus the custom
// `atomicWriteFile` helper (not in node:fs). Excludes `mkdtemp`/`mkdtempSync`
// (temp-dir creation is safe).
const WRITE_API_NAMES = [
  ...FILESYSTEM_WRITE_APIS,
  "atomicWriteFile",
].filter((name) => name !== "mkdtemp" && name !== "mkdtempSync");

// The @destructive-test-allowed marker (opt-out, same pattern as @global-store).
const DESTRUCTIVE_ALLOWED_MARKER = /@destructive-test-allowed\b/u;

// A write call where the first argument is a relative string literal starting
// with a production segment. The `["'`]` after `(\s*` matches the opening
// quote of the literal; the production segment must follow immediately (a
// relative path resolves to the repo root). A `join(<var>, ...)` call has
// `join(` as the first argument (not a string), so it does NOT match. A
// template literal with interpolation (`` `${tmp}/dist/... ``) starts with
// `${`, not a production segment, so it does NOT match.
const WRITE_API_REGEXES: ReadonlyArray<RegExp> = WRITE_API_NAMES.map((name) =>
  new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*\\(\\s*["'\`](${PRODUCTION_SEGMENT_START})`, "u"),
);

function hasDestructiveAllowedMarkerNearLine(source: string, lineIndex: number): boolean {
  const lines = source.split("\n");
  // Search backwards up to 5 lines for the marker (JSDoc before the test or
  // a comment on the line before the write).
  for (let i = lineIndex; i >= Math.max(0, lineIndex - 5); i -= 1) {
    if (DESTRUCTIVE_ALLOWED_MARKER.test(lines[i] ?? "")) return true;
  }
  return false;
}

function listTestFiles(dir: string, acc: string[] = []): string[] {
  // `support` holds the helpers these rules protect with markers of their own.
  for (const file of walk(dir, { exts: [".ts"], ignore: ["support"], exclude: experimentExclusion(ROOT) })) {
    if (file.endsWith(".test.ts")) acc.push(file);
  }
  return acc;
}

function findDestructiveWrites(source: string): readonly { line: number; segment: string }[] {
  const lines = source.split("\n");
  const hits: { line: number; segment: string }[] = [];
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const trimmed = line.trim();
    // Track block-comment state across lines so a write-call example inside
    // a JSDoc `/** ... */` block is not flagged.
    if (inBlockComment) {
      if (trimmed.includes("*/")) inBlockComment = false;
      continue;
    }
    // Skip full-line comments (line comment `//` or JSDoc line `*`).
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) {
      // A `/*` without a closing `*/` on the same line opens a block comment.
      if (trimmed.startsWith("/*") && !trimmed.includes("*/")) {
        inBlockComment = true;
      }
      continue;
    }
    // A `/*` opening on a non-comment line (rare) starts a block comment.
    if (trimmed.startsWith("/*") && !trimmed.includes("*/")) {
      inBlockComment = true;
      continue;
    }
    // Must match a write-call-with-relative-production-literal pattern.
    const matchingRegex = WRITE_API_REGEXES.find((regex) => regex.test(line));
    if (matchingRegex === undefined) continue;
    // Extract the matched segment for the violation message.
    const segmentMatch = line.match(new RegExp(`(${PRODUCTION_SEGMENT_START})`, "u"));
    const segment = segmentMatch?.[1] ?? "production-artifact";
    // Must NOT be marked with @destructive-test-allowed near this line.
    if (hasDestructiveAllowedMarkerNearLine(source, i)) continue;
    hits.push({ line: i + 1, segment });
  }
  return hits;
}

test("prevention: no test writes to production artifacts via relative literals (dist/, bundle.js, node_modules/, config file)", () => {
  const files = listTestFiles(join(ROOT, "test"));
  const violations: string[] = [];
  for (const file of files) {
    const rel = relative(ROOT, file).replaceAll("\\", "/");
    const source = readFileSync(file, "utf8");
    const destructiveWrites = findDestructiveWrites(source);
    for (const hit of destructiveWrites) {
      violations.push(`${rel}:${hit.line} (relative write to production artifact: ${hit.segment})`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    `tests that write to production artifacts race with tests that verify them. ` +
      `Write to a temp dir (join(tmp, "dist/...")) or mark with @destructive-test-allowed <reason>.\n` +
      violations.join("\n"),
  );
});

test("prevention: the destructive-test detection works (marker, temp-root, join, and bare-write cases)", () => {
  // A write marked with @destructive-test-allowed must NOT be flagged.
  const fixtureWithMarker = [
    "/**",
    " * @destructive-test-allowed rebuilds the bundle as the test's subject",
    " */",
    'test("rebuild bundle", () => { writeFileSync("dist/bundle.js", data); });',
  ].join("\n");
  assert.equal(
    findDestructiveWrites(fixtureWithMarker).length,
    0,
    "a write marked with @destructive-test-allowed must NOT be flagged",
  );
  // A write to a temp root via join() must NOT be flagged (the path is
  // join(<temp-var>, "production-segment"), not a relative literal).
  const fixtureWithJoin = 'test("temp", () => { writeFileSync(join(tmp, "dist", "bundle.js"), data); });';
  assert.equal(
    findDestructiveWrites(fixtureWithJoin).length,
    0,
    "a write wrapped in join(<temp-var>, ...) must NOT be flagged (the temp variable scopes the write)",
  );
  // A template-literal write to a temp root must NOT be flagged (starts with ${, not a production segment).
  const fixtureWithTemplate = 'test("temp", () => { writeFileSync(`${tmp}/dist/bundle.js`, data); });';
  assert.equal(
    findDestructiveWrites(fixtureWithTemplate).length,
    0,
    "a template-literal write starting with ${tmp} must NOT be flagged (temp root interpolation)",
  );
  // A bare relative write to a production artifact with no marker MUST be flagged.
  // Construct the fixture so the SOURCE line does not itself contain the
  // matched pattern (avoid the scanner flagging its own self-test fixture).
  const writeFn = "writeFile" + "Sync";
  const fixtureDestructive = `test("bad", () => { ${writeFn}("dist/bundle.js", data); });`;
  assert.equal(
    findDestructiveWrites(fixtureDestructive).length,
    1,
    "a bare relative write to a production artifact (dist/bundle.js) with no marker + no temp root MUST be flagged",
  );
  // A relative write to the config file MUST be flagged.
  const fixtureConfig = `test("bad", () => { ${writeFn}("bridlewise.config.json", data); });`;
  assert.equal(
    findDestructiveWrites(fixtureConfig).length,
    1,
    "a bare relative write to bridlewise.config.json MUST be flagged",
  );
  // A write to a NON-production path must NOT be flagged.
  const fixtureSafe = `test("ok", () => { ${writeFn}("output.txt", data); });`;
  assert.equal(
    findDestructiveWrites(fixtureSafe).length,
    0,
    "a write to a non-production path (output.txt) must NOT be flagged",
  );
});

// ---------------------------------------------------------------------------
// API-LEVEL REAL WRITES — the half the scanner above cannot see.
//
// The scanner matches a write whose FIRST ARGUMENT IS A RELATIVE STRING
// LITERAL. That is a good detector for `writeFileSync("dist/bundle.js", …)`
// and blind to every write performed by calling something that writes:
// `harnessRegister(<repo>, { write: true })` rewrites `src/architecture-manifest.ts`
// and the root policy's inventory hash; spawning the generator with `--write`
// rewrites generated source; `writeConfigRaw(…)` rewrites the shared config.
// All three were live in this repository, none was visible here, and the first
// one was OBSERVED rewriting three tracked files during a session.
//
// A write like that is not forbidden — proving that a zero-drift write changes
// nothing REQUIRES running the real thing. What is forbidden is running it
// with no way back: the target must be snapshotted and RESTORED IN A `finally`
// before anything is asserted, because the moment the property breaks is the
// moment the write lands, and an assertion that reports the damage cannot undo
// it.
//
// `test/support/` is scanned here even though the scanner above skips it —
// a helper that writes is a write, and hiding in a helper is the easiest way
// past a scanner that only reads `*.test.ts`.
// ---------------------------------------------------------------------------

/**
 * Calls that perform a REAL write through an API rather than a path literal,
 * as a REFUSAL proof (expected to write nothing). The write-mode generators
 * (`harnessRegister(…, { write: true })` and its siblings) are not here: they
 * are refused at the live root outright by the stricter rule at the end of
 * this file, restore or not.
 */
const REAL_WRITE_CALLS: ReadonlyArray<Readonly<{ pattern: RegExp; what: string }>> = [
  { pattern: /\bwriteConfigRaw\s*\(/u, what: "writeConfigRaw" },
  // THE FLAG MUST BE AN ARGUMENT TO A CALL, not merely a string on the line.
  // Measured while writing this: an expectations TABLE
  // (`[cmd, ["--write"], "expected_error_code"]`) was reported as an
  // unrestored write, and it invokes nothing. A guard that reports work
  // nobody did is a guard people learn to override, so the flag counts only
  // where something is actually being called.
  { pattern: /\w+\s*\([^)]*["'`]--write["'`]/u, what: "a --write generator invocation" },
];

/** Every `.ts` file under `test/`, INCLUDING the support helpers. */
function listAllTestSources(dir: string, acc: string[] = []): string[] {
  acc.push(...walk(dir, { exts: [".ts"], exclude: experimentExclusion(ROOT) }));
  return acc;
}

/**
 * Real-write call sites in `source` that are NOT inside a construct that
 * restores what they touched.
 *
 * "Restored" is read as a `finally` block that writes a file back INSIDE THE
 * SAME TEST — the shape every correct instance in this repository uses. A
 * temp-directory target is exempt: a call whose path argument is a local
 * variable or a `join(...)` of one is writing somewhere this test made, and
 * there is nothing shared to put back.
 *
 * ── THE SUBJECT IS THE ENCLOSING TEST, NOT THE NEXT SIXTY LINES ───────────
 *
 * This asked whether a `finally`-restore appeared in the SIXTY LINES following
 * the write, and sixty lines is a guess that two things are related because
 * they are near each other. Driven: a test that writes a shared artifact and
 * never restores it PASSES when a DIFFERENT test's `finally { writeFileSync(…)
 * }` sits twenty lines away. That is a live escape in the guard that owns the
 * rule "a test proving a refusal by attempting the real operation must
 * snapshot and restore in a `finally`" — the rule earned when a mutated config
 * write-gate turned confinement off across the whole workspace and two later
 * probes measured the damage as if it were a finding.
 *
 * So the region is now the CONSTRUCT the write is written in. A neighbour's
 * restore is outside it by definition, whatever the byte distance.
 *
 * A write at TOP LEVEL has no enclosing construct, and that is treated as NOT
 * restored: a module-level write in a test file runs at import and there is no
 * `finally` that can cover it.
 */
/** The write-back calls that count as putting a shared artifact back. */
const RESTORING_CALLS = ["writeFileSync", "copyFileSync", "cpSync", "writeFileAtomic", "atomicWriteFile"] as const;

/**
 * Does the construct enclosing `offset` restore what it touched, in a
 * `finally`?
 *
 * TWO STRUCTURAL FACTS, both scoped to the same construct: it must have a
 * `finally` at all, and it must write a file back. Asking the CALL GRAPH for
 * the second one is what a pattern could not do — a `writeFileSync` named in a
 * comment inside the test would have satisfied the previous version.
 */
function restoredWithin(source: string, offset: number): boolean {
  const scope = enclosingFunctionOf(source, offset, "the test around this write");
  // No enclosing construct means no `finally` can cover it.
  if (scope === undefined) return false;
  if (!RESTORING_CALLS.some((call) => bodyCalls(scope, call))) return false;
  // `finally` is a keyword rather than a call, so it is the one thing here the
  // structural doors cannot name — and it is read inside the SCOPE's own text,
  // which is the whole difference from the sixty-line window.
  return /\bfinally\s*\{/u.test(scope.body);
}

export function findUnrestoredRealWrites(source: string): readonly { line: number; what: string }[] {
  const lines = source.split("\n");
  const hits: { line: number; what: string }[] = [];
  // Byte offset of the start of each line, so a line hit can be handed to the
  // structural door as a position.
  const lineOffsets: number[] = [];
  let running = 0;
  for (const line of lines) { lineOffsets.push(running); running += line.length + 1; }
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i]!.trim();
    if (inBlockComment) {
      if (trimmed.includes("*/")) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith("//") || trimmed.startsWith("*")) {
      if (trimmed.startsWith("/*") && !trimmed.includes("*/")) inBlockComment = true;
      continue;
    }
    if (trimmed.startsWith("/*") && !trimmed.includes("*/")) { inBlockComment = true; continue; }
    // Inline comments removed too, so `const x = 1; // harnessRegister(…)` is
    // read as what it is. The line-leading check above only sees a comment
    // that OWNS the line.
    const code = trimmed.replace(/\/\/.*$/u, "");
    for (const { pattern, what } of REAL_WRITE_CALLS) {
      if (!pattern.test(code)) continue;
      // A target that is plainly a temporary directory needs no restore.
      if (/\b(tmp|temp)[A-Za-z]*\b/u.test(code)) continue;
      if (hasDestructiveAllowedMarkerNearLine(source, i)) continue;
      if (!restoredWithin(source, lineOffsets[i]! + lines[i]!.indexOf(trimmed))) hits.push({ line: i + 1, what });
    }
  }
  return hits;
}

test("prevention: a test that drives a REAL write at a shared artifact restores it in a finally", () => {
  const files = listAllTestSources(join(ROOT, "test"));
  // POPULATION AS A RUNTIME NUMBER: a scanner over an empty set reports no
  // violations, which is what the previous shape of this guard effectively did
  // for `test/support/` by skipping the directory outright.
  assert.ok(files.length >= 100, `test sources scanned: ${files.length}`);
  assert.ok(
    files.some((f) => f.includes(`${sep}support${sep}`)),
    "test/support/ must be inside the scanned population — a helper that writes is a write",
  );
  const violations: string[] = [];
  for (const file of files) {
    const rel = relative(ROOT, file).replaceAll("\\", "/");
    for (const hit of findUnrestoredRealWrites(readFileSync(file, "utf8"))) {
      violations.push(`${rel}:${hit.line} — ${hit.what} with no finally-restore`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    "a test that proves a refusal by attempting the real operation must snapshot and restore the target in a `finally`, BEFORE asserting.\n" +
      violations.join("\n"),
  );
});

test("prevention: the real-write detector sees each shape, and does not cry wolf", () => {
  // PLANTED VIOLATIONS, one per shape the detector must recognise.
  // The call names are SPLIT so this file's own fixtures are not read as real
  // call sites by the scan above — the same technique the sibling detector
  // test uses, and for the same reason.
  const wcr = "writeConfig" + "Raw";
  const wflag = "--" + "write";
  const planted = [
    [`test("x", () => { ${wcr}(candidate); });`, "writeConfigRaw"],
    [`test("x", () => { spawnSync(node, [gen, "${wflag}"]); });`, "--write"],
  ] as const;
  for (const [fixture, name] of planted) {
    assert.equal(findUnrestoredRealWrites(fixture).length, 1, `${name} must be flagged when nothing restores it`);
  }
  // CLEAN CONTROLS.
  const restored = [
    'test("x", () => {',
    "  const before = readFileSync(target, \"utf8\");",
    "  try {",
    `    ${wcr}(ROOT);`,
    "  } finally {",
    "    writeFileSync(target, before);",
    "  }",
    "});",
  ].join("\n");
  assert.equal(findUnrestoredRealWrites(restored).length, 0, "a finally-restore must clear the finding");

  // THE NEIGHBOUR, PLANTED. This is the shape the sixty-line window passed: a
  // test that writes a shared artifact and restores NOTHING, with a DIFFERENT
  // test's `finally { writeFileSync(…) }` a few lines below it. The window saw
  // the neighbour's restore and called the first test clean. The construct
  // cannot: the neighbour's `finally` is in another function.
  const neighbour = [
    'test("writes and never puts it back", () => {',
    `  ${wcr}(ROOT);`,
    "  assert.ok(true);",
    "});",
    "",
    'test("a DIFFERENT test, which does restore", () => {',
    "  const before = readFileSync(target, \"utf8\");",
    "  try {",
    "    assert.ok(true);",
    "  } finally {",
    "    writeFileSync(target, before);",
    "  }",
    "});",
  ].join("\n");
  assert.equal(
    findUnrestoredRealWrites(neighbour).length,
    1,
    "a neighbouring test's finally-restore must not clear a finding — that is the escape this guard was written around",
  );

  // AND A RESTORE THAT IS NOT IN A `finally` DOES NOT COUNT, because a restore
  // that only runs on the happy path is absent exactly when the assertion fails.
  const unprotected = [
    'test("x", () => {',
    "  const before = readFileSync(target, \"utf8\");",
    `  ${wcr}(ROOT);`,
    "  writeFileSync(target, before);",
    "});",
  ].join("\n");
  assert.equal(findUnrestoredRealWrites(unprotected).length, 1, "a restore outside a finally must not clear the finding");

  // …and a `finally` that restores nothing does not count either. Both halves
  // of the conjunction need their own liveness, or one of them can rot green.
  const emptyFinally = [
    'test("x", () => {',
    "  try {",
    `    ${wcr}(ROOT);`,
    "  } finally {",
    "    cleanupSomethingElse();",
    "  }",
    "});",
  ].join("\n");
  assert.equal(findUnrestoredRealWrites(emptyFinally).length, 1, "a finally that writes nothing back must not clear the finding");

  // A TOP-LEVEL write has no construct to restore it, and must not pass.
  assert.equal(
    findUnrestoredRealWrites(`${wcr}(ROOT);`).length,
    1,
    "a module-level write runs at import, where no finally can cover it",
  );
  assert.equal(
    findUnrestoredRealWrites(`test("x", () => { ${wcr}(tmpDir); });`).length,
    0,
    "a write at a temp directory has nothing shared to restore",
  );
  assert.equal(findUnrestoredRealWrites(`const x = 1; // ${wcr}(ROOT)`).length, 0, "a comment is not a call");
});

// ---------------------------------------------------------------------------
// WRITE-MODE GENERATORS NEVER TARGET THE CHECKOUT UNDER TEST — REFUSED AT RUNTIME.
//
// The restore rule above is right for a REFUSAL proof: the call is expected
// to write nothing. A write-mode generator is the other shape: `harnessSync`,
// `harnessRegenerate(…, { write: true })`, the binding/registrar/inventory,
// pin-authority and handoff writers rewrite generated files whenever the tree
// disagrees with them. Static detectors of "the live root" lost to most
// spellings, and the first runtime door (env markers + a path string against
// the index) lost to symlinks, `/proc/self/root`, scrubbed children, direct
// `node file.test.ts`, `--test-isolation=none`, a `renameSync` commit and
// untracked files. The door now sits in the shared write primitive
// (`atomicWriteFile`) and decides from procfs and inodes
// (`src/filesystem/checkout-write-door.ts`). Every bypass above is driven here.
// ---------------------------------------------------------------------------

/** Writes the CURRENT bytes back, so a broken refusal still changes nothing. */
function refusalOfSameBytesWrite(path: string): string | undefined {
  const current = readFileSync(path);
  try {
    atomicWriteFile(path, current);
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  } finally {
    assert.ok(readFileSync(path).equals(current), `the probe changed ${path}`);
  }
}

const DOOR = ROOT_POLICY.verification.checkoutWriteDoor;
const RUNNER_MARKERS = ["NODE_TEST_CONTEXT", "VITEST", DOOR.markerEnvironmentVariable];

/** This process's env minus every test-runner marker: the realistic "scrubbed" child. */
function scrubbedEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !RUNNER_MARKERS.includes(name)));
}

/** An env with no marker of any kind: what a raw, hand-started process has. */
function bareEnvironment(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  return { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "", ...extra };
}

const WRITER = pathToFileURL(join(ROOT, "src", "filesystem", "atomic-write.ts")).href;

/** A throwaway checkout (a `.git` entry and one file) that nothing arms. */
function throwawayCheckout(prefix: string): Readonly<{ root: string; tracked: string }> {
  const root = createTempDir(prefix);
  const initialized = spawnSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  const tracked = join(root, "tracked.txt");
  writeFileSync(tracked, "unchanged\n");
  return { root, tracked };
}

test("prevention: the door recognizes a test run from node's own split of the command line — and from nothing else", () => {
  const run = (options: string[], script?: string, scriptArguments: string[] = []) => testFilesRun({ options, script, scriptArguments });
  assert.deepEqual(run(["--test"], "a.test.ts", ["b.test.ts"]), ["a.test.ts", "b.test.ts"]);
  assert.deepEqual(run(["--test-isolation=none", "--test"]), [], "`node --test` naming no file still runs tests");
  assert.deepEqual(run(["--disable-warning", "ExperimentalWarning"], "/r/x.test.ts"), ["/r/x.test.ts"], "an unlisted valued option");
  assert.deepEqual(run(["--env-file-if-exists", "/dev/null"], "/r/x.test.ts"), ["/r/x.test.ts"]);
  assert.deepEqual(run(["--import", "./test/x.test.mjs", "-e", "0"]), ["./test/x.test.mjs"], "a test file as a preload");
  assert.deepEqual(run(["--input-type=module", "-e", 'await import("./test/x.test.mjs")']), ["./test/x.test.mjs"], "a test file in eval code");
  // NOT a test run: a test path that is only a script ARGUMENT, a vitest
  // segment in a project path, a vitest-named script (vitest's main process is
  // ARMED by the suite's config, never guessed), and node test options without
  // `--test` itself.
  assert.equal(run([], "/c/engine/src/cli.ts", ["harness", "sync", "--prune", "test/x.test.ts"]), undefined);
  assert.equal(run([], "/c/engine/src/cli.ts", ["chat", "--cwd", "/home/u/vitest/app"]), undefined);
  assert.equal(run([], "/r/node_modules/vitest/vitest.mjs", ["run", "--test-threads=1"]), undefined);
  assert.equal(run(["--test-reporter=spec"], "/r/plain.mjs"), undefined);
  // A valued option that is not code (wf1c-correctness §1 F8): `--watch-path`
  // names a file node watches, never one it runs.
  assert.equal(run(["--watch-path", "test/x.test.ts", "--watch"], "/r/plain.mjs"), undefined, "a --watch-path value invented a runner");
  assert.deepEqual(run(["--require=./test/x.test.cjs"], "/r/plain.mjs"), ["./test/x.test.cjs"], "a test file as a --require= preload");
  assert.equal(run([], "/c/engine/scripts/tooling/run-tests.ts", ["--auto-add-dispositions"]), undefined, "the runner's auto-heal writes the checkout");
  // An ancestor's procfs command line: the script is the first argument naming an existing file.
  const { root } = throwawayCheckout("door-cmdline-");
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, "test", "x.test.mjs"), "");
  writeFileSync(join(root, "plain.mjs"), "");
  assert.deepEqual(nodeCommandLineOf(["node", "--disable-warning", "ExperimentalWarning", "test/x.test.mjs"], root),
    { options: ["--disable-warning", "ExperimentalWarning"], script: "test/x.test.mjs", scriptArguments: [] });
  assert.equal(testFilesRun(nodeCommandLineOf(["node", "plain.mjs", "--test", "test/x.test.mjs"], root)), undefined, "a script's own --test argument");
  // An ancestor whose file-valued option names a test file is NOT a runner; one whose preload precedes a test script IS.
  assert.equal(testFilesRun(nodeCommandLineOf(["node", "--watch-path", "test/x.test.mjs", "--watch", "plain.mjs"], root)), undefined, "a --watch-path value read from procfs invented a runner");
  assert.deepEqual(nodeCommandLineOf(["node", "--env-file", "plain.mjs", "test/x.test.mjs"], root).script, "test/x.test.mjs");
  assert.deepEqual(testFilesRun(nodeCommandLineOf(["node", "--require", "plain.mjs", "test/x.test.mjs"], root)), ["test/x.test.mjs"], "a preload before a test script hid the runner");
  // WF-1b3b verify M4 / design M11: node runs `test/x.test.mjs` for each of
  // these (the value is the option's); an unclassified valued option hid it.
  for (const option of ["--title", "-C", "--conditions", "--localstorage-file", "--test-rerun-failures"]) {
    assert.deepEqual(testFilesRun(nodeCommandLineOf(["node", option, "plain.mjs", "test/x.test.mjs"], root)), ["test/x.test.mjs"], `${option} <value> hid the runner`);
  }
  // A test reporter or a global setup is a MODULE node runs.
  assert.deepEqual(testFilesRun(nodeCommandLineOf(["node", "--test-reporter", "./test/x.test.mjs", "plain.mjs"], root)), ["./test/x.test.mjs"], "a test file as a reporter module");
  assert.deepEqual(testFilesRun(nodeCommandLineOf(["node", "--test-global-setup=./test/x.test.mjs", "plain.mjs"], root)), ["./test/x.test.mjs"], "a test file as a global setup module");
  // An npm `.bin/` entry is a symlink to the script: `npx vitest run test/x.test.mjs` runs vitest, not the test file.
  mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
  symlinkSync(join(root, "plain.mjs"), join(root, "node_modules", ".bin", "vitest"));
  assert.equal(testFilesRun(nodeCommandLineOf(["node", "node_modules/.bin/vitest", "run", "test/x.test.mjs"], root)), undefined);
});

test("drift: every node option that takes a separate value is classified — the running node's own `--help` is the source (WF-1b3b design M11)", () => {
  const door = ROOT_POLICY.verification.checkoutWriteDoor;
  const classified = new Set<string>([...door.nodeCodeOptions, ...door.nodeValuedOptions]);
  // A boolean that `--help` prints on the same line as its valued sibling.
  const BOOLEAN_ON_A_VALUED_LINE = new Set(["--experimental-default-config-file"]);
  const help = spawnSync(process.execPath, ["--help"], { encoding: "utf8" }).stdout;
  const valued = help.split("\n").flatMap((line) => {
    const listed = /^ {2}(-[^\s=[]+(?:, -[^\s=[]+)*)=\.\.\./u.exec(line);
    return listed === null ? [] : listed[1]!.split(", ");
  });
  assert.ok(valued.length > 40, `the --help parse found ${String(valued.length)} valued options`);
  const unclassified = valued.filter((name) => !classified.has(name) && !BOOLEAN_ON_A_VALUED_LINE.has(name));
  assert.deepEqual(unclassified, [], `node ${process.version} takes a value for these options: add each to ROOT_POLICY checkoutWriteDoor.nodeValuedOptions (or nodeCodeOptions when node runs the value)`);
  for (const name of BOOLEAN_ON_A_VALUED_LINE) assert.ok(valued.includes(name), `${name} is no longer printed on a valued line: delete its declaration`);
});

test("prevention: a MOVE asks the door for both ends — out of the checkout under test and into it are refused, nothing moves (WF-1b3b verify V23)", () => {
  const tracked = join(ROOT, "src", "architecture-manifest.ts");
  const before = readFileSync(tracked);
  const scratch = createTempDir("door-move-");
  const refusalOf = (run: () => void): string | undefined => {
    try {
      run();
      return undefined;
    } catch (error) {
      return (error as { code?: string }).code;
    }
  };
  const stolen = join(scratch, "stolen.ts");
  const planted = join(ROOT, "src", "planted-by-move.ts");
  try {
    // The SOURCE end: a move out of the checkout is a deletion there.
    assert.equal(refusalOf(() => movePath(tracked, stolen)), CHECKOUT_WRITE_REFUSAL_CODE, "a move OUT of the checkout was allowed");
    assert.ok(readFileSync(tracked).equals(before), "the refused move touched the source");
    assert.equal(existsSync(stolen), false);
    // The DESTINATION end: a move into the checkout is a write there.
    writeFileSync(join(scratch, "planted.ts"), "export {};\n");
    assert.equal(refusalOf(() => movePath(join(scratch, "planted.ts"), planted)), CHECKOUT_WRITE_REFUSAL_CODE, "a move INTO the checkout was allowed");
    assert.equal(existsSync(planted), false);
    assert.equal(existsSync(join(scratch, "planted.ts")), true);
  } finally {
    // A door that failed must not leave the checkout damaged: put back what a wrong answer moved.
    if (existsSync(stolen) && !existsSync(tracked)) renameSync(stolen, tracked);
    if (existsSync(planted)) rmSync(planted);
  }
});

test("prevention: in a test process the door refuses the checkout under test — tracked, symlinked, /proc/self/root and untracked spellings", () => {
  assert.ok(protectedCheckoutsOfThisProcess().length > 0, "this test process must protect the checkout it runs in");
  const target = join(ROOT, "src", "architecture-manifest.ts");
  assert.equal(refusalOfSameBytesWrite(target), CHECKOUT_WRITE_REFUSAL_CODE, "canonical path");
  // A symlink to the checkout's src directory, from outside the checkout.
  const outside = createTempDir("door-symlink-");
  symlinkSync(join(ROOT, "src"), join(outside, "alias"));
  assert.equal(refusalOfSameBytesWrite(join(outside, "alias", "architecture-manifest.ts")), CHECKOUT_WRITE_REFUSAL_CODE, "symlink spelling");
  assert.equal(refusalOfSameBytesWrite(`/proc/self/root${target}`), CHECKOUT_WRITE_REFUSAL_CODE, "/proc/self/root spelling");
  // An UNTRACKED file the repository would own (a new module) is refused and never created.
  const fresh = join(ROOT, "src", "workflow", "checkout-door-probe-new-module.ts");
  assert.throws(() => atomicWriteFile(fresh, "export const X = 1;\n"),
    (error: unknown) => (error as { code?: string }).code === CHECKOUT_WRITE_REFUSAL_CODE);
  assert.equal(existsSync(fresh), false);
  // The writable directories (state, fixtures) and paths outside the checkout stay writable;
  // build output does not (a suite that rebuilt the live bundle raced every test verifying it).
  assert.throws(() => assertCheckoutWriteAllowed(join(ROOT, "dist", "bundle.js")),
    (error: unknown) => (error as { code?: string }).code === CHECKOUT_WRITE_REFUSAL_CODE);
  assert.doesNotThrow(() => assertCheckoutWriteAllowed(join(ROOT, ".bridlewise", "test-fixtures", "any.json")));
  assert.doesNotThrow(() => assertCheckoutWriteAllowed(join(ROOT, "..", ".bridlewise", "state", "any.json")), "the checkout's own state root");
  // A state-root NAME planted deeper is not a state root (wf1c-correctness §1 VT15).
  assert.throws(() => assertCheckoutWriteAllowed(join(ROOT, "src", ".bridlewise", "planted.ts")),
    (error: unknown) => (error as { code?: string }).code === CHECKOUT_WRITE_REFUSAL_CODE, "a nested .bridlewise folder was writable under test");
  assert.doesNotThrow(() => assertCheckoutWriteAllowed(join(outside, "elsewhere.ts")));
});

test("prevention: a checkout-owned LINK pointing outside is judged where it is, never where it points (SECB-V-7)", () => {
  // A throwaway checkout, armed in THIS process (it protects nothing else).
  const { root } = throwawayCheckout("door-link-leaf-");
  armCheckoutUnderTest(root);
  const outside = createTempDir("door-link-outside-");
  const target = join(outside, "target.txt");
  writeFileSync(target, "outside\n");
  const link = join(root, "link.txt");
  symlinkSync(target, link);
  // The door: the write/unlink acts on the name inside the checkout, so it is refused
  // (it used to realpath the leaf and judge the outside target: ALLOWED).
  assert.throws(() => assertCheckoutWriteAllowed(link),
    (error: unknown) => (error as { code?: string }).code === CHECKOUT_WRITE_REFUSAL_CODE);
  // The writer: a final link it was not told it may follow is refused before the door.
  assert.throws(() => atomicWriteFile(link, "pwned"),
    (error: unknown) => (error as { code?: string }).code === "atomic_write_link_refused");
  assert.equal(readFileSync(target, "utf8"), "outside\n");
  // Control: the outside target itself is not the checkout's.
  assert.doesNotThrow(() => assertCheckoutWriteAllowed(target));
});

test("prevention: the raw-rename and raw-write generators are refused too (test inventory transaction, handoff manifest)", () => {
  // The inventory is a cache of the tree, never committed (#279): a fresh checkout (every CI job) holds no file, so
  // the inventory written is the owner's own build, and the cache is unchanged — still absent, or still its bytes.
  const inventoryPath = join(ROOT, VERIFICATION_PATHS.testInventory);
  const before = existsSync(inventoryPath) ? readFileSync(inventoryPath) : null;
  assert.throws(
    () => writeTestInventoryTransaction(ROOT, buildTestInventory(ROOT)),
    (error: unknown) => (error as { code?: string }).code === CHECKOUT_WRITE_REFUSAL_CODE,
    "the inventory's renameSync commit asks the door before staging anything",
  );
  assert.deepEqual(existsSync(inventoryPath) ? readFileSync(inventoryPath) : null, before, "the refused write left the cache as it was");
  const manifest = join(ROOT, "traceability", "canonical", "handoff-protocol-manifest.json");
  const manifestBefore = readFileSync(manifest);
  assert.throws(() => regenerateHandoffManifest(manifest),
    (error: unknown) => (error as { code?: string }).code === CHECKOUT_WRITE_REFUSAL_CODE);
  assert.ok(readFileSync(manifest).equals(manifestBefore));
});

test("prevention: a child with a SCRUBBED env (no marker at all) cannot write the checkout under test — it finds its ancestor's held marker", () => {
  const target = join(ROOT, "src", "architecture-manifest.ts");
  const before = readFileSync(target);
  for (const env of [{ PATH: process.env["PATH"] ?? "" }, scrubbedEnvironment()]) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", [
      `const { atomicWriteFile } = await import(${JSON.stringify(WRITER)});`,
      "const { readFileSync } = await import('node:fs');",
      `try { atomicWriteFile(${JSON.stringify(target)}, readFileSync(${JSON.stringify(target)})); process.stdout.write('WROTE'); }`,
      "catch (error) { process.stdout.write(String(error.code)); }",
    ].join("\n")], { cwd: ROOT, env, encoding: "utf8", timeout: 120_000 });
    assert.equal(result.stdout, CHECKOUT_WRITE_REFUSAL_CODE, `${Object.keys(env).join(",")}: ${result.stderr}`);
  }
  assert.ok(readFileSync(target).equals(before));
});

/**
 * A probe TEST FILE in a throwaway checkout, run by hand with no marker: what
 * it protects must come from its own facts. It writes the checkout's tracked
 * file with the same bytes and records each outcome in `out`.
 */
const BYPASS_PROBE = [
  'import { mkdirSync, readFileSync, writeFileSync } from "node:fs";',
  'import { spawn, spawnSync } from "node:child_process";',
  'import { join } from "node:path";',
  "const { DOOR_PROBE_OUT: OUT, DOOR_PROBE_MODE: MODE, DOOR_PROBE_ROOT: ROOT_T } = process.env;",
  "const TARGET = join(ROOT_T, 'tracked.txt');",
  "const WRITE_CODE = (target) => [",
  "  `const { atomicWriteFile } = await import(${JSON.stringify(process.env.DOOR_PROBE_WRITER)});`,",
  "  `const { readFileSync } = await import('node:fs');`,",
  "  `try { atomicWriteFile(${JSON.stringify(target)}, readFileSync(${JSON.stringify(target)})); process.stdout.write('WROTE'); }`,",
  "  'catch (error) { process.stdout.write(String(error.code)); }',",
  "].join('\\n');",
  "if (MODE === 'title') process.title = 'node';",
  "const { atomicWriteFile } = await import(process.env.DOOR_PROBE_WRITER);",
  "const write = (target) => { try { atomicWriteFile(target, readFileSync(target)); return 'WROTE'; } catch (error) { return String(error.code); } };",
  "const outcome = { self: write(TARGET) };",
  "if (MODE === 'title') {",
  "  const child = spawnSync(process.execPath, ['--input-type=module', '-e', WRITE_CODE(TARGET)], { env: { PATH: process.env.PATH }, encoding: 'utf8' });",
  "  outcome.scrubbedChild = child.stdout || child.stderr;",
  "}",
  "if (MODE === 'planted-git') {",
  "  mkdirSync(join(ROOT_T, 'sub', '.git'), { recursive: true });",
  "  writeFileSync(join(ROOT_T, 'sub', 'nested.txt'), 'x\\n');",
  "  outcome.planted = write(join(ROOT_T, 'sub', 'nested.txt'));",
  "}",
  "if (MODE === 'detached') {",
  // The grandchild keeps the env (the marker this probe exported), waits until
  // this probe has exited and it was re-parented, then writes.
  "  const grandchild = spawn(process.execPath, ['--input-type=module', '-e', [",
  "    `const parent = ${process.pid};`,",
  "    'for (let i = 0; i < 200 && process.ppid === parent; i += 1) await new Promise((r) => setTimeout(r, 25));',",
  "    `const { spawnSync } = await import('node:child_process');`,",
  "    `const r = spawnSync(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(WRITE_CODE(TARGET))}], { encoding: 'utf8' });`,",
  "    `(await import('node:fs')).writeFileSync(${JSON.stringify(`${OUT}.detached`)}, JSON.stringify({ reparented: process.ppid !== parent, outcome: r.stdout || r.stderr }));`,",
  "  ].join('\\n')], { detached: true, stdio: 'ignore' });",
  "  outcome.grandchild = grandchild.pid;",
  "  grandchild.unref();",
  "}",
  "writeFileSync(OUT, JSON.stringify(outcome));",
].join("\n");

test("prevention: every known bypass is refused — unlisted node options, --import/-e loaders, process.title, a planted .git, a detached grandchild after its test exited", () => {
  const { root, tracked } = throwawayCheckout("door-bypass-");
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, "test", "probe.test.mjs"), BYPASS_PROBE);
  const cases: ReadonlyArray<readonly [string, readonly string[], string]> = [
    ["unlisted valued option", ["--disable-warning", "ExperimentalWarning", "test/probe.test.mjs"], "self"],
    ["env-file option", ["--env-file-if-exists", "/dev/null", "test/probe.test.mjs"], "self"],
    ["preload loader", ["--import", "./test/probe.test.mjs", "-e", "0"], "self"],
    ["eval loader", ["--input-type=module", "-e", 'await import("./test/probe.test.mjs")'], "self"],
    ["process.title", ["test/probe.test.mjs"], "title"],
    ["planted .git", ["test/probe.test.mjs"], "planted-git"],
    ["detached grandchild", ["test/probe.test.mjs"], "detached"],
  ];
  for (const [label, args, mode] of cases) {
    const out = join(createTempDir("door-bypass-out-"), "report.json");
    const result = spawnSync(process.execPath, args, {
      cwd: root, encoding: "utf8", timeout: 120_000,
      env: bareEnvironment({ DOOR_PROBE_OUT: out, DOOR_PROBE_MODE: mode, DOOR_PROBE_ROOT: root, DOOR_PROBE_WRITER: WRITER }),
    });
    assert.equal(result.status, 0, `${label}: ${result.stderr}`);
    const report = JSON.parse(waitForFile(out, ENDED)) as Record<string, string>;
    assert.equal(report["self"], CHECKOUT_WRITE_REFUSAL_CODE, `${label}: the probe's own write`);
    if (mode === "title") assert.equal(report["scrubbedChild"], CHECKOUT_WRITE_REFUSAL_CODE, "a scrubbed child of a re-titled test finds the held marker");
    if (mode === "planted-git") assert.equal(report["planted"], CHECKOUT_WRITE_REFUSAL_CODE, "a planted .git carves out no checkout");
    if (mode === "detached") {
      const grandchild = Number(report["grandchild"]);
      const detached = JSON.parse(waitForFile(`${out}.detached`, () => isProcessAlive(grandchild))) as { reparented: boolean; outcome: string };
      assert.equal(detached.reparented, true, "the grandchild must outlive its test");
      assert.equal(detached.outcome, CHECKOUT_WRITE_REFUSAL_CODE, "the inherited marker still protects");
    }
  }
  assert.equal(readFileSync(tracked, "utf8"), "unchanged\n");
});

test("prevention: without procfs the door says so, loudly, and a test file still protects its checkout", () => {
  const { root, tracked } = throwawayCheckout("door-noprocfs-");
  mkdirSync(join(root, "test"));
  writeFileSync(join(root, "test", "probe.test.mjs"), BYPASS_PROBE);
  const out = join(createTempDir("door-noprocfs-out-"), "report.json");
  const node = JSON.stringify(process.execPath);
  const probe = spawnSync("unshare", ["--user", "--map-root-user", "--mount", "--fork", "sh", "-c",
    `mount -t tmpfs none /proc && exec ${node} test/probe.test.mjs`], {
    cwd: root, encoding: "utf8", timeout: 120_000,
    env: bareEnvironment({ DOOR_PROBE_OUT: out, DOOR_PROBE_MODE: "self", DOOR_PROBE_ROOT: root, DOOR_PROBE_WRITER: WRITER }),
  });
  assert.equal(probe.status, 0, `mount namespace capability unavailable: ${probe.stderr}`);
  assert.match(probe.stderr, new RegExp(PROCFS_UNAVAILABLE_WARNING_CODE, "u"));
  assert.equal((JSON.parse(waitForFile(out, ENDED)) as { self: string }).self, CHECKOUT_WRITE_REFUSAL_CODE);
  assert.equal(readFileSync(tracked, "utf8"), "unchanged\n");
});

test("regression: the product editor saves under ANY ancestry that is not a test run (vitest in a path, --test-* in a shell line, a vitest-named script)", () => {
  const { root: project } = throwawayCheckout("door-editor-");
  const app = join(project, "app.ts");
  const saver = join(project, "saver.mjs");
  writeFileSync(saver, [
    `const { createTransactionalEditor } = await import(${JSON.stringify(pathToFileURL(join(ROOT, "src", "editor", "transactional-editor.ts")).href)});`,
    `const { sha256 } = await import(${JSON.stringify(pathToFileURL(join(ROOT, "src", "kernel", "integrity.ts")).href)});`,
    "const { readFileSync } = await import('node:fs');",
    `const editor = createTransactionalEditor({ repositoryRoot: ${JSON.stringify(project)}, writeSet: new Set(['app.ts']), skipSyntaxValidation: true });`,
    `const next = \`export const saved = \${Number(process.argv[2])};\\n\`;`,
    `const result = editor.applyEdit({ path: 'app.ts', preimageHash: sha256(readFileSync(${JSON.stringify(app)}, 'utf8')), operation: { kind: 'replaceFile', newContent: next } });`,
    "process.stdout.write(JSON.stringify({ success: result.success, feedback: result.feedback }));",
  ].join("\n"));
  // A script NAMED like vitest's entry, in a node_modules/vitest directory, relaying its args.
  const fakeVitest = join(createTempDir("door-fake-vitest-"), "node_modules", "vitest", "vitest.mjs");
  mkdirSync(dirname(fakeVitest), { recursive: true });
  writeFileSync(fakeVitest, [
    "import { spawnSync } from 'node:child_process';",
    `const r = spawnSync(process.execPath, [${JSON.stringify(saver)}, process.env.DOOR_SAVE_ID], { encoding: 'utf8', env: { PATH: process.env.PATH } });`,
    "process.stdout.write(r.stdout || r.stderr);",
  ].join("\n"));
  const node = JSON.stringify(process.execPath);
  const ancestries: ReadonlyArray<readonly [string, string, readonly string[]]> = [
    ["a vitest-named script with --test-threads", process.execPath, [fakeVitest, "run", "--test-threads=1", "/home/u/vitest/app"]],
    ["a shell line holding --test-*", "sh", ["-c", `${node} ${JSON.stringify(saver)} "$DOOR_SAVE_ID"; : --test-threads=1 --test`]],
    ["a node process with a vitest project path", process.execPath, ["-e", `process.stdout.write(require('node:child_process').spawnSync(${node}, [${JSON.stringify(saver)}, process.env.DOOR_SAVE_ID], { encoding: 'utf8' }).stdout)`, "--", "--project", "/home/u/src/vitest/app"]],
  ];
  ancestries.forEach(([label, command, args], index) => {
    writeFileSync(app, "export const saved = -1;\n");
    const result = spawnSync(command, args, { cwd: project, encoding: "utf8", timeout: 120_000, env: bareEnvironment({ DOOR_SAVE_ID: String(index) }) });
    assert.equal(result.status, 0, `${label}: ${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), { success: true, feedback: null }, `${label}: ${result.stdout}`);
    assert.equal(readFileSync(app, "utf8"), `export const saved = ${index};\n`, `${label}: the save landed`);
  });
});

/**
 * A probe runner hosted IN A WORKING COPY: the copy stands in for "the
 * checkout under test", protected because a test runner runs from it — not
 * because anything told the door so. Its result is a JSON line in `out`.
 */
function plantProbe(engineRoot: string, name: string, body: string): Readonly<{ file: string; out: string }> {
  // Beside the engine, not in its test tree: the probe must not change the
  // engine's own test surface (the generators it drives would refuse that first).
  const directory = join(engineRoot, "..", "door-probe");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${name}.test.ts`);
  const out = join(createTempDir("door-probe-out-"), `${name}.json`);
  writeFileSync(file, [
    'import { spawnSync } from "node:child_process";',
    'import { readFileSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    `const ENGINE = ${JSON.stringify(engineRoot)};`,
    `const OUT = ${JSON.stringify(out)};`,
    "const record = (value: unknown) => writeFileSync(OUT, JSON.stringify(value));",
    body,
  ].join("\n"));
  return { file, out };
}

/**
 * The probe's report at `path`, waited for as long as its WRITER lives
 * (`writerAlive`), never for a wall-clock span (NO-LOAD-BLOCK): a busy host
 * makes a probe slow, not absent. A writer that has ended without a complete
 * report is a refusal, at once.
 */
function waitForFile(path: string, writerAlive: () => boolean): string {
  for (;;) {
    const alive = writerAlive();
    if (existsSync(path)) {
      const text = readFileSync(path, "utf8");
      try {
        JSON.parse(text);
        return text;
      } catch {
        // A partial write while its writer still runs: read again.
      }
    }
    if (!alive) throw new Error(`the probe ended without a complete report: ${path}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
}

/** A writer that has already ended (it ran synchronously): its report is complete, or absent. */
const ENDED = (): boolean => false;
test("prevention: a nested runner in a working copy protects THAT copy — generator CLIs with scrubbed env are refused (inventory renameSync, register)", () => {
  const copy = createRepositoryWorkingCopy("checkout-door-", { include: (path) => path.startsWith("engine/") || path.startsWith("shared/") });
  try {
    // A new test makes `test-inventory --write` rewrite the inventory and the
    // root policy's pin; a new module makes `harness register --write` rewrite
    // the architecture manifest.
    // An added case in an existing test file (dispositions stay complete).
    const existing = join(copy.engineRoot, "test", "shared-suite", "dev-mode-env.test.ts");
    writeFileSync(existing, `${readFileSync(existing, "utf8")}\ntest("checkout door probe extra case", () => {});\n`);
    writeFileSync(join(copy.engineRoot, "src", "workflow", "door-probe-module.ts"), "export const PROBE = 1;\n");
    // The copy's OWN index (never the live one) stages the tree as it stands,
    // so the generators judge a coherent checkout and reach their writes.
    stageInCopy(copy.root, ["engine", "shared"]);
    const watched = [...generatedOutputPaths(copy.root)].map((path) => join(copy.root, path)).filter((path) => existsSync(path));
    const before = watched.map((path) => readFileSync(path, "utf8"));
    const probe = plantProbe(copy.engineRoot, "generators", [
      `const env = ${JSON.stringify(scrubbedEnvironment())};`,
      "const run = (args: string[]) => { const r = spawnSync(process.execPath, args, { cwd: ENGINE, env, encoding: 'utf8', timeout: 300_000 }); return { status: r.status, output: `${r.stdout}${r.stderr}` }; };",
      "record({",
      "  inventory: run([join(ENGINE, 'scripts', 'test-inventory.ts'), '--write']),",
      "  register: run([join(ENGINE, 'src', 'cli.ts'), 'harness', 'register', '--write']),",
      "});",
    ].join("\n"));
    const nested = spawnSync(process.execPath, ["--test", probe.file], { cwd: copy.engineRoot, env: scrubbedEnvironment(), encoding: "utf8", timeout: 600_000 });
    const report = JSON.parse(waitForFile(probe.out, ENDED)) as Record<string, { status: number | null; output: string }>;
    for (const [name, outcome] of Object.entries(report)) {
      assert.notEqual(outcome.status, 0, `${name} must fail: ${outcome.output.slice(-2000)}\n${nested.stdout}`);
      assert.match(outcome.output, new RegExp(CHECKOUT_WRITE_REFUSAL_CODE, "u"), `${name} must be refused by the door`);
    }
    assert.deepEqual(watched.map((path) => readFileSync(path, "utf8")), before, "no generated file of the protected copy changed");
  } finally {
    removeRepositoryLocalTemporaryDirectory(copy.root);
  }
});

test("prevention: `node file.test.ts` and `node --test --test-isolation=none` with NO runner ancestor and NO markers still protect their checkout", () => {
  const copy = createRepositoryWorkingCopy("checkout-door-orphan-", { include: (path) => path.startsWith("engine/") || path.startsWith("shared/") });
  try {
    const target = join(copy.engineRoot, "src", "architecture-manifest.ts");
    const before = readFileSync(target);
    for (const [label, runnerArgs] of [["direct", []], ["isolation-none", ["--test", "--test-isolation=none"]]] as const) {
      const probe = plantProbe(copy.engineRoot, `orphan-${label}`, [
        `const TARGET = ${JSON.stringify(target)};`,
        // Detach from every test ancestor first: wait until the launching
        // shell has exited and this process was re-parented.
        "const launcher = Number(process.env['DOOR_PROBE_LAUNCHER']);",
        `const startMarkers = ${JSON.stringify(RUNNER_MARKERS)}.filter((name) => process.env[name] !== undefined);`,
        "for (let i = 0; i < 100 && process.ppid === launcher; i += 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);",
        "const { atomicWriteFile } = await import(join(ENGINE, 'src', 'filesystem', 'atomic-write.ts'));",
        "let outcome = 'WROTE';",
        "try { atomicWriteFile(TARGET, readFileSync(TARGET)); } catch (error) { outcome = String((error as { code?: string }).code); }",
        "record({ outcome, reparented: process.ppid !== launcher, markers: startMarkers });",
      ].join("\n"));
      // `sh` starts the probe in the background and exits at once, so the
      // probe is orphaned: no test runner remains among its ancestors.
      const launch = spawnSync("sh", ["-c", 'DOOR_PROBE_LAUNCHER=$$; export DOOR_PROBE_LAUNCHER; "$@" >/dev/null 2>&1 & echo $!', "sh", process.execPath, ...runnerArgs, probe.file], {
        cwd: copy.engineRoot, env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" }, encoding: "utf8",
      });
      assert.equal(launch.status, 0, launch.stderr);
      const probePid = Number(launch.stdout.trim());
      const report = JSON.parse(waitForFile(probe.out, () => isProcessAlive(probePid))) as { outcome: string; reparented: boolean; markers: string[] };
      assert.equal(report.reparented, true, `${label}: the probe must run with no test ancestor`);
      if (label === "direct") assert.deepEqual(report.markers, [], "no runner marker in the direct probe's env");
      assert.equal(report.outcome, CHECKOUT_WRITE_REFUSAL_CODE, `${label}: the probe's own checkout is protected`);
    }
    // A WORKER THREAD with an EMPTY environment in such a direct run shares
    // its process's held marker but not its marker variable, and its process
    // is not among its own ancestors: it is under test through its own
    // process's descriptors (wf1c-correctness §1 N3).
    const workerProbe = plantProbe(copy.engineRoot, "orphan-worker", [
      `const TARGET = ${JSON.stringify(target)};`,
      "const launcher = Number(process.env['DOOR_PROBE_LAUNCHER']);",
      "for (let i = 0; i < 100 && process.ppid === launcher; i += 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);",
      "await import(join(ENGINE, 'src', 'filesystem', 'atomic-write.ts'));",
      "const { Worker } = await import('node:worker_threads');",
      "const { pathToFileURL } = await import('node:url');",
      "const WRITER = pathToFileURL(join(ENGINE, 'src', 'filesystem', 'atomic-write.ts')).href;",
      "const code = `const { parentPort } = require('node:worker_threads'); const { readFileSync } = require('node:fs'); import(${JSON.stringify(WRITER)}).then(({ atomicWriteFile }) => { let outcome = 'WROTE'; try { atomicWriteFile(${JSON.stringify(TARGET)}, readFileSync(${JSON.stringify(TARGET)})); } catch (error) { outcome = String(error.code); } parentPort.postMessage(outcome); });`;",
      "const outcome = await new Promise((done) => { const worker = new Worker(code, { eval: true, env: {} }); worker.once('message', done); worker.once('error', (error) => done('ERROR ' + String(error))); });",
      "record({ outcome, reparented: process.ppid !== launcher });",
    ].join("\n"));
    const workerLaunch = spawnSync("sh", ["-c", 'DOOR_PROBE_LAUNCHER=$$; export DOOR_PROBE_LAUNCHER; "$@" >/dev/null 2>&1 & echo $!', "sh", process.execPath, workerProbe.file], {
      cwd: copy.engineRoot, env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" }, encoding: "utf8",
    });
    assert.equal(workerLaunch.status, 0, workerLaunch.stderr);
    const workerPid = Number(workerLaunch.stdout.trim());
    const workerReport = JSON.parse(waitForFile(workerProbe.out, () => isProcessAlive(workerPid))) as { outcome: string; reparented: boolean };
    assert.equal(workerReport.reparented, true, "the worker probe must run with no test ancestor");
    assert.equal(workerReport.outcome, CHECKOUT_WRITE_REFUSAL_CODE, "a worker thread with an empty env wrote the checkout its process tests");
    assert.ok(readFileSync(target).equals(before));
  } finally {
    removeRepositoryLocalTemporaryDirectory(copy.root);
  }
});
