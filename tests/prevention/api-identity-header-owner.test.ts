// @vitest-environment node
/**
 * THE API SIGNS EVERY ANSWER IT GIVES — on every path, including the ones
 * that never reach a route.
 *
 * WHY THIS EXISTS. The client decides "is the server reachable" by asking
 * whether a response carries `API_IDENTITY_HEADER` (see
 * `src/data/connection.ts` for why a status code cannot answer that
 * question). The rule is only sound if the header is genuinely on
 * EVERYTHING the API produces. A single unsigned response path — the
 * loopback 403, the CORS preflight 204, an unmatched route's 404 — would be
 * read by the client as "the API was not reached", and the whole cockpit
 * would blank on a request that in fact worked perfectly. That is a
 * fabricated outage, which is the same class of failure as fabricated data.
 *
 * The only way to make it true for paths that do not exist yet is to stamp
 * it BEFORE any branching, at the lowest choke point: the one listener owner
 * (`server/router/http-listener.ts`), which sets it before the server's
 * handler runs and writes it on its own parser-refusal answers (WF-1b3b
 * design M2: those left unsigned). So that is what this guard checks: not
 * "the header appears somewhere in the file" — which the defective versions
 * would also satisfy — but that it is the FIRST executable statement of the
 * callback the listener hands `createServer`, that the server's socket is
 * made by that listener, and that a parser refusal carries it.
 */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";

import { API_IDENTITY_HEADER, API_IDENTITY_VALUE } from "../../shared/constants.ts";
import { clientErrorAnswer, clientErrorResponse } from "../../server/router/http-listener.ts";

import { modulePathMatching } from "../helpers/module-resolver.ts";
const SERVER_ENTRY = modulePathMatching("server/index.ts");
const LISTENER_OWNER = modulePathMatching("router/http-listener.ts");

/**
 * The body of the request callback the listener hands `createServer(options,
 * (req, res) => { … })`, with comments and blank lines removed, as a list of
 * source lines.
 *
 * A pure function of the source so the mutation self-checks below can run it
 * over synthetic text — which is what makes them prove something. A guard
 * that could only be tested by editing the real file is a guard nobody
 * re-verifies.
 */
export function handlerBodyLines(src: string): string[] {
  const start = src.indexOf("createServer(");
  if (start < 0) return [];
  const braceAt = src.indexOf("{", src.indexOf("=>", start));
  if (braceAt < 0) return [];
  return src
    .slice(braceAt + 1)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"));
}

/** True when the first executable statement stamps the identity header. */
export function stampsIdentityFirst(src: string, headerConst = "API_IDENTITY_HEADER"): boolean {
  const first = handlerBodyLines(src)[0];
  if (first === undefined) return false;
  return first.includes("setHeader") && first.includes(headerConst);
}

describe("the identity header", () => {
  const src = readFileSync(LISTENER_OWNER, "utf8");

  test("is stamped as the FIRST statement of the listener's request callback", () => {
    expect(stampsIdentityFirst(src)).toBe(true);
  });

  test("the server's socket is made by that listener, and nowhere else in the entry", () => {
    const entry = readFileSync(SERVER_ENTRY, "utf8");
    expect(entry).toContain("createHttpListener(serverConfig,");
    expect(entry).not.toMatch(/\bcreateServer\(/u);
  });

  test("a parser refusal — the one answer that never reaches the callback — carries it", () => {
    for (const code of ["HPE_HEADER_OVERFLOW", "ERR_HTTP_REQUEST_TIMEOUT", "HPE_INVALID_METHOD"]) {
      const bytes = clientErrorResponse(clientErrorAnswer(code));
      expect(bytes.slice(0, bytes.indexOf("\r\n\r\n")).split("\r\n")).toContain(`${API_IDENTITY_HEADER}: ${API_IDENTITY_VALUE}`);
    }
  });

  test("uses the shared contract constants, not a re-typed literal", () => {
    // A second spelling of the header name is a second protocol, and the
    // client would stop recognising the server the moment they drifted.
    expect(src).toContain("API_IDENTITY_HEADER");
    expect(src).toContain("API_IDENTITY_VALUE");
    expect(src.includes(`"${API_IDENTITY_HEADER}"`)).toBe(false);
  });

  test("the constants themselves are non-empty and lowercase", () => {
    // Node lowercases incoming header names; the browser's `Headers.get` is
    // case-insensitive, but a mixed-case constant invites a `req.headers[...]`
    // lookup on the server that would silently miss.
    expect(API_IDENTITY_HEADER.length).toBeGreaterThan(0);
    expect(API_IDENTITY_HEADER).toBe(API_IDENTITY_HEADER.toLowerCase());
    expect(API_IDENTITY_VALUE.length).toBeGreaterThan(0);
  });
});

describe("mutation: the guard fails when the rule is broken", () => {
  const AFTER_THE_LOOPBACK_CHECK = `
const server = createServer(options, (req, res) => {
  const host = req.headers.host ?? "";
  if (!isLoopbackHost(host)) {
    res.writeHead(403);
    res.end();
    return;
  }
  res.setHeader(API_IDENTITY_HEADER, API_IDENTITY_VALUE);
  router.dispatch(req, res);
});`;

  const NOT_AT_ALL = `
const server = createServer(options, (req, res) => {
  router.dispatch(req, res);
});`;

  const CORRECT = `
const server = createServer(options, (req, res) => {
  // a comment, and a blank line, must not count as the first statement

  res.setHeader(API_IDENTITY_HEADER, API_IDENTITY_VALUE);
  router.dispatch(req, res);
});`;

  test("stamping it AFTER the loopback check is caught", () => {
    // This is the realistic regression: it looks right, the header IS set,
    // and the 403 path silently loses it — so a blocked request would be
    // reported to the reader as the server being down.
    expect(stampsIdentityFirst(AFTER_THE_LOOPBACK_CHECK)).toBe(false);
  });

  test("not stamping it at all is caught", () => {
    expect(stampsIdentityFirst(NOT_AT_ALL)).toBe(false);
  });

  test("comments and blank lines do not count as the first statement", () => {
    // Without this, the guard could be satisfied by a comment mentioning the
    // constant — a scanner that passes on prose proves nothing.
    expect(stampsIdentityFirst(CORRECT)).toBe(true);
  });

  test("a re-typed literal instead of the constant is caught", () => {
    const RETYPED = `
const server = createServer(options, (req, res) => {
  res.setHeader("x-harness-api", "1");
  router.dispatch(req, res);
});`;
    expect(stampsIdentityFirst(RETYPED)).toBe(false);
  });
});
