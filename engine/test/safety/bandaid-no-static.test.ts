import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveBandaidConfig } from "../../src/safety/bandaid-config.ts";
import { createBandaidDetector, type EditEvent } from "../../src/safety/bandaid-detector.ts";
import { detectStructuralBandaids } from "../../src/safety/bandaid-ast-detector.ts";
import { learnBandaidPatterns } from "../../src/safety/bandaid-pattern-learner.ts";
import { registerBandaidExposure, updateBandaidExposure } from "../../src/safety/bandaid-exposure.ts";
import { buildCorpus, learnedConfig, edit, runDetect } from "./learned-bandaid-corpus.ts";

/**
 * EXP432 — bandaid detection WITHOUT static keywords.
 *
 * The user (2026-07-21): "the workaround/bandaids part is using static
 * keywords, are we in 1990?... static values like that are prohibited
 * app-wide." EXP408 hardcoded 8 regex patterns (`@ts-ignore`, `as any`,
 * `eslint-disable`, `TODO...fix|later|hack|workaround|temporary`,
 * `catch{}`, `catch{//comment}`, `if (x === null)`). EXP432 replaces
 * that static keyword list with:
 *
 * L1 STRUCTURAL (AST, keyword-free): empty/comment-only catch, `as any`/
 * `<any>x`, null guard, unused catch binding — detected by AST node
 * TYPE, not string matching.
 * L2 LEARNED (codebase-mined, keyword-free): suppression pragmas +
 * deferred markers are MINED from the codebase by the pattern learner.
 * No static keyword list lives in the source.
 * L3 ROOT-CAUSE CONTAINMENT (keyword-free, PRIMARY): edit vs known
 * root-cause-fix token containment.
 *
 * Required by the binding protocol: 50 bandaid (100% detection), 50
 * legitimate (0% false flag), 20 new bandaid types (improvisation), 10×
 * harder if 100% (500), improper-usage tests, audit all modules.
 */

// ============================================================
// 1. FIFTY BANDAID CASES — 100% detection required
// ============================================================

