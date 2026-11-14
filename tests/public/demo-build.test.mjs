import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SITE_FONT_PATH, sitePolicies } from "../../shared/site-page.ts";
import { buildStatus } from "../../scripts/floor/status.mjs";
import { relativePosix, walkFiles } from "../../scripts/floor/files.mjs";
import { servedStatic } from "../../scripts/floor/site-pages.mjs";
import { fileURLToPath } from "node:url";
import { buildDemo, demoGithubEvidence } from "../../scripts/build-demo.ts";
import { FONT_LICENCE } from "../../scripts/vendor-fonts.ts";
import { CODING_EXAMPLE } from "../../src/demo/fixture.ts";
import { parseUnifiedDiff } from "../../src/cockpit/render/diff.ts";
import { createHash } from "node:crypto";
import { resolvePreimageToRange } from "../../engine/src/editor/edit-resolve.ts";
import { computeEdit } from "../../engine/src/editor/edit-operations.ts";
import { bootstrapProcess } from "../../engine/src/runtime/cli-debug.ts";
import { armTestKeyHome } from "../../engine/test/support/test-key-home.ts";

test("a public replay closes connections in both canonical policies without loosening other directives", () => {
  for (const base of ["/demo", "/project/demo"]) {
    const normal = sitePolicies(base);
    const closed = sitePolicies(base, { connections: "none" });
    assert.equal(closed.length, 2);
    for (let index = 0; index < 2; index += 1) {
      const ordinary = normal[index].split("; ");
      const replay = closed[index].split("; ");
      assert.deepEqual(replay.filter((value) => !value.startsWith("connect-src ")), ordinary.filter((value) => !value.startsWith("connect-src ")));
      assert.deepEqual(replay.filter((value) => value.startsWith("connect-src ")), ["connect-src 'none'"]);
    }
  }
  assert.throws(() => sitePolicies("/demo", { connections: "unknown" }), { name: "TypeError", message: /Unknown site connection mode/u });
});

test("the demo output cannot enter its source checkout through a parent symlink or root alias", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "demo-location-"));
  const root = join(scratch, "source");
  const alias = join(scratch, "source-alias");
  mkdirSync(root);
  symlinkSync(root, alias, "dir");
  for (const [source, out] of [[root, join(alias, "new-output")], [alias, join(root, "new-output")], [root, scratch], [root, root]]) {
    await assert.rejects(buildDemo({ root: source, out, baseurl: "/project/demo" }), { name: "TypeError", message: "The demo output must be a new directory outside the checkout" });
  }
  assert.equal(existsSync(join(root, "new-output")), false);
});

