// @vitest-environment node
/**
 * THE STRIPPER FAMILY'S PATH CONTRACT — every file-content door REQUIRES the
 * path, and the mode-hardcoded path-less doors DO NOT EXIST.
 *
 * ── THE CLASS THIS GUARD OWNS ──────────────────────────────────────────────
 *
 * A scanner's answer depends entirely on which text it asked, and for a
 * mixed `.ts` + `.svelte` population the honest text depends on the FILE:
 * a `//` line is comment material inside script blocks and literal prose in
 * markup. The flat era made the strippers' mode flags meaningless over code
 * files, so ~20 web test files passed file content through mode-hardcoded
 * path-less doors for years; the mode machine made the modes mean what the
 * language means, and the first honest census found a false-offender
 * factory (template mode over `.ts` keeps commented mentions as prose) and
 * a phantom-span factory (flat mode over `.svelte` markup) live on the
 * real tree at once.
 *
 * ── THE ENFORCEMENT SHAPE, AND WHY NOT A PROVENANCE LINT ──────────────────
 *
 * The tempting guard traces each call's first argument back to the
 * `read()`/walk that produced it and reds when file content reaches a
 * path-less door. That is DATAFLOW over test sources — loop variables,
 * helper-bound readers, function-body slices — and every indirection a
 * future test invents is a new blind spot: a guard whose static tracer
 * silently understands less tomorrow is a false-absence machine with a
 * green light attached. The stronger shape makes the misuse UNSPELLABLE
 * instead of traced: the two mode-hardcoded doors are deleted, every
 * file-content door takes the path as a REQUIRED parameter (a 1-argument
 * call is a typecheck error through every import alias), and a fragment
 * names its own mode the same way — a probe path, `probe.ts` or
 * `probe.svelte`, passed as the path argument. This suite is the standing
 * second half (the source-view doctrine: a type closes the door a caller
 * walks through by habit, only a scan can refuse the one that walks around
 * it): an alias-resolving census over tests/**, so a path-less call that
 * somehow compiles still reds, the deleted doors stay deleted, and the
 * receipt prints what the census saw.
 *
 * ── THE UNIVERSE, STATED PLAINLY ───────────────────────────────────────────
 *
 * The family this guard walks is the web test tree's shared stripper module
 * (`tests/helpers/source-scan.ts`) and every file under `tests/` that
 * imports it. The engine's own scanners (engine/test/support/source-scan.ts,
 * the quality checks' per-line stripper, dynamic-keywords' private one) are
 * OUTSIDE this universe by design: they own flat implementations over
 * pure-`.ts` populations and never were part of the migrated family. The
 * 1-argument fragment doors that remain (`stripCommentsOnly` — the flat
 * walk; `stripTemplateComments` — the template walk; `codeStructureOnly`;
 * `stripCssBlockComments`) hardcode ONE mode each and say so in their
 * docstrings; this census enforces the one shape their misuse always took:
 * a DIRECT read of a path literal whose extension contradicts the door's
 * hardcoded mode.
 */
import { describe, test, expect } from "vitest";
import { dirname, join, resolve } from "node:path";

import * as sourceScan from "../helpers/source-scan.ts";
import {
  codeStructureOnly,
  relpath,
  walk,
} from "../helpers/source-scan.ts";
import {
  isTemplateSource,
  readSourceView,
  renderSpans,
} from "../../engine/scripts/verification/source-view.ts";

/** The doors that REQUIRE the path: a 1-argument call through any alias. */
const PATH_REQUIRED_DOORS: ReadonlySet<string> = new Set([
  "stripCommentsAndStringsFor",
  "stripCommentsAndStringsDropFor",
  "stripCommentsOnlyFor",
  "blankStringLiterals",
  "stripBlockAndOwnLineComments",
  "stripHtmlComments",
]);

/** The deleted mode-hardcoded doors: no import may name them, the helper
 * must not export them, and the typecheck refuses them besides. */
const DELETED_DOORS: ReadonlySet<string> = new Set([
  "stripCommentsAndStrings",
  "stripCommentsAndStringsDrop",
]);

