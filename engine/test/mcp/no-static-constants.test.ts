import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { ROOT_POLICY } from "../../src/kernel/root-policy.ts";
import { MCP_CONFIG_SCHEMA } from "../../src/shared/exposure/module-config-sections.ts";
import {
  MCP_MAX_TOOLS,
  MCP_MAX_TOOL_NAME_LENGTH,
  MCP_MAX_MESSAGE_BYTES,
  DEFAULT_MCP_RETRY,
  normalizeMcpModuleConfig,
} from "../../src/mcp/index.ts";
import { walk } from "../../scripts/verification/source-walk.ts";

// The fully-defaulted document, asked of the RESOLVER rather than read from
// the default constant. Same values, and it stays true when a caller supplies
// a partial config — which a read of the default never would.
const defaultModuleConfig = normalizeMcpModuleConfig({});

// ---------------------------------------------------------------------------
// No static constants: mechanical audit of the MCP module.
//
// The MCP module must NOT have static keyword lists, hardcoded URLs, or
// hardcoded server configs. All configurable values derive from ROOT_POLICY
// or the central config. This test mechanically enforces the rule so a
// regression back to hardcoded literals is caught.
// ---------------------------------------------------------------------------

const MCP_DIR = join(process.cwd(), "src", "mcp");

function listTsFiles(dir: string, acc: string[] = []): string[] {
  acc.push(...walk(dir, { exts: [".ts"] }));
  return acc;
}

function readMcpFile(rel: string): string {
  return readFileSync(join(MCP_DIR, rel), "utf8");
}

test("no-static-constants: no hardcoded MCP protocol version literal in src/mcp/", () => {
  // The protocol version "2025-11-25" must come from ROOT_POLICY, not a literal.
  const files = listTsFiles(MCP_DIR);
  const offenders: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    // Allow the ROOT_POLICY.contracts.mcpProtocolVersion reference; forbid a
    // standalone literal assignment like protocolVersion: "2025-11-25".
    const literalPattern = /protocolVersion\s*[:=]\s*["'`]2025-11-25["'`]/u;
    if (literalPattern.test(src)) {
      offenders.push(file.replace(process.cwd() + "/", ""));
    }
  }
  assert.deepEqual(offenders, [], `No hardcoded protocolVersion literal; offenders: ${offenders.join(", ")}`);
});

