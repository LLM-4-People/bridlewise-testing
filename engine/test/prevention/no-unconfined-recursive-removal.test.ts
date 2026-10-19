/**
 * NO RECORDED SHIM OR TEST COMMAND RECURSIVELY REMOVES AN UNCONFINED PLACE
 * (the security re-verification's S0; the FLAKE-REPRO decision).
 *
 * 48 recorded reproduction shims once ran `rm -rf "$HOME"`, safe only because
 * each record also set HOME to a scratch path — and nothing checked that the
 * override happened. One failed override would have removed the user's real
 * home. The door now gives every run a fresh world and refuses such a shim at
 * its request; this guard holds the WHOLE TREE to the same rule, through the
 * one detector (`unconfinedRecursiveRemoval`, src/shared/flake-reproduction.ts):
 * an `rm` with a recursive flag whose target is rooted at `$HOME`, `~`, or a
 * variable the same command did not make with `mktemp -d`.
 *
 * Scope: every recorded reproduction's and every kept attempt's setup and
 * alongside command, every npm script of both packages, every tracked shell
 * script and git hook, and every string a source holds (engine/src,
 * engine/scripts, engine/test, engine/live, tests, scripts; read by the one
 * Babel owner; widened past the test roots). The detector's
 * own two test files plant offenders on purpose and are the only files not
 * read for strings.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseSourceModule, walkAst } from "../../src/quality-packs/prevention/ast-helpers.ts";
import { flakeAttemptDirectory, flakeReproductionDirectory, unconfinedRecursiveRemoval } from "../../src/shared/flake-reproduction.ts";

const ENGINE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPOSITORY_ROOT = join(ENGINE_ROOT, "..");

const SOURCE_ROOTS = ["engine/src/", "engine/scripts/", "engine/test/", "engine/live/", "tests/", "scripts/"];
const SOURCE_EXTENSIONS = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/u;

/** The detector's own tests: they plant offenders to prove it refuses them. */
const DETECTOR_TESTS: ReadonlySet<string> = new Set(["engine/test/git/flake-reproduction.test.ts", "engine/test/prevention/no-unconfined-recursive-removal.test.ts"]);

/** Every string a source holds: its string literals and its template literals' text. */
function stringsOf(path: string, text: string): readonly string[] {
  const strings: string[] = [];
  walkAst(parseSourceModule(path, text), (node) => {
    if (node.type === "StringLiteral" && typeof node.value === "string") strings.push(node.value);
    if (node.type === "TemplateLiteral") strings.push((node.quasis as { value: { cooked: string | null } }[]).map((quasi) => quasi.value.cooked ?? "").join("${X}"));
  });
  return strings;
}