/** The 1-argument fragment doors, each with the ONE mode it hardcodes. A
 * direct read of a path literal of the WRONG mode through one of these is
 * the historical misuse shape (the flat door over a `.svelte` read, the
 * template door over a `.ts` read) and reds. */
const FRAGMENT_DOOR_MODE: ReadonlyMap<string, boolean> = new Map([
  ["stripCommentsOnly", false],
  ["stripTemplateComments", true],
]);

const HELPER_CANONICAL = resolve("tests/helpers/source-scan.ts");

/** Every `.ts` file under tests/, discovered dynamically — a new test file
 * is inside the census the day it lands, and the helper module itself is
 * walked too (its own internal calls obey the same contract). */
const TEST_FILES = walk("tests", { exts: [".ts"] });

interface TrackedName {
  /** The canonical export the local name resolves to. */
  readonly canonical: string;
  /** How calls are spelled: `name(` for a clause import, `ns.name(` for a
   * namespace import. */
  readonly callPrefix: string;
  /** True when an import clause NAMES this member (`import { X }`); a
   * namespace import names none — its members are only evidence as calls. */
  readonly named: boolean;
}

/** One call site found by the census, with the line the reader opens. */
interface CallSite {
  readonly file: string;
  readonly line: number;
  readonly canonical: string;
  readonly argc: number;
  readonly argText: string;
}

/** Parse every import clause in `src` that resolves to the shared helper,
 * mapping each LOCAL name (aliases included) to its canonical export. */
function helperImportsOf(src: string, file: string): Map<string, TrackedName> {
  const out = new Map<string, TrackedName>();
  const clauseRe = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = clauseRe.exec(src)) !== null) {
    const specifier = m[2]!;
    if (!specifier.endsWith("source-scan.ts")) continue;
    if (resolve(join(dirname(file), specifier)) !== HELPER_CANONICAL) continue;
    for (const spec of m[1]!.split(",")) {
      const parts = spec.trim().split(/\s+as\s+/);
      const canonical = (parts[0] ?? "").replace(/^type\s+/, "").trim();
      if (canonical.length === 0) continue;
      out.set((parts[1] ?? canonical).trim(), { canonical, callPrefix: "", named: true });
    }
  }
  const nsRe = /import\s*\*\s*as\s+(\w+)\s*from\s*["']([^"']*source-scan\.ts)["']/g;
  while ((m = nsRe.exec(src)) !== null) {
    if (resolve(join(dirname(file), m[2]!)) !== HELPER_CANONICAL) continue;
    for (const canonical of [...PATH_REQUIRED_DOORS, ...DELETED_DOORS, ...FRAGMENT_DOOR_MODE.keys()]) {
      out.set(`${m[1]}.${canonical}`, { canonical, callPrefix: `${m[1]}.`, named: false });
    }
  }
  return out;
}

/** The string literals a file binds at one hop: `const NAME = "…"` (the
 * historical path-constant shape every misused site used). */
function unquote(literal: string): string {
  const quote = literal[0]!;
  const body = literal.slice(1, -1);
  return body.replace(/\\(.)/g, (_match, ch: string) => (ch === "n" ? "\n" : ch));
}

function constStringBindings(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /\bconst\s+(\w+)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.set(m[1]!, unquote(m[2]!));
  return out;
}

/** Find every call of a tracked name, counting TOP-LEVEL arguments over the
 * offset-preserving literal-blanked view so a paren or comma inside a
 * string or comment cannot miscount, and slicing each argument list from
 * the VIEWED source (quoted strings intact) so a literal path in an
 * argument is readable; every view preserves offsets, so the line numbers
 * are the lines the reader opens. */
