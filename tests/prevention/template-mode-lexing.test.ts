// @vitest-environment node
/**
 * THE TEMPLATE MODE MACHINE — what a string is in a Svelte file.
 *
 * The guarded class: `lexSpans(src, html)` used to be a FLAT character
 * scanner, so over a `.svelte` file one prose apostrophe in HTML text could
 * pair with the next quote ANYWHERE in the file, and the phantom "string"
 * between them swallowed real code and comments. Both directions were
 * measured live (the round-76 false positive, and the false absence this
 * suite's killer arm reproduces): the phantom could misclassify swallowed
 * comment text as a string (a guard reds on an offender that does not exist)
 * or hide a real one (code swallowed into a "string" is blanked out of
 * `code()`; a phantom closing inside a real literal leaves its interior in
 * the code half where no string-span guard can see it). The fix is the mode
 * machine in `engine/scripts/verification/source-view.ts` — Svelte's own
 * parser semantics: markup text treats quotes as LITERAL characters;
 * delimiters exist only inside `{expressions}`, quoted attribute values,
 * `<script>` and `<style>` content.
 *
 * The never-weaken proof was run once, as a differential between the flat
 * and mode lexers over every tracked `.svelte` file (98 files): 5,170 real
 * string/template spans identical, attribute values with embedded
 * expressions still caught at the same opening quote, 29 old-only spans all
 * of the phantom class, and 7 REAL literals the old parity was hiding
 * today (Gauge.svelte, ChordGrip.svelte — the false-absence class, live).
 * This suite pins the machine's modes so the class cannot return: each
 * boundary below is a fixture where the flat behavior and the mode behavior
 * disagree, planted in the direction that hid offenders.
 */
import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative } from "node:path";

import { lexSpans, sourceViewOf, renderSpans, LEXICAL_REUSE_LIMITS, type LexSpan } from "../../engine/scripts/verification/source-view.ts";
import { walk, relpath, nonEmptySourceFilesUnder, blankStringLiterals, codeStructureOnly } from "../helpers/source-scan.ts";

/** The workspace-split guard's own scan shape, factored once: which
 * string/template span interiors carry the hand-spelled prefix? */
function handSpelledPrefixSites(src: string, html: boolean, prefix: string): string[] {
  const sites: string[] = [];
  for (const span of lexSpans(src, html)) {
    if (span.kind !== "string" && span.kind !== "template") continue;
    const text = src.slice(span.start, span.end);
    if (text.includes(prefix)) sites.push(text);
  }
  return sites;
}

/** The span covering `index`, if any. */
function spanAt(spans: readonly LexSpan[], index: number): LexSpan | undefined {
  return spans.find((s) => s.start <= index && s.end > index);
}

