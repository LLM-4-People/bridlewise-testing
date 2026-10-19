export const SYNTHETIC_SECRET_VALUES = Object.freeze({
  makora: "mbh_" + "A".repeat(48),
  provider: "sk_" + "B".repeat(40),
  aws: "AKIA" + "C".repeat(16),
  bearer: "eyJ" + "D".repeat(37),
  password: "S3cure+" + "E".repeat(12) + "/?" + "E".repeat(10),
  session: "sess-" + "F".repeat(28),
  "private-body": "MIIE" + "G".repeat(124),
  "overlap-short": "B".repeat(20)
});

function textPart(value, sensitive = false) {
  return Object.freeze({ value, sensitive });
}

function splitSensitive(value, width, separator) {
  const parts = [];
  for (let offset = 0; offset < value.length; offset += width) {
    if (offset > 0) parts.push(textPart(separator));
    parts.push(textPart(value.slice(offset, offset + width), true));
  }
  return parts;
}

function jsonUnicodeEscape(value) {
  return [...value].map((character) => {
    const codePoint = character.codePointAt(0);
    if (codePoint > 0xffff) throw new Error("fixture_unicode_escape_out_of_scope");
    return "\\u" + codePoint.toString(16).padStart(4, "0");
  }).join("");
}

export function syntheticCanaryNeedles() {
  const needles = new Set();
  for (const value of Object.values(SYNTHETIC_SECRET_VALUES)) {
    needles.add(value);
    needles.add(Buffer.from(value, "utf8").toString("base64"));
    needles.add(encodeURIComponent(value));
    needles.add(jsonUnicodeEscape(value));
  }
  return Object.freeze([...needles].filter((value) => value.length >= 4));
}

export function parserProfileForFixture(fixtureId) {
  if (fixtureId.startsWith("JSON-")) return "json";
  if (fixtureId.startsWith("TS-") || fixtureId.startsWith("JS-")) return "typescript";
  if (fixtureId.startsWith("ENV-") || fixtureId.startsWith("YAML-")) return "line-oriented";
  return "none";
}

function renderCarrier(value, carrier) {
  if (carrier === "plain") return [textPart(value, true)];
  if (carrier === "base64") return [textPart(Buffer.from(value, "utf8").toString("base64"), true)];
  if (carrier === "url-encoded") return [textPart(encodeURIComponent(value), true)];
  if (carrier === "json-unicode-escaped") return [textPart(jsonUnicodeEscape(value), true)];
  if (carrier === "yaml-block") return splitSensitive(value, 12, "\n  ");
  if (carrier === "private-key-lines") return splitSensitive(value, 32, "\n");
  if (carrier === "js-concatenated") {
    const pivot = Math.floor(value.length / 2);
    return [
      textPart("\""),
      textPart(value.slice(0, pivot), true),
      textPart("\" + \""),
      textPart(value.slice(pivot), true),
      textPart("\"")
    ];
  }
  throw new Error("fixture_carrier_unknown");
}

function appendPart(chunks, expectedSpans, leakNeedles, part, byteOffset) {
  const bytes = Buffer.from(part.value, "utf8");
  chunks.push(bytes);
  if (part.sensitive) {
    expectedSpans.push(Object.freeze({ startByte: byteOffset, endByte: byteOffset + bytes.length }));
    if (part.value.length >= 4) leakNeedles.add(part.value);
  }
  return byteOffset + bytes.length;
}

export function compileFixture(corpusId, fixture, budgets) {
  if (fixture.fragments.length > budgets.maximumFragmentsPerFixture) throw new Error("fixture_fragment_budget");
  const chunks = [];
  const safeChunks = [];
  const safeMaskChunks = [];
  const expectedSpans = [];
  const leakNeedles = new Set();
  let byteOffset = 0;
  for (const fragment of fixture.fragments) {
    if (fragment.kind === "text") {
      const fragmentBytes = Buffer.from(fragment.value, "utf8");
      if (fragmentBytes.length > budgets.maximumFragmentTextBytes) throw new Error("fixture_fragment_byte_budget");
      const part = textPart(fragment.value);
      byteOffset = appendPart(chunks, expectedSpans, leakNeedles, part, byteOffset);
      safeChunks.push(fragmentBytes);
      safeMaskChunks.push(fragmentBytes);
      continue;
    }
    if (fragment.kind === "invalid-bytes") {
      const bytes = Buffer.from(fragment.hex, "hex");
      chunks.push(bytes);
      safeChunks.push(bytes);
      safeMaskChunks.push(bytes);
      byteOffset += bytes.length;
      continue;
    }
    const value = SYNTHETIC_SECRET_VALUES[fragment.secretId];
    if (value === undefined) throw new Error("fixture_secret_id_unknown");
    leakNeedles.add(value);
    for (const part of renderCarrier(value, fragment.carrier)) {
      byteOffset = appendPart(chunks, expectedSpans, leakNeedles, part, byteOffset);
      const partBytes = Buffer.from(part.value, "utf8");
      if (part.sensitive) safeMaskChunks.push(Buffer.alloc(partBytes.length, 0x20));
      else {
        safeChunks.push(partBytes);
        safeMaskChunks.push(partBytes);
      }
    }
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length > budgets.maximumFixtureBytes) throw new Error("fixture_byte_budget");
  if (expectedSpans.length > budgets.maximumExpectedSpansPerFixture) throw new Error("fixture_expected_span_budget");
  for (let index = 0; index < expectedSpans.length; index += 1) {
    const span = expectedSpans[index];
    const previous = expectedSpans[index - 1];
    if (previous && span.startByte < previous.endByte) throw new Error("fixture_expected_span_overlap");
  }
  return Object.freeze({
    id: corpusId + "/" + fixture.id,
    corpusId,
    fixtureId: fixture.id,
    carrierClass: fixture.carrierClass,
    expectedDisposition: fixture.expectedDisposition,
    bytes,
    expectedSpans: Object.freeze(expectedSpans),
    leakNeedles: Object.freeze([...leakNeedles]),
    requiredSafeFragments: Object.freeze([...fixture.requiredSafeFragments]),
    safeSkeletonBytes: Buffer.concat(safeChunks),
    safeMaskedBytes: Buffer.concat(safeMaskChunks),
    parserProfile: parserProfileForFixture(fixture.id)
  });
}

export function compileCorpus(corpus, budgets) {
  if (corpus.fixtures.length > budgets.maximumFixturesPerCorpus) throw new Error("corpus_fixture_budget");
  const ids = new Set();
  return Object.freeze(corpus.fixtures.map((fixture) => {
    if (ids.has(fixture.id)) throw new Error("fixture_id_duplicate");
    ids.add(fixture.id);
    return compileFixture(corpus.id, fixture, budgets);
  }));
}

export function syntheticBrokerValues() {
  return Object.freeze(Object.values(SYNTHETIC_SECRET_VALUES));
}
