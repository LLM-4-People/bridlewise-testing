// @vitest-environment node
/**
 * THE FIVE LAYERS — what each one finds, what it refuses, and what is
 * honestly out of reach.
 *
 * `secret-intelligence-owner.test.ts` is the sibling of this file and covers
 * the declaration layer's own corpus and the equivalence proof against the
 * previous detector. This file covers what the rebuild ADDED:
 *
 *   A. the benign enumeration, which is the safety net under layer 4
 *   B. evasion — zero-width, homoglyph, full-width, escaped, concatenated
 *   C. the self-validating layer, which was declared and never used
 *   D. multi-language declarations, in real phrasings
 *   E. the learned vocabulary: bootstrap, inspect, forget, and isolation
 *   F. tiers: switching one off stops it and leaves the others running
 *   G. the registry: every gap is a stated fact
 *   H. determinism, across calls and across processes
 *   I. one detector — no path runs a weaker one
 *
 * MEASURED, NOT ASSERTED, wherever a number is claimed. The held-out figures
 * quoted in comments come from 7,412 positives (gitleaks, detect-secrets,
 * trufflehog) against 39,503 lines of ordinary source (lodash, the vue docs,
 * psf/requests) — data this agent did not write.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";

import {
  detectSecretSpans,
  detectSensitiveSpans,
  explainRedaction,
  redactForLLMContext,
  redactMessagesTogether,
  redactText,
} from "../../engine/src/privacy/redaction-engine.ts";
import {
  DEFAULT_PRIVACY_POLICY,
} from "../../engine/src/privacy/privacy-policy.ts";
import { viewFile } from "../../engine/src/privacy/file-viewer.ts";
import { secretTextSignalIds } from "../../engine/src/privacy/secret-signals.ts";
import { redactForUserDisplay } from "../../server/llm/redaction.ts";
import {
  configureDebugSystem,
  createCollectingSink,
  debugLog,
  resetDebugSystem,
} from "../../engine/src/shared/debug/debug-system.ts";
import { DEBUG_CONFIG_DEFAULTS } from "../../engine/src/shared/debug/debug-config.ts";
import {
  PII_TYPES,
  PRIVACY_TIERS,
  createPrivacySettings,
  currentPrivacySettings,
  enabledDetectorIds,
  resetPrivacySettings,
  setPrivacyTierEnabled,
  typeEnabled,
  unsupportedTypes,
  type PrivacyTierId,
} from "../../engine/src/privacy/pii-registry.ts";
import {
  DEFAULT_PRIVACY_TIERS_ENABLED,
} from "../../engine/src/privacy/privacy-config.ts";
import {
  benignTokenGrammar,
  BENIGN_TOKEN_GRAMMARS,
} from "../../engine/src/privacy/benign-grammars.ts";
import { createHash } from "node:crypto";

import { getArtifactIdLength } from "../../server/kernel/harness-config.ts";
import {
  entropyCandidates,
  registerAt,
  vowelRatio,
} from "../../engine/src/privacy/value-intrinsic.ts";
import {
  identitySpans,
  isPossibleUsSsn,
  passesAbaRouting,
  passesIbanMod97,
  passesLuhn,
  IDENTITY_DETECTOR_IDS,
} from "../../engine/src/privacy/identity-grammars.ts";
import { normalizeForDetection } from "../../engine/src/privacy/text-normalize.ts";
import {
  abbreviations,
  clearLearned,
  forgetLearnedTerm,
  inspectLearned,
  isAbbreviationShaped,
  lexiconForScope,
  prefixTruncations,
  seededLexicon,
  separatorVariants,
  LEXICON_WEIGHTS,
  MIN_LEARNING_OCCURRENCES,
} from "../../engine/src/privacy/credential-lexicon.ts";
import { read } from "../helpers/source-scan.ts";
import { bodyCalls, bodyCallsWith, functionBody } from "../helpers/function-scope.ts";

import { modulePath } from "../helpers/module-resolver.ts";
const P = DEFAULT_PRIVACY_POLICY;
const masked = (t: string): boolean => redactForLLMContext(t) !== t;

/** A synthetic key of each real shape. No real credential appears here. */
const V = {
  bareKey: "EZAK4uGRIsRx7x9q1HRU68UAb6qx42Bvw9bRXELoyxfH77J5s2ZX7CoEUi",
  anthropic: "sk-ant-api03-Ab3xQ9zLmN2pRt5vWy8uZc1dEf4gHj7kLm0nPq6rSt9uVw2xYz5a-Bc8dEfAA",
  hf: "hf_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  short: "Hx7Kq2Bd9Lp4",
} as const;

beforeEach(() => {
  clearLearned();
  resetPrivacySettings();
});
afterEach(() => {
  clearLearned();
  resetPrivacySettings();
});

// ── A. the benign enumeration ────────────────────────────────────────────

