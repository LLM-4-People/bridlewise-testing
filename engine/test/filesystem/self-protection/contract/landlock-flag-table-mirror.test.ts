import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  LANDLOCK_ACCESS_FS_FLAG_NAMES,
  LANDLOCK_FLAG_METADATA,
} from "../../../../src/filesystem/self-protection/self-protection-contracts.ts";

/**
 * D3 Test #9 — C↔TS flag table structural-equivalence (Layer 3, T6/T10).
 *
 * The C guardian binary's `LANDLOCK_FS_FLAGS[]` table in
 * `guardian/landlock-guardian.h` mirrors the TS
 * `LANDLOCK_ACCESS_FS_FLAG_NAMES` + `LANDLOCK_FLAG_METADATA` in
 * `src/filesystem/self-protection/self-protection-contracts.ts`. This is a
 * CROSS-LANGUAGE invariant — the TS-only DRY detector (Pass 1/2) never parses
 * `.h` files, so the mirror needs a SEPARATE structural-equivalence test.
 *
 * Asserts exact match on all 4 fields × 16 entries:
 * 1. `LANDLOCK_ACCESS_FS_FLAG_NAMES` length === 16 AND matches the C `name`
 * strings in the SAME order.
 * 2. For each flag `i`: `LANDLOCK_FLAG_METADATA[name].minAbi === C.min_abi`.
 * 3. For each flag `i`: `LANDLOCK_FLAG_METADATA[name].appliesTo === "any"` iff
 * `C.applies_to === LANDLOCK_FLAG_ANY` (1), `"dir-only"` iff
 * `C.applies_to === LANDLOCK_FLAG_DIR_ONLY` (0).
 * 4. For each flag `i`: the C `value` (`LANDLOCK_ACCESS_FS_<NAME>` constant)
 * matches `1 << i` (the bit position implied by the flag's index in the
 * canonical order). This cross-checks the C `#define` block against the
 * TS order.
 *
 * Mutant assertions: if the C table reorders two entries, the test fails; if
 * the TS metadata flips a `minAbi`, the test fails; if a flag is added to one
 * side but not the other, the test fails.
 */

const modulePath = fileURLToPath(import.meta.url);
const candidateRoot = dirname(dirname(dirname(dirname(dirname(modulePath)))));
const headerPath = join(candidateRoot, "guardian", "landlock-guardian.h");

interface CFlagEntry {
  name: string;
  value: bigint;
  minAbi: number;
  appliesTo: number; // 0 = LANDLOCK_FLAG_DIR_ONLY, 1 = LANDLOCK_FLAG_ANY
}

/** Parse the C `#define LANDLOCK_ACCESS_FS_<NAME> (1ULL << N)` block. */
function parseCDefines(header: string): Map<string, bigint> {
  const defines = new Map<string, bigint>();
  // The C header uses `# define` (indented inside #ifndef), so allow whitespace after #.
  const regex = /#\s*define\s+LANDLOCK_ACCESS_FS_(\w+)\s+\(1ULL\s*<<\s*(\d+)\s*\)/g;
  for (const match of header.matchAll(regex)) {
    const name = match[1]!;
    const bit = Number.parseInt(match[2]!, 10);
    defines.set(name, 1n << BigInt(bit));
  }
  return defines;
}

/** Parse the C `LANDLOCK_FS_FLAGS[]` table entries. */
function parseCFlagTable(header: string): CFlagEntry[] {
  const entries: CFlagEntry[] = [];
  // Match: { "NAME", LANDLOCK_ACCESS_FS_NAME, MIN_ABI, LANDLOCK_FLAG_ANY|DIR_ONLY }
  const regex = /\{\s*"(\w+)"\s*,\s*LANDLOCK_ACCESS_FS_\w+\s*,\s*(\d+)\s*,\s*(LANDLOCK_FLAG_ANY|LANDLOCK_FLAG_DIR_ONLY)\s*\}/g;
  for (const match of header.matchAll(regex)) {
    const name = match[1]!;
    const minAbi = Number.parseInt(match[2]!, 10);
    const appliesTo = match[3] === "LANDLOCK_FLAG_ANY" ? 1 : 0;
    entries.push({ name, value: 0n, minAbi, appliesTo });
  }
  return entries;
}

