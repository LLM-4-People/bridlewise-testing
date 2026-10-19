/**
 * THE VERDICT MOVED; THE DOOR STAYED.
 *
 * The runtime budget's decision logic — summary judgment, the three run-cost
 * gates, the one-run CPU decision, population drift — was HOISTED to
 * `integration/src/shared/budget-verdict.ts`, because the integration suite
 * grew the same gate and two verdicts for one question drift (finding #95's
 * fix is that both suites consume ONE owner). The module is pure (zero
 * imports, data in / verdict out), which is what made the hoist a move
 * rather than a rewrite; this file is the re-exporting shim that keeps every
 * web consumer's import path stable, on the same cross-repository precedent
 * as `secret-signals` (web imports integration/src by relative path).
 *
 * Do not add logic here: a second body behind this path would be exactly the
 * two-owners drift the hoist exists to end.
 */
export * from "../../engine/src/shared/budget-verdict.ts";