describe("A. the benign enumeration — the safety net under layer 4", () => {
  /**
   * THE WHOLE INVERSION RESTS ON THIS LIST. Entropy now decides on its own,
   * so the only thing between this engine and a masked git log is the set of
   * ordinary things it refuses to call secrets. Every entry is high-entropy
   * and every one must survive untouched.
   */
  const BENIGN: readonly Readonly<{ id: string; text: string }>[] = [
    { id: "git-sha-full", text: "commit d8250ea9f2c7d4e8b1a6350fe2947cd80b3a15e6 landed" },
    { id: "git-sha-short", text: "reverted 315cac7 yesterday" },
    { id: "uuid", text: 'row {"id":"3f2b9a1c-7d54-4e08-b6a3-19cd8f240e75"}' },
    { id: "uuid-braced", text: "guid {3f2b9a1c-7d54-4e08-b6a3-19cd8f240e75} here" },
    { id: "md5", text: "etag 708266cfeab817aaed88d81c23391298" },
    { id: "sha256", text: "sha256 3b1f8c2a9d4e7051bc6a2f8e3d905172ac4b6e8f1d2039485a6b7c8d9e0f1a2b" },
    { id: "sha512", text: `digest ${"a1b2c3d4e5f60718".repeat(8)}` },
    // The create_artifact result, VERBATIM: the artifactId is a sha256
    // slice this server issues, and the model must be able to reference
    // the artifact it just created (UIE-025 — the id went out as
    // [REDACTED:credential] and the record was not verbatim).
    {
      id: "artifact-id-tool-result",
      text: '{"ok":true,"artifactId":"3f2b9a1c7d54e08b","type":"html","title":"Deployment diagram","contentLength":8123,"scriptsChecked":0,"scriptsSkipped":0}',
    },
    { id: "iso-timestamp", text: "recorded 2026-07-27T11:03:42.512Z by the ledger" },
    { id: "iso-date", text: "due 2026-01-31 at the latest" },
    { id: "epoch-millis", text: "createdAt 1753000000000 in the row" },
    { id: "semver", text: "bumped to v10.4.17-beta.3 today" },
    { id: "mime", text: "served as application/vnd.api+json" },
    { id: "data-uri", text: '{"thumbnail":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"}' },
    { id: "url-fragment", text: "see https://play.vuejs.org/#eNo9jUEOgyAQRa8yYUO7aNkbNOkBegM2RseWRGACoxvC3TumxuX/" },
    { id: "path", text: "open src/cockpit/flow/FlowCanvas.svelte and read it" },
    { id: "dotted-name", text: "delete Object.getOwnPropertySymbols;" },
    { id: "camel-name", text: "const nativeGetSymbols = getOwnPropertySymbols" },
    { id: "word-phrase", text: "see Combining_Diacritical_Marks_for_Symbols" },
    { id: "alphabet", text: 'const B = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"' },
    { id: "hex-colour", text: "background #1b1f25 on the desk" },
    { id: "number", text: "elapsed 1234567.89 milliseconds" },
    { id: "number-with-unit", text: "Resource eventLoop.utilization: 0.4237013706696966ratio" },
    { id: "number-with-unit-epoch", text: "took 1725139200000000000ns flat" },
    { id: "response-id", text: "resp-4f2b9a1c7d544e08b6a319cd8f240e75 returned" },
  ];

  for (const c of BENIGN) {
    test(`${c.id} is never masked`, () => {
      expect(redactForLLMContext(c.text)).toBe(c.text);
    });
  }

  test("every benign grammar is REACHABLE — none is dead weight", () => {
    // A grammar nothing exercises is a claim nobody has checked, so each one
    // is probed with a token only IT explains.
    //
    // Probed directly rather than swept over the corpus above, and the
    // reason is worth recording: `benignTokenGrammar` returns the FIRST
    // grammar that matches, so `1234567.89` is reported as `semver` and
    // `number` looked dead. A sweep measures the ORDER of the list, not the
    // reachability of its members.
    const PROBES: Readonly<Record<string, string>> = {
      uuid: "3f2b9a1c-7d54-4e08-b6a3-19cd8f240e75",
      "provider-call-id": "chatcmpl-tool-b51f5c8c012ffaee",
      "hex-digest": "3b1f8c2a9d4e7051bc6a2f8e3d905172ac4b6e8f1d2039485a6b7c8d9e0f1a2b",
      "truncated-digest": "3f2b9a1c7d54e08b",
      "git-sha": "d8250ea",
      "iso-timestamp": "2026-07-27T11:03:42Z",
      "epoch-millis": "1753000000000",
      semver: "v10.4.17-beta.3",
      number: "-12.5e9",
      "number-with-unit": "0.4237013706696966ratio",
      "mime-type": "application/vnd.api+json",
      "hex-colour": "#1b1f25",
      identifier: "getOwnPropertySymbols",
      "dotted-name": "process.env.HOME",
      "word-phrase": "state-of-the-art",
      "character-set": "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    };
    const regionOnly = new Set(["url", "data-uri", "file-path"]);
    for (const grammar of BENIGN_TOKEN_GRAMMARS) {
      if (regionOnly.has(grammar.id)) continue;
      const probe = PROBES[grammar.id];
      expect(probe, `no probe declared for benign grammar "${grammar.id}"`).toBeDefined();
      expect(grammar.matches(probe!), `${grammar.id} does not match its own probe`).toBe(true);
      expect(entropyCandidates(`value ${probe!}`), `${grammar.id} probe was raised as a candidate`).toHaveLength(0);
    }
  });

  test("MUTATION: remove a benign grammar and git SHAs are masked", () => {
    // The mutation is applied to the INPUT rather than the source, because
    // what is being proved is that the grammar is load-bearing, not that a
    // particular line exists. A 40-hex digest is exactly a SHA-1.
    const sha = "d8250ea9f2c7d4e8b1a6350fe2947cd80b3a15e6";
    expect(benignTokenGrammar(sha)).toBe("hex-digest");
    expect(entropyCandidates(`commit ${sha}`)).toHaveLength(0);
    // The same 40 characters with one letter outside the hex alphabet is NOT
    // a digest, and is therefore a candidate — which is the grammar deciding,
    // and nothing else.
    const notSha = "d8250ea9f2c7d4e8b1a6350fe2947cd80b3a15eZ";
    expect(benignTokenGrammar(notSha)).toBeNull();
    expect(entropyCandidates(`commit ${notSha}`).length).toBeGreaterThan(0);
  });

  test("a truncated digest is structure, but a DECLARED credential of the same shape still masks (the stated tradeoff)", () => {
    // UIE-025: the artifact id (a sha256 slice) must survive; the veto is on
    // VALUE-INTRINSIC evidence only, so the same 16 hex characters DECLARED as
    // a credential are masked by the declaration layer exactly as before.
    const slice = "3f2b9a1c7d54e08b";
    expect(benignTokenGrammar(slice)).toBe("truncated-digest");
    expect(redactForLLMContext(`{"ok":true,"artifactId":"${slice}"}`)).toBe(
      `{"ok":true,"artifactId":"${slice}"}`,
    );
    const declared = redactForLLMContext(`apiKey = ${slice}`);
    expect(declared).toContain("[REDACTED:");
  });

  test("the truncated-digest grammar matches the ISSUER'S artifact-id length (grammar↔issuer, no drift)", () => {
    // The issuer is `sha256(content).slice(0, getArtifactIdLength())` in the
    // create_artifact handler; the grammar pins the length so the id this
    // server hands out is never masked by its own privacy layer. If the
    // issuer's default ever changes without this grammar, this arm reds
    // BEFORE a live run ships a masked id again.
    const slice = createHash("sha256").update("artifact-content").digest("hex").slice(0, getArtifactIdLength());
    expect(benignTokenGrammar(slice)).toBe("truncated-digest");
    expect(redactForLLMContext(`artifactId ${slice}`)).toBe(`artifactId ${slice}`);
  });

  test("MUTATION: the vowel rule is what separates a name from a key", () => {
    // Remove it and `getOwnPropertySymbols`-shaped runs become candidates.
    // Proved by the ratio itself rather than by a claim about it.
    expect(vowelRatio("getOwnPropertySymbols")).toBeGreaterThan(0.22);
    expect(vowelRatio("xnnhBfiSzMCACKWZfqsyNWunwUrTGpgIgA")).toBeLessThan(0.20);
  });

  test("the measurement grammar's veto is VALUE-INTRINSIC only — a declared credential of the same shape is still masked", () => {
    // The `number-with-unit` grammar admits `<number><unit>` — the shape of
    // every resource measurement the ledger's resource lane writes. A benign
    // grammar vetoes ONLY layer 4 (the value's own shape); the declaration
    // layer has evidence beyond the shape, so a credential introduced by a
    // credential noun must be masked even when its value reads exactly like
    // a measurement.
    const measurementShaped = "0.4237013706696966ratio";
    expect(benignTokenGrammar(measurementShaped)).toBe("number-with-unit");
    // Alone: benign — no layer has anything but the shape to go on.
    expect(redactForLLMContext(`utilization ${measurementShaped} stable`))
      .toBe(`utilization ${measurementShaped} stable`);
    // Declared: masked — the credential noun beside it is evidence the
    // benign veto does not reach.
    expect(redactForLLMContext(`the api key is ${measurementShaped} ok`))
      .toContain("[REDACTED:");
  });
});

// ── B. evasion ───────────────────────────────────────────────────────────

describe("B. evasion — a secret that has been made unreadable to a regex", () => {
  test("a zero-width space inside a key does not hide it", () => {
    const evaded = `${V.anthropic.slice(0, 6)}​${V.anthropic.slice(6)}`;
    expect(evaded).not.toContain(V.anthropic);
    expect(masked(evaded)).toBe(true);
  });

  test("a soft hyphen inside a key does not hide it", () => {
    const evaded = `${V.anthropic.slice(0, 10)}­${V.anthropic.slice(10)}`;
    expect(masked(evaded)).toBe(true);
  });

  test("full-width characters do not hide a declaration", () => {
    // `ｐａｓｓｗｏｒｄ＝` — every character is U+FF01..U+FF5E.
    const full = "ｐａｓｓｗｏｒｄ＝Hx7Kq2Bd9Lp4Rt8Wy";
    expect(normalizeForDetection(full).text).toContain("password=");
    expect(masked(full)).toBe(true);
  });

  test("a Cyrillic homoglyph does not hide a declaration", () => {
    // One Cyrillic `а` (U+0430) inside the English word.
    const homo = "my pаssword is Hx7Kq2Bd9Lp4Rt8Wy";
    // Witness: the homoglyph form IS the text under test, so its absence of the
    // ASCII spelling is a claim about something present, not about nothing.
    expect(homo).toContain("pаssword");
    expect(homo).not.toContain("password");
    expect(masked(homo)).toBe(true);
  });

  test("the span maps back to the REAL text, not the normalised copy", () => {
    // What gets masked is the user's own bytes. A span computed on the
    // normalised copy and applied to the original without mapping would cut
    // in the wrong place — visibly, and by exactly the number of characters
    // normalisation removed.
    const evaded = `key: ${V.anthropic.slice(0, 6)}​${V.anthropic.slice(6)}`;
    const out = redactForLLMContext(evaded);
    expect(out).not.toContain(V.anthropic.slice(6, 30));
    expect(out.startsWith("key: ")).toBe(true);
  });

  test("an escaped and a double-escaped copy are the same secret", () => {
    const together = redactMessagesTogether([
      "my database password may be Zq7Wm3Xr9Td2Lp",
      JSON.stringify({ code: 'const p = "Zq7Wm3Xr9Td2Lp"' }),
      JSON.stringify(JSON.stringify({ code: 'const p = "Zq7Wm3Xr9Td2Lp"' })),
    ]);
    for (const out of together.redacted) {
      expect(out).not.toContain("Zq7Wm3Xr9Td2Lp");
    }
  });

  test("STATED LIMIT: a value split across string concatenation is NOT found", () => {
    // `"EZAK4uGR" + "IsRx7x9q1HRU68UAb6qx42Bvw9bRXELoyxfH77J5s2ZX7CoEUi"` is
    // two tokens, and neither half is the secret. Reassembling it needs an
    // evaluator, and an evaluator on untrusted text is a worse problem than
    // the one it solves. Written as a passing test of the LIMIT rather than
    // left as an unexplained miss.
    const split = '"EZAK4uGR" + "IsRx7x9q"';
    expect(masked(split)).toBe(false);
    // The halves are each below the run floor, which is WHY it is missed —
    // not a threshold anyone can nudge.
    expect(entropyCandidates(split)).toHaveLength(0);
  });
});

// ── C. the self-validating layer ─────────────────────────────────────────

describe("C. numbers that check themselves — layer 1, previously unused", () => {
  const ALL = new Set(IDENTITY_DETECTOR_IDS);
  const found = (t: string): string[] =>
    identitySpans(t, ALL).map((s) => s.signalId);

  test("a payment card is found by ARITHMETIC, and one wrong digit is not", () => {
    expect(passesLuhn("4111111111111111")).toBe(true);
    expect(passesLuhn("4111111111111112")).toBe(false);
    expect(found("charge 4111 1111 1111 1111 today")).toContain("payment-card");
    expect(found("charge 4111 1111 1111 1112 today")).toEqual([]);
  });

  test("the checksum ALONE is not enough — the issuer range is required", () => {
    // One number in ten passes Luhn by chance. Without the issuer range this
    // layer would mask a tenth of every long numeric id in the world.
    // `9111111111111128` passes Luhn and belongs to no issuer.
    expect(passesLuhn("9111111111111128")).toBe(true);
    expect(found("order 9111111111111128 shipped")).toEqual([]);
  });

  test("an IBAN is found by its mod-97 residue", () => {
    expect(passesIbanMod97("GB82WEST12345698765432")).toBe(true);
    expect(passesIbanMod97("GB82WEST12345698765433")).toBe(false);
    expect(found("pay to GB82 WEST 1234 5698 7654 32")).toContain("bank-account");
  });

  test("a routing number is found by its weighted check digit", () => {
    expect(passesAbaRouting("021000021")).toBe(true);
    expect(passesAbaRouting("021000022")).toBe(false);
    expect(found("routing 021000021")).toContain("bank-routing");
  });

  test("an SSN is FORMAT, not PROVEN, because there is no checksum to run", () => {
    // The honest edge of layer 1, and the confidence says so.
    expect(isPossibleUsSsn("123-45-6789")).toBe(true);
    expect(isPossibleUsSsn("000-45-6789")).toBe(false);
    expect(isPossibleUsSsn("666-45-6789")).toBe(false);
    expect(isPossibleUsSsn("123-00-6789")).toBe(false);
    const span = identitySpans("ssn 123-45-6789", ALL)[0];
    expect(span?.confidence).toBe("format");
  });

  test("a private or loopback address identifies nobody and is left alone", () => {
    expect(found("server 203.0.113.42 is down")).toContain("ip-address");
    for (const local of ["127.0.0.1", "192.168.1.1", "10.0.0.5", "172.16.0.1", "0.0.0.0"]) {
      expect(found(`bound to ${local}`), local).toEqual([]);
    }
  });

  test("a phone number needs its plus sign, and the trade is deliberate", () => {
    expect(found("call +1 415 555 2671")).toContain("phone-number");
    expect(found("order 14155552671 shipped")).toEqual([]);
  });

  test("no explanation from this layer contains any part of the value", () => {
    const card = "4111111111111111";
    for (const span of identitySpans(`charge ${card}`, ALL)) {
      expect(span.explanation).not.toContain(card.slice(0, 6));
      expect(span.explanation).not.toContain(card.slice(-4));
    }
  });
});

// ── D. multi-language declarations ───────────────────────────────────────

describe("D. declarations in languages nobody enumerated", () => {
  /**
   * REAL PHRASINGS, not translations of the English case. Each is written the
   * way a speaker of that language would type it to a colleague, and the
   * VALUE is what has to be masked.
   *
   * These pass on PROXIMITY and the value's own shape, not on vocabulary:
   * none of `Passwort`, `contraseña`, `wachtwoord` or `パスワード` is in the seed.
   * That is the point — the seed is a bootstrap, and the mechanism is what
   * carries the rest.
   */
  const CASES: readonly Readonly<{ lang: string; text: string; secret: string }>[] = [
    { lang: "de", text: "Mein Passwort lautet Zq7Wm3Xr9Td2Lp8Kc", secret: "Zq7Wm3Xr9Td2Lp8Kc" },
    { lang: "es", text: "mi contraseña es Zq7Wm3Xr9Td2Lp8Kc", secret: "Zq7Wm3Xr9Td2Lp8Kc" },
    { lang: "fr", text: "le mot de passe est Zq7Wm3Xr9Td2Lp8Kc", secret: "Zq7Wm3Xr9Td2Lp8Kc" },
    { lang: "nl", text: "mijn wachtwoord is Zq7Wm3Xr9Td2Lp8Kc", secret: "Zq7Wm3Xr9Td2Lp8Kc" },
    { lang: "pt", text: "a minha palavra-passe: Zq7Wm3Xr9Td2Lp8Kc", secret: "Zq7Wm3Xr9Td2Lp8Kc" },
    { lang: "ja", text: "パスワードは Zq7Wm3Xr9Td2Lp8Kc です", secret: "Zq7Wm3Xr9Td2Lp8Kc" },
    { lang: "ru", text: "мой пароль Zq7Wm3Xr9Td2Lp8Kc", secret: "Zq7Wm3Xr9Td2Lp8Kc" },
    { lang: "zh", text: "我的密码是 Zq7Wm3Xr9Td2Lp8Kc", secret: "Zq7Wm3Xr9Td2Lp8Kc" },
  ];

  for (const c of CASES) {
    test(`${c.lang}: the value is masked`, () => {
      // Witness the mask, then the absence of the value it replaced.
      expect(redactForLLMContext(c.text)).toMatch(/\[REDACTED/);
      expect(redactForLLMContext(c.text)).not.toContain(c.secret);
    });
  }

  test("and the language is NOT what did it — the same sentence with an ordinary word survives", () => {
    // The control. If these were passing on some accidental match against the
    // English seed, an ordinary word in the value position would be masked
    // too, and the multi-language claim would be worthless.
    for (const c of CASES) {
      const ordinary = c.text.replace(c.secret, "unavailable");
      expect(redactForLLMContext(ordinary), c.lang).toBe(ordinary);
    }
  });

  test("STATED LIMIT: a short low-entropy secret in a language we have not learned is missed", () => {
    // `mein Passwort ist admin44` — seven characters with no intrinsic
    // signal, introduced by a word nothing has taught yet. This is the honest
    // floor of deterministic detection, and it is why the learned layer
    // exists rather than a promise that it does not happen.
    expect(masked("mein Passwort ist admin44")).toBe(false);
    // The English equivalent IS caught, because the noun is seeded.
    expect(masked("my password may be admin44")).toBe(true);
  });

  test("STATED LIMIT: a raw query terminator inside a prose-declared value cuts the mask at the boundary", () => {
    // The value terminators `&`, `?` and `#` are GLOBAL to the declared-
    // credential lane, not query-string furniture: every value this
    // scanner reads is bounded by them, wherever the declaration appears.
    // A prose-declared value that itself carries a raw terminator byte
    // therefore masks only up to the FIRST one, and the tail after the
    // boundary stays readable — the honest residual of giving the
    // head-of-query credential a calibrated boundary. A REGISTERED
    // credential never pays it: the known-secret layer masks its exact
    // bytes wherever they appear, terminators or no. What can pay it is
    // only an UNREGISTERED value declared in prose with a raw terminator
    // inside it.
    const head = "Zq7Wm3Xr9Td2Lp8Kc";
    const tail = "Nn4Bv8Mc2Wx";
    const out = redactForLLMContext(`my password is ${head}#${tail} today`);
    expect(out, "the head of the declared value is masked").not.toContain(head);
    expect(out, "the tail after the raw terminator is the stated residual — it stays readable").toContain(`#${tail}`);
  });
});

// ── E. the learned vocabulary ────────────────────────────────────────────

describe("E. the vocabulary is derived and learned, not maintained", () => {
  test("derivation: the separator and case variants fall out of one concept", () => {
    expect([...separatorVariants("api key")].sort()).toEqual(
      ["api key", "api-key", "api.key", "api_key", "apikey"].sort(),
    );
  });

  test("derivation: the consonant skeleton produces the abbreviations people write", () => {
    const forms = abbreviations("password");
    expect(forms).toContain("pwd");
    expect(forms).toContain("psw");
    expect(forms).toContain("pssw");
  });

  test("MUTATION: remove the vowel rule and `pod` is admitted as an abbreviation", () => {
    // THE GUARD IS TESTABLE BECAUSE THE GENERATION IS GENEROUS. `pod` IS an
    // ordered subsequence of `password` (p at 0, o at 5, d at 7), so it is
    // generated and then rejected — and the rejection is a fact about the
    // code rather than an accident of how the candidates were enumerated.
    //
    // Enumerating consonants only would make this rule vacuously true and the
    // mutation unobservable, which is one of the ways a guard proves nothing.
    expect(isAbbreviationShaped("pwd")).toBe(true);
    expect(isAbbreviationShaped("pod")).toBe(false);
    expect(abbreviations("password")).not.toContain("pod");
    // And it is the VOWEL that did it, not the length or the letters.
    expect(isAbbreviationShaped("psd")).toBe(true);
  });

  test("derivation: prefix truncations stop at three characters", () => {
    expect(prefixTruncations("password")).toEqual(["pas", "pass", "passw", "passwo", "passwor"]);
  });

  test("the seed is small and the derived set is large — that ratio IS the design", () => {
    const seeded = seededLexicon();
    const canonical = seeded.filter((e) => e.origin === "seed-strong" || e.origin === "seed-weak");
    const derived = seeded.filter((e) => e.origin === "seed-derived");
    expect(canonical.length).toBeLessThanOrEqual(20);
    expect(derived.length).toBeGreaterThan(canonical.length * 10);
  });

  test("MUTATION: remove the weighting and a lone derived term becomes a false positive", () => {
    // The ordering is the whole precision story: a form nobody typed cannot
    // carry a detection by itself. Proved as an ORDERING over the weights,
    // which is what the scorer reads.
    expect(LEXICON_WEIGHTS["seed-derived"]).toBeLessThan(LEXICON_WEIGHTS["seed-strong"]);
    expect(LEXICON_WEIGHTS["learned-derived"]).toBeLessThan(LEXICON_WEIGHTS.learned);
    expect(LEXICON_WEIGHTS["learned-derived"]).toBeLessThan(LEXICON_WEIGHTS["seed-derived"]);
    // And the behaviour that ordering buys: `pwd` alone, next to a value with
    // nothing else supporting it, does not mask.
    expect(masked("the pwd column holds a hash")).toBe(false);
  });

  test("the collision guard is REGISTER — `pass` in code is worth less than in prose", () => {
    // `pass`, `key` and `secret` are everywhere in source. The corroboration
    // is the register, not a list of exceptions.
    expect(registerAt("    if (pass = getValue(row)) { return; }", 8)).toBe("code");
    expect(registerAt("the pass for the staging box", 4)).toBe("prose");
  });

  test("bootstrapping produces the expected terms, in a language nobody seeded", () => {
    const scope = "user-A:session-1";
    const proven = V.anthropic;
    redactMessagesTogether([`ma clef de service est ${proven}`], P, { learningScope: scope });
    redactMessagesTogether([`la clef de service vaut ${proven}`], P, { learningScope: scope });
    const learned = inspectLearned(scope).filter((t) => t.occurrences >= MIN_LEARNING_OCCURRENCES);
    expect(learned.map((t) => t.term)).toContain("clef");
  });

  test("a learned term is INSPECTABLE — the word, the count, and the examples", () => {
    const scope = "user-A:session-1";
    redactMessagesTogether([`ma clef de service est ${V.anthropic}`], P, { learningScope: scope });
    redactMessagesTogether([`la clef de service vaut ${V.anthropic}`], P, { learningScope: scope });
    const entry = inspectLearned(scope).find((t) => t.term === "clef");
    expect(entry).toBeDefined();
    expect(entry!.occurrences).toBeGreaterThanOrEqual(MIN_LEARNING_OCCURRENCES);
    expect(entry!.examples.length).toBeGreaterThan(0);
    // And it never records any part of the secret it was learned beside.
    for (const example of entry!.examples) {
      expect(V.anthropic).not.toContain(example);
    }
  });

  test("a learned term DETECTS — and forgetting it stops the detection", () => {
    const scope = "user-A:session-1";
    redactMessagesTogether([`ma clef de service est ${V.anthropic}`], P, { learningScope: scope });
    redactMessagesTogether([`la clef de service vaut ${V.anthropic}`], P, { learningScope: scope });
    const probe = `ma clef est ${V.short}`;
    expect(redactForLLMContext(probe, P, { learningScope: scope })).not.toContain(V.short);
    expect(forgetLearnedTerm(scope, "clef")).toBe(true);
    expect(redactForLLMContext(probe, P, { learningScope: scope })).toBe(probe);
  });

  test("NOTHING LEARNED IN ONE SESSION REACHES ANOTHER", () => {
    const a = "user-A:session-1";
    const b = "user-B:session-2";
    redactMessagesTogether([`ma clef de service est ${V.anthropic}`], P, { learningScope: a });
    redactMessagesTogether([`la clef de service vaut ${V.anthropic}`], P, { learningScope: (b as string) === a ? "x" : a });
    expect(inspectLearned(b)).toEqual([]);
    expect(lexiconForScope(b).some((e) => e.term === "clef")).toBe(false);
    const probe = `ma clef est ${V.short}`;
    expect(redactForLLMContext(probe, P, { learningScope: b })).toBe(probe);
    // And a call with NO scope sees only the seeded vocabulary.
    expect(redactForLLMContext(probe, P)).toBe(probe);
  });

  test("learning happens only from PROVEN spans, never from an inference", () => {
    // Learning from a declaration and then declaring from the learned word is
    // a loop whose fixed point is "everything is a secret". The declaring
    // message below carries ONLY a layer-5 detection (a short value with no
    // intrinsic signal), so nothing may be learned from it.
    const scope = "user-C:session-1";
    redactMessagesTogether(["my password may be admin44"], P, { learningScope: scope });
    redactMessagesTogether(["my password may be admin44"], P, { learningScope: scope });
    const learned = inspectLearned(scope).filter((t) => t.occurrences >= MIN_LEARNING_OCCURRENCES);
    expect(learned.map((t) => t.term)).not.toContain("may");
    expect(learned.map((t) => t.term)).not.toContain("password");
  });
});

// ── F. tiers ─────────────────────────────────────────────────────────────

describe("F. every tier can be switched off, and only that tier stops", () => {
  const CANARIES: Readonly<Record<PrivacyTierId, string>> = {
    "self-validating": "charge 4111 1111 1111 1111 today",
    "grammar-defined": "write to jane.doe@example.com please",
    "known-values": "unused — layer 3 needs a registered credential",
    "value-intrinsic": `here it is: ${V.bareKey}`,
    "declared-values": "my password may be admin44",
  };

  for (const tier of PRIVACY_TIERS) {
    if (tier.id === "known-values") continue;
    test(`MUTATION: disabling ${tier.id} stops its detections and leaves the others running`, () => {
      const canary = CANARIES[tier.id];
      // On: the canary is masked.
      expect(masked(canary), `${tier.id} canary should mask when on`).toBe(true);
      setPrivacyTierEnabled(tier.id, false);
      // Off: this one stops.
      expect(redactForLLMContext(canary), `${tier.id} canary should survive when off`).toBe(canary);
      // And every OTHER tier is still running — which is the half a
      // switch-off test usually forgets, and the half that catches a switch
      // wired to the whole engine instead of to one layer.
      for (const other of PRIVACY_TIERS) {
        if (other.id === tier.id || other.id === "known-values") continue;
        expect(masked(CANARIES[other.id]), `${other.id} stopped when ${tier.id} was switched off`).toBe(true);
      }
      setPrivacyTierEnabled(tier.id, true);
      expect(masked(canary)).toBe(true);
    });
  }

  test("a tier switch reaches the detector through exactly ONE join", () => {
    // The registry is the only route from a setting to a scan: the detector
    // ids that run are computed from the declared types, never listed.
    const all = enabledDetectorIds(currentPrivacySettings());
    for (const id of IDENTITY_DETECTOR_IDS) expect(all.has(id)).toBe(true);
    const off = createPrivacySettings({ tiers: { "grammar-defined": false } });
    expect(enabledDetectorIds(off).has("email-grammar")).toBe(false);
    expect(enabledDetectorIds(off).has("luhn-checksum")).toBe(true);
  });

  test("one TYPE can be switched off inside a tier that stays on", () => {
    const noIp = createPrivacySettings({ disabledTypes: ["ip-address"] });
    const text = "server 203.0.113.42 mailed jane.doe@example.com";
    const spans = detectSecretSpans(text, P, { settings: noIp });
    expect(spans.map((s) => s.signalId)).toContain("email-address");
    expect(spans.map((s) => s.signalId)).not.toContain("ip-address");
  });

  test("the defaults come from the config owner, not from the registry", () => {
    for (const tier of PRIVACY_TIERS) {
      expect(currentPrivacySettings().tiers[tier.id]).toBe(DEFAULT_PRIVACY_TIERS_ENABLED[tier.id]);
    }
  });
});

// ── G. the registry ──────────────────────────────────────────────────────

describe("G. the registry — breadth auditable, gaps stated", () => {
  test("every declared type names its layer, method, confidence and LIMIT", () => {
    for (const type of PII_TYPES) {
      expect(PRIVACY_TIERS.some((t) => t.id === type.tier), type.id).toBe(true);
      expect(type.plainName.length, type.id).toBeGreaterThan(3);
      expect(type.method.length, type.id).toBeGreaterThan(20);
      // THE LIMITATION IS MANDATORY. It is the part a user cannot discover by
      // testing, and a registry of successes is the dishonest version of this.
      expect(type.limitation.length, `${type.id} must state what it does NOT catch`).toBeGreaterThan(30);
    }
  });

  test("what is out of reach is DECLARED, with the reason", () => {
    const gaps = unsupportedTypes().map((t) => t.id);
    expect(gaps).toContain("person-name");
    expect(gaps).toContain("street-address");
    for (const gap of unsupportedTypes()) {
      expect(gap.detectorIds).toEqual([]);
      expect(typeEnabled(gap, currentPrivacySettings())).toBe(false);
      expect(gap.limitation.toLowerCase()).toMatch(/not deterministic|differ by country|wordlist|dictionary/);
    }
  });

  test("no detector exists that no type declares — a switch reaches everything", () => {
    const declared = new Set(PII_TYPES.flatMap((t) => t.detectorIds));
    for (const id of IDENTITY_DETECTOR_IDS) expect(declared.has(id), id).toBe(true);
  });

  test("the registry NEVER states a confidence stronger than its layer can earn", () => {
    for (const type of PII_TYPES) {
      if (type.confidence !== "proven") continue;
      // Only a checksum or an exact match can say `proven`.
      expect(["self-validating", "known-values"], type.id).toContain(type.tier);
    }
  });
});

// ── H. determinism ───────────────────────────────────────────────────────

describe("H. determinism — the property a model was rejected to keep", () => {
  const SAMPLES: readonly string[] = [
    `my api key is ${V.anthropic}`,
    `here it is: ${V.bareKey}`,
    "charge 4111 1111 1111 1111 today",
    "commit d8250ea9f2c7d4e8b1a6350fe2947cd80b3a15e6 landed",
    `token=${V.hf} and mail jane.doe@example.com`,
    "my password may be admin44",
  ];

  test("the same input gives byte-identical output, repeatedly", () => {
    for (const s of SAMPLES) {
      const first = redactForLLMContext(s);
      for (let i = 0; i < 50; i += 1) expect(redactForLLMContext(s)).toBe(first);
    }
  });

  test("the ORDER of calls does not change any answer", () => {
    // The engine holds shared `g` regexes whose cursors survive calls. A
    // missing `lastIndex` reset makes the answer depend on what was scanned
    // before, which this interleaving would expose and a repeat loop would
    // not.
    const alone = SAMPLES.map((s) => redactForLLMContext(s));
    const interleaved: string[] = [];
    for (const s of SAMPLES) {
      redactForLLMContext("a long unrelated string with commit d8250ea9f2c7d4e8b1a6350fe2947cd80b3a15e6");
      interleaved.push(redactForLLMContext(s));
    }
    expect(interleaved).toEqual(alone);
  });

  test("a FRESH PROCESS produces the same bytes", () => {
    // The claim is across process restarts, so it is measured across a
    // process restart. Anything seeded from a clock, a random source or a
    // module-load order would diverge here and nowhere else.
    const script = `
      const { redactForLLMContext } = await import(${JSON.stringify(ENGINE)});
      const samples = ${JSON.stringify(SAMPLES)};
      process.stdout.write(JSON.stringify(samples.map((s) => redactForLLMContext(s))));
    `;
    const runOnce = (): string =>
      execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
        encoding: "utf8",
        timeout: 60_000,
      });
    const a = runOnce();
    const b = runOnce();
    expect(a).toBe(b);
    expect(JSON.parse(a)).toEqual(SAMPLES.map((s) => redactForLLMContext(s)));
  });
});

