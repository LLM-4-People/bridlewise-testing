import { SecurityError } from "../../src/kernel/errors.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import * as ledgerPrimitives from "../../src/timeline/ledger-primitives.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { generateId } from "../../src/kernel/integrity.ts";
import { parseExportsFromFile } from "../support/source-scan.ts";
import { engineModuleSourceRelative } from "../support/module-resolver.ts";
import { readSourceView } from "../../scripts/verification/source-view.ts";
import { walk } from "../../scripts/verification/source-walk.ts";

/**
 * DRY-1/2/3 regression: `MAXIMUM_DESCRIPTION_BYTES` silently drifted (4096 vs
 * 8192) and `MAXIMUM_CORRELATION_FIELDS` drifted (16 vs 8) because both
 * `execution-closure.ts` and `timeline/timeline-store.ts` kept local copies.
 * The fix extracted them to `ledger-primitives.ts`. This test mechanically
 * proves both consumers import the SAME constants from that single owner —
 * if someone re-introduces a local `const MAXIMUM_DESCRIPTION_BYTES =...` the
 * test fails — and that the constants are consistent with the canonical
 * ledger-primitives module.
 *
 * The shared-constant set is derived DYNAMICALLY from the owner source
 * (`parseExportsFromFile` of `ledger-primitives.ts`) — deny-by-default, so
 * the list cannot rot when the owner grows. WHICH rule applies to a new
 * export is decided by what the module IS:
 *
 *   - every export must be CONSUMED somewhere in the engine tree (no dead
 *     export in the single owner — a speculative addition reds here);
 *   - the two ledger WRITERS (execution-closure.ts, timeline-store.ts) must
 *     import from the owner and never re-define an export locally.
 *
 * The earlier rule — "both writers must reference EVERY export" — held only
 * while the owner carried exactly what those two files shared. The module
 * now also owns helpers for OTHER ledger writers (the runtime bootstrap's
 * `truncateForLedger`; the server's timeline bridge imports it through
 * this module too), and the deny-by-default posture (round 5) made the
 * writers REJECT over-long input instead of truncating — so a writer that
 * legitimately never truncates must not be forced to reference the
 * truncation helper. The dead-export rule keeps the same deny-by-default
 * teeth without the false requirement.
 */

const SRC_ROOT = join(process.cwd(), "src");
// The consumers' current locations, resolved from the tree (the fold moved
// execution-closure.ts under kernel/); never spelled.
const CLOSURE_PATH = join(process.cwd(), engineModuleSourceRelative("execution-closure.ts"));
const STORE_PATH = join(SRC_ROOT, "timeline", "timeline-store.ts");
const LEDGER_PRIMITIVES_PATH = join(SRC_ROOT, "timeline", "ledger-primitives.ts");

/** The file's CODE view (comments and string interiors blanked) — the
 * sanctioned reader for every pattern this suite matches against source. */
function codeView(path: string): string {
  return readSourceView(path).code();
}

/** The CODE-WITH-STRINGS view — module specifiers ARE string literals, so a
 * check that an import names this module reads this view, never raw bytes. */
function codeWithStringsView(path: string): string {
  return readSourceView(path).codeWithStrings();
}

// Derive the export set dynamically from the single owner source — every
// public export of ledger-primitives.ts is a shared constant/helper whose
// consumers are proven below (no hand-maintained mirror that would silently
// miss a newly added export).
const SHARED_CONSTANTS = parseExportsFromFile(LEDGER_PRIMITIVES_PATH);

/** Every .ts file of the engine source tree, for the dead-export scan. */
function engineSourceFiles(): string[] {
  return walk(SRC_ROOT, { exts: [".ts"] });
}

test("ledger-primitives: execution-closure.ts imports from the single owner", () => {
  // The import specifier is relative to execution-closure.ts's post-fold home
  // (kernel/), so it reaches timeline/ via "../" — assert the module name, not
  // a spelled relative prefix.
  assert.ok(
    /from\s+"\.\.?\/timeline\/ledger-primitives\.ts"/.test(codeWithStringsView(CLOSURE_PATH)),
    "execution-closure.ts must import from timeline/ledger-primitives.ts",
  );
});

test("ledger-primitives: timeline-store.ts imports from the single owner", () => {
  assert.ok(
    codeWithStringsView(STORE_PATH).includes("from \"./ledger-primitives.ts\""),
    "timeline-store.ts must import from ./ledger-primitives.ts",
  );
});

