import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  decodeHtmlEntities,
  escapeHtml,
  escapeMarkdownTableCell,
  htmlWithout,
  stripTags,
} from "../../shared/markup.ts";

import { parse as parseSvelte } from "svelte/compiler";
import ts from "typescript5";

/**
 * THE ONE MARKUP OWNER: `shared/markup.ts` does every HTML or Markdown
 * escape, entity decode, tag strip and markup removal in the tree. This file
 * proves both halves: the helper is complete against the shapes CodeQL
 * flagged (alerts 92 and 94-99: double unescaping, a removal that leaves a
 * new opener, `<SCRIPT>`, `</script >`, an unescaped backslash), and no
 * tracked source outside it does any of that by hand.
 *
 * ── STRUCTURAL, NOT PATTERN BY PATTERN ────────────────────────────────────
 *
 * Every source is PARSED with the TypeScript compiler (`typescript5`, the
 * parser the repository's other AST guards use): `.ts`/`.js`/`.mjs`/`.cjs`
 * whole, and each `.svelte` file's `<script>` contents and template
 * expressions as Svelte's own parser locates them. Comments and markup are never code. The rules are about
 * WHAT a call does, whatever its spelling, line wrapping or table:
 * - `entity`: a string or template literal, or a `+` chain folded with every
 *   non-literal operand as a hole, that spells an HTML character reference
 *   (`&amp;`, `&#60;`, `"&" + "amp;"`, `` `&#${code};` ``,
 *   `"&#" + String.fromCodePoint(c) + ";"`). Escaping and decoding are the
 *   owner's; a literal entity in code is a hand-rolled table or chain.
 * - `tag-filter`: a REGEX pattern (the first argument of `replace`,
 *   `replaceAll`, `split`, `match`, `matchAll`, `search`, `RegExp`; the
 *   regex receiver of `test`/`exec`) that opens a markup comment or names an
 *   element a sanitizer must special-case (`script`, `style`, `iframe`,
 *   `pre`, `code`, …), or that BEHAVES as a generic tag matcher: run by the
 *   JavaScript regex engine, it matches unrelated opening tags whole and
 *   none of the same texts without their brackets. Lookbehinds and named
 *   groups are regex syntax, not tags.
 *
 * A pattern is resolved before it is judged: a literal where it stands, a
 * module-level `const` it names, a `RegExp(…)` built from either (with its
 * flags), a template (its holes stand for an element name), and a computed
 * member (`s["replace"]`) is the call it names.
 * - `markup-char`: a `replace`/`replaceAll` whose pattern is only markup
 *   characters (`/&/g`, `"<"`, `/[<>&]/g`): one link of an escape chain.
 * - `cell-escape`: a `replace`/`replaceAll` whose replacement inserts a
 *   backslash before a pipe (a Markdown table-cell escape).
 *
 * NOT covered (needs data flow, Issue #180): a pattern held in a variable,
 * `new RegExp(variable)`, a computed member (`s["replace"]`), an imported
 * table. A CodeQL custom query is the owned follow-up.
 *
 * A legitimate non-markup use is declared in `DECLARED` with its reason.
 * A stale declaration (one that no longer trips the rule) fails.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** The owner, and the one file that proves it (its assertions spell entities). */
const OWNER_FILES = new Set(["shared/markup.ts", "tests/public/markup-owner.test.mjs"]);
const SOURCE = /\.(?:[cm]?[jt]s|svelte)$/u;