test("EXP432: 50 bandaid cases — 100% detection (no static keywords)", () => {
  const c = learnedConfig();
  const edits: EditEvent[] = [];
  let turn = 1;
  // 8 × structural AST cases (keyword-free) — 1 each
  for (const [, added, fp] of [
    ["as any", ["const z = risky() as any;"], "a.ts"],
    ["empty catch", ["try { op(); } catch (e) {}"], "a.ts"],
    ["comment-only catch block", ["try { op(); } catch (e) { /* ignore */ }"], "a.ts"],
    ["multiline comment-only catch", ["try {", "  op();", "} catch (e) {", "  // swallowed", "}"], "a.ts"],
    ["null guard ===", ["function f() { if (val === null) return; }"], "a.ts"],
    ["null guard !==", ["function f() { if (r !== null) { r.go(); } }"], "a.ts"],
    ["as any property", ["(obj as any).deep.prop = 1;"], "a.ts"],
    ["as unknown as any", ["const x = y as unknown as any;"], "a.ts"],
  ] as const) {
    edits.push(edit(turn++, fp, [...added]));
  }
  // 6 × learned suppression pragma cases — 1 each
  for (const [, added, fp] of [
    ["@ts-ignore", ["// @ts-ignore", "const x: number = maybe();"], "a.ts"],
    ["@ts-expect-error", ["// @ts-expect-error: lib type is wrong", "const y = lib();"], "a.ts"],
    ["@ts-ignore TSX", ["// @ts-ignore", "<Component prop={weird} />"], "a.tsx"],
    ["eslint-disable-next-line", ["// eslint-disable-next-line no-explicit-any", "const w: any = x;"], "a.ts"],
    ["eslint-disable block", ["/* eslint-disable */", "let anything: any = 0;"], "a.ts"],
    ["@ts-ignore inline trailing", ["const z = lib(); // @ts-ignore"], "a.ts"],
  ] as const) {
    edits.push(edit(turn++, fp, [...added]));
  }
  // 4 × learned deferred marker cases — 1 each
  for (const [, added, fp] of [
    ["TODO fix later", ["// TODO: fix this later", "const v = hack();"], "a.ts"],
    ["TODO temporary hack", ["// TODO: temporary hack to unblock", "const t = bypass();"], "a.ts"],
    ["FIXME refactor", ["// FIXME: refactor this", "const u = legacy();"], "a.ts"],
    ["TODO hack workaround", ["// TODO: workaround for now", "const s = shim();"], "a.ts"],
  ] as const) {
    edits.push(edit(turn++, fp, [...added]));
  }
  // 2 × unused catch binding (structural, keyword-free)
  edits.push(edit(turn++, "a.ts", ["try { op(); } catch (e) { console.log('done'); }"]));
  edits.push(edit(turn++, "a.ts", ["try {", "  op();", "} catch (err) {", "  other();", "}"]));
  // 6 × root-cause-not-addressed (keyword-free, PRIMARY signal)
  for (let i = 0; i < 6; i += 1) {
    edits.push(
      edit(turn++, `b${i}.ts`, ["return null;"], {
        rootCauseHint: "parseConfig returns null when config is missing",
        knownRootCauseFix: "guard config-missing at the parseConfig call site and return a typed ConfigError",
      }),
    );
  }
  // 8 × variants of structural cases (different syntax shapes)
  for (const added of [
    ["const a = b as any as any;"],
    ["try { x(); } catch { /* optional binding, comment only */ }"],
    ["function g() { if (maybe == null) return; }"],
    ["function h() { if (foo != null) foo(); }"],
    ["const r = (x as any).y as any;"],
    ["try {", "  risky();", "} catch (e) {", "  // intentionally ignored for now", "}"],
    ["const v = <any>unknownVar;"],
    ["function k() { if (val === null || val === undefined) return; }"],
  ] as const) {
    edits.push(edit(turn++, "a.ts", [...added]));
  }
  // 8 × more learned pragma / marker variants
  for (const added of [
    ["// @ts-ignore: types are wrong here", "const p = q();"],
    ["// @ts-expect-error: broken upstream", "const r = s();"],
    ["/* eslint-disable-next-line */", "const t: any = u;"],
    ["// TODO: fix this properly later", "const w = x();"],
    ["// FIXME: this is a hack", "const y = z();"],
    ["// @ts-ignore", "const aa = bb();"],
    ["// TODO: revisit", "const cc = dd();"],
    ["/* eslint-disable */", "const ee: any = ff;"],
  ] as const) {
    edits.push(edit(turn++, "a.ts", [...added]));
  }
  // 8 × mixed (structural + learned on different lines)
  for (const added of [
    ["// @ts-ignore", "const x = y as any;", "try { op(); } catch (e) {}"],
    ["// TODO: fix later", "if (val === null) return;", "const z = w as any;"],
    ["/* eslint-disable */", "const a: any = b;", "try { c(); } catch (e) { /* ignore */ }"],
    ["// @ts-expect-error", "const d = e as any;"],
    ["// FIXME: refactor", "try { f(); } catch (err) { g(); }"],
    ["if (r !== null) { r.go(); }", "// TODO: cleanup", "const h = i as any;"],
    ["try { j(); } catch { /* no binding */ }", "// @ts-ignore", "const k = l;"],
    ["const m = n as any;", "/* eslint-disable-next-line */", "const o: any = p;"],
  ] as const) {
    edits.push(edit(turn++, "a.ts", [...added]));
  }
  assert.equal(edits.length, 50, `expected 50 bandaid edits, got ${edits.length}`);
  const r = runDetect(c, edits);
  const missed: number[] = [];
  for (const e of edits) {
    if (!r.flaggedTurns.has(e.turn)) missed.push(e.turn);
  }
  assert.equal(missed.length, 0, `missed bandaid turns: ${missed.join(",")} (out of 50)`);
  assert.ok(r.detectedCount >= 50, `expected >= 50 findings, got ${r.detectedCount}`);
});

// ============================================================
// 2. FIFTY LEGITIMATE FIXES — 0% false flag required
// ============================================================

