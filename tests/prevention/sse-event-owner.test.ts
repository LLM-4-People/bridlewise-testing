// @vitest-environment node
/**
 * Mechanical enforcement: SSE event owner (Single-Party-Owner ).
 *
 * ("Single-Party-Owner Principle" + "Deny-by-
 * Default" + "No Scattered Helpers"): SSE event formatting/dispatch must
 * have ONE owner. ALL SSE events go through a single event formatter —
 * no route constructs SSE events ad-hoc. Event types are defined in ONE
 * place; the stream itself owns event formatting (lowest-level
 * enforcement); the route calls `stream.send(type, data)` and the stream
 * formats it.
 *
 * Before the stream (`server/sse.ts` → `openSseStream`) already
 * owned formatting (good), BUT the event TYPE NAMES were scattered as
 * string literals across `server/routes/run.ts` (13 distinct literals)
 * AND `src/client.ts` (mirrored literals) with NO shared contract. A
 * new server event without a client listener (or a typo like
 * `"conected"`) silently broke the wire with no compile-time or runtime
 * signal. The `send` function accepted ANY string (no deny-by-default).
 *
 * fix: `shared/constants.ts` is the SINGLE owner of the SSE
 * event-type registry (`SSE_EVENT_TYPES` + `SseEventType` +
 * `isKnownSseEventType`). Both the server stream + the client parser
 * import from it. The `send` signature takes `SseEventType` (compile-
 * time deny-by-default) + a runtime guard (defense-in-depth).
 *
 * This test pins the architecture across 7 assurance classes:
 * A. single-owner (formatting) — `openSseStream` defined ONLY in
 * `sse.ts`; no route constructs raw SSE text.
 * B. single-owner (event types) — `SSE_EVENT_TYPES` defined ONLY in
 * `shared/constants.ts`; no scattered event-type const.
 * C. typed send — `send` takes `SseEventType`; the stream imports the
 * guard.
 * D. server uses the owner — every `stream.send(...)` in run.ts uses a
 * registered event type (dynamic discovery — no hardcoded list).
 * E. client uses the owner — every SSE listener (`es.addEventListener`)
 * in client.ts uses a registered event type (dynamic discovery). DOM
 * lifetime listeners (window "focus" / document "visibilitychange" —
 * UIE-052's record check, the liveness watch) are platform events
 * outside the wire contract and are audited by the scope arm below.
 * F. contract (no drift) — server-emitted set == client-listened set
 * == owner set (a new server event without a client listener is
 * caught, and vice versa).
 * G. behavioral deny-by-default — `isKnownSseEventType` rejects an
 * unknown string; `openSseStream`'s `send` drops an unknown type
 * (never writes it to the wire).
 *
 * Dynamic discovery: the canonical event-type set is PARSED
 * from `shared/constants.ts` via regex — NEVER hardcoded in the test.
 * The server/client usage sets are PARSED from `run.ts`/`client.ts` —
 * NEVER hardcoded. A new event type added to the owner is automatically
 * covered; a new `stream.send` or `addEventListener` call is
 * automatically checked against the owner.
 *
 * Mutation-verified: reintroducing a string literal in run.ts, removing
 * the typed `send` signature, re-scattering `SSE_EVENT_TYPES` into a
 * second file, adding a server event without a client listener, or
 * removing the runtime guard each makes the relevant test FAIL.
 */
import { describe, test, expect } from "vitest";
import { join, relative, sep } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { EventEmitter } from "node:events";

import { openSseStream } from "../../server/router/sse.ts";
import { isKnownSseEventType, SSE_EVENT_TYPES } from "../../shared/constants.ts";
// The run path is five modules since the executor was split out of the GET
// handler that used to be it. Its emissions are part of the server's set.
import { runPathSource } from "../helpers/run-source.ts";
import { walkTs } from "../helpers/source-scan.ts";

const REPO_ROOT = process.cwd();
const SERVER_DIR = join(REPO_ROOT, "server");
const ROUTES_DIR = join(SERVER_DIR, "routes");
const SRC_DIR = join(REPO_ROOT, "src");
const CONTRACTS_DIR = join(REPO_ROOT, "shared");

// ── Dynamic discovery helpers ──

/** All server .ts files, recursively (domain subfolders hold source too). */
function serverFiles(): string[] {
  return walkTs(SERVER_DIR);
}