const HOLE = "\u0000";
// A character reference, or one built around a hole: `&amp;`, `&#60;`,
// `&#x3c;`, `&${name};`, `&#${code};`, `&#x${hex};`.
const ENTITY = /&(?:[A-Za-z][A-Za-z0-9]{1,31}|#[0-9]+|#[xX][0-9A-Fa-f]+|\u0000);|&#[xX]?[0-9A-Fa-f]*\u0000/u;
const SPECIAL_ELEMENTS = "script|style|iframe|object|embed|svg|math|template|title|textarea|noscript|xmp|plaintext|pre|code|!--";
// Elements a sanitizer must special-case, named in a regex (any case), and
// the markup comment opener. Generic tag classes are judged by behaviour
// below, not by spelling.
const TAG_FILTER = new RegExp(String.raw`<(?:\\?\/)?(?:${SPECIAL_ELEMENTS})|<!--`, "iu");
// A GENERIC tag matcher, by what the regex DOES (the JavaScript regex engine
// is the parser and the judge): it matches at least one of these unrelated
// tags whole (bare, closing, self-closing, upper case, with attributes). `<.*?>`, `<[^>]+>`, `<\/?[a-z][^>]*>` and every other spelling of
// "`<`, a run, `>`" do; a specific element (`<Spark\b[^>]*>`), a generic
// type in source (`fn name<[^>]*>(`) or a bare `<` do not.
const GENERIC_TAG_PROBES = Object.freeze(["<b>", "</b>", "<br/>", "<B>", '<a href="x">', "<div class='y' data-z=1>"]);
// …and depends on the brackets: the same text without them matches nowhere
// (a pattern that eats any run, `[^\r\n]+` or `^[\x20-\x7e]+$`, is not a
// tag matcher).
const BRACKETLESS_CONTROLS = Object.freeze(["b", "/b", "br/", "B", 'a href="x"', "div class='y' data-z=1"]);
function matchesGenericTags(resolved) {
  if (resolved === null || !resolved.regex) return false;
  let pattern;
  try {
    pattern = new RegExp(resolved.text.replaceAll(HOLE, "[a-z]+"), resolved.flags.replace(/[gy]/gu, ""));
  } catch {
    return false;
  }
  // ANY probe matched whole is enough: a partial stripper (only bare tags,
  // only closers, no quoted attributes) is a stripper all the same.
  return GENERIC_TAG_PROBES.some((probe) => pattern.exec(probe)?.[0] === probe)
    && BRACKETLESS_CONTROLS.every((control) => !pattern.test(control));
}
const REGEX_SYNTAX_ANGLES = /\(\?<[=!]|\(\?<[A-Za-z_$][\w$]*>|\\k<[A-Za-z_$][\w$]*>/gu;
// A pattern that is only markup characters: `&`, `<`, `[<>&"']`, `\&`.
// Quotes count inside a class only beside at least one of `<`, `>`, `&`.
const MARKUP_CHARS_ONLY = /^(?:\[\^?(?=[^\]]*[<>&])(?:[<>&"']|\\[<>&"'])+\]|[<>&]|\\[<>&])$/u;
// A decode pattern: `&` then, within one reference's length, `;` (`&(\w+);`,
// `&#(\d+);`, `&([a-z]+|#\d+);`), or `&#` itself.
const ENTITY_PATTERN = /&#|&(?:\\w|\(|\[|[A-Za-z])[^;\s|&]{0,40};/u;
const MARKUP_CHAR = /[<>&]/u;
const TRANSFORMS = new Set(["replace", "replaceAll", "split"]);
const READS = new Set(["match", "matchAll", "search"]);

/**
 * Legitimate non-markup or markup-READING uses, each with its reason. Keyed
 * `path` (the whole file) and checked for staleness: an entry whose file no
 * longer trips a rule is refused.
 */
const DECLARED = new Map([
  ["engine/src/quality/languages/c-cpp/parser.ts", "strips the `<`, `>` and `\"` delimiters of a C `#include` path, which is C syntax, not markup"],
  ["engine/verification/benchmarks/shared/qualification-authority-audit.mjs", "extracts the exact `<!-- authority-claims:v1 BEGIN -->` marker block from a Markdown record; it reads, never sanitizes"],
  ["scripts/floor/site-links.mjs", "reads every tag of the BUILT site to crawl its href/src attributes; it reads, never sanitizes"],
  ["tests/cockpit/cockpit-mouse-path-owner.test.ts", "reads the tags of this repository's own Svelte components to find their pointer controls"],
  ["tests/cockpit/editor-surface-owner.test.ts", "reads the tags of this repository's own Svelte components to find the editor surface"],
  ["engine/src/workflow/reachability.ts", "extracts the `<script>` blocks of this repository's own Svelte sources to follow their imports; it reads, never sanitizes"],
  ["server/safety/artifact-check.ts", "the artifact safety owner locates `<script>` elements of a generated artifact to SYNTAX-CHECK them; it never rewrites or sanitizes the artifact"],
  ["tests/cockpit/rest-visibility-floor.test.ts", "reads the `<style>` block of this repository's own Svelte components"],
  ["tests/cockpit/artifact-runtime-errors.test.ts", "unwraps a fixed `<script>…</script>` fixture string it built itself"],
  ["tests/prevention/template-mode-lexing.test.ts", "locates markup comments in Svelte sources to check the source lexer's spans against them"],
  ["tests/cockpit/artifact-containment.test.ts", "asserts that a generated artifact page still contains its `<iframe>`; it reads, never sanitizes"],
  ["tests/prevention/source-structure-parser-differential.test.ts", "an independent oracle locating `<script>` blocks, compared with the source-structure owner"],
]);

/** The text a literal node carries: a regex's source, a string's value, a template's quasis joined by holes. */
function literalText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isRegularExpressionLiteral(node)) return node.text.slice(1, node.text.lastIndexOf("/"));
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(HOLE);
  return null;
}

const isPlus = (node) => ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken;

/** A `+` chain folded to text, every non-literal operand a hole. */
function folded(node) {
  if (isPlus(node)) return folded(node.left) + folded(node.right);
  if (ts.isParenthesizedExpression(node)) return folded(node.expression);
  return literalText(node) ?? HOLE;
}

/** The name a call invokes: `s.replace`, `s["replace"]`, `RegExp`. */
function calleeName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && literalText(node.argumentExpression) !== null) return literalText(node.argumentExpression);
  return ts.isIdentifier(node) ? node.text : null;
}

/**
 * The initializer of a MODULE-LEVEL `const` of this file (no unwrapping).
 * Module level only: a parameter or a local of the same name elsewhere in
 * the file is a different binding, and scoping it properly is data flow
 * (#180).
 */
function declaredInitializer(name, file) {
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) return declaration.initializer ?? null;
    }
  }
  return null;
}

