// @vitest-environment node
/**
 * Prevention test: NO PROBE-THEN-LISTEN — an ephemeral port is bound by the
 * process that serves on it, never probed free first.
 *
 * ── THE DEFECT CLASS ────────────────────────────────────────────────────────
 *
 * A test that needs a server on a free port and obtains one by PROBING —
 * bind a throwaway socket to 0, read the assigned number, CLOSE it, then have
 * the real server (often a spawned child, told the number through the
 * environment) listen on that number — carries a time-of-check/time-of-use
 * race. Between the probe's `close()` and the server's `bind()` the port is
 * unowned, and any concurrent process that claims it first fails the run with
 * EADDRINUSE — on a machine that had a free port all along. Observed live:
 * `async-db-orderings-through-the-server.test.ts` probed a port, closed it,
 * and had the child `listen()` on it; a concurrent claimer reddened the run
 * (`listen EADDRINUSE 127.0.0.1:45507`) and the flake entered the memory
 * ledger.
 *
 * ── THE ROOT FIX, NOT THE RETRY ─────────────────────────────────────────────
 *
 * The fix is not "retry the listen on EADDRINUSE" — that retries around the
 * race. It is to remove the window: the process that SERVES binds port 0
 * itself, so the kernel assigns a free port atomically inside the bind, and
 * the parent learns the assigned number by reading it back — from the
 * server's own readiness line (the `server on http://…:PORT` the bootstrap
 * prints) or, in-process, from `server.address().port` in the listen
 * callback. There is no probe and no window.
 *
 * ── WHAT THIS GUARD DISTINGUISHES ───────────────────────────────────────────
 *
 *   · PROBE-THEN-LISTEN (refused): a socket bound to 0, read, and CLOSED,
 *     its number handed to another listen. The close-then-rebind is the race.
 *   · BIND-0-AND-READ-BACK (safe): a server binds 0 and the SAME live
 *     server's `address().port` is read inside the listen callback — that
 *     server stays bound; nothing is closed and rebound. Every in-process
 *     helper here already has this shape.
 *
 * The universe is the COMMITTED test estate (the git index), so a transient
 * probe file a sibling writes can never enter it. The detector is two-part:
 * a "free port" helper that closes its probe socket, and an env handoff that
 * ships a pre-resolved port number to a spawned server's `listen`. Either is
 * the probe-and-race; neither may appear. A new probe-then-listen added
 * tomorrow is caught without anyone updating a list — deny by default.
 */
import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { readFileSync, statSync, writeFileSync } from "node:fs";

import { gitTrackedPaths } from "../helpers/source-scan.ts";
import { functionsCalling } from "../helpers/function-scope.ts";
import { createTempDir } from "../helpers/temp-dir.ts";

import { modulePathMatching } from "../helpers/module-resolver.ts";
/** Directories the universe scans, matched as path prefixes. */
const SCANNED_TREES = ["tests", join("engine", "test")] as const;

const SKIPPED_SEGMENTS = new Set(["node_modules", ".git", "dist", "coverage", ".vite", ".bridlewise", "fixtures"]);

/**
 * A "probe a free port" helper, detected STRUCTURALLY rather than by a
 * distance window. The discriminating signal is not that a socket is bound to
 * 0 — every safe in-process server does that — it is a helper whose WHOLE JOB
 * is to produce a bare port number for some OTHER listener to claim. Its
 * shape, all within one function's own scope (the shared `functionsCalling`
 * door enumerates them; no regex measures a gap):
 *
 *   · it binds a socket to port 0 (`.listen(0, …)`),
 *   · it reads the assigned port back (`.address()`),
 *   · it CLOSES that socket (`.close()`) — vacating the port, which is the
 *     load-bearing member of the race, and
 *   · it RETURNS the bare port number: the signature is `Promise<number>` and
 *     the body returns a lone identifier, never the server or a URL.
 *
 * An in-process server that binds 0, serves, and closes only in teardown
 * returns the server or a URL (or nothing) and is declared to — so it never
 * takes this shape, and the safe helpers here stay green.
 */
