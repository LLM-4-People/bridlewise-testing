/**
 * THE ONE ENVIRONMENT PROJECTION (`src/process/environment-projection.ts`):
 * a child gets the allowlisted names of this process's environment and
 * nothing else — the engine's command tool included, which used to hand a
 * model-chosen command `{ ...process.env }` (every key and token).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { COMMAND_ENVIRONMENT, ENVIRONMENT_ALLOWLIST_ENTRY, MINIMAL_CHILD_ENVIRONMENT, projectEnvironment } from "../../src/process/environment-projection.ts";
import { MCP_CONFIG_SCHEMA } from "../../src/shared/exposure/module-config-sections.ts";
import { createExecuteCommandTool } from "../../src/tools/built-in-tools.ts";
import { mkOwnedTempDir } from "../support/temp-dir.ts";

test("environment projection: exact names and PREFIX* pass, everything else is dropped, a bare * is refused", () => {
  const env = { PATH: "/bin", HOME: "/h", GIT_DIR: "g", GIT_AUTHOR: "a", OPENAI_API_KEY: "sk-x", GITHUB_TOKEN: "ghp" };
  assert.deepEqual(projectEnvironment(env, ["PATH", "GIT_*"]), { PATH: "/bin", GIT_DIR: "g", GIT_AUTHOR: "a" });
  assert.throws(() => projectEnvironment(env, ["PATH", "*"]), (error: unknown) => (error as { code?: string }).code === "environment_allowlist_refused");
  assert.ok(!MINIMAL_CHILD_ENVIRONMENT.some((name) => /KEY|TOKEN|SECRET|PASS|PROXY/iu.test(name)), "the minimal set carries no credential or proxy name");
});

test("environment projection: the engine command tool's child never sees a key this process holds", async () => {
  const planted = "SECC_PLANTED_API_KEY";
  process.env[planted] = "sk-planted-value";
  try {
    const tool = createExecuteCommandTool({ allowedCommands: ["node"], timeoutMs: 10_000 });
    const result = await tool.execute(
      { toolId: "execute_command", arguments: { command: "node", args: ["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"] } },
      { repositoryRoot: mkOwnedTempDir("env-projection-tool-") },
    );
    const names = JSON.parse((JSON.parse(result.content) as { stdout: string }).stdout) as string[];
    assert.ok(!names.includes(planted), `the planted key reached the child: ${names.join(",")}`);
    assert.ok(names.every((name) => COMMAND_ENVIRONMENT.includes(name)), `only the projection: ${names.join(",")}`);
  } finally {
    delete process.env[planted];
  }
});

const refused = (allowlist: readonly string[]) => () => projectEnvironment({ HARNESS_WEB_DB_KEY: "passphrase" }, allowlist);
const refusedCode = (error: unknown) => (error as { code?: string }).code === "environment_allowlist_refused";

test("environment projection: no allowlist may name the harness's own HARNESS_* namespace (exact, a prefix of it, or under it)", () => {
  for (const entry of ["HARNESS_WEB_DB_KEY", "HARNESS_*", "HARNESS_WEB_*", "HARN*", "H*", "harness_web_auth_password"]) {
    assert.throws(refused(["PATH", entry]), refusedCode, entry);
    assert.equal(ENVIRONMENT_ALLOWLIST_ENTRY.safeParse(entry).success, false, `the config entry rule refuses ${entry}`);
  }
  // The same rule is the MCP config's (both of its lists).
  assert.equal(MCP_CONFIG_SCHEMA.safeParse({ stdioInheritedEnv: ["PATH", "HARNESS_WEB_AUTH_PASSWORD"] }).success, false);
  assert.equal(MCP_CONFIG_SCHEMA.safeParse({ credentialEnv: ["HAR*"] }).success, false);
  // Names that merely share letters are not the namespace.
  for (const entry of ["HARNESSED", "HA_X", "HOME", "HTTP_*"]) {
    assert.doesNotThrow(refused(["PATH", entry]), entry);
    assert.equal(ENVIRONMENT_ALLOWLIST_ENTRY.safeParse(entry).success, true, entry);
  }
});

test("environment projection: a proxy URL leaves without its userinfo; its host and every other value are untouched", () => {
  const env = {
    HTTPS_PROXY: "http://corp%40user:s3cr3t-pass@proxy.corp:3128",
    http_proxy: "alice:hunter2@proxy.corp:8080",
    ALL_PROXY: "socks5://tok@socks.corp:1080/",
    all_proxy: "http://u:p@ss@proxy.corp:1/a@b",
    no_proxy: "localhost,.corp",
    HTTP_PROXY: "http://proxy.corp:8080",
    PATH: "/bin:user@host",
  };
  const projected = projectEnvironment(env, COMMAND_ENVIRONMENT);
  assert.deepEqual(projected, {
    HTTPS_PROXY: "http://proxy.corp:3128",
    http_proxy: "proxy.corp:8080",
    ALL_PROXY: "socks5://socks.corp:1080/",
    all_proxy: "http://proxy.corp:1/a@b",
    no_proxy: "localhost,.corp",
    HTTP_PROXY: "http://proxy.corp:8080",
    PATH: "/bin:user@host",
  });
  assert.ok(!JSON.stringify(projected).includes("s3cr3t") && !JSON.stringify(projected).includes("hunter2"));
});

test("environment projection: every spelling a URL parser reads loses its credentials; other proxy-like names too; an unreadable proxy is not forwarded (secd-security SECD-V-B2, 7g)", () => {
  const spellings = [" http://u:PLANTEDPW@proxy.corp:1", "\nhttp://u:PLANTEDPW@proxy.corp:1", "http:///u:PLANTEDPW@proxy.corp:1", "http:/u:PLANTEDPW@proxy.corp:1", "HTTP://u:PLANTEDPW@proxy.corp:1"];
  for (const spelling of spellings) {
    const projected = projectEnvironment({ HTTPS_PROXY: spelling }, COMMAND_ENVIRONMENT);
    assert.ok(!JSON.stringify(projected).includes("PLANTEDPW"), JSON.stringify(spelling));
    const forwarded = projected["HTTPS_PROXY"];
    if (forwarded !== undefined) assert.equal(URL.parse(forwarded)?.password ?? "", "", `a parser reads no password from ${forwarded}`);
  }
  const others = { FTP_PROXY: "ftp://u:PLANTEDPW@ftp.corp:21", npm_config_https_proxy: "http://u:PLANTEDPW@npm.corp:8080", SOCKS_PROXY: "socks5://u:PLANTEDPW@s.corp:1080", Https_Proxy: "http://u:PLANTEDPW@p.corp:1" };
  const projected = projectEnvironment(others, [...COMMAND_ENVIRONMENT, ...Object.keys(others)]);
  assert.equal(Object.keys(projected).length, 4);
  assert.ok(!JSON.stringify(projected).includes("PLANTEDPW"), JSON.stringify(projected));
  assert.deepEqual(projectEnvironment({ HTTPS_PROXY: "http://[not a host" }, COMMAND_ENVIRONMENT), {}, "unreadable: not forwarded");
});
