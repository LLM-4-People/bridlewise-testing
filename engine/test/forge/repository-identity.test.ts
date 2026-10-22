/**
 * THE REPOSITORY IDENTITY (`repository-identity.ts`): every address of this
 * repository is derived from the `forge` section's organisation, web origin
 * and trunk repository. A rename is ONE value: renaming the trunk moves
 * every derived address with it, and nothing else.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { isForgeError } from "../../src/workflow/forge/codes.ts";
import { configuredForge } from "../../src/workflow/forge/configured-forge.ts";
import { configuredRepositoryIdentity, repositoryIdentity } from "../../src/workflow/forge/repository-identity.ts";
import { SETTINGS } from "./forge-settings.ts";

test("every address is derived from the organisation, the web origin and the trunk", () => {
  assert.deepEqual(repositoryIdentity(SETTINGS), {
    owner: "LLM-4-People",
    name: "bridlewise-testing",
    fullName: "LLM-4-People/bridlewise-testing",
    webUrl: "https://github.com/LLM-4-People/bridlewise-testing",
    gitUrl: "https://github.com/LLM-4-People/bridlewise-testing.git",
    issuesUrl: "https://github.com/LLM-4-People/bridlewise-testing/issues",
    pagesBasePath: "/bridlewise-testing",
    pagesUrl: "https://llm-4-people.github.io/bridlewise-testing/",
    organisationRepositories: SETTINGS.repositories.map((repository) => repository.name),
  });
});

test("a rename is one value: the trunk's new name moves every address, and nothing else", () => {
  const renamed = { ...SETTINGS, repositories: SETTINGS.repositories.map((repository) => repository.kind === "trunk" ? { ...repository, name: "bridlewise" } : repository) };
  const before = repositoryIdentity(SETTINGS);
  const after = repositoryIdentity(renamed);
  for (const field of ["name", "fullName", "webUrl", "gitUrl", "issuesUrl", "pagesBasePath", "pagesUrl"] as const) {
    assert.equal(after[field], before[field].replaceAll("bridlewise-testing", "bridlewise"), field);
  }
  assert.equal(after.owner, before.owner);
});

test("only github.com has derivable project Pages; the configured identity is the configured section's", () => {
  assert.throws(() => repositoryIdentity({ ...SETTINGS, webUrl: "https://git.example.com" }), (error: unknown) => isForgeError(error, "forge_endpoint_invalid"));
  assert.deepEqual(configuredRepositoryIdentity(), repositoryIdentity(configuredForge()));
});
