import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";

import { experimentExclusion, walk } from "../../scripts/verification/source-walk.ts";

/**
 * A DEFAULT IS AN INPUT TO RESOLUTION, NEVER A VALUE A CONSUMER READS.
 *
 * ── THE BUG THIS EXISTS FOR ─────────────────────────────────────────────────
 *
 * The redaction engine's marker recogniser imported `DEFAULT_REDACTION_PREFIX`
 * while the writer formatted from the RESOLVED `policy.redactionPrefix`.
 * Configure the prefix to anything other than the built-in and the two part
 * company: the engine masked a secret, then read its own mask as a declared
 * credential, reported a residual secret, and the evidence handler returned
 * EMPTY CONTENT. Configuring the marker destroyed the evidence it marked.
 *
 * ── WHY NO TEST CAUGHT IT, WHICH IS THE IMPORTANT PART ──────────────────────
 *
 * The whole suite runs on default configuration, so `DEFAULT_X === resolved.x`
 * holds in every test that exists. The defect is not under-tested; it is
 * INVISIBLE BY CONSTRUCTION, and so is every sibling of it. A guard is needed
 * precisely because no amount of ordinary testing can see this class.
 *
 * ── THE RULE, AND WHY THIS ONE ──────────────────────────────────────────────
 *
 * A module that declares a default AND resolves it is holding both halves of
 * one question. In that module the resolved answer already exists, so there is
 * no honest reason for anyone else to read the default: reading it yields a
 * value that stops tracking configuration the instant a caller supplies any.
 *
 *   A module-level default that its OWN module uses as the fallback arm of a
 *   resolution must not be exported.
 *
 * Unexported, the mistake becomes unreachable by shape rather than merely
 * discouraged — a consumer cannot read what it cannot name, so forgetting is
 * a compile error. Where the owner does NOT resolve its default, exporting it
 * is correct: the default is then genuinely the input each consumer resolves
 * with, and this guard says nothing about those.
 *
 * ── WHAT THIS GUARD CANNOT SEE, STATED PLAINLY ──────────────────────────────
 *
 * This is a source scan, and a source scan is only as good as the universe it
 * scans. Two limits, both real:
 *
 *  1. THE NAME. The universe is identifiers containing `DEFAULT` as a word
 *     token — the convention this codebase uses. A default named without it
 *     is invisible here. That is not hypothetical: a scan for the `DEFAULT_`
 *     PREFIX alone missed `OBAFGKM_DEFAULT_BOUNDARIES`, `MEMORY_DEFAULT_CONFIG`
 *     and `MAX_LINES_DEFAULT`, which is why the universe is a token match and
 *     not a prefix match.
 *
 *     The name-free alternative — "any exported module-level const used as its
 *     own module's fallback" — was measured, twice, and flags exactly FOUR
 *     pieces of correct code: two per-process state objects
 *     (`registrations/context.ts`, `registrations/memory.ts`), one sentinel
 *     (`recording-context.ts UNATTRIBUTED`) and one value that is itself a
 *     projection of the root policy (`mcp-adapter.ts MCP_PROTOCOL_VERSION`).
 *     Three of the four fall out under extra conditions — "never assigned to"
 *     drops the state objects, "initialised from a local literal" drops the
 *     projection — but the sentinel does not, and a conjunction assembled
 *     until the count reached zero is an allowlist written in regex, which is
 *     worse than a list because it is invisible. A narrower rule that is TRUE
 *     beats a broader rule that can only be satisfied by exceptions.
 *
 *  2. THE FORM. Resolution is recognised as `?? DEFAULT`. Measured escapes:
 *     `||`, `??=`, a destructuring or parameter default, and a helper call
 *     (`validate(value, fallback)`). Every resolver in this tree uses `??`,
 *     which is what makes the scan complete TODAY — not what keeps it
 *     complete.
 *
 *  3. THE HANDOUT. Detected export forms are `export const X`, `export { X }`
 *     and `export { X as Y }` — all covered by the planted-violation control
 *     below. Two forms still escape and are recorded rather than guessed at:
 *     `export default X`, and an ALIAS BINDING (`const D = …;` private, then
 *     `export const PUBLIC = D;`) which hands the same value out under a name
 *     that carries no marker at all.
 *
 *  4. THE MODULE. Declaration and resolution must be in the SAME file. Split
 *     them — the default in a `*-config.ts`, the `??` in its consumer — and
 *     the scan is silent by construction, while the default stays exported and
 *     any third module can still read it instead of the resolved field. That
 *     split is not hypothetical: `privacy-config.ts` declares three limits
 *     that `privacy-policy.ts` both resolves AND re-exports. Nothing reads
 *     them un-resolved today, and nothing stops it.
 *
 * All four limits are why the instance fix does not rest on this test: the
 * redaction default is module-private, which no scan has to notice.
 */

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

