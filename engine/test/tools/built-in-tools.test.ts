import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  createExecuteCommandTool,
  createSearchWebTool,
  createFetchPageTool,
  createReadDocsTool,
  createRepoQuestionTool,
  createBuiltInToolAdapters,
  generateToolCallId,
  type SearchAdapter,
  type PageFetchAdapter,
  type DocsAdapter,
  type RepoQuestionAdapter,
} from "../../src/tools/built-in-tools.ts";
import { createBuiltInToolManifestEntries } from "../../src/tools/built-in-tool-manifest.ts";
import type { ToolAdapter, ToolAdapterContext } from "../../src/tools/tool-adapter.ts";
import { mkOwnedTempDir, systemTempRoot } from "../support/temp-dir.ts";

const REPO_ROOT = mkOwnedTempDir("builtin-tool-");
const defaultContext: ToolAdapterContext = { repositoryRoot: REPO_ROOT };

// ============================================================================
// execute_command
// ============================================================================

test("exec-cmd: runs allowed command echo", async () => {
  const tool = createExecuteCommandTool();
  const result = await tool.execute(
    { toolId: "execute_command", arguments: { command: "echo", args: ["hello"] } },
    defaultContext,
  );
  assert.equal(result.isError, false);
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.exitCode, 0);
  assert.ok(parsed.stdout.includes("hello"));
});

test("exec-cmd: runs allowed command pwd", async () => {
  const tool = createExecuteCommandTool();
  const result = await tool.execute(
    { toolId: "execute_command", arguments: { command: "pwd" } },
    defaultContext,
  );
  assert.equal(result.isError, false);
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.exitCode, 0);
  assert.ok(parsed.stdout.length > 0);
});

test("exec-cmd: rejects disallowed command", async () => {
  const tool = createExecuteCommandTool();
  await assert.rejects(
    tool.execute(
      { toolId: "execute_command", arguments: { command: "rm" } },
      defaultContext,
    ),
  );
});

test("exec-cmd: rejects command with shell metachars", async () => {
  const tool = createExecuteCommandTool();
  await assert.rejects(
    tool.execute(
      { toolId: "execute_command", arguments: { command: "echo;rm" } },
      defaultContext,
    ),
  );
});

test("exec-cmd: rejects empty command", async () => {
  const tool = createExecuteCommandTool();
  await assert.rejects(
    tool.execute(
      { toolId: "execute_command", arguments: { command: "" } },
      defaultContext,
    ),
  );
});

test("exec-cmd: rejects missing command field", async () => {
  const tool = createExecuteCommandTool();
  await assert.rejects(
    tool.execute(
      { toolId: "execute_command", arguments: {} },
      defaultContext,
    ),
  );
});

test("exec-cmd: captures stderr on non-zero exit", async () => {
  const tool = createExecuteCommandTool();
  const result = await tool.execute(
    { toolId: "execute_command", arguments: { command: "ls", args: ["/nonexistent-dir-12345"] } },
    defaultContext,
  );
  assert.equal(result.isError, true);
  const parsed = JSON.parse(result.content);
  assert.notEqual(parsed.exitCode, 0);
  assert.ok(parsed.stderr.length > 0);
});

test("exec-cmd: uses cwd from arguments", async () => {
  const tool = createExecuteCommandTool();
  const result = await tool.execute(
    { toolId: "execute_command", arguments: { command: "pwd", cwd: "/tmp" } },
    defaultContext,
  );
  assert.equal(result.isError, false);
  const parsed = JSON.parse(result.content);
  assert.ok(parsed.stdout.trim() === "/tmp" || parsed.stdout.includes("tmp"));
});

test("exec-cmd: defaults cwd to repositoryRoot", async () => {
  const tool = createExecuteCommandTool();
  const result = await tool.execute(
    { toolId: "execute_command", arguments: { command: "pwd" } },
    defaultContext,
  );
  assert.equal(result.isError, false);
  const parsed = JSON.parse(result.content);
  assert.ok(parsed.stdout.includes(REPO_ROOT) || parsed.stdout.trim() === REPO_ROOT);
});

test("exec-cmd: handles non-existent command gracefully", async () => {
  const tool = createExecuteCommandTool();
  const result = await tool.execute(
    { toolId: "execute_command", arguments: { command: "node", args: ["--invalid-flag-xyz123"] } },
    defaultContext,
  );
  assert.equal(result.isError, true);
});

test("exec-cmd: accepts args as array", async () => {
  const tool = createExecuteCommandTool();
  const result = await tool.execute(
    { toolId: "execute_command", arguments: { command: "echo", args: ["a", "b", "c"] } },
    defaultContext,
  );
  assert.equal(result.isError, false);
  const parsed = JSON.parse(result.content);
  assert.ok(parsed.stdout.includes("a"));
  assert.ok(parsed.stdout.includes("b"));
  assert.ok(parsed.stdout.includes("c"));
});

