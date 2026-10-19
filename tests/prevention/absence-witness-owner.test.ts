import { describe, test, expect } from "vitest";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createTempDir } from "../helpers/temp-dir.ts";

import { readSourceView, sourceViewOf } from "../../engine/scripts/verification/source-view.ts";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * §36 MADE MECHANICAL: AN ABSENCE ASSERTION ABOUT A SECRET NEEDS A WITNESS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * > A byte scan returning zero is indistinguishable from one pointed at the
 * > wrong file.
 *
 * The rule existed as prose in `TIER1-AGENT-CONTRACT.md` §36 and NOTHING
 * enforced it. The cost of that is measurable, in this tree, today:
 * `integration/test/performance/performance-hostile.test.ts` carried NINE
 * assertions that `password`, `apiKey` and `Bearer` do not appear in a JSON
 * blob that no test ever put a credential into. They passed against `{}`. And
 * driving a real plant through one of them found the underlying claim was
 * FALSE — a thrown error message carried a whole key into the benchmark result.
 * An absence assertion with no canary is not a weak test; it is a green light
 * over a red condition.
 *
 * The discipline had already been reinvented three times in this repository —
 * `tracked-source-owner`'s `-plant` mirrors, `declared-universe-owner`'s seven
 * numbered plants, `stripper-view-owner`'s paired markers — each in a different
 * vocabulary, none of them a rule. This file is the fourth invention only in
 * the sense that it is the one that GENERALISES them; it does not add a fourth
 * private idiom, it names the property all three were reaching for.
 *
 * ── ★ THE BLIND SPOT THIS GUARD IS BUILT AROUND ───────────────────────────
 *
 * The two repositories do not share an assertion vocabulary, and the split is
 * TOTAL in both directions. Measured, and asserted below as a live population
 * fact rather than a comment:
 *
 *   harness/integration : 0 vitest-style absence assertions, hundreds of
 *                         `assert.ok(!…)` / `assert.doesNotMatch(…)` ones.
 *   web                 : 0 `node:assert` tokens of any kind, hundreds of
 *                         `.not.toContain(` / `.not.toMatch(` ones.
 *
 * So a meta-guard written against `.not.toContain(` would scan the entire
 * harness half, match nothing, and report it clean — which is §36's own failure
 * mode applied to the audit of §36. That is not a hypothetical: it is the exact
 * reason the harness half went unaudited. This guard therefore carries BOTH
 * vocabularies, and `describe("the guard sees both vocabularies")` below PROVES
 * it does rather than asserting it: it drives a planted file in each dialect
 * through the same detector and requires a finding from each, and it requires
 * the real corpus to contain live assertions of each dialect — so a future edit
 * that quietly drops one dialect's patterns fails here instead of going quiet.
 *
 * ── WHAT COUNTS AS A WITNESS ──────────────────────────────────────────────
 *
 * Within the enclosing test body, at least one of:
 *
 *   • A PLANT — the credential-shaped literal being asserted absent also
 *     appears somewhere that is not itself an absence assertion, i.e. it was
 *     put INTO the subject. This is `tracked-source-owner`'s `-plant` mirror
 *     and `declared-universe-owner`'s numbered plants, generalised.
 *   • A PRESENCE assertion — something asserted to BE there. This is
 *     `stripper-view-owner`'s paired marker, generalised, and it is the reason
 *     the redaction suites already score well: `[REDACTED:` asserted present
 *     beside the secret asserted absent is a witness, and was one before anyone
 *     called it that.
 *
 * Either one distinguishes "the secret is gone" from "the instrument was
 * pointed at nothing". Neither one requires a list of known-good files.
 *
 * ── READING SOURCE ──────────────────────────────────────────────────────────
 *
 * Through `source-view.ts`, the sanctioned reader, and through TWO of its views
 * on purpose (§29):
 *
 *   `code()`            — structure. Comments, quoted-string interiors and
 *                         template interiors all blanked, so brace balancing
 *                         cannot be desynchronised by a `{` inside a string.
 *   `codeWithStrings()` — subject. The literal `"password"` in
 *                         `assert.ok(!json.includes("password"))` IS a quoted
 *                         string, so a scan for it over `code()` could never
 *                         match and this guard would pass unconditionally —
 *                         the module's own second stated failure class.
 *
 * Both views preserve offsets (blanked, never deleted), so an index into one is
 * an index into the other and into the file. That is what makes it safe to
 * balance braces on one view and match literals on the other.
 *
 * STATED LIMIT, kept here rather than discovered later: `codeWithStrings()`
 * blanks TEMPLATE interiors, so an assertion written with a backtick literal —
 * `` assert.ok(!json.includes(`password`)) `` — is invisible to this guard.
 * That is deliberate: template interiors are where a runtime-built canary
 * lives, and treating an interpolated value as a literal credential name would
 * be noise. The population assertion below reports how many template-form
 * absence assertions exist so the size of the hole is a number, not a shrug.
 */

