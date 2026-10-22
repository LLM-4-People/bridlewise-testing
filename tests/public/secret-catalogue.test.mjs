import assert from "node:assert/strict";
import { test } from "node:test";

import { SECRET_TEXT_SIGNAL_CATALOG, signalFixture } from "../../engine/src/privacy/secret-signals.ts";

/**
 * THE CATALOGUE'S GITHUB PROJECTIONS (github-only §8.2): every row of
 * `engine/src/privacy/secret-signals.ts` declares how GitHub sees it, and a
 * `custom` row's pattern must be expressible in GitHub's Hyperscan subset
 * (no lookarounds, back-references or inline modifiers) AND give the same
 * verdict as the row's own grammar on every fixture. GitHub cannot be asked
 * here, so its matcher is emulated: the default delimiters are
 * `\A|[^0-9A-Za-z]` before and `\z|[^0-9A-Za-z]` after the secret, and
 * `mustMatch` / `mustNotMatch` are conjuncts over the matched secret.
 */

const KINDS = new Set(["provider", "generic", "custom", "door-only"]);
const OUTSIDE_SUBSET = [/\(\?[=!]/u, /\(\?<[=!]/u, /\\[1-9]/u, /\(\?[a-z]+[):]/u];
const DEFAULT_START = "(?:^|[^0-9A-Za-z])";
const DEFAULT_END = "(?=$|[^0-9A-Za-z])";

/** Whether the emulated GitHub custom pattern finds a secret in `text`. */
function githubCustomMatches(projection, text) {
  const start = projection.startDelimiter === undefined ? DEFAULT_START : `(?:${projection.startDelimiter})`;
  const end = projection.endDelimiter === undefined ? DEFAULT_END : `(?=${projection.endDelimiter})`;
  const matcher = new RegExp(`${start}(${projection.pattern})${end}`, "gu");
  for (const match of text.matchAll(matcher)) {
    const secret = match[1];
    const required = (projection.mustMatch ?? []).every((pattern) => new RegExp(pattern, "u").test(secret));
    const excluded = (projection.mustNotMatch ?? []).some((pattern) => new RegExp(pattern, "u").test(secret));
    if (required && !excluded) return true;
  }
  return false;
}

test("every catalogue row declares a known GitHub projection", () => {
  for (const signal of SECRET_TEXT_SIGNAL_CATALOG) {
    const { github } = signal;
    assert.ok(KINDS.has(github.kind), `${signal.id}: unknown projection ${String(github.kind)}`);
    if (github.kind === "provider" || github.kind === "generic") {
      assert.ok(github.secretTypes.length > 0, `${signal.id}: a ${github.kind} projection names its GitHub secret types`);
    }
    if (github.kind === "door-only") assert.ok(github.reason.length > 20, `${signal.id}: door-only without a reason`);
  }
});

test("every custom pattern is inside GitHub's Hyperscan subset", () => {
  const custom = SECRET_TEXT_SIGNAL_CATALOG.filter((signal) => signal.github.kind === "custom");
  assert.ok(custom.length >= 6, `only ${String(custom.length)} custom rows`);
  for (const signal of custom) {
    const { pattern, startDelimiter = "", endDelimiter = "", mustMatch = [], mustNotMatch = [] } = signal.github;
    for (const source of [pattern, startDelimiter, endDelimiter, ...mustMatch, ...mustNotMatch]) {
      for (const forbidden of OUTSIDE_SUBSET) {
        assert.doesNotMatch(source, forbidden, `${signal.id}: ${source} uses a construct GitHub's subset refuses`);
      }
    }
  }
  // The subset check itself refuses what it names (planted).
  for (const planted of ["a(?=b)", "a(?!b)", "(?<=a)b", "(a)\\1", "(?i)abc"]) {
    assert.ok(OUTSIDE_SUBSET.some((forbidden) => forbidden.test(planted)), `${planted} passed the subset check`);
  }
});

test("each custom pattern gives the row's own verdict on every fixture", () => {
  for (const signal of SECRET_TEXT_SIGNAL_CATALOG.filter((row) => row.github.kind === "custom")) {
    signal.fixtures.positive.forEach((_parts, index) => {
      const value = signalFixture(signal.id, index);
      for (const text of [value, ` ${value} `, `(${value})`]) {
        assert.equal(signal.admission.test(text), true, `${signal.id}[${String(index)}]: the row's grammar misses its own fixture`);
        assert.equal(githubCustomMatches(signal.github, text), true, `${signal.id}[${String(index)}]: the GitHub pattern misses ${JSON.stringify(text.slice(0, 12))}…`);
      }
    });
    for (const negative of signal.fixtures.negative) {
      assert.equal(signal.admission.test(negative), false, `${signal.id}: the row's grammar matches its near miss`);
      assert.equal(githubCustomMatches(signal.github, negative), false, `${signal.id}: the GitHub pattern matches the near miss ${negative}`);
    }
  }
});

test("every row's fixtures are honest: positives match, negatives do not, and no positive is one literal", () => {
  for (const signal of SECRET_TEXT_SIGNAL_CATALOG) {
    assert.ok(signal.fixtures.positive.length > 0, `${signal.id} has no positive fixture`);
    assert.ok(signal.fixtures.negative.length > 0, `${signal.id} has no near miss`);
    signal.fixtures.positive.forEach((parts, index) => {
      assert.ok(parts.length >= 2, `${signal.id}[${String(index)}] is one literal: a source file would hold the whole credential`);
      const value = signalFixture(signal.id, index);
      assert.equal(signal.admission.test(value), true, `${signal.id}[${String(index)}] admission`);
      assert.equal(signal.classification.test(value), true, `${signal.id}[${String(index)}] classification`);
      for (const part of parts) {
        assert.equal(signal.admission.test(part), false, `${signal.id}[${String(index)}]: the part ${JSON.stringify(part.slice(0, 8))}… is itself a credential`);
      }
    });
    for (const negative of signal.fixtures.negative) assert.equal(signal.admission.test(negative), false, `${signal.id}: ${negative}`);
  }
  assert.throws(() => signalFixture("makora-key", 9), /has no positive fixture 9/u);
});
