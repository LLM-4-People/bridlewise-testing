// @vitest-environment node
import { describe, test, expect } from "vitest";

import {
  resolveServerConfig,
  DEFAULT_PORT,
  DEFAULT_HOST,
  DEFAULT_ALLOWED_ORIGIN,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_SSE_KEEPALIVE_MS,
  DEFAULT_DB_SYNCHRONOUS,
} from "../../server/kernel/config.ts";
import { ConfigError } from "../../server/kernel/errors.ts";

describe("server config", () => {
  test("returns defaults when no env vars are set", () => {
    const cfg = resolveServerConfig({});
    expect(cfg.port).toBe(DEFAULT_PORT);
    expect(cfg.host).toBe(DEFAULT_HOST);
    expect(cfg.allowedOrigin).toBe(DEFAULT_ALLOWED_ORIGIN);
    expect(cfg.maxBodyBytes).toBe(DEFAULT_MAX_BODY_BYTES);
    expect(cfg.sseKeepaliveMs).toBe(DEFAULT_SSE_KEEPALIVE_MS);
  });

  test("respects env overrides", () => {
    const cfg = resolveServerConfig({
      HARNESS_WEB_PORT: "8080",
      HARNESS_WEB_HOST: "localhost",
      HARNESS_WEB_ALLOWED_ORIGIN: "http://example.com:3000",
      HARNESS_WEB_MAX_BODY_BYTES: "524288",
      HARNESS_WEB_SSE_KEEPALIVE_MS: "30000",
    });
    expect(cfg.port).toBe(8080);
    expect(cfg.host).toBe("localhost");
    expect(cfg.allowedOrigin).toBe("http://example.com:3000");
    expect(cfg.maxBodyBytes).toBe(524288);
    expect(cfg.sseKeepaliveMs).toBe(30000);
  });

  test("result is frozen (immutable)", () => {
    const cfg = resolveServerConfig({});
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  test("empty-string env values fall back to defaults", () => {
    const cfg = resolveServerConfig({ HARNESS_WEB_PORT: "" });
    expect(cfg.port).toBe(DEFAULT_PORT);
  });

  test("rejects out-of-range port", () => {
    // 0 is NOT out of range: it is the OS-assigned ephemeral bind, the only
    // way a launcher obtains a free port atomically (a chosen-then-closed
    // number is a probe a concurrent process can claim before the bind). The
    // kernel picks the real port, so 0 resolves to a valid config.
    const ephemeral = resolveServerConfig({ HARNESS_WEB_PORT: "0" });
    expect(ephemeral.port).toBe(0);
    expect(() => resolveServerConfig({ HARNESS_WEB_PORT: "-1" })).toThrow(ConfigError);
    expect(() => resolveServerConfig({ HARNESS_WEB_PORT: "-1" })).toThrow(/Invalid HARNESS_WEB_PORT/);
    expect(() => resolveServerConfig({ HARNESS_WEB_PORT: "70000" })).toThrow(ConfigError);
    expect(() => resolveServerConfig({ HARNESS_WEB_PORT: "70000" })).toThrow(/Invalid HARNESS_WEB_PORT/);
  });

  // CFG-0 B2: an invalid value used to become the default silently although
  // the doc said REFUSED — a durability choice nobody made.
  test("HARNESS_WEB_DB_SYNCHRONOUS: unset is the default, any case is accepted, an unknown value is refused at boot", () => {
    expect(resolveServerConfig({}).dbSynchronous).toBe(DEFAULT_DB_SYNCHRONOUS);
    expect(resolveServerConfig({ HARNESS_WEB_DB_SYNCHRONOUS: "full" }).dbSynchronous).toBe("FULL");
    expect(resolveServerConfig({ HARNESS_WEB_DB_SYNCHRONOUS: "" }).dbSynchronous).toBe(DEFAULT_DB_SYNCHRONOUS);
    for (const invalid of ["OF", "normal;DROP", "2"]) {
      expect(() => resolveServerConfig({ HARNESS_WEB_DB_SYNCHRONOUS: invalid })).toThrow(ConfigError);
      expect(() => resolveServerConfig({ HARNESS_WEB_DB_SYNCHRONOUS: invalid })).toThrow(/Invalid HARNESS_WEB_DB_SYNCHRONOUS: expected one of OFF, NORMAL, FULL, EXTRA/);
    }
  });

  test("rejects non-integer port", () => {
    expect(() => resolveServerConfig({ HARNESS_WEB_PORT: "3.5" })).toThrow(ConfigError);
    expect(() => resolveServerConfig({ HARNESS_WEB_PORT: "3.5" })).toThrow(/Invalid HARNESS_WEB_PORT/);
  });

  test("rejects out-of-range maxBodyBytes", () => {
    expect(() => resolveServerConfig({ HARNESS_WEB_MAX_BODY_BYTES: "0" })).toThrow(ConfigError);
    expect(() => resolveServerConfig({ HARNESS_WEB_MAX_BODY_BYTES: "0" })).toThrow(/Invalid HARNESS_WEB_MAX_BODY_BYTES/);
  });

  test("rejects out-of-range keepalive", () => {
    expect(() => resolveServerConfig({ HARNESS_WEB_SSE_KEEPALIVE_MS: "100" })).toThrow(ConfigError);
    expect(() => resolveServerConfig({ HARNESS_WEB_SSE_KEEPALIVE_MS: "100" })).toThrow(/Invalid HARNESS_WEB_SSE_KEEPALIVE_MS/);
    expect(() => resolveServerConfig({ HARNESS_WEB_SSE_KEEPALIVE_MS: "999999" })).toThrow(ConfigError);
    expect(() => resolveServerConfig({ HARNESS_WEB_SSE_KEEPALIVE_MS: "999999" })).toThrow(/Invalid HARNESS_WEB_SSE_KEEPALIVE_MS/);
  });

  test("table: defaults are within documented bounds", () => {
    const cfg = resolveServerConfig({});
    expect(cfg.port).toBeGreaterThanOrEqual(1);
    expect(cfg.port).toBeLessThanOrEqual(65535);
    expect(cfg.maxBodyBytes).toBeGreaterThanOrEqual(1);
    expect(cfg.sseKeepaliveMs).toBeGreaterThanOrEqual(1000);
  });
  test("connection probe has a bounded output allowance with a validated override", () => {
    expect(resolveServerConfig({}).providerTestMaxTokens).toBe(256);
    expect(resolveServerConfig({HARNESS_WEB_PROVIDER_TEST_MAX_TOKENS:"512"}).providerTestMaxTokens).toBe(512);
    for(const value of ["0","4097","1.5","Infinity","no"]){
      expect(()=>resolveServerConfig({HARNESS_WEB_PROVIDER_TEST_MAX_TOKENS:value})).toThrow(/HARNESS_WEB_PROVIDER_TEST_MAX_TOKENS/);
    }
  });
});