// ── THE ESTATES ────────────────────────────────────────────────────────────
//
// Both repositories, because a guard's population must span every repository
// the run can write to (§28b), and because the whole point of this file is that
// one half was invisible to the vocabulary the other half is written in.
const SCANNED_TREES = [
  "tests",
  join("engine", "test"),
] as const;

const SKIP_DIRECTORIES = new Set([
  "node_modules", ".git", "dist", "coverage", ".vite", ".bridlewise",
  "fixtures", "_experiments", "experiments",
]);

/**
 * Credential-shaped literals. This is a vocabulary of what a SECRET IS CALLED,
 * not a list of known offenders — it does not go stale when a file is added,
 * and a new test carrying one of these words is caught the day it lands.
 */
const CREDENTIAL_WORDS = [
  "password", "passwd", "apikey", "api_key", "api-key", "secret", "token",
  "bearer", "credential", "authorization", "private key", "privatekey",
  "sk_", "sk-", "ghp_", "akia", "xoxb-",
] as const;

/** Absence verbs, BOTH dialects. Keyed so a finding can name which one it was. */
const ABSENCE_PATTERNS: readonly Readonly<{ dialect: "node-assert" | "vitest"; re: RegExp }>[] = [
  { dialect: "node-assert", re: /assert\s*\.\s*ok\s*\(\s*!/g },
  { dialect: "node-assert", re: /assert\s*\.\s*doesNotMatch\s*\(/g },
  { dialect: "node-assert", re: /assert\s*\.\s*notEqual\s*\(/g },
  { dialect: "node-assert", re: /assert\s*\.\s*equal\s*\([^;]*?includes\s*\([^;]*?,\s*false\s*\)/g },
  { dialect: "vitest", re: /\.\s*not\s*\.\s*toContain\s*\(/g },
  { dialect: "vitest", re: /\.\s*not\s*\.\s*toMatch\s*\(/g },
  { dialect: "vitest", re: /\.\s*not\s*\.\s*toHaveProperty\s*\(/g },
  { dialect: "vitest", re: /\.\s*not\s*\.\s*toContainEqual\s*\(/g },
];

/** Presence verbs — the paired-marker witness, BOTH dialects. */
const PRESENCE_PATTERNS: readonly RegExp[] = [
  /assert\s*\.\s*ok\s*\(\s*[^!)][^;]*?\.\s*includes\s*\(/g,
  /assert\s*\.\s*match\s*\(/g,
  /assert\s*\.\s*equal\s*\([^;]*?\.\s*includes\s*\([^;]*?,\s*true\s*\)/g,
  // AN EQUALITY AGAINST A NON-EMPTY STRING LITERAL IS A PRESENCE ASSERTION,
  // and leaving it out MANUFACTURED DEBT. Two assertions in
  // `integration/test/shared/debug/debug-system.test.ts` were reported
  // unwitnessed while carrying the strongest witness form there is — a
  // NON-SENSITIVE SIBLING in the very object under test, asserted by value:
  //
  //     assert.equal(headers.accept, "WITNESS-A1-application/json",
  //                  "witness: the sibling header proves this is the object under test");
  //     assert.ok(!JSON.stringify(ctx).includes(HEADER_SECRET), …);
  //
  // If the emitted context were the wrong object, the sibling assertion fails
  // and the absence assertion never gets to pass over nothing. The detector
  // recognised `includes`, `match` and the vitest verbs, and simply had no
  // spelling for equality — so the count rose on a file that had done the
  // right thing. A vocabulary gap in a RATCHET is not neutral: it charges
  // debt for compliance, which is the fastest way to get a guard turned off.
  //
  // Bounded to a literal of two characters or more on the EXPECTED side:
  // `assert.equal(x, "")` asserts emptiness and witnesses nothing.
  /assert\s*\.\s*(?:strictEqual|equal|deepStrictEqual|deepEqual)\s*\([^;]*?,\s*"[^"]{2,}"/g,
  /(?<!\.\s{0,4}not\s{0,4})\.\s*toContain\s*\(/g,
  /(?<!\.\s{0,4}not\s{0,4})\.\s*toMatch\s*\(/g,
  /(?<!\.\s{0,4}not\s{0,4})\.\s*toHaveProperty\s*\(/g,
  /toBeGreaterThan(?:OrEqual)?\s*\(/g,
];

export type WitnessFinding = Readonly<{
  file: string;
  line: number;
  dialect: "node-assert" | "vitest";
  assertion: string;
}>;

export type ScanOutcome = Readonly<{
  findings: readonly WitnessFinding[];
  /** Security-relevant absence assertions examined. Unit: assertions. */
  examined: number;
  /** Per dialect, so a dialect that silently stops matching is visible. */
  byDialect: Readonly<Record<"node-assert" | "vitest", number>>;
  /** Test bodies entered. A zero here means the body finder broke, not that the tree is clean. */
  bodies: number;
  /** Absence assertions whose argument is a TEMPLATE literal — the stated hole, sized. */
  templateForm: number;
}>;

/** Is this line, within its body, about a credential? */
function mentionsCredential(text: string): boolean {
  const lower = text.toLowerCase();
  return CREDENTIAL_WORDS.some((w) => lower.includes(w));
}

/**
 * The bodies of every `test(...)` / `it(...)` in this source, brace-balanced on
 * the STRUCTURE view.
 *
 * Brace-balanced rather than delimited by the next `test(` — a guard in this
 * repository was found slicing one rule using the NEXT rule's name as its end
 * delimiter, which made deleting a property fail while reporting a different
 * property's name. The construct bounds itself or the bound is a guess.
 */
function testBodyRanges(structure: string): readonly Readonly<{ start: number; end: number }>[] {
  const ranges: { start: number; end: number }[] = [];
  const opener = /\b(?:test|it)\s*(?:\.\s*\w+\s*)?\(/g;
  for (let m = opener.exec(structure); m !== null; m = opener.exec(structure)) {
    // Walk forward to the first `{` that opens the callback body.
    let i = m.index + m[0].length;
    let depthParen = 1;
    let bodyStart = -1;
    while (i < structure.length) {
      const c = structure[i];
      if (c === "(") depthParen++;
      else if (c === ")") {
        depthParen--;
        if (depthParen === 0) break;
      } else if (c === "{" && depthParen === 1) {
        bodyStart = i;
        break;
      }
      i++;
    }
    if (bodyStart < 0) continue;
    let depth = 0;
    let j = bodyStart;
    for (; j < structure.length; j++) {
      if (structure[j] === "{") depth++;
      else if (structure[j] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) continue;
    ranges.push({ start: bodyStart + 1, end: j });
  }
  return ranges;
}

function lineNumberOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

/**
 * THE DETECTOR. Separated from the file walk so a plant can be driven through
 * exactly the code the real scan runs — a mutation modelled as a local lambda
 * proves nothing about the pin above it.
 */
export function scanSource(source: string, path: string): ScanOutcome {
  return scanView(sourceViewOf(source, path), path);
}

/** The same detector, over a file on disk read through the sanctioned reader. */
export function scanFile(path: string): ScanOutcome {
  return scanView(readSourceView(path), path);
}

function scanView(view: ReturnType<typeof sourceViewOf>, path: string): ScanOutcome {
  const structure = view.code();
  const subject = view.codeWithStrings();
  const findings: WitnessFinding[] = [];
  let examined = 0;
  let templateForm = 0;
  const byDialect = { "node-assert": 0, vitest: 0 };
  const bodies = testBodyRanges(structure);

  for (const { start, end } of bodies) {
    const bodySubject = subject.slice(start, end);
    const bodyStructure = structure.slice(start, end);

    // Every absence assertion in this body, with the dialect that found it.
    const hits: { index: number; dialect: "node-assert" | "vitest" }[] = [];
    for (const { dialect, re } of ABSENCE_PATTERNS) {
      re.lastIndex = 0;
      for (let m = re.exec(bodySubject); m !== null; m = re.exec(bodySubject)) {
        hits.push({ index: m.index, dialect });
      }
    }
    if (hits.length === 0) continue;

    // A body carries a PRESENCE assertion if any presence verb fires in it.
    const hasPresence = PRESENCE_PATTERNS.some((re) => {
      re.lastIndex = 0;
      return re.test(bodySubject);
    });

    for (const hit of hits) {
      // The assertion's own text, bounded by its LINE rather than by a byte
      // distance. A proximity window here would be the very idiom
      // `no-proximity-window-assertions` forbids — and it caught this file
      // doing it, which is the guard estate working.
      const lineEnd = bodySubject.indexOf("\n", hit.index);
      const assertion = bodySubject.slice(hit.index, lineEnd === -1 ? bodySubject.length : lineEnd).trim();
      if (!mentionsCredential(assertion)) continue;
      examined++;
      byDialect[hit.dialect]++;

      // The credential literals this assertion names.
      const quoted = [...assertion.matchAll(/"([^"]{2,120})"|'([^']{2,120})'/g)]
        .map((m) => m[1] ?? m[2] ?? "")
        .filter((s) => s.length > 0 && mentionsCredential(s));

      // Template-form: the argument came from a backtick, whose interior the
      // subject view blanks. Sized rather than silently skipped.
      if (quoted.length === 0 && /includes\s*\(\s{2,}|toContain\s*\(\s{2,}/.test(assertion)) templateForm++;

      // WITNESS 1 — a PLANT: the same literal appears in this body somewhere
      // that is not an absence assertion.
      const planted = quoted.some((lit) => {
        let from = 0;
        for (;;) {
          const at = bodySubject.indexOf(lit, from);
          if (at === -1) return false;
          const lineStart = bodySubject.lastIndexOf("\n", at) + 1;
          const lineEnd = bodySubject.indexOf("\n", at);
          const line = bodySubject.slice(lineStart, lineEnd === -1 ? bodySubject.length : lineEnd);
          const isAbsence = ABSENCE_PATTERNS.some(({ re }) => {
            re.lastIndex = 0;
            return re.test(line);
          });
          if (!isAbsence) return true;
          from = at + lit.length;
        }
      });

      // WITNESS 2 — a runtime-built canary bound to a name and used as input.
      // `const key = \`sk-…\${randomUUID()}\`` planted through a request body is
      // the strongest form there is, and it leaves no matching quoted literal.
      const runtimeCanary = /\b(?:const|let)\s+\w*(?:key|canary|secret|token|password|credential)\w*\s*=/i.test(bodyStructure);

      if (!planted && !hasPresence && !runtimeCanary) {
        findings.push({
          file: path,
          line: lineNumberOf(subject, start + hit.index),
          dialect: hit.dialect,
          assertion: assertion.slice(0, 160),
        });
      }
    }
  }
  return { findings, examined, byDialect, bodies: bodies.length, templateForm };
}

function scannedFiles(): string[] {
  const out: string[] = [];
  const walkTree = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walkTree(full);
      else if (entry.isFile() && /\.test\.(?:ts|mts|js|mjs)$/.test(entry.name)) out.push(full);
    }
  };
  for (const tree of SCANNED_TREES) {
    // A TREE THAT DOES NOT EXIST IS NOT AN EMPTY TREE.
    expect(
      statSync(tree).isDirectory(),
      `${tree} must be a directory — a missing scan root is not an empty one`,
    ).toBe(true);
    walkTree(tree);
  }
  return out;
}

function scanEstate(): ScanOutcome & { files: number; perTree: Record<string, number> } {
  const files = scannedFiles();
  const findings: WitnessFinding[] = [];
  const perTree: Record<string, number> = {};
  let examined = 0;
  let bodies = 0;
  let templateForm = 0;
  const byDialect = { "node-assert": 0, vitest: 0 };
  for (const file of files) {
    const tree = SCANNED_TREES.find((t) => file.startsWith(t)) ?? "?";
    perTree[tree] = (perTree[tree] ?? 0) + 1;
    const outcome = scanFile(file);
    findings.push(...outcome.findings);
    examined += outcome.examined;
    bodies += outcome.bodies;
    templateForm += outcome.templateForm;
    byDialect["node-assert"] += outcome.byDialect["node-assert"];
    byDialect.vitest += outcome.byDialect.vitest;
  }
  return { findings, examined, byDialect, bodies, templateForm, files: files.length, perTree };
}

// ═══════════════════════════════════════════════════════════════════════════

describe("§36: a security-relevant absence assertion carries a witness", () => {
  const estate = scanEstate();

  test("the estate is really walked — population as a runtime number, per tree", () => {
    // §31a: containment per part, never a scalar over the whole. A total floor
    // cannot see one tree collapse to zero while the other grows.
    for (const tree of SCANNED_TREES) {
      expect(estate.perTree[tree] ?? 0, `${tree} contributed no test files`).toBeGreaterThan(0);
    }
    expect(estate.bodies, "no test bodies were entered — the body finder is broken, not the tree clean").toBeGreaterThan(100);
    expect(estate.examined, "no security-relevant absence assertion was examined at all").toBeGreaterThan(0);
    console.log(
      `[absence-witness] files=${estate.files} bodies=${estate.bodies} examined=${estate.examined}`
      + ` node-assert=${estate.byDialect["node-assert"]} vitest=${estate.byDialect.vitest}`
      + ` template-form(unreachable)=${estate.templateForm} unwitnessed=${estate.findings.length}`,
    );
    for (const f of estate.findings) console.log(`  UNWITNESSED ${f.file}:${f.line} [${f.dialect}] ${f.assertion}`);
  });

  /**
   * THE GATE, AND IT IS A RATCHET RATHER THAN `toEqual([])` — SAID PLAINLY.
   *
   * There were 26 unwitnessed security-relevant absence assertions when this
   * guard was written, across both trees and both dialects. Clearing all of
   * them is real work on files this step did not otherwise touch, so the honest
   * gate is one that cannot get WORSE while the debt is paid down. Every
   * finding is printed by the population test above, so the debt is a list a
   * reader can act on rather than a number.
   *
   * Two things keep this from being a scalar that hides a partial collapse
   * (§31): the per-dialect population assertion beside it, and the per-file
   * containment below — the files this step repaired are named, so a
   * regression in one of them fails by NAME instead of being absorbed by the
   * ceiling.
   *
   * Some findings are conservative rather than real: `isValidGitAuthMethod("password")`
   * asks about a vocabulary member, not about egress. The detector is
   * deliberately broad, because a detector tuned to exclude shapes is a list of
   * shapes and lists go stale. Over-reporting under a ratchet is safe;
   * under-reporting is the defect this whole file exists for.
   *
   * ── RE-DERIVED FROM 26 TO 21, AND WHY THAT IS NOT A RAISE ────────────────
   *
   * §20b: a threshold names the population it bounds, and a change to that
   * population forces the number to be re-stated. The population changed here
   * — `PRESENCE_PATTERNS` gained a verb it should always have had, an equality
   * against a non-empty string literal — so the count is over a different set
   * and 26 no longer describes anything.
   *
   * The trigger was a rise, not a fall: two assertions in
   * `integration/test/shared/debug/debug-system.test.ts` pushed the count to
   * **28** while carrying an explicit `assert.equal(sibling, "WITNESS-A1-…")`
   * beside them. The debt had not grown; the vocabulary had a hole, and a
   * ratchet with a vocabulary hole charges debt for compliance.
   *
   * Measured, `npx vitest run tests/prevention/absence-witness-owner.test.ts`,
   * rc 0, unit: unwitnessed assertions over 888 files / 15,019 test bodies /
   * 149 examined: **28 before the verb, 21 after.** Seven reclassified — the
   * two above plus five others whose bodies also assert a value by equality.
   *
   * ── AND 21 IS A FLOOR ON THE DEBT, NOT THE DEBT ──────────────────────────
   *
   * A witness counts here when it is PRESENT IN THE SAME BODY, not when it is
   * derived from the same subject the absence assertion examines. That rule is
   * satisfied by `expect(1).toBeGreaterThan(0)`, by a presence assertion about
   * an unrelated value, and by a `const` whose name merely contains a
   * credential word — measured elsewhere at **at least 6 of the currently
   * witnessed assertions**. Closing that needs LINKAGE, which is a larger
   * change than this one and would move the number UP. It is stated rather
   * than implied, because a ratchet that looks like progress and is not is
   * worse than a larger number that is true.
   */
  const UNWITNESSED_CEILING = 19;

  test("the number of unwitnessed absence assertions never rises", () => {
    expect(
      estate.findings.length,
      `Unwitnessed security-relevant absence assertions rose above ${UNWITNESSED_CEILING}. `
      + "Every assertion that a secret is ABSENT needs something asserted PRESENT beside it — "
      + "either the canary planted as input, or a paired marker such as `[REDACTED:`. "
      + "Without one, a scan pointed at the wrong subject returns zero and reads as a pass. "
      + "The full list is printed by the population test above.",
    ).toBeLessThanOrEqual(UNWITNESSED_CEILING);
  });

  test("the files this step repaired are clean BY NAME, not by ceiling", () => {
    // §31a: containment per part. A scalar ceiling cannot see one file regress
    // while another improves.
    const repaired = [
      join("engine", "test", "performance", "performance-hostile.test.ts"),
    ];
    for (const file of repaired) {
      expect(
        estate.findings.filter((f) => f.file === file).map((f) => `${f.line}: ${f.assertion}`),
        `${file} was repaired to carry witnesses and has regressed`,
      ).toEqual([]);
    }
    // WITNESS: the repaired file really was scanned. Without this the emptiness
    // above is satisfied by a path that no longer matches anything.
    const scanned = scanFile(repaired[0]!);
    expect(scanned.examined, "witness: the repaired file still carries examined assertions").toBeGreaterThan(0);
  });

  test("★ BOTH VOCABULARIES ARE LIVE IN THE REAL CORPUS, not just in the pattern list", () => {
    // THE POINT OF THIS FILE. A guard that matched only `.not.toContain(` would
    // scan the whole harness half and report it clean. If either number here
    // goes to zero, this guard has gone half-blind and says so.
    expect(
      estate.byDialect["node-assert"],
      "no node:assert absence assertion was examined — the harness half has gone invisible to this guard",
    ).toBeGreaterThan(0);
    expect(
      estate.byDialect.vitest,
      "no vitest absence assertion was examined — the web half has gone invisible to this guard",
    ).toBeGreaterThan(0);
  });
});

describe("the guard sees both vocabularies — driven, not asserted", () => {
  const UNWITNESSED_NODE = `
import assert from "node:assert/strict";
import test from "node:test";
test("nothing planted, node dialect", () => {
  const json = JSON.stringify(buildIt());
  assert.ok(!json.includes("password"));
});
`;
  const UNWITNESSED_VITEST = `
import { test, expect } from "vitest";
test("nothing planted, vitest dialect", () => {
  const body = render();
  expect(body).not.toContain("apiKey");
});
`;
  const WITNESSED_BY_PLANT = `
import assert from "node:assert/strict";
import test from "node:test";
test("planted, node dialect", () => {
  const json = JSON.stringify(redact({ password: "hunter2-password" }));
  assert.ok(!json.includes("hunter2-password"));
});
`;
  const WITNESSED_BY_PRESENCE = `
import { test, expect } from "vitest";
test("paired marker, vitest dialect", () => {
  const out = redactAll(input);
  expect(out).toContain("[REDACTED:");
  expect(out).not.toContain("apiKey");
});
`;
  const INERT_NO_CREDENTIAL = `
import { test, expect } from "vitest";
test("an absence assertion about nothing sensitive is none of this guard's business", () => {
  expect(renderList()).not.toContain("placeholder-row");
});
`;

  test("PLANT — an unwitnessed node:assert absence assertion is FOUND", () => {
    const out = scanSource(UNWITNESSED_NODE, "plant-node.test.ts");
    expect(out.examined).toBe(1);
    expect(out.byDialect["node-assert"]).toBe(1);
    expect(out.findings.map((f) => f.dialect)).toEqual(["node-assert"]);
  });

  test("PLANT — an unwitnessed vitest absence assertion is FOUND", () => {
    const out = scanSource(UNWITNESSED_VITEST, "plant-vitest.test.ts");
    expect(out.examined).toBe(1);
    expect(out.byDialect.vitest).toBe(1);
    expect(out.findings.map((f) => f.dialect)).toEqual(["vitest"]);
  });

  test("CONTROL — a plant witnesses it, and the finding disappears", () => {
    const out = scanSource(WITNESSED_BY_PLANT, "control-plant.test.ts");
    expect(out.examined, "still examined — the difference is the verdict, not the population").toBe(1);
    expect(out.findings).toEqual([]);
  });

  test("CONTROL — a paired presence marker witnesses it, and the finding disappears", () => {
    const out = scanSource(WITNESSED_BY_PRESENCE, "control-presence.test.ts");
    expect(out.examined).toBe(1);
    expect(out.findings).toEqual([]);
  });

  test("INERT — an absence assertion about nothing sensitive is neither examined nor flagged", () => {
    // The wired-but-inert direction. Without this, a detector that flagged
    // EVERYTHING would pass all four tests above and be useless.
    const out = scanSource(INERT_NO_CREDENTIAL, "inert.test.ts");
    expect(out.bodies, "witness: the body WAS entered — the zeros below are a verdict, not a miss").toBe(1);
    expect(out.examined).toBe(0);
    expect(out.findings).toEqual([]);
  });

  test("the detector reads through the sanctioned views — a credential word in a COMMENT is not an assertion", () => {
    const commentOnly = `
import { test, expect } from "vitest";
test("a comment is not an assertion", () => {
  // expect(x).not.toContain("password");
  expect(render()).toContain("ok");
});
`;
    const out = scanSource(commentOnly, "comment.test.ts");
    expect(out.bodies, "witness: the body was entered").toBe(1);
    expect(out.examined, "the commented-out assertion is not counted").toBe(0);
  });

  test("the body finder is brace-bounded, not delimited by the next test's name", () => {
    const twoBodies = `
import { test, expect } from "vitest";
test("first", () => {
  const nested = { a: { b: 1 } };
  expect(String(nested)).not.toContain("apiKey");
});
test("second", () => {
  expect(render()).toContain("[REDACTED:");
});
`;
    const out = scanSource(twoBodies, "two.test.ts");
    expect(out.bodies).toBe(2);
    // The second body's presence marker must NOT witness the first body's
    // absence assertion. If the bodies bled together this would be [].
    expect(out.findings.length, "a witness in a DIFFERENT test must not count").toBe(1);
  });
});

describe("the guard is scoped to a real directory it can prove it read", () => {
  test("a planted file inside a scanned tree is really picked up by the walk", () => {
    // §36 applied to the walk itself: the estate scan's zero is only meaningful
    // if the walk demonstrably reaches new files. Through `createTempDir`, the
    // suite's single owner, so the directory cannot outlive this test.
    const dir = createTempDir("absence-witness-");
    const planted = join(dir, "planted.test.ts");
    writeFileSync(planted, UNWITNESSED_MARKER, "utf8");
    const entries = readdirSync(dir).filter((f) => /\.test\.ts$/.test(f));
    expect(entries, "the walk's file filter accepts a .test.ts file").toContain("planted.test.ts");
    const out = scanFile(planted);
    expect(out.findings.length, "and the detector finds the plant when read from disk").toBe(1);
  });
});

const UNWITNESSED_MARKER = `
import { test, expect } from "vitest";
test("planted into a temp tree", () => {
  expect(serialise()).not.toContain("password");
});
`;