function probeHelpersIn(source: string): string[] {
  const out: string[] = [];
  for (const scope of functionsCalling(source, "createServer", "test estate")) {
    const body = scope.body;
    if (!/\.listen\(\s*0\b/.test(body)) continue;
    if (!/\.address\(\)/.test(body)) continue;
    if (!/\.close\(/.test(body)) continue;
    const name = scope.name.replace(/\$/g, "\\$");
    const declaredNumber = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*:\\s*Promise\\s*<\\s*number\\s*>`).test(source);
    const returnsBarePort = /return\s+[A-Za-z_$][\w$]*\s*;/.test(body) && !/return\s*\{/.test(body) && !/return\s+(?:server|baseUrl|this)\b/.test(body);
    if (declaredNumber && returnsBarePort) out.push(scope.name);
  }
  return out;
}

/**
 * An env handoff of a pre-resolved port: a spawned server's port is carried
 * by `HARNESS_WEB_PORT: String(<something>)`. The `<something>` is the whole
 * question — a parent that PROBED the number hands over a value chosen before
 * the child bound (the race); a parent that read the number BACK from the
 * child's own readiness line hands over a value the kernel already assigned
 * inside the bind (no window). The two are told apart by the presence of the
 * read-back helper (`readPortFromReadiness`) in the same source: a handoff
 * that co-occurs with a readiness-line read is the safe shape; one with no
 * read-back is a probe. The literal `"0"` child bind never matches this
 * pattern at all.
 */
const ENV_PORT_HANDOFF = /HARNESS_WEB_PORT\s*:\s*String\(/;

/** The readiness-line read-back that makes a `String(port)` handoff safe. */
const READ_BACK_MARKER = /readPortFromReadiness/;

function isTestSource(path: string): boolean {
  return /\.(ts|mts|cts|js|mjs|cjs)$/.test(path);
}

/** Every committed source file under the scanned test trees. */
function scannedTestFiles(): string[] {
  const tracked = gitTrackedPaths(".");
  const out: string[] = [];
  for (const tree of SCANNED_TREES) {
    // A missing scan root is not an empty one — a scan with no universe
    // reports "clean" for nothing that was looked at.
    expect(statSync(tree).isDirectory(), `${tree} must be a directory`).toBe(true);
    const prefix = `${tree}/`;
    for (const path of tracked) {
      if (!path.startsWith(prefix)) continue;
      if (!isTestSource(path)) continue;
      if (path.split("/").some((segment) => SKIPPED_SEGMENTS.has(segment))) continue;
      out.push(path);
    }
  }
  return out;
}

/** The verdict for one source file: racy probe, env handoff, or clean. */
function judgeSource(source: string): Readonly<{ freePortProbe: boolean; envHandoff: boolean }> {
  // A String(port) handoff is only a violation when the port was NOT read
  // back from a readiness line — a `readPortFromReadiness` call in the same
  // source is the proof the number is the kernel's assignment, not a probe.
  const handoffWithoutReadBack = ENV_PORT_HANDOFF.test(source) && !READ_BACK_MARKER.test(source);
  return {
    freePortProbe: probeHelpersIn(source).length > 0,
    envHandoff: handoffWithoutReadBack,
  };
}

describe("no probe-then-listen — an ephemeral port is bound by its server, not probed free", () => {
  test("the detector fires on the planted probe shape and stays silent on the safe bind-0 shape", () => {
    // The planted probe: bind 0, read the number, close, hand the number to a
    // later listener. Both detectors must fire on exactly this.
    const plantedProbe = [
      `async function freePort(): Promise<number> {`,
      `  const srv = createServer();`,
      `  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));`,
      `  const port = (srv.address() as { port: number }).port;`,
      `  await new Promise<void>((r) => srv.close(() => r()));`,
      `  return port;`,
      `}`,
      `const port = await freePort();`,
      `spawn("node", [modulePathMatching("server/index.ts")], { env: { HARNESS_WEB_PORT: String(port) } });`,
    ].join("\n");
    const verdict = judgeSource(plantedProbe);
    expect(verdict.freePortProbe, "the probe helper (bind 0 → read → close) was not detected").toBe(true);
    expect(verdict.envHandoff, "the env handoff of a pre-resolved port was not detected").toBe(true);

    // The safe shape must NOT trip either detector: bind 0 on the server that
    // stays bound, read its live port in the callback, and pass the literal
    // "0" to a child (never a String(<probed>) number).
    const safe = [
      `server.listen(0, "127.0.0.1", () => {`,
      `  const addr = server.address();`,
      `  baseUrl = "http://127.0.0.1:" + (addr as { port: number }).port;`,
      `});`,
      `spawn("node", [modulePathMatching("server/index.ts")], { env: { HARNESS_WEB_PORT: "0" } });`,
    ].join("\n");
    const safeVerdict = judgeSource(safe);
    expect(safeVerdict.freePortProbe, "the safe bind-0-and-read-back was misread as a probe").toBe(false);
    expect(safeVerdict.envHandoff, "a literal-\"0\" child bind was misread as an env handoff").toBe(false);

    // The read-back handoff: a String(port) whose port came from the child's
    // own readiness line (the `readPortFromReadiness` call) is the safe shape
    // and must NOT be indicted — only a String(port) with NO read-back is.
    const readBackHandoff = [
      `const apiPort = await readPortFromReadiness(api, "api", /server on http:(\\d+)/);`,
      `spawn("npx", ["vite", "--port", "0"], { env: { HARNESS_WEB_PORT: String(apiPort) } });`,
    ].join("\n");
    expect(
      judgeSource(readBackHandoff).envHandoff,
      "a port read back from the child's readiness line was misread as a probed handoff",
    ).toBe(false);
  });

  test("the committed test estate contains no probe-then-listen and no env port handoff", () => {
    const files = scannedTestFiles();
    expect(files.length, "the test-estate universe is empty — a scan with no universe passes vacuously").toBeGreaterThan(0);
    const probes: string[] = [];
    const handoffs: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const verdict = judgeSource(source);
      // This guard's own source names the shapes it scans for; it is the one
      // file whose matches are its definition, not a violation.
      if (file.endsWith("no-port-probe-then-listen.test.ts")) continue;
      if (verdict.freePortProbe) probes.push(file);
      if (verdict.envHandoff) handoffs.push(file);
    }
    expect(
      probes,
      "probe-then-listen helpers (bind 0 → read → close, then rebind) found — " +
        "bind the serving socket to 0 and read its live port back instead:\n" + probes.join("\n"),
    ).toEqual([]);
    expect(
      handoffs,
      "a spawned server's port was pre-resolved by its parent and handed over through " +
        "HARNESS_WEB_PORT: String(…) — bind the child to the literal \"0\" and parse the assigned " +
        "port from its readiness line instead:\n" + handoffs.join("\n"),
    ).toEqual([]);
  });

  test("mutation — a planted probe-then-listen file in the estate is caught", () => {
    // Drive the estate judgement over a planted probe file, supplied from
    // outside the committed universe, to prove the scan reds on a NEW probe.
    const dir = createTempDir("probe-plant-");
    const plantPath = join(dir, "planted-probe.test.ts");
    writeFileSync(
      plantPath,
      [
        `import { createServer } from "node:http";`,
        `async function pickPort(): Promise<number> {`,
        `  const s = createServer();`,
        `  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));`,
        `  const p = (s.address() as { port: number }).port;`,
        `  await new Promise<void>((r) => s.close(() => r()));`,
        `  return p;`,
        `}`,
        `export { pickPort };`,
      ].join("\n"),
    );
    const planted = readFileSync(plantPath, "utf8");
    const verdict = judgeSource(planted);
    expect(
      verdict.freePortProbe,
      "the planted probe-then-listen helper was not indicted — the guard is blind to the class",
    ).toBe(true);
  });
});