function callsOf(
  viewedSrc: string,
  structure: string,
  file: string,
  localName: string,
  tracked: TrackedName,
): CallSite[] {
  const out: CallSite[] = [];
  const callRe = new RegExp(`\\b${tracked.callPrefix}${localName}\\s*\\(`, "g");
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(structure)) !== null) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let commas = 0;
    let i = open;
    for (; i < structure.length; i++) {
      const ch = structure[i]!;
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") {
        depth--;
        if (depth === 0) break;
      } else if (ch === "," && depth === 1) commas++;
    }
    const argText = viewedSrc.slice(open + 1, i);
    out.push({
      file,
      line: viewedSrc.slice(0, m.index).split("\n").length,
      canonical: tracked.canonical,
      argc: commas + 1,
      argText,
    });
  }
  return out;
}

/** The tests/ source of one file, through the view door: comments and
 * template interiors blanked, QUOTED STRINGS INTACT. The census's questions
 * are about code (import clauses, call shapes) and the quoted literals
 * inside it (module specifiers, path constants) — exactly the
 * `codeWithStrings()` contract — and a fixture quoting source inside a
 * template literal stops counting as evidence, which the raw text never
 * promised. */
function viewedSourceOf(absPath: string): string {
  return readSourceView(absPath).codeWithStrings();
}

/** The census: every family call site under tests/, with imports resolved
 * through aliases — the fact the round-77 grep census could not see
 * (an aliased import spelled its calls with the alias, so the grep counted
 * a fraction of the tree and called it the whole). */
function runCensus() {
  const requiredCalls: CallSite[] = [];
  const fragmentCalls: CallSite[] = [];
  const deadImports: string[] = [];
  const castDoors: string[] = [];
  for (const abs of TEST_FILES) {
    const file = relpath(abs);
    const src = viewedSourceOf(abs);
    const structure = codeStructureOnly(src);
    for (const [local, tracked] of helperImportsOf(src, file)) {
      if (DELETED_DOORS.has(tracked.canonical)) {
        // A clause NAMES the member — a stale named import reds on its own;
        // a namespace import names nothing, so it reds only if a call
        // actually reaches through it.
        const called = tracked.named
          ? true
          : callsOf(src, structure, file, local, tracked).length > 0;
        if (called) deadImports.push(`${file} imports the deleted ${tracked.canonical} as ${local}`);
        continue;
      }
      if (PATH_REQUIRED_DOORS.has(tracked.canonical)) {
        requiredCalls.push(...callsOf(src, structure, file, local, tracked));
        // A CAST is how a 1-argument call is made to compile after the door
        // took its required path — the cast strips the signature, so the
        // typecheck goes quiet and only this scan sees the bypass.
        const castRe = new RegExp(`\\b${tracked.callPrefix}${local}\\s+as\\b`, "g");
        let cast: RegExpExecArray | null;
        while ((cast = castRe.exec(structure)) !== null) {
          const line = structure.slice(0, cast.index).split("\n").length;
          castDoors.push(
            `${file}:${line} — ${tracked.canonical} is cast, and a cast is how a path-less ` +
              `call is made to compile; call it as ${tracked.canonical}(src, path) instead`,
          );
        }
        continue;
      }
      if (FRAGMENT_DOOR_MODE.has(tracked.canonical)) {
        fragmentCalls.push(...callsOf(src, structure, file, local, tracked));
      }
    }
  }
  return { requiredCalls, fragmentCalls, deadImports, castDoors };
}

const CENSUS = runCensus();

