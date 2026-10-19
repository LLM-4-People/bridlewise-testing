// @vitest-environment node
/**
 * Prevention: a Svelte `$effect` must not SYNCHRONOUSLY read+write the same
 * component state — `stateVar++`, `stateVar += …`, `stateVar = …stateVar…`
 * in the effect's own body. The update both READS the state (making the
 * effect a dependent of it) and WRITES it (re-triggering every dependent),
 * so the effect re-runs itself until Svelte's depth guard throws
 * `effect_update_depth_exceeded`. One instance of this loop cost ~15 turns
 * of failed stack captures before a per-effect re-run counter pinpointed it;
 * this guard exists so the NEXT instance is a red test, not a debugging
 * session.
 *
 * LADDER VERDICT: rung 5 (source scan), and the stop is specific.
 *   Rung 1 unavailable — effect scheduling lives inside Svelte's runtime; no
 *     OS or engine object refuses a reactive cycle at declaration time.
 *   Rung 2 unavailable — `$effect(() => { x++ })` is well-typed; the defect
 *     is a scheduling property, not a shape the type system can express.
 *   Rung 3 unavailable — runes are compiler keywords, not functions this
 *     codebase owns, so no door can demand a no-self-write proof.
 *   Rung 4 unavailable — there is no runtime choke point of ours between the
 *     template compiler and the effect scheduler.
 *   The scan is still exact about what it reads: the AST finds the real
 *   `$effect` calls (a comment or string cannot fake one), the sanctioned
 *   source view blanks comments + string interiors so a `x++` in prose
 *   cannot fire, and the enclosing-function door proves the write sits in
 *   the effect's own synchronous body — a `setTimeout` tick or a cleanup
 *   closure writing state is legal and stays green.
 *
 * DOCUMENTED BOUNDARY: a write inside a nested callback passed to a
 * SYNCHRONOUS iterator (`list.forEach(() => { x++ })`) is the same defect
 * and is NOT caught — telling that callback apart from an asynchronous one
 * needs a vocabulary of schedulers, and a vocabulary that fails silently is
 * worse than a stated gap. Member-expression writes (`obj.count++`) are out
 * of scope for the same reason (the root's reactivity is a cross-file
 * question).
 *
 * GUARD SUBJECT: a Svelte `$effect` never synchronously reads+writes the same component state in its own body
 * GUARD OWNS: src/ components' `$effect` bodies — the scan's subject; the detector helpers are tests/helpers/function-scope.ts
 * GUARD PLANT: add `count++` (or `count += 1` / `count = …count…`) to a `$effect` body in a scanned component; a write inside a nested SYNCHRONOUS iterator callback (`list.forEach(() => { count++ })`) is the documented boundary, not a plant
 * GUARD DRIVEN: the AST scan over every discovered `.svelte` component, entering through the same callArgumentsOf/enclosingFunctionOf helpers the guard uses — never a hand-rolled regex
 * GUARD LIVENESS: the component population is asserted non-empty and the sanctioned source view (comments + strings blanked) is proven awake by a planted loop in a temp component
 * GUARD BOUNDARY: a write inside a nested callback to a synchronous iterator, and member-expression writes (`obj.count++`), are deliberately not caught
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { callArgumentsOf, enclosingFunctionOf } from "../helpers/function-scope.ts";
import { relpath, walk } from "../helpers/source-scan.ts";
import { readSourceView, sourceViewOf } from "../../engine/scripts/verification/source-view.ts";

type FindingKind = "update" | "compound" | "assign";

interface SelfLoopFinding {
  /** The component state variable the effect synchronously reads + writes. */
  readonly state: string;
  readonly kind: FindingKind;
  /** Which `$effect` call in the file (0-based, source order). */
  readonly effectIndex: number;
  /** Offset of the effect's argument text in the component source. */
  readonly effectOffset: number;
}

/** The `…` inside `let { … } = $state(…)` / `let { … } = $props(…)`, brace-balanced. */
function* destructuredBindings(code: string): Generator<{ inner: string; init: string }> {
  for (const match of code.matchAll(/\blet\s*\{/g)) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let i = open; i < code.length; i += 1) {
      const c = code[i]!;
      if (c === "{") depth += 1;
      else if (c === "}") {
        depth -= 1;
        if (depth === 0) { close = i; break; }
      }
    }
    if (close < 0) continue;
    const after = code.slice(close + 1).match(/^\s*=\s*(\$state(?:\.[A-Za-z_$][\w$]*)?|\$props)\s*\(/);
    if (after === null) continue;
    yield { inner: code.slice(open + 1, close), init: after[1]! };
  }
}