/**
 * A pattern argument resolved to its text: a literal where it stands, a
 * same-file constant it names, or a `RegExp(…)` built from either (with its
 * flags). Template holes stay holes. `{ regex }` says whether the text is a
 * regular expression (a regex literal or a `RegExp`) or a literal string.
 * Imports, `.call` and runtime-built patterns need data flow (#180).
 */
function resolvePattern(node, file, depth = 0) {
  if (node === undefined || node === null || depth > 4) return null;
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return resolvePattern(node.expression, file, depth + 1);
  if (ts.isRegularExpressionLiteral(node)) return { text: literalText(node), flags: node.text.slice(node.text.lastIndexOf("/") + 1), regex: true };
  const text = literalText(node);
  if (text !== null) return { text, flags: "", regex: false };
  if (ts.isIdentifier(node)) return resolvePattern(declaredInitializer(node.text, file), file, depth + 1);
  if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && calleeName(node.expression) === "RegExp") {
    const inner = resolvePattern(node.arguments?.[0], file, depth + 1);
    if (inner === null) return null;
    const flags = node.arguments?.[1] === undefined ? "" : resolvePattern(node.arguments[1], file, depth + 1)?.text ?? "";
    return { text: inner.text, flags, regex: true };
  }
  return null;
}

/** The initializer of a same-file `const`/`let`/`var`, unwrapped from call wrappers (`Object.freeze(…)`, `deepFreeze(…)`, `new Map(…)`). */
function declaredValue(name, file) {
  let found = null;
  const visit = (node) => {
    if (found !== null) return;
    if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name !== undefined && ts.isIdentifier(node.name) && node.name.text === name) {
      found = ts.isFunctionDeclaration(node) ? node : node.initializer ?? null;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  while (found !== null && (ts.isCallExpression(found) || ts.isNewExpression(found) || ts.isAsExpression(found) || ts.isParenthesizedExpression(found))) {
    found = ts.isAsExpression(found) || ts.isParenthesizedExpression(found) ? found.expression : found.arguments?.[0] ?? null;
  }
  return found;
}

/** Whether a replacement argument is a function: an inline callback, or the name of a same-file function. */
function isReplacer(argument, file) {
  if (ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) return true;
  if (!ts.isIdentifier(argument)) return isPlus(argument);
  const value = declaredValue(argument.text, file);
  return value !== null && (ts.isFunctionDeclaration(value) || ts.isArrowFunction(value) || ts.isFunctionExpression(value));
}

/**
 * Whether a replacement that is not a literal (a callback, a function name)
 * can yield markup: any literal it holds (folded across `+`), or any value in
 * a same-file table it indexes or names, carries `<`, `>`, `&` or an entity.
 */
function callbackYieldsMarkup(argument, file) {
  return callbackTexts(argument, file).some((text) => MARKUP_CHAR.test(text) || ENTITY.test(text));
}

/** Every literal text a replacement function holds or reads from a same-file table. */
function callbackTexts(argument, file) {
  const seen = new Set();
  const texts = [];
  const collect = (node) => {
    if (node === null || node === undefined || seen.has(node)) return;
    seen.add(node);
    if (isPlus(node)) texts.push(folded(node));
    else if (literalText(node) !== null && !ts.isRegularExpressionLiteral(node)) texts.push(literalText(node));
    if (ts.isIdentifier(node) && !(node.parent !== undefined && ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)) {
      const value = declaredValue(node.text, file);
      if (value !== null && value !== argument) collect(value);
    }
    ts.forEachChild(node, collect);
  };
  collect(argument);
  return texts;
}

/** The violations of one parsed program, each `path:line rule`. */
function programViolations(path, code, lineOffsetOf) {
  const file = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true, /\.[cm]?ts$/u.test(path) ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const found = [];
  const report = (node, rule) => found.push(`${path}:${String(lineOffsetOf(file.getLineAndCharacterOfPosition(node.getStart(file)).line))} ${rule}`);
  const visit = (node) => {
    const outermostPlus = isPlus(node) && !(node.parent !== undefined && isPlus(node.parent));
    const standaloneLiteral = literalText(node) !== null && !(node.parent !== undefined && isPlus(node.parent)) && !ts.isRegularExpressionLiteral(node);
    if (outermostPlus || standaloneLiteral) {
      const text = outermostPlus ? folded(node) : literalText(node);
      if (ENTITY.test(text)) report(node, "entity (use escapeHtml / decodeHtmlEntities)");
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const name = calleeName(node.expression);
      const args = node.arguments ?? [];
      let resolved = null;
      if (name !== null && (TRANSFORMS.has(name) || READS.has(name))) resolved = resolvePattern(args[0], file);
      if (name === "RegExp") resolved = resolvePattern(node, file);
      if ((name === "test" || name === "exec") && (ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression))) {
        resolved = resolvePattern(node.expression.expression, file);
      }
      const pattern = resolved?.text ?? null;
      if (resolved?.regex === true && (TAG_FILTER.test(pattern.replace(REGEX_SYNTAX_ANGLES, "")) || matchesGenericTags(resolved))) {
        report(node, "tag-filter (use htmlWithout / stripTags)");
      }
      if ((name === "replace" || name === "replaceAll") && pattern !== null && MARKUP_CHARS_ONLY.test(pattern)) report(node, "markup-char (use escapeHtml)");
      if (name !== null && (TRANSFORMS.has(name) || READS.has(name) || name === "RegExp" || name === "test" || name === "exec") && pattern !== null && ENTITY_PATTERN.test(pattern)) {
        report(node, "entity-pattern (use decodeHtmlEntities)");
      }
      const replacement = (name === "replace" || name === "replaceAll") && args[1] !== undefined ? literalText(args[1]) : null;
      if (replacement !== null && /\\\|/u.test(replacement)) report(node, "cell-escape (use escapeMarkdownTableCell)");
      // The callback form: a pattern that matches a pipe, replaced by a
      // function (or a `+` chain) that yields a backslash.
      if ((name === "replace" || name === "replaceAll") && pattern !== null && /\\\||\[[^\]]*\|[^\]]*\]|^\|$/u.test(pattern) && args[1] !== undefined && replacement === null
        && isReplacer(args[1], file) && callbackTexts(args[1], file).some((text) => text.includes("\\"))) {
        report(node, "cell-escape (use escapeMarkdownTableCell)");
      }
      if ((name === "replace" || name === "replaceAll") && args[1] !== undefined && replacement === null && isReplacer(args[1], file) && callbackYieldsMarkup(args[1], file)) {
        report(node, "markup-callback (use escapeHtml / decodeHtmlEntities)");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/**
 * The programs inside one Svelte file, located by Svelte's own parser
 * (`svelte/compiler`, the compiler the cockpit builds with): the instance
 * and module `<script>` contents as one program each, and every template
 * expression (a `{…}` tag, an attribute or directive value, an `{#if}` test,
 * an `{#each}`/`{#await}`/`{#key}` expression) as its own. Each keeps its
 * file line. A file Svelte cannot parse is unreadable, never clean.
 */
function sveltePrograms(path, text) {
  let ast;
  try {
    ast = parseSvelte(text, { modern: true });
  } catch (error) {
    return { programs: [], unreadable: [`${path}:1 unreadable: Svelte could not parse it (${String(error?.message ?? error).split("\n")[0]})`] };
  }
  const lineOf = (offset) => text.slice(0, offset).split("\n").length - 1;
  const programs = [];
  for (const script of [ast.instance, ast.module]) {
    if (script?.content !== undefined) programs.push({ code: text.slice(script.content.start, script.content.end), base: lineOf(script.content.start) });
  }
  const walk = (node, key) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, key);
      return;
    }
    if ((key === "expression" || key === "test" || key === "key") && typeof node.type === "string" && typeof node.start === "number") {
      programs.push({ code: `(${text.slice(node.start, node.end)}\n)`, base: lineOf(node.start) });
      return;
    }
    for (const [child, value] of Object.entries(node)) if (child !== "metadata" && child !== "parent") walk(value, child);
  };
  walk(ast.fragment, "fragment");
  return { programs, unreadable: [] };
}

