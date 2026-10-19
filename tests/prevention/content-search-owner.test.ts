// @vitest-environment node
/**
 * CONTENT SEARCH: ONE OWNER, OFF THE EVENT LOOP, AND HONEST ABOUT ITS OWN
 * COMPLETENESS.
 *
 * Content search is a real, distinct capability, not a worse copy of symbol
 * search. The hybrid BM25 ranker scores DECLARED SYMBOLS — its documents are
 * name tokens plus module-path tokens — so it can never match a string
 * literal, a comment, an error code, a config key, or a file in a language
 * with no symbol extractor. Deleting the regex path would have removed the
 * only mechanism in the tree that answers that question. So this file guards
 * the path rather than its absence.
 *
 * Three defects motivate it, and each is guarded by evidence the old code
 * could not produce:
 *
 *  A. THE PATTERN COMES FROM THE MODEL AND RAN ON THE SERVER'S EVENT LOOP.
 *     A regular expression with nested quantifiers backtracks exponentially
 *     in the length of the line it matches; measured on this machine,
 *     `(a+)+$` against ONE 35-character line occupied a thread for 64.6
 *     seconds inside a single uninterruptible call, and each further two
 *     characters multiplies that by about seven, so nothing longer returns. Every request, every SSE
 *     frame and every other user's chat stopped for the duration. No
 *     deadline checked between lines can end that, because control never
 *     returns between lines. It is now run on a worker thread the pool
 *     terminates.
 *
 *     Guarded BEHAVIOURALLY, with its own liveness precondition: a cost
 *     guard that never confirms the operation happened will happily pass
 *     while measuring a refusal. So a benign search must first return the
 *     matches the fixture really contains; only then is the bomb's
 *     containment asserted, and the discriminator is that the event loop
 *     kept ticking — something the synchronous walk cannot fake.
 *
 *  B. A TRUNCATED ANSWER LOOKED EXACTLY LIKE A COMPLETE ONE. The walk
 *     stopped the instant it filled its display quota and returned that
 *     prefix with nothing to say it was a prefix, so "5 matches" and "5 of
 *     900 matches" were the same text and a model could not tell a rare
 *     symbol from a ubiquitous one.
 *
 *     The obvious guard — "the output mentions a total" — is defeated by
 *     printing any number at all, because decoration is copyable. So the
 *     total is checked against fixtures whose true counts DIFFER and are
 *     computed by the test itself. A constant, a copy of the display count,
 *     or a value derived from anything but the real scan disagrees with at
 *     least one of them.
 *
 *  C. THE FILESYSTEM'S ITERATION ORDER WAS THE RANKING FUNCTION. Which
 *     subset of matches survived truncation was an accident of `readdirSync`
 *     order, which is unspecified and differs between filesystems, so the
 *     same search could answer differently on two machines.
 *
 * Plus the structural half: exactly one module may walk the tree applying a
 * regex per line. That is a source scan, which is the floor — so it walks
 * the server tree dynamically rather than naming files, states the size of
 * the population it covered, and proves the detector still agrees on a
 * verdict by running it against a planted violation rather than trusting a
 * count of zero.
 */
import { describe, test, expect, beforeAll } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

import { createTempDir } from "../helpers/temp-dir.ts";

import { walkTs, stripCommentsOnly } from "../helpers/source-scan.ts";
import { bodyCalls, enclosingFunctionOf, functionsCalling, objectLiteralsWith } from "../helpers/function-scope.ts";
import { searchProjectContentSync, orderDirectoryEntries } from "../../server/intelligence/content-search-engine.ts";
import { executeToolCall } from "../../server/tools/tool-executor.ts";
import { getEnabledToolManifest, getToolManifest, isSaveToMemoryTool } from "../../server/tools/tools-bridge.ts";
import { getEnabledTools } from "../../server/kernel/harness-config.ts";
import { ghostToolSuggestion } from "../../server/safety/safety-bridge.ts";

const SERVER_DIR = join(import.meta.dirname, "..", "..", "server");
/** The backend's own source tree. The web manifest already imports from it
 *  (`editor/edit-tools.ts`), so the two registries are reachable from one
 *  process and the union of their tool names can be computed rather than
 *  assumed. */
const BACKEND_SRC = join(import.meta.dirname, "..", "..", "engine", "src");

/**
 * Every tool name the BACKEND runtime registry can register, discovered from
 * its source rather than listed here.
 *
 * `tools.enabled` is consumed by two registries — this server's manifest and
 * `createToolRegistry` in the backend — whose populations differ. Five of the
 * configured names (`run_quality_check`, `list_agents`, `delegate_to_agent`,
 * `get_agent_state`, `delegate_to_orchestrator`) are real backend tools this
 * server does not implement, so checking the list against either side alone
 * would either miss typos or condemn correct entries.
 *
 * The shape matched is a `ToolDefinition` literal: an object carrying
 * `type: "function"`, read as a BALANCED object rather than as "whatever is
 * within 160 bytes". Discovery, not a list, so a tool added to the backend
 * tomorrow is covered because nobody had to remember.
 */
