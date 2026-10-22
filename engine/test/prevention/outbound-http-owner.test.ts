/**
 * ONE OUTBOUND HTTP DOOR, CHECKED ON THE SYNTAX TREE. Every request the
 * harness sends to another server goes through `src/shared/outbound-http.ts`
 * (no redirect followed, verified TLS, the one cleartext decision, the proxy
 * hop, the header allowlist, bounded bodies and lifetimes) — and the door
 * owns its transport. A second caller building its own `fetch(url, {…})` is
 * how the MCP transport came to follow a redirect and re-send its
 * `X-API-Key` to another host (SEC-V-1); an injected `fetchImpl` was a seam
 * that bypassed every guarantee at once (secb-design F-6).
 *
 * The earlier guard matched `fetch(` on lines, and missed an alias
 * (`const f = fetch`), a call split across lines, `node:http(s)` request
 * APIs, `net`/`tls` connects, `undici`, a second `new WebSocket`, `.mts` /
 * `.mjs` files and every script (secb-security SECB-V-15). This one parses
 * each file and refuses, outside the door (which alone holds the one client,
 * `undici` — its dispatchers, with the pinned lookup — for requests AND
 * WebSocket handshakes):
 *
 *   - any reference to the platform `fetch` (a call, an alias, a value) or
 *     to `globalThis.fetch` / `global.fetch` / `window.fetch` / `self.fetch`;
 *   - the identifier `fetchImpl` (the retired injection seam);
 *   - `request` / `get` / `Agent` from `node:http(s)` — named, or through a
 *     namespace OR DEFAULT import (`import https from "node:https";
 *     https.request(u)`, secc-security SECC-V-B4) — `connect` /
 *     `createConnection` from `node:net` / `node:tls`, anything from `undici`;
 *   - `new WebSocket(` anywhere (the door opens every WebSocket:
 *     `openOutboundWebSocket`, pinned like a request);
 *   - `.json()` / `.text()` / `.arrayBuffer()` / `.blob()` on a response the
 *     door returned (a body is read only through its bounded readers).
 *
 * There is no transport seam, not even for tests: they answer through a real
 * loopback server (`engine/test/support/loopback-upstream.ts`).
 *
 * Population: the engine's `src/` and `scripts/`, the web server, `shared/`
 * and the repository's `scripts/` — every runtime and tooling source.
 * Planted cases prove each rule sees its spelling.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { experimentExclusion, walk } from "../../scripts/verification/source-walk.ts";
import { astNode, parseSourceModule, walkAst, type AstNode } from "../../src/quality-packs/prevention/ast-helpers.ts";
import { dispatcherOptions } from "../../src/shared/outbound-http.ts";

const ENGINE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPOSITORY_ROOT = dirname(ENGINE_ROOT);
const DOOR = "engine/src/shared/outbound-http.ts";
/**
 * Declared exceptions, each with its reason. A local TCP probe carries no
 * request and no credential; it only asks whether a port is taken.
 */
const DECLARED: Readonly<Record<string, string>> = Object.freeze({
  "scripts/dev-processes.ts:net.createConnection": "the one local port probe (portAnswers): a TCP connect on a loopback port, is it free? No request, no credential.",
  "scripts/capture/cockpit.ts:fetch": "code that runs INSIDE the browser page under test (page.evaluate): the cockpit's own same-origin API call, made as the signed-in page makes it. Not a harness request; no credential of the harness is held.",
});
const SOURCE_EXTENSIONS = [".ts", ".mts", ".cts", ".mjs", ".cjs", ".js"];
const BODY_READERS: ReadonlySet<string> = new Set(["json", "text", "arrayBuffer", "blob"]);
const DOOR_RESPONSES: ReadonlySet<string> = new Set(["outboundFetch", "dispatchOutboundRequest"]);
/** What of `node:http(s)` sends a request or owns connections: only the door holds them. */
const HTTP_CLIENT_EXPORTS: ReadonlySet<string> = new Set(["request", "get", "Agent"]);

function memberName(node: AstNode | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (node.type === "Identifier") return String(node.name);
  if (node.type === "StringLiteral") return String(node.value);
  return undefined;
}

