import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { resolveGitExecutable } from "../../src/git/git-adapter.ts";

/**
 * ONE WAY TO FIND GIT (the user's standing rule: one package, probe, never
 * branch per host or OS): `resolveGitExecutable` with no override asks the
 * shell once (`command -v git`, as one bounded run) and answers the absolute
 * path it names. There is no per-OS lookup command and no list of guessed
 * install paths. A PATH that holds no git is the typed refusal
 * `git_executable_not_found`, never a silent substitute. An override must
 * name an existing absolute path.
 */

test("GitExecutable: PATH's git, found by one shell probe, as an absolute path", () => {
  const resolved = resolveGitExecutable();
  assert.ok(isAbsolute(resolved), `expected an absolute path, got ${resolved}`);
  assert.ok(resolved.endsWith("git"), `expected a git binary, got ${resolved}`);
});

test("GitExecutable: a PATH that holds no git is the typed refusal, never a guessed install path", () => {
  // A process whose PATH holds no git (its environment is fixed when it starts, as its bounded run's thread's is).
  const adapter = pathToFileURL(join(import.meta.dirname, "..", "..", "src", "git", "git-adapter.ts")).href;
  const script = `const { resolveGitExecutable } = await import(${JSON.stringify(adapter)}); try { resolveGitExecutable(); console.log("found"); } catch (error) { console.log(error.code); }`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, PATH: "/nonexistent-bridlewise-path" } });
  assert.equal(child.stdout.trim().split("\n").at(-1), "git_executable_not_found", child.stderr);
});

test("GitExecutable: an override must be an existing absolute path", () => {
  assert.throws(() => resolveGitExecutable("relative/git"), (error: unknown) => (error as { code?: string }).code === "git_executable_invalid");
  assert.throws(() => resolveGitExecutable("/nonexistent-bridlewise/git"), (error: unknown) => (error as { code?: string }).code === "git_executable_invalid");
  assert.equal(resolveGitExecutable(process.execPath), process.execPath, "an existing absolute override is taken as given");
});

test("GitExecutable: the source holds no per-OS branch and no guessed install paths", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "..", "src", "git", "git-adapter.ts"), "utf8");
  const resolver = source.slice(source.indexOf("export function resolveGitExecutable"), source.indexOf("export function defaultOperationContext"));
  assert.doesNotMatch(resolver, /process\.platform|win32|Program Files|homebrew/u);
});
