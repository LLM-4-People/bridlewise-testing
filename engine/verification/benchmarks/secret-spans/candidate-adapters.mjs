import { SECRET_TEXT_SIGNAL_CATALOG } from "../../../src/privacy/secret-signals.ts";
import { sha256 } from "../../../src/kernel/integrity.ts";
import { utf8ByteOffset } from "../../../src/text/utf8-offsets.ts";

function spanFromCodeUnits(text, start, end, ruleId) {
  return Object.freeze({
    startByte: utf8ByteOffset(text, start),
    endByte: utf8ByteOffset(text, end),
    ruleId
  });
}

function allRegexMatches(expression, text, ruleId) {
  const flags = [...new Set((expression.flags + "g").split(""))].join("");
  const regex = new RegExp(expression.source, flags);
  const spans = [];
  for (const match of text.matchAll(regex)) {
    if (match.index === undefined || match[0].length === 0) throw new Error("candidate_empty_match");
    spans.push(spanFromCodeUnits(text, match.index, match.index + match[0].length, ruleId));
  }
  return spans;
}

const currentIdentityInput = SECRET_TEXT_SIGNAL_CATALOG.map((entry) => ({
  id: entry.id,
  source: entry.admission.source,
  flags: entry.admission.flags
}));

const CURRENT_PRODUCTION_REGEX = Object.freeze({
  id: "current-production-regex",
  mechanismIdentity: sha256(JSON.stringify(currentIdentityInput)),
  detect({ text }) {
    return SECRET_TEXT_SIGNAL_CATALOG.flatMap((entry) =>
      allRegexMatches(entry.admission, text, entry.id)
    );
  }
});

function literalMatches(bytes, values) {
  const matches = [];
  for (const value of values) {
    const needle = Buffer.from(value, "utf8");
    let offset = 0;
    while (offset <= bytes.length - needle.length) {
      const startByte = bytes.indexOf(needle, offset);
      if (startByte < 0) break;
      matches.push({ startByte, endByte: startByte + needle.length, ruleId: "known-value" });
      offset = startByte + 1;
    }
  }
  matches.sort((left, right) =>
    (right.endByte - right.startByte) - (left.endByte - left.startByte) ||
    left.startByte - right.startByte || left.endByte - right.endByte
  );
  const selected = [];
  for (const match of matches) {
    if (selected.some((prior) => match.startByte < prior.endByte && prior.startByte < match.endByte)) continue;
    selected.push(Object.freeze(match));
  }
  return selected.sort((left, right) => left.startByte - right.startByte || left.endByte - right.endByte);
}

const KNOWN_VALUE_LITERAL = Object.freeze({
  id: "known-value-literal",
  mechanismIdentity: sha256("known-value-literal/longest-overlap/v1"),
  detect({ bytes, knownValues }) {
    return literalMatches(bytes, knownValues);
  }
});

const PLACEHOLDERS = new Set(["YOUR_API_KEY_HERE", "CHANGEME", "EXAMPLE", "REPLACE_ME"]);
const PRIVATE_BEGIN = "-----BEGIN PRIVATE " + "KEY-----";
const PRIVATE_END = "-----END PRIVATE " + "KEY-----";
const CONTEXT_PATTERNS = Object.freeze([
  Object.freeze({ id: "provider-prefix", regex: /\b(?:mbh_|sk_|rk_|pk_|ghp_|github_pat_)[A-Za-z0-9_-]{20,}\b/dgu, capture: 0 }),
  Object.freeze({ id: "aws-access-key", regex: /\bAKIA[A-Z0-9]{16}\b/dgu, capture: 0 }),
  Object.freeze({ id: "bearer", regex: /\bBearer\s+([A-Za-z0-9._~+\/-]{16,}={0,2})\b/dgiu, capture: 1 }),
  Object.freeze({
    id: "assignment",
    regex: /\b(?:api[_ -]?key|authorization|password|private[_ -]?key|secret|session[_ -]?token)\b\s*[:=]\s*(["']?)([A-Za-z0-9+\/_?=-]{16,})\1/dgiu,
    capture: 2
  }),
  Object.freeze({
    id: "private-key-body",
    regex: new RegExp(PRIVATE_BEGIN + "\\r?\\n([A-Za-z0-9+/=\\r\\n]+)\\r?\\n" + PRIVATE_END, "dgu"),
    capture: 1
  })
]);

function isSafeAssignmentValue(value, matchText) {
  if (PLACEHOLDERS.has(value)) return true;
  if (/^(?:load|resolve|create)_[a-z0-9_]+$/iu.test(value)) return true;
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(value) && matchText.endsWith(value);
}

const CONTEXT_AWARE = Object.freeze({
  id: "context-aware-lexical",
  mechanismIdentity: sha256(JSON.stringify(CONTEXT_PATTERNS.map((entry) => ({
    id: entry.id,
    source: entry.regex.source,
    flags: entry.regex.flags,
    capture: entry.capture
  })))),
  detect({ text }) {
    const spans = [];
    for (const entry of CONTEXT_PATTERNS) {
      for (const match of text.matchAll(entry.regex)) {
        const indices = match.indices?.[entry.capture];
        const value = match[entry.capture];
        if (!indices || value === undefined || value.length === 0) throw new Error("candidate_capture_missing");
        if (entry.id === "assignment" && isSafeAssignmentValue(value, match[0])) continue;
        spans.push(spanFromCodeUnits(text, indices[0], indices[1], entry.id));
      }
    }
    return spans;
  }
});

export const SECRET_SPAN_CANDIDATES = Object.freeze([
  CURRENT_PRODUCTION_REGEX,
  KNOWN_VALUE_LITERAL,
  CONTEXT_AWARE
]);
