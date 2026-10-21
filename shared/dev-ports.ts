/**
 * THE DEV WORKFLOW'S TWO PORTS, DECLARED ONCE.
 *
 * `vite.config.ts` needs the API port for its proxy target, the API server
 * needs it as its listen default, and the test floor's freshness preflight
 * needs both listeners. Before this module each site restated the literals
 * (5173/5174), so moving the dev server silently left one of them checking a
 * port nobody listened on — a preflight that finds nothing and judges nothing.
 *
 * The API's own config owner still parses `HARNESS_WEB_PORT` (and refuses a
 * malformed value); this module only names the defaults and the coercion the
 * Vite config uses BEFORE the server config module is loaded.
 */

/** The Vite dev server's client port (`vite.config.ts` `server.port`). */
export const DEV_CLIENT_PORT = 5173;

/** The API's listen port when `HARNESS_WEB_PORT` says nothing. */
export const DEV_API_PORT = 5174;

/**
 * The API port Vite proxies to. `HARNESS_WEB_PORT` is the same knob the
 * server reads; an unparseable or out-of-range value falls back to the
 * declared default here because Vite cannot surface the server's own
 * refusal — and a NaN proxy target is worse than a default.
 */
export function devApiPortFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): number {
  const raw = env["HARNESS_WEB_PORT"];
  if (raw === undefined || raw === "") return DEV_API_PORT;
  const port = Number(raw);
  return Number.isInteger(port) && port >= 0 && port <= 65_535 ? port : DEV_API_PORT;
}
