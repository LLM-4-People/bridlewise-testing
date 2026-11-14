// Browser regression for the actual visual runner. Install its pinned Chromium
// before invoking it; public smoke keeps its browser-free contract.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { sha256 } from "../../engine/src/kernel/integrity.ts";
import { gate, shots, shotName } from "./plan.ts";
import { run } from "./screens.ts";

const PAGES = ["/", "/same/", "/changed/"];

// No fonts, resources, timers or animation enter these pictures. The script
// changes the solid background on each navigation, so the runner's two
// same-head captures differ without a wall-clock race or a patched adapter.
const page = (colour, script = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Visual runner fixture</title><style>html{background:${colour}}body{margin:0}</style>${script}</head><body></body></html>`;
const UNSTABLE = `<script>const next=Number(sessionStorage.getItem("navigation")??"0")+1;sessionStorage.setItem("navigation",String(next));document.documentElement.style.background=["#112233","#445566","#778899"][next%3];</script>`;

function fixture(root, name, index, same, changed) {
  const dir = join(root, name);
  mkdirSync(join(dir, "same"), { recursive: true });
  mkdirSync(join(dir, "changed"));
  writeFileSync(join(dir, "index.html"), index);
  writeFileSync(join(dir, "same", "index.html"), same);
  writeFileSync(join(dir, "changed", "index.html"), changed);
  return dir;
}

test("the real runner retains both unstable head captures, their bound diff and report links, while preserving every verdict", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bridlewise-visual-runner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = fixture(root, "base", page("#112233"), page("#112233"), page("#112233"));
  const head = fixture(root, "head", page("#112233", UNSTABLE), page("#112233"), page("#ddeeff"));
  const out = join(root, "report");
  const result = await run({ base, head, out, baseurl: "/visual-proof", pages: PAGES, changeDeclared: true });
  const saved = JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
  const html = readFileSync(join(out, "report.html"), "utf8");
  assert.deepEqual(saved.comparisons, result.comparisons);
  assert.equal(result.pass, false, "a declaration cannot accept an unstable page");
  assert.equal(saved.pass, false);
  assert.deepEqual(result.comparisons.map((c) => c.name), shots(PAGES).map(shotName));

  const unstable = result.comparisons.filter((c) => c.name.startsWith("home--"));
  const stable = result.comparisons.filter((c) => c.name.startsWith("same--"));
  const intentional = result.comparisons.filter((c) => c.name.startsWith("changed--"));
  assert.ok(unstable.length > 0 && stable.length > 0 && intentional.length > 0);
  assert.ok(unstable.every((c) => c.verdict === "unstable"));
  assert.ok(stable.every((c) => c.verdict === "same"));
  assert.ok(intentional.every((c) => c.verdict === "changed"));
  assert.deepEqual(gate(stable, { changeDeclared: false }), { pass: true, reasons: [] });
  assert.equal(gate(intentional, { changeDeclared: false }).pass, false);
  assert.equal(gate(intentional, { changeDeclared: true }).pass, true);
  assert.equal(gate(unstable, { changeDeclared: true }).pass, false);

  for (const comparison of unstable) {
    assert.deepEqual(Object.keys(comparison.stability).sort(), ["diff", "first", "second"]);
    const { first, second, diff } = comparison.stability;
    assert.equal(new Set([first.path, second.path, diff.path]).size, 3);
    for (const image of [first, second, diff]) {
      const bytes = readFileSync(join(out, image.path));
      assert.equal(image.bytes, bytes.byteLength);
      assert.equal(image.sha256, sha256(bytes), image.path);
      assert.ok(html.includes(`src="${image.path}"`), `${image.path} is shown by the report`);
      assert.ok(html.includes(image.sha256), `${image.path} is visibly bound to its bytes`);
    }
    const firstBytes = readFileSync(join(out, first.path));
    const secondBytes = readFileSync(join(out, second.path));
    assert.equal(firstBytes.equals(secondBytes), false);
    assert.notEqual(first.sha256, second.sha256);
    // The fixture changes every pixel; the production difference() owns the
    // count. PNG IHDR supplies the actual image dimensions independently.
    const width = firstBytes.readUInt32BE(16);
    const height = firstBytes.readUInt32BE(20);
    assert.equal(comparison.totalPixels, width * height);
    assert.equal(comparison.changedPixels, comparison.totalPixels);
    assert.ok(comparison.totalPixels > 0);
    assert.equal(secondBytes.readUInt32BE(16), width);
    assert.equal(secondBytes.readUInt32BE(20), height);
    const diffBytes = readFileSync(join(out, diff.path));
    assert.equal(diffBytes.readUInt32BE(16), width);
    assert.equal(diffBytes.readUInt32BE(20), height);
  }
});
