/**
 * THE REPOSITORY REGISTRY (src/workflow/repository-registry.ts): one home per
 * repository, under its git common directory, the same from every checkout.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

import { PRODUCT_NAME } from "../../src/kernel/product-identity.ts";
import { REPOSITORY_REGISTRY_AREAS, repositoryRegistry, repositoryRegistryArea, resolveRepositoryRegistry } from "../../src/workflow/repository-registry.ts";
import { createTempDir } from "../support/temp-dir.ts";
import { testGitIdentityEnvironment } from "../support/test-git-identity.ts";

test("the registry lives under the common dir, named by the product; its home is the repository's directory", () => {
  assert.deepEqual(repositoryRegistry("/work/repo/.git"), { commonDir: "/work/repo/.git", home: "/work/repo", root: `/work/repo/.git/${PRODUCT_NAME}` });
  assert.deepEqual(repositoryRegistry("/srv/bare.git"), { commonDir: "/srv/bare.git", home: "/srv/bare.git", root: `/srv/bare.git/${PRODUCT_NAME}` });
  const registry = repositoryRegistry("/work/repo/.git");
  for (const area of Object.keys(REPOSITORY_REGISTRY_AREAS) as (keyof typeof REPOSITORY_REGISTRY_AREAS)[]) {
    assert.equal(repositoryRegistryArea(registry, area), join(registry.root, REPOSITORY_REGISTRY_AREAS[area]));
  }
});

test("a linked worktree and the main checkout resolve one registry", () => {
  const root = createTempDir("repository-registry-");
  const linked = join(createTempDir("repository-registry-linked-"), "wt");
  const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...testGitIdentityEnvironment() } }).trim();
  git(root, "init", "-q", "-b", "main");
  git(root, "commit", "-q", "--allow-empty", "-m", "init");
  git(root, "worktree", "add", "-q", "--detach", linked);
  const commonDir = { commonDir: (cwd: string): string => git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir") };
  assert.deepEqual(resolveRepositoryRegistry(commonDir, linked, 1_000), resolveRepositoryRegistry(commonDir, root, 1_000));
  assert.equal(resolveRepositoryRegistry(commonDir, linked, 1_000).home, git(root, "rev-parse", "--show-toplevel"));
});