/** Every command the guard holds, with where it was found. */
function commandsOfTheTree(): readonly Readonly<{ where: string; command: string }>[] {
  const commands: { where: string; command: string }[] = [];
  // EVERY record file and every kept attempt, whether or not it explains anything now (a record the verdict ignores —
  // written before the attempts were kept, or by hand — still carries the commands it ran): each must at least be JSON.
  const directory = flakeReproductionDirectory(ENGINE_ROOT);
  const attempts = flakeAttemptDirectory(ENGINE_ROOT);
  const documents: { where: string; value: unknown }[] = [];
  const files = [
    ...(existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith(".json")).sort().map((name) => ({ name, path: join(directory, name) })) : []),
    ...(existsSync(attempts) ? readdirSync(attempts).filter((name) => name.endsWith(".json")).sort().map((name) => ({ name: `attempts/${name}`, path: join(attempts, name) })) : []),
  ];
  for (const { name, path } of files) {
    const text = readFileSync(path, "utf8");
    const values = [text];
    for (const [index, value] of values.entries()) {
      let parsed: unknown;
      assert.doesNotThrow(() => { parsed = JSON.parse(value); }, `${name}${values.length > 1 ? `:${String(index + 1)}` : ""} is JSON (an unreadable one would hide its shim from this guard)`);
      documents.push({ where: `${name}${values.length > 1 ? `:${String(index + 1)}` : ""}`, value: parsed });
    }
  }
  for (const { where, value } of documents) {
    const conditions = (value as { conditions?: { setup?: unknown; during?: unknown } } | null)?.conditions;
    for (const [field, command] of [["setup", conditions?.setup], ["during", conditions?.during]] as const) {
      if (typeof command === "string") commands.push({ where: `the reproduction record ${where} (${field})`, command });
    }
  }
  for (const manifest of ["package.json", "engine/package.json"]) {
    const scripts = (JSON.parse(readFileSync(join(REPOSITORY_ROOT, manifest), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
    for (const [name, command] of Object.entries(scripts)) commands.push({ where: `${manifest} scripts.${name}`, command });
  }
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: REPOSITORY_ROOT, encoding: "utf8", maxBuffer: 1 << 28 }).split("\0").filter((path) => path.length > 0);
  for (const path of tracked) {
    const script = path.endsWith(".sh") || (path.startsWith(".githooks/") && !path.endsWith(".md"));
    const testSource = SOURCE_EXTENSIONS.test(path) && SOURCE_ROOTS.some((root) => path.startsWith(root)) && !DETECTOR_TESTS.has(path);
    if (!script && !testSource) continue;
    // Only a source that spells an `rm` with a flag is parsed for its strings (a fixture that does not parse holds no command).
    let text: string;
    try {
      text = readFileSync(join(REPOSITORY_ROOT, path), "utf8");
    } catch (error) {
      // A tracked path deleted in the working tree has nothing to hold.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    // A shell script is one command (its assignments confine its variables); a test source, each string it holds.
    if (script) commands.push({ where: path, command: text });
    else if (/\brm\s+-/u.test(text)) for (const command of stringsOf(path, text).filter((value) => /\brm\b/u.test(value))) commands.push({ where: path, command });
  }
  return commands;
}

test("no recorded shim, npm script, shell script or test command recursively removes $HOME, ~ or a variable it did not make", () => {
  const commands = commandsOfTheTree();
  assert.ok(commands.some((entry) => entry.where.startsWith("the reproduction record ")), "the reproduction records were read");
  assert.ok(commands.some((entry) => entry.where.endsWith(".sh")), "the shell scripts were read");
  const offenders = commands.flatMap(({ where, command }) => {
    const removal = unconfinedRecursiveRemoval(command);
    return removal === null ? [] : [`${where}: ${removal}`];
  });
  assert.deepEqual(offenders, [], `recursive removals of an unconfined place:\n${offenders.join("\n")}`);
});

test("the detector refuses what the incident recorded, and keeps what a command made itself", () => {
  for (const offender of ['rm -rf "$HOME" && mkdir -p "$HOME/.local/state"', "rm -rf ~", "rm -r $DIR", "rm -fr \"${ROOT}/x\"", "rm --recursive $X", "HOME=$(mktemp -d) && rm -rf \"$HOME\"",
    // The design re-verification's seven misses (F7): a path or a backslash before rm, env, a `cd ~`, find -delete, xargs, a reassignment.
    '/bin/rm -rf "$HOME"', "env rm -rf ~", "\\rm -rf ~", "cd ~ && rm -rf .", 'find "$HOME" -delete', 'echo "$HOME" | xargs rm -rf', 'X=$(mktemp -d) || X="$HOME"; rm -rf "$X"',
    "sudo rm -rf /", "rm -rf /", "nice rm -rf ~"]) {
    assert.notEqual(unconfinedRecursiveRemoval(offender), null, offender);
  }
  for (const confined of ['WORK="$(mktemp -d /x/y.XXXXXX)"\ntrap \'rm -rf "$WORK"\' EXIT', 'W=$(mktemp -d)\nALLOW="$W/allow"\nrm -rf "$ALLOW/store"', 'rm -f "$HOME/one-file"', "rm -rf build/out"]) {
    assert.equal(unconfinedRecursiveRemoval(confined), null, confined);
  }
});
