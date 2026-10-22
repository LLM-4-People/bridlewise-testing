/**
 * THE HEADER DENYLIST (#364): one owner, `isSensitiveHeaderName` (src/privacy/secret-signals.ts), answers
 * whether a header name carries a credential, case-insensitively, as a denylist by default. Every header
 * redaction (`redactHeaders`, src/mcp/headers.ts) asks it, never a list of its own.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { redactHeaders } from "../../src/mcp/headers.ts";
import { isSensitiveHeaderName } from "../../src/privacy/secret-signals.ts";

/** Measured missed before the denylist: `Authentication`, `X-Authentication`, `Ocp-Apim-Subscription-Key`. */
const CREDENTIAL_BEARING = [
  "Authorization", "Proxy-Authorization", "Authentication", "X-Authentication",
  "Cookie", "Set-Cookie", "X-Auth-Token", "X-Csrf-Token", "Private-Token", "X-Vault-Token", "X-Amz-Security-Token",
  "X-Api-Key", "Api-Key", "Ocp-Apim-Subscription-Key", "X-Goog-Api-Key",
];
const PLAIN = ["Accept", "User-Agent", "Content-Type", "Content-Length", "If-None-Match", "Keep-Alive", "X-Key-Id"];

test("every credential-bearing header shape is flagged in any case; plain headers are not", () => {
  for (const name of CREDENTIAL_BEARING) {
    for (const spelling of [name, name.toLowerCase(), name.toUpperCase()]) assert.equal(isSensitiveHeaderName(spelling), true, spelling);
  }
  for (const name of PLAIN) {
    for (const spelling of [name, name.toLowerCase(), name.toUpperCase()]) assert.equal(isSensitiveHeaderName(spelling), false, spelling);
  }
});

test("redactHeaders masks exactly what the one owner names, and passes everything else through", () => {
  const headers = Object.fromEntries([...CREDENTIAL_BEARING, ...PLAIN].map((name) => [name, `value-of-${name}`]));
  const redacted = redactHeaders(headers);
  for (const name of CREDENTIAL_BEARING) assert.equal(redacted[name], `<redacted:${`value-of-${name}`.length}>`, name);
  for (const name of PLAIN) assert.equal(redacted[name], `value-of-${name}`, name);
  assert.equal(redactHeaders({ cookie: "a=b" })["cookie"], "<redacted:3>", "a lower-case Cookie is a cookie");
});
