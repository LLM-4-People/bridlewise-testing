import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { checkDocsLinks } from "../../scripts/check-docs-links.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");

test("the safety expectation is impossible to miss", () => {
  const readme = read("README.md");
  assert.match(readme, /developer preview/i);
  assert.match(readme, /not production-ready/i);
  assert.match(readme, /sensitive/i);
  assert.match(readme, /AGPL-3\.0/);
});

test("the development floor documents its commands and prerequisites", () => {
  for (const path of [
    "docs/cli.md",
    "docs/testing.md",
    "docs/extending.md",
    "docs/shipping.md",
    "docs/decisions/README.md",
    "docs/design/DESIGN-COCKPIT-V2.md",
  ]) {
    assert.ok(read(path).length > 500, `${path} must contain real documentation`);
  }
});

test("the CLI reference names every top-level command and the harness verbs", () => {
  const cli = read("docs/cli.md");
  for (const token of ["preflight", "quality", "harness", "check", "new-module", "sync", "timeline", "metrics"]) {
    assert.ok(cli.includes(token), `docs/cli.md must mention ${token}`);
  }
});

test("the licence and community files exist", () => {
  assert.match(read("LICENSE"), /GNU AFFERO GENERAL PUBLIC LICENSE/);
  for (const path of ["SECURITY.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "SUPPORT.md"]) {
    assert.ok(read(path).length > 200, `${path} must be substantive`);
  }
});

test("the docs link checker refuses an anchor no heading owns", () => {
  // The guard used to strip `#…` before checking the file, so a link to a
  // section that did not exist passed on the file's existence alone. This
  // plant names a real guide and a section it does not have.
  const root = mkdtempSync(join(tmpdir(), "bridlewise-docs-links-"));
  try {
    writeFileSync(join(root, "MERGE-GUIDE.md"), "# Merge and promotion guide\n\n## Real section\n");
    writeFileSync(
      join(root, "page.md"),
      "[good](MERGE-GUIDE.md#real-section) [bad](MERGE-GUIDE.md#no-such-section)\n",
    );
    const { missing } = checkDocsLinks({ root, files: ["page.md", "MERGE-GUIDE.md"] });
    assert.equal(missing.length, 1, `expected exactly the planted anchor to fail, got ${JSON.stringify(missing)}`);
    assert.match(missing[0], /MERGE-GUIDE\.md#no-such-section/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the refusal list has one owner and both contributor pages point to it", () => {
  const processDoc = read("docs/process/AGENTS.md");
  assert.match(processDoc, /^## What we will not accept$/mu);
  for (const refusal of [
    "skips or deletes a test to make a badge green",
    "hides a failure behind a retry, fallback, or special case",
    "puts a real credential, private source file, or personal data in a fixture",
    'claims a provider "supports everything" without conformance evidence',
    "claims production readiness that the admission gates do not support",
    "quotes a benchmark number without its method",
  ]) {
    assert.ok(processDoc.includes(refusal), `the refusal owner must state: ${refusal}`);
  }
  for (const page of ["docs/floor/help.md", "CONTRIBUTING.md"]) {
    assert.ok(read(page).includes("AGENTS.md#what-we-will-not-accept"), `${page} must point at the refusal owner`);
  }
  assert.doesNotMatch(read("docs/process/TIER1-AGENT-CONTRACT.md"), /Replace a root-cause fix with a retry/u);
});

test("test placement has one owner and the contributor pages point to it", () => {
  assert.match(read("docs/testing.md"), /Put the test beside its subject's domain/u);
  for (const page of ["CONTRIBUTING.md", "docs/floor/help.md"]) {
    assert.ok(read(page).includes("docs/testing.md#adding-a-test"), `${page} must point at the placement owner`);
  }
  assert.doesNotMatch(read("CONTRIBUTING.md"), /Put the test beside its subject's domain/u);
  assert.doesNotMatch(read("docs/floor/help.md"), /CONTRIBUTING\.md#test-conventions/u);
});

test("the briefing routes commit mechanics to their section and reaches the evidence page", () => {
  const briefing = read("AGENTS.md");
  assert.ok(briefing.includes("CONTRIBUTING.md#commit-and-pull-request-style"), "commit mechanics must link their owner");
  assert.ok(briefing.includes("CONTRIBUTING.md#setup"), "setup must link its owner");
  assert.doesNotMatch(briefing, /Setup, the fresh-clone gate and the commit mechanics/u);
  assert.ok(briefing.includes("[Public evidence](docs/floor/evidence.md)"));
  assert.ok(briefing.includes("docs/floor/evidence.md#corpus-boundary"));
});

test("the docs link checker refuses an absolute URL to a process document", () => {
  // The three standing decisions once labelled ROLES.md/WORKFLOW.md/AGENTS.md
  // but all linked the product repository's CONTRIBUTING.md; both guards
  // skipped http(s), so the relative-link resolution never saw them.
  const root = mkdtempSync(join(tmpdir(), "bridlewise-docs-absolute-"));
  try {
    mkdirSync(join(root, "docs/decisions"), { recursive: true });
    mkdirSync(join(root, "docs/process"), { recursive: true });
    writeFileSync(join(root, "docs/process/ROLES.md"), "# Roles\n");
    writeFileSync(
      join(root, "docs/decisions/UR-99-x.md"),
      "[good](../process/ROLES.md) [bad](https://github.com/LLM-4-People/bridlewise/blob/main/CONTRIBUTING.md)\n",
    );
    writeFileSync(
      join(root, "docs/floor.md"),
      "[site](https://github.com/LLM-4-People/bridlewise/blob/main/CONTRIBUTING.md)\n",
    );
    const { missing } = checkDocsLinks({ root, files: ["docs/decisions/UR-99-x.md", "docs/floor.md"] });
    assert.equal(missing.length, 1, `expected exactly the planted absolute URL to fail, got ${JSON.stringify(missing)}`);
    assert.match(missing[0], /docs\/decisions\/UR-99-x\.md/u);
    assert.match(missing[0], /absolute URL names the process document CONTRIBUTING\.md/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the fail-first evidence rule has one owner and the pages point to it", () => {
  const evidenceOwner = read("docs/process/AGENTS.md");
  assert.match(evidenceOwner, /^## Evidence$/mu);
  assert.match(evidenceOwner, /fails before the fix/u);
  for (const page of ["CONTRIBUTING.md", "docs/testing.md", "docs/floor/help.md"]) {
    const text = read(page);
    assert.ok(text.includes("AGENTS.md#evidence"), `${page} must point at the evidence owner`);
    assert.doesNotMatch(
      text,
      /must fail first|fail on the old behavior first|regression test that fails before the fix/iu,
      `${page} must not restate the fail-first rule`,
    );
  }
  assert.ok(read("docs/process/WORKFLOW.md").includes("AGENTS.md#evidence"), "the workflow must route the evidence bar");
});

test("the shipping page names no release workflow the tree does not hold", () => {
  const shipping = read("docs/shipping.md");
  assert.doesNotMatch(shipping, /`release\.yml`/u, "the tree has no .github/workflows/release.yml");
  assert.match(shipping, /Tagging `v\*` is a release marker, not a workflow trigger/u);
});
