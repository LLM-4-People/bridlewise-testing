// @vitest-environment node
/**
 * EVERY CALLBACK THE EVENT LOOP RUNS IS GUARDED (SCALE-CR1 C3).
 *
 * A synchronous throw inside a timer, an emitter or event-target listener, a
 * folder watch, a request handler or a listen callback has no caller to
 * catch it: it is an uncaught exception, and the process fault policy ends
 * the process on one (fail-stop, exit 70). The census of `server/` and
 * `engine/src/` found 133 such registrations with no guard (and SCALE-CR1-FIX
 * N3 three more completion callbacks its first definition missed). Each now
 * goes through `guarded(owner, fn)` (`engine/src/process/fault-policy.ts`):
 * the fault is attributed, counted (`process.faults.guardedCallbacks`) and
 * reported, and the process's role decides the rest (a service lives on, a
 * tool fails closed, a process with no role keeps Node's default).
 *
 * The same module census holds the fault policy's DOORS (SCALE-CR1-FIX H2):
 * `installProcessFaultPolicy` is called only by the process bootstrap, the
 * worker prelude and the server's first import, and every `new Worker(` is
 * started on the prelude (`new Worker(...bootstrappedWorker(…))`).
 *
 * The census is the parser-based one in
 * `engine/scripts/verification/event-loop-callbacks.ts`; the count must stay
 * 0. There is no allowlist: a body proven total today is one edit away from
 * throwing, and the guard costs one call. The only callbacks accepted
 * unguarded are promise settlers, which cannot throw.
 */
import { describe, expect, test } from "vitest";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import { processDoorFindings, processDoorFindingsIn, sqliteUserFunctions, sqliteUserFunctionsIn, unguardedCallbacksIn, unguardedEventLoopCallbacks } from "../../engine/scripts/verification/event-loop-callbacks.ts";
import { runNativeScript } from "../helpers/native-script.ts";
import { createTempDir } from "../helpers/temp-dir.ts";
import { modulePath } from "../helpers/module-resolver.ts";

const REPO = join(import.meta.dirname, "..", "..");
/** A module's file URL by its NAME (the module resolver), as source text for a child script. */
const moduleUrl = (name: string): string => JSON.stringify(pathToFileURL(modulePath(name)).href);

