import { createRequire } from "node:module";
import { canonicalHash, canonicalJson } from "../../../src/kernel/integrity.ts";

const require = createRequire(import.meta.url);
const { parse: parseJavaScript } = require("@babel/parser");
const REDACTION_MARKER = "<redacted>";
const RESOURCE_CODES = new Set([
  "candidate_cancelled",
  "candidate_input_byte_limit",
  "candidate_match_limit",
  "candidate_memory_limit",
  "candidate_timeout"
]);

export function strictUtf8(bytes) {
  const buffer = Buffer.from(bytes);
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    throw new Error("utf8_bom_forbidden");
  }
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer);
  if (!Buffer.from(text, "utf8").equals(buffer)) throw new Error("utf8_roundtrip_invalid");
  return text;
}

function lineCount(text) {
  if (text.length === 0) return 0;
  return 1 + [...text].filter((character) => character === "\n").length;
}

function spanKey(span) {
  return span.startByte + ":" + span.endByte;
}

function normalizeSpans(bytes, proposed) {
  if (!Array.isArray(proposed)) throw new Error("candidate_spans_invalid");
  const normalized = [];
  const exactRanges = new Set();
  for (const span of proposed) {
    if (!Number.isSafeInteger(span?.startByte) || !Number.isSafeInteger(span?.endByte) ||
      span.startByte < 0 || span.endByte <= span.startByte || span.endByte > bytes.length ||
      typeof span.ruleId !== "string" || span.ruleId.length === 0) {
      throw new Error("candidate_span_invalid");
    }
    strictUtf8(bytes.subarray(span.startByte, span.endByte));
    const key = spanKey(span);
    if (exactRanges.has(key)) throw new Error("candidate_span_duplicate_or_alias");
    exactRanges.add(key);
    normalized.push(Object.freeze({ startByte: span.startByte, endByte: span.endByte, ruleId: span.ruleId }));
  }
  normalized.sort((left, right) =>
    left.startByte - right.startByte || left.endByte - right.endByte || left.ruleId.localeCompare(right.ruleId)
  );
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index].startByte < normalized[index - 1].endByte) {
      throw new Error("candidate_span_overlap");
    }
  }
  return Object.freeze(normalized);
}

function replacementFor(bytes) {
  const text = strictUtf8(bytes);
  return Buffer.from(text.replace(/[^\r\n]+/gu, REDACTION_MARKER), "utf8");
}

function applyRedactions(bytes, spans) {
  const chunks = [];
  let inputOffset = 0;
  for (const span of spans) {
    chunks.push(bytes.subarray(inputOffset, span.startByte));
    chunks.push(replacementFor(bytes.subarray(span.startByte, span.endByte)));
    inputOffset = span.endByte;
  }
  chunks.push(bytes.subarray(inputOffset));
  const sanitizedBytes = Buffer.concat(chunks);
  return Object.freeze({ sanitizedBytes, sanitizedText: strictUtf8(sanitizedBytes) });
}

function paginateUtf8(text, maximumBytes) {
  const pages = [];
  let page = "";
  let pageBytes = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (characterBytes > maximumBytes) throw new Error("page_character_budget");
    if (pageBytes > 0 && pageBytes + characterBytes > maximumBytes) {
      pages.push(page);
      page = "";
      pageBytes = 0;
    }
    page += character;
    pageBytes += characterBytes;
  }
  if (page.length > 0 || text.length === 0) pages.push(page);
  return Object.freeze(pages);
}

function countNeedleOccurrences(value, needles) {
  let occurrences = 0;
  for (const needle of needles) {
    if (needle.length < 4) continue;
    let offset = 0;
    while ((offset = value.indexOf(needle, offset)) >= 0) {
      occurrences += 1;
      offset += Math.max(1, needle.length);
    }
  }
  return occurrences;
}