test("landlock-flag-table-mirror: C header has exactly 16 LANDLOCK_FS_FLAGS entries", () => {
  const header = readFileSync(headerPath, "utf8");
  const entries = parseCFlagTable(header);
  assert.equal(entries.length, 16, `LANDLOCK_FS_FLAGS must have 16 entries (got ${entries.length})`);
});

test("landlock-flag-table-mirror: TS LANDLOCK_ACCESS_FS_FLAG_NAMES matches C names in the SAME order (field 1: name + order)", () => {
  const header = readFileSync(headerPath, "utf8");
  const cEntries = parseCFlagTable(header);
  assert.equal(LANDLOCK_ACCESS_FS_FLAG_NAMES.length, 16, "TS must have 16 flag names");
  for (let i = 0; i < 16; i++) {
    assert.equal(
      LANDLOCK_ACCESS_FS_FLAG_NAMES[i],
      cEntries[i]!.name,
      `flag index ${i}: TS name "${LANDLOCK_ACCESS_FS_FLAG_NAMES[i]}" must match C name "${cEntries[i]!.name}"`,
    );
  }
});

test("landlock-flag-table-mirror: TS LANDLOCK_FLAG_METADATA.minAbi matches C min_abi (field 2: minAbi)", () => {
  const header = readFileSync(headerPath, "utf8");
  const cEntries = parseCFlagTable(header);
  for (let i = 0; i < 16; i++) {
    const name = LANDLOCK_ACCESS_FS_FLAG_NAMES[i]!;
    const cMinAbi = cEntries[i]!.minAbi;
    const tsMinAbi = LANDLOCK_FLAG_METADATA[name].minAbi;
    assert.equal(
      tsMinAbi,
      cMinAbi,
      `flag ${name}: TS minAbi ${tsMinAbi} must match C min_abi ${cMinAbi}`,
    );
  }
});

test("landlock-flag-table-mirror: TS LANDLOCK_FLAG_METADATA.appliesTo matches C applies_to (field 3: appliesTo)", () => {
  const header = readFileSync(headerPath, "utf8");
  const cEntries = parseCFlagTable(header);
  for (let i = 0; i < 16; i++) {
    const name = LANDLOCK_ACCESS_FS_FLAG_NAMES[i]!;
    const cAppliesTo = cEntries[i]!.appliesTo;
    const tsAppliesTo = LANDLOCK_FLAG_METADATA[name].appliesTo;
    const expected = cAppliesTo === 1 ? "any" : "dir-only";
    assert.equal(
      tsAppliesTo,
      expected,
      `flag ${name}: TS appliesTo "${tsAppliesTo}" must match C applies_to ${cAppliesTo} ("${expected}")`,
    );
  }
});

test("landlock-flag-table-mirror: C #define values match bit positions implied by TS canonical order (field 4: value/bit)", () => {
  const header = readFileSync(headerPath, "utf8");
  const defines = parseCDefines(header);
  assert.equal(defines.size, 16, `C #define block must have 16 LANDLOCK_ACCESS_FS_* constants (got ${defines.size})`);
  for (let i = 0; i < 16; i++) {
    const name = LANDLOCK_ACCESS_FS_FLAG_NAMES[i]!;
    const cValue = defines.get(name);
    assert.ok(cValue !== undefined, `C #define LANDLOCK_ACCESS_FS_${name} must exist`);
    const expectedValue = 1n << BigInt(i);
    assert.equal(
      cValue,
      expectedValue,
      `flag ${name} (index ${i}): C value ${cValue} must equal 1 << ${i} = ${expectedValue}`,
    );
  }
});
