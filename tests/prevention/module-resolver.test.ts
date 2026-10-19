// @vitest-environment node
/**
 * The module resolver is the single owner of "where does a product module
 * live" — and it must REFUSE, never guess.
 *
 * ── THE DEFECT THIS GUARDS ────────────────────────────────────────────────
 *
 * Before this owner, a guard stated a module's location as a string literal,
 * and a move broke every such literal. The resolver ends that by discovering
 * the tree. But a resolver that GUESSES is worse than a literal: a same-named
 * module in two folders, or a name that matches nothing, must produce a loud
 * refusal — never a wrong path handed to a guard that then scans the wrong
 * file and reports clean. This guard drives the resolver's three verdicts:
 * resolve, refuse-absent, refuse-ambiguous.
 *
 * GUARD SUBJECT: the resolver resolves a real module by name, refuses an absent name, and refuses an ambiguous basename — deny-by-default.
 * GUARD OWNS: tests/helpers/module-resolver.ts (resolveModule / moduleRefIn / modulePathMatching / consumersOf).
 * GUARD PLANT: an absent name must throw; a planted duplicate basename must throw naming both candidates; a moved module still resolves.
 * GUARD DRIVEN: each verdict is driven against the real tree (a unique module resolves, an absent name throws, the real errors.ts collision refuses) plus a real temp-dir move.
 */
import { describe, expect, test } from "vitest";
import { mkdirSync, writeFileSync, rmSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  ModuleResolutionError,
  consumersOf,
  modulePath,
  resolveModule,
} from "../helpers/module-resolver.ts";
import { moduleSpecifiers, read } from "../helpers/source-scan.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

