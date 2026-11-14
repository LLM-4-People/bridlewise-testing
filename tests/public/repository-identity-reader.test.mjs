import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { generatedRepositoryIdentity } from "../../scripts/floor/repository.mjs";

function fixture(t, name) {
  const root = mkdtempSync(join(tmpdir(), "bridlewise-identity-reader-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".github/forge"), { recursive: true });
  const declared = structuredClone(generatedRepositoryIdentity());
  const addresses = {
    name,
    fullName: `${declared.owner}/${name}`,
    webUrl: `https://github.com/${declared.owner}/${name}`,
    pagesUrl: `https://${declared.owner.toLowerCase()}.github.io/${name}/`,
    pagesBasePath: `/${name}`,
    docsUrl: `https://${declared.owner.toLowerCase()}.github.io/${name}/`,
  };
  const identity = { ...declared, ...addresses, organisationRepositories: [name], product: addresses, preview: null };
  const path = join(root, ".github/forge/repository-identity.json");
  writeFileSync(path, `${JSON.stringify(identity)}\n`);
  return { root, path, identity };
}

test("an explicit repository root selects its own generated identity without changing the default", (t) => {
  const original = generatedRepositoryIdentity();
  const first = fixture(t, "reader-alpha");
  const second = fixture(t, "reader-beta");
  assert.deepEqual(generatedRepositoryIdentity(first.root), first.identity);
  assert.deepEqual(generatedRepositoryIdentity(second.root), second.identity);
  assert.deepEqual(generatedRepositoryIdentity(), original);
  assert.notEqual(first.identity.fullName, second.identity.fullName);
});

test("a missing or malformed selected identity refuses at that root", (t) => {
  const selected = fixture(t, "reader-refusal");
  const absent = join(selected.root, "missing");
  assert.throws(() => generatedRepositoryIdentity(absent), (error) => error instanceof Error
    && error.code === "ENOENT" && error.path === join(absent, ".github/forge/repository-identity.json"));
  writeFileSync(selected.path, JSON.stringify({ ...selected.identity, pagesBasePath: null }));
  assert.throws(() => generatedRepositoryIdentity(selected.root), (error) => error instanceof Error
    && error.message === `${selected.path} is not the generated repository identity: run harness sync`);
});