test("exec-cmd: empty args array is fine", async () => {
  const tool = createExecuteCommandTool();
  const result = await tool.execute(
    { toolId: "execute_command", arguments: { command: "echo", args: [] } },
    defaultContext,
  );
  assert.equal(result.isError, false);
});

test("exec-cmd: rejects too many args", async () => {
  const tool = createExecuteCommandTool();
  await assert.rejects(
    tool.execute(
      { toolId: "execute_command", arguments: { command: "echo", args: Array(100).fill("x") } },
      defaultContext,
    ),
  );
});

test("exec-cmd: rejects oversized arg", async () => {
  const tool = createExecuteCommandTool();
  await assert.rejects(
    tool.execute(
      { toolId: "execute_command", arguments: { command: "echo", args: ["x".repeat(5000)] } },
      defaultContext,
    ),
  );
});

test("exec-cmd: supports cancellation", async () => {
  const tool = createExecuteCommandTool();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);
  const result = await tool.execute(
    { toolId: "execute_command", arguments: { command: "node", args: ["-e", "setTimeout(()=>{},5000)"] } },
    { repositoryRoot: REPO_ROOT, signal: controller.signal },
  );
  assert.equal(result.isError, true);
});

test("exec-cmd: result is frozen", async () => {
  const tool = createExecuteCommandTool();
  const result = await tool.execute(
    { toolId: "execute_command", arguments: { command: "echo", args: ["test"] } },
    defaultContext,
  );
  assert.ok(Object.isFrozen(result));
});

test("exec-cmd: git is refused, typed, in every spelling the door can be handed — its needs go through the git tools", async () => {
  // Even a list that names them: the door judges what the command reaches, not only its name.
  const tool = createExecuteCommandTool({ allowedCommands: ["git", "/usr/bin/git", "env", "sh", "find", "rg", "fd", "sort"] });
  for (const [command, args, code] of [
    ["git", ["commit", "-m", "x"], "tool_command_reaches_git"],
    ["/usr/bin/git", ["commit", "-m", "x"], "tool_command_reaches_git"],
    ["env", ["git", "commit", "-m", "x"], "tool_command_launches_programs"],
    ["sh", ["-c", "git commit -m x"], "tool_command_launches_programs"],
    ["find", [".", "-exec", "git", "commit", "-m", "x", ";"], "tool_command_argument_launches_program"],
    ["rg", ["--pre=git", "x"], "tool_command_argument_launches_program"],
    ["fd", ["-Hx", "git", "commit"], "tool_command_argument_launches_program"],
    ["sort", ["--compress-program=git", "a"], "tool_command_argument_launches_program"],
  ] as const) {
    await assert.rejects(
      tool.execute({ toolId: "execute_command", arguments: { command, args: [...args] } }, defaultContext),
      (error: unknown) => (error as { code?: string }).code === code,
      `${command} ${args.join(" ")}`,
    );
  }
});

test("exec-cmd: CONF-5 custom allowedCommands permit only configured commands", async () => {
  const tool = createExecuteCommandTool({ allowedCommands: ["echo", "pwd"] });
  const ok = await tool.execute(
    { toolId: "execute_command", arguments: { command: "echo", args: ["x"] } },
    defaultContext,
  );
  assert.equal(ok.isError, false);
  // ls is NOT in the custom list → rejected even though it is in the default list
  await assert.rejects(
    tool.execute(
      { toolId: "execute_command", arguments: { command: "ls", args: ["-a"] } },
      defaultContext,
    ),
  );
});

test("exec-cmd: CONF-5 empty allowedCommands rejects all commands", async () => {
  const tool = createExecuteCommandTool({ allowedCommands: [] });
  await assert.rejects(
    tool.execute(
      { toolId: "execute_command", arguments: { command: "echo", args: ["x"] } },
      defaultContext,
    ),
  );
});

test("exec-cmd: CONF-5 createBuiltInToolAdapters passes allowedCommands through", async () => {
  const adapters = createBuiltInToolAdapters({ allowedCommands: ["echo"] });
  const ok = await adapters.executeCommand.execute(
    { toolId: "execute_command", arguments: { command: "echo", args: ["x"] } },
    defaultContext,
  );
  assert.equal(ok.isError, false);
  await assert.rejects(
    adapters.executeCommand.execute(
      { toolId: "execute_command", arguments: { command: "ls" } },
      defaultContext,
    ),
  );
});

