/**
 * THE SITE'S STYLE GUARD: every stylesheet the site build consumes reads the
 * one design system (`src/cockpit/tokens.css`) and declares none of its own.
 *
 * This is the fast static half. The rendered pages are judged by the shared
 * rendered-site checker (computed styles, faces and requests; #409).
 *
 * `siteStylesheets` lists what the build consumes: every stylesheet in the
 * Jekyll source the builder assembled (`site.mjs` `buildSiteSource`), which
 * Jekyll either copies (`.css`) or compiles (`.scss`, `.sass`, including the
 * `_sass/` partials a front-mattered sheet imports). The generated token sheet
 * is the owner's own projection and is judged by its generator.
 *
 * `siteStyleViolations` parses a sheet with a real CSS parser (css-tree) and
 * refuses, by node, never by pattern, every name read as CSS reads it
 * (escapes decoded, case folded):
 *
 * - a parse error, or braces that do not balance (a sheet the parser cannot
 *   read whole cannot be judged);
 * - a theme block (`:root`, `[data-theme]`, `[data-cockpit-theme]`): the
 *   themes live in the owner;
 * - a custom property, `@property` or `@font-face` declared here: tokens and
 *   faces are declared once, in the owner;
 * - any `@import` (a sheet is linked by the layout, never chained: a chained
 *   fetch delays the first paint, and a remote one is a second source);
 * - an at-rule outside the closed list below;
 * - a colour literal anywhere in a value: a hex, a colour function (`rgb`,
 *   `RGB`, `oklch`, `color`, …) or a colour keyword (named or system) in a
 *   property whose grammar takes a colour; `transparent` and `currentColor`
 *   carry no palette and pass, and `color-mix()`/`light-dark()` pass when
 *   what they mix does;
 * - a duration literal (`120ms`, `.2S`) anywhere in a value;
 * - a `var()` naming a token the owner does not declare, or carrying a
 *   fallback (a fallback is a literal the token was meant to replace);
 * - a `font-family` that is not one `--face-*` token, and the `font`
 *   shorthand except a CSS-wide keyword: the faces are the owner's;
 * - a `url()` or a string that leaves the site (a scheme or `//`; the text
 *   of `content` and `quotes` is not an address);
 * - text set in the faint inks (`--ink-3`, `--ink-4`), which fail AA;
 * - a Sass source: the site's sheets are plain CSS, so one parser judges all
 *   of them (Sass variables and functions can produce any literal, which a
 *   parse of the source cannot see).
 *
 * The burn-down list names the sheets that still carry a palette of their
 * own; the build skips them. It only shrinks: each entry names the issue
 * that removes it, and the design test fails an entry that is clean or gone
 * (`tests/public/site-design-system.test.mjs`).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";

import * as csstree from "css-tree";

import { readTokenOwner } from "../../shared/token-reader.ts";
import { SITE_TOKEN_SHEET } from "./site-design.mjs";

export const STYLE_EXTENSIONS = Object.freeze([".css", ".scss", ".sass"]);

/** Sheets (source-relative) that still carry their own palette, each with the issue that removes it. */
export const STYLE_BURN_DOWN = Object.freeze(new Map([
  ["run/run-demo.css", "#161: the run demo's own palette"],
  ["policy-lab/policy-lab.css", "#161: the policy lab's own palette"],
]));

