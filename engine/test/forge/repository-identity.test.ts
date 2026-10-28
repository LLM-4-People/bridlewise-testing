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
import { FORGE_CONFIG_SCHEMA, trunkRepository } from "../../src/workflow/forge/forge-config.ts";
import { configuredRepositoryIdentity, productRenamedSettings, repositoryIdentity, repositoryIdentityCopies, withIdentityLinks } from "../../src/workflow/forge/repository-identity.ts";
import { createTempDir } from "../support/temp-dir.ts";

/** A fresh git working tree (the identity's copies are read from what a tree owns). */
function gitTop(prefix: string): string {
  const top = createTempDir(prefix);
  execFileSync("git", ["init", "-q"], { cwd: top });
  return top;
}
import { SETTINGS, SOURCES, TRUNK } from "./forge-settings.ts";

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
    // The product's repository and the preview: identities of their own, from the section's flags.
    product: { name: "bridlewise", fullName: "LLM-4-People/bridlewise", webUrl: "https://github.com/LLM-4-People/bridlewise", pagesUrl: "https://llm-4-people.github.io/bridlewise/" },
    preview: { name: "bridlewise", fullName: "LLM-4-People/bridlewise", webUrl: "https://github.com/LLM-4-People/bridlewise", pagesUrl: "https://llm-4-people.github.io/bridlewise/" },
  });
});

test("THE P1.10 RENAME is one edit of the forge section: the preview is renamed first, then the trunk takes the product's name and flag; renaming the trunk alone is refused", () => {
  const renamed = productRenamedSettings(SETTINGS);
  const named = (flag: "product" | "preview") => renamed.repositories.filter((repository) => repository[flag] === true).map((repository) => repository.name);
  assert.equal(trunkRepository(renamed).name, "bridlewise");
  assert.deepEqual(named("product"), ["bridlewise"], "the product is published from the renamed trunk");
  assert.deepEqual(named("preview"), ["bridlewise-preview"], "the preview keeps its flag under its new name");
  assert.deepEqual(renamed.appsPage.legacyApps.flatMap((app) => app.repositories), ["bridlewise"], "the legacy App page follows the trunk");
  assert.deepEqual(renamed.retired.map((entry) => entry.repository), ["bridlewise"], "the retired rulesets follow the trunk");
  const identity = repositoryIdentity(renamed);
  assert.equal(identity.product.fullName, identity.fullName);
  assert.equal(identity.preview?.webUrl, "https://github.com/LLM-4-People/bridlewise-preview");
  // Idempotent: the already-renamed section is answered unchanged (the guard applies the edit to the configured section).
  assert.deepEqual(productRenamedSettings(renamed), renamed);
  // The trunk renamed alone collides with the preview's name: the schema refuses it.
  assert.throws(() => FORGE_CONFIG_SCHEMA.parse({ ...SETTINGS, repositories: SETTINGS.repositories.map((repository) => repository.kind === "trunk" ? { ...repository, name: "bridlewise" } : repository) }), /unique/u);
  // Without a preview declared there is nothing to rename first: refused, typed.
  assert.throws(() => productRenamedSettings({ ...SETTINGS, repositories: SETTINGS.repositories.map((repository) => { const { preview: _preview, ...rest } = repository; return rest; }) }), (error: unknown) => isForgeError(error, "forge_declaration_invalid"));
});

test("each identity reference names its own repository before the rename: product and product-site the product's, preview the preview's, repo and site the trunk's", () => {
  const identity = repositoryIdentity(SETTINGS);
  const text = "[a][product:] [b][product:releases] [c][product-site:docs/] [d][preview:releases/tag/v1] [e][repo:issues] [f][site:floor/]\n";
  const definitions = new Map(withIdentityLinks(text, identity).split("\n").flatMap((line) => {
    const match = /^\[([^\]]+)\]: (\S+)$/u.exec(line);
    return match === null ? [] : [[match[1]!, match[2]!] as const];
  }));
  assert.deepEqual(Object.fromEntries(definitions), {
    "product:": "https://github.com/LLM-4-People/bridlewise",
    "product:releases": "https://github.com/LLM-4-People/bridlewise/releases",
    "product-site:docs/": "https://llm-4-people.github.io/bridlewise/docs/",
    "preview:releases/tag/v1": "https://github.com/LLM-4-People/bridlewise/releases/tag/v1",
    "repo:issues": "https://github.com/LLM-4-People/bridlewise-testing/issues",
    "site:floor/": "https://llm-4-people.github.io/bridlewise-testing/floor/",
  });
  // After the rename the product is the trunk, and the preview keeps its own repository under its new name.
  const after = repositoryIdentity(productRenamedSettings(SETTINGS));
  assert.match(withIdentityLinks("[a][product:] [d][preview:]\n", after), /\[preview:\]: https:\/\/github\.com\/LLM-4-People\/bridlewise-preview\n\[product:\]: https:\/\/github\.com\/LLM-4-People\/bridlewise\n/u);
});