// ── I. one detector ──────────────────────────────────────────────────────

const ENGINE_PATH = modulePath("redaction-engine.ts");
const ENGINE = new URL(
  "../../engine/src/privacy/redaction-engine.ts",
  import.meta.url,
).href;

describe("I. one detector — no path runs a weaker one", () => {
  const engine = read(ENGINE_PATH);

  test("no detection is LOST — the composed detector is a superset of the catalog", () => {
    // Containment, not equality. The union may find more and may never find
    // less; a layer that filtered another would break exactly this.
    const CORPUS: readonly string[] = [
      `key ${V.anthropic}`,
      "AKIAIOSFODNN7EXAMPLE",
      'const API_KEY = "sk-AAAAAAAAAAAAAAAAAAAAAAAA"',
      "Authorization: Bearer Ab3xQ9zLmN2pRt5vWy8uZc1dEf4gHj7k",
      "-----BEGIN RSA PRIVATE KEY-----",
      "ordinary prose with nothing in it at all",
      "commit d8250ea9f2c7d4e8b1a6350fe2947cd80b3a15e6",
    ];
    for (const text of CORPUS) {
      const catalog = detectSensitiveSpans(text, P);
      const composed = detectSecretSpans(text, P);
      for (const span of catalog) {
        const covered = composed.some(
          (c) => c.startUtf16 <= span.startUtf16 && c.endUtf16 >= span.endUtf16,
        );
        expect(covered, `${text}: the catalog span at ${span.startUtf16} was lost`).toBe(true);
      }
    }
  });

  test("the file-viewer and evidence paths run the COMPOSED detector too", () => {
    // They used to run the format catalog alone, and the split was written
    // down as deliberate. It meant one credential was hidden from the model
    // and visible through the file viewer — two answers to one question.
    // EACH CLAIM IS ABOUT ONE FUNCTION'S BODY, so it is asked of that body.
    // These were three windows of 2200, 400 and 900 bytes over a file in which
    // `detectSecretSpans(text, policy` appears many times — three assertions
    // that could all be satisfied by the same neighbouring call.
    for (const [fn, call] of [
      ["redactText", "detectSecretSpans"],
      ["hasSensitiveContent", "detectSecretSpans"],
      ["verifyRedaction", "detectSecretSpans"],
    ] as const) {
      expect(
        bodyCalls(functionBody(engine, fn), call),
        `${fn} must run the composed detector, not the format catalog alone`,
      ).toBe(true);
    }
    // …and the ARGUMENT matters for the verifier: it must inspect the REDACTED
    // text, which is the one thing a call-name check cannot say. The argument
    // is compared as the PARSER delimited it, so a call spanning lines reads
    // the same and a nested call inside the first argument cannot truncate it
    // the way `[^)]*` did.
    expect(
      bodyCallsWith(functionBody(engine, "verifyRedaction"), "detectSecretSpans", ["redactedText"]),
      "the verifier must re-scan the redacted text, not the original",
    ).toBe(true);
  });

  test("the verifier is not weaker than the thing it verifies", () => {
    // A residual check that cannot see what the redactor can would report
    // clean on everything the weaker detector misses.
    const secret = `here it is: ${V.bareKey}`;
    const redacted = redactForLLMContext(secret);
    expect(redacted).not.toContain(V.bareKey);
    expect(detectSecretSpans(redacted, P).length).toBe(0);
  });

  test("combination is MONOTONE — a union, never a first-match", () => {
    expect(engine, "a layer that returns early would make the union conditional").not.toMatch(
      /if\s*\(\s*\w+Spans\.length\s*>\s*0\s*\)\s*return/,
    );
    // Two secrets of different kinds in one string: both must be masked, not
    // whichever was found first.
    const both = `mail jane.doe@example.com and the key is ${V.bareKey}`;
    const out = redactForLLMContext(both);
    expect(out).not.toContain("jane.doe@example.com");
    expect(out).not.toContain(V.bareKey);
  });

  test("every explanation is value-free and names its confidence", () => {
    for (const text of [`key ${V.anthropic}`, "charge 4111 1111 1111 1111", `here it is: ${V.bareKey}`]) {
      for (const e of explainRedaction(text, P)) {
        expect(["proven", "format", "inferred"]).toContain(e.confidence);
        const value = text.slice(e.startUtf16, e.endUtf16);
        // No run of the masked value, of any meaningful length, may appear.
        for (let i = 0; i + 6 <= value.length; i += 1) {
          expect(e.explanation, `${text}: explanation leaked "${value.slice(i, i + 6)}"`).not.toContain(
            value.slice(i, i + 6),
          );
        }
      }
    }
  });

  test("NO SOURCE FILE IN THE PRIVACY ENGINE CONTAINS A NUL BYTE", () => {
    // A NUL makes a file binary to `grep` and to every source-scanning guard
    // that reads it as text — the scan reports "0 matches" and passes. One
    // was found in this suite's sibling guard while this work was underway,
    // inside a string literal, and it had been silently defeating source
    // scans of that file.
    const files = [
      "redaction-engine.ts", "secret-intelligence.ts", "value-intrinsic.ts",
      "benign-grammars.ts", "identity-grammars.ts", "credential-lexicon.ts",
      "pii-registry.ts", "text-normalize.ts", "detection-span.ts", "privacy-config.ts",
    ];
    for (const f of files) {
      const source = read(`engine/src/privacy/${f}`);
      expect(source.includes("\u0000"), `${f} contains a NUL byte`).toBe(false);
    }
  });
});