/** The violations of one tracked source file. */
function violations(path, text) {
  if (OWNER_FILES.has(path)) return [];
  if (!path.endsWith(".svelte")) return programViolations(path, text, (line) => line + 1);
  const { programs, unreadable } = sveltePrograms(path, text);
  return [...unreadable, ...programs.flatMap(({ code, base }) => programViolations(`${path.slice(0, -".svelte".length)}.svelte.ts`, code, (line) => base + line + 1)
    .map((violation) => violation.replace(".svelte.ts:", ".svelte:")))];
}

function trackedSources() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter((path) => SOURCE.test(path));
}

test("no tracked source outside the owner hand-rolls an escape, decode, strip or tag filter", () => {
  const files = trackedSources();
  assert.ok(files.length > 1000, `git ls-files found only ${String(files.length)} source files`);
  for (const folder of ["engine/src/", "server/", "src/", "scripts/", "tests/", "shared/"]) {
    assert.ok(files.some((path) => path.startsWith(folder)), `the scan reached nothing under ${folder}`);
  }
  assert.ok(files.some((path) => path.endsWith(".svelte")), "the scan reached no Svelte file");
  const found = new Map(files.map((path) => [path, violations(path, readFileSync(join(ROOT, path), "utf8"))]));
  const undeclared = [...found].filter(([path, list]) => list.length > 0 && !DECLARED.has(path)).flatMap(([, list]) => list);
  assert.deepEqual(undeclared, []);
  const stale = [...DECLARED.keys()].filter((path) => (found.get(path) ?? []).length === 0);
  assert.deepEqual(stale, [], "a declaration whose file no longer trips the guard is stale: delete it");
});

