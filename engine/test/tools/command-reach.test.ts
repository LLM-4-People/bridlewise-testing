/**
 * WHAT A COMMAND CAN REACH (src/tools/command-reach.ts): git by what it IS —
 * its name, git's own programs, a link to git's file under another name —
 * a program launcher by name, and an argument that launches a program; an
 * ordinary command, and an option after `--`, pass.
 */
import assert from "node:assert/strict";
import { chmodSync, linkSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { allowedCommandNameRefusal, PROGRAM_LAUNCHERS } from "../../src/kernel/command-names.ts";
import { commandIsGit, commandReachRefusal, resolveOnPath } from "../../src/tools/command-reach.ts";
import { createTempDir } from "../support/temp-dir.ts";

/** A PATH directory holding a stand-in `git` and three other names for it: a symbolic link, a hard link, and an unrelated program. */
function pathWithGit(): string {
  const bin = createTempDir("command-reach-bin-");
  writeFileSync(join(bin, "git"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "git"), 0o755);
  symlinkSync(join(bin, "git"), join(bin, "vcs-link"));
  linkSync(join(bin, "git"), join(bin, "vcs-hard"));
  writeFileSync(join(bin, "tool"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "tool"), 0o755);
  return bin;
}

test("git is git by its name, git's own programs, and its FILE under any other name (a symbolic or hard link)", () => {
  const bin = pathWithGit();
  for (const command of ["git", "git-receive-pack", join(bin, "git"), "vcs-link", "vcs-hard"]) {
    assert.equal(commandIsGit(command, bin), true, `${command} was not read as git`);
    assert.equal(commandReachRefusal(command, ["commit"], bin)?.code, "tool_command_reaches_git", command);
  }
  // Another git (not the one PATH names first) under another name is still git, by its file's real name.
  const elsewhere = createTempDir("command-reach-other-git-");
  writeFileSync(join(elsewhere, "git"), "#!/bin/sh\nexit 0\n");
  symlinkSync(join(elsewhere, "git"), join(bin, "vcs-other"));
  assert.equal(commandReachRefusal("vcs-other", ["commit"], bin)?.code, "tool_command_reaches_git", "another git by its real name");
  assert.equal(commandIsGit("tool", bin), false);
  assert.equal(commandReachRefusal("tool", ["commit"], bin), null);
  assert.equal(resolveOnPath("vcs-link", bin), join(bin, "vcs-link"));
  assert.equal(resolveOnPath("absent", bin), null);
});

test("a program launcher is refused by name — at the door and as a name an allowed list may hold", () => {
  for (const launcher of ["sh", "bash", "env", "xargs", "timeout", "nohup"]) {
    assert.ok(PROGRAM_LAUNCHERS.has(launcher), launcher);
    assert.equal(commandReachRefusal(launcher, ["git", "commit"], undefined)?.code, "tool_command_launches_programs", launcher);
    assert.equal(allowedCommandNameRefusal(launcher)?.code, "tool_command_launches_programs", launcher);
  }
  assert.equal(allowedCommandNameRefusal("git")?.code, "tool_command_reaches_git");
  assert.equal(allowedCommandNameRefusal("ls"), null);
});

test("an argument that launches a program is refused in each of its spellings; the same command without it, or after --, passes", () => {
  for (const [command, args] of [
    ["find", [".", "-exec", "git", "commit", ";"]],
    ["find", [".", "-execdir", "git", "add", "{}", ";"]],
    ["find", [".", "-ok", "git", ";"]],
    ["find", [".", "-okdir", "git", ";"]],
    ["fd", ["-x", "git"]],
    ["fd", ["-HX", "git"]],
    ["fd", ["--exec", "git"]],
    ["fd", ["--exec-batch=git"]],
    ["rg", ["--pre", "git", "x"]],
    ["rg", ["--pre=git", "x"]],
    ["sort", ["--compress-program=git", "a"]],
  ] as const) {
    assert.equal(commandReachRefusal(command, args, undefined)?.code, "tool_command_argument_launches_program", `${command} ${args.join(" ")}`);
  }
  for (const [command, args] of [
    ["find", [".", "-name", "x.ts"]],
    ["fd", ["-H", "x"]],
    ["rg", ["--", "--pre"]],
    ["sort", ["-r", "a"]],
    ["ls", ["-x"]],
  ] as const) {
    assert.equal(commandReachRefusal(command, args, undefined), null, `${command} ${args.join(" ")}`);
  }
});
