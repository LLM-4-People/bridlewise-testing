// @vitest-environment node
/**
 * THE STANDING LIVENESS STREAM — wired, bounded, and able to be shut down.
 *
 * The page does not ask whether the API is there; it holds one socket open
 * and listens. That replaced a 1s `/api/health` poll, and the reasons are
 * measured rather than aesthetic (browser-measured throughout this file):
 *
 *   idle cost   poll: 60 requests/min/tab on a page that is otherwise silent
 *               (zero fetches in twelve seconds without it).
 *               stream: ZERO requests in twenty seconds.
 *   detection   poll: 4,471ms at a 5s interval, 569ms at 1s — bounded by the
 *               interval and nothing else.
 *               stream: 22ms.
 *   recovery    stream: 104ms from the socket listening to the block clearing.
 *
 * FOUR THINGS CAN SILENTLY UNDO IT, and each has a test below:
 *
 *  1. AN ENTRY STOPS OPENING IT. Detection-on-use would still work, so
 *     nothing would look broken until an API died under an idle tab — the
 *     exact case the stream exists for.
 *  2. THE BEAT CADENCES DRIFT. The client's silence watchdog measures against
 *     a mirror of the server's keepalive. If they diverge the watchdog is
 *     either deaf or trigger-happy, and a trigger-happy one reports outages
 *     that are not happening.
 *  3. SHUTDOWN STOPS ENDING STREAMS. `server.close()` waits for established
 *     connections and an SSE stream never ends on its own, so the process
 *     survives SIGTERM holding sockets with no listener. This is not
 *     hypothetical: TWO ORPHANED SERVERS were produced this way in one
 *     session, and `kill` on them did nothing whatsoever.
 *  4. THE STREAM GROWS A PAYLOAD. The moment it carries something a surface
 *     renders, a reconnect becomes a data event and the connection state
 *     stops being a fact about the connection.
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

import {
  LIVE_STREAM_MISSED_BEATS,
  LIVE_STREAM_PATH,
  LIVE_STREAM_REFUSED_RETRY_MS,
  LIVE_STREAM_RETRY_MS,
  SSE_EVENT_TYPES,
} from "../../shared/constants.ts";
import { LIVENESS_BEAT_MS } from "../../src/client-config.ts";
import { DEFAULT_SSE_KEEPALIVE_MS, resolveServerConfig } from "../../server/kernel/config.ts";
import { PUBLIC_PATH_PREFIXES } from "../../server/routes/registry.ts";

import { modulePath, modulePathMatching } from "../helpers/module-resolver.ts";
const read = (p: string): string => readFileSync(p, "utf8");

// The application entry that HOLDS the socket. `src/main.ts` is a thin
// synchronous stub that dynamically imports the cockpit entry and calls
// `bootCockpit` — it deliberately wires nothing itself, so the watch has
// exactly one owner and an idle page still notices the API going away.
const ENTRIES = [modulePathMatching("src/cockpit/main.ts")] as const;

/**
 * The body of `function shutdown()`, comments stripped — so ordering
 * assertions read CODE and never the prose that describes it. Exported shape
 * kept simple on purpose: it is used by the ordering test and by its own
 * mutation self-check below.
 */
export function shutdownBody(src: string): string {
  const at = src.indexOf("function shutdown()");
  if (at < 0) return "";
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        return src
          .slice(open + 1, i)
          .split("\n")
          .filter((l) => !l.trim().startsWith("//"))
          .join("\n");
      }
    }
  }
  return "";
}

