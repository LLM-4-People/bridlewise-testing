// @vitest-environment node
/**
 * AN MCP SERVER'S OWN CREDENTIALS ARE HELD FOR ITS OUTPUT, NOT REGISTERED
 * PROCESS-WIDE (secd-security SECD-C3): the process-wide registry masks every
 * user-observable surface, so an admin's `PGPASSWORD: "CompanyName2024!"`
 * registered there made a chat title typed as a guess come back masked — an
 * equality oracle. Now the value is masked only in what that server authors,
 * at THE ONE CLIENT DOOR (`mcpServerClient`, sec-e-design H2): its tool
 * descriptions, call results, errors and stderr — and a guess anywhere else,
 * or another server's words, are shown as typed.
 */
import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createTempDir } from "../helpers/temp-dir.ts";
import { plantSettingsDocument } from "../helpers/isolated-config.ts";

const FAKE_SERVER = fileURLToPath(new URL("../../engine/test/mcp/fixtures/fake-mcp-server.mjs", import.meta.url));
const GUESSABLE = "CompanyName2024!";

// A test-scoped copy of the real config, planted BEFORE any server module
// resolves it: confinement off (the guardian refuses the harness's own tree
// as the fixture's home, and this file's subject is the mask, not the sandbox).
const configPath = join(createTempDir("mcp-held-credentials-"), "bridlewise.config.json");
const base = JSON.parse(readFileSync(fileURLToPath(new URL("../../engine/bridlewise.config.json", import.meta.url)), "utf8")) as Record<string, unknown>;
base["selfProtection"] = { schemaVersion: "bridlewise-self-protection-config/v1", enabled: false };
plantSettingsDocument(configPath, JSON.stringify(base));
process.env["HARNESS_CONFIG_PATH"] = configPath;
const { mcpClientFactoryOptions, mcpServerClient } = await import("../../server/integrations/mcp-runtime-bridge.ts");
const { redactContent, redactForUserDisplay } = await import("../../server/llm/redaction.ts");

/** A fake stdio server whose own words carry `say`, holding `env`. */
function serverEntry(id: string, say: string, env: Readonly<Record<string, string>> | undefined, extra: readonly string[] = []): never {
  return { id, transport: "stdio", command: process.execPath, args: [FAKE_SERVER, "--say", say, ...extra], protocolVersion: "2025-11-25", ...(env === undefined ? {} : { env }) } as never;
}

test("a guessable MCP literal is masked in everything that server authors and nowhere else (no equality oracle)", async () => {
  const stderr: string[] = [];
  const options = { ...mcpClientFactoryOptions(), onStderr: (_serverId: string, line: string) => { stderr.push(line); } };
  const held = mcpServerClient(serverEntry("held-db", `mode stdio ${GUESSABLE}`, { PGPASSWORD: GUESSABLE, SHORT: "stdio" }), options);
  try {
    await held.connect();
    const described = JSON.stringify(await held.listTools());
    expect(described).toContain("[REDACTED:secret]");
    expect(described).not.toContain(GUESSABLE);
    expect(described, "a short innocuous value is never held").toContain("mode stdio");
    const result = JSON.stringify(await held.callTool("ping", {}));
    expect(result).toContain("pong:1");
    expect(result).not.toContain(GUESSABLE);
    await expect.poll(() => stderr.some((line) => line.includes("starting")), { timeout: 5000 }).toBe(true);
    expect(stderr.join("\n")).not.toContain(GUESSABLE);
  } finally {
    await held.close();
  }
  const refused = mcpServerClient(serverEntry("held-db-refusing", GUESSABLE, { PGPASSWORD: GUESSABLE }, ["--fail-initialize"]), options);
  const failure = await refused.connect().then(() => undefined, (error: unknown) => error as Error);
  await refused.close();
  expect(failure?.message).toContain("bad credentials");
  expect(failure?.message).not.toContain(GUESSABLE);
  // No oracle: a user-typed guess is not confirmed by masking, on either path.
  const guess = `title ${GUESSABLE} end`;
  expect(redactForUserDisplay(guess)).toBe(guess);
  expect(redactContent(guess), "nor on the model-bound path").toBe(guess);
  // Held per server: another server that holds nothing is served as it spoke.
  const other = mcpServerClient(serverEntry("another-server", GUESSABLE, undefined), options);
  try {
    await other.connect();
    expect(JSON.stringify(await other.listTools()), "held per server").toContain(GUESSABLE);
  } finally {
    await other.close();
  }
});
