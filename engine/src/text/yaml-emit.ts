/**
 * THE ONE YAML EMITTER: a JSON-shaped value written as YAML text,
 * deterministically, for every file the harness generates that GitHub reads as
 * YAML (the issue and Discussion forms, the chooser's `config.yml`, and the
 * generated workflows). Its design is the generated pipeline's (#67, lane
 * GH-2), hardened by the #56 review's YAML 1.1 fuzz:
 *
 * - block mappings and sequences only; key order is the value's insertion
 *   order (a generator states it), never sorted;
 * - a string is a PLAIN scalar only where no YAML 1.1 or 1.2 reader can read
 *   it as anything else (printable ASCII, a letter, `_`, `/`, `$` or a
 *   non-numeric `.` first, never `: `, ` #`, a trailing `:` or space, never a
 *   boolean or null word); a multi-line string is a literal block when its
 *   lines can be one; everything else is DOUBLE-QUOTED, with every character a
 *   YAML reader would fold or refuse raw (DEL, the C1 controls including NEL,
 *   U+2028, U+2029, the BOM) written as an escape;
 * - a key is plain only when it is an identifier and no boolean or null word
 *   (`on`, `yes`, `no`, `y`, `n`, `off`, `true`, `null` are quoted);
 * - a number is written only in a form both readers read back as that number
 *   (an integer within the safe range, or a plain decimal); `1e+21`, `NaN`
 *   and the infinities are refused;
 * - {@link Commented}: a scalar with a trailing comment (an action pin's
 *   version, `uses: owner/action@<sha> # v7`).
 *
 * Anything else (`undefined`, a function, a class instance, a symbol) is the
 * typed `yaml_unrepresentable`: a generator that hands one over has a bug,
 * never a value to skip.
 */
import { InputError } from "../kernel/errors.ts";

/** A scalar with a trailing one-line comment. */
export class Commented {
  readonly value: string;
  readonly comment: string;
  constructor(value: string, comment: string) {
    if (/[\r\n]/u.test(comment)) refuse("a comment is one line");
    this.value = value;
    this.comment = comment;
    Object.freeze(this);
  }
}

export type YamlValue = string | number | boolean | null | Commented | readonly YamlValue[] | Readonly<{ [key: string]: YamlValue }>;

/** Words a YAML 1.1 or 1.2 reader turns into a boolean or null when plain (compared lower-cased). */
const RESERVED = new Set(["true", "false", "null", "yes", "no", "on", "off", "y", "n", "~", ".inf", "-.inf", "+.inf", ".nan"]);
const SAFE_PLAIN = /^(?:[A-Za-z_/$]|\.(?!\d))[\x20-\x7e]*$/u;
const PLAIN_BREAKERS = /: | #|:$| $/u;
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/u;
/** Characters a YAML reader refuses raw or folds as a line break: written as escapes in a quoted scalar, never in a literal block. */
const UNSAFE_RAW = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2028\u2029\ufeff]/gu;
const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u;

function refuse(why: string): never {
  throw new InputError(`yaml: ${why}`, "yaml_unrepresentable");
}

/** A double-quoted scalar: JSON's escapes, plus every character a YAML reader would refuse raw or fold. */
function quoted(text: string): string {
  return JSON.stringify(text).replace(UNSAFE_RAW, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function scalar(value: YamlValue): string {
  if (value instanceof Commented) return `${scalar(value.value)} # ${value.comment}`;
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    const text = String(value);
    if (!Number.isFinite(value) || !DECIMAL.test(text) || (Number.isInteger(value) && !Number.isSafeInteger(value))) refuse(`the number ${text} has no form every YAML reader reads back`);
    return text;
  }
  if (typeof value !== "string") refuse("not a scalar");
  if (SAFE_PLAIN.test(value) && !PLAIN_BREAKERS.test(value) && !RESERVED.has(value.toLowerCase())) return value;
  return quoted(value);
}

function key(name: string): string {
  return SAFE_KEY.test(name) && !RESERVED.has(name.toLowerCase()) ? name : quoted(name);
}

function assertValue(value: unknown): asserts value is YamlValue {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return;
  if (Array.isArray(value) || value instanceof Commented) return;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) return;
  refuse(`${value === undefined ? "undefined" : typeof value} is not a YAML value`);
}

function isMapping(value: YamlValue): value is Readonly<{ [key: string]: YamlValue }> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Commented);
}

/** A multi-line string as a literal block, or `null` when it cannot be one (it then goes double-quoted). */
function literalBlock(text: string, indent: number): string[] | null {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const lines = body.split("\n");
  if (body.length === 0 || /^\s/u.test(body) || lines.some((line) => line !== line.trimEnd() || /\r/u.test(line)) || new RegExp(UNSAFE_RAW.source, "u").test(body)) return null;
  const header = text.endsWith("\n") ? (text.endsWith("\n\n") ? "|+" : "|") : "|-";
  const pad = " ".repeat(indent);
  return [header, ...lines.map((line) => (line.length === 0 ? "" : `${pad}${line}`))];
}

/** The lines of `value` at `indent`; `position` says where its first line goes (a document root, after `key:`, or after `- `). */
function emitNode(value: YamlValue, indent: number, position: "document" | "value" | "item"): string[] {
  assertValue(value);
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return ["[]"];
    const lines = (value as readonly YamlValue[]).flatMap((item) => {
      const inner = emitNode(item, indent + 2, "item");
      return [`${pad}- ${inner[0]!.trimStart()}`, ...inner.slice(1)];
    });
    return position === "value" ? ["", ...lines] : lines;
  }
  if (isMapping(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return ["{}"];
    const lines = entries.flatMap(([name, child]) => {
      assertValue(child);
      const childLines = typeof child === "string" && child.includes("\n")
        ? literalBlock(child, indent + 2) ?? [quoted(child)]
        : Array.isArray(child) || isMapping(child) ? emitNode(child, indent + 2, "value") : [scalar(child)];
      const [first, ...rest] = childLines;
      return [first === "" ? `${pad}${key(name)}:` : `${pad}${key(name)}: ${first!}`, ...rest];
    });
    return position === "value" ? ["", ...lines] : lines;
  }
  if (typeof value === "string" && value.includes("\n") && position === "item") return literalBlock(value, indent) ?? [quoted(value)];
  return [scalar(value)];
}

/** `value` as a YAML document (no leading `---`, one trailing newline), preceded by `comments` as `#` lines. */
export function emitYaml(value: YamlValue, comments: readonly string[] = []): string {
  if (comments.some((line) => /[\r\n]/u.test(line))) refuse("a comment is one line");
  return [...comments.map((line) => (line === "" ? "#" : `# ${line}`)), ...emitNode(value, 0, "document")].join("\n") + "\n";
}