function line(node: AstNode): number {
  return (node.loc as { start?: { line?: number } } | undefined)?.start?.line ?? 0;
}

/** Every refusal in one file's syntax tree (`key` is what DECLARED names). */
export function outboundViolations(path: string, source: string): readonly Readonly<{ line: number; key: string; what: string }>[] {
  const program = parseSourceModule(path, source, { errorRecovery: true });
  const found: { line: number; key: string; what: string }[] = [];
  const add = (node: AstNode, key: string, what: string): void => { found.push({ line: line(node), key, what }); };
  const httpNamespaces = new Set<string>();
  const doorResponses = new Set<string>();
  // A NAME in a key position is not a reference: `obj.fetch`, `{ fetch: … }`,
  // a method or signature named `fetch`, a type member. Collected first, so
  // only a free identifier — the platform global, an alias, a call however it
  // is spelled — counts.
  const keyPositions = new Set<unknown>();
  walkAst(program, (node) => {
    for (const field of ["key", "property"] as const) {
      const child = astNode(node[field]);
      if (child?.type === "Identifier" && node.computed !== true) keyPositions.add(child);
    }
    if (node.type === "TSQualifiedName") keyPositions.add(node.right);
  });
  walkAst(program, (node) => {
    if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
      const object = memberName(astNode(node.object));
      if ((object === "globalThis" || object === "global" || object === "window" || object === "self") && memberName(astNode(node.property)) === "fetch") {
        add(node, "fetch", `${object}.fetch`);
      }
    }
    if (node.type === "ImportDeclaration") {
      const from = String((node.source as { value?: unknown } | undefined)?.value ?? "");
      const module = from.replace(/^node:/u, "");
      for (const specifier of (node.specifiers as AstNode[] | undefined) ?? []) {
        const imported = memberName(astNode(specifier.imported)) ?? "*";
        if ((specifier.type === "ImportNamespaceSpecifier" || specifier.type === "ImportDefaultSpecifier") && (module === "http" || module === "https")) {
          httpNamespaces.add(memberName(astNode(specifier.local)) ?? "");
        }
        if (node.importKind === "type" || specifier.importKind === "type") continue;
        if ((module === "http" || module === "https") && HTTP_CLIENT_EXPORTS.has(imported)) add(node, `${module}.${imported}`, `${from} ${imported}`);
        if ((module === "net" || module === "tls") && (imported === "connect" || imported === "createConnection")) add(node, `net.${imported}`, `${from} ${imported}`);
        if (module === "undici" || module.startsWith("undici/")) add(node, "undici", `${from} ${imported}`);
      }
    }
    if (node.type === "Identifier") {
      // The seam's NAME is refused in every position (`{ fetchImpl }`,
      // `config.fetchImpl`): there is no production transport injection.
      if (node.name === "fetchImpl") add(node, "fetchImpl", "the retired fetchImpl seam");
      if (!keyPositions.has(node)) {
        if (node.name === "fetch") add(node, "fetch", "the platform fetch");
      }
    }
    if (node.type === "NewExpression" && memberName(astNode(node.callee)) === "WebSocket") add(node, "WebSocket", "new WebSocket");
    if (node.type === "VariableDeclarator") {
      let init = astNode(node.init);
      if (init?.type === "AwaitExpression") init = astNode(init.argument);
      if (init?.type === "CallExpression" && DOOR_RESPONSES.has(memberName(astNode(init.callee)) ?? "")) {
        const name = memberName(astNode(node.id));
        if (name !== undefined) doorResponses.add(name);
      }
    }
  });
  walkAst(program, (node) => {
    if (node.type !== "CallExpression" && node.type !== "NewExpression") return;
    const callee = astNode(node.callee);
    if (callee?.type !== "MemberExpression" && callee?.type !== "OptionalMemberExpression") return;
    const object = astNode(callee.object);
    const property = memberName(astNode(callee.property));
    const receiver = memberName(object);
    if (receiver !== undefined && httpNamespaces.has(receiver) && property !== undefined && HTTP_CLIENT_EXPORTS.has(property)) add(node, `http.${property}`, `${receiver}.${property}`);
    if (receiver !== undefined && doorResponses.has(receiver) && property !== undefined && BODY_READERS.has(property)) add(node, "body-read", `${receiver}.${property}() on a door response (read it through readBody)`);
  });
  return found;
}

