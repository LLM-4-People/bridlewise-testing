import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { getConfigDocumentSchema, type ConfigDocument } from "../../src/kernel/config-contracts.ts";
import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";

const CONFIG_DOCUMENT_SCHEMA = getConfigDocumentSchema();

const CONFIG_PATH = new URL("../../bridlewise.config.json", import.meta.url);
const VALID_CONFIG = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));

function candidate(mutator: (value: Record<string, unknown>) => void): Record<string, unknown> {
  const value = structuredClone(VALID_CONFIG) as unknown as Record<string, unknown>;
  mutator(value);
  return value;
}

const toolsLimits = ROOT_POLICY.tools.limits;

// ============================================================================
// Valid configuration
// ============================================================================

test("tools-config: canonical config has tools section", () => {
  const parsed = CONFIG_DOCUMENT_SCHEMA.parse(VALID_CONFIG);
  assert.ok(parsed.tools);
  assert.ok(Array.isArray(parsed.tools!.enabled));
  // `enabled` is the blanket allowlist for ALL tool categories (built-in,
  // file-viewing, editor, intelligence, quality, extension, git, agent,
  // orchestrator). The 5 built-in adapter tools are the minimum; the rest
  // are the always-on and config-conditional module-group tools the repo
  // config registers. Don't pin the exact count — adding a tool should not
  // break this test.
  assert.ok(parsed.tools!.enabled.length >= 5, "enabled must list at least the 5 built-in tools");
  for (const name of ["execute_command", "search_web", "fetch_page", "read_docs", "repo_question"]) {
    assert.ok(parsed.tools!.enabled.includes(name), `enabled must include the built-in tool '${name}'`);
  }
});

test("tools-config: config without tools section validates (optional)", () => {
  const without = candidate((v) => { delete v.tools; });
  assert.ok(CONFIG_DOCUMENT_SCHEMA.safeParse(without).success);
});

test("tools-config: tools with mcpServers validates", () => {
  const withServers = candidate((v) => {
    (v.tools as Record<string, unknown>).mcpServers = [
      { id: "test-mcp", transport: "stdio", command: "npx", args: ["-y", "@mcp/server"], protocolVersion: "2025-11-25" },
    ];
  });
  assert.ok(CONFIG_DOCUMENT_SCHEMA.safeParse(withServers).success);
});

test("tools-config: tools with http mcpServer validates", () => {
  const withServers = candidate((v) => {
    (v.tools as Record<string, unknown>).mcpServers = [
      { id: "test-mcp", transport: "http", url: "https://example.com/mcp", protocolVersion: "2025-11-25" },
    ];
  });
  assert.ok(CONFIG_DOCUMENT_SCHEMA.safeParse(withServers).success);
});

test("tools-config: tools with empty mcpServers validates", () => {
  const withServers = candidate((v) => {
    (v.tools as Record<string, unknown>).mcpServers = [];
  });
  assert.ok(CONFIG_DOCUMENT_SCHEMA.safeParse(withServers).success);
});

test("tools-config: tools with timeoutMs on mcpServer validates", () => {
  const withServers = candidate((v) => {
    (v.tools as Record<string, unknown>).mcpServers = [
      { id: "test-mcp", transport: "stdio", command: "x", protocolVersion: "2025-11-25", timeoutMs: 10000 },
    ];
  });
  assert.ok(CONFIG_DOCUMENT_SCHEMA.safeParse(withServers).success);
});

test("tools-config: default bounds at ceiling validate", () => {
  const atCeiling = candidate((v) => {
    (v.tools as Record<string, unknown>).defaultBounds = {
      timeoutMs: toolsLimits.maximumToolTimeoutMs,
      maxOutputBytes: toolsLimits.maximumToolOutputBytes,
      maxMemoryBytes: toolsLimits.maximumToolMemoryBytes,
    };
  });
  assert.ok(CONFIG_DOCUMENT_SCHEMA.safeParse(atCeiling).success);
});

// ============================================================================
// Invalid: defaultBounds
// ============================================================================

test("tools-config: missing defaultBounds fails", () => {
  const missing = candidate((v) => { delete (v.tools as Record<string, unknown>).defaultBounds; });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(missing).success, false);
});