/** The local binding names of one destructured part (`a`, `a: b`, `a: b = d`, `...r`). */
function bindingNameOf(part: string): string | undefined {
  const m = part.match(/^\s*(?:\.\.\.\s*)?([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?/);
  if (m === null) return undefined;
  return m[2] ?? m[1];
}

/**
 * The writable component state names declared in `code` (the component
 * source through the sanctioned code view — comments + strings blanked):
 * `let x = $state(…)`, class-field `x = $state(…)`, destructured
 * `let { x } = $state(…)`, and the `$bindable()` parts of a `$props()`
 * destructure (a bindable prop is writable state).
 */
export function stateNamesOf(code: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const m of code.matchAll(/\blet\s+([A-Za-z_$][\w$]*)\s*=\s*\$state(?:\.[A-Za-z_$][\w$]*)?\s*\(/g)) {
    names.add(m[1]!);
  }
  for (const m of code.matchAll(
    /(?:^|[;{]\s*)(?:public\s+|private\s+|protected\s+|readonly\s+|static\s+|declare\s+|accessor\s+)*([A-Za-z_$][\w$]*)\s*=\s*\$state(?:\.[A-Za-z_$][\w$]*)?\s*\(/gm,
  )) {
    names.add(m[1]!);
  }
  for (const { inner, init } of destructuredBindings(code)) {
    // Split the binding list on top-level commas (the view has blanked
    // strings, so only structural brackets remain).
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i <= inner.length; i += 1) {
      const c = inner[i];
      if (c === "{" || c === "[" || c === "(") depth += 1;
      else if (c === "}" || c === "]" || c === ")") depth -= 1;
      if ((c === "," && depth === 0) || i === inner.length) {
        parts.push(inner.slice(start, i));
        start = i + 1;
      }
    }
    for (const part of parts) {
      if (init === "$props" && !/\$bindable\s*\(/.test(part)) continue;
      const name = bindingNameOf(part);
      if (name !== undefined) names.add(name);
    }
  }
  return names;
}

/** The text of a simple assignment's right-hand side, bounded by the enclosing construct. */
function rhsRegion(code: string, from: number): string {
  let depth = 0;
  for (let i = from; i < code.length; i += 1) {
    const c = code[i]!;
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return code.slice(from, i);
      depth -= 1;
    } else if ((c === ";" || c === ",") && depth === 0) return code.slice(from, i);
  }
  return code.slice(from);
}

/**
 * Is `offset` in the SYNCHRONOUS body of the probe's outermost function —
 * the effect callback itself? The probe wraps the effect's argument list in
 * an array literal, so the effect callback is the one function with no
 * enclosing function; a write whose innermost function is anything deeper
 * (a `setTimeout` tick, a `.then`, the returned cleanup) is asynchronous
 * and not this defect.
 */
function isSynchronousInEffect(probe: string, offset: number): boolean {
  const innermost = enclosingFunctionOf(probe, offset, "effect callback");
  if (innermost === undefined) return true; // evaluated directly in the call arguments
  return enclosingFunctionOf(probe, innermost.offset - 1, "effect callback parent") === undefined;
}

interface WriteCandidate {
  readonly name: string;
  readonly at: number;
  readonly kind: FindingKind;
  /** Offset just past the `=` of a simple assignment (kind "assign" only). */
  readonly rhsFrom: number;
}

/** Every `name++` / `name += …` / `name = …` in the probe (comments + strings blanked). */
function writeCandidates(code: string): WriteCandidate[] {
  const out: WriteCandidate[] = [];
  for (const m of code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?:\+\+|--)/g)) {
    out.push({ name: m[1]!, at: m.index, kind: "update", rhsFrom: -1 });
  }
  for (const m of code.matchAll(/(?:\+\+|--)\s*([A-Za-z_$][\w$]*)/g)) {
    out.push({ name: m[1]!, at: m.index, kind: "update", rhsFrom: -1 });
  }
  for (const m of code.matchAll(
    /(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?:\+=|-=|\*=|\/=|%=|<<=|>>>=|>>=|&=|\^=|\|=|\?\?=|&&=|\|\|=)/g,
  )) {
    out.push({ name: m[1]!, at: m.index, kind: "compound", rhsFrom: -1 });
  }
  for (const m of code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)(\s*)=(?![=>])/g)) {
    // A declaration (`let x = …`) initialises; it does not read+write state.
    if (/\b(?:let|const|var)\s*$/.test(code.slice(0, m.index))) continue;
    const rhsFrom = m.index + m[1]!.length + m[2]!.length + 1;
    out.push({ name: m[1]!, at: m.index, kind: "assign", rhsFrom });
  }
  return out;
}

