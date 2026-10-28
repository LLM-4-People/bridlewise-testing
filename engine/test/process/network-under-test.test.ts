/**
 * A TEST RUN DIALS NOTHING BUT THIS MACHINE — AT THE SOCKET
 * (`scripts/tooling/network-under-test-guard.mjs`, installed by
 * `scripts/tooling/network-under-test.ts`; the opt-in: `src/process/live-network.ts`).
 *
 * Measured (wf-del2-correctness NEW-5): a raw `fetch("https://example.com")`
 * from a test process answered 200; the outbound door refuses only what is
 * sent through it. Driven here in a child process that preloads the guard
 * exactly as a run's processes do (`--import=<guard URL>`), never on this
 * process's own sockets:
 *
 *   - the platform's fetch, `http.request` and `net.connect` to a public
 *     address, by address and by name (a resolver answering a public
 *     address), fail with `outbound_network_under_test` and send nothing;
 *   - a loopback server is reached, by address and as `localhost`;
 *   - a host the installer is handed (the run's consented live hosts)
 *     is passed through unguarded, and only that host;
 *   - every process that runs tests loads it: the engine worker, each engine
 *     test file's process (node:test `execArgv`), each web worker (the setup
 *     file).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { liveHostsUnderTest } from "../../src/process/live-network.ts";
import { networkGuardImport } from "../../scripts/tooling/network-under-test.ts";

const ENGINE_ROOT = join(import.meta.dirname, "..", "..");
const CONSENT = ROOT_POLICY.verification.networkUnderTest.liveConsentVariable;

/**
 * Runs `body` (ESM, top-level await) in a node process started exactly as the
 * engine starts a test file's process — the guard preloaded by the runner's own
 * option (`networkGuardImport`), here with `liveHosts` consented; returns its
 * last stdout line, parsed. No inherited `NODE_OPTIONS` is handed down: the
 * first guard a process installs is the one it keeps.
 */
function guarded(body: string, liveHosts: readonly string[] = []): unknown {
  const { NODE_OPTIONS: _inherited, ...environment } = process.env;
  const child = spawnSync(process.execPath, [networkGuardImport(liveHosts), "--input-type=module", "-e", body], { encoding: "utf8", timeout: 60_000, env: environment });
  assert.equal(child.status, 0, `the guarded child failed: ${child.stderr}`);
  return JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "null");
}

const PUBLIC = "93.184.216.34";
/** Child code: `answer` is a resolver that answers the given address for any name, honouring `all`, asynchronously as the system's does. */
const RESOLVER = `const answer = (address) => (host, options, callback) => process.nextTick(() => options.all ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4));`;
/** Child code: `outcome(start)` resolves the error code a socket failed with, or "connected" / "lookup:<address>". */
const OUTCOME = `const outcome = (start) => new Promise((resolve) => { const s = start(); s.once("error", (e) => resolve(e.code ?? e.cause?.code)); s.once("connect", () => { s.destroy(); resolve("connected"); }); s.once("lookup", (e, address) => { if (e) return; s.destroy(); resolve("lookup:" + address); }); });`;

test("the platform's fetch, http.request and net.connect to a public address are refused, by address and by name", () => {
  const codes = guarded([
    `import http from "node:http"; import net from "node:net";`,
    RESOLVER, OUTCOME,
    `const fetched = await fetch("http://${PUBLIC}/", { signal: AbortSignal.timeout(10_000) }).then(() => "answered", (e) => e.cause?.code ?? e.code);`,
    `const byName = await new Promise((resolve) => { const r = http.request({ host: "remote.example", port: 80, lookup: answer("${PUBLIC}") }); r.once("error", (e) => resolve(e.code)); r.end(); });`,
    `const raw = await outcome(() => net.connect({ host: "${PUBLIC}", port: 443 }));`,
    `const positional = await outcome(() => net.connect(443, "${PUBLIC}"));`,
    `const mapped = await outcome(() => net.connect({ host: "::ffff:${PUBLIC}", port: 443 }));`,
    `console.log(JSON.stringify({ fetched, byName, raw, positional, mapped }));`,
  ].join("\n"));
  const refusal = "outbound_network_under_test";
  assert.deepEqual(codes, { fetched: refusal, byName: refusal, raw: refusal, positional: refusal, mapped: refusal });
});

test("a loopback server is reached, by address and as localhost; a name the resolver answers with loopback is this machine", () => {
  const reached = guarded([
    `import http from "node:http"; import net from "node:net";`,
    RESOLVER,
    `const server = http.createServer((request, response) => response.end("here")); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));`,
    `const port = server.address().port;`,
    `const byAddress = await (await fetch("http://127.0.0.1:" + port + "/")).text();`,
    `const byLocalhost = await new Promise((resolve, reject) => { const s = net.connect({ host: "localhost", port, family: 4 }); s.once("connect", () => { s.destroy(); resolve("connected"); }); s.once("error", reject); });`,
    `const byName = await new Promise((resolve, reject) => { const r = http.request({ host: "loopback.example", port, lookup: answer("127.0.0.1") }, (response) => { response.resume(); resolve(response.statusCode); }); r.once("error", reject); r.end(); });`,
    `server.close();`,
    `console.log(JSON.stringify({ byAddress, byLocalhost, byName }));`,
  ].join("\n"));
  assert.deepEqual(reached, { byAddress: "here", byLocalhost: "connected", byName: 200 });
});

