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

/**
 * THE ONE MARKUP OWNER: `shared/markup.ts` does every HTML or Markdown
 * escape, entity decode and markup removal in the tree, and this file proves
 * both halves: the helper is complete against the shapes CodeQL flagged
 * (alerts 92 and 94-99: double unescaping, a removal that leaves a new
 * opener, `<SCRIPT>`, `</script >`, an unescaped backslash), and no tracked
 * source file outside it hand-rolls one of those chains again.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** The owner, and the one file that proves it (its assertions spell entities). */
const OWNER_FILES = new Set(["shared/markup.ts", "tests/public/markup-owner.test.mjs"]);
const SOURCE = /\.(?:[cm]?[jt]s|svelte|html?)$/u;

/**
 * THE RULES, read through the ONE source lexer (`source-view.ts`), so a
 * comment that names a shape and the markup of a Svelte template are never
 * code, and a literal is judged whatever call it sits in (`replace`,
 * `replaceAll`, `split`/`join`, `new RegExp`, a lookup table, a wrapped
 * multi-line call):
 * - `entity-literal`: an HTML character reference inside a string, template
 *   or regex literal. Escaping and decoding are the owner's; a literal entity
 *   in code is a hand-rolled table or chain.
 * - `tag-stripper`: a literal whose WHOLE pattern is a bare tag matcher
 *   (`<[^>]*>`, `<[^>]+>`, `<[^<>]*>`, `</?[^>]+>`, any quantifier). Embedded
 *   in a larger grammar (`fn name<[^>]*>(`) it matches, and is not a stripper.
 * - `markup-removal`: a `replace`, `replaceAll` or `split` whose pattern
 *   literal opens with `<!--`, `<script` or `<style` (any case) and spans
 *   on (`[\s\S]`, `[^]`, `.*`, `.+`). Extraction and tokenizing
 *   (`matchAll`, `exec`, a sticky token rule) are not removal, and neither
 *   is replacing one exact marker string.
 */
const ENTITY = /&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#[xX][0-9a-fA-F]+);/u;
const BARE_TAG_MATCHER = /^<\\?\/?\??\[\^<?>\][*+]?\??>$/u;
const REMOVAL_CALL = /\.(?:replace|replaceAll|split)\(\s*$/u;
const REMOVAL_OPENER = /^(?:<!--|<script|<style)/iu;
const ANY_SPAN = /\[\\s\\S\]|\[\^\]|\.[*+]/u;

const { isTemplateSource, lexSpans } = await import("../../engine/scripts/verification/source-view.ts");

/** A literal span's pattern text: a regex's source, a string's or template's interior. */
function literalBody(text, kind) {
  if (kind === "regex") return text.slice(1, text.lastIndexOf("/"));
  return text.slice(1, -1);
}

/** The violations of one file's text, each as `path:line rule (remedy)`. */
function violations(path, text) {
  if (OWNER_FILES.has(path)) return [];
  const found = [];
  const lineOf = (index) => text.slice(0, index).split("\n").length;
  for (const span of lexSpans(text, isTemplateSource(path))) {
    if (span.kind !== "string" && span.kind !== "template" && span.kind !== "regex") continue;
    const body = literalBody(text.slice(span.start, span.end), span.kind);
    const at = `${path}:${String(lineOf(span.start))}`;
    if (ENTITY.test(body)) found.push(`${at} entity-literal (use escapeHtml / decodeHtmlEntities)`);
    if (BARE_TAG_MATCHER.test(body)) found.push(`${at} tag-stripper (use stripTags / htmlWithout)`);
    if (REMOVAL_OPENER.test(body) && ANY_SPAN.test(body) && REMOVAL_CALL.test(text.slice(Math.max(0, span.start - 200), span.start))) {
      found.push(`${at} markup-removal (use htmlWithout)`);
    }
  }
  return found;
}

function trackedSources() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter((path) => SOURCE.test(path));
}

