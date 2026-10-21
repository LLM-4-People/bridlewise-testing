/**
 * Canonical JSON repair for model tool-call arguments — the ONE owner of
 * turning a weak model's almost-JSON output into a parsed object.
 *
 * A weak model routinely emits tool-call arguments that are ALMOST JSON but
 * not quite: prose around the payload, markdown fences, raw control characters
 * (a real newline where the model meant `\n`), an unclosed object, trailing
 * garbage, single quotes, unquoted keys, smart quotes, Python literals
 * (`True`/`False`/`None`), `NaN`, or `//` comments. Every repair here is one a
 * real model actually produced.
 *
 * THE GUARANTEE THAT MAKES THIS SAFE TO SIT AT THE TRANSPORT BOUNDARY: a
 * payload that is already valid JSON passes through UNCHANGED — the first
 * candidate (the raw text) parses on the first, exact `JSON.parse`, so no
 * repair stage ever runs on it. Each repair is pure and only fires when it
 * changed something, so valid input round-trips byte-identical. This is the
 * property the safety tests pin.
 *
 * A REPAIRED VALUE MUST BE THE VALUE. The ladder refuses what JSON cannot
 * carry without changing it: `NaN`/`Infinity`/`undefined` are not rewritten
 * to `null`, and an integer beyond double precision is not rounded. The
 * caller treats `null` as a refusal rather than dispatching a changed leaf.
 *
 * Every repair is pure (no mutation of the input) and idempotent. Candidates
 * are tried cheapest-and-safest first; the first that parses wins.
 *
 * Ported from the edit-tools lab's `vendor/smart-edit/json-parse.mjs` onto the
 * engine's shared text layer, so the runtime transport, the safety gate and the
 * tool executor all read ONE repair ladder instead of each parsing ad hoc.
 */

import { jsonNumberRanges, parseJsonExact } from "../kernel/json-integrity.ts";
import { isPlainObject } from "../shared/type-guards.ts";

/** The parsed object, or `null` when nothing parses. */
export type JsonRepairResult = Readonly<Record<string, unknown>> | null;

/**
 * Parse a JSON object from a possibly-fenced, possibly-malformed model
 * response. Returns `null` when no candidate parses — never throws, so the
 * caller decides how to surface an unparseable payload.
 */
export function parseJsonLoose(text: string): JsonRepairResult {
  if (!text || typeof text !== "string") return null;
  for (const candidate of candidates(text)) {
    const r = tryParseWithRepairs(candidate);
    if (r !== null) return r;
  }
  return null;
}

/**
 * Whether every integer NUMBER TOKEN in `text` survives `JSON.parse`
 * unchanged.
 *
 * A JSON document can spell an integer that IEEE-754 cannot represent
 * exactly (`12345678901234567890`). `JSON.parse` rounds it, and a caller that
 * treats that parsed object as the model's arguments dispatches a value the
 * model never wrote — a silently changed numeric leaf. The transport cannot
 * carry the exact literal, so the honest choice is refusal: a payload whose
 * digits would move is not repaired into something else.
 *
 * Exact-representable integers (`9007199254740991`, `-42`, `0`) pass; a
 * decimal or exponent form is left to JSON's own numeric semantics (it names
 * a double, not an integer literal).
 */
function jsonNumbersPreserved(text: string): boolean {
  const ranges = jsonNumberRanges(text);
  if (ranges === undefined) return true;
  for (const range of ranges) {
    const token = text.slice(range.startUtf16, range.endUtf16);
    if (!/^-?(?:0|[1-9]\d*)$/u.test(token)) continue;
    const parsed = Number(token);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return false;
    if (BigInt(parsed) !== BigInt(token)) return false;
  }
  return true;
}

/** One exact parse, no repair: the plain object the text encodes, or `null`. */
export function parseJsonObjectExact(text: string): JsonRepairResult {
  if (!text || typeof text !== "string") return null;
  const parsed = parseJsonExact(text);
  if (parsed === undefined || !isPlainObject(parsed.value)) return null;
  // A value that would be ROUNDED by the parse is not the value; refuse it
  // (the bridge then refuses the tool call rather than dispatch a changed
  // number).
  if (!jsonNumbersPreserved(text)) return null;
  return parsed.value;
}

/**
 * Parse one model tool-call argument buffer into the object the runtime will
 * dispatch, or refuse it. THE ONE OWNER of that decision: the bridge calls
 * this instead of spelling a fallback of its own.
 *
 * An EMPTY buffer is the one declared empty object (a tool that takes no
 * arguments is emitted with no JSON at all). Anything non-empty that does not
 * parse — with the repair ladder enabled or not — is `{ ok: false }`: it is
 * never coerced to `{}`, because dispatching a tool with defaults the model
 * never named changes the action.
 */
export type ToolCallArgumentsParse =
  | Readonly<{ ok: true; arguments: Readonly<Record<string, unknown>>; repaired: boolean }>
  | Readonly<{ ok: false }>;