test("THE ONE OPT-IN: a host the installer is handed is passed through unguarded, and only that host", () => {
  // 192.0.2.1 (TEST-NET-1) is never dialed: with one address family
  // (`autoSelectFamily: false`) node emits `lookup` and checks `connecting`
  // after it, so the socket destroyed there never connects.
  const body = [
    `import net from "node:net";`,
    RESOLVER, OUTCOME,
    `const live = await outcome(() => net.connect({ host: "live.example", port: 443, autoSelectFamily: false, lookup: answer("192.0.2.1") }));`,
    `const other = await outcome(() => net.connect({ host: "other.example", port: 443, autoSelectFamily: false, lookup: answer("192.0.2.1") }));`,
    `console.log(JSON.stringify({ live, other }));`,
  ].join("\n");
  assert.deepEqual(guarded(body, ["live.example"]), { live: "lookup:192.0.2.1", other: "outbound_network_under_test" });
  assert.deepEqual(guarded(body), { live: "outbound_network_under_test", other: "outbound_network_under_test" }, "a host nobody consented to was passed through");
});

test("IN-PROCESS: the installer the worker and the web setup call hands the guard the consented live hosts — and nothing without consent", () => {
  const [liveHost] = ROOT_POLICY.verification.networkUnderTest.liveHosts;
  assert.ok(liveHost !== undefined);
  const INSTALLER = new URL("../../scripts/tooling/network-under-test.ts", import.meta.url).href;
  const body = (consent: string | null): string[] => [
    ...(consent === null ? [] : [`process.env[${JSON.stringify(CONSENT)}] = ${JSON.stringify(consent)};`]),
    `const net = (await import("node:net")).default;`,
    `(await import(${JSON.stringify(INSTALLER)})).refuseRemoteNetworkUnderTest();`,
    RESOLVER, OUTCOME,
    `const live = await outcome(() => net.connect({ host: ${JSON.stringify(liveHost)}, port: 443, autoSelectFamily: false, lookup: answer("192.0.2.1") }));`,
    `console.log(JSON.stringify({ live }));`,
  ];
  const run = (consent: string | null): unknown => {
    const { NODE_OPTIONS: _inherited, [CONSENT]: _consent, ...environment } = process.env;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", body(consent).join("\n")], { encoding: "utf8", timeout: 60_000, env: environment });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "null");
  };
  assert.deepEqual(run("1"), { live: "lookup:192.0.2.1" }, "the consented live host was refused in-process");
  assert.deepEqual(run(null), { live: "outbound_network_under_test" }, "a live host passed without consent");
});

test("the runner's preload hands the guard the declared live hosts only when the run's environment consents (exactly \"1\")", () => {
  // The hosts the preload hands the installer: the JSON between the call's parentheses.
  const handed = (): unknown => {
    const install = decodeURIComponent(networkGuardImport().slice("--import=data:text/javascript,".length));
    const call = "installNetworkGuard(";
    return JSON.parse(install.slice(install.indexOf(call) + call.length, install.lastIndexOf(");")));
  };
  const before = process.env[CONSENT];
  try {
    delete process.env[CONSENT];
    assert.deepEqual(liveHostsUnderTest(), []);
    assert.deepEqual(handed(), []);
    process.env[CONSENT] = "yes";
    assert.deepEqual(liveHostsUnderTest(), [], "a consent value other than 1 opened the network");
    process.env[CONSENT] = "1";
    assert.deepEqual(handed(), [...ROOT_POLICY.verification.networkUnderTest.liveHosts]);
  } finally {
    if (before === undefined) delete process.env[CONSENT];
    else process.env[CONSENT] = before;
  }
});

test("WIRING: every process that runs tests is guarded — the engine worker (after arming), each engine test file's process, each web worker", () => {
  const source = (path: string): string => readFileSync(path, "utf8");
  const worker = source(join(ENGINE_ROOT, "scripts", "tooling", "test-worker.ts"));
  assert.ok(worker.search(/\brefuseRemoteNetworkUnderTest\(\);/u) > worker.search(/armCheckoutUnderTest\(/u) && worker.search(/armCheckoutUnderTest\(/u) >= 0, "the engine test worker arms the checkout write door but does not guard itself after it");
  assert.match(source(join(ENGINE_ROOT, "scripts", "tooling", "inventory-test-run.ts")), /execArgv: \[engineTestBoundsImport\(\{ \.\.\.phase\.bounds, files: [^\n]+ \}\), networkGuardImport\(\)\]/u, "the engine test files' processes are not started with the guard preloaded");
  assert.match(source(join(ENGINE_ROOT, "..", "tests", "setup", "test-setup.ts")), /^refuseRemoteNetworkUnderTest\(\);$/mu, "the web setup file does not guard its worker");
});
