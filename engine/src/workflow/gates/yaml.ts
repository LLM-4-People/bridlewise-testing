/**
 * THE ONE YAML EMITTER of the generated pipeline: a JSON-shaped value (the
 * workflow documents `workflows.ts` builds) to YAML text, deterministically.
 *
 * It emits a deliberately small subset — block mappings and sequences, plain
 * scalars only where they cannot be read back as anything else, double-quoted
 * (JSON) scalars otherwise, and literal blocks for multi-line strings — so the
 * same value always yields the same bytes and the text reads back as that
 * value. Key order is the value's own insertion order (the generators state
 * it), never sorted: a workflow reads top-down (`name`, `on`, `jobs`).
 *
 * Anything that is not a string, a finite number, a boolean, null, an array or
 * a plain object is a typed refusal: a generator that hands it `undefined` has
 * a bug, never a value to skip.
 */
import { InputError } from "../../kernel/errors.ts";

/** A scalar with a trailing comment (an action pin's version: `uses: owner/action@<sha> # v7`). */
export class Commented {
  readonly value: string;
  readonly comment: string;
  constructor(value: string, comment: string) {
    if (comment.includes("\n")) throw new InputError("yaml: a comment is one line", "yaml_unrepresentable");
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
/** A plain mapping key (GitHub's `on`, `runs-on`, `timeout-minutes`, …). */
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/u;

/** The YAML text of `value` (a document: no leading `---`, one trailing newline). */
export function emitYaml(value: YamlValue): string {
  const lines = emitNode(value, 0, "document");
  return `${lines.join("\n")}\n`;
}

function isMapping(value: YamlValue): value is Readonly<{ [key: string]: YamlValue }> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Commented);
}

function scalar(value: YamlValue): string {
  if (value instanceof Commented) return `${scalar(value.value)} # ${value.comment}`;
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new InputError(`yaml: a non-finite number cannot be emitted (${String(value)})`, "yaml_unrepresentable");
    return String(value);
  }
  if (typeof value !== "string") throw new InputError("yaml: not a scalar", "yaml_unrepresentable");
  if (value.length > 0 && SAFE_PLAIN.test(value) && !PLAIN_BREAKERS.test(value) && !RESERVED.has(value.toLowerCase()) && !value.endsWith(" ")) return value;
  return JSON.stringify(value);
}

function key(name: string): string {
  return SAFE_KEY.test(name) ? name : JSON.stringify(name);
}

function assertValue(value: unknown): asserts value is YamlValue {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return;
  if (Array.isArray(value) || value instanceof Commented) return;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) return;
  throw new InputError(`yaml: ${value === undefined ? "undefined" : typeof value} is not a YAML value`, "yaml_unrepresentable");
}

/** A multi-line string as a literal block: `|` keeps the final newline, `|-` strips its absence. */
function literalBlock(text: string, indent: number): readonly string[] {
  const pad = " ".repeat(indent);
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (body.split("\n").some((line) => line !== line.trimEnd())) {
    throw new InputError("yaml: a literal block line ends in whitespace (it would not read back)", "yaml_unrepresentable");
  }
  if (/^\s/u.test(body)) throw new InputError("yaml: a literal block starts with whitespace (needs an indentation indicator)", "yaml_unrepresentable");
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