/**
 * Parse the canonical SSE event-type wire names from the owner
 * (`shared/constants.ts`). Returns the set of wire strings (the VALUES
 * of `SSE_EVENT_TYPES`). Dynamic — the test never hardcodes the
 * event-type list.
 *
 * Also returns a key→value map so the usage parsers can map
 * `SSE_EVENT_TYPES.toolResult` → `"tool_result"`.
 */
function parseOwnerEventTypes(): { wireSet: Set<string>; keyToWire: Map<string, string> } {
  const src = readFileSync(join(CONTRACTS_DIR, "constants.ts"), "utf8");
  const objStart = src.indexOf("export const SSE_EVENT_TYPES");
  expect(objStart, "SSE_EVENT_TYPES must be defined in shared/constants.ts").toBeGreaterThan(-1);
  const objEnd = src.indexOf("} as const;", objStart);
  const body = src.slice(objStart, objEnd);
  // Match `key: "wire_name",` lines.
  const re = /^\s*(\w+)\s*:\s*"([^"]+)"\s*,?$/gm;
  const keyToWire = new Map<string, string>();
  const wireSet = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    keyToWire.set(m[1]!, m[2]!);
    wireSet.add(m[2]!);
  }
  expect(wireSet.size, "should parse at least one event type from SSE_EVENT_TYPES").toBeGreaterThan(0);
  return { wireSet, keyToWire };
}

/**
 * Parse the event types USED by the server (run.ts). Handles both forms:
 * stream.send(SSE_EVENT_TYPES.model, …) → map the key to the wire name
 * stream.send("model", …) → use the literal (regression catch)
 * Returns the set of wire names actually emitted.
 */
function parseServerEmitted(keyToWire: Map<string, string>): { wires: Set<string>; leftoverLiterals: string[] } {
  // EVERY ROUTE FILE, not just run.ts. This scanner assumed the run stream
  // was the only SSE emitter, which stopped being true when the standing
  // liveness stream landed (`routes/live.ts`) — and the assumption failed
  // LOUDLY in the right direction: it reported the client listening for a
  // `ping` "the server does not emit", while the server was emitting it from
  // a file this function never opened. A drift check that reads only one
  // file can only ever verify one file.
  //
  // AND IT HAPPENED AGAIN, in the same shape, for the same reason. The run's
  // frames stopped being written into an HTTP response and started being
  // published to a per-run feed, so the executor moved OUT of this directory
  // and every event it emits — model, tool_result, context, done, and ten
  // more — vanished from this scan at once. It failed loudly again: the
  // client was reported as listening for fourteen events "the server does not
  // emit". Twice is a pattern, so the universe is now the routes directory
  // PLUS the run path, taken from its own owner rather than named here.
  const src = [
    ...readdirSync(ROUTES_DIR)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => readFileSync(join(ROUTES_DIR, f), "utf8")),
    runPathSource(),
  ].join("\n");
  const wires = new Set<string>();
  const leftoverLiterals: string[] = [];
  // Form 1: naming a registered event type AT ALL, anywhere in the scanned
  // server sources.
  //
  // THE DOOR LIST WAS THE UNIVERSE, AND THE UNIVERSE WENT STALE AGAIN. This
  // matched two spellings — `stream.send(SSE_EVENT_TYPES.k)` and
  // `publishRunFrame(runId, SSE_EVENT_TYPES.k)` — which was every emission
  // door on the day it was written. Then a third arrived: `endRunFeed(runId,
  // { event: SSE_EVENT_TYPES.cancelled, … })`, the frame a run publishes when
  // it ends without having said so. A pattern keyed to the CALL rather than
  // to the VALUE reported that frame as one the client listens for and the
  // server never sends — a manufactured drift finding, for the third time in
  // this scanner's history, in the same shape.
  //
  // So the pattern stopped enumerating doors. Naming `SSE_EVENT_TYPES.k` in
  // server source IS how an event is emitted — the stream's `send` accepts
  // nothing else (the runtime guard drops unregistered strings, and Form 2
  // below catches a literal) — so the value is the evidence and the call
  // shape is not. Verified on the tree at the time of writing: every
  // occurrence of `SSE_EVENT_TYPES.` in the scanned sources is an emission.
  const constRe = /SSE_EVENT_TYPES\.(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = constRe.exec(src)) !== null) {
    const key = m[1]!;
    const wire = keyToWire.get(key);
    expect(wire, `SSE_EVENT_TYPES.${key} must exist in the owner`).toBeDefined();
    wires.add(wire!);
  }
  // Form 2: stream.send("literal", …) — a regression (string literal
  // instead of the const). Collect for the dedicated regression test.
  const litRe = /stream\.send\("([^"]+)"/g;
  while ((m = litRe.exec(src)) !== null) {
    leftoverLiterals.push(m[1]!);
    wires.add(m[1]!);
  }
  return { wires, leftoverLiterals };
}

