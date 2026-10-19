/**
 * STRUCTURAL SCOPES FOR SOURCE ASSERTIONS — this suite's door to the shared
 * owner, which is `integration/src/shared/source-structure.ts`.
 *
 * The matcher itself is agnostic: "what is inside this function / this CSS rule
 * / this element" depends on nothing about either product, so it has ONE
 * implementation and both repositories' guards consume it. It is re-exported
 * here because `tests/helpers/` is this suite's single owner of shared test
 * primitives (`test-helpers-dedup.test.ts` enforces that), so a test importing
 * it keeps the same one door as every other helper.
 *
 * What it replaces, and why: a guard that wants to say "`runGitConfined` goes
 * through `gitText`" was saying it with a 600-byte window, and the NEXT
 * function's `return gitText(` sat 584 bytes away — so with `runGitConfined`'s
 * body replaced by a raw unconfined spawn, the assertion still passed. See the
 * owner's own documentation for the full ladder.
 *
 * NOTHING HERE TAKES A PATTERN. The owner used to export `bodyMatches`, which
 * accepted a `RegExp` and put a detector in front of it to decide whether the
 * pattern bounded a distance. That detector was rewritten twice and holed
 * twice, because deciding "is this atom a wildcard" needs a probe alphabet and
 * an alphabet is a list. The door is gone: every question below is asked with
 * NAMES, so a window cannot be written INTO A DOOR.
 *
 * It can still be written one step out. `SourceScope.body` is a public string,
 * so `expect(functionBody(src, "f").body).toMatch(/a[\s\S]{0,600}b/)` compiles
 * and runs — bounded by the construct, which is a real improvement, and not the
 * same as the class being gone. The estate scan below the owner is what watches
 * for that, and the rung-3 rule that would end it is a recorded task.
 *
 * `windowGapIn` / `windowedPatternsIn` / `regexLiteralsIn` are the estate
 * SCAN's instruments, not doors. They exist because nothing above them can
 * reach a test that never imports this file and writes its own
 * `expect(wholeFile).toMatch(…)`.
 */
export {
  attributeOf,
  bindingValueOf,
  bodyBinds,
  bodyCalls,
  bodyCallsWith,
  bodyReturns,
  bodySays,
  callArgumentsOf,
  cssDeclares,
  cssRule,
  elementWithAttribute,
  enclosingFunctionOf,
  exportedBindings,
  exportedFunctionParameters,
  functionArgumentsOf,
  functionBodies,
  functionBody,
  functionsCalling,
  isSourceScope,
  objectLiteralsWith,
  patternGapIn,
  regexLiteralsIn,
  sliceWindowsIn,
  windowedPatternsIn,
  windowGapIn,
  type ExportedBinding,
  type PatternGap,
  type SliceWindow,
  type SourceScope,
} from "../../engine/src/shared/source-structure.ts";
