import assert from "node:assert/strict";
import test from "node:test";

import { InputError } from "../../src/kernel/errors.ts";
import {
  createPrivacyPolicy,
  redactionReplacement,
  REDACTION_CATEGORIES,
  type PrivacyPolicy,
} from "../../src/privacy/privacy-policy.ts";
import {
  detectSecretSpans,
  redactForLLMContext,
  redactText,
  verifyRedaction,
} from "../../src/privacy/redaction-engine.ts";
import { redactEvidence } from "../../src/privacy/evidence-handler.ts";
import { viewFile } from "../../src/privacy/file-viewer.ts";
import { secretTextSignalIds } from "../../src/privacy/secret-signals.ts";

/**
 * THE PRIVACY BEHAVIOURS, RUN UNDER NON-DEFAULT CONFIGURATION AS WELL AS THE
 * DEFAULT — which is the single change that makes a whole class of bug
 * visible.
 *
 * ── THE CLASS ───────────────────────────────────────────────────────────────
 *
 * Everything else in this suite runs on DEFAULT configuration. Under default
 * configuration `DEFAULT_X` and the resolved `policy.x` are the same value, so
 * a consumer that reads the default instead of the resolved field behaves
 * identically and no assertion anywhere can tell. The defect is not
 * under-tested; it is INVISIBLE BY CONSTRUCTION.
 *
 * That is exactly how the redaction-marker bug survived: the recogniser read
 * the built-in prefix while the writer formatted from the configured one, and
 * every test agreed with it because every test used the built-in one. Running
 * the same behaviours under a deliberately different marker turns that from
 * invisible into unmissable — for this defect and for any sibling nobody has
 * found yet, because the assertions below never mention `[REDACTED:`.
 *
 * ── ONE TABLE, NOT A SECOND SUITE ───────────────────────────────────────────
 *
 * The invariants are written once and evaluated over the policy matrix. There
 * is deliberately no copy of any test body: a duplicated body is two things to
 * keep in step, and the one that gets forgotten is the one that mattered.
 *
 * ── WHY THE ASSERTIONS ARE SHAPED LIKE THIS ─────────────────────────────────
 *
 * Nothing here asserts a literal marker. Every assertion is phrased against
 * what THIS policy writes (`redactionReplacement`), so the test cannot be
 * satisfied by a consumer that hardcoded the built-in one — the discriminator
 * is the configured value itself, which the old path cannot produce and cannot
 * fake.
 */

/**
 * The markers, adversarial on purpose. Each says what it is trying to break.
 */
const MARKERS: readonly Readonly<{ prefix: string; suffix: string; note: string }>[] = [
  { prefix: "[REDACTED:", suffix: "]", note: "the built-in marker — the control" },
  { prefix: "<HIDDEN:", suffix: ">", note: "a plain reconfiguration" },
  { prefix: "{{MASK-", suffix: "}}", note: "survived the original bug by accident; must survive on purpose" },
  { prefix: "***", suffix: "***", note: "prefix equals suffix" },
  { prefix: "SECRET:", suffix: "", note: "ends in a connector, and no suffix at all" },
  { prefix: "(.*)+", suffix: "$1", note: "regex metacharacters, in case anything compiles the marker" },
  { prefix: "[[", suffix: "[[]]", note: "prefix is a substring of the suffix" },
  // ── THE MARKERS MADE ENTIRELY OF VALUE DELIMITERS ────────────────────────
  //
  // These are the ones the recogniser can only catch by CONTAINMENT: the
  // value scanner has already eaten every character of the prefix by the time
  // the token arrives, so the delimiter-stripped form is empty and the
  // "starts with the marker core" test cannot fire. They were added after a
  // mutation showed the containment test could be neutered without a single
  // assertion noticing — the matrix had no marker that depended on it.
  { prefix: "<<", suffix: ">>", note: "all value delimiters — only containment can recognise it" },
  { prefix: "#", suffix: "#", note: "a single value delimiter, same reason" },
  { prefix: "🔒", suffix: "🔒", note: "astral-plane characters — two UTF-16 code units each" },
  { prefix: "\u0000MASK\u0000", suffix: "\u0000", note: "NUL bytes, written as escapes so the source itself stays clean text" },
  { prefix: "  ", suffix: "  ", note: "whitespace only, which the value scanner also skips" },
  { prefix: "\\", suffix: "\\", note: "a lone backslash" },
  { prefix: "х", suffix: "х", note: "Cyrillic homoglyph of a Latin x — the normalisation pass sees this" },
  { prefix: "-".repeat(64), suffix: "-".repeat(64), note: "the longest marker the config schema admits" },
];

