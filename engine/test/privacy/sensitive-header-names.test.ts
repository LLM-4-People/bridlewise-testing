/**
 * THE HEADER RULE (#364): one owner, `isSensitiveHeaderName` (src/privacy/secret-signals.ts), answers whether
 * a header's value may carry a credential. It is an ALLOWLIST: only the names known to be credential-free
 * (`NON_CREDENTIAL_HEADER_NAMES`) pass, case-insensitively, and every other name is a credential by default.
 * Every header redaction (`redactHeaders`, src/mcp/headers.ts) asks it, never a list of its own.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { redactHeaders } from "../../src/mcp/headers.ts";
import { isSensitiveHeaderName, NON_CREDENTIAL_HEADER_NAMES } from "../../src/privacy/secret-signals.ts";

/**
 * Credential-bearing names, including those a denylist missed: `Authentication`, `X-Authentication`,
 * `Ocp-Apim-Subscription-Key` (measured), and the review's `X-Jwt`, `DPoP`, `X-Session`, `Session-Id`,
 * `X-Signature` and `X-Access-Key-Id`.
 */
const CREDENTIAL_BEARING = [
  "Authorization", "Proxy-Authorization", "Authentication", "X-Authentication",
  "Cookie", "Set-Cookie", "X-Auth-Token", "X-Csrf-Token", "Private-Token", "X-Vault-Token", "X-Amz-Security-Token",
  "X-Api-Key", "Api-Key", "Ocp-Apim-Subscription-Key", "X-Goog-Api-Key",
  "X-Jwt", "DPoP", "X-Session", "Session-Id", "Mcp-Session-Id", "X-Signature", "X-Access-Key-Id",
];

/** Spellings of a name a header can arrive in. */
const spellings = (name: string): readonly string[] => [name, name.toLowerCase(), name.toUpperCase()];

test("every credential-bearing header, in any case, is sensitive", () => {
  for (const name of CREDENTIAL_BEARING) for (const spelling of spellings(name)) assert.equal(isSensitiveHeaderName(spelling), true, spelling);
});

test("a header whose value is a URL is sensitive: a redirect to a signed download carries its token in the query string", () => {
  const signed = "https://objects.example.net/release-asset/123?X-Amz-Signature=0123abcd&X-Amz-Credential=AKIDEXAMPLE&token=t0k3n#frag";
  const link = `<${signed}>; rel="next"`;
  for (const name of ["Location", "Link", "Content-Location", "Refresh"]) for (const spelling of spellings(name)) assert.equal(isSensitiveHeaderName(spelling), true, spelling);
  const redacted = redactHeaders({ Location: signed, Link: link, "Content-Type": "application/octet-stream" });
  assert.equal(redacted["Location"], `<redacted:${signed.length}>`);
  assert.equal(redacted["Link"], `<redacted:${link.length}>`);
  assert.equal(redacted["Content-Type"], "application/octet-stream");
  assert.ok(!JSON.stringify(redacted).includes("0123abcd") && !JSON.stringify(redacted).includes("t0k3n"), "no part of the signed URL survives");
});

test("a header nobody has named is sensitive BY DEFAULT", () => {
  for (let index = 0; index < 32; index += 1) {
    const unknown = `X-${randomBytes(6).toString("hex")}`;
    assert.equal(isSensitiveHeaderName(unknown), true, unknown);
  }
});

test("each allowlisted header, in any case, is not sensitive", () => {
  assert.ok(NON_CREDENTIAL_HEADER_NAMES.size > 0);
  const title = (name: string) => name.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("-");
  for (const name of NON_CREDENTIAL_HEADER_NAMES) {
    for (const spelling of [...spellings(name), title(name)]) assert.equal(isSensitiveHeaderName(spelling), false, spelling);
  }
});

test("redactHeaders masks every header the owner calls sensitive and passes only the allowlisted ones", () => {
  const unknown = `X-${randomBytes(6).toString("hex")}`;
  const names = [...CREDENTIAL_BEARING, unknown, ...NON_CREDENTIAL_HEADER_NAMES];
  const redacted = redactHeaders(Object.fromEntries(names.map((name) => [name, `value-of-${name}`])));
  for (const name of [...CREDENTIAL_BEARING, unknown]) assert.equal(redacted[name], `<redacted:${`value-of-${name}`.length}>`, name);
  for (const name of NON_CREDENTIAL_HEADER_NAMES) assert.equal(redacted[name], `value-of-${name}`, name);
});