/**
 * Every synchronous state self-read+write inside the `$effect` /
 * `$effect.pre` calls of one component source. Pure over the source text so
 * the guard is driven by planted fixtures, never by mutating live files.
 */
export function findEffectSelfLoops(source: string, path: string): readonly SelfLoopFinding[] {
  const code = sourceViewOf(source, path).code();
  const stateNames = stateNamesOf(code);
  if (stateNames.size === 0) return [];
  const findings: SelfLoopFinding[] = [];
  const calls = [
    ...callArgumentsOf(source, "$effect").map((args) => ({ args, pre: false })),
    ...callArgumentsOf(source, "$effect.pre").map((args) => ({ args, pre: true })),
  ];
  let cursor = 0;
  let effectIndex = 0;
  for (const { args } of calls) {
    const at = source.indexOf(args, cursor);
    const effectOffset = at >= 0 ? at : -1;
    if (at >= 0) cursor = at + args.length;
    const probe = `[${args}];`;
    const probeCode = sourceViewOf(probe, "probe.ts").code();
    for (const candidate of writeCandidates(probeCode)) {
      if (!stateNames.has(candidate.name)) continue;
      if (!isSynchronousInEffect(probe, candidate.at)) continue;
      if (candidate.kind === "assign") {
        // `x = …` is a self-loop only when the right-hand side READS `x`
        // synchronously (`x = x + 1`). `x = 5` is write-only: the effect
        // never becomes a dependent of `x`, so nothing loops.
        const rhs = rhsRegion(probeCode, candidate.rhsFrom);
        const readRe = new RegExp(`(?<![\\w$.])${candidate.name.replace(/[$]/g, "\\$")}\\b`, "g");
        // A synchronous read means the mention's innermost function is the
        // effect callback too — `x = () => x + 1` defers the read and does
        // not loop.
        const syncRead = [...rhs.matchAll(readRe)].some((hit) => {
          const mentionAt = candidate.rhsFrom + (hit.index ?? 0);
          return isSynchronousInEffect(probe, mentionAt);
        });
        if (!syncRead) continue;
      }
      findings.push({ state: candidate.name, kind: candidate.kind, effectIndex, effectOffset });
    }
    effectIndex += 1;
  }
  return findings;
}

/** The live scan: every component + state module under `src/`, discovered dynamically. */
function liveComponentFiles(): readonly string[] {
  // The filter asks a CODE question ("does this file call $effect"), so it
  // reads the sanctioned code view — a `$effect` mentioned only in a comment
  // or string does not place the file in the universe.
  return walk("src", { exts: [".svelte", ".ts"] })
    .map((file) => relpath(file))
    .filter((file) => readSourceView(file).code().includes("$effect"));
}