test("EXP432: 50 legitimate fixes — 0% false flag (no static keywords)", () => {
  const c = learnedConfig();
  const edits: EditEvent[] = [];
  let turn = 1;
  // 25 × clean real fixes (no bandaid shapes)
  for (const added of [
    ["function add(a: number, b: number) { return a + b; }"],
    ["const result = compute(input);", "if (result.isOk()) return result.value;", "throw result.error;"],
    ["function parseConfig(p) { if (!exists(p)) return new ConfigError(); return load(p); }"],
    ["export const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);"],
    ["function findById(items, id) { return items.find((x) => x.id === id); }"],
    ["const double = (x: number) => x * 2;"],
    ["function validate(input: string) { return input.length > 0 ? ok(input) : err('empty'); }"],
    ["const pairs = xs.map((x) => [x, x * 2]);"],
    ["function retry<T>(fn: () => T, n: number) { for (let i = 0; i < n; i++) { try { return fn(); } catch (e) { if (i === n - 1) throw e; } } throw new Error('unreachable'); }"],
    ["export class Calculator { add(a, b) { return a + b; } }"],
    ["const sorted = xs.slice().sort((a, b) => a - b);"],
    ["function fib(n: number) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }"],
    ["const isEven = (n: number) => n % 2 === 0;"],
    ["function gcd(a: number, b: number) { while (b !== 0) { [a, b] = [b, a % b]; } return a; }"],
    ["const head = <T,>(xs: readonly T[]) => xs[0];"],
    ["function memoize<T>(fn: (x: string) => T) { const cache = new Map<string, T>(); return (x: string) => cache.get(x) ?? cache.set(x, fn(x)).get(x)!; }"],
    ["export function compose<A, B, C>(f: (x: A) => B, g: (x: B) => C) { return (x: A) => g(f(x)); }"],
    ["const ids = items.filter((x) => x.active).map((x) => x.id);"],
    ["function clamp(n: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, n)); }"],
    ["const result = await fetch(url).then((r) => r.json());"],
    ["function shallowEqual(a: object, b: object) { const ka = Object.keys(a); return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]); }"],
    ["export const once = <T>(fn: () => T) => { let done = false; let value: T; return () => (done ? value : ((done = true), (value = fn()))); };"],
    ["function range(n: number) { return Array.from({ length: n }, (_, i) => i); }"],
    ["const partition = <T,>(xs: T[], pred: (x: T) => boolean) => { const yes: T[] = []; const no: T[] = []; for (const x of xs) (pred(x) ? yes : no).push(x); return [yes, no]; };"],
    ["function debounce<A>(fn: (a: A) => void, ms: number) { let t: ReturnType<typeof setTimeout>; return (a: A) => { clearTimeout(t); t = setTimeout(() => fn(a), ms); }; }"],
  ] as const) {
    edits.push(edit(turn++, "clean.ts", [...added]));
  }
  // 10 × root-cause-addressed edits (the edit addresses the known root cause)
  for (let i = 0; i < 10; i += 1) {
    edits.push(
      edit(turn++, `fix${i}.ts`, [
        "function parseConfig(p) {",
        "  if (!exists(p)) return new ConfigError();",
        "  return load(p);",
        "}",
      ], {
        rootCauseHint: "parseConfig returns null when config is missing",
        knownRootCauseFix: "guard config-missing at parseConfig and return a typed ConfigError",
      }),
    );
  }
  // 15 × legitimately-handled errors (non-empty catch that USES the error)
  for (const added of [
    ["try { op(); } catch (e) { logger.error('failed', e); throw e; }"],
    ["try { risky(); } catch (err) { report(err); }"],
    ["try { x(); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }"],
    ["try { parse(s); } catch (e) { return new ParseError(e.message); }"],
    ["try { load(); } catch (e) { handle(e); }"],
    ["try { connect(); } catch (e) { retryConnection(e); }"],
    ["try { write(); } catch (e) { rollback(); throw e; }"],
    ["try { fetch(); } catch (e) { return fallback(e); }"],
    ["try { transform(); } catch (e) { log(e); throw new WrappedError(e); }"],
    ["try { validate(); } catch (e) { errors.push(e); }"],
    ["try { run(); } catch (e) { if (e instanceof TypeError) return 0; throw e; }"],
    ["try { compute(); } catch (e) { return { ok: false, error: e }; }"],
    ["try { save(); } catch (e) { notify(e); throw e; }"],
    ["try { read(); } catch (e) { return defaultValue(e); }"],
    ["try { process(); } catch (e) { metrics.record(e); throw e; }"],
  ] as const) {
    edits.push(edit(turn++, "clean.ts", [...added]));
  }
  assert.equal(edits.length, 50, `expected 50 legitimate edits, got ${edits.length}`);
  const r = runDetect(c, edits);
  const falseFlagged: number[] = [];
  for (const e of edits) {
    if (r.flaggedTurns.has(e.turn)) falseFlagged.push(e.turn);
  }
  assert.equal(falseFlagged.length, 0, `false-flagged legitimate turns: ${falseFlagged.join(",")} (out of 50); findings: ${r.findings.map((f) => `${f.turn}:${f.patternLabel}`).join(",")}`);
});

