/**
 * THE YAML EMITTER — every shape the generated workflows use is emitted
 * deterministically and reads back as itself: plain scalars only where no
 * reader could take them for anything else, JSON-quoted otherwise, literal
 * blocks for multi-line text, the bare key for null, a pin's version as a
 * trailing comment; anything else is a typed refusal.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { Commented, emitYaml } from "../../../src/workflow/gates/yaml.ts";

test("plain scalars stay plain; anything a reader could misread is quoted", () => {
  const text = emitYaml({
    plain: "ubuntu-24.04",
    path: ".nvmrc",
    expression: "${{ matrix.language }}",
    category: "/language:${{ matrix.language }}",
    word: "on",
    truthy: "true",
    yes: "Yes",
    digits: "17 3 * * *",
    colonSpace: "x: y",
    comment: "a #b",
    trailingColon: "key:",
    leadingDash: "-x",
    leadingStar: "*x",
    infinity: ".inf",
    empty: "",
    trailingSpace: "x ",
    number: 5,
    boolean: true,
  });
  assert.equal(text, [
    "plain: ubuntu-24.04",
    "path: .nvmrc",
    "expression: ${{ matrix.language }}",
    "category: /language:${{ matrix.language }}",
    'word: "on"',
    'truthy: "true"',
    'yes: "Yes"',
    'digits: "17 3 * * *"',
    'colonSpace: "x: y"',
    'comment: "a #b"',
    'trailingColon: "key:"',
    'leadingDash: "-x"',
    'leadingStar: "*x"',
    'infinity: ".inf"',
    'empty: ""',
    'trailingSpace: "x "',
    "number: 5",
    "boolean: true",
    "",
  ].join("\n"));
});

test("keys: a slug is bare (GitHub's own `on`), anything else is quoted", () => {
  assert.equal(emitYaml({ on: {}, "runs-on": "x", "a b": 1 }), 'on: {}\nruns-on: x\n"a b": 1\n');
});

test("nested mappings and sequences are block-indented by two", () => {
  const text = emitYaml({ jobs: { a: { needs: ["plan", "light"], steps: [{ name: "one", with: { k: "v" } }, { run: "x" }] } }, list: [[1, 2], []] });
  assert.equal(text, [
    "jobs:",
    "  a:",
    "    needs:",
    "      - plan",
    "      - light",
    "    steps:",
    "      - name: one",
    "        with:",
    "          k: v",
    "      - run: x",
    "list:",
    "  - - 1",
    "    - 2",
    "  - []",
    "",
  ].join("\n"));
});

test("multi-line text is a literal block, with the chomping its final newline needs", () => {
  assert.equal(emitYaml({ run: "a\nb\n" }), "run: |\n  a\n  b\n");
  assert.equal(emitYaml({ run: "a\nb" }), "run: |-\n  a\n  b\n");
  assert.equal(emitYaml({ run: "a\n\nb\n" }), "run: |\n  a\n\n  b\n");
  assert.equal(emitYaml({ items: ["a\nb\n"] }), "items:\n  - |\n    a\n    b\n");
});

test("null is GitHub's bare key; a pin carries its version as a comment", () => {
  assert.equal(emitYaml({ "wait-all": null }), "wait-all:\n");
  assert.equal(emitYaml({ uses: new Commented("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", "v7") }), "uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7\n");
});

test("the same value always gives the same bytes", () => {
  const value = { b: [1, { c: "d\ne\n" }], a: "${{ x }}" };
  assert.equal(emitYaml(value), emitYaml(structuredClone(value)));
});

test("an unrepresentable value is a typed refusal, never skipped", () => {
  const refusals: readonly unknown[] = [
    { x: undefined },
    { x: Number.NaN },
    { x: Number.POSITIVE_INFINITY },
    { x: new Date(0) },
    { x: "line \nnext" },
    { x: " indented\nnext" },
  ];
  for (const value of refusals) {
    assert.throws(() => emitYaml(value as never), (error: unknown) => (error as { code?: string }).code === "yaml_unrepresentable", JSON.stringify(value, (_key, inner: unknown) => (inner === undefined ? "undefined" : inner)));
  }
  assert.throws(() => new Commented("x", "a\nb"), (error: unknown) => (error as { code?: string }).code === "yaml_unrepresentable");
});