/**
 * Parse the event types LISTENED for by the client (client.ts) — the SSE
 * WIRE contract: the listeners registered on the EventSource (`es.`).
 * Handles:
 * es.addEventListener(SSE_EVENT_TYPES.model, …)
 * es.addEventListener("model", …) ← regression
 * window/document lifetime listeners ("focus", "visibilitychange" — the
 * focus-time record check of UIE-052, the liveness watch's visibility
 * listener) are PLATFORM events with no server counterpart; they are NOT
 * wire types and must not be parsed as such. The E arm's `wires.size > 0`
 * sanity check is the rename tripwire: if `es` were renamed, the parse
 * would find zero wire listeners and go red rather than drift silently.
 * Returns the set of wire names actually listened for.
 */
function parseClientListened(keyToWire: Map<string, string>): { wires: Set<string>; leftoverLiterals: string[] } {
  const src = readFileSync(join(SRC_DIR, "client.ts"), "utf8");
  const wires = new Set<string>();
  const leftoverLiterals: string[] = [];
  const constRe = /(?<![A-Za-z0-9_$.])es\.addEventListener\(SSE_EVENT_TYPES\.(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = constRe.exec(src)) !== null) {
    const key = m[1]!;
    const wire = keyToWire.get(key);
    expect(wire, `SSE_EVENT_TYPES.${key} must exist in the owner`).toBeDefined();
    wires.add(wire!);
  }
  const litRe = /(?<![A-Za-z0-9_$.])es\.addEventListener\("([^"]+)"/g;
  while ((m = litRe.exec(src)) !== null) {
    leftoverLiterals.push(m[1]!);
    wires.add(m[1]!);
  }
  return { wires, leftoverLiterals };
}

// ── A. single-owner (formatting) ──

