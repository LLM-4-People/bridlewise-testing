/**
 * EVERY DECLARED TEST GLOB — the one declaration, in a module with no weight.
 *
 * ── WHY IT LIVES HERE AND NOT IN `vite.config.ts` ────────────────────────
 *
 * It was declared in `vite.config.ts` and exported from there, for exactly the
 * right reason, in that file's own words:
 *
 *   > EXPORTED for that same reason, not as a convenience. A guard whose
 *   > subject is "every file the runner selects" must read THIS binding,
 *   > because `include` below is this binding spread — so there is no spelling
 *   > of the entry set that can be right here and wrong there.
 *
 * And then the guard that counts the suite's population **could not import
 * it**, because importing `vite.config.ts` pulls in the svelte plugin and the
 * cross-repository liveness check. So it re-parsed the config's own SOURCE
 * with a regular expression instead — a copy, arrived at by exactly the route
 * the comment above forbids. That copy has already been wrong twice: once it
 * matched `deps.optimizer.ssr.include` and counted 452 files for a 451-file
 * suite, and once it required the array to be spelled immediately after
 * `include:` and found ZERO when the globs were lifted into this constant.
 *
 * A leaf module with no imports removes the reason for the copy. `vite.config`
 * spreads it into `include`, every guard imports it, and the population is the
 * value the runner receives rather than a re-reading of the file that declares
 * it.
 *
 * `tests/prevention/web-ui-runtime-budget.test.ts` still reads the config's
 * text — but now to assert that the runner is handed THIS binding, which is
 * the one claim the source is the right subject for.
 */
export const TEST_INCLUDE: readonly string[] = [
  // (tests/component/ left with the old component tree at the cutover —
  // a glob for it would be dead, and glob liveness refuses dead globs.)
  "tests/unit/**/*.test.ts",
  "tests/prevention/**/*.test.ts",
  // Cockpit surface tests + cockpit-native guards live in their own tree.
  // The Playwright half lives in tests/cockpit/e2e/*.spec.ts (not matched
  // here — vitest owns *.test.ts).
  "tests/cockpit/**/*.test.ts",
  // Performance regression gate: reads the Playwright profile report +
  // fails if any measured metric degrades past its budget (an absent or
  // stale report is a red, not a skip).
  "tests/performance/**/*.test.ts",
];
