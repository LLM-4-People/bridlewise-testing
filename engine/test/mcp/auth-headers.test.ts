import assert from "node:assert/strict";
import test from "node:test";

import { authEnv, authHeaders, mergeHeaders, canonicalHeaderName, redactHeaders } from "../../src/mcp/index.ts";

test("auth: api-key produces a header (default X-API-Key)", () => {
  const h = authHeaders({ type: "api-key", token: "abc123" });
  assert.deepEqual(h, { "X-API-Key": "abc123" });
});

test("auth: api-key uses a custom header name", () => {
  const h = authHeaders({ type: "api-key", token: "abc123", header: "X-Brave-Key" });
  assert.deepEqual(h, { "X-Brave-Key": "abc123" });
});

test("auth: bearer produces Authorization: Bearer <token>", () => {
  const h = authHeaders({ type: "bearer", token: "tok" });
  assert.deepEqual(h, { Authorization: "Bearer tok" });
});

test("auth: oauth is treated as bearer for transport headers", () => {
  const h = authHeaders({ type: "oauth", token: "oa-token" });
  assert.deepEqual(h, { Authorization: "Bearer oa-token" });
});

test("auth: undefined auth produces no headers", () => {
  assert.deepEqual(authHeaders(undefined), {});
});

test("auth: api-key on stdio injects env var when envName is set", () => {
  const env = authEnv({ type: "api-key", token: "k", envName: "BRAVE_API_KEY" });
  assert.deepEqual(env, { BRAVE_API_KEY: "k" });
});

test("auth: bearer on stdio injects env var when envName is set (e.g. GITHUB_PERSONAL_ACCESS_TOKEN)", () => {
  const env = authEnv({ type: "bearer", token: "ghp_x", envName: "GITHUB_PERSONAL_ACCESS_TOKEN" });
  assert.deepEqual(env, { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_x" });
});

test("auth: api-key on stdio without envName produces no env", () => {
  const env = authEnv({ type: "api-key", token: "k" });
  assert.deepEqual(env, {});
});

test("headers: mergeHeaders later sources win", () => {
  const h = mergeHeaders({ "X-A": "1", Authorization: "first" }, { Authorization: "second" });
  assert.equal(h["Authorization"], "second");
  assert.equal(h["X-A"], "1");
});

test("headers: mergeHeaders canonicalizes names", () => {
  const h = mergeHeaders({ "x-custom-header": "v", "CONTENT-TYPE": "application/json" });
  assert.equal(h["X-Custom-Header"], "v");
  assert.equal(h["Content-Type"], "application/json");
});

test("headers: canonicalHeaderName capitalizes each dash segment", () => {
  assert.equal(canonicalHeaderName("authorization"), "Authorization");
  assert.equal(canonicalHeaderName("x-api-key"), "X-Api-Key");
  assert.equal(canonicalHeaderName("Content-Type"), "Content-Type");
});

test("headers: redactHeaders masks the credential-bearing headers (isSensitiveHeaderName) and passes the rest", () => {
  const r = redactHeaders({ Authorization: "Bearer secret123", "X-Api-Key": "k", "Accept": "application/json" });
  assert.equal(r["Authorization"], "<redacted:16>"); // "Bearer secret123" is 16 chars
  assert.equal(r["X-Api-Key"], "<redacted:1>");
  assert.equal(r["Accept"], "application/json");
});