describe("1. the stream is opened by every application entry", () => {
  for (const entry of ENTRIES) {
    test(`${entry} starts the liveness watch`, () => {
      const src = read(entry);
      expect(src).toContain("startLivenessWatch");
      expect(src).toContain("openLivenessStream");
    });

    test(`${entry} hands over the DIAGNOSIS as well as the opener`, () => {
      // The watch cannot choose a retry cadence without knowing WHY the
      // stream would not open, and the two causes it must separate —
      // "nothing answered" and "the server refused us" — are indistinguishable
      // from an EventSource `error`. `LivenessPort` makes forgetting it a type
      // error; this records the rule where a reader will look for it.
      expect(read(entry)).toContain("diagnoseLivenessConnection");
    });
  }

  test("the beat cadence is the connection owner's own default, not an entry's job", () => {
    // It WAS entry-wired, and that was wrong twice: it added a second thing
    // for an entry to forget, and it made the cockpit entry import
    // `client-config.ts`, which the cockpit import law does not allow. The
    // owner defaults it; entries pass only the opener.
    const conn = read(modulePath("connection.ts"));
    expect(conn).toMatch(/let livenessBeatMs: number \| null = LIVENESS_BEAT_MS;/);
    for (const entry of ENTRIES) {
      expect(read(entry), entry).not.toContain("setLivenessBeatMs");
    }
  });

  test("the opener lives in the single EventSource owner", () => {
    // tests/prevention/client-api-owner.test.ts enforces that `new
    // EventSource(` appears only in src/client.ts. The entry wires the two
    // together; connection.ts must NOT reach for it directly, or that
    // ownership is broken and a cycle is created besides.
    expect(read(modulePathMatching("src/client.ts"))).toContain("export function openLivenessStream");
    // The CALL, not the phrase: this file's own prose names the constructor
    // when explaining who owns it, and a guard that trips on its own
    // documentation is a guard that gets deleted.
    expect(read(modulePath("connection.ts"))).not.toMatch(/new\s+EventSource\(/);
  });
});

describe("2. the two cadences cannot drift", () => {
  test("the client's beat mirror equals the server's keepalive default", () => {
    expect(LIVENESS_BEAT_MS).toBe(DEFAULT_SSE_KEEPALIVE_MS);
  });

  test("the silence threshold is several beats, not one", () => {
    // One late beat is not evidence. This codebase measures healthy-but-busy
    // stalls in seconds — §1 L1's 8,009ms scan, and a `/api/health` measured
    // at 7,358ms in the browser that still returned 200 — so a one-beat
    // threshold would report those as outages.
    expect(LIVE_STREAM_MISSED_BEATS).toBeGreaterThan(1);
  });

  test("the reconnect cadence is well under a second", () => {
    // It bounds BOTH recovery and (for a gracefully-stopped server) detection:
    // a clean end-of-stream makes the browser wait exactly this long before
    // discovering the server is gone. Measured at 1s: 1,603ms detection. At
    // 250ms: 22ms detection, 104ms recovery.
    expect(LIVE_STREAM_RETRY_MS).toBeLessThanOrEqual(500);
    expect(LIVE_STREAM_RETRY_MS).toBeGreaterThan(0);
  });
});

describe("3. the server can still be shut down", () => {
  const sse = read(modulePathMatching("server/router/sse.ts"));
  const index = read(modulePathMatching("server/index.ts"));

  test("open streams are tracked", () => {
    expect(sse).toContain("openStreams");
    expect(sse).toContain("export function closeAllSseStreams");
  });

  test("a closing stream removes itself from the registry", () => {
    // Otherwise the set grows without bound across reconnects — and this
    // stream is designed to reconnect often.
    expect(sse).toContain("openStreams.delete(close)");
  });

  test("the shutdown handler ends the streams BEFORE closing the server", () => {
    // Scoped to the FUNCTION BODY. Searching the whole file found the phrase
    // `server.close()` inside the comment that explains why closing alone is
    // not enough — a scanner that reads prose as code proves nothing.
    const body = shutdownBody(index);
    const closeAll = body.indexOf("closeAllSseStreams()");
    const serverClose = body.indexOf("server.close(");
    expect(closeAll, "closeAllSseStreams() is not in shutdown()").toBeGreaterThan(-1);
    expect(serverClose, "server.close( is not in shutdown()").toBeGreaterThan(-1);
    expect(closeAll).toBeLessThan(serverClose);
  });

  test("shutdown cannot hang: there is a forced exit", () => {
    // The defect being fixed is a shutdown that never completes. A fix that
    // can itself never complete is not a fix.
    expect(index).toContain("DEFAULT_SHUTDOWN_GRACE_MS");
    // The exit is a guarded event-loop callback (SCALE-CR1 C3), named once.
    expect(index).toContain('const exit = guarded("server.shutdown.exit", () => process.exit(0));');
    expect(index).toMatch(/setTimeout\(exit, DEFAULT_SHUTDOWN_GRACE_MS\)\.unref\(\)/);
  });

  test("both signals use it", () => {
    // Through the event-loop door (SCALE-CR1 C3): the guarded shutdown.
    expect(index).toContain('const onShutdownSignal = guarded("server.shutdown", shutdown);');
    expect(index).toContain('process.on("SIGTERM", onShutdownSignal)');
    expect(index).toContain('process.on("SIGINT", onShutdownSignal)');
  });
});

describe("4. the stream stays a liveness signal and nothing else", () => {
  const route = read(modulePath("live.ts"));

  test("it is public — 'is the server there' needs no session", () => {
    expect(PUBLIC_PATH_PREFIXES).toContain(LIVE_STREAM_PATH);
  });

  test("it sends only the beat", () => {
    const sent = [...route.matchAll(/SSE_EVENT_TYPES\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(sent)).toEqual(new Set(["ping"]));
  });

  test("the beat carries no payload", () => {
    // Its ARRIVAL is the signal. A field here is a field a surface will
    // eventually render.
    expect(route).toContain(`stream.send(SSE_EVENT_TYPES.${SSE_EVENT_TYPES.ping}, {})`);
  });

  /**
   * ── THIS ASSERTION USED TO SAY "it is capped like every other stream" ─────
   *
   * It is recorded rather than quietly replaced, because that guard PINNED A
   * DEFECT IN PLACE and the next reader would otherwise "restore" it.
   *
   * What it asserted was true and was the problem. `/api/live` is a STANDING
   * connection carrying `retry: LIVE_STREAM_RETRY_MS` (250ms). Capped like
   * every other stream meant capped out of the RUN budget (8), so eight
   * streams of any kind for one identity refused every liveness reconnect
   * with 429 — and the browser, obeying the cadence the server itself wrote,
   * asked again four times a second, forever. A refusal cannot be cured by
   * retrying, so the page never recovered; restarting the API was the only
   * cure, and opening a few tabs recreated it. Browser-observed, with the
   * cockpit blocked behind "The harness API is not answering" over a server
   * that answered every request put to it.
   *
   * Three windows plus one slot not yet released was enough. Several browser
   * windows and several in-page workspaces is the NORMAL case for this
   * product — a deliberate feature decision, not abuse.
   *
   * THE RULE THAT REPLACES IT: capped, always — an uncapped public long-lived
   * route is a file-descriptor exhaustion primitive and that has not changed —
   * but on its OWN budget, sized for multi-tab use. The stream whose entire
   * job is detecting outages may not be the first casualty of load; an
   * instrument that fails exactly when it is needed and then reports "offline"
   * for a healthy server is worse than no instrument.
   */
  test("it is capped — a public long-lived route may not be an exhaustion primitive", () => {
    // `{ req, db }` is what applies the per-identity SSE connection limit in
    // server/sse.ts. Unchanged, and still the point: the budget moved, the
    // bound did not go away.
    expect(route).toMatch(/openSseStream\(\s*ctx\.res\s*,\s*\{[^}]*req:\s*ctx\.req[^}]*db,/s);
  });

  test("…but on its OWN budget, not the run streams'", () => {
    // The route must NAME the liveness class. Taking the default would put it
    // back in the run budget, which is the defect exactly.
    expect(route).toMatch(/connectionClass:\s*SSE_CONNECTION_CLASSES\.liveness/);
  });

  test("that budget is larger than the run budget, and sized for tabs", () => {
    // One liveness socket per TAB (the client holds exactly one per page), so
    // the number is a tab count. It must be past what a person opens, and it
    // must never be the scarcer of the two — a detector that runs out before
    // the streams it observes reports outages that are not happening.
    const cfg = resolveServerConfig({});
    expect(cfg.sseMaxLivenessConnectionsPerUser).toBeGreaterThan(cfg.sseMaxConnectionsPerUser);
    expect(cfg.sseMaxLivenessConnectionsPerUser).toBeGreaterThanOrEqual(16);
  });

  test("a refusal is answered by BACKING OFF, and an outage is not", () => {
    // The other half of the same defect: 250ms is right for an outage (it is
    // what makes recovery feel instant — measured 104ms) and wrong for a
    // refusal, where retrying immediately cannot succeed and is what makes the
    // exhaustion permanent. Two constants, two causes, and the connection
    // owner picks between them from a MEASURED diagnosis.
    expect(LIVE_STREAM_REFUSED_RETRY_MS).toBeGreaterThan(LIVE_STREAM_RETRY_MS);
    const conn = read(modulePath("connection.ts"));
    expect(conn).toContain("scheduleDiagnosis(d.retryAfterMs)");
    expect(conn).toContain("scheduleDiagnosis(LIVE_STREAM_RETRY_MS)");
  });

  test("it beats immediately, before arming its interval", () => {
    const firstSend = route.indexOf("stream.send(");
    const interval = route.indexOf("setInterval(");
    expect(firstSend).toBeGreaterThan(-1);
    expect(interval).toBeGreaterThan(-1);
    expect(firstSend).toBeLessThan(interval);
  });

  test("its interval is cleared when the response closes", () => {
    expect(route).toContain("clearInterval(beat)");
    expect(route).toMatch(/ctx\.res\.on\("close"/);
  });
});

describe("5. a browser that gave up for good is noticed", () => {
  const client = read(modulePathMatching("src/client.ts"));
  const conn = read(modulePath("connection.ts"));

  test("the opener reports whether the BROWSER is still retrying", () => {
    // EventSource reconnects itself after a network error, but the spec tells
    // it to fail PERMANENTLY on a non-2xx or a wrong content type — which is
    // precisely what the Vite dev proxy sends while the API is down (`502
    // text/plain`). Browser-measured before this existed: the block appeared
    // in 33ms and then NEVER cleared.
    expect(client).toContain("es.readyState === EventSource.CONNECTING");
    expect(client).toMatch(/handlers\.onDown\(\{\s*retrying:/);
  });

  test("the watcher acts only when the browser has stopped", () => {
    // Re-opening while the browser is mid-retry would run two sockets side by
    // side against the same endpoint, so `retrying` returns without touching
    // the reconnect path — it only states the outage.
    //
    // (This assertion used to read `if (!retrying) scheduleReopen();`. The
    // rule is unchanged; what changed is that the other branch no longer
    // schedules a blind re-open — it asks the server WHY first, because the
    // permanent-close branch carries both "the API is down" and "the API
    // refused us" and they need opposite cadences.)
    expect(conn).toMatch(/if \(retrying\) \{\s*\n\s*noteNotReached\("refused", 0\);\s*\n\s*return;/);
    expect(conn).toContain("diagnoseNow();");
  });
});

/**
 * ── MUTATION SELF-CHECKS ───────────────────────────────────────────────────
 * Each re-derives the defect in-file and shows which assertion above catches
 * it, so the guard is demonstrably load-bearing rather than merely present.
 */
describe("mutation: the liveness guards fail when the rule is removed", () => {
  test("an entry that stops opening the stream", () => {
    const mutated = `import { mount } from "svelte";\nexport function bootCockpit(t) { mount(Cockpit, { target: t }); }`;
    expect(mutated).not.toContain("startLivenessWatch");
    for (const entry of ENTRIES) expect(read(entry)).toContain("startLivenessWatch");
  });

  test("cadences drifting apart", () => {
    const drifted = DEFAULT_SSE_KEEPALIVE_MS * 2;
    expect(LIVENESS_BEAT_MS).not.toBe(drifted);
    expect(LIVENESS_BEAT_MS).toBe(DEFAULT_SSE_KEEPALIVE_MS);
  });

  test("a one-beat silence threshold", () => {
    expect(LIVE_STREAM_MISSED_BEATS).not.toBe(1);
  });

  test("shutdown that closes the server without ending the streams", () => {
    // The exact shape that WAS there, and that produced two orphaned servers
    // SIGTERM could not touch. Run through the same extractor the real test
    // uses, so the extractor is shown to catch it rather than assumed to.
    const mutated = `function shutdown(): void {\n  server.close(() => process.exit(0));\n}`;
    const body = shutdownBody(mutated);
    expect(body).toContain("server.close(");
    expect(body).not.toContain("closeAllSseStreams()");
    expect(shutdownBody(read(modulePathMatching("server/index.ts")))).toContain("closeAllSseStreams()");
  });

  test("the extractor reads code, not the comment that describes it", () => {
    // The failure this replaces: searching the whole file matched
    // `server.close()` inside the explanatory comment ABOVE the function and
    // reported the ordering backwards.
    const withProse = `// server.close() alone is not enough\nfunction shutdown(): void {\n  // closeAllSseStreams() is mentioned here\n  closeAllSseStreams();\n  server.close(() => process.exit(0));\n}`;
    const body = shutdownBody(withProse);
    expect(body.indexOf("closeAllSseStreams()")).toBeLessThan(body.indexOf("server.close("));
  });

  test("a payload creeping onto the beat", () => {
    const mutated = `stream.send(SSE_EVENT_TYPES.ping, { uptimeMs: process.uptime() });`;
    expect(mutated).not.toContain("ping, {})");
    expect(read(modulePath("live.ts"))).toContain("SSE_EVENT_TYPES.ping, {})");
  });

  test("the liveness stream put back on the run budget", () => {
    // The exact shape that WAS there — the call that made the outage detector
    // compete with the runs it observes. It is the DEFAULT, which is why the
    // route has to say the class out loud: a tidier who removes the "extra"
    // option re-creates the defect and this is what stops them.
    const mutated = `await openSseStream(ctx.res, { req: ctx.req, db, retryMs: LIVE_STREAM_RETRY_MS });`;
    expect(mutated).not.toMatch(/connectionClass:\s*SSE_CONNECTION_CLASSES\.liveness/);
    expect(read(modulePath("live.ts"))).toMatch(
      /connectionClass:\s*SSE_CONNECTION_CLASSES\.liveness/,
    );
  });

  test("a refusal retried at the outage cadence", () => {
    // The client half of the same loop: one cadence for both causes. Shown as
    // source because the behaviour itself is held by
    // tests/cockpit/connection-owner.test.ts — this only pins that the two
    // branches still exist and are still different.
    const mutated = `if (d.outcome === "refused") { scheduleDiagnosis(LIVE_STREAM_RETRY_MS); return; }`;
    expect(mutated).not.toContain("scheduleDiagnosis(d.retryAfterMs)");
    expect(read(modulePath("connection.ts"))).toContain("scheduleDiagnosis(d.retryAfterMs)");
    expect(LIVE_STREAM_REFUSED_RETRY_MS).not.toBe(LIVE_STREAM_RETRY_MS);
  });

  test("an entry that wires the socket but not the diagnosis", () => {
    const mutated = `startLivenessWatch({ open: openLivenessStream, diagnose: async () => ({ outcome: "unreached", elapsedMs: 0 }) });`;
    expect(mutated).not.toContain("diagnoseLivenessConnection");
    for (const entry of ENTRIES) expect(read(entry)).toContain("diagnoseLivenessConnection");
  });
});