test("the built replay publishes a Jekyll-served module closure, exact font licence and no installed worker", async () => {
  bootstrapProcess({ role: "cli" });
  armTestKeyHome();
  const scratch = mkdtempSync(join(tmpdir(), "demo-published-assets-"));
  const out = join(scratch, "output");
  try {
    const status = await buildStatus({ root: fileURLToPath(new URL("../../", import.meta.url)), offline: true });
    const statusFile = join(scratch, "status.json");
    writeFileSync(statusFile, JSON.stringify(status));
    const result = await buildDemo({ out, baseurl: "/project/demo", statusFile });
    // Inspect the real emitted graph rather than guessing hashed chunk names.
    const moduleManifest = JSON.parse(readFileSync(join(out, "module-manifest.json"), "utf8"));
    const publishedFiles = new Set(walkFiles(out).map((file) => relativePosix(out, file)));
    for (const file of publishedFiles) assert.equal(servedStatic(file), true, "Jekyll would omit emitted output: " + file);
    assert.ok(Object.values(moduleManifest).some((chunk) => chunk.isEntry), "Vite records the document entry");
    const flow = moduleManifest["../cockpit/flow/Flow.svelte"];
    assert.ok(flow?.isDynamicEntry, "Vite records the deferred Flow by its source module");
    assert.equal(flow.src, "../cockpit/flow/Flow.svelte");
    for (const [key, chunk] of Object.entries(moduleManifest)) {
      assert.ok(publishedFiles.has(chunk.file), "Missing manifest output for " + key + ": " + chunk.file);
      if (chunk.file.endsWith(".js")) assert.match(chunk.file, /^assets\/module-.+\.js$/u);
      for (const file of [...(chunk.css ?? []), ...(chunk.assets ?? [])]) {
        assert.ok(publishedFiles.has(file), "Missing manifest dependency for " + key + ": " + file);
      }
      for (const imported of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]) {
        assert.ok(Object.hasOwn(moduleManifest, imported), "Missing manifest module imported by " + key + ": " + imported);
      }
    }
    assert.equal(result.record.github.availability, "unavailable");
    assert.equal(result.record.github.reason, status.github.reason);
    assert.equal(Object.hasOwn(result.record.github, "observedAt"), false);
    assert.equal(Object.hasOwn(result.record.github, "checks"), false);
    assert.equal(readFileSync(join(out, SITE_FONT_PATH, FONT_LICENCE.file), "utf8"), readFileSync(FONT_LICENCE.source, "utf8"));
    assert.equal(result.record.provenance, "fixture");
    assert.equal(result.record.effects.length, 1);
    const recorded = result.record.effects[0];
    const parsed = parseUnifiedDiff(recorded.patch);
    assert.equal(parsed.files[0].path, CODING_EXAMPLE.path);
    assert.deepEqual([parsed.added, parsed.removed], [1, 1]);
    assert.ok(recorded.patch.includes("-  return items[1];"));
    assert.ok(recorded.patch.includes("+  return items[0];"));
    const published = readFileSync(join(out, "public-replay.json"));
    const fixtureJson = JSON.parse(published.toString("utf8"));
    assert.deepEqual(fixtureJson.effects, result.record.effects);
    assert.deepEqual(fixtureJson.tools, result.record.tools);
    assert.equal(createHash("sha256").update(published).digest("hex"), result.fixtureSha256);
    const edit = result.record.messages.find((message) => message.id === recorded.messageId).toolCall;
    assert.equal(edit.input.path, CODING_EXAMPLE.path);
    const resolved = resolvePreimageToRange(CODING_EXAMPLE.before, edit.input.oldString, { healCascadeEnabled: false });
    assert.equal(resolved.ok, true);
    const computed = computeEdit(CODING_EXAMPLE.before, { kind: "replaceRange", startByte: resolved.startByte, endByte: resolved.endByte, text: edit.input.newString }).newContent;
    assert.equal(computeEdit(CODING_EXAMPLE.before, { kind: "applyPatch", patch: recorded.patch }).newContent, computed);
    const beforeModule = await import("data:text/javascript," + encodeURIComponent(CODING_EXAMPLE.before));
    const afterModule = await import("data:text/javascript," + encodeURIComponent(computed));
    assert.equal(beforeModule.first(["alpha", "beta"]), "beta");
    assert.equal(afterModule.first(["alpha", "beta"]), "alpha");
    assert.equal(afterModule.first([]), undefined);


    for (const file of ["sw.js", "service-worker.js", "manifest.webmanifest"]) assert.equal(existsSync(join(out, file)), false);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("replay evidence preserves the canonical floor observation availability and attempt time", async () => {
  bootstrapProcess({ role: "cli" });
  const status = await buildStatus({ root: fileURLToPath(new URL("../../", import.meta.url)), offline: true, now: new Date("2026-01-01T00:00:00Z") });
  const source = { repository: status.source.repository, repositoryUrl: "https://github.com/" + status.source.repository, commit: status.source.commit, dirty: false, builtAt: status.generatedAt };
  const unavailable = demoGithubEvidence(status, source);
  assert.deepEqual(unavailable, { availability: "unavailable", sourceCommit: source.commit, attemptedAt: status.github.checkedAt, reason: status.github.reason });
  assert.throws(() => demoGithubEvidence({ ...status, github: undefined }, source), { name: "TypeError", message: /no declared GitHub observation/u });
  assert.throws(() => demoGithubEvidence({ ...status, source: { ...status.source, commit: "0".repeat(40) } }, source), { name: "TypeError", message: /source revision/u });
  const observation = { ...status, generatedAt: "2026-02-01T00:00:00Z", github: { ...status.github, available: true, reason: null } };
  const observed = demoGithubEvidence(observation, source);
  assert.equal(observed.availability, "observed");
  assert.equal(observed.observedAt, status.github.checkedAt);
  assert.notEqual(observed.observedAt, observation.generatedAt);
  assert.equal(observed.checks.length, status.checks.length);
});