/** Identifiers whose name carries the word DEFAULT in any position. */
const DEFAULT_TOKEN = /(^|_)DEFAULT($|_)|_DEFAULT_|DEFAULT_/u;

function isDefaultNamed(identifier: string): boolean {
  const upper = identifier.toUpperCase();
  if (identifier !== upper) return false; // constant-case names only
  return DEFAULT_TOKEN.test(upper);
}

function listSourceFiles(directory: string, accumulator: string[] = []): string[] {
  accumulator.push(...walk(directory, { exts: [".ts", ".mts"], exclude: experimentExclusion(ROOT) }));
  return accumulator;
}

/**
 * Comments are not code. A doc comment explaining `config.x ?? DEFAULT_X` is
 * documentation of the rule, not a violation of it — and reading one as a
 * resolution site produced a false accusation against
 * `workflow-config.ts` on the first pass of this scan.
 */
function withoutComments(source: string): string {
  return source
    .split("\n")
    .map((line) => (/^\s*(\/\/|\*|\/\*)/u.test(line) ? "" : line.replace(/\/\/.*$/u, "")))
    .join("\n");
}

type Scan = Readonly<{
  declaredDefaults: number;
  fallbackSites: number;
  exportedDefaults: number;
  exportClauseNames: number;
  violations: readonly string[];
}>;

function scanSources(files: readonly string[], read: (file: string) => string): Scan {
  const violations: string[] = [];
  let declaredDefaults = 0;
  let fallbackSites = 0;
  let exportedDefaults = 0;
  let exportClauseNames = 0;

  for (const file of files) {
    const rel = relative(ROOT, file).replaceAll("\\", "/");
    const source = withoutComments(read(file));

    // Every module-level binding this file declares, and whether it is
    // exported by ANY form — `export const X`, `export { X }`, or
    // `export { X as Y }`. A re-export under a different name still hands the
    // value out, so the check is on the LOCAL name appearing in an export
    // clause, not on what it is called outside.
    const declared = new Set<string>();
    const exported = new Set<string>();
    for (const match of source.matchAll(/^(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gmu)) {
      declared.add(match[2]!);
      if (match[1] !== undefined) exported.add(match[2]!);
    }
    for (const clause of source.matchAll(/^export\s*\{([^}]*)\}/gmu)) {
      for (const raw of clause[1]!.split(",")) {
        const local = raw.trim().replace(/^type\s+/u, "").split(/\s+/u)[0];
        if (local !== undefined && local.length > 0) {
          exported.add(local);
          exportClauseNames += 1;
        }
      }
    }
    for (const name of declared) {
      if (!isDefaultNamed(name)) continue;
      declaredDefaults += 1;
      if (exported.has(name)) exportedDefaults += 1;
    }

    // Fallback arms: the right-hand side of `??`, including a property access
    // on a default document (`overrides.x ?? DEFAULT_DOC.x`).
    for (const match of source.matchAll(/\?\?\s*([A-Za-z_$][\w$]*)/gu)) {
      const name = match[1]!;
      if (!declared.has(name)) continue;
      fallbackSites += 1;
      if (!isDefaultNamed(name)) continue;
      if (!exported.has(name)) continue;
      violations.push(`${rel}: ${name}`);
    }
  }
  return {
    declaredDefaults,
    fallbackSites,
    exportedDefaults,
    exportClauseNames,
    violations: [...new Set(violations)].sort(),
  };
}

function scan(): Scan {
  return scanSources(listSourceFiles(SRC), (file) => readFileSync(file, "utf8"));
}

/**
 * The scan run against sources written HERE rather than against the tree.
 *
 * This is the positive control the tree cannot provide: when the tree is clean
 * the scan reports nothing, and "reports nothing" is also what a scan reports
 * when one of its three detectors has silently stopped matching. A count of
 * what the detectors found proves two of the three arms are alive; only a
 * source that IS a violation proves the arm that decides.
 */
function scanFixture(sources: Readonly<Record<string, string>>): Scan {
  return scanSources(Object.keys(sources), (file) => sources[file]!);
}

