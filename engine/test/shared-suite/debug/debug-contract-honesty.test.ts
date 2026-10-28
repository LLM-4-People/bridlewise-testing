import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  configureDebugSystem,
  resetDebugSystem,
  getDebugSignals,
  debugLog,
  createCollectingSink,
} from "../../../src/shared/debug/debug-system.ts";
import { DEBUG_CONFIG_DEFAULTS, type DebugConfig } from "../../../src/shared/debug/debug-config.ts";
import { hasSensitiveContent, redactText } from "../../../src/privacy/redaction-engine.ts";
import { DEFAULT_PRIVACY_POLICY } from "../../../src/privacy/privacy-policy.ts";
import { readSourceView, sourceViewOf, type SourceView } from "../../../scripts/verification/source-view.ts";
import { walk } from "../../../scripts/verification/source-walk.ts";

/**
 * ⚠ A SECURITY CONTROL'S CONTRACT IS PART OF THE CONTROL, AND THIS ONE NAMED AN
 * ORACLE THAT DOES NOT RUN.
 *
 * Both of `debug-system.ts`'s redaction counters promised the removed span was
 * "re-observed absent by the canonical oracle". The current import owners are
 * `errors.ts`, `debug-config.ts`, and the shared `secret-signals.ts` vocabulary.
 * No privacy detector or verifier runs in this layer. The
 * wording was residue of a wiring attempt that was reverted for a measured
 * reason (eight TDZ breaks at module load), and it was left behind in the
 * contract of the thing that decides whether a credential reaches a log.
 *
 * A reader who trusted it would have believed every counted removal had been
 * independently verified. Nothing was verified.
 *
 * ── WHY THIS GUARD IS NOT A WORD SCAN ────────────────────────────────────
 *
 * The obvious guard forbids the phrase. That guard is satisfied by SILENCE and
 * it forbids the file from honestly describing its own limit — the exact defect
 * already recorded in this project as W-11, where correcting a docstring to SAY
 * what it accepted made a raw-byte scan fail. So none of the three assertions
 * below is about wording:
 *
 *   1. STRUCTURAL — the debug subtree imports no privacy detector or verifier.
 *      That is what "no oracle runs here" MEANS, stated mechanically. Driven
 *      both ways against planted fixtures, so a scan that can no longer see an
 *      import fails instead of passing.
 *   2. DECLARED — `debug-system.ts`'s import list is exactly the three the
 *      contract names. Wiring the oracle in reds this, which forces the author
 *      back to the claims BEFORE the claims can become true again.
 *   3. BEHAVIOURAL — a string the canonical engine DOES detect moves neither
 *      counter. The oracle itself is the witness: it is called in this test,
 *      finds the secret, and the layer under test still reports nothing. That
 *      is the executable form of the deleted sentence.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const DEBUG_SUBTREE = join(REPO_ROOT, "src", "shared", "debug");
const SUBJECT = join(DEBUG_SUBTREE, "debug-system.ts");

/**
 * The module specifiers a file statically imports, read from `code()` — the
 * view with string interiors BLANKED — so a specifier quoted in a comment or
 * inside another string is documentation and not an edge. The specifier itself
 * is a string literal, so the delimiters survive `code()` and the interior does
 * not; the text is recovered from the same byte range of the raw source.
 */
