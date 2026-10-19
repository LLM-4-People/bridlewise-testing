/**
 * NO HAND-MAINTAINED BYTE-PINS — every sha256/byte-pin in source is produced
 * by a registered auto-generator, or it reds here.
 *
 * ── THE DEFECT THIS GUARDS ───────────────────────────────────────────────
 *
 * A pin whose regeneration is not reachable from the regeneration choke point
 * (`harness regenerate` / `harness sync`) is a value someone must remember to
 * re-derive by hand. The restructure proved the failure twice over: a moved
 * tool left the planned-node-test source authority stale (re-derived by a
 * separate, easily-forgotten script), and the handoff semantic-owner pins went
 * stale with no automatic refresh at all. Both "passed" `harness sync` because
 * the choke point did not know they existed.
 *
 * ── WHAT "AUTO-GENERATED" MEANS ──────────────────────────────────────────
 *
 * A sha256 literal in `src/` or `scripts/` is covered when ANY registered
 * owner re-derives it from the tree with no hand-edit:
 *
 *   1. a `targetPath` of a `listAllBindings()` entry — the hash-binding
 *      registry rewrites it;
 *   2. a file the pin-authority regeneration driver re-derives
 *      (`pinAuthorities()` in `scripts/pin-authority-regeneration.ts`),
 *      including each authority's declared projection;
 *   3. a file whose header declares it generated (`@generated` / "do not
 *      edit") — its own generator owns the pin;
 *   4. the module registrar's own manifest (`src/architecture-manifest.ts`) —
 *      its per-module `namesSha256`/`sourceSha256` are re-derived by
 *      `harness register`, part of every sync.
 *
 * A 64-hex literal that is NOT a byte-pin of a tracked file — a crypto seed, a
 * vendored upstream reference, a prose citation of a hash — is not a pin and
 * does not belong to an auto-generator. Those are excluded by SHAPE (the
 * literal is a `*.generated.ts` header value, a `*SEED*` constant, a schema
 * `z.literal` for an external artifact, or a prose mention), never by naming
 * the file. A pin that IS a byte-lock of a tracked source file and is in none
 * of the covered sets is a hand-maintained pin: it reds by name.
 *
 * DYNAMIC DISCOVERY. The covered set is read from the owners (the registry,
 * the pin-authority list, the generated-file headers found by scanning), so a
 * binding or authority added tomorrow is covered the day it registers — there
 * is no list of files here to keep in step.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { createTempDir } from "../support/temp-dir.ts";
import { listAllBindings } from "../../src/workflow/hash-binding-registry.ts";
import { authoritiesOwedByTree, pinAuthorities } from "../../scripts/pin-authority-regeneration.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const HEX64 = /[0-9a-f]{64}/u;

/** Every tracked source file under the pin-bearing roots. */
function sourceFiles(): readonly string[] {
  return execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 })
    .split("\n")
    .filter((f) => /^(?:src|scripts)\//u.test(f) && /\.(?:ts|mts|js|mjs)$/u.test(f));
}

/**
 * The set of files whose sha256 literals are auto-generated, derived from the
 * owners. Reading the owners (never a hand list) is the deny-by-default
 * property: a pin in a file NO owner claims is flagged.
 */
function coveredFiles(): ReadonlySet<string> {
  const covered = new Set<string>();
  // 1. Hash-binding registry targets (the registry rewrites each).
  for (const binding of listAllBindings()) {
    covered.add(binding.targetPath.replace(/\\/gu, "/"));
  }
  // 2. Pin-authority targets + their declared projections.
  for (const authority of pinAuthorities()) {
    covered.add(authority.targetPath.replace(/\\/gu, "/"));
    if (authority.projection !== undefined) {
      covered.add(authority.projection.targetPath.replace(/\\/gu, "/"));
    }
  }
  // 4. The module registrar's own manifest.
  covered.add("src/architecture-manifest.ts");
  return covered;
}

/**
 * Whether a 64-hex literal is a genuine BYTE-PIN of a tracked tree file —
 * the literal measures a sibling `path:` that names a live source file. This
 * is the deny-by-default classifier: a crypto seed, a vendored upstream
 * reference, a historical/incident record, or a schema literal for an external
 * artifact has no sibling `path` naming a live tree file, so it is NOT a pin
 * and never reaches the auto-generator question. Only a literal that measures
 * a tracked file AND lives in a file no owner claims is a hand-maintained pin.
 */