function discoverBackendToolNames(): ReadonlySet<string> {
  // THE OBJECT LITERAL, not 160 bytes after its discriminant. A tool whose
  // description sits between `type` and `name` fell out of the discovered set
  // silently, and this set is the UNIVERSE the assertions below are made
  // about — so a window here shrinks the guard rather than weakening one
  // assertion.
  const names = new Set<string>();
  for (const file of walkTs(BACKEND_SRC)) {
    // THE RAW SOURCE, NOT A STRIPPED VIEW. `objectLiteralsContaining` parses,
    // and a comment is not a program to a parser — so stripping first buys
    // nothing and costs correctness: the stripper blanks the CONTENTS of string
    // and regular-expression literals, which turns `/[/]/` into text that no
    // longer parses at all. Measured: this exact call threw
    // `source_structure_unparsable` on `tool-registry.ts` until the strip was
    // removed. Choosing the destructive view is the failure mode this whole
    // estate keeps rediscovering.
    const source = readFileSync(file, "utf8");
    // BOTH HALVES ARE NAMES NOW. This used to select the literal with a
    // pattern and then read the tool's name out of the literal's raw TEXT with
    // a second pattern — two chances to match a property of a NESTED object
    // instead of this one. `objectLiteralsWith` returns the literal's own
    // fields on dotted paths, so the discriminant and the name are both looked
    // up. Verified against the old pair over this tree: the same 26 names,
    // exactly.
    for (const literal of objectLiteralsWith(source, "type", "function", file)) {
      const name = literal.get("function.name") ?? literal.get("name");
      if (name !== undefined && /^[a-z][a-z0-9_]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

/** Bounds used by the engine-level tests. Fixed here so the assertions are
 *  about the ENGINE's behaviour rather than about whatever the operator has
 *  configured today. */
const TEST_BOUNDS = {
  maxDepth: 5,
  maxResults: 5,
  maxScannedMatches: 1_000,
  maxFileBytes: 1_000_000,
  previewMaxChars: 200,
} as const;

/**
 * Build a project whose file content contains EXACTLY `occurrences` lines
 * matching the needle, spread over several files and directories so the
 * result depends on a real walk rather than on one file's contents.
 */
function makeFixture(root: string, needle: string, occurrences: number): void {
  const perFile = 7;
  let written = 0;
  let fileIndex = 0;
  while (written < occurrences) {
    const take = Math.min(perFile, occurrences - written);
    const dir = join(root, `pkg${fileIndex % 3}`);
    mkdirSync(dir, { recursive: true });
    const body = [
      "// a line that does not match",
      ...Array.from({ length: take }, (_, i) => `const ${needle}${i} = ${i};`),
      "// another line that does not match",
    ].join("\n");
    writeFileSync(join(dir, `file${fileIndex}.ts`), `${body}\n`);
    written += take;
    fileIndex += 1;
  }
}

describe("A. the content-search engine reports its own completeness", () => {
  let root: string;
  beforeAll(() => {
    root = createTempDir("content-search-completeness-");
  });

  /**
   * The liveness precondition for everything below: the engine must actually
   * find things. A guard about the SHAPE of a result that never checks a
   * result was produced passes just as well on an engine that returns nothing.
   */
  test("liveness — the engine finds the matches the fixture really contains", () => {
    const dir = join(root, "liveness");
    mkdirSync(dir, { recursive: true });
    makeFixture(dir, "widget", 3);
    const result = searchProjectContentSync({ projectRoot: dir, pattern: "widget", bounds: TEST_BOUNDS });
    expect(result.completeness.totalMatches).toBe(3);
    expect(result.matches.length).toBe(3);
    expect(result.completeness.filesScanned).toBeGreaterThan(0);
    expect(result.completeness.matchesTruncated).toBe(false);
  });

  /**
   * The plant. Two corpora with DIFFERENT true totals, both far beyond the
   * display cap. A reported total that is a constant, or a copy of
   * `matches.length`, or anything not derived from the scan itself, cannot
   * agree with both — which is the property a count alone would not have.
   */
  test("the reported total tracks the corpus, so it cannot be a constant or a copy of the shown count", () => {
    const cases = [
      { name: "small", occurrences: 23 },
      { name: "large", occurrences: 61 },
    ];
    const reported: number[] = [];
    for (const c of cases) {
      const dir = join(root, c.name);
      mkdirSync(dir, { recursive: true });
      makeFixture(dir, "gadget", c.occurrences);
      const result = searchProjectContentSync({ projectRoot: dir, pattern: "gadget", bounds: TEST_BOUNDS });

      expect(result.completeness.totalMatches, `${c.name}: total must be the real count`).toBe(c.occurrences);
      // The display cap really did bite, so the two numbers are genuinely
      // different and "total == shown" is not accidentally true.
      expect(result.matches.length, `${c.name}: shown is capped`).toBe(TEST_BOUNDS.maxResults);
      expect(result.completeness.shownMatches).toBe(TEST_BOUNDS.maxResults);
      expect(result.completeness.matchesTruncated).toBe(true);
      expect(result.completeness.scanStoppedEarly).toBe(false);
      reported.push(result.completeness.totalMatches);
    }
    expect(reported[0]).not.toBe(reported[1]);
  });

  test("a complete answer says so — truncation is not claimed when nothing was cut", () => {
    const dir = join(root, "complete");
    mkdirSync(dir, { recursive: true });
    makeFixture(dir, "sprocket", TEST_BOUNDS.maxResults);
    const result = searchProjectContentSync({ projectRoot: dir, pattern: "sprocket", bounds: TEST_BOUNDS });
    expect(result.completeness.totalMatches).toBe(TEST_BOUNDS.maxResults);
    expect(result.completeness.matchesTruncated).toBe(false);
  });

  test("the scan bound is distinguishable from the display bound", () => {
    const dir = join(root, "scanbound");
    mkdirSync(dir, { recursive: true });
    makeFixture(dir, "cog", 40);
    const result = searchProjectContentSync({
      projectRoot: dir,
      pattern: "cog",
      bounds: { ...TEST_BOUNDS, maxScannedMatches: 12 },
    });
    // Counting stopped at the scan bound, so the total is a floor and the
    // result must say the real number is unknown rather than report 12 as if
    // it were complete.
    expect(result.completeness.scanStoppedEarly).toBe(true);
    expect(result.completeness.totalMatches).toBe(12);
    expect(result.completeness.matchesTruncated).toBe(true);
  });

  /**
   * ORDERING, AND THE LIMIT OF WHAT CAN BE PROVEN HERE.
   *
   * The contract is that matches come back in (path, line) order rather than
   * in whatever order the filesystem hands out, because which subset survives
   * truncation was otherwise a property of the disk layout and the same search
   * could answer differently on two machines.
   *
   * This assertion states that contract, and it WOULD fail if the sort were
   * removed on a filesystem whose `readdirSync` returns entries in hash or
   * creation order — ext4 with directory indexing, XFS, HFS+. It does NOT fail
   * on the filesystem this suite currently runs on, which was measured to
   * return entries already sorted, so no fixture built here can separate the
   * two orders. Deleting the sort passes this test on this machine.
   *
   * That is a real gap and it is recorded rather than papered over. The
   * deterministic half of the guarantee is enforced structurally below
   * instead, where a planted violation gives a verdict that does not depend on
   * which filesystem the suite happens to be running on.
   */
  test("matches come back in (path, line) order", () => {
    const dir = join(root, "ordering");
    mkdirSync(dir, { recursive: true });
    makeFixture(dir, "bolt", 30);
    const once = searchProjectContentSync({ projectRoot: dir, pattern: "bolt", bounds: TEST_BOUNDS });
    const twice = searchProjectContentSync({ projectRoot: dir, pattern: "bolt", bounds: TEST_BOUNDS });
    const key = (r: typeof once): string => r.matches.map((m) => `${m.path}:${m.line}`).join("|");
    expect(key(once)).toBe(key(twice));
    const ordered = once.matches.map((m) => `${m.path}:${String(m.line).padStart(6, "0")}`);
    expect([...ordered].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(ordered);
  });

  /**
   * The filesystem-independent half, now decided by BEHAVIOUR rather than by a
   * source scan.
   *
   * The previous version of this checked that a `.sort(` appeared within four
   * hundred characters of the `readdirSync(`. That caught a deleted sort, and
   * nothing else: replacing the comparator with `.sort(() => 0)` — which is
   * stable in V8 and returns the input exactly as it arrived — satisfied the
   * pattern and passed. A guard that a one-token edit turns into decoration is
   * the shape this project keeps rediscovering, so the ordering moved into its
   * own exported function and is exercised on an input that is deliberately out
   * of order. Nothing here depends on what this machine's filesystem returns.
   */
  /**
   * The collision the ordering fixture above cannot produce, in a fixture
   * small enough that nothing is truncated before it is reached.
   *
   * A directory `b` and a file `b.ts` sort one way as NAMES and the other way
   * as PATHS, because "." (0x2E) precedes "/" (0x2F). A depth-first walk over
   * a sorted listing therefore emits `b/x.ts` BEFORE `b.ts`, while path order
   * is the reverse — so the header's claim of (path, line) order was true of
   * the old fixture and false of the engine.
   */
  test("a directory and a file whose names collide still come back in PATH order", () => {
    const dir = join(root, "path-order");
    mkdirSync(join(dir, "b"), { recursive: true });
    writeFileSync(join(dir, "a.ts"), "const rivet = 1;\n");
    writeFileSync(join(dir, "b.ts"), "const rivet = 2;\n");
    writeFileSync(join(dir, "b", "x.ts"), "const rivet = 3;\n");
    const result = searchProjectContentSync({ projectRoot: dir, pattern: "rivet", bounds: TEST_BOUNDS });
    // Liveness: all three files were reached, so the ordering assertion is
    // about an ordering and not about a truncated prefix.
    expect(result.matches).toHaveLength(3);
    expect(result.matches.map((m) => m.path)).toEqual(["a.ts", "b.ts", "b/x.ts"]);
  });

  test("the engine imposes its own order, on a listing that arrives out of order", () => {
    const scrambled = ["zeta.ts", "alpha.ts", "Mid.ts", "beta", "0-first.ts"];
    const ordered = orderDirectoryEntries(scrambled);
    expect(ordered, "the listing must come back sorted, not as given").toEqual(
      ["0-first.ts", "Mid.ts", "alpha.ts", "beta", "zeta.ts"],
    );
    // An input that is ALREADY sorted cannot separate an ordering from a no-op,
    // which is precisely why the fixture above is not one.
    expect(orderDirectoryEntries([...ordered])).toEqual(ordered);
    // And the caller must not be handed its own array back mutated.
    expect(scrambled[0]).toBe("zeta.ts");
  });

  test("the walk really routes its listing through that ordering", () => {
    // Behaviour alone cannot say WHERE the ordering is applied, so this half
    // stays structural — but it now asserts the walk calls the one owner rather
    // than that some `.sort(` exists nearby, which is what a no-op comparator
    // satisfied. Aimed at a planted violation and a planted fix as well as at
    // the real file: a count proves the scan ran, only the plants prove it
    // still decides.
    // BOUNDED BY THE FUNCTION THAT LISTS, not by 600 bytes after a
    // `readdirSync`. The window could be satisfied by an ordering call in a
    // DIFFERENT function further down the file, which is exactly the claim
    // ("this walk orders its listing") it was supposed to make.
    const routesThroughOwner = (source: string): boolean => {
      // Raw source, for the same reason: the matcher parses, so a comment is
      // already invisible to it, and the stripper corrupts literals.
      const listers = functionsCalling(source, "readdirSync");
      return listers.length > 0 && listers.every((scope) => bodyCalls(scope, "orderDirectoryEntries"));
    };

    // The plants are FUNCTIONS, because the real subject is one and the claim
    // is about a function's body. A bare statement list would make the scan
    // find nothing and report `false` for both — a detector that cannot tell
    // the fix from the defect.
    const withoutOwner = `
      function walkDirectory(dir) {
        const names = readdirSync(dir, { withFileTypes: true })
          .filter((d) => !d.name.startsWith("."))
          .map((d) => d.name)
          .sort(() => 0);
        return names;
      }
    `;
    const withOwner = `
      function walkDirectory(dir) {
        let names = readdirSync(dir, { withFileTypes: true })
          .filter((d) => !d.name.startsWith("."))
          .map((d) => d.name);
        names = orderDirectoryEntries(names);
        return names;
      }
    `;
    // …AND THE NEIGHBOUR PLANT, which is the shape the retired window could not
    // refuse: the ordering happens in a DIFFERENT function that never listed.
    const orderedNextDoor = `
      function walkDirectory(dir) {
        return readdirSync(dir, { withFileTypes: true }).map((d) => d.name);
      }
      function renderNames(names) {
        return orderDirectoryEntries(names);
      }
    `;
    expect(routesThroughOwner(withoutOwner), "an inert comparator must not count as ordering").toBe(false);
    expect(routesThroughOwner(withOwner), "the owner call must be accepted").toBe(true);
    expect(
      routesThroughOwner(orderedNextDoor),
      "ordering in a neighbouring function is not this walk ordering its listing — the retired 600-byte window accepted exactly this",
    ).toBe(false);
    // (The retired 600-byte window is re-driven against this same plant in
    // `no-proximity-window-assertions.test.ts`, which is the one file allowed
    // to contain the construct it retires.)

    const engine = readFileSync(join(SERVER_DIR, "intelligence/content-search-engine.ts"), "utf8");
    expect(routesThroughOwner(engine), "the walk does not order its listing through the owner").toBe(true);
  });

  test("a directory that cannot be listed is reported as unlistable, not as too deep", () => {
    // The two shortfalls used to share a counter, so the answer told the reader
    // to raise a depth limit when the real cause was a directory it could not
    // open. Stating a reason that is not the reason is worse than stating none.
    const dir = join(root, "unreadable");
    mkdirSync(join(dir, "locked"), { recursive: true });
    writeFileSync(join(dir, "keep.ts"), "const marker = 1;\n");
    chmodSync(join(dir, "locked"), 0o000);
    try {
      const result = searchProjectContentSync({ projectRoot: dir, pattern: "marker", bounds: TEST_BOUNDS });
      // Liveness: the scan really ran and really found the readable half.
      expect(result.matches.map((m) => m.path)).toEqual(["keep.ts"]);
      expect(result.completeness.directoriesUnreadable).toBe(1);
      expect(result.completeness.directoriesSkippedTooDeep, "an unlistable directory is not a depth shortfall").toBe(0);
    } finally {
      chmodSync(join(dir, "locked"), 0o755);
    }
  });

  test("a file that is not text is skipped and SAID to be skipped, not silently searched", () => {
    const dir = join(root, "binary");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "keep.ts"), "const marker = 1;\n");
    writeFileSync(join(dir, "blob.bin"), Buffer.from([0x6d, 0x61, 0x72, 0x6b, 0x65, 0x72, 0x00, 0x0a]));
    const result = searchProjectContentSync({ projectRoot: dir, pattern: "marker", bounds: TEST_BOUNDS });
    expect(result.completeness.filesSkippedBinary).toBe(1);
    expect(result.matches.map((m) => m.path)).toEqual(["keep.ts"]);
  });
});

describe("B. a catastrophic pattern cannot stop the server", () => {
  let root: string;
  beforeAll(() => {
    root = createTempDir("content-search-redos-");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "benign.ts"), "const canary = 1;\nconst other = 2;\n");
    // The subject the bomb backtracks over. Long enough that the match cannot
    // complete, short enough that the file is trivial to read.
    writeFileSync(join(root, "bomb.txt"), `${"a".repeat(64)}X\n`);
  });

  const ctx = { projectRoot: "", runId: "guard", userId: "guard" };

  test("liveness — a benign search through the real tool returns the fixture's matches", async () => {
    const result = await executeToolCall("search_code", { pattern: "canary" }, { ...ctx, projectRoot: root });
    expect(result.success).toBe(true);
    expect(result.output).toContain("benign.ts:1");
    // The completeness sentence is part of the contract, not a nicety: it is
    // what makes a truncated answer legible. If the tool stopped emitting it,
    // the assertion below would still pass on rows alone, so it is asserted.
    expect(result.output).toMatch(/file\(s\) searched/);
  });

  // The deadline itself — that a backtracking pattern is terminated and the
  // event loop keeps running throughout — is proven in
  // `content-search-deadline.test.ts`, which configures a short deadline so
  // the assertions are derived from the bound they test rather than charging
  // the suite the production one.

  /**
   * THE INERT SHAPE, WHICH THIS GUARD ORIGINALLY MISSED.
   *
   * Everything in section A asserts on the engine's return value. All of it
   * stayed green against a door that awaited the real scan, took the true
   * total, and then rendered `matches.length` in its place — the whole point
   * of the change discarded one line before it reached anybody, with the call
   * site intact and the computation genuinely performed.
   *
   * The engine's honesty is worth nothing if it does not survive the trip to
   * the model, so the claim is made where the model reads it: on the OUTPUT
   * TEXT of the real tool call, over two corpora whose true totals differ and
   * are computed here. A rendered total that is the shown count, a constant,
   * or anything not carried through from the scan disagrees with at least one
   * of them.
   */
  test("the total the MODEL reads is the real one, over corpora whose totals differ", async () => {
    const seen: number[] = [];
    for (const occurrences of [128, 191]) {
      const dir = join(root, `rendered-${occurrences}`);
      mkdirSync(dir, { recursive: true });
      makeFixture(dir, "flange", occurrences);
      const result = await executeToolCall("search_code", { pattern: "flange" }, { ...ctx, projectRoot: dir });
      expect(result.success).toBe(true);

      const stated = /of (\d+) matches/.exec(result.output);
      expect(stated, `the output must state a total; got:\n${result.output}`).not.toBeNull();
      const total = Number(stated![1]);
      expect(total, "the stated total must be the corpus's real match count").toBe(occurrences);

      // And it must genuinely differ from the number of rows printed, or
      // "total" could be the shown count wearing a different label.
      const shown = /^(\d+) match\(es\) shown/.exec(result.output);
      expect(shown).not.toBeNull();
      expect(Number(shown![1])).toBeLessThan(total);
      seen.push(total);
    }
    expect(seen[0]).not.toBe(seen[1]);
  });

  test("a pattern that does not compile is a typed refusal, not an empty result", async () => {
    const result = await executeToolCall("search_code", { pattern: "[" }, { ...ctx, projectRoot: root });
    expect(result.success).toBe(false);
    expect(result.output).toContain("invalid regex pattern");
    // An empty match list is what a successful search of a project with no
    // matches returns. The two must never print the same thing.
    expect(result.output).not.toContain("No matches found");
  });
});

describe("C. exactly one module walks the tree applying a regex per line", () => {
  /**
   * The detector, as a pure function over source text so it can be aimed at a
   * planted violation as well as at the real tree. A count of zero only shows
   * the scan ran; running it over a known-bad sample shows it still agrees on
   * a verdict.
   */
  /**
   * The signals name the CAPABILITY, not the local binding.
   *
   * Requiring a call site (`readFileSync(`) looked stronger and was weaker: an
   * aliased import (`import { readFileSync as slurp }`) renames every call and
   * the detector went quiet on a genuine second walker, which is how this
   * detector was first defeated. A capability cannot be renamed away, because
   * the import that grants it must still spell the original name — so the
   * signals are matched anywhere in the file, which covers the aliased form,
   * the namespaced form (`fs.readdirSync`) and the plain call alike.
   */
  function walksTreeMatchingLines(raw: string): boolean {
    // Comments are stripped before any signal is read. Two modules explain in
    // prose that they NO LONGER call `readFileSync`, and matching that
    // sentence made them read as content walkers — a detector that treats a
    // comment as evidence reports on what the code says about itself.
    const source = stripCommentsOnly(raw);
    // The four signals must converge inside ONE function body. Matched at
    // file scope they are satisfied by a coincidence of unrelated concerns —
    // measured: editor-bridge lists ONE recycle directory (readdirSync),
    // counts lines in the files it edits (.split("\n")), and tests entry
    // names against a uuid regex, in three separate functions, and the
    // file-wide conjunction reported a second content walker where none
    // exists. Inside a body, an import line cannot appear, so a name's
    // presence IS a usage — and aliases still resolve from the import line,
    // which is the one place an aliased capability cannot be renamed away
    // (see the block above).
    const walkNames = new Set(["readdirSync", "readdir"]);
    const readNames = new Set(["readFileSync", "readFileText"]);
    for (const imp of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*["'][^"']*["']/g)) {
      for (const spec of imp[1]!.split(",")) {
        const parts = spec.trim().split(/\s+as\s+/);
        const original = parts[0]!.trim();
        const local = (parts[1] ?? parts[0])!.trim();
        if (walkNames.has(original)) walkNames.add(local);
        if (readNames.has(original)) readNames.add(local);
      }
    }
    const walkCall = new RegExp(`\\b(?:${[...walkNames].join("|")})\\s*\\(`, "g");
    const readsFileText = new RegExp(`\\b(?:${[...readNames].join("|")})\\b`);
    for (const site of source.matchAll(walkCall)) {
      // Source that cannot be parsed (a signal-name removal that left a
      // dangling fragment, as in the load-bearing mutations below) yields no
      // enclosing body, so no body carrying all four signals — the same
      // verdict as a clean file, reached without guessing. The engine module
      // itself is production TypeScript and always parses.
      let enclosing;
      try {
        enclosing = enclosingFunctionOf(source, site.index);
      } catch {
        continue;
      }
      if (enclosing === undefined) continue;
      const body = enclosing.body;
      if (!readsFileText.test(body)) continue;
      if (!/\.split\(\s*["'`]\\n["'`]\s*\)/.test(body)) continue;
      if (!/\.test\s*\(|\bnew RegExp\s*\(/.test(body)) continue;
      return true;
    }
    return false;
  }

  const PLANTED = `
    import { readdirSync, readFileSync } from "node:fs";
    export function findIt(dir: string, pattern: string) {
      const re = new RegExp(pattern, "i");
      for (const name of readdirSync(dir)) {
        const lines = readFileSync(name, "utf8").split("\\n");
        for (const line of lines) if (re.test(line)) console.log(line);
      }
    }
  `;

  test("the detector still agrees on a verdict — a planted second walker is caught", () => {
    expect(walksTreeMatchingLines(PLANTED), "a real violation must be detected").toBe(true);
    // And the clean control, so the detector is not simply always true.
    expect(walksTreeMatchingLines("export const x = 1;")).toBe(false);
    // The separated-concerns control: every signal present in the FILE, each
    // in its OWN unrelated function — the shape a directory lister + line
    // counter + id-regex module has, and a content walker does not. Measured
    // live: editor-bridge.ts reads exactly this way and is not a walker.
    const SPREAD = `
      import { readdirSync, readFileSync } from "node:fs";
      const ID_RE = /^[0-9a-f-]+$/;
      export function listEntries(dir: string) {
        return readdirSync(dir).filter((n) => ID_RE.test(n));
      }
      export function readMeta(path: string) {
        return JSON.parse(readFileSync(path, "utf8")) as unknown;
      }
      export function countLines(text: string) {
        return text.split("\\n").length;
      }
    `;
    expect(
      walksTreeMatchingLines(SPREAD),
      "signals spread across unrelated functions of one file are not a content walker",
    ).toBe(false);
    // The aliased import still cannot hide the walk (the import line grants
    // the capability, so the alias is resolved from it).
    // The needle is built in fragments: spelled whole, `readdirSync(dir)` in
    // this double-quoted string would itself read as a tree enumeration to
    // the raw-source-reader guard (its detector keeps quoted interiors).
    const walkCallNeedle = "readdirSync" + "(dir)";
    const ALIASED = PLANTED.replace("readdirSync, readFileSync", "readdirSync as rd, readFileSync").replaceAll(walkCallNeedle, "rd(dir)");
    expect(walksTreeMatchingLines(ALIASED), "an aliased readdir import must still be caught").toBe(true);
  });

  test("every one of the detector's four signals is load-bearing", () => {
    // A conjunction is only as awake as its weakest term. Removing any single
    // signal from the planted sample must flip the verdict; if one does not,
    // that term is dead and the detector would stay green with a real
    // violation present.
    //
    // A term that is itself a disjunction ("reads a file" is satisfied by
    // either read helper; "applies a regex" by either construction or test)
    // must have BOTH arms removed to be genuinely absent. Removing one arm and
    // seeing the verdict hold proves nothing about the term — which is how
    // this very test first passed while the regex signal was doing no work.
    const removals: readonly (readonly [string, readonly string[]])[] = [
      ["directory walk", ["readdirSync", "readdir"]],
      ["file read", ["readFileSync", "readFileText"]],
      ["line split", [`.split("\\n")`]],
      ["regex application", ["re.test(", "new RegExp("]],
    ];
    for (const [label, needles] of removals) {
      let weakened = PLANTED;
      for (const needle of needles) weakened = weakened.split(needle).join("NOTHING");
      expect(walksTreeMatchingLines(weakened), `${label} is not load-bearing in the detector`).toBe(false);
    }
  });

  test("the real server tree has exactly one content walker, and it is the engine", () => {
    const files = walkTs(SERVER_DIR);
    // The population this verdict covers, as a runtime number with a floor.
    // Without it a walk that found nothing would read as a clean result.
    expect(files.length, "the server walk found a real population").toBeGreaterThan(40);

    const walkers = files.filter((f) => walksTreeMatchingLines(readFileSync(f, "utf8")));
    const names = walkers.map((f) => f.split("/").slice(-1)[0]).sort();
    expect(names, `content walkers found: ${names.join(", ")}`).toEqual(["content-search-engine.ts"]);
  });
});

describe("D. the ranked path is offered to the model, not merely implemented", () => {
  /**
   * The failure this catches is the one the whole sequence exists to remove: a
   * capability that is built, wired, tested and then unreachable. `tools.enabled`
   * is an allowlist, and a tool absent from it is silently invisible to the
   * model no matter how correct it is. The symbol ranker was in exactly that
   * state — three consumers, none of them the LLM.
   */
  const rankedSearchTools = ["search_symbols", "quick_view", "slice", "viewport", "skeleton"] as const;

  test("liveness — the manifest and the enabled surface are both populated", () => {
    expect(getToolManifest().length).toBeGreaterThan(20);
    expect(getEnabledToolManifest().length).toBeGreaterThan(10);
  });

  test("every ranked code-navigation tool the server implements is reachable by the model", () => {
    const enabled = new Set(getEnabledToolManifest().map((t) => t.name));
    const registered = new Set(getToolManifest().map((t) => t.name));
    for (const name of rankedSearchTools) {
      expect(registered.has(name), `${name} is not registered at all`).toBe(true);
      expect(enabled.has(name), `${name} is registered but the model is never offered it`).toBe(true);
    }
  });

  /**
   * THE GUARD THAT WOULD HAVE CAUGHT THE ORIGINAL DEFECT, and the one above
   * would not have.
   *
   * Naming five tools checks five tools. Nine were unreachable, and after five
   * were enabled four still were — `fetch_memory`, `score_quality`,
   * `create_artifact` and `control_interface`, the last two carrying whole
   * rendered surfaces (`ArtifactView.svelte`, the `ui_control` SSE event and
   * its store) that the model had never been able to trigger. A guard that
   * chooses its own subject has already chosen how much of the problem to
   * find, and that choice is invisible in a green run.
   *
   * So the subject is the POPULATION: every built-in tool the server
   * registers. The rule is not "the list is long enough" but "registering a
   * tool and not offering it is not a state this server has" — if a tool
   * should not be callable, do not register it. Deliberately no allowlist of
   * exceptions, because an exception list is how this class gets silenced.
   */
  test("every built-in tool the server registers is one the model can actually call", () => {
    const registered = getToolManifest().filter((t) => t.category === "built-in");
    const enabled = new Set(getEnabledToolManifest().map((t) => t.name));
    // The covered population, as a runtime number with a floor. A manifest
    // that came back empty would satisfy the loop below by iterating nothing.
    expect(registered.length, "built-in tools registered").toBeGreaterThanOrEqual(30);
    const unreachable = registered.map((t) => t.name).filter((n) => !enabled.has(n));
    expect(unreachable, "registered, handled, tested — and never offered to the model").toEqual([]);
    expect(enabled.size).toBe(registered.length);
  });

  /**
   * The other half of the same allowlist: a name in it that resolves to
   * nothing. `tools.enabled` is filtered with a `Set.has`, so a typo does not
   * fail — it just never matches, and the tool it was meant to enable stays
   * off. The list spans TWO registries with different populations (this
   * server's manifest, and the backend runtime's `createToolRegistry`), which
   * is why the union is computed rather than either side alone.
   *
   * The backend half is discovered from its source rather than listed, so a
   * tool added there tomorrow is covered without anyone editing this file.
   */
  test("every name in tools.enabled resolves to a real tool in one of the two registries", () => {
    const webNames = new Set(getToolManifest().map((t) => t.name));
    const backendNames = discoverBackendToolNames();
    // Both sides need their own liveness: a discovery that silently found
    // nothing would make the union check pass by making it vacuous, and a
    // union check is a conjunction of exactly these two inputs.
    expect(webNames.size, "web manifest names").toBeGreaterThanOrEqual(30);
    expect(backendNames.size, "backend registry names discovered from source").toBeGreaterThanOrEqual(15);
    const union = new Set([...webNames, ...backendNames]);

    const configured = getEnabledTools();
    expect(configured.length, "names configured in tools.enabled").toBeGreaterThanOrEqual(30);
    const resolvesToNothing = configured.filter((n) => !union.has(n));
    expect(resolvesToNothing, "configured tool names that match no tool anywhere").toEqual([]);

    // A plant, because a count only proves the detector is awake. A name that
    // has never existed must be reported, and one that exists must not.
    expect([...configured, "a_tool_that_has_never_existed"].filter((n) => !union.has(n)))
      .toEqual(["a_tool_that_has_never_existed"]);
  });

  /**
   * `SAVE_TO_MEMORY_TOOLS` is a third allowlist over the same population, and
   * it had the same defect from the other direction: `get_awareness_summary`
   * was the only occurrence of that string in either repository. An opt-in set
   * consulted with `Set.has` can never say that one of its names is fiction.
   */
  test("every tool the memory opt-in names is a tool that exists and can be called", () => {
    const callable = getEnabledToolManifest().map((t) => t.name);
    expect(callable.length, "callable tools").toBeGreaterThanOrEqual(30);
    const optedIn = callable.filter((n) => isSaveToMemoryTool(n));
    expect(optedIn.length, "tools opted into memory").toBeGreaterThan(5);
    // The set's own source is the only place its membership is written down,
    // so the names are read from there rather than restated here.
    const bridge = stripCommentsOnly(readFileSync(join(SERVER_DIR, "tools/tools-bridge.ts"), "utf8"));
    const block = /SAVE_TO_MEMORY_TOOLS\s*=\s*new Set<string>\(\[([\s\S]*?)\]\)/.exec(bridge);
    expect(block, "the opt-in set could not be read from its owner").not.toBeNull();
    const declared = [...block![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(declared.length, "names declared in the opt-in set").toBeGreaterThan(5);
    const registered = new Set(getToolManifest().map((t) => t.name));
    expect(declared.filter((n) => !registered.has(n)), "opted-in names that name no tool").toEqual([]);
    expect([...declared, "a_tool_that_has_never_existed"].filter((n) => !registered.has(n)))
      .toEqual(["a_tool_that_has_never_existed"]);
  });

  test("the regex tool and the ranked tool are both offered, because they answer different questions", () => {
    const enabled = new Set(getEnabledToolManifest().map((t) => t.name));
    expect(enabled.has("search_code"), "content search is the only way to match a comment or a literal").toBe(true);
    expect(enabled.has("search_symbols"), "symbol search is the only ranked path").toBe(true);
  });
});

describe("D2. symbol search admits the files it could not read", () => {
  /**
   * THE MEASUREMENT THAT DECIDED THIS STEP, AND THE WIDENING IT PREDICTED.
   *
   * This test's own header once read "the map returns symbols for TypeScript
   * and NOTHING for the other seven, because the parser backend is not
   * initialised on this path", and carried the tripwire: "if the parser
   * coverage ever widens the test says so rather than quietly continuing to
   * describe a limit that no longer exists." The tree-sitter farm init
   * widened it — every registered grammar now extracts, so the fixture's
   * eight declaration files all yield symbols. The tripwire did its job.
   *
   * The invariant survives the widening and is what is asserted now: a bare
   * empty answer from symbol search must not read as "the symbol is absent"
   * when some indexed files yielded no declarations. The report travels with
   * the answer. The widened-coverage case is driven as the positive control:
   * declaration-bearing files in eight languages are all indexed and none are
   * reported unread, while a registered-language module with NO extractable
   * declaration IS — so the report names file types, not a fixed sentence.
   */
  let root: string;
  const ctx = { runId: "coverage-guard", userId: "coverage-guard" };
  const SOURCES: readonly (readonly [string, string])[] = [
    ["a.ts", "export function parseUserRecord(id: string) { return id; }\n"],
    ["b.py", "def parse_user_record(user_id):\n    return user_id\n"],
    ["c.go", "package main\nfunc ParseUserRecord(id string) string { return id }\n"],
    ["d.rs", "pub fn parse_user_record(id: &str) -> &str { id }\n"],
    ["e.java", "public class P { public String parseUserRecord(String id) { return id; } }\n"],
    ["f.rb", "def parse_user_record(id)\n  id\nend\n"],
    ["g.php", "function parse_user_record($id) { return $id; }\n"],
    ["h.cs", "public class P { public string ParseUserRecord(string id) { return id; } }\n"],
  ];
  /**
   * Registered-language modules with NO extractable declaration — a comment
   * and a bare value that declares nothing. Each is indexed (its extension is
   * registered) but yields zero symbols, which is precisely what the coverage
   * report counts as unread. The extensions are chosen OUTSIDE the eight
   * declaration languages so they never collide with a read one.
   */
  const EMPTY: readonly (readonly [string, string])[] = [
    ["x.swift", "// nothing here declares a symbol\nlet marker = 1\n"],
    ["y.kt", "// nothing here declares a symbol\nval marker = 1\n"],
  ];

  beforeAll(() => {
    root = createTempDir("content-search-languages-");
    for (const [name, body] of SOURCES) writeFileSync(join(root, name), body);
    for (const [name, body] of EMPTY) writeFileSync(join(root, name), body);
  });

  test("content search finds the declaration in EVERY language, which is why this path exists", async () => {
    const result = await executeToolCall(
      "search_code",
      { pattern: "parse_user_record|ParseUserRecord|parseUserRecord" },
      { ...ctx, projectRoot: root },
    );
    expect(result.success).toBe(true);
    for (const [name] of SOURCES) {
      expect(result.output, `${name} must be reachable by content search`).toContain(`${name}:`);
    }
  });

  test("symbol search states which files it could not read, so an empty answer is not read as 'absent'", async () => {
    // The index builds off-thread; retry until it is ready rather than
    // asserting against a "still indexing" envelope.
    let parsed: Record<string, unknown> | null = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const result = await executeToolCall("search_symbols", { query: "parse user record" }, { ...ctx, projectRoot: root });
      if (result.success && result.output.trimStart().startsWith("{")) {
        const candidate = JSON.parse(result.output) as Record<string, unknown>;
        if (Array.isArray(candidate.results)) {
          parsed = candidate;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(parsed, "the symbol index never became ready").not.toBeNull();

    // Positive control for the widening: the eight declaration files are all
    // read now, so none of their languages may appear in the unread report.
    const tscoverage = parsed!.coverage as
      | { unreadFiles?: number; unreadFileTypes?: readonly { extension: string }[] }
      | undefined;
    const tsNamed = new Set((tscoverage?.unreadFileTypes ?? []).map((e) => e.extension));
    for (const ext of [".py", ".go", ".rs", ".ts"]) {
      expect(tsNamed.has(ext), `${ext} yields symbols now — reporting it unread would be false`).toBe(false);
    }

    // The unread half: the two declaration-free registered-language modules
    // yield zero symbols and must be reported, never mistaken for "absent".
    const coverage = parsed!.coverage as
      | { unreadFiles?: number; unreadFileTypes?: readonly { extension: string }[]; note?: string }
      | undefined;
    expect(coverage, "an unread module must be reported, not passed over in silence").toBeDefined();
    expect(coverage!.unreadFiles, "the declaration-free modules are unread").toBeGreaterThan(0);

    // The report names the actual extensions, so it cannot be a fixed
    // sentence: a different project reports a different set.
    const named = new Set((coverage!.unreadFileTypes ?? []).map((e) => e.extension));
    for (const ext of [".swift", ".kt"]) {
      expect(named.has(ext), `${ext} yielded no symbols but was not reported`).toBe(true);
    }
    // And it must NOT claim the language it really did read.
    expect(named.has(".ts"), "TypeScript was read, so reporting it unread would be false").toBe(false);
  });
});

describe("E. the anti-hallucination hints do not themselves hallucinate", () => {
  /**
   * The ghost-tool map exists so a model that calls `grep` is redirected to a
   * real tool. Its hints had drifted into instructions that could not be
   * followed — five named tools that do not exist (`replace_range`,
   * `delete_range`, `insert_text`), and three named parameters that no schema
   * has ever declared (`search_code`'s `path` and `file_pattern`,
   * `read_file`'s `offset`/`limit`), on a tool whose schema sets
   * `additionalProperties: false` and rejects them. The layer that stops the
   * model inventing things was handing it inventions.
   *
   * The parameter half is now read from each tool's own schema, so it cannot
   * drift. This checks the derivation actually holds, over every entry
   * discovered from the map rather than a chosen few.
   */
  /**
   * Discovered from the map's OWN source, not copied from it.
   *
   * The copy was the hole: `ghostToolSuggestion` answers `null` for a target
   * that is not live, so an entry pointing at a tool that does not exist — or
   * at one that is registered but disabled — simply produced no suggestion,
   * and a name absent from the copied list was never asked. A nineteenth entry
   * naming `replace_range` (a tool that has never existed) passed all three
   * assertions below with the list hardcoded. It does not now.
   */
  const GHOST_NAMES: readonly string[] = (() => {
    const bridge = stripCommentsOnly(readFileSync(join(SERVER_DIR, "safety/safety-bridge.ts"), "utf8"));
    const block = /GHOST_TOOL_SUGGESTIONS[\s\S]*?Object\.freeze\(\{([\s\S]*?)\n\}\)/.exec(bridge);
    if (block === null) return [];
    return [...block[1]!.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((m) => m[1]!);
  })();

  test("liveness — the redirect table was actually read, and every entry resolves", () => {
    // Without this the discovery could silently return an empty list and every
    // assertion below would pass by iterating nothing — the exact failure the
    // hardcoded list produced, reached a different way.
    expect(GHOST_NAMES.length, "entries discovered from the redirect table").toBeGreaterThanOrEqual(18);
    expect(GHOST_NAMES).toContain("grep");
  });

  test("liveness — the suggestions actually resolve", () => {
    const resolved = GHOST_NAMES.map((n) => ghostToolSuggestion(n)).filter((s) => s !== null);
    expect(resolved.length, "no ghost suggestion resolved at all").toBeGreaterThanOrEqual(GHOST_NAMES.length);
  });

  test("every suggestion names a tool the model can actually call right now", () => {
    const enabled = new Map(getEnabledToolManifest().map((t) => [t.name, t]));
    let checked = 0;
    for (const ghost of GHOST_NAMES) {
      const suggestion = ghostToolSuggestion(ghost);
      expect(suggestion, `${ghost} lost its suggestion`).not.toBeNull();
      expect(enabled.has(suggestion!.realTool), `${ghost} points at '${suggestion!.realTool}', which the model cannot call`).toBe(true);
      checked += 1;
    }
    expect(checked, "population covered").toBe(GHOST_NAMES.length);
  });

  test("every parameter a hint names is declared by that tool's own schema", () => {
    const enabled = new Map(getEnabledToolManifest().map((t) => [t.name, t]));
    let parametersChecked = 0;
    for (const ghost of GHOST_NAMES) {
      const suggestion = ghostToolSuggestion(ghost);
      if (suggestion === null) continue;
      const entry = enabled.get(suggestion.realTool)!;
      const schema = entry.inputSchema as { properties?: Record<string, unknown> };
      const declared = new Set(Object.keys(schema.properties ?? {}));
      const quoted = [...suggestion.hint.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
      // The first quoted token is the tool name; the rest are parameters.
      for (const name of quoted.slice(1)) {
        expect(declared.has(name), `'${ghost}' hint names parameter '${name}', which '${suggestion.realTool}' does not declare`).toBe(true);
        parametersChecked += 1;
      }
    }
    // Without a floor, a hint format that stopped naming parameters at all
    // would make this test pass by checking nothing.
    expect(parametersChecked, "parameters covered").toBeGreaterThan(10);
  });

  test("a tool the model cannot call yields no suggestion at all, rather than a second wrong answer", () => {
    // A real tool name is not a ghost, so it must not be redirected.
    expect(ghostToolSuggestion("search_code")).toBeNull();
    expect(ghostToolSuggestion("read_file")).toBeNull();
    expect(ghostToolSuggestion("a-name-nothing-uses")).toBeNull();
  });
});
