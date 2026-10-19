import assert from "node:assert/strict";
import test from "node:test";

import { redactMessagesTogether } from "../../src/privacy/redaction-engine.ts";
import { heldValues } from "../../src/privacy/held-set.ts";
import { createPrivacyPolicy } from "../../src/privacy/privacy-policy.ts";
import {
  rememberableDeclaredValue,
  DEFAULT_HELD_MINIMUM_LENGTH,
  MIN_REMEMBERABLE_LENGTH,
  MIN_KNOWN_SECRET_LENGTH,
} from "../../src/privacy/secret-intelligence.ts";

/**
 * THE TWO-FLOORS INVARIANT: WHATEVER A POPULATION ACCEPTS, IT MASKS.
 *
 * The declaration layer accepts values for remembering at
 * `MIN_REMEMBERABLE_LENGTH` (6); the persistent identity registry accepts at
 * `MIN_KNOWN_SECRET_LENGTH` (12). Those are a deliberate, reasoned PAIR — the
 * low floor is safe only for one-call ephemeral values behind the
 * placeholder veto; the high floor protects every future message from a
 * short shredder. The DEFECT was one shared variant builder hardcoding the
 * REGISTRY's floor while serving BOTH populations: a declared 6-to-11
 * character secret was accepted, counted in `learnedCount` (success
 * reported), and then produced zero matchable variants — so its bare
 * repetitions LEAKED. Accept-then-leak is the worst of the three honest
 * options (mask, refuse, or leak), because it reports success.
 *
 * This file pins the CLASS, not the instance: every length from the
 * remembering floor up through the registry floor is driven through the real
 * outbound redactor, and a value the layer accepts must be masked at its
 * bare (declaration-free) occurrence. A regression that reintroduces a split
 * floor UNDER ANY NAME — a new constant, a different literal, a filter moved
 * elsewhere — reds the band between the floors.
 *
 * §36: every absence assertion here has a witness in the same string.
 */

const POLICY = createPrivacyPolicy();

/** A rememberable value of exactly `length`: two character classes, not in
 * the placeholder veto list, not purely numeric. Derived, not hardcoded, so
 * the sweep follows the floors if they are ever re-derived. */
function rememberableValueOf(length: number): string {
  const seed = "Zq4kP7xW9mQ2rT8v";
  const value = seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
  assert.ok(
    rememberableDeclaredValue(value),
    `fixture bug: ${value} (length ${length}) must be accepted by rememberableDeclaredValue`,
  );
  return value;
}

test("floors: every accepted declared length masks its bare repetition (accept implies mask)", () => {
  // From the remembering floor through past the registry floor — the band
  // between the two is exactly where the accepted-then-leaked defect lived.
  for (let length = MIN_REMEMBERABLE_LENGTH; length <= MIN_KNOWN_SECRET_LENGTH + 2; length++) {
    const value = rememberableValueOf(length);
    const witness = `WITNESS-${length}-e5a1`;
    const { redacted, learnedCount, redact } = redactMessagesTogether(
      [
        `my password may be ${value}`,
        `the bare repetition ${value} sits beside ${witness}`,
      ],
      POLICY,
    );
    assert.equal(learnedCount, 1, `length ${length}: the declaration must be learned exactly once`);
    const second = redacted[1]!;
    assert.ok(second.includes(witness), `length ${length}: the witness must survive`);
    assert.ok(
      !second.includes(value),
      `length ${length}: a value the layer ACCEPTED (learnedCount=1) must be MASKED at its bare ` +
        `occurrence — accepted-then-leaked is the two-floors defect`,
    );
    assert.ok(
      second.includes(POLICY.redactionPrefix),
      `length ${length}: the mask must be the engine's own marker`,
    );
    const leaf = `parsed value ${value} beside ${witness}`;
    const contextualLeaf = redact(leaf);
    assert.ok(contextualLeaf.includes(witness));
    assert.ok(contextualLeaf.includes(POLICY.redactionPrefix));
    assert.ok(!contextualLeaf.includes(value), "parsed leaves share the turn's declared-value floor");
  }
});

test("floors: a value below the remembering floor is refused honestly — learnedCount says so", () => {
  // 5 characters: under the floor. The honest outcome is a refusal the
  // caller can SEE (learnedCount 0), never a success report beside a leak.
  const value = "Zq4kP";
  const witness = "WITNESS-under-floor";
  const { redacted, learnedCount } = redactMessagesTogether(
    [
      `my password may be ${value}`,
      `bare ${value} beside ${witness}`,
    ],
    POLICY,
  );
  assert.equal(learnedCount, 0, "a value under the remembering floor must not count as learned");
  assert.ok(redacted[1]!.includes(witness));
  // Its bare occurrence is NOT masked by identity — and that is the declared
  // contract: refusal is visible, not silent. (The declaration site itself
  // may still be masked by the declaration layer.)
  assert.ok(redacted[1]!.includes(value), "an unlearned value is not identity-masked — the refusal is visible");
});

test("floors: a vetoed placeholder is refused even above the floor", () => {
  const { learnedCount } = redactMessagesTogether(
    ["my password may be changeme", "bare changeme beside WITNESS-veto"],
    POLICY,
  );
  assert.equal(learnedCount, 0, "placeholder values must not be promoted to identity evidence");
});


test("Intentionally held credentials mask embedded escaped copies under THEIR OWN floor, independent of the inference and registry floors (a2b-design H1)", () => {
  const masks = (value: string, held: ReturnType<typeof heldValues>): boolean => {
    const forms = [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value), Buffer.from(value).toString("base64")];
    const texts = forms.map(form => `prefix ${form} suffix`);
    const before = redactMessagesTogether(texts).redacted;
    const after = redactMessagesTogether(texts, undefined, { heldCredentials: held }).redacted;
    const masked = forms.map((form, index) => after[index] !== before[index] && after[index]!.startsWith("prefix ") && after[index]!.endsWith(" suffix") && !after[index]!.includes(form));
    assert.ok(masked.every((each) => each === masked[0]), `${value}: every escape form alike`);
    return masked[0]!;
  };
  for (const value of ["a", "a7", "a7B", "a7B!", "a7B!z", "a7B!z9", "test"]) {
    // The operator's lowest floor (1): every held value masks every escape form (below the registry's 12 and the inference floors).
    assert.equal(masks(value, heldValues("test", [value], 1)), true, `${value} at floor 1`);
    // The default floor: a held value shorter than it is never searched for in text (a one-letter value masked every "a").
    assert.equal(masks(value, heldValues("test", [value])), value.length >= DEFAULT_HELD_MINIMUM_LENGTH, `${value} at the default floor`);
  }
  assert.deepEqual(redactMessagesTogether(["ordinary content"], undefined, { heldCredentials: heldValues("test", [""]) }).redacted, ["ordinary content"]);
});
