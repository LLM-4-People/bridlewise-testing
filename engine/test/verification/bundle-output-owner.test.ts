/** Actual compiler output, publication and freshness share the declared bundle identity. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildBundleInMemory, bundleFreshness, publishBundle } from "../../scripts/build-bundle.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { buildOutputPaths } from "../../src/workflow/hash-binding-registry.ts";
import { createTempDir } from "../support/temp-dir.ts";

const ENGINE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("the default freshness destination agrees with the policy and the declared build-output owner", async () => {
  const report = await bundleFreshness();
  assert.equal(report.path, ROOT_POLICY.selfProtection.bundleRelativePath);
  const repositoryRelative = relative(dirname(ENGINE_ROOT.replace(/\/$/u, "")), join(ENGINE_ROOT, report.path)).replaceAll("\\", "/");
  assert.ok(buildOutputPaths().includes(repositoryRelative), "the real build and the working-copy output owner identify the same artifact");
});

test("a different engine root builds to its declared destination, publishes over older bytes and produces an executable ESM artifact", async () => {
  const root = createTempDir("bundle-output-root-");
  const entry = join(root, "src", "bundle-entry.ts");
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(entry, 'export const identity = "actual compiler output"; export function compute(value: number) { return value * 2; }\n');
  const built = await buildBundleInMemory(root);
  assert.equal(built.path, join(root, ROOT_POLICY.selfProtection.bundleRelativePath));
  assert.equal(built.entryPath, entry);
  assert.equal(built.settings.format, "esm");
  mkdirSync(dirname(built.path), { recursive: true });
  writeFileSync(built.path, 'export const identity = "older artifact";\n');
  const published = publishBundle(built.text, built.path);
  assert.equal(published.bundleBytes, Buffer.byteLength(built.text));
  const artifact = await import(pathToFileURL(built.path).href);
  assert.equal(artifact.identity, "actual compiler output");
  for (const value of [-3, 0, 7]) assert.equal(artifact.compute(value), value * 2);
});