function isTestPath(relativePath: string): boolean {
  return /(?:^|\/)(?:test|tests)\//u.test(relativePath);
}

function population(): readonly string[] {
  const excludeExperiments = experimentExclusion(ENGINE_ROOT);
  return [
    ...walk(join(ENGINE_ROOT, "src"), { exts: SOURCE_EXTENSIONS }),
    ...walk(join(ENGINE_ROOT, "scripts"), { exts: SOURCE_EXTENSIONS, exclude: excludeExperiments }),
    ...walk(join(REPOSITORY_ROOT, "server"), { exts: SOURCE_EXTENSIONS }),
    ...walk(join(REPOSITORY_ROOT, "shared"), { exts: SOURCE_EXTENSIONS }),
    ...walk(join(REPOSITORY_ROOT, "scripts"), { exts: SOURCE_EXTENSIONS }),
  ].filter((file) => !isTestPath(relative(REPOSITORY_ROOT, file)));
}

test("outbound http owner: the syntax tree sees every spelling, and not a mention", () => {
  const planted: ReadonlyArray<readonly [string, string]> = [
    ["const r = await fetch(url, { method: \"POST\" });", "fetch"],
    ["const f = fetch; await f(url);", "fetch"],
    ["await globalThis\n  .fetch(url);", "fetch"],
    ["const r = await fetch\n(url);", "fetch"],
    ["await this.config.fetchImpl(url, init)", "fetchImpl"],
    ["import { request } from \"node:https\"; request(u);", "https.request"],
    ["import * as http from \"node:http\"; http.get(u);", "http.get"],
    ["import { connect } from \"node:tls\"; connect(443, h);", "net.connect"],
    ["import { Agent } from \"undici\";", "undici"],
    ["const ws = new WebSocket(url);", "WebSocket"],
    ["const res = await outboundFetch(req); const body = await res.json();", "body-read"],
    ["import https from \"node:https\"; https.request(u);", "http.request"],
    ["import http from \"node:http\"; http.get(u);", "http.get"],
    ["import { Agent } from \"node:https\"; new Agent();", "https.Agent"],
    ["import * as http from \"node:http\"; const a = new http.Agent();", "http.Agent"],
    ["await global.fetch(url);", "fetch"],
  ];
  for (const [source, key] of planted) {
    assert.ok(outboundViolations("planted.ts", source).some((violation) => violation.key === key), `${key}: ${source}`);
  }
  for (const mention of [
    "interface A { fetch(url: string): Promise<string>; }",
    "type R = Readonly<{ fetch: Role; push?: Role }>; const s = z.strictObject({ fetch: schema });",
    "class C { fetch(u: string) { return u; } }",
    "const page = await adapter.fetch(url, options);",
    "import type { IncomingMessage } from \"node:http\";",
    "import { createServer } from \"node:http\";",
    "import http from \"node:http\"; http.createServer(handler);",
    "import { isIP } from \"node:net\";",
    "// fetch(x)\n/* fetch(y) */\nconst s = \"fetch(z)\";",
    "const body = await ctx.json();",
  ]) {
    assert.deepEqual(outboundViolations("mention.ts", mention), [], mention);
  }
});

test("outbound http owner: no source outside the door sends a request, holds a transport seam or reads a door body raw", () => {
  const files = population();
  assert.ok(files.length > 300, `the population must be the real runtime and tooling source (${files.length})`);
  const found: string[] = [];
  const declaredSeen = new Set<string>();
  for (const file of files) {
    const path = relative(REPOSITORY_ROOT, file);
    if (path === DOOR) continue;
    const source = readFileSync(file, "utf8");
    for (const violation of outboundViolations(path, source)) {
      const declared = `${path}:${violation.key}`;
      if (DECLARED[declared] !== undefined) { declaredSeen.add(declared); continue; }
      found.push(`${path}:${violation.line}: ${violation.what}`);
    }
  }
  assert.deepEqual(found, [], `send through src/shared/outbound-http.ts (outboundFetch, or prepare + dispatch; tests answer through test/support/loopback-upstream.ts):\n${found.join("\n")}`);
  assert.deepEqual([...declaredSeen].sort(), Object.keys(DECLARED).sort(), "a declared exception with no site left is stale: remove it");
});