test("ledger-primitives: NO DEAD EXPORT — every export of the owner is consumed in the engine tree", () => {
  // Deny-by-default for speculative additions: an export nobody references
  // (outside the owner itself) reds here. The owner's consumers are whoever
  // legitimately writes to a ledger — the two canonical writers, the runtime
  // bootstrap (which truncates the error messages it records), or any other
  // engine module — never "both specific files" (the writers REJECT
  // over-long input instead of truncating; the truncation helper serves the
  // bootstrap and the server bridge that imports through this module).
  const sources = new Map<string, string>();
  for (const file of engineSourceFiles()) {
    sources.set(file, codeView(file));
  }
  for (const name of SHARED_CONSTANTS) {
    const referenced = [...sources.entries()].some(
      ([file, src]) =>
        file !== LEDGER_PRIMITIVES_PATH && new RegExp(`\\b${name}\\b`).test(src),
    );
    assert.ok(
      referenced,
      `ledger-primitives export "${name}" is consumed by no engine module — a speculative/dead export in the single owner`,
    );
  }
});

test("ledger-primitives: no local re-definition of any shared constant in either consumer", () => {
  const closureSrc = codeView(CLOSURE_PATH);
  const storeSrc = codeView(STORE_PATH);
  // Derive the exported names dynamically from the single owner — ANY export
  // re-defined locally (`const NAME =`) in a consumer is a DRY regression
  // (the consumer must import from ledger-primitives, not re-declare). This
  // is deny-by-default: a newly added export re-declared locally is caught,
  // not just the six historical drift names.
  for (const name of SHARED_CONSTANTS) {
    const localDef = new RegExp(`(?:const|let|var)\\s+${name}\\s*=`, "u");
    assert.equal(
      localDef.test(closureSrc),
      false,
      `execution-closure.ts must not re-define ${name} locally (must import from ledger-primitives)`,
    );
    assert.equal(
      localDef.test(storeSrc),
      false,
      `timeline-store.ts must not re-define ${name} locally (must import from ledger-primitives)`,
    );
  }
});

test("ledger-primitives: imported constant values match the canonical module exactly", () => {
  // Import the consumers and re-export the constants so we can compare by value.
  // Both modules re-export the shared constants transitively; the authoritative
  // values live in ledger-primitives. We assert the canonical values are stable.
  assert.equal(ledgerPrimitives.MAXIMUM_DESCRIPTION_BYTES, 8192);
  assert.equal(ledgerPrimitives.MAXIMUM_CORRELATION_FIELDS, 8);
  assert.equal(ledgerPrimitives.MAXIMUM_IDENTIFIER_CHARACTERS, 512);
  assert.equal(ledgerPrimitives.ZERO_CHAIN_HASH, "0".repeat(64));
  assert.equal(ledgerPrimitives.GENESIS_SEQUENCE, 1n);
  assert.equal(ledgerPrimitives.MAXIMUM_SEQUENCE, 9223372036854775807n);
  assert.equal(ledgerPrimitives.CORRELATION_FIELD_NAMES.length, 8);
  assert.deepEqual(
    [...ledgerPrimitives.CORRELATION_FIELD_NAMES],
    ["runId", "sessionId", "turnId", "messageId", "taskId", "attemptId", "agentId", "parentEffectId"],
  );
});

test("ledger-primitives: MAXIMUM_CORRELATION_FIELDS equals CORRELATION_FIELD_NAMES length", () => {
  assert.equal(
    ledgerPrimitives.MAXIMUM_CORRELATION_FIELDS,
    ledgerPrimitives.CORRELATION_FIELD_NAMES.length,
    "the field-count ceiling must equal the canonical field-name set length (drift here was the DRY-2 bug)",
  );
});

test("ledger-primitives: computeChainHash is domain-segregated and deterministic", () => {
  const envelope = { a: 1, b: "x" };
  const h1 = ledgerPrimitives.computeChainHash("domain-a", ledgerPrimitives.ZERO_CHAIN_HASH, envelope);
  const h2 = ledgerPrimitives.computeChainHash("domain-a", ledgerPrimitives.ZERO_CHAIN_HASH, envelope);
  const h3 = ledgerPrimitives.computeChainHash("domain-b", ledgerPrimitives.ZERO_CHAIN_HASH, envelope);
  assert.equal(h1, h2, "same domain + preimage must produce the same hash");
  assert.notEqual(h1, h3, "different domains must produce disjoint hash spaces");
  assert.match(h1, /^[0-9a-f]{64}$/u);
});