test("a rename is one value: the trunk's new name moves every address, and nothing else", () => {
  const renamed = { ...SETTINGS, repositories: SETTINGS.repositories.map((repository) => repository.kind === "trunk" ? { ...repository, name: "renamed-trunk" } : repository) };
  const before = repositoryIdentity(SETTINGS);
  const after = repositoryIdentity(renamed);
  for (const field of ["name", "fullName", "webUrl", "gitUrl", "issuesUrl", "pagesBasePath", "pagesUrl"] as const) {
    assert.equal(after[field], before[field].replaceAll("bridlewise-testing", "renamed-trunk"), field);
  }
  assert.equal(after.owner, before.owner);
});

test("the project Pages address derives from the declared Pages domain, not a vendor literal; the configured identity is the configured section's", () => {
  // Another forge declares its own web origin and Pages domain: the address follows both.
  assert.equal(repositoryIdentity({ ...SETTINGS, webUrl: "https://git.example.com", pagesDomain: "pages.example.com" }).pagesUrl, `https://${SETTINGS.organization.toLowerCase()}.pages.example.com/${TRUNK}/`);
  assert.deepEqual(configuredRepositoryIdentity(), repositoryIdentity(configuredForge()));
});

test("the identity's copies are generated, a field each: package.json and CITATION.cff follow a rename; another shape is refused", () => {
  const top = gitTop("identity-copies-");
  const manifest = { name: "x", repository: { type: "git", url: "https://github.com/LLM-4-People/old.git" }, homepage: "https://github.com/LLM-4-People/old", bugs: { url: "https://github.com/LLM-4-People/old/issues" }, license: "AGPL-3.0-only" };
  writeFileSync(join(top, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(top, "CITATION.cff"), 'cff-version: 1.2.0\nrepository-code: "https://github.com/LLM-4-People/old"\nurl: "https://example.org"\n');
  const renamed = { ...SETTINGS, repositories: SETTINGS.repositories.map((repository) => repository.kind === "trunk" ? { ...repository, name: "bridlewise" } : repository) };
  // The copies are part of the forge-files arm: stale until written, then current.
  assert.deepEqual([...syncForgeFiles(top, { ...SOURCES, settings: renamed }, false).changed].filter((path) => !path.startsWith(".github/")), ["CITATION.cff", "package.json"]);
  syncForgeFiles(top, { ...SOURCES, settings: renamed }, true);
  assert.deepEqual([...syncForgeFiles(top, { ...SOURCES, settings: renamed }, false).changed], []);
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
  // A label quoted in code is an example, never a use: inline code and a fence define nothing.
  const quoted = "Write `[text][repo:<path>]` or:\n\n```md\n[x][repo:issues/9]\n```\n";
  assert.equal(withIdentityLinks(quoted, identity), quoted);
  // The heading block holds the repository's name, and follows a rename.
  const heading = "<!-- BEGIN GENERATED: repository name heading, from the repository identity (harness sync; engine/src/workflow/forge/repository-identity.ts) -->\n<!-- END GENERATED: repository name heading -->\n\nText.\n";
  assert.ok(withIdentityLinks(heading, identity).includes("-->\n# bridlewise-testing\n<!-- END GENERATED: repository name heading -->"));
  assert.ok(withIdentityLinks(withIdentityLinks(heading, identity), repositoryIdentity({ ...SETTINGS, repositories: SETTINGS.repositories.map((repository) => repository.kind === "trunk" ? { ...repository, name: "bridlewise" } : repository) })).includes("\n# bridlewise\n"));
  assert.throws(() => withIdentityLinks("x\n<!-- BEGIN GENERATED: repository links, from the repository identity (harness sync; engine/src/workflow/forge/repository-identity.ts) -->\n", identity), (error: unknown) => isForgeError(error, "forge_identity_copy_invalid"));
});