export function parseToolCallArguments(raw: string, repairEnabled: boolean): ToolCallArgumentsParse {
  if (raw.length === 0) return Object.freeze({ ok: true, arguments: Object.freeze({}), repaired: false });
  if (repairEnabled) {
    const exact = parseJsonObjectExact(raw);
    if (exact !== null) return Object.freeze({ ok: true, arguments: exact, repaired: false });
    const repaired = parseJsonLoose(raw);
    if (repaired === null) return Object.freeze({ ok: false });
    return Object.freeze({ ok: true, arguments: repaired, repaired: true });
  }
  const exact = parseJsonObjectExact(raw);
  return exact === null ? Object.freeze({ ok: false }) : Object.freeze({ ok: true, arguments: exact, repaired: false });
}

// ---------------------------------------------------------------------------
// Candidate generation: every fenced block (json first), the raw text, and the
// balanced-brace substring of the first top-level object.
// ---------------------------------------------------------------------------
function candidates(text: string): string[] {
  const out: string[] = [];
  const fenceRe = /```([a-zA-Z]*)\s*([\s\S]*?)```/gi;
  const fences: Array<{ lang: string; body: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) fences.push({ lang: (m[1] ?? "").toLowerCase(), body: (m[2] ?? "").trim() });
  for (const f of fences) if (f.lang === "json") out.push(f.body);
  for (const f of fences) if (f.lang !== "json") out.push(f.body);
  out.push(text);
  const slice = balancedObjectSlice(text);
  if (slice !== null && slice !== text) out.push(slice);
  return out;
}

// Repair ladder: try each repair in order, returning the first that parses to a
// plain object. Ordered cheapest-and-safest first; each repair is pure and only
// fires when it changed something, so a clean input is never altered.
function tryParseWithRepairs(s: string): JsonRepairResult {
  if (!s) return null;
  let r = parseJsonObjectExact(s);
  if (r !== null) return r;
  r = parseJsonObjectExact(escapeControlCharsInStrings(s));
  if (r !== null) return r;
  r = parseJsonObjectExact(closeAndTruncate(s));
  if (r !== null) return r;
  r = parseJsonObjectExact(normalizeLooseJson(s));
  if (r !== null) return r;
  r = parseJsonObjectExact(closeAndTruncate(escapeControlCharsInStrings(s)));
  if (r !== null) return r;
  r = parseJsonObjectExact(closeAndTruncate(normalizeLooseJson(s)));
  if (r !== null) return r;
  r = parseJsonObjectExact(closeAndTruncate(normalizeLooseJson(escapeControlCharsInStrings(s))));
  if (r !== null) return r;
  r = salvageEditsFromTruncated(s);
  if (r !== null) return r;
  return null;
}

// ---------------------------------------------------------------------------
// Balanced-object slice: string-aware scan for the first top-level {...}.
// ---------------------------------------------------------------------------
function balancedObjectSlice(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let strCh = "";
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (c === "\\") { i++; continue; }
      if (c === strCh) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; strCh = c; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null; // unbalanced
}

// ---------------------------------------------------------------------------
// Repair: escape raw control characters (U+0000–U+001F) inside JSON strings.
// ---------------------------------------------------------------------------
function escapeControlCharsInStrings(text: string): string {
  let out = "";
  let inStr = false;
  let changed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (c === "\\") { out += c + (text[i + 1] ?? ""); i++; continue; }
      if (c === '"') { inStr = false; out += c; continue; }
      const code = c.charCodeAt(0);
      if (code < 0x20) {
        if (c === "\n") out += "\\n";
        else if (c === "\t") out += "\\t";
        else if (c === "\r") out += "\\r";
        else out += "\\u" + code.toString(16).padStart(4, "0");
        changed = true;
        continue;
      }
      out += c;
      continue;
    }
    if (c === '"') inStr = true;
    out += c;
  }
  return changed ? out : text;
}

// ---------------------------------------------------------------------------
// Repair: close unclosed objects/arrays AND drop trailing garbage.
// ---------------------------------------------------------------------------
function closeAndTruncate(text: string): string {
  let out = "";
  let inStr = false;
  let strCh = "";
  let changed = false;
  const stack: string[] = [];
  let balancedEnd = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      out += c;
      if (c === "\\") { out += text[i + 1] ?? ""; i++; continue; }
      if (c === strCh) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; strCh = c; out += c; continue; }
    if (c === "{") { stack.push("{"); out += c; }
    else if (c === "[") { stack.push("["); out += c; }
    else if (c === "}" || c === "]") {
      const want = c === "}" ? "{" : "[";
      while (stack.length > 0 && stack[stack.length - 1] !== want) {
        out += stack[stack.length - 1] === "{" ? "}" : "]";
        stack.pop();
        changed = true;
      }
      if (stack.length > 0) {
        stack.pop();
        out += c;
        if (stack.length === 0 && balancedEnd === -1) balancedEnd = out.length;
      } else {
        changed = true;
      }
    } else {
      out += c;
    }
  }
  while (stack.length > 0) { out += stack.pop() === "{" ? "}" : "]"; changed = true; }
  if (balancedEnd !== -1 && balancedEnd < out.length) {
    out = out.slice(0, balancedEnd);
    changed = true;
  }
  return changed ? out : text;
}