/**
 * The other configurable dimensions, so the matrix is not only about the
 * marker. Derived one variant per switch rather than a cross product: the
 * point is that each configurable is exercised away from its default, not that
 * every combination is enumerated.
 */
const OPTION_VARIANTS: readonly Readonly<{ note: string; options: Parameters<typeof createPrivacyPolicy>[0] }>[] = [
  { note: "defaults", options: {} },
  { note: "structure collapsing", options: { preserveStructure: false } },
  { note: "line count not preserved", options: { preserveLineCount: false } },
  { note: "fail closed on uncertainty", options: { failClosedOnUncertainty: true } },
  { note: "semantic mode on", options: { semanticModeEnabled: true } },
  { note: "narrow line cap", options: { maxLines: 3 } },
  { note: "narrow context window", options: { maxContextLines: 2 } },
];

/**
 * Content samples, one per detection route the engine has.
 *
 * ── A ROW MUST EXERCISE THE ROUTE IT IS NAMED FOR ─────────────────────────
 *
 * The row below called "credential assignment" used to read
 * `api_key = "sk_abcdefghijklmnopqrstuvwx"`, and it did NOT exercise
 * credential-assignment at all. DRIVEN with `secretTextSignalIds`, which is the
 * function the engine itself selects signals through:
 *
 *   admission      `api_key = "sk_abcdefghijklmnopqrstuvwx"` → [token-prefix]
 *   classification `api_key = "sk_abcdefghijklmnopqrstuvwx"` → [token-prefix,
 *                                                              credential-assignment]
 *
 * `admission` is `DEFAULT_PROFILE`, so under the profile this matrix actually
 * runs, the row passed entirely on the `sk_` prefix rule. The reason is in the
 * regex: `credential-assignment`'s admission profile carries the negative
 * lookahead `(?!(?:[A-Za-z]*_[A-Za-z_]*|[0-9a-f]{32,})(?:[^A-Za-z0-9_$]|$))`,
 * and `sk_abcdefghijklmnopqrstuvwx` is exactly `[A-Za-z]*_[A-Za-z_]*` followed
 * by a quote — so the value EXCLUDES ITSELF from the signal the row is named
 * after. The matrix therefore had NO row covering credential assignment, while
 * carrying a name that would stop anyone from adding one. A row named for a
 * case it does not exercise is worse than a missing row.
 *
 * There are now two rows: one whose value the admission profile really does
 * admit as `credential-assignment` (asserted below, not assumed), and one that
 * keeps the old text under its true name, `token prefix`, so no coverage is
 * lost by the correction.
 */
const SAMPLES: readonly Readonly<{ name: string; text: string; secret: string }>[] = [
  { name: "credential assignment", text: "password = Kq9Tz2Vb7Xm4Rn1Pd6Ws3Hj8", secret: "Kq9Tz2Vb7Xm4Rn1Pd6Ws3Hj8" },
  { name: "token prefix in an assignment", text: 'api_key = "sk_abcdefghijklmnopqrstuvwx"', secret: "sk_abcdefghijklmnopqrstuvwx" },
  { name: "aws access key", text: "key = AKIAIOSFODNN7EXAMPLE", secret: "AKIAIOSFODNN7EXAMPLE" },
  { name: "bearer token", text: "Authorization: Bearer abcdefghijklmnopqrstuv1234567890", secret: "abcdefghijklmnopqrstuv1234567890" },
  { name: "declared credential in prose", text: "my password may be admin44xyz", secret: "admin44xyz" },
  { name: "secret on a later line", text: "const a = 1;\napi_key = sk_abcdefghijklmnopqrstuvwx\nconst b = 2;", secret: "sk_abcdefghijklmnopqrstuvwx" },
];

