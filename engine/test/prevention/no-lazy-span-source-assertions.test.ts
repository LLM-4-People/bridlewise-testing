// Standing guard against the "lazy span bridges a block boundary to a GENERIC
// target" source-assertion class.
//
// The defect this refuses: a source assertion whose regex uses a LAZY span —
// `[\s\S]*?` / `[\s\S]*` (or a bounded `[\s\S]{0,N}`) — to reach a GENERIC
// target (`return <something>`, `return;`, `throw …`, `process.exit`,
// `exitCode = …`). Because the span is unanchored, it can cross a closing brace
// and satisfy the match on the WRONG block's return/exit, so the assertion
// passes while the branch it claims to verify is dead — the wired-but-inert
// shape, proven live twice (a `"fail"[\s\S]*?return 1;` arm that matched the
// catch block's `return 1` after the fail branch's own was deleted, and a
// `store\(...\)[\s\S]*?return this.commitDedupResult` arm that spanned into the
// sibling `storeAsync` body).
//
// WHY A SCAN (the rung verdict). Rung 1–3 are unavailable: a regex literal is
// data, the language cannot forbid the shape, and the assertion's target is a
// runtime number, not a type. The behavioral fix (drive the choke-point owner)
// is the per-instance repair; THIS guard is the deny-by-default rung-5 net that
// catches the NEXT instance written the same broken way. Its universe is the
// two prevention estates plus the cockpit suite, discovered dynamically; a new
// lazy-span-to-generic-target assertion added tomorrow reds here, not silently.
//
// A lazy span is NOT itself a violation. It is refused ONLY when it reaches a
// generic return/exit/throw (the target that exists in many blocks and so can
// be satisfied by the wrong one). A span anchored to a SPECIFIC subject
// (a named function, a unique literal) stays green. A span that genuinely must
// reach a generic target must carry a documented opt-out:
// `@lazy-span-ok <reason>` on a comment line — the same deny-by-default opt-out
// pattern as `@global-store` / `@freshness-exempt`, and each marker must carry
// a non-empty reason.

import assert from "node:assert/strict";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { lexSpans, readSourceView } from "../../scripts/verification/source-view.ts";
import { walk } from "../../scripts/verification/source-walk.ts";

const ENGINE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

// The scan roots, discovered — the two prevention estates plus the cockpit
// suite. A new test file under any of these roots is scanned automatically.
const SCAN_ROOTS: readonly string[] = [
  join(REPO_ROOT, "tests", "prevention"),
  join(REPO_ROOT, "tests", "cockpit"),
  join(ENGINE_ROOT, "test", "prevention"),
];

/** Every test source file under the scan roots, recursively. */
function estateSources(): readonly string[] {
  return SCAN_ROOTS.flatMap((root) => walk(root, { exts: [".ts"] }))
    .filter((file) => /\.test\.ts$/u.test(file))
    .sort();
}

/** True if the source carries a documented `@lazy-span-ok <reason>` opt-out. */
function exemptionReason(src: string): string | null {
  const m = /^\s*(?:\/\/+|\/\*+|\*)\s*@lazy-span-ok\s+(.+)$/m.exec(src);
  return m === null ? null : m[1]!.trim();
}

// A LAZY (or greedy/reluctant) all-text span: `[\s\S]` (or the escaped-source
// form `[\\s\\S]` as it appears inside a regex LITERAL's raw text) followed by
// a `*`/`+` quantifier (optionally lazy `?`), or a bounded `{0,N}` repetition.
const LAZY_SPAN_RE = /\[\s*\\?s\\?S\s*\](?:[*+]\??|\{\s*0\s*,\s*\d+\s*\})/u;

