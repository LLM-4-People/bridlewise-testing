/**
 * A REPRODUCTION SHIM for the web runner (`harness flake reproduce --env
 * NODE_OPTIONS=--import=./engine/test/support/flake-shim-routing-rss.ts`, the
 * FLAKE-REPRO decision): every resident-set reading of the process is
 * 245748169 bytes, a 9-digit count that passes the bank-routing check digit.
 * It recreates, on any machine and every run, what a real footprint did about
 * 3% of the time (REDACT-NUM, the browser lab's 588 of 20,000): the ledger's
 * operational redactor read the resource tick's `process.rss` value as a
 * routing number and wrote "[REDACTED:pii]" in its place. The sampler and the
 * ledger are untouched: only the number the kernel reports is fixed.
 *
 * Preloaded into every process of a reproduction run (NODE_OPTIONS reaches
 * the runner and each of its workers); never imported by a test.
 */
const ROUTING_VALID_RSS = 245748169;
const reported = process.memoryUsage.bind(process);
const memoryUsage = Object.assign(
  (): NodeJS.MemoryUsage => ({ ...reported(), rss: ROUTING_VALID_RSS }),
  { rss: (): number => ROUTING_VALID_RSS },
);
process.memoryUsage = memoryUsage;