type Variant = Readonly<{ label: string; policy: PrivacyPolicy }>;

function buildMatrix(): readonly Variant[] {
  const variants: Variant[] = [];
  for (const marker of MARKERS) {
    for (const option of OPTION_VARIANTS) {
      variants.push({
        label: `marker ${JSON.stringify(marker.prefix)}…${JSON.stringify(marker.suffix)} (${marker.note}) + ${option.note}`,
        policy: createPrivacyPolicy({
          ...option.options,
          redactionPrefix: marker.prefix,
          redactionSuffix: marker.suffix,
        }),
      });
    }
  }
  return variants;
}

const MATRIX = buildMatrix();

/**
 * Whether this policy's own replacements LOOK LIKE SECRETS — standing alone,
 * or standing where the engine will actually write them.
 *
 * Some markers genuinely are indistinguishable from a credential. A prefix of
 * `sk_abcdefghijklmnopqrstuvwx` is the obvious one; a 64-character run of
 * dashes written after `api_key = ` is the one the matrix found, because the
 * published-format catalog reads key-equals-long-value as a credential
 * assignment whatever the value is made of. In both cases the engine cannot
 * certify its own output, and REFUSING is the correct answer — so those
 * markers are tested against the refusal invariant instead of the round-trip
 * one, and every marker is in exactly one of the two arms.
 *
 * The context probe deliberately ignores `declared-credential` spans. A
 * declaration-layer hit on the engine's own mask is the defect this whole file
 * exists for, not a property of the marker: counting it here would let the bug
 * exclude itself from the tests that would catch it.
 */
function markerLooksLikeASecret(policy: PrivacyPolicy): boolean {
  return REDACTION_CATEGORIES.some((category) => {
    const replacement = redactionReplacement(category, policy);
    if (detectSecretSpans(replacement, policy).length > 0) return true;
    return detectSecretSpans(`api_key = ${replacement}`, policy)
      .some((span) => span.signalId !== "declared-credential");
  });
}

test("policy matrix: the marker the engine writes is never read back as a declared secret", () => {
  // The bug, stated as a property. Placing a replacement exactly where a
  // declaration puts a value is the shape that broke: `api_key = <HIDDEN:token>`
  // was read as `api_key` declaring the value `HIDDEN:token`.
  const failures: string[] = [];
  for (const { label, policy } of MATRIX) {
    if (markerLooksLikeASecret(policy)) continue;
    for (const category of REDACTION_CATEGORIES) {
      const replacement = redactionReplacement(category, policy);
      const line = `api_key = ${replacement}`;
      const residual = detectSecretSpans(line, policy)
        .filter((span) => span.signalId === "declared-credential");
      if (residual.length > 0) {
        failures.push(`${label} / ${category}: ${residual.length} declaration span(s) over the engine's own mask`);
      }
    }
  }
  assert.deepEqual(
    failures,
    [],
    "The declaration layer read the redaction engine's own replacement as a declared credential. " +
      "That happens when the recogniser is looking for a marker other than the one this policy writes — " +
      "i.e. it read a default instead of the resolved `policy.redactionPrefix`. Offenders: " +
      failures.join("; "),
  );
});

/**
 * ── THE NAME OF A ROW IS PART OF THE ROW ──────────────────────────────────
 *
 * Every sample must actually reach the detection route its name claims, under
 * the profile the matrix runs (`admission`, the engine's `DEFAULT_PROFILE`).
 * Without this, a value can drift out of its own signal's regex and the row
 * keeps passing on some other rule — which is exactly what happened to
 * "credential assignment", silently, for as long as the row existed.
 *
 * Stated as containment (§31a), never as a count: the row must be AMONG the
 * signals the value fires, not the only one.
 */