describe("lexical work belongs to its immutable input", () => {
  it("reuses adjacent primitive scans without sharing mutable span arrays or stale input modes", () => {
    // This process has already imported its test graph. Observe a fresh native
    // first request to prove the narrow dependency boundary actually holds.
    const initialization = execFileSync(process.execPath, ["--input-type=module", "--eval", `
      import assert from 'node:assert/strict';
      import { Session } from 'node:inspector';
      import { promisify } from 'node:util';
      const session = new Session(); session.connect();
      const post = promisify(session.post).bind(session);
      const loaded = new Set();
      session.on('Debugger.scriptParsed', ({params}) => loaded.add(params.url));
      try {
        await post('Debugger.enable');
        const viewUrl = ${JSON.stringify(new URL("../../engine/scripts/verification/source-view.ts", import.meta.url).href)};
        const policyUrl = ${JSON.stringify(new URL("../../engine/src/kernel/root-policy.ts", import.meta.url).href)};
        const view = await import(viewUrl);
        assert.equal(view.sourceViewOf('const marker = "visible";', 'witness.ts').code(), 'const marker = "       ";');
        assert(loaded.has(viewUrl), 'the actual lexical owner was loaded');
        assert.equal(loaded.has(policyUrl), false, 'lexical first use must not initialize the full policy graph');
        assert.deepEqual(view.LEXICAL_REUSE_LIMITS, {maximumInputs:4096, maximumSourceCharacters:33554432, maximumSpans:1000000});
        assert(Object.isFrozen(view.LEXICAL_REUSE_LIMITS), 'lexical policy is immutable before full policy initialization');
        const {ROOT_POLICY} = await import(policyUrl);
        assert(loaded.has(policyUrl), 'the full policy witness is observable when requested');
        assert.equal(ROOT_POLICY.verification.lexicalReuse === view.LEXICAL_REUSE_LIMITS, true, 'full and narrow policy use the same canonical object');
        console.log('canonical lexical policy identity and first-use boundary verified');
      } finally { session.disconnect(); }
    `], { encoding: "utf8", timeout: 30_000 });
    expect(initialization).toContain("canonical lexical policy identity and first-use boundary verified");
    const source = `const lexical${"identifier".repeat(64)} = 1; /* witness ${Math.random()} */`;
    const slice = vi.spyOn(String.prototype, "slice");
    let first: LexSpan[];
    let second: LexSpan[];
    let firstWork: number;
    let repeatedWork: number;
    try {
      first = lexSpans(source, false);
      firstWork = slice.mock.contexts.filter(context => String(context) === source).length;
      second = lexSpans(source, false);
      repeatedWork = slice.mock.contexts.filter(context => String(context) === source).length;
    } finally { slice.mockRestore(); }
    expect(firstWork!, "the first scan must actually examine completed identifiers").toBeGreaterThan(0);
    expect(repeatedWork!, "an unchanged primitive input needs no second lexical traversal").toBe(firstWork!);
    expect(first!).toEqual([{ kind: "block-comment", start: source.indexOf("/*"), end: source.length }]);
    expect(second!).toEqual(first!);
    expect(second!).not.toBe(first!);
    expect(second![0]).not.toBe(first![0]);
    Reflect.set(first![0]!, "start", 0);
    first!.push({ kind: "string", start: 0, end: 1 });
    expect(lexSpans(source, false)).toEqual(second!);
    expect(lexSpans(source, true), "markup prose uses a different lexical mode").toEqual([]);
    const changed = source.replace("/*", "//");
    expect(changed.length).toBe(source.length);
    expect(lexSpans(changed, false)).toEqual([{ kind: "line-comment", start: changed.indexOf("//"), end: changed.length }]);
    expect(lexSpans(source, false), "returning to previous bytes must not retain the changed answer").toEqual(second!);
    const interleavedWork = vi.spyOn(String.prototype, "slice");
    let interleaved = 0;
    try {
      lexSpans(changed, false);
      expect(lexSpans(source, false)).toEqual(second!);
      interleaved = interleavedWork.mock.contexts.filter(context => String(context) === source).length;
    } finally { interleavedWork.mockRestore(); }
    expect(interleaved, "immutable inputs remain reusable across intervening scans").toBe(0);
    // One shared entry budget covers both modes, including entries whose
    // answer has no spans. It is not a separate allowance per mode.
    for (let index = 0; index < LEXICAL_REUSE_LIMITS.maximumInputs; index++) {
      lexSpans(source + String.fromCharCode(10) + index, index % 2 === 0);
    }
    const revisitWork = vi.spyOn(String.prototype, "slice");
    let revisits = 0;
    try {
      expect(lexSpans(source, false)).toEqual(second!);
      revisits = revisitWork.mock.contexts.filter(context => String(context) === source).length;
    } finally { revisitWork.mockRestore(); }
    expect(revisits, "a source beyond the finite capacity was evicted instead of retained indefinitely").toBeGreaterThan(0);
  });

  it("all source views share one scan while different view objects retain separate inputs", () => {
    const source = `const value = "visible"; const text = \`template\`; // witness`;
    let reads = 0;
    const observed = new Proxy(Object(source) as String, {
      get(target, key) {
        if (typeof key === "string" && /^\d+$/.test(key)) reads++;
        const value: unknown = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const view = sourceViewOf(observed as unknown as string, "probe.ts");
    // Prose also needs the independent line index; account for that necessary
    // traversal before observing whether lexical work repeats across views.
    expect(view.lineAt(source.length)).toBe(1);
    reads = 0;
    const code = view.code();
    const firstReads = reads;
    const withStrings = view.codeWithStrings();
    const withTemplates = view.codeWithStringsAndTemplates();
    const prose = view.prose();
    expect(firstReads, "the observer must see the actual input traversal").toBeGreaterThan(source.length);
    expect(reads, "the three views and prose share one lexical traversal").toBe(firstReads);
    expect(code).not.toContain("visible");
    expect(withStrings).toContain('"visible"');
    expect(withStrings).not.toContain("template");
    expect(withTemplates).toContain("`template`");
    expect(prose).toEqual([{ line: 1, text: "// witness", kind: "line-comment" }]);
    const changed = source.replace("visible", "changed");
    expect(sourceViewOf(changed, "probe.ts").codeWithStrings()).toContain('"changed"');
    expect(view.codeWithStrings()).toBe(withStrings);

    const primitiveSpans = lexSpans(source, false);
    const map = vi.spyOn(Array.prototype, "map");
    let defensiveCopies = 0;
    try {
      const primitive = sourceViewOf(source, "primitive.ts");
      primitive.code(); primitive.codeWithStrings(); primitive.codeWithStringsAndTemplates(); primitive.prose();
      renderSpans(source, false, (_kind, span) => span);
      defensiveCopies = map.mock.contexts.filter(context => Array.isArray(context)
        && context.length === primitiveSpans.length
        && context.every((span, index) => span?.start === primitiveSpans[index]?.start
          && span?.end === primitiveSpans[index]?.end && span?.kind === primitiveSpans[index]?.kind)).length;
    } finally { map.mockRestore(); }
    expect(defensiveCopies, "private readonly readers do not construct public mutable span copies").toBe(0);

    // Prime the lexical facts, then observe only actual masking work. The
    // result must retain every UTF-16 offset (including CR and surrogates),
    // while replacement work follows newline boundaries, not characters.
    const body = `${"😀\rX".repeat(1024)}\n${"tail".repeat(256)}\n`;
    const comment = `/*${body}*/`;
    const literal = "`" + body + "`";
    lexSpans(comment, false); lexSpans(literal, false);
    const masked = comment.replace(/[^\n]/g, " ");
    const maskedBody = body.replace(/[^\n]/g, " ");
    const replacements = vi.spyOn(RegExp.prototype, "exec");
    let outputs: string[];
    let replacementWork = 0;
    try {
      const maskedView = sourceViewOf(comment, "masking.ts");
      outputs = [maskedView.code(), maskedView.codeWithStrings(),
        maskedView.codeWithStringsAndTemplates(), codeStructureOnly(comment),
        blankStringLiterals(literal, "masking.ts")];
      replacementWork = replacements.mock.calls.filter(([input]) => input === comment || input === body).length;
    } finally { replacements.mockRestore(); }
    expect(outputs!).toEqual([masked, masked, masked, masked, "`" + maskedBody + "`"]);
    expect(replacementWork, "masking work follows newline boundaries instead of every character").toBeLessThanOrEqual(15);

  });

  it("oversized lexical inputs are scanned without retaining their characters or spans", () => {
    const oversized = [
      `const marker = 1;${" ".repeat(LEXICAL_REUSE_LIMITS.maximumSourceCharacters)}`,
      `${"/*x*/".repeat(LEXICAL_REUSE_LIMITS.maximumSpans + 1)}const marker = 1;`,
    ];
    for (const source of oversized) {
      lexSpans(source, false);
      const slice = vi.spyOn(String.prototype, "slice");
      let work = 0;
      try {
        lexSpans(source, false);
        work = slice.mock.contexts.filter(context => String(context) === source).length;
      } finally { slice.mockRestore(); }
      expect(work, "an individually oversized input is never kept by the shared cache").toBeGreaterThan(0);
    }
    const cumulative = [
      ["characters", `const marker = 1;${" ".repeat(Math.floor(LEXICAL_REUSE_LIMITS.maximumSourceCharacters / 2))}`],
      ["spans", `${"/*x*/".repeat(Math.floor(LEXICAL_REUSE_LIMITS.maximumSpans / 2) + 1)}const marker = 1;`],
    ] as const;
    for (const [dimension, source] of cumulative) {
      // Each input fits alone, but their combined weight exceeds exactly one
      // dimension. Repeating after eviction also checks weight subtraction.
      for (let cycle = 0; cycle < 2; cycle++) {
        lexSpans(source, false);
        lexSpans(source + " ", false);
        const slice = vi.spyOn(String.prototype, "slice");
        let work = 0;
        try {
          lexSpans(source, false);
          work = slice.mock.contexts.filter(context => String(context) === source).length;
        } finally { slice.mockRestore(); }
        expect(work, `cumulative ${dimension} require eviction even when each input fits`).toBeGreaterThan(0);
        const reused = vi.spyOn(String.prototype, "slice");
        let repeated = 0;
        try {
          lexSpans(source, false);
          repeated = reused.mock.contexts.filter(context => String(context) === source).length;
        } finally { reused.mockRestore(); }
        expect(repeated, `evicted ${dimension} are subtracted so the surviving input can be retained`).toBe(0);
      }
    }
  });
});

describe("markup prose is literal (the flat parity class is dead)", () => {
  const PROSE = `<p>the run's opening record is not in view</p>
<p>the tab's label says "workspace" plainly</p>`;

  it("prose apostrophes and quotes open no span and survive the code view verbatim", () => {
    const spans = lexSpans(PROSE, true);
    expect(spans, "markup prose must not be string material").toEqual([]);
    // The code view keeps every prose byte — nothing was blanked as a string
    // interior (the direction that hid real code from code-view guards).
    expect(sourceViewOf(PROSE, "probe.svelte").code()).toBe(PROSE);
  });

  it("THE KILLER: a hand-spelled ws: in a script block is caught while prose apostrophes sit in the same file", () => {
    // The round-76 TC's exact scenario: prose apostrophes in the markup, a
    // REAL hand-spelled prefix in the code. The flat lexer paired the prose
    // apostrophes across the script and either blanked or fragmented the
    // offender; the mode machine must catch it.
    const src = `${PROSE}
<script>
  const key = \`ws:\${id}:notes\`;
  register("the record's owner");
</script>
<p>the user's workspace</p>`;
    expect(handSpelledPrefixSites(src, true, "ws:")).toEqual(["`ws:${id}:notes`"]);
    // The code-view direction of the same killer: the swallowed-call class.
    // The flat lexer blanked `$effect(...)` out of code() when a prose
    // apostrophe paired across it; the machine must leave the CALL visible
    // (the string's own interior is still blanked — that is what code()
    // means).
    const codeView = `<p>the run's record</p>
<script>
  $effect(() => { register("ws-owner"); });
</script>
<p>the tab's label</p>`;
    expect(sourceViewOf(codeView, "probe.svelte").code()).toContain(
      '$effect(() => { register("',
    );
  });

  it("a phantom cannot close inside a real literal and hide its interior", () => {
    // The false-absence shape the flat lexer produced: the prose apostrophe
    // opened a string that closed at the apostrophe INSIDE the template, so
    // the `ws:` text landed in the code half where no string-span guard
    // reads it. The machine lexes the template as one span.
    const src = `<p>the user's workspace</p>
<script>
  const key = \`it's a ws:\${id} thing\`;
</script>`;
    expect(handSpelledPrefixSites(src, true, "ws:")).toEqual(["`it's a ws:${id} thing`"]);
  });

  it("prose apostrophes with NO offender read clean — the runs-section comment's rows: is not string material", () => {
    // The round-76 false positive: a markup comment holding "FACT rows:"
    // (its "rows:" contains "ws:") was swallowed by a phantom string and the
    // workspace-split source-shape arm red with an offender that did not
    // exist. The comment must be html-comment material, and the scan clean.
    const src = `${PROSE}
<!-- ── no row has a deeper surface, so these stay FACT rows: no hover. ── -->
<p>more prose's fine</p>`;
    expect(handSpelledPrefixSites(src, true, "ws:")).toEqual([]);
    const comment = src.indexOf("<!--");
    const covering = spanAt(lexSpans(src, true), comment);
    expect(covering?.kind).toBe("html-comment");
  });
});

describe("mode boundaries", () => {
  it("quotes inside {expression} strings delimit (an apostrophe in a double-quoted JS string is literal)", () => {
    const src = `<p>{note("it's fine")}</p>`;
    const spans = lexSpans(src, true);
    expect(spans.map((s) => src.slice(s.start, s.end))).toEqual([`"it's fine"`]);
    const sites = handSpelledPrefixSites(`<p>{label(\`ws:\${id}\`)}</p>`, true, "ws:");
    expect(sites).toEqual(["`ws:${id}`"]);
  });

  it("quoted attribute values delimit — value text, and expressions inside them", () => {
    const src = `<button title="breaker for {row.label} — press comma">go</button>`;
    const spans = lexSpans(src, true).filter((s) => s.kind === "string");
    expect(spans.map((s) => src.slice(s.start, s.end))).toEqual([
      `"breaker for `,
      ` — press comma"`,
    ]);
    // A hand-spelled prefix in the value TEXT and one in an expression
    // string are both caught — the two real spellings a compiled file can
    // carry. (A bare `{ws:x}` is not valid Svelte and not what the old flat
    // scanner reliably saw either; the honest arms pin the valid shapes.)
    const textValue = `<span data-key="ws:run">x</span>`;
    expect(handSpelledPrefixSites(textValue, true, "ws:")).toEqual([`"ws:run"`]);
    const exprValue = `<span title={"ws:" + id}>x</span>`;
    expect(handSpelledPrefixSites(exprValue, true, "ws:")).toEqual([`"ws:"`]);
  });

  it("JS comments inside expressions are comment spans", () => {
    const src = `<p>{/* the row's owner */ label(x)}</p>`;
    const spans = lexSpans(src, true);
    expect(spans.map((s) => src.slice(s.start, s.end))).toEqual([
      `/* the row's owner */`,
    ]);
  });

  it("script content is full JavaScript — strings, templates, regexes, comments, and a < that is an operator", () => {
    const src = `<div>a</div>
<script lang="ts">
  // the run's owner
  const re = /^\\s*["']x/;
  const s = "3 < 4 and it's true";
  const t = \`a \${s}'s tail\`;
  const fewer = count < limit;
</script>
<p>prose's end</p>`;
    const spans = lexSpans(src, true);
    expect(spans.map((s) => src.slice(s.start, s.end))).toEqual([
      `"ts"`, // the script tag's own attribute value, caught in TAG mode
      `// the run's owner`,
      `/^\\s*["']x/`,
      `"3 < 4 and it's true"`,
      `\`a \${s}'s tail\``,
    ]);
    // The `<` comparison stayed code (no tag opened at it): the template's
    // span sits after it with the offsets the file's own lines carry.
    const view = sourceViewOf(src, "probe.svelte").code();
    expect(view).toContain("count < limit;");
  });

  it("style content keeps CSS strings and comments — the flat-era treatment", () => {
    const src = `<style>
  /* the row's ink */
  .a::after { content: "it's"; }
</style>`;
    const spans = lexSpans(src, true);
    expect(spans.map((s) => src.slice(s.start, s.end))).toEqual([
      `/* the row's ink */`,
      `"it's"`,
    ]);
  });

  it("a svelte block's braces close at their own depth and its strings still delimit", () => {
    const src = `{#if count({ deep: '{' }) > 0}{"it's"}{/if}`;
    const spans = lexSpans(src, true);
    expect(spans.map((s) => src.slice(s.start, s.end))).toEqual([
      `'{'`,
      `"it's"`,
    ]);
  });

  it("a block CLOSE tag is a keyword, not a regex — the markup after it stays markup", () => {
    // `{/if}` handed to the expression walk put its `/` where a regex may
    // start: `/if}</` lexed as a regex literal and the walk swallowed the
    // markup after it, so a later markup comment stopped being one.
    for (const src of [
      "<p>{#if a}x{/if}</p>\n<!-- c -->",
      "<code>{#each xs as x}{x}{/each}</code>\n<!-- c -->",
      "<b>{#if a}x{ /if }</b>\n<!-- c -->",
      "<span>{#if a}x{:else}y{/if}</span>\n<!-- c -->",
    ]) {
      const spans = lexSpans(src, true);
      expect(spans.filter((span) => span.kind === "regex"), src).toEqual([]);
      expect(spanAt(spans, src.indexOf("<!--"))?.kind, src).toBe("html-comment");
    }
  });

  it("the ts path is unchanged — a quote in code position is a delimiter, comments first", () => {
    // html=false is uniform JavaScript: the flat walk IS the language there.
    // This arm pins that the machine did not touch the ts path.
    const src = `// the run's owner\nconst s = 'a string';\nconst t = \`ws:\${id}\`;\n`;
    const spans = lexSpans(src, false);
    expect(spans.map((s) => src.slice(s.start, s.end))).toEqual([
      `// the run's owner`,
      `'a string'`,
      `\`ws:\${id}\``,
    ]);
  });

  it("a bare `<` in prose opens no tag — comparison prose stays prose", () => {
    const src = `<p>count < limit's plain prose</p>`;
    expect(lexSpans(src, true)).toEqual([]);
    expect(sourceViewOf(src, "probe.svelte").code()).toBe(src);
  });
});

describe("identifier work follows input length across lexical modes", () => {
  it.each(["code", "template", "markup", "attribute", "script", "style"] as const)(
    "%s: exact spans survive long identifiers without rescanning their prefixes",
    (mode) => {
      for (const { length, boundary } of [128, 1_280].flatMap((length) =>
        ["_", "$", "9"].map((boundary) => ({ length, boundary })),
      )) {
        const identifier = "token_$9".repeat(Math.ceil(length / 8)).slice(0, length) + boundary + "return";
        // The whole identifier immediately governs division: no intervening
        // operator may erase its keyword-suffix context. A genuine keyword
        // separated from its regex by a comment still opens a regex.
        const body = `const result = ${identifier} / denominator / count; return /* witness */ /[}]/;`;
        let source = body;
        let expected: Readonly<{ kind: LexSpan["kind"]; text: string }>[] = [
          { kind: "block-comment", text: "/* witness */" },
          { kind: "regex", text: "/[}]/" },
        ];
        if (mode === "template") {
          // A phantom regex at division would swallow the interpolation's
          // closing brace and template tail before reaching the next slash.
          const literal = "`head${" + identifier + " / denominator}tail`";
          source = `const view = ${literal}; function witness() { return /* witness */ /[}]/; }`;
          expected = [{ kind: "template", text: literal }, ...expected];
        } else if (mode === "markup") {
          source = `<p>{(() => {${body}})()}</p>`;
        } else if (mode === "attribute") {
          source = `<p title={(() => {${body}})()}>tail</p>`;
        } else if (mode === "script") {
          source = `<script>${body}</script>`;
        } else if (mode === "style") {
          source = `<style>.${identifier} { content: "tail"; /* witness */ }</style>`;
          expected = [
            { kind: "string", text: '"tail"' },
            { kind: "block-comment", text: "/* witness */" },
          ];
        }
        const html = mode !== "code" && mode !== "template";
        const expectedSpans = expected.map(({ kind, text }) => {
          const start = source.indexOf(text);
          expect(start, "the intended span has a fixture witness").toBeGreaterThanOrEqual(0);
          return { kind, start, end: start + text.length };
        });
        // The real primitive input is the behavioral oracle. Instrumentation
        // below observes the same characters and delegates native string
        // methods unchanged; it adds no lexer hook or alternate implementation.
        expect(lexSpans(source, html), `${boundary}/${length}: primitive input produces exact witnessed spans`).toEqual(expectedSpans);
        let characterWork = 0;
        const observed = new Proxy(Object(source) as String, {
          get(target, property) {
            if (typeof property === "string" && /^\d+$/.test(property)) characterWork += 1;
            const value: unknown = Reflect.get(target, property);
            if (typeof value !== "function") return value;
            return (...args: unknown[]): unknown => {
              const result: unknown = Reflect.apply(value, target, args);
              if (property === "charAt" || property === "charCodeAt" || property === "codePointAt") {
                characterWork += 1;
              } else if (property === "slice" || property === "substring" || property === "substr") {
                characterWork += typeof result === "string" ? result.length : 0;
              }
              return result;
            };
          },
        });
        expect(lexSpans(observed as unknown as string, html), "observed input produces exact witnessed spans").toEqual(expectedSpans);
        expect(characterWork, "the work observer saw the real traversal").toBeGreaterThan(source.length);
        // One forward walk plus lookahead, one completed-word scan and its
        // slice are linear. Eight visits/copies per input unit also covers
        // the surrounding mode delimiters; growing prefix scans exceed it.
        expect(characterWork, "lexical character work must remain linear in the input").toBeLessThanOrEqual(source.length * 8);
      }
    },
  );
});

describe("the real population (deny-by-default, discovered)", () => {
  const svelteFiles = walk("src", { exts: [".svelte"] });

  it("spans are in order, non-overlapping, and inside the file — over every tracked svelte source", () => {
    // Found live while this machine was built: a literal scanner inside a
    // `<style>` region could outrun the region's closing tag, and the markup
    // walk then resumed INSIDE the emitted span — overlapping spans broke
    // renderSpans' arithmetic and blankStringLiterals' offset preservation
    // (a view LONGER than its file). The machine's own contract is total:
    // order, disjointness, and containment hold over whatever it reads.
    const broken: string[] = [];
    for (const file of svelteFiles) {
      const src = readFileSync(file, "utf8");
      let prevEnd = 0;
      for (const span of lexSpans(src, true)) {
        if (span.start < prevEnd) broken.push(`${relpath(file)}: overlap at ${span.start} (prev end ${prevEnd})`);
        if (span.end < span.start) broken.push(`${relpath(file)}: negative length at ${span.start}`);
        if (span.end > src.length) broken.push(`${relpath(file)}: span past end of file at ${span.start}`);
        prevEnd = Math.max(prevEnd, span.end);
      }
    }
    // The same contract over a degenerate read — a .ts file handed to the
    // template mode — because "in order and non-overlapping" is the lexer's
    // own promise, not a favor granted to well-formed input. The doc-comment
    // `<style>` mention inside a .ts is exactly the shape that produced the
    // live overlap before the region clamp existed.
    for (const file of walk("tests/prevention", { exts: [".ts"] }).slice(0, 40)) {
      const src = readFileSync(file, "utf8");
      let prevEnd = 0;
      for (const span of lexSpans(src, true)) {
        if (span.start < prevEnd || span.end < span.start || span.end > src.length) {
          broken.push(`${relpath(file)}: degenerate read breaks the span contract at ${span.start}`);
          break;
        }
        prevEnd = Math.max(prevEnd, span.end);
      }
    }
    expect(broken, broken.join("\n")).toEqual([]);
  });

  it("every tracked svelte file lexes without a span straddling a script or style fence", () => {
    // The parity class, measured live: phantom spans crossed the `<style>`
    // and `</script>` fences in more than ten real files. A span that
    // straddles a fence is neither script material nor markup material — it
    // is the mispairing this machine exists to end. The fences are found by
    // an INDEPENDENT instrument (plain byte search for the literal tags,
    // the same rule Svelte's own parser uses to bound script and style
    // content), never by the span machinery under test.
    const straddles: string[] = [];
    for (const file of svelteFiles) {
      const src = readFileSync(file, "utf8");
      const fences: Array<[number, number]> = [];
      for (const name of ["script", "style"]) {
        let at = src.indexOf(`<${name}`);
        while (at !== -1) {
          const close = src.indexOf(`</${name}`, at);
          fences.push([at, close === -1 ? src.length : close + 2 + name.length]);
          at = close === -1 ? -1 : src.indexOf(`<${name}`, close + 1);
        }
      }
      for (const span of lexSpans(src, true)) {
        for (const [open, end] of fences) {
          if (span.start < open && span.end > open) {
            straddles.push(`${relpath(file)}: ${src.slice(span.start, Math.min(span.end, span.start + 60))}`);
          }
          if (span.start < end && span.end > end) {
            straddles.push(`${relpath(file)}: ${src.slice(span.start, Math.min(span.end, span.start + 60))}`);
          }
        }
      }
    }
    expect(straddles, `spans that are neither markup nor script material:\n${straddles.join("\n")}`).toEqual([]);
  });

  it("every markup comment outside script and style regions is an html-comment span", () => {
    // An independent regex finds every `<!-- … -->` in markup; the machine
    // must classify each one. Under the flat lexer this failed on this tree
    // the moment a prose apostrophe re-paired the file (the round-76 site).
    const misses: string[] = [];
    for (const file of svelteFiles) {
      const src = readFileSync(file, "utf8");
      const fenced: Array<[number, number]> = [];
      for (const name of ["script", "style"]) {
        let at = src.indexOf(`<${name}`);
        while (at !== -1) {
          const close = src.indexOf(`</${name}`, at);
          fenced.push([at, close === -1 ? src.length : close]);
          at = close === -1 ? -1 : src.indexOf(`<${name}`, close + 1);
        }
      }
      const inFence = (at: number): boolean =>
        fenced.some(([open, end]) => at >= open && at < end);
      const spans = lexSpans(src, true);
      for (const m of src.matchAll(/<!--[\s\S]*?-->/gu)) {
        const at = m.index!;
        if (inFence(at)) continue; // script/style content is JS/CSS, not markup
        const covering = spanAt(spans, at);
        if (covering?.kind !== "html-comment") {
          misses.push(`${relpath(file)}:${sourceViewOf(src, file).lineAt(at)}: ${m[0].slice(0, 60)}`);
        }
      }
    }
    expect(misses, `markup comments the machine did not classify:\n${misses.join("\n")}`).toEqual([]);
  });

  it("the round-76 site: RunPane's FACT comment is html-comment material and no string in the file spells ws:", () => {
    // The measured false positive lived here: one apostrophe in the runs-row
    // prose re-paired the file, a phantom string swallowed the FACT comment,
    // and its "rows:" read as a hand-spelled prefix. The arm pins both
    // halves at the evidence site: the comment is what the machine says it
    // is, and the file's string material is clean.
    const found = svelteFiles.filter((f) => relative(".", f).endsWith("flow/RunPane.svelte"));
    expect(found, "the round-76 evidence site moved — carry the arm to it").toHaveLength(1);
    const src = readFileSync(found[0]!, "utf8");
    const spans = lexSpans(src, true);
    // The file spells "FACT rows" twice — once in its script JSDoc (block
    // comment, line ~23) and once in the MARKUP comment that the phantom
    // swallowed. Locate the markup one by its opener, not by first index.
    const markupFact = [...src.matchAll(/<!--[\s\S]*?-->/gu)].find((m) =>
      m[0].includes("stay FACT rows"),
    );
    expect(markupFact, "the round-76 markup comment moved — carry the arm to it").toBeDefined();
    expect(spanAt(spans, markupFact!.index)?.kind).toBe("html-comment");
    expect(handSpelledPrefixSites(src, true, "ws:")).toEqual([]);
  });

  it("the block-close site: EditorRoom's markup after `{/if}</span>` is still markup", () => {
    // The live evidence of the block-close regex misread: the first markup
    // comment after this line was not an html-comment span.
    const found = svelteFiles.filter((f) => relative(".", f).endsWith("rooms/EditorRoom.svelte"));
    expect(found, "the block-close evidence site moved — carry the arm to it").toHaveLength(1);
    const src = readFileSync(found[0]!, "utf8");
    const close = src.indexOf("{/if}</span>");
    expect(close, "the block-close evidence site moved — carry the arm to it").toBeGreaterThan(-1);
    const spans = lexSpans(src, true);
    expect(spanAt(spans, close)?.kind, "the close tag is no span at all").toBeUndefined();
    expect(spanAt(spans, src.indexOf("<!--", close))?.kind).toBe("html-comment");
  });

  it("the literals the flat parity hid are caught — the Gauge site", () => {
    // Gauge.svelte carried templates the old flat lexer did not classify as
    // templates at all (their backticks were swallowed by earlier
    // mispairings) — the false-absence class, live, before this machine.
    const found = svelteFiles.filter((f) => relative(".", f).endsWith("desk/Gauge.svelte"));
    expect(found, "the Gauge evidence site moved — carry the arm to it").toHaveLength(1);
    const src = readFileSync(found[0]!, "utf8");
    const templates = lexSpans(src, true)
      .filter((s) => s.kind === "template")
      .map((s) => src.slice(s.start, s.end));
    expect(templates.some((t) => t.includes("${liveTps} tok/s")), JSON.stringify(templates)).toBe(true);
  });

  it("the population is not empty and the walk is dynamic", () => {
    // A vacuous population would green every arm above; the walk refuses
    // that on its own, and this arm says the size out loud.
    expect(svelteFiles.length).toBeGreaterThan(50);
    // The population agrees with the git index (the second instrument).
    const tracked = new Set(
      execFileSync("git", ["ls-files", "*.svelte"], { encoding: "utf8" })
        .split("\n")
        .filter(Boolean),
    );
    for (const f of svelteFiles) expect(tracked.has(relative(".", f).split("\\").join("/"))).toBe(true);
    expect(nonEmptySourceFilesUnder("src", "the svelte population", [".svelte"]).length).toBeGreaterThan(0);
  });
});