// ============================================================
// 3. TWENTY NEW BANDAID TYPES (improvisation) — not in the original 7
// ============================================================

test("EXP432: 20 NEW bandaid types — dynamic detection catches them", () => {
  const c = learnedConfig();
  const edits: EditEvent[] = [];
  let turn = 1;
  // NEW structural shapes (keyword-free, AST-detected) — not in EXP408's 7.
  for (const added of [
    ["const a = b as any as any as any;"],
    ["try { f(); } catch { /* nothing */ }"],
    ["function g() { if (x == undefined) return; }"],
    ["function h() { if (y != null) y(); }"],
    ["const c = (d as any).e as any;"],
    ["const f = <any>g;"],
    ["function k() { if (z === undefined) { return null; } }"],
    ["try { op(); } catch (e) { /* TODO fix later */ }"],
    ["const m = n as unknown as any;"],
    ["function p() { if (q === null) { q = defaultValue; } }"],
  ] as const) {
    edits.push(edit(turn++, "a.ts", [...added]));
  }
  // NEW root-cause-not-addressed variants (keyword-free, PRIMARY signal)
  for (let i = 0; i < 6; i += 1) {
    edits.push(
      edit(turn++, `n${i}.ts`, ["return -1;"], {
        rootCauseHint: "function returns -1 on error instead of throwing",
        knownRootCauseFix: "throw a typed error when the precondition fails",
      }),
    );
  }
  // NEW learned-marker variants (FIXME already in corpus)
  for (const added of [
    ["// FIXME: broken", "const a = b();"],
    ["// TODO: revisit later", "const c = d();"],
    ["// FIXME: hack", "const e = f();"],
    ["// TODO: cleanup", "const g = h();"],
  ] as const) {
    edits.push(edit(turn++, "a.ts", [...added]));
  }
  assert.equal(edits.length, 20);
  const r = runDetect(c, edits);
  const missed: number[] = [];
  for (const e of edits) {
    if (!r.flaggedTurns.has(e.turn)) missed.push(e.turn);
  }
  assert.equal(missed.length, 0, `missed NEW bandaid turns: ${missed.join(",")} (out of 20)`);
});

// ============================================================
// 4. IMPROPER USAGE — unknown root cause, no corpus, empty edits
// ============================================================

test("EXP432 improper-usage: unknown root cause → structural + learned still run", () => {
  const c = learnedConfig();
  const d = createBandaidDetector({ config: c });
  // No knownRootCauseFix → root-cause comparison does NOT fire (correctly).
  // Structural + learned detection still catch the bandaid.
  d.recordEdit(edit(1, "a.ts", ["const x = y as any;"]));
  const r = d.detect();
  assert.ok(r.detectedCount >= 1, "structural any-assertion should be caught without a root-cause hint");
  assert.ok(!r.findings.some((f) => f.category === "root-cause-not-addressed"), "root-cause finding should NOT fire without knownRootCauseFix");
});

test("EXP432 improper-usage: empty learned set → only structural + root-cause run (honest degradation)", () => {
  const c = resolveBandaidConfig(); // empty learned pragmas/markers
  const d = createBandaidDetector({ config: c });
  d.recordEdit(edit(1, "a.ts", ["// @ts-ignore", "const x = y;"]));
  const r = d.detect();
  // No learned pragmas → @ts-ignore NOT flagged (honest: we don't know this
  // codebase's pragmas yet). Structural shapes + root-cause still run.
  const tsIgnoreFlagged = r.findings.some((f) => f.patternLabel === "suppression-comment");
  assert.equal(tsIgnoreFlagged, false, "without learning, suppression comments are NOT flagged (honest)");
  // But structural still works:
  const d2 = createBandaidDetector({ config: c });
  d2.recordEdit(edit(1, "a.ts", ["const x = y as any;"]));
  assert.ok(d2.detect().detectedCount >= 1, "structural any-assertion works without learning");
});

test("EXP432 improper-usage: malformed / empty edits — no crash, no false flag", () => {
  const c = learnedConfig();
  const d = createBandaidDetector({ config: c });
  d.recordEdit(edit(1, "a.ts", []));
  d.recordEdit(edit(2, "a.ts", [""]));
  d.recordEdit(edit(3, "a.ts", ["   "]));
  d.recordEdit(edit(4, "a.ts", ["@@@ malformed"]));
  d.recordEdit(edit(5, "a.ts", ["{"]));
  const r = d.detect();
  assert.equal(r.detectedCount, 0, `malformed/empty edits should not be flagged, got ${r.detectedCount}`);
});

