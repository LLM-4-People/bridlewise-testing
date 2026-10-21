/**
 * THE ONE YAML EMITTER: a JSON value written as block-style YAML, for the
 * generated files GitHub reads as YAML (issue forms, discussion forms and
 * their `config.yml`). Deterministic: keys keep their insertion order, every
 * string is a double-quoted scalar (a JSON string literal is a valid YAML
 * double-quoted scalar, so no plain-scalar ambiguity such as `no`, `1.0` or a
 * leading `*` can change its meaning), and the output ends with one newline.
 *
 * Only what JSON can hold is written: an object key must be a plain
 * identifier (letters, digits, `_` and `-`), and `undefined`, a function, a
 * non-finite number or a symbol is the typed `yaml_value_unrepresentable`,
 * never a silent drop.
 */
import { InputError } from "../kernel/errors.ts";

export type YamlValue = string | number | boolean | null | readonly YamlValue[] | { readonly [key: string]: YamlValue };

const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/u;

function refuse(path: string, why: string): never {
  throw new InputError(`YAML cannot represent ${path}: ${why}`, "yaml_value_unrepresentable", { path });
}

function scalar(value: YamlValue, path: string): string | undefined {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : refuse(path, "a non-finite number");
  if (Array.isArray(value)) return value.length === 0 ? "[]" : undefined;
  if (typeof value === "object") return Object.keys(value).length === 0 ? "{}" : undefined;
  return refuse(path, `a ${typeof value}`);
}

function lines(value: YamlValue, indent: string, path: string): string[] {
  if (Array.isArray(value)) {
    return (value as readonly YamlValue[]).flatMap((item, index) => {
      const itemPath = `${path}[${String(index)}]`;
      const single = scalar(item, itemPath);
      if (single !== undefined) return [`${indent}- ${single}`];
      const body = lines(item, `${indent}  `, itemPath);
      // The first line of a nested block rides on the dash.
      return [`${indent}- ${body[0]!.slice(indent.length + 2)}`, ...body.slice(1)];
    });
  }
  return Object.entries(value as { readonly [key: string]: YamlValue }).flatMap(([key, item]) => {
    if (!PLAIN_KEY.test(key)) refuse(`${path}.${key}`, "a key that is not a plain identifier");
    const itemPath = `${path}.${key}`;
    const single = scalar(item, itemPath);
    return single !== undefined ? [`${indent}${key}: ${single}`] : [`${indent}${key}:`, ...lines(item, `${indent}  `, itemPath)];
  });
}

/** `value` (an object) as a YAML document, preceded by `comments` as `#` lines. */
export function emitYaml(value: { readonly [key: string]: YamlValue }, comments: readonly string[] = []): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse("$", "a document that is not an object");
  return [...comments.map((line) => (line === "" ? "#" : `# ${line}`)), ...lines(value, "", "$")].join("\n") + "\n";
}