function bytePinOccurrences(relativePath: string, text: string): readonly string[] {
  const lines = text.split("\n");
  const findings: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!HEX64.test(line)) continue;
    // The literal must be a pin-shaped field (`sha256:`/`...Sha256:`/`fileSha256:`),
    // not a bare seed/array element. A bare string is data, not a measurement.
    if (!/(?:^|[\s{,])(?:[A-Za-z]*[Ss]ha256|fileSha256|sourceSha256)\s*:/u.test(line)) continue;
    // The pin measures a sibling `path:` in the SAME small window that names a
    // live tracked file. Without one, the literal measures nothing local.
    const windowStart = Math.max(0, index - 6);
    const window = lines.slice(windowStart, index + 1).join("\n");
    const pathMatch = /path:\s*"([^"]+)"/u.exec(window);
    if (pathMatch === null) continue;
    const measured = pathMatch[1]!;
    const measuredAbsolute = join(ROOT, measured);
    if (!(existsSync(measuredAbsolute) && statSync(measuredAbsolute).isFile())) continue;
    findings.push(`${relativePath}:${index + 1}: ${line.trim().slice(0, 100)}`);
  }
  return findings;
}

test("every sha256/byte-pin literal in source is produced by a registered auto-generator", () => {
  const covered = coveredFiles();
  // Liveness: the covered set must be non-empty, or the guard certifies
  // nothing. The registry alone contributes 18 targets, so an empty set means
  // the owner's derivation broke.
  assert.ok(covered.size > 0, "the auto-generated covered set came back empty — a guard over nothing certifies nothing");

  const handMaintained: string[] = [];
  for (const file of sourceFiles()) {
    if (covered.has(file)) continue;
    const text = readFileSync(join(ROOT, file), "utf8");
    if (!HEX64.test(text)) continue;
    handMaintained.push(...bytePinOccurrences(file, text));
  }
  assert.deepEqual(
    handMaintained,
    [],
    "sha256/byte-pin literal(s) measuring a tracked file with NO registered auto-generator (a " +
      "hand-maintained pin someone must remember to re-derive). Register the pin with the " +
      "hash-binding registry or the pin-authority regeneration driver so `harness sync` re-derives it:\n" +
      handMaintained.map((p) => `  - ${p}`).join("\n"),
  );
});

test("a testing-only pin authority with no subject on the tree is converged by absence, never measured", () => {
  // The regeneration choke point must run on a product-only tree too: a
  // `testingOnly` authority (its subject lives under the declared test
  // surface, absent from a product tree) is DROPPED there — converged by
  // absence — while every product authority stays owed no matter what. The
  // regression this locks out: the presence filter was born a no-op
  // (`!authority.testingOnly || true`), so on a product-only tree the driver
  // read the absent subject, reported status "error", and the mandatory
  // `harness regenerate` step failed — the product-tree convergence was
  // unreachable through the choke point.
  const productOnlyRoot = createTempDir("pin-authority-product-tree-");
  {
    const owed = authoritiesOwedByTree(productOnlyRoot);
    const owedIds = owed.map((authority) => authority.id);
    for (const authority of pinAuthorities()) {
      if (!authority.testingOnly) {
        assert.ok(
          owedIds.includes(authority.id),
          `a product authority (${authority.id}) must stay owed on a tree that lacks its subject — ` +
            `a missing product authority file is a defect the run reports, never a silent skip`,
        );
      } else {
        assert.ok(
          !owedIds.includes(authority.id),
          `a testing-only authority (${authority.id}) must be converged by absence on a tree that ` +
            `does not carry its subject — measuring an absent file fails the product-tree convergence`,
        );
      }
    }
    // Liveness: the fixture must actually be a tree WITHOUT the testing
    // subject, and the registered set must carry both halves — otherwise the
    // assertions above pass over a population that exercises nothing.
    assert.ok(
      !existsSync(join(productOnlyRoot, "test/support")),
      "the product-only fixture unexpectedly carries the test surface",
    );
    assert.ok(
      pinAuthorities().some((authority) => authority.testingOnly),
      "no testing-only authority is registered — the converged-by-absence arm has no subject",
    );
  }

  // The full tree (this checkout) carries the testing subject, so the SAME
  // authority is owed here — the absence skip is tree-derived, not a
  // permanent drop of the pin.
  const owedHere = authoritiesOwedByTree(ROOT).map((authority) => authority.id);
  for (const authority of pinAuthorities()) {
    assert.ok(owedHere.includes(authority.id), `authority ${authority.id} must be owed on the full tree`);
  }
});
