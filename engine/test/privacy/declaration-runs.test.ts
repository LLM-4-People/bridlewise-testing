import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { registerAt } from "../../src/privacy/value-intrinsic.ts";
import { createPrivacyPolicy } from "../../src/privacy/privacy-policy.ts";
import { lexiconForScope } from "../../src/privacy/credential-lexicon.ts";
import { declaredSecretSpans, registerKnownSecret, forgetKnownSecret } from "../../src/privacy/secret-intelligence.ts";
import { redactForLLMContext, detectProtocolIdentitySensitiveSpans } from "../../src/privacy/redaction-engine.ts";

const policy = createPrivacyPolicy();
const value = "hG7nP2xK9qV3mR8sT4wL6bC1";
const declared = (text: string) => declaredSecretSpans(text, undefined, lexiconForScope(""), policy);

for (const [label, character] of [["BMP", "界"], ["astral", "𐐨"]] as const) {
  test(`declaration runs: configured-size ${label} text remains exact and a following secret is detected`, () => {
    // The actual harness config accepts16MiB documents. This is one complete
    // word, not many small words that avoid the native-regexp failure.
    const prefix = character.repeat(Math.ceil(16_777_216 / Buffer.byteLength(character)));
    const text = prefix + "\nmy acc is " + value;
    let output = "";
    assert.doesNotThrow(() => { output = redactForLLMContext(text); });
    assert.equal(output.slice(0, prefix.length), prefix);
    assert.equal(output.includes(value), false);
  });
}

test("declaration runs: large camel population streams without argument spreading or numeric suffix cues", () => {
  const run = "aB".repeat(150_000);
  const camel = run + "\nmy2Acc is " + value;
  let spans: ReturnType<typeof declared> = [];
  assert.doesNotThrow(() => { spans = declared(camel); });
  assert.ok(spans.some((span) => camel.slice(span.startUtf16, span.endUtf16) === value));
  const numeric = "4" + run + "xAcc is " + value;
  assert.deepEqual(declared(numeric), []);
});

test("declaration runs: UTF16 offsets, removed characters and known identities retain their meaning", () => {
  for (const prefix of ["𐐨", "𝟜", "4\u0301", "4\u200b"]) {
    assert.deepEqual(detectProtocolIdentitySensitiveSpans(prefix + "acc-9d1e-4bcaf159dcf0"), []);
  }
  const text = "𐐨\nmy2Acc is " + value;
  assert.ok(detectProtocolIdentitySensitiveSpans(text).some((span) => text.slice(span.startUtf16, span.endUtf16) === value));
  const identity = "evt-1015365c-98ac-4acc-9d1e-4bcaf159dcf0";
  registerKnownSecret(identity, "large-run-known-control");
  try { assert.equal(redactForLLMContext(identity).includes(identity), false); }
  finally { forgetKnownSecret("large-run-known-control"); }
});

test("declaration runs: prose register preserves the legacy unanchored word language", () => {
  const legacy = /(?:[A-Za-z']+\s+){3,}[A-Za-z']+/u;
  // Isolate the subtractive prose signal through the real public classifier.
  // This corpus has no assignment, call, terminator or compound-case signal.
  const tuning = { symbolDensity: Infinity, indentColumns: Infinity, minSignals: 0 };
  const check = (line: string) => assert.equal(registerAt(line, 0, tuning), line.length === 0 || legacy.test(line) ? "prose" : "code", JSON.stringify(line));
  const alphabet = ["a", "'", " ", "1", "."];
  let level = [""];
  let checked = 0;
  for (let length = 0; length <= 7; length += 1) {
    for (const line of level) { check(line); checked += 1; }
    if (length < 7) level = level.flatMap((line) => alphabet.map((character) => line + character));
  }
  // The empty line has a dedicated prose return; the corpus below exercises
  // actual word predicates, including JS whitespace beyond ASCII space/tab.
  assert.equal(checked, 97_656);
  for (const separator of ["\t", "\v", "\f", "\r", "\u00a0", "\u1680", "\u2000", "\u2028", "\u2029", "\u202f", "\u205f", "\u3000", "\ufeff", "\u0085", "é", "’"]) {
    check(["abc", "def", "ghi", "jkl"].join(separator));
    check(["'", "'", "'", "'"].join(separator));
  }
  for (const line of ["abc def ghi", "ABC DEF GHI JKL", "1abc def ghi jkl2", "abc de1f ghi jkl", "abc def, ghi jkl", "éabc def ghi jklé", "abc def ghi jkl.more"]) check(line);
});

test("declaration runs: same-line large camel cue completes and retains its secret span", () => {
  const intelligence = new URL("../../src/privacy/secret-intelligence.ts", import.meta.url).href;
  const lexicon = new URL("../../src/privacy/credential-lexicon.ts", import.meta.url).href;
  const policies = new URL("../../src/privacy/privacy-policy.ts", import.meta.url).href;
  const code = `import {declaredSecretSpans} from ${JSON.stringify(intelligence)};
import {lexiconForScope} from ${JSON.stringify(lexicon)};
import {createPrivacyPolicy} from ${JSON.stringify(policies)};
const value=${JSON.stringify(value)},text='aB'.repeat(150000)+'xAcc is '+value;
console.log('entered same-line declaration');
const spans=declaredSecretSpans(text,undefined,lexiconForScope(''),createPrivacyPolicy());
console.log(JSON.stringify(spans.map(s=>text.slice(s.startUtf16,s.endUtf16))));`;
  // A separate owned process makes a synchronous scanner regression bounded.
  // This generous watchdog is not a production scan limit or a throughput claim.
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", code], {
    encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL",
  });
  assert.ok(child.stdout.startsWith("entered same-line declaration\n"), child.stderr);
  assert.equal(child.status, 0, `same-line declaration must complete; ${child.error?.message ?? child.stderr}`);
  assert.equal(child.signal, null);
  assert.deepEqual(JSON.parse(child.stdout.trim().split("\n").at(-1)!), [value]);
});