function occurrenceCount(value, needle) {
  if (needle.length === 0) return 0;
  let count = 0;
  let offset = 0;
  while ((offset = value.indexOf(needle, offset)) >= 0) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function identifierMultiset(text) {
  const counts = new Map();
  for (const match of text.matchAll(/[$_\p{ID_Start}][$\u200c\u200d\p{ID_Continue}]*/gu)) {
    if (match[0] === "redacted") continue;
    counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

function lineOrientedParse(text) {
  for (const line of text.split(/\r?\n/u)) {
    if (line.length === 0 || /^\s/u.test(line) || line === REDACTION_MARKER) continue;
    if (!line.includes(":") && !line.includes("=")) throw new Error("line_oriented_parse");
  }
}

function parseProfile(profile, text) {
  if (profile === "none") return;
  if (profile === "json") {
    JSON.parse(text);
    return;
  }
  if (profile === "typescript") {
    parseJavaScript(text, { sourceType: "module", plugins: ["typescript"] });
    return;
  }
  if (profile === "line-oriented") {
    lineOrientedParse(text);
    return;
  }
  throw new Error("parser_profile_unknown");
}

function parserValid(profile, text) {
  try {
    parseProfile(profile, text);
    return true;
  } catch {
    return false;
  }
}

function publicSurfaces(fixture, candidateId, projection, pageBudgets) {
  const pagesByBudget = pageBudgets.map((maximumBytes) => ({
    maximumBytes,
    pages: paginateUtf8(projection.sanitizedText, maximumBytes)
  }));
  return Object.freeze({
    sanitizedResult: projection.sanitizedText,
    pagesByBudget,
    receipt: {
      schemaVersion: "bridlewise-secret-span-public-receipt/v2",
      requestHandle: fixture.id + ":" + candidateId,
      outcome: "sanitized"
    },
    progress: { requestHandle: fixture.id + ":" + candidateId, phase: "completed" },
    log: { requestHandle: fixture.id + ":" + candidateId, code: "sanitization_completed" },
    error: null,
    cacheKey: null,
    indexDocument: projection.sanitizedText,
    telemetry: { requestHandle: fixture.id + ":" + candidateId, outcome: "sanitized" }
  });
}

function blockedSurfaces(fixture, candidateId, code) {
  return Object.freeze({
    sanitizedResult: null,
    pagesByBudget: [],
    receipt: { requestHandle: fixture.id + ":" + candidateId, outcome: "blocked", code },
    progress: { requestHandle: fixture.id + ":" + candidateId, phase: "blocked" },
    log: { requestHandle: fixture.id + ":" + candidateId, code },
    error: { requestHandle: fixture.id + ":" + candidateId, code },
    cacheKey: null,
    indexDocument: null,
    telemetry: { requestHandle: fixture.id + ":" + candidateId, outcome: "blocked", code }
  });
}

function pageBoundaryOccurrences(pagesByBudget, needles) {
  let occurrences = 0;
  for (const { pages } of pagesByBudget) {
    for (const page of pages) occurrences += countNeedleOccurrences(page, needles);
    for (let index = 1; index < pages.length; index += 1) {
      occurrences += countNeedleOccurrences(pages[index - 1] + pages[index], needles);
    }
    occurrences += countNeedleOccurrences(pages.join(""), needles);
  }
  return occurrences;
}

function fixtureDeterminismProjection(spans, projection, surfaces, code) {
  return canonicalHash({
    spans,
    sanitizedText: projection?.sanitizedText ?? null,
    surfaces,
    code
  });
}

export function validateFixtureOracle(fixture) {
  let text;
  try {
    text = strictUtf8(fixture.bytes);
  } catch {
    if (fixture.expectedDisposition !== "blocked-invalid-utf8") throw new Error("fixture_unexpected_invalid_utf8");
    return Object.freeze({ parserChecks: 0, safeNameTokens: 0 });
  }
  if (fixture.expectedDisposition === "blocked-invalid-utf8") throw new Error("fixture_invalid_utf8_oracle_vacuous");
  const spans = normalizeSpans(fixture.bytes, fixture.expectedSpans.map((span) => ({ ...span, ruleId: "oracle" })));
  const expectedProjection = applyRedactions(fixture.bytes, spans);
  if (!parserValid(fixture.parserProfile, text) || !parserValid(fixture.parserProfile, expectedProjection.sanitizedText)) {
    throw new Error("fixture_parser_oracle_invalid");
  }
  const safeMaskedText = strictUtf8(fixture.safeMaskedBytes);
  const names = identifierMultiset(safeMaskedText);
  for (const fragment of fixture.requiredSafeFragments) {
    if (occurrenceCount(text, fragment) === 0) throw new Error("fixture_safe_fragment_oracle_missing");
  }
  return Object.freeze({
    parserChecks: fixture.parserProfile === "none" ? 0 : 1,
    safeNameTokens: Object.values(names).reduce((total, count) => total + count, 0)
  });
}

export function evaluateFixture({ candidateId, fixture, proposedSpans, executionError, pageBudgets }) {
  let text;
  try {
    text = strictUtf8(fixture.bytes);
  } catch {
    if (fixture.expectedDisposition !== "blocked-invalid-utf8") throw new Error("fixture_unexpected_invalid_utf8");
    const surfaces = blockedSurfaces(fixture, candidateId, "unsupported_text_encoding");
    return Object.freeze({
      fixtureId: fixture.id,
      expectedCount: 0,
      predictedCount: 0,
      truePositiveCount: 0,
      falseRedactionCount: 0,
      safeFragmentChecks: 0,
      safeFragmentsPreserved: 0,
      safeByteSkeletonPreserved: true,
      parserCheck: false,
      parserValid: true,
      safeNameCheck: false,
      safeNameMultisetPreserved: true,
      multiplicityPreserved: true,
      linePreserved: true,
      paginationReconstructed: true,
      invalidUtf8Blocked: true,
      candidateException: false,
      resourceBudgetViolation: false,
      publicSurfaceCanaryOccurrences: countNeedleOccurrences(canonicalJson(surfaces), fixture.leakNeedles),
      pageBoundaryCanaryOccurrences: 0,
      determinismIdentity: fixtureDeterminismProjection([], null, surfaces, "unsupported_text_encoding")
    });
  }

  if (executionError !== null) {
    const code = RESOURCE_CODES.has(executionError) ? executionError : "detector_failure";
    const surfaces = blockedSurfaces(fixture, candidateId, code);
    return Object.freeze({
      fixtureId: fixture.id,
      expectedCount: fixture.expectedSpans.length,
      predictedCount: 0,
      truePositiveCount: 0,
      falseRedactionCount: 0,
      safeFragmentChecks: fixture.requiredSafeFragments.length,
      safeFragmentsPreserved: 0,
      safeByteSkeletonPreserved: false,
      parserCheck: fixture.parserProfile !== "none",
      parserValid: false,
      safeNameCheck: true,
      safeNameMultisetPreserved: false,
      multiplicityPreserved: false,
      linePreserved: false,
      paginationReconstructed: false,
      invalidUtf8Blocked: false,
      candidateException: !RESOURCE_CODES.has(executionError),
      resourceBudgetViolation: RESOURCE_CODES.has(executionError),
      publicSurfaceCanaryOccurrences: countNeedleOccurrences(canonicalJson(surfaces), fixture.leakNeedles),
      pageBoundaryCanaryOccurrences: 0,
      determinismIdentity: fixtureDeterminismProjection([], null, surfaces, code)
    });
  }

  let spans;
  try {
    spans = normalizeSpans(fixture.bytes, proposedSpans);
  } catch {
    return evaluateFixture({
      candidateId,
      fixture,
      proposedSpans: [],
      executionError: "detector_failure",
      pageBudgets
    });
  }
  const expected = new Set(fixture.expectedSpans.map(spanKey));
  const predicted = new Set(spans.map(spanKey));
  const truePositiveCount = [...predicted].filter((key) => expected.has(key)).length;
  const falseRedactionCount = [...predicted].filter((key) => !expected.has(key)).length;
  const projection = applyRedactions(fixture.bytes, spans);
  const surfaces = publicSurfaces(fixture, candidateId, projection, pageBudgets);
  const pagesReconstruct = surfaces.pagesByBudget.every(({ pages }) => pages.join("") === projection.sanitizedText);
  let safeFragmentChecks = 0;
  let safeFragmentsPreserved = 0;
  for (const fragment of fixture.requiredSafeFragments) {
    const expectedOccurrences = occurrenceCount(text, fragment);
    safeFragmentChecks += expectedOccurrences;
    if (occurrenceCount(projection.sanitizedText, fragment) === expectedOccurrences) {
      safeFragmentsPreserved += expectedOccurrences;
    }
  }
  const safeSkeleton = projection.sanitizedText.split(REDACTION_MARKER).join("");
  const expectedNames = identifierMultiset(strictUtf8(fixture.safeMaskedBytes));
  const actualNames = identifierMultiset(projection.sanitizedText);
  return Object.freeze({
    fixtureId: fixture.id,
    expectedCount: expected.size,
    predictedCount: predicted.size,
    truePositiveCount,
    falseRedactionCount,
    safeFragmentChecks,
    safeFragmentsPreserved,
    safeByteSkeletonPreserved: Buffer.from(safeSkeleton, "utf8").equals(fixture.safeSkeletonBytes),
    parserCheck: fixture.parserProfile !== "none",
    parserValid: parserValid(fixture.parserProfile, projection.sanitizedText),
    safeNameCheck: true,
    safeNameMultisetPreserved: canonicalJson(actualNames) === canonicalJson(expectedNames),
    multiplicityPreserved: predicted.size === expected.size,
    linePreserved: lineCount(text) === lineCount(projection.sanitizedText),
    paginationReconstructed: pagesReconstruct,
    invalidUtf8Blocked: false,
    candidateException: false,
    resourceBudgetViolation: false,
    publicSurfaceCanaryOccurrences: countNeedleOccurrences(canonicalJson(surfaces), fixture.leakNeedles),
    pageBoundaryCanaryOccurrences: pageBoundaryOccurrences(surfaces.pagesByBudget, fixture.leakNeedles),
    determinismIdentity: fixtureDeterminismProjection(spans, projection, surfaces, null)
  });
}
