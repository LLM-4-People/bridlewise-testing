/**
 * @config-owner — THE BENCH HARNESS (its truncations and its scan bounds).
 *
 * The bench tree is production source: `no-hardcoded-truncation-slices`
 * discovers its roots dynamically, so `bench/` is covered like `src/` and
 * `server/` are, and it should be. These numbers decide what a benchmark
 * MEASURES and what it SHOWS, and a measurement harness whose bounds drift
 * between call sites reports two different situations under one name — the
 * exact failure DESIGN-PERFORMANCE §5 records twice (a fixture eating itself,
 * a growth ratio flattering its own denominator).
 *
 * Each one is a fold or a scan bound, never a silent drop: the diff printers
 * are ordered worst-first, so what falls past the cut is the tail nobody was
 * going to read, and the report file on disk always holds every row.
 *
 * They live together, in the harness's own owner, rather than in
 * `server/config.ts` — nothing here is an operator-facing runtime tunable,
 * and putting bench display bounds in the server's config would say it was.
 */

/**
 * Hex characters of the fixture's identity digest kept as its directory name.
 *
 * 16 hex chars is 64 bits — collision-free for the handful of profiles that
 * exist while staying short enough that a fixture directory can be read at a
 * glance in a path. The digest's job is to make a fixture built from
 * different parameters a DIFFERENT fixture on disk (`assertReadTargetsPristine`
 * cannot save a run that silently reused the wrong one).
 */
export const FIXTURE_ID_HEX_CHARS = 16;

/**
 * How many of a user's conversations the redaction bench scans to find its
 * "largest conversation" target.
 *
 * A scan bound, not a truncation of results: the bench needs one big payload
 * and one mid-sized one, and reading `listMessages` for every chat in a
 * `heavy` fixture (thousands) would spend more time choosing the target than
 * measuring against it.
 */
export const REDACTION_CHAT_SCAN_LIMIT = 400;

/**
 * Rows of the regression diff printed to the terminal by the DB bench
 * orchestrator (`bench/run.ts`) and by the wire suite (`bench/wire/load.ts`).
 *
 * Both are ordered worst-first, so these are the rows that could possibly
 * matter. The wire suite prints more because it covers more suites per run.
 * The full diff is always in the report JSON — nothing is lost, only unshown.
 */
export const DB_DIFF_ROWS_SHOWN = 15;
export const WIRE_DIFF_ROWS_SHOWN = 20;

/**
 * How much of an overflow response body the rate-limit phase quotes in its
 * verdict line.
 *
 * Enough to carry a JSON error envelope's `error`/`code`, short enough that a
 * server returning an HTML error page does not flood the phase's output.
 */
export const OVERFLOW_BODY_QUOTE_CHARS = 160;

/**
 * How many of the build's largest chunks the payload bench names individually.
 *
 * A display fold, not a measurement bound: `bundle.total` and
 * `bundle.criticalPath` are computed over EVERY emitted asset, and the report
 * JSON keeps every row — this only decides how many get their own line in the
 * terminal. Ordered largest-first, so what falls past the cut is the tail that
 * cannot move a total.
 *
 * IT WAS AN INLINE `12` UNTIL THE SCAN COULD SEE IT. The guard that owns this
 * rule never reported it, because the line above the call site holds a regex
 * literal containing a quote — which desynchronised the shared comment/string
 * stripper and blanked the rest of the file from every scan built on it. The
 * literal was in plain sight for as long as the lexer was blind to it.
 */
export const BUNDLE_TOP_CHUNKS_SHOWN = 12;