test("exec-cmd: npm command is allowed", async () => {
  const tool = createExecuteCommandTool();
  const result = await tool.execute(
    { toolId: "execute_command", arguments: { command: "npm", args: ["--version"] } },
    defaultContext,
  );
  assert.equal(result.isError, false);
});

test("exec-cmd: grep command is allowed", async () => {
  const tool = createExecuteCommandTool();
  const result = await tool.execute(
    { toolId: "execute_command", arguments: { command: "echo", args: ["hello world"] } },
    defaultContext,
  );
  assert.equal(result.isError, false);
});

// ============================================================================
// search_web
// ============================================================================

const mockSearchAdapter: SearchAdapter = {
  async search(query: string, _opts: { limit?: number }) {
    return [
      { title: `Result for ${query}`, url: "https://example.com/1", snippet: "snippet 1" },
      { title: "Result 2", url: "https://example.com/2", snippet: "snippet 2" },
    ];
  },
};

test("search-web: returns results with adapter", async () => {
  const tool = createSearchWebTool(mockSearchAdapter);
  const result = await tool.execute(
    { toolId: "search_web", arguments: { query: "test query" } },
    defaultContext,
  );
  assert.equal(result.isError, false);
  const parsed = JSON.parse(result.content);
  assert.equal(parsed.length, 2);
  assert.ok(parsed[0].title.includes("test query"));
});

test("search-web: returns blocker without adapter", async () => {
  const tool = createSearchWebTool();
  const result = await tool.execute(
    { toolId: "search_web", arguments: { query: "test" } },
    defaultContext,
  );
  assert.equal(result.isError, true);
  assert.ok(result.content.includes("not configured"));
  assert.equal(result.metadata!.reason, "adapter_missing");
});

test("search-web: rejects empty query", async () => {
  const tool = createSearchWebTool(mockSearchAdapter);
  await assert.rejects(
    tool.execute({ toolId: "search_web", arguments: { query: "" } }, defaultContext),
  );
});

test("search-web: rejects missing query", async () => {
  const tool = createSearchWebTool(mockSearchAdapter);
  await assert.rejects(
    tool.execute({ toolId: "search_web", arguments: {} }, defaultContext),
  );
});

test("search-web: rejects oversized query", async () => {
  const tool = createSearchWebTool(mockSearchAdapter);
  await assert.rejects(
    tool.execute({ toolId: "search_web", arguments: { query: "x".repeat(3000) } }, defaultContext),
  );
});

test("search-web: applies limit from arguments", async () => {
  let capturedLimit: number | undefined;
  const adapter: SearchAdapter = {
    async search(_q: string, opts: { limit?: number }) { capturedLimit = opts.limit; return []; },
  };
  const tool = createSearchWebTool(adapter);
  await tool.execute({ toolId: "search_web", arguments: { query: "test", limit: 5 } }, defaultContext);
  assert.equal(capturedLimit, 5);
});

test("search-web: defaults limit to 10", async () => {
  let capturedLimit: number | undefined;
  const adapter: SearchAdapter = {
    async search(_q: string, opts: { limit?: number }) { capturedLimit = opts.limit; return []; },
  };
  const tool = createSearchWebTool(adapter);
  await tool.execute({ toolId: "search_web", arguments: { query: "test" } }, defaultContext);
  assert.equal(capturedLimit, 10);
});

test("search-web: handles adapter error gracefully", async () => {
  const adapter: SearchAdapter = {
    async search() { throw new Error("search failed"); },
  };
  const tool = createSearchWebTool(adapter);
  const result = await tool.execute({ toolId: "search_web", arguments: { query: "test" } }, defaultContext);
  assert.equal(result.isError, true);
  assert.ok(result.content.includes("search failed"));
});

test("search-web: structured output contains results", async () => {
  const tool = createSearchWebTool(mockSearchAdapter);
  const result = await tool.execute({ toolId: "search_web", arguments: { query: "test" } }, defaultContext);
  assert.ok(result.structured);
  assert.ok((result.structured!.results as readonly unknown[]).length === 2);
});

test("search-web: result is frozen", async () => {
  const tool = createSearchWebTool(mockSearchAdapter);
  const result = await tool.execute({ toolId: "search_web", arguments: { query: "test" } }, defaultContext);
  assert.ok(Object.isFrozen(result));
});

// ============================================================================
// fetch_page
// ============================================================================

const mockFetchAdapter: PageFetchAdapter = {
  async fetch(url: string) {
    return { url, content: "# Page Title\n\nContent here.", contentType: "text/markdown", statusCode: 200 };
  },
};