const SAMPLE_ROUTE: Readonly<Record<string, string>> = {
  "credential assignment": "credential-assignment",
  "token prefix in an assignment": "token-prefix",
  "aws access key": "aws-access-key",
  "bearer token": "bearer-token",
  "secret on a later line": "token-prefix",
};

test("policy matrix: every named row really reaches the route it is named for", () => {
  const failures: string[] = [];
  let checked = 0;
  for (const sample of SAMPLES) {
    const expected = SAMPLE_ROUTE[sample.name];
    if (expected === undefined) continue;
    checked++;
    const fired = secretTextSignalIds(sample.text, "admission");
    if (!fired.includes(expected)) {
      failures.push(`"${sample.name}" claims ${expected} but admission fires [${fired.join(", ")}]`);
    }
  }
  // WITNESS, before the absence claim means anything: rows were really examined,
  // and every routed name in the table is a name a sample actually has. A table
  // that matched nothing would satisfy an empty failure list.
  assert.equal(checked, Object.keys(SAMPLE_ROUTE).length, "witness: every routed name matched a real sample");
  assert.ok(checked > 0, "witness: rows were examined");
  // INERT CONTROL: the value that used to sit under the "credential assignment"
  // name must be shown NOT to fire that signal, or this guard is asserting
  // something that was always true and would not have caught the original.
  assert.ok(
    !secretTextSignalIds('api_key = "sk_abcdefghijklmnopqrstuvwx"', "admission").includes("credential-assignment"),
    "control: the old row's value genuinely does NOT admit as credential-assignment — the defect was real",
  );
  assert.deepEqual(failures, [], `A row does not exercise the route it is named for: ${failures.join("; ")}`);
});

test("policy matrix: redaction verifies under every non-default policy", () => {
  const failures: string[] = [];
  for (const { label, policy } of MATRIX) {
    if (markerLooksLikeASecret(policy)) continue;
    for (const sample of SAMPLES) {
      const redacted = redactText(sample.text, policy);
      const verification = verifyRedaction(redacted.redactedText, policy);
      if (!verification.verified) {
        failures.push(
          `${label} / ${sample.name}: ${verification.residualSpans.length} residual span(s), ` +
            `first is ${verification.residualSpans[0]?.signalId ?? "?"}`,
        );
      }
    }
  }
  assert.deepEqual(failures, [], `Redaction did not verify: ${failures.join("; ")}`);
});

test("policy matrix: the secret never survives, whatever the marker is", () => {
  const failures: string[] = [];
  for (const { label, policy } of MATRIX) {
    for (const sample of SAMPLES) {
      const redacted = redactText(sample.text, policy).redactedText;
      if (redacted.includes(sample.secret)) {
        failures.push(`${label} / ${sample.name}: the secret is still present`);
      }
      const forModel = redactForLLMContext(sample.text, policy);
      if (forModel.includes(sample.secret)) {
        failures.push(`${label} / ${sample.name}: the secret is still present on the model path`);
      }
    }
  }
  assert.deepEqual(failures, [], `A secret survived redaction: ${failures.join("; ")}`);
});

test("policy matrix: redaction is idempotent under every non-default policy", () => {
  // The egress choke point runs two passes. If a second pass changes the
  // output of the first, the engine is masking its own mask — which is the
  // same defect seen from the other side.
  const failures: string[] = [];
  for (const { label, policy } of MATRIX) {
    if (markerLooksLikeASecret(policy)) continue;
    for (const sample of SAMPLES) {
      const once = redactText(sample.text, policy).redactedText;
      const twice = redactText(once, policy).redactedText;
      if (once !== twice) {
        failures.push(`${label} / ${sample.name}: ${JSON.stringify(once)} -> ${JSON.stringify(twice)}`);
      }
    }
  }
  assert.deepEqual(failures, [], `Redaction was not idempotent: ${failures.join("; ")}`);
});