describe("event-loop callbacks", () => {
  test("the census of server/ and engine/src/ finds no unguarded registration", () => {
    const findings = unguardedEventLoopCallbacks(process.cwd());
    expect(findings.map((finding) => `${finding.path}:${String(finding.line)} ${finding.registration} ${finding.callback}`),
      "register each through guarded(owner, fn) — at the definition when the listener is later removed by reference").toEqual([]);
  });

  test("the census sees every registration shape, and accepts only the guarded and the settler forms", () => {
    const refused = (source: string) => unguardedCallbacksIn(source, "probe.ts").map((finding) => finding.registration);
    expect(refused("setTimeout(() => work(), 10);")).toEqual(["setTimeout"]);
    expect(refused("setInterval(tick, 10); setImmediate(go); queueMicrotask(go); process.nextTick(go);")).toEqual(["setInterval", "setImmediate", "queueMicrotask", "process.nextTick"]);
    expect(refused("child.on('exit', onExit); child.once('error', (e) => log(e)); target.addEventListener('abort', stop);")).toEqual(["on", "once", "addEventListener"]);
    expect(refused("child.stdout?.on('data', (d) => take(d));"), "an optional chain registers too").toEqual(["on"]);
    expect(refused("watch(dir, { recursive: true }, (e, f) => seen(f)); createServer(opts, (q, s) => serve(q, s)); server.listen(0, 'h', () => ready());")).toEqual(["watch", "createServer", "listen"]);
    expect(refused("const onExit = () => done(); child.on('exit', onExit);"), "a plain const is not a guard").toEqual(["on"]);
    expect(refused("new Promise((resolve) => setTimeout(() => resolve(new Error('x')), 1));"), "a settler called with a computed value is not proven total").toEqual(["setTimeout"]);
    // Accepted: guarded in place, a name bound to guarded, and promise settlers.
    expect(refused("setTimeout(guarded('o', () => work()), 10); child.on('exit', guarded('o', onExit));")).toEqual([]);
    expect(refused("const onAbort = guarded('o', () => stop()); signal.addEventListener('abort', onAbort);")).toEqual([]);
    expect(refused("new Promise((resolve, reject) => { setTimeout(resolve, 5); req.on('error', reject); setTimeout(() => resolve('late'), 9); });")).toEqual([]);
    expect(refused("emitter.on('x');"), "a call with no callback registers nothing").toEqual([]);
  });

  test("the census resolves names through their scopes and sees member timers, completion callbacks, handler properties and computed members (SCALE-CR1-FIX N3)", () => {
    const refused = (source: string) => unguardedCallbacksIn(source, "probe.ts").map((finding) => finding.registration);
    // A guarded name in ONE function does not guard a same-named binding in another.
    expect(refused("function a() { const f = guarded('o', () => 1); x.on('e', f); } function b() { const f = () => boom(); y.on('e', f); }"), "shadow").toEqual(["on"]);
    expect(refused("let f = guarded('o', () => 1); f = () => boom(); x.on('e', f);"), "a guarded let reassigned").toEqual(["on"]);
    expect(refused("let f = guarded('o', () => 1); f = guarded('o', () => 2); x.on('e', f);"), "reassigned to another guard").toEqual([]);
    expect(refused("globalThis.setTimeout(() => boom(), 1); timers.setImmediate(go);"), "member timers").toEqual(["setTimeout", "setImmediate"]);
    expect(refused("import { setTimeout as sleep } from 'node:timers/promises'; await sleep(5); await timersPromises.setTimeout(5);"), "the promise API takes no callback").toEqual([]);
    expect(refused("fs.readFile(p, (e, d) => use(d)); stream.write(data, (e) => done(e)); scrypt(pw, salt, 64, opts, (e, k) => keep(k)); child.stdin.end(cb2); function cb2() { boom(); }"), "node-style completion callbacks").toEqual(["readFile", "write", "scrypt", "end"]);
    expect(refused("import https from 'node:https'; https.get(url, (res) => take(res)); import { request } from 'node:http'; request(opts, (res) => take(res));"), "an HTTP client's callback").toEqual(["get", "request"]);
    expect(refused("router.get('/x', async (ctx) => serve(ctx)); writeFile(path, data); stream.write(chunk, 'utf8');"), "a router's handler and a value last argument register nothing").toEqual([]);
    expect(refused("ws.onmessage = (event) => take(event); socket.onerror = handle; ws.onclose = null;"), "on<event> handler properties").toEqual(["onmessage =", "onerror ="]);
    expect(refused("emitter['on']('x', () => boom()); emitter['once']('y', guarded('o', () => 1));"), "a computed member").toEqual(["on"]);
    expect(refused("new Promise((resolve) => { const settle = (resolve) => setTimeout(resolve, 1); settle(boom); });"), "a parameter shadowing the settler").toEqual(["setTimeout"]);
    expect(refused("new Promise((resolve) => { stream.write(d, guarded('o', (e) => resolve())); setTimeout(resolve, 1); });")).toEqual([]);
  });

  test("the fault policy is installed only by its three doors, and every worker thread starts with the prelude (SCALE-CR1-FIX H2)", () => {
    expect(processDoorFindings(REPO).map((finding) => `${finding.path}:${String(finding.line)} ${finding.finding}`),
      "install the policy through bootstrapProcess({ role }) at an entry point, and start a worker thread as new Worker(...bootstrappedWorker(entry, role, options))").toEqual([]);
    const found = (source: string, path = "server/x.ts") => processDoorFindingsIn(source, path).map((finding) => finding.finding);
    expect(found("installProcessFaultPolicy({ role: 'cli' });")).toEqual(["install-outside-doors"]);
    expect(found("installProcessFaultPolicy({ role: 'server' });", relative(REPO, modulePath("process-fault-policy.ts")))).toEqual([]);
    expect(found("new Worker(url, { workerData });")).toEqual(["worker-without-prelude"]);
    expect(found("new workers.Worker(url);")).toEqual(["worker-without-prelude"]);
    expect(found("new Worker(url, { execArgv: [...process.execArgv] });")).toEqual(["worker-without-prelude"]);
    expect(found("new Worker(...other(url, 'worker'));")).toEqual(["worker-without-prelude"]);
    expect(found("new Worker(...bootstrappedWorker(url, 'worker', { workerData }));")).toEqual([]);
  });

  test("a bootstrapped worker thread runs under its role's policy before its entry loads, and keeps its own workerData", () => {
    const result = runNativeScript(`
      import assert from 'node:assert/strict';
      import { writeFileSync } from 'node:fs';import { join } from 'node:path';
      const { bootstrappedWorker } = await import(${moduleUrl("worker-bootstrap.ts")});
      const { Worker } = await import('node:worker_threads');
      const dir = ${JSON.stringify(createTempDir("prelude-"))};
      const entry = join(dir, 'entry.mjs');
      writeFileSync(entry, "import { parentPort, workerData } from 'node:worker_threads'; const p = await import(" + JSON.stringify(${moduleUrl("fault-policy.ts")}) + "); parentPort.postMessage({ role: p.processFaultRole() ?? 'none', mine: workerData.mine });");
      const run = (role) => new Promise((resolve, reject) => { const w = new Worker(...bootstrappedWorker(entry, role, { workerData: { mine: 7 } })); w.once('message', (m) => { resolve(m); void w.terminate(); }); w.once('error', reject); });
      assert.deepEqual(await run('worker'), { role: 'worker', mine: 7 });
      assert.deepEqual(await run('server-thread'), { role: 'server-thread', mine: 7 });
      // A thread whose boot record names no valid role refuses to start (no thread runs without its policy).
      const [prelude, options] = bootstrappedWorker(entry, 'worker');
      const tampered = Object.fromEntries(Object.entries(options.workerData).map(([key, value]) => [key, { ...value, role: 'nope' }]));
      const bad = await new Promise((resolve) => { const w = new Worker(prelude, { ...options, workerData: tampered }); w.once('error', (e) => resolve(String(e.message))); w.once('exit', () => resolve('exited')); });
      assert.match(bad, /boot record names no valid role/);
      assert.throws(() => bootstrappedWorker(entry, 'worker', { workerData: 5 }), { code: 'worker_data_not_object' });
      // An entry that fails to load ends its thread with exit 70 (its owner sees a thread that stopped before it was ready).
      const broken = join(dir, 'broken.mjs');
      writeFileSync(broken, "throw new Error('entry load failure');");
      const brokenExit = await new Promise((resolve) => { const w = new Worker(...bootstrappedWorker(broken, 'server-thread')); w.once('exit', resolve); });
      assert.equal(brokenExit, 70);
      console.log(JSON.stringify({ ok: true }));
    `);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  test("guarded attributes and counts a throw, returns undefined, and observes a rejected promise (in a service process, which lives on)", () => {
    // In a child: a process with NO role re-raises a guarded fault (Node's
    // default), so this test's own runner would rightly fail on it.
    const result = runNativeScript(`
      import assert from 'node:assert/strict';
      await import(${moduleUrl("process-fault-policy.ts")});
      const { guarded, processFaultCounts } = await import(${moduleUrl("fault-policy.ts")});
      const throwing = guarded("probe.sync", () => { throw new TypeError("boom"); });
      assert.equal(throwing(), undefined);
      const hostile = guarded("probe.hostile", () => { throw Object.create(null); });
      assert.equal(hostile(), undefined);
      const rejecting = guarded("probe.async", async () => { throw new RangeError("later"); });
      assert.equal(rejecting(), undefined);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(processFaultCounts().guardedCallbackFaults, 3);
      let seen = 0;
      guarded("probe.args", (a, b) => { seen = a + b; })(2, 3);
      assert.equal(seen, 5, "arguments reach the callback");
      console.log(JSON.stringify({ ok: true }));
    `);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stderr).toMatch(/callback fault in probe\.sync: TypeError: boom/u);
  });

  test("no user-defined SQL function is registered (closing a database inside one is a SIGSEGV)", () => {
    expect(sqliteUserFunctions(process.cwd()).map((finding) => `${finding.path}:${String(finding.line)} ${finding.registration}`)).toEqual([]);
    const found = (source: string) => sqliteUserFunctionsIn(source, "probe.ts").map((finding) => finding.registration);
    expect(found("db.function('lower2', (s) => s.toLowerCase()); db?.aggregate(`total`, { start: 0, step: (a, b) => a + b });")).toEqual(["function", "aggregate"]);
    expect(found("pipeline.function(handler); db.prepare('SELECT 1');")).toEqual([]);
  });
});