test("fetch-page: returns content with adapter", async () => {
  const tool = createFetchPageTool(mockFetchAdapter);
  const result = await tool.execute(
    { toolId: "fetch_page", arguments: { url: "https://example.com" } },
    defaultContext,
  );
  assert.equal(result.isError, false);
  assert.ok(result.content.includes("Page Title"));
});

test("fetch-page: returns blocker without adapter", async () => {
  const tool = createFetchPageTool();
  const result = await tool.execute(
    { toolId: "fetch_page", arguments: { url: "https://example.com" } },
    defaultContext,
  );
  assert.equal(result.isError, true);
  assert.ok(result.content.includes("not configured"));
});

test("fetch-page: rejects empty url", async () => {
  const tool = createFetchPageTool(mockFetchAdapter);
  await assert.rejects(
    tool.execute({ toolId: "fetch_page", arguments: { url: "" } }, defaultContext),
  );
});

test("fetch-page: rejects missing url", async () => {
  const tool = createFetchPageTool(mockFetchAdapter);
  await assert.rejects(
    tool.execute({ toolId: "fetch_page", arguments: {} }, defaultContext),
  );
});

test("fetch-page: rejects non-http url", async () => {
  const tool = createFetchPageTool(mockFetchAdapter);
  await assert.rejects(
    tool.execute({ toolId: "fetch_page", arguments: { url: "ftp://example.com" } }, defaultContext),
  );
});

test("fetch-page: rejects oversized url", async () => {
  const tool = createFetchPageTool(mockFetchAdapter);
  await assert.rejects(
    tool.execute({ toolId: "fetch_page", arguments: { url: "x".repeat(5000) } }, defaultContext),
  );
});

test("fetch-page: passes format to adapter", async () => {
  let capturedFormat: string | undefined;
  const adapter: PageFetchAdapter = {
    async fetch(url: string, opts: { format?: string }) { capturedFormat = opts.format; return { url, content: "", contentType: "text", statusCode: 200 }; },
  };
  const tool = createFetchPageTool(adapter);
  await tool.execute({ toolId: "fetch_page", arguments: { url: "https://example.com", format: "html" } }, defaultContext);
  assert.equal(capturedFormat, "html");
});

test("fetch-page: defaults format to markdown", async () => {
  let capturedFormat: string | undefined;
  const adapter: PageFetchAdapter = {
    async fetch(url: string, opts: { format?: string }) { capturedFormat = opts.format; return { url, content: "", contentType: "text", statusCode: 200 }; },
  };
  const tool = createFetchPageTool(adapter);
  await tool.execute({ toolId: "fetch_page", arguments: { url: "https://example.com" } }, defaultContext);
  assert.equal(capturedFormat, "markdown");
});

test("fetch-page: handles adapter error", async () => {
  const adapter: PageFetchAdapter = {
    async fetch() { throw new Error("fetch failed"); },
  };
  const tool = createFetchPageTool(adapter);
  const result = await tool.execute({ toolId: "fetch_page", arguments: { url: "https://example.com" } }, defaultContext);
  assert.equal(result.isError, true);
  assert.ok(result.content.includes("fetch failed"));
});

test("fetch-page: structured output has statusCode", async () => {
  const tool = createFetchPageTool(mockFetchAdapter);
  const result = await tool.execute({ toolId: "fetch_page", arguments: { url: "https://example.com" } }, defaultContext);
  assert.equal(result.structured!.statusCode, 200);
});

// ============================================================================
// read_docs
// ============================================================================

const mockDocsAdapter: DocsAdapter = {
  async query(libraryId: string, query: string) {
    return { libraryId, query, content: "Documentation content", sources: ["https://docs.example.com"] };
  },
};

test("read-docs: returns content with adapter", async () => {
  const tool = createReadDocsTool(mockDocsAdapter);
  const result = await tool.execute(
    { toolId: "read_docs", arguments: { libraryId: "/org/project", query: "how to use" } },
    defaultContext,
  );
  assert.equal(result.isError, false);
  assert.ok(result.content.includes("Documentation content"));
});

test("read-docs: returns blocker without adapter", async () => {
  const tool = createReadDocsTool();
  const result = await tool.execute(
    { toolId: "read_docs", arguments: { libraryId: "/org/project", query: "how to use" } },
    defaultContext,
  );
  assert.equal(result.isError, true);
  assert.ok(result.content.includes("not configured"));
});

test("read-docs: rejects empty libraryId", async () => {
  const tool = createReadDocsTool(mockDocsAdapter);
  await assert.rejects(
    tool.execute({ toolId: "read_docs", arguments: { libraryId: "", query: "test" } }, defaultContext),
  );
});

test("read-docs: rejects missing query", async () => {
  const tool = createReadDocsTool(mockDocsAdapter);
  await assert.rejects(
    tool.execute({ toolId: "read_docs", arguments: { libraryId: "/org/project" } }, defaultContext),
  );
});