describe("the stripper family's path-required doors", () => {
  test("the deleted mode-hardcoded doors stay deleted, the path-aware doors exist", () => {
    for (const dead of DELETED_DOORS) {
      expect(
        (sourceScan as Record<string, unknown>)[dead],
        `${dead} is the mode-hardcoded path-less door this class closed — do not re-add it; the path-aware forms are the only doors`,
      ).toBeUndefined();
    }
    for (const door of PATH_REQUIRED_DOORS) {
      expect(
        typeof (sourceScan as Record<string, unknown>)[door],
        `${door} is the path-required door the migrated tree calls`,
      ).toBe("function");
    }
    // The DECLARATION, not a runtime artifact: `Function.length` reads 2 for
    // an optional parameter too under strip-types (the `?` is erased and the
    // emitted function keeps both parameters), so a length-based pin was
    // measured VACUOUS by its own mutation — the declaration is the only
    // honest witness that the path is REQUIRED, because an optional path is
    // the template-default trap reopened and the typecheck would accept
    // every 1-argument call again.
    // The comments-only doors are implemented by the VIEW OWNER and
    // re-exported here (one implementation for the engine guards and this
    // suite). The declaration is checked where it lives, so moving the
    // implementation does not weaken the shape: the re-export cannot widen
    // the signature.
    const declarationSources = [
      viewedSourceOf(HELPER_CANONICAL),
      viewedSourceOf(resolve("engine/scripts/verification/source-view.ts")),
    ];
    for (const door of PATH_REQUIRED_DOORS) {
      expect(
        declarationSources.some((source) =>
          new RegExp(`export function ${door}\\(src: string, path: string\\):`).test(source)),
        `${door} must declare its path as REQUIRED — an optional path is the template-default trap reopened`,
      ).toBe(true);
    }
  });

  test("every path-required door call under tests/ names the path (alias-resolved, deny-by-default)", () => {
    const offenders = CENSUS.requiredCalls
      .filter((c) => c.argc < 2)
      .map((c) => `${c.file}:${c.line} — ${c.canonical} called with ${c.argc} argument(s)`);
    expect(
      offenders,
      `a path-less stripper call over file content is the mode-guessing this family removed.\n` +
        `Name the file the content came from — stripCommentsAndStringsFor(src, path) — or, for a\n` +
        `fragment, name the fragment's own mode the same way: For(fragment, "probe.ts"):\n` +
        `${offenders.join("\n")}`,
    ).toEqual([]);
  });

  test("no file imports a deleted door (the named-import enforcement the grep could not do)", () => {
    expect(
      CENSUS.deadImports,
      `these imports name a door that no longer exists; the typecheck refuses them too —\n` +
        `migrate the call to the path-aware form:\n${CENSUS.deadImports.join("\n")}`,
    ).toEqual([]);
  });

  test("no path-required door is cast (a cast is the 1-argument call's way to compile)", () => {
    expect(
      CENSUS.castDoors,
      `a cast strips a door's required-path signature, so the typecheck goes quiet —\n` +
        `call the door as (src, path):\n${CENSUS.castDoors.join("\n")}`,
    ).toEqual([]);
  });

  test("the census saw the tree (a silently empty census is the false-absence shape)", () => {
    // A non-empty, substantial receipt: the migrated tree holds dozens of
    // path-required call sites. If an import-spelling change makes the
    // census understand nothing, this floor reds instead of certifying a
    // false absence.
    expect(TEST_FILES.length, "the tests/ walk must find files").toBeGreaterThan(400);
    expect(
      CENSUS.requiredCalls.length,
      "the census must see the tree's path-required door calls",
    ).toBeGreaterThanOrEqual(30);
  });

  test("a 1-argument fragment door is not handed a direct read of the wrong mode's file", () => {
    const offenders: string[] = [];
    for (const call of CENSUS.fragmentCalls) {
      if (call.argc !== 1) continue;
      const requiredTemplateMode = FRAGMENT_DOOR_MODE.get(call.canonical);
      if (requiredTemplateMode === undefined) continue;
      const src = viewedSourceOf(join(call.file));
      const readRe = /^\s*(?:read|readFileSync)\s*\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\w+)\s*[,)]/;
      const m = readRe.exec(call.argText);
      if (m === null) continue; // not the direct-read shape; the receipt still counts it
      let path: string;
      if (m[1]!.startsWith('"') || m[1]!.startsWith("'")) {
        path = m[1]!.slice(1, -1);
      } else {
        const bound = constStringBindings(src).get(m[1]!);
        if (bound === undefined) continue; // an unreadable binding is not evidence
        path = bound;
      }
      if (isTemplateSource(path) !== requiredTemplateMode) {
        offenders.push(
          `${call.file}:${call.line} — ${call.canonical} hardcodes the ` +
            `${requiredTemplateMode ? "template" : "flat"} walk but was handed ${path} directly; ` +
            `read it through stripCommentsOnlyFor(src, path) so the file names its own mode`,
        );
      }
    }
    expect(
      offenders,
      `the fragment doors keep 1-argument forms for fragments and same-mode populations only:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

describe("the path names the mode (the door dispatches on its argument)", () => {
  const GHOST_SOURCE = [
    "/** export function GHOST_FROM_DOCSTRING() {} */",
    "// export function GHOST_FROM_LINE_COMMENT() {}",
    'const quoted = "export function GHOST_FROM_STRING() {}";',
    "export function REAL_EXPORT() {}",
    "",
  ].join("\n");

  test("the same bytes through two paths give the two views (template prose keeps the ghosts, the .ts code view strips them)", () => {
    const codeView = sourceScan.stripCommentsAndStringsFor(GHOST_SOURCE, "probe.ts");
    expect(codeView, "the .ts view strips the comment/string ghosts").not.toContain("GHOST_FROM_DOCSTRING");
    expect(codeView).not.toContain("GHOST_FROM_STRING");
    expect(codeView, "and keeps the real export").toContain("REAL_EXPORT");
    const templateView = sourceScan.stripCommentsAndStringsFor(GHOST_SOURCE, "probe.svelte");
    expect(templateView, "the template view reads the same bytes as markup prose").toContain(
      "GHOST_FROM_DOCSTRING",
    );
    expect(templateView, "the two views differ — the PATH is what picked the mode").not.toBe(codeView);
  });

  test("the Drop view over .ts is byte-identical to the old flat door's rendering (the no-space contract survives the migration)", () => {
    const sample = 'const a = "s"; /* c */ const b = 2; // t\nconst r = /x(/;\n';
    const oldFlatDoor = renderSpans(sample, false, (kind, text) => (kind === "regex" ? text : ""));
    expect(sourceScan.stripCommentsAndStringsDropFor(sample, "probe.ts"), "byte-identical to the old door").toBe(
      oldFlatDoor,
    );
    expect(sourceScan.stripCommentsAndStringsDropFor(sample, "probe.ts")).not.toContain('"s"');
    expect(sourceScan.stripCommentsAndStringsDropFor('x ="a";y', "probe.ts"), "no space placeholder").toBe("x =;y");
  });

  test("the comments-only view drops an html-comment button in template mode and keeps it in code mode (the pair that motivated the path-aware door)", () => {
    const template = '<!-- <button onclick={go}>planned</button> -->\n<button data-verb-id="x/y">go</button>\n';
    const svelteView = sourceScan.stripCommentsOnlyFor(template, "probe.svelte");
    expect(svelteView, "a comment SPELLING a control is not a rendered control").not.toMatch(
      /<button[^>]*onclick/,
    );
    expect(svelteView, "the real control survives").toContain('data-verb-id="x/y"');
    const codeView = sourceScan.stripCommentsOnlyFor(template, "probe.ts");
    expect(codeView, "the flat walk has no html-comment kind — the OLD false-offender direction, printed").toContain(
      "<button onclick={go}>planned</button>",
    );
  });

  test("the template-mode migration over the real ArtifactFrame.svelte is byte-identical to the old template door's view", () => {
    const FRAME = "src/cockpit/render/ArtifactFrame.svelte";
    // Through the suite's single file-read utility (the utf8 owner), because
    // this arm's subject is the RENDERERS' agreement over the real bytes — a
    // pre-blanked input would prove agreement about views, not about the
    // file — the same reason template-mode-lexing is declared for.
    const raw = sourceScan.read(FRAME);
    // The drop views keep the file's LINES (a4-design H1): a dropped span
    // leaves its newlines, a one-line string or template one space.
    const lines = (text: string) => text.replace(/[^\n]/gu, "");
    const oldTemplateDoor = renderSpans(raw, true, (kind, text) =>
      kind === "string" || kind === "template" ? (text.includes("\n") ? lines(text) : " ") : kind === "regex" ? text : lines(text),
    );
    const view = sourceScan.stripCommentsAndStringsFor(raw, FRAME);
    expect(view).toBe(oldTemplateDoor);
    expect(view.split("\n").length, "every line of the file is still its line").toBe(raw.split("\n").length);
  });
});
