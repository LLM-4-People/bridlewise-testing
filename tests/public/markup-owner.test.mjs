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
 * whole, and each `.svelte` file's `<script>` blocks and `{…}` template
 * expressions. Comments and markup are never code. The rules are about
 * WHAT a call does, whatever its spelling, line wrapping or table:
 * - `entity`: a string or template literal, or a `+` chain folded with every
 *   non-literal operand as a hole, that spells an HTML character reference
 *   (`&amp;`, `&#60;`, `"&" + "amp;"`, `` `&#${code};` ``,
 *   `"&#" + String.fromCodePoint(c) + ";"`). Escaping and decoding are the
 *   owner's; a literal entity in code is a hand-rolled table or chain.
 * - `tag-filter`: a pattern (the first argument of `replace`, `replaceAll`,
 *   `split`, `match`, `matchAll`, `search`, `RegExp`; the regex receiver of
 *   `test`/`exec`) that opens a markup comment, names an element whose
 *   content an HTML sanitizer must special-case (`script`, `style`,
 *   `iframe`, `pre`, `code`, …), or is a generic tag class (`<[^>]…`,
 *   `<\/?[a-z]…`). Lookbehinds and named groups are regex syntax, not tags.
 * - `markup-char`: a `replace`/`replaceAll` whose pattern is only markup
 *   characters (`/&/g`, `"<"`, `/[<>&]/g`): one link of an escape chain.
 * - `cell-escape`: a `replace`/`replaceAll` whose replacement inserts a
 *   backslash before a pipe (a Markdown table-cell escape).
 *
 * A legitimate non-markup use is declared in `DECLARED` with its reason.
 * A stale declaration (one that no longer trips the rule) fails.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** The owner, and the one file that proves it (its assertions spell entities). */
const OWNER_FILES = new Set(["shared/markup.ts", "tests/public/markup-owner.test.mjs"]);
const SOURCE = /\.(?:[cm]?[jt]s|svelte)$/u;

