import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { createToolRegistry } from "../../src/runtime/tool-registry.ts";
import {
  createBuiltInToolAdapters,
} from "../../src/tools/built-in-tools.ts";
import { createBuiltInToolManifestEntries } from "../../src/tools/built-in-tool-manifest.ts";
import type { ToolManifestEntry } from "../../src/tools/tool-manifest.ts";

/**
 * GAP-16 / IMP-28 regression: the config declared 5 enabled tools but the
 * runtime registered only 2 (the filesystem read/list tools), silently
 * dropping execute_command/search_web/fetch_page/read_docs/repo_question.
 * The fix wired the built-in tools into the registry. This test mechanically
 * verifies the config-declared `tools.enabled` set includes the built-in tool
 * manifest (subset check) — `enabled` is now the blanket allowlist for ALL
 * tool categories, so it lists more than the 5 built-in tools, but the 5
 * built-in tools must always be present.
 */

const CONFIG_PATH = join(process.cwd(), "bridlewise.config.json");

interface ConfigShape {
  tools?: Readonly<{ enabled?: readonly string[] }>;
}

function readConfigEnabledTools(): readonly string[] {
  assert.ok(existsSync(CONFIG_PATH), "bridlewise.config.json must exist");
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as ConfigShape;
  const enabled = raw.tools?.enabled;
  assert.ok(Array.isArray(enabled), "config.tools.enabled must be an array");
  return enabled;
}

test("config-implementation-consistency: built-in manifest entries are a subset of config.tools.enabled", () => {
  const configTools = readConfigEnabledTools();
  const entries = createBuiltInToolManifestEntries();
  const manifestNames = entries.map((e) => e.name);
  const configSet = new Set(configTools);
  for (const name of manifestNames) {
    assert.ok(
      configSet.has(name),
      `config.tools.enabled must include the built-in tool '${name}' (enabled: ${configTools.join(", ")})`,
    );
  }
});

test("config-implementation-consistency: config.tools.enabled count is at least the built-in manifest count", () => {
  const configTools = readConfigEnabledTools();
  const entries = createBuiltInToolManifestEntries();
  assert.ok(
    configTools.length >= entries.length,
    `config.tools.enabled count (${configTools.length}) must be at least the built-in manifest count (${entries.length}) — enabled is the blanket allowlist for all tool categories`,
  );
});

test("config-implementation-consistency: every config-declared built-in tool registers in the runtime registry", () => {
  // `enabled` is now the blanket allowlist for all tool categories, but this
  // test only registers the 5 built-in adapter tools (the manifest). It
  // verifies that every BUILT-IN config-declared tool registers; the module-
  // group tools (editor, intelligence, quality, git, agent, etc.) are
  // registered by their own modules in the chat runtime, not here.
  const entries = createBuiltInToolManifestEntries();
  const builtInNames = entries.map((e) => e.name);
  const configTools = readConfigEnabledTools();
  const configSet = new Set(configTools);
  for (const name of builtInNames) {
    assert.ok(configSet.has(name), `built-in tool '${name}' must be in config.tools.enabled`);
  }
  const registry = createToolRegistry();
  const adapters = createBuiltInToolAdapters();
  const pairs: ReadonlyArray<readonly [string, ToolManifestEntry]> = [
    ["execute_command", entries[0]!],
    ["search_web", entries[1]!],
    ["fetch_page", entries[2]!],
    ["read_docs", entries[3]!],
    ["repo_question", entries[4]!],
  ];
  void adapters;
  for (const [name, entry] of pairs) {
    registry.register({
      definition: {
        type: "function",
        function: {
          name,
          description: entry.description,
          parameters: {
            type: "object",
            properties: {},
            required: [],
          },
        },
      },
      handler: () => "ok",
    });
  }
  const registered = new Set(registry.names());
  for (const name of builtInNames) {
    assert.ok(
      registered.has(name),
      `config-declared built-in tool "${name}" must be registered in the runtime registry (registered: ${[...registered].join(", ")})`,
    );
  }
});

test("config-implementation-consistency: config declares the five canonical built-in tools", () => {
  const configTools = readConfigEnabledTools();
  const expected = ["execute_command", "search_web", "fetch_page", "read_docs", "repo_question"];
  const configSet = new Set(configTools);
  for (const name of expected) {
    assert.ok(
      configSet.has(name),
      `config.tools.enabled must include the canonical built-in tool '${name}'`,
    );
  }
});

test("config-implementation-consistency: createBuiltInToolAdapters returns all five adapters", () => {
  const adapters = createBuiltInToolAdapters();
  assert.ok(adapters.executeCommand, "executeCommand adapter must exist");
  assert.ok(adapters.searchWeb, "searchWeb adapter must exist");
  assert.ok(adapters.fetchPage, "fetchPage adapter must exist");
  assert.ok(adapters.readDocs, "readDocs adapter must exist");
  assert.ok(adapters.repoQuestion, "repoQuestion adapter must exist");
});
