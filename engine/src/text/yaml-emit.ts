/**
 * THE ONE YAML EMITTER: a JSON-shaped value as deterministic block-style YAML,
 * for every generated file GitHub reads as YAML — the workflows the gate
 * catalogue generates (`src/workflow/gates/workflows.ts`) and the community
 * issue and discussion forms (Issue #103: GH-2's and GH-9's emitters folded
 * into this one).
 *
 *   - keys keep their insertion order (a workflow reads `name`, `on`, `jobs`)
 *     and must be plain identifiers (letters, digits, `_` and `-`);
 *   - a string is PLAIN only when no YAML reader could take it for anything
 *     else (a letter, `_`, `/`, `.` or `$` first; never `: `, ` #`, a trailing
 *     `:`, a YAML 1.1/1.2 boolean or null word, or number-shaped), so GitHub's
 *     `${{ … }}` reads as its documentation writes it; every other string is
 *     double-quoted (a JSON string literal is a valid YAML scalar);
 *   - a multi-line string is a literal block (`|`, `|-`, `|+`), so a
 *     workflow's script reads as a script;
 *   - `Commented` carries a trailing comment (an action pin's version:
 *     `uses: owner/action@<sha> # v7`); null is the bare key (`wait-all:`);
 *   - the document may open with `comments` (`#` lines) and ends with one
 *     newline.
 *
 * What it cannot represent — `undefined`, a function, a non-finite number, a
 * non-plain object, a non-plain key, a literal block line ending in
 * whitespace — is the typed `yaml_value_unrepresentable`, never a silent drop.
 */
import { InputError } from "../kernel/errors.ts";

/** A scalar with a trailing comment (an action pin's version: `uses: owner/action@<sha> # v7`). */
export class Commented {
  readonly value: string;
  readonly comment: string;
  constructor(value: string, comment: string) {
    if (comment.includes("\n")) throw new InputError("yaml: a comment is one line", "yaml_value_unrepresentable");
    this.value = value;
    this.comment = comment;
    Object.freeze(this);
  }
}

export type YamlValue = string | number | boolean | null | Commented | readonly YamlValue[] | Readonly<{ [key: string]: YamlValue }>;

/** Words a YAML 1.1 or 1.2 reader turns into a boolean or null when plain. */
const RESERVED = new Set(["true", "false", "null", "yes", "no", "on", "off", "y", "n", "~", ".inf", ".nan"]);
/**
 * A plain scalar that reads back as itself in block context: a letter, `_`,
 * `/`, `.` or `$` first (never an indicator, never number-shaped), then
 * printable ASCII, never `: ` or ` #`, never a trailing `:` (each would start
 * a mapping or a comment). Flow indicators (`{}[]`) are ordinary characters
 * inside a block-context plain scalar, so GitHub's `${{ … }}` stays unquoted,
 * as its own documentation writes it.
 */
const SAFE_PLAIN = /^[A-Za-z_/.$][\x20-\x7e]*$/u;
const PLAIN_BREAKERS = /: | #|:$/u;
/** A plain mapping key (GitHub's `on`, `runs-on`, `timeout-minutes`, …); any other key is refused. */
const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/u;

/** `value` as a YAML document (no leading `---`), preceded by `comments` as `#` lines, ending with one newline. */
export function emitYaml(value: YamlValue, comments: readonly string[] = []): string {
  if (comments.some((line) => line.includes("\n"))) throw new InputError("yaml: a comment is one line", "yaml_value_unrepresentable");
  const lines = emitNode(value, 0, "document");
  return `${[...comments.map((line) => (line === "" ? "#" : `# ${line}`)), ...lines].join("\n")}\n`;
}

function isMapping(value: YamlValue): value is Readonly<{ [key: string]: YamlValue }> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Commented);
}

function scalar(value: YamlValue): string {
  if (value instanceof Commented) return `${scalar(value.value)} # ${value.comment}`;
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new InputError(`yaml: a non-finite number cannot be emitted (${String(value)})`, "yaml_value_unrepresentable");
    return String(value);
  }
  if (typeof value !== "string") throw new InputError("yaml: not a scalar", "yaml_value_unrepresentable");
  if (value.length > 0 && SAFE_PLAIN.test(value) && !PLAIN_BREAKERS.test(value) && !RESERVED.has(value.toLowerCase()) && !value.endsWith(" ")) return value;
  return JSON.stringify(value);
}

function key(name: string): string {
  if (!PLAIN_KEY.test(name)) throw new InputError(`yaml: the key ${JSON.stringify(name)} is not a plain identifier`, "yaml_value_unrepresentable");
  return name;
}

function assertValue(value: unknown): asserts value is YamlValue {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return;
  if (Array.isArray(value) || value instanceof Commented) return;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) return;
  throw new InputError(`yaml: ${value === undefined ? "undefined" : typeof value} is not a YAML value`, "yaml_value_unrepresentable");
}

/** A multi-line string as a literal block: `|` keeps the final newline, `|-` strips its absence. */
function literalBlock(text: string, indent: number): readonly string[] {
  const pad = " ".repeat(indent);
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (body.split("\n").some((line) => line !== line.trimEnd())) {
    throw new InputError("yaml: a literal block line ends in whitespace (it would not read back)", "yaml_value_unrepresentable");
  }
  if (/^\s/u.test(body)) throw new InputError("yaml: a literal block starts with whitespace (needs an indentation indicator)", "yaml_value_unrepresentable");
  const header = text.endsWith("\n") ? (text.endsWith("\n\n") ? "|+" : "|") : "|-";
  return [header, ...body.split("\n").map((line) => (line.length === 0 ? "" : `${pad}${line}`))];
}

/**
 * The lines of `value` at `indent`. `position` says where the first line goes:
 * a document root, after `key:` (a scalar stays on that line), or after `- `.
 */
function emitNode(value: YamlValue, indent: number, position: "document" | "value" | "item"): string[] {
  assertValue(value);
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return ["[]"];
    const lines: string[] = [];
    for (const item of value as readonly YamlValue[]) {
      const inner = emitNode(item, indent + 2, "item");
      lines.push(`${pad}- ${inner[0]!.trimStart()}`, ...inner.slice(1));
    }
    return position === "value" ? ["", ...lines] : lines;
  }
  if (isMapping(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return ["{}"];
    const lines: string[] = [];
    for (const [name, child] of entries) {
      assertValue(child);
      const childLines = typeof child === "string" && child.includes("\n")
        ? literalBlock(child, indent + 2)
        : (Array.isArray(child) || isMapping(child)) ? emitNode(child, indent + 2, "value") : [scalar(child)];
      const [first, ...rest] = childLines;
      // A null value is written as GitHub's own spelling, the bare key (`wait-all:`).
      lines.push(first === "" || child === null ? `${pad}${key(name)}:` : `${pad}${key(name)}: ${first}`, ...rest);
    }
    if (position === "value") return ["", ...lines];
    return lines;
  }
  if (typeof value === "string" && value.includes("\n")) {
    if (position === "item") return [...literalBlock(value, indent)];
  }
  return [scalar(value)];
}
