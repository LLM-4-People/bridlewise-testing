import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { walk } from "../../scripts/verification/source-walk.ts";

/**
 * Ratchet test: NO hardcoded truncation slices in the integration production
 * source (`src/`). A `.slice(0, <number>)` or `.slice(-<number>)` literal in
 * production code is a configurable that should live in the relevant config
 * owner (`*-config.ts`) and be consumed via a named constant, not inlined at
 * the call site. Scattering these literals caused drift (the same limit
 * taking different values across call sites) and made tuning require
 * editing every site.
 *
 * The integration `src/` has ~106 existing truncation slices (UUID prefixes,
 * SHA hashes, display previews, top-N limits). Cleaning them all is a
 * dedicated round's work. This test is a RATCHET: it records the current
 * baseline count and FAILS if the count INCREASES (a new hardcoded truncation
 * slice is added). This prevents regression — no new slices can slip in —
 * while allowing incremental cleanup in future rounds (the baseline only
 * decreases; each cleanup lowers the count and a future round lowers the
 * baseline).
 *
 * Dynamic discovery — scans every `.ts` and `.mjs` file under `src/` via
 * readdirSync (no hardcoded file list). Comments are stripped first so a
 * doc reference to `.slice(0, N)` is not flagged. Test files (`.test.ts`/
 * `.test.mjs`) are excluded. The `.mjs` coverage closes the `.mjs` blind
 * spot (`.mjs` source files in `src/` were silently missed when the scan was
 * `.ts`-only).
 */
const ROOT = process.cwd();
const SRC_DIR = join(ROOT, "src");

/** The ratchet ceiling: the current count of truncation-slice literals in
 * the integration src (`.ts` + `.mjs`). Must only DECREASE. Update after a
 * cleanup round lowers the count. A new slice (count > baseline) fails the
 * test. The baseline was lowered when the dead `.mjs` smart-edit package was
 * deleted (its slices left with it) — re-derive by counting, never by hand. */
const BASELINE_TRUNCATION_SLICE_COUNT = 111;

/** `.slice(0, <literal>=1` or `.slice(0, <literal>=10` — a numeric
 * truncation cap. Matches literals >= 1 (a cap of 0 is degenerate). */
const SLICE_POS_RE = /\.slice\(\s*0\s*,\s*([1-9]\d*|\d{2,})\b/g;
/** `.slice(-<literal>)` — a fixed-width tail preview (e.g. a short hash). */
const SLICE_NEG_RE = /\.slice\(\s*-\s*([1-9]\d*|\d{2,})\b/g;

/** Strip line + block comments (preserves newlines for line-number
 * alignment). Strings are NOT stripped — a `.slice(0, N)` inside a string
 * is rare in this codebase and the false-positive rate is near zero. */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Recursively collect every non-test `.ts` and `.mjs` file under `dir`. */
function listTs(dir: string, acc: string[] = []): string[] {
  for (const file of walk(dir, { exts: [".ts", ".mjs"] })) {
    if (!file.endsWith(".test.ts") && !file.endsWith(".test.mjs")) acc.push(file);
  }
  return acc;
}

test("the integration source is present (scan is not vacuous)", () => {
  const files = listTs(SRC_DIR);
  assert.ok(files.length > 100, `integration src has .ts/.mjs files (found ${files.length})`);
});

test("no NEW hardcoded truncation slices in integration src (count <= baseline)", () => {
  const files = listTs(SRC_DIR);
  let count = 0;
  const findings: string[] = [];
  for (const file of files) {
    const stripped = stripComments(readFileSync(file, "utf8"));
    for (const re of [SLICE_POS_RE, SLICE_NEG_RE]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(stripped)) !== null) {
        count += 1;
        if (findings.length < 20) {
          findings.push(`${relative(ROOT, file)}: ${m[0]}`);
        }
      }
    }
  }
  assert.ok(
    count <= BASELINE_TRUNCATION_SLICE_COUNT,
    `integration src truncation-slice count ${count} EXCEEDS the baseline ` +
      `${BASELINE_TRUNCATION_SLICE_COUNT} — new hardcoded truncation slices were added. ` +
      `The count must only decrease. Move each new slice into a named constant ` +
      `in the relevant *-config.ts owner. First findings:\n${findings.join("\n")}`,
  );
});