// A GENERIC target — the kind that exists in many blocks and so can be
// satisfied by the wrong one. The refused set is deliberately NARROW: a return
// of a bare literal or keyword (`return 0`, `return 1`, `return true`,
// `return undefined`, `return null`, `return;`), a `throw`, or an exit
// (`process.exit(…)` / `process.exitCode = …` / `exitCode = …`). These are the
// targets many blocks share, so a lazy span can land on the WRONG block's copy.
// A `return this.specificMethod(` or `return gitText(` is a SPECIFIC target —
// the named call anchors the match to one block, so it is NOT the refused
// class (and the `{0,N}` bounded-window form is owned by
// `no-proximity-window-assertions`). Backslashes are tolerated because the
// regex body carries them literally (`process\.exit`).
const GENERIC_TARGET_RE =
  /\breturn\s*(?:;|$|[0-9\-"'`]|\btrue\b|\bfalse\b|\bundefined\b|\bnull\b|\bthis\b|\{\s*\}|\[\s*\])|\bthrow\b|\\?\bprocess\\?\.\s*exit|\\?\bexitCode\s*=/u;

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly body: string;
}

/**
 * Extract every regex LITERAL in a file that carries a lazy all-text span
 * bridging to a generic return/exit/throw target. The spans come from the
 * sanctioned lexer (`lexSpans`), so a `/` inside a string or comment is never
 * misread as a regex opener, and a regex containing a quote never
 * desynchronises the scan (the §29a class this project's hand-strippers hit).
 */
function lazySpanGenericTargetFindings(src: string, rel: string): Finding[] {
  const findings: Finding[] = [];
  const lineStarts: number[] = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") lineStarts.push(i + 1);
  const lineAt = (idx: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  for (const span of lexSpans(src, false)) {
    if (span.kind !== "regex") continue;
    const literal = src.slice(span.start, span.end); // includes the /…/flags
    // Strip the opening/closing slashes + flags to read the pattern body.
    const bodyMatch = /^\/([\s\S]*)\/[a-z]*$/u.exec(literal);
    if (bodyMatch === null) continue;
    const body = bodyMatch[1]!;
    if (!LAZY_SPAN_RE.test(body)) continue;
    if (!GENERIC_TARGET_RE.test(body)) continue;
    findings.push({ file: rel, line: lineAt(span.start), body });
  }
  return findings;
}

test("lazy-span-to-generic-target: the estate scan discovers a non-empty universe", () => {
  const files = estateSources();
  assert.ok(
    files.length > 0,
    "the estate scan discovered zero test files — a guard with an empty universe " +
      "passes vacuously; the scan roots must be wrong",
  );
});

test("lazy-span-to-generic-target: no source assertion lazy-spans to a generic return/exit/throw", () => {
  const violations: string[] = [];
  for (const file of estateSources()) {
    const view = readSourceView(file);
    // The opt-out lives in a COMMENT, so it is read from the prose view; the
    // regex findings live in CODE, so they are read from the code view. Two
    // views of one file, each naming the right subject.
    if (view.prose().some((p) => exemptionReason(p.text) !== null)) continue;
    const rel = relative(REPO_ROOT, file).split("\\").join("/");
    for (const f of lazySpanGenericTargetFindings(view.code(), rel)) {
      violations.push(
        `${f.file}:${f.line} — a source assertion lazy-spans ( [\\s\\S]*? / [\\s\\S]{0,N} ) to a ` +
          `GENERIC target: /${f.body}/ — the span can cross a block boundary and match the WRONG ` +
          "block's return/exit, so the assertion passes while the branch it claims to verify is " +
          "dead. Drive the choke point behaviorally, anchor the span to a SPECIFIC subject, or " +
          "carry a `@lazy-span-ok <reason>` opt-out.",
      );
    }
  }
  assert.deepEqual(
    violations,
    [],
    violations.length > 0 ? `\n  ${violations.join("\n  ")}` : "",
  );
});

test("lazy-span-to-generic-target: every @lazy-span-ok opt-out carries a non-empty reason", () => {
  const bare: string[] = [];
  for (const file of estateSources()) {
    for (const p of readSourceView(file).prose()) {
      if (/@lazy-span-ok\s*$/u.test(p.text)) {
        bare.push(relative(REPO_ROOT, file).split("\\").join("/"));
      }
    }
  }
  assert.deepEqual(
    bare,
    [],
    `@lazy-span-ok markers with no reason: ${bare.join(", ")} — an opt-out must say WHY the span is safe`,
  );
});

// ── Mutation-liveness: the detector bites the class, sparing the safe shapes ──

test("lazy-span-to-generic-target: the detector REDS the dangerous shape and GREENS the safe shapes", () => {
  // (1) The ORIGINAL CP2-F1 shape — lazy span to a generic `return 1`.
  const cp2f1 = `assert.match(src, /"fail"[\\s\\S]*?return 1;/);`;
  assert.equal(
    lazySpanGenericTargetFindings(cp2f1, "fixture.ts").length,
    1,
    "the CP2-F1 original (lazy span to a generic `return 1;`) must be caught",
  );

  // (2) A lazy span to a generic `throw` / `process.exit` — same class, other doors.
  const lazyThrow = `assert.match(src, /if \\(bad\\)[\\s\\S]*?throw new Error/);`;
  assert.equal(lazySpanGenericTargetFindings(lazyThrow, "fixture.ts").length, 1);
  const lazyExit = `assert.match(src, /"fail"[\\s\\S]{0,200}process\\.exit/);`;
  assert.equal(lazySpanGenericTargetFindings(lazyExit, "fixture.ts").length, 1);

  // (3) SAFE: a lazy span anchored to a SPECIFIC subject (no generic target).
  const anchored = `assert.match(src, /store\\(\\)[\\s\\S]*?this\\.commitDedupResult\\(/);`;
  assert.equal(
    lazySpanGenericTargetFindings(anchored, "fixture.ts").length,
    0,
    "a lazy span with NO generic return/exit/throw target is not the refused shape",
  );

  // (4) SAFE: a regex with NO lazy all-text span, even asserting on a return.
  const noSpan = `assert.match(src, /return 1;/);`;
  assert.equal(lazySpanGenericTargetFindings(noSpan, "fixture.ts").length, 0);

  // (5) A documented opt-out suppresses the finding (the whole-file path).
  const exempt = `// @lazy-span-ok the span is bounded by the function's own braces, proven by plant\n${cp2f1}`;
  assert.ok(exemptionReason(exempt) !== null, "a documented opt-out must register");
});
