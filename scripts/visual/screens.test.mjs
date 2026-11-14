// Browser regression for the actual visual runner. Install its pinned Chromium
// before invoking it; public smoke keeps its browser-free contract.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { chromium } from "playwright";

import { ensureTestProcessSupervisor } from "../../engine/guardian/build.ts";
import { sha256 } from "../../engine/src/kernel/integrity.ts";
import { superviseCommand } from "../../engine/src/process/supervised-run.ts";
import { readWebSuiteWatchdog } from "../../tests/helpers/budget-config.ts";
import { TEST_HANG_BACKSTOP_MS } from "../../tests/test-budget.ts";
import { gate, shots, shotName } from "./plan.ts";
import { run } from "./screens.ts";

const PAGES = ["/", "/same/", "/changed/"];

// No fonts, resources, timers or animation enter these pictures. The script
// changes the solid background on each navigation, so the runner's two
// same-head captures differ without a wall-clock race or a patched adapter.
const page = (colour, script = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Visual runner fixture</title><style>html{background:${colour}}body{margin:0}</style>${script}</head><body></body></html>`;
const UNSTABLE = `<script>const next=Number(sessionStorage.getItem("navigation")??"0")+1;sessionStorage.setItem("navigation",String(next));document.documentElement.style.background=["#112233","#445566","#778899"][next%3];</script>`;

function fixture(root, name, index, same, changed) {
  const dir = join(root, name);
  mkdirSync(join(dir, "same"), { recursive: true });
  mkdirSync(join(dir, "changed"));
  writeFileSync(join(dir, "index.html"), index);
  writeFileSync(join(dir, "same", "index.html"), same);
  writeFileSync(join(dir, "changed", "index.html"), changed);
  return dir;
}

test("the real runner retains both unstable head captures, their bound diff and report links, while preserving every verdict", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "bridlewise-visual-runner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = fixture(root, "base", page("#112233"), page("#112233"), page("#112233"));
  const head = fixture(root, "head", page("#112233", UNSTABLE), page("#112233"), page("#ddeeff"));
  const out = join(root, "report");
  const result = await run({ base, head, out, baseurl: "/visual-proof", pages: PAGES, changeDeclared: true });
  const saved = JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
  const html = readFileSync(join(out, "report.html"), "utf8");
  assert.deepEqual(saved.comparisons, result.comparisons);
  assert.equal(result.pass, false, "a declaration cannot accept an unstable page");
  assert.equal(saved.pass, false);
  assert.deepEqual(result.comparisons.map((c) => c.name), shots(PAGES).map(shotName));

  const unstable = result.comparisons.filter((c) => c.name.startsWith("home--"));
  const stable = result.comparisons.filter((c) => c.name.startsWith("same--"));
  const intentional = result.comparisons.filter((c) => c.name.startsWith("changed--"));
  assert.ok(unstable.length > 0 && stable.length > 0 && intentional.length > 0);
  assert.ok(unstable.every((c) => c.verdict === "unstable"));
  assert.ok(stable.every((c) => c.verdict === "same"));
  assert.ok(intentional.every((c) => c.verdict === "changed"));
  assert.deepEqual(gate(stable, { changeDeclared: false }), { pass: true, reasons: [] });
  assert.equal(gate(intentional, { changeDeclared: false }).pass, false);
  assert.equal(gate(intentional, { changeDeclared: true }).pass, true);
  assert.equal(gate(unstable, { changeDeclared: true }).pass, false);

  for (const comparison of unstable) {
    assert.deepEqual(Object.keys(comparison.stability).sort(), ["diff", "first", "second"]);
    const { first, second, diff } = comparison.stability;
    assert.equal(new Set([first.path, second.path, diff.path]).size, 3);
    for (const image of [first, second, diff]) {
      const bytes = readFileSync(join(out, image.path));
      assert.equal(image.bytes, bytes.byteLength);
      assert.equal(image.sha256, sha256(bytes), image.path);
      assert.ok(html.includes(`src="${image.path}"`), `${image.path} is shown by the report`);
      assert.ok(html.includes(image.sha256), `${image.path} is visibly bound to its bytes`);
    }
    const firstBytes = readFileSync(join(out, first.path));
    const secondBytes = readFileSync(join(out, second.path));
    assert.equal(firstBytes.equals(secondBytes), false);
    assert.notEqual(first.sha256, second.sha256);
    // The fixture changes every pixel; the production difference() owns the
    // count. PNG IHDR supplies the actual image dimensions independently.
    const width = firstBytes.readUInt32BE(16);
    const height = firstBytes.readUInt32BE(20);
    assert.equal(comparison.totalPixels, width * height);
    assert.equal(comparison.changedPixels, comparison.totalPixels);
    assert.ok(comparison.totalPixels > 0);
    assert.equal(secondBytes.readUInt32BE(16), width);
    assert.equal(secondBytes.readUInt32BE(20), height);
    const diffBytes = readFileSync(join(out, diff.path));
    assert.equal(diffBytes.readUInt32BE(16), width);
    assert.equal(diffBytes.readUInt32BE(20), height);
  }
});


/** Real listener state, rather than a close mock that can agree with itself. */
function lifecycleFixture(t, beforeListen) {
  const root = mkdtempSync(join(tmpdir(), "bridlewise-visual-lifecycle-"));
  const base = fixture(root, "base", page("#112233"), page("#112233"), page("#112233"));
  const head = fixture(root, "head", page("#112233"), page("#112233"), page("#112233"));
  const servers = [];
  const closed = new Set();
  const started = new Set();
  const listen = Server.prototype.listen;
  t.mock.method(Server.prototype, "listen", function (...args) {
    servers.push(this);
    this.once("close", () => closed.add(this));
    this.once("listening", () => started.add(this));
    if (beforeListen?.(this, servers.length) === false) return this;
    return Reflect.apply(listen, this, args);
  });
  t.after(async () => {
    // The original implementation is a negative control: its listeners can
    // still be open when our assertion fails. Retain that failure, then close
    // the fixture's own listeners so the control does not hang its caller.
    try {
      await Promise.all(servers.filter((server) => server.listening).map((server) =>
        new Promise((resolveClose, rejectClose) => {
          server.close((error) => error === undefined ? resolveClose() : rejectClose(error));
          server.closeAllConnections();
        })));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  return {
    root,
    servers,
    closed,
    started,
    options: { base, head, out: join(root, "report"), baseurl: "/visual-lifecycle", pages: [], changeDeclared: true },
    assertServersClosed() {
      assert.equal(servers.length, 2, "both built sites acquired a real HTTP listener");
      assert.equal(closed.size, servers.length, "run awaited every acquired server's close event");
      for (const server of servers) {
        assert.equal(server.listening, false, "the acquired listener stopped accepting connections");
        assert.equal(server.address(), null, "the acquired listener released its address");
        assert.ok(closed.has(server), "this acquired listener completed its close");
      }
    },
  };
}

function errorLeaves(error) {
  return error instanceof AggregateError ? error.errors.flatMap(errorLeaves) : [error];
}

test("an absent browser executable preserves the actual launch refusal and closes both site listeners", { concurrency: false }, async (t) => {
  const scene = lifecycleFixture(t);
  const launch = chromium.launch.bind(chromium);
  const absent = join(scene.root, "intentionally-absent-chromium");
  t.mock.method(chromium, "launch", (options) => launch({ ...options, executablePath: absent }));
  await assert.rejects(run(scene.options), (error) => {
    assert.ok(errorLeaves(error).some((leaf) => leaf instanceof Error && leaf.message.includes(absent)),
      "the real Playwright refusal names the intentionally absent executable");
    return true;
  });
  scene.assertServersClosed();
});

test("a browser launch rejection closes both acquired site listeners", { concurrency: false }, async (t) => {
  const scene = lifecycleFixture(t);
  const primary = new Error("planted-browser-launch-refusal");
  t.mock.method(chromium, "launch", async () => { throw primary; });
  await assert.rejects(run(scene.options), (error) => {
    assert.ok(errorLeaves(error).includes(primary), "the original launch failure is retained");
    return true;
  });
  scene.assertServersClosed();
});

test("a differ page startup rejection closes the acquired browser and both site listeners", { concurrency: false }, async (t) => {
  const scene = lifecycleFixture(t);
  const primary = new Error("planted-differ-page-refusal");
  let browserCloses = 0;
  t.mock.method(chromium, "launch", async () => ({
    newPage: async () => { throw primary; },
    close: async () => { browserCloses += 1; },
  }));
  await assert.rejects(run(scene.options), (error) => {
    assert.ok(errorLeaves(error).includes(primary), "the original page startup failure is retained");
    return true;
  });
  assert.equal(browserCloses, 1, "the successfully acquired browser was closed once");
  scene.assertServersClosed();
});

test("a body failure and browser close rejection are both retained while contexts and both servers close", { concurrency: false }, async (t) => {
  const scene = lifecycleFixture(t);
  const primary = new Error("planted-shot-page-refusal");
  const teardown = new Error("planted-browser-close-refusal");
  let contextCloses = 0;
  let listeningAtBrowserClose;
  t.mock.method(chromium, "launch", async () => ({
    newPage: async () => ({}),
    newContext: async () => ({
      addInitScript: async () => {},
      newPage: async () => { throw primary; },
      close: async () => { contextCloses += 1; },
    }),
    close: async () => {
      listeningAtBrowserClose = scene.servers.map((server) => server.listening);
      throw teardown;
    },
  }));
  await assert.rejects(run({ ...scene.options, pages: ["/"] }), (error) => {
    assert.ok(error instanceof AggregateError, "a teardown rejection cannot replace the body's failure");
    assert.ok(error.errors.includes(primary), "the body failure remains a first-class error");
    assert.ok(error.errors.includes(teardown), "the browser close failure remains a first-class error");
    return true;
  });
  assert.equal(contextCloses, 1, "the failed shot's acquired context was closed once");
  assert.deepEqual(listeningAtBrowserClose, [false, false], "both server closes started before browser close was awaited");
  scene.assertServersClosed();
});

test("a browser close rejection after a completed body still closes both site listeners and refuses the run", { concurrency: false }, async (t) => {
  const scene = lifecycleFixture(t);
  const teardown = new Error("planted-browser-only-close-refusal");
  let listeningAtBrowserClose;
  t.mock.method(chromium, "launch", async () => ({
    newPage: async () => ({}),
    close: async () => {
      listeningAtBrowserClose = scene.servers.map((server) => server.listening);
      throw teardown;
    },
  }));
  await assert.rejects(run(scene.options), (error) => {
    assert.ok(errorLeaves(error).includes(teardown), "the teardown failure is not converted to a successful verdict");
    return true;
  });
  assert.deepEqual(listeningAtBrowserClose, [false, false], "server close admission does not depend on browser close succeeding");
  scene.assertServersClosed();
});

test("a body failure and context close rejection are both retained while browser and server cleanup continues", { concurrency: false }, async (t) => {
  const scene = lifecycleFixture(t);
  const primary = new Error("planted-context-page-refusal");
  const teardown = new Error("planted-context-close-refusal");
  let browserCloses = 0;
  t.mock.method(chromium, "launch", async () => ({
    newPage: async () => ({}),
    newContext: async () => ({
      addInitScript: async () => {},
      newPage: async () => { throw primary; },
      close: async () => { throw teardown; },
    }),
    close: async () => { browserCloses += 1; },
  }));
  await assert.rejects(run({ ...scene.options, pages: ["/"] }), (error) => {
    assert.ok(error instanceof AggregateError, "context teardown cannot replace the body failure");
    assert.ok(errorLeaves(error).includes(primary), "the original context work failure is retained");
    assert.ok(errorLeaves(error).includes(teardown), "the context close failure is retained");
    return true;
  });
  assert.equal(browserCloses, 1, "context cleanup failure does not suppress browser cleanup");
  scene.assertServersClosed();
});


test("a context initialization rejection closes its acquired context, browser and both site listeners", { concurrency: false }, async (t) => {
  const scene = lifecycleFixture(t);
  const primary = new Error("planted-context-init-refusal");
  let contextCloses = 0;
  let browserCloses = 0;
  let shotPages = 0;
  t.mock.method(chromium, "launch", async () => ({
    newPage: async () => ({}),
    newContext: async () => ({
      addInitScript: async () => { throw primary; },
      newPage: async () => {
        shotPages += 1;
        throw new Error("a rejected initialization cannot open a shot page");
      },
      close: async () => { contextCloses += 1; },
    }),
    close: async () => { browserCloses += 1; },
  }));
  await assert.rejects(run({ ...scene.options, pages: ["/"] }), (error) => {
    assert.ok(errorLeaves(error).includes(primary), "the original initialization failure is retained");
    return true;
  });
  assert.equal(shotPages, 0, "no shot work starts after initialization rejected");
  assert.equal(contextCloses, 1, "the context acquired before initialization was closed once");
  assert.equal(browserCloses, 1, "initialization failure does not suppress browser cleanup");
  scene.assertServersClosed();
});

test("a second listener startup error closes the first acquired listener and retains the actual startup error", { concurrency: false }, async (t) => {
  const primary = new Error("planted-second-listener-startup-refusal");
  const scene = lifecycleFixture(t, (server, attempt) => {
    if (attempt !== 2) return;
    // The production serve owner must listen for the native error before
    // starting the listener. The second attempt never acquires an address.
    queueMicrotask(() => server.emit("error", primary));
    return false;
  });
  let browserLaunches = 0;
  t.mock.method(chromium, "launch", async () => {
    browserLaunches += 1;
    throw new Error("a browser cannot launch after listener startup rejected");
  });
  await assert.rejects(run(scene.options), (error) => {
    assert.ok(errorLeaves(error).includes(primary), "the exact native listener error remains observable");
    return true;
  });
  assert.equal(browserLaunches, 0, "browser startup never begins after the second listener refused");
  assert.equal(scene.servers.length, 2, "both listener attempts were observed");
  const [first, second] = scene.servers;
  assert.equal(scene.started.size, 1, "only the first listener acquired an address");
  assert.ok(scene.started.has(first), "the first listener really started before the second attempt");
  assert.equal(scene.started.has(second), false, "the refused second attempt was never acquired");
  assert.ok(scene.closed.has(first), "the first acquired listener completed its close before run rejected");
  for (const server of scene.servers) {
    assert.equal(server.listening, false, "no listener remains accepting connections after startup refused");
    assert.equal(server.address(), null, "neither the closed listener nor the refused attempt holds an address");
  }
});


test("a pending browser close releases both listeners and remains a refused supervised invocation", { concurrency: false }, async (t) => {
  const scene = lifecycleFixture(t);
  const child = join(scene.root, "pending-close.mjs");
  const marker = "pending-browser-close";
  const script = `import { mock } from "node:test";
import { Server } from "node:http";
import { chromium } from ${JSON.stringify(import.meta.resolve("playwright"))};
import { run } from ${JSON.stringify(new URL("./screens.ts", import.meta.url).href)};
const servers = [], closed = new Set();
const listen = Server.prototype.listen;
mock.method(Server.prototype, "listen", function (...args) {
  servers.push(this);
  this.once("close", () => closed.add(this));
  return Reflect.apply(listen, this, args);
});
mock.method(chromium, "launch", async () => ({
  newPage: async () => ({}),
  close: () => {
    // Keep this deliberately unresolved fixture alive until its existing
    // supervisor stops it. This is no browser-termination or timer verdict.
    setInterval(() => {}, 1_000);
    const report = () => process.stdout.write(JSON.stringify({
      kind: ${JSON.stringify(marker)}, created: servers.length,
      listening: servers.map((server) => server.listening),
      addressesReleased: servers.map((server) => server.address() === null),
      closed: closed.size,
    }) + "\\n");
    if (servers.some((server) => server.listening)) report();
    else Promise.all(servers.map((server) => closed.has(server) ? Promise.resolve() :
      new Promise((closedServer) => server.once("close", closedServer)))).then(report);
    return new Promise(() => {});
  },
}));
await run(${JSON.stringify(scene.options)});
`;
  writeFileSync(child, script);
  const watchdog = readWebSuiteWatchdog();
  assert.equal("missing" in watchdog, false, "the existing web supervisor bounds are declared");
  const stop = new AbortController();
  let stdout = "";
  let stderr = "";
  const outcome = await superviseCommand({
    supervisor: ensureTestProcessSupervisor(), command: process.execPath,
    args: ["--experimental-strip-types", child],
    hardCeilingMs: TEST_HANG_BACKSTOP_MS, killGraceMs: watchdog.killGraceMs,
    stop: stop.signal,
    onStdout: (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.split("\n").slice(0, -1).some((line) => line.includes(`"kind":"${marker}"`))) stop.abort();
    },
    onStderr: (chunk) => { stderr += chunk.toString("utf8"); },
  });
  const line = stdout.split("\n").find((entry) => entry.includes(`"kind":"${marker}"`));
  assert.ok(line, `the pending cleanup produced its listener observation: ${stderr}`);
  const observed = JSON.parse(line);
  assert.equal(observed.created, 2);
  assert.deepEqual(observed.listening, [false, false], "both listeners closed before the pending browser close could settle");
  assert.deepEqual(observed.addressesReleased, [true, true]);
  assert.equal(observed.closed, observed.created, "both real listener close events completed");
  assert.equal(outcome.ending, "stopped", "pending cleanup remains a stopped invocation, never a passing visual check");
  assert.notEqual(outcome.exitCode, 0);
  assert.equal(outcome.supervision?.interrupted, true);
  assert.equal(outcome.supervision?.noOwnedChildren, true, "the existing supervisor closed its actually owned process tree");
  assert.equal(outcome.outputComplete, true, "the native terminal retained the fixture's complete diagnostic output");
  // Chromium is mocked in this control. The receipt proves this fixture's
  // owned invocation ended; it does not assert an actual Chromium was killed.
});