// ── J. connection-string credentials ─────────────────────────────────────
//
// A DATABASE_URL's password lives in the URL's userinfo. The detector had no
// signal for that shape: the no-`!` twin was masked only because the PII
// email grammar saw `Summer2026@db.internal`, and one `!` or `$` in the
// password defeated it. The catalog now owns a `connection-string` signal;
// these arms drive every egress path the finding named, not just the
// detector.
describe("J. a URL userinfo password is a credential on every egress path", () => {
  const WITH_BANG = "postgres://app:Summer2026!@db.internal:5432/app";
  const WITH_DOLLAR = "mysql://app:S3cret$Value@db.internal:3306/app";
  const BENIGN = "postgres://app@db.internal:5432/app";

  afterEach(() => resetDebugSystem());

  test("the catalog declares connection-string for a password, and vetoes the benign user@host form", () => {
    for (const url of [WITH_BANG, WITH_DOLLAR]) {
      expect(secretTextSignalIds(url, "admission"), url).toContain("connection-string");
      expect(
        detectSecretSpans(url, P).some((span) => span.signalId === "connection-string"),
        url,
      ).toBe(true);
    }
    // A URL with a user and no password is not a credential: no colon
    // between the scheme and the `@`, so the signal must not fire.
    expect(secretTextSignalIds(BENIGN, "admission")).not.toContain("connection-string");
  });

  test("a keep-marked userinfo is already concealed and is never re-read as a password", () => {
    // The MCP owner masks the whole userinfo and labels its place with a keep
    // mark. The marker's own `:` is not a user/password separator; if the
    // global signal re-read it, an egress redactor would replace the marker
    // with a generic mask and the write-back would lose the part.
    const MASKED = "https://‹keep:url.userinfo›@mcp.example.com/mcp?api_key=‹keep:url.query.api_key.0›&region=eu";
    expect(secretTextSignalIds(MASKED, "admission")).not.toContain("connection-string");
    expect(
      detectSecretSpans(MASKED, P).some((span) => span.signalId === "connection-string"),
    ).toBe(false);
    expect(redactForUserDisplay(MASKED)).toBe(MASKED);

    // The veto is SCOPED to a userinfo that IS the labelled mark: a real
    // password in front of a marked query is still a credential and still
    // masked.
    const MIXED = "postgres://app:Summer2026!@db.internal:5432/app?token=‹keep:url.query.token.0›";
    expect(secretTextSignalIds(MIXED, "admission")).toContain("connection-string");
    expect(JSON.stringify(redactForUserDisplay(MIXED))).not.toContain("Summer2026!");

    // A password that merely CONTAINS the marker text is not the marker: the
    // signal still fires, so the veto cannot become a spelling a credential
    // hides behind.
    const PASSWORD_CONTAINS_MARKER = "postgres://app:pa‹keep:ss@db.internal:5432/app";
    expect(secretTextSignalIds(PASSWORD_CONTAINS_MARKER, "admission")).toContain("connection-string");
    expect(JSON.stringify(redactForUserDisplay(PASSWORD_CONTAINS_MARKER))).not.toContain("pa‹keep:ss");
  });

  test("redactForLLMContext masks the password in both the ! and $ forms", () => {
    for (const url of [WITH_BANG, WITH_DOLLAR]) {
      const out = redactForLLMContext(url);
      expect(out, url).not.toContain("Summer2026");
      expect(out, url).not.toContain("S3cret$Value");
      expect(out, url).toContain("[REDACTED:credential]");
    }
  });

  test("redactText masks the password and reports the span", () => {
    const result = redactText(WITH_BANG, P);
    expect(result.spanCount).toBeGreaterThan(0);
    expect(result.redactedText).not.toContain("Summer2026!");
    expect(result.redactedText).toContain("[REDACTED:credential]");
  });

  test("redactForUserDisplay masks the password as a leaf and inside a DATABASE_URL field", () => {
    expect(JSON.stringify(redactForUserDisplay(WITH_BANG))).not.toContain("Summer2026!");
    const out = JSON.stringify(redactForUserDisplay({ DATABASE_URL: WITH_BANG }));
    expect(out).not.toContain("Summer2026!");
    expect(out).toContain("[REDACTED:credential]");
  });

  test("the debug sink never receives the password", () => {
    const sink = createCollectingSink();
    configureDebugSystem(
      {
        ...DEBUG_CONFIG_DEFAULTS,
        enabled: true,
        level: "error",
        categories: ["privacy"],
        sinks: { enabledSinks: ["collecting"] },
      },
      [sink],
    );
    debugLog("privacy", "error", `database refused ${WITH_BANG}`);
    const event = sink.events.at(-1);
    expect(event, "the error level must reach the sink").toBeDefined();
    expect(event!.message).not.toContain("Summer2026!");
    expect(event!.message).toMatch(/\[REDACTED/);
  });

  test("a docker-compose.yml read masks the password", () => {
    const yaml = `services:\n  db:\n    environment:\n      DATABASE_URL: ${WITH_BANG}\n`;
    const view = viewFile("docker-compose.yml", yaml);
    expect(view.outcome).toBe("viewed");
    if (view.outcome !== "viewed") return;
    expect(view.content).not.toContain("Summer2026!");
    expect(view.content).toContain("[REDACTED:credential]");
    expect(view.redactionSummary.verified).toBe(true);
  });
});
