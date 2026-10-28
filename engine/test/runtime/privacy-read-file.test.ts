import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createToolRegistry } from "../../src/runtime/tool-registry.ts";
import { mkTempDir } from "../support/temp-dir.ts";

/**
 * INT-14 regression: the read_file tool returned raw file content with no
 * redaction. The fix routed reads through the privacy file-viewer so detected
 * credential/PII spans are replaced before egress. This test writes files
 * containing several secret-signal patterns and verifies the read_file tool
 * redacts them (the raw secret never egresses) while preserving surrounding
 * structure.
 */

function readViaTool(root: string, path: string): string {
  const registry = createToolRegistry();
  const result = registry.execute(
    { id: "call-1", name: "read_file", arguments: JSON.stringify({ path }) },
    { repositoryRoot: root },
  );
  assert.equal(result.isError, false, `read_file failed: ${result.content}`);
  return result.content;
}

test("privacy-read-file: redacts sk_-prefixed API tokens (token-prefix signal)", () => {
  const dir = mkTempDir("privacy-read-file-");
  try {
    const secret = "sk_" + "a".repeat(40);
    writeFileSync(join(dir, "config.ts"), `const API_KEY = "${secret}";\nconst other = 42;`);
    const out = readViaTool(dir, "config.ts");
    assert.equal(out.includes(secret), false, "raw sk_ token must not egress");
    assert.ok(out.includes("[REDACTED"), `expected a redaction marker, got: ${out}`);
    assert.ok(out.includes("other"), "non-sensitive structure must be preserved");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("privacy-read-file: redacts AWS access keys (AKIA signal)", () => {
  const dir = mkTempDir("privacy-read-file-");
  try {
    const secret = "AKIA" + "IOSFODNN7EXAMPLE01".slice(0, 16);
    writeFileSync(join(dir, "aws.txt"), `aws_access_key_id = ${secret}`);
    const out = readViaTool(dir, "aws.txt");
    assert.equal(out.includes(secret), false, "raw AWS key must not egress");
    assert.ok(out.includes("[REDACTED"), `expected a redaction marker, got: ${out}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("privacy-read-file: redacts Bearer tokens (bearer-token signal)", () => {
  const dir = mkTempDir("privacy-read-file-");
  try {
    const secret = "Bearer " + "a".repeat(40);
    writeFileSync(join(dir, "headers.txt"), `Authorization: ${secret}\n`);
    const out = readViaTool(dir, "headers.txt");
    assert.equal(out.includes(secret), false, "raw bearer token must not egress");
    assert.ok(out.includes("[REDACTED"), `expected a redaction marker, got: ${out}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("privacy-read-file: redacts credential assignments (api_key = value)", () => {
  const dir = mkTempDir("privacy-read-file-");
  try {
    // Use a non-hex, non-underscore value so the credential-assignment signal
    // redacts it (the engine deliberately skips 32+ hex chars, which look like
    // SHA-256 hashes, and `X_Y` identifier-shaped values).
    const secret = "ZZ" + "k".repeat(40);
    writeFileSync(join(dir, "env.txt"), `api_key = ${secret}\nDEBUG=true`);
    const out = readViaTool(dir, "env.txt");
    assert.equal(out.includes(secret), false, "raw credential value must not egress");
    assert.ok(out.includes("[REDACTED"), `expected a redaction marker, got: ${out}`);
    assert.ok(out.includes("DEBUG"), "non-sensitive structure must be preserved");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("privacy-read-file: redacts PEM private key blocks (private-key signal)", () => {
  const dir = mkTempDir("privacy-read-file-");
  try {
    const pem = ("--" + "---BEGIN RSA PRIVATE KEY-----\nMIIEpAIKBgQDAQAB\n-----END RSA PRIVATE KEY-----");
    writeFileSync(join(dir, "id_rsa"), pem);
    const out = readViaTool(dir, "id_rsa");
    assert.ok(out.includes("[REDACTED"), `expected a redaction marker for the private key block, got: ${out}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("privacy-read-file: preserves non-sensitive content verbatim", () => {
  const dir = mkTempDir("privacy-read-file-");
  try {
    writeFileSync(join(dir, "plain.ts"), "export const x = 42;\nexport function add(a, b) { return a + b; }\n");
    const out = readViaTool(dir, "plain.ts");
    assert.equal(out, "export const x = 42;\nexport function add(a, b) { return a + b; }\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("privacy-read-file: redacts multiple secrets in one file", () => {
  const dir = mkTempDir("privacy-read-file-");
  try {
    const sk = "sk_" + "b".repeat(40);
    const aws = "AKIA" + "ABCDEFGHIJKLMNOP";
    writeFileSync(join(dir, "multi.txt"), `key1=${sk}\nkey2=${aws}\nnote=clean`);
    const out = readViaTool(dir, "multi.txt");
    assert.equal(out.includes(sk), false, "first secret must be redacted");
    assert.equal(out.includes(aws), false, "second secret must be redacted");
    assert.ok(out.includes("note=clean"), "non-sensitive line must be preserved");
    const redactionCount = (out.match(/\[REDACTED/gu) ?? []).length;
    assert.ok(redactionCount >= 2, `expected >=2 redaction markers, got ${redactionCount}: ${out}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("privacy-read-file: read_file tool definition describes redaction behavior", () => {
  const registry = createToolRegistry();
  const defs = registry.definitions();
  const readFile = defs.find((d) => d.function.name === "read_file");
  assert.ok(readFile !== undefined, "read_file tool must be registered");
  assert.ok(
    /redact/iu.test(readFile!.function.description),
    "read_file description must mention redaction (INT-14 contract)",
  );
});