test("tools-config: defaultBounds timeoutMs zero fails", () => {
  const bad = candidate((v) => {
    ((v.tools as Record<string, unknown>).defaultBounds as Record<string, unknown>).timeoutMs = 0;
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(bad).success, false);
});

test("tools-config: defaultBounds timeoutMs negative fails", () => {
  const bad = candidate((v) => {
    ((v.tools as Record<string, unknown>).defaultBounds as Record<string, unknown>).timeoutMs = -1;
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(bad).success, false);
});

test("tools-config: defaultBounds timeoutMs exceeding ceiling fails", () => {
  const bad = candidate((v) => {
    ((v.tools as Record<string, unknown>).defaultBounds as Record<string, unknown>).timeoutMs = toolsLimits.maximumToolTimeoutMs + 1;
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(bad).success, false);
});

test("tools-config: defaultBounds maxOutputBytes zero fails", () => {
  const bad = candidate((v) => {
    ((v.tools as Record<string, unknown>).defaultBounds as Record<string, unknown>).maxOutputBytes = 0;
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(bad).success, false);
});

test("tools-config: defaultBounds maxMemoryBytes exceeding ceiling fails", () => {
  const bad = candidate((v) => {
    ((v.tools as Record<string, unknown>).defaultBounds as Record<string, unknown>).maxMemoryBytes = toolsLimits.maximumToolMemoryBytes + 1;
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(bad).success, false);
});

// ============================================================================
// Invalid: enabled
// ============================================================================

test("tools-config: missing enabled fails", () => {
  const missing = candidate((v) => { delete (v.tools as Record<string, unknown>).enabled; });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(missing).success, false);
});

test("tools-config: duplicate enabled tools fails", () => {
  const dup = candidate((v) => {
    (v.tools as Record<string, unknown>).enabled = ["execute_command", "execute_command"];
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(dup).success, false);
});

test("tools-config: too many enabled tools fails", () => {
  const tooMany = candidate((v) => {
    (v.tools as Record<string, unknown>).enabled = Array(toolsLimits.maximumEnabledTools + 1).fill("x").map((x, i) => `${x}${i}`);
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(tooMany).success, false);
});

test("tools-config: empty tool name in enabled fails", () => {
  const bad = candidate((v) => {
    (v.tools as Record<string, unknown>).enabled = [""];
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(bad).success, false);
});

// ============================================================================
// Invalid: mcpServers
// ============================================================================

test("tools-config: stdio server without command fails", () => {
  const bad = candidate((v) => {
    (v.tools as Record<string, unknown>).mcpServers = [
      { id: "s1", transport: "stdio", protocolVersion: "2025-11-25" },
    ];
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(bad).success, false);
});

test("tools-config: http server without url fails", () => {
  const bad = candidate((v) => {
    (v.tools as Record<string, unknown>).mcpServers = [
      { id: "s1", transport: "http", protocolVersion: "2025-11-25" },
    ];
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(bad).success, false);
});

test("tools-config: duplicate mcp server ids fail", () => {
  const dup = candidate((v) => {
    (v.tools as Record<string, unknown>).mcpServers = [
      { id: "s1", transport: "stdio", command: "x", protocolVersion: "2025-11-25" },
      { id: "s1", transport: "stdio", command: "y", protocolVersion: "2025-11-25" },
    ];
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(dup).success, false);
});

test("tools-config: too many mcp servers fail", () => {
  const tooMany = candidate((v) => {
    (v.tools as Record<string, unknown>).mcpServers = Array(toolsLimits.maximumMcpServers + 1).fill(0).map((_, i) => ({
      id: `s${i}`, transport: "stdio", command: "x", protocolVersion: "2025-11-25",
    }));
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(tooMany).success, false);
});

test("tools-config: invalid server id fails", () => {
  const bad = candidate((v) => {
    (v.tools as Record<string, unknown>).mcpServers = [
      { id: "bad server", transport: "stdio", command: "x", protocolVersion: "2025-11-25" },
    ];
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(bad).success, false);
});

test("tools-config: wrong protocol version fails", () => {
  const bad = candidate((v) => {
    (v.tools as Record<string, unknown>).mcpServers = [
      { id: "s1", transport: "stdio", command: "x", protocolVersion: "2025-01-01" },
    ];
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(bad).success, false);
});

test("tools-config: invalid url in http server fails", () => {
  const bad = candidate((v) => {
    (v.tools as Record<string, unknown>).mcpServers = [
      { id: "s1", transport: "http", url: "not-a-url", protocolVersion: "2025-11-25" },
    ];
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(bad).success, false);
});

test("tools-config: server timeoutMs exceeding ceiling fails", () => {
  const bad = candidate((v) => {
    (v.tools as Record<string, unknown>).mcpServers = [
      { id: "s1", transport: "stdio", command: "x", protocolVersion: "2025-11-25", timeoutMs: toolsLimits.maximumToolTimeoutMs + 1 },
    ];
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(bad).success, false);
});

// ============================================================================
// Unknown fields
// ============================================================================

test("tools-config: unknown field in tools fails", () => {
  const bad = candidate((v) => {
    (v.tools as Record<string, unknown>).unknownField = true;
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(bad).success, false);
});

test("tools-config: unknown field in defaultBounds fails", () => {
  const bad = candidate((v) => {
    ((v.tools as Record<string, unknown>).defaultBounds as Record<string, unknown>).extra = true;
  });
  assert.equal(CONFIG_DOCUMENT_SCHEMA.safeParse(bad).success, false);
});

// ============================================================================
// Config document type
// ============================================================================

test("tools-config: parsed config has ToolsConfig type", () => {
  const parsed = CONFIG_DOCUMENT_SCHEMA.parse(VALID_CONFIG) as ConfigDocument;
  assert.ok(parsed.tools);
  assert.equal(typeof parsed.tools!.defaultBounds.timeoutMs, "number");
  assert.ok(Array.isArray(parsed.tools!.enabled));
});
