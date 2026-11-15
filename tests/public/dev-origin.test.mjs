import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_DEV_ORIGIN, resolveDevOrigin } from "../../shared/dev-origin.ts";
import { serverLaunchEnvironment, serverManagerLaunchEnvironment } from "../../scripts/sd-stale-classifier.ts";
import { resolveServerConfig } from "../../server/kernel/config.ts";

const workspace = Object.freeze({ CODESPACES: "true", CODESPACE_NAME: "careful-horse-example", GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "app.github.dev" });
const expected = "https://careful-horse-example-5173.app.github.dev";

function resolved(env) {
  const value = resolveDevOrigin(env);
  assert.equal(value.ok, true);
  return value;
}

test("local defaults preserve loopback transport and non-Secure cookies", () => {
  const value = resolved({});
  assert.equal(value.origin, DEFAULT_DEV_ORIGIN);
  assert.equal(value.source, "local");
  assert.equal(value.forwardedHostname, undefined);
  assert.equal(resolveServerConfig({}).cookieSecure, false);
});

test("one declared workspace origin reaches server and both launch branches", () => {
  const value = resolved(workspace);
  assert.equal(value.origin, expected);
  assert.equal(value.forwardedHostname, "careful-horse-example-5173.app.github.dev");
  assert.equal(value.source, "codespaces");
  assert.equal(resolveServerConfig(workspace).allowedOrigin, expected);
  assert.equal(resolveServerConfig(workspace).cookieSecure, true);
  const caller = { ...workspace, PATH: "/usr/bin", HOME: "/scratch/home", XDG_RUNTIME_DIR: "/scratch/manager", DBUS_SESSION_BUS_ADDRESS: "unix:path=/scratch/manager/bus", UNRELATED_TOKEN: "dummy-control-only", NODE_OPTIONS: "--require=unrelated", HARNESS_API_KEY: "dummy-control-only" };
  const child = serverLaunchEnvironment(caller);
  const manager = serverManagerLaunchEnvironment(caller, child);
  assert.equal(child.HARNESS_WEB_ALLOWED_ORIGIN, expected);
  assert.equal(manager.HARNESS_WEB_ALLOWED_ORIGIN, expected);
  assert.equal(manager.XDG_RUNTIME_DIR, caller.XDG_RUNTIME_DIR);
  assert.equal(manager.DBUS_SESSION_BUS_ADDRESS, caller.DBUS_SESSION_BUS_ADDRESS);
  assert.equal(child.XDG_RUNTIME_DIR, undefined);
  assert.equal(child.DBUS_SESSION_BUS_ADDRESS, undefined);
  assert.equal(resolved(child).origin, value.origin);
  for (const name of ["CODESPACES", "CODESPACE_NAME", "GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN", "UNRELATED_TOKEN", "NODE_OPTIONS", "HARNESS_API_KEY"]) {
    assert.equal(Object.hasOwn(child, name), false, name);
    assert.equal(Object.hasOwn(manager, name), false, name);
  }
});

test("an explicit valid origin remains authoritative and is canonicalized once", () => {
  const caller = { ...workspace, CODESPACE_NAME: "invalid/name", HARNESS_WEB_ALLOWED_ORIGIN: "https://personal.example.invalid:443/" };
  const value = resolved(caller);
  assert.equal(value.origin, "https://personal.example.invalid");
  assert.equal(value.source, "configured");
  assert.equal(resolved(serverLaunchEnvironment(caller)).origin, value.origin);
  assert.equal(resolveServerConfig(caller).allowedOrigin, value.origin);
});

test("configured loopback origins keep local proxy mode; suffixes do not become loopback", () => {
  for (const origin of ["http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173"]) assert.equal(resolved({ HARNESS_WEB_ALLOWED_ORIGIN: origin }).forwardedHostname, undefined);
  assert.equal(resolved({ HARNESS_WEB_ALLOWED_ORIGIN: "https://localhost.evil.invalid" }).forwardedHostname, "localhost.evil.invalid");
});