test("EXP432 improper-usage: disabled family produces no findings", () => {
  const c = learnedConfig({ families: { bandaid: { enabled: false, minEvents: 1 } } });
  const d = createBandaidDetector({ config: c });
  d.recordEdit(edit(1, "a.ts", ["const x = y as any;"]));
  assert.equal(d.detect().detectedCount, 0);
});

test("EXP432 improper-usage: a NEW bandaid type the detector cannot catch is logged, not crashed", () => {
  // A bandaid shape none of the 3 layers catches: a semantic workaround
  // that uses NO structural shape, NO learned marker, NO root-cause hint.
  // The detector returns 0 findings (honest) — the LLM-tiebreaker (future
  // work) would handle this. No crash.
  const c = learnedConfig();
  const d = createBandaidDetector({ config: c });
  d.recordEdit(edit(1, "a.ts", ["// this approach avoids the broken module by using a different one entirely", "const x = otherModule();"]));
  const r = d.detect();
  // 0 findings — honest. Documented as a known limitation (semantic
  // bandaids need the LLM tiebreaker, future work).
  assert.equal(r.detectedCount, 0);
});

// ============================================================
// 5. NO STATIC KEYWORDS — audit the source for hardcoded patterns
// ============================================================

test("EXP432 audit: bandaid-config.ts has NO static BANDAID_DEFAULT_PATTERNS", () => {
  // The static keyword list was REMOVED in EXP432. The default config must
  // have an EMPTY bandaidPatterns list (no hardcoded patterns).
  const c = resolveBandaidConfig();
  assert.equal(c.bandaidPatterns.length, 0, "default bandaidPatterns must be EMPTY (no static keywords)");
  assert.equal(c.learnedSuppressionPragmas.length, 0, "default learnedSuppressionPragmas must be EMPTY (populated by learner)");
  assert.equal(c.learnedDeferredMarkers.length, 0, "default learnedDeferredMarkers must be EMPTY (populated by learner)");
  assert.equal(c.workaroundConsequentialTools.length, 0, "default consequentialTools must be EMPTY (dynamic)");
  assert.equal(c.workaroundManualApproachPatterns.length, 0, "default manualApproachPatterns must be EMPTY");
  assert.equal(c.workaroundConsequentialToolsMode, "all", "default mode is 'all' (every tool consequential — no list)");
});

