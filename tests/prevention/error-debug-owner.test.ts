// @vitest-environment node
/**
 * Mechanical enforcement: the error + debug system has ONE owner
 * (Single-Party-Owner ).
 *
 * Enforces:
 * "No `throw new Error(...)` — use the typed hierarchy
 * (server/errors.ts)."
 * "A proper centralized debug/error system must be
 * implemented and enforced everywhere... everything goes through
 * it. When not in debug mode, ignore debug."
 * SPO: error mapping lives in the router (the choke point), not each
 * route. Routes throw typed errors; the router maps them.
 * SPO: ALL console output (debug logging + always-on info) goes
 * through server/debug-bridge.ts. No `console.*` or
 * `process.stderr.write`/`process.stdout.write` outside the bridge.
 * SPO: the ENTIRE error hierarchy lives in server/errors.ts.
 *
 * This test suite covers FOUR assurance classes:
 * (A) SOURCE-SCAN: no console.* / process.{stderr,stdout}.write outside
 * debug-bridge.ts; no `throw new Error(` outside errors.ts/comments;
 * no ad-hoc `res.writeHead` error responses in routes; the body
 * errors (BodySizeLimitError/BodyParseError) are defined in
 * errors.ts (not router.ts).
 * (B) BEHAVIORAL — router mapping: every error class with a statusCode
 * is mapped by the router's statusForError; every error code is in
 * CODE_STATUS_MAP or prefixed invalid_/missing_.
 * (C) BEHAVIORAL — zero overhead: before configureWebDebug, webWarn/
 * webHandleError/webAuditEvent do NOT evaluate the context thunk and
 * do NOT move the signal counters.
 * (D) CONTRACT — the router's error body shape is consistent
 * ({error, message} or the 202 {status:"indexing"} contract).
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { walk } from "../helpers/source-scan.ts";
import { createRouter } from "../../server/router/router.ts";
import { parseErrorClassStatusCode, scanThrownErrorCodes, findUnmapped500DefaultCodes, isInsideStringOrComment } from "../helpers/error-scan.ts";

// ── Source scan helpers ──

const SERVER_ROOT = "server";
const BRIDGE_FILE = modulePath("debug-bridge.ts");
const ERRORS_FILE = modulePathMatching("server/kernel/errors.ts");
const ROUTER_FILE = modulePath("router.ts");

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

function lineOf(src: string, idx: number): number {
  let n = 1;
  for (let i = 0; i < idx; i += 1) if (src[i] === "\n") n += 1;
  return n;
}

// ── (A) Source-scan: no console output outside the debug bridge ──

describe("error-debug owner — source scan", () => {
  test("(A1) no console.warn/error/log/info/debug outside debug-bridge.ts in server/", () => {
    const findings: { file: string; line: number; text: string }[] = [];
    const re = /\bconsole\.(warn|error|log|info|debug)\s*\(/;
    for (const file of walk(SERVER_ROOT, { exts: [".ts"] })) {
      if (file === BRIDGE_FILE) continue;
      const lines = readFileSync(file, "utf-8").split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        if (isCommentLine(lines[i]!)) continue;
        if (re.test(lines[i]!)) {
          findings.push({ file: relative(process.cwd(), file), line: i + 1, text: lines[i]!.trim() });
        }
      }
    }
    if (findings.length > 0) {
      const detail = findings.map((f) => `${f.file}:${f.line}  ${f.text}`).join("\n");
      throw new Error(
        `console.* found outside ${BRIDGE_FILE} — route through the debug bridge (webWarn/webConsoleInfo):\n${detail}`,
      );
    }
  });

  test("(A2) no process.stderr.write / process.stdout.write outside debug-bridge.ts in server/", () => {
    const findings: { file: string; line: number; text: string }[] = [];
    const re = /\bprocess\.(stderr|stdout)\.write\s*\(/;
    for (const file of walk(SERVER_ROOT, { exts: [".ts"] })) {
      if (file === BRIDGE_FILE) continue;
      const lines = readFileSync(file, "utf-8").split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        if (isCommentLine(lines[i]!)) continue;
        if (re.test(lines[i]!)) {
          findings.push({ file: relative(process.cwd(), file), line: i + 1, text: lines[i]!.trim() });
        }
      }
    }
    if (findings.length > 0) {
      const detail = findings.map((f) => `${f.file}:${f.line}  ${f.text}`).join("\n");
      throw new Error(
        `process.{stderr,stdout}.write found outside ${BRIDGE_FILE} — route through the debug bridge:\n${detail}`,
      );
    }
  });

  test("(A3) no `throw new Error(` outside errors.ts + comments in server/ + src/", () => {
    const roots = ["src", "server"];
    const findings: { file: string; line: number; text: string }[] = [];
    const re = /\bthrow\s+new\s+Error\s*\(/g;
    for (const root of roots) {
      for (const file of walk(root, { exts: [".ts"] })) {
        const raw = readFileSync(file, "utf-8");
        const lines = raw.split("\n");
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(raw)) !== null) {
          // Char-level skip (consistent with no-throw-new-error.test.ts):
          // a `throw new Error(` inside a string literal or a block/line
          // comment is NOT a real throw. The line-level `isCommentLine`
          // helper missed inline comments + string literals (a latent
          // false-positive gap — the two tests used different skipping
          // strategies). Use the shared char-level helper for consistency.
          if (isInsideStringOrComment(raw, m.index)) continue;
          const lineNo = lineOf(raw, m.index);
          findings.push({ file: relative(process.cwd(), file), line: lineNo, text: lines[lineNo - 1]?.trim() ?? "" });
        }
      }
    }
    if (findings.length > 0) {
      const detail = findings.map((f) => `${f.file}:${f.line}  ${f.text}`).join("\n");
      throw new Error(
        `Raw \`throw new Error(...)\` found — use a typed error from ${ERRORS_FILE}:\n${detail}`,
      );
    }
  });

  test("(A4) no ad-hoc error `res.writeHead` in routes (the router owns error mapping)", () => {
    const findings: { file: string; line: number; text: string }[] = [];
    // An ad-hoc error response in a route is `res.writeHead(STATUS` where
    // STATUS is a 4xx/5xx (a success 200/201/204 is fine — that's a normal
    // response, not an error response). The router's `dispatch` catch
    // block is the single owner of error `writeHead`.
    const re = /\bres\.writeHead\s*\(\s*(\d{3})\b/;
    for (const file of walk(join(SERVER_ROOT, "routes"), { exts: [".ts"] })) {
      const lines = readFileSync(file, "utf-8").split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        if (isCommentLine(lines[i]!)) continue;
        const m = re.exec(lines[i]!);
        if (m && Number(m[1]) >= 400) {
          findings.push({ file: relative(process.cwd(), file), line: i + 1, text: lines[i]!.trim() });
        }
      }
    }
    if (findings.length > 0) {
      const detail = findings.map((f) => `${f.file}:${f.line}  ${f.text}`).join("\n");
      throw new Error(
        `Ad-hoc error res.writeHead found in routes — routes should THROW typed errors; the router maps them (SPO):\n${detail}`,
      );
    }
  });

  test("(A5) BodySizeLimitError + BodyParseError are defined in errors.ts (SPO — error hierarchy in ONE owner)", () => {
    const errorsSrc = readFileSync(ERRORS_FILE, "utf-8");
    expect(errorsSrc).toMatch(/export class BodySizeLimitError extends WebError/);
    expect(errorsSrc).toMatch(/export class BodyParseError extends WebError/);
    // router.ts must NOT define them (only re-export for test compat).
    const routerSrc = readFileSync(ROUTER_FILE, "utf-8");
    expect(routerSrc).not.toMatch(/export class BodySizeLimitError extends Error/);
    expect(routerSrc).not.toMatch(/export class BodyParseError extends Error/);
    // router.ts re-exports them from errors.ts (compatibility seam).
    expect(routerSrc).toMatch(/export \{ BodySizeLimitError, BodyParseError \}/);
  });

  test("(A6) the router routes errors through the debug bridge (webHandleError in every catch)", () => {
    // The router is the central error-mapping choke point — every route
    // error converges here. If the router does NOT route through the debug
    // bridge (webHandleError), errors are silent on the server side (the
    // client sees the HTTP response, but the operator never sees the error
    // when debug is on — the error-count signal does not increment). This
    // catches a regression where a catch block maps the error to a response
    // without calling webHandleError (the prior state before this round).
    // The router has 3 catch blocks (auth/CSRF gate, body-read, dispatch).
    const routerSrc = readFileSync(ROUTER_FILE, "utf-8");
    // Every `catch (err) {` in router.ts must be followed (within the block)
    // by a `webHandleError(` call. We count catch blocks + webHandleError
    // calls — they must be equal (every catch routes through the bridge).
    // The invariant is "no catch is silent" — every one routes through the
    // centralized debug bridge. It was expressed as `webHandleError` count ==
    // catch count, which conflates the bridge with ONE of its entry points:
    // `webHandleError` is for a failure that becomes an error response, while
    // `webWarn` is for a degraded-but-handled condition (attribution falling
    // back to anonymous, for instance). Requiring the former everywhere would
    // force a handled degradation to be reported as a request error.
    //
    // Counting BRIDGE calls preserves the real guarantee — nothing is
    // swallowed — without dictating which entry point fits the situation.
    const catchCount = (routerSrc.match(/\bcatch\s*\(\s*\w+\s*\)\s*\{/g) ?? []).length;
    const bridgeCount = (routerSrc.match(/\b(webHandleError|webWarn)\s*\(/g) ?? []).length;
    expect(catchCount, "the router must have catch blocks").toBeGreaterThan(0);
    expect(
      bridgeCount,
      `every router catch must route through the debug bridge — webHandleError for a failure ` +
        `that becomes a response, webWarn for a handled degradation (found ${catchCount} ` +
        `catches, ${bridgeCount} bridge calls)`,
    ).toBeGreaterThanOrEqual(catchCount);
  });

  test("(A7) process-level faults have ONE owner, the engine's fault policy, installed by the server's first import", () => {
    // The last line of defense used to be two listeners in `server/index.ts`,
    // installed after the boot's top-level await and able to throw on a
    // hostile reason (SCALE-CR1 C2). The one owner is now
    // `engine/src/process/fault-policy.ts`; the server installs it through its
    // FIRST import, and no server file registers a process-level fault
    // listener of its own. Its behavior (a rejection survives, an uncaught
    // exception exits 70 after recording) is driven in
    // tests/unit/process-fault-policy.test.ts.
    const indexSrc = readFileSync(modulePathMatching("server/index.ts"), "utf-8");
    const firstImport = /^import\s+["']([^"']+)["'];/mu.exec(indexSrc)?.[1];
    expect(firstImport, "the server's first import installs the fault policy").toBe("./kernel/process-fault-policy.ts");
    const installer = readFileSync(join(SERVER_ROOT, "kernel", "process-fault-policy.ts"), "utf-8");
    expect(installer).toContain('installProcessFaultPolicy({ role: "server" });');
    const registrations: string[] = [];
    for (const file of walk(SERVER_ROOT)) {
      const src = readFileSync(file, "utf-8");
      for (const match of src.matchAll(/process\.(?:on|once|addListener|prependListener)\(\s*["'](uncaughtException|unhandledRejection)["']/gu)) {
        if (!isInsideStringOrComment(src, match.index)) registrations.push(`${relative(process.cwd(), file)} ${match[1]!}`);
      }
    }
    expect(registrations, "no server file registers a process-level fault listener of its own").toEqual([]);
  });
});

// ── (B) Behavioral — router maps every error type ──

import {
  WebError,
  ConfigError,
  ValidationError,
  FileSystemError,
  AuthError,
  ForbiddenError,
  ConflictError,
  NotFoundError,
  BadRequestError,
  PathTraversalError,
  ProjectPathError,
  MapNotReadyError,
  ServiceUnavailableError,
  AwarenessNotReadyError,
  BodySizeLimitError,
  BodyParseError,
  CsrfError,
  RateLimitError,
  statusForCode,
} from "../../server/kernel/errors.ts";

describe("error-debug owner — router mapping (behavioral)", () => {
  // Instantiate the router's statusForError by importing createRouter and
  // exercising a handler that throws. We use a minimal stub DB + isPublicPath.
  type StubDb = {
    countUsers: () => number;
    deleteAuthSession: (token: string) => void;
    getProjectByPath: (path: string, userId: string) => unknown;
  };

  // A representative status check: throw an error from a handler and
  // observe the status the router writes. We drive the router with a
  // stubbed IncomingMessage/ServerResponse.
  function dispatchThrowingRouter(thrown: unknown): Promise<{
    status: number;
    body: unknown;
  }> {
    const db: StubDb = {
      countUsers: () => 1,
      deleteAuthSession: () => {},
      getProjectByPath: () => null,
    };
    const router = createRouter({
      db: db as never,
      isPublicPath: () => true,
    });
    router.get("/throw", () => {
      throw thrown;
    });
    // Minimal stubs: a GET with no body + a res that records writeHead+end.
    const req = {
      method: "GET",
      url: "/throw",
      headers: {},
      on: () => {},
    } as never;
    let capturedStatus = 0;
    let capturedBody = "";
    const res = {
      headersSent: false,
      writableEnded: false,
      writeHead(this: { headersSent: boolean }, status: number, _headers?: unknown) {
        capturedStatus = status;
        this.headersSent = true;
      },
      write(chunk: string) {
        capturedBody += chunk;
      },
      end(this: { writableEnded: boolean }, chunk?: string) {
        if (chunk) capturedBody += chunk;
        this.writableEnded = true;
      },
      setHeader() {},
      appendHeader() {},
      flushHeaders() {},
      on() {},
    } as never;
    // The router dispatch is async; run it synchronously via a helper.
    const { MockAgent } = (() => { try { return require("undici"); } catch { return { MockAgent: null }; } })();
    void MockAgent;
    // Drive the promise synchronously using a then/catch shim.
    let done = false;
    let err: unknown = null;
    router.dispatch(req, res).then(() => { done = true; }).catch((e: unknown) => { err = e; done = true; });
    // The dispatch is microtask-based; spin the microtask queue by awaiting
    // a resolved promise up to a bounded number of turns.
    const spin = () => {
      let turns = 0;
      const tick = (): Promise<void> => {
        if (done || turns > 50) return Promise.resolve();
        turns += 1;
        return Promise.resolve().then(tick);
      };
      return tick();
    };
    // We cannot await in a non-async helper; return a promise the caller awaits.
    return spin().then(() => {
      if (err) throw err;
      let parsed: unknown = null;
      try { parsed = capturedBody.length > 0 ? JSON.parse(capturedBody) : null; } catch { parsed = capturedBody; }
      return { status: capturedStatus, body: parsed };
    });
  }

  test("(B1) errors carrying statusCode are mapped to their declared status", async () => {
    const cases: { err: Error; expected: number }[] = [
      { err: new AuthError("x"), expected: 401 },
      { err: new ForbiddenError("x"), expected: 403 },
      { err: new ConflictError("x"), expected: 409 },
      { err: new NotFoundError("x"), expected: 404 },
      { err: new BadRequestError("x"), expected: 400 },
      { err: new PathTraversalError("x"), expected: 403 },
      { err: new CsrfError("x"), expected: 403 },
      { err: new RateLimitError("x", 1), expected: 429 },
      { err: new MapNotReadyError("x"), expected: 202 },
      { err: new ServiceUnavailableError("x"), expected: 503 },
      { err: new AwarenessNotReadyError("x"), expected: 202 },
      { err: new BodySizeLimitError(), expected: 413 },
      { err: new BodyParseError(), expected: 400 },
    ];
    for (const c of cases) {
      const result = await dispatchThrowingRouter(c.err);
      expect(result.status, `${c.err.constructor.name} → status`).toBe(c.expected);
    }
  });

  test("(B2) errors carrying a code (no statusCode) are mapped via CODE_STATUS_MAP or prefix", async () => {
    // Every error class with a default code that has NO statusCode must be
    // mapped: either in CODE_STATUS_MAP or prefixed invalid_/missing_.
    const defaultCodes: { cls: new (m: string) => WebError; code: string }[] = [
      { cls: ConfigError, code: "config_invalid" },
      { cls: FileSystemError, code: "filesystem_error" },
      { cls: ProjectPathError, code: "project_path_invalid" },
    ];
    for (const c of defaultCodes) {
      const mapped =
        statusForCode(c.code) ??
        (c.code.startsWith("invalid_") || c.code.startsWith("missing_") ? 400 : undefined);
      expect(mapped, `${c.cls.name} default code "${c.code}" must be mapped (not 500 fallback)`).toBeDefined();
    }
    // Also verify the specific codes we added this round map correctly.
    expect(statusForCode("patch_malformed_header")).toBe(400);
    expect(statusForCode("patch_context_mismatch")).toBe(400);
    expect(statusForCode("project_path_empty")).toBe(404);
    expect(statusForCode("project_path_stale_encrypted")).toBe(404);
    expect(statusForCode("project_path_missing")).toBe(404);
    expect(statusForCode("project_path_not_directory")).toBe(404);
    expect(statusForCode("project_path_inaccessible")).toBe(404);
    expect(statusForCode("project_path_invalid")).toBe(404);
    expect(statusForCode("config_invalid")).toBe(503);
  });

  test("(B3) every error code thrown in the codebase maps to a non-500 status (dynamic discovery)", () => {
    // Dynamic: scan ALL server/.ts files for error codes thrown
    // via `new \w+Error(msg, "code")` patterns. A new error code added to
    // the codebase is automatically discovered + checked — no hardcoded
    // list that silently rots (the old list missed any new code).
    //
    // A code is "mapped" if ANY of:
    // 1. The error CLASS that throws it has a `statusCode!= 500` (e.g.
    // ForbiddenError=403, NotFoundError=404, BadRequestError=400).
    // 2. The code is in CODE_STATUS_MAP (explicit override for codes
    // thrown by 500-default classes like ProjectPathError).
    // 3. The code starts with `invalid_` or `missing_` (convention: 400).
    //
    // The scan logic (parse class → statusCode, walk server/ for thrown
    // codes, verify mapped) is shared with error-handling-consistency E3 via
    // `tests/helpers/error-scan.ts` (No Scattered Helpers applies to tests
    // too — one scan, two consumers). The shared scan uses the thorough
    // string+comment skip so a doc comment mentioning a throw is not parsed
    // as a real throw.
    //
    // DENY-BY-DEFAULT: there is NO hardcoded class allowlist. Every error
    // class whose statusCode is undefined/500 (the router's 500 default) is
    // a must-be-mapped class — a code it throws that is NOT in
    // CODE_STATUS_MAP (and does not use the invalid_/missing_ prefix) is
    // flagged. This requires the CODE_STATUS_MAP to be EXHAUSTIVE: every
    // thrown code must be explicitly mapped (even to 500 for genuinely
    // server-side errors like db_key_file_corrupt or
    // tool_manifest_duplicate_name), so no code falls through to a SILENT
    // undocumented 500. A new 500-default error class is auto-caught; a new
    // code it throws is auto-caught.
    const serverDir = join(process.cwd(), "server");
    const errorsSrc = readFileSync(join(serverDir, "kernel/errors.ts"), "utf8");
    const classStatusCode = parseErrorClassStatusCode(errorsSrc);
    const thrownCodes = scanThrownErrorCodes(serverDir);
    expect(thrownCodes.length, "should discover at least one error code thrown in server/").toBeGreaterThan(0);
    const unmapped = findUnmapped500DefaultCodes(thrownCodes, classStatusCode, (c) => statusForCode(c) !== undefined);
    expect(
      unmapped,
      `every error code thrown by a 500-default class must be in CODE_STATUS_MAP or use invalid_/missing_ prefix (deny-by-default — no class allowlist; unmapped: ${[...new Set(unmapped)].join(", ")})`,
    ).toEqual([]);
  });
});

// ── (C) Behavioral — zero overhead when debug off ──

import {
  webWarn,
  webHandleError,
  webAuditEvent,
  webDebugLog,
  configureWebDebug,
  resetWebDebug,
  getWebDebugSignals,
  createConsoleSink,
  isWebDebugEnabled,
  webConsoleError,
} from "../../server/observability/debug-bridge.ts";
import { resolveWebDebugBootstrap } from "../../server/kernel/harness-config.ts";
import { DEBUG_CONFIG_DEFAULTS } from "../../engine/src/shared/debug/debug-config.ts";
import { getAuditEvents } from "../../engine/src/shared/debug/debug-system.ts";
import { functionBody } from "../../engine/src/shared/source-structure.ts";

import { modulePath, modulePathMatching } from "../helpers/module-resolver.ts";
describe("error-debug owner — warn/error are never suppressed; debug stays lazy (LG)", () => {
  function captureStderr(fn: () => void): string {
    const origWrite = process.stderr.write.bind(process.stderr);
    let captured = "";
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured += chunk.toString();
      return true;
    }) as never;
    try {
      fn();
    } finally {
      process.stderr.write = origWrite as never;
    }
    return captured;
  }

  beforeEach(() => {
    resetWebDebug();
  });
  afterEach(() => {
    resetWebDebug();
  });

  test("(C1) before configureWebDebug, webWarn IS reported (thunk evaluated, stderr fallback)", () => {
    // UD-LOG-NEVER-DISABLED: a warn site whose comment says "never silent"
    // emitted nothing at the old `!configured` guard. Warn is independent of
    // the master switch, so the unconfigured system uses its stderr fallback.
    let evaluated = false;
    const captured = captureStderr(() => {
      webWarn("test", "REPRO-WARN unconfigured", () => {
        evaluated = true;
        return { detail: "x" };
      });
    });
    expect(evaluated, "a reported warning evaluates its context").toBe(true);
    expect(captured).toContain("REPRO-WARN unconfigured");
    expect(getWebDebugSignals().warnCount).toBe(1);
  });

  test("(C2) before configureWebDebug, webDebugLog info remains zero-overhead (thunk not evaluated)", () => {
    let evaluated = false;
    const before = getWebDebugSignals();
    webDebugLog("test", "info", "should not emit", () => {
      evaluated = true;
      return { secret: "leak" };
    });
    expect(evaluated).toBe(false);
    expect(getWebDebugSignals().debugCount).toBe(before.debugCount);
  });

  test("(C3) before configureWebDebug, webHandleError IS reported and counts", () => {
    // An error caught before (or without) the debug system's installation is
    // exactly the failure an operator must see; the old guard dropped it.
    const before = getWebDebugSignals();
    const captured = captureStderr(() => {
      webHandleError(new Error("REPRO-ERROR unconfigured"), { module: "test", operation: "test" });
    });
    const after = getWebDebugSignals();
    expect(after.errorCount).toBe(before.errorCount + 1);
    expect(captured).toContain("REPRO-ERROR unconfigured");
  });

  test("(C4) before configureWebDebug, webAuditEvent does NOT emit or move counters", () => {
    const before = getWebDebugSignals();
    webAuditEvent("test.event", { detail: "x" });
    const after = getWebDebugSignals();
    expect(after.auditCount ?? 0).toBe(before.auditCount ?? 0);
  });

  test("(C5) after configureWebDebug, webWarn DOES evaluate the thunk + the sink receives it", () => {
    configureWebDebug({ enabled: true, categories: ["test"] }, [createConsoleSink()]);
    let evaluated = false;
    const captured = captureStderr(() => {
      webWarn("test", "should emit", () => {
        evaluated = true;
        return { detail: "x" };
      });
    });
    expect(evaluated).toBe(true);
    expect(captured).toContain("should emit");
  });

  test("(C6) a configured system with the master switch OFF still reports warn and error", () => {
    // The shipped document is `enabled: false`; the old debugLog returned at
    // the master switch, so every warn/error site was silent in production.
    configureWebDebug({ enabled: false, categories: ["test"] }, [createConsoleSink()]);
    const captured = captureStderr(() => {
      webWarn("test", "warn while disabled");
      webDebugLog("test", "error", "error while disabled");
    });
    expect(captured).toContain("warn while disabled");
    expect(captured).toContain("error while disabled");
  });
});

// ── (E) The debug config wiring census — the section is real, and every
// consumer reaches it through the ONE resolver ──
//
// The debug section of the config document was declared, write-gated,
// shipped in the file and consumed by NOTHING (the round-34 zombie): the
// bootstrap read one env var and configured the system from code defaults,
// so every config leaf was inert. The wiring made the section real through
// ONE resolver (`resolveWebDebugBootstrap`, server/kernel/harness-config.ts)
// that both the boot path and every consumer reach through. These arms hold
// the wiring's three load-bearing facts mechanically: the default category
// allow-list covers what the server actually emits (a hand list rotted at
// six names while the server emitted ~30, silently category-suppressing the
// rest), the env var is read at exactly one owner and consulted by exactly
// one resolver, and the boot consults the resolver before the socket listens.

describe("error-debug owner — the debug config wiring census", () => {
  test("(E1) the CONFIG DOCUMENT's category allow-list covers what the server emits (one owner, derived census)", () => {
    // The allow-list had three owners: this bridge's own array, the config
    // document's copy, and this census's regex-derived set (which read every
    // quoted lowercase token in the bridge file, so `warn` — a LEVEL — counted
    // as a category). The document is the one owner now; the bridge carries no
    // list, and this census reads the document a person can edit.
    const codeOnly = (file: string): string =>
      readFileSync(file, "utf8").split("\n").filter((line) => !isCommentLine(line)).join("\n");
    const derived = new Set<string>();
    for (const file of walk(SERVER_ROOT, { exts: [".ts"] })) {
      const src = codeOnly(file);
      for (const m of src.matchAll(/webWarn\(\s*"([^"]+)"/gu)) derived.add(m[1]!);
      for (const m of src.matchAll(/webDebugLog\(\s*"([^"]+)"/gu)) derived.add(m[1]!);
      for (const m of src.matchAll(/module:\s*"([^"]+)"/gu)) derived.add(m[1]!);
    }
    expect(derived.size, "the derived category set must be real — a census over zero call sites proves nothing").toBeGreaterThanOrEqual(30);
    const document = JSON.parse(readFileSync(join(process.cwd(), "engine", "bridlewise.config.json"), "utf8")) as {
      debug?: { categories?: unknown };
    };
    expect(Array.isArray(document.debug?.categories), "the config document must declare debug.categories").toBe(true);
    const declaredList = document.debug!.categories as string[];
    expect(declaredList.length).toBeGreaterThanOrEqual(30);
    const declared = new Set(declaredList);
    const missing = [...derived].filter((c) => !declared.has(c));
    expect(missing, `emitted categories the document's allow-list does not cover (they would be silently category-suppressed with debug on): ${missing.join(", ")}`).toEqual([]);
    // A LEVEL is not a category. The old bridge-file scan admitted `warn`
    // because the prose beside the list spells it; the document's list must
    // hold emission categories only.
    for (const level of ["off", "error", "warn", "info", "debug", "trace"]) {
      expect(declared.has(level), `${level} is a level, not a category`).toBe(false);
    }
    // And the bridge no longer owns a second copy to drift from the document.
    const bridgeSrc = readFileSync(BRIDGE_FILE, "utf8");
    expect(bridgeSrc, "the bridge must not reintroduce a category list").not.toContain("DEFAULT_WEB_DEBUG_CATEGORIES");
  });

  test("(E2) the debug env var is read at exactly ONE owner and consulted by exactly ONE resolver (no consumer bypasses the precedence design)", () => {
    // The precedence design lives or dies at its one door: if any consumer
    // reads `HARNESS_WEB_DEBUG` (or calls `debugEnabled`) directly, the
    // env-vs-file decision forks per call site — the undesigned state the
    // wiring exists to end. The literal may appear only in the config owner
    // (server/kernel/config.ts, where every env read lives); the accessor
    // may be called only by the owner itself and the resolver.
    const envReaders: string[] = [];
    const callers: string[] = [];
    for (const file of [...walk(SERVER_ROOT, { exts: [".ts"] }), ...walk("src", { exts: [".ts", ".svelte"] })]) {
      const lines = readFileSync(file, "utf8").split("\n");
      const code = lines.filter((line) => !isCommentLine(line)).join("\n");
      if (code.includes("HARNESS_WEB_DEBUG")) envReaders.push(file);
      if (/\bdebugEnabled\(\s*\)/u.test(code) && !/function debugEnabled/u.test(code)) callers.push(file);
    }
    expect(envReaders, `HARNESS_WEB_DEBUG must be read only at the config owner: ${envReaders.join(", ")}`).toEqual([
      join(SERVER_ROOT, "kernel", "config.ts"),
    ]);
    expect(callers.sort(), `debugEnabled() must be consulted only by the resolver (the one precedence owner): ${callers.join(", ")}`).toEqual([
      join(SERVER_ROOT, "kernel", "harness-config.ts"),
    ]);
  });

  test("(E3) the boot configures the debug system through the resolver — on its install decision, never a direct env gate", () => {
    const indexSrc = readFileSync(modulePathMatching("server/index.ts"), "utf8");
    expect(indexSrc).toContain("resolveWebDebugBootstrap()");
    expect(indexSrc).toMatch(/if \(debugBootstrap\.install\)/);
    // The call's argument NAMES, not a window: the install decision passes the
    // resolved base as its first argument. Assert the call shape itself.
    expect(indexSrc.replace(/\r\n/g, "\n")).toContain(
      "configureWebDebug(\n    debugBootstrap.base",
    );
    // The old gate — `if (debugEnabled())` deciding the bootstrap at the
    // call site — is the bypass this census exists to refuse: the env read
    // belongs to the resolver, never to the boot.
    expect(indexSrc).not.toMatch(/if \(debugEnabled\(\)\)/);
    // And the master switch alone must not gate the install: the shipped
    // document has `enabled: false` with `audit.enabled: true`, and gating on
    // `enabled` counted and dropped every audit event (auditEvent returns at
    // the `!configured` guard). The decision belongs to the resolver.
    expect(indexSrc).not.toMatch(/if \(debugBootstrap\.base\.enabled/);
  });

  test("(E6) a boot config with the master switch off and audit on is installed and produces an audit record", () => {
    // THE SHIPPED DOCUMENT IS THIS ARM'S FIXTURE: `debug.enabled` is false
    // and `debug.audit.enabled` is true. The resolver must answer install=true
    // anyway, and configuring with that resolved base must make auditEvent
    // RECORD — not count and drop at the `!configured` guard.
    const previous = process.env.HARNESS_WEB_DEBUG;
    delete process.env.HARNESS_WEB_DEBUG;
    resetWebDebug();
    try {
      const bootstrap = resolveWebDebugBootstrap();
      expect(bootstrap.base.enabled, "the master switch is off in this fixture").toBe(false);
      expect(bootstrap.base.audit?.enabled, "audit is on in this fixture").toBe(true);
      expect(bootstrap.install, "audit alone requires the boot to install the system").toBe(true);
      // The boot's sink list is the section's allow-list decision; with no
      // sinks the record still lands in the audit ring buffer and counter.
      configureWebDebug(bootstrap.base, []);
      webAuditEvent("test.boot_audit", { detail: "recorded" });
      expect(getWebDebugSignals().auditCount).toBe(1);
      expect(getAuditEvents()).toHaveLength(1);
      expect(getAuditEvents()[0]!.category).toBe("test.boot_audit");
    } finally {
      resetWebDebug();
      if (previous === undefined) delete process.env.HARNESS_WEB_DEBUG;
      else process.env.HARNESS_WEB_DEBUG = previous;
    }
  });

  test("(E4) the boot resolves the debug section BEFORE the socket listens (the startup pin's order)", () => {
    // A hand-edited weakening section must be a BOOT refusal, not a
    // first-request failure: the resolver (which enforces the section's
    // floor) runs before the listener is created (`createHttpListener`) —
    // the same order discipline as the masker's policy pin. Line numbers, not
    // spans: the first resolveWebDebugBootstrap call must precede it.
    const indexSrc = readFileSync(modulePathMatching("server/index.ts"), "utf8");
    const resolveAt = indexSrc.indexOf("resolveWebDebugBootstrap()");
    const listenAt = indexSrc.indexOf("createHttpListener(");
    expect(resolveAt, "index.ts must call the debug resolver at boot").toBeGreaterThan(-1);
    expect(listenAt, "index.ts must create the server socket").toBeGreaterThan(-1);
    expect(resolveAt).toBeLessThan(listenAt);
  });

  test("(E5) the bridge's own door refuses a redaction-off policy, typed, before the system is configured (the third door)", () => {
    // The write gate refuses the weakening write; the boot resolver refuses
    // hand-edited bytes; and the bridge itself refuses any caller that hands
    // it a redaction-off policy — defense in depth, each door independent.
    // The refusal must leave the system unconfigured (it precedes the
    // configure call), so a refused policy is never half-installed.
    resetWebDebug();
    try {
      expect(() =>
        configureWebDebug({
          enabled: true,
          redaction: { ...DEBUG_CONFIG_DEFAULTS.redaction, enabled: false },
        }),
      ).toThrowError(expect.objectContaining({ code: "debug_redaction_required" }));
      expect(isWebDebugEnabled()).toBe(false);
    } finally {
      resetWebDebug();
    }
  });
});

// ── (F) The bridge's sink contract and the always-on redactor ──

describe("error-debug owner — the bridge's sink contract and the fatal sink", () => {
  const LIVE_KEY = "sk-LIVEKEY-8f31c05a9e27b46d1a08f3c65b92d740";
  let originalWrite: typeof process.stderr.write;
  let captured = "";

  beforeEach(() => {
    resetWebDebug();
    captured = "";
    originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured += chunk.toString();
      return true;
    }) as never;
  });
  afterEach(() => {
    process.stderr.write = originalWrite as never;
    resetWebDebug();
  });

  test("(F0) configureWebDebug refuses an omitted category list — the resolved document is the owner", () => {
    resetWebDebug();
    try {
      expect(
        () => configureWebDebug({ enabled: true }, []),
        "omitting the list must not fall back to a bridge-owned copy",
      ).toThrowError(expect.objectContaining({ code: "debug_categories_undeclared" }));
      expect(isWebDebugEnabled(), "a refused config installs nothing").toBe(false);
      // An EXPLICIT empty list is a declared decision, not a fallback; warn
      // and error remain reported through the always-on path.
      expect(() => configureWebDebug({ enabled: true, categories: [] }, [])).not.toThrow();
    } finally {
      resetWebDebug();
    }
  });

  test("(F1) configureWebDebug({enabled:true}) with sinks OMITTED installs the console sink (documented contract)", () => {
    configureWebDebug({ enabled: true, categories: ["test"] });
    webDebugLog("test", "warn", "WITNESS-F1 the default sink is installed");
    expect(captured, "an omitted sink list must default to the console sink; events were counted and dropped").toContain("WITNESS-F1");
  });

  test("(F2) an EXPLICIT empty sink list installs no sink — warn still uses the always-on fallback", () => {
    configureWebDebug({ enabled: true, categories: ["test"] }, []);
    webDebugLog("test", "warn", "WITNESS-F2 no configured sink");
    // The caller's [] is honored: no sink was installed, so no sink write was
    // attempted. Warn is nevertheless reported through the terminal fallback —
    // the decision's always-reported half, not a substituted default sink.
    expect(getWebDebugSignals().sinkWriteAttempts).toBe(0);
    expect(captured, "warn is never silent, even with no configured sink").toContain("WITNESS-F2 no configured sink");
    const debugBefore = captured.length;
    webDebugLog("test", "debug", "WITNESS-F2 debug stays off");
    expect(captured.length, "debug remains optional").toBe(debugBefore);
  });

  test("(F3) webConsoleError redacts through the debug system's redactor", () => {
    webConsoleError(`WITNESS-F3 credential rejected: ${LIVE_KEY}`);
    expect(captured, "witness: the line was written").toContain("WITNESS-F3");
    expect(captured, "the credential format must be masked before stderr").not.toContain(LIVE_KEY);
    expect(captured).toContain("[REDACTED]");
  });

  test("(F4) the two caught, non-fatal sites use the error signal, not the fatal sink", () => {
    const indexSrc = readFileSync(modulePathMatching("server/index.ts"), "utf8");
    const shutdown = functionBody(indexSrc, "shutdown", "server/index.ts shutdown").body;
    expect(shutdown).toContain("webHandleError");
    expect(shutdown, "the fatal always-on sink is not for caught failures").not.toContain("webConsoleError");
    const configSrc = readFileSync(modulePathMatching("server/kernel/harness-config.ts"), "utf8");
    // The watch failure is a caught, non-fatal optimisation failure; its
    // remediation is now context on the error signal.
    expect(configSrc).toContain('operation: "settings_watch"');
    expect(configSrc).not.toContain("the settings watch could not watch");
  });
});

// ── (D) Contract — router error body shape ──

describe("error-debug owner — router error body contract", () => {
  function dispatchAndCapture(thrown: unknown): Promise<{ status: number; body: unknown }> {
    const db = {
      countUsers: () => 1,
      deleteAuthSession: () => {},
      getProjectByPath: () => null,
    };
    const router = createRouter({ db: db as never, isPublicPath: () => true });
    router.get("/throw", () => {
      throw thrown;
    });
    const req = { method: "GET", url: "/throw", headers: {}, on: () => {} } as never;
    let capturedStatus = 0;
    let capturedBody = "";
    const res = {
      headersSent: false,
      writableEnded: false,
      writeHead(this: { headersSent: boolean }, status: number) { capturedStatus = status; this.headersSent = true; },
      write(chunk: string) { capturedBody += chunk; },
      end(this: { writableEnded: boolean }, chunk?: string) { if (chunk) capturedBody += chunk; this.writableEnded = true; },
      setHeader() {},
      appendHeader() {},
      flushHeaders() {},
      on() {},
    } as never;
    return router.dispatch(req, res).then(() => {
      let parsed: unknown = null;
      try { parsed = JSON.parse(capturedBody); } catch { parsed = capturedBody; }
      return { status: capturedStatus, body: parsed };
    });
  }

  test("(D1) a typed WebError produces {error: code, message}", async () => {
    const result = await dispatchAndCapture(new ValidationError("bad input", "invalid_test"));
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "invalid_test", message: "bad input" });
  });

  test("(D2) a 202 MapNotReadyError produces {status: 'indexing', code, message}", async () => {
    const result = await dispatchAndCapture(new MapNotReadyError("building"));
    expect(result.status).toBe(202);
    const body = result.body as Record<string, unknown>;
    expect(body.status).toBe("indexing");
    expect(body.code).toBe("map_not_ready");
    expect(body.message).toBe("building");
  });

  test("(D3) a 202 AwarenessNotReadyError produces {status: 'indexing', code, message}", async () => {
    const result = await dispatchAndCapture(new AwarenessNotReadyError("computing"));
    expect(result.status).toBe(202);
    const body = result.body as Record<string, unknown>;
    expect(body.status).toBe("indexing");
    expect(body.code).toBe("awareness_not_ready");
    expect(body.message).toBe("computing");
  });

  test("(D4) a ConfigError (config_invalid → 503) produces {error: code, message}", async () => {
    const result = await dispatchAndCapture(new ConfigError("Invalid LLM API config"));
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: "config_invalid", message: "Invalid LLM API config" });
  });

  test("(D5) a ProjectPathError (project_path_invalid → 404) produces {error: code, message}", async () => {
    const result = await dispatchAndCapture(new ProjectPathError("missing path"));
    expect(result.status).toBe(404);
    expect(result.body).toEqual({ error: "project_path_invalid", message: "missing path" });
  });
});
