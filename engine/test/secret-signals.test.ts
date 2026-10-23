import assert from "node:assert/strict";
import test from "node:test";

import {
  hasSecretTextSignal,
  secretTextSignalIds,
  type SecretSignalProfile,
} from "../src/privacy/secret-signals.ts";

const admission = "admission" as const satisfies SecretSignalProfile;

function credentialAssignmentMatches(value: string): boolean {
  return secretTextSignalIds(value, admission).includes("credential-assignment");
}

test("credential-assignment does not match function-call assignments (IMP-PRE1 regression)", () => {
  const falsePositives = [
    'authorization = load_bound_json_object(root, snapshot["authorizationReceipt"])',
    "    authorization = load_bound_json_object(root, snapshot[\"authorizationReceipt\"])",
    "private_key = resolve_configured_public_key_reference(root)",
    "secret = get_secret_key()",
    "password = request.headers['apikey']",
    "api_key = load_environment_variable('API_KEY')",
    "session_token = create_session_token(user_id)",
  ];
  for (const value of falsePositives) {
    assert.equal(credentialAssignmentMatches(value), false, `should not match: ${value}`);
  }
});

test("credential-assignment does not match quoted identifiers or placeholders", () => {
  const safeNegatives = [
    'const secret = "load_bound_json_object"',
    'api_key = "YOUR_API_KEY_HERE"',
    'password = "CHANGEME"',
    'api_key = "REPLACE_ME"',
    'secret = "EXAMPLE"',
    'const secret = "resolve_configured_public_key_reference"',
  ];
  for (const value of safeNegatives) {
    assert.equal(credentialAssignmentMatches(value), false, `should not match: ${value}`);
  }
});

test("credential-assignment does not match public hex digests or empty values", () => {
  const safeNegatives = [
    'password = "0123456789abcdef0123456789abcdef"',
    'artifact_sha256 = 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    'api_key = ""',
    "password = null",
    "session_token = undefined",
    'secret = ""',
  ];
  for (const value of safeNegatives) {
    assert.equal(credentialAssignmentMatches(value), false, `should not match: ${value}`);
  }
});

test("credential-assignment does not match bare identifier assignments without underscores in the value", () => {
  assert.equal(credentialAssignmentMatches(("authorization = Be" + "arer tokenvalue123456")), false);
  assert.equal(credentialAssignmentMatches("function classifyCredentialReference(secretMetadata, sessionTokenName) {"), false);
});

test("credential-assignment matches real API key assignments without known prefixes", () => {
  const truePositives = [
    'api_key = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA=="',
    'api_key: "AKIAIOSFODNN7EXAMPLE123456"',
    'API_KEY = "S3cure+EEEEEEEEEEEE/?EEEEEEEEEE"',
  ];
  for (const value of truePositives) {
    assert.equal(credentialAssignmentMatches(value), true, `should match: ${value}`);
  }
});

test("prefixed token values are caught by token-prefix even when credential-assignment excludes them", () => {
  const prefixedValues = [
    ('export const API_KEY = "sk' + '_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"'),
    ('api_key = "sk' + '_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"'),
    ('api_key = "rk' + '_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"'),
    ('api_key = "pk' + '_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"'),
    ('api_key = "gh' + 'p_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"'),
  ];
  for (const value of prefixedValues) {
    assert.equal(credentialAssignmentMatches(value), false, `credential-assignment should not match: ${value}`);
    assert.equal(hasSecretTextSignal(value, admission), true, `hasSecretTextSignal should match: ${value}`);
  }
});

test("credential-assignment matches real password assignments", () => {
  const truePositives = [
    'database_password: "S3cure+EEEEEEEEEEEE/?EEEEEEEEEE"',
    'password="S3cure+EEEEEEEEEEEE/?EEEEEEEEEE"',
    'password="BBBBBBBBBBBBBBBBBBBB"',
    'password = "MyS3cretPassw0rd12345678"',
    'password: "Hunter2ZephyrAlphaBeta"',
  ];
  for (const value of truePositives) {
    assert.equal(credentialAssignmentMatches(value), true, `should match: ${value}`);
  }
});

test("credential-assignment matches real session token assignments", () => {
  const truePositives = [
    "SESSION_TOKEN=sess-FFFFFFFFFFFFFFFFFFFFFFFFFFFF",
    "session_token=sess-FFFFFFFFFFFFFFFFFFFFFFFFFFFF",
    'session_token: "sess-FFFFFFFFFFFFFFFFFFFFFFFFFFFF"',
    'SESSION_TOKEN = "sess-FFFFFFFFFFFFFFFFFFFFFFFFFFFF"',
  ];
  for (const value of truePositives) {
    assert.equal(credentialAssignmentMatches(value), true, `should match: ${value}`);
  }
});

test("credential-assignment matches real secret assignments with mixed characters", () => {
  const truePositives = [
    'secret = "ak_live_abc123XYZ456def789"',
    'secret: "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA=="',
    'api_key: "AKIAIOSFODNN7EXAMPLE123456"',
  ];
  for (const value of truePositives) {
    assert.equal(credentialAssignmentMatches(value), true, `should match: ${value}`);
  }
});

test("hasSecretTextSignal returns false for the exact foundation-regeneration-dag false positive line", () => {
  const falsePositiveLine = 'authorization = load_bound_json_object(root, snapshot["authorizationReceipt"])';
  assert.equal(hasSecretTextSignal(falsePositiveLine, admission), false);
});

test("hasSecretTextSignal returns true for real credential content even with surrounding text", () => {
  const realSecretContext = `
# Configuration
# Do not commit real credentials
api_key = "sk${""}_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
# End of config
`;
  assert.equal(hasSecretTextSignal(realSecretContext, admission), true);
});

test("credential-assignment handles YAML-style colon assignments", () => {
  assert.equal(credentialAssignmentMatches('database_password: "S3cure+EEEEEEEEEEEE/?EEEEEEEEEE"'), true);
  assert.equal(credentialAssignmentMatches("session_token: sess-FFFFFFFFFFFFFFFFFFFFFFFFFFFF"), true);
  assert.equal(credentialAssignmentMatches("secret: load_bound_json_object(root)"), false);
});

test("credential-assignment is case-insensitive for keyword matching", () => {
  assert.equal(credentialAssignmentMatches('API_KEY = "S3cure+EEEEEEEEEEEE/?EEEEEEEEEE"'), true);
  assert.equal(credentialAssignmentMatches('Api_Key = "S3cure+EEEEEEEEEEEE/?EEEEEEEEEE"'), true);
  assert.equal(credentialAssignmentMatches('PASSWORD = "S3cure+EEEEEEEEEEEE/?EEEEEEEEEE"'), true);
  assert.equal(credentialAssignmentMatches('SECRET = "S3cure+EEEEEEEEEEEE/?EEEEEEEEEE"'), true);
  assert.equal(credentialAssignmentMatches('Session_Token = "sess-FFFFFFFFFFFFFFFFFFFFFFFFFFFF"'), true);
});

test("sk_ prefixed values are caught by token-prefix even when credential-assignment excludes them", () => {
  assert.equal(credentialAssignmentMatches(('API_KEY = "sk' + '_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"')), false);
  assert.equal(hasSecretTextSignal(('API_KEY = "sk' + '_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"'), admission), true);
  assert.equal(hasSecretTextSignal(('api_key = "gh' + 'p_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"'), admission), true);
});
