/**
 * THE SECRET-FILE OWNER (`src/privacy/secret-files.ts`): a file whose name
 * says it holds credentials reaches a model with every VALUE redacted and its
 * KEYS and structure visible — including values no detector recognises (the
 * file's name is the evidence) — through the engine's file viewer.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { isSecretFile, redactSecretFileText } from "../../src/privacy/secret-files.ts";
import { viewFile } from "../../src/privacy/file-viewer.ts";
import { DEFAULT_PRIVACY_POLICY } from "../../src/privacy/privacy-policy.ts";

const MARK = "[REDACTED:secret]";

test("secret files are recognised by name; ordinary files and env templates are not", () => {
  for (const path of [".env", "app/.env.production", ".ENV.local", "deploy/key.pem", "id_ed25519", "C:\\\\u\\\\.npmrc", ".netrc", "prod.tfvars", "certs/site.p12", ".git-credentials", "secrets.yaml", "a/credentials"]) {
    assert.equal(isSecretFile(path), true, path);
  }
  for (const path of [".env.example", ".env.sample", ".env.template", "id_ed25519.pub", "src/env.ts", "README.md", "key.ts", "keys/", ".pem", "environment.json"]) {
    assert.equal(isSecretFile(path), false, path);
  }
});

test("inside a project, a floor store's CREDENTIAL file is a secret file and its ordinary configuration is not (secd-design H1: served, values hidden)", () => {
  for (const path of ["proj/.npmrc", "proj/.docker/config.json", "proj/.kube/config", "proj/.codex/auth.json", "proj/.claude/.credentials.json", "proj/.config/gh/hosts.yml", "proj/.m2/settings.xml", "proj/.config/containers/auth.json", "proj/.pgpass"]) {
    assert.equal(isSecretFile(path), true, path);
  }
  for (const path of ["proj/.docker/compose.yml", "proj/.claude/settings.json", "proj/.claude/commands/review.md", "proj/.cursor/rules/a.md", "proj/.codex/config.toml", "proj/.gemini/styleguide.md", "proj/.kube/dev.yaml"]) {
    assert.equal(isSecretFile(path), false, path);
  }
});

test("every value is redacted and every key stays visible: env, JSON, YAML, INI, PEM, netrc", () => {
  const token = randomUUID().replaceAll("-", ""), url = `postgres://app:${token}@db.internal:5432/app`;
  const env = `# database\nexport DATABASE_URL=${url}\nPLAIN_NAME=${token}\nEMPTY=\n\n[section]\nretries = 3`;
  assert.equal(redactSecretFileText(".env", env, DEFAULT_PRIVACY_POLICY),
    `# ${MARK}\nexport DATABASE_URL=${MARK}\nPLAIN_NAME=${MARK}\nEMPTY=\n\n[section]\nretries = ${MARK}`);
  const json = `{\n  "client_id": "${token}",\n  "nested": {\n    "private_key": "${token}"\n  }\n}`;
  assert.equal(redactSecretFileText("credentials.json", json, DEFAULT_PRIVACY_POLICY),
    `{\n  "client_id": ${MARK},\n  "nested": {\n    "private_key": ${MARK}\n  }\n}`);
  const yaml = `production:\n  api_key: ${token}\n  hosts:\n    - ${token}`;
  assert.equal(redactSecretFileText("secrets.yml", yaml, DEFAULT_PRIVACY_POLICY), `production:\n  api_key: ${MARK}\n  hosts:\n${MARK}`);
  const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${token}\n${token}\n-----END OPENSSH PRIVATE KEY-----\n`;
  assert.equal(redactSecretFileText("id_rsa", pem, DEFAULT_PRIVACY_POLICY), `-----BEGIN OPENSSH PRIVATE KEY-----\n${MARK}\n-----END OPENSSH PRIVATE KEY-----\n`);
  assert.equal(redactSecretFileText(".netrc", `machine host login me password ${token}`, DEFAULT_PRIVACY_POLICY), MARK);
  // An `.npmrc` registry-scoped token (its key starts with `//`, which is not a comment there); a `// comment` stays a comment, its text hidden.
  assert.equal(redactSecretFileText(".npmrc", `registry=https://r.example/\n//r.example/:_authToken=${token}\n// a comment`, DEFAULT_PRIVACY_POLICY),
    `registry=${MARK}\n//r.example/:_authToken=${MARK}\n// ${MARK}`);
  for (const [path, text] of [[".env", env], ["credentials.json", json], ["secrets.yml", yaml], ["id_rsa", pem]] as const) {
    assert.ok(!redactSecretFileText(path, text, DEFAULT_PRIVACY_POLICY).includes(token), path);
  }
  assert.equal(redactSecretFileText("src/app.ts", `const x = "${token}";`, DEFAULT_PRIVACY_POLICY), `const x = "${token}";`, "an ordinary file is untouched here");
});

test("the leak corpus (sec-e-correctness H-1): comments, section arguments, base64 runs, block scalars and indented PEM carry no value", () => {
  const token = randomUUID().replaceAll("-", "");
  const base64 = Buffer.from(`KEYMATERIAL-${token}`).toString("base64");
  const padded = Buffer.from(`${token}xy`).toString("base64");
  assert.ok(base64.endsWith("=") && padded.endsWith("=="), "the corpus carries both paddings");
  const corpus: readonly (readonly [path: string, text: string, expected: string])[] = [
    // (a) a comment's body is read like a line: a commented-out setting keeps its key, other text is hidden.
    [".env", `#API_TOKEN=${token}\n# ${token}\n#\nX=1`, `#API_TOKEN=${MARK}\n# ${MARK}\n#\nX=${MARK}`],
    [".npmrc", `; //registry.example.invalid/:_authToken=${token}\n// ${token}`, `; //registry.example.invalid/:_authToken=${MARK}\n// ${MARK}`],
    // (b) a section keeps its name; an argument that is not plain words is hidden.
    [".gitconfig", `[user]\n  name = a\n[url "https://oauth2:${token}@git.example.invalid/"]\n[remote "origin"]\n[[servers]]\n[https://u:${token}@h]\n[]`,
      `[user]\n  name = ${MARK}\n[url ${MARK}]\n[remote ${MARK}]\n[[servers]]\n[https ${MARK}]\n[]`],
    // (c) a base64 run with its padding is a value, never a key with an empty value.
    ["deploy.ppk", `PuTTY-User-Key-File-3: ssh-rsa\nPrivate-Lines: 2\n${base64}\n${padded}\nEMPTY=`,
      `PuTTY-User-Key-File-3: ${MARK}\nPrivate-Lines: ${MARK}\n${MARK}\n${MARK}\nEMPTY=`],
    // (d) a YAML block scalar is one value: every line indented deeper than its key.
    [".kube/config", `users:\n- name: u\n  user:\n    client-key-data: |\n      ${base64}\n      ${token}\n\n    token: >-\n      ${token}\n- name: v`,
      `users:\n- name: ${MARK}\n  user:\n    client-key-data: |\n      ${MARK}\n\n    token: >-\n      ${MARK}\n- name: ${MARK}`],
    // (e) PEM armour is recognised when indented (a key inside YAML or an indented file).
    ["id_rsa", `  -----BEGIN OPENSSH PRIVATE KEY-----\n  ${token}\n  ${padded}\n  -----END OPENSSH PRIVATE KEY-----`,
      `  -----BEGIN OPENSSH PRIVATE KEY-----\n${MARK}\n  -----END OPENSSH PRIVATE KEY-----`],
    // A token followed by `=` or `:` is not a key: only identifier-shaped names are shown.
    ["credentials", `token ${token}: yes\n${token.slice(0, 10)} x=1`, `${MARK}\n${MARK}`],
  ];
  for (const [path, text, expected] of corpus) {
    const served = redactSecretFileText(path, text, DEFAULT_PRIVACY_POLICY);
    assert.equal(served, expected, path);
    for (const secret of [token, base64.replace(/=+$/u, ""), padded.replace(/=+$/u, "")]) assert.ok(!served.includes(secret), `${path} leaks`);
  }
});

test("the engine's file viewer (its read_file) shows a secret file's keys and never its values, in every mode", () => {
  const token = randomUUID().replaceAll("-", "");
  const text = `SERVICE_URL=https://svc.internal\nOPAQUE=${token}\n`;
  for (const mode of ["full", "regex"] as const) {
    const view = viewFile(".env", text, { mode, pattern: "=", policy: DEFAULT_PRIVACY_POLICY } as never);
    assert.equal(view.outcome, "viewed", mode);
    assert.ok(view.content.includes("SERVICE_URL=") && view.content.includes("OPAQUE="), mode);
    assert.ok(!view.content.includes(token) && !view.content.includes("svc.internal"), mode);
  }
});