test("planted hand-rolled markup work is refused in every shape and folder", () => {
  const planted = {
    // concatenated entities and a lookup table
    "server/a.ts": 'const AMP = "&" + "amp;";\nconst TABLE = { "<": "&" + "lt" + ";" };\n',
    // numeric-reference encoders, template and concatenation
    "src/b.ts": "const encode = (c: string) => `&#${c.codePointAt(0)};`;\nconst encode2 = (c: number) => \"&#\" + String.fromCharCode(c) + \";\";\n",
    // a tag stripper with a name class, wrapped over lines
    "scripts/c.mjs": "const plain = html.replace(\n  /<\\/?[a-z][^>]*>/gi,\n  \"\",\n);\n",
    // <pre> removal and a split-based script remover
    "engine/src/d.ts": 'const body = html.replaceAll(/<PRE\\b[^]*?<\\/pre>/gi, "");\nconst parts = html.split(/<script/i);\n',
    // a pipe-only cell escape
    "scripts/floor/e.ts": 'const cell = (value: string) => value.replace(/\\|/g, "\\\\|");\n',
    // one link of an escape chain, and a decoder through RegExp
    "shared/f.ts": 'const step = text.replace(/&/g, AMP);\nconst entity = new RegExp("<!--[\\\\s\\\\S]*?-->", "g");\n',
    // a tag filter as the receiver of test, and a tag strip in a Svelte script and template
    "tests/g.test.ts": "const dangerous = /<iframe/i.test(html);\n",
    // the callback forms: a lookup table, an inline callback, a named encoder, a decoder
    "server/i.ts": 'const MAP = Object.freeze({ "<": "&" + "lt;", ">": "&" + "gt;" });\nconst a = s.replace(/[<>"]/g, (c) => MAP[c]);\nconst b = s.replace(/[^\\w ]/g, (c) => "&#" + c.charCodeAt(0) + ";");\nfunction enc(c: string) { return "&" + "amp;"; }\nconst d = s.replace(/x/g, enc);\nconst DECODE = { amp: "&", lt: "<" };\nconst e = s.replace(/&(\\w+);/g, (_m, n) => DECODE[n]);\n',
    // the three cheap gaps: a callback cell escape, generic strippers, a hex encoder
    "scripts/j.mjs": 'const cell = value.replace(/\\|/g, (pipe) => "\\\\" + pipe);\nconst a = html.replace(/<.*?>/g, "");\nconst b = html.replaceAll(/<[\\s\\S]+?>/g, " ");\nconst hex = (c) => "&#x" + c.codePointAt(0).toString(16) + ";";\nconst hex2 = (c) => `&#x${c.toString(16)};`;\n',
    // six generic stripper spellings, each judged by behaviour
    "server/k.ts": [
      'const a = s.replace(/<[^>]*>/g, "");',
      'const b = s.replace(/<.*?>/g, "");',
      'const c = s.replace(/<[\\s\\S]+?>/g, "");',
      'const d = s.replace(/<\\/?[a-z][^>]*>/gi, "");',
      'const e = s.replace(/<[^<>]+>/g, "");',
      'const f = s.replace(/<(?:[^>"\']|"[^"]*"|\'[^\']*\')*>/g, "");',
    ].join("\n") + "\n",
    // seven PARTIAL strippers: each misses some tag shape, and each is still a stripper
    "server/m.ts": [
      'const a = s.replace(/<\\/?\\w+>/g, "");',
      'const b = s.replace(/<\\S+?>/g, "");',
      'const c = s.replace(/<[^>"]*>/g, "");',
      'const d = s.replace(/<[^>]{1,20}>/g, "");',
      'const e = s.replace(/<[^>=]*>/g, "");',
      'const f = s.replace(/<[a-z/]+>/g, "");',
      'const g = s.replace(/<[A-Z][^>]*>/g, "");',
    ].join("\n") + "\n",
    // the pattern through a module constant, RegExp(const), a template hole and a computed member
    "server/l.ts": [
      "const TAG = /<[^>]+>/g;",
      'const TAG_SOURCE = "<[^>]*>";',
      'const plain = s.replace(TAG, "");',
      'const built = s.replace(new RegExp(TAG_SOURCE, "g"), "");',
      'const opener = (name: string) => s.replace(new RegExp(`<${name}[^>]*>`, "g"), "");',
      'const computed = s["replace"](/<.*?>/g, "");',
    ].join("\n") + "\n",
    "src/h.svelte": "<script>\n  const plain = html.replace(/<[^>]+>/g, \"\");\n</script>\n<p>{text.replaceAll(\"&\", \"&\" + \"amp;\")}</p>\n<p>a&nbsp;b</p>\n",
  };
  const found = Object.fromEntries(Object.entries(planted).map(([path, text]) => [path, violations(path, text)]));
  const rules = Object.fromEntries(Object.entries(found).map(([path, list]) => [path, list.map((line) => line.split(" ")[1])]));
  assert.deepEqual(rules, {
    "server/a.ts": ["entity", "entity"],
    "src/b.ts": ["entity", "entity"],
    "scripts/c.mjs": ["tag-filter"],
    "engine/src/d.ts": ["tag-filter", "tag-filter"],
    "scripts/floor/e.ts": ["cell-escape"],
    "shared/f.ts": ["markup-char", "tag-filter"],
    "tests/g.test.ts": ["tag-filter"],
    "server/i.ts": ["entity", "entity", "markup-char", "markup-callback", "markup-callback", "entity", "entity", "markup-callback", "entity-pattern", "markup-callback"],
    "scripts/j.mjs": ["cell-escape", "tag-filter", "tag-filter", "entity", "entity"],
    "server/k.ts": ["tag-filter", "tag-filter", "tag-filter", "tag-filter", "tag-filter", "tag-filter"],
    "server/m.ts": ["tag-filter", "tag-filter", "tag-filter", "tag-filter", "tag-filter", "tag-filter", "tag-filter"],
    // `new RegExp(…)` is judged as a call of its own, then again as the replace pattern it feeds
    "server/l.ts": ["tag-filter", "tag-filter", "tag-filter", "tag-filter", "tag-filter", "tag-filter"],
    "src/h.svelte": ["tag-filter", "markup-char", "markup-callback", "entity"],
  }, JSON.stringify(found));
  assert.match(found["scripts/c.mjs"][0], /^scripts\/c\.mjs:1 /u, "a wrapped call is reported at its start");
  assert.match(found["src/h.svelte"][0], /^src\/h\.svelte:2 /u, "a Svelte script keeps its file lines");
  assert.match(found["src/h.svelte"][3], /^src\/h\.svelte:4 /u, "a Svelte template expression keeps its file line");
});

