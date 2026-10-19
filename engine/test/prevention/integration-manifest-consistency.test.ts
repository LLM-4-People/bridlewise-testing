/**
 * SPO R50 — Architecture-manifest hash-consistency mechanical test.
 *
 * R50 discovered that prior rounds (R42–R49) added exports to config-owner
 * modules (intelligence-config, runtime-config, awareness/config, shared/
 * similarity, etc.) WITHOUT updating the corresponding `exportCount` /
 * `namesSha256` in `src/architecture-manifest.ts`. The R48 prevention test
 * only checks for UNREGISTERED files (drift = a src file with no manifest
 * entry); it did NOT check that the registered entry's hash still matches
 * the source. So 18 manifest entries silently drifted (e.g.
 * intelligence-config: manifest said 9 exports, source had 31).
 *
 * This test closes that gap: for every registered src.ts module, it
 * recomputes the export names + count + canonical hash via the SAME
 * `analyzeArchitectureSource` + `canonicalHash` the architecture verification
 * uses, and asserts the manifest's `exportCount`/`namesSha256` match. A
 * future round that adds an export without updating the manifest is
 * auto-caught (deny-by-default — the manifest can no longer silently rot).
 *
 * Dynamic discovery: the registered set is parsed from the
 * manifest itself — NO hardcoded file list.
 */

import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { analyzeArchitectureSource } from "../../scripts/verification/architecture.ts";
import { canonicalHash } from "../../src/kernel/integrity.ts";

const ROOT = process.cwd();
const MANIFEST_PATH = join(ROOT, "src/architecture-manifest.ts");
const manifest = readFileSync(MANIFEST_PATH, "utf8");

// Parse every registered src/*.ts moduleContract entry: path + exportCount + namesSha256.
// The `path:` token only appears in moduleContract entries (dependency lists use bare
// "src/..." strings inside arrays), so this matches only the real registrations.
interface Entry { path: string; count: number; hash: string; }
const entries: Entry[] = [];
for (const m of manifest.matchAll(/path:\s*"(src\/[^"]+\.ts)".*?exportCount:\s*(\d+),\s*namesSha256:\s*"([0-9a-f]+)"/gs)) {
  entries.push({ path: m[1]!, count: parseInt(m[2]!, 10), hash: m[3]! });
}

test("R50-manifest: every registered src/*.ts module's exportCount + namesSha256 matches its source (no silent drift)", () => {
  assert.ok(entries.length > 100, `manifest must register many src modules (found ${entries.length})`);
  const drift: string[] = [];
  let checked = 0;
  for (const e of entries) {
    const full = join(ROOT, e.path);
    if (!existsSync(full)) continue; // skip non-existent (e.g. generated/external paths)
    const facts = analyzeArchitectureSource(e.path, readFileSync(full, "utf8"));
    const computed = canonicalHash(facts.exportedNames);
    checked++;
    if (facts.exportedNames.length !== e.count || computed !== e.hash) {
      drift.push(`${e.path}: manifest count=${e.count} hash=${e.hash.slice(0, 8)} vs source count=${facts.exportedNames.length} hash=${computed.slice(0, 8)}`);
    }
  }
  assert.ok(checked > 100, `must have checked >100 registered source files (checked ${checked})`);
  assert.equal(drift.length, 0,
    `architecture-manifest exportCount/namesSha256 drift — update the manifest entries after changing exports: ${drift.join(" | ")}`);
});