function importSpecifiers(view: SourceView, raw: string): readonly string[] {
  const out: string[] = [];
  const code = view.code();
  // ⚠ THE `\n` THAT USED TO BE IN THIS CLASS MADE THE GUARD BLIND TO A
  // MULTI-LINE IMPORT, AND THAT IS A HOLE IN A SECURITY GUARD, NOT A COSMETIC
  // MISS. The clause read `[^'"\n]*?`, so `import {\n  a,\n} from "./x.ts"`
  // matched nothing — and the test below that refuses ANY `privacy/` import in
  // the debug subtree runs on this same reader. A verifier imported across
  // more than one line would have been invisible to the check that exists to
  // forbid it, while the check went on passing.
  //
  // FOUND THE ONLY WAY IT COULD BE: by adding a real multi-line import to the
  // subject and watching the "import list is EXACTLY …" assertion report the
  // OLD three specifiers. The witness below never planted a multi-line edge,
  // so it had no way to catch this — that plant is added now, both directions.
  //
  // `;` REPLACES `\n` AS THE BOUND, and it is the right one: an import clause
  // can span lines but can never contain a semicolon, so the lazy match still
  // cannot run past the end of the statement into an unrelated string literal.
  const pattern = /(?:^|[\n;])\s*import\s(?:[^'";]*?from\s*)?(['"])/gu;
  for (const match of code.matchAll(pattern)) {
    const quoteAt = match.index + match[0].length - 1;
    const quote = match[1]!;
    const close = code.indexOf(quote, quoteAt + 1);
    if (close < 0) continue;
    out.push(raw.slice(quoteAt + 1, close));
  }
  return out;
}

function listTs(dir: string): string[] {
  return walk(dir, { exts: [".ts"] });
}

test("contract honesty: the import reader is WITNESSED — it finds real specifiers and misses none it is shown", () => {
  // §29b/§36 — a scanner that returns an empty set is indistinguishable from
  // one whose pattern stopped matching. Both directions, on text this test owns.
  const planted = [
    `import a from "./alpha.ts";`,
    `import { b } from "../beta.ts";`,
    `import * as c from "node:fs";`,
    `// import { fake } from "./not-an-edge.ts";`,
    `const s = 'import x from "./also-not-an-edge.ts"';`,
    `import "./side-effect.ts";`,
    // ⚠ THE PLANT THAT WAS MISSING, AND ITS ABSENCE HID A LIVE DEFECT.
    // Every specimen above sits on ONE line, so the reader's `[^'"\n]*?`
    // clause was never asked a question it could get wrong. A real multi-line
    // import — the shape a formatter produces for any import of more than two
    // or three names — returned NOTHING, silently, including for the
    // `privacy/` refusal below. A witness that only plants the easy shape
    // certifies the reader against the easy shape.
    `import {`,
    `  d,`,
    `  e,`,
    `} from "./multiline.ts";`,
    // …and the negative twin, so the fix cannot be "match everything".
    `/* import { fake2 } from "./commented-multiline.ts"; */`,
    ``,
  ].join("\n");
  const view = sourceViewOf(planted, "planted.ts");
  const found = importSpecifiers(view, planted);
  assert.deepEqual(
    [...found].sort(),
    ["../beta.ts", "./alpha.ts", "./multiline.ts", "./side-effect.ts", "node:fs"],
    "every real edge is found — INCLUDING the multi-line one — and neither the commented ones nor the one inside a string is",
  );

  const noneView = sourceViewOf(`export const x = 1;\n`, "none.ts");
  assert.deepEqual(importSpecifiers(noneView, `export const x = 1;\n`), [], "a module with no imports yields none");
});

test("contract honesty: NOTHING in the debug subtree imports a privacy VERIFIER — 'no oracle runs here', stated mechanically", () => {
  const modules = listTs(DEBUG_SUBTREE);
  assert.ok(modules.length >= 2, `witness: the subtree was actually walked (${modules.length} modules)`);

  // The invariant is "no detector runs here", not "no file lives under a
  // directory named privacy/". The debug layer DOES share the vocabulary
  // (secret-signals.ts — the key names and signal catalog); what it must never
  // import is the VERIFIER machinery (the redaction engine and the detection /
  // grammar modules that decide a span is a secret). The fold moved the
  // vocabulary under src/privacy/, so a path-prefix refusal would forbid the
  // shared word-list and pass vacuously on the verifier. Refuse the verifier
  // capability by name; permit the vocabulary module alone.
  const SHARED_VOCABULARY = /\/secret-signals\.ts$/u;
  const offenders: string[] = [];
  let totalEdges = 0;
  for (const file of modules) {
    const view = readSourceView(file);
    const raw = readFileSync(file, "utf8");
    const specs = importSpecifiers(view, raw);
    totalEdges += specs.length;
    for (const spec of specs) {
      if (/(^|\/)privacy\//u.test(spec) && !SHARED_VOCABULARY.test(spec)) {
        offenders.push(`${relative(REPO_ROOT, file)} → ${spec}`);
      }
    }
  }
  assert.ok(totalEdges > 0, "witness: the scan read real import edges, so an empty offender list means something");
  console.log(`[contract-honesty] ${modules.length} modules, ${totalEdges} import edges (unit: import statements) in src/shared/debug`);

  assert.deepEqual(
    offenders,
    [],
    "the debug layer verifies nothing, because it imports no verifier — if this reds, the counters' contracts must be rewritten in the same commit",
  );
});

test("contract honesty: debug-system.ts's import list is EXACTLY the three its contract names", () => {
  const raw = readFileSync(SUBJECT, "utf8");
  const specs = [...importSpecifiers(readSourceView(SUBJECT), raw)].sort();
  assert.deepEqual(
    specs,
    ["../../kernel/errors.ts", "../../privacy/secret-signals.ts", "./debug-config.ts"],
    "the contract says 'this file's entire import list is three owners'; this is that sentence, checkable",
  );
});

/**
 * ⚠ THE CONTRACT THIS TEST ENFORCES HAS NARROWED, AND THE NARROWING IS THE
 * POINT. THE STRING HAD TO CHANGE WITH IT.
 *
 * It used to be `AKIA<16 characters>`, chosen because the canonical engine
 * detected it and it hit none of the eight key-name patterns the debug layer
 * was configured with. That second half is no longer true: the layer now
 * derives its content vocabulary from `SECRET_TEXT_SIGNAL_CATALOG`, whose
 * `aws-access-key` signal matches exactly that string. Keeping it would have
 * made this test assert a leak that has been closed.
 *
 * SO THE CLAIM IS RE-STATED AT THE RIGHT WIDTH. What the debug layer now
 * shares with the canonical engine is the VOCABULARY (`secret-signals.ts`).
 * What it still does not have is the VERIFIER: nothing here calls
 * `verifyRedaction`, nothing re-observes a span as absent, and no PII
 * detector, identity grammar or entropy test runs. `redactedValues` therefore
 * still means only "values dropped for a sensitive key name".
 *
 * The string below is chosen to prove that gap is REAL rather than described:
 * the canonical engine detects it AND removes it, and the debug layer is
 * blind to it. Both halves are asserted in the same run, so if the engine ever
 * stops seeing it this test reds on its own witness instead of quietly passing
 * on a vacuous zero.
 */
const ENGINE_DETECTABLE = "4111111111111111";

test("contract honesty: a secret THE ORACLE FINDS but this layer's vocabulary does NOT moves neither counter", () => {
  assert.equal(
    hasSensitiveContent(ENGINE_DETECTABLE, DEFAULT_PRIVACY_POLICY),
    true,
    "witness: the canonical oracle really does detect this string, so the zeros below are about the debug layer",
  );
  assert.ok(
    !redactText(ENGINE_DETECTABLE, DEFAULT_PRIVACY_POLICY).redactedText.includes(ENGINE_DETECTABLE),
    "witness: and the canonical engine really would have removed it",
  );

  const sink = createCollectingSink();
  configureDebugSystem(
    {
      ...DEBUG_CONFIG_DEFAULTS,
      enabled: true,
      level: "trace",
      categories: ["test"],
      sinks: { ...DEBUG_CONFIG_DEFAULTS.sinks, enabledSinks: ["collecting"] },
    } as DebugConfig,
    [sink],
  );
  const before = getDebugSignals();
  debugLog("test", "error", "msg", () => ({ detail: `WITNESS-O1 ${ENGINE_DETECTABLE}` }));
  const out = String(sink.events[0]!.context.detail);
  const after = getDebugSignals();

  assert.ok(out.includes("WITNESS-O1"), "witness: reading the string the secret was in");
  assert.equal(after.debugCount - before.debugCount, 1, "witness: an event WAS emitted");
  assert.ok(out.includes(ENGINE_DETECTABLE), "the secret reaches the sink in full — no detector runs here");
  assert.equal(after.redactedValues - before.redactedValues, 0, "and nothing is reported as removed");

  // The CONTROL, so the zeros above are not simply a redactor that never fires:
  // the same event shape under a sensitive KEY NAME does move the counter.
  const beforeControl = getDebugSignals();
  debugLog("test", "error", "msg", () => ({ apiKey: ENGINE_DETECTABLE, note: "WITNESS-O2" }));
  const controlCtx = sink.events[1]!.context;
  const afterControl = getDebugSignals();
  assert.equal(controlCtx.note, "WITNESS-O2", "witness: reading the control's context");
  assert.equal(controlCtx.apiKey, "[REDACTED]");
  assert.equal(afterControl.redactedValues - beforeControl.redactedValues, 1, "the layer does fire — for key names, and only for key names");

  resetDebugSystem();
});
