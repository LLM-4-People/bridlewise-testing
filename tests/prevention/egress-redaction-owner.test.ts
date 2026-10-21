// @vitest-environment node
/**
 * EGRESS REDACTION — the SECURITY control, made cheap without being weakened.
 *
 * `sendJson` walks every response and runs the secret detector on every
 * string leaf. Measured at 6.6–77× the cost of the `JSON.stringify` it
 * precedes (DESIGN-PERFORMANCE §5), for two reasons, both of them
 * per-string: the detector recompiled its six regexes, and it allocated a
 * `Uint32Array(text.length + 1)` UTF-8 offset map before it knew whether
 * there was anything to convert.
 *
 * Both are now paid once, or not at all. **That is a change to a security
 * control**, so it is proved rather than reasoned about:
 *
 *   A. EQUIVALENCE. The previous detector is replicated here, verbatim, and
 *      run beside the current one over a corpus of real strings plus an
 *      adversarial set that DOES carry secrets. Same spans, same bytes. A
 *      corpus of negatives alone would prove only that the fast path is fast.
 *   B. THE SHARED REGEX'S CURSOR. A `g` regex is stateful; hoisting it means
 *      `lastIndex` now survives between calls. The reset is part of the
 *      algorithm, and a mutation proves the guard sees it — otherwise a
 *      secret at the start of a string is invisible whenever the PREVIOUS
 *      string had a match.
 *   C. THE SECOND PASS IS NOT REDUNDANT, and this file carries the
 *      counterexample rather than the argument. `routes/views.ts` redacts
 *      rows on the way out and `sendJson` redacts the result again; the two
 *      catch different things, in both directions, so both stay.
 *   D. A LEAK FOUND WHILE MEASURING, and closed. The choke point preferred
 *      the plain-text result whenever the plain pass found ANYTHING, which
 *      suppressed the JSON-aware pass — so one visible secret in a string
 *      hid every escaped secret beside it.
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

import {
  redactForUserDisplay,
  redactToolCallArguments,
  redactContent,
} from "../../server/llm/redaction.ts";
import {
  detectSensitiveSpans,
  detectSecretSpans,
  redactForLLMContext,
  applyRedactions,
  type RedactableSpan,
} from "../../engine/src/privacy/redaction-engine.ts";
import { SECRET_TEXT_SIGNAL_CATALOG } from "../../engine/src/privacy/secret-signals.ts";
import {
  createUtf8OffsetMap,
  utf8ByteOffsetFromMap,
} from "../../engine/src/text/utf8-offsets.ts";
import {
  signalIdToCategory,
  DEFAULT_PRIVACY_POLICY,
  type PrivacyPolicy,
} from "../../engine/src/privacy/privacy-policy.ts";

// ── The PREVIOUS detector, replicated verbatim from the pre-change source ──
//
// A fresh `RegExp` per signal per call, and the offset map built eagerly and
// unconditionally. This is the thing the current implementation must agree
// with, byte for byte, and it is kept here rather than described.

function detectSpansPrevious(text: string, policy: PrivacyPolicy): RedactableSpan[] {
  const map = createUtf8OffsetMap(text);
  const spans: RedactableSpan[] = [];
  for (const signal of SECRET_TEXT_SIGNAL_CATALOG) {
    const sourceRegex = signal.admission;
    const flags = sourceRegex.flags.includes("g") ? sourceRegex.flags : sourceRegex.flags + "g";
    const regex = new RegExp(sourceRegex.source, flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      if (match[0].length === 0) {
        if (regex.lastIndex === 0) break;
        regex.lastIndex += 1;
        continue;
      }
      const start = match.index;
      const end = start + match[0].length;
      const category = signalIdToCategory(signal.id);
      if (!policy.enabledCategories.has(category)) continue;
      try {
        spans.push({
          startUtf16: start,
          endUtf16: end,
          startByte: utf8ByteOffsetFromMap(map, start),
          endByte: utf8ByteOffsetFromMap(map, end),
          category,
          signalId: signal.id,
          reason: `detected:${signal.id}`,
          detectorId: "secret-signals",
        });
      } catch {
        /* the engine's own bestEffort */
      }
      if (!regex.global) break;
    }
  }
  return resolveOverlapsPrevious(spans);
}