test("near misses are not flagged", () => {
  const nearMisses = {
    "a.ts": [
      'const query = `?path=${path}&root=${root}`;',
      'const pairs = search.split("&").map((pair) => pair.split("="));',
      'const both = a && b;',
      'const pattern = /(?<![\\w$.])(?<name>catch)\\k<name>(?![\\w$])/u;',
      'const generic = source.match(/Promise<void> \\{/);',
      'const component = source.match(/<Spark\\b[^>]*>/);',
      'const rust = "fn parse(id: &str) -> &str";',
      'const escaped = value.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&");',
      'const sql = "a & b";',
      'const upper = name.replace(/(^|-)(\\w)/g, (_m, sep, c) => c.toUpperCase());',
      'const LABELS = { ok: "fine", bad: "broken" };',
      'const label = code.replace(/\\w+/g, (word) => LABELS[word] ?? word);',
      'const generic = type.replace(/T/g, () => "U");',
      'const MARKER = "<redacted>";',
      'const masked = text.replace(/[^\\r\\n]+/gu, MARKER);',
      'const segments = command.split(/&&|\\|\\||[;\\n]/u);',
      'const arrow = code.replace(/=>/g, "->");',
      'const anyRun = text.replace(/[^\\r\\n]+/gu, "*");',
      'const printable = /^[\\x20-\\x7e]+$/u.test(key);',
      'const typeArgs = source.match(/fn\\s+(\\w+)\\s*(<[^>]*>)?\\s*\\(/);',
      'const generics = type.match(/Array<\\w+>/);',
      'const pipes = table.split(/\\|/).map((cell) => cell.trim());',
      '// html.replace(/<script[\\s\\S]*?<\\/script>/g, "") is what the owner replaced',
    ].join("\n"),
    "b.svelte": "<script>\n  const x = 1;\n</script>\n<p>a&nbsp;b &lt;tag&gt; {x}</p>\n<!-- a <script> in a comment -->\n",
  };
  assert.deepEqual(Object.entries(nearMisses).flatMap(([path, text]) => violations(path, text)), []);
});

