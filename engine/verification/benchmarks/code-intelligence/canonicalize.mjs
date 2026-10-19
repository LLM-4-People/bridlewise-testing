#!/usr/bin/env node
// Independent cross-runtime canonical JSON control for admitted bootstrap bytes.
// This is not a runtime bootstrap compiler.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { TextDecoder } from "node:util";

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function rejectNonIntegerNumberTokens(raw) {
  let inString = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === "-" || /[0-9]/.test(char)) {
      const token = raw.slice(index).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/)?.[0];
      if (!token) throw new Error(`invalid number token at byte ${index}`);
      if (/[.eE]/.test(token)) throw new Error(`floating-point number forbidden: ${token}`);
      const integer = Number(token);
      if (!Number.isSafeInteger(integer) || Math.abs(integer) > MAX_SAFE) throw new Error(`unsafe integer: ${token}`);
      index += token.length - 1;
    }
  }
}

function rejectDuplicateObjectKeys(raw) {
  let index = 0;
  const whitespace = () => { while (/\s/u.test(raw[index] ?? "")) index += 1; };
  const stringToken = () => {
    const start = index;
    if (raw[index] !== '"') throw new Error(`expected string at character ${index}`);
    index += 1;
    let escaped = false;
    while (index < raw.length) {
      const char = raw[index];
      index += 1;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') return JSON.parse(raw.slice(start, index));
    }
    throw new Error(`unterminated string at character ${start}`);
  };
  const value = () => {
    whitespace();
    if (raw[index] === "{") {
      index += 1; whitespace();
      const keys = new Set();
      if (raw[index] === "}") { index += 1; return; }
      while (true) {
        whitespace();
        const key = stringToken();
        if (keys.has(key)) throw new Error(`duplicate JSON object key: ${key}`);
        keys.add(key); whitespace();
        if (raw[index] !== ":") throw new Error(`expected colon at character ${index}`);
        index += 1; value(); whitespace();
        if (raw[index] === "}") { index += 1; return; }
        if (raw[index] !== ",") throw new Error(`expected object delimiter at character ${index}`);
        index += 1;
      }
    }
    if (raw[index] === "[") {
      index += 1; whitespace();
      if (raw[index] === "]") { index += 1; return; }
      while (true) {
        value(); whitespace();
        if (raw[index] === "]") { index += 1; return; }
        if (raw[index] !== ",") throw new Error(`expected array delimiter at character ${index}`);
        index += 1;
      }
    }
    if (raw[index] === '"') { stringToken(); return; }
    const token = raw.slice(index).match(/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u)?.[0];
    if (!token) throw new Error(`invalid JSON value at character ${index}`);
    index += token.length;
  };
  value(); whitespace();
  if (index !== raw.length) throw new Error(`trailing JSON content at character ${index}`);
}

function normalize(value, path = "$") {
  if (Array.isArray(value)) return value.map((item, index) => normalize(item, `${path}[${index}]`));
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      if (!/^[\x20-\x7e]+$/.test(key)) throw new Error(`non-ASCII object key at ${path}`);
    }
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key], `${path}.${key}`)]));
  }
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error(`non-safe integer at ${path}`);
  if (typeof value === "string") {
    for (let index = 0; index < value.length; index += 1) {
      const unit = value.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const trailing = value.charCodeAt(index + 1);
        if (!(trailing >= 0xdc00 && trailing <= 0xdfff)) throw new Error(`lone high surrogate at ${path}`);
        index += 1;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        throw new Error(`lone low surrogate at ${path}`);
      }
    }
    if (value.normalize("NFC") !== value) throw new Error(`non-NFC string at ${path}`);
  }
  return value;
}

if (process.argv.length !== 3) {
  console.error("usage: canonicalize.mjs <json-file>");
  process.exit(2);
}
const rawBytes = readFileSync(process.argv[2]);
const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(rawBytes);
rejectNonIntegerNumberTokens(raw);
rejectDuplicateObjectKeys(raw);
const parsed = JSON.parse(raw);
const bytes = `${JSON.stringify(normalize(parsed))}\n`;
process.stdout.write(JSON.stringify({
  bytes: Buffer.byteLength(bytes),
  sha256: createHash("sha256").update(bytes, "utf8").digest("hex"),
}) + "\n");