test("no tracked source file outside the owner hand-rolls an escape, decode or removal", () => {
  const files = trackedSources();
  assert.ok(files.length > 1000, `git ls-files found only ${String(files.length)} source files`);
  for (const folder of ["engine/src/", "server/", "src/", "scripts/", "tests/", "shared/"]) {
    assert.ok(files.some((path) => path.startsWith(folder)), `the scan reached nothing under ${folder}`);
  }
  assert.deepEqual(files.flatMap((path) => violations(path, readFileSync(join(ROOT, path), "utf8"))), []);
});

test("planted hand-rolled chains are refused in every shape and folder", () => {
  // Each entity is assembled here, so this file's own literals stay clean.
  const amp = "&" + "amp;";
  const lt = "&" + "lt;";
  const planted = {
    "scripts/floor/a.mjs": `value\n    .replace(/${amp}/gu, "&")\n    .replace(/${lt}/gu, "<");\n`,
    "server/b.ts": `const safe = text.replaceAll("&", "${amp}").split("<").join('${lt}');\n`,
    "server/c.ts": `const TABLE = {\n  "&": "${amp}",\n  "<": \`${lt}\`,\n};\n`,
    "src/d.svelte": `<script>\n  const plain = html.replace(\n    /<!` + `--[\\s\\S]*?-->/g,\n    "",\n  );\n</script>\n<p>a&nbsp;b</p>\n`,
    "engine/src/e.ts": `const body = html.replaceAll(/<SCR` + `IPT\\b[^]*?<\\/script>/gi, "");\n`,
    "tests/f.test.ts": `const slug = heading.replace(new RegExp("<[^>]+>", "g"), "");\nconst tags = /<\\/?[^>]*>/g;\n`,
    "shared/g.ts": `const parts = html.split(/<style[\\s\\S]*?<\\/style>/i);\n`,
  };
  const found = Object.fromEntries(Object.entries(planted).map(([path, text]) => [path, violations(path, text)]));
  const counts = Object.fromEntries(Object.entries(found).map(([path, list]) => [path, list.length]));
  assert.deepEqual(counts, {
    "scripts/floor/a.mjs": 2,
    "server/b.ts": 2,
    "server/c.ts": 2,
    "src/d.svelte": 1,
    "engine/src/e.ts": 1,
    "tests/f.test.ts": 2,
    "shared/g.ts": 1,
  }, JSON.stringify(found));
  assert.match(found["scripts/floor/a.mjs"][0], /a\.mjs:2 entity-literal/u);
  assert.match(found["server/c.ts"][1], /c\.ts:3 entity-literal/u);
  assert.match(found["src/d.svelte"][0], /d\.svelte:3 markup-removal/u, "a wrapped call is judged at its literal's line; markup &nbsp; is not code");
  assert.match(found["tests/f.test.ts"][0], /f\.test\.ts:1 tag-stripper/u);
});

test("near misses are not flagged", () => {
  const nearMisses = {
    "a.ts": `const body = wrapper.replace(/^<script>/, "").replace(/<\\/script>$/, "");\n`,
    "b.ts": `const nav = html.replace(/<nav class="breadcrumb"[\\s\\S]*?<\\/nav>/u, "");\n`,
    "c.ts": `/**\n * A denylist loses to \`${"&" + "#106;"}avascript:\`, and six scanners grew \`.replace(/<!` + `--…/\`.\n */\n// x.replace(/${"&" + "amp;"}/g, "&")\n`,
    "d.ts": `const FN = /fn\\s+(\\w+)\\s*(<[^>]*>)?\\s*\\(/;\nconst blocks = src.matchAll(/<script\\b[^>]*>([\\s\\S]*?)<\\/script>/gi);\nconst rule = { kind: "comment", re: /<!` + `--[\\s\\S]*?(?:-->|$)/y };\n`,
    "f.ts": `const missing = page.replace("<!` + `-- ROADMAP-PLAN-BEGIN", "<!` + `-- plan removed");\n`,
    "e.svelte": `<p>a&nbsp;b &lt;tag&gt;</p>\n<script>const x = 1;</script>\n`,
    "shared/markup.ts": `x.replace(/${"&" + "amp;"}/g, "&");\n`,
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
