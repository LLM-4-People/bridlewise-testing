// @vitest-environment node
/**
 * A MODEL'S READ OF A SECRET FILE SHOWS KEYS, NEVER VALUES (cred-final §11,
 * coordinator decision 2026-09-28): the web server's `read_file` and
 * `search_code` hand a secret file's text to the model through the
 * secret-file owner — a value no detector recognises (an opaque token, a
 * connection string) is redacted because the FILE's name says it is one; an
 * ordinary file is served as it is.
 */
import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createTempDir } from "../helpers/temp-dir.ts";
import { executeToolCall } from "../../server/tools/tool-executor.ts";

test("read_file and search_code of a secret file carry its keys and none of its values", async () => {
  const projectRoot = createTempDir("secret-file-reads-");
  const token = randomUUID().replaceAll("-", "");
  writeFileSync(join(projectRoot, ".env"), `DATABASE_URL=postgres://app:${token}@db/app\nOPAQUE_SETTING=${token}\n`);
  writeFileSync(join(projectRoot, "notes.txt"), `OPAQUE_SETTING=${token}\n`);
  // The search walk skips dot-files; a named env file it does visit is the same kind of secret file.
  writeFileSync(join(projectRoot, "prod.env"), `OPAQUE_SETTING=${token}\n`);
  const read = await executeToolCall("read_file", { path: ".env" }, { projectRoot });
  expect(read.success).toBe(true);
  expect(read.output).toContain("DATABASE_URL=");
  expect(read.output).toContain("OPAQUE_SETTING=");
  expect(read.output).not.toContain(token);
  const search = await executeToolCall("search_code", { pattern: "OPAQUE_SETTING" }, { projectRoot });
  expect(search.success).toBe(true);
  expect(search.output).toContain("prod.env");
  expect(search.output).toContain("notes.txt");
  const envLine = search.output.split("\n").find((line) => line.startsWith("prod.env:"))!;
  expect(envLine).toContain("OPAQUE_SETTING=");
  expect(envLine).not.toContain(token);
  // An ordinary file is not a secret file: the owner leaves it to the detectors.
  expect((await executeToolCall("read_file", { path: "notes.txt" }, { projectRoot })).output).toContain(token);
});

test("the store NAMES committed in a project are served (secd-design H1): a credential file with its values hidden, ordinary configuration exact", async () => {
  const projectRoot = createTempDir("store-names-in-project-");
  const token = randomUUID().replaceAll("-", "");
  mkdirSync(join(projectRoot, ".docker"));
  mkdirSync(join(projectRoot, ".claude"));
  writeFileSync(join(projectRoot, ".npmrc"), `registry=https://registry.example.invalid/\n//registry.example.invalid/:_authToken=${token}\n`);
  writeFileSync(join(projectRoot, ".docker", "config.json"), `{\n  "auths": {\n    "registry.example.invalid": {\n      "auth": "${token}"\n    }\n  }\n}\n`);
  writeFileSync(join(projectRoot, ".docker", "compose.yml"), `services:\n  app:\n    image: example:${token}\n`);
  writeFileSync(join(projectRoot, ".claude", "settings.json"), `{ "permissions": { "allow": ["Bash(npm test)"] }, "note": "${token}" }\n`);
  const npmrc = await executeToolCall("read_file", { path: ".npmrc" }, { projectRoot });
  expect(npmrc.success, npmrc.output).toBe(true);
  expect(npmrc.output).toContain("//registry.example.invalid/:_authToken=");
  expect(npmrc.output).not.toContain(token);
  const docker = await executeToolCall("read_file", { path: ".docker/config.json" }, { projectRoot });
  expect(docker.success, docker.output).toBe(true);
  expect(docker.output).toContain('"auth":');
  expect(docker.output).not.toContain(token);
  for (const path of [".docker/compose.yml", ".claude/settings.json"]) {
    const plain = await executeToolCall("read_file", { path }, { projectRoot });
    expect(plain.success, plain.output).toBe(true);
    expect(plain.output, path).toContain(token);
  }
});