test("read-docs: rejects oversized query", async () => {
  const tool = createReadDocsTool(mockDocsAdapter);
  await assert.rejects(
    tool.execute({ toolId: "read_docs", arguments: { libraryId: "/org/project", query: "x".repeat(5000) } }, defaultContext),
  );
});

test("read-docs: handles adapter error", async () => {
  const adapter: DocsAdapter = {
    async query() { throw new Error("docs service down"); },
  };
  const tool = createReadDocsTool(adapter);
  const result = await tool.execute({ toolId: "read_docs", arguments: { libraryId: "/org/project", query: "test" } }, defaultContext);
  assert.equal(result.isError, true);
});

test("read-docs: structured output has sources", async () => {
  const tool = createReadDocsTool(mockDocsAdapter);
  const result = await tool.execute({ toolId: "read_docs", arguments: { libraryId: "/org/project", query: "test" } }, defaultContext);
  assert.ok(result.structured);
  assert.ok((result.structured!.sources as readonly string[]).length > 0);
});

// ============================================================================
// repo_question
// ============================================================================

const mockRepoAdapter: RepoQuestionAdapter = {
  async ask(repo: string, question: string) {
    return { repo, question, answer: "This repo does X.", sources: ["https://deepwiki.com/page"] };
  },
};

test("repo-q: returns answer with adapter", async () => {
  const tool = createRepoQuestionTool(mockRepoAdapter);
  const result = await tool.execute(
    { toolId: "repo_question", arguments: { repo: "owner/repo", question: "What does this repo do?" } },
    defaultContext,
  );
  assert.equal(result.isError, false);
  assert.ok(result.content.includes("does X"));
});

test("repo-q: returns blocker without adapter", async () => {
  const tool = createRepoQuestionTool();
  const result = await tool.execute(
    { toolId: "repo_question", arguments: { repo: "owner/repo", question: "What?" } },
    defaultContext,
  );
  assert.equal(result.isError, true);
  assert.ok(result.content.includes("not configured"));
});

test("repo-q: rejects empty repo", async () => {
  const tool = createRepoQuestionTool(mockRepoAdapter);
  await assert.rejects(
    tool.execute({ toolId: "repo_question", arguments: { repo: "", question: "test" } }, defaultContext),
  );
});

test("repo-q: rejects invalid repo format", async () => {
  const tool = createRepoQuestionTool(mockRepoAdapter);
  await assert.rejects(
    tool.execute({ toolId: "repo_question", arguments: { repo: "not-a-repo", question: "test" } }, defaultContext),
  );
});

test("repo-q: rejects missing question", async () => {
  const tool = createRepoQuestionTool(mockRepoAdapter);
  await assert.rejects(
    tool.execute({ toolId: "repo_question", arguments: { repo: "owner/repo" } }, defaultContext),
  );
});

test("repo-q: rejects oversized question", async () => {
  const tool = createRepoQuestionTool(mockRepoAdapter);
  await assert.rejects(
    tool.execute({ toolId: "repo_question", arguments: { repo: "owner/repo", question: "x".repeat(5000) } }, defaultContext),
  );
});

test("repo-q: handles adapter error", async () => {
  const adapter: RepoQuestionAdapter = {
    async ask() { throw new Error("deepwiki unavailable"); },
  };
  const tool = createRepoQuestionTool(adapter);
  const result = await tool.execute({ toolId: "repo_question", arguments: { repo: "owner/repo", question: "test" } }, defaultContext);
  assert.equal(result.isError, true);
});

test("repo-q: structured output has sources", async () => {
  const tool = createRepoQuestionTool(mockRepoAdapter);
  const result = await tool.execute({ toolId: "repo_question", arguments: { repo: "owner/repo", question: "test" } }, defaultContext);
  assert.ok(result.structured);
  assert.ok((result.structured!.sources as readonly string[]).length > 0);
});

// ============================================================================
// Manifest entries
// ============================================================================

test("manifest-entries: creates 5 built-in entries", () => {
  const entries = createBuiltInToolManifestEntries();
  assert.equal(entries.length, 5);
});