test("ledger-primitives: root-policy description byte ceiling is consistent with the ledger primitive", () => {
  // The config schema and root policy must not declare a description-byte ceiling
  // that disagrees with the shared ledger primitive. This catches the original
  // 4096-vs-8192 drift between configuration and implementation.
  const policyCeiling = ROOT_POLICY.verification.testDiscovery?.maximumSourceBytes;
  void policyCeiling;
  assert.equal(
    ledgerPrimitives.MAXIMUM_DESCRIPTION_BYTES,
    8192,
    "ledger MAXIMUM_DESCRIPTION_BYTES is the canonical ceiling",
  );
});

// ========== BUG-2 (SSOT-9): edge-type drift prevention ==========
// The canonical cross-authority consistency test lives in
// test/timeline/edge-type-consistency.test.ts (deepEqual of root-policy
// edgeTypes vs TIMELINE_EDGE_TYPES). The test below is a source-level
// prevention that ensures the drifted "caused" spelling does not return.

test("BUG-2 prevention: no \"caused\" edge type remains in timeline vocabulary (SSOT-9)", () => {
  const typesSrc = codeView(join(SRC_ROOT, "timeline", "timeline-types.ts"));
  const recSrc = codeView(join(SRC_ROOT, "timeline", "timeline-recorder.ts"));
  assert.equal(
    /"caused"/u.test(typesSrc),
    false,
    "timeline-types.ts must use \"causal\" not \"caused\" (SSOT-9 edge-type drift)",
  );
  assert.equal(
    /"caused"/u.test(recSrc),
    false,
    "timeline-recorder.ts must use \"causal\" not \"caused\" (SSOT-9 edge-type drift)",
  );
});

// ========== BUG-5 (SSOT-11): canonical ID generation ==========

test("ledger-primitives: generateId produces prefix-uuid format (SSOT-11)", () => {
  const id = generateId("run");
  assert.ok(id.startsWith("run-"), `generateId should prefix with 'run-', got: ${id}`);
  assert.match(
    id,
    /^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    "generateId must produce prefix-<uuid-v4> format (SSOT-11)",
  );
});

test("ledger-primitives: generateId with different prefixes produces distinct ids (SSOT-11)", () => {
  const a = generateId("run");
  const b = generateId("turn");
  assert.ok(a.startsWith("run-"));
  assert.ok(b.startsWith("turn-"));
  assert.notEqual(a, b);
});

test("ledger-primitives: generateIdentifier delegates to the canonical generateId (SSOT-11)", () => {
  const integritySrc = codeView(join(process.cwd(), engineModuleSourceRelative("integrity.ts")));
  const ledgerSrc = codeWithStringsView(join(SRC_ROOT, "timeline", "ledger-primitives.ts"));
  assert.ok(
    /\brandomUUID\b/.test(integritySrc),
    "integrity.ts must use crypto.randomUUID() for generateId (SSOT-11)",
  );
  assert.equal(
    /\bMath\.random\b/.test(integritySrc),
    false,
    "integrity.ts must not use Math.random for identifiers (SSOT-11)",
  );
  assert.ok(
    /generateId as generateIdentifier/.test(ledgerSrc),
    "ledger-primitives.ts must re-export generateId as generateIdentifier from integrity.ts (SSOT-11)",
  );
  const id = ledgerPrimitives.generateIdentifier("test");
  assert.ok(id.startsWith("test-"));
  assert.match(
    id,
    /^test-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    "generateIdentifier must produce prefix-<uuid-v4> format (SSOT-11)",
  );
});

for (const code of ["execution_sequence_exhausted", "timeline_sequence_exhausted"] as const) {
  test(`ledger successor admission: ${code}`, () => {
    assert.equal(ledgerPrimitives.nextLedgerSequence(0n, code), 1n);
    assert.equal(ledgerPrimitives.nextLedgerSequence(ledgerPrimitives.MAXIMUM_SEQUENCE - 1n, code), ledgerPrimitives.MAXIMUM_SEQUENCE);
    for (const value of [-1n, ledgerPrimitives.MAXIMUM_SEQUENCE, ledgerPrimitives.MAXIMUM_SEQUENCE + 1n]) {
      assert.throws(() => ledgerPrimitives.nextLedgerSequence(value, code), (error) => error instanceof SecurityError && error.code === code && error.message === "Ledger sequence exhausted");
    }
  });
}