const HOLE = "\u0000";
const ENTITY = /&(?:[A-Za-z][A-Za-z0-9]{1,31}|#[0-9]+|#[xX][0-9A-Fa-f]+|\u0000);|&#\u0000/u;
const SPECIAL_ELEMENTS = "script|style|iframe|object|embed|svg|math|template|title|textarea|noscript|xmp|plaintext|pre|code|!--";
const TAG_FILTER = new RegExp(String.raw`<(?:\\?\/)?(?:${SPECIAL_ELEMENTS})|<!--|<(?:\\?\/)?\??\[|<(?:\\?\/)?\(\?:`, "iu");
const REGEX_SYNTAX_ANGLES = /\(\?<[=!]|\(\?<[A-Za-z_$][\w$]*>|\\k<[A-Za-z_$][\w$]*>/gu;
const MARKUP_CHARS_ONLY = /^(?:\[\^?(?:[<>&]|\\[<>&])+\]|[<>&]|\\[<>&])$/u;
const TRANSFORMS = new Set(["replace", "replaceAll", "split"]);
const READS = new Set(["match", "matchAll", "search"]);

/**
 * Legitimate non-markup or markup-READING uses, each with its reason. Keyed
 * `path` (the whole file) and checked for staleness: an entry whose file no
 * longer trips a rule is refused.
 */
const DECLARED = new Map([
  ["engine/src/workflow/reachability.ts", "extracts the `<script>` blocks of this repository's own Svelte sources to follow their imports; it reads, never sanitizes"],
  ["engine/src/shared/source-structure.ts", "the source-structure owner locates `<script>` blocks of Svelte sources for its parser; it reads, never sanitizes"],
  ["server/safety/artifact-check.ts", "the artifact safety owner locates `<script>` elements of a generated artifact to SYNTAX-CHECK them; it never rewrites or sanitizes the artifact"],
  ["tests/cockpit/rest-visibility-floor.test.ts", "reads the `<style>` block of this repository's own Svelte components"],
  ["tests/cockpit/artifact-runtime-errors.test.ts", "unwraps a fixed `<script>…</script>` fixture string it built itself"],
  ["tests/cockpit/index-rail-owner.test.ts", "plants a component edit inside the `</style>` of a fixture copy"],
  ["tests/prevention/template-mode-lexing.test.ts", "locates markup comments in Svelte sources to check the source lexer's spans against them"],
  ["tests/cockpit/artifact-containment.test.ts", "asserts that a generated artifact page still contains its `<iframe>`; it reads, never sanitizes"],
  ["tests/cockpit/flow-past-view-owner.test.ts", "matches a TypeScript call's generic type arguments (`fetchJson<…>(`) in source, not markup"],
  ["tests/prevention/roadmap-status-owner.test.ts", "removes one exact `<!-- ROADMAP-PLAN-BEGIN` marker from a copy of the page to plant a missing block"],
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

const calleeName = (node) => (ts.isPropertyAccessExpression(node) ? node.name.text : ts.isIdentifier(node) ? node.text : null);

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
      let pattern = null;
      if (name !== null && (TRANSFORMS.has(name) || READS.has(name) || name === "RegExp")) pattern = args[0] === undefined ? null : literalText(args[0]);
      if ((name === "test" || name === "exec") && ts.isPropertyAccessExpression(node.expression)) pattern = literalText(node.expression.expression);
      if (pattern !== null && TAG_FILTER.test(pattern.replace(REGEX_SYNTAX_ANGLES, ""))) report(node, "tag-filter (use htmlWithout / stripTags)");
      if ((name === "replace" || name === "replaceAll") && pattern !== null && MARKUP_CHARS_ONLY.test(pattern)) report(node, "markup-char (use escapeHtml)");
      const replacement = (name === "replace" || name === "replaceAll") && args[1] !== undefined ? literalText(args[1]) : null;
      if (replacement !== null && /\\\|/u.test(replacement)) report(node, "cell-escape (use escapeMarkdownTableCell)");
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/**
 * The programs inside one Svelte file: each `<script>` block as one program
 * (other text blanked, so lines stay true), and each `{…}` template
 * expression as its own (block keywords such as `#if`, `:else if`, `@html`,
 * `#each … as` are not expression text).
 */
function sveltePrograms(text) {
  const programs = [];
  const lower = text.toLowerCase();
  const markup = text.split("");
  let at = 0;
  for (;;) {
    const open = lower.indexOf("<script", at);
    if (open === -1) break;
    const bodyStart = lower.indexOf(">", open) + 1;
    const close = lower.indexOf("</script", bodyStart);
    const bodyEnd = close === -1 ? text.length : close;
    programs.push({ code: text.slice(0, bodyStart).replace(/[^\n]/gu, " ") + text.slice(bodyStart, bodyEnd), base: 0 });
    for (let index = open; index < bodyEnd; index += 1) if (markup[index] !== "\n") markup[index] = " ";
    at = bodyEnd;
  }
  const rest = markup.join("");
  for (let index = rest.indexOf("{"); index !== -1; index = rest.indexOf("{", index + 1)) {
    let depth = 0;
    let end = index;
    for (; end < rest.length; end += 1) {
      if (rest[end] === "{") depth += 1;
      else if (rest[end] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const inner = rest.slice(index + 1, end).replace(/^\s*(?:[#:@/][a-z]+(?:\s+if)?)/u, "").replace(/\s+as\s+[\s\S]*$/u, "");
    programs.push({ code: `(${inner}\n)`, base: rest.slice(0, index).split("\n").length - 1 });
    index = end;
  }
  return programs;
}

/** The violations of one tracked source file. */
function violations(path, text) {
  if (OWNER_FILES.has(path)) return [];
  if (!path.endsWith(".svelte")) return programViolations(path, text, (line) => line + 1);
  return sveltePrograms(text).flatMap(({ code, base }) => programViolations(`${path.slice(0, -".svelte".length)}.svelte.ts`, code, (line) => base + line + 1)
    .map((violation) => violation.replace(".svelte.ts:", ".svelte:")));
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
    "src/h.svelte": ["tag-filter", "markup-char", "entity"],
  }, JSON.stringify(found));
  assert.match(found["scripts/c.mjs"][0], /^scripts\/c\.mjs:1 /u, "a wrapped call is reported at its start");
  assert.match(found["src/h.svelte"][0], /^src\/h\.svelte:2 /u, "a Svelte script keeps its file lines");
  assert.match(found["src/h.svelte"][2], /^src\/h\.svelte:4 /u, "a Svelte template expression keeps its file line");
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
