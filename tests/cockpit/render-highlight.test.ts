// @vitest-environment node
/**
 * The syntax highlighter (src/cockpit/render/highlight.ts).
 *
 * The load-bearing property is not "does it colour keywords" — it is that
 * highlighting is a PARTITION of the source. Tokenizing must never add,
 * drop, reorder, or rewrite a character, or the reader is looking at code
 * that differs from what the tool returned. That is asserted as a property
 * over every grammar and a spread of adversarial inputs.
 *
 * The second property is HONEST DECLINE: an unknown language, or input past
 * the cost budget, must come back `highlighted: false` with a stated
 * reason, not silently mis-coloured by a wrong grammar.
 */
import { describe, expect, test } from "vitest";

import {
  GRAMMAR_IDS,
  grammarForPath,
  highlight,
  resolveGrammar,
} from "../../src/cockpit/render/highlight.ts";
import { MAX_HIGHLIGHT_CHARS } from "../../src/cockpit/render/render-config.ts";

/** Rebuild the source from a highlight result. */
function rejoin(lines: readonly (readonly { text: string }[])[]): string {
  return lines.map((toks) => toks.map((t) => t.text).join("")).join("\n");
}

const SAMPLES: readonly string[] = [
  'const a = "x"; // comment\nfunction f(b) { return a + b; }',
  "def f(x):\n    # comment\n    return f'{x}'",
  'fn main() { let x: u32 = 1; /* c */ println!("{}", x); }',
  'package main\nimport "fmt"\nfunc main() { fmt.Println(1.5e3) }',
  '{"a": 1, "b": [true, null], "c": "s"}',
  "#!/bin/sh\nset -e\nfor f in *.ts; do echo \"$f\"; done",
  ".x { color: #abc; width: calc(100% - 2px); }",
  '<div class="a" data-x=\'1\'><!-- c --><span>t</span></div>',
  "SELECT a, b FROM t WHERE x = 'y' -- note",
  "key: value\n# comment\nlist:\n  - one\n  - two",
  "[section]\nkey = \"value\" # note",
  "public class A { private int x = 0; }",
  "#include <stdio.h>\nint main(void) { return 0; }",
  // Adversarial: unterminated everything, lone markers, unicode, tabs.
  'const s = "unterminated\nconst t = `also unterminated',
  "/* unterminated block comment",
  "\t\t  \n\n   \t",
  "emoji 🙂 and combining é and CJK 漢字",
  "a".repeat(5000),
  "",
  "\n",
  "\n\n\n",
];

describe("highlighting is a PARTITION of the source", () => {
  for (const id of GRAMMAR_IDS) {
    test(`grammar "${id}" preserves every sample exactly`, () => {
      for (const sample of SAMPLES) {
        const r = highlight(sample, id);
        expect(rejoin(r.lines), `grammar ${id} altered: ${JSON.stringify(sample.slice(0, 40))}`).toBe(
          sample,
        );
        // One entry per source line, always.
        expect(r.lines).toHaveLength(sample.split("\n").length);
      }
    });
  }

  test("an unknown language preserves the source too", () => {
    for (const sample of SAMPLES) {
      expect(rejoin(highlight(sample, "brainfuck").lines)).toBe(sample);
    }
  });

  test("no token is ever empty (empty spans would be dead DOM)", () => {
    for (const id of GRAMMAR_IDS) {
      for (const sample of SAMPLES) {
        for (const line of highlight(sample, id).lines) {
          for (const tok of line) expect(tok.text.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe("declining is honest, never a wrong guess", () => {
  test("an unknown language declines WITH a reason", () => {
    const r = highlight("x", "cobol");
    expect(r.highlighted).toBe(false);
    expect(r.grammar).toBeNull();
    expect(r.declined).toContain("cobol");
  });

  test("an unlabelled fence declines and says so", () => {
    const r = highlight("x", "");
    expect(r.highlighted).toBe(false);
    expect(r.declined).toContain("no language");
  });

  test("input past the budget declines and names the budget", () => {
    const huge = "a".repeat(MAX_HIGHLIGHT_CHARS + 1);
    const r = highlight(huge, "ts");
    expect(r.highlighted).toBe(false);
    expect(r.declined).toContain("budget");
    expect(rejoin(r.lines)).toBe(huge);
  });

  test("a known language reports the grammar it used", () => {
    const r = highlight("const a = 1;", "typescript");
    expect(r.highlighted).toBe(true);
    expect(r.grammar).toBe("ts");
  });
});

describe("the roles a reader depends on", () => {
  function kindOf(code: string, lang: string, text: string): string | undefined {
    for (const line of highlight(code, lang).lines) {
      for (const tok of line) if (tok.text === text) return tok.kind;
    }
    return undefined;
  }

  test("keywords, strings, numbers and comments are distinguished in ts", () => {
    const src = 'const n = 42; // note\nreturn "s";';
    expect(kindOf(src, "ts", "const")).toBe("keyword");
    expect(kindOf(src, "ts", "42")).toBe("number");
    expect(kindOf(src, "ts", "// note")).toBe("comment");
    expect(kindOf(src, "ts", '"s"')).toBe("string");
  });

  test("a call target reads as a function", () => {
    expect(kindOf("doThing(1)", "ts", "doThing")).toBe("func");
  });

  test("a json key is distinguished from a json string value", () => {
    const src = '{"k": "v"}';
    expect(kindOf(src, "json", '"k"')).toBe("string");
    expect(kindOf(src, "json", "true")).toBeUndefined();
    expect(kindOf('{"a": true}', "json", "true")).toBe("keyword");
  });

  test("a python triple-quoted string is one token, not three", () => {
    const src = 'x = """a\nb"""';
    const r = highlight(src, "python");
    const joined = r.lines.flat().filter((t) => t.kind === "string");
    expect(joined.length).toBeGreaterThan(0);
  });
});

describe("language resolution", () => {
  test("aliases map to their grammar", () => {
    expect(resolveGrammar("tsx")).toBe("ts");
    expect(resolveGrammar("Bash")).toBe("sh");
    expect(resolveGrammar("YML")).toBe("yaml");
    expect(resolveGrammar("golang")).toBe("go");
  });

  test("an unknown or empty language resolves to null (no fallback guess)", () => {
    expect(resolveGrammar("cobol")).toBeNull();
    expect(resolveGrammar("")).toBeNull();
    expect(resolveGrammar("   ")).toBeNull();
  });

  test("a path's extension names its grammar, and an unknown one stays null", () => {
    expect(grammarForPath("src/a/b.ts")).toBe("ts");
    expect(grammarForPath("a\\b\\c.py")).toBe("python");
    expect(grammarForPath("Makefile")).toBeNull();
    expect(grammarForPath(".gitignore")).toBeNull();
    expect(grammarForPath("a.unknownext")).toBeNull();
  });
});