test("EXP432 audit: deviation-detector.ts has NO static STOPWORDS list", () => {
  // The static STOPWORDS list was REMOVED in EXP432. IDF handles stopword
  // downweighting dynamically per-corpus.
  const src = readFileSync("src/safety/deviation-detector.ts", "utf8") as string;
  assert.ok(!/const STOPWORDS\s*=\s*new Set\(/.test(src), "STOPWORDS static list must be REMOVED");
  assert.ok(src.includes("IDF"), "deviation detector should mention IDF (the dynamic replacement)");
});

test("EXP432 audit: bandaid-detector.ts has no hardcoded regex patterns", () => {
  const src = readFileSync("src/safety/bandaid-detector.ts", "utf8") as string;
  // No hardcoded detection patterns (the static keyword list is gone).
  for (const forbidden of ["@ts-ignore", "@ts-expect-error", "eslint-disable", "TODO", "catch\\s*", "as\\\\s+any"]) {
    assert.ok(!src.includes(forbidden), `bandaid-detector.ts must not hardcode "${forbidden}"`);
  }
});

// ============================================================
// 6. LEARNER — the dynamic replacement for the static keyword list
// ============================================================

test("EXP432 learner: mines suppression pragmas from the corpus (no hardcoded list)", () => {
  const learned = learnBandaidPatterns(buildCorpus(), { minSupport: 2, maxPragmaLength: 80, maxDeferredLength: 200, includeLongCommentHeuristic: true });
  // Must learn @ts-ignore, @ts-expect-error, eslint-disable (each in >= 2 files).
  const joined = learned.suppressionPragmas.join("|");
  assert.ok(joined.includes("@ts-ignore"), `should learn @ts-ignore, got: ${joined}`);
  assert.ok(joined.includes("@ts-expect-error"), `should learn @ts-expect-error, got: ${joined}`);
  assert.ok(joined.includes("eslint-disable"), `should learn eslint-disable, got: ${joined}`);
  // Must learn TODO, FIXME (each in >= 2 files, UPPERCASE convention).
  const dJoined = learned.deferredMarkers.join("|");
  assert.ok(dJoined.includes("TODO"), `should learn TODO, got: ${dJoined}`);
  assert.ok(dJoined.includes("FIXME"), `should learn FIXME, got: ${dJoined}`);
});

test("EXP432 learner: minSupport filters rare pragmas (dynamic)", () => {
  // A pragma that appears in only 1 file should NOT be learned (minSupport=2).
  const corpus = [
    { path: "a.ts", content: "// @ts-ignore\nconst x = y;" },
    { path: "b.ts", content: "// @ts-ignore\nconst z = w;" },
    { path: "c.ts", content: "// @unique-pragma-only-once\nconst q = r;" },
  ];
  const learned = learnBandaidPatterns(corpus, { minSupport: 2, maxPragmaLength: 80, maxDeferredLength: 200, includeLongCommentHeuristic: true });
  assert.ok(learned.suppressionPragmas.some((p) => p.includes("@ts-ignore")), "@ts-ignore (2 files) should be learned");
  assert.ok(!learned.suppressionPragmas.some((p) => p.includes("@unique-pragma-only-once")), "rare pragma (1 file) should NOT be learned");
});

test("EXP432 learner: learns a NEW pragma it has never seen (no hardcoded list)", () => {
  // A future pragma `@biome-ignore` (not in any hardcoded list) should be
  // learned if it appears in >= minSupport files. This proves the learner
  // is DYNAMIC — it does not depend on a static list of known pragmas.
  const corpus = [
    { path: "a.ts", content: "// @biome-ignore lint/a: x\nconst a = 1;" },
    { path: "b.ts", content: "// @biome-ignore lint/b: y\nconst c = 2;" },
    { path: "c.ts", content: "// @oxlint-disable\nconst d = 3;" },
    { path: "d.ts", content: "// @oxlint-disable\nconst e = 4;" },
  ];
  const learned = learnBandaidPatterns(corpus, { minSupport: 2, maxPragmaLength: 80, maxDeferredLength: 200, includeLongCommentHeuristic: true });
  assert.ok(learned.suppressionPragmas.some((p) => p.includes("@biome-ignore")), "should learn @biome-ignore (a future pragma)");
  assert.ok(learned.suppressionPragmas.some((p) => p.includes("@oxlint-disable")), "should learn @oxlint-disable (a future pragma)");
});

test("EXP432 learner: structural long-comment heuristic is keyword-free", () => {
  // A comment much longer than the code it precedes → deferred smell,
  // regardless of the comment's vocabulary (no keyword list needed).
  const corpus = [
    {
      path: "a.ts",
      content: [
        "// This is a very long comment explaining why we cannot fix this",
        "// properly right now because the upstream module is broken and we",
        "// need to ship a workaround until the team addresses the root cause.",
        "const x = y;",
      ].join("\n"),
    },
  ];
  const learned = learnBandaidPatterns(corpus, { minSupport: 1, maxPragmaLength: 80, maxDeferredLength: 500, includeLongCommentHeuristic: true });
  assert.ok(learned.deferredMarkers.includes("__long_comment_heuristic__"), "long-comment heuristic should be emitted");
});

// ============================================================
// 7. SHARED EXPOSURE — signals, actions, customizations
// ============================================================

test("EXP432 exposure: registers signals + actions + customizations", () => {
  const state = registerBandaidExposure(learnedConfig());
  // Signals
  assert.equal(typeof state.detectedCount, "number");
  assert.equal(typeof state.structuralFindings, "number");
  assert.equal(typeof state.rootCauseFindings, "number");
  assert.ok(state.learnedPragmaCount >= 0);
  assert.ok(state.learnedDeferredCount >= 0);
  // The detector's learnedPragmaCount should reflect the learned pragmas.
  assert.ok(state.learnedPragmaCount >= 3, `expected >= 3 learned pragmas, got ${state.learnedPragmaCount}`);
  // Update after a detection pass.
  const r = runDetect(learnedConfig(), [edit(1, "a.ts", ["const x = y as any;"])]);
  updateBandaidExposure(state, r);
  assert.equal(state.detectedCount, r.detectedCount);
  assert.ok(state.structuralFindings >= 1);
});

test("EXP432 exposure: relearn action updates the live config", async () => {
  const state = registerBandaidExposure(resolveBandaidConfig());
  assert.equal(state.learnedPragmaCount, 0);
  // Run the relearn action with the corpus.
  const corpus = buildCorpus();
  const result = await (await import("../../src/shared/exposure/index.ts")).executeAction("bandaid.relearn", { sourcesJson: JSON.stringify(corpus) }) as { suppressionPragmas: string[] };
  assert.ok(result.suppressionPragmas.some((p) => p.includes("@ts-ignore")), "relearn should populate the pragmas");
  assert.ok(state.learnedPragmaCount >= 3, `after relearn, learnedPragmaCount should be >= 3, got ${state.learnedPragmaCount}`);
});

// ============================================================
// 8. TEN TIMES HARDER — 500 bandaid cases (if 100% on 50)
// ============================================================

test("EXP432 10× harder: 500 generated bandaid cases — 100% detection", () => {
  const c = learnedConfig();
  const edits: EditEvent[] = [];
  let turn = 1;
  // 500 cases: cycle through structural shapes + learned pragmas/markers.
  const structuralShapes = [
    ["const z = risky() as any;"],
    ["try { op(); } catch (e) {}"],
    ["try { op(); } catch (e) { /* ignore */ }"],
    ["function f() { if (val === null) return; }"],
    ["function f() { if (r !== null) { r.go(); } }"],
    ["(obj as any).deep.prop = 1;"],
    ["const x = y as unknown as any;"],
    ["try { op(); } catch (e) { console.log('done'); }"],
    ["function g() { if (maybe == null) return; }"],
    ["const f = <any>g;"],
  ];
  const learnedComments = [
    ["// @ts-ignore", "const x = y;"],
    ["// @ts-expect-error", "const y = z;"],
    ["/* eslint-disable-next-line */", "const w: any = x;"],
    ["// TODO: fix later", "const v = h();"],
    ["// FIXME: refactor", "const u = l();"],
    ["/* eslint-disable */", "let anything: any = 0;"],
    ["// @ts-ignore: broken", "const a = b();"],
    ["// TODO: workaround", "const c = s();"],
  ];
  const rootCauseFix = "guard config-missing at the parseConfig call site and return a typed ConfigError";
  for (let i = 0; i < 500; i += 1) {
    const mod = i % 4;
    if (mod === 0) {
      const shape = structuralShapes[i % structuralShapes.length]!;
      edits.push(edit(turn++, "a.ts", [...shape]));
    } else if (mod === 1) {
      const lc = learnedComments[i % learnedComments.length]!;
      edits.push(edit(turn++, "a.ts", [...lc]));
    } else if (mod === 2) {
      edits.push(edit(turn++, `r${i}.ts`, ["return null;"], { rootCauseHint: "config missing", knownRootCauseFix: rootCauseFix }));
    } else {
      // mixed: structural + learned on different lines
      const shape = structuralShapes[i % structuralShapes.length]!;
      const lc = learnedComments[i % learnedComments.length]!;
      edits.push(edit(turn++, "a.ts", [...shape, ...lc]));
    }
  }
  assert.equal(edits.length, 500);
  const r = runDetect(c, edits);
  const missed: number[] = [];
  for (const e of edits) {
    if (!r.flaggedTurns.has(e.turn)) missed.push(e.turn);
  }
  assert.equal(missed.length, 0, `10× harder: missed ${missed.length}/500 bandaid turns; first misses: ${missed.slice(0, 10).join(",")}`);
});

test("EXP432 10× harder: 500 legitimate fixes — 0% false flag", () => {
  const c = learnedConfig();
  const edits: EditEvent[] = [];
  let turn = 1;
  const cleanSnippets = [
    ["function add(a: number, b: number) { return a + b; }"],
    ["const result = compute(input);", "if (result.isOk()) return result.value;", "throw result.error;"],
    ["function parseConfig(p) { if (!exists(p)) return new ConfigError(); return load(p); }"],
    ["export const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);"],
    ["const double = (x: number) => x * 2;"],
    ["function fib(n: number) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }"],
    ["const isEven = (n: number) => n % 2 === 0;"],
    ["try { op(); } catch (e) { logger.error('failed', e); throw e; }"],
    ["try { risky(); } catch (err) { report(err); }"],
    ["const ids = items.filter((x) => x.active).map((x) => x.id);"],
    ["function clamp(n: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, n)); }"],
    ["function gcd(a: number, b: number) { while (b !== 0) { [a, b] = [b, a % b]; } return a; }"],
    ["function range(n: number) { return Array.from({ length: n }, (_, i) => i); }"],
    ["try { x(); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }"],
    ["const head = <T,>(xs: readonly T[]) => xs[0];"],
  ];
  const rootCauseFix = "guard config-missing at parseConfig and return a typed ConfigError";
  for (let i = 0; i < 500; i += 1) {
    if (i % 5 === 0) {
      // root-cause-addressed edit
      edits.push(
        edit(turn++, `fix${i}.ts`, ["function parseConfig(p) {", "  if (!exists(p)) return new ConfigError();", "  return load(p);", "}"], {
          rootCauseHint: "config missing", knownRootCauseFix: rootCauseFix,
        }),
      );
    } else {
      const snip = cleanSnippets[i % cleanSnippets.length]!;
      edits.push(edit(turn++, "clean.ts", [...snip]));
    }
  }
  assert.equal(edits.length, 500);
  const r = runDetect(c, edits);
  const falseFlagged: number[] = [];
  for (const e of edits) {
    if (r.flaggedTurns.has(e.turn)) falseFlagged.push(e.turn);
  }
  assert.equal(falseFlagged.length, 0, `10× harder: false-flagged ${falseFlagged.length}/500; findings: ${r.findings.map((f) => `${f.turn}:${f.patternLabel}`).slice(0, 10).join(",")}`);
});

// ============================================================
// 9. STRUCTURAL DETECTOR — direct unit tests (keyword-free)
// ============================================================

test("EXP432 structural: empty/comment-only catch detected by AST shape", () => {
  const f = detectStructuralBandaids("try { op(); } catch (e) {}", { filePath: "a.ts", learnedSuppressionPragmas: [], learnedDeferredMarkers: [], longCommentDeferredEnabled: false, longCommentMinRatio: 4, longCommentMinCommentLength: 40 });
  assert.ok(f.some((x) => x.shape === "empty-or-comment-only-catch"));
});

test("EXP432 structural: as-any detected by TSAnyKeyword AST node", () => {
  const f = detectStructuralBandaids("const x = y as any;", { filePath: "a.ts", learnedSuppressionPragmas: [], learnedDeferredMarkers: [], longCommentDeferredEnabled: false, longCommentMinRatio: 4, longCommentMinCommentLength: 40 });
  assert.ok(f.some((x) => x.shape === "any-assertion"));
  // `as unknown` is NOT a bandaid — must NOT be flagged.
  const f2 = detectStructuralBandaids("const x = y as unknown;", { filePath: "a.ts", learnedSuppressionPragmas: [], learnedDeferredMarkers: [], longCommentDeferredEnabled: false, longCommentMinRatio: 4, longCommentMinCommentLength: 40 });
  assert.equal(f2.length, 0, "as unknown should NOT be flagged");
});

test("EXP432 structural: null guard detected by NullLiteral AST node", () => {
  const f = detectStructuralBandaids("function f() { if (val === null) return; }", { filePath: "a.ts", learnedSuppressionPragmas: [], learnedDeferredMarkers: [], longCommentDeferredEnabled: false, longCommentMinRatio: 4, longCommentMinCommentLength: 40 });
  assert.ok(f.some((x) => x.shape === "null-guard"));
});

test("EXP432 structural: unused catch binding detected (error swallowing)", () => {
  const f = detectStructuralBandaids("try { op(); } catch (e) { console.log('done'); }", { filePath: "a.ts", learnedSuppressionPragmas: [], learnedDeferredMarkers: [], longCommentDeferredEnabled: false, longCommentMinRatio: 4, longCommentMinCommentLength: 40 });
  assert.ok(f.some((x) => x.shape === "unused-catch-binding"));
  // A catch that USES the error is NOT flagged.
  const f2 = detectStructuralBandaids("try { op(); } catch (e) { report(e); }", { filePath: "a.ts", learnedSuppressionPragmas: [], learnedDeferredMarkers: [], longCommentDeferredEnabled: false, longCommentMinRatio: 4, longCommentMinCommentLength: 40 });
  assert.equal(f2.length, 0, "catch that uses the error should NOT be flagged");
});

test("EXP432 structural: clean code produces 0 findings", () => {
  const f = detectStructuralBandaids("function add(a, b) { return a + b; }", { filePath: "a.ts", learnedSuppressionPragmas: [], learnedDeferredMarkers: [], longCommentDeferredEnabled: false, longCommentMinRatio: 4, longCommentMinCommentLength: 40 });
  assert.equal(f.length, 0);
});
