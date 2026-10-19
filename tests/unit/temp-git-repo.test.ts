// @vitest-environment node
/**
 * THE FIXTURE REPOSITORY IS HERMETIC (a4-design M5, a4-correctness N-6):
 * `createTempGitRepo` creates and drives ITS OWN repository whatever git the
 * caller's environment names. An inherited `GIT_DIR` (git exports it to
 * hooks and linked worktrees — this checkout is one) once pointed its
 * `git init` and `git config` at another repository, which then carried the
 * fixture identity while the fixture had no repository; an ambient global
 * config (`init.defaultBranch`, `core.hooksPath`) shaped the fixture.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createTempDir } from "../helpers/temp-dir.ts";
import { createTempGitRepo } from "../helpers/temp-git-repo.ts";
import { TEST_GIT_IDENTITY } from "../../engine/test/support/test-git-identity.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createTempGitRepo — its own repository, whatever git the environment names", () => {
  test("an inherited GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE never reaches the fixture's git", () => {
    const victim = createTempGitRepo("temp-git-victim-");
    const victimConfig = readFileSync(join(victim.dir, ".git", "config"), "utf8");
    vi.stubEnv("GIT_DIR", join(victim.dir, ".git"));
    vi.stubEnv("GIT_INDEX_FILE", join(victim.dir, ".git", "index"));
    vi.stubEnv("GIT_WORK_TREE", victim.dir);
    const fixture = createTempGitRepo("temp-git-fixture-");
    writeFileSync(join(fixture.dir, "a.txt"), "a\n");
    fixture.git("add", "a.txt");
    fixture.git("commit", "-q", "-m", "fixture");
    expect(existsSync(join(fixture.dir, ".git")), "the fixture has its own repository").toBe(true);
    expect(fixture.git("rev-parse", "--git-dir").trim()).toBe(".git");
    expect(fixture.git("log", "--format=%an").trim()).toBe(TEST_GIT_IDENTITY.name);
    expect(readFileSync(join(victim.dir, ".git", "config"), "utf8"), "the other repository is untouched").toBe(victimConfig);
    expect(existsSync(join(victim.dir, ".git", "index")), "nothing was staged into the other repository").toBe(false);
  });

  test("an ambient global config (default branch, hooks path, signing) never shapes the fixture", () => {
    const home = createTempDir("temp-git-home-");
    const planted = "[init]\n\tdefaultBranch = planted\n[core]\n\thooksPath = /nonexistent-hooks\n[tag]\n\tgpgsign = true\n[user]\n\tname = Ambient Person\n";
    writeFileSync(join(home, ".gitconfig"), planted);
    writeFileSync(join(home, "global.gitconfig"), planted);
    vi.stubEnv("HOME", home);
    vi.stubEnv("GIT_CONFIG_GLOBAL", join(home, "global.gitconfig"));
    const repo = createTempGitRepo("temp-git-ambient-");
    expect(repo.git("symbolic-ref", "--short", "HEAD").trim(), "the first branch is named, never the ambient default").toBe("main");
    expect(() => repo.git("config", "--get", "core.hooksPath"), "no ambient hooks path").toThrow("git config --get core.hooksPath failed in");
    writeFileSync(join(repo.dir, "a.txt"), "a\n");
    repo.git("add", "a.txt");
    repo.git("commit", "-q", "-m", "fixture");
    repo.git("tag", "-a", "v1", "-m", "an annotated tag is not signed by the ambient config");
    expect(repo.git("log", "--format=%an").trim()).toBe(TEST_GIT_IDENTITY.name);
    expect(createTempGitRepo("temp-git-named-", { initialBranch: "master" }).git("symbolic-ref", "--short", "HEAD").trim()).toBe("master");
  });
});