test("no-static-constants: the MCP module never reads this process's environment and never fixes a tool's capabilities", () => {
  // A stdio server's environment is the HOST's (the subprocess allowlist);
  // a module-level read of process.env is how every harness secret used to
  // reach every MCP child. And a tool's read/write class is derived from its
  // annotations by the one classifier — a fixed ["read", "network"] literal
  // is how every MCP write used to be declared a read.
  const offenders: string[] = [];
  for (const file of listTsFiles(MCP_DIR)) {
    const src = readFileSync(file, "utf8");
    if (/\bprocess\.env\b/u.test(src)) offenders.push(`${file.replace(process.cwd() + "/", "")}: process.env`);
    if (/\[\s*["']read["']\s*,\s*["']network["']\s*\]/u.test(src)) offenders.push(`${file.replace(process.cwd() + "/", "")}: fixed capability literal`);
  }
  assert.deepEqual(offenders, []);
});

test("no-static-constants: no hardcoded server configs (npx/uvx/docker commands) in src/mcp/", () => {
  const files = listTsFiles(MCP_DIR);
  const offenders: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    // No hardcoded server invocation commands in the module source.
    if (/\b(?:npx|uvx|docker|pip)\s+["'`]/u.test(src)) {
      offenders.push(file.replace(process.cwd() + "/", ""));
    }
  }
  assert.deepEqual(offenders, [], `No hardcoded server commands in src/mcp/; offenders: ${offenders.join(", ")}`);
});

test("no-static-constants: no hardcoded URLs (https://... or wss://...) in src/mcp/", () => {
  const files = listTsFiles(MCP_DIR);
  const offenders: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    // Forbid hardcoded URL literals (except in comments). The transports take
    // URLs from config, not from hardcoded values.
    const urlPattern = /["'`](?:https?|wss?):\/\/[^\s"'`]+["'`]/u;
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (/^\s*(?:\/\/|\*|\/\*)/u.test(line)) continue; // skip comment lines
      if (urlPattern.test(line)) {
        offenders.push(`${file.replace(process.cwd() + "/", "")}:${i + 1}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `No hardcoded URL literals in src/mcp/; offenders: ${offenders.join(", ")}`);
});

test("no-static-constants: no TRANSPORT_ERROR_CODES keyword set in retry.ts", () => {
  const src = readMcpFile("retry.ts");
  assert.ok(
    !/TRANSPORT_ERROR_CODES\s*=\s*new Set/u.test(src),
    "TRANSPORT_ERROR_CODES keyword set must not exist; use the McpError.transportLevel flag instead",
  );
});

test("no-static-constants: MAX_MCP_TOOLS derived from ROOT_POLICY (not a numeric literal)", () => {
  assert.equal(MCP_MAX_TOOLS, ROOT_POLICY.tools.limits.maximumEnabledTools);
  const src = readMcpFile("core.ts");
  assert.ok(
    !/\bMAX_MCP_TOOLS\s*=\s*[0-9]/u.test(src),
    "MAX_MCP_TOOLS must be derived from ROOT_POLICY, not a numeric literal",
  );
  assert.ok(
    /ROOT_POLICY\.tools\.limits\.maximumEnabledTools/u.test(src),
    "MAX_MCP_TOOLS must reference ROOT_POLICY.tools.limits.maximumEnabledTools",
  );
});

test("no-static-constants: MAX_TOOL_NAME_LENGTH derived from ROOT_POLICY (not a numeric literal)", () => {
  assert.equal(MCP_MAX_TOOL_NAME_LENGTH, ROOT_POLICY.tools.limits.maximumToolNameCharacters);
  const src = readMcpFile("core.ts");
  assert.ok(
    !/\bMAX_TOOL_NAME_LENGTH\s*=\s*[0-9]/u.test(src),
    "MAX_TOOL_NAME_LENGTH must be derived from ROOT_POLICY, not a numeric literal",
  );
  assert.ok(
    /ROOT_POLICY\.tools\.limits\.maximumToolNameCharacters/u.test(src),
    "MAX_TOOL_NAME_LENGTH must reference ROOT_POLICY.tools.limits.maximumToolNameCharacters",
  );
});

test("no-static-constants: MAX_MCP_MESSAGE_BYTES derived from ROOT_POLICY", () => {
  assert.equal(MCP_MAX_MESSAGE_BYTES, ROOT_POLICY.runtime.limits.maximumSseEventBytes);
  const src = readMcpFile("core.ts");
  assert.ok(
    /ROOT_POLICY\.runtime\.limits\.maximumSseEventBytes/u.test(src),
    "MAX_MCP_MESSAGE_BYTES must reference ROOT_POLICY.runtime.limits.maximumSseEventBytes",
  );
});

test("no-static-constants: DEFAULT_MCP_MODULE_CONFIG.protocolVersion from ROOT_POLICY", () => {
  assert.equal(defaultModuleConfig.defaults.protocolVersion, ROOT_POLICY.contracts.mcpProtocolVersion);
  const src = readMcpFile("config.ts");
  assert.ok(
    /ROOT_POLICY\.contracts\.mcpProtocolVersion/u.test(src),
    "DEFAULT_MCP_MODULE_CONFIG.defaults.protocolVersion must reference ROOT_POLICY.contracts.mcpProtocolVersion",
  );
});

test("no-static-constants: DEFAULT_MCP_MODULE_CONFIG.timeoutMs from ROOT_POLICY", () => {
  assert.equal(defaultModuleConfig.defaults.timeoutMs, ROOT_POLICY.tools.limits.defaultToolTimeoutMs);
  const src = readMcpFile("config.ts");
  assert.ok(
    /ROOT_POLICY\.tools\.limits\.defaultToolTimeoutMs/u.test(src),
    "DEFAULT_MCP_MODULE_CONFIG.defaults.timeoutMs must reference ROOT_POLICY.tools.limits.defaultToolTimeoutMs",
  );
});

test("no-static-constants: DEFAULT_MCP_MODULE_CONFIG.limits.maxServers from ROOT_POLICY", () => {
  assert.equal(defaultModuleConfig.limits.maxServers, ROOT_POLICY.tools.limits.maximumMcpServers);
  const src = readMcpFile("config.ts");
  assert.ok(
    /ROOT_POLICY\.tools\.limits\.maximumMcpServers/u.test(src),
    "DEFAULT_MCP_MODULE_CONFIG.limits.maxServers must reference ROOT_POLICY.tools.limits.maximumMcpServers",
  );
});

test("no-static-constants: DEFAULT_MCP_MODULE_CONFIG.limits.maxToolsPerServer from ROOT_POLICY", () => {
  assert.equal(defaultModuleConfig.limits.maxToolsPerServer, ROOT_POLICY.tools.limits.maximumEnabledTools);
  const src = readMcpFile("config.ts");
  assert.ok(
    /ROOT_POLICY\.tools\.limits\.maximumEnabledTools/u.test(src),
    "DEFAULT_MCP_MODULE_CONFIG.limits.maxToolsPerServer must reference ROOT_POLICY.tools.limits.maximumEnabledTools",
  );
});

test("no-static-constants: no hardcoded clientInfo default in core.ts", () => {
  const src = readMcpFile("core.ts");
  // The old default { name: "bridlewise", version: "0.1.0" } must be gone.
  assert.ok(
    !/["'`]bridlewise["'`]/u.test(src),
    "core.ts must not hardcode the client name 'bridlewise'; clientInfo is required from the caller",
  );
  assert.ok(
    !/version:\s*["'`]0\.1\.0["'`]/u.test(src),
    "core.ts must not hardcode the client version '0.1.0'; clientInfo is required from the caller",
  );
});

test("no-static-constants: JSONRPC_VERSION is the protocol standard (not a server config)", () => {
  // JSON-RPC "2.0" is the wire-protocol standard (like HTTP/1.1), not a
  // configurable server value. It is allowed as a literal in core.ts.
  const src = readMcpFile("core.ts");
  assert.ok(/JSONRPC_VERSION\s*=\s*["'`]2\.0["'`]/u.test(src), "JSONRPC_VERSION is the protocol standard");
});

test("no-static-constants: every module-default knob is policy-derived or carries an explicit blessing here", () => {
  // The universe is the RESOLVER's own answer — a knob added to the module
  // defaults enters the populated document and is discovered here, so a new
  // module literal can never slip in the way closeGraceMs did. Each
  // discovered knob is either derived from ROOT_POLICY at its assignment in
  // the module's default block, or named below with both a reason and a
  // bound check (the blessing IS an assertion, never a name on a list).
  const src = readMcpFile("config.ts");
  const blockStart = src.indexOf("const DEFAULT_MCP_MODULE_CONFIG");
  assert.ok(blockStart > 0, "the module default block must exist (the assignment scan targets it)");
  const blockEnd = src.indexOf("});", blockStart);
  assert.ok(blockEnd > blockStart, "the module default block must close");
  const block = src.slice(blockStart, blockEnd);
  const discovered: ReadonlyMap<string, unknown> = new Map([
    ...Object.entries(defaultModuleConfig.defaults).map(([key, value]) => [`defaults.${key}`, value] as const),
    ...Object.entries(defaultModuleConfig.limits).map(([key, value]) => [`limits.${key}`, value] as const),
  ]);
  assert.ok(discovered.size >= 3, "the resolver must populate a non-trivial defaults set (an empty universe proves nothing)");
  const blessed: Readonly<Record<string, Readonly<{ why: string; check: (value: unknown) => boolean }>>> = {
    "defaults.retry": {
      why: "the retry shape is a small literal pair the retry arm below already bounds against policy ceilings",
      check: (value) => {
        const retry = value as { count: number; backoffMs: number };
        return Number.isInteger(retry.count) && retry.count > 0 && retry.count <= ROOT_POLICY.runtime.limits.maximumRetries
          && Number.isFinite(retry.backoffMs) && retry.backoffMs >= 0 && retry.backoffMs <= ROOT_POLICY.runtime.limits.maximumBackoffMs;
      },
    },
    "defaults.sseReconnectMs": {
      why: "the event-stream reconnection time is implementation-defined (\"a few seconds\", HTML SSE); it must stay a positive int the tools.mcp write-gate schema accepts",
      check: (value) => MCP_CONFIG_SCHEMA.safeParse({ sseReconnectMs: value }).success,
    },
    "defaults.sseRetryMaxMs": {
      why: "the ceiling on a server-named resume delay has no policy sibling; it must exceed the resume floor and stay inside the write-gate schema",
      check: (value) => MCP_CONFIG_SCHEMA.safeParse({ sseRetryMaxMs: value }).success && (value as number) > normalizeMcpModuleConfig({}).defaults.sseReconnectMs,
    },
    "defaults.resumeAttempts": {
      why: "a resume budget per request has no policy sibling; it must stay a positive int the write-gate schema accepts",
      check: (value) => MCP_CONFIG_SCHEMA.safeParse({ resumeAttempts: value }).success,
    },
    "defaults.serverRequestBacklog": {
      why: "a per-client answer backlog has no policy sibling; it must stay a positive int the write-gate schema accepts",
      check: (value) => MCP_CONFIG_SCHEMA.safeParse({ serverRequestBacklog: value }).success,
    },
    "defaults.stderrLinesPerSecond": {
      why: "a per-server log budget has no policy sibling; it must stay a positive int the write-gate schema accepts",
      check: (value) => MCP_CONFIG_SCHEMA.safeParse({ stderrLinesPerSecond: value }).success,
    },
    "defaults.credentialEnv": {
      why: "no variable is readable by a placeholder until the operator lists it; the empty default must pass the write-gate grammar",
      check: (value) => Array.isArray(value) && value.length === 0 && MCP_CONFIG_SCHEMA.safeParse({ credentialEnv: value }).success,
    },
    "defaults.stderrTailBytes": {
      why: "a diagnostic tail has no policy sibling; it must stay a positive int the tools.mcp write-gate schema accepts",
      check: (value) => MCP_CONFIG_SCHEMA.safeParse({ stderrTailBytes: value }).success,
    },
    "defaults.stdioInheritedEnv": {
      why: "the MCP SDK's own default inherited set; it must pass the write-gate grammar and carry no credential, proxy or wildcard entry",
      check: (value) => MCP_CONFIG_SCHEMA.safeParse({ stdioInheritedEnv: value }).success
        && (value as readonly string[]).every((name) => !/KEY|TOKEN|SECRET|PASS|PROXY|\*/iu.test(name)),
    },
    "defaults.closeGraceMs": {
      why: "a polite-shutdown grace has no policy sibling to derive from; it must stay a positive int the write-gate schema for tools.mcp accepts",
      check: (value) => MCP_CONFIG_SCHEMA.safeParse({ closeGraceMs: value }).success,
    },
  };
  for (const path of Object.keys(blessed)) {
    assert.ok(discovered.has(path), `a blessing exists for a knob the resolver no longer returns: ${path} (stale blessing — remove it)`);
  }
  const failures: string[] = [];
  for (const [path, value] of discovered) {
    const leaf = path.slice(path.indexOf(".") + 1);
    if (new RegExp(`${leaf}:\\s*ROOT_POLICY\\.`, "u").test(block)) continue;
    const blessing = blessed[path];
    if (blessing === undefined) {
      failures.push(`${path} is a bare literal in the module default with no blessing here (value ${JSON.stringify(value)})`);
      continue;
    }
    if (!blessing.check(value)) {
      failures.push(`${path} is blessed but broke its bound: ${blessing.why} (value ${JSON.stringify(value)})`);
    }
  }
  assert.deepEqual(failures, [], `module-default knobs that are neither policy-derived nor blessed:\n${failures.join("\n")}`);
});

test("no-static-constants: DEFAULT_MCP_RETRY is a module default (not a server config)", () => {
  // The retry defaults (count: 3, backoffMs: 1000) are module-level defaults
  // overridable by per-server config. They are not "server configs" or URLs.
  assert.equal(DEFAULT_MCP_RETRY.count, 3);
  assert.equal(DEFAULT_MCP_RETRY.backoffMs, 1000);
  // Verify they're within ROOT_POLICY limits.
  assert.ok(DEFAULT_MCP_RETRY.count <= ROOT_POLICY.runtime.limits.maximumRetries);
  assert.ok(DEFAULT_MCP_RETRY.backoffMs <= ROOT_POLICY.runtime.limits.maximumBackoffMs);
});

test("no-static-constants: URL_PATTERN imported from config-contracts (not re-declared) in config.ts", () => {
  const src = readMcpFile("config.ts");
  // The invariant is semantic: config.ts imports URL_PATTERN from the
  // config-contracts OWNER (a specifier ending in "config-contracts"), wherever
  // the fold has placed that owner — not from a hardcoded path spelling, which
  // would break on every move while the import stayed correct.
  assert.ok(
    /import\s*\{[^}]*URL_PATTERN[^}]*\}\s*from\s*["'`][^"'`]*config-contracts/u.test(src),
    "config.ts must import URL_PATTERN from config-contracts (canonical owner), not re-declare it",
  );
  assert.ok(
    !/const\s+URL_PATTERN\s*=/u.test(src),
    "config.ts must not re-declare URL_PATTERN (DRY — one canonical owner in config-contracts.ts)",
  );
  assert.ok(
    !/const\s+WS_URL_PATTERN\s*=/u.test(src),
    "config.ts must not re-declare WS_URL_PATTERN (DRY — one canonical owner in config-contracts.ts)",
  );
});
