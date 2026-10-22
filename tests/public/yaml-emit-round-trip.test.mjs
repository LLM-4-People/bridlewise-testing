// THE ONE YAML EMITTER READS BACK AS ITS VALUE (engine/src/text/yaml-emit.ts).
// Class: a generated YAML file GitHub reads must mean exactly the value the
// generator built. Plant: 3,000 seeded random documents whose keys include the
// YAML 1.1 boolean and null words and whose strings include every character a
// reader folds or refuses raw (DEL, C1, NEL, U+2028, U+2029, the BOM), leading
// and trailing spaces, comment and mapping breakers, number-shaped and
// multi-line text. Driven: each is emitted and parsed back by the repository's
// one YAML reader (`yaml`) as YAML 1.1 AND 1.2. Liveness: the reader does
// misread the plain spellings the emitter quotes.
import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "yaml";

import { Commented, emitYaml } from "../../engine/src/text/yaml-emit.ts";

/** A small deterministic generator (mulberry32), so a failure names its seed. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KEYS = ["on", "yes", "no", "y", "n", "off", "true", "null", "Yes", "ON", "name", "runs-on", "a b", "x:", "#k", "-k", "1", ".5", "~", "é", "k\u0085", ""];
const PIECES = ["a", "Z", " ", ": ", " #", "#", "-", "?", "*", "&", "!", "|", ">", "'", "\"", "%", "@", "`", "[", "]", "{", "}", ",", "\\", "\n", "\t", "\r", "\u007f", "\u0085", "\u0080", "\u009f", "\u2028", "\u2029", "\ufeff", "é", "€", "0", "1.0", "0x1F", "1e3", "1:20", "yes", "No", "null", "~", ".inf", ".nan", "${{ x }}", "./p", ".5", "<<", "=", "\u0001", "\u001b"];

function string(next) {
  const length = Math.floor(next() * 6);
  let text = "";
  for (let index = 0; index < length; index += 1) text += PIECES[Math.floor(next() * PIECES.length)];
  return text;
}

function value(next, depth) {
  const pick = next();
  if (depth > 3 || pick < 0.45) return string(next);
  if (pick < 0.5) return Math.floor(next() * 2_000_001) - 1_000_000;
  if (pick < 0.53) return Math.round(next() * 1000) / 8;
  if (pick < 0.56) return next() < 0.5;
  if (pick < 0.58) return null;
  if (pick < 0.78) return Array.from({ length: Math.floor(next() * 4) }, () => value(next, depth + 1));
  const object = {};
  for (let index = Math.floor(next() * 4); index > 0; index -= 1) object[KEYS[Math.floor(next() * KEYS.length)] + (next() < 0.3 ? string(next) : "")] = value(next, depth + 1);
  return object;
}

test("3,000 random documents read back as their value, as YAML 1.1 and 1.2", () => {
  for (let seed = 1; seed <= 3000; seed += 1) {
    const next = random(seed);
    const document = { root: value(next, 0), [KEYS[seed % KEYS.length]]: value(next, 1) };
    const text = emitYaml(document);
    for (const version of ["1.1", "1.2"]) {
      assert.deepEqual(parse(text, { version, uniqueKeys: true }), document, `seed ${seed}, YAML ${version}:\n${text}`);
    }
  }
});

test("a comment rides after its scalar, and header comments lead the document", () => {
  const text = emitYaml({ uses: new Commented("actions/checkout@0123abc", "v5") }, ["generated", ""]);
  assert.equal(text, "# generated\n#\nuses: actions/checkout@0123abc # v5\n");
  assert.deepEqual(parse(text), { uses: "actions/checkout@0123abc" });
});

test("what has no form every reader reads back is refused, typed", () => {
  for (const bad of [{ n: Number.NaN }, { n: Infinity }, { n: 1e21 }, { n: 2 ** 60 }, { n: 1e-7 }, { u: undefined }, { f: () => 1 }, { d: new Date(0) }]) {
    assert.throws(() => emitYaml(bad), (error) => error.code === "yaml_unrepresentable", JSON.stringify(Object.keys(bad)));
  }
  assert.throws(() => emitYaml({ a: 1 }, ["two\nlines"]), (error) => error.code === "yaml_unrepresentable");
  assert.throws(() => new Commented("x", "two\nlines"), (error) => error.code === "yaml_unrepresentable");
});

test("liveness: the reader does misread what the emitter must quote, and no raw folding character is ever written", () => {
  assert.equal(parse("k: on", { version: "1.1" }).k, true);
  assert.equal(parse("on: 1", { version: "1.1" }).true, 1);
  assert.equal(parse("k: 1:20", { version: "1.1" }).k, 80, "a YAML 1.1 sexagesimal");
  assert.deepEqual(parse(emitYaml({ on: "on", k: "1:20" }), { version: "1.1" }), { on: "on", k: "1:20" });
  // The `yaml` reader keeps NEL, DEL, C1, U+2028 and U+2029 raw, but PyYAML and GitHub's reader fold or refuse
  // them (the #56 review's fuzz): the emitter never writes one raw.
  const text = emitYaml({ k: "a\u0085b\u007f\u0080\u2028\u2029\ufeff\u0001", list: ["x\u0085\ny"] });
  assert.doesNotMatch(text, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\ufeff]/u);
  assert.deepEqual(parse(text, { version: "1.1" }), { k: "a\u0085b\u007f\u0080\u2028\u2029\ufeff\u0001", list: ["x\u0085\ny"] });
});