test("escapeHtml escapes the five characters in one pass", () => {
  assert.equal(escapeHtml(`<a href="x" title='y'>&amp;</a>`), "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;amp;&lt;/a&gt;");
  assert.equal(escapeHtml("plain"), "plain");
  assert.equal(decodeHtmlEntities(escapeHtml(`<&"'>&lt;`)), `<&"'>&lt;`, "decode inverts escape exactly once");
});

test("decodeHtmlEntities decodes once, never twice (alert 98)", () => {
  assert.equal(decodeHtmlEntities("&amp;lt;script&amp;gt;"), "&lt;script&gt;");
  assert.equal(decodeHtmlEntities("a&amp;b &quot;q&quot; &#39;s&apos; &lt;&gt;"), `a&b "q" 's' <>`);
  assert.equal(decodeHtmlEntities("&#60;&#x3C;&#X3c;"), "<<<");
  assert.equal(decodeHtmlEntities("&nbsp; &unknown; &amp &#0; &#xD800; &#1114112;"), "&nbsp; &unknown; &amp &#0; &#xD800; &#1114112;");
});

test("escapeMarkdownTableCell escapes the backslash with the pipe (alert 97)", () => {
  assert.equal(escapeMarkdownTableCell("a|b"), "a\\|b");
  assert.equal(escapeMarkdownTableCell("a\\|b"), "a\\\\\\|b", "a backslash before a pipe can no longer cancel its escape");
  assert.equal(escapeMarkdownTableCell("C:\\path"), "C:\\\\path");
});

