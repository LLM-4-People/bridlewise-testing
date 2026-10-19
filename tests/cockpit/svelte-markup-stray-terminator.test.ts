// @vitest-environment node
/**
 * A closing `>` that lands on its own line AFTER its tag already closed is
 * not tag syntax any more — Svelte parses it as a Text node and renders it
 * as a stray character in the UI (measured: an orphaned terminator beside
 * the conversation verbs rendered a literal ">" between two buttons and a
 * second one trailing them, read by users as an arrow affordance).
 *
 * The detector is the Svelte parser itself, not a text scan: a legitimate
 * split-tag terminator (`</button` + newline + `>`, or a multi-line
 * opening tag closed by a lone `>`) produces NO text node, while an
 * orphaned one always does. Text scanning cannot tell the two apart —
 * attribute expressions containing `=>` poison every line heuristic.
 */
import { describe, expect, test } from "vitest";
import { parse } from "svelte/compiler";
import { read, sourceFiles, relpath } from "../helpers/source-scan.ts";

/** Text nodes whose entire content is whitespace + `>` — a rendered stray. */
function strayTerminators(source: string, filename: string): string[] {
  const ast = parse(source, { filename });
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as { type?: string; data?: unknown; [k: string]: unknown };
    if (n.type === "Text" && typeof n.data === "string" && /^\s*>+\s*$/.test(n.data)) {
      found.push(n.data);
    }
    for (const value of Object.values(n)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  };
  visit(ast.html);
  return found;
}

describe("no orphaned tag terminator renders as stray text", () => {
  test("split-tag terminators are syntax, orphans are text nodes (witnesses)", () => {
    // Legit: a multi-line opening tag closed by a lone `>`.
    expect(strayTerminators("<button\n  onclick={x}\n>ok</button>", "witness.svelte")).toEqual([]);
    // Legit: a closing tag split across lines.
    expect(strayTerminators("<button>ok</button\n>", "witness.svelte")).toEqual([]);
    // Orphan: the tag already closed; the lone `>` renders.
    expect(strayTerminators("<button>ok</button>\n>", "witness.svelte")).not.toEqual([]);
    // Orphan: after an expression close, a lone `>` renders.
    expect(strayTerminators("<span>{x}</span>\n  >", "witness.svelte")).not.toEqual([]);
  });

  test("every cockpit svelte file renders zero stray `>` text nodes", () => {
    const svelte = sourceFiles("src").map(relpath).filter((f) => f.endsWith(".svelte"));
    expect(svelte.length, "the scan must find the svelte tree").toBeGreaterThan(50);
    const offenders: string[] = [];
    for (const f of svelte) {
      const hits = strayTerminators(read(f), f);
      if (hits.length > 0) offenders.push(`${f}: ${hits.length} stray text node(s)`);
    }
    expect(offenders, "orphaned `>` terminators render as stray characters").toEqual([]);
  });
});