describe("svelte $effect self-loop prevention", () => {
  test("no $effect synchronously reads + writes the same component state (deny-by-default)", () => {
    const files = liveComponentFiles();
    // Liveness: the universe must not be empty — a renamed rune or a moved
    // tree would otherwise pass having examined nothing.
    expect(files.length, "should discover at least one file using $effect").toBeGreaterThan(0);
    let effectsScanned = 0;
    const violations: string[] = [];
    for (const file of files) {
      // The bytes are parser input (sourceViewOf + the AST doors); every
      // QUESTION about the file is answered through a view, never matched
      // against the raw value.
      const parserInput = readFileSync(file, "utf8");
      const findings = findEffectSelfLoops(parserInput, file);
      effectsScanned += callArgumentsOf(parserInput, "$effect").length + callArgumentsOf(parserInput, "$effect.pre").length;
      for (const finding of findings) {
        const view = sourceViewOf(parserInput, file);
        const line = finding.effectOffset >= 0 ? view.lineAt(finding.effectOffset) : "?";
        violations.push(`${file}:${line} — $effect #${finding.effectIndex + 1} synchronously reads + writes $state "${finding.state}" (${finding.kind})`);
      }
    }
    console.log(`[$effect self-loop scan] ${files.length} files with $effect, ${effectsScanned} effect calls scanned`);
    expect(effectsScanned, "should scan at least one $effect call").toBeGreaterThan(0);
    expect(
      violations,
      `an $effect that synchronously reads + writes the same $state is a self-dependency — the effect re-runs itself until Svelte throws effect_update_depth_exceeded. Move the write into an event/callback, or write WITHOUT reading (x = 5, not x++):\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  // ── Mutation verification (planted fixtures, pure-function driven) ──────
  // The guard's detector is a pure function over source text, so each plant
  // is a fixture string — the live tree is never mutated. Every plant names
  // a DIFFERENT shape than the one the live arm could ever see, proving the
  // guard catches the CLASS.

  const STATE = "let sweepTick = $state(0);";

  test("plant: a synchronous `tick++` in an $effect is flagged (the measured incident shape)", () => {
    const findings = findEffectSelfLoops(`${STATE}\n$effect(() => { sweepTick++; });`, "planted.svelte");
    expect(findings.length).toBe(1);
    expect(findings[0]!.state).toBe("sweepTick");
    expect(findings[0]!.kind).toBe("update");
  });

  test("plant: compound assignment (`+=`, `??=`) and prefix update are flagged", () => {
    expect(findEffectSelfLoops(`${STATE}\n$effect(() => { sweepTick += 1; });`, "p.svelte").length).toBe(1);
    expect(findEffectSelfLoops(`${STATE}\n$effect(() => { sweepTick ??= 7; });`, "p.svelte").length).toBe(1);
    expect(findEffectSelfLoops(`${STATE}\n$effect(() => { ++sweepTick; });`, "p.svelte").length).toBe(1);
    expect(findEffectSelfLoops(`${STATE}\n$effect(() => --sweepTick);`, "p.svelte").length).toBe(1);
  });

  test("plant: the sanctioned escape — reading through `untrack(() => x)` — is NOT flagged", () => {
    // The nested arrow defers the read out of the tracked context, so this
    // is the fix shape for the defect, and the guard must stay green on it.
    const source = `${STATE}\n$effect(() => { sweepTick = untrack(() => sweepTick) + 1; });`;
    expect(findEffectSelfLoops(source, "p.svelte").length).toBe(0);
  });

  test("plant: a self-reading assignment (`x = x + 1`) is flagged; a write-only one (`x = 5`) is not", () => {
    expect(findEffectSelfLoops(`${STATE}\n$effect(() => { sweepTick = sweepTick + 1; });`, "p.svelte").length).toBe(1);
    expect(findEffectSelfLoops(`${STATE}\n$effect(() => { sweepTick = 5; });`, "p.svelte").length).toBe(0);
  });

  test("plant: an ASYNCHRONOUS write (interval tick, cleanup closure) is NOT flagged", () => {
    // The false-positive boundary: deferred writes do not loop the effect.
    const interval = `${STATE}\n$effect(() => { const t = setInterval(() => { sweepTick++; }, 1000); return () => clearInterval(t); });`;
    expect(findEffectSelfLoops(interval, "p.svelte").length).toBe(0);
    const cleanup = `${STATE}\n$effect(() => { document.title = String(sweepTick); return () => { sweepTick = 0; }; });`;
    expect(findEffectSelfLoops(cleanup, "p.svelte").length).toBe(0);
  });

  test("plant: reading one state and writing ANOTHER is NOT flagged (the inert shape)", () => {
    const source = `let sourceCount = $state(0); let mirrored = $state(0);\n$effect(() => { mirrored = sourceCount + 1; });`;
    expect(findEffectSelfLoops(source, "p.svelte").length).toBe(0);
  });

  test("plant: a write to a NON-state variable is NOT flagged (state membership is load-bearing)", () => {
    const source = `let plainCounter = 0; let sweepTick = $state(0);\n$effect(() => { plainCounter++; });`;
    expect(findEffectSelfLoops(source, "p.svelte").length).toBe(0);
  });

  test("plant: `x++` inside a comment or string literal is NOT flagged (the view blanks them)", () => {
    const source = `${STATE}\n$effect(() => { /* sweepTick++ */ const s = "sweepTick++"; return sweepTick; });`;
    expect(findEffectSelfLoops(source, "p.svelte").length).toBe(0);
  });

  test("plant: $effect.pre is covered too", () => {
    expect(findEffectSelfLoops(`${STATE}\n$effect.pre(() => { sweepTick += 2; });`, "p.svelte").length).toBe(1);
  });

  test("plant: a $bindable prop is writable state; destructured $state names are found", () => {
    const bindable = `let { value = $bindable(0), label } = $props();\n$effect(() => { value++; });`;
    expect(findEffectSelfLoops(bindable, "p.svelte").length).toBe(1);
    const destructured = `let { low, high } = $state({ low: 0, high: 1 });\n$effect(() => { low += high; });`;
    expect(findEffectSelfLoops(destructured, "p.svelte").length).toBe(1);
    // …but a NON-bindable prop is not writable state.
    const plainProp = `let { value = $bindable(0), label } = $props();\n$effect(() => { label++; });`;
    expect(findEffectSelfLoops(plainProp, "p.svelte").length).toBe(0);
  });

  test("plant: an $effect whose callback is an identifier reference yields no findings (no crash)", () => {
    const source = `${STATE}\nconst tick = () => { sweepTick++; };\n$effect(tick);`;
    expect(findEffectSelfLoops(source, "p.svelte").length).toBe(0);
  });
});
