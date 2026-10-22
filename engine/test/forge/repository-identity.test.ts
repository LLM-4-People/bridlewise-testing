/**
 * THE REPOSITORY IDENTITY (`repository-identity.ts`): every address of this
 * repository is derived from the `forge` section's organisation, web origin
 * and trunk repository. A rename is ONE value: renaming the trunk moves
 * every derived address with it, and nothing else.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { isForgeError } from "../../src/workflow/forge/codes.ts";
import { configuredForge } from "../../src/workflow/forge/configured-forge.ts";
import { syncForgeFiles } from "../../src/workflow/forge/generated-files.ts";
import { configuredRepositoryIdentity, repositoryIdentity, repositoryIdentityCopies, withIdentityLinks } from "../../src/workflow/forge/repository-identity.ts";
import { createTempDir } from "../support/temp-dir.ts";

/** A fresh git working tree (the identity's copies are read from what a tree owns). */
function gitTop(prefix: string): string {
  const top = createTempDir(prefix);
  execFileSync("git", ["init", "-q"], { cwd: top });
  return top;
}
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
  const top = gitTop("identity-copies-");
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
  assert.equal(repositoryIdentityCopies(gitTop("identity-none-"), repositoryIdentity(renamed)).size, 0);
});

test("identity links in a hand-written document: each label used gets its generated definition, the clone command follows the identity, and a rename moves both", () => {
  const identity = repositoryIdentity(SETTINGS);
  const doc = "# Doc\n\nSee [issue 7][repo:issues/7], the [site][site:floor/help/] and [home][repo:].\n\n<!-- BEGIN GENERATED: clone command, from the repository identity (harness sync; engine/src/workflow/forge/repository-identity.ts) -->\n<!-- END GENERATED: clone command -->\n";
  const linked = withIdentityLinks(doc, identity);
  assert.ok(linked.includes("[repo:]: https://github.com/LLM-4-People/bridlewise-testing\n"));
  assert.ok(linked.includes("[repo:issues/7]: https://github.com/LLM-4-People/bridlewise-testing/issues/7\n"));
  assert.ok(linked.includes("[site:floor/help/]: https://llm-4-people.github.io/bridlewise-testing/floor/help/\n"));
  assert.ok(linked.includes("git clone https://github.com/LLM-4-People/bridlewise-testing.git\ncd bridlewise-testing\n"));
  assert.equal(withIdentityLinks(linked, identity), linked, "regenerating changes nothing");
  const renamed = withIdentityLinks(linked, repositoryIdentity({ ...SETTINGS, repositories: SETTINGS.repositories.map((repository) => repository.kind === "trunk" ? { ...repository, name: "bridlewise" } : repository) }));
  assert.equal(renamed.includes("bridlewise-testing"), false, "a rename leaves no old address in the document");
  // A label no longer used loses its definition; a document with none carries no block.
  assert.equal(withIdentityLinks(linked.replace(" and [home][repo:]", ""), identity).includes("[repo:]:"), false);
  assert.equal(withIdentityLinks("# Plain\n", identity), "# Plain\n");
  assert.throws(() => withIdentityLinks("x\n<!-- BEGIN GENERATED: repository links, from the repository identity (harness sync; engine/src/workflow/forge/repository-identity.ts) -->\n", identity), (error: unknown) => isForgeError(error, "forge_identity_copy_invalid"));
});