/** The at-rules a site sheet may hold. */
const AT_RULES = new Set(["media", "supports", "keyframes", "container", "layer", "charset"]);
const COLOUR_FUNCTIONS = new Set(["rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "color", "device-cmyk"]);
const COLOUR_TYPES = ["named-color", "system-color", "deprecated-system-color"];
const NO_PALETTE = new Set(["transparent", "currentcolor"]);
const WIDE_KEYWORDS = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);
const FAINT_INKS = new Set(["--ink-3", "--ink-4"]);
const THEME_ATTRIBUTES = new Set(["data-theme", "data-cockpit-theme"]);
/** An address with a scheme or a protocol-relative one: it leaves the site. */
const REMOTE = /^\s*(?:[a-z][a-z\d+.-]*:|\/\/)/iu;
/** Properties whose strings are text the page shows, not addresses. */
const TEXT_PROPERTIES = new Set(["content", "quotes"]);

const COLOUR_KEYWORDS = (() => {
  const words = new Set();
  for (const type of COLOUR_TYPES) {
    csstree.definitionSyntax.walk(csstree.lexer.types[type].syntax, (node) => {
      if (node.type === "Keyword") words.add(node.name.toLowerCase());
    });
  }
  return words;
})();

/** A name as CSS reads it: escapes decoded (`\\63 rimson` is crimson), case folded. */
const plain = (name) => csstree.ident.decode(name).toLowerCase();

const takesColourMemo = new Map();
/** Whether a property's grammar accepts a colour (an unknown property is assumed to). */
function takesColour(property) {
  const name = plain(property);
  if (takesColourMemo.has(name)) return takesColourMemo.get(name);
  const definition = csstree.lexer.getProperty(name);
  const result = definition === null || definition === undefined || syntaxTakesColour(definition.syntax, new Set());
  takesColourMemo.set(name, result);
  return result;
}

function syntaxTakesColour(syntax, seen) {
  let found = false;
  csstree.definitionSyntax.walk(syntax, (node) => {
    if (found) return;
    if (node.type === "Type") {
      if (node.name === "color" || COLOUR_TYPES.includes(node.name)) found = true;
      else if (!seen.has(`type:${node.name}`)) {
        seen.add(`type:${node.name}`);
        const type = csstree.lexer.types[node.name];
        if (type?.syntax && syntaxTakesColour(type.syntax, seen)) found = true;
      }
    } else if (node.type === "Property" && !seen.has(`property:${node.name}`)) {
      seen.add(`property:${node.name}`);
      const property = csstree.lexer.properties[node.name];
      if (property?.syntax && syntaxTakesColour(property.syntax, seen)) found = true;
    }
  });
  return found;
}

/** Every token name the owner declares, in any theme or media remap. */
export function declaredTokens(owner) {
  return new Set([...owner.base.keys(), ...owner.logbook.keys(), ...owner.media.flatMap((remap) => [...remap.values.keys()])]);
}

/** The findings for one value of `property`. */
function valueViolations(property, value, tokens) {
  const findings = [];
  const colourContext = takesColour(property);
  const tokenOnly = (node) => node.type === "Function" && plain(node.name) === "var";
  csstree.walk(value, (node) => {
    switch (node.type) {
      case "Hash":
        findings.push(`colour literal: #${node.value}`);
        break;
      case "Function": {
        const name = plain(node.name);
        if (COLOUR_FUNCTIONS.has(name)) findings.push(`colour literal: ${node.name}()`);
        if (name === "var") {
          const parts = node.children.toArray();
          const token = parts[0]?.type === "Identifier" ? parts[0].name : null;
          if (token === null) findings.push("var() names no token");
          else if (!tokens.has(token)) findings.push(`var(${token}): the owner declares no such token`);
          if (parts.some((part) => part.type === "Operator" && part.value === ",")) findings.push(`var(${token ?? ""}) carries a fallback`);
        }
        break;
      }
      case "Identifier":
        if (colourContext && COLOUR_KEYWORDS.has(plain(node.name)) && !NO_PALETTE.has(plain(node.name))) findings.push(`colour literal: ${node.name}`);
        break;
      case "Dimension":
        if (["s", "ms"].includes(plain(node.unit))) findings.push(`duration literal: ${node.value}${node.unit}`);
        break;
      case "String":
        if (!TEXT_PROPERTIES.has(plain(property)) && REMOTE.test(node.value)) findings.push(`a string leaves the site: ${node.value}`);
        break;
      case "Url":
        if (REMOTE.test(node.value)) findings.push(`url() leaves the site: ${node.value}`);
        break;
      default:
        break;
    }
  });
  const lower = plain(property);
  const parts = value.type === "Value" ? value.children.toArray() : [];
  const wide = parts.length === 1 && parts[0].type === "Identifier" && WIDE_KEYWORDS.has(plain(parts[0].name));
  if (lower === "font-family" && !wide) {
    const face = parts.length === 1 && tokenOnly(parts[0]) && parts[0].children.first?.type === "Identifier" && parts[0].children.first.name.startsWith("--face-");
    if (!face) findings.push(`not one --face-* token: ${csstree.generate(value)}`);
  }
  if (lower === "font" && !wide) findings.push("the shorthand sets a family: use font-family: var(--face-*) and the longhands");
  if (lower === "color") {
    csstree.walk(value, (node) => {
      if (tokenOnly(node) && node.children.first?.type === "Identifier" && FAINT_INKS.has(node.children.first.name)) findings.push(`faint ink as text: ${node.children.first.name}`);
    });
  }
  return findings;
}

/**
 * What a site stylesheet may not hold (see the header), each finding with its
 * line. `tokens` is the owner's declared names ({@link declaredTokens}).
 */
export function siteStyleViolations(css, { tokens }) {
  const findings = [];
  const at = (node) => (node?.loc ? `${String(node.loc.start.line)}:${String(node.loc.start.column)} ` : "");
  const ast = csstree.parse(css, {
    positions: true,
    parseCustomProperty: false,
    onParseError: (error) => findings.push(`${String(error.line ?? "?")}:${String(error.column ?? "?")} unparseable: ${error.message}`),
  });
  // The parser closes an unclosed block at the end of the sheet; a sheet
  // whose braces do not balance is refused here, on the tokens.
  let depth = 0;
  csstree.tokenize(css, (type, start) => {
    if (type === csstree.tokenTypes.LeftCurlyBracket) depth += 1;
    else if (type === csstree.tokenTypes.RightCurlyBracket && (depth -= 1) < 0) {
      findings.push(`offset ${String(start)} unbalanced: a } closes nothing`);
      depth = 0;
    }
  });
  if (depth > 0) findings.push(`unbalanced: ${String(depth)} block(s) never closed`);
  csstree.walk(ast, {
    enter(node) {
      if (node.type === "Rule" && node.prelude.type === "SelectorList") {
        let theme = false;
        csstree.walk(node.prelude, (part) => {
          if (part.type === "PseudoClassSelector" && plain(part.name) === "root") theme = true;
          if (part.type === "AttributeSelector" && THEME_ATTRIBUTES.has(plain(part.name.name))) theme = true;
        });
        if (theme) findings.push(`${at(node)}theme block: ${csstree.generate(node.prelude)}`);
      } else if (node.type === "Atrule") {
        const name = plain(node.name);
        if (name === "import") findings.push(`${at(node)}@import: a sheet is linked by the layout, never chained`);
        else if (name === "font-face") findings.push(`${at(node)}@font-face: the faces are declared once, in the owner`);
        else if (name === "property") findings.push(`${at(node)}@property: a token is declared once, in the owner`);
        else if (!AT_RULES.has(name)) findings.push(`${at(node)}@${node.name}: not an at-rule the site's sheets hold`);
      } else if (node.type === "Declaration") {
        if (plain(node.property).startsWith("--")) {
          findings.push(`${at(node)}custom property declared: ${node.property}`);
          return csstree.walk.skip;
        }
        if (node.value.type === "Raw") findings.push(`${at(node)}unparseable value: ${node.property}: ${node.value.value}`);
        else for (const finding of valueViolations(node.property, node.value, tokens)) findings.push(`${at(node)}${node.property}: ${finding}`);
        return csstree.walk.skip;
      }
      return undefined;
    },
  });
  return findings;
}

/** Every stylesheet in the assembled site source the build consumes, source-relative. */
export function siteStylesheets(sourceRoot) {
  return readdirSync(sourceRoot, { recursive: true })
    .map((path) => String(path).split(sep).join("/"))
    .filter((path) => STYLE_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension)) && statSync(join(sourceRoot, path)).isFile())
    .filter((path) => path !== SITE_TOKEN_SHEET)
    .sort();
}

/**
 * Judges every stylesheet of the assembled source at `sourceRoot` against
 * the owner at `root`. Answers `{ sheets, findings }`: every sheet the build
 * consumes, and the findings of each one outside the burn-down list (whose
 * own upkeep, present and still failing, the design test holds).
 */
export function judgeSiteStyles({ root, sourceRoot }) {
  const tokens = declaredTokens(readTokenOwner(readFileSync(join(root, "src/cockpit/tokens.css"), "utf8")));
  const sheets = siteStylesheets(sourceRoot);
  const findings = [];
  for (const path of sheets) {
    if (STYLE_BURN_DOWN.has(path)) continue;
    if (!path.toLowerCase().endsWith(".css")) {
      findings.push(`${path}: a Sass source: the site's stylesheets are plain CSS, judged by one parser`);
      continue;
    }
    const found = siteStyleViolations(readFileSync(join(sourceRoot, ...path.split("/")), "utf8"), { tokens });
    findings.push(...found.map((finding) => `${path}:${finding}`));
  }
  return { sheets, findings };
}