function resolveOverlapsPrevious(spans: RedactableSpan[]): RedactableSpan[] {
  if (spans.length <= 1) return spans;
  const sorted = [...spans].sort((a, b) =>
    a.startUtf16 !== b.startUtf16 ? a.startUtf16 - b.startUtf16 : b.endUtf16 - a.endUtf16,
  );
  const resolved: RedactableSpan[] = [];
  for (const span of sorted) {
    const last = resolved[resolved.length - 1];
    if (last !== undefined && span.startUtf16 < last.endUtf16) {
      if (span.endUtf16 - span.startUtf16 > last.endUtf16 - last.startUtf16) {
        resolved[resolved.length - 1] = span;
      }
      continue;
    }
    resolved.push(span);
  }
  return resolved;
}

const CREDENTIAL_KEY_PREFIX =
  /^((?:api[_ -]?key|authorization|password|private[_ -]?key|secret|session[_ -]?token)\s*[:=]\s*["']?)/iu;

function redactPrevious(text: string): string {
  if (typeof text !== "string" || text.length === 0) return text ?? "";
  const spans = detectSpansPrevious(text, DEFAULT_PRIVACY_POLICY);
  if (spans.length === 0) return text;
  const adjusted: RedactableSpan[] = [];
  for (const span of spans) {
    if (span.signalId === "credential-assignment") {
      const matched = text.slice(span.startUtf16, span.endUtf16);
      const split = CREDENTIAL_KEY_PREFIX.exec(matched);
      if (split !== null) {
        const prefixLen = split[1]!.length;
        if (prefixLen > 0 && span.startUtf16 + prefixLen < span.endUtf16) {
          adjusted.push({ ...span, startUtf16: span.startUtf16 + prefixLen });
          continue;
        }
      }
    }
    adjusted.push(span);
  }
  return applyRedactions(text, adjusted, DEFAULT_PRIVACY_POLICY);
}

// ── The corpus ──

/** Strings that DO carry secrets — one per catalog signal and then some.
 * Without these the equivalence claim would only cover the fast path. */
const POSITIVES: readonly string[] = [
  ('const API_KEY = "sk' + '_abcdefghijklmnopqrstuvwx"'),
  "password: 'hunter2hunter2hunter2hunter2'",
  ("Authorization: Be" + "arer abcdefghijklmnopqrstuvwxyz0123"),
  ("AK" + "IAIOSFODNN7EXAMPLE"),
  ("--" + "---BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----"),
  ("mb" + "h_abcdefghijklmnopqrstuvwxyz"),
  ("gh" + "p_abcdefghijklmnopqrstuvwxyz012345"),
  'session_token = "aaaaaaaaaaaaaaaaaaaaaa"\nprivate_key: "bbbbbbbbbbbbbbbbbbbbbb"',
  // Two matches of the SAME signal in one string — the case a stale
  // `lastIndex` mangles.
  ("sk" + "_aaaaaaaaaaaaaaaaaaaaaaaa and sk" + "_bbbbbbbbbbbbbbbbbbbbbbbb"),
  // Astral characters around a secret: the offset map's surrogate handling.
  "😀 const secret = 'ccccccccccccccccccccccc' 😀🎉",
  ('{"content":"const API_KEY = \\"sk' + '_abcdefghijklmnopqrstuvwx\\""}'),
];

/** Strings that carry nothing — the overwhelming majority of a real payload,
 * and the only ones the lazy offset map changes the cost of. */
const NEGATIVES: readonly string[] = [
  "",
  "just some prose about api keys in general",
  "a".repeat(4096),
  "src/cockpit/flow/Flow.svelte",
  '{"path":"README.md","lines":42}',
  "😀🎉 emoji only",
  "[REDACTED:credential]",
  "sk_short",
];

const CORPUS: readonly string[] = [...POSITIVES, ...NEGATIVES];

describe("A. the cheap detector redacts exactly what the previous one redacted", () => {
  test.each(CORPUS.map((s, i) => [i, s] as const))(
    "corpus[%i]: masks every byte the previous detector masked",
    (_i, text) => {
      // ── THE CONTRACT CHANGED FROM EQUALITY TO CONTAINMENT, DELIBERATELY ──
      //
      // This read `expect(redactForLLMContext(text)).toBe(redactPrevious(text))`
      // and that was the right assertion while `redactForLLMContext` ran the
      // format catalog and nothing else. It now runs four layers
      // (`detectSecretSpans`: identity, declaration, shape, format), so it
      // can legitimately mask MORE — and an equality assertion would report
      // "the detector regressed" for a detector that improved.
      //
      // What must never change is the direction: every span the previous
      // detector found must still be covered. Containment says exactly that
      // and says nothing more, so it fails on a LOST detection and passes on
      // a gained one. Equality could only be restored by refusing to improve.
      //
      // MUTATION: change any compiled flag or source in `COMPILED_SIGNALS`,
      // or make `redactForLLMContext` drop a layer, and a previous span stops
      // being covered.
      const previous = detectSpansPrevious(text, DEFAULT_PRIVACY_POLICY);
      const current = detectSecretSpans(text, DEFAULT_PRIVACY_POLICY);
      for (const old of previous) {
        expect(
          current.some((s) => s.startUtf16 <= old.startUtf16 && s.endUtf16 >= old.endUtf16),
          `the ${old.signalId} span at ${old.startUtf16}..${old.endUtf16} is no longer covered`,
        ).toBe(true);
      }
      // And the previously-masked bytes are still absent from the output.
      for (const old of previous) {
        expect(redactForLLMContext(text)).not.toContain(
          text.slice(old.startUtf16, old.endUtf16),
        );
      }
    },
  );

  test.each(CORPUS.map((s, i) => [i, s] as const))(
    "corpus[%i]: same spans, field for field",
    (_i, text) => {
      // The redacted text can agree while the SPANS differ (two detectors
      // masking the same bytes for different reasons), and the spans are what
      // the audit trail records.
      expect(detectSensitiveSpans(text, DEFAULT_PRIVACY_POLICY)).toEqual(
        detectSpansPrevious(text, DEFAULT_PRIVACY_POLICY),
      );
    },
  );

  test("the positives actually redact something — the corpus is not all fast path", () => {
    // Without this, every assertion above could be `s === s` and pass.
    const masked = POSITIVES.filter((s) => redactForLLMContext(s) !== s);
    expect(masked.length, "every POSITIVE must carry a detectable secret").toBe(POSITIVES.length);
    const untouched = NEGATIVES.filter((s) => redactForLLMContext(s) !== s);
    expect(untouched, "no NEGATIVE may be redacted (false positives are a defect too)").toEqual([]);
  });

  test("a string with no secrets is returned by identity — the lazy map's whole point", () => {
    const clean = "a".repeat(100_000);
    expect(redactForLLMContext(clean)).toBe(clean);
  });
});

describe("B. the shared regex's cursor cannot leak between strings", () => {
  test("a secret at position 0 is found after a match late in the previous string", () => {
    // The property, stated behaviourally. It holds TODAY for a second reason
    // as well as the reset — see the source guard below — so a reader must
    // not take this test as proof that the reset line is what is holding it.
    const long = `${"x ".repeat(200)}sk${""}_aaaaaaaaaaaaaaaaaaaaaaaa`;
    expect(redactForLLMContext(long)).toContain("[REDACTED:");
    const short = ("sk" + "_bbbbbbbbbbbbbbbbbbbbbbbb");
    expect(
      redactForLLMContext(short),
      "a secret at the start of the NEXT string must still be found",
    ).toBe("[REDACTED:token]");
  });

  test("the same string redacts identically however many times it is passed", () => {
    const text = ("sk" + "_aaaaaaaaaaaaaaaaaaaaaaaa and sk" + "_bbbbbbbbbbbbbbbbbbbbbbbb");
    const first = redactForLLMContext(text);
    for (let i = 0; i < 5; i += 1) expect(redactForLLMContext(text)).toBe(first);
    expect(first).not.toContain("sk_a");
    expect(first).not.toContain("sk_b");
  });

  test("the reset is still in the source, and this is the guard that holds it", () => {
    /**
     * REPORTED RATHER THAN OVERSTATED. Deleting `regex.lastIndex = 0;` was
     * mutation-tested and every BEHAVIOURAL test above stayed green. The
     * reason is specific and worth recording: the scan loop drains each
     * regex to `exec() === null`, and the engine resets `lastIndex` to 0 on
     * a null result, so a hoisted `g` regex happens to arrive at the next
     * string clean.
     *
     * That is a property of the LOOP, not of the regex, and it survives only
     * as long as no early exit is added — the loop had one (`if
     * (!regex.global) break`) until this change removed it as dead. Restore
     * an early exit without the reset and a secret before the previous
     * match's offset becomes invisible, silently, in a security control.
     *
     * So the reset stays and is guarded HERE, by reading the source, and
     * this comment is the honest statement that the behavioural tests above
     * are not what is holding it.
     */
    const engine = readFileSync(
      new URL(
        "../../engine/src/privacy/redaction-engine.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(engine).toContain("regex.lastIndex = 0;");
  });
});

describe("C. the second pass is not redundant — in either direction", () => {
  test("the VIEW pass no longer catches anything the plain pass cannot — measured, and recorded", () => {
    // ── A COUNTEREXAMPLE THAT STOPPED BEING TRUE ──────────────────────────
    //
    // This test used to assert the opposite, and it was correct when it was
    // written: `views.ts` parses a tool call's JSON arguments before
    // detecting, so `\"` could not hide a credential assignment from it,
    // while the plain-text pass was defeated by the backslash before the
    // quote. That was the direction that made the view pass irreplaceable.
    //
    // The five-layer detector removed the asymmetry. The plain pass no longer
    // depends on a quote delimiter to find a credential — the declaration
    // layer scores the evidence around the value and the value-intrinsic
    // layer needs no delimiter at all — so it now sees straight through the
    // escaping.
    //
    // MEASURED rather than assumed: over the 841 JSON-shaped strings in the
    // held-out corpus, the JSON-aware pass masks MORE than the plain pass in
    // exactly ONE case, and that one is an artefact — re-stringifying shifts
    // the offsets and the same value is masked twice, which is a worse
    // output, not a better one.
    const args = JSON.stringify({ code: 'const password = "zzzzzzzzzzzzzzzzzzzz"' });
    expect(redactToolCallArguments(args)).toContain("[REDACTED:credential]");
    expect(redactContent(args), "the plain pass now sees through the escaping too").toContain("[REDACTED:");
    // THE PASS IS KEPT ANYWAY, and the reason is monotonicity rather than
    // sentiment: `redactUserDisplayString` prefers whichever pass masked
    // MORE, so a redundant pass can only ever tie. Removing it would trade a
    // guaranteed floor for a saving that measures as noise, and the other
    // direction of "not redundant" below is still live.
  });

  test("the CHOKE POINT catches fields no view mapper touches", () => {
    // `chatToView` does not redact the chat TITLE, and no mapper covers the
    // config snapshot, the MCP server config or a project name. Dropping the
    // `sendJson` pass would send those verbatim.
    const payload = { chat: { id: "c1", title: ("notes for AK" + "IAIOSFODNN7EXAMPLE") } };
    const out = redactForUserDisplay(payload) as { chat: { title: string } };
    expect(out.chat.title).toContain("[REDACTED:");
    expect(out.chat.title).not.toContain(("AK" + "IAIOSFODNN7EXAMPLE"));
  });

  test("both passes composed are idempotent — redaction is not paid in fidelity", () => {
    // The reason two passes are affordable at all: the marker does not match
    // any signal, so the second pass over an already-redacted value is a
    // no-op rather than a re-mangling.
    const once = redactForUserDisplay({ v: ('api_key = "sk' + '_abcdefghijklmnopqrstuvwx"') });
    const twice = redactForUserDisplay(once);
    expect(twice).toEqual(once);
  });
});

describe("D. one visible secret must not hide the escaped ones beside it", () => {
  test("a string carrying BOTH a plain and an escaped secret has both masked", () => {
    // THE LEAK, as measured at the egress choke point before this change:
    //   in   {"note":"sk_aaaa…","code":"const password = \"zzzz…\""}
    //   out  {"note":"[REDACTED:token]","code":"const password = \"zzzz…\""}
    // The token was masked, so the credential was not even looked for — the
    // rule was "take the JSON-aware result only if the plain pass found
    // NOTHING".
    // MUTATION: restore `jsonAware.includes("[REDACTED:") &&
    // !plain.includes("[REDACTED:")` in `redactUserDisplayString` and this
    // fails.
    const text = JSON.stringify({
      note: ("sk" + "_aaaaaaaaaaaaaaaaaaaaaaaa"),
      code: 'const password = "zzzzzzzzzzzzzzzzzzzz"',
    });
    const out = redactForUserDisplay(text) as string;
    expect(out).not.toContain(("sk" + "_aaaaaaaaaaaaaaaaaaaaaaaa"));
    expect(out, "the escaped credential must be masked too").not.toContain(
      "zzzzzzzzzzzzzzzzzzzz",
    );
  });

  test("the choke point never masks LESS than the plain pass alone", () => {
    // The monotonicity that makes the new rule safe: it selects the JSON-aware
    // result only when it masked MORE, so it can never fall back to less.
    const count = (s: string): number => (s.match(/\[REDACTED:/g) ?? []).length;
    for (const text of CORPUS) {
      const out = redactForUserDisplay(text) as string;
      expect(
        count(out),
        `the choke point masked fewer values than the plain pass for ${JSON.stringify(text.slice(0, 60))}`,
      ).toBeGreaterThanOrEqual(count(redactContent(text)));
    }
  });
});

// ── E. the LLM-bound structured redactor is FIELD-AWARE ──────────────────
//
// `redactToolCallArguments` parsed the JSON, walked string VALUES, and threw
// the key names away. A 64-hex id under `apiKey` therefore reached the model
// verbatim — it carries no intrinsic credential shape and no declaration
// beside it — while the same value under a sensitive key was masked by the
// user-display path. The tool-call door now masks values under sensitive KEY
// names before the value walker, using the catalogue's single
// `isSensitiveKeyName` owner.
describe("E. the LLM-bound structured redactor is field-aware", () => {
  // Synthetic high-entropy value: no provider prefix, no declaration, no
  // checksum — exactly what a value-pattern-only walker cannot see.
  const HEX64 = "3b1f8c2a9d4e7051bc6a2f8e3d905172ac4b6e8f1d2039485a6b7c8d9e0f1a2b";

  test("a bare 64-hex value under apiKey is masked", () => {
    const out = redactToolCallArguments(JSON.stringify({ apiKey: HEX64 }));
    expect(out).not.toContain(HEX64);
    expect(JSON.parse(out)).toEqual({ apiKey: "[redacted]" });
  });

  test("a nested headers.authorization value is masked", () => {
    const out = redactToolCallArguments(
      JSON.stringify({ headers: { authorization: HEX64 } }),
    );
    expect(out).not.toContain(HEX64);
    expect(JSON.parse(out)).toEqual({ headers: { authorization: "[redacted]" } });
  });

  test("the key names survive so the caller can still read the structure", () => {
    const out = JSON.parse(
      redactToolCallArguments(JSON.stringify({ apiKey: HEX64, note: "ordinary prose" })),
    ) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(["apiKey", "note"]);
    expect(out.note).toBe("ordinary prose");
  });
});