test("manifest-entries: all entries have unique ids", () => {
  const entries = createBuiltInToolManifestEntries();
  const ids = entries.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("manifest-entries: all entries have unique names", () => {
  const entries = createBuiltInToolManifestEntries();
  const names = entries.map((e) => e.name);
  assert.equal(new Set(names).size, names.length);
});

test("manifest-entries: all entries have type object inputSchema", () => {
  const entries = createBuiltInToolManifestEntries();
  for (const entry of entries) {
    assert.equal(entry.inputSchema.type, "object");
  }
});

test("manifest-entries: all entries have at least one capability", () => {
  const entries = createBuiltInToolManifestEntries();
  for (const entry of entries) {
    assert.ok(entry.capabilities.length > 0);
  }
});

test("manifest-entries: all entries have positive bounds", () => {
  const entries = createBuiltInToolManifestEntries();
  for (const entry of entries) {
    assert.ok(entry.bounds.timeoutMs > 0);
    assert.ok(entry.bounds.maxOutputBytes > 0);
    assert.ok(entry.bounds.maxMemoryBytes > 0);
  }
});

test("manifest-entries: execute_command has execute capability", () => {
  const entries = createBuiltInToolManifestEntries();
  const cmd = entries.find((e) => e.id === "execute_command")!;
  assert.ok(cmd.capabilities.includes("execute"));
});

test("manifest-entries: search_web has network capability", () => {
  const entries = createBuiltInToolManifestEntries();
  const search = entries.find((e) => e.id === "search_web")!;
  assert.ok(search.capabilities.includes("network"));
});

test("manifest-entries: fetch_page has network capability", () => {
  const entries = createBuiltInToolManifestEntries();
  const fetch = entries.find((e) => e.id === "fetch_page")!;
  assert.ok(fetch.capabilities.includes("network"));
});

test("manifest-entries: read_docs has network capability", () => {
  const entries = createBuiltInToolManifestEntries();
  const docs = entries.find((e) => e.id === "read_docs")!;
  assert.ok(docs.capabilities.includes("network"));
});

test("manifest-entries: repo_question has network capability", () => {
  const entries = createBuiltInToolManifestEntries();
  const repo = entries.find((e) => e.id === "repo_question")!;
  assert.ok(repo.capabilities.includes("network"));
});

test("manifest-entries: all entries are frozen", () => {
  const entries = createBuiltInToolManifestEntries();
  for (const entry of entries) {
    assert.ok(Object.isFrozen(entry));
    assert.ok(Object.isFrozen(entry.bounds));
  }
});

// ============================================================================
// createBuiltInToolAdapters
// ============================================================================

test("built-in-adapters: creates all 5 adapters", () => {
  const adapters = createBuiltInToolAdapters();
  assert.ok(adapters.executeCommand);
  assert.ok(adapters.searchWeb);
  assert.ok(adapters.fetchPage);
  assert.ok(adapters.readDocs);
  assert.ok(adapters.repoQuestion);
});

test("built-in-adapters: creates with custom adapters", () => {
  const adapters = createBuiltInToolAdapters({
    searchAdapter: mockSearchAdapter,
    fetchAdapter: mockFetchAdapter,
    docsAdapter: mockDocsAdapter,
    repoAdapter: mockRepoAdapter,
  });
  assert.ok(adapters.searchWeb);
  assert.ok(adapters.fetchPage);
  assert.ok(adapters.readDocs);
  assert.ok(adapters.repoQuestion);
});

test("built-in-adapters: adapters are frozen", () => {
  const adapters = createBuiltInToolAdapters();
  assert.ok(Object.isFrozen(adapters));
});

// ============================================================================
// generateToolCallId
// ============================================================================

test("tool-call-id: generates unique ids", () => {
  const id1 = generateToolCallId();
  const id2 = generateToolCallId();
  assert.notEqual(id1, id2);
  assert.ok(id1.startsWith("tool-call-"));
});

// ============================================================================
// X-1: execute_command mutating-command write-set governance
// ============================================================================
//
// A dedicated temp root per concern keeps fixtures isolated from the shared
// REPO_ROOT. Write-set entries are repository-root-relative; targets are
// resolved against the command cwd (the repository root by default).
// ============================================================================

function makeGateFixture(): { root: string; context: ToolAdapterContext } {
  const root = mkOwnedTempDir("exec-gate-");
  mkdirSync(join(root, "scratch"), { recursive: true });
  mkdirSync(join(root, "other"), { recursive: true });
  return { root, context: { repositoryRoot: root } };
}

test("exec-cmd: X-1 touch is denied when no write set is granted", async () => {
  const { context } = makeGateFixture();
  const tool = createExecuteCommandTool();
  await assert.rejects(
    tool.execute({ toolId: "execute_command", arguments: { command: "touch", args: ["scratch/new.txt"] } }, context),
    /outside the session write set/,
  );
});

test("exec-cmd: X-1 touch is allowed when the target is inside the write set", async () => {
  const { root, context } = makeGateFixture();
  const tool = createExecuteCommandTool({ writeSet: new Set(["scratch/"]) });
  const result = await tool.execute(
    { toolId: "execute_command", arguments: { command: "touch", args: ["scratch/made.txt"] } },
    context,
  );
  assert.equal(result.isError, false);
  assert.ok(existsSync(join(root, "scratch", "made.txt")), "touch must create the file inside the write set");
});

test("exec-cmd: X-1 touch is denied when the target is outside the write set", async () => {
  const { root, context } = makeGateFixture();
  const tool = createExecuteCommandTool({ writeSet: new Set(["scratch/"]) });
  await assert.rejects(
    tool.execute({ toolId: "execute_command", arguments: { command: "touch", args: ["other/nope.txt"] } }, context),
    /outside the session write set/,
  );
  assert.equal(existsSync(join(root, "other", "nope.txt")), false, "the denied command must not run");
});

test("exec-cmd: X-1 denial error is a typed SecurityError with code tool_command_write_denied", async () => {
  const { context } = makeGateFixture();
  const tool = createExecuteCommandTool();
  const failure = await tool.execute(
    { toolId: "execute_command", arguments: { command: "mkdir", args: ["anywhere"] } },
    context,
  ).then(() => null, (error: unknown) => error as { code?: string });
  assert.equal(failure?.code, "tool_command_write_denied");
});

test("exec-cmd: X-1 mkdir -m skips the mode value when extracting targets", async () => {
  const { root, context } = makeGateFixture();
  const tool = createExecuteCommandTool({ writeSet: new Set(["scratch/"]) });
  const result = await tool.execute(
    { toolId: "execute_command", arguments: { command: "mkdir", args: ["-m", "755", "-p", "scratch/nested/deep"] } },
    context,
  );
  assert.equal(result.isError, false);
  assert.ok(existsSync(join(root, "scratch", "nested", "deep")), "mkdir -p must create the nested directory");
});

test("exec-cmd: X-1 cp gates only the destination (sources are reads)", async () => {
  const { root, context } = makeGateFixture();
  writeFileSync(join(root, "other", "source.txt"), "payload");
  const tool = createExecuteCommandTool({ writeSet: new Set(["scratch/"]) });
  const result = await tool.execute(
    { toolId: "execute_command", arguments: { command: "cp", args: ["other/source.txt", "scratch/copied.txt"] } },
    context,
  );
  assert.equal(result.isError, false);
  assert.equal(readFileSync(join(root, "scratch", "copied.txt"), "utf8"), "payload");
});

test("exec-cmd: X-1 cp is denied when the destination is outside the write set", async () => {
  const { root, context } = makeGateFixture();
  writeFileSync(join(root, "scratch", "source.txt"), "payload");
  const tool = createExecuteCommandTool({ writeSet: new Set(["scratch/"]) });
  await assert.rejects(
    tool.execute({ toolId: "execute_command", arguments: { command: "cp", args: ["scratch/source.txt", "other/copied.txt"] } }, context),
    /outside the session write set/,
  );
});

test("exec-cmd: X-1 mv requires every operand inside the write set", async () => {
  const { root, context } = makeGateFixture();
  writeFileSync(join(root, "scratch", "before.txt"), "payload");
  const tool = createExecuteCommandTool({ writeSet: new Set(["scratch/"]) });
  // Moving scratch/before.txt to other/after.txt destroys the source inside
  // the write set but writes outside it → denied.
  await assert.rejects(
    tool.execute({ toolId: "execute_command", arguments: { command: "mv", args: ["scratch/before.txt", "other/after.txt"] } }, context),
    /outside the session write set/,
  );
  // Moving within the write set is allowed.
  const result = await tool.execute(
    { toolId: "execute_command", arguments: { command: "mv", args: ["scratch/before.txt", "scratch/after.txt"] } },
    context,
  );
  assert.equal(result.isError, false);
  assert.ok(existsSync(join(root, "scratch", "after.txt")));
});

test("exec-cmd: sed and awk are general interpreters, refused as launchers in every form — even listed, even with a write set", async () => {
  const { root, context } = makeGateFixture();
  writeFileSync(join(root, "scratch", "data.txt"), "alpha beta");
  const tool = createExecuteCommandTool({ allowedCommands: ["sed", "awk", "gawk"], writeSet: new Set(["scratch/"]) });
  for (const [command, args] of [
    ["sed", ["s/alpha/gamma/", "scratch/data.txt"]],
    ["sed", ["-i", "s/alpha/gamma/", "scratch/data.txt"]],
    ["sed", ["s/x/git commit/e", "scratch/data.txt"]],
    ["awk", ["{ print $1 }", "scratch/data.txt"]],
    ["awk", ['BEGIN { system("git commit -m x") }']],
    ["gawk", ["-i", "inplace", "{ print }", "scratch/data.txt"]],
  ] as const) {
    await assert.rejects(
      tool.execute({ toolId: "execute_command", arguments: { command, args: [...args] } }, context),
      (error: unknown) => (error as { code?: string }).code === "tool_command_launches_programs",
      `${command} ${args.join(" ")}`,
    );
  }
  assert.equal(readFileSync(join(root, "scratch", "data.txt"), "utf8"), "alpha beta", "nothing ran");
});

test("exec-cmd: X-1 write-set matching honors exact file entries", async () => {
  const { root, context } = makeGateFixture();
  writeFileSync(join(root, "scratch", "exact.txt"), "payload");
  const tool = createExecuteCommandTool({ writeSet: new Set(["scratch/exact.txt"]) });
  const result = await tool.execute(
    { toolId: "execute_command", arguments: { command: "touch", args: ["scratch/exact.txt"] } },
    context,
  );
  assert.equal(result.isError, false);
  await assert.rejects(
    tool.execute({ toolId: "execute_command", arguments: { command: "touch", args: ["scratch/other.txt"] } }, context),
    /outside the session write set/,
  );
});

test("exec-cmd: X-1 targets outside the repository are denied", async () => {
  const { context } = makeGateFixture();
  const tool = createExecuteCommandTool({ writeSet: new Set(["scratch/"]) });
  await assert.rejects(
    tool.execute({ toolId: "execute_command", arguments: { command: "touch", args: [join(systemTempRoot(), "escape-hatch.txt")] } }, context),
    /outside the session write set/,
  );
});

test("exec-cmd: X-1 read-only commands are unaffected by an empty write set", async () => {
  const { context } = makeGateFixture();
  const tool = createExecuteCommandTool();
  const result = await tool.execute(
    { toolId: "execute_command", arguments: { command: "ls", args: ["scratch"] } },
    context,
  );
  assert.equal(result.isError, false);
});

test("exec-cmd: X-1 createBuiltInToolAdapters threads the write set through", async () => {
  const { context } = makeGateFixture();
  const adapters = createBuiltInToolAdapters({ writeSet: new Set(["scratch/"]) });
  const result = await adapters.executeCommand.execute(
    { toolId: "execute_command", arguments: { command: "touch", args: ["scratch/via-adapters.txt"] } },
    context,
  );
  assert.equal(result.isError, false);
  const deniedAdapters = createBuiltInToolAdapters();
  await assert.rejects(
    deniedAdapters.executeCommand.execute(
      { toolId: "execute_command", arguments: { command: "touch", args: ["scratch/nope.txt"] } },
      context,
    ),
    /outside the session write set/,
  );
});

// ============================================================================
// X-2: execute_command description explains the command/args contract
// ============================================================================

test("manifest-entries: execute_command description explains command is the executable only (X-2)", () => {
  const entries = createBuiltInToolManifestEntries();
  const exec = entries.find((e) => e.id === "execute_command")!;
  assert.ok(exec.description.includes("executable name ONLY"), "description must state command is the executable only");
  assert.ok(exec.description.includes("args: array of argument strings"), "description must explain the args array");
  assert.ok(!exec.description.includes("Read-only for v1"), "stale read-only claim must be gone (X-1)");
  assert.ok(exec.description.includes("write set"), "description must document the mutating-command write-set gate (X-1)");
});

// ============================================================================
// MINOR: adapter blockers are structured JSON
// ============================================================================

test("adapters: not-configured blockers are structured JSON (MINOR)", async () => {
  const cases: ReadonlyArray<readonly [string, ToolAdapter, string, Record<string, unknown>]> = [
    ["search_web", createSearchWebTool(), "search", { query: "x" }],
    ["fetch_page", createFetchPageTool(), "pageFetch", { url: "https://example.com" }],
    ["read_docs", createReadDocsTool(), "docs", { libraryId: "/org/project", query: "x" }],
    ["repo_question", createRepoQuestionTool(), "repoQuestion", { repo: "owner/repo", question: "x" }],
  ];
  for (const [toolId, adapter, expectedAdapterName, args] of cases) {
    const result = await adapter.execute({ toolId, arguments: args }, defaultContext);
    assert.equal(result.isError, true, `${toolId} blocker must be an error`);
    const parsed = JSON.parse(result.content) as { error?: string; adapter?: string; tool?: string; message?: string };
    assert.equal(parsed.error, "adapter_not_configured", `${toolId} blocker must carry the typed error code`);
    assert.equal(parsed.adapter, expectedAdapterName, `${toolId} blocker must name the adapter`);
    assert.equal(parsed.tool, toolId, `${toolId} blocker must name the tool`);
    assert.ok(parsed.message!.includes("not configured"), `${toolId} blocker must keep the human-readable message`);
  }
});