// ---------------------------------------------------------------------------
// Repair: lexical normalization for "loose JSON" — the Python/JS-flavored
// output a weak model writes when it treats the payload like source code.
// ---------------------------------------------------------------------------
function normalizeLooseJson(text: string): string {
  let out = "";
  let inStr: string | null = null;
  let changed = false;
  const isIdentChar = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);
  const isWs = (c: string): boolean => c === " " || c === "\t" || c === "\n" || c === "\r";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (inStr === '"') {
      out += c;
      if (c === "\\") { out += text[i + 1] ?? ""; i += 2; continue; }
      if (c === '"') inStr = null;
      i++; continue;
    }
    if (inStr === "'") {
      if (c === "\\" && (text[i + 1] === "'" || text[i + 1] === "\\")) { out += text[i + 1] === "'" ? '"' : "\\\\"; i += 2; changed = true; continue; }
      if (c === "'") { out += '"'; inStr = null; i++; changed = true; continue; }
      if (c === '"') { out += '\\"'; i++; changed = true; continue; }
      out += c; i++; continue;
    }
    if (c === "“" || c === "”" || c === "‘" || c === "’") {
      out += '"'; changed = true; i++; continue;
    }
    if (c === '"' && inStr === null) {
      let k = out.length - 1;
      while (k >= 0 && isWs(out[k]!)) k--;
      const pv = k >= 0 ? out[k]! : "";
      let j = i + 1;
      while (j < n && text[j] !== '"') { if (text[j] === "\\") j++; j++; }
      let afterClose = j + 1;
      while (afterClose < n && isWs(text[afterClose]!)) afterClose++;
      const looksLikeKey = text[afterClose] === ":";
      const valueJustEnded = pv === '"' || pv === "}" || pv === "]" || /[0-9e]/.test(pv);
      if (looksLikeKey && valueJustEnded && pv !== "{" && pv !== "[") {
        out += ","; changed = true;
      }
      inStr = '"'; out += c; i++; continue;
    }
    if (c === '"') { inStr = '"'; out += c; i++; continue; }
    if (c === "'") { inStr = "'"; out += '"'; changed = true; i++; continue; }
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
      changed = true; continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2; changed = true; continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < n && isWs(text[j]!)) j++;
      if (text[j] === "}" || text[j] === "]") { changed = true; i++; continue; }
      out += c; i++; continue;
    }
    if (inStr === null && /[A-Za-z_$]/.test(c)) {
      let k = out.length - 1;
      while (k >= 0 && isWs(out[k]!)) k--;
      const prevNonWs = k >= 0 ? out[k]! : "";
      let j = i;
      while (j < n && isIdentChar(text[j]!)) j++;
      const word = text.slice(i, j);
      let m2 = j;
      while (m2 < n && isWs(text[m2]!)) m2++;
      if ((prevNonWs === "{" || prevNonWs === ",") && text[m2] === ":" && word.length > 0) {
        out += '"' + word + '"'; changed = true; i = j; continue;
      }
      if (word === "True") { out += "true"; changed = true; i = j; continue; }
      if (word === "False") { out += "false"; changed = true; i = j; continue; }
      if (word === "None") { out += "null"; changed = true; i = j; continue; }
      // NaN / Infinity / -Infinity / undefined have NO JSON value. They used
      // to be rewritten to `null` here, which changed the leaf's value; they
      // are left in place so the candidate fails to parse and the caller
      // refuses the payload (preserve or refuse — never coerce).

      out += word; i = j; continue;
    }
    out += c; i++;
  }
  return changed ? out : text;
}

// ---------------------------------------------------------------------------
// Repair: salvage complete edit objects from a truncated tail. The model's
// output was cut by max_tokens mid-object; the complete `{...}` objects before
// the cut are still valid edits.
// ---------------------------------------------------------------------------
function salvageEditsFromTruncated(tail: string): JsonRepairResult {
  if (!tail) return null;
  const edits: Array<Readonly<Record<string, unknown>>> = [];
  for (let i = 0; i < tail.length; i++) {
    if (tail[i] !== "{") continue;
    let depth = 0;
    let inStr = false;
    let strCh = "";
    let end = -1;
    for (let j = i; j < tail.length; j++) {
      const c = tail[j]!;
      if (inStr) {
        if (c === "\\") { j++; continue; }
        if (c === strCh) inStr = false;
        continue;
      }
      if (c === '"' || c === "'") { inStr = true; strCh = c; continue; }
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end !== -1) {
      let obj = parseJsonObjectExact(tail.slice(i, end + 1));
      if (obj === null) obj = parseJsonObjectExact(escapeControlCharsInStrings(tail.slice(i, end + 1)));
      if (obj !== null && typeof obj["oldString"] === "string" && typeof obj["newString"] === "string") edits.push(obj);
      i = end;
    }
  }
  return edits.length > 0 ? Object.freeze({ edits: Object.freeze(edits) }) as Readonly<Record<string, unknown>> : null;
}