for (const value of ["https://user:dummy-secret@example.invalid", "https://@example.invalid", "https://.example.invalid", "https://%2eexample.invalid", "https://。example.invalid", "https://example.invalid/task", "https://example.invalid/a/..", "https://example.invalid?", "https://example.invalid#", "https://example.invalid?query=1", "https://example.invalid#fragment", "https:example.invalid", "https://example.invalid\\other", " https://example.invalid", "https://example.invalid\n", "file:///workspace", "null"]) {
  test(`invalid configured origin refuses without echoing its input: ${JSON.stringify(value).replace(/dummy-secret/g, "redacted")}`, () => {
    const result = resolveDevOrigin({ HARNESS_WEB_ALLOWED_ORIGIN: value });
    assert.equal(result.ok, false);
    assert.match(result.reason, /HARNESS_WEB_ALLOWED_ORIGIN/);
    assert.equal(result.reason.includes(value), false);
    assert.equal(result.reason.includes("dummy-secret"), false);
    assert.throws(() => serverLaunchEnvironment({ HARNESS_WEB_ALLOWED_ORIGIN: value }), /Invalid HARNESS_WEB_ALLOWED_ORIGIN/);
    assert.throws(() => resolveServerConfig({ HARNESS_WEB_ALLOWED_ORIGIN: value }), /Invalid HARNESS_WEB_ALLOWED_ORIGIN/);
  });
}

test("the actual Vite proxy rewrites only the declared forwarded authority", async () => {
  const previous = process.env.HARNESS_WEB_ALLOWED_ORIGIN;
  process.env.HARNESS_WEB_ALLOWED_ORIGIN = expected;
  try {
    const { BUILD_CONFIG } = await import("../../vite.config.ts?forwarded-origin-control");
    assert.deepEqual(BUILD_CONFIG.server.allowedHosts, [new URL(expected).hostname]);
    const proxy = BUILD_CONFIG.server.proxy["/api"];
    assert.equal(proxy.changeOrigin, false);
    let onProxyRequest;
    proxy.configure({ on(event, handler) {
      assert.equal(event, "proxyReq");
      onProxyRequest = handler;
    } });
    assert.equal(typeof onProxyRequest, "function");
    for (const incomingHost of [new URL(expected).host, "127.0.0.1:5173", "localhost:5173", "evil.localhost", "192.0.2.1", "unconfigured.example.invalid", undefined]) {
      const changed = [];
      onProxyRequest({ setHeader(name, value) { changed.push([name, value]); } }, { headers: { host: incomingHost } });
      assert.deepEqual(changed, incomingHost === new URL(expected).host ? [["host", new URL(proxy.target).host]] : [], String(incomingHost));
    }
  } finally {
    if (previous === undefined) delete process.env.HARNESS_WEB_ALLOWED_ORIGIN;
    else process.env.HARNESS_WEB_ALLOWED_ORIGIN = previous;
  }
});

for (const value of [{ CODESPACES: "true" }, { CODESPACE_NAME: "" }, { ...workspace, CODESPACE_NAME: "bad.name" }, { ...workspace, CODESPACE_NAME: "-bad" }, { ...workspace, CODESPACE_NAME: "bad-" }, { ...workspace, CODESPACE_NAME: "x".repeat(60) }, { ...workspace, GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "https://app.github.dev" }, { ...workspace, GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "app.github.dev/other" }, { ...workspace, GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "app.github.dev:443" }, { ...workspace, GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: ".app.github.dev" }, { ...workspace, GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: "app..github.dev" }]) {
  test(`incomplete or malformed declared workspace refuses: ${JSON.stringify(value)}`, () => {
    assert.equal(resolveDevOrigin(value).ok, false);
    assert.throws(() => serverLaunchEnvironment(value), /Invalid/);
    assert.throws(() => resolveServerConfig(value), /Invalid/);
  });
}
