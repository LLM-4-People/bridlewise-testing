/**
 * THE REPOSITORY IDENTITY (`repository-identity.ts`): every address of this
 * repository is derived from the `forge` section's organisation, web origin
 * and trunk repository. A rename is ONE value: renaming the trunk moves
 * every derived address with it, and nothing else.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { isForgeError } from "../../src/workflow/forge/codes.ts";
import { configuredForge } from "../../src/workflow/forge/configured-forge.ts";
import { syncForgeFiles } from "../../src/workflow/forge/generated-files.ts";
import { configuredRepositoryIdentity, repositoryIdentity, repositoryIdentityCopies } from "../../src/workflow/forge/repository-identity.ts";
import { createTempDir } from "../support/temp-dir.ts";
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

test("the identity's copies are generated, a field each: package.json and CITATION.cff follow a rename; another shape is refused", () => {
  const top = createTempDir("identity-copies-");
  const manifest = { name: "x", repository: { type: "git", url: "https://github.com/LLM-4-People/old.git" }, homepage: "https://github.com/LLM-4-People/old", bugs: { url: "https://github.com/LLM-4-People/old/issues" }, license: "AGPL-3.0-only" };
  writeFileSync(join(top, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(top, "CITATION.cff"), 'cff-version: 1.2.0\nrepository-code: "https://github.com/LLM-4-People/old"\nurl: "https://example.org"\n');
  const renamed = { ...SETTINGS, repositories: SETTINGS.repositories.map((repository) => repository.kind === "trunk" ? { ...repository, name: "bridlewise" } : repository) };
  // The copies are part of the forge-files arm: stale until written, then current.
  assert.deepEqual([...syncForgeFiles(top, renamed, false).changed].filter((path) => !path.startsWith(".github/")), ["CITATION.cff", "package.json"]);
  syncForgeFiles(top, renamed, true);
  assert.deepEqual([...syncForgeFiles(top, renamed, false).changed], []);
  const written = JSON.parse(readFileSync(join(top, "package.json"), "utf8")) as typeof manifest;
  assert.deepEqual(Object.keys(written), Object.keys(manifest), "every field stays where the file has it");
  assert.deepEqual({ repository: written.repository, homepage: written.homepage, bugs: written.bugs, license: written.license },
    { repository: { type: "git", url: "https://github.com/LLM-4-People/bridlewise.git" }, homepage: "https://github.com/LLM-4-People/bridlewise", bugs: { url: "https://github.com/LLM-4-People/bridlewise/issues" }, license: "AGPL-3.0-only" });
  assert.equal(readFileSync(join(top, "CITATION.cff"), "utf8"), 'cff-version: 1.2.0\nrepository-code: "https://github.com/LLM-4-People/bridlewise"\nurl: "https://example.org"\n', "only the one field changed");
  // Another shape is refused, never guessed: two repository-code lines; a manifest without its bugs object.
  writeFileSync(join(top, "CITATION.cff"), "repository-code: a\nrepository-code: b\n");
  assert.throws(() => repositoryIdentityCopies(top, repositoryIdentity(renamed)), (error: unknown) => isForgeError(error, "forge_identity_copy_invalid"));
  writeFileSync(join(top, "CITATION.cff"), 'repository-code: "x"\n');
  writeFileSync(join(top, "package.json"), `${JSON.stringify({ repository: { url: "u" } })}\n`);
  assert.throws(() => repositoryIdentityCopies(top, repositoryIdentity(renamed)), (error: unknown) => isForgeError(error, "forge_identity_copy_invalid") && /bugs/u.test(error.message));
  // A tree without the files carries no copy.
  assert.equal(repositoryIdentityCopies(createTempDir("identity-none-"), repositoryIdentity(renamed)).size, 0);
});