describe("A. single-owner (formatting): openSseStream + raw SSE text", () => {
  test("openSseStream is defined ONLY in server/sse.ts", async () => {
    const definers: string[] = [];
    for (const f of serverFiles()) {
      const src = readFileSync(f, "utf8");
      if (/export async function openSseStream\b/.test(src)) {
        definers.push(relative(SERVER_DIR, f).split(sep).join("/"));
      }
    }
    expect(definers, "openSseStream must be defined ONLY in sse.ts (the single stream owner)").toEqual(["router/sse.ts"]);
  });

  test("no route/service constructs raw SSE text (event:/data:/text/event-stream outside sse.ts)", async () => {
    // The stream owner (sse.ts) is the ONLY file that writes the SSE wire
    // format. A route that constructs `event: foo\ndata: bar\n\n` itself
    // bypasses the single owner. Scan every server.ts file except sse.ts.
    // Comment lines (// or *) mentioning the content type are excluded —
    // only actual code that SETS the SSE header or writes the wire format
    // is an offender.
    const offenders: string[] = [];
    for (const f of serverFiles()) {
      const rel = relative(SERVER_DIR, f).split(sep).join("/");
      if (rel === "router/sse.ts") continue;
      const src = readFileSync(f, "utf8");
      for (const rawLine of src.split("\n")) {
        // Strip leading whitespace; skip comment-only lines.
        const line = rawLine.trimStart();
        if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) continue;
        // The SSE content-type header SET in code (not a comment). Only the
        // stream owner sets `text/event-stream` as a header value.
        if (/text\/event-stream/.test(line)) offenders.push(`${rel}: text/event-stream`);
        // A raw SSE event-line write outside the owner.
        if (/\.write\(\s*`event:\s/.test(line) || /\.write\(\s*"event:/.test(line)) {
          offenders.push(`${rel}: raw event: write`);
        }
      }
    }
    expect(offenders, `raw SSE text must only be constructed in sse.ts: ${offenders.join(", ")}`).toEqual([]);
  });
});

// ── B. single-owner (event types) ──

describe("B. single-owner (event types): SSE_EVENT_TYPES in ONE place", () => {
  test("SSE_EVENT_TYPES is defined ONLY in shared/constants.ts", async () => {
    const definers: string[] = [];
    // Scan shared/ + server/ + src/ for a `const SSE_EVENT_TYPES` or
    // `export const SSE_EVENT_TYPES` declaration.
    const allDirs = [CONTRACTS_DIR, SERVER_DIR, SRC_DIR];
    for (const dir of allDirs) {
      for (const f of walkTs(dir)) {
        const src = readFileSync(f, "utf8");
        if (/(?:export\s+)?const\s+SSE_EVENT_TYPES\b/.test(src)) {
          definers.push(relative(REPO_ROOT, f).split(sep).join("/"));
        }
      }
    }
    expect(definers, "SSE_EVENT_TYPES must be defined ONLY in shared/constants.ts").toEqual([
      "shared/constants.ts",
    ]);
  });

  test("no second event-type registry (SseEventType/SSE_EVENT re-declared as a const elsewhere)", async () => {
    // A parallel registry (e.g. `const SSE_EVENTS = {…}` in a route or
    // client state file) would re-introduce the drift class. Scan for a
    // typed event-name const object outside the owner.
    const offenders: string[] = [];
    for (const dir of [SERVER_DIR, SRC_DIR]) {
      for (const f of walkTs(dir)) {
        const src = readFileSync(f, "utf8");
        // A const object whose values are all event-name-ish strings +
        // named with SSE/EVENT in the identifier. Catches a re-registry.
        if (/(?:export\s+)?const\s+(?:SSE_\w*EVENT|EVENT_TYPES|SSE_EVENTS)\b/.test(src)) {
          const rel = relative(REPO_ROOT, f).split(sep).join("/");
          offenders.push(rel);
        }
      }
    }
    expect(offenders, `no parallel SSE event-type registry: ${offenders.join(", ")}`).toEqual([]);
  });
});

// ── C. typed send ──

describe("C. typed send: the stream choke point enforces the type", () => {
  test("sse.ts imports SseEventType + isKnownSseEventType from the owner", async () => {
    const src = readFileSync(join(SERVER_DIR, "router/sse.ts"), "utf8");
    expect(src).toContain("shared/constants.ts");
    expect(src).toContain("SseEventType");
    expect(src).toContain("isKnownSseEventType");
  });

  test("the SseStream.send signature takes SseEventType (not bare string)", async () => {
    const src = readFileSync(join(SERVER_DIR, "router/sse.ts"), "utf8");
    // The type declaration. The third parameter is the frame's SEQUENCE,
    // written to the wire as SSE's `id:` field — the half of resumption this
    // stream used to be missing while already telling browsers to reconnect.
    // It is optional because not every frame is part of a resumable record: a
    // stream's own open acknowledgment has no sequence, and inventing one
    // would tell a reconnecting client it had seen something it had not.
    expect(src).toMatch(
      /send:\s*\(eventName:\s*SseEventType,\s*data:\s*unknown,\s*id\?:\s*number\)\s*=>\s*void/,
    );
    // The implementation: `function send(eventName: SseEventType, …`
    expect(src).toMatch(/function send\(eventName:\s*SseEventType,/);
  });

  test("the send implementation calls isKnownSseEventType (runtime deny-by-default)", async () => {
    const src = readFileSync(join(SERVER_DIR, "router/sse.ts"), "utf8");
    expect(src).toMatch(/isKnownSseEventType\(eventName\)/);
  });
});

// ── D. server uses the owner ──

describe("D. server uses the owner (run.ts stream.send calls)", () => {
  test("every stream.send in run.ts uses a registered event type (no unregistered, no leftover literals)", async () => {
    const { wireSet, keyToWire } = parseOwnerEventTypes();
    const { wires, leftoverLiterals } = parseServerEmitted(keyToWire);
    // Every emitted wire name is in the owner's set.
    for (const w of wires) {
      expect(wireSet.has(w), `run.ts emits unregistered event type '${w}'`).toBe(true);
    }
    // No leftover string literals (regression — all calls must use the const).
    expect(leftoverLiterals, `run.ts must use SSE_EVENT_TYPES.* not string literals: ${leftoverLiterals.join(", ")}`).toEqual([]);
    // run.ts actually emits at least one event (sanity — the stream is used).
    expect(wires.size, "run.ts should emit at least one SSE event type").toBeGreaterThan(0);
  });
});

// ── E. client uses the owner ──

describe("E. client uses the owner (client.ts addEventListener calls)", () => {
  test("every addEventListener in client.ts uses a registered event type (no unregistered, no leftover literals)", async () => {
    const { wireSet, keyToWire } = parseOwnerEventTypes();
    const { wires, leftoverLiterals } = parseClientListened(keyToWire);
    for (const w of wires) {
      expect(wireSet.has(w), `client.ts listens for unregistered event type '${w}'`).toBe(true);
    }
    expect(leftoverLiterals, `client.ts must use SSE_EVENT_TYPES.* not string literals: ${leftoverLiterals.join(", ")}`).toEqual([]);
    expect(wires.size, "client.ts should listen for at least one SSE event type").toBeGreaterThan(0);
  });

  test("the wire contract covers ONLY the EventSource listeners — window/document lifetime events are not wire types", async () => {
    // client.ts registers two DOM lifetime listeners: window "focus" and
    // document "visibilitychange" (the focus-time record check of UIE-052
    // and the liveness watch). They are PLATFORM events with no server
    // counterpart — counting them as wire types would red the whole audit
    // until someone "fixed" it by registering them in SSE_EVENT_TYPES (the
    // wrong door). This arm pins the scope: if the parser is ever widened
    // back to receiver-blind matching, this goes red and forces the scope
    // decision to be re-made deliberately, not silently.
    const { keyToWire } = parseOwnerEventTypes();
    const { wires } = parseClientListened(keyToWire);
    expect(wires.has("focus"), "window 'focus' is a platform event, not an SSE wire type").toBe(false);
    expect(wires.has("visibilitychange"), "document 'visibilitychange' is a platform event, not an SSE wire type").toBe(false);
  });
});

// ── F. contract (no drift) ──

describe("F. contract: server-emitted == client-listened == owner set (no drift)", () => {
  test("every server-emitted type has a client listener (no orphan server event)", async () => {
    const { keyToWire } = parseOwnerEventTypes();
    const server = parseServerEmitted(keyToWire).wires;
    const client = parseClientListened(keyToWire).wires;
    const orphans = [...server].filter((w) => !client.has(w));
    expect(orphans, `server emits event(s) the client does not listen for (drift): ${orphans.join(", ")}`).toEqual([]);
  });

  test("every client-listened type is emitted by the server (no orphan client listener)", async () => {
    const { keyToWire } = parseOwnerEventTypes();
    const server = parseServerEmitted(keyToWire).wires;
    const client = parseClientListened(keyToWire).wires;
    const orphans = [...client].filter((w) => !server.has(w));
    expect(orphans, `client listens for event(s) the server does not emit (drift): ${orphans.join(", ")}`).toEqual([]);
  });

  test("the owner registry is non-empty + every entry is used by BOTH sides", async () => {
    const { wireSet, keyToWire } = parseOwnerEventTypes();
    const server = parseServerEmitted(keyToWire).wires;
    const client = parseClientListened(keyToWire).wires;
    // Every owner entry is used by at least one side (no dead event type).
    const dead = [...wireSet].filter((w) => !server.has(w) && !client.has(w));
    expect(dead, `owner defines unused event type(s): ${dead.join(", ")}`).toEqual([]);
  });
});

// ── G. behavioral deny-by-default ──

describe("G. behavioral: isKnownSseEventType + send reject unknown types", () => {
  test("isKnownSseEventType returns true for every registered type + false for unknown", async () => {
    for (const wire of Object.values(SSE_EVENT_TYPES)) {
      expect(isKnownSseEventType(wire), `registered type '${wire}' must be known`).toBe(true);
    }
    expect(isKnownSseEventType("bogus_event")).toBe(false);
    expect(isKnownSseEventType("conected")).toBe(false); // typo regression
    expect(isKnownSseEventType("")).toBe(false);
  });

  test("openSseStream.send drops an unknown event type (never writes it to the wire)", async () => {
    // Build a minimal mock ServerResponse: an EventEmitter with the
    // methods openSseStream calls (writeHead, flushHeaders, write, end).
    const written: string[] = [];
    class MockRes extends EventEmitter {
      writeHead(): void { /* no-op */ }
      flushHeaders(): void { /* no-op */ }
      write(chunk: string): boolean { written.push(String(chunk)); return true; }
      end(): void { /* no-op */ }
    }
    const res = new MockRes();
    const stream = await openSseStream(res as never, { keepaliveMs: 86_400_000 }); // long keepalive so the interval doesn't fire during the test
    // A registered type IS written to the wire.
    written.length = 0;
    stream.send(SSE_EVENT_TYPES.done, { runId: "r1" });
    expect(written.join("")).toContain("event: done");
    expect(written.join("")).toContain("data:");
    // An UNKNOWN type is NOT written (deny-by-default). Cast to bypass
    // the compile-time type (simulates a non-TS caller / dynamic string).
    written.length = 0;
    stream.send("bogus_event" as never, { runId: "r1" });
    expect(written.join(""), "an unregistered event type must NOT be written to the wire").toBe("");
    stream.close();
  });
});