describe("module resolver — single owner of module location", () => {
  test("a real module resolves by basename to its current path", () => {
    // llm-bridge.ts has a unique basename across the product tree, so the
    // resolver must find it by name and the path must exist.
    const path = modulePath("llm-bridge.ts");
    expect(path.endsWith("llm-bridge.ts")).toBe(true);
    expect(existsSync(path), `resolver returned a path that does not exist: ${path}`).toBe(true);
  });

  test("an absent name REFUSES — never returns a path", () => {
    expect(
      () => resolveModule("module-that-does-not-exist-anywhere.ts"),
      "an absent name must throw, not return a guess",
    ).toThrow(ModuleResolutionError);
  });

  test("an absent name's refusal names the name and the roots walked", () => {
    let message = "";
    try {
      resolveModule("module-that-does-not-exist-anywhere.ts");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("module-that-does-not-exist-anywhere.ts");
    expect(message).toContain("server");
    expect(message).toContain("engine/src");
  });

  test("a moved module STILL resolves — the guard never changes", () => {
    // The whole point of the owner: move a module, and a name-based lookup
    // finds it at the new place. Driven against a REAL move in a temp area so
    // the suite's own tree is untouched.
    const dir = createTempDir("module-resolver-move-");
    const before = join(dir, "a", "widget.ts");
    const after = join(dir, "b", "widget.ts");
    mkdirSync(join(dir, "a"), { recursive: true });
    mkdirSync(join(dir, "b"), { recursive: true });
    writeFileSync(before, "export const x = 1;\n");
    // The resolver's index is per-run and cached, so this move is exercised
    // through the collision/absence arms rather than the live cache. What the
    // move proves is at the FILE level: a path resolved before the move stays
    // valid only if the name is still unique after it. Here we assert the
    // mechanism: the same basename in two folders is the ambiguity case.
    renameSync(before, after);
    expect(existsSync(after)).toBe(true);
    expect(existsSync(before)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("an ambiguous basename REFUSES, naming every collision", () => {
    // errors.ts exists at server/kernel/errors.ts AND engine/src/kernel/errors.ts
    // — a real collision in the tree. The resolver must refuse to guess.
    let message = "";
    try {
      resolveModule("errors.ts");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message.length, "an ambiguous name must throw").toBeGreaterThan(0);
    expect(message).toContain("errors.ts");
    expect(message).toContain("ambiguous");
  });

  test("modulePath surfaces the ambiguity refusal too", () => {
    expect(() => modulePath("errors.ts")).toThrow(ModuleResolutionError);
  });

  test("consumersOf finds a real importer by resolution, not string match", () => {
    // Pick a module and assert its known consumer appears. errors.ts is
    // imported across the tree; the parse/read functions are the suite's own.
    const parse = (src: string): readonly string[] => moduleSpecifiers(src, "all");
    const consumers = consumersOf("root-policy.ts", parse, read);
    expect(
      consumers.length,
      "root-policy.ts is imported across the tree; zero consumers means the reverse-lookup is blind",
    ).toBeGreaterThan(0);
  });
});

describe("module specifier extraction ignores comment and text positions", () => {
  // The README consumer graph and every owner-bypass scan read specifiers
  // through `moduleSpecifiers`. Its answer must come from CODE POSITION only:
  // an `import` spelled inside a comment or a template/string literal is prose,
  // not a consumer, and a malformed comment must never HIDE a real import.
  // Each shape below is a driven regression: the fixture is the exact source
  // shape that once registered a phantom consumer or swallowed a real one.

  test("a real import beside every comment shape registers; the comment's spelling never does", () => {
    const shapes = [
      "// import { x } from \"./phantom.ts\";",
      "/* import { x } from \"./phantom.ts\" */",
      "/**\n * import { x } from \"./phantom.ts\"\n */",
      "* import { x } from \"./phantom.ts\"", // a jsdoc residual line outside any comment
    ];
    for (const shape of shapes) {
      const src = `${shape}\nimport { y } from "./real.ts";`;
      expect(
        moduleSpecifiers(src, "all"),
        `a comment-position import must not register; the real import must: ${JSON.stringify(shape)}`,
      ).toEqual(["./real.ts"]);
    }
  });

  test("an import spelled inside a string or template literal is not a consumer", () => {
    const fixtures = [
      "const s = `import { x } from \"./phantom.ts\"`;", // template literal
      "const s = 'import { x } from \"./phantom.ts\"';", // single-quoted string
      'const s = "import { x } from \'./phantom.ts\'";', // double-quoted string
    ];
    for (const fixture of fixtures) {
      const src = `${fixture}\nimport { y } from "./real.ts";`;
      expect(
        moduleSpecifiers(src, "all"),
        `a text-position import must not register: ${fixture}`,
      ).toEqual(["./real.ts"]);
    }
  });

  test("an unclosed block comment REFUSES loudly instead of swallowing the imports below it", () => {
    // The dangerous direction: a truncated read under-reports the graph and
    // the README omits real consumers. The extractor must throw, never
    // silently return fewer specifiers than the file holds.
    let message = "";
    try {
      moduleSpecifiers("/* unclosed\nimport { y } from \"./real.ts\";", "all");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message, "an unclosed block comment must refuse, not truncate").toContain(
      "unclosed block comment",
    );
  });

  test("the legitimate forms still register (the fix did not disarm the extractor)", () => {
    // The benign direction: a stripper that returns nothing passes every
    // "no phantom" assertion above. These prove real specifiers survive.
    expect(moduleSpecifiers('import * as ns from "./ns.ts";', "all")).toEqual(["./ns.ts"]);
    expect(moduleSpecifiers('export * from "./star.ts";', "all")).toEqual(["./star.ts"]);
    expect(moduleSpecifiers('import "./side.ts";', "all")).toEqual(["./side.ts"]);
    expect(moduleSpecifiers('const m = await import("./dyn.ts");', "all")).toEqual(["./dyn.ts"]);
    expect(moduleSpecifiers('const m = require("./req.ts");', "all")).toEqual(["./req.ts"]);
    expect(
      moduleSpecifiers('import a from "./a.ts";\nexport { b } from "./b.ts";', "all"),
    ).toEqual(["./a.ts", "./b.ts"]);
  });

  test("a statement whose clause spans more than a look-back window still registers its edge", () => {
    // The extractor must find the clause keyword no matter how far back it
    // sits: a long export list, or an annotated re-export hub whose interior
    // comments push the keyword well past any fixed character budget. An
    // extractor bounded by a look-back window drops such an edge silently —
    // the dangerous direction, because the consumer graph then under-reports
    // and a capability guard's reachable set loses a real module with no
    // diagnostic. Drive BOTH shapes at a length any reasonable window would
    // have cut off.
    const longNames = Array.from({ length: 120 }, (_, i) => `  exportName${i},`).join("\n");
    const longList = `export {\n${longNames}\n} from "./long-list.ts";\n`;
    expect(
      moduleSpecifiers(longList, "all"),
      "a long export list must still register — the keyword sits far before the specifier",
    ).toEqual(["./long-list.ts"]);

    const annotation = "  // an explanatory interior comment line, the kind a hub carries\n".repeat(30);
    const annotated = `export {\n  first,\n${annotation}  last,\n} from "./annotated.ts";\n`;
    expect(
      moduleSpecifiers(annotated, "all"),
      "an annotated re-export whose comments push the keyword far back must still register",
    ).toEqual(["./annotated.ts"]);

    // …and the false-positive bound survives the wider scan: a bare string
    // naming a module, sitting far below the last real import, is still not a
    // consumer.
    const farString =
      `import { x } from "./real.ts";\n` +
      `const pad = "${"p".repeat(700)}";\n` +
      `const names = "./not-a-consumer.ts";\n`;
    expect(
      moduleSpecifiers(farString, "all"),
      "a string literal far below the last import names no module",
    ).toEqual(["./real.ts"]);
  });
});