test("stripTags removes tags to a fixed point (alert 92)", () => {
  assert.equal(stripTags("Plan <em>one</em>"), "Plan one");
  assert.equal(stripTags("<<b>script>alert(1)<</b>/script>"), "alert(1)");
  assert.equal(stripTags("<scr<b>ipt>x"), "x");
  assert.equal(stripTags("a < b > c"), "a  c");
  assert.equal(stripTags("1 < 2"), "1 < 2");
});

test("htmlWithout removes comments and elements without joining their sides (alerts 94-96, 99)", () => {
  assert.equal(htmlWithout("a<!-- x -->b", { comments: true }), "a b");
  assert.equal(htmlWithout("<!<!-- x -->-- y -->", { comments: true }), "<! -- y -->", "no new comment opener forms");
  assert.equal(htmlWithout("<scr<!-- x -->ipt>z", { comments: true }), "<scr ipt>z", "no new script opener forms");
  assert.equal(htmlWithout("a<!-- unclosed", { comments: true }), "a ");
  const elements = { elements: ["script", "style", "pre", "code"] };
  assert.equal(htmlWithout("x<SCRIPT>bad()</SCRIPT >y", elements), "x y");
  assert.equal(htmlWithout("x<script type=module>bad()</script\n>y", elements), "x y");
  assert.equal(htmlWithout("x<style>.a{}</style>y<pre><b>t</b></pre>z<code>c</code>w", elements), "x y z w");
  assert.equal(htmlWithout("x<script>never closed", elements), "x ");
  assert.equal(htmlWithout("<codex>k</codex><prefix>p</prefix>", elements), "<codex>k</codex><prefix>p</prefix>", "a longer tag name is not the element");
  assert.equal(htmlWithout("<scr<script>x</script>ipt>bad()</script>", elements), "<scr ipt>bad()</script>");
  assert.equal(htmlWithout("a<!-- <script> -->b<script><!-- --></script>c", { comments: true, ...elements }), "a b c");
  assert.equal(htmlWithout("no markup", { comments: true }), "no markup");
});