test("resolved defaults: a default its own module resolves is never exported", () => {
  const result = scan();
  assert.deepEqual(
    result.violations,
    [],
    "These modules both declare a default and resolve it, and still hand the default out. " +
      "The resolved field is the answer; the default is only its input, and a consumer that " +
      "reads the default stops tracking configuration the moment a caller supplies any — which " +
      "no test can see, because the suite runs on default configuration. " +
      "Fix: drop the `export` and export the resolver instead (callers that want the plain " +
      "defaults call it with no arguments). Offenders: " +
      result.violations.join("; "),
  );
});

test("resolved defaults: the scan has a universe to scan (no vacuous pass)", () => {
  // A guard about what a scan does NOT find must first prove the scan found
  // anything at all. A regex that silently stops matching — a renamed export
  // form, a changed comment style — turns this file green while enforcing
  // nothing, which is the most expensive kind of pass there is.
  const result = scan();
  assert.ok(
    result.declaredDefaults >= 100,
    `the scan must still be finding default-named module constants; found ${result.declaredDefaults}`,
  );
  assert.ok(
    result.fallbackSites >= 100,
    `the scan must still be finding \`??\` resolution sites; found ${result.fallbackSites}`,
  );
  // The THIRD arm, and the one a count of the other two cannot reach. The
  // verdict is `declared AND default-named AND EXPORTED`; break the export
  // detector and every candidate reads as private, so the file goes green
  // while enforcing nothing — and the two counts above stay exactly as they
  // were. Renaming the clause regex by one character was enough.
  assert.ok(
    result.exportClauseNames >= 100,
    `the scan must still be reading \`export { … }\` clauses; found ${result.exportClauseNames} names`,
  );
  assert.ok(
    result.exportedDefaults >= 1,
    `the scan must still be able to SEE a default-named constant as exported; found ${result.exportedDefaults}`,
  );
});

test("resolved defaults: the scan detects a planted violation in every export form", () => {
  // A positive control. Counting what the detectors found says they are awake;
  // only a source that IS a violation says they still AGREE on a verdict. Each
  // fixture is the same defect written a different legal way, so a detector
  // that regresses for one form alone is still caught.
  const forms: Readonly<Record<string, string>> = {
    "fixture/inline.ts": `export const DEFAULT_THING = 1;\nexport function resolve(o: { thing?: number }) { return o.thing ?? DEFAULT_THING; }\n`,
    "fixture/clause.ts": `const DEFAULT_THING = 1;\nfunction resolve(o: { thing?: number }) { return o.thing ?? DEFAULT_THING; }\nexport { DEFAULT_THING, resolve };\n`,
    "fixture/renamed.ts": `const DEFAULT_THING = 1;\nfunction resolve(o: { thing?: number }) { return o.thing ?? DEFAULT_THING; }\nexport { DEFAULT_THING as THING_FALLBACK, resolve };\n`,
    "fixture/multiline.ts": `const DEFAULT_THING = 1;\nfunction resolve(o: { thing?: number }) { return o.thing ?? DEFAULT_THING; }\nexport {\n  DEFAULT_THING,\n  resolve,\n};\n`,
    "fixture/token-in-the-middle.ts": `export const THING_DEFAULT_VALUE = 1;\nexport function resolve(o: { thing?: number }) { return o.thing ?? THING_DEFAULT_VALUE; }\n`,
  };
  const planted = scanFixture(forms);
  assert.deepEqual(
    planted.violations.map((v) => v.split(":")[0]).sort(),
    Object.keys(forms).sort(),
    "every export form that hands a self-resolved default out must be detected; " +
      `detected: ${planted.violations.join("; ")}`,
  );

  // And the control must be able to say NO, or it is not a control.
  const clean = scanFixture({
    "fixture/private.ts": `const DEFAULT_THING = 1;\nexport function resolve(o: { thing?: number }) { return o.thing ?? DEFAULT_THING; }\n`,
    "fixture/not-resolved-here.ts": `export const DEFAULT_THING = 1;\nexport function describe() { return DEFAULT_THING; }\n`,
    "fixture/comment-only.ts": `export const DEFAULT_THING = 1;\n// resolution is written as \`o.thing ?? DEFAULT_THING\` in the consumer\nexport function describe() { return DEFAULT_THING; }\n`,
  });
  assert.deepEqual(clean.violations, [], `the control must not accuse correct code: ${clean.violations.join("; ")}`);
});