test("the leak corpus through read_file (sec-e-correctness H-1): a store file served in a project carries none of its values", async () => {
  const projectRoot = createTempDir("secret-file-corpus-");
  const token = randomUUID().replaceAll("-", "");
  const base64 = Buffer.from(`KEYMATERIAL-${token}`).toString("base64");
  const padded = Buffer.from(`${token}xy`).toString("base64");
  mkdirSync(join(projectRoot, ".kube"));
  writeFileSync(join(projectRoot, ".gitconfig"), `[user]\n  name = a\n[url "https://oauth2:${token}@git.example.invalid/"]\n  insteadOf = https://git.example.invalid/\n`);
  writeFileSync(join(projectRoot, ".env"), `#API_TOKEN=${token}\nX=1\n`);
  writeFileSync(join(projectRoot, ".npmrc"), `; //registry.example.invalid/:_authToken=${token}\n`);
  writeFileSync(join(projectRoot, ".kube", "config"), `users:\n- name: u\n  user:\n    client-key-data: |\n      ${base64}\n`);
  writeFileSync(join(projectRoot, "deploy.ppk"), `PuTTY-User-Key-File-3: ssh-rsa\nPrivate-Lines: 1\n${padded}\n`);
  writeFileSync(join(projectRoot, "tls.pem"), `  --${""}---BEGIN PRIVATE KEY-----\n  ${padded}\n  -----END PRIVATE KEY-----\n`);
  for (const [path, key] of [[".gitconfig", "[url "], [".env", "#API_TOKEN="], [".npmrc", "_authToken="], [".kube/config", "client-key-data: |"], ["deploy.ppk", "Private-Lines:"], ["tls.pem", ("--" + "---BEGIN PRIVATE KEY-----")]] as const) {
    const read = await executeToolCall("read_file", { path }, { projectRoot });
    expect(read.success, read.output).toBe(true);
    expect(read.output, path).toContain(key);
    for (const secret of [token, base64.replace(/=+$/u, ""), padded.replace(/=+$/u, "")]) expect(read.output, path).not.toContain(secret);
  }
});

test("home-shaped folders INSIDE a project are its content (sec-e-design M1): a dotfiles repository or a fixture home is served, credential values hidden", async () => {
  const projectRoot = createTempDir("home-shaped-in-project-");
  const token = randomUUID().replaceAll("-", "");
  const files: Readonly<Record<string, string>> = {
    "dotfiles/home/alice/.npmrc": `//registry.example.invalid/:_authToken=${token}\n`,
    "dotfiles/home/alice/.ssh/config": "Host example\n  User alice\n",
    "test/fixtures/home/user/.docker/config.json": `{\n  "auths": {\n    "registry.example.invalid": {\n      "auth": "${token}"\n    }\n  }\n}\n`,
    "test/fixtures/home/user/.claude/settings.json": `{ "permissions": { "allow": ["Bash(npm test)"] } }\n`,
    "src/pages/home/widgets/.cursor/rules/a.md": "# rules\n",
    "Users/bob/.kube/dev.yaml": "clusters: []\n",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(projectRoot, path, ".."), { recursive: true });
    writeFileSync(join(projectRoot, path), text);
  }
  for (const path of Object.keys(files)) {
    const read = await executeToolCall("read_file", { path }, { projectRoot });
    expect(read.success, `${path}: ${read.output}`).toBe(true);
    expect(read.output, path).not.toContain(token);
  }
  expect((await executeToolCall("read_file", { path: "dotfiles/home/alice/.npmrc" }, { projectRoot })).output).toContain("_authToken=");
  expect((await executeToolCall("read_file", { path: "dotfiles/home/alice/.ssh/config" }, { projectRoot })).output).toContain("Host example");
});