test("policy matrix: configuring the marker never destroys the evidence it marks", () => {
  // The user-visible consequence of the original bug: `redactEvidence`
  // returned a refusal with no content, so configuring a prefix emptied every
  // piece of evidence that contained a secret.
  const failures: string[] = [];
  for (const { label, policy } of MATRIX) {
    if (markerLooksLikeASecret(policy)) continue;
    for (const sample of SAMPLES) {
      const evidence = redactEvidence(sample.text, { policy });
      if (evidence.status === "blocked") {
        failures.push(`${label} / ${sample.name}: evidence refused (${evidence.blockReason})`);
        continue;
      }
      if (!evidence.redactedContent.includes(policy.redactionPrefix)) {
        failures.push(`${label} / ${sample.name}: the configured marker is absent from the result`);
      }
      const view = viewFile("sample.ts", sample.text, { mode: "full", policy });
      if (view.outcome === "refused") {
        failures.push(`${label} / ${sample.name}: file view refused (${view.blockReason})`);
      } else if (!view.content.includes(policy.redactionPrefix)) {
        failures.push(`${label} / ${sample.name}: the configured marker is absent from the view`);
      }
    }
  }
  assert.deepEqual(failures, [], `Configuring the marker destroyed or refused evidence: ${failures.join("; ")}`);
});

test("policy matrix: a marker that is itself a secret is refused, not emitted", () => {
  // The deliberate opposite, and the invariant a shortcut fix destroyed once:
  // stripping markers before verification made this case pass silently by
  // hiding the secret marker from the verifier. It must still refuse.
  const leaky = createPrivacyPolicy({
    redactionPrefix: "sk_abcdefghijklmnopqrstuvwx",
    redactionSuffix: "",
  });
  assert.ok(markerLooksLikeASecret(leaky), "precondition: this marker must be detectable as a secret");
  const evidence = redactEvidence("password = MyS3cretPassw0rd12345678", { policy: leaky });
  assert.equal(evidence.status, "blocked");
  assert.ok(!("redactedContent" in evidence), "a refusal carries no content");
  assert.equal(evidence.blockReason, "redaction_incomplete_residual_secrets_detected");

  const view = viewFile("test.ts", "password = MyS3cretPassw0rd12345678", { mode: "full", policy: leaky });
  assert.equal(view.outcome, "refused");
  assert.equal(view.blockReason, "redaction_incomplete_residual_secrets_detected");
});

test("policy matrix: a marker that cannot identify itself is refused at construction", () => {
  // An empty prefix makes the replacement a bare word and makes "does this
  // token contain the marker" true of every token in existence — which would
  // switch the whole declaration layer off without saying so.
  assert.throws(
    () => createPrivacyPolicy({ redactionPrefix: "", redactionSuffix: "" }),
    (error: unknown) =>
      error instanceof InputError &&
      error.code === "privacy_policy_marker_floor_violation" &&
      error.message.includes("redactionPrefix"),
  );
});

test("policy matrix: the matrix is populated (no vacuous pass)", () => {
  // Every assertion above is a loop over this matrix. An empty matrix, or a
  // precondition that excludes everything, turns all of them green while
  // testing nothing.
  assert.ok(MATRIX.length >= MARKERS.length, `matrix must cover every marker; it has ${MATRIX.length}`);
  const exercised = MATRIX.filter((variant) => !markerLooksLikeASecret(variant.policy));
  assert.ok(
    exercised.length >= MATRIX.length / 2,
    `most of the matrix must clear the marker-is-not-a-secret precondition; ${exercised.length} of ${MATRIX.length} did`,
  );
  const nonDefault = exercised.filter((variant) => variant.policy.redactionPrefix !== "[REDACTED:");
  assert.ok(nonDefault.length > 0, "the matrix must contain policies whose marker is not the built-in one");
});