/** The client's dispatcher constructors the door may call. */
const DISPATCHER_CLASSES: ReadonlySet<string> = new Set(["Agent", "ProxyAgent", "Pool", "Client"]);

/**
 * Every dispatcher construction in `source`, and whether its options spread a
 * `dispatcherOptions(…)` call — the one builder that turns the client's own
 * headers/body timeouts off.
 */
export function dispatcherConstructions(path: string, source: string): readonly Readonly<{ line: number; what: string; fromOptions: boolean }>[] {
  const found: { line: number; what: string; fromOptions: boolean }[] = [];
  walkAst(parseSourceModule(path, source, { errorRecovery: true }), (node) => {
    if (node.type !== "NewExpression") return;
    // `new Agent(…)` and `new undici.Client(…)` alike: the constructed class's own name.
    const callee = astNode(node.callee);
    const what = callee?.type === "MemberExpression" && callee.computed !== true ? memberName(astNode(callee.property)) : memberName(callee);
    if (what === undefined || !DISPATCHER_CLASSES.has(what)) return;
    // An Agent's options come first; a Client's or a Pool's after its origin.
    const options = astNode((node.arguments as unknown[] | undefined)?.[what === "Client" || what === "Pool" ? 1 : 0]);
    const fromOptions = options?.type === "ObjectExpression" && ((options.properties as AstNode[] | undefined) ?? []).some((property) => {
      const spread = property.type === "SpreadElement" ? astNode(property.argument) : undefined;
      return spread?.type === "CallExpression" && memberName(astNode(spread.callee)) === "dispatcherOptions";
    });
    found.push({ line: line(node), what, fromOptions });
  });
  return found;
}

test("outbound http owner: every dispatcher is built from dispatcherOptions — the caller's deadline is the only lifetime (sec-e-design H1)", () => {
  // The builder: undici's 300 s headers/body timeouts are OFF, keep-alive and the WebSocket bound carried.
  assert.deepEqual({ ...dispatcherOptions(4000, 1000) }, { pipelining: 1, keepAliveTimeout: 4000, keepAliveMaxTimeout: 4000, keepAliveTimeoutThreshold: 1000, headersTimeout: 0, bodyTimeout: 0 });
  assert.deepEqual({ ...dispatcherOptions(4000, 1000, 1024) }, { pipelining: 1, keepAliveTimeout: 4000, keepAliveMaxTimeout: 4000, keepAliveTimeoutThreshold: 1000, headersTimeout: 0, bodyTimeout: 0, webSocket: { maxPayloadSize: 1024 } });
  // The scan sees a construction that sets its own options, and not one spreading the builder.
  for (const [source, expected] of [
    ["new Agent({ keepAliveTimeout: 1 });", false],
    ["const options = dispatcherOptions(1); new Agent(options);", false],
    ["new ProxyAgent({ uri, ...dispatcherOptions(1) });", true],
    ["new Agent({ ...dispatcherOptions(1, 2), connect: { lookup } });", true],
    ["new undici.Client(origin, { ...options, ...dispatcherOptions(1, 2) });", true],
    ["new undici.Client(origin, options);", false],
  ] as const) assert.deepEqual(dispatcherConstructions("planted.ts", source).map((found) => found.fromOptions), [expected], source);
  // The door: every construction (at least the pinned Agent and the ProxyAgent) spreads the builder.
  const door = dispatcherConstructions(DOOR, readFileSync(join(REPOSITORY_ROOT, DOOR), "utf8"));
  assert.ok(door.length >= 3, `the door's constructions were found (${door.length}: the pinned Agent, the ProxyAgent, the pool's Client)`);
  assert.deepEqual(door.filter((found) => !found.fromOptions).map((found) => `${DOOR}:${found.line}: new ${found.what}`), [], "build it from dispatcherOptions(…)");
});
